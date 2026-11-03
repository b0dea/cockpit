import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { initCommand } from '../fix-catalogue.js'
import { readBoundedInput, schemaIssueSummary, STRUCTURED_INPUT_BYTE_LIMIT, unboundHostOperation } from '../config/load.js'
import type { Diagnostic } from '../diagnostics.js'
import { errorCause, snapshotJson, RefusalError, tryParseJson, hasErrorCode } from '../environment/contract.js'
import { judgePostureDeclaration } from '../environment/posture-observation.js'
import { isSensitiveField, redactSensitiveText } from '../environment/sensitive.js'
import { CockpitConfig, GeneratedEnvironment, Guards, InstallPolicy, MachineFloor, Testing, configurationDefaults } from '../schema.js'
import { toSiblingRows } from '../emit.js'
import { gaps, parseRegistry, type DocumentedSibling, type Gap } from './registry.js'
import {
    ANSWER_PROVENANCES, renderCompleteDocument, renderIncompleteDocument, UNCONFIRMED_FIX, unconfirmedReason,
    type AnswerProvenance, type Attribution, type DocumentModel, type UnconfirmableAnswer, type UnconfirmedAnswer,
} from './render.js'
import { COMPOSE_NAMES, NODE_LOCKFILE_NAMES, deriveInferredFacts, readDockerfileFacts, type InferenceResult } from '../init/derive.js'
import { productPackageManifest } from '../team-metadata.js'

export const mechanism = {
    id: 'document-outcome',
    module: 'packages/cockpit/src/document/command.ts',
    exports: ['documentCommand', 'documentObservedCommand', 'classifyEstateObservation', 'observePublicEstate', 'observeCockpitRoot', 'plannedGreenfieldQuestions', 'isAnswerProvenance'],
} as const

/**
 * The directory holding the repositories, and optionally the direct children to observe. A cockpit
 * created beside a product repository observes only that repository in their shared parent, which
 * also holds unrelated checkouts that are not part of this estate. A cockpit kept inside a product
 * repository sets rootIsRepository, so the root's own manifests are observed as the sibling at ".".
 */
export interface EstateObservationInput {
    readonly root: string
    readonly repositories?: readonly string[]
    readonly rootIsRepository?: true
}
type ObservationScope = Readonly<{ root: string; repositories?: readonly string[]; rootIsRepository?: true }>
export interface EstateObservationAdapters {
    readonly observe: (input: EstateObservationInput) => Promise<unknown>
}
export type EstateClassification = 'one-sibling' | 'incomplete-multi-repository'
    | 'no-runnable-product' | 'ready-multi-repository'
export interface EstateClassificationResult {
    readonly classification: EstateClassification
    readonly sourceObservationSha256: string
    readonly notice: string
    readonly gaps: readonly Readonly<{ field: string; source: string; why: string }>[]
    readonly runnable: readonly Readonly<{
        slug: string
        path: string
        disposition: 'confirmed' | 'absent' | 'unknown'
    }>[]
}
export type EstateClassificationOutcome = Readonly<{
    kind: 'complete'; status: 0; diagnostics: readonly Diagnostic[]; result: EstateClassificationResult
}> | Readonly<{
    kind: 'refusal'; status: 2; diagnostics: readonly Diagnostic[]; result: null
}>

interface OutcomeBase {
    artifact: string | null
    destination: string | null
    diagnostics: Diagnostic[]
    result: { document: string; unconfirmed?: readonly UnconfirmedAnswer[] } | null
    status: number
    question?: DocumentConfigurationQuestion | null
}

export interface CompleteDocumentOutcome extends OutcomeBase {
    kind: 'complete'
    artifact: string
    result: { document: string; unconfirmed?: readonly UnconfirmedAnswer[] }
    status: 0
}

export interface GapDraftOutcome extends OutcomeBase {
    kind: 'gap-draft'
    artifact: string
    result: { document: string }
}

export interface SkippedScopeOutcome extends OutcomeBase {
    kind: 'skipped-scope'
    artifact: null
    result: null
}

export interface RefusedDocumentOutcome extends OutcomeBase {
    kind: 'refusal'
    artifact: null
    result: null
}

export type DocumentOutcome =
    | CompleteDocumentOutcome
    | GapDraftOutcome
    | SkippedScopeOutcome
    | RefusedDocumentOutcome

export interface DocumentCommandInput {
    root?: string
    registry?: string
    output?: string
    configuration?: DocumentConfigurationInput
    /** How init observed the estate when it is not the cockpit root's children: a dedicated or an in-repo cockpit. */
    estate?: EstateObservationInput
}

export type DocumentConfigurationField = 'cockpit.name' | 'sibling' | 'estate.runnable' | 'ports.bases'
    | 'environment.install_policies' | 'environment.test_data' | 'environment.generated' | 'environment.machine'
    | 'environment.posture' | 'testing' | 'guards' | 'configuration.defaults'
export interface DocumentConfigurationQuestion {
    readonly id: `question:${string}`
    readonly field: DocumentConfigurationField
    readonly source: string
    readonly why: string
    readonly expectedSha256?: string
}
export type { AnswerProvenance, UnconfirmedAnswer } from './render.js'

export function isAnswerProvenance(value: unknown): value is AnswerProvenance {
    return (ANSWER_PROVENANCES as readonly unknown[]).includes(value)
}
export interface DocumentConfigurationAnswer {
    readonly questionId: string
    readonly bytes: string
    readonly sha256: string
    readonly provenance: AnswerProvenance
}
export interface DocumentConfigurationInput {
    readonly sourceObservationSha256: string
    readonly classification?: EstateClassification
    readonly answers: readonly DocumentConfigurationAnswer[]
}

/** Where an unrecorded value was looked for: a shell registry, or the repositories init observed. */
type DefaultSource = 'registry' | 'estate'
const defaultReason = (field: string, source: DefaultSource) => source === 'registry'
    ? `the registry dialect does not record ${field}; materialised from the CockpitConfig schema default`
    : `no observed repository file declares ${field}; materialised from the CockpitConfig schema default`

// cockpit.toml is committed beside the cockpit's own install, so the directive names that install.
// A path to the package that ran this command would point into one machine's temporary or product tree.
const SCHEMA_DIRECTIVE = './node_modules/@b00dea/cockpit/cockpit.schema.json'

const SCHEMA_ISSUES_SHOWN = 10

function issueSummary(error: { readonly issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
    return schemaIssueSummary(error.issues, SCHEMA_ISSUES_SHOWN)
}

// cockpit.toml loading refuses the same operation, but only after init has written the file, where
// the recorded answers can no longer be reset; the answer is refused here, before anything is written.
function hostOperationRefusal(operation: NonNullable<ReturnType<typeof unboundHostOperation>>, field: string): RefusedDocumentOutcome {
    return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
        `${operation.path} runs "${operation.executable}" on the host, but cockpit runs host operations only with the Node executable that runs cockpit, so this configuration could never be planned`,
        field, 'in the answer, make argv[0] of the host operation "node", or run the command in a service: set location = "in-stack" and service to a generated service whose image has the tool')
}

function refusal(code: string, message: string, target?: string, fix?: string): RefusedDocumentOutcome {
    return {
        kind: 'refusal',
        artifact: null,
        destination: null,
        diagnostics: [{ severity: 'error', code, message, target, fix }],
        result: null,
        status: 2,
    }
}

function estateRefusal(message: string, target = 'estate', fix?: string): EstateClassificationOutcome {
    return Object.freeze({ kind: 'refusal', status: 2, result: null, diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const,
        code: 'DOCUMENT_ESTATE_OBSERVATION_INVALID',
        message,
        target,
        ...(fix === undefined ? {} : { fix }),
    })]) })
}

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/
const SAFE_RELATIVE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/
const MAX_ESTATE_EVIDENCE_BYTES = 1024 * 1024
const MAX_ESTATE_REASON_LENGTH = 512
const MAX_CONFIGURATION_ANSWER_BYTES = 262_144
const LANGUAGE_MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile'] as const
const PUBLIC_RUNNABLE_SOURCES = [...LANGUAGE_MANIFESTS, 'Dockerfile', ...COMPOSE_NAMES] as const
const PACKAGE_RUN_SCRIPTS = ['dev', 'start', 'serve'] as const

interface EstateRepositoryObservation {
    readonly slug: string
    readonly path: string
    readonly evidencePath: string
    readonly runnable: 'confirmed' | 'absent' | 'unknown'
    readonly why?: string
    readonly source: Readonly<{ path: string; sha256: string }>
    readonly sources?: readonly Readonly<{ path: string; sha256: string }>[]
}

interface RepositorySources {
    readonly runnable: EstateRepositoryObservation['runnable']
    readonly reasons: readonly string[]
    readonly sources: readonly Readonly<{ path: string; sha256: string }>[]
}

class EstateSourceObservationError extends RefusalError {
    readonly target: string
    readonly fix: string

    constructor(target: string, message: string) {
        super(message)
        this.target = target
        this.fix = `replace it with one readable regular file under the repository, then rerun ${initCommand()} with the root, target and options you ran it with`
    }
}

function sourceObservationError(repository: string, label: string, source: string, problem: string) {
    const displayed = label === '.' ? source : `${label}/${source}`
    return new EstateSourceObservationError(resolve(repository, source),
        `public runnable source ${displayed} ${problem}; init cannot trust product classification without bounded current source identity`)
}

function boundedReasons(reasons: readonly string[]): string {
    const complete = reasons.join('; ')
    if (complete.length <= MAX_ESTATE_REASON_LENGTH) return complete
    const included: string[] = []
    for (const reason of reasons) {
        const omitted = reasons.length - included.length - 1
        const suffix = omitted === 0 ? '' : `; ${omitted} additional source issue${omitted === 1 ? '' : 's'} omitted`
        if ([...included, reason].join('; ').length + suffix.length > MAX_ESTATE_REASON_LENGTH) break
        included.push(reason)
    }
    const omitted = reasons.length - included.length
    return `${included.join('; ')}${included.length === 0 ? '' : '; '}${omitted} additional source issue${omitted === 1 ? '' : 's'} omitted`
}

