import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Diagnostic } from '../diagnostics.js'
import { readinessReport, type ReadinessReport } from '../readiness.js'
import { cockpitCommand, initCommand, formatShellCommand } from '../fix-catalogue.js'
import {
    isAnswerProvenance,
    plannedGreenfieldQuestions,
    type AnswerProvenance, type DocumentCommandInput, type DocumentOutcome, type EstateClassificationOutcome, type EstateClassificationResult,
    type UnconfirmedAnswer,
    type EstateObservationInput,
} from '../init/draft.js'
import { SURFACE_TARGETS, type SurfaceTarget } from '../surfaces/contract.js'
import { ENVIRONMENT_CODES, snapshotJson, errorCause } from './contract.js'
import { bootstrapHolderId } from './identity.js'
import {
    authenticateStatePublication,
    readState,
    refreshBootstrapObservation,
    refreshBootstrapPublication,
    resetBootstrapAnswer,
    restartBootstrapState,
    selectBootstrapStateRoot,
    transactState,
    type BootstrapStateAddress,
    type BootstrapStateNamespace,
    type BootstrapStateRecord,
    type SelectBootstrapStateRootInput,
    type StateResult,
} from './state.js'

const DRAFT_BYTE_LIMIT = 262_144
const SHA256 = /^[a-f0-9]{64}$/

export interface InitApplicationInput {
    readonly root: string
    /** The tool whose setup skill init publishes before the interview; the first of tools. */
    readonly target: SurfaceTarget
    /** Every tool the person chose, written as surfaces.tools; the final sync renders each one. */
    readonly tools: readonly SurfaceTarget[]
    readonly registry?: string
    readonly accepted: boolean
    readonly acceptedPreviewSha256?: string
    readonly sessionId: string
    readonly platform: SelectBootstrapStateRootInput['platform']
    readonly home: string | undefined
    readonly xdgStateHome?: string
    readonly uid?: number
    readonly greenfieldAnswer?: Readonly<{
        questionId: string
        bytes: string
        provenance: AnswerProvenance
    }>
    readonly resetAnswer?: Readonly<{ field: string; acceptedPreviewSha256?: string }>
    /**
     * The operator's answer to where the cockpit lives, required when root is a product repository.
     * For "dedicated", root is the new cockpit folder and firstSibling the product repository beside it.
     */
    readonly cockpitRoot?: Readonly<{ kind: 'in-repo' }> | Readonly<{ kind: 'dedicated'; firstSibling: string }>
}

export type CockpitRootAnswer = 'dedicated' | 'in-repo'

export interface CockpitRootOption {
    readonly answer: CockpitRootAnswer
    readonly root: string
    /** Directories init creates before it writes anything else; each is outside the directory init ran in. */
    readonly creates: readonly string[]
    readonly siblingsRoot: string
    readonly firstSibling: string
    readonly tradeOff: string
    /** Set when this option cannot be taken here; init refuses it before creating anything. */
    readonly unavailable?: string
}

/** Asked before anything is written, because the answer decides which directory init writes into. */
export interface CockpitRootQuestion {
    readonly field: 'cockpit.root'
    readonly why: string
    readonly recommended: CockpitRootAnswer
    readonly options: readonly CockpitRootOption[]
}

interface DigestRow { readonly path: string; readonly sha256: string }
interface BootstrapProjection {
    readonly root: string
    readonly target: SurfaceTarget
    readonly sources: readonly DigestRow[]
    readonly files: readonly DigestRow[]
    readonly previewSha256: string
}

interface OwnerOutcome {
    readonly kind: string
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

export interface SelectedBootstrapPublicationAuthority {
    readonly kind: 'selected-bootstrap-publication-authority'
}

type PreparedBootstrapOutcome =
    | Readonly<{ kind: 'complete'; status: 0; diagnostics: readonly Diagnostic[]; result: BootstrapProjection;
        authority: SelectedBootstrapPublicationAuthority }>
    | Readonly<{ kind: 'refusal'; status: 2; diagnostics: readonly Diagnostic[]; result: null }>

type AppliedBootstrapOutcome =
    | Readonly<{ kind: 'complete'; status: 0; diagnostics: readonly Diagnostic[]; result: BootstrapProjection;
        authority: SelectedBootstrapPublicationAuthority }>
    | Readonly<{ kind: 'refusal'; status: 2; diagnostics: readonly Diagnostic[]; result: null }>

type ResumedBootstrapOutcome =
    | Readonly<{ kind: 'complete'; status: 0; diagnostics: readonly Diagnostic[]; result: BootstrapProjection;
        canonicalOwnership: true }>
    | Readonly<{ kind: 'refresh'; status: 0; diagnostics: readonly Diagnostic[]; result: BootstrapProjection;
        authority: SelectedBootstrapPublicationAuthority; canonicalOwnership: false }>
    | Readonly<{ kind: 'pending'; status: 0; diagnostics: readonly Diagnostic[]; result: null;
        canonicalOwnership: false }>
    | Readonly<{ kind: 'refusal'; status: 2; diagnostics: readonly Diagnostic[]; result: null }>

export type DestinationObservation =
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'available'; sha256: string }>
    | Readonly<{ kind: 'refusal'; diagnostics: readonly Diagnostic[] }>

export interface InitApplicationAdapters {
    readonly now: () => string
    readonly prepareBootstrap: (input: Readonly<{ root: string; target: SurfaceTarget }>) => Promise<PreparedBootstrapOutcome>
    readonly resumeBootstrap: (input: Readonly<{
        root: string
        target: SurfaceTarget
        address: BootstrapStateAddress
        expectedRevision?: number
        expectedCommandSha256?: string
    }>) => Promise<ResumedBootstrapOutcome>
    readonly applyBootstrap: (authority: SelectedBootstrapPublicationAuthority) => Promise<AppliedBootstrapOutcome>
    readonly document: (input: DocumentCommandInput) => Promise<DocumentOutcome>
    readonly observeDestination: (input: Readonly<{ path: string; byteLimit: number }>) => Promise<DestinationObservation>
    readonly validateConfig: (path: string) => Promise<OwnerOutcome>
    readonly synchronize: (input: Readonly<{
        configPath: string
        bootstrapState?: Readonly<{ publication: StateResult<BootstrapStateRecord>; address: BootstrapStateAddress }>
    }>) => Promise<OwnerOutcome>
    readonly check: (input: Readonly<{ configPath: string }>) => Promise<OwnerOutcome>
    readonly preflight: (input: Readonly<{ configPath: string }>) => Promise<OwnerOutcome>
    readonly classifyEstate?: (input: EstateObservationInput) => Promise<EstateClassificationOutcome>
    /** Says whether root is a product repository, which makes init ask where the cockpit lives. */
    readonly observeRoot?: (input: Readonly<{ root: string }>) => Promise<'product-repository' | 'cockpit-root'>
    /** Proposes answers from files the repositories already carry; every value comes back as inferred. */
    readonly infer?: (input: Readonly<{ root: string; configurationRoot?: string;
        repositories: readonly Readonly<{ slug: string; path: string }>[] }>)
        => Promise<Readonly<{
            facts: readonly Readonly<{ fields: readonly string[]; target: string; value: unknown;
                provenance: Readonly<{ kind: 'inferred'; source: string; reason: string }> }>[]
            skipped: readonly Readonly<{ source: string; reason: string }>[]
        }>>
    /**
     * Findings about prerequisites no init stage checks (the root's Git working tree, the cockpit's
     * own install, sibling remotes, committed secret files), and whether a runtime is declared.
     */
    readonly inspectReadiness?: (input: Readonly<{
        root: string
        configPath?: string
        repositories: readonly Readonly<{ slug: string; root: string }>[]
        checkRoot: boolean
        tools: readonly string[]
        classification?: string
    }>) => Promise<Readonly<{ state: ReadinessReport['state']; findings: readonly Diagnostic[] }>>
}

