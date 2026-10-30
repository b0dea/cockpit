#!/usr/bin/env bash
# Scope guard for the Version Packages pull request, run by CI when the pull request comes from the
# Changesets version branch. The release workflow builds that branch, and anyone who can push to it
# can add a commit a reviewer skims past as "the usual version bump". So the guard admits only what
# the version step writes: version fields in package.json files and package-lock.json, CHANGELOG.md
# files, and deleted changeset files. Anything else fails with the path that broke the rule.
#
# Usage: check-version-pr-scope.sh <base-commit> <head-commit>
# Must not: modify the checkout. It reads both commits through git only.
set -euo pipefail

base="${1:?usage: check-version-pr-scope.sh <base-commit> <head-commit>}"
head="${2:?usage: check-version-pr-scope.sh <base-commit> <head-commit>}"

# Prints nothing when the file differs between the commits only in version fields: a package
# manifest's `version`, or the `version` of a workspace entry (a lockfile key outside
# node_modules/). Prints the reason otherwise.
version_only() {
  # shellcheck disable=SC2016 # the single quotes hold JavaScript for node, not shell
  BASE="$base" HEAD="$head" FILE="$1" node -e '
    const { execFileSync } = require("node:child_process")
    const read = revision => JSON.parse(execFileSync("git", ["show", `${revision}:${process.env.FILE}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))
    const strip = value => {
      if (process.env.FILE.endsWith("package-lock.json")) {
        for (const [key, entry] of Object.entries(value.packages ?? {})) {
          if (!key.includes("node_modules/") && entry && typeof entry === "object") delete entry.version
        }
      } else delete value.version
      return JSON.stringify(value)
    }
    if (strip(read(process.env.BASE)) !== strip(read(process.env.HEAD))) {
      console.log("changes more than version fields")
    }
  '
}

failures=0
refuse() {
  echo "::error::$2: $1. The Version Packages pull request may change only version fields in package.json files and package-lock.json, CHANGELOG.md files, and delete .changeset/*.md files. Remove the change from the version branch, or make it in its own pull request."
  failures=$((failures + 1))
}

# Captured first so a failing diff (an unknown commit) stops the script instead of reading as empty.
changes="$(git diff --name-status --no-renames "$base" "$head")"
while IFS=$'\t' read -r status path; do
  [[ -n "$status" ]] || continue
  case "$status" in
    M)
      if [[ "$path" == package.json || "$path" == */package.json || "$path" == package-lock.json ]]; then
        reason="$(version_only "$path")"
        if [[ -n "$reason" ]]; then refuse "$reason" "$path"; fi
      elif [[ "$path" != CHANGELOG.md && "$path" != */CHANGELOG.md ]]; then
        refuse "modified" "$path"
      fi
      ;;
    A)
      if [[ "$path" != CHANGELOG.md && "$path" != */CHANGELOG.md ]]; then refuse "added" "$path"; fi
      ;;
    D)
      # Changeset files sit directly in .changeset/. Its README and config are not changesets.
      if [[ ! "$path" =~ ^\.changeset/[^/]+\.md$ || "$path" == .changeset/README.md ]]; then
        refuse "deleted" "$path"
      fi
      ;;
    *)
      refuse "changed with git status $status" "$path"
      ;;
  esac
done <<< "$changes"

if (( failures > 0 )); then
  echo "::error::$failures change(s) fall outside the Version Packages scope." >&2
  exit 1
fi
echo "Version Packages scope: only version fields, changelogs and consumed changesets changed."
