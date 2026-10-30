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
CURRENT_VERSION="$(node -p "require('./node_modules/@b0dea/cockpit/package.json').version")"
TARGET_VERSION="1.2.3"
mkdir -p .cockpit/releases/current .cockpit/releases/candidate
gh release download "@b0dea/cockpit@${CURRENT_VERSION}" \
  --pattern release-evidence.json.sha256 \
  --dir .cockpit/releases/current
gh release download "@b0dea/cockpit@${TARGET_VERSION}" \
  --pattern release-evidence.json.sha256 \
  --dir .cockpit/releases/candidate
cat .cockpit/releases/current/release-evidence.json.sha256
cat .cockpit/releases/candidate/release-evidence.json.sha256
CURRENT_RECORD_SHA256="REVIEWED_CURRENT_RECORD_SHA256"
CANDIDATE_RECORD_SHA256="REVIEWED_CANDIDATE_RECORD_SHA256"
gh release download "@b0dea/cockpit@${CURRENT_VERSION}" \
  --pattern release-evidence.json --dir .cockpit/releases/current
gh release download "@b0dea/cockpit@${TARGET_VERSION}" \
  --pattern release-evidence.json --dir .cockpit/releases/candidate
node ./node_modules/@b0dea/cockpit/libexec/release-evidence.mjs assemble \
  --current .cockpit/releases/current/release-evidence.json \
  --current-sha256 "$CURRENT_RECORD_SHA256" \
  --candidate .cockpit/releases/candidate/release-evidence.json \
  --candidate-sha256 "$CANDIDATE_RECORD_SHA256" \
  --output .cockpit/releases/release-evidence-pair.json
./node_modules/.bin/cockpit upgrade --config ./cockpit.toml \
  --release-evidence .cockpit/releases/release-evidence-pair.json \
  --release-evidence-sha256 "$(awk 'NR == 1 { print $1 }' .cockpit/releases/release-evidence-pair.json.sha256)"
./node_modules/.bin/cockpit sync --config ./cockpit.toml --dry-run
./node_modules/.bin/cockpit sync --config ./cockpit.toml
./node_modules/.bin/cockpit preflight --config ./cockpit.toml
```

`upgrade` is experimental and its interface may change before a stable release. It is a
read-only plan and refuses to run without the exact release-evidence file. Before `sync`, review the changed
overlays, ownership, capability states and any manual steps it lists.

Cockpit reads the release-evidence file only if it is a regular file of limited size that is not changing; pipes
and other special files are refused without waiting for a writer. The size limit is set in
[the release-evidence code](../packages/cockpit/src/upgrade/release-evidence.ts). Release integrity values must be
canonical base64 SHA-256, SHA-384, or SHA-512 digests of the matching length.
Hexadecimal digests and truncated placeholders are refused even when
the file containing them has the expected hash.

Every GitHub release attaches one `release-evidence.json` record and its SHA-256 file. The record
names that exact npm package version and registry integrity and hashes the core surface
declarations with the same constructor used during `sync`. Download the installed and candidate
records from their exact tags, review both SHA-256 files, then run the shipped offline assembler
as shown above. The assembler refuses changed bytes, linked or special-file inputs, mismatched
packages, invalid records, and an existing output instead of replacing it. Its paired output is
the only file `upgrade` accepts; a record for a single release is not enough.

The first public release carries only its own record because no earlier release
exists. It never invents a `current` release. Once a later release exists, combine any installed
release record with the chosen candidate record, so skipping intermediate versions does not weaken
the comparison.
