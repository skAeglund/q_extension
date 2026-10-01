/*
 * explorerdb accumulator: counts from many dumps, kept down to single games, and pruned
 * only when the disk makes it.
 *
 * Why not merge month indexes: each would drop the positions under its own threshold
 * first, and a position with 15 games in the whole archive has at most one or two in any
 * month. Here every dump is added with all of its positions (N >= 1), so counts add up
 * across months before anything is dropped. The whole archive at N >= 1 would be some
 * 2 TB, though, so when the disk budget is reached the accumulator is pruned at the lowest
 * threshold that fits (usually 2: single games). A position loses at most (t - 1) games
 * at each prune at t, and only if it hadn't reached t by then; the prunes are recorded and
 * the finished index reports that bound (`maxUndercount`).
 *
 * The directory:
 *   state.json    filter, ply limit, and the ops applied: { type: 'dump', source, report }
 *                 or { type: 'prune', minGames }; `pending` is the op being applied
 *   aNNN.gK.bin   shard NNN (the hash's top byte, as the import's shards) after K ops:
 *                 "QXXACC01", u32 length, a JSON header padded with spaces ({ gen, stats }),
 *                 then index records (store.mjs) sorted by hash, then move
 *   lock          the pid of the process using it
 *   import.tmp/   the import's spill files
 *
 * Crashes: an op writes each shard's next generation next to the old one (.part, then
 * renamed) and removes the old one after, so every shard is always whole at generation K
 * or K + 1. Applying the pending op again skips the shards already at K + 1: for a dump,
 * importing it again adds it to just the others.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SHARDS, REC, THRESHOLDS, FORMAT, writeHeader, rewriteHeader, HEADER_PAD } from './store.mjs';
import { HASH_NAME } from './games.mjs';
import { openRecords, recordWriter, mergeRecords, emptyStats, addStats } from './merge.mjs';

var MAGIC = 'QXXACC01';
var SHARD_HEAD = 4096;
var KIND = 'explorerdb-accumulator';

function shardName(s, gen) { return 'a' + String(s).padStart(3, '0') + '.g' + gen + '.bin'; }

function readShardHead(file) {
  var fd = fs.openSync(file, 'r');
  try {
    var head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 8) !== MAGIC) throw new Error(file + ' is not an accumulator shard');
    var len = head.readUInt32LE(8), json = Buffer.alloc(len);
    fs.readSync(fd, json, 0, len, 12);
    var h = JSON.parse(json.toString('utf8'));
    h.start = 12 + len;
    h.bytes = fs.fstatSync(fd).size - h.start;
    return h;
  } finally {
    fs.closeSync(fd);
  }
}

/*
 * One shard's next generation: `m.base` (a shard file, or null for none yet) summed with
 * the raw record files in `extra`, keeping positions reached by `minGames`, written to
 * m.out (via .part, then renamed); the base is removed after. Returns { stats, bytes }.
 * Run in the import's workers for a dump, in the main thread for a prune.
 */
export function mergeAccShard(m, extra, minGames) {
  var part = m.out + '.part';
  var inputs = [];
  if (m.base) inputs.push(openRecords(m.base, readShardHead(m.base).start));
  extra.forEach(function (f) { inputs.push(openRecords(f, 0)); });
  var fd = fs.openSync(part, 'w+'), st;   // w+: the header is read back to be rewritten
  try {
    writeHeader(fd, { gen: m.gen }, SHARD_HEAD - 12);
    var wr = recordWriter(fd);
    st = mergeRecords(inputs, minGames, wr.put);
    wr.flush();
    st.bytes = wr.bytes();
    // The header describes what the shard now holds, not what went in.
    rewriteShardHead(fd, { gen: m.gen, stats: st.out });
  } finally {
    fs.closeSync(fd);
    inputs.forEach(function (r) { r.close(); });
  }
  fs.renameSync(part, m.out);
  if (m.base) fs.rmSync(m.base, { force: true });
  return st;
}

