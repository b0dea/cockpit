import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { EXIT_CODES } from './invocation.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'
import { adaptGuardDecision, normalizeOpenCodeInput } from './guards/harness-adapter.js'
import { isGuardSurfaceTarget, type GuardSurfaceTarget } from './surfaces/harness-registry.js'
import { renderJsonResponse } from './diagnostics.js'
import { ENVIRONMENT_CODES, RefusalError, errorCause, type ExecutionStep } from './environment/contract.js'
import { runGuardEvaluationApplication } from './environment/application/guard.js'
import { observeSetupCheckout } from './environment/setup-observation.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveExecutablePath, resolveGitExecutable } from './environment/executable.js'
import { authenticatedExecutionOutcome, executeProbe, runUntilDeadline } from './environment-exec/execute.js'
import { loadCockpitConfig } from './config/load.js'
import { GUARD_AGENT_VARIABLES } from './guards/agent-workspaces.js'
import { GUARD_CHECK_PATH, GUARD_CHECK_UNSYNCED_PROTOCOL } from './guards/guard-record.js'

// MCP arguments are opaque to a tool-name policy; bound the native envelope before parsing it.
const NATIVE_INPUT_BYTES = 1_048_576

// The generated hook registrations give each guard call 30 seconds, and what a harness does when that
// fires is unmeasured, so the guard refuses on its own first. The deadline counts from this process's
// start, as the harness's timeout does; a synchronous stall still meets the harness's.
const GUARD_DEADLINE_MS = 25_000

// The text a file tool leaves. The guard judges these calls by their paths and reads the text only to judge the
// frontmatter of a skill, command or agent file, which asks when it is not given. Bounding the whole call at the
// parser's limit refused every write of a file larger than it, so a call past that limit is judged without its text.
const CALL_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = { Write: ['content'], Edit: ['old_string', 'new_string'], NotebookEdit: ['new_source'] }

// What the hook's check answers for a call another checkout's guard handed over, passed on as it is.
type Forwarded = Readonly<{ exitCode: number; stdout: Buffer; stderr: Buffer }>
// A guard answers with one short JSON object or one line of refusal; anything past this is not a guard's answer.
const FORWARDED_OUTPUT_BYTES = 65_536

/**
 * Runs the hook's check for the checkout at `checkout` on the call's own bytes, as the hook runs it for a session started
 * there: the check sync wrote below the home directory, run under /bin/sh by absolute path rather than any program found
 * on the search path, with no Node options and none of this run's guard variables. It runs inside the handler's deadline
 * scope, whose signal `executeProbe` takes up, so at the deadline the run is stopped with the rest of the evaluation and
 * the agent tool's own hook timeout is never the one that fires. Returns what it answered, or why it could not run.
 */
