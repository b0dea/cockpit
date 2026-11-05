import { installedPackageMetadata } from '../../package-metadata.js'
import { proposeGeneratedEnvironmentRepair } from '../../repair.js'
import { dirname, join, resolve } from 'node:path'
import { loadCockpitConfig, observeConfigSource } from '../../config/load.js'
import type { Diagnostic } from '../../diagnostics.js'
import { classifyGeneratedPaths, encodeOwnershipManifest, type SurfacePriorOwnedEntry } from '../../surfaces/ownership.js'
import { SIBLING_GUIDE_MARKER } from '../../surfaces/projection.js'
import type { SurfaceObservedEntry } from '../../surfaces/sync.js'
import { nodeAuthority, readAnchoredFile, readAnchoredBatches, type PublicationPlan } from '../../generated-environment/transaction.js'
import { errorCause, RefusalError } from '../contract.js'
import { observationEnvironment, resolveDockerExecutable } from '../executable.js'
import { assessComposeTopology, composeProjectDirectory, observeComposeTopology } from '../compose-topology.js'
import { declaredRuntime } from '../declaration.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentCommandInput,
    type GeneratedEnvironmentCommandOutcome,
    type GeneratedEnvironmentCurrentness,
    type GeneratedEnvironmentRepairAuthority,
    MAX_GENERATED_BYTES,
    OWNERSHIP_PATH,
    type PreparedEnvironment,
    compareCodeUnits,
    complete,
    defaultAdapters,
    generatedPathFacts,
    mergedAdapters,
    overrideChangedRefusal,
    sha256,
    sourceIdentity,
} from './shared.js'
import { prepare, readOwnership } from './prepare.js'
import {
    classifyOwnedState,
    inputSourcesCurrent,
    observeSurfaceState,
    ownedInputOverlap,
    planObservedSurfaces,
    preparePublication,
    surfacePlanRefusal,
} from './publication.js'
import { prepareSurfaces } from './surfaces.js'
import { staleMcpOutputsOnly } from './surface-outputs.js'

interface RepairRecord {
    readonly prepared: PreparedEnvironment
    readonly plan: PublicationPlan
    readonly adapters: GeneratedEnvironmentCommandAdapters
}
export const issuedRepairs = new WeakMap<GeneratedEnvironmentRepairAuthority, RepairRecord>()

export function issueRepairAuthority(record: RepairRecord): GeneratedEnvironmentRepairAuthority {
    const authority: GeneratedEnvironmentRepairAuthority = { kind: 'generated-environment-repair' }
    issuedRepairs.set(authority, record)
    return authority
}

