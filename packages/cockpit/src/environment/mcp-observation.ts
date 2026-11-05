import type { ENVIRONMENT_CODES, EnvironmentDiagnostic } from './contract.js'
import { locateExecutable, observationEnvironment } from './executable.js'
import { guardSearchPathRelativeEntry } from '../guards/protected-locations.js'
import type { McpServer } from '../surfaces/mcp.js'

type LaunchProblem = Readonly<{ kind: 'unresolved'; reason: string }>
    | Readonly<{ kind: 'relative-path'; entry: string; absolute: string | undefined }>

function relativeEntryClass(entry: string): string {
    if (entry === '') return 'an empty entry, which is the working directory'
    if (entry === '..' || entry.startsWith('../')) return `the parent-relative entry ${JSON.stringify(entry)}`
    if (entry === '.' || entry.startsWith('./')) return `the dot-relative entry ${JSON.stringify(entry)}, such as a package manager adds`
    return `the bare relative entry ${JSON.stringify(entry)}`
}

// Presence only: the doctor needs to know a command can be started, not its identity, so it
// does not hash the binary the way a verified spawn does. A relative PATH entry refuses the lookup
// without saying anything about the command, and may belong only to this process, so the absolute
// entries are read to say what a tool started without it would find.
async function launchProblem(command: string, cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<LaunchProblem | undefined> {
    const located = await locateExecutable(command, env, cwd)
    if (located.state === 'present') return undefined
    const entry = command.includes('/') ? null : guardSearchPathRelativeEntry(env.PATH ?? '')
    const search = observationEnvironment(env)
    if (entry === null || env.PATH === undefined || env.PATH === '' || search.state === 'unavailable' && !search.noAbsoluteDirectory) return { kind: 'unresolved', reason: located.reason }
    const absolute = search.state === 'available' ? await locateExecutable(command, search.env, cwd) : undefined
    return { kind: 'relative-path', entry, absolute: absolute?.state === 'present' ? absolute.path : undefined }
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
    const launches = new Map<string, Promise<LaunchProblem | undefined>>()
    for (const server of servers.filter(row => row.enabled)) {
        const launch = 'transport' in server ? server.helper : server
        if (launch !== null) launches.set(JSON.stringify([launch.command, launch.cwd]), launchProblem(launch.command, launch.cwd, env))
    }
    for (const server of servers.filter(row => row.enabled)) {
        const launch = 'transport' in server ? server.helper : server
        if (launch !== null) {
            const problem = await launches.get(JSON.stringify([launch.command, launch.cwd]))
            const part = 'transport' in server ? 'headers helper' : 'command'
            if (problem?.kind === 'unresolved') diagnostics.push({
                severity: 'warning',
                code: 'MCP_COMMAND_UNRESOLVED' satisfies typeof ENVIRONMENT_CODES.MCP_COMMAND_UNRESOLVED,
                target: server.name,
                message: `the ${part} of MCP server ${server.name}, ${launch.command} in ${launch.cwd}, does not resolve to an executable file (${problem.reason}), so no tool can start ${'transport' in server ? 'its connection' : 'it'}`,
                fix: 'install the command or correct it in the sibling\'s MCP declaration, then run npx --no cockpit sync --config <your cockpit.toml>; a changed declaration needs a person to approve its new sha256 under [mcp.approved]',
            })
            if (problem?.kind === 'relative-path') diagnostics.push({
                severity: 'warning',
                code: 'MCP_COMMAND_UNRESOLVED' satisfies typeof ENVIRONMENT_CODES.MCP_COMMAND_UNRESOLVED,
                target: server.name,
                message: `the ${part} of MCP server ${server.name}, ${launch.command}, could not be looked up from the PATH doctor runs with: it holds ${relativeEntryClass(problem.entry)}, which doctor excludes from observation because it names a different directory for each working directory. ${problem.absolute === undefined
                    ? `${launch.command} is in none of the absolute entries either`
                    : `${launch.command} is at ${problem.absolute} among the absolute entries, so a tool started with those alone can start it`}`,
                fix: `remove the relative entry from the shell or launcher that starts the agent tool, then rerun doctor without it${problem.absolute === undefined ? `; ${launch.command} also has to be installed in an absolute PATH directory` : '; the MCP declaration needs no change'}`,
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
