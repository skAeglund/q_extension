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
import { Chess } from '../../src/vendor/chess.js';
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

/*
 * A base repertoire (build --base, 2026-11-24): the owner's own file, extended rather than
 * known. Returns { games, moves: Map(key -> SAN, my first move in each position of mine),
 * replies: Map(key -> [SAN], their replies in each of theirs), positions: Set(key), prefix:
 * [SAN] (the moves from the start while the file has only one) }.
 */
export function baseFromPgn(text, side) {
  var games = parsePgn(text);
  if (games.length !== 1) throw new Error('A base PGN holds one game (it has ' + games.length + ').');
  var moves = new Map(), replies = new Map(), positions = new Set(), continuing = new Map();
  (function walk(n) {
    var k = String(keyOf(n.fen));
    positions.add(k);
    if (n.children.length) {
      // Where the file goes on from this position: its own move order, kept by toTree().
      if (!continuing.has(k)) continuing.set(k, pathOf(n).map(function (x) { return x.san; }));
      if (turn(n.fen) === side) { if (!moves.has(k)) moves.set(k, n.children[0].san); }
      else {
        var r = replies.get(k) || [];
        n.children.forEach(function (c) { if (!r.some(function (s) { return moveKey(s) === moveKey(c.san); })) r.push(c.san); });
        replies.set(k, r);
      }
    }
    n.children.forEach(walk);
  })(games[0].root);
  var prefix = [];
  for (var n = games[0].root; n.children.length === 1; n = n.children[0]) prefix.push(n.children[0].san);
  return { games: games, moves: moves, replies: replies, positions: positions, continuing: continuing, prefix: prefix };
}

// baseFromPgn()'s continuing positions as toTree()'s opts.fixed: paths from the build's root
// (after `prefix`), for the positions the file goes on from at or past the root.
export function baseFixed(base, prefix) {
  var fixed = new Map();
  prefix = prefix || [];
  base.continuing.forEach(function (p, k) {
    if (p.length < prefix.length) return;
    for (var i = 0; i < prefix.length; i++) if (moveKey(p[i]) !== moveKey(prefix[i])) return;
    fixed.set(k, p.slice(prefix.length));
  });
  return fixed;
}

/*
 * The base's game with the build's tree (build.mjs toTree(), rooted after `prefix`) grafted
 * on: the owner's moves and comments stay as they are; a move the build adds comes with its
 * note; at a line end of the base the build doesn't carry on, its plan and "transposes to"
 * notes are appended to the owner's comment. Returns the games for pgntree's writePgn().
 */
export function mergeBase(base, tree, prefix) {
  var g = base.games[0];
  var b = g.root;
  (prefix || []).forEach(function (san) {
    var c = b.children.find(function (x) { return moveKey(x.san) === moveKey(san); });
    if (!c) throw new Error('The base has no ' + san + ' where the build starts.');
    b = c;
  });
  function convert(parent, k) {
    var c = new Chess(parent.fen);
    var mv = c.move(k.san);
    var node = { san: mv.san, suffix: '', nags: [], comment: k.note || null, pre: null, children: [], parent: parent, fen: c.fen() };
    (k.children || []).forEach(function (x) { node.children.push(convert(node, x)); });
    return node;
  }
  function graft(bn, tn) {
    (tn.children || []).forEach(function (k) {
      var bc = bn.children.find(function (x) { return moveKey(x.san) === moveKey(k.san); });
      if (!bc) { bn.children.push(convert(bn, k)); return; }
      if (!bc.children.length && !(k.children || []).length) {
        var add = String(k.note || '').split(' · ').filter(function (p) { return /^transposes to /.test(p) || /^\(\d+\./.test(p); });
        if (add.length) bc.comment = (bc.comment ? bc.comment + ' ' : '') + add.join(' ');
      }
      graft(bc, k);
    });
  }
  graft(b, tree);
  return base.games;
}
