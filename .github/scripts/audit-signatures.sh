#!/usr/bin/env bash
# Verifies registry signatures and attestations of every installed package: catches a tampered or
# unsigned tarball that the lockfile integrity hash alone would accept.
#
# Runs the audit with a pinned npm rather than the one bundled with the runner's Node. Some registry
# edges answer a package's attestations with its provenance bundle only, and the pacote in npm before
# 11.11.0 then reports EMISSINGSIGNATUREKEY for every attempt on that edge (seen for a package whose
# publish attestation names a current registry key). Later pacote asks for a registry key only when a
# keyed attestation is present, and still verifies every bundle it receives.
set -euo pipefail

npm exec --yes --package=npm@11.21.1 -- npm audit signatures --prefer-online
