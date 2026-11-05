import type { ENVIRONMENT_CODES, EnvironmentDiagnostic } from './contract.js'
import { locateExecutable } from './executable.js'
import type { McpServer } from '../surfaces/mcp.js'

// Presence only: the doctor needs to know a command can be started, not its identity, so it
// does not hash the binary the way a verified spawn does.
async function commandReason(command: string, cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
    const located = await locateExecutable(command, env, cwd)
    return located.state === 'present' ? undefined : located.reason
}

/**
 * What each approved MCP server needs before a tool can start it, read without starting anything or
 * touching the network: a local server's command and a remote server's headers helper resolve from
 * where the wrapper runs them, and every required environment name the server reads is set. A disabled server
 * starts in no tool, so it is not checked. Diagnostics name variables, never their values.
 */
export async function observeMcpStartup(
    servers: readonly McpServer[],
    env: Readonly<Record<string, string | undefined>>,
): Promise<readonly EnvironmentDiagnostic[]> {
    const diagnostics: EnvironmentDiagnostic[] = []
    const launches = new Map<string, Promise<string | undefined>>()
    for (const server of servers.filter(row => row.enabled)) {
        const launch = 'transport' in server ? server.helper : server
        if (launch !== null) launches.set(JSON.stringify([launch.command, launch.cwd]), commandReason(launch.command, launch.cwd, env))
    }
    for (const server of servers.filter(row => row.enabled)) {
        const launch = 'transport' in server ? server.helper : server
        if (launch !== null) {
            const reason = await launches.get(JSON.stringify([launch.command, launch.cwd]))
            if (reason !== undefined) diagnostics.push({
                severity: 'warning',
                code: 'MCP_COMMAND_UNRESOLVED' satisfies typeof ENVIRONMENT_CODES.MCP_COMMAND_UNRESOLVED,
                target: server.name,
                message: `the ${'transport' in server ? 'headers helper' : 'command'} of MCP server ${server.name}, ${launch.command} in ${launch.cwd}, does not resolve to an executable file (${reason}), so no tool can start ${'transport' in server ? 'its connection' : 'it'}`,
                fix: 'install the command or correct it in the sibling\'s MCP declaration, then run npx --no cockpit sync --config <your cockpit.toml>; a changed declaration needs a person to approve its new sha256 under [mcp.approved]',
            })
        }
        const unset = server.envNames.filter(name => !env[name])
        if (unset.length > 0) diagnostics.push({
            severity: 'warning',
            code: 'MCP_ENVIRONMENT_UNSET' satisfies typeof ENVIRONMENT_CODES.MCP_ENVIRONMENT_UNSET,
            target: server.name,
            message: `MCP server ${server.name} reads ${unset.join(', ')}, which ${unset.length === 1 ? 'is' : 'are'} unset or empty here, so a tool started from this environment ${'transport' in server ? 'cannot send the server its credential' : 'cannot start it'}`,
            fix: `set each named variable in the environment the agent tool is started from${'transport' in server ? ', or give the server a headersHelper that reads the credential when the tool connects' : ''}`,
        })
    }
    return diagnostics
}
