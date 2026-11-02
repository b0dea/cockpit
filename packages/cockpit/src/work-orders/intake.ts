import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { snapshotJson, type JsonSnapshot } from '../environment/contract.js'
import {
    isParsedWorkOrder, parseWorkOrder, WORK_ORDER_LIMITS, type ParsedWorkOrder,
    type WorkOrderCriterion, type WorkOrderDecision, type WorkOrderSource,
} from './contract.js'

export const mechanism = {
    id: 'work-order-intake',
    module: 'packages/cockpit/src/work-orders/intake.ts',
    exports: ['WORK_ORDER_ACCEPTANCE_TTL_MS', 'WORK_ORDER_INTAKE_CODES', 'WORK_ORDER_INTAKE_LIMITS', 'WORK_ORDER_WIP_MAXIMA', 'acceptWorkOrder', 'activateAcceptedWorkOrder', 'beginWorkOrderAcceptance', 'beginWorkOrderRenewal', 'createWorkOrderAcceptanceRecord', 'intakeWorkOrder', 'isCurrentWorkOrderAcceptance', 'isValidatedWorkOrderPolicy', 'readmitWorkOrderAcceptance', 'routeWorkOrder', 'validateWorkOrderPolicy'],
} as const

export const WORK_ORDER_WIP_MAXIMA = Object.freeze({ cockpit: 3, programme: 1 })
export const WORK_ORDER_ACCEPTANCE_TTL_MS = 300_000
export const WORK_ORDER_INTAKE_LIMITS = Object.freeze({ inventory: 1_024, skills: 128, gaps: 64, actorBytes: 256 })
export const WORK_ORDER_INTAKE_CODES = Object.freeze([
    'WO_POLICY_INVALID', 'WO_ROUTE_REQUIRED', 'WO_WIP_INVALID', 'WO_WIP_CAP',
    'WO_CONTRACT_INVALID', 'WO_ID_EXISTS', 'WO_AUDIT_INVALID', 'WO_SKILLS_INVALID',
    'WO_SOURCE_GAPS', 'WO_ACCEPTANCE_INVALID',
    'WO_ACCEPTANCE_REPLAY', 'WO_ACCEPTANCE_STALE', 'WO_ACCEPTANCE_DECLINED', 'WO_RENEWAL_DECISION_REQUIRED',
] as const)
export type WorkOrderIntakeCode = typeof WORK_ORDER_INTAKE_CODES[number]
export interface WorkOrderIntakeRefusal {
    readonly kind: 'refusal'
    readonly code: WorkOrderIntakeCode
    readonly message: string
    readonly open?: number
    readonly programmeOpen?: number
    readonly unclassified?: readonly string[]
}
export interface WorkOrderPolicyInput { readonly cockpitCap: number; readonly programmeCap: number; readonly attemptCap: number }
export interface ValidatedWorkOrderPolicy extends WorkOrderPolicyInput {}
export interface WorkOrderRoutingInput {
    readonly certification?: boolean
    readonly crossSession?: boolean
    readonly programme?: string
}
export interface WorkOrderCapacity {
    readonly policy: ValidatedWorkOrderPolicy
    readonly orders: readonly Readonly<{ id: string; contract: ParsedWorkOrder | null }>[]
}
export interface WorkOrderRoutePermit {
    readonly kind: 'work-order'
    readonly judgement: 'instructed'
    readonly programme?: string
    readonly open: number
    readonly programmeOpen: number
    readonly unclassified: readonly string[]
}
export type WorkOrderRoute = WorkOrderIntakeRefusal | WorkOrderRoutePermit | Readonly<{ kind: 'fix'; judgement: 'instructed'; reason: string }>
export interface WorkOrderSourceGap {
    readonly kind: 'omission' | 'contradiction' | 'question'
    readonly reference: string
    readonly detail: string
}
export interface WorkOrderSourceAudit {
    readonly sources: readonly WorkOrderSource[]
    readonly gaps: readonly WorkOrderSourceGap[]
}
export interface InstalledThinkingSkill {
    readonly reference: string
    readonly category: 'thinking' | 'research' | 'specification' | 'planning' | 'other'
    readonly applicable: boolean
    readonly reason: string
}
export type WorkOrderSkillComposition =
    | Readonly<{ kind: 'absent'; reason: string }>
    | Readonly<{ kind: 'references'; references: readonly InstalledThinkingSkill[] }>
