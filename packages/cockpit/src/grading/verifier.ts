import { createHash, randomUUID } from 'node:crypto'
import { isParsedWorkOrder, type ParsedWorkOrder, type WorkOrderCriterion } from '../work-orders/contract.js'
import { isCurrentWorkOrderAcceptance, type AcceptedWorkOrder } from '../work-orders/intake.js'

export const mechanism = {
    id: 'work-order-verification',
    module: 'packages/cockpit/src/grading/verifier.ts',
    exports: ['CRITERION_OUTCOMES', 'checkGradeCurrency', 'checkPreparedWorkOrderCurrency', 'normalizeVerificationObservation', 'prepareWorkOrderVerification', 'verificationObservationPassed', 'verifyPreparedWorkOrder', 'verifyWorkOrder'],
} as const

export const CRITERION_OUTCOMES = Object.freeze([
    'passed with current supporting evidence',
    'appears passed but evidence is insufficient or suspicious',
    'failed after execution',
    'never ran',
] as const)
export type CriterionOutcome = typeof CRITERION_OUTCOMES[number]
export type VerificationObservation =
    | Readonly<{ kind: 'executed'; exitCode: number; stdout: string; stderr: string; truncated: boolean }>
    | Readonly<{ kind: 'error' | 'unavailable'; reason: string }>
export interface ArtifactEvidence {
    readonly path: string
    readonly digest: string
    readonly start: number
    readonly end: number
    readonly quote: string
    readonly symbol?: string
}
export interface CriterionAssessment {
    readonly criterion: string
    readonly criterionDigest: string
    readonly outcome: CriterionOutcome
    readonly verificationDigests: readonly string[]
    readonly verificationEvidence: readonly Readonly<{ digest: string; stream: 'stdout' | 'stderr'; start: number; end: number; quote: string }>[]
    readonly evidence: readonly ArtifactEvidence[]
    readonly observation: string
    readonly alternative: string
}
export type GraderResponse =
    | Readonly<{ kind: 'assessment'; runId: string; grader: string; integrity: 'clean' | 'contaminated'; criteria: readonly CriterionAssessment[] }>
    | Readonly<{ kind: 'error' | 'abstained' | 'never-ran'; reason: string }>
export interface GradingInput {
    readonly accepted: AcceptedWorkOrder
    readonly author: string
    readonly grader: string
}
export interface GradingArtifact { readonly path: string; readonly digest: string; readonly text: string }
export interface PreparedWorkOrderVerification {
    readonly workOrderId: string
    readonly contractDigest: string
    readonly artifactDigest: string
    readonly author: string
    readonly grader: string
    readonly contract: ParsedWorkOrder
    readonly artifacts: readonly GradingArtifact[]
    readonly verification: ParsedWorkOrder['verification']
}
export interface VerificationRecord {
    readonly criterion: string
    readonly argv: readonly string[]
    readonly result: VerificationObservation
    readonly digest: string
}
export interface GraderContext {
    readonly runId: string
    readonly contract: ParsedWorkOrder
    readonly artifactDigest: string
    readonly artifacts: readonly GradingArtifact[]
    readonly criteria: readonly Readonly<{ criterion: WorkOrderCriterion; digest: string }>[]
    readonly verification: readonly VerificationRecord[]
}
export interface WorkOrderSubjectDependencies {
    readonly readWorkOrder: () => Promise<ParsedWorkOrder>
    readonly readArtifact: (path: string) => Promise<Uint8Array>
}
export interface GradingDependencies extends WorkOrderSubjectDependencies {
    readonly runVerification: (argv: readonly string[]) => Promise<VerificationObservation>
    readonly grade: (context: GraderContext) => Promise<GraderResponse>
}
export interface CriterionGrade {
    readonly criterion: string
    readonly outcome: CriterionOutcome
    readonly reasons: readonly string[]
    readonly assessment?: CriterionAssessment
}
export interface WorkOrderGrade {
    readonly workOrderId: string
    readonly contractDigest: string
    readonly artifactDigest: string
    readonly runId: string
    readonly author: string
    readonly grader: string
    readonly criteria: readonly CriterionGrade[]
    readonly verification: readonly VerificationRecord[]
}

