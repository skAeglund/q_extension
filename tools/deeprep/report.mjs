/*
 * deeprep build's output besides the tree: the PGN's comments, the review (Markdown, for
 * the user or a Claude session to go through), and the decisions file it can answer with.
 *
 * The review lists the decisions worth a second look, most reached first, with every
 * number the choice was made on. A decision is written back as a line from the start
 * position (the build's --moves included) and what to do there:
 *
 *   { "1. d4 c5 2. dxc5 e5 3. e4 Bxc5 4. Nc3 Nf6 5. Bg5": { "play": "Nc6", "why": "..." },
 *     "1. d4 c5 2. dxc5 e5 3. Nf3": { "avoid": ["Nf6"] } }
 *
 * and `build --decisions <file>` keeps to it: `play` is played whatever it scores (it
 * needs minGames games there), `avoid` never is. A FEN works as a key too.
 */

import { Chess } from '../../src/vendor/chess.js';
import { keyOf } from '../explorerdb/games.mjs';
import { lineText } from './pgn.mjs';

var STANDARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function f1(x) { return x == null || !isFinite(x) ? '–' : x.toFixed(1); }
function p0(x) { return x == null || !isFinite(x) ? '–' : Math.round(100 * x) + '%'; }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

// The line to a node, numbered, from the start position when the build had --moves.
export function lineOf(ctx, path) {
  return ctx.prefix ? lineText(STANDARD, ctx.prefix.concat(path)) : lineText(ctx.root, path);
}

export function pickOf(n) {
  return n.cands ? n.cands.find(function (c) { return c.san === n.move; }) : null;
}

/*
 * What a decision should be looked at for: {
 *   close     the runner-up scores within closeMargin
 *   learn     the learning cost chose the move: another blends higher
 *   trap      a quarter or more of their replies are blunders, or a move that blends
 *             higher was left out as unsound
 *   limit     a move that blends higher was over the loss limit
 *   engine    the move gives up 2+ win% against ChessDB's best (inside the limit)
 *   no-eval   ChessDB knows the position but has no eval for the move, so no limit held it
 *   thin      the move has fewer than 4 x minGames games
 *   holdout   on the holdout index another move's games did 3+ points better
 *   pinned, all-out, pin-missing
 * }
 */
export function flagsOf(n, cfg) {
  var f = [];
  var c = pickOf(n);
  if (!c) return f;
  var ok = n.cands.filter(function (x) { return !x.out; });
  var others = ok.filter(function (x) { return x !== c; });
  var runner = others.reduce(function (a, b) { return !a || b.score > a.score ? b : a; }, null);
  if (runner && c.score - runner.score <= cfg.closeMargin) f.push('close');
  if (n.why === 'learn') f.push('learn');
  var higher = n.cands.filter(function (x) { return x.blend > c.blend + 1e-9; });
  if ((c.trap || 0) >= 0.25 || higher.some(function (x) { return x.out === 'unsound'; })) f.push('trap');
  if (higher.some(function (x) { return x.out === 'max-loss'; })) f.push('limit');
  if (n.engineBest && c.engine != null && n.engineBest.win - c.engine >= 2) f.push('engine');
  // ChessDB knows the position but not the move, nor the position after it: the loss limit
  // and the sound value couldn't judge it, and it passed them (as in repgen).
  if (n.engineBest && c.engine == null) f.push('no-eval');
  if (c.games < 4 * cfg.minGames) f.push('thin');
  if (c.holdout && c.holdout.games >= cfg.minGames) {
    var beat = n.cands.some(function (x) {
      return x !== c && x.holdout && x.holdout.games >= cfg.minGames && x.holdout.raw - c.holdout.raw >= 3;
    });
    if (beat) f.push('holdout');
  }
  if (n.why === 'pinned') f.push('pinned');
  if (n.why === 'all-out') f.push('all-out');
  if (n.pinMissing) f.push('pin-missing');
  return f;
}

// The PGN's comment before the first move of mine: count is my positions, held the holdout's
// eval or null. pgnclean drops it (repgen/clean.mjs DEEPREP), as it does moveNote's
// notes: change the wording there too.
export function rootNote(count, inSample, held) {
  var e = held || inSample;
  return count + ' positions to know; ' + (held ? 'holdout ' : 'in sample ') + (100 * e.s).toFixed(1) +
    '% (everyone ' + (100 * e.raw).toFixed(1) + '%)';
}

