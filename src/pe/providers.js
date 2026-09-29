/*
 * Practical eval - Lichess explorer and ChessDB clients.
 *
 * No chrome.* APIs here either: fetch, the clock and the cache are injected, so the rate
 * limiter can be tested in Node with a fake clock.
 *
 * Politeness rules (see the design doc):
 *   - Lichess explorer: one request in flight, a token bucket of `ratePerMin` (burst
 *     `burst`), and a 60 s pause of every queued call on HTTP 429. Qchess's own Lichess
 *     panel may draw on the same allowance, so the bucket sits under Lichess's own (below).
 *   - ChessDB: at most two requests in flight, lookups and analysis requests together,
 *     the Lichess search's lookups first. A position or move is asked to be analysed at
 *     most once a day.
 *   - Waiting explorer calls go highest priority first (the search's reach), and each
 *     root position has a request budget (see explorer()).
 *   - A cache hit costs nothing: no token, no budget, no queue slot.
 */

import { fenKey } from './search.js';

export var EXPLORER_URL = 'https://explorer.lichess.org/lichess';
export var CHESSDB_URL = 'https://www.chessdb.cn/cdb.php';
var CDB_RETRIES = 2;         // a lookup that fails on the network is tried twice more,
var CDB_RETRY_MS = 1500;     // after 1.5 s and then 3 s

/*
 * Lichess's explorer limit, measured with tools/lichess-rate.mjs on 2026-09-27 (it sends
 * no rate headers): a token bucket holding about 23 requests and refilling about 18.5 to
 * 19 a minute. From rest, 23 unpaced requests went through and the 24th got a 429; a
 * steady 33/min got one on the 52nd, and 20 then 30/min on the 76th, at 164 s.
 *
 * Ours is smaller on both counts, so it can never run ahead of Lichess's. The burst is
 * where the speed is: after a minute or so without requests, a new position's first
 * requests go out at once instead of one every 4 s. The rate is capped at RATE_MAX.
 *
 * The bucket is per token (or per account), not per IP: with one token refused, a
 * second account's token got 12 answers straight after (2026-09-27; that run's first
 * token got 22 through, not 23). So how much of the burst we take depends on whose token
 * this is (burstFor):
 *   - Qchess's token: shared with Qchess's own Lichess panel, so a burst of 16 leaves the
 *     panel 7.
 *   - the popup's own token: nobody else's, so 20, which keeps 2 or 3 in hand against a
 *     bucket of 22 or 23.
 * Two tokens of one account may still share a bucket: per token vs per account is
 * untested. At 20 that would leave the panel 2 or 3 at once, and 2.5 a minute.
 */
export var LICHESS_RATE = 16;
export var LICHESS_BURST = 16;
export var OWN_BURST = 20;
export var RATE_MAX = 18;

// The burst for the token in use: `own` is the popup's token, `site` Qchess's.
export function burstFor(own, site) {
  return own && own !== site ? OWN_BURST : LICHESS_BURST;
}

var DAY = 24 * 3600 * 1000;
export var TTL = {
  explorer: 30 * DAY,
  chessdb: 7 * DAY,
  chessdbUnknown: 1 * DAY,   // ChessDB learns positions; ask again sooner
  analyse: 1 * DAY,          // don't ask ChessDB to analyse the same thing twice a day
  // After asking, look the position up again once this has passed: a queued position
  // had evals about 65 s later when measured (2026-09-25). Still unknown then, it is
  // looked up again at this interval for `recheckFor`, whenever a search needs it.
  recheck: 2 * 60 * 1000,
  recheckFor: 60 * 60 * 1000
};

export function Cancelled() {
  var e = new Error('cancelled');
  e.cancelled = true;
  return e;
}

// The per-root request budget is spent; the search keeps its last completed iteration.
export function BudgetOut() {
  var e = new Error('budget');
  e.budget = true;
  return e;
}

export function HttpError(status, message) {
  var e = new Error(message || ('HTTP ' + status));
  e.status = status;
  return e;
}

/*
 * Token bucket plus a single lane. `schedule(fn, isStale, priority)` runs fn() when a
 * token is available, one job at a time: the next job starts only once the previous one
 * has settled. Among waiting jobs the highest priority goes first, then call order. A
 * job whose isStale() is true when its turn comes is dropped without spending a token;
 * `sweep()` drops them at once, so a new root position frees the queue immediately.
 */
