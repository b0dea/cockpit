// Owns when `environment.seed` is due and the record of its last success. A seed fills the stack's
// resettable volumes, so it is due on the first start and again whenever one of those volumes was
// created after the last successful seed: after `reset`, a `docker volume rm`, or a start that
// failed before the seed ran. The record is the stack's data-outcome state; the volume creation
// times come from Docker, which the lifecycle composition reads and hands in.
import { isCanonicalTimestamp, type HolderId, type StackId } from './contract.js'
import { readState, transactState, type StateNamespace } from './state.js'

export const mechanism = {
    id: 'environment-seed',
    module: 'packages/cockpit/src/environment/seed.ts',
    exports: ['readSeededAt', 'recordSeeded', 'seedDue'],
} as const

/** The instant of the last successful seed, null when none is recorded, undefined when the record is unreadable. */
export async function readSeededAt(namespace: StateNamespace, stackId: StackId): Promise<string | null | undefined> {
    const record = await readState(namespace.paths.dataOutcome(stackId))
    if (record.kind === 'missing') return null
    if (record.kind !== 'complete' || record.value.kind !== 'data-outcome' || record.value.subjectId !== stackId) return undefined
    const value = record.value.value as unknown
    const seededAt = value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).join(',') === 'seededAt' ? (value as { seededAt: unknown }).seededAt : undefined
    return typeof seededAt === 'string' && isCanonicalTimestamp(seededAt) ? seededAt : undefined
}

export async function recordSeeded(input: Readonly<{
    namespace: StateNamespace
    stackId: StackId
    holderId: HolderId
    seededAt: string
}>): Promise<boolean> {
    const address = input.namespace.paths.dataOutcome(input.stackId)
    const result = await transactState(input.namespace, address, { ownerId: input.holderId }, (current) => ({
        format: 'cockpit-state/v1' as const,
        kind: 'data-outcome' as const,
        cockpitId: address.cockpitId,
        subjectId: input.stackId,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: input.seededAt,
        value: { seededAt: input.seededAt },
    }))
    return result.kind === 'complete'
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
