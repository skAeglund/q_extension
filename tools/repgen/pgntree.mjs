/*
 * PGN <-> move tree, variations and comments included. Every move is replayed with
 * chess.js, so each node carries the FEN after it: transpositions are found by position,
 * not by what a comment says.
 *
 *   game = { headers: [[key, value]], root, result }
 *   node = { san, suffix, nags, comment, pre, children, parent, fen }
 *     root is a node without a move: its fen is the start position and its comment the
 *     one before the first move. `pre` is a comment written before a move, which PGN
 *     only allows at the start of a variation.
 */

import { Chess } from '../../src/vendor/chess.js';

var STANDARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
var RESULTS = { '1-0': 1, '0-1': 1, '1/2-1/2': 1, '*': 1 };

function tokenize(text) {
  var out = [];
  var i = 0, n = text.length;
  while (i < n) {
    var c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%' && (i === 0 || text[i - 1] === '\n')) {       // escape line
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '{') {
      var j = text.indexOf('}', i + 1);
      if (j < 0) j = n;
      out.push({ t: 'comment', v: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === ';') {
      var e = text.indexOf('\n', i);
      if (e < 0) e = n;
      out.push({ t: 'comment', v: text.slice(i + 1, e) });
      i = e;
      continue;
    }
    if (c === '[') {
      var m = /^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(text.slice(i, i + 4096));
      if (m) {
        out.push({ t: 'header', k: m[1], v: m[2].replace(/\\(["\\])/g, '$1') });
        i += m[0].length;
        continue;
      }
    }
    if (c === '(' || c === ')') { out.push({ t: c }); i++; continue; }
    var k = i;
    while (k < n && !/[\s{}();[\]]/.test(text[k])) k++;
    if (k === i) k++;
    var w = text.slice(i, k);
    i = k;
    if (/^\$\d+$/.test(w)) { out.push({ t: 'nag', v: w }); continue; }
    if (RESULTS[w]) { out.push({ t: 'result', v: w }); continue; }
    w = w.replace(/^\d+\.+/, '');                                // "12." or "12...e5"
    if (!w || /^\.+$/.test(w)) continue;
    out.push({ t: 'move', v: w });
  }
  return out;
}

function node(parent, fen) {
  return { san: null, suffix: '', nags: [], comment: null, pre: null, children: [],
    parent: parent, fen: fen };
}

function header(game, key) {
  for (var i = 0; i < game.headers.length; i++) if (game.headers[i][0] === key) return game.headers[i][1];
  return null;
}

export function pathOf(n) {
  var p = [];
  for (; n && n.san; n = n.parent) p.unshift(n);
  return p;
}

export function parsePgn(text) {
  var games = [];
  var game = null, cur = null, fresh = true, pending = null, stack = [], moved = false;

  function start() {
    game = { headers: [], root: null, result: '*' };
    games.push(game);
    cur = null;
    fresh = true;
    pending = null;
    stack = [];
    moved = false;
  }
  function rootOf() {
    if (!game.root) {
      var fen = header(game, 'FEN') || STANDARD;
      game.root = node(null, fen);
      cur = game.root;
    }
    return game.root;
  }

  tokenize(String(text).replace(/^\uFEFF/, '')).forEach(function (tk) {
    if (tk.t === 'header') {
      if (!game || moved || game.root) start();
      game.headers.push([tk.k, tk.v]);
      return;
    }
    if (!game) start();
    rootOf();
    if (tk.t === 'result') { game.result = tk.v; moved = true; return; }
    if (tk.t === 'comment') {
      if (cur === game.root && fresh && !stack.length) {
        cur.comment = cur.comment ? cur.comment + ' ' + tk.v : tk.v;
      } else if (fresh) {
        pending = pending ? pending + ' ' + tk.v : tk.v;
      } else {
        cur.comment = cur.comment ? cur.comment + ' ' + tk.v : tk.v;
      }
      return;
    }
    if (tk.t === 'nag') { if (cur.san) cur.nags.push(tk.v); return; }
    if (tk.t === '(') {
      if (!cur.parent) throw new Error('A variation with no move to be an alternative to');
      stack.push(cur);
      cur = cur.parent;
      fresh = true;
      return;
    }
    if (tk.t === ')') {
      if (!stack.length) throw new Error('Unbalanced ")"');
      cur = stack.pop();
      fresh = false;
      pending = null;
      return;
    }
    // A move.
    var m = /^(.*?)([!?]*)$/.exec(tk.v);
    var chess = new Chess(cur.fen);
    var played;
    try { played = chess.move(m[1]); } catch (e) { played = null; }
    if (!played) {
      var where = pathOf(cur).map(function (x) { return x.san; }).join(' ');
      throw new Error('Illegal move "' + tk.v + '"' + (where ? ' after ' + where : ' at the start'));
    }
    var nd = node(cur, chess.fen());
    nd.san = played.san;
    nd.suffix = m[2];
    nd.pre = pending;
    pending = null;
    cur.children.push(nd);
    cur = nd;
    fresh = false;
    moved = true;
  });
  return games.filter(function (g) { return g.root; });
}

// Move number before a move played from `fen`: always for White, for Black when forced.
export function label(fen, force) {
  var f = String(fen).split(/\s+/);
  var num = Number(f[5]) || 1;
  return f[1] === 'b' ? (force ? num + '... ' : '') : num + '. ';
}

export function movesText(nodes) {
  return nodes.map(function (x, i) { return label(x.parent.fen, i === 0) + x.san; }).join(' ');
}

function esc(s) { return String(s).replace(/}/g, ')'); }

function wrap(tokens, width) {
  // A move number stays with its move; newlines inside comments are kept.
  var words = [];
  tokens.join(' ').split(' ').forEach(function (w) {
    var prev = words[words.length - 1];
    if (prev && /^\(?\d+\.(\.\.)?$/.test(prev)) words[words.length - 1] = prev + ' ' + w;
    else if (w) words.push(w);
  });
  var out = '', col = 0;
  words.forEach(function (w) {
    var first = w.indexOf('\n') < 0 ? w.length : w.indexOf('\n');
    if (col && col + 1 + first > width) { out += '\n'; col = 0; }
    else if (col) { out += ' '; col++; }
    out += w;
    var last = w.lastIndexOf('\n');
    col = last < 0 ? col + w.length : w.length - last - 1;
  });
  return out;
}

export function writePgn(games) {
  return games.map(function (game) {
    function move(c, force) {
      var t = [];
      if (c.pre) t.push('{' + esc(c.pre) + '}');
      t.push(label(c.parent.fen, force || !!c.pre) + c.san + c.suffix);
      c.nags.forEach(function (x) { t.push(x); });
      if (c.comment) t.push('{' + esc(c.comment) + '}');
      return t;
    }
    function line(nd, force) {
      var kids = nd.children;
      if (!kids.length) return [];
      var out = move(kids[0], force);
      for (var i = 1; i < kids.length; i++) {
        var v = move(kids[i], true).concat(line(kids[i], !!kids[i].comment));
        out.push('(' + v.join(' ') + ')');
      }
      return out.concat(line(kids[0], kids.length > 1 || !!kids[0].comment));
    }
    var tokens = [];
    if (game.root.comment) tokens.push('{' + esc(game.root.comment) + '}');
    tokens = tokens.concat(line(game.root, true));
    tokens.push(game.result || '*');
    var hs = game.headers.slice();
    var r = hs.find(function (h) { return h[0] === 'Result'; });
    if (r) r[1] = game.result || '*';
    return hs.map(function (h) {
      return '[' + h[0] + ' "' + String(h[1]).replace(/(["\\])/g, '\\$1') + '"]';
    }).join('\n') + (hs.length ? '\n\n' : '') + wrap(tokens, 79) + '\n';
  }).join('\n');
}
