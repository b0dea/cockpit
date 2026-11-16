import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import type { CockpitId, StackId } from './contract.js'
import {
    classifyReclaim,
    discoverMachineStacks,
    discoverReclaim,
    inspectionOverflow,
    planReset,
    removeTargets,
    type ReclaimDiscovery,
    type ReclaimDiscoverySnapshot,
    type ReclaimResource,
} from './reclaim.js'
import type { ExecutionStep } from './contract.js'
import type { StateRecord } from './state.js'

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
// Compose labels each volume it creates with its project and the volume's key in the Compose file.
const composeProject = 'synthetic-0123456789ab'
const composeLabels = (key: string) => ({ 'com.docker.compose.project': composeProject, 'com.docker.compose.volume': key })
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
    executionMode: 'verified-path' as const,
})

const canonicalTemp = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)))

const dockerRow = ({ id, name, kind, labels: itemLabels, referenced, bytes }: ReclaimResource) => kind === 'build-cache'
    ? { ID: id, Reclaimable: !referenced, Size: bytes === null ? null : String(bytes) }
    : {
          id: kind === 'volume' ? name : id, name,
          labels: kind === 'image' ? {} : Object.fromEntries([...Object.keys(labels), ...kind === 'volume' ? Object.keys(composeLabels('')) : []]
              .map((key) => [key, itemLabels[key] ?? ''])),
          referenced: false,
          bytes: kind === 'network' || kind === 'container' ? null : bytes,
      }
// The daemon applies the stack-label filter itself, so the fixture keeps both answers: every row,
// and the rows carrying this stack's label that the filtered listing returns.
const writeDockerRows = async (root: string, kind: string, rows: readonly ReclaimResource[], encode = (row: ReclaimResource) => JSON.stringify(dockerRow(row))) => {
    await writeFile(join(root, `docker.${kind}`), `${rows.map(encode).join('\n')}\n`)
    const owned = rows.filter((row) => row.labels['dev.b0dea.cockpit.stack-id'] === stackId)
    await writeFile(join(root, `docker.${kind}.owned`), `${owned.map(encode).join('\n')}\n`)
}
// Answers `docker container ls --filter network=<name>` with every container attached to a network,
// whatever its labels: the listing a network's holders are found by.
const writeNetworkHolders = async (root: string, holders: Readonly<Record<string, readonly string[]>>) => {
    await writeFile(join(root, 'docker.container.holders'), `${Object.entries(holders)
        .map(([id, networks]) => JSON.stringify({ id, networks: networks.join(',') })).join('\n')}\n`)
}
// Serves the fixture rows by argv: an inspection prints one object per id, the stack-label filter
// selects the owned rows, and a network filter selects the attached holders.
const fakeDocker = `#!/bin/sh
if [ "$1" = context ] && [ "$2" = inspect ]; then /bin/cat -- "$PWD/selection.context"; exit; fi
case "$1" in --host) shift 2;; *) exit 91;; esac
kind="$1"
if [ "$2" = inspect ]; then echo "$kind" >> "$PWD/inspect.calls"; shift 4; status=0; for id do if [ "$kind" = image ] || [ "$kind" = volume ]; then /bin/cat -- "$PWD/inspect.$id" || status=1; else /bin/cat -- "$PWD/inspect.$kind.$id" || status=1; fi; done; exit $status; fi
if [ "$kind" = builder ]; then shift; kind=build-cache; [ "$1" = prune ] && exit 0; fi
suffix=
for arg do case "$arg" in "label=dev.b0dea.cockpit.stack-id=${stackId}") suffix=.owned;; network=*) suffix=.holders;; esac; done
/bin/cat -- "$PWD/docker.$kind$suffix"
`
const runtimeByDiscovery = new WeakMap<object, ReturnType<typeof executable>>()

