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
 *   node tools/deeprep.mjs build lichess --moves "1.d4 c5 2.dxc5 e5" --side black --out e5 --holdout held
 *
 * builds a repertoire by the user's four criteria (deeprep/build.mjs): the deep score, no
 * reliance on traps, the practical evaluation (both from ChessDB), and few lines to learn.
 * Writes <out>.pgn, <out>.json and <out>.review.md, the decisions worth a second look, which
 * a decisions file (--decisions) answers.
 *
 *   node tools/deeprep.mjs eval held e5
 *
 * scores a repertoire PGN (any) as a fixed policy against an index's games: on a holdout
 * (other months), without the luck of the choices (deeprep/evaluate.mjs).
 *
 *   node tools/deeprep.mjs fit lichess
 *   node tools/deeprep.mjs slice lichess --moves "1.d4 c5 2.dxc5 e5" --out e5_slice
 *   node tools/deeprep.mjs bench lichess
 *
 * `fit` measures the shrinkage prior for an index; `slice` writes the part of an index
 * under a line as a small index (deeprep/slice.mjs), for a Claude session elsewhere; `bench`
 * times lookups: run it once on a new index or disk to know what a search costs.
 *
 * Only `build` uses the network (ChessDB, cached in repertoires/repgen-cache.jsonl). Bare
 * index names are looked up in explorer/, as explorerdb does.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Chess } from '../src/vendor/chess.js';
import { openFenced } from './explorerdb/fence.mjs';
import { openIndex } from './explorerdb/store.mjs';
import { keyOf } from './explorerdb/games.mjs';
import { createSearch, fitPrior, DEFAULTS } from './deeprep/search.mjs';
import { toPgn, candidateLines, lineText, dumpsOf } from './deeprep/pgn.mjs';
import { repertoireFromPgn, evaluateRepertoire } from './deeprep/evaluate.mjs';
import { createBuilder, repertoireMoves, toTree, positionOf, BUILD_DEFAULTS } from './deeprep/build.mjs';
import { moveNote, rootNote, parseDecisions, reviewMarkdown, lineOf } from './deeprep/report.mjs';
import { createProviders } from '../src/pe/providers.js';
import { createFileCache } from './repgen/filecache.mjs';
import { writeSlice } from './deeprep/slice.mjs';
import { inPath, outPath, EXPLORER } from './repgen/paths.mjs';

