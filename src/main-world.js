/*
 * Qchess Transpositions - main world content script.
 *
 * Runs in the MAIN world (see manifest) because Qchess keeps its analysis state in
 * script-scope `let`/`const` bindings rather than on `window`. An isolated-world
 * content script would see none of it.
 *
 * What the page gives us:
 *   tree                          { root: { move, fen, children[], variationId, moveIndex } }
 *   studyData.chapters[]          .length for the popup's read-out, .perspective for the
 *                                 side the chapter's repertoire is written for
 *   activeChapterIndex, studyUuid notice a chapter or study swap
 *   userColor, boardFlipped, REP_STATE   fallbacks for "which side am I?"
 *   window._repStripFen(fen)      -> first 4 FEN fields; the site's position-identity key
 *   window.nodeDataKey(node)      -> "<variationId>-<moveIndex>", matches [data-node] in #moves
 *   window.rebuildNotationDisplay()      rebuilds #moves from scratch on every navigation
 *
 * Two nodes transpose iff _repStripFen(a.fen) === _repStripFen(b.fen). Because every node
 * already carries a FEN, no chess logic is needed here at all.
 *
 * Matching is deliberately confined to the chapter that is currently open: every position
 * it reports is one you can reach and jump to without leaving the board you are looking at.
 *
 * The target list is rendered as an inline `.next-moves-menu` - the same element and
 * classes the site uses for its own branch menu, inserted the same way (immediately after
 * the move's row), so it inherits the site's colours, border and hover states.
 *
 * Second, unrelated job: every variation in the notation gets a left spine saying whose
 * move opened it - bright for yours, faint for the opponent's (see markSides).
 *
 * Third: a "Practical" column in the explorer table (see "practical eval" below). The
 * work happens in the background worker; this script only picks rows and paints.
 *
 * Fourth: a "Copy continuation" item in the notation's right-click menu (see "copy
 * continuation" below).
 *
 * Fifth: in training mode, moves in a comment's "(3... Nc6 4. Bg2)" preview that line on
 * the board (see "clickable lines" below).
 */

