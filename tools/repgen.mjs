#!/usr/bin/env node
/*
 * repgen - builds a repertoire from the Practical eval, unattended (overnight, say).
 *
 *   set LICHESS_TOKEN=lip_...        (PowerShell: $env:LICHESS_TOKEN = 'lip_...')
 *   node tools/repgen.mjs --moves "1.e4 c5" --side white --out sicilian
 *
 * A bare --out name goes into repertoires/ (repgen/paths.mjs); one with a directory is
 * taken as it is. Writes <out>.pgn (re-written after every position, so it is always readable),
 * <out>.json (the run's state: run the same command again to resume) and <out>.log.
 * Responses are cached in repgen-cache.jsonl next to <out>, shared by every run.
 *
 *   node tools/repgen.mjs --out sicilian --check
 *
 * checks a run against ChessDB's newer evals (repgen/check.mjs) and searches again where
 * they could change a move; --dry-run only reports.
 *
 * The search, the rounds and the providers are the extension's own (src/pe). What this
 * adds is the plan (repgen/generator.mjs) and Node plumbing. With --maia, Maia 3 fills in
 * thin positions as it does in the column; repgen runs the model itself (repgen/maia.mjs),
 * which needs `npm install --prefix tools` once.
 *
 * See README.md, "Repertoire generator", for the options.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Chess } from '../src/vendor/chess.js';
import { createProviders, localAddress, localInfo } from '../src/pe/providers.js';
import { fenKey } from '../src/pe/search.js';
import { createGenerator, newState, REPGEN_DEFAULTS, SEARCH_DEFAULTS } from './repgen/generator.mjs';
import { makeRunRoot } from './repgen/root.mjs';
import { createFileCache, withFreshChessdb } from './repgen/filecache.mjs';
import { runCheck, apply as applyCheck, outcome as checkOutcome } from './repgen/check.mjs';
import { toPgn, engineLoss, markFor } from './repgen/pgn.mjs';
import { outPath, REPERTOIRES } from './repgen/paths.mjs';
import { loadMaia, maiaEloFor, clampElo, MAIA_FILE } from './repgen/maia.mjs';

var STANDARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Options that are shares may be given as fractions (0.9) or percentages (90).
var SHARES = ['coverage', 'coverageStep', 'singleBelow', 'minReach', 'minShare', 'lineMinReach', 'rowShare',
  'replyThreshold', 'reachFloor', 'compareReachMin'];

function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

function parseArgs(argv) {
  var a = {};
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '-h') { a.help = true; continue; }
    var m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error('Unexpected argument: ' + argv[i]);
    var k = camel(m[1]);
    if (m[2] != null) a[k] = m[2];
    else if (i + 1 < argv.length && !/^--[a-z]/.test(argv[i + 1])) a[k] = argv[++i];
    else a[k] = true;
  }
  return a;
}

function usage() {
  return [
    'Usage: node tools/repgen.mjs [--fen "<FEN>" | --moves "1.e4 c5"] [--side white|black]',
    '                             [--out <name>] [--hours <n>] [options]',
    '',
    'Start:     --fen, --moves (from the initial position), --side (default: side to move)',
    'Output:    --out <name> (default "repertoire"), --cache <file>, --fresh, --pgn-only',
    'Check:     --check (ask ChessDB again, search again where it matters), --check-all',
    '           (search every one of my positions again), --dry-run (report only)',
    'Run:       --hours <n>, --max-searches <n>, --rate <Lichess requests/min, default 15>,',
    '           --chessdb-rate <ChessDB requests/min, default 60>',
    'Lichess:   --speeds blitz,rapid,classical  --ratings 1800,2000,2200  --token-file <file>',
    '           (or the LICHESS_TOKEN environment variable)',
    '           --explorer localhost:9337: ask a local explorer (tools/explorerdb.mjs serve)',
    '           instead; no token needed, and a new run takes the index\'s filter',
    'Maia:      --maia [on|off] (off; kept with the run), --maia-model <file> (default',
    '           repertoires/' + MAIA_FILE + ', downloaded on first use), --maia-elo <n>',
    '           (default: from --ratings, 2100 for 1800,2000,2200), --maia-until 100,',
    '           --maia-only-below 10, --maia-weight 20',
    'Choice:    --weights <ChessDB>,<Practical>,<prepared> (default ' + REPGEN_DEFAULTS.weights + ';',
    '           kept with the run, and runs from before it have 0,1,0), --prep-prior-games 50',
    '           (games\' worth of trust in the Practical value at a prepared score\'s leaf)',
    'Plan:      ' + Object.keys(REPGEN_DEFAULTS).filter(function (k) { return k !== 'weights'; }).map(function (k) {
      return '--' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }) +
        ' ' + REPGEN_DEFAULTS[k];
    }).join('\n           '),
    'Search:    ' + Object.keys(SEARCH_DEFAULTS).filter(function (k) { return !/^maia/.test(k); })
      .map(function (k) {
        return '--' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }) +
          ' ' + SEARCH_DEFAULTS[k];
      }).join('\n           ')
  ].join('\n');
}

function numberOpt(k, v) {
  var n = Number(v);
  if (!isFinite(n) || n < 0) throw new Error('--' + k + ' needs a number, got ' + v);
  if (SHARES.indexOf(k) >= 0 && n > 1) n /= 100;
  return n;
}

// --weights 0.1,0.2,0.7: ChessDB, Practical, prepared. Kept as shares of 1.
function weightsOpt(v) {
  var w = String(v).split(',').map(Number);
  if (w.length !== 3 || w.some(function (x) { return !isFinite(x) || x < 0; }) ||
      !(w[0] + w[1] + w[2] > 0)) {
    throw new Error('--weights is three numbers for ChessDB, Practical and prepared, e.g. 0.1,0.2,0.7; got ' + v);
  }
  var t = w[0] + w[1] + w[2];
  return w.map(function (x) { return Math.round(x / t * 1e6) / 1e6; });
}

function pick(args, defaults) {
  var out = {};
  Object.keys(defaults).forEach(function (k) {
    if (args[k] != null && typeof defaults[k] === 'number') out[k] = numberOpt(k, args[k]);
  });
  return out;
}

function startFrom(args) {
  if (args.moves) {
    var c = new Chess(args.fen && args.fen !== true ? args.fen : STANDARD);
    var sans = String(args.moves).replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/).filter(Boolean);
    var played = sans.map(function (s) {
      try { return c.move(s).san; } catch (e) { throw new Error('Not a legal move in --moves: ' + s); }
    });
    // A prefix is only written into the PGN from the initial position.
    return { fen: c.fen(), prefix: args.fen ? [] : played, fenGiven: !!args.fen };
  }
  var fen = args.fen && args.fen !== true ? String(args.fen) : STANDARD;
  new Chess(fen);   // throws on a bad FEN
  return { fen: fen, prefix: [] };
}

function sideOf(v, fen) {
  if (v == null || v === true) return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
  v = String(v).toLowerCase();
  if (v === 'w' || v === 'white') return 'w';
  if (v === 'b' || v === 'black') return 'b';
  throw new Error('--side is white or black');
}

function onOff(v) {
  if (v === true) return true;
  var s = String(v).toLowerCase();
  if (s === 'on' || s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'off' || s === 'false' || s === 'no' || s === '0') return false;
  throw new Error('--maia is on or off, got ' + v);
}

function readToken(args) {
  if (args.tokenFile) return fs.readFileSync(String(args.tokenFile), 'utf8').trim();
  return String(process.env.LICHESS_TOKEN || '').trim();
}

function mmss(ms) {
  var s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

/*
 * --explorer: the local explorer is asked what it serves before anything else, since a
 * new run takes its filter (repgen's default filter is not the importer's).
 */
