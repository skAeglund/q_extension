/*
 * explorerdb serve: answers like the Lichess explorer, from an index file.
 *
 *   GET /lichess?fen=<fen>&moves=<n>&speeds=…&ratings=…   the explorer's own query
 *   GET /info                                             which index this is
 *
 * The search's providers (src/pe/providers.js) and repgen ask it instead of Lichess when
 * given its address. No token and no rate limit: it's your own machine.
 *
 * The filter is fixed when importing, so `speeds` and `ratings` can't change the answer.
 * A request with a different filter is answered all the same, from the index, and the
 * first one of each kind is logged: repgen compares its filter at the start instead
 * (/info has the index's), and the popup's Test button shows it.
 *
 * Listens on 127.0.0.1 unless told otherwise, and answers GET only.
 */

import http from 'node:http';
import { explorerAnswer } from './store.mjs';

// What /info says. `id` changes with every import, so caches can tell indexes apart.
export function indexInfo(db) {
  var m = db.meta;
  return {
    id: m.source + '@' + m.created,
    source: m.source,
    created: m.created,
    filter: m.filter,
    plies: m.plies,
    minGames: m.minGames,
    positions: m.report.positions,
    games: m.report.games.kept
  };
}

function sameList(a, b) {
  return String((a || []).slice().sort()) === String((b || []).slice().sort());
}

/*
 * One request -> { status, body }. `seen` collects the filters already reported, `log`
 * gets a line for each new one.
 */
export function handle(db, rawUrl, seen, log) {
  var u = new URL(rawUrl, 'http://localhost');
  if (u.pathname === '/info') return { status: 200, body: indexInfo(db) };
  if (u.pathname !== '/lichess' && u.pathname !== '/') {
    return { status: 404, body: { error: 'Not found: ask /lichess?fen=… or /info' } };
  }
  var fen = u.searchParams.get('fen');
  if (!fen) return { status: 400, body: { error: 'fen is missing' } };
  var speeds = (u.searchParams.get('speeds') || '').split(',').filter(Boolean);
  var ratings = (u.searchParams.get('ratings') || '').split(',').filter(Boolean).map(Number);
  var f = db.meta.filter;
  if ((speeds.length && !sameList(speeds, f.speeds)) || (ratings.length && !sameList(ratings, f.ratings))) {
    var k = speeds.join(',') + '|' + ratings.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      log('A request asks for ' + (speeds.join(', ') || 'any speed') + '; ratings ' +
        (ratings.join(', ') || 'any') + '. This index only has ' + f.speeds.join(', ') +
        '; ratings ' + f.ratings.join(', ') + ', and answers with that.');
    }
  }
  var moves = u.searchParams.has('moves') ? Number(u.searchParams.get('moves')) : 12;
  try {
    return { status: 200, body: explorerAnswer(db, fen, moves >= 0 ? moves : 12) };
  } catch (e) {
    return { status: 400, body: { error: 'Bad fen: ' + (e && e.message || e) } };
  }
}

export function createServer(db, o) {
  o = o || {};
  var log = o.log || function () {};
  var seen = new Set();
  var served = 0;
  return http.createServer(function (req, res) {
    var r;
    if (req.method !== 'GET') r = { status: 405, body: { error: 'GET only' } };
    else {
      try { r = handle(db, req.url, seen, log); } catch (e) {
        r = { status: 500, body: { error: String(e && e.message || e) } };
      }
    }
    served++;
    if (o.onServed) o.onServed(served);
    res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(r.body));
  });
}
