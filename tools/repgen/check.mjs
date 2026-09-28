/*
 * Repertoire check: asks ChessDB again about every position of mine in a run, and
 * decides what its newer evals change. Lines end where ChessDB knew least, and it goes on
 * analysing what the search asked it to, so a run checked days later can differ.
 *
 * Pure like generator.mjs: ChessDB and the explorer come through `deps`, and the caller
 * makes sure deps.chessdb answers from after the check started (repgen.mjs does it with
 * the cache's freshSince).
 *
 *   deps.explorer(fen)  as in generator.mjs (cached: the games haven't changed)
 *   deps.chessdb(fen)   fresh
 *   deps.analyse(fen)   optional: ask ChessDB again about a position it still doesn't know
 *
 * What a position of mine gets:
 *   - Its engine values (ChessDB's view of my move and of its best) are brought up to
 *     date, and with them the PGN's !?, ?! and ?? marks. No search needed.
 *   - A search again (`recheck`, see generator.mjs) when the new evals could change the
 *     pick: a move ChessDB now rates close enough to be a candidate, my move no longer
 *     being one, positions the last search found without an eval, or ChessDB's best
 *     changing where its best was played. With Maia now on for the run, a search made
 *     without it where a move had fewer games than Maia starts at. With `all`, every
 *     searched position.
 *   - Back in the queue when it ended for want of an eval that ChessDB now has, or
 *     because the last try failed.
 */

import { sideToMove, moveKey, scoreToRootWin } from '../../src/pe/search.js';
import { pickCandidates, choose, reachable, REPGEN_DEFAULTS, SEARCH_DEFAULTS } from './generator.mjs';
import { engineLoss, markFor, pawns } from './pgn.mjs';

function win(x) { return x == null ? '?' : x.toFixed(1); }

// ChessDB's view of one of my moves, in win% for me, or undefined without an eval.
function engineOf(cdb, fen, san) {
  if (!cdb || cdb.status !== 'ok') return undefined;
  var m = (cdb.moves || []).find(function (x) { return moveKey(x.san) === moveKey(san); });
  return m ? scoreToRootWin(m.score, fen, sideToMove(fen)) : undefined;
}

// The same in centipawns (my node: ChessDB's score is already mine), or null.
function cpOf(cdb, san) {
  if (!cdb || cdb.status !== 'ok') return null;
  var m = (cdb.moves || []).find(function (x) { return moveKey(x.san) === moveKey(san); });
  return m ? m.score : null;
}

// How many of a search's moves had fewer than `until` games: all of them in a position
// with fewer, else those whose saved games say so, or that had too few for a value (runs
// from before rows saved their games).
function thinRows(n, until) {
  var rows = n.rows || [];
  if (n.games != null && n.games < until) return rows.length || 1;
  return rows.filter(function (r) {
    return r.state === 'few' || (r.games != null && r.games < until);
  }).length;
}

/*
 * One position of mine against ChessDB's answer now. Returns
 *   { action: null | 'recheck' | 'queue', reasons: [...], engine: {...} | null,
 *     markFrom, markTo, still }
 * `engine` is what to write into the node ({ engine, bestMove, bestEngine, rows }), null
 * when ChessDB has nothing to say. `still` is 'no-eval' for a position it still doesn't
 * know.
 */
