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
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { makeFilter, HASH_NAME } from './games.mjs';
import { SHARDS, REC, THRESHOLDS, shardFile, writeHeader } from './store.mjs';

export var DEFAULTS = {
  speeds: ['blitz', 'rapid', 'classical'],
  ratings: [1600, 1800, 2000, 2200, 2500],
  plies: 40,
  minGames: 10,
  combinePlies: 12,
  batch: 2000
};

// The dump as text. Node 22.15+ has zstd built in; before that, the zstd program.
function openText(file, onBytes) {
  var raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  raw.on('data', function (b) { onBytes(b.length); });
  if (!/\.zst$/i.test(file)) return { stream: raw, raw: raw };
  if (typeof zlib.createZstdDecompress === 'function') {
    return { stream: raw.pipe(zlib.createZstdDecompress()), raw: raw };
  }
  var p = spawn('zstd', ['-dc'], { stdio: ['pipe', 'pipe', 'inherit'] });
  p.on('error', function () {
    raw.destroy(new Error('This Node has no zstd (22.15+ does), and the zstd program was not ' +
      'found. Update Node, install zstd, or decompress the dump first.'));
  });
  raw.pipe(p.stdin);
  return { stream: p.stdout, raw: raw };
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
        if (!ended && carry.trim()) take(carry);
        stop();
      });
      text.on('error', function (e) { if (!ended) failed(e); });
      src.raw.on('error', function (e) { if (!ended) failed(e); });
    });

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
    format: 1,
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
