// Owns when `environment.seed` is due. A seed fills the stack's resettable volumes, so it is due on
// the first start and again whenever one of those volumes was created after the last successful seed:
// after `reset`, a `docker volume rm`, or a start that failed before the seed ran. The last success is
// kept in the stack's lifecycle record; the volume creation times come from Docker, which the
// lifecycle composition reads and hands in.
import { type HolderId, type StackId } from './contract.js'
import { decodeLifecycleRecord, updateLifecycleRecord } from './lifecycle-stage.js'
import { readState, type StateNamespace } from './state.js'

/** The instant of the last successful seed, null when none is recorded, undefined when the record is unreadable. */
export async function readSeededAt(namespace: StateNamespace, stackId: StackId): Promise<string | null | undefined> {
    const address = namespace.paths.lifecycle(stackId)
    const record = await readState(address)
    if (record.kind === 'missing') return null
    if (record.kind !== 'complete') return undefined
    const lifecycle = decodeLifecycleRecord(record.value, { cockpitId: address.cockpitId, stackId })
    return lifecycle ? lifecycle.value.seededAt ?? null : undefined
}

export async function recordSeeded(input: Readonly<{
    namespace: StateNamespace
    stackId: StackId
    holderId: HolderId
    seededAt: string
}>): Promise<boolean> {
    const result = await updateLifecycleRecord({ ...input, change: { seededAt: input.seededAt } })
    return result.kind !== 'refusal'
}

/**
 * Docker records a volume's creation in whole seconds, so a volume created in the second the seed
 * was recorded is read as the one the seed filled: a start creates the volume and seeds it moments
 * later, and reading it as newer would seed again on every later `up`.
 */
export function seedDue(seededAt: string | null, volumesCreatedAt: readonly number[]): boolean {
    if (seededAt === null) return true
    const seededSecond = Math.floor(Date.parse(seededAt) / 1000)
    return volumesCreatedAt.some((instant) => Math.floor(instant / 1000) > seededSecond)
}
