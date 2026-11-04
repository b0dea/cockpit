// Owns the record cockpit keeps of each work order, `.cockpit/work-orders/<id>.json`: what was
// accepted and by whom, the checks cockpit ran, the grade, notes and questions, and how the order
// closed. Records are committed so the `work verify` CI job can read them, and only cockpit writes
// them: the guard denies an agent's write below `.cockpit/work-orders/`, because an unkeyed record
// an agent wrote there would read as cockpit's own. A write holds the order's lock file, which a
// crashed writer leaves behind until `work recover --apply` removes it.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { isProcessGone, observeProcessStart, processHost } from '../environment/claims.js'
import { hasErrorCode, RefusalError } from '../environment/contract.js'
import { executeProbe } from '../environment-exec/execute.js'
import { DECIDERS, WORK_GRADING } from '../schema.js'
import { WORK_ORDER_ID, WorkOrderFrontMatter } from './contract.js'

export const WORK_RECORD_DIRECTORY = '.cockpit/work-orders'
const RECORD_LIMIT_BYTES = 1_048_576
const OUTPUT_TAIL_BYTES = 4_096
const at = z.string().datetime()
const by = z.enum(DECIDERS)
const note = z.string().min(1).max(4_096)

const CheckResult = z.object({
    criterion: z.string().max(64),
    kind: z.enum(['argv', 'gate']),
    passed: z.boolean(),
    // How the check ended: an exit status, a gate verdict, or why it could not run.
    outcome: z.string().max(256),
    output: z.string().max(OUTPUT_TAIL_BYTES * 2),
}).strict()
export type CheckResult = z.infer<typeof CheckResult>

const Verdict = z.object({ id: z.string().max(64), verdict: z.enum(['met', 'unmet', 'unclear']), note: z.string().max(4_096) }).strict()
const Grade = z.object({
    at, digest: z.string().length(64), mode: z.enum(WORK_GRADING), passed: z.boolean(),
    criteria: z.array(Verdict).max(64), outOfScope: z.array(z.string().max(1_100)).max(512),
    // Which evaluator answered and those passed over on the way; absent when no evaluator ran.
    evaluator: z.object({ tool: z.string().max(64), fallbacks: z.array(z.object({ tool: z.string().max(64), code: z.string().max(64), message: z.string().max(8_192) }).strict()).max(8) }).strict().optional(),
    note: note.optional(),
}).strict()

export const WorkRecord = z.object({
    format: z.literal('cockpit-work-order/v1'),
    id: z.string().regex(WORK_ORDER_ID),
    state: z.enum(['accepted', 'checked', 'graded', 'done', 'partial', 'abandoned']),
    accepted: z.object({
        at, by, digest: z.string().length(64),
        // The accepted contract, so a later amendment can be compared criterion by criterion.
        order: WorkOrderFrontMatter,
        sources: z.record(z.string(), z.string().length(64)),
        base: z.record(z.string(), z.string().regex(/^[a-f0-9]{40,64}$/)),
    }).strict(),
    // `weakened` names what the amendment removed; `review` each change a model, or a person where none grades, judges
    // against the bar, with its text before and after. An agent's amendment is judged at the next grade.
    amendments: z.array(z.object({ at, by, from: z.string().length(64), to: z.string().length(64), weakened: z.array(z.string()).max(64),
        review: z.array(z.object({ field: z.string().max(64), before: z.string().max(131_072), after: z.string().max(131_072) }).strict()).max(128) }).strict()).max(256),
    // A person's (or, where [work.gates] allows, an agent's or CI's) acknowledgement that the change weakened tests:
    // it covers exactly the findings its digest names, so a later weakening needs its own.
    acknowledgements: z.array(z.object({ at, by, digest: z.string().length(64), findings: z.array(z.string().max(1_100)).max(256), note }).strict()).max(256),
    attempts: z.number().int().min(0),
    checks: z.object({ at, digest: z.string().length(64), results: z.array(CheckResult).max(64) }).strict().optional(),
    grade: Grade.optional(),
    // A decision is resolved by a later `resolution` note naming it in `resolves`: with `record`, the decision
    // record it is written in; without, `text` says why it made no lasting decision. The latest resolution counts.
    notes: z.array(z.object({ at, by: z.enum(['agent', 'person', 'ci']), kind: z.enum(['note', 'question', 'answer', 'decision', 'resolution']), text: note,
        answers: z.number().int().min(1).optional(), resolves: z.number().int().min(1).optional(), record: z.string().max(1_100).optional() }).strict()).max(1_024),
    closure: z.object({ at, by, how: z.enum(['graded', 'checks-passed', 'self-reported', 'partial', 'abandoned']), note: note.optional() }).strict().optional(),
    // Each lock `work recover --apply` removed: the holder it named and what was checked to call it gone.
    recoveries: z.array(z.object({ at, holder: z.string().max(1_024), checked: z.array(z.string().max(1_024)).max(16) }).strict()).max(256).optional(),
}).strict()
export type WorkRecord = z.infer<typeof WorkRecord>

