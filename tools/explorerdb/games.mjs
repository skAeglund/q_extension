/*
 * explorerdb: reading games out of a Lichess dump and replaying them fast.
 *
 * Pure: no files, no threads. The importer (importer.mjs) and its workers (worker.mjs)
 * call these, and so do the tests.
 *
 * Speed is the point here. A month of blitz/rapid/classical at 1600+ is about 25 million
 * games, a billion moves at 40 plies each. chess.js's move() plays about 15,000 moves a
 * second, because it writes every candidate's SAN (check detection included) to find the
 * one it was given, and builds a Move object with FENs. findMove() below matches the SAN
 * against chess.js's own pseudo-legal moves instead, and asks for legal ones only when two
 * candidates remain (a pinned piece): about 400,000 a second. The positions are keyed by
 * chess.js's own Zobrist hash, kept up to date by _makeMove.
 *
 * That uses chess.js's underscore methods (_moves, _makeMove, _hash, _epSquare, _epKey).
 * src/vendor/chess.js is pinned at 1.4.0, and test/explorerdb.js checks the result against
 * move() and fen() on random games, so an upgrade that changes them fails there first.
 */

import { Chess } from '../../src/vendor/chess.js';

// Named in the index header: an index is only readable by the same hash function.
export var HASH_NAME = 'chess.js-1.4.0-zobrist';

// Lichess's speeds, from its estimated game length: base + 40 × increment, in seconds.
export function speedOf(timeControl) {
  if (!timeControl || timeControl === '-') return 'correspondence';
  var m = /^(\d+)\+(\d+)$/.exec(timeControl);
  if (!m) return null;
  var t = Number(m[1]) + 40 * Number(m[2]);
  if (t < 30) return 'ultraBullet';
  if (t < 180) return 'bullet';
  if (t < 480) return 'blitz';
  if (t < 1500) return 'rapid';
  return 'classical';
}

// The explorer's rating groups, by the players' average: 1600 means 1600-1799, and 2500
// means 2500 and up.
export var RATING_GROUPS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

export function ratingGroup(avg) {
  var g = 0;
  for (var i = 0; i < RATING_GROUPS.length; i++) if (avg >= RATING_GROUPS[i]) g = RATING_GROUPS[i];
  return g;
}

var RESULT = { '1-0': 0, '1/2-1/2': 1, '0-1': 2 };

function header(text, name) {
  var i = text.indexOf('[' + name + ' "');
  if (i < 0) return null;
  var s = i + name.length + 3;
  var e = text.indexOf('"', s);
  return e < 0 ? null : text.slice(s, e);
}

/*
 * One game's text (headers, blank line, moves) -> { moves, result } if it passes the
 * filter, otherwise null. `result` is 0 (White won), 1 (draw) or 2 (Black won); games
 * without one are skipped, as are games from a set-up position or another variant.
 * `why` counts the reasons, for the report.
 */
export function makeFilter(o) {
  var speeds = {};
  (o.speeds || []).forEach(function (s) { speeds[s] = true; });
  var groups = {};
  (o.ratings || []).forEach(function (r) { groups[r] = true; });
  return function (text, why) {
    var body = text.indexOf('\n\n');
    if (body < 0) { why.broken++; return null; }
    var head = text.slice(0, body);
    var variant = header(head, 'Variant');
    if ((variant && variant !== 'Standard') || head.indexOf('[FEN "') >= 0) { why.variant++; return null; }
    if (!speeds[speedOf(header(head, 'TimeControl'))]) { why.speed++; return null; }
    var we = Number(header(head, 'WhiteElo')), be = Number(header(head, 'BlackElo'));
    if (!(we > 0 && be > 0) || !groups[ratingGroup((we + be) / 2)]) { why.rating++; return null; }
    var r = RESULT[header(head, 'Result')];
    if (r === undefined) { why.result++; return null; }
    return { moves: text.slice(body + 2), result: r };
  };
}

/*
 * The first `plies` SAN moves of a movetext: comments ({ [%clk ...] }), move numbers,
 * NAGs, annotations and the result dropped. Lichess dumps have no variations.
 */
export function movetextSans(text, plies) {
  var out = [];
  var i = 0, n = text.length;
  while (i < n && out.length < plies) {
    var c = text.charCodeAt(i);
    if (c === 123) {                                        // {
      var j = text.indexOf('}', i + 1);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c <= 32) { i++; continue; }
    var k = i;
    while (k < n && text.charCodeAt(k) > 32 && text.charCodeAt(k) !== 123) k++;
    var w = text.slice(i, k);
    i = k;
    if (w.charCodeAt(0) >= 48 && w.charCodeAt(0) <= 57) {   // "12." "12..." or a result
      var d = w.replace(/^\d+\.+/, '');
      if (d === w) continue;                                  // 1-0, 0-1, 1/2-1/2
      w = d;
      if (!w) continue;
    }
    if (w === '*' || w.charCodeAt(0) === 36) continue;        // $1
    out.push(w);
  }
  return out;
}