export interface GreenfieldQuestion {
    readonly id: string
    readonly field: string
    readonly source: string
    readonly why: string
    readonly expectedSha256?: string
    /** Lines preserve the owner draft exactly when joined with a newline, within bounded human rendering. */
    readonly document?: readonly string[]
}

type IssuedEstateClassificationResult = EstateClassificationResult & Readonly<{
    sourceObservationSha256: string
}>

export interface GreenfieldResult extends EstateClassificationResult {
    readonly sourceObservationSha256: string
    readonly answers: readonly Readonly<{
        questionId: string; bytes: string; sha256: string; provenance: AnswerProvenance
    }>[]
}

/** One proposed value for an unanswered field. It stays a proposal until the operator confirms it in an answer. */
export interface InferredItem {
    readonly target: string
    readonly value: unknown
    readonly provenance: Readonly<{ kind: 'inferred'; source: string; reason: string }>
}

export interface OutstandingField {
    readonly field: string
    readonly why: string
    readonly inferred: readonly InferredItem[]
}

/** Every field the interview will still ask, in order, so an unattended caller can answer them in one pass. */
export interface InterviewPlan {
    /** Fields an earlier run already answered; their answers are kept. */
    readonly answered: readonly string[]
    readonly outstanding: readonly OutstandingField[]
    readonly inferenceSkipped: readonly Readonly<{ source: string; reason: string }>[]
    /** Where the accepted cockpit lives, when init runs for a product repository; it is kept like any other answer. */
    readonly cockpitRoot?: CockpitRootAnswer
}

export interface InitResult {
    readonly stage: BootstrapStateRecord['value']['stage']
    readonly root: string
    readonly target: SurfaceTarget
    readonly previewSha256: string
    readonly files: readonly DigestRow[]
    readonly ownerOutcome?: OwnerOutcome
    readonly question?: GreenfieldQuestion
    readonly estate?: GreenfieldResult
    readonly interview?: InterviewPlan
    readonly cockpitRoot?: CockpitRootQuestion
    readonly resetAnswer?: Readonly<{ field: string; revision: number; invalidatedFields: readonly string[]; previewSha256: string }>
    /** Answers in cockpit.toml no person stated; each stays listed there, and doctor warns, until someone confirms it. */
    readonly unconfirmed?: readonly UnconfirmedAnswer[]
    /** This run's findings grouped under the prerequisites cockpit depends on: what to do next. */
    readonly readiness?: ReadinessReport
}

interface InitOutcomeBase {
    readonly status: number
    readonly artifact: string | null
    readonly destination: string | null
    readonly diagnostics: readonly Diagnostic[]
    readonly result: InitResult | null
}

export type InitApplicationOutcome =
    | (InitOutcomeBase & Readonly<{ kind: 'pending' | 'artifact' | 'complete'; status: 0 }>)
    | (InitOutcomeBase & Readonly<{ kind: 'pending-dependency' | 'refusal'; status: 2 }>)

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

// The document owner reports the open question as a blocking gap because a standalone draft with
// it is invalid. Here the run stops at that question and exits 0, so an error read as a failure.
function questionNotices(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    return diagnostics.map(row => row.code === 'DOCUMENT_GAP' && row.severity === 'error' ? { ...row, severity: 'info' } : row)
}

function diagnostic(code: string, message: string, target?: string): Diagnostic {
    return { severity: 'error', code, message, ...(target === undefined ? {} : { target }) }
}

function refused(code: string, message: string, target?: string): InitApplicationOutcome {
    return { kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: [diagnostic(code, message, target)], result: null }
}

export function unsupportedInitPlatformOutcome(platform: string): InitApplicationOutcome {
    return refused(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        `init cannot select a state root on ${platform} — bootstrap state ownership is implemented only for macOS and Linux; fix: run ${initCommand()} on a supported macOS or Linux host`)
}

function ownerRefusal(
    outcome: OwnerOutcome, stage: BootstrapStateRecord['value']['stage'], projection: BootstrapProjection,
    greenfield?: Parameters<typeof result>[3],
): InitApplicationOutcome {
    return {
        kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: outcome.diagnostics,
        result: result(stage, projection, outcome, greenfield),
    }
}

function result(
    stage: BootstrapStateRecord['value']['stage'],
    projection: BootstrapProjection,
    ownerOutcome?: OwnerOutcome,
    greenfield?: Readonly<{ question?: GreenfieldQuestion; estate?: GreenfieldResult; interview?: InterviewPlan;
        cockpitRoot?: CockpitRootQuestion; resetAnswer?: InitResult['resetAnswer']; unconfirmed?: InitResult['unconfirmed'] }>,
): InitResult {
    return { stage, root: projection.root, target: projection.target,
        previewSha256: projection.previewSha256, files: [...projection.files],
        ...(ownerOutcome === undefined ? {} : { ownerOutcome }),
        ...(greenfield?.question === undefined ? {} : { question: greenfield.question }),
        ...(greenfield?.estate === undefined ? {} : { estate: greenfield.estate }),
        ...(greenfield?.interview === undefined ? {} : { interview: greenfield.interview }),
        ...(greenfield?.cockpitRoot === undefined ? {} : { cockpitRoot: greenfield.cockpitRoot }),
        ...(greenfield?.resetAnswer === undefined ? {} : { resetAnswer: greenfield.resetAnswer }),
        ...(greenfield?.unconfirmed === undefined ? {} : { unconfirmed: greenfield.unconfirmed }) }
}

// The repository's directory name becomes the first sibling's slug and the cockpit's name stem.
const SIBLING_DIRECTORY = /^[a-z][a-z0-9-]{0,63}$/

function cockpitRootQuestion(root: string): CockpitRootQuestion {
    const dedicated = resolve(dirname(root), `${basename(root)}-cockpit`)
    const unnamed = SIBLING_DIRECTORY.test(basename(root)) ? undefined
        : `the directory name ${JSON.stringify(basename(root))} is not a valid sibling slug (lowercase letters, digits and hyphens, starting with a letter); rename the directory, or create a dedicated cockpit folder yourself and add this repository with cockpit sibling add --from`
    return {
        field: 'cockpit.root',
        why: `${root} is a product repository, and the cockpit root is where init writes cockpit.toml, AGENTS.md, guards and harness settings, so init never chooses it for you; answer cockpit.root = "dedicated" or "in-repo"`,
        recommended: 'dedicated',
        options: [
            { answer: 'dedicated' as const, root: dedicated, creates: [dedicated], siblingsRoot: '..',
                firstSibling: root,
                tradeOff: `the product repository stays free of cockpit files, and the cockpit grows to more repositories with cockpit sibling add, each created or found beside ${basename(root)}, without moving`,
                ...(unnamed === undefined ? {} : { unavailable: unnamed }) },
            { answer: 'in-repo' as const, root, creates: [], siblingsRoot: '.', firstSibling: root,
                tradeOff: 'the product repository carries the cockpit files and the cockpit cannot neutrally own several repositories; it can be moved out to a dedicated folder later',
                ...(unnamed === undefined ? {} : { unavailable: unnamed }) },
        ],
    }
}

