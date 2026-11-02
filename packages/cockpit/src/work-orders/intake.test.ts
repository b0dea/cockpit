import { describe, expect, it } from 'vitest'
import { parseWorkOrder, type ParsedWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import {
    acceptWorkOrder, activateAcceptedWorkOrder, beginWorkOrderAcceptance, beginWorkOrderRenewal, intakeWorkOrder,
    createWorkOrderAcceptanceRecord, isCurrentWorkOrderAcceptance, isValidatedWorkOrderPolicy, readmitWorkOrderAcceptance,
    routeWorkOrder, validateWorkOrderPolicy, type WorkOrderAcceptanceRecord,
    WORK_ORDER_ACCEPTANCE_TTL_MS, WORK_ORDER_WIP_MAXIMA,
} from './intake.js'

const now = Date.parse('2026-01-03T12:00:00Z')
const storeDigest = 'c'.repeat(64)
const parse = (text = workOrderFixture()): ParsedWorkOrder => {
    const parsed = parseWorkOrder(Buffer.from(text))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings))
    return parsed.value
}
const policy = (cockpitCap = 3, programmeCap = 1) => {
    const result = validateWorkOrderPolicy({ cockpitCap, programmeCap })
    if (result.kind !== 'policy') throw new Error('valid policy refused')
    return result.policy
}
const route = (programme?: string) => routeWorkOrder({ certification: true, ...(programme ? { programme } : {}) }, { policy: policy(), orders: [] })
const draft = (text = workOrderFixture()) => {
    const contract = parse(text)
    const result = intakeWorkOrder({
        route: route(contract.frontmatter.programme), contract,
        sourceAudit: { sources: contract.sources, gaps: [] }, installedSkills: [],
    })
    if (result.kind !== 'draft') throw new Error('valid draft refused')
    return result
}
const accept = (candidate = draft()) => {
    const request = beginWorkOrderAcceptance(candidate, now)
    if (request.kind !== 'human_needed') throw new Error('operator continuation unavailable')
    const result = acceptWorkOrder(request.continuation, candidate, { now: now + 1, actor: 'operator', answer: `accept ${candidate.contract.digest}` })
    if (result.kind !== 'accepted') throw new Error('operator acceptance refused')
    return result
}

