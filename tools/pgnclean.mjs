#!/usr/bin/env node
/*
 * pgnclean - finishes a repertoire PGN from repgen for keeping: comments down to the
 * played share, and transposing branches folded into comments (repgen/clean.mjs).
 *
 *   node tools/pgnclean.mjs sicilian.pgn                   -> sicilian.clean.pgn
 *   node tools/pgnclean.mjs sicilian.pgn --out final.pgn --side white
 *
 * Works on any PGN, including one edited or exported from Qchess: transpositions are
 * found by replaying the moves, not from repgen's comments. The side comes from repgen's
 * headers (White/Black "Repertoire"); --side is needed for any other PGN.
 *
 * A bare input name that isn't in the current directory is looked up in repertoires/, and a
 * bare --out name is written there (repgen/paths.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parsePgn, writePgn } from './repgen/pgntree.mjs';
import { cleanGame, sideOfHeaders } from './repgen/clean.mjs';
import { inPath, outPath } from './repgen/paths.mjs';

function main(argv) {
  var input = null, out = null, side = null;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--side') side = String(argv[++i] || '').toLowerCase();
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/pgnclean.mjs <file.pgn> [--out <file.pgn>] [--side white|black]');
      return 0;
    } else if (!input && !/^--/.test(a)) input = a;
    else throw new Error('Unexpected argument: ' + a);
  }
  if (!input) throw new Error('Which PGN? Usage: node tools/pgnclean.mjs <file.pgn>');
  if (side) {
    side = { w: 'w', white: 'w', b: 'b', black: 'b' }[side];
    if (!side) throw new Error('--side is white or black');
  }
  input = inPath(input);
  out = out ? outPath(out) : input.replace(/(\.pgn)?$/i, '.clean.pgn');
  if (path.resolve(out) === path.resolve(input)) {
    throw new Error('--out is the input file; write the cleaned PGN somewhere else.');
  }

  var games = parsePgn(fs.readFileSync(input, 'utf8'));
  if (!games.length) throw new Error('No game found in ' + input);
  games.forEach(function (g, gi) {
    var s = side || sideOfHeaders(g.headers);
    if (!s) throw new Error('Game ' + (gi + 1) + ': which side is the repertoire for? Pass --side.');
    var r = cleanGame(g, s);
    console.log((games.length > 1 ? 'Game ' + (gi + 1) + ': ' : '') + r.removed +
      ' transposing repl' + (r.removed === 1 ? 'y' : 'ies') + ' folded into comments, ' +
      r.marked + ' of your moves marked as transposing.');
    r.notes.forEach(function (n) { console.log('  ' + n); });
  });
  fs.writeFileSync(out, writePgn(games));
  console.log('Wrote ' + out);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  console.error('pgnclean: ' + (e && e.message || e));
  process.exit(1);
}
