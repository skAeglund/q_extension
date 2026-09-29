/*
 * explorerdb: the files. Spilled records while importing, and the finished index.
 *
 * Importing is external counting: the workers write every (position, move, result) they
 * replay to one of 256 shard files, by the hash's top byte, and each shard is then counted
 * on its own by sorting. A JS Map keyed by 64-bit hashes (BigInt) manages about a million
 * updates a second, a quarter of the replay's speed, and a month's positions wouldn't fit
 * in memory anyway. The first plies are the exception: every game passes through them, so
 * the workers count those in memory (worker.mjs) and a shard never holds millions of copies
 * of the start position.
 *
 * Spilled record, 16 bytes: hash u64, move u16, white u16, draws u16, black u16.
 *
 * Index file:
 *   "QXXDB001", u32 length of the JSON header, the JSON header, then records of 22 bytes
 *   sorted by hash, then move: hash u64, move u16, white u32, draws u32, black u32.
 *   A position's records are its moves, plus ENDED and CUT (games.mjs) for the games that
 *   stopped there. Only positions reached by at least `minGames` games are kept, with all
 *   their moves. Format 2: format 1 (before CUT) counted both as ENDED.
 * All little-endian.
 */

import fs from 'node:fs';
import { Chess } from '../../src/vendor/chess.js';
import { codeParts, fullFen, keyOf, HASH_NAME, CUT } from './games.mjs';

export var SHARDS = 256;
export var SPILL = 16;
export var REC = 22;
var MAGIC = 'QXXDB001';
export var FORMAT = 2;

// Positions reached by at least this many games: the report's rows.
export var THRESHOLDS = [1, 2, 3, 5, 10, 20, 50, 100, 1000];

export function shardOf(hash) { return Number(hash >> 56n); }

export function shardFile(dir, shard, worker) {
  return dir + '/s' + String(shard).padStart(3, '0') + '.w' + worker + '.bin';
}

// Per-shard buffers, appended to the worker's own file for that shard when full.
export function createSpill(dir, worker, bufBytes) {
  bufBytes = bufBytes || 128 * 1024;
  var bufs = [], used = new Array(SHARDS).fill(0);
  for (var s = 0; s < SHARDS; s++) bufs.push(Buffer.allocUnsafe(bufBytes));
  var records = 0;
  function flushShard(s) {
    if (!used[s]) return;
    fs.appendFileSync(shardFile(dir, s, worker), bufs[s].subarray(0, used[s]));
    used[s] = 0;
  }
  function put(hash, code, w, d, b) {
    // Counts over 65,535 go out as more than one record; they add up again when counted.
    while (w > 0xffff || d > 0xffff || b > 0xffff) {
      var cw = Math.min(w, 0xffff), cd = Math.min(d, 0xffff), cb = Math.min(b, 0xffff);
      put(hash, code, cw, cd, cb);
      w -= cw; d -= cd; b -= cb;
    }
    var s = shardOf(hash);
    if (used[s] + SPILL > bufBytes) flushShard(s);
    var buf = bufs[s], o = used[s];
    buf.writeBigUInt64LE(hash, o);
    buf.writeUInt16LE(code, o + 8);
    buf.writeUInt16LE(w, o + 10);
    buf.writeUInt16LE(d, o + 12);
    buf.writeUInt16LE(b, o + 14);
    used[s] = o + SPILL;
    records++;
  }
  return {
    put: put,
    flush: function () { for (var s = 0; s < SHARDS; s++) flushShard(s); },
    records: function () { return records; }
  };
}

/*
 * Counts one shard: sorts its spilled records by (hash, move), sums them, and writes the
 * positions reached by at least `minGames` games to `out` as index records. Returns the
 * counts for the report: positions and index records at each of THRESHOLDS.
 */
export function aggregateShard(files, minGames, out) {
  var parts = files.filter(function (f) { return fs.existsSync(f); })
    .map(function (f) { return fs.readFileSync(f); });
  var buf = Buffer.concat(parts);
  parts = null;
  var n = buf.length / SPILL;
  var hi = new Uint32Array(n), lo = new Uint32Array(n), mv = new Uint16Array(n);
  var idx = new Uint32Array(n);
  for (var i = 0; i < n; i++) {
    lo[i] = buf.readUInt32LE(i * SPILL);
    hi[i] = buf.readUInt32LE(i * SPILL + 4);
    mv[i] = buf.readUInt16LE(i * SPILL + 8);
    idx[i] = i;
  }
  idx.sort(function (a, b) { return (hi[a] - hi[b]) || (lo[a] - lo[b]) || (mv[a] - mv[b]); });

  var stats = { spilled: n, positions: THRESHOLDS.map(function () { return 0; }),
    records: THRESHOLDS.map(function () { return 0; }), kept: 0, keptRecords: 0 };
  var outBuf = Buffer.allocUnsafe(1 << 20), outUsed = 0;
  var fd = fs.openSync(out, 'w');
  function write(h, l, code, w, d, b) {
    if (outUsed + REC > outBuf.length) { fs.writeSync(fd, outBuf, 0, outUsed); outUsed = 0; }
    outBuf.writeUInt32LE(l, outUsed);
    outBuf.writeUInt32LE(h, outUsed + 4);
    outBuf.writeUInt16LE(code, outUsed + 8);
    outBuf.writeUInt32LE(w, outUsed + 10);
    outBuf.writeUInt32LE(d, outUsed + 14);
    outBuf.writeUInt32LE(b, outUsed + 18);
    outUsed += REC;
  }

  var moves = [];           // [code, w, d, b] of the position being summed
  var k = 0;
  while (k < n) {
    var h = hi[idx[k]], l = lo[idx[k]];
    moves.length = 0;
    var total = 0;
    while (k < n && hi[idx[k]] === h && lo[idx[k]] === l) {
      var r = idx[k] * SPILL, code = mv[idx[k]];
      var w = buf.readUInt16LE(r + 10), d = buf.readUInt16LE(r + 12), b = buf.readUInt16LE(r + 14);
      var last = moves[moves.length - 1];
      if (last && last[0] === code) { last[1] += w; last[2] += d; last[3] += b; }
      else moves.push([code, w, d, b]);
      total += w + d + b;
      k++;
    }
    for (var t = 0; t < THRESHOLDS.length; t++) {
      if (total >= THRESHOLDS[t]) { stats.positions[t]++; stats.records[t] += moves.length; }
    }
    if (total >= minGames) {
      stats.kept++;
      stats.keptRecords += moves.length;
      for (var j = 0; j < moves.length; j++) write(h, l, moves[j][0], moves[j][1], moves[j][2], moves[j][3]);
    }
  }
  if (outUsed) fs.writeSync(fd, outBuf, 0, outUsed);
  fs.closeSync(fd);
  return stats;
}

