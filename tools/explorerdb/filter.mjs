/*
 * explorerdb filter: one Lichess dump -> just the games an import would keep, much smaller.
 *
 * Why: downloading the dumps is the slow part at home. A machine with a fast line (a cloud
 * session) reads the dump, keeps the games that pass the filter, and writes each one as
 * its five headers the import reads and its first `plies` + 1 moves: the extra ply tells
 * the import a game went on past the limit (CUT) from one that ended there. Clocks, names,
 * links and the rest go. The output is still PGN that `import` reads, though without move
 * numbers, and it is split into parts under `partBytes` (GitHub refuses files over 100 MB),
 * each a whole zstd frame ending on a whole game, listed in a manifest (<base>.json) with
 * their sizes and sha256. `import <base>.json` reads the parts back to back.
 *
 * A month takes hours, and a cloud container can be recycled in the middle of one. So each
 * closed part comes with a checkpoint (`onPart`): the counts up to its last game, the start
 * of the game after it, and where that game is in the dump (`at`: the byte offset of its
 * zstd frame, and how far into the frame's text it starts). A run given that checkpoint
 * (`resume`) downloads the dump from that frame on, checks it arrived at the same game, and
 * goes on with the next part. Lichess's dumps are frames of about 6 MB, so that costs one
 * frame, wherever in the month the checkpoint is.
 *
 * A checkpoint without `at` (from before it existed), or an `at` that doesn't land on its
 * game (a server that ignores byte ranges, say), falls back to reading the dump from the
 * start and counting games up to the checkpoint: about 20 minutes for 30 M games.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { makeFilter, header, movetextSans, FILTERED_FORMAT } from './games.mjs';
import { curlStream, zstdFrames, DEFAULTS } from './importer.mjs';

export var FILTER_DEFAULTS = {
  speeds: DEFAULTS.speeds,
  ratings: DEFAULTS.ratings,
  plies: DEFAULTS.plies,
  partBytes: 95e6,
  chunkBytes: 1 << 20,
  // 19 with a 128 MB window: openings repeat across games far apart, and the parts are
  // written once and downloaded many times. 2^27 is what decoders accept by default.
  level: 19,
  windowLog: 27
};

var RESULTS = { '1-0': 1, '0-1': 1, '1/2-1/2': 1 };

// One kept game, as short as import can read it.
export function compactGame(text, plies) {
  var body = text.indexOf('\n\n');
  var head = text.slice(0, body);
  var result = header(head, 'Result');
  var sans = movetextSans(text.slice(body + 2), plies + 1);
  return '[Event "?"]\n[Result "' + result + '"]\n[WhiteElo "' + header(head, 'WhiteElo') +
    '"]\n[BlackElo "' + header(head, 'BlackElo') + '"]\n[TimeControl "' + header(head, 'TimeControl') +
    '"]\n\n' + (sans.length ? sans.join(' ') + ' ' : '') + result + '\n\n';
}

function openPart(file, o) {
  var P = zlib.constants;
  var params = {};
  params[P.ZSTD_c_compressionLevel] = o.level;
  params[P.ZSTD_c_windowLog] = o.windowLog;
  params[P.ZSTD_c_enableLongDistanceMatching] = 1;
  params[P.ZSTD_c_checksumFlag] = 1;
  var z = zlib.createZstdCompress({ params: params });
  var out = fs.createWriteStream(file);
  var hash = crypto.createHash('sha256');
  var part = { file: file, bytes: 0, games: 0, z: z };
  z.on('data', function (b) { part.bytes += b.length; hash.update(b); });
  var done = new Promise(function (resolve, reject) {
    z.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
  });
  done.catch(function () {});
  z.pipe(out);
  // Writes a chunk and flushes it, so `bytes` is exact afterwards: that is what keeps a
  // part under the limit. A flush per megabyte ends a block early now and then, which
  // costs next to nothing.
  part.write = async function (s) {
    if (!z.write(s)) await once(z, 'drain');
    await new Promise(function (resolve) { z.flush(resolve); });
  };
  part.close = async function () {
    z.end();
    await done;
    part.sha256 = hash.digest('hex');
  };
  part.abort = function () { z.destroy(); out.destroy(); };
  return part;
}

function fmt(n) { return n.toLocaleString('en-US'); }
function mb(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB'; }

// The first two lines of the game at `at` (Event and Site, which names the game), or what
// the chunk holds of them: what a resumed run must find where it picks up.
function gameStart(s, at) {
  var e = s.indexOf('\n', s.indexOf('\n', at) + 1);
  return s.slice(at, e < 0 ? Math.min(s.length, at + 200) : e);
}

// Either may be cut short by the end of a chunk.
function samePrefix(a, b) {
  return typeof b === 'string' && b.length > 0 && (a.indexOf(b) === 0 || b.indexOf(a) === 0);
}

var unzstd = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null;

/*
 * The dump's text in pieces, each with where it starts: {offset, skip, text} is text from
 * `skip` bytes into the decompressed frame at byte `offset` of the dump. A .zst dump is
 * decompressed one whole frame at a time (the next while this one is filtered), which is what
 * lets a checkpoint name the frame a game is in; zstdFrames already walks the frames, since
 * Node's streaming decoder can't be trusted with pzstd's. In a plain PGN a piece's offset is
 * just its first byte. From `at` ({offset, skip}), it starts there. Text is latin1, one
 * character a byte, so a position in the text is a byte count.
 */
