#!/usr/bin/env bash
# These bytes are committed and identical on every clone. This machine's handler identity lives in
# the ignored file `cockpit sync` writes beside them; the application authenticates it before
# resolving policy, so a missing, foreign or stale file refuses every guarded call.
set -fuo pipefail
config='__COCKPIT_GUARD_CONFIG__'
__COCKPIT_GUARD_RECOVERY__
source_path="${BASH_SOURCE[0]:-}"
case "$source_path" in
    */*) guards="${source_path%/*}" ;;
    *) guards=. ;;
esac
# The hook's check passes the root it verified, which a linked directory cannot move.
if [ -n "${COCKPIT_GUARD_CHECKED_ROOT:-}" ]; then
    root=$COCKPIT_GUARD_CHECKED_ROOT
elif ! root=$(cd -P -- "$guards/../.." && pwd -P); then
    printf 'cockpit guard: cannot resolve the cockpit checkout above %s, so shell commands, file edits and writes, and restricted MCP tools under Claude Code are refused. ' "$guards" >&2
    cockpit_guard_recovery '' "$config"
    exit 2
fi
local_file="$root/.cockpit/local/guard-identity"
# A checked run is handed the identity text the hook's check hashed, and never reads the file again: one
# created after the check would be unchecked.
if [ -n "${COCKPIT_GUARD_CHECKED_ROOT:-}" ]; then identity_text=${COCKPIT_GUARD_CHECKED_IDENTITY-}
else { identity_text=$(< "$local_file"); } 2>/dev/null || identity_text=''
fi
format='' node='' handler='' identity=''
if ! { IFS= read -r format && IFS= read -r node && IFS= read -r handler && IFS= read -r identity; } <<< "$identity_text" \
    || [ "$format" != 'cockpit-guard-local/v1' ] || [ -z "$node" ] || [ -z "$handler" ] || [ -z "$identity" ]; then
    printf 'cockpit guard: %s is missing, unreadable or from another cockpit version. It records the Node executable and cockpit handler on this machine, which committed files cannot carry, so shell commands, file edits and writes, and restricted MCP tools under Claude Code are refused until it exists. ' "$local_file" >&2
    cockpit_guard_recovery "$root" "$config"
    exit 2
fi
if [ ! -x "$node" ] || [ ! -r "$handler" ]; then
    printf 'cockpit guard: the Node executable %s or cockpit handler %s recorded in %s is gone (Node or cockpit was moved or reinstalled), so shell commands, file edits and writes, and restricted MCP tools under Claude Code are refused. ' "$node" "$handler" "$local_file" >&2
    cockpit_guard_recovery "$root" "$config"
    exit 2
fi
export COCKPIT_GUARD_IDENTITY="$identity" COCKPIT_GUARD_ROOT="$root"
# Ambient Node options can execute code before the authenticated application starts.
unset NODE_OPTIONS NODE_PATH
exec "$node" "$handler" guard-evaluate "$@"
