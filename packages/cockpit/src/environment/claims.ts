import { z } from 'zod'
import { lstat, opendir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { MAX_COLD_START_SECONDS, STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import {
    hasErrorCode,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    type CheckoutId,
    type CockpitId,
    type EnvironmentCode,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type HolderId,
    type ExecutionStep,
    type StackId,
} from './contract.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { firstExecutable, isProcessGone, isProcessStart, observeProcessStart, processHost, PS_PATHS, runBoundedProbe, type ProcessHost, type ProcessStartObservation } from './process-identity.js'
import {
    abortStateTransaction,
    inspectStateLock,
    issueStateScopedLock,
    parseCoordinationStateEntry,
    readState,
    SERIALIZED_RECORD_BYTE_LIMIT,
    snapshotStateNamespace,
    transactState,
    withStateNamespaceInventory,
    withStateScopedLock,
    type SkippedStateNamespace,
    type StateNamespace,
    type StateRecord,
    type StateResult,
    type StateTransactionAbort,
    type StateTransactionOptions,
} from './state.js'

const OWNER = 'environment-claims'

export const observationDeclarations = Object.freeze([
    { id: 'claim-state', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'not-applicable', reason: 'claims do not exist before the first seed' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY },
] as const)

export async function observeClaimState(input: { readonly namespace: StateNamespace; readonly stackId: StackId; readonly observedAt: string }): Promise<EnvironmentObservation> {
    const namespace = snapshotStateNamespace(input.namespace)
    if (!namespace || !/^stack:[a-f0-9]{64}$/.test(input.stackId) || !isCanonicalTimestamp(input.observedAt)) {
        throw new RefusalError('claim observation input is malformed')
    }
    const inventory = await readActiveStackInventory(namespace)
    const refusal = inventory.kind === 'refusal' ? inventory.diagnostics[0] : undefined
    return {
        code: ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY,
        owner: OWNER,
        stackId: input.stackId,
        source: namespace.paths.coordination(input.stackId).path,
        observed: refusal
            ? { state: 'failed', reason: refusal.message, observedAt: input.observedAt }
            : { state: 'available', value: true, observedAt: input.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' },
        remedy: 'repair or release malformed coordination state',
    }
}

const holderIdentity = /^holder:[a-f0-9]{64}:session$/
const checkoutIdentity = /^checkout:[a-f0-9]{64}$/
const stackIdentity = /^stack:[a-f0-9]{64}$/

const ClaimHolderSchema = z.object({
    holderId: z.string().regex(holderIdentity),
    checkoutId: z.string().regex(checkoutIdentity),
    claimedAt: z.string().refine(isCanonicalTimestamp),
    pid: z.number().int().positive().max(2_147_483_647).optional(),
    processStart: z.string().refine(isProcessStart).optional(),
}).strict().refine((holder) => holder.processStart === undefined || holder.pid !== undefined)

const PortLeaseRecordSchema = z.object({
    offset: z.number().int().nonnegative().safe(),
    ports: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.number().int().min(1).max(65535))
        .refine((ports) => Object.keys(ports).length > 0)
        .refine((ports) => new Set(Object.values(ports)).size === Object.keys(ports).length),
    released: z.boolean(),
    declaration: z.object({
        step: z.number().int().positive().safe(),
        count: z.number().int().positive().safe(),
        bases: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.number().int().min(1).max(65535))
            .refine((bases) => Object.keys(bases).length > 0)
            .refine((bases) => new Set(Object.values(bases)).size === Object.keys(bases).length),
    }).strict(),
}).strict().superRefine((lease, context) => {
    const portKeys = Object.keys(lease.ports).sort()
    const baseKeys = Object.keys(lease.declaration.bases).sort()
    const candidate = lease.offset % lease.declaration.step === 0
        && lease.offset / lease.declaration.step < lease.declaration.count
    const derived = baseKeys.every((key) => lease.ports[key] === lease.declaration.bases[key]! + lease.offset)
    if (!candidate || portKeys.join('\0') !== baseKeys.join('\0') || !derived) {
        context.addIssue({ code: 'custom', message: 'lease does not match its declaration' })
    }
})

const CoordinationValueSchema = z.object({
    holders: z.array(ClaimHolderSchema).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    lease: PortLeaseRecordSchema.nullable(),
    lastReleasedHolder: z.string().regex(holderIdentity).nullable().optional().default(null),
    // Records an earlier cockpit wrote carry a `drain` field; nothing reads it now, and a stack it
    // describes as half torn down is finished by running the same down or reset again.
    drain: z.unknown().optional(),
}).strict().superRefine((value, context) => {
    const holderIds = value.holders.map(({ holderId }) => holderId)
    if (
        new Set(holderIds).size !== holderIds.length
        || value.lastReleasedHolder !== null && holderIds.includes(value.lastReleasedHolder)
        || value.holders.length > 0 && (value.lease === null || value.lease.released)
        || value.holders.length === 0 && value.lease !== null && !value.lease.released && value.lastReleasedHolder === null
    ) {
        context.addIssue({ code: 'custom', message: 'coordination invariants are inconsistent' })
    }
})

interface ClaimHolder {
    readonly holderId: HolderId
    readonly checkoutId: CheckoutId
    readonly claimedAt: string
    readonly pid?: number
    // The holding process's start identity (see `observeProcessStart`). Present only for a `cockpit
    // session` wrapper, whose hold ends with its process; the plain CLI's hold outlives every command.
    readonly processStart?: string
}

export interface PortLeaseRecord {
    readonly offset: number
    readonly ports: Readonly<Record<string, number>>
    readonly released: boolean
    readonly declaration: {
        readonly step: number
        readonly count: number
        readonly bases: Readonly<Record<string, number>>
    }
}

export interface CoordinationRecord {
    readonly holders: readonly ClaimHolder[]
    readonly lease: PortLeaseRecord | null
    readonly lastReleasedHolder: HolderId | null
}

type ClaimMutationRefusal = {
    readonly kind: 'refusal'
    readonly diagnostics: readonly EnvironmentDiagnostic[]
}

type ReleaseClaimResult =
    | {
          readonly kind: 'complete'
          readonly change: 'released' | 'unchanged'
          readonly decision: 'stop' | 'retain'
          readonly remaining: readonly HolderId[]
      }
    | ClaimMutationRefusal

export { isProcessGone, isProcessStart, observeProcessStart, processHost, type ProcessHost, type ProcessStartObservation } from './process-identity.js'

export interface HolderProcess {
    readonly pid?: number
    readonly processStart?: string
}

const LSOF_PATHS = ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof'] as const
const SS_PATHS = ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss', '/sbin/ss'] as const

type HostRead = { readonly kind: 'complete'; readonly text: string } | { readonly kind: 'failed'; readonly reason: string }
type ListenerRead =
    | { readonly kind: 'complete'; readonly format: 'lsof' | 'ss'; readonly text: string }
    | { readonly kind: 'failed'; readonly reason: string }

/** What observing which process listens on a port reads from this machine; production binds it with `listenerHost`. */
export interface ListenerHost {
    readonly process: ProcessHost
    /**
     * The TCP sockets listening on any of the ports: `lsof -F pn` on macOS, which lists only this
     * user's processes, and `ss -Hltnp` on Linux, which lists every socket but names only this
     * user's processes.
     */
    readonly listeners: (ports: readonly number[]) => Promise<ListenerRead>
    /** `ps -A -o pid=,ppid=,lstart=` under a fixed locale and zone. */
    readonly processTable: () => Promise<HostRead>
}

const issuedListenerHosts = new WeakSet<object>()

/** Whether `listenerHost` made this host, so its reads accept only the executor's own outcomes. */
export function isIssuedListenerHost(value: unknown): value is ListenerHost {
    return value !== null && typeof value === 'object' && issuedListenerHosts.has(value)
}

/** The production `ListenerHost`: ss or lsof, and ps, cross the executor. */
export function listenerHost(execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>): ListenerHost {
    const host: ListenerHost = Object.freeze({
        process: processHost(execute),
        listeners: async (ports) => {
            // lsof is absent from common Linux images while iproute2's ss is present, and ss also
            // shows sockets whose owner this user cannot see, which lsof leaves out.
            if (process.platform === 'linux') {
                const ss = await firstExecutable(SS_PATHS)
                if (!ss) return { kind: 'failed', reason: `ss (iproute2) is not installed at ${SS_PATHS.join(', ')}` }
                const text = await runBoundedProbe(ss, `process:listeners:${ports.join(',')}`, ['-Hltnp'], { LC_ALL: 'C' }, execute,
                    { timeoutMs: 15_000, stdoutLimitBytes: 4_194_304, exitCodes: [0] })
                return text === undefined
                    ? { kind: 'failed', reason: 'ss did not report which processes listen on the leased ports; a sandbox can refuse to run it, so if one is in use, run this command outside it' }
                    : { kind: 'complete', format: 'ss', text }
            }
            const lsof = await firstExecutable(LSOF_PATHS)
            if (!lsof) return { kind: 'failed', reason: `lsof is not installed at ${LSOF_PATHS.join(', ')}` }
            // lsof exits 1 when it finds nothing to list; an empty listing then names no owner, which
            // never proves a listener is a session's.
            const text = await runBoundedProbe(lsof, `process:listeners:${ports.join(',')}`,
                ['-nP', '-w', `-iTCP:${ports.join(',')}`, '-sTCP:LISTEN', '-Fpn'], { LC_ALL: 'C' }, execute,
                { timeoutMs: 15_000, stdoutLimitBytes: 1_048_576, exitCodes: [0, 1] })
            return text === undefined
                ? { kind: 'failed', reason: 'lsof did not report which processes listen on the leased ports; a sandbox can refuse to run it, so if one is in use, run this command outside it' }
                : { kind: 'complete', format: 'lsof', text }
        },
        processTable: async () => {
            const ps = await firstExecutable(PS_PATHS)
            if (!ps) return { kind: 'failed', reason: 'ps is not installed at /bin/ps or /usr/bin/ps' }
            const text = await runBoundedProbe(ps, 'process:table', ['-A', '-o', 'pid=,ppid=,lstart='], { LC_ALL: 'C', TZ: 'UTC0' }, execute,
                { timeoutMs: 15_000, stdoutLimitBytes: 16_777_216, exitCodes: [0] })
            return text === undefined
                ? { kind: 'failed', reason: 'ps did not list the running processes; a sandbox can refuse to run it, so if one is in use, run this command outside it' }
                : { kind: 'complete', text }
        },
    } satisfies ListenerHost)
    issuedListenerHosts.add(host)
    return host
}

export interface SessionListenerPort {
    readonly port: number
    /**
     * Whether every process listening on the port descends from a live session holding the stack,
     * and every probed address that answered is covered by one of their sockets.
     */
    readonly owned: boolean
    readonly reason: string
}

/** A loopback address the bind probe found listening on a leased port. */
export interface ProbedListener {
    readonly port: number
    readonly address: '127.0.0.1' | '::1'
}

export type SessionListenerObservation =
    | Readonly<{ kind: 'complete'; ports: readonly SessionListenerPort[] }>
    | Readonly<{ kind: 'unavailable'; reason: string }>

type ProcessEntry = Readonly<{ ppid: number; start: string }>

function parseProcessTable(read: HostRead): ReadonlyMap<number, ProcessEntry> | undefined {
    if (read.kind !== 'complete') return undefined
    const table = new Map<number, ProcessEntry>()
    for (const line of read.text.split('\n')) {
        if (line.trim() === '') continue
        const match = /^\s*([0-9]{1,10})\s+([0-9]{1,10})\s+(\S.*?)\s*$/.exec(line)
        if (!match || table.has(Number(match[1]))) return undefined
        table.set(Number(match[1]), { ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, ' ') })
    }
    return table.size > 0 ? table : undefined
}

