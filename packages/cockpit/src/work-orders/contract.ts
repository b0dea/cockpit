import { createHash } from 'node:crypto'

export const mechanism = {
    id: 'work-order-contract',
    module: 'packages/cockpit/src/work-orders/contract.ts',
    exports: ['WORK_ORDER_FINDING_CODES', 'WORK_ORDER_LIMITS', 'WORK_ORDER_SECTIONS', 'WORK_ORDER_STATUSES', 'isParsedWorkOrder', 'parseWorkOrder'],
} as const

// A small executable document fits in 64 KiB; independent structural caps prevent
// a single dense line or thousands of tiny records from consuming that whole budget.
export const WORK_ORDER_LIMITS = Object.freeze({
    bytes: 65_536, lines: 2_048, lineBytes: 4_096, keys: 5, sections: 10,
    criteriaMin: 3, criteriaMax: 7, sources: 32, authority: 64,
    commands: 14, commandBytes: 2_048, arguments: 32, planSteps: 64, decisions: 32,
})
export const WORK_ORDER_STATUSES = Object.freeze(['draft', 'ready', 'active', 'blocked', 'completed', 'parked', 'cancelled'] as const)
export type WorkOrderStatus = typeof WORK_ORDER_STATUSES[number]
export const WORK_ORDER_SECTIONS = Object.freeze([
    'Objective', 'Non-goals', 'Context and sources', 'Authority', 'Acceptance criteria',
    'Verification', 'Docs impact', 'Plan', 'Evidence', 'Decisions',
] as const)
export const WORK_ORDER_FINDING_CODES = Object.freeze([
    'WO_SIZE_LIMIT', 'WO_ENCODING_INVALID', 'WO_LINE_LIMIT', 'WO_LINE_BYTES_LIMIT',
    'WO_FRONTMATTER_INVALID', 'WO_KEY_DUPLICATE', 'WO_KEY_UNKNOWN', 'WO_FIELD_INVALID',
    'WO_SECTION_INVALID', 'WO_SECTION_DUPLICATE', 'WO_SECTION_MISSING', 'WO_SOURCE_INVALID',
    'WO_AUTHORITY_INVALID', 'WO_CRITERIA_INVALID', 'WO_VERIFICATION_INVALID', 'WO_PLAN_INVALID',
    'WO_EVIDENCE_INVALID', 'WO_DECISION_INVALID', 'WO_CONTRADICTION',
] as const)
export type WorkOrderFindingCode = typeof WORK_ORDER_FINDING_CODES[number]
export interface WorkOrderFinding {
    readonly code: WorkOrderFindingCode
    readonly target: string
    readonly message: string
}
export type SourceProvenance = 'read' | 'inferred' | 'operator-confirmed'
export interface WorkOrderSource {
    readonly id: string
    readonly provenance: SourceProvenance
    readonly reference: string
    readonly reason: string
}
export interface WorkOrderCriterion {
    readonly id: string
    readonly source: string
    readonly given: string
    readonly when: string
    readonly then: string
}
export interface WorkOrderDecision {
    readonly date: string
    readonly decision: string
    readonly disposition: 'accepted' | 'rejected' | 'deferred'
    readonly reason: string
    readonly impact: string
}
export interface ParsedWorkOrder {
    readonly digest: string
    readonly frontmatter: Readonly<{ id: string; title: string; status: WorkOrderStatus; created: string; programme?: string }>
    readonly objective: string
    readonly nonGoals: string
    readonly sources: readonly WorkOrderSource[]
    readonly authority: readonly string[]
    readonly criteria: readonly WorkOrderCriterion[]
    readonly verification: readonly Readonly<{ criterion: string; argv: readonly string[] }>[]
    readonly docsImpact: string
    readonly plan: readonly Readonly<{ checked: boolean; text: string }>[]
    readonly evidence: readonly Readonly<{ layer: 'source' | 'local' | 'ci' | 'runtime' | 'deployment'; reference: string; description: string }>[]
    readonly decisions: readonly WorkOrderDecision[]
}
export type WorkOrderParseResult =
    | { readonly ok: true; readonly exitCode: 0; readonly findings: readonly WorkOrderFinding[]; readonly value: ParsedWorkOrder }
    | { readonly ok: false; readonly exitCode: 1; readonly findings: readonly WorkOrderFinding[] }

const issuedContracts = new WeakSet<object>()
export function isParsedWorkOrder(value: unknown): value is ParsedWorkOrder {
    return typeof value === 'object' && value !== null && issuedContracts.has(value)
}

