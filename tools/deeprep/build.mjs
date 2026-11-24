/*
 * deeprep build: a repertoire chosen for what the user asked of one on 2026-10-02:
 *
 *   1. a high score in the middlegames it leads to: the deep score from the index's games
 *      (search.mjs), shrunk, so a lead on few games doesn't win on luck;
 *   2. no reliance on traps: a trap is fine, but the position must stay decent when the
 *      opponent doesn't fall for it. Two checks, from ChessDB: my move at most `maxLoss`
 *      win% points under ChessDB's best (as repgen's), and the sound value, the score
 *      after their replies that aren't blunders, at most `soundMargin` under the best
 *      candidate's, taken at its lower bound (`soundZ` SEs under). The sound value is
 *      shrunk as the deep score is: unshrunk, a move with a few hundred lucky games knocked
 *      well-known ones out as "unsound" (the first real build, 2026-10-03: 3.Be3 Qc7, 201
 *      games, put Nf6 and Nc6, 3,201 and 4,854, out). Shrinking alone wasn't enough for a
 *      move just over minGames, hence the lower bound;
 *   3. a good practical evaluation: ChessDB's eval of my move, and Prac d1 (ChessDB's evals
 *      after each of their replies, weighed by how often people play them, risk-averse),
 *      blended with the deep score by `weights`;
 *   4. few great lines over many best ones: "58% with a new move, or 56% by transposing into
 *      a known position: generally the known one". A position of mine to learn costs
 *      `learnCost` points of the whole repertoire's score per 100, so at a node reached by
 *      `reach` of the games a move pays learnCost/100 x (positions it adds) / reach points
 *      of its own score. What a move adds is the new share of its line times the size of
 *      the largest candidate's line (see price()): a move into positions the repertoire
 *      already has adds nothing, a new line adds the whole size. Lines don't shrink in
 *      proportion to reach: in the first real build (1.d4 c5 2.dxc5 e5, 99 decisions) a
 *      wholly new line cost 1.5 points per unit of learnCost above 2% reach, 2-2.5 at
 *      0.5-2%, and 1.75 at the median decision by reach. So the default is 1: about 2
 *      points, the user's "58 new vs 56 known". (It was 0.5, meant as 2 points, and let
 *      5...Qb6, a new line, beat 5...Nc6, a transposition, by 1.1 deep points at 8% reach.)
 *      A move the repertoire already plays in a position with the same pawns counts
 *      `theme` less (recurring moves are easier to learn). `themeKey` 'mine' counts only my
 *      own pawns as "the same pawns".
 *
 * o.known (known.mjs mergeKnown(), build --known): repertoires the user already knows. Their
 * positions count as learned, and a position in them ends a line (end `known`) instead of
 * being built again. Their moves seed the theme discount only with `knownTheme` 1: the
 * discount is for ideas that recur inside the chapter, and a known file's move with the same
 * pawns is no easier to learn unless a line actually transposes into it (2026-11-23: 1...f5
 * was being steered by Jobava moves).
 *
 * No move is left out for having few or no games (2026-11-23). The search lists my moves with
 * `minGames` games, and the `consider` best of those by deep score are weighed, plus the most
 * played. ChessDB's best is always weighed too, and so is a pinned move, whatever their
 * games: a move under minGames (`thin`) is valued as the search values thin moves, its own
 * games shrunk towards the position's score (with none, the score itself), and the lean
 * below then makes it what ChessDB and Prac say. It neither sets the bar for "unsound" nor
 * is put out by it, its sound value being ChessDB's eval for want of human replies. And a
 * line no longer ends with me to move: a position of mine that would be a leaf (few games,
 * no move with minGames, the last ply) gets ChessDB's best as a final move (`why: 'engine'`,
 * `final`), and the position after it ends the line. Before this, lines thinning out ended
 * in all-out picks 10+ points under ChessDB's best (10.a4 for 10.O-O-O on 12 games).
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
import { riskMean, scoreToRootWin, winFromCp, moveKey } from '../../src/pe/search.js';
import { pickReplies } from '../repgen/generator.mjs';
import { CUT, ENDED, keyOf, codeParts, fullFen } from '../explorerdb/games.mjs';
import { createSearch, leafStat, shrinkWeight } from './search.mjs';
import { lineText } from './pgn.mjs';

export var BUILD_DEFAULTS = {
  plies: 12,              // each decision's deep scores look this many plies ahead
  minGames: 50,           // a move needs this many games to compete; a position with fewer ends its line
  prior: 200,             // search.mjs's shrinkage
  risk: 0.05,             // risk aversion, in the search and in Prac d1
  maxPly: 60,             // no line goes on past this many plies from the root (30 until 2026-11-24:
                          // with reach-driven coverage, reach and games end lines, not ply)
  // Their replies, as repgen follows them (generator.mjs pickReplies). With coverReach on, these
  // only add replies that also reach coverReach (a reply under coverShare, say).
  coverage: 0.9, coverageStep: 0.1, singleBelow: 0.5,
  minReach: 0.005, minShare: 0, lineMinReach: 0.001,
  // Reach-driven coverage (2026-11-24), in place of the percentages above: a reply is followed
  // when it has coverShare of its position's games, minGames games, and a reach of at least
  // coverReach, reach being of the games from the repertoire's reference point (rootReach is
  // the root's own, from the index: deeprep.mjs works it out from --moves). A sharp line goes
  // on down to coverReach / sharpFactor: a reply played sharpShare+ that ChessDB puts sharpLoss
  // win% under their best, or one after which my best move is sharpGain over my most played.
  coverReach: 0.0005,     // 0: the percentages above alone, as before 2026-11-24
  coverShare: 0.02,
  rootReach: 1,
  sharpFactor: 5,         // 1 or 0: no sharp lines
  sharpShare: 0.1, sharpLoss: 10, sharpGain: 10,
  // Plan lines at line ends (2026-11-24): a comment of up to planLines groups, one per reply
  // played planShare+ (most played first), each about planPlies plies: they play their most
  // played move while the index has planGames games, I play ChessDB's best, and past the data
  // ChessDB's best for both. Never trained: repworks shows them as clickable lines.
  planLines: 3, planPlies: 10, planGames: 20, planShare: 0.02,
  // Main lines deep (2026-11-24): a line whose reach is still mainReach goes on to at least ply
  // mainPly from the start (rootPly is the root's own, from --moves), past the data too: they
  // play their most played move while the index has planGames games, then ChessDB's best,
  // and only that one reply; I play ChessDB's best. 0: off.
  mainReach: 0.002, mainPly: 30, rootPly: 0,
  // A deep base (2026-11-24): the drilled region is what reaches drillReach (drillReach /
  // sharpFactor on sharp lines). Only positions inside it cost learning; below it a decision is
  // cheap: no Prac d1 or sound value (the blend renormalises over ChessDB and deep), one ChessDB
  // answer (the position's own), no polishing. 0: everything is drilled, as before.
  drillReach: 0,
  maxMine: 0,             // stop growing at this many positions of mine (0: no limit)
  maxMinutes: 0,          // ...or after this many minutes; plans then go most reached first until then too
  consider: 4,            // my best moves by deep score that are weighed (plus the most played)
  weights: [0.3, 0.2, 0.5],   // ChessDB, Prac d1, deep: the blend my move is ranked by
  maxLoss: 5,             // ChessDB: my move at most this many win% under its best (0: off)
  blunder: 8,             // a reply giving me this many win% over their best is a blunder
  soundMargin: 3,         // sound value at most this far under the best candidate's (0: off)
  soundZ: 1,              // ...whose sound value counts at its lower bound, minus this many SEs
  soundTopShare: 0.05,    // ...among candidates with at least this share of the position's games
                          // (0: any candidate with minGames, as before 2026-11-23)
  enginePrior: 1,         // deep and sound shrink towards the position's score plus this times
                          // ChessDB's win% for the move over the average move's (0: the score alone)
  pracLean: 1,            // ...and Prac's lead over the average candidate's, in the blend's own
                          // ChessDB : Prac proportion (0: ChessDB alone, as before 2026-11-21)
  learnCost: 1,           // points of the repertoire's score 100 new positions must earn (0: off)
  learnMargin: 2,         // ...but only among moves whose blend is within this many points of the
                          // best blend (negative: no limit, as before 2026-11-23)
  theme: 0.5,             // a move played elsewhere with the same pawns costs this much less than a new one
  themeKey: 'both',       // "the same pawns": 'both' sides', or 'mine' alone (2026-11-22: of 161 White
                          // moves in 1.Nc3 sideline drafts, none matched a Jobava move on both sides'
                          // pawns, 46 on White's)
  knownTheme: 0,          // 1: --known files' moves seed the theme discount too (as before 2026-11-23)
  costCap: 300,           // positions counted per move at most
  passes: 3,              // polish passes
  switchMargin: 0.25,     // a polish pass changes a move only for this many points
  closeMargin: 1          // the review flags a decision whose runner-up is this close
};

function turn(fen) { return String(fen).split(/\s+/)[1] === 'b' ? 'b' : 'w'; }

// The pawns alone: what "the same structure" means for the theme discount. only: 'w' or
// 'b' keeps that side's pawns and drops the other's.
export function pawnKey(fen, only) {
  var drop = only === 'w' ? /[nbrqkpNBRQK]/g : only === 'b' ? /[nbrqkNBRQKP]/g : /[nbrqkNBRQK]/g;
  return String(fen).split(/\s+/)[0].split('/').map(function (rank) {
    var x = rank.replace(/\d/g, function (d) { return '1'.repeat(Number(d)); }).replace(drop, '1');
    return x.replace(/1+/g, function (m) { return String(m.length); });
  }).join('/');
}

function playSan(fen, san) {
  if (!san) return null;                     // chess.js plays move(null) as a null move
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
 * for me). `pull` ({ mu, w }, optional): the candidate's own shrinkage at my move, from
 * candidates() there (mu its position's score, w its weight). Returns { prac, sound, trap,
 * refute, refuteValue, pulled }:
 *   prac   Prac d1: the risk-averse mean of ChessDB's eval after each reply played, by games
 *   sound  the frequency-weighted deep score over the replies that aren't blunders (a
 *          blunder gives me more than `blunder` win% over their best reply), pulled to mu
 *          as the candidate's deep score is, so the two compare; with none played,
 *          ChessDB's eval after their best one
 *   trap   the share of the games that are blunders
 *   pulled whether sound was pulled to mu (not ChessDB's eval for want of replies)
 * All null when ChessDB doesn't know the position.
 */
