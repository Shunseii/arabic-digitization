#!/bin/sh
# Set every workspace package.json to one version before tagging a release:
#   scripts/set-version.sh 0.6.5
# (apps/mobile/app.json keeps its own version: it is the OTA runtime version.)
set -eu
version="${1:?usage: scripts/set-version.sh <major.minor.patch>}"
echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
  echo "not a version: $version" >&2
  exit 1
}
cd "$(dirname "$0")/.."
for f in package.json apps/*/package.json packages/*/package.json; do
  node -e "const f=process.argv[1],p=JSON.parse(require('fs').readFileSync(f,'utf8'));p.version=process.argv[2];require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$f" "$version"
done
echo "Set version $version in: $(ls package.json apps/*/package.json packages/*/package.json | tr '\n' ' ')"
