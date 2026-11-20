import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import { readBoundedInput } from '../../config/load.js'
import { guardParity, parseGuardCases, readHookAnswer, renderGuardParity, type ComparedCase, type GuardCase, type HookVerdict, type GuardParity } from '../../guards/guard-import.js'
import { refusalOutcome } from '../../refusal.js'
import { ENVIRONMENT_CODES, errorCause, type Diagnostic, type ExecutionStep } from '../contract.js'
import { resolveExecutablePath, type ResolvedExecutable } from '../executable.js'
import { mapLimit } from '../map-limit.js'
import { confinedPath } from './shared.js'
import { guardCommandInvocations } from './guard.js'

export interface GuardImportInput {
    readonly configPath: string
    /** The team's PreToolUse hook program, absolute. */
    readonly hookScript: string
    /** The JSON cases file, absolute. */
    readonly casesFile: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface GuardImportAdapters {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
}

export type GuardImportOutcome = Readonly<{ status: 0 | 2; artifact: string | null; destination: null; diagnostics: readonly Diagnostic[]; result: GuardParity | null }>

// cockpit registers its own guard hook with a 30-second timeout, so either hook gets as long as an agent tool would give it.
const HOOK_TIMEOUT_MS = 30_000
const HOOK_OUTPUT_BYTES = 65_536
// Hooks start a process each; a few at a time keeps hundreds of cases quick without loading the machine.
const PARALLEL_CASES = 4
const COCKPIT_GUARD = '.cockpit/guards/bash-guard.sh'

type Program = Readonly<{ executable: ResolvedExecutable; bytes: number }>

function hookStep({ executable, bytes }: Program, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, payload: string): ExecutionStep {
    return { id: `guard-import-${randomUUID()}`, argv: [executable.canonicalPath, ...args], argv0: executable.invocationPath, cwd, env,
        timeoutMs: HOOK_TIMEOUT_MS, spawnNotAfter: new Date(Date.now() + HOOK_TIMEOUT_MS).toISOString(),
        stdoutLimitBytes: HOOK_OUTPUT_BYTES, stderrLimitBytes: HOOK_OUTPUT_BYTES, stdin: payload,
        paths: [], ports: [], labels: { owner: 'guard-import' }, expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: bytes,
            argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
        filesystemChecks: [{ path: cwd, expected: 'directory' }], compensation: [] }
}

async function judge(adapters: GuardImportAdapters, step: ExecutionStep): Promise<HookVerdict> {
    const outcome = authenticatedExecutionOutcome(await adapters.execute(step), step)
    if (!outcome) return { decision: 'error', reason: 'its outcome could not be authenticated as the step cockpit issued' }
    const text = (bytes: Buffer) => new TextDecoder('utf-8').decode(bytes)
    if (outcome.kind === 'complete') return readHookAnswer({ exitCode: 0, stdout: text(outcome.stdout), stderr: text(outcome.stderr) })
    if (outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED && outcome.receipt !== undefined) {
        return readHookAnswer({ exitCode: outcome.execution.exitCode, stdout: text(outcome.stdout), stderr: text(outcome.stderr) })
    }
    if (outcome.code === ENVIRONMENT_CODES.EXECUTION_TIMEOUT) return { decision: 'error', reason: `gave no answer within ${HOOK_TIMEOUT_MS / 1_000} seconds` }
    return { decision: 'error', reason: `did not run to completion (${outcome.code})` }
}

/**
 * Replays every case through the team's hook and cockpit's installed guard, each given the PreToolUse
 * payload Claude Code would send for a Bash call. A hook judges the payload and runs nothing it
 * names, but the hook itself is a program, so it runs with only PATH, HOME and CLAUDE_PROJECT_DIR,
 * under a timeout, and the outcome says that it ran.
 */
export async function runGuardImportApplication(input: GuardImportInput, adapters: GuardImportAdapters): Promise<GuardImportOutcome> {
    let root: string
    try { root = realpathSync(dirname(resolve(input.configPath))) }
    catch (error) { return refusalOutcome('ADOPT_INPUT_UNAVAILABLE', `the cockpit root of ${input.configPath} cannot be read: ${errorCause(error)}`, '--config') }
    let cases: readonly GuardCase[]
    try {
        const read = await readBoundedInput(input.casesFile)
        if (read.kind !== 'complete') return refusalOutcome('ADOPT_INPUT_UNAVAILABLE', `${input.casesFile} is larger than a cases file may be`, '--cases')
        const parsed = parseGuardCases(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
        if ('refusal' in parsed) return refusalOutcome('ADOPT_CASES_INVALID', `${input.casesFile}: ${parsed.refusal}`, '--cases')
        cases = parsed.cases
    } catch (error) { return refusalOutcome('ADOPT_INPUT_UNAVAILABLE', `${input.casesFile} cannot be read: ${errorCause(error)}`, '--cases') }
    const old = await resolveExecutablePath(input.hookScript)
    if (old.state !== 'available') return refusalOutcome('ADOPT_INPUT_UNAVAILABLE',
        `${input.hookScript} cannot be run as a hook (${old.reason}); a hook is an executable file with a #! line, as the agent tool runs it`, '--import-guard')
    const shell = await resolveExecutablePath('/bin/bash')
    if (shell.state !== 'available') return refusalOutcome('ADOPT_INPUT_UNAVAILABLE', `cockpit's guard runs under /bin/bash, which is unavailable: ${shell.reason}`)
    const guard = join(root, COCKPIT_GUARD)
    const sync = `run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${input.configPath}`
    try { statSync(guard) }
    catch { return refusalOutcome('ADOPT_INPUT_UNAVAILABLE', `${guard} does not exist, so there is no cockpit guard to compare with`, '--config', sync) }
    let programs: Readonly<{ old: Program; cockpit: Program }>
    try {
        programs = { old: { executable: old.value, bytes: statSync(old.value.canonicalPath).size },
            cockpit: { executable: shell.value, bytes: statSync(shell.value.canonicalPath).size } }
    } catch (error) { return refusalOutcome('ADOPT_INPUT_UNAVAILABLE', `a hook program could not be read: ${errorCause(error)}`, '--import-guard') }
    const directories = new Map<GuardCase, string>()
    for (const row of cases) {
        const invalid = (why: string) => refusalOutcome('ADOPT_CASES_INVALID', `case ${JSON.stringify(row.id)} names cwd ${JSON.stringify(row.cwd)}, which ${why}`, '--cases')
        let cwd: string
        try { cwd = realpathSync(resolve(root, row.cwd ?? '.')) } catch (error) { return invalid(`cannot be resolved: ${errorCause(error)}`) }
        if (!confinedPath(root, cwd)) return invalid(`is outside the cockpit root ${root}`)
        if (!statSync(cwd).isDirectory()) return invalid('is not a directory')
        directories.set(row, cwd)
    }
    const env = Object.fromEntries(Object.entries({ PATH: input.env.PATH, HOME: input.env.HOME, CLAUDE_PROJECT_DIR: root })
        .filter((entry): entry is [string, string] => entry[1] !== undefined))
    const payload = (command: string, cwd: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd })
    const cockpitGuard = (command: string, cwd: string) => judge(adapters, hookStep(programs.cockpit, [guard, '--harness', 'claudecode'], cwd, env, payload(command, cwd)))
    // The Claude Code adapter answers deny for a guard that cannot judge at all (a stale or missing
    // identity, a moved Node), which would read as cockpit refusing every case.
    const control = await cockpitGuard('pwd', root)
    if (control.decision !== 'allow') return refusalOutcome('ADOPT_COCKPIT_GUARD_UNAVAILABLE',
        `cockpit's guard did not allow \`pwd\` in ${root} (${control.decision}: ${control.reason}), so its answers would not be judgements of the cases`, '--config', sync)
    const compared = await mapLimit(cases, PARALLEL_CASES, async (row): Promise<ComparedCase> => {
        const cwd = directories.get(row)!
        const [previous, cockpit] = await Promise.all([
            judge(adapters, hookStep(programs.old, [], cwd, env, payload(row.command, cwd))),
            cockpitGuard(row.command, cwd),
        ])
        return { case: row, cwd, old: previous, cockpit }
    })
    const parity = guardParity(compared, guardCommandInvocations)
    const diagnostics: Diagnostic[] = [{ severity: 'warning', code: 'ADOPT_HOOK_EXECUTED', target: input.hookScript,
        message: `ran ${input.hookScript} once per case, with only PATH, HOME and CLAUDE_PROJECT_DIR set and a ${HOOK_TIMEOUT_MS / 1_000}-second timeout; it was given each command to judge, and cockpit ran none of the commands` }]
    // A comparison with holes is not a parity result.
    if (parity.errors.length) diagnostics.push({ severity: 'error', code: 'ADOPT_CASES_UNCOMPARED', target: '--cases',
        message: `a hook failed on ${parity.errors.length} of ${parity.cases} cases (${parity.errors.map(row => row.case.id).join(', ')}), so they were not compared; the report names why` })
    return { status: parity.errors.length ? 2 : 0, artifact: renderGuardParity(parity), destination: null, diagnostics, result: parity }
}
