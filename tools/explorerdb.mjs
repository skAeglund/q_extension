#!/usr/bin/env node
/*
 * explorerdb - a local opening explorer, built from Lichess's monthly game dumps
 * (https://database.lichess.org), so repertoire runs need not wait on the explorer's rate
 * limit.
 *
 *   node tools/explorerdb.mjs import lichess_db_standard_rated_2026-08.pgn.zst --out aug26
 *
 * reads one dump and writes aug26.xdb: for every position reached by at least --min-games
 * of the games that pass the filter, the moves played and their results. The filter is
 * fixed when importing and defaults to what the extension asks Lichess for (blitz, rapid,
 * classical; average rating 1600 and up). The report says how many positions each
 * threshold keeps and how big the index would be, so one month tells what the whole
 * archive would cost.
 *
 *   node tools/explorerdb.mjs query aug26 --moves "1.e4 c5"
 *   node tools/explorerdb.mjs query aug26 --fen "<fen>"
 *   node tools/explorerdb.mjs info aug26
 *
 * `query` prints a position the way the Lichess explorer answers (the parts the search
 * reads). Bare names are looked up in and written to repertoires/ (repgen/paths.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Chess } from '../src/vendor/chess.js';
import { importDump, DEFAULTS } from './explorerdb/importer.mjs';
import { openIndex, explorerAnswer } from './explorerdb/store.mjs';
import { RATING_GROUPS } from './explorerdb/games.mjs';
import { inPath, outPath } from './repgen/paths.mjs';

var SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

var USAGE = [
  'Usage:',
  '  node tools/explorerdb.mjs import <dump.pgn.zst|.pgn> --out <name> [options]',
  '      --speeds blitz,rapid,classical    time controls to keep',
  '      --ratings 1600,1800,2000,2200,2500 rating groups (players\' average) to keep',
  '      --plies 40          moves counted per game, in plies',
  '      --min-games 10      keep positions reached by at least this many games',
  '      --workers N         replay threads (default: cores - 1, at most 8)',
  '      --max-games N       stop after N games of the dump (a quick trial)',
  '      --tmp <dir>         temporary files (default <out>.tmp; a month needs 10-15 GB)',
  '      --keep-tmp          leave them there',
  '  node tools/explorerdb.mjs query <index> (--moves "1.e4 c5" | --fen "<fen>")',
  '  node tools/explorerdb.mjs info <index>'
].join('\n');

function indexPath(name, forWriting) {
  if (!/\.xdb$/i.test(name)) name += '.xdb';
  return forWriting ? outPath(name) : inPath(name);
}

function list(s, what) {
  return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

function num(s, what) {
  var v = Number(s);
  if (!(v >= 0) || Math.floor(v) !== v) throw new Error(what + ' is a whole number');
  return v;
}

function fmt(n) { return n.toLocaleString('en-US'); }
function size(b) {
  return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' :
    (b / 1e3).toFixed(1) + ' kB';
}

function printReport(meta) {
  var r = meta.report, g = r.games;
  console.log('Source:   ' + meta.source + ' (' + meta.filter.speeds.join(', ') + '; ratings ' +
    meta.filter.ratings.join(', ') + '; ' + meta.plies + ' plies)');
  console.log('Games:    ' + fmt(g.read) + ' read, ' + fmt(g.kept) + ' passed the filter (' +
    (g.read ? (100 * g.kept / g.read).toFixed(1) : '0') + '%), ' + fmt(g.illegal) + ' unreadable');
  console.log('Skipped:  speed ' + fmt(g.skipped.speed) + ', rating ' + fmt(g.skipped.rating) +
    ', variant or set-up ' + fmt(g.skipped.variant) + ', no result ' + fmt(g.skipped.result) +
    (g.skipped.broken ? ', broken ' + fmt(g.skipped.broken) : ''));
  console.log('Plies:    ' + fmt(g.plies) + ' replayed, ' + fmt(r.spilled) + ' records counted');
  console.log('');
  console.log('Positions reached by at least N games, and the index that would keep them:');
  console.log('       N    positions   moves+ends        size');
  r.thresholds.forEach(function (t) {
    console.log(String(t.minGames).padStart(8) + fmt(t.positions).padStart(13) +
      fmt(t.records).padStart(13) + size(t.bytes).padStart(12) +
      (t.minGames === meta.minGames ? '   <- this index' : ''));
  });
  if (!r.thresholds.some(function (t) { return t.minGames === meta.minGames; })) {
    console.log('This index keeps N >= ' + meta.minGames + ': ' + fmt(r.positions) + ' positions.');
  }
  console.log('');
  console.log('Took ' + Math.floor(r.seconds / 60) + 'm' + String(r.seconds % 60).padStart(2, '0') + 's.');
}

async function cmdImport(argv) {
  var o = { speeds: DEFAULTS.speeds, ratings: DEFAULTS.ratings };
  var input = null, out = null;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--speeds') o.speeds = list(argv[++i]);
    else if (a === '--ratings') o.ratings = list(argv[++i]).map(Number);
    else if (a === '--plies') o.plies = num(argv[++i], '--plies');
    else if (a === '--min-games') o.minGames = num(argv[++i], '--min-games');
    else if (a === '--workers') o.workers = num(argv[++i], '--workers');
    else if (a === '--max-games') o.maxGames = num(argv[++i], '--max-games');
    else if (a === '--tmp') o.tmp = argv[++i];
    else if (a === '--keep-tmp') o.keepTmp = true;
    else if (!input && !/^--/.test(a)) input = a;
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!input) throw new Error('Which dump?\n' + USAGE);
  if (!out) throw new Error('--out is needed (a name, e.g. --out aug26)');
  o.speeds.forEach(function (s) {
    if (SPEEDS.indexOf(s) < 0) throw new Error('Unknown speed ' + s + ' (' + SPEEDS.join(', ') + ')');
  });
  o.ratings.forEach(function (r) {
    if (RATING_GROUPS.indexOf(r) < 0) throw new Error('Rating groups are ' + RATING_GROUPS.join(', '));
  });
  if (o.minGames < 1) o.minGames = 1;
  if (!fs.existsSync(input)) throw new Error('No such file: ' + input);
  o.input = input;
  o.out = indexPath(out, true);
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  o.log = function (s) { console.error(s); };
  var meta = await importDump(o);
  console.log('Wrote ' + o.out + ' (' + size(fs.statSync(o.out).size) + ')\n');
  printReport(meta);
  return 0;
}

function cmdQuery(argv) {
  var name = null, fen = null, moves = null;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--fen') fen = argv[++i];
    else if (a === '--moves') moves = argv[++i];
    else if (!name && !/^--/.test(a)) name = a;
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!name) throw new Error('Which index?\n' + USAGE);
  if (moves != null) {
    var c = new Chess();
    moves.replace(/\d+\.+/g, ' ').split(/\s+/).filter(Boolean).forEach(function (m) {
      try { c.move(m); } catch (e) { throw new Error('Illegal move "' + m + '"'); }
    });
    fen = c.fen();
  }
  if (!fen) fen = new Chess().fen();
  var db = openIndex(indexPath(name, false));
  try {
    console.log(JSON.stringify(explorerAnswer(db, fen), null, 1));
  } finally {
    db.close();
  }
  return 0;
}

function cmdInfo(argv) {
  if (!argv[0]) throw new Error('Which index?\n' + USAGE);
  var db = openIndex(indexPath(argv[0], false));
  try {
    console.log(fmt(db.count) + ' records; made ' + db.meta.created + ', keeping N >= ' +
      db.meta.minGames + '\n');
    printReport(db.meta);
  } finally {
    db.close();
  }
  return 0;
}

async function main(argv) {
  var cmd = argv[0];
  if (cmd === 'import') return cmdImport(argv.slice(1));
  if (cmd === 'query') return cmdQuery(argv.slice(1));
  if (cmd === 'info') return cmdInfo(argv.slice(1));
  console.log(USAGE);
  return cmd === '--help' || cmd === '-h' ? 0 : 1;
}

main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) {
  console.error('explorerdb: ' + (e && e.message || e));
  process.exitCode = 1;
});
