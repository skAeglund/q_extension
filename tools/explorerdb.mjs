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
 * reads). Bare index names are looked up in and written to explorer/ (repgen/paths.mjs),
 * and a bare dump name not in the current directory is looked for there too.
 *
 *   node tools/explorerdb.mjs serve aug26 [--port 9337]
 *
 * answers the explorer's queries over HTTP (explorerdb/server.mjs), for the extension's
 * "Local explorer" setting and repgen's --explorer.
 *
 *   node tools/explorerdb.mjs all --into lichess --disk-gb 160
 *
 * imports every monthly dump Lichess has, unattended and resumable (explorerdb/all.mjs),
 * into an accumulator that keeps single games until the disk budget says otherwise
 * (explorerdb/acc.mjs), and writes lichess.xdb from it at the end. `add`, `prune` and
 * `finish` are its steps by hand; `merge` joins finished indexes.
 *
 *   curl -sL <dump url> | node tools/explorerdb.mjs filter - --out 2016/2016-02
 *
 * keeps only the games an import would keep, cut to their first plies (explorerdb/
 * filter.mjs), in parts under 95 MB with a manifest, 2016-02.json. Meant for a machine with
 * a fast line; `import 2016-02.json --out feb16` then reads the parts as the month.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Chess } from '../src/vendor/chess.js';
import { importDump, DEFAULTS } from './explorerdb/importer.mjs';
import { filterDump, FILTER_DEFAULTS } from './explorerdb/filter.mjs';
import { mergeIndexes } from './explorerdb/merge.mjs';
import { fill, drain, parseMonths, lichessDumpSize, lichessFilter } from './explorerdb/relay.mjs';
import { openIndex, explorerAnswer } from './explorerdb/store.mjs';
import { createServer, indexInfo } from './explorerdb/server.mjs';
import { RATING_GROUPS } from './explorerdb/games.mjs';
import { THRESHOLDS, REC } from './explorerdb/store.mjs';
import { inPath, outPath, EXPLORER } from './repgen/paths.mjs';
import { openAcc, addDump, prune, writeIndex, summary } from './explorerdb/acc.mjs';
import { runAll } from './explorerdb/all.mjs';

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
  '      (or a filtered month\'s manifest, <month>.json, or a folder of them, in place of',
  '      the dump: a folder\'s months are counted together, exactly)',
  '  node tools/explorerdb.mjs merge <index> <index>... --out <name> [--min-games 10]',
  '      sums indexes (a month each, say) into one; --months 2016-01..2018-12 takes',
  '      explorer/<month>.xdb for each month (--skip-missing to leave out the absent ones)',
  '  node tools/explorerdb.mjs filter <dump.pgn.zst|url|-> [--out <path>] [options]',
  '      keeps what an import would, each game cut to --plies + 1; - reads a .zst on stdin;',
  '      a URL is read as it downloads, resuming where the connection breaks',
  '      --speeds, --ratings, --plies  as for import (these are all an import can use later)',
  '      --part-mb 95        parts under this size (GitHub refuses files over 100 MB)',
  '      --level 19          zstd level',
  '      --source <name>     the dump\'s name in the manifest (for stdin)',
  '      --max-games N       stop after N games of the dump (a quick trial)',
  '  node tools/explorerdb.mjs drain --repos <owner/name,...> [options]      (at home)',
  '      imports every filtered month the repositories hold, keeps its files, and removes',
  '      it from the repository so fill can use the room; runs until stopped',
  '      --keep <dir>        where the months\' files are kept (default explorer/filtered;',
  '                          --no-keep to drop them after importing)',
  '      --no-import         only check, keep and remove each month: `all` adds the kept',
  '                          files to its accumulator, so an index per month is spare work',
  '      --until YYYY-MM     stop once every month from 2013-01 to this one is imported',
  '      --once              one pass, then stop',
  '      --max-waiting N     take no more months while N wait in --keep for `all`',
  '      --poll-min 5        how often to look when there is nothing new',
  '      --workers, --min-games, --plies   as for import (an index per month, <month>.xdb)',
  '  node tools/explorerdb.mjs fill --repos <owner/name,...> [options]       (in the cloud)',
  '      filters months from database.lichess.org into the repositories, as drain empties them',
  '      --months 2013-01..2026-12   which months (months not published yet are skipped)',
  '      --cap-gb 3          filtered months a repository holds at once',
  '      --workers 3         months filtered at once (one core each)',
  '      --part-mb 95        parts under this size; each is pushed with a checkpoint as it closes,',
  '                          so smaller parts lose less when the session is stopped mid-month',
  '      --footer <text>     appended to commit messages',
  '      --newest-first      newest month first (the other end of the archive)',
  '      --skip-done-in <owner/name,...>   another session\'s repositories: months in their',
  '                          LEDGERs are left to it, so two sessions meet in the middle',
  '  node tools/explorerdb.mjs query <index> (--moves "1.e4 c5" | --fen "<fen>")',
  '  node tools/explorerdb.mjs info <index>',
  '  node tools/explorerdb.mjs serve <index> [--port 9337] [--host 127.0.0.1]',
  '',
  'Many months, into an accumulator (<name>.acc/, kept down to single games):',
  '  node tools/explorerdb.mjs all --into <name> [options]',
  '      --disk-gb 150       disk the run may use: accumulator, dumps, temporary files',
  '      --reserve-gb 10     free space always left on the disk',
  '      --from 2013-01 --to 2026-08   months (default: all that Lichess lists)',
  '      --oldest-first      (default: newest first, so recent months are in soonest)',
  '      --dumps <dir>       where dumps are downloaded (default explorer/dumps)',
  '      --keep-dumps        keep a dump once it is added',
  '      --keep-filtered     keep the files of a filtered month once it is added (by default they go)',
  '      --filtered <dir>    filtered months from drain, added instead of downloading the',
  '                          dump (default explorer/filtered; --no-filtered to ignore them)',
  '      --filtered-before YYYY-MM   older months only come filtered: they are waited for,',
  '                          never downloaded (where the cloud fill and this meet)',
  '      --no-prefetch       never download the next dump during an import',
  '      --connections 1     connections per download (two measured no faster)',
  '      --out <name>        the index written at the end (default: the --into name)',
  '      --min-games 10      its threshold',
  '      --snapshot-every N  also write it every N months',
  '      --speeds, --ratings, --plies, --workers   as for import (a new accumulator only)',
  '  node tools/explorerdb.mjs add <dump> --into <name>     one dump, by hand',
  '  node tools/explorerdb.mjs prune <name> --min-games N',
  '  node tools/explorerdb.mjs finish <name> [--out <name>] [--min-games 10]',
  '  node tools/explorerdb.mjs info <name>                  an index, or an accumulator'
].join('\n');