export interface WorkOrderDraft {
    readonly kind: 'draft'
    readonly contract: ParsedWorkOrder
    readonly skills: WorkOrderSkillComposition
    readonly gaps: readonly WorkOrderSourceGap[]
}
export interface WorkOrderIntakeInput {
    readonly route: WorkOrderRoute
    readonly contract: ParsedWorkOrder
    readonly sourceAudit: WorkOrderSourceAudit
    readonly installedSkills: readonly InstalledThinkingSkill[]
}
export interface WorkOrderActivationProvenance {
    readonly from: 'draft'
    readonly to: 'active'
    readonly acceptedDigest: string
    readonly operator: string
    readonly generation: number
    readonly predecessorRecordDigest?: string
}
export interface WorkOrderAcceptanceContinuation { readonly digest: string; readonly expiresAt: number }
export interface WorkOrderAcceptanceRequest {
    readonly kind: 'human_needed'
    readonly digest: string
    readonly continuation: WorkOrderAcceptanceContinuation
}
export interface AcceptedWorkOrder {
    readonly kind: 'accepted'
    readonly contract: ParsedWorkOrder
    readonly binding: Readonly<{
        digest: string
        authority: readonly string[]
        criteria: readonly WorkOrderCriterion[]
        acceptedAt: string
        acceptedBy: string
        acceptedDigest?: string
        activation?: WorkOrderActivationProvenance
        previousDigest?: string
        decision?: WorkOrderDecision
    }>
}
export interface WorkOrderAcceptanceRecord {
    readonly kind: 'acceptance-record'
    readonly version: 1
    readonly workOrderId: string
    readonly contractDigest: string
    readonly authority: readonly string[]
    readonly criteria: readonly WorkOrderCriterion[]
    readonly acceptedAt: string
    readonly acceptedBy: string
    readonly generation: number
    readonly acceptedDigest?: string
    readonly activation?: WorkOrderActivationProvenance
    readonly previousDigest?: string
    readonly decision?: WorkOrderDecision
    readonly predecessorRecordDigest?: string
    readonly recordDigest: string
}
export interface WorkOrderAcceptanceStoreReader {
    readonly storeDigest: string
    readCurrentAcceptance(workOrderId: string): unknown
}
export interface ActivatedWorkOrder {
    readonly kind: 'activated'
    readonly bytes: Uint8Array
    readonly accepted: AcceptedWorkOrder
}
export interface WorkOrderAcceptanceResponse {
    readonly now: number
    readonly actor: string
    readonly answer: string
}
interface AcceptanceSession {
    readonly draft: WorkOrderDraft
    readonly issuedAt: number
    readonly previous?: AcceptedWorkOrder
    readonly decision?: WorkOrderDecision
}

const issuedPolicies = new WeakSet<object>()
const issuedRoutes = new WeakMap<object, readonly string[]>()
const issuedDrafts = new WeakSet<object>()
const acceptedDrafts = new WeakSet<object>()
const issuedAcceptances = new WeakSet<object>()
const supersededAcceptances = new WeakSet<object>()
const admittedRecordDigests = new Map<string, string>()
const admittedGenerations = new Map<string, number>()
const admittedAcceptances = new Map<string, AcceptedWorkOrder>()
const sessions = new WeakMap<object, AcceptanceSession>()
const currentPrompts = new WeakMap<WorkOrderDraft, WorkOrderAcceptanceContinuation>()

function refuse(code: WorkOrderIntakeCode, message: string): WorkOrderIntakeRefusal {
    return Object.freeze({ kind: 'refusal', code, message })
}
function boundedText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= WORK_ORDER_LIMITS.lineBytes
        && !/[\x00-\x1f\x7f]/.test(value)
}

export function validateWorkOrderPolicy(input: unknown): { readonly kind: 'policy'; readonly policy: ValidatedWorkOrderPolicy } | WorkOrderIntakeRefusal {
    if (typeof input !== 'object' || input === null || !('cockpitCap' in input) || !('programmeCap' in input)) {
        return refuse('WO_POLICY_INVALID', 'A validated cockpit and programme WIP policy is required')
    }
    const { cockpitCap, programmeCap } = input
    const attemptCap = 'attemptCap' in input ? input.attemptCap : 2
    if (Object.keys(input).some((key) => key !== 'cockpitCap' && key !== 'programmeCap' && key !== 'attemptCap')
        || typeof attemptCap !== 'number' || !Number.isInteger(attemptCap) || attemptCap < 1 || attemptCap > 2
        || typeof cockpitCap !== 'number' || typeof programmeCap !== 'number'
        || !Number.isInteger(cockpitCap) || cockpitCap < 1 || cockpitCap > WORK_ORDER_WIP_MAXIMA.cockpit
        || !Number.isInteger(programmeCap) || programmeCap < 1 || programmeCap > WORK_ORDER_WIP_MAXIMA.programme) {
        return refuse('WO_POLICY_INVALID', `Attempt cap must be 1 or 2; WIP caps must be positive integers no greater than ${WORK_ORDER_WIP_MAXIMA.cockpit} cockpit / ${WORK_ORDER_WIP_MAXIMA.programme} programme`)
    }
    const policy = Object.freeze({ cockpitCap, programmeCap, attemptCap })
    issuedPolicies.add(policy)
    return Object.freeze({ kind: 'policy', policy })
}

export function isValidatedWorkOrderPolicy(input: unknown): input is ValidatedWorkOrderPolicy {
    return typeof input === 'object' && input !== null && issuedPolicies.has(input)
}