var USAGE = [
  'Usage:',
  '  node tools/deeprep.mjs search <index> (--moves "1.e4 c5" | --fen "<fen>") --out <name> [options]',
  '  node tools/deeprep.mjs moves  <index> (--moves ... | --fen ...) [options]',
  '  node tools/deeprep.mjs browse <index> (--moves ... | --fen ...) [options]',
  '  node tools/deeprep.mjs build  <index> (--moves ... | --fen ...) --out <name> [--side ...] [--holdout <index>]',
  '                                [--decisions <file>] [--no-chessdb] [build options, see the README]',
  '  node tools/deeprep.mjs eval   <index> <pgn> [--side white|black] [--moves ... | --fen ...] [--json <file>]',
  '  node tools/deeprep.mjs slice  <index> (--moves ... | --fen ...) --out <name> [--plies 42] [--min-games 50]',
  '  node tools/deeprep.mjs fit    <index> [--moves ... | --fen ...] [--side white|black] [--samples 2000]',
  '  node tools/deeprep.mjs bench  <index> [--samples 2000]',
  '',
  'Options:',
  '  --side white|black   the repertoire\'s side (default: the side to move)',
  '  --plies ' + DEFAULTS.plies + '          horizon, in plies from the position',
  '  --min-games ' + DEFAULTS.minGames + '      a position or move with fewer games is a leaf',
  '  --z ' + DEFAULTS.z + '                lower bound = deep score - z x SE',
  '  --my-moves N         consider only my N most played moves (default: all with --min-games)',
  '  --prior ' + DEFAULTS.prior + '          shrinkage: games\' worth of the position\'s own score in each',
  '                       of my moves\' values (0: none; `fit` measures one for an index)',
  '  --risk ' + DEFAULTS.risk + '          risk aversion at their moves, per win% point (0: plain mean)',
  '  --max-lookups N      give up past this many lookups (default 20,000,000)',
  'build: its own --plies (' + BUILD_DEFAULTS.plies + '), and --' + Object.keys(BUILD_DEFAULTS).filter(function (k) {
    return k !== 'plies' && k !== 'minGames' && k !== 'prior' && k !== 'risk';
  }).map(function (k) { return k.replace(/[A-Z]/g, function (ch) { return '-' + ch.toLowerCase(); }) + ' ' + BUILD_DEFAULTS[k]; })
    .join(', --'),
  '  --chessdb-rate 60 (per minute), --cache <file> (default repertoires/repgen-cache.jsonl)',
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

function parse(argv, extra, positional) {
  var o = { name: null, fen: null, moves: null, search: {}, tree: {}, out: null, samples: 2000,
    positional: !!positional, file: null, json: null };
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
    else if (a === '--prior') o.search.prior = num(argv[++i], '--prior');
    else if (a === '--risk') o.search.risk = num(argv[++i], '--risk');
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
    else if (a === '--json') o.json = argv[++i];
    else if (!o.name && !/^--/.test(a)) o.name = a;
    else if (o.positional && !o.file && !/^--/.test(a)) o.file = a;
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
  if (!o.fen && !positional) o.fen = new Chess().fen();
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
    (x.myMoves ? ', my ' + x.myMoves + ' most played moves' : '') +
    ', prior ' + fmt(x.prior) + ', risk ' + x.risk;
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
    var meta = { index: db.meta.source + '@' + db.meta.created, dumps: dumpsOf(db.meta), filter: db.meta.filter, fen: o.fen,
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

function pct(x) { return isFinite(x) ? (100 * x).toFixed(1) + '%' : '?'; }

/*
 * A repertoire's score on an index: best one it wasn't made from (a holdout), so the
 * choices' luck can't flatter it. The PGN can be any repertoire: deeprep's, repgen's, or
 * one made by hand.
 */
function cmdEval(argv) {
  var o = parse(argv, false, true);
  if (!o.file) throw new Error('Which PGN? deeprep eval <index> <pgn>');
  var file = inPath(o.file);
  if (!/\.pgn$/i.test(file) && !fs.existsSync(file) && fs.existsSync(file + '.pgn')) file += '.pgn';
  var rep = repertoireFromPgn(fs.readFileSync(file, 'utf8'), { side: o.search.side, root: o.fen });
  var db = open(o.name);
  try {
    var r = evaluateRepertoire(db, rep, { minGames: o.search.minGames || DEFAULTS.minGames });
    var me = rep.side === 'w' ? 'White' : 'Black';
    var from = rep.prefix && rep.prefix.length ? lineText(rep.start, rep.prefix)
      : rep.root === new Chess().fen() ? 'the start' : rep.root;
    console.log('Repertoire for ' + me + ' from ' + from +
      '\n  on ' + db.meta.source + ' (' + db.meta.filter.speeds.join(',') + ', ' + db.meta.filter.ratings.join(',') + ')');
    // The dumps it was made from, when the run's JSON says.
    var json = file.replace(/\.pgn$/i, '.json');
    var made = null;
    try { made = JSON.parse(fs.readFileSync(json, 'utf8')).meta; } catch (e) { /* none, or not deeprep's */ }
    var mine = dumpsOf(db.meta);
    if (made && made.dumps) {
      var both = made.dumps.filter(function (d) { return mine.indexOf(d) >= 0; });
      console.log(both.length
        ? '  Note: ' + both.length + ' of the ' + made.dumps.length + ' dumps it was made from are in this index too, so ' +
          'this score shares the choices\' luck. An index of other months gives an unbiased one.'
        : '  None of the dumps it was made from are in this index: the score is unbiased (a holdout).');
    }
    if (!r.games) throw new Error('The root is not in this index.');
    console.log('  Score ' + pct(r.s) + ' ±' + (100 * r.se).toFixed(1) + ' over ' + fmt(r.games) + ' games; everyone ' +
      'scored ' + pct(r.raw) + ' from there (' + ((r.s - r.raw) >= 0 ? '+' : '') + (100 * (r.s - r.raw)).toFixed(1) + ').');
    console.log('  Moves to know: ' + fmt(r.cards) + ' positions' + (r.unreached ? ' (and ' + fmt(r.unreached) +
      ' these games never reach)' : '') + '.' + (rep.conflicts ? ' ' + rep.conflicts + ' positions had two moves of ' +
      'mine in the PGN; the first counts.' : '') + (rep.alternatives ? ' ' + rep.alternatives + ' alternative moves ' +
      'of mine (variations) are left out.' : ''));
    console.log('  Games: ' + pct(r.ends.out) + ' leave the book on an unprepared reply, ' + pct(r.ends.end) +
      ' reach a line\'s end, ' + pct(r.ends.over) + ' end inside it.');
    if (r.first.length) {
      console.log('  Their first move:   share    rep  people');
      r.first.forEach(function (f) {
        console.log('    ' + (f.san || '(others)').padEnd(16) + (Math.round(100 * f.share) + '%').padStart(6) +
          pct(f.s).padStart(7) + pct(f.raw).padStart(8));
      });
    }
    var line = function (x, san) { return lineText(rep.root, x.path.concat(san ? [san] : [])); };
    if (r.weak.length) {
      console.log('  Weak spots (my move\'s games score under another move\'s, or the line under the position\'s average):');
      r.weak.slice(0, 15).forEach(function (w) {
        console.log('    ' + line(w, w.san) + '  reach ' + pct(w.reach) + ': ' + w.san + ' ' + pct(w.own) + ' (' +
          fmt(w.games) + ')' + (w.alt ? ', ' + w.alt + ' ' + pct(w.altScore) + ' (' + fmt(w.altGames) + ')' : '') +
          ', line ' + pct(w.value) + ', average here ' + pct(w.avg));
      });
    }
    if (r.unprepared.length) {
      console.log('  Unprepared replies (by reach):');
      r.unprepared.slice(0, 15).forEach(function (u) {
        console.log('    ' + line(u, u.san) + '  reach ' + pct(u.reach) + ' (' + Math.round(100 * u.share) + '% here), people ' +
          'score ' + pct(u.score) + ' after it');
      });
    }
    if (r.unseen.length) {
      console.log('  Moves of mine with no games in this index (the line ends there):');
      r.unseen.slice(0, 10).forEach(function (u) { console.log('    ' + line(u, u.san) + '  reach ' + pct(u.reach)); });
    }
    if (o.json) {
      var out = outPath(o.json.replace(/\.json$/i, '') + '.json');
      fs.writeFileSync(out, JSON.stringify({ meta: { index: db.meta.source, dumps: mine, pgn: file }, eval: r }, function (k, v) {
        return typeof v === 'bigint' ? String(v) : v;
      }, 1));
      console.log('Wrote ' + out);
    }
  } finally {
    db.close();
  }
  return 0;
}

// The prior this index's own games call for (fitPrior): how far good moves really differ.
function cmdFit(argv) {
  var o = parse(argv, false);
  var db = open(o.name);
  try {
    var x = Object.assign({}, DEFAULTS, o.search);
    var t = Date.now();
    var f = fitPrior(db, o.fen, { samples: o.samples, minGames: x.minGames, side: o.search.side });
    if (!f.positions) throw new Error('No position on the walks had two moves with ' + x.minGames + ' games.');
    console.log(fmt(f.positions) + ' positions, ' + fmt(f.moves) + ' moves with ' + x.minGames + '+ games (' +
      ((Date.now() - t) / 1000).toFixed(1) + ' s).');
    console.log('Moves\' true scores spread by ' + (100 * f.tau).toFixed(2) + ' points around each other; one game ' +
      'varies by ' + (100 * Math.sqrt(f.vr)).toFixed(1) + '.');
    console.log(isFinite(f.prior)
      ? 'Prior: --prior ' + fmt(f.prior) + ' (a move with that many games keeps half its lead).'
      : 'The moves don\'t differ by more than their noise: every lead is luck. Use a large --prior.');
  } finally {
    db.close();
  }
  return 0;
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


/*
 * The positions under one line, as a small index of its own (deeprep/slice.mjs): what a
 * Claude session in the cloud needs to work on this index. --plies covers a build's lines
 * (--max-ply, 30) plus how far each decision looks ahead (--plies, 12).
 */
function cmdSlice(argv) {
  var o = parse(argv, true);
  if (!o.out) throw new Error('--out <name> is missing');
  var db = open(o.name);
  try {
    var plies = o.search.plies != null ? o.search.plies : BUILD_DEFAULTS.maxPly + BUILD_DEFAULTS.plies;
    var minGames = o.search.minGames || DEFAULTS.minGames;
    var out = indexPath(o.out);
    var t = Date.now();
    var r = writeSlice(db, o.fen, out, { plies: plies, minGames: minGames,
      line: o.prefix ? lineText(new Chess().fen(), o.prefix) : null });
    console.log('Wrote ' + out + ': ' + fmt(r.positions) + ' positions, ' + fmt(r.records) + ' records, ' +
      (r.bytes / 1e6).toFixed(1) + ' MB, in ' + ((Date.now() - t) / 1000).toFixed(1) + ' s. It answers like the whole ' +
      'index from there, down to ' + plies + ' plies, with --min-games ' + minGames + ' or more.');
  } finally {
    db.close();
  }
  return 0;
}

/* ------------------------------------------------------------------ build */

// Build options given as shares may be fractions (0.9) or percentages (90), as in repgen.
var BUILD_SHARES = ['coverage', 'coverageStep', 'singleBelow', 'minReach', 'minShare', 'lineMinReach'];

function camel(s) { return s.replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); }); }
function kebab(s) { return s.replace(/[A-Z]/g, function (ch) { return '-' + ch.toLowerCase(); }); }

function parseBuild(argv) {
  var o = { name: null, fen: null, moves: null, side: null, out: null, config: {}, decisions: null, holdout: null,
    chessdb: true, chessdbRate: 60, cache: null };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--fen') o.fen = argv[++i];
    else if (a === '--moves') o.moves = argv[++i];
    else if (a === '--side') {
      var sd = argv[++i];
      if (sd !== 'white' && sd !== 'black') throw new Error('--side is white or black');
      o.side = sd[0];
    }
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--decisions') o.decisions = argv[++i];
    else if (a === '--holdout') o.holdout = argv[++i];
    else if (a === '--no-chessdb') o.chessdb = false;
    else if (a === '--chessdb-rate') o.chessdbRate = num(argv[++i], '--chessdb-rate');
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--weights') {
      var w = String(argv[++i]).split(',').map(Number);
      if (w.length !== 3 || w.some(function (x) { return !(x >= 0); }) || !(w[0] + w[1] + w[2] > 0)) {
        throw new Error('--weights is three numbers for ChessDB, Prac and deep, e.g. 0.1,0.2,0.7');
      }
      o.config.weights = w;
    }
    else if (/^--[a-z]/.test(a) && typeof BUILD_DEFAULTS[camel(a.slice(2))] === 'number') {
      var k = camel(a.slice(2));
      var v = num(argv[++i], a);
      if (BUILD_SHARES.indexOf(k) >= 0 && v > 1) v /= 100;
      o.config[k] = v;
    }
    else if (!o.name && !/^--/.test(a)) o.name = a;
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!o.name) throw new Error('Which index?\n' + USAGE);
  if (!o.out) throw new Error('--out <name> is missing');
  o.prefix = null;
  if (o.moves != null) {
    var c = new Chess(o.fen || undefined);
    var sans = o.moves.replace(/\d+\.+/g, ' ').split(/\s+/).filter(Boolean).map(function (m) {
      try { return c.move(m).san; } catch (e) { throw new Error('Illegal move "' + m + '"'); }
    });
    if (!o.fen) o.prefix = sans;
    o.fen = c.fen();
  }
  if (!o.fen) o.fen = new Chess().fen();
  return o;
}