/**
 * The digest a source is bound by, or undefined when it is cockpit output rather than product
 * evidence. Sync writes the cockpit's package pin and scripts into the cockpit root's package.json,
 * which for an in-repo cockpit is the product's own manifest; bound as raw bytes, that write made
 * every resumed in-repo init refuse its accepted answers as a changed estate. So a package.json is
 * bound by its parsed content without the entries sync owns, and one holding nothing else is not
 * observed at all. Any other change to a source still changes its digest.
 */
function sourceDigest(manifest: string, bytes: Buffer): string | undefined {
    const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
    if (manifest !== 'package.json') return digest(bytes)
    // A package.json that is not JSON has no product entries to separate, so its raw bytes bind it.
    const parsed = tryParseJson(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return digest(bytes)
    const product = productPackageManifest(parsed as Record<string, unknown>)
    return Object.keys(product).length === 0 ? undefined : digest(JSON.stringify(product))
}

function composeDeclaresServices(text: string): boolean {
    try {
        const document: unknown = parseYaml(text)
        const services = document && typeof document === 'object' && !Array.isArray(document)
            ? (document as Record<string, unknown>).services : undefined
        return !!services && typeof services === 'object' && !Array.isArray(services)
            && Object.keys(services).length > 0
            && Object.values(services).every(service => !!service && typeof service === 'object' && !Array.isArray(service))
    } catch { return false } // The caller's reason names invalid Compose YAML; the parser message would quote file content.
}

/** Reads fixed public runnable sources and reports whether one declares a product process. */
async function observeRepositorySources(repository: string, label: string): Promise<RepositorySources> {
    const sources: { path: string; sha256: string }[] = []
    let runnable: EstateRepositoryObservation['runnable'] = 'absent'
    const reasons: string[] = []
    // Reasons from several repositories are joined into one why, so each names its own file.
    const named = (source: string) => label === '.' ? source : `${label}/${source}`
    for (const manifest of PUBLIC_RUNNABLE_SOURCES) {
        const path = resolve(repository, manifest)
        let bytes: Buffer
        try {
            const stat = await lstat(path)
            if (stat.isSymbolicLink()) throw sourceObservationError(repository, label, manifest, 'is a symbolic link')
            if (!stat.isFile()) throw sourceObservationError(repository, label, manifest, 'is not a regular file')
            if (stat.nlink !== 1) throw sourceObservationError(repository, label, manifest, 'has multiple hard links')
            if (stat.size > MAX_ESTATE_EVIDENCE_BYTES) {
                throw sourceObservationError(repository, label, manifest, 'exceeds the bounded observation size')
            }
            bytes = await readFile(path)
        } catch (error) {
            if (error instanceof EstateSourceObservationError) throw error
            if (hasErrorCode(error, 'ENOENT')) continue
            throw sourceObservationError(repository, label, manifest, 'could not be inspected and read safely')
        }
        if (bytes.byteLength > MAX_ESTATE_EVIDENCE_BYTES) {
            throw sourceObservationError(repository, label, manifest, 'grew beyond the bounded observation size while it was read')
        }
        const sha256 = sourceDigest(manifest, bytes)
        if (sha256 === undefined) continue
        sources.push(Object.freeze({ path: manifest, sha256 }))
        if (manifest === 'Dockerfile') {
            let text: string
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
            catch { // Fatal decoding throws only for invalid UTF-8, which the reason names.
                if (runnable !== 'confirmed') runnable = 'unknown'
                reasons.push(`${named('Dockerfile')} is not valid UTF-8`)
                continue
            }
            if (readDockerfileFacts(text).command) runnable = 'confirmed'
            else {
                if (runnable !== 'confirmed') runnable = 'unknown'
                reasons.push(`${named('Dockerfile')} final stage declares no CMD or ENTRYPOINT`)
            }
            continue
        }
        if ((COMPOSE_NAMES as readonly string[]).includes(manifest)) {
            let text: string
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
            catch { // Fatal decoding throws only for invalid UTF-8, which the reason names.
                if (runnable !== 'confirmed') runnable = 'unknown'
                reasons.push(`${named(manifest)} is not valid UTF-8`)
                continue
            }
            if (composeDeclaresServices(text)) runnable = 'confirmed'
            else {
                if (runnable !== 'confirmed') runnable = 'unknown'
                reasons.push(`${named(manifest)} is not valid Compose YAML with at least one service`)
            }
            continue
        }
        if (manifest !== 'package.json') {
            if (runnable !== 'confirmed') runnable = 'unknown'
            reasons.push(`${named(manifest)} does not declare a supported runnable command`)
            continue
        }
        let parsed: unknown
        try { parsed = JSON.parse(bytes.toString('utf8')) }
        catch { // The reason names invalid JSON; the parser message would quote file content.
            if (runnable !== 'confirmed') runnable = 'unknown'
            reasons.push(`${named('package.json')} is not valid JSON`)
            continue
        }
        const scripts = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).scripts : undefined
        const confirmed = scripts && typeof scripts === 'object' && !Array.isArray(scripts)
            && PACKAGE_RUN_SCRIPTS.some(name => typeof (scripts as Record<string, unknown>)[name] === 'string'
                && ((scripts as Record<string, unknown>)[name] as string).trim().length > 0)
        if (confirmed) runnable = 'confirmed'
        else reasons.push(`${named('package.json')} declares no non-empty dev, start or serve script`)
    }
    return { runnable, reasons, sources }
}

function observationInput(input: EstateObservationInput): ObservationScope | undefined {
    if (!input || typeof input !== 'object' || typeof input.root !== 'string'
        || !isAbsolute(input.root) || resolve(input.root) !== input.root) return undefined
    const keys = Object.keys(input).sort().join(',')
    if (keys === 'root') return { root: input.root }
    if (keys === 'root,rootIsRepository') return input.rootIsRepository === true ? { root: input.root, rootIsRepository: true } : undefined
    if (keys !== 'repositories,root' || !Array.isArray(input.repositories) || input.repositories.length < 1
        || input.repositories.length > 64 || input.repositories.some(name => typeof name !== 'string' || !SAFE_NAME.test(name))
        || new Set(input.repositories).size !== input.repositories.length) return undefined
    return { root: input.root, repositories: Object.freeze([...input.repositories].sort()) }
}

export async function observePublicEstate(input: EstateObservationInput): Promise<unknown> {
    const captured = observationInput(input)
    if (!captured) throw new RefusalError('public estate observation requires one canonical absolute root and optionally named repositories')
    const root = await realpath(captured.root)
    if (root !== captured.root) throw new RefusalError('public estate root is linked or non-canonical')
    const entries = captured.rootIsRepository ? [] : await estateDirectories(root, captured.repositories)
    const repositories: EstateRepositoryObservation[] = []
    if (captured.rootIsRepository) {
        const slug = basename(root)
        if (!SAFE_NAME.test(slug)) throw new RefusalError(`the repository directory name ${JSON.stringify(slug)} is not a valid sibling slug`)
        const { runnable, reasons, sources } = await observeRepositorySources(root, '.')
        const source = sources[0]
        if (source) repositories.push(Object.freeze({ slug, path: '.', evidencePath: source.path, runnable,
            ...(runnable === 'confirmed' ? {} : { why: boundedReasons(reasons) }), source,
            ...(sources.length > 1 ? { sources: Object.freeze(sources) } : {}) }))
    }
    for (const entry of entries) {
        const { runnable, reasons, sources } = await observeRepositorySources(resolve(root, entry.name), entry.name)
        const source = sources[0]
        if (!source) continue
        repositories.push(Object.freeze({ slug: entry.name, path: entry.name, evidencePath: source.path, runnable,
            ...(runnable === 'confirmed' ? {} : { why: boundedReasons(reasons) }), source,
            ...(sources.length > 1 ? { sources: Object.freeze(sources) } : {}) }))
    }
    return Object.freeze({ root, observedAt: new Date().toISOString(), repositories: Object.freeze(repositories) })
}

/**
 * A product repository is a git checkout whose own root carries a public manifest. Running init
 * there must ask where the cockpit lives, because the answer decides where init writes; an empty,
 * documents-only or not-yet-versioned directory simply is the cockpit.
 */
export async function observeCockpitRoot(input: Readonly<{ root: string }>): Promise<'product-repository' | 'cockpit-root'> {
    let git = false
    try {
        await lstat(resolve(input.root, '.git'))
        git = true
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error
    }
    if (!git) return 'cockpit-root'
    const { sources } = await observeRepositorySources(input.root, '.')
    return sources.length > 0 ? 'product-repository' : 'cockpit-root'
}

async function estateDirectories(root: string, only?: readonly string[]) {
    const entries = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && SAFE_NAME.test(entry.name)
            && (only === undefined || only.includes(entry.name)))
        .sort((left, right) => left.name.localeCompare(right.name))
    if (only !== undefined && entries.length !== only.length) {
        throw new RefusalError(`a named estate repository is missing or not a plain directory: ${only.join(', ')}`)
    }
    if (entries.length > 64) throw new RefusalError('public estate contains more than 64 candidate repositories')
    return Promise.all(entries.map(async entry => ({ name: entry.name, stat: await lstat(resolve(root, entry.name)) })))
}

function sourceObservationSha256(root: string, rows: readonly EstateRepositoryObservation[]): string {
    return createHash('sha256').update(JSON.stringify({
        root,
        repositories: rows.map(row => ({
            slug: row.slug,
            path: row.path,
            runnable: row.runnable,
            why: row.why ?? null,
            source: { path: row.source.path, sha256: row.source.sha256 },
            ...(row.sources ? { sources: row.sources } : {}),
        })),
    })).digest('hex')
}

function sameIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function sameStat(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
    return sameIdentity(left, right)
        && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function estateCandidate(value: unknown, root: string): readonly EstateRepositoryObservation[] | undefined {
    const candidate = snapshotJson(value)
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const record = candidate as Record<string, unknown>
    const observedAt = typeof record.observedAt === 'string' ? new Date(record.observedAt) : undefined
    if (Object.keys(record).sort().join(',') !== 'observedAt,repositories,root'
        || record.root !== root || typeof record.observedAt !== 'string'
        || !observedAt || Number.isNaN(observedAt.valueOf()) || observedAt.toISOString() !== record.observedAt
        // No repository is a valid observation: an empty directory or one holding only documents has
        // nothing runnable, and that is answered with a surfaces-only cockpit rather than a refusal.
        // currentEstateRows still refuses an empty list while any candidate directory has a manifest.
        || !Array.isArray(record.repositories) || record.repositories.length > 64) return undefined
    const rows: EstateRepositoryObservation[] = []
    for (const value of record.repositories) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const row = value as Record<string, unknown>
        const runnable = row.runnable
        const keys = ['evidencePath', 'path', 'runnable', 'slug', 'source',
            ...(row.sources === undefined ? [] : ['sources']), ...(runnable === 'confirmed' ? [] : ['why'])].sort().join(',')
        if (Object.keys(row).sort().join(',') !== keys || typeof row.slug !== 'string' || !SAFE_NAME.test(row.slug)
            || typeof row.path !== 'string' || !SAFE_RELATIVE.test(row.path)
            || typeof row.evidencePath !== 'string' || !SAFE_RELATIVE.test(row.evidencePath)
            || runnable !== 'confirmed' && runnable !== 'absent' && runnable !== 'unknown'
            || runnable === 'confirmed' && row.why !== undefined
            || runnable !== 'confirmed' && (typeof row.why !== 'string' || row.why.trim() !== row.why || row.why.length < 1 || row.why.length > MAX_ESTATE_REASON_LENGTH)
            || !row.source || typeof row.source !== 'object' || Array.isArray(row.source)
            || Object.keys(row.source).sort().join(',') !== 'path,sha256') return undefined
        const source = row.source as Record<string, unknown>
        if (source.path !== row.evidencePath || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)
            || typeof row.why === 'string' && redactSensitiveText(row.why) !== row.why) return undefined
        const sources = row.sources
        if (sources !== undefined && (!Array.isArray(sources) || sources.length < 2 || sources.length > PUBLIC_RUNNABLE_SOURCES.length
            || sources.some(value => !value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).sort().join(',') !== 'path,sha256'
                || typeof value.path !== 'string' || !(PUBLIC_RUNNABLE_SOURCES as readonly string[]).includes(value.path)
                || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256))
            || new Set(sources.map(value => value.path)).size !== sources.length
            || sources[0].path !== source.path || sources[0].sha256 !== source.sha256)) return undefined
        rows.push(Object.freeze({ slug: row.slug, path: row.path, evidencePath: row.evidencePath, runnable,
            ...(runnable === 'confirmed' ? {} : { why: row.why as string }),
            source: Object.freeze({ path: source.path, sha256: source.sha256 }),
            ...(sources === undefined ? {} : { sources: Object.freeze(sources.map(value => Object.freeze({ path: value.path as string, sha256: value.sha256 as string }))) }) }))
    }
    if (new Set(rows.map(row => row.slug)).size !== rows.length
        || new Set(rows.map(row => row.path)).size !== rows.length) return undefined
    return Object.freeze(rows)
}

async function currentEstateRows(root: string, rows: readonly EstateRepositoryObservation[], scope: ObservationScope): Promise<boolean | Readonly<{ cause: string }>> {
    try {
        const candidates = scope.rootIsRepository ? [{ name: '.' }] : await estateDirectories(root, scope.repositories)
        for (const directory of candidates) {
            const manifests: string[] = []
            for (const manifest of PUBLIC_RUNNABLE_SOURCES) {
                try {
                    const path = resolve(root, directory.name, manifest)
                    const stat = await lstat(path)
                    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
                        || stat.size > MAX_ESTATE_EVIDENCE_BYTES) return false
                    if (manifest === 'package.json') {
                        const bytes = await readFile(path)
                        if (bytes.byteLength > MAX_ESTATE_EVIDENCE_BYTES) return false
                        if (sourceDigest(manifest, bytes) === undefined) continue
                    }
                    manifests.push(manifest)
                } catch (error) {
                    if (!hasErrorCode(error, 'ENOENT')) throw error
                }
            }
            if (manifests.length === 0) continue
            const row = rows.find(row => row.path === directory.name)
            const observed = row && (row.sources ?? [row.source]).map(source => source.path)
            if (!observed || observed.length !== manifests.length
                || observed.some((path, index) => path !== manifests[index])) return false
        }
        for (const row of rows) {
            const repository = resolve(root, row.path)
            const repositoryRelative = relative(root, repository)
            const ownRoot = row.path === '.' && scope.rootIsRepository === true
            if (!repositoryRelative && !ownRoot || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)
                || await realpath(repository) !== repository) return false
            const repositoryBefore = await lstat(repository)
            if (!repositoryBefore.isDirectory() || repositoryBefore.isSymbolicLink()) return false
            for (const source of row.sources ?? [row.source]) {
                const evidence = resolve(repository, source.path)
                const evidenceRelative = relative(repository, evidence)
                if (!evidenceRelative || evidenceRelative.startsWith(`..${sep}`) || isAbsolute(evidenceRelative)
                    || await realpath(evidence) !== evidence) return false
                const before = await lstat(evidence)
                if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
                    || before.size > MAX_ESTATE_EVIDENCE_BYTES) return false
                const bytes = await readFile(evidence)
                if (bytes.byteLength > MAX_ESTATE_EVIDENCE_BYTES) return false
                const after = await lstat(evidence)
                if (!sameStat(before, after)
                    || sourceDigest(source.path, bytes) !== source.sha256) return false
            }
            if (!(ownRoot ? sameIdentity : sameStat)(repositoryBefore, await lstat(repository))) return false
        }
        return true
    } catch (error) {
        return { cause: errorCause(error) }
    }
}

export async function classifyEstateObservation(
    input: EstateObservationInput,
    adapters: EstateObservationAdapters,
): Promise<EstateClassificationOutcome> {
    let root: string
    let before: Awaited<ReturnType<typeof lstat>>
    let directories: Awaited<ReturnType<typeof estateDirectories>>
    const captured = observationInput(input)
    if (!captured) return estateRefusal('estate classification requires one canonical absolute root and optionally named repositories')
    const only = captured.repositories
    try {
        root = await realpath(captured.root)
        before = await lstat(root)
        if (root !== captured.root || !before.isDirectory() || before.isSymbolicLink()) {
            return estateRefusal('estate root is linked, missing or non-canonical', captured.root)
        }
        directories = captured.rootIsRepository ? [] : await estateDirectories(root, only)
    } catch (error) {
        return estateRefusal((only === undefined ? 'estate root is linked, missing or non-canonical'
            : `estate root is linked, missing or non-canonical, or does not hold ${only.join(', ')} as a plain directory`) + `: ${errorCause(error)}`, captured.root)
    }
    let observed: unknown
    try { observed = await adapters.observe(Object.freeze({ root, ...(only === undefined ? {} : { repositories: only }),
        ...(captured.rootIsRepository ? { rootIsRepository: true as const } : {}) })) }
    catch (error) {
        return error instanceof EstateSourceObservationError
            ? estateRefusal(error.message, error.target, error.fix)
            : estateRefusal('estate observation owner failed', root)
    }
    const rows = estateCandidate(observed, root)
    if (!rows) return estateRefusal('estate observation is malformed, ambiguous, stale or unbound to current source bytes', root)
    const current = await currentEstateRows(root, rows, captured)
    if (current !== true) {
        return estateRefusal(`estate observation is malformed, ambiguous, stale or unbound to current source bytes${typeof current === 'object' ? `: ${current.cause}` : ''}`, root)
    }
    try {
        const currentDirectories = captured.rootIsRepository ? [] : await estateDirectories(root, only)
        if (directories.length !== currentDirectories.length || directories.some((entry, index) =>
            entry.name !== currentDirectories[index]!.name || !sameStat(entry.stat, currentDirectories[index]!.stat))) {
            return estateRefusal('estate candidate directories changed during observation', root)
        }
        const after = await lstat(root)
        if (!(captured.rootIsRepository ? sameIdentity : sameStat)(before, after)) return estateRefusal('estate root changed during observation', root)
    } catch (error) { return estateRefusal(`estate root changed during observation: ${errorCause(error)}`, root) }

    const confirmed = rows.filter(row => row.runnable === 'confirmed')
    const unknown = rows.filter(row => row.runnable === 'unknown')
    const multi = rows.length >= 2
    const classification: EstateClassification = confirmed.length === 0 && unknown.length === 0
        ? 'no-runnable-product' : !multi ? 'one-sibling'
            : unknown.length > 0 ? 'incomplete-multi-repository' : 'ready-multi-repository'
    const gaps = classification === 'no-runnable-product'
        ? [Object.freeze(rows.length === 0
            ? { field: 'runnable-product', source: '.', why: 'no directory under the root carries a supported language manifest, Dockerfile or Compose file' }
            : { field: 'runnable-product', source: rows.map(row => `${row.slug}/${row.source.path}`).join(', '),
                why: rows.map(row => row.why).filter(Boolean).join('; ') })]
        : unknown.map(row => Object.freeze({ field: `${row.slug}.runnable`, source: `${row.slug}/${row.source.path}`, why: row.why! }))
    const result: EstateClassificationResult = Object.freeze({
        classification,
        sourceObservationSha256: sourceObservationSha256(root, rows),
        notice: classification === 'one-sibling'
            ? 'one repository gets the full cockpit: agent instructions, guards, harness settings and its stack; grow it with the sibling add command'
            : classification === 'no-runnable-product'
                ? 'build enough product to run before scaffolding a cockpit environment'
                : classification === 'incomplete-multi-repository'
                    ? 'the estate observation is incomplete and must be resumed from its named gaps'
                    : 'the observed multi-repository estate is ready for harness discovery',
        gaps: Object.freeze(gaps),
        runnable: Object.freeze(rows.map(row => Object.freeze({
            slug: row.slug, path: row.path, disposition: row.runnable,
        }))),
    })
    return Object.freeze({ kind: 'complete', status: 0, diagnostics: Object.freeze([]), result })
}

