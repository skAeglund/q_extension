/*
 * explorerdb relay: filtered months carried from a machine with a fast line (a cloud
 * session) to the home machine, through GitHub repositories used as a queue.
 *
 *   fill  (cloud): filters months straight from database.lichess.org and pushes each to a
 *                  repository with room. The manifest is pushed last: it says the month is
 *                  complete.
 *   drain (home):  pulls each repository, imports every complete month, keeps its files,
 *                  then removes the month from the repository ("consumed: <month>").
 *
 * A repository whose months have all been consumed is reset by fill before it is filled
 * again: a new root commit with the same README and LEDGER, force-pushed, so its history
 * stops carrying the old parts. LEDGER lists every month ever pushed there, one line each
 * ("2017-03 <games kept> <bytes>"), and is carried across resets: the ledgers of all the
 * repositories together say which months are done, so either side can stop and start again.
 *
 * Why this shape: GitHub refuses files over 100 MB and pushes over 2 GB, and warns about
 * repositories past a few GB, while a recent month filters to about 3 GB. Parts are pushed
 * in batches under `pushBytes`, and a repository takes months only up to `capBytes`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { filterDump } from './filter.mjs';
import { importDump } from './importer.mjs';

export var LEDGER = 'LEDGER';
var MONTH = /^(\d{4})-(\d{2})$/;
var MANIFEST = /^(\d{4})\/(\d{4}-\d{2})\.json$/;

export var RELAY_DEFAULTS = {
  capBytes: 3e9,
  pushBytes: 1.5e9,
  ratio: 0.13,              // filtered / dump: 0.090-0.124 for 2013-2016
  workers: 3,
  pollMs: 120000,
  tries: 5
};

export function dumpUrl(month) {
  return 'https://database.lichess.org/standard/lichess_db_standard_rated_' + month + '.pgn.zst';
}

// "2017-01..2017-12", "2017-03", or several of those joined by commas.
export function parseMonths(spec) {
  var out = [];
  String(spec || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (s) {
    var r = s.split('..');
    var a = MONTH.exec(r[0]), b = MONTH.exec(r[r.length - 1]);
    if (!a || !b || r.length > 2) throw new Error('Months are YYYY-MM or YYYY-MM..YYYY-MM, not ' + s);
    var y = Number(a[1]), m = Number(a[2]), ey = Number(b[1]), em = Number(b[2]);
    if (m < 1 || m > 12 || em < 1 || em > 12) throw new Error('No month ' + s);
    for (; y < ey || (y === ey && m <= em); m === 12 ? (y++, m = 1) : m++) {
      out.push(y + '-' + String(m).padStart(2, '0'));
    }
  });
  return Array.from(new Set(out)).sort();
}

export function parseLedger(text) {
  var out = {};
  String(text || '').split('\n').forEach(function (l) {
    var m = /^(\d{4}-\d{2})\b/.exec(l.trim());
    if (m) out[m[1]] = l.trim();
  });
  return out;
}

export function formatLedger(entries) {
  return Object.keys(entries).sort().map(function (m) { return entries[m]; }).join('\n') + '\n';
}

export function repoName(url) {
  return url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[\/:]/).pop();
}

/*
 * What to do with a repository, from what it holds now: `reset` when every month in it has
 * been consumed (its last commit is drain's, and nothing is left), `room` = bytes it may
 * still take. `reserved` is what months being filtered for it are expected to add.
 */
export function repoPlan(snap, capBytes, reserved) {
  var used = 0;
  Object.keys(snap.months).forEach(function (m) { used += snap.months[m].bytes; });
  var empty = !Object.keys(snap.months).length && !snap.loose.length;
  return {
    used: used,
    empty: empty,
    reset: empty && /^consumed: /.test(snap.subject),
    room: capBytes - used - (reserved || 0),
    idle: empty && !reserved
  };
}

// The repository to filter a month of `est` bytes for: the one with most room it fits in,
// or an idle one (a month bigger than the cap still goes somewhere). null: wait for drain.
export function pickRepo(plans, est) {
  var best = null;
  plans.forEach(function (p, i) {
    if (!(p.room >= est || p.idle)) return;
    if (best === null || p.room > plans[best].room) best = i;
  });
  return best;
}

