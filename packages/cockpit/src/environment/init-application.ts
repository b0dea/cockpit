import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Diagnostic } from '../diagnostics.js'
import type {
    DocumentCommandInput, DocumentOutcome, EstateClassificationOutcome, EstateClassificationResult,
} from '../document/command.js'
import { SURFACE_TARGETS, type SurfaceTarget } from '../surfaces/contract.js'
import { bootstrapHolderId } from './identity.js'
import {
    authenticateStatePublication,
    readState,
    selectBootstrapStateRoot,
    transactState,
    type BootstrapStateAddress,
    type BootstrapStateNamespace,
    type BootstrapStateRecord,
    type SelectBootstrapStateRootInput,
    type StateResult,
} from './state.js'

export const mechanism = {
    id: 'init-application',
    module: 'packages/cockpit/src/environment/init-application.ts',
    exports: ['runInitApplication'],
} as const

const DRAFT_BYTE_LIMIT = 262_144
const SHA256 = /^[a-f0-9]{64}$/

export interface InitApplicationInput {
    readonly root: string
    readonly target: SurfaceTarget
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
        provenance: 'operator-confirmed'
    }>
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
    readonly classifyEstate?: (input: Readonly<{ root: string }>) => Promise<EstateClassificationOutcome>
}

export interface GreenfieldQuestion {
    readonly id: string
    readonly field: string
    readonly source: string
    readonly why: string
    readonly expectedSha256?: string
}

type IssuedEstateClassificationResult = EstateClassificationResult & Readonly<{
    sourceObservationSha256: string
}>

export interface GreenfieldResult extends EstateClassificationResult {
    readonly sourceObservationSha256: string
    readonly answers: readonly Readonly<{
        questionId: string; bytes: string; sha256: string; provenance: 'operator-confirmed'
    }>[]
}