/** Where the estate's repositories are observed: the cockpit root, or the product repository a dedicated cockpit sits beside. */
function estateInput(input: InitApplicationInput): EstateObservationInput {
    if (input.cockpitRoot?.kind === 'dedicated') return { root: dirname(input.cockpitRoot.firstSibling),
        repositories: [basename(input.cockpitRoot.firstSibling)] }
    // Choosing in-repo must not lose the product: its root manifests are observed as the sibling at ".".
    if (input.cockpitRoot?.kind === 'in-repo') return { root: input.root, rootIsRepository: true as const }
    return { root: input.root }
}

function documentEstate(input: InitApplicationInput): Pick<DocumentCommandInput, 'estate'> {
    return input.cockpitRoot === undefined ? {} : { estate: estateInput(input) }
}

async function interviewPlan(
    input: InitApplicationInput,
    adapters: InitApplicationAdapters,
    classification: EstateClassificationResult,
    answered: number,
): Promise<InterviewPlan> {
    const planned = plannedGreenfieldQuestions({ root: input.root, classification: classification.classification, gaps: classification.gaps })
    const observedRoot = estateInput(input).root
    const inference = await adapters.infer?.({ root: observedRoot, configurationRoot: input.root,
        repositories: classification.runnable.map(row => ({ slug: row.slug, path: relative(observedRoot, resolve(observedRoot, row.path)) || '.' })) })
    return {
        answered: planned.slice(0, answered).map(row => row.field),
        outstanding: planned.slice(answered).map(({ field, why }) => ({ field, why,
            inferred: [...field === 'cockpit.name' ? nameProposal(input.root) : [],
                ...(inference?.facts ?? []).filter(fact => fact.fields.includes(field))
                    .map(({ target, value, provenance }) => ({ target, value, provenance }))] })),
        inferenceSkipped: inference?.skipped ?? [],
        ...(input.cockpitRoot === undefined ? {} : { cockpitRoot: input.cockpitRoot.kind }),
    }
}

// The cockpit root's directory name is the proposed cockpit name when it is a valid one.
function nameProposal(root: string): readonly InferredItem[] {
    const name = basename(root)
    return /^[a-z0-9][a-z0-9-]*$/.test(name) ? [{ target: 'cockpit.name', value: name,
        provenance: { kind: 'inferred' as const, source: root, reason: 'the cockpit root directory name' } }] : []
}

function commandDigest(input: InitApplicationInput): string {
    return sha256(JSON.stringify({ root: input.root, target: input.target, tools: input.tools, registry: input.registry ?? null,
        ...(input.cockpitRoot === undefined ? {} : { cockpitRoot: input.cockpitRoot.kind }),
        ...(input.cockpitRoot?.kind === 'dedicated' ? { firstSibling: input.cockpitRoot.firstSibling } : {}) }))
}

function evidenceMatches(record: BootstrapStateRecord, projection: BootstrapProjection, commandSha256: string): boolean {
    return record.value.checkoutRoot === projection.root
        && record.value.target === projection.target
        && record.value.commandSha256 === commandSha256
        && record.value.previewSha256 === projection.previewSha256
        && JSON.stringify(record.value.sources) === JSON.stringify(projection.sources)
}

function recordedProjection(record: BootstrapStateRecord): BootstrapProjection {
    return {
        root: record.value.checkoutRoot,
        target: record.value.target,
        sources: [...record.value.sources],
        files: [...record.value.published],
        previewSha256: record.value.previewSha256,
    }
}

async function persist(
    namespace: BootstrapStateNamespace,
    address: BootstrapStateAddress,
    input: InitApplicationInput,
    projection: BootstrapProjection,
    adapters: InitApplicationAdapters,
    stage: BootstrapStateRecord['value']['stage'],
    current: BootstrapStateRecord | null,
    fields?: Readonly<{ published?: readonly DigestRow[]; destination?: string; artifactBytes?: string; artifactSha256?: string;
        greenfield?: BootstrapStateRecord['value']['greenfield'] }>,
): Promise<StateResult<BootstrapStateRecord>> {
    const publication = await transactState(namespace, address, { ownerId: bootstrapHolderId({
        checkoutId: namespace.checkoutId, sessionId: input.sessionId,
    }) }, (observed) => ({
        format: 'cockpit-state/v1', kind: 'bootstrap', checkoutId: namespace.checkoutId, target: input.target,
        revision: observed === null ? 0 : observed.revision + 1,
        updatedAt: adapters.now(),
        value: {
            stage, checkoutRoot: input.root, target: input.target,
            sources: [...projection.sources], commandSha256: commandDigest(input), previewSha256: projection.previewSha256,
            published: [...(fields?.published ?? current?.value.published ?? [])],
            destination: fields?.destination ?? current?.value.destination ?? null,
            artifactBytes: fields?.artifactBytes ?? current?.value.artifactBytes ?? null,
            artifactSha256: fields?.artifactSha256 ?? current?.value.artifactSha256 ?? null,
            ...(fields?.greenfield === undefined && current?.value.greenfield === undefined
                ? {} : { greenfield: fields?.greenfield ?? current!.value.greenfield! }),
        },
    }))
    return publication
}

function greenfieldResult(
    classification: EstateClassificationResult,
    sourceObservationSha256: string,
    answers: NonNullable<BootstrapStateRecord['value']['greenfield']>['answers'],
): GreenfieldResult {
    return { ...classification, sourceObservationSha256, answers: [...answers] }
}

function stateFailure(outcome: StateResult<unknown>): InitApplicationOutcome {
    if (outcome.kind === 'refusal') return refused(outcome.code, outcome.message, outcome.target)
    return refused('INIT_STATE_DURABILITY_INDETERMINATE', 'bootstrap state durability could not be confirmed')
}

export async function runInitApplication(
    input: InitApplicationInput,
    adapters: InitApplicationAdapters,
): Promise<InitApplicationOutcome> {
    return withReadiness(await runInitStages(input, adapters), input, adapters)
}

async function publicationGone(root: string, record: BootstrapStateRecord, adapters: InitApplicationAdapters): Promise<boolean> {
    for (const path of [...record.value.published.map(row => row.path), 'cockpit.toml']) {
        if (!await pathAbsent(root, path, adapters)) return false
    }
    return true
}

// A file is absent when it or any directory above it is; the observation refuses a path whose
// parent is missing, and anything it cannot prove absent counts as present.
async function pathAbsent(root: string, path: string, adapters: InitApplicationAdapters): Promise<boolean> {
    for (let current = path; current !== '.' && current !== '/'; current = dirname(current)) {
        const observed = await adapters.observeDestination({ path: join(root, current), byteLimit: DRAFT_BYTE_LIMIT })
        if (observed.kind !== 'refusal') return observed.kind === 'absent'
    }
    return false
}