var DEFAULT_PORT = 9337;

function indexPath(name, forWriting) {
  if (!/\.xdb$/i.test(name)) name += '.xdb';
  return forWriting ? outPath(name, EXPLORER) : inPath(name, EXPLORER);
}

function accPath(name) {
  if (!/\.acc$/i.test(name)) name += '.acc';
  return outPath(name, EXPLORER);
}
function isAcc(name) { return fs.existsSync(path.join(accPath(name), 'state.json')); }

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

function checkFilter(o) {
  o.speeds.forEach(function (s) {
    if (SPEEDS.indexOf(s) < 0) throw new Error('Unknown speed ' + s + ' (' + SPEEDS.join(', ') + ')');
  });
  o.ratings.forEach(function (r) {
    if (RATING_GROUPS.indexOf(r) < 0) throw new Error('Rating groups are ' + RATING_GROUPS.join(', '));
  });
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
  checkFilter(o);
  if (o.minGames < 1) o.minGames = 1;
  input = inPath(input, EXPLORER);
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

async function cmdFilter(argv) {
  var o = { speeds: FILTER_DEFAULTS.speeds, ratings: FILTER_DEFAULTS.ratings };
  var input = null, out = null;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--speeds') o.speeds = list(argv[++i]);
    else if (a === '--ratings') o.ratings = list(argv[++i]).map(Number);
    else if (a === '--plies') o.plies = num(argv[++i], '--plies');
    else if (a === '--part-mb') o.partBytes = num(argv[++i], '--part-mb') * 1e6;
    else if (a === '--level') o.level = num(argv[++i], '--level');
    else if (a === '--source') o.source = argv[++i];
    else if (a === '--max-games') o.maxGames = num(argv[++i], '--max-games');
    else if (!input && (a === '-' || !/^--/.test(a))) input = a;
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!input) throw new Error('Which dump?\n' + USAGE);
  checkFilter(o);
  if (!(o.partBytes === undefined || o.partBytes >= 1e6)) throw new Error('--part-mb is at least 1');
  var name = o.source || (input === '-' ? null : path.basename(input));
  if (!out) {
    var m = name && /(\d{4}-\d{2})/.exec(name);
    if (!m) throw new Error('--out is needed (a path without extension, e.g. --out 2016/2016-02)');
    out = m[1];
  }
  if (input !== '-' && !/^https?:\/\//i.test(input)) {
    input = inPath(input, EXPLORER);
    if (!fs.existsSync(input)) throw new Error('No such file: ' + input);
  }
  o.input = input;
  o.out = outPath(out, EXPLORER).replace(/\.json$/i, '');
  o.log = function (s) { console.error(s); };
  var m2 = await filterDump(o);
  var total = m2.parts.reduce(function (a, p) { return a + p.bytes; }, 0);
  console.log('Wrote ' + o.out + '.json and ' + m2.parts.length + ' part' + (m2.parts.length > 1 ? 's' : '') +
    ' (' + size(total) + ')');
  console.log('Games:    ' + fmt(m2.games.read) + ' read, ' + fmt(m2.games.kept) + ' kept (' +
    (100 * m2.games.kept / m2.games.read).toFixed(1) + '%)');
  console.log('Size:     ' + size(m2.bytes.dump) + ' of dump -> ' + size(total) + ' (' +
    (m2.bytes.dump / total).toFixed(1) + 'x smaller), in ' + m2.seconds + ' s');
  return 0;
}

