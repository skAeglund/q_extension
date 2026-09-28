/*
 * Maia 3 for repgen: the search's provider.maia (src/pe/search.js), computed in Node.
 * The extension asks the Qchess tab for Maia; repgen runs the model itself, through
 * onnxruntime-node (tools/package.json, installed with `npm install --prefix tools`).
 *
 * The model is CSSLab's maia3_simplified.onnx from their Maia platform (GPL-3), ~46 MB,
 * the size of the model Qchess keeps. It is downloaded on first use, never shipped. The
 * encoding below is written from the platform's description of its inputs and outputs,
 * not copied from its code:
 *
 *   tokens       [B, 64, 12]  one-hot pieces by square (a1 = 0, b1 = 1, ... h8 = 63): White's
 *                             P N B R Q K, then Black's p n b r q k. Always from the side to
 *                             move's view: with Black to move the board is flipped top to
 *                             bottom and the colours swapped. Castling rights, en passant
 *                             and the side to move are not inputs.
 *   elo_self     [B]          the rating Maia plays at, a plain number (trained 600-2600)
 *   elo_oppo     [B]          the opponent's; the platform passes the same number twice
 *   logits_move  [B, 4352]    in the same flipped frame: from * 64 + to for every pair of
 *                             squares, then 256 promotions, 4096 + (from file * 8 + to
 *                             file) * 4 + [q r b n] (always rank 7 to rank 8)
 *   logits_value [B, 3]       loss / draw / win, unused
 *
 * The policy is a softmax over the legal moves alone, which chess.js lists.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Chess } from '../../src/vendor/chess.js';
import { fenKey } from '../../src/pe/search.js';

export var MAIA_FILE = 'maia3_simplified.onnx';
// Pinned to the commit the encoding was checked against (2026-09-28), so a newer model on
// their main branch never replaces this one unnoticed.
export var MAIA_URL = 'https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/' +
  'a6e52f5c811ee18863cb2f0e81f2433a5b9905de/public/maia3/' + MAIA_FILE;
export var MAIA_SHA256 = '405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856';
export var MAIA_BYTES = 45683686;

var PIECES = 'PNBRQKpnbrqk';
var PROMOS = 'qrbn';
export var MAIA_MOVES = 4352;
var TOKENS = 64 * 12;
// The long tail carries no weight, only size: the extension drops it too.
var MIN_PROB = 0.001;

// Maia stands in for the filter's players, so it plays at their rating: the mean of the
// rating groups' midpoints (2500 is 2500+), in Maia's range. The extension's peMaiaElo.
var MID = { 0: 800, 1000: 1100, 1200: 1300, 1400: 1500, 1600: 1700, 1800: 1900,
  2000: 2100, 2200: 2350, 2500: 2650 };
export function maiaEloFor(ratings) {
  var sum = 0, n = 0;
  (ratings || []).forEach(function (b) {
    var m = MID[b] != null ? MID[b] : Number(b) + 100;
    if (isFinite(m)) { sum += m; n++; }
  });
  return clampElo(n ? sum / n : 1900);
}

export function clampElo(elo) {
  return Math.max(600, Math.min(2600, Math.round(Number(elo) / 50) * 50));
}

function square(s) { return (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97); }
function flip(s) { return s[0] + (9 - Number(s[1])); }

// A move's output index, its squares already in the model's frame.
export function moveIndex(from, to, promotion) {
  if (!promotion) return square(from) * 64 + square(to);
  return 4096 + ((from.charCodeAt(0) - 97) * 8 + (to.charCodeAt(0) - 97)) * 4 +
    PROMOS.indexOf(promotion);
}

export function maiaTokens(fen) {
  var parts = String(fen).trim().split(/\s+/);
  var black = parts[1] === 'b';
  var rows = parts[0].split('/');
  var t = new Float32Array(TOKENS);
  for (var r = 0; r < 8; r++) {
    var file = 0;
    for (var i = 0; i < rows[r].length; i++) {
      var ch = rows[r][i];
      if (ch >= '1' && ch <= '8') { file += Number(ch); continue; }
      // FEN lists rank 8 first. Flipped, rank 8 becomes rank 1 and the colours swap.
      var rank = black ? r : 7 - r;
      var p = black ? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      var k = PIECES.indexOf(p);
      if (k >= 0) t[(rank * 8 + file) * 12 + k] = 1;
      file++;
    }
  }
  return t;
}

/*
 * The policy for `fen` from the model's move logits (`logits`, this position's starting
 * at `offset`): [{ san, prob }], most likely first, without the long tail. Empty when
 * there is no legal move.
 */
export function policyFrom(fen, logits, offset) {
  var black = String(fen).trim().split(/\s+/)[1] === 'b';
  var moves = new Chess(fen).moves({ verbose: true });
  if (!moves.length) return [];
  var ls = moves.map(function (m) {
    var from = black ? flip(m.from) : m.from, to = black ? flip(m.to) : m.to;
    return logits[(offset || 0) + moveIndex(from, to, m.promotion)];
  });
  var max = Math.max.apply(null, ls);
  var e = ls.map(function (x) { return Math.exp(x - max); });
  var z = e.reduce(function (a, b) { return a + b; }, 0);
  return moves.map(function (m, i) { return { san: m.san, prob: e[i] / z }; })
    .filter(function (x) { return x.prob >= MIN_PROB; })
    .sort(function (a, b) { return b.prob - a.prob; });
}

