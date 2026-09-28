# CLAUDE.md

Chrome MV3 extension that marks moves in a [qchess.net](https://qchess.net) study which
transpose into another branch of the chapter you have open, and lets you jump between them.
Matching is deliberately scoped to that one chapter. It also gives every variation in the
notation a left bar saying whether it opens with your move or the opponent's.

`README.md` documents the extension for users. This file covers what you need to know to
work on it.

## The short version

- No build step, no dependencies, no framework. The files in `src/` are what ships.
- The extension reads **undocumented internals of a third-party site**. That coupling is the
  whole design, and it's the thing most likely to break.
- `node test/harness.js` is the real test suite and the primary way to verify changes.

## Working on it

```bash
node test/harness.js          # 411 checks: main-world.js on a stubbed DOM, plus test/pe.js
                              # (search, rounds, metric, rate limiter, budget; no network)
                              # and test/repgen.js (the repertoire generator)
                              # and test/pgnclean.js (PGN tree, cleaning, transpositions)
                              # and test/cdbexplore.js (target picking, ChessDB search)
node --check src/main-world.js
python icons/make_icons.py    # regenerate PNGs (stdlib only, no Pillow)
```

To load: `chrome://extensions` → Developer mode → Load unpacked → this folder. After editing,
hit reload on the extension card **and** reload the qchess tab.

Bump `manifest.json` `version` when shipping a change worth reloading for.

## The page contract

`src/main-world.js` depends on these page symbols. If a qchess deploy renames or removes any
of them, the extension silently stops working — this list is the first thing to re-check.

| Symbol | Kind | Used for |
| --- | --- | --- |
| `tree` | script-scope `let` | `{root: {move, fen, children[], variationId, moveIndex}}`. Every node carries a full FEN. |
| `studyData.chapters[]` | script-scope `let` | chapter count for the popup read-out; `.perspective` is the side the chapter's repertoire is for |
| `activeChapterIndex`, `studyUuid` | script-scope | noticing a chapter or study swap |
| `REP_STATE`, `userColor`, `boardFlipped` | script-scope | fallbacks for "which side am I?", consulted in that order after `.perspective` |
| `window._repStripFen(fen)` | function | first 4 FEN fields — the site's position key |
| `window.nodeDataKey(node)` | function | `"<variationId>-<moveIndex>"`, matches `data-node` in `#moves` |
| `window.rebuildNotationDisplay()` | function | wrapped, to re-apply markers |
| `#move-context-menu` / `.context-menu-item` / `#context-copy` | static markup | the notation's right-click menu; "Copy continuation" (`#qx-copy-cont`) goes in right after `#context-copy`. A click inside the menu doesn't close it (the site's document listener checks `menu.contains`) |
| `contextMenuTargetMove` | script-scope `let` | `{element, node}` of the move the right-click menu was opened for; set by `showMoveContextMenu`, nulled by `closeMoveContextMenu` |
| `window.closeMoveContextMenu()` | function | closes that menu (the extension falls back to removing `.active`) |
| `.next-moves-menu` / `.next-move-option` | CSS classes | the menu's native styling |
| `.variation-line` / `.branch-variation` / `.variation-move-group` | CSS classes | a branch, a branch nested in one, and the move spans inside either; the first group in a container is the move that opens that branch |

### Training mode (clickable lines, v1.13.0)

Training (the sidebar's Study/Train switch, `studyMode === 'train'`) has its own notation and
never touches `#moves`. Clickable lines depend on:

| Symbol | Kind | Used for |
| --- | --- | --- |
| `ts` | script-scope `let` | training state: `readMode`, `readNodes` (Read tab: the whole line), `playedNodes` (Interactive: moves so far), `viewIndex` (-1 = start). Nodes are real tree nodes, consecutive from `tree.root` |
| `#mt-moves-display` | rebuilt DOM | `renderMTNotation()` output: `.added-move` rows whose slots carry `data-idx` into `readNodes`/`playedNodes`, each commented node followed by `makeMainCommentRow(comment, null)`, a `.main-comment-row` of text nodes (plus `<a>` for URLs) with **no** `data-comment-for` |
| `window.renderMTNotation()` | function | wrapped: re-decorates comments after each rebuild, ends the preview |
| `window.renderFEN(fen)` | function | board only (pieces, `currentPlayer`), no state. Wrapped: a call not from us ends the preview |
| `window.trainJumpToIndex(i)` | function | how the extension goes back to training's position |
| `.allsquares` (id = square, `e4`) / `.letzterZug` | board DOM | last-move highlight, set directly: `highlightLastMove` also draws `currentNode`'s glyph |
| AnalysisWorker `emPlayMove {fen, move, emId}` | worker message | → `emMovePlayed {emId, ok, san, uci, newFen}`; in **our own** instance. The page's `verifyMove` is unusable here: its `moveUsVerified` reply resolves the user's pending training move, and outside training adds the move to the tree |

In train mode the page's `moveUsVerified` handler returns early (`if (studyMode === 'train') return;`) unless
training is waiting for the user's move, so a move played on the board never reaches the tree there.

### Explorer panel (Practical eval, in progress)

Found by reading the page source on 2026-09-25, then confirmed on the live test study the
same day. The design doc for the feature lives outside the repo.

Live findings the source didn't make obvious:

- `localStorage.lichessSettings` is `null` until the user touches the panel's filter. Read
  the `lichessSettings` binding instead, since it always holds the defaults.
- Closing the panel (`#toggle-tree`) sets `databaseTurnedOn = false` and hides the table, but
  the stale `.tree-move` rows stay in the DOM. Check the flag, not whether rows exist.
- A "novelty" row isn't necessarily a move with no games. The page asks the explorer for its
  default 12 moves, so every move ChessDB knows beyond those shows up as a novelty too.
- Wrapping `window.displayStatistics` catches the page's renders: 2 calls per navigation.
- The table is only as wide as the side panel: 237 px in a 958 px-wide window (the W/D/B
  bars shrink to 2 px) and 625 px in a 2560 px one.

| Symbol | Kind | Used for |
| --- | --- | --- |
| `fen`, `currentNode` | script-scope `let` | shown position's full FEN; `currentNode` is null at the root, and the table renders for `currentNode \|\| tree.root` |
| `window.displayStatistics(stats, evals)` | function | the one render path for `#database-trees`: clears it with `innerHTML = ''`, runs 2+ times per navigation (games, then again when ChessDB answers), and is deferred while dragging. To be wrapped, like `rebuildNotationDisplay` |
| `lastStatsData` | script-scope `let` | rows just drawn: `[{next_move (SAN), total, white_wins, draws, black_wins}]`. Elite rows also carry `engine_eval` and `avg_*_elo` as strings; Lichess rows carry numbers and `avg_rating` |
| `lastEvalsData` | script-scope `let` | `{SAN: pawns, White's point of view}`, where ChessDB `queryall` overrides `/postgres-query/<db>` evals. This is the Eval column |
| `lichessSettings` | script-scope `let` | `{speeds, ratings, player, playerColor, modes, recentOnly}`; defaults `speeds: blitz, rapid, classical`, `ratings: 1600…2500`. Saved to `localStorage.lichessSettings` only after the user changes it |
| `selectedDB` | script-scope `let` | `'Elite' \| 'CORRdb' \| 'y2024' \| 'TTdb' \| 'Lichess'`; the buttons are `#qdb #corrdb #y2024 #ttdb #lichessdb`, and the selected one has `.chosendbschema` |
| `databaseTurnedOn`, `sortMode` | script-scope `let` | panel open or closed; row order (reorders only, so key rows by SAN). `sortMode` is `'eval' \| 'popularity' \| 'score' \| 'maia' \| 'white-eval' \| 'black-eval' \| 'mine-eval' \| 'only-rep'`, saved in `localStorage.sortMode` |
| `/Frontend/maia/maia-integration.js` header clicks | external script | **not in the study page's HTML**, so grepping the page misses it. At load it binds bubble-phase clicks: `#db-column-header .move-eval` → `setSortMode('eval')`, `.move-percentage` → `'popularity'`, `#dbh-score-label` → `'score'`, plus `#maia-prob-header` → `'maia'`. `setSortMode` does nothing when that mode is already on, and otherwise re-renders through `displayStatistics`. It also sets their titles ("Click to sort by …") and gives the Score label `pointer-events: auto`. The extension's header clicks (Eval refresh, Score toggle) are taken only once `sortMode` is exactly that column's mode (`sortedBy()`, v1.11.1); before that the click goes through and sorts |
| `#db-column-header` | static markup | header cells `.move-name .move-eval .move-global-percentage .move-percentage .move-count #dbh-score-label .move-percentages`; not rebuilt |
| `#database-trees .tree-move` | rebuilt DOM | a row: `.move-name` (SAN), `.move-eval`, `.move-global-percentage`, `.move-percentage`, `.move-count`, `.move-percentages`. Totals row has `.total-row`; no-games rows come from `createNoveltyElement` and have `.novelty-text`; in repertoire mode a row is wrapped in `.rep-move-group` |
| `.move-percentages` bars | rebuilt DOM | a normal row's (and the totals row's) Score cell holds exactly three `div.percentage-bar`: `.white-bar .draw-bar .black-bar`, width set inline (`style.width = "<x>%"`), text `"<round(x)>%"` only when x ≥ 15 (`x.toFixed(1)` if that rounds to 0). Novelty rows hold a `span.novelty-text` instead, placeholder rows a bare `'?'`. The prepared mode rewrites only widths, text, `title` and classes, and only where there are exactly those three children |
| `#dbh-score-label` | static markup | the "Score" header text. Page CSS gives it `width: 0; overflow: visible; pointer-events: none`, so its text overflows into `.move-percentages`, a later flex sibling painted on top. To be clickable (the prepared toggle) it needs `pointer-events: auto`, and `position: relative; z-index: 1`, scoped to our `#db-column-header.qx-prep-toggle`. The site adds `.sort-active-header` to it when sorting by score, and never rewrites its text |
| `#tree-move-styles` | page-injected `<style>` | fixed `!important` column widths, and rows `height:20px; overflow:hidden` |
| `localStorage.lichessToken` | page storage | the site's own Lichess token (see the design's open question 1; not used by default) |
| `/Frontend/maia/maia-worker.js` | module worker | Maia 3 (ONNX, ~46 MB, in IndexedDB `QchessMaiaModels`). Messages in: `init` → `status` `ready` or `no-cache`; `policy {id, fen, elo}` → `policy-result {id, moves: [{san, prob}]}`. The extension starts **its own instance** from the MAIN world (the page's is closure-private) and only ever sends `init` and `policy`: `clear` would delete the user's model |
| `window.maiaIsEnabled()` | function | the page's Maia switch; after a `no-cache`, the extension tries its worker again only once this is true |
| `window.parseQueryAll(text)` | function | ChessDB's plain-text `queryall` answer → `{kind: 'list' \| 'unknown' \| …, items}`. Used by the Eval header's refresh (v1.11.0), so its answer takes the page's own path into `normalizeChessDBResults` |
| `lichessCache` | script-scope `const` | the Lichess path's cache for the session (80 entries): stats, games and evals **with ChessDB's first answer merged in**. A cache hit redraws from it without asking ChessDB again, which is why the refresh exists. Not read or written by the extension; the `displayStatistics` wrapper's overlay (`cdbSeen`) covers its redraws. The Elite/other-DB path has no such cache and asks ChessDB on every visit |
| `window.normalizeChessDBResults(fen, parsed)` | function | turns ChessDB's `queryall` into the Eval column's `{SAN: pawns}` via the page's shared `/Frontend/AnalysisWorker.js` (`uciListToSan` → `uciListToSanDone {fen, sanMoves}`). The page takes the first reply from that worker whatever it answers, so overlapping positions swap move names and ChessDB's evals are lost (the column keeps the Elite DB's older ones). Replaced by the extension with the same conversion in **its own instance** of that worker, replies matched by FEN (v1.10.1) |
| `window.fetchCDB(params, signal)` | function | the page's one ChessDB fetch (`https://www.chessdb.cn/cdb.php?<params>`, resolves `{url, txt}`, rethrows `AbortError`). Both paths call it with `{action: 'queryall', board}`: Lichess before its own fetch, Elite just after the first render. Each new request aborts the last one (`cdbController`). Wrapped (v1.11.2) to count the page's requests out per position |
| `lastFetchedFEN` | script-scope `let` | the position the page's latest explorer request is for, set when it starts (after the Lichess path's 280 ms debounce) |

Each `.tree-move` row has a bubbling click listener that navigates (`verifyMove`). Anything
clickable injected into a row needs the same capture-phase interception as the badges
(point 3 below). Rows also carry a native `title` (average Elo). Qchess uses right-click
only on notation moves (`.move-in-nota`) and game entries, so right-click on a Practical
cell (exclude the move) takes nothing from the site. Evals reach `displayStatistics` as its
second argument: numbers in pawns from White's point of view, a mate as about ±300.

Transposition detection is just `_repStripFen(a.fen) === _repStripFen(b.fen)`. There is **no
chess logic in this extension** — no move generation, no board representation, no engine.
Keep it that way; the FENs are already there.

Whose move opened a branch comes from the same place: `moveBit()` reads the side off the
node's FEN. Do not use the parity of `moveIndex` — a chapter can start from a position with
Black to move.

## Five things that will look like mistakes and aren't

**1. `src/main-world.js` must run in the MAIN world.** `tree` and `studyData` are script-scope
`let` bindings, not properties of `window`. An isolated-world content script sees none of
them. Don't "fix" the manifest by dropping `"world": "MAIN"`.

**2. Page state is read through try/catch getters (the `G` object), not `window.x`.**
`window.studyData` is `undefined` while a bare `studyData` resolves, and referencing an
undeclared name throws `ReferenceError`. This already caused one silent bug where
matching never ran against page state at all. Follow the existing pattern for any new page global.

**3. Badge clicks are intercepted by one delegated listener on `document` in the CAPTURE
phase.** This is not over-engineering. Move elements (or their `.variation-move-group`
parents) carry the site's own click handler, which navigates and then calls
`rebuildNotationDisplay()`. A listener bound to the injected element fires too late —
handlers higher up have already run, so the click navigates *and* the rebuild wipes the menu.
Capture-phase interception is the only reliable fix.

**4. The site scales its own `.next-moves-menu` by `transform: scale(1.1)`.** Because the
origin is the centre, an unscaled-width menu grows past both edges of `#moves` - which is why
`.qx-menu` carries `transform: none !important` and a `max-width`. Related: `injectCss()` must
actually be called (startup *and* `annotate()`); without the stylesheet nothing above applies
and the menu renders at 1.1x, outside the pane. The harness now asserts both.

**5. Anything injected into `#moves` is transient.** The site rebuilds that subtree from
scratch on every navigation. `annotate()` must stay idempotent and is re-run after each
rebuild; that's also why it reopens an open menu rather than letting it vanish.

## Investigating the site

The entire ~24k-line app is inlined in the study page HTML and **served without auth**:

```bash
curl -s https://qchess.net/study/3411d48d-b0f1-43fb-a667-b49057243e1c -o /tmp/study.html
curl -s https://qchess.net/Frontend/ShowGame.css -o /tmp/ShowGame.css
```

Grep those rather than poking at the live page — it's faster and you get full context. Useful
starting points: `_repBuildMap()` (the site's own cross-chapter FEN index), `genMoveLabel()` /
`buildPrefixLine()` (move formatting), `handleMoveClick()` (navigation), `makeVariationRow()`
/ `renderInlineBranch()` (branch markup).

## Verifying in a browser

Live verification is unreliable and will eat your time: the study page (Stockfish WASM plus
several workers) repeatedly **freezes the renderer against CDP/browser automation** after the
first load. Budget for it, and don't keep retrying.

Prefer, in this order:

1. `node test/harness.js` — covers detection, the menu, both navigation paths, toggles.
2. A static HTML mock linking the real `ShowGame.css`, served over `python -m http.server`,
   to check that injected UI looks native.
3. Hand the build to the user to load, and say plainly what was and wasn't verified.

If you do drive the live site: a direct `/study/<uuid>` URL bounces to the homepage — navigate
via `/studies` and click through.

The browser's qchess login is a throwaway test account: editing anything there (moves,
comments, chapters, saving) is fine when it helps a test.

Test study (safe to modify) — contains a deliberate three-way transposition
that should resolve to **3 transposing positions / 8 marked moves**, the numbers the harness
asserts:

```
https://qchess.net/study/3411d48d-b0f1-43fb-a667-b49057243e1c
```

## Conventions

- Plain ES5-flavoured JS (`var`, `function`, no modules) — this runs directly in a page with
  no transpilation, and the site itself is written the same way. That applies to
  `main-world.js` and `bridge.js`. The exception is the background worker: it is
  `type: module`, and `src/pe/*.js` are ES modules, still in `var`/`function` style. Node loads
  them from the CommonJS harness with `import()`. `src/pe/search.js`, `rounds.js` and
  `providers.js` stay free of `chrome.*` so they can be tested there.
- Practical values are only compared at one depth, because deeper values drift upwards
  (a human mean is never below the engine's best reply, and each ply adds a max over your
  moves). That's why the rows deepen in lockstep rounds (`rounds.js`), why green skips a
  row at another depth, and why `myNode` compares your candidates at one depth before
  searching the winner deeper. Keep it that way.
- `src/vendor/chess.js` is chess.js 1.4.0 (npm, `dist/esm`), unmodified apart from its
  header. The background worker uses it only to play moves into child FENs. The "no chess
  logic" rule above is about the transposition feature, which still has none.
- Comments explain *why*, especially where the code works around site behaviour. The
  non-obvious constraints above are commented inline; keep them there if you refactor.
- When you change `src/main-world.js`, update `test/harness.js` in the same pass. The stub DOM
  is minimal — if new code needs a DOM API the stub lacks, add it to the stub rather than
  weakening the test.
- `test/`, `tools/`, `repertoires/` and `icons/make_icons.py` are excluded when packaging
  for distribution; everything else ships.
- `repertoires/` holds the repertoire tools' runs, their shared `repgen-cache.jsonl` and
  cleaned PGNs. Bare names go there (`tools/repgen/paths.mjs`): repgen's and pgnclean's
  `--out`, and input files that aren't in the current directory. A name with a directory is
  used as given.
- `tools/repgen.mjs` is a Node CLI that imports `src/pe/*.js` and `src/vendor/chess.js`
  directly, so those files must stay free of `chrome.*` and browser-only globals. Its own
  modules (`tools/repgen/*.mjs`) follow the same `var`/`function` style.
- `tools/lichess-rate.mjs` measures the explorer's rate limit with the user's token
  (`LICHESS_TOKEN`), stepping through rates until the first 429. Its result is the
  comment above `LICHESS_RATE` in `src/pe/providers.js`. Only the user runs it, since it
  needs their token. The plan in
  `generator.mjs` and the check in `check.mjs` are pure (deps injected) and tested by
  `test/repgen.js`; `root.mjs` is
  `background.js`'s `startRoot` without the port, so a change to one likely belongs in the
  other.
- `tools/pgnclean.mjs` reads PGN back (`repgen/pgntree.mjs`, variations and all) and finds
  transpositions by replaying moves with chess.js, never by parsing repgen's comments.
  `repgen/clean.mjs` recognises repgen's comment wording (`N% of N games`, `Prac `,
  `engine move`, `end: `, …): change `pgn.mjs`'s wording and that list together.
- `tools/cdbexplore.mjs` deepens ChessDB's tree below a PGN's line ends and close decisions
  of mine (`repgen/explore.mjs`, pure: ChessDB, sleep and clock come through deps). The
  search follows vondele/cdbexplore (GPL-3), rewritten, not copied: keep it that way. It
  leaves out cdbexplore's extension along ChessDB's stored PV, its forced re-query of deep
  nodes, and unscored moves (which cdbexplore only searches past depth ~25), and it stops a
  position early once `stable` depths agree. Scores are ChessDB's own scale throughout
  (cursed wins are 0; mates and TB wins gain a ply on the way in and lose one per ply up),
  so the search's mate-in-1 is ChessDB's 29999. The deadline (`--minutes`, `--hours`) is enforced inside a depth: past it, nothing
  new is asked or waited for and the unfinished depth is dropped. The first live run showed
  why: one depth waited 16 minutes on newly queued positions.

## Status

**Practical eval, phase 1 (v1.5.0)**, verified live on 2026-09-25 on the test study:
- Depth-1 values appear: on a new position, the first after 1.4 s and all four after 3.0 s.
- After a page reload they come back from the IndexedDB cache in about 30 ms.
- Clicking an empty cell computes that row without playing the move.
- The transposition badges are unaffected.

**Phase 2 (v1.6.0)**, verified live the same day:
- Rows deepen d1 → d3 → d5. The small depth marker shows while a row searches, and the %
  comes back when it stops.
- At the start position all four rows finished in about 3.3 minutes (65 positions): e4
  reached 5 plies, the rest stopped at 3 when the 60-request budget ran out.
- Leaving a position mid-search frees the queue: the next position deepened at once. Coming
  back resumes the interrupted rows, which keep showing their last value.
- With Lichess selected in the panel, about 2.5 minutes of browsing during a search never
  showed the panel's error.

**Lockstep rounds (v1.6.1)**, verified live the same day:
- After 1.Nf3 d5 2.c4 d4, all six rows sat at d1 until depth 3 appeared for all of them in
  one instant, 94 s later. Depth 5 was never started, because the estimate showed it
  couldn't fit in the remaining budget.
- At the start position (depth 3 cached), depth 3 was back in about a second. Depth 5 then
  finished for all four rows together about 3.3 minutes later, within the budget.
- The own-move comparison at equal depth made two switches of +1.2 (after 1...c5, d4 over
  Nf3; after 1...e6, e4 over g3).

**Row picking and right-click exclusion (v1.7.0/1.7.1)**, verified live the same day:
- At the start position e3 (1% of games, 0.00) was picked by eval and got a value.
- A real right-click turned its cell into `×` without moving the board, and the exclusion
  survived a page reload.
- Right-clicking again brought it back at d3 from the cache. It caught up to the table's
  depth 5 (52%) and sat out the green comparison until it got there.
- 1.7.1 breaks equal evals by games played. A quiet position has a dozen moves at 0.00,
  and 1.7.0 picked among them arbitrarily. The fix is covered by the harness, not live.

**ChessDB analysis requests (v1.8.0), replacing the Stockfish phase.** Stockfish leaves
were dropped: a search already takes minutes. Instead, a position the search needs and
ChessDB doesn't know is sent to `action=queue`, and a reply people play (share ≥
`replyThreshold`) that a known position lacks is sent to `action=store` with ChessDB's
castling spelling (e1g1, via chess.js in the worker). Measured on 2026-09-25: a queued
position had evals 65 s later, and an unknown position that was only queried stayed
unknown, so `queryall` does not queue by itself. After asking, `chessdb()` looks the position up
again after 2 minutes (an unknown one every 2 minutes for an hour), so later rounds of
the same search see the evals. A finished row with `analysing > 0` is re-searched on a
revisit 2.5+ minutes later, twice per page load. Both endpoints were checked with curl the
same day: `queue` answers `{"status":"ok"}` with `json=1`, and a `store` of e7e6 in an
unknown position gave that position evals (e6 and ChessDB's own best, g4) 56 s later. The
extension's use of them is covered by the harness only: the live check was blocked by the
renderer freeze described below.

**Maia fallback (v1.9.0).** An opponent node under `maiaUntil` (100) games blends Maia's
policy in as `K` pseudo-games, `K = maiaWeight × (1 − games/maiaUntil)`: 20 just above
10 games, 0 at 100. Under `maiaOnlyBelow` (10) Maia alone decides. The games of the
opponent move that led to a node (`hint`) bound its own games, so under 10 the explorer
isn't asked at all. The uniform α smoothing stays on the games part only. Results carry
`maia` (reach-weighted share of the value from Maia); ≥ 0.5 paints the cell purple.
Without Maia (off, no model, timeout) nodes under `minGames` are leaves, as before. The
search asks the tab for Maia over the port (`maia`/`maiaResult`, 30 s timeout); the tab
runs its own worker instance and stops it after 90 s idle. Harness only; not yet seen
live. Speed and memory of the second instance are unmeasured.

**Prepared score (v1.10.0)**, verified live on 2026-09-26 on the test study (Lichess panel,
blitz/rapid/classical 1600–2500, k = 50):
- The Score header toggles both ways, and the click is intercepted. The label wins the hit
  test at width 0. In a CSS mock, `pointer-events: auto` alone still sent the click to
  `.move-percentages`, which is why the label also gets `position: relative; z-index: 1`.
- Toggling off restored the page's exact widths (e4 at the start: 49.0675 / 4.6761 /
  46.2563, as `lastStatsData` gives). The bar elements stayed the same, with no `data-qx`
  attributes or title left behind. Rows without a split were faded. Novelty and totals rows
  were untouched.
