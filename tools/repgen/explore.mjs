/*
 * ChessDB exploration for a repertoire (tools/cdbexplore.mjs). ChessDB scores a position
 * it is asked to analyse with one search of about depth 22 per move, and its evals only
 * get deeper when the positions below it are in the database too: each query backs the
 * scores of the positions one move on up into it. So a line end in a repertoire, some 15
 * plies in, usually has a stored line of 4 or 5 plies behind its eval.
 *
 * This finds the positions of a PGN where that matters (targets) and builds ChessDB's tree
 * below them, the way vondele/cdbexplore does: an iterative-deepening minimax over
 * ChessDB's own scores, where a move's depth shrinks by one per `evalDecay` cp it is behind
 * the best, and positions ChessDB doesn't know are queued and waited for. After each depth
 * the best line is asked about again from its end back to the target, so ChessDB backs the
 * new scores up; at the end the same goes on up the PGN to its start.
 *
 * Pure like generator.mjs: ChessDB comes through `deps`, time through deps.now/sleep.
 * Scores are ChessDB's: centipawns for the side to move, mates near ±30000.
 *
 *   deps.queryall(fen)  -> Promise<ChessDB's queryall JSON>  (never cached)
 *   deps.queue(fen)     -> Promise<ChessDB's queue JSON>
 *   deps.sleep(ms), deps.now()
 */

import { Chess } from '../../src/vendor/chess.js';
import { fenKey, sideToMove, moveKey } from '../../src/pe/search.js';

export var EXPLORE_DEFAULTS = {
  maxEval: 300,      // cp: a position decided beyond this isn't worth exploring
  shortLine: 10,     // plies: a stored line shorter than this is a shallow eval
  close: 30,         // cp: another move this near mine makes my position a decision
  evalDecay: 2,      // cp behind the best per ply less depth (cdbexplore's default)
  minDepth: 6,       // the stability test starts here
  maxDepth: 12,
  stable: 3,         // stop when this many depths in a row agree on the move ...
  settle: 10,        // ... and their scores are this close (cp)
  unknownWait: 10 * 60 * 1000   // give up on a position ChessDB won't score after this
};

var MATE = 30000;     // ChessDB's conventions, as in cdbexplore
var CURSED = 20000;   // tablebase wins the 50-move rule spoils
var SPECIAL = 10000;  // material scores stay below this
var EGTB = 7;         // ChessDB answers from tablebases up to this many pieces
var SIEVED = 5;       // ChessDB scores at least this many moves of an analysed position
var MAX_EXT = 10;     // plies past the depth a line may be extended
var WAIT_FIRST = 5000, WAIT_MAX = 60000;

function pieces(fen) { return fen.split(' ')[0].replace(/[^a-z]/gi, '').length; }

function lanOf(m) { return m.from + m.to + (m.promotion || ''); }

/*
 * Every position of a parsed PGN (repgen/pgntree.mjs) once, transpositions merged into
 * the first, in PGN order. `side` is the repertoire's; `state` a repgen run's state, for
 * reach. Each: { key, fen, path (SANs), ply, leaf, own (my move), moves (the PGN's SANs from
 * here), reach, above (FENs from the start down to its parent) }.
 */
export function positions(game, side, state) {
  var out = [], seen = new Map();
  (function walk(nd, path, above) {
    var key = fenKey(nd.fen);
    var have = seen.get(key);
    if (have) {
      // A transposition: its moves count too (a line may go on from either place).
      nd.children.forEach(function (c) { if (have.moves.indexOf(c.san) < 0) have.moves.push(c.san); });
      have.leaf = have.leaf && !nd.children.length;
    } else {
      var sn = state && state.nodes && state.nodes[key];
      have = { key: key, fen: nd.fen, path: path, ply: path.length, leaf: !nd.children.length,
        own: sideToMove(nd.fen) === side, moves: nd.children.map(function (c) { return c.san; }),
        reach: sn && sn.reach != null ? sn.reach : null, above: above };
      seen.set(key, have);
      out.push(have);
    }
    var below = above.concat([nd.fen]);
    nd.children.forEach(function (c) { walk(c, path.concat([c.san]), below); });
  })(game.root, [], []);
  return out;
}