/*
 * o = { run(tokens, elos, batch) -> Promise<Float32Array of batch * 4352 move logits>,
 *       maxBatch, defer(fn), memo }
 * Returns { policy(fen, elo) -> Promise<[{ san, prob }]>, counts() }.
 *
 * One run at a time. Requests made while one runs, or in the same turn, share the next:
 * on a resumed run the explorer answers from the cache, and Maia's positions come in
 * bursts. A batch of 32 took 12 ms a position against 35 for one alone.
 */
export function createMaia(o) {
  var maxBatch = o.maxBatch || 32;
  var defer = o.defer || setImmediate;
  var memoMax = o.memo || 20000;
  var memo = new Map();
  var inflight = new Map();
  var queue = [];
  var running = false;
  var c = { positions: 0, batches: 0 };

  function remember(key, moves) {
    memo.set(key, moves);
    if (memo.size > memoMax) memo.delete(memo.keys().next().value);
  }

  function pump() {
    if (running || !queue.length) return;
    running = true;
    var batch = queue.splice(0, maxBatch);
    var tokens = new Float32Array(batch.length * TOKENS);
    var elos = new Float32Array(batch.length);
    batch.forEach(function (q, i) {
      tokens.set(q.tokens, i * TOKENS);
      elos[i] = q.elo;
    });
    c.batches++;
    Promise.resolve().then(function () {
      return o.run(tokens, elos, batch.length);
    }).then(function (logits) {
      batch.forEach(function (q, i) {
        var moves;
        try { moves = policyFrom(q.fen, logits, i * MAIA_MOVES); } catch (e) { q.reject(e); return; }
        c.positions++;
        remember(q.key, moves);
        q.resolve(moves);
      });
    }, function (e) {
      batch.forEach(function (q) { q.reject(e); });
    }).then(function () {
      running = false;
      pump();
    });
  }

  function policy(fen, elo) {
    var key = fenKey(fen) + '|' + elo;
    if (memo.has(key)) return Promise.resolve(memo.get(key));
    if (inflight.has(key)) return inflight.get(key);
    var tokens;
    try { tokens = maiaTokens(fen); } catch (e) { return Promise.reject(e); }
    var p = new Promise(function (resolve, reject) {
      queue.push({ fen: fen, elo: elo, key: key, tokens: tokens, resolve: resolve, reject: reject });
    });
    inflight.set(key, p);
    function done() { inflight.delete(key); }
    p.then(done, done);
    defer(pump);
    return p;
  }

  return { policy: policy, counts: function () { return Object.assign({}, c); } };
}

/*
 * The model file, downloaded to `file` when it isn't there yet. Written under another
 * name and checked before it takes its own, so a download cut short is never used.
 * o = { url, sha256, fetch, log }
 */
export function ensureModel(file, o) {
  if (fs.existsSync(file)) return Promise.resolve(file);
  var url = o.url || MAIA_URL;
  var log = o.log || function () {};
  log('Downloading Maia 3 (' + Math.round(MAIA_BYTES / 1e6) + ' MB) from ' + url);
  return Promise.resolve((o.fetch || fetch)(url)).then(function (res) {
    if (!res.ok) throw new Error('Maia download failed: HTTP ' + res.status + ' from ' + url);
    return res.arrayBuffer();
  }).then(function (ab) {
    var buf = Buffer.from(ab);
    var sum = crypto.createHash('sha256').update(buf).digest('hex');
    var want = o.sha256 === undefined ? MAIA_SHA256 : o.sha256;
    if (want && sum !== want) {
      throw new Error('Maia download from ' + url + ' is not the expected file (sha256 ' + sum + ')');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var part = file + '.part';
    fs.writeFileSync(part, buf);
    fs.renameSync(part, file);
    log('Saved Maia 3 to ' + file);
    return file;
  });
}

/*
 * Loads onnxruntime-node and the model. o = { file, download, fetch, log }; `download`
 * false: a missing file is an error rather than fetched.
 * Resolves to createMaia()'s { policy, counts }.
 */
export function loadMaia(o) {
  var ort;
  return import('onnxruntime-node').catch(function (e) {
    var err = new Error('Maia needs onnxruntime-node. Install it once, from the project ' +
      'folder: npm install --prefix tools   (' + (e && e.code || e && e.message || e) + ')');
    err.setup = true;
    throw err;
  }).then(function (m) {
    ort = m.default || m;
    if (o.download === false && !fs.existsSync(o.file)) {
      var err = new Error('No Maia model at ' + o.file);
      err.setup = true;
      throw err;
    }
    return ensureModel(o.file, { fetch: o.fetch, log: o.log });
  }).then(function (file) {
    // The default level ('all') crashed the process in onnxruntime-node 1.30.0 on Linux
    // x64 while creating the session; 'extended' loads it and gives the same moves.
    return ort.InferenceSession.create(fs.readFileSync(file), { graphOptimizationLevel: 'extended' });
  }).then(function (session) {
    return createMaia({
      run: function (tokens, elos, batch) {
        return session.run({
          tokens: new ort.Tensor('float32', tokens, [batch, 64, 12]),
          elo_self: new ort.Tensor('float32', elos, [batch]),
          elo_oppo: new ort.Tensor('float32', Float32Array.from(elos), [batch])
        }).then(function (r) { return r.logits_move.data; });
      }
    });
  });
}
