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
const crypto = require('crypto');
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
  const pgnGames = dumpGames.map((g, i) => [
    '[Event "Rated game"]', `[Site "https://lichess.org/g${i}"]`, `[Result "${g.res}"]`,
    `[WhiteElo "${g.we}"]`, `[BlackElo "${g.be}"]`, `[TimeControl "${g.tc}"]`, '',
    g.sans.map((m, j) => (j % 2 ? `${(j + 1) / 2 | 0}... ` : `${j / 2 + 1}. `) + m +
      ' { [%clk 0:03:00] }').join(' ') + ' ' + g.res, '', ''].join('\n'));
  const pgn = pgnGames.join('');
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
      if (!want.has(k)) want.set(k, { fen: c.fen(), tot: [0, 0, 0], cut: 0, moves: new Map() });
      const e = want.get(k);
      e.tot[res]++;
      if (i === sans.length && g.sans.length > PLIES) e.cut++;   // went on past the limit
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
      const moves = recs.filter(x => x.code && x.code !== G.CUT);
      const cut = recs.filter(x => x.code === G.CUT).reduce((n, x) => n + x.white + x.draws + x.black, 0);
      assert.strictEqual(cut, e.cut, k);
      assert.strictEqual(moves.length, e.moves.size, k);
      for (const [san, counts] of e.moves) {
        const code = codeOf(c.move(san));
        c.undo();
        const x = moves.find(y => y.code === code);
        assert.deepStrictEqual(x && [x.white, x.draws, x.black], counts, k + ' ' + san);
      }
    }
    assert.ok([...want.values()].some(e => e.cut), 'no game reached the ply limit');
    // And the explorer-shaped answer, for a few of them and every cut-off one.
    [...want.entries()].filter(([, e], i) => i < 40 || e.cut).forEach(([k, e]) => {
      const a = S.explorerAnswer(db, k);
      assert.strictEqual(a.white + a.draws + a.black, e.tot[0] + e.tot[1] + e.tot[2] - e.cut, k);
      assert.strictEqual(a.cut, e.cut, k);
      assert.strictEqual(a.moves.reduce((n, m) => n + m.white + m.draws + m.black, 0) <=
        a.white + a.draws + a.black, true, k);
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

  console.log('\nexplorerdb: many months');
  const M = await load('tools/explorerdb/merge.mjs');
  const A = await load('tools/explorerdb/acc.mjs');
  const AL = await load('tools/explorerdb/all.mjs');
  // The same games as three "months" of uneven size, as Lichess names them.
  const months = ['2013-01', '2013-02', '2013-03'];
  const cuts = [0, 90, 250, pgnGames.length];
  const monthFiles = months.map((m, i) => {
    const f = path.join(tmp, `lichess_db_standard_rated_${m}.pgn`);
    fs.writeFileSync(f, pgnGames.slice(cuts[i], cuts[i + 1]).join(''));
    return f;
  });
  const recordsOf = file => { const d = S.openIndex(file); d.close(); return fs.readFileSync(file).subarray(d.start); };
  const whole = recordsOf(index);
  // The positions the whole import keeps at N: its records, filtered by total.
  const keptAt = N => {
    const out = [];
    for (let i = 0; i < whole.length;) {
      let j = i, tot = 0;
      while (j < whole.length && whole.compare(whole, j, j + 8, i, i + 8) === 0) {
        tot += whole.readUInt32LE(j + 10) + whole.readUInt32LE(j + 14) + whole.readUInt32LE(j + 18);
        j += S.REC;
      }
      if (tot >= N) out.push(whole.subarray(i, j));
      i = j;
    }
    return Buffer.concat(out);
  };
  const monthIdx = [];
  for (let i = 0; i < 3; i++) {
    const f = path.join(tmp, `m${i}.xdb`);
    await I.importDump({ input: monthFiles[i], out: f, plies: PLIES, minGames: 1, workers: 2 });
    monthIdx.push(f);
  }
  await check('merging three months at N >= 1 gives the whole import\'s records, byte for byte', async () => {
    const out = path.join(tmp, 'merged.xdb');
    const mm = await M.mergeIndexes({ inputs: monthIdx, out, minGames: 1 });
    assert.ok(recordsOf(out).equals(whole));
    assert.strictEqual(mm.report.games.kept, wantKept);
    assert.strictEqual(mm.report.positions, want.size);
    const m3 = await M.mergeIndexes({ inputs: monthIdx, out: path.join(tmp, 'merged3.xdb'), minGames: 3 });
    assert.ok(recordsOf(path.join(tmp, 'merged3.xdb')).equals(keptAt(3)));
    assert.strictEqual(m3.report.thresholds.find(t => t.minGames === 3).positions, m3.report.positions);
  });
  await check('indexes with another filter or ply limit are not merged', () => {
    const other = path.join(tmp, 'other.xdb');
    return I.importDump({ input: monthFiles[0], out: other, plies: 20, minGames: 1, workers: 1 }).then(() =>
      assert.rejects(M.mergeIndexes({ inputs: [monthIdx[0], other], out: path.join(tmp, 'no.xdb') }), /Different plies/));
  });

  const accDir = path.join(tmp, 'a.acc');
  const create = { filter: { speeds: I.DEFAULTS.speeds, ratings: I.DEFAULTS.ratings }, plies: PLIES };
  await check('an accumulator of the three months writes the whole import\'s index, at 1 and at 3', async () => {
    const acc = A.openAcc(accDir, { create });
    for (const f of monthFiles) await A.addDump(acc, f, I.importDump, { workers: 2 });
    await assert.rejects(A.addDump(acc, monthFiles[0], I.importDump, {}), /already/);
    const m1 = A.writeIndex(acc, path.join(tmp, 'acc1.xdb'), 1);
    assert.ok(recordsOf(path.join(tmp, 'acc1.xdb')).equals(whole));
    assert.strictEqual(m1.report.games.kept, wantKept);
    assert.deepStrictEqual(m1.report.dumps.length, 3);
    assert.strictEqual(m1.source, '3 dumps, 2013-01..2013-03');
    A.writeIndex(acc, path.join(tmp, 'acc3.xdb'), 3);
    assert.ok(recordsOf(path.join(tmp, 'acc3.xdb')).equals(keptAt(3)));
    // The index opens and answers like any other.
    const d = S.openIndex(path.join(tmp, 'acc3.xdb'));
    assert.strictEqual(S.explorerAnswer(d, new Chess().fen()).white, S.explorerAnswer(db, new Chess().fen()).white);
    d.close();
    acc.close();
  });
  await check('an accumulator is locked while open, and read-only opens don\'t lock', () => {
    // Another process holding it: this one's parent, which is alive.
    fs.writeFileSync(path.join(accDir, 'lock'), String(process.ppid));
    assert.throws(() => A.openAcc(accDir), /in use by process/);
    const ro = A.openAcc(accDir, { readOnly: true });
    assert.strictEqual(ro.state.ops.length, 3);
    // A lock whose process is gone is taken over.
    fs.writeFileSync(path.join(accDir, 'lock'), '999999');
    const a1 = A.openAcc(accDir);
    assert.strictEqual(fs.readFileSync(path.join(accDir, 'lock'), 'utf8'), String(process.pid));
    a1.close();
    assert.ok(!fs.existsSync(path.join(accDir, 'lock')));
  });
  await check('an import cut off mid-merge is finished by adding the same dump again', async () => {
    const dir = path.join(tmp, 'crash.acc');
    const acc = A.openAcc(dir, { create });
    await A.addDump(acc, monthFiles[0], I.importDump, { workers: 2 });
    // Dies after 100 shards: those hold month 2, the rest don't.
    let n = 0;
    const dying = o => I.importDump(Object.assign({}, o, { intoShard: s => {
      if (n++ === 100) throw new Error('power cut');
      return o.intoShard(s);
    } }));
    await assert.rejects(A.addDump(acc, monthFiles[1], dying, { workers: 1 }), /power cut/);
    acc.close();
    // What a crash can also leave: a half-written shard, and an old generation beside a new one.
    fs.writeFileSync(path.join(dir, 'a200.g2.bin.part'), 'half');
    const g1 = acc.gens.findIndex(g => g === 2);
    fs.copyFileSync(path.join(dir, `a${String(g1).padStart(3, '0')}.g2.bin`), path.join(dir, `a${String(g1).padStart(3, '0')}.g1.bin`));
    const again = A.openAcc(dir);
    assert.ok(!fs.existsSync(path.join(dir, 'a200.g2.bin.part')));
    assert.ok(!fs.existsSync(path.join(dir, `a${String(g1).padStart(3, '0')}.g1.bin`)));
    const atTwo = again.gens.filter(g => g === 2).length;
    assert.ok(atTwo > 0 && atTwo < 256, String(atTwo));
    await assert.rejects(A.addDump(again, monthFiles[2], I.importDump, {}), /Unfinished: adding .*2013-02/);
    await A.addDump(again, monthFiles[1], I.importDump, { workers: 2 });
    await A.addDump(again, monthFiles[2], I.importDump, { workers: 2 });
    A.writeIndex(again, path.join(tmp, 'crash.xdb'), 1);
    assert.ok(recordsOf(path.join(tmp, 'crash.xdb')).equals(whole));
    again.close();
  });
  await check('a prune drops what is under its threshold so far, and says what that can cost', async () => {
    const dir = path.join(tmp, 'pruned.acc');
    const acc = A.openAcc(dir, { create });
    await A.addDump(acc, monthFiles[0], I.importDump, { workers: 2 });
    const before = acc.totals();
    const op = A.prune(acc, 2);
    const after = acc.totals();
    assert.strictEqual(after.positions[0], before.positions[1]);   // all that had 2 or more
    assert.strictEqual(after.bytes, before.records[1] * S.REC);
    assert.ok(op.droppedGames > 0);
    await A.addDump(acc, monthFiles[1], I.importDump, { workers: 2 });
    await A.addDump(acc, monthFiles[2], I.importDump, { workers: 2 });
    const mx = A.writeIndex(acc, path.join(tmp, 'pruned.xdb'), 1);
    assert.strictEqual(mx.report.maxUndercount, 1);
    assert.deepStrictEqual(mx.report.prunes, [2]);
    const d = S.openIndex(path.join(tmp, 'pruned.xdb'));
    // Every position is short by at most one game, and nothing with 2 or more is lost.
    let short = 0;
    for (const [k, e] of want) {
      const n = e.tot[0] + e.tot[1] + e.tot[2];
      const got = d.records(G.keyOf(k)).reduce((s, x) => s + x.white + x.draws + x.black, 0);
      assert.ok(got <= n && got >= n - 1 && (n < 2 || got > 0), k + ': ' + got + ' of ' + n);
      if (got < n) short++;
    }
    assert.ok(short > 0, 'the prune dropped nothing that came back');
    d.close();
    assert.strictEqual(A.pruneFor(after, after.bytes), 2);
    assert.strictEqual(A.pruneFor(after, -1), 1000);
    acc.close();
  });

  // The driver, with Lichess's list and the downloads replaced by the three files.
  const fakeList = months.map((m, i) => ({ name: path.basename(monthFiles[i]), month: m,
    size: fs.statSync(monthFiles[i]).size }));
  const runDir = path.join(tmp, 'run');
  const runOpts = extra => Object.assign({
    acc: path.join(runDir, 'r.acc'), dumps: path.join(runDir, 'dumps'), out: path.join(runDir, 'r.xdb'),
    minGames: 3, diskBytes: 1e12, reserveBytes: 0, prefetch: true, filter: create.filter, plies: PLIES,
    workers: 1, list: fakeList, log: () => {},
    fetchDump: (d, dest) => { fetched.push(d.month); fs.copyFileSync(monthFiles[months.indexOf(d.month)], dest); return Promise.resolve(dest); }
  }, extra);
  let fetched = [];
  await check('the driver adds months newest first, deletes each dump, resumes, and writes the index', async () => {
    await AL.runAll(runOpts({ from: '2013-02' }));
    assert.deepStrictEqual(fetched, ['2013-03', '2013-02']);
    assert.deepStrictEqual(fs.readdirSync(path.join(runDir, 'dumps')), []);
    fetched = [];
    // As if stopped between adding 2013-02 and deleting it.
    fs.copyFileSync(monthFiles[1], path.join(runDir, 'dumps', fakeList[1].name));
    const sum = await AL.runAll(runOpts({}));
    assert.deepStrictEqual(fs.readdirSync(path.join(runDir, 'dumps')), []);
    assert.deepStrictEqual(fetched, ['2013-01']);
    assert.strictEqual(sum.dumps.length, 3);
    assert.ok(recordsOf(path.join(runDir, 'r.xdb')).equals(keptAt(3)));
    assert.ok(!fs.existsSync(path.join(runDir, 'r.acc', 'lock')));
  });
  await check('with too little disk the driver prunes, never above the index\'s threshold', async () => {
    fetched = [];
    const logs2 = [];
    // Room for the first month and a bit at N >= 1: the others force prunes.
    const full = A.openAcc(path.join(runDir, 'r.acc'), { readOnly: true });
    const first = full.state.ops[0];
    const dir = path.join(tmp, 'tight');
    await AL.runAll(runOpts({ acc: path.join(dir, 't.acc'), dumps: path.join(dir, 'dumps'),
      out: path.join(dir, 't.xdb'), marginBytes: 0, firstRatio: 0.3, log: s => logs2.push(s),
      diskBytes: first.bytesAfter + Math.max(...fakeList.map(d => d.size)) + 30e3 }));
    const acc = A.openAcc(path.join(dir, 't.acc'), { readOnly: true });
    const prunes = A.summary(acc).prunes;
    assert.ok(prunes.length > 0, logs2.join('\n'));
    assert.ok(prunes.every(t => t >= 2 && t <= 3), prunes.join(','));
    // Pruning at or under 3 can't change what an index at 3 keeps... except for a position
    // a prune cut short: it can drop under 3 in the sum. So compare with the bound.
    const d = S.openIndex(path.join(dir, 't.xdb'));
    const bound = A.summary(acc).maxUndercount;
    for (const [k, e] of want) {
      const n = e.tot[0] + e.tot[1] + e.tot[2];
      const got = d.records(G.keyOf(k)).reduce((s, x) => s + x.white + x.draws + x.black, 0);
      assert.ok(got <= n && (got >= n - bound || got === 0), k);
      if (n >= 3 + bound) assert.ok(got > 0, k + ' lost');
    }
    d.close();
  });
  await check('a download cut off resumes where it stopped, and a bad one is fetched again', async () => {
    const http = require('http');
    const body = crypto.randomBytes(300000);
    let cut = true, corrupt = 0, ranges = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': body.length }); return res.end(); }
      if (req.url.endsWith('.torrent')) { res.writeHead(404); return res.end(); }   // no repair: fetched whole
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      ranges.push(from);
      let data = body.subarray(from);
      if (corrupt > 0) { corrupt--; data = Buffer.from(data); data[5] ^= 1; }
      res.writeHead(m ? 206 : 200, { 'Content-Length': data.length });
      if (cut) { cut = false; res.write(data.subarray(0, 100000)); setTimeout(() => res.destroy(), 50); return; }
      res.end(data);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/x.pgn.zst';
      const sum = crypto.createHash('sha256').update(body).digest('hex');
      const dest = path.join(tmp, 'dl.pgn.zst');
      await AL.download({ url, name: 'x.pgn.zst', sha256: sum }, dest, () => {}, { unitMs: 1 });
      assert.ok(fs.readFileSync(dest).equals(body));
      assert.strictEqual(ranges[0], 0);
      assert.ok(ranges[1] >= 100000, String(ranges));
      assert.ok(!fs.existsSync(dest + '.part'));
      // A copy that fails its check is thrown away and fetched again; twice is an error.
      ranges = []; corrupt = 1;
      const d2 = path.join(tmp, 'dl2.pgn.zst');
      await AL.download({ url, name: 'x.pgn.zst', sha256: sum }, d2, () => {}, { unitMs: 1 });
      assert.ok(fs.readFileSync(d2).equals(body));
      corrupt = 2;
      await assert.rejects(AL.download({ url, name: 'x.pgn.zst', sha256: sum }, path.join(tmp, 'dl3.pgn.zst'),
        () => {}, { unitMs: 1 }), /sha256 mismatch twice/);
      assert.ok(!fs.existsSync(path.join(tmp, 'dl3.pgn.zst')));
    } finally {
      server.close();
    }
  });
  await check('a copy that fails its sha256 is repaired from the torrent\'s piece hashes', async () => {
    const http = require('http');
    const body = crypto.randomBytes(300000), plen = 32768, count = Math.ceil(body.length / plen);
    const pieces = Buffer.concat(Array.from({ length: count }, (_, p) =>
      crypto.createHash('sha1').update(body.subarray(p * plen, (p + 1) * plen)).digest()));
    const torrentOf = len => Buffer.concat([Buffer.from('d8:announce3:x:y4:infod6:lengthi' + len +
      'e4:name9:x.pgn.zst12:piece lengthi' + plen + 'e6:pieces' + pieces.length + ':'), pieces, Buffer.from('ee')]);
    let torrent = torrentOf(body.length), asked = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': body.length }); return res.end(); }
      if (req.url.endsWith('.torrent')) { res.writeHead(200, { 'Content-Length': torrent.length }); return res.end(torrent); }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0, to = m && m[2] ? Number(m[2]) + 1 : body.length;
      asked.push([from, to]);
      const data = body.subarray(from, to);
      res.writeHead(m ? 206 : 200, { 'Content-Length': data.length });
      res.end(data);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/x.pgn.zst';
      const sum = crypto.createHash('sha256').update(body).digest('hex');
      assert.deepStrictEqual(AL.bdecode(torrent).info.length, body.length);
      // What the crash left: a full-length .part (no map, as from before) whose tail
      // around pieces 4-5 went to zeros, and one flipped byte in piece 8.
      const broken = () => {
        const b = Buffer.from(body);
        b.fill(0, 4 * plen + 100, 6 * plen - 7);
        b[8 * plen + 3] ^= 1;
        return b;
      };
      const dest = path.join(tmp, 'rep.pgn.zst'), logs = [];
      fs.writeFileSync(dest + '.part', broken());
      await AL.download({ url, name: 'x.pgn.zst', sha256: sum }, dest, l => logs.push(l), { unitMs: 1 });
      assert.ok(fs.readFileSync(dest).equals(body));
      // Two requests: pieces 4-5 together, then piece 8. Nothing else of the file.
      assert.deepStrictEqual(asked, [[4 * plen, 6 * plen], [8 * plen, 9 * plen]]);
      assert.ok(logs.some(l => /3 of 10 pieces are bad/.test(l)), logs.join('\n'));
      assert.ok(!fs.existsSync(dest + '.part') && !fs.existsSync(dest + '.part.json'));

      // A torrent for another upload of the dump is no help: fetched whole.
      asked = []; logs.length = 0;
      torrent = torrentOf(body.length + 1);
      const d2 = path.join(tmp, 'rep2.pgn.zst');
      fs.writeFileSync(d2 + '.part', broken());
      await AL.download({ url, name: 'x.pgn.zst', sha256: sum }, d2, l => logs.push(l), { unitMs: 1 });
      assert.ok(fs.readFileSync(d2).equals(body));
      assert.deepStrictEqual(asked, [[0, body.length]]);
      assert.ok(logs.some(l => /another upload/.test(l)), logs.join('\n'));
    } finally {
      server.close();
    }
  });
  await check('a download runs over two connections, each resumed where it stopped', async () => {
    const http = require('http');
    const body = crypto.randomBytes(1000000);
    let cutAt = null, open = 0, most = 0, asked = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': body.length }); return res.end(); }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const from = Number(m[1]), to = m[2] ? Number(m[2]) + 1 : body.length;
      asked.push([from, to]);
      open++; most = Math.max(most, open);
      res.on('close', () => open--);
      const data = body.subarray(from, to);
      res.writeHead(206, { 'Content-Length': data.length, 'Content-Range': 'bytes ' + from + '-' + (to - 1) + '/' + body.length });
      // The connection for the second half breaks off 100 kB in, once.
      if (cutAt === from) {
        cutAt = null;
        res.write(data.subarray(0, 100000));
        return setTimeout(() => res.destroy(), 100);
      }
      // Slowly enough for both to be open at once.
      res.write(data.subarray(0, 1000));
      setTimeout(() => res.end(data.subarray(1000)), 50);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/x.pgn.zst';
      const sum = crypto.createHash('sha256').update(body).digest('hex');
      const d = () => ({ url, name: 'x.pgn.zst', sha256: sum });
      const o = { unitMs: 1, connections: 2, minSplit: 100000 };
      const dest = path.join(tmp, 'two.pgn.zst');
      cutAt = 500000;
      await AL.download(d(), dest, () => {}, o);
      assert.ok(fs.readFileSync(dest).equals(body));
      assert.deepStrictEqual(asked.slice(0, 2).sort((a, b) => a[0] - b[0]), [[0, 500000], [500000, 1000000]]);
      assert.strictEqual(most, 2);
      // The cut half resumes from what was written; the other half isn't asked for again.
      const again = asked.slice(2);
      assert.ok(again.length >= 1 && again.every(r => r[0] >= 600000 && r[1] <= 1000000), JSON.stringify(asked));
      assert.ok(!fs.existsSync(dest + '.part') && !fs.existsSync(dest + '.part.json'));

      // A .part from a single-connection download, with no map: done up to its length,
      // the rest split in two.
      asked = [];
      const d2 = path.join(tmp, 'two2.pgn.zst');
      fs.writeFileSync(d2 + '.part', body.subarray(0, 200000));
      await AL.download(d(), d2, () => {}, o);
      assert.ok(fs.readFileSync(d2).equals(body));
      assert.deepStrictEqual(asked.sort((a, b) => a[0] - b[0]), [[200000, 600000], [600000, 1000000]]);

      // An unreadable map starts over rather than trusting a full-length .part.
      asked = [];
      const d3 = path.join(tmp, 'two3.pgn.zst');
      fs.writeFileSync(d3 + '.part', Buffer.alloc(body.length));
      fs.writeFileSync(d3 + '.part.json', '{"size":');
      await AL.download(d(), d3, () => {}, o);
      assert.ok(fs.readFileSync(d3).equals(body));
      assert.deepStrictEqual(asked.sort((a, b) => a[0] - b[0]), [[0, 500000], [500000, 1000000]]);
    } finally {
      server.close();
    }
  });
  await check('an unfinished month outside the range asked for stops the driver', async () => {
    const dir = path.join(tmp, 'pend');
    const acc = A.openAcc(path.join(dir, 'p.acc'), { create });
    acc.begin({ type: 'dump', source: fakeList[0].name });
    acc.close();
    await assert.rejects(AL.runAll(runOpts({ acc: path.join(dir, 'p.acc'), dumps: path.join(dir, 'dumps'),
      out: path.join(dir, 'p.xdb'), from: '2013-02' })), /was adding .*2013-01/);
  });

  // Filtered months as drain keeps them: <dir>/YYYY/YYYY-MM.json and its parts.
  const FF = await load('tools/explorerdb/filter.mjs');
  const filterInto = (dir, i) => FF.filterDump({ input: monthFiles[i], plies: PLIES, partBytes: 3000, chunkBytes: 1000,
    out: path.join(dir, months[i].slice(0, 4), months[i]) });
  await check('the driver adds a filtered month instead of downloading it, under its dump\'s name', async () => {
    fetched = [];
    const dir = path.join(tmp, 'filt');
    const fdir = path.join(dir, 'filtered');
    await filterInto(fdir, 1);
    // A dump downloaded before its filtered parts came: added from the parts, then deleted.
    fs.mkdirSync(path.join(dir, 'dumps'), { recursive: true });
    fs.copyFileSync(monthFiles[1], path.join(dir, 'dumps', fakeList[1].name));
    const logs = [];
    await AL.runAll(runOpts({ acc: path.join(dir, 'f.acc'), dumps: path.join(dir, 'dumps'), out: path.join(dir, 'f.xdb'),
      filtered: fdir, log: s => logs.push(s) }));
    assert.deepStrictEqual(fetched.sort(), ['2013-01', '2013-03']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'dumps')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(fdir, '2013')), [], 'filtered files kept');
    assert.ok(logs.some(s => /deleting the filtered files of 2013-02, added already/.test(s)), logs.join('\n'));
    assert.ok(logs.some(s => /adding .*2013-02.* from its filtered parts/.test(s)), logs.join('\n'));
    assert.ok(recordsOf(path.join(dir, 'f.xdb')).equals(keptAt(3)));
    const acc = A.openAcc(path.join(dir, 'f.acc'), { readOnly: true });
    const op = acc.state.ops.find(x => x.source === fakeList[1].name);
    assert.ok(op && op.filtered, JSON.stringify(acc.state.ops.map(x => x.source)));
    assert.ok(!acc.state.ops.some(x => /\.json$/.test(x.source)));
  });
  await check('...a filtered month that arrives once it is added goes at the start; keepFiltered keeps them all', async () => {
    const dir = path.join(tmp, 'filt');
    const fdir = path.join(dir, 'filtered');
    await filterInto(fdir, 1);
    await filterInto(fdir, 2);       // 2013-03 was added from its dump
    const logs = [];
    await AL.runAll(runOpts({ acc: path.join(dir, 'f.acc'), dumps: path.join(dir, 'dumps'), out: path.join(dir, 'f.xdb'),
      filtered: fdir, log: s => logs.push(s) }));
    assert.deepStrictEqual(fs.readdirSync(path.join(fdir, '2013')), [], logs.join('\n'));
    fetched = [];
    const kdir = path.join(tmp, 'filtKeep');
    const kf = path.join(kdir, 'filtered');
    const man = await filterInto(kf, 1);
    await AL.runAll(runOpts({ acc: path.join(kdir, 'k.acc'), dumps: path.join(kdir, 'dumps'), out: path.join(kdir, 'k.xdb'),
      filtered: kf, keepFiltered: true }));
    assert.deepStrictEqual(fetched.sort(), ['2013-01', '2013-03']);
    assert.deepStrictEqual(fs.readdirSync(path.join(kf, '2013')).sort(), man.parts.map(p => p.file).concat(['2013-02.json']).sort());
  });
  await check('...months before --filtered-before are waited for, never downloaded', async () => {
    fetched = [];
    const dir = path.join(tmp, 'filt2');
    const fdir = path.join(dir, 'filtered');
    await filterInto(fdir, 1);
    const logs = [];
    // 2013-01 arrives later, as drain would bring it; a part copied short doesn't count.
    let half = null;
    const arrive = async () => {
      const man = await filterInto(fdir, 0);
      const part = path.join(fdir, '2013', man.parts[0].file);
      half = fs.readFileSync(part);
      fs.truncateSync(part, 10);
      setTimeout(() => fs.writeFileSync(part, half), 200);
    };
    await AL.runAll(runOpts({ acc: path.join(dir, 'g.acc'), dumps: path.join(dir, 'dumps'), out: path.join(dir, 'g.xdb'),
      filtered: fdir, filteredBefore: '2013-03', pollMs: 20,
      log: s => { logs.push(s); if (/^waiting for/.test(s)) arrive(); } }));
    assert.deepStrictEqual(fetched, ['2013-03']);
    assert.ok(half, 'never waited');
    assert.strictEqual(logs.filter(s => /waiting for 1 filtered month \(2013-01\) from drain/.test(s)).length, 1, logs.join('\n'));
    assert.ok(recordsOf(path.join(dir, 'g.xdb')).equals(keptAt(3)));
  });
  await check('...and a month cut off mid-add from its dump is finished from its filtered parts', async () => {
    fetched = [];
    const dir = path.join(tmp, 'filt3');
    const fdir = path.join(dir, 'filtered');
    for (const i of [0, 1, 2]) await filterInto(fdir, i);
    const acc = A.openAcc(path.join(dir, 'h.acc'), { create });
    acc.begin({ type: 'dump', source: fakeList[2].name });
    acc.close();
    await AL.runAll(runOpts({ acc: path.join(dir, 'h.acc'), dumps: path.join(dir, 'dumps'), out: path.join(dir, 'h.xdb'),
      filtered: fdir }));
    assert.deepStrictEqual(fetched, []);
    assert.ok(recordsOf(path.join(dir, 'h.xdb')).equals(keptAt(3)));
  });

  console.log('\nexplorerdb: filtering a dump for download');
  const F = await load('tools/explorerdb/filter.mjs');
  await check('a kept game keeps its five headers and plies + 1 moves, nothing else', () => {
    const g = F.compactGame(game(base), 3);
    assert.strictEqual(g, '[Event "?"]\n[Result "1-0"]\n[WhiteElo "1700"]\n[BlackElo "1600"]\n' +
      '[TimeControl "300+0"]\n\ne4 c5 Nf3?! d6 1-0\n\n');
    assert.deepStrictEqual(f(g, why).result, 0);
  });
  const fdir = path.join(tmp, 'filtered');
  const fm = await F.filterDump({ input: dumpFile, out: path.join(fdir, 'm'), plies: PLIES,
    partBytes: 1200, chunkBytes: 500 });
  await check('the filter keeps what import keeps, in parts under the size, with their hashes', () => {
    assert.strictEqual(fm.games.read, 403);
    assert.strictEqual(fm.games.kept, wantKept);
    assert.ok(fm.parts.length >= 3, fm.parts.length + ' parts');
    assert.strictEqual(fm.parts.reduce((n, p) => n + p.games, 0), wantKept);
    for (const p of fm.parts) {
      const b = fs.readFileSync(path.join(fdir, p.file));
      assert.ok(b.length === p.bytes && p.bytes <= 1200, p.file + ' ' + b.length);
      assert.strictEqual(require('crypto').createHash('sha256').update(b).digest('hex'), p.sha256);
      assert.ok(/\n\n$/.test(zlib.zstdDecompressSync(b).toString()), p.file + ' ends inside a game');
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(fdir, 'm.json'), 'utf8')).parts, fm.parts);
  });
  const fIndex = path.join(tmp, 'filtered.xdb');
  const fMeta = await I.importDump({ input: path.join(fdir, 'm.json'), out: fIndex, plies: PLIES,
    minGames: 1, workers: 2 });
  await check('importing the filtered parts counts exactly what importing the dump did', () => {
    const fdb = S.openIndex(fIndex);
    try {
      assert.strictEqual(fMeta.source, 'dump.pgn');
      assert.strictEqual(fMeta.report.games.kept, wantKept);
      assert.strictEqual(fMeta.report.positions, meta.report.positions);
      for (const k of want.keys()) assert.deepStrictEqual(fdb.records(G.keyOf(k)), db.records(G.keyOf(k)), k);
    } finally {
      fdb.close();
    }
  });
  await check('a filtered month refuses more plies, other ratings, and a part not fully downloaded', async () => {
    const man = path.join(fdir, 'm.json');
    await assert.rejects(I.importDump({ input: man, out: path.join(tmp, 'p.xdb'), plies: PLIES + 1 }),
      /filtered to 30 plies/);
    await assert.rejects(I.importDump({ input: man, out: path.join(tmp, 'p.xdb'), plies: PLIES,
      ratings: [1400, 1600] }), /has no 1400 games/);
    const last = path.join(fdir, fm.parts[fm.parts.length - 1].file);
    fs.truncateSync(last, 100);
    await assert.rejects(I.importDump({ input: man, out: path.join(tmp, 'p.xdb'), plies: PLIES }),
      /not fully downloaded/);
    assert.ok(!fs.existsSync(path.join(tmp, 'p.xdb.tmp')), 'temporary files left');
  });

  const partsText = (dir, man) => man.parts.map(p => zlib.zstdDecompressSync(fs.readFileSync(path.join(dir, p.file))).toString('latin1')).join('');
  await check('a filter stopped after a part goes on from its checkpoint, and keeps exactly the same games', async () => {
    const cps = [], cdir = path.join(tmp, 'cp1'), rdir = path.join(tmp, 'cp2');
    const whole = await F.filterDump({ input: dumpFile, out: path.join(cdir, 'm'), plies: PLIES, partBytes: 1200, chunkBytes: 500,
      onPart: async (p, cp) => { cps.push(JSON.parse(JSON.stringify(cp))); } });
    assert.strictEqual(cps.length, whole.parts.length - 1);
    assert.deepStrictEqual(cps[1].parts, whole.parts.slice(0, 2));
    assert.strictEqual(cps[1].kept, whole.parts[0].games + whole.parts[1].games);
    // The resumed run has only what a recycled container would: the checkpoint.
    const res = await F.filterDump({ input: dumpFile, out: path.join(rdir, 'm'), plies: PLIES, partBytes: 1200, chunkBytes: 500,
      resume: cps[1] });
    assert.deepStrictEqual(res.games, whole.games);
    assert.deepStrictEqual(res.parts.slice(0, 2), whole.parts.slice(0, 2));
    assert.strictEqual(res.resumed, 2);
    assert.ok(!fs.existsSync(path.join(rdir, whole.parts[0].file)), 'wrote a part again');
    for (const p of whole.parts.slice(0, 2)) fs.copyFileSync(path.join(cdir, p.file), path.join(rdir, p.file));
    assert.strictEqual(partsText(rdir, res), partsText(cdir, whole));
    await assert.rejects(F.filterDump({ input: dumpFile, out: path.join(tmp, 'cp3', 'm'), plies: PLIES,
      resume: Object.assign({}, cps[1], { next: '[Event "Rated Bullet game"]\n[Site "https://lichess.org/xxxxxxxx"]' }) }),
      e => e.resumeMismatch && /changed since the checkpoint/.test(e.message));
    await assert.rejects(F.filterDump({ input: dumpFile, out: path.join(tmp, 'cp3', 'm'), plies: PLIES + 1, resume: cps[1] }),
      e => e.resumeMismatch);
  });

  await check('a download that breaks is picked up where it broke off', async () => {
    // A stand-in for curl: serves the file from -r's offset, and breaks once 3000 bytes in.
    const fake = path.join(tmp, 'fakecurl.js'), count = path.join(tmp, 'fakecurl.n');
    fs.writeFileSync(fake, `const fs = require('fs');
      const a = process.argv.slice(2), r = a.indexOf('-r'), from = r < 0 ? 0 : parseInt(a[r + 1]);
      const n = fs.existsSync(${JSON.stringify(count)}) ? +fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 0;
      fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
      const b = fs.readFileSync(a[a.length - 1].replace('https://x/', ''));
      if (n === 0) { process.stdout.write(b.subarray(0, 3000), () => process.exit(56)); }
      else process.stdout.write(b.subarray(from));`);
    const chunks = [];
    for await (const c of I.curlStream('https://x/' + dumpFile, { curl: [process.execPath, fake], waitMs: 1 })) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(fs.readFileSync(dumpFile)));
    assert.strictEqual(fs.readFileSync(count, 'utf8'), '2');
  });

  console.log('\nexplorerdb: combining months');
  const mdir = path.join(tmp, 'months');
  fs.mkdirSync(mdir);
  // The test dump as three "months".
  const allGames = pgn.split(/(?=\[Event )/).filter(Boolean);
  const thirds = [0, 1, 2].map(i => {
    const f = path.join(mdir, `m${i}.pgn`);
    fs.writeFileSync(f, allGames.filter((_, j) => j % 3 === i).join(''));
    return f;
  });
  const monthIndex = async (minGames, tag) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const x = path.join(mdir, `${tag}${i}.xdb`);
      await I.importDump({ input: thirds[i], out: x, plies: PLIES, minGames, workers: 1 });
      out.push(x);
    }
    return out;
  };
  const sameAsWhole = (file, minGames, label) => {
    const x = S.openIndex(file);
    try {
      let positions = 0;
      for (const [k, e] of want) {
        const n = e.tot[0] + e.tot[1] + e.tot[2];
        const got = x.records(G.keyOf(k));
        if (n >= minGames) { positions++; assert.deepStrictEqual(got, db.records(G.keyOf(k)), label + ' ' + k); }
        else assert.deepStrictEqual(got, [], label + ' kept ' + k);
      }
      assert.strictEqual(x.meta.report.positions, positions, label);
      assert.strictEqual(x.meta.report.games.kept, wantKept, label);
    } finally { x.close(); }
  };
  const ones = await monthIndex(1, 'one');
  await check('merging months indexed in full gives exactly the index of all their games', async () => {
    const m1 = await M.mergeIndexes({ inputs: ones, out: path.join(mdir, 'all1.xdb'), minGames: 1 });
    assert.strictEqual(m1.merged.length, 3);
    sameAsWhole(path.join(mdir, 'all1.xdb'), 1, 'N>=1');
    await M.mergeIndexes({ inputs: ones, out: path.join(mdir, 'all3.xdb'), minGames: 3 });
    sameAsWhole(path.join(mdir, 'all3.xdb'), 3, 'N>=3');
  });
  await check('...months indexed at N >= 2 only ever undercount, and only where a month was thin', async () => {
    const twos = await monthIndex(2, 'two');
    await M.mergeIndexes({ inputs: twos, out: path.join(mdir, 'all2.xdb'), minGames: 1 });
    const x = S.openIndex(path.join(mdir, 'all2.xdb'));
    let short = 0;
    try {
      for (const k of want.keys()) {
        const whole = db.records(G.keyOf(k));
        for (const r of x.records(G.keyOf(k))) {
          const w = whole.find(y => y.code === r.code);
          assert.ok(w && r.white <= w.white && r.draws <= w.draws && r.black <= w.black, k);
          if (r.white + r.draws + r.black < w.white + w.draws + w.black) short++;
        }
      }
    } finally { x.close(); }
    assert.ok(short > 0, 'expected some undercounts in so small a test');
  });
  await check('...and a merge refuses the same month twice, or another ply limit', async () => {
    await assert.rejects(M.mergeIndexes({ inputs: [ones[0], ones[1], ones[0]], out: path.join(mdir, 'dup.xdb') }),
      /both hold m0\.pgn/);
    await assert.rejects(M.mergeIndexes({ inputs: [path.join(mdir, 'all1.xdb'), ones[2]], out: path.join(mdir, 'dup.xdb') }),
      /both hold m2\.pgn/);
    const p20 = path.join(mdir, 'p20.xdb');
    await I.importDump({ input: thirds[0], out: p20, plies: 20, minGames: 1, workers: 1 });
    await assert.rejects(M.mergeIndexes({ inputs: [p20, ones[1]], out: path.join(mdir, 'bad.xdb') }), /Different plies: one1\.xdb has 30, p20\.xdb 20/);
    assert.ok(!fs.existsSync(path.join(mdir, 'dup.xdb.partial')) && !fs.existsSync(path.join(mdir, 'bad.xdb')));
  });
  await check('importing a folder of filtered months counts them together, exactly', async () => {
    const year = path.join(mdir, 'year');
    for (let i = 0; i < 3; i++) {
      await F.filterDump({ input: thirds[i], out: path.join(year, `2019-0${i + 1}`), plies: PLIES });
    }
    const ym = await I.importDump({ input: year, out: path.join(mdir, 'year.xdb'), plies: PLIES, minGames: 3, workers: 2 });
    assert.match(ym.source, /^3 filtered months, 2019-01\.\.2019-03$/);
    sameAsWhole(path.join(mdir, 'year.xdb'), 3, 'folder');
  });

  console.log('\nexplorerdb: the relay (fill in the cloud, drain at home)');
  const R = await load('tools/explorerdb/relay.mjs');
  await check('months parse as ranges and lists', () => {
    assert.deepStrictEqual(R.parseMonths('2016-11..2017-02, 2016-12,2018-05'),
      ['2016-11', '2016-12', '2017-01', '2017-02', '2018-05']);
    assert.throws(() => R.parseMonths('2017-13'), /No month/);
    assert.deepStrictEqual(R.parseLedger('2017-01 5 9\n\n2017-02 1 2\n'), { '2017-01': '2017-01 5 9', '2017-02': '2017-02 1 2' });
    assert.strictEqual(R.repoName('https://github.com/a/database_helper2.git'), 'database_helper2');
  });
  await check('a month goes to the repository with most room, or waits', () => {
    const snap = (bytes, subject, loose) => ({ months: bytes ? { '2017-01': { bytes } } : {}, loose: loose || [], subject });
    const plans = [R.repoPlan(snap(2e9, 'x'), 3e9, 0), R.repoPlan(snap(0, 'consumed: 2017-01'), 3e9, 0),
      R.repoPlan(snap(0, 'reset: y'), 3e9, 2.5e9)];
    assert.deepStrictEqual(plans.map(p => [p.reset, p.idle]), [[false, false], [true, true], [false, false]]);
    assert.strictEqual(R.pickRepo(plans, 1e9), 1);
    assert.strictEqual(R.pickRepo([plans[0], plans[2]], 0.9e9), 0);
    assert.strictEqual(R.pickRepo([plans[0], plans[2]], 1.1e9), null);
    assert.strictEqual(R.pickRepo([R.repoPlan(snap(0, 'reset'), 3e9, 0)], 5e9), 0);   // too big, but idle
    assert.strictEqual(R.repoPlan(snap(0, 'consumed: x', ['2017/2017-02.1.pgn.zst']), 3e9, 0).reset, false);
  });

  const gitOk = await R.git(['--version']).then(() => true, () => false);
  if (gitOk) {
    const env = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' };
    const saved = {};
    Object.keys(env).forEach(k => { saved[k] = process.env[k]; process.env[k] = env[k]; });
    try {
      const rel = path.join(tmp, 'relay');
      const repos = [];
      for (const name of ['helperA', 'helperB']) {
        const bare = path.join(rel, name + '.git');
        await R.git(['init', '-q', '--bare', '-b', 'main', bare]);
        await R.git(['config', 'uploadpack.allowFilter', 'true'], bare);
        const seed = path.join(rel, 'seed-' + name);
        await R.git(['clone', '-q', bare, seed]);
        fs.writeFileSync(path.join(seed, 'README.md'), '# ' + name + '\n');
        await R.git(['add', 'README.md'], seed);
        await R.git(['commit', '-q', '-m', 'README'], seed);
        await R.git(['push', '-q', 'origin', 'HEAD:main'], seed);
        repos.push(pathToFileURL(bare).href);
      }
      // One month as the filter writes it, to size the cap: each repository holds one.
      const probe = await F.filterDump({ input: dumpFile, out: path.join(rel, 'probe', 'p'), plies: PLIES,
        partBytes: 2000, chunkBytes: 800 });
      const monthBytes = probe.parts.reduce((n, p) => n + p.bytes, 0);
      const months = R.parseMonths('2020-01..2020-05');
      const logs = [];
      const filling = R.fill({ repos, months, work: path.join(rel, 'work'), capBytes: monthBytes * 1.5,
        pushBytes: 4000, workers: 2, pollMs: 50, footer: 'Relay-Test: yes', log: s => logs.push(s),
        dumpSize: m => m === '2020-04' ? 0 : monthBytes / 0.12,
        filterMonth: (m, out) => F.filterDump({ input: dumpFile, out, source: m, plies: PLIES,
          partBytes: 2000, chunkBytes: 800 }) });
      const out = path.join(rel, 'home');
      const draining = R.drain({ repos, dir: path.join(out, 'clones'), keep: path.join(out, 'kept'), out,
        until: ['2020-01', '2020-02', '2020-03', '2020-05'], pollMs: 50, footer: 'Relay-Test: yes', log: s => logs.push(s),
        importOptions: { plies: PLIES, minGames: 1, workers: 1 } });
      const [filled, drained] = await Promise.all([filling, draining]);
      await check('fill pushes months as drain makes room, and drain imports each of them', () => {
        assert.deepStrictEqual(filled, { pushed: 4, skipped: ['2020-04'], failed: [], elsewhere: [] }, logs.join('\n'));
        assert.deepStrictEqual(drained.slice().sort(), ['2020-01', '2020-02', '2020-03', '2020-05']);
        assert.ok(logs.some(s => /2020-04: no dump published/.test(s)));
        for (const m of drained) {
          const x = S.openIndex(path.join(out, m + '.xdb'));
          try { assert.strictEqual(x.meta.report.positions, meta.report.positions, m); } finally { x.close(); }
          assert.ok(fs.existsSync(path.join(out, 'kept', '2020', m + '.json')), m + ' not kept');
        }
      });
      await check('...a repository drained empty is reset, and the ledgers remember every month', async () => {
        const all = {};
        let resets = 0;
        for (const url of repos) {
          const s = await R.snapshot(url, path.join(rel, 'check'));
          assert.deepStrictEqual(Object.keys(s.months), [], url);
          Object.assign(all, s.ledger);
          const log = await R.git(['log', '--format=%s%n%b', 'main'], require('url').fileURLToPath(url));
          if (/^reset: /m.test(log)) resets++;
          assert.ok(/Relay-Test: yes/.test(log), 'footer missing');
          fs.rmSync(s.dir, { recursive: true, force: true });
        }
        assert.deepStrictEqual(Object.keys(all).sort(), ['2020-01', '2020-02', '2020-03', '2020-05']);
        assert.ok(resets >= 1, 'no reset');
      });
      await check('...and a second fill finds nothing left to do', async () => {
        const again = await R.fill({ repos, months, work: path.join(rel, 'work'), pollMs: 50, log: () => {},
          dumpSize: () => { throw new Error('asked'); }, filterMonth: () => { throw new Error('asked'); } });
        assert.deepStrictEqual(again, { pushed: 0, skipped: [], failed: ['2020-04'], elsewhere: [] });   // still unpublished, and asking throws
      });
      await check('...and drain clones again a clone left broken by a crash', async () => {
        // As found on 2026-10-01: HEAD at refs/heads/.invalid, no refs, a stale shallow.lock.
        const clone = path.join(out, 'clones', 'helperA');
        fs.writeFileSync(path.join(clone, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
        fs.rmSync(path.join(clone, '.git', 'refs'), { recursive: true, force: true });
        fs.mkdirSync(path.join(clone, '.git', 'refs', 'heads'), { recursive: true });
        fs.rmSync(path.join(clone, '.git', 'packed-refs'), { force: true });
        fs.writeFileSync(path.join(clone, '.git', 'shallow.lock'), 'x');
        const dlogs = [];
        await R.drain({ repos, dir: path.join(out, 'clones'), keep: path.join(out, 'kept'), out, once: true,
          pollMs: 50, log: s => dlogs.push(s), importOptions: { plies: PLIES, minGames: 1, workers: 1 } });
        assert.ok(!dlogs.some(s => /helperA: /.test(s)), dlogs.join('\n'));
        await R.git(['rev-parse', '--verify', 'HEAD'], clone);
      });
      await check('...and with noImport drain keeps and removes a month without indexing it', async () => {
        const nlogs = [];
        // A month pushed by hand, as fill lays it out: parts and manifest under its year.
        const push = path.join(rel, 'push6');
        await R.git(['clone', '-q', repos[0], push]);
        fs.mkdirSync(path.join(push, '2020'), { recursive: true });
        await F.filterDump({ input: dumpFile, out: path.join(push, '2020', '2020-06'), source: '2020-06', plies: PLIES,
          partBytes: 2000, chunkBytes: 800 });
        await R.git(['add', '2020'], push);
        await R.git(['commit', '-q', '-m', 'month: 2020-06'], push);
        await R.git(['push', '-q', 'origin', 'HEAD:main'], push);
        const kept = path.join(rel, 'kept2');
        await assert.rejects(R.drain({ repos, dir: path.join(out, 'clones'), out, once: true, noImport: true, keep: null }),
          /would lose the months/);
        const got = await R.drain({ repos, dir: path.join(out, 'clones'), keep: kept, out, once: true, noImport: true,
          pollMs: 50, log: s => nlogs.push(s) });
        assert.deepStrictEqual(got, ['2020-06'], nlogs.join('\n'));
        assert.ok(fs.existsSync(path.join(kept, '2020', '2020-06.json')));
        assert.ok(!fs.existsSync(path.join(out, '2020-06.xdb')), 'indexed anyway');
        assert.ok(!fs.readdirSync(path.join(kept, '2020')).some(f => /\.tmp$/.test(f)));
        for (const url of repos) {
          const sn = await R.snapshot(url, path.join(rel, 'check2'));
          assert.deepStrictEqual(Object.keys(sn.months), [], url);
          fs.rmSync(sn.dir, { recursive: true, force: true });
        }
      });
      await check('a second fill from the other end leaves the first one\'s months to it, also ones it pushes meanwhile', async () => {
        // The first session (helperA/B) has 2020-01..03 and 05 in its LEDGERs; the second
        // has its own repository and goes newest first.
        const bareC = path.join(rel, 'helperC.git');
        await R.git(['init', '-q', '--bare', '-b', 'main', bareC]);
        await R.git(['config', 'uploadpack.allowFilter', 'true'], bareC);
        const seed = path.join(rel, 'seed-helperC');
        await R.git(['clone', '-q', bareC, seed]);
        fs.writeFileSync(path.join(seed, 'README.md'), '# helperC\n');
        await R.git(['add', 'README.md'], seed);
        await R.git(['commit', '-q', '-m', 'README'], seed);
        await R.git(['push', '-q', 'origin', 'HEAD:main'], seed);
        const repoC = pathToFileURL(bareC).href;
        const filtered = [], clogs = [];
        const res = await R.fill({ repos: [repoC], others: repos, newestFirst: true,
          months: R.parseMonths('2020-03,2020-04,2020-05,2020-07,2020-08'), work: path.join(rel, 'workC'),
          capBytes: monthBytes * 10, pushBytes: 4000, workers: 1, pollMs: 50, log: s => clogs.push(s),
          dumpSize: () => monthBytes / 0.12,
          filterMonth: async (m, o2) => {
            filtered.push(m);
            const man = await F.filterDump({ input: dumpFile, out: o2, source: m, plies: PLIES,
              partBytes: 2000, chunkBytes: 800 });
            // Meanwhile the first session pushes 2020-04, which this one hasn't reached yet.
            if (m === '2020-08') {
              const src = path.join(rel, 'other04');
              await F.filterDump({ input: dumpFile, out: path.join(src, '2020-04'), source: '2020-04', plies: PLIES,
                partBytes: 2000, chunkBytes: 800 });
              await R.pushMonth(repos[1], '2020-04', src, path.join(rel, 'workO'), { pushBytes: 4000, tries: 3, log: () => {} });
            }
            return man;
          } });
        assert.deepStrictEqual(filtered, ['2020-08', '2020-07'], clogs.join('\n'));
        assert.strictEqual(res.pushed, 2);
        assert.deepStrictEqual(res.elsewhere.slice().sort(), ['2020-03', '2020-04', '2020-05']);
        assert.ok(clogs.some(s => /2020-04: done by the other session \(helperB\), skipped/.test(s)), clogs.join('\n'));
        const sn = await R.snapshot(repoC, path.join(rel, 'checkC'));
        assert.deepStrictEqual(Object.keys(sn.ledger).sort(), ['2020-07', '2020-08']);
        fs.rmSync(sn.dir, { recursive: true, force: true });
      });
      await check('fill pushes each part with a checkpoint, and after a recycle goes on from it', async () => {
        const bareD = path.join(rel, 'helperD.git');
        await R.git(['init', '-q', '--bare', '-b', 'main', bareD]);
        await R.git(['config', 'uploadpack.allowFilter', 'true'], bareD);
        const seed = path.join(rel, 'seed-helperD');
        await R.git(['clone', '-q', bareD, seed]);
        fs.writeFileSync(path.join(seed, 'README.md'), '# helperD\n');
        await R.git(['add', 'README.md'], seed);
        await R.git(['commit', '-q', '-m', 'README'], seed);
        await R.git(['push', '-q', 'origin', 'HEAD:main'], seed);
        const repoD = pathToFileURL(bareD).href;
        const opts = { input: dumpFile, source: '2020-09', plies: PLIES, partBytes: 1200, chunkBytes: 500 };
        const ref = path.join(rel, 'refD');
        const whole = await F.filterDump(Object.assign({ out: path.join(ref, 'm') }, opts));
        assert.ok(whole.parts.length >= 4, whole.parts.length + ' parts');
        const dlogs = [], calls = [];
        // The first container dies once its second part is pushed: its parts and checkpoint
        // are in the repository, nothing else survives.
        const recycled = async (m, out, more) => {
          calls.push(more.resume ? more.resume.parts.length : 0);
          if (calls.length > 1) return F.filterDump(Object.assign({ out }, opts, more));
          let n = 0;
          await F.filterDump(Object.assign({ out }, opts, { onPart: async (p, cp) => {
            await more.onPart(p, cp);
            if (++n === 2) throw new Error('container recycled');
          } }));
        };
        const first = await R.fill({ repos: [repoD], months: ['2020-09'], work: path.join(rel, 'workD1'), capBytes: 1e9,
          pushBytes: 4000, workers: 1, pollMs: 1, tries: 3, log: s => dlogs.push(s), dumpSize: () => 1e6,
          filterMonth: (m, out, more) => calls.length ? Promise.reject(new Error('container gone')) : recycled(m, out, more) });
        assert.deepStrictEqual(first.failed, ['2020-09'], dlogs.join('\n'));
        let sn = await R.snapshot(repoD, path.join(rel, 'checkD'));
        assert.deepStrictEqual(Object.keys(sn.months), []);
        assert.strictEqual(sn.progress['2020-09'].parts.length, 2, 'the part on its way when the filter died is in');
        fs.rmSync(sn.dir, { recursive: true, force: true });
        // A new container: a fresh work directory, the same command.
        calls.length = 0;
        calls.push('new');
        const second = await R.fill({ repos: [repoD], months: ['2020-09'], work: path.join(rel, 'workD2'), capBytes: 1e9,
          pushBytes: 4000, workers: 1, pollMs: 1, log: s => dlogs.push(s), dumpSize: () => 1e6,
          filterMonth: (m, out, more) => recycled(m, out, more) });
        assert.strictEqual(second.pushed, 1, dlogs.join('\n'));
        assert.ok(dlogs.some(s => /2020-09: going on from part 3 \(/.test(s)), dlogs.join('\n'));
        assert.deepStrictEqual(calls, ['new', 2]);
        sn = await R.snapshot(repoD, path.join(rel, 'checkD'));
        assert.deepStrictEqual(sn.loose, []);
        assert.deepStrictEqual(sn.months['2020-09'].manifest.games, whole.games);
        assert.ok(!sn.files.includes(R.progressFile('2020-09')), 'checkpoint left behind');
        fs.rmSync(sn.dir, { recursive: true, force: true });
        const full = path.join(rel, 'fullD');
        await R.git(['clone', '-q', repoD, full]);
        const man = JSON.parse(fs.readFileSync(path.join(full, '2020', '2020-09.json'), 'utf8'));
        assert.deepStrictEqual(fs.readdirSync(path.join(full, '2020')).sort(),
          man.parts.map(p => p.file).concat(['2020-09.json']).sort());
        for (const p of man.parts) {
          assert.strictEqual(require('crypto').createHash('sha256').update(fs.readFileSync(path.join(full, '2020', p.file))).digest('hex'), p.sha256);
        }
        assert.strictEqual(partsText(path.join(full, '2020'), man), partsText(ref, whole));
      });

      const bareRepo = async name => {
        const bare = path.join(rel, name + '.git');
        await R.git(['init', '-q', '--bare', '-b', 'main', bare]);
        await R.git(['config', 'uploadpack.allowFilter', 'true'], bare);
        const seed = path.join(rel, 'seed-' + name);
        await R.git(['clone', '-q', bare, seed]);
        fs.writeFileSync(path.join(seed, 'README.md'), '# ' + name + '\n');
        await R.git(['add', 'README.md'], seed);
        await R.git(['commit', '-q', '-m', 'README'], seed);
        await R.git(['push', '-q', 'origin', 'HEAD:main'], seed);
        return pathToFileURL(bare).href;
      };
      // The month as the default part size gives it, imported: what every other run must count.
      const refDir = path.join(rel, 'refSize');
      const refMan = await R.lichessFilter({ plies: PLIES, url: () => dumpFile })('2020-10', path.join(refDir, '2020-10'), {});
      const refX = path.join(rel, 'refSize.xdb');
      await I.importDump({ input: path.join(refDir, '2020-10.json'), out: refX, plies: PLIES, minGames: 1, workers: 1 });
      const sameRecords = async (repo, month, label) => {
        const full = path.join(rel, 'full-' + label);
        await R.git(['clone', '-q', repo, full]);
        const man = JSON.parse(fs.readFileSync(path.join(full, '2020', month + '.json'), 'utf8'));
        const x = path.join(rel, label + '.xdb');
        await I.importDump({ input: path.join(full, '2020', month + '.json'), out: x, plies: PLIES, minGames: 1, workers: 1 });
        const a = S.openIndex(x), b = S.openIndex(refX);
        try {
          assert.strictEqual(a.meta.report.positions, b.meta.report.positions, label);
          for (const k of want.keys()) assert.deepStrictEqual(a.records(G.keyOf(k)), b.records(G.keyOf(k)), label + ' ' + k);
        } finally { a.close(); b.close(); }
        return { man, full };
      };
      await check('fill --part-mb: smaller parts, each pushed with a valid checkpoint, and the same records', async () => {
        const cli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'explorerdb.mjs'),
          'fill', '--repos', 'a/b', '--part-mb', '0'], { encoding: 'utf8' });
        assert.match(cli.stderr, /--part-mb is at least 1/);
        assert.strictEqual(refMan.parts.length, 1);
        const repoE = await bareRepo('helperE');
        const elogs = [];
        const res = await R.fill({ repos: [repoE], months: ['2020-10'], work: path.join(rel, 'workE'), capBytes: 1e9,
          pushBytes: 4000, workers: 1, pollMs: 1, log: s => elogs.push(s), dumpSize: () => 1e6,
          filterMonth: R.lichessFilter({ plies: PLIES, partBytes: 1200, chunkBytes: 500, url: () => dumpFile }) });
        assert.strictEqual(res.pushed, 1, elogs.join('\n'));
        const { man, full } = await sameRecords(repoE, '2020-10', 'smallParts');
        assert.ok(man.parts.length >= 4, man.parts.length + ' parts');
        assert.ok(man.parts.every(p => p.bytes <= 1200), JSON.stringify(man.parts));
        assert.deepStrictEqual(man.games, refMan.games);
        // One commit per part but the last, each with the checkpoint after it.
        const log = (await R.git(['log', '--format=%H %s', 'main'], full)).trim().split('\n').reverse();
        const partCommits = log.filter(l => / 2020-10: part \d+, /.test(l));
        assert.strictEqual(partCommits.length, man.parts.length - 1);
        for (let i = 0; i < partCommits.length; i++) {
          const cp = JSON.parse(await R.git(['show', partCommits[i].split(' ')[0] + ':' + R.progressFile('2020-10')], full));
          assert.deepStrictEqual(cp.parts, man.parts.slice(0, i + 1));
          assert.strictEqual(cp.kept, man.parts.slice(0, i + 1).reduce((n, p) => n + p.games, 0));
        }
      });
      await check('...and a month started with one part size goes on with another, to the same records', async () => {
        const repoF = await bareRepo('helperF');
        let calls = 0;
        const small = R.lichessFilter({ plies: PLIES, partBytes: 1200, chunkBytes: 500, url: () => dumpFile });
        const flogs = [];
        await R.fill({ repos: [repoF], months: ['2020-10'], work: path.join(rel, 'workF1'), capBytes: 1e9,
          pushBytes: 4000, workers: 1, pollMs: 1, log: s => flogs.push(s), dumpSize: () => 1e6,
          filterMonth: async (m, out, more) => {
            if (calls++) throw new Error('container gone');
            let n = 0;
            await small(m, out, { onPart: async (p, cp) => {
              await more.onPart(p, cp);
              if (++n === 2) throw new Error('container recycled');
            } });
          } });
        const res = await R.fill({ repos: [repoF], months: ['2020-10'], work: path.join(rel, 'workF2'), capBytes: 1e9,
          pushBytes: 4000, workers: 1, pollMs: 1, log: s => flogs.push(s), dumpSize: () => 1e6,
          filterMonth: R.lichessFilter({ plies: PLIES, partBytes: 3000, chunkBytes: 500, url: () => dumpFile }) });
        assert.strictEqual(res.pushed, 1, flogs.join('\n'));
        assert.ok(flogs.some(s => /2020-10: going on from part 3 \(/.test(s)), flogs.join('\n'));
        const { man } = await sameRecords(repoF, '2020-10', 'mixedParts');
        assert.ok(man.parts.slice(0, 2).every(p => p.bytes <= 1200) && man.parts.slice(2).some(p => p.bytes > 1200),
          JSON.stringify(man.parts));
        assert.deepStrictEqual(man.games, refMan.games);
      });
    } finally {
      Object.keys(env).forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    }
  }

  console.log('\nexplorerdb: the server');
  const START = new Chess().fen();
  const SV = await load('tools/explorerdb/server.mjs');
  const P = await load('src/pe/providers.js');
  const logs = [];
  const reported = new Set();
  const ask = u => SV.handle(db, u, reported, l => logs.push(l));
  await check('/info names the index, and /lichess answers like the explorer', () => {
    const info = ask('/info');
    assert.strictEqual(info.status, 200);
    assert.ok(/^dump\.pgn@\d{4}-/.test(info.body.id), info.body.id);
    assert.deepStrictEqual(info.body.filter, meta.filter);
    const a = ask('/lichess?variant=standard&fen=' + encodeURIComponent(fenKey(START)) +
      '&speeds=blitz,rapid,classical&ratings=1600,1800,2000,2200,2500&moves=2');
    const full = S.explorerAnswer(db, START);
    assert.deepStrictEqual([a.body.white, a.body.draws, a.body.black], [full.white, full.draws, full.black]);
    assert.deepStrictEqual(a.body.moves, full.moves.slice(0, 2));
    assert.deepStrictEqual(logs, []);
  });
  await check('a bad request gets a 400 or 404, and another filter is logged once', () => {
    assert.strictEqual(ask('/lichess').status, 400);
    assert.strictEqual(ask('/lichess?fen=nonsense').status, 400);
    assert.strictEqual(ask('/masters?fen=' + encodeURIComponent(START)).status, 404);
    ask('/lichess?fen=' + encodeURIComponent(START) + '&speeds=bullet&ratings=2000');
    ask('/lichess?fen=' + encodeURIComponent(START) + '&speeds=bullet&ratings=2000');
    assert.strictEqual(logs.length, 1);
    assert.ok(/bullet/.test(logs[0]) && /only has blitz, rapid, classical/.test(logs[0]), logs[0]);
  });

  const server = SV.createServer(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = 'localhost:' + server.address().port;
  const FILTER = { speeds: ['blitz'], ratings: [2000] };
  const noCache = { get: () => Promise.reject(new Error('the cache was read')),
    put: () => Promise.reject(new Error('the cache was written')) };
  let tokenAsked = 0;
  let use = address;
  const stats = {};
  const prov = P.createProviders({ fetch, cache: noCache, stats,
    getToken: () => { tokenAsked++; return Promise.resolve(''); },
    localExplorer: () => use });
  await check('providers ask the local explorer: no token, cache or budget, a hit for rounds.js', async () => {
    const counts = { hits: 0, misses: 0 };
    const budget = { limit: 0, spent: 0 };
    const v = await prov.explorer(START, FILTER, () => false, { counts, budget });
    const full = S.explorerAnswer(db, START);
    assert.strictEqual(v.total, full.white + full.draws + full.black);
    assert.deepStrictEqual(v.moves.map(m => m.san), full.moves.map(m => m.san));
    assert.strictEqual(v.moves[0].games, full.moves[0].white + full.moves[0].draws + full.moves[0].black);
    assert.deepStrictEqual([counts.hits, counts.misses, budget.spent, tokenAsked, stats.localRequests],
      [1, 0, 0, 0, 1]);
    const info = await prov.localInfo(address + '/');
    assert.strictEqual(info.id, ask('/info').body.id);
  });
  await check('with the address cleared, the next request goes to Lichess again', async () => {
    use = '';
    await assert.rejects(prov.explorer(START, FILTER, () => false, {}), /the cache was read/);
    use = address;
  });
  await check('addresses are spelled one way, and the local URL is the explorer\'s query', () => {
    assert.strictEqual(P.localAddress(' localhost:9337/ '), 'http://localhost:9337');
    assert.strictEqual(P.localAddress('https://x.lan:1/'), 'https://x.lan:1');
    assert.strictEqual(P.localAddress(''), '');
    const u = P.localExplorerUrl(START, FILTER, 'localhost:9337');
    assert.strictEqual(u, P.explorerUrl(START, FILTER).replace(P.EXPLORER_URL, 'http://localhost:9337/lichess'));
  });
  const other = require('http').createServer((q, r) => { r.end('{}'); });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  await check('a server that isn\'t running, or isn\'t one, says so', async () => {
    await assert.rejects(P.localInfo(fetch, 'localhost:' + other.address().port), /is not a local explorer/);
    const port = other.address().port;
    await new Promise(r => other.close(r));
    await assert.rejects(P.localInfo(fetch, 'localhost:' + port), /nothing answers at http:\/\/localhost:/);
    use = 'localhost:' + port;
    await assert.rejects(prov.explorer(START, FILTER, () => false, {}), /local explorer not answering/);
    use = address;
  });
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  db.close();

  if (typeof zlib.zstdCompressSync === 'function') {
    // As Lichess's dumps are written (pzstd): frames, each behind a skippable frame whose
    // 4-byte payload is its size. Node's decoder alone read 0 games from the real one, and
    // loses every frame after the first when one write holds two.
    const text = fs.readFileSync(dumpFile), third = Math.ceil(text.length / 3);
    const frames = [0, 1, 2].map(i => zlib.zstdCompressSync(text.subarray(i * third, (i + 1) * third),
      { params: { [zlib.constants.ZSTD_c_checksumFlag]: i % 2 } }));
    const pz = Buffer.concat(frames.flatMap(f => {
      const skip = Buffer.alloc(12);
      skip.writeUInt32LE(0x184D2A50, 0); skip.writeUInt32LE(4, 4); skip.writeUInt32LE(f.length, 8);
      return [skip, f];
    }));
    await check('skippable frames are dropped, and no chunk passed on spans two frames', async () => {
      const ends = frames.map((f, i) => frames.slice(0, i + 1).reduce((n, g) => n + g.length, 0));
      for (const step of [1, 7, 4096, pz.length]) {
        const out = [], t = I.zstdFrames();
        t.on('data', b => out.push(b));
        for (let i = 0; i < pz.length; i += step) t.write(pz.subarray(i, i + step));
        await new Promise(r => t.end(r));
        assert.ok(Buffer.concat(out).equals(Buffer.concat(frames)), 'chunks of ' + step);
        let n = 0;
        for (const b of out) {
          assert.ok(!ends.some(e => n < e && n + b.length > e), 'a chunk spans a frame end');
          n += b.length;
        }
      }
    });
    await check('a dump that goes bad after a good frame, or stops inside one, is an error', async () => {
      const first = pz.subarray(0, 12 + frames[0].length);
      for (const [name, bytes, why] of [
        ['bad', Buffer.concat([first, Buffer.from('garbage, not a frame')]), /Not a zstd frame at byte/],
        ['cut', pz.subarray(0, pz.length - 5), /ends inside a zstd frame/]]) {
        fs.writeFileSync(path.join(tmp, name + '.pgn.zst'), bytes);
        await assert.rejects(I.importDump({ input: path.join(tmp, name + '.pgn.zst'),
          out: path.join(tmp, name + '.xdb'), workers: 1 }), why);
        assert.ok(!fs.existsSync(path.join(tmp, name + '.xdb')), name + '.xdb written');
      }
    });
    fs.writeFileSync(dumpFile + '.zst', pz);
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
  // Seen on Windows with Node < 22.15 and no zstd program: the import "read 0 games" and
  // wrote an empty index. Each of these must be an error, and leave no index behind.
  await check('a missing zstd, a file with no games, or a filter nothing passes is an error', async () => {
    const zstd = zlib.createZstdDecompress, envPath = process.env.PATH;
    fs.writeFileSync(path.join(tmp, 'x.pgn.zst'), 'not really zstd');
    delete zlib.createZstdDecompress;          // as on a Node before 22.15
    process.env.PATH = '';                     // and no zstd program
    try {
      await assert.rejects(I.importDump({ input: path.join(tmp, 'x.pgn.zst'), out: path.join(tmp, 'z.xdb'),
        workers: 1 }), /has no zstd built in .* zstd program was not found/);
    } finally {
      if (zstd) zlib.createZstdDecompress = zstd;
      process.env.PATH = envPath;
    }
    fs.writeFileSync(path.join(tmp, 'x.pgn'), 'hello\n');
    await assert.rejects(I.importDump({ input: path.join(tmp, 'x.pgn'), out: path.join(tmp, 'x.xdb'),
      workers: 1 }), /No games in x\.pgn/);
    await assert.rejects(I.importDump({ input: dumpFile, out: path.join(tmp, 'u.xdb'), workers: 1,
      speeds: ['ultraBullet'], ratings: [2500] }), /None of the 403 games passed the filter/);
    ['z.xdb', 'x.xdb', 'u.xdb', 'z.xdb.tmp', 'u.xdb.tmp'].forEach(f =>
      assert.ok(!fs.existsSync(path.join(tmp, f)), f + ' left behind'));
  });
  const m10 = await I.importDump({ input: dumpFile, out: path.join(tmp, 'ten.xdb'), maxGames: 10,
    workers: 1 });
  await check('--max-games stops reading early', () =>
    assert.strictEqual(m10.report.games.read, 10));

  fs.rmSync(tmp, { recursive: true, force: true });
};
