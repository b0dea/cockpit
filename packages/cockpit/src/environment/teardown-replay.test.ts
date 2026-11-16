import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import type { CockpitId, StackId } from './contract.js'
import {
    discoverReclaim,
    planTeardown,
    type ReclaimDiscovery,
    type ReclaimResource,
} from './reclaim.js'
import type { StateRecord } from './state.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const cockpitId = `cockpit:synthetic:${sha('cockpit')}` as CockpitId
const stackId = `stack:${sha('stack')}` as StackId
const configSha256 = sha('config')
const dockerContext = 'synthetic-context'
const dockerEndpoint = 'unix:///tmp/synthetic-docker.sock'
const labels = {
    'dev.b0dea.cockpit.stack-id': stackId,
    'dev.b0dea.cockpit.config-sha256': configSha256,
    'dev.b0dea.cockpit.owner-id': cockpitId,
}
const coordinationRecords = new Map<string, StateRecord>()
const coordinationRecord = (root: string): StateRecord => {
    const existing = coordinationRecords.get(root)
    if (existing !== undefined) return existing
    const record: StateRecord = {
        format: 'cockpit-state/v1', kind: 'coordination', cockpitId, subjectId: stackId,
        revision: 4, updatedAt: new Date().toISOString(),
        value: { holders: [], lease: null, lastReleasedHolder: null },
    }
    coordinationRecords.set(root, record)
    return record
}
const resource = (overrides: Partial<ReclaimResource>): ReclaimResource => ({
    id: 'container-1', name: 'container-1', kind: 'container', labels, referenced: false, bytes: 10, ...overrides,
})
const discovery = (resources: readonly ReclaimResource[]): ReclaimDiscovery => ({
    observedAt: '2026-09-08T00:00:01.000Z', producer: 'runtime-resource-discovery', resources,
    startedAt: '2026-09-08T00:00:00.000Z', stackId, selection: { context: dockerContext, endpoint: dockerEndpoint },
})
const dockerRow = ({ id, name, kind, labels: itemLabels, referenced, bytes }: ReclaimResource) => kind === 'build-cache'
    ? { ID: id, Reclaimable: !referenced, Size: bytes === null ? null : String(bytes) }
    : {
          id: kind === 'volume' ? name : id, name,
          labels: kind === 'image' ? {} : Object.fromEntries(Object.keys(labels).map((key) => [key, itemLabels[key] ?? ''])),
          referenced: false,
          bytes: kind === 'network' || kind === 'container' ? null : bytes,
      }
const executable = {
    canonicalPath: '/usr/local/bin/docker', invocationPath: '/usr/local/bin/docker', sha256: sha('docker'), executionMode: 'verified-path' as const,
}
const input = (resources: readonly ReclaimResource[], root = '/tmp/synthetic-cockpit') => ({
    stackId, cockpitId, configSha256, coordinationRecord: coordinationRecord(root), declaredCacheIds: [], discovery: discovery(resources),
    executable, cwd: '/tmp/synthetic-cockpit', env: { PATH: '/usr/bin' }, timeoutMs: 10_000,
})

