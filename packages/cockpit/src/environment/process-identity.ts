// What identifies a process on this machine: whether its pid exists and when it started, read
// through the executor. Holders of a stack and of a state lock are judged gone by the same rule.
import { readFile } from 'node:fs/promises'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, isCanonicalTimestamp, snapshotExecutionPlan, type ExecutionStep } from './contract.js'
import { resolveExecutablePath, type ResolvedExecutable } from './executable.js'

export type ProcessStartObservation =
    | { readonly state: 'absent' }
    | { readonly state: 'present'; readonly start: string }
    | { readonly state: 'unknown'; readonly reason: string }

/** What observing a process reads from this machine; production binds it with `processHost`. */
export interface ProcessHost {
    readonly platform: NodeJS.Platform
    /** Whether the pid exists, by signal 0; anything short of proof of absence is `live` or `unavailable`. */
    readonly presence: (pid: number) => Promise<'live' | 'absent' | 'unavailable'>
    /** `ps -o lstart=` for the pid under a fixed locale and zone. */
    readonly psStart: (pid: number) => Promise<{ readonly kind: 'complete'; readonly text: string } | { readonly kind: 'failed'; readonly reason: string }>
    /** A file's UTF-8 text; rejects with the read's errno error. */
    readonly readFile: (path: string) => Promise<string>
}

const PS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LSTART_START = /^lstart:(.+)$/
const PROC_START = /^proc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$/

/** A start identity as `observeProcessStart` reports it: `lstart:<timestamp>` or `proc:<boot id>:<ticks>`. */
export function isProcessStart(value: unknown): value is string {
    return typeof value === 'string' && (PROC_START.test(value) || isCanonicalTimestamp(LSTART_START.exec(value)?.[1]))
}

const startKind = (start: string): string => start.slice(0, start.indexOf(':'))

/**
 * Whether an observation proves gone the process recorded with `processStart`. A gone pid proves it
 * whether or not a start was recorded, since reuse can only make a dead process look alive; a start
 * identity decides only against one read the same way.
 */
export function isProcessGone(processStart: string | undefined, observed: ProcessStartObservation): boolean {
    return observed.state === 'absent' || observed.state === 'present' && processStart !== undefined
        && startKind(observed.start) === startKind(processStart) && observed.start !== processStart
}

// A pid alone does not name a holder: the pid of a killed session is reused, and a reused pid read
// as the session would wedge its stack for as long as the stranger runs. So a session records its
// process's start identity, and a holder is dead when its pid is gone or now belongs to a process
// with another identity. On Linux the identity is the start in clock ticks since boot (field 22 of
// /proc/<pid>/stat) with the boot's ID: ps derives a wall-clock start from the boot time, which moves
// whenever the wall clock is stepped (NTP, a resumed VM), so a running session would read as a
// stranger and lose its hold. macOS records the wall-clock start once, and ps prints it to the
// second under a fixed locale and zone. Each identity names how it was read; anything that cannot
// be confirmed reads as unknown, and unknown is never dead.
export async function observeProcessStart(pid: number, host: ProcessHost): Promise<ProcessStartObservation> {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return { state: 'unknown', reason: `process id ${pid} is invalid` }
    const presence = await host.presence(pid)
    if (presence === 'absent') return { state: 'absent' }
    if (presence !== 'live') return { state: 'unknown', reason: `the presence of process ${pid} could not be confirmed` }
    return host.platform === 'linux' ? observeProcStart(pid, host) : observeLstart(pid, host)
}

async function observeProcStart(pid: number, host: ProcessHost): Promise<ProcessStartObservation> {
    let stat: string
    try { stat = await host.readFile(`/proc/${pid}/stat`) } catch (error) {
        // Signal 0 just found it, so a missing entry means it exited since, unless this /proc is not
        // this pid namespace's (unmounted in a chroot or sandbox); only a second signal decides.
        if (hasErrorCode(error, 'ENOENT') && await host.presence(pid) === 'absent') return { state: 'absent' }
        return { state: 'unknown', reason: `/proc/${pid}/stat could not be read (${errorCause(error)})` }
    }
    let bootId: string
    try { bootId = (await host.readFile('/proc/sys/kernel/random/boot_id')).trim() } catch (error) {
        return { state: 'unknown', reason: `the boot ID could not be read (${errorCause(error)})` }
    }
    // The command name in parentheses may itself hold spaces and parentheses; the fields after the
    // last `)` start at field 3, so field 22 is the twentieth.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    if (stat.lastIndexOf(')') === -1 || ticks === undefined || !/^[0-9]{1,20}$/.test(ticks) || !BOOT_ID.test(bootId)) {
        return { state: 'unknown', reason: `/proc reported an unrecognised start for process ${pid}` }
    }
    return { state: 'present', start: `proc:${bootId}:${ticks}` }
}

