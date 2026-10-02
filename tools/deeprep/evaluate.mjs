/*
 * deeprep eval: what a repertoire scores against the games of an index, as a fixed policy.
 *
 * At my move the repertoire's move is played; at theirs every reply counts, by how often it
 * is played, and the line goes on where a reply leads to a position the repertoire has a
 * move for (a transposition included). Everything else is a leaf at the score of its own
 * games: a reply the repertoire doesn't prepare for ("out of book"), the replies after my
 * last move on a line ("line end"), and games that end in the repertoire. No maximum is
 * taken anywhere, so on games the repertoire wasn't chosen with (a holdout index: other
 * months) this is an unbiased estimate of what it scores against that player pool. On the
 * index it was chosen with, it carries the same optimism as the deep scores did.
 *
 * Positions are walked ply by ply from the root (a transposition arrives at the same ply,
 * so its reach is summed before it goes on), then valued from the last ply back.
 *
 * Pure apart from db.records(key); chess.js public API throughout, since a repertoire has
 * thousands of positions, not millions.
 */

import { Chess } from '../../src/vendor/chess.js';
import { CUT, ENDED, keyOf, codeParts, fullFen } from '../explorerdb/games.mjs';
import { parsePgn } from '../repgen/pgntree.mjs';
import { leafStat } from './search.mjs';

var STANDARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function turn(fen) { return String(fen).split(/\s+/)[1] === 'b' ? 'b' : 'w'; }

/*
 * A repertoire from PGN text: { side, root, moves: Map(key -> { san, fen }), conflicts,
 * alternatives }. `moves` holds my move in each position of mine the PGN plays from (its
 * first move there: the main line's). A position reached twice with two different moves
 * of mine keeps the first (`conflicts` counts them); a second move of mine in the same
 * place, a variation, is left out (`alternatives`).
 *
 * side: 'w' | 'b', or null to read it from the headers (repgen's names the side
 * "Repertoire"; deeprep's Event says "for White"/"for Black"). root: the position the
 * evaluation starts from: the end of the first game's opening run of single moves (the
 * --moves of the run that made it), unless o.root gives one.
 */
export function repertoireFromPgn(text, o) {
  o = o || {};
  var games = parsePgn(text);
  if (!games.length) throw new Error('No game in the PGN.');
  var side = o.side || sideFromHeaders(games[0].headers);
  if (!side) throw new Error('Which side is the repertoire for? Give --side white|black.');
  var moves = new Map(), conflicts = 0, alternatives = 0;
  games.forEach(function (g) {
    (function walk(n) {
      if (n.children.length && turn(n.fen) === side) {
        var k = keyOf(n.fen), had = moves.get(k);
        if (!had) moves.set(k, { san: n.children[0].san, fen: n.fen });
        else if (had.san !== n.children[0].san) conflicts++;
        alternatives += n.children.length - 1;
      }
      n.children.forEach(walk);
    })(g.root);
  });
  var root = o.root, prefix = null;
  if (!root) {
    var n = games[0].root;
    prefix = [];
    while (n.children.length === 1) { n = n.children[0]; prefix.push(n.san); }
    root = n.fen;
  }
  // prefix: the moves from the PGN's start to the root, when the root was found that way.
  return { side: side, root: root, start: games[0].root.fen, prefix: prefix, moves: moves,
    conflicts: conflicts, alternatives: alternatives };
}

function sideFromHeaders(hs) {
  var h = {};
  hs.forEach(function (x) { h[x[0]] = x[1]; });
  if (h.White === 'Repertoire') return 'w';
  if (h.Black === 'Repertoire') return 'b';
  var m = /for (White|Black)/.exec(h.Event || '');
  return m ? (m[1] === 'White' ? 'w' : 'b') : null;
}

function sumRecs(recs) {
  var s = { moves: [], ended: null, cut: null, total: 0, w: 0, d: 0, b: 0 };
  recs.forEach(function (r) {
    var x = { code: r.code, w: r.white, d: r.draws, b: r.black, n: r.white + r.draws + r.black };
    s.total += x.n; s.w += x.w; s.d += x.d; s.b += x.b;
    if (r.code === CUT) s.cut = x;
    else if (r.code === ENDED) s.ended = x;
    else s.moves.push(x);
  });
  s.moves.sort(function (a, b) { return b.n - a.n || a.code - b.code; });
  return s;
}