function buildAttributions(
    model: Pick<DocumentModel, 'name' | 'siblings' | 'defaults'>,
    root: string | undefined,
    source: DefaultSource,
): Attribution[] {
    const attributions: Attribution[] = []
    const defaults = model.defaults
    if (model.name && root) {
        attributions.push({
            target: 'cockpit.name',
            value: model.name,
            from: 'inferred',
            because: 'the positional cockpit root basename was supplied by the operator',
        })
    }
    for (const [target, value, field] of [
        ['cockpit.siblings_root', defaults.cockpit.siblings_root, 'the sibling checkout root'],
        ['cockpit.guide_cap', defaults.cockpit.guide_cap, 'the root guide line cap'],
        ['ports.step', defaults.ports.step, 'the stack port step'],
        ['ports.count', defaults.ports.count, 'the available stack count'],
        // The guard hosts are not here: written, even as [], they record a decision that no
        // non-local host exists, and doctor stops warning GUARD_HOSTS_UNDECLARED.
        ['guards.protected_branches', defaults.guards.protected_branches, 'protected branches'],
        ['guards.allow', defaults.guards.allow, 'allowed commands'],
        ['guards.deny', defaults.guards.deny, 'denied commands'],
        ['mcp.approved', defaults.mcp.approved, 'approved MCP servers'],
        ['workorders.attempt_cap', defaults.workorders.attempt_cap, 'the work-order attempt cap'],
        ['workorders.wip_cap', defaults.workorders.wip_cap, 'the work-order WIP cap'],
    ] as const) {
        attributions.push({ target, value, from: 'default', because: defaultReason(field, source) })
    }
    for (const sibling of model.siblings) {
        if (sibling.mount.from === 'inferred') {
            attributions.push({
                target: `sibling.${sibling.slug}.mount`,
                value: sibling.mount.value,
                from: 'inferred',
                because: sibling.mount.because ?? 'the registry dialect does not record mount directly',
            })
        }
        if (sibling.acquire.from === 'inferred') {
            attributions.push({
                target: `sibling.${sibling.slug}.acquire`,
                value: sibling.acquire.value,
                from: 'inferred',
                because: sibling.acquire.because ?? 'the registry dialect does not record acquisition directly',
            })
        }
        attributions.push({
            target: `sibling.${sibling.slug}.toolchain`,
            value: defaults.sibling.toolchain,
            from: 'default',
            because: defaultReason('a sibling toolchain', source),
        })
        attributions.push({
            target: `sibling.${sibling.slug}.guides`,
            value: defaults.sibling.guides,
            from: 'default',
            because: defaultReason('guide filenames', source),
        })
    }
    return attributions
}

function diagnosticsFor(attributions: readonly Attribution[], unresolved: readonly Gap[]): Diagnostic[] {
    return [
        ...attributions.map((attribution): Diagnostic => ({
            severity: 'info',
            code: attribution.from === 'default' ? 'DOCUMENT_DEFAULT' : 'DOCUMENT_INFERRED',
            message: attribution.because,
            target: attribution.target,
        })),
        ...unresolved.map((gap): Diagnostic => ({
            severity: gap.blocking ? 'error' : 'warning',
            code: 'DOCUMENT_GAP',
            message: gap.why,
            target: `${gap.slug}.${gap.field}`,
            fix: gap.fix ?? (gap.blocking ? 'supply this value before treating the draft as valid' : 'confirm or replace the attributed default'),
        })),
    ]
}

function cockpitName(root?: string): string | undefined {
    const name = root ? basename(root) : undefined
    return name && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined
}

const inferredValue = (inference: InferenceResult | undefined, target: string) =>
    inference?.facts.find(fact => fact.target === target)

function unresolvedGaps(siblings: DocumentedSibling[], name: string | undefined, rootProvided: boolean, inference?: InferenceResult): Gap[] {
    return [
        ...(!name
            ? [{
                slug: 'cockpit',
                field: 'name',
                why: rootProvided
                    ? 'the positional cockpit root basename is not a valid cockpit name'
                    : 'an explicit registry cannot establish the cockpit name',
                blocking: true,
                fix: rootProvided
                    ? 'rename the cockpit root to lowercase letters, digits, and hyphens, or supply the name in the draft'
                    : 'supply this value before treating the draft as valid',
            }]
            : []),
        ...(inferredValue(inference, 'ports.bases') ? []
            : [{ slug: 'ports', field: 'bases', why: 'no registry dialect records the product port map and no Compose file at the cockpit root publishes a host port from a variable with a default', blocking: true }]),
        // A Compose file whose host ports cannot all be read leaves bases that check would refuse.
        ...(inference?.skipped ?? []).filter(row => (COMPOSE_NAMES as readonly string[]).includes(row.source))
            .map(row => ({ slug: 'ports', field: 'bases', why: `${row.source} ${row.reason}`, blocking: true })),
        ...(['hosted_db_hosts', 'vendor_endpoint_hosts'] as const).map(field => ({ slug: 'guards', field, blocking: false,
            why: 'the registry dialect does not record the non-local hosts the guard denies, so the key is left unwritten and doctor warns GUARD_HOSTS_UNDECLARED',
            fix: 'list the database and live vendor API hosts of every non-local environment under [guards], or write both hosted_db_hosts = [] and vendor_endpoint_hosts = [] to record that none exists' })),
        ...gaps(siblings),
    ]
}

/** The registry draft's values read from the cockpit root's own Compose file. */
function composeAttributions(inference: InferenceResult | undefined): Attribution[] {
    return (['ports.bases', 'environment.compose_files'] as const).flatMap(target => {
        const fact = inferredValue(inference, target)
        return fact ? [{ target, value: fact.value, from: 'inferred' as const, because: `${fact.provenance.source}: ${fact.provenance.reason}` }] : []
    })
}

type ConfigurationContext = Readonly<{
    root: string | undefined
    registrySha256: string | null
    sourceObservationSha256: string
    classification: EstateClassification | null
}>

function configurationInput(value: unknown): DocumentConfigurationInput | undefined {
    const candidate = snapshotJson(value)
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const record = candidate as Record<string, unknown>
    const keys = Object.keys(record).sort().join(',')
    if (keys !== 'answers,sourceObservationSha256' && keys !== 'answers,classification,sourceObservationSha256'
        || typeof record.sourceObservationSha256 !== 'string' || !SHA256.test(record.sourceObservationSha256)
        || record.classification !== undefined && !['one-sibling', 'incomplete-multi-repository',
            'no-runnable-product', 'ready-multi-repository'].includes(record.classification as string)
        || !Array.isArray(record.answers) || record.answers.length > 12) return undefined
    const answers: DocumentConfigurationAnswer[] = []
    for (const value of record.answers) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const answer = value as Record<string, unknown>
        if (Object.keys(answer).sort().join(',') !== 'bytes,provenance,questionId,sha256'
            || typeof answer.questionId !== 'string' || !/^question:[a-f0-9]{64}$/.test(answer.questionId)
            || typeof answer.bytes !== 'string' || Buffer.byteLength(answer.bytes) > MAX_CONFIGURATION_ANSWER_BYTES
            || answer.bytes.includes('\0') || redactSensitiveText(answer.bytes) !== answer.bytes
            || typeof answer.sha256 !== 'string' || !SHA256.test(answer.sha256)
            || createHash('sha256').update(answer.bytes).digest('hex') !== answer.sha256
            || !isAnswerProvenance(answer.provenance)) return undefined
        answers.push(Object.freeze({ questionId: answer.questionId, bytes: answer.bytes,
            sha256: answer.sha256, provenance: answer.provenance as AnswerProvenance }))
    }
    return Object.freeze({ sourceObservationSha256: record.sourceObservationSha256,
        ...(record.classification === undefined ? {} : { classification: record.classification as EstateClassification }),
        answers: Object.freeze(answers) })
}

const QUESTION_WHY = {
    name: 'the source does not establish a schema-valid cockpit name',
    nameProposed: 'name the cockpit: the name scopes its Compose projects, state and generated files, and renaming it after the first sync means bringing the stack down and syncing again; the cockpit root directory name is proposed',
    siblingEstate: 'the source does not establish schema-shaped sibling declarations',
    siblingRegistry: 'the registry leaves required sibling configuration unresolved',
    ports: 'no source establishes the host-published base port map; an explicit empty map means none',
    policies: 'declare the exact dependency install protocols: toolchains, volumes, lockfiles, install and load probes, and any build or test commands',
    testData: 'answer with exactly { seeded_data: boolean, signed_in_users: boolean } to state whether this local setup needs seeded data and signed-in users; each false field records a precise not-declared decision, while true keeps the product-owned declaration work visible without claiming that data or authentication exists',
    generated: 'declare the exact generated environment: compose path, services, pinned images, commands, health probes, mounts, data modes, fixtures, volumes, vendors, decisions, and their provenance; or, to run a Compose file the checkout already has, answer environment.compose_files instead: compose_files = ["compose.yml"] under [environment] in an answers file, or { "compose_files": ["compose.yml"] } typed at this question',
    machine: 'declare the machine floor the product needs from the container runtime: runtime_memory_mb, runtime_cpus, free_disk_mb and cold_start_seconds; these are product requirements a person states: cockpit never proposes them, because no product file records them and this machine\'s capacity is not what the product needs',
    posture: `preflight refuses a runtime until its posture is declared: addressing is "port" (localhost:<port>) or "hostname"; authentication is "none" (no sign-in), "bypassed" (sign-in turned off locally) or "real"; posture_requirements names what depends on them, each tagged with the posture it needs. For a plain localhost stack with no sign-in, answer ${JSON.stringify({ addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] })}`,
    testing: 'declare the product\'s test commands as [testing] stages and gates: a targeted gate agents run while iterating and a full gate they run before handing back shared changes; init proposes them from test entry points it finds on disk. Answer "none" when the product has no tests yet: no work can then be graded PASS, and doctor warns until gates are declared',
    guards: 'name the database hosts and live vendor API hosts of every non-local environment the product has (production, staging, shared dev or QA): cockpit runs only locally, so the guard denies agent commands that reach them; answer { "hosted_db_hosts": [], "vendor_endpoint_hosts": [] } to record that none exists',
    defaults: 'confirm the exact surfaced inferred and schema-default values before completing the document',
} as const

/** How a decision comment attributes an answer, so a value the agent chose never reads as one a person stated. */
const STATED_BY: Readonly<Record<AnswerProvenance, string>> = {
    'operator-confirmed': 'the operator stated that',
    'agent-default': 'the setup agent assumed, as a default, that',
    unattributed: 'the answers file, without saying who chose it, states that',
}
const noGuardHostsDecision = (provenance: AnswerProvenance) =>
    `${STATED_BY[provenance]} no non-local environment (production, staging, shared) has a database or live vendor host for the guard to deny`

