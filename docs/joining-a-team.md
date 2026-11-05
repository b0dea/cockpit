# Joining a team's cockpit

You have cloned a cockpit a team already committed. You create this machine's local state, then
confirm the committed files did not change.

## Install the team's exact version

From the cockpit root, install the lockfile without changing it:

```sh
npm ci
```

The root `package.json` pins `@b00dea/cockpit` exactly, because different versions can render
different guards and teammates would keep reporting each other's output as drift. `cockpit check`
refuses a running version that differs from the pin and prints the command that realigns them. Do
not replace the pin with a range.

## Prepare this checkout

```sh
npm run cockpit:setup
npm run cockpit:sync
npm run cockpit:check
```

- `setup` clones or verifies the declared sibling repositories.
- `sync` checks this checkout, writes its machine identity under `.cockpit/local/`, and refreshes
  the generated files. Committed files do not depend on where you cloned.
- `check` confirms the generated files match `cockpit.toml`.

Two things stay per machine:

- **Codex hook trust.** See [Trust the Codex hook](harness-surfaces.md#trust-the-codex-hook).
- **Runtime measurements.** Each machine
  [measures its container runtime](environment.md#measure-the-container-runtime) once before its
  first `up`.

### The `cockpit:ignore` region

The root `.gitignore` has a marked `cockpit:ignore` region for installed dependencies, machine-local
state, secret resolver material, and any sibling checkout below the cockpit root. Its start marker
records a digest, so `sync` rewrites a region that sibling changes made stale but refuses one edited
by hand; `check` reports either without writing.

A sibling with `acquire = "none"` stays visible, so the cockpit can track local data, unless its
directory is a Git repository, which is ignored like a cloned checkout. Sibling directories are
written as literal ignore paths. A `siblings_root` containing a line break or NUL is refused,
because `.gitignore` cannot represent it.

## Verify a clean join

```sh
git status --short
```

It should print nothing. If it shows generated drift, confirm `npm ci` installed the exact pinned
version. If `sync` changed only the `.gitignore` block, a declared sibling differs on this machine:
a local repository with no remote is ignored only where it exists, because nothing can clone it
here. Discard the change with `git restore .gitignore`; the block settles once whoever created that
repository publishes it and records the remote with `sibling add <slug> --remote <url>`.