export function assess(n, ex, cdb, cfg, sopts, all) {
  var out = { action: null, reasons: [], engine: null, markFrom: '', markTo: '', still: null };
  var known = cdb && cdb.status === 'ok' && (cdb.moves || []).length > 0;

  if (n.status === 'leaf') {
    if (n.reason === 'no-eval') {
      if (known) { out.action = 'queue'; out.reasons.push('ChessDB knows this position now'); }
      else out.still = 'no-eval';
    } else if (n.reason === 'error') {
      out.action = 'queue';
      out.reasons.push('the last try failed (' + (n.error || 'error') + ')');
    }
    return out;
  }
  if (n.status !== 'done' || !n.move || !known) return out;

  var c = pickCandidates(ex, cdb, n.fen, cfg, sopts);
  var best = c.best;
  var rows = (n.rows || []).map(function (r) {
    var e = engineOf(cdb, n.fen, r.san);
    return Object.assign({}, r, { engine: e, cp: cpOf(cdb, r.san) });
  });
  out.engine = { engine: engineOf(cdb, n.fen, n.move), bestMove: best.san,
    bestEngine: best.win, rows: n.rows ? rows : undefined };
  out.markFrom = markFor(engineLoss(n), cfg);
  out.markTo = markFor(engineLoss(Object.assign({}, n, out.engine)), cfg);

  if (n.pickedBy === 'practical' || n.why === 'no-value') {
    var had = new Set((n.rows || []).map(function (r) { return moveKey(r.san); }));
    c.rows.filter(function (san) { return !had.has(moveKey(san)); }).forEach(function (san) {
      out.reasons.push('new candidate ' + san + ' (engine ' + win(c.wins[san]) + ')');
    });
    if (n.pickedBy === 'practical' &&
      !c.rows.some(function (san) { return moveKey(san) === moveKey(n.move); })) {
      out.reasons.push(n.move + ' is no longer a candidate (engine ' + win(out.engine.engine) + ')');
    }
    // The last search's own rows, picked by today's choose() on today's ChessDB evals:
    // runs from before moves with too few games competed on ChessDB's eval passed those
    // over, and a near-tie can go the other way now.
    var cps = {};
    rows.forEach(function (r) { if (r.cp != null) cps[r.san] = r.cp; });
    var again = choose((n.rows || []).map(function (r) {
      return { san: r.san, res: { state: r.state, value: r.value, depth: r.depth,
        complete: r.complete } };
    }), (n.rows || []).reduce(function (m, r) { m[r.san] = r.share || 0; return m; }, {}),
    { cps: cps, within: cfg.closeWithin, cp: cfg.closeCp });
    if (again && moveKey(again.san) !== moveKey(n.move)) {
      if (again.res.state === 'few') {
        out.reasons.push(again.san + ' has too few games for a Practical value, but its engine ' +
          win(again.res.value) + ' beats ' + n.move + '\'s ' + win(n.value));
      } else if (again.over) {
        out.reasons.push(again.san + ' is within ' + win(again.over.res.value - again.res.value) +
          ' of ' + again.over.san + '\'s Practical value, and ChessDB rates it ' +
          pawns(cps[again.san]) + ' vs ' + pawns(cps[again.over.san]));
      } else if (n.close) {
        out.reasons.push(n.move + ' won a near-tie on ChessDB\'s eval, which no longer decides it (' +
          pawns(cps[n.move]) + ' vs ' + again.san + ' ' + pawns(cps[again.san]) + ')');
      }
    }
    var missing = (n.rows || []).reduce(function (s, r) { return s + (r.analysing || 0); }, 0);
    if (missing) {
      out.reasons.push(missing + ' position' + (missing === 1 ? '' : 's') +
        ' had no ChessDB eval in the last search');
    }
    // Maia turned on for a run searched without it: where a move had fewer games than
    // Maia starts at, its value was a leaf's (or ChessDB's alone) and is now a blend.
    // Deeper thin positions under well-played moves count for less, and wait for
    // --check-all.
    if (sopts.maia && n.maiaElo == null) {
      var thin = thinRows(n, sopts.maiaUntil);
      if (thin) {
        out.reasons.push('searched without Maia, and ' + thin + ' move' + (thin === 1 ? ' has' : 's have') +
          ' under ' + sopts.maiaUntil + ' games');
      }
    }
  }
  if (n.pickedBy === 'engine' && moveKey(best.san) !== moveKey(n.move)) {
    out.reasons.push('ChessDB\'s best is now ' + best.san + ' (' + win(best.win) + '), was ' +
      n.move + ' (' + win(n.engine) + ')');
  }
  if (!out.reasons.length && all && n.pickedBy === 'practical') out.reasons.push('--check-all');
  if (out.reasons.length) out.action = 'recheck';
  return out;
}