/** Keeps the end of a command's output, where a runner prints its summary, within the record's bound. */
export function outputTail(value: string): string {
    const bytes = Buffer.from(value)
    return bytes.byteLength <= OUTPUT_TAIL_BYTES ? value : `[...]${bytes.subarray(bytes.byteLength - OUTPUT_TAIL_BYTES).toString('utf8')}`
}

export interface WorkStore {
    readonly read: (id: string) => Promise<WorkRecord | undefined>
    readonly list: () => Promise<readonly WorkRecord[]>
    /** Runs `change` holding the order's lock; it returns the next record, or undefined to write nothing. */
    readonly update: <T>(id: string, change: (current: WorkRecord | undefined) => Promise<{ record?: WorkRecord; value: T }>) => Promise<T>
    /** Names a lock's holder and, with `apply`, removes the lock once the holder is shown gone, recording what was checked. */
    readonly recover: (id: string, apply: boolean, containers: () => Promise<ContainerEvidence>) => Promise<LockRecovery>
}

/** The containers cockpit labels on this machine's Docker daemon, which a process probe cannot look inside. */
export type ContainerEvidence =
    | Readonly<{ state: 'listed'; context: string; containers: readonly Readonly<{ id: string; name: string; running: boolean }>[] }>
    | Readonly<{ state: 'no-docker'; reason: string }>
    | Readonly<{ state: 'unavailable'; reason: string }>
type LockRecovery = Readonly<{ id: string; lock: 'none' | 'live' | 'unknown' | 'dead' | 'removed'; holder?: string; checked?: readonly string[]; recorded?: boolean }>

// A lock names its writer: pid and start, so a reused pid never keeps a dead writer's lock alive, and
// the host and whether it ran in a container, because a pid means nothing outside the process table
// it came from. Docker names a container's host after the container, unless it shares the machine's network.
const LockHolder = z.object({ pid: z.number().int().min(1), start: z.string().max(256).optional(), host: z.string().min(1).max(255), container: z.boolean() }).strict()
type LockHolder = z.infer<typeof LockHolder>
const inContainer = () => existsSync('/.dockerenv') || existsSync('/run/.containerenv')
const holder = async (): Promise<LockHolder> => {
    const observed = await observeProcessStart(process.pid, processHost(executeProbe))
    return { pid: process.pid, ...observed.state === 'present' ? { start: observed.start } : {}, host: hostname(), container: inContainer() }
}

// Whether the holder is shown running or gone, looking first where a pid probe cannot; anything unproven is unknown.
async function judgeHolder(found: LockHolder, containers: ContainerEvidence): Promise<Readonly<{ lock: 'live' | 'unknown' | 'dead'; checked: readonly string[] }>> {
    const here = hostname()
    const listed = containers.state === 'listed' ? containers.containers : []
    const checked = [`the lock was written by process ${found.pid} on host ${found.host}${found.container ? ' inside a container' : ''}`, `this machine is host ${here}`,
        (containers.state === 'listed' ? `Docker context ${containers.context} lists ${listed.length} cockpit-labelled container(s)${listed.length
            ? `: ${listed.map(row => `${row.name} (${row.running ? 'running' : 'stopped'})`).join(', ')}` : ''}`
            : containers.state === 'no-docker' ? `no Docker client is installed (${containers.reason}), so no container on this machine runs cockpit`
                : `Docker could not be read: ${containers.reason}`).slice(0, 1_024)]
    if (containers.state === 'unavailable') return { lock: 'unknown', checked }
    if (found.host !== here || found.container) {
        const writer = /^[a-f0-9]{12}$/.test(found.host) ? listed.find(row => row.id.startsWith(found.host)) : undefined
        if (!writer) return { lock: 'unknown', checked: [...checked, 'the writer ran on another host or in a container this machine does not list, whose processes this machine cannot see'] }
        return { lock: writer.running ? 'live' : 'dead', checked: [...checked, `container ${writer.name}, which wrote it, is ${writer.running ? 'running' : 'stopped, so none of its processes runs'}`] }
    }
    const observed = await observeProcessStart(found.pid, processHost(executeProbe))
    const lock = isProcessGone(found.start, observed) ? 'dead' : observed.state === 'unknown' ? 'unknown' : 'live'
    return { lock, checked: [...checked, `process ${found.pid} on this machine is ${lock === 'dead' ? 'gone' : observed.state === 'unknown' ? `not observable (${observed.reason})` : 'running'}`] }
}

