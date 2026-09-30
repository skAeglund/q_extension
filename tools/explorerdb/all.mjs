/*
 * explorerdb all: every monthly dump of Lichess's standard rated games into one
 * accumulator (acc.mjs), unattended, and an index at the end.
 *
 * For each month still missing: download (resumed after a break, checked against
 * Lichess's sha256sums.txt), add to the accumulator, delete the dump. The next month
 * downloads while one is imported when the disk has room for both. Before each import the
 * disk budget is checked, and the accumulator is pruned at the lowest threshold that
 * makes room (see acc.mjs for what that costs).
 *
 * Stopping is safe at any point, a crash or Ctrl+C included: run the same command again
 * and it carries on (a month cut off mid-import is imported again, into the shards that
 * don't have it yet).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { importDump } from './importer.mjs';
import { openAcc, addDump, hasDump, prune, pruneFor, writeIndex, summary } from './acc.mjs';
import { THRESHOLDS } from './store.mjs';

var BASE = 'https://database.lichess.org/standard/';
var GB = 1e9;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function gb(b) {
  return b >= GB ? (b / GB).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(1) + ' kB';
}
function monthOf(name) { var m = /(\d{4}-\d{2})/.exec(name); return m ? m[1] : null; }

// Tries `fn` again after 15 s, 30 s, ... up to 10 minutes apart: a night's outage is survived.
async function retry(what, log, fn, unitMs) {
  for (var attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 30) throw e;
      var wait = Math.min(600, 15 * Math.pow(2, Math.min(attempt, 6)));
      log(what + ' failed (' + (e && e.message || e) + '); again in ' + wait + ' s');
      await sleep(wait * (unitMs == null ? 1000 : unitMs));
    }
  }
}

async function fetchText(url, log) {
  return retry('fetching ' + url, log, async function () {
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
}

// The dumps Lichess lists, with their sizes (counts.txt has game counts, not bytes).
export async function listDumps(log) {
  var urls = (await fetchText(BASE + 'list.txt', log)).split(/\s+/).filter(Boolean);
  var sums = {};
  (await fetchText(BASE + 'sha256sums.txt', log)).split('\n').forEach(function (l) {
    var m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim());
    if (m) sums[m[2]] = m[1];
  });
  return urls.map(function (u) {
    var name = u.slice(u.lastIndexOf('/') + 1);
    return { url: u, name: name, month: monthOf(name), sha256: sums[name] || null };
  }).filter(function (d) { return d.month; });
}

async function sizeOf(d, log, unitMs) {
  if (d.size) return d.size;
  d.size = await retry('asking the size of ' + d.name, log, async function () {
    var res = await fetch(d.url, { method: 'HEAD' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var n = Number(res.headers.get('content-length'));
    if (!(n > 0)) throw new Error('no Content-Length');
    return n;
  }, unitMs);
  return d.size;
}

async function sha256(file) {
  var h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 22 }), h);
  return h.digest('hex');
}

/*
 * One connection by default. Measured on 2026-09-30 over cable (11 MB/s to OVH): one
 * connection to Lichess got 7.4–8.4 MB/s, two at once 3.5 + 3.6. Over the earlier, slower
 * line two gained nothing either, since the line was full. So a second connection only
 * presses harder on a donation-run server. `--connections` is there for a case where it
 * does help.
 */
export var CONNECTIONS = 1;
var MIN_SPLIT = 64e6;          // a range left under twice this isn't split again

// Just enough bencode for a .torrent: integers, byte strings (as Buffers), lists, dicts.
export function bdecode(buf) {
  var i = 0;
  function next() {
    var c = buf[i];
    if (c === 0x69) {                                    // i<n>e
      var e = buf.indexOf(0x65, i);
      var n = Number(buf.toString('latin1', i + 1, e));
      i = e + 1;
      return n;
    }
    if (c === 0x6c || c === 0x64) {                      // l...e, d...e
      i++;
      var l = c === 0x6c ? [] : {};
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('bencode: cut off');
        if (c === 0x6c) l.push(next());
        else { var k = next().toString('latin1'); l[k] = next(); }
      }
      i++;
      return l;
    }
    var colon = buf.indexOf(0x3a, i);                    // <len>:<bytes>
    var len = Number(buf.toString('latin1', i, colon));
    if (!(colon > i) || !(len >= 0) || colon + 1 + len > buf.length) throw new Error('bencode: bad string at ' + i);
    i = colon + 1 + len;
    return buf.subarray(colon + 1, i);
  }
  return next();
}

