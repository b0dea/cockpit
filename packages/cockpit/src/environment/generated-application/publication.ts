import { initCommand } from '../../fix-catalogue.js'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SURFACE_PUBLICATION_ANCHORS } from '../../surfaces/harness-registry.js'
import {
    classifyGeneratedPaths,
    encodeOwnershipManifest,
    projectGeneratedPathFacts,
    type GeneratedPathFact,
    type GeneratedPathClassificationResult,
    type EnvironmentOwnershipEntry,
    type OwnershipManifest,
    type SurfaceDiagnostic,
    type SurfacePriorOwnedEntry,
} from '../../surfaces/ownership.js'
import { observeSiblingGuides } from '../../surfaces/projection.js'
import type { SurfaceInputEvidence } from '../../surfaces/render.js'
import { planSurfaceChanges, type SurfaceChange, type SurfaceObservedEntry, type SurfaceChangePlanResult } from '../../surfaces/sync.js'
import {
    readAnchoredFile,
    readAnchoredEntry,
    readAnchoredBatches,
    expectedState,
    admitPublicationPlan,
    type AnchoredEntry,
    type AnchoredBatchReadResult,
    type PublicationMutation,
    type PublicationPlan,
} from '../../generated-environment/transaction.js'
import { RefusalError, hasErrorCode } from '../contract.js'
import { cockpitId } from '../identity.js'
import { revalidateGeneratedCheckoutIdentity } from '../setup-observation.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import {
    COMPOSE_SOURCE_BYTES,
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentSyncInput,
    MAX_GENERATED_BYTES,
    MAX_OWNED_FILES,
    MAX_OWNERSHIP_BYTES,
    MAX_SURFACE_FILE_BYTES,
    OWNERSHIP_PATH,
    type PreparedEnvironment,
    type RefusalOutcome,
    SURFACE_ROOT,
    compareCodeUnits,
    confined,
    generatedPathFacts,
    mergedAdapters,
    sha256,
    siblingRootsCurrent,
    sourceIdentity,
} from './shared.js'
import { type OwnershipState, expectedOutputExists, prepare, readOwnership, renamedStackRefusal, safePath, syncCommandInput } from './prepare.js'
import { type UnfinishedInit, authenticatedBootstrapPriorSurfaces, unfinishedInitSurfaces } from './bootstrap-skill.js'
import { prepareSurfaces } from './surfaces.js'