// Every stop init makes, the preview included, says which prerequisites are still missing, so the
// setup agent can walk the person through them before the first `up` instead of meeting them one
// refusal at a time; a cockpit was left uncommitted, outside Git or with no installed cockpit while
// init reported success.
async function withReadiness(
    outcome: InitApplicationOutcome,
    input: InitApplicationInput,
    adapters: InitApplicationAdapters,
): Promise<InitApplicationOutcome> {
    const result = outcome.result
    if (!adapters.inspectReadiness || result === null) return outcome
    const configured = result.stage === 'draft-observed' || result.stage === 'environment-verified'
    const estateRoot = estateInput(input).root
    const inspected = await adapters.inspectReadiness({
        root: result.root,
        ...(configured ? { configPath: join(result.root, 'cockpit.toml') } : {}),
        repositories: configured ? [] : (result.estate?.runnable ?? [])
            .map(({ slug, path }) => ({ slug, root: resolve(estateRoot, path) })),
        // A dedicated cockpit folder is created as a Git repository by init itself.
        checkRoot: input.cockpitRoot?.kind !== 'dedicated',
        tools: input.tools,
        ...(result.estate === undefined ? {} : { classification: result.estate.classification }),
    })
    const diagnostics = [...outcome.diagnostics, ...inspected.findings]
    return { ...outcome, diagnostics,
        result: { ...result, readiness: readinessReport(inspected.state, diagnostics, input.tools) } } as InitApplicationOutcome
}

async function runInitStages(
    input: InitApplicationInput,
    adapters: InitApplicationAdapters,
): Promise<InitApplicationOutcome> {
    if (!isAbsolute(input.root) || resolve(input.root) !== input.root) {
        return refused('INIT_ROOT_INVALID', 'init requires one canonical absolute checkout root', input.root)
    }
    if (input.tools[0] !== input.target || new Set(input.tools).size !== input.tools.length) {
        return refused('CLI_USAGE_INVALID', 'init requires distinct tools whose first is the target', '--target')
    }
    if (input.resetAnswer !== undefined && (input.greenfieldAnswer !== undefined || input.accepted)) {
        return refused('INIT_ANSWER_RESET_CONFLICT', 'resetting a recorded answer is a standalone operation')
    }
    if (input.greenfieldAnswer !== undefined && !input.accepted) {
        return refused('GREENFIELD_ANSWER_UNEXPECTED', 'configuration answers require an accepted bootstrap preview')
    }
    const firstSibling = input.cockpitRoot?.kind === 'dedicated' ? input.cockpitRoot.firstSibling : undefined
    if (firstSibling !== undefined && (input.registry !== undefined || !isAbsolute(firstSibling) || resolve(firstSibling) !== firstSibling
        || dirname(firstSibling) !== dirname(input.root) || firstSibling === input.root)) {
        return refused('INIT_ROOT_INVALID', 'a dedicated cockpit root must sit beside the product repository it is created for, without a registry', input.root)
    }
    for (const target of SURFACE_TARGETS) {
        if (target === input.target) continue
        const other = await selectBootstrapStateRoot({ platform: input.platform, home: input.home,
            xdgStateHome: input.xdgStateHome, checkoutRoot: input.root, target, uid: input.uid })
        if (other.kind !== 'complete') return stateFailure(other)
        const priorAddress = other.value.paths.bootstrap(target)
        const prior = await readState(priorAddress)
        if (prior.kind === 'complete') {
            return { kind: 'refusal', status: 2, artifact: null, destination: null, result: null, diagnostics: [{
                ...diagnostic('INIT_TARGET_CHANGED', `bootstrap state is already bound to ${target}`, input.root),
                fix: `to resume the init started for ${target}, run ${initCommand({ root: input.root, target })} with the options you started it with (a root that was removed and recreated starts again from the preview); to use --target ${input.tools.join(',')} instead, ask the person who owns this machine before you delete ${formatShellCommand([priorAddress.path])}, which holds only that init's progress, then run ${initCommand({ root: input.root, target: input.tools.join(',') })}` }] }
        }
        if (prior.kind === 'refusal') return stateFailure(prior)
    }

    const selected = await selectBootstrapStateRoot({ platform: input.platform, home: input.home,
        xdgStateHome: input.xdgStateHome, checkoutRoot: input.root, target: input.target, uid: input.uid })
    if (selected.kind !== 'complete') return stateFailure(selected)
    const namespace = selected.value
    const address = namespace.paths.bootstrap(input.target)
    const read = await readState(address)
    if (read.kind === 'refusal') return stateFailure(read)
    let current = read.kind === 'complete' ? read.value : null
    // State is keyed by the root's path, so it outlives the directory. Resuming into a recreated one
    // reached its sync, which could not authenticate files that were no longer there.
    let restarted: Diagnostic | undefined
    let discarded: BootstrapStateRecord | undefined
    if (current !== null && current.value.stage !== 'surface-previewed' && await publicationGone(input.root, current, adapters)) {
        // A reset would rewrite answers that the restart is about to discard.
        if (input.resetAnswer !== undefined) return { kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
            diagnostics: [{ ...diagnostic('INIT_ANSWER_RESET_UNAVAILABLE', `none of the files init published into ${input.root}, nor cockpit.toml, exist any more, so its recorded answers no longer apply`, address.path),
                fix: `run ${initCommand({ root: input.root, target: input.tools.join(','), args: '--json' })} without --reset-answer: init starts again from the preview` }] }
        restarted = { severity: 'info', code: 'INIT_STATE_RESTARTED', target: address.path,
            message: `none of the files init published into ${input.root}, nor cockpit.toml, exist any more (the directory was removed or recreated, or they were deleted), so init starts again from the preview; the answers recorded there are discarded once the fresh preview is accepted` }
        discarded = current
        current = null
    }
    const outcome = await initStagesFrom(input, adapters, namespace, address, current, discarded)
    return restarted === undefined ? outcome
        : { ...outcome, diagnostics: [restarted, ...outcome.diagnostics] } as InitApplicationOutcome
}

