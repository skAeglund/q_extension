# Qchess Transpositions

A Chrome extension for [qchess.net](https://qchess.net) study pages. It marks every move in
the notation pane that reaches a position you can also reach by a different move order, and
lets you jump straight to the other line.

Matching is confined to the chapter you have open, so everything it marks is somewhere you
can jump to without leaving the board in front of you.

It also marks which side each variation belongs to, so the branches you chose are told apart
from the ones you have to be ready for.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Open a Qchess study — reload the tab if it was already open

## Using it

A green `⇄` badge appears next to any move that transposes, carrying the number of other
ways to reach that position. Moves reaching the same position also share a colour and a
dashed outline, so you can see at a glance which marks belong together.

Clicking a badge opens a branch menu below that move, built from the site's own
`.next-moves-menu` / `.next-move-option` classes so it matches the menu Qchess shows for its
own branches:

```
  3. b4 ⇄2   c5
  4. g3 ⇄3   cxb4 ⇄2
  ┌────────────────────────────────────────────────┐
  │ SAME POSITION VIA                              │
  │ 4.g3   1.Nf3 d5 2.c4 d4 3.b4 c5                │
  │ 4.b4   1.Nf3 d5 2.c4 d4 3.g3 c5                │
  └────────────────────────────────────────────────┘
  5. Bg2  Nc6
```

Each row is the move (`genMoveLabel` format) plus the move order that reaches it. The move
order matters: different orders frequently end on the *same* move, so `4.g3` can legitimately
appear twice and only the order tells them apart.

Clicking a row replays a click on that move in the notation, so the site's own navigation
handler runs. Escape or a click elsewhere closes the menu.

### Whose branch is whose

Every variation in the notation gets a left bar saying who opened it: bright for a branch
that starts with one of **your** moves, faint for one that starts with the opponent's.

```
14... f6  15. Bf3  Nc5  16. b4  Nd7      ← theirs: a move you have to meet
15. Qe2   Nc5  16. Rfe1  e6              ← yours: an alternative you chose
```

The two kinds of branch mean different things — an opponent branch has to be covered, a
branch of your own is a choice between lines — and the notation draws them identically.
Branches nested inside another get the same treatment on their own elbow.

"Yours" is the chapter's own **perspective** setting, the same field the site uses to orient
the board; in repertoire mode it is the perspective you entered with, and outside a study
chapter it falls back to the site's white/black setting and then to the board orientation.
The popup says which side it settled on.

The toolbar popup has toggles for markers, outlines, compact badges and the branch bars, plus
a count of what was found in the current chapter.

### Copy continuation

Right-clicking a move in the notation adds **Copy continuation** below the site's Copy. It
copies just the branch that move is in: from the branch's first move (the last point where
the line splits) to the end of the line, following the first move wherever it splits again
further on, the way the site's Variation PGN does. Only the moves, with no comments or
glyphs:

```
4... c5 5. d4 cxd4 6. Nxd4 Nf6 7. Nc3
```

A move on the main line with no split above it copies from the chapter's first move. The
item reads **Copied** for a moment, then the menu closes.

### Clickable lines in training

In training mode (Read or Interactive), a line written in a comment in parentheses gets
clickable moves:

```
Better is (3... Nc6 4. Bg2 e5 5. d3), or even (5... b6 6. Bg2 Bb7 7. axb4).
```

Click a move to see the position after it on the board. The chapter, and where you are in
training, don't change: it's only a preview. While it's showing, ← and → step through the
line, Esc goes back, and so does a click on the board. Any other navigation (a notation
move, the next training move) goes back too.

A comment's lines play end to end with the arrow keys: → on a line's last move goes to the
next line's first move, and ← from a line's first move goes back to the previous line's
last move, or out of the preview after the first line. On training's last move, → goes
into the first line of that move's comment.

Where the line starts comes from its first move number. If it's the move after the
commented one (`5... b6` on a comment on 5.a3), the line continues from there. If it's the
commented move's own number and side (`3... Nc6` on a comment on 3...c5), the line replaces
that move. A line that fits neither stays plain text, and so does anything in parentheses
that isn't moves. Moves from the first illegal one on are struck through.

## Eval column (ChessDB)

The explorer's Eval column shows ChessDB's evals as soon as ChessDB has answered for the
position; until then it stays blank, rather than flashing the database's older numbers
(after 5 s without an answer, those show). With Lichess selected, Qchess doesn't ask
ChessDB again when you come back to a position it has already shown, so a position you
left before ChessDB answered would keep the database's numbers, or none. The extension
asks ChessDB itself in that case.

**Refresh.** Click the Eval header to sort by eval, as Qchess does. Once the table is
sorted by eval, the header reads **Eval ↻**, and a click asks ChessDB again about the
position on the board. With Lichess selected, Qchess otherwise keeps a position's first ChessDB answer for
the whole session, so a position ChessDB has analysed since (for example one the Practical
column asked it to analyse) would only update after a page reload. The evals dim while the
request is out, and the header's tooltip says when you last asked and what ChessDB said.
The new evals stay in place when you come back to the position. The Practical column
keeps its own cached ChessDB answers (7 days) and isn't affected.