export function routeWorkOrder(input: WorkOrderRoutingInput, capacity?: WorkOrderCapacity): WorkOrderRoute {
    if (input.certification !== undefined && typeof input.certification !== 'boolean'
        || input.crossSession !== undefined && typeof input.crossSession !== 'boolean'
        || input.programme !== undefined && !/^[a-z][a-z0-9-]*$/.test(input.programme)) {
        return refuse('WO_ROUTE_REQUIRED', 'Routing requires explicit certification/durability decisions and a canonical programme slug')
    }
    if (!input.certification && !input.crossSession && input.programme === undefined) {
        return Object.freeze({ kind: 'fix', judgement: 'instructed', reason: 'No independent certification, cross-session durability or programme coordination required' })
    }
    if (!capacity || !isValidatedWorkOrderPolicy(capacity.policy)) return refuse('WO_POLICY_INVALID', 'Work-order routing requires an issued validated WIP policy')
    if (!Array.isArray(capacity.orders) || capacity.orders.length > WORK_ORDER_INTAKE_LIMITS.inventory) return refuse('WO_WIP_INVALID', 'WIP inventory is missing or exceeds the bounded inventory limit')
    const ids = new Set<string>()
    const unclassified: string[] = []
    let open = 0
    let programmeOpen = 0
    for (const order of capacity.orders) {
        if (!boundedText(order.id) || ids.has(order.id)) return refuse('WO_WIP_INVALID', 'WIP inventory requires unique named work orders')
        ids.add(order.id)
        const contract = isParsedWorkOrder(order.contract) && order.contract.frontmatter.id === order.id ? order.contract : undefined
        if (contract && ['completed', 'cancelled', 'parked'].includes(contract.frontmatter.status)) continue
        open += 1
        if (!contract) unclassified.push(order.id)
        if (input.programme !== undefined && (!contract || contract.frontmatter.programme === input.programme)) programmeOpen += 1
    }
    const unclassifiedNames = Object.freeze(unclassified)
    if (open >= capacity.policy.cockpitCap || input.programme !== undefined && programmeOpen >= capacity.policy.programmeCap) {
        return Object.freeze({ kind: 'refusal', code: 'WO_WIP_CAP', message: 'WIP capacity exhausted before work-order intake', open, programmeOpen, unclassified: unclassifiedNames })
    }
    const permit: WorkOrderRoutePermit = Object.freeze({ kind: 'work-order', judgement: 'instructed', ...(input.programme === undefined ? {} : { programme: input.programme }), open, programmeOpen, unclassified: unclassifiedNames })
    issuedRoutes.set(permit, Object.freeze([...ids]))
    return permit
}

function sameSource(left: WorkOrderSource, right: WorkOrderSource): boolean {
    return left.id === right.id && left.provenance === right.provenance && left.reference === right.reference && left.reason === right.reason
}

export function intakeWorkOrder(input: WorkOrderIntakeInput): WorkOrderDraft | WorkOrderIntakeRefusal {
    const ids = issuedRoutes.get(input.route)
    if (input.route.kind !== 'work-order' || !ids) return refuse('WO_ROUTE_REQUIRED', 'Complete work-order routing and WIP checks before compiling a draft')
    issuedRoutes.delete(input.route)
    const { contract, sourceAudit, installedSkills } = input
    if (!isParsedWorkOrder(contract) || contract.frontmatter.status !== 'draft' || input.route.programme !== contract.frontmatter.programme) {
        return refuse('WO_CONTRACT_INVALID', 'Intake requires an issued draft contract matching the routed programme')
    }
    if (ids.includes(contract.frontmatter.id)) return refuse('WO_ID_EXISTS', 'The work-order identity already exists in the audited inventory')
    if (!Array.isArray(sourceAudit.sources) || !Array.isArray(sourceAudit.gaps)
        || sourceAudit.sources.length > WORK_ORDER_LIMITS.sources || sourceAudit.gaps.length > WORK_ORDER_INTAKE_LIMITS.gaps
        || new Set(sourceAudit.sources.map((source) => source.id)).size !== sourceAudit.sources.length
        || sourceAudit.sources.some((source) => !boundedText(source.id) || !boundedText(source.reference) || !boundedText(source.reason)
            || !['read', 'inferred', 'operator-confirmed'].includes(source.provenance))
        || sourceAudit.gaps.some((gap) => !['omission', 'contradiction', 'question'].includes(gap.kind) || !boundedText(gap.reference) || !boundedText(gap.detail))) {
        return refuse('WO_AUDIT_INVALID', 'Source audit requires bounded unique sources and named material gaps')
    }
    if (!Array.isArray(installedSkills) || installedSkills.length > WORK_ORDER_INTAKE_LIMITS.skills) return refuse('WO_SKILLS_INVALID', 'Installed-skill snapshot is missing or oversized')
    const skills = new Map<string, InstalledThinkingSkill>()
    for (const skill of installedSkills) {
        if (!boundedText(skill.reference) || !boundedText(skill.reason) || typeof skill.applicable !== 'boolean'
            || !['thinking', 'research', 'specification', 'planning', 'other'].includes(skill.category)) return refuse('WO_SKILLS_INVALID', 'Installed skills require a reference, category, applicability and reason')
        const prior = skills.get(skill.reference)
        if (prior && (prior.category !== skill.category || prior.applicable !== skill.applicable || prior.reason !== skill.reason)) return refuse('WO_SKILLS_INVALID', 'Installed-skill references disagree about applicability')
        skills.set(skill.reference, Object.freeze({ reference: skill.reference, category: skill.category, applicable: skill.applicable, reason: skill.reason }))
    }
    const references = [...skills.values()].filter((skill) => skill.applicable && skill.category !== 'other')
    const composition: WorkOrderSkillComposition = references.length
        ? Object.freeze({ kind: 'references', references: Object.freeze(references) })
        : Object.freeze({ kind: 'absent', reason: 'No applicable installed thinking, research, specification or planning skill' })
    const gaps: WorkOrderSourceGap[] = sourceAudit.gaps.map((gap) => Object.freeze({ kind: gap.kind, reference: gap.reference, detail: gap.detail }))
    for (const source of contract.sources) {
        if (!sourceAudit.sources.some((audited) => sameSource(source, audited))) gaps.push(Object.freeze({ kind: 'omission', reference: source.id, detail: 'Contract source is absent or differs from the current source audit' }))
    }
    for (const source of sourceAudit.sources) {
        if (!contract.sources.some((compiled) => compiled.id === source.id)) gaps.push(Object.freeze({ kind: 'omission', reference: source.id, detail: 'Audited material source is absent from the contract' }))
    }
    const draft: WorkOrderDraft = Object.freeze({ kind: 'draft', contract, skills: composition, gaps: Object.freeze(gaps) })
    issuedDrafts.add(draft)
    return draft
}

