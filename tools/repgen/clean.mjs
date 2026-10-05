/*
 * Finishing a generated repertoire PGN, from repgen or deeprep (tools/pgnclean.mjs):
 *
 *   - Comments: only the played share is kept ("9% of 97,950 games" becomes "9%"), and
 *     only on a move that still has alternatives once transpositions are gone: the share
 *     is there to compare branches. The generators' other notes (Prac values, engine
 *     moves, deeprep's scores and limits, line ends, transposition pointers) go; anything
 *     else in a comment, such as your own notes, stays.
 *   - Transpositions, found by position: a move that ends its line in a position that
 *     goes on elsewhere in the game.
 *       Their move: the branch is removed and noted on my move it answered, e.g. on
 *       4. Bxc4 after 3... e6: "Nf6 transposes into 3... Nf6 4. Bxc4 e6".
 *       My move: it stays (it is the move to play), with "Transposes into ..." on it.
 *     The line is written from where the two move orders part.
 *
 * Notes are separated by a blank line, which Qchess keeps as a paragraph break (a single
 * newline it joins into a space, as PGN soft-wrapping).
 */

import { pathOf, movesText } from './pgntree.mjs';
import { fenKey, sideToMove } from '../../src/pe/search.js';

var SEP = '\n\n';
// repgen's notes, by how they start. A note is the text between ' · '.
var GENERATED = /^(Prac |engine move|given move|transposes to |not searched yet|end: )/;

// deeprep's, whole: build's moveNote (deeprep/report.mjs) and rootNote, the search's
// moveComment (deeprep/pgn.mjs) and its root comment (deeprep.mjs). deeprep joins some
// with '; ', so those are matched part by part. Its "transposes to" and "end:" are
// repgen's words.
var N = '(?:-?\\d+(?:\\.\\d+)?|–)';                // f1(): one decimal, or – for none
var P = '(?:\\d+(?:\\.\\d+)?%|\\?)';                 // pct(), or p0()
var OUT = '\\S+ (?:over the loss limit|unsound)';
var DEEPREP = [
  'score ' + N + ': deep ' + N + '(?:, ChessDB ' + N + ')?(?:, Prac ' + N + ')?',
  '[\\d,]+ games, raw ' + N,
  'sound ' + N + '(?:, blunders ' + P + ')?',
  'learning -' + N + ' \\(' + P + ' new\\)',
  'over \\S+ ' + N + ', learning -' + N,
  'pinned',
  'every move over a limit: the safest',
  'also \\S+ ' + N + '(?:, \\S+ ' + N + ')*',
  OUT + '(?:, ' + OUT + ')*',
  'ChessDB best \\S+ ' + N,
  'replies not covered ' + P,
  '\\d+ positions to know',
  '(?:in sample|holdout) ' + P + ' \\(everyone ' + P + '\\)',
  'best lower bound',
  'deep ' + P + ' ±\\S+, raw ' + P + ', [\\d,]+ games',
  'also \\S+ ' + P + ' ±\\S+ \\([\\d,]+\\)(?:, \\S+ ' + P + ' ±\\S+ \\([\\d,]+\\))*',
  'deep ' + P + ' for (?:White|Black), [\\d,]+ games'
].map(function (x) { return new RegExp('^' + x + '$'); });

// The share of games a reply has; deeprep's search adds its deep score.
var SHARE = /^(\d+(?:\.\d+)?%) of [\d,]+ games(?:, deep \S+ ±\S+)?$/;

// The notes of a paragraph: [[part]], parts being what deeprep joined with '; '.
function notes(p) {
  return p.replace(/\s+/g, ' ').trim().split(' · ').map(function (b) {
    return GENERATED.test(b) ? [] : b.split('; ');
  });
}

