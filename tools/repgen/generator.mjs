/*
 * Repertoire generator - the plan: which positions get searched, which of my moves is
 * kept, and which opponent replies are followed.
 *
 * Pure like src/pe: no fetch, no files, no timers. Everything comes through `deps`, so
 * test/repgen.js drives it with fake data.
 *
 *   deps.explorer(fen)       -> { total, moves: [{ san, games }] }   (Lichess, the run's filter)
 *   deps.chessdb(fen)        -> { status, moves: [{ san, score }] }  (score: side to move)
 *   deps.analyse(fen)        optional, fire and forget: ask ChessDB to analyse a position
 *   deps.play(fen, san)      -> { fen, san }: the position after `san`, and its SAN as
 *                               chess.js spells it (so the PGN is clean)
 *   deps.runRoot(fen, rows, { opts, budget, shares })
 *                            -> { results: Map(san -> final row result), spent }
 *                               the table's own lockstep rounds (tools/repgen/root.mjs)
 *
 * Two kinds of node, keyed by fenKey so a transposition is one node:
 *   me   my move. The candidates are searched like the Practical column's rows, and the
 *        best practical value wins - compared at one depth only, as the column's green
 *        does, because deeper values drift upwards.
 *   opp  their move. Replies are followed most played first until they cover
 *        `coverage` of the games. Coverage drops by `coverageStep` at every later
 *        opponent decision on the line; below `singleBelow` only the top reply goes on.
 *        A reply besides the top one also needs `minReach` and `minShare` (of that
 *        position's games), and no line goes on below
 *        `lineMinReach` or once a position has fewer than `stopGames` games.
 *
 * Work goes best first by reach (the chance of the line, from the opponent's move
 * shares), so a run stopped at any point has done the most likely positions.
 *
 * A check (repgen/check.mjs) sets `recheck` on done nodes of mine: they are searched
 * again, in reach order like queued work, but stay done meanwhile, so the PGN keeps the
 * old line until the new search replaces it. A re-search that changes the move drops
 * whatever only the old move led to.
 */

import { fenKey, sideToMove, moveKey, scoreToRootWin, expectedScore } from '../../src/pe/search.js';

export var REPGEN_DEFAULTS = {
  coverage: 0.9,          // first opponent decision: follow replies covering this share
  coverageStep: 0.1,      // ...and this much less at each later one on the line
  singleBelow: 0.5,       // under this coverage, only the most played reply goes on
  minReach: 0.005,        // a reply other than the top one needs this reach
  minShare: 0,            // ...and this share of the position's games
  lineMinReach: 0.001,    // no line goes on below this reach
  stopGames: 10,          // a position with fewer games ends the line
  maxPly: 40,             // plies from the start position
  deepPlies: 6,           // my moves before this ply are searched deep (depth 5)...
  deepMaxPly: 6,          // ...meaning the search's maxPly 6
  shallowMaxPly: 4,       // later ones to depth 3
  budgetDeep: 150,        // uncached explorer requests per deep search
  budget: 60,             // ...and per later one
  // A close call is searched deeper: when rows at the table's depth are within
  // deeperWithin points of the best by the choice's own score (the blend, or Practical
  // alone), those rows alone are searched again two plies deeper, up to deeperMaxPly
  // (8 is depth 7), with budgetDeeper uncached explorer requests each time. The rest
  // lost by more than that and stay at their depth, which keeps them out of the
  // comparison (see choose()). 0 turns it off.
  deeperWithin: 1,
  deeperMaxPly: 8,
  budgetDeeper: 600,
  scoreRows: 3,           // my best scoring moves in the games are always candidates...
  scoreMinGames: 20,      // ...among those played at least this often
  rowShare: 0.05,         // my moves played this often are candidates too...
  maxEngineLoss: 10,      // ...unless ChessDB puts them this many win% under its best
  maxRows: 6,             // ...while there are fewer candidates than this
  noEvalRetries: 2,       // ChessDB didn't know my position: ask it, and look again
  noEvalWaitMs: 3 * 60 * 1000,
  errorRetries: 3,
  errorWaitMs: 60 * 1000,
  // The PGN marks my move by how many win% points it gives up against ChessDB's best
  // (0 turns a mark off). Only the PGN reads these, so --pgn-only re-marks a finished run.
  markInteresting: 3,     // !?
  markDubious: 7,         // ?!
  markBlunder: 15,        // ??
  // ...and !? at least for a move ChessDB puts this many centipawns under 0 for me when
  // its best doesn't: at the depth ChessDB backs its scores up from, 0.00 is a draw with
  // best play, and giving the opponent even a slight edge concedes it.
  markWorseThan: 10,
  // How my move is chosen (see choose()): a weighted mean of ChessDB's eval of the move,
  // its Practical value and its prepared score, all in win% for me. A run keeps the
  // weights it was made with; runs from before the blend have [0, 1, 0], Practical alone.
  weights: [0.1, 0.2, 0.7],
  // A near-tie goes to ChessDB (see choose()): a move within closeWithin win% points of
  // the top one wins when ChessDB rates it at least closeCp centipawns higher. Only while
  // ChessDB has no weight of its own in the choice. 0 turns it off.
  closeWithin: 1,
  closeCp: 5
};

