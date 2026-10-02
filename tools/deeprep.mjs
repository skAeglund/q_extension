#!/usr/bin/env node
/*
 * deeprep - repertoires from deep win rates in the local explorer index (explorerdb).
 *
 *   node tools/deeprep.mjs search lichess --moves "1.d4 c5 2.dxc5" --side black --out benoni
 *
 * scores each of my moves by what the games went on to do when I keep choosing my best
 * scoring move and the opponent plays as people do (deeprep/search.mjs), down to --plies
 * from the position, stopping early where fewer than --min-games games go on. Writes
 * repertoires/<out>.pgn (the chosen moves, the replies played often enough to prepare for,
 * and alternatives in comments) and <out>.json (the same tree, with every number).
 *
 *   node tools/deeprep.mjs moves lichess --moves "1.d4 c5 2.dxc5"
 *   node tools/deeprep.mjs browse lichess --moves "1.d4 c5 2.dxc5" --side black
 *
 * `moves` prints one position's table: my candidates by deep score, with SE, a lower
 * bound, the raw score and games. `browse` does the same position by position, typing
 * moves to go on, so you can choose at each move yourself.
 *
 *   node tools/deeprep.mjs bench lichess
 *
 * times lookups in the index: run it once on a new index or disk to know what a search costs.
 *
 * No network: ChessDB is not asked (yet). Bare index names are looked up in explorer/, as
 * explorerdb does.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { Chess } from '../src/vendor/chess.js';
import { openFenced } from './explorerdb/fence.mjs';
import { openIndex } from './explorerdb/store.mjs';
import { keyOf } from './explorerdb/games.mjs';
import { createSearch, DEFAULTS } from './deeprep/search.mjs';
import { toPgn, candidateLines } from './deeprep/pgn.mjs';
import { inPath, outPath, EXPLORER } from './repgen/paths.mjs';

var USAGE = [
  'Usage:',
  '  node tools/deeprep.mjs search <index> (--moves "1.e4 c5" | --fen "<fen>") --out <name> [options]',
  '  node tools/deeprep.mjs moves  <index> (--moves ... | --fen ...) [options]',
  '  node tools/deeprep.mjs browse <index> (--moves ... | --fen ...) [options]',
  '  node tools/deeprep.mjs bench  <index> [--samples 2000]',
  '',
  'Options:',
  '  --side white|black   the repertoire\'s side (default: the side to move)',
  '  --plies ' + DEFAULTS.plies + '          horizon, in plies from the position',
  '  --min-games ' + DEFAULTS.minGames + '      a position or move with fewer games is a leaf',
  '  --z ' + DEFAULTS.z + '                lower bound = deep score - z x SE',
  '  --my-moves N         consider only my N most played moves (default: all with --min-games)',
  '  --max-lookups N      give up past this many lookups (default 20,000,000)',
  'search only:',
  '  --keep 1             my moves expanded at each of my moves (best scores first)',
  '  --no-safe            don\'t also expand the move with the best lower bound',
  '  --show 3             alternatives listed in the comment',
  '  --reply-share 5      prepare for replies played at least this % of the time...',
  '  --min-reach 1        ...on lines reached at least this % of the time',
  '  --coverage 90        instead: the most played replies until they cover this % of the',
  '                       games (then --reply-share and --min-reach default to 0)...',
  '  --coverage-step 10   ...this many points less at each later opponent decision...',
  '  --single-below 50    ...and under this, only the most played reply'
].join('\n');

function indexPath(name) {
  if (!/\.xdb$/i.test(name)) name += '.xdb';
  return inPath(name, EXPLORER);
}

function num(s, what) {
  var v = Number(s);
  if (!(v >= 0) || !isFinite(v)) throw new Error(what + ' is a number >= 0');
  return v;
}

function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

function parse(argv, extra) {
  var o = { name: null, fen: null, moves: null, search: {}, tree: {}, out: null, samples: 2000 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--fen') o.fen = argv[++i];
    else if (a === '--moves') o.moves = argv[++i];
    else if (a === '--side') {
      var s = argv[++i];
      if (s !== 'white' && s !== 'black') throw new Error('--side is white or black');
      o.search.side = s[0];
    }
    else if (a === '--plies') o.search.plies = num(argv[++i], '--plies');
    else if (a === '--min-games') o.search.minGames = Math.max(1, num(argv[++i], '--min-games'));
    else if (a === '--z') o.search.z = num(argv[++i], '--z');
    else if (a === '--my-moves') o.search.myMoves = num(argv[++i], '--my-moves');
    else if (a === '--max-lookups') o.search.maxLookups = num(argv[++i], '--max-lookups');
    else if (a === '--keep' && extra) o.tree.keep = Math.max(1, num(argv[++i], '--keep'));
    else if (a === '--no-safe' && extra) o.tree.keepSafe = false;
    else if (a === '--show' && extra) o.tree.show = num(argv[++i], '--show');
    else if (a === '--reply-share' && extra) o.tree.replyShare = num(argv[++i], '--reply-share') / 100;
    else if (a === '--min-reach' && extra) o.tree.minReach = num(argv[++i], '--min-reach') / 100;
    else if (a === '--coverage' && extra) o.tree.coverage = num(argv[++i], '--coverage') / 100;
    else if (a === '--coverage-step' && extra) o.tree.coverageStep = num(argv[++i], '--coverage-step') / 100;
    else if (a === '--single-below' && extra) o.tree.singleBelow = num(argv[++i], '--single-below') / 100;
    else if (a === '--out' && extra) o.out = argv[++i];
    else if (a === '--samples') o.samples = num(argv[++i], '--samples');
    else if (!o.name && !/^--/.test(a)) o.name = a;
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!o.name) throw new Error('Which index?\n' + USAGE);
  if (o.tree.coverage == null && (o.tree.coverageStep != null || o.tree.singleBelow != null)) {
    throw new Error('--coverage-step and --single-below need --coverage');
  }
  if (o.tree.coverage != null && !(o.tree.coverage > 0 && o.tree.coverage <= 1)) {
    throw new Error('--coverage is a % above 0, at most 100');
  }
  o.prefix = null;
  if (o.moves != null) {
    var c = new Chess();
    o.prefix = o.moves.replace(/\d+\.+/g, ' ').split(/\s+/).filter(Boolean).map(function (m) {
      try { return c.move(m).san; } catch (e) { throw new Error('Illegal move "' + m + '"'); }
    });
    o.fen = c.fen();
  }
  if (!o.fen) o.fen = new Chess().fen();
  return o;
}

function open(name) {
  var file = indexPath(name);
  if (!fs.existsSync(file)) throw new Error('No index at ' + file);
  var t = Date.now();
  var db = openFenced(file, {
    log: function (s) { console.error(s); },
    progress: function (f) { console.error('  ' + Math.round(100 * f) + '%'); }
  });
  var ms = Date.now() - t;
  if (ms > 2000) console.error('Blocks found in ' + (ms / 1000).toFixed(0) + ' s (saved for next time).');
  return db;
}

function progress(p) {
  console.error('  ' + fmt(p.lookups) + ' lookups, ' + fmt(p.lookups / (p.ms / 1000)) + '/s');
}

function summary(s, db) {
  var st = db.stats();
  return fmt(s.lookups) + ' lookups (' + fmt(s.positions) + ' positions), ' + fmt(st.reads) + ' block reads, ' +
    (s.ms / 1000).toFixed(1) + ' s' + (s.ms > 0 ? ', ' + fmt(s.lookups / (s.ms / 1000)) + '/s' : '');
}

function describe(o, side) {
  var x = Object.assign({}, DEFAULTS, o.search);
  return 'for ' + (side === 'w' ? 'White' : 'Black') + ', ' + x.plies + ' plies, min ' + x.minGames + ' games' +
    (x.myMoves ? ', my ' + x.myMoves + ' most played moves' : '');
}

function coverageNote(t) {
  if (t.coverage == null) return '';
  var p = function (x) { return Math.round(100 * x * 10) / 10; };
  return ', replies to ' + p(t.coverage) + '% less ' + p(t.coverageStep != null ? t.coverageStep : 0.1) +
    ' a move, top only under ' + p(t.singleBelow != null ? t.singleBelow : 0.5) + '%';
}

function cmdSearch(argv) {
  var o = parse(argv, true);
  if (!o.out) throw new Error('--out <name> is missing');
  var db = open(o.name);
  try {
    var s = createSearch(db, o.fen, Object.assign({ progress: progress }, o.search));
    console.log('Searching ' + describe(o, s.side));
    if (!s.value().n) throw new Error('That position is not in the index.');
    var tree = s.tree(o.tree);
    var root = s.candidates();
    candidateLines(root).forEach(function (l) { console.log('  ' + l); });
    console.log(summary(s.stats(), db));
    var base = outPath(o.out.replace(/\.(pgn|json)$/i, ''));
    var meta = { index: db.meta.source + '@' + db.meta.created, filter: db.meta.filter, fen: o.fen,
      moves: o.prefix, side: s.side, search: s.options, tree: o.tree, stats: s.stats() };
    delete meta.search.progress;
    fs.writeFileSync(base + '.json', JSON.stringify({ meta: meta, tree: tree }, null, 1));
    fs.writeFileSync(base + '.pgn', toPgn(tree, {
      prefix: o.prefix, fen: o.prefix ? null : o.fen,
      headers: { Event: 'deeprep ' + describe(o, s.side) + coverageNote(o.tree),
        Annotator: 'deeprep (' + db.meta.source + ')' },
      rootComment: 'deep ' + (100 * tree.s).toFixed(1) + '% for ' + (s.side === 'w' ? 'White' : 'Black') +
        ', ' + fmt(tree.games) + ' games'
    }));
    console.log('Wrote ' + base + '.pgn and .json');
  } finally {
    db.close();
  }
  return 0;
}

function cmdMoves(argv) {
  var o = parse(argv, false);
  var db = open(o.name);
  try {
    var s = createSearch(db, o.fen, Object.assign({ progress: progress }, o.search));
    console.log((o.prefix && o.prefix.length ? o.prefix.join(' ') : o.fen) + ' (' + describe(o, s.side) + ')');
    candidateLines(s.candidates()).forEach(function (l) { console.log('  ' + l); });
    console.log(summary(s.stats(), db));
  } finally {
    db.close();
  }
  return 0;
}

async function cmdBrowse(argv) {
  var o = parse(argv, false);
  var db = open(o.name);
  var memo = new Map();
  var side = o.search.side || new Chess(o.fen).turn();
  var path = [];                              // SANs played from the start position
  var c = new Chess(o.fen);
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  var ask = function (q) { return new Promise(function (r) { rl.question(q, r); }); };
  console.log('Type a move (or its number) to play it, b to go back, q to quit. ' + describe(o, side) + '.');
  try {
    for (;;) {
      var s = createSearch(db, c.fen(), Object.assign({ memo: memo, progress: progress }, o.search, { side: side }));
      var op = s.candidates();
      console.log('\n' + ((o.prefix || []).concat(path).join(' ') || c.fen()) + (op.mine ? '   (your move)' : '   (their move)'));
      candidateLines(op).forEach(function (l, i) { console.log((i ? String(i).padStart(3) + ' ' : '    ') + l); });
      console.log('  ' + summary(s.stats(), db));
      var a = String(await ask('> ')).trim();
      if (a === 'q' || a === 'quit') break;
      if (a === 'b' || a === 'back') {
        if (path.length) { path.pop(); c.undo(); } else console.log('At the start.');
        continue;
      }
      var san = /^\d+$/.test(a) && op.list[Number(a) - 1] ? op.list[Number(a) - 1].san : a;
      try { path.push(c.move(san).san); } catch (e) { console.log('Not a legal move: ' + a); }
    }
  } finally {
    rl.close();
    db.close();
  }
  return 0;
}

// Positions to look up: random walks from the start, each move chosen by how often it's
// played, so the sample looks like a search's (popular positions, then rarer ones).
function samplePositions(db, n) {
  var keys = [];
  var rnd = Math.random;
  while (keys.length < n) {
    var c = new Chess();
    var depth = 4 + Math.floor(rnd() * 24);
    for (var p = 0; p < depth; p++) {
      var recs = db.records(keyOf(c.fen())).filter(function (r) { return r.code !== 0 && r.code !== 65; });
      if (!recs.length) break;
      var tot = recs.reduce(function (t, r) { return t + r.white + r.draws + r.black; }, 0);
      var x = rnd() * tot, pick = recs[0];
      for (var i = 0; i < recs.length; i++) {
        x -= recs[i].white + recs[i].draws + recs[i].black;
        if (x < 0) { pick = recs[i]; break; }
      }
      var sq = function (k) { return 'abcdefgh'[k & 7] + (1 + (k >> 3)); };
      var promo = ['', 'n', 'b', 'r', 'q'][pick.code >> 12] || undefined;
      try { c.move({ from: sq(pick.code & 63), to: sq((pick.code >> 6) & 63), promotion: promo }); } catch (e) { break; }
      keys.push(keyOf(c.fen()));
      if (keys.length >= n) break;
    }
  }
  return keys;
}

function cmdBench(argv) {
  var o = parse(argv, false);
  var file = indexPath(o.name);
  var t0 = Date.now();
  var db = open(o.name);
  var tOpen = Date.now() - t0;
  try {
    console.log(db.meta.source + ': ' + fmt(db.count) + ' records (' + (fs.statSync(file).size / 1e9).toFixed(1) +
      ' GB), ' + fmt(db.fences) + ' blocks of ' + db.block + '; opened in ' + (tOpen / 1000).toFixed(1) + ' s');
    var keys = samplePositions(db, o.samples);
    var time = function (label, fn) {
      var t = process.hrtime.bigint();
      var found = 0;
      keys.forEach(function (k) { if (fn(k).length) found++; });
      var us = Number(process.hrtime.bigint() - t) / 1000 / keys.length;
      console.log(label.padEnd(36) + us.toFixed(1).padStart(8) + ' µs a lookup (' + found + '/' + keys.length + ' found)');
      return us;
    };
    // The walk itself read these positions once, so they may be cached: shuffle, and read
    // other ones first.
    keys.sort(function () { return Math.random() - 0.5; });
    time('fenced, first pass', db.records);
    var us = time('fenced, again (cached by the OS)', db.records);
    var plain = openIndex(file);
    try { time('plain binary search (explorerdb)', plain.records); } finally { plain.close(); }
    console.log('A search of 1,000,000 lookups would take about ' + Math.round(us) + '-' +
      Math.round(us * 3) + ' s at these speeds.');
  } finally {
    db.close();
  }
  return 0;
}

async function main(argv) {
  var cmd = argv[0];
  if (cmd === 'search') return cmdSearch(argv.slice(1));
  if (cmd === 'moves') return cmdMoves(argv.slice(1));
  if (cmd === 'browse') return cmdBrowse(argv.slice(1));
  if (cmd === 'bench') return cmdBench(argv.slice(1));
  console.log(USAGE);
  return cmd === '--help' || cmd === '-h' ? 0 : 1;
}

main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) {
  console.error('deeprep: ' + (e && e.message || e));
  process.exitCode = 1;
});