export async function inputSourcesCurrent(
    prepared: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters,
    deadline?: number,
): Promise<boolean> {
    try {
        if (deadline !== undefined && Date.now() >= deadline) return false
        if (!await revalidateGeneratedCheckoutIdentity(prepared.checkoutIdentity)) return false
        if (!await siblingRootsCurrent(prepared.siblingRoots)) return false
        if (prepared.guardHandler) {
            const handler = prepared.guardHandler
            const root = await lstat(prepared.root)
            const config = await lstat(prepared.configPath)
            const module = await readAnchoredFile(dirname(handler.module), basename(handler.module), MAX_GENERATED_BYTES, prepared.node, adapters)
            if (String(root.ino) !== handler.rootInode
                || config.isSymbolicLink() || String(config.ino) !== handler.configInode
                || module.kind !== 'complete' || module.sha256 !== handler.moduleSha256) return false
        }
        const target = await safePath(prepared.root, prepared.configSource.path, false)
        if (!target) return false
        for (const expected of prepared.sourceRoots) {
            const status = await lstat(expected.root)
            if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== expected.identity.dev || status.ino !== expected.identity.ino) return false
            if (deadline !== undefined && Date.now() >= deadline) return false
        }
        if (prepared.guideSources.requests.length > 0) {
            const current = await observeSiblingGuides({
                allowedRoots: [...new Set(prepared.guideSources.requests.map(row => row.root))],
                requests: prepared.guideSources.requests,
            })
            const observations = current.kind === 'complete'
                ? [...current.observations].sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath)) : []
            const missing = current.kind === 'complete' ? [...current.missing].sort(compareCodeUnits) : []
            if ((deadline !== undefined && Date.now() >= deadline) || current.kind !== 'complete'
                || missing.length !== prepared.guideSources.missing.length
                || missing.some((path, index) => path !== prepared.guideSources.missing[index])
                || observations.length !== prepared.guideSources.observations.length
                || observations.some((row, index) => {
                    const expected = prepared.guideSources.observations[index]
                    return !expected || row.slug !== expected.slug || row.sourcePath !== expected.sourcePath
                        || row.sourceEntryType !== expected.sourceEntryType || row.sourceLinkTarget !== expected.sourceLinkTarget
                        || row.contentPath !== expected.contentPath || row.content !== expected.content
                        || row.contentBytes !== expected.contentBytes || row.contentSha256 !== expected.contentSha256
                        || row.contentIdentity !== expected.contentIdentity
                        || JSON.stringify(row.importTargets ?? []) !== JSON.stringify(expected.importTargets ?? [])
                })) return false
        }
        const mcpByRoot = new Map<string, Array<Extract<SurfaceInputEvidence, { kind: 'mcp' }>>>()
        for (const evidence of prepared.sourceEvidence) if (evidence.kind === 'mcp') {
            const group = mcpByRoot.get(evidence.root) ?? []
            group.push(evidence)
            mcpByRoot.set(evidence.root, group)
        }
        for (const [root, evidence] of mcpByRoot) {
            const reads = await readAnchoredBatches(root, evidence.map(row => ({
                path: row.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-file' as const,
            })), prepared.node, adapters, deadline)
            if (!reads || reads.kind !== 'complete' || reads.results.length !== evidence.length || reads.results.some((read, index) => read.kind !== 'complete'
                || read.sha256 !== evidence[index]!.sha256 || sourceIdentity(read.identity) !== evidence[index]!.identity)) return false
            if (deadline !== undefined && Date.now() >= deadline) return false
        }
        const reads = await readAnchoredBatches(prepared.root, [
            { path: prepared.configSource.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-file' as const },
            ...prepared.customSources.map(source => ({ path: source.path, maxBytes: source.maxBytes, action: 'read-file' as const })),
            ...(prepared.nativeHookPolicySource ? [{ path: prepared.nativeHookPolicySource.path,
                maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const }] : []),
            ...prepared.adoptedSources.map(source => ({ path: source.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const })),
            ...prepared.composeSources.map(source => ({ path: source.path, maxBytes: COMPOSE_SOURCE_BYTES, action: 'read-file' as const })),
        ], prepared.node, adapters, deadline)
        const adoptedOffset = prepared.customSources.length + 1 + (prepared.nativeHookPolicySource ? 1 : 0)
        const composeOffset = adoptedOffset + prepared.adoptedSources.length
        if ((deadline !== undefined && Date.now() >= deadline) || !reads || reads.kind !== 'complete'
            || reads.results.length !== composeOffset + prepared.composeSources.length) return false
        const source = reads.results[0]!
        const expected = prepared.configSourceIdentity
        const localCurrent = source.kind === 'complete' && source.sha256 === prepared.configSource.sha256
            && source.identity.root.dev === expected.root.dev && source.identity.root.ino === expected.root.ino
            && source.identity.file.dev === expected.file.dev && source.identity.file.ino === expected.file.ino
            && source.identity.chain.length === expected.chain.length
            && source.identity.chain.every((entry, index) => entry.dev === expected.chain[index]?.dev && entry.ino === expected.chain[index]?.ino)
            && prepared.customSources.every((custom, index) => {
                const read = reads.results[index + 1]!
                return read.kind === 'complete' && read.sha256 === custom.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(custom.identity)
            })
            && (!prepared.nativeHookPolicySource || (() => {
                const read = reads.results[prepared.customSources.length + 1]!
                return read.kind === 'complete' && read.sha256 === prepared.nativeHookPolicySource.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(prepared.nativeHookPolicySource.identity)
            })())
            && prepared.adoptedSources.every((adopted, index) => {
                const read = reads.results[adoptedOffset + index]!
                return read.kind === 'complete' && read.sha256 === adopted.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(adopted.identity)
            })
            && prepared.composeSources.every((compose, index) => {
                const read = reads.results[composeOffset + index]!
                return read.kind === 'complete' && read.sha256 === compose.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(compose.identity)
            })
        if (!localCurrent) return false
        const assetReads = prepared.surfaceAssets.length === 0
            ? { kind: 'complete' as const, results: [] }
            : await readAnchoredBatches(SURFACE_ROOT, prepared.surfaceAssets.map(asset => ({
            path: asset.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), prepared.node, adapters, deadline)
        if (!assetReads || assetReads.kind !== 'complete' || assetReads.results.length !== prepared.surfaceAssets.length || assetReads.results.some((read, index) => read.kind !== 'complete'
            || read.sha256 !== prepared.surfaceAssets[index]!.sha256
            || sourceIdentity(read.identity) !== sourceIdentity(prepared.surfaceAssets[index]!.identity))) return false
        if (deadline !== undefined && Date.now() >= deadline) return false
        return true
    } catch { /* a failed re-observation means the inputs changed; the caller refuses. */ return false }
}

function publicationInputPath(root: string, path: string): string | undefined {
    const offset = relative(root, isAbsolute(path) ? path : resolve(root, path))
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
        ? offset : undefined
}

export async function ownedInputOverlap(
    prepared: PreparedEnvironment,
    prior: readonly Readonly<{ path: string }>[],
): Promise<Readonly<{ kind: 'complete'; path?: string }> | Readonly<{ kind: 'invalid' }>> {
    const presentInputPaths = [
        prepared.configPath,
        resolve(prepared.root, prepared.configSource.path),
        ...prepared.guideSources.observations.flatMap(observation => [observation.sourcePath, observation.contentPath]),
        ...prepared.sourceEvidence.filter((row): row is Extract<SurfaceInputEvidence, { kind: 'mcp' }> => row.kind === 'mcp')
            .map(evidence => resolve(evidence.root, evidence.path)),
        ...prepared.customSources.map(source => resolve(prepared.root, source.path)),
        ...(prepared.nativeHookPolicySource ? [resolve(prepared.root, prepared.nativeHookPolicySource.path)] : []),
        ...prepared.adoptedSources.map(source => resolve(prepared.root, source.path)),
    ]
    const requiredPresentPaths = new Set(presentInputPaths)
    const missingGuidePaths = new Set(prepared.guideSources.missing)
    const inputPaths = [...presentInputPaths, ...missingGuidePaths]
    const pathsUnderRoot = [...inputPaths, ...prior.map(row => resolve(prepared.root, row.path))]
        .map(path => publicationInputPath(prepared.root, path))
        .filter((path): path is string => path !== undefined)
    const directories = new Set([prepared.root])
    for (const path of pathsUnderRoot) {
        const segments = path.split(sep).slice(0, -1)
        let directory = prepared.root
        for (const segment of segments) {
            directory = resolve(directory, segment)
            directories.add(directory)
        }
    }
    if (directories.size > MAX_OWNED_FILES * 4 || constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) {
        return { kind: 'invalid' }
    }
    type DirectoryWatch = Readonly<{
        path: string
        handle: Awaited<ReturnType<typeof open>>
        dev: bigint
        ino: bigint
        mtimeNs: bigint
        ctimeNs: bigint
    }>
    const handles: Array<Awaited<ReturnType<typeof open>>> = []
    const watches: DirectoryWatch[] = []
    let outcome: Readonly<{ kind: 'complete'; path?: string }> | Readonly<{ kind: 'invalid' }> = { kind: 'invalid' }
    let closeFailed = false
    const stable = async (watch: DirectoryWatch): Promise<boolean> => {
        const opened = await watch.handle.stat({ bigint: true })
        const named = await lstat(watch.path, { bigint: true })
        return opened.isDirectory() && named.isDirectory() && !named.isSymbolicLink()
            && opened.dev === watch.dev && opened.ino === watch.ino
            && opened.mtimeNs === watch.mtimeNs && opened.ctimeNs === watch.ctimeNs
            && named.dev === watch.dev && named.ino === watch.ino
            && named.mtimeNs === watch.mtimeNs && named.ctimeNs === watch.ctimeNs
    }
    try {
        for (const path of [...directories].sort(compareCodeUnits)) {
            let handle: Awaited<ReturnType<typeof open>>
            try {
                handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT') && path !== prepared.root) continue
                throw error
            }
            handles.push(handle)
            const opened = await handle.stat({ bigint: true })
            const named = await lstat(path, { bigint: true })
            if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
                || opened.dev !== named.dev || opened.ino !== named.ino) throw new RefusalError('directory identity changed')
            if (path === prepared.root && (opened.dev !== BigInt(prepared.configSourceIdentity.root.dev)
                || opened.ino !== BigInt(prepared.configSourceIdentity.root.ino))) throw new RefusalError('publication root identity changed')
            watches.push({ path, handle, dev: opened.dev, ino: opened.ino,
                mtimeNs: opened.mtimeNs, ctimeNs: opened.ctimeNs })
        }
        if (!(await Promise.all(watches.map(stable))).every(Boolean)) throw new RefusalError('directory namespace changed')
        const exact = new Set<string>()
        const physical: Array<Readonly<{ dev: number; ino: number }>> = []
        for (const path of [...new Set(inputPaths)].sort(compareCodeUnits)) {
            const input = publicationInputPath(prepared.root, path)
            if (input) exact.add(input)
            let status: Awaited<ReturnType<typeof lstat>>
            try {
                status = await lstat(path)
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT')
                    && missingGuidePaths.has(path) && !requiredPresentPaths.has(path)) continue
                throw error
            }
            physical.push({ dev: status.dev, ino: status.ino })
        }
        for (const row of [...prior].sort((left, right) => compareCodeUnits(left.path, right.path))) {
            if (exact.has(row.path)) {
                outcome = { kind: 'complete', path: row.path }
                break
            }
            const path = resolve(prepared.root, row.path)
            let status: Awaited<ReturnType<typeof lstat>>
            try {
                status = await lstat(path)
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT')) continue
                throw error
            }
            if (physical.some(input => input.dev === status.dev && input.ino === status.ino)) {
                outcome = { kind: 'complete', path: row.path }
                break
            }
        }
        if (outcome.kind === 'invalid') outcome = { kind: 'complete' }
        if (!(await Promise.all(watches.map(stable))).every(Boolean)) outcome = { kind: 'invalid' }
    } catch {
        // an unobservable directory is reported as an invalid read.
        outcome = { kind: 'invalid' }
    } finally {
        for (const handle of handles.reverse()) try { await handle.close() } catch { /* an unobservable directory is reported as an invalid read. */ closeFailed = true }
    }
    return closeFailed ? { kind: 'invalid' } : outcome
}