// A listening socket and the process holding it; `pid` is absent when the socket's owner is
// another user's process.
type VisibleSocket = Readonly<{ pid?: number; address: string }>

function parseListeners(read: ListenerRead, ports: readonly number[]): ReadonlyMap<number, readonly VisibleSocket[]> | undefined {
    if (read.kind !== 'complete') return undefined
    const sockets = new Map<number, VisibleSocket[]>(ports.map((port) => [port, []]))
    if (read.format === 'ss') {
        for (const line of read.text.split('\n')) {
            if (line.trim() === '') continue
            const [state, , , local, , ...rest] = line.trim().split(/\s+/)
            const match = /^(\*|[0-9.]+(?:%\S+)?|\[[^\]]+\](?:%\S+)?):([0-9]{1,5})$/.exec(local ?? '')
            if (state !== 'LISTEN' || !match) return undefined
            const port = sockets.get(Number(match[2]))
            if (!port) continue
            const address = match[1]!.replace(/%\S+$/, '').replace(/^\[(.*)\]$/, '$1')
            // A process name is quoted and may itself spell `pid=`; every pid found must descend from
            // the session, so a spelled one can add a pid but never hide the real owner's.
            const pids = [...rest.join(' ').matchAll(/pid=([1-9][0-9]{0,9}),fd=/g)].map((found) => Number(found[1]))
            if (pids.length === 0) port.push({ address })
            for (const pid of pids) port.push({ pid, address })
        }
        return sockets
    }
    let pid: number | undefined
    for (const line of read.text.split('\n')) {
        if (line === '') continue
        if (line.startsWith('p')) {
            if (!/^p[1-9][0-9]{0,9}$/.test(line)) return undefined
            pid = Number(line.slice(1))
        } else if (line.startsWith('n')) {
            const match = /^n(\*|[0-9.]+|\[[^\]]+\]):([0-9]{1,5})$/.exec(line)
            if (pid === undefined || !match) return undefined
            sockets.get(Number(match[2]))?.push({ pid, address: match[1]!.replace(/^\[(.*)\]$/, '$1') })
        } else if (!line.startsWith('f')) return undefined
    }
    return sockets
}