function openPieces(input, at, onBytes, curl) {
  var start = at ? at.offset : 0;
  var raw = input === '-' ? process.stdin
    : /^https?:\/\//i.test(input) ? curlStream(input, { start: start, curl: curl || 'curl' })
    : fs.createReadStream(input, { start: start, highWaterMark: 1 << 20 });
  raw.on('data', function (b) { onBytes(b.length); });
  var zst = input === '-' || /\.zst$/i.test(input.replace(/[?#].*$/, ''));
  var frames = null;
  if (zst) {
    if (!unzstd) throw new Error('This Node has no zstd (Node 22.15 or later has)');
    frames = zstdFrames({ whole: true, start: start });
    raw.on('error', function (e) { frames.destroy(e); });
    raw.pipe(frames);
  }
  async function* whole() {
    if (!zst) {
      var pos = start;
      for await (var b of raw) { yield { offset: pos, skip: 0, text: b.toString('latin1') }; pos += b.length; }
      return;
    }
    var queue = [];
    var take = async function () {
      var q = queue.shift();
      return { offset: q.offset, skip: 0, text: (await q.p).toString('latin1') };
    };
    for await (var f of frames) {
      var p = unzstd(f.data);
      p.catch(function () {});
      queue.push({ offset: f.offset, p: p });
      if (queue.length > 1) yield await take();
    }
    while (queue.length) yield await take();
  }
  async function* pieces() {
    var drop = at ? at.skip : 0;
    for await (var c of whole()) {
      if (drop) {
        if (drop >= c.text.length) { drop -= c.text.length; continue; }
        c = { offset: c.offset, skip: c.skip + drop, text: c.text.slice(drop) };
        drop = 0;
      }
      yield c;
    }
  }
  return {
    pieces: pieces(),
    stop: function () { raw.destroy(); if (frames) frames.destroy(); }
  };
}

// Where position p of the text is in the dump, given the pieces it is made of (`segs`: each
// piece's position in the text, ascending).
function locate(segs, p) {
  for (var i = segs.length - 1; i > 0 && segs[i].pos > p; i--);
  return { offset: segs[i].offset, skip: segs[i].skip + p - segs[i].pos };
}
// The pieces of the text from position p on.
function segsFrom(segs, p) {
  var first = locate(segs, p);
  return [{ pos: 0, offset: first.offset, skip: first.skip }].concat(segs.filter(function (g) { return g.pos > p; })
    .map(function (g) { return { pos: g.pos - p, offset: g.offset, skip: g.skip }; }));
}

/*
 * o: { input (a dump, an https URL of one, or '-' for a .zst on stdin), size (a URL's), out (path without extension), source,
 *      speeds, ratings, plies, partBytes, chunkBytes, level, windowLog, maxGames, log, curl (tests),
 *      onPart(part, checkpoint) (awaited after each part but the last closes),
 *      resume (a checkpoint: its parts are not written again, and are not in `out`'s directory) }
 * Resolves with the manifest written to <out>.json. A resume that doesn't arrive at the
 * checkpoint's game, even counting from the start, rejects with `resumeMismatch` set.
 */
export async function filterDump(o) {
  o = Object.assign({}, FILTER_DEFAULTS, o);
  var log = o.log || function () {};
  var r = o.resume;
  if (r && (r.plies !== o.plies || JSON.stringify(r.filter) !== JSON.stringify({ speeds: o.speeds, ratings: o.ratings }))) {
    throw Object.assign(new Error('The checkpoint is for another filter'), { resumeMismatch: true });
  }
  if (!r || !r.at || o.input === '-') return filterRun(o, log, null);
  try {
    return await filterRun(o, log, r.at);
  } catch (e) {
    if (!e || !e.atMiss) throw e;
    log('resuming at the checkpoint\'s byte offset failed (' + e.message + '); counting the games from the start instead');
    return filterRun(o, log, null);
  }
}

// One go at it: from `from` (the checkpoint's `at`, its place in the dump), or from the start.
async function filterRun(o, log, from) {
  var filter = makeFilter(o);
  var why = { broken: 0, variant: 0, speed: 0, rating: 0, result: 0 };
  var n = { read: 0, kept: 0, bytesIn: 0, textOut: 0 };
  var url = /^https?:\/\//i.test(o.input);
  var size = o.input === '-' || url ? o.size || 0 : fs.statSync(o.input).size;
  var base = path.basename(o.out);
  var dir = path.dirname(o.out);
  fs.mkdirSync(dir, { recursive: true });
  var parts = [], part = null, lastRatio = 0, t0 = Date.now(), lastLog = t0;
  var r = o.resume, skip = 0, earlier = 0;
  if (r) {
    parts = r.parts.map(function (p) { return Object.assign({ done: true }, p); });
    // From `at` the games before it are already behind; otherwise they are counted again.
    if (from) n.read = r.read; else skip = r.read;
    n.kept = r.kept;
    n.textOut = r.textOut;
    Object.assign(why, r.why);
    earlier = r.seconds || 0;
  }
  // The counts after the last chunk written: when a part closes, they are its end.
  var mark = { read: r ? r.read : 0, kept: n.kept, why: Object.assign({}, why), textOut: n.textOut,
    next: r ? r.next : null, at: r && r.at || null };

  async function flush(s, games) {
    if (!s) return;
    // A part closes before a chunk that might not fit: half again the last chunk's size.
    if (part && part.games && part.bytes + Math.max(lastRatio * s.length * 1.5, 1) > o.partBytes) {
      await part.close();
      var closed = part;
      part = null;
      if (o.onPart) await o.onPart(closed, checkpoint());
    }
    if (!part) {
      part = openPart(path.join(dir, base + '.' + (parts.length + 1) + '.pgn.zst'), o);
      parts.push(part);
    }
    var before = part.bytes;
    await part.write(s);
    part.games += games;
    lastRatio = (part.bytes - before) / s.length;
    n.textOut += s.length;
  }

  function checkpoint() {
    return {
      source: o.source || path.basename(o.input.replace(/[?#].*$/, '')),
      filter: { speeds: o.speeds, ratings: o.ratings },
      plies: o.plies,
      parts: parts.map(function (p) { return { file: path.basename(p.file), bytes: p.bytes, games: p.games, sha256: p.sha256 }; }),
      read: mark.read, kept: mark.kept, why: mark.why, textOut: mark.textOut, next: mark.next, at: mark.at,
      seconds: earlier + Math.round((Date.now() - t0) / 1000)
    };
  }

  var carry = '', carrySegs = [], buf = '', bufGames = 0, stopped = false, checked = !from, src = null;
  if (from) {
    n.bytesIn = from.offset;
    log('going on from game ' + fmt(r.read + 1) + ', ' + mb(from.offset) + ' into the dump');
  }
  try {
    src = openPieces(o.input, from, function (b) { n.bytesIn += b; }, o.curl);
    for await (var piece of src.pieces) {
      var segs = carrySegs.concat([{ pos: carry.length, offset: piece.offset, skip: piece.skip }]);
      var s = carry + piece.text, at = 0, next;
      if (!checked) {
        if (!samePrefix(gameStart(s, 0), r.next)) {
          throw Object.assign(new Error('it starts ' + JSON.stringify(gameStart(s, 0).slice(0, 80))), { atMiss: true });
        }
        checked = true;
      }
      while ((next = s.indexOf('\n[Event ', at + 1)) >= 0) {
        if (o.maxGames && n.read >= o.maxGames) { stopped = true; break; }
        if (n.read < skip) {
          // Filtered before the checkpoint: counted, nothing else.
          n.read++;
          at = next + 1;
          if (n.read === skip && !samePrefix(gameStart(s, at), r.next)) {
            throw Object.assign(new Error('The dump has changed since the checkpoint: game ' + (skip + 1) +
              ' starts ' + JSON.stringify(gameStart(s, at).slice(0, 80))), { resumeMismatch: true });
          }
          continue;
        }
        n.read++;
        var g = s.slice(at, next + 1);
        if (filter(g, why)) { n.kept++; buf += compactGame(g, o.plies); bufGames++; }
        at = next + 1;
        if (buf.length >= o.chunkBytes) {
          await flush(buf, bufGames);
          buf = ''; bufGames = 0;
          mark = { read: n.read, kept: n.kept, why: Object.assign({}, why), textOut: n.textOut, next: gameStart(s, at),
            at: locate(segs, at) };
        }
      }
      carry = stopped ? '' : s.slice(at);
      carrySegs = stopped ? [] : segsFrom(segs, at);
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        if (n.read < skip) log('counted ' + fmt(n.read) + ' of the ' + fmt(skip) + ' games filtered before (' + mb(n.bytesIn) + ')');
        else log('read ' + fmt(n.read) + ' games (' + mb(n.bytesIn) + (size ? ' of ' + mb(size) : '') +
          '), kept ' + fmt(n.kept) + ', written ' + mb(parts.reduce(function (a, p) { return a + p.bytes; }, 0)) +
          ', ' + fmt(Math.round(n.read / ((Date.now() - t0) / 1000))) + ' games/s');
      }
      if (stopped) break;
    }
    if (stopped) src.stop();
    else {
      if (!checked) throw Object.assign(new Error('nothing there'), { atMiss: true });
      if (n.read < skip) throw Object.assign(new Error('The dump ended at game ' + n.read + ', before the checkpoint at ' + skip), { resumeMismatch: true });
      if (carry.trim() && !(o.maxGames && n.read >= o.maxGames)) {
        n.read++;
        if (filter(carry, why)) { n.kept++; buf += compactGame(carry.replace(/\s*$/, '\n\n'), o.plies); bufGames++; }
      }
    }
    if (!n.read || n.read === why.broken) throw new Error('No games in ' + (o.source || o.input));
    if (!n.kept) throw new Error('None of the ' + n.read + ' games passed the filter');
    await flush(buf, bufGames);
    await part.close();
  } catch (e) {
    if (src) src.stop();
    if (!checked && e) e.atMiss = true;
    // Closed parts handed to onPart are the caller's (one may be on its way to a repository).
    parts.forEach(function (p) {
      if (p.done || (o.onPart && p !== part)) return;
      p.abort();
      fs.rmSync(p.file, { force: true });
    });
    throw e;
  }

  var manifest = {
    format: FILTERED_FORMAT,
    source: o.source || path.basename(o.input.replace(/[?#].*$/, '')),
    filter: { speeds: o.speeds, ratings: o.ratings },
    plies: o.plies,
    games: { read: n.read, kept: n.kept, skipped: why, complete: !o.maxGames || n.read < o.maxGames },
    bytes: { dump: n.bytesIn, text: n.textOut },
    zstd: { level: o.level, windowLog: o.windowLog },
    parts: parts.map(function (p) {
      return { file: path.basename(p.file), bytes: p.bytes, games: p.games, sha256: p.sha256 };
    }),
    created: new Date().toISOString(),
    seconds: earlier + Math.round((Date.now() - t0) / 1000)
  };
  if (r) manifest.resumed = r.parts.length;
  var big = manifest.parts.filter(function (p) { return p.bytes > o.partBytes; });
  if (big.length) log('warning: ' + big.map(function (p) { return p.file + ' ' + mb(p.bytes); }).join(', ') + ' over the part size');
  fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}
