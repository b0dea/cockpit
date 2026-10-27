import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBoundedInput, schemaIssueSummary, STRUCTURED_INPUT_BYTE_LIMIT } from '../config/load.js'
import type { Diagnostic } from '../diagnostics.js'
import { snapshotJson } from '../environment/contract.js'
import { isSensitiveField, redactSensitiveText } from '../environment/sensitive.js'
import { CockpitConfig, GeneratedEnvironment, InstallPolicy, configurationDefaults } from '../schema.js'
import { toSiblingRows } from '../emit.js'
import { gaps, parseRegistry, type DocumentedSibling, type Gap } from './registry.js'
import { renderCompleteDocument, renderIncompleteDocument, type Attribution, type DocumentModel } from './render.js'

export const mechanism = {
    id: 'document-outcome',
    module: 'packages/cockpit/src/document/command.ts',
    exports: ['documentCommand', 'documentObservedCommand', 'classifyEstateObservation', 'observePublicEstate', 'plannedGreenfieldQuestions'],
} as const

export interface EstateObservationInput { readonly root: string }
export interface EstateObservationAdapters {
    readonly observe: (input: EstateObservationInput) => Promise<unknown>
}
export type EstateClassification = 'one-sibling' | 'incomplete-multi-repository'
    | 'no-runnable-product' | 'ready-multi-repository'
export interface EstateClassificationResult {
    readonly classification: EstateClassification
    readonly sourceObservationSha256: string
    readonly applicability: Readonly<{
        stack: true; seed: true; postures: true
        registry: boolean; projection: boolean; drift: boolean
        compose: 'applicable' | 'inapplicable' | 'unknown'
    }>
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
    result: { document: string } | null
    status: number
    question?: DocumentConfigurationQuestion | null
}

export interface CompleteDocumentOutcome extends OutcomeBase {
    kind: 'complete'
    artifact: string
    result: { document: string }
    status: 0
}

export interface GapDraftOutcome extends OutcomeBase {
    kind: 'gap-draft'
    artifact: string
    result: null
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
}

export type DocumentConfigurationField = 'cockpit.name' | 'sibling' | 'estate.runnable' | 'ports.bases'
    | 'environment.install_policies' | 'environment.generated' | 'configuration.defaults'
export interface DocumentConfigurationQuestion {
    readonly id: `question:${string}`
    readonly field: DocumentConfigurationField
    readonly source: string
    readonly why: string
    readonly expectedSha256?: string
}
export interface DocumentConfigurationAnswer {
    readonly questionId: string
    readonly bytes: string
    readonly sha256: string
    readonly provenance: 'operator-confirmed'
}
export interface DocumentConfigurationInput {
    readonly sourceObservationSha256: string
    readonly classification?: EstateClassification
    readonly answers: readonly DocumentConfigurationAnswer[]
}

const schemaArtifact = fileURLToPath(new URL('../../cockpit.schema.json', import.meta.url))
const defaultReason = (field: string) =>
    `the registry dialect does not record ${field}; materialised from the CockpitConfig schema default`

function schemaDirective(destination: string | null): string {
    if (!destination) return './node_modules/@b0dea/cockpit/cockpit.schema.json'
    const path = relative(dirname(destination), schemaArtifact).split(sep).join('/')
    return path.startsWith('.') ? path : `./${path}`
}

const SCHEMA_ISSUES_SHOWN = 10

function issueSummary(error: { readonly issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
    return schemaIssueSummary(error.issues, SCHEMA_ISSUES_SHOWN)
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

function estateRefusal(message: string, target = 'estate'): EstateClassificationOutcome {
    return Object.freeze({ kind: 'refusal', status: 2, result: null, diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const,
        code: 'DOCUMENT_ESTATE_OBSERVATION_INVALID',
        message,
        target,
    })]) })
}

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/
const SAFE_RELATIVE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/
const MAX_ESTATE_EVIDENCE_BYTES = 1024 * 1024
const MAX_CONFIGURATION_ANSWER_BYTES = 262_144
const PUBLIC_MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile'] as const
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

