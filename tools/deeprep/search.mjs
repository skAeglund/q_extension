/*
 * deeprep: the deep score of a position, from the local explorer index alone.
 *
 * A position's W/D/B in the index are the final results of every game that passed through
 * it, so a score at ply 16 doesn't measure anything later than one at ply 12. What a deeper
 * horizon changes is how many of my own decisions are optimised along the way. The value
 * is an expectimax over the games:
 *
 *   - my move:        the best of my moves with at least `minGames` games (by score);
 *   - their move:     the average of their replies, weighted by how often each is played,
 *                     with games that ended or were cut off there as leaves of their own;
 *   - a leaf:         the score of the games through it. That is a node `plies` from the
 *                     root, one reached by fewer than `minGames` games, or one where none
 *                     of my moves has that many.
 *
 * A reply under `minGames` is a leaf too, and needs no lookup: the parent's record for that
 * move already holds its results. Values are memoised by (position, plies left), so a
 * transposition is searched once per depth.
 *
 * Score is (W + D/2) / games for `side`. Each value also carries a standard error: a
 * leaf's from its own W/D/L (with one pseudo-win and one pseudo-loss, so 3 games of 3 wins
 * don't claim certainty), their move's as sqrt(sum share^2 SE^2), mine as the chosen
 * move's.
 *
 * Two corrections, both on by default since 2026-10-02 (`prior` 0 and `risk` 0 give the
 * plain expectimax above):
 *
 *   - Shrinkage (`prior`, in games). Taking the best of several noisy scores picks luck as
 *     well as good moves, at every one of my moves on the way down: in the first real run
 *     (1.d4 c5 2.dxc5 e5, 16 plies) the chosen moves' deep scores stood 6 points above
 *     their raw ones, weighted by reach, and on an index of coin flips the best moves
 *     scored 56-62%. So at my move each candidate's value is pulled towards the
 *     position's own score by `prior` games' worth, as an empirical-Bayes estimate:
 *     v' = mu + w (v - mu), w = n / (n + prior), where n = var / SE^2 is the games' worth
 *     of the value (var: the variance of one game's result here). A move with 8,000 games
 *     keeps its value; one with 60 keeps a quarter of its lead at prior 200. The
 *     opponent's replies under `minGames` (leaves) are pulled the same way. `fit` measures
 *     a prior for an index (fitPrior): var / tau^2, tau being the spread of the
 *     candidates' true scores around their position's.
 *   - Risk aversion (`risk`, lambda per win% point). Their move takes riskMean() (as the
 *     Practical column and repgen do) instead of the plain mean, so a position whose
 *     common reply is sound and whose tail is blunders is worth less than its mean.
 *
 * A shrunk value keeps the SE of its games, not the posterior's: a value pulled once is
 * pulled again at each of my moves above it, each time by how noisy its games are. The
 * bias of the max is still not in the SE, which is why the candidates show `lb` = score -
 * z * SE beside the score, and the tree keeps the move with the best lower bound when it
 * isn't the best scoring one.
 *
 * The walk plays moves on one chess.js board with _makeMove/_undoMove and reads the
 * position's key from its incremental Zobrist hash (as the import does, games.mjs), with
 * the en-passant square normalised by legalEp(). chess.js's public move() would be ~30x
 * slower. Pure apart from `db.records(key)`, so the tests run it on a small index.
 */

import { Chess } from '../../src/vendor/chess.js';
import { riskMean } from '../../src/pe/search.js';
import { CUT, ENDED, legalEp, fullFen, codeParts } from '../explorerdb/games.mjs';

export var DEFAULTS = {
  plies: 16,          // horizon, in plies from the root
  minGames: 50,       // a position or move with fewer games is a leaf
  z: 1,               // lb = score - z * SE
  myMoves: 0,         // consider only my N most played moves (0: all with minGames)
  maxLookups: 20e6,   // give up past this many index lookups
  prior: 200,         // shrinkage: games' worth of the position's own score in each of my
                      // candidates' values (0: none). `fit` measures it for an index.
  risk: 0.05          // risk aversion at their moves, lambda per win% point (0: plain mean)
};

