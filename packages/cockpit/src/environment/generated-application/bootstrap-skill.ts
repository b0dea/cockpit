import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { SURFACE_TARGETS, type SurfaceSourceFile, type SurfaceTarget } from '../../surfaces/contract.js'
import {
    CORE_PROCEDURE_ASSETS as PROCEDURE_ASSETS,
    CORE_SKILL_ASSETS as SKILL_ASSETS,
    shippedSkillSources,
} from '../../surfaces/core-declarations.js'
import type { SurfacePriorOwnedEntry } from '../../surfaces/ownership.js'
import { SHIPPED_SETUP_SKILL, inspectSkillSet, projectInspectedSkillOutputs } from '../../surfaces/skill-contract.js'
import {
    nodeAuthority,
    readAnchoredEntry,
    readAnchoredBatches,
    expectedState,
    admitPublicationPlan,
    runPublicationPlan,
    type PublicationMutation,
    type DirectoryIdentity,
    type FileIdentity,
} from '../../generated-environment/transaction.js'
import { errorCause, RefusalError } from '../contract.js'
import type { ResolvedExecutable } from '../executable.js'
import { authenticateStatePublication, readState, selectBootstrapStateRoot, type BootstrapStateRecord } from '../state.js'
import { exactKeys } from '../../exact-keys.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentSyncInput,
    MAX_OWNERSHIP_BYTES,
    MAX_SURFACE_FILE_BYTES,
    OWNERSHIP_PATH,
    SURFACE_ROOT,
    type SelectedBootstrapPublicationAuthority,
    type SelectedBootstrapRecord,
    type SelectedBootstrapResumeInput,
    type SelectedBootstrapResumeOutcome,
    type SelectedBootstrapSurfaceInput,
    type SelectedBootstrapSurfaceOutcome,
    type SelectedBootstrapSurfaceResult,
    type SurfaceAssetPath,
    consumedBootstrapStatePublications,
    issuedSelectedBootstrapAuthorities,
    mergedAdapters,
    ownRecord,
    readSurfaceAsset,
    sha256,
    sourceIdentity,
} from './shared.js'
import { prepare, readOwnership } from './prepare.js'

function selectedBootstrapInput(input: unknown): SelectedBootstrapSurfaceInput | undefined {
    const record = ownRecord(input)
    if (!record || !exactKeys(record, ['root', 'target', 'tools']) || typeof record.root !== 'string'
        || !isAbsolute(record.root) || resolve(record.root) !== record.root
        || !SURFACE_TARGETS.includes(record.target as SurfaceTarget)
        || !Array.isArray(record.tools) || record.tools[0] !== record.target
        || new Set(record.tools).size !== record.tools.length
        || record.tools.some(tool => !SURFACE_TARGETS.includes(tool as SurfaceTarget))) return undefined
    return { root: record.root, target: record.target as SurfaceTarget, tools: [...record.tools] as SurfaceTarget[] }
}

type AuthenticatedAsset = Readonly<{ path: string; bytes: string; sha256: string }>

/** The shipped skill sources with the packaged collection and procedures that authenticate them. */
function bootstrapSkillInput(assets: ReadonlyMap<string, AuthenticatedAsset>, tools: readonly SurfaceTarget[]): Readonly<{
    sources: readonly SurfaceSourceFile[]
    collection: AuthenticatedAsset
    procedures: readonly AuthenticatedAsset[]
    tools: readonly SurfaceTarget[]
}> | undefined {
    const skills = shippedSkillSources(assets, tools)
    const collection = assets.get('skills/collection.json')
    const procedures = PROCEDURE_ASSETS.map(path => assets.get(path))
    if (!skills || !collection || procedures.some(row => row === undefined)) return undefined
    const pick = ({ path, bytes, sha256: digest }: AuthenticatedAsset) => ({ path, bytes, sha256: digest })
    return { sources: skills.flatMap(skill => skill.sources), collection: pick(collection),
        procedures: (procedures as AuthenticatedAsset[]).map(pick), tools }
}

