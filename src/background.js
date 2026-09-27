/*
 * Qchess Transpositions - background service worker (Practical eval).
 *
 * Owns everything the page must not: network, the response cache, the Lichess token and
 * the search. The MAIN-world script asks for rows through the bridge, which holds one
 * long-lived port per tab:
 *
 *   main-world  --qx:pe:request-->  bridge  --port 'qx-pe'-->  here
 *   main-world  <--qx:pe:update---  bridge  <--port---------  here
 *
 * The token never goes the other way. It is read from chrome.storage.local (the popup's
 * field) or, when that is empty and the user allows it, taken from the bridge, which
 * reads the one Qchess itself keeps in the page's localStorage.
 */

import { Chess } from './vendor/chess.js';
import { fenKey } from './pe/search.js';
import { createRootSearch } from './pe/rounds.js';
import { createProviders, burstFor, EXPLORER_URL, LICHESS_RATE } from './pe/providers.js';
import { createCache } from './pe/cache.js';

var DEFAULT_BUDGET = 60;     // uncached explorer requests per root position
var ANALYSE_MAX = 30;        // ChessDB analysis requests per root position
var MAIA_TIMEOUT_MS = 30000; // the first answer includes loading the model

// Maia's policy by "<position>|<rating>", for this worker's lifetime. Recomputing is
// cheap; this only spares the tab repeated work within a search.
var maiaCache = new Map();
function maiaRemember(key, moves) {
  maiaCache.set(key, moves);
  if (maiaCache.size > 5000) maiaCache.delete(maiaCache.keys().next().value);
}

var cache = createCache();

// Per browser session, so the popup's counter survives the worker being suspended.
var stats = { explorerRequests: 0, explorer429: 0, chessdbRequests: 0 };
var statsLoaded = chrome.storage.session.get('peStats').then(function (r) {
  var s = r && r.peStats;
  if (s) Object.keys(s).forEach(function (k) {
    if (typeof s[k] === 'number') stats[k] = Math.max(stats[k] || 0, s[k]);
    else if (!stats[k]) stats[k] = s[k];
  });
}, function () {});
var saveTimer = null;
function saveStats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    chrome.storage.session.set({ peStats: stats }).catch(function () {});
  }, 500);
}

var ownToken = '';    // the popup's token, kept in step with storage
var siteToken = '';   // last token the bridge offered from Qchess's localStorage
var tokenSource = 'none';

// Lichess's bucket is per token: the popup's own token can use more of it than Qchess's,
// which the site's panel draws on too (providers.js, burstFor).
function applyBurst() {
  providers.setBurst(burstFor(ownToken, siteToken));
}

function getToken() {
  return chrome.storage.local.get({ lichessToken: '' }).then(function (r) {
    ownToken = String(r.lichessToken || '').trim();
    applyBurst();
    if (ownToken) { tokenSource = 'popup'; return ownToken; }
    tokenSource = siteToken ? 'qchess' : 'none';
    return siteToken;
  });
}

// The limiter's bucket, saved after explorer requests so a restarted worker doesn't
// start full while Lichess's is still refilling.
var limiterTimer = null;
function saveLimiter() {
  clearTimeout(limiterTimer);
  limiterTimer = setTimeout(function () {
    chrome.storage.session.set({ peLimiter: providers.limiterSnapshot() }).catch(function () {});
  }, 1000);
}

var providers = createProviders({
  fetch: function (url, init) {
    var p = fetch(url, init);
    if (String(url).indexOf(EXPLORER_URL) === 0) p.then(saveLimiter, saveLimiter);
    return p;
  },
  cache: cache,
  getToken: getToken,
  stats: stats
});

// Searches wait for this: the right burst for the token, then the saved bucket.
var limiterReady = chrome.storage.local.get({ lichessToken: '' }).then(function (r) {
  ownToken = String(r.lichessToken || '').trim();
  applyBurst();
  return chrome.storage.session.get('peLimiter');
}).then(function (r) {
  providers.limiterRestore(r && r.peLimiter);
}).catch(function () {});

// setRate caps it at RATE_MAX, whatever an older popup saved.
chrome.storage.sync.get({ peRatePerMin: LICHESS_RATE }).then(function (s) {
  providers.setRate(Number(s.peRatePerMin) || LICHESS_RATE);
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'sync' && changes.peRatePerMin) {
    providers.setRate(Number(changes.peRatePerMin.newValue) || LICHESS_RATE);
  }
  if (area === 'local' && changes.lichessToken) {
    ownToken = String(changes.lichessToken.newValue || '').trim();
    applyBurst();
  }
});

// Neither API returns child positions, so chess.js plays the moves.
var childMemo = new Map();
// ChessDB's spelling of a move: from and to squares, so castling is e1g1 (the explorer's
// e1h1 would name a different move).
function uciOf(fen, san) {
  var m = new Chess(fen).move(san);
  return m.from + m.to + (m.promotion || '');
}

