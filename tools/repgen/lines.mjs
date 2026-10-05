/*
 * --moves as a tree of lines, variations and all:
 *
 *   1. d4 c5 2. dxc5 Nf6 3. Nf3 (3. Nc3 e6) (3. c4 Na6) (3. c3) Na6
 *
 * The moves up to the first variation are the run's prefix, as a single line always was:
 * the run starts where they end. From there the tree is *given*. At each of its positions
 * with a move after it, only the moves it gives are played: their replies are those and no
 * others, whatever the games say, and my move is that one, unsearched. Where a branch ends,
 * the run carries on as usual, with the line's real reach (the given replies' shares of the
 * games), so (3. c3) has my move after 3.c3 searched as usual. A plain line has no
 * given positions, and runs exactly as before.
 *
 * Pure apart from chess.js (through pgntree.mjs), so test/repgen.js covers it.
 */

import { parsePgn, pathOf } from './pgntree.mjs';
import { fenKey, sideToMove } from '../../src/pe/search.js';

/*
 * { fen, prefix, tree }: the position the run starts from, the moves to it, and the node
 * there (pgntree's), whose subtree givenOf() turns into the given positions.
 */
export function readMoves(text, startFen) {
  var games;
  try {
    games = parsePgn('[FEN "' + startFen + '"]\n' + String(text));
  } catch (e) {
    throw new Error('--moves: ' + (e && e.message || e));
  }
  if (!games.length) throw new Error('--moves has no moves');
  var n = games[0].root;
  var prefix = [];
  while (n.children.length === 1) {
    n = n.children[0];
    prefix.push(n.san);
  }
  return { fen: n.fen, prefix: prefix, tree: n };
}

/*
 * The given positions below `tree`: { fenKey: [SAN, ...] }, in the order the moves were
 * written. Two branches can reach one position: their moves are pooled. My positions take
 * one move each, so two moves of mine at one position are an error.
 */
export function givenOf(tree, side) {
  var given = {};
  function walk(n) {
    if (!n.children.length) return;
    var key = fenKey(n.fen);
    var sans = given[key] || (given[key] = []);
    n.children.forEach(function (c) { if (sans.indexOf(c.san) < 0) sans.push(c.san); });
    if (sideToMove(n.fen) === side && sans.length > 1) {
      var path = pathOf(n).map(function (x) { return x.san; });
      throw new Error('--moves gives more than one move of yours ' +
        (path.length ? 'after ' + path.join(' ') : 'at the start') + ': ' + sans.join(', ') +
        '. Only the opponent\'s moves can branch.');
    }
    n.children.forEach(walk);
  }
  walk(tree);
  return given;
}

// Whether two given maps are the same lines, whatever order they were written in.
export function sameGiven(a, b) {
  function canon(g) {
    return JSON.stringify(Object.keys(g || {}).sort().map(function (k) {
      return [k, g[k].slice().sort()];
    }));
  }
  return canon(a) === canon(b);
}