export function createRateLimiter(o) {
  var now = o.now || Date.now;
  var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var ratePerMin = o.ratePerMin || LICHESS_RATE;
  var burst = o.burst || LICHESS_BURST;
  var tokens = burst;
  var last = now();
  var pausedUntil = 0;
  var jobs = [];
  var seq = 0;
  var pumping = false;

  function refill() {
    var t = now();
    tokens = Math.min(burst, tokens + (t - last) * ratePerMin / 60000);
    last = t;
  }

  function sweep() {
    jobs = jobs.filter(function (j) {
      if (j.isStale && j.isStale()) { j.reject(Cancelled()); return false; }
      return true;
    });
  }

  function take() {
    var bi = 0;
    for (var i = 1; i < jobs.length; i++) {
      var a = jobs[i], b = jobs[bi];
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) bi = i;
    }
    return jobs.splice(bi, 1)[0];
  }

  function step() {
    sweep();
    if (!jobs.length) { pumping = false; return; }
    var t = now();
    if (pausedUntil > t) { sleep(Math.min(pausedUntil - t, 1000)).then(step); return; }
    refill();
    if (tokens < 1) {
      sleep(Math.min(Math.ceil((1 - tokens) * 60000 / ratePerMin), 1000)).then(step);
      return;
    }
    tokens -= 1;
    var job = take();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).then(step);
  }

  return {
    schedule: function (fn, isStale, priority) {
      return new Promise(function (resolve, reject) {
        jobs.push({ fn: fn, isStale: isStale, priority: priority || 0, seq: seq++,
          resolve: resolve, reject: reject });
        if (!pumping) {
          pumping = true;
          // Start on a microtask, so jobs queued in the same tick compete on priority.
          Promise.resolve().then(step);
        }
      });
    },
    sweep: sweep,
    queued: function () { return jobs.length; },
    // A 429 means Lichess's bucket is empty: ours is emptied too, or it would be fuller
    // than Lichess's once the pause is over.
    pause: function (ms) {
      pausedUntil = Math.max(pausedUntil, now() + ms);
      refill();
      tokens = 0;
    },
    pausedFor: function () { return Math.max(0, pausedUntil - now()); },
    setRate: function (r) { if (r > 0) { refill(); ratePerMin = Math.min(r, RATE_MAX); } },
    // A smaller burst takes effect at once; a larger one fills up at the rate.
    setBurst: function (b) {
      if (!(b > 0) || b === burst) return;
      refill();
      burst = b;
      tokens = Math.min(tokens, burst);
    },
    burst: function () { return burst; },
    /*
     * The bucket as it stands, and back. The service worker is stopped when idle and
     * would come back with a full bucket while Lichess's is still refilling, so
     * background.js keeps the snapshot in session storage. Times are Date.now()'s, so they
     * carry across restarts.
     */
    snapshot: function () {
      refill();
      return { tokens: tokens, t: last, pausedUntil: pausedUntil };
    },
    restore: function (s) {
      if (!s || !isFinite(s.tokens) || !isFinite(s.t)) return;
      tokens = Math.max(0, Math.min(burst, s.tokens + Math.max(0, now() - s.t) * ratePerMin / 60000));
      last = now();
      if (isFinite(s.pausedUntil)) pausedUntil = Math.max(pausedUntil, s.pausedUntil);
    }
  };
}

/*
 * At most `n` jobs in flight; the rest wait, highest priority first, then in call order.
 * The returned promise carries its job (`p.job`), so a caller that joins a request already
 * waiting can raise its priority: the Maia preview's ChessDB lookups (priority 0) queue
 * behind the Lichess search's (1), and one the Lichess search also needs moves up.
 */
export function createLimiter(n) {
  var active = 0;
  var queue = [];
  var seq = 0;
  function take() {
    var bi = 0;
    for (var i = 1; i < queue.length; i++) {
      var a = queue[i], b = queue[bi];
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) bi = i;
    }
    return queue.splice(bi, 1)[0];
  }
  function next() {
    while (active < n && queue.length) {
      var job = take();
      if (job.isStale && job.isStale()) { job.reject(Cancelled()); continue; }
      active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).then(function () {
        active--;
        next();
      });
    }
  }
  return function (fn, isStale, priority) {
    var job = { fn: fn, isStale: isStale, priority: priority || 0, seq: seq++ };
    var p = new Promise(function (resolve, reject) {
      job.resolve = resolve;
      job.reject = reject;
    });
    queue.push(job);
    next();
    p.job = job;
    return p;
  };
}