const authenticatedDiscovery = async (
    root: string,
    resources: readonly ReclaimResource[],
    options: {
        readonly networkInspection?: (resource: ReclaimResource) => unknown
        readonly containerNetworks?: Readonly<Record<string, readonly string[]>>
        readonly displayedBytes?: Readonly<Record<string, string>>
        readonly discoveryStackId?: StackId
        readonly execute?: typeof executeProbe
    } = {},
): Promise<ReclaimDiscovery> => {
    const groups = new Map<Exclude<ReclaimResource['kind'], 'cache'>, ReclaimResource[]>([
        ['container', []], ['network', []], ['volume', []], ['image', []], ['build-cache', []],
    ])
    for (const item of resources) {
        if (item.kind === 'cache') throw new Error('filesystem cache cannot enter Docker discovery')
        groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
    }
    for (const [kind, rows] of groups) {
        await writeDockerRows(root, kind, rows, (row) => {
            const shown = options.displayedBytes?.[row.id]
            const encoded = dockerRow(row) as Record<string, unknown>
            return JSON.stringify(shown === undefined ? encoded : kind === 'build-cache' ? { ...encoded, Size: shown } : { ...encoded, bytes: shown })
        })
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
    }
    // A holder names each network it is attached to: `name:<network>` directly, as a created,
    // never-started container does, or a network id resolved to that network's name.
    const networkName = (reference: string) => reference.startsWith('name:') ? reference.slice(5)
        : resources.find(({ kind, id }) => kind === 'network' && id === reference)?.name ?? `network-${reference.slice(0, 8)}`
    await writeNetworkHolders(root, Object.fromEntries(Object.entries(options.containerNetworks ?? {})
        .map(([id, networks]) => [id, networks.map(networkName)])))
    await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
    const script = join(root, 'docker')
    const bytes = Buffer.from(fakeDocker)
    await writeFile(script, bytes, { mode: 0o700 })
    await chmod(script, 0o700)
    const docker = { canonicalPath: script, invocationPath: script, sha256: createHash('sha256').update(bytes).digest('hex'), executionMode: 'verified-path' as const }
    const steps: ExecutionStep[] = []
    const run = options.execute ?? executeProbe
    const discovery = await discoverReclaim({
        executable: docker, cwd: root, env: { PATH: '/usr/bin:/bin' }, stackId: options.discoveryStackId ?? stackId, cockpitId,
        timeoutMs: 5_000, context: dockerContext,
    }, async (step) => { steps.push(step); return run(step) })
    if (discovery === undefined || 'diagnostics' in discovery) throw new Error(`discovery unavailable: ${JSON.stringify(discovery)}`)
    const listing = (kind: string) => steps.find(({ id }) => id === `runtime:discover:${kind}`)
    const owned = ['--filter', `label=dev.b0dea.cockpit.stack-id=${options.discoveryStackId ?? stackId}`]
    expect(listing('container')?.argv.slice(0, 9)).toEqual([script, '--host', dockerEndpoint, 'container', 'ls', '--all', '--no-trunc', ...owned])
    expect(listing('container')?.argv.at(-1)).toContain('.Label "dev.b0dea.cockpit.owner-id"')
    expect(listing('container')?.argv.at(-1)).toContain('"bytes":null')
    expect(listing('image')?.argv.slice(3, 9)).toEqual(['image', 'ls', '--all', '--no-trunc', ...owned])
    expect(listing('image')?.argv.at(-1)).not.toContain('.Label')
    expect(listing('network')?.argv.slice(3, 8)).toEqual(['network', 'ls', '--no-trunc', ...owned])
    expect(listing('network')?.argv.at(-1)).toContain('"bytes":null')
    expect(listing('volume')?.argv).not.toContain('--filter')
    expect(listing('build-cache')?.argv).toEqual([script, '--host', dockerEndpoint, 'builder', 'du', '--format', 'json'])
    const imageInspection = steps.find(({ labels: item }) => item.resourceKind === 'image-inspection')
    if (imageInspection !== undefined) expect(imageInspection.argv[6]).toContain('{{with (index .Config "Labels")}}')
    const networkInspection = steps.find(({ labels: item }) => item.resourceKind === 'network-inspection')
    if (networkInspection !== undefined) {
        expect(networkInspection.argv.slice(3, 6)).toEqual(['network', 'inspect', '--format'])
        expect(networkInspection.argv[6]).toContain('range $member, $endpoint := .Containers')
    }
    runtimeByDiscovery.set(discovery, docker)
    return discovery
}

