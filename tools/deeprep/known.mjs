/*
 * deeprep: repertoires the user already knows (build --known, eval --known).
 *
 * Asked 2026-11-22: White sidelines after 1.Nc3 (1...Nf6 2.d4, 1...e6 2.d4, ...) should
 * transpose into the user's Jobava London where they can, and play its kind of moves
 * elsewhere. A build only knew its own positions, so it got no credit for joining the Jobava
 * and decided the Jobava positions it reached all over again. A known PGN changes three
 * things in build.mjs, and nothing in how candidates are valued:
 *
 *   - every position in it counts as learned: a move into it costs nothing new;
 *   - every move of mine in it seeds the recurring-move discount (`theme`);
 *   - a position in it ends the build's line there (end `known`), with a note saying which
 *     of its lines it joins.
 *
 * "Every position" is every node of every game, the side to move either way: the main
 * line's, a variation's (an alternative move of mine included) and a line's last one. The
 * files can be deeprep's own, pgnclean's, or Lichess study exports (several chapters, share
 * comments, transposition notes): only the moves are read. A transposition pgnclean cut
 * ("Nf6 transposes into ...") lands on a position that is in the file anyway.
 */

import path from 'node:path';
import { parsePgn, pathOf } from '../repgen/pgntree.mjs';
import { keyOf } from '../explorerdb/games.mjs';
import { moveKey } from '../../src/pe/search.js';
import { lineText } from './pgn.mjs';

function turn(fen) { return String(fen).split(/\s+/)[1] === 'b' ? 'b' : 'w'; }

function headerOf(g, k) {
  for (var i = 0; i < g.headers.length; i++) if (g.headers[i][0] === k) return g.headers[i][1];
  return null;
}

// "repertoires/1. Nc3 - Jobava simplified6.pgn" -> "1. Nc3 - Jobava simplified6"
export function knownName(file) {
  return path.basename(String(file)).replace(/\.pgn$/i, '');
}

/*
 * One known PGN. o = { side: 'w' | 'b' (the build's), name }. Returns {
 *   name, games
 *   positions  Map(position key as a string -> { line, name }): every position, with the
 *              shortest line to it from its game's start (numbered SAN), and the name it is
 *              shown under: the file's, plus the chapter's when the file has several
 *   mine       [{ key, fen, san }]: every move of mine, alternatives included, once each
 *   first      Map(key -> { san, fen }): my first move in each position of mine (the main
 *              line's), as evaluate.mjs plays a repertoire
 * }
 */
export function knownFromPgn(text, o) {
  var side = o.side;
  var games = parsePgn(text);
  if (!games.length) throw new Error('No game in the known PGN ' + o.name + '.');
  var positions = new Map(), mine = [], seen = new Set(), first = new Map();
  var plies = new Map();
  games.forEach(function (g) {
    var chapter = headerOf(g, 'ChapterName');
    var name = games.length > 1 && chapter ? o.name + ', ' + chapter : o.name;
    (function walk(n) {
      var k = String(keyOf(n.fen));
      var sans = pathOf(n).map(function (x) { return x.san; });
      if (!positions.has(k) || sans.length < plies.get(k)) {
        positions.set(k, { line: lineText(g.root.fen, sans), name: name });
        plies.set(k, sans.length);
      }
      if (n.children.length && turn(n.fen) === side) {
        if (!first.has(k)) first.set(k, { san: n.children[0].san, fen: n.fen });
        n.children.forEach(function (c) {
          var mk = k + '|' + moveKey(c.san);
          if (seen.has(mk)) return;
          seen.add(mk);
          mine.push({ key: k, fen: n.fen, san: c.san });
        });
      }
      n.children.forEach(walk);
    })(g.root);
  });
  return { name: o.name, games: games.length, positions: positions, mine: mine, first: first };
}

/*
 * Several known repertoires as one: the first file to have a position names it, and plays
 * the first move there. Returns { names, positions, mine, first } (knownFromPgn's shapes).
 */
export function mergeKnown(list) {
  var out = { names: [], positions: new Map(), mine: [], first: new Map() };
  var seen = new Set();
  list.forEach(function (k) {
    out.names.push(k.name);
    k.positions.forEach(function (v, key) { if (!out.positions.has(key)) out.positions.set(key, v); });
    k.first.forEach(function (v, key) { if (!out.first.has(key)) out.first.set(key, v); });
    k.mine.forEach(function (m) {
      var mk = m.key + '|' + moveKey(m.san);
      if (!seen.has(mk)) { seen.add(mk); out.mine.push(m); }
    });
  });
  return out;
}

/*
 * A repertoire's moves (evaluate.mjs's Map(BigInt key -> { san, fen })) with the known
 * repertoire's added where it has none, marked `known`, so a reply that transposes into the
 * known tree is followed there. Returns a new Map.
 */
export function withKnown(moves, known) {
  var m = new Map(moves);
  if (known) {
    known.first.forEach(function (v, key) {
      var k = BigInt(key);
      if (!m.has(k)) m.set(k, { san: v.san, fen: v.fen, known: true });
    });
  }
  return m;
}
