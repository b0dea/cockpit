import { createHash } from 'node:crypto'
import { executeBrowserCommand, ownDataRecord } from '../browser/commands.js'
import { evaluateUiGate } from '../browser/ui-gate.js'
import { completeWorkOrder } from '../grading/completion.js'
import { runGate } from '../testing/gates.js'
import { executeWorkOrderStep } from './executor.js'
import { WORK_ORDER_ID, WORK_ORDER_LOCKS, type ParsedWorkOrder, type WorkOrderDecision } from './contract.js'
import { acceptWorkOrder, beginWorkOrderAcceptance, beginWorkOrderRenewal, intakeWorkOrder, routeWorkOrder } from './intake.js'
import { collectWorkOrderMetrics, renderWorkOrderMetrics } from './metrics.js'
import { assessWorkOrderSize, assessWorkPressure, applyWorkOrderSweep, planWorkOrderSweep, reverseWorkOrderSweep } from './pressure.js'
import { mintProgrammeWorkOrder } from './programme.js'
import { reviewWorkOrderWave } from './review.js'
import { resumeWorkOrder } from './resume.js'
import { persistWorkOrderProgress } from './state.js'
import { projectWorkOrderStatus } from './status.js'
import { isWorkApplicationComposition, type PreparedAnswer, type WorkApplicationComposition } from './composition.js'
import { errorCause } from '../environment/contract.js'

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
    | Readonly<{ operation: 'work-record' | 'work-answer'; workOrderId: string; eventFile: string }>
    | Readonly<{ operation: 'work-sweep'; apply: boolean }>
    | Readonly<{ operation: 'work-reverse'; workOrderId: string }>
    | Readonly<{ operation: 'work-programme-mint'; programmeId: string; itemKey?: string; candidate?: string }>
    | Readonly<{ operation: 'browser-drive' | 'browser-accessibility' | 'browser-screenshot' | 'browser-debugger'; role?: string }>
    | Readonly<{ operation: 'test-run'; gate: string; mode: 'canonical' | 'full' | 'staged'; select?: Readonly<{ kind: 'spec' | 'file' | 'test' | 'route'; value: string }> }>

export interface WorkApplicationContinuation { readonly digest: string; readonly prompt: string; readonly decide: (answer: string) => Promise<WorkApplicationOutcome> }
export type WorkApplicationOutcome =
    | Readonly<{ kind: 'complete'; operation: WorkApplicationRequest['operation']; value: unknown }>
    | Readonly<{ kind: 'human-needed'; operation: 'work-accept' | 'work-renew' | 'work-answer'; continuation: WorkApplicationContinuation }>
    | Readonly<{ kind: 'refusal'; operation: WorkApplicationRequest['operation'] | 'invalid'; reason: string }>
    // The operation ran and produced a result that does not meet its bar (a gate short of PASS, a grade
    // with an unmet criterion, a step whose verification failed); the result is the evidence to act on.
    | Readonly<{ kind: 'unsatisfied'; operation: 'test-run' | 'work-grade' | 'work-execute'; value: unknown; reason: string }>

