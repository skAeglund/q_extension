/*
 * explorerdb merge: several indexes (a month each, as drain makes them) -> one.
 *
 * Every index is sorted by (hash, move), so this is a k-way merge that streams each file
 * once: records of the same position and move are summed, and a position is kept if its
 * summed games reach `minGames`. Memory is a buffer per input, whatever the sizes.
 *
 * What it can't do: a month's index only holds the positions that month reached
 * `minGames` times, so a position under that in some months is missing those months'
 * games here. The merge never counts too many, only too few, and only for positions that
 * are rare in some month; and a month holds all the moves of every position it kept, so
 * the moves' shares within one month stay whole. Counting months together exactly is
 * importing their filtered files in one go (import <folder>), which this complements:
 * import a year at a time, then merge the years.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REC, FORMAT, THRESHOLDS, openIndex } from './store.mjs';
import { HASH_NAME } from './games.mjs';

var MAGIC = 'QXXDB001';

// Sequential reader of one index's records.
function cursor(file) {
  var db = openIndex(file);
  var meta = db.meta, count = db.count;
  db.close();
  var fd = fs.openSync(file, 'r');
  var head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  var start = 12 + head.readUInt32LE(8);
  var buf = Buffer.allocUnsafe(REC * 16384), have = 0, at = 0, next = 0;
  var c = { meta: meta, count: count, file: file, done: false, lo: 0, hi: 0, code: 0, w: 0, d: 0, b: 0 };
  c.advance = function () {
    if (at >= have) {
      if (next >= count) { c.done = true; fs.closeSync(fd); return; }
      var n = Math.min(16384, count - next);
      fs.readSync(fd, buf, 0, n * REC, start + next * REC);
      next += n; have = n; at = 0;
    }
    var o = at * REC;
    c.lo = buf.readUInt32LE(o);
    c.hi = buf.readUInt32LE(o + 4);
    c.code = buf.readUInt16LE(o + 8);
    c.w = buf.readUInt32LE(o + 10);
    c.d = buf.readUInt32LE(o + 14);
    c.b = buf.readUInt32LE(o + 18);
    at++;
  };
  return c;
}

function less(a, b) {
  return a.hi !== b.hi ? a.hi < b.hi : a.lo !== b.lo ? a.lo < b.lo : a.code < b.code;
}

// A binary heap of cursors, by (hash, move).
function heap(items) {
  var h = items.slice();
  function down(i) {
    for (;;) {
      var l = 2 * i + 1, r = l + 1, m = i;
      if (l < h.length && less(h[l], h[m])) m = l;
      if (r < h.length && less(h[r], h[m])) m = r;
      if (m === i) return;
      var t = h[i]; h[i] = h[m]; h[m] = t; i = m;
    }
  }
  for (var i = (h.length >> 1) - 1; i >= 0; i--) down(i);
  return {
    top: function () { return h[0]; },
    size: function () { return h.length; },
    // The top cursor moved on: put it back in its place, or drop it when it's done.
    fix: function () {
      if (h[0].done) { var last = h.pop(); if (h.length) { h[0] = last; down(0); } }
      else down(0);
    }
  };
}

// Inputs must count the same thing the same way.
export function checkCompatible(metas, files) {
  var a = metas[0];
  metas.forEach(function (m, i) {
    var what = m.hash !== a.hash ? ['the hash', m.hash, a.hash] :
      m.plies !== a.plies ? ['plies', m.plies, a.plies] :
      String(m.filter.speeds) !== String(a.filter.speeds) ? ['speeds', m.filter.speeds, a.filter.speeds] :
      String(m.filter.ratings) !== String(a.filter.ratings) ? ['ratings', m.filter.ratings, a.filter.ratings] : null;
    if (what) {
      throw new Error('Different ' + what[0] + ': ' + path.basename(files[i]) + ' has ' + what[1] + ', ' +
        path.basename(files[0]) + ' ' + what[2] + '. Indexes counted differently can\'t be merged.');
    }
  });
}

/*
 * o: { inputs: [index files], out, minGames, log }. Resolves with the merged index's
 * header. The same source twice is refused: it would count its games twice.
 */