async function initStagesFrom(
    input: InitApplicationInput,
    adapters: InitApplicationAdapters,
    namespace: BootstrapStateNamespace,
    address: BootstrapStateAddress,
    recorded: BootstrapStateRecord | null,
    discarded: BootstrapStateRecord | undefined,
): Promise<InitApplicationOutcome> {
    let current = recorded
    let rootQuestion: CockpitRootQuestion | undefined
    let boundInput = input
    if (current !== null && input.cockpitRoot === undefined && input.registry === undefined) {
        // The command driver starts each invocation before it has rediscovered placement. The
        // accepted command digest restores the placement without reclassifying a genesis root; a
        // dedicated root is named after its product repository, so the remedies that rerun init
        // against the cockpit root resume it too.
        const placements: NonNullable<InitApplicationInput['cockpitRoot']>[] = [{ kind: 'in-repo' },
            ...basename(input.root).endsWith('-cockpit') ? [{ kind: 'dedicated' as const,
                firstSibling: resolve(dirname(input.root), basename(input.root).slice(0, -'-cockpit'.length)) }] : []]
        const accepted = current.value.commandSha256
        boundInput = placements.map(cockpitRoot => ({ ...input, cockpitRoot })).find(candidate => commandDigest(candidate) === accepted) ?? input
    }
    if (current === null && input.cockpitRoot === undefined && input.registry === undefined && adapters.observeRoot) {
        let observed: Awaited<ReturnType<NonNullable<InitApplicationAdapters['observeRoot']>>>
        try { observed = await adapters.observeRoot({ root: input.root }) }
        catch (error) {
            return refused('INIT_ROOT_OBSERVATION_FAILED', `whether ${input.root} is a product repository could not be observed (${errorCause(error)}); fix the named file and rerun ${initCommand({ root: input.root, target: input.tools.join(',') })}`, input.root)
        }
        if (observed === 'product-repository') rootQuestion = cockpitRootQuestion(input.root)
    }
    // Accepting publishes files into the root, so a product repository's root must be chosen first;
    // --accept-preview and --accept-defaults consent to bytes, never to a location. Every durable
    // bootstrap stage follows accepted placement, which init-created files must not reopen on resume.
    if (rootQuestion && input.accepted) return refused('INIT_COCKPIT_ROOT_REQUIRED',
        `${input.root} is a product repository, so where the cockpit lives decides where init writes and is never chosen by default: add cockpit.root = "dedicated" (recommended: creates ${rootQuestion.options[0]!.root}) or cockpit.root = "in-repo" to the --answers file, or run ${initCommand({ root: input.root, target: input.tools.join(','), args: '--interactive' })}`, 'cockpit.root')
    let prepared: PreparedBootstrapOutcome | undefined
    let resumed: ResumedBootstrapOutcome | undefined
    if (current?.value.stage === 'surface-published' || current?.value.stage === 'draft-observed'
        || current?.value.stage === 'environment-verified') {
        resumed = await adapters.resumeBootstrap({ root: input.root, target: input.target, address,
            expectedRevision: current.revision, expectedCommandSha256: current.value.commandSha256 })
        if (resumed.kind === 'refusal') return ownerRefusal(resumed, current.value.stage, recordedProjection(current))
    }
    if (resumed?.kind !== 'complete' && resumed?.kind !== 'refresh') {
        prepared = await adapters.prepareBootstrap({ root: input.root, target: input.target })
        if (prepared.kind !== 'complete') {
            return ownerRefusal(prepared, current?.value.stage ?? 'surface-previewed', current === null ? {
                root: input.root, target: input.target, sources: [], files: [], previewSha256: sha256('unavailable'),
            } : recordedProjection(current))
        }
    }
    let projection: BootstrapProjection
    if (resumed?.kind === 'complete' || resumed?.kind === 'refresh') projection = resumed.result
    else if (prepared?.kind === 'complete') projection = prepared.result
    else return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'selected bootstrap projection is unavailable')
    if (projection.root !== input.root || projection.target !== input.target || !SHA256.test(projection.previewSha256)) {
        return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'selected bootstrap preview does not match the requested root and target')
    }
    const expectedCommand = commandDigest(boundInput)
    const stateMatches = current === null || resumed?.kind === 'refresh'
        ? current === null || current.value.stage === 'surface-published' && current.value.checkoutRoot === projection.root
            && current.value.target === projection.target && current.value.commandSha256 === expectedCommand
        : evidenceMatches(current, projection, expectedCommand)
    if (!stateMatches) {
        return refused('INIT_STATE_STALE', 'bootstrap state does not match the current root, target, command, sources, or preview', address.path)
    }
    if (resumed?.kind === 'refresh' && !input.accepted) return { kind: 'pending', status: 0, artifact: null, destination: null,
        diagnostics: [...resumed.diagnostics], result: result('surface-published', projection) }
    let appliedReset: InitResult['resetAnswer']
    if (input.resetAnswer !== undefined) {
        const reset = await resetBootstrapAnswer(namespace, address, {
            ownerId: bootstrapHolderId({ checkoutId: namespace.checkoutId, sessionId: input.sessionId }),
            field: input.resetAnswer.field, updatedAt: adapters.now(),
            ...(input.resetAnswer.acceptedPreviewSha256 === undefined ? {}
                : { acceptedPreviewSha256: input.resetAnswer.acceptedPreviewSha256 }),
        })
        if (reset.kind === 'refusal') {
            const code = reset.code.replace('BOOTSTRAP_', 'INIT_')
            const fix = code === 'INIT_ANSWER_RESET_UNAVAILABLE' ? resetUnavailableFix(input, current) : undefined
            return { kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
                diagnostics: [{ ...diagnostic(code, reset.message, reset.target), ...(fix === undefined ? {} : { fix }) }] }
        }
        const publicPreview = { ...reset.preview }
        if (reset.kind === 'pending') return { kind: 'pending', status: 0, artifact: null, destination: null,
            diagnostics: [], result: result(current!.value.stage, projection, undefined, { resetAnswer: publicPreview }) }
        current = reset.record
        appliedReset = publicPreview
    }
    if (rootQuestion) return { kind: 'pending', status: 0, artifact: null, destination: null,
        diagnostics: [...(resumed?.diagnostics ?? prepared!.diagnostics)],
        result: result(current?.value.stage ?? 'surface-previewed', projection, undefined, { cockpitRoot: rootQuestion }) }
    if (!input.accepted && (current?.value.greenfield === undefined || current.value.stage !== 'surface-published')) {
        const diagnostics = [...(resumed?.diagnostics ?? prepared!.diagnostics)]
        let interview: InterviewPlan | undefined
        let estate: GreenfieldResult | undefined
        const stage = current?.value.stage ?? 'surface-previewed'
        const recorded = current?.value.greenfield?.answers ?? []
        // Questions are only asked after acceptance, but listing them now lets an unattended caller
        // prepare every answer before it consents. The observation is read-only. Once cockpit.toml is
        // prepared the interview is over, and it still lists the recorded answers: without them a
        // resumed run reported every field of the same answers file as never asked.
        if (boundInput.registry === undefined && adapters.classifyEstate
            && (stage === 'surface-previewed' || stage === 'surface-published' || current?.value.greenfield !== undefined)) {
            const classified = await adapters.classifyEstate(estateInput(boundInput))
            if (classified.kind === 'complete') {
                interview = await interviewPlan(boundInput, adapters, classified.result, recorded.length)
                if (recorded.length > 0) estate = greenfieldResult(classified.result,
                    (classified.result as IssuedEstateClassificationResult).sourceObservationSha256, recorded)
            } else diagnostics.push({ severity: 'warning', code: 'INIT_INTERVIEW_PREVIEW_UNAVAILABLE',
                message: `the interview could not be previewed (${classified.diagnostics.map(row => row.code).join(', ')}); each question is still reported when accepting reaches it`,
                target: input.root })
        }
        return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics,
            result: result(stage, projection, undefined,
                interview === undefined ? undefined : { interview, ...(estate === undefined ? {} : { estate }) }) }
    }
    if (input.accepted && (!SHA256.test(input.acceptedPreviewSha256 ?? '') || input.acceptedPreviewSha256 !== projection.previewSha256)) {
        return refused('INIT_PREVIEW_CHANGED', 'selected bootstrap preview changed after acceptance', input.root)
    }

    if (resumed?.kind === 'refresh') {
        const prior = current!
        const applied = await adapters.applyBootstrap(resumed.authority)
        if (applied.kind !== 'complete') return ownerRefusal(applied, prior.value.stage, projection)
        if (applied.result.root !== projection.root || applied.result.target !== projection.target
            || applied.result.previewSha256 !== projection.previewSha256
            || JSON.stringify(applied.result.files) !== JSON.stringify(projection.files)) {
            return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'refreshed bootstrap result does not match the accepted preview')
        }
        const refreshed = await refreshBootstrapPublication(namespace, address, { ownerId: bootstrapHolderId({
            checkoutId: namespace.checkoutId, sessionId: input.sessionId,
        }), expectedRevision: prior.revision, expectedSources: prior.value.sources,
        expectedCommandSha256: prior.value.commandSha256, expectedPreviewSha256: prior.value.previewSha256,
        expectedPublished: prior.value.published,
        sources: [...projection.sources], previewSha256: projection.previewSha256, published: [...projection.files],
        updatedAt: adapters.now() })
        if (refreshed.kind === 'refusal' && 'reason' in refreshed) return refused('INIT_STATE_STALE',
            `${refreshed.message}; rerun ${initCommand({ root: input.root, target: input.tools.join(',') })} to review the current preview`, address.path)
        if (refreshed.kind !== 'complete') return stateFailure(refreshed)
        current = refreshed.value
    }

    if (current === null) {
        const previewed = discarded === undefined
            ? await persist(namespace, address, boundInput, projection, adapters, 'surface-previewed', null)
            : await restartBootstrapState(namespace, address, { ownerId: bootstrapHolderId({ checkoutId: namespace.checkoutId,
                sessionId: input.sessionId }), expectedRevision: discarded.revision, updatedAt: adapters.now(),
            value: { commandSha256: commandDigest(boundInput), previewSha256: projection.previewSha256, sources: projection.sources } })
        if (previewed.kind === 'stale') return refused('INIT_STATE_STALE',
            `bootstrap state changed while init was restarting it; rerun ${initCommand({ root: input.root, target: input.tools.join(',') })} to review the current preview`, address.path)
        if (previewed.kind !== 'complete') return stateFailure(previewed)
        current = previewed.value
    }
    if (current.value.stage === 'surface-previewed') {
        if (prepared?.kind !== 'complete') {
            return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'selected bootstrap publication authority is unavailable')
        }
        const applied = await adapters.applyBootstrap(prepared.authority)
        if (applied.kind !== 'complete') {
            return ownerRefusal(applied, current.value.stage, projection)
        }
        if (applied.result.root !== projection.root || applied.result.target !== projection.target
            || applied.result.previewSha256 !== projection.previewSha256
            || JSON.stringify(applied.result.files) !== JSON.stringify(projection.files)) {
            return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'published bootstrap result does not match the accepted preview')
        }
        const published = await persist(namespace, address, boundInput, projection, adapters, 'surface-published', current,
            { published: projection.files })
        if (published.kind !== 'complete') return stateFailure(published)
        current = published.value
    }

    const destination = resolve(input.root, 'cockpit.toml')
    if (current.value.stage === 'surface-published') {
        let classification: EstateClassificationResult | undefined
        let sourceObservationSha256: string
        if (boundInput.registry === undefined) {
            if (!adapters.classifyEstate) return { kind: 'pending-dependency', status: 2, artifact: null, destination: null,
                diagnostics: [diagnostic('GREENFIELD_DISCOVERY_UNAVAILABLE', 'greenfield init requires the public estate observation owner')],
                result: result('surface-published', projection) }
            const classified = await adapters.classifyEstate(estateInput(boundInput))
            if (classified.kind !== 'complete') return ownerRefusal(classified, current.value.stage, projection)
            classification = classified.result
            sourceObservationSha256 = (classified.result as IssuedEstateClassificationResult).sourceObservationSha256
            if (!SHA256.test(sourceObservationSha256)) return refused('GREENFIELD_OBSERVATION_INVALID',
                'estate classification omitted its stable source observation digest', input.root)
        } else {
            sourceObservationSha256 = sha256(JSON.stringify({ root: boundInput.root, registry: resolve(boundInput.registry!),
                commandSha256: expectedCommand }))
        }
        let state = current.value.greenfield
        const mode = boundInput.registry === undefined ? 'estate' as const : 'registry' as const
        let staleSourceObservationSha256: string | undefined
        if (state && ((state.mode ?? 'estate') !== mode || state.sourceObservationSha256 !== sourceObservationSha256
            || state.classification !== classification?.classification)) {
            if (mode !== 'estate' || (state.mode ?? 'estate') !== 'estate') {
                return refused('GREENFIELD_OBSERVATION_CHANGED', 'configuration source changed after the interview was persisted', address.path)
            }
            if (state.sourceObservationSha256 === sourceObservationSha256) {
                return refused('GREENFIELD_OBSERVATION_CHANGED',
                    `configuration classification changed while its source observation digest stayed the same; rerun ${initCommand({ root: input.root, target: input.tools.join(',') })} to re-observe the current interview, and report the invariant failure if it persists`, address.path)
            }
            if (input.greenfieldAnswer !== undefined) {
                return refused('GREENFIELD_ANSWER_INVALID',
                    `configuration source changed, so the answer for the earlier pending question was not applied; rerun ${initCommand({ root: input.root, target: input.tools.join(',') })} to review the fresh observation before answering again`, address.path)
            }
            staleSourceObservationSha256 = state.sourceObservationSha256
            state = undefined
        }
        const priorAnswers = state?.answers ?? []
        const proposed = input.greenfieldAnswer
        if (proposed && (!isAnswerProvenance(proposed.provenance) || proposed.bytes.trim() !== proposed.bytes
            || proposed.bytes.length < 1 || proposed.bytes.includes('\0') || Buffer.byteLength(proposed.bytes) > DRAFT_BYTE_LIMIT
            || proposed.questionId !== state?.questions[state.answers.length]?.id)) {
            return refused('GREENFIELD_ANSWER_INVALID', 'configuration answer does not match the next persisted question and provenance', address.path)
        }
        const answers = proposed ? [...priorAnswers, { ...proposed, sha256: sha256(proposed.bytes) }] : [...priorAnswers]
        const documented = await adapters.document({ root: boundInput.root, registry: boundInput.registry, output: destination, ...documentEstate(boundInput),
            configuration: { sourceObservationSha256, ...(classification ? { classification: classification.classification } : {}), answers, tools: input.tools } })
        if (documented.artifact === null) {
            if (proposed && documented.diagnostics.some(row => row.code.startsWith('DOCUMENT_CONFIGURATION_ANSWER')
                || row.code === 'DOCUMENT_DEFAULT_CONFIRMATION_INVALID')) {
                // The owner's diagnostics name the field and the schema reason; dropping them left the operator with no way to correct the answer.
                return { kind: 'refusal', status: 2, artifact: null, destination: null, result: null, diagnostics: [
                    diagnostic('GREENFIELD_ANSWER_INVALID', 'configuration owner rejected the proposed answer', address.path),
                    ...documented.diagnostics] }
            }
            return ownerRefusal(documented, current.value.stage, projection)
        }
        const draftRemedy = `shorten the answers; for a saved answer, from the cockpit root, preview its reset with ${initCommand({ root: input.root, target: input.tools.join(','), args: '--reset-answer <field> --json' })}, then repeat with --accept-reset <previewSha256> before answering again`
        if (Buffer.byteLength(documented.artifact, 'utf8') > DRAFT_BYTE_LIMIT) {
            return refused('INIT_DRAFT_INVALID', `cockpit.toml exceeds the draft byte limit and cannot be offered for confirmation; ${draftRemedy}`, destination)
        }
        const question = documented.question
        if (question) {
            const surfacedQuestion = question.field === 'configuration.defaults'
                ? { ...question, document: documented.artifact.split('\n') } : question
            const expected = state?.questions[state.answers.length]
            if (!proposed && expected && JSON.stringify(expected) !== JSON.stringify(question)) {
                return refused('GREENFIELD_OBSERVATION_CHANGED', 'configuration question changed after it was persisted', address.path)
            }
            const interview = classification ? await interviewPlan(boundInput, adapters, classification, answers.length) : undefined
            const estate = classification ? greenfieldResult(classification, sourceObservationSha256, answers) : undefined
            const pendingResult = result('surface-published', projection, undefined,
                { ...(staleSourceObservationSha256 !== undefined && !input.accepted ? {} : { question: surfacedQuestion }),
                    ...(estate ? { estate } : {}), ...(interview ? { interview } : {}),
                    ...(!input.accepted && appliedReset ? { resetAnswer: appliedReset } : {}) })
            if (snapshotJson(pendingResult) === undefined) {
                return refused('INIT_DRAFT_INVALID', `configuration review cannot be shown exactly within the bounded human output; ${draftRemedy}`, destination)
            }
            if (!input.accepted) return { kind: 'pending', status: 0, artifact: null, destination: null,
                diagnostics: questionNotices(documented.diagnostics), result: pendingResult }
            const questions = [...(state?.questions ?? []),
                ...(state === undefined || proposed && !state.questions.some(row => row.id === question.id) ? [question] : [])]
            const nextState = { ...(mode === 'registry' ? { mode } : {}), stage: 'question-pending' as const, sourceObservationSha256,
                ...(classification ? { classification: classification.classification, notice: classification.notice } : {}), questions, answers }
            const recorded = staleSourceObservationSha256 === undefined
                ? await persist(namespace, address, boundInput, projection, adapters, 'surface-published', current,
                    { published: current.value.published, greenfield: nextState })
                : await refreshBootstrapObservation(namespace, address, {
                    ownerId: bootstrapHolderId({ checkoutId: namespace.checkoutId, sessionId: input.sessionId }),
                    expectedRevision: current.revision,
                    expectedSourceObservationSha256: staleSourceObservationSha256,
                    greenfield: nextState, updatedAt: adapters.now(),
                })
            if (recorded.kind === 'refusal' && 'reason' in recorded) {
                return refused('GREENFIELD_OBSERVATION_CHANGED',
                    `${recorded.message}; rerun ${initCommand({ root: input.root, target: input.tools.join(',') })} to review the fresh observation before answering again`, address.path)
            }
            if (recorded.kind !== 'complete') return stateFailure(recorded)
            return { kind: 'pending', status: 0, artifact: null, destination: null,
                diagnostics: questionNotices(documented.diagnostics), result: pendingResult }
        }
        if (documented.kind !== 'complete') return ownerRefusal(documented, current.value.stage, projection)
        if (documented.destination !== destination) {
            return refused('INIT_DRAFT_INVALID', 'document owner returned an unbound cockpit.toml artifact', destination)
        }
        const resolvedState = { ...(mode === 'registry' ? { mode } : {}), stage: answers.length === 0 ? 'resolved' as const : 'answers-recorded' as const,
            sourceObservationSha256, ...(classification ? { classification: classification.classification,
                notice: classification.notice } : {}),
            questions: [...(state?.questions ?? [])], answers }
        if (!input.accepted && staleSourceObservationSha256 !== undefined) {
            const interview = classification ? await interviewPlan(boundInput, adapters, classification, 0) : undefined
            const estate = classification ? greenfieldResult(classification, sourceObservationSha256, []) : undefined
            return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: documented.diagnostics,
                result: result('surface-published', projection, undefined,
                    { ...(estate ? { estate } : {}), ...(interview ? { interview } : {}) }) }
        }
        if (staleSourceObservationSha256 !== undefined) {
            const refreshed = await refreshBootstrapObservation(namespace, address, {
                ownerId: bootstrapHolderId({ checkoutId: namespace.checkoutId, sessionId: input.sessionId }),
                expectedRevision: current.revision,
                expectedSourceObservationSha256: staleSourceObservationSha256,
                greenfield: resolvedState, updatedAt: adapters.now(),
            })
            if (refreshed.kind === 'refusal' && 'reason' in refreshed) {
                return refused('GREENFIELD_OBSERVATION_CHANGED',
                    `${refreshed.message}; rerun ${initCommand({ root: input.root, target: input.tools.join(',') })} to review the fresh observation before answering again`, address.path)
            }
            if (refreshed.kind !== 'complete') return stateFailure(refreshed)
            current = refreshed.value
        }
        const artifactSha256 = sha256(documented.artifact)
        const persisted = await persist(namespace, address, boundInput, projection, adapters, 'draft-prepared', current, {
            published: current.value.published, destination: 'cockpit.toml', artifactBytes: documented.artifact, artifactSha256,
            greenfield: resolvedState,
        })
        if (persisted.kind !== 'complete') return stateFailure(persisted)
        current = persisted.value
        return { kind: 'artifact', status: 0, artifact: documented.artifact, destination,
            diagnostics: documented.diagnostics, result: result('draft-prepared', projection, undefined, unconfirmedOf(documented)) }
    }

    const persistedConfiguration = current.value.greenfield
    if (!persistedConfiguration) return refused('INIT_DRAFT_SOURCE_CHANGED',
        'persisted cockpit.toml has no source-bound configuration answers', destination)
    const currentDocument = await adapters.document({ root: boundInput.root, registry: boundInput.registry, output: destination, ...documentEstate(boundInput),
        configuration: { sourceObservationSha256: persistedConfiguration.sourceObservationSha256,
            ...(persistedConfiguration.classification ? { classification: persistedConfiguration.classification } : {}),
            answers: persistedConfiguration.answers, tools: input.tools } })
    if (currentDocument.kind !== 'complete') {
        // The answers are bound to the estate init observed; a product edit after the draft breaks
        // that binding, and replaying the same answers cannot rebind it, so a bare rerun refuses again.
        const observed = current.value.stage !== 'draft-prepared'
        const fix = `restore the product files changed since init drafted cockpit.toml, then rerun ${initCommand({ root: input.root, target: input.tools.join(','),
            args: `--accept-preview ${projection.previewSha256}` })}${observed
            ? `; to keep the change instead, finish without init: run ${cockpitCommand('sync', { config: destination })}, then ${cockpitCommand('check', { config: destination })}` : ''}`
        return ownerRefusal({ ...currentDocument, diagnostics: currentDocument.diagnostics.map(row =>
            row.code === 'DOCUMENT_ESTATE_OBSERVATION_CHANGED' ? { ...row, fix,
                message: 'the product files init observed (package manifests, Dockerfile, Compose files) changed after it drafted cockpit.toml, so the recorded answers no longer describe this repository and init will not verify the draft against it' }
                : row) }, current.value.stage, projection)
    }
    if (currentDocument.destination !== destination || currentDocument.artifact !== current.value.artifactBytes
        || sha256(currentDocument.artifact) !== current.value.artifactSha256) {
        return refused('INIT_DRAFT_SOURCE_CHANGED',
            'current configuration sources no longer reproduce the persisted cockpit.toml', destination)
    }

    let draftPublication: StateResult<BootstrapStateRecord> | undefined
    if (current.value.stage === 'draft-prepared') {
        const observed = await adapters.observeDestination({ path: destination, byteLimit: DRAFT_BYTE_LIMIT })
        if (observed.kind === 'refusal') return { kind: 'refusal', status: 2, artifact: null, destination: null,
            diagnostics: observed.diagnostics, result: result(current.value.stage, projection) }
        if (observed.kind === 'absent') {
            return { kind: 'artifact', status: 0, artifact: current.value.artifactBytes!, destination,
                diagnostics: [], result: result('draft-prepared', projection, undefined, unconfirmedOf(currentDocument)) }
        }
        if (observed.sha256 !== current.value.artifactSha256) {
            return refused('INIT_DRAFT_CHANGED', 'existing cockpit.toml bytes differ from the persisted draft', destination)
        }
        const observedState = await persist(namespace, address, boundInput, projection, adapters, 'draft-observed', current)
        if (observedState.kind !== 'complete') return stateFailure(observedState)
        current = observedState.value
        draftPublication = observedState
    }

    if (resumed === undefined) {
        resumed = await adapters.resumeBootstrap({ root: input.root, target: input.target, address })
        if (resumed.kind === 'refusal') return ownerRefusal(resumed, current.value.stage, projection)
        if (resumed.kind === 'complete') {
            projection = resumed.result
            if (!evidenceMatches(current, projection, expectedCommand)
                || projection.previewSha256 !== input.acceptedPreviewSha256) {
                return refused('INIT_STATE_STALE', 'canonical bootstrap ownership does not match the accepted durable state', address.path)
            }
        }
    }
    if (current.value.stage === 'environment-verified' && resumed.kind !== 'complete') {
        return refused('INIT_CANONICAL_OWNERSHIP_MISSING', 'verified bootstrap state has no matching canonical ownership', address.path)
    }
    if (resumed.kind === 'pending' && draftPublication === undefined) {
        const refreshed = await persist(namespace, address, boundInput, projection, adapters, 'draft-observed', current)
        if (refreshed.kind !== 'complete') return stateFailure(refreshed)
        current = refreshed.value
        draftPublication = refreshed
    }
    if (draftPublication !== undefined) {
        const authenticated = authenticateStatePublication({ publication: draftPublication, address })
        if (!authenticated) return refused('INIT_STATE_UNAUTHENTICATED', 'bootstrap state publication could not be authenticated', address.path)
    }
    // From here cockpit.toml is on disk and the recorded answers can no longer be reset, so every stop
    // says how to finish: an agent that met one tried --reset-answer, then ran sync by hand.
    const verificationStop = (outcome: OwnerOutcome): InitApplicationOutcome => {
        const stopped = ownerRefusal(outcome, 'draft-observed', projection, unconfirmedOf(currentDocument))
        return { ...stopped, diagnostics: [...stopped.diagnostics, { severity: 'info', code: 'INIT_VERIFICATION_INCOMPLETE', target: destination,
            message: 'cockpit.toml is written, so its recorded answers can no longer be reset; init stopped while verifying it',
            fix: `correct what the errors above name, changing a cockpit.toml value in cockpit.toml itself, then rerun ${initCommand({ root: input.root,
                target: input.tools.join(','), args: `--accept-preview ${projection.previewSha256}` })} to finish verifying it` }] } as InitApplicationOutcome
    }
    const validation = await adapters.validateConfig(destination)
    if (validation.status !== 0) return verificationStop(validation)
    const synchronized = await adapters.synchronize(resumed.kind === 'complete'
        ? { configPath: destination }
        : { configPath: destination, bootstrapState: { publication: draftPublication!, address } })
    if (synchronized.status !== 0) return verificationStop(synchronized)
    const checked = await adapters.check({ configPath: destination })
    if (checked.status !== 0) return verificationStop(checked)
    const preflight = await adapters.preflight({ configPath: destination })
    // A surfaces-only cockpit has no runtime to preflight. Its refusal is the verified state, and is
    // reported as information so the operator still reads that no runtime is declared.
    const runtimeAbsent = preflight.status !== 0 && preflight.diagnostics.length > 0
        && preflight.diagnostics.every(row => row.code === 'ENVIRONMENT_NOT_DECLARED')
    if (preflight.status !== 0 && !runtimeAbsent) return verificationStop(preflight)
    const verified = await persist(namespace, address, boundInput, projection, adapters, 'environment-verified', current)
    if (verified.kind !== 'complete') return stateFailure(verified)
    return { kind: 'complete', status: 0, artifact: null, destination: null,
        diagnostics: runtimeAbsent ? preflight.diagnostics.map(row => ({ ...row, severity: 'info' as const })) : preflight.diagnostics,
        result: result('environment-verified', projection, undefined, unconfirmedOf(currentDocument)) }
}