export async function prepareGeneratedEnvironmentCurrentness(
    input: GeneratedEnvironmentCommandInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCurrentness> {
    const adapters = mergedAdapters(adapterOverrides)
    const base = await prepare(input, adapters)
    const ownership = 'status' in base ? undefined : await readOwnership(base, adapters)
    const publication = 'status' in base ? base : await preparePublication(input, adapters, base, ownership)
    const prepared = 'prepared' in publication ? publication.prepared : undefined
    const outcome = 'status' in publication ? publication : await checkCanonicalGeneratedEnvironment(input, prepared, adapters)
    const authority = prepared && 'plan' in publication
        ? issueRepairAuthority({ prepared, plan: publication.plan, adapters }) : undefined
    return {
        outcome,
        changes: 'plan' in publication ? publication.plan.changes : [],
        storedProducer: ownership?.kind === 'complete' ? ownership.manifest.producer : null,
        currentProducer: { package: installedPackageMetadata.name, version: installedPackageMetadata.version,
            sourceRevision: installedPackageMetadata.cockpitSourceRevision },
        fixContext: { resolvedConfigPath: prepared?.configPath ?? null,
            generatedTargets: prepared ? [...prepared.owned, ...prepared.surfaces].map(row => row.path) : [] },
        mcpServers: prepared?.mcpServers ?? [],
        ...(authority ? { repairAuthority: authority } : {}),
        ...('status' in publication ? { repairRefusal: publication }
            : 'refusal' in publication ? { repairRefusal: publication.refusal } : {}),
    }
}

// Each copied guide carries a marker naming its sibling, path and digest, so the guides whose copy in
// the AGENTS.md on disk differs from the one sync would write can be named rather than the file alone.
function staleSiblingGuides(prepared: PreparedEnvironment, observed: readonly SurfaceObservedEntry[]): readonly string[] {
    const desired = prepared.surfaces.find(entry => entry.path === 'AGENTS.md')
    const current = observed.find(entry => entry.path === 'AGENTS.md')
    const markers = (text: string) => new Map([...text.matchAll(SIBLING_GUIDE_MARKER)].map(match => [`${match[1]}/${match[2]}`, match[3]]))
    const want = markers(desired?.kind === 'shared-region' && desired.region.format === 'markdown-delimited' ? desired.region.bytes : '')
    const have = markers(current?.kind === 'file' ? current.bytes : '')
    return [...new Set([...want.keys(), ...have.keys()])].filter(key => want.get(key) !== have.get(key)).sort(compareCodeUnits)
}

export async function checkCanonicalGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
    seed?: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters = defaultAdapters,
): Promise<GeneratedEnvironmentCommandOutcome> {
    const base = seed ?? await prepare(input, adapters)
    if ('status' in base) return base
    const ownership = await readOwnership(base, adapters)
    if (ownership.kind === 'unsupported') return refuse(
        'GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', `generated ownership format ${ownership.format} is not supported`, OWNERSHIP_PATH,
    )
    if (ownership.kind !== 'complete') return refuse(
        ownership.kind === 'missing' ? 'GENERATED_OWNERSHIP_MISSING' : 'GENERATED_OWNERSHIP_INVALID',
        'durable generated ownership metadata is missing or invalid', OWNERSHIP_PATH,
        'restore trusted ownership metadata or run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const priorSurfaces = ownership.manifest.entries.filter((row): row is SurfacePriorOwnedEntry => 'harnesses' in row)
    const prepared = seed?.surfaceSelftest ? seed : await prepareSurfaces(base, priorSurfaces, adapters, ownership.manifest)
    if ('status' in prepared) return prepared
    if (prepared.changedOverrideOriginals[0]) return overrideChangedRefusal(prepared.changedOverrideOriginals[0])
    const ownedInput = await ownedInputOverlap(prepared, ownership.manifest.entries)
    if (ownedInput.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'authenticated input identity could not be compared with generated ownership metadata', OWNERSHIP_PATH,
        'restore trusted ownership metadata or run npx --no cockpit sync --config <your cockpit.toml>',
    )
    if (ownedInput.path) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata overlaps an authenticated input', ownedInput.path,
        'restore trusted ownership metadata or run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const surfaceState = await observeSurfaceState(prepared, priorSurfaces, adapters)
    if (!surfaceState) return refuse('SURFACE_STATE_CONFLICT', 'surface state could not be observed safely', 'surfaces')
    const classified = await classifyOwnedState(prepared, ownership.manifest, surfaceState.raw)
    if (classified.kind !== 'complete') return refuse(classified.diagnostic.code, classified.diagnostic.message, classified.diagnostic.target)
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return refuse('SURFACE_STATE_CONFLICT', 'owned surface identity or confinement is unknown', unknown.fact.path)
    const effectivePriorSurfaces = priorSurfaces
    const surfacePaths = new Set(prepared.surfaces.map(row => row.path))
    const staleEnvironment = ownership.manifest.entries.filter(row => !('harnesses' in row) && !surfacePaths.has(row.path)
        && !prepared.owned.some(file => file.path === row.path))
    if (staleEnvironment.length > 0) return refuse('GENERATED_STALE_ARTIFACT', 'a formerly owned generated artifact remains in durable ownership metadata', staleEnvironment[0]!.path,
        'a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal and approves the stale-removal digest it shows')
    const required = generatedPathFacts(prepared, 'required-after-sync')
    if (required.kind !== 'complete') return refuse(required.diagnostic.code, required.diagnostic.message, required.diagnostic.target)
    const canonicalReads = await readAnchoredBatches(prepared.root, prepared.generated.map(file => ({
        path: file.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-file' as const,
    })), prepared.node, adapters)
    // An indexed refusal omits the prefix receipts. Reobserve only that prefix to retain
    // first-failure ordering; the failed row remains fatal even if a later read could succeed.
    for (const [index, file] of prepared.generated.entries()) {
        try {
            const read = canonicalReads?.kind === 'complete' ? canonicalReads.results[index]
                : canonicalReads?.kind === 'invalid' && index < canonicalReads.index
                    ? await readAnchoredFile(prepared.root, file.path, MAX_GENERATED_BYTES, prepared.node, adapters)
                    : undefined
            if (!read || read.kind !== 'complete') throw new RefusalError('generated artifact unavailable')
            const fact = required.facts.find(fact => fact.path === file.path)!
            const classification = classifyGeneratedPaths([fact], [{ path: file.path, kind: 'file', bytes: read.bytes,
                confinement: 'confined', identity: sourceIdentity(read.identity) }])
            if (classification.kind !== 'complete' || classification.paths[0]?.state === 'unknown') return refuse(
                'GENERATED_ARTIFACT_MISSING', 'owned generated artifact could not be classified safely', file.path, 'run npx --no cockpit sync --config <your cockpit.toml>',
            )
            if (classification.paths[0]?.state !== 'unchanged') return refuse(
                'GENERATED_ARTIFACT_DRIFT', 'owned generated artifact differs from canonical bytes', file.path, 'run npx --no cockpit sync --config <your cockpit.toml>',
            )
        } catch (error) {
            return refuse('GENERATED_ARTIFACT_MISSING', `owned generated artifact became unreadable: ${errorCause(error)}`, file.path, 'run npx --no cockpit sync --config <your cockpit.toml>')
        }
    }
    const comparison = planObservedSurfaces(prepared, effectivePriorSurfaces, surfaceState)
    if (comparison.kind !== 'complete') return surfacePlanRefusal(prepared, comparison.diagnostic)
    const drift = comparison.actions.map(action => action.path)
    // Removing a formerly owned path is plain sync's to do only where [autonomy] stale_delete is agent or
    // the removal only narrows MCP access; otherwise it needs a person's approval of its exact digest, so
    // send the reader to the one command that can.
    const removals = comparison.actions.filter(action => action.kind === 'remove')
    const stale = removals[0]
    if (stale) return prepared.workEnvironment.policy.autonomy.stale_delete === 'agent'
        || staleMcpOutputsOnly(removals.map(action => action.path), prepared.configuredHarnesses)
        ? refuse('GENERATED_ARTIFACT_DRIFT', 'a formerly generated path is still on disk and in the ownership record', stale.path, 'run npx --no cockpit sync --config <your cockpit.toml>')
        : refuse('GENERATED_ARTIFACT_DRIFT', 'a formerly generated path is still on disk and in the ownership record', stale.path,
            'a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal and approves the stale-removal digest it shows')
    const staleGuides = drift.includes('AGENTS.md') ? staleSiblingGuides(prepared, surfaceState.observed) : []
    if (staleGuides.length > 0) return refuse('GENERATED_ARTIFACT_DRIFT',
        `AGENTS.md holds an out-of-date copy of ${staleGuides.join(', ')}: the guide changed in its sibling, or the declared guides changed, since the last sync`,
        'AGENTS.md', 'run npx --no cockpit sync --config <your cockpit.toml>, then commit AGENTS.md together with the guide change')
    if (drift.length > 0) return refuse('GENERATED_ARTIFACT_DRIFT', 'owned surface state differs from the canonical model', drift[0]!, 'run npx --no cockpit sync --config <your cockpit.toml>')
    if (ownership.bytes !== encodeOwnershipManifest(prepared).bytes) return refuse(
        'GENERATED_OWNERSHIP_DRIFT', 'generated ownership metadata differs from the current canonical manifest', OWNERSHIP_PATH,
        'run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const source = await observeConfigSource(prepared.configPath)
    if (source.state !== 'available' || source.sha256 !== prepared.sourceSha256
        || !await inputSourcesCurrent(prepared, adapters)) {
        return refuse('GENERATED_SOURCE_CHANGED', 'a generated input changed during generated environment checking', 'generated-environment')
    }
    return complete('check', prepared)
}

// A cockpit running its own Compose files owns that topology, so check reads it as Compose resolves
// it and reports what would break parallel stacks.
async function composeTopologyDiagnostics(
    configPath: string,
    sourceSha256: string,
    adapters: GeneratedEnvironmentCommandAdapters,
    inherited: Readonly<Record<string, string | undefined>>,
): Promise<readonly Diagnostic[]> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete' || loaded.result.source.sha256 !== sourceSha256) return [{ severity: 'error' as const,
        code: 'GENERATED_SOURCE_CHANGED', message: 'the configuration changed while check was reading the Compose topology', target: configPath }]
    const config = loaded.result.config
    if (declaredRuntime(config.environment) !== 'compose') return []
    // Reading the topology changes nothing, so it searches like every other observation, whichever
    // caller reached it: a package manager's relative bin must not select or refuse Docker here.
    const search = observationEnvironment(inherited)
    const environment = search.state === 'available' ? search.env : inherited
    const env = { PATH: environment.PATH, DOCKER_HOST: environment.DOCKER_HOST, DOCKER_CONTEXT: environment.DOCKER_CONTEXT,
        DOCKER_TLS_VERIFY: environment.DOCKER_TLS_VERIFY, DOCKER_CERT_PATH: environment.DOCKER_CERT_PATH }
    const [docker, node] = await Promise.all([search.state === 'available' ? resolveDockerExecutable(environment) : search, nodeAuthority()])
    const observed = docker.state !== 'available' ? { kind: 'unavailable' as const, reason: docker.reason }
        : !node ? { kind: 'unavailable' as const, reason: 'the current Node executable could not be authenticated' }
            : await observeComposeTopology({ root: dirname(loaded.result.source.path), references: config.environment.compose_files,
                projectName: config.cockpit.name, docker: docker.value, node, env }, adapters.execute)
    if (observed.kind !== 'complete') return [{ severity: 'error' as const, code: 'COMPOSE_TOPOLOGY_UNAVAILABLE',
        message: `check could not read the declared Compose topology, so its ports, healthchecks and images are unverified: ${observed.reason}`,
        target: config.environment.compose_files.join(', '),
        fix: 'install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files' }]
    const root = dirname(loaded.result.source.path)
    const siblingsRoot = resolve(root, config.cockpit.siblings_root)
    return assessComposeTopology(observed.services, {
        projectDirectory: composeProjectDirectory(root, config.environment.compose_files),
        portVariables: Object.keys(config.ports.bases),
        siblings: config.sibling.map(sibling => ({
            slug: sibling.slug, var: sibling.var, mount: sibling.mount, path: resolve(siblingsRoot, sibling.dir) })),
        hostPaths: config.environment.generated_host_paths.map(declared => ({ declared, path: resolve(root, declared) })),
        profiles: config.environment.profiles,
    })
}

export async function checkGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const adapters = mergedAdapters(adapterOverrides)
    const currentness = await prepareGeneratedEnvironmentCurrentness(input, adapters)
    const findings = currentness.outcome.kind === 'complete'
        ? await composeTopologyDiagnostics(input.configPath, currentness.outcome.result.sourceSha256, adapters, adapters.observationEnv ?? process.env) : []
    const diagnostics = [...currentness.outcome.diagnostics, ...findings]
    const outcome = findings.some(row => row.severity === 'error')
        ? { kind: 'refusal' as const, artifact: null, destination: null, result: null, status: 2 as const, diagnostics }
        : { ...currentness.outcome, diagnostics }
    return { ...outcome, fixContext: currentness.fixContext, report: {
        storedProducer: currentness.storedProducer, currentProducer: currentness.currentProducer,
        repair: proposeGeneratedEnvironmentRepair(currentness),
    } }
}
