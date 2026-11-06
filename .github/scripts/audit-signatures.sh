#!/usr/bin/env bash
# Verifies registry signatures and attestations of every installed package: catches a tampered or
# unsigned tarball that the lockfile integrity hash alone would accept.
#
# CI has seen one package report EMISSINGSIGNATUREKEY on a first attempt, then pass on the same
# lockfile; the registry serves that package's attestations with a known key, and the cause on the
# runner is unproven, so each retry records how that fetch was answered. Only that failure is retried, against fresh responses. A pass still verifies
# every package, and a key that is really missing fails every attempt. Each retry leaves a warning, so
# recurrences stay visible.
set -uo pipefail

for attempt in 1 2 3; do
  output=$(npm audit signatures --prefer-online 2>&1)
  status=$?
  printf '%s\n' "$output"
  if [[ $status -eq 0 ]]; then
    exit 0
  fi
  if [[ $output != *EMISSINGSIGNATUREKEY* || $attempt -eq 3 ]]; then
    exit "$status"
  fi
  echo "::warning title=npm audit signatures::EMISSINGSIGNATUREKEY on attempt $attempt; retrying"
  # The evidence the next occurrence needs: how npm's own log says that fetch was answered.
  spec=$(sed -nE 's/^npm error ([^ ]+@[^ ]+) has attestations.*/\1/p' <<<"$output" | head -n 1)
  log=$(sed -nE 's/.*complete log of this run can be found in: (.*)/\1/p' <<<"$output" | head -n 1)
  if [[ -n $spec && -f $log ]]; then
    # npm prints @scope/name but fetches @scope%2fname.
    grep -F -e "attestations/$spec" -e "attestations/${spec/\//%2f}" "$log" || echo "npm's log records no attestation fetch for $spec"
  fi
  sleep 30
done