export async function mergeIndexes(o) {
  var log = o.log || function () {};
  if (o.inputs.length < 2) throw new Error('Merging needs at least two indexes');
  var cs = o.inputs.map(cursor);
  var metas = cs.map(function (c) { return c.meta; });
  checkCompatible(metas, o.inputs);
  var seen = {};
  metas.forEach(function (m, i) {
    (m.merged ? m.merged.map(function (x) { return x.source; }) : [m.source]).forEach(function (k) {
      if (seen[k]) throw new Error(path.basename(o.inputs[i]) + ' and ' + seen[k] + ' both hold ' + k);
      seen[k] = path.basename(o.inputs[i]);
    });
  });
  var minGames = Math.max(1, o.minGames || 1);
  var t0 = Date.now();

  // The header is written last, once the counts are known, into room left for it now.
  var sources = [];                          // a merged input brings its own list
  metas.forEach(function (m) {
    if (m.merged) sources = sources.concat(m.merged);
    else sources.push({ source: m.source, minGames: m.minGames, games: m.report.games.kept, created: m.created });
  });
  var reserve = Buffer.byteLength(JSON.stringify(sources)) + 65536;
  var tmp = o.out + '.partial';
  var fd = fs.openSync(tmp, 'w');
  var out = Buffer.allocUnsafe(REC * 16384), used = 0;
  function write(lo, hi, code, w, d, b) {
    if (used + REC > out.length) { fs.writeSync(fd, out, 0, used, null); used = 0; }
    out.writeUInt32LE(lo, used);
    out.writeUInt32LE(hi, used + 4);
    out.writeUInt16LE(code, used + 8);
    out.writeUInt32LE(w, used + 10);
    out.writeUInt32LE(d, used + 14);
    out.writeUInt32LE(b, used + 18);
    used += REC;
  }

  var stats = { positions: THRESHOLDS.map(function () { return 0; }),
    records: THRESHOLDS.map(function () { return 0; }), kept: 0, keptRecords: 0, read: 0 };
  var total = cs.reduce(function (a, c) { return a + c.count; }, 0), lastLog = t0;
  try {
    // Written at the file's own offset (null), which the records then follow.
    fs.writeSync(fd, Buffer.alloc(12 + reserve), 0, 12 + reserve, null);
    var h = heap(cs.filter(function (c) { c.advance(); return !c.done; }));
    var moves = [];                           // [code, w, d, b] of the position being summed
    while (h.size()) {
      var top = h.top(), phi = top.hi, plo = top.lo, games = 0;
      moves.length = 0;
      while (h.size() && h.top().hi === phi && h.top().lo === plo) {
        var c = h.top(), last = moves[moves.length - 1];
        if (last && last[0] === c.code) { last[1] += c.w; last[2] += c.d; last[3] += c.b; }
        else moves.push([c.code, c.w, c.d, c.b]);
        games += c.w + c.d + c.b;
        stats.read++;
        c.advance();
        h.fix();
      }
      for (var t = 0; t < THRESHOLDS.length; t++) {
        if (games >= THRESHOLDS[t]) { stats.positions[t]++; stats.records[t] += moves.length; }
      }
      if (games >= minGames) {
        stats.kept++;
        stats.keptRecords += moves.length;
        for (var j = 0; j < moves.length; j++) write(plo, phi, moves[j][0], moves[j][1], moves[j][2], moves[j][3]);
      }
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        log('merged ' + (100 * stats.read / total).toFixed(1) + '% of ' + total.toLocaleString('en-US') + ' records');
      }
    }
    if (used) fs.writeSync(fd, out, 0, used, null);

    var sum = function (f) { return metas.reduce(function (a, m) { return a + (f(m) || 0); }, 0); };
    var skipped = {};
    metas.forEach(function (m) {
      Object.keys(m.report.games.skipped || {}).forEach(function (k) { skipped[k] = (skipped[k] || 0) + m.report.games.skipped[k]; });
    });
    var meta = {
      format: FORMAT,
      hash: HASH_NAME,
      source: 'merge of ' + sources.length + ' sources: ' + sources.map(function (x) { return x.source; }).join(', ').slice(0, 200),
      merged: sources,
      filter: metas[0].filter,
      plies: metas[0].plies,
      minGames: minGames,
      created: new Date().toISOString(),
      report: {
        games: { read: sum(function (m) { return m.report.games.read; }), kept: sum(function (m) { return m.report.games.kept; }),
          replayed: sum(function (m) { return m.report.games.replayed; }), illegal: sum(function (m) { return m.report.games.illegal; }),
          plies: sum(function (m) { return m.report.games.plies; }), skipped: skipped },
        spilled: stats.read,
        thresholds: THRESHOLDS.map(function (th, i) {
          return { minGames: th, positions: stats.positions[i], records: stats.records[i], bytes: stats.records[i] * REC };
        }),
        positions: stats.kept,
        records: stats.keptRecords,
        seconds: Math.round((Date.now() - t0) / 1000)
      }
    };
    var json = JSON.stringify(meta);
    var pad = reserve - Buffer.byteLength(json);
    if (pad < 0) throw new Error('The merged header outgrew its room');
    json += ' '.repeat(pad);                 // JSON.parse ignores the trailing spaces
    var head = Buffer.alloc(12);
    head.write(MAGIC, 0, 'latin1');
    head.writeUInt32LE(Buffer.byteLength(json), 8);
    fs.writeSync(fd, head, 0, 12, 0);
    fs.writeSync(fd, Buffer.from(json, 'utf8'), 0, Buffer.byteLength(json), 12);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, o.out);
    return meta;
  } catch (e) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
