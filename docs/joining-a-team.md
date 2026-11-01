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

`setup` acquires or verifies declared sibling repositories. `sync` checks this checkout,
writes its machine identity under `.cockpit/local/`, and refreshes generated files from
`cockpit.toml`. Harness directory grants are stored relative to the cockpit root, so a clone in a
different directory does not rewrite them. The Docker label values that depend on the checkout path enter
Compose only when a command runs; they are not committed.

If you use Codex, trust its guard hook once on this machine: Codex silently skips a project hook
nobody has trusted, and `check` reports `CODEX_HOOK_UNTRUSTED` until you do. Follow
[Trust the Codex hook](harness-surfaces.md#trust-the-codex-hook).

Runtime measurements are not committed either: each machine measures its own container runtime
once before its first `up`, as described in
[Measure the container runtime](environment.md#measure-the-container-runtime).

For Codex, cockpit writes those relative grants to
`sandbox_workspace_write.writable_roots` with `sandbox_mode = "workspace-write"`. It does not
also publish a permission profile, because Codex gives the workspace-write settings precedence;
run `npm run cockpit:sync` after changing sibling declarations to regenerate the exact list.

The root `.gitignore` has a `cockpit:ignore` region for installed dependencies, machine-local
state, secret resolver material, and a sibling checkout directory that lives below the cockpit
root. `init` creates that region while preserving every line outside it. The first `sync` does the
same for a valid hand-written configuration whose compatible team metadata is missing. The start
marker records a digest of the region, so a later `sync` rewrites a region that changed sibling
declarations made stale and refuses one edited by hand instead of overwriting it; `check` reports
either without writing, and `sync --dry-run` lists the write. A sibling with `acquire = "none"`
stays visible so the cockpit can track local data, unless its directory is a Git repository, such
as one `sibling add --create` made: that directory is ignored like a cloned checkout.
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
the exact pinned version. If `sync` changed only the `.gitignore` block, a declared sibling
directory differs on this machine: a local repository without a remote is ignored only where it
exists, because nothing can clone it here. Discard that change with `git restore .gitignore`; the
block settles once whoever created the repository publishes it and records the remote with
`sibling add <slug> --remote <url>`.