- Prepared bars arrived with each round. At 1.Nf3 d5 2.b4 c5 all three rows went from depth
  1 to depth 3 within 50 ms of each other (then stopped on the budget). Every update carried
  `prep`.
- The transposition badges were unchanged: 8 marked moves across 3 positions.
- Raw → prepared expected score:
  - Start position, depth 5: e4 51 → 51, d4 53 → 54, c4 53 → 52, Nf3 54 → 54. The prior
    share is 0–2%, and the Practical choices there are mostly the popular moves, so the two
    barely differ.
  - 1.Nf3 d5 2.c4 d4, depth 5: b3 46 → 53, and e4 53 → 50. For e4, the Practical choice
    after ...c5 and ...Nc6 is e5, and the games after e5 went worse than that position's
    average (c5 52 → 44, Nc6 49 → 46). That is selection by Practical, measurement by
    results, as designed.
  - Same position, depth 1: e3, b4, d3, g3 have prepared ≈ raw. At depth 1 there is no move
    of yours inside the search, so only the shrinkage differs.
  - 1.Nf3 d5 2.b4 c5, depth 3: bxc5 59 → 61, b5 53 → 53, Bb2 50 → 55.
- "Games at the leaves" can exceed a row's own games (349 M for e4 at the start). Positions
  count games that reach them by other move orders, and transposed subtrees count once per
  path, as the spec says.
