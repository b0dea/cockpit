import { isValidatedWorkOrderPolicy, type ValidatedWorkOrderPolicy } from './intake.js'
import { z } from 'zod'
import { isParsedWorkOrder, WORK_ORDER_LIMITS, type ParsedWorkOrder } from './contract.js'

export const mechanism = {
    id: 'work-order-state',
    module: 'packages/cockpit/src/work-orders/state.ts',
    exports: ['WORK_ORDER_STATE_LIMITS', 'createWorkOrderState', 'encodeWorkOrderState', 'parseWorkOrderSourceEvidenceReference', 'persistWorkOrderProgress', 'readWorkOrderState', 'validateWorkOrderRepositories', 'workOrderProofIsCurrent'],
} as const

// Execution state is a bounded snapshot, not an ever-growing transcript.
export const WORK_ORDER_STATE_LIMITS = Object.freeze({ bytes: 262_144, repositories: 64, records: 64, repeatedFailures: 2 })
const text = z.string().min(1).max(4_096).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value))
const timestamp = z.string().refine((value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
})
const Writer = z.object({ actor: text.max(256), at: timestamp }).strict()
const path = z.string().max(4_096).regex(/^[A-Za-z0-9._/-]+$/).refine((value) => value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
const Repository = z.object({ path, revision: z.string().regex(/^(?=[a-f0-9]*[1-9a-f])(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    worktreeDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const Repositories = z.array(Repository).min(1).max(WORK_ORDER_STATE_LIMITS.repositories)
const Command = z.array(text).min(1).max(WORK_ORDER_LIMITS.arguments).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= WORK_ORDER_LIMITS.commandBytes)
const Layer = z.enum(['source', 'local', 'ci', 'runtime', 'deployment'])
const Binding = z.object({ layer: Layer, reference: text, contractDigest: z.string().regex(/^[a-f0-9]{64}$/), repositories: Repositories }).strict()
const Proof = Binding.extend({ layer: z.enum(['local', 'ci', 'runtime', 'deployment']), command: Command }).strict()
const WrittenDetail = z.object({ detail: text, writer: Writer }).strict()
const stepNumber = z.number().int().min(1).max(WORK_ORDER_LIMITS.planSteps)
const Step = z.object({ number: stepNumber, text, command: Command, requires: z.array(stepNumber).max(WORK_ORDER_LIMITS.planSteps), checked: Proof.extend({ writer: Writer }).strict().optional() }).strict()
const Decision = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), decision: text, disposition: z.enum(['accepted', 'rejected', 'deferred']), reason: text, impact: text }).strict()
const Attempt = z.object({
    step: stepNumber, approach: text, count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    lastOutcome: z.enum(['failed', 'passed']), failures: z.number().int().min(0).max(WORK_ORDER_STATE_LIMITS.repeatedFailures),
    writer: Writer, rootCause: WrittenDetail.optional(),
}).strict().refine((attempt) => attempt.count >= attempt.failures && (attempt.lastOutcome === 'passed' ? attempt.failures === 0 : attempt.failures > 0))
const Gap = z.object({ id: text.max(256), step: stepNumber, question: text, writer: Writer, answer: WrittenDetail.optional() }).strict()
const Reservation = z.object({ step: stepNumber, approach: text, writer: Writer }).strict()
const State = z.object({
    format: z.literal('cockpit-work-order-state/v1'), id: z.string(), contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), heartbeat: Writer, repositories: Repositories,
    steps: z.array(Step).min(1).max(WORK_ORDER_LIMITS.planSteps),
    attempts: z.array(Attempt).max(WORK_ORDER_STATE_LIMITS.records), gaps: z.array(Gap).max(WORK_ORDER_STATE_LIMITS.records),
    evidence: z.array(Binding.extend({ writer: Writer }).strict()).max(WORK_ORDER_STATE_LIMITS.records),
    decisions: z.array(z.object({ decision: Decision, writer: Writer }).strict()).max(WORK_ORDER_LIMITS.decisions),
    reservation: Reservation.optional(),
    reconciliations: z.array(z.object({ reservation: Reservation, reason: text, writer: Writer }).strict()).max(WORK_ORDER_STATE_LIMITS.records),
}).strict()