const authenticatedInput = async (
    resources: readonly ReclaimResource[],
    existingRoot?: string,
    containerNetworks: Readonly<Record<string, readonly string[]>> = {},
) => {
    const root = existingRoot ?? await realpath(await mkdtemp(join(tmpdir(), 'cockpit-teardown-')))
    const groups = new Map<Exclude<ReclaimResource['kind'], 'cache'>, ReclaimResource[]>([
        ['container', []], ['network', []], ['volume', []], ['image', []], ['build-cache', []],
    ])
    for (const item of resources) {
        if (item.kind === 'cache') throw new Error('filesystem cache cannot enter Docker discovery')
        groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
    }
    for (const [kind, rows] of groups) {
        const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id))
        const output = (selected: readonly ReclaimResource[]) => `${selected.map((row) => JSON.stringify(dockerRow(row))).join('\n')}\n`
        // The daemon applies the stack-label filter, so the fake keeps the filtered answer beside the whole one.
        await writeFile(join(root, `docker.${kind}`), output(sorted))
        await writeFile(join(root, `docker.${kind}.owned`), output(sorted.filter((row) => row.labels['dev.b0dea.cockpit.stack-id'] === stackId)))
        if (kind === 'image') for (const row of rows) await writeFile(join(root, `inspect.${row.id}`), `${JSON.stringify({
            id: row.id, labels: Object.fromEntries(Object.keys(labels).map((key) => [key, row.labels[key] ?? ''])),
        })}\n`)
        if (kind === 'volume') for (const row of rows) await writeFile(join(root, `inspect.${row.name}`), `${JSON.stringify({
            name: row.name, generation: row.generation ?? '',
        })}\n`)
        // Network inspection prints attached endpoint ids; a referenced row stands for an endpoint
        // discovery did not see, which keeps the network.
        if (kind === 'network') for (const row of rows) await writeFile(join(root, `inspect.network.${row.id}`), `${JSON.stringify({
            id: row.id, members: row.referenced ? `endpoint-${row.id} ` : '',
        })}\n`)
    }
    // Every container attached to a network, whatever its labels, answers the network filter.
    const networkName = (networkId: string) => resources.find(({ kind, id }) => kind === 'network' && id === networkId)?.name ?? networkId
    await writeFile(join(root, 'docker.container.holders'), `${Object.entries(containerNetworks)
        .map(([id, networks]) => JSON.stringify({ id, networks: networks.map(networkName).join(',') })).join('\n')}\n`)
    await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
    const script = join(root, 'docker')
    // Inspection is chunked, so the fake answers every id of one call, as Docker does.
    const bytes = Buffer.from(`#!/bin/sh\nif [ "$1" = context ] && [ "$2" = inspect ]; then /bin/cat -- "$PWD/selection.context"; exit; fi\ncase "$1" in --host) shift 2;; *) exit 91;; esac\nkind="$1"\nif { [ "$kind" = image ] || [ "$kind" = volume ]; } && [ "$2" = inspect ]; then shift 4; for id do /bin/cat -- "$PWD/inspect.$id"; done; exit; fi\nif { [ "$kind" = network ] || [ "$kind" = container ]; } && [ "$2" = inspect ]; then shift 4; for id do /bin/cat -- "$PWD/inspect.$kind.$id"; done; exit; fi\nif [ "$kind" = builder ]; then shift; kind=build-cache; [ "$1" = prune ] && exit 0; fi\nsuffix=\nfor arg do case "$arg" in "label=dev.b0dea.cockpit.stack-id=${stackId}") suffix=.owned;; network=*) suffix=.holders;; esac; done\n/bin/cat -- "$PWD/docker.$kind$suffix"\n`)
    await writeFile(script, bytes, { mode: 0o700 })
    await chmod(script, 0o700)
    const docker = { canonicalPath: script, invocationPath: script, sha256: createHash('sha256').update(bytes).digest('hex'), executionMode: 'verified-path' as const }
    const combined = await discoverReclaim({
        executable: docker, cwd: root, env: { PATH: '/usr/bin:/bin' }, stackId, cockpitId, timeoutMs: 5_000, context: dockerContext,
    }, executeProbe)
    if (combined === undefined || 'diagnostics' in combined) throw new Error('discovery unavailable')
    const stateRoot = join(root, 'state')
    const cockpitRoot = join(stateRoot, 'cockpits', cockpitId.replaceAll(':', '_'))
    const path = join(cockpitRoot, 'records', 'coordination', `${stackId.replace(':', '_')}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(coordinationRecord(root))}\n`)
    const coordinationAddress = { path, stateRoot, cockpitRoot, kind: 'coordination' as const, cockpitId, subjectId: stackId }
    return { root, value: {
        ...input(combined.resources, root), discovery: combined, executable: docker, cwd: root,
        env: { PATH: '/usr/bin:/bin' }, coordinationAddress,
    } }
}

