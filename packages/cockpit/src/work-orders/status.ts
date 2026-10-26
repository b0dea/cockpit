import { isParsedWorkOrder, type ParsedWorkOrder, type WorkOrderStatus } from './contract.js'
import { parseWorkOrderSourceEvidenceReference, readWorkOrderState, validateWorkOrderRepositories, workOrderProofIsCurrent,
    type WorkOrderExecutionState, type WorkOrderRepository, type WorkOrderStateRefusal } from './state.js'

export const mechanism = {
    id: 'work-order-status',
    module: 'packages/cockpit/src/work-orders/status.ts',
    exports: ['projectWorkOrderStatus'],
} as const

export interface WorkOrderStatusInput {
    readonly orders: readonly { readonly contract: unknown; readonly state: Uint8Array | null }[]
    readonly repositories: readonly WorkOrderRepository[]
    readonly sourceEvidence?: readonly WorkOrderSourceEvidenceObservation[]
}
export type WorkOrderSourceEvidenceObservation =
    | Readonly<{ path: string; state: 'available'; sha256: string }>
    | Readonly<{ path: string; state: 'unavailable'; reason: string }>
export interface WorkOrderDrift {
    readonly path: string
    readonly expected: string | null
    readonly actual: string | null
    readonly expectedWorktreeDigest?: string | null
    readonly actualWorktreeDigest?: string | null
}
export interface WorkOrderEvidenceStatus { readonly reference: string; readonly freshness: 'current' | 'stale' | 'unavailable' | 'unbound'; readonly reason?: string }
export type WorkOrderEvidenceLayers = { readonly [K in ParsedWorkOrder['evidence'][number]['layer']]: readonly WorkOrderEvidenceStatus[] }
export interface WorkOrderStatusRow {
    readonly id: string; readonly status: WorkOrderStatus; readonly contract: ParsedWorkOrder
    readonly state: WorkOrderExecutionState | null; readonly drift: readonly WorkOrderDrift[]; readonly layers: WorkOrderEvidenceLayers
}
export interface WorkOrderStatusRefusal { readonly kind: 'refusal'; readonly code: 'WO_STATUS_AMBIGUOUS' | 'WO_STATUS_INVALID'; readonly message: string }
export type WorkOrderStatusResult = Readonly<{ kind: 'complete'; active: readonly string[]; orders: readonly WorkOrderStatusRow[] }> | WorkOrderStateRefusal | WorkOrderStatusRefusal

export function projectWorkOrderStatus(input: WorkOrderStatusInput): WorkOrderStatusResult {
    if (!Array.isArray(input.orders) || input.orders.length > 1_024) return { kind: 'refusal', code: 'WO_STATUS_INVALID', message: 'Status requires a bounded order inventory' }
    if (!Array.isArray(input.repositories) || input.repositories.length && !validateWorkOrderRepositories(input.repositories)) return { kind: 'refusal', code: 'WO_STATUS_INVALID', message: 'Current repository observations are malformed or ambiguous' }
    const sourceEvidence = input.sourceEvidence ?? []
    if (!Array.isArray(sourceEvidence) || sourceEvidence.length > 4_096 || new Set(sourceEvidence.map(entry => entry?.path)).size !== sourceEvidence.length
        || sourceEvidence.some(entry => {
            if (!entry || typeof entry.path !== 'string' || !entry.path) return true
            if (entry.state === 'available') return Object.keys(entry).sort().join(',') !== 'path,sha256,state' || !/^[a-f0-9]{64}$/.test(entry.sha256)
            return entry.state !== 'unavailable' || Object.keys(entry).sort().join(',') !== 'path,reason,state'
                || typeof entry.reason !== 'string' || !entry.reason.trim() || Buffer.byteLength(entry.reason) > 4_096
        })) {
        return { kind: 'refusal', code: 'WO_STATUS_INVALID', message: 'Selected source observations are malformed or ambiguous' }
    }
    const rows: WorkOrderStatusRow[] = []
    for (const entry of input.orders) {
        const contract = entry.contract
        if (!isParsedWorkOrder(contract)) return { kind: 'refusal', code: 'WO_CONTRACT_INVALID', message: 'Status requires contracts issued by the canonical parser' }
        if (rows.some((row) => row.id === contract.frontmatter.id)) return { kind: 'refusal', code: 'WO_STATUS_AMBIGUOUS', message: `Duplicate work-order identity ${contract.frontmatter.id}` }
        const loaded = entry.state === null ? null : readWorkOrderState(contract, entry.state)
        if (loaded?.kind === 'refusal') return loaded
        const state = loaded?.value ?? null
        if (!state && ['active', 'blocked', 'completed'].includes(contract.frontmatter.status)) return { kind: 'refusal', code: 'WO_STATE_INVALID', message: `${contract.frontmatter.id} requires durable execution state` }
        const drift: WorkOrderDrift[] = []
        if (state) {
            for (const expected of state.repositories) {
                const actual = input.repositories.find((entry) => entry.path === expected.path)
                if (expected.revision !== (actual?.revision ?? null)
                    || expected.worktreeDigest !== actual?.worktreeDigest) drift.push({ path: expected.path,
                    expected: expected.revision, actual: actual?.revision ?? null,
                    expectedWorktreeDigest: expected.worktreeDigest ?? null, actualWorktreeDigest: actual?.worktreeDigest ?? null })
            }
            for (const actual of input.repositories) if (!state.repositories.some((entry) => entry.path === actual.path)) drift.push({ path: actual.path,
                expected: null, actual: actual.revision, expectedWorktreeDigest: null, actualWorktreeDigest: actual.worktreeDigest ?? null })
        }
        const layers: { [K in keyof WorkOrderEvidenceLayers]: WorkOrderEvidenceStatus[] } = { source: [], local: [], ci: [], runtime: [], deployment: [] }
        for (const entry of contract.evidence) layers[entry.layer].push(Object.freeze({ reference: entry.reference, freshness: 'unbound' }))
        if (state) for (const proof of [...state.evidence, ...state.steps.flatMap((step) => step.checked ? [step.checked] : [])]) {
            if (proof.layer !== 'source') {
                layers[proof.layer].push(Object.freeze({ reference: proof.reference, freshness: workOrderProofIsCurrent(proof, contract, input.repositories) ? 'current' : 'stale' }))
                continue
            }
            const selected = parseWorkOrderSourceEvidenceReference(proof.reference)
            const observation = selected && sourceEvidence.find(entry => entry.path === selected.path)
            const current = workOrderProofIsCurrent(proof, contract, input.repositories)
            layers.source.push(Object.freeze(!selected
                ? { reference: proof.reference, freshness: 'unavailable' as const, reason: 'Source evidence reference is invalid' }
                : !observation
                    ? { reference: proof.reference, freshness: 'unavailable' as const, reason: 'Selected source observation is unavailable' }
                    : observation.state === 'unavailable'
                        ? { reference: proof.reference, freshness: 'unavailable' as const, reason: observation.reason }
                        : { reference: proof.reference, freshness: current && observation.sha256 === selected.sha256 ? 'current' as const : 'stale' as const }))
        }
        for (const values of Object.values(layers)) Object.freeze(values)
        rows.push(Object.freeze({ id: contract.frontmatter.id, status: contract.frontmatter.status, contract, state, drift: Object.freeze(drift.map((entry) => Object.freeze(entry))), layers: Object.freeze(layers) }))
    }
    return Object.freeze({ kind: 'complete', active: Object.freeze(rows.filter((row) => row.status === 'active').map((row) => row.id)), orders: Object.freeze(rows) })
}