function repoUrls(s) {
  var r = list(s).map(function (x) {
    return /^[\w.-]+\/[\w.-]+$/.test(x) ? 'https://github.com/' + x : x;
  });
  if (!r.length) throw new Error('--repos is needed (e.g. --repos you/database_helper,you/database_helper2)');
  return r;
}

async function cmdFill(argv) {
  var o = { months: parseMonths('2013-01..' + (new Date().getFullYear()) + '-12') }, partBytes;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--repos') o.repos = repoUrls(argv[++i]);
    else if (a === '--months') o.months = parseMonths(argv[++i]);
    else if (a === '--cap-gb') o.capBytes = Number(argv[++i]) * 1e9;
    else if (a === '--workers') o.workers = num(argv[++i], '--workers');
    else if (a === '--part-mb') partBytes = num(argv[++i], '--part-mb') * 1e6;
    else if (a === '--work') o.work = argv[++i];
    else if (a === '--footer') o.footer = argv[++i];
    else if (a === '--newest-first') o.newestFirst = true;
    else if (a === '--skip-done-in') o.others = repoUrls(argv[++i]);
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!o.repos) repoUrls('');
  if (o.others && o.others.some(function (u) { return o.repos.indexOf(u) >= 0; })) {
    throw new Error('--skip-done-in names the other session\'s repositories, not this one\'s');
  }
  if (!(o.capBytes === undefined || o.capBytes >= 1e8)) throw new Error('--cap-gb is at least 0.1');
  if (!(partBytes === undefined || partBytes >= 1e6)) throw new Error('--part-mb is at least 1');
  o.dumpSize = lichessDumpSize;
  o.filterMonth = lichessFilter(partBytes ? { log: function () {}, partBytes: partBytes } : { log: function () {} });
  o.log = function (s) { console.log(s); };
  var r = await fill(o);
  console.log(r.pushed + ' months pushed' + (r.skipped.length ? '; not published yet: ' + r.skipped.join(', ') : '') +
    (r.failed.length ? '; failed: ' + r.failed.join(', ') : '') +
    (r.elsewhere.length ? '; ' + r.elsewhere.length + ' left to the other session' : ''));
  return r.failed.length ? 1 : 0;
}

async function cmdDrain(argv) {
  var o = { dir: path.join(EXPLORER, 'relay'), keep: path.join(EXPLORER, 'filtered'), out: EXPLORER,
    importOptions: { speeds: DEFAULTS.speeds, ratings: DEFAULTS.ratings } };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--repos') o.repos = repoUrls(argv[++i]);
    else if (a === '--keep') o.keep = path.resolve(argv[++i]);
    else if (a === '--no-keep') o.keep = null;
    else if (a === '--no-import') o.noImport = true;
    else if (a === '--dir') o.dir = path.resolve(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--until') o.until = parseMonths('2013-01..' + parseMonths(argv[++i])[0]);
    else if (a === '--once') o.once = true;
    else if (a === '--max-waiting') o.maxWaiting = num(argv[++i], '--max-waiting');
    else if (a === '--poll-min') o.pollMs = Number(argv[++i]) * 60000;
    else if (a === '--footer') o.footer = argv[++i];
    else if (a === '--workers') o.importOptions.workers = num(argv[++i], '--workers');
    else if (a === '--min-games') o.importOptions.minGames = Math.max(1, num(argv[++i], '--min-games'));
    else if (a === '--plies') o.importOptions.plies = num(argv[++i], '--plies');
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!o.repos) repoUrls('');
  o.log = function (s) { console.log(s); };
  var got = await drain(o);
  console.log(got.length + ' months ' + (o.noImport ? 'kept' : 'imported'));
  return 0;
}