// The Practical column's defaults as they were when repgen was built. The column's later
// request savings (v1.14.0: replies from 3%, no explorer under 10 games, my alternatives
// only from 10% reach) are off here, so a checked run searches again the way it was made;
// --reply-threshold 3 --skip-explorer-below 10 --compare-reach-min 10 turn them on.
// Maia is off for the same reason, and because it needs onnxruntime-node and its model
// (repgen/maia.mjs): --maia turns it on for a run, with the column's blend. maiaElo 0 means
// "from the run's rating filter", as the column's does. riskAversion is the column's
// 0.05: a new run saves it at creation, and a run from before it was searched with plain
// means and keeps 0 (repgen.mjs).
export var SEARCH_DEFAULTS = {
  replyThreshold: 0.02,
  minGames: 50,
  skipExplorerBelow: 0,
  reachFloor: 0.02,
  ownMargin: 5,
  ownMaxCandidates: 3,
  compareReachMin: 0,
  maia: false,
  maiaElo: 0,
  maiaUntil: 100,
  maiaOnlyBelow: 10,
  maiaWeight: 20,
  prepPriorGames: 50,
  riskAversion: 0.05
};

// 0 means "the top reply only".
export function coverageAt(cfg, oi) {
  var c = Math.round((cfg.coverage - cfg.coverageStep * oi) * 1e6) / 1e6;
  return c < cfg.singleBelow ? 0 : c;
}

export function pickReplies(ex, reach, oi, cfg) {
  if (!ex || !ex.total) return [];
  var cov = coverageAt(cfg, oi);
  var moves = (ex.moves || []).filter(function (m) { return m.games >= cfg.stopGames; })
    .sort(function (a, b) { return b.games - a.games; });
  var out = [];
  var cum = 0;
  for (var i = 0; i < moves.length; i++) {
    var share = moves[i].games / ex.total;
    // Sorted by games, so once one reply falls short every later one does too.
    if (i === 0 ? reach * share < cfg.lineMinReach
                : cum >= cov || reach * share < cfg.minReach || share < cfg.minShare) break;
    out.push({ san: moves[i].san, share: share, games: moves[i].games });
    cum += share;
  }
  return out;
}

/*
 * My candidates, in three groups:
 *   - as the Practical column picks its rows: the moves ChessDB rates within ownMargin of
 *     its best (up to ownMaxCandidates, more played first among equals);
 *   - the scoreRows moves that score best for me in the games (wins plus half the draws),
 *     among those with at least scoreMinGames games. What players actually score with a
 *     move can differ a lot from the engine's view, so these are searched whatever
 *     ChessDB thinks of them, and even when it has no eval for them;
 *   - the moves played at least rowShare of the time that ChessDB doesn't rate too far
 *     down, while there is room under maxRows. Only this group is capped.
 */
