/*
 * Practical eval - deepening a root position's rows in lockstep rounds.
 *
 * Deeper values drift upwards (search.js, myNode), so the table only compares rows at
 * one depth. Every row finishes a round before any row starts the next: round 1 is each
 * row's direct replies, and each later round adds a full move (depth 1, 3, 5 below the
 * row). A round's values are published together when the last row finishes it; only
 * round 1 is published row by row, so the first values appear fast.
 *
 * Pure like search.js: the provider comes from `makeProvider`, so Node tests can drive it.
 *
 * o = {
 *   rootFen, opts,                          opts as for evaluateRow, plus maxPly
 *   makeProvider(san, isAborted, counts)    a provider for one row; its requests must be
 *                                           dropped once isAborted() is true, and each
 *                                           explorer call must bump counts.hits (cache)
 *                                           or counts.misses (a request)
 *   budget: { limit, spent }                the root's explorer budget, if any
 *   onResult(san, res), onError(san, e)     res as from evaluateRow, plus `final`,
 *                                           `complete` and `stopped`
 *   isStale()                               true once the root is no longer wanted
 * }
 *
 * A row is `complete` when a deeper search could not change it (nothing was cut off by
 * depth). The table stops when every row is complete, at maxPly, or on the budget:
 *   - before a round, if the remaining budget can't roughly pay for it. The estimate is
 *     the lines the last round cut off by depth, scaled by that round's cache-miss rate,
 *     so a revisit whose positions are cached still goes deeper.
 *   - during a round, if a request is refused. The round is abandoned and every row stays
 *     at the last round they all completed; the abandoned round's responses are cached,
 *     so coming back finishes it cheaply.
 * Either way the last completed round is re-sent as final, with `stopped` saying why.
 *
 * A row added later (a click) catches up round by round to the table's depth, published
 * as it goes, and then joins the round in progress. A row removed (a right-click) stops
 * at once, and the round no longer waits for it.
 */

import { evaluateRow, PE_DEFAULTS } from './search.js';

