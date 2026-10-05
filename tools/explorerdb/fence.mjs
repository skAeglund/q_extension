/*
 * explorerdb: an index reader that finds a position in one read.
 *
 * openIndex (store.mjs) binary-searches the file itself: about 32 reads of 8 bytes for an
 * index of billions of records. That is fine for the explorer's one query at a time, but a
 * deep search (tools/deeprep.mjs) makes millions of lookups. Here the first hash of every
 * block of `block` records is kept in memory (the fences), so a lookup is a binary search
 * in memory and then one read of a block, rarely two.
 *
 * The fences are built once by reading the index from end to end (sequential reads are
 * what an SSD does fastest) and saved next to it, <index>.fence, with the index's size and
 * creation time, so a re-imported index gets new ones. 1,024 records a block is 22.5 kB a
 * read, and 8 bytes of memory per 1,024 records: about 50 MB for a 150 GB index.
 *
 * Fence file: "QXXFNC01", u32 length of the JSON header, the JSON header, then the fences,
 * u64 little-endian each.
 */

import fs from 'node:fs';
import { openIndex, REC } from './store.mjs';

var MAGIC = 'QXXFNC01';
export var BLOCK = 1024;

function stamp(db, size, block) {
  return { indexSize: size, created: db.meta.created, source: db.meta.source, block: block };
}

function sameStamp(a, b) {
  return a.indexSize === b.indexSize && a.created === b.created && a.source === b.source &&
    a.block === b.block;
}

function readFences(file, want) {
  if (!fs.existsSync(file)) return null;
  var buf = fs.readFileSync(file);
  if (buf.length < 12 || buf.toString('latin1', 0, 8) !== MAGIC) return null;
  var len = buf.readUInt32LE(8);
  var head;
  try { head = JSON.parse(buf.toString('utf8', 12, 12 + len)); } catch (e) { return null; }
  if (!sameStamp(head, want)) return null;
  var n = (buf.length - 12 - len) / 8;
  if (n !== head.fences) return null;
  var out = new BigUint64Array(n);
  for (var i = 0; i < n; i++) out[i] = buf.readBigUInt64LE(12 + len + i * 8);
  return out;
}

function writeFences(file, head, fences) {
  var json = Buffer.from(JSON.stringify(head), 'utf8');
  var buf = Buffer.alloc(12 + json.length + fences.length * 8);
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt32LE(json.length, 8);
  json.copy(buf, 12);
  for (var i = 0; i < fences.length; i++) buf.writeBigUInt64LE(fences[i], 12 + json.length + i * 8);
  fs.writeFileSync(file + '.part', buf);
  fs.renameSync(file + '.part', file);
}

// Reads the whole index once, in large chunks, and takes the hash at each block's start.
function buildFences(db, fd, block, progress) {
  var nb = Math.ceil(db.count / block);
  var fences = new BigUint64Array(nb);
  var per = Math.max(1, Math.floor((16 << 20) / (block * REC)));   // blocks per chunk, ~16 MB
  var buf = Buffer.allocUnsafe(per * block * REC);
  var last = Date.now();
  for (var b = 0; b < nb; b += per) {
    var first = b * block;
    var recs = Math.min(per * block, db.count - first);
    var got = fs.readSync(fd, buf, 0, recs * REC, db.start + first * REC);
    if (got < recs * REC) throw new Error('The index ended early while reading it');
    for (var k = 0; b + k < nb && k < per; k++) fences[b + k] = buf.readBigUInt64LE(k * block * REC);
    if (progress && Date.now() - last > 5000) {
      last = Date.now();
      progress(b / nb);
    }
  }
  return fences;
}

/*
 * Opens `file` with fences: { meta, count, start, records(key), lookups(), close() }, the
 * same records(key) as openIndex. o: { block, fenceFile (default <file>.fence; false: don't
 * save), progress(fraction), log(line) }.
 */
export function openFenced(file, o) {
  o = o || {};
  var block = o.block || BLOCK;
  var db = openIndex(file);
  db.close();
  var fd = fs.openSync(file, 'r');
  var size = fs.fstatSync(fd).size;
  var want = stamp(db, size, block);
  var fenceFile = o.fenceFile === false ? null : (o.fenceFile || file + '.fence');
  var fences = fenceFile ? readFences(fenceFile, want) : null;
  if (!fences) {
    if (o.log) o.log('Reading the index once to find its blocks (' + db.count + ' records)');
    fences = buildFences(db, fd, block, o.progress);
    if (fenceFile) {
      try { writeFences(fenceFile, Object.assign({ fences: fences.length }, want), fences); } catch (e) {
        if (o.log) o.log('Could not save ' + fenceFile + ': ' + (e && e.message || e));
      }
    }
  }

  var n = db.count, start = db.start;
  var buf = Buffer.allocUnsafe(block * REC);
  var reads = 0, lookups = 0;

  // Records [from, from + block) into buf; returns how many.
  function readBlock(bi) {
    var from = bi * block;
    var cnt = Math.min(block, n - from);
    fs.readSync(fd, buf, 0, cnt * REC, start + from * REC);
    reads++;
    return cnt;
  }

  function records(key) {
    lookups++;
    var out = [];
    if (!n) return out;
    // First fence >= key; the position's records start in the block before it, or (when
    // that fence equals the key) exactly at that fence.
    var a = 0, b = fences.length;
    while (a < b) {
      var m = (a + b) >>> 1;
      if (fences[m] < key) a = m + 1; else b = m;
    }
    var bi = a > 0 ? a - 1 : 0;
    for (; bi < fences.length; bi++) {
      if (bi > 0 && fences[bi] > key) break;
      var cnt = readBlock(bi);
      // First record >= key in this block.
      var lo = 0, hi = cnt;
      while (lo < hi) {
        var mid = (lo + hi) >>> 1;
        if (buf.readBigUInt64LE(mid * REC) < key) lo = mid + 1; else hi = mid;
      }
      for (var j = lo; j < cnt; j++) {
        var o = j * REC;
        if (buf.readBigUInt64LE(o) !== key) return out;
        out.push({ code: buf.readUInt16LE(o + 8), white: buf.readUInt32LE(o + 10),
          draws: buf.readUInt32LE(o + 14), black: buf.readUInt32LE(o + 18) });
      }
      // Reached the block's end: the position may go on in the next one.
    }
    return out;
  }

  return {
    meta: db.meta,
    count: n,
    start: start,
    block: block,
    fences: fences.length,
    records: records,
    stats: function () { return { lookups: lookups, reads: reads }; },
    close: function () { fs.closeSync(fd); }
  };
}