/*
 * o = { state, config, search, deps, all, onNode(n, result) }
 * Looks at every position of mine in the repertoire, most likely first, and resolves to
 * [{ node, result }] for those with something to report. Changes nothing: that is
 * apply()'s job, so a dry run is this alone.
 */
export function runCheck(o) {
  var state = o.state;
  var cfg = Object.assign({}, REPGEN_DEFAULTS, o.config || state.config || {});
  var sopts = Object.assign({}, SEARCH_DEFAULTS, o.search || state.search || {});
  var d = o.deps;
  var keys = reachable(state).filter(function (k) {
    var n = state.nodes[k];
    return n.kind === 'me' && (n.status === 'done' || n.status === 'leaf') &&
      n.reason !== 'game-over';
  });
  var found = [];
  var i = 0;
  function next() {
    if (i >= keys.length) return Promise.resolve(found);
    var n = state.nodes[keys[i++]];
    var needsGames = n.status === 'done';
    return Promise.all([needsGames ? d.explorer(n.fen) : null, d.chessdb(n.fen)]).then(function (r) {
      var res = assess(n, r[0], r[1], cfg, sopts, o.all);
      if (res.still === 'no-eval' && d.analyse) {
        try { Promise.resolve(d.analyse(n.fen)).catch(function () {}); } catch (e) { /* a hint */ }
      }
      var engineMoved = res.engine && (res.engine.engine !== n.engine ||
        res.engine.bestMove !== n.bestMove || res.engine.bestEngine !== n.bestEngine);
      if (res.action || engineMoved || res.still) found.push({ node: n, result: res });
      if (o.onNode) o.onNode(n, res);
      return next();
    });
  }
  return next().then(function () { return { checked: keys.length, found: found }; });
}

// What a search keeps on the node, cleared when a failed position goes back in the queue.
var SEARCH_FIELDS = ['noEval', 'tries', 'error', 'reason', 'retryAt'];

/*
 * Writes a check's findings into the state: engine values everywhere, `recheck` (and
 * what the move was, `checkPrev`) where a search is due, and the queue for failed
 * positions. Returns counts for the log.
 */
export function apply(state, found) {
  var c = { recheck: 0, queued: 0, marks: 0, engine: 0 };
  // outcome() reports on this check only.
  Object.keys(state.nodes).forEach(function (k) {
    var n = state.nodes[k];
    if (n.checkPrev && !n.recheck && n.status !== 'queued' && n.status !== 'wait') delete n.checkPrev;
  });
  found.forEach(function (f) {
    var n = f.node, r = f.result;
    if (r.engine) {
      n.engine = r.engine.engine;
      n.bestMove = r.engine.bestMove;
      n.bestEngine = r.engine.bestEngine;
      if (r.engine.rows) n.rows = r.engine.rows;
      c.engine++;
      if (r.markFrom !== r.markTo) c.marks++;
    }
    if (r.action === 'recheck') {
      // A second check before the first one's searches are done keeps the older move.
      if (!n.recheck) {
        n.checkPrev = { move: n.move, pickedBy: n.pickedBy, value: n.value, depth: n.depth };
      }
      n.recheck = true;
      delete n.retryAt;
      delete n.tries;
      c.recheck++;
    } else if (r.action === 'queue') {
      SEARCH_FIELDS.forEach(function (k) { delete n[k]; });
      n.status = 'queued';
      n.checkPrev = { move: null };
      c.queued++;
    }
  });
  return c;
}

/*
 * After the searches: what became of the positions the last check sent back.
 *   changed  searched again, and another move won
 *   added    had ended without a move, and now have one
 *   kept     same move, or ended again
 *   pending  not searched yet
 */
export function outcome(state) {
  var o = { pending: 0, changed: [], added: [], kept: 0 };
  Object.keys(state.nodes).forEach(function (k) {
    var n = state.nodes[k];
    if (!n.checkPrev) return;
    if (n.recheck || n.status === 'queued' || n.status === 'wait') o.pending++;
    else if (n.checkPrev.move == null) {
      if (n.status === 'done') o.added.push(n); else o.kept++;
    } else if (n.move !== n.checkPrev.move) o.changed.push(n);
    else o.kept++;
  });
  return o;
}
