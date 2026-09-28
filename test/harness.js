/*
 * Runs src/main-world.js for real, against a stubbed DOM and a reconstruction of the
 * test study's move tree, and asserts it finds what the live page found (3 transposing
 * positions, 8 marked moves).
 *
 *     node test/harness.js
 *
 * The 19 move paths below were dumped from the live study at
 * qchess.net/study/3411d48d-b0f1-43fb-a667-b49057243e1c.
 *
 * Matching is confined to the open chapter, so studyData.chapters is only here to prove
 * nothing reaches into the other one.
 *
 * FENs are stood in for by the sorted multiset of moves played plus a real move counter,
 * which for these lines (pure move-order permutations) collides in exactly the same
 * places real FENs do. _repStripFen is the site's real implementation, so the key path
 * is genuine, and the fullmove field is real so move labels are too.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ------------------------------------------------------------ the study */

const PATHS = [
  'Nf3', 'Nf3 d5', 'Nf3 d5 c4', 'Nf3 d5 c4 d4',
  'Nf3 d5 c4 d4 g3', 'Nf3 d5 c4 d4 g3 c5', 'Nf3 d5 c4 d4 g3 c5 b4', 'Nf3 d5 c4 d4 g3 c5 b4 cxb4',
  'Nf3 d5 c4 d4 b4', 'Nf3 d5 c4 d4 b4 c5', 'Nf3 d5 c4 d4 b4 c5 g3', 'Nf3 d5 c4 d4 b4 c5 g3 cxb4',
  'Nf3 d5 b4', 'Nf3 d5 b4 c5', 'Nf3 d5 b4 c5 c4', 'Nf3 d5 b4 c5 c4 d4',
  'Nf3 d5 b4 c5 c4 d4 g3', 'Nf3 d5 b4 c5 c4 d4 g3 cxb4', 'Nf3 d5 b4 c5 c4 d4 d3',
  // Transposes nowhere; it is here to give the notation one variation that opens with a
  // Black move, since every branch point in the lines above happens to be White's.
  'Nf3 d5 c4 e6'
];

const KEYS = {
  'Nf3': '0-0', 'Nf3 d5': '0-1', 'Nf3 d5 c4': '0-2', 'Nf3 d5 c4 d4': '0-3',
  'Nf3 d5 c4 d4 g3': '0-4', 'Nf3 d5 c4 d4 g3 c5': '0-5',
  'Nf3 d5 c4 d4 g3 c5 b4': '0-6', 'Nf3 d5 c4 d4 g3 c5 b4 cxb4': '0-7',
  'Nf3 d5 c4 d4 b4': '1-4', 'Nf3 d5 c4 d4 b4 c5': '1-5',
  'Nf3 d5 c4 d4 b4 c5 g3': '1-6', 'Nf3 d5 c4 d4 b4 c5 g3 cxb4': '1-7',
  'Nf3 d5 b4': '2-2', 'Nf3 d5 b4 c5': '2-3', 'Nf3 d5 b4 c5 c4': '2-4',
  'Nf3 d5 b4 c5 c4 d4': '2-5', 'Nf3 d5 b4 c5 c4 d4 g3': '2-6',
  'Nf3 d5 b4 c5 c4 d4 g3 cxb4': '2-7', 'Nf3 d5 b4 c5 c4 d4 d3': '3-6',
  'Nf3 d5 c4 e6': '4-3'
};

// placement field stands in for the position; side + fullmove are real.
const fenFor = p => {
  const moves = p.split(' ').filter(Boolean);
  const side = moves.length % 2 ? 'b' : 'w';
  const fullmove = Math.floor(moves.length / 2) + 1;
  return `${moves.slice().sort().join('_')} ${side} - - 0 ${fullmove}`;
};

function buildTree() {
  const root = { move: '', fen: 'start w - - 0 1', children: [], variationId: 0, moveIndex: -1 };
  const byPath = { '': root };
  for (const p of PATHS) {
    const moves = p.split(' ');
    const [variationId, moveIndex] = KEYS[p].split('-').map(Number);
    const node = {
      move: moves[moves.length - 1], fen: fenFor(p),
      children: [], variationId, moveIndex, _path: p
    };
    byPath[moves.slice(0, -1).join(' ')].children.push(node);
    byPath[p] = node;
  }
  return { root };
}

/* --------------------------------------------------------------- mini DOM */

function matches(el, sel) {
  return sel.split(',').map(s => s.trim()).some(s => {
    if (s.startsWith('.')) return el._classes.has(s.slice(1));
    const attr = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(s);
    if (attr) {
      const v = el.attrs[attr[1]];
      return v !== undefined && (attr[2] === undefined || v === attr[2]);
    }
    return el.tagName === s;
  });
}

let clickSpy = [];

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], attrs: {}, textContent: '', title: '',
    _classes: new Set(), _style: {}, _listeners: {}, parent: null
  };
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: v => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  el.classList = {
    add: (...c) => c.forEach(x => el._classes.add(x)),
    remove: (...c) => c.forEach(x => el._classes.delete(x)),
    contains: c => el._classes.has(c)
  };
  el.style = {
    setProperty: (k, v) => { el._style[k] = v; },
    removeProperty: k => { delete el._style[k]; }
  };
  Object.defineProperty(el, 'id', {
    get: () => el.attrs.id || '',
    set: v => { el.attrs.id = String(v); }
  });
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = k => (k in el.attrs ? el.attrs[k] : null);
  el.removeAttribute = k => { delete el.attrs[k]; };
  el.appendChild = c => { c.parent = el; el.children.push(c); return c; };
  el.insertBefore = (c, ref) => {
    const i = ref ? el.children.indexOf(ref) : -1;
    c.parent = el;
    if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
    return c;
  };
  Object.defineProperty(el, 'parentNode', { get: () => el.parent });
  Object.defineProperty(el, 'nextSibling', {
    get: () => {
      if (!el.parent) return null;
      const i = el.parent.children.indexOf(el);
      return el.parent.children[i + 1] || null;
    }
  });
  el.addEventListener = (t, fn) => { (el._listeners[t] ||= []).push(fn); };
  el.removeEventListener = () => {};
  el.remove = () => {
    if (!el.parent) return;
    const i = el.parent.children.indexOf(el);
    if (i >= 0) el.parent.children.splice(i, 1);
    el.parent = null;
  };
  el.removeChild = c => { c.remove(); return c; };
  // Text nodes live in `children` too (see makeText), so childNodes is the same list.
  el.nodeType = 1;
  Object.defineProperty(el, 'childNodes', { get: () => el.children });
  el.closest = sel => {
    let n = el;
    while (n) { if (matches(n, sel)) return n; n = n.parent; }
    return null;
  };
  el.getBoundingClientRect = () => ({ left: 10, top: 10, right: 30, bottom: 26 });
  el.click = () => { clickSpy.push(el.getAttribute('data-node')); };
  el.querySelector = sel => descend(el, sel)[0] || null;
  el.querySelectorAll = sel => descend(el, sel);
  return el;
}

// A text node: an element-shaped stub (so the selector walk can pass over it) with
// nodeType 3 and a nodeValue.
function makeText(v) {
  const t = makeEl('#text');
  t.nodeType = 3;
  t.nodeValue = String(v);
  t.textContent = String(v);
  return t;
}
// What the browser's textContent would give for an element holding text nodes.
const textOf = el => el.nodeType === 3 ? el.nodeValue
  : (el.children.length ? el.children.map(textOf).join('') : el.textContent);

function descend(root, sel, out = []) {
  for (const c of root.children) {
    if (matches(c, sel)) out.push(c);
    descend(c, sel, out);
  }
  return out;
}

/*
 * Build #moves the way the page does:
 *
 *   main line    .added-move > .move-in-nota[data-node]
 *   variation    .variation-row > .variation-content > .variation-line
 *                  > .variation-move-group[data-node] > .move-in-nota[data-node]
 *   sub-branch   the same group spans inside a .branch-variation in that line
 *
 * Variation ids map onto that: 0 is the main line, 1/2/4 hang off it, and 3 branches
 * off 2. Both the group and the move span carry data-node, as on the page, so the
 * group - first in document order - is what the extension finds and marks up.
 */
const movesRoot = makeEl('div');
movesRoot._classes.add('moves');
const moveEls = new Map();
const lines = new Map();

function moveEl(p, ...classes) {
  const el = makeEl('div');
  classes.forEach(c => el._classes.add(c));
  el.setAttribute('data-node', KEYS[p]);
  el.textContent = p.split(' ').pop();
  return el;
}

function newVariationLine() {
  const row = makeEl('div');
  row._classes.add('variation-row');
  const content = makeEl('div');
  content._classes.add('variation-content');
  const line = makeEl('span');
  line._classes.add('variation-line');
  content.appendChild(line);
  row.appendChild(content);
  movesRoot.appendChild(row);
  return line;
}

function lineFor(vid) {
  if (!lines.has(vid)) {
    if (vid === 3) {                       // a branch off variation 2, nested in its line
      const branch = makeEl('span');
      branch._classes.add('branch-variation');
      lines.get(2).appendChild(branch);
      lines.set(vid, branch);
    } else {
      lines.set(vid, newVariationLine());
    }
  }
  return lines.get(vid);
}

for (const p of PATHS) {
  const vid = Number(KEYS[p].split('-')[0]);
  if (vid === 0) {
    const row = makeEl('div');
    row._classes.add('added-move');
    const el = moveEl(p, 'move-in-nota');
    row.appendChild(el);
    movesRoot.appendChild(row);
    moveEls.set(KEYS[p], el);
  } else {
    const group = makeEl('span');
    group._classes.add('variation-move-group');
    group.setAttribute('data-node', KEYS[p]);
    group.appendChild(moveEl(p, 'move-in-nota', 'variation-move'));
    lineFor(vid).appendChild(group);
    moveEls.set(KEYS[p], group);
  }
}

const body = makeEl('body');
const head = makeEl('head');
const roots = [movesRoot, body, head];

/*
 * The explorer panel, built the way the page builds it (see CLAUDE.md, "Explorer panel"):
 * a static #db-column-header, and #database-trees rebuilt from scratch by
 * displayStatistics(stats) - .tree-move rows, one wrapped in .rep-move-group, a novelty
 * row, and a .total-row.
 */
const CELLS = ['move-name', 'move-eval', 'move-global-percentage', 'move-percentage',
  'move-count', 'move-percentages'];

const dbHeader = makeEl('div');
dbHeader.id = 'db-column-header';
CELLS.forEach(c => {
  const x = makeEl('div');
  x._classes.add(c);
  if (c === 'move-percentages') {             // the Score label sits before the bars
    const score = makeEl('span');
    score.id = 'dbh-score-label';
    score.textContent = 'Score';
    dbHeader.appendChild(score);
  }
  dbHeader.appendChild(x);
});
const dbTrees = makeEl('div');
dbTrees.id = 'database-trees';
body.appendChild(dbHeader);
body.appendChild(dbTrees);

// Qchess's maia-integration.js: the Eval header and the Score label sort the table, and
// a click on the sort already on does nothing.
const sortClicks = [];
function siteSetSortMode(mode) {
  sortClicks.push(mode);
  if (global.sortMode === mode) return;
  global.sortMode = mode;
  global.window.displayStatistics(global.lastStatsData, global.lastEvalsData);
}
dbHeader.querySelector('.move-eval').addEventListener('click', () => siteSetSortMode('eval'));
dbHeader.querySelector('[id="dbh-score-label"]').addEventListener('click', () => siteSetSortMode('score'));

// The Score bars, as displayStatistics draws them: three div.percentage-bar with an
// inline width, labelled "<round(x)>%" only from 15% up.
function scoreBars(parent, w, d, b, n) {
  [['white-bar', w], ['draw-bar', d], ['black-bar', b]].forEach(([cls, v]) => {
    const x = makeEl('div');
    x._classes.add('percentage-bar');
    x._classes.add(cls);
    const p = n > 0 ? v / n * 100 : 0;
    x.style.width = `${p}%`;
    if (p >= 15) x.textContent = `${Math.round(p)}%`;
    parent.appendChild(x);
  });
}

function tableRow(san, extra) {
  const r = makeEl('div');
  r._classes.add('tree-move');
  if (extra) r._classes.add(extra);
  r.title = 'Avg White Elo: 2000';
  CELLS.forEach(c => {
    const x = makeEl('div');
    x._classes.add(c);
    if (c === 'move-name') x.textContent = san;
    r.appendChild(x);
  });
  return r;
}