async function surfaceObservationMaxBytes(root: string, path: string): Promise<number | undefined> {
    const target = confined(root, path)
    if (!target) return undefined
    try {
        const status = await lstat(target)
        if (!status.isFile() || status.isSymbolicLink()) return 1
        if (!Number.isSafeInteger(status.size) || status.size < 0) return undefined
        return Math.min(MAX_GENERATED_BYTES, Math.max(1, status.size))
    } catch (error) {
        return hasErrorCode(error, 'ENOENT') ? 1 : undefined
    }
}

export async function observeSurfaceState(
    prepared: PreparedEnvironment,
    prior: readonly SurfacePriorOwnedEntry[],
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<{ observed: readonly SurfaceObservedEntry[]; raw: ReadonlyMap<string, AnchoredEntry>; opaque: ReadonlySet<string> } | undefined> {
    const paths = new Set([...prepared.surfaces.map(row => row.path), ...prior.map(row => row.path)])
    if (prepared.surfaces.some(row => row.path === 'opencode.jsonc')) paths.add('opencode.json')
    const raw = new Map<string, AnchoredEntry>()
    const observed: SurfaceObservedEntry[] = []
    const opaque = new Set<string>()
    const orderedPaths = [...paths].sort(compareCodeUnits)
    const maxBytes = await Promise.all(orderedPaths.map(path => surfaceObservationMaxBytes(prepared.root, path)))
    if (maxBytes.some(limit => limit === undefined)) return undefined
    const entries = await readAnchoredBatches(prepared.root, orderedPaths.map((path, index) => ({
        path, maxBytes: maxBytes[index]!, action: 'read-entry' as const,
    })), prepared.node, adapters)
    if (!entries || entries.kind !== 'complete' || entries.results.length !== orderedPaths.length) return undefined
    for (const [index, path] of orderedPaths.entries()) {
        const entry = entries.results[index]!
        if (entry.kind === 'invalid') return undefined
        if (entry.kind === 'complete') return undefined
        raw.set(path, entry)
        if (entry.kind === 'missing') observed.push({ path, kind: 'missing' })
        else if (entry.kind === 'file') {
            let bytes: string
            try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes) } catch {
                // undecodable bytes make the path opaque, never owned.
                opaque.add(path)
                continue
            }
            observed.push({ path, kind: 'file', bytes, sha256: entry.sha256, identity: sourceIdentity(entry.identity) })
        } else if (entry.kind === 'symlink') observed.push({ path, kind: 'symlink', target: entry.target, identity: JSON.stringify(entry.identity) })
        else observed.push({ path, kind: 'other', identity: 'other' })
    }
    return { observed, raw, opaque }
}