const runnableWhy = (gaps: EstateClassificationResult['gaps']) =>
    `resolve the exact current runnable gaps: ${gaps.map(gap => `${gap.field} from ${gap.source}`).join('; ')}`

/**
 * The questions a greenfield estate interview asks, in order. Init lists them before any answer
 * exists so an unattended caller can prepare every answer in one pass; the loop in
 * completeConfigurationDocument asks the same questions in the same order.
 */
export function plannedGreenfieldQuestions(input: Readonly<{
    root: string
    classification: EstateClassification
    gaps: EstateClassificationResult['gaps']
}>): readonly Readonly<{ field: DocumentConfigurationField; why: string }>[] {
    const surfacesOnly = input.classification === 'no-runnable-product'
    return Object.freeze([
        { field: 'cockpit.name' as const, why: cockpitName(input.root) ? QUESTION_WHY.nameProposed : QUESTION_WHY.name },
        { field: 'sibling' as const, why: QUESTION_WHY.siblingEstate },
        ...(!surfacesOnly && input.gaps.length > 0 ? [{ field: 'estate.runnable' as const, why: runnableWhy(input.gaps) }] : []),
        { field: 'ports.bases' as const, why: QUESTION_WHY.ports },
        ...(surfacesOnly ? [] : [
            { field: 'environment.install_policies' as const, why: QUESTION_WHY.policies },
            { field: 'environment.test_data' as const, why: QUESTION_WHY.testData },
            { field: 'environment.generated' as const, why: QUESTION_WHY.generated },
            { field: 'environment.machine' as const, why: QUESTION_WHY.machine },
            { field: 'environment.posture' as const, why: QUESTION_WHY.posture },
            { field: 'testing' as const, why: QUESTION_WHY.testing },
        ]),
        // Asked even with nothing to run: the guard governs the agent's commands, not the runtime.
        { field: 'guards' as const, why: QUESTION_WHY.guards },
        { field: 'configuration.defaults' as const, why: QUESTION_WHY.defaults },
    ])
}

/** Compose-first answer: the repository already has Compose files, so no generated environment is rendered. */
function composeFilesAnswer(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return Object.keys(value).join(',') === 'compose_files' ? (value as { compose_files: unknown }).compose_files : undefined
}

function configurationQuestion(
    context: ConfigurationContext,
    field: DocumentConfigurationField,
    why: string,
    expectedSha256?: string,
): DocumentConfigurationQuestion {
    const digest = createHash('sha256').update(JSON.stringify({ ...context, field, expectedSha256: expectedSha256 ?? null })).digest('hex')
    return Object.freeze({ id: `question:${digest}`, field,
        source: `configuration:${context.sourceObservationSha256}`,
        why, ...(expectedSha256 === undefined ? {} : { expectedSha256 }) })
}

function readConfigurationAnswer(
    answers: readonly DocumentConfigurationAnswer[],
    index: number,
    question: DocumentConfigurationQuestion,
): { kind: 'pending' } | { kind: 'answer'; value: unknown; provenance: AnswerProvenance } | { kind: 'refusal'; outcome: RefusedDocumentOutcome } {
    const answer = answers[index]
    if (!answer) return { kind: 'pending' }
    if (answer.questionId !== question.id) return { kind: 'refusal', outcome: refusal(
        'DOCUMENT_CONFIGURATION_ANSWER_STALE',
        'the operator answer does not match the current source-bound question',
        question.field,
    ) }
    try {
        const value: unknown = JSON.parse(answer.bytes)
        if (containsSensitiveField(value)) return { kind: 'refusal', outcome: refusal(
            'DOCUMENT_CONFIGURATION_ANSWER_INVALID', 'operator answers cannot contain sensitive fields', question.field,
        ) }
        return { kind: 'answer', value, provenance: answer.provenance }
    }
    catch { return { kind: 'refusal', outcome: refusal( // The parser message would quote the operator's answer.
        'DOCUMENT_CONFIGURATION_ANSWER_INVALID', 'the operator answer is not valid JSON', question.field,
    ) } }
}

function containsSensitiveField(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(containsSensitiveField)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value as Record<string, unknown>)
        .some(([key, nested]) => isSensitiveField(key) || containsSensitiveField(nested))
}

function questionGap(question: DocumentConfigurationQuestion): Gap {
    const [slug, ...field] = question.field.split('.')
    return { slug: slug!, field: field.join('.') || question.field, why: question.why, blocking: true }
}

function pendingConfiguration(
    model: DocumentModel,
    destination: string | null,
    question: DocumentConfigurationQuestion,
    configuration?: CockpitConfig,
): GapDraftOutcome {
    const unresolved = [questionGap(question)]
    const artifact = renderIncompleteDocument({ ...model, gaps: unresolved }, SCHEMA_DIRECTIVE, configuration)
    return {
        kind: 'gap-draft', artifact, destination, diagnostics: diagnosticsFor(model.attributions, unresolved),
        result: { document: artifact }, status: 2, question,
    }
}

function sameDetectedSibling(answered: Record<string, unknown>, detected: Record<string, unknown>): boolean {
    return Object.entries(detected).every(([key, value]) => JSON.stringify(answered[key]) === JSON.stringify(value))
}

/** undefined for a registry source; otherwise the observed repository directory, relative to the cockpit root. */
type GreenfieldSiblingsRoot = string | undefined

function inferGreenfieldSiblingRoot(attributions: Attribution[], siblingsRoot: GreenfieldSiblingsRoot): Attribution[] {
    if (siblingsRoot === undefined) return attributions
    const index = attributions.findIndex(row => row.target === 'cockpit.siblings_root')
    if (index >= 0) attributions.splice(index, 1)
    attributions.push({ target: 'cockpit.siblings_root', value: siblingsRoot, from: 'inferred',
        because: siblingsRoot === '.'
            ? 'the authenticated greenfield estate repositories are direct children of the cockpit root'
            : 'the cockpit was created beside the product repository, so the authenticated estate repositories are children of the cockpit root\'s parent' })
    return attributions
}

/** Why an estate sibling's toolchain is the schema default, naming the lockfile read when one was. */
function estateToolchainReason(slug: string, directory: string, inference: InferenceResult | undefined): string {
    const fact = inferredValue(inference, `${slug}.toolchain`)
    return fact
        ? `${fact.provenance.source} proposes the ${String(fact.value)} toolchain, but the sibling answer leaves toolchain unset; materialised from the CockpitConfig schema default`
        : `no lockfile that maps to a toolchain (${NODE_LOCKFILE_NAMES.join(', ')}) was found in ${directory}, so no sibling toolchain is proposed; materialised from the CockpitConfig schema default`
}

function defaultAttributions(
    defaults: ReturnType<typeof configurationDefaults>,
    siblings: readonly Record<string, unknown>[],
    detected: readonly DocumentedSibling[],
    root: string | undefined,
    source: DefaultSource,
    siblingsRoot: GreenfieldSiblingsRoot = undefined,
    inference?: InferenceResult,
): Attribution[] {
    // The name is always an answer, so it is never surfaced as an inferred value to confirm.
    const attributions = buildAttributions({ siblings: detected, defaults }, root, source)
        .filter(row => !row.target.startsWith('sibling.') || row.from !== 'default')
    for (const [field, value] of Object.entries(defaults.environment)) {
        if (field !== 'install_policies') attributions.push({ target: `environment.${field}`, value, from: 'default',
            because: defaultReason(`the environment ${field} declaration`, source) })
    }
    attributions.push({ target: 'surfaces', value: defaults.surfaces, from: 'default',
        because: defaultReason('the surfaces declaration', source) })
    for (const sibling of siblings) {
        for (const field of ['toolchain', 'guides'] as const) if (!(field in sibling)) {
            attributions.push({ target: `sibling.${String(sibling.slug)}.${field}`,
                value: defaults.sibling[field], from: 'default', because: field === 'toolchain' && source === 'estate' && root
                    ? estateToolchainReason(String(sibling.slug), relative(root, resolve(root, siblingsRoot ?? '.', String(sibling.dir))) || '.', inference)
                    : defaultReason(`a sibling ${field}`, source) })
        }
    }
    return inferGreenfieldSiblingRoot(attributions, siblingsRoot)
}

function confirmationDigest(attributions: readonly Attribution[]): string {
    return createHash('sha256').update(JSON.stringify(attributions
        .map(({ target, value, from }) => ({ target, value, from })))).digest('hex')
}

function documentedRows(rows: CockpitConfig['sibling']): DocumentedSibling[] {
    return rows.map(row => ({ slug: row.slug, dir: row.dir, ...(row.remote ? { remote: row.remote } : {}),
        ...(row.branch ? { branch: row.branch } : {}), mount: { value: row.mount, from: 'read' },
        acquire: { value: row.acquire, from: 'read' }, var: row.var, purpose: row.purpose }))
}

