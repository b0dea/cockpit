import { randomUUID } from 'node:crypto'
import { initCommand } from '../fix-catalogue.js'
import { canonicalJson } from '../canonical-json.js'
import type { SurfaceTarget } from '../surfaces/contract.js'
import {
    runInitApplication,
    unsupportedInitPlatformOutcome,
    type CockpitRootQuestion,
    type InitApplicationInput,
    type InitApplicationOutcome,
} from '../environment/init-application.js'
import { refusalOutcome as refusal } from '../refusal.js'

interface InitCommandInput {
    readonly root: string
    readonly target: SurfaceTarget
    /** Every chosen tool, target first; just the target when only one was given. */
    readonly tools?: readonly SurfaceTarget[]
    readonly registry?: string
    readonly sessionId?: string
    readonly platform?: 'darwin' | 'linux'
    readonly home?: string
    readonly xdgStateHome?: string
    readonly resetAnswer?: InitApplicationInput['resetAnswer']
}

/**
 * Consent and answers supplied as arguments by a caller with no terminal. The digests are the ones a
 * pending run printed, so acceptance stays bound to the exact bytes and no flag accepts blindly.
 */
export interface UnattendedInit {
    readonly previewSha256: string
    /** The parsed answers file, keyed by interview field (nested tables spell the dotted field names). */
    readonly answers: Readonly<Record<string, unknown>>
    readonly defaultsSha256?: string
}

interface InitCommandOptions {
    readonly interactive: boolean
    readonly json: boolean
    readonly unattended?: UnattendedInit
}

export interface InitCommandIo {
    readonly terminal: boolean
    readonly confirm: (preview: NonNullable<InitApplicationOutcome['result']>) => Promise<string | undefined>
    readonly writeArtifact: (destination: string, artifact: string) => Promise<void>
    readonly answerQuestion?: (question: NonNullable<NonNullable<InitApplicationOutcome['result']>['question']>) => Promise<string | undefined>
    readonly chooseCockpitRoot?: (question: CockpitRootQuestion) => Promise<string | undefined>
    /** Creates and initialises one repository beside the product, or initialises its existing plain directory; it never creates parents. */
    readonly createCockpitRoot?: (path: string) => Promise<void>
}

type AnswerProvenance = NonNullable<InitApplicationInput['greenfieldAnswer']>['provenance']

type InitApplicationHandler = (input: InitApplicationInput) => Promise<InitApplicationOutcome>

// Real interviews ask up to eleven questions; the bound only stops an application that never converges from looping forever.
const MAX_INTERVIEW_ANSWERS = 64

const ANSWER_FIELDS = ['cockpit.root', 'cockpit.name', 'sibling', 'estate.runnable', 'ports.bases',
    'environment.install_policies', 'environment.test_data', 'environment.compose_files',
    'environment.machine', 'environment.posture', 'testing', 'guards'] as const

/**
 * The answers file's optional [provenance] table says who chose an answer: "human" (the default),
 * "agent-default" when the setup agent picked it because the person let it choose, or "derived" when
 * the setup agent accepts the value init read from exact sources. Without it, every value an agent
 * invented was written into cockpit.toml as something the operator stated. A derived field needs no
 * value in the file: init answers it with what it read, and the document owner checks it either way.
 */
const PROVENANCE_TABLE = 'provenance'
const PROVENANCE_VALUES: Readonly<Record<string, AnswerProvenance>> = { human: 'operator-confirmed', 'agent-default': 'agent-default', derived: 'derived' }
// cockpit proposes at most part of the machine floor, since free disk and the cold start time have no
// source; an answers file that does not attribute one is recorded as unattributed rather than as the person's.
const UNATTRIBUTED_UNLESS_MARKED: readonly string[] = ['environment.machine']

const isTable = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)

/** Flattens the answers file to field -> value, naming any key that matches no interview field. */
function answersByField(answers: Readonly<Record<string, unknown>>): { fields: Map<string, unknown>; unknown: string[] } {
    const fields = new Map<string, unknown>()
    const unknown: string[] = []
    const walk = (table: Record<string, unknown>, prefix: string) => {
        for (const [key, value] of Object.entries(table)) {
            const path = prefix === '' ? key : `${prefix}.${key}`
            if (path === PROVENANCE_TABLE) continue
            if ((ANSWER_FIELDS as readonly string[]).includes(path)) fields.set(path, value)
            else if (isTable(value) && ANSWER_FIELDS.some(field => field.startsWith(`${path}.`))) walk(value, path)
            else unknown.push(path)
        }
    }
    walk(answers, '')
    return { fields, unknown }
}