export async function classifyOwnedState(
    prepared: PreparedEnvironment,
    manifest: OwnershipManifest | undefined,
    raw: ReadonlyMap<string, AnchoredBatchReadResult>,
): Promise<GeneratedPathClassificationResult> {
    const current = generatedPathFacts(prepared, 'declared-before-sync')
    if (current.kind !== 'complete') return current
    const historical = manifest ? projectGeneratedPathFacts(manifest, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath }, []) : { kind: 'complete' as const, facts: [] }
    if (historical.kind !== 'complete') return historical
    const previous = new Map(historical.facts.map(fact => [fact.path, fact]))
    const desired = new Map(current.facts.map(fact => [fact.path, fact]))
    const facts: GeneratedPathFact[] = []
    const observations: Array<Record<string, unknown>> = []
    for (const [path, observed] of raw) {
        const fact = observed.kind === 'missing'
            ? desired.get(path) ?? previous.get(path) : previous.get(path) ?? desired.get(path)
        if (!fact) continue
        facts.push(fact)
        if (observed.kind === 'file') observations.push({ path, kind: 'file', bytes: observed.bytes, confinement: 'confined', identity: sourceIdentity(observed.identity) })
        else observations.push({ path, kind: observed.kind, confinement: observed.kind === 'missing' ? 'confined' : 'unknown' })
    }
    return classifyGeneratedPaths(facts, observations)
}