export function createWorkStore(root: string): WorkStore {
    const directory = join(root, WORK_RECORD_DIRECTORY)
    const pathOf = (id: string, suffix: string) => {
        if (!WORK_ORDER_ID.test(id)) throw new RefusalError(`work order id ${JSON.stringify(id)} is not an id`)
        return join(directory, `${id}${suffix}`)
    }
    const read = async (id: string): Promise<WorkRecord | undefined> => {
        const path = pathOf(id, '.json')
        let bytes: Buffer
        try {
            const status = await lstat(path)
            if (!status.isFile() || status.size > RECORD_LIMIT_BYTES) throw new RefusalError(`${WORK_RECORD_DIRECTORY}/${id}.json is not a regular file of at most 1 MiB`)
            bytes = await readFile(path)
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return undefined
            throw error
        }
        let value: unknown
        try { value = JSON.parse(bytes.toString('utf8')) }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; value = undefined }
        const parsed = WorkRecord.safeParse(value)
        if (!parsed.success || parsed.data.id !== id) {
            throw new RefusalError(`${WORK_RECORD_DIRECTORY}/${id}.json is not a cockpit work-order record; restore it with git restore -- ${WORK_RECORD_DIRECTORY}/${id}.json`)
        }
        return parsed.data
    }
    const lock = async (id: string) => {
        await mkdir(directory, { recursive: true })
        const path = pathOf(id, '.lock')
        // The holder is written before the lock appears, by linking a finished file into place, so a
        // crash never leaves a lock that names nobody and so could never be shown gone.
        const staged = `${path}.${randomUUID()}.tmp`
        await writeFile(staged, `${JSON.stringify(await holder())}\n`, { flag: 'wx', mode: 0o644 })
        try { await link(staged, path) }
        catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error
            throw new RefusalError(`work order ${id} is locked by another cockpit command (${WORK_RECORD_DIRECTORY}/${id}.lock); wait for it, or if it crashed run npx --no cockpit work recover --config <your cockpit.toml> --work-order ${id} --apply`)
        } finally { await rm(staged, { force: true }) }
        return async () => { await rm(path, { force: true }) }
    }
    const write = async (record: WorkRecord) => {
        const checked = WorkRecord.parse(record)
        const bytes = `${JSON.stringify(checked, null, 2)}\n`
        if (Buffer.byteLength(bytes) > RECORD_LIMIT_BYTES) throw new RefusalError(`the ${record.id} record would exceed 1 MiB`)
        const path = pathOf(record.id, '.json')
        const staged = `${path}.${randomUUID()}.tmp`
        const handle = await open(staged, 'wx', 0o644)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        try { await rename(staged, path) } catch (error) { await rm(staged, { force: true }); throw error }
    }
    const store: WorkStore = {
        read,
        list: async () => {
            let names: string[]
            try { names = await readdir(directory) } catch (error) { if (hasErrorCode(error, 'ENOENT')) return []; throw error }
            const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)).filter(id => WORK_ORDER_ID.test(id)).sort()
            return Promise.all(ids.map(async id => (await read(id))!))
        },
        update: async (id, change) => {
            const release = await lock(id)
            try {
                const result = await change(await read(id))
                if (result.record) await write(result.record)
                return result.value
            } finally { await release() }
        },
        recover: async (id, apply, containers) => {
            const path = pathOf(id, '.lock')
            let text: string
            try { text = await readFile(path, 'utf8') } catch (error) { if (hasErrorCode(error, 'ENOENT')) return { id, lock: 'none' as const }; throw error }
            let parsed: unknown
            try { parsed = JSON.parse(text) } catch (error) { if (!(error instanceof SyntaxError)) throw error }
            const found = LockHolder.safeParse(parsed)
            const shown = text.trim().slice(0, 1_024)
            if (!found.success) return { id, lock: 'unknown' as const, holder: shown, checked: ['the lock does not name its holder the way cockpit writes one'] }
            // A lock whose writer is still running, or cannot be shown gone, is never removed: the write it guards may be in progress.
            const judged = await judgeHolder(found.data, await containers())
            if (judged.lock !== 'dead' || !apply) return { id, lock: judged.lock, holder: shown, checked: judged.checked }
            // The lock is taken over rather than deleted, so no other writer slips in before the recovery is recorded.
            const ours = `${path}.${randomUUID()}.tmp`
            await writeFile(ours, `${JSON.stringify(await holder())}\n`, { flag: 'wx', mode: 0o644 })
            try {
                if (await readFile(path, 'utf8') !== text) throw new RefusalError(`the lock on ${id} changed while it was being recovered; rerun work recover`)
                await rename(ours, path)
            } finally { await rm(ours, { force: true }) }
            try {
                const record = await read(id)
                if (record) await write({ ...record, recoveries: [...record.recoveries ?? [], { at: new Date().toISOString(), holder: shown, checked: [...judged.checked] }] })
                return { id, lock: 'removed' as const, holder: shown, checked: judged.checked, recorded: record !== undefined }
            } finally { await rm(path, { force: true }) }
        },
    }
    return store
}