var SAN = /^([NBRQK])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([NBRQ]))?[+#]?[!?]*$/;

// 0x88 square of "e4".
function sq88(s) { return (s.charCodeAt(0) - 97) + (56 - s.charCodeAt(1)) * 16; }

/*
 * chess.js's internal move for a SAN, or null. Among the pseudo-legal moves of that piece
 * to that square (and file/rank, promotion), one match is the move: the game is legal.
 * Two matches only happen when one of them is illegal (a pinned piece, so no
 * disambiguation was written), and then the legal moves decide.
 */
export function findMove(c, san) {
  if (san.charCodeAt(0) === 79 || san.charCodeAt(0) === 48) {   // O-O, 0-0
    var flag = /^[O0]-[O0]-[O0]/.test(san) ? 64 : 32;           // BITS.QSIDE / KSIDE_CASTLE
    var ks = c._moves({ legal: true, piece: 'k' });
    for (var i = 0; i < ks.length; i++) if (ks[i].flags & flag) return ks[i];
    return null;
  }
  var m = SAN.exec(san);
  if (!m) return null;
  var piece = m[1] ? m[1].toLowerCase() : 'p';
  var to = sq88(m[4]);
  var ff = m[2] ? m[2].charCodeAt(0) - 97 : -1;
  var fr = m[3] ? 56 - m[3].charCodeAt(0) : -1;
  var promo = m[5] ? m[5].toLowerCase() : undefined;
  function pick(legal) {
    var ms = c._moves({ legal: legal, piece: piece }), hit = null, n = 0;
    for (var i = 0; i < ms.length; i++) {
      var x = ms[i];
      if (x.to !== to || x.promotion !== promo) continue;
      if (ff >= 0 && (x.from & 7) !== ff) continue;
      if (fr >= 0 && (x.from >> 4) !== fr) continue;
      hit = x;
      n++;
    }
    return n === 1 ? hit : n === 0 ? null : undefined;
  }
  var h = pick(false);
  return h === undefined ? pick(true) || null : h;
}

/*
 * A move as 16 bits: from + 64 × to + 4096 × promotion, squares numbered a1 = 0 … h8 = 63,
 * promotion 0 none, 1 n, 2 b, 3 r, 4 q. Castling is the king's move (e1g1). 0 is a1a1,
 * never a move, so it stands for "no move": the game ended here, or the ply limit did.
 */
var PROMO = { n: 1, b: 2, r: 3, q: 4 };
var PROMO_CHAR = ['', 'n', 'b', 'r', 'q'];

function sq64(x88) { return (x88 & 7) + 8 * (7 - (x88 >> 4)); }
function sqName(i) { return 'abcdefgh'[i & 7] + (1 + (i >> 3)); }

export function moveCode(mo) {
  return sq64(mo.from) + 64 * sq64(mo.to) + 4096 * (mo.promotion ? PROMO[mo.promotion] : 0);
}

export function codeParts(code) {
  return { from: sqName(code & 63), to: sqName((code >> 6) & 63), promotion: PROMO_CHAR[code >> 12] || undefined };
}

/*
 * A game's walk: hashes[i] is the position before move i and codes[i] that move;
 * hashes[sans.length] is the last position reached. null if a move doesn't play (never
 * seen in Lichess's dumps, but a corrupt line shouldn't stop an import).
 */
export function createReplayer() {
  var c = new Chess();
  return function replay(sans) {
    c.reset();
    var hashes = new Array(sans.length + 1), codes = new Array(sans.length);
    for (var i = 0; i < sans.length; i++) {
      hashes[i] = c._hash;
      var mo = findMove(c, sans[i]);
      if (!mo) return null;
      codes[i] = moveCode(mo);
      c._makeMove(mo);
      if (c._epSquare !== -1) legalEp(c);
    }
    hashes[sans.length] = c._hash;
    return { hashes: hashes, codes: codes };
  };
}

/*
 * A position keeps its en-passant square only if the capture is legal, as FENs from
 * chess.js's fen() and from Lichess do. chess.js's hash keeps it whenever an enemy pawn
 * stands beside the pawn that moved, even if that pawn is pinned, so it is taken out
 * here. Called after a double step, which is rare enough not to cost anything.
 */
function legalEp(c) {
  var ps = c._moves({ legal: true, piece: 'p' });
  for (var i = 0; i < ps.length; i++) if (ps[i].flags & 8) return;   // BITS.EP_CAPTURE
  c._hash ^= c._epKey();
  c._epSquare = -1;
}

// The key of a position given as a FEN: equal to the replay's hash of the same position,
// whether or not the FEN names an en-passant square nobody can take.
export function keyOf(fen) {
  var c = new Chess(fullFen(fen));
  if (c._epSquare !== -1) legalEp(c);
  return c._hash;
}

// The explorer's FENs, and fenKey()'s, have four fields; chess.js wants six.
export function fullFen(fen) {
  var f = String(fen).trim().split(/\s+/);
  while (f.length < 4) f.push('-');
  if (f.length < 6) f = f.slice(0, 4).concat(['0', '1']);
  return f.join(' ');
}
