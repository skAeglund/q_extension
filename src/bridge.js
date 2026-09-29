/*
 * Qchess Transpositions - isolated world bridge.
 *
 * The worker script runs in the MAIN world so it can see the page's script-scope
 * state, but MAIN-world scripts have no access to chrome.* APIs. This script sits in
 * the default isolated world and relays:
 *
 *   chrome.storage  --(qx:settings)-->  main world
 *   main world      --(qx:stats)-->     popup (via chrome.runtime messaging)
 *   main world      --(qx:pe:request)-> background worker (port 'qx-pe')
 *   background      --(qx:pe:update)--> main world
 *   background      --(qx:pe:maia)-->   main world, which answers with qx:pe:maiaResult
 *
 * Practical-eval events carry JSON strings rather than objects, so nothing depends on
 * how a CustomEvent's detail crosses between worlds.
 *
 * The Lichess token never enters the MAIN world. When the user allows it, the one
 * Qchess keeps in localStorage (shared with this isolated world) is read here and
 * handed straight to the background worker.
 */

(function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    outline: true,
    minBadge: false,
    sides: true,
    // Practical eval
    peEnabled: true,
    peFollowPanel: true,
    peUseSiteToken: true,
    peSpeeds: 'blitz,rapid',
    peRatings: '1800,2000,2200',
    rowThreshold: 2,
    replyThreshold: 3,
    minGames: 50,
    peRatePerMin: 16,
    reachFloor: 2,
    maxPly: 6,
    ownMargin: 5,
    ownMaxCandidates: 3,
    peRequestBudget: 60,
    peMaia: true,
    peMaiaPreview: true,
    peView: 'lichess',
    maiaUntil: 100,
    maiaOnlyBelow: 10,
    maiaWeight: 20,
    // Prepared score
    prepEnabled: true,
    prepBar: false,
    prepPriorGames: 50
  };

  var current = DEFAULTS;
  var latestStats = { isStudy: false, groups: 0, marked: 0 };

  function push(settings) {
    current = settings;
    document.dispatchEvent(new CustomEvent('qx:settings', { detail: settings }));
  }

  function pushFromStorage() {
    chrome.storage.sync.get(DEFAULTS, function (s) {
      if (chrome.runtime.lastError) { push(DEFAULTS); return; }
      push(s);
    });
  }

  // The MAIN-world script announces itself; it may load before or after this one,
  // so push on both its signal and our own start-up.
  document.addEventListener('qx:ready', pushFromStorage);
  pushFromStorage();

  document.addEventListener('qx:stats', function (e) {
    latestStats = e.detail || latestStats;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    pushFromStorage();
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'qx:getStats') return;
    // Ask the main world for a fresh reading, then answer with whatever we have.
    document.dispatchEvent(new CustomEvent('qx:ping'));
    setTimeout(function () { sendResponse(latestStats); }, 60);
    return true; // keep the message channel open for the async response
  });

  /* ------------------------------------------------------- practical eval */

  var port = null;
  var lastRootRequest = null;   // re-sent if the worker was suspended mid-search
  var pending = 0;              // rows asked for whose search hasn't finished

  function siteToken() {
    if (!current.peUseSiteToken) return '';
    try { return localStorage.getItem('lichessToken') || ''; } catch (e) { return ''; }
  }

  function connect() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'qx-pe' });
    } catch (e) {
      port = null;       // extension reloaded under us; this page needs a reload
      return null;
    }
    port.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'maia') {
        document.dispatchEvent(new CustomEvent('qx:pe:maia', { detail: JSON.stringify(msg) }));
        return;
      }
      if (!msg || msg.type !== 'update') return;
      // A row sends one update per iteration; only its last one ends it. Results from
      // before phase 2 carry no flag and count as final. The Maia preview's updates don't
      // count: it only runs while the row's Lichess search does.
      if (pending > 0 && msg.pass !== 'maia' && !(msg.result && msg.result.final === false)) {
        pending--;
      }
      document.dispatchEvent(new CustomEvent('qx:pe:update', { detail: JSON.stringify(msg) }));
    });
    port.onDisconnect.addListener(function () {
      port = null;
      // An MV3 worker can be stopped at any time. Its cache persists, so asking again
      // resumes from there at no request cost.
      if (pending > 0 && lastRootRequest) setTimeout(function () { send(lastRootRequest); }, 250);
    });
    return port;
  }

  function send(req) {
    var p = connect();
    if (!p) return;
    var msg = {};
    Object.keys(req).forEach(function (k) { msg[k] = req[k]; });
    msg.type = 'request';
    msg.siteToken = siteToken();
    try { p.postMessage(msg); } catch (e) { port = null; }
  }

  document.addEventListener('qx:pe:request', function (e) {
    var req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    // An empty row list still goes through: a new root with nothing to compute is how
    // the worker learns to drop the old root's rows.
    if (!req || !Array.isArray(req.rows)) return;
    if (!req.add) { lastRootRequest = req; pending = 0; }
    pending += req.rows.length;
    // A right-clicked row must not come back if the worker restarts and this is re-sent.
    if (req.remove && req.remove.length && lastRootRequest && lastRootRequest.gen === req.gen) {
      lastRootRequest.rows = lastRootRequest.rows.filter(function (s) {
        return req.remove.indexOf(s) < 0;
      });
    }
    send(req);
  });

  // The main world's Maia answers go back over the port they came from.
  document.addEventListener('qx:pe:maiaResult', function (e) {
    var r;
    try { r = JSON.parse(e.detail); } catch (err) { return; }
    if (!r || !port) return;
    r.type = 'maiaResult';
    try { port.postMessage(r); } catch (err) { port = null; }
  });

  // Excluded moves live in the worker's session storage, which content scripts can't
  // reach directly.
  document.addEventListener('qx:pe:exclude', function (e) {
    var x;
    try { x = JSON.parse(e.detail); } catch (err) { return; }
    try { chrome.runtime.sendMessage({ type: 'qx:pe:exclude', key: x.key, on: !!x.on }); } catch (err) {}
  });

  // The Score header's toggle (main world) is the prepBar setting, so it persists and the
  // popup shows it. Saving it comes back through onChanged like any other setting.
  document.addEventListener('qx:pe:prepBar', function (e) {
    var on;
    try { on = JSON.parse(e.detail); } catch (err) { return; }
    try { chrome.storage.sync.set({ prepBar: !!on }); } catch (err) {}
  });

  // Likewise the Prac header's switch between the Lichess values and Maia's.
  document.addEventListener('qx:pe:view', function (e) {
    var v;
    try { v = JSON.parse(e.detail); } catch (err) { return; }
    try { chrome.storage.sync.set({ peView: v === 'maia' ? 'maia' : 'lichess' }); } catch (err) {}
  });

  function sendExcluded() {
    try {
      chrome.runtime.sendMessage({ type: 'qx:pe:getExcluded' }, function (r) {
        if (chrome.runtime.lastError || !r || !Array.isArray(r.keys) || !r.keys.length) return;
        document.dispatchEvent(new CustomEvent('qx:pe:excludedList', { detail: JSON.stringify(r.keys) }));
      });
    } catch (err) {}
  }
  document.addEventListener('qx:ready', sendExcluded);
  sendExcluded();

  // Messages crossing the port are what keep an MV3 worker alive; an open but silent
  // port is not enough, and a 60 s rate-limit pause would otherwise let it be stopped.
  setInterval(function () {
    if (port && pending > 0) {
      try { port.postMessage({ type: 'hb' }); } catch (e) { port = null; }
    }
  }, 20000);
})();
