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
  await check('merging three months at N >= 1 gives the whole import\'s records, byte for byte', () => {
    const out = path.join(tmp, 'merged.xdb');
    const mm = M.mergeIndexes(monthIdx, out, 1);
    assert.ok(recordsOf(out).equals(whole));
    assert.strictEqual(mm.report.games.kept, wantKept);
    assert.strictEqual(mm.report.positions, want.size);
    const m3 = M.mergeIndexes(monthIdx, path.join(tmp, 'merged3.xdb'), 3);
    assert.ok(recordsOf(path.join(tmp, 'merged3.xdb')).equals(keptAt(3)));
    assert.strictEqual(m3.report.thresholds.find(t => t.minGames === 3).positions, m3.report.positions);
  });
  await check('indexes with another filter or ply limit are not merged', () => {
    const other = path.join(tmp, 'other.xdb');
    return I.importDump({ input: monthFiles[0], out: other, plies: 20, minGames: 1, workers: 1 }).then(() =>
      assert.throws(() => M.mergeIndexes([monthIdx[0], other], path.join(tmp, 'no.xdb'), 1), /ply limit/));
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