export async function observePublicEstate(input: EstateObservationInput): Promise<unknown> {
    if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'root'
        || typeof input.root !== 'string' || !isAbsolute(input.root) || resolve(input.root) !== input.root) {
        throw new TypeError('public estate observation requires one canonical absolute root')
    }
    const root = await realpath(input.root)
    if (root !== input.root) throw new TypeError('public estate root is linked or non-canonical')
    const entries = await estateDirectories(root)
    const repositories: EstateRepositoryObservation[] = []
    for (const entry of entries) {
        const repository = resolve(root, entry.name)
        const sources: { path: string; sha256: string }[] = []
        let runnable: EstateRepositoryObservation['runnable'] = 'absent'
        const reasons: string[] = []
        for (const manifest of PUBLIC_MANIFESTS) {
            const path = resolve(repository, manifest)
            let bytes: Buffer
            try {
                const stat = await lstat(path)
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_ESTATE_EVIDENCE_BYTES) {
                    throw new TypeError(`public manifest is not one bounded regular file: ${entry.name}/${manifest}`)
                }
                bytes = await readFile(path)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                continue
            }
            if (bytes.byteLength > MAX_ESTATE_EVIDENCE_BYTES) {
                throw new TypeError(`public manifest exceeds the observation bound: ${entry.name}/${manifest}`)
            }
            sources.push(Object.freeze({ path: manifest, sha256: createHash('sha256').update(bytes).digest('hex') }))
            if (manifest !== 'package.json') {
                if (runnable !== 'confirmed') runnable = 'unknown'
                reasons.push(`${manifest} does not declare a supported runnable command`)
                continue
            }
            let parsed: unknown
            try { parsed = JSON.parse(bytes.toString('utf8')) }
            catch {
                if (runnable !== 'confirmed') runnable = 'unknown'
                reasons.push('package.json is not valid JSON')
                continue
            }
            const scripts = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>).scripts : undefined
            const confirmed = scripts && typeof scripts === 'object' && !Array.isArray(scripts)
                && PACKAGE_RUN_SCRIPTS.some(name => typeof (scripts as Record<string, unknown>)[name] === 'string'
                    && ((scripts as Record<string, unknown>)[name] as string).trim().length > 0)
            if (confirmed) runnable = 'confirmed'
            else reasons.push('package.json declares no non-empty dev, start or serve script')
        }
        const source = sources[0]
        if (!source) continue
        repositories.push(Object.freeze({ slug: entry.name, path: entry.name, evidencePath: source.path, runnable,
            ...(runnable === 'confirmed' ? {} : { why: reasons.join('; ') }), source,
            ...(sources.length > 1 ? { sources: Object.freeze(sources) } : {}) }))
    }
    return Object.freeze({ root, observedAt: new Date().toISOString(), repositories: Object.freeze(repositories) })
}