function scored(ans) {
  return ans && ans.status === 'ok' ? (ans.moves || []).filter(function (m) { return m.score != null; }) : [];
}

/*
 * Which positions are worth a look, from ChessDB's queryall answer for each
 * (answers: Map key -> JSON). A line end, or a position of mine where another move is
 * within `close` of the PGN's, as long as the best score is within `maxEval`. Each
 * candidate gets { reason, best: {san, score}, mine: {san, score} | null, rival }.
 */
export function candidates(list, answers, opts) {
  opts = Object.assign({}, EXPLORE_DEFAULTS, opts);
  var out = [];
  list.forEach(function (p) {
    var ms = scored(answers.get(p.key));
    if (!ms.length) return;
    var best = ms.reduce(function (a, b) { return b.score > a.score ? b : a; });
    if (Math.abs(best.score) > opts.maxEval) return;
    var c = Object.assign({}, p, { best: { san: best.san, score: best.score }, mine: null, rival: null });
    if (p.leaf) {
      c.reason = 'line end';
    } else if (p.own && !opts.leavesOnly) {
      var played = p.moves.map(moveKey);
      var isMine = function (m) { return played.indexOf(moveKey(m.san)) >= 0; };
      var mine = ms.filter(isMine);
      if (!mine.length) return;
      var m = mine.reduce(function (a, b) { return b.score > a.score ? b : a; });
      var others = ms.filter(function (x) { return !isMine(x); });
      if (!others.length) return;
      var r = others.reduce(function (a, b) { return b.score > a.score ? b : a; });
      if (Math.abs(r.score - m.score) > opts.close) return;
      c.mine = { san: m.san, score: m.score };
      c.rival = { san: r.san, score: r.score };
      c.reason = 'decision';
    } else {
      return;
    }
    out.push(c);
  });
  return out;
}

/*
 * The candidates whose stored line (querypv; pvs: Map key -> JSON) is short, likeliest
 * first: by reach when the run's state gave one, else nearest the start.
 */
export function pickTargets(cands, pvs, opts) {
  opts = Object.assign({}, EXPLORE_DEFAULTS, opts);
  return cands.filter(function (c) {
    var pv = pvs.get(c.key);
    c.line = pv && pv.status === 'ok' && pv.pv ? pv.pv.length : 0;
    return c.line < opts.shortLine;
  }).sort(function (a, b) {
    var ra = a.reach == null ? -1 : a.reach, rb = b.reach == null ? -1 : b.reach;
    return rb - ra || a.ply - b.ply;
  });
}

// A ChessDB score as the search uses it: cursed wins are draws, and mates and tablebase
// wins gain the ply the search takes off again on the way up (cdbexplore does the same).
function norm(s) {
  if (Math.abs(s) < SPECIAL) return s;
  if (Math.abs(s) <= CURSED) return 0;
  return s + (s > 0 ? 1 : -1);
}
function stepUp(s) { return Math.abs(s) > SPECIAL ? s - (s > 0 ? 1 : -1) : s; }

/*
 * explorer.explore(fen, o) with o = { above (FENs from the PGN's start to the parent),
 * deadline, onDepth(entry) } resolves to
 *   { depths: [{ depth, best (uci), score, pv }], stopped: 'stable' | 'max-depth' |
 *     'time' | 'trivial' | 'unknown', requests, queued }
 */
