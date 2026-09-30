/*
 * Repertoire generator (tools/repgen): the plan against a hand-written world, the PGN,
 * the file cache, and the root search adapter over the real rounds. No network.
 * Called from test/harness.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert');

const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const ex = (total, moves) => ({
  total,
  moves: moves.map(([san, games]) => ({ san, uci: san, games, white: 0, draws: games, black: 0 }))
});
// Moves with their results: [san, white, draws, black].
const exr = moves => {
  const ms = moves.map(([san, white, draws, black]) =>
    ({ san, uci: san, white, draws, black, games: white + draws + black }));
  return { total: ms.reduce((s, m) => s + m.games, 0), moves: ms };
};
const cdb = moves => ({ status: 'ok', moves: moves.map(([san, score]) => ({ san, uci: san, score })) });
const val = (value, depth, extra) => Object.assign({ state: 'value', value, depth, final: true }, extra);

/*
 * White to move at S. 1.d4 beats 1.e4 on practical value. Black's replies to 1.d4 are
 * followed to 90% (Nf6, d5, e6); 2.c4 is the pick after both Nf6 and d5; 1.d4 Nf6 2.c4 e6
 * and 1.d4 d5 2.c4 e6 are the same position X. ChessDB doesn't know the position after
 * 1.d4 e6.
 */
function world() {
  return {
    'S w - - 0 1': { ex: ex(1000, [['e4', 600], ['d4', 400]]),
      cdb: cdb([['e4', 30], ['d4', 25], ['h4', -200]]), next: { e4: 'E4 b - - 0 1', d4: 'D b - - 0 1' },
      root: { e4: val(55, 3), d4: val(58, 3) } },
    'D b - - 0 1': { ex: ex(1000, [['Nf6', 500], ['d5', 300], ['e6', 150], ['f5', 40], ['g6', 10], ['a6', 5]]),
      next: { Nf6: 'N w - - 0 2', d5: 'P w - - 0 2', e6: 'E w - - 0 2' } },
    'N w - - 0 2': { ex: ex(500, [['c4', 400], ['Nf3', 100]]), cdb: cdb([['c4', 20], ['Nf3', 20]]),
      next: { c4: 'NC b - - 0 2' },
      // Nf3 is still catching up (depth 1): it sits out, however good it looks.
      root: { c4: val(60, 3), Nf3: val(70, 1) } },
    'NC b - - 0 2': { ex: ex(400, [['e6', 380], ['g6', 20]]), next: { e6: 'X w - - 0 3' } },
    'P w - - 0 2': { ex: ex(300, [['c4', 300]]), cdb: cdb([['c4', 10]]), next: { c4: 'PC b - - 0 2' },
      root: { c4: val(52, 3) } },
    'PC b - - 0 2': { ex: ex(300, [['e6', 300]]), next: { e6: 'X w - - 0 3' } },
    'E w - - 0 2': { ex: ex(150, [['c4', 150]]), cdb: { status: 'unknown', moves: [] } },
    'X w - - 0 3': { ex: ex(200, [['Nc3', 200]]), cdb: cdb([['Nc3', 10]]), next: { Nc3: 'XN b - - 0 3' },
      root: { Nc3: val(50, 3) } },
    'XN b - - 0 3': { ex: ex(5, [['d5', 5]]) }
  };
}

function deps(w, log) {
  log = log || { roots: [], analysed: [] };
  return {
    log,
    explorer: fen => Promise.resolve(w[fen] && w[fen].ex),
    chessdb: fen => Promise.resolve((w[fen] && w[fen].cdb) || { status: 'unknown', moves: [] }),
    analyse: fen => { log.analysed.push(fen); return Promise.resolve(true); },
    play: (fen, san) => {
      const next = w[fen] && w[fen].next && w[fen].next[san];
      if (!next) throw new Error('no move ' + san + ' at ' + fen);
      return { fen: next, san };
    },
    runRoot: (fen, rows, x) => {
      log.roots.push({ fen, rows, opts: x.opts, budget: x.budget });
      const r = w[fen].root;
      if (r instanceof Error) return Promise.resolve({ results: new Map(rows.map(s => [s, { state: 'error', error: r }])) });
      return Promise.resolve({ results: new Map(rows.filter(s => r[s]).map(s => [s, r[s]])), spent: 7 });
    }
  };
}

async function drain(gen, clock, limit) {
  const events = [];
  for (let i = 0; i < (limit || 100); i++) {
    const ev = await gen.step();
    events.push(ev);
    if (ev.type === 'done') break;
    if (ev.type === 'waiting') clock.t = ev.until;
  }
  return events;
}