describe('work-order intake', () => {
    it('defaults to an artifact-free fix door and explicitly routes durable or certified work', () => {
        expect(routeWorkOrder({})).toEqual({ kind: 'fix', judgement: 'instructed', reason: 'No independent certification, cross-session durability or programme coordination required' })
        for (const reasons of [{ certification: true }, { crossSession: true }, { programme: 'cache' }]) {
            expect(routeWorkOrder(reasons, { policy: policy(), orders: [] })).toMatchObject({ kind: 'work-order', judgement: 'instructed' })
        }
        expect(intakeWorkOrder({ route: routeWorkOrder({}), contract: parse(), sourceAudit: { sources: [], gaps: [] }, installedSkills: [] }))
            .toMatchObject({ kind: 'refusal', code: 'WO_ROUTE_REQUIRED' })
    })

    it('permits lower positive integer caps and refuses raised, fractional, zero or missing policies', () => {
        expect(validateWorkOrderPolicy({ cockpitCap: 1, programmeCap: 1 }).kind).toBe('policy')
        for (const input of [
            { cockpitCap: WORK_ORDER_WIP_MAXIMA.cockpit + 1, programmeCap: 1 },
            { cockpitCap: 1, programmeCap: WORK_ORDER_WIP_MAXIMA.programme + 1 },
            { cockpitCap: 1.5, programmeCap: 1 }, { cockpitCap: 0, programmeCap: 1 }, {}, null,
        ]) expect(validateWorkOrderPolicy(input)).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
        expect(routeWorkOrder({ certification: true })).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
    })

    it('counts unclassifiable orders as open, names them and refuses before intake', () => {
        const result = routeWorkOrder({ certification: true }, { policy: policy(1), orders: [{ id: 'unreadable-order', contract: null }] })
        expect(result).toMatchObject({ kind: 'refusal', code: 'WO_WIP_CAP', open: 1, unclassified: ['unreadable-order'] })
    })

    it('enforces programme capacity independently and conservatively counts unknown membership', () => {
        for (const contract of [parse(workOrderFixture({ programme: 'cache' })), null]) {
            expect(routeWorkOrder({ programme: 'cache' }, { policy: policy(), orders: [{ id: contract?.frontmatter.id ?? 'unreadable', contract }] }))
                .toMatchObject({ kind: 'refusal', code: 'WO_WIP_CAP', programmeOpen: 1 })
        }
        const other = parse(workOrderFixture({ programme: 'other' }))
        expect(routeWorkOrder({ programme: 'cache' }, { policy: policy(), orders: [{ id: other.frontmatter.id, contract: other }] }).kind).toBe('work-order')
    })

    it('excludes terminal and parked work while naming malformed and duplicate inventory', () => {
        const parked = parse(workOrderFixture({ status: 'parked' }))
        expect(routeWorkOrder({ certification: true }, { policy: policy(1), orders: [{ id: parked.frontmatter.id, contract: parked }] }).kind).toBe('work-order')
        expect(routeWorkOrder({ certification: true }, { policy: policy(), orders: [{ id: 'same', contract: null }, { id: 'same', contract: null }] }))
            .toMatchObject({ kind: 'refusal', code: 'WO_WIP_INVALID' })
    })

    it('refuses copied route and parser values, programme mismatch and duplicate work identities', () => {
        const contract = parse()
        const input = { route: { ...route() }, contract, sourceAudit: { sources: contract.sources, gaps: [] }, installedSkills: [] }
        expect(intakeWorkOrder(input)).toMatchObject({ kind: 'refusal', code: 'WO_ROUTE_REQUIRED' })
        expect(intakeWorkOrder({ ...input, route: route(), contract: { ...contract } })).toMatchObject({ kind: 'refusal', code: 'WO_CONTRACT_INVALID' })
        expect(intakeWorkOrder({ ...input, route: route('cache') })).toMatchObject({ kind: 'refusal', code: 'WO_CONTRACT_INVALID' })
        const collision = routeWorkOrder({ certification: true }, { policy: policy(), orders: [{ id: contract.frontmatter.id, contract }] })
        expect(intakeWorkOrder({ ...input, route: collision })).toMatchObject({ kind: 'refusal', code: 'WO_ID_EXISTS' })
    })

    it('requires a fresh WIP route for every draft compilation', () => {
        const contract = parse()
        const input = { route: route(), contract, sourceAudit: { sources: contract.sources, gaps: [] }, installedSkills: [] }
        expect(intakeWorkOrder(input).kind).toBe('draft')
        expect(intakeWorkOrder(input)).toMatchObject({ kind: 'refusal', code: 'WO_ROUTE_REQUIRED' })
    })

    it('composes only applicable installed skill references once and records explicit absence', () => {
        const contract = parse()
        const thinking = { reference: 'skills/think/SKILL.md', category: 'thinking' as const, applicable: true, reason: 'Clarify the cache boundary' }
        const installedSkills = [thinking, thinking,
            { reference: 'skills/research/SKILL.md', category: 'research' as const, applicable: false, reason: 'Sources already supplied' },
            { reference: 'skills/other/SKILL.md', category: 'other' as const, applicable: true, reason: 'Unrelated operation' },
        ]
        const result = intakeWorkOrder({ route: route(), contract, sourceAudit: { sources: contract.sources, gaps: [] }, installedSkills })
        expect(result.kind).toBe('draft')
        if (result.kind !== 'draft') throw new Error('draft refused')
        expect(result.skills).toEqual({ kind: 'references', references: [thinking] })
        if (result.skills.kind !== 'references') throw new Error('applicable skill reference missing')
        expect(result.contract.sources).toEqual(contract.sources)
        expect(draft().skills).toMatchObject({ kind: 'absent', reason: expect.stringContaining('No applicable installed') })
        expect(Object.isFrozen(result.skills.references)).toBe(true)
    })

    it('keeps named audit omissions, contradictions and human questions in draft', () => {
        const contract = parse()
        const gaps = [{ kind: 'contradiction' as const, reference: 'S1', detail: 'Two supported behaviors disagree' },
            { kind: 'question' as const, reference: 'S3', detail: 'Which reader wins?' }]
        const result = intakeWorkOrder({ route: route(), contract, sourceAudit: { sources: contract.sources.slice(1), gaps }, installedSkills: [] })
        expect(result.kind).toBe('draft')
        if (result.kind !== 'draft') throw new Error('draft refused')
        expect(result.gaps).toEqual([...gaps, { kind: 'omission', reference: 'S1', detail: 'Contract source is absent or differs from the current source audit' }])
        expect(beginWorkOrderAcceptance(result, now)).toMatchObject({ kind: 'refusal', code: 'WO_SOURCE_GAPS' })
    })

    it('detects audited material sources omitted from the compiled draft', () => {
        const contract = parse()
        const result = intakeWorkOrder({ route: route(), contract,
            sourceAudit: { sources: [...contract.sources, { id: 'S4', provenance: 'read' as const, reference: 'src/reader.ts', reason: 'Reader affects refresh' }], gaps: [] }, installedSkills: [] })
        expect(result.kind).toBe('draft')
        if (result.kind !== 'draft') throw new Error('draft refused')
        expect(result.gaps).toContainEqual({ kind: 'omission', reference: 'S4', detail: 'Audited material source is absent from the contract' })
    })
})

