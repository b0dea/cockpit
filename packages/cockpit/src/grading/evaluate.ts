import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { parseDocument } from 'yaml'
import { ENVIRONMENT_CODES, errorCause, parseJsonText, RefusalError, type ConsumedFile, type ExecutionStep } from '../environment/contract.js'
import { resolveExecutablePath } from '../environment/executable.js'
import { authenticatedExecutionOutcome, executeProbe } from '../environment-exec/execute.js'
import { EVALUATOR_COMMANDS, type EvaluatorTool } from '../schema.js'

export const mechanism = {
    id: 'independent-evaluation',
    module: 'packages/cockpit/src/grading/evaluate.ts',
    exports: ['findEvaluators', 'locateEvaluators', 'evaluate', 'evaluatorUnavailable'],
} as const

// One run of an agent tool apart from the agent that did the work: a fresh headless session started in a
// private directory of its own, held read-only by the tool's own mechanism, whose answer is checked
// against the caller's schema. This module is the only place that knows how each tool is spelled.

type Executable = Readonly<{ path: string; sha256: string; bytes: number }>
export type EvaluationAttempt = Readonly<{ tool: EvaluatorTool; code: string; message: string }>
/** The tools a caller may run, in order, with those that could not be found or probed passed over. */
export type EvaluatorChain = Readonly<{ located: readonly Readonly<{ tool: EvaluatorTool; executable: Executable }>[]; skipped: readonly EvaluationAttempt[] }>
export type EvaluationRequest = Readonly<{
    chain: EvaluatorChain
    // Labels the run; the document is written to the run directory as the request the prompt names.
    role: string
    document: Readonly<Record<string, unknown>>
    // A closed JSON Schema: object, array, string, integer and null types, enum, properties, items.
    schema: Readonly<Record<string, unknown>>
    repository: string
    timeoutMs: number
    timeoutField: string
    executableDirectories: readonly string[]
    environment: Readonly<Record<string, string | undefined>>
}>
export type EvaluationResult =
    | Readonly<{ kind: 'answer'; value: Readonly<Record<string, unknown>>; sessionId: string; tool: EvaluatorTool; fallbacks: readonly EvaluationAttempt[] }>
    | Readonly<{ kind: 'refusal'; code: string; message: string; fix: string; attempts: readonly EvaluationAttempt[] }>

const MAX_DOCUMENT_BYTES = 8 * 1_048_576
// The Codex CLI's and OpenCode's JSON streams carry every tool call and its output; a larger stream
// fails naming this bound rather than being cut short of the session identity or the final answer.
const STDOUT_LIMIT_BYTES = 8 * 1_048_576
const STDERR_LIMIT_BYTES = 65_536
const ANSWER_LIMIT_BYTES = 65_536
const PROBE_TIMEOUT_MS = 30_000
const CAUSE_CHARACTERS = 2_048
const digest = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
// The tool ran and said why it gave no answer (signed out, rate-limited), so another tool may be tried.
class ToolReportedFailure extends RefusalError {}
// A tool that resumed a session it had already answered in could carry another run's context.
const answeredSessions = new Set<string>()

type Invocation = Readonly<{ runRoot: string; repository: string; schemaPath: string; schema: string; responsePath: string; prompt: string }>
type Reading = Readonly<{ sessionId: string; answer: string }>

function parseJson(text: string, subject: string, expected: string): unknown {
    const parsed = parseJsonText(text, subject, expected)
    if ('refusal' in parsed) throw new RefusalError(parsed.refusal)
    return parsed.value
}

function strictJson(text: string, subject: string, expected: string): unknown {
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new RefusalError(`${subject} is not strict duplicate-free JSON`)
    return parseJson(text, subject, expected)
}

function jsonLines(stdout: string, subject: string): Record<string, unknown>[] {
    return stdout.split('\n').filter(Boolean).map(line => parseJson(line, subject, 'one JSON event per line') as Record<string, unknown>)
}

