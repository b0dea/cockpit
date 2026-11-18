/**
 * Steps that wait for a person. When an agent's run of sync, reset, stacks prune or a person's work
 * step stops short of a person, cockpit records the command here; `cockpit approve`, which a person
 * runs in a terminal outside the agent, runs each one again against the current state with the person
 * answering. The record holds only what to run, never what to show, so nothing in it is trusted as
 * the thing approved. It is machine-local, under `.cockpit/local`.
 */
import { join } from 'node:path'

import { readBoundedFile } from './bounded-read.js'
import { commandSpelling } from './command-table.js'
import { errorCause, hasErrorCode, tryParseJson } from './environment/contract.js'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles } from './guards/local-identity.js'

const FORMAT = 'cockpit-pending-approvals/v1'
const NAME = 'pending-approvals'
export const PENDING_APPROVALS_PATH = `${GUARD_LOCAL_PATHS.directory}/${NAME}`
// A person reads every item in one sitting, so the list keeps the newest few.
const MAX_ITEMS = 20
const MAX_BYTES = 262_144
/** The commands approve runs; any other in the record means cockpit did not write it. */
const APPROVABLE = new Set(['sync', 'reset', 'stacks', 'work accept', 'work signoff', 'work acknowledge', 'work retry'])

export type PendingApproval = Readonly<{ argv: readonly string[]; config: string; title: string; at: string }>
type Read = Readonly<{ kind: 'complete'; items: readonly PendingApproval[] }> | Readonly<{ kind: 'refusal'; message: string }>

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const valid = (row: unknown): row is PendingApproval => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
    const item = row as Record<string, unknown>
    return Object.keys(item).sort().join(',') === 'argv,at,config,title' && Array.isArray(item.argv) && item.argv.length <= 64
        && item.argv.every(word => typeof word === 'string' && word.length <= 4_096 && !/[\x00-\x1f\x7f]/.test(word))
        && APPROVABLE.has(commandSpelling(item.argv as string[]).name ?? '') && text(item.config, 4_096) && text(item.title, 512) && text(item.at, 64)
        // The command runs on the configuration it names last, which is the one recorded.
        && item.argv.at(-2) === '--config' && item.argv.at(-1) === item.config
}

/** What waits for a person under `root`; none when nothing was recorded. A record cockpit did not write is refused, never ignored. */
export function readPendingApprovals(root: string): Read {
    const path = join(root, PENDING_APPROVALS_PATH)
    const refused = (reason: string): Read => ({ kind: 'refusal', message: `${path} is not a list of pending approvals cockpit wrote (${reason})` })
    let bytes: Buffer
    try {
        const read = readBoundedFile(path, MAX_BYTES)
        if (read.kind === 'too-large') return refused(`it is larger than ${MAX_BYTES} bytes`)
        bytes = read.bytes
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { kind: 'complete', items: [] }
        return refused(`it could not be read: ${errorCause(error)}`)
    }
    const value = tryParseJson(bytes.toString('utf8')) as { format?: unknown; items?: unknown } | null
    if (value === null || typeof value !== 'object' || value.format !== FORMAT || !Array.isArray(value.items) || !value.items.every(valid)) {
        return refused(`it does not carry the ${FORMAT} format`)
    }
    return { kind: 'complete', items: value.items }
}

const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((word, index) => word === right[index])

async function write(root: string, items: readonly PendingApproval[]): Promise<string | undefined> {
    const written = await writeCockpitLocalFiles(root, [{ name: NAME, bytes: `${JSON.stringify({ format: FORMAT, items })}\n` }])
    return written.kind === 'complete' ? undefined : written.message
}

/** Records one command for a person, replacing an earlier record of the same command; the reason when it could not. */
export async function recordPendingApproval(root: string, item: PendingApproval): Promise<string | undefined> {
    const read = readPendingApprovals(root)
    if (read.kind === 'refusal') return read.message
    return write(root, [...read.items.filter(row => !same(row.argv, item.argv)), item].slice(-MAX_ITEMS))
}

/** Removes a command a person answered; the reason when it could not. */
export async function removePendingApproval(root: string, argv: readonly string[]): Promise<string | undefined> {
    const read = readPendingApprovals(root)
    if (read.kind === 'refusal') return read.message
    return write(root, read.items.filter(row => !same(row.argv, argv)))
}