async function cmdMerge(argv) {
  var inputs = [], out = null, minGames = DEFAULTS.minGames, skipMissing = false, months = null;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--min-games') minGames = Math.max(1, num(argv[++i], '--min-games'));
    else if (a === '--months') months = parseMonths(argv[++i]);
    else if (a === '--skip-missing') skipMissing = true;
    else if (!/^--/.test(a)) inputs.push(indexPath(a, false));
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (months) {
    var missing = [];
    months.forEach(function (m) {
      var f = indexPath(m, false);
      if (fs.existsSync(f)) inputs.push(f); else missing.push(m);
    });
    if (missing.length && !skipMissing) {
      throw new Error('No index for ' + missing.join(', ') + ' (--skip-missing to merge the others)');
    }
    if (missing.length) console.error('Left out (no index): ' + missing.join(', '));
  }
  if (!out) throw new Error('--out is needed (a name, e.g. --out all)');
  inputs.forEach(function (f) { if (!fs.existsSync(f)) throw new Error('No such index: ' + f); });
  var o = { inputs: inputs, out: indexPath(out, true), minGames: minGames, log: function (s) { console.error(s); } };
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  var meta = await mergeIndexes(o);
  console.log('Wrote ' + o.out + ' (' + size(fs.statSync(o.out).size) + ') from ' + inputs.length + ' indexes\n');
  printReport(meta);
  var under = meta.merged.filter(function (m) { return m.minGames > 1; });
  if (under.length) {
    console.log('\nThe inputs kept positions reached by at least ' +
      Array.from(new Set(under.map(function (m) { return m.minGames; }))).join('/') + ' games each, so a position ' +
      'rarer than that in some of them is missing those games here. Importing their filtered months together ' +
      '(import <folder>) counts them exactly.');
  }
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
  if (!/\.xdb$/i.test(argv[0]) && isAcc(argv[0])) return accInfo(argv[0]);
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

function cmdServe(argv) {
  var name = null, port = DEFAULT_PORT, host = '127.0.0.1';
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--port') port = num(argv[++i], '--port');
    else if (a === '--host') host = argv[++i];
    else if (!name && !/^--/.test(a)) name = a;
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!name) throw new Error('Which index?\n' + USAGE);
  var db = openIndex(indexPath(name, false));
  var info = indexInfo(db);
  var t0 = Date.now(), last = 0;
  var server = createServer(db, {
    log: function (s) { console.log(s); },
    onServed: function (n) {
      // A line a minute at most while it's being used.
      if (Date.now() - last > 60000) { last = Date.now(); console.log(fmt(n) + ' answers so far'); }
    }
  });
  return new Promise(function (resolve, reject) {
    server.on('error', function (e) {
      reject(e.code === 'EADDRINUSE' ? new Error('Port ' + port + ' is taken; pick another with --port.') : e);
    });
    server.listen(port, host, function () {
      console.log('Serving ' + info.source + ' (' + fmt(info.positions) + ' positions; ' +
        info.filter.speeds.join(', ') + '; ratings ' + info.filter.ratings.join(', ') + ')');
      console.log('at http://' + (host === '127.0.0.1' ? 'localhost' : host) + ':' + port +
        '. Stop with Ctrl+C.');
      process.on('SIGINT', function () {
        console.log('\nStopped after ' + Math.round((Date.now() - t0) / 60000) + ' min.');
        server.close();
        server.closeAllConnections();
        db.close();
        resolve(0);
      });
    });
  });
}

// --speeds, --ratings, --plies, --workers into `o`; returns the other arguments.
function filterArgs(argv, o) {
  var rest = [];
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--speeds') o.speeds = list(argv[++i]);
    else if (a === '--ratings') o.ratings = list(argv[++i]).map(Number);
    else if (a === '--plies') o.plies = num(argv[++i], '--plies');
    else if (a === '--workers') o.workers = num(argv[++i], '--workers');
    else rest.push(a);
  }
  (o.speeds || []).forEach(function (s) {
    if (SPEEDS.indexOf(s) < 0) throw new Error('Unknown speed ' + s + ' (' + SPEEDS.join(', ') + ')');
  });
  (o.ratings || []).forEach(function (r) {
    if (RATING_GROUPS.indexOf(r) < 0) throw new Error('Rating groups are ' + RATING_GROUPS.join(', '));
  });
  return rest;
}