function play(fen, code) {
  var p = codeParts(code);
  var c = new Chess(fullFen(fen));
  try {
    var mo = c.move({ from: p.from, to: p.to, promotion: p.promotion });
    return { fen: c.fen(), san: mo.san };
  } catch (e) {
    return null;
  }
}

function codeOfSan(fen, san) {
  var c = new Chess(fullFen(fen));
  var mo;
  try { mo = c.move(san); } catch (e) { return null; }
  var sq = function (s) { return 'abcdefgh'.indexOf(s[0]) + 8 * (Number(s[1]) - 1); };
  return { code: sq(mo.from) + 64 * sq(mo.to) + 4096 * (mo.promotion ? ' nbrq'.indexOf(mo.promotion) : 0),
    fen: c.fen(), san: mo.san };
}

/*
 * The repertoire's score on `db`. rep: repertoireFromPgn()'s, or any { side, root, moves:
 * Map(key -> { san }) }. o: { minGames (50: an alternative of mine counts in `weak` only
 * with this many games), minReach (0.005: what `weak` and `unprepared` list), maxPly (200) }.
 *
 * Returns {
 *   s, se, games          the repertoire's expected score for its side, from the root
 *   raw                   the root's own score: what everyone in the index scored from there
 *   cards                 positions of mine the walk reached (moves to know), and `unreached`
 *   ends                  shares of the games (by reach): out (an unprepared reply), end (my
 *                         line ran out), over (the game ended inside the repertoire)
 *   first                 the opponent's first decision: each reply's share, the
 *                         repertoire's score after it and what people scored after it
 *   weak                  my moves whose own games score clearly under another move's
 *                         there, or under the position's average, by reach x gap
 *   unprepared            replies left out of a prepared position, by reach
 *   unseen                my moves the index has no games for (the line ends there)
 * }
 */