async function selectedBootstrapAssets(
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly Readonly<{ path: SurfaceAssetPath; bytes: string; sha256: string; identity: FileIdentity }>[] | undefined> {
    const reads = await readAnchoredBatches(SURFACE_ROOT, SKILL_ASSETS.map(path => ({
        path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== SKILL_ASSETS.length) return undefined
    const assets = SKILL_ASSETS.map((path, index) => readSurfaceAsset(path, reads.results[index]!))
    return assets.every((asset): asset is NonNullable<typeof asset> => asset !== undefined) ? assets : undefined
}

async function selectedBootstrapRecordCurrent(record: SelectedBootstrapRecord): Promise<boolean> {
    try {
        const root = await lstat(record.root)
        if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== record.rootIdentity.dev || root.ino !== record.rootIdentity.ino) return false
        const reads = await readAnchoredBatches(SURFACE_ROOT, record.assets.map(asset => ({
            path: asset.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), record.node, record.adapters)
        const state = record.bootstrapState && await readState(record.bootstrapState.address)
        return (!record.bootstrapState || state?.kind === 'complete'
                && JSON.stringify(state.value) === JSON.stringify(record.bootstrapState.record))
            && !!reads && reads.kind === 'complete' && reads.results.length === record.assets.length
            && reads.results.every((read, index) => read.kind === 'complete' && read.sha256 === record.assets[index]!.sha256
                && sourceIdentity(read.identity) === sourceIdentity(record.assets[index]!.identity))
    } catch {
        // a failed re-observation means the inputs are no longer authenticated; the caller refuses.
        return false
    }
}

export async function prepareSelectedBootstrapSurface(
    input: SelectedBootstrapSurfaceInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<SelectedBootstrapSurfaceOutcome> {
    const captured = selectedBootstrapInput(input)
    if (!captured) return refuse('GENERATED_INPUT_INVALID', 'selected bootstrap input is invalid', 'bootstrap')
    const adapters = mergedAdapters(adapterOverrides)
    let root: string
    let rootIdentity: DirectoryIdentity
    try {
        root = await realpath(captured.root)
        const status = await lstat(root)
        if (root !== captured.root || !status.isDirectory() || status.isSymbolicLink()) throw new RefusalError('root')
        rootIdentity = { dev: status.dev, ino: status.ino }
    } catch (error) {
        return refuse('GENERATED_INPUT_INVALID', `selected bootstrap root is not a canonical directory: ${errorCause(error)}`, captured.root)
    }
    const node = await nodeAuthority()
    const assets = node && await selectedBootstrapAssets(node, adapters)
    if (!node || !assets) return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap assets could not be authenticated', 'bootstrap')
    const skillInput = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])), captured.tools)
    if (!skillInput) return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap assets are incomplete', 'bootstrap')
    const { sources } = skillInput
    const inspection = await inspectSkillSet(skillInput)
    if (inspection.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap skill set was refused', 'bootstrap')
    const inspected = projectInspectedSkillOutputs(inspection, captured.tools, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'selected bootstrap output set was refused', captured.target)
    const reads = await readAnchoredBatches(root, inspected.files.map(file => ({
        path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== inspected.files.length) {
        return refuse('SURFACE_STATE_CONFLICT', 'selected bootstrap destinations could not be authenticated', captured.target)
    }
    const mutations: PublicationMutation[] = []
    for (const [index, file] of inspected.files.entries()) {
        const current = reads.results[index]!
        if (current.kind !== 'missing' && current.kind !== 'file') return refuse('SURFACE_STATE_CONFLICT', 'selected bootstrap destination is not a regular file or missing', file.path)
        if (current.kind === 'file' && current.sha256 !== file.sha256) return refuse('SURFACE_STATE_CONFLICT', 'selected bootstrap destination contains unmanaged bytes', file.path)
        if (current.kind === 'missing') mutations.push({ path: file.path, phase: 'desired', operation: 'write-file',
            bytes: file.bytes, sha256: file.sha256, expected: { kind: 'missing' as const } })
    }
    const admitted = await admitPublicationPlan({ mode: 'bootstrap', root, rootIdentity, node, inspected,
        mutations }, adapters)
    if (admitted.kind !== 'complete') return admitted
    const sourceRows = sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    const files = inspected.files.map(file => ({ path: file.path, sha256: file.sha256 }))
    const previewSha256 = sha256(JSON.stringify({ target: captured.target, sources: sourceRows, files }))
    const result: SelectedBootstrapSurfaceResult = { root, target: captured.target, sources: sourceRows, files,
        previewSha256, changes: admitted.plan.changes }
    const authority: SelectedBootstrapPublicationAuthority = { kind: 'selected-bootstrap-publication-authority' }
    issuedSelectedBootstrapAuthorities.set(authority, Object.freeze({ root, rootIdentity, target: captured.target, node,
        assets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => ({ path, sha256: digest, identity }))),
        inspected, result, plan: admitted.plan, adapters }))
    return { kind: 'complete', artifact: null, destination: null, diagnostics: [], result, authority, status: 0 }
}

export async function applySelectedBootstrapSurface(
    authority: SelectedBootstrapPublicationAuthority,
): Promise<SelectedBootstrapSurfaceOutcome> {
    const record = authority !== null && typeof authority === 'object' ? issuedSelectedBootstrapAuthorities.get(authority) : undefined
    if (!record) return refuse('GENERATED_PUBLICATION_FAILED', 'selected bootstrap publication authority is unknown or already consumed', 'bootstrap')
    issuedSelectedBootstrapAuthorities.delete(authority)
    const outcome = await runPublicationPlan(record.plan, { execute: record.adapters.execute,
        revalidate: async () => selectedBootstrapRecordCurrent(record) })
    if (outcome.kind !== 'complete') return outcome
    return { kind: 'complete', artifact: null, destination: null, diagnostics: [],
        result: record.result, authority, status: 0 }
}

export async function resumeSelectedBootstrapSurface(
    input: SelectedBootstrapResumeInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<SelectedBootstrapResumeOutcome> {
    const captured = selectedBootstrapInput({ root: input.root, target: input.target, tools: input.tools })
    const durable = await readState(input.address)
    if (!captured || durable.kind !== 'complete' || durable.value.kind !== 'bootstrap'
        || durable.value.value.checkoutRoot !== captured.root || durable.value.target !== captured.target
        || input.address.checkoutRoot !== captured.root || input.address.target !== captured.target
        || durable.value.value.stage === 'surface-previewed') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume requires the current durable state, root and target', 'bootstrap',
    )
    const adapters = mergedAdapters(adapterOverrides)
    let rootIdentity: DirectoryIdentity
    try {
        const status = await lstat(captured.root)
        if (!status.isDirectory() || status.isSymbolicLink() || await realpath(captured.root) !== captured.root) throw new RefusalError('root')
        rootIdentity = { dev: status.dev, ino: status.ino }
    } catch (error) {
        return refuse('GENERATED_INPUT_INVALID', `selected bootstrap root is not a canonical directory: ${errorCause(error)}`, captured.root)
    }
    const node = await nodeAuthority()
    if (!node) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume could not authenticate the node executable', 'bootstrap')
    const ownership = await readAnchoredEntry(captured.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    if (ownership.kind !== 'missing' && ownership.kind !== 'file') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume ownership could not be read safely', OWNERSHIP_PATH,
    )
    const assets = await selectedBootstrapAssets(node, adapters)
    if (!assets) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume packaged assets could not be authenticated', 'bootstrap')
    const skillInput = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])), captured.tools)
    if (!skillInput) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume packaged assets are incomplete', 'bootstrap')
    const { sources } = skillInput
    const inspection = await inspectSkillSet(skillInput)
    if (inspection.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume skill set was refused', 'bootstrap')
    const inspected = projectInspectedSkillOutputs(inspection, captured.tools, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume output projection was refused', captured.target)
    const sourceRows = sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    const files = inspected.files.map(file => ({ path: file.path, sha256: file.sha256 }))
    const previewSha256 = sha256(JSON.stringify({ target: captured.target, sources: sourceRows, files }))
    const state = durable.value.value
    const sourcesCurrent = JSON.stringify(state.sources) === JSON.stringify(sourceRows)
        && JSON.stringify(state.published) === JSON.stringify(files) && state.previewSha256 === previewSha256
    if (ownership.kind === 'missing') {
        if (sourcesCurrent) return { kind: 'pending', status: 0, diagnostics: [],
            result: null, canonicalOwnership: false }
        const priorPreviewSha256 = sha256(JSON.stringify({ target: captured.target, sources: state.sources, files: state.published }))
        if (input.expectedRevision !== durable.value.revision || input.expectedCommandSha256 !== state.commandSha256
            || priorPreviewSha256 !== state.previewSha256 || state.stage !== 'surface-published'
            || JSON.stringify(state.published.map(row => row.path)) !== JSON.stringify(files.map(row => row.path))) return refuse(
            'GENERATED_SOURCE_CHANGED', 'bootstrap resume package sources differ from the accepted durable preview', 'bootstrap',
        )
        const reads = await readAnchoredBatches(captured.root, inspected.files.map(file => ({
            path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
        })), node, adapters)
        if (!reads || reads.kind !== 'complete' || reads.results.length !== inspected.files.length) return refuse(
            'SURFACE_STATE_CONFLICT', 'bootstrap refresh destinations could not be authenticated', captured.target,
        )
        const mutations: PublicationMutation[] = []
        for (const [index, file] of inspected.files.entries()) {
            const current = reads.results[index]!
            const prior = state.published[index]!
            if (current.kind !== 'file' || current.sha256 !== prior.sha256 && current.sha256 !== file.sha256) return refuse(
                'SURFACE_STATE_CONFLICT', 'bootstrap refresh destination differs from its authenticated publication', file.path,
            )
            if (current.sha256 === file.sha256) continue
            const expected = expectedState(current)
            if (!expected) return refuse('SURFACE_STATE_CONFLICT', 'bootstrap refresh destination could not be authenticated', file.path)
            mutations.push({ path: file.path, phase: 'desired', operation: 'write-file',
                bytes: file.bytes, sha256: file.sha256, expected })
        }
        const admitted = await admitPublicationPlan({ mode: 'bootstrap', root: captured.root, rootIdentity, node, inspected,
            mutations, refresh: { address: input.address,
                revision: durable.value.revision, commandSha256: state.commandSha256 } }, adapters)
        if (admitted.kind !== 'complete') return admitted
        const result: SelectedBootstrapSurfaceResult = { root: captured.root, target: captured.target,
            sources: sourceRows, files, previewSha256, changes: admitted.plan.changes }
        const authority: SelectedBootstrapPublicationAuthority = { kind: 'selected-bootstrap-publication-authority' }
        issuedSelectedBootstrapAuthorities.set(authority, Object.freeze({ root: captured.root, rootIdentity,
            target: captured.target, node,
            assets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => ({ path, sha256: digest, identity }))),
            inspected, result, plan: admitted.plan, adapters,
            bootstrapState: Object.freeze({ address: input.address, record: durable.value }),
        }))
        return { kind: 'refresh', status: 0, diagnostics: [], result, authority,
            canonicalOwnership: false }
    }
    if (ownership.kind !== 'file') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume ownership changed after classification', OWNERSHIP_PATH,
    )
    if (!sourcesCurrent) return refuse(
        'GENERATED_SOURCE_CHANGED', 'bootstrap resume package sources differ from the accepted durable preview', 'bootstrap',
    )
    const base = await prepare({ configPath: join(captured.root, 'cockpit.toml') }, adapters)
    if ('status' in base) return base
    const canonical = await readOwnership(base, adapters)
    if (base.root !== captured.root || canonical.kind !== 'complete'
        || canonical.manifest.format !== 'cockpit-generated-ownership/v3' || canonical.sha256 !== ownership.sha256) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume requires canonical ownership bound to the current checkout and configuration', OWNERSHIP_PATH,
    )
    const current = await readAnchoredEntry(captured.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    const refreshed = await readState(input.address)
    if (current.kind !== 'file' || current.sha256 !== ownership.sha256
        || sourceIdentity(current.identity) !== sourceIdentity(ownership.identity)
        || refreshed.kind !== 'complete' || JSON.stringify(refreshed.value) !== JSON.stringify(durable.value)) return refuse(
        'GENERATED_SOURCE_CHANGED', 'bootstrap resume ownership or state changed during checking', 'bootstrap',
    )
    return { kind: 'complete', status: 0, diagnostics: [], canonicalOwnership: true,
        result: { root: captured.root, target: captured.target, sources: sourceRows, files, previewSha256,
            changes: [] } }
}