function validTime(now: number): boolean {
    return Number.isSafeInteger(now) && now >= 0 && now <= 8_640_000_000_000_000 - WORK_ORDER_ACCEPTANCE_TTL_MS
}
// The CLI admits acceptance only from an interactive terminal outside CI and JSON modes, before any of this runs.
function draftRefusal(draft: WorkOrderDraft, now: number): WorkOrderIntakeRefusal | undefined {
    if (!issuedDrafts.has(draft) || !validTime(now)) return refuse('WO_ACCEPTANCE_INVALID', 'Acceptance requires an issued current draft and valid time')
    if (draft.gaps.length) return refuse('WO_SOURCE_GAPS', 'Named source omissions, contradictions or questions keep this order in draft')
    const date = new Date(now).toISOString().slice(0, 10)
    if (draft.contract.frontmatter.created > date || draft.contract.decisions.some((decision) => decision.date > date)) return refuse('WO_ACCEPTANCE_INVALID', 'Acceptance cannot precede the contract or its dated decisions')
    if (acceptedDrafts.has(draft)) return refuse('WO_ACCEPTANCE_REPLAY', 'This draft has already consumed operator acceptance')
    return undefined
}
function requestAcceptance(draft: WorkOrderDraft, now: number, previous?: AcceptedWorkOrder, decision?: WorkOrderDecision): WorkOrderAcceptanceRequest {
    const continuation = Object.freeze({ digest: draft.contract.digest, expiresAt: now + WORK_ORDER_ACCEPTANCE_TTL_MS })
    sessions.set(continuation, { draft, issuedAt: now, previous, decision })
    currentPrompts.set(draft, continuation)
    return Object.freeze({ kind: 'human_needed', digest: draft.contract.digest, continuation })
}

export function beginWorkOrderAcceptance(draft: WorkOrderDraft, now: number): WorkOrderAcceptanceRequest | WorkOrderIntakeRefusal {
    return draftRefusal(draft, now) ?? requestAcceptance(draft, now)
}

export function isCurrentWorkOrderAcceptance(accepted: AcceptedWorkOrder, contract: ParsedWorkOrder): boolean {
    return issuedAcceptances.has(accepted) && !supersededAcceptances.has(accepted) && isParsedWorkOrder(contract)
        && accepted.binding.digest === contract.digest
}

export function beginWorkOrderRenewal(previous: AcceptedWorkOrder, draft: WorkOrderDraft, now: number, decision: WorkOrderDecision): WorkOrderAcceptanceRequest | WorkOrderIntakeRefusal {
    const refusal = draftRefusal(draft, now)
    if (refusal) return refusal
    if (!isCurrentWorkOrderAcceptance(previous, previous.contract) || previous.contract.frontmatter.id !== draft.contract.frontmatter.id
        || previous.contract.digest === draft.contract.digest) return refuse('WO_ACCEPTANCE_STALE', 'Renewal requires the current accepted order and a changed contract with the same identity')
    if (!draft.contract.decisions.includes(decision) || decision.disposition !== 'accepted'
        || decision.date < previous.binding.acceptedAt.slice(0, 10)
        || previous.contract.decisions.some((prior) => sameCanonicalValue(prior, decision))) {
        return refuse('WO_RENEWAL_DECISION_REQUIRED', 'Material edits require a new dated accepted decision recording reason and impact')
    }
    return requestAcceptance(draft, now, previous, decision)
}

