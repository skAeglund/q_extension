/*
 * explorerdb (tools/explorerdb.mjs): the dump filter, the fast replay against chess.js's
 * own move(), and an import of a generated dump counted against a plain recount.
 * Called from test/harness.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const assert = require('assert');

const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

// A small deterministic generator, so a failure repeats.
function rng(seed) {
  let s = seed >>> 0;
  return n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

module.exports = async function run(check) {
  const G = await load('tools/explorerdb/games.mjs');
  const S = await load('tools/explorerdb/store.mjs');
  const I = await load('tools/explorerdb/importer.mjs');
  const { Chess } = await load('src/vendor/chess.js');
  const { fenKey } = await load('src/pe/search.js');

  console.log('\nexplorerdb: reading the dump');
  await check('speeds follow Lichess\'s estimate (base + 40 x increment)', () => {
    assert.strictEqual(G.speedOf('15+0'), 'ultraBullet');
    assert.strictEqual(G.speedOf('60+1'), 'bullet');
    assert.strictEqual(G.speedOf('120+1'), 'bullet');   // 2+1 is bullet on Lichess
    assert.strictEqual(G.speedOf('120+2'), 'blitz');
    assert.strictEqual(G.speedOf('180+0'), 'blitz');
    assert.strictEqual(G.speedOf('600+0'), 'rapid');
    assert.strictEqual(G.speedOf('900+10'), 'rapid');        // 15+10
    assert.strictEqual(G.speedOf('1800+0'), 'classical');
    assert.strictEqual(G.speedOf('-'), 'correspondence');
  });
  await check('rating groups go by the players\' average, 2500 open-ended', () => {
    assert.strictEqual(G.ratingGroup(1599.5), 1400);
    assert.strictEqual(G.ratingGroup(1600), 1600);
    assert.strictEqual(G.ratingGroup(2499), 2200);
    assert.strictEqual(G.ratingGroup(3100), 2500);
  });

  const game = h => '[Event "Rated game"]\n' + Object.keys(h).map(k => `[${k} "${h[k]}"]\n`).join('') +
    '\n1. e4 { [%clk 0:03:00] } 1... c5 { [%clk 0:03:00] } 2. Nf3?! $6 2... d6 1-0\n\n';
  const base = { Result: '1-0', WhiteElo: '1700', BlackElo: '1600', TimeControl: '300+0' };
  const f = G.makeFilter(I.DEFAULTS);
  const why = { broken: 0, variant: 0, speed: 0, rating: 0, result: 0 };
  await check('the filter keeps a 1650 blitz game and says why it drops others', () => {
    const g = f(game(base), why);
    assert.strictEqual(g.result, 0);
    assert.deepStrictEqual(G.movetextSans(g.moves, 99), ['e4', 'c5', 'Nf3?!', 'd6']);
    assert.strictEqual(f(game(Object.assign({}, base, { TimeControl: '60+0' })), why), null);
    assert.strictEqual(f(game(Object.assign({}, base, { WhiteElo: '1500', BlackElo: '1600' })), why), null);
    assert.strictEqual(f(game(Object.assign({}, base, { BlackElo: '?' })), why), null);
    assert.strictEqual(f(game(Object.assign({}, base, { Result: '*' })), why), null);
    assert.strictEqual(f(game(Object.assign({}, base, { FEN: '8/8/8/8/8/8/8/K1k5 w - - 0 1' })), why), null);
    assert.strictEqual(f(game(Object.assign({}, base, { Variant: 'Chess960' })), why), null);
    assert.deepStrictEqual(why, { broken: 0, variant: 2, speed: 1, rating: 2, result: 1 });
    assert.strictEqual(f(game(Object.assign({}, base, { Result: '1/2-1/2' })), why).result, 1);
  });
  await check('movetext stops at the ply limit and skips numbers, comments, NAGs, results', () => {
    assert.deepStrictEqual(G.movetextSans('1. e4 {x} 1... e5 2. Nf3 Nc6 3. Bb5', 3), ['e4', 'e5', 'Nf3']);
    assert.deepStrictEqual(G.movetextSans('1.e4 e5 2.Qh5 $2 Nc6 3.Bc4 Nf6 4.Qxf7# 1-0', 99),
      ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
  });

  console.log('\nexplorerdb: the fast replay');
  // Random games, so castling, en passant, promotions and disambiguation all come up.
  const r = rng(12345);
  const games = [];
  for (let g = 0; g < 16; g++) {
    const c = new Chess();
    const sans = [];
    for (let i = 0; i < 160 && !c.isGameOver(); i++) {
      const ms = c.moves();
      const m = ms[r(ms.length)];
      c.move(m);
      sans.push(m);
    }
    games.push(sans);
  }
  const seen = { castle: 0, ep: 0, promo: 0, disamb: 0, positions: 0 };
  await check('every legal move\'s SAN finds that move, in every position of 16 random games', () => {
    for (const sans of games) {
      const c = new Chess();
      for (const played of sans) {
        for (const mv of c.moves({ verbose: true })) {
          const mo = G.findMove(c, mv.san);
          assert.ok(mo, mv.san + ' not found at ' + c.fen());
          const p = G.codeParts(G.moveCode(mo));
          assert.deepStrictEqual([p.from, p.to, p.promotion], [mv.from, mv.to, mv.promotion],
            mv.san + ' at ' + c.fen());
          if (mv.isKingsideCastle() || mv.isQueensideCastle()) seen.castle++;
          if (mv.isEnPassant()) seen.ep++;
          if (mv.promotion) seen.promo++;
          if (/^[NBRQ][a-h1-8]x?[a-h][1-8]/.test(mv.san)) seen.disamb++;
        }
        seen.positions++;
        c.move(played);
      }
    }
    assert.ok(seen.castle && seen.ep && seen.promo && seen.disamb, JSON.stringify(seen));
  });
  // Only a move that could be two pieces' is checked for legality: dumps hold legal games.
  await check('a pinned knight\'s twin plays without disambiguation', () => {
    const c = new Chess('4k3/8/8/8/1b6/8/3N4/4K1N1 w - - 0 1');   // Nd2 pinned by Bb4
    const mo = G.findMove(c, 'Nf3');
    assert.strictEqual(G.codeParts(G.moveCode(mo)).from, 'g1');
  });
  await check('the replay\'s hash of every position is keyOf() of its FEN, en passant included', () => {
    const replay = G.createReplayer();
    let eps = 0;
    for (const sans of games) {
      const w = replay(sans);
      const c = new Chess();
      assert.strictEqual(w.hashes[0], G.keyOf(c.fen()));
      sans.forEach((m, i) => {
        c.move(m);
        assert.strictEqual(w.hashes[i + 1], G.keyOf(c.fen()), 'after ' + sans.slice(0, i + 1).join(' '));
        // A FEN naming an en-passant square nobody can take on keys like one without it.
        const f4 = c.fen().split(' ');
        if (f4[3] !== '-') eps++;
      });
    }
    const a = G.keyOf('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    assert.strictEqual(a, G.keyOf('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'));
    assert.strictEqual(a, G.keyOf('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3'));
    assert.ok(eps > 0, 'no en-passant square came up');
  });
  await check('an unplayable move ends the replay with null', () =>
    assert.strictEqual(G.createReplayer()(['e4', 'e5', 'Ke3']), null));

  console.log('\nexplorerdb: counting');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-xdb-'));
  await check('counts over 65,535 split when spilled and add up again', () => {
    const dir = path.join(tmp, 'split');
    fs.mkdirSync(dir);
    const sp = S.createSpill(dir, 0, 64);
    sp.put(5n, 12, 70000, 1, 200000);
    sp.put(5n, 12, 1, 0, 0);
    sp.put(5n, 0, 0, 3, 0);
    sp.flush();
    const out = path.join(dir, 'out.bin');
    const st = S.aggregateShard([S.shardFile(dir, 0, 0), S.shardFile(dir, 0, 1)], 1, out);
    assert.strictEqual(st.kept, 1);
    const b = fs.readFileSync(out);
    assert.strictEqual(b.length, 2 * S.REC);
    assert.deepStrictEqual([b.readUInt16LE(8), b.readUInt32LE(14)], [0, 3]);
    assert.deepStrictEqual([b.readUInt16LE(S.REC + 8), b.readUInt32LE(S.REC + 10),
      b.readUInt32LE(S.REC + 14), b.readUInt32LE(S.REC + 18)], [12, 70001, 1, 200000]);
  });

  // A dump in Lichess's layout: kept and dropped games, clocks, one castling line.
  const r2 = rng(99);
  const TCS = ['180+0', '300+3', '60+0', '600+0', '1800+0', '15+0'];
  const RES = ['1-0', '1/2-1/2', '0-1'];
  const dumpGames = [];
  for (let g = 0; g < 400; g++) {
    const c = new Chess();
    const sans = [];
    const len = 6 + r2(60);
    for (let i = 0; i < len && !c.isGameOver(); i++) {
      const ms = c.moves();
      // Mostly the first moves listed, so games share their openings.
      const m = ms[r2(4) ? r2(Math.min(3, ms.length)) : r2(ms.length)];
      c.move(m);
      sans.push(m);
    }
    dumpGames.push({ sans, res: RES[r2(3)], we: 1300 + r2(1300), be: 1300 + r2(1300), tc: TCS[r2(TCS.length)] });
  }
  const castle = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6'];
  for (let g = 0; g < 3; g++) dumpGames.push({ sans: castle, res: '1-0', we: 2000, be: 2000, tc: '300+0' });
  const pgn = dumpGames.map((g, i) => [
    '[Event "Rated game"]', `[Site "https://lichess.org/g${i}"]`, `[Result "${g.res}"]`,
    `[WhiteElo "${g.we}"]`, `[BlackElo "${g.be}"]`, `[TimeControl "${g.tc}"]`, '',
    g.sans.map((m, j) => (j % 2 ? `${(j + 1) / 2 | 0}... ` : `${j / 2 + 1}. `) + m +
      ' { [%clk 0:03:00] }').join(' ') + ' ' + g.res, '', ''].join('\n')).join('');
  const dumpFile = path.join(tmp, 'dump.pgn');
  fs.writeFileSync(dumpFile, pgn);

  // The plain recount: chess.js's move() and fenKey, no hashes.
  const PLIES = 30;
  const want = new Map();
  let wantKept = 0;
  for (const g of dumpGames) {
    const avg = (g.we + g.be) / 2;
    if (['blitz', 'rapid', 'classical'].indexOf(G.speedOf(g.tc)) < 0 || avg < 1600) continue;
    wantKept++;
    const res = RES.indexOf(g.res);
    const c = new Chess();
    const sans = g.sans.slice(0, PLIES);
    for (let i = 0; i <= sans.length; i++) {
      const k = fenKey(c.fen());
      if (!want.has(k)) want.set(k, { fen: c.fen(), tot: [0, 0, 0], moves: new Map() });
      const e = want.get(k);
      e.tot[res]++;
      if (i < sans.length) {
        const mv = c.move(sans[i]);
        const a = e.moves.get(mv.san) || [0, 0, 0];
        a[res]++;
        e.moves.set(mv.san, a);
      }
    }
  }

  const sq = n => n.charCodeAt(0) - 97 + 8 * (n.charCodeAt(1) - 49);
  const codeOf = mv => sq(mv.from) + 64 * sq(mv.to) + 4096 * (' nbrq'.indexOf(mv.promotion || ' ') || 0);
  const index = path.join(tmp, 'all.xdb');
  const meta = await I.importDump({ input: dumpFile, out: index, plies: PLIES, minGames: 1,
    workers: 2, combinePlies: 4, batch: 37 });
  const db = S.openIndex(index);
  await check('an import of 403 games counts every position like a plain recount', () => {
    assert.strictEqual(meta.report.games.read, 403);
    assert.strictEqual(meta.report.games.kept, wantKept);
    assert.strictEqual(meta.report.positions, want.size);
    for (const [k, e] of want) {
      const recs = db.records(G.keyOf(k));
      const tot = [0, 0, 0];
      recs.forEach(x => { tot[0] += x.white; tot[1] += x.draws; tot[2] += x.black; });
      assert.deepStrictEqual(tot, e.tot, k);
      const c = new Chess(e.fen);
      const moves = recs.filter(x => x.code);
      assert.strictEqual(moves.length, e.moves.size, k);
      for (const [san, counts] of e.moves) {
        const code = codeOf(c.move(san));
        c.undo();
        const x = moves.find(y => y.code === code);
        assert.deepStrictEqual(x && [x.white, x.draws, x.black], counts, k + ' ' + san);
      }
    }
    // And the explorer-shaped answer, for a few of them.
    [...want.entries()].slice(0, 40).forEach(([k, e]) => {
      const a = S.explorerAnswer(db, k);
      assert.deepStrictEqual([a.white, a.draws, a.black], e.tot, k);
      a.moves.forEach(m => assert.deepStrictEqual([m.white, m.draws, m.black], e.moves.get(m.san), k + ' ' + m.san));
    });
  });
  await check('answers look like the explorer\'s: most played first, castling as e1h1', () => {
    const a = S.explorerAnswer(db, new Chess().fen());
    const games = m => m.white + m.draws + m.black;
    for (let i = 1; i < a.moves.length; i++) assert.ok(games(a.moves[i - 1]) >= games(a.moves[i]));
    const c = new Chess();
    castle.slice(0, 6).forEach(m => c.move(m));
    const oo = S.explorerAnswer(db, c.fen()).moves.find(m => m.san === 'O-O');
    assert.strictEqual(oo.uci, 'e1h1');
    const none = S.explorerAnswer(db, '8/8/8/8/8/8/8/K1k5 w - - 0 1');
    assert.deepStrictEqual([none.white, none.moves.length, none.indexed], [0, 0, false]);
  });
  await check('the report counts what each threshold would keep', () => {
    const t = N => meta.report.thresholds.find(x => x.minGames === N);
    const atLeast = N => [...want.values()].filter(e => e.tot[0] + e.tot[1] + e.tot[2] >= N).length;
    assert.strictEqual(t(1).positions, want.size);
    assert.strictEqual(t(3).positions, atLeast(3));
    assert.strictEqual(t(10).positions, atLeast(10));
    assert.strictEqual(t(1).bytes, db.count * S.REC);
  });
  db.close();

  if (typeof zlib.zstdCompressSync === 'function') {
    fs.writeFileSync(dumpFile + '.zst', zlib.zstdCompressSync(fs.readFileSync(dumpFile)));
    const small = path.join(tmp, 'min3.xdb');
    const m3 = await I.importDump({ input: dumpFile + '.zst', out: small, plies: PLIES, minGames: 3,
      workers: 1 });
    const db3 = S.openIndex(small);
    await check('a .zst dump with --min-games 3 keeps just the positions 3 games reached', () => {
      assert.strictEqual(m3.report.games.kept, wantKept);
      for (const [k, e] of want) {
        const n = e.tot[0] + e.tot[1] + e.tot[2];
        assert.strictEqual(db3.records(G.keyOf(k)).length > 0, n >= 3, k);
      }
      assert.ok(!fs.existsSync(small + '.tmp'), 'temporary files left');
    });
    db3.close();
  }
  const m10 = await I.importDump({ input: dumpFile, out: path.join(tmp, 'ten.xdb'), maxGames: 10,
    workers: 1 });
  await check('--max-games stops reading early', () =>
    assert.strictEqual(m10.report.games.read, 10));

  fs.rmSync(tmp, { recursive: true, force: true });
};
