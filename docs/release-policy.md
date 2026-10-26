# Runtime, deprecation, and migration policy

<!-- cockpit:verified version=0.0.0 -->

This policy is for operators selecting or upgrading cockpit. It states the supported runtime and
the notice required before a public contract can be removed.

## Runtime support

The CLI requires Node.js 22 or newer. The development manifest and CI matrix declare Node 22.13.0,
24, and 26. Node 20 is a negative control that must fail with
[COCKPIT_NODE_VERSION_UNSUPPORTED](../packages/cockpit/bin/cockpit.mjs) before compiled CLI code
loads. Environment operations also require the declared local tools, such as Git
and Docker with Compose, to pass their current authenticated probes.

Cockpit supports the latest released minor. Older minors are deprecated when a new minor ships;
their presence in an old lockfile does not imply continuing fixes. Pin an exact version in each
consumer lockfile and review upgrades before applying generated changes.

The package is currently private at version `0.0.0`. No public registry availability, published
support window, provenance statement, or updater behavior is claimed until release evidence and
public readback exist.

## Publication readiness

Repository visibility and npm publication are separate operator decisions. Keep the package's
`private` guard until the internal trial and an explicit release decision are complete. A green
test run does not authorize either publication.

Before opening the repository, verify the exact source export and every Git ref that will be
published. The current tree, package tarball, and reachable history are different scan subjects:

```sh
npm run build
npm test
npm run typecheck
npm run lint:docs
npm run lint:supply-chain
node scripts/hygiene-scan.mjs --history
npm audit --ignore-scripts
```

Run the hygiene checks in a maintainer checkout with its private site-identifier list available.
A universal-only scan cannot establish that consumer names are absent. A history report with
findings, binary gaps, or exceeded bounds is not a clean result. If old history contains private
material, prepare a separately reviewed clean-root repository from the scanned source export;
do not copy the old Git directory, branches, tags, or ignored working files. Preserve the private
repository until the operator explicitly decides its disposition.

Before publishing a package, create the real tarball from an export of the exact source commit that
passed the checks above. The release packaging step must stamp that commit's full 40-character
hexadecimal Git object name into the artifact manifest's `cockpitSourceRevision` without modifying
the source commit, and must make no other unreviewed transformation. Verify the packed value before
publication. Retain the tarball's digest, dependency audit, and SBOM beside the release evidence. A
`development` revision is valid only for private development artifacts and is not release
provenance.

The supply-chain detector checks local inputs and reports the remaining external gates:
package-scope ownership, trusted publisher configuration, source-revision stamping, provenance
attestation, artifact attachment, superseded-minor deprecation, and dependency-update cooldown.
Those must be independently verified against the actual release, not inferred from configuration
files. The MIT license and bundled dependency notices must remain in the tarball.

The [private security reporting channel](../SECURITY.md#reporting-a-vulnerability) and
[private conduct contact](../CODE_OF_CONDUCT.md#enforcement) also need live receipt verification
before visibility changes. Record a clean-machine install and synthetic quickstart from the
exact export, plus dated native harness evidence. Before claiming the framework generalises,
complete real-use acceptance in three distinct cockpits: two established environments with
different shapes and one greenfield setup. Reaching that threshold does not publish anything;
repository visibility and package publication still require explicit operator decisions. After
an authorized publication, read back the public repository and installed package independently.

## Deprecation

A public command, option, configuration field, generated path, diagnostic contract, or extension
seam receives at least one minor release of warning before removal. The warning names the
replacement and the release in which removal can occur. Security fixes may refuse unsafe behavior
immediately, but still provide the safest actionable migration available.

The generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md),
[capability matrix](capability-matrix.md), and [Troubleshooting](troubleshooting.md) describe the
installed version. They are not promises that a later release preserves an item beyond this policy.

## Migration

Every breaking change ships a migration note for the operator performing the upgrade. It states
what changed, the observable failure or diagnostic, the exact replacement, and any rollback
boundary. When the edit is mechanical, the release includes a codemod or script; manual prose is
not a substitute.

Before publishing generated changes:

```sh
cockpit upgrade --config ./cockpit.toml \
  --release-evidence ./release-evidence.json \
  --release-evidence-sha256 EXPECTED_SHA256
cockpit sync --config ./cockpit.toml --dry-run
cockpit sync --config ./cockpit.toml
cockpit preflight --config ./cockpit.toml
```

`upgrade` is a read-only plan and fails closed without exact release evidence. Review changed
overlays, ownership, capability evidence, and operator actions before `sync`. Native harness,
vendor, clean-machine, and publication checks remain operator-held unless the release evidence
records those exact observations.

Release evidence is read from a stable regular file of at most 1 MiB; pipes and other special
files refuse without waiting for a writer. Release integrity values must contain canonical base64 SHA-256, SHA-384, or SHA-512 digests with
the matching byte length. Hexadecimal digests and truncated placeholders are refused even when
the surrounding evidence file has the expected hash.