export function evaluateRepertoire(db, rep, o) {
  o = Object.assign({ minGames: 50, minReach: 0.005, maxPly: 200 }, o || {});
  var me = rep.side;
  var stat = function (x) { return leafStat(x.w, x.d, x.b, me); };
  var nodes = new Map();       // key -> node
  var level = new Map();
  var rootKey = keyOf(rep.root);
  level.set(rootKey, { key: rootKey, fen: rep.root, reach: 1, path: [] });
  var ends = { out: 0, end: 0, over: 0 };
  var order = [];              // levels, for valuing back from the last
  var unprepared = [], unseen = [];

  for (var ply = 0; level.size && ply < o.maxPly; ply++) {
    var next = new Map();
    order.push([]);
    level.forEach(function (n) {
      if (nodes.has(n.key)) return;          // a repetition of an earlier position
      nodes.set(n.key, n);
      order[order.length - 1].push(n);
      var a = sumRecs(db.records(n.key));
      n.a = a;
      n.mine = turn(n.fen) === me;
      n.kids = [];
      function go(code, rec, share) {
        var p = play(n.fen, code);
        if (!p) return null;
        var k = keyOf(p.fen);
        var kid = { key: k, san: p.san, rec: rec, share: share };
        n.kids.push(kid);
        var m = next.get(k);
        if (m) m.reach += n.reach * share;
        else next.set(k, { key: k, fen: p.fen, reach: n.reach * share, path: n.path.concat(p.san), via: rec });
        return kid;
      }
      if (n.mine) {
        var r = rep.moves.get(n.key);
        if (!r) {
          // Only the root can be a position of mine the repertoire has no move for.
          n.leaf = true;
          ends.out += n.reach;
          return;
        }
        var cs = codeOfSan(n.fen, r.san);
        var rec = cs && a.moves.find(function (x) { return x.code === cs.code; });
        if (!cs || !rec) {
          n.leaf = true;
          n.unseen = r.san;
          ends.end += n.reach;
          unseen.push({ path: n.path, san: r.san, reach: n.reach });
          return;
        }
        n.move = r.san;
        go(cs.code, rec, 1);
        return;
      }
      if (!a.total) { n.leaf = true; ends.end += n.reach; return; }
      // Their move: a reply goes on if the repertoire has a move in the position it leads to.
      var prepared = false, left = [];
      a.moves.forEach(function (x) {
        var p = play(n.fen, x.code);
        if (p && rep.moves.has(keyOf(p.fen))) { prepared = true; go(x.code, x, x.n / a.total); }
        else left.push({ x: x, san: p ? p.san : '?' });
      });
      left.forEach(function (l) {
        var share = l.x.n / a.total;
        if (prepared) {
          ends.out += n.reach * share;
          if (n.reach * share >= o.minReach) {
            unprepared.push({ path: n.path, san: l.san, reach: n.reach * share, share: share,
              games: l.x.n, score: stat(l.x).s });
          }
        } else {
          ends.end += n.reach * share;
        }
      });
      n.leaves = left.map(function (l) { return l.x; });
      [a.ended, a.cut].forEach(function (x) {
        if (!x) return;
        n.leaves.push(x);
        ends.over += n.reach * x.n / a.total;
      });
    });
    level = next;
  }

  // Values, from the last ply back. An unvalued kid (a repetition) counts at its own games.
  for (var i = order.length - 1; i >= 0; i--) {
    order[i].forEach(function (n) {
      var a = n.a;
      n.raw = a.total ? leafStat(a.w, a.d, a.b, me) : null;
      if (n.leaf || !a.total) {
        // A position the index doesn't keep: the games of the move that led here.
        n.v = n.raw || (n.via ? stat(n.via) : { s: NaN, se: Infinity, n: 0 });
        return;
      }
      var kidV = function (k) {
        var m = nodes.get(k.key);
        return m && m.v ? m.v : stat(k.rec);
      };
      if (n.mine) {
        var v = kidV(n.kids[0]);
        n.v = { s: v.s, se: v.se, n: a.total };
        return;
      }
      var sw = 0, ss = 0, sv = 0;
      var add = function (w, v) { sw += w; ss += w * v.s; sv += w * w * v.se * v.se; };
      n.kids.forEach(function (k) { add(k.rec.n, kidV(k)); });
      n.leaves.forEach(function (x) { add(x.n, stat(x)); });
      n.v = { s: ss / sw, se: Math.sqrt(sv) / sw, n: a.total };
    });
  }

  var root = nodes.get(rootKey);
  var cards = 0;
  var weak = [];
  nodes.forEach(function (n) {
    if (!n.mine || n.leaf || !n.move) return;
    cards++;
    if (n.reach < o.minReach) return;
    // My move's own games against my other moves' here, and against the position's.
    var mineRec = n.kids[0].rec;
    var own = stat(mineRec);
    var best = null;
    n.a.moves.forEach(function (x) {
      if (x === mineRec || x.n < o.minGames) return;
      var s = stat(x);
      if (!best || s.s > best.s.s) best = { x: x, s: s };
    });
    var bp = best && play(n.fen, best.x.code);
    var bestSan = bp ? bp.san : null;
    var gap = Math.max(best ? best.s.s - own.s : 0, n.raw.s - n.v.s);
    if (gap > 0.03) {
      weak.push({ path: n.path, san: n.move, reach: n.reach, games: mineRec.n, own: own.s, value: n.v.s,
        avg: n.raw.s, alt: bestSan, altScore: best ? best.s.s : null, altGames: best ? best.x.n : 0, gap: gap });
    }
  });
  weak.sort(function (x, y) { return y.reach * y.gap - x.reach * x.gap; });
  unprepared.sort(function (x, y) { return y.reach - x.reach; });
  var unreached = 0;
  rep.moves.forEach(function (_, k) { if (!nodes.has(k)) unreached++; });

  // The opponent's first decision on the way: the root, or after my move from it.
  var first = [];
  var fd = root;
  while (fd && fd.mine && !fd.leaf && fd.kids.length) fd = nodes.get(fd.kids[0].key);
  if (fd && !fd.mine && fd.a && fd.a.total) {
    fd.kids.forEach(function (k) {
      var m = nodes.get(k.key);
      first.push({ san: k.san, share: k.share, games: k.rec.n, s: m && m.v ? m.v.s : stat(k.rec).s,
        raw: stat(k.rec).s });
    });
    var others = fd.leaves.filter(function (x) { return x.code !== ENDED && x.code !== CUT; });
    if (others.length) {
      var w = 0, s = 0, g = 0;
      others.forEach(function (x) { var t = stat(x); w += x.n; s += x.n * t.s; g += x.n; });
      first.push({ san: null, share: g / fd.a.total, games: g, s: s / w, raw: s / w });
    }
  }

  return {
    side: me, root: rep.root,
    s: root && root.v ? root.v.s : NaN, se: root && root.v ? root.v.se : Infinity,
    games: root && root.a ? root.a.total : 0, raw: root && root.raw ? root.raw.s : NaN,
    cards: cards, unreached: unreached, positions: nodes.size,
    ends: ends, first: first, weak: weak, unprepared: unprepared, unseen: unseen
  };
}

export { STANDARD };
