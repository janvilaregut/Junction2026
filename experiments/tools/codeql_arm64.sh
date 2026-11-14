#!/bin/bash
# CodeQL C# on Apple Silicon without Rosetta 2.
#
# The CodeQL 2.27.4 bundle ships the C# extractor only as a self-contained osx-x64
# .NET 10 app ("Bad CPU type in executable" on an arm64 Mac without Rosetta). The
# extractor itself is managed code, so we copy the extractor pack, delete the bundled
# x64 runtime (native dylibs + framework assemblies), switch the runtimeconfig to a
# framework-dependent net10.0 app and replace the three apphosts by shell shims that
# call an arm64 .NET 10 runtime installed in the work area.
#
#   experiments/tools/codeql_arm64.sh setup
#   experiments/tools/codeql_arm64.sh analyze <source-dir> <db-dir> <out-dir>
set -euo pipefail
LAB=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$LAB/corpus/tools"
DIST=$(dirname "$(readlink -f "$(command -v codeql)")")
EXT="$WORK/codeql-arm64"
DN="$WORK/dotnet10"

case "${1:-}" in
setup)
  [ -x "$DN/dotnet" ] || bash "$HOME/.dotnet/dotnet-install.sh" --channel 10.0 --runtime dotnet \
      --install-dir "$DN" --architecture arm64 --no-path
  FW=$(ls -d "$DN"/shared/Microsoft.NETCore.App/10.* | tail -1)
  mkdir -p "$EXT"
  [ -e "$EXT/csharp" ] || cp -R "$DIST/csharp" "$EXT/csharp"
  T="$EXT/csharp/tools/osx64"
  for f in "${T:?}"/*.dll; do [ -f "${FW:?}/$(basename "$f")" ] && rm "$f"; done
  rm -f "${T:?}"/*.dylib "${T:?}"/createdump
  for app in Semmle.Autobuild.CSharp Semmle.Extraction.CSharp.Driver Semmle.Extraction.CSharp.Standalone; do
    printf '#!/bin/sh\nexec "%s" "$(dirname "$0")/%s.dll" "$@"\n' "$DN/dotnet" "$app" > "$T/$app"
    chmod +x "$T/$app"
    python3 - "$T/$app.runtimeconfig.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); ro = d["runtimeOptions"]
ro.pop("includedFrameworks", None)
ro["framework"] = {"name": "Microsoft.NETCore.App", "version": "10.0.0"}; ro["rollForward"] = "LatestMinor"
json.dump(d, open(p, "w"), indent=2)
EOF
    [ -f "$T/$app.deps.json" ] && mv "$T/$app.deps.json" "$T/$app.deps.json.orig"
  done
  codeql pack download --common-caches="$WORK/codeql-cache" codeql/csharp-queries
  codeql resolve extractor --language=csharp --search-path="$EXT"
  ;;
analyze)
  SRC=$2; DB=$3; OUT=$4
  mkdir -p "$OUT"
  export PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"
  { /usr/bin/time -l codeql database create "$DB" --language=csharp --build-mode=none --source-root="$SRC" \
      --search-path="$EXT" --common-caches="$WORK/codeql-cache" --overwrite --threads=0 ; } > "$OUT/codeql.create.log" 2>&1
  { /usr/bin/time -l codeql database analyze "$DB" codeql/csharp-queries:codeql-suites/csharp-security-and-quality.qls \
      --common-caches="$WORK/codeql-cache" --format=sarif-latest --output="$OUT/codeql.sarif" --threads=0 --ram=24000 ; } \
      > "$OUT/codeql.analyze.log" 2>&1
  ;;
*) echo "usage: $0 setup | analyze <src> <db> <out>"; exit 2;;
esac
