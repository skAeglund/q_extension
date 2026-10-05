/*
 * pgnclean (tools/pgnclean.mjs): the PGN tree, comment cleaning and transpositions.
 * Called from test/harness.js.
 */

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert');

const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

// The case from the live run: after 3...e6 4.Bxc4, Black's Nf6 and Nc6 reach positions
// that go on under 3...Nf6 and 3...Nc6.
const QGA = `[Event "Practical repertoire"]
[White "Repertoire"]
[Black "Lichess"]
[Result "*"]

1. d4 {Prac 55.0 d5, engine 52.0} 1... d5 {60% of 1,000,000 games} 2. c4 {Prac
55.1 d5, engine 52.2} 2... dxc4 {30% of 200,000 games} 3. e3 {Prac 60.1 d5,
engine 50.0; Nf3 59.0} 3... Nf6 {40% of 97,950 games} (3... e6 {9% of 97,950
games} 4. Bxc4 {Prac 64.0 d5, engine 51.3; Nc3 63.3} 4... c5 {40% of 8,743 games
· not searched yet} (4... Nf6 {38% of 8,743 games · transposes to 3... Nf6 4.
Bxc4 e6}) (4... Nc6 {15% of 8,743 games · transposes to 3... Nc6 4. Bxc4 e6}))
(3... Nc6 {20% of 97,950 games} 4. Bxc4 {Prac 61.0 d3, engine 50.0} 4... e6 {50%
of 5,000 games} 5. Nf3 {Prac 60.0 d3, engine 50.0 · end: few games (8)}) 4. Bxc4
{Prac 62.0 d5, engine 51.0} 4... e6 {70% of 20,000 games} 5. Nf3 {Prac 61.0 d3,
engine 50.1 · end: few games (5)} *
`;

