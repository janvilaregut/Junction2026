#!/bin/bash
# Normalise every output folder produced by run_tools.py / codeql_arm64.sh.
cd "$(dirname "$0")/../.."
N="python3 experiments/tools/normalise.py"
$N out/tools/base --root corpus/tools/refs/base > /dev/null
for b in 2129 2234 2283 2297; do
  r=ju26-issue-$b
  [ -d out/tools/$r ] && $N out/tools/$r --root corpus/tools/refs/$r > /dev/null
  [ -d out/tools/$r/changed-only ] && $N out/tools/$r/changed-only --root corpus/tools/refs/$r-changed > /dev/null
done
[ -d out/tools/seeded ] && $N out/tools/seeded --root corpus/tools/seeded > /dev/null
for d in out/tools/e5/*/; do s=$(basename "$d"); $N "$d" --root corpus/tools/e5/$s > /dev/null; done
echo normalised
