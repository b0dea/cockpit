import { EXIT_CODES } from './invocation.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'
import { adaptGuardDecision, normalizeOpenCodeInput } from './guards/harness-adapter.js'
import { isGuardSurfaceTarget, type GuardSurfaceTarget } from './surfaces/harness-registry.js'
import { renderJsonResponse } from './diagnostics.js'
import { RefusalError, errorCause } from './environment/contract.js'
import { runGuardEvaluationApplication } from './environment/application/guard.js'
import { observeSetupCheckout } from './environment/setup-observation.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveDockerExecutable, resolveGitExecutable } from './environment/executable.js'
import { executeProbe, runUntilDeadline } from './environment-exec/execute.js'
import { loadCockpitConfig } from './config/load.js'

// MCP arguments are opaque to a tool-name policy; bound the native envelope before parsing it.
const NATIVE_INPUT_BYTES = 1_048_576

// The generated hook registrations give each guard call 30 seconds, and what a harness does when that
// fires is unmeasured, so the guard refuses on its own first. The deadline counts from this process's
// start, as the harness's timeout does; a synchronous stall still meets the harness's.
const GUARD_DEADLINE_MS = 25_000

// The guard runs before every agent tool call, so this module imports only what a guard decision needs;
// the rest of the CLI loads only for the other commands.
export async function runGuardCommand(
    commandArgs: readonly string[],
    io: { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'>; stdin?: NodeJS.ReadStream },
    env: Readonly<Record<string, string | undefined>>,
    deadlineMs = GUARD_DEADLINE_MS,
): Promise<number> {
    let harness: GuardSurfaceTarget | undefined
    type Response = Awaited<ReturnType<typeof runGuardEvaluationApplication>>
    const evaluate = async (): Promise<Response> => {
        try {
            if (commandArgs.length !== 2 || commandArgs[0] !== '--harness'
                || !isGuardSurfaceTarget(commandArgs[1])) throw new RefusalError('Invalid private guard arguments.')
            harness = commandArgs[1]
            if (!io.stdin) throw new RefusalError('Guard input stream is missing.')
            const chunks: Buffer[] = []
            let bytes = 0
            for await (const chunk of io.stdin) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                bytes += buffer.length
                if (bytes > NATIVE_INPUT_BYTES) throw new RefusalError('Guard input exceeds its byte bound.')
                chunks.push(buffer)
            }
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
            const native = JSON.parse(raw)
            const mcp = harness === 'claudecode' && typeof native?.tool_name === 'string' && native.tool_name.startsWith('mcp__')
            if (!mcp && bytes > GUARD_INPUT_LIMITS.inputBytes) throw new RefusalError('Guard input exceeds its byte bound.')
            if (mcp && (native.tool_input === null || typeof native.tool_input !== 'object' || Array.isArray(native.tool_input))) {
                throw new RefusalError('Malformed MCP tool input.')
            }
            const payload = harness === 'opencode' && native?.tool !== undefined
                ? normalizeOpenCodeInput(native)
                : { hook_event_name: native?.hook_event_name, tool_name: native?.tool_name,
                    // Only the bounded metadata reaches the own-data parser and authenticated evaluator.
                    tool_input: mcp ? {} : native?.tool_input, cwd: native?.cwd ?? process.cwd() }
            const identityBytes = env.COCKPIT_GUARD_IDENTITY
            if (!identityBytes || Buffer.byteLength(identityBytes) > GUARD_INPUT_LIMITS.inputBytes) throw new RefusalError('Installed guard identity is missing or oversized.')
            const guardRoot = env.COCKPIT_GUARD_ROOT
            if (!guardRoot) throw new RefusalError('Installed guard root is missing.')
            const guardEnvironment = env
            return await runGuardEvaluationApplication({ identity: JSON.parse(identityBytes), guardRoot, payload, harness, cwd: process.cwd(),
                askIsDeny: guardEnvironment.COCKPIT_ASK_IS_DENY === '1',
                ripgrepConfigActive: Object.hasOwn(guardEnvironment, 'RIPGREP_CONFIG_PATH') || guardEnvironment.COCKPIT_RIPGREP_CONFIG_ACTIVE === '1',
                searchPath: guardEnvironment.PATH ?? '',
                ...guardEnvironment.HOME ? { home: guardEnvironment.HOME } : {}, ...guardEnvironment.XDG_CONFIG_HOME ? { xdgConfigHome: guardEnvironment.XDG_CONFIG_HOME } : {} }, {
                loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
                resolveGit: () => resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
                resolveDocker: () => resolveDockerExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
                execute: executeProbe,
            })
        } catch (error) {
            const reason = `Guard input, arguments or installed identity are unavailable or malformed: ${errorCause(error)}`
            return { decision: { decision: 'unavailable', reason },
                diagnostics: [{ severity: 'error', code: 'GUARD_INPUT_UNAVAILABLE', message: reason, target: 'guard' }] }
        }
    }
    // Past the deadline every process the evaluation started ends and none starts; closing the input
    // ends a read the harness never finished. Either would keep this process from exiting.
    const response = await runUntilDeadline(deadlineMs, evaluate, (): Response => {
        io.stdin?.destroy()
        const reason = `The guard ran out of time: it did not decide within ${GUARD_DEADLINE_MS / 1000} seconds, so this call is refused before the agent tool's own hook timeout. Retry it; a heavily loaded machine slows the guard.`
        return { decision: { decision: 'unavailable', reason },
            diagnostics: [{ severity: 'error', code: 'GUARD_TIMED_OUT', message: reason, target: 'guard' }] }
    })
    // Project once at the publication boundary; adapters only spell the closed decision.
    const projected = JSON.parse(renderJsonResponse({ result: response.decision, diagnostics: response.diagnostics }, response.fixContext)) as { result: typeof response.decision }
    const decision = projected.result.decision === 'ask' && env.COCKPIT_ASK_IS_DENY === '1'
        ? { ...projected.result, decision: 'deny' as const } : projected.result
    const output = adaptGuardDecision(harness, decision)
    io.stdout.write(output.stdout)
    io.stderr.write(output.stderr)
    const status: number = output.exitCode
    return status === EXIT_CODES.success ? EXIT_CODES.success
        : status === EXIT_CODES.cancelled ? EXIT_CODES.cancelled : EXIT_CODES.failure
}