const issuedGrades = new WeakMap<WorkOrderGrade, { input: GradingInput; context: GraderContext }>()
const issuedSubjects = new WeakMap<PreparedWorkOrderVerification, { input: GradingInput; observed: Awaited<ReturnType<typeof observeSubject>> }>()
const MAX_ARTIFACT_BYTES = 1_048_576
const MAX_OUTPUT_BYTES = 65_536

function gradingDigest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function immutable<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) immutable(child)
        Object.freeze(value)
    }
    return value
}

function text(value: unknown, maximum = MAX_OUTPUT_BYTES): value is string {
    return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= maximum
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function observeSubject(input: GradingInput, dependencies: WorkOrderSubjectDependencies) {
    const contract = await dependencies.readWorkOrder()
    if (!isParsedWorkOrder(contract) || !isCurrentWorkOrderAcceptance(input.accepted, contract)) {
        throw new Error('Current work-order does not match its issued operator acceptance')
    }
    const artifacts: GradingArtifact[] = []
    let totalBytes = 0
    for (const path of contract.authority) {
        const bytes = await dependencies.readArtifact(path)
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`Artifact ${path} is unreadable or exceeds ${MAX_ARTIFACT_BYTES} bytes`)
        totalBytes += bytes.byteLength
        if (totalBytes > 8 * MAX_ARTIFACT_BYTES) throw new Error('Authority artifacts exceed the 8 MiB grading budget')
        const captured = Buffer.from(bytes)
        artifacts.push({ path, digest: createHash('sha256').update(captured).digest('hex'), text: new TextDecoder('utf-8', { fatal: true }).decode(captured) })
    }
    const artifactDigest = gradingDigest(artifacts.map(({ path, digest }) => ({ path, digest })))
    return immutable({ contract, artifacts, artifactDigest })
}

export function normalizeVerificationObservation(result: VerificationObservation): VerificationObservation {
    if (result?.kind === 'executed' && Number.isInteger(result.exitCode)
        && typeof result.stdout === 'string' && typeof result.stderr === 'string' && typeof result.truncated === 'boolean') {
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) return { kind: 'error', reason: 'Verification output exceeded the bounded capture' }
        return immutable({ kind: 'executed', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated })
    }
    if ((result?.kind === 'error' || result?.kind === 'unavailable') && text(result.reason)) return immutable({ kind: result.kind, reason: result.reason })
    return { kind: 'error', reason: 'Verification adapter returned a malformed observation' }
}

export function verificationObservationPassed(result: VerificationObservation): boolean {
    const observation = normalizeVerificationObservation(result)
    return observation.kind === 'executed' && observation.exitCode === 0 && observation.truncated === false
        && `${observation.stdout}${observation.stderr}`.trim().length > 0
}

