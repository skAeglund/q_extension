#!/usr/bin/env node
/*
 * Measures the Lichess opening explorer's rate limit, for the Practical column's rate
 * limiter (src/pe/providers.js: the result of the first runs is the comment above
 * LICHESS_RATE).
 *
 *   set LICHESS_TOKEN=lip_...        (PowerShell: $env:LICHESS_TOKEN = 'lip_...')
 *
 *   node tools/lichess-rate.mjs [--rates 20,30,45,60,90,0] [--seconds 75] [--max 600]
 *     Steps through the rates (requests a minute; 0 = unpaced), each for `--seconds`, so a
 *     per-minute window is crossed at every step. Stops at the first 429.
 *
 *   node tools/lichess-rate.mjs --who
 *     Which Lichess account each token belongs to, and whether the two are the same token.
 *     Never prints a token.
 *
 *   node tools/lichess-rate.mjs --shared
 *     Is the limit per token or per IP? Uses up token A's allowance (unpaced, until a
 *     429), then at once asks with token B. B still answered means per token (or per
 *     account: --who tells which); B refused at once means per IP. Start from rest: nothing
 *     sent from this IP for two minutes.
 *
 * Tokens: A is --token-file <file> or LICHESS_TOKEN, B is --token-file-b <file> or
 * LICHESS_TOKEN_B. Always one request in flight, as Lichess asks; after a 429 it waits out
 * the minute Lichess asks for. Positions are ones repgen's cache already holds, and nothing
 * is written anywhere.
 *
 * Don't browse Qchess's Lichess panel, or run repgen or the extension's Practical column,
 * meanwhile: they may share the limit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { explorerUrl } from '../src/pe/providers.js';

var HERE = path.dirname(fileURLToPath(import.meta.url));
var CACHE = path.join(HERE, '..', 'repertoires', 'repgen-cache.jsonl');
var ACCOUNT_URL = 'https://lichess.org/api/account';
var FILTER = { speeds: ['blitz', 'rapid', 'classical'], ratings: [1600, 1800, 2000, 2200, 2500] };

function args() {
  var a = {};
  var v = process.argv.slice(2);
  for (var i = 0; i < v.length; i++) {
    var m = /^--([a-z-]+)$/.exec(v[i]);
    if (!m) throw new Error('Unknown argument: ' + v[i]);
    a[m[1]] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  }
  return a;
}

function tokenFrom(file, env) {
  if (file && file !== true) return fs.readFileSync(String(file), 'utf8').trim();
  return String(process.env[env] || '').trim();
}

function positions() {
  var out = [];
  if (fs.existsSync(CACHE)) {
    fs.readFileSync(CACHE, 'utf8').split('\n').forEach(function (l) {
      var m = /^\{"s":"explorer","k":"([^#"]+)#/.exec(l);
      if (m) out.push(m[1]);
    });
  }
  if (!out.length) out.push('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  // Shuffled, so a server-side cache can't make one step look faster than another.
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function pct(xs, p) {
  var s = xs.slice().sort(function (a, b) { return a - b; });
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
}

var fens = null;
var next = 0;
var headers = {};

// One explorer request with `token`: { status, ms }, or status 'network' on a failure.
async function ask(token) {
  if (!fens) fens = positions();
  var fen = fens[next++ % fens.length];
  var t = Date.now();
  try {
    var res = await fetch(explorerUrl(fen, FILTER), { headers: { Authorization: 'Bearer ' + token } });
    await res.arrayBuffer();
    res.headers.forEach(function (v, k) { if (/rate|retry|limit/i.test(k)) headers[k] = v; });
    if (res.status === 401) throw new Error('Lichess rejected a token (401).');
    return { status: res.status, ms: Date.now() - t };
  } catch (e) {
    if (e && /401/.test(e.message)) throw e;
    return { status: 'network', ms: Date.now() - t };
  }
}

function reportHeaders() {
  if (Object.keys(headers).length) console.log('Rate headers seen: ' + JSON.stringify(headers));
  else console.log('Lichess sent no rate headers.');
}

/* ------------------------------------------------------------------ rates */