function newAcc(o) {
  return { filter: { speeds: o.speeds || DEFAULTS.speeds, ratings: o.ratings || DEFAULTS.ratings },
    plies: o.plies || DEFAULTS.plies };
}

function stderr(s) { console.error(s); }

function accInfo(name) {
  var acc = openAcc(accPath(name), { readOnly: true });
  var sum = summary(acc), t = acc.totals(), st = acc.state;
  console.log('Accumulator ' + acc.dir + ' (' + st.filter.speeds.join(', ') + '; ratings ' +
    st.filter.ratings.join(', ') + '; ' + st.plies + ' plies)');
  var months = sum.dumps.map(function (d) { var m = /(\d{4}-\d{2})/.exec(d); return m ? m[1] : d; }).sort();
  console.log('Dumps:    ' + months.length + (months.length ? ' (' + months.join(' ') + ')' : ''));
  console.log('Games:    ' + fmt(sum.games.read) + ' read, ' + fmt(sum.games.kept) + ' kept');
  console.log('Prunes:   ' + (sum.prunes.length ? 'at ' + sum.prunes.join(', ') + '; a position is missing at most ' +
    sum.maxUndercount + (sum.maxUndercount === 1 ? ' game' : ' games') + ', and ' + fmt(sum.droppedGames) + ' position visits were dropped in all' : 'none'));
  if (st.pending) {
    console.log('Unfinished: ' + (st.pending.type === 'dump' ? 'adding ' + st.pending.source :
      'pruning at ' + st.pending.minGames) + ' (run it again to finish)');
  }
  console.log('Holds:    ' + size(t.bytes) + '\n');
  console.log('Positions reached by at least N games, and an index that kept them:');
  console.log('       N    positions   moves+ends        size');
  THRESHOLDS.forEach(function (n, i) {
    console.log(String(n).padStart(8) + fmt(t.positions[i]).padStart(13) + fmt(t.records[i]).padStart(13) +
      size(t.records[i] * REC).padStart(12));
  });
  return 0;
}

async function cmdAdd(argv) {
  var o = {}, input = null, into = null;
  var rest = filterArgs(argv, o);
  for (var i = 0; i < rest.length; i++) {
    if (rest[i] === '--into') into = rest[++i];
    else if (!input && !/^--/.test(rest[i])) input = rest[i];
    else throw new Error('Unexpected argument: ' + rest[i] + '\n' + USAGE);
  }
  if (!input || !into) throw new Error('add <dump> --into <name>\n' + USAGE);
  input = inPath(input, EXPLORER);
  if (!fs.existsSync(input)) throw new Error('No such file: ' + input);
  var acc = openAcc(accPath(into), { create: newAcc(o) });
  try {
    var op = await addDump(acc, input, importDump, { workers: o.workers, log: stderr });
    console.log('Added ' + op.source + ': ' + fmt(op.report.games.kept) + ' games kept; ' +
      size(op.bytesBefore) + ' -> ' + size(op.bytesAfter));
  } finally {
    acc.close();
  }
  return 0;
}

function cmdPrune(argv) {
  var name = null, n = null;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-games') n = num(argv[++i], '--min-games');
    else if (!name && !/^--/.test(argv[i])) name = argv[i];
    else throw new Error('Unexpected argument: ' + argv[i] + '\n' + USAGE);
  }
  if (!name || !(n >= 2)) throw new Error('prune <name> --min-games N (2 or more)\n' + USAGE);
  var acc = openAcc(accPath(name));
  try {
    var op = prune(acc, n, stderr);
    console.log('Pruned at ' + n + ': ' + size(op.bytesBefore) + ' -> ' + size(op.bytesAfter));
  } finally {
    acc.close();
  }
  return 0;
}

function cmdFinish(argv) {
  var name = null, out = null, n = DEFAULTS.minGames;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--min-games') n = num(argv[++i], '--min-games');
    else if (!name && !/^--/.test(argv[i])) name = argv[i];
    else throw new Error('Unexpected argument: ' + argv[i] + '\n' + USAGE);
  }
  if (!name) throw new Error('finish <name> [--out <name>]\n' + USAGE);
  var file = indexPath(out || name, true);
  var acc = openAcc(accPath(name));
  try {
    var meta = writeIndex(acc, file, Math.max(1, n), stderr);
    console.log('Wrote ' + file + ' (' + size(fs.statSync(file).size) + ')\n');
    printReport(meta);
  } finally {
    acc.close();
  }
  return 0;
}

