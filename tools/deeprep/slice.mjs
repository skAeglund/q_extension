/*
 * deeprep slice: the part of an index under one position, as an index of its own.
 *
 * The user's index is 11.8 GB on their machine. A slice holds every position a search
 * from `fen` can reach within `plies` (through moves with at least `minGames` games), each
 * with all its records, so deeprep's commands give the same answers on it as on the whole
 * index, from that position, with that minGames and horizon. A few MB, small enough to
 * hand to a Claude session in the cloud along with the question.
 *
 * Same format as explorerdb's (store.mjs): the source's header, plus `slice`, and the
 * records sorted by hash.
 */

import fs from 'node:fs';
import { Chess } from '../../src/vendor/chess.js';
import { legalEp, fullFen, CUT, ENDED } from '../explorerdb/games.mjs';
import { writeHeader, HEADER_PAD, rewriteHeader } from '../explorerdb/store.mjs';
import { recordWriter } from '../explorerdb/merge.mjs';
import { playCode } from './search.mjs';

/*
 * Writes the slice to `out`. o: { plies, minGames, line (for the header) }. Resolves
 * { positions, records, bytes }.
 */
export function writeSlice(db, fen, out, o) {
  var c = new Chess(fullFen(fen));
  if (c._epSquare !== -1) legalEp(c);
  var kept = new Map();        // hash -> records
  var depth = new Map();       // hash -> most plies left it was visited with
  (function walk(left) {
    var k = c._hash;
    if (depth.has(k) && depth.get(k) >= left) return;
    depth.set(k, left);
    var recs = kept.has(k) ? kept.get(k) : db.records(k);
    if (!recs.length) return;
    kept.set(k, recs);
    if (left <= 0) return;
    var total = recs.reduce(function (t, r) { return t + r.white + r.draws + r.black; }, 0);
    if (total < o.minGames) return;
    recs.forEach(function (r) {
      if (r.code === ENDED || r.code === CUT || r.white + r.draws + r.black < o.minGames) return;
      if (!playCode(c, r.code)) return;
      walk(left - 1);
      c._undoMove();
    });
  })(o.plies);

  var keys = Array.from(kept.keys()).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  var meta = Object.assign({}, db.meta, {
    source: db.meta.source + ' (slice)',
    created: new Date().toISOString(),
    minGames: o.minGames,
    slice: { of: db.meta.source + '@' + db.meta.created, fen: fen, line: o.line || null, plies: o.plies,
      minGames: o.minGames, positions: keys.length }
  });
  // Keep the list of dumps (for eval's holdout check), not the import's whole report.
  meta.report = db.meta.report && db.meta.report.dumps ? { dumps: db.meta.report.dumps } : null;
  var part = out + '.part';
  var fd = fs.openSync(part, 'w+');
  var records = 0;
  try {
    writeHeader(fd, meta, HEADER_PAD);
    var wr = recordWriter(fd);
    keys.forEach(function (k) {
      var lo = Number(k & 0xffffffffn), hi = Number(k >> 32n);
      kept.get(k).forEach(function (r) {
        wr.put(lo, hi, r.code, r.white, r.draws, r.black);
        records++;
      });
    });
    wr.flush();
    rewriteHeader(fd, meta);
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(out, { force: true });
  fs.renameSync(part, out);
  return { positions: keys.length, records: records, bytes: fs.statSync(out).size };
}
