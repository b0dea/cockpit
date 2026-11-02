# Runtime, deprecation, and migration policy

<!-- cockpit:verified version=0.0.0 -->

This page is for people choosing or upgrading cockpit: which runtimes are supported, how much
notice a breaking change gets, and what a migration note contains.

## Runtime support

The supported Node.js versions are the ones in the `engines` field of the
[package manifest](../packages/cockpit/package.json). The launcher refuses any other version with
[COCKPIT_NODE_VERSION_UNSUPPORTED](../packages/cockpit/bin/cockpit.mjs) before compiled code loads.
Environment commands also need Git and, for the stack, Docker with Compose; see the
[prerequisites](getting-started.md#install-cockpit).

CI tests that range:

- on every merge to main, the full suite on macOS and Linux at the lowest supported version, and a
  compatibility subset (launcher, package metadata and runtime probe tests) on Linux at each other
  supported line;
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

Every GitHub release attaches one `release-evidence.json` record and its SHA-256 file. The record
names that exact npm package version and registry integrity, and hashes the core surface
declarations with the same constructor `sync` uses. To review an upgrade, download the installed
and candidate records from their exact tags, review both SHA-256 files, pair the records with the
shipped offline assembler, and only then plan and apply:

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

`upgrade` is experimental. It is a read-only plan, and it accepts only the paired file the
assembler writes; a record for a single release is not enough. Before `sync`, review the changed
overlays, ownership, capability states and any manual steps it lists;
[Review an upgrade](harness-surfaces.md#review-an-upgrade) explains what the plan reports.

The assembler refuses changed bytes, linked or special-file inputs, mismatched packages, invalid
records, and an existing output instead of replacing it. Combining the installed record directly
with the candidate means skipping intermediate versions does not weaken the comparison. The first
public release carries only its own record; there is no earlier `current` release to pair it with.

Cockpit reads the release-evidence file only if it is a regular file, not changing, and within the
size limit set in [the release-evidence code](../packages/cockpit/src/upgrade/release-evidence.ts);
pipes and other special files are refused without waiting for a writer. Integrity values must be
canonical base64 SHA-256, SHA-384 or SHA-512 digests of the matching length. Hexadecimal digests
and truncated placeholders are refused even when the file holding them has the expected hash.
