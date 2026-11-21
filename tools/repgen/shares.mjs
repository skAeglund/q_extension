/*
 * Played shares on a PGN's branches (tools/pgnshare.mjs): each move gets "N% of M games"
 * at the front of its comment, in deeprep's wording (deeprep/pgn.mjs moveComment), so
 * pgnclean keeps it as the share and a second run replaces it rather than adding another.
 * Pure: the explorer comes in as lookup(fen) -> compactExplorer()'s shape (providers.js).
 */

import { fenKey } from '../../src/pe/search.js';

// deeprep's share note (repgen/clean.mjs SHARE), or pgnclean's bare "40%" left of it, alone
// or as the first '; ' part or paragraph of a comment.
var LEADING = /^\d+(?:\.\d+)?%(?: of [\d,]+ games(?:, deep \S+ ±\S+)?)?(?:; |\s*$|\s*\n)/;

function games(n) { return n.toLocaleString('en-US'); }

// Whole percent, as deeprep writes it, but one decimal under 1% so a rare move isn't "0%".
export function shareText(n, total) {
  var p = 100 * n / total;
  return (p > 0 && p < 1 ? p.toFixed(1) : String(Math.round(p))) + '% of ' + games(total) + ' games';
}

export function withShare(comment, note) {
  var text = String(comment || ''), m = LEADING.exec(text);
  var rest = (m ? text.slice(m[0].length) : text).trim();
  // A share that was a paragraph of its own (pgnclean's) stays one: Qchess shows the break.
  return rest ? note + (m && /\n/.test(m[0]) ? '\n\n' : '; ') + rest : note;
}

function walk(nd, fn) {
  fn(nd);
  nd.children.forEach(function (c) { walk(c, fn); });
}

/*
 * Annotates the games (parsePgn's trees) in place. o.all: every move, not only those
 * where the PGN branches. o.progress(done, of). Returns { moves, positions, empty }:
 * moves annotated, positions looked up, and moves left alone because no game reached
 * their position.
 */
export async function annotateShares(gameList, lookup, o) {
  o = o || {};
  var targets = [];
  gameList.forEach(function (g) {
    walk(g.root, function (nd) {
      if (nd.children.length > 1 || (o.all && nd.children.length)) {
        nd.children.forEach(function (c) { targets.push(c); });
      }
    });
  });
  var answers = new Map(), keys = [];
  targets.forEach(function (c) {
    var k = fenKey(c.parent.fen);
    if (!answers.has(k)) { answers.set(k, null); keys.push([k, c.parent.fen]); }
  });
  for (var i = 0; i < keys.length; i++) {
    answers.set(keys[i][0], await lookup(keys[i][1]));
    if (o.progress) o.progress(i + 1, keys.length);
  }
  var r = { moves: 0, positions: keys.length, empty: 0 };
  targets.forEach(function (c) {
    var a = answers.get(fenKey(c.parent.fen));
    if (!a || !a.total) { r.empty++; return; }
    var m = (a.moves || []).find(function (x) { return x.san === c.san; });
    c.comment = withShare(c.comment, shareText(m ? m.games : 0, a.total));
    r.moves++;
  });
  return r;
}