// Which socket addresses accept a connection to a loopback probe. A wildcard socket is read as
// dual-stack, as Node and most servers bind it; an IPv6-only wildcard beside an invisible IPv4
// listener is a limit of this reading.
const COVERS: Readonly<Record<ProbedListener['address'], readonly string[]>> = {
    '127.0.0.1': ['127.0.0.1', '0.0.0.0', '*', '::'],
    '::1': ['::1', '*', '::'],
}

const MAX_ANCESTRY = 512

// Whether `pid` or one of its parents in the process table is one of `roots`. A process the table
// does not list has exited since the listing, and is not read as anyone's.
function reachesAncestor(pid: number, roots: ReadonlySet<number>, table: ReadonlyMap<number, ProcessEntry>): boolean {
    let current = pid
    for (let depth = 0; depth < MAX_ANCESTRY && current > 1; depth += 1) {
        if (roots.has(current)) return true
        const entry = table.get(current)
        if (!entry) return false
        current = entry.ppid
    }
    return false
}

/**
 * Whether `ancestor`, still running with its recorded start identity, is `pid` itself or one of its
 * ancestors. Anything that cannot be read is unknown.
 */
export async function observeProcessAncestry(input: {
    readonly pid: number
    readonly ancestor: Required<HolderProcess>
    readonly host: ListenerHost
}): Promise<'ancestor' | 'unrelated' | Readonly<{ unknown: string }>> {
    const observed = await observeProcessStart(input.ancestor.pid, input.host.process)
    if (observed.state === 'unknown') return { unknown: observed.reason }
    if (observed.state !== 'present' || observed.start !== input.ancestor.processStart) return 'unrelated'
    const table = parseProcessTable(await input.host.processTable())
    if (!table) return { unknown: 'the running processes could not be listed' }
    return reachesAncestor(input.pid, new Set([input.ancestor.pid]), table) ? 'ancestor' : 'unrelated'
}

/**
 * Which of the ports only processes a live `cockpit session` holding the stack started listen on.
 * An address, a port or a sibling's directory says nothing about who serves it; the proof is the
 * process. A session holder counts only when its recorded pid still runs with its recorded start
 * identity, and a listener only when its parent chain reaches that pid and one of the session's
 * sockets covers every loopback address the probe found answering. The sessions, the sockets and
 * the process table are each read once; a listener read wrongly here is reported, never failed.
 * Anything that cannot be read is unavailable, never owned.
 */
