import { WORK_ORDER_LIMITS } from './contract.js'
import { WORK_ORDER_INTAKE_LIMITS, type WorkOrderCapacity } from './intake.js'
import { assessWorkPressure } from './pressure.js'

export const mechanism = {
    id: 'work-order-metrics',
    module: 'packages/cockpit/src/work-orders/metrics.ts',
    exports: ['collectWorkOrderMetrics', 'renderWorkOrderMetrics'],
} as const

export interface WorkOrderHistoryEntry {
    readonly id: string
    readonly createdAt: number
    readonly firstHeartbeatAt: number | null
    readonly everStarted: boolean
}
export interface WorkOrderMetricHistory {
    readonly writer: string
    readonly coverage: 'complete' | 'partial' | 'unavailable'
    readonly entries: readonly WorkOrderHistoryEntry[]
}
export interface WorkOrderProcessObservation {
    readonly writer: string
    readonly argv: readonly string[]
    readonly exitCode: number | null
    readonly signal: string | null
    readonly stdout: string
}
export interface WorkOrderMetricsInput {
    readonly capacity: WorkOrderCapacity
    readonly inventoryWriter: string
    readonly history: WorkOrderMetricHistory
    readonly process: WorkOrderProcessObservation | null
}
export interface WorkOrderMetricCount { readonly name: string; readonly value: number | undefined; readonly writer: string }
export interface WorkOrderMetricRatio extends WorkOrderMetricCount {
    readonly numerator: number | undefined
    readonly denominator: number | undefined
    readonly definition: string
}
export interface WorkOrderMetrics {
    readonly kind: 'metrics'
    readonly counts: readonly WorkOrderMetricCount[]
    readonly ratios: readonly WorkOrderMetricRatio[]
    readonly history: Readonly<{ coverage: WorkOrderMetricHistory['coverage']; observedOrders: number; totalOrders: number; writer: string }>
    readonly heartbeat: Readonly<{ samples: number; meanMs: number | undefined; writer: string }>
}
export interface WorkOrderMetricsRefusal {
    readonly kind: 'refusal'
    readonly code: 'WO_METRICS_INVENTORY' | 'WO_METRICS_HISTORY' | 'WO_METRICS_PROCESS'
    readonly message: string
}
interface ProcessCounts { fixRuns: number; workOrderRuns: number; ceremonyArtifacts: number; productChanges: number }

const refuse = (code: WorkOrderMetricsRefusal['code'], message: string): WorkOrderMetricsRefusal => Object.freeze({ kind: 'refusal', code, message })
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= WORK_ORDER_LIMITS.lineBytes && !/[\x00-\x1f\x7f]/.test(value)
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function processCounts(observation: WorkOrderProcessObservation): ProcessCounts | WorkOrderMetricsRefusal {
    if (!observation || typeof observation !== 'object' || !text(observation.writer) || !Array.isArray(observation.argv) || !observation.argv.length
        || observation.argv.length > WORK_ORDER_LIMITS.arguments || !observation.argv.every(text)
        || Buffer.byteLength(JSON.stringify(observation.argv)) > WORK_ORDER_LIMITS.commandBytes
        || observation.exitCode !== 0 || observation.signal !== null || typeof observation.stdout !== 'string'
        || !observation.stdout.trim() || Buffer.byteLength(observation.stdout) > WORK_ORDER_LIMITS.bytes) {
        return refuse('WO_METRICS_PROCESS', 'Process metrics require a named writer, bounded argv/output, exit 0, no signal and nonempty output')
    }
    let decoded: unknown
    try { decoded = JSON.parse(observation.stdout) } catch {
        return refuse('WO_METRICS_PROCESS', 'Process metrics output is not valid JSON')
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)
        || Object.keys(decoded).length !== 4 || !('fixRuns' in decoded) || !('workOrderRuns' in decoded)
        || !('ceremonyArtifacts' in decoded) || !('productChanges' in decoded)
        || !nonnegative(decoded.fixRuns) || !nonnegative(decoded.workOrderRuns)
        || !nonnegative(decoded.ceremonyArtifacts) || !nonnegative(decoded.productChanges)
        || !Number.isSafeInteger(decoded.fixRuns + decoded.workOrderRuns)) {
        return refuse('WO_METRICS_PROCESS', 'Process metrics require exactly four nonnegative safe integer counts: fixRuns, workOrderRuns, ceremonyArtifacts, productChanges')
    }
    return { fixRuns: decoded.fixRuns, workOrderRuns: decoded.workOrderRuns, ceremonyArtifacts: decoded.ceremonyArtifacts, productChanges: decoded.productChanges }
}

