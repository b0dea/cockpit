import { errorCause, hasErrorCode } from './contract.js'
/**
 * Owns this machine's runtime measurements: `machine/runtime-measurements.json` under the per-user
 * state root, one row per measured runtime. A row is keyed by the runtime product, the daemon
 * `docker info` names and the engine version, and says nothing about a checkout, so every checkout
 * and git worktree of every cockpit on this machine shares it; a different runtime, daemon or
 * engine matches no row and is refused until it is measured. It is not something the team declares,
 * so it is not in cockpit.toml: teammates on different runtimes would overwrite each other's rows,
 * and recording one would change guarded configuration that only a human `sync` accepts.
 *
 * It reads and writes the file and nothing else: `runtime-measurement.ts` produces rows and
 * `runtime.ts` decides whether a row admits the observed runtime.
 */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { readBoundedInput } from '../config/load.js'

const MEASUREMENTS_PATH = 'machine/runtime-measurements.json'
const FORMAT = 'cockpit-runtime-measurements/v1'
const ROW_LIMIT = 32

const Text = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/)
const Row = z.object({
    runtime: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    daemon: Text,
    engineVersion: Text,
    composeFloor: z.string().regex(/^\d+\.\d+\.\d+$/),
    measuredOn: z.string().date(),
}).strict()
const MeasurementFile = z.object({ format: z.literal(FORMAT), measurements: z.array(Row).max(ROW_LIMIT) }).strict()

/** One passing measurement: the runtime product, the daemon `docker info` named, its engine version and the Compose floor. */
export type RuntimeMeasurementRow = Readonly<z.infer<typeof Row>>

export type LocalRuntimeMeasurements =
    | Readonly<{ kind: 'read'; path: string; rows: readonly RuntimeMeasurementRow[] }>
    | Readonly<{ kind: 'unreadable'; path: string; reason: string }>

/** Read the rows; a missing file is an empty record, anything else unreadable names why. */
export async function readLocalRuntimeMeasurements(stateRoot: string): Promise<LocalRuntimeMeasurements> {
    const path = join(stateRoot, MEASUREMENTS_PATH)
    let bytes: Buffer
    try {
        const read = await readBoundedInput(path)
        if (read.kind !== 'complete') return { kind: 'unreadable', path, reason: 'the file is larger than cockpit reads' }
        bytes = read.bytes
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { kind: 'read', path, rows: [] }
        return { kind: 'unreadable', path, reason: `the file could not be read (${errorCause(error)})` }
    }
    let value: unknown
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch { // Parser text would quote the file; the reason names the two ways it fails.
        return { kind: 'unreadable', path, reason: 'the file is not UTF-8 JSON' }
    }
    const parsed = MeasurementFile.safeParse(value)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return { kind: 'unreadable', path,
            reason: `the file is not a ${FORMAT} record (${issue ? `${issue.path.join('.') || 'record'}: ${issue.message}` : 'invalid'})` }
    }
    return { kind: 'read', path, rows: parsed.data.measurements.map((row) => row) }
}

export type RecordResult =
    | Readonly<{ kind: 'complete'; path: string; replaced: RuntimeMeasurementRow | null; discardedUnreadable: string | null }>
    | Readonly<{ kind: 'refusal'; path: string; reason: string }>

async function plainDirectory(path: string): Promise<'present' | 'absent' | string> {
    try {
        const status = await lstat(path)
        return status.isDirectory() && !status.isSymbolicLink() ? 'present' : `${path} is not a plain directory`
    } catch (error) {
        return hasErrorCode(error, 'ENOENT') ? 'absent' : `${path} is unavailable (${errorCause(error)})`
    }
}

// Rename replaces a planted symlink at the destination instead of writing through it.
async function replaceFile(directory: string, name: string, bytes: string): Promise<void> {
    const temporary = join(directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
    try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(directory, name))
    } finally {
        await rm(temporary, { force: true })
    }
}

/**
 * Record one passing measurement, replacing the row for the same runtime and daemon. A record that
 * cannot be read is replaced too, because every row in it is re-derivable by measuring, and the
 * result says so; refusing would leave an agent no way forward.
 */
export async function recordLocalRuntimeMeasurement(stateRoot: string, row: RuntimeMeasurementRow): Promise<RecordResult> {
    const path = join(stateRoot, MEASUREMENTS_PATH)
    const checked = Row.safeParse(row)
    if (!checked.success) return { kind: 'refusal', path, reason: `the measurement row is malformed (${checked.error.issues[0]?.message ?? 'invalid'})` }
    try {
        const directory = join(stateRoot, 'machine')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const state = await plainDirectory(directory)
        if (state !== 'present') return { kind: 'refusal', path, reason: state }
        const current = await readLocalRuntimeMeasurements(stateRoot)
        const existing = current.kind === 'read' ? current.rows : []
        const replaced = existing.find((candidate) => candidate.runtime === row.runtime && candidate.daemon === row.daemon) ?? null
        const kept = existing.filter((candidate) => candidate !== replaced)
        if (kept.length >= ROW_LIMIT) {
            return { kind: 'refusal', path, reason: `the record already holds ${ROW_LIMIT} other runtimes; remove the ones this machine no longer runs` }
        }
        const record = { format: FORMAT, measurements: [...kept, checked.data] }
        await replaceFile(directory, 'runtime-measurements.json', `${JSON.stringify(record, null, 2)}\n`)
        return { kind: 'complete', path, replaced, discardedUnreadable: current.kind === 'unreadable' ? current.reason : null }
    } catch (error) {
        return { kind: 'refusal', path, reason: `the record could not be written (${errorCause(error)})` }
    }
}
