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
  const { Chess } = await load('src/vendor/chess.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-deep-'));
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

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
    const s = D.createSearch(hdb, START, { plies: 3, minGames: 2 });
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
    const s = D.createSearch(hdb, START, { plies: 3, minGames: 15 });
    near(s.candidates().list[0].s, 0.5 * 0.5 + 0.5 * 0.75, 'e4');
  });
  await check('the horizon: at 1 ply each move is its own games', () => {
    const op = D.createSearch(hdb, START, { plies: 1, minGames: 2 }).candidates();
    near(op.list[0].s, 0.625, 'e4');
    near(op.list[1].s, 0.6, 'd4');
  });
  await check('Black\'s side scores the same games from the other end', () => {
    const s = D.createSearch(hdb, START, { plies: 3, minGames: 2, side: 'b' });
    // White is the opponent now: the root averages by games played. After 1.e4 Black
    // chooses: e5 (then White's Nf3 and Bc4 average 0.5 for Black) over c5 (0.25).
    const op = s.candidates();
    assert.strictEqual(op.mine, false);
    assert.deepStrictEqual(op.list.map(x => x.san), ['e4', 'd4']);
    near(op.list[0].s, 0.5, 'e4 for Black');
    near(op.list[1].s, 0.4, 'd4 for Black');
    near(s.value().s, (40 * 0.5 + 30 * 0.4) / 70, 'root for Black');
  });

  add('c4 e5 Nc3', 3, 0, 0);       // few games, all won
  const handFile2 = path.join(tmp, 'hand2.pgn');
  fs.writeFileSync(handFile2, pgnOf(hand));
  const handIdx2 = path.join(tmp, 'hand2.xdb');
  await I.importDump({ input: handFile2, out: handIdx2, plies: 10, minGames: 1, workers: 1 });
  const hdb2 = F.openFenced(handIdx2, { fenceFile: false });
  await check('the tree keeps the best lower bound beside the best score', () => {
    const s = D.createSearch(hdb2, START, { plies: 3, minGames: 2, z: 2 });
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
  await check('the PGN has the chosen moves, the safe one as a variation, numbers in comments', () => {
    const s = D.createSearch(hdb2, START, { plies: 3, minGames: 2, z: 2 });
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
  // The same rules, written the slow way: chess.js move() and FEN keys, no memo.
  function plainValue(fen, left, via, me, o) {
    const recs = plain.records(G.keyOf(fen));
    const stat = x => D.leafStat(x.white, x.draws, x.black, me);
    if (!recs.length) return via ? stat(via) : { s: NaN };
    const sum = { white: 0, draws: 0, black: 0 };
    recs.forEach(x => { sum.white += x.white; sum.draws += x.draws; sum.black += x.black; });
    const total = sum.white + sum.draws + sum.black;
    if (left <= 0 || total < o.minGames) return stat(sum);
    const games = x => x.white + x.draws + x.black;
    const moves = recs.filter(x => x.code !== G.ENDED && x.code !== G.CUT);
    const child = x => {
      const p = G.codeParts(x.code);
      const c = new Chess(fen);
      c.move({ from: p.from, to: p.to, promotion: p.promotion });
      return plainValue(c.fen(), left - 1, x, me, o);
    };
    if (new Chess(fen).turn() === me) {
      const mine = moves.filter(x => games(x) >= o.minGames);
      if (!mine.length) return stat(sum);
      return { s: Math.max(...mine.map(x => child(x).s)) };
    }
    let w = 0, s = 0;
    recs.forEach(x => {
      const v = x.code === G.ENDED || x.code === G.CUT || games(x) < o.minGames ? stat(x) : child(x);
      w += games(x);
      s += games(x) * v.s;
    });
    return { s: s / w };
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
          const s = D.createSearch(db, fen, Object.assign({ side: me }, o));
          near(s.value().s, plainValue(fen, o.plies, null, me, o).s, `${fen} ${me} ${JSON.stringify(o)}`);
          n++;
        }
      }
    }
    assert.strictEqual(n, roots.length * 6);
  });
  await check('memo shared between roots changes nothing', () => {
    const memo = new Map();
    const o = { plies: 8, minGames: 3, side: 'w' };
    roots.forEach(fen => {
      const a = D.createSearch(db, fen, Object.assign({ memo }, o)).value().s;
      const b = D.createSearch(db, fen, o).value().s;
      near(a, b, fen);
    });
  });
  await check('a search over its lookup limit says how to narrow it', () => {
    assert.throws(() => D.createSearch(db, START, { plies: 12, minGames: 1, maxLookups: 5 }).value(),
      /passed 5 lookups/);
  });

  [hdb, hdb2, db].forEach(d => d.close());
  plain.close();
  fs.rmSync(tmp, { recursive: true, force: true });
};