export function replyCheck(cdb, fen, side, rp, cfg, pull) {
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
  var sound = sw > 0 ? ss / sw : bestMe;
  var pulled = sw > 0 && pull && isFinite(pull.mu);
  if (pulled) sound = pull.mu + pull.w * (sound - pull.mu);
  return {
    prac: items.length ? riskMean(items, cfg.risk) : null,
    sound: sound,
    pulled: !!pulled,
    trap: rp.total ? blunders / rp.total : 0,
    refute: bestSan,
    refuteValue: bestMe
  };
}

/*
 * o = { root: FEN, side: 'w' | 'b', config (BUILD_DEFAULTS' keys), chessdb(fen) -> Promise
 * (or none: no ChessDB), decisions: Map(position key -> { play, avoid: [] }),
 * chessdbPv(fen) -> Promise of { pv: [SAN] } (ChessDB's querypv; optional, for plan lines past
 * the data), known: mergeKnown()'s (optional), base: baseFromPgn()'s (optional), log(node, 'polish'?)
 * after each decision }. A decisions entry at a position of theirs may carry `cover: [SAN]`:
 * replies followed whatever their share or reach.
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
  if (cfg.themeKey !== 'both' && cfg.themeKey !== 'mine') throw new Error('themeKey is both or mine');
  // The known repertoires: positions (key -> { line, name }), my first move in each, and
  // their moves' theme counts. The counts stay apart from `themes`, which addTheme() takes
  // down and puts back while it prices a node: a known move must never be taken out.
  var known = o.known || null;
  var knownPos = known ? known.positions : new Map();
  var knownMove = known ? known.first : new Map();
  var seeded = new Map();
  var proxies = new Map();     // key -> my best move by deep score, for counting positions
  var cdbMemo = new Map();
  // A base repertoire (the owner's own file, 2026-11-24): its moves of mine are played as they
  // are, its replies always followed, and its positions are never a known file's leaf.
  var base = o.base || { moves: new Map(), replies: new Map(), positions: new Set() };
  var R = cfg.coverReach > 0 ? cfg.coverReach : 0;
  var rootReach = cfg.rootReach > 0 ? cfg.rootReach : 1;
  var decisions = o.decisions || new Map();
  var log = o.log || function () {};
  var seq = 0;
  var stats = { decisions: 0, chessdb: 0, polished: 0, finals: 0, base: 0, sharp: 0, plans: 0 };

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

  // sharp: the line came through a sharp reply, so it goes on down to coverReach / sharpFactor.
  function ensure(fen, reach, oi, ply, path, sharp) {
    var k = keyStr(fen);
    var n = nodes.get(k);
    if (n) {
      n.reach += reach;
      n.arrivals++;
      if (sharp) n.sharp = true;
      return n;
    }
    n = { key: k, fen: fen, kind: turn(fen) === side ? 'me' : 'opp', reach: reach, oi: oi, ply: ply,
      path: path, status: 'queued', seq: seq++, arrivals: 1 };
    if (sharp) n.sharp = true;
    // A known position is learned already: the line joins the known repertoire here. A base
    // position is the build's own, whatever a known file holds (their prefixes share some).
    if (knownPos.has(k) && !base.positions.has(k)) { n.status = 'leaf'; n.end = 'known'; n.known = knownPos.get(k); }
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

  function threshold(sharp) { return sharp && cfg.sharpFactor > 1 ? R / cfg.sharpFactor : R; }
  // A main line: reach still at mainReach and short of ply mainPly from the start.
  function mainLine(n) {
    return cfg.mainReach > 0 && cfg.rootPly + n.ply < cfg.mainPly && rootReach * n.reach >= cfg.mainReach - 1e-12;
  }
  // Below the drilled region: learning costs nothing and decisions are cheap.
  function drillAt(sharp) { return sharp && cfg.sharpFactor > 1 ? cfg.drillReach / cfg.sharpFactor : cfg.drillReach; }
  function cheap(n) { return cfg.drillReach > 0 && rootReach * n.reach < drillAt(n.sharp) - 1e-12; }
  var t0 = Date.now();
  function overTime() { return cfg.maxMinutes > 0 && Date.now() - t0 > cfg.maxMinutes * 60000; }
  function overLimit() {
    if (overTime()) return 'time';
    if (cfg.maxMine > 0 && settled >= cfg.maxMine) return 'positions';
    return null;
  }
  var settled = 0;             // positions of mine decided so far (each once)

  // Their replies by the rules alone (no ChessDB): the coverage percentages, and with coverReach
  // on, every reply with coverShare and minGames games; either way only those whose reach is at
  // least the line's threshold. Most played first.
  function replyPicks(fen, reach, oi, sharp) {
    var pos = positionOf(db, fen);
    if (pos.total < cfg.minGames) return { pos: pos, picks: [] };
    var ex = { total: pos.total, moves: pos.moves.map(function (m) { return { san: m.san, games: m.games }; }) };
    var old = pickReplies(ex, reach, oi, {
      coverage: cfg.coverage, coverageStep: cfg.coverageStep, singleBelow: cfg.singleBelow,
      minReach: cfg.minReach, minShare: cfg.minShare, lineMinReach: cfg.lineMinReach, stopGames: cfg.minGames
    });
    if (!R) return { pos: pos, picks: old };
    var at = rootReach * reach, thr = threshold(sharp), picks = [];
    pos.moves.slice().sort(function (a, b) { return b.games - a.games; }).forEach(function (m) {
      var share = m.games / pos.total;
      var rule = share >= cfg.coverShare && m.games >= cfg.minGames;
      var inOld = old.some(function (x) { return moveKey(x.san) === moveKey(m.san); });
      if ((rule || inOld) && at * share >= thr - 1e-12) picks.push({ san: m.san, share: share, games: m.games });
    });
    return { pos: pos, picks: picks };
  }

  // Replies followed by name, whatever their share: the base's, and a decisions entry's `cover`.
  function namedPicks(n, pos, have) {
    var d = decisions.get(n.key);
    var names = (base.replies.get(n.key) || []).concat(d && d.cover ? d.cover : []);
    var out = [];
    names.forEach(function (san) {
      var mv = playSan(n.fen, san);
      if (!mv) return;
      if (have.concat(out).some(function (x) { return moveKey(x.san) === moveKey(mv.san); })) return;
      var m = pos.moves.find(function (x) { return moveKey(x.san) === moveKey(mv.san); });
      out.push({ san: mv.san, share: m && pos.total ? m.games / pos.total : 0, games: m ? m.games : 0, named: true });
    });
    return out;
  }

  // Win% for the side to move of each move ChessDB lists: Map(move key -> win%), best.
  function wins(answer) {
    var w = new Map(), best = null;
    if (answer && answer.status === 'ok' && answer.moves) answer.moves.forEach(function (m) {
      var v = winFromCp(m.score);
      w.set(moveKey(m.san), v);
      if (best == null || v > best) best = v;
    });
    return { w: w, best: best };
  }

  /*
   * Replies under the line's threshold but over coverReach / sharpFactor that make the line
   * sharp: (i) played sharpShare+ and sharpLoss win% under their best by ChessDB (a common
   * mistake), or (ii) after it my best move is sharpGain over my most played one.
   */
  async function sharpPicks(n, pos, have) {
    if (!R || !(cfg.sharpFactor > 1) || n.sharp || !o.chessdb) return [];
    var at = rootReach * n.reach, lo = R / cfg.sharpFactor, out = [];
    var maybe = pos.moves.filter(function (m) {
      var share = m.games / pos.total;
      return share >= cfg.coverShare && m.games >= cfg.minGames && at * share >= lo - 1e-12 && at * share < R &&
        !have.some(function (x) { return moveKey(x.san) === moveKey(m.san); });
    }).sort(function (a, b) { return b.games - a.games; });
    if (!maybe.length) return out;
    var theirs = wins(await chessdb(n.fen));
    for (var i = 0; i < maybe.length; i++) {
      var m = maybe[i], share = m.games / pos.total, why = null;
      var v = theirs.w.get(moveKey(m.san));
      if (share >= cfg.sharpShare && v != null && theirs.best - v >= cfg.sharpLoss) why = 'mistake';
      else {
        var mv = playSan(n.fen, m.san);
        var mine = wins(await chessdb(mv.fen));
        var p2 = positionOf(db, mv.fen);
        var top = p2.moves.length ? p2.moves.reduce(function (a, b) { return b.games > a.games ? b : a; }) : null;
        var tv = top ? mine.w.get(moveKey(top.san)) : null;
        if (tv != null && mine.best - tv >= cfg.sharpGain) why = 'gain';
      }
      if (why) { out.push({ san: m.san, share: share, games: m.games, sharp: why }); stats.sharp++; }
    }
    return out;
  }

  async function allPicks(n) {
    var r = replyPicks(n.fen, n.reach, n.oi, n.sharp);
    var named = namedPicks(n, r.pos, r.picks);
    var sharp = r.pos.total >= cfg.minGames ? await sharpPicks(n, r.pos, r.picks.concat(named)) : [];
    return { pos: r.pos, picks: r.picks.concat(sharp, named) };
  }

  function replyOf(n, p) {
    var mv = playSan(n.fen, p.san);
    var r = { san: mv.san, share: p.share, games: p.games,
      child: ensure(mv.fen, n.reach * p.share, n.oi + 1, n.ply + 1, n.path.concat(mv.san), n.sharp || !!p.sharp).key };
    if (p.sharp) r.sharp = p.sharp;
    if (p.named) r.named = true;
    return r;
  }

  async function expandOpp(n) {
    var named = base.replies.has(n.key) || (decisions.get(n.key) || {}).cover;
    if (n.ply >= cfg.maxPly && !named) return leaf(n, 'max-ply');
    var r = await allPicks(n);
    n.games = r.pos.total;
    if (!r.picks.length && mainLine(n)) {
      // A main line goes on past where the rules stop it: their main reply only, at the
      // line's full reach, so it stays a main line down to mainPly.
      var san = r.pos.total >= cfg.planGames && r.pos.moves.length
        ? r.pos.moves.reduce(function (a, b) { return b.games > a.games ? b : a; }).san : await engineBest(n.fen);
      var m0 = san ? r.pos.moves.find(function (x) { return moveKey(x.san) === moveKey(san); }) : null;
      if (san && playSan(n.fen, san)) {
        n.replies = [replyOf(n, { san: san, share: 1, games: m0 ? m0.games : 0 })];
        n.replies[0].main = true;
        n.other = 0;
        n.status = 'done';
        stats.main = (stats.main || 0) + 1;
        return;
      }
    }
    if (!r.picks.length) return leaf(n, r.pos.total < cfg.minGames ? 'few-games' : 'rare');
    var covered = 0;
    n.replies = r.picks.map(function (p) { covered += p.share; return replyOf(n, p); });
    n.other = Math.max(0, 1 - covered);
    n.status = 'done';
  }

  /*
   * A position reached by a second move order gains that path's reach, but what was built
   * below it kept the first one's: the first real line cut (2026-10-03) ended 3.Nc3 Bxc5
   * 4.Nf3 Nc6 5.e3 Nf6, reached 3% of the time, as if it were 1.3%. So once the reach is
   * recomputed, a position of theirs follows the replies its whole reach earns. Reach only
   * grows here and the picks are a prefix of the replies by games, so this only adds.
   */
  async function widen(n) {
    if (n.ply >= cfg.maxPly) return false;
    if (R) {
      // Reach-driven: what a reply needs doesn't depend on the others, so any new pick is added.
      var ra = await allPicks(n);
      var had = n.replies || [];
      var add = ra.picks.filter(function (p) { return !had.some(function (h) { return moveKey(h.san) === moveKey(p.san); }); });
      if (!add.length) return false;
      n.replies = had.concat(add.map(function (p) { return replyOf(n, p); }));
      n.other = Math.max(0, 1 - n.replies.reduce(function (a, x) { return a + x.share; }, 0));
      n.status = 'done';
      delete n.end;
      return true;
    }
    var r = replyPicks(n.fen, n.reach, n.oi);
    var have = n.replies || [];
    if (r.picks.length <= have.length) return false;
    for (var i = 0; i < have.length; i++) if (moveKey(have[i].san) !== moveKey(r.picks[i].san)) return false;
    var covered = 0;
    n.replies = r.picks.map(function (p, j) {
      covered += p.share;
      if (j < have.length) return have[j];
      var mv = playSan(n.fen, p.san);
      return { san: mv.san, share: p.share, games: p.games,
        child: ensure(mv.fen, n.reach * p.share, n.oi + 1, n.ply + 1, n.path.concat(mv.san)).key };
    });
    n.other = Math.max(0, 1 - covered);
    n.status = 'done';
    delete n.end;
    return true;
  }

  function themeKey(fen, san) { return pawnKey(fen, cfg.themeKey === 'mine' ? side : null) + '|' + moveKey(san); }
  function addTheme(n, d) {
    if (!n.move) return;
    var k = themeKey(n.fen, n.move);
    themes.set(k, (themes.get(k) || 0) + d);
    if (!(themes.get(k) > 0)) themes.delete(k);
  }
  function themeCount(k) { return (themes.get(k) || 0) + (seeded.get(k) || 0); }
  function cardCost(fen, san) { return themeCount(themeKey(fen, san)) > 0 ? 1 - cfg.theme : 1; }
  if (known && cfg.knownTheme > 0) known.mine.forEach(function (m) {
    var k = themeKey(m.fen, m.san);
    seeded.set(k, (seeded.get(k) || 0) + 1);
  });

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
   * `elsewhere` or a known repertoire, nor below a position that is, since that one's line
   * is built (or learned) whatever this decision does. Inside a known repertoire its own
   * moves are followed. Nearest first, up to cfg.costCap positions.
   */
  function linePositions(fen, reach, oi, ply, elsewhere, sharp) {
    var all = 0, fresh = 0, seen = new Set();
    var queue = [{ fen: fen, reach: reach, oi: oi, ply: ply, inside: false }];
    for (var qi = 0; qi < queue.length && all < cfg.costCap; qi++) {
      var x = queue[qi];
      var k = keyStr(x.fen);
      if (seen.has(k)) continue;
      seen.add(k);
      if (x.ply >= cfg.maxPly) continue;
      // Positions below the drilled region aren't learned, and nothing past them is either.
      if (cfg.drillReach > 0 && rootReach * x.reach < drillAt(sharp) - 1e-12) continue;
      var inside = x.inside || elsewhere.has(k) || knownPos.has(k);
      var known = nodes.get(k);
      // A line that ends here ends; one that joins a known repertoire goes on inside it.
      if (known && known.status === 'leaf' && known.end !== 'known') continue;
      // The base is the owner's own repertoire: learned, like a known file.
      if (base.positions.has(k)) inside = true;
      if (turn(x.fen) === side) {
        var san = known && known.move ? known.move : base.moves.has(k) ? base.moves.get(k)
          : knownMove.has(k) ? knownMove.get(k).san : proxy(x.fen);
        if (!san) continue;
        all++;
        if (!inside) {
          // A position the repertoire has counts in the themes itself: only another one
          // playing the same move makes it cheaper.
          var tk = themeKey(x.fen, san);
          var self = known && known.move && themeKey(known.fen, known.move) === tk ? 1 : 0;
          fresh += themeCount(tk) > self ? 1 - cfg.theme : 1;
        }
        var mv = playSan(x.fen, san);
        if (mv) queue.push({ fen: mv.fen, reach: x.reach, oi: x.oi, ply: x.ply + 1, inside: inside });
      } else {
        var reps = known && known.replies ? known.replies : replyPicks(x.fen, x.reach, x.oi, false).picks;
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
    // Below the drilled region nothing is learned: the choice is pure chess.
    if (cheap(n)) {
      n.cands.forEach(function (c) { c.positions = 0; c.fresh = 0; c.newShare = 0; c.penalty = 0; c.score = c.blend; });
      return;
    }
    addTheme(n, -1);
    var live = n.cands.filter(function (c) { return !c.out; });
    live.forEach(function (c) {
      var lp = cfg.learnCost > 0 ? linePositions(c.fen, n.reach, n.oi, n.ply + 1, elsewhere, n.sharp) : { all: 0, fresh: 0 };
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
    // Learning only breaks near-ties: the best score (blend - learning) among the moves whose
    // blend is within learnMargin of the best blend. (Asked 2026-11-23: at the rarest roots the
    // 50/f learn cost reached 600-2,000, so learning picked 4.Bc1 against 3...Nh5 and 4.Qd2
    // against 3...Bd7, several points under the best move by every other measure.)
    var top = ok.reduce(function (a, b) { return b.blend > a.blend ? b : a; });
    var eligible = cfg.learnMargin >= 0
      ? ok.filter(function (c) { return c.blend >= top.blend - cfg.learnMargin; }) : ok;
    var best = eligible.reduce(function (a, b) { return b.score > a.score ? b : a; });
    return { c: best, why: best === top ? 'best' : 'learn', eligible: eligible };
  }

  function settle(n, pick) {
    if (!n.move) settled++;
    addTheme(n, -1);
    n.move = pick.c.san;
    n.why = pick.why;
    addTheme(n, 1);
    var mv = playSan(n.fen, n.move);
    n.child = ensure(mv.fen, n.reach, n.oi, n.ply + 1, n.path.concat(mv.san), n.sharp).key;
    n.status = 'done';
  }

  // ChessDB's answer for a position of mine: { wins: Map(move key -> win% for me), best, bestSan }.
  function engineOf(here, fen) {
    var wins = new Map(), best = null, bestSan = null;
    if (here && here.status === 'ok' && here.moves) {
      here.moves.forEach(function (m) {
        var v = scoreToRootWin(m.score, fen, side);
        wins.set(moveKey(m.san), v);
        if (best == null || v > best) { best = v; bestSan = m.san; }
      });
    }
    return { wins: wins, best: best, bestSan: bestSan };
  }

  /*
   * A move of mine the search doesn't list (under minGames games, or none at all), in the
   * search's candidates() shape: valued as the search values a thin move, its own games
   * shrunk towards the position's score by the prior; with no games, the position's score
   * itself and w 0, so the lean in decide() makes it what ChessDB and Prac say. Its SE with
   * no games is the prior's spread, sqrt(var / prior). Null if the move isn't legal here.
   * (Asked 2026-11-23: a move must never be excluded just because it has few or no games.
   * ChessDB's best was only the loss limit's yardstick, so with under 50 games it could
   * never be played, and lines thinning out ended in all-out picks 10+ points under it.)
   */
  function thinOption(fen, san, pos) {
    var mv = playSan(fen, san);
    if (!mv) return null;
    pos = pos || positionOf(db, fen);
    var m = pos.moves.find(function (x) { return moveKey(x.san) === moveKey(mv.san); }) || { games: 0, w: 0, d: 0, b: 0 };
    var all = leafStat(pos.w, pos.d, pos.b, side);
    var vr = all.n > 0 && isFinite(all.se) ? all.se * all.se * all.n : 0.25;
    var own = leafStat(m.w, m.d, m.b, side);
    var x = { san: mv.san, games: m.games, share: pos.total ? m.games / pos.total : 0, raw: own.s, s: all.s,
      se: cfg.prior > 0 ? Math.sqrt(vr / cfg.prior) : null, w: 0, thin: true };
    if (m.games > 0) {
      x.w = isFinite(all.s) ? shrinkWeight(own.se, vr, cfg.prior) : 1;
      x.s = isFinite(all.s) ? all.s + x.w * (own.s - all.s) : own.s;
      x.se = own.se;
    }
    return x;
  }

  function candOf(n, x, d) {
    var c = { san: x.san, fen: playSan(n.fen, x.san).fen, games: x.games, share: x.share,
      raw: isFinite(x.raw) ? 100 * x.raw : null, deep: isFinite(x.s) ? 100 * x.s : null,
      se: x.se != null && isFinite(x.se) ? 100 * x.se : null, w: x.w, engine: null, prac: null, sound: null, trap: null };
    if (x.thin) c.thin = true;
    if (d && d.avoid && d.avoid.some(function (a) { return moveKey(a) === moveKey(x.san); })) c.out = 'avoid';
    return c;
  }

  /*
   * A position of mine where the line would end (`why`: few-games, thin, max-ply) ends on my
   * move instead: ChessDB's best, or a pinned move, so no line stops with me to move and no
   * answer. The position after it ends the line as usual. No candidates are weighed: it is
   * scored on ChessDB and its own games (shrunk) alone, and polishing leaves it.
   */
  async function finalMove(n, why, d) {
    var pos = positionOf(db, n.fen);
    if (n.games == null) n.games = pos.total;
    var e = engineOf(await chessdb(n.fen), n.fen);
    n.engineBest = e.bestSan != null ? { san: e.bestSan, win: e.best } : null;
    var pin = d && d.play ? playSan(n.fen, d.play) : null;
    if (d && d.play && !pin) n.pinMissing = d.play;
    var x = thinOption(n.fen, pin ? pin.san : e.bestSan, pos);
    if (!x) return leaf(n, why);
    var c = candOf(n, x, null);
    if (e.wins.has(moveKey(c.san))) c.engine = e.wins.get(moveKey(c.san));
    c.blend = blend(cfg.weights, [c.engine, null, c.deep]);
    c.penalty = 0;
    c.score = c.blend;
    n.cands = [c];
    n.final = why;
    stats.finals++;
    settle(n, { c: c, why: pin ? 'pinned' : 'engine' });
    log(n);
  }

  /*
   * A position of the base repertoire: its move, as it is. No candidates are weighed (the
   * owner chose it) and no ChessDB asked; polishing leaves it (`final` 'base').
   */
  function baseMove(n, san) {
    var pos = positionOf(db, n.fen);
    n.games = pos.total;
    var x = thinOption(n.fen, san, pos);
    if (!x) { n.pinMissing = san; return leaf(n, 'base-illegal'); }
    var c = candOf(n, x, null);
    c.blend = blend(cfg.weights, [null, null, c.deep]);
    c.penalty = 0;
    c.score = c.blend;
    n.cands = [c];
    n.final = 'base';
    stats.base++;
    settle(n, { c: c, why: 'base' });
    log(n);
  }

  async function decide(n) {
    var d = decisions.get(n.key);
    if (base.moves.has(n.key)) return baseMove(n, base.moves.get(n.key));
    if (n.ply >= cfg.maxPly) return finalMove(n, 'max-ply', d);
    var op = createSearch(db, n.fen, sopts).candidates();
    n.games = op.total;
    if (!op.list.length) return finalMove(n, op.total < cfg.minGames ? 'few-games' : 'thin', d);
    var pos = null;
    var optionOf = function (san) {
      var mv = playSan(n.fen, san);
      if (!mv) return null;
      var x = op.list.find(function (y) { return moveKey(y.san) === moveKey(mv.san); });
      return x || thinOption(n.fen, mv.san, pos || (pos = positionOf(db, n.fen)));
    };
    var picked = op.list.slice(0, cfg.consider);
    var add = function (x) { if (x && !picked.some(function (y) { return moveKey(y.san) === moveKey(x.san); })) picked.push(x); };
    add(op.list.reduce(function (a, b) { return b.games > a.games ? b : a; }));
    if (d && d.play) {
      // A pinned move is weighed whatever its games; only an illegal one is missing.
      var want = optionOf(d.play);
      if (want) add(want);
      else n.pinMissing = d.play;
    }
    n.cands = picked.map(function (x) { return candOf(n, x, d); });
    // ChessDB here and after each candidate, asked together. Below the drilled region, here only.
    var lite = cheap(n);
    var answers = await Promise.all([chessdb(n.fen)].concat(n.cands.map(function (c) {
      return c.out || lite ? null : chessdb(c.fen);
    })));
    var e = engineOf(answers[0], n.fen);
    var wins = e.wins, best = e.best, bestSan = e.bestSan;
    n.engineBest = bestSan != null ? { san: bestSan, win: best } : null;
    // ChessDB's best is always weighed, whatever its games: outside the `consider` best by
    // deep score (5.Be3, 2,102 games) or under minGames (10.O-O-O, 12) it never was.
    if (bestSan != null && !n.cands.some(function (c) { return moveKey(c.san) === moveKey(bestSan); })) {
      var bx = optionOf(bestSan);
      if (bx) {
        var bc = candOf(n, bx, d);
        n.cands.push(bc);
        answers.push(bc.out || lite ? null : await chessdb(bc.fen));
      }
    }
    // ChessDB's view of the average move here, by games: what the position's score stands for.
    var eref = null;
    if (cfg.enginePrior > 0) {
      var ew = 0, es = 0;
      op.list.forEach(function (x) {
        var v = wins.get(moveKey(x.san));
        if (v != null) { ew += x.games; es += x.games * v; }
      });
      if (ew > 0) eref = es / ew;
    }
    var live = n.cands.filter(function (c) { return !c.out; });
    n.cands.forEach(function (c, i) {
      if (wins.has(moveKey(c.san))) c.engine = wins.get(moveKey(c.san));
      if (c.out) return;
      // Cheap: no ChessDB after the move, so no Prac or sound value, and no search of their replies.
      var rp = lite ? { list: [], total: 0 } : createSearch(db, c.fen, Object.assign({}, sopts, { plies: Math.max(1, cfg.plies - 1) })).candidates();
      var chk = replyCheck(answers[i + 1], c.fen, side, rp, cfg, { mu: 100 * op.raw, w: c.w });
      c.prac = chk.prac;
      c.sound = chk.sound;
      c.trap = chk.trap;
      c.refute = chk.refute;
      // A move ChessDB lists no eval for here still has one: after it, their best reply.
      // Without it, the loss limit would pass exactly the moves it knows least about.
      if (c.engine == null && chk.refuteValue != null) c.engine = chk.refuteValue;
      c.pulled = chk.pulled;
      if (cfg.maxLoss > 0 && c.engine != null && best != null && best - c.engine > cfg.maxLoss + 1e-9) c.out = 'max-loss';
    });
    // Shrink towards what ChessDB and Prac predict for the move, not the position's score
    // alone: v'' = T + w (v - T), T = mu + enginePrior x lead, which is the search's v' plus
    // (1 - w) x enginePrior x lead. A thin move then keeps its games' lead only as far as the
    // engine and Prac back it; a well-known one barely moves. Asked 2026-10-19, after the
    // Scandi build: 6.Bg5 Qb6 (ChessDB -0.29, 153 games) and 10.Bxf6 Rxf6 (58 games, over
    // Qxf6, ChessDB's best) were both decided by thin games' luck pulled to the average.
    // The lead is ChessDB's (engine - eref) plus, at Prac's share b of the blend's ChessDB and
    // Prac weights, how much more Prac's view of the move beats ChessDB's than it does for
    // the candidates on average, by games. Prac is known only for candidates, while eref is
    // over every move, hence the gap and not Prac over an average of its own. Without Prac in
    // T, a thin move's deep weight went to ChessDB a second time, and the blend's Prac share
    // stayed 0.2 however thin the games were (asked 2026-11-21: deeper in the line, with fewer
    // games, ChessDB and Prac should decide).
    var W = cfg.weights || [], wE = W[0] > 0 ? W[0] : 0, wP = W[1] > 0 ? W[1] : 0;
    var b = cfg.pracLean > 0 && wE + wP > 0 ? cfg.pracLean * wP / (wE + wP) : 0;
    var gw = 0, gs = 0;
    live.forEach(function (c) {
      if (c.engine != null && c.prac != null) { gw += c.games; gs += c.games * (c.prac - c.engine); }
    });
    var gap = gw > 0 ? gs / gw : null;
    live.forEach(function (c) {
      c.lean = 0;
      if (eref == null || c.engine == null || c.w == null) return;
      var lead = c.engine - eref;
      if (b > 0 && gap != null && c.prac != null) lead += b * (c.prac - c.engine - gap);
      c.lean = (1 - c.w) * cfg.enginePrior * lead;
      c.deep += c.lean;
      if (c.pulled) c.sound += c.lean;
    });
    n.cands.forEach(function (c) { delete c.pulled; });
    n.cands.forEach(function (c) { c.blend = blend(cfg.weights, [c.engine, c.prac, c.deep]); });
    if (cfg.soundMargin > 0) {
      // The bar is the best sound value at its lower bound, with the move's deep SE: a thin
      // move's luck is its sound value too. The Scandi build (2026-10-19) put 10...Qxf6 (982
      // games, 6% blunders, sound 64.4) out as unsound by 0.12 against Rxf6's 67.6 ±5.5 on
      // 58 games, and Rxf6 won.
      // A move under minGames (c.thin) neither sets the bar nor is put out: with no human
      // replies its sound value is ChessDB's eval after their best one, a different scale
      // from the others' scores in games.
      // Nor does a move with under soundTopShare of the position's games set it, though it can
      // still be put out, and still be chosen. The lower bound wasn't enough (2026-11-23): after
      // 1.Nc3 d5 2.d4 Nf6 3.Bf4 g6 4.e3 Bg7 5.h4 O-O, 6.Nb5 (150 games, sound 59.1 ±2.3) put 6.h5
      // (24,762, 53.0) out, and after 3.Bf4 Bd7, 4.Be5 (113 games) did the same to 4.e3.
      var minTop = cfg.soundTopShare > 0 && n.games > 0 ? cfg.soundTopShare * n.games : 0;
      var sounds = n.cands.filter(function (c) {
        return !c.out && !c.thin && c.sound != null && c.games >= minTop;
      }).map(function (c) {
        return c.sound - cfg.soundZ * (c.se || 0);
      });
      var top = sounds.length ? Math.max.apply(null, sounds) : null;
      n.cands.forEach(function (c) {
        if (top != null && !c.out && !c.thin && c.sound != null && c.sound < top - cfg.soundMargin - 1e-9) c.out = 'unsound';
      });
    }
    price(n, new Set(nodes.keys()));
    stats.decisions++;
    var pick = choose(n);
    if (!pick) return leaf(n, 'avoided');
    settle(n, pick);
    log(n);
  }

  // At maxMine or maxMinutes the build stops where it is: what is still queued ends its line
  // (`stopped`). Work goes most reached first, so what it has is the most likely part.
  async function grow() {
    for (;;) {
      if (!stats.stopped) stats.stopped = overLimit();
      if (stats.stopped) {
        nodes.forEach(function (q) { if (q.status === 'queued') leaf(q, 'stopped'); });
        return;
      }
      var n = next();
      if (!n) return;
      if (n.kind === 'opp') await expandOpp(n);
      else await decide(n);
    }
  }

  // grow(), then widen() with the whole repertoire's reach until nothing more is earned.
  // Ends with the reach recomputed.
  async function growAll() {
    for (;;) {
      await grow();
      recomputeReach();
      if (stats.stopped) return;
      var wider = 0, all = Array.from(nodes.values());
      for (var i = 0; i < all.length; i++) {
        var n = all[i];
        if (n.kind === 'opp' && n.reach > 0 && (n.status === 'done' || (n.status === 'leaf' && n.end === 'rare')) &&
          await widen(n)) wider++;
      }
      if (!wider) return;
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
      if ((d && d.play) || n.final || cheap(n)) continue;
      price(n, reachable(n.key));
      var cur = n.cands.find(function (c) { return c.san === n.move; });
      var pick = choose(n);
      if (!pick || !cur || pick.c === cur) { if (pick && cur) n.why = pick.why; continue; }
      // A move outside the learning margin goes whatever its score: its learning saving
      // can be larger than any switch margin.
      var gone = pick.eligible && pick.eligible.indexOf(cur) < 0;
      if (cur.out || gone || pick.c.score - cur.score >= cfg.switchMargin) {
        var was = n.move;
        settle(n, pick);
        n.was = (n.was || []).concat(was);
        prune();
        await growAll();
        stats.polished++;
        changed++;
        log(n, 'polish');
      }
    }
    return changed;
  }

  // ChessDB's best move for the side to move, or null.
  async function engineBest(fen) {
    var a = await chessdb(fen), best = null;
    if (a && a.status === 'ok' && a.moves) a.moves.forEach(function (m) { if (!best || m.score > best.score) best = m; });
    return best ? best.san : null;
  }

  // One plan line from `fen`: `first` (a reply of theirs, or none), then about planPlies plies:
  // their most played move while the index has planGames games, else ChessDB's best; mine
  // always ChessDB's best. Numbered SAN ("9... Nc6 10. Be3"), or null.
  async function planLine(fen, first) {
    var sans = [], cur = fen;
    if (first) {
      var mv0 = playSan(cur, first);
      if (!mv0) return null;
      sans.push(mv0.san); cur = mv0.fen;
    }
    while (sans.length < cfg.planPlies) {
      var san = null;
      if (turn(cur) !== side) {
        var p = positionOf(db, cur);
        if (p.total >= cfg.planGames && p.moves.length) san = p.moves.reduce(function (a, b) { return b.games > a.games ? b : a; }).san;
        else if (o.chessdbPv) {
          // Past the data: ChessDB's line for both sides, in one request (querypv).
          var pv = await o.chessdbPv(cur);
          for (var j = 0; pv && pv.pv && j < pv.pv.length && sans.length < cfg.planPlies; j++) {
            var mp = playSan(cur, pv.pv[j]);
            if (!mp) break;
            sans.push(mp.san); cur = mp.fen;
          }
          break;
        }
      }
      if (!san) san = await engineBest(cur);
      var mv = san ? playSan(cur, san) : null;
      if (!mv) break;
      sans.push(mv.san); cur = mv.fen;
    }
    return sans.length ? lineText(fen, sans) : null;
  }

  // The plan comment for a line end: one group per reply played planShare+ (most played first,
  // planLines at most), or one group from my move when the line ends with me to move.
  async function planOf(fen) {
    var groups = [];
    if (turn(fen) === side) {
      var g0 = await planLine(fen, null);
      if (g0) groups.push(g0);
    } else {
      var pos = positionOf(db, fen);
      var reps = pos.total ? pos.moves.filter(function (m) { return m.games / pos.total >= cfg.planShare; })
        .sort(function (a, b) { return b.games - a.games; }).slice(0, cfg.planLines) : [];
      for (var i = 0; i < reps.length; i++) {
        var g = await planLine(fen, reps[i].san);
        if (g) groups.push(g);
      }
    }
    return groups.length ? groups.map(function (x) { return '(' + x + ')'; }).join(' ') : null;
  }

  // Plan lines at every line end of the finished repertoire that doesn't join a known one.
  // Most reached first; with maxMinutes, they get a quarter of it past the build's own end, so
  // a stopped build still ends (where a build stopped, its `stopped` ends get none).
  async function plans() {
    if (!(cfg.planLines > 0) || !o.chessdb) return;
    var until = cfg.maxMinutes > 0 ? Math.max(Date.now(), t0 + cfg.maxMinutes * 60000) + cfg.maxMinutes * 15000 : Infinity;
    var ends = Array.from(reachable(null)).map(function (k) { return nodes.get(k); }).filter(function (n) {
      return n.status === 'leaf' && n.end !== 'known' && n.end !== 'stopped' && n.reach > 0;
    }).sort(function (a, b) { return b.reach - a.reach; });
    for (var i = 0; i < ends.length; i++) {
      if (Date.now() > until) { stats.plansSkipped = ends.length - i; break; }
      ends[i].plan = await planOf(ends[i].fen);
      if (ends[i].plan) stats.plans++;
    }
  }

  async function run() {
    var rk = keyStr(o.root);
    if (knownPos.has(rk) && !base.positions.has(rk)) {
      var kp = knownPos.get(rk);
      throw new Error('The root is a position of the known repertoire already: ' + (kp.line || 'its start') + ' in ' + kp.name + '.');
    }
    ensure(o.root, 1, 0, 0, []);
    await growAll();
    for (var p = 0; p < cfg.passes && !stats.stopped; p++) {
      if (!(await polish())) break;
    }
    prune();
    recomputeReach();
    // The final costs, as the repertoire stands.
    nodes.forEach(function (n) {
      if (n.kind === 'me' && n.status === 'done' && n.cands && !n.final) price(n, reachable(n.key));
    });
    await plans();
    return { nodes: nodes, stats: stats };
  }

  return { run: run, nodes: nodes, config: cfg, side: side, stats: stats, rootKey: keyStr(o.root) };
}

/*
 * Where the repertoire joins a known one: { lines (moves of the tree that end in a known
 * position), positions, reach (their summed reach), byName: { name: { lines, positions,
 * reach } }, list: [{ key, path, line, name, reach, lines }] most reached first }. On a
 * finished build (pruned, reach recomputed).
 */
export function knownEnds(nodes) {
  var out = { lines: 0, positions: 0, reach: 0, byName: {}, list: [] };
  var at = new Map();
  nodes.forEach(function (n) {
    if (n.status !== 'done' || !(n.reach > 0)) return;
    var kids = n.kind === 'me' ? (n.child ? [n.child] : []) : (n.replies || []).map(function (r) { return r.child; });
    kids.forEach(function (k) {
      var m = nodes.get(k);
      if (!m || m.end !== 'known') return;
      out.lines++;
      if (!at.has(k)) at.set(k, { key: k, path: m.path, line: m.known.line, name: m.known.name, reach: m.reach, lines: 0 });
      at.get(k).lines++;
    });
  });
  at.forEach(function (x) {
    out.positions++;
    out.reach += x.reach;
    var b = out.byName[x.name] || (out.byName[x.name] = { lines: 0, positions: 0, reach: 0 });
    b.lines += x.lines; b.positions++; b.reach += x.reach;
    out.list.push(x);
  });
  out.list.sort(function (a, b) { return b.reach - a.reach; });
  return out;
}

// The note on a move into a known repertoire. pgnclean keeps it (repgen/clean.mjs KNOWN):
// change the wording there too.
export function knownNote(m) {
  return 'transposes to ' + m.known.line + ' (in ' + m.known.name + ')';
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
 *
 * opts.fixed: Map(position key -> [SAN] from the root): positions that go on at that path
 * only (a --base file's own move order, 2026-11-24). Reached any other way, the line ends there
 * with "transposes to" that path, even before the tree has got there. Without it, a base
 * extension went on under the owner's other move order too (131 positions twice in the Jobava
 * chapter), since the tree takes the most played reply first, not the owner's path.
 */
export function toTree(nodes, rootKey, note, line, opts) {
  var shown = new Map();
  var fixed = opts && opts.fixed || new Map();
  function same(a, b) { return a.length === b.length && a.every(function (s, i) { return moveKey(s) === moveKey(b[i]); }); }
  // How the child at `at` (its path from the root) ends: a known join, a transposition, or null
  // when it goes on here.
  function joinOf(m, at) {
    if (m.end === 'known') return knownNote(m);
    var fx = fixed.get(m.key);
    if (fx && !same(fx, at)) return 'transposes to ' + line(fx);
    if (shown.has(m.key)) return 'transposes to ' + line(shown.get(m.key));
    return null;
  }
  function build(n, out, at) {
    out.children = [];
    if (shown.has(n.key)) return out;
    shown.set(n.key, fixed.get(n.key) || n.path);
    if (n.kind === 'me' && n.move) {
      var kidNode = nodes.get(n.child);
      var kid = { san: n.move, mine: true, note: note(n, kidNode) };
      if (kidNode && kidNode.plan) { kid.plan = kidNode.plan; kid.note = joinNote(kid.note, kidNode.plan); }
      var j = kidNode ? joinOf(kidNode, at.concat(n.move)) : null;
      if (j) kid.note = joinNote(kid.note, j);
      else if (kidNode) build(kidNode, kid, at.concat(n.move));
      out.children.push(kid);
    } else if (n.kind === 'opp' && n.replies) {
      n.replies.slice().sort(function (a, b) { return b.share - a.share; }).forEach(function (r) {
        var m = nodes.get(r.child);
        var kid = { san: r.san, mine: false, note: Math.round(100 * r.share) + '% of ' + r.games.toLocaleString('en-US') + ' games' };
        if (m && m.plan) { kid.plan = m.plan; kid.note = joinNote(kid.note, m.plan); }
        var jr = m ? joinOf(m, at.concat(r.san)) : null;
        if (jr) kid.note = joinNote(kid.note, jr);
        else if (m) build(m, kid, at.concat(r.san));
        out.children.push(kid);
      });
    }
    return out;
  }
  var root = nodes.get(rootKey);
  return build(root, { fen: root.fen, root: true, other: root.other || 0 }, []);
}

function joinNote(a, b) { return a ? a + ' · ' + b : b; }
