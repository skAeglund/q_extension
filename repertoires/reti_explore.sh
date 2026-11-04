#!/bin/bash
# cdbexplore over the Reti study (repworks-data studies/0fD2MFez), one chapter at a time.
# Resumable: cdbexplore skips targets explored in the last 7 days, so just run it again.
# Progress (.explore.json/.log) is committed and pushed after every finished target.
cd "$(dirname "$0")/.."
BRANCH=claude/reti-study-cdbexplore-amk07g
CHAPTERS="reti_1_anti_kid reti_2_anti_c5 reti_3_anti_e6_qgd reti_4_anti_c6_london reti_5_from_maroczy reti_6_reti_accepted_e4 reti_7_1_nc6"
# The live files are marked skip-worktree between pushes, so a half-written log doesn't
# show as an uncommitted change.
live() { git ls-files repertoires | grep -E 'reti_.*\.explore\.(log|json)$'; }
push() {
  live | xargs -r git update-index --no-skip-worktree
  git add repertoires/reti_* >/dev/null 2>&1
  live | xargs -r git update-index --skip-worktree
  git diff --cached --quiet && { live | xargs -r git update-index --skip-worktree; return; }
  git commit -qm "cdbexplore Reti: $1" && for d in 2 4 8 16; do git push -q -u origin $BRANCH && break; sleep $d; done
}
for c in $CHAPTERS; do
  log=repertoires/$c.explore.log
  if grep -q "^.\{9\}Done:" $log 2>/dev/null && [ "$(grep -c 'Done:' $log)" -ge 1 ] && [ -e repertoires/$c.done ]; then continue; fi
  echo "CHAPTER $c start"
  node tools/cdbexplore.mjs $c.pgn --side white > repertoires/.$c.out 2>&1 &
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