function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return Promise.resolve(); }
  if (args.explorer == null) return run(args, null);
  if (args.explorer === true) throw new Error('--explorer needs the local explorer\'s address, e.g. --explorer localhost:9337');
  return localInfo(fetch, String(args.explorer)).then(function (info) {
    return run(args, { address: localAddress(String(args.explorer)), info: info });
  });
}

function run(args, local) {
  var out = outPath(args.out && args.out !== true ? String(args.out) : 'repertoire');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  var statePath = out + '.json', pgnPath = out + '.pgn', logPath = out + '.log';
  var cachePath = args.cache ? path.resolve(String(args.cache))
    : path.join(path.dirname(out), 'repgen-cache.jsonl');

  function log(s) {
    var line = new Date().toISOString().slice(11, 19) + ' ' + s;
    console.log(line);
    try { fs.appendFileSync(logPath, line + '\n'); } catch (e) { /* the console has it */ }
  }

  // State: resume unless told otherwise. Plan and search options given now override the
  // saved ones, so a run can be tuned between nights.
  var state = null;
  var checking = !!(args.check || args.checkAll);
  if (checking && (args.fresh || !fs.existsSync(statePath))) {
    throw new Error('--check needs a run to check: ' + statePath +
      (args.fresh ? ', not --fresh.' : ' not found.'));
  }
  if (args.dryRun && !checking) throw new Error('--dry-run goes with --check.');
  if (fs.existsSync(statePath) && !args.fresh) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (args.fen || args.moves) {
      var s = startFrom(args);
      if (fenKey(s.fen) !== fenKey(state.startFen)) {
        throw new Error(statePath + ' is a run from another position. Use --fresh to start ' +
          'over, or another --out.');
      }
    }
    if (args.side && sideOf(args.side, state.startFen) !== state.side) {
      throw new Error(statePath + ' is a run for the other side. Use --fresh or another --out.');
    }
  } else {
    var st = startFrom(args);
    state = newState(st.fen, sideOf(args.side, st.fen), st.prefix);
    state.filter = local ? { speeds: local.info.filter.speeds.slice(), ratings: local.info.filter.ratings.slice() } : {
      speeds: String(args.speeds || 'blitz,rapid,classical').split(',').filter(Boolean),
      ratings: String(args.ratings || '1800,2000,2200').split(',').filter(Boolean).map(Number)
    };
    // The weights are saved even at their defaults, so a later change of the defaults
    // doesn't change how this run chooses.
    state.config = { weights: REPGEN_DEFAULTS.weights.slice() };
    state.search = {};
    state.created = new Date().toISOString();
  }
  // Runs from before the blend chose by Practical value alone, and keep doing so.
  if (!state.config.weights) {
    state.config.weights = [0, 1, 0];
    if (!args.pgnOnly && args.weights == null) log('Note: this run was made choosing by Practical value alone and keeps doing so. ' +
      '--weights ' + REPGEN_DEFAULTS.weights + ' --check chooses again with ChessDB and the prepared ' +
      'score weighed in (a search again for each of my positions with more than one candidate).');
  }
  if (args.weights != null) {
    var wWas = state.config.weights.join();
    state.config.weights = weightsOpt(args.weights === true ? '' : args.weights);
    if (wWas !== state.config.weights.join() && state.searches > 0 && !checking) {
      log('Note: the positions searched so far keep the moves chosen with weights ' + wWas +
        '. --check chooses them again.');
    }
  }
  if (args.speeds || args.ratings) {
    if (Object.keys(state.nodes).length > 1 && !args.fresh) {
      log('Note: changing the Lichess filter mid-run mixes two player pools in one repertoire.');
    }
    if (args.speeds) state.filter.speeds = String(args.speeds).split(',').filter(Boolean);
    if (args.ratings) state.filter.ratings = String(args.ratings).split(',').filter(Boolean).map(Number);
  }
  Object.assign(state.config, pick(args, REPGEN_DEFAULTS));
  Object.assign(state.search, pick(args, SEARCH_DEFAULTS));
  if (args.maia != null) {
    var maiaWas = !!state.search.maia;
    state.search.maia = onOff(args.maia);
    if (maiaWas !== state.search.maia && state.searches > 0 && !checking) {
      log(state.search.maia
        ? 'Note: the positions searched so far were searched without Maia. --check searches ' +
          'again those where it matters.'
        : 'Note: the positions searched so far keep the values they had with Maia.');
    }
  }
  if (state.search.maiaElo) state.search.maiaElo = clampElo(state.search.maiaElo);
  // Maia plays at the filter's rating unless told otherwise, so a run that changes its
  // filter moves Maia with it.
  var maiaOn = !!state.search.maia;
  var maiaElo = state.search.maiaElo || maiaEloFor(state.filter.ratings);
  var maiaFile = args.maiaModel && args.maiaModel !== true ? path.resolve(String(args.maiaModel))
    : path.join(REPERTOIRES, MAIA_FILE);

  function save() {
    var tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
    fs.writeFileSync(pgnPath, toPgn(state));
  }

  if (args.pgnOnly) {
    fs.writeFileSync(pgnPath, toPgn(state));
    log('Wrote ' + pgnPath);
    return Promise.resolve();
  }

  // Where the games come from, kept with the run: one month of your own index and all of
  // Lichess are two different pools, like two filters.
  var source = local ? 'local ' + local.info.id : 'lichess';
  var searchedBefore = Object.keys(state.nodes).length > 1;
  if (state.explorer && state.explorer !== source && searchedBefore && !checking) {
    log('Note: this run was searched with ' + state.explorer + ' and now uses ' + source +
      '. The two count different games.');
  } else if (!state.explorer && local && searchedBefore) {
    log('Note: this run was searched with Lichess and now uses ' + source + '.');
  }
  state.explorer = source;
  if (local) {
    var f = local.info.filter;
    var same = function (a, b) { return String(a.slice().sort()) === String(b.slice().sort()); };
    if (!same(f.speeds, state.filter.speeds) || !same(f.ratings.map(String), state.filter.ratings.map(String))) {
      log('Note: the run\'s filter is ' + state.filter.speeds.join(',') + ' / ' +
        state.filter.ratings.join(',') + ', but ' + local.address + ' serves ' + f.speeds.join(',') +
        ' / ' + f.ratings.join(',') + ' (its answers are for that).');
    }
  }

  var token = local ? '' : readToken(args);
  if (!token && !local) {
    throw new Error('No Lichess token. Create one at https://lichess.org/account/oauth/token ' +
      '(no scopes needed) and set LICHESS_TOKEN, or pass --token-file.');
  }

  // ChessDB has no limit in the providers beyond two requests in flight, which is fine
  // for a tab but not for a whole night: space its requests out here.
  var cdbGap = 60000 / (args.chessdbRate ? numberOpt('chessdbRate', args.chessdbRate) : 60);
  var cdbNext = 0;
  function politeFetch(url, init) {
    if (String(url).indexOf('chessdb.cn') < 0) return fetch(url, init);
    var t = Date.now();
    var at = Math.max(t, cdbNext);
    cdbNext = at + cdbGap;
    return new Promise(function (r) { setTimeout(r, at - t); }).then(function () {
      return fetch(url, init);
    });
  }

  // A check makes ChessDB answers from before it stale. Kept in the state, so a checked
  // run carried on later still doesn't use them. A dry run changes nothing that lasts.
  var checkStart = checking ? Date.now() : 0;
  var freshSince = function () { return checkStart || state.freshSince || 0; };

  var stats = {};
  var providers = createProviders({
    fetch: politeFetch,
    cache: withFreshChessdb(createFileCache(cachePath), freshSince),
    getToken: function () { return Promise.resolve(token); },
    localExplorer: local ? local.address : '',
    stats: stats,
    ratePerMin: args.rate ? numberOpt('rate', args.rate) : 15
  });

  function play(fen, san) {
    var c = new Chess(fen);
    var m = c.move(san);
    return { fen: c.fen(), san: m.san };
  }
  function uci(fen, san) {
    var m = new Chess(fen).move(san);
    return m.from + m.to + (m.promotion || '');
  }

  // Loaded before the first search. A position Maia fails on is searched without it, as
  // in the column; the first failure is logged.
  var maia = null;
  var maiaFailed = false;
  function maiaPolicy(fen, elo) {
    if (!maia) return Promise.resolve(null);
    return maia.policy(fen, elo).catch(function (e) {
      if (!maiaFailed) {
        maiaFailed = true;
        log('Maia failed (' + (e && e.message || e) + '); positions it fails on are searched without it.');
      }
      return null;
    });
  }
  function startMaia() {
    if (!maiaOn || maia) return Promise.resolve();
    return loadMaia({ file: maiaFile, download: !args.maiaModel || args.maiaModel === true, log: log })
      .then(function (m) {
        maia = m;
        log('Maia 3 at ' + maiaElo + (state.search.maiaElo ? '' : ' (from the rating filter)') +
          ': it blends in under ' + gen.search.maiaUntil + ' games, and decides alone under ' +
          gen.search.maiaOnlyBelow + '.');
      });
  }

  var runRoot = makeRunRoot({
    providers: providers,
    filter: state.filter,
    child: function (fen, san) { return play(fen, san).fen; },
    uci: uci,
    maia: maiaOn ? maiaPolicy : null
  });

  var NEVER = function () { return false; };
  var gen = createGenerator({
    state: state,
    config: state.config,
    search: Object.assign({}, state.search, maiaOn ? { maiaElo: maiaElo } : {}),
    deps: {
      explorer: function (fen) {
        return providers.explorer(fen, state.filter, NEVER, { priority: 100 });
      },
      chessdb: function (fen) { return providers.chessdb(fen, NEVER); },
      analyse: function (fen) { return providers.analyse(fen, null); },
      play: play,
      runRoot: runRoot
    }
  });

  var started = Date.now();
  var deadline = args.hours ? started + numberOpt('hours', args.hours) * 3600 * 1000 : Infinity;
  var maxSearches = args.maxSearches ? numberOpt('maxSearches', args.maxSearches) : Infinity;
  var searchesAtStart = state.searches;
  var sawHeaders = false;

  // The line as numbered moves, and how likely it is.
  function lineOf(n) {
    var parts = state.startFen.split(/\s+/);
    var h0 = (Math.max(1, Number(parts[5]) || 1) - 1) * 2 + (parts[1] === 'b' ? 1 : 0);
    var moves = (n.path || []).map(function (san, i) {
      var h = h0 + i;
      var num = Math.floor(h / 2) + 1;
      return (h % 2 === 0 ? num + '.' : i === 0 ? num + '...' : '') + san;
    }).join(' ');
    return '[' + (n.reach * 100).toFixed(2) + '%] ' + (moves || '(start)');
  }

  function summary(why) {
    var c = gen.counts();
    log(why + ': ' + (state.searches - searchesAtStart) + ' searches this run (' + c.searches +
      ' in all), ' + c.done + ' positions done, ' + c.leaf + ' ended, ' +
      (c.queued + c.wait + c.recheck) + ' left; ' + (stats.explorerRequests || 0) +
      ' Lichess and ' + (stats.chessdbRequests || 0) + ' ChessDB requests in ' +
      mmss(Date.now() - started) + (stats.explorer429 ?
        ', ' + stats.explorer429 + ' rate-limited' : '') +
      (maia ? '; Maia ' + maia.counts().positions + ' positions' : '') + '.');
    var o = checkOutcome(state);
    if (o.changed.length || o.added.length || o.kept || o.pending) {
      log('Check: ' + o.changed.length + ' move' + (o.changed.length === 1 ? '' : 's') +
        ' changed, ' + o.added.length + ' line' + (o.added.length === 1 ? '' : 's') +
        ' carried on, ' + o.kept + ' kept' + (o.pending ? ', ' + o.pending + ' still to search' : '') +
        '.' + (o.changed.length ? ' The PGN from before: ' + path.basename(out) + '.before-check.pgn' : ''));
      o.changed.forEach(function (n) {
        log('  ' + lineOf(n) + ': ' + n.checkPrev.move + ' -> ' + n.move);
      });
    }
  }

  process.on('SIGINT', function () {
    try { save(); } catch (e) { /* best effort */ }
    summary('Stopped');
    // A second --check would ask ChessDB about everything again; the searches it queued
    // are in the state already.
    log(checking && state.checked ? 'Run it again without --check to carry on.'
      : 'Run the same command to carry on.');
    process.exit(130);
  });

  log('repgen: ' + (state.side === 'w' ? 'White' : 'Black') + ' from ' + state.startFen +
    (state.prefix.length ? ' (' + state.prefix.join(' ') + ')' : '') + '; ' +
    (local ? 'local explorer ' + local.info.source + ' at ' + local.address : 'Lichess') + ' ' +
    state.filter.speeds.join(',') + ' / ' + state.filter.ratings.join(',') + '.');
  if (Object.keys(state.config).length || Object.keys(state.search).length) {
    log('Options: ' + JSON.stringify(Object.assign({}, state.config, state.search)));
  }

  function loop() {
    if (Date.now() >= deadline) { summary('Time is up'); return Promise.resolve(); }
    if (state.searches - searchesAtStart >= maxSearches) {
      summary('Search limit reached');
      return Promise.resolve();
    }
    return gen.step().then(function (ev) {
      if (!sawHeaders && stats.rateHeaders) {
        sawHeaders = true;
        log('Lichess rate headers: ' + JSON.stringify(stats.rateHeaders));
      }
      if (ev.type === 'done') { save(); summary('Done'); return; }
      if (ev.type === 'waiting') {
        return new Promise(function (r) {
          setTimeout(r, Math.max(1000, Math.min(ev.until - Date.now(), 30000)));
        }).then(loop);
      }
      var n = ev.node;
      if (ev.type === 'searched') {
        // Blended: the other rows by their blend, as the choice saw them.
        var blended = n.blend != null;
        var alts = (n.rows || []).filter(function (r) { return r.san !== n.move && r.value != null; })
          .map(function (r) {
            return r.san + ' ' + (blended && r.blend != null
              ? r.blend.toFixed(1) + ' (Prac ' + r.value.toFixed(1) + ')' : r.value.toFixed(1));
          });
        var el = engineLoss(n);
        log('Me   ' + lineOf(n) + ': ' + n.move + markFor(el, state.config) +
          (n.pickedBy === 'practical'
          ? ' (Prac ' + n.value.toFixed(1) + (n.few ? ' few games' : ' d' + n.depth) +
            (n.maia >= 0.005 ? ', ' + Math.round(n.maia * 100) + '% Maia' : '') +
            (blended ? (n.prep != null ? ', prep ' + n.prep.toFixed(1) : '') +
              ', blend ' + n.blend.toFixed(1) : '') +
            (alts.length ? '; ' + alts.join(', ') : '') +
            (n.ms != null ? '; ' + mmss(n.ms) + ', ' + n.spent + ' requests' : '') + ')'
          : ' (engine, ' + n.why + ')') +
          (n.checkPrev && n.checkPrev.move
            ? (n.checkPrev.move === n.move ? ', kept' : ', was ' + n.checkPrev.move) : ''));
      } else if (ev.type === 'expanded') {
        log('Opp  ' + lineOf(n) + ': ' + n.replies.map(function (r) {
          return r.san + ' ' + Math.round(r.share * 100) + '%';
        }).join(', ') + ' of ' + n.games + ' games');
      } else if (ev.type === 'no-eval') {
        log('Wait ' + lineOf(n) + ': ChessDB has no eval yet; asked it to analyse.');
      } else if (ev.type === 'retry') {
        log('Retry ' + lineOf(n) + ': ' + n.error);
      } else if (ev.type === 'leaf' && ev.error) {
        log('Gave up ' + lineOf(n) + ': ' + n.error);
      } else if (ev.type === 'recheck-failed') {
        log('Kept ' + lineOf(n) + ': ' + n.move + ', searching it again failed (' + n.error + ')');
      }
      save();
      return loop();
    });
  }

  function fmt(x) { return x == null ? '?' : x.toFixed(1); }

  function check() {
    log('Check: asking ChessDB again about my positions' + (args.dryRun ? ' (dry run)' : '') + '.');
    return runCheck({
      state: state,
      all: !!args.checkAll,
      deps: {
        explorer: function (fen) {
          return providers.explorer(fen, state.filter, NEVER, { priority: 100 });
        },
        chessdb: function (fen) { return providers.chessdb(fen, NEVER); },
        analyse: args.dryRun ? null : function (fen) { return providers.analyse(fen, null); }
      },
      onNode: function (n, r) {
        var bits = [];
        if (r.markFrom !== r.markTo) {
          bits.push('mark ' + (r.markFrom || 'none') + ' -> ' + (r.markTo || 'none') +
            ' (engine ' + fmt(n.engine) + ' -> ' + fmt(r.engine.engine) + ', best ' +
            r.engine.bestMove + ' ' + fmt(r.engine.bestEngine) + ')');
        }
        if (r.action === 'recheck') bits.push('search again: ' + r.reasons.join('; '));
        if (r.action === 'queue') bits.push('carry on: ' + r.reasons.join('; '));
        if (r.still === 'no-eval') {
          bits.push('ChessDB still has no eval' + (args.dryRun ? '' : ', asked it again'));
        }
        if (bits.length) log('Check ' + lineOf(n) + ': ' + bits.join('; '));
      }
    }).then(function (res) {
      var f = res.found;
      function count(test) { return f.filter(function (x) { return test(x.result); }).length; }
      var again = count(function (r) { return r.action === 'recheck'; });
      var more = count(function (r) { return r.action === 'queue'; });
      var marks = count(function (r) { return r.markFrom !== r.markTo; });
      var still = count(function (r) { return !!r.still; });
      log('Check: ' + res.checked + ' positions of mine; ' + again + ' to search again, ' +
        more + ' line' + (more === 1 ? '' : 's') + ' to carry on, ' + marks + ' mark' +
        (marks === 1 ? '' : 's') + ' changed' + (still ? ', ' + still + ' still unknown to ChessDB' : '') +
        '; ' + (stats.chessdbRequests || 0) + ' ChessDB and ' + (stats.explorerRequests || 0) +
        ' Lichess requests in ' + mmss(Date.now() - started) + '.');
      if (args.dryRun) return false;
      // The PGN as it was, to compare with what the searches make of it.
      if (fs.existsSync(pgnPath)) fs.copyFileSync(pgnPath, out + '.before-check.pgn');
      applyCheck(state, f);
      state.freshSince = checkStart;
      state.checked = new Date(checkStart).toISOString();
      save();
      return true;
    });
  }

  // Maia is loaded before anything is asked of Lichess, so a missing install stops the run
  // at once. A dry run searches nothing.
  if (checking) {
    return (args.dryRun ? Promise.resolve() : startMaia()).then(check)
      .then(function (go) { return go ? loop() : null; });
  }
  save();
  return startMaia().then(loop);
}

main().then(function () { process.exit(0); }, function (e) {
  console.error('repgen: ' + (e && e.message === 'no-token' ? 'no Lichess token'
    : e && e.status === 401 ? 'Lichess rejected the token (401)'
    : (e && e.message) || e));
  process.exit(1);
});
