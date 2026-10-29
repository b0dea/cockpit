import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, type CheckoutId, type CockpitId, type HolderId, type StackId } from './contract.js'
import { coordinationStateRecord, decodeCoordinationRecord, finalizeDrainOutcome, inspectDrainAttemptAuthority, openRuntimeDrainExecution, prepareDrainOutcomePublication, recoverDrainReservation, reduceDrainOutcome, reserveDrain, reserveDrainAttempt, settleRuntimeDrainSuccess } from './claims.js'
import {
    classifyReclaim,
    admitReclaimDiscovery,
    combineReclaimDiscoveries,
    inspectionOverflow,
    createDockerSelectionSteps,
    admitDockerSelection,
    createReclaimDiscoverySteps,
    createImageInspectionSteps,
    admitImageInspections,
    createVolumeInspectionSteps,
    admitVolumeInspections,
    createNetworkInspectionSteps,
    admitNetworkInspections,
    planReset,
    planTeardown,
    projectResetActionTargets,
    projectTeardownActionTargets,
    consumeReclaimTargetProjection,
    redeemReclaimAction,
    redeemTeardownAction,
    reconcileReclaimAction,
    consumeReclaimCompleted,
    admitReclaimFailure,
    consumeReclaimFailure,
    type ReclaimDiscoverySnapshot,
    type ReclaimResource,
} from './reclaim.js'
import { readState, selectStateRoot, transactState, type StateRecord } from './state.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const cockpitId = `cockpit:synthetic:${sha('cockpit')}` as CockpitId
const stackId = `stack:${sha('stack')}` as StackId
const foreignStackId = `stack:${sha('foreign')}` as StackId
const configSha256 = sha('config')
const owner = cockpitId
const dockerContext = 'synthetic-context'
const dockerEndpoint = 'unix:///tmp/synthetic-docker.sock'
const labels = {
    'dev.b0dea.cockpit.stack-id': stackId,
    'dev.b0dea.cockpit.config-sha256': configSha256,
    'dev.b0dea.cockpit.owner-id': owner,
}
const removalCanonicalPath = await realpath('/bin/rm')
const removalSha256 = createHash('sha256').update(await readFile(removalCanonicalPath)).digest('hex')

const coordinationRecords = new Map<string, StateRecord>()
const stateRecord = (root?: string): StateRecord => {
    const existing = root === undefined ? undefined : coordinationRecords.get(root)
    if (existing !== undefined) return existing
    const record: StateRecord = {
        format: 'cockpit-state/v1', kind: 'coordination', cockpitId, subjectId: stackId,
        revision: 7, updatedAt: new Date().toISOString(),
        value: { holders: [], lease: null, lastReleasedHolder: null },
    }
    if (root !== undefined) coordinationRecords.set(root, record)
    return record
}

const executable = (path: string) => ({
    canonicalPath: path === '/bin/rm' ? removalCanonicalPath : path,
    invocationPath: path,
    sha256: path === '/bin/rm' ? removalSha256 : sha(path),
    executionMode: path.endsWith('/docker') ? 'staged' as const : 'verified-path' as const,
})

const canonicalTemp = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)))

const writeCoordination = async (root: string, record = stateRecord(root)) => {
    const stateRoot = join(root, 'state')
    const cockpitRoot = join(stateRoot, 'cockpits', cockpitId.replaceAll(':', '_'))
    const path = join(cockpitRoot, 'records', 'coordination', `${stackId.replace(':', '_')}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(record)}\n`)
    const address = { path, stateRoot, cockpitRoot, kind: 'coordination' as const, cockpitId, subjectId: stackId }
    const observed = await readState(address)
    if (observed.kind !== 'complete') throw new Error(JSON.stringify(observed))
    return address
}

const dockerRow = ({ id, name, kind, labels: itemLabels, referenced, bytes }: ReclaimResource) => kind === 'build-cache'
    ? { ID: id, Reclaimable: !referenced, Size: bytes === null ? null : String(bytes) }
    : {
          id: kind === 'volume' ? name : id, name,
          labels: kind === 'image' ? {} : Object.fromEntries(Object.keys(labels).map((key) => [key, itemLabels[key] ?? ''])),
          referenced: kind === 'image' ? name !== '<none>' : false,
          bytes: kind === 'network' ? null : kind === 'container' && bytes !== null ? `${bytes}B (virtual 200MB)` : bytes,
      }
const runtimeByDiscovery = new WeakMap<object, ReturnType<typeof executable>>()
const selectionByDiscovery = new WeakMap<object, object>()

interface DiscoveryApi {
    readonly createDockerSelectionSteps: typeof createDockerSelectionSteps
    readonly admitDockerSelection: typeof admitDockerSelection
    readonly createReclaimDiscoverySteps: typeof createReclaimDiscoverySteps
    readonly admitReclaimDiscovery: typeof admitReclaimDiscovery
    readonly createImageInspectionSteps: typeof createImageInspectionSteps
    readonly admitImageInspections: typeof admitImageInspections
    readonly createVolumeInspectionSteps: typeof createVolumeInspectionSteps
    readonly admitVolumeInspections: typeof admitVolumeInspections
    readonly createNetworkInspectionSteps: typeof createNetworkInspectionSteps
    readonly admitNetworkInspections: typeof admitNetworkInspections
    readonly combineReclaimDiscoveries: typeof combineReclaimDiscoveries
    readonly executeProbe: typeof executeProbe
}

const discoveryApi: DiscoveryApi = {
    createDockerSelectionSteps, admitDockerSelection, createReclaimDiscoverySteps, admitReclaimDiscovery,
    createImageInspectionSteps, admitImageInspections, createVolumeInspectionSteps, admitVolumeInspections,
    createNetworkInspectionSteps, admitNetworkInspections,
    combineReclaimDiscoveries, executeProbe,
}

const issuedSelection = async (root: string, docker: ReturnType<typeof executable>, api: DiscoveryApi = discoveryApi) => {
    const probes = api.createDockerSelectionSteps({
        executable: docker, cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000,
        context: dockerContext,
    })
    if (probes === undefined) throw new Error('selection probes unavailable')
    const evidence = await Promise.all(probes.map(async (step) => ({ step, outcome: await api.executeProbe(step) })))
    const authority = api.admitDockerSelection(probes, evidence)
    if (authority === undefined) throw new Error('selection evidence rejected')
    return authority
}

const authenticatedDiscovery = async (
    root: string,
    resources: readonly ReclaimResource[],
    api: DiscoveryApi = discoveryApi,
    options: {
        readonly networkInspection?: (resource: ReclaimResource) => unknown
        readonly containerNetworks?: Readonly<Record<string, readonly string[]>>
        readonly displayedBytes?: Readonly<Record<string, string>>
    } = {},
): Promise<ReclaimDiscoverySnapshot> => {
    const groups = new Map<Exclude<ReclaimResource['kind'], 'cache'>, ReclaimResource[]>([
        ['container', []], ['network', []], ['volume', []], ['image', []], ['build-cache', []],
    ])
    for (const item of resources) {
        if (item.kind === 'cache') throw new Error('filesystem cache cannot enter Docker discovery')
        groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
    }
    for (const [kind, rows] of groups) {
        await writeFile(join(root, `docker.${kind}`), `${rows.map((row) => {
            const shown = options.displayedBytes?.[row.id]
            const encoded = dockerRow(row) as Record<string, unknown>
            return JSON.stringify(shown === undefined ? encoded : kind === 'build-cache' ? { ...encoded, Size: shown } : { ...encoded, bytes: shown })
        }).join('\n')}\n`)
        if (kind === 'image') for (const row of rows) {
            await writeFile(join(root, `inspect.${row.id}`), `${JSON.stringify({
                id: row.id, labels: Object.fromEntries(Object.keys(labels).map((key) => [key, row.labels[key] ?? ''])),
            })}\n`)
        }
        if (kind === 'volume') for (const row of rows) {
            await writeFile(join(root, `inspect.${row.name}`), `${JSON.stringify({ name: row.name, generation: row.generation ?? '' })}\n`)
        }
        if (kind === 'network') for (const row of rows) {
            await writeFile(join(root, `inspect.network.${row.id}`), `${JSON.stringify(
                // A referenced row stands for an endpoint discovery did not see, which keeps the network.
                options.networkInspection?.(row) ?? { id: row.id, members: row.referenced ? `endpoint-${row.id} ` : '' },
            )}\n`)
        }
        if (kind === 'container') for (const row of rows) {
            // `name:<network>` stands for a created, never-started container, which Docker reports
            // by network name with an empty id.
            const networks = Object.fromEntries((options.containerNetworks?.[row.id] ?? []).map((networkId) => networkId.startsWith('name:')
                ? [networkId.slice(5), { NetworkID: '' }]
                : [`network-${networkId.slice(0, 8)}`, { NetworkID: networkId }]))
            await writeFile(join(root, `inspect.container.${row.id}`), `${JSON.stringify({ id: row.id, networks })}\n`)
        }
    }
    await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
    const script = join(root, 'docker')
    const bytes = Buffer.from('#!/bin/sh\nif [ "$1" = context ] && [ "$2" = inspect ]; then /bin/cat -- "$PWD/selection.context"; exit; fi\ncase "$1" in --host) shift 2;; *) exit 91;; esac\nkind="$1"\nif [ "$2" = inspect ]; then echo "$kind" >> "$PWD/inspect.calls"; shift 4; status=0; for id do if [ "$kind" = image ] || [ "$kind" = volume ]; then /bin/cat -- "$PWD/inspect.$id" || status=1; else /bin/cat -- "$PWD/inspect.$kind.$id" || status=1; fi; done; exit $status; fi\nif [ "$kind" = builder ]; then shift; kind=build-cache; [ "$1" = prune ] && exit 0; fi\n/bin/cat -- "$PWD/docker.$kind"\n')
    await writeFile(script, bytes, { mode: 0o700 })
    await chmod(script, 0o700)
    const docker = { canonicalPath: script, invocationPath: script, sha256: createHash('sha256').update(bytes).digest('hex'), executionMode: 'staged' as const }
    const selectionAuthority = await issuedSelection(root, docker, api)
    const plans = api.createReclaimDiscoverySteps({ executable: docker,
        cwd: root, env: { PATH: '/usr/bin:/bin' }, stackId, cockpitId, timeoutMs: 5_000,
        selectionAuthority,
    })
    if (plans === undefined) throw new Error('discovery plan unavailable')
    const containerPlan = plans.find(({ labels: item }) => item.resourceKind === 'container')
    expect(containerPlan?.argv.slice(0, 8)).toEqual([script, '--host', dockerEndpoint, 'container', 'ls', '--all', '--size', '--no-trunc'])
    expect(containerPlan?.argv.at(-1)).toContain('.Label "dev.b0dea.cockpit.owner-id"')
    expect(plans.find(({ labels: item }) => item.resourceKind === 'image')?.argv.at(-1)).not.toContain('.Label')
    expect(plans.find(({ labels: item }) => item.resourceKind === 'network')?.argv.at(-1)).toContain('"bytes":null')
    expect(plans.find(({ labels: item }) => item.resourceKind === 'build-cache')?.argv).toEqual([
        script, '--host', dockerEndpoint, 'builder', 'du', '--format', 'json',
    ])
    expect(plans.every(({ argv }) => !argv.includes('--filter'))).toBe(true)
    const observations = await Promise.all([...groups.keys()].map(async (kind) => {
        const step = plans.find((candidate) => candidate.labels.resourceKind === kind)
        if (step === undefined) throw new Error('discovery step unavailable')
        return { kind, step, outcome: await api.executeProbe(step) }
    }))
    const observedSelection = await issuedSelection(root, docker, api)
    const rawSnapshots = observations.map(({ kind, step, outcome }): ReclaimDiscoverySnapshot => {
        const admitted = api.admitReclaimDiscovery(step, outcome, kind, observedSelection)
        if (admitted === undefined) throw new Error(`discovery evidence rejected for ${kind}`)
        return admitted
    })
    const rawImageSnapshot = rawSnapshots[3]
    const rawNetworkSnapshot = rawSnapshots[1]
    const rawContainerSnapshot = rawSnapshots[0]!
    const snapshots = await Promise.all(rawSnapshots.map(async (admitted, index): Promise<ReclaimDiscoverySnapshot> => {
        const kind = observations[index]!.kind
        if (kind === 'image') {
            const inspections = api.createImageInspectionSteps(admitted)
            if (inspections === undefined) throw new Error('image inspection plan unavailable')
            if (inspections[0] !== undefined) expect(inspections[0].argv[6]).toContain('{{with (index .Config "Labels")}}')
            const inspected = api.admitImageInspections(admitted, await Promise.all(inspections.map(async (inspection) => ({
                step: inspection, outcome: await api.executeProbe(inspection),
            }))))
            if (inspected === undefined) throw new Error('image inspection evidence rejected')
            return inspected
        }
        if (kind === 'volume') {
            const inspections = api.createVolumeInspectionSteps(admitted)
            if (inspections === undefined) throw new Error('volume inspection plan unavailable')
            const evidence = await Promise.all(inspections.map(async (inspection) => ({ step: inspection, outcome: await api.executeProbe(inspection) })))
            if (evidence[0] !== undefined) {
                const [command, ...arguments_] = evidence[0].step.argv
                const broken = { ...evidence[0].step, argv: [command, ...arguments_.slice(0, -1), 'replacement-volume'] as [string, ...string[]] }
                expect(api.admitVolumeInspections(admitted, [{ step: broken, outcome: evidence[0].outcome }, ...evidence.slice(1)])).toBeUndefined()
            }
            const inspected = api.admitVolumeInspections(admitted, evidence)
            if (inspected === undefined) throw new Error('volume inspection evidence rejected')
            return inspected
        }
        if (kind === 'network') {
            const inspections = api.createNetworkInspectionSteps(admitted, rawContainerSnapshot)
            if (inspections === undefined) throw new Error('network inspection plan unavailable')
            const networkInspection = inspections.find(({ labels: item }) => item.resourceKind === 'network-inspection')
            if (networkInspection !== undefined) {
                expect(networkInspection.argv.slice(3, 6)).toEqual(['network', 'inspect', '--format'])
                expect(networkInspection.argv[6]).toContain('range $member, $endpoint := .Containers')
            }
            const evidence = await Promise.all(inspections.map(async (inspection) => ({ step: inspection, outcome: await api.executeProbe(inspection) })))
            if (evidence[0] !== undefined) {
                expect(api.admitNetworkInspections(admitted, rawContainerSnapshot, [{
                    step: evidence[0].step,
                    outcome: { ...evidence[0].outcome },
                }, ...evidence.slice(1)])).toBeUndefined()
                expect(api.admitNetworkInspections(admitted, rawContainerSnapshot, [{
                    step: { ...evidence[0].step, labels: { ...evidence[0].step.labels, resourceId: 'replacement-network' } },
                    outcome: evidence[0].outcome,
                }, ...evidence.slice(1)])).toBeUndefined()
            }
            if (evidence.length > 1) {
                expect(api.admitNetworkInspections(admitted, rawContainerSnapshot, [...evidence].reverse())).toBeUndefined()
                expect(api.admitNetworkInspections(admitted, rawContainerSnapshot, evidence.map(() => evidence[0]!))).toBeUndefined()
            }
            const inspected = api.admitNetworkInspections(admitted, rawContainerSnapshot, evidence)
            if (inspected === undefined) throw new Error('network inspection evidence rejected')
            return inspected
        }
        return admitted
    }))
    if (rawImageSnapshot !== undefined) {
        const withoutImageInspection = snapshots.map((item, index) => index === 3 ? rawImageSnapshot! : item)
        expect(api.combineReclaimDiscoveries(withoutImageInspection)).toBeUndefined()
    }
    if (rawNetworkSnapshot !== undefined) {
        const withoutNetworkInspection = snapshots.map((item, index) => index === 1 ? rawNetworkSnapshot! : item)
        expect(api.combineReclaimDiscoveries(withoutNetworkInspection)).toBeUndefined()
    }
    const combined = api.combineReclaimDiscoveries(snapshots)
    if (combined === undefined) throw new Error('discovery evidence could not be combined')
    runtimeByDiscovery.set(combined, docker)
    selectionByDiscovery.set(combined, await issuedSelection(root, docker, api))
    return combined
}

