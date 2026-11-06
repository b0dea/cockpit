import { formatShellCommand } from '../fix-catalogue.js'

const absentConfig = 'Local hook changes can remain after switching branches, and an open session may keep a cached hook. Fix: a human must return to the intended configured checkout/worktree and branch. If this branch intentionally has no cockpit, review the active hook source against that branch, preserve native guards, and restore only reviewed cockpit changes. Close and reopen the agent after changing checkout or hook definitions.'
const absentInstall = "@b00dea/cockpit is not installed or is incomplete. Fix: a human must run the repository's documented dependency-install command using its pinned package manifest and lockfile in a terminal, outside the agent, in"
const syncSuffix = 'in a terminal, outside the agent, then retry. If hook definitions changed, close and reopen the agent first.'

export function guardRecovery(root: string, configPath: string, available: Readonly<{ config: boolean; package: boolean }>): string {
    if (!available.config) return `${configPath} is missing or unreadable. ${absentConfig}`
    if (!available.package) return `${absentInstall} ${formatShellCommand([root])}; if this branch has no cockpit dependency, return to the intended configured branch. Retry after installation so the hook can name the installed sync command.`
    return `Fix: a human must run \`${formatShellCommand([`${root}/node_modules/@b00dea/cockpit/bin/cockpit.mjs`, 'sync', '--config', configPath])}\` ${syncSuffix}`
}

// The pre-handler hook must diagnose a missing installation without requiring Node or that package.
// Both generated transports use these same bytes; the helper only prints and never repairs a guard.
export const GUARD_RECOVERY_SHELL = `shell_arg() {
    value=$1
    printf "'"
    while case "$value" in *"'"*) true;; *) false;; esac; do
        prefix=\${value%%"'"*}
        printf "%s'\\\"'\\\"'" "$prefix"
        value=\${value#*"'"}
    done
    printf "%s'" "$value"
}
cockpit_guard_recovery() {
    recovery_root=$1
    recovery_config="$1/$2"
    recovery_launcher="$1/node_modules/@b00dea/cockpit/bin/cockpit.mjs"
    if [ -z "$recovery_root" ] || [ ! -f "$recovery_config" ] || [ ! -r "$recovery_config" ]; then
        printf '%s is missing or unreadable. %s\\n' "$recovery_config" ${formatShellCommand([absentConfig])} >&2
    elif [ ! -x "$recovery_launcher" ] || [ ! -f "$recovery_root/node_modules/@b00dea/cockpit/dist/cli.js" ] || [ ! -r "$recovery_root/node_modules/@b00dea/cockpit/dist/cli.js" ]; then
        printf '%s %s; if this branch has no cockpit dependency, return to the intended configured branch. Retry after installation so the hook can name the installed sync command.\\n' ${formatShellCommand([absentInstall])} "$(shell_arg "$recovery_root")" >&2
    else
        printf 'Fix: a human must run ${'`'}%s sync --config %s${'`'} %s\\n' "$(shell_arg "$recovery_launcher")" "$(shell_arg "$recovery_config")" ${formatShellCommand([syncSuffix])} >&2
    fi
}`