const resetInput = (root: string, overrides: Record<string, unknown> = {}) => {
    const runtime = typeof overrides.discovery === 'object' && overrides.discovery !== null
        ? runtimeByDiscovery.get(overrides.discovery) : undefined
    return ({
        stackId,
        cockpitId,
        configSha256,
        coordinationRecord: stateRecord(root),
        requesterHolderId: null,
        declaredCacheIds: [],
        resettableVolumes: ['session-data'],
        composeProject,
        generatedHostPaths: [{ root, path: join(root, 'generated', 'session'), declaration: 'generated/session' }],
        discovery: plannedDiscovery([resource({
            id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation'),
        })]),
        runtimeExecutable: runtime ?? executable('/usr/local/bin/docker'),
        pathExecutable: executable('/bin/rm'),
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10_000,
        ...overrides,
    })
}

// A volume without explicit labels is one Compose created for this stack under the key it is named.
const resource = (overrides: Partial<ReclaimResource> = {}): ReclaimResource => ({
    id: 'container-1',
    name: 'synthetic-container',
    kind: 'container',
    labels: overrides.kind === 'volume' ? { ...labels, ...composeLabels(overrides.name ?? 'synthetic-container') } : labels,
    referenced: false,
    bytes: 128,
    ...overrides,
})

const snapshot = (resources: readonly ReclaimResource[]): ReclaimDiscoverySnapshot => ({
    observedAt: '2026-09-08T00:00:01.000Z',
    producer: 'runtime-resource-discovery',
    resources,
})

