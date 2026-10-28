# Runtime, deprecation, and migration policy

<!-- cockpit:verified version=0.0.0 -->

This policy is for people choosing or upgrading cockpit: which runtimes are supported, how much
notice a breaking change gets, and what a migration note contains.

## Runtime support

cockpit supports the Node.js versions listed in
[Getting started](getting-started.md#install-cockpit), the range CI tests on macOS and
Linux. The launcher refuses unsupported Node versions with
[COCKPIT_NODE_VERSION_UNSUPPORTED](../packages/cockpit/bin/cockpit.mjs) before any compiled code
loads. Environment commands also need Git and, for the stack, Docker with Compose; see the
[prerequisites](getting-started.md#install-cockpit) for the current Docker runtime requirement.

Fixes land on the latest released minor only. Older minors are deprecated when a new minor
ships, so pin an exact version in each consumer lockfile and review an upgrade before applying
its generated changes.

Nothing is published yet. The development version is `0.0.0`, and the package stays private on
the main development branch until a separate release branch deliberately prepares publication.
Before the first public release, obsolete commands, paths and fields are removed without
compatibility code or a migration promise. The policy below starts with published contracts;
while the package remains pre-1.0, a minor release may still carry a breaking change.

## Deprecation

A public command, option, configuration field, generated path, diagnostic contract, or extension
seam receives at least one minor release of warning before removal. The warning names the
replacement and the release in which removal can occur. Security fixes may refuse unsafe behavior
immediately, but still provide the safest actionable migration available.

Dropping a supported Node.js release line that has not reached end of life is a major change.

The generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md),
[capability matrix](capability-matrix.md), and [Troubleshooting](troubleshooting.md) describe the
installed version. They are not promises that a later release preserves an item beyond this policy.

## Migration

Every breaking change ships a migration note for the person performing the upgrade. It states
what changed, the observable failure or diagnostic, the exact replacement, and any rollback
boundary. When the edit is mechanical, the release includes a codemod or script; manual prose is
not a substitute.

Before publishing generated changes:

```sh
./node_modules/.bin/cockpit upgrade --config ./cockpit.toml \
  --release-evidence ./release-evidence.json \
  --release-evidence-sha256 EXPECTED_SHA256
./node_modules/.bin/cockpit sync --config ./cockpit.toml --dry-run
./node_modules/.bin/cockpit sync --config ./cockpit.toml
./node_modules/.bin/cockpit preflight --config ./cockpit.toml
```

`upgrade` is experimental and its interface may change before a stable release. It is a
read-only plan and fails closed without exact release evidence. Review changed
overlays, ownership, capability evidence and any manual steps it lists before `sync`.

Release evidence is read from a size-bounded stable regular file; pipes and other special files
refuse without waiting for a writer. The [release-evidence owner](../packages/cockpit/src/upgrade/release-evidence.ts)
defines the current input bound. Release integrity values must contain canonical base64 SHA-256, SHA-384, or SHA-512 digests with
the matching byte length. Hexadecimal digests and truncated placeholders are refused even when
the surrounding evidence file has the expected hash.