/*
 * After a failed sha256: finds the bad pieces by the SHA-1s in Lichess's .torrent for the
 * dump (nobody seeds them, but the hashes are good) and fetches only those again, by Range.
 * true when it replaced some; false when it can't help (no torrent, a torrent for another
 * upload of the dump, as 2026-06's is, or most of the file bad), and the caller downloads
 * it all again.
 */
async function repair(d, part, size, log, o) {
  var t;
  try {
    var res = await fetch(d.url + '.torrent', { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    t = bdecode(Buffer.from(await res.arrayBuffer())).info;
    if (!t || !(t['piece length'] > 0) || !t.pieces) throw new Error('not a torrent');
  } catch (e) {
    log('no piece hashes for ' + d.name + ' (' + (e && e.message || e) + ')');
    return false;
  }
  if (t.length !== size) {
    log('the torrent of ' + d.name + ' is for another upload of it (' + t.length + ' bytes, not ' + size + ')');
    return false;
  }
  var plen = t['piece length'], count = Math.ceil(size / plen);
  if (t.pieces.length !== count * 20) { log('the torrent of ' + d.name + ' has the wrong number of pieces'); return false; }
  log('finding the bad pieces of ' + d.name + ' (' + count + ' pieces of ' + gb(plen) + ')');
  var bad = [], buf = Buffer.alloc(plen), fh = await fsp.open(part, 'r+');
  try {
    for (var p = 0; p < count; p++) {
      var at = p * plen, n = Math.min(plen, size - at);
      await fh.read(buf, 0, n, at);
      var h = crypto.createHash('sha1').update(buf.subarray(0, n)).digest();
      if (!h.equals(t.pieces.subarray(p * 20, p * 20 + 20))) bad.push(p);
    }
    if (!bad.length) { log('every piece of ' + d.name + ' is good, yet the sha256 isn\'t'); return false; }
    if (bad.length > count / 2) { log(bad.length + ' of ' + count + ' pieces are bad'); return false; }
    log(bad.length + ' of ' + count + ' pieces are bad (' + gb(bad.length * plen) + ', from ' +
      gb(bad[0] * plen) + '); fetching them again');
    // Adjacent bad pieces go in one request, up to 64 MB (a crash leaves one run of them).
    var runs = [];
    bad.forEach(function (q) {
      var r = runs[runs.length - 1];
      if (r && q === r.to && (r.to - r.from) * plen < 64e6) r.to++;
      else runs.push({ from: q, to: q + 1 });
    });
    for (var k = 0; k < runs.length; k++) {
      var run = runs[k], from = run.from * plen, len = Math.min(run.to * plen, size) - from;
      await retry('fetching pieces ' + run.from + '-' + (run.to - 1) + ' of ' + d.name, log, async function () {
        var r = await fetch(d.url, { signal: AbortSignal.timeout(o.pieceMs || 300000),
          headers: { Range: 'bytes=' + from + '-' + (from + len - 1) } });
        if (r.status !== 206) throw new Error('HTTP ' + r.status);
        var got = Buffer.from(await r.arrayBuffer());
        if (got.length !== len) throw new Error(got.length + ' of ' + len + ' bytes');
        for (var q = run.from; q < run.to; q++) {
          var piece = got.subarray((q - run.from) * plen, Math.min((q - run.from + 1) * plen, len));
          if (!crypto.createHash('sha1').update(piece).digest().equals(t.pieces.subarray(q * 20, q * 20 + 20))) {
            throw new Error('piece ' + q + ' came back bad');
          }
        }
        await fh.write(got, 0, len, from);
      }, o.unitMs);
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

/*
 * Downloads d.url to `dest` over `connections` Range requests at once, into dest.part,
 * so a break resumes where it stopped. dest.part.json holds each range's progress
 * ({at, to}), saved every few seconds and only after the bytes are written; a .part with
 * no .json (a single-connection download from before) counts as done up to its length.
 * Whenever fewer ranges than connections are left, the largest is split in half, so both
 * connections stay busy to the end. A connection that sends nothing for 2 minutes stops
 * the pass, which is resumed. Checked against Lichess's sha256 before it's renamed into
 * place; a copy that fails is repaired piece by piece if the torrent allows (repair()),
 * and otherwise fetched again whole.
 */
export async function download(d, dest, log, o) {
  o = o || {};
  if (fs.existsSync(dest)) return dest;
  var size = await sizeOf(d, log, o.unitMs), part = dest + '.part', map = part + '.json';
  var conns = Math.max(1, o.connections || CONNECTIONS), minSplit = o.minSplit || MIN_SPLIT;
  var noRanges = false;

  function load() {
    var have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (fs.existsSync(map)) {
      try {
        var m = JSON.parse(fs.readFileSync(map, 'utf8'));
        if (m.size === size && have === size) return m.ranges;
      } catch (e) { /* unreadable: start over */ }
      fs.rmSync(map);
      fs.rmSync(part, { force: true });
      return [{ at: 0, to: size }];
    }
    if (have > size) { fs.rmSync(part); have = 0; }
    return [{ at: have, to: size }];
  }
  function save(ranges) {
    fs.writeFileSync(map + '.tmp', JSON.stringify({ size: size, ranges: ranges }));
    fs.renameSync(map + '.tmp', map);
  }
  function left(ranges) {
    return ranges.reduce(function (n, r) { return n + r.to - r.at; }, 0);
  }

  for (var round = 0; ; round++) {
    await retry('downloading ' + d.name, log, async function () {
      var ranges = noRanges ? [{ at: 0, to: size }] : load().filter(function (r) { return r.at < r.to; });
      if (!ranges.length && fs.existsSync(part)) return;
      if (!noRanges) {
        for (;;) {
          if (ranges.length >= conns) break;
          var big = ranges.reduce(function (a, r) { return !a || r.to - r.at > a.to - a.at ? r : a; }, null);
          if (!big || big.to - big.at < 2 * minSplit) break;
          var mid = big.at + Math.floor((big.to - big.at) / 2);
          ranges.push({ at: mid, to: big.to });
          big.to = mid;
        }
      }
      // The map first: a .part at full length with no map would read as finished.
      save(ranges);
      var fh = await fsp.open(part, fs.existsSync(part) ? 'r+' : 'w+');
      var ctl = new AbortController();
      var from = size - left(ranges), last = Date.now(), t0 = Date.now(), saved = Date.now();
      /*
       * Progress is saved only for bytes known to be on the disk: the positions are taken,
       * then the file is flushed, then they're saved. Without the flush, a crash can keep
       * the file's length while losing its last writes to zeros, and a resume trusts them.
       * That happened on 2026-09-30 (an unexpected restart; 126 zero bytes in log.txt),
       * and cost the whole of 2026-07 on its sha256 check.
       */
      var checkpoint = async function () {
        var snap = ranges.map(function (r) { return { at: r.at, to: r.to }; });
        await fh.sync();
        save(snap);
      };
      try {
        if ((await fh.stat()).size < size) await fh.truncate(size);
        var one = async function (r) {
          // Each connection its own stall timer: a stuck one mustn't hide behind the other.
          var stall = null, poke = function () {
            clearTimeout(stall);
            stall = setTimeout(function () { ctl.abort(new Error('no data for 2 minutes')); }, o.stallMs || 120000);
          };
          poke();
          try {
            await oneRange(r, poke);
          } finally {
            clearTimeout(stall);
          }
        };
        var oneRange = async function (r, poke) {
          var res = await fetch(d.url, { signal: ctl.signal,
            headers: noRanges ? {} : { Range: 'bytes=' + r.at + '-' + (r.to - 1) } });
          if (!noRanges && res.status === 200) {
            noRanges = true;                          // no ranges offered: one connection, from 0
            throw new Error('the server ignored the range');
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          for await (var b of Readable.fromWeb(res.body)) {
            poke();
            var n = Math.min(b.length, r.to - r.at);
            if (n > 0) await fh.write(b, 0, n, r.at);
            r.at += n;
            if (r.at >= r.to) break;
            if (Date.now() - saved > 5000) { saved = Date.now(); await checkpoint(); }
            if (Date.now() - last > 60000) {
              last = Date.now();
              var got = size - left(ranges), rate = (got - from) / ((Date.now() - t0) / 1000);
              log('downloading ' + d.name + ': ' + gb(got) + ' of ' + gb(size) + ', ' +
                (rate / 1e6).toFixed(1) + ' MB/s (' + ranges.filter(function (x) { return x.at < x.to; }).length +
                ' connections), about ' + Math.round((size - got) / rate / 60) + ' min to go');
            }
          }
          if (r.at < r.to) throw new Error('a connection ended at ' + r.at + ' of ' + r.to + ' bytes');
        };
        // One failing stops the others, so the pass can be resumed as a whole.
        var res = await Promise.allSettled(ranges.map(function (r) {
          return one(r).catch(function (e) { ctl.abort(e); throw e; });
        }));
        var bad = res.find(function (x) { return x.status === 'rejected'; });
        if (bad) throw ctl.signal.reason || bad.reason;
      } finally {
        // Every write has settled by now; a failed flush keeps the last saved map.
        var synced = await fh.sync().then(function () { return true; }, function () { return false; });
        await fh.close();
        if (synced) save(ranges);
      }
    }, o.unitMs);
    if (!d.sha256) { log('no sha256 listed for ' + d.name + '; not checked'); break; }
    log('checking ' + d.name);
    var sum = await sha256(part);
    if (sum === d.sha256) break;
    if (round === 0 && await repair(d, part, size, log, o)) {
      log('checking ' + d.name + ' again');
      sum = await sha256(part);
      if (sum === d.sha256) break;
    }
    fs.rmSync(part);
    fs.rmSync(map, { force: true });
    if (round >= 1) throw new Error(d.name + ': sha256 mismatch twice (' + sum + ')');
    log(d.name + ': sha256 mismatch; downloading it again');
  }
  fs.renameSync(part, dest);
  fs.rmSync(map, { force: true });
  return dest;
}

function dirBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce(function (n, f) {
    var p = path.join(dir, f), st = fs.statSync(p);
    return n + (st.isDirectory() ? dirBytes(p) : st.size);
  }, 0);
}

function freeBytes(dir) {
  var s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

/*
 * The most a dump takes on disk while it's added, as a multiple of its size: the larger
 * of its spill files and what the accumulator grew by, from the last dumps added. Before
 * any, feb16's (1.2 and 1.4), rounded up.
 */
function peakRatio(acc, first) {
  var r = acc.state.ops.filter(function (op) { return op.type === 'dump' && op.size; }).slice(-3)
    .map(function (op) {
      return Math.max(op.report.spilled * 16, op.bytesAfter - op.bytesBefore) / op.size;
    });
  return r.length ? Math.max.apply(null, r) : first || 1.6;
}

/*
 * o: { acc (dir), dumps (dir), out (index path), minGames, from, to, oldestFirst,
 *      diskBytes, reserveBytes, prefetch, keepDumps, snapshotEvery, workers, filter, plies,
 *      connections, log, and for tests: list (the dumps, instead of asking Lichess), fetchDump,
 *      marginBytes, firstRatio }
 */
export async function runAll(o) {
  var log = o.log;
  fs.mkdirSync(o.dumps, { recursive: true });
  var acc = openAcc(o.acc, { create: { filter: o.filter, plies: o.plies } });
  try {
    var st = acc.state;
    if (JSON.stringify(st.filter) !== JSON.stringify(o.filter) || st.plies !== o.plies) {
      log('The accumulator keeps its own filter: ' + st.filter.speeds.join(', ') + '; ratings ' +
        st.filter.ratings.join(', ') + '; ' + st.plies + ' plies');
    }
    if (st.pending && st.pending.type === 'prune') {
      log('finishing the prune at ' + st.pending.minGames + ' that was cut off');
      prune(acc, st.pending.minGames, log);
    }

    var all = o.list || await listDumps(log);
    var todo = all.filter(function (d) {
      return (!o.from || d.month >= o.from) && (!o.to || d.month <= o.to) && !hasDump(acc, d.name);
    });
    todo.sort(function (a, b) { return o.oldestFirst ? (a.month < b.month ? -1 : 1) : (a.month < b.month ? 1 : -1); });
    if (st.pending) {
      var p = todo.findIndex(function (d) { return d.name === st.pending.source; });
      if (p < 0) throw new Error('The accumulator was adding ' + st.pending.source + ', which isn\'t in the range asked for');
      todo.unshift(todo.splice(p, 1)[0]);
    }
    var sum0 = summary(acc);
    log(sum0.dumps.length + ' dumps in ' + o.acc + ' already, ' + todo.length + ' to go' +
      (todo.length ? ' (' + todo[0].month + (todo.length > 1 ? ' .. ' + todo[todo.length - 1].month : '') + ')' : ''));

    // A dump left behind by a stop just after it was added.
    if (!o.keepDumps) {
      fs.readdirSync(o.dumps).forEach(function (f) {
        if (hasDump(acc, f)) { log('deleting ' + f + ', added already'); fs.rmSync(path.join(o.dumps, f), { force: true }); }
      });
    }

    var fetchDump = o.fetchDump || function (d, dest) { return download(d, dest, log, { connections: o.connections }); };
    var dest = function (d) { return path.join(o.dumps, d.name); };
    var prefetched = null;       // { d, promise }

    // Disk the run may use now: its budget, or less if the disk itself is fuller.
    function budget() {
      var used = acc.totals().bytes + dirBytes(o.dumps) + dirBytes(path.join(o.acc, 'import.tmp'));
      return Math.min(o.diskBytes, used + freeBytes(o.dumps) - o.reserveBytes);
    }
    function onDisk() { return acc.totals().bytes + dirBytes(o.dumps); }

    // Prunes until `need` more bytes fit, never above the final index's own threshold
    // (below it, pruning doesn't change the final index).
    function makeRoom(need, why) {
      var room = budget() - onDisk();
      if (need <= room) return;
      var t = acc.totals();
      var target = t.bytes - (need - room);
      var at = pruneFor(t, target);
      if (at > o.minGames) at = o.minGames;
      log('need ' + gb(need) + ' ' + why + ', have ' + gb(Math.max(0, room)) + ': pruning the accumulator (' +
        gb(t.bytes) + ') at ' + at + ' games');
      var op = prune(acc, at, log);
      log('pruned at ' + at + ': ' + gb(op.bytesBefore) + ' -> ' + gb(op.bytesAfter) + ' in ' + op.seconds + ' s');
      room = budget() - onDisk();
      if (need > room) {
        throw new Error('Not enough disk: ' + gb(need) + ' needed ' + why + ', ' + gb(room) +
          ' left even with the accumulator pruned at ' + at + '. Free some space or raise --disk-gb.');
      }
    }

    var added = 0;
    for (var i = 0; i < todo.length; i++) {
      var d = todo[i];
      var file = null;
      if (prefetched && prefetched.d === d) {
        var pf = prefetched;
        prefetched = null;
        file = await pf.promise.catch(function (e) {
          log('the download meanwhile failed (' + (e && e.message || e) + '); trying again');
          return null;
        });
      }
      if (!file) {
        await sizeOf(d, log);
        if (!fs.existsSync(dest(d))) makeRoom(d.size, 'to download ' + d.name);
        file = await fetchDump(d, dest(d));
      }
      d.size = fs.statSync(file).size;
      var need = d.size * peakRatio(acc, o.firstRatio) * 1.15 + acc.totals().bytes * 0.05 + (o.marginBytes == null ? GB : o.marginBytes);
      makeRoom(need, 'to add ' + d.name);

      var next = todo[i + 1];
      if (o.prefetch && next && !fs.existsSync(dest(next))) {
        await sizeOf(next, log);
        if (budget() - onDisk() - need - next.size >= 0) {
          log('downloading ' + next.name + ' (' + gb(next.size) + ') meanwhile');
          prefetched = { d: next, promise: fetchDump(next, dest(next)) };
          prefetched.promise.catch(function () { /* awaited, and reported, when its turn comes */ });
        }
      }

      log('adding ' + d.name + ' (' + gb(d.size) + '; ' + (i + 1) + ' of ' + todo.length + ')');
      var op = await addDump(acc, file, importDump, { workers: o.workers, log: log });
      var g = op.report.games;
      log('added ' + d.name + ': ' + g.kept.toLocaleString('en-US') + ' of ' + g.read.toLocaleString('en-US') +
        ' games kept, accumulator ' + gb(op.bytesBefore) + ' -> ' + gb(op.bytesAfter) + ', ' +
        Math.round(op.report.seconds / 60) + ' min');
      if (!o.keepDumps) fs.rmSync(file, { force: true });
      added++;
      if (o.snapshotEvery && added % o.snapshotEvery === 0 && i < todo.length - 1) snapshot(false);
    }
    if (prefetched) await prefetched.promise;
    snapshot(true);
    return summary(acc);

    function snapshot(last) {
      var t = acc.totals();
      var i10 = THRESHOLDS.indexOf(o.minGames);
      var size = i10 >= 0 ? t.records[i10] * 22 : t.bytes;
      var room = budget() - onDisk();
      if (size > room) {
        if (!last) { log('no room for a snapshot (' + gb(size) + '); skipped'); return; }
        // Pruning at the index's own threshold leaves what it holds unchanged.
        log('no room for the index (' + gb(size) + ' needed, ' + gb(room) + ' free): pruning at ' + o.minGames + ' first');
        prune(acc, o.minGames, log);
      }
      log('writing ' + o.out + ' (N >= ' + o.minGames + ')');
      var meta = writeIndex(acc, o.out, o.minGames, log);
      log('wrote ' + o.out + ': ' + meta.report.positions.toLocaleString('en-US') + ' positions, ' +
        gb(fs.statSync(o.out).size) + (meta.report.maxUndercount ? '; a kept position is missing at most ' +
          meta.report.maxUndercount + ' games to prunes' : ''));
    }
  } finally {
    acc.close();
  }
}