// A reset rewrites the interview, which only exists until cockpit.toml is written from it.
function resetUnavailableFix(input: InitApplicationInput, current: BootstrapStateRecord | null): string {
    const resume = (args: string) => initCommand({ root: input.root, target: input.tools.join(','), args })
    switch (current?.value.stage) {
        case 'draft-prepared':
            return `cockpit.toml is already drafted from the recorded answers: rerun ${resume(`--accept-preview ${current.value.previewSha256}`)} to write it, then change the value in cockpit.toml itself and rerun the same command`
        case 'draft-observed':
            return `cockpit.toml is already written from the recorded answers: change the value in cockpit.toml itself, then rerun ${resume(`--accept-preview ${current.value.previewSha256}`)} to finish verifying it`
        case 'environment-verified':
            return `init has finished: change the value in cockpit.toml itself, then run ${cockpitCommand('sync', { config: join(input.root, 'cockpit.toml') })}`
        default:
            return `no answer is recorded yet: run ${resume('--json')} to preview, then answer the interview`
    }
}

/** The review items a finished interview leaves: answers the setup agent chose or no one attributed. */
function unconfirmedOf(document: DocumentOutcome): { unconfirmed?: InitResult['unconfirmed'] } {
    const rows = document.kind === 'complete' ? document.result.unconfirmed : undefined
    return rows === undefined || rows.length === 0 ? {} : { unconfirmed: rows }
}
