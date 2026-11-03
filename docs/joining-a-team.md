# Joining a team's cockpit

<!-- cockpit:verified version=0.0.0 -->

This guide is for a developer who has cloned a cockpit that a team already committed, with its
`cockpit.toml` and generated files. You create this machine's local state, then confirm that the
committed files did not change.

## Install the team's exact version

From the cockpit root, install the lockfile without changing it:

```sh
npm ci
```

The root `package.json` pins `@b0dea/cockpit` exactly, because different cockpit versions can render
different guards and teammates would keep reporting each other's output as drift. `cockpit check`
refuses a running version that differs from the pin and prints the
`npm install --save-dev --save-exact` command that realigns them. Do not replace the pin with a range.

## Prepare this checkout

Run the committed scripts:

```sh
npm run cockpit:setup
npm run cockpit:sync
npm run cockpit:check
```

- `setup` clones or verifies the declared sibling repositories.
- `sync` checks this checkout, writes its machine identity under `.cockpit/local/`, and refreshes
  the generated files from `cockpit.toml`. Committed files do not depend on where you cloned: harness
  directory grants are relative to the cockpit root, and Docker labels that carry the checkout
  path reach Compose only when a command runs.
- `check` confirms the generated files match `cockpit.toml`.

For Codex, the relative grants go to `sandbox_workspace_write.writable_roots` with
`sandbox_mode = "workspace-write"`, and cockpit publishes no separate permission profile because
Codex gives the workspace-write settings precedence. Run `npm run cockpit:sync` after changing
sibling declarations to regenerate the list.

Two things stay per machine:

- **Codex hook trust.** Codex silently skips a project hook nobody has trusted on that machine,
  and `check` reports `CODEX_HOOK_UNTRUSTED`, once Codex has run on the machine, until you
  [trust the Codex hook](harness-surfaces.md#trust-the-codex-hook).
- **Runtime measurements.** Each machine measures its own container runtime once before its first
  `up`; see [Measure the container runtime](environment.md#measure-the-container-runtime).

### The `cockpit:ignore` region

The root `.gitignore` has a marked `cockpit:ignore` region for installed dependencies,
machine-local state, secret resolver material, and any sibling checkout below the cockpit root.
`init`, or the first `sync` of a hand-written configuration, creates it and leaves every line
outside it alone. Its start marker records a digest, so `sync` rewrites a region that sibling
changes made stale but refuses one edited by hand; `check` reports either without writing.

A sibling with `acquire = "none"` stays visible, so the cockpit can track local data, unless its
directory is a Git repository (such as one `sibling add --create` made), which is ignored like a
cloned checkout. Sibling directories are written as literal ignore paths, so wildcard-shaped names
match nothing else. A `siblings_root` containing a line break or NUL is refused before anything
changes, because `.gitignore` cannot represent it.

## Verify a clean join

After `check` succeeds, confirm that setup did not change team-owned bytes:

```sh
git status --short
```

It should print nothing. If it shows generated drift, confirm `npm ci` installed the exact pinned
version. If `sync` changed only the `.gitignore` block, a declared sibling differs on this machine:
a local repository with no remote is ignored only where it exists, because nothing can clone it
here. Discard the change with `git restore .gitignore`; the block settles once whoever created that
repository publishes it and records the remote with `sibling add <slug> --remote <url>`.