const resetInput = (root: string, overrides: Record<string, unknown> = {}) => {
    const runtime = typeof overrides.discovery === 'object' && overrides.discovery !== null
        ? runtimeByDiscovery.get(overrides.discovery) : undefined
    const selectionAuthority = typeof overrides.discovery === 'object' && overrides.discovery !== null
        ? selectionByDiscovery.get(overrides.discovery) : undefined
    return ({
        stackId,
        cockpitId,
        configSha256,
        coordinationRecord: stateRecord(root),
        expectedCoordinationRevision: 7,
        requesterHolderId: null,
        declaredCacheIds: [],
        resettableVolumes: ['session-data'],
        generatedHostPaths: [{ root, path: join(root, 'generated', 'session'), declaration: 'generated/session' }],
        discovery: snapshot([resource({
            id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation'),
        })]),
        runtimeExecutable: runtime ?? executable('/usr/local/bin/docker'),
        ...(selectionAuthority === undefined ? {} : { selectionAuthority }),
        pathExecutable: executable('/bin/rm'),
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10_000,
        ...overrides,
    })
}

const resource = (overrides: Partial<ReclaimResource> = {}): ReclaimResource => ({
    id: 'container-1',
    name: 'synthetic-container',
    kind: 'container',
    labels,
    referenced: false,
    bytes: 128,
    ...overrides,
})

const snapshot = (resources: readonly ReclaimResource[]): ReclaimDiscoverySnapshot => ({
    observedAt: '2026-09-08T00:00:01.000Z',
    producer: 'runtime-resource-discovery',
    resources,
})

const classify = (resources: readonly ReclaimResource[], declaredCacheIds: readonly string[] = []) => classifyReclaim({
    stackId,
    cockpitId,
    configSha256,
    coordinationRecord: stateRecord(),
    declaredCacheIds,
    discovery: snapshot(resources),
})

describe('reclaim classification', () => {
    it('keeps ownership evidence and reversibility as independent axes', () => {
        const cacheId = 'abcdefghijklmnopqrstuvwxy'
        const rows = classify([
            resource(),
            resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            resource({ id: cacheId, name: cacheId, kind: 'build-cache', labels: {}, bytes: 512 }),
        ], [cacheId])

        expect(rows.kind).toBe('complete')
        if (rows.kind !== 'complete') return
        expect(rows.resources.map(({ ownership, reversibility, action }) => ({ ownership, reversibility, action }))).toEqual([
            { ownership: 'unknown', reversibility: 'regenerable-cache', action: 'reclaim' },
            { ownership: 'current', reversibility: 'runtime', action: 'teardown' },
            { ownership: 'current', reversibility: 'data-bearing', action: 'reset-required' },
        ])
    })

    it.each([
        ['partial', { 'dev.b0dea.cockpit.stack-id': stackId }],
        ['unlabelled', {}],
        ['malformed', { ...labels, 'dev.b0dea.cockpit.stack-id': '../escape' }],
        ['foreign', { ...labels, 'dev.b0dea.cockpit.stack-id': foreignStackId }],
        ['stale-config', { ...labels, 'dev.b0dea.cockpit.config-sha256': sha('stale') }],
    ] as const)('classifies %s labels without granting an action', (ownership, candidateLabels) => {
        const result = classify([resource({ labels: candidateLabels })])
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.resources[0]).toEqual(expect.objectContaining({ ownership, action: 'report-only' }))
        expect(result.resources[0]?.evidence.length).toBeGreaterThan(0)
        expect(result.resources[0]?.reason.length).toBeGreaterThan(0)
    })

    it('uses the deliberately broken label beside a valid control', () => {
        const result = classify([
            resource({ id: 'valid' }),
            resource({ id: 'broken', labels: { ...labels, 'dev.b0dea.cockpit.owner-id': `${owner}/escape` } }),
        ])
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.resources.map(({ id, ownership, action }) => ({ id, ownership, action }))).toEqual([
            { id: 'broken', ownership: 'malformed', action: 'report-only' },
            { id: 'valid', ownership: 'current', action: 'teardown' },
        ])
    })

    it('permits only an exact declared unreferenced build cache from unknown state', () => {
        const cacheId = 'abcdefghijklmnopqrstuvwxy'
        const referencedId = 'bcdefghijklmnopqrstuvwxyz'
        const result = classify([
            resource({ id: cacheId, name: cacheId, kind: 'build-cache', labels: {}, referenced: false }),
            resource({ id: `${cacheId}-copy`, name: `${cacheId}-copy`, kind: 'build-cache', labels: {}, referenced: false }),
            resource({ id: referencedId, name: referencedId, kind: 'build-cache', labels: {}, referenced: true }),
        ], [cacheId, referencedId])
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.resources.map(({ id, action }) => ({ id, action }))).toEqual([
            { id: cacheId, action: 'reclaim' },
            { id: `${cacheId}-copy`, action: 'report-only' },
            { id: referencedId, action: 'report-only' },
        ])
    })

    it('returns a canonical explicit no-op for empty discovery and stable order for permutations', () => {
        const empty = classify([])
        expect(empty).toEqual(expect.objectContaining({ kind: 'complete', noop: true, resources: [] }))
        const first = classify([resource({ id: 'z' }), resource({ id: 'a', name: 'a' })])
        const second = classify([resource({ id: 'a', name: 'a' }), resource({ id: 'z' })])
        expect(first).toEqual(second)
    })

    it('refuses duplicate and hostile discovery input without deleting anything', () => {
        expect(classify([resource(), resource()])).toEqual(expect.objectContaining({ kind: 'refusal' }))
        expect(classify([resource({ id: '__proto__' })])).toEqual(expect.objectContaining({ kind: 'refusal' }))
    })

    it('keeps suggestions as a command and independent risk text', () => {
        const result = classify([resource({ labels: { ...labels, 'dev.b0dea.cockpit.stack-id': foreignStackId } })])
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.resources[0]?.suggestion).toEqual({
            command: "docker container rm -- 'container-1'",
            risk: expect.stringContaining('foreign'),
        })
        expect(result.resources[0]?.suggestion?.command).not.toContain(result.resources[0]?.suggestion?.risk ?? '')
    })
})