async function rates(a, token) {
  var list = String(a.rates || '20,30,45,60,90,0').split(',').map(Number);
  var seconds = Number(a.seconds || 75);
  var max = Number(a.max || 600);
  var sent = 0;
  var started = Date.now();

  for (var si = 0; si < list.length && sent < max; si++) {
    var rate = list[si];
    var gap = rate > 0 ? 60000 / rate : 0;
    var t0 = Date.now();
    var lat = [];
    var codes = {};
    var hit = null;
    while (Date.now() - t0 < seconds * 1000 && sent < max) {
      var due = t0 + lat.length * gap;
      if (Date.now() < due) await sleep(due - Date.now());
      var r = await ask(token);
      sent++;
      lat.push(r.ms);
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.status === 429) {
        hit = { after: lat.length, secs: ((Date.now() - t0) / 1000).toFixed(0),
          total: sent, sinceStart: ((Date.now() - started) / 1000).toFixed(0) };
        break;
      }
    }
    var secs = (Date.now() - t0) / 1000;
    console.log((rate ? rate + '/min' : 'unpaced').padEnd(9) + ' ' + String(lat.length).padStart(4) +
      ' requests in ' + secs.toFixed(0).padStart(3) + ' s = ' + (lat.length * 60 / secs).toFixed(0).padStart(3) +
      '/min; latency median ' + pct(lat, 0.5) + ' ms, p90 ' + pct(lat, 0.9) + ' ms; ' + JSON.stringify(codes));
    if (hit) {
      console.log('429 after ' + hit.after + ' requests (' + hit.secs + ' s) at this rate; ' + hit.total +
        ' requests in ' + hit.sinceStart + ' s since the start. Waiting out the minute Lichess asks for.');
      await sleep(61000);
      break;
    }
  }
  reportHeaders();
}

/* -------------------------------------------------------------------- who */

// The account a token belongs to. /api/account needs no scope.
async function account(token) {
  var res = await fetch(ACCOUNT_URL, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) return { error: 'rejected (401)' };
  if (!res.ok) return { error: 'HTTP ' + res.status };
  var j = await res.json();
  return { username: j.username || j.id || '?' };
}

// A short fingerprint, so two tokens can be told apart without showing either.
function print(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

async function who(a, tokenA, tokenB) {
  var accA = await account(tokenA);
  console.log('Token A (fingerprint ' + print(tokenA) + '): ' + (accA.username || accA.error));
  if (!tokenB) {
    console.log('No token B: pass --token-file-b <file> or set LICHESS_TOKEN_B to compare.');
    return { a: accA };
  }
  var accB = await account(tokenB);
  console.log('Token B (fingerprint ' + print(tokenB) + '): ' + (accB.username || accB.error));
  var same = tokenA === tokenB;
  var sameAccount = accA.username && accA.username === accB.username;
  console.log(same ? 'A and B are the same token.'
    : sameAccount ? 'Different tokens of the same account.'
    : 'Different tokens of different accounts.');
  return { a: accA, b: accB, same: same, sameAccount: !!sameAccount };
}

/* ----------------------------------------------------------------- shared */

async function shared(a, tokenA, tokenB) {
  if (!tokenB) throw new Error('--shared needs token B: --token-file-b <file> or LICHESS_TOKEN_B.');
  var w = await who(a, tokenA, tokenB);
  if (w.same) throw new Error('A and B are the same token, so this would tell nothing.');
  if (w.a.error || w.b.error) throw new Error('Both tokens must work.');

  // Use up A's allowance. From rest that is about 23 requests.
  var t0 = Date.now();
  var aOk = 0;
  var aHit = false;
  for (var i = 0; i < 40; i++) {
    var r = await ask(tokenA);
    if (r.status === 429) { aHit = true; break; }
    if (r.status === 200) aOk++;
  }
  console.log('Token A: ' + aOk + ' answered, then ' + (aHit ? 'a 429' : 'no 429 in 40 requests') +
    ', after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s.');
  if (!aHit) {
    console.log('A was never refused, so this tells nothing. Was the limit raised?');
    reportHeaders();
    return;
  }

  // At once, the same with B, stopping at its first 429.
  var t1 = Date.now();
  var bOk = 0;
  var bHit = false;
  for (var k = 0; k < 12; k++) {
    var rb = await ask(tokenB);
    if (rb.status === 429) { bHit = true; break; }
    if (rb.status === 200) bOk++;
  }
  console.log('Token B, straight after: ' + bOk + ' answered' + (bHit ? ', then a 429' : '') +
    ', in ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s.');

  if (bOk === 0 && bHit) {
    console.log('=> Shared: B was refused at once. The limit counts per IP' +
      (w.sameAccount ? ' or per account (same account here: run again with another account\'s token to tell)' : '') + '.');
  } else if (bOk >= 5) {
    console.log('=> Separate: B had its own allowance. The limit counts per ' +
      (w.sameAccount ? 'token' : 'token or per account (different accounts here)') + ', not per IP.');
  } else {
    console.log('=> Unclear: B got ' + bOk + ' through. Rest two minutes and run it again.');
  }
  reportHeaders();
  console.log('Waiting out the minute Lichess asks for.');
  await sleep(61000);
}

async function main() {
  var a = args();
  var tokenA = tokenFrom(a['token-file'], 'LICHESS_TOKEN');
  var tokenB = tokenFrom(a['token-file-b'], 'LICHESS_TOKEN_B');
  if (!tokenA) throw new Error('No Lichess token: set LICHESS_TOKEN or pass --token-file.');
  if (a.who) return who(a, tokenA, tokenB);
  if (a.shared) return shared(a, tokenA, tokenB);
  return rates(a, tokenA);
}

main().catch(function (e) {
  console.error('lichess-rate: ' + (e && e.message || e));
  process.exit(1);
});