describe('operator contract acceptance', () => {
    it('returns human_needed and freezes the exact current digest, Authority and criteria only on explicit acceptance', () => {
        const candidate = draft()
        const request = beginWorkOrderAcceptance(candidate, now)
        expect(request).toMatchObject({ kind: 'human_needed', digest: candidate.contract.digest })
        const accepted = accept(candidate)
        expect(accepted.binding).toMatchObject({ digest: candidate.contract.digest, acceptedBy: 'operator', authority: candidate.contract.authority, criteria: candidate.contract.criteria })
        expect(isCurrentWorkOrderAcceptance(accepted, candidate.contract)).toBe(true)
        expect(Object.isFrozen(accepted.binding)).toBe(true)
    })

    it('activates only the exact accepted draft bytes and preserves acceptance provenance', () => {
        const source = workOrderFixture()
        const acceptedDraft = accept(draft(source))
        const activated = activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source))
        expect(activated.kind).toBe('activated')
        if (activated.kind !== 'activated') throw new Error('activation refused')
        expect(activated.accepted.contract.frontmatter.status).toBe('active')
        expect(activated.accepted.binding).toMatchObject({
            digest: activated.accepted.contract.digest,
            acceptedDigest: acceptedDraft.contract.digest,
            acceptedBy: acceptedDraft.binding.acceptedBy,
            activation: { from: 'draft', to: 'active', generation: 1, operator: acceptedDraft.binding.acceptedBy },
        })
        expect(Buffer.from(activated.bytes).toString()).toBe(source.replace('status: draft', 'status: active'))
        expect(isCurrentWorkOrderAcceptance(acceptedDraft, acceptedDraft.contract)).toBe(false)
        expect(isCurrentWorkOrderAcceptance(activated.accepted, activated.accepted.contract)).toBe(true)
        const record = createWorkOrderAcceptanceRecord(activated.accepted)
        expect(record).toMatchObject({ kind: 'acceptance-record', acceptedDigest: acceptedDraft.contract.digest })
        if (record.kind !== 'acceptance-record') throw new Error('record refused')
        expect(readmitWorkOrderAcceptance(activated.accepted.contract, {
            storeDigest,
            readCurrentAcceptance: () => ({ ...record, activation: { ...record.activation, operator: 'forged' } }),
        })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        expect(readmitWorkOrderAcceptance(activated.accepted.contract, {
            storeDigest,
            readCurrentAcceptance: () => JSON.parse(JSON.stringify(record)) as unknown,
        }).kind).toBe('accepted')
    })

    it('refuses activation from copied authority, changed bytes, non-draft bytes and replay', () => {
        const source = workOrderFixture().replace('id: WO-001', 'id: WO-003')
        const acceptedDraft = accept(draft(source))
        expect(activateAcceptedWorkOrder({ ...acceptedDraft }, Buffer.from(source))).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        expect(activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source.replace('Refresh 1 completes.', 'Refresh 1 changed.'))))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        expect(activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source.replace('status: draft', 'status: ready'))))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        expect(activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source)).kind).toBe('activated')
        expect(activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source))).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
    })

    it('preserves canonical whitespace and CRLF while replacing only the draft status token', () => {
        const source = workOrderFixture().replace('id: WO-001', 'id: WO-006')
            .replace('status: draft', 'status: draft  ').replace(/\n/g, '\r\n')
        const acceptedDraft = accept(draft(source))
        const activated = activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source))
        expect(activated.kind).toBe('activated')
        if (activated.kind !== 'activated') throw new Error('activation refused')
        expect(Buffer.from(activated.bytes).toString()).toBe(source.replace('status: draft', 'status: active'))
    })

    it('consumes a continuation once including after a declined or forged response', () => {
        const candidate = draft()
        const request = beginWorkOrderAcceptance(candidate, now)
        if (request.kind !== 'human_needed') throw new Error('request refused')
        const response = { now: now + 1, actor: 'operator', answer: 'yes' }
        expect(acceptWorkOrder({ ...request.continuation }, candidate, response)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_REPLAY' })
        expect(acceptWorkOrder(request.continuation, candidate, response)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_DECLINED' })
        expect(acceptWorkOrder(request.continuation, candidate, { ...response, answer: `accept ${candidate.contract.digest}` })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_REPLAY' })
    })

    it('refuses stale bytes and expired time after the prompt', () => {
        for (const mode of ['bytes', 'expired'] as const) {
            const candidate = draft()
            const request = beginWorkOrderAcceptance(candidate, now)
            if (request.kind !== 'human_needed') throw new Error('request refused')
            const current = mode === 'bytes' ? draft(workOrderFixture().replace('Refresh 1 completes.', 'Refresh 1 and invalidation complete.')) : candidate
            expect(acceptWorkOrder(request.continuation, current, {
                now: mode === 'expired' ? now + WORK_ORDER_ACCEPTANCE_TTL_MS + 1 : now + 1,
                actor: 'operator', answer: `accept ${current.contract.digest}`,
            })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        }
    })

    it('invalidates an earlier prompt when another is issued for the same draft', () => {
        const candidate = draft()
        const first = beginWorkOrderAcceptance(candidate, now)
        const second = beginWorkOrderAcceptance(candidate, now + 1)
        if (first.kind !== 'human_needed' || second.kind !== 'human_needed') throw new Error('request refused')
        const response = { now: now + 2, actor: 'operator', answer: `accept ${candidate.contract.digest}` }
        expect(acceptWorkOrder(first.continuation, candidate, response)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        expect(acceptWorkOrder(second.continuation, candidate, response).kind).toBe('accepted')
        expect(beginWorkOrderAcceptance(candidate, now + 3)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_REPLAY' })
    })

    it('invalidates material edits and requires a new dated accepted decision with reason and impact for renewal', () => {
        const previous = accept()
        const edited = draft(workOrderFixture().replace('Refresh 1 completes.', 'Refresh 1 and invalidation complete.'))
        expect(isCurrentWorkOrderAcceptance(previous, edited.contract)).toBe(false)
        expect(beginWorkOrderRenewal(previous, edited, now + 2, edited.contract.decisions[0]))
            .toMatchObject({ kind: 'refusal', code: 'WO_RENEWAL_DECISION_REQUIRED' })
        const updated = draft(workOrderFixture().replace('Refresh 1 completes.', 'Refresh 1 and invalidation complete.')
            + '- 2026-01-03 | Add invalidation to refresh | accepted | Reader can race the cache | Verify invalidation too.\n')
        const request = beginWorkOrderRenewal(previous, updated, now + 2, updated.contract.decisions[1])
        expect(request.kind).toBe('human_needed')
        if (request.kind !== 'human_needed') throw new Error('renewal refused')
        const renewed = acceptWorkOrder(request.continuation, updated, { now: now + 3, actor: 'operator', answer: `accept ${updated.contract.digest}` })
        expect(renewed.kind).toBe('accepted')
        if (renewed.kind !== 'accepted') throw new Error('renewal failed')
        expect(renewed.binding.previousDigest).toBe(previous.contract.digest)
        expect(isCurrentWorkOrderAcceptance(renewed, updated.contract)).toBe(true)
        expect(isCurrentWorkOrderAcceptance(previous, previous.contract)).toBe(false)
    })

    it('isolates identical acceptance generations by durable store while retaining same-store replay refusal', () => {
        const original = accept(draft(workOrderFixture().replace('id: WO-001', 'id: WO-008')))
        const record = createWorkOrderAcceptanceRecord(original)
        if (record.kind !== 'acceptance-record') throw new Error('record refused')
        const reader = (storeDigest: string) => ({ storeDigest,
            readCurrentAcceptance: () => JSON.parse(JSON.stringify(record)) as unknown })
        const first = readmitWorkOrderAcceptance(original.contract, reader('a'.repeat(64)))
        expect(first.kind).toBe('accepted')
        expect(readmitWorkOrderAcceptance(original.contract, reader('a'.repeat(64))))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_REPLAY' })
        const second = readmitWorkOrderAcceptance(original.contract, reader('b'.repeat(64)))
        expect(second.kind).toBe('accepted')
        if (first.kind !== 'accepted' || second.kind !== 'accepted') throw new Error('independent store admission refused')
        expect(isCurrentWorkOrderAcceptance(first, original.contract)).toBe(true)
        expect(isCurrentWorkOrderAcceptance(second, original.contract)).toBe(true)
    })

    it('re-admits an exact stable record as fresh process-local authority', () => {
        const original = accept(draft(workOrderFixture().replace('id: WO-001', 'id: WO-004')))
        const record = createWorkOrderAcceptanceRecord(original)
        expect(record.kind).toBe('acceptance-record')
        if (record.kind !== 'acceptance-record') throw new Error('record refused')
        const reader = { storeDigest, readCurrentAcceptance: () => JSON.parse(JSON.stringify(record)) as unknown }
        const current = readmitWorkOrderAcceptance(original.contract, reader)
        expect(current.kind).toBe('accepted')
        if (current.kind !== 'accepted') throw new Error('re-admission refused')
        expect(current).not.toBe(original)
        expect(current.binding).toEqual(original.binding)
        expect(isCurrentWorkOrderAcceptance(current, original.contract)).toBe(true)
        expect(readmitWorkOrderAcceptance(original.contract, reader)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_REPLAY' })
    })

    it('refuses malformed, changing, mismatched and copied durable authority', () => {
        const source = workOrderFixture().replace('id: WO-001', 'id: WO-005')
        const original = accept(draft(source))
        const record = createWorkOrderAcceptanceRecord(original)
        if (record.kind !== 'acceptance-record') throw new Error('record refused')
        const changed = parse(source.replace('Refresh 1 completes.', 'Refresh 1 and invalidation complete.'))
        const cases: readonly [ParsedWorkOrder, () => unknown, string][] = [
            [original.contract, () => ({ ...record, recordDigest: '0'.repeat(64) }), 'WO_ACCEPTANCE_INVALID'],
            [changed, () => record, 'WO_ACCEPTANCE_STALE'],
        ]
        for (const [contract, readCurrentAcceptance, code] of cases) {
            expect(readmitWorkOrderAcceptance(contract, { storeDigest, readCurrentAcceptance })).toMatchObject({ kind: 'refusal', code })
        }
        expect(readmitWorkOrderAcceptance(original.contract, {
            storeDigest,
            readCurrentAcceptance: () => { throw new Error('not contained') },
        })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        const otherCandidate = draft(source)
        const otherRequest = beginWorkOrderAcceptance(otherCandidate, now + 10)
        if (otherRequest.kind !== 'human_needed') throw new Error('request refused')
        const other = acceptWorkOrder(otherRequest.continuation, otherCandidate, {
            now: now + 11, actor: 'other-operator', answer: `accept ${otherCandidate.contract.digest}`,
        })
        if (other.kind !== 'accepted') throw new Error('acceptance refused')
        const changedRecord = createWorkOrderAcceptanceRecord(other)
        if (changedRecord.kind !== 'acceptance-record') throw new Error('record refused')
        let reads = 0
        expect(readmitWorkOrderAcceptance(original.contract, {
            storeDigest,
            readCurrentAcceptance: () => ++reads === 1 ? record : changedRecord,
        })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        expect(createWorkOrderAcceptanceRecord({ ...original })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
    })

    it('refuses accessors, cycles and a store object mutated between current reads', () => {
        const original = accept(draft(workOrderFixture().replace('id: WO-001', 'id: WO-007')))
        const record = createWorkOrderAcceptanceRecord(original)
        if (record.kind !== 'acceptance-record') throw new Error('record refused')
        let storeAccesses = 0
        const accessorStore = { readCurrentAcceptance: () => record } as { storeDigest?: string; readCurrentAcceptance: () => unknown }
        Object.defineProperty(accessorStore, 'storeDigest', { enumerable: true, get: () => { storeAccesses += 1; return storeDigest } })
        expect(readmitWorkOrderAcceptance(original.contract, accessorStore as never))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        const proxyStore = new Proxy({ storeDigest, readCurrentAcceptance: () => record }, { ownKeys: target => {
            storeAccesses += 1; return Reflect.ownKeys(target)
        } })
        expect(readmitWorkOrderAcceptance(original.contract, proxyStore)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        expect(storeAccesses).toBe(0)
        const accessor = { ...record }
        Object.defineProperty(accessor, 'acceptedBy', { enumerable: true, get: () => { throw new Error('accessed') } })
        expect(readmitWorkOrderAcceptance(original.contract, { storeDigest, readCurrentAcceptance: () => accessor }))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        const cyclic = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
        cyclic.criteria = [cyclic]
        expect(readmitWorkOrderAcceptance(original.contract, { storeDigest, readCurrentAcceptance: () => cyclic }))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        let proxyTraps = 0
        const proxy = new Proxy(record, { ownKeys: (target) => { proxyTraps += 1; return Reflect.ownKeys(target) } })
        expect(readmitWorkOrderAcceptance(original.contract, { storeDigest, readCurrentAcceptance: () => proxy }))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        expect(proxyTraps).toBe(0)
        const mutable = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
        let reads = 0
        expect(readmitWorkOrderAcceptance(original.contract, { storeDigest, readCurrentAcceptance: () => {
            if (++reads === 2) mutable.acceptedBy = 'changed-after-first-read'
            return mutable
        } })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
    })

    it('does not create a durable record from an expired prompt', () => {
        const candidate = draft()
        const request = beginWorkOrderAcceptance(candidate, now)
        if (request.kind !== 'human_needed') throw new Error('request refused')
        const expired = acceptWorkOrder(request.continuation, candidate, {
            now: now + WORK_ORDER_ACCEPTANCE_TTL_MS + 1,
            actor: 'operator', answer: `accept ${candidate.contract.digest}`,
        })
        expect(expired).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        expect(createWorkOrderAcceptanceRecord(expired as never)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
    })

    it('binds renewal records to a monotonic generation and exact predecessor', () => {
        const originalText = workOrderFixture().replace('id: WO-001', 'id: WO-002')
        const previous = accept(draft(originalText))
        const predecessor = createWorkOrderAcceptanceRecord(previous)
        if (predecessor.kind !== 'acceptance-record') throw new Error('record refused')
        const updatedText = originalText.replace('Refresh 1 completes.', 'Refresh 1 and invalidation complete.')
            + '- 2026-01-03 | Add invalidation to refresh | accepted | Reader can race the cache | Verify invalidation too.\n'
        const updated = draft(updatedText)
        const request = beginWorkOrderRenewal(previous, updated, now + 2, updated.contract.decisions[1])
        if (request.kind !== 'human_needed') throw new Error('renewal refused')
        const renewed = acceptWorkOrder(request.continuation, updated, { now: now + 3, actor: 'operator', answer: `accept ${updated.contract.digest}` })
        if (renewed.kind !== 'accepted') throw new Error('renewal failed')
        expect(createWorkOrderAcceptanceRecord(renewed)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        const inaccessible = { ...predecessor }
        Object.defineProperty(inaccessible, 'contractDigest', { enumerable: true, get: () => { throw new Error('accessed') } })
        expect(activateAcceptedWorkOrder(renewed, Buffer.from(updatedText), inaccessible))
            .toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        const activated = activateAcceptedWorkOrder(renewed, Buffer.from(updatedText), predecessor)
        expect(activated).toMatchObject({ kind: 'activated', accepted: { binding: { activation: {
            generation: 2, predecessorRecordDigest: predecessor.recordDigest,
        } } } })
        if (activated.kind !== 'activated') throw new Error('activation refused')
        expect(activated.accepted.binding.activation).not.toHaveProperty('decision')
        const current = createWorkOrderAcceptanceRecord(activated.accepted, predecessor)
        expect(current).toMatchObject({
            kind: 'acceptance-record', generation: 2, decision: updated.contract.decisions[1],
            predecessorRecordDigest: predecessor.recordDigest,
        })
        if (current.kind !== 'acceptance-record') throw new Error('renewal record refused')
        expect(current.activation).not.toHaveProperty('decision')
        expect(readmitWorkOrderAcceptance(activated.accepted.contract, { storeDigest, readCurrentAcceptance: () => ({
            ...current, activation: { ...current.activation, decision: current.decision },
        }) })).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_INVALID' })
        const wrongPredecessor: WorkOrderAcceptanceRecord = { ...predecessor, recordDigest: '0'.repeat(64) }
        expect(createWorkOrderAcceptanceRecord(activated.accepted, wrongPredecessor)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
        const currentReader = { storeDigest, readCurrentAcceptance: () => JSON.parse(JSON.stringify(current)) as unknown }
        expect(readmitWorkOrderAcceptance(activated.accepted.contract, currentReader).kind).toBe('accepted')

        const nextText = updatedText.replace('Refresh 2 completes.', 'Refresh 2 completes after invalidation.')
            + '- 2026-01-03 | Clarify refresh ordering | accepted | Ordering remained implicit | Verify ordered invalidation.\n'
        const next = draft(nextText)
        const nextRequest = beginWorkOrderRenewal(activated.accepted, next, now + 4, next.contract.decisions[2])
        if (nextRequest.kind !== 'human_needed') throw new Error('second renewal refused')
        const nextRenewed = acceptWorkOrder(nextRequest.continuation, next, {
            now: now + 5, actor: 'operator', answer: `accept ${next.contract.digest}`,
        })
        if (nextRenewed.kind !== 'accepted') throw new Error('second renewal failed')
        const nextActivated = activateAcceptedWorkOrder(nextRenewed, Buffer.from(nextText), current)
        if (nextActivated.kind !== 'activated') throw new Error('second activation refused')
        const nextRecord = createWorkOrderAcceptanceRecord(nextActivated.accepted, current)
        expect(nextRecord).toMatchObject({
            kind: 'acceptance-record', generation: 3, decision: next.contract.decisions[2],
            predecessorRecordDigest: current.recordDigest,
        })
        if (nextRecord.kind !== 'acceptance-record') throw new Error('second renewal record refused')
        expect(nextRecord.activation).not.toHaveProperty('decision')
        expect(current.decision).toEqual(updated.contract.decisions[1])
        expect(readmitWorkOrderAcceptance(nextActivated.accepted.contract, {
            storeDigest,
            readCurrentAcceptance: () => JSON.parse(JSON.stringify(nextRecord)) as unknown,
        }).kind).toBe('accepted')
        const oldReader = { storeDigest, readCurrentAcceptance: () => JSON.parse(JSON.stringify(predecessor)) as unknown }
        expect(readmitWorkOrderAcceptance(previous.contract, oldReader)).toMatchObject({ kind: 'refusal', code: 'WO_ACCEPTANCE_STALE' })
    })
})

it('issues lowerable attempt caps while retaining default two', () => {
    expect(validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })).toMatchObject({ kind: 'policy', policy: { attemptCap: 2 } })
    for (const attemptCap of [1, 2]) expect(validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1, attemptCap })).toMatchObject({ kind: 'policy', policy: { attemptCap } })
    expect(validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1, attemptCap: 3 })).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
})

it('authenticates the issued policy identity rather than its copied fields', () => {
    const issued = policy()
    expect(isValidatedWorkOrderPolicy(issued)).toBe(true)
    expect(isValidatedWorkOrderPolicy({ ...issued })).toBe(false)
    expect(routeWorkOrder({ certification: true }, { policy: { ...issued }, orders: [] })).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
})
