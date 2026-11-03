// Owns the record cockpit keeps of each work order, `.cockpit/work-orders/<id>.json`: what was
// accepted and by whom, the checks cockpit ran, the grade, notes and questions, and how the order
// closed. Records are committed so the `work verify` CI job can read them, and only cockpit writes
// them: the guard denies an agent's write below `.cockpit/work-orders/`, because an unkeyed record
// an agent wrote there would read as cockpit's own. A write holds the order's lock file, which a
// crashed writer leaves behind until `work recover --apply` removes it.
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
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
    amendments: z.array(z.object({ at, by, from: z.string().length(64), to: z.string().length(64), weakened: z.array(z.string()).max(64) }).strict()).max(256),
    attempts: z.number().int().min(0),
    checks: z.object({ at, digest: z.string().length(64), results: z.array(CheckResult).max(64) }).strict().optional(),
    grade: Grade.optional(),
    notes: z.array(z.object({ at, by: z.enum(['agent', 'person', 'ci']), kind: z.enum(['note', 'question', 'answer']), text: note,
        answers: z.number().int().min(1).optional() }).strict()).max(1_024),
    closure: z.object({ at, by, how: z.enum(['graded', 'checks-passed', 'self-reported', 'partial', 'abandoned']), note: note.optional() }).strict().optional(),
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
    readonly recover: (id: string, apply: boolean) => Promise<Readonly<{ id: string; lock: 'none' | 'live' | 'unknown' | 'dead' | 'removed'; holder?: string }>>
}

// A lock names its holder as pid@start, so a reused pid never keeps a dead writer's lock alive.
const holder = async (): Promise<string> => {
    const observed = await observeProcessStart(process.pid, processHost(executeProbe))
    return observed.state === 'present' ? `${process.pid}@${observed.start}` : `${process.pid}`
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
        const recorded = await holder()
        try {
            const handle = await open(path, 'wx', 0o644)
            try { await handle.writeFile(`${recorded}\n`) } finally { await handle.close() }
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error
            throw new RefusalError(`work order ${id} is locked by another cockpit command (${WORK_RECORD_DIRECTORY}/${id}.lock); wait for it, or if it crashed run npx --no cockpit work recover --config <your cockpit.toml> --work-order ${id} --apply`)
        }
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
        recover: async (id, apply) => {
            const path = pathOf(id, '.lock')
            let text: string
            try { text = await readFile(path, 'utf8') } catch (error) { if (hasErrorCode(error, 'ENOENT')) return { id, lock: 'none' as const }; throw error }
            const recorded = text.trim()
            const [pidText, start] = recorded.split('@', 2)
            const observed = await observeProcessStart(Number(pidText), processHost(executeProbe))
            // A lock whose writer is still running, or cannot be shown gone, is never removed: the write it guards may be in progress.
            if (!isProcessGone(start, observed)) return { id, lock: observed.state === 'unknown' ? 'unknown' as const : 'live' as const, holder: recorded }
            if (!apply) return { id, lock: 'dead' as const, holder: recorded }
            await rm(path, { force: true })
            return { id, lock: 'removed' as const, holder: recorded }
        },
    }
    return store
}
