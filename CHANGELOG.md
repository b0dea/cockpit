# Changelog

<!-- cockpit:verified version=0.0.0 -->

What changed, written for someone deciding whether to upgrade: what breaks, what to do about
it, and what is merely new.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public surface — the
part a major version protects — is the CLI's commands and flags, the <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema, the
layout of generated files, and the overlay contract. Anything else may move in a patch.

Cockpit supports the latest released minor. A public surface receives at least one minor release
of deprecation warning before removal. Every breaking change includes a migration note describing
the symptom and exact replacement; when the edit is mechanical, the release includes a codemod or
script. Dropping a supported non-EOL Node.js LTS line is a semver-major change.

## [Unreleased]

Pre-release. Nothing has been published to a registry, the package sits at `0.0.0`, and there
is no version to upgrade from yet. Until the first release, the entries below describe what
exists in the repository rather than what shipped.

### Added

- <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema. A sibling repository is described on two independent axes: `mount`,
  how the stack uses the checkout, and `acquire`, how the checkout reaches the disk. Neither is
  derived from the other, because collapsing them produces a preflight that reports healthy
  while the stack mounts the wrong thing, or nothing.
- A registry reader for `document`. It reads supported shell registry dialects and round-trips them through <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` without losing meaning.
  Every field it could not read directly carries a provenance and the reason it was inferred,
  and anything it could not answer is emitted as a commented gap rather than a plausible
  placeholder.
- `setup` acquires and wires declared sibling repositories from an explicit configuration.
- Environment lifecycle, health, logs, and baseline commands. Reset and baseline recording
  require an exact in-process operator confirmation for interactive mutation.
- `sync` renders stack files and harness surfaces from the resolved configuration; `check`
  detects generated drift, and `selftest` authenticates measured harness evidence.
- Shipped surface templates under `packages/cockpit/surfaces/` — what cockpit renders into a
  user's cockpit, separate from repository-maintenance instructions.
- An anonymisation scan for the working tree, staged index, and reachable Git history.
- A packaging check that asserts the real `npm pack` output against the `files` allow-list.
- Continuous integration on pull requests and `main`: tests and typecheck on macOS and Linux
  across the supported Node versions, with the anonymisation scan as its own job so a red build
  distinguishes a leaked tree from a failed test.
- Repository standards: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CODEOWNERS`,
  issue forms and a pull request checklist.

### Fixed

- Authenticated reads batch up to 64 small files while preserving byte, path, and receipt bounds.
  Temporary execution handoffs avoid unnecessary durability flushes; publication and recovery
  records retain their durability guarantees.

- Generation refuses sibling paths escaping the declared root, including filesystem-link escapes.
- Vendor templates target the authenticated sibling directory; targets outside the publication root
  refuse instead of writing to a local lookalike. The synthetic quickstart generates and tracks
  managed templates before setup.
- Greenfield configuration binds sibling directories to the observed estate and attributes its
  inferred root explicitly before confirmation.
- Configuration, registry, and adoption ingestion refuse oversized or unstable input before parsing.
- Comparison revalidates the source subject at every command boundary, including final teardown.
- Legacy harness evidence enforces bounded files, manifests, events, and arguments.
- Work-order identities reject malformed and null Git object IDs; changed-test selection accepts
  exact SHA-1 and SHA-256 commit IDs.
- Concurrent work admission ignores transient changes inside excluded coordination directories
  while still refusing changes to included source paths, Git metadata, or file contents.

- The launcher accepts bounded `logs --follow` collection. Cancellation returns exit 130 and
  retains authenticated, redacted records after the process group stops. Log tail limits now
  match at the command, application, and planning boundaries.
- Destructive resource inspection limits concurrent Docker clients across resource kinds and
  waits for outstanding inspections before reporting a failed observation.
- Upgrade evidence rejects truncated or incorrectly encoded release integrity digests.
  Supply canonical base64 for the declared SHA algorithm instead of hexadecimal placeholders.
- New work-order identities are reserved across local branches and linked worktrees before
  intake or programme mint publishes a contract. Existing work-order operations keep their
  checkout-local locking.
- Dependency and generator updates retain exact warning, bundle, schema, and package checks.
  Source installs explicitly disable dependency lifecycle scripts; packaging still runs its
  verification hooks. Development tooling requires Node 22.13, 24, or 26.

- `document` refuses invalid UTF-8 and repeated input/output options instead of silently
  changing source content or choosing the last path.
- Registry arrays accept comments after their closing delimiter while still rejecting
  executable trailing syntax.
- `registry-resolve` refuses sibling roots that would corrupt its delimited shell records.
- Documented defaults and their provenance now derive from the runtime schema.
- Test discovery stays within the current checkout's packages, excluding nested worktrees.

[Unreleased]: https://github.com/b0dea/cockpit/commits/main