// The PGN comment on my move.
export function moveNote(n, kid) {
  var c = pickOf(n);
  if (!c) return '';
  var parts = [];
  parts.push('score ' + f1(c.score) + ': deep ' + f1(c.deep) + (c.engine != null ? ', ChessDB ' + f1(c.engine) : '') +
    (c.prac != null ? ', Prac ' + f1(c.prac) : ''));
  parts.push(fmt(c.games) + ' games, raw ' + f1(c.raw));
  if (c.sound != null) parts.push('sound ' + f1(c.sound) + ((c.trap || 0) >= 0.05 ? ', blunders ' + p0(c.trap) : ''));
  if (c.penalty >= 0.05) parts.push('learning -' + f1(c.penalty) + ' (' + p0(c.newShare) + ' new)');
  if (n.why === 'learn') {
    var top = n.cands.filter(function (x) { return !x.out; }).reduce(function (a, b) { return b.blend > a.blend ? b : a; });
    parts.push('over ' + top.san + ' ' + f1(top.blend) + ', learning -' + f1(top.penalty));
  }
  if (n.why === 'pinned') parts.push('pinned');
  if (n.why === 'all-out') parts.push('every move over a limit: the safest');
  var alts = n.cands.filter(function (x) { return x !== c && !x.out; }).sort(function (a, b) { return b.score - a.score; });
  if (alts.length) parts.push('also ' + alts.slice(0, 3).map(function (x) { return x.san + ' ' + f1(x.score); }).join(', '));
  var out = n.cands.filter(function (x) { return x.out && x.out !== 'avoid'; });
  if (out.length) parts.push(out.map(function (x) { return x.san + ' ' + (x.out === 'max-loss' ? 'over the loss limit' : 'unsound'); }).join(', '));
  if (n.engineBest && c.engine != null && n.engineBest.win - c.engine >= 2) {
    parts.push('ChessDB best ' + n.engineBest.san + ' ' + f1(n.engineBest.win));
  }
  if (kid && kid.status === 'done' && kid.other > 0.005) parts.push('replies not covered ' + p0(kid.other));
  if (kid && kid.status === 'leaf') parts.push('end: ' + (kid.end === 'few-games' ? 'few games' : kid.end === 'rare' ? 'no reply likely enough' : kid.end));
  return parts.join(' · ');
}

/*
 * The decisions file: { line or FEN: { play, avoid, why } } -> Map(position key -> {play, avoid}).
 * A line is SAN from the start position, numbers optional; failing that, from `root`.
 */