async function estateDirectories(root: string) {
    const entries = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && SAFE_NAME.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
    if (entries.length > 64) throw new TypeError('public estate contains more than 64 candidate repositories')
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

function sameStat(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
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
            || runnable !== 'confirmed' && (typeof row.why !== 'string' || row.why.trim() !== row.why || row.why.length < 1 || row.why.length > 512)
            || !row.source || typeof row.source !== 'object' || Array.isArray(row.source)
            || Object.keys(row.source).sort().join(',') !== 'path,sha256') return undefined
        const source = row.source as Record<string, unknown>
        if (source.path !== row.evidencePath || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)
            || typeof row.why === 'string' && redactSensitiveText(row.why) !== row.why) return undefined
        const sources = row.sources
        if (sources !== undefined && (!Array.isArray(sources) || sources.length < 2 || sources.length > PUBLIC_MANIFESTS.length
            || sources.some(value => !value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).sort().join(',') !== 'path,sha256'
                || typeof value.path !== 'string' || !PUBLIC_MANIFESTS.includes(value.path)
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

async function currentEstateRows(root: string, rows: readonly EstateRepositoryObservation[]): Promise<boolean> {
    try {
        for (const directory of await estateDirectories(root)) {
            const manifests: string[] = []
            for (const manifest of PUBLIC_MANIFESTS) {
                try {
                    const stat = await lstat(resolve(root, directory.name, manifest))
                    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
                        || stat.size > MAX_ESTATE_EVIDENCE_BYTES) return false
                    manifests.push(manifest)
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
            if (!repositoryRelative || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)
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
                    || createHash('sha256').update(bytes).digest('hex') !== source.sha256) return false
            }
            if (!sameStat(repositoryBefore, await lstat(repository))) return false
        }
        return true
    } catch {
        return false
    }
}

export async function classifyEstateObservation(
    input: EstateObservationInput,
    adapters: EstateObservationAdapters,
): Promise<EstateClassificationOutcome> {
    let root: string
    let before: Awaited<ReturnType<typeof lstat>>
    let directories: Awaited<ReturnType<typeof estateDirectories>>
    try {
        if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'root'
            || typeof input.root !== 'string' || !isAbsolute(input.root) || resolve(input.root) !== input.root) {
            return estateRefusal('estate classification requires one canonical absolute root')
        }
        root = await realpath(input.root)
        before = await lstat(root)
        if (root !== input.root || !before.isDirectory() || before.isSymbolicLink()) {
            return estateRefusal('estate root is linked, missing or non-canonical', input.root)
        }
        directories = await estateDirectories(root)
    } catch {
        return estateRefusal('estate root is linked, missing or non-canonical', input.root)
    }
    let observed: unknown
    try { observed = await adapters.observe(Object.freeze({ root })) }
    catch { return estateRefusal('estate observation owner failed', root) }
    const rows = estateCandidate(observed, root)
    if (!rows || !await currentEstateRows(root, rows)) {
        return estateRefusal('estate observation is malformed, ambiguous, stale or unbound to current source bytes', root)
    }
    try {
        const currentDirectories = await estateDirectories(root)
        if (directories.length !== currentDirectories.length || directories.some((entry, index) =>
            entry.name !== currentDirectories[index]!.name || !sameStat(entry.stat, currentDirectories[index]!.stat))) {
            return estateRefusal('estate candidate directories changed during observation', root)
        }
        const after = await lstat(root)
        if (!sameStat(before, after)) return estateRefusal('estate root changed during observation', root)
    } catch { return estateRefusal('estate root changed during observation', root) }

    const confirmed = rows.filter(row => row.runnable === 'confirmed')
    const unknown = rows.filter(row => row.runnable === 'unknown')
    const multi = rows.length >= 2
    const classification: EstateClassification = confirmed.length === 0 && unknown.length === 0
        ? 'no-runnable-product' : !multi ? 'one-sibling'
            : unknown.length > 0 ? 'incomplete-multi-repository' : 'ready-multi-repository'
    const gaps = classification === 'no-runnable-product'
        ? [Object.freeze(rows.length === 0
            ? { field: 'runnable-product', source: '.', why: `no directory under the root carries ${PUBLIC_MANIFESTS.join(', ')}` }
            : { field: 'runnable-product', source: rows.map(row => `${row.slug}/${row.source.path}`).join(', '),
                why: rows.map(row => row.why).filter(Boolean).join('; ') })]
        : unknown.map(row => Object.freeze({ field: `${row.slug}.runnable`, source: `${row.slug}/${row.source.path}`, why: row.why! }))
    const result: EstateClassificationResult = Object.freeze({
        classification,
        sourceObservationSha256: sourceObservationSha256(root, rows),
        applicability: Object.freeze({ stack: true, seed: true, postures: true,
            registry: multi, projection: multi, drift: multi,
            compose: unknown.length > 0 ? 'unknown' : confirmed.length > 0 ? 'applicable' : 'inapplicable' }),
        notice: classification === 'one-sibling'
            ? 'cockpit starts earning its keep at two siblings; this estate can still use stack, seed and posture controls'
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

function buildAttributions(model: Pick<DocumentModel, 'name' | 'siblings' | 'defaults'>, root?: string): Attribution[] {
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
        ['cockpit.guide', defaults.cockpit.guide, 'the root guide filename'],
        ['cockpit.guide_cap', defaults.cockpit.guide_cap, 'the root guide line cap'],
        ['ports.step', defaults.ports.step, 'the stack port step'],
        ['ports.count', defaults.ports.count, 'the available stack count'],
        ['guards.hosted_db_hosts', defaults.guards.hosted_db_hosts, 'hosted database hosts'],
        ['guards.vendor_endpoint_hosts', defaults.guards.vendor_endpoint_hosts, 'vendor endpoint hosts'],
        ['guards.protected_branches', defaults.guards.protected_branches, 'protected branches'],
        ['guards.ask_is_deny_on', defaults.guards.ask_is_deny_on, 'harnesses where ask means deny'],
        ['mcp.approved', defaults.mcp.approved, 'approved MCP servers'],
        ['workorders.attempt_cap', defaults.workorders.attempt_cap, 'the work-order attempt cap'],
        ['workorders.wip_cap', defaults.workorders.wip_cap, 'the work-order WIP cap'],
        ['workorders.programme_wip_cap', defaults.workorders.programme_wip_cap, 'the programme work-order WIP cap'],
    ] as const) {
        attributions.push({ target, value, from: 'default', because: defaultReason(field) })
    }
    if ('scope' in defaults.cockpit) attributions.push({
        target: 'cockpit.scope', value: defaults.cockpit.scope, from: 'default',
        because: defaultReason('the cockpit estate scope'),
    })
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
            because: defaultReason('a sibling toolchain'),
        })
        attributions.push({
            target: `sibling.${sibling.slug}.guides`,
            value: defaults.sibling.guides,
            from: 'default',
            because: 'the registry dialect does not record guide filenames; materialised from the CockpitConfig schema default',
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

function unresolvedGaps(siblings: DocumentedSibling[], name: string | undefined, rootProvided: boolean): Gap[] {
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
        { slug: 'ports', field: 'bases', why: 'no registry dialect records the product port map', blocking: true },
        ...gaps(siblings),
    ]
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
        || !Array.isArray(record.answers) || record.answers.length > 7) return undefined
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
            || answer.provenance !== 'operator-confirmed') return undefined
        answers.push(Object.freeze({ questionId: answer.questionId, bytes: answer.bytes,
            sha256: answer.sha256, provenance: 'operator-confirmed' }))
    }
    return Object.freeze({ sourceObservationSha256: record.sourceObservationSha256,
        ...(record.classification === undefined ? {} : { classification: record.classification as EstateClassification }),
        answers: Object.freeze(answers) })
}

