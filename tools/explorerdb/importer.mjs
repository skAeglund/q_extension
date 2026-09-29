/*
 * explorerdb import: one Lichess dump (.pgn.zst or .pgn) -> an index file.
 *
 * The main thread decompresses, splits the text into games and filters them by their
 * headers; worker threads replay the games that pass and spill records to shard files;
 * then the same workers count the shards, and the main thread joins their output behind
 * the header. The temporary directory holds about 16 bytes per ply played past
 * `combinePlies`: some 10-15 GB for a month at 40 plies.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { makeFilter, HASH_NAME } from './games.mjs';
import { SHARDS, REC, THRESHOLDS, FORMAT, shardFile, writeHeader } from './store.mjs';

export var DEFAULTS = {
  speeds: ['blitz', 'rapid', 'classical'],
  ratings: [1600, 1800, 2000, 2200, 2500],
  plies: 40,
  minGames: 10,
  combinePlies: 12,
  batch: 2000
};

/*
 * The dump as text. Node 22.15+ has zstd built in; before that, the zstd program.
 * `finished` settles when the decompressor is done: a stream that merely ends is not
 * proof of success, because a zstd program that failed to start, or quit on an error,
 * still ends its output. That is how a missing zstd once imported "0 games" without a word.
 */
var NO_ZSTD = 'This Node (' + process.version + ') has no zstd built in (22.15 and later do), ' +
  'and the zstd program was not found. Update Node, install zstd, or decompress the dump ' +
  'first and import the .pgn.';

/**
 * Lichess's dumps are written by pzstd: a skippable frame (4 bytes of payload, the next
 * frame's size) before every frame of about 6 MB. Node's zstd decoder (24.14.1) gets both
 * wrong without a word:
 * - a skippable frame ends its output there (at byte 0 of a dump: "no games");
 * - a write holding the end of one frame and the start of the next ends it too, or fails,
 *   depending on where the write splits.
 * So this walks the frames by their headers (frame header, 3-byte block headers up to the
 * last block, the optional checksum), drops the skippable ones, and never passes on a chunk
 * that crosses from one frame into the next. Bytes that aren't a frame, or a file that ends
 * inside one, are an error here, since the decoder can't be trusted to say so.
 */
var ZSTD_MAGIC = 0xFD2FB528;
export function zstdFrames() {
  var left = null, copy = 0, skip = 0, inFrame = false, sum = 0, at = 0;
  return new Transform({
    transform: function (chunk, enc, cb) {
      var b = left ? Buffer.concat([left, chunk]) : chunk, i = 0;
      left = null;
      while (i < b.length) {
        if (copy || skip) {
          var c = Math.min(copy || skip, b.length - i);
          if (copy) { this.push(b.subarray(i, i + c)); copy -= c; } else skip -= c;
          i += c; at += c;
          continue;
        }
        var have = b.length - i;
        if (inFrame) {
          if (have < 3) break;
          var h = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
          copy = 3 + (((h >> 1) & 3) === 1 ? 1 : h >>> 3);     // an RLE block holds 1 byte
          if (h & 1) { copy += sum; inFrame = false; }
          continue;
        }
        if (have < 8) break;
        var magic = b.readUInt32LE(i);
        if ((magic & 0xFFFFFFF0) === 0x184D2A50) { skip = 8 + b.readUInt32LE(i + 4); continue; }
        if (magic !== ZSTD_MAGIC) return cb(new Error('Not a zstd frame at byte ' + at + ' of the dump'));
        var fhd = b[i + 4], single = (fhd >> 5) & 1;
        copy = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single ? 1 : 0, 2, 4, 8][fhd >> 6];
        sum = (fhd >> 2) & 1 ? 4 : 0;
        inFrame = true;
      }
      if (i < b.length) left = Buffer.from(b.subarray(i));
      cb();
    },
    flush: function (cb) {
      cb(left || copy || inFrame ? new Error('The dump ends inside a zstd frame (byte ' + at + ')') : null);
    }
  });
}

