/*
 * deeprep: the search's tree (search.mjs tree()) as PGN, and as lines of text for the
 * terminal. Scores are for the repertoire's side, in percent.
 */

function pct(x) { return isFinite(x) ? (100 * x).toFixed(1) + '%' : '?'; }
function pm(x) { return isFinite(x) ? '±' + (100 * x).toFixed(1) : '±?'; }
function games(n) { return n.toLocaleString('en-US'); }

var TAG = { best: '', safe: 'best lower bound; ', kept: '' };

export function moveComment(n) {
  var parts = [];
  if (n.mine) {
    parts.push(TAG[n.tag] + 'deep ' + pct(n.s) + ' ' + pm(n.se) + ', raw ' + pct(n.raw) + ', ' +
      games(n.games) + ' games');
    if (n.alts && n.alts.length) {
      parts.push('also ' + n.alts.map(function (a) {
        return a.san + ' ' + pct(a.s) + ' ' + pm(a.se) + ' (' + games(a.games) + ')';
      }).join(', '));
    }
  } else {
    parts.push(Math.round(100 * n.share) + '% of ' + games(Math.round(n.games / n.share)) + ' games, deep ' +
      pct(n.s) + ' ' + pm(n.se));
  }
  if (n.other > 0.005 && n.children && n.children.length) parts.push('replies not covered ' + Math.round(100 * n.other) + '%');
  return parts.join('; ');
}

// Ply index of the side to move in a FEN: 0 for White at move 1.
function plyOf(fen) {
  var f = fen.split(/\s+/);
  return 2 * (Number(f[5]) - 1 || 0) + (f[1] === 'b' ? 1 : 0);
}

function num(ply, force) {
  var m = Math.floor(ply / 2) + 1;
  return ply % 2 === 0 ? m + '. ' : force ? m + '... ' : '';
}

// The moves after `node`, as PGN movetext, ply = the ply of the move to come.
function line(node, ply, force) {
  var kids = node.children || [];
  if (!kids.length) return '';
  var main = kids[0];
  var c0 = moveComment(main);
  var out = num(ply, force) + main.san + (c0 ? ' {' + c0 + '}' : '');
  for (var i = 1; i < kids.length; i++) {
    var k = kids[i], ck = moveComment(k);
    var rest = line(k, ply + 1, !!ck);
    out += ' (' + num(ply, true) + k.san + (ck ? ' {' + ck + '}' : '') + (rest ? ' ' + rest : '') + ')';
  }
  var cont = line(main, ply + 1, !!c0 || kids.length > 1);
  return out + (cont ? ' ' + cont : '');
}

/*
 * PGN of the tree. o: { prefix: [SAN] played from the start position to the root (with
 * --moves), or fen: the root (with --fen), headers: {name: value}, rootComment }.
 */
export function toPgn(root, o) {
  o = o || {};
  var h = Object.assign({ Event: 'deeprep', Result: '*' }, o.headers || {});
  var start = o.prefix ? 0 : plyOf(root.fen);
  if (!o.prefix && o.fen) { h.FEN = o.fen; h.SetUp = '1'; }
  var head = Object.keys(h).map(function (k) { return '[' + k + ' "' + String(h[k]).replace(/"/g, "'") + '"]'; });
  var text = '';
  var ply = start;
  (o.prefix || []).forEach(function (san) { text += num(ply, ply === start) + san + ' '; ply++; });
  // One comment: chess.js's loadPgn refuses two in a row.
  var note = [];
  if (o.rootComment) note.push(o.rootComment);
  if (root.mine === undefined && root.other > 0.005 && root.children.length) {
    note.push('replies not covered ' + Math.round(100 * root.other) + '%');
  }
  if (note.length) text += '{' + note.join('; ') + '} ';
  var body = line(root, ply, ply === start || !!o.rootComment || !!(o.prefix && o.prefix.length));
  return head.join('\n') + '\n\n' + wrap(text + body + ' *') + '\n';
}

function wrap(s) {
  var out = [], cur = '';
  s.split(' ').forEach(function (w) {
    if (cur && cur.length + 1 + w.length > 79) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  });
  if (cur) out.push(cur);
  return out.join('\n');
}

/*
 * A candidates table (search.mjs candidates()) as lines: my moves ranked by deep score,
 * or their replies by share.
 */
export function candidateLines(op) {
  if (!op.list.length) return ['(no moves with enough games: ' + games(op.total) + ' games here)'];
  var rows = [['move', 'deep', 'SE', 'lb', 'raw', 'games', 'share']];
  op.list.forEach(function (x) {
    rows.push([x.san, x.deep ? pct(x.s) : '(' + pct(x.s) + ')', pm(x.se), pct(x.lb), pct(x.raw),
      games(x.games), Math.round(100 * x.share) + '%']);
  });
  var w = rows[0].map(function (_, i) { return Math.max.apply(null, rows.map(function (r) { return r[i].length; })); });
  return rows.map(function (r) {
    return r.map(function (x, i) { return i ? x.padStart(w[i]) : x.padEnd(w[i]); }).join('  ');
  });
}