export function writeHeader(fd, meta) {
  var json = Buffer.from(JSON.stringify(meta), 'utf8');
  var head = Buffer.alloc(12);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(json.length, 8);
  fs.writeSync(fd, head);
  fs.writeSync(fd, json);
  return 12 + json.length;
}

export function openIndex(file) {
  var fd = fs.openSync(file, 'r');
  var head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  if (head.toString('latin1', 0, 8) !== MAGIC) {
    fs.closeSync(fd);
    throw new Error(file + ' is not an explorerdb index.');
  }
  var len = head.readUInt32LE(8);
  var json = Buffer.alloc(len);
  fs.readSync(fd, json, 0, len, 12);
  var meta = JSON.parse(json.toString('utf8'));
  if (meta.format !== FORMAT) {
    fs.closeSync(fd);
    throw new Error(file + ' is an index of format ' + meta.format + '; this reader needs ' + FORMAT +
      '. Import the dump again.');
  }
  if (meta.hash !== HASH_NAME) {
    fs.closeSync(fd);
    throw new Error(file + ' was made with ' + meta.hash + ', this reader uses ' + HASH_NAME + '.');
  }
  var start = 12 + len;
  var n = Math.floor((fs.fstatSync(fd).size - start) / REC);
  var probe = Buffer.alloc(8);
  function hashAt(i) {
    fs.readSync(fd, probe, 0, 8, start + i * REC);
    return probe.readBigUInt64LE(0);
  }
  return {
    meta: meta,
    count: n,
    // [{code, white, draws, black}] of a position's records, or [] if it isn't kept.
    records: function (key) {
      var a = 0, b = n;                       // first record with hash >= key
      while (a < b) {
        var m = (a + b) >>> 1;
        if (hashAt(m) < key) a = m + 1; else b = m;
      }
      var out = [], chunk = Buffer.alloc(REC * 64);
      for (var i = a; i < n; i += 64) {
        var got = fs.readSync(fd, chunk, 0, REC * Math.min(64, n - i), start + i * REC) / REC;
        for (var j = 0; j < got; j++) {
          if (chunk.readBigUInt64LE(j * REC) !== key) return out;
          out.push({ code: chunk.readUInt16LE(j * REC + 8), white: chunk.readUInt32LE(j * REC + 10),
            draws: chunk.readUInt32LE(j * REC + 14), black: chunk.readUInt32LE(j * REC + 18) });
        }
      }
      return out;
    },
    close: function () { fs.closeSync(fd); }
  };
}

/*
 * A position in the Lichess explorer's JSON shape, the parts compactExplorer()
 * (src/pe/providers.js) reads: totals, and moves with uci, san and counts, most played
 * first (at most `limit`). Castling is written king-takes-rook (e1h1), as the explorer
 * does. The totals leave out the games the ply limit cut off here: their next move isn't
 * in the index, and the search reads the moves as shares of the total. So a position
 * only reached at the limit answers with zeros, as one that isn't in the index does
 * (a position with fewer games than the index keeps); `indexed` and `cut` tell them apart.
 */
export function explorerAnswer(db, fen, limit) {
  var recs = db.records(keyOf(fen));
  var c = new Chess(fullFen(fen));
  var legal = c.moves({ verbose: true });
  var res = { white: 0, draws: 0, black: 0, moves: [], topGames: [], recentGames: [],
    opening: null, indexed: recs.length > 0, cut: 0 };
  recs.forEach(function (r) {
    if (r.code === CUT) { res.cut += r.white + r.draws + r.black; return; }
    res.white += r.white; res.draws += r.draws; res.black += r.black;
    if (!r.code) return;
    var p = codeParts(r.code);
    var mo = legal.find(function (x) {
      return x.from === p.from && x.to === p.to && x.promotion === p.promotion;
    });
    if (!mo) return;                          // only a hash collision could do this
    var uci = p.from + p.to + (p.promotion || '');
    if (mo.isKingsideCastle()) uci = p.from + 'h' + p.from[1];
    else if (mo.isQueensideCastle()) uci = p.from + 'a' + p.from[1];
    res.moves.push({ uci: uci, san: mo.san, white: r.white, draws: r.draws, black: r.black });
  });
  res.moves.sort(function (a, b) {
    return (b.white + b.draws + b.black) - (a.white + a.draws + a.black);
  });
  if (limit >= 0 && res.moves.length > limit) res.moves.length = limit;
  return res;
}