export function acceptWorkOrder(continuation: WorkOrderAcceptanceContinuation, current: WorkOrderDraft, response: WorkOrderAcceptanceResponse): AcceptedWorkOrder | WorkOrderIntakeRefusal {
    const session = sessions.get(continuation)
    if (!session) return refuse('WO_ACCEPTANCE_REPLAY', 'Acceptance continuation is unknown or already consumed')
    sessions.delete(continuation)
    const refusal = draftRefusal(current, response.now)
    if (refusal) return refusal
    if (currentPrompts.get(session.draft) !== continuation || response.now < session.issuedAt || response.now > continuation.expiresAt
        || current.contract.digest !== continuation.digest || current !== session.draft
        || session.previous && !isCurrentWorkOrderAcceptance(session.previous, session.previous.contract)) {
        return refuse('WO_ACCEPTANCE_STALE', 'Contract, operator prompt, prior acceptance or time changed; request current acceptance')
    }
    currentPrompts.delete(session.draft)
    if (!boundedText(response.actor) || Buffer.byteLength(response.actor) > WORK_ORDER_INTAKE_LIMITS.actorBytes) return refuse('WO_ACCEPTANCE_INVALID', 'Acceptance requires a bounded named operator')
    if (response.answer !== `accept ${continuation.digest}`) return refuse('WO_ACCEPTANCE_DECLINED', 'Operator did not explicitly accept the current digest')
    const accepted: AcceptedWorkOrder = Object.freeze({ kind: 'accepted', contract: current.contract, binding: Object.freeze({
        digest: current.contract.digest, authority: current.contract.authority, criteria: current.contract.criteria,
        acceptedAt: new Date(response.now).toISOString(), acceptedBy: response.actor,
        ...(session.previous === undefined ? {} : { previousDigest: session.previous.contract.digest, decision: session.decision }),
    }) })
    acceptedDrafts.add(current)
    issuedAcceptances.add(accepted)
    if (session.previous) supersededAcceptances.add(session.previous)
    return accepted
}

export function activateAcceptedWorkOrder(
    accepted: AcceptedWorkOrder,
    source: Uint8Array,
    predecessor?: WorkOrderAcceptanceRecord,
): ActivatedWorkOrder | WorkOrderIntakeRefusal {
    if (!isCurrentWorkOrderAcceptance(accepted, accepted?.contract)
        || accepted.contract.frontmatter.status !== 'draft' || !(source instanceof Uint8Array)) {
        return refuse('WO_ACCEPTANCE_INVALID', 'Activation requires current process-issued acceptance of a draft')
    }
    if (createHash('sha256').update(source).digest('hex') !== accepted.binding.digest) {
        return refuse('WO_ACCEPTANCE_STALE', 'Activation source bytes differ from the accepted draft')
    }
    const prior = predecessor === undefined ? undefined : safeAcceptanceRecord(predecessor)
    const renewed = accepted.binding.previousDigest !== undefined
    if (renewed && (!prior || prior.contractDigest !== accepted.binding.previousDigest)
        || !renewed && predecessor !== undefined) {
        return refuse('WO_ACCEPTANCE_STALE', 'Activation generation requires the exact durable predecessor')
    }
    let text: string
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source)
    } catch {
        return refuse('WO_ACCEPTANCE_INVALID', 'Activation source is not valid UTF-8')
    }
    const frontmatter = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/.exec(text)
    if (!frontmatter) return refuse('WO_ACCEPTANCE_INVALID', 'Activation source has no canonical frontmatter')
    const statusRows = frontmatter[2].split(/\r?\n/).filter((line) => line.startsWith('status:'))
    if (statusRows.length !== 1 || !/^status: draft[ \t]*$/.test(statusRows[0])) {
        return refuse('WO_ACCEPTANCE_STALE', 'Activation requires the exact accepted draft status')
    }
    const activeHeader = frontmatter[2].replace(/^status: draft(?=[ \t]*(?:\r?$))/m, 'status: active')
    const activeBytes = Buffer.from(`${frontmatter[1]}${activeHeader}${frontmatter[3]}${text.slice(frontmatter[0].length)}`)
    const parsed = parseWorkOrder(activeBytes)
    if (!parsed.ok || parsed.value.frontmatter.status !== 'active'
        || parsed.value.frontmatter.id !== accepted.contract.frontmatter.id) {
        return refuse('WO_ACCEPTANCE_INVALID', 'Status-only activation did not produce a canonical active contract')
    }
    const activation: WorkOrderActivationProvenance = Object.freeze({
        from: 'draft', to: 'active', acceptedDigest: accepted.binding.digest,
        operator: accepted.binding.acceptedBy, generation: (prior?.generation ?? 0) + 1,
        ...(prior === undefined ? {} : { predecessorRecordDigest: prior.recordDigest }),
    })
    const current: AcceptedWorkOrder = Object.freeze({ kind: 'accepted', contract: parsed.value, binding: Object.freeze({
        digest: parsed.value.digest, authority: parsed.value.authority, criteria: parsed.value.criteria,
        acceptedAt: accepted.binding.acceptedAt, acceptedBy: accepted.binding.acceptedBy,
        acceptedDigest: accepted.binding.digest, activation,
        ...(accepted.binding.previousDigest === undefined ? {} : {
            previousDigest: accepted.binding.previousDigest, decision: accepted.binding.decision,
        }),
    }) })
    supersededAcceptances.add(accepted)
    issuedAcceptances.add(current)
    return Object.freeze({ kind: 'activated', bytes: activeBytes, accepted: current })
}