export function filterHash(f) {
  f = f || {};
  return [
    (f.speeds || []).slice().sort().join(','),
    (f.ratings || []).slice().sort(function (a, b) { return a - b; }).join(','),
    f.since || ''
  ].join('|');
}

// `base` is the explorer to ask: Lichess's unless a local one (localExplorerUrl) is given.
export function explorerUrl(fen, f, base) {
  var q = 'variant=standard&fen=' + encodeURIComponent(fenKey(fen)) +
    '&speeds=' + (f.speeds || []).join(',') +
    '&ratings=' + (f.ratings || []).join(',') +
    '&moves=30&topGames=0&recentGames=0';
  if (f.since) q += '&since=' + f.since;
  return (base || EXPLORER_URL) + '?' + q;
}

/*
 * A local explorer (tools/explorerdb.mjs serve) answers the same queries at <address>/lichess
 * and says which index it serves at <address>/info. The address is what the user typed,
 * e.g. "http://localhost:9337"; '' means none.
 */
export function localAddress(a) {
  a = String(a || '').trim().replace(/\/+$/, '');
  if (a && !/^https?:\/\//i.test(a)) a = 'http://' + a;
  return a;
}
export function localExplorerUrl(fen, f, address) {
  return explorerUrl(fen, f, localAddress(address) + '/lichess');
}

// What the local explorer at `address` serves (its /info), or an error saying why not.
export function localInfo(fetchFn, address) {
  address = localAddress(address);
  if (!address) return Promise.reject(HttpError(0, 'no address'));
  return Promise.resolve().then(function () {
    return fetchFn(address + '/info', { cache: 'no-store' });
  }).catch(function (e) {
    throw HttpError(0, 'nothing answers at ' + address + ' (' + (e && e.message || e) + ')');
  }).then(function (res) {
    if (!res.ok) throw HttpError(res.status, address + ' answered HTTP ' + res.status);
    return res.json().catch(function () { return null; });
  }).then(function (j) {
    if (!j || !j.id || !j.filter) {
      throw HttpError(0, address + ' is not a local explorer (tools/explorerdb.mjs serve)');
    }
    return j;
  });
}

// Only what the search needs: the counts per move and for the position also feed the
// prepared score (search.js).
export function compactExplorer(j) {
  var total = (j.white || 0) + (j.draws || 0) + (j.black || 0);
  return {
    total: total,
    white: j.white || 0, draws: j.draws || 0, black: j.black || 0,
    moves: (j.moves || []).map(function (m) {
      return {
        uci: m.uci, san: m.san,
        white: m.white || 0, draws: m.draws || 0, black: m.black || 0,
        games: (m.white || 0) + (m.draws || 0) + (m.black || 0)
      };
    })
  };
}

export function compactChessdb(j) {
  return {
    status: j.status || 'unknown',
    moves: (j.moves || []).map(function (m) {
      return { uci: m.uci, san: m.san, score: Number(m.score) };
    })
  };
}

/*
 * o = { fetch, cache, getToken, stats, now, sleep, ratePerMin, burst, localExplorer }
 *   cache.get(store, key, ttlMs) -> Promise<value|undefined>; cache.put(store, key, value)
 *   getToken() -> Promise<string>; empty means "no token"
 *   stats: an object whose counters are bumped (explorerRequests, explorer429, ...)
 *   localExplorer: the address of a local explorer, or a function returning it (it can
 *     change while the worker runs); '' or absent means Lichess
 */
export function createProviders(o) {
  var stats = o.stats || {};
  var lichess = createRateLimiter({ now: o.now, sleep: o.sleep,
    ratePerMin: o.ratePerMin, burst: o.burst });
  var cdbLane = createLimiter(2);
  var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var inflight = new Map();   // identical concurrent requests share one fetch
  var asking = new Map();     // analysis requests on their way

  function once(key, make) {
    if (inflight.has(key)) return inflight.get(key);
    var p = make();
    inflight.set(key, p);
    var clear = function () { inflight.delete(key); };
    p.then(clear, clear);
    return p;
  }

  /*
   * ctx (optional) = { priority, budget: { limit, spent }, exempt }
   *   priority  higher is fetched first (the search passes the mass a node explains)
   *   budget    uncached requests allowed for one root position, shared by its rows;
   *             charged when a request is queued, refunded if it is dropped as stale
   *   exempt    charged but never refused - the first iteration, so every row gets
   *             a value
   *   counts    { hits, misses }, bumped per call, so the caller can tell how much of
   *             its work the cache is carrying
   * A cache hit, or joining a request already in flight, costs nothing.
   */
  function explorer(fen, filter, isStale, ctx) {
    ctx = ctx || {};
    var local = localAddress(typeof o.localExplorer === 'function' ? o.localExplorer() : o.localExplorer);
    if (local) return localExplorer(local, fen, filter, ctx);
    var key = fenKey(fen) + '#' + filterHash(filter);
    var counts = ctx.counts || {};
    return o.cache.get('explorer', key, TTL.explorer).then(function (hit) {
      if (hit || inflight.has('x' + key)) {
        counts.hits = (counts.hits || 0) + 1;
        return hit || inflight.get('x' + key);
      }
      counts.misses = (counts.misses || 0) + 1;
      var budget = ctx.budget;
      if (budget) {
        if (!ctx.exempt && budget.spent >= budget.limit) throw BudgetOut();
        budget.spent++;
      }
      var p = once('x' + key, function attempt() {
        return lichess.schedule(function () {
          return o.getToken().then(function (token) {
            if (!token) throw HttpError(0, 'no-token');
            stats.explorerRequests = (stats.explorerRequests || 0) + 1;
            return o.fetch(explorerUrl(fen, filter), {
              headers: { Authorization: 'Bearer ' + token }
            });
          }).then(function (res) {
            noteRateHeaders(res);
            if (res.status === 429) {
              stats.explorer429 = (stats.explorer429 || 0) + 1;
              lichess.pause(60000);
              var e = HttpError(429);
              e.retry = true;
              throw e;
            }
            if (!res.ok) throw HttpError(res.status);
            return res.json().then(function (j) {
              var v = compactExplorer(j);
              return o.cache.put('explorer', key, v).then(function () { return v; });
            });
          });
        }, isStale, ctx.priority).catch(function (e) {
          // Re-queued only after this job has left the lane, so the retry waits out the
          // pause like everything else instead of deadlocking on itself.
          if (e && e.retry) return attempt();
          throw e;
        });
      });
      if (budget) p.catch(function (e) { if (e && e.cancelled) budget.spent--; });
      return p;
    });
  }

  /*
   * The local explorer is asked directly: no token, no rate limit, no budget, since
   * none of them protect anything on your own machine. Its answers aren't cached either.
   * The server answers in a millisecond or two, and a cache would mix one index's counts
   * with Lichess's under the same key. For the budget estimate in rounds.js an answer counts
   * as a cache hit, since it costs no Lichess request.
   */
  function localExplorer(address, fen, filter, ctx) {
    var counts = ctx.counts || {};
    counts.hits = (counts.hits || 0) + 1;
    var url = localExplorerUrl(fen, filter, address);
    return once('l' + url, function () {
      stats.localRequests = (stats.localRequests || 0) + 1;
      return Promise.resolve().then(function () { return o.fetch(url); }).catch(function (e) {
        throw HttpError(0, 'local explorer not answering at ' + address + ' (' +
          (e && e.message || e) + ')');
      }).then(function (res) {
        if (!res.ok) throw HttpError(res.status, 'local explorer');
        return res.json();
      }).then(compactExplorer);
    });
  }

  // Recorded so the popup can show what Lichess says about its limit (D5).
  function noteRateHeaders(res) {
    if (!res || !res.headers || !res.headers.forEach) return;
    var seen = {};
    res.headers.forEach(function (v, k) {
      if (/rate|retry/i.test(k)) seen[k] = v;
    });
    if (Object.keys(seen).length) stats.rateHeaders = seen;
  }

  function now() { return (o.now || Date.now)(); }

  // priority: among lookups waiting for the lane, higher goes first (createLimiter).
  function chessdb(fen, isStale, priority) {
    var key = fenKey(fen);
    return Promise.all([
      o.cache.get('chessdb', key, TTL.chessdb),
      o.cache.get('chessdb', 'ask|' + key, TTL.analyse)
    ]).then(function (r) {
      var hit = r[0], ask = r[1];
      // Asked to analyse it: look again once ChessDB has had time to, so a later round
      // or search sees the new evals. A known position (a move was asked for) is looked
      // up once more; an unknown one until it is known, for a while.
      var asked = hit && ask && now() - Math.max(hit.t || 0, ask.t) >= TTL.recheck
        && (hit.status === 'ok' ? ask.t >= (hit.t || 0) : now() - ask.t < TTL.recheckFor);
      if (hit && !asked && (hit.status === 'ok' || now() - hit.t < TTL.chessdbUnknown)) {
        return hit;
      }
      var joined = inflight.get('c' + key);
      if (joined && joined.job && (priority || 0) > joined.job.priority) {
        joined.job.priority = priority;
      }
      return once('c' + key, function () {
        var out = { job: null };
        function attempt(tries) {
          var p = cdbLane(function () {
            stats.chessdbRequests = (stats.chessdbRequests || 0) + 1;
            var url = CHESSDB_URL + '?action=queryall&json=1&board=' + encodeURIComponent(fen);
            return o.fetch(url).then(function (res) {
              if (!res.ok) throw HttpError(res.status);
              return res.json();
            }).then(function (j) {
              var v = compactChessdb(j);
              v.t = now();
              return o.cache.put('chessdb', key, v).then(function () { return v; });
            });
          }, isStale, out.job ? out.job.priority : priority);
          out.job = p.job;
          return p.catch(function (e) {
            if (!cdbRetryable(e) || tries >= CDB_RETRIES || (isStale && isStale())) throw e;
            return sleep(CDB_RETRY_MS * (tries + 1)).then(function () { return attempt(tries + 1); });
          });
        }
        var p = attempt(0);
        // chessdb() raises a joined request's priority through p.job: the one waiting now.
        Object.defineProperty(p, 'job', { get: function () { return out.job; } });
        return p;
      });
    });
  }

  /*
   * A dropped connection is retried, not passed on: one failed lookup in a deeper round
   * stops the whole table ('error'). Seen live on 2026-09-28, the page's own ChessDB
   * fetch failing with ERR_CONNECTION_CLOSED once, while 150 lookups at 3 in flight (450 a
   * minute) all went through: a passing network fault, not a limit. HTTP errors other
   * than 5xx are ChessDB's answer and final.
   */
  function cdbRetryable(e) {
    return !!e && !e.cancelled && (!e.status || e.status >= 500);
  }

  /*
   * Ask ChessDB to analyse a position it doesn't know (`queue`), or one move from a
   * position it does know (`store`, uci in ChessDB's spelling: castling is e1g1). It
   * analyses in the background; the answer is 'ok', or nothing for a position it finds
   * trivial. Resolves true when a request was sent, false when it was asked already
   * today. Not dropped when the search moves on: the analysis is worth having anyway.
   */
  function analyse(fen, uci) {
    var key = fenKey(fen);
    var what = key + (uci ? '|' + uci : '');
    if (asking.has(what)) return asking.get(what);
    var p = o.cache.get('chessdb', 'ask|' + what, TTL.analyse).then(function (done) {
      if (done) return false;
      return cdbLane(function () {
        stats.chessdbAnalyse = (stats.chessdbAnalyse || 0) + 1;
        var url = CHESSDB_URL + '?action=' + (uci ? 'store' : 'queue') + '&json=1&board='
          + encodeURIComponent(fen) + (uci ? '&move=move:' + uci : '');
        return o.fetch(url).then(function (res) {
          if (!res.ok) throw HttpError(res.status);
          var t = { t: now() };
          // The position-level record is what chessdb() checks to know it should look again.
          return Promise.all([
            o.cache.put('chessdb', 'ask|' + what, t),
            uci ? o.cache.put('chessdb', 'ask|' + key, t) : null
          ]).then(function () { return true; });
        });
      });
    });
    asking.set(what, p);
    var clear = function () { asking.delete(what); };
    p.then(clear, clear);
    return p;
  }

  // A token check that bypasses the cache: one request for the start position.
  function testToken(token) {
    return lichess.schedule(function () {
      stats.explorerRequests = (stats.explorerRequests || 0) + 1;
      var f = { speeds: ['blitz'], ratings: [2000] };
      return o.fetch(explorerUrl('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', f),
        { headers: { Authorization: 'Bearer ' + token } });
    }).then(function (res) {
      noteRateHeaders(res);
      if (res.status === 429) { stats.explorer429 = (stats.explorer429 || 0) + 1; lichess.pause(60000); }
      return { ok: res.ok, status: res.status };
    });
  }

  return {
    explorer: explorer,
    chessdb: chessdb,
    analyse: analyse,
    testToken: testToken,
    localInfo: function (address) { return localInfo(o.fetch, address); },
    pausedFor: lichess.pausedFor,
    sweep: lichess.sweep,
    queued: lichess.queued,
    setRate: lichess.setRate,
    setBurst: lichess.setBurst,
    limiterSnapshot: lichess.snapshot,
    limiterRestore: lichess.restore
  };
}