// A discovery as discoverReclaim returns it, for planning cases that need no Docker fixture.
const plannedDiscovery = (resources: readonly ReclaimResource[]): ReclaimDiscovery => ({
    ...snapshot(resources), startedAt: '2026-09-08T00:00:00.000Z', stackId,
    selection: { context: dockerContext, endpoint: dockerEndpoint },
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
    ] as const)('classifies %s labels without granting an action', (ownership, candidateLabels) => {
        const result = classify([resource({ labels: candidateLabels })])
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.resources[0]).toEqual(expect.objectContaining({ ownership, action: 'report-only' }))
        expect(result.resources[0]?.evidence.length).toBeGreaterThan(0)
        expect(result.resources[0]?.reason.length).toBeGreaterThan(0)
    })

    it('tears down runtime resources an earlier configuration of this stack started, and keeps their data', () => {
        const earlier = { ...labels, 'dev.b0dea.cockpit.config-sha256': sha('earlier') }
        const resources = [
            resource({ id: 'container-earlier', labels: earlier }),
            resource({ id: 'network-earlier', name: 'synthetic_default', kind: 'network', labels: earlier, bytes: null }),
            resource({ id: 'volume-earlier', name: 'session-data', kind: 'volume', labels: earlier, dataBearing: true }),
        ]
        const result = classify(resources)
        if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
        expect(result.resources.map(({ id, ownership, action }) => ({ id, ownership, action }))).toEqual([
            { id: 'container-earlier', ownership: 'stale-config', action: 'teardown' },
            { id: 'network-earlier', ownership: 'stale-config', action: 'teardown' },
            { id: 'volume-earlier', ownership: 'stale-config', action: 'report-only' },
        ])
        // Without the stack's coordination record the labels alone grant nothing, whichever configuration they name.
        const unrecorded = classifyReclaim({ stackId, cockpitId, configSha256, coordinationRecord: null, declaredCacheIds: [], discovery: snapshot(resources) })
        if (unrecorded.kind !== 'complete') throw new Error(JSON.stringify(unrecorded))
        expect(unrecorded.resources.map(({ ownership, action }) => ({ ownership, action })))
            .toEqual(resources.map(() => ({ ownership: 'unknown', action: 'report-only' })))
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
    it('keeps a network held by a container outside the stack listing and releases one held only by its own stack', async () => {
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
            ], {
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
            // The listing is scoped to this stack's label, so the foreign and unlabelled resources are
            // absent from discovery; the unlabelled and foreign containers still hold their networks.
            expect(observed.resources.filter(({ kind }) => kind !== 'network').map(({ id }) => id))
                .toEqual(['container-created-own', 'container-own'])
            expect(observed.resources.filter(({ kind }) => kind === 'network').map(({ id, referenced }) => ({ id, referenced }))).toEqual([
                { id: 'network-created', referenced: true },
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
                { id: 'network-orphan', ownership: 'current', action: 'teardown' },
                { id: 'network-own', ownership: 'current', action: 'teardown' },
                { id: 'network-running', ownership: 'current', action: 'report-only' },
                { id: 'network-stopped', ownership: 'current', action: 'report-only' },
            ])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('lists cockpit-labelled resources of every stack by label presence, and fails closed on a row it cannot read', async () => {
        const root = await canonicalTemp('cockpit-machine-discovery-')
        try {
            const script = join(root, 'docker')
            const bytes = '#!/bin/sh\nif [ "$1" = context ]; then /bin/cat -- "$PWD/selection.context"; exit; fi\n/bin/cat -- "$PWD/machine.$4"\n'
            await writeFile(script, bytes, { mode: 0o700 })
            await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
            const row = (extra: Record<string, string> = {}) => `${JSON.stringify({ id: 'c1', name: 'synthetic-api-1', state: 'running', labels: {
                ...labels, 'com.docker.compose.project': composeProject, 'com.docker.compose.project.working_dir': '/synthetic/checkout', ...extra } })}\n`
            await writeFile(join(root, 'machine.ls'), row())
            const steps: ExecutionStep[] = []
            const input = { executable: { canonicalPath: script, invocationPath: script, sha256: sha(bytes), executionMode: 'verified-path' as const },
                cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000, context: dockerContext }
            const discovery = await discoverMachineStacks(input, async (step) => { steps.push(step); return executeProbe(step) })
            // `container ls`, `network ls` and `volume ls` all print machine.ls here; each is attributed by its own kind.
            expect(discovery?.resources.map(({ kind, cockpitId: owner, stackId: stack, running, workingDir }) => ({ kind, owner, stack, running, workingDir })))
                .toEqual(['container', 'network', 'volume'].map((kind) => ({ kind, owner: cockpitId, stack: stackId,
                    running: kind === 'container', workingDir: kind === 'container' ? '/synthetic/checkout' : null })))
            for (const kind of ['container', 'network', 'volume']) {
                const listing = steps.find(({ id }) => id === `stacks:discover:${kind}`)!
                expect(listing.argv.slice(1, 3)).toEqual(['--host', dockerEndpoint])
                expect(listing.argv.slice(-4, -2)).toEqual(['--filter', 'label=dev.b0dea.cockpit.stack-id'])
            }
            await writeFile(join(root, 'machine.ls'), row({ 'com.example.unexpected': 'x' }))
            expect(await discoverMachineStacks(input, executeProbe)).toBeUndefined()
            await writeFile(join(root, 'machine.ls'), '{"id": "c1"\n')
            expect(await discoverMachineStacks(input, executeProbe)).toBeUndefined()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('refuses malformed network inspection output', async () => {
        const root = await canonicalTemp('cockpit-network-malformed-')
        try {
            await expect(authenticatedDiscovery(root, [
                resource({ id: 'network-orphan', name: 'owned-orphan', kind: 'network', bytes: null }),
            ], {
                networkInspection: (candidate) => ({ id: candidate.id, members: ['container-own'] }),
            })).rejects.toThrow('discovery unavailable')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('discovers only while the context names the same local endpoint before, between and after the listings', async () => {
        const root = await canonicalTemp('cockpit-selection-')
        const selection = (context: string, endpoint: string) => writeFile(join(root, 'selection.context'), `${JSON.stringify({ context, endpoint })}\n`)
        try {
            const observed = await authenticatedDiscovery(root, [resource()])
            expect(observed.selection).toEqual({ context: dockerContext, endpoint: dockerEndpoint })
            // Every other selection read reports another daemon, so no round sees one endpoint throughout.
            let reads = 0
            const rebinding = async (step: ExecutionStep) => {
                if (step.id === 'runtime:select:context') {
                    reads += 1
                    await selection(dockerContext, reads % 2 === 0 ? 'unix:///tmp/rebound.sock' : dockerEndpoint)
                }
                return executeProbe(step)
            }
            await expect(authenticatedDiscovery(root, [resource()], { execute: rebinding })).rejects.toThrow('discovery unavailable')
            expect(reads).toBe(4)
            for (const [context, endpoint] of [
                ['changed-context', dockerEndpoint], [dockerContext, 'tcp://127.0.0.1:2375'], [dockerContext, 'ssh://synthetic.invalid'],
                [dockerContext, 'npipe:////./pipe/docker_engine'], [dockerContext, 'unix:///tmp/docker.sock\0'],
            ] as const) {
                const fixed = async (step: ExecutionStep) => {
                    if (step.id === 'runtime:select:context') await selection(context, endpoint)
                    return executeProbe(step)
                }
                await expect(authenticatedDiscovery(root, [resource()], { execute: fixed }), JSON.stringify(endpoint)).rejects.toThrow('discovery unavailable')
            }
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it.each([
        ['a remote DOCKER_HOST', { env: { PATH: '/usr/bin', DOCKER_HOST: 'tcp://elsewhere:2375' }, context: dockerContext }],
        ['a Windows pipe on a POSIX host', { env: { PATH: '/usr/bin' }, context: 'default', host: 'npipe:////./pipe/dockerDesktopLinuxEngine' }],
    ] as const)('refuses %s before any Docker step runs', async (_name, variant) => {
        const execute = vi.fn(executeProbe)
        expect(await discoverReclaim({
            executable: { ...executable('/tmp/docker'), executionMode: 'verified-path' }, cwd: '/tmp',
            stackId, cockpitId, timeoutMs: 1_000, ...variant,
        }, execute)).toBeUndefined()
        expect(execute).not.toHaveBeenCalled()
    })

    it.each([
        'unix:///tmp/synthetic-rootless.sock',
    ])('selects the exact local DOCKER_HOST %s through the default context', async (host) => {
        const root = await canonicalTemp('cockpit-selection-host-')
        try {
            const script = join(root, 'docker')
            const bytes = Buffer.from(fakeDocker)
            await writeFile(script, bytes, { mode: 0o700 })
            for (const kind of ['container', 'network', 'volume', 'image', 'build-cache']) await writeDockerRows(root, kind, [])
            await writeNetworkHolders(root, {})
            const runtime = { canonicalPath: script, invocationPath: script, sha256: sha(bytes.toString()), executionMode: 'verified-path' as const }
            const discover = async (context: string, requested: string, reported = requested) => {
                await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: 'default', endpoint: reported })}\n`)
                const steps: ExecutionStep[] = []
                const discovered = await discoverReclaim({
                    executable: runtime, cwd: root, env: { PATH: '/usr/bin:/bin' }, stackId, cockpitId, timeoutMs: 5_000, context, host: requested,
                }, async (step) => { steps.push(step); return executeProbe(step) })
                return { discovered, steps }
            }
            const admitted = await discover('default', host)
            expect(admitted.discovered).toEqual(expect.objectContaining({ selection: { context: 'default', endpoint: host } }))
            const selections = admitted.steps.filter(({ id }) => id === 'runtime:select:context')
            expect(selections.every((step) => step.env.DOCKER_HOST === host)).toBe(true)
            const daemonSteps = admitted.steps.filter(({ id }) => id !== 'runtime:select:context')
            expect(daemonSteps.length).toBeGreaterThan(0)
            expect(daemonSteps.every((step) => step.argv[1] === '--host' && step.argv[2] === host && step.env.DOCKER_HOST === undefined)).toBe(true)
            expect((await discover(dockerContext, host)).discovered).toBeUndefined()
            expect((await discover('default', 'tcp://elsewhere:2375')).discovered).toBeUndefined()
            expect((await discover('default', host, 'unix:///tmp/rebound.sock')).discovered).toBeUndefined()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('admits the decimal human sizes Docker prints', async () => {
        const root = await canonicalTemp('cockpit-discovery-sizes-')
        try {
            // 1.029 * 1e9 is 1028999999.9999999 in floating point; real daemons print sizes like this.
            const observed = await authenticatedDiscovery(root, [
                resource({ id: 'sha256:sized-image', name: 'synthetic-image', kind: 'image', bytes: 1_029_000_000 }),
                resource({ id: 'sized-cache', name: 'sized-cache', kind: 'build-cache', labels: {}, bytes: 1_213_000 }),
            ], { displayedBytes: { 'sha256:sized-image': '1.029GB', 'sized-cache': '1.213MB' } })
            expect(Object.fromEntries(observed.resources.map(({ id, bytes }) => [id, bytes]))).toEqual({
                'sha256:sized-image': 1_029_000_000, 'sized-cache': 1_213_000,
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('inspects each resource type in chunks of 64 rather than one Docker client per resource', async () => {
        const root = await canonicalTemp('cockpit-discovery-chunks-')
        try {
            const volumes = Array.from({ length: 130 }, (_, index) => resource({
                id: `volume-${String(index).padStart(3, '0')}`, name: `volume-${String(index).padStart(3, '0')}`, kind: 'volume', bytes: null,
            }))
            // Volumes are listed whole so a reset sees a foreign volume under a declared name, but
            // only this stack's volumes are inspected.
            const foreignVolumes = Array.from({ length: 70 }, (_, index) => resource({
                id: `foreign-${index}`, name: `foreign-${index}`, kind: 'volume', labels: {}, bytes: null,
            }))
            const images = Array.from({ length: 65 }, (_, index) => resource({
                id: `sha256:${String(index).padStart(64, '0')}`, name: `image-${index}`, kind: 'image', bytes: 1,
            }))
            const observed = await authenticatedDiscovery(root, [...volumes, ...foreignVolumes, ...images])

            expect(observed.resources.filter(({ kind }) => kind === 'volume')).toHaveLength(200)
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
            const volumes = ['kept-a', 'vanished', 'kept-b'].map((name) => resource({ id: name, name, kind: 'volume', bytes: null }))
            const vanish = async (step: ExecutionStep) => {
                // Docker prints the surviving objects, reports the missing one on stderr and exits nonzero.
                if (step.labels.resourceKind === 'volume-inspection') await rm(join(root, 'inspect.vanished'), { force: true })
                return executeProbe(step)
            }

            await expect(authenticatedDiscovery(root, volumes, { execute: vanish })).rejects.toThrow('discovery unavailable')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('preserves absent ownership labels beside a malformed control', async () => {
        const root = await canonicalTemp('cockpit-discovery-labels-')
        try {
            const observed = await authenticatedDiscovery(root, [
                resource({ id: 'unlabelled', name: 'unlabelled', kind: 'volume', labels: {}, bytes: null }),
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

    it('refuses a declared volume whose Compose name an unlabelled volume holds', async () => {
        const root = await canonicalTemp('cockpit-reset-unowned-name-')
        try {
            // Compose adopts an existing volume of the name it would create, labels or not.
            const observed = await authenticatedDiscovery(root, [
                resource({ id: `${composeProject}_session-data`, name: `${composeProject}_session-data`, kind: 'volume', labels: {}, bytes: null }),
            ])
            expect(await planReset(resetInput(root, { generatedHostPaths: [], discovery: observed }))).toEqual(expect.objectContaining({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'RECLAIM_ACCOUNTING_MISMATCH' })],
            }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('targets a declared volume by its Compose key within the stack\'s project, not by Docker\'s volume name', async () => {
        const root = await canonicalTemp('cockpit-reset-compose-key-')
        try {
            const otherProject = 'synthetic-ba9876543210'
            const plan = await planReset(resetInput(root, { resettableVolumes: ['data'], generatedHostPaths: [], discovery: await authenticatedDiscovery(root, [
                resource({ id: `${composeProject}_data`, name: `${composeProject}_data`, kind: 'volume', dataBearing: true,
                    labels: { ...labels, ...composeLabels('data') }, generation: sha('volume-generation') }),
                // The same key in another checkout's project, and a volume named exactly as declared.
                resource({ id: `${otherProject}_data`, name: `${otherProject}_data`, kind: 'volume', dataBearing: true,
                    labels: { ...labels, 'dev.b0dea.cockpit.stack-id': foreignStackId, 'com.docker.compose.project': otherProject, 'com.docker.compose.volume': 'data' } }),
                resource({ id: 'data', name: 'data', kind: 'volume', labels: {}, bytes: null }),
            ]) }))
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            expect(plan.noop).toBe(false)
            expect(plan.targets.map(({ kind, identity, declaration }) => ({ kind, identity, declaration }))).toEqual([
                { kind: 'volume', identity: `${composeProject}_data`, declaration: 'data' },
            ])
            expect(plan.removals.map(({ step }) => step.argv.slice(3))).toEqual([['volume', 'rm', '--', `${composeProject}_data`]])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('resets a declared volume an earlier configuration of this stack created', async () => {
        const root = await canonicalTemp('cockpit-reset-earlier-config-')
        try {
            // Compose keeps a data volume across cockpit.toml edits and `up` goes on using it.
            const earlier = { ...labels, 'dev.b0dea.cockpit.config-sha256': sha('earlier'), ...composeLabels('session-data') }
            const plan = await planReset(resetInput(root, { generatedHostPaths: [], discovery: await authenticatedDiscovery(root, [
                resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, labels: earlier, generation: sha('earlier-generation') }),
            ]) }))
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            expect(plan.targets.map(({ kind, identity }) => ({ kind, identity }))).toEqual([{ kind: 'volume', identity: 'session-data' }])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('refuses to plan a reset from a discovery of another stack', async () => {
        const root = await canonicalTemp('cockpit-reset-other-stack-')
        try {
            const declared = { resettableVolumes: [], generatedHostPaths: [] }
            // A discovery lists only its own stack's resources, so another stack's would make this
            // one look empty and every target absent.
            expect(await planReset(resetInput(root, { ...declared, discovery: await authenticatedDiscovery(root, [], { discoveryStackId: foreignStackId }) })))
                .toEqual(expect.objectContaining({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'RECLAIM_ACCOUNTING_MISMATCH' })] }))
            expect(await planReset(resetInput(root, { ...declared, discovery: await authenticatedDiscovery(root, []) })))
                .toEqual(expect.objectContaining({ kind: 'complete' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('lists both declared target classes and removes the stack\'s own containers first, each by id', async () => {
        const root = await canonicalTemp('cockpit-reset-')
        try {
            await mkdir(join(root, 'generated', 'session'), { recursive: true })
            // The stack's own stopped container still references its volume, and Docker refuses
            // to remove a referenced volume, so reset removes that container first. A container
            // another stack owns is never a reset target.
            const plan = await planReset(resetInput(root, { discovery: await authenticatedDiscovery(root, [
                resource({ id: 'container-1', name: 'synthetic-api-1' }),
                resource({ id: 'container-2', name: 'other-api-1', labels: { ...labels, 'dev.b0dea.cockpit.stack-id': `stack:${sha('other stack')}` } }),
                resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') }),
            ]) }))
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            expect(plan.targets.map(({ kind, identity, declaration }) => ({ kind, identity, declaration }))).toEqual([
                { kind: 'container', identity: 'container-1', declaration: 'synthetic-api-1' },
                { kind: 'host-path', identity: join(root, 'generated', 'session'), declaration: 'generated/session' },
                { kind: 'volume', identity: 'session-data', declaration: 'session-data' },
            ])
            expect(plan.removals.map(({ step }) => step.argv.slice(step.argv[0] === removalCanonicalPath ? 1 : 3))).toEqual([
                ['container', 'rm', '--force', '--', 'container-1'],
                ['-rf', '--', join(root, 'generated', 'session')],
                ['volume', 'rm', '--', 'session-data'],
            ])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('returns an explicit no-op when no target is declared', async () => {
        const root = await canonicalTemp('cockpit-reset-empty-')
        try {
            const result = await planReset(resetInput(root, {
                resettableVolumes: [], generatedHostPaths: [], discovery: await authenticatedDiscovery(root, []),
            }))
            expect(result).toEqual(expect.objectContaining({ kind: 'complete', noop: true, targets: [], removals: [] }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('refuses while another session holds the stack', async () => {
        const root = await canonicalTemp('cockpit-reset-co-tenant-')
        try {
            const discovery = await authenticatedDiscovery(root, [])
            const coTenantRecord = { ...stateRecord(), value: {
                holders: [{ holderId: `holder:${sha('holder')}:session`, checkoutId: `checkout:${sha('checkout')}`, claimedAt: '2026-09-08T00:00:00.000Z' }],
                lease: { offset: 0, ports: { WEB: 4100 }, released: false, declaration: { step: 100, count: 1, bases: { WEB: 4100 } } },
                lastReleasedHolder: null,
            } }
            expect(await planReset(resetInput(root, { generatedHostPaths: [], discovery, coordinationRecord: coTenantRecord })))
                .toEqual({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'RESET_CO_TENANT' })] })
            expect(await planReset(resetInput(root, { generatedHostPaths: [], discovery })))
                .toEqual(expect.objectContaining({ kind: 'complete' }))
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('gives the same targets read twice one digest, and a replaced volume or host path another', async () => {
        const root = await canonicalTemp('cockpit-reset-digest-')
        const target = join(root, 'generated', 'session')
        try {
            await mkdir(target, { recursive: true })
            const volume = resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true, generation: sha('volume-generation') })
            const digest = async (resources: readonly ReclaimResource[]) => {
                const plan = await planReset(resetInput(root, { discovery: await authenticatedDiscovery(root, resources) }))
                if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
                return plan.digest
            }
            const approved = await digest([volume])
            expect(await digest([volume])).toBe(approved)
            expect(await digest([{ ...volume, generation: sha('replacement-generation') }])).not.toBe(approved)
            await rm(target, { recursive: true })
            expect(await digest([volume])).not.toBe(approved)
            await mkdir(target)
            expect(await digest([volume])).toBe(approved)
            await rm(target, { recursive: true })
            await writeFile(target, 'replaced by a file')
            expect(await digest([volume])).not.toBe(approved)
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

    // The read after the removals decides what is gone, so a resource something else removed first
    // does not stop the rest.
    it('treats a resource Docker no longer has as removed, and stops at any other failure', async () => {
        const target = (id: string) => ({ kind: 'container', id, name: id, step: { id: `remove:${id}` } }) as never
        const failed = (stderr: string) => ({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED', stderr: Buffer.from(stderr) }) as never
        const ran: string[] = []
        expect(await removeTargets([target('a'), target('b')], async (step) => {
            ran.push(step.id)
            return step.id === 'remove:a' ? failed('Error response from daemon: No such container: a\n') : { kind: 'complete' } as never
        })).toBeUndefined()
        expect(ran).toEqual(['remove:a', 'remove:b'])
        expect(await removeTargets([target('c')], async () => failed('Error response from daemon: conflict: unable to remove\n')))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'RECLAIM_ACCOUNTING_MISMATCH' }] })
    })

    it('preserves non-ASCII target bytes through the plan and its exact removal', async () => {
        const root = await canonicalTemp('cockpit-reset-encoding-')
        const target = join(root, 'generated', 'sessión-東京')
        try {
            await mkdir(target, { recursive: true })
            const plan = await planReset(resetInput(root, {
                resettableVolumes: [],
                generatedHostPaths: [{ root, path: target, declaration: 'generated/sessión-東京' }],
                discovery: await authenticatedDiscovery(root, []),
            }))
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            expect(plan.targets).toEqual([expect.objectContaining({ identity: target })])
            expect(plan.removals[0]?.step.argv.slice(1)).toEqual(['-rf', '--', target])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

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
})