export function pickCandidates(ex, cdb, fen, cfg, sopts) {
  var side = sideToMove(fen);
  var shares = {};
  var byKey = new Map();
  var total = ex && ex.total ? ex.total : 0;
  (ex && ex.moves || []).forEach(function (m) {
    byKey.set(moveKey(m.san), total ? m.games / total : 0);
  });
  var evals = (cdb && cdb.status === 'ok' && cdb.moves || []).map(function (m) {
    // At my node I am the side to move, so ChessDB's score is already mine.
    return { san: m.san, win: scoreToRootWin(m.score, fen, side), cp: m.score,
      share: byKey.get(moveKey(m.san)) || 0 };
  });
  evals.sort(function (a, b) { return (b.win - a.win) || (b.share - a.share); });
  if (!evals.length) return { rows: [], shares: shares, best: null };
  var best = evals[0];
  var rows = evals.filter(function (e) { return best.win - e.win <= sopts.ownMargin; })
    .slice(0, Math.max(1, sopts.ownMaxCandidates));
  function has(san) {
    return rows.some(function (r) { return moveKey(r.san) === moveKey(san); });
  }

  var scores = {};
  (ex && ex.moves || []).filter(function (m) { return m.games >= cfg.scoreMinGames; })
    .map(function (m) {
      var mine = side === 'w' ? m.white : m.black;
      return { m: m, score: ((mine || 0) + (m.draws || 0) / 2) / m.games };
    })
    .sort(function (a, b) { return (b.score - a.score) || (b.m.games - a.m.games); })
    .slice(0, cfg.scoreRows)
    .forEach(function (x) {
      var e = evals.find(function (v) { return moveKey(v.san) === moveKey(x.m.san); }) ||
        { san: x.m.san, win: undefined, share: total ? x.m.games / total : 0 };
      scores[e.san] = x.score;
      if (!has(e.san)) rows.push(e);
    });

  var room = Math.max(rows.length, cfg.maxRows);
  evals.filter(function (e) {
    return e.share >= cfg.rowShare && best.win - e.win <= cfg.maxEngineLoss;
  }).sort(function (a, b) { return b.share - a.share; }).forEach(function (e) {
    if (rows.length < room && !has(e.san)) rows.push(e);
  });
  rows.forEach(function (e) { shares[e.san] = e.share; });
  return { rows: rows.map(function (e) { return e.san; }), shares: shares, best: best,
    scores: scores,
    wins: rows.reduce(function (m, e) { m[e.san] = e.win; return m; }, {}),
    cps: rows.reduce(function (m, e) { if (e.cp != null) m[e.san] = e.cp; return m; }, {}) };
}

// Practical alone: no weight on ChessDB or the prepared score. Also what a missing
// `weights` means (choose() called without them).
export function practicalOnly(w) {
  return !w || !(w[0] > 0 || w[2] > 0);
}

/*
 * The blend a move is chosen by: weights [chessdb, practical, prepared] over its ChessDB
 * eval, Practical value and prepared score (win% for me). A part that is missing spreads
 * its weight over the others. The prepared score needs no weighting by games of its own:
 * it is already pulled towards the Practical value when its leaves have few (prior), so
 * with thin data the blend leans on Practical by itself. Null for Practical alone.
 */
export function blendScore(w, engine, value, prep) {
  if (practicalOnly(w)) return null;
  var sw = 0, s = 0;
  [[w[0], engine], [w[1], value], [w[2], prep]].forEach(function (p) {
    if (p[0] > 0 && p[1] != null && isFinite(p[1])) { sw += p[0]; s += p[0] * p[1]; }
  });
  return sw > 0 ? s / sw : value;
}