// The evals the last render was given, for the ChessDB checks.
let renderedEvals = null;
function renderTable(stats, evals) {
  renderedEvals = evals;
  dbTrees.children.forEach(c => { c.parent = null; });
  dbTrees.children.length = 0;
  const sum = [0, 0, 0, 0];
  stats.forEach(m => {
    let r;
    if (m.next_move === 'c4') {                 // a repertoire-mode row with its chips
      const wrap = makeEl('div');
      wrap._classes.add('rep-move-group');
      r = wrap.appendChild(tableRow('c4', 'chapter-covered'));
      dbTrees.appendChild(wrap);
    } else {
      r = dbTrees.appendChild(tableRow(m.next_move));
    }
    const c = [m.white_wins, m.draws, m.black_wins, m.total].map(x => parseInt(x, 10) || 0);
    c.forEach((x, i) => { sum[i] += x; });
    scoreBars(r.querySelector('.move-percentages'), c[0], c[1], c[2], c[3]);
  });
  const nov = tableRow('a6');
  const novText = Object.assign(makeEl('span'), { textContent: 'novelty' });
  novText._classes.add('novelty-text');
  nov.querySelector('.move-percentages').appendChild(novText);
  dbTrees.appendChild(nov);
  const total = tableRow('∑', 'total-row');
  scoreBars(total.querySelector('.move-percentages'), sum[0], sum[1], sum[2], sum[3]);
  dbTrees.appendChild(total);
}

const STATS = [
  ['e4', 5000], ['d4', 3000], ['Nf3', 1000], ['c4', 800], ['g3', 150], ['b3', 50]
].map(([next_move, total]) => ({ next_move, total: String(total),
  // 40% / 30% / 30%, as strings like the Elite database sends them
  white_wins: String(total * 0.4), draws: String(total * 0.3), black_wins: String(total * 0.3) }));

// The notation's right-click menu: static markup, shown by showMoveContextMenu() with
// contextMenuTargetMove set to {element, node}.
const ctxMenu = makeEl('div');
ctxMenu.id = 'move-context-menu';
['context-promote', 'context-delete', 'context-copy', 'context-sort'].forEach(id => {
  const x = makeEl('div');
  x._classes.add('context-menu-item');
  x.id = id;
  ctxMenu.appendChild(x);
});
body.appendChild(ctxMenu);

const events = {};
const document = {
  getElementById: id => {
    if (id === 'moves') return movesRoot;
    for (const r of roots) {
      const f = descend(r, `[id="${id}"]`)[0];
      if (f) return f;
    }
    return null;
  },
  querySelector: sel => {
    for (const r of roots) { const f = descend(r, sel)[0]; if (f) return f; }
    return null;
  },
  querySelectorAll: sel => roots.flatMap(r => descend(r, sel)),
  createElement: makeEl,
  createTextNode: makeText,
  addEventListener: (t, fn) => { (events[t] ||= []).push(fn); },
  dispatchEvent: e => { (events[e.type] || []).forEach(fn => fn(e)); return true; },
  head, body, documentElement: head
};

class CustomEventStub {
  constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
}

// Simulate a user click: capture-phase document listeners, same as the real thing, then,
// unless one stopped it, the listeners bound on the target and its ancestors (bubbling).
// Returns whether a capture listener stopped it.
function fireClick(target) {
  let stopped = false;
  const ev = {
    type: 'click', target,
    preventDefault() {}, stopPropagation() { stopped = true; }
  };
  for (const fn of events.click || []) { fn(ev); if (stopped) break; }
  if (stopped) return true;
  for (let n = target; n; n = n.parent) (n._listeners.click || []).forEach(fn => fn(ev));
  return false;
}

/* ------------------------------------------------- page globals (MAIN world) */

let statsSeen = null;
document.addEventListener('qx:stats', e => { statsSeen = e.detail; });

global.document = document;
global.CustomEvent = CustomEventStub;
global.tree = buildTree();
global.activeChapterIndex = 0;
global.studyUuid = 'test-study';
global.studyData = {
  chapters: [
    { name: 'test', pgn: '1. Nf3 d5', perspective: 'white', chapter_uuid: 'a' },
    { name: 'Sideline', pgn: '1. b4 c5', perspective: 'white', chapter_uuid: 'b' }
  ]
};
// The fallbacks for "which side am I?", in the order the extension consults them.
global.REP_STATE = { active: false, perspective: null };
global.userColor = 'white';
global.boardFlipped = false;

// Explorer panel state.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
global.fen = START;
global.lastStatsData = STATS;
global.lichessSettings = { speeds: ['blitz', 'rapid', 'classical'],
  ratings: [1600, 1800, 2000, 2200, 2500], player: '', playerColor: 'white',
  modes: ['rated'], recentOnly: false };
global.selectedDB = 'Elite';
global.sortMode = 'eval';                  // the page's default
// Closed until the Practical tests open it, so the earlier tests' settings pushes don't
// already send the column's first request.
global.databaseTurnedOn = false;

global.contextMenuTargetMove = null;
let ctxClosed = 0;
// What the page's clipboard got; clip.fail makes the next write reject.
const clip = { text: null, fail: false };

global.window = {
  innerWidth: 1280, innerHeight: 800,
  navigator: { clipboard: { writeText: t => {
    if (clip.fail) return Promise.reject(new Error('denied'));
    clip.text = t;
    return Promise.resolve();
  } } },
  closeMoveContextMenu: () => {
    ctxClosed++;
    ctxMenu.classList.remove('active');
    global.contextMenuTargetMove = null;
  },
  addEventListener: () => {},
  _repStripFen: f => (f || '').split(' ').slice(0, 4).join(' '),   // the site's real one
  nodeDataKey: n => `${n.variationId}-${n.moveIndex}`,
  rebuildNotationDisplay: () => {},
  displayStatistics: renderTable
};
// The lifecycle poll is driven by hand: tick() runs one round of it.
let tick = () => {};
global.setInterval = fn => { tick = fn; return 0; };
global.clearTimeout = clearTimeout;
global.setTimeout = setTimeout;

/* ------------------------------------------------------------------- run */

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main-world.js'), 'utf8');
new Function('window', 'document', 'CustomEvent', 'setInterval', src)(
  global.window, document, CustomEventStub, global.setInterval
);

const push = s => document.dispatchEvent(
  Object.assign(new CustomEventStub('qx:settings'), { detail: s }));
const settle = (ms = 140) => new Promise(r => setTimeout(r, ms));

const badges = () => document.querySelectorAll('.qx-badge');
const outlined = () => document.querySelectorAll('.qx-t');
const menu = () => document.querySelector('.qx-menu');
const options = () => document.querySelectorAll('.qx-opt');
const badgeOn = k => moveEls.get(k).children.find(c => c._classes.has('qx-badge'));
// The branch container whose first move is `k` - a .variation-line or, for a branch off
// a branch, the .branch-variation inside one.
const branchOn = k => document.querySelectorAll('.variation-line, .branch-variation')
  .find(c => {
    const first = c.children.find(x => x._classes.has('variation-move-group'));
    return first && first.getAttribute('data-node') === k;
  });
const optText = o => o.children.map(c => c.textContent).join(' | ');

