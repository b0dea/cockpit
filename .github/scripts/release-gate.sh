#!/usr/bin/env bash
# The last check before npm, run by the release workflow on the commit about to publish. The
# required check on a pull request can be stale when it merges, since main may have moved, and an
# administrator can bypass it. So this reads what actually passed in pushes to the default branch:
# every test cell on this exact tree, or on the parent's tree when this commit changes only what the
# version step writes, and in both cases ci-ok on this tree, which holds the scope check, the package
# smoke, the anonymisation scan and test protection that the cells do not.
#
# Must not: modify the checkout. A failed or silent lookup refuses.
set -euo pipefail

scripts="$(cd "$(dirname "$0")" && pwd -P)"

passed() {
  [[ "$(node "$scripts/tested-tree.mjs" "$@" || true)" == none ]]
}

head="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"

# This commit's ci-ok comes from its own push run, which starts beside this workflow. A failed lookup
# stops the wait, and the checks below then refuse on missing evidence.
ci_running() {
  gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$head&event=push&per_page=100" \
    | node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(0, "utf8")).workflow_runs.some(run => run.status !== "completed") ? 0 : 1)'
}
while ci_running; do
  echo "release gate: waiting for CI on $head to finish."
  sleep 30
done
if passed "$head" "$tree" linux platforms ci-ok; then
  echo 'release gate: every test cell and ci-ok passed on this tree.'
  exit 0
fi
if bash "$scripts/check-version-pr-scope.sh" HEAD^1 HEAD >/dev/null 2>&1 \
  && passed "$(git rev-parse HEAD^1)" "$(git rev-parse 'HEAD^1^{tree}')" linux platforms \
  && passed "$head" "$tree" ci-ok; then
  echo "release gate: this commit changes only versions and changelogs, every test cell passed on its parent's tree, and ci-ok passed on this tree."
  exit 0
fi
echo "::error::Refusing to publish: ci-ok has not passed on this commit's tree, or not every test cell has passed on it, or on its parent's when it only moves the version. Wait for CI on this commit, re-run any failed or cancelled jobs, then re-run this workflow. See docs/contributing/releasing.md." >&2
exit 1