async function runCheckFor(checkout: string, raw: string, harness: GuardSurfaceTarget, cwd: string,
    env: Readonly<Record<string, string | undefined>>, deadlineMs: number): Promise<Forwarded | string> {
    const why = `The call is in ${checkout}, another checkout of this repository whose own guard judges it, but that guard's check could not run: `
    // The handler read at most this much already; checked again here because the executor takes it as given.
    if (Buffer.byteLength(raw) > NATIVE_INPUT_BYTES) return `${why}the call's input is larger than the ${NATIVE_INPUT_BYTES} bytes the guard reads.`
    if (!env.HOME || !isAbsolute(env.HOME)) return `${why}HOME is not an absolute path, so the check below ~/${GUARD_CHECK_PATH} cannot be found.`
    const check = join(env.HOME, GUARD_CHECK_PATH)
    let entry
    try { entry = lstatSync(check) } catch (error) { return `${why}${check} could not be read (${errorCause(error)}).` }
    if (!entry.isFile()) return `${why}${check} is not a regular file.`
    const shell = await resolveExecutablePath('/bin/sh')
    if (shell.state !== 'available') return `${why}${shell.reason}.`
    const remaining = Math.floor(deadlineMs - performance.now())
    if (remaining <= 0) return `${why}no time was left before the guard's deadline.`
    const childEnvironment: Record<string, string> = { COCKPIT_GUARD_DELEGATED: '1' }
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && !name.startsWith('COCKPIT_GUARD_') && name !== 'NODE_OPTIONS' && name !== 'NODE_PATH') childEnvironment[name] = value
    }
    const step: ExecutionStep = { id: `guard-delegate-${randomUUID()}`, argv: [shell.value.canonicalPath, check, checkout, '--harness', harness],
        argv0: shell.value.invocationPath, cwd, env: childEnvironment, timeoutMs: remaining, spawnNotAfter: new Date(Date.now() + remaining).toISOString(),
        stdoutLimitBytes: FORWARDED_OUTPUT_BYTES, stderrLimitBytes: FORWARDED_OUTPUT_BYTES,
        paths: [], ports: [], labels: { owner: 'guard-delegate' }, expected: [],
        consumedFiles: [{ path: shell.value.canonicalPath, sha256: shell.value.sha256, maxBytes: statSync(shell.value.canonicalPath).size,
            argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
        filesystemChecks: [{ path: cwd, expected: 'directory' }, { path: check, expected: 'file' }], compensation: [] }
    const outcome = authenticatedExecutionOutcome(await executeProbe(step, { stdin: raw }), step)
    if (!outcome) return `${why}its outcome could not be authenticated as the run cockpit started.`
    if (outcome.kind === 'complete') return { exitCode: 0, stdout: outcome.stdout, stderr: outcome.stderr }
    if (outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED && outcome.receipt !== undefined) {
        return { exitCode: outcome.execution.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }
    }
    return `${why}it did not run to completion (${outcome.code}).`
}

// The guard runs before every agent tool call, so this module imports only what a guard decision needs;
// the rest of the CLI loads only for the other commands.
export async function runGuardCommand(
    commandArgs: readonly string[],
    io: { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'>; stdin?: NodeJS.ReadStream },
    env: Readonly<Record<string, string | undefined>>,
    deadlineMs = GUARD_DEADLINE_MS,
): Promise<number> {
    let harness: GuardSurfaceTarget | undefined
    let leavesSandbox = false
    type Response = Awaited<ReturnType<typeof runGuardEvaluationApplication>> | Readonly<{ forwarded: Forwarded }>
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
            leavesSandbox = native?.tool_input?.dangerouslyDisableSandbox === true
            const mcp = harness === 'claudecode' && typeof native?.tool_name === 'string' && native.tool_name.startsWith('mcp__')
            const textFields = typeof native?.tool_name === 'string' && Object.hasOwn(CALL_TEXT_FIELDS, native.tool_name) ? CALL_TEXT_FIELDS[native.tool_name] : undefined
            const withoutText = !mcp && textFields !== undefined && bytes > GUARD_INPUT_LIMITS.inputBytes
                && native.tool_input !== null && typeof native.tool_input === 'object' && !Array.isArray(native.tool_input)
            if (!mcp && !withoutText && bytes > GUARD_INPUT_LIMITS.inputBytes) throw new RefusalError('Guard input exceeds its byte bound.')
            if (mcp && (native.tool_input === null || typeof native.tool_input !== 'object' || Array.isArray(native.tool_input))) {
                throw new RefusalError('Malformed MCP tool input.')
            }
            const identityBytes = env.COCKPIT_GUARD_IDENTITY
            if (!identityBytes || Buffer.byteLength(identityBytes) > GUARD_INPUT_LIMITS.inputBytes) throw new RefusalError('Installed guard identity is missing or oversized.')
            const guardRoot = env.COCKPIT_GUARD_ROOT
            if (!guardRoot) throw new RefusalError('Installed guard root is missing.')
            // A shell left in a directory that was removed, such as a worktree, reaches nothing by a relative path, and
            // the only way out is a cd; judged from there, every call failed, that cd included. It is judged from the root.
            let cwd: string
            let removed = false
            try { cwd = process.cwd() }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                process.chdir(guardRoot)
                cwd = process.cwd()
                removed = typeof native?.cwd !== 'string' || !existsSync(native.cwd)
            }
            const payload = harness === 'opencode' && native?.tool !== undefined
                ? normalizeOpenCodeInput(removed ? { ...native, cwd } : native)
                : { hook_event_name: native?.hook_event_name, tool_name: native?.tool_name,
                    // Only the bounded metadata reaches the own-data parser and authenticated evaluator.
                    tool_input: mcp ? {} : withoutText ? Object.fromEntries(Object.entries(native.tool_input as object).filter(([key]) => !textFields!.includes(key))) : native?.tool_input, cwd: removed ? cwd : native?.cwd ?? cwd }
            const guardEnvironment = env
            // Claude Code and Codex name the session's transcript and id, and Claude Code its scratchpad and the subagent making the call; they locate the agent's own files.
            const reported = (key: string) => typeof native?.[key] === 'string' ? native[key] as string : undefined
            const agentSession = Object.fromEntries(([['transcriptPath', 'transcript_path'], ['sessionId', 'session_id'], ['scratchpadDir', 'scratchpad_dir'], ['agentType', 'agent_type']] as const)
                .flatMap(([name, key]) => reported(key) === undefined ? [] : [[name, reported(key)]]))
            const agentEnvironment = Object.fromEntries(GUARD_AGENT_VARIABLES.flatMap(name => guardEnvironment[name] ? [[name, guardEnvironment[name]]] : []))
            const response = await runGuardEvaluationApplication({ identity: JSON.parse(identityBytes), guardRoot, payload, harness, cwd,
                askIsDeny: guardEnvironment.COCKPIT_ASK_IS_DENY === '1',
                unsyncedWorktree: guardEnvironment.COCKPIT_GUARD_CHECK_PROTOCOL === GUARD_CHECK_UNSYNCED_PROTOCOL,
                delegated: guardEnvironment.COCKPIT_GUARD_DELEGATED === '1',
                ripgrepConfigActive: Object.hasOwn(guardEnvironment, 'RIPGREP_CONFIG_PATH') || guardEnvironment.COCKPIT_RIPGREP_CONFIG_ACTIVE === '1',
                searchPath: guardEnvironment.PATH ?? '', agentSession, agentEnvironment,
                ...guardEnvironment.HOME ? { home: guardEnvironment.HOME } : {}, ...guardEnvironment.XDG_CONFIG_HOME ? { xdgConfigHome: guardEnvironment.XDG_CONFIG_HOME } : {} }, {
                loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
                resolveGit: () => resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
                execute: executeProbe,
            })
            if (response.delegate === undefined) return response
            const answered = await runCheckFor(response.delegate, raw, harness, cwd, guardEnvironment, deadlineMs)
            if (typeof answered !== 'string') return { forwarded: answered }
            return { decision: { decision: 'unavailable', reason: answered },
                diagnostics: [{ severity: 'error', code: 'GUARD_AUTHORITY_UNAVAILABLE', message: answered, target: 'guard' }] }
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
    if ('forwarded' in response) {
        io.stdout.write(response.forwarded.stdout)
        io.stderr.write(response.forwarded.stderr)
        return response.forwarded.exitCode
    }
    // Project once at the publication boundary; adapters only spell the closed decision.
    const projected = JSON.parse(renderJsonResponse({ result: response.decision, diagnostics: response.diagnostics }, response.fixContext)) as { result: typeof response.decision }
    const decision = projected.result.decision === 'ask' && env.COCKPIT_ASK_IS_DENY === '1'
        ? { ...projected.result, decision: 'deny' as const } : projected.result
    const output = adaptGuardDecision(harness, decision, { leavesSandbox })
    io.stdout.write(output.stdout)
    io.stderr.write(output.stderr)
    const status: number = output.exitCode
    return status === EXIT_CODES.success ? EXIT_CODES.success
        : status === EXIT_CODES.cancelled ? EXIT_CODES.cancelled : EXIT_CODES.failure
}