/** Reads the [provenance] table into field -> provenance, or names what is wrong with it. */
function answerProvenance(answers: Readonly<Record<string, unknown>>, answered: ReadonlyMap<string, unknown>):
    { marks: Map<string, AnswerProvenance> } | { refusal: InitApplicationOutcome } {
    const marks = new Map<string, AnswerProvenance>()
    const table = answers[PROVENANCE_TABLE]
    if (table === undefined) return { marks }
    if (!isTable(table)) return { refusal: refusal('INIT_ANSWER_INVALID', `${PROVENANCE_TABLE} must be a table of answer field = "human", "agent-default" or "derived"`) }
    const problems: string[] = []
    const walk = (current: Record<string, unknown>, prefix: string) => {
        for (const [key, value] of Object.entries(current)) {
            const path = prefix === '' ? key : `${prefix}.${key}`
            if (isTable(value)) { walk(value, path); continue }
            if (!(ANSWER_FIELDS as readonly string[]).includes(path) || path === 'cockpit.root') {
                problems.push(`provenance names no recorded interview answer: ${path}`)
            } else if (typeof value !== 'string' || PROVENANCE_VALUES[value] === undefined) {
                problems.push(`provenance.${path} must be "human", "agent-default" or "derived"`)
            } else if (!answered.has(path) && value !== 'derived') {
                problems.push(`provenance names ${path}, which the answers file does not answer`)
            } else marks.set(path, PROVENANCE_VALUES[value]!)
        }
    }
    walk(table, '')
    return problems.length === 0 ? { marks }
        : { refusal: refusal('INIT_ANSWER_INVALID', `${problems.join('; ')}; the [provenance] table says who chose each answer and is optional`) }
}

/** Who chose the answer to one question, as the answers file records it. */
function provenanceFor(field: string, marks: ReadonlyMap<string, AnswerProvenance>): AnswerProvenance {
    if (field === 'configuration.defaults') return 'operator-confirmed'
    return marks.get(field) ?? (UNATTRIBUTED_UNLESS_MARKED.includes(field) ? 'unattributed' : 'operator-confirmed')
}

/** Future questions can disappear after an answer; only actual questions and recorded answers count as used. */
function noteInterview(asked: Set<string>, outcome: InitApplicationOutcome): void {
    const interview = outcome.result?.interview
    if (!interview) return
    if (interview.cockpitRoot !== undefined) asked.add('cockpit.root')
    for (const field of interview.answered) asked.add(field)
    if (outcome.result?.question !== undefined) asked.add(outcome.result.question.field)
}

type UnattendedAnswer = { kind: 'answer'; bytes: string } | { kind: 'missing' } | { kind: 'refusal'; outcome: InitApplicationOutcome }

/**
 * The value init read for a field from exact sources, as the pending run proposed it; "answered"
 * when an earlier run already recorded the field, whose recorded answer stays in force.
 */
function derivedProposal(field: string, pending: InitApplicationOutcome): { value: unknown } | 'answered' | undefined {
    const interview = pending.result?.interview
    if (interview?.answered.includes(field)) return 'answered'
    const proposal = interview?.outstanding.find(row => row.field === field)?.proposals
        .find(row => row.target === field && row.provenance.kind === 'derived')
    return proposal && { value: proposal.value }
}