function openText(file, onBytes) {
  var raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  raw.on('data', function (b) { onBytes(b.length); });
  var none = function () {};
  if (!/\.zst$/i.test(file)) return { stream: raw, raw: raw, finished: Promise.resolve(), stop: none };
  if (typeof zlib.createZstdDecompress === 'function') {
    // Node's decoder emits 'end' before its 'error', so only 'close' says it is done.
    var z = zlib.createZstdDecompress();
    var zDone = new Promise(function (resolve, reject) {
      z.on('error', reject);
      z.on('close', resolve);
    });
    zDone.catch(none);
    var frames = zstdFrames();
    frames.on('error', function (e) { z.destroy(e); });
    return { stream: raw.pipe(frames).pipe(z), raw: raw, finished: zDone, stop: none };
  }
  var p = spawn('zstd', ['-dc'], { stdio: ['pipe', 'pipe', 'pipe'] });
  var stderr = '';
  p.stderr.on('data', function (b) { stderr += b; });
  p.stdin.on('error', none);        // EPIPE once zstd has stopped reading
  var finished = new Promise(function (resolve, reject) {
    p.on('error', function (e) { reject(e && e.code === 'ENOENT' ? new Error(NO_ZSTD) : e); });
    p.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('zstd failed (exit ' + code + ')' + (stderr.trim() ? ': ' + stderr.trim() : '')));
    });
  });
  finished.catch(none);
  raw.pipe(p.stdin);
  return { stream: p.stdout, raw: raw, finished: finished, stop: function () { p.kill(); } };
}

function createPool(n, data) {
  var url = new URL('./worker.mjs', import.meta.url);
  var slots = [];
  for (var i = 0; i < n; i++) {
    var slot = { w: new Worker(url, { workerData: Object.assign({ id: i }, data) }), busy: 0, waiting: [] };
    // A worker answers its messages in order, one reply each.
    slot.w.on('message', function (m) {
      var p = this.waiting.shift();
      this.busy--;
      if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    }.bind(slot));
    slot.w.on('error', function (e) {
      this.waiting.splice(0).forEach(function (p) { p.reject(e); });
    }.bind(slot));
    slots.push(slot);
  }
  return slots;
}

// Posts a message and resolves with the worker's reply.
function ask(slot, msg) {
  slot.busy++;
  return new Promise(function (resolve, reject) {
    slot.waiting.push({ resolve: resolve, reject: reject });
    slot.w.postMessage(msg);
  });
}