type AcceptanceRecordPayload = Omit<WorkOrderAcceptanceRecord, 'recordDigest'>

function canonicalJson(value: unknown): string | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot === undefined) return undefined
    const encoded = JSON.stringify(snapshot)
    return Buffer.byteLength(encoded) <= WORK_ORDER_LIMITS.bytes ? encoded : undefined
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
    const canonical = canonicalJson(left)
    return canonical !== undefined && canonical === canonicalJson(right)
}

function recordDigest(payload: AcceptanceRecordPayload): string | undefined {
    const canonical = canonicalJson(payload)
    return canonical === undefined ? undefined : createHash('sha256').update(canonical).digest('hex')
}

function acceptanceRecordPayload(input: Omit<AcceptanceRecordPayload, 'kind' | 'version'>): AcceptanceRecordPayload {
    return {
        kind: 'acceptance-record', version: 1, workOrderId: input.workOrderId,
        contractDigest: input.contractDigest, authority: input.authority, criteria: input.criteria,
        acceptedAt: input.acceptedAt, acceptedBy: input.acceptedBy, generation: input.generation,
        ...(input.acceptedDigest === undefined ? {} : { acceptedDigest: input.acceptedDigest }),
        ...(input.activation === undefined ? {} : { activation: input.activation }),
        ...(input.previousDigest === undefined ? {} : { previousDigest: input.previousDigest }),
        ...(input.decision === undefined ? {} : { decision: input.decision }),
        ...(input.predecessorRecordDigest === undefined ? {} : { predecessorRecordDigest: input.predecessorRecordDigest }),
    }
}

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
    const keys = Object.keys(value)
    return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}

