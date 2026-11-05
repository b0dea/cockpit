# Runtime, deprecation, and migration policy

Which runtimes are supported, how much notice a breaking change gets, and what a migration note
contains.

## Runtime support

The supported Node.js versions are in the `engines` field of the
[package manifest](../packages/cockpit/package.json). CI runs the full suite on Linux at the lowest
of them on every pull request. On what reaches main, before a release can merge, it runs the full
suite on macOS and a compatibility subset (launcher, package metadata and runtime probe tests) on
each other supported line. A weekly run tests the full suite at the newest. The launcher refuses
any other version with [COCKPIT_NODE_VERSION_UNSUPPORTED](../packages/cockpit/bin/cockpit.mjs)
before compiled code loads. Environment commands also need Git and, for the stack, Docker with
Compose.

Fixes land on the latest released minor only; older minors are deprecated when a new minor ships.
Pin an exact version in each consumer lockfile and review an upgrade before applying its generated
changes.

While the major version is 0, a minor release may carry a breaking change; it still ships a
migration note.

## Deprecation

A public command, option, configuration field, generated path, diagnostic contract or extension seam
gets at least one minor release of warning before removal. The warning names the replacement and the
release in which removal can happen. A security fix may refuse unsafe behaviour immediately, but
still provides the safest migration available.

Dropping a supported Node.js release line before its end of life is a major change.

The generated references describe the installed version only; they promise nothing about later
releases beyond this policy.

## Migration

Every breaking change ships a migration note in the [changelog](../packages/cockpit/CHANGELOG.md):
what changed, the observable failure or diagnostic, the exact replacement, and any rollback
boundary. When the edit is mechanical, the release includes a codemod or script rather than prose.

To upgrade, follow [Upgrade cockpit](harness-surfaces.md#upgrade-cockpit).