## Practical column

The explorer table gets a **Prac** column right after Eval. For each of your candidate
moves it shows your expected score (win%, 0–100) when every opponent reply is weighted by how
often Lichess players actually play it, and each reply is valued by its ChessDB eval. Eval
is the engine's worst-case view; Prac is what you score in practice against that player
pool.

- It is computed only on your moves. Rows are picked two ways, up to 8 in all: the moves
  the Eval column rates within 5 win% points of its best (up to 3), so a strong but rarely
  played move is never skipped, and the rows with at least 2% of the games. Any other row
  shows a faint `+` on hover: click it to compute that row.
- **Right-click** a Prac cell to leave that move out of the analysis at this position. It
  shows a faint `×`, its search stops, and its share of the request budget goes to the
  other rows. Right-click again to bring it back. Exclusions last for the browser session.
- **Green** marks the best practical move: the highest Prac among rows searched to the
  same depth (every row showing that number, on a tie). It needs at least two values to
  compare. The tooltip still gives each value's difference from the engine's win%.
- **Maia fills in where games are few.** Under 100 games, a reply's weight is its games
  plus a share of up to 20 "pseudo-games" spread by Maia's move probabilities. Maia's part
  shrinks as the games add up and is gone at 100. Under 10 games Maia alone decides, and a
  line whose move already had under 10 games is not even looked up on Lichess. Maia plays
  at the rating filter's middle (about 2150 for the default 1600–2500).
  A value that rests mostly on Maia is **purple**; if it is also the best, it stays green
  with a purple underline. The tooltip gives Maia's share and marks replies with no games.
  This uses the Maia model Qchess already keeps: turn Maia on in Qchess once to download
  it. The extension runs its own copy of Qchess's Maia worker, so the page's Maia column
  is unaffected, and the Maia switch doesn't need to stay on.
- **Maia preview while Lichess catches up.** The Lichess explorer allows about 16 requests
  a minute, so a new position's values can take a minute or more to reach depth 3. In the
  meantime the column shows a quick preview: the same search with Maia's predicted replies
  in place of Lichess games everywhere, which needs only ChessDB and Maia. It reads `≈54`
  in purple italics. Measured against live ChessDB with Qchess's Maia model and nothing
  cached, 4 to 6 rows reached depth 1 in about 2 s, depth 3 in about 10 s and depth 5 in
  about 30 s. A preview gives way to the Lichess value once that is 3 plies deep, or
  finished, and until then only when it is deeper than the Lichess value.
  - It's a way to see early whether a move is worth waiting for, for example one that
    scores above the engine's best. Maia doesn't know opening theory, though: where the
    players in the filter know the book reply, the preview can overrate a trap that
    Lichess games will show doesn't work. That is why the Lichess value replaces it.
  - Green marks the best preview among those at one depth, as it does for Lichess values.
    A preview is never compared with a Lichess value.
  - The preview's tooltip gives its replies and how far the Lichess search has got. The
    Lichess value's tooltip names the last preview afterwards.
  - It makes no Lichess requests, and its ChessDB lookups wait behind the Lichess
    search's, so it never slows the real value down. Both searches share ChessDB's cache,
    so the preview's lookups are often ones the Lichess search needs later anyway.
  - It needs Qchess's Maia model, like the fill-in above, and has its own switch in the
    popup.