function unattendedAnswer(
    field: string,
    expectedSha256: string | undefined,
    supplied: ReadonlyMap<string, unknown>,
    unattended: UnattendedInit,
    marks: ReadonlyMap<string, AnswerProvenance>,
    pending: InitApplicationOutcome,
): UnattendedAnswer {
    if (field === 'configuration.defaults') {
        if (unattended.defaultsSha256 === undefined) return { kind: 'missing' }
        if (unattended.defaultsSha256 !== expectedSha256) return { kind: 'refusal', outcome: refusal('INIT_DEFAULTS_NOT_ACCEPTED',
            '--accept-defaults does not equal the digest of the surfaced defaults; rerun without it to read the current digest') }
        return { kind: 'answer', bytes: JSON.stringify({ confirmed: true, sha256: unattended.defaultsSha256 }) }
    }
    let value = supplied.get(field)
    if (value === undefined && marks.get(field) === 'derived') {
        const derived = derivedProposal(field, pending)
        if (derived === 'answered') return { kind: 'missing' }
        if (derived === undefined) return { kind: 'refusal', outcome: refusal('INIT_ANSWER_INVALID',
            `provenance.${field} is "derived", but init read no complete value for ${field} from an exact source; answer it in the answers file and mark it "human" once a person states it, or "agent-default" when you chose it`) }
        value = derived.value
    }
    if (value === undefined) return { kind: 'missing' }
    try { return { kind: 'answer', bytes: JSON.stringify(value) } }
    catch (error) {
        return { kind: 'refusal', outcome: refusal('INIT_ANSWER_INVALID',
            `the answer for ${field} cannot be written as JSON (${error instanceof Error ? error.message : 'unknown error'})`) }
    }
}

/**
 * An answer an earlier run recorded stays in force, so a different value in the file must not be
 * accepted quietly: the person approved the file's bytes, not the recorded ones.
 */
function recordedAnswerConflict(
    input: Pick<InitCommandInput, 'root' | 'target' | 'tools'>,
    preview: InitApplicationOutcome,
    supplied: ReadonlyMap<string, unknown>,
    marks: ReadonlyMap<string, AnswerProvenance>,
    unattended: UnattendedInit,
): InitApplicationOutcome | undefined {
    const placement = preview.result?.interview?.cockpitRoot
    const suppliedPlacement = supplied.get('cockpit.root')
    if (placement !== undefined && suppliedPlacement !== undefined && suppliedPlacement !== placement) return refusal('INIT_ANSWER_CONFLICT',
        `the answers file gives cockpit.root = ${JSON.stringify(suppliedPlacement)}, but this cockpit was created ${placement === 'in-repo' ? 'inside the product repository' : 'in a dedicated folder'}; init does not move an existing cockpit, so drop cockpit.root from the answers file or set it to ${JSON.stringify(placement)}`)
    const answered = preview.result?.interview?.answered ?? []
    const recorded = preview.result?.estate?.answers ?? []
    for (const [index, field] of answered.entries()) {
        // The defaults are accepted by digest, not by the answers file, and are bound to the draft they confirmed.
        if (field === 'configuration.defaults') continue
        const now = unattendedAnswer(field, undefined, supplied, unattended, marks, preview)
        if (now.kind === 'refusal') return now.outcome
        if (now.kind !== 'answer' || recorded[index] === undefined) continue
        let same = false
        // A recorded or supplied answer that is not JSON cannot match, which the conflict refusal below reports.
        try { same = canonicalJson(JSON.parse(now.bytes)) === canonicalJson(JSON.parse(recorded[index]!.bytes)) } catch { same = false }
        if (same && provenanceFor(field, marks) !== recorded[index]!.provenance) same = false
        if (!same) return refusal('INIT_ANSWER_CONFLICT',
            `the answers file gives a different value for ${field} than the answer an earlier run recorded; drop ${field} from the answers file to keep the recorded answer, or, before cockpit.toml is prepared, preview a reset with ${initCommand({ root: input.root, target: (input.tools ?? [input.target]).join(','), args: `--reset-answer ${field} --json` })}`)
    }
    return undefined
}

export async function runInitOperatorCommand(
    input: InitCommandInput,
    options: InitCommandOptions,
    io: InitCommandIo,
    application: InitApplicationHandler,
): Promise<InitApplicationOutcome> {
    const platform = input.platform ?? process.platform
    if (platform !== 'darwin' && platform !== 'linux') return unsupportedInitPlatformOutcome(platform)
    const asked = new Set<string>()
    const outcome = await drive({ ...input, platform }, options, io, application, asked)
    if (!options.unattended || outcome.kind !== 'complete' || asked.size === 0) return outcome
    // A finished run that ignored part of the file would otherwise look like it honoured all of it.
    const ignored = [...answersByField(options.unattended.answers).fields.keys()]
        .filter(field => !asked.has(field))
    if (ignored.length === 0) return outcome
    return { ...outcome, diagnostics: [...outcome.diagnostics, { severity: 'warning', code: 'INIT_ANSWER_UNUSED',
        message: `the answers file gave ${ignored.join(', ')}, which the interview never asked for` }] }
}