export function collectWorkOrderMetrics(input: WorkOrderMetricsInput): WorkOrderMetrics | WorkOrderMetricsRefusal {
    if (!input || typeof input !== 'object') return refuse('WO_METRICS_INVENTORY', 'Metrics require a complete observation request')
    const pressure = assessWorkPressure(input.capacity)
    if (pressure.kind === 'refusal' || !text(input.inventoryWriter)) return refuse('WO_METRICS_INVENTORY', pressure.kind === 'refusal' ? pressure.message : 'Metrics require a named inventory writer')
    const { history, process } = input
    const ids = new Set(input.capacity.orders.map((entry) => entry.id))
    if (!history || !text(history.writer) || !['complete', 'partial', 'unavailable'].includes(history.coverage)
        || !Array.isArray(history.entries) || history.entries.length > WORK_ORDER_INTAKE_LIMITS.inventory
        || history.entries.some((entry) => entry === null || typeof entry !== 'object')
        || new Set(history.entries.map((entry) => entry.id)).size !== history.entries.length
        || history.entries.some((entry) => !ids.has(entry.id) || !nonnegative(entry.createdAt) || typeof entry.everStarted !== 'boolean'
            || entry.firstHeartbeatAt !== null && (!nonnegative(entry.firstHeartbeatAt) || entry.firstHeartbeatAt < entry.createdAt || !entry.everStarted))
        || history.coverage === 'complete' && history.entries.length !== ids.size
        || history.coverage === 'unavailable' && history.entries.length !== 0) {
        return refuse('WO_METRICS_HISTORY', 'History requires bounded unique current/archived order identities, honest coverage and chronological first-heartbeat observations')
    }
    const produced = process === null ? undefined : processCounts(process)
    if (produced && 'kind' in produced) return produced
    const processWriter = process?.writer ?? 'unavailable'
    const inert = history.entries.length === ids.size && history.coverage !== 'unavailable'
        ? history.entries.filter((entry) => !entry.everStarted).length : undefined
    const count = (name: string, value: number | undefined, writer: string): WorkOrderMetricCount => Object.freeze({ name, value, writer })
    const ratio = (name: string, numerator: number | undefined, denominator: number | undefined, writer: string, definition: string): WorkOrderMetricRatio => Object.freeze({ name, numerator, denominator,
        value: numerator === undefined || denominator === undefined || denominator === 0 ? undefined : numerator / denominator, writer, definition })
    const delays = history.entries.flatMap((entry) => entry.firstHeartbeatAt === null ? [] : [entry.firstHeartbeatAt - entry.createdAt])
    const counts = [
        count('work-orders', ids.size, input.inventoryWriter), count('open-work-orders', pressure.open, input.inventoryWriter),
        count('inert-work-orders', inert, history.writer), count('fix-runs', produced?.fixRuns, processWriter),
        count('work-order-runs', produced?.workOrderRuns, processWriter), count('ceremony-artifacts', produced?.ceremonyArtifacts, processWriter),
        count('product-changes', produced?.productChanges, processWriter), count('first-heartbeat-samples', delays.length, history.writer),
    ]
    return Object.freeze({ kind: 'metrics', counts: Object.freeze(counts), ratios: Object.freeze([
        // Parking or archiving cannot improve this denominator: the adapter must
        // supply all orders, including retained terminal history, in the one inventory.
        ratio('inert-ratio', inert, ids.size, history.writer, 'never-started orders / all current and archived work orders'),
        ratio('fix-door-ratio', produced?.fixRuns, produced === undefined ? undefined : produced.fixRuns + produced.workOrderRuns,
            processWriter, 'fix runs / all recorded fix and work-order runs'),
        ratio('ceremony-ratio', produced?.ceremonyArtifacts, produced?.productChanges, processWriter, 'ceremony artifacts / recorded product changes'),
    ]), history: Object.freeze({ coverage: history.coverage, observedOrders: history.entries.length, totalOrders: ids.size, writer: history.writer }),
    heartbeat: Object.freeze({ samples: delays.length, meanMs: delays.length ? delays.reduce((sum, value) => sum + value / delays.length, 0) : undefined, writer: history.writer }) })
}

export function renderWorkOrderMetrics(metrics: WorkOrderMetrics): string {
    const show = (value: number | undefined) => value === undefined ? 'unavailable' : String(value)
    return [
        ...metrics.counts.map((metric) => `${metric.name}: ${show(metric.value)}; writer=${metric.writer}`),
        ...metrics.ratios.map((metric) => `${metric.name}: ${show(metric.value)} (${show(metric.numerator)}/${show(metric.denominator)}); ${metric.definition}; writer=${metric.writer}`),
        `first-heartbeat-mean-ms: ${show(metrics.heartbeat.meanMs)}; writer=${metrics.heartbeat.writer}`,
        `history=${metrics.history.coverage} (${metrics.history.observedOrders}/${metrics.history.totalOrders} orders); writer=${metrics.history.writer}`,
    ].join('\n')
}