- `–` means too few games (under 50, when Maia isn't available) or no ChessDB eval, and
  `?` means an error. Hover either one for the reason; click `?` to retry.
- Hovering a value lists the main replies with the move you'd answer each with
  (`c5 38% → 67% (Nf3)`), the tail valued by engine, the share with no eval, and the depth.
- Values deepen in the background: first the direct replies, then one full move deeper at
  a time, up to 5 plies below the row. Every row finishes a depth before any row goes
  deeper, and a depth's values appear together, because deeper values tend to come out
  higher and only same-depth values compare fairly. While the rows are still searching,
  the `%` gives way to a small depth marker (`52d3`), and the tooltip says "searching
  deeper". When they stop, the tooltip says why: nothing deeper to see, the depth limit,
  or the request budget.
- At your own moves further down the line, the search starts from ChessDB's best move. On
  later rounds it compares the nearby alternatives at the same depth, switches only when
  one clearly scores better against real replies, and then searches the chosen move to
  full depth. The tooltip names the switch (`Your move after Nf6: c4, not ChessDB's Nf3`).
  Alternatives are only compared on lines reached at least 10% of the time. On rarer
  lines, ChessDB's best stands: an alternative costs a request and barely moves the row.
- Below a reply with fewer than 10 games, the explorer isn't asked (without Maia). The
  position is valued by ChessDB, as it would be with too few games anyway.
- When ChessDB has no eval for a position the search needs, or for a reply people often
  play, the extension asks ChessDB to analyse it (its `queue` and `store` requests). That
  line then counts as a leaf for now. ChessDB usually answers within a couple of minutes:
  later depths of the same search pick up its evals, and a finished row is searched again
  when you come back to the position a few minutes later (twice at most). The tooltip
  says how many positions were sent.

It uses the panel's Lichess filter (speeds, ratings, "recent only"), even while the panel
shows another database; the header's tooltip then says "Practical: Lichess data".

**Token.** The Lichess explorer needs a personal token. Paste one into the popup, or leave
it empty and the extension uses the one Qchess keeps after "Connect Lichess" (switchable).
Either way the token stays in the background worker and never reaches the page. With a
**local explorer** set in the popup (see [A local explorer](#a-local-explorer-explorerdb)),
no token is needed and none of the limits below apply.

**Politeness.** One Lichess request at a time, 16 a minute (a setting, 18 at most), with
bursts after a pause. The explorer's own limit, measured in September 2026, lets 22 or 23
requests through at once and refills at about 19 a minute. It counts per token, not per
connection. The extension stays under both numbers:
- With your own token in the popup, bursts are up to 20. Qchess's panel has its own
  allowance, so the extension doesn't compete with it.
- With Qchess's token, bursts are up to 16, leaving the panel room.

The burst is what makes a new position quick: its first requests go out together instead
of one every 4 seconds. So a token of your own in the popup makes the column faster, and
leaves Qchess's allowance to Qchess. Don't run repgen with that same token while you use
the column: they would share it. A rate-limit answer pauses everything for 60 s. Each position gets at most 60 new requests (a setting),
spent on the most-played lines first; every row always gets its first value. A depth is
only started if the remaining budget roughly covers it. If the budget runs out partway
anyway, the table stays at the last depth every row finished, and the responses already
fetched are cached, so a revisit finishes that depth cheaply. Leaving a position drops its
waiting requests at once, and coming back picks up where it stopped. Responses are cached (explorer 30 days, ChessDB
7 days), so revisiting a position costs nothing. The popup shows the cache size and the
requests made this session. ChessDB is asked to analyse a position or move at most once a
day, and at most 30 times per position you look at. After asking, the position is looked
up again every 2 minutes, only while a search needs it, for an hour at most.

Settings are in the popup's **Practical eval** section: on/off, token and Test, the local
explorer's address and Test, whether to
follow the panel's filter (and the fallback speeds and ratings), and under Advanced the row
and reply thresholds, the minimum games, the request rate, how rare a line can be and still
be followed, the maximum depth, how many of your own moves are compared and how close they
must be, the requests per position, and Maia's game limits and weight. Maia itself, and
the Maia preview, have switches next to the filter settings.

### Prepared score (the Score column)

The Score column's bars show how games went after each move, and those results include
every later mistake by the side that played it. A good move can look worse than it is if
many players who chose it went wrong a move or two later. The **prepared score** recomputes
the win/draw/loss split as if you play the move the Practical search picks at each of your
turns, while opponents keep their real mix of replies, mistakes included.

**Click the Score header** to switch the bars between the panel's own results and the
prepared ones. If the table is sorted by something else, the first click sorts it by score,
as Qchess does, and the next one switches. The label reads **Prepared** while it's on, and the choice is remembered (the
popup has the same switch). No new column is added, and sorting still follows the panel's
own results.

- A recomputed bar has a thin blue outline. The best prepared score has a green one
  instead, compared the way green is in the Prac column: rows at the same depth, and at
  least two of them.
- A bar that rests mostly on the Practical value rather than on games (see below) is
  muted, with a dashed outline.
- A row with no prepared split keeps the panel's bar, faded: not computed yet, excluded,
  `–`/`?`, or not your move. Novelty rows and the totals row are never changed.
- Hovering a bar gives the prepared split next to the same games' own results, your
  expected score both ways, the main replies (`c5 38% → 61% (Nf3)`: their own score, then
  prepared, then your answer), how much rests on the Practical value, the depth, and the
  games at the leaves.

It comes from the same search as the Prac column and costs **no extra requests**. At each
of your moves it follows the Practical choice; it never picks moves by their results,
because picking by the best-looking sample would mostly pick luck. Where the search stops,
a line's own game results are used, pulled towards its Practical value by a number of
"games' worth" of trust (50 by default). A line with thousands of games keeps its results;
a line with a handful leans on the Practical value. The tooltip gives that share.

What it means: your score if you play your prep as deep as the search went, then play like
the average player in this pool. Beyond that depth, results include everyone's later
mistakes, yours too.

**Known bias.** Players who find the best move tend to be stronger and to play the rest of
the game better, so part of the prepared score reflects who plays the line rather than the
line itself. A narrow rating filter reduces this.

The numbers always come from the extension's own Lichess data, even when the panel shows
Elite, CORRdb or another database; the tooltip compares against the same games, and adds the
panel's own numbers only when it shows the same Lichess filter.

Settings, in the popup's **Prepared score** group: on/off (off also hides the toggle), and
whether the Score column shows prepared results. Under Advanced: the trust in the Practical
value, in games. Like every search setting, a change applies to positions searched after
it. Rows already computed keep their values, so rows computed while prepared scores were off
show the faded panel bar until their position is searched again (reload the page to force
that).

## Repertoire generator

`tools/repgen.mjs` builds a repertoire from the Practical eval without a browser. It's meant
to run for hours, overnight for example, and produces a PGN you import into a Qchess chapter.
It uses the extension's own search, depth rounds and Lichess/ChessDB clients (`src/pe`), so
its values are the ones the Prac column would show. It needs Node 22 or later, and nothing
else unless you turn on Maia ([below](#maia)).

```bash
# PowerShell: $env:LICHESS_TOKEN = 'lip_...'
node tools/repgen.mjs --moves "1.e4 c5" --side white --out sicilian --hours 8
```

The Lichess explorer needs a token. Create one at
[lichess.org/account/oauth/token](https://lichess.org/account/oauth/token); it needs no
scopes. Put it in `LICHESS_TOKEN`, or in a file passed as `--token-file`. The token is never
written anywhere.

The games are Lichess blitz, rapid and classical games in the 1800, 2000 and 2200 rating
groups (`--speeds`, `--ratings`). A run keeps the filter it started with.

**How it builds the tree:**

- **Your moves.** Candidates are chosen the way the column chooses its rows: the moves
  ChessDB rates within 5 win% points of its best (up to 3), plus moves played at least 5% of
  the time that it rates within 10 points (up to 6 candidates in all). On top of those, the
  3 moves that score best for you in the games (wins plus half the draws) are always
  searched, whatever ChessDB thinks of them. Only moves with at least 20 games count for
  this (`--score-rows`, `--score-min-games`). They are searched in lockstep rounds, depth 5 for
  your moves in the first 6 plies after the start position (`--deep-plies`) and depth 3
  after that. The best Practical value
  wins, compared only at one depth, as the column's green is. Without Maia, a move with too
  few games for a Practical value (under 50) competes on ChessDB's eval instead, which its
  Practical value would be at least about, so it wins only when even that beats the rest;
  the PGN says `Prac at least …, few games`. A near-tie goes to ChessDB: a move within 1 point of
  the top Practical value wins when ChessDB rates it at least 0.05 higher
  (`--close-within`, in win% points, 0 turns it off; `--close-cp`, in centipawns). A
  lead of more than a point wins however ChessDB rates the move. The PGN then says what
  the move beat, as in `{Prac 57.5 d3, engine 54.1 (over d4 58.0: ChessDB +0.30 vs +0.25)}`.
  With fewer than 10 games, or no
  Practical value at all, ChessDB's best move is played instead and the PGN says so.
- **Their moves.** The most played replies are followed until they cover 90% of the games
  (`--coverage`). Coverage drops by 10 points at each later opponent decision on the line
  (`--coverage-step`). Once it falls below 50% (`--single-below`), only the most played reply
  goes on.
- **Where lines end.** A line ends when its position has fewer than 10 games
  (`--stop-games`). A reply other than the most played one is followed only if the line's
  chance of happening (its *reach*) is at least 0.5% (`--min-reach`), and no line goes on
  below 0.1% (`--line-min-reach`) or more than 40 plies past the start position (`--max-ply`).
- **Order.** The most likely positions are done first, so a run stopped at any point has
  covered what matters most. A position reached by two move orders is searched once.
- **Maia** is off unless you turn it on (`--maia`, [below](#maia)). Without it, positions
  under 50 games count as leaves, as they do with Maia switched off in the column.

**Output files** (for `--out sicilian`) go into the `repertoires/` folder of the project.
An `--out` with a directory (`--out D:/chess/sicilian`) is used as given instead. The other
tools look up a bare file name there too, so `node tools/pgnclean.mjs sicilian.pgn` works
from the project folder.

- `sicilian.pgn` is rewritten after every position, so it's always readable. Opponent
  replies are ordered most played first. Your moves carry comments like
  `{Prac 58.2 d5, engine 53.1; Nf3 56.0, c4 55.4}`, and replies carry `{34% of 12,345 games}`.
  Comments also say where and why a line ends, or `transposes to …`.
  Your move is marked when ChessDB rates it under its own best move: `!?` from 3 win%
  points, `?!` from 7 and `??` from 15 (`--mark-interesting`, `--mark-dubious`,
  `--mark-blunder`; 0 turns a mark off). A move that hands the opponent an edge (−0.10 or
  worse for you) where ChessDB's best doesn't gets at least `!?`, however little win% it
  costs: at ChessDB's depth, 0.00 in a known opening is a draw with best play
  (`--mark-worse-than`, in centipawns). Its comment then names the best, as in
  `{Prac 58.0 d5, engine 36.5 (best e4 52.8)}`. A Practical pick can be worse on the board
  than the engine's move, and the mark says by how much. Qchess imports the marks as move
  annotations. To re-mark a finished run with other thresholds, pass them with `--pgn-only`.
- `sicilian.json` is the run's state. Run the same command again to carry on where it
  stopped, including after Ctrl+C. Plan options given on a resumed run replace the saved
  ones, and `--fresh` starts over. `--pgn-only` rewrites the PGN from the state.
- `sicilian.log` has a line per position.
- `repgen-cache.jsonl`, next to it, caches every response and is shared by all runs. A
  second run over the same ground is much faster.

**Speed.** Lichess requests are paced at 15 a minute (`--rate`) and ChessDB requests at 60
(`--chessdb-rate`). A search of one of your positions costs up to 60 uncached Lichess
requests (`--budget`), or up to 150 when searched deep (`--budget-deep`). The first round of
a search is never cut short, and later rounds stop when the budget can't pay for them. A
night of 8 hours is about 7,000 Lichess requests. Lichess's limit, measured in September
2026, refills at about 19 a minute, so a `--rate` above 18 runs into rate limits. That limit
may be shared with the extension and Qchess's panel. Make sure the PC doesn't go to sleep
during the run.

The extension's Practical column makes about a third fewer requests since v1.14.0. It
expands replies from 3%, skips the explorer below a reply with under 10 games, and
compares your alternatives only on lines reached 10% of the time. repgen keeps searching
as before, so a checked run is searched again the way it was built. `--reply-threshold 3
--skip-explorer-below 10 --compare-reach-min 10` switch these savings on.

`node tools/repgen.mjs --help` lists every option with its default.

### Maia

With `--maia`, Maia 3's move predictions fill in where the games are few, the way they do in
the Practical column. Under 100 games, a reply's weight is its games plus up to 20
"pseudo-games" spread by Maia's probabilities, a share that shrinks as the games add up. Under
10 games Maia alone decides, and below a reply with under 10 games Lichess isn't asked at all.
Without Maia, the search treats a position under 50 games as a leaf, so your moves in
positions with a few dozen games competed on ChessDB's eval alone. With it they get Practical
values, and the PGN says how much of a value rests on Maia:
`{Prac 54.2 d3, 35% Maia, engine 53.0}`.

Set it up once, from the project folder:

```bash
npm install --prefix tools
```

This installs [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node) into
`tools/node_modules` (about 300 MB, since it carries every platform's binaries). On Linux
x64 its installer also downloads CUDA libraries, which Maia doesn't need:
`ONNXRUNTIME_NODE_INSTALL=skip npm install --prefix tools` skips them.

The first run with Maia downloads the model into `repertoires/`: `maia3_simplified.onnx`
(46 MB) from CSSLab's [Maia platform](https://github.com/CSSLab/maia-platform-frontend)
(GPL-3), at a fixed commit and checked against its checksum. `--maia-model <file>` uses a
copy you already have instead; it isn't saved with the run, so pass it every time. Qchess's
own Maia model is the same size, but whether it is the same file hasn't been checked.

```bash
node tools/repgen.mjs --moves "1.e4 c5" --side white --out sicilian --maia --hours 8
```

- `--maia` is saved with the run, so the same command without it carries on with Maia.
  `--maia off` turns it off again.
- Maia plays at the middle of the rating filter, as in the column: 2100 for the default
  1800, 2000 and 2200 (`--maia-elo` sets it). `--maia-until`, `--maia-only-below` and
  `--maia-weight` are the column's other Maia settings.
- On the CPU, Maia takes about 35 ms a position, or 12 ms each when a search asks for
  several at once. Lichess's rate limit still sets the pace of a run.
- A move nobody plays can now win on Maia's predictions alone. Its line then ends, because
  a position with fewer than 10 games ends a line (`--stop-games`).
- To bring a run made without Maia up to date, use `--check --maia` (see
  [Checking a run later](#checking-a-run-later)). It searches again every position where
  one of your candidates had under 100 games. In the runs in `repertoires/` that is about
  70% of the positions searched. Their Lichess games come from the cache.

### Deepening ChessDB's evals

ChessDB's eval of a position is only as deep as the tree it has stored below it. In well-known
openings that tree is huge. A position it was asked to analyse, like most line ends of a run,
gets one search of about depth 22 per move, and it stays at that depth until the positions
after it are in the database too. In `reti_accepted_e4`, the stored line behind a position
was 27 plies long (median) in the first 8 plies, 7 at plies 12–15, and 4 at the line ends.

`tools/cdbexplore.mjs` builds ChessDB's tree where the repertoire relies on it:

```bash
node tools/cdbexplore.mjs sicilian.pgn --list       # which positions, nothing explored
node tools/cdbexplore.mjs sicilian.pgn --hours 3
node tools/repgen.mjs --out sicilian --check        # then bring the run up to date
```

It asks ChessDB about every position of the PGN (one request each), and keeps:

- **Line ends**, and **your positions where another move is within 30 cp** (`--close`) of
  the PGN's move. `--leaves-only` keeps only the line ends.
- ...whose best move is within **3 pawns** (`--max-eval 300`): beyond that the line is
  decided, and exploring won't change it.
- ...whose **stored line is under 10 plies** (`--short-line`).

It explores them in order of how often they're reached, from the run's `sicilian.json` next
to the PGN (or `--run <name>`). Without a run, it goes nearest the start first. Each position
gets the search of [vondele/cdbexplore](https://github.com/vondele/cdbexplore):
depth after depth, a minimax over ChessDB's own scores in which a move gets one ply less for
every 2 cp (`--eval-decay`) it trails the best. Positions ChessDB doesn't know are queued and
waited for, which is where most of the time goes. After each depth it asks about the best line
again from its end back, so that ChessDB backs the scores up. At the end it asks about the
moves from the position back to the start of the PGN.

A position stops at depth 12 (`--max-depth`), or earlier when 3 depths in a row
(`--stable`), from depth 6 on (`--min-depth`), agree on the move within 10 cp (`--settle`).
It also stops after 20 minutes (`--minutes`), even in the middle of a depth, which can take a
quarter of an hour when it waits on new positions. The unfinished depth is dropped. The run
as a whole stops at `--hours`.

Tested by hand on three line ends of `reti_accepted_e4` (with cdbexplore itself, at depth 12):
400–1,000 requests and 8–10 minutes each, and 40–70 new positions queued. One eval stayed at
0.00 and one moved 0.42 pawns. In the third, the best reply changed: a6, ChessDB's best, fell
by more than a pawn, and the eval stayed about the same under another move. The stopping
rule above would have ended the first two at depth 6 and 12, and the third at depth 12.

ChessDB is asked at most 60 times a minute (`--rate`), with 3 requests in flight
(`--concurrency`). `sicilian.explore.log` has a line per depth and a before/after line per
position, scores from White's side. `sicilian.explore.json` records each position explored,
and one explored in the last 7 days (`--again-after`) is skipped unless you pass `--again`.
Works on any PGN; give `--side white|black` when it isn't repgen's.

### Checking a run later

Lines end where ChessDB knows least: a search asks it to analyse the positions it found
without an eval, and ChessDB keeps analysing after the run is over. A few days later, check
the run against what ChessDB says now:

```bash
node tools/repgen.mjs --out sicilian --check --dry-run   # report only
node tools/repgen.mjs --out sicilian --check --hours 2   # report, then search again
```

The check asks ChessDB again about every position of yours in the repertoire, one request
each (a few minutes for a few hundred positions). The Lichess games come from the cache,
so it costs no Lichess requests. For each position, `sicilian.log` gets a `Check` line if
something changed:

- **Marks** follow ChessDB's new evals at once, without a search: a move can gain or lose
  its `!?`, `?!` or `??`.
- **Searched again**, when the new evals could change your move: a move ChessDB now rates
  close enough to its best to be a candidate, your move no longer being one, a last search
  that found positions without an eval (ChessDB may have analysed them since), a move with
  too few games whose eval beats the chosen move's Practical value (runs from before such
  moves competed passed them over), a near-tie that ChessDB's new evals decide differently
  (including runs from before near-ties went to ChessDB), or, where
  ChessDB's best was played for want of games, ChessDB's best changing. With Maia turned on
  (`--check --maia`), a search made without it where one of your candidates had under 100
  games is searched again too. `--check-all`
  searches every one of your moves again. Runs made before the check existed didn't record
  the positions their searches found without an eval, so check those with `--check-all`
  once.
- **Carried on**, a line that ended because ChessDB had no eval for the position and now
  has one, or because the last try failed.

Then, unless `--dry-run`, the searches run like a normal run, likeliest first, within
`--hours`. Until a position is searched again, the PGN keeps its old move. When another move
wins, whatever only the old move led to is dropped and the new move's line is built. If a
search fails, the old move stays. The PGN from before the check is saved as
`sicilian.before-check.pgn`, and the run's summary lists each move that changed, as in
`[31.39%] 1.e4 c5 2.Nf3 d6: d4 -> Bb5+`.

From the check on, the run doesn't use ChessDB answers from before it, even when stopped
and carried on later: run the same command without `--check` to carry on. Its Lichess
answers no longer expire, so the searches see the games the repertoire was built on.

### Finishing the PGN

Once you're happy with a run, `tools/pgnclean.mjs` turns its PGN into one to keep:

```bash
node tools/pgnclean.mjs sicilian.pgn
```

It writes `sicilian.clean.pgn` and never touches the input file.

- **Comments** keep only the played share: `{9% of 97,950 games}` becomes `{9%}`. Even that
  is kept only on a move that has alternatives, since its purpose is to compare branches.
  A move that is the only reply left, once transposing branches are gone, has no comment.
  The Prac values, engine moves and line-end notes go. Anything else in a comment, such as a
  note of your own, stays.
- **Their transposing moves** are removed as branches. The move is noted instead on your
  move it answered, with the line written from where the two move orders part. After
  3... e6 4. Bxc4, for example, the branches 4... Nf6 and 4... Nc6 go, and 4. Bxc4 reads:
  ```
  {Nf6 transposes into 3... Nf6 4. Bxc4 e6

  Nc6 transposes into 3... Nc6 4. Bxc4 e6}
  ```
  Notes are separated by a blank line, which Qchess keeps as a paragraph break in the main
  line's comment rows.
- **Your transposing moves** stay, since they're the moves to play, and get
  `{Transposes into …}`.

Transpositions are found by replaying the moves, not from repgen's comments. The script
works on any PGN, including one you've edited or exported from Qchess. It reads the
repertoire's side from repgen's `White`/`Black` headers; give `--side white|black` for any
other PGN, and `--out` to choose the output file.

### A local explorer (explorerdb)

`tools/explorerdb.mjs` builds an opening explorer of your own from Lichess's monthly game
dumps ([database.lichess.org](https://database.lichess.org)), so the counts don't have to come
through the explorer's rate limit. It imports one dump at a time:

```bash
node tools/explorerdb.mjs import lichess_db_standard_rated_2026-08.pgn.zst --out aug26
node tools/explorerdb.mjs query aug26 --moves "1.e4 c5"
node tools/explorerdb.mjs info aug26
```

Indexes live in the `explorer/` folder of the project: a bare name like `aug26` means
`explorer/aug26.xdb`, and a name with a directory is used as given. A dump given by bare name
is looked for in the current directory, then in `explorer/`, so you can keep dumps there too.

`import` keeps the games that pass the filter, which is fixed at import time. By default it
is what the extension asks Lichess for: blitz, rapid and classical, with the players' average
rating 1600 and up (`--speeds`, `--ratings`, in the explorer's own terms). It counts each
game's first 40 plies (`--plies`), and writes `explorer/aug26.xdb` holding every position reached by
at least 10 of those games (`--min-games`), with all the moves played there. The report shows
how many positions each threshold from 1 to 1000 would keep, and how big the index would be,
so one month tells you what the whole archive would cost.

`query` prints a position the way the Lichess explorer answers it (totals, then each move's
uci, SAN and results, most played first).

**Serving it.** To have the Practical column and repgen use the index instead of Lichess:

```bash
node tools/explorerdb.mjs serve aug26                # http://localhost:9337, Ctrl+C stops it
```

- **The column:** type `localhost:9337` under **Local explorer** in the popup, then Save.
  Test shows which index answers. Searches from then on ask the server: no token, no rate
  limit, no per-position budget, so rows deepen as fast as ChessDB answers. Its answers
  aren't cached, since one month's counts and Lichess's shouldn't share a cache. Clear the
  field to go back to Lichess.
- **repgen:** add `--explorer localhost:9337`. No token is needed, and a new run takes the
  index's filter. The run remembers which explorer it used and notes a switch, since one
  month and all of Lichess count different games.

The filter is the index's, fixed at import. A request asking for another one (the panel's
filter, say) gets the index's answer all the same, and the server prints a note the first
time. Positions under `--min-games` answer with no games, which the search treats as too
few, as it does for rare positions on Lichess. So do positions only reached at the ply limit:
their games went on, but the index doesn't know with which moves.

What it needs:
- **Node 22.15 or later** reads `.zst` itself (`node --version` tells you which you have).
  An older Node needs the `zstd` program on the PATH, or a dump you've decompressed first.
  Updating Node to the current LTS is simplest, on Windows too.
- **Temporary space**, about 16 bytes per counted ply past the 12th: 10–15 GB for a month.
  It goes in `<out>.xdb.tmp`, or wherever `--tmp` says, and is deleted at the end.
- **Time.** The replay runs on `--workers` threads (default: one fewer than your cores, at
  most 8). Reading and filtering the dump runs on one more. `--max-games 1000000` stops
  early, for a quick trial.

Positions are keyed by chess.js's 64-bit Zobrist hash, so an index is only readable with the
same chess.js (1.4.0, `src/vendor/`). The index says which hash it was made with.

## How it works

Qchess is a vanilla-JS app with no build step, and it keeps its analysis state in
script-scope bindings rather than on `window`:

| Page symbol | Used for |
| --- | --- |
| `tree` | The chapter's move tree. **Every node carries a full FEN.** |
| `studyData.chapters[]` | Chapter count for the popup, and `.perspective` — the side the chapter is written for |
| `activeChapterIndex`, `studyUuid` | Noticing that the open chapter or study changed |
| `REP_STATE`, `userColor`, `boardFlipped` | Fallbacks for "which side am I?", in that order |
| `.variation-line`, `.branch-variation` | The branch containers the left bars go on |
| `_repStripFen(fen)` | The site's own position key — the first 4 FEN fields |
| `nodeDataKey(node)` | `"<variationId>-<moveIndex>"`, matching `data-node` in `#moves` |
| `rebuildNotationDisplay()` | Re-renders `#moves`; we wrap it to re-apply markers |

The Practical eval column, in progress, will add these explorer-panel symbols. The full
list is in `CLAUDE.md`:

| Page symbol | Used for |
| --- | --- |
| `fen`, `currentNode` | The position the explorer table is showing |
| `displayStatistics()` | Rebuilds `#database-trees`; to be wrapped to re-apply the column |
| `lastStatsData`, `lastEvalsData` | The rows' games and evals (SAN-keyed) |
| `lichessSettings`, `selectedDB` | The panel's Lichess filter and which database it shows |
| `#db-column-header`, `.tree-move` | Header and row markup the column is inserted into |

Detection is just:

```js
_repStripFen(a.fen) === _repStripFen(b.fen)
```

Because each node already stores a FEN, the extension contains no chess logic — no move
generation, no board representation, no engine.

### Architecture

`src/main-world.js` runs in the **MAIN world** (`"world": "MAIN"` in the manifest). This is
required: an isolated-world content script cannot see `tree` or `studyData`, since they are
`let` bindings in the page's script scope rather than properties of `window`.

MAIN-world scripts have no access to `chrome.*`, so `src/bridge.js` runs in the default
isolated world and relays settings in (`chrome.storage` → `qx:settings` event) and stats out
(`qx:stats` event → popup).

### Why badge clicks are intercepted in the capture phase

Every move element (or its `.variation-move-group` parent) carries the site's own click
handler, which navigates and then calls `rebuildNotationDisplay()`. A listener bound to the
badge itself is not enough — handlers bound higher up have already run by then, so the click
both navigated *and* triggered a rebuild that wiped the menu before it could be used.

The extension instead uses one delegated listener on `document` in the **capture** phase. It
sees the event before anything else, so `stopPropagation()` there reliably keeps badge clicks
away from the site's navigation. As a second guard, `annotate()` reopens the menu if a rebuild
happens while it is showing.

## Tests

```bash
node test/harness.js
```

Runs `src/main-world.js` for real against a stubbed DOM and a reconstruction of a study
containing a deliberate three-way transposition (`Nf3 d5 c4 d4 g3 c5 b4` and its two other
move orders). It asserts the same numbers the live page produced — 3 transposing positions,
8 marked moves — and covers the injected stylesheet, the toggles, the branch menu (its
classes, where it is inserted, its labels, toggling, reopening after a rebuild), navigation,
and the fact that nothing reaches into the study's other chapters. The stub `#moves` is built
the way the page builds it — main line as `.added-move` rows, variations as `.variation-line`
spans, one branch nested in another — so the branch bars are checked on real markup, along
with each source the side is read from. The stub explorer table draws the Score bars the
way the page does, so the prepared mode is checked on that markup: the header toggle, the
bars' widths and labels, restoring them exactly, and leaving the structure alone. A stub
training notation (`#mt-moves-display`, rebuilt like `renderMTNotation`) checks the
clickable lines: where each starts, the preview, the keys, and that training's state is
never touched.

## Notes and limits

- **Position key.** `_repStripFen` keeps placement, side to move, castling rights and the
  en-passant square, ignoring the halfmove and fullmove counters. This is the site's own
  convention. It is conservative: it will never invent a false transposition, but two
  positions differing only in a recorded-but-unplayable en-passant square count as distinct.
- **Scope.** Matching covers the chapter you have open — not the study's other chapters, and
  not your other studies. Widening it would mean parsing the other chapters' PGNs (they
  already arrive with the study) or fetching `/api/studies/<uuid>` per study; the page's
  `_repBuildMap()` and `_repParsePgnBatchParallel()` show the shape that would take.
- **Repertoire mode.** When the site's own repertoire mode is active it swaps the tree out;
  markers follow whatever tree is live, which is usually what you want.
- **Performance.** Indexing is one walk of the tree the page has already built, re-run after
  each notation rebuild. Nothing is parsed and nothing is fetched.
- The Qchess study page is heavy (Stockfish WASM plus several workers). If a tab feels wedged
  during a reload, that is the page, not this extension.

## Layout

```
manifest.json
src/main-world.js   detection + UI, runs in the page's world
src/bridge.js       chrome.storage <-> page relay, isolated world
src/background.js   Practical eval: service worker (network, cache, token, search)
src/pe/search.js    the metric and the expectimax search (pure; tested in Node)
src/pe/rounds.js    deepens a position's rows in lockstep rounds (pure; tested in Node)
src/pe/providers.js Lichess explorer + ChessDB clients, rate limiter
src/pe/cache.js     IndexedDB cache with an in-memory LRU
src/vendor/chess.js chess.js 1.4.0, to play moves into child positions
src/popup.html/.css/.js
icons/              generated by icons/make_icons.py (stdlib only)
test/harness.js     node test/harness.js
test/pe.js          the Practical eval's pure tests, run by the harness
test/repgen.js      the repertoire generator's tests, run by the harness
test/pgnclean.js    pgnclean's tests, run by the harness
test/cdbexplore.js  cdbexplore's tests, run by the harness
test/explorerdb.js  explorerdb's tests, run by the harness
tools/repgen.mjs    the repertoire generator (Node; not part of the extension)
tools/pgnclean.mjs  finishes a repgen PGN: comments and transpositions
tools/cdbexplore.mjs deepens ChessDB's evals below a PGN's line ends and close decisions
tools/explorerdb.mjs builds a local opening explorer from a Lichess monthly dump
tools/repgen/       their plan, PGN reader/writers, file cache, root search adapter,
                    ChessDB exploration (explore.mjs) and Maia 3 (maia.mjs)
tools/explorerdb/   the dump reader and fast replay (games.mjs), shard counting and the
                    index file (store.mjs), the importer and its worker threads
tools/package.json  onnxruntime-node, for repgen --maia only
```
