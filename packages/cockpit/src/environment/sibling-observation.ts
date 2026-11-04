// Owns: observing whether each checkout recorded to serve a sibling still exists. It is the one
// verdict preflight, doctor and `up` share: `up` refuses a vanished served checkout, so a gate that
// only warned about it would pass a stack `up` cannot start. Must not: decide the health verdict
// (observations.ts) or inspect whether a checkout belongs to its sibling (sibling-checkouts.ts).
import { dirname } from 'node:path'
import type { CockpitConfig } from '../schema.js'
import {
    ENVIRONMENT_CODES,
    RefusalError,
    snapshotEnvironmentObservation,
    type EnvironmentObservation,
    type StackId,
} from './contract.js'
import { loadServedSiblings, SIBLING_CHECKOUTS_PATH, vanishedCheckoutFix, vanishedServedCheckouts } from './sibling-checkouts.js'

const OWNER = 'sibling-observation'

export const observationDeclarations = Object.freeze([
    { id: 'served-checkouts', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.SIBLING_CHECKOUT_UNAVAILABLE, isIssued: isSiblingObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()

function isSiblingObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

/** One row: the directories that should serve a sibling and do not exist. Passing means none. */
export async function observeServedCheckouts(input: Readonly<{
    stackId: StackId
    observedAt: string
    configPath: string
    config: Pick<CockpitConfig, 'cockpit' | 'sibling'>
}>): Promise<readonly EnvironmentObservation[]> {
    const served = await loadServedSiblings(dirname(input.configPath), input.config)
    let missing: readonly string[]
    let remedy: string
    if (served.kind === 'refusal') {
        // `up` refuses an unreadable record as well: no one can say which checkout serves a sibling.
        missing = [SIBLING_CHECKOUTS_PATH]
        remedy = served.diagnostic.fix ?? `repair ${SIBLING_CHECKOUTS_PATH}`
    } else {
        const vanished = await vanishedServedCheckouts(served.siblings)
        missing = vanished.map(sibling => sibling.served)
        remedy = vanished.length === 0 ? 'no action needed' : vanished.map(sibling => `${sibling.slug}: ${vanishedCheckoutFix(sibling.slug)}`).join('; ')
    }
    const snapshot = snapshotEnvironmentObservation({
        code: ENVIRONMENT_CODES.SIBLING_CHECKOUT_UNAVAILABLE, owner: OWNER, stackId: input.stackId, source: 'served-checkouts',
        observed: { state: 'available', value: missing, observedAt: input.observedAt },
        expectation: { kind: 'equal', value: [] },
        applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' }, remedy,
    })
    if (!snapshot) throw new RefusalError('served-checkouts observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return [snapshot]
}