const QUESTION_WHY = {
    name: 'the source does not establish a schema-valid cockpit name',
    siblingEstate: 'the source does not establish schema-shaped sibling declarations',
    siblingRegistry: 'the registry leaves required sibling configuration unresolved',
    ports: 'no source establishes the host-published base port map; an explicit empty map means none',
    policies: 'declare the exact dependency install protocols: toolchains, volumes, lockfiles, install and load probes, and any build or test commands',
    generated: 'declare the exact generated environment: compose path, services, pinned images, commands, health probes, mounts, data modes, fixtures, volumes, vendors, decisions, and their provenance; or, to run a Compose file the checkout already has, answer { "compose_files": ["compose.yml"] }',
    defaults: 'confirm the exact surfaced inferred and schema-default values before completing the document',
} as const

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
        ...(cockpitName(input.root) ? [] : [{ field: 'cockpit.name' as const, why: QUESTION_WHY.name }]),
        { field: 'sibling' as const, why: QUESTION_WHY.siblingEstate },
        ...(!surfacesOnly && input.gaps.length > 0 ? [{ field: 'estate.runnable' as const, why: runnableWhy(input.gaps) }] : []),
        { field: 'ports.bases' as const, why: QUESTION_WHY.ports },
        ...(surfacesOnly ? [] : [
            { field: 'environment.install_policies' as const, why: QUESTION_WHY.policies },
            { field: 'environment.generated' as const, why: QUESTION_WHY.generated },
        ]),
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
): { kind: 'pending' } | { kind: 'answer'; value: unknown } | { kind: 'refusal'; outcome: RefusedDocumentOutcome } {
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
        return { kind: 'answer', value }
    }
    catch { return { kind: 'refusal', outcome: refusal(
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
): GapDraftOutcome {
    const unresolved = [questionGap(question)]
    return {
        kind: 'gap-draft', artifact: renderIncompleteDocument({ ...model, gaps: unresolved }, schemaDirective(destination)),
        destination, diagnostics: diagnosticsFor(model.attributions, unresolved), result: null, status: 2, question,
    }
}

function sameDetectedSibling(answered: Record<string, unknown>, detected: Record<string, unknown>): boolean {
    return Object.entries(detected).every(([key, value]) => JSON.stringify(answered[key]) === JSON.stringify(value))
}

function inferGreenfieldSiblingRoot(attributions: Attribution[], greenfieldEstate: boolean): Attribution[] {
    if (!greenfieldEstate) return attributions
    const index = attributions.findIndex(row => row.target === 'cockpit.siblings_root')
    if (index >= 0) attributions.splice(index, 1)
    attributions.push({ target: 'cockpit.siblings_root', value: '.', from: 'inferred',
        because: 'the authenticated greenfield estate repositories are direct children of the cockpit root' })
    return attributions
}

function defaultAttributions(
    defaults: ReturnType<typeof configurationDefaults>,
    siblings: readonly Record<string, unknown>[],
    detected: readonly DocumentedSibling[],
    root?: string,
    greenfieldEstate = false,
): Attribution[] {
    const attributions = buildAttributions({ name: cockpitName(root), siblings: detected, defaults }, root)
        .filter(row => !row.target.startsWith('sibling.') || row.from !== 'default')
    for (const [field, value] of Object.entries(defaults.environment)) {
        if (field !== 'install_policies') attributions.push({ target: `environment.${field}`, value, from: 'default',
            because: defaultReason(`the environment ${field} declaration`) })
    }
    attributions.push({ target: 'surfaces', value: defaults.surfaces, from: 'default',
        because: defaultReason('the surfaces declaration') })
    for (const sibling of siblings) {
        for (const field of ['toolchain', 'guides'] as const) if (!(field in sibling)) {
            attributions.push({ target: `sibling.${String(sibling.slug)}.${field}`,
                value: defaults.sibling[field], from: 'default', because: defaultReason(`a sibling ${field}`) })
        }
    }
    return inferGreenfieldSiblingRoot(attributions, greenfieldEstate)
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

function completeConfigurationDocument(
    input: DocumentCommandInput,
    root: string | undefined,
    registrySha256: string | null,
    detected: readonly DocumentedSibling[],
    estateGaps: EstateClassificationResult['gaps'] = [],
    estateRunnable: EstateClassificationResult['runnable'] = [],
): DocumentOutcome {
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
    const greenfieldEstate = registrySha256 === null
    const destination = input.output ? resolve(input.output) : null
    let answerIndex = 0
    let name = cockpitName(root)
    let siblingRows: CockpitConfig['sibling'] | undefined
    let siblingAnswerRows: readonly Record<string, unknown>[] = []

    if (!name) {
        const question = configurationQuestion(context, 'cockpit.name', QUESTION_WHY.name)
        const read = readConfigurationAnswer(configuration.answers, answerIndex, question)
        if (read.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: detected,
            attributions: inferGreenfieldSiblingRoot(
                buildAttributions({ name, defaults, siblings: detected }, root), greenfieldEstate), gaps: [] }, destination, question)
        if (read.kind === 'refusal') return read.outcome
        const parsed = CockpitConfig.shape.cockpit.safeParse({ ...defaults.cockpit, name: read.value })
        if (!parsed.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            `the operator-confirmed cockpit name does not match the schema: ${issueSummary(parsed.error)}`, question.field)
        name = parsed.data.name
        answerIndex += 1
    }

    const detectedRows = toSiblingRows(detected)
    const needsSiblingAnswer = detected.length === 0 || gaps([...detected]).some(gap => gap.blocking)
    if (needsSiblingAnswer) {
        const question = configurationQuestion(context, 'sibling', detected.length === 0
            ? QUESTION_WHY.siblingEstate : QUESTION_WHY.siblingRegistry)
        const read = readConfigurationAnswer(configuration.answers, answerIndex, question)
        if (read.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: detected,
            attributions: inferGreenfieldSiblingRoot(
                buildAttributions({ name, defaults, siblings: detected }, root), greenfieldEstate), gaps: [] }, destination, question)
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
        siblingRows = parsed.data
        answerIndex += 1
    } else {
        const parsed = CockpitConfig.shape.sibling.safeParse(detectedRows)
        if (!parsed.success) return refusal('DOCUMENT_CONFIGURATION_INVALID',
            `detected registry sibling facts do not satisfy the configuration schema: ${issueSummary(parsed.error)}`, 'sibling')
        siblingRows = parsed.data
        siblingAnswerRows = detectedRows
    }

    if (estateRunnable.length > 0) {
        const dispositionSlugs = estateRunnable.map(row => row.slug)
        const siblingSlugs = siblingRows.map(row => row.slug)
        if (new Set(dispositionSlugs).size !== dispositionSlugs.length
            || [...dispositionSlugs].sort().join(',') !== [...siblingSlugs].sort().join(',')
            || estateRunnable.some(disposition => siblingRows.find(row => row.slug === disposition.slug)?.dir !== disposition.path)) return refusal(
            'DOCUMENT_ESTATE_TOPOLOGY_MISMATCH',
            'the sibling declarations do not match the repository identities and directories in the current estate observation',
            'sibling',
        )
    }

    const runnableResolutions = new Map<string, Readonly<{ runnable: boolean; service?: string; command?: readonly string[] }>>()
    if (!surfacesOnly && estateGaps.length > 0) {
        const slugs = estateGaps.map(gap => /^([a-z][a-z0-9-]{0,63})\.runnable$/.exec(gap.field)?.[1])
        if (slugs.some(slug => !slug) || new Set(slugs).size !== slugs.length) return refusal(
            'DOCUMENT_ESTATE_GAPS_INVALID', 'the current estate runnable gaps are malformed or duplicated')
        const question = configurationQuestion(context, 'estate.runnable', runnableWhy(estateGaps))
        const read = readConfigurationAnswer(configuration.answers, answerIndex, question)
        if (read.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: documentedRows(siblingRows),
            attributions: defaultAttributions(defaults, siblingAnswerRows, detected, root), gaps: [] },
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
        answerIndex += 1
    }

    const portQuestion = configurationQuestion(context, 'ports.bases', QUESTION_WHY.ports)
    const portRead = readConfigurationAnswer(configuration.answers, answerIndex, portQuestion)
    const previewRows = documentedRows(siblingRows)
    const attributions = defaultAttributions(defaults, siblingAnswerRows, detected, root, greenfieldEstate)
    const stackScope = configuration.classification === 'one-sibling'
    if (stackScope) {
        const defaultScope = attributions.findIndex(row => row.target === 'cockpit.scope')
        if (defaultScope >= 0) attributions.splice(defaultScope, 1)
        attributions.push({ target: 'cockpit.scope', value: 'stack', from: 'inferred',
            because: 'the authenticated one-sibling estate uses the stack-only floor' })
    }
    if (portRead.kind === 'pending') return pendingConfiguration({ name, defaults, siblings: previewRows,
        attributions, gaps: [] }, destination, portQuestion)
    if (portRead.kind === 'refusal') return portRead.outcome
    const parsedPorts = CockpitConfig.shape.ports.safeParse({ ...defaults.ports, bases: portRead.value })
    if (!parsedPorts.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
        `the operator-confirmed port bases do not match the schema: ${issueSummary(parsedPorts.error)}`, portQuestion.field)
    answerIndex += 1

    let environment = defaults.environment
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
        answerIndex += 1

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
        } else {
            const parsedGenerated = GeneratedEnvironment.safeParse(generatedRead.value)
            if (!parsedGenerated.success) return refusal('DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                `the operator-confirmed generated environment does not match the schema or omits required provenance: ${issueSummary(parsedGenerated.error)}`,
                generatedQuestion.field)
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
        answerIndex += 1
    }

    const candidate = CockpitConfig.safeParse({ ...defaults, cockpit: { ...defaults.cockpit, name,
        ...(greenfieldEstate ? { siblings_root: '.' } : {}), ...(stackScope ? { scope: 'stack' } : {}) },
        sibling: siblingRows, ports: parsedPorts.data, environment })
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
        attributions, gaps: [] }, destination, defaultsQuestion)
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

    const artifact = renderCompleteDocument(candidate.data, schemaDirective(destination))
    const diagnostics = diagnosticsFor(attributions, [])
    if (surfacesOnly) diagnostics.push({ severity: 'info', code: 'DOCUMENT_RUNTIME_NOT_DECLARED', target: 'environment',
        message: 'no runnable product was observed, so this configuration declares no runtime environment and no Compose file: sync publishes the harness surfaces only, and up, logs and the other runtime commands refuse',
        fix: 'once a product runs, declare environment.compose_files or [environment.generated] and run cockpit sync' })
    if (!destination) diagnostics.unshift({ severity: 'info', code: 'DOCUMENT_STDOUT_TARGET',
        message: 'stdout bytes are intended for the canonical cockpit.toml location; arbitrary redirection has no schema-location guarantee',
        target: '<cockpit-root>/cockpit.toml' })
    return { kind: 'complete', artifact, destination, diagnostics, result: { document: artifact },
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
                registry, 'for a new product run: cockpit init <root> --target <harness>; otherwise check the cockpit root or registry path')
        }
        return refusal('REGISTRY_UNREADABLE', `the registry file could not be read (${code ?? 'unknown I/O error'})`, registry)
    }

    let source: string
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return refusal('REGISTRY_ENCODING_INVALID', 'the registry file is not valid UTF-8', registry)
    }

    if (source.trim() === '') return refusal('REGISTRY_EMPTY', 'the registry file is empty', registry)

    const parsed = parseRegistry(source)
    if (parsed.skipped.length > 0) {
        const knownGaps = diagnosticsFor([], unresolvedGaps(parsed.siblings, cockpitName(root), root !== undefined))
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
            parsed.found ? undefined : 'for a new product run: cockpit init <root> --target <harness>',
        )
    }

    if (input.configuration !== undefined) {
        return completeConfigurationDocument(input, root,
            createHash('sha256').update(bytes).digest('hex'), parsed.siblings, estateGaps, estateRunnable)
    }

    const validName = cockpitName(root)
    const unresolved = unresolvedGaps(parsed.siblings, validName, root !== undefined)
    const model: DocumentModel = {
        name: validName,
        defaults: configurationDefaults(),
        siblings: parsed.siblings,
        attributions: [],
        gaps: unresolved,
    }
    model.attributions = buildAttributions(model, root)
    const destination = input.output ? resolve(input.output) : null
    const artifact = renderIncompleteDocument(model, schemaDirective(destination))
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
        result: null,
        status: 2,
    }
}

export async function documentCommand(input: DocumentCommandInput): Promise<DocumentOutcome> {
    return documentCommandOwned(input, [], [])
}

export async function documentObservedCommand(input: DocumentCommandInput): Promise<DocumentOutcome> {
    if (input.registry !== undefined || input.configuration === undefined) return documentCommand(input)
    if (!input.root) return refusal('DOCUMENT_SOURCE_REQUIRED', 'greenfield configuration completion requires one canonical root')
    const classified = await classifyEstateObservation({ root: resolve(input.root) }, { observe: observePublicEstate })
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