// writeHeader writes store.mjs's index magic; a shard has its own.
function rewriteShardHead(fd, h) {
  rewriteHeader(fd, h);
  var magic = Buffer.from(MAGIC, 'latin1');
  fs.writeSync(fd, magic, 0, 8, 0);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/*
 * Opens (or with `create`, makes) the accumulator in `dir`. create: { filter, plies }.
 * Takes the lock unless `readOnly`.
 */
export function openAcc(dir, o) {
  o = o || {};
  var stateFile = path.join(dir, 'state.json');
  var state;
  if (!fs.existsSync(stateFile)) {
    if (!o.create) throw new Error('No accumulator at ' + dir);
    fs.mkdirSync(dir, { recursive: true });
    state = { kind: KIND, format: FORMAT, hash: HASH_NAME, filter: o.create.filter,
      plies: o.create.plies, created: new Date().toISOString(), ops: [], pending: null };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  }
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.kind !== KIND) throw new Error(dir + ' is not an explorerdb accumulator');
  if (state.format !== FORMAT || state.hash !== HASH_NAME) {
    throw new Error(dir + ' holds format ' + state.format + ' (' + state.hash + '); this needs ' +
      FORMAT + ' (' + HASH_NAME + ')');
  }

  var lockFile = path.join(dir, 'lock'), locked = false;
  if (!o.readOnly) {
    if (fs.existsSync(lockFile)) {
      var pid = Number(fs.readFileSync(lockFile, 'utf8'));
      if (pid && pid !== process.pid && pidAlive(pid)) {
        throw new Error(dir + ' is in use by process ' + pid + ' (stop it, or wait for it to finish)');
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    locked = true;
  }

  // Each shard's generation, tidying what a crash left: .part files, and an old
  // generation beside its successor.
  var gens = new Array(SHARDS).fill(0);
  function scan() {
    var found = new Array(SHARDS).fill(null).map(function () { return []; });
    fs.readdirSync(dir).forEach(function (f) {
      if (/\.part$/.test(f)) { if (!o.readOnly) fs.rmSync(path.join(dir, f), { force: true }); return; }
      var m = /^a(\d{3})\.g(\d+)\.bin$/.exec(f);
      if (m) found[Number(m[1])].push(Number(m[2]));
    });
    found.forEach(function (list, s) {
      list.sort(function (a, b) { return a - b; });
      gens[s] = list.length ? list[list.length - 1] : 0;
      if (!o.readOnly) list.slice(0, -1).forEach(function (g) { fs.rmSync(path.join(dir, shardName(s, g)), { force: true }); });
    });
  }
  scan();

  function save() {
    fs.writeFileSync(stateFile + '.part', JSON.stringify(state, null, 1));
    fs.renameSync(stateFile + '.part', stateFile);
  }
  function file(s, gen) { return path.join(dir, shardName(s, gen)); }
  function gen() { return state.ops.length; }

  function shardHeads() {
    var out = [];
    for (var s = 0; s < SHARDS; s++) out.push(gens[s] ? readShardHead(file(s, gens[s])) : null);
    return out;
  }

  var acc = {
    dir: dir,
    state: state,
    gens: gens,
    file: file,
    gen: gen,
    save: save,
    shardHeads: shardHeads,

    // Bytes of records held, and their stats: at each of THRESHOLDS, over all shards.
    totals: function () {
      var st = emptyStats(), bytes = 0;
      shardHeads().forEach(function (h) {
        if (!h) return;
        bytes += h.bytes;
        if (h.stats) addStats(st, h.stats);
      });
      st.bytes = bytes;
      return st;
    },

    // Starts an op, or picks up the pending one if it's the same.
    begin: function (op) {
      if (state.pending) {
        var p = state.pending;
        if (p.type !== op.type || p.source !== op.source || p.minGames !== op.minGames) {
          throw new Error('Unfinished: ' + describe(p) + '. Run that again first.');
        }
        return p;
      }
      op.gen = gen() + 1;
      op.started = new Date().toISOString();
      state.pending = op;
      save();
      return op;
    },

    commit: function (op, extra) {
      for (var s = 0; s < SHARDS; s++) {
        if (gens[s] !== op.gen) throw new Error('Shard ' + s + ' is at ' + gens[s] + ', not ' + op.gen);
      }
      Object.assign(op, extra || {}, { finished: new Date().toISOString() });
      state.ops.push(op);
      state.pending = null;
      save();
    },

    close: function () {
      if (locked) { try { fs.rmSync(lockFile, { force: true }); } catch (e) { /* gone already */ } }
      locked = false;
    }
  };
  return acc;
}

function describe(op) {
  return op.type === 'dump' ? 'adding ' + op.source : 'pruning at ' + op.minGames;
}

export function hasDump(acc, source) {
  return acc.state.ops.some(function (op) { return op.type === 'dump' && op.source === source; });
}

/*
 * Adds one dump, or a filtered month's manifest. `importDump` is importer.mjs's (passed
 * in, so this module stays out of the worker's import graph). o.source names it in the
 * ops (default: the file's name; all.mjs passes the dump's name for a filtered month, so
 * a month counts as added whichever way it came), o.size and o.filtered are recorded.
 * Resolves with the op.
 */
export async function addDump(acc, input, importDump, o) {
  o = o || {};
  var source = o.source || path.basename(input);
  if (hasDump(acc, source)) throw new Error(source + ' is in ' + acc.dir + ' already');
  var before = acc.totals().bytes;
  var op = acc.begin({ type: 'dump', source: source });
  var g = op.gen;
  var meta = await importDump({
    input: input,
    speeds: acc.state.filter.speeds,
    ratings: acc.state.filter.ratings,
    plies: acc.state.plies,
    minGames: 1,
    workers: o.workers,
    maxGames: o.maxGames,
    tmp: path.join(acc.dir, 'import.tmp'),
    log: o.log,
    intoShard: function (s) {
      if (acc.gens[s] >= g) return null;
      return { base: acc.gens[s] ? acc.file(s, acc.gens[s]) : null, out: acc.file(s, g), gen: g };
    },
    shardMerged: function (s) { acc.gens[s] = g; }
  });
  var after = acc.totals();
  var r = meta.report;
  acc.commit(op, { report: { games: r.games, spilled: r.spilled, seconds: r.seconds, partial: !!r.partial },
    size: o.size || fs.statSync(input).size, filtered: !!o.filtered || undefined,
    bytesBefore: before, bytesAfter: after.bytes });
  return op;
}

// Drops the positions reached by fewer than `minGames` games so far.
export function prune(acc, minGames, log) {
  var before = acc.totals();
  var op = acc.begin({ type: 'prune', minGames: minGames });
  var g = op.gen, t0 = Date.now(), dropped = emptyStats();
  for (var s = 0; s < SHARDS; s++) {
    if (acc.gens[s] >= g) continue;
    addStats(dropped, mergeAccShard({ base: acc.gens[s] ? acc.file(s, acc.gens[s]) : null, out: acc.file(s, g), gen: g }, [], minGames));
    acc.gens[s] = g;
    if (log && s % 64 === 63) log('pruning at ' + minGames + ': ' + (s + 1) + ' of ' + SHARDS + ' shards');
  }
  var after = acc.totals();
  acc.commit(op, { bytesBefore: before.bytes, bytesAfter: after.bytes,
    positionsBefore: before.positions[0], positionsAfter: after.positions[0],
    // Position visits dropped: a game counts once at each position of it that went.
    droppedGames: dropped.droppedGames,
    seconds: Math.round((Date.now() - t0) / 1000) });
  return op;
}

/*
 * The lowest threshold (of THRESHOLDS, at least 2) whose positions fit in `bytes`, from
 * the stats totals() gives; the highest one if none does.
 */
export function pruneFor(st, bytes) {
  for (var i = 0; i < THRESHOLDS.length; i++) {
    if (THRESHOLDS[i] >= 2 && st.records[i] * REC <= bytes) return THRESHOLDS[i];
  }
  return THRESHOLDS[THRESHOLDS.length - 1];
}

// What the accumulator holds, for info and for a written index's header.
export function summary(acc) {
  var games = { read: 0, kept: 0, replayed: 0, illegal: 0, plies: 0,
    skipped: { broken: 0, variant: 0, speed: 0, rating: 0, result: 0 } };
  var spilled = 0, seconds = 0, dumps = [], prunes = [], droppedGames = 0;
  acc.state.ops.forEach(function (op) {
    if (op.type === 'prune') { prunes.push(op.minGames); droppedGames += op.droppedGames || 0; return; }
    dumps.push(op.source);
    var g = op.report.games;
    ['read', 'kept', 'replayed', 'illegal', 'plies'].forEach(function (k) { games[k] += g[k] || 0; });
    Object.keys(games.skipped).forEach(function (k) { games.skipped[k] += (g.skipped && g.skipped[k]) || 0; });
    spilled += op.report.spilled || 0;
    seconds += op.report.seconds || 0;
  });
  return {
    games: games, spilled: spilled, seconds: seconds, dumps: dumps, prunes: prunes,
    droppedGames: droppedGames,
    // A position kept loses at most t - 1 games at each prune at t.
    maxUndercount: prunes.reduce(function (n, t) { return n + t - 1; }, 0)
  };
}

function dumpRange(dumps) {
  var months = dumps.map(function (d) { var m = /(\d{4}-\d{2})/.exec(d); return m ? m[1] : d; }).sort();
  return months.length ? months[0] + (months.length > 1 ? '..' + months[months.length - 1] : '') : 'nothing';
}

/*
 * Writes an index (store.mjs's format, for query and serve) of the positions reached by at
 * least `minGames` games. The accumulator is only read. Resolves with its header.
 */
export function writeIndex(acc, out, minGames, log) {
  var sum = summary(acc);
  if (!sum.dumps.length) throw new Error(acc.dir + ' holds no dumps yet');
  if (acc.state.pending) throw new Error('Unfinished: ' + describe(acc.state.pending) + '. Finish that first.');
  var t0 = Date.now();
  var meta = {
    format: FORMAT, hash: HASH_NAME,
    source: sum.dumps.length + ' dumps, ' + dumpRange(sum.dumps),
    filter: acc.state.filter, plies: acc.state.plies, minGames: minGames,
    created: new Date().toISOString(),
    report: null
  };
  var part = out + '.part';
  var fd = fs.openSync(part, 'w+'), st = emptyStats();
  try {
    writeHeader(fd, meta, HEADER_PAD);
    var wr = recordWriter(fd);
    for (var s = 0; s < SHARDS; s++) {
      if (!acc.gens[s]) continue;
      var f = acc.file(s, acc.gens[s]);
      var r = openRecords(f, readShardHead(f).start);
      try { addStats(st, mergeRecords([r], minGames, wr.put)); } finally { r.close(); }
      if (log && s % 64 === 63) log('writing ' + path.basename(out) + ': ' + (s + 1) + ' of ' + SHARDS + ' shards');
    }
    wr.flush();
    meta.report = {
      games: sum.games, spilled: sum.spilled,
      thresholds: THRESHOLDS.map(function (t, i) {
        return { minGames: t, positions: st.positions[i], records: st.records[i], bytes: st.records[i] * REC };
      }),
      positions: st.kept, records: st.keptRecords,
      seconds: sum.seconds + Math.round((Date.now() - t0) / 1000),
      dumps: sum.dumps, prunes: sum.prunes, maxUndercount: sum.maxUndercount,
      droppedGames: sum.droppedGames
    };
    rewriteHeader(fd, meta);
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(out, { force: true });
  fs.renameSync(part, out);
  return meta;
}
