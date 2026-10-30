#!/usr/bin/env bash
# Version step of the release workflow. changesets/action runs it to build the Version Packages
# pull request from the pending changesets.
#
# Owns: applying the changesets and recording the new workspace version in package-lock.json.
# Must not: download packages or run their scripts (the lockfile update resolves metadata only).
set -euo pipefail

npx changeset version

# `changeset version` edits package.json only. Without this the lockfile keeps the previous
# workspace version, and the supply-chain check refuses the pull request as a stale lockfile.
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
