/**
 * Names the one local Docker daemon a command addresses, before the command does any work, so
 * `down`, `reset` and `runtime measure` choose a daemon by one rule. It observes Docker's own
 * context configuration through the supplied `execute`; it never spawns a process itself.
 */
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, type Diagnostic, type ExecutionStep } from './contract.js'
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import { resolveDockerExecutable, type ResolvedExecutable } from './executable.js'

type Executor = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

export type LocalDockerDaemon =
    // `endpoint` is the local socket the context resolves to; `source` says where it was read.
    | Readonly<{ kind: 'complete'; dockerContext: string; endpoint: string; source: string }>
    | Readonly<{ kind: 'refusal'; diagnostic: Diagnostic }>

export interface DaemonUse {
    // The command, as the subject of a sentence: "down and reset", "runtime measure".
    readonly command: string
    // Why that command refuses a remote daemon, as a clause.
    readonly localOnly: string
}

const DOCKER_CONTEXT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

async function readContext(execute: Executor, executable: ResolvedExecutable, env: Readonly<Record<string, string>>,
    timeoutMs: number, id: string, args: readonly string[]): Promise<string | undefined> {
    const step: ExecutionStep = Object.freeze({
        id,
        argv: Object.freeze([executable.canonicalPath, ...args]) as readonly [string, ...string[]],
        argv0: executable.invocationPath,
        // The context lookup reads only Docker's client configuration, and the config's own
        // directory may not exist yet; a missing config is reported by the command, not here.
        cwd: '/', env, timeoutMs,
        stdoutLimitBytes: 1_024, stderrLimitBytes: 4_096,
        paths: Object.freeze([]), ports: Object.freeze([]),
        labels: Object.freeze({ purpose: id }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({
            path: executable.canonicalPath, sha256: executable.sha256,
            maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true as const,
            executionMode: executable.executionMode,
        })]),
        filesystemChecks: Object.freeze([]),
        compensation: Object.freeze([]),
    })
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    if (outcome?.kind !== 'complete' || outcome.stderr.byteLength !== 0) return undefined
    const text = outcome.stdout.toString('utf8')
    // Docker's final line ending is framing; trimming more would rewrite the endpoint's identity.
    return Buffer.from(text, 'utf8').equals(outcome.stdout) ? text.replace(/\r?\n$/, '') : undefined
}

/**
 * A local DOCKER_HOST is taken as given, through Docker's `default` context. Otherwise the context
 * is the one DOCKER_CONTEXT names or, with neither set, the active one, read once here so the
 * caller can pin it for every later step: reading it per step lets a `docker context use` mid-run
 * point one step at one daemon and the next at another. Either way the context must resolve to a
 * local Unix socket, so a remote daemon is refused however it was named.
 */
export async function selectLocalDockerDaemon(
    env: Readonly<Record<string, string | undefined>>,
    timeoutMs: number,
    execute: Executor,
    use: DaemonUse,
): Promise<LocalDockerDaemon> {
    const refuse = (code: string, message: string, target: string): LocalDockerDaemon => Object.freeze({
        kind: 'refusal' as const, diagnostic: Object.freeze({ severity: 'error' as const, code, message, target }),
    })
    if (env.DOCKER_HOST !== undefined) {
        return admitLocalDockerEndpoint(env.DOCKER_HOST) === undefined
            ? refuse('CLI_USAGE_INVALID',
                `DOCKER_HOST is not a local Docker endpoint, and ${use.localOnly}; fix: unset DOCKER_HOST to use the active Docker context, or set DOCKER_HOST to a local Unix socket`,
                'DOCKER_HOST')
            : Object.freeze({ kind: 'complete' as const, dockerContext: 'default', endpoint: env.DOCKER_HOST, source: 'DOCKER_HOST' })
    }
    const named = env.DOCKER_CONTEXT
    if (named !== undefined && !DOCKER_CONTEXT_NAME.test(named)) {
        return refuse('CLI_USAGE_INVALID', `DOCKER_CONTEXT ${JSON.stringify(named.slice(0, 128))} is not a Docker context name; fix: set it to a local context from \`docker context ls\`, or unset it to use the active context`,
            'DOCKER_CONTEXT')
    }
    const executable = await resolveDockerExecutable(env)
    if (executable.state !== 'available') return refuse(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, executable.reason, 'docker')
    // Only the search path: Docker then reads the operator's own context store, as `up` does.
    const stepEnv: Readonly<Record<string, string>> = Object.freeze({ ...(env.PATH === undefined ? {} : { PATH: env.PATH }) })
    const context = named ?? await readContext(execute, executable.value, stepEnv, timeoutMs, 'runtime:daemon:context', ['context', 'show'])
    if (context === undefined || !DOCKER_CONTEXT_NAME.test(context)) {
        return refuse(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `${use.command} could not read the active Docker context from \`docker context show\`; fix: run \`docker context show\` to see why, or set DOCKER_CONTEXT to the local context to use`,
            'docker context')
    }
    const which = named === undefined ? `active Docker context ${context}` : `Docker context ${context} named by DOCKER_CONTEXT`
    const target = `docker context ${context}`
    const endpoint = await readContext(execute, executable.value, stepEnv, timeoutMs, 'runtime:daemon:endpoint',
        ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'])
    if (endpoint === undefined) {
        return refuse(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `${use.command} could not read the endpoint of the ${which}; fix: run \`docker context inspect ${context}\` to see why`, target)
    }
    if (admitLocalDockerEndpoint(endpoint) === undefined) {
        const select = named === undefined ? 'select a local context with `docker context use <name>`' : 'set DOCKER_CONTEXT to a local context, or unset it'
        return refuse(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `the ${which} points at ${endpoint}, not a local Unix socket, and ${use.localOnly}; fix: ${select}, then retry`, target)
    }
    return Object.freeze({ kind: 'complete' as const, dockerContext: context, endpoint, source: target })
}