// Restrict symbol evidence to named declaration headers. Literal/comment masking
// prevents a nearby mention from acquiring the authority of a declaration.
function declarationContains(body: string, symbol: string, start: number, end: number): boolean {
    if (!/^[$A-Z_a-z][$\w]*$/.test(symbol)) return false
    let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
    let masked = ''
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index]
        const next = body[index + 1]
        if (mode === 'code') {
            if (char === '/' && (next === '/' || next === '*')) {
                mode = next === '/' ? 'line' : 'block'
                masked += '  '
                index += 1
            } else if (char === "'" || char === '"' || char === '`') {
                mode = char === "'" ? 'single' : char === '"' ? 'double' : 'template'
                masked += ' '
            } else masked += char
        } else if (mode === 'line' && char === '\n') {
            mode = 'code'
            masked += '\n'
        } else if (mode === 'block' && char === '*' && next === '/') {
            mode = 'code'
            masked += '  '
            index += 1
        } else if (mode !== 'line' && mode !== 'block' && char === '\\') {
            masked += ' ' + (next === '\n' ? '\n' : ' ')
            index += 1
        } else {
            if (mode === 'single' && char === "'" || mode === 'double' && char === '"' || mode === 'template' && char === '`') mode = 'code'
            masked += char === '\n' ? '\n' : ' '
        }
    }
    const declarations = /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:async[ \t]+)?(?:function\*?|class|interface|type|enum|const|let|var)[ \t]+([$A-Z_a-z][$\w]*)\b/gm
    for (const match of masked.matchAll(declarations)) {
        if (match[1] !== symbol) continue
        const nameStart = match.index + match[0].lastIndexOf(symbol)
        if (start <= nameStart && end >= nameStart + symbol.length) return true
    }
    return false
}

function supportingEvidence(assessment: CriterionAssessment, context: GraderContext): boolean {
    if (!Array.isArray(assessment.evidence) || !assessment.evidence.length || assessment.evidence.length > context.contract.authority.length) return false
    return assessment.evidence.every(evidence => {
        if (!evidence || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end)
            || evidence.start < 0 || evidence.end <= evidence.start || !text(evidence.quote)) return false
        const artifact = context.artifacts.find(item => item.path === evidence.path)
        return artifact !== undefined && artifact.digest === evidence.digest && evidence.end <= artifact.text.length
            && artifact.text.slice(evidence.start, evidence.end) === evidence.quote
            && (evidence.symbol === undefined || typeof evidence.symbol === 'string'
                && declarationContains(artifact.text, evidence.symbol, evidence.start, evidence.end))
    })
}

function supportingVerification(assessment: CriterionAssessment, records: readonly VerificationRecord[]): boolean {
    if (!Array.isArray(assessment.verificationEvidence) || assessment.verificationEvidence.length !== records.length) return false
    return assessment.verificationEvidence.every((evidence, index) => {
        const record = records[index]
        if (!evidence || evidence.digest !== record.digest || record.result.kind !== 'executed'
            || evidence.stream !== 'stdout' && evidence.stream !== 'stderr'
            || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end)
            || evidence.start < 0 || evidence.end <= evidence.start || !text(evidence.quote)) return false
        const output = evidence.stream === 'stdout' ? record.result.stdout : record.result.stderr
        return evidence.end <= output.length && output.slice(evidence.start, evidence.end) === evidence.quote
    })
}