/*
 * The column's green, as a choice: the best row among rows at the table's depth.
 * A row that can't go deeper (`complete`) is exact at every depth and always competes.
 * So does a row with too few games for a Practical value (`few`, under minGames without
 * Maia), on ChessDB's eval: the opponent's mean over their replies is never below their
 * best one, so its Practical value would be at least about that. It wins only when even
 * that floor beats the others, which also drift upwards with depth. Without this, a move
 * ChessDB rates well above the rest lost to the one move with enough games.
 * Equal scores go to the more played move.
 *
 * o = { weights, wins: { san: ChessDB win% for me }, preps: { san: prepared score, win%
 * for me }, cps: { san: centipawns for me }, within, cp }
 *
 * Best means the highest blendScore(). With `weights` Practical alone (or none), that is
 * the Practical value. The depth rule stays whatever the weights: the prepared score
 * follows the Practical choices of the same search, so it drifts with its depth too.
 *
 * A near-tie goes to ChessDB, while ChessDB has no weight in the blend. Going down the
 * rows in order, a row within `within` points of the top one takes over when ChessDB
 * rates it at least `cp` centipawns above the current pick. A Practical lead under a
 * point is mostly noise, so ChessDB decides there; a clear lead still wins however
 * ChessDB rates the move, which is the point of Practical (a move can look bad only for
 * an engine reply people don't find). A row without a ChessDB eval never takes over and
 * is never taken over. The pick then carries `over`: the top row it beat.
 *
 * Returns a copy of the picked row with `score` (what it was ranked by), or null.
 */
export function choose(rows, shares, o) {
  o = o || {};
  var w = o.weights;
  var vals = rows.filter(function (r) {
    return r.res && (r.res.state === 'value' || r.res.state === 'few') && r.res.value != null;
  });
  function any(res) { return res.complete || res.state === 'few'; }
  var top = 0;
  vals.forEach(function (r) { if (!any(r.res) && r.res.depth > top) top = r.res.depth; });
  var cmp = vals.filter(function (r) { return any(r.res) || r.res.depth === top; })
    .map(function (r) {
      var b = blendScore(w, o.wins && o.wins[r.san], r.res.value, o.preps && o.preps[r.san]);
      return Object.assign({}, r, { score: b == null ? r.res.value : b });
    });
  cmp.sort(function (a, b) {
    return (b.score - a.score) || ((shares[b.san] || 0) - (shares[a.san] || 0));
  });
  if (!cmp.length) return null;
  var first = cmp[0];
  if (!(o.within > 0) || !o.cps || (w && w[0] > 0)) return first;
  var cps = o.cps;
  var need = Math.max(1, o.cp || 0);
  var pick = first;
  cmp.forEach(function (r) {
    if (r === first || first.score - r.score > o.within) return;
    var a = cps[pick.san], b = cps[r.san];
    if (a == null || b == null) return;
    if (b - a >= need) pick = r;
  });
  return pick === first ? first : Object.assign({}, pick, { over: first });
}

/*
 * The rows of a close call: those choose() compares whose score is within `within` of
 * the best one's. Only rows with a searched value (not `few`, which has none to deepen),
 * and only when at least two are close and one of them can still go deeper. [] otherwise.
 */
export function closeBand(rows, shares, o) {
  if (!(o.within > 0)) return [];
  var w = o.weights;
  var vals = rows.filter(function (r) {
    return r.res && (r.res.state === 'value' || r.res.state === 'few') && r.res.value != null;
  });
  function any(res) { return res.complete || res.state === 'few'; }
  var top = 0;
  vals.forEach(function (r) { if (!any(r.res) && r.res.depth > top) top = r.res.depth; });
  var cmp = vals.filter(function (r) { return any(r.res) || r.res.depth === top; })
    .map(function (r) {
      var b = blendScore(w, o.wins && o.wins[r.san], r.res.value, o.preps && o.preps[r.san]);
      return { r: r, score: b == null ? r.res.value : b };
    });
  if (!cmp.length) return [];
  var best = Math.max.apply(null, cmp.map(function (c) { return c.score; }));
  var band = cmp.filter(function (c) {
    return c.r.res.state === 'value' && best - c.score <= o.within;
  }).map(function (c) { return c.r; });
  if (band.length < 2 || band.every(function (r) { return r.res.complete; })) return [];
  return band.map(function (r) { return r.san; });
}

