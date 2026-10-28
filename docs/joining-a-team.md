# Joining a team's cockpit

<!-- cockpit:verified version=0.0.0 -->

This guide is for a developer who has cloned a product that already commits `cockpit.toml` and
cockpit's generated files. It explains how to create only the machine-local state for the new
checkout and verify that the committed environment remains unchanged.

## Install the team's exact version

From the cockpit root, install the lockfile without changing it:

```sh
npm ci
```

The root `package.json` pins `@b0dea/cockpit` exactly because different cockpit versions can render
different guards and otherwise create repeated drift between teammates. `cockpit check` refuses a
different running version and prints the exact `npm install --save-dev --save-exact` command needed
to align it. Do not replace the pin with a range.

## Prepare this checkout

Run the committed scripts:

```sh
npm run cockpit:setup
npm run cockpit:sync
npm run cockpit:check
```

`setup` acquires or verifies declared sibling repositories. `sync` authenticates this checkout,
writes its machine identity under `.cockpit/local/`, and refreshes generated files from
`cockpit.toml`. Harness directory grants are stored relative to the cockpit root, so a clone in a
different directory does not rewrite them. Docker ownership values remain path-bound but enter
Compose only at execution; they are not committed.

For Codex, cockpit writes those relative grants to
`sandbox_workspace_write.writable_roots` with `sandbox_mode = "workspace-write"`. It does not
also publish a permission profile, because Codex gives the workspace-write settings precedence;
run `npm run cockpit:sync` after changing sibling declarations to regenerate the exact list.

The root `.gitignore` has a `cockpit:ignore` region for installed dependencies, machine-local
state, secret resolver material, and a sibling checkout directory that lives below the cockpit
root. `init` creates that region while preserving every line outside it. The first `sync` does the
same for a valid hand-written configuration whose compatible team metadata is missing. Later
`sync` and `check` authenticate the exact region and refuse an edited or stale one instead of
overwriting it; `sync --dry-run` reports missing metadata without writing it.
The sibling directory is escaped as a literal Git ignore path, so wildcard-shaped names do not
match nearby directories. A `siblings_root` containing a line break or NUL is refused before
metadata changes because `.gitignore` cannot represent it; choose a single-line path and rerun
`cockpit init`.

## Verify a clean join

After `check` succeeds, confirm that setup did not change team-owned bytes:

```sh
git status --short
```

The command should print nothing. If it reports generated drift, first confirm `npm ci` installed
the exact pinned version. If the `.gitignore` block alone is stale, restore the committed block.
To deliberately regenerate it after changing the configuration, remove the whole marked region,
run `cockpit init` for the team's existing target, review the replacement, and commit that team
change.