describe('runtime discovery authority', () => {
    it('keeps a network referenced by another holder and releases one held only by its own stack', async () => {
        const root = await canonicalTemp('cockpit-network-references-')
        const foreignLabels = { ...labels, 'dev.b0dea.cockpit.stack-id': foreignStackId }
        try {
            const observed = await authenticatedDiscovery(root, [
                resource({ id: 'container-own', name: 'own-service' }),
                resource({ id: 'container-running', name: 'running-service', labels: foreignLabels }),
                resource({ id: 'container-stopped', name: 'stopped-service', labels: {} }),
                resource({ id: 'container-created-own', name: 'replacement-own-service' }),
                resource({ id: 'container-created', name: 'created-service', labels: {} }),
                resource({ id: 'network-orphan', name: 'owned-orphan', kind: 'network', bytes: null }),
                resource({ id: 'network-created', name: 'owned-created', kind: 'network', bytes: null }),
                resource({ id: 'network-own', name: 'owned-default', kind: 'network', bytes: null }),
                resource({ id: 'network-running', name: 'owned-running', kind: 'network', referenced: true, bytes: null }),
                resource({ id: 'network-stopped', name: 'owned-stopped', kind: 'network', bytes: null }),
                resource({
                    id: 'network-foreign', name: 'owned-orphan', kind: 'network', bytes: null,
                    labels: foreignLabels,
                }),
            ], discoveryApi, {
                // The stack's own container is attached both as a running endpoint and by configuration.
                networkInspection: (candidate) => ({
                    id: candidate.id,
                    members: candidate.id === 'network-own' ? 'container-own ' : candidate.referenced ? 'container-running ' : '',
                }),
                containerNetworks: {
                    'container-own': ['network-own'],
                    'container-running': ['network-running'],
                    'container-stopped': ['network-stopped'],
                    'container-created-own': ['name:owned-default'],
                    'container-created': ['name:owned-created'],
                },
            })
            expect(observed.resources.filter(({ kind }) => kind === 'network').map(({ id, referenced }) => ({ id, referenced }))).toEqual([
                { id: 'network-created', referenced: true },
                { id: 'network-foreign', referenced: false },
                { id: 'network-orphan', referenced: false },
                { id: 'network-own', referenced: false },
                { id: 'network-running', referenced: true },
                { id: 'network-stopped', referenced: true },
            ])
            const classified = classifyReclaim({
                stackId, cockpitId, configSha256, coordinationRecord: stateRecord(), declaredCacheIds: [], discovery: observed,
            })
            expect(classified.kind).toBe('complete')
            if (classified.kind !== 'complete') return
            expect(classified.resources.filter(({ kind }) => kind === 'network')
                .map(({ id, ownership, action }) => ({ id, ownership, action }))).toEqual([
                { id: 'network-created', ownership: 'current', action: 'report-only' },
                { id: 'network-foreign', ownership: 'foreign', action: 'report-only' },
                { id: 'network-orphan', ownership: 'current', action: 'teardown' },
                { id: 'network-own', ownership: 'current', action: 'teardown' },
                { id: 'network-running', ownership: 'current', action: 'report-only' },
                { id: 'network-stopped', ownership: 'current', action: 'report-only' },
            ])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('refuses malformed network inspection output', async () => {
        const root = await canonicalTemp('cockpit-network-malformed-')
        try {
            await expect(authenticatedDiscovery(root, [
                resource({ id: 'network-orphan', name: 'owned-orphan', kind: 'network', bytes: null }),
            ], discoveryApi, {
                networkInspection: (candidate) => ({ id: candidate.id, members: ['container-own'] }),
            })).rejects.toThrow('network inspection evidence rejected')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('requires one issued context-to-endpoint observation before discovery', async () => {
        const docker = { ...executable('/tmp/docker'), executionMode: 'staged' as const }
        const probes = createDockerSelectionSteps({
            executable: docker, cwd: '/tmp', env: { PATH: '/usr/bin' }, timeoutMs: 1_000,
            context: dockerContext,
        })
        expect(probes?.map(({ argv }) => argv.slice(1))).toEqual([
            ['context', 'inspect', dockerContext, '--format', '{"context":{{json .Name}},"endpoint":{{json .Endpoints.docker.Host}}}'],
        ])
        expect(admitDockerSelection(probes ?? [], [])).toBeUndefined()
        expect(createReclaimDiscoverySteps({
            executable: docker, cwd: '/tmp', env: { PATH: '/usr/bin' }, stackId, cockpitId, timeoutMs: 1_000,
            selectionAuthority: Object.freeze({}),
        })).toBeUndefined()
        expect(createDockerSelectionSteps({
            executable: docker, cwd: '/tmp', env: { PATH: '/usr/bin', DOCKER_HOST: 'tcp://elsewhere:2375' },
            timeoutMs: 1_000, context: dockerContext,
        })).toBeUndefined()

        const root = await canonicalTemp('cockpit-selection-')
        try {
            const script = join(root, 'docker')
            const bytes = Buffer.from('#!/bin/sh\nif [ "$1" = context ]; then /bin/cat -- "$PWD/selection.context"; exit; fi\n/bin/cat -- "$PWD/docker.container"\n')
            await writeFile(script, bytes, { mode: 0o700 })
            const runtime = { canonicalPath: script, invocationPath: script, sha256: sha(bytes.toString()), executionMode: 'staged' as const }
            const observe = async () => {
                const selectionSteps = createDockerSelectionSteps({
                    executable: runtime, cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000,
                    context: dockerContext,
                })
                if (selectionSteps === undefined) throw new Error('selection probes unavailable')
                const evidence = await Promise.all(selectionSteps.map(async (step) => ({ step, outcome: await executeProbe(step) })))
                expect(evidence.map(({ outcome }) => outcome.kind)).toEqual(['complete'])
                return { authority: admitDockerSelection(selectionSteps, evidence), selectionSteps, evidence }
            }
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
            await writeFile(join(root, 'docker.container'), `${JSON.stringify(dockerRow(resource()))}\n`)
            const valid = await observe()
            expect(valid.authority).toBeDefined()
            expect(admitDockerSelection(valid.selectionSteps, valid.evidence)).toBeUndefined()
            const discoveryInput = {
                executable: runtime, cwd: root, env: { PATH: '/usr/bin:/bin' }, stackId, cockpitId, timeoutMs: 5_000,
                selectionAuthority: valid.authority!,
            }
            const discoverySteps = createReclaimDiscoverySteps(discoveryInput)
            expect(discoverySteps).toBeDefined()
            expect(createReclaimDiscoverySteps(discoveryInput)).toBeUndefined()
            const container = discoverySteps?.find(({ labels: item }) => item.resourceKind === 'container')
            if (container === undefined) throw new Error('container discovery unavailable')
            const containerOutcome = await executeProbe(container)
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: 'unix:///tmp/rebound.sock' })}\n`)
            const rebound = await observe()
            expect(rebound.authority).toBeDefined()
            expect(admitReclaimDiscovery(container, containerOutcome, 'container', rebound.authority!)).toBeUndefined()
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: 'changed-context', endpoint: dockerEndpoint })}\n`)
            expect((await observe()).authority).toBeUndefined()
            for (const endpoint of [
                'tcp://127.0.0.1:2375', 'ssh://synthetic.invalid', 'npipe:////./pipe/docker_engine',
                'npipe:////synthetic.invalid/pipe/docker_engine', 'npipe:////./pipe/../docker_engine',
                'npipe:////./pipe/docker_engine ', 'unix:///tmp/docker.sock\0',
            ]) {
                await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint })}\n`)
                expect((await observe()).authority, JSON.stringify(endpoint)).toBeUndefined()
            }
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it.each(['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'])(
        'plans the exact Windows pipe %s selection without issuing discovery authority', (host) => {
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')
            if (!platform?.configurable) throw new Error('process.platform cannot be configured for the OS boundary test')
            const input = { executable: { ...executable('/tmp/docker.exe'), executionMode: 'staged' as const }, cwd: '/tmp',
                env: { PATH: '/usr/bin' }, timeoutMs: 1_000, context: 'default', host }
            try {
                Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
                const steps = createDockerSelectionSteps(input)
                expect(steps).toHaveLength(1)
                expect(steps?.[0]).toMatchObject({
                    argv: ['/tmp/docker.exe', 'context', 'inspect', 'default', '--format',
                        '{"context":{{json .Name}},"endpoint":{{json .Endpoints.docker.Host}}}'],
                    env: { PATH: '/usr/bin', DOCKER_HOST: host },
                })
                expect(admitDockerSelection(steps ?? [], [])).toBeUndefined()
                expect(createDockerSelectionSteps({ ...input, context: dockerContext })).toBeUndefined()
            } finally {
                Object.defineProperty(process, 'platform', platform)
            }
        })

    it('refuses a Windows pipe on a POSIX host before Docker selection dispatch', () => {
        expect(createDockerSelectionSteps({
            executable: { ...executable('/tmp/docker'), executionMode: 'staged' }, cwd: '/tmp',
            env: { PATH: '/usr/bin' }, timeoutMs: 1_000, context: 'default',
            host: 'npipe:////./pipe/dockerDesktopLinuxEngine',
        })).toBeUndefined()
    })

    it.each([
        'unix:///tmp/synthetic-rootless.sock',
    ])('selects the exact local DOCKER_HOST %s through the default context', async (host) => {
        const root = await canonicalTemp('cockpit-selection-host-')
        try {
            const script = join(root, 'docker')
            const bytes = Buffer.from('#!/bin/sh\n/bin/cat -- "$PWD/selection.context"\n')
            await writeFile(script, bytes, { mode: 0o700 })
            const runtime = { canonicalPath: script, invocationPath: script, sha256: sha(bytes.toString()), executionMode: 'staged' as const }
            const select = async (input: { readonly context: string; readonly host: string }) => {
                await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: 'default', endpoint: input.host })}\n`)
                const steps = createDockerSelectionSteps({
                    executable: runtime, cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000,
                    context: input.context, host: input.host,
                })
                if (steps === undefined) return undefined
                expect(steps[0]!.env).toEqual({ PATH: '/usr/bin:/bin', DOCKER_HOST: input.host })
                const evidence = await Promise.all(steps.map(async (step) => ({ step, outcome: await executeProbe(step) })))
                return admitDockerSelection(steps, evidence)
            }
            expect(await select({ context: 'default', host })).toBeDefined()
            expect(await select({ context: dockerContext, host })).toBeUndefined()
            expect(await select({ context: 'default', host: 'tcp://elsewhere:2375' })).toBeUndefined()
            const admitted = await select({ context: 'default', host })
            expect(admitted).toBeDefined()
            const discovery = createReclaimDiscoverySteps({
                executable: runtime, cwd: root, env: { PATH: '/usr/bin:/bin' }, stackId, cockpitId, timeoutMs: 5_000,
                selectionAuthority: admitted!,
            })
            expect(discovery?.every((step) => step.argv[1] === '--host' && step.argv[2] === host)).toBe(true)
            const changed = createDockerSelectionSteps({
                executable: runtime, cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000,
                context: 'default', host,
            })
            if (changed === undefined) throw new Error('local host selection unavailable')
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: 'default', endpoint: 'unix:///tmp/rebound.sock' })}\n`)
            const evidence = await Promise.all(changed.map(async (step) => ({ step, outcome: await executeProbe(step) })))
            expect(admitDockerSelection(changed, evidence)).toBeUndefined()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('admits the decimal human sizes Docker prints', async () => {
        const root = await canonicalTemp('cockpit-discovery-sizes-')
        try {
            // 1.029 * 1e9 is 1028999999.9999999 in floating point; real daemons print sizes like this.
            const observed = await authenticatedDiscovery(root, [
                resource({ id: 'sized-container', bytes: 8_190 }),
                resource({ id: 'sha256:sized-image', name: 'synthetic-image', kind: 'image', labels: {}, bytes: 1_029_000_000 }),
                resource({ id: 'sized-cache', name: 'sized-cache', kind: 'build-cache', labels: {}, bytes: 1_213_000 }),
            ], discoveryApi, { displayedBytes: {
                'sized-container': '8.19kB (virtual 499MB)', 'sha256:sized-image': '1.029GB', 'sized-cache': '1.213MB',
            } })
            expect(Object.fromEntries(observed.resources.map(({ id, bytes }) => [id, bytes]))).toEqual({
                'sized-container': 8_190, 'sha256:sized-image': 1_029_000_000, 'sized-cache': 1_213_000,
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('inspects each resource type in chunks of 64 rather than one Docker client per resource', async () => {
        const root = await canonicalTemp('cockpit-discovery-chunks-')
        try {
            const volumes = Array.from({ length: 130 }, (_, index) => resource({
                id: `volume-${String(index).padStart(3, '0')}`, name: `volume-${String(index).padStart(3, '0')}`, kind: 'volume', labels: {}, bytes: null,
            }))
            const images = Array.from({ length: 65 }, (_, index) => resource({
                id: `sha256:${String(index).padStart(64, '0')}`, name: `image-${index}`, kind: 'image', labels: {}, bytes: 1,
            }))
            const observed = await authenticatedDiscovery(root, [...volumes, ...images])

            expect(observed.resources.filter(({ kind }) => kind === 'volume')).toHaveLength(130)
            const calls = (await readFile(join(root, 'inspect.calls'), 'utf8')).trim().split('\n')
            expect({ volume: calls.filter((kind) => kind === 'volume').length, image: calls.filter((kind) => kind === 'image').length })
                .toEqual({ volume: 3, image: 2 })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('names the inspected resources when one printed object exceeds its byte budget', () => {
        const step = { id: 'runtime:inspect:volume-inspection:synthetic', argv: ['/synthetic/docker', '--host', 'unix:///synthetic.sock', 'volume', 'inspect', '--format', '{{json .}}', 'small', 'huge'] } as never
        const outcome = (stdout: string) => ({ kind: 'complete', stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) }) as never

        expect(inspectionOverflow(step, outcome(`{"name":"small"}\n{"name":"${'x'.repeat(16_384)}"}\n`)))
            .toBe('docker volume inspect printed more than 16384 bytes for one of 2 resources (small, huge); inspect them and remove or relabel the oversized one')
        expect(inspectionOverflow(step, outcome('{"name":"small"}\n{"name":"huge"}\n'))).toBeUndefined()
    })

    it('fails the whole discovery closed when one id in a chunk vanished before inspection, as the per-id path did', async () => {
        const root = await canonicalTemp('cockpit-discovery-vanished-')
        try {
            const volumes = ['kept-a', 'vanished', 'kept-b'].map((name) => resource({ id: name, name, kind: 'volume', labels: {}, bytes: null }))
            const vanish: DiscoveryApi = { ...discoveryApi, executeProbe: async (step, options) => {
                // Docker prints the surviving objects, reports the missing one on stderr and exits nonzero.
                if (step.labels.resourceKind === 'volume-inspection') await rm(join(root, 'inspect.vanished'), { force: true })
                return discoveryApi.executeProbe(step, options)
            } }

            await expect(authenticatedDiscovery(root, volumes, vanish)).rejects.toThrow('volume inspection evidence rejected')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('preserves absent ownership labels beside a malformed control', async () => {
        const root = await canonicalTemp('cockpit-discovery-labels-')
        try {
            const observed = await authenticatedDiscovery(root, [
                resource({ id: 'unlabelled', labels: {} }),
                resource({ id: 'broken', labels: { ...labels, 'dev.b0dea.cockpit.owner-id': 'broken' } }),
            ])
            expect(observed.observedAt).not.toBe('2026-09-08T00:00:01.000Z')
            const result = classifyReclaim({
                stackId, cockpitId, configSha256, coordinationRecord: stateRecord(), declaredCacheIds: [], discovery: observed,
            })
            expect(result.kind).toBe('complete')
            if (result.kind === 'complete') expect(result.resources.map(({ id, ownership }) => ({ id, ownership }))).toEqual([
                { id: 'broken', ownership: 'malformed' }, { id: 'unlabelled', ownership: 'unlabelled' },
            ])
        } finally { await rm(root, { recursive: true, force: true }) }
    })
})

describe('reset planning', () => {
    it('refuses a volume without authenticated generation evidence', async () => {
        const root = await canonicalTemp('cockpit-reset-generation-gap-')
        try {
            const observed = await authenticatedDiscovery(root, [
                resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true }),
            ])
            expect(observed.resources[0]?.generation).toBeUndefined()
            expect(await planReset(resetInput(root, { generatedHostPaths: [], discovery: observed }))).toEqual(expect.objectContaining({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'RECLAIM_ACCOUNTING_MISMATCH' })],
            }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('binds both declared target classes and emits one exact action after consent', async () => {
        const root = await canonicalTemp('cockpit-reset-')
        try {
            await mkdir(join(root, 'generated', 'session'), { recursive: true })
            // The stack's own stopped container still references its volume, and Docker refuses
            // to remove a referenced volume, so reset removes that container first. A container
            // another stack owns is never a reset target.
            const discovered = () => snapshot([
                resource({ id: 'container-1', name: 'synthetic-api-1' }),
                resource({ id: 'container-2', name: 'other-api-1', labels: { ...labels, 'dev.b0dea.cockpit.stack-id': `stack:${sha('other stack')}` } }),
                resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ]).resources
            const fresh = await authenticatedDiscovery(root, discovered())
            const preview = await planReset(resetInput(root, { discovery: fresh }))
            expect(preview).toEqual(expect.objectContaining({ kind: 'preview', coordinationRevision: 7 }))
            if (preview.kind !== 'preview') return
            expect(preview.targets.map(({ kind, identity, declaration }) => ({ kind, identity, declaration }))).toEqual([
                { kind: 'container', identity: 'container-1', declaration: 'synthetic-api-1' },
                { kind: 'host-path', identity: join(root, 'generated', 'session'), declaration: 'generated/session' },
                { kind: 'volume', identity: 'session-data', declaration: 'session-data' },
            ])

            const coordinationAddress = await writeCoordination(root)
            expect(await planReset(resetInput(root, {
                confirmationDigest: preview.digest, discovery: fresh, coordinationAddress,
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
            const actionDiscovery = await authenticatedDiscovery(root, discovered())
            const accepted = await planReset(resetInput(root, {
                confirmationDigest: preview.digest, consent: preview.consent, discovery: actionDiscovery, coordinationAddress,
            }))
            expect(accepted).toEqual(expect.objectContaining({
                kind: 'complete', step: null, actionAuthority: expect.any(Object), remaining: 2,
            }))
            if (accepted.kind !== 'complete') return
            expect(JSON.stringify(accepted)).not.toContain('-rf')
            const reusedConsentDiscovery = await authenticatedDiscovery(root, discovered())
            expect(await planReset(resetInput(root, {
                confirmationDigest: preview.digest, consent: preview.consent, discovery: reusedConsentDiscovery, coordinationAddress,
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
            expect(await planReset(resetInput(root, {
                confirmationDigest: preview.digest,
                discovery: actionDiscovery,
                coordinationAddress,
            }))).toEqual(expect.objectContaining({
                kind: 'refusal',
                diagnostics: [expect.objectContaining({ code: 'RECLAIM_ACCOUNTING_MISMATCH' })],
            }))
            const reminted = combineReclaimDiscoveries([actionDiscovery])
            expect(reminted).toBeUndefined()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('returns an explicit no-op preview when no target is declared', async () => {
        const root = await canonicalTemp('cockpit-reset-empty-')
        try {
            const empty = await authenticatedDiscovery(root, [])
            const result = await planReset(resetInput(root, {
                resettableVolumes: [], generatedHostPaths: [], discovery: empty,
            }))
            expect(result).toEqual(expect.objectContaining({ kind: 'preview', noop: true, targets: [] }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('refuses consent or coordination mutation and co-tenants', async () => {
        const root = await canonicalTemp('cockpit-reset-guards-')
        try {
            await mkdir(join(root, 'generated', 'session'), { recursive: true })
            const previewDiscovery = await authenticatedDiscovery(root, [resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })])
            const preview = await planReset(resetInput(root, { discovery: previewDiscovery }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            expect(await planReset(resetInput(root, { confirmationDigest: sha('wrong') }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
            const fresh = await authenticatedDiscovery(root, snapshot([
                resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ]).resources)
            expect(await planReset(resetInput(root, { confirmationDigest: preview.digest, expectedCoordinationRevision: 6, discovery: fresh }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
            const coTenantRecord = stateRecord()
            coTenantRecord.value = {
                holders: [{ holderId: `holder:${sha('holder')}:session`, checkoutId: `checkout:${sha('checkout')}`, claimedAt: '2026-09-08T00:00:00.000Z' }],
                lease: { offset: 0, ports: { WEB: 4100 }, released: false, declaration: { step: 100, count: 1, bases: { WEB: 4100 } } },
                lastReleasedHolder: null,
            }
            expect(await planReset(resetInput(root, { coordinationRecord: coTenantRecord, confirmationDigest: preview.digest, discovery: fresh }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('refuses an unissued discovery even when its bytes match the accepted preview', async () => {
        const root = await canonicalTemp('cockpit-reset-auth-')
        try {
            await mkdir(join(root, 'generated', 'session'), { recursive: true })
            const previewDiscovery = await authenticatedDiscovery(root, [resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })])
            const preview = await planReset(resetInput(root, { discovery: previewDiscovery }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            expect(await planReset(resetInput(root, {
                confirmationDigest: preview.digest,
                coordinationAddress: await writeCoordination(root),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('binds consent and discovery to the same Docker identity and daemon context', async () => {
        const root = await canonicalTemp('cockpit-reset-runtime-')
        try {
            const previewDiscovery = await authenticatedDiscovery(root, [resource({ id: 'session-data', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })])
            const preview = await planReset(resetInput(root, { generatedHostPaths: [], discovery: previewDiscovery }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            const fresh = await authenticatedDiscovery(root, [resource({ id: 'session-data', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })])
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: 'unix:///tmp/rebound.sock' })}\n`)
            const reboundSelection = await issuedSelection(root, runtimeByDiscovery.get(fresh)!)
            expect(await planReset(resetInput(root, {
                generatedHostPaths: [], confirmationDigest: preview.digest, consent: preview.consent,
                discovery: fresh, selectionAuthority: reboundSelection, coordinationAddress: await writeCoordination(root),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
            expect(await planReset(resetInput(root, {
                generatedHostPaths: [], confirmationDigest: preview.digest, discovery: fresh,
                runtimeExecutable: executable('/tmp/other-docker'),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('accepts a stable old coordination record and rejects a replacement volume name', async () => {
        const root = await canonicalTemp('cockpit-reset-freshness-')
        try {
            const first = await authenticatedDiscovery(root, [
                resource({ id: 'volume-original', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ])
            const preview = await planReset(resetInput(root, { generatedHostPaths: [], discovery: first }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            const replacement = await authenticatedDiscovery(root, [
                resource({ id: 'volume-replacement', name: 'session-data-replaced', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ])
            expect(await planReset(resetInput(root, {
                generatedHostPaths: [], discovery: replacement, confirmationDigest: preview.digest,
                coordinationAddress: await writeCoordination(root),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))

            const stale = stateRecord()
            stale.updatedAt = '2026-09-07T23:58:00.000Z'
            const stalePreview = await planReset(resetInput(root, {
                generatedHostPaths: [], discovery: replacement, coordinationRecord: stale,
            }))
            expect(stalePreview.kind).toBe('preview')
            if (stalePreview.kind !== 'preview') return
            const stableDiscovery = await authenticatedDiscovery(root, replacement.resources)
            expect(await planReset(resetInput(root, {
                generatedHostPaths: [], discovery: stableDiscovery, coordinationRecord: stale,
                confirmationDigest: stalePreview.digest, consent: stalePreview.consent,
                coordinationAddress: await writeCoordination(root, stale),
            }))).toEqual(expect.objectContaining({ kind: 'complete' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('rejects a same-name volume with a different authenticated generation', async () => {
        const root = await canonicalTemp('cockpit-reset-volume-generation-')
        try {
            const original = { ...resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true }), generation: sha('volume-generation') }
            const replacement = { ...original, generation: sha('replacement-generation') }
            const first = await authenticatedDiscovery(root, [original])
            const preview = await planReset(resetInput(root, { generatedHostPaths: [], discovery: first }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            const changed = await authenticatedDiscovery(root, [replacement])
            expect(await planReset(resetInput(root, {
                generatedHostPaths: [], discovery: changed, confirmationDigest: preview.digest,
                consent: preview.consent, coordinationAddress: await writeCoordination(root),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('refuses accessor-backed authority inputs before evaluating them', async () => {
        const root = await canonicalTemp('cockpit-reset-accessor-')
        try {
            const value = resetInput(root)
            const original = value.discovery
            let reads = 0
            Object.defineProperty(value, 'discovery', {
                enumerable: true,
                get: () => {
                    reads += 1
                    return original
                },
            })
            expect(await planReset(value)).toEqual(expect.objectContaining({ kind: 'refusal' }))
            expect(reads).toBe(0)
            const symbolBacked = Object.assign(resetInput(root), { [Symbol('hidden')]: true })
            expect(await planReset(symbolBacked)).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('projects teardown targets only from the exact owner-issued result', async () => {
        const root = await canonicalTemp('cockpit-teardown-targets-')
        try {
            const discovery = await authenticatedDiscovery(root, [])
            const runtime = runtimeByDiscovery.get(discovery)
            const selectionAuthority = selectionByDiscovery.get(discovery)
            if (!runtime || !selectionAuthority) throw new Error('teardown fixture unavailable')
            const result = await planTeardown({
                stackId, cockpitId, configSha256, coordinationRecord: stateRecord(root), declaredCacheIds: [],
                discovery, executable: runtime, selectionAuthority, cwd: root,
                env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000,
            })
            if (result.kind !== 'complete') throw new Error('teardown result unavailable')
            expect(projectTeardownActionTargets({ ...result } as never)).toBeUndefined()
            expect(projectResetActionTargets(result as never)).toBeUndefined()
            const projection = projectTeardownActionTargets(result)
            expect(projection).toEqual(expect.any(Object))
            expect(consumeReclaimTargetProjection({ ...projection! } as never)).toBeUndefined()
            for (const substituted of [
                { purpose: 'reset', stackId, configSha256, planDigest: result.discoveryDigest, commitments: [] },
                { purpose: 'down', stackId: `stack:${sha('other')}`, configSha256, planDigest: result.discoveryDigest, commitments: [] },
                { purpose: 'down', stackId, configSha256: sha('other'), planDigest: result.discoveryDigest, commitments: [] },
                { purpose: 'down', stackId, configSha256, planDigest: sha('other'), commitments: [] },
            ]) expect(consumeReclaimTargetProjection(substituted as never)).toBeUndefined()
            const envelope = consumeReclaimTargetProjection(projection!)
            expect(envelope).toEqual({
                purpose: 'down', stackId, configSha256, planDigest: result.discoveryDigest, commitments: [],
            })
            expect(Object.isFrozen(envelope)).toBe(true)
            expect(Object.isFrozen(envelope?.commitments)).toBe(true)
            expect(consumeReclaimTargetProjection(projection!)).toBeUndefined()
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each([
        'remaining-identity-changes', 'completed-cache-reappears', 'remaining-cache-is-replaced',
        'remaining-bytes-change', 'mixed-kind-order', 'two-action-success', 'completed-target-reappears',
        'completed-target-is-replaced', 'cold-prestart-retry', 'cold-changed-timeout', 'cold-added-target', 'cold-second-action-retry',
        'cold-second-completed-replacement', 'cold-second-remaining-replacement', 'cold-second-added-target',
        'cache-ancestor-replaced-before-redemption', 'redeemed-cache-target-replaced', 'redeemed-cache-ancestor-replaced',
    ] as const)(
        '%s stays bound to a committed teardown attempt', async (mode) => {
            const root = await canonicalTemp('cockpit-teardown-attempt-')
            try {
                const holderId = `holder:${sha('teardown-holder')}:session` as HolderId
                const checkoutId = `checkout:${sha('teardown-checkout')}` as CheckoutId
                const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId })
                if (selected.kind !== 'complete') throw new Error('state namespace unavailable')
                const seeded = await transactState(selected.value, selected.value.paths.coordination(stackId), { ownerId: holderId }, () => ({
                    format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId, subjectId: stackId,
                    revision: 0, updatedAt: new Date().toISOString(), value: {
                        holders: [{ holderId, checkoutId, claimedAt: new Date().toISOString() }],
                        lease: { offset: 0, ports: { WEB: 3000 }, released: false,
                            declaration: { step: 100, count: 1, bases: { WEB: 3000 } } },
                        lastReleasedHolder: null, drain: null,
                    },
                }))
                if (seeded.kind !== 'complete') throw new Error('coordination fixture unavailable')
                const first = mode === 'mixed-kind-order'
                    ? resource({ id: 'a'.repeat(25), name: 'first-build-cache', kind: 'build-cache', dataBearing: false })
                    : resource({ id: 'container-1', name: 'first-container' })
                const remaining = resource({ id: 'container-2', name: 'remaining-container', bytes: 256 })
                const firstCacheId = sha('first-cache')
                const secondCacheId = sha('second-cache')
                const cacheRoot = join(root, 'dependency-caches')
                const firstCachePath = join(cacheRoot, firstCacheId)
                const secondCachePath = join(cacheRoot, secondCacheId)
                const usesCaches = mode === 'completed-cache-reappears' || mode === 'remaining-cache-is-replaced'
                    || mode === 'cache-ancestor-replaced-before-redemption'
                    || mode === 'redeemed-cache-target-replaced' || mode === 'redeemed-cache-ancestor-replaced'
                if (usesCaches) {
                    await mkdir(firstCachePath, { recursive: true })
                    await mkdir(secondCachePath)
                }
                const dependencyCaches = usesCaches ? [
                    { cacheId: firstCacheId, root: cacheRoot, path: firstCachePath },
                    { cacheId: secondCacheId, root: cacheRoot, path: secondCachePath },
                ] : []
                const runtimeResources = usesCaches ? [] : [first, remaining]
                const previewDiscovery = await authenticatedDiscovery(root, runtimeResources)
                const previewRuntime = runtimeByDiscovery.get(previewDiscovery)
                const previewSelection = selectionByDiscovery.get(previewDiscovery)
                if (!previewRuntime || !previewSelection) throw new Error('teardown preview authority unavailable')
                const common = {
                    stackId, cockpitId, configSha256, coordinationRecord: seeded.value,
                    declaredCacheIds: usesCaches ? [firstCacheId, secondCacheId]
                        : mode === 'mixed-kind-order' ? ['a'.repeat(25)] : [],
                    dependencyCaches, pathExecutable: executable('/bin/rm'),
                    executable: previewRuntime, cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 30_000,
                }
                const preview = await planTeardown({ ...common, discovery: previewDiscovery, selectionAuthority: previewSelection })
                if (preview.kind !== 'complete' || !preview.consent) throw new Error('teardown preview unavailable')
                const projection = projectTeardownActionTargets(preview)
                const projected = consumeReclaimTargetProjection(projection!)
                expect(projected).toMatchObject({
                    purpose: 'down', stackId, configSha256, planDigest: preview.discoveryDigest,
                })
                expect(Object.isFrozen(projected)).toBe(true)
                expect(Object.isFrozen(projected?.commitments)).toBe(true)
                expect(projected?.commitments.every(Object.isFrozen)).toBe(true)
                const reclaimCommitments = projected?.commitments
                const reclaimTargets = reclaimCommitments?.map(({ targetId }) => targetId)
                expect(reclaimTargets).toEqual(usesCaches
                    ? [`cache:${firstCacheId}`, `cache:${secondCacheId}`].sort()
                    : mode === 'mixed-kind-order'
                        ? [`build-cache:${'a'.repeat(25)}`, 'container:container-2']
                        : ['container:container-1', 'container:container-2'])
                const cachePathForTarget = (targetId: string) => dependencyCaches.find(({ cacheId }) => `cache:${cacheId}` === targetId)?.path
                const completedCachePath = usesCaches ? cachePathForTarget(reclaimTargets![0]!) : undefined
                const remainingCachePath = usesCaches ? cachePathForTarget(reclaimTargets![1]!) : undefined
                const actionDiscovery = await authenticatedDiscovery(root, runtimeResources)
                const runtime = runtimeByDiscovery.get(actionDiscovery)
                const selectionAuthority = selectionByDiscovery.get(actionDiscovery)
                if (!runtime || !selectionAuthority) throw new Error('teardown action authority unavailable')
                const planned = await planTeardown({
                    ...common, executable: runtime, discovery: actionDiscovery, selectionAuthority,
                    expectedDiscoveryDigest: preview.discoveryDigest, consent: preview.consent,
                    coordinationAddress: selected.value.paths.coordination(stackId),
                })
                if (planned.kind !== 'complete' || !planned.actionAuthority) throw new Error('teardown action unavailable')
                const targetIds = [stackId, ...reclaimTargets!].sort()
                const request = {
                    purpose: 'down' as const, stackId, holderId, requesterId: holderId, configSha256,
                    planDigest: preview.discoveryDigest, operationBasis: sha('teardown basis'), generation: sha('teardown generation'),
                    targetIds, actions: [
                        { stage: 'runtime-stop' as const, targetId: stackId, validForMs: 30_000 },
                        ...reclaimCommitments!.map(({ targetId, ...targetCommitment }) => ({
                            stage: 'reclaim' as const, targetId, validForMs: 30_000, targetCommitment,
                        })),
                    ], expectedCoordinationRevision: 0,
                }
                const reserved = await reserveDrain({ namespace: selected.value, request })
                if (reserved.kind !== 'complete') throw new Error('drain reservation unavailable')
                const runtimeAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: reserved.authority })
                if (runtimeAttempt.kind !== 'complete') throw new Error('runtime attempt unavailable')
                const candidate = inspectDrainAttemptAuthority(runtimeAttempt.authority)
                const runtimeExecution = candidate && openRuntimeDrainExecution({
                    authority: runtimeAttempt.authority, candidate,
                })
                const runtimeSuccess = runtimeExecution && settleRuntimeDrainSuccess({ authority: runtimeExecution, fact: {
                    purpose: request.purpose, stackId, configSha256, planDigest: runtimeAttempt.reservation.planDigest,
                    operationBasis: runtimeAttempt.reservation.operationBasis,
                    coordinationRevision: runtimeAttempt.reservation.coordinationRevision,
                    reservationId: runtimeAttempt.reservation.reservationId, reservedAt: runtimeAttempt.reservation.reservedAt,
                    generation: runtimeAttempt.reservation.generation, attemptId: runtimeAttempt.attempt.attemptId,
                    attemptRevision: runtimeAttempt.attempt.committedRevision, attemptCommittedAt: runtimeAttempt.attempt.committedAt,
                    validThrough: runtimeAttempt.attempt.validThrough, actionIndex: runtimeAttempt.attempt.actionIndex,
                    currentTarget: runtimeAttempt.attempt.currentTarget, currentStage: runtimeAttempt.attempt.currentStage,
                    observedAt: runtimeAttempt.attempt.committedAt,
                } })
                if (!runtimeSuccess) throw new Error('runtime completion unavailable')
                const active = await readState(selected.value.paths.coordination(stackId))
                if (active.kind !== 'complete') throw new Error('active drain unavailable')
                const progressed = reduceDrainOutcome({ record: active.value, authority: runtimeSuccess })
                if (!progressed) throw new Error('runtime progress unavailable')
                const progressCommit = await prepareDrainOutcomePublication({
                    authority: runtimeSuccess, namespace: selected.value, stackId,
                })
                if (progressCommit.kind !== 'complete') throw new Error('runtime progress commit unavailable')
                expect(finalizeDrainOutcome({ authority: runtimeSuccess, publication: progressCommit,
                    address: selected.value.paths.coordination(stackId) })).toBe(true)
                const recovered = await recoverDrainReservation({ namespace: selected.value, request })
                if (recovered.kind !== 'complete') throw new Error('drain recovery unavailable')
                const reclaimAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: recovered.authority })
                if (reclaimAttempt.kind !== 'complete') throw new Error('reclaim attempt unavailable')
                expect(await redeemTeardownAction(planned.actionAuthority as never)).toBeUndefined()
                if (mode === 'cache-ancestor-replaced-before-redemption') {
                    await rename(cacheRoot, join(root, 'held-dependency-caches'))
                    await mkdir(completedCachePath!, { recursive: true })
                    await writeFile(join(completedCachePath!, 'replacement'), 'preserved')
                    expect(await redeemTeardownAction({ actionAuthority: planned.actionAuthority, attempt: reclaimAttempt.authority })).toBeUndefined()
                    expect(await readFile(join(completedCachePath!, 'replacement'), 'utf8')).toBe('preserved')
                    return
                }
                const execution = await redeemTeardownAction({ actionAuthority: planned.actionAuthority, attempt: reclaimAttempt.authority })
                if (!execution) throw new Error('teardown execution unavailable')
                const coldFirst = mode === 'cold-prestart-retry' || mode === 'cold-changed-timeout' || mode === 'cold-added-target'
                const executableBytes = coldFirst ? await readFile(execution.step.argv[0]) : undefined
                if (coldFirst) await writeFile(execution.step.argv[0], '#!/bin/sh\nexit 1\n', { mode: 0o700 })
                if (mode === 'redeemed-cache-target-replaced') {
                    await rm(completedCachePath!, { recursive: true })
                    await mkdir(completedCachePath!)
                    await writeFile(join(completedCachePath!, 'replacement'), 'preserved')
                }
                if (mode === 'redeemed-cache-ancestor-replaced') {
                    await rename(cacheRoot, join(root, 'held-dependency-caches'))
                    await mkdir(completedCachePath!, { recursive: true })
                    await writeFile(join(completedCachePath!, 'replacement'), 'preserved')
                }
                const outcome = await executeProbe(execution.step)
                if (mode === 'redeemed-cache-target-replaced' || mode === 'redeemed-cache-ancestor-replaced') {
                    expect(outcome).toMatchObject({
                        kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                        execution: { started: false },
                    })
                    expect(outcome).not.toHaveProperty('receipt')
                    expect(await readFile(join(completedCachePath!, 'replacement'), 'utf8')).toBe('preserved')
                    return
                }
                if (coldFirst) {
                    await writeFile(execution.step.argv[0], executableBytes!, { mode: 0o700 })
                    const failed = admitReclaimFailure({ authority: execution.authority, outcome })
                    if (failed.kind !== 'complete') throw new Error('teardown failure authority unavailable')
                    const failureAuthority = consumeReclaimFailure(failed.authority)
                    if (!failureAuthority) throw new Error('teardown failure unavailable')
                    const active = await readState(selected.value.paths.coordination(stackId))
                    if (active.kind !== 'complete') throw new Error('active teardown attempt unavailable')
                    const failedValue = reduceDrainOutcome({ record: active.value, authority: failureAuthority })
                    if (!failedValue) throw new Error('teardown failure transition unavailable')
                    const failedCommit = await prepareDrainOutcomePublication({
                        authority: failureAuthority, namespace: selected.value, stackId,
                    })
                    if (failedCommit.kind !== 'complete') throw new Error('teardown failure commit unavailable')
                    expect(finalizeDrainOutcome({ authority: failureAuthority, publication: failedCommit,
                        address: selected.value.paths.coordination(stackId) })).toBe(true)
                    vi.resetModules()
                    const freshReclaim = await import('./reclaim.js')
                    const freshClaims = await import('./claims.js')
                    const freshExecute = await import('../environment-exec/execute.js')
                    const freshApi: DiscoveryApi = { ...freshReclaim, executeProbe: freshExecute.executeProbe }
                    const coldReservation = await freshClaims.recoverDrainReservation({ namespace: selected.value, request })
                    if (coldReservation.kind !== 'complete') throw new Error('cold teardown recovery unavailable')
                    expect(freshClaims.inspectFailedReclaimRecovery({
                        authority: { ...coldReservation.authority } as never, record: failedCommit.value,
                    })).toBeUndefined()
                    const coldRecoveryAuthority = freshClaims.inspectFailedReclaimRecovery({
                        authority: coldReservation.authority, record: failedCommit.value,
                    })
                    if (!coldRecoveryAuthority) throw new Error('cold teardown projection unavailable')
                    const coldProjection = freshClaims.consumeFailedReclaimRecovery(coldRecoveryAuthority)
                    expect(coldProjection).toMatchObject({
                        purpose: 'down', planDigest: preview.discoveryDigest, completed: [],
                        current: { targetId: reclaimTargets![0] }, pending: [{ targetId: reclaimTargets![1] }],
                    })
                    const coldResources = mode === 'cold-added-target'
                        ? [resource({ id: 'a-container', name: 'added-container' }), ...runtimeResources]
                        : runtimeResources
                    const coldDiscovery = await authenticatedDiscovery(root, coldResources, freshApi)
                    expect(Date.parse(coldDiscovery.observedAt)).toBeGreaterThan(Date.parse(coldProjection!.freshAfter))
                    const coldPlan = await freshReclaim.planTeardown({
                        ...common, coordinationRecord: failedCommit.value, discovery: coldDiscovery,
                        executable: runtimeByDiscovery.get(coldDiscovery)!, selectionAuthority: selectionByDiscovery.get(coldDiscovery),
                        expectedDiscoveryDigest: preview.discoveryDigest, recoveryAuthority: coldReservation.authority,
                        ...(mode === 'cold-changed-timeout' ? { timeoutMs: 29_000 } : {}),
                        coordinationAddress: selected.value.paths.coordination(stackId),
                    })
                    if (mode !== 'cold-prestart-retry') {
                        expect(coldPlan).toMatchObject({ kind: 'refusal' })
                        return
                    }
                    if (coldPlan.kind !== 'complete' || !coldPlan.actionAuthority) throw new Error(`cold teardown action unavailable: ${JSON.stringify(coldPlan)}`)
                    const coldAttempt = await freshClaims.reserveDrainAttempt({ namespace: selected.value, authority: coldReservation.authority })
                    if (coldAttempt.kind !== 'complete') throw new Error('cold teardown retry attempt unavailable')
                    const coldExecution = await freshReclaim.redeemTeardownAction({ actionAuthority: coldPlan.actionAuthority, attempt: coldAttempt.authority })
                    if (!coldExecution) throw new Error('cold teardown execution unavailable')
                    const coldOutcome = await freshExecute.executeProbe(coldExecution.step)
                    expect(coldOutcome.kind).toBe('complete')
                    const coldPost = await authenticatedDiscovery(root, [remaining], freshApi)
                    expect(freshReclaim.reconcileReclaimAction({ authority: coldExecution.authority, outcome: coldOutcome, discovery: coldPost }))
                        .toMatchObject({ kind: 'complete' })
                    return
                }
                expect(outcome.kind).toBe('complete')
                const observedRemaining = mode === 'remaining-identity-changes'
                    ? resource({ ...remaining, name: 'replaced-container', labels: { ...labels, replacement: 'true' } })
                    : resource({ ...remaining, bytes: 4_096 })
                if (mode === 'completed-cache-reappears') {
                    await mkdir(completedCachePath!)
                }
                if (mode === 'remaining-cache-is-replaced') {
                    const staged = `${remainingCachePath!}.staged`
                    await mkdir(staged)
                    await rm(remainingCachePath!, { recursive: true })
                    await rename(staged, remainingCachePath!)
                }
                const postDiscovery = await authenticatedDiscovery(root, usesCaches ? [] : [observedRemaining])
                const reconciled = reconcileReclaimAction({ authority: execution.authority, outcome, discovery: postDiscovery })
                if (mode === 'two-action-success') expect(reconciled).toMatchObject({ kind: 'complete', continuation: expect.any(Object) })
                expect(reconciled).toMatchObject({
                    kind: mode === 'remaining-identity-changes' || mode === 'completed-cache-reappears'
                        || mode === 'remaining-cache-is-replaced' ? 'refusal' : 'complete',
                })
                if ((mode === 'two-action-success' || mode === 'completed-target-reappears' || mode === 'completed-target-is-replaced'
                    || mode === 'cold-second-action-retry' || mode === 'cold-second-completed-replacement'
                    || mode === 'cold-second-remaining-replacement' || mode === 'cold-second-added-target')
                    && reconciled.kind === 'complete' && reconciled.authority) {
                    const success = consumeReclaimCompleted(reconciled.authority)
                    if (!success) throw new Error('teardown completion unavailable')
                    const current = await readState(selected.value.paths.coordination(stackId))
                    if (current.kind !== 'complete') throw new Error('teardown progress record unavailable')
                    const nextProgress = reduceDrainOutcome({ record: current.value, authority: success })
                    if (!nextProgress) throw new Error('teardown progress unavailable')
                    const committed = await prepareDrainOutcomePublication({
                        authority: success, namespace: selected.value, stackId,
                    })
                    if (committed.kind !== 'complete') throw new Error('teardown progress commit unavailable')
                    expect(finalizeDrainOutcome({ authority: success, publication: committed,
                        address: selected.value.paths.coordination(stackId) })).toBe(true)
                    // The discovery that reconciled the first removal plans the second, as `down` does;
                    // the other modes plan from a discovery taken after the publication.
                    const nextDiscovery = mode === 'two-action-success' ? postDiscovery : await authenticatedDiscovery(root, [remaining])
                    const nextPlan = await planTeardown({
                        ...common, coordinationRecord: committed.value, discovery: nextDiscovery,
                        executable: runtimeByDiscovery.get(nextDiscovery)!, selectionAuthority: selectionByDiscovery.get(nextDiscovery),
                        expectedDiscoveryDigest: preview.discoveryDigest, continuation: reconciled.continuation ?? undefined,
                        coordinationAddress: selected.value.paths.coordination(stackId),
                    })
                    if (nextPlan.kind !== 'complete' || !nextPlan.actionAuthority) throw new Error(`second teardown action unavailable: ${JSON.stringify(nextPlan)}`)
                    const nextReservation = await recoverDrainReservation({ namespace: selected.value, request })
                    if (nextReservation.kind !== 'complete') throw new Error('second teardown recovery unavailable')
                    const nextAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: nextReservation.authority })
                    if (nextAttempt.kind !== 'complete') throw new Error('second teardown attempt unavailable')
                    const nextExecution = await redeemTeardownAction({ actionAuthority: nextPlan.actionAuthority, attempt: nextAttempt.authority })
                    if (!nextExecution) throw new Error('second teardown execution unavailable')
                    const coldSecond = mode === 'cold-second-action-retry' || mode === 'cold-second-completed-replacement'
                        || mode === 'cold-second-remaining-replacement' || mode === 'cold-second-added-target'
                    const secondExecutableBytes = coldSecond ? await readFile(nextExecution.step.argv[0]) : undefined
                    if (coldSecond) await writeFile(nextExecution.step.argv[0], '#!/bin/sh\nexit 1\n', { mode: 0o700 })
                    const nextOutcome = await executeProbe(nextExecution.step)
                    if (coldSecond) {
                        await writeFile(nextExecution.step.argv[0], secondExecutableBytes!, { mode: 0o700 })
                        const failed = admitReclaimFailure({ authority: nextExecution.authority, outcome: nextOutcome })
                        if (failed.kind !== 'complete') throw new Error('second teardown failure authority unavailable')
                        const failureAuthority = consumeReclaimFailure(failed.authority)
                        if (!failureAuthority) throw new Error('second teardown failure unavailable')
                        const secondActive = await readState(selected.value.paths.coordination(stackId))
                        if (secondActive.kind !== 'complete') throw new Error('second active teardown attempt unavailable')
                        const failedValue = reduceDrainOutcome({ record: secondActive.value, authority: failureAuthority })
                        if (!failedValue) throw new Error('second teardown failure transition unavailable')
                        const failedCommit = await prepareDrainOutcomePublication({
                            authority: failureAuthority, namespace: selected.value, stackId,
                        })
                        if (failedCommit.kind !== 'complete') throw new Error('second teardown failure commit unavailable')
                        expect(finalizeDrainOutcome({ authority: failureAuthority, publication: failedCommit,
                            address: selected.value.paths.coordination(stackId) })).toBe(true)
                        vi.resetModules()
                        const freshReclaim = await import('./reclaim.js')
                        const freshClaims = await import('./claims.js')
                        const freshExecute = await import('../environment-exec/execute.js')
                        const freshApi: DiscoveryApi = { ...freshReclaim, executeProbe: freshExecute.executeProbe }
                        const coldReservation = await freshClaims.recoverDrainReservation({ namespace: selected.value, request })
                        if (coldReservation.kind !== 'complete') throw new Error('second cold teardown recovery unavailable')
                        const coldResources = mode === 'cold-second-completed-replacement'
                            ? [resource({ ...first, id: 'container-replacement' }), remaining]
                            : mode === 'cold-second-remaining-replacement'
                                ? [resource({ ...remaining, name: 'remaining-replacement' })]
                                : mode === 'cold-second-added-target'
                                    ? [resource({ id: 'a-container', name: 'added-container' }), remaining]
                                : [remaining]
                        const coldDiscovery = await authenticatedDiscovery(root, coldResources, freshApi)
                        const coldPlan = await freshReclaim.planTeardown({
                            ...common, coordinationRecord: failedCommit.value, discovery: coldDiscovery,
                            executable: runtimeByDiscovery.get(coldDiscovery)!, selectionAuthority: selectionByDiscovery.get(coldDiscovery),
                            expectedDiscoveryDigest: preview.discoveryDigest, recoveryAuthority: coldReservation.authority,
                            coordinationAddress: selected.value.paths.coordination(stackId),
                        })
                        if (mode !== 'cold-second-action-retry') {
                            expect(coldPlan).toMatchObject({ kind: 'refusal' })
                            return
                        }
                        if (coldPlan.kind !== 'complete' || !coldPlan.actionAuthority) throw new Error('second cold teardown action unavailable')
                        const coldAttempt = await freshClaims.reserveDrainAttempt({ namespace: selected.value, authority: coldReservation.authority })
                        if (coldAttempt.kind !== 'complete') throw new Error('second cold teardown retry attempt unavailable')
                        const coldExecution = await freshReclaim.redeemTeardownAction({ actionAuthority: coldPlan.actionAuthority, attempt: coldAttempt.authority })
                        if (!coldExecution) throw new Error('second cold teardown execution unavailable')
                        const coldOutcome = await freshExecute.executeProbe(coldExecution.step)
                        expect(coldOutcome.kind).toBe('complete')
                        const coldPost = await authenticatedDiscovery(root, [], freshApi)
                        expect(freshReclaim.reconcileReclaimAction({ authority: coldExecution.authority, outcome: coldOutcome, discovery: coldPost }))
                            .toMatchObject({ kind: 'complete' })
                        return
                    }
                    expect(nextOutcome.kind).toBe('complete')
                    const finalDiscovery = await authenticatedDiscovery(root,
                        mode === 'completed-target-reappears' ? [first]
                            : mode === 'completed-target-is-replaced' ? [resource({ ...first, id: 'container-replacement' })] : [])
                    const final = reconcileReclaimAction({ authority: nextExecution.authority, outcome: nextOutcome, discovery: finalDiscovery })
                    expect(final).toMatchObject({ kind: mode === 'completed-target-reappears' || mode === 'completed-target-is-replaced' ? 'refusal' : 'complete' })
                    if (mode === 'two-action-success') expect(final).toMatchObject({ kind: 'complete', continuation: null })
                }
            } finally { await rm(root, { recursive: true, force: true }) }
        },
    )

    it('does not carry reset continuation authority across coordination revisions', async () => {
        const root = await canonicalTemp('cockpit-reset-coordination-continuation-')
        const target = join(root, 'generated', 'session')
        try {
            await mkdir(target, { recursive: true })
            const initial = await authenticatedDiscovery(root, [
                resource({ id: 'session-data', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ])
            const preview = await planReset(resetInput(root, { discovery: initial }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            const fresh = await authenticatedDiscovery(root, initial.resources)
            const first = await planReset(resetInput(root, {
                discovery: fresh, confirmationDigest: preview.digest, consent: preview.consent,
                coordinationAddress: await writeCoordination(root),
            }))
            expect(first.kind).toBe('complete')
            if (first.kind !== 'complete') return
            await rm(target, { recursive: true })
            const changed = { ...stateRecord(root), revision: 8, updatedAt: new Date().toISOString() }
            const remaining = await authenticatedDiscovery(root, initial.resources)
            expect(await planReset(resetInput(root, {
                discovery: remaining, confirmationDigest: preview.digest, continuation: first.continuation ?? undefined,
                coordinationRecord: changed, expectedCoordinationRevision: changed.revision,
                coordinationAddress: await writeCoordination(root, changed),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('requires the resolved system removal executable for host reset', async () => {
        const root = await canonicalTemp('cockpit-reset-removal-executable-')
        try {
            const target = join(root, 'generated', 'session')
            await mkdir(target, { recursive: true })
            expect(await planReset(resetInput(root, {
                pathExecutable: executable(join(root, 'rm')),
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
            expect(await planReset(resetInput(root, {
                pathExecutable: { ...executable('/bin/rm'), sha256: sha('wrong') },
            }))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('preserves non-ASCII target bytes through preview and exact action', async () => {
        const root = await canonicalTemp('cockpit-reset-encoding-')
        const target = join(root, 'generated', 'sessión-東京')
        try {
            await mkdir(target, { recursive: true })
            const fresh = await authenticatedDiscovery(root, [])
            const initial = resetInput(root, {
                resettableVolumes: [],
                generatedHostPaths: [{ root, path: target, declaration: 'generated/sessión-東京' }],
                discovery: fresh,
            })
            const preview = await planReset(initial)
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            expect(preview.targets).toEqual([expect.objectContaining({ identity: target })])
            const actionDiscovery = await authenticatedDiscovery(root, [])
            const accepted = await planReset({
                ...initial, discovery: actionDiscovery, confirmationDigest: preview.digest, consent: preview.consent,
                selectionAuthority: selectionByDiscovery.get(actionDiscovery),
                coordinationAddress: await writeCoordination(root),
            })
            expect(accepted).toEqual(expect.objectContaining({ kind: 'complete', step: null, actionAuthority: expect.any(Object) }))
            if (accepted.kind !== 'complete') return
            expect(JSON.stringify(accepted)).not.toContain('-rf')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each(['unchanged', 'target-before-redemption', 'ancestor-before-redemption',
        'target-after-redemption', 'ancestor-after-redemption'] as const)(
        'binds a nested host reset to its declared root: %s', async (mode) => {
            const root = await canonicalTemp('cockpit-reset-path-identity-')
            const ancestor = join(root, 'generated')
            const target = join(ancestor, 'nested', 'session')
            const holderId = `holder:${sha('holder')}:session` as HolderId
            const checkoutId = `checkout:${sha('checkout')}` as CheckoutId
            try {
                await mkdir(target, { recursive: true })
                const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId })
                if (selected.kind !== 'complete') throw new Error('state namespace unavailable')
                const seeded = await transactState(selected.value, selected.value.paths.coordination(stackId), { ownerId: holderId }, () => ({
                    format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId, subjectId: stackId,
                    revision: 0, updatedAt: new Date().toISOString(), value: {
                        holders: [{ holderId, checkoutId, claimedAt: new Date().toISOString() }],
                        lease: { offset: 0, ports: { WEB: 3000 }, released: false,
                            declaration: { step: 100, count: 1, bases: { WEB: 3000 } } },
                        lastReleasedHolder: null, drain: null,
                    },
                }))
                if (seeded.kind !== 'complete') throw new Error('coordination fixture unavailable')
                const previewDiscovery = await authenticatedDiscovery(root, [])
                const base = resetInput(root, {
                    coordinationRecord: seeded.value, expectedCoordinationRevision: 0, requesterHolderId: holderId,
                    resettableVolumes: [], generatedHostPaths: [{ root, path: target, declaration: 'generated/nested/session' }],
                    discovery: previewDiscovery,
                })
                const preview = await planReset(base)
                if (preview.kind !== 'preview') throw new Error(`reset preview unavailable: ${JSON.stringify(preview)}`)
                const projection = projectResetActionTargets(preview)
                const projected = projection && consumeReclaimTargetProjection(projection)
                const commitments = projected?.commitments
                if (commitments?.length !== 1) throw new Error('reset target commitment unavailable')
                const actionDiscovery = await authenticatedDiscovery(root, [])
                const planned = await planReset({
                    ...base, discovery: actionDiscovery, confirmationDigest: preview.digest, consent: preview.consent,
                    selectionAuthority: selectionByDiscovery.get(actionDiscovery),
                    coordinationAddress: selected.value.paths.coordination(stackId),
                })
                if (planned.kind !== 'complete' || !planned.actionAuthority) throw new Error('reset action unavailable')
                const targetId = `host-path:${target}`
                const { targetId: committedTargetId, ...targetCommitment } = commitments[0]!
                expect(committedTargetId).toBe(targetId)
                const request = {
                    purpose: 'reset' as const, stackId, holderId, requesterId: holderId, configSha256,
                    planDigest: preview.digest, operationBasis: sha('nested reset basis'), generation: sha('nested reset generation'),
                    targetIds: [stackId, targetId].sort(),
                    actions: [
                        { stage: 'runtime-stop' as const, targetId: stackId, validForMs: 30_000 },
                        { stage: 'reclaim' as const, targetId, validForMs: 30_000, targetCommitment },
                    ],
                    expectedCoordinationRevision: 0,
                }
                const reserved = await reserveDrain({ namespace: selected.value, request })
                if (reserved.kind !== 'complete') throw new Error(`nested reset drain unavailable: ${JSON.stringify(reserved)}`)
                const runtimeAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: reserved.authority })
                if (runtimeAttempt.kind !== 'complete') throw new Error('runtime attempt unavailable')
                const runtimeCandidate = inspectDrainAttemptAuthority(runtimeAttempt.authority)
                const runtimeExecution = runtimeCandidate && openRuntimeDrainExecution({
                    authority: runtimeAttempt.authority, candidate: runtimeCandidate,
                })
                const runtimeSuccess = runtimeExecution && settleRuntimeDrainSuccess({
                    authority: runtimeExecution,
                    fact: {
                        purpose: request.purpose, stackId, configSha256, planDigest: runtimeAttempt.reservation.planDigest,
                        operationBasis: runtimeAttempt.reservation.operationBasis,
                        coordinationRevision: runtimeAttempt.reservation.coordinationRevision,
                        reservationId: runtimeAttempt.reservation.reservationId, reservedAt: runtimeAttempt.reservation.reservedAt,
                        generation: runtimeAttempt.reservation.generation, attemptId: runtimeAttempt.attempt.attemptId,
                        attemptRevision: runtimeAttempt.attempt.committedRevision, attemptCommittedAt: runtimeAttempt.attempt.committedAt,
                        validThrough: runtimeAttempt.attempt.validThrough, actionIndex: runtimeAttempt.attempt.actionIndex,
                        currentTarget: runtimeAttempt.attempt.currentTarget, currentStage: runtimeAttempt.attempt.currentStage,
                        observedAt: runtimeAttempt.attempt.committedAt,
                    },
                })
                if (!runtimeSuccess) throw new Error('runtime success unavailable')
                const active = await readState(selected.value.paths.coordination(stackId))
                if (active.kind !== 'complete') throw new Error('active drain unavailable')
                const progressed = reduceDrainOutcome({ record: active.value, authority: runtimeSuccess })
                if (!progressed) throw new Error('runtime progress unavailable')
                const publication = await prepareDrainOutcomePublication({
                    authority: runtimeSuccess, namespace: selected.value, stackId,
                })
                if (publication.kind !== 'complete') throw new Error('runtime progress commit unavailable')
                expect(finalizeDrainOutcome({ authority: runtimeSuccess, publication,
                    address: selected.value.paths.coordination(stackId) })).toBe(true)
                const recovered = await recoverDrainReservation({ namespace: selected.value, request })
                if (recovered.kind !== 'complete') throw new Error('drain recovery unavailable')
                const reclaimAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: recovered.authority })
                if (reclaimAttempt.kind !== 'complete') throw new Error('reclaim attempt unavailable')
                const replace = async (scope: 'target' | 'ancestor') => {
                    // Staged beside the original rather than recreated in its place: ext4
                    // reuses the inode a removed directory just freed, which would hand the
                    // replacement the identity the action is bound to and hide the change.
                    const staged = join(root, 'staged-session')
                    await mkdir(staged, { recursive: true })
                    await writeFile(join(staged, 'replacement'), 'preserved')
                    if (scope === 'target') await rm(target, { recursive: true })
                    else await rename(ancestor, join(root, 'held-generated'))
                    await mkdir(dirname(target), { recursive: true })
                    await rename(staged, target)
                }
                if (mode === 'target-before-redemption' || mode === 'ancestor-before-redemption') {
                    await replace(mode.startsWith('target') ? 'target' : 'ancestor')
                    expect(await redeemReclaimAction({ actionAuthority: planned.actionAuthority, attempt: reclaimAttempt.authority })).toBeUndefined()
                    expect(await readFile(join(target, 'replacement'), 'utf8')).toBe('preserved')
                    return
                }
                const execution = await redeemReclaimAction({ actionAuthority: planned.actionAuthority, attempt: reclaimAttempt.authority })
                if (!execution) throw new Error('reclaim execution unavailable')
                if (mode === 'target-after-redemption' || mode === 'ancestor-after-redemption') {
                    await replace(mode.startsWith('target') ? 'target' : 'ancestor')
                    const outcome = await executeProbe(execution.step)
                    expect(outcome).toMatchObject({
                        kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                        execution: { started: false },
                    })
                    expect(outcome).not.toHaveProperty('receipt')
                    expect(await readFile(join(target, 'replacement'), 'utf8')).toBe('preserved')
                    return
                }
                expect(await executeProbe(execution.step)).toMatchObject({ kind: 'complete' })
                await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
            } finally { await rm(root, { recursive: true, force: true }) }
        },
    )

    it.each(['traversal', 'root', 'symlink-parent', 'dangling-link'] as const)('refuses unsafe host path: %s', async (mode) => {
        const root = await canonicalTemp('cockpit-reset-path-')
        try {
            await mkdir(join(root, 'generated'), { recursive: true })
            let target = join(root, 'generated', 'session')
            if (mode === 'traversal') target = join(root, '..', 'outside')
            if (mode === 'root') target = root
            if (mode === 'symlink-parent') {
                await mkdir(join(root, 'outside'))
                await symlink(join(root, 'outside'), join(root, 'generated', 'linked'))
                target = join(root, 'generated', 'linked', 'session')
            }
            if (mode === 'dangling-link') await symlink(join(root, 'missing'), target)
            const result = await planReset(resetInput(root, {
                generatedHostPaths: [{ root, path: target, declaration: 'synthetic' }],
            }))
            expect(result).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each(['disappears', 'is replaced'] as const)('stops when a confirmed target %s', async (change) => {
        const root = await canonicalTemp('cockpit-reset-race-')
        const target = join(root, 'generated', 'session')
        try {
            await mkdir(target, { recursive: true })
            const previewDiscovery = await authenticatedDiscovery(root, [resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })])
            const preview = await planReset(resetInput(root, { discovery: previewDiscovery }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            await rm(target, { recursive: true })
            if (change === 'is replaced') await mkdir(target)
            const changed = await authenticatedDiscovery(root, snapshot([
                resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ]).resources)
            expect(await planReset(resetInput(root, { confirmationDigest: preview.digest, discovery: changed })))
                .toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('withholds continuation authority until the opaque action is consumed', async () => {
        const root = await canonicalTemp('cockpit-reset-continuation-')
        const target = join(root, 'generated', 'session')
        try {
            await mkdir(target, { recursive: true })
            const firstDiscovery = await authenticatedDiscovery(root, [
                resource({ id: 'session-data', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ])
            const coordinationAddress = await writeCoordination(root)
            const preview = await planReset(resetInput(root, { discovery: firstDiscovery }))
            expect(preview.kind).toBe('preview')
            if (preview.kind !== 'preview') return
            const actionDiscovery = await authenticatedDiscovery(root, [
                resource({ id: 'session-data', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ])
            const first = await planReset(resetInput(root, {
                discovery: actionDiscovery, confirmationDigest: preview.digest, consent: preview.consent, coordinationAddress,
            }))
            expect(first.kind).toBe('complete')
            if (first.kind !== 'complete') return
            expect(first.continuation).toBeNull()
            await rm(target, { recursive: true })
            const secondDiscovery = await authenticatedDiscovery(root, [
                resource({ id: 'session-data', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ])
            const second = await planReset(resetInput(root, {
                discovery: secondDiscovery, confirmationDigest: preview.digest, coordinationAddress,
                continuation: Object.freeze({ kind: 'fabricated-reset-continuation' }),
            }))
            expect(second).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each([
        ['foreign', { ...labels, 'dev.b0dea.cockpit.stack-id': foreignStackId }],
        ['stale', { ...labels, 'dev.b0dea.cockpit.config-sha256': sha('stale') }],
        ['malformed', { ...labels, 'dev.b0dea.cockpit.owner-id': '../escape' }],
    ] as const)('refuses a %s declared volume', async (_name, candidateLabels) => {
        const root = await canonicalTemp('cockpit-reset-volume-')
        try {
            const result = await planReset(resetInput(root, {
                generatedHostPaths: [],
                discovery: snapshot([resource({ id: 'volume-1', name: 'session-data', kind: 'volume', labels: candidateLabels, dataBearing: true })]),
            }))
            expect(result).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each([
        'success', 'prestart-failure', 'prestart-retry', 'cold-prestart-retry', 'cold-changed-config',
        'cold-changed-runtime', 'cold-changed-timeout', 'cold-target-set-change', 'cold-target-identity-change',
        'cold-added-target',
        'expired-before-spawn', 'started-failure', 'same-id-replacement',
        'remaining-volume-replacement', 'remaining-volume-bytes-change', 'two-action-success',
        'completed-target-reappears', 'completed-target-is-replaced',
        'cold-second-action-retry', 'cold-second-completed-replacement', 'cold-second-remaining-replacement',
        'cold-second-added-target',
        'wrong-purpose', 'wrong-plan', 'wrong-coordination-revision',
    ] as const)('%s stays bound to one committed reclaim attempt', async (mode) => {
        const root = await canonicalTemp('cockpit-reset-attempt-')
        try {
            const coldRetryMode = mode === 'cold-prestart-retry' || mode === 'cold-changed-config'
                || mode === 'cold-changed-runtime' || mode === 'cold-changed-timeout'
                || mode === 'cold-target-set-change' || mode === 'cold-target-identity-change' || mode === 'cold-added-target'
            const retryMode = mode === 'prestart-retry' || coldRetryMode
            const holderId = `holder:${sha('holder')}:session` as HolderId
            const checkoutId = `checkout:${sha('checkout')}` as CheckoutId
            const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId })
            if (selected.kind !== 'complete') throw new Error('state namespace unavailable')
            const seeded = await transactState(selected.value, selected.value.paths.coordination(stackId), { ownerId: holderId }, () => ({
                format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId, subjectId: stackId,
                revision: 0, updatedAt: new Date().toISOString(), value: {
                    holders: [{ holderId, checkoutId, claimedAt: new Date().toISOString() }],
                    lease: { offset: 0, ports: { WEB: 3000 }, released: false,
                        declaration: { step: 100, count: 1, bases: { WEB: 3000 } } },
                    lastReleasedHolder: null, drain: null,
                },
            }))
            if (seeded.kind !== 'complete') throw new Error('coordination fixture unavailable')
            const volume = resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })
            const hasRemainingVolume = mode === 'remaining-volume-replacement' || mode === 'remaining-volume-bytes-change'
                || mode === 'two-action-success' || mode === 'completed-target-reappears'
                || mode === 'completed-target-is-replaced' || mode === 'cold-second-action-retry'
                || mode === 'cold-second-completed-replacement' || mode === 'cold-second-remaining-replacement'
                || mode === 'cold-second-added-target'
            const remainingVolume = resource({
                id: 'volume-2', name: 'session-logs', kind: 'volume', dataBearing: true,
                generation: sha('remaining-volume-generation'), bytes: 256,
            })
            const resetVolumes = hasRemainingVolume ? [volume, remainingVolume] : [volume]
            const previewDiscovery = await authenticatedDiscovery(root, resetVolumes)
            const base = resetInput(root, {
                coordinationRecord: seeded.value, expectedCoordinationRevision: 0, requesterHolderId: holderId,
                resettableVolumes: hasRemainingVolume ? ['session-data', 'session-logs'] : ['session-data'],
                generatedHostPaths: [], discovery: previewDiscovery,
            })
            const preview = await planReset(base)
            if (preview.kind !== 'preview') throw new Error('reset preview unavailable')
            expect(projectResetActionTargets({ ...preview } as never)).toBeUndefined()
            expect(projectTeardownActionTargets(preview as never)).toBeUndefined()
            const projection = projectResetActionTargets(preview)
            expect(consumeReclaimTargetProjection({ ...projection } as never)).toBeUndefined()
            const projected = consumeReclaimTargetProjection(projection!)
            expect(projected).toMatchObject({
                purpose: 'reset', stackId, configSha256, planDigest: preview.digest,
            })
            expect(Object.isFrozen(projected)).toBe(true)
            expect(Object.isFrozen(projected?.commitments)).toBe(true)
            expect(projected?.commitments.every(Object.isFrozen)).toBe(true)
            const reclaimCommitments = projected?.commitments
            const reclaimTargets = reclaimCommitments?.map(({ targetId }) => targetId)
            expect(reclaimTargets).toEqual(hasRemainingVolume
                ? ['volume:session-data', 'volume:session-logs'] : ['volume:session-data'])
            expect(consumeReclaimTargetProjection(projection!)).toBeUndefined()
            const actionDiscovery = await authenticatedDiscovery(root, resetVolumes)
            const planned = await planReset({
                ...base, discovery: actionDiscovery, confirmationDigest: preview.digest, consent: preview.consent,
                selectionAuthority: selectionByDiscovery.get(actionDiscovery),
                coordinationAddress: selected.value.paths.coordination(stackId),
            })
            if (planned.kind !== 'complete' || !planned.actionAuthority) throw new Error('reset action unavailable')
            const targetIds = [stackId, ...reclaimTargets!].sort()
            if (mode === 'wrong-coordination-revision') {
                const advanced = await transactState(
                    selected.value, selected.value.paths.coordination(stackId), { ownerId: holderId },
                    (current) => {
                        const value = current && decodeCoordinationRecord(current, stackId)
                        if (!value) throw new Error('coordination advance unavailable')
                        return coordinationStateRecord(selected.value, stackId, current, new Date().toISOString(), value)
                    },
                )
                if (advanced.kind !== 'complete') throw new Error('coordination advance unavailable')
            }
            const drainRequest = {
                purpose: mode === 'wrong-purpose' ? 'down' as const : 'reset' as const, stackId, holderId, requesterId: holderId, configSha256,
                planDigest: mode === 'wrong-plan' ? sha('other reset plan') : preview.digest,
                operationBasis: sha('reset basis'), generation: sha('reset generation'),
                targetIds, actions: [
                    { stage: 'runtime-stop' as const, targetId: stackId, validForMs: 30_000 },
                    ...reclaimCommitments!.map(({ targetId, ...targetCommitment }) => ({
                        stage: 'reclaim' as const, targetId, validForMs: 30_000, targetCommitment,
                    })),
                ], expectedCoordinationRevision: mode === 'wrong-coordination-revision' ? 1 : 0,
            }
            const reserved = await reserveDrain({ namespace: selected.value, request: drainRequest })
            if (reserved.kind !== 'complete') throw new Error('drain reservation unavailable')
            const runtimeAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: reserved.authority })
            if (runtimeAttempt.kind !== 'complete') throw new Error('runtime attempt unavailable')
            expect(await redeemReclaimAction({ actionAuthority: planned.actionAuthority, attempt: { ...runtimeAttempt.authority } as never })).toBeUndefined()
            const runtimeFact = {
                purpose: drainRequest.purpose, stackId, configSha256, planDigest: runtimeAttempt.reservation.planDigest,
                operationBasis: runtimeAttempt.reservation.operationBasis, coordinationRevision: runtimeAttempt.reservation.coordinationRevision,
                reservationId: runtimeAttempt.reservation.reservationId, reservedAt: runtimeAttempt.reservation.reservedAt,
                generation: runtimeAttempt.reservation.generation, attemptId: runtimeAttempt.attempt.attemptId,
                attemptRevision: runtimeAttempt.attempt.committedRevision, attemptCommittedAt: runtimeAttempt.attempt.committedAt,
                validThrough: runtimeAttempt.attempt.validThrough, actionIndex: runtimeAttempt.attempt.actionIndex,
                currentTarget: runtimeAttempt.attempt.currentTarget, currentStage: runtimeAttempt.attempt.currentStage,
                observedAt: runtimeAttempt.attempt.committedAt,
            }
            const activeRecord = await readState(selected.value.paths.coordination(stackId))
            if (activeRecord.kind !== 'complete') throw new Error('active drain unavailable')
            const runtimeCandidate = inspectDrainAttemptAuthority(runtimeAttempt.authority)
            const runtimeExecution = runtimeCandidate && openRuntimeDrainExecution({
                authority: runtimeAttempt.authority, candidate: runtimeCandidate,
            })
            const runtimeSuccess = runtimeExecution && settleRuntimeDrainSuccess({
                authority: runtimeExecution, fact: runtimeFact,
            })
            if (!runtimeSuccess) throw new Error('runtime success authority unavailable')
            const progressed = reduceDrainOutcome({ record: activeRecord.value, authority: runtimeSuccess })
            if (!progressed) throw new Error('runtime progress unavailable')
            const progressCommit = await prepareDrainOutcomePublication({
                authority: runtimeSuccess, namespace: selected.value, stackId,
            })
            if (progressCommit.kind !== 'complete') throw new Error('runtime progress commit unavailable')
            expect(finalizeDrainOutcome({ authority: runtimeSuccess, publication: progressCommit,
                address: selected.value.paths.coordination(stackId) })).toBe(true)
            const recovered = await recoverDrainReservation({ namespace: selected.value, request: drainRequest })
            if (recovered.kind !== 'complete') throw new Error('drain recovery unavailable')
            const reclaimAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: recovered.authority })
            if (reclaimAttempt.kind !== 'complete') throw new Error('reclaim attempt unavailable')
            expect(reclaimAttempt.attempt).toMatchObject({ currentStage: 'reclaim', currentTarget: 'volume:session-data', actionIndex: 1 })
            expect(await redeemReclaimAction({ actionAuthority: { ...planned.actionAuthority } as never, attempt: reclaimAttempt.authority })).toBeUndefined()
            const recoveredAgain = await recoverDrainReservation({ namespace: selected.value, request: drainRequest })
            expect(recoveredAgain).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }] })
            const execution = await redeemReclaimAction({ actionAuthority: planned.actionAuthority, attempt: reclaimAttempt.authority })
            if (mode === 'wrong-purpose' || mode === 'wrong-plan' || mode === 'wrong-coordination-revision') {
                expect(execution).toBeUndefined()
                return
            }
            if (!execution) throw new Error('reclaim execution unavailable')
            if (mode === 'prestart-failure' || retryMode) await writeFile(execution.step.argv[0], '#!/bin/sh\nexit 1\n', { mode: 0o700 })
            if (mode === 'started-failure') await rm(join(root, 'docker.volume'))
            if (mode === 'expired-before-spawn') {
                vi.useFakeTimers()
                vi.setSystemTime(Date.parse(execution.step.spawnNotAfter!) + 1)
            }
            const outcome = await executeProbe(execution.step)
            if (mode === 'prestart-failure' || retryMode || mode === 'expired-before-spawn' || mode === 'started-failure') {
                expect(outcome).toMatchObject({ kind: 'refusal', execution: { started: mode === 'started-failure' } })
                const failed = admitReclaimFailure({ authority: execution.authority, outcome })
                if (mode === 'expired-before-spawn') vi.useRealTimers()
                if (mode === 'started-failure') {
                    expect(failed).toMatchObject({ kind: 'unavailable' })
                    return
                }
                expect(failed).toMatchObject({ kind: 'complete', authority: expect.any(Object) })
                if (failed.kind !== 'complete') return
                const preCommitDiscovery = retryMode
                    ? await authenticatedDiscovery(root, resetVolumes) : undefined
                expect(consumeReclaimFailure({ ...failed.authority })).toBeUndefined()
                const failureAuthority = consumeReclaimFailure(failed.authority)
                expect(failureAuthority).toEqual({})
                expect(consumeReclaimFailure(failed.authority)).toBeUndefined()
                if (retryMode && failureAuthority) {
                    const active = await readState(selected.value.paths.coordination(stackId))
                    if (active.kind !== 'complete') throw new Error('failed attempt record unavailable')
                    const failedValue = reduceDrainOutcome({ record: active.value, authority: failureAuthority })
                    if (!failedValue) throw new Error('failed attempt transition unavailable')
                    const failedCommit = await prepareDrainOutcomePublication({
                        authority: failureAuthority, namespace: selected.value, stackId,
                    })
                    if (failedCommit.kind !== 'complete') throw new Error('failed attempt commit unavailable')
                    expect(finalizeDrainOutcome({ authority: failureAuthority, publication: failedCommit,
                        address: selected.value.paths.coordination(stackId) })).toBe(true)
                    expect(reduceDrainOutcome({ record: failedCommit.value, authority: failureAuthority })).toBeUndefined()
                    if (coldRetryMode) {
                        vi.resetModules()
                        const freshReclaim = await import('./reclaim.js')
                        const freshClaims = await import('./claims.js')
                        const freshExecute = await import('../environment-exec/execute.js')
                        const freshApi: DiscoveryApi = { ...freshReclaim, executeProbe: freshExecute.executeProbe }
                        expect(await freshClaims.recoverDrainReservation({ namespace: selected.value, request: {
                            ...drainRequest, planDigest: sha('changed cold plan'),
                        } })).toMatchObject({ kind: 'refusal' })
                        expect(await freshClaims.recoverDrainReservation({ namespace: selected.value, request: {
                            ...drainRequest, purpose: 'down',
                        } })).toMatchObject({ kind: 'refusal' })
                        expect(await freshClaims.recoverDrainReservation({ namespace: selected.value, request: {
                            ...drainRequest, generation: sha('changed cold generation'),
                        } })).toMatchObject({ kind: 'refusal' })
                        expect(await freshClaims.recoverDrainReservation({ namespace: selected.value, request: {
                            ...drainRequest, expectedCoordinationRevision: drainRequest.expectedCoordinationRevision + 1,
                        } })).toMatchObject({ kind: 'refusal' })
                        expect(await freshClaims.recoverDrainReservation({ namespace: selected.value, request: {
                            ...drainRequest, targetIds: [...drainRequest.targetIds].reverse(),
                        } })).toMatchObject({ kind: 'refusal' })
                        const coldReservation = await freshClaims.recoverDrainReservation({ namespace: selected.value, request: drainRequest })
                        if (coldReservation.kind !== 'complete') throw new Error('cold retry drain recovery unavailable')
                        const coldRecordAuthority = freshClaims.inspectFailedReclaimRecovery({
                            authority: coldReservation.authority, record: failedCommit.value,
                        })
                        expect(coldRecordAuthority).toBeDefined()
                        expect(freshClaims.consumeFailedReclaimRecovery(coldRecordAuthority!)).toMatchObject({
                            purpose: 'reset', current: { targetCommitment: expect.any(Object) },
                        })
                        const coldResources = mode === 'cold-target-set-change' ? []
                            : mode === 'cold-target-identity-change'
                                ? [resource({ ...volume, generation: sha('changed cold identity') })]
                                : mode === 'cold-added-target'
                                    ? [resource({ id: 'volume-0', name: 'a-data', kind: 'volume', dataBearing: true,
                                        generation: sha('added cold target') }), volume]
                                : resetVolumes
                        const coldDiscovery = await authenticatedDiscovery(root, coldResources, freshApi)
                        const coldInput = {
                            ...base, coordinationRecord: failedCommit.value,
                            expectedCoordinationRevision: failedCommit.value.revision,
                            discovery: coldDiscovery, runtimeExecutable: runtimeByDiscovery.get(coldDiscovery)!,
                            selectionAuthority: selectionByDiscovery.get(coldDiscovery),
                            confirmationDigest: preview.digest,
                            recoveryAuthority: coldReservation.authority,
                            ...(mode === 'cold-changed-config' ? { configSha256: sha('changed cold config') } : {}),
                            ...(mode === 'cold-changed-runtime' ? { cwd: join(root, 'changed-runtime') } : {}),
                            ...(mode === 'cold-changed-timeout' ? { timeoutMs: 29_000 } : {}),
                            ...(mode === 'cold-added-target' ? { resettableVolumes: ['a-data', 'session-data'] } : {}),
                            coordinationAddress: selected.value.paths.coordination(stackId),
                        }
                        if (mode === 'cold-prestart-retry') {
                            expect(await freshReclaim.planReset({
                                ...coldInput, recoveryAuthority: { ...coldReservation.authority } as never,
                            })).toMatchObject({ kind: 'refusal' })
                        }
                        const coldPlan = await freshReclaim.planReset(coldInput)
                        if (mode !== 'cold-prestart-retry') {
                            expect(coldPlan).toMatchObject({ kind: 'refusal' })
                            return
                        }
                        if (coldPlan.kind !== 'complete' || !coldPlan.actionAuthority) throw new Error(`cold retry reset action unavailable: ${JSON.stringify(coldPlan)}`)
                        const coldAttempt = await freshClaims.reserveDrainAttempt({ namespace: selected.value, authority: coldReservation.authority })
                        if (coldAttempt.kind !== 'complete') throw new Error('cold retry drain attempt unavailable')
                        expect(await freshReclaim.redeemReclaimAction({
                            actionAuthority: planned.actionAuthority, attempt: coldAttempt.authority,
                        })).toBeUndefined()
                        expect(freshClaims.reduceDrainOutcome({
                            record: failedCommit.value, authority: failureAuthority,
                        })).toBeUndefined()
                        const coldExecution = await freshReclaim.redeemReclaimAction({ actionAuthority: coldPlan.actionAuthority, attempt: coldAttempt.authority })
                        if (!coldExecution) throw new Error('cold retry reclaim execution unavailable')
                        const coldOutcome = await freshExecute.executeProbe(coldExecution.step)
                        expect(coldOutcome.kind).toBe('complete')
                        const coldPost = await authenticatedDiscovery(root, [], freshApi)
                        expect(freshReclaim.reconcileReclaimAction({ authority: coldExecution.authority, outcome: coldOutcome, discovery: coldPost }))
                            .toMatchObject({ kind: 'complete' })
                        return
                    }
                    const stalePlan = await planReset({
                        ...base, coordinationRecord: failedCommit.value, expectedCoordinationRevision: failedCommit.value.revision,
                        discovery: preCommitDiscovery!, selectionAuthority: selectionByDiscovery.get(preCommitDiscovery!),
                        confirmationDigest: preview.digest, continuation: failed.continuation,
                        coordinationAddress: selected.value.paths.coordination(stackId),
                    })
                    expect(stalePlan).toMatchObject({ kind: 'refusal' })
                    const retryDiscovery = await authenticatedDiscovery(root, resetVolumes)
                    const retryPlan = await planReset({
                        ...base, coordinationRecord: failedCommit.value, expectedCoordinationRevision: failedCommit.value.revision,
                        discovery: retryDiscovery, selectionAuthority: selectionByDiscovery.get(retryDiscovery),
                        confirmationDigest: preview.digest,
                        continuation: failed.continuation,
                        coordinationAddress: selected.value.paths.coordination(stackId),
                    })
                    if (retryPlan.kind !== 'complete' || !retryPlan.actionAuthority) throw new Error(`retry reset action unavailable: ${JSON.stringify(retryPlan)}`)
                    const retryReservation = await recoverDrainReservation({ namespace: selected.value, request: drainRequest })
                    if (retryReservation.kind !== 'complete') throw new Error('retry drain recovery unavailable')
                    const retryAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: retryReservation.authority })
                    if (retryAttempt.kind !== 'complete') throw new Error('retry drain attempt unavailable')
                    expect(await redeemReclaimAction({ actionAuthority: planned.actionAuthority, attempt: retryAttempt.authority })).toBeUndefined()
                    const retryExecution = await redeemReclaimAction({ actionAuthority: retryPlan.actionAuthority, attempt: retryAttempt.authority })
                    if (!retryExecution) throw new Error('retry reclaim execution unavailable')
                    const retryOutcome = await executeProbe(retryExecution.step)
                    expect(retryOutcome.kind).toBe('complete')
                    const retryPost = await authenticatedDiscovery(root, [])
                    expect(reconcileReclaimAction({ authority: retryExecution.authority, outcome: retryOutcome, discovery: retryPost }))
                        .toMatchObject({ kind: 'complete' })
                }
                return
            }
            expect(outcome.kind).toBe('complete')
            if (mode === 'same-id-replacement') {
                const replacement = await authenticatedDiscovery(root, [resource({
                    id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true,
                    generation: sha('replacement-generation'), labels: { ...labels, replacement: 'true' },
                })])
                expect(reconcileReclaimAction({ authority: execution.authority, outcome, discovery: replacement }))
                    .toMatchObject({ kind: 'refusal' })
                return
            }
            const remainingAfterAction = mode === 'remaining-volume-replacement'
                ? [resource({
                    ...remainingVolume, generation: sha('replacement-generation'),
                    labels: { ...labels, replacement: 'true' },
                })]
                : mode === 'remaining-volume-bytes-change'
                    ? [resource({ ...remainingVolume, bytes: 4_096 })]
                    : hasRemainingVolume ? [remainingVolume] : []
            const postDiscovery = await authenticatedDiscovery(root, remainingAfterAction)
            let reads = 0
            const accessorInput = { outcome, discovery: postDiscovery } as Record<string, unknown>
            Object.defineProperty(accessorInput, 'authority', { enumerable: true, get: () => { reads += 1; return execution.authority } })
            expect(reconcileReclaimAction(accessorInput as never)).toMatchObject({ kind: 'refusal' })
            expect(reads).toBe(0)
            expect(reconcileReclaimAction({ authority: execution.authority, outcome, discovery: postDiscovery, [Symbol('hidden')]: true } as never))
                .toMatchObject({ kind: 'refusal' })
            const reconciled = reconcileReclaimAction({ authority: execution.authority, outcome, discovery: postDiscovery })
            if (mode === 'remaining-volume-replacement') {
                expect(reconciled).toMatchObject({ kind: 'refusal' })
                return
            }
            expect(reconciled).toMatchObject({ kind: 'complete', authority: expect.any(Object) })
            if (mode === 'two-action-success') expect(reconciled).toMatchObject({ continuation: expect.any(Object) })
            if (reconciled.kind !== 'complete' || !reconciled.authority) return
            expect(consumeReclaimCompleted({ ...reconciled.authority })).toBeUndefined()
            const reclaimSuccess = consumeReclaimCompleted(reconciled.authority)
            expect(reclaimSuccess).toEqual({})
            expect(consumeReclaimCompleted(reconciled.authority)).toBeUndefined()
            if ((mode === 'two-action-success' || mode === 'completed-target-reappears' || mode === 'completed-target-is-replaced'
                || mode === 'cold-second-action-retry' || mode === 'cold-second-completed-replacement'
                || mode === 'cold-second-remaining-replacement' || mode === 'cold-second-added-target') && reclaimSuccess) {
                const current = await readState(selected.value.paths.coordination(stackId))
                if (current.kind !== 'complete') throw new Error('reclaim progress record unavailable')
                const nextProgress = reduceDrainOutcome({ record: current.value, authority: reclaimSuccess })
                if (!nextProgress) throw new Error('reclaim progress unavailable')
                const committed = await prepareDrainOutcomePublication({
                    authority: reclaimSuccess, namespace: selected.value, stackId,
                })
                if (committed.kind !== 'complete') throw new Error('reclaim progress commit unavailable')
                expect(finalizeDrainOutcome({ authority: reclaimSuccess, publication: committed,
                    address: selected.value.paths.coordination(stackId) })).toBe(true)
                const nextDiscovery = await authenticatedDiscovery(root, [remainingVolume])
                const nextPlan = await planReset({
                    ...base, coordinationRecord: committed.value, expectedCoordinationRevision: committed.value.revision,
                    discovery: nextDiscovery, selectionAuthority: selectionByDiscovery.get(nextDiscovery),
                    confirmationDigest: preview.digest, continuation: reconciled.continuation ?? undefined,
                    coordinationAddress: selected.value.paths.coordination(stackId),
                })
                if (nextPlan.kind !== 'complete' || !nextPlan.actionAuthority) throw new Error(`second reset action unavailable: ${JSON.stringify(nextPlan)}`)
                const nextReservation = await recoverDrainReservation({ namespace: selected.value, request: drainRequest })
                if (nextReservation.kind !== 'complete') throw new Error('second drain recovery unavailable')
                const nextAttempt = await reserveDrainAttempt({ namespace: selected.value, authority: nextReservation.authority })
                if (nextAttempt.kind !== 'complete') throw new Error('second reclaim attempt unavailable')
                const nextExecution = await redeemReclaimAction({ actionAuthority: nextPlan.actionAuthority, attempt: nextAttempt.authority })
                if (!nextExecution) throw new Error('second reclaim execution unavailable')
                const coldSecond = mode === 'cold-second-action-retry' || mode === 'cold-second-completed-replacement'
                    || mode === 'cold-second-remaining-replacement' || mode === 'cold-second-added-target'
                const secondExecutableBytes = coldSecond ? await readFile(nextExecution.step.argv[0]) : undefined
                if (coldSecond) await writeFile(nextExecution.step.argv[0], '#!/bin/sh\nexit 1\n', { mode: 0o700 })
                const nextOutcome = await executeProbe(nextExecution.step)
                if (coldSecond) {
                    await writeFile(nextExecution.step.argv[0], secondExecutableBytes!, { mode: 0o700 })
                    const failed = admitReclaimFailure({ authority: nextExecution.authority, outcome: nextOutcome })
                    if (failed.kind !== 'complete') throw new Error('second reset failure authority unavailable')
                    const failureAuthority = consumeReclaimFailure(failed.authority)
                    if (!failureAuthority) throw new Error('second reset failure unavailable')
                    const secondActive = await readState(selected.value.paths.coordination(stackId))
                    if (secondActive.kind !== 'complete') throw new Error('second active reset attempt unavailable')
                    const failedValue = reduceDrainOutcome({ record: secondActive.value, authority: failureAuthority })
                    if (!failedValue) throw new Error('second reset failure transition unavailable')
                    const failedCommit = await prepareDrainOutcomePublication({
                        authority: failureAuthority, namespace: selected.value, stackId,
                    })
                    if (failedCommit.kind !== 'complete') throw new Error('second reset failure commit unavailable')
                    expect(finalizeDrainOutcome({ authority: failureAuthority, publication: failedCommit,
                        address: selected.value.paths.coordination(stackId) })).toBe(true)
                    vi.resetModules()
                    const freshReclaim = await import('./reclaim.js')
                    const freshClaims = await import('./claims.js')
                    const freshExecute = await import('../environment-exec/execute.js')
                    const freshApi: DiscoveryApi = { ...freshReclaim, executeProbe: freshExecute.executeProbe }
                    const coldReservation = await freshClaims.recoverDrainReservation({ namespace: selected.value, request: drainRequest })
                    if (coldReservation.kind !== 'complete') throw new Error('second cold reset recovery unavailable')
                    const coldResources = mode === 'cold-second-completed-replacement'
                        ? [resource({ ...volume, id: 'volume-replacement' }), remainingVolume]
                        : mode === 'cold-second-remaining-replacement'
                            ? [resource({ ...remainingVolume, generation: sha('replacement-generation') })]
                            : mode === 'cold-second-added-target'
                                ? [resource({ id: 'volume-0', name: 'a-data', kind: 'volume', dataBearing: true,
                                    generation: sha('added cold second target') }), remainingVolume]
                            : [remainingVolume]
                    const coldDiscovery = await authenticatedDiscovery(root, coldResources, freshApi)
                    const coldPlan = await freshReclaim.planReset({
                        ...base, coordinationRecord: failedCommit.value,
                        expectedCoordinationRevision: failedCommit.value.revision,
                        discovery: coldDiscovery, runtimeExecutable: runtimeByDiscovery.get(coldDiscovery)!,
                        selectionAuthority: selectionByDiscovery.get(coldDiscovery), confirmationDigest: preview.digest,
                        recoveryAuthority: coldReservation.authority,
                        ...(mode === 'cold-second-added-target' ? { resettableVolumes: ['a-data', 'session-data', 'session-logs'] } : {}),
                        coordinationAddress: selected.value.paths.coordination(stackId),
                    })
                    if (mode !== 'cold-second-action-retry') {
                        expect(coldPlan).toMatchObject({ kind: 'refusal' })
                        return
                    }
                    if (coldPlan.kind !== 'complete' || !coldPlan.actionAuthority) throw new Error('second cold reset action unavailable')
                    const coldAttempt = await freshClaims.reserveDrainAttempt({ namespace: selected.value, authority: coldReservation.authority })
                    if (coldAttempt.kind !== 'complete') throw new Error('second cold reset retry attempt unavailable')
                    const coldExecution = await freshReclaim.redeemReclaimAction({ actionAuthority: coldPlan.actionAuthority, attempt: coldAttempt.authority })
                    if (!coldExecution) throw new Error('second cold reset execution unavailable')
                    const coldOutcome = await freshExecute.executeProbe(coldExecution.step)
                    expect(coldOutcome.kind).toBe('complete')
                    const coldPost = await authenticatedDiscovery(root, [], freshApi)
                    expect(freshReclaim.reconcileReclaimAction({ authority: coldExecution.authority, outcome: coldOutcome, discovery: coldPost }))
                        .toMatchObject({ kind: 'complete' })
                    return
                }
                expect(nextOutcome.kind).toBe('complete')
                const finalDiscovery = await authenticatedDiscovery(root,
                    mode === 'completed-target-reappears' ? [volume]
                        : mode === 'completed-target-is-replaced' ? [resource({ ...volume, id: 'volume-replacement' })] : [])
                const final = reconcileReclaimAction({ authority: nextExecution.authority, outcome: nextOutcome, discovery: finalDiscovery })
                expect(final).toMatchObject({ kind: mode === 'completed-target-reappears' || mode === 'completed-target-is-replaced' ? 'refusal' : 'complete' })
                if (mode === 'two-action-success') expect(final).toMatchObject({ kind: 'complete', continuation: null })
            }
        } finally {
            vi.useRealTimers()
            await rm(root, { recursive: true, force: true })
        }
    })
})