function gradeCriterion(criterion: WorkOrderCriterion, response: GraderResponse, context: GraderContext): CriterionGrade {
    const outcome = (index: 1 | 2 | 3, reason: string): CriterionGrade => ({ criterion: criterion.id, outcome: CRITERION_OUTCOMES[index], reasons: [reason] })
    const records = context.verification.filter(record => record.criterion === criterion.id)
    const failed = records.find(record => record.result.kind === 'executed' && record.result.exitCode !== 0)
    if (failed) return outcome(2, `Declared verification failed: ${JSON.stringify(failed.argv)}`)
    const unavailable = records.find(record => record.result.kind !== 'executed')
    if (unavailable) return outcome(3, unavailable.result.kind === 'executed' ? 'Verification did not run' : unavailable.result.reason)
    if (records.some(record => record.result.kind === 'executed' && (record.result.truncated || !(record.result.stdout + record.result.stderr).trim()))) {
        return outcome(1, 'Verification output is truncated or silent')
    }
    if (response?.kind !== 'assessment') return outcome(response?.kind === 'never-ran' ? 3 : 1, `Independent grader ${response?.kind ?? 'returned malformed evidence'}: ${response?.reason ?? 'no reason supplied'}`)
    const assessments = response.criteria
    if (response.runId !== context.runId || response.integrity !== 'clean' || !Array.isArray(assessments)
        || assessments.length !== context.criteria.length || new Set(assessments.map(item => item?.criterion)).size !== context.criteria.length
        || assessments.some(item => !item || !context.criteria.some(current => current.criterion.id === item.criterion))) {
        return outcome(1, 'Independent assessment identity, integrity or criterion coverage is invalid')
    }
    const assessment = assessments.find(item => item.criterion === criterion.id)
    if (!assessment || !CRITERION_OUTCOMES.includes(assessment.outcome)) return outcome(1, 'Independent grader returned an invalid criterion outcome')
    if (assessment.outcome !== CRITERION_OUTCOMES[0]) return { criterion: criterion.id, outcome: assessment.outcome, reasons: [assessment.observation || 'Independent grader did not establish support'] }
    const expected = context.criteria.find(item => item.criterion.id === criterion.id)!
    if (assessment.criterionDigest !== expected.digest || !Array.isArray(assessment.verificationDigests)
        || gradingDigest(assessment.verificationDigests) !== gradingDigest(records.map(record => record.digest))
        || !text(assessment.observation) || !text(assessment.alternative)
        || !supportingVerification(assessment, records) || !supportingEvidence(assessment, context)) {
        return outcome(1, 'Evidence does not support the current criterion, artifact declaration or rerun verification')
    }
    return { criterion: criterion.id, outcome: CRITERION_OUTCOMES[0], reasons: [], assessment: structuredClone(assessment) }
}

function refusedGrade(input: GradingInput, artifactDigest: string, runId: string, reason: string): WorkOrderGrade {
    const contract = input.accepted.contract
    return immutable({ workOrderId: contract.frontmatter.id, contractDigest: contract.digest,
        artifactDigest, runId, author: input.author, grader: input.grader, verification: [],
        criteria: contract.criteria.map(criterion => ({ criterion: criterion.id, outcome: CRITERION_OUTCOMES[1], reasons: [reason] })) })
}

export async function prepareWorkOrderVerification(input: GradingInput, dependencies: WorkOrderSubjectDependencies): Promise<PreparedWorkOrderVerification> {
    input = Object.freeze({ ...input })
    if (!isParsedWorkOrder(input.accepted.contract) || !text(input.author, 256) || !text(input.grader, 256) || input.author === input.grader) {
        throw new Error('Grading requires an issued contract and independent named author and grader')
    }
    const observed = await observeSubject(input, dependencies)
    const subject: PreparedWorkOrderVerification = immutable({
        workOrderId: observed.contract.frontmatter.id,
        contractDigest: observed.contract.digest,
        artifactDigest: observed.artifactDigest,
        author: input.author,
        grader: input.grader,
        contract: observed.contract,
        artifacts: observed.artifacts,
        verification: observed.contract.verification,
    })
    issuedSubjects.set(subject, { input, observed })
    return subject
}

export async function checkPreparedWorkOrderCurrency(subject: PreparedWorkOrderVerification, dependencies: WorkOrderSubjectDependencies): Promise<string | undefined> {
    const issued = issuedSubjects.get(subject)
    if (!issued) return 'Verification subject is not an issued current subject'
    try {
        const current = await observeSubject(issued.input, dependencies)
        if (current.contract.digest !== issued.observed.contract.digest || current.artifactDigest !== issued.observed.artifactDigest) {
            return 'Current artifact or accepted criterion changed after verification preparation'
        }
        return undefined
    } catch (error) {
        return `Verification subject currency check failed: ${errorMessage(error)}`
    }
}