function validDigest(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function validDecision(value: unknown): value is WorkOrderDecision {
    if (typeof value !== 'object' || value === null
        || !exactKeys(value, ['date', 'decision', 'disposition', 'reason', 'impact'])) return false
    const decision = value as unknown as WorkOrderDecision
    return /^\d{4}-\d{2}-\d{2}$/.test(decision.date)
        && ['accepted', 'rejected', 'deferred'].includes(decision.disposition)
        && boundedText(decision.decision) && boundedText(decision.reason) && boundedText(decision.impact)
}

function validCriterion(value: unknown): value is WorkOrderCriterion {
    if (typeof value !== 'object' || value === null
        || !exactKeys(value, ['id', 'source', 'given', 'when', 'then'])) return false
    const criterion = value as unknown as WorkOrderCriterion
    return boundedText(criterion.id) && boundedText(criterion.source) && boundedText(criterion.given)
        && boundedText(criterion.when) && boundedText(criterion.then)
}

function validActivation(value: unknown): value is WorkOrderActivationProvenance {
    if (typeof value !== 'object' || value === null
        || !exactKeys(value, ['from', 'to', 'acceptedDigest', 'operator', 'generation'], ['predecessorRecordDigest'])) return false
    const activation = value as unknown as WorkOrderActivationProvenance
    return activation.from === 'draft' && activation.to === 'active' && validDigest(activation.acceptedDigest)
        && boundedText(activation.operator) && Number.isSafeInteger(activation.generation) && activation.generation > 0
        && (activation.predecessorRecordDigest === undefined || validDigest(activation.predecessorRecordDigest))
}

function parseAcceptanceRecord(value: unknown): WorkOrderAcceptanceRecord | undefined {
    if (typeof value !== 'object' || value === null
        || !exactKeys(value, [
            'kind', 'version', 'workOrderId', 'contractDigest', 'authority', 'criteria',
            'acceptedAt', 'acceptedBy', 'generation', 'recordDigest',
        ], ['acceptedDigest', 'activation', 'previousDigest', 'decision', 'predecessorRecordDigest'])) return undefined
    const candidate = value as unknown as WorkOrderAcceptanceRecord
    if (candidate.kind !== 'acceptance-record' || candidate.version !== 1
        || !boundedText(candidate.workOrderId) || !validDigest(candidate.contractDigest)
        || !Array.isArray(candidate.authority) || candidate.authority.length < 1 || candidate.authority.length > WORK_ORDER_LIMITS.authority
        || !candidate.authority.every(boundedText)
        || !Array.isArray(candidate.criteria) || candidate.criteria.length < WORK_ORDER_LIMITS.criteriaMin
        || candidate.criteria.length > WORK_ORDER_LIMITS.criteriaMax || !candidate.criteria.every(validCriterion)
        || !boundedText(candidate.acceptedBy) || Buffer.byteLength(candidate.acceptedBy) > WORK_ORDER_INTAKE_LIMITS.actorBytes
        || typeof candidate.acceptedAt !== 'string' || !Number.isFinite(Date.parse(candidate.acceptedAt))
        || new Date(candidate.acceptedAt).toISOString() !== candidate.acceptedAt
        || !Number.isSafeInteger(candidate.generation) || candidate.generation < 1
        || candidate.acceptedDigest !== undefined && (!validDigest(candidate.acceptedDigest)
            || candidate.acceptedDigest === candidate.contractDigest)
        || candidate.activation !== undefined && !validActivation(candidate.activation)
        || !validDigest(candidate.recordDigest)) return undefined
    const renewed = candidate.generation > 1
    if (renewed !== (validDigest(candidate.previousDigest) && validDecision(candidate.decision)
        && validDigest(candidate.predecessorRecordDigest))) return undefined
    if (!renewed && (candidate.previousDigest !== undefined || candidate.decision !== undefined
        || candidate.predecessorRecordDigest !== undefined)) return undefined
    const activated = candidate.acceptedDigest !== undefined
    const activation = candidate.activation
    if (activated !== (activation !== undefined)) return undefined
    if (activation && (activation.acceptedDigest !== candidate.acceptedDigest
        || activation.operator !== candidate.acceptedBy
        || activation.generation !== candidate.generation
        || activation.predecessorRecordDigest !== candidate.predecessorRecordDigest)) return undefined
    const payload = acceptanceRecordPayload(candidate)
    if (canonicalJson({ ...payload, recordDigest: candidate.recordDigest }) === undefined
        || recordDigest(payload) !== candidate.recordDigest) return undefined
    return Object.freeze({ ...payload, recordDigest: candidate.recordDigest })
}

function snapshotAcceptanceRecord(value: unknown): JsonSnapshot | undefined {
    const snapshot = snapshotJson(value)
    return snapshot !== undefined && canonicalJson(snapshot) !== undefined ? snapshot : undefined
}

function safeAcceptanceRecord(value: unknown): WorkOrderAcceptanceRecord | undefined {
    try {
        return parseAcceptanceRecord(snapshotAcceptanceRecord(value))
    } catch (_error) {
        return undefined
    }
}

export function createWorkOrderAcceptanceRecord(
    accepted: AcceptedWorkOrder,
    predecessor?: WorkOrderAcceptanceRecord,
): WorkOrderAcceptanceRecord | WorkOrderIntakeRefusal {
    if (!isCurrentWorkOrderAcceptance(accepted, accepted?.contract)) {
        return refuse('WO_ACCEPTANCE_INVALID', 'A durable record requires current process-issued acceptance')
    }
    const prior = predecessor === undefined ? undefined : safeAcceptanceRecord(predecessor)
    const renewed = accepted.binding.previousDigest !== undefined
    if (renewed && (!prior || prior.contractDigest !== accepted.binding.previousDigest)
        || !renewed && predecessor !== undefined) {
        return refuse('WO_ACCEPTANCE_STALE', 'Durable renewal requires the exact valid predecessor record')
    }
    const generation = (prior?.generation ?? 0) + 1
    const activated = accepted.contract.frontmatter.status === 'active'
    const activation = accepted.binding.activation
    if (activated !== (activation !== undefined)) {
        return refuse('WO_ACCEPTANCE_INVALID', 'Active acceptance requires exact issued activation provenance')
    }
    if (activation && (accepted.binding.acceptedDigest !== activation.acceptedDigest
        || accepted.binding.acceptedBy !== activation.operator || generation !== activation.generation
        || activation.predecessorRecordDigest !== prior?.recordDigest)) {
        return refuse('WO_ACCEPTANCE_INVALID', 'Active acceptance provenance differs from the accepted transition')
    }
    const payload = acceptanceRecordPayload({
        workOrderId: accepted.contract.frontmatter.id,
        contractDigest: accepted.binding.digest,
        authority: accepted.binding.authority,
        criteria: accepted.binding.criteria,
        acceptedAt: accepted.binding.acceptedAt,
        acceptedBy: accepted.binding.acceptedBy,
        generation,
        ...(accepted.binding.acceptedDigest === undefined ? {} : { acceptedDigest: accepted.binding.acceptedDigest }),
        ...(accepted.binding.activation === undefined ? {} : { activation: accepted.binding.activation }),
        ...(accepted.binding.previousDigest === undefined ? {} : {
            previousDigest: accepted.binding.previousDigest,
            decision: accepted.binding.decision,
            predecessorRecordDigest: prior?.recordDigest,
        }),
    })
    const digest = recordDigest(payload)
    if (digest === undefined) return refuse('WO_ACCEPTANCE_INVALID', 'Durable acceptance record exceeds canonical bounds')
    return Object.freeze({ ...payload, recordDigest: digest })
}

function readCurrentRecord(contract: ParsedWorkOrder, store: WorkOrderAcceptanceStoreReader): WorkOrderAcceptanceRecord | WorkOrderIntakeRefusal {
    let first: WorkOrderAcceptanceRecord | undefined
    let second: WorkOrderAcceptanceRecord | undefined
    try {
        const reader = store.readCurrentAcceptance
        if (typeof reader !== 'function') return refuse('WO_ACCEPTANCE_INVALID', 'Current acceptance store has no reader')
        first = safeAcceptanceRecord(reader.call(store, contract.frontmatter.id))
        second = safeAcceptanceRecord(reader.call(store, contract.frontmatter.id))
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return refuse('WO_ACCEPTANCE_INVALID', `Current acceptance store read failed: ${reason}`)
    }
    if (!first || !second) return refuse('WO_ACCEPTANCE_INVALID', 'Current acceptance store returned an invalid bounded record')
    if (first.recordDigest !== second.recordDigest) return refuse('WO_ACCEPTANCE_STALE', 'Current acceptance changed across the read boundary')
    return first
}

function acceptanceStore(input: unknown): WorkOrderAcceptanceStoreReader | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string') || (keys as string[]).sort().join(',') !== 'readCurrentAcceptance,storeDigest'
        || !descriptors.storeDigest?.enumerable || !('value' in descriptors.storeDigest)
        || !descriptors.readCurrentAcceptance?.enumerable || !('value' in descriptors.readCurrentAcceptance)
        || typeof descriptors.readCurrentAcceptance.value !== 'function') return undefined
    const captured = snapshotJson({ storeDigest: descriptors.storeDigest.value }) as Readonly<{ storeDigest?: unknown }> | undefined
    if (!captured || typeof captured.storeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(captured.storeDigest)) return undefined
    return Object.freeze({ storeDigest: captured.storeDigest,
        readCurrentAcceptance: (workOrderId: string) => Reflect.apply(descriptors.readCurrentAcceptance!.value, input, [workOrderId]) })
}