export type WorkOrderWriter = z.infer<typeof Writer>
export type WorkOrderRepository = z.infer<typeof Repository>
export type WorkOrderExecutionState = z.infer<typeof State>
export type WorkOrderStateCode = 'WO_POLICY_INVALID' | 'WO_CONTRACT_INVALID' | 'WO_STATE_INVALID' | 'WO_STATE_CONTRADICTION' | 'WO_STATE_PERSIST_FAILED' | 'WO_STATE_CONFLICT' | 'WO_ROOT_CAUSE_REQUIRED'
export interface WorkOrderStateRefusal { readonly kind: 'refusal'; readonly code: WorkOrderStateCode; readonly message: string }
export type WorkOrderStateResult = Readonly<{ kind: 'complete'; value: WorkOrderExecutionState }> | WorkOrderStateRefusal

export interface WorkOrderStateStore {
    readonly read: () => Promise<Uint8Array>
    // The adapter must atomically compare exact bytes and durably publish before resolving true.
    readonly compareAndSwap: (expected: Uint8Array, next: Uint8Array) => Promise<boolean>
}

const Event = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('heartbeat') }).strict(),
    z.object({ kind: z.literal('check'), step: stepNumber, proof: Proof }).strict(),
    z.object({ kind: z.literal('attempt'), step: stepNumber, approach: text, outcome: z.enum(['failed', 'passed']) }).strict(),
    z.object({ kind: z.literal('settle-execution'), step: stepNumber, approach: text, proof: Proof }).strict(),
    z.object({ kind: z.literal('reserve-execution'), step: stepNumber, approach: text }).strict(),
    z.object({ kind: z.literal('reconcile-execution'), step: stepNumber, approach: text, reason: text }).strict(),
    z.object({ kind: z.literal('root-cause'), step: stepNumber, approach: text, detail: text }).strict(),
    z.object({ kind: z.literal('gap'), id: text.max(256), step: stepNumber, question: text }).strict(),
    z.object({ kind: z.literal('resolve-gap'), id: text.max(256), answer: text }).strict(),
    Binding.extend({ kind: z.literal('evidence') }).strict(),
    z.object({ kind: z.literal('decision'), decision: Decision }).strict(),
])
export type WorkOrderProgressEvent = z.infer<typeof Event>

function refuse(code: WorkOrderStateCode, message: string): WorkOrderStateRefusal { return Object.freeze({ kind: 'refusal', code, message }) }
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
    }
    return value
}
function sameCommand(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}
function samePaths(left: readonly WorkOrderRepository[], right: readonly WorkOrderRepository[]): boolean {
    return left.length === right.length && left.every((repository) => right.some((entry) => entry.path === repository.path))
}
export function parseWorkOrderSourceEvidenceReference(reference: unknown): Readonly<{ path: string; sha256: string }> | undefined {
    if (typeof reference !== 'string') return undefined
    const match = /^(.*)#sha256=([a-f0-9]{64})$/.exec(reference)
    if (!match || !path.safeParse(match[1]).success) return undefined
    return Object.freeze({ path: match[1]!, sha256: match[2]! })
}
export function workOrderProofIsCurrent(proof: { readonly contractDigest: string; readonly repositories: readonly WorkOrderRepository[] }, contract: ParsedWorkOrder, repositories: readonly WorkOrderRepository[]): boolean {
    return proof.contractDigest === contract.digest && samePaths(proof.repositories, repositories)
        && proof.repositories.every((repository) => repositories.some((entry) => entry.path === repository.path
            && entry.revision === repository.revision && entry.worktreeDigest === repository.worktreeDigest))
}
export function validateWorkOrderRepositories(input: unknown): readonly WorkOrderRepository[] | undefined {
    const parsed = Repositories.safeParse(input)
    if (!parsed.success || new Set(parsed.data.map((entry) => entry.path)).size !== parsed.data.length) return undefined
    return freeze(parsed.data)
}

