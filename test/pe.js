/*
 * Practical eval - the pure parts: the metric, the search against a fake provider, and
 * the rate limiter against a fake clock. No network. Called from test/harness.js.
 */

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert');

const load = rel => import(pathToFileURL(path.join(__dirname, '..', 'src', rel)).href);

// A provider over hand-written positions. FENs are placeholders; only field 2 (side to
// move) matters to the search.
function fakeProvider(pos, calls) {
  calls = calls || { explorer: 0, chessdb: 0 };
  return {
    calls,
    explorer: fen => { calls.explorer++; return Promise.resolve(pos[fen] && pos[fen].ex); },
    chessdb: fen => {
      calls.chessdb++;
      return Promise.resolve((pos[fen] && pos[fen].cdb) || { status: 'unknown', moves: [] });
    },
    child: (fen, san) => {
      const next = pos[fen] && pos[fen].next && pos[fen].next[san];
      if (!next) throw new Error('illegal');
      return next;
    }
  };
}

const ex = (total, moves) => ({
  total,
  moves: moves.map(([san, games]) => ({ san, uci: san, games, white: 0, draws: games, black: 0 }))
});
const cdb = moves => ({ status: 'ok', moves: moves.map(([san, score]) => ({ san, uci: san, score })) });

// The design's worked example: A1 +2.0 (4,000 games), A2 +1.5 (3,000), A3 -0.5 (200),
// position total 10,000. Scores are ChessDB's, from the side to move at the row (Black),
// so White's +2.0 is -200 here.
const WORKED = {
  'root w - -': { next: { Nf3: 'row b - -' } },
  'row b - -': {
    ex: ex(10000, [['A1', 4000], ['A2', 3000], ['A3', 200], ['A4', 800]]),
    cdb: cdb([['A1', -200], ['A2', -150], ['A3', 50], ['A9', 0]])
  }
};