export function isFatal(e) {
  return !!e && (e.message === 'no-token' || e.status === 401 || e.status === 403);
}

/*
 * The keys of the nodes the start position leads to, most likely first (by the reach of
 * the path that gets there first). Only these are in the repertoire: toPgn() walks the
 * same edges.
 */
export function reachable(state) {
  var nodes = state.nodes;
  var root = fenKey(state.startFen);
  var seen = new Set();
  var out = [];
  var open = nodes[root] ? [{ key: root, reach: 1 }] : [];
  while (open.length) {
    var bi = 0;
    for (var i = 1; i < open.length; i++) if (open[i].reach > open[bi].reach) bi = i;
    var cur = open.splice(bi, 1)[0];
    if (seen.has(cur.key)) continue;
    seen.add(cur.key);
    out.push(cur.key);
    var n = nodes[cur.key];
    if (!n || n.status !== 'done') continue;
    if (n.kind === 'me') {
      if (n.child && nodes[n.child]) open.push({ key: n.child, reach: cur.reach });
    } else {
      (n.replies || []).forEach(function (r) {
        if (r.child && nodes[r.child]) open.push({ key: r.child, reach: cur.reach * r.share });
      });
    }
  }
  return out;
}

// Drops the nodes the start position no longer leads to, so the run doesn't spend its
// time on lines an earlier move of mine was replaced in.
export function prune(state) {
  var keep = new Set(reachable(state));
  var gone = 0;
  Object.keys(state.nodes).forEach(function (k) {
    if (!keep.has(k)) { delete state.nodes[k]; gone++; }
  });
  return gone;
}

export function newState(startFen, side, prefix) {
  return { version: 1, startFen: startFen, side: side, prefix: prefix || [],
    nodes: {}, seq: 0, searches: 0 };
}

/*
 * o = { state, config, search, deps, now }
 * step() does one node and resolves to an event:
 *   { type: 'searched' | 'expanded' | 'leaf' | 'no-eval' | 'retry', node, error? }
 *   { type: 'waiting', until }   only nodes waiting on ChessDB or a retry are left
 *   { type: 'done' }
 * A fatal error (no token, token rejected) rejects; anything else is retried.
 */