(async () => {
  let failures = 0;
  // Async checks return their promise so the caller can await it; a sync check that
  // throws, or an async one that rejects, counts as a failure either way.
  const check = (name, fn) => {
    const ok = () => console.log('  PASS  ' + name);
    const bad = e => { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message); };
    try {
      const r = fn();
      if (r && typeof r.then === 'function') return r.then(ok, bad);
      ok();
    } catch (e) { bad(e); }
    return Promise.resolve();
  };

  /* --- detection ------------------------------------------------------- */
  push({ enabled: true, outline: true, minBadge: false });
  await settle();

  console.log('\nstyling');
  check('stylesheet is injected', () => {
    const st = document.getElementById('qx-css');
    assert.ok(st, 'no <style id=qx-css> in <head>');
    assert.ok(st.textContent.includes('.qx-badge'), 'stylesheet has no badge rules');
  });
  check('menu overrides the site\'s 1.1x scale', () => {
    const css = document.getElementById('qx-css').textContent;
    assert.ok(/\.qx-menu\{[^}]*transform:none!important/.test(css), 'no transform reset');
    assert.ok(/\.qx-menu\{[^}]*max-width:100%/.test(css), 'menu is not width-capped');
  });
  check('injected only once', () =>
    assert.strictEqual(head.children.filter(c => c.id === 'qx-css').length, 1,
      'got ' + head.children.filter(c => c.id === 'qx-css').length));

  console.log('\nsame-chapter detection');
  check('finds 3 transposing positions', () =>
    assert.strictEqual(statsSeen.groups, 3, 'got ' + statsSeen.groups));
  check('marks 8 moves', () =>
    assert.strictEqual(statsSeen.marked, 8, 'got ' + statsSeen.marked));
  check('one badge per marked move', () =>
    assert.strictEqual(badges().length, 8, 'got ' + badges().length));
  check('outlines the same 8 moves', () =>
    assert.strictEqual(outlined().length, 8, 'got ' + outlined().length));
  check('non-transposing move untouched', () => {
    assert.ok(!badgeOn('3-6'), 'got a badge');
    assert.ok(!moveEls.get('3-6')._classes.has('qx-t'), 'got an outline');
  });

  /* --- the menu -------------------------------------------------------- */
  console.log('\nbranch menu');
  check('no menu before clicking', () => assert.strictEqual(menu(), null));

  check('badge click opens a menu and is not passed on', () => {
    const stopped = fireClick(badgeOn('0-6'));
    assert.ok(stopped, 'event was allowed to reach the site handler');
    assert.ok(menu(), 'no menu opened');
  });

  check('menu uses the site\'s own classes', () => {
    assert.ok(menu()._classes.has('next-moves-menu'), 'class: ' + menu().className);
    assert.ok(options()[0]._classes.has('next-move-option'));
  });

  check('menu sits on its own row, after the move\'s row', () => {
    const row = moveEls.get('0-6').parent;
    assert.strictEqual(row.parent.children[row.parent.children.indexOf(row) + 1], menu());
  });

  check('lists the 2 other move orders', () =>
    assert.strictEqual(options().length, 2, 'got ' + options().length));

  check('labels the move, notes the move order', () => {
    // 'Nf3 d5 c4 d4 b4 c5 g3' -> label 4.g3, order 1.Nf3 d5 2.c4 d4 3.b4 c5
    const texts = options().map(optText);
    assert.ok(texts.some(t => t.startsWith('4.g3 |')), 'labels: ' + JSON.stringify(texts));
    assert.ok(texts.every(t => t.includes('1.Nf3 d5')), 'no move order shown: ' + JSON.stringify(texts));
  });

  check('same label, different order, stays distinguishable', () => {
    const texts = options().map(optText);
    assert.strictEqual(new Set(texts).size, texts.length, 'duplicate rows: ' + JSON.stringify(texts));
  });

  check('the open badge is marked while its menu is up', () =>
    assert.ok(badgeOn('0-6')._classes.has('qx-open'), 'class: ' + badgeOn('0-6').className));

  check('clicking a badge again closes the menu', () => {
    fireClick(badgeOn('0-6'));
    assert.strictEqual(menu(), null);
    assert.ok(!badgeOn('0-6')._classes.has('qx-open'), 'badge left lit');
  });

  /* --- navigation ------------------------------------------------------ */
  console.log('\nnavigation');
  check('clicking an option clicks that move in the notation', () => {
    fireClick(badgeOn('0-6'));
    clickSpy = [];
    const target = options()[0];
    const label = optText(target);
    fireClick(target);
    assert.strictEqual(clickSpy.length, 1, 'clicks: ' + JSON.stringify(clickSpy));
    const expected = label.startsWith('4.g3 | 1.Nf3 d5 2.c4 d4 3.b4') ? '1-6' : '2-6';
    assert.strictEqual(clickSpy[0], expected, 'went to ' + clickSpy[0] + ' for ' + label);
    assert.strictEqual(menu(), null, 'menu stayed open');
  });

  /* --- menu survives a re-render -------------------------------------- */
  console.log('\nresilience');
  check('menu reopens after a notation rebuild', async () => {
    fireClick(badgeOn('0-6'));
    assert.ok(menu(), 'menu did not open');
    push({ enabled: true, outline: true, minBadge: false });
  });
  await settle();
  check('  ...and is still there afterwards', () => {
    assert.ok(menu(), 'menu was wiped by the rebuild');
    assert.strictEqual(options().length, 2);
  });
  fireClick(body);   // click elsewhere
  check('outside click closes it', () => assert.strictEqual(menu(), null));

  /* --- toggles --------------------------------------------------------- */
  push({ enabled: true, outline: false, minBadge: false });
  await settle();
  console.log('\ntoggles');
  check('outline off keeps badges', () => {
    assert.strictEqual(outlined().length, 0, 'outlines: ' + outlined().length);
    assert.strictEqual(badges().length, 8, 'badges: ' + badges().length);
  });

  push({ enabled: false, outline: true, minBadge: false });
  await settle();
  check('disabling clears everything', () =>
    assert.strictEqual(badges().length, 0, 'got ' + badges().length));
  check('reports off', () => assert.strictEqual(statsSeen.off, true));

  /* --- current chapter only -------------------------------------------- */
  push({ enabled: true, outline: true, minBadge: false });
  await settle(400);
  console.log('\ncurrent chapter only');
  check('nothing is reported from other chapters', () => {
    assert.strictEqual(statsSeen.crossPositions, undefined,
      'still reporting cross-chapter hits: ' + statsSeen.crossPositions);
    assert.strictEqual(statsSeen.groups, 3, 'groups: ' + statsSeen.groups);
  });
  check('badge counts only this chapter\'s move orders', () =>
    assert.strictEqual(badgeOn('0-6').textContent, '⇄2', 'got ' + badgeOn('0-6').textContent));
  check('menu lists only this chapter\'s move orders', () => {
    fireClick(badgeOn('0-6'));
    assert.strictEqual(options().length, 2, 'options: ' + options().length);
    assert.ok(!options().some(o => optText(o).includes('Sideline')),
      'another chapter leaked in: ' + JSON.stringify(options().map(optText)));
    fireClick(body);
  });
  check('the study\'s other chapters are never parsed', () => {
    assert.strictEqual(global.window._repParsePgnBatchParallel, undefined,
      'the worker-pool parser is still being reached for');
  });

  /* --- compact badges -------------------------------------------------- */
  push({ enabled: true, outline: true, minBadge: true });
  await settle(200);
  console.log('\ncompact badges');
  check('badge is the glyph alone', () =>
    assert.strictEqual(badgeOn('0-6').textContent, '⇄', 'got ' + badgeOn('0-6').textContent));

  /* --- your-side branches ---------------------------------------------- */
  push({ enabled: true, outline: true, minBadge: false, sides: true });
  await settle();
  console.log('\nyour-side branches');

  check('stylesheet carries the spine rules', () => {
    const css = document.getElementById('qx-css').textContent;
    assert.ok(/\.variation-line\.qx-ub[^{]*\{[^}]*border-left:/.test(css), 'no spine on variations');
    assert.ok(/\.branch-variation\.qx-ub::before\{/.test(css), 'nested branch elbow not recoloured');
  });

  check('your own variations get the bright spine', () => {
    assert.ok(branchOn('1-4')._classes.has('qx-ub'), 'classes: ' + branchOn('1-4').className);
    assert.ok(branchOn('2-2')._classes.has('qx-ub'), 'classes: ' + branchOn('2-2').className);
  });

  check('a branch nested inside one is marked too', () => {
    const b = branchOn('3-6');
    assert.ok(b._classes.has('branch-variation'), 'marked the wrong element: ' + b.className);
    assert.ok(b._classes.has('qx-ub'), 'classes: ' + b.className);
  });

  check('the opponent\'s variation is marked as theirs', () => {
    assert.ok(branchOn('4-3')._classes.has('qx-ob'), 'classes: ' + branchOn('4-3').className);
    assert.ok(!branchOn('4-3')._classes.has('qx-ub'), 'marked as yours');
  });

  check('reports the side and how many variations are yours', () => {
    assert.strictEqual(statsSeen.you, 'white', 'got ' + statsSeen.you);
    assert.strictEqual(statsSeen.yours, 3, 'got ' + statsSeen.yours);
  });

  global.studyData.chapters[0].perspective = 'black';
  push({ sides: true });
  await settle();
  check('the chapter\'s perspective decides which side is yours', () => {
    assert.strictEqual(statsSeen.you, 'black', 'got ' + statsSeen.you);
    assert.ok(branchOn('1-4')._classes.has('qx-ob'), 'White\'s variation still yours');
    assert.ok(branchOn('4-3')._classes.has('qx-ub'), 'Black\'s variation not yours');
  });

  delete global.studyData.chapters[0].perspective;
  global.userColor = 'black';
  push({ sides: true });
  await settle();
  check('falls back to the site\'s own colour setting', () =>
    assert.strictEqual(statsSeen.you, 'black', 'got ' + statsSeen.you));

  global.REP_STATE = { active: true, perspective: 'white' };
  push({ sides: true });
  await settle();
  check('repertoire mode wins over both', () =>
    assert.strictEqual(statsSeen.you, 'white', 'got ' + statsSeen.you));

  global.REP_STATE = { active: false, perspective: null };
  global.userColor = 'white';
  global.studyData.chapters[0].perspective = 'white';

  push({ enabled: false, sides: true });
  await settle();
  check('spines survive the transposition markers being switched off', () => {
    assert.strictEqual(badges().length, 0, 'badges: ' + badges().length);
    assert.ok(branchOn('1-4')._classes.has('qx-ub'), 'classes: ' + branchOn('1-4').className);
  });

  push({ enabled: true, sides: false });
  await settle();
  check('switching them off clears every spine', () =>
    assert.strictEqual(document.querySelectorAll('.qx-ub, .qx-ob').length, 0,
      'left over: ' + document.querySelectorAll('.qx-ub, .qx-ob').length));

  /* --- practical eval: pure parts -------------------------------------- */
  await require('./pe.js')(check);
  await require('./repgen.js')(check);
  await require('./pgnclean.js')(check);
  await require('./cdbexplore.js')(check);

  /* --- practical eval: the column --------------------------------------- */
  console.log('\npractical eval: column');
  const peReqs = [];
  document.addEventListener('qx:pe:request', e => peReqs.push(JSON.parse(e.detail)));
  const peUpdate = (san, result, root) => document.dispatchEvent(Object.assign(
    new CustomEventStub('qx:pe:update'),
    { detail: JSON.stringify({ type: 'update', root: root || START.split(' ').slice(0, 4).join(' '), san, result }) }));
  const row = san => dbTrees.querySelectorAll('.tree-move')
    .find(r => r.querySelector('.move-name').textContent === san);
  const cellOf = san => row(san).querySelector('.qx-pe');
  const after = (parent, cls) => {
    const i = parent.children.findIndex(c => c._classes.has('move-eval'));
    return parent.children[i + 1] && parent.children[i + 1]._classes.has(cls);
  };

  global.databaseTurnedOn = true;
  push({ enabled: true, sides: true, peEnabled: true });
  tick();                                        // hooks displayStatistics
  global.window.displayStatistics(STATS);
  await settle(250);

  await check('the page\'s render function is wrapped', () =>
    assert.ok(global.window.displayStatistics.__qxWrapped, 'not wrapped'));
  await check('one header cell, right after Eval', () => {
    assert.strictEqual(dbHeader.querySelectorAll('.qx-pe-h').length, 1);
    assert.ok(after(dbHeader, 'qx-pe-h'), 'header cell is not after .move-eval');
  });
  await check('every row gets a cell after Eval, wrapped and totals rows included', () => {
    const rows = dbTrees.querySelectorAll('.tree-move');
    assert.strictEqual(rows.length, 8);
    rows.forEach(r => assert.ok(after(r, 'qx-pe'),
      'no cell after Eval in ' + r.querySelector('.move-name').textContent));
  });
  await check('asks for the rows over 2%, most played first', () => {
    assert.strictEqual(peReqs.length, 1, 'requests: ' + peReqs.length);
    assert.deepStrictEqual(peReqs[0].rows, ['e4', 'd4', 'Nf3', 'c4']);
    assert.strictEqual(peReqs[0].add, false);
    assert.strictEqual(peReqs[0].rootFen, START);
  });
  await check('uses the panel\'s Lichess filter and the reply settings', () => {
    assert.deepStrictEqual(peReqs[0].filter.speeds, ['blitz', 'rapid', 'classical']);
    assert.deepStrictEqual(peReqs[0].filter.ratings, [1600, 1800, 2000, 2200, 2500]);
    assert.strictEqual(peReqs[0].opts.replyThreshold, 0.03);
    assert.strictEqual(peReqs[0].opts.minGames, 50);
  });
  await check('requested rows show a faint dot, the rest wait for a click', () => {
    assert.strictEqual(cellOf('e4').textContent, '·');
    assert.ok(cellOf('g3')._classes.has('qx-od'), 'g3: ' + cellOf('g3').className);
    assert.ok(cellOf('a6')._classes.has('qx-od'), 'novelty: ' + cellOf('a6').className);
    assert.strictEqual(cellOf('∑').textContent, '');
  });
  await check('sends the deepening settings and each row\'s share of the games', () => {
    const o = peReqs[0].opts;
    assert.deepStrictEqual([o.maxPly, o.reachFloor, o.ownMargin, o.ownMaxCandidates, o.budget],
      [6, 0.02, 5, 3, 60]);
    assert.strictEqual(peReqs[0].shares.e4, 0.5);
  });
  await check('sends the Maia settings, at the filter\'s rating', () => {
    const o = peReqs[0].opts;
    // Buckets 1600..2500: midpoints 1700 1900 2100 2350 2650, mean 2140, to the nearest 50.
    assert.deepStrictEqual([o.maia, o.maiaElo, o.maiaUntil, o.maiaOnlyBelow, o.maiaWeight],
      [true, 2150, 100, 10, 20]);
  });
  await check('the token never enters this world', () =>
    assert.ok(!JSON.stringify(peReqs).includes('oken'), JSON.stringify(peReqs)));

  peUpdate('e4', { state: 'value', value: 65.3, engine: 55, depth: 1, positions: 1, games: 9000,
    tailShare: 0.02, unexplained: 0.01, replies: [{ san: 'c5', share: 0.38, v: 67 }] });
  await check('a lone value is not marked best: there is nothing to compare it with', () =>
    assert.ok(!cellOf('e4')._classes.has('qx-best'), cellOf('e4').className));
  peUpdate('d4', { state: 'value', value: 50, engine: 51.5, depth: 1, positions: 1, games: 100,
    replies: [] });
  peUpdate('Nf3', { state: 'few', value: 52, engine: 52, games: 12 });
  peUpdate('c4', { state: 'error', reason: 'Lichess rejected the token (401).' });

  await check('a value paints as win%, and the highest one is marked best', () => {
    assert.strictEqual(cellOf('e4').textContent, '65%');
    assert.ok(cellOf('e4')._classes.has('qx-best'), cellOf('e4').className);
    assert.ok(!cellOf('d4')._classes.has('qx-best'), 'd4 marked: ' + cellOf('d4').className);
  });
  await check('  ...and the engine value behind a "few games" dash never counts as best', () =>
    assert.ok(!cellOf('Nf3')._classes.has('qx-best'), cellOf('Nf3').className));
  await check('the tooltip breaks the value down', () => {
    const t = cellOf('e4').title;
    assert.ok(t.includes('Practical 65%') && t.includes('engine 55%'), t);
    assert.ok(t.includes('c5  38% → 67%'), t);
    assert.ok(t.includes('Depth 1'), t);
  });
  await check('too few games shows a dash with the reason', () => {
    assert.strictEqual(cellOf('Nf3').textContent, '–');
    assert.ok(cellOf('Nf3').title.includes('Only 12 games'), cellOf('Nf3').title);
  });
  await check('an error shows ? with the reason, and can be retried', () => {
    assert.strictEqual(cellOf('c4').textContent, '?');
    assert.ok(cellOf('c4').title.includes('401'), cellOf('c4').title);
    assert.ok(cellOf('c4')._classes.has('qx-od'));
  });

  global.window.displayStatistics(STATS);      // the page's second render
  await check('a rebuild repaints at once from memory', () => {
    assert.strictEqual(cellOf('e4').textContent, '65%');
    assert.strictEqual(row('e4').querySelectorAll('.qx-pe').length, 1);
    assert.strictEqual(dbHeader.querySelectorAll('.qx-pe-h').length, 1, 'second header cell');
  });
  await settle(250);
  await check('  ...without asking again', () =>
    assert.strictEqual(peReqs.length, 1, 'requests: ' + peReqs.length));

  await check('clicking a waiting cell computes it and does not play the move', () => {
    assert.ok(fireClick(cellOf('g3')), 'click reached the row\'s handler');
    const last = peReqs[peReqs.length - 1];
    assert.deepStrictEqual(last.rows, ['g3']);
    assert.strictEqual(last.add, true);
    assert.strictEqual(cellOf('g3').textContent, '·');
  });
  await check('clicking a value plays the move as usual', () =>
    assert.ok(!fireClick(cellOf('e4')), 'click was swallowed'));
  await check('the header says the data is Lichess when the panel shows another DB', () =>
    assert.ok(dbHeader.querySelector('.qx-pe-h').title.includes('Practical: Lichess data')));

  peUpdate('d4', { state: 'value', value: 58.4, engine: 51.5, depth: 3, positions: 7,
    games: 100, final: false, replies: [{ san: 'Nf6', share: 0.5, v: 60, expanded: true, move: 'c4' }] });
  await check('while deeper iterations run, the % gives way to a depth marker', () => {
    assert.strictEqual(cellOf('d4').textContent, '58');
    assert.strictEqual(cellOf('d4').getAttribute('data-d'), 'd3');
    assert.ok(cellOf('d4').title.includes('searching deeper'), cellOf('d4').title);
    assert.ok(cellOf('d4').title.includes('Nf6  50% → 60%  (c4)'), cellOf('d4').title);
    assert.strictEqual(cellOf('e4').getAttribute('data-d'), null);
  });

  const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  global.fen = BLACK_TO_MOVE;
  let n = peReqs.length;
  global.window.displayStatistics(STATS);
  await settle(250);
  await check('on the opponent\'s turn nothing is computed, and old rows are cancelled', () => {
    assert.strictEqual(peReqs.length, n + 1);
    const last = peReqs[peReqs.length - 1];
    assert.deepStrictEqual(last.rows, []);
    assert.ok(last.gen > peReqs[0].gen, 'gen did not advance');
    assert.strictEqual(cellOf('e4').textContent, '');
    assert.ok(cellOf('e4').title.includes('your moves only'), cellOf('e4').title);
  });

  global.fen = START;
  global.window.displayStatistics(STATS);
  await settle(250);
  await check('going back is instant from memory', () =>
    assert.strictEqual(cellOf('e4').textContent, '65%'));
  await check('  ...and a row left mid-search resumes, still showing its last value', () => {
    assert.deepStrictEqual(peReqs[peReqs.length - 1].rows, ['d4']);
    assert.strictEqual(cellOf('d4').textContent, '58');
  });
  peUpdate('d4', { state: 'value', value: 58.4, engine: 51.5, depth: 5, positions: 31,
    games: 100, final: true, stopped: 'budget', replies: [],
    switches: [{ path: ['Nf6'], from: 'Nf3', to: 'c4', gain: 2.34, reach: 0.5 }] });
  await check('the last iteration drops the marker and says why it stopped', () => {
    assert.strictEqual(cellOf('d4').textContent, '58%');
    assert.strictEqual(cellOf('d4').getAttribute('data-d'), null);
    assert.ok(cellOf('d4').title.includes('Depth 5') && cellOf('d4').title.includes('budget'),
      cellOf('d4').title);
  });
  await check('the tooltip names a switch away from ChessDB\'s move', () =>
    assert.ok(cellOf('d4').title.includes('Your move after Nf6: c4, not ChessDB\'s Nf3 (+2.3)'),
      cellOf('d4').title));
  await check('green only compares rows at the same depth: a shallower 65% sits out', () => {
    assert.ok(!cellOf('e4')._classes.has('qx-best'), 'e4 (depth 1) marked against d4 (depth 5)');
    assert.ok(!cellOf('d4')._classes.has('qx-best'), 'd4 marked with nothing to compare');
  });
  peUpdate('e4', { state: 'value', value: 65.3, engine: 55, depth: 1, positions: 1, games: 9000,
    final: true, complete: true, replies: [] });
  await check('  ...unless it cannot go any deeper, which makes it exact at every depth', () =>
    assert.ok(cellOf('e4')._classes.has('qx-best'), cellOf('e4').className));

  /* --- Maia ------------------------------------------------------------- */
  peUpdate('Nf3', { state: 'value', value: 70, engine: 50, depth: 1, positions: 3, games: 30,
    final: true, complete: true, maia: 0.62, maiaElo: 2150,
    replies: [{ san: 'd5', share: 0.4, v: 55 }, { san: 'Nc6', share: 0.1, v: 60, maiaOnly: true }] });
  await check('a value resting mostly on Maia is purple, and says how much', () => {
    assert.ok(cellOf('Nf3')._classes.has('qx-maia'), cellOf('Nf3').className);
    assert.ok(cellOf('Nf3').title.includes('Maia: 62% of this value (rating 2150)'), cellOf('Nf3').title);
    assert.ok(cellOf('Nf3').title.includes('Nc6  10% → 60%  Maia'), cellOf('Nf3').title);
  });
  await check('  ...and when it is also the best, it stays green, underlined purple', () => {
    assert.ok(cellOf('Nf3')._classes.has('qx-best'), cellOf('Nf3').className);
    assert.ok(src.includes('.qx-pe.qx-best.qx-maia{color:#3fb950;text-decoration:underline;'),
      'no green-with-purple-underline rule');
  });
  peUpdate('Nf3', { state: 'few', games: 12, engine: 52, maiaMissing: true });
  await check('without the model, the tooltip says how to get Maia', () =>
    assert.ok(cellOf('Nf3').title.includes('turn Maia on in Qchess once'), cellOf('Nf3').title));
  peUpdate('Nf3', { state: 'few', value: 52, engine: 52, games: 12 });

  /* --- Maia preview ----------------------------------------------------- */
  // Its own position (1.Nf3 d5), so the rows above keep their state.
  const FEN_PV = 'rnbqkbnr/ppp1pppp/8/3p4/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 2';
  const ROOT_PV = FEN_PV.split(' ').slice(0, 4).join(' ');
  const pvLichess = (san, result) => peUpdate(san, result, ROOT_PV);
  const pvMaia = (san, result) => document.dispatchEvent(Object.assign(
    new CustomEventStub('qx:pe:update'),
    { detail: JSON.stringify({ type: 'update', pass: 'maia', root: ROOT_PV, san, result }) }));
  const pvVal = (value, depth, extra) => Object.assign({ state: 'value', value, engine: 50.5,
    depth, positions: depth * 3, games: 9000, final: false, replies: [] }, extra);
  global.fen = FEN_PV;
  global.window.displayStatistics(STATS);
  await settle(250);
  await check('the request asks for the Maia preview beside the Lichess search', () =>
    assert.strictEqual(peReqs[peReqs.length - 1].opts.maiaPreview, true));
  pvMaia('e4', pvVal(54.2, 1, { maia: 1, maiaElo: 2150,
    replies: [{ san: 'c5', share: 0.4, v: 56, maiaOnly: true }] }));
  await check('before any Lichess value, the preview shows: ≈, purple italics', () => {
    assert.strictEqual(cellOf('e4').textContent, '≈54');
    assert.ok(cellOf('e4')._classes.has('qx-mp') && cellOf('e4')._classes.has('qx-maia'),
      cellOf('e4').className);
    assert.strictEqual(cellOf('e4').getAttribute('data-d'), null);
    assert.ok(src.includes('.qx-pe.qx-mp{font-style:italic}'), 'no italic rule');
  });
  await check('  ...its tooltip says what it is and how far Lichess has got', () => {
    const t = cellOf('e4').title;
    assert.ok(t.startsWith('Maia preview 54% · engine 51% (+4)'), t);
    assert.ok(t.includes('Maia\'s predictions (rating 2150)'), t);
    assert.ok(t.includes('c5  40% → 56%') && !t.includes('56%  Maia'), t);
    assert.ok(t.includes('Depth 1') && t.includes('Lichess: computing…'), t);
  });
  await check('  ...and clicking it plays the move, like any value', () =>
    assert.ok(!fireClick(cellOf('e4')), 'the click was swallowed'));
  await check('the header explains the ≈', () =>
    assert.ok(dbHeader.querySelector('.qx-pe-h').title.includes('≈ in purple italics'),
      dbHeader.querySelector('.qx-pe-h').title));
  pvLichess('e4', pvVal(52, 1));
  await check('a Lichess value as deep as the preview takes over', () => {
    assert.strictEqual(cellOf('e4').textContent, '52');
    assert.strictEqual(cellOf('e4').getAttribute('data-d'), 'd1');
    assert.ok(!cellOf('e4')._classes.has('qx-mp'), cellOf('e4').className);
    assert.ok(cellOf('e4').title.includes('Maia preview: 54% at depth 1'), cellOf('e4').title);
  });
  pvMaia('e4', pvVal(56.4, 3, { maia: 1, maiaElo: 2150 }));
  pvMaia('d4', pvVal(53.1, 3, { maia: 1, maiaElo: 2150 }));
  pvLichess('d4', pvVal(51, 1));
  pvMaia('Nf3', pvVal(60, 1, { maia: 1, maiaElo: 2150 }));
  await check('a deeper preview stands in for a shallower Lichess value', () => {
    assert.deepStrictEqual([cellOf('e4').textContent, cellOf('d4').textContent], ['≈56', '≈53']);
    assert.ok(cellOf('e4').title.includes('Lichess so far: 52% at depth 1'), cellOf('e4').title);
  });
  await check('  ...the best preview at one depth is green, a preview at another sits out', () => {
    assert.ok(cellOf('e4')._classes.has('qx-best'), cellOf('e4').className);
    assert.ok(!cellOf('d4')._classes.has('qx-best'), cellOf('d4').className);
    assert.strictEqual(cellOf('Nf3').textContent, '≈60');
    assert.ok(!cellOf('Nf3')._classes.has('qx-best'), 'a depth-1 preview beat depth 3');
  });
  push({ peMaiaPreview: false });
  await check('switched off, the Lichess values show', () =>
    assert.deepStrictEqual([cellOf('e4').textContent, cellOf('d4').textContent,
      cellOf('Nf3').textContent], ['52', '51', '·']));
  push({ peMaiaPreview: true });
  pvLichess('e4', pvVal(55, 3));
  pvLichess('d4', pvVal(57, 3));
  await check('at depth 3 the Lichess values take over, with their own green', () => {
    assert.deepStrictEqual([cellOf('e4').textContent, cellOf('d4').textContent], ['55', '57']);
    assert.ok(cellOf('d4')._classes.has('qx-best'), cellOf('d4').className);
    assert.ok(!cellOf('e4')._classes.has('qx-best'), cellOf('e4').className);
  });
  pvMaia('c4', pvVal(58, 5, { maia: 1, maiaElo: 2150 }));
  pvLichess('c4', { state: 'few', games: 12, engine: 52 });
  pvLichess('Nf3', pvVal(50, 1, { final: true, complete: true }));
  await check('  ...and a final Lichess result takes over at any depth, a dash included', () => {
    assert.strictEqual(cellOf('Nf3').textContent, '50%');
    assert.strictEqual(cellOf('c4').textContent, '–');
  });
  global.fen = START;
  global.window.displayStatistics(STATS);
  await settle(250);

  // The Maia runner: its own instance of Qchess's worker, driven by the bridge's events.
  const maiaOut = [];
  document.addEventListener('qx:pe:maiaResult', e => maiaOut.push(JSON.parse(e.detail)));
  const askMaia = (id, fen) => document.dispatchEvent(Object.assign(
    new CustomEventStub('qx:pe:maia'), { detail: JSON.stringify({ id, fen, elo: 2150 }) }));
  const workers = [];
  let model = true;
  global.Worker = class {
    constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; workers.push(this); }
    postMessage(m) {
      this.sent.push(m.type);
      const reply = d => setTimeout(() => this.onmessage && this.onmessage({ data: d }), 5);
      if (m.type === 'init') reply({ type: 'status', status: model ? 'ready' : 'no-cache' });
      if (m.type === 'policy') {
        reply({ type: 'policy-result', id: m.id, fen: m.fen, elo: m.elo,
          moves: [{ san: 'e5', prob: 0.6 }, { san: 'c5', prob: 0.3995 }, { san: 'a5', prob: 0.0005 }] });
      }
    }
    terminate() { this.dead = true; }
  };
  try {
    askMaia(1, 'fen-a');
    askMaia(2, 'fen-b');
    await settle(60);
    await check('Maia runs in its own instance of Qchess\'s worker, and answers each request', () => {
      assert.strictEqual(workers.length, 1);
      assert.strictEqual(workers[0].url, '/Frontend/maia/maia-worker.js');
      assert.deepStrictEqual(workers[0].opts, { type: 'module' });
      assert.deepStrictEqual(maiaOut.map(r => r.id), [1, 2]);
      assert.deepStrictEqual(maiaOut[0].moves.map(m => m.san), ['e5', 'c5'], 'long tail dropped');
    });
    await check('  ...sending it only init and policy, never clear or download', () =>
      assert.deepStrictEqual(workers[0].sent, ['init', 'policy', 'policy']));
  } finally {
    delete global.Worker;
  }

  /* --- ChessDB evals: the page's UCI -> SAN step ---------------------- */
  // The page's own version, standing in for it: records its calls, answers {}.
  const origCalls = [];
  global.window.normalizeChessDBResults = async (f, parsed) => { origCalls.push(f); return { orig: 1 }; };
  const cdbList = s => ({ kind: 'list', items: s.split('|').map(c => {
    const o = {};
    c.split(',').forEach(kv => { const i = kv.indexOf(':'); if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1); });
    return o;
  }) });
  const SAN = { e2e4: 'e4', d2d4: 'd4', b8c6: 'Nc6', g4f3: 'Bxf3', b8d7: 'Nd7' };
  const sanWorkers = [];
  global.Worker = class {
    constructor(url, opts) { this.url = url; this.opts = opts; this.held = []; sanWorkers.push(this); }
    // Holds its replies until release(), which sends them in reverse order - the overlap
    // that gave one position another's move names.
    postMessage(m) {
      if (m.event === 'uciListToSan') {
        this.held.push({ event: 'uciListToSanDone', fen: m.fen, sanMoves: m.uciMoves.map(u => SAN[u] || u) });
      }
    }
    release() { this.held.splice(0).reverse().forEach(d => this.onmessage({ data: d })); }
    terminate() {}
  };
  // Not the start position, which the Practical checks after these render.
  const FEN_W = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const FEN_B = 'rn1qkbnr/ppp2ppp/4p3/8/2B1P1b1/1Q3N2/PP1P1PPP/RNB1K2R b KQkq - 1 5';
  try {
    tick();
    const norm = global.window.normalizeChessDBResults;
    await check('the page\'s ChessDB conversion is replaced', () => assert.ok(norm.__qxWrapped));
    const pW = norm(FEN_W, cdbList('move:e2e4,score:25,rank:2|move:d2d4,score:13,rank:1'));
    const pB = norm(FEN_B, cdbList('move:g4f3,score:15,rank:2|move:b8d7,score:-57,rank:0'));
    await settle(10);
    sanWorkers[0].release();
    const [eW, eB] = await Promise.all([pW, pB]);
    await check('overlapping positions each get their own move names and evals', () => {
      assert.deepStrictEqual(eW, { e4: 0.25, d4: 0.13 });
      assert.deepStrictEqual(eB, { Bxf3: -0.15, Nd7: 0.57 }, 'Black to move: White\'s point of view');
    });
    await check('  ...in one instance of Qchess\'s AnalysisWorker, the page\'s left alone', () => {
      assert.strictEqual(sanWorkers.length, 1);
      assert.strictEqual(sanWorkers[0].url, '/Frontend/AnalysisWorker.js');
      assert.deepStrictEqual(sanWorkers[0].opts, { type: 'module' });
      assert.strictEqual(origCalls.length, 0);
    });
    const eU = await norm(FEN_W, { kind: 'unknown', items: [] });
    await check('  ...and anything but a move list still goes to the page\'s own', () => {
      assert.deepStrictEqual(eU, { orig: 1 });
      assert.deepStrictEqual(origCalls, [FEN_W]);
    });
    tick();
    await check('  ...wrapped once', () => assert.strictEqual(global.window.normalizeChessDBResults, norm));

    // The Eval column waits for ChessDB, and a revisit starts from what it said.
    const waiting = () => dbTrees._classes.has('qx-cdb-wait');
    const FEN_N = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    global.fen = FEN_N;
    global.window.displayStatistics(STATS, { Nc6: 0.4 });
    await check("a position ChessDB hasn't answered for yet has its Eval column hidden", () => {
      assert.ok(waiting());
      assert.deepStrictEqual(renderedEvals, { Nc6: 0.4 });
    });
    const pN = norm(FEN_N, cdbList('move:b8c6,score:-30'));
    await settle(10);
    sanWorkers[0].release();
    await pN;
    await check('  ...shown once ChessDB has answered', () => assert.ok(!waiting()));
    global.window.displayStatistics(STATS, { Nc6: 0.4, a6: 1 });
    await check("a render with the page's own evals gets ChessDB's over them", () => {
      assert.deepStrictEqual(renderedEvals, { Nc6: 0.3, a6: 1 });
      assert.ok(!waiting());
    });
    global.fen = FEN_B;
    global.window.displayStatistics(STATS, {});
    await check('  ...also on a revisit, before ChessDB is asked again', () => {
      assert.deepStrictEqual(renderedEvals, { Bxf3: -0.15, Nd7: 0.57 });
      assert.ok(!waiting());
    });
    const FEN_U = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/7N/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    global.fen = FEN_U;
    global.window.displayStatistics(STATS, { Nc6: 0.4 });
    await norm(FEN_U, { kind: 'unknown', items: [] });
    await check("a position ChessDB doesn't know shows the page's evals", () => assert.ok(!waiting()));
    const FEN_F = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 2';
    global.fen = FEN_F;
    global.window.displayStatistics(STATS, { Nc6: 0.4 });
    await check('if ChessDB never answers, the evals stay hidden...', () => assert.ok(waiting()));
    await settle(5100);
    await check('  ...for 5 s, and then show', () => assert.ok(!waiting()));
    global.window.displayStatistics(STATS, { Nc6: 0.4 });
    await check("  ...and aren't hidden again by the next render", () => assert.ok(!waiting()));

    // The Eval header asks ChessDB again. The page's parser, standing in for it.
    global.window.parseQueryAll = txt => (txt === 'unknown' ? { kind: 'unknown', items: [] } : cdbList(txt));
    const fetched = [];
    let cdbReply = 'move:b8c6,score:-45';
    global.fetch = async (url, opts) => {
      fetched.push({ url, opts });
      if (cdbReply === null) throw new TypeError('Failed to fetch');
      return { ok: true, text: async () => cdbReply };
    };
    const evalHead = dbHeader.querySelector('.move-eval');
    const busy = () => dbHeader._classes.has('qx-cdb-busy') && dbTrees._classes.has('qx-cdb-busy');
    try {
      global.fen = FEN_N;
      // The page's cache for the session: ChessDB's first answer merged into its evals.
      global.lastEvalsData = { Nc6: 0.3, a6: 1 };
      global.sortMode = 'popularity';
      tick();
      await check('sorted by something else, the Eval header says a click sorts first', () => {
        assert.ok(evalHead.title.startsWith('Click to sort by eval'), evalHead.title);
        assert.ok(!dbHeader._classes.has('qx-cdb-armed'), 'the refresh glyph shows');
      });
      let n0 = sortClicks.length;
      await check('  ...and the first click goes through to the site and sorts', () => {
        assert.ok(!fireClick(evalHead), 'the click was swallowed');
        assert.deepStrictEqual(sortClicks.slice(n0), ['eval']);
        assert.strictEqual(global.sortMode, 'eval');
        assert.strictEqual(fetched.length, 0, 'ChessDB was asked');
      });
      await check('the Eval header then offers to ask ChessDB again', () => {
        assert.ok(evalHead.title.startsWith('Click to ask ChessDB again'), evalHead.title);
        assert.ok(dbHeader._classes.has('qx-cdb-armed'), 'no refresh glyph');
      });
      n0 = sortClicks.length;
      await check('  ...a click on it is taken, and nothing of the site\'s sees it', () => {
        assert.ok(fireClick(evalHead));
        assert.strictEqual(sortClicks.length, n0);
      });
      fireClick(evalHead);
      await settle(10);
      await check('  ...one queryall for the shown position, past the HTTP cache', () => {
        assert.strictEqual(fetched.length, 1, 'a second click while one is out asked again');
        assert.ok(fetched[0].url.startsWith('https://www.chessdb.cn/cdb.php?action=queryall&'));
        assert.ok(fetched[0].url.includes('board=' + encodeURIComponent(FEN_N)));
        assert.strictEqual(fetched[0].opts.cache, 'no-store');
      });
      await check('  ...the evals dim while it\'s out', () => assert.ok(busy()));
      renderedEvals = null;
      sanWorkers[0].release();
      await settle(10);
      await check('  ...and the table is redrawn with the new answer', () => {
        assert.deepStrictEqual(renderedEvals, { Nc6: 0.45, a6: 1 });
        assert.ok(!busy());
        assert.ok(evalHead.title.includes('ChessDB asked again at'), evalHead.title);
      });
      global.fen = FEN_B;
      global.window.displayStatistics(STATS, {});
      await check('  ...the note is about that position only', () =>
        assert.ok(!evalHead.title.includes('asked again'), evalHead.title));
      global.fen = FEN_N;
      global.window.displayStatistics(STATS, { Nc6: 0.3, a6: 1 });
      await check('  ...and the page\'s cached redraw of it gets the new evals too', () =>
        assert.deepStrictEqual(renderedEvals, { Nc6: 0.45, a6: 1 }));

      cdbReply = 'move:b8c6,score:-60';
      fireClick(evalHead);
      await settle(10);
      global.fen = FEN_B;
      renderedEvals = null;
      sanWorkers[0].release();
      await settle(10);
      await check('moving on before ChessDB answers leaves the new table alone', () =>
        assert.strictEqual(renderedEvals, null));
      global.fen = FEN_N;
      global.window.displayStatistics(STATS, { Nc6: 0.3 });
      await check('  ...and the answer still counts when you come back', () =>
        assert.deepStrictEqual(renderedEvals, { Nc6: 0.6 }));

      cdbReply = null;
      const warn = console.warn;
      console.warn = () => {};
      fireClick(evalHead);
      await settle(10);
      console.warn = warn;
      await check('if ChessDB can\'t be reached, the header says so and the evals stay', () => {
        assert.ok(!busy());
        assert.ok(evalHead.title.includes('ChessDB didn\'t answer'), evalHead.title);
        assert.deepStrictEqual(renderedEvals, { Nc6: 0.6 });
      });

      const n = fetched.length;
      const cell = dbTrees.querySelector('.move-eval');
      await check('an Eval cell in a row still plays its move', () => {
        assert.ok(!fireClick(cell), 'the click was swallowed');
        assert.strictEqual(fetched.length, n);
      });

      // The page's fetchCDB, standing in for it: each call held until settled by hand.
      const pageCdb = [];
      global.window.fetchCDB = params => new Promise((res, rej) => pageCdb.push({ params, res, rej }));
      tick();
      await check("the page's ChessDB requests are followed", () =>
        assert.ok(global.window.fetchCDB.__qxWrapped));
      const shown = f => { global.fen = f; global.lastFetchedFEN = f; };
      cdbReply = 'move:b8c6,score:-20';
      global.lastEvalsData = { Nc6: 0.4 };
      const FEN_C = 'rnbqkbnr/pppp1ppp/8/4p3/2P1P3/8/PP1P1PPP/RNBQKBNR b KQkq - 0 2';
      shown(FEN_C);
      let f0 = fetched.length;
      global.window.displayStatistics(STATS, { Nc6: 0.4 });
      await settle(10);
      await check("a table the page drew without asking ChessDB (its cache hit) makes us ask", () => {
        assert.strictEqual(fetched.length, f0 + 1);
        assert.ok(fetched[f0].url.includes('board=' + encodeURIComponent(FEN_C)));
        assert.strictEqual(fetched[f0].opts.cache, 'no-store');
        assert.ok(!busy(), 'dimmed like a refresh');
      });
      renderedEvals = null;
      sanWorkers[0].release();
      await settle(10);
      await check('  ...and redraws it with the answer, the header left alone', () => {
        assert.deepStrictEqual(renderedEvals, { Nc6: 0.2 });
        assert.ok(!waiting());
        assert.ok(!evalHead.title.includes('asked again'), evalHead.title);
      });

      const FEN_P = 'rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2';
      shown(FEN_P);
      global.window.fetchCDB({ action: 'queryall', board: FEN_P, showall: '0' }).catch(() => {});
      f0 = fetched.length;
      global.window.displayStatistics(STATS, { Nc6: 0.4 });
      await settle(10);
      await check("  ...but not while the page's own request is out", () =>
        assert.strictEqual(fetched.length, f0));
      pageCdb.pop().rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await settle(10);
      await check('  ...and when that is aborted (the page moved on or hit its cache), we do', () =>
        assert.strictEqual(fetched.length, f0 + 1));
      sanWorkers[0].release();
      await settle(10);

      const FEN_A = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/2P5/PP1P1PPP/RNBQKBNR b KQkq - 0 2';
      shown(FEN_A);
      const pa = global.window.fetchCDB({ action: 'queryall', board: FEN_A, showall: '0' });
      f0 = fetched.length;
      pageCdb.pop().res({ txt: 'move:b8c6,score:-10' });
      await pa;
      global.window.displayStatistics(STATS, { Nc6: 0.4 });
      await settle(10);
      await check("  ...nor while the page's answer is on its way to the Eval column", () =>
        assert.strictEqual(fetched.length, f0));
      const pn = norm(FEN_A, cdbList('move:b8c6,score:-10'));
      await settle(10);
      sanWorkers[0].release();
      await pn;
      await settle(4100);
      await check('  ...or after it arrived', () => assert.strictEqual(fetched.length, f0));

      const FEN_D = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/3P4/PPP2PPP/RNBQKBNR b KQkq - 0 2';
      global.fen = FEN_D;
      global.window.displayStatistics(STATS, { Nc6: 0.4 });
      await settle(10);
      await check("  ...or before the page has started on the position (Lichess debounce)", () =>
        assert.strictEqual(fetched.length, f0));

      cdbReply = null;
      shown(FEN_D);
      global.window.displayStatistics(STATS, { Nc6: 0.4 });
      await settle(10);
      global.window.displayStatistics(STATS, { Nc6: 0.4 });
      await settle(10);
      await check('  ...and a failed ask of ours isn\'t repeated on every render', () => {
        assert.strictEqual(fetched.length, f0 + 1);
        assert.ok(!evalHead.title.includes('didn\'t answer'), evalHead.title);
      });
    } finally {
      delete global.fetch;
      delete global.lastEvalsData;
      delete global.lastFetchedFEN;
      delete global.window.fetchCDB;
    }
    global.fen = START;
    global.window.displayStatistics(STATS);
    await settle(50);
    const pX = norm(FEN_W, cdbList('move:e2e4,score:25'));
    await settle(10);
    sanWorkers[0].onerror();
    await check('if the worker fails, the page\'s own conversion takes over', async () => {
      assert.deepStrictEqual(await pX, { orig: 1 });
      assert.deepStrictEqual(await norm(FEN_W, cdbList('move:e2e4,score:25')), { orig: 1 });
      assert.strictEqual(sanWorkers.length, 1, 'restarted');
    });
  } finally {
    delete global.Worker;
  }

  /* --- right-click to exclude a move ---------------------------------- */
  const ROOT0 = START.split(' ').slice(0, 4).join(' ');
  const fireContext = target => {
    let stopped = false, prevented = false;
    const ev = { type: 'contextmenu', target,
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
    for (const fn of events.contextmenu || []) { fn(ev); if (stopped) break; }
    return { stopped, prevented };
  };
  const excl = [];
  document.addEventListener('qx:pe:exclude', e => excl.push(JSON.parse(e.detail)));
  const lastReq = () => peReqs[peReqs.length - 1];
  await check('e4 is green before any exclusion', () =>
    assert.ok(cellOf('e4')._classes.has('qx-best'), cellOf('e4').className));
  let ctx = fireContext(cellOf('e4'));
  await check('right-click on a Practical cell excludes that move, not the browser menu', () => {
    assert.ok(ctx.prevented && ctx.stopped, JSON.stringify(ctx));
    assert.strictEqual(cellOf('e4').textContent, '×');
    assert.ok(cellOf('e4').title.includes('Right-click to include'), cellOf('e4').title);
    assert.deepStrictEqual(excl[excl.length - 1], { key: ROOT0 + '|e4', on: true });
  });
  await check('  ...tells the worker to stop it', () =>
    assert.deepStrictEqual([lastReq().rows, lastReq().remove], [[], ['e4']]));
  await check('  ...and an excluded move never takes the green', () =>
    assert.strictEqual(dbTrees.querySelectorAll('.qx-pe').filter(c => c._classes.has('qx-best')).length, 0));
  n = peReqs.length;
  fireContext(cellOf('e4'));
  await check('right-click again brings a finished value straight back, with no request', () => {
    assert.strictEqual(cellOf('e4').textContent, '65%');
    assert.ok(cellOf('e4')._classes.has('qx-best'));
    assert.strictEqual(peReqs.length, n);
    assert.deepStrictEqual(excl[excl.length - 1], { key: ROOT0 + '|e4', on: false });
  });
  fireContext(cellOf('b3'));
  fireContext(cellOf('b3'));
  await check('  ...and a move never computed is computed', () =>
    assert.deepStrictEqual([lastReq().rows, lastReq().add], [['b3'], true]));
  document.dispatchEvent(Object.assign(new CustomEventStub('qx:pe:excludedList'),
    { detail: JSON.stringify([ROOT0 + '|Nf3']) }));
  await check('exclusions saved earlier in the session are applied on load', () =>
    assert.strictEqual(cellOf('Nf3').textContent, '×'));

  /* --- positions ChessDB was asked to analyse ------------------------------ */
  peUpdate('c4', { state: 'value', value: 50, engine: 50, depth: 5, positions: 9, games: 100,
    final: true, stopped: 'budget', analysing: 2, replies: [] });
  await check('the tooltip says ChessDB was asked to analyse what it lacked', () =>
    assert.ok(cellOf('c4').title.includes('ChessDB had no eval for 2 positions or moves')
      && cellOf('c4').title.includes('Come back in a few minutes'), cellOf('c4').title));
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const revisit = async minutes => {
    clock += minutes * 60000;
    global.fen = BLACK_TO_MOVE;
    global.window.displayStatistics(STATS);
    await settle(200);
    global.fen = START;
    global.window.displayStatistics(STATS);
    await settle(200);
    return lastReq().rows;
  };
  try {
    const soon = await revisit(1);
    const later = await revisit(3);
    await check('coming back a few minutes later searches that row again', () => {
      assert.ok(!soon.includes('c4'), 'after a minute: ' + soon);
      assert.ok(later.includes('c4'), 'after 4 minutes: ' + later);
      assert.strictEqual(cellOf('c4').textContent, '50%');
    });
    peUpdate('c4', { state: 'value', value: 50, engine: 50, depth: 5, positions: 9, games: 100,
      final: true, stopped: 'budget', analysing: 1, replies: [] });
    const again = await revisit(3);
    peUpdate('c4', { state: 'value', value: 50, engine: 50, depth: 5, positions: 9, games: 100,
      final: true, stopped: 'budget', analysing: 1, replies: [] });
    const third = await revisit(3);
    await check('  ...twice at most, for a position ChessDB never learns', () => {
      assert.ok(again.includes('c4'), 'second: ' + again);
      assert.ok(!third.includes('c4'), 'third: ' + third);
    });
  } finally {
    Date.now = realNow;
  }

  /* --- rows picked by the engine as well as by games -------------------- */
  global.fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  global.window.displayStatistics(STATS,
    { e4: 0.2, d4: 0.3, Nf3: 0.25, c4: 0.1, a6: 0.28, g3: 0.28, b3: -1.2 });
  await settle(250);
  await check('rows come from the engine as well as the games: its best few first', () =>
    assert.deepStrictEqual(lastReq().rows, ['d4', 'g3', 'a6', 'e4', 'Nf3', 'c4']));
  await check('  ...with equal evals broken by games played (g3 before the unplayed a6)', () =>
    assert.ok(lastReq().rows.indexOf('g3') < lastReq().rows.indexOf('a6')));

  /* --- prepared score: the Score column --------------------------------- */
  console.log('\nprepared score: the Score column');
  const ROOT5 = global.fen.split(' ').slice(0, 4).join(' ');
  const scoreLabel = document.getElementById('dbh-score-label');
  const mpOf = san => row(san).querySelector('.move-percentages');
  const snap = san => mpOf(san).children.map(b => [b.className, b.style.width, b.textContent]);
  const prepAttrs = el => Object.keys(el.attrs).filter(k => k.startsWith('data-qx'));
  const pctOf = b => parseFloat(b.style.width);
  const prepEvents = [];
  document.addEventListener('qx:pe:prepBar', e => prepEvents.push(JSON.parse(e.detail)));

  await check('the search is asked for the prepared split, with k; the bar mode stays here', () => {
    const o = lastReq().opts;
    assert.deepStrictEqual([o.prep, o.prepPriorGames], [true, 50]);
    assert.ok(!('prepBar' in o), 'prepBar sent to the worker');
  });
  await check('the stylesheet makes the Score label clickable, above the bars\' header', () => {
    const css = document.getElementById('qx-css').textContent;
    assert.ok(css.includes('#db-column-header.qx-prep-toggle #dbh-score-label{pointer-events:auto!important;'
      + 'cursor:pointer;position:relative;z-index:1}'), 'no clickable-label rule');
    assert.ok(dbHeader._classes.has('qx-prep-toggle'), 'header class missing');
    assert.strictEqual(scoreLabel.textContent, 'Score');
    assert.ok(scoreLabel.title.includes('Click for prepared'), scoreLabel.title);
  });

  const rawE4 = snap('e4'), rawNov = snap('a6'), rawTot = snap('∑');
  const PREP_E4 = { state: 'value', value: 61, engine: 55, depth: 3, positions: 12, games: 5000,
    final: true, replies: [{ san: 'c5', share: 0.38, v: 62, move: 'Nf3',
      raw: { w: 0.33, d: 0.1, b: 0.57, n: 1900 }, prep: { w: 0.56, d: 0.1, b: 0.34 } },
    { san: 'a5', share: 0.01, v: 70, raw: null, prep: { w: 0.7, d: 0, b: 0.3 } }],
    prep: { w: 0.55, d: 0.1, b: 0.35 }, prior: 0.12, leafGames: 4210,
    raw: { w: 0.4, d: 0.3, b: 0.3, n: 5000 } };
  peUpdate('e4', PREP_E4, ROOT5);
  peUpdate('d4', { state: 'value', value: 57, engine: 55, depth: 3, positions: 9, games: 3000,
    final: true, replies: [], prep: { w: 0.45, d: 0.2, b: 0.35 }, prior: 0.6, leafGames: 90,
    raw: { w: 0.4, d: 0.3, b: 0.3, n: 3000 } }, ROOT5);
  // Computed while prepared scores were switched off: a value, but no split.
  peUpdate('Nf3', { state: 'value', value: 55, engine: 55, depth: 3, positions: 4, games: 1000,
    final: true, replies: [] }, ROOT5);
  await check('with the toggle off, the bars are the panel\'s own', () => {
    assert.deepStrictEqual(snap('e4'), rawE4);
    assert.ok(!mpOf('e4')._classes.has('qx-prep'));
  });

  global.sortMode = 'eval';
  peUpdate('Nf3', { state: 'value', value: 55, engine: 55, depth: 3, positions: 4, games: 1000,
    final: true, replies: [] }, ROOT5);
  await check('sorted by something else, the Score label says a click sorts first', () =>
    assert.ok(scoreLabel.title.startsWith('Click to sort by score; click again'), scoreLabel.title));
  let sc0 = sortClicks.length;
  await check('  ...and the first click goes through to the site and sorts, bars unchanged', () => {
    assert.ok(!fireClick(scoreLabel), 'the click was swallowed');
    assert.deepStrictEqual(sortClicks.slice(sc0), ['score']);
    assert.strictEqual(global.sortMode, 'score');
    assert.deepStrictEqual(prepEvents, [], 'the toggle switched');
    assert.strictEqual(scoreLabel.textContent, 'Score');
    assert.ok(!scoreLabel.title.includes('Click to sort'), scoreLabel.title);
  });
  sc0 = sortClicks.length;
  const e4Bars = mpOf('e4').children.slice();
  await check('a click on the Score header switches to prepared bars, and is intercepted', () => {
    assert.strictEqual(sortClicks.length, sc0, 'the site saw the click');
    assert.ok(fireClick(scoreLabel), 'the click reached the page');
    assert.strictEqual(scoreLabel.textContent, 'Prepared');
    assert.deepStrictEqual(prepEvents, [true], 'the setting was not saved');
    assert.ok(scoreLabel.title.includes('Click for the panel\'s own results'), scoreLabel.title);
  });
  await check('  ...a row with a split shows it, labelled by the page\'s 15% rule', () => {
    const b = mpOf('e4').children;
    [55, 10, 35].forEach((x, i) =>
      assert.ok(Math.abs(pctOf(b[i]) - x) < 1e-9, 'bar ' + i + ': ' + b[i].style.width));
    assert.deepStrictEqual(b.map(x => x.textContent), ['55%', '', '35%']);
    assert.ok(mpOf('e4')._classes.has('qx-prep'), mpOf('e4').className);
    assert.ok(!mpOf('e4')._classes.has('qx-prep-muted'));
  });
  await check('  ...only widths, text, title and classes change: same bars, same order', () => {
    assert.strictEqual(mpOf('e4').children.length, 3);
    e4Bars.forEach((b, i) => assert.strictEqual(mpOf('e4').children[i], b, 'bar ' + i + ' replaced'));
    assert.deepStrictEqual(mpOf('e4').children.map(b => b.className), rawE4.map(x => x[0]));
  });
  await check('  ...a split resting mostly on the Practical value is muted', () =>
    assert.ok(mpOf('d4')._classes.has('qx-prep') && mpOf('d4')._classes.has('qx-prep-muted'),
      mpOf('d4').className));
  await check('  ...the best prepared score gets the highlight', () => {
    assert.ok(mpOf('e4')._classes.has('qx-prep-best'), mpOf('e4').className);
    assert.ok(!mpOf('d4')._classes.has('qx-prep-best'), mpOf('d4').className);
  });
  await check('  ...a row without a split keeps its raw bar, faded, and says why', () => {
    assert.ok(mpOf('Nf3')._classes.has('qx-prep-raw'), mpOf('Nf3').className);
    assert.ok(!mpOf('Nf3')._classes.has('qx-prep'));
    assert.deepStrictEqual(snap('Nf3').map(x => x.slice(1)), rawE4.map(x => x.slice(1)));
    assert.ok(mpOf('Nf3').title.includes('switched off'), mpOf('Nf3').title);
    assert.ok(mpOf('g3')._classes.has('qx-prep-raw'), 'a row never computed: ' + mpOf('g3').className);
  });
  await check('  ...novelty and totals rows are untouched', () => {
    assert.deepStrictEqual(snap('a6'), rawNov);
    assert.deepStrictEqual(snap('∑'), rawTot);
    assert.strictEqual(mpOf('a6').className, 'move-percentages');
    assert.strictEqual(mpOf('∑').className, 'move-percentages');
    assert.deepStrictEqual(prepAttrs(mpOf('∑')).concat(...mpOf('∑').children.map(prepAttrs)), []);
  });
  await check('  ...the tooltip compares with these games and breaks the split down', () => {
    const t = mpOf('e4').title;
    ['Prepared 55 / 10 / 35 (these games 40 / 30 / 30)',
      'Your expected score 60% (55% in these games, +5)',
      'c5  38% → 61%  (Nf3)',
      'Rests on Practical value: 12% · depth 3 · 4,210 games at the leaves',
      'Beyond depth 3, results include everyone\'s later mistakes.',
      'the panel shows Elite'].forEach(x => assert.ok(t.includes(x), 'missing "' + x + '" in:\n' + t));
    assert.ok(!t.includes('a5'), 'a reply under the threshold is listed');
  });
  global.selectedDB = 'Lichess';
  global.window.displayStatistics(STATS);
  await check('  ...adding the panel\'s own numbers when it shows the same Lichess data', () =>
    assert.ok(mpOf('e4').title.includes('Panel 40 / 30 / 30 · 5,000 games'), mpOf('e4').title));
  global.selectedDB = 'Elite';
  global.window.displayStatistics(STATS);
  await check('the prepared bars survive the table\'s rebuild', () => {
    assert.ok(mpOf('e4').children[0] !== e4Bars[0], 'not rebuilt');
    assert.ok(Math.abs(pctOf(mpOf('e4').children[0]) - 55) < 1e-9, mpOf('e4').children[0].style.width);
    assert.ok(mpOf('e4')._classes.has('qx-prep'));
  });
  peUpdate('e4', Object.assign({}, PREP_E4, { prep: { w: 0.6, d: 0.1, b: 0.3 }, depth: 5, final: false }), ROOT5);
  await check('  ...and update with each round', () =>
    assert.ok(Math.abs(pctOf(mpOf('e4').children[0]) - 60) < 1e-9, mpOf('e4').children[0].style.width));
  peUpdate('e4', PREP_E4, ROOT5);
  await check('toggling off restores the exact raw widths and labels', () => {
    assert.ok(fireClick(scoreLabel));
    assert.strictEqual(scoreLabel.textContent, 'Score');
    assert.deepStrictEqual(prepEvents, [true, false]);
    ['e4', 'd4', 'Nf3', 'g3'].forEach(san => {
      assert.deepStrictEqual(snap(san).map(x => x.slice(1)), rawE4.map(x => x.slice(1)), san);
      assert.strictEqual(mpOf(san).className, 'move-percentages', san);
      assert.strictEqual(mpOf(san).title, '', san + ' title');
      assert.deepStrictEqual(prepAttrs(mpOf(san)).concat(...mpOf(san).children.map(prepAttrs)), [], san);
    });
  });
  push({ prepBar: true });
  await settle(50);
  await check('the popup\'s setting switches the bars too', () =>
    assert.ok(mpOf('e4')._classes.has('qx-prep') && scoreLabel.textContent === 'Prepared'));
  push({ prepEnabled: false });
  await settle(50);
  await check('with prepared scores off: raw bars, the plain label, and the click left to the page', () => {
    assert.deepStrictEqual(snap('e4'), rawE4);
    assert.strictEqual(scoreLabel.textContent, 'Score');
    assert.ok(!dbHeader._classes.has('qx-prep-toggle'));
    assert.ok(!fireClick(scoreLabel), 'the click was swallowed');
  });
  assert.ok(cellOf('b3')._classes.has('qx-od'), 'b3 is not waiting for a click');
  fireClick(cellOf('b3'));
  await check('  ...and the search is told not to compute them', () =>
    assert.strictEqual(lastReq().opts.prep, false));
  push({ prepEnabled: true, prepBar: false });
  await settle(50);

  global.databaseTurnedOn = false;
  global.fen = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 1 1';
  n = peReqs.length;
  global.window.displayStatistics(STATS);
  await settle(250);
  await check('a closed database panel makes no requests', () =>
    assert.strictEqual(peReqs.length, n, 'requests: ' + (peReqs.length - n)));
  global.databaseTurnedOn = true;

  push({ peEnabled: false });
  await settle(250);
  n = peReqs.length;
  global.window.displayStatistics(STATS);
  await settle(250);
  await check('switched off: no column and no requests', () => {
    assert.strictEqual(document.querySelectorAll('.qx-pe, .qx-pe-h').length, 0);
    assert.strictEqual(peReqs.length, n);
  });

  /* --- copy continuation ---------------------------------------------- */
  console.log('\ncopy continuation');
  tick();
  tick();
  const copyItem = () => document.getElementById('qx-copy-cont');
  check('one item in the right-click menu, right after the site\'s Copy', () => {
    assert.strictEqual(ctxMenu.children.filter(c => c.id === 'qx-copy-cont').length, 1);
    const ids = ctxMenu.children.map(c => c.id);
    assert.strictEqual(ids[ids.indexOf('context-copy') + 1], 'qx-copy-cont', ids.join(','));
    assert.ok(copyItem()._classes.has('context-menu-item'), 'not styled as the site\'s items');
    assert.strictEqual(copyItem().textContent, 'Copy continuation');
  });

  const nodeAt = p => {
    let n = global.tree.root;
    for (const m of p.split(' ')) n = n.children.find(c => c.move === m);
    return n;
  };
  const copyFrom = async p => {
    global.contextMenuTargetMove = { element: null, node: nodeAt(p) };
    ctxMenu.classList.add('active');
    clip.text = null;
    const stopped = fireClick(copyItem());
    await settle(10);
    return stopped;
  };

  await check('copies from the branch start to the line\'s end; the click is not passed on', async () => {
    const before = ctxClosed;
    assert.ok(await copyFrom('Nf3 d5 c4 d4 b4 c5'), 'the click reached the page');
    assert.strictEqual(clip.text, '3. b4 c5 4. g3 cxb4');
    assert.strictEqual(copyItem().textContent, 'Copied');
    await settle(700);
    assert.strictEqual(ctxClosed, before + 1, 'menu not closed');
    assert.strictEqual(copyItem().textContent, 'Copy continuation');
  });
  await check('a move deep in a branch copies from the branch\'s first move', async () => {
    await copyFrom('Nf3 d5 b4 c5 c4');
    assert.strictEqual(clip.text, '2. b4 c5 3. c4 d4 4. g3 cxb4');
  });
  await check('a branch opened by Black starts with "N... "', async () => {
    await copyFrom('Nf3 d5 c4 e6');
    assert.strictEqual(clip.text, '2... e6');
    await copyFrom('Nf3 d5 c4 d4');
    assert.strictEqual(clip.text, '2... d4 3. g3 c5 4. b4 cxb4');
  });
  await check('with no branch above, it copies from the first move', async () => {
    await copyFrom('Nf3');
    assert.strictEqual(clip.text, '1. Nf3 d5 2. c4 d4 3. g3 c5 4. b4 cxb4');
  });
  await check('a failed write says so, and leaves a menu reopened meanwhile open', async () => {
    await settle(700);
    clip.fail = true;
    const before = ctxClosed;
    const warn = console.warn;
    console.warn = () => {};                   // the expected failure's warning
    await copyFrom('Nf3 d5 b4');
    console.warn = warn;
    clip.fail = false;
    assert.strictEqual(copyItem().textContent, 'Copy failed');
    global.contextMenuTargetMove = { element: null, node: nodeAt('Nf3') };   // reopened
    await settle(700);
    assert.strictEqual(ctxClosed, before, 'closed the reopened menu');
    assert.strictEqual(copyItem().textContent, 'Copy continuation');
  });

  /* --- clickable lines (training mode) --------------------------------- */
  console.log('\nclickable lines in training comments');

  // The test study's line as training walks it, with real side-to-move and fullmove
  // fields (all the extension reads off these FENs) and the two comments from the live
  // study, plus comments that must stay plain and one with an illegal move.
  const TL = ['Nf3', 'd5', 'c4', 'd4', 'g3', 'c5', 'b4', 'cxb4', 'a3', 'bxa3', 'Bg2'];
  const tlFen = (moves) => {
    const side = moves.length % 2 ? 'b' : 'w';
    return `${moves.join('_') || 'start'} ${side} - - 0 ${Math.floor(moves.length / 2) + 1}`;
  };
  const tlRoot = { move: '', fen: tlFen([]), children: [] };
  const tlNodes = TL.map((m, i) => ({ move: m, fen: tlFen(TL.slice(0, i + 1)), children: [] }));
  tlNodes[1].comment = 'A remark (see the other chapter) and (4. e4 e5) that fits nowhere';
  tlNodes[5].comment = 'Test of clickable line at the same ply: (3... Nc6 4. Bg2 e5 5. d3)';
  tlNodes[8].comment = 'Test of clickable line before the move: (5... b6 6. Bg2 Bb7 7. axb4)';
  tlNodes[9].comment = 'Illegal on: (6. Bg2 Qxh7 7. Nc3)';
  // On the last move: three lines, the middle one illegal from its first move.
  tlNodes[10].comment = 'Either (6... Qa5 7. O-O), (6... Qxh7) or (6... Nc6 7. Qa4)';
  global.studyMode = 'train';

  // The page's AnalysisWorker, answering emPlayMove. A move to h7 is "illegal".
  const UCI = { Nc6: 'b8c6', Bg2: 'f1g2', e5: 'e7e5', d3: 'd2d3', b6: 'b7b6', Bb7: 'c8b7',
    axb4: 'a3b4' };
  const clWorkers = [];
  const clPosted = [];
  global.Worker = class {
    constructor(url, opts) { this.url = url; this.opts = opts; clWorkers.push(this); }
    postMessage(m) {
      clPosted.push(m);
      if (m.event !== 'emPlayMove') return;
      const [pos, side, , , , full] = m.fen.split(' ');
      const reply = /h7/.test(m.move)
        ? { event: 'emMovePlayed', emId: m.emId, ok: false, error: 'illegal move' }
        : { event: 'emMovePlayed', emId: m.emId, ok: true, san: m.move, uci: UCI[m.move] || 'a1a2',
          newFen: `${pos}_${m.move} ${side === 'w' ? 'b' : 'w'} - - 0 ${side === 'b' ? +full + 1 : full}` };
      setTimeout(() => this.onmessage && this.onmessage({ data: reply }), 0);
    }
    terminate() {}
  };

  // Training's page functions, the way the site's call each other.
  const mtBox = makeEl('div');
  mtBox.id = 'mt-moves-display';
  body.appendChild(mtBox);
  const boardEl = makeEl('div');
  boardEl.id = 'big-container';
  ['b8', 'c6', 'f1', 'g2', 'e7', 'e5', 'd2', 'd3', 'e4'].forEach(id => {
    const sq = makeEl('div');
    sq._classes.add('allsquares');
    sq.id = id;
    boardEl.appendChild(sq);
  });
  body.appendChild(boardEl);
  const drawn = [];                              // every renderFEN, ours and the site's
  let jumps = 0;
  global.ts = { active: true, readMode: true, readNodes: tlNodes, playedNodes: [], viewIndex: 6 };
  global.fen = tlNodes[6].fen;
  global.tree = { root: tlRoot };
  const siteNodes = () => global.ts.readMode ? global.ts.readNodes : global.ts.playedNodes;
  Object.assign(global.window, {
    renderFEN: f => { drawn.push(f); },
    clearArrows: () => {},
    loadNodeShapes: () => {},
    highlightLastMove: () => { throw new Error('highlightLastMove would draw the real glyph'); },
    renderMTNotation: () => {
      mtBox.children.forEach(c => { c.parent = null; });
      mtBox.children.length = 0;
      siteNodes().forEach((n, idx) => {
        const row = makeEl('div');
        row._classes.add('added-move');
        const slot = makeEl('div');
        slot._classes.add('move-in-nota');
        slot.textContent = n.move;
        slot.setAttribute('data-idx', String(idx));
        slot.addEventListener('click', () => global.window.trainJumpToIndex(idx));
        row.appendChild(slot);
        mtBox.appendChild(row);
        if (n.comment) {                         // makeMainCommentRow(comment, null)
          const c = makeEl('div');
          c._classes.add('main-comment-row');
          c.appendChild(makeText(n.comment));
          mtBox.appendChild(c);
        }
      });
    },
    trainJumpToIndex: idx => {
      jumps++;
      global.ts.viewIndex = idx;
      global.fen = siteNodes()[idx].fen;
      global.window.renderFEN(global.fen);
      global.window.renderMTNotation();
    }
  });
  const rowOf = i => {
    const rows = mtBox.children;
    const at = rows.findIndex(r => r.querySelector('[data-idx]') &&
      r.querySelector('[data-idx]').getAttribute('data-idx') === String(i));
    const next = rows[at + 1];
    return next && next._classes.has('main-comment-row') ? next : null;
  };
  const clOf = i => rowOf(i).children.filter(c => c._classes && c._classes.has('qx-cl'));
  const clNamed = (i, san) => clOf(i).find(c => c.textContent === san);
  const fireKey = key => {
    let stopped = false;
    const ev = { type: 'keydown', key, preventDefault() {}, stopPropagation() { stopped = true; } };
    for (const fn of events.keydown || []) { fn(ev); if (stopped) break; }
    return stopped;
  };
  const firePress = (target, button = 0) => {
    let stopped = false;
    const ev = { type: 'mousedown', button, target, preventDefault() {},
      stopPropagation() { stopped = true; } };
    for (const fn of events.mousedown || []) { fn(ev); if (stopped) break; }
    return stopped;
  };
  const lit = () => document.querySelectorAll('.letzterZug').map(e => e.id).sort().join(',');
  const onSpans = () => document.querySelectorAll('.qx-cl-on').map(e => e.textContent);
  const lastDrawn = () => drawn[drawn.length - 1];

  tick();                                        // installs the training hooks
  global.window.renderMTNotation();
  await settle(40);

  check('the same-ply line\'s moves become clickable; the text reads the same', () => {
    assert.deepStrictEqual(clOf(5).map(c => c.textContent), ['Nc6', 'Bg2', 'e5', 'd3']);
    assert.strictEqual(textOf(rowOf(5)), tlNodes[5].comment);
  });
  check('so do the before-the-move line\'s', () =>
    assert.deepStrictEqual(clOf(8).map(c => c.textContent), ['b6', 'Bg2', 'Bb7', 'axb4']));
  check('a remark in parentheses and a line that fits neither position stay plain', () => {
    assert.strictEqual(clOf(1).length, 0);
    assert.strictEqual(textOf(rowOf(1)), tlNodes[1].comment);
  });
  check('in one instance of the page\'s AnalysisWorker, asked only emPlayMove', () => {
    assert.strictEqual(clWorkers.length, 1);
    assert.strictEqual(clWorkers[0].url, '/Frontend/AnalysisWorker.js');
    assert.ok(clPosted.every(m => m.event === 'emPlayMove'), 'posted something else');
  });
  check('moves from the first illegal one on are struck through', () => {
    assert.deepStrictEqual(clOf(9).map(c => c._classes.has('qx-cl-bad')), [false, true, true]);
  });

  const siteState = () => JSON.stringify([global.ts.viewIndex, global.fen, global.ts.readMode]);
  const before = siteState();
  await check('same ply: the line replaces the commented move (starts before 3...c5)', async () => {
    drawn.length = 0;
    assert.ok(fireClick(clNamed(5, 'd3')), 'the click reached the page');
    await settle(10);
    assert.strictEqual(lastDrawn(), 'Nf3_d5_c4_d4_g3_Nc6_Bg2_e5_d3 b - - 0 5');
    assert.strictEqual(lit(), 'd2,d3');
    assert.deepStrictEqual(onSpans(), ['d3']);
  });
  check('  ...and nothing of training\'s changed', () => assert.strictEqual(siteState(), before));
  await check('before the move: the line continues from the commented position', async () => {
    fireClick(clNamed(8, 'b6'));
    await settle(10);
    assert.strictEqual(lastDrawn(), 'Nf3_d5_c4_d4_g3_c5_b4_cxb4_a3_b6 w - - 0 6');
    assert.deepStrictEqual(onSpans(), ['b6']);
  });
  check('the arrow keys step through the preview, not training\'s line', () => {
    fireClick(clNamed(5, 'e5'));
  });
  await settle(10);
  check('  ...left goes back a move, and from the line\'s first move out', () => {
    assert.ok(fireKey('ArrowLeft'), 'the key reached the page');
    assert.deepStrictEqual(onSpans(), ['Bg2']);
    fireKey('ArrowLeft');
    assert.deepStrictEqual(onSpans(), ['Nc6']);
    const j = jumps;
    fireKey('ArrowLeft');
    assert.deepStrictEqual(onSpans(), []);
    assert.strictEqual(jumps, j + 1, 'did not go back to training\'s position');
    assert.strictEqual(lastDrawn(), tlNodes[6].fen);
    assert.strictEqual(siteState(), before);
  });
  check('  ...and once out, the keys are the site\'s again', () =>
    assert.ok(!fireKey('ArrowLeft'), 'still caught'));
  await check('  ...right stops at the line\'s last move; Escape leaves', async () => {
    fireClick(clNamed(5, 'e5'));
    await settle(10);
    fireKey('ArrowRight');
    fireKey('ArrowRight');
    assert.deepStrictEqual(onSpans(), ['d3']);
    assert.ok(fireKey('Escape'));
    assert.deepStrictEqual(onSpans(), []);
    assert.strictEqual(lastDrawn(), tlNodes[6].fen);
  });
  await check('an illegal move does nothing', async () => {
    const n = drawn.length;
    fireClick(clNamed(9, 'Nc3'));
    await settle(10);
    assert.strictEqual(drawn.length, n);
  });
  await check('the site drawing the board ends the preview', async () => {
    fireClick(clNamed(5, 'Bg2'));
    await settle(10);
    global.window.renderFEN(tlNodes[7].fen);              // e.g. training's next move
    assert.deepStrictEqual(onSpans(), []);
    assert.ok(!fireKey('ArrowLeft'), 'keys still caught');
  });
  await check('a left press on the board goes back instead of moving a previewed piece', async () => {
    fireClick(clNamed(5, 'Bg2'));
    await settle(10);
    const sq = document.getElementById('e4');
    assert.ok(!firePress(sq, 2), 'right-click (arrows) was taken');
    assert.deepStrictEqual(onSpans(), ['Bg2']);
    assert.ok(firePress(sq, 0), 'the press reached the board');
    assert.deepStrictEqual(onSpans(), []);
    assert.strictEqual(lastDrawn(), tlNodes[6].fen);
    assert.ok(!firePress(sq, 0), 'taken with no preview on');
  });
  await check('a redraw of the notation asks the worker nothing new', async () => {
    const n = clPosted.length;
    global.window.renderMTNotation();
    await settle(20);
    assert.strictEqual(clPosted.length, n);
    assert.strictEqual(clOf(5).length, 4);
    assert.ok(clNamed(9, 'Qxh7')._classes.has('qx-cl-bad'));
  });
  check('right on a move before the last is the site\'s', () =>
    assert.ok(!fireKey('ArrowRight'), 'caught with training on move 7 of 11'));
  await check('right on the last move goes into its comment\'s first line', async () => {
    global.window.trainJumpToIndex(10);
    assert.ok(fireKey('ArrowRight'), 'the key reached the page');
    await settle(10);
    assert.deepStrictEqual(onSpans(), ['Qa5']);
    assert.strictEqual(lastDrawn(), `${TL.join('_')}_Qa5 w - - 0 7`);
  });
  await check('  ...right runs on into the next line, past one that can\'t be played', async () => {
    fireKey('ArrowRight');
    assert.deepStrictEqual(onSpans(), ['O-O']);
    fireKey('ArrowRight');
    await settle(10);
    assert.deepStrictEqual(onSpans(), ['Nc6']);
    fireKey('ArrowRight');
    assert.deepStrictEqual(onSpans(), ['Qa4']);
    assert.ok(fireKey('ArrowRight'), 'the key reached the page at the end');
    await settle(10);
    assert.deepStrictEqual(onSpans(), ['Qa4']);
  });
  await check('  ...and left retraces it exactly, then leaves', async () => {
    fireKey('ArrowLeft');
    assert.deepStrictEqual(onSpans(), ['Nc6']);
    fireKey('ArrowLeft');
    await settle(10);
    assert.deepStrictEqual(onSpans(), ['O-O']);
    fireKey('ArrowLeft');
    assert.deepStrictEqual(onSpans(), ['Qa5']);
    const j = jumps;
    fireKey('ArrowLeft');
    assert.deepStrictEqual(onSpans(), []);
    assert.strictEqual(jumps, j + 1, 'did not go back to training\'s position');
    assert.strictEqual(lastDrawn(), tlNodes[10].fen);
  });
  await check('  ...a click into the second line also runs on and back', async () => {
    fireClick(clNamed(10, 'Nc6'));
    await settle(10);
    fireKey('ArrowLeft');
    await settle(10);
    assert.deepStrictEqual(onSpans(), ['O-O']);
    fireKey('Escape');
  });
  check('  ...only in training', () => {
    global.studyMode = 'study';
    const caught = fireKey('ArrowRight');
    global.studyMode = 'train';
    assert.ok(!caught, 'caught outside training');
  });
  global.window.trainJumpToIndex(6);

  await check('interactive mode: comments on the moves played so far', async () => {
    global.ts.readMode = false;
    global.ts.playedNodes = tlNodes.slice(0, 7);
    global.window.renderMTNotation();
    await settle(10);
    assert.strictEqual(clOf(5).length, 4);
    assert.strictEqual(rowOf(8), null);
    fireClick(clNamed(5, 'Nc6'));
    await settle(10);
    assert.strictEqual(lastDrawn(), 'Nf3_d5_c4_d4_g3_Nc6 w - - 0 4');
    fireKey('Escape');
  });
  delete global.Worker;

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
