#!/usr/bin/env node
/*
 * cdbexplore - deepens ChessDB's analysis where a repertoire relies on it.
 *
 *   node tools/cdbexplore.mjs sicilian.pgn --list          # which positions, no exploring
 *   node tools/cdbexplore.mjs sicilian.pgn --hours 3
 *
 * ChessDB's eval of a position far into a line is usually one search of about depth 22
 * with a few plies of stored line behind it. This asks ChessDB about every position of the
 * PGN (one request each), picks the line ends and the positions of mine where another move
 * is close to the PGN's, keeps those whose stored line is short, and builds ChessDB's tree
 * below each (repgen/explore.mjs, after vondele/cdbexplore). Positions ChessDB doesn't know
 * are queued and waited for, which is where most of the time goes.
 *
 * Works on any PGN (--side for one that isn't repgen's). Next to a repgen run
 * (sicilian.json) it orders the positions by how often they are reached, and
 * `node tools/repgen.mjs --out sicilian --check` afterwards picks up the new evals.
 * Without a run, the opponent moves' share comments ({22%}) give that order instead.
 *
 * A bare file name that isn't in the current directory is looked up in repertoires/.
 * Writes <name>.explore.log and <name>.explore.json (what was explored when; a position
 * explored in the last --again-after days, 7 by default, is skipped).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parsePgn } from './repgen/pgntree.mjs';
import { sideOfHeaders } from './repgen/clean.mjs';
import { positions, candidates, pickTargets, createExplorer, sanOf, EXPLORE_DEFAULTS } from './repgen/explore.mjs';
import { createLimiter, CHESSDB_URL } from '../src/pe/providers.js';
import { fenKey, sideToMove } from '../src/pe/search.js';
import { inPath } from './repgen/paths.mjs';

function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

function parseArgs(argv) {
  var a = { _: [] };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '-h') { a.help = true; continue; }
    var m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(argv[i]);
    if (!m) { a._.push(argv[i]); continue; }
    var k = camel(m[1]);
    if (m[2] != null) a[k] = m[2];
    else if (i + 1 < argv.length && !/^--[a-z]/.test(argv[i + 1])) a[k] = argv[++i];
    else a[k] = true;
  }
  return a;
}

var OPTS = ['maxEval', 'shortLine', 'close', 'evalDecay', 'minDepth', 'maxDepth', 'stable', 'settle'];

function usage() {
  return [
    'Usage: node tools/cdbexplore.mjs <file.pgn> [--side white|black] [--run <name>] [options]',
    '',
    'Run:     --list (only show the positions), --hours <n>, --minutes <n per position, 20>,',
    '         --rate <ChessDB requests/min, 60>, --concurrency <in flight, 3>,',
    '         --again (explore positions done recently too), --again-after <days, 7>',
    'Pick:    --leaves-only, ' + ['maxEval', 'shortLine', 'close'].map(opt).join(', '),
    'Search:  ' + ['evalDecay', 'minDepth', 'maxDepth', 'stable', 'settle'].map(opt).join(', '),
    '',
    'Scores are in centipawns (ChessDB\'s); the log shows them from White\'s side.'
  ].join('\n');
  function opt(k) {
    return '--' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }) + ' ' + EXPLORE_DEFAULTS[k];
  }
}

function num(k, v) {
  var n = Number(v);
  if (!isFinite(n) || n < 0) throw new Error('--' + k + ' needs a number, got ' + v);
  return n;
}

function mmss(ms) {
  var s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

// White's point of view, in pawns.
function white(score, fen) {
  if (score == null) return '?';
  var s = sideToMove(fen) === 'w' ? score : -score;
  if (Math.abs(s) >= 10000) return s > 0 ? '+M' : '-M';
  return (s >= 0 ? '+' : '') + (s / 100).toFixed(2);
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) { console.log(usage()); return Promise.resolve(); }

  var input = inPath(String(args._[0]));
  var base = input.replace(/\.pgn$/i, '').replace(/\.clean$/i, '');
  var runPath = args.run ? inPath(String(args.run).replace(/\.json$/i, '') + '.json') : base + '.json';
  var state = fs.existsSync(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : null;
  if (args.run && !state) throw new Error('No repgen run at ' + runPath);
  var outPath = base + '.explore.json', logPath = base + '.explore.log';

  function log(s) {
    var line = new Date().toISOString().slice(11, 19) + ' ' + s;
    console.log(line);
    try { fs.appendFileSync(logPath, line + '\n'); } catch (e) { /* the console has it */ }
  }

  var games = parsePgn(fs.readFileSync(input, 'utf8'));
  if (!games.length) throw new Error('No game found in ' + input);
  var side = args.side ? { w: 'w', white: 'w', b: 'b', black: 'b' }[String(args.side).toLowerCase()]
    : sideOfHeaders(games[0].headers) || (state && state.side);
  if (!side) throw new Error('Which side is the repertoire for? Pass --side white or --side black.');

  var opts = { leavesOnly: !!args.leavesOnly };
  OPTS.forEach(function (k) { if (args[k] != null) opts[k] = num(k, args[k]); });
  opts = Object.assign({}, EXPLORE_DEFAULTS, opts);

  var done = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : { targets: {} };
  function save() {
    var tmp = outPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(done, null, 1));
    fs.renameSync(tmp, outPath);
  }

  // ChessDB, spaced out and a few requests in flight at most.
  var gap = 60000 / (args.rate ? num('rate', args.rate) : 60);
  var nextAt = 0;
  var lane = createLimiter(args.concurrency ? Math.max(1, num('concurrency', args.concurrency)) : 3);
  var requests = 0;
  function cdb(action, fen) {
    return lane(function () {
      var t = Date.now(), at = Math.max(t, nextAt);
      nextAt = at + gap;
      return new Promise(function (r) { setTimeout(r, at - t); }).then(function () {
        requests++;
        var url = CHESSDB_URL + '?action=' + action + '&json=1&board=' + encodeURIComponent(fen);
        return fetch(url, { signal: AbortSignal.timeout(30000) });
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    });
  }

  // Positions in all the games, once each.
  var list = [], keys = new Set();
  games.forEach(function (g) {
    positions(g, side, state).forEach(function (p) {
      if (!keys.has(p.key)) { keys.add(p.key); list.push(p); }
    });
  });

  var rootFen = games[0].root.fen;
  function lineOf(p) {
    var parts = rootFen.split(/\s+/);
    var h0 = (Math.max(1, Number(parts[5]) || 1) - 1) * 2 + (parts[1] === 'b' ? 1 : 0);
    var moves = p.path.map(function (san, i) {
      var h = h0 + i, n = Math.floor(h / 2) + 1;
      return (h % 2 === 0 ? n + '.' : i === 0 ? n + '...' : '') + san;
    }).join(' ');
    return (p.reach != null ? '[' + (p.reach * 100).toFixed(2) + '%] ' : '') + (moves || '(start)');
  }

  var started = Date.now();
  var deadline = args.hours ? started + num('hours', args.hours) * 3600000 : Infinity;
  var perTarget = (args.minutes ? num('minutes', args.minutes) : 20) * 60000;
  var againAfter = (args.againAfter != null ? num('againAfter', args.againAfter) : 7) * 86400000;

  process.on('SIGINT', function () {
    try { save(); } catch (e) { /* best effort */ }
    log('Stopped after ' + requests + ' ChessDB requests in ' + mmss(Date.now() - started) +
      '. Run the same command to carry on.');
    process.exit(130);
  });

  log('cdbexplore: ' + path.basename(input) + ', ' + list.length + ' positions, ' +
    (side === 'w' ? 'White' : 'Black') + "'s repertoire" + (state ? ', reach from ' + path.basename(runPath) : '') +
    '. Asking ChessDB about each.');

  function each(items, fn) {
    return Promise.all(items.map(function (x, i) {
      return fn(x).then(function (v) {
        if ((i + 1) % 50 === 0) log('  ' + (i + 1) + ' of ' + items.length);
        return v;
      }, function () { return null; });
    }));
  }

  var answers = new Map(), pvs = new Map();
  return each(list, function (p) {
    return cdb('queryall', p.fen).then(function (j) { answers.set(p.key, j); });
  }).then(function () {
    var cands = candidates(list, answers, opts);
    return each(cands, function (c) {
      return cdb('querypv', c.fen).then(function (j) { pvs.set(c.key, j); });
    }).then(function () { return pickTargets(cands, pvs, opts); });
  }).then(function (targets) {
    var unknown = list.filter(function (p) {
      var a = answers.get(p.key);
      return !a || a.status !== 'ok';
    }).length;
    var now = Date.now();
    var fresh = targets.filter(function (t) {
      var d = done.targets[t.key];
      return args.again || !d || now - Date.parse(d.at) >= againAfter;
    });
    log('Survey: ' + targets.length + ' positions to explore (' +
      targets.filter(function (t) { return t.reason === 'line end'; }).length + ' line ends, ' +
      targets.filter(function (t) { return t.reason === 'decision'; }).length + ' decisions)' +
      (fresh.length < targets.length ? ', ' + (targets.length - fresh.length) + ' of them explored recently' : '') +
      (unknown ? '; ChessDB has no eval for ' + unknown + ' position' + (unknown === 1 ? '' : 's') : '') +
      '; ' + requests + ' requests in ' + mmss(Date.now() - started) + '. Scores from White\'s side.');
    targets.forEach(function (t) {
      log('  ' + lineOf(t) + ' (' + t.reason + '): ' + describe(t) + ', stored line ' + t.line +
        (fresh.indexOf(t) < 0 ? ' [explored ' + done.targets[t.key].at.slice(0, 10) + ']' : ''));
    });
    if (args.list) return null;

    var ex = createExplorer({
      queryall: function (fen) { return cdb('queryall', fen); },
      queue: function (fen) { return cdb('queue', fen); },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      now: Date.now
    }, opts);

    var results = [];
    function one(i) {
      if (i >= fresh.length) return Promise.resolve();
      if (Date.now() >= deadline) {
        log('Time is up with ' + (fresh.length - i) + ' position' + (fresh.length - i === 1 ? '' : 's') + ' left.');
        return Promise.resolve();
      }
      var t = fresh[i], t0 = Date.now();
      log('Exploring ' + (i + 1) + '/' + fresh.length + ': ' + lineOf(t) + ' (' + t.reason + ')');
      return ex.explore(t.fen, {
        above: t.above,
        deadline: Math.min(deadline, t0 + perTarget),
        onDepth: function (h) {
          log('  depth ' + h.depth + ': ' + sanOf(t.fen, h.best) + ' ' + white(h.score, t.fen));
        }
      }).then(function (r) {
        return Promise.all([cdb('queryall', t.fen), cdb('querypv', t.fen)]).then(function (a) {
          var after = candidates([t], new Map([[t.key, a[0]]]), Object.assign({}, opts, { maxEval: Infinity, close: Infinity }))[0];
          var line = a[1] && a[1].pv ? a[1].pv.length : 0;
          var rec = {
            fen: t.fen, line: lineOf(t), reason: t.reason, reach: t.reach,
            before: { best: t.best, mine: t.mine, rival: t.rival, line: t.line },
            after: after ? { best: after.best, mine: after.mine, rival: after.rival, line: line } : null,
            depths: r.depths.map(function (h) { return { depth: h.depth, best: sanOf(t.fen, h.best), score: h.score }; }),
            stopped: r.stopped, requests: r.requests, queued: r.queued, ms: Date.now() - t0,
            at: new Date().toISOString()
          };
          done.targets[t.key] = rec;
          save();
          results.push(rec);
          log('  ' + r.stopped + ' after ' + mmss(rec.ms) + ', ' + r.requests + ' requests, ' + r.queued +
            ' queued. ChessDB now: ' + (after ? describe(after) : 'no eval') + ' (was ' + describe(t) +
            '), stored line ' + t.line + ' -> ' + line);
          return one(i + 1);
        });
      });
    }
    return one(0).then(function () {
      var changed = results.filter(function (r) {
        if (!r.after) return false;
        if (r.after.best.san !== r.before.best.san) return true;
        if (r.reason === 'decision' && r.after.mine && r.before.mine &&
            Math.sign(r.after.mine.score - r.after.rival.score) !== Math.sign(r.before.mine.score - r.before.rival.score)) return true;
        return Math.abs(r.after.best.score - r.before.best.score) >= opts.settle;
      });
      log('Done: ' + results.length + ' explored, ' + changed.length + ' changed; ' + requests +
        ' ChessDB requests in ' + mmss(Date.now() - started) + '.');
      changed.forEach(function (r) {
        log('  ' + r.line + ': ' + describe(r.before, r.fen) + ' -> ' + describe(r.after, r.fen));
      });
      if (state) {
        log('To bring the run up to date: node tools/repgen.mjs --out ' +
          path.relative(process.cwd(), runPath.replace(/\.json$/i, '')) + ' --check');
      }
    });
  });

  // "best Nf6 +0.21; mine e4 +0.10 vs d4 +0.25" for a candidate or a record.
  function describe(c, fen) {
    fen = fen || c.fen;
    var s = 'best ' + c.best.san + ' ' + white(c.best.score, fen);
    if (c.mine) s += '; mine ' + c.mine.san + ' ' + white(c.mine.score, fen) + ' vs ' + c.rival.san + ' ' + white(c.rival.score, fen);
    return s;
  }
}

main().then(function () { process.exit(0); }, function (e) {
  console.error('cdbexplore: ' + ((e && e.message) || e));
  process.exit(1);
});