async function drive(
    input: InitCommandInput & Required<Pick<InitCommandInput, 'platform'>>,
    options: InitCommandOptions,
    io: InitCommandIo,
    application: InitApplicationHandler,
    asked: Set<string>,
): Promise<InitApplicationOutcome> {
    let shared: Omit<InitApplicationInput, 'accepted'> = {
        root: input.root,
        target: input.target,
        tools: input.tools ?? [input.target],
        ...(input.registry === undefined ? {} : { registry: input.registry }),
        sessionId: input.sessionId ?? randomUUID(),
        platform: input.platform,
        home: input.home ?? process.env.HOME,
        ...(input.xdgStateHome === undefined ? {} : { xdgStateHome: input.xdgStateHome }),
        ...(input.resetAnswer === undefined ? {} : { resetAnswer: input.resetAnswer }),
    }
    if (input.resetAnswer !== undefined) {
        const resetPreview = { field: input.resetAnswer.field }
        const direct = await application({ ...shared, resetAnswer: resetPreview, accepted: false })
        if (direct.kind === 'pending' && direct.result?.resetAnswer?.field === input.resetAnswer.field) {
            if (input.resetAnswer.acceptedPreviewSha256 === undefined) return direct
            return application({ ...shared, accepted: false })
        }
        if (direct.kind !== 'refusal' || direct.diagnostics.length !== 1
            || direct.diagnostics[0]?.code !== 'INIT_ANSWER_RESET_UNAVAILABLE') return direct
        const { resetAnswer: _resetAnswer, ...discoveryInput } = shared
        const discovery = await application({ ...discoveryInput, accepted: false })
        const option = discovery.result?.cockpitRoot?.options.find(row => row.answer === 'dedicated')
        if (!option || option.unavailable !== undefined) return direct
        const routed = { ...shared, root: option.root,
            cockpitRoot: { kind: 'dedicated' as const, firstSibling: option.firstSibling } }
        const preview = await application({ ...routed, resetAnswer: resetPreview, accepted: false })
        if (input.resetAnswer.acceptedPreviewSha256 === undefined || preview.kind !== 'pending'
            || preview.result?.resetAnswer?.field !== input.resetAnswer.field) return preview
        return application({ ...routed, accepted: false })
    }
    const unattended = options.unattended
    const supplied = unattended ? answersByField(unattended.answers) : undefined
    if (supplied && supplied.unknown.length > 0) return refusal('INIT_ANSWER_FIELD_UNKNOWN',
        `the answers file names no interview field: ${supplied.unknown.join(', ')}; valid fields are ${ANSWER_FIELDS.join(', ')}, plus the optional [${PROVENANCE_TABLE}] table`)
    const provenance = unattended && supplied ? answerProvenance(unattended.answers, supplied.fields) : { marks: new Map<string, AnswerProvenance>() }
    if ('refusal' in provenance) return provenance.refusal
    const { marks } = provenance
    let preview = await application({ ...shared, accepted: false })
    noteInterview(asked, preview)
    if (preview.kind !== 'pending' || preview.status !== 0) return preview
    if (!unattended && (!options.interactive || options.json)) return preview
    if (!unattended && !io.terminal) return refusal('INIT_TERMINAL_REQUIRED',
        'interactive init requires an attached terminal; an agent without one passes --accept-preview and --answers instead')
    const rootQuestion = preview.result?.cockpitRoot
    if (rootQuestion) {
        asked.add(rootQuestion.field)
        const answer = unattended ? supplied!.fields.get(rootQuestion.field) : await io.chooseCockpitRoot?.(rootQuestion)
        // No answer leaves the choice to the application, which refuses acceptance and names the key.
        const option = rootQuestion.options.find(row => row.answer === answer)
        if (answer !== undefined && !option) return refusal('INIT_ANSWER_INVALID',
            `cockpit.root must be one of ${rootQuestion.options.map(row => JSON.stringify(row.answer)).join(' or ')}`)
        // The preview digest does not depend on the root, so a stale one is refused before the folder is created.
        if (option && unattended && unattended.previewSha256 !== preview.result!.previewSha256) {
            return refusal('INIT_PREVIEW_NOT_ACCEPTED', '--accept-preview does not equal the digest of the pending preview; rerun without it to read the current digest')
        }
        if (option?.unavailable !== undefined) return refusal('INIT_COCKPIT_ROOT_UNAVAILABLE',
            `cockpit.root = ${JSON.stringify(option.answer)} cannot be used here: ${option.unavailable}`)
        if (option?.answer === 'dedicated') {
            try {
                if (!io.createCockpitRoot) throw new Error('this caller cannot create directories')
                await io.createCockpitRoot(option.root)
            }
            catch (error) {
                return refusal('INIT_COCKPIT_ROOT_CREATE_FAILED', `the dedicated cockpit folder ${option.root} could not be created (${error instanceof Error ? error.message : 'unknown error'}); create it yourself or answer cockpit.root = "in-repo"`)
            }
            shared = { ...shared, root: option.root, cockpitRoot: { kind: 'dedicated', firstSibling: option.firstSibling } }
        } else if (option) shared = { ...shared, cockpitRoot: { kind: 'in-repo' } }
        if (option) {
            preview = await application({ ...shared, accepted: false })
            noteInterview(asked, preview)
            if (preview.kind !== 'pending' || preview.status !== 0) return preview
        }
    }
    const accepted = { ...shared, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 } as const
    let outcome: InitApplicationOutcome
    if (unattended && unattended.previewSha256 !== preview.result!.previewSha256) {
        return refusal('INIT_PREVIEW_NOT_ACCEPTED', '--accept-preview does not equal the digest of the pending preview; rerun without it to read the current digest')
    }
    if (unattended && supplied) {
        const conflict = recordedAnswerConflict(input, preview, supplied.fields, marks, unattended)
        if (conflict) return conflict
    }
    if (preview.result?.question === undefined && !unattended) {
        const answer = await io.confirm(preview.result!)
        if (answer !== preview.result!.previewSha256) {
            return refusal('INIT_PREVIEW_NOT_ACCEPTED', 'type the exact preview digest to accept the selected bootstrap target')
        }
        outcome = await application(accepted)
    } else if (preview.result?.question === undefined) outcome = await application(accepted)
    else outcome = preview
    for (let answered = 0; outcome.kind === 'pending' && outcome.result?.question !== undefined; answered += 1) {
        if (answered >= MAX_INTERVIEW_ANSWERS) return refusal('INIT_INTERVIEW_LIMIT_EXCEEDED',
            `the interview still asks questions after ${MAX_INTERVIEW_ANSWERS} answers; rerun ${initCommand({ root: input.root, target: (input.tools ?? [input.target]).join(',') })} with the same options to resume from the persisted answers`)
        const question = outcome.result.question
        let bytes: string | undefined
        // A person typing at the terminal states their own answer.
        let answerProvenanceValue: AnswerProvenance = 'operator-confirmed'
        if (unattended && supplied) {
            const resolved = unattendedAnswer(question.field, question.expectedSha256, supplied.fields, unattended, marks, outcome)
            if (resolved.kind === 'refusal') return resolved.outcome
            // An unanswered field is not a failure: the pending result lists what is still outstanding.
            if (resolved.kind === 'missing') return outcome
            bytes = resolved.bytes
            answerProvenanceValue = provenanceFor(question.field, marks)
        } else {
            if (!io.answerQuestion) return outcome
            bytes = await io.answerQuestion(question)
            if (bytes === undefined) return refusal('GREENFIELD_ANSWER_REQUIRED', 'greenfield init requires an explicit answer to the named question')
        }
        outcome = await application({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes, provenance: answerProvenanceValue,
        } })
        noteInterview(asked, outcome)
    }
    if (outcome.kind !== 'artifact' || outcome.artifact === null || outcome.destination === null) return outcome
    try {
        await io.writeArtifact(outcome.destination, outcome.artifact)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            return refusal('INIT_ARTIFACT_WRITE_FAILED', `cockpit.toml could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})`)
        }
    }
    outcome = await application(accepted)
    return outcome
}
