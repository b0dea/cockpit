import { isProxy } from 'node:util/types'
import { executeBrowserCommand } from '../browser/commands.js'
import { evaluateUiGate } from '../browser/ui-gate.js'
import { completeWorkOrder } from '../grading/completion.js'
import { runGate } from '../testing/gates.js'
import { executeWorkOrderStep } from './executor.js'
import { acceptWorkOrder, beginWorkOrderAcceptance, beginWorkOrderRenewal, intakeWorkOrder, routeWorkOrder } from './intake.js'
import { collectWorkOrderMetrics, renderWorkOrderMetrics } from './metrics.js'
import { assessWorkOrderSize, assessWorkPressure, applyWorkOrderSweep, planWorkOrderSweep, reverseWorkOrderSweep } from './pressure.js'
import { mintProgrammeWorkOrder } from './programme.js'
import { reviewWorkOrderWave } from './review.js'
import { resumeWorkOrder } from './resume.js'
import { persistWorkOrderProgress } from './state.js'
import { projectWorkOrderStatus } from './status.js'
import { isWorkApplicationComposition, type WorkApplicationComposition } from './composition.js'

export const mechanism = {
    id: 'work-order-application',
    module: 'packages/cockpit/src/work-orders/application.ts',
    exports: ['captureWorkApplicationRequest', 'runWorkApplication'],
} as const

export type WorkApplicationRequest =
    | Readonly<{ operation: 'work-intake'; workOrderId: string }>
    | Readonly<{ operation: 'work-intake'; intent: string; candidate?: string }>
    | Readonly<{ operation: 'work-accept' | 'work-renew' | 'work-grade' | 'work-review'; workOrderId: string }>
    | Readonly<{ operation: 'work-status'; workOrderId?: string }>
    | Readonly<{ operation: 'work-resume' | 'work-metrics' }>
    | Readonly<{ operation: 'work-recover'; lockId: string; apply: boolean }>
    | Readonly<{ operation: 'work-execute'; workOrderId: string; approach: string }>
    | Readonly<{ operation: 'work-record'; workOrderId: string; eventFile: string }>
    | Readonly<{ operation: 'work-sweep'; apply: boolean }>
    | Readonly<{ operation: 'work-reverse'; workOrderId: string }>
    | Readonly<{ operation: 'work-programme-mint'; programmeId: string; itemKey?: string; candidate?: string }>
    | Readonly<{ operation: 'browser-drive' | 'browser-accessibility' | 'browser-screenshot' | 'browser-debugger'; role?: string }>
    | Readonly<{ operation: 'test-run'; gate: string; mode: 'canonical' | 'full' | 'staged'; select?: Readonly<{ kind: 'spec' | 'file' | 'test' | 'route'; value: string }> }>

export interface WorkApplicationContinuation { readonly digest: string; readonly prompt: string; readonly decide: (answer: string) => Promise<WorkApplicationOutcome> }
export type WorkApplicationOutcome =
    | Readonly<{ kind: 'complete'; operation: WorkApplicationRequest['operation']; value: unknown }>
    | Readonly<{ kind: 'human-needed'; operation: 'work-accept' | 'work-renew'; continuation: WorkApplicationContinuation }>
    | Readonly<{ kind: 'refusal'; operation: WorkApplicationRequest['operation'] | 'invalid'; reason: string }>