module.exports = async function run(check) {
  const G = await load('tools/repgen/generator.mjs');
  const PG = await load('tools/repgen/pgn.mjs');
  const FC = await load('tools/repgen/filecache.mjs');
  const R = await load('tools/repgen/root.mjs');
  // Most of what follows is about choosing by Practical value alone, as runs from before
  // the blend do (repgen.mjs saves [0, 1, 0] into them). The blend has its own section.
  const PRAC = { weights: [0, 1, 0] };
  const D = Object.assign({}, G.REPGEN_DEFAULTS, PRAC);
  // A generator the way repgen.mjs makes one: the run's saved config, Practical alone
  // unless the state says otherwise.
  const pracGen = o => {
    o.state.config = Object.assign({}, PRAC, o.state.config);
    return G.createGenerator(Object.assign({}, o, { config: Object.assign({}, o.state.config, o.config) }));
  };

  console.log('\nrepertoire generator: replies');
  await check('coverage falls by a step per opponent decision, then only the top reply', () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(i => G.coverageAt(D, i)), [0.9, 0.8, 0.7, 0.6, 0.5, 0]);
  });
  const E = ex(1000, [['a', 500], ['b', 300], ['c', 150], ['d', 40], ['e', 9]]);
  const sans = rs => rs.map(r => r.san).join(' ');
  await check('replies are followed until they cover the share', () => {
    assert.strictEqual(sans(G.pickReplies(E, 1, 0, D)), 'a b c');
    assert.strictEqual(sans(G.pickReplies(E, 1, 1, D)), 'a b');
    assert.strictEqual(sans(G.pickReplies(E, 1, 5, D)), 'a');
  });
  await check('a reply besides the top one needs minReach', () =>
    assert.strictEqual(sans(G.pickReplies(E, 0.02, 0, D)), 'a b'));
  await check('a reply besides the top one needs minShare of the position', () => {
    assert.strictEqual(sans(G.pickReplies(E, 1, 0, Object.assign({}, D, { minShare: 0.2 }))), 'a b');
    assert.strictEqual(sans(G.pickReplies(E, 1, 0, Object.assign({}, D, { minShare: 0.6 }))), 'a');
  });
  await check('the top reply goes on down to lineMinReach, and no further', () => {
    assert.strictEqual(sans(G.pickReplies(E, 0.004, 0, D)), 'a');
    assert.strictEqual(sans(G.pickReplies(E, 0.0019, 0, D)), '');
  });
  await check('a reply with fewer than stopGames games is never followed', () =>
    assert.strictEqual(sans(G.pickReplies(E, 1, 0, Object.assign({}, D, { coverage: 1, singleBelow: 0 }))), 'a b c d'));

  console.log('\nrepertoire generator: my moves');
  const noScore = Object.assign({}, D, { scoreRows: 0 });
  await check('candidates: near the engine best, then popular moves it rates well enough', () => {
    const c = G.pickCandidates(ex(1000, [['e4', 600], ['d4', 300], ['h4', 100]]),
      cdb([['e4', 30], ['d4', 25], ['h4', -200]]), 'S w - - 0 1', noScore, G.SEARCH_DEFAULTS);
    assert.deepStrictEqual(c.rows, ['e4', 'd4']);   // h4: 10% but far below the best
    assert.strictEqual(c.shares.d4, 0.3);
  });
  // e4 and d4 are near the engine's best. By score: a4 90%, h4 75%, b4 70%, then g4 65%;
  // f4 scores 100% on 19 games, too few to count. ChessDB hates a4 and h4 and has no
  // eval for b4.
  const SC = exr([['e4', 250, 100, 250], ['d4', 150, 100, 150], ['a4', 40, 10, 0],
    ['h4', 30, 0, 10], ['b4', 60, 20, 20], ['g4', 60, 10, 30], ['f4', 19, 0, 0]]);
  const SCDB = cdb([['e4', 30], ['d4', 25], ['a4', -300], ['h4', -250], ['g4', -40], ['f4', -300]]);
  await check('the top 3 scoring moves with 20+ games are searched, whatever ChessDB thinks', () => {
    const c = G.pickCandidates(SC, SCDB, 'S w - - 0 1', D, G.SEARCH_DEFAULTS);
    assert.deepStrictEqual(c.rows.slice(0, 5), ['e4', 'd4', 'a4', 'h4', 'b4']);
    assert.ok(c.rows.indexOf('f4') < 0, 'f4 has only 19 games: ' + c.rows);
    // g4 is fourth by score; it is in only as a popular move (7.6%) rated close enough.
    assert.deepStrictEqual(Object.keys(c.scores), ['a4', 'h4', 'b4']);
    assert.strictEqual(c.scores.a4, 0.9);
    assert.strictEqual(c.wins.b4, undefined);
  });
  await check('  ...and maxRows never cuts them', () => {
    const c = G.pickCandidates(SC, SCDB, 'S w - - 0 1', Object.assign({}, D, { maxRows: 2 }),
      G.SEARCH_DEFAULTS);
    assert.deepStrictEqual(c.rows, ['e4', 'd4', 'a4', 'h4', 'b4']);
  });
  await check('  ...scored for Black when Black is to move', () => {
    const c = G.pickCandidates(exr([['c5', 50, 0, 50], ['e5', 10, 0, 30], ['a6', 30, 0, 10]]),
      cdb([['c5', 50], ['e5', 45], ['a6', -300]]), 'B b - - 0 1', Object.assign({}, D, { scoreRows: 1 }),
      G.SEARCH_DEFAULTS);
    assert.deepStrictEqual(Object.keys(c.scores), ['e5']);
    assert.ok(c.rows.indexOf('a6') < 0, 'a6 scores 25% for Black: ' + c.rows);
  });
  await check('  ...and with no move on 20 games, the rule adds nothing', () => {
    const c = G.pickCandidates(exr([['e4', 10, 0, 0], ['a4', 19, 0, 0]]),
      cdb([['e4', 30], ['a4', -300]]), 'S w - - 0 1', D, G.SEARCH_DEFAULTS);
    assert.deepStrictEqual(c.rows, ['e4']);
    assert.deepStrictEqual(c.scores, {});
  });
  await check('candidates are in the root player\'s view when Black is to move', () => {
    // ChessDB scores are the side to move's: Black's +50 is Black's best.
    const c = G.pickCandidates(ex(100, [['c5', 60], ['e5', 40]]), cdb([['c5', 50], ['e5', 20]]),
      'B b - - 0 1', D, G.SEARCH_DEFAULTS);
    assert.strictEqual(c.best.san, 'c5');
    assert.ok(c.wins.c5 > 50, 'c5 ' + c.wins.c5);
    assert.deepStrictEqual(c.cps, { c5: 50, e5: 20 });
  });
  await check('the pick compares rows at the table\'s depth only', () => {
    const rows = [{ san: 'a', res: val(60, 3) }, { san: 'b', res: val(70, 1) }];
    assert.strictEqual(G.choose(rows, {}).san, 'a');
  });
  await check('  ...but a complete row competes at any depth', () => {
    const rows = [{ san: 'a', res: val(60, 3) }, { san: 'b', res: val(70, 1, { complete: true }) }];
    assert.strictEqual(G.choose(rows, {}).san, 'b');
  });
  await check('  ...and equal values go to the more played move', () => {
    const rows = [{ san: 'a', res: val(60, 3) }, { san: 'b', res: val(60, 3) }];
    assert.strictEqual(G.choose(rows, { a: 0.1, b: 0.4 }).san, 'b');
  });
  const few = (value, games) => ({ state: 'few', value, depth: 1, complete: true, final: true, games });
  await check('a row with too few games competes on ChessDB\'s eval, a floor for its value', () => {
    // 7.Qa4+ 53.0 at depth 3 vs 7.d3 on 5 games, ChessDB 55.4: d3.
    const rows = [{ san: 'Qa4+', res: val(53, 3) }, { san: 'd3', res: few(55.4, 5) }];
    assert.strictEqual(G.choose(rows, {}).san, 'd3');
  });
  await check('  ...and loses when even that is under the others', () => {
    const rows = [{ san: 'Qa4+', res: val(53, 3) }, { san: 'f3', res: few(51.7, 7) }];
    assert.strictEqual(G.choose(rows, {}).san, 'Qa4+');
  });
  await check('  ...and never sets the table\'s depth', () => {
    const rows = [{ san: 'a', res: val(53, 3) }, { san: 'b', res: val(60, 1) },
      { san: 'c', res: Object.assign(few(52, 5), { depth: 5, complete: false }) }];
    assert.strictEqual(G.choose(rows, {}).san, 'a');
  });
  await check('  ...but a row with no eval at all stays out', () => {
    const rows = [{ san: 'a', res: val(53, 3) }, { san: 'b', res: { state: 'none', value: null, depth: 1 } }];
    assert.strictEqual(G.choose(rows, {}).san, 'a');
  });
  const near = (cps, within) => ({ cps, within: within == null ? 1 : within, cp: 5 });
  await check('a near-tie on Practical value goes to ChessDB\'s better eval', () => {
    // A: ChessDB +1.00, Practical 55. B: +0.00, 56.
    const rows = [{ san: 'A', res: val(55, 3) }, { san: 'B', res: val(56, 3) }];
    const p = G.choose(rows, {}, near({ A: 100, B: 0 }));
    assert.strictEqual(p.san, 'A');
    assert.strictEqual(p.over.san, 'B');
  });
  await check('  ...but a clear Practical lead wins however ChessDB rates the move', () => {
    // C: +0.50, 55. D: +0.20, 58.
    const rows = [{ san: 'C', res: val(55, 3) }, { san: 'D', res: val(58, 3) }];
    const p = G.choose(rows, {}, near({ C: 50, D: 20 }));
    assert.strictEqual(p.san, 'D');
    assert.ok(!p.over);
  });
  await check('  ...1 point is close, 1.1 is not', () => {
    const at = v => G.choose([{ san: 'A', res: val(v, 3) }, { san: 'B', res: val(56, 3) }], {},
      near({ A: 100, B: 0 })).san;
    assert.deepStrictEqual([at(55), at(54.9)], ['A', 'B']);
  });
  await check('  ...and under 0.05 between them, Practical decides', () => {
    const at = a => G.choose([{ san: 'A', res: val(55.5, 3) }, { san: 'B', res: val(56, 3) }], {},
      near({ A: a, B: 0 })).san;
    assert.deepStrictEqual([at(4), at(5)], ['B', 'A']);
  });
  await check('  ...going down the rows, each needs 0.05 over the current pick', () => {
    // X takes over from T; Y is only 0.02 over X, so X's Practical value keeps it.
    const rows = [{ san: 'T', res: val(56, 3) }, { san: 'X', res: val(55.8, 3) },
      { san: 'Y', res: val(55.1, 3) }];
    assert.strictEqual(G.choose(rows, {}, near({ T: 0, X: 10, Y: 12 })).san, 'X');
  });
  await check('  ...a row without a ChessDB eval neither takes over nor is taken over', () => {
    const rows = [{ san: 'A', res: val(55.5, 3) }, { san: 'B', res: val(56, 3) }];
    assert.strictEqual(G.choose(rows, {}, near({ A: 100 })).san, 'B');
    assert.strictEqual(G.choose(rows, {}, near({ B: 0 })).san, 'B');
  });
  await check('  ...a row at another depth stays out of it', () => {
    const rows = [{ san: 'A', res: val(55.5, 1) }, { san: 'B', res: val(56, 3) }];
    assert.strictEqual(G.choose(rows, {}, near({ A: 100, B: 0 })).san, 'B');
  });
  await check('  ...and closeWithin 0 turns it off', () => {
    const rows = [{ san: 'A', res: val(55.5, 3) }, { san: 'B', res: val(56, 3) }];
    assert.strictEqual(G.choose(rows, {}, near({ A: 100, B: 0 }, 0)).san, 'B');
  });

  console.log('\nrepertoire generator: the blend');
  const W = [0.2, 0.4, 0.4];
  await check('the default choice blends ChessDB, Practical and prepared 0.1 / 0.2 / 0.7', () =>
    assert.deepStrictEqual(G.REPGEN_DEFAULTS.weights, [0.1, 0.2, 0.7]));
  await check('the blend is the weighted mean, and a missing part spreads its weight', () => {
    assert.ok(Math.abs(G.blendScore(W, 50, 60, 70) - 62) < 1e-9);
    // No prepared score: ChessDB 1/3, Practical 2/3.
    assert.ok(Math.abs(G.blendScore(W, 50, 62, null) - 58) < 1e-9);
    assert.strictEqual(G.blendScore([0, 1, 0], 50, 60, 70), null);
    assert.strictEqual(G.blendScore(undefined, 50, 60, 70), null);
    assert.ok(Math.abs(G.blendScore([1, 0, 0], null, 60, 70) - 60) < 1e-9, 'nothing weighed: Practical');
  });
  const bo = (wins, preps, extra) => Object.assign({ weights: W, wins, preps }, extra);
  await check('a better prepared score can outweigh a Practical lead', () => {
    // a: 0.2*50 + 0.4*58 + 0.4*50 = 53.2; b: 0.2*50 + 0.4*56 + 0.4*56 = 54.8.
    const rows = [{ san: 'a', res: val(58, 3) }, { san: 'b', res: val(56, 3) }];
    const p = G.choose(rows, {}, bo({ a: 50, b: 50 }, { a: 50, b: 56 }));
    assert.strictEqual(p.san, 'b');
    assert.ok(Math.abs(p.score - 54.8) < 1e-9, p.score);
    assert.strictEqual(G.choose(rows, {}, { wins: { a: 50, b: 50 }, preps: { a: 50, b: 56 } }).san, 'a',
      'without weights, Practical alone');
  });
  await check('  ...and so can ChessDB\'s eval', () => {
    const rows = [{ san: 'a', res: val(58, 3) }, { san: 'b', res: val(57, 3) }];
    assert.strictEqual(G.choose(rows, {}, bo({ a: 40, b: 50 }, { a: 55, b: 55 })).san, 'b');
  });
  await check('  ...but rows are still compared at the table\'s depth only', () => {
    const rows = [{ san: 'a', res: val(55, 3) }, { san: 'b', res: val(60, 1) }];
    assert.strictEqual(G.choose(rows, {}, bo({ a: 50, b: 70 }, { a: 50, b: 70 })).san, 'a');
  });
  await check('  ...and a row with too few games competes on its blend', () => {
    // few: value = ChessDB's 56; 0.2*56 + 0.4*56 + 0.4*56 = 56 vs 0.2*50 + 0.4*58 + 0.4*54 = 54.8.
    const rows = [{ san: 'a', res: val(58, 3) }, { san: 'b', res: few(56, 5) }];
    assert.strictEqual(G.choose(rows, {}, bo({ a: 50, b: 56 }, { a: 54, b: 56 })).san, 'b');
  });
  await check('with ChessDB weighed in, the near-tie rule stays out of it', () => {
    // Practical and prepared tie; the blend's ChessDB part already favours A by 1.
    const rows = [{ san: 'A', res: val(56, 3) }, { san: 'B', res: val(56.5, 3) }];
    const p = G.choose(rows, {}, bo({ A: 50, B: 49 }, { A: 56, B: 55 },
      { cps: { A: 0, B: 100 }, within: 1, cp: 5 }));
    assert.strictEqual(p.san, 'A');
    assert.ok(!p.over);
  });
  await check('  ...and without it, it applies to the blend of the other two', () => {
    const rows = [{ san: 'A', res: val(56, 3) }, { san: 'B', res: val(56.5, 3) }];
    const p = G.choose(rows, {}, bo({}, { A: 56, B: 56 }, { weights: [0, 0.5, 0.5],
      cps: { A: 100, B: 0 }, within: 1, cp: 5 }));
    assert.strictEqual(p.san, 'A');
    assert.strictEqual(p.over.san, 'B');
    assert.ok(Math.abs(p.over.score - 56.25) < 1e-9, p.over.score);
  });

  console.log('\nrepertoire generator: a run');
  const w = world();
  const clock = { t: 1000 };
  const dp = deps(w);
  const state = G.newState('S w - - 0 1', 'w');
  const gen = pracGen({ state, deps: dp, now: () => clock.t, config: { deepPlies: 2 } });
  const events = await drain(gen, clock);
  const N = state.nodes;
  await check('the practical pick wins over the engine\'s', () => {
    assert.strictEqual(N['S w - -'].move, 'd4');
    assert.strictEqual(N['S w - -'].pickedBy, 'practical');
  });
  await check('opponent replies to 90%, most played first', () =>
    assert.strictEqual(sans(N['D b - -'].replies), 'Nf6 d5 e6'));
  await check('work goes best first by reach', () =>
    assert.deepStrictEqual(dp.log.roots.map(r => r.fen.split(' ')[0]).slice(0, 3), ['S', 'N', 'X']));
  await check('a transposition is searched once, and its reach adds up', () => {
    assert.strictEqual(dp.log.roots.filter(r => r.fen.startsWith('X ')).length, 1);
    assert.ok(Math.abs(N['X w - -'].reach - (0.5 * 0.95 + 0.3)) < 1e-9, 'reach ' + N['X w - -'].reach);
  });
  await check('early moves are searched deep, with the deep budget; later ones shallow', () => {
    const s = dp.log.roots.find(r => r.fen.startsWith('S '));
    const n = dp.log.roots.find(r => r.fen.startsWith('N '));
    assert.deepStrictEqual([s.opts.maxPly, s.budget, n.opts.maxPly, n.budget], [6, 150, 4, 60]);
    assert.strictEqual(s.opts.maia, false);
  });
  await check('a position ChessDB doesn\'t know is sent for analysis, retried, then given up', () => {
    assert.deepStrictEqual(dp.log.analysed, ['E w - - 0 2', 'E w - - 0 2']);
    assert.strictEqual(events.filter(e => e.type === 'no-eval').length, 2);
    assert.strictEqual(N['E w - -'].status, 'leaf');
    assert.strictEqual(N['E w - -'].reason, 'no-eval');
  });
  await check('a line ends under stopGames', () => {
    assert.strictEqual(N['XN b - -'].status, 'leaf');
    assert.strictEqual(N['XN b - -'].reason, 'few-games');
  });
  await check('the run finishes with nothing left', () => {
    const c = gen.counts();
    assert.strictEqual(events[events.length - 1].type, 'done');
    assert.strictEqual(c.queued + c.wait, 0);
    assert.strictEqual(c.searches, 4);
  });

  const saved = JSON.parse(JSON.stringify(state));
  const dp2 = deps(world());
  await drain(pracGen({ state: saved, deps: dp2, now: () => clock.t }), clock);
  await check('a saved run resumes without searching anything again', () =>
    assert.strictEqual(dp2.log.roots.length, 0));

  const w3 = world();
  w3['S w - - 0 1'].root = Object.assign(new Error('HTTP 502'), { status: 502 });
  const clock3 = { t: 0 };
  const g3 = pracGen({ state: G.newState('S w - - 0 1', 'w'), deps: deps(w3), now: () => clock3.t });
  const e3 = await g3.step();
  await check('a failed search waits and is retried', () => {
    assert.strictEqual(e3.type, 'retry');
    assert.strictEqual(g3.state.nodes['S w - -'].status, 'wait');
  });
  w3['S w - - 0 1'].root = Object.assign(new Error('HTTP 401'), { status: 401 });
  clock3.t += 10 * 60 * 1000;
  const e4 = await g3.step().then(() => null, e => e);
  await check('  ...but a rejected token stops the run', () => assert.strictEqual(e4 && e4.status, 401));

  const w5 = world();
  const g5 = pracGen({ state: G.newState('S w - - 0 1', 'w'), deps: deps(w5),
    now: () => 0, config: { maxPly: 2 } });
  await drain(g5, { t: 0 });
  await check('maxPly ends lines at the depth limit', () => {
    assert.strictEqual(g5.state.nodes['D b - -'].status, 'leaf');
    assert.strictEqual(g5.state.nodes['D b - -'].reason, 'max-ply');
  });

  const w6 = world();
  w6['D b - - 0 1'].ex = ex(40, [['Nf6', 9], ['d5', 9], ['e6', 8], ['c5', 7], ['g6', 7]]);
  const g6 = pracGen({ state: G.newState('S w - - 0 1', 'w'), deps: deps(w6), now: () => 0 });
  await drain(g6, { t: 0 });
  await check('a position whose games are spread thin over replies ends the line', () =>
    assert.strictEqual(g6.state.nodes['D b - -'].reason, 'thin'));

  console.log('\nrepertoire generator: PGN');
  const pgn = PG.toPgn(state, { date: new Date(2026, 8, 25) });
  const body = pgn.split('\n\n')[1].replace(/\n/g, ' ');
  await check('headers carry the start position when it isn\'t the initial one', () => {
    assert.ok(pgn.includes('[FEN "S w - - 0 1"]'), pgn);
    assert.ok(pgn.includes('[Date "2026.09.25"]'));
    assert.ok(pgn.includes('[White "Repertoire"]'));
  });
  await check('my move carries its practical value and the alternatives', () =>
    assert.ok(body.startsWith('1. d4 {Prac 58.0 d3, engine '), body));
  await check('the most played reply is the main line; the others are variations', () => {
    assert.ok(body.includes('1... Nf6 {50% of 1,000 games} (1... d5 {30% of 1,000 games} 2. c4'), body);
    assert.ok(body.includes('(1... e6 {15% of 1,000 games · end: ChessDB has no eval})'), body);
  });
  await check('a transposition is written once, under its likelier move order', () => {
    assert.ok(body.includes('2... e6 {100% of 300 games · transposes to 1. d4 Nf6 2. c4 e6}'), body);
    assert.strictEqual(body.split('3. Nc3').length - 1, 1, body);
  });
  await check('a line\'s end says why', () =>
    assert.ok(body.includes('3. Nc3 {Prac 50.0 d3, engine 50.9 · end: few games (5)}'), body));
  await check('the game ends with *', () => assert.ok(body.trim().endsWith('*'), body));
  await check('lines stay under 80 characters, and a move number stays with its move', () => {
    const lines = pgn.split('\n\n')[1].split('\n');
    assert.ok(lines.length > 1, 'expected wrapping');
    lines.forEach(l => {
      assert.ok(l.length < 80, l);
      assert.ok(!/\d+\.(\.\.)?$/.test(l), 'number left at line end: ' + l);
    });
  });

  const bs = G.newState('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'w', ['e4']);
  bs.nodes['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'] = { kind: 'opp', status: 'done',
    games: 100, replies: [{ san: 'c5', share: 1, games: 100, child: 'k2' }] };
  bs.nodes.k2 = { kind: 'me', status: 'queued' };
  const bpgn = PG.toPgn(bs);
  await check('a --moves prefix is played from the initial position, numbered on', () => {
    assert.ok(!bpgn.includes('[FEN'), bpgn);
    assert.ok(bpgn.includes('1. e4 c5 {100% of 100 games · not searched yet}'), bpgn);
  });
  const bs2 = G.newState('B b - - 3 7', 'w');
  bs2.nodes['B b - -'] = bs.nodes['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'];
  await check('a start with Black to move is numbered "7..."', () =>
    assert.ok(PG.toPgn(bs2).includes('\n\n7... c5 {'), PG.toPgn(bs2)));

  console.log('\nrepertoire generator: marks');
  await check('a move is marked by the win% it gives up against ChessDB\'s best', () => {
    // From a clear edge of mine (70), so no move here hands the opponent one.
    const at = loss => PG.markFor({ loss, win: 70 - loss, best: { san: 'e4', win: 70 } });
    assert.deepStrictEqual([0, 2.9, 3, 6.9, 7, 14.9, 15, 40].map(at),
      ['', '', '!?', '!?', '?!', '?!', '??', '??']);
    assert.strictEqual(PG.markFor(null), '');
    assert.strictEqual(PG.markFor({ loss: 20, win: 50, best: { win: 70 } }, { markBlunder: 0 }), '?!');
  });
  const S = await load('src/pe/search.js');
  const cps = (best, mine, cfg) => {
    const b = S.winFromCp(best), m = S.winFromCp(mine);
    return PG.markFor({ loss: b - m, win: m, best: { san: 'e4', win: b } }, cfg);
  };
  await check('handing the opponent an edge the best move doesn\'t is !? however small', () => {
    assert.strictEqual(cps(0, -20), '!?');          // 1.8 win% points
    assert.strictEqual(cps(1, -13), '!?');
    assert.strictEqual(cps(-5, -15), '!?');         // equal enough, then worse
    assert.strictEqual(cps(0, -9), '');             // not an edge yet
    assert.strictEqual(cps(20, 0), '');             // giving up my own edge isn't the same
    assert.strictEqual(cps(-15, -30), '');          // already worse
    assert.strictEqual(cps(0, -20, { markWorseThan: 0 }), '');
    assert.strictEqual(cps(0, -80), '?!');          // a bigger drop still escalates
  });
  await check('my node keeps ChessDB\'s best next to its own move', () => {
    assert.strictEqual(N['S w - -'].bestMove, 'e4');
    assert.ok(N['S w - -'].bestEngine > N['S w - -'].engine);
  });
  await check('  ...and a move close to it isn\'t marked', () => assert.ok(body.startsWith('1. d4 {'), body));
  // 1.d4 wins on practical value although ChessDB puts it about 16 points under 1.e4. It
  // is only a candidate as one of the moves that score best in the games.
  const w7 = world();
  w7['S w - - 0 1'].cdb = cdb([['e4', 30], ['d4', -150]]);
  const s7 = G.newState('S w - - 0 1', 'w');
  await drain(pracGen({ state: s7, deps: deps(w7), now: () => 0 }), { t: 0 });
  const b7 = PG.toPgn(s7).split('\n\n')[1].replace(/\n/g, ' ');
  await check('a Practical pick far under the engine\'s best gets ??, and says the best', () =>
    assert.ok(/^1\. d4\?\? \{Prac 58\.0 d3, engine 36\.\d \(best e4 52\.\d\)/.test(b7), b7));
  await check('  ...and the thresholds are the run\'s own', () => {
    s7.config = { markBlunder: 20 };
    assert.ok(PG.toPgn(s7).includes('1. d4?! {'), PG.toPgn(s7));
    s7.config = {};
  });
  const old7 = JSON.parse(JSON.stringify(s7));
  delete old7.nodes['S w - -'].bestMove;
  delete old7.nodes['S w - -'].bestEngine;
  await check('  ...and a run saved before the best was stored finds it among the candidates', () =>
    assert.ok(PG.toPgn(old7).includes('1. d4?? {Prac 58.0 d3, engine 36.'), PG.toPgn(old7)));
  // 1.e4 has too few games for a Practical value, but its ChessDB eval beats 1.d4's value.
  const wf = world();
  wf['S w - - 0 1'].root = { e4: few(60, 5), d4: val(58, 3) };
  const sf = G.newState('S w - - 0 1', 'w');
  await drain(pracGen({ state: sf, deps: deps(wf), now: () => 0 }), { t: 0 });
  await check('a move with too few games wins on its eval, and the PGN says so', () => {
    const n = sf.nodes['S w - -'];
    assert.deepStrictEqual([n.move, n.pickedBy, n.few, n.value], ['e4', 'practical', true, 60]);
    const bf = PG.toPgn(sf).split('\n\n')[1].replace(/\n/g, ' ');
    assert.ok(/^1\. e4 \{Prac at least 60\.0, few games \(5\), engine 52\.\d; d4 58\.0 d3/.test(bf), bf);
  });
  // 1.e4 is half a point under 1.d4, and ChessDB rates it +0.30 against +0.25.
  const wn = world();
  wn['S w - - 0 1'].root = { e4: val(57.5, 3), d4: val(58, 3) };
  const sn = G.newState('S w - - 0 1', 'w');
  await drain(pracGen({ state: sn, deps: deps(wn), now: () => 0 }), { t: 0 });
  await check('a run gives a near-tie to ChessDB, and the PGN says what it beat', () => {
    const n = sn.nodes['S w - -'];
    assert.strictEqual(n.move, 'e4');
    assert.deepStrictEqual(n.close, { san: 'd4', value: 58, cp: 25, mine: 30 });
    assert.deepStrictEqual(n.rows.map(r => r.cp), [30, 25]);
    const bn = PG.toPgn(sn).split('\n\n')[1].replace(/\n/g, ' ');
    assert.ok(/^1\. e4 \{Prac 57\.5 d3, engine 5\d\.\d \(over d4 58\.0: ChessDB \+0\.30 vs \+0\.25\) ·/.test(bn), bn);
  });
  const sn0 = G.newState('S w - - 0 1', 'w');
  await drain(pracGen({ state: sn0, deps: deps(wn), now: () => 0,
    config: { closeWithin: 0 } }), { t: 0 });
  await check('  ...and not with --close-within 0', () => {
    assert.strictEqual(sn0.nodes['S w - -'].move, 'd4');
    assert.ok(!sn0.nodes['S w - -'].close);
  });
  const PT = await load('tools/repgen/pgntree.mjs');
  const CL = await load('tools/repgen/clean.mjs');
  await check('  ...and pgnclean drops the note with the rest of the Prac comment', () =>
    assert.strictEqual(CL.cleanComment('Prac 57.5 d3, engine 54.1 (over d4 58.0: ChessDB +0.30 vs +0.25)' +
      ' · end: few games (5)'), null));
  await check('  ...and pgnclean keeps the mark', () => {
    // The test world's moves happen to be legal from the initial position.
    const g = PT.parsePgn(PG.toPgn(s7).replace('[FEN "S w - - 0 1"]',
      '[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]'))[0];
    CL.cleanGame(g, 'w');
    assert.ok(PT.writePgn([g]).includes('1. d4??'), PT.writePgn([g]));
  });

  console.log('\nrepertoire generator: check');
  const CK = await load('tools/repgen/check.mjs');
  // The first run: the last search at X wanted evals ChessDB didn't have.
  const cw = world();
  cw['X w - - 0 3'].root = { Nc3: val(50, 3, { analysing: 2 }) };
  const cs = G.newState('S w - - 0 1', 'w');
  const cclock = { t: 1000 };
  await drain(pracGen({ state: cs, deps: deps(cw), now: () => cclock.t, config: { deepPlies: 2 } }), cclock);
  const xReach = cs.nodes['X w - -'].reach;
  await check('a search keeps how many positions it found without an eval', () =>
    assert.strictEqual(cs.nodes['X w - -'].rows[0].analysing, 2));

  // Days later ChessDB knows the position after 1.d4 e6, and rates g3 as well as c4
  // and Nf3 after 1.d4 Nf6. g3 turns out the better practical move.
  const later = () => {
    const w = world();
    w['X w - - 0 3'].root = { Nc3: val(50, 3, { analysing: 0 }) };
    w['E w - - 0 2'].cdb = cdb([['c4', 10]]);
    w['E w - - 0 2'].next = { c4: 'EC b - - 0 2' };
    w['E w - - 0 2'].root = { c4: val(51, 3) };
    w['EC b - - 0 2'] = { ex: ex(8, [['Nf6', 8]]) };
    w['N w - - 0 2'].cdb = cdb([['c4', 20], ['Nf3', 20], ['g3', 20]]);
    w['N w - - 0 2'].ex = ex(500, [['c4', 380], ['Nf3', 100], ['g3', 20]]);
    w['N w - - 0 2'].next.g3 = 'NG b - - 0 2';
    w['N w - - 0 2'].root.g3 = val(65, 3);
    w['NG b - - 0 2'] = { ex: ex(8, [['d5', 8]]) };
    return w;
  };
  const before = JSON.stringify(cs);
  const cr = await CK.runCheck({ state: cs, deps: deps(later()) });
  const act = key => (cr.found.find(f => f.node.key === key) || { result: {} }).result;
  await check('a check changes nothing by itself (a dry run is just that)', () =>
    assert.strictEqual(JSON.stringify(cs), before));
  await check('  ...looks at every position of mine in the repertoire', () =>
    assert.strictEqual(cr.checked, 5));
  await check('  ...carries on a line that ended where ChessDB now has an eval', () =>
    assert.strictEqual(act('E w - -').action, 'queue'));
  await check('  ...searches again where a move has become a candidate', () => {
    assert.strictEqual(act('N w - -').action, 'recheck');
    assert.ok(/new candidate g3/.test(act('N w - -').reasons.join()), act('N w - -').reasons);
  });
  await check('  ...and where the last search found positions without an eval', () =>
    assert.ok(/2 positions had no ChessDB eval/.test(act('X w - -').reasons.join()), act('X w - -').reasons));
  await check('  ...and leaves the rest alone', () => {
    assert.strictEqual(act('S w - -').action, undefined);
    assert.strictEqual(act('P w - -').action, undefined);
  });
  const ca = CK.apply(cs, cr.found);
  await check('applied, the old line stays until the search replaces it', () => {
    assert.deepStrictEqual([ca.recheck, ca.queued], [2, 1]);
    assert.strictEqual(cs.nodes['N w - -'].status, 'done');
    assert.ok(PG.toPgn(cs).includes('2. c4'), PG.toPgn(cs));
  });
  const cdp = deps(later());
  const cev = await drain(pracGen({ state: cs, deps: cdp, now: () => cclock.t }), cclock);
  await check('only the positions the check sent back are searched, likeliest first', () =>
    assert.deepStrictEqual(cdp.log.roots.map(r => r.fen.split(' ')[0]), ['X', 'N', 'E']));
  await check('  ...a better move replaces the old one, and what only it led to goes', () => {
    assert.strictEqual(cs.nodes['N w - -'].move, 'g3');
    assert.strictEqual(cs.nodes['N w - -'].checkPrev.move, 'c4');
    assert.ok(!cs.nodes['NC b - -'], 'NC is still there');
    assert.ok(cs.nodes['NG b - -'], 'NG was not added');
  });
  await check('  ...a position still reached another way stays, its reach not counted twice', () => {
    assert.ok(cs.nodes['X w - -']);
    assert.strictEqual(cs.nodes['X w - -'].reach, xReach);
    assert.strictEqual(cs.nodes['X w - -'].recheck, undefined);
  });
  await check('  ...and a line that had ended goes on', () => {
    assert.strictEqual(cs.nodes['E w - -'].move, 'c4');
    assert.strictEqual(cs.nodes['EC b - -'].reason, 'few-games');
  });
  await check('the outcome says what the check changed', () => {
    const o = CK.outcome(cs);
    assert.deepStrictEqual([o.changed.map(n => n.key), o.added.map(n => n.key), o.kept, o.pending],
      [['N w - -'], ['E w - -'], 1, 0]);
    assert.strictEqual(cev[cev.length - 1].type, 'done');
  });
  await check('  ...and the PGN has the new move', () => {
    const b = PG.toPgn(cs).split('\n\n')[1].replace(/\n/g, ' ');
    assert.ok(b.includes('2. g3 {Prac 65.0 d3'), b);
    assert.ok(!b.includes('2. c4 {Prac 60.0'), b);
  });
  const cr2 = await CK.runCheck({ state: cs, deps: deps(later()) });
  await check('checked again with nothing new, nothing is searched', () =>
    assert.ok(cr2.found.every(f => !f.result.action), JSON.stringify(cr2.found.map(f => f.result.reasons))));

  // A search that fails keeps the old move and its line.
  const fw = later();
  fw['S w - - 0 1'].root = Object.assign(new Error('HTTP 502'), { status: 502 });
  cs.nodes['S w - -'].recheck = true;
  const fclock = { t: cclock.t };
  const fev = await drain(pracGen({ state: cs, deps: deps(fw), now: () => fclock.t }), fclock);
  await check('a search again that keeps failing leaves the old move in place', () => {
    assert.ok(fev.some(e => e.type === 'recheck-failed'), fev.map(e => e.type));
    assert.strictEqual(cs.nodes['S w - -'].move, 'd4');
    assert.strictEqual(cs.nodes['S w - -'].status, 'done');
    assert.ok(!cs.nodes['S w - -'].recheck);
    assert.ok(PG.toPgn(cs).includes('1. d4'), PG.toPgn(cs));
  });

  const n0 = { kind: 'me', status: 'done', fen: 'S w - - 0 1', move: 'e4', pickedBy: 'engine',
    why: 'few-games', engine: 52.9, bestMove: 'e4', bestEngine: 52.9 };
  await check('an engine move is searched again when ChessDB\'s best changes', () => {
    const r = CK.assess(n0, ex(5, [['e4', 5]]), cdb([['e4', 30], ['d4', 45]]), D, G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, 'recheck');
    assert.strictEqual(r.engine.bestMove, 'd4');
    assert.strictEqual(CK.assess(n0, ex(5, [['e4', 5]]), cdb([['e4', 30]]), D, G.SEARCH_DEFAULTS).action, null);
  });
  await check('a mark follows ChessDB\'s new evals without a search', () => {
    const n = Object.assign({}, N['S w - -']);   // 1.d4, close to 1.e4 when searched
    const r = CK.assess(n, w['S w - - 0 1'].ex, cdb([['e4', 30], ['d4', -150]]), D, G.SEARCH_DEFAULTS);
    assert.deepStrictEqual([r.markFrom, r.markTo], ['', '??']);
    // It still scores as well as any move in the games, so it stays a candidate.
    assert.strictEqual(r.action, null);
  });
  await check('  ...and a move that is no longer a candidate is searched again', () => {
    const n = Object.assign({}, N['S w - -']);
    const r = CK.assess(n, w['S w - - 0 1'].ex, cdb([['e4', 30], ['d4', -150]]), noScore, G.SEARCH_DEFAULTS);
    assert.ok(/d4 is no longer a candidate \(engine 36\.\d\)/.test(r.reasons.join()), r.reasons.join());
  });
  await check('--check-all searches every practical move again', () => {
    const n = Object.assign({}, N['S w - -']);
    assert.strictEqual(CK.assess(n, w['S w - - 0 1'].ex, w['S w - - 0 1'].cdb, D, G.SEARCH_DEFAULTS).action, null);
    assert.strictEqual(CK.assess(n, w['S w - - 0 1'].ex, w['S w - - 0 1'].cdb, D, G.SEARCH_DEFAULTS, true).action, 'recheck');
  });
  await check('a move a row with too few games now beats is searched again', () => {
    // Searched before such rows competed: e4 had 5 games and ChessDB's 60, d4 won on 58.
    const n = Object.assign({}, N['S w - -'], { rows: N['S w - -'].rows.map(r =>
      r.san === 'e4' ? Object.assign({}, r, { state: 'few', value: 60, depth: 1, complete: true }) : r) });
    const r = CK.assess(n, w['S w - - 0 1'].ex, w['S w - - 0 1'].cdb, D, G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, 'recheck');
    assert.ok(/e4 has too few games for a Practical value, but its engine 60\.0 beats d4's 58\.0/
      .test(r.reasons.join()), r.reasons.join());
  });

  await check('a near-tie that ChessDB now decides is searched again', () => {
    // Searched with e4 1 point under d4; ChessDB now rates e4 +0.30 against d4's +0.25.
    const n = Object.assign({}, N['S w - -'], { rows: N['S w - -'].rows.map(r =>
      r.san === 'e4' ? Object.assign({}, r, { value: 57 }) : r) });
    const r = CK.assess(n, w['S w - - 0 1'].ex, cdb([['e4', 30], ['d4', 25]]), D, G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, 'recheck');
    assert.ok(/e4 is within 1\.0 of d4's Practical value, and ChessDB rates it \+0\.30 vs \+0\.25/
      .test(r.reasons.join()), r.reasons.join());
  });
  await check('  ...and so is one it no longer decides', () => {
    const n = Object.assign({}, sn.nodes['S w - -']);
    const r = CK.assess(n, wn['S w - - 0 1'].ex, cdb([['e4', 28], ['d4', 25]]), D, G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, 'recheck');
    assert.ok(/e4 won a near-tie on ChessDB's eval, which no longer decides it \(\+0\.28 vs d4 \+0\.25\)/
      .test(r.reasons.join()), r.reasons.join());
    assert.strictEqual(CK.assess(n, wn['S w - - 0 1'].ex, cdb([['e4', 30], ['d4', 25]]), D,
      G.SEARCH_DEFAULTS).action, null);
  });

  console.log('\nrepertoire generator: a blended run');
  // e4: Practical 55, prepared 65 (30% of it from the Practical value), ChessDB +0.30.
  // d4: Practical 58, prepared 55, ChessDB +0.25. Blend: e4 58.55, d4 55.66.
  const sp = (w, d, b) => ({ w, d, b });
  const wb = world();
  wb['S w - - 0 1'].root = { e4: val(55, 3, { prep: sp(0.62, 0.06, 0.32), prior: 0.3 }),
    d4: val(58, 3, { prep: sp(0.55, 0, 0.45), prior: 0.1 }) };
  const sb = G.newState('S w - - 0 1', 'w');
  await drain(G.createGenerator({ state: sb, deps: deps(wb), now: () => 0, config: { weights: W } }), { t: 0 });
  const nb = sb.nodes['S w - -'];
  const sd = G.newState('S w - - 0 1', 'w');
  await drain(G.createGenerator({ state: sd, deps: deps(wb), now: () => 0 }), { t: 0 });
  await check('a run with the default weights blends 0.1 / 0.2 / 0.7', () => {
    const n = sd.nodes['S w - -'];
    assert.strictEqual(n.move, 'e4');
    assert.ok(Math.abs(n.blend - (0.1 * n.engine + 0.2 * 55 + 0.7 * 65)) < 1e-9, n.blend);
  });
  await check('with weights 0.2 / 0.4 / 0.4, the prepared score wins it for 1.e4', () => {
    assert.strictEqual(nb.move, 'e4');
    assert.strictEqual(nb.value, 55);
    assert.ok(Math.abs(nb.prep - 65) < 1e-9, nb.prep);
    assert.strictEqual(nb.prior, 0.3);
    assert.ok(Math.abs(nb.blend - (0.2 * nb.engine + 0.4 * 55 + 0.4 * 65)) < 1e-9, nb.blend);
  });
  await check('  ...and every row keeps its prepared score, share of prior and blend', () => {
    const d4 = nb.rows.find(r => r.san === 'd4');
    assert.ok(Math.abs(d4.prep - 55) < 1e-9, d4.prep);
    assert.strictEqual(d4.prior, 0.1);
    assert.ok(Math.abs(d4.blend - (0.2 * d4.engine + 0.4 * 58 + 0.4 * 55)) < 1e-9, d4.blend);
    assert.strictEqual(d4.score, 0.5, 'its score in the games stays');
  });
  const bb = PG.toPgn(sb).split('\n\n')[1].replace(/\n/g, ' ');
  await check('  ...and the PGN gives the parts, the blend, and the others by theirs', () =>
    assert.ok(/^1\. e4 \{Prac 55\.0 d3, prep 65\.0 \(30% Prac\), engine 52\.\d, blend 58\.\d; d4 55\.\d \(Prac 58\.0\) ·/
      .test(bb), bb));
  await check('  ...which pgnclean drops like any Prac comment', () =>
    assert.strictEqual(CL.cleanComment('Prac 55.0 d3, prep 65.0 (30% Prac), engine 52.8, blend 58.5; ' +
      'd4 55.7 (Prac 58.0) · end: few games (5)'), null));
  // Black to move: the prepared split is turned into Black's score.
  const wk = { 'B b - - 0 1': { ex: ex(1000, [['c5', 600], ['e5', 400]]), cdb: cdb([['c5', 20], ['e5', 20]]),
    next: { c5: 'C w - - 0 2', e5: 'E w - - 0 2' },
    root: { c5: val(50, 3, { prep: sp(0.6, 0.2, 0.2) }), e5: val(50, 3, { prep: sp(0.3, 0.2, 0.5) }) } } };
  const sk = G.newState('B b - - 0 1', 'b');
  await drain(G.createGenerator({ state: sk, deps: deps(wk), now: () => 0 }), { t: 0 });
  await check('with Black to move, the prepared score is Black\'s', () => {
    const n = sk.nodes['B b - -'];
    assert.strictEqual(n.move, 'e5');
    assert.ok(Math.abs(n.prep - 60) < 1e-9, n.prep);
    assert.ok(Math.abs(n.rows.find(r => r.san === 'c5').prep - 30) < 1e-9);
  });
  const WD = Object.assign({}, G.REPGEN_DEFAULTS, { weights: W });
  await check('a check with the same evals leaves a blended pick alone', () => {
    const r = CK.assess(Object.assign({}, nb), wb['S w - - 0 1'].ex, wb['S w - - 0 1'].cdb, WD, G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, null, r.reasons.join());
  });
  await check('  ...and searches again where ChessDB\'s new eval tips the blend', () => {
    // e4 at -3.00 now: 0.2*24.9 + 22 + 26 = 53.0 against d4's 55.7.
    const r = CK.assess(Object.assign({}, nb), wb['S w - - 0 1'].ex, cdb([['e4', -300], ['d4', 25]]), WD,
      G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, 'recheck');
    assert.ok(/d4 now leads the blend: 55\.\d vs e4 53\.\d/.test(r.reasons.join()), r.reasons.join());
    assert.ok(Math.abs(r.engine.blend - r.engine.rows.find(x => x.san === 'e4').blend) < 1e-9,
      'the pick\'s blend follows the new eval');
  });
  await check('a run from before rows saved prepared scores is searched again once they count', () => {
    const n = Object.assign({}, N['S w - -']);
    const old = Object.assign({}, n, { rows: n.rows.map(r => { const x = Object.assign({}, r); delete x.prep; return x; }) });
    const r = CK.assess(old, w['S w - - 0 1'].ex, w['S w - - 0 1'].cdb, WD, G.SEARCH_DEFAULTS);
    assert.strictEqual(r.action, 'recheck');
    assert.ok(/searched before prepared scores were saved/.test(r.reasons.join()), r.reasons.join());
    assert.strictEqual(CK.assess(old, w['S w - - 0 1'].ex, w['S w - - 0 1'].cdb, D, G.SEARCH_DEFAULTS).action,
      null, 'not while it chooses by Practical alone');
  });

  console.log('\nrepertoire generator: file cache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repgen-'));
  const file = path.join(dir, 'c.jsonl');
  let ct = 1000;
  const c1 = FC.createFileCache(file, () => ct);
  await c1.put('explorer', 'k1', { total: 3 });
  await c1.put('explorer', 'k1', { total: 4 });
  fs.appendFileSync(file, '{"s":"explorer","k":"k2","t":10');     // killed mid-write
  const c2 = FC.createFileCache(file, () => ct);
  await check('a reloaded cache has the latest value, and skips a cut-off line', async () => {
    assert.deepStrictEqual(await c2.get('explorer', 'k1', 1e9), { total: 4 });
    assert.strictEqual(await c2.get('explorer', 'k2', 1e9), undefined);
  });
  ct += 5000;
  await check('  ...and expiry is the caller\'s TTL', async () =>
    assert.strictEqual(await c2.get('explorer', 'k1', 5000), undefined));
  for (let i = 0; i < 200; i++) await c2.put('chessdb', 'same', { i });
  FC.createFileCache(file, () => ct);
  await check('  ...and a file of superseded lines is compacted on load', () =>
    assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').length <= 3));
  const c3 = FC.createFileCache(file, () => ct);
  await c3.put('chessdb', 'old', { status: 'ok' });
  await c3.put('chessdb', 'ask|old', { t: ct });
  await c3.put('explorer', 'games', { total: 9 });
  let since = 0;
  const fresh = FC.withFreshChessdb(c3, () => since, () => ct);
  await check('before any check, the cache is as it was', async () =>
    assert.deepStrictEqual(await fresh.get('chessdb', 'old', 1e9), { status: 'ok' }));
  ct += 1000;
  since = ct;
  await check('after a check, ChessDB answers from before it are stale...', async () =>
    assert.strictEqual(await fresh.get('chessdb', 'old', 1e9), undefined));
  await fresh.put('chessdb', 'new', { status: 'ok' });
  ct += 1000;
  await check('  ...answers since then are not', async () =>
    assert.deepStrictEqual(await fresh.get('chessdb', 'new', 1e9), { status: 'ok' }));
  ct += 1e12;
  await check('  ...and Lichess answers and analysis requests keep their own rules', async () => {
    assert.deepStrictEqual(await fresh.get('explorer', 'games', 5000), { total: 9 });
    assert.strictEqual(await fresh.get('chessdb', 'ask|old', 5000), undefined);
  });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\nrepertoire generator: the root search');
  const RW = {
    'root w - -': { next: { Nf3: 'row b - -', c4: 'row2 b - -' } },
    'row b - -': { ex: ex(10000, [['A1', 4000], ['A2', 3000], ['A3', 200], ['A4', 800]]),
      cdb: cdb([['A1', -200], ['A2', -150], ['A3', 50], ['A9', 0]]) },
    'row2 b - -': { ex: ex(20, [['B1', 20]]), cdb: cdb([['B1', 0]]) }
  };
  const ctxs = [];
  const runRoot = R.makeRunRoot({
    providers: {
      explorer: (fen, filter, isStale, ctx) => { ctxs.push(ctx); return Promise.resolve(RW[fen] && RW[fen].ex); },
      chessdb: fen => Promise.resolve((RW[fen] && RW[fen].cdb) || { status: 'unknown', moves: [] })
    },
    filter: {},
    child: (fen, san) => RW[fen].next[san]
  });
  const rr = await runRoot('root w - -', ['Nf3', 'c4'], { opts: { maxPly: 4 }, budget: 10, shares: { Nf3: 0.6 } });
  await check('the column\'s rounds give each row its final value', () => {
    const r = rr.results.get('Nf3');
    assert.strictEqual(r.state, 'value');
    // The column's own options: risk-averse, with the plain mean beside it.
    assert.strictEqual(Number(r.mean.toFixed(1)), 65.3);
    assert.ok(r.value < r.mean, r.value);
    assert.strictEqual(r.final, true);
    assert.strictEqual(rr.results.get('c4').state, 'few');
  });
  await check('  ...and, with repgen\'s search options, a prepared split for the blend', async () => {
    const rp = await runRoot('root w - -', ['Nf3'], { opts: Object.assign({}, G.SEARCH_DEFAULTS, { maxPly: 4 }),
      budget: 10, shares: { Nf3: 0.6 } });
    const r = rp.results.get('Nf3');
    assert.ok(r.prep && Math.abs(r.prep.w + r.prep.d + r.prep.b - 1) < 1e-9, JSON.stringify(r.prep));
    assert.ok(r.prior > 0 && r.prior < 1, r.prior);
    // repgen is risk-averse like the column.
    assert.strictEqual(G.SEARCH_DEFAULTS.riskAversion, 0.05);
    assert.ok(r.value < r.mean, r.value + ' vs ' + r.mean);
  });
  await check('  ...with the row\'s share as request priority and the budget passed on', () => {
    assert.ok(ctxs.some(c => c.priority === 10 + 0.6 && c.exempt === true), JSON.stringify(ctxs));
    assert.ok(ctxs.every(c => c.budget && c.budget.limit === 10));
  });

  console.log('\nrepertoire generator: Maia');
  const M = await load('tools/repgen/maia.mjs');
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  await check('the move space: every pair of squares, then promotions to the last rank', () => {
    assert.deepStrictEqual([M.moveIndex('a1', 'b1'), M.moveIndex('a1', 'a2'), M.moveIndex('e2', 'e4'),
      M.moveIndex('h8', 'h8'), M.moveIndex('a7', 'a8', 'q'), M.moveIndex('a7', 'a8', 'n'),
      M.moveIndex('a7', 'b8', 'q'), M.moveIndex('h7', 'h8', 'n')],
    [1, 8, 796, 4095, 4096, 4099, 4100, 4351]);
    assert.strictEqual(M.MAIA_MOVES, 4352);
  });
  const ones = t => Array.from(t).reduce((a, x, i) => (x ? a.concat(i) : a), []);
  await check('the board: one piece per square, White\'s first', () => {
    const t = M.maiaTokens(START);
    assert.strictEqual(ones(t).length, 32);
    // Ra1, Ke1, Pe2, then Black's ke8.
    [0 * 12 + 3, 4 * 12 + 5, 12 * 12 + 0, 60 * 12 + 11].forEach(i => assert.strictEqual(t[i], 1, 'index ' + i));
  });
  await check('  ...and with Black to move, as Black sees it: flipped, colours swapped', () => {
    // After 1.e4 the model sees White to move against 1...e5.
    assert.deepStrictEqual(Array.from(M.maiaTokens(E4)),
      Array.from(M.maiaTokens('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')));
    assert.strictEqual(M.maiaTokens(E4)[36 * 12 + 6], 1);
  });
  const logits = (n, set) => {
    const l = new Float32Array(n * M.MAIA_MOVES);
    set.forEach(([i, v]) => { l[i] = v; });
    return l;
  };
  await check('the policy is a softmax over the legal moves alone', () => {
    // e2-e5 isn't legal: its logit counts for nothing.
    const p = M.policyFrom(START, logits(1, [[M.moveIndex('e2', 'e4'), Math.log(3)],
      [M.moveIndex('e2', 'e5'), 50]]), 0);
    assert.strictEqual(p[0].san, 'e4');
    assert.ok(Math.abs(p[0].prob - 3 / 22) < 1e-6, p[0].prob);
    assert.strictEqual(p.length, 20);
    assert.ok(Math.abs(p.reduce((a, x) => a + x.prob, 0) - 1) < 1e-6);
  });
  await check('  ...Black\'s moves are read back from the flipped board', () =>
    // 1...c5 is c2-c4 to the model.
    assert.strictEqual(M.policyFrom(E4, logits(1, [[M.moveIndex('c2', 'c4'), 5]]), 0)[0].san, 'c5'));
  await check('  ...castling and promotions for either side, at a position\'s place in a batch', () => {
    const PW = 'r3k2r/1P6/8/8/8/8/8/R3K2R w KQkq - 0 1', PB = 'r3k2r/8/8/8/8/8/1p6/R3K2R b KQkq - 0 1';
    const K = M.MAIA_MOVES;
    const l = logits(2, [[M.moveIndex('e1', 'g1'), 9], [M.moveIndex('b7', 'b8', 'q'), 8],
      [K + M.moveIndex('e1', 'g1'), 8], [K + M.moveIndex('b7', 'b8', 'q'), 9]]);
    // The new queen checks along the back rank.
    assert.deepStrictEqual(M.policyFrom(PW, l, 0).slice(0, 2).map(x => x.san), ['O-O', 'b8=Q+']);
    assert.deepStrictEqual(M.policyFrom(PB, l, K).slice(0, 2).map(x => x.san), ['b1=Q+', 'O-O']);
  });
  await check('  ...without the long tail, and empty with no legal move', () => {
    assert.deepStrictEqual(M.policyFrom(START, logits(1, [[M.moveIndex('e2', 'e4'), 12]]), 0)
      .map(x => x.san), ['e4']);
    assert.deepStrictEqual(M.policyFrom('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', logits(1, []), 0), []);
  });
  await check('Maia plays at the middle of the rating filter, as in the column', () => {
    assert.strictEqual(M.maiaEloFor([1800, 2000, 2200]), 2100);
    assert.strictEqual(M.maiaEloFor([1600, 1800, 2000, 2200, 2500]), 2150);
    assert.strictEqual(M.maiaEloFor([]), 1900);
    assert.deepStrictEqual([M.clampElo(3000), M.clampElo(100), M.clampElo(2124)], [2600, 600, 2100]);
  });

  const runs = [];
  let failNext = false;
  const mm = M.createMaia({
    maxBatch: 2,
    run: (tokens, elos, batch) => {
      runs.push({ batch, elos: Array.from(elos), tokens: tokens.length });
      if (failNext) { failNext = false; return Promise.reject(new Error('boom')); }
      return Promise.resolve(logits(batch, []));
    }
  });
  const asked = await Promise.all([mm.policy(START, 2100), mm.policy(E4, 2100), mm.policy(START, 2100),
    mm.policy(START, 1500)]);
  await check('positions asked together run as one batch, up to maxBatch', () => {
    assert.deepStrictEqual(runs.map(r => [r.batch, r.tokens]), [[2, 2 * 768], [1, 768]]);
    assert.deepStrictEqual(runs.map(r => r.elos), [[2100, 2100], [1500]]);
    assert.strictEqual(asked[0], asked[2]);     // one position and rating: asked once
    assert.strictEqual(asked[0].length, 20);
  });
  await mm.policy(E4, 2100);
  await check('  ...and what was computed is remembered', () => {
    assert.strictEqual(runs.length, 2);
    assert.deepStrictEqual(mm.counts(), { positions: 3, batches: 2 });
  });
  const KK = '8/8/8/8/8/8/8/K6k w - - 0 1';
  failNext = true;
  const boom = await mm.policy(KK, 2100).then(() => null, e => e);
  const kk = await mm.policy(KK, 2100);
  await check('  ...a failed run fails its positions, which are asked again next time', () => {
    assert.strictEqual(boom && boom.message, 'boom');
    assert.deepStrictEqual(kk.map(x => x.san).sort(), ['Ka2', 'Kb1', 'Kb2']);
  });

  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'repgen-maia-'));
  const bytes = Buffer.from('not really a model');
  const sum = require('crypto').createHash('sha256').update(bytes).digest('hex');
  let fetched = 0;
  const fakeFetch = url => {
    fetched++;
    if (/404$/.test(url)) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) });
  };
  const mfile = path.join(mdir, 'sub', 'm.onnx');
  const wrong = await M.ensureModel(mfile, { url: 'u', sha256: 'f'.repeat(64), fetch: fakeFetch })
    .then(() => null, e => e);
  await check('the model is saved only when it is the expected file', () => {
    assert.ok(/not the expected file/.test(wrong && wrong.message), String(wrong));
    assert.ok(!fs.existsSync(mfile) && !fs.existsSync(mfile + '.part'));
  });
  await M.ensureModel(mfile, { url: 'u', sha256: sum, fetch: fakeFetch });
  await M.ensureModel(mfile, { url: 'u', sha256: sum, fetch: fakeFetch });
  await check('  ...and downloaded once', () => {
    assert.strictEqual(fs.readFileSync(mfile, 'utf8'), 'not really a model');
    assert.strictEqual(fetched, 2);
  });
  const e404 = await M.ensureModel(path.join(mdir, 'n.onnx'), { url: 'x/404', fetch: fakeFetch })
    .then(() => null, e => e);
  await check('  ...and a failed download says why', () =>
    assert.ok(/HTTP 404/.test(e404 && e404.message), String(e404)));
  fs.rmSync(mdir, { recursive: true, force: true });

  const maiaAsked = [];
  const runRootM = R.makeRunRoot({
    providers: {
      explorer: fen => Promise.resolve(RW[fen] && RW[fen].ex),
      chessdb: fen => Promise.resolve((RW[fen] && RW[fen].cdb) || { status: 'unknown', moves: [] })
    },
    filter: {},
    child: (fen, san) => RW[fen].next[san],
    maia: (fen, elo) => {
      maiaAsked.push([fen, elo]);
      return Promise.resolve([{ san: 'B1', prob: 0.9 }, { san: 'B2', prob: 0.1 }]);
    }
  });
  const rm = await runRootM('root w - -', ['c4'], { opts: { maxPly: 2, maia: true, maiaElo: 2100 },
    budget: 10, shares: {} });
  const rmOff = await runRootM('root w - -', ['c4'], { opts: { maxPly: 2 }, budget: 10, shares: {} });
  await check('with Maia on, a row with too few games gets a Practical value', () => {
    const r = rm.results.get('c4');
    assert.strictEqual(r.state, 'value');
    assert.ok(r.maia > 0 && r.maia < 1, String(r.maia));
    assert.deepStrictEqual(maiaAsked[0], ['row2 b - -', 2100]);
  });
  await check('  ...and with it off, the row is as before and Maia isn\'t asked', () => {
    assert.strictEqual(rmOff.results.get('c4').state, 'few');
    assert.strictEqual(maiaAsked.length, 1);
  });

  const wm = world();
  wm['S w - - 0 1'].root = { e4: val(55, 3), d4: val(58, 3, { maia: 0.4 }) };
  const sm = G.newState('S w - - 0 1', 'w');
  const dpm = deps(wm);
  await drain(pracGen({ state: sm, deps: dpm, now: () => 0, search: { maia: true, maiaElo: 2100 } }),
    { t: 0 });
  await check('a run with Maia searches with it, and keeps its share and rating', () => {
    const o = dpm.log.roots[0].opts;
    assert.deepStrictEqual([o.maia, o.maiaElo, o.maiaUntil, o.maiaOnlyBelow, o.maiaWeight],
      [true, 2100, 100, 10, 20]);
    const n = sm.nodes['S w - -'];
    assert.deepStrictEqual([n.move, n.maia, n.maiaElo], ['d4', 0.4, 2100]);
    assert.strictEqual(n.rows.find(r => r.san === 'd4').maia, 0.4);
    assert.strictEqual(N['S w - -'].maiaElo, undefined);
  });
  await check('  ...the PGN says how much of the value is Maia\'s, and pgnclean drops it', () => {
    const b = PG.toPgn(sm).split('\n\n')[1].replace(/\n/g, ' ');
    assert.ok(b.startsWith('1. d4 {Prac 58.0 d3, 40% Maia, engine '), b);
    assert.strictEqual(CL.cleanComment('Prac 58.0 d3, 40% Maia, engine 52.1; e4 55.0'), null);
  });

  const mopts = Object.assign({}, G.SEARCH_DEFAULTS, { maia: true });
  const fn = Object.assign({}, sf.nodes['S w - -']);     // e4 won on 5 games, without Maia
  const reasons = (n, so) => CK.assess(n, wf['S w - - 0 1'].ex, wf['S w - - 0 1'].cdb, D, so).reasons.join('; ');
  await check('a check with Maia on searches again where a search without it had thin moves', () => {
    assert.strictEqual(CK.assess(fn, wf['S w - - 0 1'].ex, wf['S w - - 0 1'].cdb, D, mopts).action, 'recheck');
    assert.ok(/searched without Maia, and 1 move has under 100 games/.test(reasons(fn, mopts)), reasons(fn, mopts));
    assert.ok(/2 moves have under 100 games/.test(reasons(Object.assign({}, fn, { games: 60 }), mopts)));
  });
  await check('  ...but not with Maia off, nor where the search had it', () => {
    assert.ok(!/Maia/.test(reasons(fn, G.SEARCH_DEFAULTS)), reasons(fn, G.SEARCH_DEFAULTS));
    assert.ok(!/Maia/.test(reasons(Object.assign({}, fn, { maiaElo: 2100 }), mopts)));
    assert.ok(!/Maia/.test(reasons(Object.assign({}, N['S w - -']), mopts)));
  });

  console.log('\nrepertoire generator: risk aversion');
  const rn = sn.nodes['S w - -'];                 // e4 and d4 valued, searched by default
  const lin = Object.assign({}, G.SEARCH_DEFAULTS, { riskAversion: 0 });
  const plain = Object.assign({}, rn);
  delete plain.risk;
  const rreasons = (n, so) => CK.assess(n, wn['S w - - 0 1'].ex, wn['S w - - 0 1'].cdb, D, so).reasons.join('; ');
  await check('a run searches risk-averse by default, and its nodes say with what', () => {
    assert.strictEqual(rn.risk, 0.05);
    assert.strictEqual(dp.log.roots[0].opts.riskAversion, 0.05);
  });
  await check('  ...and a search with plain means saves none', async () => {
    const s0 = G.newState('S w - - 0 1', 'w');
    await drain(pracGen({ state: s0, deps: deps(wn), now: () => 0, search: { riskAversion: 0 } }), { t: 0 });
    assert.strictEqual(s0.nodes['S w - -'].risk, undefined);
  });
  await check('a check searches again where the run\'s risk aversion differs from the search\'s', () => {
    assert.ok(/searched with risk aversion 0, the run now uses 0.05/.test(rreasons(plain, G.SEARCH_DEFAULTS)),
      rreasons(plain, G.SEARCH_DEFAULTS));
    assert.ok(/searched with risk aversion 0.05, the run now uses 0$/.test(rreasons(rn, lin)), rreasons(rn, lin));
    assert.strictEqual(CK.assess(plain, wn['S w - - 0 1'].ex, wn['S w - - 0 1'].cdb, D, G.SEARCH_DEFAULTS).action,
      'recheck');
  });
  await check('  ...but not where they agree, nor with a single valued row', () => {
    assert.ok(!/risk/.test(rreasons(rn, G.SEARCH_DEFAULTS)), rreasons(rn, G.SEARCH_DEFAULTS));
    assert.ok(!/risk/.test(rreasons(plain, lin)), rreasons(plain, lin));
    const one = Object.assign({}, plain, { rows: plain.rows.filter(r => r.san === rn.move) });
    assert.ok(!/risk/.test(rreasons(one, G.SEARCH_DEFAULTS)), rreasons(one, G.SEARCH_DEFAULTS));
  });
};