var SQ = {};
'abcdefgh'.split('').forEach(function (f, i) {
  for (var r = 1; r <= 8; r++) SQ[f + r] = i + 16 * (8 - r);   // chess.js's 0x88 squares
});

function moveCode(mo) {
  var f = (mo.from & 7) + 8 * (7 - (mo.from >> 4)), t = (mo.to & 7) + 8 * (7 - (mo.to >> 4));
  return f + 64 * t + 4096 * (mo.promotion ? ' nbrq'.indexOf(mo.promotion) : 0);
}

// Score and SE for `me` ('w' or 'b') of games won by White, drawn, won by Black.
export function leafStat(w, d, b, me) {
  var n = w + d + b;
  var mine = me === 'w' ? w : b;
  if (!n) return { s: NaN, se: Infinity, n: 0 };
  var s = (mine + d / 2) / n;
  var n2 = n + 2;
  var m2 = (mine + 1 + d / 2) / n2;
  var e2 = (mine + 1 + d / 4) / n2;
  var v = Math.max(e2 - m2 * m2, 0);
  return { s: s, se: Math.sqrt(v / n), n: n };
}

/*
 * Pulls a value towards `mu` by `prior` games' worth: the empirical-Bayes posterior mean
 * when values spread around mu with variance tau^2 = vr / prior, and one game's result
 * has variance vr. A value's games' worth is vr / SE^2. The SE is left as it was (see
 * the top of the file).
 */
export function shrink(v, mu, vr, prior) {
  if (!(prior > 0) || !isFinite(mu)) return v;
  var w = shrinkWeight(v.se, vr, prior);
  return { s: mu + w * (v.s - mu), se: v.se, n: v.n };
}

// The share of its distance from mu a value keeps: its games' worth over that plus the prior.
export function shrinkWeight(se, vr, prior) {
  if (!(prior > 0)) return 1;
  var n = se > 0 && isFinite(se) ? vr / (se * se) : (se === 0 ? Infinity : 0);
  return n === Infinity ? 1 : n / (n + prior);
}

// One game's variance for `me`, from a leafStat: SE^2 x games (with its pseudo-games).
function varOf(st) { return st.n > 0 && isFinite(st.se) ? st.se * st.se * st.n : 0.25; }

// A position's records -> { moves: [{code, w, d, b, n}] most played first, ended, cut, total }.
function sortRecords(recs) {
  var moves = [], ended = null, cut = null, total = 0;
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    var x = { code: r.code, w: r.white, d: r.draws, b: r.black, n: r.white + r.draws + r.black };
    total += x.n;
    if (r.code === CUT) cut = x;
    else if (r.code === ENDED) ended = x;
    else moves.push(x);
  }
  moves.sort(function (a, b) { return b.n - a.n || a.code - b.code; });
  return { moves: moves, ended: ended, cut: cut, total: total };
}

function sumOf(a) {
  var w = 0, d = 0, b = 0;
  a.moves.forEach(function (m) { w += m.w; d += m.d; b += m.b; });
  [a.ended, a.cut].forEach(function (m) { if (m) { w += m.w; d += m.d; b += m.b; } });
  return { w: w, d: d, b: b };
}

/*
 * A search rooted at `fen`. o: DEFAULTS plus { side: 'w' | 'b' (default: the side to move),
 * progress({lookups, nodes, ms}) every few seconds, memo (a Map from an earlier search with
 * the same side and options) }.
 *
 * Returns { side, value(), candidates(), tree(t), stats() }, all about the root; `tree`
 * builds the output (see there).
 */