export async function authenticatedBootstrapPriorSurfaces(
    root: string,
    state: NonNullable<GeneratedEnvironmentSyncInput['bootstrapState']>,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly SurfacePriorOwnedEntry[] | undefined> {
    const publication = state.publication
    if (publication === null || typeof publication !== 'object' || consumedBootstrapStatePublications.has(publication)) return undefined
    const authenticated = authenticateStatePublication(state)
    if (!authenticated || authenticated.status !== 'complete' || authenticated.record.kind !== 'bootstrap') return undefined
    const record = authenticated.record
    if (record.target !== state.address.target || state.address.checkoutRoot !== root) return undefined
    const surfaces = await bootstrapPublishedSurfaces(root, record, node, adapters)
    if (surfaces) consumedBootstrapStatePublications.add(publication)
    return surfaces
}

// A plain sync between an interrupted init and its rerun met init's own setup skill files with no
// ownership record and refused them, and its remedy had an agent delete them. The bootstrap record
// sync reads here comes from this user's private state root, scoped to this cockpit root, and the
// files must still hold exactly the bytes init published from the installed package.
export async function unfinishedInitSurfaces(
    root: string,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<UnfinishedInit | undefined> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined
    for (const target of SURFACE_TARGETS) {
        const namespace = await selectBootstrapStateRoot({ platform: process.platform, home: process.env.HOME,
            xdgStateHome: process.env.XDG_STATE_HOME, checkoutRoot: root, target })
        if (namespace.kind !== 'complete') return undefined
        const read = await readState(namespace.value.paths.bootstrap(target))
        if (read.kind === 'complete') return { root, target, published: read.value.value.published.map(row => row.path),
            surfaces: await bootstrapPublishedSurfaces(root, read.value, node, adapters) }
    }
    return undefined
}

export interface UnfinishedInit {
    readonly root: string
    readonly target: SurfaceTarget
    readonly published: readonly string[]
    /** Absent when the files no longer hold what init recorded, so sync cannot take them over. */
    readonly surfaces: readonly SurfacePriorOwnedEntry[] | undefined
}

async function bootstrapPublishedSurfaces(
    root: string,
    record: BootstrapStateRecord,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly SurfacePriorOwnedEntry[] | undefined> {
    if (record.kind !== 'bootstrap' || record.value.stage === 'surface-previewed' || record.value.checkoutRoot !== root
        || record.value.target !== record.target) return undefined
    const assets = await selectedBootstrapAssets(node, adapters)
    if (!assets) return undefined
    // The record names no tools, so they are the targets whose setup skill it published, in published order.
    const allTools = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])), SURFACE_TARGETS)
    const allInspection = allTools && await inspectSkillSet(allTools)
    const allProjection = allInspection?.kind === 'complete'
        ? projectInspectedSkillOutputs(allInspection, SURFACE_TARGETS, SHIPPED_SETUP_SKILL) : undefined
    if (allProjection?.kind !== 'complete') return undefined
    const targetByPath = new Map(allProjection.files.map(file => [file.path, file.target]))
    const tools = [...new Set(record.value.published.map(row => targetByPath.get(row.path)))]
    if (tools.some(tool => tool === undefined)) return undefined
    const skillInput = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])), tools as SurfaceTarget[])
    if (!skillInput) return undefined
    const sourceRows = skillInput.sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    if (JSON.stringify(sourceRows) !== JSON.stringify(record.value.sources)) return undefined
    const inspection = await inspectSkillSet(skillInput)
    if (inspection.kind !== 'complete') return undefined
    const inspected = projectInspectedSkillOutputs(inspection, tools as SurfaceTarget[], SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return undefined
    const files = inspected.files
    const published = files.map(file => ({ path: file.path, sha256: file.sha256 }))
    if (JSON.stringify(published) !== JSON.stringify(record.value.published)) return undefined
    const reads = await readAnchoredBatches(root, files.map(file => ({
        path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== files.length
        || reads.results.some((read, index) => read.kind !== 'file' || read.sha256 !== files[index]!.sha256)) return undefined
    return files.map(file => ({
        kind: 'file' as const, path: file.path, harnesses: [file.target] as [SurfaceTarget], scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const,
        ownership: 'whole-file' as const, sha256: file.sha256,
    }))
}