export interface InitResult {
    readonly stage: BootstrapStateRecord['value']['stage']
    readonly root: string
    readonly target: SurfaceTarget
    readonly previewSha256: string
    readonly files: readonly DigestRow[]
    readonly nextCommand: string
    readonly ownerOutcome?: OwnerOutcome
    readonly question?: GreenfieldQuestion
    readonly estate?: GreenfieldResult
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

function diagnostic(code: string, message: string, target?: string): Diagnostic {
    return { severity: 'error', code, message, ...(target === undefined ? {} : { target }) }
}

function refused(code: string, message: string, target?: string): InitApplicationOutcome {
    return { kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: [diagnostic(code, message, target)], result: null }
}

function ownerRefusal(outcome: OwnerOutcome, stage: BootstrapStateRecord['value']['stage'], projection: BootstrapProjection): InitApplicationOutcome {
    return {
        kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: outcome.diagnostics,
        result: result(stage, projection, 'repair the named owner refusal before retrying', outcome),
    }
}

function result(
    stage: BootstrapStateRecord['value']['stage'],
    projection: BootstrapProjection,
    nextCommand: string,
    ownerOutcome?: OwnerOutcome,
    greenfield?: Readonly<{ question?: GreenfieldQuestion; estate?: GreenfieldResult }>,
): InitResult {
    return Object.freeze({ stage, root: projection.root, target: projection.target,
        previewSha256: projection.previewSha256, files: Object.freeze([...projection.files]), nextCommand,
        ...(ownerOutcome === undefined ? {} : { ownerOutcome }),
        ...(greenfield?.question === undefined ? {} : { question: greenfield.question }),
        ...(greenfield?.estate === undefined ? {} : { estate: greenfield.estate }) })
}

function commandDigest(input: InitApplicationInput): string {
    return sha256(JSON.stringify({ root: input.root, target: input.target, registry: input.registry ?? null }))
}

function evidenceMatches(record: BootstrapStateRecord, projection: BootstrapProjection, commandSha256: string): boolean {
    return record.value.checkoutRoot === projection.root
        && record.value.target === projection.target
        && record.value.commandSha256 === commandSha256
        && record.value.previewSha256 === projection.previewSha256
        && JSON.stringify(record.value.sources) === JSON.stringify(projection.sources)
}

function recordedProjection(record: BootstrapStateRecord): BootstrapProjection {
    return Object.freeze({
        root: record.value.checkoutRoot,
        target: record.value.target,
        sources: Object.freeze([...record.value.sources]),
        files: Object.freeze([...record.value.published]),
        previewSha256: record.value.previewSha256,
    })
}

function nextCommand(stage: BootstrapStateRecord['value']['stage']): string {
    if (stage === 'surface-previewed') return 'publish the accepted selected-target bootstrap preview'
    if (stage === 'surface-published') return 'prepare cockpit.toml from the existing registry'
    if (stage === 'draft-prepared') return 'write the exact cockpit.toml artifact'
    if (stage === 'draft-observed') return 'verify the generated environment and preflight'
    return 'bootstrap complete'
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
            nextCommand: nextCommand(stage),
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
    return Object.freeze({ ...classification, sourceObservationSha256, answers: Object.freeze([...answers]) })
}

function stateFailure(outcome: StateResult<unknown>): InitApplicationOutcome {
    if (outcome.kind === 'refusal') return refused(outcome.code, outcome.message, outcome.target)
    return refused('INIT_STATE_DURABILITY_INDETERMINATE', 'bootstrap state durability could not be confirmed')
}

export async function runInitApplication(
    input: InitApplicationInput,
    adapters: InitApplicationAdapters,
): Promise<InitApplicationOutcome> {
    if (!isAbsolute(input.root) || resolve(input.root) !== input.root) {
        return refused('INIT_ROOT_INVALID', 'init requires one canonical absolute checkout root', input.root)
    }
    if (input.greenfieldAnswer !== undefined && !input.accepted) {
        return refused('GREENFIELD_ANSWER_UNEXPECTED', 'configuration answers require an accepted bootstrap preview')
    }
    for (const target of SURFACE_TARGETS) {
        if (target === input.target) continue
        const other = await selectBootstrapStateRoot({ platform: input.platform, home: input.home,
            xdgStateHome: input.xdgStateHome, checkoutRoot: input.root, target, uid: input.uid })
        if (other.kind !== 'complete') return stateFailure(other)
        const prior = await readState(other.value.paths.bootstrap(target))
        if (prior.kind === 'complete') {
            return refused('INIT_TARGET_CHANGED', `bootstrap state is already bound to ${target}`, input.root)
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
    let prepared: PreparedBootstrapOutcome | undefined
    let resumed: ResumedBootstrapOutcome | undefined
    if (current?.value.stage === 'draft-observed' || current?.value.stage === 'environment-verified') {
        resumed = await adapters.resumeBootstrap({ root: input.root, target: input.target, address })
        if (resumed.kind === 'refusal') return ownerRefusal(resumed, current.value.stage, recordedProjection(current))
    }
    if (resumed?.kind !== 'complete') {
        prepared = await adapters.prepareBootstrap({ root: input.root, target: input.target })
        if (prepared.kind !== 'complete') {
            return ownerRefusal(prepared, current?.value.stage ?? 'surface-previewed', current === null ? {
                root: input.root, target: input.target, sources: [], files: [], previewSha256: sha256('unavailable'),
            } : recordedProjection(current))
        }
    }
    let projection: BootstrapProjection
    if (resumed?.kind === 'complete') projection = resumed.result
    else if (prepared?.kind === 'complete') projection = prepared.result
    else return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'selected bootstrap projection is unavailable')
    if (projection.root !== input.root || projection.target !== input.target || !SHA256.test(projection.previewSha256)) {
        return refused('INIT_BOOTSTRAP_IDENTITY_CHANGED', 'selected bootstrap preview does not match the requested root and target')
    }
    const expectedCommand = commandDigest(input)
    if (current !== null && !evidenceMatches(current, projection, expectedCommand)) {
        return refused('INIT_STATE_STALE', 'bootstrap state does not match the current root, target, command, sources, or preview', address.path)
    }
    if (!input.accepted && (current?.value.greenfield === undefined || current.value.stage !== 'surface-published')) {
        return { kind: 'pending', status: 0, artifact: null, destination: null,
            diagnostics: resumed?.diagnostics ?? prepared!.diagnostics,
            result: result(current?.value.stage ?? 'surface-previewed', projection, 'confirm selected bootstrap preview') }
    }
    if (input.accepted && (!SHA256.test(input.acceptedPreviewSha256 ?? '') || input.acceptedPreviewSha256 !== projection.previewSha256)) {
        return refused('INIT_PREVIEW_CHANGED', 'selected bootstrap preview changed after acceptance', input.root)
    }

    if (current === null) {
        const previewed = await persist(namespace, address, input, projection, adapters, 'surface-previewed', null)
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
        const published = await persist(namespace, address, input, projection, adapters, 'surface-published', current,
            { published: projection.files })
        if (published.kind !== 'complete') return stateFailure(published)
        current = published.value
    }

    const destination = resolve(input.root, 'cockpit.toml')
    if (current.value.stage === 'surface-published') {
        let classification: EstateClassificationResult | undefined
        let sourceObservationSha256: string
        if (input.registry === undefined) {
            if (!adapters.classifyEstate) return { kind: 'pending-dependency', status: 2, artifact: null, destination: null,
                diagnostics: [diagnostic('GREENFIELD_DISCOVERY_UNAVAILABLE', 'greenfield init requires the public estate observation owner')],
                result: result('surface-published', projection, 'restore public estate discovery and retry') }
            const classified = await adapters.classifyEstate(Object.freeze({ root: input.root }))
            if (classified.kind !== 'complete') return ownerRefusal(classified, current.value.stage, projection)
            classification = classified.result
            sourceObservationSha256 = (classified.result as IssuedEstateClassificationResult).sourceObservationSha256
            if (!SHA256.test(sourceObservationSha256)) return refused('GREENFIELD_OBSERVATION_INVALID',
                'estate classification omitted its stable source observation digest', input.root)
        } else {
            sourceObservationSha256 = sha256(JSON.stringify({ root: input.root, registry: resolve(input.registry),
                commandSha256: expectedCommand }))
        }
        let state = current.value.greenfield
        const mode = input.registry === undefined ? 'estate' as const : 'registry' as const
        if (state && ((state.mode ?? 'estate') !== mode || state.sourceObservationSha256 !== sourceObservationSha256
            || state.classification !== classification?.classification)) {
            return refused('GREENFIELD_OBSERVATION_CHANGED', 'configuration source changed after the interview was persisted', address.path)
        }
        const priorAnswers = state?.answers ?? []
        const proposed = input.greenfieldAnswer
        if (proposed && (proposed.provenance !== 'operator-confirmed' || proposed.bytes.trim() !== proposed.bytes
            || proposed.bytes.length < 1 || proposed.bytes.includes('\0') || Buffer.byteLength(proposed.bytes) > DRAFT_BYTE_LIMIT
            || proposed.questionId !== state?.questions[state.answers.length]?.id)) {
            return refused('GREENFIELD_ANSWER_INVALID', 'configuration answer does not match the next persisted question and provenance', address.path)
        }
        const answers = proposed ? [...priorAnswers, { ...proposed, sha256: sha256(proposed.bytes) }] : [...priorAnswers]
        const documented = await adapters.document({ root: input.root, registry: input.registry, output: destination,
            configuration: { sourceObservationSha256, ...(classification ? { classification: classification.classification } : {}), answers } })
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
        const question = documented.question
        if (question) {
            const expected = state?.questions[state.answers.length]
            if (!proposed && expected && JSON.stringify(expected) !== JSON.stringify(question)) {
                return refused('GREENFIELD_OBSERVATION_CHANGED', 'configuration question changed after it was persisted', address.path)
            }
            if (!input.accepted) {
                const estate = classification ? greenfieldResult(classification, sourceObservationSha256, answers) : undefined
                return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: documented.diagnostics,
                    result: result('surface-published', projection, 'answer the named unresolved configuration fact', undefined,
                        { question, ...(estate ? { estate } : {}) }) }
            }
            const questions = [...(state?.questions ?? []),
                ...(state === undefined || proposed && !state.questions.some(row => row.id === question.id) ? [question] : [])]
            const nextState = { ...(mode === 'registry' ? { mode } : {}), stage: 'question-pending' as const, sourceObservationSha256,
                ...(classification ? { classification: classification.classification, notice: classification.notice,
                    applicability: classification.applicability } : {}), questions, answers }
            const recorded = await persist(namespace, address, input, projection, adapters, 'surface-published', current,
                { published: current.value.published, greenfield: nextState })
            if (recorded.kind !== 'complete') return stateFailure(recorded)
            const estate = classification ? greenfieldResult(classification, sourceObservationSha256, answers) : undefined
            return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: documented.diagnostics,
                result: result('surface-published', projection, 'answer the named unresolved configuration fact', undefined,
                    { question, ...(estate ? { estate } : {}) }) }
        }
        if (documented.kind !== 'complete') return ownerRefusal(documented, current.value.stage, projection)
        if (documented.destination !== destination || Buffer.byteLength(documented.artifact, 'utf8') > DRAFT_BYTE_LIMIT) {
            return refused('INIT_DRAFT_INVALID', 'document owner returned an unbound or oversized cockpit.toml artifact', destination)
        }
        const resolvedState = { ...(mode === 'registry' ? { mode } : {}), stage: answers.length === 0 ? 'resolved' as const : 'answers-recorded' as const,
            sourceObservationSha256, ...(classification ? { classification: classification.classification,
                notice: classification.notice, applicability: classification.applicability } : {}),
            questions: [...(state?.questions ?? [])], answers }
        const artifactSha256 = sha256(documented.artifact)
        const persisted = await persist(namespace, address, input, projection, adapters, 'draft-prepared', current, {
            published: current.value.published, destination: 'cockpit.toml', artifactBytes: documented.artifact, artifactSha256,
            greenfield: resolvedState,
        })
        if (persisted.kind !== 'complete') return stateFailure(persisted)
        current = persisted.value
        return { kind: 'artifact', status: 0, artifact: documented.artifact, destination,
            diagnostics: documented.diagnostics, result: result('draft-prepared', projection, nextCommand('draft-prepared')) }
    }

