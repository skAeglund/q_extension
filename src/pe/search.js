/*
 * Practical eval - the search and the metric.
 *
 * Pure: no chrome.* APIs, no fetch, no timers. Everything the search needs from the
 * outside world comes through the provider passed in, so Node tests can drive it with
 * fake data (test/harness.js).
 *
 *   provider.explorer(fen, info) -> { total, moves: [{ uci, san, games, white, draws, black }] }
 *   provider.chessdb(fen, info)  -> { status: 'ok' | 'unknown' | 'checkmate' | 'stalemate' | ...,
 *                                     moves: [{ uci, san, score }] }   score: cp, side to move
 *   provider.child(fen, san)     -> the FEN after playing `san`
 *   provider.analyse(fen, san?)  optional, fire and forget: ask ChessDB to analyse a
 *                                position it doesn't know, or a move it has no eval for
 *   provider.maia(fen, info)     optional: Maia's policy, [{ san, prob }], or null when
 *                                unavailable. Used only with opts.maia.
 *
 * info = { reach, plies }: the node's probability of being reached, and the iteration's
 * depth. The search doesn't need either answered differently; the worker uses them to
 * order and budget requests. A provider may reject with `e.budget` to end deepening.
 *
 * All values are win% (0-100) for the side to move at the root - "me". Evals are
 * converted to win% before anything is averaged, because centipawns are not linear in
 * practical outcome.
 *
 * Every node returns an object rather than a bare number, so a second metric rides along
 * the same tree walk: the prepared score (`prep`, below), built from the explorer's
 * white/draws/black counts the search already has in hand.
 *
 * Prepared score. The explorer's own results include every later mistake by the side that
 * played a move. The prepared split recomputes them as if I play the Practical choice at
 * each of my turns, while opponents keep their real replies. Same tree, same weights, same
 * move choices; only the leaves differ: game results, shrunk towards the Practical value
 * by `prepPriorGames` pseudo-games (see leafSplit). It is kept as { w, d, b } fractions in
 * White/Black terms, as the panel's bars draw it. `prior` is the share of it that rests on
 * the Practical value rather than on games. It never picks, prunes or orders anything, and
 * never calls the provider: with opts.prep off the requests are exactly the same.
 */

export var PE_DEFAULTS = {
  replyThreshold: 0.03,    // replies with at least this share are recursed into
  minGames: 50,            // without Maia, an opponent node with fewer games is a leaf
  skipExplorerBelow: 10,   // without Maia, below a move with fewer games: no explorer call
  maia: false,             // Maia fills in thin positions (the provider must have .maia)
  maiaElo: 2150,
  maiaUntil: 100,          // Maia weighs in below this many games...
  maiaOnlyBelow: 10,       // ...and alone below this many
  maiaWeight: 20,          // Maia's weight in pseudo-games, just above maiaOnlyBelow
  maiaOnly: false,         // Maia's predictions alone, no explorer at all: the preview
                           // background.js runs while the Lichess search deepens
  alpha: 4,                // smoothing: w = games + alpha / k over the k used replies
  reachFloor: 0.02,        // nodes below this reach are not expanded
  maxPly: 6,               // deepening cap, from the root: the row move is ply 1
  ownMargin: 5,            // my candidates: within this many win% points of the best
  ownMaxCandidates: 3,
  compareReachMin: 0.10,   // my alternatives are compared only on lines reached this often
  preferBestWithin: 1,     // keep the ChessDB best unless another beats it by more
  prep: true,              // compute the prepared split alongside the Practical value
  prepPriorGames: 50,      // k: games' worth of trust in the Practical value at a leaf
  riskAversion: 0.05       // lambda of riskMean at opponent nodes; 0: the plain mean
};

// ChessDB encodes mate as +-(30000 - plies). Anything this large is a mate score.
var MATE_THRESHOLD = 29000;