export function planObservedSurfaces(
    prepared: PreparedEnvironment,
    priorOwned: readonly SurfacePriorOwnedEntry[],
    state: NonNullable<Awaited<ReturnType<typeof observeSurfaceState>>>,
): SurfaceChangePlanResult {
    const plan = planSurfaceChanges({ configuredHarnesses: [...new Set([...prepared.configuredHarnesses, ...priorOwned.flatMap(row => row.harnesses)])].sort(),
        desired: prepared.surfaces.filter(row => !state.opaque.has(row.path)),
        priorOwned: priorOwned.filter(row => !state.opaque.has(row.path)), observed: state.observed })
    if (plan.kind !== 'complete') return plan
    const extra: SurfaceChange[] = []
    for (const path of state.opaque) {
        const prior = priorOwned.find(row => row.path === path)
        const desired = prepared.surfaces.find(row => row.path === path)
        const raw = state.raw.get(path)
        if (!prior || prior.kind !== 'file' || raw?.kind !== 'file' || prior.sha256 !== raw.sha256
            || desired && desired.kind !== 'file') return { kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT', message: 'opaque surface bytes do not match authenticated whole-file ownership', target: path } }
        extra.push(desired ? { kind: 'write', path, desired } : { kind: 'remove', path, priorOwned: prior })
    }
    const actions = [...plan.actions, ...extra].sort((a, b) => (a.kind === 'write' ? 0 : 1) - (b.kind === 'write' ? 0 : 1) || compareCodeUnits(a.path, b.path))
    return { kind: 'complete', actions }
}

/** A hand edit to a merged adopted file belongs in its adopted copy; say so where the conflict is reported. */
export function surfacePlanRefusal(prepared: PreparedEnvironment, diagnostic: SurfaceDiagnostic, unfinishedInit?: UnfinishedInit): RefusalOutcome {
    const adopted = diagnostic.code === 'SURFACE_STATE_CONFLICT'
        ? prepared.registry.config.surfaces.adopted.find(row => row.path === diagnostic.target) : undefined
    // Plain sync met a setup file an unfinished init published and can no longer vouch for; the
    // person needs to hear about that init, not only that the file is unrecorded.
    if (diagnostic.code === 'SURFACE_STATE_CONFLICT' && unfinishedInit && !unfinishedInit.surfaces
        && diagnostic.target !== undefined && unfinishedInit.published.includes(diagnostic.target)) {
        return refuse(diagnostic.code, `${diagnostic.message}; an unfinished init for this root (--target ${unfinishedInit.target}) published it, and it no longer holds the bytes that init recorded or the installed cockpit package changed since`,
            diagnostic.target, `resume that init with ${initCommand({ root: unfinishedInit.root, target: unfinishedInit.target })} and the options you started it with, which shows its current preview; or ask the person who ran init before you remove cockpit.toml and the files it published so init starts again`)
    }
    return adopted
        ? refuse(diagnostic.code, `${diagnostic.message}; ${adopted.path} is merged from ${adopted.source}`, diagnostic.target,
            `make the change in ${adopted.source}, then ask the person who owns the cockpit before you delete ${adopted.path}, and run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>`)
        : refuse(diagnostic.code, diagnostic.message, diagnostic.target, diagnostic.fix)
}

function surfaceMutations(
    actions: readonly SurfaceChange[],
    raw: ReadonlyMap<string, AnchoredEntry>,
    compactSurfacePaths: ReadonlySet<string>,
): readonly PublicationMutation[] | undefined {
    const compactAnchorFor = (path: string): string | undefined => {
        return SURFACE_PUBLICATION_ANCHORS.find(anchor => path.startsWith(`${anchor}/`))
    }
    const result: PublicationMutation[] = []
    for (const action of actions) {
        if (action.kind === 'already-absent') continue
        const current = raw.get(action.path) ?? { kind: 'missing' as const }
        const expected = expectedState(current)
        if (!expected) return undefined
        if (action.kind === 'write') {
            const compactAnchor = compactSurfacePaths.has(action.path) ? compactAnchorFor(action.path) : undefined
            const bytes = action.desired.kind === 'file' ? action.desired.bytes : action.postimage
            if (bytes === undefined) return undefined
            result.push({ path: action.path, phase: 'desired', operation: 'write-file', bytes, sha256: sha256(bytes), expected,
                ...(compactAnchor ? { compactAnchor } : {}) })
        } else if (action.postimage !== undefined) result.push({ path: action.path, phase: 'stale', operation: 'write-file', bytes: action.postimage,
            sha256: sha256(action.postimage), expected })
        else result.push({ path: action.path, phase: 'stale', operation: 'remove-file', expected })
    }
    return result
}

async function environmentMutations(
    prepared: PreparedEnvironment,
    manifest: OwnershipManifest | undefined,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<Readonly<{ kind: 'complete'; mutations: readonly PublicationMutation[] }> | Readonly<{ kind: 'invalid'; path: string }>> {
    const prior = manifest?.entries ?? []
    const surfacePaths = new Set(prepared.surfaces.map(row => row.path))
    const priorEnvironment = new Map(prior.filter((row): row is EnvironmentOwnershipEntry => !('harnesses' in row) && !surfacePaths.has(row.path)).map(row => [row.path, row]))
    const desired = new Map(prepared.owned.map(row => [row.path, row]))
    const paths = [...new Set([...priorEnvironment.keys(), ...desired.keys()])].sort(compareCodeUnits)
    const mutations: PublicationMutation[] = []
    const entries = await readAnchoredBatches(prepared.root, paths.map(path => ({
        path, maxBytes: MAX_GENERATED_BYTES, action: 'read-entry' as const,
    })), prepared.node, adapters)
    if (!entries) return { kind: 'invalid', path: paths[0] ?? 'generated-environment' }
    if (entries.kind === 'invalid') return { kind: 'invalid', path: paths[entries.index] ?? paths[0] ?? 'generated-environment' }
    if (entries.results.length !== paths.length) return { kind: 'invalid', path: paths[0] ?? 'generated-environment' }
    const classified = await classifyOwnedState(prepared, manifest, new Map(paths.map((path, index) => [path, entries.results[index]!])))
    if (classified.kind !== 'complete') return { kind: 'invalid', path: classified.diagnostic.target ?? 'generated-environment' }
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return { kind: 'invalid', path: unknown.fact.path }
    for (const [index, path] of paths.entries()) {
        const current = entries.results[index]!
        if (current.kind === 'complete') return { kind: 'invalid', path }
        const expected = expectedState(current)
        if (!expected) return { kind: 'invalid', path }
        const owned = priorEnvironment.get(path)
        const next = desired.get(path)
        if (current.kind !== 'missing' && (!owned || current.kind !== 'file'
            || current.sha256 !== owned.sha256 && next?.sha256 !== owned.sha256)) {
            return { kind: 'invalid', path }
        }
        if (next) {
            if (current.kind === 'file' && current.sha256 === next.sha256) continue
            mutations.push({ path, phase: 'desired', operation: 'write-file', bytes: next.bytes, sha256: next.sha256, expected })
        } else if (current.kind === 'file') mutations.push({ path, phase: 'stale', operation: 'remove-file', expected })
    }
    return { kind: 'complete', mutations }
}

export async function preparePublication(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
    seed?: PreparedEnvironment,
    knownOwnership?: OwnershipState,
): Promise<RefusalOutcome | Readonly<{
    prepared: PreparedEnvironment; ownership: OwnershipState; plan: PublicationPlan
}> | Readonly<{
    prepared: PreparedEnvironment; ownership: OwnershipState; refusal: RefusalOutcome
}>> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const adapters = mergedAdapters(adapterOverrides)
    const base = seed ?? await prepare({ configPath: request.configPath }, adapters)
    if ('status' in base) return base
    const ownership = knownOwnership ?? await readOwnership(base, adapters)
    if (ownership.kind === 'unsupported') return refuse(
        'GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', `generated ownership format ${ownership.format} is not supported`, OWNERSHIP_PATH,
    )
    if (ownership.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is malformed or unsafe', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    if (ownership.kind === 'complete' && ownership.manifest.cockpitId !== base.cockpitId) {
        const recorded = await renamedStackRefusal(base)
        if (recorded) return recorded
    }
    const unfinishedInit = ownership.kind === 'missing' && !request.bootstrapState
        ? await unfinishedInitSurfaces(base.root, base.node, adapters) : undefined
    const adoptedBootstrap = ownership.kind !== 'missing' ? undefined : request.bootstrapState
        ? await authenticatedBootstrapPriorSurfaces(base.root, request.bootstrapState, base.node, adapters)
        : unfinishedInit?.surfaces
    if (ownership.kind === 'missing' && request.bootstrapState && !adoptedBootstrap) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'the setup skill files init published no longer hold the bytes it recorded, or the installed cockpit package changed since init published them, so sync cannot take them over as cockpit\'s own', 'bootstrap',
        `if the cockpit package was upgraded, run ${initCommand({ args: '--json' })} and accept its fresh preview; otherwise restore the setup skill files init published (its --json preview lists them under result.files), or ask the person who ran init before you remove cockpit.toml and those files so init starts again`,
    )
    if (ownership.kind !== 'missing' && request.bootstrapState) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap adoption is only valid before the first ownership manifest', 'bootstrap',
    )
    if (ownership.kind === 'missing' && await expectedOutputExists(base)) return refuse(
        'GENERATED_OWNERSHIP_MISSING', 'generated outputs exist without durable ownership metadata', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    const current = await readAnchoredEntry(base.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, base.node, adapters)
    if (ownership.kind === 'missing' ? current.kind !== 'missing'
        : current.kind !== 'file' || current.sha256 !== ownership.sha256
            || sourceIdentity(current.identity) !== sourceIdentity(ownership.identity)) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata changed after observation', OWNERSHIP_PATH,
    )
    const priorEntries = ownership.kind === 'complete' ? ownership.manifest.entries : []
    const priorSurfaces = [...priorEntries.filter((row): row is SurfacePriorOwnedEntry => 'harnesses' in row), ...(adoptedBootstrap ?? [])]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    const prepared = await prepareSurfaces(base, priorSurfaces, adapters, ownership.kind === 'complete' ? ownership.manifest : undefined)
    if ('status' in prepared) return prepared
    const ownedInput = await ownedInputOverlap(prepared, priorEntries)
    if (ownedInput.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'authenticated input identity could not be compared with generated ownership metadata', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    if (ownedInput.path) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata overlaps an authenticated input', ownedInput.path,
        'restore the last trusted ownership metadata before syncing',
    )
    const surfaceState = await observeSurfaceState(prepared, priorSurfaces, adapters)
    if (!surfaceState) return refuse('SURFACE_STATE_CONFLICT', 'surface state could not be observed safely', 'surfaces')
    const classified = await classifyOwnedState(prepared, ownership.kind === 'complete' ? ownership.manifest : undefined, surfaceState.raw)
    if (classified.kind !== 'complete') return refuse(classified.diagnostic.code, classified.diagnostic.message, classified.diagnostic.target)
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return refuse('SURFACE_STATE_CONFLICT', 'owned surface identity or confinement is unknown', unknown.fact.path)
    const effectivePriorSurfaces = priorSurfaces
    const environment = await environmentMutations(prepared, ownership.kind === 'complete' ? ownership.manifest : undefined, adapters)
    if (environment.kind === 'invalid') return { prepared, ownership, refusal: refuse(
        'GENERATED_STALE_ARTIFACT_DRIFT', 'a generated whole-file path is unmanaged, changed, or unsafe', environment.path,
    ) }
    const plan = planObservedSurfaces(prepared, effectivePriorSurfaces, surfaceState)
    if (plan.kind !== 'complete') return surfacePlanRefusal(prepared, plan.diagnostic, unfinishedInit)
    const surface = surfaceMutations(plan.actions, surfaceState.raw, prepared.compactSurfacePaths)
    if (!surface) return refuse('SURFACE_STATE_CONFLICT', 'surface change plan could not be admitted', 'surfaces')
    const all = [...environment.mutations, ...surface]
    if (new Set(all.map(row => row.path)).size !== all.length) return refuse('SURFACE_PATH_CONFLICT', 'generated output estates overlap', 'generated-environment')
    const publication = await admitPublicationPlan({
        authority: { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath },
        generation: prepared.generation,
        sourceSha256: prepared.sourceSha256,
        rootIdentity: prepared.configSourceIdentity.root,
        node: prepared.node,
        mode: 'sync',
        ledgerExpected: ownership.kind === 'missing' ? { kind: 'missing' }
            : { kind: 'file', sha256: ownership.sha256, identity: ownership.identity.file },
        nextLedgerBytes: encodeOwnershipManifest(prepared).bytes,
        mutations: all,
        surfaceActions: plan.actions,
    }, adapters)
    if (publication.kind === 'refusal') return { prepared, ownership, refusal: publication }
    return { prepared, ownership, plan: publication.plan }
}
