#!/usr/bin/env bash
# These bytes are committed and identical on every clone. This machine's handler identity lives in
# the ignored file `cockpit sync` writes beside them; the application authenticates it before
# resolving policy, so a missing, foreign or stale file refuses every call.
set -fuo pipefail
config='__COCKPIT_GUARD_CONFIG__'
shell_arg() {
    case "$1" in
        ''|*[!A-Za-z0-9_./:@%+=,-]*)
            local value=$1 prefix
            printf "'"
            while [[ $value == *"'"* ]]; do
                prefix=${value%%\'*}
                printf "%s'\"'\"'" "$prefix"
                value=${value#*\'}
            done
            printf "%s'" "$value"
            ;;
        *) printf '%s' "$1" ;;
    esac
}
if [ "${1:-}" = '--handler-stdio' ]; then
    # The application runs a verified snapshot of this file from a private directory, so it passes
    # the checkout it has already authenticated instead of this file's location.
    root="${COCKPIT_GUARD_ROOT:?authenticated guard root is missing}"
else
    source_path="${BASH_SOURCE[0]:-}"
    case "$source_path" in
        */*) guards="${source_path%/*}" ;;
        *) guards=. ;;
    esac
    if ! root=$(cd -P -- "$guards/../.." && pwd -P); then
        config_arg=$(shell_arg "<checkout>/$config")
        printf 'cockpit guard: cannot resolve the cockpit checkout above %s, so every tool call is refused. Fix: run `cockpit sync --config %s` in a terminal, outside the agent.\n' "$guards" "$config_arg" >&2
        exit 2
    fi
fi
local_file="$root/.cockpit/local/guard-identity"
config_arg=$(shell_arg "$root/$config")
fix="Fix: run \`cockpit sync --config $config_arg\` in a terminal, outside the agent, then retry."
format='' node='' handler='' identity=''
if ! { IFS= read -r format && IFS= read -r node && IFS= read -r handler && IFS= read -r identity; } 2>/dev/null < "$local_file" \
    || [ "$format" != 'cockpit-guard-local/v1' ] || [ -z "$node" ] || [ -z "$handler" ] || [ -z "$identity" ]; then
    printf 'cockpit guard: %s is missing, unreadable or from another cockpit version. It records the Node executable and cockpit handler on this machine, which committed files cannot carry, so every tool call is refused until it exists. %s\n' "$local_file" "$fix" >&2
    exit 2
fi
if [ ! -x "$node" ] || [ ! -r "$handler" ]; then
    printf 'cockpit guard: the Node executable %s or cockpit handler %s recorded in %s is gone (Node or cockpit was moved or reinstalled), so every tool call is refused. %s\n' "$node" "$handler" "$local_file" "$fix" >&2
    exit 2
fi
export COCKPIT_GUARD_IDENTITY="$identity" COCKPIT_GUARD_ROOT="$root"
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
