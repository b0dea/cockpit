import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { type CheckoutId, type CockpitId, type HolderId, type StackId } from './contract.js'
import {
    coordinationStateRecord,
    commitDrainOutcome,
    recoverDrainReservation, reduceDrainOutcome, reserveDrain, reserveDrainAttempt,
} from './claims.js'
import {
    discoverReclaim,
    executeReclaimAction,
    planTeardown,
    type ReclaimDiscovery,
    type ReclaimResource,
} from './reclaim.js'
import { readState, selectStateRoot, transactState, type StateRecord } from './state.js'

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
const removalCanonicalPath = await realpath('/bin/rm')
const removalSha256 = createHash('sha256').update(await readFile(removalCanonicalPath)).digest('hex')
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

describe('teardown replay', () => {
    it('retains a network referenced only by persisted container configuration', async () => {
        const network = resource({ id: 'network-1', name: 'network-1', kind: 'network', referenced: false, bytes: null })
        // The stack's own containers no longer hold its network, since teardown removes them first;
        // another stack's container configuration still does.
        const container = resource({ id: 'container-1', labels: { ...labels, 'dev.b0dea.cockpit.stack-id': `stack:${sha('other stack')}` } })
        const authenticated = await authenticatedInput([network, container], undefined, { [container.id]: [network.id] })
        try {
            expect(authenticated.value.discovery.resources.find(({ id }) => id === network.id)?.referenced).toBe(true)
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('is byte-identical across discovery order and acts only on the accepted snapshot', async () => {
        const resources = [
            resource({ id: 'network-1', name: 'network-1', kind: 'network', bytes: 30 }),
            resource({ id: 'container-1', bytes: 10 }),
        ]
        const firstInput = await authenticatedInput(resources)
        const secondInput = await authenticatedInput([...resources].reverse(), firstInput.root)
        try {
            const first = await planTeardown(firstInput.value)
            const second = await planTeardown(secondInput.value)
            if (first.kind !== 'complete' || second.kind !== 'complete') throw new Error(JSON.stringify([first, second]))
            // The consent carries when its discovery finished; everything planned from the resources is identical.
            const planned = (plan: typeof first) => JSON.stringify({ ...plan, consent: plan.consent?.digest })
            expect(Buffer.from(planned(first))).toEqual(Buffer.from(planned(second)))
            expect(first).toEqual(expect.objectContaining({ kind: 'complete', remaining: 2, action: null }))
            // The preview's own discovery is the state the consent was given on, not the state now.
            expect(await planTeardown({
                ...firstInput.value, expectedDiscoveryDigest: first.discoveryDigest, consent: first.consent ?? undefined,
            })).toEqual(expect.objectContaining({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'RECLAIM_ACCOUNTING_MISMATCH' })] }))
            const fresh = await authenticatedInput(resources, firstInput.root)
            try {
                const action = await planTeardown({ ...fresh.value, expectedDiscoveryDigest: first.discoveryDigest, consent: first.consent ?? undefined })
                expect(action).toEqual(expect.objectContaining({ kind: 'complete', remaining: 1 }))
                if (action.kind !== 'complete') throw new Error(JSON.stringify(action))
                expect(action.action?.step?.argv.slice(3)).toEqual(['container', 'rm', '--force', '--', 'container-1'])
                // A continuation of a drain no attempt ran is refused rather than ignored; the same
                // request without it is the control that proceeded.
                expect(await planTeardown({
                    ...fresh.value, expectedDiscoveryDigest: first.discoveryDigest, consent: first.consent ?? undefined,
                    continuation: action.action!.continuation,
                })).toEqual({ kind: 'refusal', diagnostics: [expect.objectContaining({
                    code: 'RECLAIM_ACCOUNTING_MISMATCH', message: 'teardown continuation no longer matches the remaining consented resources',
                })] })
            } finally { await rm(fresh.root, { recursive: true, force: true }) }
        } finally { await rm(firstInput.root, { recursive: true, force: true }); await rm(secondInput.root, { recursive: true, force: true }) }
    })

    it('leaves a foreign control and all data-bearing resources without executable actions', async () => {
        const foreign = resource({ id: 'foreign', labels: { ...labels, 'dev.b0dea.cockpit.stack-id': `stack:${sha('foreign')}` } })
        const data = resource({ id: 'volume-1', name: 'session-data', kind: 'volume', dataBearing: true })
        const authenticated = await authenticatedInput([foreign, data])
        try {
            const result = await planTeardown(authenticated.value)
            expect(result).toEqual(expect.objectContaining({ kind: 'complete', noop: true }))
            if (result.kind !== 'complete') return
            expect(result.remaining).toBe(0)
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('reports byte classes separately and never converts unknown bytes to zero', async () => {
        const buildCacheId = 'abcdefghijklmnopqrstuvwxy'
        const authenticated = await authenticatedInput([
            resource({ id: 'orphan', bytes: 12 }),
            resource({ id: 'image', name: 'image', kind: 'image', bytes: null }),
            resource({ id: buildCacheId, name: buildCacheId, kind: 'build-cache', bytes: 40 }),
            resource({ id: 'stale-network', name: 'stale-network', kind: 'network', labels: { ...labels, 'dev.b0dea.cockpit.config-sha256': sha('stale') }, bytes: 8 }),
        ])
        try {
            const result = await planTeardown({ ...authenticated.value, declaredCacheIds: [buildCacheId] })
            expect(result.kind).toBe('complete')
            if (result.kind !== 'complete') return
            // Containers are listed without `--size`, so their bytes stay unknown rather than zero;
            // the image and the network an earlier configuration started are reclaimable, their bytes unknown too.
            expect(result.byteAccounting).toEqual({
                observed: { orphans: null, images: null, buildCache: 40, staleNetworks: null },
                reclaimable: { orphans: null, images: null, buildCache: 40, staleNetworks: null },
                action: null,
                actuallyReclaimed: null,
            })
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
            const preview = await planTeardown(initial.value)
            expect(preview).toEqual(expect.objectContaining({ kind: 'complete', remaining: 2 }))
            if (preview.kind !== 'complete') return
            const fresh = await authenticatedInput([dangling, multiplyTagged, secondTag, built], initial.root)
            const action = await planTeardown({
                ...fresh.value, expectedDiscoveryDigest: preview.discoveryDigest, consent: preview.consent ?? undefined,
            })
            expect(action).toEqual(expect.objectContaining({ kind: 'complete', remaining: 1 }))
            if (action.kind === 'complete') expect(action).toEqual(expect.objectContaining({ action: expect.objectContaining({ step: expect.any(Object) }) }))
        } finally { await rm(initial.root, { recursive: true, force: true }) }
    })

    it('stops on disappearance or relabelling instead of widening selection', async () => {
        const initial = await authenticatedInput([resource({ id: 'container-1' })])
        const disappeared = await authenticatedInput([])
        const relabelled = await authenticatedInput([resource({ id: 'container-1', labels: { ...labels, 'dev.b0dea.cockpit.owner-id': `cockpit:other:${sha('other')}` } })])
        try {
            const preview = await planTeardown(initial.value)
            expect(preview.kind).toBe('complete')
            if (preview.kind !== 'complete') return
            expect(await planTeardown({ ...disappeared.value, expectedDiscoveryDigest: preview.discoveryDigest })).toEqual(expect.objectContaining({ kind: 'refusal' }))
            expect(await planTeardown({ ...relabelled.value, expectedDiscoveryDigest: preview.discoveryDigest })).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally {
            await rm(initial.root, { recursive: true, force: true })
            await rm(disappeared.root, { recursive: true, force: true })
            await rm(relabelled.root, { recursive: true, force: true })
        }
    })

    it('returns a no-op with no destructive argv for empty discovery', async () => {
        const authenticated = await authenticatedInput([])
        try {
            expect(await planTeardown(authenticated.value)).toEqual(expect.objectContaining({ kind: 'complete', noop: true }))
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('refuses byte totals that overflow exact integer accounting', async () => {
        const authenticated = await authenticatedInput([
            resource({ id: 'large', name: 'large', kind: 'image', bytes: Number.MAX_SAFE_INTEGER }),
            resource({ id: 'one-more', name: 'one-more', kind: 'image', bytes: 1 }),
        ])
        try {
            expect(await planTeardown(authenticated.value)).toEqual(expect.objectContaining({ kind: 'refusal' }))
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('binds build-cache action and reconciliation to the immutable daemon endpoint', async () => {
        const cacheId = 'abcdefghijklmnopqrstuvwxy'
        const initial = await authenticatedInput([
            resource({ id: cacheId, name: cacheId, kind: 'build-cache', referenced: false, bytes: 20 }),
        ])
        try {
            const preview = await planTeardown({ ...initial.value, declaredCacheIds: [cacheId] })
            expect(preview.kind).toBe('complete')
            if (preview.kind !== 'complete') return
            const fresh = await authenticatedInput(initial.value.discovery.resources, initial.root)
            await writeFile(join(initial.root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: 'unix:///tmp/rebound.sock' })}\n`)
            const action = await planTeardown({
                ...fresh.value, declaredCacheIds: [cacheId], expectedDiscoveryDigest: preview.discoveryDigest,
                consent: preview.consent ?? undefined,
            })
            expect(action).toEqual(expect.objectContaining({ kind: 'complete', remaining: 0, action: expect.objectContaining({ step: expect.any(Object) }) }))
            await writeFile(join(initial.root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: 'unix:///tmp/another.sock' })}\n`)
        } finally { await rm(initial.root, { recursive: true, force: true }) }
    })

    it('refuses unsafe opaque build-cache selectors', async () => {
        for (const cacheId of ['', 'a'.repeat(65), 'cache-id', 'UPPERCASE']) {
            await expect(planTeardown({
                ...input([]), declaredCacheIds: [cacheId],
            })).resolves.toEqual(expect.objectContaining({ kind: 'refusal' }))
        }
    })

    it('reclaims one exact confined dependency-cache directory', async () => {
        const authenticated = await authenticatedInput([])
        const cacheId = sha('dependency-cache')
        const cacheRoot = join(authenticated.root, 'dependency-cache')
        const cachePath = join(cacheRoot, cacheId)
        try {
            await mkdir(cachePath, { recursive: true })
            const request = {
                ...authenticated.value,
                declaredCacheIds: [cacheId],
                dependencyCaches: [{ cacheId, root: cacheRoot, path: cachePath }],
                pathExecutable: {
                    canonicalPath: removalCanonicalPath, invocationPath: '/bin/rm', sha256: removalSha256, executionMode: 'verified-path' as const,
                },
            }
            const preview = await planTeardown(request)
            expect(preview).toEqual(expect.objectContaining({ kind: 'complete', remaining: 1 }))
            if (preview.kind !== 'complete') return
            const fresh = await authenticatedInput([], authenticated.root)
            const action = await planTeardown({
                ...request, discovery: fresh.value.discovery, executable: fresh.value.executable,
                expectedDiscoveryDigest: preview.discoveryDigest, consent: preview.consent ?? undefined,
            })
            expect(action).toEqual(expect.objectContaining({ kind: 'complete', remaining: 0 }))
            if (action.kind === 'complete') expect(action).toEqual(expect.objectContaining({ action: expect.objectContaining({ step: expect.any(Object) }) }))
            expect((await lstat(cachePath)).isDirectory()).toBe(true)
        } finally { await rm(authenticated.root, { recursive: true, force: true }) }
    })

    it('removes a dependency cache only while its original inode remains', async () => {
        const setup = async () => {
            const authenticated = await authenticatedInput([])
            const holderId = `holder:${sha(`holder-${authenticated.root}`)}:session` as HolderId
            const checkoutId = `checkout:${sha(`checkout-${authenticated.root}`)}` as CheckoutId
            const namespace = await selectStateRoot({ platform: 'linux', home: authenticated.root, cockpitId })
            if (namespace.kind !== 'complete') throw new Error('state namespace unavailable')
            const seeded = await transactState(namespace.value, namespace.value.paths.coordination(stackId), { ownerId: holderId }, () => ({
                format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId, subjectId: stackId,
                revision: 0, updatedAt: new Date().toISOString(), value: {
                    holders: [{ holderId, checkoutId, claimedAt: new Date().toISOString() }],
                    lease: { offset: 0, ports: { WEB: 3000 }, released: false,
                        declaration: { step: 100, count: 1, bases: { WEB: 3000 } } },
                    lastReleasedHolder: null, drain: null,
                },
            }))
            if (seeded.kind !== 'complete') throw new Error('coordination fixture unavailable')
            const cacheId = sha(`dependency-cache-${authenticated.root}`)
            const cacheRoot = join(authenticated.root, 'dependency-cache')
            const cachePath = join(cacheRoot, cacheId)
            await mkdir(cachePath, { recursive: true })
            const request = {
                ...authenticated.value,
                coordinationRecord: seeded.value,
                declaredCacheIds: [cacheId],
                dependencyCaches: [{ cacheId, root: cacheRoot, path: cachePath }],
                pathExecutable: {
                    canonicalPath: removalCanonicalPath, invocationPath: '/bin/rm', sha256: removalSha256, executionMode: 'verified-path' as const,
                },
            }
            const preview = await planTeardown(request)
            if (preview.kind !== 'complete') throw new Error('cache preview unavailable')
            const fresh = await authenticatedInput([], authenticated.root)
            const action = await planTeardown({
                ...request, discovery: fresh.value.discovery, executable: fresh.value.executable,
                expectedDiscoveryDigest: preview.discoveryDigest, consent: preview.consent ?? undefined,
                coordinationAddress: namespace.value.paths.coordination(stackId),
            })
            if (action.kind !== 'complete' || action.action === null) throw new Error('cache action unavailable')
            const targetId = `cache:${cacheId}`
            const commitment = preview.envelope.commitments.find((candidate) => candidate.targetId === targetId)
            if (!commitment) throw new Error('cache target commitment unavailable')
            const { targetId: committedTargetId, ...targetCommitment } = commitment
            const drainRequest = {
                purpose: 'down' as const, stackId, holderId, requesterId: holderId, configSha256,
                planDigest: preview.discoveryDigest, operationBasis: sha(`teardown-basis-${authenticated.root}`),
                generation: sha(`teardown-generation-${authenticated.root}`), targetIds: [stackId, targetId].sort(),
                actions: [
                    { stage: 'runtime-stop' as const, targetId: stackId, validForMs: 30_000 },
                    { stage: 'reclaim' as const, targetId: committedTargetId, validForMs: 30_000, targetCommitment },
                ], expectedCoordinationRevision: 0,
            }
            const reserved = await reserveDrain({ namespace: namespace.value, request: drainRequest })
            if (reserved.kind !== 'complete') throw new Error('drain reservation unavailable')
            const runtimeAttempt = await reserveDrainAttempt({ namespace: namespace.value, reservation: reserved.reservation })
            if (runtimeAttempt.kind !== 'complete') throw new Error('runtime attempt unavailable')
            const success = { kind: 'success' as const, reservation: runtimeAttempt.reservation, fact: {
                purpose: drainRequest.purpose, stackId, configSha256, planDigest: runtimeAttempt.reservation.planDigest,
                operationBasis: runtimeAttempt.reservation.operationBasis,
                coordinationRevision: runtimeAttempt.reservation.coordinationRevision,
                reservationId: runtimeAttempt.reservation.reservationId, reservedAt: runtimeAttempt.reservation.reservedAt,
                generation: runtimeAttempt.reservation.generation, attemptId: runtimeAttempt.attempt.attemptId,
                attemptRevision: runtimeAttempt.attempt.committedRevision, attemptCommittedAt: runtimeAttempt.attempt.committedAt,
                validThrough: runtimeAttempt.attempt.validThrough, actionIndex: runtimeAttempt.attempt.actionIndex,
                currentTarget: runtimeAttempt.attempt.currentTarget, currentStage: runtimeAttempt.attempt.currentStage,
                observedAt: runtimeAttempt.attempt.committedAt,
            } }
            const active = await readState(namespace.value.paths.coordination(stackId))
            if (active.kind !== 'complete') throw new Error('active drain unavailable')
            const progress = reduceDrainOutcome({ record: active.value, outcome: success })
            if (!progress) throw new Error('runtime progress unavailable')
            const committed = await commitDrainOutcome({
                outcome: success, namespace: namespace.value, stackId,
            })
            if (committed.kind !== 'complete') throw new Error('runtime progress commit unavailable')
            const recovered = await recoverDrainReservation({ namespace: namespace.value, request: drainRequest })
            if (recovered.kind !== 'complete') throw new Error('drain recovery unavailable')
            const reclaimAttempt = await reserveDrainAttempt({ namespace: namespace.value, reservation: recovered.reservation })
            if (reclaimAttempt.kind !== 'complete') throw new Error('reclaim attempt unavailable')
            return { action: action.action, attempt: reclaimAttempt, cachePath, root: authenticated.root }
        }

        const valid = await setup()
        const replaced = await setup()
        try {
            expect(await executeReclaimAction({ action: valid.action, attempt: valid.attempt, execute: executeProbe })).toMatchObject({ kind: 'executed' })
            await expect(lstat(valid.cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
            // A second removal under the same attempt no longer finds the original inode and runs nothing.
            expect(await executeReclaimAction({ action: valid.action, attempt: valid.attempt, execute: executeProbe })).toEqual({ kind: 'unavailable' })

            const original = await lstat(replaced.cachePath)
            const replacement = `${replaced.cachePath}-replacement`
            await mkdir(replacement)
            const replacementIdentity = await lstat(replacement)
            expect(replacementIdentity.ino).not.toBe(original.ino)
            await rm(replaced.cachePath, { recursive: true })
            await rename(replacement, replaced.cachePath)

            const execute = vi.fn(executeProbe)
            expect(await executeReclaimAction({ action: replaced.action, attempt: replaced.attempt, execute })).toEqual({ kind: 'unavailable' })
            expect(execute).not.toHaveBeenCalled()
            expect((await lstat(replaced.cachePath)).ino).toBe(replacementIdentity.ino)
        } finally {
            await rm(valid.root, { recursive: true, force: true })
            await rm(replaced.root, { recursive: true, force: true })
        }
    })
})
