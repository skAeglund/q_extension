/*
 * deeprep build: a repertoire chosen for what the user asked of one on 2026-10-02:
 *
 *   1. a high score in the middlegames it leads to: the deep score from the index's games
 *      (search.mjs), shrunk, so a lead on few games doesn't win on luck;
 *   2. no reliance on traps: a trap is fine, but the position must stay decent when the
 *      opponent doesn't fall for it. Two checks, from ChessDB: my move at most `maxLoss`
 *      win% points under ChessDB's best (as repgen's), and the sound value, the score
 *      after their replies that aren't blunders, at most `soundMargin` under the best
 *      candidate's;
 *   3. a good practical evaluation: ChessDB's eval of my move, and Prac d1 (ChessDB's evals
 *      after each of their replies, weighed by how often people play them, risk-averse),
 *      blended with the deep score by `weights`;
 *   4. few great lines over many best ones: "58% with a new move, or 56% by transposing into
 *      a known position: generally the known one". A position of mine to learn costs
 *      `learnCost` points of the whole repertoire's score per 100, so at a node reached by
 *      `reach` of the games a move pays learnCost/100 x (positions it adds) / reach points
 *      of its own score. What a move adds is the new share of its line times the size of
 *      the largest candidate's line (see price()): a move into positions the repertoire
 *      already has adds nothing, a new line adds the whole size. At the default 0.5 that
 *      is about 2 points for a wholly new line at any reach, since lines shrink with it.
 *      A move the repertoire already plays in a position with the same pawns counts
 *      `theme` less (recurring moves are easier to learn).
 *
 * The plan is repgen's: work goes best first by reach, my move is decided, their replies
 * are followed by coverage (pickReplies), and a transposition is one node. Then `passes`
 * polish passes decide every move of mine again, most reached first, with the whole
 * repertoire known: an early decision could only guess what the rest would share.
 *
 * Pure apart from db.records(key) and deps.chessdb(fen) (a promise of ChessDB's queryall
 * in compactChessdb()'s shape, or null), so the tests run it on a small index and a fake
 * ChessDB.
 */

import { Chess } from '../../src/vendor/chess.js';
import { riskMean, scoreToRootWin, moveKey } from '../../src/pe/search.js';
import { pickReplies } from '../repgen/generator.mjs';
import { CUT, ENDED, keyOf, codeParts, fullFen } from '../explorerdb/games.mjs';
import { createSearch } from './search.mjs';

export var BUILD_DEFAULTS = {
  plies: 12,              // each decision's deep scores look this many plies ahead
  minGames: 50,           // a move needs this many games to compete; a position with fewer ends its line
  prior: 200,             // search.mjs's shrinkage
  risk: 0.05,             // risk aversion, in the search and in Prac d1
  maxPly: 30,             // no line goes on past this many plies from the root
  // Their replies, as repgen follows them (generator.mjs pickReplies).
  coverage: 0.9, coverageStep: 0.1, singleBelow: 0.5,
  minReach: 0.005, minShare: 0, lineMinReach: 0.001,
  consider: 4,            // my best moves by deep score that are weighed (plus the most played)
  weights: [0.1, 0.2, 0.7],   // ChessDB, Prac d1, deep: the blend my move is ranked by
  maxLoss: 5,             // ChessDB: my move at most this many win% under its best (0: off)
  blunder: 8,             // a reply giving me this many win% over their best is a blunder
  soundMargin: 3,         // sound value at most this far under the best candidate's (0: off)
  learnCost: 0.5,         // points of the repertoire's score 100 new positions must earn (0: off)
  theme: 0.5,             // a move played elsewhere with the same pawns costs this much less than a new one
  costCap: 300,           // positions counted per move at most
  passes: 3,              // polish passes
  switchMargin: 0.25,     // a polish pass changes a move only for this many points
  closeMargin: 1          // the review flags a decision whose runner-up is this close
};