export function createSearch(db, fen, o) {
  o = Object.assign({}, DEFAULTS, o || {});
  var c = new Chess(fullFen(fen));
  if (c._epSquare !== -1) legalEp(c);
  var me = o.side || c.turn();
  // hash -> [plies left] -> { s, se, n }. Shared between searches (browse) when given: a
  // value depends on the position, plies left, side and options, never on the root.
  var memo = o.memo || new Map();
  var lookups = 0, nodes = 0, t0 = Date.now(), lastTick = t0;

  function lookup() {
    lookups++;
    if (lookups > o.maxLookups) {
      throw new Error('The search passed ' + o.maxLookups + ' lookups. Raise --min-games, lower ' +
        '--plies, or limit --my-moves; --max-lookups raises the limit.');
    }
    if (o.progress && (lookups & 4095) === 0 && Date.now() - lastTick > 3000) {
      lastTick = Date.now();
      o.progress({ lookups: lookups, nodes: nodes, ms: lastTick - t0 });
    }
    return sortRecords(db.records(c._hash));
  }

  function play(code) {
    var ms = c._moves({ legal: false });
    for (var i = 0; i < ms.length; i++) {
      if (moveCode(ms[i]) === code) {
        c._makeMove(ms[i]);
        if (c._epSquare !== -1) legalEp(c);
        return ms[i];
      }
    }
    return null;                              // a hash collision's move; never in practice
  }

  function statOf(x) { return leafStat(x.w, x.d, x.b, me); }

  /*
   * Value of the position on the board, `left` plies from the horizon. `via` is the
   * record of the move that led here (its results stand in if the position isn't indexed).
   */
  function value(left, via) {
    var key = c._hash;
    var byLeft = memo.get(key);
    if (byLeft && byLeft[left]) return byLeft[left];
    var a = lookup();
    var r = evaluate(a, left, via);
    if (!byLeft) { byLeft = []; memo.set(key, byLeft); }
    byLeft[left] = r;
    nodes++;
    return r;
  }

  function evaluate(a, left, via) {
    if (!a.total) return via ? statOf(via) : { s: NaN, se: Infinity, n: 0 };
    var all = sumOf(a);
    var leaf = leafStat(all.w, all.d, all.b, me);
    if (left <= 0 || a.total < o.minGames) return leaf;
    var vr = varOf(leaf);
    if (c.turn() === me) {
      var best = null;
      mine(a).forEach(function (m) {
        if (!play(m.code)) return;
        var v = shrink(value(left - 1, m), leaf.s, vr, o.prior);
        c._undoMove();
        if (!best || v.s > best.s) best = v;
      });
      return best ? { s: best.s, se: best.se, n: a.total } : leaf;
    }
    var items = [], sw = 0, sv = 0;
    function add(n, v) { items.push({ w: n, v: 100 * v.s }); sw += n; sv += n * n * v.se * v.se; }
    function thin(x) { return shrink(statOf(x), leaf.s, vr, o.prior); }
    a.moves.forEach(function (m) {
      if (m.n < o.minGames || !play(m.code)) return add(m.n, thin(m));
      var v = value(left - 1, m);
      c._undoMove();
      add(m.n, v);
    });
    if (a.ended) add(a.ended.n, thin(a.ended));
    if (a.cut) add(a.cut.n, thin(a.cut));
    return { s: riskMean(items, o.risk) / 100, se: Math.sqrt(sv) / sw, n: a.total };
  }

  // My moves that compete: at least minGames games, the myMoves most played.
  function mine(a) {
    var ms = a.moves.filter(function (m) { return m.n >= o.minGames; });
    return o.myMoves ? ms.slice(0, o.myMoves) : ms;
  }

  function sanOf(code) {
    var p = codeParts(code);
    var ms = c._moves({ legal: true });
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].from === SQ[p.from] && ms[i].to === SQ[p.to] && ms[i].promotion === p.promotion) {
        return c._moveToSan(ms[i], ms);
      }
    }
    return p.from + p.to + (p.promotion || '');
  }

  /*
   * The position on the board, `left` plies from the horizon: my candidates ranked by
   * score, or their replies, most played first. Each: { san, code, games, share, raw
   * (the move's own score), s, se, lb, deep (searched, not a leaf), w (the share of its
   * distance from the position's score, `raw` below, that s kept: 1 if not shrunk) }.
   */
  function options(left) {
    var a = lookup();
    if (!a.total || left <= 0 || a.total < o.minGames) return { total: a.total, mine: c.turn() === me, list: [] };
    var my = c.turn() === me;
    var all = sumOf(a);
    var leaf = leafStat(all.w, all.d, all.b, me);
    var vr = varOf(leaf);
    var list = (my ? mine(a) : a.moves).map(function (m) {
      var san = sanOf(m.code);
      var raw = statOf(m);
      var v = raw, deep = false, w = 1;
      if (m.n >= o.minGames && play(m.code)) {
        v = value(left - 1, m);
        c._undoMove();
        deep = true;
      }
      // As evaluate() counts them: my candidates and their thin replies shrunk.
      if (my || !deep) {
        if (isFinite(leaf.s)) w = shrinkWeight(v.se, vr, o.prior);
        v = shrink(v, leaf.s, vr, o.prior);
      }
      return { san: san, code: m.code, games: m.n, share: m.n / a.total, raw: raw.s, s: v.s, se: v.se,
        lb: v.s - o.z * v.se, deep: deep, w: w };
    });
    if (my) list.sort(function (x, y) { return y.s - x.s; });
    return { total: a.total, mine: my, raw: leaf.s, list: list };
  }

  /*
   * The output: from the root to the horizon, my chosen moves and the replies worth
   * preparing for. t: {
   *   keep: 1          my moves expanded at each of my nodes, best scores first
   *   keepSafe: true   also expand the move with the best lower bound, if not among them
   *   show: 3          my alternatives listed (not expanded) beside the choice
   *   replyShare: .05  a reply is prepared for if played this often here...
   *   minReach: .01    ...and the line reaches it this often (their shares multiplied)
   *   coverage: null   instead, as repgen does: replies most played first until they cover
   *                    this share of the position's games...
   *   coverageStep: .1 ...this much less at each later opponent decision on the line...
   *   singleBelow: .5  ...and under this, only the most played reply.
   * }
   * With coverage, the most played reply always goes on (the line still ends at minGames
   * or the horizon), and replyShare and minReach default to 0 but still apply to the others.
   * Node: { san, fen, mine (my move), s, se, lb, games, share, raw, reach, tag ('best',
   * 'safe', 'kept'), alts: [...], other (share of replies not prepared for), children }.
   */
  function tree(t) {
    var byCoverage = !!t && t.coverage != null;
    t = Object.assign({ keep: 1, keepSafe: true, show: 3, replyShare: byCoverage ? 0 : 0.05,
      minReach: byCoverage ? 0 : 0.01, coverage: null, coverageStep: 0.1, singleBelow: 0.5 }, t || {});
    // Coverage at the line's oi-th opponent decision (0 = the first); 0 means the top reply only.
    function coverageAt(oi) {
      var c = Math.round((t.coverage - t.coverageStep * oi) * 1e6) / 1e6;
      return c < t.singleBelow ? 0 : c;
    }
    function grow(node, left, reach, oi) {
      var op = options(left);
      node.children = [];
      if (!op.list.length) return node;
      if (op.mine) {
        var pick = op.list.slice(0, t.keep).map(function (x, i) { return [x, i ? 'kept' : 'best']; });
        if (t.keepSafe) {
          var safe = op.list.reduce(function (p, x) { return x.lb > p.lb ? x : p; });
          if (pick.every(function (q) { return q[0] !== safe; })) pick.push([safe, 'safe']);
        }
        // The alternatives not expanded go in the chosen move's comment.
        var alts = op.list.filter(function (x) { return pick.every(function (q) { return q[0] !== x; }); })
          .slice(0, t.show);
        pick.forEach(function (q, i) {
          var kid = Object.assign({ mine: true, tag: q[1], reach: reach }, q[0]);
          if (!i) kid.alts = alts;
          if (play(q[0].code)) {
            kid.fen = c.fen();
            if (q[0].deep) grow(kid, left - 1, reach, oi);
            c._undoMove();
          }
          node.children.push(kid);
        });
      } else {
        var other = 0, cov = byCoverage ? coverageAt(oi) : 0, covered = 0;
        // op.list is most played first.
        op.list.forEach(function (x, i) {
          var r = reach * x.share;
          var take = byCoverage
            ? x.deep && (i === 0 || covered < cov && x.share >= t.replyShare && r >= t.minReach)
            : x.deep && x.share >= t.replyShare && r >= t.minReach;
          if (!take) { other += x.share; return; }
          covered += x.share;
          var kid = Object.assign({ mine: false, reach: r }, x);
          if (play(x.code)) {
            kid.fen = c.fen();
            grow(kid, left - 1, r, oi + 1);
            c._undoMove();
          }
          node.children.push(kid);
        });
        node.other = other;
      }
      return node;
    }
    var v = value(o.plies, null);
    return grow({ fen: c.fen(), s: v.s, se: v.se, games: v.n, reach: 1, root: true }, o.plies, 1, 0);
  }

  return {
    side: me,
    options: o,
    value: function () { return value(o.plies, null); },
    candidates: function () { return options(o.plies); },
    tree: tree,
    stats: function () { return { lookups: lookups, nodes: nodes, positions: memo.size, ms: Date.now() - t0 }; }
  };
}