export async function observeSessionListeners(input: {
    readonly listeners: readonly ProbedListener[]
    readonly holders: readonly HolderProcess[]
    readonly host: ListenerHost
}): Promise<SessionListenerObservation> {
    const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason })
    const probedPorts = [...new Set(input.listeners.map(({ port }) => port))].sort((left, right) => left - right)
    const sessions = input.holders.filter((holder): holder is Required<HolderProcess> =>
        holder.pid !== undefined && holder.processStart !== undefined)
    // A session whose start cannot be read may be running; reading it as gone would blame its own
    // listener on a stranger, so that leaves ownership unavailable.
    const live = new Set<number>()
    for (const holder of sessions) {
        const observed = await observeProcessStart(holder.pid, input.host.process)
        if (observed.state === 'unknown') return unavailable(`cockpit session process ${holder.pid} could not be confirmed running (${observed.reason})`)
        if (observed.state === 'present' && observed.start === holder.processStart) live.add(holder.pid)
    }
    if (live.size === 0) {
        return { kind: 'complete', ports: probedPorts.map((port) => ({ port, owned: false,
            reason: 'no live cockpit session holds this stack' })) }
    }
    const listening = parseListeners(await input.host.listeners(probedPorts), probedPorts)
    const table = parseProcessTable(await input.host.processTable())
    if (!table) return unavailable('the running processes could not be listed')
    if (!listening) return unavailable('the processes listening on the leased ports could not be identified')
    const ports = probedPorts.map((port): SessionListenerPort => {
        const sockets = listening.get(port)!
        // lsof lists only this user's processes, so a probed address no visible socket covers is
        // served by a process it cannot see.
        const hidden = input.listeners.find((probed) => probed.port === port
            && !sockets.some(({ address }) => COVERS[probed.address].includes(address)))
        if (hidden) return { port, owned: false, reason: `its listener on ${hidden.address === '::1' ? '[::1]' : hidden.address} belongs to a process this user cannot see` }
        const unseen = sockets.find(({ pid }) => pid === undefined)
        if (unseen) return { port, owned: false, reason: `its listener on ${unseen.address.includes(':') ? `[${unseen.address}]` : unseen.address} belongs to a process this user cannot see` }
        const foreign = [...new Set(sockets.map(({ pid }) => pid!))].sort((left, right) => left - right)
            .find((pid) => !reachesAncestor(pid, live, table))
        return foreign === undefined
            ? { port, owned: true, reason: 'a live cockpit session holding this stack started its listener' }
            : { port, owned: false, reason: `process ${foreign} was not started by a live cockpit session holding this stack` }
    })
    return { kind: 'complete', ports }
}

function describeHolder(holder: ClaimHolder): string {
    return holder.pid === undefined ? holder.holderId : `${holder.holderId} (process ${holder.pid})`
}

