#!/bin/sh
# Measures an app directory's lint without and with designguard, in one capped container at a time:
#   audit/memory.sh <app> <dir> [memory, default 2g] [name]
# The app lives in the Docker volume dg-<app>, cloned at /work/app with its dependencies installed. With a name, the
# designguard run's findings go to audit/out/<name>.json and its handlers' verdicts to audit/out/<name>-explain.jsonl.
# RUNS=1 skips the run without designguard.
app=$1; dir=$2; memory=${3:-2g}; name=$4
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/out"
heap=$(( $(echo "$memory" | tr -d g) * 1024 * 85 / 100 ))
for dg in ${RUNS:-0 1}; do
  out=; explain=; [ "$dg" = 1 ] && [ -n "$name" ] && out=/out/$name.json && explain=/out/$name-explain.jsonl
  rm -f "$here/out/$name-explain.jsonl"
  docker run --rm --memory "$memory" --memory-swap "$memory" -v "dg-$app:/work" -v "$here:/audit:ro" -v "$here/out:/out" -w /work/app \
    -e DG=$dg -e OUT=$out -e DESIGNGUARD_EXPLAIN=$explain dg-tsaudit \
    sh -c "cp /audit/eslint.audit.mjs . && node --expose-gc --max-old-space-size=$heap /audit/memory.mjs $dir 2>/tmp/err || { echo \"{\\\"dir\\\": \\\"$dir\\\", \\\"designguard\\\": $dg, \\\"failed\\\": \\\"\$(grep -m1 -oE 'heap out of memory|Error: .*' /tmp/err)\\\"}\"; }"
done
