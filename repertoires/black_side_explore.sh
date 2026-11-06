#!/bin/bash
# cdbexplore over the Black sidelines (Nf3, c4, f4...) study (repworks-data studies/1zlp6bMw), one chapter at a time.
# Resumable: cdbexplore skips targets explored in the last 7 days, so just run it again.
# Progress (.explore.json/.log) is committed and pushed after every finished target.
# CHAPTERS="black_side_3_f4 ..." limits it to some chapters; BRANCH defaults to the checked-out one.
cd "$(dirname "$0")/.."
BRANCH=${BRANCH:-$(git branch --show-current)}
CHAPTERS=${CHAPTERS:-"black_side_1_nf3 black_side_2_c4 black_side_3_f4 black_side_4_g4 black_side_5_b4 black_side_6_g3"}
# The live files are marked skip-worktree between pushes, so a half-written log doesn't
# show as an uncommitted change.
live() { git ls-files repertoires | grep -E 'black_side_.*\.explore\.(log|json)$'; }
push() {
  live | xargs -r git update-index --no-skip-worktree
  git add repertoires/black_side_* >/dev/null 2>&1
  live | xargs -r git update-index --skip-worktree
  git diff --cached --quiet && { live | xargs -r git update-index --skip-worktree; return; }
  git commit -qm "cdbexplore Black sidelines: $1" && for d in 2 4 8 16; do git push -q -u origin $BRANCH && break; sleep $d; done
}
for c in $CHAPTERS; do
  log=repertoires/$c.explore.log
  if grep -q "^.\{9\}Done:" $log 2>/dev/null && [ "$(grep -c 'Done:' $log)" -ge 1 ] && [ -e repertoires/$c.done ]; then continue; fi
  echo "CHAPTER $c start"
  node tools/cdbexplore.mjs $c.pgn --side black > repertoires/.$c.out 2>&1 &
  pid=$!; n=0
  while kill -0 $pid 2>/dev/null; do
    sleep 30
    m=$(grep -c "stopped\|stable after\|time after\| after .*requests" $log 2>/dev/null)
    if [ "$m" != "$n" ]; then n=$m; echo "TARGET $c $(grep -E 'Exploring [0-9]+/' $log | tail -1 | grep -oE '[0-9]+/[0-9]+') $(grep -E ' after [0-9]+m' $log | tail -1 | sed 's/^ *//' | cut -c1-160)"; push "$c progress"; fi
  done
  wait $pid; rc=$?
  if [ $rc -eq 0 ] && tail -40 $log | grep -q "Done:"; then touch repertoires/$c.done; push "$c done"; echo "CHAPTER $c done"; else push "$c interrupted"; echo "CHAPTER $c FAILED rc=$rc: $(tail -3 repertoires/.$c.out)"; exit 1; fi
done
echo "ALL DONE"