interface OperationShape { readonly required: readonly string[]; readonly optional?: readonly string[] }
const operationKeys: Readonly<Record<WorkApplicationRequest['operation'], OperationShape>> = Object.freeze({
    'work-intake': { required: ['operation'], optional: ['workOrderId', 'intent', 'candidate'] }, 'work-accept': { required: ['operation', 'workOrderId'] },
    'work-renew': { required: ['operation', 'workOrderId'] }, 'work-status': { required: ['operation'], optional: ['workOrderId'] },
    'work-resume': { required: ['operation'] }, 'work-recover': { required: ['operation', 'lockId', 'apply'] }, 'work-execute': { required: ['operation', 'workOrderId', 'approach'] },
    'work-record': { required: ['operation', 'workOrderId', 'eventFile'] }, 'work-answer': { required: ['operation', 'workOrderId', 'eventFile'] },
    'work-sweep': { required: ['operation', 'apply'] }, 'work-reverse': { required: ['operation', 'workOrderId'] },
    'work-programme-mint': { required: ['operation', 'programmeId'], optional: ['itemKey', 'candidate'] }, 'work-metrics': { required: ['operation'] },
    'work-grade': { required: ['operation', 'workOrderId'] }, 'work-review': { required: ['operation', 'workOrderId'] }, 'browser-drive': { required: ['operation'], optional: ['role'] },
    'browser-accessibility': { required: ['operation'], optional: ['role'] }, 'browser-screenshot': { required: ['operation'], optional: ['role'] },
    'browser-debugger': { required: ['operation'], optional: ['role'] }, 'test-run': { required: ['operation', 'gate', 'mode'], optional: ['select'] },
})
const requestKeys = [...new Set(Object.values(operationKeys).flatMap(shape => [...shape.required, ...(shape.optional ?? [])]))]
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
    const row = ownDataRecord(value, [], requestKeys)
    if (!row || typeof row.operation !== 'string' || !Object.hasOwn(operationKeys, row.operation)) return undefined
    const operation = row.operation as WorkApplicationRequest['operation']; const shape = operationKeys[operation]
    const allowed = [...shape.required, ...(shape.optional ?? [])]; const keys = Object.keys(row)
    if (keys.some(key => !allowed.includes(key)) || shape.required.some(key => !Object.hasOwn(row, key))) return undefined
    const requiresWorkOrderId = shape.required.includes('workOrderId')
    if (requiresWorkOrderId && !bounded(row.workOrderId, WORK_ORDER_ID, 128)
        || !requiresWorkOrderId && row.workOrderId !== undefined
            && !bounded(row.workOrderId, WORK_ORDER_ID, 128)) return undefined
    if ('approach' in row && !bounded(row.approach, /^.+$/, 4_096)) return undefined
    if ('programmeId' in row && !bounded(row.programmeId, /^[a-z][a-z0-9-]{0,63}$/, 64)) return undefined
    if ('itemKey' in row && row.itemKey !== undefined && !bounded(row.itemKey, /^[a-z][a-z0-9-]{0,63}$/, 64)) return undefined
    if ('eventFile' in row && !relativeSelector(row.eventFile)) return undefined
    if ('lockId' in row && row.lockId !== WORK_ORDER_LOCKS.capacity && row.lockId !== WORK_ORDER_LOCKS.identity
        && !bounded(row.lockId, WORK_ORDER_ID, 128)) return undefined
    if ('intent' in row && !relativeSelector(row.intent) || 'candidate' in row && row.candidate !== undefined && !relativeSelector(row.candidate)) return undefined
    if (operation === 'work-intake' && (typeof row.workOrderId === 'string') === (typeof row.intent === 'string')
        || operation === 'work-intake' && row.candidate !== undefined && typeof row.intent !== 'string') return undefined
    if ('apply' in row && typeof row.apply !== 'boolean') return undefined
    if ('gate' in row && !bounded(row.gate, /^[a-z][a-z0-9-]{0,63}$/, 64)) return undefined
    if ('role' in row && row.role !== undefined && !bounded(row.role, /^[a-z0-9][a-z0-9_-]{0,63}$/, 64)) return undefined
    if ('mode' in row && !['canonical', 'full', 'staged'].includes(row.mode as string)) return undefined
    if ('select' in row && row.select !== undefined) {
        const select = ownDataRecord(row.select, ['kind', 'value'], [])
        if (!select || !['spec', 'file', 'test', 'route'].includes(select.kind as string) || !bounded(select.value, /^.+$/, 4_096)) return undefined
        row.select = Object.freeze({ kind: select.kind, value: select.value })
    }
    return Object.freeze(row) as unknown as WorkApplicationRequest
}
const refusal = (operation: WorkApplicationOutcome['operation'], reason: string): WorkApplicationOutcome => Object.freeze({ kind: 'refusal', operation, reason })
const complete = (operation: WorkApplicationRequest['operation'], value: unknown): WorkApplicationOutcome => Object.freeze({ kind: 'complete', operation, value })
const unsatisfied = (operation: 'test-run' | 'work-grade' | 'work-execute', value: unknown, reason: string): WorkApplicationOutcome =>
    Object.freeze({ kind: 'unsatisfied', operation, value, reason })