function turn(fen) { return String(fen).split(/\s+/)[1] === 'b' ? 'b' : 'w'; }

// The pawns alone: what "the same structure" means for the theme discount.
export function pawnKey(fen) {
  return String(fen).split(/\s+/)[0].split('/').map(function (rank) {
    var x = rank.replace(/\d/g, function (d) { return '1'.repeat(Number(d)); }).replace(/[nbrqkNBRQK]/g, '1');
    return x.replace(/1+/g, function (m) { return String(m.length); });
  }).join('/');
}

function playSan(fen, san) {
  var c = new Chess(fullFen(fen));
  try {
    var mo = c.move(san);
    return { fen: c.fen(), san: mo.san };
  } catch (e) {
    return null;
  }
}

/*
 * A position's games: { total, w, d, b, moves: [{ san, games, w, d, b }] } most played
 * first. Shares are of every game through the position, ended and cut ones included, as
 * the search counts them.
 */
export function positionOf(db, fen) {
  var recs = db.records(keyOf(fen));
  var out = { total: 0, w: 0, d: 0, b: 0, moves: [] };
  if (!recs.length) return out;
  var c = new Chess(fullFen(fen));
  var legal = c.moves({ verbose: true });
  recs.forEach(function (r) {
    var n = r.white + r.draws + r.black;
    out.total += n; out.w += r.white; out.d += r.draws; out.b += r.black;
    if (r.code === ENDED || r.code === CUT) return;
    var p = codeParts(r.code);
    var mo = legal.find(function (x) { return x.from === p.from && x.to === p.to && x.promotion === p.promotion; });
    if (mo) out.moves.push({ san: mo.san, games: n, w: r.white, d: r.draws, b: r.black });
  });
  out.moves.sort(function (a, b) { return b.games - a.games || (a.san < b.san ? -1 : 1); });
  return out;
}

// Weighted mean of the parts there are; null if none.
export function blend(w, parts) {
  var sw = 0, s = 0;
  parts.forEach(function (p, i) {
    if (w[i] > 0 && p != null && isFinite(p)) { sw += w[i]; s += w[i] * p; }
  });
  return sw > 0 ? s / sw : null;
}

/*
 * ChessDB's view of the position after my candidate, `fen` (their move), against the
 * index's replies `rp` (createSearch().candidates() there: their replies with deep scores
 * for me). Returns { prac, sound, trap, refute, refuteValue }:
 *   prac   Prac d1: the risk-averse mean of ChessDB's eval after each reply played, by games
 *   sound  the frequency-weighted deep score over the replies that aren't blunders (a
 *          blunder gives me more than `blunder` win% over their best reply); with none
 *          played, ChessDB's eval after their best one
 *   trap   the share of the games that are blunders
 * All null when ChessDB doesn't know the position.
 */
export function replyCheck(cdb, fen, side, rp, cfg) {
  var none = { prac: null, sound: null, trap: null, refute: null, refuteValue: null };
  if (!cdb || cdb.status !== 'ok' || !cdb.moves || !cdb.moves.length) return none;
  var evals = new Map();
  cdb.moves.forEach(function (m) { evals.set(moveKey(m.san), scoreToRootWin(m.score, fen, side)); });
  var bestMe = Infinity, bestSan = null;
  cdb.moves.forEach(function (m) {
    var v = evals.get(moveKey(m.san));
    if (v < bestMe) { bestMe = v; bestSan = m.san; }
  });
  var items = [], sw = 0, ss = 0, blunders = 0;
  (rp.list || []).forEach(function (r) {
    var e = evals.get(moveKey(r.san));
    if (e == null) return;                    // ChessDB has no eval for it: can't tell
    items.push({ w: r.games, v: e });
    if (e - bestMe > cfg.blunder) { blunders += r.games; return; }
    sw += r.games;
    ss += r.games * 100 * r.s;
  });
  return {
    prac: items.length ? riskMean(items, cfg.risk) : null,
    sound: sw > 0 ? ss / sw : bestMe,
    trap: rp.total ? blunders / rp.total : 0,
    refute: bestSan,
    refuteValue: bestMe
  };
}

