'use strict';

// Checkboxes: opt-<key>.
var DEFAULTS = {
  enabled: true,
  outline: true,
  minBadge: false,
  sides: true,
  peEnabled: true,
  peUseSiteToken: true,
  peFollowPanel: true,
  peMaia: true,
  peMaiaPreview: true,
  prepEnabled: true,
  prepBar: false
};

// Number and text inputs: num-<key>. Keep in step with bridge.js DEFAULTS.
var FIELDS = {
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
  maiaUntil: 100,
  maiaOnlyBelow: 10,
  maiaWeight: 20,
  prepPriorGames: 50
};

var OPTS = Object.keys(DEFAULTS);

function $(id) { return document.getElementById(id); }

function setStatus(text, cls) {
  var el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function showStats(stats) {
  $('stat-groups').textContent = stats.groups || 0;
  $('stat-marked').textContent = stats.marked || 0;
  $('stats').hidden = false;
  // Which side you are comes from the chapter's own perspective setting, so show what was
  // detected rather than leaving the user to guess why the bars fell where they did.
  if (stats.you) {
    $('stat-you').textContent = stats.you.charAt(0).toUpperCase() + stats.you.slice(1);
    $('side-note').textContent = (stats.yours || 0) + ' variation'
      + (stats.yours === 1 ? '' : 's') + ' in this chapter start'
      + (stats.yours === 1 ? 's' : '') + ' with a move of yours.';
  }
}

/* ------------------------------------------------------------- settings */

chrome.storage.sync.get(DEFAULTS, function (s) {
  OPTS.forEach(function (key) {
    var box = $('opt-' + key);
    if (!box) return;
    box.checked = !!s[key];
    box.addEventListener('change', function () {
      var patch = {};
      patch[key] = box.checked;
      chrome.storage.sync.set(patch, refreshStats);
    });
  });
});

// The OPTS loop above only handles checkboxes; these save on change, typed.
chrome.storage.sync.get(FIELDS, function (s) {
  Object.keys(FIELDS).forEach(function (key) {
    var el = $('num-' + key);
    if (!el) return;
    el.value = s[key];
    el.addEventListener('change', function () {
      var v = el.value;
      if (typeof FIELDS[key] === 'number') {
        v = Number(v);
        if (!isFinite(v) || v < 0) { el.value = s[key]; return; }
      } else {
        v = String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean).join(',');
        if (!v) { el.value = s[key]; return; }
      }
      s[key] = v;
      var patch = {};
      patch[key] = v;
      chrome.storage.sync.set(patch);
    });
  });
});

/* ---------------------------------------------------------- lichess token */

// The saved token is never put back into the field; the field only shows that one exists.
function tokenNote(text, cls) {
  var n = $('pe-token-note');
  n.textContent = text;
  n.className = 'note' + (cls ? ' ' + cls : '');
}

chrome.storage.local.get({ lichessToken: '' }, function (r) {
  $('pe-token').placeholder = r.lichessToken ? 'Saved (paste to replace)' : 'lip_…';
});

$('pe-save').addEventListener('click', function () {
  var v = $('pe-token').value.trim();
  chrome.storage.local.set({ lichessToken: v }, function () {
    $('pe-token').value = '';
    $('pe-token').placeholder = v ? 'Saved (paste to replace)' : 'lip_…';
    tokenNote(v ? 'Saved.' : 'Cleared. Qchess\'s own connection is used if allowed below.', 'ok');
  });
});

$('pe-test').addEventListener('click', function () {
  tokenNote('Testing…');
  chrome.runtime.sendMessage({ type: 'qx:pe:testToken', token: $('pe-token').value.trim() },
    function (r) {
      if (chrome.runtime.lastError || !r) { tokenNote('Background worker not reachable.', 'warn'); return; }
      var src = r.source === 'qchess' ? ' (Qchess\'s token)' : '';
      if (r.source === 'none') tokenNote('No token: paste one, or open a Qchess tab that is connected to Lichess.', 'warn');
      else if (r.ok) tokenNote('Lichess accepted the token' + src + '.', 'ok');
      else if (r.status === 401) tokenNote('Lichess rejected the token' + src + ' (401).', 'warn');
      else if (r.status === 429) tokenNote('Rate-limited by Lichess; try again in a minute.', 'warn');
      else tokenNote('Test failed' + (r.status ? ': HTTP ' + r.status : r.error ? ': ' + r.error : '') + '.', 'warn');
    });
});

function refreshPeStats() {
  chrome.runtime.sendMessage({ type: 'qx:pe:stats' }, function (r) {
    if (chrome.runtime.lastError || !r) return;
    var cached = r.cache ? (r.cache.explorer || 0) : 0;
    var parts = [cached + ' positions cached', r.explorerRequests + ' Lichess requests this session'];
    if (r.explorer429) parts.push(r.explorer429 + '× rate-limited');
    if (r.maiaPositions) parts.push(r.maiaPositions + ' positions from Maia');
    if (r.chessdbAnalyse) parts.push(r.chessdbAnalyse + ' positions sent to ChessDB for analysis');
    if (r.pausedFor > 0) parts.push('paused ' + Math.ceil(r.pausedFor / 1000) + ' s');
    $('pe-stats').textContent = parts.join(' · ');
    $('pe-stats').title = r.rateHeaders ? 'Lichess rate headers: ' + JSON.stringify(r.rateHeaders) : '';
  });
}

refreshPeStats();

/* ---------------------------------------------------------------- stats */

function refreshStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.url || tab.url.indexOf('https://qchess.net/') !== 0) {
      setStatus('Open a Qchess study to use this.', 'warn');
      $('stats').hidden = true;
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'qx:getStats' }, function (stats) {
      if (chrome.runtime.lastError || !stats) {
        setStatus('Not connected — reload the Qchess tab.', 'warn');
        $('stats').hidden = true;
        return;
      }
      if (!stats.isStudy) {
        setStatus('No study open on this page.', 'warn');
        $('stats').hidden = true;
        return;
      }
      if (stats.off) {
        setStatus('Markers are switched off.', 'warn');
        showStats(stats);
        return;
      }
      if (!stats.groups) {
        setStatus('No transpositions found in this chapter.', 'ok');
        showStats(stats);
        return;
      }
      setStatus('Active — ' + stats.groups + ' transposing position'
        + (stats.groups > 1 ? 's' : '') + ' found.', 'ok');
      showStats(stats);
    });
  });
}

// Give the content script a moment if the popup opened during page load.
refreshStats();
setTimeout(refreshStats, 400);