// The Lichess curve - the same constant the page's own calculateWinningPercentage uses.
export function winFromCp(cp) {
  if (cp >= MATE_THRESHOLD) return 100;
  if (cp <= -MATE_THRESHOLD) return 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function sideToMove(fen) {
  return String(fen || '').split(' ')[1] === 'b' ? 'b' : 'w';
}

// First four FEN fields: placement, side, castling, en passant. Same key as the page's
// _repStripFen, so the move counters never split a cache entry.
export function fenKey(fen) {
  return String(fen || '').trim().split(/\s+/).slice(0, 4).join(' ');
}

// A ChessDB score is from the side to move at `fen`. Flip it whenever that is not the
// root player. This is the easiest bug to make here, so it has its own tests.
export function scoreToRootWin(score, fen, rootSide) {
  var cp = sideToMove(fen) === rootSide ? score : -score;
  return winFromCp(cp);
}

// Castling is the one move the two APIs spell differently in UCI: the explorer uses
// king-takes-rook (e1h1), ChessDB the king's destination (e1g1). SAN agrees, so key on
// SAN with check/mate marks dropped.
export function moveKey(san) {
  return String(san || '').replace(/[+#?!]+$/, '');
}

// Engine value of a position from ChessDB alone: the side to move plays its best move.
function engineWinOf(cdb, fen, rootSide) {
  if (!cdb) return null;
  if (cdb.status === 'checkmate') return sideToMove(fen) === rootSide ? 0 : 100;
  if (cdb.status === 'stalemate') return 50;
  if (cdb.status !== 'ok' || !cdb.moves || !cdb.moves.length) return null;
  var best = -Infinity;
  for (var i = 0; i < cdb.moves.length; i++) {
    if (cdb.moves[i].score > best) best = cdb.moves[i].score;
  }
  return scoreToRootWin(best, fen, rootSide);
}

function evalMap(cdb, fen, rootSide) {
  var m = new Map();
  if (!cdb || cdb.status !== 'ok' || !cdb.moves) return m;
  cdb.moves.forEach(function (x) {
    m.set(moveKey(x.san), { san: x.san, uci: x.uci, score: x.score,
      win: scoreToRootWin(x.score, fen, rootSide) });
  });
  return m;
}

/* ------------------------------------------------------------ prepared score */

function isCount(x) { return typeof x === 'number' && isFinite(x) && x >= 0; }

// A move's results as counts { w, d, b, n }, or null when they can't be trusted: a
// response whose white + draws + black doesn't add up to its games has no usable counts.
export function moveCounts(m) {
  if (!m || !isCount(m.white) || !isCount(m.draws) || !isCount(m.black)) return null;
  var n = m.white + m.draws + m.black;
  if (n !== m.games) return null;
  return { w: m.white, d: m.draws, b: m.black, n: n };
}

// A position's own results: its white/draws/black when present and consistent, else the
// sum over its moves. Never a refetch.
export function positionCounts(ex) {
  if (!ex) return null;
  if (isCount(ex.white) && isCount(ex.draws) && isCount(ex.black) &&
      ex.white + ex.draws + ex.black === ex.total) {
    return { w: ex.white, d: ex.draws, b: ex.black, n: ex.total };
  }
  var s = { w: 0, d: 0, b: 0, n: 0 };
  var any = false;
  (ex.moves || []).forEach(function (m) {
    var c = moveCounts(m);
    if (!c) return;
    any = true;
    s.w += c.w; s.d += c.d; s.b += c.b; s.n += c.n;
  });
  return any ? s : null;
}

// Counts as fractions, or null when there are no games.
export function splitOf(c) {
  if (!c || !(c.n > 0)) return null;
  return { w: c.w / c.n, d: c.d / c.n, b: c.b / c.n };
}

// The draw rate a leaf with no games of its own borrows: this node's when it has games,
// else what it inherited.
function drawRateOf(c, inherited) {
  return c && c.n > 0 ? c.d / c.n : inherited;
}

/*
 * A leaf's prepared split: its game results, shrunk towards a prior Q built from its
 * Practical value v (root win%). v is an expected score, so Q keeps the draw rate `dr`
 * and puts the rest where the expected score says: Q_w + Q_d / 2 = P_w. The clamp keeps
 * both decisive shares in [0, 1] near 0 and 100.
 *
 *   S = (N·E + k·Q) / (N + k),  prior = k / (N + k)   (1 with no games: S = Q)
 */
export function leafSplit(counts, v, rootSide, dr, k) {
  var pw = rootSide === 'b' ? 1 - v / 100 : v / 100;
  pw = Math.min(1, Math.max(0, pw));
  var d = Math.min(dr || 0, 2 * pw, 2 * (1 - pw));
  var qw = pw - d / 2;
  var q = { w: qw, d: d, b: 1 - qw - d };
  var n = counts && counts.n > 0 ? counts.n : 0;
  if (!n) return { prep: q, prior: 1, leafGames: 0 };
  var t = n + k;
  return {
    prep: { w: (counts.w + k * q.w) / t, d: (counts.d + k * q.d) / t, b: (counts.b + k * q.b) / t },
    prior: k / t,
    leafGames: n
  };
}

// Counts as the split plus its games, for result messages.
function rawOf(c) {
  var s = splitOf(c);
  return s ? { w: s.w, d: s.d, b: s.b, n: c.n } : null;
}

// The root side's expected score from a split, as a fraction.
export function expectedScore(split, rootSide) {
  if (!split) return null;
  return (rootSide === 'b' ? split.b : split.w) + split.d / 2;
}

/*
 * An opponent node's value: a risk-averse mean of its replies (the certainty equivalent
 * under exponential utility), with lambda per win% point:
 *
 *   -(1/lambda) ln( sum w_i exp(-lambda v_i) / sum w_i )
 *
 * lambda 0 is the plain weighted mean. Above it, replies good for me count for less than
 * their share and replies good for the opponent for more, so a position whose common
 * reply is sound and whose tail is blunders is worth less than its mean. Asked for on
 * 2026-09-30: 82% of games at 48 and the rest at 82+ has a mean of 54, but the user
 * would rather have a position whose common replies all give 50-55. At lambda 0.05 that
 * row is worth 51.2 and a 50/55 split 52.3. The mean counts the blunders at the rate
 * the whole rating filter makes them; they are the part that fades against stronger or
 * forewarned opponents. Shifted by the smallest value, so exp never underflows.
 */
export function riskMean(items, lambda) {
  var sw = 0, swv = 0, lo = Infinity;
  items.forEach(function (x) {
    sw += x.w; swv += x.w * x.v;
    if (x.v < lo) lo = x.v;
  });
  if (!(sw > 0)) return null;
  if (!(lambda > 0)) return swv / sw;
  var se = 0;
  items.forEach(function (x) { se += x.w * Math.exp(-lambda * (x.v - lo)); });
  return lo - Math.log(se / sw) / lambda;
}

/*
 * value(pos, depthLeft, reach, leafWin) - expectimax over human replies.
 *
 * Opponent nodes: risk-averse mean of their replies' values (riskMean). My nodes: max over
 * a few candidates near the ChessDB best. Leaves: `leafWin`, the parent's ChessDB score for the
 * move that got here - already fetched, so a leaf never costs a request of its own.
 *
 * Provider calls carry { reach, plies } so the caller can order requests by the mass
 * they explain, and tell the first iteration from later ones.
 *
 * Every value `v` carries `vm` beside it: the same tree, the same choices of my moves, but
 * plain means at the opponent nodes. The tooltip shows it, so the effect of riskAversion
 * can be seen. Leaves have no `vm`; it is their `v`.
 *
 * One makeSearch is one iteration. Its stats:
 *   positions  opponent nodes visited (after the per-iteration memo)
 *   frontier   nodes a deeper iteration would open up; 0 means deepening is pointless
 *   switches   my-nodes where the practical pick differs from the ChessDB best
 *   analysing  positions and moves the search wanted an eval for and ChessDB had none;
 *              each is handed to provider.analyse, so a later search can use it
 */
function makeSearch(provider, opts, rootSide, stats, plies) {
  // Per iteration, keyed by position and remaining depth: a transposition inside the
  // row's tree is searched once. Reach is not in the key; the first path to arrive
  // decides the pruning.
  var memo = new Map();

  // After the first failure the rest of the iteration is abandoned, rather than running
  // on in the background and spending requests on a result nobody will see.
  function guard() {
    return stats.failed ? Promise.reject(stats.failed) : null;
  }
  function fail(e) {
    if (!stats.failed) stats.failed = e;
    throw e;
  }

  // Only what the search would have used: a node it expands, or a reply it recurses into.
  var asked = new Set();
  function analyse(pos, san) {
    var k = fenKey(pos) + '|' + (san || '');
    if (asked.has(k)) return;
    asked.add(k);
    stats.analysing++;
    if (!provider.analyse) return;
    try {
      Promise.resolve(provider.analyse(pos, san)).catch(function () {});
    } catch (e) { /* a hint, never a reason to fail the search */ }
  }

  var K_PRIOR = opts.prepPriorGames;

  // Sets a leaf's prepared split from `counts`, valued at the leaf's own Practical value.
  // Arithmetic only: the counts are ones the search already fetched.
  function prepLeaf(node, counts, dr) {
    if (!opts.prep || node.v == null) return node;
    var s = leafSplit(counts, node.v, rootSide, dr, K_PRIOR);
    node.prep = s.prep;
    node.prior = s.prior;
    node.leafGames = s.leafGames;
    return node;
  }

  // hint: an upper bound on this position's games (the games of the opponent move that
  // led here), or undefined when unknown.
  // up: for the prepared score only - { counts, dr }: the results of that opponent move,
  // and the nearest ancestor's draw rate. Like reach, the memo ignores it: the first path
  // to arrive decides.
  function opponentNode(pos, depthLeft, reach, leafWin, path, hint, up) {
    var key = fenKey(pos) + '|' + depthLeft;
    if (memo.has(key)) return memo.get(key);
    var p = guard() || opponentNodeRaw(pos, depthLeft, reach, leafWin, path, hint, up || {});
    memo.set(key, p);
    return p;
  }

  /*
   * The opponent's reply distribution. Lichess games where there are enough of them;
   * below `maiaUntil` games, Maia's move probabilities fill in, as `K` pseudo-games
   * spread by Maia's policy, with K falling linearly from `maiaWeight` to 0 at
   * `maiaUntil`. Below `maiaOnlyBelow` games Maia alone decides - and when the move that
   * led here already had fewer games than that, the explorer isn't even asked, since this
   * position can have no more games than that move.
   *
   * With `maiaOnly` the explorer is never asked and Maia alone weighs every reply: the
   * same search, with Maia standing in for the games everywhere. It costs ChessDB and Maia
   * only, so it deepens in seconds where Lichess's rate limit takes minutes.
   *
   * Without Maia (off, model not downloaded, or no answer) a node under `minGames` is a
   * leaf, as before. Below a move with under `skipExplorerBelow` games it is one without
   * asking the explorer either: valued by ChessDB, whatever the explorer would say.
   *
   * Both shortcuts take the move's games as a bound on the position's, and it is a loose
   * one: a position also collects games through other move orders. Replaying 135 of
   * repgen's searches (2026-09-27), skipping under 50 found more games in 16% of the
   * positions skipped, up to 6,835 behind a 43-game move, and moved row values by up to
   * 5.8 points. Under 10 the values moved by at most 1.6 and saved 14% of requests, so
   * keep the cut-offs low.
   *
   * `maia` on the result is the share of the value that rests on Maia: each reply's
   * Maia part of its weight, plus its games part times its own subtree's Maia share.
   */
  function opponentNodeRaw(pos, depthLeft, reach, leafWin, path, hint, up) {
    stats.positions++;
    var info = { reach: reach, plies: plies };
    var useMaia = !!opts.maia && typeof provider.maia === 'function';
    var skipEx = !!opts.maiaOnly || (hint != null &&
      hint < (useMaia ? opts.maiaOnlyBelow : opts.skipExplorerBelow));
    return Promise.all([
      skipEx ? null : provider.explorer(pos, info),
      provider.chessdb(pos, info)
    ]).catch(fail).then(function (r) {
      var ex = r[0], cdb = r[1];
      var total = ex ? ex.total : (hint || 0);
      var wantMaia = useMaia && (!ex || total < opts.maiaUntil);
      var mp = wantMaia ? Promise.resolve()
        .then(function () { return provider.maia(pos, info); })
        .catch(function () { return null; }) : null;
      return Promise.resolve(mp).then(function (maia) {
        if (maia && !maia.length) maia = null;
        if (wantMaia && !maia) stats.maiaMissing = true;
        return replyNode(pos, depthLeft, reach, leafWin, path, ex, cdb, total, maia, up);
      });
    });
  }

  function replyNode(pos, depthLeft, reach, leafWin, path, ex, cdb, total, maia, up) {
    var engine = engineWinOf(cdb, pos, rootSide);
    if (engine == null) engine = leafWin;
    // Prepared score: this node's own results are the games through my move, already in
    // hand. With the explorer skipped (a Maia-only node), the move that led here stands
    // in for them - one ply early, but never a lookup of its own.
    var own = opts.prep ? positionCounts(ex) : null;
    var dr = drawRateOf(own, up.dr || 0);
    var leafCounts = ex ? own : up.counts;
    function leaf(reason) {
      return prepLeaf({ v: engine, kind: 'leaf', reason: reason, games: total, engine: engine,
        own: own }, leafCounts, drawRateOf(leafCounts, up.dr || 0));
    }
    if (!maia && (!ex || total < opts.minGames)) return leaf('few-games');
    var evals = evalMap(cdb, pos, rootSide);
    if (!evals.size) {
      if (cdb && cdb.status === 'unknown') analyse(pos);
      return leaf('no-eval');
    }

    // Games count unless Maia alone decides; K is Maia's weight in pseudo-games.
    var gamesOn = !!ex && !(maia && total < opts.maiaOnlyBelow);
    var K = !maia ? 0 : !gamesOn ? 1 : opts.maiaWeight * Math.max(0, 1 - total / opts.maiaUntil);
    var cands = new Map();
    function cand(san) {
      var key = moveKey(san);
      if (!cands.has(key)) cands.set(key, { san: san, games: 0, prob: 0, cnt: null });
      return cands.get(key);
    }
    if (ex) ex.moves.forEach(function (m) {
      var c = cand(m.san);
      c.games = m.games;
      c.cnt = moveCounts(m);
    });
    var probSum = 0;
    (maia || []).forEach(function (m) { cand(m.san).prob = m.prob; probSum += m.prob; });
    var denom = (gamesOn ? total : 0) + K * probSum;
    if (!(denom > 0)) return leaf('few-games');

    var all = [];
    cands.forEach(function (c) {
      var g = gamesOn ? c.games : 0;
      var mw = K * c.prob;
      if (g + mw <= 0) return;
      // cnt: the reply's real results, even where Maia alone sets its weight (1 to 9
      // games) - the prepared score's empirical part is always real games.
      all.push({ san: c.san, games: c.games, g: g, mw: mw, share: (g + mw) / denom,
        cnt: c.cnt });
    });
    all.forEach(function (m) {
      if (!evals.has(moveKey(m.san)) && m.share >= opts.replyThreshold) analyse(pos, m.san);
    });
    // Replies with no ChessDB eval are left out of both numbers, so the two differ only
    // in how leaves are valued.
    var used = all.filter(function (m) { return evals.has(moveKey(m.san)); });
    if (!used.length) return leaf('no-eval');

    var k = used.length;
    var usedShare = 0;
    var tailShare = 0;
    // Heaviest replies first, so their requests are queued first.
    used.sort(function (a, b) { return b.share - a.share; });
    return Promise.all(used.map(function (m) {
      var share = m.share;
      var childLeaf = evals.get(moveKey(m.san)).win;
      usedShare += share;
      if (share < opts.replyThreshold) tailShare += share;
      var worth = share >= opts.replyThreshold && reach * share >= opts.reachFloor;
      var out = { san: m.san, share: share, games: m.games, g: m.g, mw: m.mw, v: childLeaf,
        expanded: false, maiaOnly: m.g === 0, cnt: m.cnt };
      var rdr = drawRateOf(m.cnt, dr);
      if (!worth || depthLeft <= 1) {
        if (worth) stats.frontier++;       // only depth held it back
        return prepLeaf(out, m.cnt, rdr);
      }
      var next = provider.child(pos, m.san);
      // The positions below can have no more games than this move.
      return myNode(next, depthLeft - 1, reach * share, childLeaf, path.concat(m.san), m.g,
        { counts: m.cnt, dr: rdr })
        .then(function (n) {
          out.v = n.v;
          out.vm = n.vm;
          out.expanded = true;
          out.move = n.move || null;
          out.sub = n.maia || 0;
          if (n.prep) {
            out.prep = n.prep;
            out.prior = n.prior;
            out.leafGames = n.leafGames;
          } else {
            // A my-node that ended the walk (no eval, or out of depth) is a leaf: its
            // games are this reply's.
            prepLeaf(out, m.cnt, rdr);
          }
          return out;
        });
    })).then(function (replies) {
      var sw = 0, swvm = 0, swm = 0;
      var pw = 0, pd = 0, pb = 0, pp = 0, lg = 0, prepOk = opts.prep;
      var items = [];
      replies.forEach(function (x) {
        // Uniform smoothing belongs to the games; Maia is already a prior.
        var w = x.g + x.mw + (gamesOn ? opts.alpha / k : 0);
        var f = w > 0 ? x.mw / w : 0;
        sw += w;
        items.push({ w: w, v: x.v });
        swvm += w * (x.vm != null ? x.vm : x.v);
        // The Maia share and the prepared split stay linear: they say what the value
        // rests on, and what the games did, not how much it is worth to me.
        swm += w * (f + (1 - f) * (x.sub || 0));
        // The prepared split: the same weighted mean. Its prior share has no Maia term,
        // because the Maia part of a weight is already a reply valued at its prior.
        if (!x.prep) { prepOk = false; return; }
        pw += w * x.prep.w; pd += w * x.prep.d; pb += w * x.prep.b;
        pp += w * x.prior;
        lg += x.leafGames;
      });
      var node = {
        v: riskMean(items, opts.riskAversion),
        vm: swvm / sw,
        kind: 'mean',
        games: total,
        engine: engine,
        replies: replies,
        maia: swm / sw,
        tailShare: tailShare,
        unexplained: Math.max(0, 1 - usedShare),
        own: own
      };
      if (prepOk) {
        node.prep = { w: pw / sw, d: pd / sw, b: pb / sw };
        node.prior = pp / sw;
        node.leafGames = lg;
      }
      return node;
    });
  }

  /*
   * My move: choose at equal depth, then value the choice at full depth.
   *
   * Deeper values drift upwards - every extra ply adds a human mean (never below the
   * engine's best reply) and another max over my moves - so candidates are only compared
   * at one depth: one full move shallower than this node's, which is exactly what the
   * previous iteration searched the ChessDB best to. That value is already cached, so the
   * comparison costs requests only for the alternatives. The winner is then searched to
   * the full remaining depth; only a switch costs a full-depth search of an alternative.
   *
   * A node reached for the first time (no shallower depth to compare at) keeps the
   * ChessDB best, and the next iteration re-picks on practical values.
   *
   * On a line reached less than `compareReachMin` of the time the ChessDB best stands at
   * every depth. The alternatives cost a request each and barely move the row: in the
   * replay above this saved 20% of requests, moving row values by 0.04 points on average.
   */
  function myNode(pos, depthLeft, reach, leafWin, path, hint, up) {
    if (depthLeft <= 0) return Promise.resolve({ v: leafWin, kind: 'leaf' });
    var g = guard();
    if (g) return g;
    return Promise.resolve(provider.chessdb(pos, { reach: reach, plies: plies }))
      .catch(fail).then(function (cdb) {
        var evals = evalMap(cdb, pos, rootSide);
        if (!evals.size) {
          if (cdb && cdb.status === 'unknown') analyse(pos);
          var e = engineWinOf(cdb, pos, rootSide);
          return { v: e == null ? leafWin : e, kind: 'leaf', reason: 'no-eval' };
        }
        var all = Array.from(evals.values()).sort(function (a, b) { return b.win - a.win; });
        var best = all[0];
        if (depthLeft <= 1) return { v: best.win, kind: 'leaf', move: best.san };
        var alts = reach < opts.compareReachMin ? [] : all.slice(1)
          .filter(function (c) { return best.win - c.win <= opts.ownMargin; })
          .slice(0, Math.max(0, opts.ownMaxCandidates - 1));
        var cmpDepth = depthLeft - 3;

        function deep(c) {
          return opponentNode(provider.child(pos, c.san), depthLeft - 1, reach, c.win,
            path.concat(c.san), hint, up);
        }
        // The prepared split follows the Practical choice, from its full-depth search. It
        // is never re-chosen by results: picking by the best empirical score would pick
        // whichever move got lucky in a small sample and then report that same luck.
        function done(c) {
          return function (n) {
            var r = { v: n.v, vm: n.vm != null ? n.vm : n.v, kind: 'max', move: c.san,
              maia: n.maia || 0 };
            if (n.prep) { r.prep = n.prep; r.prior = n.prior; r.leafGames = n.leafGames; }
            return r;
          };
        }

        if (!alts.length || cmpDepth < 1) {
          if (alts.length) stats.frontier++;     // the next iteration compares them
          return deep(best).then(done(best));
        }

        var cands = [best].concat(alts);
        return Promise.all(cands.map(function (c) {
          return opponentNode(provider.child(pos, c.san), cmpDepth, reach, c.win,
            path.concat(c.san), hint, up);
        })).then(function (res) {
          // Start from the ChessDB best and switch only for a clear practical gain, which
          // damps flips driven by sample noise.
          var base = res[0].v;
          var pick = 0;
          for (var i = 1; i < res.length; i++) {
            if (res[i].v > res[pick].v && res[i].v - base > opts.preferBestWithin) pick = i;
          }
          var chosen = cands[pick];
          if (pick) {
            stats.switches.push({ path: path.slice(), from: best.san, to: chosen.san,
              gain: res[pick].v - base, reach: reach });
          }
          return deep(chosen).then(done(chosen));
        });
      });
  }

  return { opponentNode: opponentNode, myNode: myNode };
}

/*
 * One table row at one depth: the position after my candidate `san`, with the opponent
 * to move, searched `plies` plies below it (1: the row's direct replies, valued by their
 * one-shot ChessDB evals).
 */
export function evaluateRow(provider, rootFen, san, plies, options) {
  var opts = Object.assign({}, PE_DEFAULTS, options || {});
  var rootSide = sideToMove(rootFen);
  var stats = { positions: 0, frontier: 0, switches: [], analysing: 0, maiaMissing: false,
    failed: null };
  var rowFen;
  try {
    rowFen = provider.child(rootFen, san);
  } catch (e) {
    return Promise.resolve({ state: 'error', reason: 'Not a legal move here: ' + san });
  }
  var s = makeSearch(provider, opts, rootSide, stats, plies);
  return s.opponentNode(rowFen, plies, 1, null, []).then(function (n) {
    var out = {
      fen: rowFen,
      depth: plies,
      value: n.v,
      // The value with plain means at the opponent nodes (riskAversion 0), same choices.
      mean: n.vm != null ? n.vm : n.v,
      engine: n.engine,
      games: n.games,
      positions: stats.positions,
      frontier: stats.frontier,
      analysing: stats.analysing,
      maia: n.maia || 0,
      maiaElo: opts.maia ? opts.maiaElo : null,
      maiaMissing: stats.maiaMissing,
      tailShare: n.tailShare || 0,
      unexplained: n.unexplained || 0,
      replies: (n.replies || []).map(function (r) {
        var x = { san: r.san, share: r.share, v: r.v, expanded: r.expanded, move: r.move || null,
          maiaOnly: !!r.maiaOnly };
        if (opts.prep) { x.raw = rawOf(r.cnt); x.prep = r.prep || null; }
        return x;
      }),
      // The heaviest few, for the tooltip.
      switches: stats.switches.sort(function (a, b) { return b.reach - a.reach; }).slice(0, 3)
    };
    if (opts.prep) {
      // prep/prior: the row's prepared split and how much of it rests on the Practical
      // value. raw: the row position's own results in the search's own data, the
      // like-for-like baseline whatever database the panel shows.
      out.prep = n.prep || null;
      out.prior = n.prep ? n.prior : null;
      out.leafGames = n.prep ? n.leafGames : 0;
      out.raw = rawOf(n.own);
    }
    if (n.kind === 'mean') out.state = 'value';
    else if (n.reason === 'few-games') out.state = 'few';
    else out.state = 'none';
    if (out.value == null && out.state === 'value') out.state = 'none';
    return out;
  });
}