(function () {
  'use strict';

  if (window.__qxTranspositionsLoaded) return;
  window.__qxTranspositionsLoaded = true;

  var PALETTE = ['#7aa2f7', '#e0af68', '#9ece6a', '#f7768e', '#bb9af7', '#2ac3de'];

  var settings = {
    enabled: true,
    outline: true,
    minBadge: false,
    sides: true,
    // Practical eval (the token is deliberately not among these - it never enters
    // this world; see bridge.js)
    peEnabled: true,
    peFollowPanel: true,
    peSpeeds: 'blitz,rapid',
    peRatings: '1800,2000,2200',
    rowThreshold: 2,
    replyThreshold: 3,
    minGames: 50,
    reachFloor: 2,
    maxPly: 6,
    ownMargin: 5,
    ownMaxCandidates: 3,
    peRequestBudget: 60,
    peMaia: true,
    peMaiaPreview: true,
    // Which of the two the Prac column shows, switched by clicking its header: 'lichess'
    // or 'maia' (the preview). UI only, like prepBar.
    peView: 'lichess',
    maiaUntil: 100,
    maiaOnlyBelow: 10,
    maiaWeight: 20,
    // Prepared score: the Score column's bars recomputed as if you follow the Practical
    // choices. prepBar is UI only: which bars the Score column shows.
    prepEnabled: true,
    prepBar: false,
    prepPriorGames: 50
  };

  /* ---------------------------------------------------------------------
   * Page-scope access.
   *
   * `tree`, `studyData` and `activeChapterIndex` are script-scope bindings, so
   * `window.tree` is undefined while a bare `tree` resolves. Referencing an
   * undeclared name throws ReferenceError, hence the try/catch getters.
   * ------------------------------------------------------------------- */
  var G = {
    get tree() { try { return tree; } catch (e) { return undefined; } },
    get studyData() { try { return studyData; } catch (e) { return undefined; } },
    get chapterIndex() { try { return activeChapterIndex; } catch (e) { return -1; } },
    get studyUuid() { try { return studyUuid; } catch (e) { return ''; } },
    get rep() { try { return REP_STATE; } catch (e) { return undefined; } },
    get userColor() { try { return userColor; } catch (e) { return ''; } },
    get boardFlipped() { try { return boardFlipped; } catch (e) { return false; } },
    // {element, node} of the move the notation's right-click menu is open for, else null
    get ctxTarget() { try { return contextMenuTargetMove; } catch (e) { return null; } },
    // Explorer panel (Practical eval)
    get fen() { try { return fen; } catch (e) { return ''; } },
    get lastStats() { try { return lastStatsData; } catch (e) { return undefined; } },
    get lastEvals() { try { return lastEvalsData; } catch (e) { return undefined; } },
    get lichessSettings() { try { return lichessSettings; } catch (e) { return undefined; } },
    get selectedDB() { try { return selectedDB; } catch (e) { return ''; } },
    get sortMode() { try { return sortMode; } catch (e) { return ''; } },
    get lastFetchedFen() { try { return lastFetchedFEN; } catch (e) { return ''; } },
    // Closing the panel hides the table but leaves its stale rows in the DOM, so this
    // flag - not the rows - says whether the panel is in use.
    get dbOn() { try { return databaseTurnedOn; } catch (e) { return true; } },
    // Training mode's state: readMode, readNodes / playedNodes, viewIndex
    get ts() { try { return ts; } catch (e) { return undefined; } },
    get studyMode() { try { return studyMode; } catch (e) { return ''; } }
  };

  function ready() {
    var t = G.tree;
    return !!(t && t.root &&
      typeof window._repStripFen === 'function' &&
      typeof window.nodeDataKey === 'function' &&
      document.getElementById('moves'));
  }

  /* ------------------------------------------------------------------ CSS */

  function injectCss() {
    if (document.getElementById('qx-css')) return;
    var st = document.createElement('style');
    st.id = 'qx-css';
    st.textContent = [
      // One accent for every badge, so "transposition" reads as a single affordance.
      // #3fb950 sits beside the site's own green active-move highlight without being
      // confusable with it.
      '.qx-badge,.qx-menu{--qx-g:#3fb950}',

      // --qx-c stays one hue per transposing position: the outline is what ties the
      // marked moves to each other, the badge is the button.
      // justify-self: a move is a grid item in .added-move and would otherwise stretch
      // across its whole column, so the outline sat far to the right of the move itself.
      '.qx-t{outline:1px dashed var(--qx-c,#7aa2f7);outline-offset:1px;border-radius:3px;',
      'justify-self:start}',

      '.qx-badge{display:inline-flex;align-items:center;align-self:center;',
      'margin-left:4px;padding:1px 5px;border:1px solid var(--qx-g);border-radius:8px;',
      'background:var(--qx-g);color:#0b1f0d;font-size:10px;line-height:1.35;',
      'font-weight:700;letter-spacing:.2px;cursor:pointer;user-select:none;',
      'transition:filter .12s,background-color .12s,box-shadow .12s}',
      '.qx-badge:hover{filter:brightness(1.15)}',
      '.qx-badge.qx-open{box-shadow:0 0 0 2px rgba(63,185,80,.35)}',

      // .next-moves-menu supplies background, border, radius and padding; these keep it
      // inside the notation pane. The site scales its own menu by 1.1 from the centre,
      // which pushes the left edge outside #moves - hence transform:none. flex-basis
      // covers the menu landing in a wrapping flex row (.variation-content).
      '.qx-menu{transform:none!important;box-sizing:border-box;display:block;',
      'width:auto;max-width:100%;min-width:0;flex:0 0 100%;margin:5px 12px 7px 0;',
      'padding:4px;font-size:12px;overflow-x:hidden;position:relative;z-index:3;',
      'border-left:3px solid var(--qx-g)}',

      '.qx-menu .qx-head{display:flex;align-items:center;gap:6px;',
      'padding:3px 5px 2px;font-size:9px;letter-spacing:.7px;text-transform:uppercase;',
      'font-weight:700;opacity:.55}',
      '.qx-menu .qx-head::after{content:"";flex:1 1 auto;height:1px;',
      'background:currentColor;opacity:.35}',
      '.qx-menu .qx-head~.qx-head{margin-top:4px}',

      // Wrap rather than truncate: the move order is the only thing telling two
      // otherwise identical rows apart, so none of it can be cut off.
      '.qx-menu .qx-opt{display:flex;flex-wrap:wrap;align-items:baseline;',
      'column-gap:8px;row-gap:1px;padding:4px 5px;white-space:normal}',
      '.qx-menu .qx-opt b{flex:0 0 auto;font-weight:700;color:#fff}',
      '.qx-menu .qx-opt small{flex:1 1 auto;min-width:0;font-size:11px;opacity:.55;',
      'overflow-wrap:anywhere}',

      // Your-side branches. Deliberately a brightness, not a hue: the per-position
      // colours above already own every hue, and a seventh one here would read as
      // "this branch belongs to that transposition". Both classes carry a spine so
      // the text of every variation stays on the same left edge.
      '.qx-ub{--qx-s:rgba(255,255,255,.78)}',
      '.qx-ob{--qx-s:rgba(255,255,255,.13)}',
      '.variation-line.qx-ub,.variation-line.qx-ob{border-left:3px solid var(--qx-s)}',
      '.variation-line.qx-ub{background-color:rgba(237,226,226,.26)}',
      // A nested branch already has a 2px #555 spine plus a ::before elbow; recolour
      // both, and leave the opponent's alone - #555 is already the "not yours" end.
      '.branch-variation.qx-ub{border-left-color:var(--qx-s)}',
      '.branch-variation.qx-ub::before{background:var(--qx-s)}',

      // Practical column. The page pins every other column to a fixed width and rows to
      // height:20px;overflow:hidden (#tree-move-styles), so this cell is fixed-width too.
      // Header and row cells take the same horizontal space: 34px + 8px margin.
      '#db-column-header .qx-pe-h,#database-trees .qx-pe{flex-shrink:0;width:34px;',
      'min-width:34px;margin-right:8px;text-align:right;white-space:nowrap;',
      'overflow:hidden;font-variant-numeric:tabular-nums}',
      '#db-column-header .qx-pe-h{font-size:10px;color:#888;letter-spacing:.04em}',
      '#database-trees .qx-pe{font-size:11px;color:#bdbdbd}',
      '#database-trees .qx-pe.qx-best{color:#3fb950;font-weight:600}',
      // Mostly Maia's predictions rather than games. The best move stays green, with a
      // purple underline so the Maia part still shows.
      '#database-trees .qx-pe.qx-maia{color:#b392f0}',
      '#database-trees .qx-pe.qx-best.qx-maia{color:#3fb950;text-decoration:underline;',
      'text-decoration-color:#b392f0;text-decoration-thickness:2px;text-underline-offset:2px}',
      // The Maia preview (≈, and qx-maia's purple): italic, so it never reads as a Lichess
      // value that happens to rest mostly on Maia.
      '#database-trees .qx-pe.qx-mp{font-style:italic}',
      // The header switches the column between the Lichess values and Maia's (qx-pe-sw);
      // showing Maia's, it reads "Maia" in the preview's purple italics. When the hidden
      // one is deeper here, its depth sits before the label as a small badge in that
      // one's colour, pulsing when it appears.
      '#db-column-header .qx-pe-h.qx-pe-sw{cursor:pointer}',
      '#db-column-header .qx-pe-h.qx-pe-sw:hover{color:#ddd}',
      '#db-column-header .qx-pe-h.qx-pe-hm{color:#b392f0;font-style:italic;letter-spacing:0}',
      '#db-column-header .qx-pe-h.qx-alt-m{--qx-alt:#b392f0}',
      '#db-column-header .qx-pe-h.qx-alt-l{--qx-alt:#c9d1d9}',
      '#db-column-header .qx-pe-h[data-alt]::before{content:attr(data-alt);',
      'display:inline-block;margin-right:1px;padding:0 2px;border-radius:6px;',
      'font-size:8px;line-height:11px;font-style:normal;font-weight:700;letter-spacing:0;',
      'vertical-align:1px;color:#0d1117;background:var(--qx-alt);',
      'animation:qx-pulse 1.1s ease-out 2}',
      '@keyframes qx-pulse{0%{box-shadow:0 0 0 0 var(--qx-alt)}',
      '100%{box-shadow:0 0 0 5px rgba(0,0,0,0)}}',
      '#database-trees .qx-pe.qx-q{opacity:.45}',
      '#database-trees .qx-pe.qx-x{opacity:.35}',
      // While deeper iterations run, the % sign gives way to a small depth marker.
      '#database-trees .qx-pe[data-d]::after{content:attr(data-d);font-size:8px;',
      'font-weight:400;opacity:.55;margin-left:1px}',
      '#database-trees .qx-pe.qx-od{cursor:pointer}',
      // Waiting for ChessDB: hidden, not removed, so the columns don't shift.
      '#database-trees.qx-cdb-wait .move-eval{visibility:hidden}',
      // Once sorted by eval, the Eval header asks ChessDB again (U+21BB). The glyph's
      // room is always kept, so "Eval" doesn't move when it appears. While the request
      // is out, the evals dim.
      '#db-column-header .move-eval{cursor:pointer}',
      '#db-column-header .move-eval::after{content:"\\21bb";margin-left:3px;opacity:.45;',
      'visibility:hidden}',
      '#db-column-header.qx-cdb-armed .move-eval::after{visibility:visible}',
      '#db-column-header .move-eval:hover::after,#db-column-header.qx-cdb-busy .move-eval::after{opacity:1}',
      '#database-trees.qx-cdb-busy .move-eval{opacity:.35}',
      '#database-trees .qx-pe.qx-od:empty::after{content:"+";opacity:0}',
      '#database-trees .tree-move:hover .qx-pe.qx-od:empty::after{opacity:.4}',
      // In a narrow panel (a 958px window gives the table 237px) there is no slack at
      // all; shrink the cell rather than hide anything of the site's.
      '#db-column-header.qx-pe-narrow .qx-pe-h,#database-trees.qx-pe-narrow .qx-pe{',
      'width:28px;min-width:28px;margin-right:4px;font-size:10px}',
      '#db-column-header.qx-pe-narrow .qx-pe-h{letter-spacing:0}',
      // No room for the depth there: a dot says the same, the title says which depth.
      '#db-column-header.qx-pe-narrow .qx-pe-h[data-alt]::before{content:"";width:5px;',
      'height:5px;padding:0;border-radius:50%;vertical-align:1px}',

      // Prepared score. The page gives the Score label pointer-events:none and width:0,
      // its text overflowing into .move-percentages - a later flex sibling, painted on
      // top of it. Without all three of these the label can't be clicked or hovered.
      '#db-column-header.qx-prep-toggle #dbh-score-label{pointer-events:auto!important;',
      'cursor:pointer;position:relative;z-index:1}',
      // Bars recomputed from the prepared split: a thin inset outline says so. Outline,
      // not border or padding, so the bars keep their exact widths.
      '#database-trees .move-percentages.qx-prep{outline:1px solid rgba(88,166,255,.9);',
      'outline-offset:-1px}',
      // Mostly the prior (the Practical value) rather than games: muted.
      '#database-trees .move-percentages.qx-prep-muted{outline-style:dashed}',
      '#database-trees .move-percentages.qx-prep-muted>.percentage-bar{opacity:.6}',
      // Still the panel's own results in prepared mode: faded, so it's clear.
      '#database-trees .move-percentages.qx-prep-raw{opacity:.35}',
      '#database-trees .move-percentages.qx-prep-best{outline:2px solid #3fb950;',
      'outline-offset:-2px}',

      // Clickable lines in training comments. Comments are italic in the comment
      // colour; a move you can click is upright, bolder and underlined with dots, and
      // the one on the board gets the same green as the badges.
      '.qx-cl{font-style:normal;font-weight:600;cursor:pointer;border-radius:3px;',
      'padding:0 1px;border-bottom:1px dotted currentColor}',
      '.qx-cl:hover{background:rgba(255,255,255,.12)}',
      '.qx-cl.qx-cl-on{background:#3fb950;color:#0b1f0d;border-bottom-color:transparent}',
      // Not legal from where the line starts, or after a move that isn't.
      '.qx-cl.qx-cl-bad{cursor:default;font-weight:400;opacity:.55;',
      'text-decoration:line-through;border-bottom-color:transparent;background:none}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------- move formatting */

  // Mirrors the site's genMoveLabel()/buildPrefixLine(): move number comes from the
  // FEN's fullmove field, and a FEN with black to move means White just moved.
  function moveBit(node) {
    var parts = String(node.fen || '').split(' ');
    var isWhite = parts[1] === 'b';
    var full = parseInt(parts[5], 10);
    if (!isFinite(full)) full = 1;
    return { san: node.move, no: isWhite ? full : full - 1, isWhite: isWhite };
  }

  function fmtLabel(bit) {
    return bit.no + (bit.isWhite ? '.' : '...') + bit.san;
  }

  // "1.Nf3 d5 2.c4 d4 3.b4 c5" - numbers on White's moves only, like the notation pane.
  function fmtLine(bits) {
    return bits.map(function (b, i) {
      if (b.isWhite) return b.no + '.' + b.san;
      if (i === 0) return b.no + '...' + b.san;
      return b.san;
    }).join(' ');
  }

  // "4... c5 5. d4 cxd4" - PGN spacing, for pasting elsewhere.
  function fmtPgn(bits) {
    return bits.map(function (b, i) {
      if (b.isWhite) return b.no + '. ' + b.san;
      if (i === 0) return b.no + '... ' + b.san;
      return b.san;
    }).join(' ');
  }

  /* ------------------------------------------------------ copy continuation
   * An item in the notation's right-click menu (#move-context-menu, static markup) next
   * to the site's Copy. Copy gives the line from the first move, comments included; this
   * gives only the moves from where the clicked move's branch starts - its first
   * ancestor-or-self with a sibling - to the end of the line, following first children
   * as the site's "Variation PGN" does. No comments, no glyphs.
   * ------------------------------------------------------------------------- */

  function pathTo(root, target) {
    var path = [root];
    function walk(n) {
      if (n === target) return true;
      for (var i = 0; i < n.children.length; i++) {
        path.push(n.children[i]);
        if (walk(n.children[i])) return true;
        path.pop();
      }
      return false;
    }
    return walk(root) ? path : null;
  }

  function continuationPgn(node) {
    var t = G.tree;
    var path = t && t.root && node ? pathTo(t.root, node) : null;
    if (!path || path.length < 2) return '';
    var i = path.length - 1;
    while (i > 1 && path[i - 1].children.length < 2) i--;
    var line = path.slice(i);
    for (var n = node; n.children && n.children.length; n = n.children[0]) {
      line.push(n.children[0]);
    }
    return fmtPgn(line.map(moveBit));
  }

  var COPY_LABEL = 'Copy continuation';
  var copyTimer = null;

  function injectCopyItem() {
    var menu = document.getElementById('move-context-menu');
    if (!menu || document.getElementById('qx-copy-cont')) return;
    var item = document.createElement('div');
    item.id = 'qx-copy-cont';
    // The site's class, so it looks like the other items (hover, padding).
    item.className = 'context-menu-item qx-copy-cont';
    item.textContent = COPY_LABEL;
    var after = document.getElementById('context-copy');
    if (after && after.parentNode === menu) menu.insertBefore(item, after.nextSibling);
    else menu.appendChild(item);
  }

  function closeSiteMenu() {
    if (typeof window.closeMoveContextMenu === 'function') window.closeMoveContextMenu();
    else {
      var menu = document.getElementById('move-context-menu');
      if (menu) menu.classList.remove('active');
    }
  }

  function copyContinuation(item) {
    var target = G.ctxTarget;
    var text = continuationPgn(target && target.node);
    function done(ok) {
      item.textContent = ok ? 'Copied' : 'Copy failed';
      clearTimeout(copyTimer);
      // Long enough to read; not if the menu has since been opened for another move.
      copyTimer = setTimeout(function () {
        item.textContent = COPY_LABEL;
        if (G.ctxTarget === target) closeSiteMenu();
      }, 600);
    }
    var clip = window.navigator && window.navigator.clipboard;
    if (!text || !clip) { done(false); return; }
    clip.writeText(text).then(function () { done(true); }, function (err) {
      console.warn('[qchess-transpositions]', err);
      done(false);
    });
  }

  /* ---------------------------------------------------------------- indexing */

  // Every position in the chapter that is currently open, keyed by normalized FEN.
  function indexCurrentTree() {
    var byKey = new Map();
    var t = G.tree;
    if (!t || !t.root) return byKey;
    (function walk(n, bits) {
      var b = n.move ? bits.concat(moveBit(n)) : bits;
      if (n.move && n.fen) {
        var k = window._repStripFen(n.fen);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ bits: b, key: window.nodeDataKey(n) });
      }
      (n.children || []).forEach(function (c) { walk(c, b); });
    })(t.root, []);
    return byKey;
  }

  // Changes when the study, the open chapter or the side you play does, which is when
  // the markers need recomputing - the notation rebuild hook covers everything else.
  // The side is in here because the site changes it without rebuilding the notation:
  // its own colour switch and the chapter settings dialog both just mutate state.
  function stateStamp() {
    var sd = G.studyData;
    return [G.studyUuid, G.chapterIndex, sd && sd.chapters ? sd.chapters.length : 0,
      userSide()].join('#');
  }

  /* ------------------------------------------------------ your-side branches
   *
   * A variation that starts with one of your own moves is a choice you made; one that
   * starts with the opponent's is a move you have to be ready for. The notation draws
   * them identically, even though only the second kind has to be memorised in full.
   * ---------------------------------------------------------------------- */

  // Which side the repertoire is for. `perspective` is the chapter's own record of it -
  // the same field the site uses to orient the board, to pick evals' point of view and
  // to build repertoire mode. The fallbacks only matter outside a study chapter.
  function userSide() {
    var rep = G.rep;
    if (rep && rep.active && rep.perspective) return rep.perspective;

    var sd = G.studyData;
    var ch = sd && sd.chapters ? sd.chapters[G.chapterIndex] : null;
    if (ch && ch.perspective) return ch.perspective;

    var uc = G.userColor;                       // the site's own statistics setting
    if (uc === 'white' || uc === 'black') return uc;

    return G.boardFlipped ? 'black' : 'white';  // whoever is at the bottom of the board
  }

  // data-node key -> true if White played that move. Read off the FEN rather than the
  // parity of moveIndex, because a chapter can start from a position with Black to move.
  function sidesByKey() {
    var byKey = new Map();
    var t = G.tree;
    if (!t || !t.root) return byKey;
    (function walk(n) {
      if (n.move && n.fen) byKey.set(window.nodeDataKey(n), moveBit(n).isWhite);
      (n.children || []).forEach(walk);
    })(t.root);
    return byKey;
  }

  // The move a branch starts with. Both the group and the move span inside it carry
  // data-node; the group is the one that wraps the whole first move plus its comment.
  function firstMoveGroup(el) {
    var kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.classList && k.classList.contains('variation-move-group') &&
          k.getAttribute('data-node')) return k;
    }
    return null;
  }

  function clearSideMarks() {
    var els = document.querySelectorAll('.qx-ub, .qx-ob');
    for (var i = 0; i < els.length; i++) {
      els[i].classList.remove('qx-ub');
      els[i].classList.remove('qx-ob');
    }
  }

  function markSides() {
    clearSideMarks();
    var moves = document.getElementById('moves');
    if (!settings.sides || !moves) return 0;

    var whiteIsMine = userSide() === 'white';
    var sides = sidesByKey();
    // A branch is either a .variation-line (a variation hanging off the main line) or a
    // .branch-variation (one nested inside another); in both cases the branch is the
    // container and its first move group is what it starts with.
    var conts = moves.querySelectorAll('.variation-line, .branch-variation');
    var mine = 0;

    for (var i = 0; i < conts.length; i++) {
      var first = firstMoveGroup(conts[i]);
      if (!first) continue;
      var isWhite = sides.get(first.getAttribute('data-node'));
      if (isWhite === undefined) continue;   // a move the tree no longer has
      if (isWhite === whiteIsMine) { conts[i].classList.add('qx-ub'); mine++; }
      else conts[i].classList.add('qx-ob');
    }
    return mine;
  }

  /* ------------------------------------------------------------------ menu */

  var openFor = null;   // data-node key of the badge whose menu is open
  var targets = [];     // jump targets for the open menu, addressed by data-qx-i

  function closeMenu(forget) {
    var m = document.querySelector('.qx-menu');
    if (m) m.remove();
    var lit = document.querySelectorAll('.qx-open');
    for (var i = 0; i < lit.length; i++) lit[i].classList.remove('qx-open');
    if (forget !== false) openFor = null;
  }

  function buildMenu(moveEl, entries) {
    var menu = document.createElement('div');
    // Same classes as the site's own branch menu, so it picks up its styling.
    menu.className = 'next-moves-menu qx-menu';
    targets = [];

    function head(text) {
      var h = document.createElement('div');
      h.className = 'qx-head';
      h.textContent = text;
      menu.appendChild(h);
    }

    function option(bits, key) {
      var o = document.createElement('div');
      o.className = 'next-move-option qx-opt';
      o.setAttribute('data-qx-i', String(targets.length));

      var label = document.createElement('b');
      label.textContent = fmtLabel(bits[bits.length - 1]);
      o.appendChild(label);

      // The move order is what actually distinguishes one target from another -
      // two move orders often end on the same move.
      var prefix = fmtLine(bits.slice(0, -1));
      if (prefix) {
        var s = document.createElement('small');
        s.textContent = prefix;
        o.appendChild(s);
      }

      o.title = fmtLine(bits);
      targets.push(key);
      menu.appendChild(o);
    }

    head('Same position via');
    entries.forEach(function (e) { option(e.bits, e.key); });

    // The site inserts its menu right after the move; put ours after the whole row so
    // it lands on its own line instead of inside a flex row of move cells.
    var row = (moveEl.closest && moveEl.closest('.added-move, .variation-row')) || moveEl;
    if (row.parentNode) row.parentNode.insertBefore(menu, row.nextSibling);
    return menu;
  }

  function openMenu(badge) {
    var moveEl = badge.closest && badge.closest('[data-node]');
    if (!moveEl) return;
    var key = moveEl.getAttribute('data-node');
    closeMenu();
    var others = badge.__qxOthers;
    if (!others || !others.length) return;
    buildMenu(moveEl, others);
    badge.classList.add('qx-open');
    openFor = key;
  }

  function jump(key) {
    closeMenu();
    if (!key) return;
    // Replay a real click on the move element so the site's own handler runs.
    var el = document.querySelector('[data-node="' + key + '"]');
    if (el) el.click();
  }

  /*
   * One delegated listener, in the CAPTURE phase.
   *
   * This is the fix for badge clicks doing nothing: every move element (or its
   * .variation-move-group parent) carries the site's own click handler, which navigates
   * and then calls rebuildNotationDisplay(). Stopping propagation from a listener on the
   * badge itself is not enough, because handlers bound higher up in the capture phase
   * have already run. Intercepting here, before anything else sees the event, guarantees
   * a badge click never reaches the site's navigation.
   */
  // Right-click on a Practical cell toggles whether that move is analysed. Qchess only
  // uses right-click on notation moves and game entries, so explorer rows are free.
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    var cell = t && t.closest ? t.closest('.qx-pe') : null;
    if (!cell || !cell.getAttribute('data-san') || !peActive() || !peMyTurn(G.fen)) return;
    e.preventDefault();
    e.stopPropagation();
    peToggleExclude(cell.getAttribute('data-san'));
  }, true);

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // The Eval header asks ChessDB again, once the table is sorted by eval (sortedBy).
    var evalHead = t.closest('.move-eval');
    if (evalHead && evalHead.parentNode && evalHead.parentNode.id === 'db-column-header' &&
        sortedBy('eval')) {
      e.preventDefault();
      e.stopPropagation();
      cdbRefresh();
      return;
    }

    // The Score header label switches the bars between the panel's results and the
    // prepared ones. Stopped here like the badges, so nothing of the site's sees it.
    var scoreLabel = document.getElementById('dbh-score-label');
    if (scoreLabel && (t === scoreLabel || (scoreLabel.contains && scoreLabel.contains(t))) &&
        prepActive() && sortedBy('score')) {
      e.preventDefault();
      e.stopPropagation();
      prepToggle();
      return;
    }

    // The Prac header switches the column between the Lichess values and Maia's. Not a
    // header of the site's, so nothing sorts on it; stopped anyway, like the others.
    var peHead = t.closest('.qx-pe-h');
    if (peHead && pePreviewOn()) {
      e.preventDefault();
      e.stopPropagation();
      peViewToggle();
      return;
    }

    // A Practical cell waiting to be computed (or retried). Its row carries the site's
    // handler that plays the move, so this has to be stopped here, like the badges.
    // Cells showing a value are left alone: clicking them plays the move as usual.
    var peCell = t.closest('.qx-pe');
    if (peCell && peCell.classList.contains('qx-od')) {
      e.preventDefault();
      e.stopPropagation();
      peClickRow(peCell.getAttribute('data-san'));
      return;
    }

    // Our item in the notation's right-click menu. A click inside that menu doesn't
    // close it (the site checks menu.contains), so copyContinuation closes it itself.
    // A move in a line in a training comment. The row has no handler of the site's,
    // but a stray one would redraw the board under the preview, so it's stopped too.
    var clMove = t.closest('.qx-cl');
    if (clMove) {
      e.preventDefault();
      e.stopPropagation();
      clClick(clMove);
      return;
    }

    var copyItem = t.closest('.qx-copy-cont');
    if (copyItem) {
      e.preventDefault();
      e.stopPropagation();
      copyContinuation(copyItem);
      return;
    }

    var badge = t.closest('.qx-badge');
    if (badge) {
      e.preventDefault();
      e.stopPropagation();
      var moveEl = badge.closest('[data-node]');
      var key = moveEl && moveEl.getAttribute('data-node');
      if (openFor === key) closeMenu();      // toggle
      else openMenu(badge);
      return;
    }

    var opt = t.closest('.qx-opt');
    if (opt) {
      e.preventDefault();
      e.stopPropagation();
      jump(targets[Number(opt.getAttribute('data-qx-i'))]);
      return;
    }

    if (!t.closest('.qx-menu')) closeMenu();
  }, true);

  document.addEventListener('keydown', function (e) {
    // Ahead of the site's training handler, which would step the real line instead.
    if (clKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') closeMenu();
  }, true);

  /* -------------------------------------------------------------- annotate */

  var lastStats = { isStudy: false, groups: 0, marked: 0 };

  function clearMarks() {
    var badges = document.querySelectorAll('.qx-badge');
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    var outlined = document.querySelectorAll('.qx-t');
    for (var j = 0; j < outlined.length; j++) {
      outlined[j].classList.remove('qx-t');
      outlined[j].style.removeProperty('--qx-c');
    }
    // NB: deliberately does not close the menu. A rebuild triggered while the menu is
    // open used to wipe it before it could be clicked; annotate() reopens it instead.
    closeMenu(false);
  }

  function annotate() {
    injectCss();   // no-op once present; also recovers if the SPA replaces <head>
    if (!ready()) {
      lastStats = { isStudy: false, groups: 0, marked: 0 };
      emitStats();
      return;
    }
    var wasOpen = openFor;
    clearMarks();

    // Independent of the transposition markers: it answers a different question.
    var side = userSide();
    var yours = markSides();

    if (!settings.enabled) {
      openFor = null;
      lastStats = { isStudy: true, groups: 0, marked: 0, off: true, you: side, yours: yours };
      emitStats();
      return;
    }

    var mine = indexCurrentTree();
    var groups = 0, marked = 0, gi = 0;
    var reopen = null;

    mine.forEach(function (entries) {
      // Interesting only if the same position is reachable more than one way.
      if (entries.length < 2) return;

      groups++;
      var color = PALETTE[gi++ % PALETTE.length];

      entries.forEach(function (e) {
        var el = document.querySelector('[data-node="' + e.key + '"]');
        if (!el) return;

        if (settings.outline) {
          el.classList.add('qx-t');
          el.style.setProperty('--qx-c', color);
        }

        var others = entries.filter(function (o) { return o !== e; });

        var badge = document.createElement('span');
        badge.className = 'qx-badge';
        badge.textContent = settings.minBadge ? '⇄' : ('⇄' + others.length);
        badge.__qxOthers = others;
        badge.title = 'Same position: ' + others.length + ' other move order'
          + (others.length > 1 ? 's' : '');

        el.appendChild(badge);
        marked++;
        if (wasOpen && e.key === wasOpen) reopen = badge;
      });
    });

    // Survive a re-render that happened while the menu was open.
    if (reopen) openMenu(reopen);
    else openFor = null;

    lastStats = {
      isStudy: true,
      groups: groups,
      marked: marked,
      you: side,
      yours: yours,
      chapters: (G.studyData && G.studyData.chapters) ? G.studyData.chapters.length : 0
    };
    emitStats();
  }

  var refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(annotate, 40);
  }

  /* --------------------------------------------------------- practical eval
   *
   * A "Practical" column in the explorer table: for each of your candidate moves, your
   * expected score when every opponent reply is weighted by how often Lichess players
   * actually play it. The background worker does the fetching and the maths; this part
   * only decides which rows to ask for and paints what comes back.
   *
   * Values are kept in `pe.results`, keyed by position and move, so the table's rebuild
   * on every navigation (displayStatistics clears #database-trees) repaints instantly.
   * ---------------------------------------------------------------------- */

  var PE_MAX_AUTO = 8;
  // excluded: "<root>|<san>" keys the user right-clicked out of the analysis. Kept for
  // the browser session by the worker (chrome.storage.session), via the bridge.
  // maia: the Maia preview's results, keyed like `results` (see pePreview).
  var pe = { results: new Map(), maia: new Map(), gen: 0, root: null, stats: null, evals: null,
    timer: null, excluded: new Set(), rechecks: new Map() };

  function stripFen(f) {
    return String(f || '').trim().split(/\s+/).slice(0, 4).join(' ');
  }

  /*
   * The Eval header and the Score label sort the table (Qchess's maia-integration.js
   * binds them to setSortMode('eval') / ('score'), which does nothing when that sort is
   * already on). So a click is ours only once the table is sorted by that column; before
   * that it goes through and sorts. Unreadable sortMode: ours, as the site's own
   * handler then gives up too.
   */
  function sortedBy(mode) {
    var m = G.sortMode;
    return !m || m === mode;
  }

  function peActive() {
    return settings.peEnabled && G.dbOn !== false && !!G.fen &&
      !!document.getElementById('database-trees');
  }

  // Computed on your moves only: on the opponent's turn the column would model *your*
  // replies as the Lichess pool's, which answers a different question.
  function peMyTurn(f) {
    return (String(f || '').split(' ')[1] === 'b' ? 'black' : 'white') === userSide();
  }

  function sixMonthsAgo() {        // the page's own _sixMonthsAgoYYYYMM()
    var d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function csv(s) {
    return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // The panel's own filter when readable - from the binding, since localStorage only
  // gets a copy once the user has changed it.
  function peFilter() {
    var ls = G.lichessSettings;
    if (settings.peFollowPanel && ls && ls.speeds && ls.speeds.length && ls.ratings &&
        ls.ratings.length) {
      return { speeds: ls.speeds.slice(), ratings: ls.ratings.slice(),
        since: ls.recentOnly ? sixMonthsAgo() : '', panel: true,
        player: String(ls.player || '').trim() };
    }
    return { speeds: csv(settings.peSpeeds),
      ratings: csv(settings.peRatings).map(Number).filter(isFinite), since: '' };
  }

  function filterLabel(f) {
    var r = f.ratings.slice().sort(function (a, b) { return a - b; });
    var rr = r.length ? (r.length > 1 ? r[0] + '–' + r[r.length - 1] : String(r[0])) : 'all';
    return f.speeds.join('/') + ', ' + rr;
  }

  // SAN -> share of the games in the table's current rows.
  function peShares() {
    var st = pe.stats || G.lastStats || [];
    var total = 0, by = new Map();
    for (var i = 0; i < st.length; i++) {
      if (!st[i] || st[i].next_move == null) continue;
      var n = parseInt(st[i].total, 10) || 0;
      total += n;
      by.set(st[i].next_move, n);
    }
    by.forEach(function (n, san) { by.set(san, total ? n / total : 0); });
    return by;
  }

  function winFromCp(cp) {         // the Lichess curve, as in src/pe/search.js
    if (cp >= 29000) return 100;
    if (cp <= -29000) return 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  // SAN -> win% for the side to move, from the Eval column: pawns from White's point of
  // view, ChessDB where it knows the position (a mate comes through as about +-300).
  function peEvalWins() {
    var ev = pe.evals || G.lastEvals || {};
    var sign = String(G.fen || '').split(' ')[1] === 'b' ? -1 : 1;
    var out = new Map();
    Object.keys(ev).forEach(function (san) {
      var p = parseFloat(ev[san]);
      if (isFinite(p)) out.set(san, winFromCp(p * 100 * sign));
    });
    return out;
  }

  // The moves the table actually draws; a row without a cell is not worth a request.
  function peTableSans() {
    var out = new Set();
    var trees = document.getElementById('database-trees');
    var rows = trees ? trees.querySelectorAll('.tree-move') : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].classList.contains('total-row')) continue;
      var nm = rows[i].querySelector('.move-name');
      if (nm) out.add(String(nm.textContent || '').trim());
    }
    return out;
  }

  /*
   * Rows computed without a click: the moves the engine rates near its best, then the
   * ones people play. Popularity alone would skip a strong move that is rarely played -
   * exactly the kind of move worth comparing - and the engine alone would skip the moves
   * you are most likely to meet. Excluded rows are left out, so excluding the engine's
   * best lets the next one in.
   */
  function peAutoRows() {
    var root = stripFen(G.fen);
    var drawn = peTableSans();
    function ok(san) { return drawn.has(san) && !pe.excluded.has(root + '|' + san); }

    var margin = num(settings.ownMargin, 5);
    var shares = peShares();
    var byEval = [];
    peEvalWins().forEach(function (w, san) { if (ok(san)) byEval.push([san, w]); });
    // Evals are rounded to the centipawn, and a quiet position has a dozen moves at 0.00:
    // among equals, the more played one goes first.
    byEval.sort(function (a, b) {
      return (b[1] - a[1]) || ((shares.get(b[0]) || 0) - (shares.get(a[0]) || 0));
    });
    var list = byEval.filter(function (x) { return byEval[0][1] - x[1] <= margin; })
      .slice(0, Math.max(1, num(settings.ownMaxCandidates, 3)))
      .map(function (x) { return x[0]; });

    var min = num(settings.rowThreshold, 2) / 100;
    var byGames = [];
    shares.forEach(function (share, san) {
      if (share >= min && share > 0 && ok(san)) byGames.push([san, share]);
    });
    byGames.sort(function (a, b) { return b[1] - a[1]; });
    byGames.forEach(function (x) { if (list.indexOf(x[0]) < 0) list.push(x[0]); });
    return list.slice(0, PE_MAX_AUTO);
  }

  function peRemember(key, val, map) {
    map = map || pe.results;
    map.delete(key);
    map.set(key, val);
    if (map.size > 3000) map.delete(map.keys().next().value);
  }

  function num(v, dflt) {
    v = Number(v);
    return isFinite(v) && v >= 0 ? v : dflt;
  }

  // Deepening is worth resuming: a row whose search was cut short by navigating away.
  function peUnfinished(r) {
    return !!r && r.state === 'value' && r.final === false;
  }

  /*
   * A finished row whose search asked ChessDB to analyse positions it didn't know is
   * worth searching again when you come back, once ChessDB has had time to answer (a
   * queued position took about a minute when measured). Twice at most per page load:
   * some positions ChessDB won't analyse, and the row would otherwise re-run forever.
   */
  var PE_RECHECK_MS = 150000, PE_RECHECKS = 2;
  function peRecheck(key, r) {
    return !!r && r.state === 'value' && r.final !== false && r.analysing > 0
      && Date.now() - (r.at || 0) >= PE_RECHECK_MS && (pe.rechecks.get(key) || 0) < PE_RECHECKS;
  }
  function peResume(key, r) {
    if (peUnfinished(r)) return true;
    if (!peRecheck(key, r)) return false;
    pe.rechecks.set(key, (pe.rechecks.get(key) || 0) + 1);
    return true;
  }

  // A row to send for a position just entered: its Lichess value is missing or worth
  // resuming, or its Maia value is (with the preview on, the column can show either).
  // Sending a row runs both; the one already done comes back from the cache.
  function peNeeds(key) {
    var r = pe.results.get(key);
    if (!r || peResume(key, r)) return true;
    if (!pePreviewOn()) return false;
    var m = pe.maia.get(key);
    return !m || peUnfinished(m);
  }

  // Maia stands in for the games of the filter's players, so it plays at their rating:
  // the mean of the rating buckets' midpoints (2500 is 2500+), clamped to Maia's range.
  var MAIA_MID = { 0: 800, 1000: 1100, 1200: 1300, 1400: 1500, 1600: 1700, 1800: 1900,
    2000: 2100, 2200: 2350, 2500: 2650 };
  function peMaiaElo(filter) {
    var r = (filter && filter.ratings) || [], sum = 0, n = 0;
    r.forEach(function (b) {
      var m = MAIA_MID[b] != null ? MAIA_MID[b] : Number(b) + 100;
      if (isFinite(m)) { sum += m; n++; }
    });
    var elo = n ? sum / n : 1900;
    return Math.max(600, Math.min(2600, Math.round(elo / 50) * 50));
  }

  function peSend(rows, add, remove) {
    var f = G.fen;
    var filter = peFilter();
    var root = stripFen(f);
    var shares = {};
    var all = peShares();
    rows.forEach(function (san) {
      shares[san] = all.get(san) || 0;
      // A row with a value keeps showing it while it resumes or is searched again.
      var r = pe.results.get(root + '|' + san);
      if (!r || r.state !== 'value') {
        peRemember(root + '|' + san, { state: 'queued' });
      }
    });
    document.dispatchEvent(new CustomEvent('qx:pe:request', { detail: JSON.stringify({
      gen: pe.gen, rootFen: f, rows: rows, add: !!add, remove: remove || [],
      filter: filter, shares: shares,
      opts: {
        replyThreshold: num(settings.replyThreshold, 3) / 100,
        minGames: num(settings.minGames, 50),
        reachFloor: num(settings.reachFloor, 2) / 100,
        maxPly: num(settings.maxPly, 6),
        ownMargin: num(settings.ownMargin, 5),
        ownMaxCandidates: Math.max(1, num(settings.ownMaxCandidates, 3)),
        budget: num(settings.peRequestBudget, 60),
        maia: settings.peMaia !== false,
        maiaPreview: settings.peMaia !== false && settings.peMaiaPreview !== false,
        maiaElo: peMaiaElo(filter),
        maiaUntil: num(settings.maiaUntil, 100),
        maiaOnlyBelow: num(settings.maiaOnlyBelow, 10),
        maiaWeight: num(settings.maiaWeight, 20),
        prep: settings.prepEnabled !== false,
        prepPriorGames: num(settings.prepPriorGames, 50)
      }
    }) }));
  }

  function peRequest() {
    if (!peActive()) return;
    var f = G.fen;
    var root = stripFen(f);
    var mine = peMyTurn(f);
    if (root !== pe.root) {
      // A new position cancels the rows still running for the old one. Rows already
      // answered stay in pe.results, so going back is instant.
      pe.gen++;
      pe.root = root;
      pe.results.forEach(function (v, k) {
        if (v.state === 'queued' && k.indexOf(root + '|') !== 0) pe.results.delete(k);
      });
      var need = [];
      if (mine) {
        need = peAutoRows().filter(function (san) { return peNeeds(root + '|' + san); });
        // Rows computed by a click, and left before they finished, resume too.
        pe.results.forEach(function (v, k) {
          if (k.indexOf(root + '|') !== 0 || pe.excluded.has(k)) return;
          if (need.indexOf(k.slice(root.length + 1)) >= 0 || !peNeeds(k)) return;
          var san = k.slice(root.length + 1);
          if (need.indexOf(san) < 0) need.push(san);
        });
      }
      peSend(need, false);      // sent even when empty: it still cancels the old root
      return;
    }
    if (!mine) return;
    // Same position, e.g. the table's second render once ChessDB answered.
    var more = peAutoRows().filter(function (san) { return !pe.results.has(root + '|' + san); });
    if (more.length) peSend(more, true);
  }

  var PE_MAIA_MISSING = 'Maia unavailable: turn Maia on in Qchess once to download its '
    + 'model, then thin positions are filled in with its predictions.';

  // m: the row's Maia preview, if any, for comparison.
  function peTooltip(r, filter, m) {
    if (r.state === 'few') {
      return 'Only ' + (r.games || 0) + ' games here with the current filter (minimum '
        + settings.minGames + ').' + (r.engine != null ? '\nEngine: ' + Math.round(r.engine) + '%' : '')
        + (r.maiaMissing ? '\n' + PE_MAIA_MISSING : '');
    }
    if (r.state === 'none') return 'ChessDB has no eval for this position.';
    if (r.state === 'error') return r.reason + '\nClick to retry.';
    var lines = [peValueLine('Practical ' + Math.round(r.value) + '%', r)];
    lines.push((r.games || 0).toLocaleString('en-US') + ' games · Lichess ' + filterLabel(filter));
    peReplyLines(r, lines, true);
    if (r.maia >= 0.005) {
      lines.push('Maia: ' + Math.round(r.maia * 100) + '% of this value (rating ' + r.maiaElo
        + '), filling in where there are under ' + num(settings.maiaUntil, 100) + ' games');
    } else if (r.maiaMissing) {
      lines.push(PE_MAIA_MISSING);
    }
    if (r.analysing > 0) {
      lines.push('ChessDB had no eval for ' + r.analysing + ' position' + (r.analysing === 1 ? '' : 's')
        + ' or move' + (r.analysing === 1 ? '' : 's') + ' this needs, and was asked to analyse '
        + (r.analysing === 1 ? 'it' : 'them') + '. '
        + (r.final === false ? 'Deeper rounds pick up its answers.'
          : 'Come back in a few minutes to search again with its answers.'));
    }
    peSwitchLines(r, lines);
    if (m) {
      lines.push('Maia preview: ' + Math.round(m.value) + '% at depth ' + m.depth
        + ', with Maia\'s predictions in place of games');
    }
    lines.push(peDepthLine(r));
    return lines.join('\n');
  }

  // "<label> · engine 55% (+3)"
  function peValueLine(label, r) {
    var diff = r.engine != null ? Math.round(r.value - r.engine) : null;
    return label + (r.engine != null
      ? ' · engine ' + Math.round(r.engine) + '% (' + (diff >= 0 ? '+' : '') + diff + ')' : '');
  }

  // The main replies, then the tail valued by engine and the share left out. `maiaMark`
  // flags replies with no games, which says nothing in the preview: none have any there.
  function peReplyLines(r, lines, maiaMark) {
    var min = (Number(settings.replyThreshold) || 0) / 100;
    (r.replies || []).filter(function (x) { return x.share >= min; }).slice(0, 8)
      .forEach(function (x) {
        lines.push('  ' + x.san + '  ' + Math.round(x.share * 100) + '% → ' + Math.round(x.v) + '%'
          + (x.move ? '  (' + x.move + ')' : '') + (maiaMark && x.maiaOnly ? '  Maia' : ''));
      });
    if (r.tailShare > 0.0005) {
      lines.push('  others under ' + settings.replyThreshold + '%: '
        + (r.tailShare * 100).toFixed(1) + '% (engine eval)');
    }
    if (r.unexplained > 0.0005) {
      lines.push('  no engine eval: ' + (r.unexplained * 100).toFixed(1) + '% (left out)');
    }
  }

  function peSwitchLines(r, lines) {
    (r.switches || []).forEach(function (w) {
      lines.push('Your move ' + (w.path.length ? 'after ' + w.path.join(' ') : 'here') + ': '
        + w.to + ', not ChessDB\'s ' + w.from + ' (+' + w.gain.toFixed(1) + ')');
    });
  }

  function peDepthLine(r) {
    var depth = 'Depth ' + r.depth + ' · ' + r.positions + ' position'
      + (r.positions === 1 ? '' : 's') + ' searched';
    if (r.final === false) depth += ' · searching deeper…';
    else if (r.stopped === 'budget') depth += ' · stopped: request budget for this position used';
    else if (r.stopped === 'maxPly') depth += ' · stopped at the depth limit';
    else if (r.stopped === 'error') depth += ' · stopped: a request failed';
    else if (r.complete) depth += ' · complete: nothing deeper to search';
    return depth;
  }

  /*
   * The Maia preview (src/pe/rounds.js, createPreviewedSearch): the same search with
   * Maia's predictions in place of Lichess games. It needs ChessDB and Maia only, so it
   * reaches depth 3 and 5 while the Lichess search is still at depth 1. The column shows
   * one of the two, the user's choice (settings.peView, switched by clicking the header),
   * and the header flags the other one when it is deeper (peAltDepth).
   */
  function pePreviewOn() {
    return settings.peMaia !== false && settings.peMaiaPreview !== false;
  }

  function peViewMaia() {
    return pePreviewOn() && settings.peView === 'maia';
  }

  function peViewToggle() {
    if (!pePreviewOn()) return;
    settings.peView = peViewMaia() ? 'lichess' : 'maia';
    // Saved through the bridge like prepBar, so it persists across page loads.
    document.dispatchEvent(new CustomEvent('qx:pe:view', {
      detail: JSON.stringify(settings.peView) }));
    pePaint();
  }

  // The deepest value `map` holds for the rows the table shows at this position.
  function peDepthOf(map, root, sans) {
    var d = 0;
    sans.forEach(function (san) {
      var key = san && root + '|' + san;
      if (!key || pe.excluded.has(key)) return;
      var r = map.get(key);
      if (r && r.state === 'value' && r.depth > d) d = r.depth;
    });
    return d;
  }

  function pePreviewTooltip(m, r) {
    var lines = [peValueLine('Maia ' + Math.round(m.value) + '%', m)];
    lines.push('Replies weighted by Maia\'s predictions (rating ' + m.maiaElo + '), not by '
      + 'Lichess games.');
    peReplyLines(m, lines, false);
    peSwitchLines(m, lines);
    lines.push(peDepthLine(m));
    lines.push(r && r.state === 'value'
      ? 'Lichess: ' + Math.round(r.value) + '% at depth ' + r.depth
        + (r.final === false ? ', searching…' : '')
      : r && r.state !== 'queued' ? 'Lichess: no value' : 'Lichess: computing…');
    return lines.join('\n');
  }

  // A cell in Maia's view: its value in purple italics, with the same depth marker as a
  // Lichess value. r: the row's Lichess result, for the tooltip.
  function peRenderMaia(cell, m, r, mine, best) {
    var cls = ['qx-pe', 'qx-maia', 'qx-mp'];
    var text = '', title = '', depth = '';
    if (!mine) {
      cls = ['qx-pe'];
      title = 'Practical: computed on your moves only.';
    } else if (!m) {
      if (r) {
        cls.push('qx-q');
        text = '·';
        title = 'Computing…';
      } else {
        cls = ['qx-pe', 'qx-od'];
        title = 'Click to compute the practical score for this move.';
      }
    } else if (m.state === 'value') {
      text = Math.round(m.value) + (m.final === false ? '' : '%');
      if (m.final === false) depth = 'd' + m.depth;
      if (best != null && Math.round(m.value) === best) cls.push('qx-best');
      title = pePreviewTooltip(m, r);
    } else if (m.state === 'error') {
      cls = ['qx-pe', 'qx-od'];
      text = '?';
      title = m.reason + '\nClick to retry.';
    } else {
      text = '–';
      title = m.state === 'none' ? 'ChessDB has no eval for this position.'
        : m.maiaMissing ? PE_MAIA_MISSING : 'No value from Maia here.';
    }
    cell.className = cls.join(' ');
    cell.textContent = text;
    if (depth) cell.setAttribute('data-d', depth); else cell.removeAttribute('data-d');
    cell.title = title;
  }

  /*
   * Green: the highest value among `vals`, compared as displayed, so that equal-looking
   * numbers are marked alike. Values only compare at one depth - deeper ones drift
   * upwards - so a row at another depth (one added by a click, catching up) sits out; a
   * row that can't go any deeper (`complete`) is exact at every depth and always takes
   * part. With fewer than two to compare, nothing is marked.
   */
  function peBestOf(vals) {
    var top = 0;
    vals.forEach(function (r) { if (!r.complete && r.depth > top) top = r.depth; });
    var best = null, cmp = new Set();
    vals.forEach(function (r) {
      if (!r.complete && r.depth !== top) return;
      cmp.add(r);
      var v = Math.round(r.value);
      if (best == null || v > best) best = v;
    });
    return { best: cmp.size < 2 ? null : best, cmp: cmp };
  }

  // m: the row's Maia preview, named in the tooltip once the Lichess value has taken over.
  function peRenderCell(cell, r, mine, filter, best, m) {
    var cls = ['qx-pe'];
    var text = '', title = '', depth = '';
    if (!mine) {
      title = 'Practical: computed on your moves only.';
    } else if (!r) {
      cls.push('qx-od');
      title = 'Click to compute the practical score for this move.';
    } else if (r.state === 'queued') {
      cls.push('qx-q');
      text = '·';
      title = 'Computing…';
    } else if (r.state === 'value') {
      text = Math.round(r.value) + (r.final === false ? '' : '%');
      if (r.final === false) depth = 'd' + r.depth;
      if (best != null && Math.round(r.value) === best) cls.push('qx-best');
      if (r.maia >= 0.5) cls.push('qx-maia');
      title = peTooltip(r, filter, m && m.state === 'value' && m.value != null ? m : null);
    } else if (r.state === 'few' || r.state === 'none') {
      text = '–';
      title = peTooltip(r, filter);
    } else {
      cls.push('qx-od');
      text = '?';
      title = peTooltip(r, filter);
    }
    cell.className = cls.join(' ');
    cell.textContent = text;
    if (depth) cell.setAttribute('data-d', depth); else cell.removeAttribute('data-d');
    // A native title: never clipped by the row's overflow:hidden, and it takes over from
    // the row's own title (average Elo) while hovering this cell.
    cell.title = title;
  }

  function peEnsureCell(row, cls) {
    var cell = row.querySelector('.' + cls);
    if (cell) return cell;
    cell = document.createElement('div');
    cell.className = cls;
    var ev = row.querySelector('.move-eval');
    row.insertBefore(cell, ev ? ev.nextSibling : null);
    return cell;
  }

  function peClear() {
    var els = document.querySelectorAll('.qx-pe, .qx-pe-h');
    for (var i = 0; i < els.length; i++) els[i].remove();
    prepPaint(null);
  }

  /*
   * The header: "Prac" or, showing Maia's values, "Maia". `depths` ({lichess, maia}, the
   * deepest value each has here; null off your turn) puts the hidden one's depth before
   * the label when it is deeper than the one shown: worth a click to see.
   */
  function peHeader(h, filter, viewMaia, depths) {
    var sw = pePreviewOn();
    h.textContent = viewMaia ? 'Maia' : 'Prac';
    h.classList[sw ? 'add' : 'remove']('qx-pe-sw');
    h.classList[viewMaia ? 'add' : 'remove']('qx-pe-hm');
    var shownD = depths ? (viewMaia ? depths.maia : depths.lichess) : 0;
    var hiddenD = depths && sw ? (viewMaia ? depths.lichess : depths.maia) : 0;
    var alt = hiddenD > shownD ? String(hiddenD) : null;
    h.classList[alt && !viewMaia ? 'add' : 'remove']('qx-alt-m');
    h.classList[alt && viewMaia ? 'add' : 'remove']('qx-alt-l');
    if (alt) {
      if (h.getAttribute('data-alt') !== alt) h.setAttribute('data-alt', alt);
    } else {
      h.removeAttribute('data-alt');
    }

    var notes = [];
    if (alt) {
      notes.push((viewMaia ? 'The Lichess values' : 'Maia\'s values') + ' have reached depth '
        + hiddenD + ' here' + (shownD ? ', these depth ' + shownD : '') + '. Click to see them.');
    }
    if (G.selectedDB !== 'Lichess') notes.push('Practical: Lichess data');
    if (viewMaia) {
      notes.push('Maia: your expected score when each opponent reply is weighted by Maia\'s '
        + 'predictions at the filter\'s rating instead of by Lichess games. ChessDB and Maia '
        + 'only, so it deepens in seconds. Green: the highest among rows searched to the '
        + 'same depth. A small d3 after a number: still searching, 3 plies deep so far.');
    } else {
      notes.push('Your expected score when each opponent reply is weighted by how often '
        + 'Lichess players (' + filterLabel(filter) + ') play it. Green: the highest '
        + 'practical score among rows searched to the same depth. A small d3 after a number: '
        + 'still searching, 3 plies deep so far; all rows finish a depth before any goes '
        + 'deeper.'
        + (settings.peMaia !== false ? ' Purple: mostly Maia\'s predictions, where there are '
          + 'under ' + num(settings.maiaUntil, 100) + ' games.' : ''));
    }
    if (sw) {
      notes.push('Click to show ' + (viewMaia ? 'the Lichess values.'
        : 'Maia\'s values: its predictions in place of Lichess games, much faster.'));
    }
    if (filter.player) notes.push('The panel\'s player filter is not applied here.');
    h.title = notes.join('\n');
  }

  function pePaint() {
    var header = document.getElementById('db-column-header');
    var trees = document.getElementById('database-trees');
    if (!settings.peEnabled) { peClear(); return; }
    if (!header || !trees) return;

    var narrow = trees.clientWidth > 0 && trees.clientWidth < 300;
    header.classList[narrow ? 'add' : 'remove']('qx-pe-narrow');
    trees.classList[narrow ? 'add' : 'remove']('qx-pe-narrow');

    var filter = peFilter();
    var f = G.fen;
    var root = stripFen(f);
    var mine = peMyTurn(f);
    var rows = trees.querySelectorAll('.tree-move');
    var sans = [];
    for (var i = 0; i < rows.length; i++) {
      var nm = rows[i].classList.contains('total-row') ? null : rows[i].querySelector('.move-name');
      sans.push(nm ? String(nm.textContent || '').trim() : null);
    }
    var viewMaia = peViewMaia();
    peHeader(peEnsureCell(header, 'qx-pe-h'), filter, viewMaia, mine ? {
      lichess: peDepthOf(pe.results, root, sans), maia: peDepthOf(pe.maia, root, sans) } : null);

    // The view's values, compared among themselves for the green (peBestOf). The
    // prepared bars rest on the Lichess values whichever view is on.
    var vals = [], shown = [];
    sans.forEach(function (san) {
      var key = san && root + '|' + san;
      if (!key || pe.excluded.has(key)) return;
      var r = pe.results.get(key), m = pe.maia.get(key);
      if (r && r.state === 'value') vals.push(r);
      var v = viewMaia ? m : r;
      if (v && v.state === 'value') shown.push(v);
    });
    var best = peBestOf(shown);
    var cmp = peBestOf(vals).cmp;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.classList.contains('total-row')) {
        peEnsureCell(row, 'qx-pe').textContent = '';      // keeps the columns aligned
        continue;
      }
      var san = sans[i];
      if (san == null) continue;
      var cell = peEnsureCell(row, 'qx-pe');
      cell.setAttribute('data-san', san);
      if (mine && pe.excluded.has(root + '|' + san)) {
        cell.className = 'qx-pe qx-x';
        cell.textContent = '×';
        cell.removeAttribute('data-d');
        cell.title = 'Excluded from Practical. Right-click to include it again.';
        continue;
      }
      var res = pe.results.get(root + '|' + san), mres = pe.maia.get(root + '|' + san);
      if (viewMaia) {
        peRenderMaia(cell, mres, res, mine, best.cmp.has(mres) ? best.best : null);
      } else {
        peRenderCell(cell, res, mine, filter, best.cmp.has(res) ? best.best : null, mres);
      }
    }
    prepPaint({ rows: rows, sans: sans, root: root, mine: mine, cmp: cmp, filter: filter });
  }

  /* ------------------------------------------------------- prepared score
   *
   * The same search also gives each row a prepared split: its results as if you play the
   * Practical choice at each of your turns, opponents keeping their real replies (see
   * src/pe/search.js). There is no room for another column, so a click on the Score
   * header label switches the Score column's bars between the panel's own results and
   * these.
   *
   * The page's bars (displayStatistics): each normal row's .move-percentages holds
   * exactly three div.percentage-bar - .white-bar, .draw-bar, .black-bar - with an inline
   * width and the text "<round(x)>%" only when x >= 15. Novelty rows (span.novelty-text)
   * and placeholders ('?') have no bars and are left alone, as is the totals row. Only
   * widths, text, title and classes are ever changed, never the structure; the raw values
   * are kept in data- attributes and put back when the mode goes off.
   * ---------------------------------------------------------------------- */

  var PREP_CLS = ['qx-prep', 'qx-prep-muted', 'qx-prep-raw', 'qx-prep-best'];

  function prepActive() {
    return !!settings.peEnabled && settings.prepEnabled !== false;
  }

  function prepToggle() {
    settings.prepBar = !settings.prepBar;
    // Saved through the bridge, so it persists and the popup shows it.
    document.dispatchEvent(new CustomEvent('qx:pe:prepBar', {
      detail: JSON.stringify(!!settings.prepBar) }));
    pePaint();
  }

  function prepBarsOf(mp) {
    var c = mp && mp.children;
    if (!c || c.length !== 3) return null;
    if (!c[0].classList.contains('white-bar') || !c[1].classList.contains('draw-bar') ||
        !c[2].classList.contains('black-bar')) return null;
    return [c[0], c[1], c[2]];
  }

  // The page's own label rule, so a prepared bar reads exactly like a raw one.
  function prepBarText(x) {
    if (!(x >= 15)) return '';
    return ((Math.round(x) === 0 && x > 0) ? x.toFixed(1) : Math.round(x)) + '%';
  }

  function prepSave(mp, bars) {
    bars.forEach(function (b) {
      if (b.getAttribute('data-qx-w') != null) return;
      b.setAttribute('data-qx-w', b.style.width || '');
      b.setAttribute('data-qx-t', b.textContent || '');
    });
    if (mp.getAttribute('data-qx-title') == null) mp.setAttribute('data-qx-title', mp.title || '');
  }

  function prepRestore(mp) {
    var bars = prepBarsOf(mp);
    (bars || []).forEach(function (b) {
      var w = b.getAttribute('data-qx-w');
      if (w == null) return;
      b.style.width = w;
      b.textContent = b.getAttribute('data-qx-t') || '';
      b.removeAttribute('data-qx-w');
      b.removeAttribute('data-qx-t');
    });
    var t = mp.getAttribute('data-qx-title');
    if (t != null) { mp.title = t; mp.removeAttribute('data-qx-title'); }
    PREP_CLS.forEach(function (c) { mp.classList.remove(c); });
  }

  function prepSetBars(bars, split) {
    [split.w, split.d, split.b].forEach(function (f, i) {
      var x = Math.max(0, f * 100);
      bars[i].style.width = x + '%';
      bars[i].textContent = prepBarText(x);
    });
  }

  function prepScore(split, side) {
    if (!split) return null;
    return (side === 'b' ? split.b : split.w) + split.d / 2;
  }

  function pct(f) { return Math.round(f * 100); }
  function splitText(s) { return pct(s.w) + ' / ' + pct(s.d) + ' / ' + pct(s.b); }

  // The panel's own row, when it shows the same Lichess data as the search.
  function prepPanelRow(san, filter) {
    if (G.selectedDB !== 'Lichess' || !filter.panel) return null;
    var st = pe.stats || G.lastStats || [];
    for (var i = 0; i < st.length; i++) {
      if (st[i] && st[i].next_move === san) {
        var n = parseInt(st[i].total, 10) || 0;
        if (!n) return null;
        return { w: (parseInt(st[i].white_wins, 10) || 0) / n, d: (parseInt(st[i].draws, 10) || 0) / n,
          b: (parseInt(st[i].black_wins, 10) || 0) / n, n: n };
      }
    }
    return null;
  }

  function prepTooltip(r, san, side, filter) {
    var you = prepScore(r.prep, side);
    var lines = ['Prepared ' + splitText(r.prep) + (r.raw ? ' (these games ' + splitText(r.raw) + ')' : '')];
    var raw = prepScore(r.raw, side);
    var diff = raw != null ? pct(you) - pct(raw) : null;
    lines.push('Your expected score ' + pct(you) + '%' + (raw != null ? ' (' + pct(raw)
      + '% in these games, ' + (diff >= 0 ? '+' : '') + diff + ')' : ''));
    var min = (Number(settings.replyThreshold) || 0) / 100;
    (r.replies || []).filter(function (x) { return x.share >= min && x.prep; }).slice(0, 8)
      .forEach(function (x) {
        var a = prepScore(x.raw, side);
        lines.push('  ' + x.san + '  ' + (a != null ? pct(a) + '%' : '–') + ' → '
          + pct(prepScore(x.prep, side)) + '%' + (x.move ? '  (' + x.move + ')' : ''));
      });
    lines.push('Rests on Practical value: ' + pct(r.prior || 0) + '% · depth ' + r.depth + ' · '
      + (r.leafGames || 0).toLocaleString('en-US') + ' games at the leaves'
      + (r.final === false ? ' · searching deeper…' : ''));
    lines.push('Beyond depth ' + r.depth + ', results include everyone\'s later mistakes.');
    // The baseline above is always the search's own data; the panel's numbers only when
    // they are the same data.
    var p = prepPanelRow(san, filter);
    if (p) lines.push('Panel ' + splitText(p) + ' · ' + p.n.toLocaleString('en-US') + ' games');
    else lines.push('Lichess ' + filterLabel(filter) + (G.selectedDB && G.selectedDB !== 'Lichess'
      ? '; the panel shows ' + G.selectedDB + '.' : '.'));
    return lines.join('\n');
  }

  function prepLabel(on, filter) {
    var header = document.getElementById('db-column-header');
    var lab = document.getElementById('dbh-score-label');
    if (header) header.classList[on ? 'add' : 'remove']('qx-prep-toggle');
    if (!lab) return;
    if (lab.getAttribute('data-qx-text') == null) {
      lab.setAttribute('data-qx-text', lab.textContent || '');
      lab.setAttribute('data-qx-title', lab.title || '');
    }
    var orig = lab.getAttribute('data-qx-text');
    if (!on) {
      lab.textContent = orig;
      lab.title = lab.getAttribute('data-qx-title') || '';
      return;
    }
    // Text only: the site owns the label's classes (.sort-active-header), and sorting
    // still follows the raw data.
    lab.textContent = settings.prepBar ? 'Prepared' : orig;
    var what = 'results if you follow the Practical choices at your moves while opponents '
      + 'play their real replies, from Lichess data (' + filterLabel(filter) + ').';
    lab.title = (sortedBy('score') ? '' : 'Click to sort by score; click again to switch.\n')
      + (G.selectedDB !== 'Lichess' ? 'Prepared: Lichess data\n' : '')
      + (settings.prepBar ? 'Prepared: ' + what + ' Click for the panel\'s own results.'
        : 'Score: the panel\'s own results. Click for prepared ' + what);
  }

  // o: what pePaint worked out, or null to put everything back.
  function prepPaint(o) {
    var trees = document.getElementById('database-trees');
    var on = !!o && prepActive();
    var filter = o ? o.filter : null;
    if (on) prepLabel(true, filter); else prepLabel(false);
    if (!trees) return;
    if (!on || !settings.prepBar) {
      var all = trees.querySelectorAll('.move-percentages');
      for (var j = 0; j < all.length; j++) prepRestore(all[j]);
      return;
    }
    var side = String(G.fen || '').split(' ')[1] === 'b' ? 'b' : 'w';
    // The best-scoring highlight compares what green compares: rows at the same depth,
    // or complete. As displayed, and only with two or more to compare.
    var best = null, shown = 0;
    o.cmp.forEach(function (r) {
      if (!r.prep) return;
      shown++;
      var e = pct(prepScore(r.prep, side));
      if (best == null || e > best) best = e;
    });
    if (shown < 2) best = null;
    for (var i = 0; i < o.rows.length; i++) {
      var row = o.rows[i];
      var san = o.sans[i];
      if (row.classList.contains('total-row') || san == null) continue;
      var mp = row.querySelector('.move-percentages');
      var bars = prepBarsOf(mp);
      if (!bars) continue;                           // novelty or placeholder: untouched
      prepSave(mp, bars);
      var key = o.root + '|' + san;
      var r = pe.results.get(key);
      var usable = o.mine && !pe.excluded.has(key) && r && r.state === 'value' && r.prep;
      PREP_CLS.forEach(function (c) { mp.classList.remove(c); });
      if (!usable) {
        prepRestore(mp);
        prepSave(mp, bars);
        mp.classList.add('qx-prep-raw');
        mp.title = !o.mine ? 'Prepared: computed on your moves only. These are the panel\'s own results.'
          : 'No prepared split for this move' + (r && r.state === 'value' && !r.prep
            ? ' (computed while it was switched off; it comes back when this position is searched again)'
            : '') + '. These are the panel\'s own results.';
        continue;
      }
      prepSetBars(bars, r.prep);
      mp.classList.add('qx-prep');
      if (r.prior >= 0.5) mp.classList.add('qx-prep-muted');
      if (best != null && o.cmp.has(r) && pct(prepScore(r.prep, side)) === best) {
        mp.classList.add('qx-prep-best');
      }
      mp.title = prepTooltip(r, san, side, o.filter);
    }
  }

  function peRefresh() {
    pePaint();
    clearTimeout(pe.timer);
    pe.timer = setTimeout(function () {
      try { peRequest(); pePaint(); } catch (e) { console.warn('[qchess-transpositions]', e); }
    }, 150);
  }

  function peClickRow(san) {
    if (!peActive() || !san) return;
    var f = G.fen;
    if (!peMyTurn(f)) return;
    if (stripFen(f) !== pe.root) peRequest();         // make sure the gen is current
    peSend([san], true);
    pePaint();
  }

  /*
   * Right-click on a Practical cell: leave that move out of the analysis at this
   * position, or bring it back. Leaving it out stops its search, so its share of the
   * request budget goes to the other rows, and the depth rounds stop waiting for it.
   */
  function peToggleExclude(san) {
    if (!peActive() || !san) return;
    var f = G.fen;
    if (!peMyTurn(f)) return;
    var root = stripFen(f);
    if (root !== pe.root) peRequest();
    var key = root + '|' + san;
    var r = pe.results.get(key);
    var on = !pe.excluded.has(key);
    if (on) pe.excluded.add(key); else pe.excluded.delete(key);
    document.dispatchEvent(new CustomEvent('qx:pe:exclude', {
      detail: JSON.stringify({ key: key, on: on }) }));
    if (r && r.state === 'queued') pe.results.delete(key);   // it will never be answered
    if (on) peSend([], true, [san]);
    else if (!r || r.state === 'queued' || peUnfinished(r)) peSend([san], true);
    pePaint();
  }

  // The worker's list of excluded moves arrives once the page has loaded; rows it names
  // may already have been asked for.
  document.addEventListener('qx:pe:excludedList', function (e) {
    var keys;
    try { keys = JSON.parse(e.detail); } catch (err) { return; }
    if (!Array.isArray(keys)) return;
    var root = stripFen(G.fen), drop = [];
    keys.forEach(function (k) {
      if (pe.excluded.has(k)) return;
      pe.excluded.add(k);
      var r = pe.results.get(k);
      if (k.indexOf(root + '|') === 0 && root === pe.root) {
        if (r && (r.state === 'queued' || peUnfinished(r))) drop.push(k.slice(root.length + 1));
      }
      if (r && r.state === 'queued') pe.results.delete(k);
    });
    if (drop.length) peSend([], true, drop);
    pePaint();
  });

  /*
   * Maia for the search, which runs in the background worker and asks for positions
   * through the bridge. It gets its own instance of Qchess's Maia worker: the page's is
   * private to its script, and sharing it would mix our requests into its display. The
   * model is the one Qchess already keeps (its IndexedDB, same origin), so nothing is
   * downloaded; without it the worker reports 'no-cache' and the search goes on
   * without Maia. Only 'init' and 'policy' are ever sent - Qchess's worker also takes
   * 'clear', which deletes the model. Idle for a while, the instance is stopped to free
   * its memory.
   */
  var MAIA_WORKER = '/Frontend/maia/maia-worker.js';
  var MAIA_IDLE_MS = 90000;
  var maiaRun = { worker: null, state: 'off', queue: [], waiting: new Map(), next: 1, idle: null };

  function maiaReply(id, moves, status) {
    document.dispatchEvent(new CustomEvent('qx:pe:maiaResult', {
      detail: JSON.stringify({ id: id, moves: moves || null, status: status || 'ok' }) }));
  }

  function maiaStop(state) {
    if (maiaRun.worker) { try { maiaRun.worker.terminate(); } catch (e) {} }
    maiaRun.worker = null;
    maiaRun.state = state;
    maiaRun.queue.splice(0).forEach(function (q) { maiaReply(q.id, null, 'unavailable'); });
    maiaRun.waiting.forEach(function (id) { maiaReply(id, null, 'unavailable'); });
    maiaRun.waiting.clear();
  }

  function maiaTouch() {
    clearTimeout(maiaRun.idle);
    maiaRun.idle = setTimeout(function () {
      if (!maiaRun.waiting.size && !maiaRun.queue.length) maiaStop('off');
    }, MAIA_IDLE_MS);
  }

  function maiaPost(q) {
    var wid = maiaRun.next++;
    maiaRun.waiting.set(wid, q.id);
    maiaRun.worker.postMessage({ type: 'policy', id: wid, fen: q.fen, elo: q.elo });
  }

  function maiaStart() {
    if (maiaRun.worker) return;
    var w;
    try { w = new Worker(MAIA_WORKER, { type: 'module' }); } catch (e) { maiaStop('unavailable'); return; }
    maiaRun.worker = w;
    maiaRun.state = 'loading';
    w.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') {
        if (m.status === 'ready') {
          maiaRun.state = 'ready';
          maiaRun.queue.splice(0).forEach(maiaPost);
        } else if (m.status === 'no-cache') {
          maiaStop('unavailable');
        }
      } else if (m.type === 'policy-result' && maiaRun.waiting.has(m.id)) {
        var id = maiaRun.waiting.get(m.id);
        maiaRun.waiting.delete(m.id);
        // Everything but the long tail: it carries no weight, only message size.
        maiaReply(id, (m.moves || []).filter(function (x) { return x.prob >= 0.001; }));
        maiaTouch();
      } else if (m.type === 'error') {
        if (m.id != null && maiaRun.waiting.has(m.id)) {
          var qid = maiaRun.waiting.get(m.id);
          maiaRun.waiting.delete(m.id);
          maiaReply(qid, null, 'error');
        } else if (m.id == null) {
          maiaStop('unavailable');
        }
      }
    };
    w.onerror = function () { maiaStop('unavailable'); };
    w.postMessage({ type: 'init' });
  }

  document.addEventListener('qx:pe:maia', function (e) {
    var q;
    try { q = JSON.parse(e.detail); } catch (err) { return; }
    if (!q || q.id == null || !q.fen) return;
    // Missing model: ask again only once Qchess's own Maia is on, i.e. the model exists.
    if (maiaRun.state === 'unavailable') {
      var on = false;
      try { on = typeof window.maiaIsEnabled === 'function' && window.maiaIsEnabled(); } catch (err) {}
      if (!on) { maiaReply(q.id, null, 'unavailable'); return; }
      maiaRun.state = 'off';
    }
    maiaStart();
    if (maiaRun.state === 'ready') maiaPost(q); else if (maiaRun.worker) maiaRun.queue.push(q);
    maiaTouch();
  });

  document.addEventListener('qx:pe:update', function (e) {
    var msg;
    try { msg = JSON.parse(e.detail); } catch (err) { return; }
    if (!msg || !msg.root || !msg.san || !msg.result) return;
    if (msg.result.state === 'excluded') return;     // the worker confirming a right-click
    msg.result.at = Date.now();
    peRemember(msg.root + '|' + msg.san, msg.result, msg.pass === 'maia' ? pe.maia : pe.results);
    if (msg.root === stripFen(G.fen)) pePaint();
  });

  // The page renders the explorer table through one function; re-apply the column
  // after each call, including the deferred ones made after a drag.
  function hookStats() {
    var f = window.displayStatistics;
    if (typeof f !== 'function' || f.__qxWrapped) return;
    var wrapped = function (stats, evals) {
      var key = '', cdb;
      try { key = stripFen(G.fen); cdb = key && cdbSeen.get(key); } catch (e) {}
      var r;
      if (cdb) {
        evals = Object.assign({}, evals || {}, cdb);
        r = f.call(this, stats, evals);
      } else {
        r = f.apply(this, arguments);
      }
      cdbDrawn = key;
      try { cdbGate(key, !!cdb); cdbTitle(); } catch (e) { console.warn('[qchess-transpositions]', e); }
      // Later in this task, since the Elite path asks ChessDB just after rendering.
      if (!cdb && key) setTimeout(function () { cdbNeed(key); }, 0);
      try { pe.stats = stats; pe.evals = evals || null; peRefresh(); } catch (e) {
        console.warn('[qchess-transpositions]', e);
      }
      return r;
    };
    wrapped.__qxWrapped = true;
    window.displayStatistics = wrapped;
  }

  /*
   * ChessDB evals in the explorer's Eval column. The page fetches ChessDB's queryall and
   * has its shared AnalysisWorker turn the UCI moves into SAN (normalizeChessDBResults).
   * Its listener takes the first 'uciListToSanDone' that worker sends, whichever request
   * it answers, so when two positions' conversions overlap (quick navigation, the worker
   * busy with Stockfish lines) a position gets the other position's move names. None of
   * them match the table, ChessDB's evals are silently dropped, and the column keeps the
   * qchess database's older evals, which the page then caches for the session. It also
   * gives up after 3 s. Replaced by the same conversion in our own instance of that
   * worker, with each reply matched to its request.
   */
  var SAN_WORKER = '/Frontend/AnalysisWorker.js';
  var SAN_TIMEOUT_MS = 10000;
  var sanRun = { worker: null, broken: false, waiting: [] };

  function sanStop() {
    if (sanRun.worker) { try { sanRun.worker.terminate(); } catch (e) {} }
    sanRun.worker = null;
    sanRun.broken = true;
    sanRun.waiting.splice(0).forEach(function (q) { q.done(null); });
  }

  function sanStart() {
    if (sanRun.worker || sanRun.broken) return !!sanRun.worker;
    try { sanRun.worker = new Worker(SAN_WORKER, { type: 'module' }); } catch (e) {
      sanRun.broken = true;
      return false;
    }
    sanRun.worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.event !== 'uciListToSanDone' || !Array.isArray(m.sanMoves)) return;
      // The worker echoes the FEN it was given; that plus the list length is the match.
      for (var i = 0; i < sanRun.waiting.length; i++) {
        var q = sanRun.waiting[i];
        if (q.fen === m.fen && q.n === m.sanMoves.length) {
          sanRun.waiting.splice(i, 1);
          q.done(m.sanMoves);
          return;
        }
      }
    };
    sanRun.worker.onerror = sanStop;
    return true;
  }

  // The SAN list; [] after a timeout; null when our worker can't be used at all.
  function sanOf(fen, uciMoves) {
    return new Promise(function (resolve) {
      if (!sanStart()) { resolve(null); return; }
      var q = { fen: fen, n: uciMoves.length, done: null };
      var timer = setTimeout(function () {
        var i = sanRun.waiting.indexOf(q);
        if (i >= 0) sanRun.waiting.splice(i, 1);
        resolve([]);
      }, SAN_TIMEOUT_MS);
      q.done = function (san) { clearTimeout(timer); resolve(san); };
      sanRun.waiting.push(q);
      sanRun.worker.postMessage({ event: 'uciListToSan', fen: fen, uciMoves: uciMoves });
    });
  }

  /*
   * The page draws the table first with its own database's evals (older ChessDB
   * snapshots) and again once ChessDB answers, so a stale number shows for a moment on
   * every visit. Instead: ChessDB's evals as last converted are kept per position for
   * this page load and laid over the page's in every render, and until ChessDB has
   * answered for the shown position the Eval column is hidden. If it never answers (the
   * page's fetch failed), the page's evals show after CDB_WAIT_MS.
   */
  var CDB_WAIT_MS = 5000;
  var CDB_KEEP = 500;
  var cdbSeen = new Map();          // stripped FEN -> {SAN: pawns}; {} when ChessDB had none
  var cdbWait = { key: null, timer: null, gaveUp: null };

  function cdbShow() {
    clearTimeout(cdbWait.timer);
    cdbWait.key = null;
    var trees = document.getElementById('database-trees');
    if (trees) trees.classList.remove('qx-cdb-wait');
  }

  function cdbRecord(fen, evals) {
    var key = stripFen(fen);
    cdbSeen.delete(key);
    cdbSeen.set(key, evals || {});
    if (cdbSeen.size > CDB_KEEP) cdbSeen.delete(cdbSeen.keys().next().value);
    // The page's own re-render follows in the same task when there are evals; with
    // none it doesn't render again, so what it has is all there is.
    if (key === cdbWait.key) cdbShow();
  }

  // After a render of the table for `key`: hide its evals while ChessDB is outstanding.
  function cdbGate(key, known) {
    if (known || !key || key === cdbWait.gaveUp) { cdbShow(); return; }
    if (key === cdbWait.key) return;
    var trees = document.getElementById('database-trees');
    if (!trees) return;
    clearTimeout(cdbWait.timer);
    cdbWait.key = key;
    trees.classList.add('qx-cdb-wait');
    cdbWait.timer = setTimeout(function () {
      if (cdbWait.key !== key) return;
      cdbWait.gaveUp = key;
      cdbShow();
    }, CDB_WAIT_MS);
  }

  /*
   * On the Lichess path the page caches each table for the session (lichessCache) with
   * the evals it had once ChessDB answered - or, if you moved on before it did, the
   * Elite DB's alone. A cache hit redraws from that and never asks ChessDB again, so
   * such a position kept blank or stale evals until a page reload (or the Eval header's
   * refresh). So the page's own queryall requests are followed per position, and when
   * the shown position has no ChessDB answer and the page isn't asking, we ask.
   */
  var CDB_PAGE_GRACE_MS = 4000;     // an answer the page has, but hasn't converted yet
  var CDB_AUTO_AGAIN_MS = 60000;    // after an ask of ours that failed
  var cdbPage = new Map();          // stripped FEN -> {n: requests out, at: last answer}
  var cdbPageHooked = false;
  var cdbAuto = { key: null, at: 0 };
  var cdbDrawn = null;              // the position the table was last rendered for

  function hookCdbFetch() {
    var orig = window.fetchCDB;
    if (typeof orig !== 'function' || orig.__qxWrapped) return;
    var wrapped = function (params) {
      var p = orig.apply(this, arguments);
      var key = params && params.action === 'queryall' ? stripFen(params.board) : '';
      if (!key || !p || typeof p.then !== 'function') return p;
      var s = cdbPage.get(key);
      if (!s) {
        s = { n: 0, at: 0 };
        cdbPage.set(key, s);
        if (cdbPage.size > CDB_KEEP) cdbPage.delete(cdbPage.keys().next().value);
      }
      s.n++;
      // Registered before the page's own await, so this runs first; an answer then
      // gets the grace period to reach normalizeChessDBResults. An abort (the page
      // moved on, or its cache hit) or a failure is final.
      p.then(function () { s.n--; s.at = Date.now(); cdbNeed(key); },
        function () { s.n--; s.at = 0; cdbNeed(key); });
      return p;
    };
    wrapped.__qxWrapped = true;
    window.fetchCDB = wrapped;
    cdbPageHooked = true;
  }

  // Ask ChessDB ourselves for the shown position if nothing else will.
  function cdbNeed(key) {
    if (!cdbPageHooked || !key || key !== stripFen(G.fen) || cdbSeen.has(key) || !G.dbOn) return;
    // The page hasn't started on this position yet (its Lichess debounce): it will ask.
    var fetched = G.lastFetchedFen;
    if (fetched && stripFen(fetched) !== key) return;
    var s = cdbPage.get(key);
    if (s && s.n > 0) return;                 // runs again when the page's request settles
    var wait = s && s.at ? s.at + CDB_PAGE_GRACE_MS - Date.now() : 0;
    if (wait > 0) { setTimeout(function () { cdbNeed(key); }, wait); return; }
    if (cdbRefreshing === key) return;
    if (cdbAuto.key === key && Date.now() - cdbAuto.at < CDB_AUTO_AGAIN_MS) return;
    if (cdbAsk(false)) cdbAuto = { key: key, at: Date.now() };
  }

  function hookCdbEvals() {
    var orig = window.normalizeChessDBResults;
    if (typeof orig !== 'function' || orig.__qxWrapped) return;
    var fixed = function (fen, parsed) {
      var self = this, args = arguments;
      var page = function () { return orig.apply(self, args); };
      var items = parsed && parsed.kind === 'list' && parsed.items ? parsed.items.filter(function (it) {
        return it && (it.move || it.egtb || it.search);
      }) : [];
      var p;
      if (!items.length || typeof fen !== 'string') {
        p = Promise.resolve(page());
      } else {
        var uci = items.map(function (it) { return it.move || it.egtb || it.search; });
        // Same numbers as the page's: pawns, from White's point of view.
        var flip = (fen.split(' ')[1] || 'w').toLowerCase() === 'b' ? -1 : 1;
        p = sanOf(fen, uci).then(function (san) {
          if (!san) return page();
          var evals = {};
          items.forEach(function (it, i) {
            if (!san[i]) return;
            var cp = (Number(it.score || 0) / 100) * flip;
            evals[san[i]] = Number.isFinite(cp) ? Number(cp.toFixed(2)) : 0;
          });
          return evals;
        });
      }
      return p.then(function (evals) {
        if (typeof fen === 'string') {
          try { cdbRecord(fen, evals); } catch (e) { console.warn('[qchess-transpositions]', e); }
        }
        return evals;
      });
    };
    fixed.__qxWrapped = true;
    window.normalizeChessDBResults = fixed;
  }

  /*
   * Refresh: a click on the Eval header asks ChessDB about the shown position again.
   * The page doesn't on a revisit when Lichess is selected: it redraws the table from
   * its own cache for the session (lichessCache, ChessDB's evals merged in), so a
   * position ChessDB has analysed since (one the Practical search queued, say) kept its
   * old evals until a page reload. The answer goes through the same conversion as the
   * page's (normalizeChessDBResults, wrapped above), which records it in cdbSeen, so
   * every later render of the position lays it over, the page's cached ones included.
   */
  var CDB_URL = 'https://www.chessdb.cn/cdb.php';
  var CDB_REFRESH_MS = 10000;
  var cdbRefreshing = null;         // stripped FEN being asked about
  var cdbLast = { key: null, text: '' };

  function cdbEvalHeader() {
    var header = document.getElementById('db-column-header');
    return header ? header.querySelector('.move-eval') : null;
  }

  // Rerun after every render, which is also what follows a change of sort.
  function cdbTitle() {
    var h = cdbEvalHeader();
    if (!h) return;
    var armed = sortedBy('eval');
    var header = h.parentNode;
    if (header && header.classList) header.classList[armed ? 'add' : 'remove']('qx-cdb-armed');
    var t = armed ? 'Click to ask ChessDB again for this position\'s evals.'
      : 'Click to sort by eval. Once sorted, a click asks ChessDB again for this position\'s evals.';
    if (cdbLast.key && cdbLast.key === stripFen(G.fen)) t += '\n' + cdbLast.text;
    if (h.title !== t) h.title = t;
  }

  function cdbBusy(on) {
    ['db-column-header', 'database-trees'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList[on ? 'add' : 'remove']('qx-cdb-busy');
    });
  }

  function cdbRefresh() { cdbAsk(true); }

  // `manual`: the header's refresh, which dims the evals and reports in the header's
  // title. Otherwise cdbNeed's quiet ask. False if nothing was sent.
  function cdbAsk(manual) {
    var fen = G.fen, key = stripFen(fen);
    if (!key || cdbRefreshing || typeof fetch !== 'function' ||
        typeof window.parseQueryAll !== 'function' ||
        typeof window.normalizeChessDBResults !== 'function') return false;
    cdbRefreshing = key;
    if (manual) cdbBusy(true);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, CDB_REFRESH_MS);
    var at = new Date().toTimeString().slice(0, 5), answered = false;
    // no-store: ChessDB answers no-cache, which would still allow a revalidated copy.
    fetch(CDB_URL + '?action=queryall&showall=0&board=' + encodeURIComponent(fen),
      { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (txt) {
      var parsed = window.parseQueryAll(txt);
      return Promise.resolve(window.normalizeChessDBResults(fen, parsed)).then(function (evals) {
        var n = evals ? Object.keys(evals).length : 0;
        answered = true;
        if (manual) cdbLast = { key: key, text: n
          ? 'ChessDB asked again at ' + at + ': ' + n + ' move' + (n === 1 ? '' : 's') + '.'
          : 'ChessDB has no evals for this position (asked at ' + at + ').' };
      });
    }).catch(function (e) {
      if (!manual) return;
      cdbLast = { key: key, text: 'ChessDB didn\'t answer (asked at ' + at + ').' };
      console.warn('[qchess-transpositions] ChessDB refresh:', e);
    }).then(function () {
      clearTimeout(timer);
      cdbRefreshing = null;
      if (manual) cdbBusy(false);
      // Redrawn only if the table still shows that position; the wrapper lays the new
      // evals over the page's. A quiet ask can come while the page is still fetching
      // this position's games, with the last position's rows in lastStatsData: those
      // are only redrawn if the last render was already this position's.
      var stats = G.lastStats;
      if (answered && stripFen(G.fen) === key && (manual || cdbDrawn === key) &&
          Array.isArray(stats) && typeof window.displayStatistics === 'function') {
        try { window.displayStatistics(stats, G.lastEvals); } catch (e) {
          console.warn('[qchess-transpositions]', e);
        }
      }
      cdbTitle();
      // A position shown meanwhile may have been skipped while this was out.
      var now = stripFen(G.fen);
      if (now !== key) cdbNeed(now);
    });
    return true;
  }

  /* --------------------------------------------------------- clickable lines
   * In training mode, a comment holding a line in parentheses - "(3... Nc6 4. Bg2 e5)" -
   * gets clickable moves. Clicking one shows the position after it on the board, and
   * nothing else changes: the tree, `fen`, `currentNode` and the training state stay as
   * they were, so the next navigation of the site's (a notation move, the arrow keys
   * once the preview is left, the next training move) simply draws its own position.
   *
   * Where the line starts comes from the FENs, not from any marker in the comment: if
   * its first move number and side ("3..." = Black on move 3) are those of the
   * commented move's own position, it continues from there; if they are those of the
   * position before that move, it replaces the move. The two differ by a ply, so at
   * most one fits. A line that fits neither stays plain text.
   *
   * The moves are played in our own instance of the page's AnalysisWorker
   * ('emPlayMove', replies matched by id). Not the page's: its 'moveUsVerified' reply
   * goes to the handler that plays the user's training move.
   * ------------------------------------------------------------------------- */

  var CL_TIMEOUT_MS = 5000;
  var CL_KEEP = 200;
  var clRun = { worker: null, broken: false, seq: 0, waiting: {} };
  var clCache = new Map();    // startFen|sans -> Promise of [{san, fen, from, to}]
  var clView = null;          // {key, moves, index}: the preview on the board, else null
  var clOwnRender = false;    // true while we draw, so the renderFEN hook ignores us

  var CL_NUM = /^(\d+)(\.\.\.|…|\.)$/;
  var CL_NUM_SAN = /^(\d+)(\.\.\.|…|\.)(\S+)$/;
  var CL_SAN = /^(?:O-O(?:-O)?|0-0(?:-0)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=?[QRBN])?)[+#]?[!?]{0,2}$/;

  // Every "(N. move ...)" / "(N... move ...)" in `text`, with where each move sits in
  // it: [{no, black, moves: [{san, at, len}]}]. A group with anything other than move
  // numbers and moves in it (a remark in parentheses) isn't a line.
  function clParse(text) {
    var out = [], m, group = /\(([^()]*)\)/g;
    while ((m = group.exec(text))) {
      var base = m.index + 1, inner = m[1], tok, re = /\S+/g;
      var line = { no: 0, black: false, moves: [] }, ok = true, first = true;
      while ((tok = re.exec(inner))) {
        var s = tok[0], at = base + tok.index, num = CL_NUM.exec(s), both = CL_NUM_SAN.exec(s);
        if (both && !CL_SAN.test(both[3])) both = null;
        if (first) {
          if (!num && !both) { ok = false; break; }
          var hit = num || both;
          line.no = parseInt(hit[1], 10);
          line.black = hit[2] !== '.';
          first = false;
        }
        if (num) continue;
        if (both) {
          var skip = both[1].length + both[2].length;
          line.moves.push({ san: both[3], at: at + skip, len: both[3].length });
        } else if (CL_SAN.test(s)) {
          line.moves.push({ san: s, at: at, len: s.length });
        } else { ok = false; break; }
      }
      if (ok && line.moves.length) out.push(line);
    }
    return out;
  }

  // The FEN the line starts from: the commented node's own position, or the one before
  // it (the line replaces the node's move). null when neither has that move to play.
  function clStartFen(line, fen, parentFen) {
    function fits(f) {
      var p = String(f || '').split(' ');
      return p[1] === (line.black ? 'b' : 'w') && parseInt(p[5], 10) === line.no;
    }
    if (fits(fen)) return fen;
    if (parentFen && fits(parentFen)) return parentFen;
    return null;
  }

  function clStop() {
    if (clRun.worker) { try { clRun.worker.terminate(); } catch (e) {} }
    clRun.worker = null;
    clRun.broken = true;
    Object.keys(clRun.waiting).forEach(function (id) { clRun.waiting[id](null); });
    clRun.waiting = {};
  }

  function clStart() {
    if (clRun.worker || clRun.broken) return !!clRun.worker;
    try { clRun.worker = new Worker(SAN_WORKER, { type: 'module' }); } catch (e) {
      clRun.broken = true;
      return false;
    }
    clRun.worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.event !== 'emMovePlayed' || !clRun.waiting[m.emId]) return;
      var done = clRun.waiting[m.emId];
      delete clRun.waiting[m.emId];
      done(m);
    };
    clRun.worker.onerror = clStop;
    return true;
  }

  // One move: {san, fen, from, to}, false if it's illegal, null if the worker failed.
  function clPlay(fen, san) {
    return new Promise(function (resolve) {
      if (!clStart()) { resolve(null); return; }
      var id = 'qx-cl-' + (++clRun.seq);
      var timer = setTimeout(function () { delete clRun.waiting[id]; resolve(null); },
        CL_TIMEOUT_MS);
      clRun.waiting[id] = function (m) {
        clearTimeout(timer);
        if (!m) { resolve(null); return; }
        if (!m.ok) { resolve(false); return; }
        var uci = String(m.uci || '');
        resolve({ san: m.san, fen: m.newFen, from: uci.slice(0, 2), to: uci.slice(2, 4) });
      };
      // Glyphs off, zeros as the letter O; chess.js reads the rest, check signs included.
      var move = san.replace(/[!?]+$/, '').replace(/0/g, 'O');
      clRun.worker.postMessage({ event: 'emPlayMove', fen: fen, move: move, emId: id });
    });
  }

  // The line's moves as far as they are legal. A worker failure isn't cached, so the
  // next render asks again.
  function clResolve(startFen, sans) {
    var key = startFen + '|' + sans.join(' ');
    if (clCache.has(key)) return clCache.get(key);
    var p = (function next(fen, i, acc) {
      if (i >= sans.length) return Promise.resolve(acc);
      return clPlay(fen, sans[i]).then(function (r) {
        if (r === null) return null;
        if (r === false) return acc;
        return next(r.fen, i + 1, acc.concat([r]));
      });
    })(startFen, 0, []);
    clCache.set(key, p);
    if (clCache.size > CL_KEEP) clCache.delete(clCache.keys().next().value);
    p.then(function (moves) { if (!moves) clCache.delete(key); });
    return p;
  }

  function clSpans() {
    var box = document.getElementById('mt-moves-display');
    return box ? box.querySelectorAll('.qx-cl') : [];
  }

  function clMarkActive() {
    var spans = clSpans();
    for (var i = 0; i < spans.length; i++) {
      var q = spans[i].__qxCl;
      var on = !!(clView && q && q.row === clView.row && q.line === clView.line &&
        q.i === clView.index);
      if (on) spans[i].classList.add('qx-cl-on'); else spans[i].classList.remove('qx-cl-on');
    }
  }

  function clDraw() {
    var v = clView;
    var at = v.index >= 0 ? v.moves[v.index] : null;
    clOwnRender = true;
    try {
      window.renderFEN(at ? at.fen : v.startFen);
      if (typeof window.clearArrows === 'function') window.clearArrows();
      // Not the site's highlightLastMove: it also draws currentNode's glyph (the real
      // move's "!" or "?") on the square. The squares are ids like "e4".
      var lz = document.querySelectorAll('.letzterZug');
      for (var i = 0; i < lz.length; i++) lz[i].classList.remove('letzterZug');
      [at && at.from, at && at.to].forEach(function (sq) {
        var el = sq && document.getElementById(sq);
        if (el) el.classList.add('letzterZug');
      });
    } finally { clOwnRender = false; }
    clMarkActive();
  }

  // Forget the preview; the board already shows (or is about to show) something else.
  function clDrop() {
    if (!clView) return;
    clView = null;
    clMarkActive();
  }

  // Back to the position training is on, drawn the way the site draws it.
  function clLeave() {
    if (!clView) return;
    clDrop();
    var s = G.ts, t = G.tree;
    var nodes = s ? (s.readMode ? s.readNodes : s.playedNodes) : null;
    if (s && nodes && s.viewIndex >= 0 && s.viewIndex < nodes.length &&
        typeof window.trainJumpToIndex === 'function') {
      window.trainJumpToIndex(s.viewIndex);
      return;
    }
    var f = G.fen || (t && t.root && t.root.fen);
    if (!f || typeof window.renderFEN !== 'function') return;
    window.renderFEN(f);
    var lz = document.querySelectorAll('.letzterZug');
    for (var i = 0; i < lz.length; i++) lz[i].classList.remove('letzterZug');
    var shapes = s && s.viewIndex >= 0 && nodes ? nodes[s.viewIndex] : t && t.root;
    if (typeof window.loadNodeShapes === 'function') window.loadNodeShapes(shapes);
  }

  // Show a line's move `pick` (an index, or 'last' for its last legal one).
  function clOpen(q, pick) {
    clResolve(q.startFen, q.sans).then(function (moves) {
      if (!moves || !moves.length || typeof window.renderFEN !== 'function') return;
      var i = pick === 'last' ? moves.length - 1 : pick;
      if (i >= moves.length) return;
      clView = { key: q.key, startFen: q.startFen, moves: moves, index: i,
        row: q.row, line: q.line };
      clDraw();
    });
  }

  function clClick(span) {
    var q = span.__qxCl;
    if (!q || span.classList.contains('qx-cl-bad')) return;
    clOpen(q, q.i);
  }

  // The nearest line in comment `row` from line number `line` on, going `step` (+1/-1),
  // whose first move is legal: the __qxCl of its first move, or null.
  function clLineFrom(row, line, step) {
    var spans = clSpans(), best = null;
    for (var i = 0; i < spans.length; i++) {
      var q = spans[i].__qxCl;
      if (!q || q.row !== row || q.i !== 0 || spans[i].classList.contains('qx-cl-bad')) continue;
      if (step > 0 ? q.line < line : q.line > line) continue;
      if (!best || (step > 0 ? q.line < best.line : q.line > best.line)) best = q;
    }
    return best;
  }

  // On training's last move, the first line in that move's comment.
  function clAtEnd() {
    var s = G.ts;
    if (!s || G.studyMode !== 'train') return null;
    var nodes = s.readMode ? s.readNodes : s.playedNodes;
    if (!nodes || !nodes.length || s.viewIndex !== nodes.length - 1) return null;
    return clLineFrom(s.viewIndex, 0, 1);
  }

  // The lines in one comment, played end to end: right from training's last move goes
  // into its comment's first line, right from a line's last move to the next line's
  // first, and left retraces exactly that, leaving the preview left of the first line's
  // first move. So the two keys always undo each other.
  function clKey(e) {
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
      return false;
    }
    if (!clView) {
      if (e.key !== 'ArrowRight') return false;
      var first = clAtEnd();
      if (!first) return false;
      clOpen(first, 0);
      return true;
    }
    if (e.key === 'Escape') { clLeave(); return true; }
    if (e.key === 'ArrowRight') {
      if (clView.index < clView.moves.length - 1) { clView.index++; clDraw(); }
      else {
        var next = clLineFrom(clView.row, clView.line + 1, 1);
        if (next) clOpen(next, 0);
      }
      return true;
    }
    if (e.key === 'ArrowLeft') {
      if (clView.index > 0) { clView.index--; clDraw(); }
      else {
        var prev = clLineFrom(clView.row, clView.line - 1, -1);
        if (prev) clOpen(prev, 'last'); else clLeave();
      }
      return true;
    }
    return false;
  }

  // Split a comment's text nodes around the moves of each line in them.
  // `idx` is the commented node's index in training's list; lines are numbered in the
  // order they appear in the comment, for the arrow keys.
  function clDecorateRow(row, fen, parentFen, idx) {
    var kids = [].slice.call(row.childNodes || []);
    var lineNo = 0;
    kids.forEach(function (tn) {
      if (tn.nodeType !== 3) return;           // links stay as the site made them
      var text = tn.nodeValue || '';
      var spans = [];
      clParse(text).forEach(function (line) {
        var start = clStartFen(line, fen, parentFen);
        if (!start) return;
        var sans = line.moves.map(function (x) { return x.san; });
        var key = start + '|' + sans.join(' ');
        var n = lineNo++;
        line.moves.forEach(function (x, i) {
          spans.push({ at: x.at, len: x.len,
            q: { key: key, startFen: start, sans: sans, i: i, row: idx, line: n } });
        });
      });
      if (!spans.length) return;
      var pos = 0, made = [];
      spans.forEach(function (sp) {
        if (sp.at > pos) row.insertBefore(document.createTextNode(text.slice(pos, sp.at)), tn);
        var el = document.createElement('span');
        el.className = 'qx-cl';
        el.textContent = text.substr(sp.at, sp.len);
        el.__qxCl = sp.q;
        row.insertBefore(el, tn);
        made.push(el);
        pos = sp.at + sp.len;
      });
      if (pos < text.length) row.insertBefore(document.createTextNode(text.slice(pos)), tn);
      row.removeChild(tn);
      // Moves past the first illegal one can't be shown.
      made.forEach(function (el) {
        var q = el.__qxCl;
        if (q.i !== 0) return;
        clResolve(q.startFen, q.sans).then(function (moves) {
          if (!moves) return;
          made.forEach(function (o) {
            if (o.__qxCl.key !== q.key || o.__qxCl.i < moves.length) return;
            o.classList.add('qx-cl-bad');
            o.title = 'Not legal here';
          });
        });
      });
    });
  }

  // After renderMTNotation: a comment row follows the row of the move it belongs to,
  // and that row's slots carry data-idx into readNodes / playedNodes.
  function clDecorate() {
    var box = document.getElementById('mt-moves-display');
    var s = G.ts, t = G.tree;
    if (!box || !s || !t || !t.root) return;
    var nodes = s.readMode ? s.readNodes : s.playedNodes;
    if (!nodes || !nodes.length) return;
    var idx = -1, kids = box.children || [];
    for (var k = 0; k < kids.length; k++) {
      var el = kids[k];
      if (el.classList.contains('main-comment-row')) {
        var node = idx >= 0 ? nodes[idx] : null;
        if (!node || !node.fen) continue;
        var parent = idx > 0 ? nodes[idx - 1] : t.root;
        clDecorateRow(el, node.fen, parent && parent.fen, idx);
        continue;
      }
      var slots = el.querySelectorAll ? el.querySelectorAll('[data-idx]') : [];
      for (var i = 0; i < slots.length; i++) {
        var n = parseInt(slots[i].getAttribute('data-idx'), 10);
        if (n > idx) idx = n;
      }
    }
    clMarkActive();
  }

  // renderMTNotation redraws the training notation (and our spans with it) on every
  // step; renderFEN from anyone but us means the board shows the site's position again.
  function hookTraining() {
    var rm = window.renderMTNotation;
    if (typeof rm === 'function' && !rm.__qxWrapped) {
      var wrappedRm = function () {
        clDrop();
        var r = rm.apply(this, arguments);
        try { clDecorate(); } catch (e) { console.warn('[qchess-transpositions]', e); }
        return r;
      };
      wrappedRm.__qxWrapped = true;
      window.renderMTNotation = wrappedRm;
      try { clDecorate(); } catch (e) { console.warn('[qchess-transpositions]', e); }
    }
    var rf = window.renderFEN;
    if (typeof rf === 'function' && !rf.__qxWrapped) {
      var wrappedRf = function () {
        if (!clOwnRender) clDrop();
        return rf.apply(this, arguments);
      };
      wrappedRf.__qxWrapped = true;
      window.renderFEN = wrappedRf;
    }
  }

  // A press on the board while it shows a preview goes back to the real position
  // instead: the pieces under the pointer aren't the ones the site would move, and in
  // interactive mode a move made from them would count as a wrong answer. Right-click
  // (arrows) is left alone.
  function clBoardPress(e) {
    if (!clView || (e.type === 'mousedown' && e.button !== 0)) return;
    var t = e.target;
    if (!t || !t.closest || !t.closest('.allsquares')) return;
    e.preventDefault();
    e.stopPropagation();
    clLeave();
  }
  document.addEventListener('mousedown', clBoardPress, true);
  document.addEventListener('touchstart', clBoardPress, { capture: true, passive: false });

  /* ----------------------------------------------------------------- hooks */

  // Qchess rebuilds #moves from scratch on every navigation, so re-apply afterwards.
  var hooked = false;
  function hookRender() {
    if (hooked || typeof window.rebuildNotationDisplay !== 'function') return false;
    var orig = window.rebuildNotationDisplay;
    window.rebuildNotationDisplay = function () {
      var r = orig.apply(this, arguments);
      try { refreshSoon(); } catch (e) {
        console.warn('[qchess-transpositions]', e);
      }
      return r;
    };
    hooked = true;
    return true;
  }

  /* -------------------------------------------------- settings / stats IPC */

  function emitStats() {
    document.dispatchEvent(new CustomEvent('qx:stats', { detail: lastStats }));
  }

  document.addEventListener('qx:settings', function (e) {
    var next = e.detail || {};
    Object.keys(next).forEach(function (k) {
      if (k in settings) settings[k] = next[k];
    });
    refreshSoon();
    try { peRefresh(); } catch (err) { console.warn('[qchess-transpositions]', err); }
  });

  document.addEventListener('qx:ping', function () { emitStats(); });

  /* ------------------------------------------------------------- lifecycle
   * Qchess is a single-page app: chapters and whole studies swap in without a
   * page load, and the study view may not exist when this script first runs.
   * Poll until the tree shows up, then keep watching for it being torn down
   * and rebuilt.
   * --------------------------------------------------------------------- */

  var lastStamp = null;
  setInterval(function () {
    // The explorer panel doesn't depend on the notation being ready.
    hookStats();
    hookCdbEvals();
    hookCdbFetch();
    cdbTitle();
    injectCopyItem();
    hookTraining();
    if (!ready()) {
      hooked = false;
      return;
    }
    if (hookRender()) refreshSoon();

    var stamp = stateStamp();
    if (stamp !== lastStamp) {
      lastStamp = stamp;
      refreshSoon();
    }
  }, 700);

  injectCss();

  // Tell the bridge we're up, so it can push current settings.
  document.dispatchEvent(new CustomEvent('qx:ready'));
})();
