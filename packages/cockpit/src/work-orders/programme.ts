import { createHash } from 'node:crypto'
import { isParsedWorkOrder, WORK_ORDER_LIMITS, type ParsedWorkOrder } from './contract.js'
import { WORK_ORDER_INTAKE_LIMITS, type WorkOrderCapacity } from './intake.js'
import { isCurrentWorkPressure, type WorkPressureFacts } from './pressure.js'

export const mechanism = {
    id: 'work-order-programme',
    module: 'packages/cockpit/src/work-orders/programme.ts',
    exports: ['mintProgrammeWorkOrder'],
} as const

export interface ProgrammeItem {
    readonly key: string
    readonly objective: string
    readonly independentlyShippable: boolean
    readonly orderId: string | null
    readonly orderDigest: string | null
}
export interface ProgrammeLedger { readonly programme: string; readonly items: readonly ProgrammeItem[] }
export interface ProgrammeMintInput {
    readonly ledger: ProgrammeLedger
    readonly itemKey: string
    readonly candidate: ParsedWorkOrder
    readonly capacity: WorkOrderCapacity
    readonly pressure: WorkPressureFacts
    readonly actor: string
}
export interface ProgrammeRefusal {
    readonly kind: 'refusal'
    readonly code: 'WO_PROGRAMME_LEDGER' | 'WO_PROGRAMME_PRESSURE' | 'WO_PROGRAMME_CAP'
        | 'WO_PROGRAMME_ORDER' | 'WO_PROGRAMME_SHIPPABILITY' | 'WO_PROGRAMME_CONTRACT' | 'WO_PROGRAMME_PREDECESSOR'
    readonly message: string
}
export interface ProgrammeMint {
    readonly kind: 'mint'
    readonly actor: string
    readonly itemKey: string
    readonly shippability: 'instructed'
    readonly order: ParsedWorkOrder
    readonly expectedLedgerDigest: string
    readonly ledger: ProgrammeLedger
}
export interface ProgrammeExisting { readonly kind: 'existing'; readonly orderId: string; readonly itemKey: string }

const refuse = (code: ProgrammeRefusal['code'], message: string): ProgrammeRefusal => Object.freeze({ kind: 'refusal', code, message })
const boundedText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= WORK_ORDER_LIMITS.lineBytes && !/[\x00-\x1f\x7f]/.test(value)

export function mintProgrammeWorkOrder(input: ProgrammeMintInput): ProgrammeMint | ProgrammeExisting | ProgrammeRefusal {
    if (!input || typeof input !== 'object') return refuse('WO_PROGRAMME_LEDGER', 'Programme mint requires a complete request')
    const { ledger, candidate, capacity, pressure, actor, itemKey } = input
    if (!ledger || !/^[a-z][a-z0-9-]*$/.test(ledger.programme) || !boundedText(actor)
        || !Array.isArray(ledger.items) || !ledger.items.length || ledger.items.length > WORK_ORDER_INTAKE_LIMITS.inventory
        || ledger.items.some((item) => item === null || typeof item !== 'object')
        || new Set(ledger.items.map((item) => item.key)).size !== ledger.items.length
        || ledger.items.some((item) => !boundedText(item.key) || !boundedText(item.objective) || typeof item.independentlyShippable !== 'boolean'
            || !(item.orderId === null && item.orderDigest === null || typeof item.orderId === 'string' && /^WO-[0-9]{3,}$/.test(item.orderId)
                && typeof item.orderDigest === 'string' && /^[a-f0-9]{64}$/.test(item.orderDigest)))
        || new Set(ledger.items.filter((item) => item.orderId !== null).map((item) => item.orderId)).size !== ledger.items.filter((item) => item.orderId !== null).length) {
        return refuse('WO_PROGRAMME_LEDGER', 'Programme ledger requires bounded ordered intent, unique items and exact minted order bindings')
    }
    if (!isCurrentWorkPressure(pressure, capacity, ledger.programme)) return refuse('WO_PROGRAMME_PRESSURE', 'Observe current admitted policy and canonical orders for this programme before minting')
    if (!isParsedWorkOrder(candidate) || candidate.frontmatter.programme !== ledger.programme || candidate.frontmatter.status !== 'draft') {
        return refuse('WO_PROGRAMME_CONTRACT', 'Programme mint requires an issued draft contract in the same programme')
    }
    const requested = ledger.items.find((item) => item.key === itemKey)
    if (requested?.orderId !== null && requested?.orderId !== undefined) {
        const recorded = capacity.orders.find((entry) => entry.id === requested.orderId)?.contract
        return requested.orderId === candidate.frontmatter.id && requested.orderDigest === candidate.digest
            && isParsedWorkOrder(recorded) && recorded.digest === candidate.digest
            ? Object.freeze({ kind: 'existing', orderId: requested.orderId, itemKey })
            : refuse('WO_PROGRAMME_CONTRACT', 'This programme item is already bound to a different order or contract')
    }
    const nextIndex = ledger.items.findIndex((item) => item.orderId === null)
    if (nextIndex < 0 || ledger.items[nextIndex].key !== itemKey || ledger.items.slice(nextIndex + 1).some((item) => item.orderId !== null)) {
        return refuse('WO_PROGRAMME_ORDER', 'Only the next unminted programme item may mint an order')
    }
    for (const item of ledger.items.slice(0, nextIndex)) {
        const prior = capacity.orders.find((entry) => entry.id === item.orderId)?.contract
        if (!isParsedWorkOrder(prior) || prior.frontmatter.programme !== ledger.programme || !['completed', 'cancelled'].includes(prior.frontmatter.status)) {
            return refuse('WO_PROGRAMME_PREDECESSOR', `Programme predecessor ${item.orderId} has not completed or been cancelled`)
        }
    }
    if (!ledger.items[nextIndex].independentlyShippable) return refuse('WO_PROGRAMME_SHIPPABILITY', 'The next programme item must be independently shippable; this judgement is instructed')
    if (capacity.orders.some((entry) => entry.id === candidate.frontmatter.id)) return refuse('WO_PROGRAMME_CONTRACT', 'Minted work-order identity already exists in the canonical inventory')
    if (pressure.cockpitRemaining < 1 || pressure.programmeRemaining < 1) return refuse('WO_PROGRAMME_CAP', 'Cockpit or programme capacity is exhausted before minting')
    // The persistence owner must compare this digest and capacity again while
    // atomically recording both the order and ledger binding.
    const expectedLedgerDigest = createHash('sha256').update(JSON.stringify(ledger)).digest('hex')
    const items = ledger.items.map((item, index) => Object.freeze(index === nextIndex
        ? { ...item, orderId: candidate.frontmatter.id, orderDigest: candidate.digest } : { ...item }))
    return Object.freeze({ kind: 'mint', actor, itemKey, shippability: 'instructed', order: candidate, expectedLedgerDigest,
        ledger: Object.freeze({ programme: ledger.programme, items: Object.freeze(items) }) })
}
