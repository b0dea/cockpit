# Runtime, deprecation, and migration policy

This page is for people choosing or upgrading cockpit: which runtimes are supported, how much
notice a breaking change gets, and what a migration note contains.

## Runtime support

The supported Node.js versions are the ones in the `engines` field of the
[package manifest](../packages/cockpit/package.json). The launcher refuses any other version with
[COCKPIT_NODE_VERSION_UNSUPPORTED](../packages/cockpit/bin/cockpit.mjs) before compiled code loads.
Environment commands also need Git and, for the stack, Docker with Compose; see the
[prerequisites](getting-started.md#install-cockpit).

CI tests that range:

- on every pull request, the full suite on Linux at the lowest supported version;
- on what reaches main, and before any release can merge, the full suite on macOS at the lowest
  supported version and a compatibility subset (launcher, package metadata and runtime probe tests)
  on Linux at each other supported line;
- weekly, the full suite on Linux at the newest supported line.

Fixes land on the latest released minor only; older minors are deprecated when a new minor ships.
Pin an exact version in each consumer lockfile and review an upgrade before applying its generated
changes.

The deprecation policy below applies to published releases. While the major version is 0, a
minor release may still carry a breaking change; it still ships a migration note.

## Deprecation

A public command, option, configuration field, generated path, diagnostic contract or extension
seam gets at least one minor release of warning before removal. The warning names the replacement
and the release in which removal can happen. A security fix may refuse unsafe behaviour
immediately, but still provides the safest migration available.

Dropping a supported Node.js release line before its end of life is a major change.

The generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md),
[capability matrix](capability-matrix.md) and [Troubleshooting](troubleshooting.md) describe the
installed version only; they promise nothing about later releases beyond this policy.

## Migration

Every breaking change ships a migration note in the [changelog](../packages/cockpit/CHANGELOG.md)
for whoever performs the upgrade: what changed, the observable failure or diagnostic, the exact
replacement, and any rollback boundary. When the edit is mechanical, the release includes a codemod
or script rather than prose.

To upgrade, run `npx --no cockpit upgrade --config cockpit.toml`: it moves the exact pin and applies
the regenerated files with `sync`, as [Upgrade cockpit](harness-surfaces.md#upgrade-cockpit) describes.