- Seen once and not explained: at 1.Nf3 d5 2.c4 d4, e3, b4, d3 and g3 stayed at depth 1,
  shown as final with no stop reason, while e4 and b3 deepened to 5. A fresh position
  deepened all its rows in lockstep. This is Practical-column behaviour: `rounds.js` and the
  row picking are unchanged in this version.
- Harness only: the popup's Prepared group and its k field, the bridge saving `prepBar`
  (the page's state matched it after the extension reload), the muted state's look on the
  live page, and the narrow (237 px) table.

The worker's own request rate can't be seen from the page. The limiter's rate and its
one-in-flight rule are covered by the harness, and the live timings fit them.

These work through Qchess's own Lichess token (no token saved in the popup). The popup
itself (settings, token Test button, request counter) and "no requests when switched off"
are covered by the harness only. The Lichess rate limit (per token or per IP) has not
been measured yet.

Transpositions: verified via the harness and a CSS mock. **Not yet verified end-to-end in Chrome**: the
manifest wiring, the MAIN/isolated bridge handshake, and the popup's real
`chrome.tabs.sendMessage` path have only been reasoned through. If the popup reports
"Not connected", suspect `src/bridge.js` first.

Cross-chapter matching was built and then removed on purpose (v1.3.0): a marker is only
useful if it points somewhere you can go without leaving the board you are looking at. If it
ever comes back, `_repParsePgnBatchParallel([{fen, pgn}])` parses the other chapters' PGNs
across up to 4 workers — they already arrive with the study, so it costs no network — and
`loadChapter(i, {goToNode})` takes a `{variationId, moveIndex, fen}` descriptor to land on the
move. Neither is referenced by the extension any more.

**ChessDB eval fix (v1.10.1).** Reported 2026-09-26: in the line 3...Bg4 4.Bxc4 e6 5.Qb3
(FEN `rn1qkbnr/ppp2ppp/4p3/8/2B1P1b1/1Q3N2/PP1P1PPP/RNB1K2R b KQkq - 1 5`) the Eval column showed Bxf3 -0.29 while ChessDB
said -0.13/-0.15. All ten visible evals equalled `/postgres-query/Elite`'s exactly, so the
ChessDB override had been dropped by the page's conversion race described in the table.
ChessDB's own responses are `Cache-Control: no-cache`, and the site has no service worker,
so HTTP caching is not involved. Harness only; not yet seen live.

**ChessDB-first Eval column (v1.10.2).** The page renders the table with the Elite DB's
evals first and again when ChessDB answers, so the stale number flashed on every visit.
The `displayStatistics` wrapper now lays ChessDB's evals, as last converted for that
position in this page load, over the page's `evals` argument before the page renders, and
while ChessDB is outstanding for the shown position it hides `.move-eval` in
`#database-trees` (`qx-cdb-wait`, `visibility: hidden`). A ChessDB `unknown` shows the page's
evals at once; a fetch that never answers shows them after 5 s. Harness only.

**ChessDB refresh (v1.11.0; sort-first in v1.11.1).** Once the table is sorted by eval, clicking the Eval header (`#db-column-header .move-eval`,
static; it gets a `↻` via CSS while armed, `.qx-cdb-armed`, and a status `title`) fetches
`queryall` for the shown position with `cache: 'no-store'`, parses it with the page's
`parseQueryAll`, and converts it through the wrapped `normalizeChessDBResults`, which
records it in `cdbSeen`. If the table still shows that position it is redrawn from
`lastStatsData`/`lastEvalsData`, with the overlay supplying the new evals. One request at a
time, 10 s timeout; a failure changes nothing but the tooltip. The Practical column's
worker cache is left alone. In 1.11.0 the capture-phase listener swallowed the click unconditionally, which also blocked maia-integration.js's sort-by-eval (and the Score toggle blocked sort-by-score); reported by the user the same day. Now the first click on either header sorts, and only a click on the column already sorted by does the extension's thing. `white-eval` / `black-eval` / `mine-eval` count as "something else": the site's handler would switch them to `eval`. Harness only; not yet seen live.

**Repertoire generator (`tools/repgen.mjs`)**, built 2026-09-26. Covered by the harness and
by an offline end-to-end run of the CLI against a fake `fetch` (resume, cache reuse, PGN
parsed back by chess.js). **Not yet run against the real Lichess and ChessDB**: it needs the
user's personal Lichess token (the explorer returns 401 without one), and neither the real
cost per position nor Lichess's limit per token has been measured. ChessDB is paced at 60
requests a minute in the CLI only; the providers themselves are unchanged.

**Repertoire check (`--check`)**, built 2026-09-26. Asks ChessDB again about every position
of mine reachable in a run (`repgen/check.mjs`, pure like the generator), brings engine
values and marks up to date, and sets `recheck` where fresh evals could change the pick.
A `recheck` node stays `done` until its re-search settles, so an interrupted check never
loses a line from the PGN; a changed move prunes what only the old one reached
(`prune()`), and a kept move doesn't re-`ensure()` its child (that would double its
reach). Staleness is `state.freshSince`, applied by `withFreshChessdb` in
`filecache.mjs`: ChessDB answers older than the last check miss, explorer answers never
expire. Rows now save the search's `analysing` count; runs from before that have none, so
only `--check-all` re-searches their practical picks for missing evals. Covered by the
harness and an offline CLI run against a fake `fetch` (dry run changes nothing, 0 Lichess
requests, before-check PGN written). Not yet run against the real ChessDB.

