import { EXIT_CODES } from './invocation.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'
import { adaptGuardDecision, normalizeOpenCodeInput } from './guards/harness-adapter.js'
import { isGuardSurfaceTarget, type GuardSurfaceTarget } from './surfaces/harness-registry.js'
import { renderJsonResponse } from './diagnostics.js'
import { RefusalError, errorCause } from './environment/contract.js'
import { runGuardEvaluationApplication } from './environment/application/guard.js'
import { observeSetupCheckout } from './environment/setup-observation.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveDockerExecutable, resolveGitExecutable } from './environment/executable.js'
import { executeProbe } from './environment-exec/execute.js'
import { loadCockpitConfig } from './config/load.js'

// The guard runs before every agent tool call, so this module imports only what a guard decision needs;
// the rest of the CLI loads only for the other commands.
export async function runGuardCommand(
    commandArgs: readonly string[],
    io: { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'>; stdin?: NodeJS.ReadStream },
    env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
    let harness: GuardSurfaceTarget | undefined
    let response: Awaited<ReturnType<typeof runGuardEvaluationApplication>>
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
            if (bytes > GUARD_INPUT_LIMITS.inputBytes) throw new RefusalError('Guard input exceeds its byte bound.')
            chunks.push(buffer)
        }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
        const native = JSON.parse(raw)
        const payload = harness === 'opencode' && native?.tool !== undefined
            ? normalizeOpenCodeInput(native)
            : { hook_event_name: native?.hook_event_name, tool_name: native?.tool_name,
                tool_input: native?.tool_input, cwd: native?.cwd ?? process.cwd() }
        const identityBytes = env.COCKPIT_GUARD_IDENTITY
        if (!identityBytes || Buffer.byteLength(identityBytes) > GUARD_INPUT_LIMITS.inputBytes) throw new RefusalError('Installed guard identity is missing or oversized.')
        const guardRoot = env.COCKPIT_GUARD_ROOT
        if (!guardRoot) throw new RefusalError('Installed guard root is missing.')
        const guardEnvironment = env
        response = await runGuardEvaluationApplication({ identity: JSON.parse(identityBytes), guardRoot, payload, harness, cwd: process.cwd(),
            askIsDeny: guardEnvironment.COCKPIT_ASK_IS_DENY === '1',
            ripgrepConfigActive: Object.hasOwn(guardEnvironment, 'RIPGREP_CONFIG_PATH') || guardEnvironment.COCKPIT_RIPGREP_CONFIG_ACTIVE === '1',
            searchPath: guardEnvironment.PATH ?? '' }, {
            loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: () => resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
            resolveDocker: () => resolveDockerExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
            execute: executeProbe,
        })
    } catch (error) {
        const reason = `Guard input, arguments or installed identity are unavailable or malformed: ${errorCause(error)}`
        response = { decision: { decision: 'unavailable', reason },
            diagnostics: [{ severity: 'error', code: 'GUARD_INPUT_UNAVAILABLE', message: reason, target: 'guard' }] }
    }
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
