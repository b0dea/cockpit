import { randomUUID } from 'node:crypto'
import type { SurfaceTarget } from '../surfaces/contract.js'
import {
    runInitApplication,
    unsupportedInitPlatformOutcome,
    type CockpitRootQuestion,
    type InitApplicationInput,
    type InitApplicationOutcome,
} from '../environment/init-application.js'

export const mechanism = {
    id: 'init-command',
    module: 'packages/cockpit/src/init/command.ts',
    exports: ['runInitOperatorCommand'],
} as const

export interface InitCommandInput {
    readonly root: string
    readonly target: SurfaceTarget
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

export interface InitCommandOptions {
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

export type InitApplicationHandler = (input: InitApplicationInput) => Promise<InitApplicationOutcome>

// Real interviews ask up to nine questions; the bound only stops an application that never converges from looping forever.
const MAX_INTERVIEW_ANSWERS = 64

const ANSWER_FIELDS = ['cockpit.root', 'cockpit.name', 'sibling', 'estate.runnable', 'ports.bases',
    'environment.install_policies', 'environment.test_data', 'environment.generated', 'environment.compose_files',
    'environment.machine', 'guards'] as const

const isTable = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)

/** Flattens the answers file to field -> value, naming any key that matches no interview field. */
function answersByField(answers: Readonly<Record<string, unknown>>): { fields: Map<string, unknown>; unknown: string[] } {
    const fields = new Map<string, unknown>()
    const unknown: string[] = []
    const walk = (table: Record<string, unknown>, prefix: string) => {
        for (const [key, value] of Object.entries(table)) {
            const path = prefix === '' ? key : `${prefix}.${key}`
            if ((ANSWER_FIELDS as readonly string[]).includes(path)) fields.set(path, value)
            else if (isTable(value) && ANSWER_FIELDS.some(field => field.startsWith(`${path}.`))) walk(value, path)
            else unknown.push(path)
        }
    }
    walk(answers, '')
    return { fields, unknown }
}

function refusal(code: string, message: string): InitApplicationOutcome {
    return { kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: [{ severity: 'error', code, message }], result: null }
}

/** Records every field the interview has asked or will ask, so a supplied field it never asks is reported. */
function noteInterview(asked: Set<string>, outcome: InitApplicationOutcome): void {
    const interview = outcome.result?.interview
    if (!interview) return
    for (const field of [...interview.answered, ...interview.outstanding.map(row => row.field)]) {
        asked.add(field)
        // Compose-first answers the generated-environment question under its own field name.
        if (field === 'environment.generated') asked.add('environment.compose_files')
    }
}

type UnattendedAnswer = { kind: 'answer'; bytes: string } | { kind: 'missing' } | { kind: 'refusal'; outcome: InitApplicationOutcome }

function unattendedAnswer(
    field: string,
    expectedSha256: string | undefined,
    supplied: ReadonlyMap<string, unknown>,
    unattended: UnattendedInit,
): UnattendedAnswer {
    if (field === 'configuration.defaults') {
        if (unattended.defaultsSha256 === undefined) return { kind: 'missing' }
        if (unattended.defaultsSha256 !== expectedSha256) return { kind: 'refusal', outcome: refusal('INIT_DEFAULTS_NOT_ACCEPTED',
            '--accept-defaults does not equal the digest of the surfaced defaults; rerun without it to read the current digest') }
        return { kind: 'answer', bytes: JSON.stringify({ confirmed: true, sha256: unattended.defaultsSha256 }) }
    }
    // Compose-first replaces the generated environment, so one question accepts either spelling.
    const composeFirst = field === 'environment.generated' ? supplied.get('environment.compose_files') : undefined
    const generated = supplied.get(field)
    if (composeFirst !== undefined && generated !== undefined) return { kind: 'refusal', outcome: refusal('INIT_ANSWER_AMBIGUOUS',
        'the answers file gives both environment.generated and environment.compose_files; compose-first replaces the generated environment') }
    const value = composeFirst !== undefined ? { compose_files: composeFirst } : generated
    if (value === undefined) return { kind: 'missing' }
    try { return { kind: 'answer', bytes: JSON.stringify(value) } }
    catch (error) {
        return { kind: 'refusal', outcome: refusal('INIT_ANSWER_INVALID',
            `the answer for ${field} cannot be written as JSON (${error instanceof Error ? error.message : 'unknown error'})`) }
    }
}

const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : isTable(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
        : JSON.stringify(value)

/**
 * An answer an earlier run recorded stays in force, so a different value in the file must not be
 * accepted quietly: the person approved the file's bytes, not the recorded ones.
 */
function recordedAnswerConflict(
    preview: InitApplicationOutcome,
    supplied: ReadonlyMap<string, unknown>,
    unattended: UnattendedInit,
): InitApplicationOutcome | undefined {
    const answered = preview.result?.interview?.answered ?? []
    const recorded = preview.result?.estate?.answers ?? []
    for (const [index, field] of answered.entries()) {
        const now = unattendedAnswer(field, undefined, supplied, unattended)
        if (now.kind === 'refusal') return now.outcome
        if (now.kind !== 'answer' || recorded[index] === undefined) continue
        let same = false
        try { same = canonicalJson(JSON.parse(now.bytes)) === canonicalJson(JSON.parse(recorded[index]!.bytes)) } catch { same = false }
        if (!same) return refusal('INIT_ANSWER_CONFLICT',
            `the answers file gives a different value for ${field} than the answer an earlier run recorded; drop ${field} from the answers file to keep the recorded answer. init has no command to reset a recorded answer`)
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
        ...(input.registry === undefined ? {} : { registry: input.registry }),
        sessionId: input.sessionId ?? randomUUID(),
        platform: input.platform,
        home: input.home ?? process.env.HOME,
        ...(input.xdgStateHome === undefined ? {} : { xdgStateHome: input.xdgStateHome }),
        ...(input.resetAnswer === undefined ? {} : { resetAnswer: input.resetAnswer }),
    }
    if (input.resetAnswer !== undefined) return application({ ...shared, accepted: false })
    const unattended = options.unattended
    const supplied = unattended ? answersByField(unattended.answers) : undefined
    if (supplied && supplied.unknown.length > 0) return refusal('INIT_ANSWER_FIELD_UNKNOWN',
        `the answers file names no interview field: ${supplied.unknown.join(', ')}; valid fields are ${ANSWER_FIELDS.join(', ')}`)
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
        const conflict = recordedAnswerConflict(preview, supplied.fields, unattended)
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
            `the interview still asks questions after ${MAX_INTERVIEW_ANSWERS} answers; rerun cockpit init to resume from the persisted answers`)
        const question = outcome.result.question
        let bytes: string | undefined
        if (unattended && supplied) {
            const resolved = unattendedAnswer(question.field, question.expectedSha256, supplied.fields, unattended)
            if (resolved.kind === 'refusal') return resolved.outcome
            // An unanswered field is not a failure: the pending result lists what is still outstanding.
            if (resolved.kind === 'missing') return outcome
            bytes = resolved.bytes
        } else {
            if (!io.answerQuestion) return outcome
            bytes = await io.answerQuestion(question)
            if (bytes === undefined) return refusal('GREENFIELD_ANSWER_REQUIRED', 'greenfield init requires an explicit answer to the named question')
        }
        outcome = await application({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes, provenance: 'operator-confirmed',
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
