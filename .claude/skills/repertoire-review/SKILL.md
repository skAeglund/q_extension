---
name: repertoire-review
description: Build or review a chess repertoire with deeprep (tools/deeprep.mjs) on the user's local explorer index - run `deeprep build`, go through its review file, look into flagged decisions with `deeprep moves`, write a decisions file, rebuild, and check the result on a holdout index with `deeprep eval`. Use when the user asks to make, check or improve a repertoire from their explorerdb index, or hands over a deeprep slice.
---

# Reviewing a deeprep repertoire

The scripts gather the numbers; your part is the decisions where the numbers alone don't
settle it. Work from the numbers the tools print, never from your own sense of the
position: say so when a decision rests on few games.

## The user's criteria, in order

1. A high score in the middlegames the repertoire leads to (the deep score; on a holdout,
   the score that counts).
2. No reliance on traps. A trap is fine, but the position must stay decent when the
   opponent doesn't fall for it: look at `sound` (the deep score over their replies that
   aren't blunders), the blunder share, and ChessDB's eval of the move.
3. A good practical evaluation: `Prac` (ChessDB's evals after their replies, weighed by
   how often people play them) and `ChessDB`.
4. Few great lines over many best ones. 56% by transposing into a position the repertoire
   already has beats 58% with a new move. Recurring moves and structures make it easier
   to learn, but count for less than 1-3.

## What you need

- The index: `explorer/<name>.xdb`, or a slice the user made on their machine and handed
  over, as in `node tools/deeprep.mjs slice lichess --moves "1.d4 c5 2.dxc5 e5" --out e5`.
  A slice answers like the whole index from its root, down to its plies and min games.
- A holdout if there is one: an index (or slice) of other months, never ones the index
  was built from. Without one, every score shares the choices' luck. Say so in the report.
- The line, the side, and anything the user said about style.

## Steps

1. Build: `node tools/deeprep.mjs build <index> --moves "<line>" --side <white|black>
   --out <name> [--holdout <index>] [--decisions repertoires/<name>.decisions.json]`.
   It asks ChessDB about thousands of positions. Answers are cached in
   `repertoires/repgen-cache.jsonl`, and the default rate (60 a minute) is the polite
   one, so leave it. `--no-chessdb` skips ChessDB, but then criteria 2 and 3 go unchecked.
2. Read `repertoires/<name>.review.md`. Start with the flagged decisions, most reached
   first. Low-reach ones matter less to the score, but they are just as many positions
   to learn.
3. For each one, look closer before deciding:
   - `node tools/deeprep.mjs moves <index> --moves "<line>" --side <side>` gives the table
     for that position. Add `--plies 16` to look further, or `--prior 0` to see the
     unshrunk deep scores.
   - A move whose lead rests on a few hundred games, or that the holdout column doesn't
     back, is probably luck.
   - `trap`: is the sound value still decent, compared with the other moves'?
   - `learn`: the builder gave up score for fewer positions. Check that the gap is small
     and the shared line is real (the PGN says "transposes to").
   - `engine` / `limit`: ChessDB thinks less of the move than the games do. Inside the
     loss limit that is the point of practical play. Ask whether the refutation is one
     people would find (its share of games in the `moves` table).
4. Write the decisions where you differ, or confirm a close call, in
   `repertoires/<name>.decisions.json`, with the reason:
   `{ "1. d4 c5 2. dxc5 e5 3. e4 Bxc5 4. Nc3 Nf6 5. Bg5": { "play": "Nc6", "why": "..." } }`
   or `{ "...": { "avoid": ["Qb6"], "why": "..." } }`. Keys are the review's lines, as
   they appear in it.
5. Rebuild with `--decisions`, and compare: `node tools/deeprep.mjs eval <holdout>
   repertoires/<name>.pgn` before and after. A change that costs holdout score should be
   one criteria 2-4 call for. Say what it cost.
6. Report to the user: the score on the holdout against everyone's, how many positions
   to know, the decisions you made and why (one line each), and what you left to them.

## Don't

- Don't change the index, the cache, or another run's files.
- Don't raise ChessDB's rate, or tune settings until a holdout score looks good: that
  overfits the holdout too. Change a setting for a reason the user gave.
- Don't treat a deep score as a prediction without saying how many games it rests on.