export async function verifyPreparedWorkOrder(subject: PreparedWorkOrderVerification, dependencies: GradingDependencies): Promise<WorkOrderGrade> {
    const runId = randomUUID()
    const issued = issuedSubjects.get(subject)
    const contract = subject.contract
    const verification: VerificationRecord[] = []
    let artifactDigest = subject.artifactDigest
    const refused = (reason: string): WorkOrderGrade => immutable({ workOrderId: contract.frontmatter.id, contractDigest: contract.digest,
        artifactDigest, runId, author: subject.author, grader: subject.grader, verification,
        criteria: contract.criteria.map(criterion => ({ criterion: criterion.id, outcome: CRITERION_OUTCOMES[1], reasons: [reason] })) })
    if (!issued) return refused('Verification subject is not an issued current subject')
    try {
        const current = await observeSubject(issued.input, dependencies)
        if (current.contract.digest !== issued.observed.contract.digest || current.artifactDigest !== issued.observed.artifactDigest) {
            return refused('Current artifact or accepted criterion changed before final verification')
        }
        artifactDigest = current.artifactDigest
        // Declared commands can share state, so preserve their contract order.
        for (const command of current.contract.verification) {
            let result: VerificationObservation
            try { result = normalizeVerificationObservation(await dependencies.runVerification(command.argv)) }
            catch (error) { result = { kind: 'error', reason: `Verification execution failed: ${errorMessage(error)}` } }
            verification.push(immutable({ ...command, result, digest: gradingDigest({ runId, ...command, result }) }))
        }
        const verified = await observeSubject(issued.input, dependencies)
        if (verified.contract.digest !== issued.observed.contract.digest || verified.artifactDigest !== issued.observed.artifactDigest) {
            return refused('Current artifact or accepted criterion changed during final verification')
        }
        const context: GraderContext = immutable({ ...current, runId, verification,
            criteria: current.contract.criteria.map(criterion => ({ criterion, digest: gradingDigest({ criterion, source: current.contract.sources.find(source => source.id === criterion.source) }) })) })
        let response: GraderResponse
        try { response = await dependencies.grade(context) }
        catch (error) { response = { kind: 'error', reason: `Independent grading failed: ${errorMessage(error)}` } }
        if (response?.kind === 'assessment' && response.grader !== subject.grader) return refused('Independent grader identity differs from the authenticated launch')
        const after = await observeSubject(issued.input, dependencies)
        if (after.artifactDigest !== context.artifactDigest || after.contract.digest !== context.contract.digest) return refused('Current artifact or criterion changed during grading')
        const grade: WorkOrderGrade = immutable({ workOrderId: contract.frontmatter.id, contractDigest: contract.digest,
            artifactDigest: context.artifactDigest, runId, author: subject.author, grader: subject.grader,
            verification, criteria: context.contract.criteria.map(criterion => gradeCriterion(criterion, response, context)) })
        issuedGrades.set(grade, { input: issued.input, context })
        return grade
    } catch (error) {
        return refused(`Current grading evidence could not be established: ${errorMessage(error)}`)
    }
}

export async function verifyWorkOrder(input: GradingInput, dependencies: GradingDependencies): Promise<WorkOrderGrade> {
    const runId = randomUUID()
    try {
        return await verifyPreparedWorkOrder(await prepareWorkOrderVerification(input, dependencies), dependencies)
    } catch (error) {
        return refusedGrade(input, '', runId, `Current grading evidence could not be established: ${errorMessage(error)}`)
    }
}

export async function checkGradeCurrency(grade: WorkOrderGrade, dependencies: GradingDependencies): Promise<string | undefined> {
    const issued = issuedGrades.get(grade)
    if (!issued || !grade.criteria.length || grade.criteria.some(criterion => criterion.outcome !== CRITERION_OUTCOMES[0])) return 'Grade is not an issued strict success'
    try {
        const current = await observeSubject(issued.input, dependencies)
        if (current.contract.digest !== issued.context.contract.digest || current.artifactDigest !== issued.context.artifactDigest) return 'Current artifact or accepted criterion changed after grading'
        return undefined
    } catch (error) {
        return `Grade currency check failed: ${errorMessage(error)}`
    }
}