// A failed run's stdout can interleave non-JSON lines, so only the lines that parse are read for a cause.
function reportedEvents(stdout: string): Record<string, unknown>[] {
    return stdout.split('\n').flatMap(line => {
        try { const event: unknown = JSON.parse(line); return event && typeof event === 'object' && !Array.isArray(event) ? [event as Record<string, unknown>] : [] }
        catch (error) { if (error instanceof SyntaxError) return []; throw error }
    })
}

function opencodeCause(stdout: string, stderr: string): string | undefined {
    const failed = reportedEvents(stdout).find(event => event.type === 'error')?.error as { name?: unknown; data?: { message?: unknown } } | undefined
    const reported = typeof failed?.data?.message === 'string' ? failed.data.message : typeof failed?.name === 'string' ? failed.name : undefined
    const logged = [...stderr.matchAll(/ error(?:\.error)?="([^"]+)"/g)].at(-1)?.[1]
    return reported && logged ? `${reported} (${logged})` : reported ?? logged
}

// Each read-only mechanism was measured on 2026-11-03 beside a control without it: Codex 0.166.0 refused a
// shell write under --sandbox read-only and made it under workspace-write; Claude Code 2.1.317 had no tool
// to write with under --tools Read,Grep,Glob and wrote the file once Write was added; OpenCode 1.19.5
// listed only glob, grep, read and list under these denials and offered write once edit was not denied.
const TOOLS = Object.freeze({
    codexcli: Object.freeze({
        name: 'the Codex CLI', install: 'npm install -g @openai/codex', signIn: 'codex login',
        help: ['exec', '--help'], flags: ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', '--cd', '--json', '--output-schema', '--output-last-message'],
        environment: ['HOME', 'CODEX_HOME'], fixedEnvironment: {},
        restriction: 'codex exec --sandbox read-only',
        // Codex reads its working root as a project, and outside a Git checkout only with --skip-git-repo-check.
        argv: (run: Invocation) => ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', run.runRoot, '--json',
            '--output-schema', run.schemaPath, '--output-last-message', run.responsePath, run.prompt],
        read: (stdout: string, run: Invocation): Reading => {
            let sessionId: string | undefined
            for (const event of jsonLines(stdout, 'a Codex CLI event line')) {
                const candidate = event.type === 'thread.started' && typeof event.thread_id === 'string' ? event.thread_id
                    : event.type === 'thread.started' && typeof event.threadId === 'string' ? event.threadId : undefined
                if (candidate && sessionId) throw new RefusalError('the Codex CLI emitted duplicate thread identities')
                sessionId ??= candidate
            }
            if (!sessionId) throw new RefusalError('the Codex CLI named no thread identity')
            const stat = lstatSync(run.responsePath)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > ANSWER_LIMIT_BYTES || realpathSync(run.responsePath) !== run.responsePath) {
                throw new RefusalError('the Codex CLI answer is not a contained bounded file')
            }
            const bytes = readFileSync(run.responsePath)
            if (bytes.length > ANSWER_LIMIT_BYTES) throw new RefusalError('the Codex CLI answer grew past its bound')
            return { sessionId, answer: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        },
        // A failed run (an API rejection, a missing login) is reported as a JSON event on stdout.
        cause: (stdout: string) => reportedEvents(stdout).reduce<string | undefined>((cause, event) =>
            event.type === 'error' && typeof event.message === 'string' ? event.message
                : event.type === 'turn.failed' && typeof (event.error as { message?: unknown } | undefined)?.message === 'string' ? (event.error as { message: string }).message : cause, undefined),
    }),
    claudecode: Object.freeze({
        name: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', signIn: 'claude auth login',
        help: ['--help'], flags: ['--print', '--output-format', '--json-schema', '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--tools', '--permission-mode', '--add-dir'],
        // On macOS the sign-in is a keychain item kept under the user's name; without USER it reads as signed out.
        environment: ['HOME', 'USER', 'CLAUDE_CONFIG_DIR'], fixedEnvironment: {},
        restriction: 'claude --tools Read,Grep,Glob',
        // --safe-mode skips the hooks, plugins, skills, MCP servers and CLAUDE.md the user configured;
        // dontAsk denies what would prompt, so the repository is readable only because --add-dir names it.
        // --tools and --add-dir take several values, so -- ends them before the prompt.
        argv: (run: Invocation) => ['--print', '--output-format', 'json', '--json-schema', run.schema, '--no-session-persistence', '--safe-mode',
            '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--add-dir', run.repository, '--', run.prompt],
        read: (stdout: string): Reading => {
            const result = strictJson(stdout, 'the Claude Code result', 'one JSON result object') as Record<string, unknown>
            if (result.type !== 'result' || result.is_error !== false || typeof result.session_id !== 'string' || !result.session_id
                || typeof result.structured_output !== 'object' || result.structured_output === null) {
                throw new ToolReportedFailure(`Claude Code returned no structured result${typeof result.result === 'string' && result.result ? `: ${result.result.slice(-CAUSE_CHARACTERS)}` : ''}`)
            }
            return { sessionId: result.session_id, answer: JSON.stringify(result.structured_output) }
        },
        cause: (stdout: string) => {
            const result = reportedEvents(stdout).find(event => event.type === 'result')?.result
            return typeof result === 'string' && result ? result : undefined
        },
    }),
    opencode: Object.freeze({
        name: 'OpenCode', install: 'npm install -g opencode-ai', signIn: 'opencode auth login',
        help: ['run', '--help'], flags: ['--pure', '--format', '--print-logs', '--log-level'],
        environment: ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'],
        // OpenCode merges this over the user's configuration last, and a denied tool is not offered at all.
        // Each permission is replaced whole, so a user rule allowing part of it cannot survive; read, glob,
        // grep and list keep the user's rules. An ask would wait for a person nobody is, so the
        // repository, outside the working directory, is allowed outright. --pure skips external plugins.
        fixedEnvironment: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'deny', bash: 'deny', task: 'deny', todowrite: 'deny', question: 'deny', webfetch: 'deny',
            websearch: 'deny', lsp: 'deny', doom_loop: 'deny', skill: 'deny', external_directory: 'allow' }) },
        restriction: 'opencode run with OPENCODE_PERMISSION denying edit, bash, task, web, skill, question, todowrite and lsp',
        // OpenCode's error event says only "Unexpected server error"; its error log on stderr says which.
        argv: (run: Invocation) => ['run', '--pure', '--format', 'json', '--print-logs', '--log-level', 'ERROR', run.prompt],
        read: (stdout: string): Reading => {
            const events = jsonLines(stdout, 'an OpenCode event line')
            if (events.some(event => event.type === 'error')) throw new ToolReportedFailure(`OpenCode reported an error: ${opencodeCause(stdout, '') ?? 'no message'}`)
            const sessions = new Set(events.map(event => event.sessionID))
            const [sessionId] = sessions
            if (sessions.size !== 1 || typeof sessionId !== 'string' || !sessionId) throw new RefusalError('OpenCode named no single session identity')
            const text = events.filter(event => event.type === 'text').at(-1)?.part as { text?: unknown } | undefined
            if (typeof text?.text !== 'string') throw new RefusalError('OpenCode returned no final answer')
            return { sessionId, answer: text.text }
        },
        cause: opencodeCause,
    }),
} satisfies Record<EvaluatorTool, unknown>)