async function observeLstart(pid: number, host: ProcessHost): Promise<ProcessStartObservation> {
    const started = await host.psStart(pid)
    if (started.kind === 'failed') return { state: 'unknown', reason: started.reason }
    const match = PS_START.exec(started.text.trim())
    if (!match) return { state: 'unknown', reason: `ps reported an unrecognised start time for process ${pid}` }
    const [, month, day, hours, minutes, seconds, year] = match
    const startedAt = new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hours), Number(minutes), Number(seconds)))
    return Number.isNaN(startedAt.getTime()) ? { state: 'unknown', reason: `ps reported an invalid start time for process ${pid}` }
        : { state: 'present', start: `lstart:${startedAt.toISOString()}` }
}

/** The production `ProcessHost`: signal 0 and ps cross the executor, and /proc is read directly. */
export function processHost(execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>): ProcessHost {
    return {
        platform: process.platform,
        presence: async (pid: number) => {
            const node = await resolveExecutablePath(process.execPath)
            if (node.state !== 'available') return 'unavailable' as const
            const answer = await runBoundedProbe(node.value, `process:presence:${pid}`, ['-e', PROCESS_PRESENCE_PROBE, String(pid)], {}, execute)
            return answer === 'live' || answer === 'absent' ? answer : 'unavailable' as const
        },
        psStart: async (pid: number) => {
            const ps = await firstExecutable(PS_PATHS)
            if (!ps) return { kind: 'failed' as const, reason: 'ps is not installed at /bin/ps or /usr/bin/ps' }
            const text = await runBoundedProbe(ps, `process:start:${pid}`, ['-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C', TZ: 'UTC0' }, execute)
            return text === undefined
                ? { kind: 'failed' as const, reason: `ps did not report when process ${pid} started; a sandbox can refuse to run ps, so if one is in use, run this command outside it` }
                : { kind: 'complete' as const, text }
        },
        readFile: (path: string) => readFile(path, 'utf8'),
    }
}

// Reports `live` or `absent` for a pid; twice, so a transient answer reads as `unavailable`.
const PROCESS_PRESENCE_PROBE = "const p=Number(process.argv[1]);const c=()=>{try{process.kill(p,0);return'live'}catch(e){return e&&e.code==='ESRCH'?'absent':'unavailable'}};const a=c(),b=c();process.stdout.write(a===b?a:'unavailable')"

export const PS_PATHS = ['/bin/ps', '/usr/bin/ps'] as const

export async function firstExecutable(candidates: readonly string[]): Promise<ResolvedExecutable | undefined> {
    for (const candidate of candidates) {
        const resolved = await resolveExecutablePath(candidate)
        if (resolved.state === 'available') return resolved.value
    }
    return undefined
}

export interface ProbeBounds {
    readonly timeoutMs: number
    readonly stdoutLimitBytes: number
    readonly exitCodes: readonly number[]
}

// One short read-only step through the executor; its stdout when it exits with an accepted code, otherwise undefined.
export async function runBoundedProbe(
    executable: ResolvedExecutable,
    id: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
    bounds: ProbeBounds = { timeoutMs: 5_000, stdoutLimitBytes: 256, exitCodes: [0] },
): Promise<string | undefined> {
    const step = snapshotExecutionPlan({ steps: [{
        id, argv: [executable.canonicalPath, ...args] as const,
        argv0: executable.invocationPath, cwd: '/', env: { ...env }, timeoutMs: bounds.timeoutMs,
        stdoutLimitBytes: bounds.stdoutLimitBytes, stderrLimitBytes: 1_024, paths: [], ports: [],
        labels: { probe: id }, expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
            argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks: [], compensation: [],
    }] })?.steps[0]
    if (!step) return undefined
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    if (outcome?.kind === 'complete') return outcome.execution.exitCode === 0 ? Buffer.from(outcome.stdout).toString('utf8') : undefined
    // The executor reports a nonzero exit as a failed step. Only a process that exited by itself with
    // an accepted code counts; a timeout, an output limit or a signal carries another code or a signal.
    return outcome?.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED && outcome.receipt !== undefined
        && outcome.execution.signal === null && bounds.exitCodes.includes(outcome.execution.exitCode)
        ? Buffer.from(outcome.stdout).toString('utf8') : undefined
}
