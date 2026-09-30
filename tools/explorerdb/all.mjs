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

/*
 * Downloads d.url to `dest` over `connections` Range requests at once, into dest.part,
 * so a break resumes where it stopped. dest.part.json holds each range's progress
 * ({at, to}), saved every few seconds and only after the bytes are written; a .part with
 * no .json (a single-connection download from before) counts as done up to its length.
 * Whenever fewer ranges than connections are left, the largest is split in half, so both
 * connections stay busy to the end. A connection that sends nothing for 2 minutes stops
 * the pass, which is resumed. Checked against Lichess's sha256 before it's renamed into
 * place.
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
            if (Date.now() - saved > 5000) { saved = Date.now(); save(ranges); }
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
        await fh.close();
        save(ranges);
      }
    }, o.unitMs);
    if (!d.sha256) { log('no sha256 listed for ' + d.name + '; not checked'); break; }
    log('checking ' + d.name);
    var sum = await sha256(part);
    if (sum === d.sha256) break;
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