// ChessDB through the extension's provider, cached in repgen's file (shared with it) and
// spaced out like repgen's: a build asks for thousands of positions.
function makeChessdb(o) {
  var cachePath = o.cache ? path.resolve(o.cache) : outPath('repgen-cache.jsonl');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  var gap = 60000 / Math.max(1, o.chessdbRate), nextAt = 0;
  function politeFetch(url, init) {
    var t = Date.now(), at = Math.max(t, nextAt);
    nextAt = at + gap;
    return new Promise(function (r) { setTimeout(r, at - t); }).then(function () { return fetch(url, init); });
  }
  var stats = {};
  var p = createProviders({ fetch: politeFetch, cache: createFileCache(cachePath), stats: stats,
    getToken: function () { return Promise.resolve(''); } });
  var fn = function (fen) { return p.chessdb(fen); };
  fn.stats = stats;
  return fn;
}

function mmss(ms) {
  var s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

async function cmdBuild(argv) {
  var o = parseBuild(argv);
  var db = open(o.name);
  var hdb = o.holdout ? open(o.holdout) : null;
  try {
    var ctx = { prefix: o.prefix, root: o.fen };
    var line = function (p) { return lineOf(ctx, p); };
    if (hdb) {
      var mine = dumpsOf(db.meta), both = dumpsOf(hdb.meta).filter(function (d) { return mine.indexOf(d) >= 0; });
      if (both.length) console.log('Note: the holdout shares ' + both.length + ' dump(s) with the index (' + both.slice(0, 3).join(', ') +
        (both.length > 3 ? ', ...' : '') + '), so its score shares the choices\' luck too.');
    }
    var decisions = o.decisions ? parseDecisions(JSON.parse(fs.readFileSync(inPath(o.decisions), 'utf8')), o.fen) : new Map();
    var cdb = o.chessdb ? makeChessdb(o) : null;
    var t0 = Date.now();
    // Lookups counted, for the summary: a build's cost is mostly index reads.
    var lookups = 0;
    var counted = { meta: db.meta, records: function (k) { lookups++; return db.records(k); } };
    var b = createBuilder(counted, { root: o.fen, side: o.side, config: o.config, chessdb: cdb, decisions: decisions,
      log: function (n, what) {
        var c = n.cands.find(function (x) { return x.san === n.move; });
        var alt = n.cands.filter(function (x) { return x !== c && !x.out; }).sort(function (x, y) { return y.score - x.score; })[0];
        console.log('[' + (100 * n.reach).toFixed(2).padStart(6) + '%] ' + (line(n.path) || '(root)') + ': ' + n.move +
          (what === 'polish' ? ' (was ' + n.was[n.was.length - 1] + ')' : '') + ' (score ' + c.score.toFixed(1) + ', deep ' +
          c.deep.toFixed(1) + (c.engine != null ? ', ChessDB ' + c.engine.toFixed(1) : '') +
          (c.sound != null ? ', sound ' + c.sound.toFixed(1) : '') + '; ' + n.why +
          (alt ? '; ' + alt.san + ' ' + alt.score.toFixed(1) : '') + ') ' + mmss(Date.now() - t0));
      } });
    var side = b.side === 'w' ? 'White' : 'Black';
    console.log('Building for ' + side + ' from ' + (o.prefix ? line([]) : o.fen) + ' on ' + db.meta.source +
      (cdb ? '' : ', without ChessDB') + '.');
    await b.run();
    var cfg = b.config;
    // The holdout's games of each candidate, for the review.
    if (hdb) {
      b.nodes.forEach(function (n) {
        if (!n.cands) return;
        var pos = positionOf(hdb, n.fen);
        n.cands.forEach(function (c) {
          var m = pos.moves.find(function (x) { return x.san === c.san; });
          if (m) {
            var mine = b.side === 'w' ? m.w : m.b;
            c.holdout = { games: m.games, raw: 100 * (mine + m.d / 2) / m.games };
          }
        });
      });
    }
    var rep = { side: b.side, root: o.fen, moves: repertoireMoves(b.nodes) };
    var inSample = evaluateRepertoire(db, rep, { minGames: cfg.minGames });
    var held = hdb ? evaluateRepertoire(hdb, rep, { minGames: cfg.minGames }) : null;
    var base = outPath(o.out.replace(/\.(pgn|json|md)$/i, ''));
    fs.mkdirSync(path.dirname(base), { recursive: true });
    var nodes = [];
    b.nodes.forEach(function (n) { nodes.push(n); });
    var meta = { tool: 'deeprep build', index: db.meta.source + '@' + db.meta.created, dumps: dumpsOf(db.meta),
      filter: db.meta.filter, fen: o.fen, moves: o.prefix, side: b.side, config: cfg, chessdb: !!cdb,
      decisions: o.decisions, holdout: hdb ? { index: hdb.meta.source, dumps: dumpsOf(hdb.meta), eval: held } : null,
      inSample: inSample, stats: Object.assign({ ms: Date.now() - t0, lookups: lookups, chessdbRequests: cdb ? cdb.stats.chessdbRequests || 0 : 0 }, b.stats),
      created: new Date().toISOString() };
    var replacer = function (k, v) { return typeof v === 'bigint' ? String(v) : v; };
    fs.writeFileSync(base + '.json', JSON.stringify({ meta: meta, nodes: nodes }, replacer, 1));
    var mineCount = nodes.filter(function (n) { return n.kind === 'me' && n.status === 'done'; }).length;
    var tree = toTree(b.nodes, b.rootKey, moveNote, line);
    var headers = { Event: 'deeprep build for ' + side, Annotator: 'deeprep (' + db.meta.source + ')',
      White: b.side === 'w' ? 'Repertoire' : 'Lichess', Black: b.side === 'b' ? 'Repertoire' : 'Lichess' };
    fs.writeFileSync(base + '.pgn', toPgn(tree, { prefix: o.prefix, fen: o.prefix ? null : o.fen, headers: headers,
      rootComment: rootNote(mineCount, inSample, held) }));
    fs.writeFileSync(base + '.review.md', reviewMarkdown({ out: path.basename(base), side: b.side, root: o.fen, prefix: o.prefix,
      index: db.meta.source, filter: db.meta.filter, cfg: cfg, nodes: b.nodes, inSample: inSample, chessdb: !!cdb,
      holdout: hdb ? { name: hdb.meta.source, eval: held } : null, date: new Date().toISOString().slice(0, 10) }));
    console.log(mineCount + ' positions of mine; ' + b.stats.decisions + ' decisions, ' + b.stats.polished +
      ' changed by polishing; ' + fmt(lookups) + ' lookups, ' + (cdb ? (cdb.stats.chessdbRequests || 0) + ' ChessDB requests, ' : '') +
      mmss(Date.now() - t0) + '.');
    console.log('In sample: ' + (100 * inSample.s).toFixed(1) + '% (everyone ' + (100 * inSample.raw).toFixed(1) + '%)' +
      (held ? '. Holdout: ' + (100 * held.s).toFixed(1) + '% ±' + (100 * held.se).toFixed(1) + ' (everyone ' + (100 * held.raw).toFixed(1) + '%).' : '.'));
    console.log('Wrote ' + base + '.pgn, .json and .review.md');
  } finally {
    db.close();
    if (hdb) hdb.close();
  }
  return 0;
}

async function main(argv) {
  var cmd = argv[0];
  if (cmd === 'search') return cmdSearch(argv.slice(1));
  if (cmd === 'moves') return cmdMoves(argv.slice(1));
  if (cmd === 'browse') return cmdBrowse(argv.slice(1));
  if (cmd === 'bench') return cmdBench(argv.slice(1));
  if (cmd === 'fit') return cmdFit(argv.slice(1));
  if (cmd === 'eval') return cmdEval(argv.slice(1));
  if (cmd === 'build') return cmdBuild(argv.slice(1));
  if (cmd === 'slice') return cmdSlice(argv.slice(1));
  console.log(USAGE);
  return cmd === '--help' || cmd === '-h' ? 0 : 1;
}

main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) {
  console.error('deeprep: ' + (e && e.message || e));
  process.exitCode = 1;
});