export function readmitWorkOrderAcceptance(
    contract: ParsedWorkOrder,
    store: WorkOrderAcceptanceStoreReader,
): AcceptedWorkOrder | WorkOrderIntakeRefusal {
    const capturedStore = acceptanceStore(store)
    if (!isParsedWorkOrder(contract) || !capturedStore) {
        return refuse('WO_ACCEPTANCE_INVALID', 'Re-admission requires a parser-issued contract and current contained-store reader')
    }
    const record = readCurrentRecord(contract, capturedStore)
    if ('code' in record) return record
    if (record.workOrderId !== contract.frontmatter.id || record.contractDigest !== contract.digest
        || (record.acceptedDigest === undefined ? contract.frontmatter.status !== 'draft' : contract.frontmatter.status !== 'active')
        || !sameCanonicalValue(record.authority, contract.authority)
        || !sameCanonicalValue(record.criteria, contract.criteria)) {
        return refuse('WO_ACCEPTANCE_STALE', 'Durable acceptance does not bind the current contract')
    }
    const storeOrder = `${capturedStore.storeDigest}:${record.workOrderId}`
    const highest = admittedGenerations.get(storeOrder) ?? 0
    if (admittedRecordDigests.get(storeOrder) === record.recordDigest) {
        return refuse('WO_ACCEPTANCE_REPLAY', 'Durable acceptance record was already admitted in this process')
    }
    if (highest === 0 && admittedGenerations.size >= WORK_ORDER_INTAKE_LIMITS.inventory) {
        return refuse('WO_ACCEPTANCE_INVALID', 'Process acceptance inventory exceeds its bounded limit')
    }
    if (record.generation <= highest) {
        return refuse('WO_ACCEPTANCE_STALE', 'Durable acceptance generation is older than current process authority')
    }
    if (highest > 0 && record.generation !== highest + 1) {
        return refuse('WO_ACCEPTANCE_STALE', 'Durable acceptance generation does not follow current process authority')
    }
    const prior = admittedAcceptances.get(storeOrder)
    if (prior) supersededAcceptances.add(prior)
    const accepted: AcceptedWorkOrder = Object.freeze({ kind: 'accepted', contract, binding: Object.freeze({
        digest: record.contractDigest, authority: contract.authority, criteria: contract.criteria,
        acceptedAt: record.acceptedAt, acceptedBy: record.acceptedBy,
        ...(record.acceptedDigest === undefined ? {} : { acceptedDigest: record.acceptedDigest }),
        ...(record.activation === undefined ? {} : { activation: record.activation }),
        ...(record.previousDigest === undefined ? {} : { previousDigest: record.previousDigest, decision: record.decision }),
    }) })
    issuedAcceptances.add(accepted)
    admittedRecordDigests.set(storeOrder, record.recordDigest)
    admittedGenerations.set(storeOrder, record.generation)
    admittedAcceptances.set(storeOrder, accepted)
    return accepted
}
