# cockpit

<!-- cockpit:verified version=0.0.0 -->

cockpit boots one product from several working repositories and gives supported agent tools the
same generated environment, instructions, controls, and verification entrypoints.

Spec and workflow tools describe work. Cockpit owns the environment where that work runs: sibling
checkouts, local services, generated harness surfaces, lifecycle state, browser access, and bounded
grading. It contains none of the product code and is not a sandbox.

Its current environment loop provides:

- authenticated setup, generated publication, bring-up, health evidence, logs, sleep, and exact
  reset previews across a multi-repository product;
- a foreground `session` command that holds one exact lifecycle owner while an agent command runs,
  then uses the normal co-tenant-safe sleep path after that process group is confirmed stopped;
- measured machine admission, optional provenance-bearing service and browser CPU/memory ceilings,
  and an enforced cold-start limit reported for services actually started by the invocation;
- an owned ignore boundary for central encrypted/provider secret sources, recursive mutation and
  staging guards, and optional product-owned Varlock adoption;
- generated agent guidance for targeted behavioral verification, security-review routing, and
  provider-neutral authenticated test fixtures with an optional Clerk starter. These procedures
  are instructions; they do not claim native harness enforcement or a live identity-provider test.

## Status and installation

Pre-alpha. The package remains private at `0.0.0`; no public registry install or release is claimed.
The current installation path is a source checkout with Node.js 22.13 or newer on a supported release line (22, 24, or 26):

```sh
git clone https://github.com/b0dea/cockpit.git
cd cockpit
npm ci --ignore-scripts
npm run build
```

This README will name the public package-install command only after publication is independently
verified.

## 60-second synthetic quickstart

Validate the checked-in comparison fixture without credentials, Docker, or a product checkout:

```sh
node packages/cockpit/bin/cockpit.mjs compare validate \
  --fixture fixtures/comparison/command-set.json \
  --json
```

This exercises the installed CLI and a synthetic input. It does not prove a native harness loaded
generated controls or that a real product can start on this machine. Literal clean-machine
execution remains operator-held evidence until a dated run is recorded.

## Start here

- [CLI reference](docs/cli-reference.md) — generated commands, flags, and exits.
- [Environment](docs/environment.md) — lifecycle, ownership, bring-up, and recovery.
- [Harness extension seam](docs/harness-surfaces.md#ownership-and-extension) — overlays and generated ownership.
- [Troubleshooting](docs/troubleshooting.md) — generated diagnostics and remedies.
- [Contribution verification](CONTRIBUTING.md#verification) — local tests and acceptance boundaries.
- [Repository owners](.github/CODEOWNERS) — review routing and its limits.

The durable user guides begin at [Getting started](docs/getting-started.md). Generated references
derive from command and schema owners, so this README does not duplicate their tables.

For an initialized product checkout, the low-ceremony owned lifetime is:

```sh
cockpit session --config ./cockpit.toml -- your-agent-command
```

That command runs `up`, keeps the exact holder for the foreground command, and calls the canonical
`sleep` lifecycle afterward. Use standalone `up` only when the environment should remain running
beyond one foreground command. See [Environment](docs/environment.md) for ownership, resource,
cold-start, and cleanup semantics.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/cockpit` | CLI, schema, environment owners, and shipped surface templates |
| `fixtures` | Synthetic registries, estates, probes, and comparison inputs |
| `docs` | User, operator, and contributor documentation |

Only `packages/cockpit/surfaces/` contains templates rendered into a consumer checkout.
Read [Contributing](CONTRIBUTING.md) before changing this repository.

## Project policies

- [Security](SECURITY.md) — support, disclosure, and the pending private-reporting gate.
- [Code of Conduct](CODE_OF_CONDUCT.md) — community standards and named contact.
- [Changelog](CHANGELOG.md) — release-facing changes and migration policy.
- [MIT License](LICENSE).