export function createExplorer(deps, opts) {
  opts = Object.assign({}, EXPLORE_DEFAULTS, opts);
  var tt = new Map();        // key -> { depth, status, moves: {uci: score} }
  var pending = new Map();   // key -> Promise, so parallel branches ask once
  var queuedOnce = new Set();
  var stats = { requests: 0, queued: 0 };

  function store(key, v) {
    var have = tt.get(key);
    if (!have || have.depth <= v.depth) { tt.set(key, v); return v; }
    return have;
  }

  function queue(fen) {
    stats.queued++;
    return deps.queue(fen).catch(function () { return null; });
  }

  // Past the target's deadline nothing new is asked or waited for, so a depth that is
  // waiting on queued positions winds down instead of overrunning (one took 16 minutes).
  var cutoff = Infinity;
  function late() { return deps.now() >= cutoff; }

  // ChessDB's moves for a position, waiting for one it has to analyse first. Resolves
  // null for a position it won't score (invalid, not scored within unknownWait, or past
  // the deadline).
  function ask(fen, fresh) {
    var key = fenKey(fen);
    if (!fresh) {
      var hit = tt.get(key);
      if (hit) return Promise.resolve(hit);
      if (pending.has(key)) return pending.get(key);
      if (late()) return Promise.resolve(null);
    }
    var started = deps.now(), wait = WAIT_FIRST, enqueued = false;
    function attempt() {
      stats.requests++;
      return deps.queryall(fen).then(function (j) { return j; }, function () { return null; })
        .then(function (j) {
          var st = j && j.status;
          if (st === 'ok') {
            var moves = {};
            (j.moves || []).forEach(function (m) { if (m.score != null) moves[m.uci] = norm(Number(m.score)); });
            var legal = new Chess(fen).moves().length;
            // An incomplete list: ask ChessDB to sieve the position again.
            if (Object.keys(moves).length < Math.min(SIEVED, legal) && !queuedOnce.has(key)) {
              queuedOnce.add(key);
              queue(fen);
            }
            return store(key, { depth: 0, status: 'ok', moves: moves });
          }
          if (st === 'checkmate' || st === 'stalemate') return store(key, { depth: 0, status: st, moves: {} });
          if (st === 'invalid board') return null;
          if (st === 'unknown' && !enqueued) {
            enqueued = true;
            return queue(fen).then(function (q) {
              // ChessDB queues nothing for a tablebase position with castling rights:
              // every move scores 1 and the search sorts it out (as cdbexplore).
              if (q && !q.status) {
                var ones = {};
                new Chess(fen).moves({ verbose: true }).forEach(function (m) { ones[lanOf(m)] = 1; });
                return store(key, { depth: 0, status: 'ok', moves: ones });
              }
              return again();
            });
          }
          return again();   // unknown (queued), rate limited, failed or malformed
        });
    }
    function again() {
      if (late() || deps.now() - started >= opts.unknownWait) return null;
      var w = wait;
      wait = Math.min(wait * 1.5, WAIT_MAX);
      return deps.sleep(w).then(attempt);
    }
    var p = attempt();
    if (!fresh) {
      pending.set(key, p);
      p.then(function () { pending.delete(key); });
    }
    return p;
  }

  // Terminal positions: { score, pv } or null.
  function trivial(c, key, seen) {
    if (c.isCheckmate()) return { score: -MATE, pv: ['checkmate'] };
    if (c.isStalemate() || c.isInsufficientMaterial() || Number(c.fen().split(' ')[4]) >= 100 ||
        seen.has(key)) {
      return { score: 0, pv: ['draw'] };   // a repeat on the line counts as the draw it can be
    }
    return null;
  }

  var rootDepth = 0;

  // { score, pv } for the side to move at fen, or null when ChessDB has nothing.
  function search(fen, depth, level, seen) {
    var c = new Chess(fen);
    var key = fenKey(fen);
    var t = trivial(c, key, seen);
    if (t) return Promise.resolve(t);
    return ask(fen, false).then(function (ans) {
      if (!ans) return null;
      var ucis = Object.keys(ans.moves);
      if (!ucis.length) return ans.status === 'checkmate' ? { score: -MATE, pv: ['checkmate'] }
        : ans.status === 'stalemate' ? { score: 0, pv: ['draw'] } : null;
      var best = -Infinity, worst = Infinity, bestUci = null;
      ucis.forEach(function (u) {
        var s = ans.moves[u];
        if (s > best) { best = s; bestUci = u; }
        if (s < worst) worst = s;
      });
      // Tablebase territory: ChessDB's answer is exact (a 1 means castling rights kept
      // it out of the tables).
      if (pieces(fen) <= EGTB && Math.abs(best) !== 1) {
        return { score: stepUp(best), pv: [bestUci, 'EGTB'] };
      }

      function moveDepth(s) {
        var decay = opts.evalDecay ? Math.floor((s - best) / opts.evalDecay) : (s - best) * 1e6;
        return depth + decay - 1;
      }
      var toSearch = ucis.filter(function (u) { return moveDepth(ans.moves[u]) >= 0; }).length;

      var here = new Set(seen);
      here.add(key);
      var jobs = [], allowExt = true, drawSeen = false;
      var result = {}, pvs = {};
      c.moves({ verbose: true }).forEach(function (m) {
        var u = lanOf(m), s = ans.moves[u];
        if (s == null) return;   // unscored moves stay out (cdbexplore only reaches them far deeper)
        var nd = moveDepth(s);
        if (s === best && toSearch === 1 && depth > 4) nd++;   // the only move worth a look
        if (nd >= 0 && level >= rootDepth + MAX_EXT) {
          if (!allowExt || s < best) nd = -1; else allowExt = false;
        }
        // A drawn position grows along one line, not all of them.
        if (best === 0 && s === 0) { if (drawSeen) nd--; else drawSeen = true; }
        result[u] = s;
        pvs[u] = [u];
        if (nd < 0) return;
        var after = new Chess(fen);
        after.move({ from: m.from, to: m.to, promotion: m.promotion });
        jobs.push(search(after.fen(), nd, level + 1, here).then(function (r) {
          if (!r) return;
          result[u] = -r.score;
          pvs[u] = [u].concat(r.pv);
        }));
      });
      return Promise.all(jobs).then(function () {
        store(key, { depth: depth, status: 'ok', moves: result });
        var bs = -Infinity, bu = null;
        Object.keys(result).forEach(function (u) {
          if (result[u] > bs || (result[u] === bs && pvs[u].length > pvs[bu].length)) { bs = result[u]; bu = u; }
        });
        return { score: stepUp(bs), pv: pvs[bu] };
      });
    });
  }

  function fensAlong(fen, pv) {
    var c = new Chess(fen), out = [fen];
    for (var i = 0; i < pv.length; i++) {
      if (pv[i] === 'checkmate' || pv[i] === 'draw' || pv[i] === 'EGTB') break;
      var u = pv[i];
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(c.fen());
    }
    return out;
  }

  // Ask again from the far end back: each query backs ChessDB's scores up one move.
  function reprobe(fens) {
    return fens.slice().reverse().reduce(function (p, f) {
      return p.then(function () { return ask(f, true); });
    }, Promise.resolve());
  }

  function settled(hist) {
    if (hist.length < opts.stable) return false;
    var last = hist.slice(-opts.stable);
    if (last[last.length - 1].depth < opts.minDepth) return false;
    var scores = last.map(function (h) { return h.score; });
    return last.every(function (h) { return h.best === last[0].best; }) &&
      Math.max.apply(null, scores) - Math.min.apply(null, scores) <= opts.settle;
  }

  function explore(fen, o) {
    o = o || {};
    var above = o.above || [];
    var seen = new Set(above.map(fenKey));
    var hist = [];
    var before = { requests: stats.requests, queued: stats.queued };
    cutoff = o.deadline != null ? o.deadline : Infinity;
    function done(stopped) {
      return reprobe(above).then(function () {
        return { depths: hist, stopped: stopped, requests: stats.requests - before.requests,
          queued: stats.queued - before.queued };
      });
    }
    var root = new Chess(fen);
    if (trivial(root, fenKey(fen), seen)) return done('trivial');
    function next(depth) {
      if (late()) return done('time');
      rootDepth = depth;
      return search(fen, depth, 0, seen).then(function (r) {
        // A depth cut short by the deadline is missing lines: it doesn't count.
        if (late()) return done('time');
        if (!r || !r.pv.length || /^(checkmate|draw|EGTB)$/.test(r.pv[0])) {
          return done(r ? 'trivial' : 'unknown');
        }
        var h = { depth: depth, best: r.pv[0], score: r.score, pv: r.pv };
        hist.push(h);
        if (o.onDepth) o.onDepth(h);
        return reprobe(fensAlong(fen, r.pv)).then(function () {
          if (settled(hist)) return done('stable');
          if (depth >= opts.maxDepth) return done('max-depth');
          return next(depth + 1);
        });
      });
    }
    return next(1);
  }

  return { explore: explore, stats: stats };
}

// A UCI move as SAN in fen, for reports.
export function sanOf(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch (e) { return uci; }
}