// Names each other holder and how to end it. A dead session's hold is released before this is
// reached, so every holder named here is running, or could not be confirmed gone.
export function liveHolderMessage(holders: readonly ClaimHolder[]): string {
    const pids = holders.flatMap(({ pid }) => pid === undefined ? [] : [pid])
    // A pid can have been reused, and a hold may stand on a pid alone, so stopping one is only safe once confirmed.
    return `another cockpit session holds this stack (${holders.map(describeHolder).join(', ')}), or its process could not be confirmed gone, and down and reset never displace a running session; `
        // The command a session runs is not repeated here: its arguments can carry credentials.
        + `let its command finish${pids.length > 0 ? ` or, once \`ps -o pid,ppid,command -p ${pids.join(',')}\` shows it is that session and not one your own agent started (an MCP server, say), stop it with \`kill ${pids.join(' ')}\`` : ''}, then retry`
}

type ReleaseDeadSessionHoldersResult =
    | {
          readonly kind: 'complete'
          readonly released: readonly ClaimHolder[]
      }
    | ClaimMutationRefusal

// Every probe is a child process; a record may name thousands of holders.
const MAX_CONCURRENT_HOLDER_PROBES = 4

/**
 * Remove the holds of `cockpit session` wrappers whose process is gone. A session killed with
 * SIGKILL, a crash or a closed terminal never runs its closing `sleep`, and its hold then made
 * `down`, `reset` and `sleep` refuse forever while naming a session nobody could end. When every
 * holder is dead, the requesting holder takes the stack over in the same transaction: the stack is
 * still running, and a lease no holder retains reads as a stopped stack whose ports are free. A
 * stack down removed runs nothing, so its lease is released with its last dead holder instead, as
 * down leaves it; a takeover there read to up as a claim an earlier command left.
 */
export async function releaseDeadSessionHolders(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly removed?: boolean
    readonly successor: { readonly holderId: HolderId; readonly checkoutId: CheckoutId } & HolderProcess
    readonly now: string
    readonly observe: (pid: number) => Promise<ProcessStartObservation>
}): Promise<ReleaseDeadSessionHoldersResult> {
    const stored = await readState(input.namespace.paths.coordination(input.stackId))
    if (stored.kind === 'missing') return { kind: 'complete', released: [] }
    if (stored.kind !== 'complete') return stateRefusal(stored)
    const value = decodeCoordinationRecord(stored.value, input.stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId)
    const candidates = value.holders.filter((holder) => holder.holderId !== input.successor.holderId && holder.pid !== undefined)
    // Indexed slots keep the verdicts in holder order whatever order the probes finish in.
    const observed: ProcessStartObservation[] = new Array(candidates.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_HOLDER_PROBES, candidates.length) }, async () => {
        while (next < candidates.length) {
            const index = next++
            observed[index] = await input.observe(candidates[index]!.pid!)
        }
    }))
    const dead = candidates.filter((holder, index) => isProcessGone(holder.processStart, observed[index]!))
    if (dead.length === 0) return { kind: 'complete', released: [] }
    let committed: readonly ClaimHolder[] = []
    const result = await transactClaim<ReleaseDeadSessionHoldersResult>(input.namespace, input.stackId, input.successor.holderId, (current) => {
        const latest = decodeCoordinationRecord(current, input.stackId)
        if (!latest) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId))
        if (latest.lease === null || latest.lease.released) {
            return abortStateTransaction({ kind: 'complete', released: [] })
        }
        // Only a holder still recorded exactly as it was observed is released; one that changed
        // since is someone else's to judge.
        const released = dead.filter((holder) => latest.holders.some((candidate) => candidate.holderId === holder.holderId
            && candidate.claimedAt === holder.claimedAt && candidate.pid === holder.pid
            && candidate.processStart === holder.processStart))
        if (released.length === 0) return abortStateTransaction({ kind: 'complete', released: [] })
        committed = released
        const remaining = latest.holders.filter((holder) => !released.some(({ holderId }) => holderId === holder.holderId))
        const reduced: CoordinationRecord = { ...latest, holders: remaining, lastReleasedHolder: released.at(-1)!.holderId }
        const next = remaining.length > 0 ? reduced : input.removed ? { ...reduced, lease: { ...latest.lease, released: true } }
            : addCoordinationHolder(reduced, input.successor, input.now)?.value
        if (!next) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination holder set cannot accept the successor holder', input.successor.holderId))
        return coordinationStateRecord(input.namespace, input.stackId, current, input.now, next)
    })
    if ('diagnostics' in result || 'released' in result) return result
    if (result.kind !== 'complete') return result.kind === 'missing'
        ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path) : stateRefusal(result)
    return { kind: 'complete', released: committed }
}

export type ActiveStackInventoryResult =
    | { readonly kind: 'complete'; readonly value: readonly { readonly stackId: StackId; readonly record: CoordinationRecord }[] }
    | ClaimMutationRefusal

function diagnostic(
    code: EnvironmentCode,
    message: string,
    target: string,
    fix?: string,
): EnvironmentDiagnostic {
    return { severity: 'error', code, message, target, ...(fix ? { fix } : {}) }
}

function refuse(
    code: EnvironmentCode,
    message: string,
    target: string,
    fix?: string,
): ClaimMutationRefusal {
    return { kind: 'refusal', diagnostics: [diagnostic(code, message, target, fix)] }
}

export async function readActiveStackInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeProcess'> = {},
): Promise<ActiveStackInventoryResult> {
    return readCoordinationInventory(namespace, options)
}

async function readCoordinationInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeProcess'>,
    budget?: { entries: number; bytes: number },
): Promise<ActiveStackInventoryResult> {
    const ownedNamespace = snapshotStateNamespace(namespace)
    if (!ownedNamespace) return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'state namespace is malformed', 'state namespace')
    namespace = ownedNamespace
    const directory = dirname(namespace.paths.coordination(`stack:${'0'.repeat(64)}` as StackId).path)
    let inspected = false
    try {
        const before = await lstat(directory, { bigint: true })
        inspected = true
        if (!before.isDirectory() || before.isSymbolicLink()) {
            return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store is not a safe directory', directory)
        }
        const names: string[] = []
        const handle = await opendir(directory)
        try {
            for await (const entry of handle) {
                if (names.length >= STRUCTURED_INPUT_ENTRY_LIMIT) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store exceeds its entry boundary', directory)
                }
                if (budget && ++budget.entries > STRUCTURED_INPUT_ENTRY_LIMIT) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination inventory exceeds its aggregate entry boundary', directory)
                }
                names.push(entry.name)
            }
        } finally { await handle.close().catch(() => undefined) }
        const records: { stackId: StackId; record: CoordinationRecord }[] = []
        const observedRecords = new Map<StackId, StateRecord>()
        for (const name of names.sort()) {
            if (budget) {
                const path = join(directory, name)
                const status = await lstat(path)
                if (!status.isFile() || status.isSymbolicLink() || !Number.isSafeInteger(status.size)
                    || (budget.bytes += status.size) > SERIALIZED_RECORD_BYTE_LIMIT) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination inventory exceeds its aggregate byte boundary or contains an unsafe entry', path)
                }
            }
            const entry = parseCoordinationStateEntry(name)
            if (entry?.kind === 'temporary') {
                const lock = await inspectStateLock(namespace, options.observeProcess)
                const residue = join(directory, name)
                const [currentResidue, afterLockInspection] = await Promise.all([
                    lstat(residue),
                    lstat(directory, { bigint: true }),
                ])
                if (!currentResidue.isFile() || currentResidue.isSymbolicLink()
                    || !afterLockInspection.isDirectory() || afterLockInspection.isSymbolicLink()
                    || afterLockInspection.dev !== before.dev || afterLockInspection.ino !== before.ino
                    || afterLockInspection.mtimeNs !== before.mtimeNs || afterLockInspection.ctimeNs !== before.ctimeNs) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
                }
                if (lock.holderState === 'live') {
                    return refuse(
                        ENVIRONMENT_CODES.STATE_LOCKED,
                        'coordination publication is in progress',
                        residue,
                        'retry after the coordination transaction completes',
                    )
                }
                if (lock.holderState === 'unknown') {
                    return refuse(
                        ENVIRONMENT_CODES.STATE_LOCKED,
                        'coordination publication ownership is unverified',
                        residue,
                        lock.recovery,
                    )
                }
                return refuse(
                    ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                    'coordination store contains an orphaned unverified publication residue',
                    residue,
                    `${lock.description}; ${lock.recovery}; remove the residue only after proving that no writer owns it`,
                )
            }
            if (!entry || entry.kind !== 'record') {
                return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store contains an unexpected entry', join(directory, name))
            }
            const stackId = entry.stackId
            const result = await readState(namespace.paths.coordination(stackId))
            if (result.kind !== 'complete') {
                return refuse(
                    result.kind === 'missing' ? ENVIRONMENT_CODES.STATE_RECORD_MALFORMED : result.code,
                    result.kind === 'missing' ? 'coordination record disappeared during observation' : result.message,
                    result.kind === 'missing' ? result.path : result.target,
                )
            }
            const record = decodeCoordinationRecord(result.value, stackId)
            if (!record) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', result.value.subjectId)
            observedRecords.set(stackId, result.value)
            if (record.holders.length > 0 || record.lease !== null && !record.lease.released) records.push({ stackId, record })
        }
        const after = await lstat(directory, { bigint: true })
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
        }
        return { kind: 'complete', value: records }
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return inspected
                ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
                : { kind: 'complete', value: [] }
        }
        return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'coordination store could not be inspected', directory)
    }
}

// Port leases are machine-wide, so this reads every cockpit's coordination records. `skipped` names
// each other cockpit's namespace this version cannot read; its leases are not seen, and the caller
// reports it so a person can remove it. The caller's own namespace, a contended lock and the
// shared read bounds still refuse.
export async function readRootPortInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeProcess'> = {},
): Promise<
    | { readonly kind: 'complete'; readonly value: readonly { cockpitId: CockpitId; stackId: StackId; record: CoordinationRecord }[]
        readonly skipped: readonly SkippedStateNamespace[] }
    | ClaimMutationRefusal
> {
    const result = await withStateNamespaceInventory(namespace, async (namespaces, unreadable) => {
        const records: { cockpitId: CockpitId; stackId: StackId; record: CoordinationRecord }[] = []
        const skipped = [...unreadable]
        const budget = { entries: namespaces.length, bytes: 0 }
        for (const candidate of namespaces) {
            const inventory = await readCoordinationInventory(candidate, options, budget)
            if (inventory.kind !== 'complete') {
                const diagnostic = inventory.diagnostics[0]
                if (candidate.cockpitRoot === namespace.cockpitRoot || diagnostic?.code === ENVIRONMENT_CODES.STATE_LOCKED
                    || budget.entries > STRUCTURED_INPUT_ENTRY_LIMIT || budget.bytes > SERIALIZED_RECORD_BYTE_LIMIT) return inventory
                skipped.push({ path: candidate.cockpitRoot, reason: diagnostic?.message ?? 'coordination records are unreadable' })
                continue
            }
            const cockpitId = candidate.paths.coordination(`stack:${'0'.repeat(64)}` as StackId).cockpitId
            records.push(...inventory.value.map((record) => ({ cockpitId, ...record })))
        }
        return { kind: 'complete' as const, value: records, skipped }
    })
    if (result.kind === 'complete') return result.value
    if (result.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'state namespace inventory disappeared during observation', result.path)
    return refuse(result.code, result.message, result.target, result.recovery)
}

function validIdentity(value: string, pattern: RegExp): boolean {
    return typeof value === 'string' && pattern.test(value)
}

export function decodeCoordinationRecord(record: StateRecord | null, stackId: StackId): CoordinationRecord | undefined {
    if (record === null) return { holders: [], lease: null, lastReleasedHolder: null }
    if (record.kind !== 'coordination' || record.subjectId !== stackId) return undefined
    const parsed = CoordinationValueSchema.safeParse(record.value)
    if (!parsed.success) return undefined
    return {
        holders: parsed.data.holders
            .map((holder) => ({
                holderId: holder.holderId as HolderId,
                checkoutId: holder.checkoutId as CheckoutId,
                claimedAt: holder.claimedAt,
                ...(holder.pid === undefined ? {} : { pid: holder.pid }),
                ...(holder.processStart === undefined ? {} : { processStart: holder.processStart }),
            }))
            .sort((left, right) => left.holderId < right.holderId ? -1 : left.holderId > right.holderId ? 1 : 0),
        lease: parsed.data.lease === null ? null : {
            offset: parsed.data.lease.offset,
            ports: { ...parsed.data.lease.ports },
            released: parsed.data.lease.released,
            declaration: {
                step: parsed.data.lease.declaration.step,
                count: parsed.data.lease.declaration.count,
                bases: { ...parsed.data.lease.declaration.bases },
            },
        },
        lastReleasedHolder: parsed.data.lastReleasedHolder as HolderId | null,
    }
}

export function addCoordinationHolder(
    value: CoordinationRecord,
    holder: { readonly holderId: HolderId; readonly checkoutId: CheckoutId } & HolderProcess,
    now: string,
): { readonly value: CoordinationRecord; readonly change: 'acquired' | 'unchanged' } | undefined {
    const existing = value.holders.find((candidate) => candidate.holderId === holder.holderId)
    if (existing && existing.checkoutId !== holder.checkoutId) return undefined
    if (existing) return { value, change: 'unchanged' }
    return {
        value: {
            ...value,
            holders: [...value.holders, { ...holder, claimedAt: now }]
                .sort((left, right) => left.holderId < right.holderId ? -1 : left.holderId > right.holderId ? 1 : 0),
            lastReleasedHolder: value.lastReleasedHolder === holder.holderId ? null : value.lastReleasedHolder,
        },
        change: 'acquired',
    }
}

export function removeExactCoordinationHolder(
    value: CoordinationRecord,
    holderId: HolderId,
): CoordinationRecord | undefined {
    try {
        if (!holderIdentity.test(holderId) || value.lease === null || value.lease.released) return undefined
        const holders = value.holders.filter((holder) => holder.holderId !== holderId)
        if (holders.length !== value.holders.length - 1) return undefined
        return {
            ...value,
            holders,
            lastReleasedHolder: holderId,
        }
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

export function coordinationStateRecord(
    namespace: StateNamespace,
    stackId: StackId,
    current: StateRecord | null,
    now: string,
    value: CoordinationRecord,
): StateRecord {
    return {
        format: 'cockpit-state/v1',
        kind: 'coordination',
        cockpitId: namespace.paths.coordination(stackId).cockpitId,
        subjectId: stackId,
        revision: current === null ? 0 : current.revision + 1,
        updatedAt: now,
        value: {
            holders: value.holders.map((holder) => ({ ...holder })),
            lease: value.lease === null ? null : {
                ...value.lease,
                ports: { ...value.lease.ports },
                declaration: { ...value.lease.declaration, bases: { ...value.lease.declaration.bases } },
            },
            lastReleasedHolder: value.lastReleasedHolder,
        },
    }
}

function stateRefusal(result: Exclude<StateResult<StateRecord>, { kind: 'complete' | 'missing' }>): ClaimMutationRefusal {
    return refuse(
        result.code,
        result.message,
        result.target,
        'recovery' in result ? result.recovery : undefined,
    )
}

async function transactClaim<T>(
    namespace: StateNamespace,
    stackId: StackId,
    ownerId: HolderId,
    update: (current: StateRecord | null) => StateRecord | StateTransactionAbort<T>,
    beforeCommit?: () => StateTransactionAbort<T> | undefined,
): Promise<StateResult<StateRecord> | T> {
    const result = await transactState(
        namespace,
        namespace.paths.coordination(stackId),
        { ownerId, contentionTimeoutMs: 2_000, beforeCommit },
        update,
    )
    const aborted = result as StateTransactionAbort<T>
    return aborted.aborted === true ? aborted.value : result as StateResult<StateRecord>
}

export async function releaseClaim(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly requesterId: HolderId
    readonly holderId: HolderId
    readonly now: string
}): Promise<ReleaseClaimResult> {
    let request: {
        readonly namespace: StateNamespace
        readonly stackId: StackId
        readonly requesterId: HolderId
        readonly holderId: HolderId
        readonly now: string
    }
    try {
        const namespaceProperty = Object.getOwnPropertyDescriptor(input, 'namespace')
        if (!namespaceProperty || !('value' in namespaceProperty)) throw new RefusalError('invalid namespace property')
        const stableNamespace = snapshotStateNamespace(namespaceProperty.value as StateNamespace)
        if (!stableNamespace) throw new RefusalError('invalid namespace')
        request = {
            namespace: stableNamespace,
            stackId: input.stackId,
            requesterId: input.requesterId,
            holderId: input.holderId,
            now: input.now,
        }
    } catch (error) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, `claim release input could not be read safely: ${errorCause(error)}`, 'claim release input')
    }
    if (
        !validIdentity(request.stackId, stackIdentity)
        || !validIdentity(request.requesterId, holderIdentity)
        || !validIdentity(request.holderId, holderIdentity)
        || !isCanonicalTimestamp(request.now)
    ) {
        return refuse(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'claim release requires canonical stack, holder, and timestamp values',
            String(request.stackId ?? ''),
        )
    }
    // A holder whose session is gone is released by `releaseDeadSessionHolders`, which proves the
    // death itself; no other holder's claim is this function's to drop.
    if (request.requesterId !== request.holderId) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_CO_TENANT,
            'a holder can release only its own claim',
            request.holderId,
        )
    }

    const result = await transactClaim<ReleaseClaimResult>(
        request.namespace,
        request.stackId,
        request.requesterId,
        (current) => {
            const value = decodeCoordinationRecord(current, request.stackId)
            if (!value) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', request.stackId))
            const holders = value.holders.filter((holder) => holder.holderId !== request.holderId)
            if (holders.length === value.holders.length) {
                if (holders.length === 0) {
                    return abortStateTransaction(refuse(
                        ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                        'claim release requires an active non-final holder',
                        request.stackId,
                    ))
                }
                return abortStateTransaction({
                    kind: 'complete', change: 'unchanged', decision: 'retain',
                    remaining: holders.map((holder) => holder.holderId),
                })
            }
            if (holders.length === 0) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                    'the final holder is released by sleep or down, which stop the stack first',
                    request.stackId,
                ))
            }
            return coordinationStateRecord(request.namespace, request.stackId, current, new Date().toISOString(), {
                holders,
                lease: value.lease,
                lastReleasedHolder: request.holderId,
            })
        },
    )
    if ('diagnostics' in result || 'remaining' in result) return result
    if (result.kind === 'missing') {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path)
    }
    if (result.kind !== 'complete') return stateRefusal(result)
    const value = decodeCoordinationRecord(result.value, request.stackId)
    if (!value) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published claim record is malformed', result.value.subjectId)
    }
    const remaining = value.holders.map((holder) => holder.holderId)
    return {
        kind: 'complete',
        change: 'released',
        decision: remaining.length === 0 ? 'stop' : 'retain',
        remaining,
    }
}

/**
 * Releases the last holder of a stack that sleep, down or reset has just stopped, and with it the
 * port lease, so the ports are free for the next up. A stack no session holds is already released.
 */
export async function releaseStoppedStack(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
}): Promise<{ readonly kind: 'complete' } | ClaimMutationRefusal> {
    const result = await transactClaim<ClaimMutationRefusal | 'unchanged'>(input.namespace, input.stackId, input.holderId, (current) => {
        const value = decodeCoordinationRecord(current, input.stackId)
        if (!value) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId))
        if (value.holders.length === 0) return abortStateTransaction('unchanged')
        const others = value.holders.filter(({ holderId }) => holderId !== input.holderId)
        if (others.length > 0 || value.holders.length !== 1) {
            return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, liveHolderMessage(others), input.stackId))
        }
        return coordinationStateRecord(input.namespace, input.stackId, current, new Date().toISOString(), {
            holders: [],
            lease: value.lease === null ? null : { ...value.lease, released: true },
            lastReleasedHolder: input.holderId,
        })
    })
    if (result === 'unchanged') return { kind: 'complete' }
    if ('diagnostics' in result) return result
    if (result.kind === 'complete') return { kind: 'complete' }
    return result.kind === 'missing'
        ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path)
        : stateRefusal(result)
}

/**
 * Runs `operation` while this process alone may stop or remove the stack. Sleep, down and reset each
 * hold it from their first read to their last removal, and an up refuses to lease the stack's ports
 * while one runs. A run that was killed leaves the lock to the next one, which finishes its work.
 */
export async function withStackTeardown<T extends object>(
    namespace: StateNamespace,
    stackId: StackId,
    holderId: HolderId,
    operation: () => Promise<T>,
    contentionTimeoutMs = 2_000,
): Promise<T | ClaimMutationRefusal> {
    const scope = issueStateScopedLock(namespace, { owner: 'stack-teardown', identity: createHash('sha256').update(stackId).digest('hex') })
    if (!scope) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'stack teardown lock could not be named', stackId)
    const locked = await withStateScopedLock(namespace, scope, { ownerId: holderId, contentionTimeoutMs }, operation)
    // A lock this run could not release is the next run's to reclaim; the work itself is done.
    if (locked.kind === 'complete' || locked.kind === 'indeterminate') return locked.value
    if (locked.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'stack teardown lock returned no result', locked.path)
    return locked.code === ENVIRONMENT_CODES.STATE_LOCKED
        ? refuse(ENVIRONMENT_CODES.STATE_LOCKED, `a sleep, down or reset of this stack is running: ${locked.message}`, stackId,
            'wait for it to finish, then retry')
        : stateRefusal(locked)
}

/**
 * Waits until no sleep, down or reset of the stack runs. Up refuses to lease ports under a teardown,
 * and sessions started together met exactly that: one whose command ended at once slept while the
 * others came to join, and every one of them refused. A teardown is bounded by its stop steps, so
 * this gives up after two minutes rather than the hour a cold start may take.
 */
export async function waitForStackTeardown(namespace: StateNamespace, stackId: StackId, holderId: HolderId): Promise<boolean> {
    const deadline = Date.now() + 120_000
    while (true) {
        const waited = await withStackTeardown(namespace, stackId, holderId, async () => ({}), 30_000)
        if (!('diagnostics' in waited)) return true
        if (waited.diagnostics[0]?.code !== ENVIRONMENT_CODES.STATE_LOCKED || Date.now() >= deadline) return false
    }
}

/**
 * Runs `operation` while this process alone brings the stack up; another up of it waits, then joins
 * the stack the first one started. An agent tool starts every MCP server at once, and each server a
 * `cockpit session` wraps runs its own up: each claimed the stopped stack beside the others, none was
 * its only holder or saw progress it could trust, and every one refused. A waiter holds nothing, and
 * the lock of a run that was killed goes to the next one. A waiter gives up after the longest cold
 * start a cockpit.toml may declare.
 */
export async function withStackBringUp<T extends object>(
    namespace: StateNamespace,
    stackId: StackId,
    holderId: HolderId,
    operation: () => Promise<T>,
): Promise<T | ClaimMutationRefusal> {
    const scope = issueStateScopedLock(namespace, { owner: 'stack-bring-up', identity: createHash('sha256').update(stackId).digest('hex') })
    if (!scope) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'stack bring-up lock could not be named', stackId)
    const deadline = Date.now() + MAX_COLD_START_SECONDS * 1_000
    let ran = false
    const run = () => { ran = true; return operation() }
    while (true) {
        const locked = await withStateScopedLock(namespace, scope, { ownerId: holderId, contentionTimeoutMs: 30_000 }, run)
        if (locked.kind === 'complete' || locked.kind === 'indeterminate') return locked.value
        if (locked.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'stack bring-up lock returned no result', locked.path)
        // Only a lock this run never got is waited for again; a run that started is never repeated.
        if (locked.code !== ENVIRONMENT_CODES.STATE_LOCKED || ran) return stateRefusal(locked)
        if (Date.now() >= deadline) return refuse(ENVIRONMENT_CODES.STATE_LOCKED, `another up of this stack is still running: ${locked.message}`, stackId,
            'wait for it to finish, then retry')
    }
}