/*
 * o = { root: FEN, side: 'w' | 'b', config (BUILD_DEFAULTS' keys), chessdb(fen) -> Promise
 * (or none: no ChessDB), decisions: Map(position key -> { play, avoid: [] }),
 * log(node, 'polish'?) after each decision }.
 * Returns { run(), nodes, rootKey, config }.
 */
export function createBuilder(db, o) {
  var cfg = Object.assign({}, BUILD_DEFAULTS, o.config || {});
  var side = o.side || turn(o.root);
  var memo = new Map();
  var sopts = { side: side, plies: cfg.plies, minGames: cfg.minGames, prior: cfg.prior, risk: cfg.risk,
    memo: memo, maxLookups: cfg.maxLookups || 1e9 };
  var nodes = new Map();
  var themes = new Map();      // pawnKey|san -> how many of my positions play it
  var proxies = new Map();     // key -> my best move by deep score, for counting positions
  var cdbMemo = new Map();
  var decisions = o.decisions || new Map();
  var log = o.log || function () {};
  var seq = 0;
  var stats = { decisions: 0, chessdb: 0, polished: 0 };

  function keyStr(fen) { return String(keyOf(fen)); }

  function chessdb(fen) {
    if (!o.chessdb) return Promise.resolve(null);
    var k = keyStr(fen);
    if (!cdbMemo.has(k)) {
      stats.chessdb++;
      cdbMemo.set(k, Promise.resolve().then(function () { return o.chessdb(fen); }).catch(function () { return null; }));
    }
    return cdbMemo.get(k);
  }

  function ensure(fen, reach, oi, ply, path) {
    var k = keyStr(fen);
    var n = nodes.get(k);
    if (n) {
      n.reach += reach;
      n.arrivals++;
      return n;
    }
    n = { key: k, fen: fen, kind: turn(fen) === side ? 'me' : 'opp', reach: reach, oi: oi, ply: ply,
      path: path, status: 'queued', seq: seq++, arrivals: 1 };
    nodes.set(k, n);
    return n;
  }

  function next() {
    var best = null;
    nodes.forEach(function (n) {
      if (n.status !== 'queued') return;
      if (!best || n.reach > best.reach || (n.reach === best.reach && n.seq < best.seq)) best = n;
    });
    return best;
  }

  function leaf(n, why) { n.status = 'leaf'; n.end = why; }

  function replyPicks(fen, reach, oi) {
    var pos = positionOf(db, fen);
    if (pos.total < cfg.minGames) return { pos: pos, picks: [] };
    var ex = { total: pos.total, moves: pos.moves.map(function (m) { return { san: m.san, games: m.games }; }) };
    return { pos: pos, picks: pickReplies(ex, reach, oi, {
      coverage: cfg.coverage, coverageStep: cfg.coverageStep, singleBelow: cfg.singleBelow,
      minReach: cfg.minReach, minShare: cfg.minShare, lineMinReach: cfg.lineMinReach, stopGames: cfg.minGames
    }) };
  }

  function expandOpp(n) {
    if (n.ply >= cfg.maxPly) return leaf(n, 'max-ply');
    var r = replyPicks(n.fen, n.reach, n.oi);
    n.games = r.pos.total;
    if (r.pos.total < cfg.minGames) return leaf(n, 'few-games');
    if (!r.picks.length) return leaf(n, 'rare');
    var covered = 0;
    n.replies = r.picks.map(function (p) {
      var mv = playSan(n.fen, p.san);
      covered += p.share;
      return { san: mv.san, share: p.share, games: p.games,
        child: ensure(mv.fen, n.reach * p.share, n.oi + 1, n.ply + 1, n.path.concat(mv.san)).key };
    });
    n.other = Math.max(0, 1 - covered);
    n.status = 'done';
  }

  function themeKey(fen, san) { return pawnKey(fen) + '|' + moveKey(san); }
  function addTheme(n, d) {
    if (!n.move) return;
    var k = themeKey(n.fen, n.move);
    themes.set(k, (themes.get(k) || 0) + d);
    if (!(themes.get(k) > 0)) themes.delete(k);
  }
  function cardCost(fen, san) { return themes.has(themeKey(fen, san)) ? 1 - cfg.theme : 1; }

  function proxy(fen) {
    var k = keyStr(fen);
    if (!proxies.has(k)) {
      var op = createSearch(db, fen, sopts).candidates();
      proxies.set(k, op.list.length ? op.list[0].san : null);
    }
    return proxies.get(k);
  }

  /*
   * The positions of mine a line from `fen` (their move) leads to: the repertoire's own
   * moves and replies where it has them, else my best move by deep score and their
   * replies by coverage. Returns { all, fresh }: every one of them, and the ones the
   * repertoire won't have anyway (each 1, or 1 - theme for a recurring move): not in
   * `elsewhere`, nor below a position that is, since that one's line is built whatever
   * this decision does. Nearest first, up to cfg.costCap positions.
   */
  function linePositions(fen, reach, oi, ply, elsewhere) {
    var all = 0, fresh = 0, seen = new Set();
    var queue = [{ fen: fen, reach: reach, oi: oi, ply: ply, inside: false }];
    for (var qi = 0; qi < queue.length && all < cfg.costCap; qi++) {
      var x = queue[qi];
      var k = keyStr(x.fen);
      if (seen.has(k)) continue;
      seen.add(k);
      if (x.ply >= cfg.maxPly) continue;
      var inside = x.inside || elsewhere.has(k);
      var known = nodes.get(k);
      if (known && known.status === 'leaf') continue;
      if (turn(x.fen) === side) {
        var san = known && known.move ? known.move : proxy(x.fen);
        if (!san) continue;
        all++;
        if (!inside) {
          // A position the repertoire has counts in the themes itself: only another one
          // playing the same move makes it cheaper.
          var tk = themeKey(x.fen, san);
          var self = known && known.move && themeKey(known.fen, known.move) === tk ? 1 : 0;
          fresh += (themes.get(tk) || 0) > self ? 1 - cfg.theme : 1;
        }
        var mv = playSan(x.fen, san);
        if (mv) queue.push({ fen: mv.fen, reach: x.reach, oi: x.oi, ply: x.ply + 1, inside: inside });
      } else {
        var reps = known && known.replies ? known.replies : replyPicks(x.fen, x.reach, x.oi).picks;
        reps.forEach(function (r) {
          var mv2 = playSan(x.fen, r.san);
          if (mv2) queue.push({ fen: mv2.fen, reach: x.reach * r.share, oi: x.oi + 1, ply: x.ply + 1, inside: inside });
        });
      }
    }
    return { all: all, fresh: fresh };
  }

  /*
   * Each candidate's learning cost and final score, against what the repertoire has
   * `elsewhere`. What a move costs is the part of its line that is new, times the size of
   * the largest candidate's line: a move into positions the repertoire already has costs
   * nothing, a move into new ones the whole size, whether or not its own line happens to
   * be short. (Counting only new positions would favour a move that ends the line soon,
   * into positions too thin to go on, over a main move.) A line with no positions at all
   * counts as new. The node itself is one position for every candidate; a move it plays
   * elsewhere with the same pawns makes it cheaper.
   *
   *   penalty = learnCost / 100 x (own + size x fresh / all) / reach
   */
  function price(n, elsewhere) {
    addTheme(n, -1);
    var live = n.cands.filter(function (c) { return !c.out; });
    live.forEach(function (c) {
      var lp = cfg.learnCost > 0 ? linePositions(c.fen, n.reach, n.oi, n.ply + 1, elsewhere) : { all: 0, fresh: 0 };
      c.positions = lp.all;
      c.fresh = lp.fresh;
      c.own = cardCost(n.fen, c.san);
    });
    // Left out: no learning cost, only the blend (choose() falls back on them only when
    // every move is out).
    n.cands.forEach(function (c) { if (c.out) { c.penalty = 0; c.score = c.blend; } });
    var size = live.reduce(function (m, c) { return Math.max(m, c.positions || 0); }, 0);
    live.forEach(function (c) {
      c.newShare = c.positions > 0 ? c.fresh / c.positions : 1;
      c.penalty = cfg.learnCost > 0
        ? cfg.learnCost / 100 * (c.own + size * c.newShare) / Math.max(n.reach, 1e-9) : 0;
      c.score = c.blend - c.penalty;
    });
    addTheme(n, 1);
  }

  function choose(n) {
    var d = decisions.get(n.key);
    var ok = n.cands.filter(function (c) { return !c.out; });
    var pinned = d && d.play && n.cands.find(function (c) { return moveKey(c.san) === moveKey(d.play); });
    if (pinned) return { c: pinned, why: 'pinned' };
    if (!ok.length) {
      // Everything over a limit: the safest by ChessDB, else the best deep score.
      var safe = n.cands.filter(function (c) { return c.out !== 'avoid'; }).slice()
        .sort(function (a, b) { return ((b.engine != null ? b.engine : -1) - (a.engine != null ? a.engine : -1)) || (b.deep - a.deep); })[0];
      return safe ? { c: safe, why: 'all-out' } : null;
    }
    var best = ok.reduce(function (a, b) { return b.score > a.score ? b : a; });
    var top = ok.reduce(function (a, b) { return b.blend > a.blend ? b : a; });
    return { c: best, why: best === top ? 'best' : 'learn' };
  }

  function settle(n, pick) {
    addTheme(n, -1);
    n.move = pick.c.san;
    n.why = pick.why;
    addTheme(n, 1);
    var mv = playSan(n.fen, n.move);
    n.child = ensure(mv.fen, n.reach, n.oi, n.ply + 1, n.path.concat(mv.san)).key;
    n.status = 'done';
  }

  async function decide(n) {
    if (n.ply >= cfg.maxPly) return leaf(n, 'max-ply');
    var op = createSearch(db, n.fen, sopts).candidates();
    n.games = op.total;
    if (!op.list.length) return leaf(n, op.total < cfg.minGames ? 'few-games' : 'thin');
    var d = decisions.get(n.key);
    var picked = op.list.slice(0, cfg.consider);
    var add = function (x) { if (x && picked.indexOf(x) < 0) picked.push(x); };
    add(op.list.reduce(function (a, b) { return b.games > a.games ? b : a; }));
    if (d && d.play) {
      var want = op.list.find(function (x) { return moveKey(x.san) === moveKey(d.play); });
      if (want) add(want);
      else n.pinMissing = d.play;              // not a move with minGames games here
    }
    n.cands = picked.map(function (x) {
      var c = { san: x.san, fen: playSan(n.fen, x.san).fen, games: x.games, share: x.share, raw: 100 * x.raw,
        deep: 100 * x.s, se: 100 * x.se, engine: null, prac: null, sound: null, trap: null };
      if (d && d.avoid && d.avoid.some(function (a) { return moveKey(a) === moveKey(x.san); })) c.out = 'avoid';
      return c;
    });
    // ChessDB here and after each candidate, asked together.
    var answers = await Promise.all([chessdb(n.fen)].concat(n.cands.map(function (c) {
      return c.out ? null : chessdb(c.fen);
    })));
    var here = answers[0];
    var wins = new Map(), best = null, bestSan = null;
    if (here && here.status === 'ok' && here.moves) {
      here.moves.forEach(function (m) {
        var v = scoreToRootWin(m.score, n.fen, side);
        wins.set(moveKey(m.san), v);
        if (best == null || v > best) { best = v; bestSan = m.san; }
      });
    }
    n.engineBest = bestSan != null ? { san: bestSan, win: best } : null;
    n.cands.forEach(function (c, i) {
      if (wins.has(moveKey(c.san))) c.engine = wins.get(moveKey(c.san));
      if (c.out) return;
      var rp = createSearch(db, c.fen, Object.assign({}, sopts, { plies: Math.max(1, cfg.plies - 1) })).candidates();
      var chk = replyCheck(answers[i + 1], c.fen, side, rp, cfg);
      c.prac = chk.prac;
      c.sound = chk.sound;
      c.trap = chk.trap;
      c.refute = chk.refute;
      // A move ChessDB lists no eval for here still has one: after it, their best reply.
      // Without it, the loss limit would pass exactly the moves it knows least about.
      if (c.engine == null && chk.refuteValue != null) c.engine = chk.refuteValue;
      if (cfg.maxLoss > 0 && c.engine != null && best != null && best - c.engine > cfg.maxLoss + 1e-9) c.out = 'max-loss';
    });
    n.cands.forEach(function (c) { c.blend = blend(cfg.weights, [c.engine, c.prac, c.deep]); });
    if (cfg.soundMargin > 0) {
      var sounds = n.cands.filter(function (c) { return !c.out && c.sound != null; }).map(function (c) { return c.sound; });
      var top = sounds.length ? Math.max.apply(null, sounds) : null;
      n.cands.forEach(function (c) {
        if (!c.out && c.sound != null && c.sound < top - cfg.soundMargin - 1e-9) c.out = 'unsound';
      });
    }
    price(n, new Set(nodes.keys()));
    stats.decisions++;
    var pick = choose(n);
    if (!pick) return leaf(n, 'avoided');
    settle(n, pick);
    log(n);
  }

  async function grow() {
    for (;;) {
      var n = next();
      if (!n) return;
      if (n.kind === 'opp') expandOpp(n);
      else await decide(n);
    }
  }

  // Reach from the root through the repertoire's edges (Kahn's order, so a transposition
  // sums its parents first). Unreachable nodes get 0.
  function edges(n) {
    if (n.status !== 'done') return [];
    if (n.kind === 'me') return n.child ? [{ key: n.child, f: 1 }] : [];
    return (n.replies || []).map(function (r) { return { key: r.child, f: r.share }; });
  }
  function reachable(skip) {
    var seen = new Set(), stack = [o.rootKey || keyStr(o.root)];
    while (stack.length) {
      var k = stack.pop();
      if (seen.has(k) || !nodes.has(k)) continue;
      seen.add(k);
      if (k === skip) continue;
      edges(nodes.get(k)).forEach(function (e) { stack.push(e.key); });
    }
    return seen;
  }
  function recomputeReach() {
    var live = reachable(null);
    var indeg = new Map();
    live.forEach(function (k) { indeg.set(k, 0); });
    live.forEach(function (k) {
      edges(nodes.get(k)).forEach(function (e) { if (live.has(e.key)) indeg.set(e.key, indeg.get(e.key) + 1); });
    });
    nodes.forEach(function (n) { n.reach = 0; });
    var rootKey = keyStr(o.root);
    nodes.get(rootKey).reach = 1;
    var queue = [];
    indeg.forEach(function (v, k) { if (!v) queue.push(k); });
    while (queue.length) {
      var n = nodes.get(queue.shift());
      edges(n).forEach(function (e) {
        if (!live.has(e.key)) return;
        nodes.get(e.key).reach += n.reach * e.f;
        indeg.set(e.key, indeg.get(e.key) - 1);
        if (!indeg.get(e.key)) queue.push(e.key);
      });
    }
    return live;
  }
  function prune() {
    var live = reachable(null);
    nodes.forEach(function (n, k) {
      if (!live.has(k)) { addTheme(n, -1); nodes.delete(k); }
    });
  }

  // Every decision again, most reached first, against the whole repertoire.
  async function polish() {
    var changed = 0;
    var order = [];
    recomputeReach();
    nodes.forEach(function (n) { if (n.kind === 'me' && n.status === 'done' && n.cands) order.push(n); });
    order.sort(function (a, b) { return b.reach - a.reach || a.seq - b.seq; });
    for (var i = 0; i < order.length; i++) {
      var n = order[i];
      if (nodes.get(n.key) !== n || !(n.reach > 0)) continue;
      var d = decisions.get(n.key);
      if (d && d.play) continue;
      price(n, reachable(n.key));
      var cur = n.cands.find(function (c) { return c.san === n.move; });
      var pick = choose(n);
      if (!pick || !cur || pick.c === cur) { if (pick && cur) n.why = pick.why; continue; }
      if (cur.out || pick.c.score - cur.score >= cfg.switchMargin) {
        var was = n.move;
        settle(n, pick);
        n.was = (n.was || []).concat(was);
        prune();
        await grow();
        recomputeReach();
        stats.polished++;
        changed++;
        log(n, 'polish');
      }
    }
    return changed;
  }

  async function run() {
    ensure(o.root, 1, 0, 0, []);
    await grow();
    for (var p = 0; p < cfg.passes; p++) {
      if (!(await polish())) break;
    }
    prune();
    recomputeReach();
    // The final costs, as the repertoire stands.
    nodes.forEach(function (n) {
      if (n.kind === 'me' && n.status === 'done' && n.cands) price(n, reachable(n.key));
    });
    return { nodes: nodes, stats: stats };
  }

  return { run: run, nodes: nodes, config: cfg, side: side, stats: stats, rootKey: keyStr(o.root) };
}