// o.share false: the played share goes too.
export function cleanComment(text, o) {
  if (text == null) return null;
  var keep = !(o && o.share === false);
  var paras = String(text).split(/\r?\n[ \t]*\r?\n/).map(function (p) {
    return notes(p).map(function (parts) {
      return parts.map(function (x) {
        var m = SHARE.exec(x);
        if (m) return keep ? m[1] : '';
        return DEEPREP.some(function (re) { return re.test(x); }) ? '' : x;
      }).filter(Boolean).join('; ');
    }).filter(Boolean).join(' · ');
  }).filter(Boolean);
  return paras.length ? paras.join(SEP) : null;
}

function shareOf(text) {
  var all = [].concat.apply([], notes(String(text || '')));
  for (var i = 0; i < all.length; i++) {
    var m = SHARE.exec(all[i]);
    if (m) return m[1];
  }
  return null;
}

export function sideOfHeaders(headers) {
  var h = {};
  (headers || []).forEach(function (x) { h[x[0]] = x[1]; });
  if (h.White === 'Repertoire' && h.Black !== 'Repertoire') return 'w';
  if (h.Black === 'Repertoire' && h.White !== 'Repertoire') return 'b';
  return null;
}

function walk(nd, fn) {
  fn(nd);
  nd.children.forEach(function (c) { walk(c, fn); });
}

function append(nd, note) {
  nd.comment = nd.comment ? nd.comment + SEP + note : note;
}

/*
 * side: 'w' | 'b', the repertoire's side. Returns what was done:
 *   { removed, marked, notes: [text] }
 */
export function cleanGame(game, side) {
  var root = game.root;
  // The share is put back at the end, once it is known which moves still have
  // alternatives.
  var shares = new Map();
  walk(root, function (nd) {
    var sh = shareOf(nd.comment);
    nd.comment = cleanComment(nd.comment, { share: false });
    nd.pre = cleanComment(nd.pre);
    // own: words of yours left in the comment, which the share joins on one line.
    if (sh) shares.set(nd, { share: sh, own: !!nd.comment });
  });

  // Every position the game reaches, in document order (main line first at each branch).
  var at = new Map();
  walk(root, function (nd) {
    if (!nd.san) return;
    var k = fenKey(nd.fen);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(nd);
  });

  // Decide everything first, then change the tree, so removals can't hide a home.
  var todo = [];
  walk(root, function (nd) {
    if (!nd.san || nd.children.length) return;
    var home = (at.get(fenKey(nd.fen)) || []).find(function (o) {
      return o !== nd && o.children.length > 0;
    });
    if (!home) return;
    var mine = pathOf(nd), theirs = pathOf(home);
    if (theirs.length <= mine.length && theirs.every(function (x, i) { return mine[i] === x; })) {
      return;   // a repetition of a position on its own line: nothing to point to
    }
    var d = 0;
    while (d < mine.length && d < theirs.length && mine[d] === theirs[d]) d++;
    todo.push({ nd: nd, line: movesText(theirs.slice(d)),
      opp: sideToMove(nd.parent.fen) !== side });
  });

  var out = { removed: 0, marked: 0, notes: [] };
  todo.forEach(function (x) {
    var nd = x.nd;
    if (x.opp) {
      var note = nd.san + ' transposes into ' + x.line;
      nd.parent.children.splice(nd.parent.children.indexOf(nd), 1);
      // On my move it answered (before the game, if it is the first move).
      append(nd.parent, note);
      out.removed++;
      out.notes.push(note);
    } else {
      append(nd, 'Transposes into ' + x.line);
      out.marked++;
      out.notes.push(nd.san + ': transposes into ' + x.line);
    }
  });
  shares.forEach(function (x, nd) {
    var sibs = nd.parent && nd.parent.children;
    if (!sibs || sibs.length < 2 || sibs.indexOf(nd) < 0) return;
    if (!nd.comment) nd.comment = x.share;
    else nd.comment = x.share + (x.own ? ' · ' : SEP) + nd.comment;
  });
  return out;
}
