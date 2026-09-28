/*
 * The generator's state as one PGN game, ready to import into a Qchess chapter.
 *
 * Opponent replies are ordered most played first, so the main line is always the most
 * likely one. A position reached by more than one move order is written out once, under
 * the most likely of them; the others end with a "transposes" comment (and the
 * extension's own markers link them once the chapter is imported).
 *
 * My move is marked !?, ?! or ?? by how far ChessDB rates it under its best move
 * (markInteresting / markDubious / markBlunder), and !? at least when it hands the
 * opponent an edge the best move doesn't (markWorseThan): a Practical pick can be
 * objectively worse.
 */

import { REPGEN_DEFAULTS } from './generator.mjs';
import { winFromCp, moveKey } from '../../src/pe/search.js';

var REASONS = {
  'few-games': 'few games',
  thin: 'no reply with enough games',
  'max-ply': 'depth limit',
  rare: 'no reply likely enough',
  'no-eval': 'ChessDB has no eval',
  'game-over': 'game over',
  error: 'failed'
};

/*
 * How many win% points my move gives up against ChessDB's best, or null when ChessDB has
 * no eval for it (a move searched only for how it scores in the games). Runs saved before
 * the best was stored find it among the candidates, which always include it.
 */
export function engineLoss(n) {
  if (!n || n.kind !== 'me' || n.engine == null) return null;
  var best = { san: n.bestMove, win: n.bestEngine };
  if (best.win == null) {
    best = { san: n.move, win: n.engine };
    (n.rows || []).forEach(function (r) {
      if (r.engine != null && r.engine > best.win) best = { san: r.san, win: r.engine };
    });
  }
  return { loss: Math.max(0, best.win - n.engine), win: n.engine, best: best };
}

/*
 * '??', '?!', '!?' or '' for engineLoss(n)'s result; a threshold of 0 is off. On top of
 * the loss in win% points, a move that gives the opponent the edge ChessDB's best doesn't
 * give (markWorseThan, in centipawns) gets !? at least, however little win% it costs.
 */
export function markFor(el, cfg) {
  cfg = Object.assign({}, REPGEN_DEFAULTS, cfg || {});
  if (!el || el.loss == null) return '';
  var loss = el.loss;
  if (cfg.markBlunder > 0 && loss >= cfg.markBlunder) return '??';
  if (cfg.markDubious > 0 && loss >= cfg.markDubious) return '?!';
  if (cfg.markInteresting > 0 && loss >= cfg.markInteresting) return '!?';
  if (cfg.markWorseThan > 0 && el.best && el.win != null) {
    var edge = winFromCp(-cfg.markWorseThan);
    if (el.win <= edge && el.best.win > edge) return '!?';
  }
  return '';
}