export function createGenerator(o) {
  var cfg = Object.assign({}, REPGEN_DEFAULTS, o.config || {});
  var sopts = Object.assign({}, SEARCH_DEFAULTS, o.search || {});
  var d = o.deps;
  var now = o.now || Date.now;
  var state = o.state;
  var nodes = state.nodes;

  // path: the first move order to arrive, for the log.
  function ensure(fen, ply, reach, oi, path) {
    var key = fenKey(fen);
    var n = nodes[key];
    if (n) {
      // Another move order: the same node. Its reach grows, which only matters while
      // it still waits its turn.
      n.reach += reach;
      n.transpositions = (n.transpositions || 0) + 1;
      return n;
    }
    n = { kind: sideToMove(fen) === state.side ? 'me' : 'opp', key: key, fen: fen,
      ply: ply, reach: reach, oi: oi, path: path, status: 'queued', seq: state.seq++ };
    nodes[key] = n;
    return n;
  }
  if (!nodes[fenKey(state.startFen)]) ensure(state.startFen, 0, 1, 0, []);

  function ready(n, t) {
    return n.status === 'queued' || (n.status === 'wait' && n.retryAt <= t) ||
      (!!n.recheck && !(n.retryAt > t));
  }

  function next() {
    var t = now();
    var best = null;
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      if (!ready(n, t)) return;
      if (!best || n.reach > best.reach || (n.reach === best.reach && n.seq < best.seq)) best = n;
    });
    return best;
  }

  function earliestWait() {
    var w = null;
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      if ((n.status === 'wait' || n.recheck) && n.retryAt != null &&
        (w == null || n.retryAt < w)) w = n.retryAt;
    });
    return w;
  }

  function leaf(n, reason) {
    n.status = 'leaf';
    n.reason = reason;
    delete n.retryAt;
    return { type: 'leaf', node: n };
  }

  function settle(n, mv, extra) {
    var old = n.child;
    Object.assign(n, extra);
    n.move = mv.san;
    n.status = 'done';
    delete n.retryAt;
    delete n.recheck;
    delete n.tries;
    delete n.error;
    // A re-search that kept its move: the line below stands, and ensure() would count
    // this move order's reach a second time.
    if (old && old === fenKey(mv.fen) && nodes[old]) return;
    n.child = ensure(mv.fen, n.ply + 1, n.reach, n.oi, (n.path || []).concat(mv.san)).key;
    if (old) prune(state);
  }

  function myStep(n) {
    return Promise.all([d.explorer(n.fen), d.chessdb(n.fen)]).then(function (r) {
      var ex = r[0], cdb = r[1];
      n.games = ex ? ex.total : 0;
      if (cdb && (cdb.status === 'checkmate' || cdb.status === 'stalemate')) {
        return leaf(n, 'game-over');
      }
      var c = pickCandidates(ex, cdb, n.fen, cfg, sopts);
      if (!c.rows.length) {
        // ChessDB knew it when it was searched; keep that search rather than lose the line.
        if (n.recheck) throw new Error('ChessDB has no eval for it now');
        n.noEval = (n.noEval || 0) + 1;
        if (n.noEval > cfg.noEvalRetries) return leaf(n, 'no-eval');
        try {
          if (d.analyse) Promise.resolve(d.analyse(n.fen)).catch(function () {});
        } catch (e) { /* a hint only */ }
        n.status = 'wait';
        n.retryAt = now() + cfg.noEvalWaitMs;
        return { type: 'no-eval', node: n };
      }
      // Too few games to say anything practical: the engine's move ends the line.
      if (n.games < cfg.stopGames) {
        settle(n, d.play(n.fen, c.best.san), { pickedBy: 'engine', why: 'few-games',
          engine: c.best.win, bestMove: c.best.san, bestEngine: c.best.win });
        return { type: 'searched', node: n };
      }

      var deep = n.ply < cfg.deepPlies;
      var opts = Object.assign({}, sopts, { maxPly: deep ? cfg.deepMaxPly : cfg.shallowMaxPly });
      var started = now();
      var spent = 0;
      var deeper = [];
      var side = sideToMove(n.fen);
      var w = cfg.weights;
      // The prepared score as win% for me, like the other two parts of the blend.
      function prepOf(res) {
        var e = res && res.prep ? expectedScore(res.prep, side) : null;
        return e != null ? e * 100 : null;
      }
      function prepsOf(rows) {
        var p = {};
        rows.forEach(function (r) {
          var e = prepOf(r.res);
          if (e != null) p[r.san] = e;
        });
        return p;
      }
      function resultsOf(out, sans) {
        var results = out && out.results;
        return sans.map(function (san) {
          return { san: san, res: results && (results.get ? results.get(san) : results[san]) };
        });
      }
      // A close call goes two plies deeper, the close rows alone, until it isn't one or
      // deeperMaxPly is reached. The deeper values replace the old ones only if every close
      // row got one at the same, greater depth; otherwise the shallower comparison stands.
      function deepen(rows, maxPly) {
        if (maxPly + 2 > cfg.deeperMaxPly) return Promise.resolve(rows);
        var band = closeBand(rows, c.shares, { weights: w, wins: c.wins, preps: prepsOf(rows),
          within: cfg.deeperWithin });
        if (!band.length) return Promise.resolve(rows);
        var o2 = Object.assign({}, opts, { maxPly: maxPly + 2 });
        return Promise.resolve(d.runRoot(n.fen, band, {
          opts: o2, budget: cfg.budgetDeeper, shares: c.shares
        })).then(function (out) {
          spent += out && out.spent || 0;
          var got = resultsOf(out, band);
          var old = rows.filter(function (r) { return band.indexOf(r.san) >= 0; });
          var from = old.reduce(function (m, r) { return Math.max(m, r.res.depth || 0); }, 0);
          // A complete row is exact at any depth; the others must all be at the new one.
          var to = got.reduce(function (m, g) {
            return g.res && !g.res.complete ? Math.max(m, g.res.depth || 0) : m;
          }, 0);
          var ok = to > from && got.every(function (g) {
            return g.res && g.res.state === 'value' && g.res.value != null &&
              (g.res.depth === to || g.res.complete);
          });
          if (!ok) return rows;
          deeper.push({ from: from, to: to, rows: band.slice() });
          var byS = {};
          got.forEach(function (g) { byS[g.san] = g.res; });
          var next = rows.map(function (r) { return byS[r.san] ? { san: r.san, res: byS[r.san] } : r; });
          return deepen(next, maxPly + 2);
        }, function (e) {
          if (isFatal(e)) throw e;
          return rows;
        });
      }
      return Promise.resolve(d.runRoot(n.fen, c.rows, {
        opts: opts, budget: deep ? cfg.budgetDeep : cfg.budget, shares: c.shares
      })).then(function (out) {
        spent += out && out.spent || 0;
        var rows = resultsOf(out, c.rows);
        var errs = rows.filter(function (r) { return !r.res || r.res.state === 'error'; });
        if (errs.length === rows.length) {
          throw (errs[0].res && errs[0].res.error) || new Error('no results');
        }
        return deepen(rows, opts.maxPly);
      }).then(function (rows) {
        var preps = prepsOf(rows);
        var pick = choose(rows, c.shares, { weights: w, wins: c.wins, preps: preps,
          cps: c.cps, within: cfg.closeWithin, cp: cfg.closeCp });
        state.searches++;
        var summary = rows.filter(function (r) { return r.res && r.res.state !== 'error'; })
          .map(function (r) {
            var b = r.res.value != null
              ? blendScore(w, c.wins[r.san], r.res.value, preps[r.san]) : null;
            return { san: r.san, state: r.res.state, value: r.res.value, depth: r.res.depth,
              complete: !!r.res.complete, stopped: r.res.stopped || null,
              engine: c.wins[r.san], share: c.shares[r.san] || 0,
              // Positions the search wanted an eval for and ChessDB didn't have: a check
              // searches these again once ChessDB has analysed them.
              analysing: r.res.analysing || 0,
              games: r.res.games != null ? r.res.games : null,
              score: c.scores[r.san] != null ? c.scores[r.san] : null,
              cp: c.cps[r.san] != null ? c.cps[r.san] : null,
              // The share of the value that rests on Maia rather than games.
              maia: r.res.maia ? r.res.maia : undefined,
              // The prepared score (win% for me; null when the search had none) and the
              // share of it that rests on the Practical value rather than games. A check
              // tells rows from before they were saved by `prep` being absent.
              prep: preps[r.san] != null ? preps[r.san] : null,
              prior: r.res.prior != null ? r.res.prior : undefined,
              // What the row was ranked by, when that isn't its Practical value.
              blend: b != null ? b : undefined };
          });
        var san = pick ? pick.san : c.best.san;
        settle(n, d.play(n.fen, san), {
          pickedBy: pick ? 'practical' : 'engine',
          why: pick ? undefined : 'no-value',
          // Won on ChessDB's eval, a floor for the Practical value it has too few games for.
          few: pick && pick.res.state === 'few' ? true : undefined,
          // A near-tie that ChessDB decided: the top row it beat, and its score.
          close: pick && pick.over ? { san: pick.over.san, value: pick.over.score,
            cp: c.cps[pick.over.san], mine: c.cps[pick.san] } : undefined,
          value: pick ? pick.res.value : null,
          // The blend it was chosen by, when not Practical alone, and its prepared score.
          blend: pick && !practicalOnly(w) ? pick.score : undefined,
          prep: pick && preps[pick.san] != null ? preps[pick.san] : undefined,
          prior: pick && pick.res.prior != null ? pick.res.prior : undefined,
          depth: pick ? pick.res.depth : 0,
          maia: pick && pick.res.maia ? pick.res.maia : undefined,
          // The rating Maia played at, when the search had Maia: a check tells searches
          // made without it by its absence.
          maiaElo: opts.maia ? opts.maiaElo : undefined,
          // The risk aversion the values were searched with; none means plain means (0), as
          // in runs from before it.
          risk: opts.riskAversion > 0 ? opts.riskAversion : undefined,
          engine: c.wins[san],
          bestMove: c.best.san,
          bestEngine: c.best.win,
          rows: summary,
          // Close calls searched deeper: from and to depth, and the rows that were.
          deeper: deeper.length ? deeper : undefined,
          ms: now() - started,
          spent: spent
        });
        return { type: 'searched', node: n };
      });
    });
  }

  function oppStep(n) {
    if (n.ply + 1 >= cfg.maxPly) return Promise.resolve(leaf(n, 'max-ply'));
    return Promise.resolve(d.explorer(n.fen)).then(function (ex) {
      n.games = ex ? ex.total : 0;
      if (n.games < cfg.stopGames) return leaf(n, 'few-games');
      var picks = pickReplies(ex, n.reach, n.oi, cfg);
      if (!picks.length) {
        var thin = !(ex.moves || []).some(function (m) { return m.games >= cfg.stopGames; });
        return leaf(n, thin ? 'thin' : 'rare');
      }
      n.replies = picks.map(function (p) {
        var mv = d.play(n.fen, p.san);
        return { san: mv.san, share: p.share, games: p.games,
          child: ensure(mv.fen, n.ply + 1, n.reach * p.share, n.oi + 1,
            (n.path || []).concat(mv.san)).key };
      });
      n.status = 'done';
      delete n.retryAt;
      return { type: 'expanded', node: n };
    });
  }

  function step() {
    var n = next();
    if (!n) {
      var w = earliestWait();
      return Promise.resolve(w != null ? { type: 'waiting', until: w } : { type: 'done' });
    }
    return (n.kind === 'me' ? myStep(n) : oppStep(n)).catch(function (e) {
      if (isFatal(e)) throw e;
      n.tries = (n.tries || 0) + 1;
      n.error = String(e && e.message || e);
      if (n.recheck) {
        // The old search stands if the new one can't be had.
        if (n.tries > cfg.errorRetries) {
          delete n.recheck;
          delete n.retryAt;
          delete n.tries;
          return { type: 'recheck-failed', node: n, error: e };
        }
        n.retryAt = now() + cfg.errorWaitMs * n.tries;
        return { type: 'retry', node: n, error: e };
      }
      if (n.tries > cfg.errorRetries) {
        var ev = leaf(n, 'error');
        ev.error = e;
        return ev;
      }
      n.status = 'wait';
      n.retryAt = now() + cfg.errorWaitMs * n.tries;
      return { type: 'retry', node: n, error: e };
    });
  }

  function counts() {
    var c = { me: 0, opp: 0, queued: 0, wait: 0, done: 0, leaf: 0, recheck: 0 };
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      c[n.kind]++;
      c[n.status]++;
      if (n.recheck) c.recheck++;
    });
    c.searches = state.searches;
    return c;
  }

  return { step: step, state: state, counts: counts, config: cfg, search: sopts };
}