function child(fen, san) {
  var k = fen + '|' + san;
  if (childMemo.has(k)) return childMemo.get(k);
  var c = new Chess(fen);
  c.move(san);
  var out = c.fen();
  childMemo.set(k, out);
  if (childMemo.size > 5000) childMemo.delete(childMemo.keys().next().value);
  return out;
}

function reasonOf(e) {
  if (!e) return 'Unknown error';
  if (e.message === 'no-token') {
    return 'No Lichess token. Paste one in the extension popup, or connect Lichess in Qchess.';
  }
  if (e.status === 401) return 'Lichess rejected the token (401).';
  if (e.status) return (e.source || 'Request') + ' failed: HTTP ' + e.status + '.';
  return (e.source || 'Network') + ' unreachable: ' + (e.message || e);
}

function tag(source) {
  return function (e) { if (e && !e.source) e.source = source; throw e; };
}

/* ------------------------------------------------------------------ ports */

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'qx-pe') return;
  // gen: the tab's current root generation. search: that root's rounds, shared by all its
  // rows, including ones added later by a click.
  var st = { gen: 0, alive: true, search: null,
    maia: { next: 1, waiting: new Map(), inflight: new Map(), down: false } };

  port.onDisconnect.addListener(function () {
    st.alive = false;
    providers.sweep();
    st.maia.waiting.forEach(function (w) { w(null); });
    st.maia.waiting.clear();
  });

  port.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'maiaResult') {
      var w = st.maia.waiting.get(msg.id);
      if (w) { st.maia.waiting.delete(msg.id); w(msg); }
      return;
    }
    if (!msg || msg.type !== 'request') return;   // 'hb' only keeps the worker awake
    siteToken = typeof msg.siteToken === 'string' ? msg.siteToken : '';
    applyBurst();
    if (msg.gen < st.gen) return;
    if (msg.gen > st.gen || !st.search) {
      // A new root: older rows are now stale, and their queued requests go at once.
      st.gen = msg.gen;
      st.maia.down = false;          // the model may have been downloaded since
      st.search = startRoot(port, st, msg);
      providers.sweep();
    }
    var search = st.search;
    // A right-click on a Practical cell: stop that row now. If it was still running,
    // say so, so the bridge stops counting it as pending.
    (msg.remove || []).forEach(function (san) {
      if (search.remove(san)) {
        try {
          port.postMessage({ type: 'update', gen: msg.gen, root: fenKey(msg.rootFen), san: san,
            result: { state: 'excluded' } });
        } catch (e) { st.alive = false; }
      }
    });
    if (msg.remove && msg.remove.length) providers.sweep();
    Promise.all([statsLoaded, limiterReady]).then(function () { search.add(msg.rows || []); });
  });
});

/*
 * Maia runs in the tab (main-world.js), which has Qchess's model; the search asks it
 * over the port. Resolves to [{ san, prob }], or null when Maia can't answer - then the
 * search treats the position as it did before Maia.
 */
