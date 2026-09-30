/*
 * explorerdb merge: sums sorted runs of index records (store.mjs's 22-byte records, sorted
 * by hash, then move) into one, keeping the positions that reach `minGames` in the sum.
 *
 * Index records are sorted, so this is a streaming k-way merge: memory stays at a few
 * buffers whatever the size of the inputs, and a 20 GB shard costs a read and a write.
 * The same merge adds a month to the accumulator (acc.mjs), prunes it, writes an index out
 * of it, and joins finished .xdb files (`explorerdb merge`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { REC, THRESHOLDS, openIndex, writeHeader, rewriteHeader, HEADER_PAD } from './store.mjs';

var CHUNK = REC * 190650;          // about 4 MB
var U32 = 0xffffffff;

// Sequential reader over the records of `file` from byte `start` to the end.
export function openRecords(file, start) {
  var fd = fs.openSync(file, 'r');
  var size = fs.fstatSync(fd).size;
  var pos = start || 0;
  var buf = Buffer.allocUnsafe(CHUNK), at = 0, len = 0;
  var r = { lo: 0, hi: 0, code: 0, w: 0, d: 0, b: 0, done: false };
  function fill() {
    // A torn tail (a file cut off mid-record) is an error, never silently dropped.
    var want = Math.min(CHUNK, size - pos);
    if (want <= 0) { len = 0; at = 0; return; }
    if (want % REC) throw new Error(file + ' ends inside a record (' + (size - (start || 0)) + ' bytes)');
    len = fs.readSync(fd, buf, 0, want, pos);
    pos += len;
    at = 0;
  }
  r.next = function () {
    if (at >= len) fill();
    if (at >= len) { r.done = true; fs.closeSync(fd); fd = -1; return false; }
    r.lo = buf.readUInt32LE(at);
    r.hi = buf.readUInt32LE(at + 4);
    r.code = buf.readUInt16LE(at + 8);
    r.w = buf.readUInt32LE(at + 10);
    r.d = buf.readUInt32LE(at + 14);
    r.b = buf.readUInt32LE(at + 18);
    at += REC;
    return true;
  };
  r.close = function () { if (fd >= 0) { fs.closeSync(fd); fd = -1; } };
  r.next();
  return r;
}

// Buffered writer of records to an open fd.
export function recordWriter(fd) {
  var buf = Buffer.allocUnsafe(CHUNK), used = 0, bytes = 0;
  return {
    put: function (lo, hi, code, w, d, b) {
      if (used === CHUNK) { fs.writeSync(fd, buf, 0, used); used = 0; }
      buf.writeUInt32LE(lo, used);
      buf.writeUInt32LE(hi, used + 4);
      buf.writeUInt16LE(code, used + 8);
      buf.writeUInt32LE(w, used + 10);
      buf.writeUInt32LE(d, used + 14);
      buf.writeUInt32LE(b, used + 18);
      used += REC;
      bytes += REC;
    },
    flush: function () { if (used) fs.writeSync(fd, buf, 0, used); used = 0; },
    bytes: function () { return bytes; }
  };
}

export function emptyStats() {
  return { positions: THRESHOLDS.map(function () { return 0; }),
    records: THRESHOLDS.map(function () { return 0; }), kept: 0, keptRecords: 0, dropped: 0,
    droppedGames: 0 };
}

export function addStats(a, b) {
  for (var i = 0; i < THRESHOLDS.length; i++) {
    a.positions[i] += b.positions[i];
    a.records[i] += b.records[i];
  }
  a.kept += b.kept;
  a.keptRecords += b.keptRecords;
  a.dropped += b.dropped || 0;
  a.droppedGames += b.droppedGames || 0;
  return a;
}

/*
 * Merges the record readers in `inputs` into `put` (recordWriter's), summing a move's
 * counts across inputs and keeping positions reached by at least `minGames` games.
 * Returns the stats of the merged positions: at each of THRESHOLDS, kept, and dropped
 * (positions, and the games that reached them); `out` has the same for what was kept.
 */
