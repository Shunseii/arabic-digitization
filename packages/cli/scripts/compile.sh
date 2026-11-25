#!/bin/sh
# Compile corpus into standalone executables for every release target, plus a
# SHA-256 checksum file the installers verify downloads against.
#
#   packages/cli/scripts/compile.sh <version> [out-dir]
#
# <version> is what `corpus --version` prints (e.g. 0.6.0). Needs Bun and the
# workspace dependencies installed (pnpm install). out-dir defaults to
# packages/cli/dist.
set -eu

version=${1:?usage: compile.sh <version> [out-dir]}
cli_dir=$(cd "$(dirname "$0")/.." && pwd)
out=${2:-$cli_dir/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd)

# asset name:Bun target. The x64 builds use Bun's baseline variant so CPUs
# without AVX2 can run them.
targets="
corpus-linux-x64:bun-linux-x64-baseline
corpus-linux-arm64:bun-linux-arm64
corpus-darwin-x64:bun-darwin-x64-baseline
corpus-darwin-arm64:bun-darwin-arm64
corpus-windows-x64.exe:bun-windows-x64-baseline
"

assets=""
for entry in $targets; do
  asset=${entry%%:*}
  target=${entry#*:}
  echo "Building $asset ($target)"
  bun build "$cli_dir/src/main.ts" \
    --compile --minify \
    --target="$target" \
    --define "CORPUS_VERSION=\"$version\"" \
    --outfile "$out/$asset"
  assets="$assets $asset"
done

cd "$out"
# shellcheck disable=SC2086 # word splitting of the asset list is intended
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum $assets >corpus-checksums.txt
else
  shasum -a 256 $assets >corpus-checksums.txt
fi
cat corpus-checksums.txt
