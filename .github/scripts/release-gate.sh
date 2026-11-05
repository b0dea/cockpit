#!/usr/bin/env bash
# The last check before npm, run by the release workflow on the commit about to publish. The
# required check on a pull request can be stale when it merges, since main may have moved, and an
# administrator can bypass it. So this reads what actually passed: every test cell on this exact
# tree, or on the parent's tree when this commit changes only what the version step writes.
#
# Must not: modify the checkout. A failed or silent lookup refuses.
set -euo pipefail

scripts="$(cd "$(dirname "$0")" && pwd -P)"

tree_passed() {
  [[ "$(node "$scripts/tested-tree.mjs" "$1" "$2" || true)" == none ]]
}

if tree_passed "$(git rev-parse HEAD)" "$(git rev-parse 'HEAD^{tree}')"; then
  echo 'release gate: every test cell passed on this tree.'
  exit 0
fi
if bash "$scripts/check-version-pr-scope.sh" HEAD^1 HEAD >/dev/null 2>&1 \
  && tree_passed "$(git rev-parse HEAD^1)" "$(git rev-parse 'HEAD^1^{tree}')"; then
  echo "release gate: this commit changes only versions and changelogs, and every test cell passed on its parent's tree."
  exit 0
fi
echo "::error::Refusing to publish: not every test cell has passed on this commit's tree, or on its parent's when it only moves the version. Wait for CI on this commit, re-run any failed or cancelled cells, then re-run this workflow. See docs/contributing/releasing.md." >&2
exit 1
