import { resolve } from 'node:path'

import type { ENVIRONMENT_CODES, EnvironmentDiagnostic } from './contract.js'
import { resolveExecutable, resolveExecutablePath } from './executable.js'
import type { McpServer } from '../surfaces/mcp.js'

/**
 * What each approved MCP server needs before a tool can start it, read without starting anything or
 * touching the network: a local server's command and a remote server's headers helper resolve from
 * where the wrapper runs them, and every environment name the server reads is set. A disabled server
 * starts in no tool, so it is not checked. Diagnostics name variables, never their values.
 */
export async function observeMcpStartup(
    servers: readonly McpServer[],
    env: Readonly<Record<string, string | undefined>>,
): Promise<readonly EnvironmentDiagnostic[]> {
    const diagnostics: EnvironmentDiagnostic[] = []
    for (const server of servers.filter(row => row.enabled)) {
        const launch = 'transport' in server ? server.helper : server
        if (launch !== null) {
            // The wrapper changes into the server's directory first, so a command with a slash is
            // relative to it and a bare name is looked up on PATH.
            const resolved = launch.command.includes('/')
                ? await resolveExecutablePath(resolve(launch.cwd, launch.command))
                : await resolveExecutable(launch.command, env)
            if (resolved.state !== 'available') diagnostics.push({
                severity: 'warning',
                code: 'MCP_COMMAND_UNRESOLVED' satisfies typeof ENVIRONMENT_CODES.MCP_COMMAND_UNRESOLVED,
                target: server.name,
                message: `the ${'transport' in server ? 'headers helper' : 'command'} of MCP server ${server.name}, ${launch.command} in ${launch.cwd}, does not resolve to an executable file (${resolved.reason}), so no tool can start ${'transport' in server ? 'its connection' : 'it'}`,
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