function askMaia(port, st, fen, elo) {
  var key = fenKey(fen) + '|' + elo;
  if (maiaCache.has(key)) return Promise.resolve(maiaCache.get(key));
  if (st.maia.down || !st.alive) return Promise.resolve(null);
  if (st.maia.inflight.has(key)) return st.maia.inflight.get(key);
  var p = new Promise(function (resolve) {
    var id = st.maia.next++;
    var timer = setTimeout(function () {
      st.maia.waiting.delete(id);
      resolve(null);
    }, MAIA_TIMEOUT_MS);
    st.maia.waiting.set(id, function (r) {
      clearTimeout(timer);
      if (r && r.status === 'unavailable') st.maia.down = true;
      var moves = r && Array.isArray(r.moves) ? r.moves : null;
      if (moves && moves.length) {
        maiaRemember(key, moves);
        stats.maiaPositions = (stats.maiaPositions || 0) + 1;
        saveStats();
      }
      resolve(moves && moves.length ? moves : null);
    });
    try {
      port.postMessage({ type: 'maia', id: id, fen: fen, elo: elo });
    } catch (e) {
      st.alive = false;
      st.maia.waiting.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
  st.maia.inflight.set(key, p);
  p.then(function () { st.maia.inflight.delete(key); });
  return p;
}

function startRoot(port, st, msg) {
  var gen = msg.gen;
  function rootStale() { return !st.alive || gen < st.gen; }
  var filter = msg.filter || {};
  var shares = msg.shares || {};
  var budget = { limit: Number(msg.opts && msg.opts.budget) || DEFAULT_BUDGET, spent: 0 };
  var analysed = 0;
  var maiaElo = Number(msg.opts && msg.opts.maiaElo) || 1900;

  function makeProvider(san, isAborted, counts) {
    function isStale() { return rootStale() || isAborted(); }
    var share = shares[san] || 0.01;

    // Identical requests from different rows share one fetch. If the row that queued it
    // goes stale, the others get a cancellation they didn't ask for: ask again.
    function retrying(call) {
      var tries = 0;
      return (function go() {
        return call().catch(function (e) {
          if (e && e.cancelled && !isStale() && tries++ < 3) return go();
          throw e;
        });
      })();
    }

    return {
      explorer: function (fen, info) {
        // Within a round, work goes in descending mass: the row's share of games times
        // the node's reach. Round 1 jumps the queue and is never refused.
        var first = !info || info.plies === 1;
        var ctx = { budget: budget, exempt: first, counts: counts,
          priority: (first ? 10 : 0) + share * (info ? info.reach : 1) };
        return retrying(function () {
          return providers.explorer(fen, filter, isStale, ctx);
        }).catch(tag('Lichess'));
      },
      chessdb: function (fen) {
        return retrying(function () { return providers.chessdb(fen, isStale); }).catch(tag('ChessDB'));
      },
      // Positions the search needed and ChessDB didn't know: ask it to analyse them, so
      // coming back later finds evals there. Capped per root position.
      analyse: function (fen, san) {
        if (analysed >= ANALYSE_MAX) return Promise.resolve(false);
        analysed++;
        return providers.analyse(fen, san ? uciOf(fen, san) : null).then(function (sent) {
          if (!sent) analysed--;             // asked already today: costs nothing
          else saveStats();
          return sent;
        }, function () { return false; });
      },
      maia: function (fen) {
        if (isStale()) return Promise.resolve(null);
        return askMaia(port, st, fen, maiaElo);
      },
      child: child
    };
  }

  function post(san, result) {
    saveStats();
    if (rootStale()) return;
    try {
      port.postMessage({ type: 'update', gen: gen, root: fenKey(msg.rootFen), san: san,
        result: result });
    } catch (e) { st.alive = false; }
  }

  return createRootSearch({
    rootFen: msg.rootFen,
    opts: msg.opts,
    budget: budget,
    makeProvider: makeProvider,
    isStale: rootStale,
    onResult: function (san, res) { res.tokenSource = tokenSource; post(san, res); },
    onError: function (san, e) { post(san, { state: 'error', reason: reasonOf(e), final: true }); }
  });
}

/* ---------------------------------------------------------------- popup */

// Moves right-clicked out of the analysis, as "<position>|<SAN>" keys. For the browser
// session only, as agreed: nothing is excluded for good by accident.
var EXCLUDED_MAX = 1000;
function excludedKeys() {
  return chrome.storage.session.get({ peExcluded: [] }).then(function (r) {
    return Array.isArray(r.peExcluded) ? r.peExcluded : [];
  }, function () { return []; });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === 'qx:pe:getExcluded') {
    excludedKeys().then(function (keys) { sendResponse({ keys: keys }); });
    return true;
  }
  if (msg.type === 'qx:pe:exclude' && typeof msg.key === 'string') {
    excludedKeys().then(function (keys) {
      keys = keys.filter(function (k) { return k !== msg.key; });
      if (msg.on) keys.push(msg.key);
      if (keys.length > EXCLUDED_MAX) keys = keys.slice(-EXCLUDED_MAX);
      return chrome.storage.session.set({ peExcluded: keys });
    }).catch(function () {});
    return;
  }
  if (msg.type === 'qx:pe:stats') {
    Promise.all([statsLoaded, cache.count(), getToken()]).then(function (r) {
      sendResponse({
        explorerRequests: stats.explorerRequests || 0,
        explorer429: stats.explorer429 || 0,
        chessdbRequests: stats.chessdbRequests || 0,
        chessdbAnalyse: stats.chessdbAnalyse || 0,
        maiaPositions: stats.maiaPositions || 0,
        rateHeaders: stats.rateHeaders || null,
        cache: r[1],
        pausedFor: providers.pausedFor(),
        tokenSource: tokenSource
      });
    });
    return true;
  }
  if (msg.type === 'qx:pe:testToken') {
    var given = String(msg.token || '').trim();
    (given ? Promise.resolve(given) : getToken()).then(function (token) {
      var source = given ? 'popup' : tokenSource;
      if (!token) { sendResponse({ ok: false, status: 0, source: 'none' }); return; }
      return providers.testToken(token).then(function (r) {
        saveStats();
        sendResponse({ ok: r.ok, status: r.status, source: source });
      });
    }).catch(function (e) {
      sendResponse({ ok: false, status: 0, error: String(e && e.message || e) });
    });
    return true;
  }
});
