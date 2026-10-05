/*
 * deeprep (tools/deeprep.mjs): the fenced index reader against explorerdb's own, the deep
 * score on a hand-checked index, and the search against a plain recursive version (chess.js
 * move() and FEN keys, no hashes or memo) on a random one. Called from test/harness.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert');

const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

function rng(seed) {
  let s = seed >>> 0;
  return n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

const RES = ['1-0', '1/2-1/2', '0-1'];

function pgnOf(games) {
  return games.map((g, i) => [
    '[Event "Rated game"]', `[Site "https://lichess.org/d${i}"]`, `[Result "${g.res}"]`,
    '[WhiteElo "2000"]', '[BlackElo "2000"]', '[TimeControl "300+0"]', '',
    g.sans.map((m, j) => (j % 2 ? '' : `${j / 2 + 1}. `) + m).join(' ') + ' ' + g.res, '', ''].join('\n')).join('');
}

module.exports = async function run(check) {
  const G = await load('tools/explorerdb/games.mjs');
  const S = await load('tools/explorerdb/store.mjs');
  const I = await load('tools/explorerdb/importer.mjs');
  const F = await load('tools/explorerdb/fence.mjs');
  const D = await load('tools/deeprep/search.mjs');
  const P = await load('tools/deeprep/pgn.mjs');
  const E = await load('tools/deeprep/evaluate.mjs');
  const B = await load('tools/deeprep/build.mjs');
  const R = await load('tools/deeprep/report.mjs');
  const SL = await load('tools/deeprep/slice.mjs');
  const T = await load('tools/repgen/pgntree.mjs');
  const C = await load('tools/repgen/clean.mjs');
  const PE = await load('src/pe/search.js');
  const { Chess } = await load('src/vendor/chess.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-deep-'));
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
  // pgnclean on a PGN deeprep wrote: the comments left that are neither a share nor where a
  // line transposes, which should be none.
  const leftAfterClean = (pgn, side) => {
    const [g] = T.parsePgn(pgn);
    C.cleanGame(g, side);
    const left = [];
    const walk = nd => {
      [nd.comment, nd.pre].forEach(c => c && c.split(/\n\n/).forEach(x => {
        if (!/^\d+%$/.test(x) && !/^(\S+ t|T)ransposes into /.test(x)) left.push(x);
      }));
      nd.children.forEach(walk);
    };
    walk(g.root);
    return left;
  };
  // The plain expectimax: no shrinkage, plain means at their moves.
  const PLAIN = { prior: 0, risk: 0 };
  // riskMean, written out: the certainty equivalent at lambda per win% point (values 0-1).
  const ce = (items, lambda) => {
    const sw = items.reduce((t, x) => t + x.w, 0);
    if (!lambda) return items.reduce((t, x) => t + x.w * x.v, 0) / sw;
    const lo = Math.min(...items.map(x => x.v));
    return lo - Math.log(items.reduce((t, x) => t + x.w * Math.exp(-lambda * 100 * (x.v - lo)), 0) / sw) / (lambda * 100);
  };

  /* --- a hand-checked index ---------------------------------------------- */
  const hand = [];
  const add = (line, w, d, b) => {
    const sans = line.split(' ');
    for (let i = 0; i < w; i++) hand.push({ sans, res: '1-0' });
    for (let i = 0; i < d; i++) hand.push({ sans, res: '1/2-1/2' });
    for (let i = 0; i < b; i++) hand.push({ sans, res: '0-1' });
  };
  add('e4 e5 Nf3', 8, 0, 2);      // 0.8
  add('e4 e5 Bc4', 2, 0, 8);      // 0.2
  add('e4 c5 Nf3', 10, 10, 0);    // 0.75
  add('d4 d5 c4', 18, 0, 12);     // 0.6
  const handFile = path.join(tmp, 'hand.pgn');
  fs.writeFileSync(handFile, pgnOf(hand));
  const handIdx = path.join(tmp, 'hand.xdb');
  await I.importDump({ input: handFile, out: handIdx, plies: 10, minGames: 1, workers: 1 });
  const hdb = F.openFenced(handIdx, { block: 4 });
  const START = new Chess().fen();

  console.log('\ndeeprep: the deep score');
  await check('my move takes my best reply, theirs averages by games played', () => {
    const s = D.createSearch(hdb, START, { plies: 3, minGames: 2, ...PLAIN });
    assert.strictEqual(s.side, 'w');
    near(s.value().s, 0.775, 'root');                 // e4: 1/2 x 0.8 + 1/2 x 0.75
    const op = s.candidates();
    assert.deepStrictEqual(op.list.map(x => x.san), ['e4', 'd4']);
    near(op.list[0].s, 0.775, 'e4');
    near(op.list[0].raw, 0.625, 'e4 raw');            // (20 + 10/2) / 40
    near(op.list[1].s, 0.6, 'd4');
    assert.strictEqual(op.list[0].games, 40);
  });
  await check('a position whose moves have too few games is a leaf at its own score', () => {
    // After 1.e4 e5 (20 games) neither Nf3 nor Bc4 has 15: that position scores 0.5.
    const s = D.createSearch(hdb, START, { plies: 3, minGames: 15, ...PLAIN });
    near(s.candidates().list[0].s, 0.5 * 0.5 + 0.5 * 0.75, 'e4');
  });
  await check('the horizon: at 1 ply each move is its own games', () => {
    const op = D.createSearch(hdb, START, { plies: 1, minGames: 2, ...PLAIN }).candidates();
    near(op.list[0].s, 0.625, 'e4');
    near(op.list[1].s, 0.6, 'd4');
  });
  await check('Black\'s side scores the same games from the other end', () => {
    const s = D.createSearch(hdb, START, { plies: 3, minGames: 2, side: 'b', ...PLAIN });
    // White is the opponent now: the root averages by games played. After 1.e4 Black
    // chooses: e5 (then White's Nf3 and Bc4 average 0.5 for Black) over c5 (0.25).
    const op = s.candidates();
    assert.strictEqual(op.mine, false);
    assert.deepStrictEqual(op.list.map(x => x.san), ['e4', 'd4']);
    near(op.list[0].s, 0.5, 'e4 for Black');
    near(op.list[1].s, 0.4, 'd4 for Black');
    near(s.value().s, (40 * 0.5 + 30 * 0.4) / 70, 'root for Black');
  });

  await check('risk aversion: a position whose reply is a coin of 20% and 80% is worth less than 50%', () => {
    // For Black after 1.e4 e5, White's Nf3 (10 games) scores 20% for Black and Bc4 80%.
    const c = new Chess();
    c.move('e4');
    c.move('e5');
    const plain = D.createSearch(hdb, c.fen(), { plies: 2, minGames: 2, side: 'b', ...PLAIN });
    near(plain.value().s, 0.5, 'plain mean');
    const ra = D.createSearch(hdb, c.fen(), { plies: 2, minGames: 2, side: 'b', prior: 0, risk: 0.05 });
    near(ra.value().s, ce([{ w: 10, v: 0.2 }, { w: 10, v: 0.8 }], 0.05), 'certainty equivalent');
    assert.ok(ra.value().s < 0.33 && ra.value().s > 0.32, String(ra.value().s));
  });
  await check('shrinkage: my move\'s value is pulled towards the position\'s score by its SE', () => {
    // After 1.e4 e5 White picks between Nf3 (0.8) and Bc4 (0.2), 10 games each, in a
    // position that scores 0.5.
    const c = new Chess();
    c.move('e4');
    c.move('e5');
    const at = prior => D.createSearch(hdb, c.fen(), { plies: 2, minGames: 2, prior, risk: 0 });
    near(at(0).value().s, 0.8, 'no prior');
    const L = D.leafStat(10, 0, 10, 'w');
    const nf3 = D.leafStat(8, 0, 2, 'w');
    const vr = L.se * L.se * L.n;
    const n = vr / (nf3.se * nf3.se);
    for (const k of [5, 50, 500]) {
      const w = n / (n + k);
      near(at(k).value().s, 0.5 + w * 0.3, 'prior ' + k);
      near(at(k).value().se, nf3.se, 'SE at prior ' + k);
    }
    assert.ok(Math.abs(at(1e9).value().s - 0.5) < 1e-6, 'an endless prior leaves the position\'s own score');
    // The candidates table shows the shrunk values, the raw ones beside them.
    const op = at(50).candidates();
    assert.deepStrictEqual(op.list.map(x => x.san), ['Nf3', 'Bc4']);
    near(op.list[0].s, at(50).value().s, 'table = value');
    near(op.list[0].raw, 0.8, 'raw');
    near(op.raw, 0.5, 'the position\'s own score');
  });

  add('c4 e5 Nc3', 3, 0, 0);       // few games, all won
  const handFile2 = path.join(tmp, 'hand2.pgn');
  fs.writeFileSync(handFile2, pgnOf(hand));
  const handIdx2 = path.join(tmp, 'hand2.xdb');
  await I.importDump({ input: handFile2, out: handIdx2, plies: 10, minGames: 1, workers: 1 });
  const hdb2 = F.openFenced(handIdx2, { fenceFile: false });
  const pull = [];
  const addP = (line, w, b) => {
    for (let i = 0; i < w; i++) pull.push({ sans: line.split(' '), res: '1-0' });
    for (let i = 0; i < b; i++) pull.push({ sans: line.split(' '), res: '0-1' });
  };
  addP('e4 e5', 260, 140);
  addP('c4 e5', 4, 0);
  addP('d4 d5', 300, 300);
  const pullFile = path.join(tmp, 'pull.pgn');
  fs.writeFileSync(pullFile, pgnOf(pull));
  const pullIdx = path.join(tmp, 'pull.xdb');
  await I.importDump({ input: pullFile, out: pullIdx, plies: 10, minGames: 1, workers: 1 });
  const pdb = F.openFenced(pullIdx, { fenceFile: false });
  await check('shrinkage: 4 won games lose their lead to 400 scoring 65%', () => {
    const op = prior => D.createSearch(pdb, START, { plies: 1, minGames: 2, prior, risk: 0 })
      .candidates().list.map(x => x.san);
    assert.deepStrictEqual(op(0), ['c4', 'e4', 'd4']);
    assert.deepStrictEqual(op(200), ['e4', 'c4', 'd4']);
  });
  await check('fit: tau from the candidates\' spread less their noise, prior = var / tau^2', () => {
    // Only the start position has two moves with 50 games: e4 (65%, 400) and d4 (50%, 600).
    const f = D.fitPrior(pdb, START, { samples: 5, minGames: 50, rnd: () => 0.5 });
    assert.strictEqual(f.positions, 1);
    assert.strictEqual(f.moves, 2);
    const a = D.leafStat(260, 0, 140, 'w'), b = D.leafStat(300, 0, 300, 'w');
    const wa = 1 / a.se ** 2, wb = 1 / b.se ** 2;
    const m = (wa * a.s + wb * b.s) / (wa + wb);
    const q = wa * (a.s - m) ** 2 + wb * (b.s - m) ** 2;
    const tau2 = (q - 1) / (wa + wb - (wa * wa + wb * wb) / (wa + wb));
    near(f.tau, Math.sqrt(tau2), 'tau');
    const vr = (a.se ** 2 * a.n + b.se ** 2 * b.n) / 2;
    near(f.prior, vr / tau2, 'prior');
    assert.ok(f.prior > 20 && f.prior < 80, String(f.prior));
    // For Black only: no position of Black's has two candidates.
    assert.strictEqual(D.fitPrior(pdb, START, { samples: 5, minGames: 50, side: 'b' }).positions, 0);
  });
  await check('the tree keeps the best lower bound beside the best score', () => {
    const s = D.createSearch(hdb2, START, { plies: 3, minGames: 2, z: 2, ...PLAIN });
    const t = s.tree({ replyShare: 0.05, minReach: 0.01 });
    assert.deepStrictEqual(t.children.map(k => [k.san, k.tag]), [['c4', 'best'], ['e4', 'safe']]);
    assert.deepStrictEqual(t.children[0].alts.map(a => a.san), ['d4']);
    assert.strictEqual(t.children[1].alts, undefined);
    near(t.children[0].s, 1, 'c4');
    const e4 = t.children[1];
    // Equal shares: most played first, then by move code (e7e5 before c7c5).
    assert.deepStrictEqual(e4.children.map(k => k.san), ['c5', 'e5']);
    near(e4.children[1].share, 0.5, 'e5 share');
    assert.deepStrictEqual(e4.children[1].children.map(k => [k.san, k.tag]), [['Nf3', 'best']]);
    assert.strictEqual(e4.children[1].children[0].alts[0].san, 'Bc4');
    // Without the safe move: only c4.
    assert.deepStrictEqual(s.tree({ keepSafe: false }).children.map(k => k.san), ['c4']);
    // Rare replies aren't prepared for: at 60% only e5/c5 (50% each) drop out.
    const t2 = s.tree({ replyShare: 0.6, keepSafe: false, keep: 2 });
    const e4b = t2.children.find(k => k.san === 'e4');
    assert.deepStrictEqual(e4b.children, []);
    near(e4b.other, 1, 'not covered');
  });
  // Replies with distinct shares, and a second opponent decision after 1.e4 e5 2.Nf3.
  const cov = [];
  const addC = (line, w, b) => {
    for (let i = 0; i < w; i++) cov.push({ sans: line.split(' '), res: '1-0' });
    for (let i = 0; i < b; i++) cov.push({ sans: line.split(' '), res: '0-1' });
  };
  addC('e4 e5 Nf3 Nc6 Bb5', 30, 10);   // after 2.Nf3: Nc6 40/60, d6 15/60, Nf6 5/60
  addC('e4 e5 Nf3 d6 d4', 10, 5);
  addC('e4 e5 Nf3 Nf6 Nxe5', 3, 2);
  addC('e4 c5 Nf3', 15, 10);           // after 1.e4: e5 60%, c5 25%, e6 10%, d5 5%
  addC('e4 e6 d4', 5, 5);
  addC('e4 d5 exd5', 3, 2);
  const covFile = path.join(tmp, 'cov.pgn');
  fs.writeFileSync(covFile, pgnOf(cov));
  const covIdx = path.join(tmp, 'cov.xdb');
  await I.importDump({ input: covFile, out: covIdx, plies: 10, minGames: 1, workers: 1 });
  const cdb = F.openFenced(covIdx, { fenceFile: false });
  await check('coverage: replies most played first until they cover the share, less each decision', () => {
    const s = D.createSearch(cdb, START, { plies: 6, minGames: 2, ...PLAIN });
    const replies = (t) => {
      const e4 = t.children[0];
      const nf3 = e4.children.find(k => k.san === 'e5').children[0];
      return [e4.children.map(k => k.san), nf3.children.map(k => k.san), e4, nf3];
    };
    // Without coverage: every reply played 5% of the time, d5 included.
    assert.deepStrictEqual(replies(s.tree({}))[0], ['e5', 'c5', 'e6', 'd5']);
    // 90%: e5 + c5 = 85%, so e6 too (95%); then 80% after 2.Nf3: Nc6 67%, so d6 too (92%).
    let [first, second, e4, nf3] = replies(s.tree({ coverage: 0.9 }));
    assert.deepStrictEqual(first, ['e5', 'c5', 'e6']);
    assert.deepStrictEqual(second, ['Nc6', 'd6']);
    near(e4.other, 0.05, 'not covered at the first decision');
    near(nf3.other, 5 / 60, 'at the second');
    // Under --single-below at the second decision (80% < 85%): the top reply only.
    [first, second] = replies(s.tree({ coverage: 0.9, singleBelow: 0.85 }));
    assert.deepStrictEqual(first, ['e5', 'c5', 'e6']);
    assert.deepStrictEqual(second, ['Nc6']);
    // A bigger step: 90% then 60%, which Nc6 alone covers.
    assert.deepStrictEqual(replies(s.tree({ coverage: 0.9, coverageStep: 0.3 }))[1], ['Nc6']);
    // minReach still holds for the others, never for the top reply: c5 reaches 25%, e6
    // 10%, d6 15%.
    [first, second] = replies(s.tree({ coverage: 0.9, minReach: 0.2 }));
    assert.deepStrictEqual(first, ['e5', 'c5']);
    assert.deepStrictEqual(second, ['Nc6']);
    assert.deepStrictEqual(replies(s.tree({ coverage: 0.9, minReach: 0.7 }))[0], ['e5']);
  });
  await check('dumpsOf reads an accumulator\'s list, a merge\'s sources and an import\'s', () => {
    assert.deepStrictEqual(P.dumpsOf({ source: '2 dumps', report: { dumps: ['a.zst', 'b.zst'] } }), ['a.zst', 'b.zst']);
    // explorerdb merge: `source` is only a summary, the inputs are in `merged`.
    assert.deepStrictEqual(P.dumpsOf({ source: 'merge of 3 sources: a.zst, b.zst + c.zst', report: {},
      merged: [{ source: 'a.zst' }, { source: 'b.zst + c.zst' }] }), ['a.zst', 'b.zst', 'c.zst']);
    assert.deepStrictEqual(P.dumpsOf({ source: 'a.zst + b.zst', report: {} }), ['a.zst', 'b.zst']);
    assert.deepStrictEqual(P.dumpsOf(null), []);
  });
  await check('a root where they move gets one comment, which chess.js reads back', () => {
    const c = new Chess();
    c.move('e4');
    const s = D.createSearch(cdb, c.fen(), { plies: 5, minGames: 2, side: 'w', ...PLAIN });
    const pgn = P.toPgn(s.tree({ coverage: 0.9 }), { prefix: ['e4'], rootComment: 'deep for White' });
    const body = pgn.split('\n\n')[1].replace(/\s+/g, ' ');
    assert.ok(/^1\. e4 \{deep for White; replies not covered 5%\} 1\.\.\. e5/.test(body), body);
    const back = new Chess();
    back.loadPgn(pgn);
    assert.strictEqual(back.history()[0], 'e4');
  });

  await check('the PGN has the chosen moves, the safe one as a variation, numbers in comments', () => {
    const s = D.createSearch(hdb2, START, { plies: 3, minGames: 2, z: 2, ...PLAIN });
    const pgn = P.toPgn(s.tree({}), { prefix: [] });
    const body = pgn.split('\n\n')[1].replace(/\s+/g, ' ');
    assert.ok(/^1\. c4 \{deep 100\.0% ±[\d.]+, raw 100\.0%, 3 games; also d4 60\.0%/.test(body), body);
    assert.ok(/\(1\. e4 \{best lower bound; deep 77\.5%/.test(body), body);
    assert.ok(/\(1\.\.\. e5 \{50% of 40 games, deep 80\.0%/.test(body), body);
    assert.ok(/2\. Nf3 \{deep 80\.0%[^}]*also Bc4 20\.0%/.test(body), body);
    assert.ok(/ 1\.\.\. c5 \{50% of 40 games, deep 75\.0%/.test(body), body);
    // Parsed back by chess.js, the main line is c4 and then the variations hold.
    const c = new Chess();
    c.loadPgn(pgn);
    assert.deepStrictEqual(c.history(), ['c4', 'e5', 'Nc3']);
  });
  await check('pgnclean takes the search\'s PGN down to the shares of their replies', () => {
    const s = D.createSearch(hdb2, START, { plies: 3, minGames: 2, z: 2, ...PLAIN });
    const pgn = P.toPgn(s.tree({ coverage: 0.9 }), { prefix: [], rootComment: 'deep 77.5% for White, 1,234 games' });
    assert.ok(/best lower bound; deep/.test(pgn) && /% of 40 games, deep/.test(pgn), pgn);
    assert.deepStrictEqual(leftAfterClean(pgn, 'w'), []);
    const [g] = T.parsePgn(pgn);
    C.cleanGame(g, 'w');
    const e4 = g.root.children.find(x => x.san === 'e4');
    assert.deepStrictEqual(e4.children.map(x => x.comment), ['50%', '50%']);
    assert.strictEqual(g.root.children[0].children[0].comment, null, '1.c4 e5: the only reply');
  });

  /* --- eval: a repertoire as a fixed policy ------------------------------ */
  console.log('\ndeeprep: a repertoire\'s score (eval)');
  const afterE4 = (() => { const c = new Chess(); c.move('e4'); return c.fen(); })();
  await check('eval: my moves as the PGN plays them, every reply by its games', () => {
    const rep = E.repertoireFromPgn('[White "Repertoire"]\n\n1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *');
    assert.strictEqual(rep.side, 'w');
    assert.strictEqual(rep.root, afterE4, 'the root: after the opening run of single moves');
    assert.deepStrictEqual(rep.prefix, ['e4']);
    assert.strictEqual(rep.moves.size, 3);
    const r = E.evaluateRepertoire(hdb, rep, { minGames: 5 });
    near(r.s, 0.5 * 0.8 + 0.5 * 0.75, 'score');
    near(r.raw, 0.625, 'what everyone scored from there');
    assert.strictEqual(r.games, 40);
    assert.strictEqual(r.cards, 2);
    near(r.ends.over, 1, 'every game ends inside the repertoire');
    near(r.ends.out + r.ends.end, 0, 'nothing out of book');
    assert.deepStrictEqual(r.first.map(f => [f.san, f.share]), [['c5', 0.5], ['e5', 0.5]]);
    near(r.first.find(f => f.san === 'e5').s, 0.8, 'after e5');
    near(r.first.find(f => f.san === 'e5').raw, 0.5, 'people after e5');
    assert.deepStrictEqual(r.weak, []);
  });
  await check('eval: an unprepared reply leaves the book at its own score; a weak move is listed', () => {
    const rep = E.repertoireFromPgn('1. e4 e5 2. Bc4 *', { side: 'w', root: afterE4 });
    const r = E.evaluateRepertoire(hdb, rep, { minGames: 5 });
    near(r.s, 0.5 * 0.2 + 0.5 * 0.75, 'score');
    near(r.ends.out, 0.5, 'c5 is out of book');
    assert.deepStrictEqual(r.unprepared.map(u => [u.san, u.reach]), [['c5', 0.5]]);
    near(r.unprepared[0].score, 0.75, 'people after c5');
    assert.strictEqual(r.weak.length, 1);
    assert.deepStrictEqual([r.weak[0].san, r.weak[0].alt, r.weak[0].altGames], ['Bc4', 'Nf3', 10]);
    near(r.weak[0].gap, 0.6, 'Nf3 scores 60 points more');
  });
  await check('eval: a move the index has no games for ends the line at the position\'s score', () => {
    const rep = E.repertoireFromPgn('1. e4 e5 2. d4 (2. Nf3) *', { side: 'w', root: afterE4 });
    assert.strictEqual(rep.alternatives, 1);
    const r = E.evaluateRepertoire(hdb, rep, { minGames: 5 });
    assert.deepStrictEqual(r.unseen.map(u => u.san), ['d4']);
    near(r.s, 0.5 * 0.5 + 0.5 * 0.75, 'score');
    near(r.ends.end, 0.5, 'a line end');
  });
  const tr = [];
  const addT = (line, w, b) => {
    for (let i = 0; i < w; i++) tr.push({ sans: line.split(' '), res: '1-0' });
    for (let i = 0; i < b; i++) tr.push({ sans: line.split(' '), res: '0-1' });
  };
  addT('d4 d5 Nf3 Nf6', 6, 4);
  addT('Nf3 d5 d4 Nf6', 2, 8);
  addT('d4 d5 c4 e6', 5, 5);
  const trFile = path.join(tmp, 'tr.pgn');
  fs.writeFileSync(trFile, pgnOf(tr));
  const trIdx = path.join(tmp, 'tr.xdb');
  await I.importDump({ input: trFile, out: trIdx, plies: 10, minGames: 1, workers: 1 });
  const tdb = F.openFenced(trIdx, { fenceFile: false });
  await check('eval: a reply that transposes into the repertoire goes on there, its reach summed', () => {
    const pgn = '[Black "Repertoire"]\n\n1. d4 d5 2. Nf3 (2. c4 e6) 2... Nf6 *\n\n[Black "Repertoire"]\n\n1. Nf3 d5 *\n';
    const rep = E.repertoireFromPgn(pgn, { root: START });
    assert.strictEqual(rep.side, 'b');
    const r = E.evaluateRepertoire(tdb, rep, { minGames: 5 });
    near(r.s, (20 * (0.5 * 0.6 + 0.5 * 0.5) + 10 * 0.6) / 30, 'score');
    assert.strictEqual(r.cards, 4);
    near(r.ends.over, 1, 'all inside');
    assert.strictEqual(r.unreached, 0);
    // A move that never comes up in these games is a card not reached.
    const r2 = E.evaluateRepertoire(tdb, E.repertoireFromPgn(pgn + '\n[Black "Repertoire"]\n\n1. e4 e5 *\n', { root: START }));
    assert.strictEqual(r2.unreached, 1);
  });

  /* --- build: the repertoire builder -------------------------------------- */
  console.log('\ndeeprep: build');
  const mkIdx = async (name, lines) => {
    const gs = [];
    lines.forEach(([line, w, d, b]) => {
      for (let i = 0; i < w; i++) gs.push({ sans: line.split(' '), res: '1-0' });
      for (let i = 0; i < d; i++) gs.push({ sans: line.split(' '), res: '1/2-1/2' });
      for (let i = 0; i < b; i++) gs.push({ sans: line.split(' '), res: '0-1' });
    });
    const f = path.join(tmp, name + '.pgn');
    fs.writeFileSync(f, pgnOf(gs));
    const x = path.join(tmp, name + '.xdb');
    await I.importDump({ input: f, out: x, plies: 12, minGames: 1, workers: 1 });
    return F.openFenced(x, { fenceFile: false });
  };
  // 1.e4 is a trap: 40% answer 1...f6?? and lose, the rest play 1...e5 at 50%. 1.d4 d5 is 58%.
  const trapDb = await mkIdx('trap', [['e4 e5', 30, 0, 30], ['e4 f6', 38, 0, 2], ['d4 d5', 58, 0, 42]]);
  const fenAfter = (...sans) => { const c = new Chess(); sans.forEach(m => c.move(m)); return c.fen(); };
  const fakeCdb = answers => fen => {
    const a = answers[PE.fenKey(fen)];
    return Promise.resolve(a ? { status: 'ok', moves: a.map(([san, score]) => ({ san, score })) } : { status: 'unknown', moves: [] });
  };
  const trapCdb = {
    [PE.fenKey(START)]: [['e4', 30], ['d4', 30]],
    [PE.fenKey(fenAfter('e4'))]: [['e5', 0], ['f6', -300]],
    [PE.fenKey(fenAfter('d4'))]: [['d5', -50]]
  };
  const BASE = { plies: 2, minGames: 10, prior: 0, risk: 0, weights: [0, 0, 1], learnCost: 0, passes: 0 };
  const build = async (db, cfg, cdb, extra) => {
    const b = B.createBuilder(db, Object.assign({ root: START, side: 'w', config: Object.assign({}, BASE, cfg),
      chessdb: cdb ? fakeCdb(cdb) : null }, extra || {}));
    await b.run();
    return b;
  };
  const rootOf = b => b.nodes.get(b.rootKey);
  await check('replyCheck: Prac d1, the sound value over replies that aren\'t blunders, the trap share', () => {
    const rp = D.createSearch(trapDb, fenAfter('e4'), { plies: 1, minGames: 10, side: 'w', ...PLAIN }).candidates();
    const cdbA = { status: 'ok', moves: [{ san: 'e5', score: 0 }, { san: 'f6', score: -300 }] };
    const r = B.replyCheck(cdbA, fenAfter('e4'), 'w', rp, { blunder: 8, risk: 0 });
    near(r.prac, (60 * 50 + 40 * PE.winFromCp(300)) / 100, 'Prac d1');
    near(r.sound, 50, 'sound: after e5 only');
    near(r.trap, 0.4, 'f6 is a blunder, 40% of the games');
    assert.strictEqual(r.refute, 'e5');
    // Risk-averse Prac, and nothing without ChessDB.
    assert.ok(B.replyCheck(cdbA, fenAfter('e4'), 'w', rp, { blunder: 8, risk: 0.05 }).prac < r.prac);
    assert.strictEqual(B.replyCheck({ status: 'unknown' }, fenAfter('e4'), 'w', rp, { blunder: 8 }).sound, null);
  });
  await check('build: a trap whose sound value is under the other move\'s is left out', async () => {
    let b = await build(trapDb, { soundMargin: 3 }, trapCdb);
    const r = rootOf(b);
    assert.strictEqual(r.move, 'd4');
    const e4 = r.cands.find(c => c.san === 'e4');
    assert.strictEqual(e4.out, 'unsound');
    near(e4.deep, 68, 'e4 deep');
    near(e4.sound, 50, 'e4 sound');
    assert.deepStrictEqual(R.flagsOf(r, b.config).filter(f => f === 'trap'), ['trap']);
    // Without the check the trap wins on its deep score.
    b = await build(trapDb, { soundMargin: 0 }, trapCdb);
    assert.strictEqual(rootOf(b).move, 'e4');
  });
  await check('build: the sound value is shrunk like the deep score, so a lucky thin move can\'t make others unsound', async () => {
    // 1.e4 e5 is 50% on 400 games; 1.d4 d5 65% on 20. Neither has a blunder to fall for.
    const luckDb = await mkIdx('luck', [['e4 e5', 200, 0, 200], ['d4 d5', 13, 0, 7]]);
    const luckCdb = { [PE.fenKey(START)]: [['e4', 30], ['d4', 30]], [PE.fenKey(fenAfter('e4'))]: [['e5', 0]],
      [PE.fenKey(fenAfter('d4'))]: [['d5', 0]] };
    let b = await build(luckDb, { soundMargin: 3, prior: 200 }, luckCdb);
    let d4 = rootOf(b).cands.find(c => c.san === 'd4'), e4 = rootOf(b).cands.find(c => c.san === 'e4');
    near(d4.sound, d4.deep, 'd4: sound pulled as far as its deep score');
    assert.ok(d4.sound < 55, 'not its 65% of 20 games');
    assert.strictEqual(e4.out, undefined, 'e4 stays in');
    // Unshrunk, d4's 65 put e4's 50 out as "unsound".
    b = await build(luckDb, { soundMargin: 3, prior: 0 }, luckCdb);
    near(rootOf(b).cands.find(c => c.san === 'd4').sound, 65, 'prior 0: unshrunk');
    assert.strictEqual(rootOf(b).cands.find(c => c.san === 'e4').out, 'unsound');
    luckDb.close();
  });
  await check('build: the loss limit, with an eval from the position after a move ChessDB doesn\'t list', async () => {
    let b = await build(trapDb, { soundMargin: 0 }, Object.assign({}, trapCdb, { [PE.fenKey(START)]: [['e4', -200], ['d4', 30]] }));
    assert.strictEqual(rootOf(b).move, 'd4');
    assert.strictEqual(rootOf(b).cands.find(c => c.san === 'e4').out, 'max-loss');
    // ChessDB lists only d4 at the start, but after 1.e4 its best reply leaves me at -2.00.
    b = await build(trapDb, { soundMargin: 0 }, Object.assign({}, trapCdb, {
      [PE.fenKey(START)]: [['d4', 30]], [PE.fenKey(fenAfter('e4'))]: [['e5', 200], ['f6', -300]] }));
    const e4 = rootOf(b).cands.find(c => c.san === 'e4');
    near(e4.engine, PE.winFromCp(-200), 'e4 valued after their best reply');
    assert.strictEqual(e4.out, 'max-loss');
    // A move ChessDB knows nothing about, here or after it, passes the limit but is flagged.
    b = await build(trapDb, { soundMargin: 0 }, { [PE.fenKey(START)]: [['d4', 300]] });
    assert.strictEqual(rootOf(b).move, 'e4');
    assert.ok(R.flagsOf(rootOf(b), b.config).includes('no-eval'));
    // Without ChessDB nothing is checked: the deep score decides.
    b = await build(trapDb, {}, null);
    assert.strictEqual(rootOf(b).move, 'e4');
    assert.strictEqual(rootOf(b).cands[0].engine, null);
  });
  // After 1.d4 the repertoire meets 1...d5 2.Nf3 Nf6 first; at 1...Nf6, 2.Nf3 d5 goes there
  // too, while 2.c4 e6 3.Nc3 is a new line that scores a little better.
  const lines = (d5, nf6) => [['d4 d5 Nf3 Nf6 e3', d5 / 2, 0, d5 / 2], ['d4 Nf6 Nf3 d5 e3', nf6 / 4, 0, nf6 / 4],
    ['d4 Nf6 c4 e6 Nc3', nf6 / 4 + 1, 0, nf6 / 4 - 1]];
  const trDb1 = await mkIdx('learn1', lines(120, 80));
  const LEARN = { plies: 4, minGames: 10, coverage: 1, singleBelow: 0, minReach: 0, lineMinReach: 0 };
  await check('build: the learning cost takes a move into known positions over a new line that scores more', async () => {
    let b = await build(trDb1, Object.assign({ learnCost: 0 }, LEARN));
    const at = b => b.nodes.get(String(G.keyOf(fenAfter('d4', 'Nf6'))));
    assert.strictEqual(at(b).move, 'c4');
    b = await build(trDb1, Object.assign({ learnCost: 200 }, LEARN));
    const n = at(b);
    assert.strictEqual(n.move, 'Nf3');
    assert.strictEqual(n.why, 'learn');
    const nf3 = n.cands.find(c => c.san === 'Nf3'), c4 = n.cands.find(c => c.san === 'c4');
    near(nf3.newShare, 0, 'Nf3 goes into the line after 1...d5');
    near(c4.newShare, 1, 'c4 is all new');
    near(n.reach, 0.4, 'reach');
    near(c4.deep - nf3.deep, 2.5, 'c4 scores 2.5 more');
    near(c4.penalty - nf3.penalty, 2 * 1 * 1 / 0.4, 'the difference: learnCost/100 x size x new / reach');
    assert.ok(R.flagsOf(n, b.config).includes('learn'));
    // The PGN says where it transposes, and chess.js reads it.
    const pgn = P.toPgn(B.toTree(b.nodes, b.rootKey, R.moveNote, p => p.join(' ')), { prefix: [] });
    assert.ok(/transposes to d4 d5 Nf3 Nf6/.test(pgn.replace(/\s+/g, ' ')), pgn);
    const c = new Chess();
    c.loadPgn(pgn);
    assert.strictEqual(c.history()[0], 'd4');
  });
  // The other way round: 1...Nf6 is decided first, before the line after 1...d5 exists.
  const trDb2 = await mkIdx('learn2', lines(80, 120));
  await check('build: polishing decides again once the rest of the repertoire is known', async () => {
    const at = b => b.nodes.get(String(G.keyOf(fenAfter('d4', 'Nf6'))));
    let b = await build(trDb2, Object.assign({ learnCost: 200 }, LEARN));
    assert.strictEqual(at(b).move, 'c4', 'decided first, nothing to share yet');
    b = await build(trDb2, Object.assign({ learnCost: 200, passes: 2 }, LEARN));
    assert.strictEqual(at(b).move, 'Nf3');
    assert.deepStrictEqual(at(b).was, ['c4']);
    assert.strictEqual(b.stats.polished, 1);
    // What only c4 led to is gone.
    assert.ok(!b.nodes.has(String(G.keyOf(fenAfter('d4', 'Nf6', 'c4')))));
    // Evaluated as it stands: 1.d4, 2.Nf3 after either reply, and 3.e3 where they meet.
    const r = E.evaluateRepertoire(trDb2, { side: 'w', root: START, moves: B.repertoireMoves(b.nodes) }, { minGames: 10 });
    assert.strictEqual(r.cards, 4);
    near(r.s, 0.5, 'every line scores 50%');
    near(r.ends.out, 0, 'no reply left out');
  });
  await check('build: a position reached by two move orders follows the replies its whole reach earns', async () => {
    // 1.e4 e5 2.Nf3 Nc6 (70%) and 1.e4 Nc6 2.Nf3 e5 (30%) meet; 3.Bb5's replies are a6 40%,
    // Nf6 30%, d6 30%. The 70% path gets there first: 0.7 x 0.4 is under the 0.29 line
    // minimum, the whole 1.0 x 0.4 isn't.
    const twoDb = await mkIdx('two', [
      ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6', 28, 0, 0], ['e4 e5 Nf3 Nc6 Bb5 Nf6 O-O', 21, 0, 0], ['e4 e5 Nf3 Nc6 Bb5 d6 O-O', 21, 0, 0],
      ['e4 Nc6 Nf3 e5 Bb5 a6 Ba4 Nf6', 12, 0, 0], ['e4 Nc6 Nf3 e5 Bb5 Nf6 O-O', 9, 0, 0], ['e4 Nc6 Nf3 e5 Bb5 d6 O-O', 9, 0, 0]]);
    const b = await build(twoDb, { lineMinReach: 0.29 }, null);
    const y = b.nodes.get(String(G.keyOf(fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bb5'))));
    near(y.reach, 1, 'both paths');
    assert.strictEqual(y.status, 'done');
    assert.deepStrictEqual(y.replies.map(r => r.san), ['a6', 'Nf6']);
    assert.strictEqual(b.nodes.get(String(G.keyOf(fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6')))).move, 'Ba4');
    twoDb.close();
  });
  await check('build: decisions pin a move or keep one out', async () => {
    const key = 'd4 Nf6';
    let dec = R.parseDecisions({ ['1. ' + key]: { play: 'Nf3', why: 'test' } }, START);
    let b = await build(trDb1, Object.assign({ learnCost: 0 }, LEARN), null, { decisions: dec });
    const n = b.nodes.get(String(G.keyOf(fenAfter('d4', 'Nf6'))));
    assert.strictEqual(n.move, 'Nf3');
    assert.strictEqual(n.why, 'pinned');
    dec = R.parseDecisions({ [fenAfter('d4', 'Nf6')]: { avoid: 'c4' } }, START);
    b = await build(trDb1, Object.assign({ learnCost: 0 }, LEARN), null, { decisions: dec });
    assert.strictEqual(b.nodes.get(String(G.keyOf(fenAfter('d4', 'Nf6')))).move, 'Nf3');
    assert.throws(() => R.parseDecisions({ '1. d4 Ke2': { play: 'x' } }, START), /not a line of legal moves/);
  });
  await check('build: the review lists flagged decisions with a line to answer with', async () => {
    const b = await build(trDb1, Object.assign({ learnCost: 200 }, LEARN));
    const md = R.reviewMarkdown({ out: 'x', side: 'w', root: START, prefix: [], index: 'test', filter: { speeds: ['blitz'], ratings: [2000] },
      cfg: b.config, nodes: b.nodes, inSample: null, holdout: null, chessdb: false, date: '2026-10-02' });
    assert.ok(/### 1\. d4 Nf6 — reach 40%/.test(md), md);
    assert.ok(md.includes('Decide: `"1. d4 Nf6": { "play": "Nf3" }`'), md);
    assert.ok(/\| \*\*Nf3\*\* \|/.test(md));
  });
  await check('build: pgnclean takes the PGN down to shares and transpositions', async () => {
    const write = (b, held) => P.toPgn(B.toTree(b.nodes, b.rootKey, R.moveNote, p => p.join(' ')), { prefix: [],
      headers: { White: 'Repertoire', Black: 'Lichess' }, rootComment: R.rootNote(4, { s: 0.585, raw: 0.522 }, held) });
    const pgns = [
      write(await build(trapDb, { soundMargin: 3 }, trapCdb), null),          // unsound, ChessDB, Prac, sound
      write(await build(trapDb, { soundMargin: 0 }, trapCdb), { s: 0.55, raw: 0.5 }),   // blunders; holdout
      write(await build(trDb1, Object.assign({ learnCost: 200 }, LEARN)), null),          // learning, over, transposes
      write(await build(trDb1, Object.assign({ learnCost: 0 }, LEARN), null,
        { decisions: R.parseDecisions({ '1. d4 Nf6': { play: 'Nf3' } }, START) }), null)  // pinned
    ];
    const all = pgns.join('\n').replace(/\s+/g, ' ');
    ['positions to know; in sample 58.5% (everyone 52.2%)', 'holdout 55.0%', 'score ', ', ChessDB ', ', Prac ', ' games, raw ',
      'sound ', ', blunders 40%', ' unsound', 'learning -', ' · over ', ' · pinned', ' · also ', 'end: ',
      'transposes to '].forEach(x => assert.ok(all.includes(x), 'the builds wrote "' + x + '"'));
    pgns.forEach(pgn => assert.deepStrictEqual(leftAfterClean(pgn, 'w'), [], pgn));
  });
  await check('pawnKey: the pawns alone', () => {
    assert.strictEqual(B.pawnKey(fenAfter('d4', 'c5', 'dxc5', 'e5')), '8/pp1p1ppp/8/2P1p3/8/8/PPP1PPPP/8');
    assert.strictEqual(B.pawnKey(START), B.pawnKey(fenAfter('Nf3', 'Nf6')));
  });

  /* --- the fenced reader --------------------------------------------------- */
  console.log('\ndeeprep: the fenced reader');
  const r = rng(4242);
  const games = [];
  for (let g = 0; g < 600; g++) {
    const c = new Chess();
    const sans = [];
    const len = 4 + r(26);
    for (let i = 0; i < len && !c.isGameOver(); i++) {
      // Few distinct moves, so lines share positions and transpose.
      const ms = c.moves().sort();
      const m = ms[r(5) ? r(Math.min(3, ms.length)) : r(ms.length)];
      c.move(m);
      sans.push(m);
    }
    games.push({ sans, res: RES[r(3)] });
  }
  const rndFile = path.join(tmp, 'rnd.pgn');
  fs.writeFileSync(rndFile, pgnOf(games));
  const rndIdx = path.join(tmp, 'rnd.xdb');
  await I.importDump({ input: rndFile, out: rndIdx, plies: 20, minGames: 1, workers: 2 });
  const plain = S.openIndex(rndIdx);
  // Every position's FEN, through chess.js alone.
  const fens = new Set([START]);
  games.forEach(g => {
    const c = new Chess();
    g.sans.slice(0, 20).forEach(m => { c.move(m); fens.add(c.fen()); });
  });
  await check('fenced lookups equal the plain binary search, for every block size', () => {
    for (const block of [1, 3, 64, 1024]) {
      const db = F.openFenced(rndIdx, { block, fenceFile: false });
      for (const f of fens) assert.deepStrictEqual(db.records(G.keyOf(f)), plain.records(G.keyOf(f)), block + ' ' + f);
      assert.deepStrictEqual(db.records(G.keyOf('8/8/8/8/8/8/8/K1k5 w - - 0 1')), []);
      assert.deepStrictEqual(db.records(0n), plain.records(0n));
      assert.deepStrictEqual(db.records(0xffffffffffffffffn), plain.records(0xffffffffffffffffn));
      db.close();
    }
  });
  await check('fences are saved beside the index and rebuilt when it changes', () => {
    const db = F.openFenced(rndIdx, { block: 16 });
    db.close();
    assert.ok(fs.existsSync(rndIdx + '.fence'));
    let built = 0;
    F.openFenced(rndIdx, { block: 16, log: () => built++ }).close();
    assert.strictEqual(built, 0, 'read from the file');
    F.openFenced(rndIdx, { block: 32, log: () => built++ }).close();
    assert.strictEqual(built, 1, 'another block size');
    fs.copyFileSync(handIdx, path.join(tmp, 'swap.xdb'));
    fs.copyFileSync(rndIdx + '.fence', path.join(tmp, 'swap.xdb.fence'));
    F.openFenced(path.join(tmp, 'swap.xdb'), { block: 32, log: () => built++ }).close();
    assert.strictEqual(built, 2, 'another index');
  });

  /* --- the search against a plain version ------------------------------- */
  console.log('\ndeeprep: against a plain search');
  // The same rules, written the slow way: chess.js move() and FEN keys, no memo. Values
  // carry their SE, which the shrinkage needs.
  function plainValue(fen, left, via, me, o) {
    const recs = plain.records(G.keyOf(fen));
    const stat = x => D.leafStat(x.white, x.draws, x.black, me);
    if (!recs.length) return via ? stat(via) : { s: NaN, se: Infinity };
    const sum = { white: 0, draws: 0, black: 0 };
    recs.forEach(x => { sum.white += x.white; sum.draws += x.draws; sum.black += x.black; });
    const total = sum.white + sum.draws + sum.black;
    const L = stat(sum);
    if (left <= 0 || total < o.minGames) return L;
    const vr = L.se * L.se * L.n;
    const k = o.prior || 0;
    const pull = v => {
      if (!k) return v;
      const n = vr / (v.se * v.se);
      const w = n / (n + k);
      return { s: L.s + w * (v.s - L.s), se: v.se };
    };
    const games = x => x.white + x.draws + x.black;
    const moves = recs.filter(x => x.code !== G.ENDED && x.code !== G.CUT);
    const child = x => {
      const p = G.codeParts(x.code);
      const c = new Chess(fen);
      c.move({ from: p.from, to: p.to, promotion: p.promotion });
      return plainValue(c.fen(), left - 1, x, me, o);
    };
    if (new Chess(fen).turn() === me) {
      // Most played first, as the search orders them, so ties go the same way.
      const mine = moves.filter(x => games(x) >= o.minGames).sort((a, b) => games(b) - games(a) || a.code - b.code);
      if (!mine.length) return L;
      return mine.map(x => pull(child(x))).reduce((a, b) => (b.s > a.s ? b : a));
    }
    const items = [];
    let sv = 0;
    recs.forEach(x => {
      const v = x.code === G.ENDED || x.code === G.CUT || games(x) < o.minGames ? pull(stat(x)) : child(x);
      items.push({ w: games(x), v: v.s });
      sv += games(x) * games(x) * v.se * v.se;
    });
    return { s: ce(items, o.risk || 0), se: Math.sqrt(sv) / total };
  }
  const db = F.openFenced(rndIdx, { block: 8, fenceFile: false });
  const roots = [START];
  {
    const c = new Chess();
    games[0].sans.slice(0, 5).forEach(m => { c.move(m); roots.push(c.fen()); });
  }
  await check('deep scores equal the plain search\'s, for both sides, horizons and limits', () => {
    let n = 0;
    for (const fen of roots) {
      for (const me of ['w', 'b']) {
        for (const o of [{ plies: 2, minGames: 1 }, { plies: 6, minGames: 3 }, { plies: 12, minGames: 8 }]) {
          for (const x of [PLAIN, { prior: 30, risk: 0 }, { prior: 0, risk: 0.05 }, { prior: 200, risk: 0.05 }]) {
            const oo = Object.assign({ side: me }, o, x);
            const s = D.createSearch(db, fen, oo).value();
            const p = plainValue(fen, o.plies, null, me, oo);
            const what = `${fen} ${me} ${JSON.stringify(oo)}`;
            assert.ok(Math.abs(s.s - p.s) < 1e-9, `${what}: ${s.s} vs ${p.s}`);
            assert.ok(Math.abs(s.se - p.se) < 1e-9, `${what} SE: ${s.se} vs ${p.se}`);
            n++;
          }
        }
      }
    }
    assert.strictEqual(n, roots.length * 24);
  });
  await check('memo shared between roots changes nothing', () => {
    const memo = new Map();
    const o = { plies: 8, minGames: 3, side: 'w', prior: 50, risk: 0.05 };
    roots.forEach(fen => {
      const a = D.createSearch(db, fen, Object.assign({ memo }, o)).value().s;
      const b = D.createSearch(db, fen, o).value().s;
      near(a, b, fen);
    });
  });
  await check('a slice answers like the whole index from its root, to its plies and minGames', () => {
    const out = path.join(tmp, 'slice.xdb');
    const r = SL.writeSlice(db, START, out, { plies: 6, minGames: 3 });
    assert.ok(r.positions > 10 && r.records > r.positions, JSON.stringify(r));
    const sl = F.openFenced(out, { fenceFile: false });
    try {
      assert.strictEqual(sl.meta.slice.plies, 6);
      for (const me of ['w', 'b']) {
        for (const o of [{ plies: 6, minGames: 3 }, { plies: 4, minGames: 5 }]) {
          const a = D.createSearch(sl, START, Object.assign({ side: me }, o)), b = D.createSearch(db, START, Object.assign({ side: me }, o));
          near(a.value().s, b.value().s, me + ' ' + JSON.stringify(o));
          assert.deepStrictEqual(a.candidates().list.map(x => [x.san, x.s]), b.candidates().list.map(x => [x.san, x.s]));
        }
      }
      // Below its minGames it doesn't hold everything: a search there may differ, as said.
      assert.ok(sl.count < plain.count);
    } finally {
      sl.close();
    }
  });
  await check('a search over its lookup limit says how to narrow it', () => {
    assert.throws(() => D.createSearch(db, START, { plies: 12, minGames: 1, maxLookups: 5 }).value(),
      /passed 5 lookups/);
  });

  [hdb, hdb2, pdb, tdb, trapDb, trDb1, trDb2, cdb, db].forEach(d => d.close());
  plain.close();
  fs.rmSync(tmp, { recursive: true, force: true });
};
