/*
 * cdbexplore (tools/cdbexplore.mjs): picking the positions of a PGN worth exploring, and
 * the search over a fake ChessDB (repgen/explore.mjs). No network.
 * Called from test/harness.js.
 */

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert');

const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

module.exports = async function run(check) {
  const T = await load('tools/repgen/pgntree.mjs');
  const X = await load('tools/repgen/explore.mjs');
  const { Chess } = await load('src/vendor/chess.js');
  const { fenKey } = await load('src/pe/search.js');

  const play = (fen, ...ucis) => {
    const c = new Chess(fen);
    ucis.forEach(u => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }));
    return c.fen();
  };
  const k = (...ucis) => fenKey(play(START, ...ucis));

  /* --- picking -------------------------------------------------------- */

  const [g] = T.parsePgn(`[White "Repertoire"]
[Black "Lichess"]

1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 3. Bb5 *`);
  const list = X.positions(g, 'w', null);
  const at = sans => list.find(p => p.path.join(' ') === sans);
  const cq = moves => ({ status: 'ok', moves: moves.map(([san, score]) => ({ san, score })) });
  const answers = new Map([
    [at('').key, cq([['e4', 30], ['d4', 25]])],                 // close: a decision
    [at('e4').key, cq([['e5', -30], ['c5', -35]])],             // theirs, not a line end
    [at('e4 e5').key, cq([['Nf3', 40], ['Bc4', 0]])],           // mine, but Nf3 is clear
    [at('e4 e5 Nf3 Nc6').key, cq([['Bb5', 35], ['Bc4', 30]])], // close: a decision
    [at('e4 e5 Nf3 Nc6 Bb5').key, cq([['a6', -40], ['Nf6', -45]])],   // a line end
    [at('e4 c5').key, { status: 'unknown' }],                  // no eval: nothing to go on
    [at('e4 c5 Nf3').key, cq([['d6', -500]])]                   // a line end, but decided
  ]);

  await check('explore: every position once, with whose move and the way there', () => {
    assert.strictEqual(list.length, 8);
    assert.deepStrictEqual(list.map(p => p.own), [true, false, true, false, true, false, true, false]);
    const leaf = at('e4 e5 Nf3 Nc6 Bb5');
    assert.ok(leaf.leaf && !at('e4 e5').leaf);
    assert.deepStrictEqual(leaf.above.map(fenKey), ['', 'e2e4', 'e2e4 e7e5', 'e2e4 e7e5 g1f3',
      'e2e4 e7e5 g1f3 b8c6'].map(s => k(...s.split(' ').filter(Boolean))));
    assert.deepStrictEqual(at('e4 e5').moves, ['Nf3']);
  });

  const cands = X.candidates(list, answers);
  await check('explore: candidates are line ends and close decisions of mine, not decided ones', () => {
    assert.deepStrictEqual(cands.map(c => [c.path.join(' '), c.reason]), [
      ['', 'decision'], ['e4 e5 Nf3 Nc6', 'decision'], ['e4 e5 Nf3 Nc6 Bb5', 'line end']]);
    assert.deepStrictEqual([cands[0].mine, cands[0].rival], [{ san: 'e4', score: 30 }, { san: 'd4', score: 25 }]);
    assert.deepStrictEqual(cands[2].best, { san: 'a6', score: -40 });
    assert.deepStrictEqual(X.candidates(list, answers, { leavesOnly: true }).map(c => c.reason), ['line end']);
    assert.strictEqual(X.candidates(list, answers, { close: 4 }).length, 1);
  });

  await check('explore: only short stored lines are kept, nearest the start first', () => {
    const pvs = new Map([
      [cands[0].key, { status: 'ok', pv: new Array(40).fill('e2e4') }],
      [cands[1].key, { status: 'ok', pv: ['f8c5', 'c2c3', 'g8f6'] }],
      [cands[2].key, { status: 'ok', pv: ['a7a6', 'b5a4'] }]
    ]);
    const t = X.pickTargets(cands, pvs);
    assert.deepStrictEqual(t.map(x => [x.path.length, x.line]), [[4, 3], [5, 2]]);
  });

  await check("explore: with a run's reach, the likeliest position goes first", () => {
    const state = { nodes: {} };
    state.nodes[at('e4 e5 Nf3 Nc6').key] = { reach: 0.1 };
    state.nodes[at('e4 e5 Nf3 Nc6 Bb5').key] = { reach: 0.3 };
    const l2 = X.positions(g, 'w', state);
    const c2 = X.candidates(l2, answers);
    const t = X.pickTargets(c2, new Map(c2.map(c => [c.key, { status: 'ok', pv: ['a7a6'] }])));
    assert.deepStrictEqual(t.map(x => x.path.length), [5, 4, 0]);
  });

  /* --- the search ------------------------------------------------------ */

  // A ChessDB made of a table: fen key -> {uci: score}. A missing position has no moves;
  // `unknown` answers 'unknown' that many times first.
  function fake(table, unknown) {
    const log = { calls: [], queued: [], slept: [] };
    const left = new Map(Object.entries(unknown || {}));
    let t = 0;
    return {
      log,
      deps: {
        queryall: fen => {
          const key = fenKey(fen);
          log.calls.push(key);
          if (left.get(key) > 0) { left.set(key, left.get(key) - 1); return Promise.resolve({ status: 'unknown' }); }
          const moves = Object.entries(table[key] || {}).map(([uci, score]) => ({ uci, score }));
          return Promise.resolve({ status: 'ok', moves });
        },
        queue: fen => { log.queued.push(fenKey(fen)); return Promise.resolve({ status: 'ok' }); },
        sleep: ms => { log.slept.push(ms); t += ms; return Promise.resolve(); },
        now: () => t
      }
    };
  }

  // 1.e4 looks best until ChessDB's answer after 1.e4 e5 is backed up: then 1.d4.
  const world = {
    [k()]: { e2e4: 30, d2d4: 20, g1f3: 10, c2c4: 5, b2b3: -40 },
    [k('e2e4')]: { e7e5: -30, c7c5: -35, e7e6: -45, c7c6: -50, d7d5: -60 },
    [k('e2e4', 'e7e5')]: { g1f3: -10, b1c3: -20, f1c4: -25, d2d4: -30, f2f4: -40 },
    [k('d2d4')]: { d7d5: -20, g8f6: -25, e7e6: -30, c7c5: -60, f7f5: -80 }
  };
  const above = [play(START, 'h2h3', 'h7h6'), play(START, 'h2h3', 'h7h6', 'g1f3')];

  {
    const f = fake(world);
    const seen = [];
    const ex = X.createExplorer(f.deps, { minDepth: 3, stable: 2 });
    const r = await ex.explore(START, { above, onDepth: h => seen.push(h.depth) });
    await check('explore: minimax over the deepened tree changes the best move', () => {
      assert.deepStrictEqual(r.depths.map(h => [h.depth, h.best, h.score]),
        [[1, 'e2e4', 30], [2, 'd2d4', 20], [3, 'd2d4', 20]]);
      assert.deepStrictEqual(r.depths[1].pv, ['d2d4']);
      assert.deepStrictEqual(seen, [1, 2, 3]);
    });
    await check('explore: stops once the move and score hold for `stable` depths', () =>
      assert.strictEqual(r.stopped, 'stable'));
    await check('explore: the best line is asked again from its end, then the PGN up to its start', () => {
      const c = f.log.calls;
      assert.deepStrictEqual(c.slice(-2), above.slice().reverse().map(fenKey));
      // After depth 1 (1.e4 e5): the position after 1.e4, then the root.
      const i = c.indexOf(k('e2e4', 'e7e5'));
      assert.deepStrictEqual(c.slice(i + 1, i + 3), [k('e2e4'), k()]);
    });
    await check('explore: a position with fewer than 5 scored moves is queued once', () => {
      assert.ok(f.log.queued.includes(k('d2d4', 'd7d5')));
      assert.strictEqual(f.log.queued.filter(x => x === k('d2d4', 'd7d5')).length, 1);
      assert.strictEqual(r.queued, f.log.queued.length);
      assert.strictEqual(r.requests, f.log.calls.length);
    });
  }

  {
    const f = fake(world);
    const r = await X.createExplorer(f.deps, {}).explore(START, { deadline: 0 });
    await check('explore: a deadline already past starts nothing', () => {
      assert.deepStrictEqual([r.stopped, r.depths.length], ['time', 0]);
      assert.strictEqual(r.requests, 0);
    });
  }

  {
    // Depth 2 reaches 1.e4 e5 for the first time, and ChessDB never scores it.
    const f = fake(world, { [k('e2e4', 'e7e5')]: Infinity });
    const r = await X.createExplorer(f.deps, {}).explore(START, { deadline: 60000 });
    await check('explore: the deadline cuts a waiting depth short, and that depth is dropped', () => {
      assert.strictEqual(r.stopped, 'time');
      assert.deepStrictEqual(r.depths.map(h => h.depth), [1]);
      const waited = f.log.slept.reduce((a, b) => a + b, 0);
      assert.ok(waited >= 60000 && waited < 120000, 'waited ' + waited);
    });
  }

  {
    const f = fake(world, { [k()]: 2 });
    const r = await X.createExplorer(f.deps, { maxDepth: 1 }).explore(START);
    await check('explore: an unknown position is queued once and waited for', () => {
      assert.deepStrictEqual(f.log.queued.filter(x => x === k()), [k()]);
      assert.deepStrictEqual(f.log.slept, [5000, 7500]);
      assert.deepStrictEqual(r.depths.map(h => h.best), ['e2e4']);
      assert.strictEqual(r.stopped, 'max-depth');
    });
  }

  {
    const f = fake(world, { [k()]: Infinity });
    const r = await X.createExplorer(f.deps, {}).explore(START);
    await check('explore: gives up on a position ChessDB never scores', () => {
      assert.strictEqual(r.stopped, 'unknown');
      assert.ok(f.log.slept.reduce((a, b) => a + b, 0) >= X.EXPLORE_DEFAULTS.unknownWait);
      assert.ok(f.log.slept.every(ms => ms <= 60000));
    });
  }

  {
    // 1.f3 e5 2.g4: Qh4 mates. ChessDB says 29999; the search's own mate must agree.
    const fool = play(START, 'f2f3', 'e7e5', 'g2g4');
    const f = fake({ [fenKey(fool)]: { d8h4: 29999, d7d5: 300, g8f6: 250, b8c6: 240, a7a6: 200 } });
    const r = await X.createExplorer(f.deps, { maxDepth: 2 }).explore(fool);
    await check('explore: mates keep ChessDB\'s plies-to-mate scale', () =>
      assert.deepStrictEqual(r.depths.map(h => [h.best, h.score, h.pv]),
        [['d8h4', 29999, ['d8h4', 'checkmate']], ['d8h4', 29999, ['d8h4', 'checkmate']]]));
  }

  {
    // A cursed win is a draw: the plain +0.10 is better.
    const f = fake({ [k()]: { e2e4: 19990, d2d4: 10, g1f3: 5, c2c4: 0, b2b3: -40 } });
    const r = await X.createExplorer(f.deps, { maxDepth: 1 }).explore(START);
    await check('explore: a cursed win counts as a draw', () =>
      assert.deepStrictEqual([r.depths[0].best, r.depths[0].score], ['d2d4', 10]));
  }

  await check('explore: UCI to SAN for the log', () => {
    assert.strictEqual(X.sanOf(START, 'g1f3'), 'Nf3');
    assert.strictEqual(X.sanOf(START, 'e2e5'), 'e2e5');
  });
};