// Every value the output schema admits, checked here for every tool: OpenCode has no flag that
// constrains its answer, and the schema a tool enforced is only as good as that tool's own check.
function schemaViolation(schema: Readonly<Record<string, unknown>>, value: unknown, path: string): string | undefined {
    const types = ([] as unknown[]).concat(schema.type ?? [])
    const matches = (type: unknown) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
        : type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
            : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type
    if (!types.some(matches)) return `${path} is not ${types.join(' or ')}`
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} is not one of ${schema.enum.join(', ')}`
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            const found = schemaViolation(schema.items as Record<string, unknown>, item, `${path}[${index}]`); if (found) return found
        }
    } else if (typeof value === 'object' && value !== null) {
        const properties = schema.properties as Readonly<Record<string, Readonly<Record<string, unknown>>>>
        const extra = Object.keys(value).find(key => !Object.hasOwn(properties, key)); if (extra !== undefined) return `${path} has the undeclared field ${extra}`
        for (const [key, property] of Object.entries(properties)) {
            if (!Object.hasOwn(value, key)) return `${path} lacks ${key}`
            const found = schemaViolation(property, (value as Record<string, unknown>)[key], `${path}.${key}`); if (found) return found
        }
    }
    return undefined
}

async function findExecutable(directories: readonly string[], name: string): Promise<Readonly<{ state: 'available'; value: Executable }> | Readonly<{ state: 'unavailable'; reason: string }>> {
    let reason = `Executable ${name} is unavailable`
    for (const directory of directories) {
        if (!isAbsolute(directory)) continue
        const resolved = await resolveExecutablePath(join(directory, name))
        if (resolved.state !== 'available') { reason = resolved.reason; continue }
        let bytes: number
        try { bytes = lstatSync(resolved.value.canonicalPath).size }
        catch (error) { reason = `Executable ${name} is unavailable: ${errorCause(error)}`; continue }
        return Object.freeze({ state: 'available', value: Object.freeze({ path: resolved.value.canonicalPath, sha256: resolved.value.sha256, bytes }) })
    }
    return Object.freeze({ state: 'unavailable', reason })
}

const missingMessage = (tool: EvaluatorTool, reason: string) => {
    const spec = TOOLS[tool]
    return `${spec.name} (${EVALUATOR_COMMANDS[tool]}) is not on PATH (${reason}); install it with ${spec.install} and sign in with ${spec.signIn}`
}

/** The listed tools found on the search path, without running them: what doctor reports. */
export async function findEvaluators(tools: readonly EvaluatorTool[], directories: readonly string[]): Promise<Readonly<{
    found: readonly EvaluatorTool[]; missing: readonly EvaluationAttempt[]
}>> {
    const found: EvaluatorTool[] = []; const missing: EvaluationAttempt[] = []
    for (const tool of tools) {
        const located = await findExecutable(directories, EVALUATOR_COMMANDS[tool])
        if (located.state === 'available') found.push(tool)
        else missing.push(Object.freeze({ tool, code: ENVIRONMENT_CODES.EVALUATOR_UNAVAILABLE, message: missingMessage(tool, located.reason) }))
    }
    return Object.freeze({ found: Object.freeze(found), missing: Object.freeze(missing) })
}

/** No listed evaluator can run here; one literal fix so the diagnostic inventory captures it. */
export function evaluatorUnavailable(message: string) {
    return Object.freeze({
        code: 'EVALUATOR_UNAVAILABLE' as const satisfies typeof ENVIRONMENT_CODES.EVALUATOR_UNAVAILABLE,
        message,
        fix: 'install and sign in to an agent tool workorders.evaluators lists (codexcli: npm install -g @openai/codex, then codex login; claudecode: npm install -g @anthropic-ai/claude-code, then claude auth login; opencode: npm install -g opencode-ai, then opencode auth login), or list one you have, then run npx --no cockpit doctor --config <your cockpit.toml>',
    })
}

type StepOutcome = Readonly<{ kind: 'complete'; stdout: string; stderr: string }>
    | Readonly<{ kind: 'failed'; code: string; exitCode?: number; stdout: string; stderr: string }>

async function runStep(executable: Executable, args: readonly string[], options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number
    stdoutLimitBytes: number; labels: Readonly<Record<string, string>>; consumed?: readonly ConsumedFile[]; paths?: readonly string[] }>): Promise<StepOutcome> {
    const argv = Object.freeze([executable.path, ...args]) as readonly [string, ...string[]]
    const step: ExecutionStep = Object.freeze({ id: `evaluator-${randomUUID()}`, argv, argv0: executable.path, cwd: options.cwd, env: Object.freeze({ ...options.env }),
        timeoutMs: options.timeoutMs, spawnNotAfter: new Date(Date.now() + options.timeoutMs).toISOString(), stdoutLimitBytes: options.stdoutLimitBytes, stderrLimitBytes: STDERR_LIMIT_BYTES,
        paths: Object.freeze([...options.paths ?? []]), ports: Object.freeze([]), labels: Object.freeze({ ...options.labels }), expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({ path: executable.path, sha256: executable.sha256, maxBytes: executable.bytes, argvIndexes: Object.freeze([0]), executable: true, executionMode: 'verified-path' as const }),
            ...options.consumed ?? []]),
        filesystemChecks: Object.freeze([Object.freeze({ path: options.cwd, expected: 'directory' as const })]), compensation: Object.freeze([]) })
    const outcome = authenticatedExecutionOutcome(await executeProbe(step), step)
    if (!outcome) return { kind: 'failed', code: 'UNAUTHENTICATED', stdout: '', stderr: '' }
    const decode = (bytes: Buffer) => new TextDecoder('utf-8').decode(bytes)
    if (outcome.kind === 'complete') return { kind: 'complete', stdout: decode(outcome.stdout), stderr: decode(outcome.stderr) }
    return { kind: 'failed', code: outcome.code, ...outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED ? { exitCode: outcome.execution.exitCode } : {},
        stdout: decode(outcome.stdout), stderr: decode(outcome.stderr) }
}

// A probe's result holds for the executable bytes it ran, so a tool is probed once per process.
const probed = new Map<string, string | null>()

async function probe(tool: EvaluatorTool, executable: Executable, directories: readonly string[]): Promise<string | null> {
    const key = `${tool}\0${executable.path}\0${executable.sha256}`
    if (probed.has(key)) return probed.get(key)!
    const spec = TOOLS[tool]
    const cwd = realpathSync(tmpdir())
    const env = { PATH: directories.join(delimiter), TMPDIR: tmpdir() }
    const options = { cwd, env, timeoutMs: PROBE_TIMEOUT_MS, stdoutLimitBytes: STDERR_LIMIT_BYTES, labels: { owner: 'independent-evaluator-probe', tool } }
    const version = await runStep(executable, ['--version'], options)
    const help = await runStep(executable, spec.help, options)
    let problem: string | null = null
    if (version.kind !== 'complete' || !version.stdout.trim()) {
        problem = `${spec.name} at ${executable.path} did not report its version: ${version.kind === 'complete' ? 'no output' : version.exitCode === undefined ? version.code : `exit ${version.exitCode}`}`
    } else {
        // OpenCode prints its help on stderr.
        const text = help.kind === 'complete' ? `${help.stdout}\n${help.stderr}` : ''
        const missing = spec.flags.filter(flag => !text.includes(flag))
        if (missing.length) problem = `${spec.name} at ${executable.path} does not offer ${[EVALUATOR_COMMANDS[tool], ...spec.help.slice(0, -1)].join(' ')} ${missing.join(' ')}; update it, then rerun`
    }
    probed.set(key, problem)
    return problem
}

/** Finds and probes each listed tool in order; one that is missing or too old is passed over and recorded. */
export async function locateEvaluators(tools: readonly EvaluatorTool[], directories: readonly string[]): Promise<EvaluatorChain> {
    const located: { tool: EvaluatorTool; executable: Executable }[] = []; const skipped: EvaluationAttempt[] = []
    for (const tool of tools) {
        const found = await findExecutable(directories, EVALUATOR_COMMANDS[tool])
        if (found.state !== 'available') { skipped.push(Object.freeze({ tool, code: ENVIRONMENT_CODES.EVALUATOR_UNAVAILABLE, message: missingMessage(tool, found.reason) })); continue }
        const problem = await probe(tool, found.value, directories)
        if (problem) skipped.push(Object.freeze({ tool, code: ENVIRONMENT_CODES.EVALUATOR_UNAVAILABLE, message: problem }))
        else located.push(Object.freeze({ tool, executable: found.value }))
    }
    return Object.freeze({ located: Object.freeze(located), skipped: Object.freeze(skipped) })
}

type AttemptResult = Readonly<{ kind: 'answer'; value: Record<string, unknown>; sessionId: string }>
    | Readonly<{ kind: 'unavailable'; message: string }>
    | Readonly<{ kind: 'invalid'; message: string }>

async function attempt(tool: EvaluatorTool, executable: Executable, request: EvaluationRequest): Promise<AttemptResult> {
    const spec = TOOLS[tool]
    const observed = await findExecutable([dirname(executable.path)], executable.path.slice(dirname(executable.path).length + 1))
    if (observed.state !== 'available' || JSON.stringify(observed.value) !== JSON.stringify(executable)) {
        return { kind: 'unavailable', message: `${spec.name} at ${executable.path} is unavailable or changed since cockpit inspected it${observed.state === 'unavailable' ? ` (${observed.reason})` : ''}` }
    }
    const documentBytes = JSON.stringify({ ...request.document, restriction: spec.restriction })
    if (Buffer.byteLength(documentBytes) > MAX_DOCUMENT_BYTES) return { kind: 'invalid', message: 'the evaluation request exceeds its bound' }
    const runRoot = await mkdtemp(join(realpathSync(tmpdir()), 'cockpit-work-actor-'))
    const requestPath = join(runRoot, 'request.json'); const schemaPath = join(runRoot, 'schema.json'); const responsePath = join(runRoot, 'response.json')
    try {
        const staging = lstatSync(runRoot)
        if (!staging.isDirectory() || staging.isSymbolicLink() || realpathSync(runRoot) !== runRoot || (staging.mode & 0o777) !== 0o700) {
            return { kind: 'invalid', message: 'the evaluator run directory is not a private canonical directory' }
        }
        const schema = JSON.stringify(request.schema)
        await writeFile(requestPath, documentBytes, { flag: 'wx', mode: 0o600 })
        await writeFile(schemaPath, schema, { flag: 'wx', mode: 0o600 })
        const requestDigest = digest(readFileSync(requestPath))
        const prompt = `Read exactly the request JSON at ${requestPath} with SHA-256 ${requestDigest}; follow its fixed evaluator instruction and reply with only one JSON object, and no other text, that matches the JSON Schema at ${schemaPath}.`
        // Agent tools load instruction files and project configuration from their working root, and in
        // the repository those are files the graded agent can write. The private run directory holds
        // only the request and schema, so the repository is named in the request instead.
        const run: Invocation = Object.freeze({ runRoot, repository: request.repository, schemaPath, schema, responsePath, prompt })
        const args = spec.argv(run)
        const env: Record<string, string> = { ...spec.fixedEnvironment, PATH: request.executableDirectories.join(delimiter) }
        for (const name of spec.environment) { const value = request.environment[name]; if (value) env[name] = value }
        const schemaIndex = args.indexOf(schemaPath)
        const outcome = await runStep(executable, args, { cwd: runRoot, env, timeoutMs: request.timeoutMs, stdoutLimitBytes: STDOUT_LIMIT_BYTES, paths: [responsePath],
            labels: { owner: 'independent-evaluator', role: request.role, tool, requestDigest },
            consumed: schemaIndex === -1 ? [] : [Object.freeze({ path: schemaPath, sha256: digest(schema), maxBytes: ANSWER_LIMIT_BYTES, argvIndexes: Object.freeze([schemaIndex + 1]), executable: false })] })
        if (outcome.kind === 'failed') {
            const reported = spec.cause(outcome.stdout, outcome.stderr)
            if (outcome.code === ENVIRONMENT_CODES.EXECUTION_TIMEOUT) {
                // OpenCode keeps retrying a rejected request (a free model's usage limit among them) until stopped.
                return { kind: 'unavailable', message: `${spec.name} timed out after ${request.timeoutMs / 1_000} seconds${reported ? ` after reporting: ${reported.slice(-CAUSE_CHARACTERS)}` : ''}; raise ${request.timeoutField}` }
            }
            if (outcome.code === ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT || outcome.code === ENVIRONMENT_CODES.EXECUTION_STDERR_LIMIT) {
                return { kind: 'invalid', message: `${spec.name} output exceeded its ${outcome.code === ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT ? STDOUT_LIMIT_BYTES : STDERR_LIMIT_BYTES}-byte capture` }
            }
            if (outcome.exitCode === undefined) return { kind: 'unavailable', message: `${spec.name} did not run to completion: ${outcome.code}` }
            const cause = (reported ?? outcome.stderr).trim().slice(-CAUSE_CHARACTERS) || 'no error event or stderr output'
            return { kind: 'unavailable', message: `${spec.name} exited with status ${outcome.exitCode}: ${cause}; if it is not signed in, run ${spec.signIn}, then rerun` }
        }
        const { sessionId, answer } = spec.read(outcome.stdout, run)
        if (answeredSessions.has(sessionId)) return { kind: 'invalid', message: `${spec.name} answered in session ${sessionId}, which already answered another evaluation` }
        answeredSessions.add(sessionId)
        if (Buffer.byteLength(answer) > ANSWER_LIMIT_BYTES) return { kind: 'invalid', message: 'the evaluator answer exceeds its bound' }
        const value = strictJson(answer, 'the evaluator answer', 'the object its output schema declares')
        const violation = schemaViolation(request.schema, value, 'answer')
        if (violation) return { kind: 'invalid', message: `the evaluator answer does not match its output schema: ${violation}` }
        return { kind: 'answer', value: value as Record<string, unknown>, sessionId }
    } catch (error) {
        if (error instanceof ToolReportedFailure) return { kind: 'unavailable', message: error.message }
        return { kind: 'invalid', message: `${spec.name} answer could not be read: ${errorCause(error)}` }
    } finally { await rm(runRoot, { recursive: true }) }
}

/**
 * Runs the first tool in the chain that answers. A tool that cannot run here (missing, signed out,
 * rate-limited, timed out) is recorded and the next is tried; an answer that cannot be trusted is refused
 * outright, since trying another tool then would shop for a verdict.
 */
export async function evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const attempts: EvaluationAttempt[] = [...request.chain.skipped]
    for (const { tool, executable } of request.chain.located) {
        const result = await attempt(tool, executable, request)
        if (result.kind === 'answer') return Object.freeze({ kind: 'answer', value: Object.freeze(result.value), sessionId: result.sessionId, tool, fallbacks: Object.freeze(attempts) })
        if (result.kind === 'invalid') {
            return Object.freeze({ kind: 'refusal', attempts: Object.freeze([...attempts, Object.freeze({ tool, code: ENVIRONMENT_CODES.EVALUATOR_ANSWER_INVALID, message: result.message })]),
                code: 'EVALUATOR_ANSWER_INVALID' as const satisfies typeof ENVIRONMENT_CODES.EVALUATOR_ANSWER_INVALID, message: result.message,
                fix: 'rerun the command; if the answer is refused again, list another evaluator first in workorders.evaluators' })
        }
        attempts.push(Object.freeze({ tool, code: ENVIRONMENT_CODES.EVALUATOR_RUN_FAILED, message: result.message }))
    }
    const message = attempts.map(row => row.message).join('; then ') || 'workorders.evaluators lists no evaluator'
    if (attempts.every(row => row.code === ENVIRONMENT_CODES.EVALUATOR_UNAVAILABLE)) return Object.freeze({ kind: 'refusal', attempts: Object.freeze(attempts), ...evaluatorUnavailable(message) })
    return Object.freeze({ kind: 'refusal', attempts: Object.freeze(attempts), message,
        code: 'EVALUATOR_RUN_FAILED' as const satisfies typeof ENVIRONMENT_CODES.EVALUATOR_RUN_FAILED,
        fix: 'read the message for the cause each evaluator reported: sign in to it, wait out its usage limit, or raise workorders.evaluator_timeout_seconds, then rerun the command' })
}