function pct(x, digits) { return (x * 100).toFixed(digits == null ? 0 : digits) + '%'; }
function win(x) { return x == null ? '?' : x.toFixed(1); }
// Centipawns as ChessDB's site shows them: +0.30, -0.15, and mates as +M / -M.
export function pawns(cp) {
  if (cp == null) return '?';
  if (Math.abs(cp) >= 29000) return cp > 0 ? '+M' : '-M';
  return (cp >= 0 ? '+' : '-') + (Math.abs(cp) / 100).toFixed(2);
}
function thousands(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
// How much of a Practical value rests on Maia's predictions rather than games.
function maiaPart(x) {
  var p = Math.round((x || 0) * 100);
  return p >= 1 ? ', ' + p + '% Maia' : '';
}

export function toPgn(state, o) {
  o = o || {};
  var nodes = state.nodes;
  var parts = String(state.startFen).split(/\s+/);
  var prefix = state.prefix || [];
  // Half-moves before the start position, counted from move 1 with White.
  var base = (Math.max(1, Number(parts[5]) || 1) - 1) * 2 + (parts[1] === 'b' ? 1 : 0);
  var rootKey = parts.slice(0, 4).join(' ');
  var cfg = Object.assign({}, REPGEN_DEFAULTS, state.config || {});

  function edgesOf(key) {
    var n = nodes[key];
    if (!n || n.status !== 'done') return [];
    if (n.kind === 'me') {
      if (!n.move) return [];
      var el = engineLoss(n);
      return [{ id: key + '|' + n.move, san: n.move, child: n.child, from: n,
        mark: markFor(el, cfg), best: el && el.best }];
    }
    return (n.replies || []).map(function (r) {
      return { id: key + '|' + r.san, san: r.san, child: r.child, from: n, reply: r };
    });
  }

  // Each position's home: the most likely way to reach it. Best first by path reach.
  var home = {}, homePath = {};
  home[rootKey] = null;
  homePath[rootKey] = [];
  var open = [{ key: rootKey, reach: 1 }];
  while (open.length) {
    var bi = 0;
    for (var i = 1; i < open.length; i++) if (open[i].reach > open[bi].reach) bi = i;
    var cur = open.splice(bi, 1)[0];
    edgesOf(cur.key).forEach(function (e) {
      if (!e.child || e.child in home) return;
      home[e.child] = e.id;
      homePath[e.child] = homePath[cur.key].concat(e.san);
      open.push({ key: e.child, reach: cur.reach * (e.reply ? e.reply.share : 1) });
    });
  }

  function label(ply, force) {
    var h = base + ply;
    var num = Math.floor(h / 2) + 1;
    return h % 2 === 0 ? num + '. ' : (force ? num + '... ' : '');
  }

  function moveText(path, fromPly) {
    return path.map(function (san, i) { return label(fromPly + i, i === 0) + san; }).join(' ');
  }

  function comment(e) {
    var bits = [];
    var n = e.from;
    if (e.reply) {
      bits.push(pct(e.reply.share) + ' of ' + thousands(e.from.games) + ' games');
    } else if (n.pickedBy === 'practical') {
      // A move with too few games won on ChessDB's eval, a floor for its Practical value.
      var mine = n.few && (n.rows || []).find(function (r) { return moveKey(r.san) === moveKey(n.move); });
      var s = n.few
        ? 'Prac at least ' + win(n.value) + ', few games' +
          (mine && mine.games != null ? ' (' + mine.games + ')' : '') + ', engine ' + win(n.engine)
        : 'Prac ' + win(n.value) + ' d' + n.depth + maiaPart(n.maia) + ', engine ' + win(n.engine);
      // Marked: say what it was measured against.
      if (e.mark) s += ' (best ' + e.best.san + ' ' + win(e.best.win) + ')';
      // A near-tie ChessDB decided: the move with the top Practical value it beat.
      if (n.close) {
        s += ' (over ' + n.close.san + ' ' + win(n.close.value) + ': ChessDB ' +
          pawns(n.close.mine) + ' vs ' + pawns(n.close.cp) + ')';
      }
      var others = (n.rows || []).filter(function (r) {
        return r.san !== n.move && !(n.close && r.san === n.close.san) &&
          r.state === 'value' && r.value != null;
      }).sort(function (a, b) { return b.value - a.value; }).slice(0, 3)
        .map(function (r) { return r.san + ' ' + win(r.value) + (r.depth !== n.depth ? ' d' + r.depth : ''); });
      if (others.length) s += '; ' + others.join(', ');
      bits.push(s);
    } else {
      bits.push('engine move' + (n.engine != null ? ' ' + win(n.engine) : '') +
        (n.why === 'few-games' ? ', few games' : ', no practical value'));
    }
    var c = e.child && nodes[e.child];
    if (e.child && home[e.child] !== e.id) {
      bits.push('transposes to ' + moveText(homePath[e.child], 0));
    } else if (!c || c.status === 'queued' || c.status === 'wait') {
      bits.push('not searched yet');
    } else if (c.status === 'leaf') {
      bits.push('end: ' + (REASONS[c.reason] || c.reason) +
        (c.reason === 'few-games' ? ' (' + (c.games || 0) + ')' : ''));
    }
    return bits.join(' · ');
  }

  function follow(e, ply, force) {
    if (!e.child || home[e.child] !== e.id) return [];
    return line(e.child, ply, force);
  }

  function line(key, ply, force) {
    var es = edgesOf(key);
    if (!es.length) return [];
    var m0 = es[0];
    var c0 = comment(m0);
    var out = [label(ply, force) + m0.san + (m0.mark || ''), '{' + c0 + '}'];
    for (var i = 1; i < es.length; i++) {
      var mi = es[i];
      var v = [label(ply, true) + mi.san, '{' + comment(mi) + '}'].concat(follow(mi, ply + 1, true));
      out.push('(' + v.join(' ') + ')');
    }
    return out.concat(follow(m0, ply + 1, true));
  }

  // A move number stays on the line of its move.
  function wrap(tokens, width) {
    var words = [];
    tokens.join(' ').split(' ').forEach(function (w) {
      var prev = words[words.length - 1];
      if (prev && /^\(?\d+\.(\.\.)?$/.test(prev)) words[words.length - 1] = prev + ' ' + w;
      else words.push(w);
    });
    var lines = [];
    var curLine = '';
    words.forEach(function (w) {
      if (curLine && curLine.length + 1 + w.length > width) { lines.push(curLine); curLine = w; }
      else curLine = curLine ? curLine + ' ' + w : w;
    });
    if (curLine) lines.push(curLine);
    return lines.join('\n');
  }

  var tokens = [];
  if (prefix.length) tokens.push(moveText(prefix, -prefix.length));
  tokens = tokens.concat(line(rootKey, 0, !prefix.length));
  tokens.push('*');

  var d = o.date || new Date();
  var date = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' +
    String(d.getDate()).padStart(2, '0');
  var headers = [
    ['Event', o.event || 'Practical repertoire'],
    ['Site', 'repgen'],
    ['Date', date],
    ['White', state.side === 'w' ? 'Repertoire' : 'Lichess'],
    ['Black', state.side === 'b' ? 'Repertoire' : 'Lichess'],
    ['Result', '*']
  ];
  var standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  var initial = prefix.length ? standard : rootKey;
  if (initial !== standard) {
    headers.push(['SetUp', '1']);
    headers.push(['FEN', state.startFen]);
  }
  return headers.map(function (h) { return '[' + h[0] + ' "' + h[1] + '"]'; }).join('\n') +
    '\n\n' + wrap(tokens, 79) + '\n';
}
