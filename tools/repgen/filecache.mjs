/*
 * The providers' cache interface over one append-only JSON-lines file, so a run that is
 * stopped (or killed) and started again doesn't ask Lichess or ChessDB twice. The whole
 * file is read into memory at start; every put is one appended line. A file mostly made
 * of superseded lines is rewritten on load.
 */

import fs from 'node:fs';

export function createFileCache(file, now) {
  now = now || Date.now;
  var m = new Map();
  var lines = 0;

  if (fs.existsSync(file)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach(function (l) {
      if (!l) return;
      try {
        var r = JSON.parse(l);
        m.set(r.s + '|' + r.k, { s: r.s, k: r.k, t: r.t, v: r.v });
        lines++;
      } catch (e) { /* a line cut short when the run was killed */ }
    });
    if (lines > m.size * 1.5 + 100) compact();
  }

  function compact() {
    var tmp = file + '.tmp';
    var out = [];
    m.forEach(function (r) { out.push(JSON.stringify(r)); });
    fs.writeFileSync(tmp, out.length ? out.join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
  }

  return {
    get: function (store, key, ttl) {
      var r = m.get(store + '|' + key);
      return Promise.resolve(r && now() - r.t < ttl ? r.v : undefined);
    },
    put: function (store, key, v) {
      var r = { s: store, k: key, t: now(), v: v };
      m.set(store + '|' + key, r);
      fs.appendFileSync(file, JSON.stringify(r) + '\n');
      return Promise.resolve();
    },
    count: function () { return Promise.resolve({ size: m.size }); }
  };
}

/*
 * The cache as a checked run sees it (repgen/check.mjs). since() is when the last check
 * started: a ChessDB answer from before it is stale, since newer evals are the point of
 * a check. Lichess answers never expire once a run has been checked, so its searches see
 * the games the repertoire was built on, and don't pay for them again. ChessDB's
 * "asked to analyse" records keep their own day.
 */
export function withFreshChessdb(cache, since, now) {
  now = now || Date.now;
  return {
    get: function (store, key, ttl) {
      var t = since();
      if (t) {
        if (store === 'explorer') ttl = Infinity;
        else if (store === 'chessdb' && key.indexOf('ask|') !== 0) ttl = Math.min(ttl, now() - t + 1);
      }
      return cache.get(store, key, ttl);
    },
    put: cache.put,
    count: cache.count
  };
}
