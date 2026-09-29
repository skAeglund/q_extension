/*
 * explorerdb worker thread. Two jobs:
 *   replay:    { games: [{ moves, result }] } -> spills records to this worker's shard files
 *   aggregate: { shard, files, minGames, out } -> counts one shard (store.mjs)
 * and `finish` flushes what the replay still holds.
 *
 * The first `combinePlies` plies are counted in memory before they are spilled: every
 * game passes through them, so there are few distinct ones and without this the start
 * position alone would be 25 million records in one shard. The key is the game's moves so
 * far, a string, which a Map handles several times faster than a BigInt hash.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createReplayer, movetextSans } from './games.mjs';
import { aggregateShard, createSpill } from './store.mjs';

var o = workerData;
var replay = createReplayer();
var spill = null;
var early = new Map();       // "e4 c5 Nf3|<move>" -> [hash, code, w, d, b]
var EARLY_MAX = 400000;

function flushEarly() {
  early.forEach(function (e) { spill.put(e[0], e[1], e[2], e[3], e[4]); });
  early.clear();
}

function count(path, hash, code, result) {
  var e = early.get(path);
  if (!e) { e = [hash, code, 0, 0, 0]; early.set(path, e); }
  e[2 + result]++;
}

function replayGames(games) {
  var bad = 0, plies = 0;
  for (var g = 0; g < games.length; g++) {
    var sans = movetextSans(games[g].moves, o.plies);
    var walk = replay(sans);
    if (!walk) { bad++; continue; }
    var r = games[g].result;
    var w = r === 0 ? 1 : 0, d = r === 1 ? 1 : 0, b = r === 2 ? 1 : 0;
    var path = '';
    for (var i = 0; i <= sans.length; i++) {
      var code = i < sans.length ? walk.codes[i] : 0;
      if (i < o.combinePlies) {
        count(path + '|' + code, walk.hashes[i], code, r);
        if (i < sans.length) path += ' ' + sans[i];
      } else {
        spill.put(walk.hashes[i], code, w, d, b);
      }
    }
    plies += sans.length;
  }
  if (early.size > EARLY_MAX) flushEarly();
  return { games: games.length - bad, bad: bad, plies: plies };
}

parentPort.on('message', function (msg) {
  try {
    if (msg.type === 'replay') {
      if (!spill) spill = createSpill(o.dir, o.id);
      parentPort.postMessage({ type: 'replayed', result: replayGames(msg.games) });
    } else if (msg.type === 'finish') {
      if (spill) { flushEarly(); spill.flush(); }
      parentPort.postMessage({ type: 'finished', records: spill ? spill.records() : 0 });
    } else if (msg.type === 'aggregate') {
      var stats = aggregateShard(msg.files, msg.minGames, msg.out);
      parentPort.postMessage({ type: 'aggregated', shard: msg.shard, stats: stats });
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e && e.stack || String(e) });
  }
});