async function completeConfigurationDocument(
    input: DocumentCommandInput,
    root: string | undefined,
    registrySha256: string | null,
    detected: readonly DocumentedSibling[],
    estateGaps: EstateClassificationResult['gaps'] = [],
    estateRunnable: EstateClassificationResult['runnable'] = [],
): Promise<DocumentOutcome> {
    const configuration = configurationInput(input.configuration)
    if (!configuration) return refusal('DOCUMENT_CONFIGURATION_INVALID',
        'configuration completion requires bounded source-bound operator-confirmed answers')
    // Nothing runnable is no reason to withhold agent surfaces. Such a cockpit declares no runtime,
    // so the interview skips every environment question and the result says that runtime is absent.
    const surfacesOnly = configuration.classification === 'no-runnable-product'
    if (configuration.classification === 'incomplete-multi-repository' && estateGaps.length === 0) return refusal(
        'DOCUMENT_ESTATE_INCOMPLETE',
        'resolve every named repository runnable gap before scaffolding a cockpit configuration',
    )
    if (detected.length === 0 && !root) return refusal(
        'DOCUMENT_SOURCE_REQUIRED', 'greenfield configuration completion requires one canonical root')

    const context: ConfigurationContext = Object.freeze({ root, registrySha256,
        sourceObservationSha256: configuration.sourceObservationSha256,
        classification: configuration.classification ?? null })
    const defaults = configurationDefaults()
    const defaultSource: DefaultSource = registrySha256 !== null ? 'registry' : 'estate'
    const siblingsRoot: GreenfieldSiblingsRoot = registrySha256 !== null ? undefined
        : input.estate && root ? relative(root, input.estate.root) || '.' : '.'
    const destination = input.output ? resolve(input.output) : null
    let answerIndex = 0
    let siblingRows: CockpitConfig['sibling'] | undefined
    let siblingAnswerRows: readonly Record<string, unknown>[] = []
    // Every answer a person did not state is listed in cockpit.toml, so it never reads as theirs.
    const unconfirmed: UnconfirmedAnswer[] = []
    const record = (field: UnconfirmableAnswer, provenance: AnswerProvenance) => {
        if (provenance !== 'operator-confirmed') unconfirmed.push(Object.freeze({ field, provenance }))
    }

    // Always asked, with the directory name as the proposal: the name scopes Compose projects, state
    // and generated files, so renaming after sync is a migration, and setup agents that were never
    // asked renamed the cockpit by hand afterwards.
    const proposedName = cockpitName(root)
    const nameQuestion = configurationQuestion(context, 'cockpit.name', proposedName ? QUESTION_WHY.nameProposed : QUESTION_WHY.name)
    const nameRead = readConfigurationAnswer(configuration.answers, answerIndex, nameQuestion)
    if (nameRead.kind === 'pending') return pendingConfiguration({ name: proposedName, defaults, siblings: detected,
        attributions: inferGreenfieldSiblingRoot(
            buildAttributions({ name: proposedName, defaults, siblings: detected }, root, defaultSource), siblingsRoot), gaps: [] }, destination, nameQuestion)
    if (nameRead.kind === 'refusal') return nameRead.outcome
    const parsedName = CockpitConfig.shape.cockpit.safeParse({ ...defaults.cockpit, name: nameRead.value })
    if (!parsedName.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
        `the cockpit name answer does not match the schema: ${issueSummary(parsedName.error)}`, nameQuestion.field)
    const name = parsedName.data.name
    record('cockpit.name', nameRead.provenance)
    answerIndex += 1

    const detectedRows = toSiblingRows(detected)
    const needsSiblingAnswer = detected.length === 0 || gaps([...detected]).some(gap => gap.blocking)
    if (needsSiblingAnswer) {
        const question = configurationQuestion(context, 'sibling', detected.length === 0
            ? QUESTION_WHY.siblingEstate : QUESTION_WHY.siblingRegistry)
        const read = readConfigurationAnswer(configuration.answers, answerIndex, question)
        if (read.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: detected,
            attributions: inferGreenfieldSiblingRoot(
                buildAttributions({ defaults, siblings: detected }, root, defaultSource), siblingsRoot), gaps: [] }, destination, question)
        if (read.kind === 'refusal') return read.outcome
        if (!Array.isArray(read.value) || read.value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
            return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                'the operator-confirmed sibling answer must be an array of schema-shaped declarations', question.field)
        }
        siblingAnswerRows = read.value as Record<string, unknown>[]
        const parsed = CockpitConfig.shape.sibling.safeParse(read.value)
        if (!parsed.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            `the operator-confirmed sibling declarations do not match the schema: ${issueSummary(parsed.error)}`, question.field)
        if (detectedRows.some((row, index) => !siblingAnswerRows[index]
            || !sameDetectedSibling(siblingAnswerRows[index]!, row)) || detectedRows.length > siblingAnswerRows.length) {
            return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                'the operator-confirmed sibling declarations are invalid or change detected registry facts', question.field)
        }
        const hostOperation = parsed.data.reduce<ReturnType<typeof unboundHostOperation>>((found, row, index) =>
            found ?? unboundHostOperation(row.derives?.generated, ['sibling', String(index), 'derives', 'generated']), undefined)
        if (hostOperation) return hostOperationRefusal(hostOperation, question.field)
        siblingRows = parsed.data
        record('sibling', read.provenance)
        answerIndex += 1
    } else {
        const parsed = CockpitConfig.shape.sibling.safeParse(detectedRows)
        if (!parsed.success) return refusal('DOCUMENT_CONFIGURATION_INVALID',
            `detected registry sibling facts do not satisfy the configuration schema: ${issueSummary(parsed.error)}`, 'sibling')
        siblingRows = parsed.data
        siblingAnswerRows = detectedRows
    }

    // Read with the same inference init proposed from, so a defaulted toolchain names the lockfile it overrode.
    const inference = defaultSource === 'estate' && root ? await deriveInferredFacts({ root: resolve(root, siblingsRoot ?? '.'),
        configurationRoot: root, repositories: siblingRows.map(row => ({ slug: row.slug, path: row.dir })) }) : undefined

    if (estateRunnable.length > 0) {
        const dispositionSlugs = estateRunnable.map(row => row.slug)
        const siblingSlugs = siblingRows.map(row => row.slug)
        if (new Set(dispositionSlugs).size !== dispositionSlugs.length
            || [...dispositionSlugs].sort().join(',') !== [...siblingSlugs].sort().join(',')
            || estateRunnable.some(disposition => siblingRows.find(row => row.slug === disposition.slug)?.dir !== disposition.path)) {
            // Naming only the code left a setup agent that had declared every repository beside an
            // in-repo cockpit with no way to tell which declaration init would not accept.
            const observed = estateRunnable.map(row => `${row.slug} (dir ${JSON.stringify(row.path)})`)
            const declared = siblingRows.map(row => `${row.slug} (dir ${JSON.stringify(row.dir)})`)
            const unobserved = declared.filter(row => !observed.includes(row))
            const undeclared = observed.filter(row => !declared.includes(row))
            return refusal('DOCUMENT_ESTATE_TOPOLOGY_MISMATCH',
                `the sibling answer must declare exactly the repositories init observed (${observed.join(', ')})${
                    unobserved.length === 0 ? '' : `; it declares ${unobserved.join(', ')}, which init did not observe`}${
                    undeclared.length === 0 ? '' : `; it omits ${undeclared.join(', ')}`}${
                    input.estate === undefined ? '' : '; a cockpit inside or beside a product repository starts with that repository alone'}`,
                'sibling',
                'declare one sibling for each repository the message says init observed, with that slug and dir, and no other; add any other repository after init with npx --no cockpit sibling add <slug> --config <your cockpit.toml>',
            )
        }
    }

    const runnableResolutions = new Map<string, Readonly<{ runnable: boolean; service?: string; command?: readonly string[] }>>()
    if (!surfacesOnly && estateGaps.length > 0) {
        const slugs = estateGaps.map(gap => /^([a-z][a-z0-9-]{0,63})\.runnable$/.exec(gap.field)?.[1])
        if (slugs.some(slug => !slug) || new Set(slugs).size !== slugs.length) return refusal(
            'DOCUMENT_ESTATE_GAPS_INVALID', 'the current estate runnable gaps are malformed or duplicated')
        const question = configurationQuestion(context, 'estate.runnable', runnableWhy(estateGaps))
        const read = readConfigurationAnswer(configuration.answers, answerIndex, question)
        if (read.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: documentedRows(siblingRows),
            attributions: defaultAttributions(defaults, siblingAnswerRows, detected, root, defaultSource, siblingsRoot, inference), gaps: [] },
            input.output ? resolve(input.output) : null, question)
        if (read.kind === 'refusal') return read.outcome
        if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)
            || Object.keys(read.value).sort().join(',') !== [...slugs].sort().join(',')) return refusal(
            'DOCUMENT_CONFIGURATION_ANSWER_INVALID', 'the runnable answer must resolve every current gap exactly once', question.field)
        for (const slug of slugs as string[]) {
            const resolution = (read.value as Record<string, unknown>)[slug]
            if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return refusal(
                'DOCUMENT_CONFIGURATION_ANSWER_INVALID', 'each runnable gap requires one schema-shaped disposition', question.field)
            const row = resolution as Record<string, unknown>
            if (row.runnable === false && Object.keys(row).join(',') === 'runnable') {
                runnableResolutions.set(slug, Object.freeze({ runnable: false }))
                continue
            }
            if (row.runnable !== true || Object.keys(row).sort().join(',') !== 'command,runnable,service'
                || typeof row.service !== 'string' || !SAFE_NAME.test(row.service)
                || !Array.isArray(row.command) || row.command.length < 1 || row.command.length > 32
                || row.command.some(part => typeof part !== 'string' || part.length < 1 || part.length > 4096)) return refusal(
                'DOCUMENT_CONFIGURATION_ANSWER_INVALID', 'runnable dispositions require an exact service identity and command argv', question.field)
            runnableResolutions.set(slug, Object.freeze({ runnable: true, service: row.service,
                command: Object.freeze([...row.command] as string[]) }))
        }
        if (configuration.classification === 'one-sibling'
            && [...runnableResolutions.values()].every(row => !row.runnable)) return refusal(
            'DOCUMENT_NO_RUNNABLE_PRODUCT', 'the operator-confirmed estate contains no runnable product', question.field)
        record('estate.runnable', read.provenance)
        answerIndex += 1
    }

    const portQuestion = configurationQuestion(context, 'ports.bases', QUESTION_WHY.ports)
    const portRead = readConfigurationAnswer(configuration.answers, answerIndex, portQuestion)
    const previewRows = documentedRows(siblingRows)
    const attributions = defaultAttributions(defaults, siblingAnswerRows, detected, root, defaultSource, siblingsRoot, inference)
    if (portRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
        attributions, gaps: [] }, destination, portQuestion)
    if (portRead.kind === 'refusal') return portRead.outcome
    const parsedPorts = CockpitConfig.shape.ports.safeParse({ ...defaults.ports, bases: portRead.value })
    if (!parsedPorts.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
        `the operator-confirmed port bases do not match the schema: ${issueSummary(parsedPorts.error)}`, portQuestion.field)
    record('ports.bases', portRead.provenance)
    answerIndex += 1

    let environment = defaults.environment
    let testData: Readonly<{ seeded_data: boolean; signed_in_users: boolean; provenance: AnswerProvenance }> | undefined
    let testing: Testing | undefined
    let testingNone: AnswerProvenance | undefined
    if (!surfacesOnly) {
        const policyQuestion = configurationQuestion(context, 'environment.install_policies', QUESTION_WHY.policies)
        const policyRead = readConfigurationAnswer(configuration.answers, answerIndex, policyQuestion)
        if (policyRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
            attributions, gaps: [] }, destination, policyQuestion)
        if (policyRead.kind === 'refusal') return policyRead.outcome
        const parsedPolicies = InstallPolicy.array().max(256).safeParse(policyRead.value)
        if (!parsedPolicies.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            `the operator-confirmed dependency install protocols do not match the schema: ${issueSummary(parsedPolicies.error)}`,
            policyQuestion.field)
        record('environment.install_policies', policyRead.provenance)
        answerIndex += 1

        if (registrySha256 === null) {
            const testDataQuestion = configurationQuestion(context, 'environment.test_data', QUESTION_WHY.testData)
            const testDataRead = readConfigurationAnswer(configuration.answers, answerIndex, testDataQuestion)
            if (testDataRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
                attributions, gaps: [] }, destination, testDataQuestion)
            if (testDataRead.kind === 'refusal') return testDataRead.outcome
            const value = testDataRead.value
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).sort().join(',') !== 'seeded_data,signed_in_users'
                || typeof (value as Record<string, unknown>).seeded_data !== 'boolean'
                || typeof (value as Record<string, unknown>).signed_in_users !== 'boolean') return refusal(
                'DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                'the local test-data answer must be exactly { seeded_data: boolean, signed_in_users: boolean }',
                testDataQuestion.field,
            )
            testData = Object.freeze({ seeded_data: (value as { seeded_data: boolean }).seeded_data,
                signed_in_users: (value as { signed_in_users: boolean }).signed_in_users, provenance: testDataRead.provenance })
            record('environment.test_data', testDataRead.provenance)
            answerIndex += 1
        }

        const generatedQuestion = configurationQuestion(context, 'environment.generated', QUESTION_WHY.generated)
        const generatedRead = readConfigurationAnswer(configuration.answers, answerIndex, generatedQuestion)
        if (generatedRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
            attributions, gaps: [] }, destination, generatedQuestion)
        if (generatedRead.kind === 'refusal') return generatedRead.outcome
        const composeFirst = composeFilesAnswer(generatedRead.value)
        if (composeFirst) {
            const parsedCompose = Array.isArray(composeFirst) && composeFirst.length > 0
                ? CockpitConfig.shape.environment.safeParse({ ...defaults.environment,
                    install_policies: parsedPolicies.data, compose_files: composeFirst }) : undefined
            if (!parsedCompose?.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                `the operator-confirmed Compose files do not match the schema: ${parsedCompose
                    ? issueSummary(parsedCompose.error) : 'compose_files must list at least one path'}`,
                generatedQuestion.field)
            environment = parsedCompose.data
            const defaultIndex = attributions.findIndex(row => row.target === 'environment.compose_files')
            if (defaultIndex >= 0) attributions.splice(defaultIndex, 1)
        } else {
            const parsedGenerated = GeneratedEnvironment.safeParse(generatedRead.value)
            if (!parsedGenerated.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                `the operator-confirmed generated environment does not match the schema or omits required provenance: ${issueSummary(parsedGenerated.error)}`,
                generatedQuestion.field)
            const hostOperation = unboundHostOperation(parsedGenerated.data, ['environment', 'generated'])
            if (hostOperation) return hostOperationRefusal(hostOperation, generatedQuestion.field)
            let runnableWitnesses = 0
            for (const disposition of estateRunnable) {
                const services = parsedGenerated.data.services.filter(service => service.sibling === disposition.slug)
                const resolution = runnableResolutions.get(disposition.slug)
                const runnable = disposition.disposition === 'confirmed' || resolution?.runnable === true
                const witnessMatches = resolution?.runnable === true
                    ? services.filter(service => service.id === resolution.service
                        && JSON.stringify(service.command) === JSON.stringify(resolution.command)).length
                    : 0
                if (runnable ? services.length === 0 || resolution?.runnable === true && witnessMatches !== 1 : services.length !== 0) {
                    return refusal('DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH',
                        'the generated environment does not match the operator-confirmed runnable dispositions', generatedQuestion.field)
                }
                if (runnable) runnableWitnesses += 1
            }
            if (estateRunnable.length > 0 && runnableWitnesses === 0) {
                return refusal('DOCUMENT_NO_RUNNABLE_PRODUCT',
                    'the observed and operator-confirmed estate contains no runnable product', generatedQuestion.field)
            }
            environment = { ...defaults.environment, install_policies: parsedPolicies.data, generated: parsedGenerated.data }
        }
        record(composeFirst ? 'environment.compose_files' : 'environment.generated', generatedRead.provenance)
        answerIndex += 1

        // Every runtime command refuses a declared runtime with no floor, so a configuration that
        // declares one is incomplete until the operator states it. Nothing proposes it: Compose
        // deploy.resources limits are per-container ceilings that most files omit, and docker info
        // reports this machine's capacity, not what the product needs.
        const machineQuestion = configurationQuestion(context, 'environment.machine', QUESTION_WHY.machine)
        const machineRead = readConfigurationAnswer(configuration.answers, answerIndex, machineQuestion)
        if (machineRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
            attributions, gaps: [] }, destination, machineQuestion)
        if (machineRead.kind === 'refusal') return machineRead.outcome
        const parsedMachine = MachineFloor.safeParse(machineRead.value)
        if (!parsedMachine.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            `the operator-confirmed machine floor does not match the schema: ${issueSummary(parsedMachine.error)}`, machineQuestion.field)
        environment = { ...environment, machine: parsedMachine.data }
        record('environment.machine', machineRead.provenance)
        answerIndex += 1

        const postureQuestion = configurationQuestion(context, 'environment.posture', QUESTION_WHY.posture)
        const postureRead = readConfigurationAnswer(configuration.answers, answerIndex, postureQuestion)
        if (postureRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
            attributions, gaps: [] }, destination, postureQuestion)
        if (postureRead.kind === 'refusal') return postureRead.outcome
        const postureAnswer = postureRead.value
        const parsedPosture = postureAnswer && typeof postureAnswer === 'object' && !Array.isArray(postureAnswer)
            && Object.keys(postureAnswer).sort().join(',') === 'addressing,authentication,posture_requirements'
            ? CockpitConfig.shape.environment.safeParse({ ...environment, ...postureAnswer }) : undefined
        if (!parsedPosture?.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            `the operator-confirmed posture must be exactly { addressing, authentication, posture_requirements }${parsedPosture
                ? `: ${issueSummary(parsedPosture.error)}` : ''}`, postureQuestion.field)
        // The same judgement preflight gates on, so a posture that could never pass is refused here.
        const postureFailures = judgePostureDeclaration({ addressing: parsedPosture.data.addressing ?? null,
            authentication: parsedPosture.data.authentication ?? null }, parsedPosture.data.posture_requirements ?? [])
            .filter(row => !row.pass)
        if (postureFailures.length > 0) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            `the operator-confirmed posture would fail preflight: ${postureFailures.map(row => row.reason).join('; ')}`, postureQuestion.field)
        environment = parsedPosture.data
        record('environment.posture', postureRead.provenance)
        answerIndex += 1

        // Asked, never defaulted: a cockpit with no gate cannot grade work, and "none" is a decision
        // a person makes, not the absence of an answer.
        const testingQuestion = configurationQuestion(context, 'testing', QUESTION_WHY.testing)
        const testingRead = readConfigurationAnswer(configuration.answers, answerIndex, testingQuestion)
        if (testingRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
            attributions, gaps: [] }, destination, testingQuestion)
        if (testingRead.kind === 'refusal') return testingRead.outcome
        if (testingRead.value === 'none') testingNone = testingRead.provenance
        else {
            const answer = testingRead.value
            const parsedTesting = answer && typeof answer === 'object' && !Array.isArray(answer)
                ? Testing.safeParse({ native_hooks: { install: 'inspect' }, ...answer }) : undefined
            if (!parsedTesting?.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                `the testing answer must be "none" or a [testing] table of stages and gates${parsedTesting
                    ? `: ${issueSummary(parsedTesting.error)}` : ''}`, testingQuestion.field)
            testing = parsedTesting.data
        }
        record('testing', testingRead.provenance)
        answerIndex += 1
    }

    // Left as schema defaults, both lists are empty and the guard denies nothing by host, which no
    // one would notice; so the hosts are an explicit answer, and an explicit empty one is a decision.
    const guardQuestion = configurationQuestion(context, 'guards', QUESTION_WHY.guards)
    const guardRead = readConfigurationAnswer(configuration.answers, answerIndex, guardQuestion)
    if (guardRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
        attributions, gaps: [] }, destination, guardQuestion)
    if (guardRead.kind === 'refusal') return guardRead.outcome
    const guardAnswer = guardRead.value
    const parsedGuards = guardAnswer && typeof guardAnswer === 'object' && !Array.isArray(guardAnswer)
        && Object.keys(guardAnswer).sort().join(',') === 'hosted_db_hosts,vendor_endpoint_hosts'
        ? Guards.safeParse({ ...defaults.guards, ...guardAnswer }) : undefined
    if (!parsedGuards?.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
        `the operator-confirmed guard hosts must be exactly { hosted_db_hosts, vendor_endpoint_hosts }${parsedGuards
            ? `: ${issueSummary(parsedGuards.error)}` : ''}`, guardQuestion.field)
    const noGuardHosts = parsedGuards.data.hosted_db_hosts.length === 0 && parsedGuards.data.vendor_endpoint_hosts.length === 0
    record('guards', guardRead.provenance)
    answerIndex += 1

    const candidate = CockpitConfig.safeParse({ ...(unconfirmed.length === 0 ? {} : { unconfirmed: unconfirmed.map(row => row.field) }),
        ...defaults, cockpit: { ...defaults.cockpit, name,
        ...(siblingsRoot === undefined ? {} : { siblings_root: siblingsRoot }) },
        sibling: siblingRows, ports: parsedPorts.data, guards: parsedGuards.data, environment, ...(testing ? { testing } : {}) })
    if (!candidate.success) return refusal('DOCUMENT_CONFIGURATION_INVALID',
        `the completed operator-confirmed configuration does not match the schema: ${issueSummary(candidate.error)}`)
    if (configuration.classification === 'one-sibling' && candidate.data.sibling.length !== 1
        || (configuration.classification === 'ready-multi-repository'
            || configuration.classification === 'incomplete-multi-repository') && candidate.data.sibling.length < 2) {
        return refusal('DOCUMENT_CONFIGURATION_APPLICABILITY_INVALID',
            'the sibling declarations do not match the current estate classification', 'sibling')
    }

    const expectedSha256 = confirmationDigest(attributions)
    const defaultsQuestion = configurationQuestion(context, 'configuration.defaults', QUESTION_WHY.defaults, expectedSha256)
    const defaultsRead = readConfigurationAnswer(configuration.answers, answerIndex, defaultsQuestion)
    if (defaultsRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
        attributions, gaps: [], unconfirmed }, destination, defaultsQuestion, candidate.data)
    if (defaultsRead.kind === 'refusal') return defaultsRead.outcome
    if (!defaultsRead.value || typeof defaultsRead.value !== 'object' || Array.isArray(defaultsRead.value)
        || Object.keys(defaultsRead.value).sort().join(',') !== 'confirmed,sha256'
        || (defaultsRead.value as Record<string, unknown>).confirmed !== true
        || (defaultsRead.value as Record<string, unknown>).sha256 !== expectedSha256) {
        return refusal('DOCUMENT_DEFAULT_CONFIRMATION_INVALID',
            'the operator did not confirm the exact surfaced inferred and schema-default values', defaultsQuestion.field)
    }
    answerIndex += 1
    if (configuration.answers.length !== answerIndex) return refusal('DOCUMENT_CONFIGURATION_ANSWER_EXTRA',
        'configuration completion received an answer for no current question')

    const decisions = [
        ...(noGuardHosts ? [`guards: ${noGuardHostsDecision(guardRead.provenance)}; list those hosts under [guards] once one exists`] : []),
        ...(testingNone ? [`testing: no test gate is declared because ${STATED_BY[testingNone]} the product has no tests to run yet; declare [testing] once it does`] : []),
        ...(testData ? [testData.seeded_data
            ? candidate.data.environment.generated?.data?.modes.some(mode => mode.mode === 'seeded')
                ? 'seeded data: declared by the product-owned seeded mode in environment.generated.data'
                : 'seeded data: required but unresolved; declare product-owned seed operations before claiming a seeded local setup'
            : `seeded data: not declared because ${STATED_BY[testData.provenance]} this local setup does not need it`,
        testData.signed_in_users
            ? candidate.data.browser?.authentication.states.length
                ? 'signed-in users: declared by browser.authentication states backed by seeded personas'
                : 'signed-in users: required but unresolved; declare seeded personas and browser authentication states before claiming signed-in testing'
            : `signed-in users: not declared because ${STATED_BY[testData.provenance]} this local setup does not need them`] : []),
    ]
    const artifact = renderCompleteDocument(candidate.data, SCHEMA_DIRECTIVE, decisions, unconfirmed)
    const diagnostics = diagnosticsFor(attributions, [])
    for (const row of unconfirmed) diagnostics.push({ severity: 'warning', code: 'DOCUMENT_ANSWER_UNCONFIRMED', target: row.field,
        message: `${unconfirmedReason(row)}, so cockpit.toml lists it under unconfirmed and doctor warns until a person confirms it`,
        fix: UNCONFIRMED_FIX })
    if (noGuardHosts) diagnostics.push({ severity: 'info', code: 'DOCUMENT_GUARD_HOSTS_NONE', target: 'guards',
        message: `${noGuardHostsDecision(guardRead.provenance)}, so the guard denies no command by host`,
        fix: 'list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run npx --no cockpit sync --config <your cockpit.toml> once a non-local environment exists' })
    if (surfacesOnly) diagnostics.push({ severity: 'info', code: 'DOCUMENT_RUNTIME_NOT_DECLARED', target: 'environment',
        message: 'no runnable product was observed, so this configuration declares no runtime environment and no Compose file: sync publishes the harness surfaces only, and up, logs and the other runtime commands refuse',
        fix: 'once a product runs, declare environment.compose_files or [environment.generated] and run npx --no cockpit sync --config <your cockpit.toml>' })
    if (!destination) diagnostics.unshift({ severity: 'info', code: 'DOCUMENT_STDOUT_TARGET',
        message: 'stdout bytes are intended for the canonical cockpit.toml location; arbitrary redirection has no schema-location guarantee',
        target: '<cockpit-root>/cockpit.toml' })
    return { kind: 'complete', artifact, destination, diagnostics,
        result: { document: artifact, ...(unconfirmed.length === 0 ? {} : { unconfirmed: Object.freeze(unconfirmed) }) },
        status: 0, question: null }
}

