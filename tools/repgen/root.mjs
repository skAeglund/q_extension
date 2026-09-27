/*
 * One of my positions, searched the way the Practical column searches it: the column's
 * own lockstep rounds (src/pe/rounds.js) over the shared providers. This is
 * background.js's startRoot without the port, the tab and Maia.
 *
 * o = { providers, filter, child(fen, san) -> fen, analyseMax }
 * Returns runRoot(fen, rows, { opts, budget, shares }) -> Promise<{ results, spent }>,
 * results a Map of each row's last published result. A row that failed outright has
 * { state: 'error', error }.
 */

import { createRootSearch } from '../../src/pe/rounds.js';

export function makeRunRoot(o) {
  var providers = o.providers;
  var analyseMax = o.analyseMax == null ? 30 : o.analyseMax;

  return function runRoot(fen, rows, x) {
    var budget = { limit: x.budget, spent: 0 };
    var shares = x.shares || {};
    var analysed = 0;
    var results = new Map();

    function makeProvider(san, isAborted, counts) {
      var share = shares[san] || 0.01;
      // Identical requests from different rows share one fetch; if the row that queued
      // it is abandoned, the others get a cancellation they didn't ask for: ask again.
      function retrying(call) {
        var tries = 0;
        return (function go() {
          return call().catch(function (e) {
            if (e && e.cancelled && !isAborted() && tries++ < 3) return go();
            throw e;
          });
        })();
      }
      return {
        explorer: function (f, info) {
          var first = !info || info.plies === 1;
          var ctx = { budget: budget, exempt: first, counts: counts,
            priority: (first ? 10 : 0) + share * (info ? info.reach : 1) };
          return retrying(function () { return providers.explorer(f, o.filter, isAborted, ctx); });
        },
        chessdb: function (f) {
          return retrying(function () { return providers.chessdb(f, isAborted); });
        },
        analyse: function (f, s) {
          if (analysed >= analyseMax || !providers.analyse) return Promise.resolve(false);
          // A move needs ChessDB's spelling of it (castling is e1g1); without it, asking
          // about the position instead would be the wrong request.
          var uci = null;
          try { uci = s && o.uci ? o.uci(f, s) : null; } catch (e) { uci = null; }
          if (s && !uci) return Promise.resolve(false);
          analysed++;
          return providers.analyse(f, uci).then(function (sent) {
            if (!sent) analysed--;
            return sent;
          }, function () { return false; });
        },
        child: o.child
      };
    }

    var search = createRootSearch({
      rootFen: fen,
      opts: x.opts,
      budget: budget,
      makeProvider: makeProvider,
      onResult: function (san, res) { results.set(san, res); },
      onError: function (san, e) {
        results.set(san, { state: 'error', error: e, reason: String(e && e.message || e),
          final: true });
      }
    });
    search.add(rows);
    return search.done().then(function () { return { results: results, spent: budget.spent }; });
  };
}
