#!/usr/bin/env bash
# What a release adds to code that already passed its tests: a tarball with a new version. Packs
# through the package's real prepack, installs that tarball outside the checkout and runs its CLI.
#
# Usage: package-smoke.sh [package directory]
# Must not: modify the checkout's tracked files.
set -euo pipefail

package="$(cd "${1:-packages/cockpit}" && pwd -P)"
name="$(node -p 'require(process.argv[1]).name' "$package/package.json")"
version="$(node -p 'require(process.argv[1]).version' "$package/package.json")"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

(cd "$package" && npm pack --pack-destination "$scratch" >/dev/null)
tarballs=("$scratch"/*.tgz)
if (( ${#tarballs[@]} != 1 )); then
  echo "::error::npm pack produced ${#tarballs[@]} tarballs, expected one" >&2
  exit 1
fi
mkdir "$scratch/consumer"
cd "$scratch/consumer"
npm install --ignore-scripts --no-audit --no-fund --no-package-lock "${tarballs[0]}" >/dev/null
reported="$("$scratch/consumer/node_modules/.bin/cockpit" --version)"
case "$reported" in
  "$name $version "*) echo "package smoke: $reported" ;;
  *)
    echo "::error::the installed CLI reported '$reported', expected $name $version" >&2
    exit 1
    ;;
esac
