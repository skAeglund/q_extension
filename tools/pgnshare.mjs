#!/usr/bin/env node
/*
 * pgnshare - writes each branching move's played share into a PGN's comments, as deeprep
 * does: "23% of 41,250 games", put in front of whatever comment the move already has
 * (repgen/shares.mjs). A share already there from an earlier run or from deeprep is
 * replaced, not doubled.
 *
 *   node tools/pgnshare.mjs sicilian.pgn                       -> sicilian.shares.pgn
 *   node tools/pgnshare.mjs sicilian.pgn --index lichess        the local index file
 *   node tools/pgnshare.mjs sicilian.pgn --explorer localhost:9337
 *   node tools/pgnshare.mjs sicilian.pgn --all --out sicilian.pgn
 *
 * Where it counts: Lichess's explorer by default (LICHESS_TOKEN or --token-file, --speeds,
 * --ratings as repgen's defaults, cached in repertoires/repgen-cache.jsonl); a served local
 * explorer (explorerdb serve) with --explorer; or an index file read directly with --index
 * (a bare name is looked up in explorer/, as deeprep does). The share is of all the games in
 * the position, and a move with none gets 0%.
 *
 * Only moves where the PGN branches are annotated: the alternatives the share is there to
 * compare. --all annotates every move.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parsePgn, writePgn } from './repgen/pgntree.mjs';
import { annotateShares } from './repgen/shares.mjs';
import { inPath, outPath, EXPLORER } from './repgen/paths.mjs';
import { createProviders, localAddress, localInfo, compactExplorer } from '../src/pe/providers.js';
import { createFileCache } from './repgen/filecache.mjs';
import { openFenced } from './explorerdb/fence.mjs';
import { explorerAnswer } from './explorerdb/store.mjs';

var USAGE = 'Usage: node tools/pgnshare.mjs <file.pgn> [--out <file.pgn>] [--all]\n' +
  '  [--index <name> | --explorer <address> | --token-file <file> --speeds blitz,rapid,classical\n' +
  '   --ratings 1600,1800,2000,2200,2500]';

var NEVER = function () { return false; };

function parse(argv) {
  var o = { all: false };
  var takes = { '--out': 'out', '--index': 'index', '--explorer': 'explorer', '--token-file': 'tokenFile',
    '--speeds': 'speeds', '--ratings': 'ratings' };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (takes[a]) {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      o[takes[a]] = argv[++i];
    } else if (a === '--all') o.all = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!o.input && !/^--/.test(a)) o.input = a;
    else throw new Error('Unexpected argument: ' + a);
  }
  if (o.index && o.explorer) throw new Error('--index or --explorer, not both');
  return o;
}

// lookup(fen) -> compactExplorer()'s shape, and a line saying where the counts come from.
async function source(o) {
  if (o.index) {
    var name = /\.xdb$/i.test(o.index) ? o.index : o.index + '.xdb';
    var file = inPath(name, EXPLORER);
    if (!fs.existsSync(file)) throw new Error('No index at ' + file);
    var db = openFenced(file, { log: function (s) { console.error(s); } });
    return {
      lookup: function (fen) { return Promise.resolve(compactExplorer(explorerAnswer(db, fen, -1))); },
      what: 'index ' + file + ' (' + db.meta.filter.speeds.join(',') + ', ' + db.meta.filter.ratings.join(',') + ')',
      close: function () { db.close(); }
    };
  }
  var stats = {}, local = null, token = '';
  var filter = {
    speeds: String(o.speeds || 'blitz,rapid,classical').split(',').filter(Boolean),
    ratings: String(o.ratings || '1600,1800,2000,2200,2500').split(',').filter(Boolean).map(Number)
  };
  if (o.explorer) {
    local = localAddress(o.explorer);
    var info = await localInfo(fetch, local);
    filter = info.filter;
  } else {
    token = o.tokenFile ? fs.readFileSync(String(o.tokenFile), 'utf8').trim()
      : String(process.env.LICHESS_TOKEN || '').trim();
    if (!token) {
      throw new Error('No Lichess token. Create one at https://lichess.org/account/oauth/token ' +
        '(no scopes needed) and set LICHESS_TOKEN, pass --token-file, or use --index / --explorer.');
    }
  }
  var cachePath = outPath('repgen-cache.jsonl');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  var p = createProviders({ fetch: fetch, cache: createFileCache(cachePath), stats: stats,
    getToken: function () { return Promise.resolve(token); }, localExplorer: local || '' });
  return {
    lookup: function (fen) { return p.explorer(fen, filter, NEVER, { priority: 100 }); },
    what: (local ? 'local explorer ' + local : 'Lichess') + ' (' + filter.speeds.join(',') + ', ' +
      filter.ratings.join(',') + ')',
    stats: stats,
    close: function () {}
  };
}

async function main(argv) {
  var o = parse(argv);
  if (o.help) { console.log(USAGE); return 0; }
  if (!o.input) throw new Error('Which PGN? ' + USAGE);
  var input = inPath(o.input);
  var out = o.out ? outPath(o.out) : input.replace(/(\.pgn)?$/i, '.shares.pgn');
  var games = parsePgn(fs.readFileSync(input, 'utf8'));
  if (!games.length) throw new Error('No game found in ' + input);

  var src = await source(o);
  console.log('Counting from ' + src.what + '.');
  var t = Date.now(), last = 0;
  try {
    var r = await annotateShares(games, src.lookup, { all: o.all, progress: function (i, n) {
      if (Date.now() - last > 5000 || i === n) {
        last = Date.now();
        console.error('  ' + i + ' / ' + n + ' positions');
      }
    } });
  } finally {
    src.close();
  }
  console.log(r.moves + ' moves annotated from ' + r.positions + ' positions in ' +
    ((Date.now() - t) / 1000).toFixed(1) + ' s' +
    (src.stats ? ', ' + (src.stats.explorerRequests || 0) + ' Lichess requests' : '') + '.' +
    (r.empty ? ' ' + r.empty + ' left alone: no games reach their position.' : ''));
  fs.writeFileSync(out, writePgn(games));
  console.log('Wrote ' + out);
  return 0;
}

main(process.argv.slice(2)).then(function (code) { process.exit(code); }, function (e) {
  console.error('pgnshare: ' + (e && e.message === 'no-token' ? 'no Lichess token'
    : e && e.status === 401 ? 'Lichess rejected the token (401)'
    : e && e.message || e));
  process.exit(1);
});