function canonicalDate(value: string): boolean {
    const time = Date.parse(value)
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}
function row(line: string, count: number): string[] | undefined {
    if (!line.startsWith('- ')) return undefined
    const fields = line.slice(2).split(' | ').map((field) => field.trim())
    return fields.length === count && fields.every((field) => field.length > 0 && !field.includes('|')) ? fields : undefined
}
function exactPath(value: string): boolean {
    return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('/') && !value.endsWith('/')
        && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function parseWorkOrder(input: Uint8Array): WorkOrderParseResult {
    const findings: WorkOrderFinding[] = []
    const add = (code: WorkOrderFindingCode, target: string, message: string) => {
        if (!findings.some((finding) => finding.code === code && finding.target === target)) findings.push(Object.freeze({ code, target, message }))
    }
    const refused = (): WorkOrderParseResult => Object.freeze({ ok: false, exitCode: 1, findings: Object.freeze(findings) })
    if (input.byteLength > WORK_ORDER_LIMITS.bytes) {
        add('WO_SIZE_LIMIT', 'contract', `Work-order exceeds ${WORK_ORDER_LIMITS.bytes} bytes`)
        return refused()
    }
    const bytes = Buffer.from(input)
    let text: string
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch { // Fatal decoding throws only for invalid UTF-8, which the finding names.
        add('WO_ENCODING_INVALID', 'contract', 'Work-order must be valid UTF-8')
        return refused()
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    if (lines.length > WORK_ORDER_LIMITS.lines) {
        add('WO_LINE_LIMIT', 'contract', `Work-order exceeds ${WORK_ORDER_LIMITS.lines} lines`)
        return refused()
    }
    if (lines.some((line) => Buffer.byteLength(line) > WORK_ORDER_LIMITS.lineBytes)) {
        add('WO_LINE_BYTES_LIMIT', 'contract', `A line exceeds ${WORK_ORDER_LIMITS.lineBytes} bytes`)
        return refused()
    }
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text.replace(/\r\n/g, '\n'))) {
        add('WO_ENCODING_INVALID', 'contract', 'Work-order contains unsupported control characters')
        return refused()
    }
    const end = lines.indexOf('---', 1)
    if (lines[0] !== '---' || end < 0) {
        add('WO_FRONTMATTER_INVALID', 'frontmatter', 'Work-order requires opening and closing --- delimiters')
        return refused()
    }
    const fields = new Map<string, string>()
    let keyCount = 0
    for (const line of lines.slice(1, end)) {
        if (line.trim() === '') continue
        keyCount += 1
        const match = /^([a-z_]+): (\S.*)$/.exec(line)
        if (!match) {
            add('WO_FRONTMATTER_INVALID', 'frontmatter', 'Frontmatter uses one plain key: value per line')
            continue
        }
        const [, key, value] = match
        if (!['id', 'title', 'status', 'created', 'programme'].includes(key)) add('WO_KEY_UNKNOWN', key, 'Unknown frontmatter key')
        if (fields.has(key)) add('WO_KEY_DUPLICATE', key, 'Duplicate frontmatter key')
        else fields.set(key, value.trim())
    }
    if (keyCount > WORK_ORDER_LIMITS.keys) add('WO_FRONTMATTER_INVALID', 'frontmatter', `Frontmatter exceeds ${WORK_ORDER_LIMITS.keys} keys`)
    const id = fields.get('id') ?? ''
    const title = fields.get('title') ?? ''
    const status = WORK_ORDER_STATUSES.find((candidate) => candidate === fields.get('status'))
    const created = fields.get('created') ?? ''
    const programme = fields.get('programme')
    if (!/^WO-[0-9]{3,}$/.test(id)) add('WO_FIELD_INVALID', 'id', 'id must be WO- followed by at least three digits')
    if (!title) add('WO_FIELD_INVALID', 'title', 'title is required')
    if (!status) add('WO_FIELD_INVALID', 'status', 'status must be a canonical work-order status')
    if (!canonicalDate(created)) add('WO_FIELD_INVALID', 'created', 'created must be a real YYYY-MM-DD date')
    if (programme !== undefined && !/^[a-z][a-z0-9-]*$/.test(programme)) add('WO_FIELD_INVALID', 'programme', 'programme must be a lowercase slug')

    const sections = new Map<string, string[]>()
    let current: string | undefined
    for (const raw of lines.slice(end + 1)) {
        const line = raw.trimEnd()
        if (line.startsWith('## ')) {
            current = line.slice(3)
            if (!WORK_ORDER_SECTIONS.some((name) => name === current)) add('WO_SECTION_INVALID', 'sections', 'Only canonical section headings are supported')
            if (sections.has(current)) add('WO_SECTION_DUPLICATE', current, 'Duplicate section heading')
            else sections.set(current, [])
        } else if (line.trim() !== '') {
            if (current === undefined) add('WO_SECTION_INVALID', 'sections', 'Content must belong to a canonical section')
            else sections.get(current)?.push(line)
        }
    }
    for (const name of WORK_ORDER_SECTIONS) if (!sections.has(name)) add('WO_SECTION_MISSING', name, 'Required section is missing')
    if (sections.size > WORK_ORDER_LIMITS.sections) add('WO_SECTION_INVALID', 'sections', `Work-order exceeds ${WORK_ORDER_LIMITS.sections} sections`)
    const body = (name: string) => sections.get(name) ?? []
    for (const [name, content] of sections) {
        if (content.some((line) => /^#{1,6}(?:\s|$)/.test(line) && !(name === 'Acceptance criteria' && /^### AC[1-7]$/.test(line)))) {
            add('WO_SECTION_INVALID', name, 'Unexpected nested heading')
        }
    }
    const objective = body('Objective').join('\n')
    const nonGoals = body('Non-goals').join('\n')
    const docsImpact = body('Docs impact').join('\n')
    for (const [name, value] of [['Objective', objective], ['Non-goals', nonGoals]]) {
        if (!value.trim()) add('WO_SECTION_INVALID', name, 'Section requires explicit content')
    }
    if (!/^(?:none|update): \S[^\n]*$/.test(docsImpact)) add('WO_SECTION_INVALID', 'Docs impact', 'Use none: reason or update: impact')

    const sources: WorkOrderSource[] = []
    for (const line of body('Context and sources')) {
        const parts = row(line, 4)
        const provenance = (['read', 'inferred', 'operator-confirmed'] as const).find((value) => value === parts?.[1])
        if (!parts || !/^S[1-9][0-9]*$/.test(parts[0]) || !provenance || sources.some((source) => source.id === parts[0])) {
            add('WO_SOURCE_INVALID', 'Context and sources', 'Sources require unique S identifiers, provenance, reference and reason')
        } else sources.push(Object.freeze({ id: parts[0], provenance, reference: parts[2], reason: parts[3] }))
    }
    if (sources.length === 0 || sources.length > WORK_ORDER_LIMITS.sources) add('WO_SOURCE_INVALID', 'Context and sources', `Require one to ${WORK_ORDER_LIMITS.sources} material sources`)
    const authority: string[] = []
    for (const line of body('Authority')) {
        const path = line.startsWith('- ') ? line.slice(2) : ''
        if (!exactPath(path) || authority.includes(path)) add('WO_AUTHORITY_INVALID', 'Authority', 'Authority requires unique exact relative file paths without traversal or globs')
        else authority.push(path)
    }
    if (!authority.length || authority.length > WORK_ORDER_LIMITS.authority) add('WO_AUTHORITY_INVALID', 'Authority', `Require one to ${WORK_ORDER_LIMITS.authority} exact files`)

    const criteria: WorkOrderCriterion[] = []
    const criterionLines = body('Acceptance criteria')
    for (let index = 0; index < criterionLines.length; index += 5) {
        const [heading, sourceLine, givenLine, whenLine, thenLine] = criterionLines.slice(index, index + 5)
        const source = sourceLine?.match(/^Source: (S[1-9][0-9]*)$/)?.[1]
        const given = givenLine?.match(/^Given: (\S.*)$/)?.[1]
        const when = whenLine?.match(/^When: (\S.*)$/)?.[1]
        const then = thenLine?.match(/^Then: (\S.*)$/)?.[1]
        if (heading !== `### AC${index / 5 + 1}` || !source || !sources.some((item) => item.id === source) || !given || !when || !then) {
            add('WO_CRITERIA_INVALID', 'Acceptance criteria', 'Criteria require ordered AC identifiers, a known source and explicit Given/When/Then')
        } else criteria.push(Object.freeze({ id: `AC${index / 5 + 1}`, source, given, when, then }))
    }
    if (criteria.length < WORK_ORDER_LIMITS.criteriaMin || criteria.length > WORK_ORDER_LIMITS.criteriaMax) {
        add('WO_CRITERIA_INVALID', 'Acceptance criteria', 'Require three to seven sourced binary Given/When/Then criteria')
    }

    const verification: { criterion: string; argv: readonly string[] }[] = []
    for (const line of body('Verification')) {
        const match = /^- (AC[1-7]) \| (\[.*\])$/.exec(line)
        let argv: unknown
        if (match) {
            try { argv = JSON.parse(match[2]) } catch { // Parser text would quote the contract; the finding names the expected shape.
                add('WO_VERIFICATION_INVALID', 'Verification', 'Verification argv must be a valid JSON array')
            }
        }
        if (!match || !criteria.some((criterion) => criterion.id === match[1])
            || !Array.isArray(argv) || !argv.length || argv.length > WORK_ORDER_LIMITS.arguments
            || argv.some((argument: unknown) => typeof argument !== 'string' || !argument.trim() || /[\x00-\x1f\x7f]/.test(argument))
            || Buffer.byteLength(match[2]) > WORK_ORDER_LIMITS.commandBytes) {
            add('WO_VERIFICATION_INVALID', 'Verification', 'Verification requires known AC identifiers and bounded nonempty argv arrays')
        } else verification.push(Object.freeze({ criterion: match[1], argv: Object.freeze(argv) }))
    }
    if (verification.length > WORK_ORDER_LIMITS.commands || criteria.some((criterion) => !verification.some((command) => command.criterion === criterion.id))) {
        add('WO_VERIFICATION_INVALID', 'Verification', `Every criterion needs runnable verification within ${WORK_ORDER_LIMITS.commands} commands`)
    }
    const plan: { checked: boolean; text: string }[] = []
    for (const [index, line] of body('Plan').entries()) {
        const match = /^(\d+)\. \[([ x])\] (\S.*)$/.exec(line)
        if (!match || match[1] !== String(index + 1)) add('WO_PLAN_INVALID', 'Plan', 'Plan requires sequential numbered checkboxes')
        else plan.push(Object.freeze({ checked: match[2] === 'x', text: match[3] }))
    }
    if (!plan.length || plan.length > WORK_ORDER_LIMITS.planSteps) add('WO_PLAN_INVALID', 'Plan', `Require one to ${WORK_ORDER_LIMITS.planSteps} ordered steps`)
    const evidence: ParsedWorkOrder['evidence'][number][] = []
    const evidenceLines = body('Evidence')
    if (evidenceLines.length !== 1 || evidenceLines[0] !== '- none') {
        if (!evidenceLines.length) add('WO_EVIDENCE_INVALID', 'Evidence', 'Record layered evidence or explicit - none')
        for (const line of evidenceLines) {
            const parts = row(line, 3)
            const layer = (['source', 'local', 'ci', 'runtime', 'deployment'] as const).find((value) => value === parts?.[0])
            if (!parts || !layer) add('WO_EVIDENCE_INVALID', 'Evidence', 'Evidence requires a layer, reference and description')
            else evidence.push(Object.freeze({ layer, reference: parts[1], description: parts[2] }))
        }
    }
    const decisions: WorkOrderDecision[] = []
    const decisionLines = body('Decisions')
    if (decisionLines.length !== 1 || decisionLines[0] !== '- none') {
        if (!decisionLines.length) add('WO_DECISION_INVALID', 'Decisions', 'Record dated decisions or explicit - none')
        for (const line of decisionLines) {
            const parts = row(line, 5)
            const disposition = (['accepted', 'rejected', 'deferred'] as const).find((value) => value === parts?.[2])
            if (!parts || !canonicalDate(parts[0]) || parts[0] < created || !disposition || decisions.some((decision) => decision.decision === parts[1])) {
                add('WO_DECISION_INVALID', 'Decisions', 'Decisions require a real date, unique subject, disposition, reason and impact')
            } else decisions.push(Object.freeze({ date: parts[0], decision: parts[1], disposition, reason: parts[3], impact: parts[4] }))
        }
    }
    if (decisions.length > WORK_ORDER_LIMITS.decisions) add('WO_DECISION_INVALID', 'Decisions', `Decisions exceed ${WORK_ORDER_LIMITS.decisions} entries`)
    if (status === 'completed' && (plan.some((step) => !step.checked) || evidence.length === 0)) {
        add('WO_CONTRADICTION', 'status', 'Completed orders require checked Plan and recorded evidence; grading remains a separate completion gate')
    }
    if (findings.length || !status) return refused()
    const value: ParsedWorkOrder = Object.freeze({
        digest: createHash('sha256').update(bytes).digest('hex'),
        frontmatter: Object.freeze({ id, title, status, created, ...(programme === undefined ? {} : { programme }) }),
        objective, nonGoals, docsImpact, sources: Object.freeze(sources), authority: Object.freeze(authority),
        criteria: Object.freeze(criteria), verification: Object.freeze(verification), plan: Object.freeze(plan),
        evidence: Object.freeze(evidence), decisions: Object.freeze(decisions),
    })
    issuedContracts.add(value)
    return Object.freeze({ ok: true, exitCode: 0, findings: Object.freeze([]), value })
}