export function git(args, cwd, o) {
  return new Promise(function (resolve, reject) {
    execFile('git', args, { cwd: cwd, maxBuffer: 1 << 26, env: (o && o.env) || process.env },
      function (e, stdout, stderr) {
        if (e) {
          var err = new Error('git ' + args.join(' ') + ' failed: ' + (stderr || e.message).trim());
          err.stderr = String(stderr || '');
          reject(err);
        } else resolve(String(stdout));
      });
  });
}

function rejected(e) {
  return /\[rejected\]|non-fast-forward|fetch first|stale info|failed to push/i.test(e.stderr || e.message);
}

/*
 * A clone of the repository's last commit holding only README, LEDGER and the manifests
 * (sparse, blobless): a few hundred kB however many parts it holds.
 */
export async function snapshot(url, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  await git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', url, dir]);
  await git(['sparse-checkout', 'set', '--no-cone', '/README.md', '/' + LEDGER, '/*/*.json'], dir);
  var files = (await git(['ls-tree', '-r', '--name-only', 'HEAD'], dir).catch(function () { return ''; }))
    .split('\n').filter(Boolean);
  var head = (await git(['log', '-1', '--format=%H%n%s'], dir).catch(function () { return '\n'; })).split('\n');
  var months = {}, loose = [];
  files.forEach(function (f) {
    var m = MANIFEST.exec(f);
    if (m && m[2].slice(0, 4) === m[1]) {
      var man = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      months[m[2]] = { bytes: man.parts.reduce(function (a, p) { return a + p.bytes; }, 0), manifest: man };
    }
  });
  files.forEach(function (f) {
    var m = /^(\d{4})\/(\d{4}-\d{2})\./.exec(f);
    if (m && !months[m[2]]) loose.push(f);      // parts of a month still being pushed
  });
  var ledgerFile = path.join(dir, LEDGER);
  return {
    dir: dir,
    sha: head[0] || null,
    subject: head[1] || '',
    files: files,
    months: months,
    loose: loose,
    ledger: parseLedger(fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '')
  };
}

// Every month a repository holds or has held: its LEDGER, and manifests from before LEDGER.
function doneIn(snap) {
  var d = Object.assign({}, snap.ledger);
  Object.keys(snap.months).forEach(function (m) {
    if (!d[m]) d[m] = ledgerLine(m, snap.months[m].manifest);
  });
  return d;
}

function ledgerLine(month, man) {
  return month + ' ' + man.games.kept + ' ' + man.parts.reduce(function (a, p) { return a + p.bytes; }, 0);
}

