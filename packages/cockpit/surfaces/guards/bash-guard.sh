#!/usr/bin/env bash
# The application authenticates these generated identities before resolving policy.
set -fuo pipefail
export COCKPIT_GUARD_IDENTITY='__COCKPIT_GUARD_IDENTITY__'
node='__COCKPIT_GUARD_NODE__'
handler='__COCKPIT_GUARD_MODULE__'
if [ -z "$node" ] || [ -z "$handler" ] || [ ! -x "$node" ] || [ ! -r "$handler" ]; then
    printf 'cockpit guard: authenticated handler unavailable\n' >&2
    exit 2
fi
# Ambient Node options can execute code before the authenticated application starts.
unset NODE_OPTIONS NODE_PATH
if [ "${1:-}" = '--handler-stdio' ]; then
    shift
    unset COCKPIT_GUARD_TRANSPORT
    printf '%s' "${COCKPIT_GUARD_STDIN:?bounded transport input is missing}" | "$node" "$handler" guard-evaluate "$@"
    exit $?
fi
export COCKPIT_GUARD_TRANSPORT=1
exec "$node" "$handler" guard-evaluate "$@"