export function mergeRecords(inputs, minGames, put) {
  var live = inputs.filter(function (r) { return !r.done; });
  var st = emptyStats(), kept = emptyStats();
  // The position being summed: its moves, in code order.
  var codes = new Uint16Array(4096), W = new Float64Array(4096), D = new Float64Array(4096),
    B = new Float64Array(4096), n = 0, ended = false;
  while (live.length) {
    // The smallest hash among the inputs.
    var hi = live[0].hi, lo = live[0].lo;
    for (var i = 1; i < live.length; i++) {
      var x = live[i];
      if (x.hi < hi || (x.hi === hi && x.lo < lo)) { hi = x.hi; lo = x.lo; }
    }
    n = 0;
    var total = 0;
    // Take that position's records from every input, in move order.
    for (;;) {
      var best = -1, code = 0;
      for (var j = 0; j < live.length; j++) {
        var y = live[j];
        if (y.done || y.hi !== hi || y.lo !== lo) continue;
        if (best < 0 || y.code < code) { best = j; code = y.code; }
      }
      if (best < 0) break;
      var r = live[best];
      if (n && codes[n - 1] === code) { W[n - 1] += r.w; D[n - 1] += r.d; B[n - 1] += r.b; }
      else {
        if (n === codes.length) throw new Error('A position with over ' + n + ' records: not an index?');
        codes[n] = code; W[n] = r.w; D[n] = r.d; B[n] = r.b; n++;
      }
      total += r.w + r.d + r.b;
      if (!r.next()) ended = true;
    }
    if (ended) { live = live.filter(function (z) { return !z.done; }); ended = false; }
    for (var t = 0; t < THRESHOLDS.length; t++) {
      if (total >= THRESHOLDS[t]) { st.positions[t]++; st.records[t] += n; }
    }
    if (total >= minGames) {
      for (var u = 0; u < THRESHOLDS.length; u++) {
        if (total >= THRESHOLDS[u]) { kept.positions[u]++; kept.records[u] += n; }
      }
      st.kept++;
      st.keptRecords += n;
      for (var k = 0; k < n; k++) {
        if (W[k] > U32 || D[k] > U32 || B[k] > U32) {
          throw new Error('A count over 4,294,967,295 at hash ' + hi.toString(16) + lo.toString(16).padStart(8, '0'));
        }
        put(lo, hi, codes[k], W[k], D[k], B[k]);
      }
    } else {
      st.dropped++;
      st.droppedGames += total;
    }
  }
  kept.kept = st.kept;
  kept.keptRecords = st.keptRecords;
  st.out = kept;
  return st;
}

// Merges whole files (records from `start` of each) into a new file of records.
export function mergeFiles(files, minGames, out) {
  var inputs = files.map(function (f) {
    return typeof f === 'string' ? openRecords(f, 0) : openRecords(f.file, f.start);
  });
  var fd = fs.openSync(out, 'w');
  try {
    var wr = recordWriter(fd);
    var st = mergeRecords(inputs, minGames, wr.put);
    wr.flush();
    st.bytes = wr.bytes();
    return st;
  } finally {
    fs.closeSync(fd);
    inputs.forEach(function (r) { r.close(); });
  }
}

/*
 * Joins finished indexes (`explorerdb merge`) into `out`, keeping positions reached by
 * `minGames` in the sum. They must share the filter and ply limit. Each input has already
 * dropped its own positions under its own threshold, so a position can be missing games
 * here that the inputs each had too few of: the accumulator (acc.mjs) is the way round
 * that. Resolves with the new header.
 */
export function mergeIndexes(files, out, minGames) {
  var dbs = files.map(function (f) { return openIndex(f); });
  var inputs = [];
  try {
    var m0 = dbs[0].meta;
    dbs.forEach(function (db, i) {
      var m = db.meta;
      if (JSON.stringify(m.filter) !== JSON.stringify(m0.filter) || m.plies !== m0.plies) {
        throw new Error(path.basename(files[i]) + ' has another filter or ply limit than ' +
          path.basename(files[0]) + ' (' + JSON.stringify(m.filter) + ', ' + m.plies + ' plies)');
      }
    });
    inputs = dbs.map(function (db, i) { return openRecords(files[i], db.start); });
    var games = { read: 0, kept: 0, replayed: 0, illegal: 0, plies: 0,
      skipped: { broken: 0, variant: 0, speed: 0, rating: 0, result: 0 } };
    dbs.forEach(function (db) {
      var g = db.meta.report.games;
      ['read', 'kept', 'replayed', 'illegal', 'plies'].forEach(function (k) { games[k] += g[k] || 0; });
      Object.keys(games.skipped).forEach(function (k) { games.skipped[k] += (g.skipped && g.skipped[k]) || 0; });
    });
    var meta = {
      format: m0.format, hash: m0.hash,
      source: dbs.map(function (db) { return db.meta.source; }).join(' + '),
      filter: m0.filter, plies: m0.plies, minGames: minGames,
      created: new Date().toISOString(), report: null
    };
    var t0 = Date.now();
    var part = out + '.part';
    var fd = fs.openSync(part, 'w+');
    try {
      writeHeader(fd, meta, HEADER_PAD);
      var wr = recordWriter(fd);
      var st = mergeRecords(inputs, minGames, wr.put);
      wr.flush();
      meta.report = {
        games: games,
        spilled: dbs.reduce(function (n, db) { return n + (db.meta.report.spilled || 0); }, 0),
        thresholds: THRESHOLDS.map(function (t, i) {
          return { minGames: t, positions: st.positions[i], records: st.records[i], bytes: st.records[i] * REC };
        }),
        positions: st.kept, records: st.keptRecords,
        seconds: Math.round((Date.now() - t0) / 1000),
        inputMinGames: dbs.map(function (db) { return db.meta.minGames; })
      };
      rewriteHeader(fd, meta);
    } finally {
      fs.closeSync(fd);
    }
    fs.rmSync(out, { force: true });
    fs.renameSync(part, out);
    return meta;
  } finally {
    inputs.forEach(function (r) { r.close(); });
    dbs.forEach(function (db) { db.close(); });
  }
}