interface OperationShape { readonly required: readonly string[]; readonly optional?: readonly string[] }
const operationKeys: Readonly<Record<WorkApplicationRequest['operation'], OperationShape>> = Object.freeze({
    'work-intake': { required: ['operation'], optional: ['workOrderId', 'intent', 'candidate'] }, 'work-accept': { required: ['operation', 'workOrderId'] },
    'work-renew': { required: ['operation', 'workOrderId'] }, 'work-status': { required: ['operation'], optional: ['workOrderId'] },
    'work-resume': { required: ['operation'] }, 'work-recover': { required: ['operation', 'lockId', 'apply'] }, 'work-execute': { required: ['operation', 'workOrderId', 'approach'] },
    'work-record': { required: ['operation', 'workOrderId', 'eventFile'] },
    'work-sweep': { required: ['operation', 'apply'] }, 'work-reverse': { required: ['operation', 'workOrderId'] },
    'work-programme-mint': { required: ['operation', 'programmeId'], optional: ['itemKey', 'candidate'] }, 'work-metrics': { required: ['operation'] },
    'work-grade': { required: ['operation', 'workOrderId'] }, 'work-review': { required: ['operation', 'workOrderId'] }, 'browser-drive': { required: ['operation'], optional: ['role'] },
    'browser-accessibility': { required: ['operation'], optional: ['role'] }, 'browser-screenshot': { required: ['operation'], optional: ['role'] },
    'browser-debugger': { required: ['operation'], optional: ['role'] }, 'test-run': { required: ['operation', 'gate', 'mode'], optional: ['select'] },
})
function ownData(value: unknown): Record<string, unknown> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string') || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) return undefined
        return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    } catch { return undefined }
}
function printable(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code < 32 || code >= 127 && code <= 159) return false }
    return true
}
function bounded(value: unknown, pattern: RegExp, maximum: number): value is string {
    return typeof value === 'string' && Buffer.byteLength(value) <= maximum && printable(value) && pattern.test(value)
}
const relativeSelector = (value: unknown): value is string => bounded(value, /^[A-Za-z0-9._/-]+$/, 4_096)
    && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
export function captureWorkApplicationRequest(value: unknown): WorkApplicationRequest | undefined {
    const row = ownData(value)
    if (!row || typeof row.operation !== 'string' || !Object.hasOwn(operationKeys, row.operation)) return undefined
    const operation = row.operation as WorkApplicationRequest['operation']; const shape = operationKeys[operation]
    const allowed = [...shape.required, ...(shape.optional ?? [])]; const keys = Object.keys(row)
    if (keys.some(key => !allowed.includes(key)) || shape.required.some(key => !Object.hasOwn(row, key))) return undefined
    const requiresWorkOrderId = shape.required.includes('workOrderId')
    if (requiresWorkOrderId && !bounded(row.workOrderId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 128)
        || !requiresWorkOrderId && row.workOrderId !== undefined
            && !bounded(row.workOrderId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 128)) return undefined
    if ('approach' in row && !bounded(row.approach, /^.+$/, 4_096)) return undefined
    if ('programmeId' in row && !bounded(row.programmeId, /^[a-z][a-z0-9-]{0,63}$/, 64)) return undefined
    if ('itemKey' in row && row.itemKey !== undefined && !bounded(row.itemKey, /^[a-z][a-z0-9-]{0,63}$/, 64)) return undefined
    if ('eventFile' in row && !relativeSelector(row.eventFile)) return undefined
    if ('lockId' in row && row.lockId !== '.admission-capacity' && row.lockId !== '.identity-admission'
        && !bounded(row.lockId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 128)) return undefined
    if ('intent' in row && !relativeSelector(row.intent) || 'candidate' in row && row.candidate !== undefined && !relativeSelector(row.candidate)) return undefined
    if (operation === 'work-intake' && (typeof row.workOrderId === 'string') === (typeof row.intent === 'string')
        || operation === 'work-intake' && row.candidate !== undefined && typeof row.intent !== 'string') return undefined
    if ('apply' in row && typeof row.apply !== 'boolean') return undefined
    if ('gate' in row && !bounded(row.gate, /^[a-z][a-z0-9-]{0,63}$/, 64)) return undefined
    if ('role' in row && row.role !== undefined && !bounded(row.role, /^[a-z0-9][a-z0-9_-]{0,63}$/, 64)) return undefined
    if ('mode' in row && !['canonical', 'full', 'staged'].includes(row.mode as string)) return undefined
    if ('select' in row && row.select !== undefined) {
        const select = ownData(row.select)
        if (!select || Object.keys(select).sort().join(',') !== 'kind,value' || !['spec', 'file', 'test', 'route'].includes(select.kind as string) || !bounded(select.value, /^.+$/, 4_096)) return undefined
        row.select = Object.freeze({ kind: select.kind, value: select.value })
    }
    return Object.freeze(row) as unknown as WorkApplicationRequest
}
const refusal = (operation: WorkApplicationOutcome['operation'], reason: string): WorkApplicationOutcome => Object.freeze({ kind: 'refusal', operation, reason })
const complete = (operation: WorkApplicationRequest['operation'], value: unknown): WorkApplicationOutcome => Object.freeze({ kind: 'complete', operation, value })