function stamp() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function mb(b) { return (b / 1e6).toFixed(1) + ' MB'; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/*
 * Pushes one filtered month (`files` in `srcDir`, manifest last) to a repository, resetting
 * it first when drain has emptied it. Starts over from a fresh snapshot when drain pushed
 * in between; parts already pushed then simply add nothing.
 */
export async function pushMonth(url, month, srcDir, work, o) {
  var year = month.slice(0, 4);
  var man = JSON.parse(fs.readFileSync(path.join(srcDir, month + '.json'), 'utf8'));
  var footer = o.footer ? '\n\n' + o.footer : '';
  for (var attempt = 1; ; attempt++) {
    var snap = await snapshot(url, path.join(work, 'push-' + repoName(url)));
    var dir = snap.dir;
    try {
      var ledger = doneIn(snap);
      var lease = null;
      if (repoPlan(snap, 0, 0).reset) {
        await git(['checkout', '-q', '--orphan', 'fresh'], dir);
        await git(['commit', '-q', '--allow-empty', '-m', 'reset: every month here has been consumed' + footer], dir);
        lease = snap.sha;
      }
      fs.mkdirSync(path.join(dir, year), { recursive: true });
      var batch = [], batchBytes = 0;
      var flushParts = async function () {
        if (!batch.length) return;
        await git(['add', '--sparse'].concat(batch), dir);
        if (await git(['diff', '--cached', '--quiet'], dir).then(function () { return false; }, function () { return true; })) {
          await git(['commit', '-q', '-m', month + ': parts ' + batch.map(function (f) {
            return f.split('.').slice(-3)[0];
          }).join(', ') + footer], dir);
          await pushHead(dir, lease);
          lease = null;
        }
        batch = []; batchBytes = 0;
      };
      for (var i = 0; i < man.parts.length; i++) {
        var p = man.parts[i];
        if (batchBytes + p.bytes > o.pushBytes) await flushParts();
        fs.copyFileSync(path.join(srcDir, p.file), path.join(dir, year, p.file));
        batch.push(year + '/' + p.file);
        batchBytes += p.bytes;
      }
      await flushParts();
      fs.copyFileSync(path.join(srcDir, month + '.json'), path.join(dir, year, month + '.json'));
      ledger[month] = ledgerLine(month, man);
      fs.writeFileSync(path.join(dir, LEDGER), formatLedger(ledger));
      await git(['add', '--sparse', year + '/' + month + '.json', LEDGER], dir);
      await git(['commit', '-q', '-m', month + ': ' + man.games.kept + ' of ' + man.games.read + ' games, ' +
        mb(man.parts.reduce(function (a, q) { return a + q.bytes; }, 0)) + footer], dir);
      await pushHead(dir, lease);
      return;
    } catch (e) {
      if (!rejected(e) || attempt >= o.tries) throw e;
      o.log('push of ' + month + ' to ' + repoName(url) + ' was overtaken; trying again');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function writeLedger(url, work, o) {
  for (var attempt = 1; ; attempt++) {
    var snap = await snapshot(url, path.join(work, 'ledger-' + repoName(url)));
    try {
      fs.writeFileSync(path.join(snap.dir, LEDGER), formatLedger(doneIn(snap)));
      await git(['add', '--sparse', LEDGER], snap.dir);
      await git(['commit', '-q', '-m', 'LEDGER: the months pushed here so far' + (o.footer ? '\n\n' + o.footer : '')], snap.dir);
      await pushHead(snap.dir, null);
      return;
    } catch (e) {
      if (!rejected(e) || attempt >= o.tries) throw e;
    } finally {
      fs.rmSync(snap.dir, { recursive: true, force: true });
    }
  }
}

function pushHead(dir, lease) {
  return git(['push', '-q'].concat(lease ? ['--force-with-lease=main:' + lease] : [], ['origin', 'HEAD:main']), dir);
}

/*
 * o: { repos: [url], months: [YYYY-MM], work, capBytes, pushBytes, ratio, workers, pollMs,
 *      footer (appended to commit messages), log,
 *      dumpSize(month) -> bytes or 0 (not published), filterMonth(month, outBase) -> manifest }
 * Resolves with { pushed, skipped (not published), failed } once no month is left to try.
 */
export async function fill(o) {
  o = Object.assign({}, RELAY_DEFAULTS, o);
  var log = o.log = o.log || function () {};
  var work = o.work || path.join(os.tmpdir(), 'explorerdb-relay');
  fs.mkdirSync(work, { recursive: true });
  var reserved = o.repos.map(function () { return 0; });
  var locks = o.repos.map(function () { return Promise.resolve(); });

  var looks = 0;
  async function look() {
    var snaps = [], n = ++looks;       // workers look at once: each in its own directory
    for (var i = 0; i < o.repos.length; i++) {
      snaps.push(await snapshot(o.repos[i], path.join(work, 'look-' + n + '-' + i)));
      fs.rmSync(snaps[i].dir, { recursive: true, force: true });
    }
    return snaps;
  }

  var snaps = await look();
  // A repository filled before LEDGER existed gets one before drain empties it.
  for (var i = 0; i < snaps.length; i++) {
    var have = doneIn(snaps[i]);
    if (Object.keys(have).some(function (m) { return !snaps[i].ledger[m]; })) {
      await writeLedger(o.repos[i], work, o);
      log(stamp() + ' ' + repoName(o.repos[i]) + ': LEDGER written (' + Object.keys(have).length + ' months)');
    }
  }
  var done = {};
  snaps.forEach(function (s) { Object.assign(done, doneIn(s)); });
  var queue = o.months.filter(function (m) { return !done[m]; });
  log(stamp() + ' ' + (o.months.length - queue.length) + ' of ' + o.months.length + ' months already done; ' +
    queue.length + ' to go');
  var failed = [], skipped = [];

  async function one(month) {
    var size = await o.dumpSize(month);
    if (!size) { log(stamp() + ' ' + month + ': no dump published, skipped'); skipped.push(month); return; }
    var est = size * o.ratio, target;
    for (;;) {
      var plans = (await look()).map(function (s, i) { return repoPlan(s, o.capBytes, reserved[i]); });
      target = pickRepo(plans, est);
      if (target !== null) break;
      await sleep(o.pollMs);
    }
    reserved[target] += est;
    var url = o.repos[target];
    var out = path.join(work, 'filter-' + month);
    try {
      log(stamp() + ' ' + month + ': filtering (' + mb(size) + ') for ' + repoName(url));
      var man = await o.filterMonth(month, path.join(out, month));
      var got = man.parts.reduce(function (a, p) { return a + p.bytes; }, 0);
      var run = locks[target].then(function () { return pushMonth(url, month, out, work, o); });
      locks[target] = run.catch(function () {});
      await run;
      log(stamp() + ' ' + month + ': pushed to ' + repoName(url) + ', ' + mb(got) + ' (' +
        (size / got).toFixed(1) + 'x smaller), ' + man.games.kept + ' games');
    } finally {
      reserved[target] -= est;
      fs.rmSync(out, { recursive: true, force: true });
    }
  }

  var next = 0;
  await Promise.all(Array.from({ length: Math.min(o.workers, queue.length) }, async function () {
    while (next < queue.length) {
      var m = queue[next++];
      for (var t = 1; ; t++) {
        try { await one(m); break; } catch (e) {
          log(stamp() + ' ' + m + ': ' + (e && e.message || e) + (t < 3 ? '; trying again' : '; giving up'));
          if (t >= 3) { failed.push(m); break; }
          await sleep(Math.min(o.pollMs, 30000));
        }
      }
    }
  }));
  return { pushed: queue.length - failed.length - skipped.length, skipped: skipped, failed: failed };
}

function sha256(file) {
  var h = crypto.createHash('sha256');
  var fd = fs.openSync(file, 'r'), buf = Buffer.allocUnsafe(1 << 22), n;
  try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// The repository's last commit, whatever happened to its history (fill force-pushes resets).
async function update(url, dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    await git(['clone', '-q', '--depth', '1', url, dir]);
    return;
  }
  try {
    await git(['fetch', '-q', '--depth', '1', 'origin', 'main'], dir);
  } catch (e) {
    // A clone cut off (2026-10-01: a stale shallow.lock, HEAD at refs/heads/.invalid) fails
    // every fetch for good: clone it again. A clone with a commit failed for another reason.
    var whole = await git(['rev-parse', '--verify', '-q', 'HEAD'], dir).then(function () { return true; }, function () { return false; });
    if (whole) throw e;
    fs.rmSync(dir, { recursive: true, force: true });
    await git(['clone', '-q', '--depth', '1', url, dir]);
    return;
  }
  await git(['reset', '-q', '--hard', 'FETCH_HEAD'], dir);
  await git(['clean', '-qfd'], dir);
}

/*
 * o: { repos: [url], dir (clones), keep (where a month's files are kept, or null), out
 *      (where indexes go: <out>/<month>.xdb), importOptions, pollMs, until (months: stop once
 *      all of them are imported), once (one pass), footer, log, importMonth(manifest, index) }
 */
export async function drain(o) {
  o = Object.assign({ pollMs: 300000, tries: 5 }, o);
  if (o.noImport && !o.keep) throw new Error('Not importing and not keeping would lose the months');
  var log = o.log || function () {};
  var footer = o.footer ? '\n\n' + o.footer : '';
  var importMonth = o.importMonth || function (input, out) {
    return importDump(Object.assign({}, o.importOptions, { input: input, out: out }));
  };
  fs.mkdirSync(o.dir, { recursive: true });
  fs.mkdirSync(o.out, { recursive: true });
  var imported = [];
  for (;;) {
    var worked = false;
    for (var r = 0; r < o.repos.length; r++) {
      var url = o.repos[r], dir = path.join(o.dir, repoName(url));
      try {
        await update(url, dir);
      } catch (e) {
        log(stamp() + ' ' + repoName(url) + ': ' + e.message);
        continue;
      }
      var months = (await git(['ls-files'], dir)).split('\n').map(function (f) {
        var m = MANIFEST.exec(f);
        return m && m[2].slice(0, 4) === m[1] ? m[2] : null;
      }).filter(Boolean).sort();
      for (var i = 0; i < months.length; i++) {
        var month = months[i], year = month.slice(0, 4);
        var index = path.join(o.out, month + '.xdb');
        try {
          await drainMonth();
        } catch (e) {
          // Left in the repository, to be tried again on the next pass.
          log(stamp() + ' ' + month + ': ' + (e && e.message || e));
          fs.rmSync(index + '.partial', { force: true });
          fs.rmSync(index + '.partial.tmp', { recursive: true, force: true });
        }
      }
      if (months.length) {
        await git(['reflog', 'expire', '--expire=now', '--all'], dir).catch(function () {});
        await git(['gc', '-q', '--prune=now'], dir).catch(function () {});
      }
      if (o.until && o.until.every(have)) {
        return imported;
      }
    }
    if (o.once) return imported;
    if (!worked) await sleep(o.pollMs);
  }

  // Whether a month is done here: its index, or with noImport its kept manifest.
  function have(m) {
    return o.noImport ? fs.existsSync(path.join(o.keep, m.slice(0, 4), m + '.json')) : fs.existsSync(path.join(o.out, m + '.xdb'));
  }

  async function drainMonth() {
    // With noImport the files are checked and kept again after a crash: cheap, and the copy
    // is then known whole.
    if (o.noImport || !fs.existsSync(index)) {
      var man = JSON.parse(fs.readFileSync(path.join(dir, year, month + '.json'), 'utf8'));
      man.parts.forEach(function (p) {
        if (sha256(path.join(dir, year, p.file)) !== p.sha256) throw new Error(p.file + ' does not match its sha256');
      });
      var input = path.join(dir, year, month + '.json');
      if (o.keep) {
        var kd = path.join(o.keep, year);
        fs.mkdirSync(kd, { recursive: true });
        man.parts.forEach(function (p) { fs.copyFileSync(path.join(dir, year, p.file), path.join(kd, p.file)); });
        // The manifest last, and whole: `all` takes a month once its manifest is there.
        fs.copyFileSync(input, path.join(kd, month + '.json.tmp'));
        fs.renameSync(path.join(kd, month + '.json.tmp'), path.join(kd, month + '.json'));
        input = path.join(kd, month + '.json');
      }
      if (o.noImport) {
        // `all` adds the kept files to its accumulator: an index per month would only
        // compete with it for the cores.
        log(stamp() + ' ' + month + ': kept ' + man.games.kept + ' games from ' + repoName(url) + ' in ' + path.dirname(input));
      } else {
        log(stamp() + ' ' + month + ': importing ' + man.games.kept + ' games from ' + repoName(url));
        var t0 = Date.now();
        await importMonth(input, index + '.partial');
        fs.renameSync(index + '.partial', index);
        log(stamp() + ' ' + month + ': imported in ' + Math.round((Date.now() - t0) / 1000) + ' s -> ' + index);
      }
      imported.push(month);
    }
    await consume(url, dir, month, footer, o.tries);
    log(stamp() + ' ' + month + ': removed from ' + repoName(url));
    worked = true;
  }
}

async function consume(url, dir, month, footer, tries) {
  var year = month.slice(0, 4);
  for (var t = 1; ; t++) {
    var mine = (await git(['ls-files', year], dir)).split('\n').filter(function (f) {
      return f.indexOf(year + '/' + month + '.') === 0;
    });
    if (!mine.length) return;               // fill reset the repository meanwhile
    await git(['rm', '-q'].concat(mine), dir);
    await git(['commit', '-q', '-m', 'consumed: ' + month + footer], dir);
    try {
      await git(['push', '-q', 'origin', 'HEAD:main'], dir);
      return;
    } catch (e) {
      if (!rejected(e) || t >= tries) throw e;
      await update(url, dir);
    }
  }
}

export function lichessDumpSize(month) {
  return new Promise(function (resolve) {
    execFile('curl', ['-sSIL', dumpUrl(month)], function (e, out) {
      if (e) return resolve(0);
      var status = 0, len = 0;
      String(out).split('\n').forEach(function (l) {
        var s = /^HTTP\/[\d.]+ (\d+)/.exec(l);
        if (s) status = Number(s[1]);
        var c = /^content-length:\s*(\d+)/i.exec(l);
        if (c) len = Number(c[1]);
      });
      resolve(status === 200 ? len : 0);
    });
  });
}

export function lichessFilter(o) {
  return function (month, outBase) {
    return filterDump(Object.assign({}, o, { input: dumpUrl(month), out: outBase,
      source: path.basename(dumpUrl(month)) }));
  };
}