function fmt(n) { return n.toLocaleString('en-US'); }
function mb(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB'; }
function mins(ms) {
  var s = Math.round(ms / 1000);
  return s >= 60 ? Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's' : s + 's';
}

/*
 * o: { input, out, speeds, ratings, plies, minGames, combinePlies, workers, maxGames,
 *      tmp, keepTmp, log }
 * Resolves with the header written to the index (its `report` has the counts).
 */
export async function importDump(o) {
  o = Object.assign({}, DEFAULTS, o);
  var log = o.log || function () {};
  var nWorkers = o.workers || Math.max(1, Math.min(8, os.cpus().length - 1));
  var tmp = o.tmp || o.out + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  var size = fs.statSync(o.input).size;
  var t0 = Date.now();

  var pool = createPool(nWorkers, { dir: tmp, plies: o.plies, combinePlies: o.combinePlies });
  var filter = makeFilter(o);
  var why = { broken: 0, variant: 0, speed: 0, rating: 0, result: 0 };
  var n = { read: 0, kept: 0, replayed: 0, bad: 0, plies: 0, bytes: 0 };

  try {
    await new Promise(function (resolve, reject) {
      var src = openText(o.input, function (b) { n.bytes += b; });
      var text = src.stream;
      text.setEncoding('latin1');   // headers and moves are ASCII; names don't matter here
      var carry = '', batch = [], inflight = 0, ended = false, done = false, lastLog = Date.now();
      var failed = function (e) {
        if (done) return;
        done = ended = true;
        src.raw.destroy();          // an open stream would keep the process alive
        text.destroy();
        src.stop();
        reject(e);
      };

      function progress(force) {
        var now = Date.now();
        if (!force && now - lastLog < 10000) return;
        lastLog = now;
        var frac = n.bytes / size, el = now - t0;
        log('read ' + fmt(n.read) + ' games (' + mb(n.bytes) + ' of ' + mb(size) + ', ' +
          (100 * frac).toFixed(1) + '%), kept ' + fmt(n.kept) + ', ' +
          fmt(Math.round(n.read / (el / 1000))) + ' games/s' +
          (frac > 0.01 && frac < 1 ? ', about ' + mins(el / frac - el) + ' to go' : ''));
      }
      function finishIfDone() {
        if (ended && inflight === 0 && !done) { done = true; resolve(); }
      }
      function send() {
        if (!batch.length) return;
        var games = batch;
        batch = [];
        var slot = pool.reduce(function (a, b) { return b.busy < a.busy ? b : a; });
        inflight++;
        if (inflight >= nWorkers * 2) text.pause();
        ask(slot, { type: 'replay', games: games }).then(function (m) {
          n.replayed += m.result.games;
          n.bad += m.result.bad;
          n.plies += m.result.plies;
          inflight--;
          if (inflight < nWorkers && !ended) text.resume();
          finishIfDone();
        }, failed);
      }
      function take(game) {
        if (o.maxGames && n.read >= o.maxGames) return false;
        n.read++;
        var g = filter(game, why);
        if (g) {
          n.kept++;
          batch.push(g);
          if (batch.length >= o.batch) send();
        }
        return true;
      }
      function stop() {
        if (ended) return;
        ended = true;
        send();
        progress(true);
        src.raw.destroy();
        text.destroy();
        src.stop();
        finishIfDone();
      }

      text.on('data', function (chunk) {
        if (ended) return;
        var s = carry + chunk;
        // A game starts at "[Event "; everything before the last one is complete games.
        var at = 0, next;
        while ((next = s.indexOf('\n[Event ', at + 1)) >= 0) {
          if (!take(s.slice(at, next + 1))) { stop(); return; }
          at = next + 1;
        }
        carry = s.slice(at);
        progress(false);
      });
      text.on('end', function () {
        if (ended) return;
        src.finished.then(function () {
          if (!ended && carry.trim()) take(carry);
          stop();
        }, failed);
      });
      text.on('error', function (e) { if (!ended) failed(e); });
      src.raw.on('error', function (e) { if (!ended) failed(e); });
    });

    // An index of nothing is never what was meant: say why instead of writing one.
    if (!n.read || n.read === why.broken) {
      throw new Error('No games in ' + path.basename(o.input) + ' (' + mb(n.bytes) + ' read). ' +
        'Is it a Lichess PGN dump, .pgn or .pgn.zst?');
    }
    if (!n.kept) {
      throw new Error('None of the ' + n.read + ' games passed the filter (skipped for speed ' +
        why.speed + ', rating ' + why.rating + ', variant or set-up ' + why.variant + ', no result ' +
        why.result + ').');
    }
    await Promise.all(pool.map(function (slot) { return ask(slot, { type: 'finish' }); }));
    var tRead = Date.now();
    log('replayed ' + fmt(n.replayed) + ' games (' + fmt(n.plies) + ' plies) in ' + mins(tRead - t0) +
      '; counting ' + SHARDS + ' shards');

    // Count the shards, several at once.
    var stats = new Array(SHARDS), next = 0;
    await Promise.all(pool.map(async function (slot) {
      while (next < SHARDS) {
        var s = next++;
        var files = pool.map(function (_, w) { return shardFile(tmp, s, w); });
        var m = await ask(slot, { type: 'aggregate', shard: s, files: files, minGames: o.minGames,
          out: tmp + '/out' + String(s).padStart(3, '0') + '.bin' });
        stats[s] = m.stats;
        files.forEach(function (f) { if (!o.keepTmp) fs.rmSync(f, { force: true }); });
      }
    }));
  } catch (e) {
    if (!o.keepTmp) fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    await Promise.all(pool.map(function (slot) { return slot.w.terminate(); }));
  }

  var report = {
    games: { read: n.read, kept: n.kept, replayed: n.replayed, illegal: n.bad, plies: n.plies,
      skipped: why },
    spilled: 0,
    thresholds: THRESHOLDS.map(function (t) { return { minGames: t, positions: 0, records: 0 }; }),
    positions: 0,
    records: 0,
    seconds: 0
  };
  stats.forEach(function (st) {
    report.spilled += st.spilled;
    report.positions += st.kept;
    report.records += st.keptRecords;
    st.positions.forEach(function (p, i) {
      report.thresholds[i].positions += p;
      report.thresholds[i].records += st.records[i];
    });
  });
  report.thresholds.forEach(function (t) { t.bytes = t.records * REC; });
  report.seconds = Math.round((Date.now() - t0) / 1000);

  var meta = {
    format: FORMAT,
    hash: HASH_NAME,
    source: path.basename(o.input),
    filter: { speeds: o.speeds, ratings: o.ratings },
    plies: o.plies,
    minGames: o.minGames,
    created: new Date().toISOString(),
    report: report
  };
  var fd = fs.openSync(o.out, 'w');
  try {
    writeHeader(fd, meta);
    var buf = Buffer.allocUnsafe(1 << 22);
    for (var s = 0; s < SHARDS; s++) {
      var f = tmp + '/out' + String(s).padStart(3, '0') + '.bin';
      var ifd = fs.openSync(f, 'r'), got;
      while ((got = fs.readSync(ifd, buf, 0, buf.length, null)) > 0) fs.writeSync(fd, buf, 0, got);
      fs.closeSync(ifd);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!o.keepTmp) fs.rmSync(tmp, { recursive: true, force: true });
  return meta;
}