// The prompt shows a person what they are answering; agent-written text is printed with its control
// and bidirectional-override characters replaced so it can neither drive the person's terminal nor
// display in an order other than the one recorded.
const shown = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '\uFFFD')
function answerPrompt(workOrderId: string, prepared: PreparedAnswer, digest: string): string {
    const event = prepared.event
    const lines = event.kind === 'resolve-gap' && prepared.question
        ? [`Open question ${shown(prepared.question.id)} on step ${prepared.question.step} of ${workOrderId}:`, `  ${shown(prepared.question.question)}`, 'Answer to record:', `  ${shown(event.answer)}`]
        : event.kind === 'decision'
            ? [`Decision to record on ${workOrderId}:`, ...(['date', 'decision', 'disposition', 'reason', 'impact'] as const).map(field => `  ${field}: ${shown(String(event.decision[field]))}`)]
            : []
    return [...lines, `This is recorded as ${shown(prepared.writer.actor)}'s answer. To record it, type answer ${digest}`].join('\n')
}
// The digest alone would let an agent edit the order after the person read it in an editor and have the
// edited digest accepted, so the prompt shows the contract the digest binds.
function acceptancePrompt(contract: ParsedWorkOrder, decision: WorkOrderDecision | undefined): string {
    return [
        `${decision ? 'Renew' : 'Accept'} ${shown(contract.frontmatter.id)}: ${shown(contract.frontmatter.title)}`,
        'Authority:', ...contract.authority.map(path => `  - ${shown(path)}`),
        'Sources:', ...contract.sources.map(source => `  ${shown(source.id)} (${source.provenance}) ${shown(source.reference)}: ${shown(source.reason)}`),
        'Acceptance criteria:', ...contract.criteria.flatMap(criterion => [`  ${shown(criterion.id)} (source ${shown(criterion.source)})`,
            `    Given: ${shown(criterion.given)}`, `    When: ${shown(criterion.when)}`, `    Then: ${shown(criterion.then)}`]),
        'Verification:', ...contract.verification.map(row => `  ${shown(row.criterion)}: ${shown(JSON.stringify(row.argv))}`),
        ...decision ? ['Decision this renewal confirms:', ...(['date', 'decision', 'disposition', 'reason', 'impact'] as const).map(field => `  ${field}: ${shown(decision[field])}`)] : [],
        `To accept exactly this contract, type accept ${contract.digest}`,
    ].join('\n')
}

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
            const decision = operation === 'work-renew' ? prepared.decision : undefined
            const started = operation === 'work-renew' ? prepared.previous && decision ? beginWorkOrderRenewal(prepared.previous, draft, Date.now(), decision) : undefined : beginWorkOrderAcceptance(draft, Date.now())
            if (!started) return refusal(operation, 'Renewal requires a current accepted contract and decision')
            if (started.kind === 'refusal') return refusal(operation, started.message)
            const decide = async (answer: string): Promise<WorkApplicationOutcome> => {
                const accepted = acceptWorkOrder(started.continuation, draft, { now: Date.now(), actor: composition.operator, answer })
                if (accepted.kind === 'refusal') return refusal(operation, accepted.message)
                try { await composition.persistAcceptance(prepared, accepted); return complete(operation, { id: captured.workOrderId, digest: accepted.binding.digest }) }
                catch (error) { return refusal(operation, errorCause(error)) }
            }
            return Object.freeze({ kind: 'human-needed', operation, continuation: Object.freeze({ digest: started.digest, prompt: acceptancePrompt(draft.contract, decision), decide }) })
        }
        if (operation === 'work-execute') {
            const prepared = await composition.execution(captured.workOrderId, captured.approach); const result = await executeWorkOrderStep(prepared.input, prepared.dependencies)
            return result.kind === 'complete' ? complete(operation, result) : result.kind === 'paused' ? unsatisfied(operation, result, result.reason) : refusal(operation, result.reason)
        }
        if (operation === 'work-record') { const prepared = await composition.record(captured.workOrderId, captured.eventFile); const result = await persistWorkOrderProgress(prepared.contract, composition.policy,
            prepared.stateBytes, prepared.event, prepared.writer, prepared.store); return result.kind === 'complete' ? complete(operation, result) : refusal(operation, result.message) }
        if (operation === 'work-answer') {
            const prepared = await composition.answer(captured.workOrderId, captured.eventFile)
            const bound = JSON.stringify({ workOrder: captured.workOrderId, contract: prepared.contract.digest, state: createHash('sha256').update(prepared.stateBytes).digest('hex'), event: prepared.event })
            const digest = createHash('sha256').update(bound).digest('hex')
            let consumed = false
            const decide = async (answer: string): Promise<WorkApplicationOutcome> => {
                if (consumed) return refusal(operation, 'This answer prompt was already used; rerun work answer')
                consumed = true
                if (answer.trim() !== `answer ${digest}`) return refusal(operation, `Nothing was recorded: the person did not type answer ${digest}`)
                const result = await persistWorkOrderProgress(prepared.contract, composition.policy, prepared.stateBytes, prepared.event,
                    { actor: prepared.writer.actor, at: new Date().toISOString() }, prepared.store)
                return result.kind === 'complete' ? complete(operation, result) : refusal(operation, result.message)
            }
            return Object.freeze({ kind: 'human-needed', operation, continuation: Object.freeze({ digest, prompt: answerPrompt(captured.workOrderId, prepared, digest), decide }) })
        }
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
            : unsatisfied(operation, run, `${run.verdict}: ${run.reasons.join('; ') || 'declared gate was not satisfied'}`) }
        if (operation === 'work-review') { const prepared = await composition.review(captured.workOrderId); const result = await reviewWorkOrderWave(prepared.input, prepared.dependencies)
            return result.kind === 'complete' ? complete(operation, result) : refusal(operation, result.reason) }
        if (operation === 'work-grade') {
            const prepared = await composition.grading(captured.workOrderId); const result = await completeWorkOrder(prepared.input, prepared.dependencies)
            if (result.completed) return complete(operation, result)
            if (!result.unmet || !result.grade) return refusal(operation, result.reason)
            const grade = result.grade
            return unsatisfied(operation, { workOrderId: grade.workOrderId, runId: grade.runId,
                criteria: grade.criteria.map(({ criterion, outcome, reasons }) => ({ criterion, outcome, reasons })),
                verification: grade.verification.map(({ criterion, argv, result: observed }) => ({ criterion, argv,
                    ...(observed.kind === 'executed' ? { exitCode: observed.exitCode } : { unavailable: observed.reason }) })) }, result.reason)
        }
        return refusal(operation, 'Unsupported work application operation')
    } catch (error) { return refusal(operation, errorCause(error)) }
}