/*
 * A prior for an index (`fit`): how far my candidates' true scores spread around each
 * other, from positions met on random walks from `fen` (each move chosen by how often
 * it is played, as a search meets them), and prior = var / tau^2.
 *
 * tau^2 is DerSimonian and Laird's random-effects estimate, pooled over the positions:
 * per position, Q = sum w_i (s_i - s_w)^2 over its candidates (moves with minGames games),
 * w_i = 1 / SE_i^2, s_w their weighted mean, and
 *
 *   tau^2 = sum (Q - (k - 1)) / sum (sum w - sum w^2 / sum w)
 *
 * which takes out what sampling noise alone would spread them by. It is measured on the
 * moves' own scores: the deep values' spread isn't observable this way. o: { samples
 * (positions), minGames, side ('w' | 'b': only positions that side moves in), maxPly
 * (walk length), rnd }.
 * Returns { positions, moves, tau, vr, prior } (tau as a fraction; prior in games).
 */
export function fitPrior(db, fen, o) {
  o = Object.assign({ samples: 2000, minGames: DEFAULTS.minGames, side: null, maxPly: 30,
    rnd: Math.random }, o || {});
  var seen = new Set();
  var num = 0, den = 0, vsum = 0, moves = 0, positions = 0;
  var start = fullFen(fen);
  var walks = 0;
  while (positions < o.samples && walks < o.samples * 20) {
    walks++;
    var c = new Chess(start);
    if (c._epSquare !== -1) legalEp(c);
    for (var p = 0; p < o.maxPly; p++) {
      var a = sortRecords(db.records(c._hash));
      if (a.total < 2 * o.minGames || !a.moves.length) break;
      if (!seen.has(c._hash)) {
        seen.add(c._hash);
        if (!o.side || c.turn() === o.side) {
          var me = c.turn();
          var cs = a.moves.filter(function (m) { return m.n >= o.minGames; }).map(function (m) {
            var st = leafStat(m.w, m.d, m.b, me);
            return { s: st.s, w: 1 / (st.se * st.se), vr: varOf(st) };
          });
          if (cs.length >= 2) {
            var sw = 0, sw2 = 0, sws = 0, q = 0;
            cs.forEach(function (x) { sw += x.w; sw2 += x.w * x.w; sws += x.w * x.s; });
            var mean = sws / sw;
            cs.forEach(function (x) { q += x.w * (x.s - mean) * (x.s - mean); vsum += x.vr; });
            num += q - (cs.length - 1);
            den += sw - sw2 / sw;
            moves += cs.length;
            positions++;
            if (positions >= o.samples) break;
          }
        }
      }
      // On by a move chosen in proportion to its games.
      var x = o.rnd() * a.moves.reduce(function (t, m) { return t + m.n; }, 0), pick = a.moves[0];
      for (var i = 0; i < a.moves.length; i++) {
        x -= a.moves[i].n;
        if (x < 0) { pick = a.moves[i]; break; }
      }
      if (!playCode(c, pick.code)) break;
    }
  }
  var tau2 = den > 0 ? Math.max(num / den, 0) : NaN;
  var vr = moves ? vsum / moves : NaN;
  return { positions: positions, moves: moves, tau: Math.sqrt(tau2), vr: vr,
    prior: tau2 > 0 ? vr / tau2 : Infinity };
}

// Plays the move with index code `code` on chess.js board `c`; false if it has none.
export function playCode(c, code) {
  var ms = c._moves({ legal: false });
  for (var i = 0; i < ms.length; i++) {
    if (moveCode(ms[i]) === code) {
      c._makeMove(ms[i]);
      if (c._epSquare !== -1) legalEp(c);
      return true;
    }
  }
  return false;
}