export function createRootSearch(o) {
  var opts = Object.assign({}, PE_DEFAULTS, o.opts || {});
  var maxDepth = Math.max(1, (opts.maxPly || 2) - 1);
  var isStale = o.isStale || function () { return false; };
  var order = [];            // rows in the order they were asked for
  var bySan = new Map();
  var common = 0;            // the last round every row completed
  var finished = null;       // once stopped: the reason ('' when every row is complete)
  var abort = { aborted: false };
  var counts = { hits: 0, misses: 0 };
  var loop = null;
  var tails = [];

  var NEVER = { aborted: false };   // round 1 is never abandoned: every row gets a value

  function publish(row, d, extra) {
    var res = row.results[d];
    if (!res || isStale() || row.removed) return;
    var out = Object.assign({}, res, extra);
    row.shownFinal = !!out.final;
    o.onResult(row.san, out);
  }

  // What to say about a row published at depth d while the table is running or stopped.
  function status(row, d) {
    if (row.complete && d === row.depth) return { final: true, complete: true };
    if (finished !== null && d >= common) {
      return finished ? { final: true, stopped: finished } : { final: true };
    }
    return { final: false };
  }

  function iterate(row, d) {
    var ab = d === 1 ? NEVER : abort;
    var provider = o.makeProvider(row.san, function () { return ab.aborted || row.removed; },
      counts);
    return evaluateRow(provider, o.rootFen, row.san, d, opts).then(function (res) {
      row.results[d] = res;
      row.depth = d;
      if (res.state !== 'value' || res.frontier === 0) row.complete = true;
      // Round 1, and catching up to a depth the table already shows, go out at once. A
      // deeper value waits for its round, so rows are only ever compared like with like.
      if (d === 1 || d <= common) publish(row, d, status(row, d));
    });
  }

  function upTo(row, D) {
    row.chain = row.chain.then(function step() {
      if (isStale() || row.removed || row.failed || row.roundErr || row.complete ||
          row.depth >= D) return;
      var d = row.depth ? row.depth + 2 : 1;
      return iterate(row, d).then(step, function (e) {
        if (row.removed) return;              // taken out by the user; not an error
        if (!row.depth) {
          // No value at all: an error for this row only.
          row.failed = e;
          if (!isStale() && !(e && e.cancelled)) o.onError(row.san, e);
          return;
        }
        // Later rounds: the rest of this round is pointless now.
        row.roundErr = e;
        abort.aborted = true;
      });
    });
    return row.chain;
  }

  // Waits for every row, including ones added while it waits.
  var added = 0;
  function settle(D) {
    var list = order.slice();
    var seen = added;
    return Promise.all(list.map(function (r) { return upTo(r, D); })).then(function () {
      if (added > seen) return settle(D);
    });
  }

  function lastAtOrBelow(row, d) {
    for (var x = Math.min(d, row.depth); x >= 1; x -= 2) if (row.results[x]) return x;
    return 0;
  }

  function stop(reason) {
    finished = reason;
    order.forEach(function (r) {
      if (r.failed) return;
      var d = lastAtOrBelow(r, common);
      if (!d || (r.shownFinal && r.complete)) return;
      if (r.complete && d === r.depth) publish(r, d, { final: true, complete: true });
      else publish(r, d, reason ? { final: true, stopped: reason } : { final: true });
    });
  }

  function round(D) {
    if (isStale()) return Promise.resolve();
    abort = { aborted: false };
    counts = { hits: 0, misses: 0 };
    return settle(D).then(function () {
      if (isStale()) return;
      var errs = order.map(function (r) { return r.roundErr; }).filter(Boolean);
      if (errs.length) {
        return stop(errs.some(function (e) { return e.budget; }) ? 'budget' : 'error');
      }
      common = D;
      var live = order.filter(function (r) { return !r.complete && !r.failed; });
      if (!live.length) return stop('');
      if (D + 2 > maxDepth) return stop('maxPly');
      if (o.budget) {
        var frontier = live.reduce(function (s, r) {
          return s + ((r.results[D] && r.results[D].frontier) || 0);
        }, 0);
        var seen = counts.hits + counts.misses;
        var est = seen ? Math.ceil(frontier * counts.misses / seen) : frontier;
        if (est > o.budget.limit - o.budget.spent) return stop('budget');
      }
      // The round's values, held back until now. Round 1 went out row by row.
      if (D > 1) {
        order.forEach(function (r) { if (r.depth === D) publish(r, D, status(r, D)); });
      }
      return round(D + 2);
    });
  }

  function add(sans) {
    (sans || []).forEach(function (san) {
      if (bySan.has(san)) return;
      var row = { san: san, results: {}, depth: 0, chain: Promise.resolve() };
      bySan.set(san, row);
      order.push(row);
      added++;
      if (finished !== null) {
        // The table has stopped: bring the newcomer to the table's depth, then finish it.
        tails.push(upTo(row, Math.max(common, 1)).then(function () {
          var d = lastAtOrBelow(row, common || 1);
          if (!d || row.shownFinal) return;
          // Short of the table's depth only if a request failed or the budget ran out.
          var short = d < common && !(row.complete && d === row.depth);
          publish(row, d, short ? { final: true,
            stopped: row.roundErr && !row.roundErr.budget ? 'error' : 'budget' } : status(row, d));
        }));
      }
    });
    if (!loop) loop = round(1);
  }

  /*
   * The user took a row out. Its waiting requests are dropped (isAborted), the round no
   * longer waits for it, and it is left out of the budget estimate. Adding it again
   * starts it afresh. Returns whether it was still running.
   */
  function remove(san) {
    var row = bySan.get(san);
    if (!row) return false;
    bySan.delete(san);
    order.splice(order.indexOf(row), 1);
    row.removed = true;
    return !row.shownFinal && !row.failed;
  }

  return {
    add: add,
    remove: remove,
    // Resolves once the rounds, and any rows added after they stopped, have settled.
    done: function () {
      return (loop || Promise.resolve()).then(function () { return Promise.all(tails); });
    }
  };
}