function validateState(contract: ParsedWorkOrder, input: unknown): WorkOrderStateResult {
    if (!isParsedWorkOrder(contract)) return refuse('WO_CONTRACT_INVALID', 'Execution requires a contract issued by the canonical parser')
    const parsed = State.safeParse(input)
    if (!parsed.success) return refuse('WO_STATE_INVALID', `Invalid execution state: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    const state = parsed.data
    if (Buffer.byteLength(JSON.stringify(state)) > WORK_ORDER_STATE_LIMITS.bytes) return refuse('WO_STATE_INVALID', `Execution state exceeds ${WORK_ORDER_STATE_LIMITS.bytes} bytes`)
    if (state.id !== contract.frontmatter.id || state.contractDigest !== contract.digest) return refuse('WO_STATE_CONTRADICTION', 'Execution state belongs to another contract revision')
    if (!validateWorkOrderRepositories(state.repositories) || state.steps.length !== contract.plan.length) return refuse('WO_STATE_CONTRADICTION', 'Execution repositories or Plan length contradict the contract')
    const unique = (values: readonly string[]) => new Set(values).size === values.length
    if (!unique(state.gaps.map((gap) => gap.id)) || !unique(state.attempts.map((attempt) => JSON.stringify([attempt.step, attempt.approach])))
        || !unique(state.decisions.map((entry) => entry.decision.decision))) return refuse('WO_STATE_CONTRADICTION', 'Execution records have duplicate identities')
    for (const [index, step] of state.steps.entries()) {
        if (step.number !== index + 1 || step.text !== contract.plan[index].text
            || !contract.verification.some((command) => sameCommand(command.argv, step.command))
            || new Set(step.requires).size !== step.requires.length || step.requires.some((dependency) => dependency >= step.number)
            || contract.plan[index].checked && !step.checked) return refuse('WO_STATE_CONTRADICTION', `Plan step ${index + 1} contradicts the parsed contract or its dependencies`)
        if (step.checked && (!sameCommand(step.checked.command, step.command) || step.requires.some((dependency) => !state.steps[dependency - 1].checked))) return refuse('WO_STATE_CONTRADICTION', `Checked step ${step.number} lacks its declared command or prerequisite proof`)
        if (step.checked && (state.gaps.some((gap) => gap.step === step.number && !gap.answer)
            || state.attempts.some((attempt) => attempt.step === step.number && attempt.failures >= WORK_ORDER_STATE_LIMITS.repeatedFailures && !attempt.rootCause))) return refuse('WO_STATE_CONTRADICTION', `Checked step ${step.number} still has an unresolved blocker`)
    }
    const written = [state.heartbeat, ...state.steps.flatMap((step) => step.checked ? [step.checked.writer] : []),
        ...state.attempts.flatMap((attempt) => [attempt.writer, ...(attempt.rootCause ? [attempt.rootCause.writer] : [])]),
        ...state.gaps.flatMap((gap) => [gap.writer, ...(gap.answer ? [gap.answer.writer] : [])]),
        ...state.evidence.map((entry) => entry.writer), ...state.decisions.map((entry) => entry.writer),
        ...(state.reservation ? [state.reservation.writer] : []), ...state.reconciliations.flatMap((entry) => [entry.reservation.writer, entry.writer])]
    if (written.some((writer) => writer.at > state.heartbeat.at || writer.at.slice(0, 10) < contract.frontmatter.created)) return refuse('WO_STATE_CONTRADICTION', 'Record writers fall outside the durable heartbeat boundary')
    if ([...state.attempts, ...state.gaps].some((entry) => entry.step > state.steps.length)
        || state.reservation && state.reservation.step > state.steps.length
        || state.reconciliations.some((entry) => entry.reservation.step > state.steps.length || entry.writer.at < entry.reservation.writer.at)
        || state.gaps.some((gap) => gap.answer && gap.answer.writer.at < gap.writer.at)) return refuse('WO_STATE_CONTRADICTION', 'Execution records reference an unknown step or contradictory chronology')
    const bindings = [...state.evidence, ...state.steps.flatMap((step) => step.checked ? [step.checked] : [])]
    if (bindings.some((entry) => entry.contractDigest !== contract.digest || !validateWorkOrderRepositories(entry.repositories) || !samePaths(entry.repositories, state.repositories))) return refuse('WO_STATE_CONTRADICTION', 'Evidence binds another contract or an incomplete repository boundary')
    if (state.decisions.some(({ decision, writer }) => {
        const time = Date.parse(decision.date)
        return !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== decision.date || decision.date < contract.frontmatter.created || decision.date > writer.at.slice(0, 10)
    })) return refuse('WO_STATE_INVALID', 'Decision dates must be real dates within their writer boundary')
    return freeze({ kind: 'complete', value: state })
}

export function readWorkOrderState(contract: ParsedWorkOrder, input: Uint8Array): WorkOrderStateResult {
    if (!(input instanceof Uint8Array) || input.byteLength > WORK_ORDER_STATE_LIMITS.bytes) return refuse('WO_STATE_INVALID', `Execution state must be bytes within ${WORK_ORDER_STATE_LIMITS.bytes} bytes`)
    let value: unknown
    try {
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
        value = JSON.parse(source)
        // Requiring the codec's compact JSON prevents duplicate keys being erased by JSON.parse.
        if (JSON.stringify(value) !== source) return refuse('WO_STATE_INVALID', 'Execution state requires compact JSON without duplicate keys or alternate encodings; use the state codec')
    } catch (error) {
        // The decoder's message quotes the bytes where it stopped; name the failure, not the content.
        return refuse('WO_STATE_INVALID', `Execution state is not ${error instanceof SyntaxError ? 'valid JSON' : 'valid UTF-8'}; expected the compact object the state codec writes`)
    }
    return validateState(contract, value)
}

export function encodeWorkOrderState(contract: ParsedWorkOrder, input: WorkOrderExecutionState): Uint8Array {
    const parsed = validateState(contract, input)
    if (parsed.kind === 'refusal') throw new Error(`[${parsed.code}] ${parsed.message}`)
    return Buffer.from(JSON.stringify(parsed.value))
}

export function createWorkOrderState(contract: ParsedWorkOrder, input: {
    readonly writer: WorkOrderWriter; readonly repositories: readonly WorkOrderRepository[]
    readonly steps: readonly { readonly command: readonly string[]; readonly requires: readonly number[] }[]
}): WorkOrderStateResult {
    if (!isParsedWorkOrder(contract)) return refuse('WO_CONTRACT_INVALID', 'Execution requires a contract issued by the canonical parser')
    return validateState(contract, {
        format: 'cockpit-work-order-state/v1', id: contract.frontmatter.id, contractDigest: contract.digest,
        revision: 0, heartbeat: input.writer, repositories: input.repositories,
        steps: input.steps.map((step, index) => ({ number: index + 1, text: contract.plan[index]?.text, command: step.command, requires: step.requires })),
        attempts: [], gaps: [], evidence: [], decisions: [], reconciliations: [],
    })
}

export async function persistWorkOrderProgress(contract: ParsedWorkOrder, policy: ValidatedWorkOrderPolicy, input: Uint8Array, eventInput: unknown, writerInput: WorkOrderWriter, store: WorkOrderStateStore): Promise<WorkOrderStateResult> {
    if (!isValidatedWorkOrderPolicy(policy)) return refuse('WO_POLICY_INVALID', 'Progress requires an issued work-order policy')
    const expected = Buffer.from(input)
    const loaded = readWorkOrderState(contract, expected)
    if (loaded.kind === 'refusal') return loaded
    const eventResult = Event.safeParse(eventInput)
    const writerResult = Writer.safeParse(writerInput)
    if (!eventResult.success || !writerResult.success || writerResult.data.at < loaded.value.heartbeat.at) return refuse('WO_STATE_INVALID', 'Progress requires a valid event and a named, non-regressing writer')
    const event = eventResult.data
    if (contract.frontmatter.status !== 'active' && (contract.frontmatter.status !== 'blocked' || ['check', 'attempt', 'reserve-execution', 'settle-execution'].includes(event.kind))) return refuse('WO_STATE_CONTRADICTION', 'Execution requires active status; blocked work may only record evidence, decisions, heartbeat, reconciliation and answers')
    const writer = writerResult.data
    const state = structuredClone(loaded.value)
    const step = 'step' in event ? state.steps[event.step - 1] : undefined
    if ('step' in event && !step) return refuse('WO_STATE_INVALID', `Unknown Plan step ${event.step}`)
    if (event.kind === 'gap' || event.kind === 'attempt' && event.outcome === 'failed') {
        const invalid = new Set([event.step])
        for (const candidate of state.steps) {
            if (invalid.has(candidate.number) || candidate.requires.some((dependency) => invalid.has(dependency))) {
                invalid.add(candidate.number)
                delete candidate.checked
            }
        }
    }
    switch (event.kind) {
        case 'heartbeat': break
        case 'check': {
            if (!step || state.reservation || !sameCommand(step.command, event.proof.command) || event.proof.contractDigest !== contract.digest
                || step.requires.some((dependency) => !state.steps[dependency - 1].checked || !workOrderProofIsCurrent(state.steps[dependency - 1].checked!, contract, event.proof.repositories))
                || state.gaps.some((gap) => gap.step === event.step && !gap.answer)
                || state.attempts.some((attempt) => attempt.step === event.step && attempt.failures >= policy.attemptCap && !attempt.rootCause)) return refuse('WO_STATE_CONTRADICTION', 'Checking a step requires its declared proof, current prerequisites and resolved blockers')
            step.checked = { ...event.proof, writer }
            break
        }
        case 'attempt': {
            if (state.reservation && (state.reservation.step !== event.step || state.reservation.approach !== event.approach)) {
                return refuse('WO_STATE_CONTRADICTION', 'Attempt does not match the durable execution reservation')
            }
            let attempt = state.attempts.find((entry) => entry.step === event.step && entry.approach === event.approach)
            if (attempt && attempt.failures >= policy.attemptCap) return refuse('WO_ROOT_CAUSE_REQUIRED', 'Repeated failure requires root-cause analysis and a different approach or human input')
            if (!attempt) { attempt = { step: event.step, approach: event.approach, count: 0, lastOutcome: event.outcome, failures: 0, writer }; state.attempts.push(attempt) }
            attempt.count += 1
            attempt.lastOutcome = event.outcome
            attempt.failures = event.outcome === 'failed' ? attempt.failures + 1 : 0
            attempt.writer = writer
            delete state.reservation
            break
        }
        case 'settle-execution': {
            if (!step || !state.reservation || state.reservation.step !== event.step || state.reservation.approach !== event.approach
                || !sameCommand(step.command, event.proof.command) || event.proof.contractDigest !== contract.digest
                || step.requires.some((dependency) => !state.steps[dependency - 1].checked || !workOrderProofIsCurrent(state.steps[dependency - 1].checked!, contract, event.proof.repositories))
                || state.gaps.some((gap) => gap.step === event.step && !gap.answer)) {
                return refuse('WO_STATE_CONTRADICTION', 'Successful execution settlement requires its exact reservation, declared proof, current prerequisites and resolved blockers')
            }
            let attempt = state.attempts.find((entry) => entry.step === event.step && entry.approach === event.approach)
            if (attempt && attempt.failures >= policy.attemptCap) return refuse('WO_ROOT_CAUSE_REQUIRED', 'Repeated failure requires root-cause analysis and a different approach or human input')
            if (!attempt) { attempt = { step: event.step, approach: event.approach, count: 0, lastOutcome: 'passed', failures: 0, writer }; state.attempts.push(attempt) }
            attempt.count += 1
            attempt.lastOutcome = 'passed'
            attempt.failures = 0
            attempt.writer = writer
            step.checked = { ...event.proof, writer }
            delete state.reservation
            break
        }
        case 'reserve-execution': {
            if (state.reservation) return refuse('WO_STATE_CONTRADICTION', 'Interrupted execution requires explicit reconciliation before another dispatch')
            state.reservation = { step: event.step, approach: event.approach, writer }
            break
        }
        case 'reconcile-execution': {
            if (!state.reservation || state.reservation.step !== event.step || state.reservation.approach !== event.approach) {
                return refuse('WO_STATE_CONTRADICTION', 'Reconciliation requires the exact outstanding execution reservation')
            }
            state.reconciliations.push({ reservation: state.reservation, reason: event.reason, writer })
            delete state.reservation
            break
        }
        case 'root-cause': {
            const attempt = state.attempts.find((entry) => entry.step === event.step && entry.approach === event.approach)
            if (!attempt || attempt.failures === 0) return refuse('WO_STATE_CONTRADICTION', 'Root cause requires a recorded failing attempt')
            attempt.rootCause = { detail: event.detail, writer }
            break
        }
        case 'gap': {
            if (state.gaps.some((gap) => gap.id === event.id)) return refuse('WO_STATE_CONTRADICTION', 'A human gap with this identity already exists')
            state.gaps.push({ id: event.id, step: event.step, question: event.question, writer })
            break
        }
        case 'resolve-gap': {
            const gap = state.gaps.find((entry) => entry.id === event.id)
            if (!gap || gap.answer) return refuse('WO_STATE_CONTRADICTION', 'Resolving a gap requires an unanswered durable question')
            gap.answer = { detail: event.answer, writer }
            break
        }
        case 'evidence': {
            const { kind: _kind, ...binding } = event
            state.evidence.push({ ...binding, writer })
            break
        }
        case 'decision': state.decisions.push({ decision: event.decision, writer }); break
    }
    state.heartbeat = writer
    state.revision += 1
    const validated = validateState(contract, state)
    if (validated.kind === 'refusal') return validated
    try {
        const bytes = encodeWorkOrderState(contract, validated.value)
        if (!await store.compareAndSwap(expected, bytes)) return refuse('WO_STATE_CONFLICT', 'Execution state changed; reload before deciding the next action')
        const readback = Buffer.from(await store.read())
        if (!readback.equals(Buffer.from(bytes))) return refuse('WO_STATE_PERSIST_FAILED', 'Execution state write was acknowledged but exact readback differs; advancement is withheld')
        return readWorkOrderState(contract, readback)
    } catch (error) {
        return refuse('WO_STATE_PERSIST_FAILED', `Execution state could not be persisted and confirmed: ${error instanceof Error ? error.message : String(error)}`)
    }
}
