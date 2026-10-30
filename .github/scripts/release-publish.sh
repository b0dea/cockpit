#!/usr/bin/env bash
# Publish step of the release workflow. Run by changesets/action only when the Version
# Packages pull request has merged, so every pending changeset is already folded in.
#
# Owns: the private-package guard, the npm version guard, the source-revision stamp, and the
# handoff to `changeset publish`. Must not: write to the source commit (the stamp lives in the
# working tree only) or authenticate with a stored token (publishing is OIDC).
set -euo pipefail

manifest=packages/cockpit/package.json
revision="${GITHUB_SHA:?GITHUB_SHA is required: this script runs inside the release workflow}"

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::GITHUB_SHA is not a full 40-character commit id: $revision" >&2
  exit 1
fi

if [[ "$(node -p "require('./$manifest').private === true")" == true ]]; then
  echo "::notice::$manifest is private: true. Nothing was published. Set private to false (and run the one-time npm trusted publisher setup) to enable publishing."
  exit 0
fi

# npm trusted publishing needs npm 11.5.1 or newer. An older npm would fall through to a
# missing-token failure with a message that does not say why.
npm_version="$(npm --version)"
if ! node -e '
  const [a, b, c] = process.argv[1].split(".").map(Number)
  process.exit(a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1))) ? 0 : 1)
' "$npm_version"; then
  echo "::error::npm $npm_version cannot publish with trusted publishing; npm 11.5.1 or newer is required. Use a newer Node 24 release in .github/workflows/release.yml." >&2
  exit 1
fi

# Trusted publishing cannot create a package: npm accepts an OIDC publish only for a package
# that already exists and lists this workflow as its trusted publisher. Stop with that reason
# instead of failing later with an authentication error that does not give one.
package_name="$(node -p "require('./$manifest').name")"
if ! registry_error="$(npm view "$package_name" name 2>&1 >/dev/null)"; then
  if [[ "$registry_error" == *E404* ]]; then
    echo "::error::$package_name does not exist on npm yet, and trusted publishing cannot create it. Nothing was published. Follow 'First publication' in docs/contributing/releasing.md, then re-run this workflow." >&2
  else
    echo "::error::could not read $package_name from the npm registry, so nothing was published: $registry_error" >&2
  fi
  exit 1
fi

# Stamp the exact commit into the artifact manifest, as docs/release-policy.md requires. The
# checkout is discarded after the job, so the source commit is never modified.
REVISION="$revision" MANIFEST="$manifest" node -e '
  const { readFileSync, writeFileSync } = require("node:fs")
  const manifest = JSON.parse(readFileSync(process.env.MANIFEST, "utf8"))
  manifest.cockpitSourceRevision = process.env.REVISION
  writeFileSync(process.env.MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
'

# Verify the stamp the tarball will carry before anything is published.
stamped="$(node -p "require('./$manifest').cockpitSourceRevision")"
if [[ "$stamped" != "$revision" ]]; then
  echo "::error::cockpitSourceRevision is '$stamped' after stamping; expected $revision" >&2
  exit 1
fi

npx changeset publish
