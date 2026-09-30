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
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { makeFilter, header, movetextSans, FILTERED_FORMAT } from './games.mjs';
import { openText, DEFAULTS } from './importer.mjs';

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

/*
 * o: { input (a dump, an https URL of one, or '-' for a .zst on stdin), size (a URL's), out (path without extension), source,
 *      speeds, ratings, plies, partBytes, chunkBytes, level, windowLog, maxGames, log }
 * Resolves with the manifest written to <out>.json.
 */
export async function filterDump(o) {
  o = Object.assign({}, FILTER_DEFAULTS, o);
  var log = o.log || function () {};
  var filter = makeFilter(o);
  var why = { broken: 0, variant: 0, speed: 0, rating: 0, result: 0 };
  var n = { read: 0, kept: 0, bytesIn: 0, textOut: 0 };
  var url = /^https?:\/\//i.test(o.input);
  var size = o.input === '-' || url ? o.size || 0 : fs.statSync(o.input).size;
  var base = path.basename(o.out);
  var dir = path.dirname(o.out);
  fs.mkdirSync(dir, { recursive: true });
  var parts = [], part = null, lastRatio = 0, t0 = Date.now(), lastLog = t0;

  async function flush(s, games) {
    if (!s) return;
    // A part closes before a chunk that might not fit: half again the last chunk's size.
    if (part && part.games && part.bytes + Math.max(lastRatio * s.length * 1.5, 1) > o.partBytes) {
      await part.close();
      part = null;
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

  var src = openText(o.input, function (b) { n.bytesIn += b; });
  var text = src.stream;
  text.setEncoding('latin1');
  var carry = '', buf = '', bufGames = 0, stopped = false;
  try {
    for await (var chunk of text) {
      var s = carry + chunk, at = 0, next;
      while ((next = s.indexOf('\n[Event ', at + 1)) >= 0) {
        if (o.maxGames && n.read >= o.maxGames) { stopped = true; break; }
        n.read++;
        var g = s.slice(at, next + 1);
        if (filter(g, why)) { n.kept++; buf += compactGame(g, o.plies); bufGames++; }
        at = next + 1;
        if (buf.length >= o.chunkBytes) { await flush(buf, bufGames); buf = ''; bufGames = 0; }
      }
      carry = stopped ? '' : s.slice(at);
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        log('read ' + fmt(n.read) + ' games (' + mb(n.bytesIn) + (size ? ' of ' + mb(size) : '') +
          '), kept ' + fmt(n.kept) + ', written ' + mb(parts.reduce(function (a, p) { return a + p.bytes; }, 0)) +
          ', ' + fmt(Math.round(n.read / ((Date.now() - t0) / 1000))) + ' games/s');
      }
      if (stopped) break;
    }
    if (stopped) { src.raw.destroy(); src.stop(); }
    else {
      await src.finished;
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
    parts.forEach(function (p) { p.abort(); fs.rmSync(p.file, { force: true }); });
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
    seconds: Math.round((Date.now() - t0) / 1000)
  };
  var big = manifest.parts.filter(function (p) { return p.bytes > o.partBytes; });
  if (big.length) log('warning: ' + big.map(function (p) { return p.file + ' ' + mb(p.bytes); }).join(', ') + ' over the part size');
  fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}