module.exports = async function run(check) {
  const T = await load('tools/repgen/pgntree.mjs');
  const C = await load('tools/repgen/clean.mjs');

  const find = (g, sans) => {
    let nd = g.root;
    for (const san of sans.split(' ')) {
      nd = nd.children.find(c => c.san === san);
      if (!nd) return null;
    }
    return nd;
  };

  console.log('\npgnclean: the PGN tree');
  const RT = `[Event "x"]
[SetUp "1"]
[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]
[Result "*"]

{Before} 1... c5 $1 {Sicilian} (1... e5!? 2. Nf3 ({why not} 2. f4 exf4) 2... Nc6) 2. Nf3 *
`;
  const g1 = T.parsePgn(RT);
  await check('parses moves, variations, comments, NAGs and a start with Black to move', () => {
    assert.strictEqual(g1.length, 1);
    const g = g1[0];
    assert.strictEqual(g.root.comment, 'Before');
    assert.deepStrictEqual(g.root.children.map(c => c.san), ['c5', 'e5']);
    assert.deepStrictEqual(g.root.children[0].nags, ['$1']);
    assert.strictEqual(g.root.children[1].suffix, '!?');
    assert.strictEqual(find(g, 'e5 f4').pre, 'why not');
    assert.ok(find(g, 'c5 Nf3').fen.startsWith('rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b'));
  });
  const again = T.parsePgn(T.writePgn(g1));
  await check('writing and reading back gives the same tree', () => {
    const shape = nd => ({ san: nd.san, s: nd.suffix, n: nd.nags, c: nd.comment, p: nd.pre,
      k: nd.children.map(shape) });
    assert.deepStrictEqual(shape(again[0].root), shape(g1[0].root));
    assert.ok(T.writePgn(g1).includes('\n\n{Before} 1... c5 $1 {Sicilian} (1... e5!? 2. Nf3'), T.writePgn(g1));
  });
  await check('an illegal move is an error that says where', () =>
    assert.throws(() => T.parsePgn('1. e4 e5 2. Ke3 *'), /Illegal move "Ke3" after e4 e5/));

  console.log('\npgnclean: comments');
  await check('the played share is kept, without the game count', () =>
    assert.strictEqual(C.cleanComment('9% of 97,950\ngames · end: few games (5)'), '9%'));
  await check('Prac values and engine moves go entirely', () => {
    assert.strictEqual(C.cleanComment('Prac 64.0 d5, engine 51.3; Nc3 63.3'), null);
    assert.strictEqual(C.cleanComment('engine move 51.0, few games · end: depth limit'), null);
  });
  await check('your own notes stay', () => {
    assert.strictEqual(C.cleanComment('12% of 1,234 games · watch for Qb6'), '12% · watch for Qb6');
    assert.strictEqual(C.cleanComment('Plan: queenside\n\nThen b4'), 'Plan: queenside\n\nThen b4');
  });

  await check("deeprep's notes go too, and your words in them stay", () => {
    assert.strictEqual(C.cleanComment('87 positions to know; in sample 58.5% (everyone 52.2%);\nreplies not covered 9%'), null);
    assert.strictEqual(C.cleanComment('score 55.3: deep 57.7, ChessDB 50.0, Prac 50.4 · 38,798 games, raw 52.7 · sound ' +
      '57.6, blunders 13% · learning -0.2 (13% new) · over Nf6 56.1, learning -1.4 · also Nf6 53.1, Qb6\n49.3 · Nc6 over ' +
      'the loss limit, f5 unsound · every move over a limit: the safest · ChessDB best Nf6 52.1 · pinned · replies not ' +
      'covered 12% · end: no reply likely enough'), null);
    assert.strictEqual(C.cleanComment('22% of 51,253 games, deep 61.2% ±0.7; replies not covered 4%'), '22%');
    assert.strictEqual(C.cleanComment('best lower bound; deep 66.1% ±1.4, raw 58.9%, 313 games; also O-O 58.1% ±1.6 ' +
      '(590), d6 53.9% ±2.2 (376)'), null);
    assert.strictEqual(C.cleanComment('score 52.3: deep 54.5, Prac 55.2 · Qb6 is a trap; avoid it · sound 55.7'),
      'Qb6 is a trap; avoid it');
    assert.strictEqual(C.cleanComment('deep 64.1% ±2.9, raw 52.7%, 38,798 games; my plan: f5'), 'my plan: f5');
  });

  console.log('\npgnclean: transpositions');
  const [g] = T.parsePgn(QGA);
  const r = C.cleanGame(g, C.sideOfHeaders(g.headers));
  await check('the side comes from repgen\'s headers', () =>
    assert.strictEqual(C.sideOfHeaders(g.headers), 'w'));
  await check('their transposing replies are removed as branches', () => {
    assert.deepStrictEqual(find(g, 'd4 d5 c4 dxc4 e3 e6 Bxc4').children.map(c => c.san), ['c5']);
    assert.strictEqual(r.removed, 2);
  });
  await check('  ...and noted on my move they answered, from where the lines part', () => {
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 e6 Bxc4').comment,
      'Nf6 transposes into 3... Nf6 4. Bxc4 e6\n\nNc6 transposes into 3... Nc6 4. Bxc4 e6');
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 e6').comment, '9%');
  });
  await check('a move with alternatives keeps only its share', () => {
    assert.strictEqual(find(g, 'd4').comment, null);
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 Nf6').comment, '40%');
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 Nc6').comment, '20%');
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 Nf6 Bxc4 e6 Nf3').comment, null);
  });
  await check('a move without alternatives has no share', () => {
    assert.strictEqual(find(g, 'd4 d5').comment, null);
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4').comment, null);
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 Nf6 Bxc4 e6').comment, null);
  });
  await check('  ...including one left alone when the transposing branches went', () =>
    assert.strictEqual(find(g, 'd4 d5 c4 dxc4 e3 e6 Bxc4 c5').comment, null));
  const [own] = T.parsePgn('[White "Repertoire"]\n\n1. e4 e5 {60% of 1,000 games · my plan} ' +
    '(1... c5 {30% of 1,000 games · sharp}) 2. Nf3 Nc6 {90% of 500 games · usual} *');
  C.cleanGame(own, 'w');
  await check('your own words stay, joined to the share where there is one', () => {
    assert.strictEqual(find(own, 'e4 e5').comment, '60% · my plan');
    assert.strictEqual(find(own, 'e4 c5').comment, '30% · sharp');
    assert.strictEqual(find(own, 'e4 e5 Nf3 Nc6').comment, 'usual');
  });
  const out = T.writePgn([g]);
  await check('the written PGN reads back, notes and all', () => {
    const [b] = T.parsePgn(out);
    assert.strictEqual(find(b, 'd4 d5 c4 dxc4 e3 e6 Bxc4').comment.replace(/\s*\n\s*\n\s*/g, '|').replace(/\s+/g, ' '),
      'Nf6 transposes into 3... Nf6 4. Bxc4 e6|Nc6 transposes into 3... Nc6 4. Bxc4 e6');
    assert.ok(!/Prac \d|games|transposes to/.test(out), out);
  });

  // 1.d4 e6 2.Nf3 d5 3.c4 reaches the position after 1.d4 d5 2.c4 e6 3.Nf3, which goes on.
  const MINE = `[White "Repertoire"]
[Black "Lichess"]

1. d4 d5 (1... e6 2. Nf3 d5 3. c4) 2. c4 e6 3. Nf3 Nf6 4. g3 *`;
  const [m] = T.parsePgn(MINE);
  const rm = C.cleanGame(m, 'w');
  await check('my transposing move stays, marked', () => {
    assert.strictEqual(find(m, 'd4 e6 Nf3 d5 c4').comment, 'Transposes into 1... d5 2. c4 e6 3. Nf3');
    assert.deepStrictEqual([rm.removed, rm.marked], [0, 1]);
  });

  const [f] = T.parsePgn(`[White "Lichess"]
[Black "Repertoire"]

1. d4 d5 2. Nf3 Nf6 (2... c6 3. c4) 3. c4 *`);
  const rf = C.cleanGame(f, C.sideOfHeaders(f.headers));
  await check('a line end that transposes nowhere is left alone', () =>
    assert.deepStrictEqual([rf.removed, rf.marked], [0, 0]));

  // Black's repertoire: 1.Nf3 Nf6 2.d4 reaches 1.d4 Nf6 2.Nf3, which goes on.
  const [e] = T.parsePgn(`[White "Lichess"]
[Black "Repertoire"]

1. d4 (1. Nf3 {20% of 1,000 games} 1... Nf6 2. d4) 1... Nf6 2. Nf3 d5 3. c4 (3. Bf4 c5) *`);
  const re = C.cleanGame(e, C.sideOfHeaders(e.headers));
  await check("for Black, White's transposing move goes onto my move it answered", () => {
    assert.strictEqual(re.removed, 1);
    assert.strictEqual(find(e, 'Nf3 Nf6').comment, 'd4 transposes into 1. d4 Nf6 2. Nf3');
    assert.strictEqual(find(e, 'Nf3').comment, '20%');
    assert.deepStrictEqual(find(e, 'Nf3 Nf6').children, []);
  });
};