async function cmdAll(argv) {
  var o = {}, into = null, out = null, n = DEFAULTS.minGames;
  var run = { diskBytes: 150e9, reserveBytes: 10e9, prefetch: true, keepDumps: false, snapshotEvery: 0,
    dumps: path.join(EXPLORER, 'dumps'), filtered: path.join(EXPLORER, 'filtered') };
  var rest = filterArgs(argv, o);
  for (var i = 0; i < rest.length; i++) {
    var a = rest[i];
    if (a === '--into') into = rest[++i];
    else if (a === '--out') out = rest[++i];
    else if (a === '--min-games') n = num(rest[++i], '--min-games');
    else if (a === '--disk-gb') run.diskBytes = Number(rest[++i]) * 1e9;
    else if (a === '--reserve-gb') run.reserveBytes = Number(rest[++i]) * 1e9;
    else if (a === '--from') run.from = rest[++i];
    else if (a === '--to') run.to = rest[++i];
    else if (a === '--oldest-first') run.oldestFirst = true;
    else if (a === '--dumps') run.dumps = path.resolve(rest[++i]);
    else if (a === '--keep-dumps') run.keepDumps = true;
    else if (a === '--keep-filtered') run.keepFiltered = true;
    else if (a === '--filtered') run.filtered = path.resolve(rest[++i]);
    else if (a === '--no-filtered') run.filtered = null;
    else if (a === '--filtered-before') run.filteredBefore = rest[++i];
    else if (a === '--no-prefetch') run.prefetch = false;
    else if (a === '--connections') run.connections = num(rest[++i], '--connections');
    else if (a === '--snapshot-every') run.snapshotEvery = num(rest[++i], '--snapshot-every');
    else throw new Error('Unexpected argument: ' + a + '\n' + USAGE);
  }
  if (!into) throw new Error('all --into <name>\n' + USAGE);
  if (run.filteredBefore && !run.filtered) throw new Error('--filtered-before needs the filtered months (not --no-filtered)');
  [run.from, run.to, run.filteredBefore].forEach(function (m) {
    if (m && !/^\d{4}-\d{2}$/.test(m)) throw new Error('Months are written 2016-02');
  });
  if (!(run.diskBytes > 0) || !(run.reserveBytes >= 0)) throw new Error('--disk-gb and --reserve-gb are numbers');
  var c = newAcc(o);
  run.acc = accPath(into);
  run.out = indexPath(out || into, true);
  run.minGames = Math.max(1, n);
  run.filter = c.filter;
  run.plies = c.plies;
  run.workers = o.workers;
  fs.mkdirSync(run.acc, { recursive: true });
  var logFile = path.join(run.acc, 'log.txt');
  run.log = function (s) {
    var line = new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + s;
    console.error(line);
    fs.appendFileSync(logFile, line + '\n');
  };
  try {
    await runAll(run);
  } catch (e) {
    run.log('stopped: ' + (e && e.message || e));
    throw e;
  }
  run.log('done');
  return 0;
}

async function main(argv) {
  var cmd = argv[0];
  if (cmd === 'import') return cmdImport(argv.slice(1));
  if (cmd === 'filter') return cmdFilter(argv.slice(1));
  if (cmd === 'fill') return cmdFill(argv.slice(1));
  if (cmd === 'merge') return cmdMerge(argv.slice(1));
  if (cmd === 'drain') return cmdDrain(argv.slice(1));
  if (cmd === 'query') return cmdQuery(argv.slice(1));
  if (cmd === 'info') return cmdInfo(argv.slice(1));
  if (cmd === 'serve') return cmdServe(argv.slice(1));
  if (cmd === 'add') return cmdAdd(argv.slice(1));
  if (cmd === 'prune') return cmdPrune(argv.slice(1));
  if (cmd === 'finish') return cmdFinish(argv.slice(1));
  if (cmd === 'all') return cmdAll(argv.slice(1));
  console.log(USAGE);
  return cmd === '--help' || cmd === '-h' ? 0 : 1;
}

main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) {
  console.error('explorerdb: ' + (e && e.message || e));
  process.exitCode = 1;
});