async function documentCommandOwned(
    input: DocumentCommandInput,
    estateGaps: EstateClassificationResult['gaps'],
    estateRunnable: EstateClassificationResult['runnable'],
): Promise<DocumentOutcome> {
    const root = input.root ? resolve(input.root) : undefined
    const registry = input.registry ? resolve(input.registry) : root ? resolve(root, 'env/lib/instance.sh') : undefined
    if (!registry) return refusal('DOCUMENT_SOURCE_REQUIRED', 'provide one cockpit root or --registry <file>')

    let bytes: Buffer
    try {
        const read = await readBoundedInput(registry)
        if (read.kind === 'too-large') return refusal('REGISTRY_TOO_LARGE',
            `the registry file exceeds the ${STRUCTURED_INPUT_BYTE_LIMIT}-byte input limit`, registry)
        bytes = read.bytes
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' && input.configuration !== undefined && root !== undefined && input.registry === undefined) {
            return completeConfigurationDocument(input, root, null, [], estateGaps, estateRunnable)
        }
        if (code === 'ENOENT') {
            return refusal('REGISTRY_NOT_FOUND',
                'the registry file does not exist; document inventories an existing shell-registry cockpit (env/lib/instance.sh)',
                registry, `for a new product run: ${initCommand()}; otherwise check the cockpit root or registry path`)
        }
        return refusal('REGISTRY_UNREADABLE', `the registry file could not be read (${code ?? 'unknown I/O error'})`, registry)
    }

    let source: string
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch { // Fatal decoding throws only for invalid UTF-8, which the reason names.
        return refusal('REGISTRY_ENCODING_INVALID', 'the registry file is not valid UTF-8', registry)
    }

    if (source.trim() === '') return refusal('REGISTRY_EMPTY', 'the registry file is empty', registry)

    const parsed = parseRegistry(source)
    // A registry cockpit runs a Compose file of its own beside the registry; its published host
    // ports are the port map the registry dialect does not record.
    const inference = root && input.configuration === undefined ? await deriveInferredFacts({ root, repositories: [] }) : undefined
    if (parsed.skipped.length > 0) {
        const knownGaps = diagnosticsFor([], unresolvedGaps(parsed.siblings, cockpitName(root), root !== undefined, inference))
        return {
            kind: 'skipped-scope',
            artifact: null,
            destination: null,
            diagnostics: [
                ...parsed.skipped.map((row): Diagnostic => ({
                    severity: 'error',
                    code: row.code ?? 'REGISTRY_ROW_SKIPPED',
                    message: row.reason,
                    target: `registry line ${row.sourceLine}`,
                    fix: 'repair every skipped row before documenting repository scope',
                })),
                ...knownGaps,
            ],
            result: null,
            status: 2,
        }
    }
    if (!parsed.dialect || parsed.siblings.length === 0) {
        return refusal(
            parsed.found ? 'REGISTRY_EMPTY' : 'REGISTRY_NOT_FOUND',
            parsed.found ? 'the registry contains no usable rows'
                : 'the file contains no sibling registry; document inventories an existing shell-registry cockpit',
            registry,
            parsed.found ? undefined : `for a new product run: ${initCommand()}`,
        )
    }

    if (input.configuration !== undefined) {
        return completeConfigurationDocument(input, root,
            createHash('sha256').update(bytes).digest('hex'), parsed.siblings, estateGaps, estateRunnable)
    }

    const validName = cockpitName(root)
    const unresolved = unresolvedGaps(parsed.siblings, validName, root !== undefined, inference)
    const inferred = composeAttributions(inference)
    const model: DocumentModel = {
        name: validName,
        defaults: configurationDefaults(),
        siblings: parsed.siblings,
        attributions: [],
        gaps: unresolved,
        inferred: Object.fromEntries(inferred.map(row => [row.target, row.value])),
    }
    model.attributions = [...buildAttributions(model, root, 'registry'), ...inferred]
    const destination = input.output ? resolve(input.output) : null
    const artifact = renderIncompleteDocument(model, SCHEMA_DIRECTIVE)
    const diagnostics = diagnosticsFor(model.attributions, unresolved)
    if (!destination) {
        diagnostics.unshift({
            severity: 'info',
            code: 'DOCUMENT_STDOUT_TARGET',
            message: 'stdout bytes are intended for the canonical cockpit.toml location; arbitrary redirection has no schema-location guarantee',
            target: '<cockpit-root>/cockpit.toml',
        })
    }
    return {
        kind: 'gap-draft',
        artifact,
        destination,
        diagnostics,
        result: { document: artifact },
        status: 2,
    }
}

export async function documentCommand(input: DocumentCommandInput): Promise<DocumentOutcome> {
    return documentCommandOwned(input, [], [])
}

export async function documentObservedCommand(input: DocumentCommandInput): Promise<DocumentOutcome> {
    if (input.registry !== undefined || input.configuration === undefined) return documentCommand(input)
    if (!input.root) return refusal('DOCUMENT_SOURCE_REQUIRED', 'greenfield configuration completion requires one canonical root')
    const classified = await classifyEstateObservation(input.estate ?? { root: resolve(input.root) }, { observe: observePublicEstate })
    if (classified.kind !== 'complete') return {
        kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
        diagnostics: [...classified.diagnostics],
    }
    if (input.configuration.sourceObservationSha256 !== classified.result.sourceObservationSha256
        || input.configuration.classification !== classified.result.classification) {
        return refusal('DOCUMENT_ESTATE_OBSERVATION_CHANGED',
            'the configuration answers are not bound to the current public estate observation', input.root)
    }
    return documentCommandOwned(input, classified.result.gaps, classified.result.runnable)
}