    const persistedConfiguration = current.value.greenfield
    if (!persistedConfiguration) return refused('INIT_DRAFT_SOURCE_CHANGED',
        'persisted cockpit.toml has no source-bound configuration answers', destination)
    const currentDocument = await adapters.document({ root: input.root, registry: input.registry, output: destination,
        configuration: { sourceObservationSha256: persistedConfiguration.sourceObservationSha256,
            ...(persistedConfiguration.classification ? { classification: persistedConfiguration.classification } : {}),
            answers: persistedConfiguration.answers } })
    if (currentDocument.kind !== 'complete') return ownerRefusal(currentDocument, current.value.stage, projection)
    if (currentDocument.destination !== destination || currentDocument.artifact !== current.value.artifactBytes
        || sha256(currentDocument.artifact) !== current.value.artifactSha256) {
        return refused('INIT_DRAFT_SOURCE_CHANGED',
            'current configuration sources no longer reproduce the persisted cockpit.toml', destination)
    }

    let draftPublication: StateResult<BootstrapStateRecord> | undefined
    if (current.value.stage === 'draft-prepared') {
        const observed = await adapters.observeDestination({ path: destination, byteLimit: DRAFT_BYTE_LIMIT })
        if (observed.kind === 'refusal') return { kind: 'refusal', status: 2, artifact: null, destination: null,
            diagnostics: observed.diagnostics, result: result(current.value.stage, projection, nextCommand(current.value.stage)) }
        if (observed.kind === 'absent') {
            return { kind: 'artifact', status: 0, artifact: current.value.artifactBytes!, destination,
                diagnostics: [], result: result('draft-prepared', projection, nextCommand('draft-prepared')) }
        }
        if (observed.sha256 !== current.value.artifactSha256) {
            return refused('INIT_DRAFT_CHANGED', 'existing cockpit.toml bytes differ from the persisted draft', destination)
        }
        const observedState = await persist(namespace, address, input, projection, adapters, 'draft-observed', current)
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
        const refreshed = await persist(namespace, address, input, projection, adapters, 'draft-observed', current)
        if (refreshed.kind !== 'complete') return stateFailure(refreshed)
        current = refreshed.value
        draftPublication = refreshed
    }
    if (draftPublication !== undefined) {
        const authenticated = authenticateStatePublication({ publication: draftPublication, address })
        if (!authenticated) return refused('INIT_STATE_UNAUTHENTICATED', 'bootstrap state publication could not be authenticated', address.path)
    }
    const validation = await adapters.validateConfig(destination)
    if (validation.status !== 0) return ownerRefusal(validation, 'draft-observed', projection)
    const synchronized = await adapters.synchronize(resumed.kind === 'complete'
        ? { configPath: destination }
        : { configPath: destination, bootstrapState: { publication: draftPublication!, address } })
    if (synchronized.status !== 0) return ownerRefusal(synchronized, 'draft-observed', projection)
    const checked = await adapters.check({ configPath: destination })
    if (checked.status !== 0) return ownerRefusal(checked, 'draft-observed', projection)
    const preflight = await adapters.preflight({ configPath: destination })
    if (preflight.status !== 0) return ownerRefusal(preflight, 'draft-observed', projection)
    const verified = await persist(namespace, address, input, projection, adapters, 'environment-verified', current)
    if (verified.kind !== 'complete') return stateFailure(verified)
    return { kind: 'complete', status: 0, artifact: null, destination: null,
        diagnostics: preflight.diagnostics, result: result('environment-verified', projection, nextCommand('environment-verified')) }
}