**Missing ChessDB evals on revisits (v1.11.2).** Reported 2026-09-26: Eval cells stayed
blank (mostly on opponent moves, sometimes on the user's) until the Eval header's refresh.
Cause: the Lichess path's `lichessCache` stores a table as soon as Lichess answers, with the
Elite DB's evals, and merges ChessDB in only if ChessDB answers while the position is still
shown. Leave before that (the next request aborts it) and every later visit is a cache hit
that never asks ChessDB, showing the Elite DB's evals, which lack many Lichess-only moves.
Now the `displayStatistics` wrapper, and the wrapped `fetchCDB` when a request of the page's
settles, run `cdbNeed()`: if the shown position has no ChessDB answer in `cdbSeen`, the page
has no queryall out for it, none answered in the last 4 s (grace for its conversion), and
`lastFetchedFEN` is that position, the extension asks quietly (`cdbAsk(false)`: no dimming,
no header note), at most once a minute per position after a failure. The redraw after a
quiet answer needs the last render to have been for that position, since `lastStatsData`
may still be the previous position's while the page fetches. Harness only; not yet seen live.

**Repgen: moves with too few games compete (2026-09-26).** Reported on
`reti_accepted_e4`: after 3...Be6 4.Ng5 Qd4 5.Nc3 Nf6 6.Nxe6 fxe6 the run played 7.Qa4+
(Prac 53.0 d3, 66 games) over 7.d3 (5 games, ChessDB 55.4). A row under `minGames` has
state `few` and ChessDB's eval as its value, and `choose()` compared `value` rows only, so
the one move with enough games won however far ChessDB rated it under the others. The
column's much higher d3 was Maia's, which repgen doesn't have. Now `few` rows compete on
that eval, a floor for their Practical value (a human mean is never below the best reply),
and never set the table's depth. The node gets `few: true`, the PGN says `Prac at least …,
few games (N)`, and rows save `games`. `--check` re-searches positions whose saved rows
`choose()` now picks differently; 7 of that run's 117 practical picks, found offline from
its JSON. Harness only; no live run yet.

**ChessDB exploration (`tools/cdbexplore.mjs`)**, built 2026-09-26. Why: ChessDB scores
a queued position with one search of about depth 22 per move (noobpwnftw, talkchess 2019;
its engine is noobpwnftw/Stockfish branch `siever`, Stockfish 19 plus a sieve command, as
of 2026-09-20), and an eval deepens only as positions below it enter the database and get
backed up. In `reti_accepted_e4` the stored line (querypv's `depth`, which equals its PV
length) was 27 plies (median) at plies 0–7, 7 at 12–15, 4 at the line ends. vondele's
cdbsearch.py, run by hand at depth 12 with 3 in flight on three close line ends: 975, 447 and
405 requests, 8–10 minutes each, 43–71 positions queued, no rate limiting. Evals moved
0.00, −0.42 and −0.02 (Black's side), but in the third ChessDB's best reply (a6) fell by over
a pawn. The tool's own search is covered by the harness. Its `--list` survey ran live on
`reti_accepted_e4` the same day: 310 positions, 376 requests in 6m16s at 60/min, 21 targets
(9 line ends, 12 decisions), ChessDB with no eval for 2. The first full run the same day
(all 21, before the in-depth deadline existed): 5h33m, 9,048 requests; 8 targets stopped
`stable` (1–21 min), 13 on time (22–40 min, overrunning `--minutes`, hence the fix). No
rate limiting. 9 of 21 changed: ChessDB's best moved off the PGN's move in two decisions by
0.21 and 0.27, and most line-end evals rose for White (+2.32 → +3.10 at most). A `--check
--dry-run` afterwards: 153 positions, 14 to search again, 7 marks changed.

**Copy continuation (v1.12.0).** Requested 2026-09-26: the site's Copy gives the whole line
from move 1 with comments; this copies only the clicked move's branch (from its first
ancestor-or-self with a sibling) to the end of the line, following first children like the
site's Variation PGN, as bare moves with PGN numbering from the FENs. Harness only; not yet
seen live. The site hides its own Copy for chapters not starting from the initial position;
ours is always shown, since its numbering doesn't depend on that.

**Repgen: near-ties go to ChessDB (2026-09-26).** The user's rule: Practical decides, except
when two moves are within `closeWithin` (1) win% points of each other, where the one ChessDB
rates at least `closeCp` (5) centipawns higher wins. A clear Practical lead still wins
however ChessDB rates the move; that is what Practical is for (a move "bad" only to an engine
reply nobody finds). A weighted blend of Practical, prepared and ChessDB was discussed and
turned down for that reason. `choose()` walks the in-band rows in Practical order and switches
only for a 0.05 gain over the current pick, so it is deterministic when pairwise preferences
cycle. Rows now save `cp`; a node won that way carries `close`, and the PGN says
`(over d4 58.0: ChessDB +0.30 vs +0.25)`. `--check` re-searches near-ties that fresh evals
decide differently. On by default. Only repgen: the extension's green (in `main-world.js`) and
the search's own inner rule (`preferBestWithin`, anchored on ChessDB's best) are unchanged.
Harness only; no live run yet.

**Clickable lines in training (v1.13.0).** Requested 2026-09-26: in a training comment,
`(3... Nc6 4. Bg2 e5 5. d3)` gets clickable moves that preview the line on the board and
add nothing to any chapter. Where it starts is read off the FENs (the commented node's
position or its parent's, whichever has that move number and side). The two comments in
the test study's line cover both. Verified live the same day in Read mode, by injecting
the section into the page (the extension itself wasn't reloaded, since `chrome://extensions`
can't be opened from automation): both lines drew the right positions and highlights, the
arrow keys stepped through and back out, a board click went back, and `ts`, `fen`,
`currentNode`, the tree and `dirtyChapterIndices` were unchanged. Interactive mode is
covered by the harness only. Study mode (`#moves`) is not decorated.

**Line jumping (v1.13.1).** Requested 2026-09-27: → on training's last move enters the first
line of that move's comment, and a comment's lines play end to end with the arrow keys (→
from a line's last move to the next line's first, ← back to the previous line's last),
skipping lines whose first move is illegal. Lines are numbered per comment row
(`__qxCl.row`/`.line`); jumping never crosses into another comment. The 1.13.0 stop at a
line's start position on ← was dropped so ← and → are exact inverses. Harness only.

**Faster deepening (v1.14.0).** Asked 2026-09-27: deepening was slow. The explorer's rate
limit was measured with `tools/lichess-rate.mjs` (no rate headers are sent). It is a token
bucket of about 23 requests, refilling at about 18.5–19 a minute:
- 23 unpaced requests went through from rest, and the 24th got a 429;
- a steady 33/min got a 429 on the 52nd;
- 20/min, then 30/min, got one on the 76th, at 164 s.

The old 15/min was already 80% of the refill, so the gain is in the burst. The limiter is
now 16/min with a burst of 16 (was 8), and the popup's rate is capped at 18 (`RATE_MAX`).
Lichess's bucket thus stays at least 7 ahead, the room left for Qchess's panel.
ChessDB measured about 420 ms per `queryall`, about 210/min with 2 in flight, so it isn't
the limit.

Requests per position were measured by replaying repgen's 135 depth-5 searches over
`repgen-cache.jsonl` (1 of 8,439 explorer answers missing). New defaults:
- `replyThreshold` 3% (was 2);
- `skipExplorerBelow` 10: without Maia, the explorer isn't asked below a move with fewer
  games, the Maia path's rule extended;
- `compareReachMin` 10%: no own-move alternatives on rarer lines.

Together they take 8,439 requests down to 5,766 (d1 4, d3 12.5, d5 26 per position, was
4 / 17 / 41). Row values moved by 0.08 on average and 1.6 at most, and the best row changed
in 3 of 135. Two ideas were rejected in the same replay:
- Skipping below 50 games: the "games of the move that led here" bound failed in 16% of
  skips (transpositions: 6,835 games behind a 43-game move) and moved values by up to 5.8.
  The Maia shortcut at `maiaOnlyBelow` relies on the same bound.
- An explorer request at my own nodes, to bound each candidate: it cost more than it saved.

Prefetching the next position was left out: consecutive positions share only 11% of their
requests, and prefetching spends the burst the next position would use.

repgen keeps its old search (`SEARCH_DEFAULTS` sets the savings to 0, and flags turn them
on). The limiter changes are covered by the harness; the extension itself is not yet seen
live.

**Own-token burst (v1.14.1).** `tools/lichess-rate.mjs --shared` showed the limit counts per
token or per account, not per IP. Token A (the user's own, account blindsmurf) was refused
after 22 requests, and token B (Qchess's, account OpeningVariations) then got 12 through at
once. Per token vs per account is untested.

So the burst now depends on the token (`burstFor`): 20 with the popup's own token, 16 with
Qchess's, since Qchess's panel draws on that one. It is 20, not 22, because that run's
bucket held 22, not 23.

Two further changes:
- A 429 now empties our bucket too, so after the 60 s pause it can't be fuller than
  Lichess's.
- The bucket is saved to session storage after explorer requests (`peLimiter`) and
  restored before a search starts. A worker stopped while idle would otherwise come back
  full while Lichess's is still refilling.

The user asked about alternating their two tokens to double the rate. That was declined as
evading Lichess's per-account limit, and it would also starve Qchess's panel. Harness only;
not yet seen live.

Obvious next feature: flag *legal moves from the current position that would transpose into a
known line but aren't in the tree yet* — same index, hooked into the database move list where
the site already consults `REP_STATE.map`.