/*
 * The repertoire's moves as evaluate.mjs takes them: Map(position key as BigInt -> { san }).
 */
export function repertoireMoves(nodes) {
  var m = new Map();
  nodes.forEach(function (n) { if (n.kind === 'me' && n.move) m.set(BigInt(n.key), { san: n.move, fen: n.fen }); });
  return m;
}

/*
 * The repertoire as a tree for deeprep/pgn.mjs toPgn(): most likely reply first, a
 * position met a second time ends with "transposes to" the first one's line. `note(n,
 * kid)` writes a move's comment.
 */
export function toTree(nodes, rootKey, note, line) {
  var shown = new Map();
  function build(n, out) {
    out.children = [];
    if (shown.has(n.key)) return out;
    shown.set(n.key, n.path);
    if (n.kind === 'me' && n.move) {
      var kidNode = nodes.get(n.child);
      var kid = { san: n.move, mine: true, note: note(n, kidNode) };
      if (kidNode && shown.has(kidNode.key)) kid.note = joinNote(kid.note, 'transposes to ' + line(shown.get(kidNode.key)));
      else if (kidNode) build(kidNode, kid);
      out.children.push(kid);
    } else if (n.kind === 'opp' && n.replies) {
      n.replies.slice().sort(function (a, b) { return b.share - a.share; }).forEach(function (r) {
        var m = nodes.get(r.child);
        var kid = { san: r.san, mine: false, note: Math.round(100 * r.share) + '% of ' + r.games.toLocaleString('en-US') + ' games' };
        if (m && shown.has(m.key)) kid.note = joinNote(kid.note, 'transposes to ' + line(shown.get(m.key)));
        else if (m) build(m, kid);
        out.children.push(kid);
      });
    }
    return out;
  }
  var root = nodes.get(rootKey);
  return build(root, { fen: root.fen, root: true, other: root.other || 0 });
}

function joinNote(a, b) { return a ? a + ' · ' + b : b; }