export function parseDecisions(obj, root) {
  var m = new Map();
  Object.keys(obj || {}).forEach(function (k) {
    var v = obj[k] || {};
    var fen = null;
    if (/\//.test(k) && / [wb] /.test(k + ' ')) fen = k;
    else {
      var sans = k.replace(/\d+\.+/g, ' ').trim().split(/\s+/).filter(Boolean);
      [STANDARD, root].some(function (start) {
        if (!start) return false;
        var c = new Chess(start);
        try { sans.forEach(function (s) { c.move(s); }); } catch (e) { return false; }
        fen = c.fen();
        return true;
      });
    }
    if (!fen) throw new Error('Decisions: "' + k + '" is not a line of legal moves from the start or the root.');
    var avoid = v.avoid == null ? [] : Array.isArray(v.avoid) ? v.avoid : [v.avoid];
    m.set(String(keyOf(fen)), { play: v.play || null, avoid: avoid.map(String), why: v.why || null, line: k });
  });
  return m;
}

function table(n) {
  var rows = ['| move | games | raw | deep | ChessDB | Prac | sound | blunders | new | learning | score | holdout | |',
    '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|'];
  var c0 = pickOf(n);
  n.cands.slice().sort(function (a, b) {
    return (a.out ? 1 : 0) - (b.out ? 1 : 0) || (b.score != null ? b.score : -1e9) - (a.score != null ? a.score : -1e9) ||
      b.blend - a.blend;
  }).forEach(function (c) {
    var name = c === c0 ? '**' + c.san + '**' : c.san;
    rows.push('| ' + [name, fmt(c.games), f1(c.raw), f1(c.deep) + ' ±' + f1(c.se), f1(c.engine), f1(c.prac), f1(c.sound),
      c.trap == null ? '–' : p0(c.trap), c.out ? '' : p0(c.newShare), c.out ? '' : '-' + f1(c.penalty), c.out ? '' : f1(c.score),
      c.holdout ? f1(c.holdout.raw) + ' (' + fmt(c.holdout.games) + ')' : '–',
      c.out ? (c.out === 'max-loss' ? 'over the loss limit' : c.out) : ''].join(' | ') + ' |');
  });
  return rows.join('\n');
}

var FLAG_TEXT = {
  close: 'close call',
  learn: 'chosen for being easier to learn',
  trap: 'traps',
  limit: 'a better-scoring move is over the loss limit',
  engine: 'under ChessDB\'s best',
  'no-eval': 'ChessDB has no eval for the move, so no limit checked it',
  thin: 'few games',
  holdout: 'the holdout prefers another move',
  pinned: 'pinned by you',
  'all-out': 'every move over a limit',
  'pin-missing': 'the pinned move has too few games'
};

/*
 * ctx = { out, side, root, prefix, index, filter, cfg, nodes (Map), stats, inSample (eval),
 * holdout: { name, eval } or null, date }
 */
export function reviewMarkdown(ctx) {
  var cfg = ctx.cfg;
  var mine = [], opp = 0;
  ctx.nodes.forEach(function (n) {
    if (n.kind === 'me' && n.status === 'done') mine.push(n);
    else if (n.kind === 'opp') opp++;
  });
  mine.sort(function (a, b) { return b.reach - a.reach; });
  var whys = {};
  mine.forEach(function (n) { whys[n.why] = (whys[n.why] || 0) + 1; });
  var flagged = mine.map(function (n) { return { n: n, f: flagsOf(n, cfg) }; })
    .filter(function (x) { return x.f.some(function (f) { return f !== 'thin'; }); });
  var L = [];
  var side = ctx.side === 'w' ? 'White' : 'Black';
  L.push('# Review: ' + ctx.out);
  L.push('');
  L.push('Repertoire for ' + side + ' from ' + (ctx.prefix && ctx.prefix.length ? lineText(STANDARD, ctx.prefix) : ctx.root) +
    ' · index ' + ctx.index + ' (' + ctx.filter.speeds.join(', ') + '; ' + ctx.filter.ratings.join(', ') + ') · ' + ctx.date);
  L.push('');
  L.push('Settings: ' + ['plies', 'minGames', 'prior', 'risk', 'weights', 'maxLoss', 'blunder', 'soundMargin', 'learnCost',
    'theme', 'coverage', 'coverageStep', 'singleBelow'].map(function (k) { return k + ' ' + cfg[k]; }).join(', ') +
    (ctx.chessdb ? '' : '. **No ChessDB**: no loss limit, sound value or Prac d1.'));
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('- ' + mine.length + ' positions of mine to know, ' + opp + ' of theirs.');
  if (ctx.inSample) {
    L.push('- On the index it was built from: ' + f1(100 * ctx.inSample.s) + '%, everyone ' + f1(100 * ctx.inSample.raw) +
      '% (this shares the choices\' luck).');
  }
  if (ctx.holdout && ctx.holdout.eval) {
    var h = ctx.holdout.eval;
    L.push('- On the holdout ' + ctx.holdout.name + ': **' + f1(100 * h.s) + '%** ±' + f1(100 * h.se) + ', everyone ' +
      f1(100 * h.raw) + '% (' + (h.s >= h.raw ? '+' : '') + f1(100 * (h.s - h.raw)) + '), over ' + fmt(h.games) +
      ' games. Games leave the book ' + p0(h.ends.out) + ', reach a line end ' + p0(h.ends.end) + '.');
  } else {
    L.push('- No holdout: give `--holdout <index of other months>` for a score the choices\' luck can\'t flatter.');
  }
  L.push('- Moves: ' + Object.keys(whys).map(function (k) {
    return whys[k] + ' ' + ({ best: 'best by score', learn: 'chosen for learning', pinned: 'pinned', 'all-out': 'all over a limit' }[k] || k);
  }).join(', ') + '. ' + flagged.length + ' to review below.');
  L.push('');
  L.push('Columns: deep is the deep score (shrunk, ±SE); ChessDB the engine\'s win% for my move; Prac the risk-averse mean ' +
    'of ChessDB\'s evals after their replies, by how often they\'re played; sound the deep score over their replies that ' +
    'aren\'t blunders (more than ' + cfg.blunder + ' win% over their best), shrunk like deep; new the share of the move\'s line the ' +
    'repertoire doesn\'t have yet; score = blend (' + cfg.weights.join('/') + ' of ChessDB/Prac/deep) minus learning. ' +
    'All in win% for ' + side + '.');
  L.push('');
  L.push('## To review, most reached first');
  L.push('');
  // The most reached ones in full; the rest are in the table below.
  var MAX = 60;
  if (flagged.length > MAX) {
    L.push('The ' + MAX + ' most reached of ' + flagged.length + '; the others are in the table at the end, with their flags.');
    L.push('');
  }
  flagged.slice(0, MAX).forEach(function (x) {
    var n = x.n;
    var c = pickOf(n);
    L.push('### ' + lineOf(ctx, n.path) + ' — reach ' + p0(n.reach) + ', ' + fmt(n.games) + ' games');
    L.push('');
    L.push('Flags: ' + x.f.map(function (f) { return FLAG_TEXT[f] || f; }).join(', ') + '. Played **' + c.san + '**' +
      (n.engineBest ? '; ChessDB\'s best ' + n.engineBest.san + ' ' + f1(n.engineBest.win) : '') +
      (c.refute ? '; their best reply ' + c.refute : '') + (n.was ? '; was ' + n.was.join(', ') + ' before polishing' : '') + '.');
    L.push('');
    L.push(table(n));
    L.push('');
    L.push('Decide: `"' + lineOf(ctx, n.path) + '": { "play": "' + c.san + '" }`');
    L.push('');
  });
  L.push('## Every decision');
  L.push('');
  L.push('| line | reach | move | why | score | runner-up | flags |');
  L.push('|---|--:|---|---|--:|---|---|');
  mine.forEach(function (n) {
    var c = pickOf(n);
    var r = n.cands.filter(function (x) { return x !== c && !x.out; }).sort(function (a, b) { return b.score - a.score; })[0];
    L.push('| ' + lineOf(ctx, n.path) + ' | ' + p0(n.reach) + ' | ' + c.san + ' | ' + n.why + ' | ' + f1(c.score) + ' | ' +
      (r ? r.san + ' ' + f1(r.score) : '') + ' | ' + flagsOf(n, cfg).join(', ') + ' |');
  });
  L.push('');
  return L.join('\n');
}