export async function runWorkApplication(request: WorkApplicationRequest, composition: WorkApplicationComposition): Promise<WorkApplicationOutcome> {
    const captured = captureWorkApplicationRequest(request)
    if (!captured) return refusal('invalid', 'Work application requests require a closed selector-only shape')
    if (!isWorkApplicationComposition(composition)) return refusal('invalid', 'An issued work application composition is required')
    const operation = captured.operation
    try {
        if (operation === 'work-status' || operation === 'work-resume') {
            const input = await composition.status(); const result = operation === 'work-status' ? projectWorkOrderStatus(input) : resumeWorkOrder(input, composition.policy)
            if (result.kind === 'refusal') return refusal(operation, result.message)
            return complete(operation, operation === 'work-status' && captured.workOrderId && result.kind === 'complete' ? { ...result, orders: result.orders.filter(row => row.id === captured.workOrderId) } : result)
        }
        if (operation === 'work-recover') {
            const result = await composition.recovery(captured.lockId, captured.apply)
            return result.kind === 'held'
                ? refusal(operation, `Recovery held for lock ${result.lockId} at ${result.target}; holder=${result.holder}; pid=${result.pid ?? 'unavailable'}; ${result.recovery}`)
                : complete(operation, result)
        }
        if (operation === 'work-intake') {
            const prepared = 'intent' in captured ? await composition.intent(captured.intent, captured.candidate) : await composition.intake(captured.workOrderId)
            const route = prepared.origin === 'existing' ? routeWorkOrder(prepared.routing, prepared.capacity) : prepared.route
            if (route.kind === 'refusal') return refusal(operation, route.message)
            if (route.kind === 'fix') return complete(operation, route)
            if (prepared.origin === 'intent-route') return complete(operation, { route, candidateRequired: true, intent: prepared.intentPath })
            const draft = intakeWorkOrder({ route, contract: prepared.contract, sourceAudit: prepared.sourceAudit, installedSkills: prepared.installedSkills })
            if (draft.kind === 'refusal') return refusal(operation, draft.message)
            if (prepared.origin === 'intent') await composition.persistDraft(prepared, draft)
            return complete(operation, draft)
        }
        if (operation === 'work-accept' || operation === 'work-renew') {
            const prepared = await composition.acceptance(captured.workOrderId)
            const route = routeWorkOrder(prepared.intake.routing, prepared.intake.capacity)
            const compiled = intakeWorkOrder({ route, contract: prepared.intake.contract, sourceAudit: prepared.intake.sourceAudit, installedSkills: prepared.intake.installedSkills })
            if (compiled.kind === 'refusal') return refusal(operation, compiled.message)
            const draft = compiled
            const admission = { interactive: true, json: false, ci: false, stdinIsTTY: true, stdoutIsTTY: true } as const
            const started = operation === 'work-renew' ? prepared.previous && prepared.decision ? beginWorkOrderRenewal(prepared.previous, draft, admission, Date.now(), prepared.decision) : undefined : beginWorkOrderAcceptance(draft, admission, Date.now())
            if (!started) return refusal(operation, 'Renewal requires a current accepted contract and decision')
            if (started.kind === 'refusal') return refusal(operation, started.message)
            const stableDraft = draft
            const decide = async (answer: string): Promise<WorkApplicationOutcome> => {
                const accepted = acceptWorkOrder(started.continuation, stableDraft, { admission, now: Date.now(), actor: composition.operator, answer })
                if (accepted.kind === 'refusal') return refusal(operation, accepted.message)
                try { await composition.persistAcceptance(prepared, accepted); return complete(operation, { id: captured.workOrderId, digest: accepted.binding.digest }) }
                catch (error) { return refusal(operation, error instanceof Error ? error.message : String(error)) }
            }
            return Object.freeze({ kind: 'human-needed', operation, continuation: Object.freeze({ digest: started.digest, prompt: started.prompt, decide }) })
        }
        if (operation === 'work-execute') { const prepared = await composition.execution(captured.workOrderId, captured.approach); const result = await executeWorkOrderStep(prepared.input, prepared.dependencies); return result.kind === 'complete' ? complete(operation, result) : refusal(operation, result.reason) }
        if (operation === 'work-record') { const prepared = await composition.record(captured.workOrderId, captured.eventFile); const result = await persistWorkOrderProgress(prepared.contract, composition.policy,
            prepared.stateBytes, prepared.event, prepared.writer, prepared.store); return result.kind === 'complete' ? complete(operation, result) : refusal(operation, result.message) }
        if (operation === 'work-sweep') {
            const prepared = await composition.sweep(captured.apply)
            for (const row of prepared.sizes) { const size = assessWorkOrderSize(row.contract, row.path); if (size.kind === 'refusal') return refusal(operation, size.message) }
            const result = await applyWorkOrderSweep(planWorkOrderSweep(prepared.capacity, prepared.observations, prepared.context), prepared.writer)
            return result.kind === 'refusal' ? refusal(operation, result.message) : complete(operation, result)
        }
        if (operation === 'work-reverse') { const prepared = await composition.reversal(captured.workOrderId); const result = reverseWorkOrderSweep(prepared.contract, prepared.current, prepared.expected, prepared.context); if (result.kind === 'refusal') return refusal(operation, result.message); await prepared.persist(result); return complete(operation, result) }
        if (operation === 'work-programme-mint') { const selected = await composition.programme(captured.programmeId, captured.itemKey); const pressure = assessWorkPressure(selected.capacity, captured.programmeId); if (pressure.kind === 'refusal') return refusal(operation, pressure.message)
            if (!captured.candidate) return complete(operation, { programmeId: captured.programmeId, itemKey: selected.itemKey, candidateRequired: true })
            const prepared = await selected.candidate(captured.candidate); const result = mintProgrammeWorkOrder({ ...prepared.input, pressure }); if (result.kind === 'refusal') return refusal(operation, result.message); if (result.kind === 'mint') await prepared.persist(result); return complete(operation, result) }
        if (operation === 'work-metrics') { const metrics = collectWorkOrderMetrics(await composition.metrics()); return metrics.kind === 'refusal' ? refusal(operation, metrics.message) : complete(operation, { metrics, text: renderWorkOrderMetrics(metrics) }) }
        if (operation.startsWith('browser-')) { const browserRequest = captured as Extract<WorkApplicationRequest, { operation: `browser-${string}` }>; const kind = operation === 'browser-accessibility' ? 'accessibility' : operation === 'browser-screenshot' ? 'screenshot' : 'drive'; const result = await executeBrowserCommand(await composition.browser(kind, operation === 'browser-debugger', browserRequest.role)); if (result.kind === 'refusal') return refusal(operation, result.reason); if (result.kind === 'complete') { const gate = evaluateUiGate({ activating: kind, receipts: [result.receipt] }); if (gate.kind === 'refusal') return refusal(operation, gate.reason) } return complete(operation, result) }
        if (operation === 'test-run') { const prepared = await composition.gate(captured); const run = await runGate(prepared.registry, prepared.request, prepared.dependencies); return run.satisfiesGate
            ? complete(operation, run)
            : refusal(operation, `${run.verdict}: ${run.reasons.join('; ') || 'declared gate was not satisfied'}`) }
        if (operation === 'work-review') { const prepared = await composition.review(captured.workOrderId); const result = await reviewWorkOrderWave(prepared.input, prepared.dependencies)
            return result.kind === 'complete' ? complete(operation, result) : refusal(operation, result.reason) }
        if (operation === 'work-grade') { const prepared = await composition.grading(captured.workOrderId); const result = await completeWorkOrder(prepared.input, prepared.dependencies); return result.completed ? complete(operation, result) : refusal(operation, result.reason) }
        return refusal(operation, 'Unsupported work application operation')
    } catch (error) { return refusal(operation, error instanceof Error ? error.message : String(error)) }
}