describe('teardown planning', () => {
    it('retains a network referenced only by persisted container configuration', async () => {
        const network = resource({ id: 'network-1', name: 'network-1', kind: 'network', referenced: false, bytes: null })
        // The stack's own containers no longer hold its network, since teardown removes them first;
        // another stack's container configuration still does.
        const container = resource({ id: 'container-1', labels: { ...labels, 'dev.b0dea.cockpit.stack-id': `stack:${sha('other stack')}` } })
        const authenticated = await authenticatedInput([network, container], undefined, { [container.id]: [network.id] })
        try {
            expect(authenticated.value.discovery.resources.find(({ id }) => id === network.id)?.referenced).toBe(true)
            const plan = planTeardown(authenticated.value)
            expect(plan).toEqual({ kind: 'complete', targets: [] })
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('plans the same removals whatever order discovery lists them: containers first, each named by id', async () => {
        const resources = [
            resource({ id: 'network-1', name: 'network-1', kind: 'network', bytes: 30 }),
            resource({ id: 'container-1', bytes: 10 }),
        ]
        const firstInput = await authenticatedInput(resources)
        const secondInput = await authenticatedInput([...resources].reverse(), firstInput.root)
        try {
            const first = planTeardown(firstInput.value)
            const second = planTeardown(secondInput.value)
            if (first.kind !== 'complete' || second.kind !== 'complete') throw new Error(JSON.stringify([first, second]))
            expect(JSON.stringify(first)).toBe(JSON.stringify(second))
            expect(first.targets.map(({ step }) => step.argv.slice(3))).toEqual([
                ['container', 'rm', '--force', '--', 'container-1'],
                ['network', 'rm', '--', 'network-1'],
            ])
        } finally { await rm(firstInput.root, { recursive: true, force: true }); await rm(secondInput.root, { recursive: true, force: true }) }
    })

    it('removes nothing of another stack and none of its own data', async () => {
        const foreign = resource({ id: 'foreign', labels: { ...labels, 'dev.b0dea.cockpit.stack-id': `stack:${sha('foreign')}` } })
        const relabelled = resource({ id: 'relabelled', labels: { ...labels, 'dev.b0dea.cockpit.owner-id': `cockpit:other:${sha('other')}` } })
        const data = resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true })
        const authenticated = await authenticatedInput([foreign, relabelled, data])
        try {
            expect(planTeardown(authenticated.value)).toEqual({ kind: 'complete', targets: [] })
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('uses authenticated inspection to remove a current-owned image under one name and keep one tagged under several', async () => {
        const dangling = resource({ id: `sha256:${sha('dangling')}`, name: '<none>', kind: 'image', referenced: false, bytes: 30 })
        const multiplyTagged = resource({ id: `sha256:${sha('multiply-tagged')}`, name: 'kept', kind: 'image', referenced: false, bytes: 40 })
        // The tag Compose gives an image it builds for this stack, which down removed nothing of.
        const built = resource({ id: `sha256:${sha('built')}`, name: 'synthetic-api', kind: 'image', referenced: false, bytes: 50 })
        const secondTag = { ...multiplyTagged, name: 'also-kept' }
        const initial = await authenticatedInput([dangling, multiplyTagged, secondTag, built])
        try {
            expect(initial.value.discovery.resources.filter(({ id }) => id === multiplyTagged.id)).toEqual([
                expect.objectContaining({ name: 'also-kept', referenced: true }),
            ])
            expect(initial.value.discovery.resources.find(({ id }) => id === built.id)?.referenced).toBe(false)
            const plan = planTeardown(initial.value)
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            expect(plan.targets.map(({ id }) => id).sort()).toEqual([built.id, dangling.id].sort())
        } finally { await rm(initial.root, { recursive: true, force: true }) }
    })

    it('removes a declared build cache on the daemon its discovery selected', async () => {
        const cacheId = 'abcdefghijklmnopqrstuvwxy'
        const initial = await authenticatedInput([
            resource({ id: cacheId, name: cacheId, kind: 'build-cache', referenced: false, bytes: 20 }),
        ])
        try {
            const plan = planTeardown({ ...initial.value, declaredCacheIds: [cacheId] })
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            expect(plan.targets.map(({ step }) => step.argv.slice(1))).toEqual([
                ['--host', dockerEndpoint, 'builder', 'prune', '--filter', `id=${cacheId}`, '--force'],
            ])
        } finally { await rm(initial.root, { recursive: true, force: true }) }
    })

    it('refuses unsafe opaque build-cache selectors', () => {
        for (const cacheId of ['', 'a'.repeat(65), 'cache-id', 'UPPERCASE']) {
            expect(planTeardown({ ...input([]), declaredCacheIds: [cacheId] })).toEqual(expect.objectContaining({ kind: 'refusal' }))
        }
    })
})
