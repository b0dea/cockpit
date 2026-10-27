# Changelog

<!-- cockpit:verified version=0.0.0 -->

What changed in each release, written for someone deciding whether to upgrade: what breaks,
what to do about it, and what is new.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public surface a major version
protects is the CLI's commands and flags, the <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema, the generated file
layout, and the overlay contract. Deprecation and migration rules are in the
[release policy](docs/release-policy.md).

## [Unreleased]

The initial public release. Nothing has been published yet, so there is nothing to upgrade
from; this entry describes what the first version contains.

### Added

- **Configuration.** A validated <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema for a product's sibling repositories,
  ports, guards, MCP servers, generated environment and work orders. Each sibling declares how
  the stack uses it (`mount`) and how it reaches disk (`acquire`) independently.
- **Bootstrap and adoption.** `init` previews and accepts a per-harness bootstrap with digest
  confirmation; `document` turns an existing shell registry into an attributed draft that marks
  every inferred value and gap; `registry-resolve` exposes a validated registry to shell scripts.
- **Generation and drift.** `sync` renders the Docker Compose stack, environment templates,
  decision log, personas and agent surfaces for Claude Code, Codex CLI and OpenCode as one
  recoverable transaction, with `--dry-run` and interactively approved stale removal. `check`
  reports drift without changing files, and a reusable GitHub Action runs it in CI.
- **Environment lifecycle.** `setup`, `up`, `session`, `sleep`, `down`, `reset`, `preflight`,
  `doctor`, `logs` and `baseline-record`, with port leases, co-tenant-safe holders, measured
  cold-start limits, optional per-service resource ceilings, and exact previews before
  destructive steps.
- **Guards and surfaces.** One guard policy for protected branches, environment and secret files,
  and declared hosted database and vendor hosts, translated per harness; overlays with hash-bound
  replacement; an MCP allowlist; a capability matrix that reports each feature as enforced,
  instructed or unavailable; and `selftest` for measuring them.
- **Work orders and grading.** Commands to take in, accept, execute, review and record work
  orders, and an independent evaluator that grades each acceptance criterion from verifier reruns.
- **Browser and test evidence.** Commands for driving declared browser surfaces, collecting
  accessibility observations and screenshots, and running declared product test gates.
- **Upgrade review.** `upgrade` produces a read-only plan from exact release evidence.
- **Repository standards.** Synthetic example and fixtures, anonymisation scan, packaging
  allow-list check, generated CLI and configuration references, documentation lint, and CI on
  macOS and Linux across Node 22.13, 24 and 26.

[Unreleased]: https://github.com/b0dea/cockpit/commits/main