module.exports = async function run(check) {
  const S = await load('pe/search.js');
  const P = await load('pe/providers.js');
  const C = await load('pe/cache.js');
  const near = (a, b, eps, what) =>
    assert.ok(Math.abs(a - b) <= eps, (what || 'value') + ': got ' + a + ', want ' + b);

  console.log('\npractical eval: metric');

  let res;
  // The worked examples here are plain means: riskAversion 0 (see "risk aversion" below).
  const LIN = { riskAversion: 0 };
  res = await S.evaluateRow(fakeProvider(WORKED), 'root w - -', 'Nf3', 1, LIN);
  await check('worked example gives 65.3%', () => {
    assert.strictEqual(res.state, 'value');
    assert.strictEqual(Number(res.value.toFixed(1)), 65.3, 'got ' + res.value);
    assert.strictEqual(res.mean, res.value);
  });
  await check('  ...with the unevaluated reply reported as unexplained mass', () =>
    near(res.unexplained, 0.28, 1e-9, 'unexplained'));
  await check('  ...against an engine value of 45.4%', () =>
    near(res.engine, S.winFromCp(-50), 1e-9, 'engine'));
  await check('depth 1 costs one explorer and one ChessDB call per row', () => {
    const calls = { explorer: 0, chessdb: 0 };
    return S.evaluateRow(fakeProvider(WORKED, calls), 'root w - -', 'Nf3', 1, {})
      .then(() => assert.deepStrictEqual(calls, { explorer: 1, chessdb: 1 }));
  });
  await check('win% curve matches the page\'s constant', () => {
    near(S.winFromCp(200), 67.62, 0.01);
    near(S.winFromCp(0), 50, 1e-9);
  });

  console.log('\npractical eval: perspective');
  await check('the same score from both sides sums to 100', () => {
    [0, 35, -120, 480, 29990].forEach(s => near(
      S.scoreToRootWin(s, 'x w - -', 'w') + S.scoreToRootWin(s, 'x w - -', 'b'), 100, 1e-9));
  });
  await check('a score from the root side\'s own turn is not flipped', () =>
    near(S.scoreToRootWin(200, 'x b - -', 'b'), S.winFromCp(200), 1e-9));
  const BLACK_ROOT = {
    'root b - -': { next: { Nf6: 'row w - -' } },
    // White to move at the row: +200 is good for White, so bad for the Black root.
    'row w - -': { ex: ex(1000, [['B1', 1000]]), cdb: cdb([['B1', 200]]) }
  };
  res = await S.evaluateRow(fakeProvider(BLACK_ROOT), 'root b - -', 'Nf6', 1, {});
  await check('a Black-to-move root flips ChessDB signs', () =>
    near(res.value, S.winFromCp(-200), 1e-9));

  console.log('\npractical eval: mates');
  await check('mate scores map to 100 and 0', () => {
    assert.strictEqual(S.winFromCp(29999), 100);
    assert.strictEqual(S.winFromCp(-29998), 0);
  });
  await check('a mate for the side to move is a loss for the other root', () =>
    assert.strictEqual(S.scoreToRootWin(29999, 'x b - -', 'w'), 0));

  console.log('\npractical eval: tail, gaps, floors');
  res = await S.evaluateRow(fakeProvider(WORKED), 'root w - -', 'Nf3', 1,
    { replyThreshold: 0.05 });
  await check('replies under the threshold are tail, valued by their own eval', () => {
    near(res.tailShare, 0.02, 1e-9, 'tail share');
    const a3 = res.replies.find(r => r.san === 'A3');
    near(a3.v, S.winFromCp(-50), 1e-9, 'A3');
    assert.strictEqual(a3.expanded, false);
  });
  await check('a reply ChessDB doesn\'t know is dropped, not zeroed', () =>
    assert.ok(!res.replies.some(r => r.san === 'A4'), 'A4 was kept'));
  const CASTLE = {
    'root w - -': { next: { e4: 'row b - -' } },
    'row b - -': {
      ex: { total: 100, moves: [{ san: 'O-O', uci: 'e8h8', games: 100, white: 0, draws: 100, black: 0 }] },
      cdb: { status: 'ok', moves: [{ san: 'O-O', uci: 'e8g8', score: 0 }] }
    }
  };
  res = await S.evaluateRow(fakeProvider(CASTLE), 'root w - -', 'e4', 1, {});
  await check('castling matches although the two APIs spell its UCI differently', () =>
    assert.strictEqual(res.state, 'value', 'state ' + res.state));
  const FEW = {
    'root w - -': { next: { a3: 'row b - -' } },
    'row b - -': { ex: ex(49, [['C1', 49]]), cdb: cdb([['C1', -100]]) }
  };
  res = await S.evaluateRow(fakeProvider(FEW), 'root w - -', 'a3', 1, {});
  await check('a position under minGames is a leaf, valued by the engine', () => {
    assert.strictEqual(res.state, 'few');
    near(res.value, S.winFromCp(100), 1e-9);
  });
  res = await S.evaluateRow(fakeProvider(WORKED), 'root w - -', 'Qxh7', 1, {});
  await check('an illegal row move is an error, not a throw', () => assert.strictEqual(res.state, 'error'));

  console.log('\npractical eval: deepening');
  // Row R, one reply r1, then my move: ChessDB prefers M1 (+0.50) over M2 (+0.40), but
  // humans answer M1 well (x1: 44.5%) and M2 badly (y1: 59%). Scores are from the side
  // to move, so Black's +60 is White's -60. Row S is a plain line that goes three deep.
  const cpFor = w => -Math.log(100 / w - 1) / 0.00368208;
  const switchTree = (y1, extra) => Object.assign({
    'root w - -': { next: { R: 'row b - -', S: 'srow b - -' } },
    'row b - -': { ex: ex(1000, [['r1', 1000]]), cdb: cdb([['r1', 0]]), next: { r1: 'my w - -' } },
    'my w - -': { cdb: cdb([['M1', 50], ['M2', 40]]), next: { M1: 'p1 b - -', M2: 'p2 b - -' } },
    'p1 b - -': { ex: ex(1000, [['x1', 1000]]), cdb: cdb([['x1', 60]]), next: { x1: 'px w - -' } },
    'p2 b - -': { ex: ex(1000, [['y1', 1000]]), cdb: cdb([['y1', y1]]), next: { y1: 'py w - -' } },
    'srow b - -': { ex: ex(1000, [['s1', 1000]]), cdb: cdb([['s1', 0]]), next: { s1: 'smy w - -' } },
    'smy w - -': { cdb: cdb([['N1', 0]]), next: { N1: 'q1 b - -' } },
    'q1 b - -': { ex: ex(1000, [['z', 1000]]), cdb: cdb([['z', 0]]), next: { z: 'qz w - -' } }
  }, extra || {});

  // Runs a root search over fake data. o: { tree, rows, opts, budget, hits, isStale,
  // hook(san, info) -> undefined | Promise (delay) | Error (reject) }
  const R = await load('pe/rounds.js');
  const runRoot = async o => {
    const pubs = [], errors = [], log = [];
    const search = R.createRootSearch({
      rootFen: 'root w - -', opts: o.opts || {}, budget: o.budget, isStale: o.isStale,
      makeProvider: (san, isAborted, counts) => {
        const p = fakeProvider(o.tree);
        const inner = p.explorer;
        p.explorer = (fen, info) => {
          if (isAborted()) return Promise.reject(Object.assign(new Error('c'), { cancelled: true }));
          log.push({ san, plies: info.plies });
          if (o.hits) counts.hits++; else counts.misses++;
          const h = o.hook && o.hook(san, info);
          if (h instanceof Error) return Promise.reject(h);
          return Promise.resolve(h).then(() => inner(fen, info));
        };
        return p;
      },
      onResult: (san, r) => pubs.push(Object.assign(JSON.parse(JSON.stringify(r)), { san })),
      onError: (san, e) => errors.push({ san, e })
    });
    search.add(o.rows || ['R']);
    await search.done();
    if (o.later) { search.add(o.later); await search.done(); }
    return { pubs, errors, log, of: san => pubs.filter(p => p.san === san) };
  };
  const budgetErr = () => Object.assign(new Error('budget'), { budget: true });

  let run = await runRoot({ tree: switchTree(-100) });
  let runs = run.of('R');
  await check('rounds run at 1, 3 and 5 plies, and only the last is final', () => {
    assert.deepStrictEqual(runs.map(r => r.depth), [1, 3, 5]);
    assert.deepStrictEqual(runs.map(r => r.final), [false, false, true]);
    assert.strictEqual(runs[2].stopped, 'maxPly');
  });
  await check('own move: the first time a my-node is reached, the ChessDB best stands', () => {
    near(runs[1].value, S.winFromCp(-60), 1e-9, 'd3');
    assert.deepStrictEqual(runs[1].switches, []);
    assert.strictEqual(runs[1].replies[0].move, 'M1');
  });
  await check('  ...and the next round switches when practice clearly favours another', () => {
    near(runs[2].value, S.winFromCp(100), 1e-9, 'd5');
    assert.strictEqual(runs[2].replies[0].move, 'M2');
    assert.deepStrictEqual(runs[2].switches.map(w => [w.path.join(' '), w.from, w.to]),
      [['r1', 'M1', 'M2']]);
  });
  runs = (await runRoot({ tree: switchTree(-cpFor(S.winFromCp(-60) + 0.5)) })).of('R');
  await check('  ...but not for a 0.5-point gap', () => {
    near(runs[2].value, S.winFromCp(-60), 1e-9, 'd5');
    assert.strictEqual(runs[2].replies[0].move, 'M1');
  });
  // Deeper, M1 turns out well for me (Black errs after x1): 81% at full depth against
  // M2's 59%. Compared at equal depth, M1 is 44.5% and M2 59%, so M2 is chosen.
  runs = (await runRoot({ tree: switchTree(-100, {
    'px w - -': { cdb: cdb([['Q', 0]]), next: { Q: 'pq b - -' } },
    'pq b - -': { ex: ex(1000, [['w1', 1000]]), cdb: cdb([['w1', -400]]), next: { w1: 'pw w - -' } }
  }) })).of('R');
  await check('own moves are compared at equal depth, not the best one move deeper', () => {
    assert.deepStrictEqual(runs[2].switches.map(w => [w.from, w.to]), [['M1', 'M2']]);
    near(runs[2].switches[0].gain, S.winFromCp(100) - S.winFromCp(-60), 1e-9, 'gain');
    near(runs[2].value, S.winFromCp(100), 1e-9, 'valued at full depth');
  });
  runs = (await runRoot({ tree: switchTree(-100), opts: { maxPly: 4 } })).of('R');
  await check('maxPly 4 stops after 3 plies', () =>
    assert.deepStrictEqual(runs.map(r => [r.depth, r.final]), [[1, false], [3, true]]));
  runs = (await runRoot({ tree: WORKED, rows: ['Nf3'], opts: { reachFloor: 0.5 } })).of('Nf3');
  await check('a reply below reachFloor is a leaf, so a row with only those is complete at 1', () => {
    assert.deepStrictEqual(runs.map(r => [r.depth, r.final, r.complete]), [[1, true, true]]);
    assert.ok(!runs[0].stopped, 'stopped: ' + runs[0].stopped);
  });

  console.log('\npractical eval: rounds');
  const slow = (san, info) => san === 'S' && info.plies === 3
    ? new Promise(r => setTimeout(r, 30)) : undefined;
  run = await runRoot({ tree: switchTree(-100), rows: ['R', 'S'], hook: slow });
  await check('no row starts a round before every row has finished the last one', () => {
    const last3 = run.log.map(x => x.plies).lastIndexOf(3);
    const first5 = run.log.map(x => x.plies).indexOf(5);
    assert.ok(first5 > last3, 'a depth-5 request came before the last depth-3 one');
  });
  await check('  ...and a round\'s values are published together, at one depth', () =>
    assert.deepStrictEqual(run.pubs.map(p => p.depth), [1, 1, 3, 3, 5, 5]));

  run = await runRoot({ tree: switchTree(-100), rows: ['R', 'S'],
    hook: (san, info) => (san === 'S' && info.plies === 5 ? budgetErr() : undefined) });
  await check('a budget refusal mid-round leaves every row at the last shared depth', () => {
    const finals = run.pubs.filter(p => p.final);
    assert.deepStrictEqual(finals.map(p => [p.san, p.depth, p.stopped]),
      [['R', 3, 'budget'], ['S', 3, 'budget']]);
    assert.ok(!run.pubs.some(p => p.depth === 5), 'a depth-5 value was published');
  });

  run = await runRoot({ tree: switchTree(-100), rows: ['R', 'S'], budget: { limit: 10, spent: 9 } });
  await check('a round the remaining budget can\'t pay for isn\'t started', () => {
    assert.ok(!run.log.some(x => x.plies === 3), 'depth-3 requests were made');
    assert.deepStrictEqual(run.pubs.filter(p => p.final).map(p => [p.san, p.depth, p.stopped]),
      [['R', 1, 'budget'], ['S', 1, 'budget']]);
  });
  run = await runRoot({ tree: switchTree(-100), rows: ['R', 'S'], budget: { limit: 10, spent: 9 },
    hits: true });
  await check('  ...unless the cache is carrying the work', () =>
    assert.deepStrictEqual(run.of('R').map(p => p.depth), [1, 3, 5]));

  run = await runRoot({ tree: switchTree(-100), later: ['S'] });
  await check('a row added after the table stopped catches up to its depth', () =>
    assert.deepStrictEqual(run.of('S').map(p => [p.depth, p.final, p.stopped || p.complete]),
      [[1, false, undefined], [3, false, undefined], [5, true, true]]));

  run = await runRoot({ tree: switchTree(-100), later: ['S'],
    hook: (san, info) => (san === 'S' && info.plies === 3 ? budgetErr() : undefined) });
  await check('  ...and says so when the budget runs out on the way', () =>
    assert.deepStrictEqual(run.of('S').map(p => [p.depth, p.final, p.stopped]),
      [[1, false, undefined], [1, true, 'budget']]));

  // A new position's first request is empty when its table has nothing to pick rows
  // from yet; the rows follow with the next render. Seen live on 2026-09-28: the rows
  // stopped at depth 1, shown as final with no reason.
  run = await (async () => {
    const pubs = [];
    const search = R.createRootSearch({ rootFen: 'root w - -', opts: {},
      makeProvider: () => fakeProvider(switchTree(-100)),
      onResult: (san, r) => pubs.push([san, r.depth, r.final, r.stopped || '']),
      onError: () => {} });
    search.add([]);
    await search.done();
    search.add(['R']);
    await search.done();
    return pubs;
  })();
  await check('rows arriving after an empty first request deepen as usual', () =>
    assert.deepStrictEqual(run, [['R', 1, false, ''], ['R', 3, false, ''], ['R', 5, true, 'maxPly']]));

  run = await runRoot({ tree: Object.assign({}, switchTree(-100), {
    'root w - -': { next: { R: 'row b - -', S: 'srow b - -', T: 'trow b - -' } },
    // Three replies of a third each, all under the reach floor: complete at depth 1.
    'trow b - -': { ex: ex(900, [['t1', 300], ['t2', 300], ['t3', 300]]),
      cdb: cdb([['t1', 0], ['t2', 0], ['t3', 0]]) }
  }), rows: ['T'], later: ['R'], opts: { reachFloor: 0.5 } });
  await check('a row added after every row was complete deepens past them', () => {
    assert.deepStrictEqual(run.of('T').map(p => [p.depth, p.final, p.complete]), [[1, true, true]]);
    assert.deepStrictEqual(run.of('R').map(p => [p.depth, p.final]), [[1, false], [3, false], [5, true]]);
  });

  let failOnce = true;
  const retried = await (async () => {
    const pubs = [], errs = [];
    const search = R.createRootSearch({ rootFen: 'root w - -', opts: {},
      makeProvider: () => {
        const p = fakeProvider(switchTree(-100));
        const inner = p.explorer;
        p.explorer = (fen, info) => {
          if (failOnce) { failOnce = false; return Promise.reject(Object.assign(new Error('x'), { status: 500 })); }
          return inner(fen, info);
        };
        return p;
      },
      onResult: (san, r) => pubs.push([san, r.depth]),
      onError: san => errs.push(san) });
    search.add(['R']);
    await search.done();
    search.add(['R']);
    await search.done();
    return { pubs, errs };
  })();
  await check('a row that failed starts afresh when asked for again (Click to retry)', () => {
    assert.deepStrictEqual(retried.errs, ['R']);
    assert.deepStrictEqual(retried.pubs, [['R', 1], ['R', 3], ['R', 5]]);
  });

  // Removing a row mid-round (a right-click): the round stops waiting for it.
  const pubsR = [];
  const cancelled = () => Object.assign(new Error('c'), { cancelled: true });
  const sR = R.createRootSearch({
    rootFen: 'root w - -', opts: {},
    makeProvider: (san, isAborted, counts) => {
      const p = fakeProvider(switchTree(-100));
      const inner = p.explorer;
      p.explorer = (fen, info) => {
        if (isAborted()) return Promise.reject(cancelled());
        counts.misses++;
        if (san !== 'S' || info.plies !== 3) return inner(fen, info);
        return new Promise(r => setTimeout(r, 30))
          .then(() => (isAborted() ? Promise.reject(cancelled()) : inner(fen, info)));
      };
      return p;
    },
    onResult: (san, r) => pubsR.push([san, r.depth, r.final]),
    onError: () => {}
  });
  sR.add(['R', 'S']);
  await new Promise(r => setTimeout(r, 10));
  const wasRunning = sR.remove('S');
  await sR.done();
  await check('a row taken out mid-round stops, and the others go on without it', () => {
    assert.strictEqual(wasRunning, true);
    assert.deepStrictEqual(pubsR.filter(p => p[0] === 'S'), [['S', 1, false]]);
    assert.deepStrictEqual(pubsR.filter(p => p[0] === 'R').map(p => p[1]), [1, 3, 5]);
  });

  let gone2 = false;
  run = await runRoot({ tree: switchTree(-100), isStale: () => gone2,
    hook: (san, info) => { if (info.plies === 3) gone2 = true; } });
  await check('a root that goes stale publishes nothing more', () =>
    assert.deepStrictEqual(run.pubs.map(p => p.depth), [1]));
  run = await runRoot({ tree: switchTree(-100), rows: ['R', 'S'],
    hook: san => (san === 'R' ? Object.assign(new Error('x'), { status: 500 }) : undefined) });
  await check('a failure in the first round is an error for that row only', () => {
    assert.deepStrictEqual(run.errors.map(x => [x.san, x.e.status]), [['R', 500]]);
    assert.deepStrictEqual(run.of('S').map(p => p.depth), [1, 3, 5]);
  });
  // What the search hands to ChessDB for analysis.
  const asks = [];
  const withAsk = tree => Object.assign(fakeProvider(tree),
    { analyse: (fen, san) => { asks.push(san ? fen + ' ' + san : fen); return Promise.resolve(true); } });
  res = await S.evaluateRow(withAsk(WORKED), 'root w - -', 'Nf3', 1, {});
  await check('a reply people play that ChessDB has no eval for is asked about', () => {
    assert.deepStrictEqual(asks, ['row b - - A4']);
    assert.strictEqual(res.analysing, 1);
  });
  asks.length = 0;
  const UNK = {
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: ex(1000, [['a', 700], ['b', 300]]), cdb: cdb([['a', 0], ['b', 0]]),
      next: { a: 'mine w - -', b: 'thin w - -' } },
    'thin w - -': { cdb: cdb([['T', 0]]), next: { T: 'few b - -' } },
    'few b - -': { ex: ex(10, [['q', 10]]) }                    // too few games to expand
  };
  res = await S.evaluateRow(withAsk(UNK), 'root w - -', 'R', 3, {});
  await check("a position ChessDB doesn't know is queued, if the search would use it", () => {
    assert.deepStrictEqual(asks, ['mine w - -']);
    assert.strictEqual(res.analysing, 1);
    assert.strictEqual(res.state, 'value');
  });
  asks.length = 0;
  const failing = Object.assign(fakeProvider(WORKED), { analyse: () => { throw new Error('x'); } });
  res = await S.evaluateRow(failing, 'root w - -', 'Nf3', 1, {});
  await check('  ...and a failed request for analysis never fails the search', () =>
    assert.strictEqual(Number(res.mean.toFixed(1)), 65.3));

  console.log('\npractical eval: Maia preview');
  // The Lichess search and the preview over switchTree. switchTree has 1000 games
  // everywhere, so the Lichess search never asks Maia; the preview never asks the explorer.
  // hook / maiaHook(pass, san, info) -> undefined | Promise (a delay or a rejection).
  const PPOL = { 'row b - -': [['r1', 1]], 'p1 b - -': [['x1', 1]], 'p2 b - -': [['y1', 1]],
    'srow b - -': [['s1', 1]], 'q1 b - -': [['z', 1]] };
  const tickMs = ms => new Promise(r => setTimeout(r, ms));
  const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
  const runPaired = o => {
    const pubs = [], log = [];
    const mk = pass => (san, isAborted, counts) => {
      const p = fakeProvider(o.tree);
      const inner = p.explorer;
      p.explorer = (fen, info) => {
        log.push({ pass, san, what: 'explorer' });
        if (isAborted()) return Promise.reject(cancelled());
        counts.misses++;
        return Promise.resolve(o.hook && o.hook(pass, san, info)).then(() => inner(fen, info));
      };
      p.maia = (fen, info) => {
        log.push({ pass, san, what: 'maia' });
        return Promise.resolve(o.maiaHook && o.maiaHook(pass, san, info))
          .then(() => (PPOL[fen] || []).map(([m, prob]) => ({ san: m, prob })));
      };
      return p;
    };
    const pub = pass => (san, r) => pubs.push({ pass, san, depth: r.depth, final: r.final,
      maia: r.maia, state: r.state });
    const search = R.createPreviewedSearch({
      rootFen: 'root w - -', opts: { maia: true },
      previewAfter: !!o.previewAfter,
      makeProvider: mk('lichess'),
      onResult: pub('lichess'),
      onError: (san, e) => pubs.push({ pass: 'lichess', san, error: e }),
      preview: o.noPreview ? null : {
        makeProvider: mk('maia'),
        onResult: pub('maia'),
        onError: (san, e) => pubs.push({ pass: 'maia', san, error: e })
      }
    });
    const depths = (pass, san) => pubs.filter(p => p.pass === pass && p.san === san && !p.error)
      .map(p => p.depth);
    return { search, pubs, log, depths };
  };

  let rg = gate(), pg = gate();
  let pr = runPaired({ tree: switchTree(-100),
    hook: (pass, san, info) => (info.plies === 3 ? rg.p : undefined),
    maiaHook: (pass, san, info) => (info.plies === 5 ? pg.p : undefined) });
  pr.search.add(['R', 'S']);
  await tickMs(20);
  await check('the preview deepens while the Lichess search waits on the explorer', () => {
    assert.deepStrictEqual([pr.depths('maia', 'R'), pr.depths('maia', 'S')], [[1, 3], [1, 3]]);
    assert.deepStrictEqual([pr.depths('lichess', 'R'), pr.depths('lichess', 'S')], [[1], [1]]);
  });
  await check('  ...with Maia alone, never asking the explorer', () => {
    assert.ok(pr.pubs.filter(p => p.pass === 'maia').every(p => p.maia === 1), 'not all Maia');
    assert.strictEqual(pr.log.filter(x => x.pass === 'maia' && x.what === 'explorer').length, 0);
    assert.strictEqual(pr.log.filter(x => x.pass === 'lichess' && x.what === 'maia').length, 0);
  });
  rg.open();
  await tickMs(20);
  pg.open();
  await pr.search.done();
  await check('both run to their own end: the column can show either', () => {
    assert.deepStrictEqual([pr.depths('maia', 'R'), pr.depths('maia', 'S')], [[1, 3, 5], [1, 3, 5]]);
    assert.deepStrictEqual(pr.depths('lichess', 'R'), [1, 3, 5]);
  });
  let n0 = pr.pubs.length;
  pr.search.add(['R']);
  await pr.search.done();
  await check('  ...and asking for the row again doesn\'t restart it', () =>
    assert.strictEqual(pr.pubs.length, n0));

  pg = gate();
  const boom = () => tickMs(5).then(() => { throw Object.assign(new Error('x'), { status: 500 }); });
  rg = gate();
  pr = runPaired({ tree: switchTree(-100),
    hook: (pass, san, info) => (san === 'R' && info.plies === 1 ? boom()
      : san === 'S' && info.plies === 3 ? rg.p : undefined),
    maiaHook: (pass, san, info) => (info.plies === 3 ? pg.p : undefined) });
  pr.search.add(['R', 'S']);
  await tickMs(20);
  pg.open();
  await tickMs(20);
  await check('a row whose Lichess search fails keeps its Maia values', () => {
    assert.ok(pr.pubs.some(p => p.pass === 'lichess' && p.san === 'R' && p.error), 'no error');
    assert.deepStrictEqual(pr.depths('maia', 'R'), [1, 3, 5]);
    assert.deepStrictEqual(pr.depths('maia', 'S'), [1, 3, 5]);
  });
  rg.open();
  await pr.search.done();

  rg = gate();
  pr = runPaired({ tree: switchTree(-100),
    hook: (pass, san, info) => (info.plies === 3 ? rg.p : undefined) });
  pr.search.add(['R']);
  await tickMs(20);
  pr.search.remove('R');
  pr.search.add(['R']);
  await tickMs(20);
  await check('a row taken out and put back starts both afresh', () =>
    assert.deepStrictEqual(pr.depths('maia', 'R'), [1, 3, 5, 1, 3, 5]));
  rg.open();
  await pr.search.done();
  await check('  ...and the Lichess one still gets there', () =>
    assert.deepStrictEqual(pr.depths('lichess', 'R'), [1, 1, 3, 5]));

  // A local explorer: the preview waits for the Lichess search, so the two never share
  // ChessDB's lane.
  rg = gate();
  pr = runPaired({ tree: switchTree(-100), previewAfter: true,
    hook: (pass, san, info) => (info.plies === 3 ? rg.p : undefined) });
  pr.search.add(['R', 'S']);
  await tickMs(20);
  pr.search.add(['T']);
  pr.search.remove('T');
  await check('previewAfter: no preview while the Lichess search runs', () => {
    assert.strictEqual(pr.pubs.filter(p => p.pass === 'maia').length, 0);
    assert.strictEqual(pr.log.filter(x => x.pass === 'maia').length, 0);
    assert.deepStrictEqual(pr.depths('lichess', 'R'), [1]);
  });
  rg.open();
  await pr.search.done();
  await check('  ...and once it has settled, the preview runs to its own end', () => {
    assert.deepStrictEqual([pr.depths('lichess', 'R'), pr.depths('lichess', 'S')], [[1, 3, 5], [1, 3, 5]]);
    assert.deepStrictEqual([pr.depths('maia', 'R'), pr.depths('maia', 'S')], [[1, 3, 5], [1, 3, 5]]);
    const firstMaia = pr.pubs.findIndex(p => p.pass === 'maia');
    const lastReal = pr.pubs.map(p => p.pass).lastIndexOf('lichess');
    assert.ok(firstMaia > lastReal, 'the preview started before the Lichess search settled');
  });
  await check('  ...without a row taken out while it waited', () =>
    assert.strictEqual(pr.log.filter(x => x.san === 'T' && x.pass === 'maia').length, 0));

  pr = runPaired({ tree: switchTree(-100), noPreview: true });
  pr.search.add(['R', 'S']);
  await pr.search.done();
  await check('without the preview, no Maia search runs', () => {
    assert.strictEqual(pr.pubs.filter(p => p.pass === 'maia').length, 0);
    assert.strictEqual(pr.log.filter(x => x.pass === 'maia').length, 0);
    assert.deepStrictEqual(pr.depths('lichess', 'R'), [1, 3, 5]);
  });

  console.log('\npractical eval: Maia');
  // A provider whose Maia answers from `pol` (fen -> [[san, prob]]), counting calls.
  const withMaia = (tree, pol, log) => Object.assign(fakeProvider(tree, log), {
    maia: fen => { log.maia = (log.maia || 0) + 1; log.maiaFens = (log.maiaFens || []).concat(fen);
      return Promise.resolve(pol[fen] ? pol[fen].map(([san, prob]) => ({ san, prob })) : null); }
  });
  const W = cp => S.winFromCp(cp);
  // Scores are Black's (the row's side to move): -100 is +1.00 for me.
  const thin = games => ({
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: ex(games[0] + games[1], [['A', games[0]], ['B', games[1]]]),
      cdb: cdb([['A', -100], ['B', 0], ['C', 100]]) }
  });
  const POL = { 'row b - -': [['A', 0.2], ['B', 0.3], ['C', 0.5]] };
  // The formulas below are plain means.
  const MAIA = { maia: true, maiaElo: 2000, riskAversion: 0 };
  let log = {};
  res = await S.evaluateRow(withMaia(thin([30, 10]), POL, log), 'root w - -', 'R', 1, MAIA);
  await check('under 100 games, Maia fills in as pseudo-games that fade towards 100', () => {
    // 40 games: K = 20 * (1 - 40/100) = 12 pseudo-games, spread 0.2 / 0.3 / 0.5.
    const K = 12, a = 4 / 3;
    const w = { A: 30 + 0.2 * K + a, B: 10 + 0.3 * K + a, C: 0.5 * K + a };
    const want = (w.A * W(100) + w.B * W(0) + w.C * W(-100)) / (w.A + w.B + w.C);
    near(res.value, want, 1e-9);
    assert.strictEqual(res.state, 'value');
    near(res.maia, K / (w.A + w.B + w.C), 1e-9, 'maia share');
    near(res.replies.find(r => r.san === 'C').share, 6 / 52, 1e-9, 'C share');
    assert.ok(res.replies.find(r => r.san === 'C').maiaOnly, 'C has no games');
    assert.strictEqual(res.maiaElo, 2000);
  });
  log = {};
  res = await S.evaluateRow(withMaia(thin([80, 20]), POL, log), 'root w - -', 'R', 1, MAIA);
  await check('  ...and from 100 games on, Maia is not asked at all', () => {
    assert.strictEqual(log.maia || 0, 0);
    assert.strictEqual(res.maia, 0);
    const a = 2;
    near(res.value, ((80 + a) * W(100) + (20 + a) * W(0)) / (100 + 2 * a), 1e-9);
  });
  log = {};
  res = await S.evaluateRow(withMaia(thin([6, 2]), POL, log), 'root w - -', 'R', 1, MAIA);
  await check('under 10 games Maia alone decides', () => {
    near(res.value, 0.2 * W(100) + 0.3 * W(0) + 0.5 * W(-100), 1e-9);
    near(res.maia, 1, 1e-9, 'maia share');
  });
  log = {};
  res = await S.evaluateRow(withMaia(thin([6, 2]), {}, log), 'root w - -', 'R', 1, MAIA);
  await check('without an answer from Maia, a thin position is a leaf as before', () => {
    assert.strictEqual(res.state, 'few');
    assert.strictEqual(res.maiaMissing, true);
  });
  log = {};
  res = await S.evaluateRow(withMaia(thin([30, 10]), POL, log), 'root w - -', 'R', 1, {});
  await check('with Maia off it is never asked', () => {
    assert.strictEqual(log.maia || 0, 0);
    assert.strictEqual(res.state, 'few');
  });

  // Deeper: the rare reply b (5 games) leads to a position with at most 5 games, so the
  // explorer is not asked there; Maia alone values it.
  const DEEP = {
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: ex(200, [['a', 195], ['b', 5]]), cdb: cdb([['a', 0], ['b', 0]]),
      next: { a: 'ma w - -', b: 'mb w - -' } },
    'ma w - -': { cdb: cdb([['M', 0]]), next: { M: 'pa b - -' } },
    'mb w - -': { cdb: cdb([['N', 0]]), next: { N: 'pb b - -' } },
    'pa b - -': { ex: ex(150, [['x', 150]]), cdb: cdb([['x', 0]]) },
    'pb b - -': { ex: ex(5, [['y', 5]]), cdb: cdb([['y', -300], ['z', 300]]) }
  };
  const DPOL = { 'pb b - -': [['y', 0.25], ['z', 0.75]] };
  log = { explorer: 0, chessdb: 0 };
  const exSeen = [];
  const dprov = withMaia(DEEP, DPOL, log);
  const exInner = dprov.explorer;
  dprov.explorer = (fen, info) => { exSeen.push(fen); return exInner(fen, info); };
  res = await S.evaluateRow(dprov, 'root w - -', 'R', 3, Object.assign({ replyThreshold: 0.02,
    reachFloor: 0.02 }, MAIA));
  await check('below a move with under 10 games, the explorer is not asked', () => {
    assert.ok(!exSeen.includes('pb b - -'), 'asked: ' + exSeen);
    assert.ok(exSeen.includes('pa b - -'), 'the busy line was not searched: ' + exSeen);
    assert.deepStrictEqual(log.maiaFens, ['pb b - -']);
  });
  await check('  ...and the Maia share of the row is the reach-weighted Maia part', () => {
    const b = res.replies.find(r => r.san === 'b');
    near(b.v, 0.25 * W(300) + 0.75 * W(-300), 1e-9, 'b');
    const a = 4 / 2;                           // alpha / k at the row, k = 2
    near(res.maia, (5 + a) / (200 + 2 * a), 1e-9, 'maia share');
  });

  exSeen.length = 0;
  const fprov = withMaia(DEEP, DPOL, { explorer: 0, chessdb: 0 });
  const fInner = fprov.explorer;
  fprov.explorer = (fen, info) => { exSeen.push(fen); return fInner(fen, info); };
  await S.evaluateRow(fprov, 'root w - -', 'R', 3, Object.assign({ replyThreshold: 0.02,
    reachFloor: 0.02, explorerFree: true }, MAIA));
  await check('  ...unless the explorer is free (local): then it is asked there too', () =>
    assert.ok(exSeen.includes('pb b - -'), 'not asked: ' + exSeen));

  console.log('\npractical eval: Maia alone (the preview\'s search)');
  const MONLY = Object.assign({ maiaOnly: true }, MAIA);
  log = { explorer: 0, chessdb: 0 };
  res = await S.evaluateRow(withMaia(thin([3000, 1000]), POL, log), 'root w - -', 'R', 1, MONLY);
  await check('maiaOnly: Maia alone weighs the replies, however many games there are', () => {
    near(res.value, 0.2 * W(100) + 0.3 * W(0) + 0.5 * W(-100), 1e-9);
    near(res.maia, 1, 1e-9, 'maia share');
    assert.strictEqual(res.state, 'value');
  });
  await check('  ...and the explorer is never asked', () => assert.strictEqual(log.explorer, 0));
  log = { explorer: 0, chessdb: 0 };
  const MPOL = { 'row b - -': [['a', 0.6], ['b', 0.4]], 'pa b - -': [['x', 1]],
    'pb b - -': [['y', 0.25], ['z', 0.75]] };
  res = await S.evaluateRow(withMaia(DEEP, MPOL, log), 'root w - -', 'R', 3,
    Object.assign({ replyThreshold: 0.02, reachFloor: 0.02 }, MONLY));
  await check('  ...at every depth: each opponent position is Maia\'s', () => {
    assert.strictEqual(log.explorer, 0);
    assert.deepStrictEqual(log.maiaFens.slice().sort(), ['pa b - -', 'pb b - -', 'row b - -']);
    const b = res.replies.find(r => r.san === 'b');
    near(b.share, 0.4, 1e-9, 'b share');
    near(b.v, 0.25 * W(300) + 0.75 * W(-300), 1e-9, 'b');
  });
  log = { explorer: 0, chessdb: 0 };
  res = await S.evaluateRow(withMaia(thin([3000, 1000]), {}, log), 'root w - -', 'R', 1, MONLY);
  await check('  ...and with no answer from Maia there is no value, still without the explorer', () => {
    assert.strictEqual(res.state, 'few');
    assert.strictEqual(res.maiaMissing, true);
    assert.strictEqual(log.explorer, 0);
  });

  console.log('\npractical eval: fewer requests');
  // Without Maia, the same tree: b's 5 games make the position below it a leaf whatever the
  // explorer says, so it isn't asked.
  const deepSeen = async opts => {
    const seen = [];
    const p = fakeProvider(DEEP);
    const inner = p.explorer;
    p.explorer = (fen, info) => { seen.push(fen); return inner(fen, info); };
    const r = await S.evaluateRow(p, 'root w - -', 'R', 3,
      Object.assign({ replyThreshold: 0.02, reachFloor: 0.02 }, opts));
    return { seen, r };
  };
  let skipOn = await deepSeen({});
  let skipOff = await deepSeen({ skipExplorerBelow: 0 });
  await check('without Maia, below a move with under 10 games the explorer is not asked', () => {
    assert.ok(!skipOn.seen.includes('pb b - -'), 'asked: ' + skipOn.seen);
    assert.ok(skipOn.seen.includes('pa b - -'), 'the busy line was not searched: ' + skipOn.seen);
    assert.ok(skipOff.seen.includes('pb b - -'), 'asked with the skip off: ' + skipOff.seen);
  });
  await check('  ...and the row\'s value is the same as when it is asked', () => {
    near(skipOn.r.value, skipOff.r.value, 1e-12);
    near(skipOn.r.replies.find(r => r.san === 'b').v, W(-300), 1e-9, 'b: ChessDB\'s best');
  });
  const free = await deepSeen({ explorerFree: true });
  await check('explorerFree (a local explorer): the explorer is asked below a rare move too', () =>
    assert.ok(free.seen.includes('pb b - -'), 'not asked: ' + free.seen));
  skipOn = await deepSeen({ skipExplorerBelow: 5 });
  await check('  ...and from the cut-off on it is asked', () =>
    assert.ok(skipOn.seen.includes('pb b - -'), 'not asked at 5 games: ' + skipOn.seen));

  // Two replies, h (95%) and l (5%), each to a position of mine where ChessDB prefers M1 to
  // M2. At depth 5 both my-nodes can compare at depth 1, but only h's line is reached often
  // enough for it to be worth M2's request.
  const leafy = { ex: ex(1000, [['x', 1000]]), cdb: cdb([['x', 0]]), next: { x: 'end w - -' } };
  const CMP = {
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: ex(1000, [['h', 950], ['l', 50]]), cdb: cdb([['h', 0], ['l', 0]]),
      next: { h: 'mh w - -', l: 'ml w - -' } },
    'mh w - -': { cdb: cdb([['M1', 50], ['M2', 40]]), next: { M1: 'h1 b - -', M2: 'h2 b - -' } },
    'ml w - -': { cdb: cdb([['M1', 50], ['M2', 40]]), next: { M1: 'l1 b - -', M2: 'l2 b - -' } },
    'h1 b - -': leafy, 'h2 b - -': leafy, 'l1 b - -': leafy, 'l2 b - -': leafy
  };
  const cmpSeen = async opts => {
    const seen = [];
    const p = fakeProvider(CMP);
    const inner = p.explorer;
    p.explorer = (fen, info) => { seen.push(fen); return inner(fen, info); };
    await S.evaluateRow(p, 'root w - -', 'R', 5, opts);
    return seen;
  };
  const cmpOn = await cmpSeen({});
  const cmpOff = await cmpSeen({ compareReachMin: 0 });
  await check('my alternatives are compared only on lines reached at least 10% of the time', () => {
    assert.ok(cmpOn.includes('h2 b - -'), 'the busy line compared nothing: ' + cmpOn);
    assert.ok(!cmpOn.includes('l2 b - -'), 'the 5% line compared: ' + cmpOn);
    assert.ok(cmpOn.includes('l1 b - -'), 'the 5% line was not searched: ' + cmpOn);
    assert.ok(cmpOff.includes('l2 b - -'), 'not compared with the cut-off at 0: ' + cmpOff);
  });
  // At depth 3 no my-node can compare yet; each one that would, next round, counts.
  const frOn = (await S.evaluateRow(fakeProvider(CMP), 'root w - -', 'R', 3, {})).frontier;
  const frOff = (await S.evaluateRow(fakeProvider(CMP), 'root w - -', 'R', 3,
    { compareReachMin: 0 })).frontier;
  await check('  ...and a line under it isn\'t counted as held back by depth', () =>
    assert.strictEqual(frOn, frOff - 1));

  const calls = { explorer: 0, chessdb: 0 };
  const TRANS = {
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: ex(1000, [['a', 500], ['b', 500]]), cdb: cdb([['a', 0], ['b', 0]]),
      next: { a: 'my w - -', b: 'my w - -' } },
    'my w - -': { cdb: cdb([['M', 0]]), next: { M: 'same b - -' } },
    'same b - -': { ex: ex(1000, [['z', 1000]]), cdb: cdb([['z', 0]]), next: { z: 'end w - -' } }
  };
  await S.evaluateRow(fakeProvider(TRANS, calls), 'root w - -', 'R', 3, {});
  await check('a transposition inside a row is searched once per iteration', () =>
    assert.strictEqual(calls.explorer, 2, 'explorer calls: ' + calls.explorer));

  console.log('\npractical eval: risk aversion');
  const rm = (pairs, l) => S.riskMean(pairs.map(([w, v]) => ({ w, v })), l);
  await check('the default is 0.05; 0 is the plain weighted mean', () => {
    assert.strictEqual(S.PE_DEFAULTS.riskAversion, 0.05);
    near(rm([[0.82, 48], [0.14, 82], [0.04, 85]], 0), 0.82 * 48 + 0.14 * 82 + 0.04 * 85, 1e-9);
    near(rm([[3, 40], [1, 60]], 0), 45, 1e-9);
  });
  await check('  ...and at 0.05 a sound position beats one propped up by blunders', () => {
    const trap = [[0.82, 48], [0.14, 82], [0.04, 85]], sound = [[1, 50], [1, 55]];
    assert.ok(rm(trap, 0) > rm(sound, 0));
    near(rm(trap, 0.05), 51.2, 0.05, 'trap');
    near(rm(sound, 0.05), 52.3, 0.05, 'sound');
  });
  await check('  ...between the smallest value and the mean, and exact for equal values', () => {
    const xs = [[5, 20], [1, 90], [2, 55]];
    [0.01, 0.05, 0.2, 1].forEach(l => {
      const v = rm(xs, l);
      assert.ok(v >= 20 && v <= rm(xs, 0), l + ': ' + v);
    });
    near(rm([[1, 60], [3, 60]], 0.05), 60, 1e-9);
    assert.ok(isFinite(rm([[1, 0], [1, 100]], 5)), 'no underflow');
    assert.strictEqual(rm([], 0.05), null);
  });

  // My move after the row's only reply: T (ChessDB's best) leads to a position where 82%
  // play a sound reply and 18% blunder; S to one where both replies are fine for me. The
  // plain mean keeps T, risk aversion switches to S. Depth 5, so the my-node compares at 1.
  const RISK = {
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: ex(1000, [['x', 1000]]), cdb: cdb([['x', 0]]), next: { x: 'me w - -' } },
    'me w - -': { cdb: cdb([['T', 30], ['S', 20]]), next: { T: 't b - -', S: 's b - -' } },
    't b - -': { ex: ex(1000, [['g', 820], ['b', 180]]), cdb: cdb([['g', 10], ['b', -400]]),
      next: { g: 'tg w - -', b: 'tb w - -' } },
    's b - -': { ex: ex(1000, [['p', 500], ['q', 500]]), cdb: cdb([['p', -20], ['q', -80]]),
      next: { p: 'sp w - -', q: 'sq w - -' } }
  };
  const rLin = await S.evaluateRow(fakeProvider(RISK), 'root w - -', 'R', 5, LIN);
  const rRisk = await S.evaluateRow(fakeProvider(RISK), 'root w - -', 'R', 5, {});
  await check('risk aversion can change my move: the blunder-propped line loses', () => {
    assert.strictEqual(rLin.replies[0].move, 'T');
    assert.strictEqual(rLin.switches.length, 0);
    assert.strictEqual(rRisk.replies[0].move, 'S');
    assert.deepStrictEqual(rRisk.switches.map(w => w.from + '>' + w.to), ['T>S']);
  });
  await check('  ...and the row\'s mean is the plain mean along the moves it chose', () => {
    near(rLin.mean, rLin.value, 1e-12);
    const w = 500 + 2;                               // games + alpha / k, k = 2
    near(rRisk.mean, (w * W(20) + w * W(80)) / (2 * w), 1e-9, 'mean along S');
    assert.ok(rRisk.value < rRisk.mean, rRisk.value + ' vs ' + rRisk.mean);
  });

  console.log('\nprepared score: metric');
  // Explorer responses with real counts: [san, white, draws, black]. The position's own
  // counts are the sum of its moves unless given.
  const exc = (moves, own) => {
    const ms = moves.map(([san, w, d, b]) => ({ san, uci: san, white: w, draws: d, black: b,
      games: w + d + b }));
    const s = own || ms.reduce((a, m) => [a[0] + m.white, a[1] + m.draws, a[2] + m.black], [0, 0, 0]);
    return { total: s[0] + s[1] + s[2], white: s[0], draws: s[1], black: s[2], moves: ms };
  };
  const K0 = { prepPriorGames: 0 };
  const exp = (split, side) => S.expectedScore(split, side || 'w');
  const sums1 = (sp, what) => near(sp.w + sp.d + sp.b, 1, 1e-12, (what || 'split') + ' sum');
  const sameSplit = (a, b, what) => {
    assert.ok(a && b, (what || 'split') + ': missing');
    ['w', 'd', 'b'].forEach(o => near(a[o], b[o], 1e-9, (what || 'split') + '.' + o));
  };

  // The prompt's worked example. After A my moves are c1 (best) and c2; after B, c3 (best)
  // and c4. Every game is decisive: A is 400 games of c1 at 60% and 200 of c2 at 40%, B is
  // 300 of c3 at 55% and 100 of c4 at 35%. Below c1 and c3, every reply has that same
  // split, so their prepared score is exactly 60% and 55% whatever the smoothing.
  // `side` mirrors the colours: 'b' gives the same tree with Black as the root.
  const workedTree = side => {
    const o = side === 'b' ? 'w' : 'b';
    const me = side || 'w';
    const f = (name, s) => name + ' ' + s + ' - -';
    const c = ([san, w, d, b]) => (side === 'b' ? [san, b, d, w] : [san, w, d, b]);
    const t = {};
    t[f('root', me)] = { next: { R: f('row', o) } };
    t[f('row', o)] = { ex: exc([['A', 320, 0, 280], ['B', 200, 0, 200]].map(c)),
      cdb: cdb([['A', -20], ['B', -10]]), next: { A: f('ma', me), B: f('mb', me) } };
    t[f('ma', me)] = { cdb: cdb([['c1', 40], ['c2', 10]]), next: { c1: f('p1', o), c2: f('p2', o) } };
    t[f('mb', me)] = { cdb: cdb([['c3', 30], ['c4', 0]]), next: { c3: f('p3', o), c4: f('p4', o) } };
    t[f('p1', o)] = { ex: exc([['x', 120, 0, 80], ['y', 120, 0, 80]].map(c)),
      cdb: cdb([['x', -40], ['y', -30]]), next: { x: f('e1', me), y: f('e2', me) } };
    t[f('p3', o)] = { ex: exc([['x', 110, 0, 90], ['y', 55, 0, 45]].map(c)),
      cdb: cdb([['x', -30], ['y', -20]]), next: { x: f('e3', me), y: f('e4', me) } };
    return t;
  };
  res = await S.evaluateRow(fakeProvider(workedTree()), 'root w - -', 'R', 3, K0);
  await check('worked example: the raw row score is 52%', () => {
    near(exp(res.raw), 0.52, 1e-12, 'raw');
    assert.strictEqual(res.raw.n, 1000);
    sameSplit(res.raw, { w: 0.52, d: 0, b: 0.48 }, 'raw');
  });
  await check('  ...and the prepared score 58.0%, with k = 0 at depth 3', () => {
    near(exp(res.prep), (602 * 0.6 + 402 * 0.55) / 1004, 1e-12, 'prep');
    assert.strictEqual(Number((100 * exp(res.prep)).toFixed(1)), 58.0);
    const pw = (602 * 0.6 + 402 * 0.55) / 1004;
    sameSplit(res.prep, { w: pw, d: 0, b: 1 - pw }, 'prep');
    assert.strictEqual(res.prior, 0);
    assert.strictEqual(res.leafGames, 700, 'leaf games');
  });
  await check('  ...and each reply carries its raw and prepared split', () => {
    const a = res.replies.find(r => r.san === 'A');
    near(exp(a.raw), 320 / 600, 1e-12, 'A raw');
    near(exp(a.prep), 0.6, 1e-12, 'A prep');
    assert.strictEqual(a.move, 'c1');
  });

  const Q = (v, dr, side) => S.leafSplit(null, v, side || 'w', dr, 50);
  await check('shrinkage: no games gives the prior Q, resting wholly on it', () => {
    const s = Q(60, 0.2);
    assert.strictEqual(s.prior, 1);
    assert.strictEqual(s.leafGames, 0);
    near(s.prep.d, 0.2, 1e-12, 'keeps the draw rate');
    near(exp(s.prep), 0.6, 1e-12, 'matches P');
    sums1(s.prep);
  });
  await check('  ...a very large sample gives about its own results', () => {
    const s = S.leafSplit({ w: 6e6, d: 2e6, b: 2e6, n: 1e7 }, 30, 'w', 0.2, 50);
    sameSplit({ w: +s.prep.w.toFixed(4), d: +s.prep.d.toFixed(4), b: +s.prep.b.toFixed(4) },
      { w: 0.6, d: 0.2, b: 0.2 });
    sums1(s.prep);
  });
  await check('  ...N = k gives the midpoint, half on the prior', () => {
    const c = { w: 40, d: 0, b: 10, n: 50 };
    const s = S.leafSplit(c, 50, 'w', 0, 50);
    assert.strictEqual(s.prior, 0.5);
    // Q at P = 50% with no draws is 50/0/50, E is 80/0/20.
    sameSplit(s.prep, { w: 0.65, d: 0, b: 0.35 });
    assert.strictEqual(s.leafGames, 50);
  });
  await check('  ...near 0 the draw share is clamped: P_w 0.02 with d 0.3 gives d\' 0.04', () => {
    const s = Q(2, 0.3);
    near(s.prep.d, 0.04, 1e-12, 'd\'');
    assert.ok(s.prep.w >= 0 && s.prep.b >= 0, JSON.stringify(s.prep));
    near(exp(s.prep), 0.02, 1e-12, 'still matches P');
    sums1(s.prep);
    const hi = Q(99, 0.3);
    assert.ok(hi.prep.b >= 0 && hi.prep.w <= 1, JSON.stringify(hi.prep));
  });
  await check('perspective: a Black root converts P to White\'s point of view', () => {
    const s = Q(70, 0.1, 'b');
    sameSplit(s.prep, { w: 0.25, d: 0.1, b: 0.65 });
    near(S.expectedScore(s.prep, 'b'), 0.7, 1e-12);
  });
  const mirW = await S.evaluateRow(fakeProvider(workedTree()), 'root w - -', 'R', 3, {});
  const mirB = await S.evaluateRow(fakeProvider(workedTree('b')), 'root b - -', 'R', 3, {});
  await check('  ...and a colour-mirrored tree gives the mirrored split, with k = 50', () => {
    sameSplit(mirB.prep, { w: mirW.prep.b, d: mirW.prep.d, b: mirW.prep.w });
    sameSplit(mirB.raw, { w: mirW.raw.b, d: mirW.raw.d, b: mirW.raw.w }, 'raw');
    near(mirB.prior, mirW.prior, 1e-12, 'prior');
    near(mirB.value, mirW.value, 1e-9, 'practical');
    assert.ok(mirW.prior > 0 && mirW.prior < 1, 'prior ' + mirW.prior);
  });

  console.log('\nprepared score: selection stays with Practical');
  // Row R, one reply r1, then my move: M1 is ChessDB's best, M2 is within the margin.
  // o: { x1: [cp, counts] after M1, y1: [cp, counts] after M2 }. Scores are Black's.
  const pickTree = (x1, y1) => ({
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: exc([['r1', 500, 0, 500]]), cdb: cdb([['r1', 0]]), next: { r1: 'my w - -' } },
    'my w - -': { cdb: cdb([['M1', 50], ['M2', 40]]), next: { M1: 'p1 b - -', M2: 'p2 b - -' } },
    'p1 b - -': { ex: exc([['x1'].concat(x1[1])]), cdb: cdb([['x1', x1[0]]]), next: { x1: 'px w - -' } },
    'p2 b - -': { ex: exc([['y1'].concat(y1[1])]), cdb: cdb([['y1', y1[0]]]), next: { y1: 'py w - -' } }
  });
  const PICK = { prepPriorGames: 0, minGames: 10 };
  // M2's line scores 70% over 20 games, but its Practical value is lower: M1 stays.
  res = await S.evaluateRow(fakeProvider(pickTree([0, [50, 0, 50]], [100, [14, 0, 6]])),
    'root w - -', 'R', 5, PICK);
  await check('a luckier alternative with a lower Practical value is not chosen', () => {
    assert.strictEqual(res.replies[0].move, 'M1');
    assert.deepStrictEqual(res.switches, []);
  });
  await check('  ...and the prepared score follows M1 (50%), not M2\'s 70%', () =>
    near(exp(res.prep), 0.5, 1e-12, 'prep'));
  // The Practical comparison switches to M2 although its games went worse (30% to 70%).
  res = await S.evaluateRow(fakeProvider(pickTree([60, [70, 0, 30]], [-100, [30, 0, 70]])),
    'root w - -', 'R', 5, PICK);
  await check('when the Practical comparison switches, the prepared score follows the switch', () => {
    assert.deepStrictEqual(res.switches.map(w => [w.from, w.to]), [['M1', 'M2']]);
    assert.strictEqual(res.replies[0].move, 'M2');
    near(exp(res.prep), 0.3, 1e-12, 'prep');
  });

  console.log('\nprepared score: leaves');
  // One row with two replies: T (tail) and H (heavy, recursed into). Scores are Black's.
  const leafTree = extra => Object.assign({
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: exc([['H', 600, 300, 100], ['T', 3, 0, 7]]), cdb: cdb([['H', 0], ['T', 0]]),
      next: { H: 'mh w - -', T: 'mt w - -' } }
  }, extra || {});
  res = await S.evaluateRow(fakeProvider(leafTree()), 'root w - -', 'R', 3, K0);
  await check('a tail reply is a leaf with its own results', () => {
    const t = res.replies.find(r => r.san === 'T');
    assert.strictEqual(t.expanded, false);
    sameSplit(t.prep, { w: 0.3, d: 0, b: 0.7 });
    sameSplit(t.prep, t.raw);
  });
  await check('a my-node without an eval is a leaf with the results of the reply that led there', () => {
    const h = res.replies.find(r => r.san === 'H');
    assert.strictEqual(h.expanded, true);
    sameSplit(h.prep, { w: 0.6, d: 0.3, b: 0.1 });
  });
  res = await S.evaluateRow(fakeProvider(leafTree()), 'root w - -', 'R', 3,
    { prepPriorGames: 0, reachFloor: 1 });
  await check('a reply below the reach floor is a leaf with its own results', () => {
    const h = res.replies.find(r => r.san === 'H');
    assert.strictEqual(h.expanded, false);
    sameSplit(h.prep, h.raw);
    assert.strictEqual(res.leafGames, 1010);
  });
  // H leads to my move N, then to an opponent node p whose own games differ from H's.
  const below = p => leafTree({
    'mh w - -': { cdb: cdb([['N', 0]]), next: { N: 'p b - -' } },
    'p b - -': p
  });
  res = await S.evaluateRow(fakeProvider(below({ ex: exc([['q', 16, 0, 4]]), cdb: cdb([['q', 0]]) })),
    'root w - -', 'R', 3, K0);
  await check('an opponent node with too few games is a leaf with its own results', () => {
    const h = res.replies.find(r => r.san === 'H');
    sameSplit(h.prep, { w: 0.8, d: 0, b: 0.2 });
  });
  res = await S.evaluateRow(fakeProvider(below({ ex: exc([['q', 100, 0, 0]]) })),
    'root w - -', 'R', 3, K0);
  await check('an opponent node without evals is a leaf with its own results', () => {
    const h = res.replies.find(r => r.san === 'H');
    sameSplit(h.prep, { w: 1, d: 0, b: 0 });
  });
  res = await S.evaluateRow(fakeProvider(below({ ex: exc([['q', 16, 0, 4]]), cdb: cdb([['q', 0]]) })),
    'root w - -', 'R', 3, {});
  await check('  ...and with k = 50 it leans on its Practical value, and says how much', () => {
    const h = res.replies.find(r => r.san === 'H');
    const want = S.leafSplit({ w: 16, d: 0, b: 4, n: 20 }, h.v, 'w', 0, 50).prep;
    sameSplit(h.prep, want);
    const t = res.replies.find(r => r.san === 'T');
    // Row weights: games + alpha / k, k = 2 replies.
    const wh = 1000 + 2, wt = 10 + 2;
    near(res.prior, (wh * 50 / 70 + wt * 50 / 60) / (wh + wt), 1e-12, 'prior');
    near(res.prep.w, (wh * h.prep.w + wt * t.prep.w) / (wh + wt), 1e-12, 'row w');
  });

  console.log('\nprepared score: Maia and missing counts');
  const thinC = games => ({
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: exc([['A', games[0], 0, 0], ['B', 0, 0, games[1]]]),
      cdb: cdb([['A', -100], ['B', 0], ['C', 100]]) }
  });
  res = await S.evaluateRow(withMaia(thinC([30, 10]), POL, {}), 'root w - -', 'R', 1, MAIA);
  await check('a Maia-only reply gets the prior Q, resting wholly on it', () => {
    const c = res.replies.find(r => r.san === 'C');
    assert.strictEqual(c.raw, null);
    // The row's draw rate is 0, so Q has no draws.
    sameSplit(c.prep, S.leafSplit(null, c.v, 'w', 0, 50).prep);
    const K = 12, a = 4 / 3;
    const w = { A: 30 + 0.2 * K + a, B: 10 + 0.3 * K + a, C: 0.5 * K + a };
    near(res.prior, (w.A * 50 / 80 + w.B * 50 / 60 + w.C * 1) / (w.A + w.B + w.C), 1e-12, 'prior');
  });
  res = await S.evaluateRow(withMaia(thinC([6, 2]), POL, {}), 'root w - -', 'R', 1,
    Object.assign({}, MAIA, K0));
  await check('when Maia alone decides, a reply\'s real games still feed its results', () => {
    near(res.maia, 1, 1e-9, 'maia share');
    sameSplit(res.replies.find(r => r.san === 'A').prep, { w: 1, d: 0, b: 0 }, 'A');
    sameSplit(res.replies.find(r => r.san === 'B').prep, { w: 0, d: 0, b: 1 }, 'B');
  });
  // DEEP with counts: b (5 games, 4-0-1) leads to a node where the explorer is skipped.
  const deepC = pol => {
    const t = Object.assign({}, DEEP);
    t['row b - -'] = Object.assign({}, DEEP['row b - -'],
      { ex: exc([['a', 100, 50, 45], ['b', 4, 0, 1]]) });
    return withMaia(t, pol, { explorer: 0, chessdb: 0 });
  };
  const DC = Object.assign({ replyThreshold: 0.02, reachFloor: 0.02 }, MAIA, K0);
  res = await S.evaluateRow(deepC({}), 'root w - -', 'R', 3, DC);
  await check('a Maia-skip node whose Maia fails is valued with the reply that led there', () => {
    const b = res.replies.find(r => r.san === 'b');
    assert.strictEqual(b.expanded, true);
    sameSplit(b.prep, { w: 0.8, d: 0, b: 0.2 });
  });
  res = await S.evaluateRow(deepC(DPOL), 'root w - -', 'R', 3, DC);
  await check('  ...and one Maia answers has replies with no games of their own: all prior', () => {
    const b = res.replies.find(r => r.san === 'b');
    const q = v => S.leafSplit(null, v, 'w', 0, 0).prep;
    const y = q(W(300)), z = q(W(-300));
    sameSplit(b.prep, { w: 0.25 * y.w + 0.75 * z.w, d: 0, b: 0.25 * y.b + 0.75 * z.b });
  });
  const NOCOUNT = {
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: { total: 200, moves: [
      { san: 'A', uci: 'A', games: 100, white: 30, draws: 40, black: 30 },
      { san: 'B', uci: 'B', games: 100, white: 10, draws: 10, black: 10 }] },
    cdb: cdb([['A', 0], ['B', -50]]) }
  };
  res = await S.evaluateRow(fakeProvider(NOCOUNT), 'root w - -', 'R', 1, {});
  await check('counts that don\'t add up are no counts: the prior, with the position\'s draw rate', () => {
    const b = res.replies.find(r => r.san === 'B');
    assert.strictEqual(b.raw, null);
    // The position has no counts of its own, so it sums its usable moves: A's 40% draws.
    sameSplit(b.prep, S.leafSplit(null, b.v, 'w', 0.4, 50).prep);
    sameSplit(res.raw, { w: 0.3, d: 0.4, b: 0.3 }, 'raw');
    sums1(res.prep);
  });
  res = await S.evaluateRow(fakeProvider({
    'root w - -': { next: { R: 'row b - -' } },
    'row b - -': { ex: { total: 100, moves: [{ san: 'A', uci: 'A', games: 100 }] }, cdb: cdb([['A', 0]]) }
  }), 'root w - -', 'R', 1, {});
  await check('  ...and a response without any counts gives Q without throwing', () => {
    assert.strictEqual(res.state, 'value');
    assert.strictEqual(res.raw, null);
    assert.strictEqual(res.prior, 1);
    sameSplit(res.prep, { w: 0.5, d: 0, b: 0.5 });
  });
  res = await S.evaluateRow(fakeProvider(WORKED), 'root w - -', 'Nf3', 1, {});
  await check('the existing fakes (all draws, no position counts) still get a split', () => {
    sameSplit(res.raw, { w: 0, d: 1, b: 0 }, 'raw');
    sums1(res.prep);
    assert.strictEqual(Number(res.mean.toFixed(1)), 65.3);
  });

  console.log('\nprepared score: requests, rounds, switch');
  // Every provider call, in order, with prep on and off.
  const traced = (make, log) => {
    const p = make();
    ['explorer', 'chessdb', 'analyse', 'maia'].forEach(name => {
      if (typeof p[name] !== 'function') return;
      const inner = p[name];
      p[name] = (fen, x) => { log.push(name + ' ' + fen + (typeof x === 'string' ? ' ' + x : ''));
        return inner(fen, x); };
    });
    if (!p.analyse) p.analyse = (fen, san) => { log.push('analyse ' + fen + ' ' + (san || '')); return Promise.resolve(true); };
    return p;
  };
  const scenarios = [
    [() => fakeProvider(pickTree([60, [70, 0, 30]], [-100, [30, 0, 70]])), 5, PICK],
    [() => fakeProvider(workedTree()), 5, {}],
    [() => fakeProvider(UNK), 3, {}],
    [() => fakeProvider(WORKED), 1, {}, 'Nf3'],
    [() => deepC(DPOL), 3, DC],
    [() => deepC({}), 3, DC],
    [() => withMaia(thinC([30, 10]), POL, {}), 1, MAIA]
  ];
  for (const [make, d, o, row] of scenarios) {
    const on = [], off = [];
    const rOn = await S.evaluateRow(traced(make, on), 'root w - -', row || 'R', d, Object.assign({}, o, { prep: true }));
    const rOff = await S.evaluateRow(traced(make, off), 'root w - -', row || 'R', d, Object.assign({}, o, { prep: false }));
    await check('same provider calls, in the same order, with prep on and off (depth ' + d + ', ' +
      on.length + ' calls)', () => {
      assert.deepStrictEqual(on, off);
      assert.ok(on.length > 0);
      near(rOn.value, rOff.value, 0, 'practical value');
      assert.ok(rOn.prep, 'no prep with it on');
      assert.ok(!('prep' in rOff) && !('raw' in rOff) && !('leafGames' in rOff),
        'prep fields with it off');
      assert.ok(rOff.replies.every(r => !('prep' in r) && !('raw' in r)), 'reply prep with it off');
    });
  }
  const rootCounts = async prep => {
    const seen = new Set(), snaps = [];
    const search = R.createRootSearch({
      rootFen: 'root w - -', opts: { prep },
      makeProvider: (san, isAborted, counts) => {
        const p = fakeProvider(workedTree());
        const inner = p.explorer;
        if (!snaps.includes(counts)) snaps.push(counts);
        p.explorer = (fen, info) => {
          if (seen.has(fen)) counts.hits++; else { seen.add(fen); counts.misses++; }
          return inner(fen, info);
        };
        return p;
      },
      onResult: () => {}, onError: () => {}
    });
    search.add(['R']);
    await search.done();
    return snaps.map(c => [c.hits, c.misses]);
  };
  const cOn = await rootCounts(true), cOff = await rootCounts(false);
  await check('  ...and the same cache hits and misses per round', () => {
    assert.deepStrictEqual(cOn, cOff);
    assert.strictEqual(cOn.length, 3, 'rounds: ' + JSON.stringify(cOn));
  });

  // The worked row R, and switchTree's plain row S beside it.
  const twoRows = Object.assign({}, workedTree(), {
    'root w - -': { next: { R: 'row b - -', S: 'srow b - -' } },
    'srow b - -': switchTree(-100)['srow b - -'], 'smy w - -': switchTree(-100)['smy w - -'],
    'q1 b - -': switchTree(-100)['q1 b - -']
  });
  run = await runRoot({ tree: twoRows, rows: ['R', 'S'], opts: K0 });
  await check('rounds publish the prepared split with each Practical value, at its depth', () => {
    assert.deepStrictEqual(run.pubs.map(p => p.depth), [1, 1, 3, 3, 5, 5]);
    assert.ok(run.pubs.every(p => p.prep && typeof p.prior === 'number' && p.raw), 'a pub without prep');
  });
  const d3 = await S.evaluateRow(fakeProvider(workedTree()), 'root w - -', 'R', 3, K0);
  await check('  ...the same split the row\'s search gives at that depth', () => {
    const p = run.of('R').find(x => x.depth === 3);
    sameSplit(p.prep, d3.prep);
    assert.strictEqual(p.leafGames, d3.leafGames);
  });
  run = await runRoot({ tree: workedTree(), rows: ['R'], opts: { prep: false } });
  await check('  ...and nothing of it with prep off', () =>
    assert.ok(run.pubs.length && run.pubs.every(p => !('prep' in p)), 'prep published'));

  console.log('\npractical eval: rate limiter');
  let t = 0;
  const now = () => t;
  const sleep = ms => { t += ms; return Promise.resolve(); };
  const lim = P.createRateLimiter({ now, sleep, ratePerMin: 15, burst: 8 });
  const ran = [];
  await Promise.all(Array.from({ length: 11 }, (_, i) =>
    lim.schedule(() => { ran.push(t); return i; })));
  await check('a burst of 8, then no faster than the rate', () => {
    assert.ok(ran.slice(0, 8).every(x => x === 0), 'burst: ' + ran.slice(0, 8));
    for (let i = 8; i < ran.length; i++) {
      assert.ok(ran[i] - ran[i - 1] >= 4000 - 1, 'gap ' + (ran[i] - ran[i - 1]) + 'ms at ' + i);
    }
  });
  // Lichess's own bucket as measured (providers.js): 23 held, refilling 18.5 a minute at
  // the low end. The defaults, run flat out with a pause in between, must never take
  // Lichess's below 8 when sending (itself plus 7 for Qchess's panel).
  const limD = P.createRateLimiter({ now, sleep });
  let lichess = 23, lastT = t, minLeft = Infinity;
  const sendD = () => {
    lichess = Math.min(23, lichess + (t - lastT) * 18.5 / 60000);
    lastT = t;
    minLeft = Math.min(minLeft, lichess);
    lichess -= 1;
  };
  const burstStart = t;
  const burstTimes = [];
  await Promise.all(Array.from({ length: 60 }, () =>
    limD.schedule(() => { burstTimes.push(t); sendD(); })));
  await sleep(45000);
  await Promise.all(Array.from({ length: 40 }, () => limD.schedule(sendD)));
  await check('by default, a burst of 16 at 16 a minute', () => {
    assert.strictEqual(P.LICHESS_BURST, 16);
    assert.strictEqual(P.LICHESS_RATE, 16);
    assert.ok(burstTimes.slice(0, 16).every(x => x === burstStart), 'burst: ' + burstTimes.slice(0, 17));
    assert.ok(burstTimes[16] - burstStart >= 3750 - 1, '17th at ' + (burstTimes[16] - burstStart));
  });
  await check('  ...which never runs ahead of Lichess\'s bucket, leaving 7 for Qchess\'s panel', () =>
    assert.ok(minLeft >= 8 - 1e-9, 'Lichess had ' + minLeft.toFixed(2) + ' left'));
  limD.setRate(30);
  const capTimes = [];
  await Promise.all(Array.from({ length: 20 }, () => limD.schedule(() => capTimes.push(t))));
  await check('  ...and a rate set above 18 a minute is held to 18', () => {
    for (let i = 1; i < capTimes.length; i++) {
      assert.ok(capTimes[i] - capTimes[i - 1] >= 60000 / 18 - 1,
        'gap ' + (capTimes[i] - capTimes[i - 1]) + 'ms at ' + i);
    }
  });

  await check('the popup\'s own token gets a burst of 20; Qchess\'s token, or the same one, 16', () => {
    assert.strictEqual(P.burstFor('mine', 'site'), 20);
    assert.strictEqual(P.burstFor('mine', ''), 20);
    assert.strictEqual(P.burstFor('', 'site'), 16);
    assert.strictEqual(P.burstFor('same', 'same'), 16);
  });
  // The own token's burst against the smallest bucket seen (22 in the --shared run), at
  // the highest rate the popup allows: Lichess's never drops below 3 when sending.
  const limO = P.createRateLimiter({ now, sleep, burst: P.OWN_BURST, ratePerMin: P.RATE_MAX });
  let lichessO = 22, lastO = t, minO = Infinity;
  const sendO = () => {
    lichessO = Math.min(22, lichessO + (t - lastO) * 18.5 / 60000);
    lastO = t;
    minO = Math.min(minO, lichessO);
    lichessO -= 1;
  };
  await Promise.all(Array.from({ length: 50 }, () => limO.schedule(sendO)));
  await sleep(40000);
  await Promise.all(Array.from({ length: 30 }, () => limO.schedule(sendO)));
  await check('  ...which stays 2 inside the smallest bucket measured, at 18 a minute', () =>
    assert.ok(minO >= 3 - 1e-9, 'Lichess had ' + minO.toFixed(2) + ' left'));

  const limB = P.createRateLimiter({ now, sleep, burst: 16, ratePerMin: 16 });
  limB.setBurst(20);
  const b0 = t;
  const bTimes = [];
  await Promise.all(Array.from({ length: 17 }, () => limB.schedule(() => bTimes.push(t - b0))));
  await check('a larger burst fills up at the rate, not at once', () => {
    assert.ok(bTimes.slice(0, 16).every(x => x === 0), 'first 16: ' + bTimes.slice(0, 16));
    assert.ok(bTimes[16] > 0, '17th went at once');
  });
  await sleep(120000);
  limB.setBurst(10);
  const s0 = t;
  const sTimes = [];
  await Promise.all(Array.from({ length: 11 }, () => limB.schedule(() => sTimes.push(t - s0))));
  await check('  ...and a smaller one takes effect at once', () => {
    assert.ok(sTimes.slice(0, 10).every(x => x === 0), 'first 10: ' + sTimes.slice(0, 10));
    assert.ok(sTimes[10] > 0, '11th went at once');
  });

  await sleep(120000);
  limB.pause(60000);
  const p0 = t;
  const pTimes = [];
  await Promise.all(Array.from({ length: 18 }, () => limB.schedule(() => pTimes.push(t - p0))));
  await check('a 429\'s pause empties the bucket: afterwards only what refilled goes at once', () => {
    assert.ok(pTimes[0] >= 60000, 'first at ' + pTimes[0]);
    // 60 s at 16 a minute refills 16, but the burst is 10 now.
    assert.strictEqual(pTimes.filter(x => x === pTimes[0]).length, 10);
  });

  const limS = P.createRateLimiter({ now, sleep, burst: 20, ratePerMin: 16 });
  await Promise.all(Array.from({ length: 20 }, () => limS.schedule(() => {})));
  const snap = limS.snapshot();
  await sleep(15000);               // the worker is stopped and started again
  const limR = P.createRateLimiter({ now, sleep, burst: 20, ratePerMin: 16 });
  limR.restore(snap);
  const r0 = t;
  const rTimes = [];
  await Promise.all(Array.from({ length: 6 }, () => limR.schedule(() => rTimes.push(t - r0))));
  await check('a restored bucket carries on from the snapshot, not full', () => {
    assert.ok(snap.tokens < 1, 'snapshot tokens ' + snap.tokens);
    // 15 s at 16 a minute: 4 refilled, so the 5th waits.
    assert.strictEqual(rTimes.filter(x => x === 0).length, 4, 'at once: ' + rTimes);
  });
  limR.restore({ tokens: 'x', t: 0 });
  await check('  ...and a broken snapshot changes nothing', () => {
    const s = limR.snapshot();
    assert.ok(isFinite(s.tokens) && s.tokens >= 0 && s.tokens <= 20, JSON.stringify(s));
  });

  let spent = false;
  const stale = lim.schedule(() => { spent = true; }, () => true).catch(e => e);
  await check('a stale job is dropped without running', async () => {
    const e = await stale;
    assert.ok(e && e.cancelled, 'not cancelled');
    assert.strictEqual(spent, false);
  });
  await stale;

  const order = [];
  const lim2 = P.createRateLimiter({ now, sleep, ratePerMin: 15, burst: 8 });
  await Promise.all([1, 5, 3].map(p => lim2.schedule(() => order.push(p), null, p)));
  await check('waiting jobs run highest priority first', () =>
    assert.deepStrictEqual(order, [5, 3, 1]));
  let dead = false;
  const swept = lim2.schedule(() => {}, () => dead).catch(e => e);
  dead = true;
  lim2.sweep();
  await check('sweep() drops stale jobs at once', async () => {
    const e = await swept;
    assert.ok(e && e.cancelled);
    assert.strictEqual(lim2.queued(), 0);
  });

  // Providers against a fake fetch: 429 first, then a real answer.
  t = 0;
  const stats = {};
  const fetchLog = [];
  let answer429 = true;
  const fakeFetch = url => {
    fetchLog.push({ url, t });
    if (url.indexOf('explorer') >= 0 && answer429) {
      answer429 = false;
      return Promise.resolve({ ok: false, status: 429, headers: new Map([['retry-after', '60']]) });
    }
    const body = url.indexOf('explorer') >= 0
      ? { white: 5, draws: 3, black: 2, moves: [{ uci: 'e7e5', san: 'e5', white: 5, draws: 3, black: 2 }] }
      : { status: 'ok', moves: [{ uci: 'e7e5', san: 'e5', score: -30 }] };
    return Promise.resolve({ ok: true, status: 200, headers: new Map(), json: () => Promise.resolve(body) });
  };
  const prov = P.createProviders({
    fetch: fakeFetch, cache: C.createMemoryCache(now), getToken: () => Promise.resolve('tok'),
    stats, now, sleep
  });
  const F = { speeds: ['blitz'], ratings: [2000] };
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const got = await prov.explorer(fen, F);
  await check('a 429 pauses explorer calls for 60 s, then retries', () => {
    assert.strictEqual(stats.explorer429, 1);
    const ex = fetchLog.filter(x => x.url.indexOf('explorer') >= 0);
    assert.strictEqual(ex.length, 2, 'explorer fetches: ' + ex.length);
    assert.ok(ex[1].t - ex[0].t >= 60000, 'retried after ' + (ex[1].t - ex[0].t) + 'ms');
    assert.strictEqual(got.total, 10);
  });
  await check('the rate headers are recorded for the popup', () =>
    assert.deepStrictEqual(stats.rateHeaders, { 'retry-after': '60' }));
  await check('explorer asks for 30 moves and no games', () => {
    const u = fetchLog[0].url;
    assert.ok(u.includes('moves=30') && u.includes('topGames=0') && u.includes('recentGames=0'), u);
    assert.ok(u.startsWith('https://explorer.lichess.org/lichess?'), u);
  });
  const before = { fetches: fetchLog.length, requests: stats.explorerRequests };
  await prov.explorer(fen, F);
  await prov.chessdb(fen);
  await prov.chessdb(fen);
  await check('a cached response costs no request and no budget', () => {
    assert.strictEqual(stats.explorerRequests, before.requests);
    assert.strictEqual(fetchLog.length, before.fetches + 1, 'only the first ChessDB call fetches');
  });
  await check('a different filter is a different cache entry', async () => {
    await prov.explorer(fen, { speeds: ['rapid'], ratings: [2000] });
    assert.strictEqual(stats.explorerRequests, before.requests + 1);
  });
  const budget = { limit: 2, spent: 0 };
  const bprov = P.createProviders({
    fetch: fakeFetch, cache: C.createMemoryCache(now), getToken: () => Promise.resolve('tok'),
    stats: {}, now, sleep
  });
  const pos = i => 'rnbqkbnr/pppppppp/8/8/8/' + i + '7/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
  await bprov.explorer(pos(1), F, null, { budget });
  await bprov.explorer(pos(2), F, null, { budget });
  const refused = await bprov.explorer(pos(3), F, null, { budget }).catch(e => e);
  await check('the request budget refuses uncached requests once spent', () => {
    assert.ok(refused && refused.budget, String(refused));
    assert.strictEqual(budget.spent, 2);
  });
  await bprov.explorer(pos(1), F, null, { budget });
  await check('  ...but a cached position still answers, free', () =>
    assert.strictEqual(budget.spent, 2));
  await bprov.explorer(pos(3), F, null, { budget, exempt: true });
  await check('  ...and the first iteration is never refused, though it is counted', () =>
    assert.strictEqual(budget.spent, 3));
  const b2 = { limit: 5, spent: 0 };
  const gone = await bprov.explorer(pos(4), F, () => true, { budget: b2 }).catch(e => e);
  await check('a request dropped as stale gives its budget back', () => {
    assert.ok(gone && gone.cancelled);
    assert.strictEqual(b2.spent, 0);
  });

  // The ChessDB lane: the Lichess search's lookups (1) before the preview's (0).
  const lane = P.createLimiter(1);
  const laneOrder = [];
  const hold = gate();
  lane(() => hold.p);
  const waiting = [
    lane(() => { laneOrder.push('a'); }, null, 0),
    lane(() => { laneOrder.push('b'); }, null, 1),
    lane(() => { laneOrder.push('c'); }, null, 0),
    lane(() => { laneOrder.push('d'); }, null, 0)
  ];
  waiting[2].job.priority = 2;
  hold.open();
  await Promise.all(waiting);
  await check('lookups waiting for the ChessDB lane go highest priority first', () =>
    assert.deepStrictEqual(laneOrder, ['c', 'b', 'a', 'd']));
  const cdbHold = gate();
  const boards = [];
  const pfetch = url => {
    boards.push(new URLSearchParams(url.split('?')[1]).get('board'));
    return (boards.length <= P.CDB_IN_FLIGHT ? cdbHold.p : Promise.resolve()).then(() => ({ ok: true,
      status: 200, headers: new Map(), json: () => Promise.resolve({ status: 'ok', moves: [] }) }));
  };
  const pprov = P.createProviders({ fetch: pfetch, cache: C.createMemoryCache(now),
    getToken: () => Promise.resolve('tok'), stats: {}, now, sleep });
  // The first CDB_IN_FLIGHT lookups fill the lane; the rest wait.
  const fill = Array.from({ length: P.CDB_IN_FLIGHT }, (_, i) => pos(1 + 5 * i));
  const looks = fill.map(f => pprov.chessdb(f, null, 1));
  await tickMs(5);
  looks.push(pprov.chessdb(pos(3), null, 0), pprov.chessdb(pos(4), null, 0));
  await tickMs(5);
  looks.push(pprov.chessdb(pos(4), null, 1));
  await tickMs(5);
  cdbHold.open();
  await Promise.all(looks);
  await check('  ...and a lookup the preview queued moves up when the Lichess search joins it', () =>
    assert.deepStrictEqual(boards, fill.concat([pos(4), pos(3)])));
  // A dropped connection is tried again; ChessDB's own HTTP answers are not.
  const flaky = [];
  const rprov = P.createProviders({ fetch: url => {
    flaky.push(url);
    if (flaky.length <= 2) return Promise.reject(new TypeError('Failed to fetch'));
    if (url.includes('7P%2F')) return Promise.resolve({ ok: false, status: 400 });
    return Promise.resolve({ ok: true, status: 200, headers: new Map(),
      json: () => Promise.resolve({ status: 'ok', moves: [] }) });
  }, cache: C.createMemoryCache(now), getToken: () => Promise.resolve('tok'), stats: {}, now, sleep });
  const t0 = t;
  const gotBack = await rprov.chessdb(pos(5), null, 1);
  await check('a ChessDB lookup that fails on the network is tried again, after a pause', () => {
    assert.strictEqual(gotBack.status, 'ok');
    assert.strictEqual(flaky.length, 3);
    assert.ok(t - t0 >= 4500, 'waited ' + (t - t0));
  });
  flaky.length = 2;
  let cdbRefused = null;
  await rprov.chessdb('rnbqkbnr/pppppppp/8/8/8/7P/PPPPPPP1/RNBQKBNR b KQkq - 0 1', null, 1)
    .catch(e => { cdbRefused = e; });
  await check('  ...but an HTTP error from ChessDB is final', () => {
    assert.strictEqual(cdbRefused && cdbRefused.status, 400);
    assert.strictEqual(flaky.length, 3);
  });

  // Lookups in flight at once: CDB_IN_FLIGHT, no more.
  const wideHold = gate();
  let wideNow = 0, wideMax = 0;
  const wprov = P.createProviders({ fetch: () => {
    wideNow++;
    wideMax = Math.max(wideMax, wideNow);
    return wideHold.p.then(() => {
      wideNow--;
      return { ok: true, status: 200, headers: new Map(),
        json: () => Promise.resolve({ status: 'ok', moves: [] }) };
    });
  }, cache: C.createMemoryCache(now), getToken: () => Promise.resolve('tok'), stats: {}, now, sleep });
  const wide = [1, 2, 3, 4, 5, 6].map(i => wprov.chessdb(pos(10 + i), null, 1));
  await tickMs(5);
  await check('ChessDB gets CDB_IN_FLIGHT (3) lookups at once', () => {
    assert.strictEqual(P.CDB_IN_FLIGHT, 3);
    assert.strictEqual(wideMax, 3);
  });
  wideHold.open();
  await Promise.all(wide);
  await check('  ...and never more', () => assert.strictEqual(wideMax, 3));

  // A 429 from ChessDB pauses the whole lane, then the lookup is tried again.
  const busyAt = [];
  const bStats = {};
  const bprov2 = P.createProviders({ fetch: url => {
    busyAt.push(t);
    const refuse = busyAt.length === 1;
    return Promise.resolve(refuse ? { ok: false, status: 429 } : { ok: true, status: 200,
      headers: new Map(), json: () => Promise.resolve({ status: 'ok', moves: [] }) });
  }, cache: C.createMemoryCache(now), getToken: () => Promise.resolve('tok'), stats: bStats, now, sleep });
  const tb = t;
  const busy = await bprov2.chessdb(pos(20), null, 1);
  const after = await bprov2.chessdb(pos(21), null, 1);
  await check('a ChessDB 429 pauses the lane, and the lookup is tried again after it', () => {
    assert.strictEqual(busy.status, 'ok');
    assert.strictEqual(after.status, 'ok');
    assert.strictEqual(bStats.chessdb429, 1);
    assert.strictEqual(busyAt.length, 3);
    assert.ok(busyAt[1] - tb >= P.CDB_PAUSE_MS, 'retried after ' + (busyAt[1] - tb));
  });
  const refusedAt = t;
  let held429 = 0;
  const heldAt = [];
  const hprov = P.createProviders({ fetch: () => {
    held429++;
    heldAt.push(t);
    return Promise.resolve(held429 === 1 ? { ok: false, status: 429 } : { ok: true, status: 200,
      headers: new Map(), json: () => Promise.resolve({ status: 'ok', moves: [] }) });
  }, cache: C.createMemoryCache(now), getToken: () => Promise.resolve('tok'), stats: {}, now,
  sleep: ms => new Promise(r => setTimeout(() => { t += ms; r(); }, 1)) });
  const first = hprov.chessdb(pos(22), null, 1);
  await tickMs(3);
  const other = hprov.chessdb(pos(23), null, 1);
  await Promise.all([first, other]);
  await check('  ...and a lookup asked during the pause waits it out too', () => {
    assert.strictEqual(held429, 3);
    assert.ok(heldAt.slice(1).every(x => x - refusedAt >= P.CDB_PAUSE_MS), 'at ' + heldAt);
  });

  // Asking ChessDB to analyse what it doesn't know.
  t = 0;
  const cdbLog = [];
  let cdbStatus = 'unknown';
  const cdbFetch = url => {
    cdbLog.push(url);
    const body = url.includes('action=queryall')
      ? (cdbStatus === 'ok' ? { status: 'ok', moves: [{ uci: 'e7e5', san: 'e5', score: -30 }] }
        : { status: cdbStatus })
      : { status: 'ok' };
    return Promise.resolve({ ok: true, status: 200, headers: new Map(), json: () => Promise.resolve(body) });
  };
  const aStats = {};
  const aprov = P.createProviders({ fetch: cdbFetch, cache: C.createMemoryCache(now),
    getToken: () => Promise.resolve('tok'), stats: aStats, now, sleep });
  const odd = 'r1bqkbn1/1ppppp1r/2n3pp/p7/P6P/R1N3P1/1PPPPP2/2BQKBNR w Kq - 2 6';
  const lookups = () => cdbLog.filter(u => u.includes('action=queryall')).length;
  await aprov.chessdb(odd);
  const sent = [await aprov.analyse(odd), await aprov.analyse(odd)];
  await check('an unknown position is queued for analysis once a day', () => {
    assert.deepStrictEqual(sent, [true, false]);
    const q = cdbLog.filter(u => u.includes('action=queue'));
    assert.strictEqual(q.length, 1);
    assert.ok(q[0].startsWith('https://www.chessdb.cn/cdb.php?action=queue&json=1&board=r1bqkbn1%2F'), q[0]);
    assert.strictEqual(aStats.chessdbAnalyse, 1);
  });
  t += 60 * 1000;
  await aprov.chessdb(odd);
  await check('  ...and looked up again only once ChessDB has had 2 minutes', () =>
    assert.strictEqual(lookups(), 1));
  t += 60 * 1000;
  await aprov.chessdb(odd);
  await aprov.chessdb(odd);
  await check('  ...then once more, and still unknown, cached for another 2 minutes', () =>
    assert.strictEqual(lookups(), 2));
  cdbStatus = 'ok';
  t += 2 * 60 * 1000;
  const learnt = await aprov.chessdb(odd);
  await aprov.chessdb(odd);
  t += 10 * 60 * 1000;
  await aprov.chessdb(odd);
  await check('  ...until it is known, and then cached as usual', () => {
    assert.strictEqual(learnt.status, 'ok');
    assert.strictEqual(lookups(), 3);
  });
  cdbStatus = 'unknown';
  const odd2 = odd.replace('w Kq', 'b Kq');
  await aprov.chessdb(odd2);
  await aprov.analyse(odd2);
  t += 3 * 60 * 1000;
  await aprov.chessdb(odd2);
  t += 58 * 60 * 1000;
  await aprov.chessdb(odd2);
  await aprov.chessdb(odd2);
  await check('  ...but an hour after asking, an unknown position is left for a day', () =>
    assert.strictEqual(lookups(), 5));
  await aprov.analyse(fen, 'e1g1');
  await check("a move ChessDB lacks is stored for analysis, in ChessDB's spelling", () => {
    const st = cdbLog.filter(u => u.includes('action=store'));
    assert.strictEqual(st.length, 1);
    assert.ok(st[0].endsWith('&move=move:e1g1'), st[0]);
  });
  cdbStatus = 'ok';
  const kfen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  await aprov.chessdb(kfen);
  await aprov.analyse(kfen, 'g1f3');
  t += 2 * 60 * 1000;
  const before2 = lookups();
  await aprov.chessdb(kfen);
  await aprov.chessdb(kfen);
  t += 2 * 60 * 1000;
  await aprov.chessdb(kfen);
  await check('  ...and its position is looked up once more afterwards', () =>
    assert.strictEqual(lookups(), before2 + 1));

  const noTok = P.createProviders({
    fetch: fakeFetch, cache: C.createMemoryCache(now), getToken: () => Promise.resolve(''),
    stats: {}, now, sleep
  });
  const err = await noTok.explorer(fen, F).catch(e => e);
  await check('no token is an error the column can explain', () =>
    assert.strictEqual(err && err.message, 'no-token'));
};
