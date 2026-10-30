import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import {
    reserveDrain,
    type CoordinationRecord,
} from './claims.js'
import {
    type CheckoutId,
    type CockpitId,
    type HolderId,
    type StackId,
} from './contract.js'
import {
    planDown,
    planResetLifecycle,
    planSleep,
    planUp,
} from './lifecycle.js'
import {
    projectLifecycleStage,
    resolveLifecycleStage,
} from './lifecycle-stage.js'
import {
    deriveEntrypoints,
    projectPortLeaseResult,
} from './ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import {
    admitDockerSelection,
    admitImageInspections,
    admitReclaimDiscovery,
    admitVolumeInspections,
    combineReclaimDiscoveries,
    createDockerSelectionSteps,
    createImageInspectionSteps,
    createReclaimDiscoverySteps,
    createVolumeInspectionSteps,
    createNetworkInspectionSteps,
    admitNetworkInspections,
    planReset,
    planTeardown,
    projectResetActionTargets,
    projectTeardownActionTargets,
    type ReclaimDiscoverySnapshot,
    type ReclaimResource,
    type ReclaimTargetProjection,
} from './reclaim.js'
import {
    admitRuntimeTopology,
    createRuntimeAdapter,
    createRuntimeTopologyPlan,
    projectRuntimeLifecycle,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { readState, selectStateRoot, type StateNamespace, type StateRecord } from './state.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cockpitId = `cockpit:integration:${sha('cockpit')}` as CockpitId
const stackId = `stack:${sha('stack')}` as StackId
const holderId = `holder:${sha('holder')}:session` as HolderId
const checkoutId = `checkout:${sha('checkout')}` as CheckoutId
const configSha256 = sha('configuration')
const batchId = sha('runtime batch')
const generation = sha('operation generation')
const dockerContext = 'synthetic-context'
const dockerEndpoint = 'unix:///tmp/synthetic-docker.sock'
const ownershipLabels = {
    'dev.b0dea.cockpit.stack-id': stackId,
    'dev.b0dea.cockpit.config-sha256': configSha256,
    'dev.b0dea.cockpit.owner-id': cockpitId,
}
const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    roots.push(root)
    return root
}

async function stateNamespace(root: string): Promise<StateNamespace> {
    const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId })
    if (selected.kind !== 'complete') throw new Error('state namespace unavailable')
    return selected.value
}

async function issuePortProjection(namespace: StateNamespace) {
    const now = new Date().toISOString()
    const lease = await leasePortFamilyFixture({
        namespace,
        stackId,
        holderId,
        checkoutId,
        config: { step: 100, count: 1, bases: { WEB: 61_321 } },
        now,
        listenerTimeoutMs: 1_000,
        listenerEvidence: [{
            ports: [61_321],
            observation: { state: 'available', value: [], observedAt: now, producer: 'integration-listener-probe' },
        }],
    })
    if (lease.kind !== 'complete') throw new Error(`port lease unavailable: ${JSON.stringify(lease)}`)
    const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
    if (entrypoints.kind !== 'complete') throw new Error('entrypoints unavailable')
    const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
    if (!projection) throw new Error('port projection unavailable')
    return projection
}

async function issueStageProjection(namespace: StateNamespace) {
    const observedAt = new Date().toISOString()
    const stage = await resolveLifecycleStage({ namespace, stackId, observedAt })
    if (stage.kind !== 'complete') throw new Error('lifecycle stage unavailable')
    const projection = projectLifecycleStage({
        authority: stage.authority,
        stackId,
        cockpitId,
        earliest: Date.parse(stage.authority.observedAt),
        latest: Date.parse(stage.authority.validThrough),
        evaluatedAt: Date.now(),
    })
    if (!projection) throw new Error('lifecycle stage projection unavailable')
    return projection
}

async function issueRuntimeTopology(root: string): Promise<RuntimeTopologyEvidence> {
    const composePath = join(root, 'compose.yml')
    const composeSource = 'services: {}\n'
    await writeFile(composePath, composeSource)
    const runtimePath = join(root, 'docker')
    const topology = {
        services: {
            db: { labels: { 'dev.b0dea.cockpit.stack-id': stackId, 'dev.b0dea.cockpit.config-sha256': configSha256 } },
            api: { depends_on: ['db'], labels: { 'dev.b0dea.cockpit.stack-id': stackId, 'dev.b0dea.cockpit.config-sha256': configSha256 } },
        },
    }
    const runtimeBytes = Buffer.from(`#!/bin/sh\nprintf '%s' '${JSON.stringify(topology)}'\n`)
    await writeFile(runtimePath, runtimeBytes, { mode: 0o700 })
    await chmod(runtimePath, 0o700)
    const runtimeSha256 = sha(runtimeBytes)
    const runtime = createRuntimeAdapter({
        runtime: { name: 'docker', version: '27.1.2', executableSha256: runtimeSha256 },
        composeVersion: '2.39.2',
        executable: { canonicalPath: runtimePath, invocationPath: runtimePath, sha256: runtimeSha256, executionMode: 'verified-path' },
        operation: 'validate',
        cwd: root,
        composeFiles: [{ reference: 'compose.yml', canonicalPath: composePath, source: composeSource, sha256: sha(composeSource) }],
        projectName: 'synthetic',
        env: { PATH: '/usr/bin:/bin' },
        ports: [],
        labels: { stackId, configSha256, batchId },
        timeoutMs: 5_000,
        stackId,
        coldStartLimitMillis: 60_000,
        expectedMountSources: [],
    })
    if (runtime.kind !== 'preview') throw new Error(`runtime adapter unavailable: ${JSON.stringify(runtime.diagnostics)}`)
    const plan = createRuntimeTopologyPlan({
        runtimePlan: runtime.plan,
        stackId,
        configSha256,
        batchId,
        observationWindow: {
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
    })
    if (plan.kind !== 'planned') throw new Error(`runtime topology plan unavailable: ${plan.reason}`)
    const admitted = admitRuntimeTopology({ plan, outcome: await executeProbe(plan.step) })
    if (admitted.kind !== 'complete') throw new Error(`runtime topology unavailable: ${admitted.reason}`)
    return admitted.topology
}

function dockerRow(resource: ReclaimResource) {
    if (resource.kind === 'build-cache') {
        return { ID: resource.id, Reclaimable: !resource.referenced, Size: String(resource.bytes) }
    }
    return {
        id: resource.kind === 'volume' ? resource.name : resource.id,
        name: resource.name,
        labels: resource.labels,
        referenced: false,
        bytes: resource.kind === 'network' ? null : resource.bytes,
    }
}

async function issueSelection(root: string, executable: ReturnType<typeof resolvedExecutable>) {
    const steps = createDockerSelectionSteps({ executable, cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000, context: dockerContext })
    if (!steps) throw new Error('Docker selection plan unavailable')
    const evidence = await Promise.all(steps.map(async (step) => ({ step, outcome: await executeProbe(step) })))
    const authority = admitDockerSelection(steps, evidence)
    if (!authority) throw new Error('Docker selection evidence unavailable')
    return authority
}

function resolvedExecutable(path: string, bytes: Buffer) {
    return { canonicalPath: path, invocationPath: path, sha256: sha(bytes), executionMode: 'verified-path' as const }
}

async function issueReclaimDiscovery(root: string, resources: readonly ReclaimResource[]) {
    const kinds = ['container', 'network', 'volume', 'image', 'build-cache'] as const
    for (const kind of kinds) {
        const rows = resources.filter((resource) => resource.kind === kind)
        await writeFile(join(root, `docker.${kind}`), `${rows.map((row) => JSON.stringify(dockerRow(row))).join('\n')}\n`)
        if (kind === 'volume') {
            for (const row of rows) await writeFile(join(root, `inspect.${row.name}`), `${JSON.stringify({ name: row.name, generation: row.generation })}\n`)
        }
        if (kind === 'network') {
            for (const row of rows) await writeFile(join(root, `inspect.network.${row.id}`), `${JSON.stringify({ id: row.id, members: '' })}\n`)
        }
        if (kind === 'container') {
            for (const row of rows) await writeFile(join(root, `inspect.container.${row.id}`), `${JSON.stringify({ id: row.id, networks: {} })}\n`)
        }
    }
    await writeFile(join(root, 'selection.context'), `${JSON.stringify({ context: dockerContext, endpoint: dockerEndpoint })}\n`)
    const runtimePath = join(root, 'docker')
    const runtimeBytes = Buffer.from('#!/bin/sh\nif [ "$1" = context ]; then /bin/cat -- "$PWD/selection.context"; exit; fi\n[ "$1" = --host ] || exit 91\nshift 2\nkind="$1"\nif [ "$2" = inspect ]; then shift 4; status=0; for id do if [ "$kind" = image ] || [ "$kind" = volume ]; then /bin/cat -- "$PWD/inspect.$id" || status=1; else /bin/cat -- "$PWD/inspect.$kind.$id" || status=1; fi; done; exit $status; fi\n[ "$kind" = builder ] && kind=build-cache\n/bin/cat -- "$PWD/docker.$kind"\n')
    await writeFile(runtimePath, runtimeBytes, { mode: 0o700 })
    await chmod(runtimePath, 0o700)
    const executable = resolvedExecutable(runtimePath, runtimeBytes)
    const selection = await issueSelection(root, executable)
    const steps = createReclaimDiscoverySteps({
        executable,
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        stackId,
        cockpitId,
        timeoutMs: 5_000,
        selectionAuthority: selection,
    })
    if (!steps) throw new Error('reclaim discovery plan unavailable')
    const observations = await Promise.all(steps.map(async (step) => ({
        step,
        outcome: await executeProbe(step),
    })))
    const observedSelection = await issueSelection(root, executable)
    const snapshots: ReclaimDiscoverySnapshot[] = []
    const rawSnapshots = new Map(observations.map(({ step, outcome }) => {
        const kind = step.labels.resourceKind as typeof kinds[number]
        const snapshot = admitReclaimDiscovery(step, outcome, kind, observedSelection)
        if (!snapshot) throw new Error(`${kind} discovery evidence unavailable`)
        return [kind, snapshot] as const
    }))
    const containerSnapshot = rawSnapshots.get('container')
    if (!containerSnapshot) throw new Error('container discovery evidence unavailable')
    for (const kind of kinds) {
        let snapshot = rawSnapshots.get(kind)
        if (!snapshot) throw new Error(`${kind} discovery evidence unavailable`)
        if (kind === 'image') {
            const inspections = createImageInspectionSteps(snapshot)
            if (!inspections) throw new Error('image inspection plan unavailable')
            const inspected = admitImageInspections(snapshot, await Promise.all(inspections.map(async (inspection) => ({
                step: inspection, outcome: await executeProbe(inspection),
            }))))
            if (!inspected) throw new Error('image inspection evidence unavailable')
            snapshot = inspected
        }
        if (kind === 'volume') {
            const inspections = createVolumeInspectionSteps(snapshot)
            if (!inspections) throw new Error('volume inspection plan unavailable')
            const inspected = admitVolumeInspections(snapshot, await Promise.all(inspections.map(async (inspection) => ({
                step: inspection, outcome: await executeProbe(inspection),
            }))))
            if (!inspected) throw new Error('volume inspection evidence unavailable')
            snapshot = inspected
        }
        if (kind === 'network') {
            const inspections = createNetworkInspectionSteps(snapshot, containerSnapshot)
            if (!inspections) throw new Error('network inspection plan unavailable')
            const inspected = admitNetworkInspections(snapshot, containerSnapshot, await Promise.all(inspections.map(async (inspection) => ({
                step: inspection, outcome: await executeProbe(inspection),
            }))))
            if (!inspected) throw new Error('network inspection evidence unavailable')
            snapshot = inspected
        }
        if (!snapshot) throw new Error(`${kind} inspection evidence unavailable`)
        snapshots.push(snapshot)
    }
    const discovery = combineReclaimDiscoveries(snapshots)
    if (!discovery) throw new Error('combined reclaim discovery unavailable')
    return { discovery, executable, selection: await issueSelection(root, executable) }
}

async function coordinationSnapshot(namespace: StateNamespace) {
    const result = await readState(namespace.paths.coordination(stackId))
    if (result.kind !== 'complete') throw new Error('coordination state unavailable')
    return {
        bytes: await readFile(namespace.paths.coordination(stackId).path),
        record: result.value,
    }
}

function coordinationValue(record: StateRecord): CoordinationRecord {
    return record.value as unknown as CoordinationRecord
}

async function issueUpInput(namespace: StateNamespace, topology: RuntimeTopologyEvidence) {
    const runtime = projectRuntimeLifecycle(topology)
    if (!runtime) throw new Error('runtime projection unavailable')
    return {
        lifecycleStage: await issueStageProjection(namespace),
        runtime,
        ports: await issuePortProjection(namespace),
        progress: null,
        completedServices: [],
        operationGeneration: generation,
    }
}

async function issueTeardownProjection(root: string, record: StateRecord): Promise<ReclaimTargetProjection> {
    const cacheId = 'abcdefghijklmnopqrstuvwxy'
    const observed = await issueReclaimDiscovery(root, [
        { id: cacheId, name: 'synthetic-build-cache', kind: 'build-cache', labels: {}, referenced: false, bytes: 128 },
        { id: 'container-2', name: 'synthetic-container', kind: 'container', labels: ownershipLabels, referenced: false, bytes: 256 },
    ])
    const preview = await planTeardown({
        stackId, cockpitId, configSha256, coordinationRecord: record,
        declaredCacheIds: [cacheId], discovery: observed.discovery,
        executable: observed.executable, selectionAuthority: observed.selection,
        cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 30_000,
    })
    const projection = projectTeardownActionTargets(preview)
    if (!projection) throw new Error('teardown target projection unavailable')
    return projection
}

async function issueResetProjection(root: string, record: StateRecord): Promise<ReclaimTargetProjection> {
    const volumes: ReclaimResource[] = [
        { id: 'volume-1', name: 'alpha-data', kind: 'volume', labels: ownershipLabels, referenced: false, bytes: 128, dataBearing: true, generation: sha('alpha generation') },
        { id: 'volume-2', name: 'zeta-data', kind: 'volume', labels: ownershipLabels, referenced: false, bytes: 256, dataBearing: true, generation: sha('zeta generation') },
    ]
    const observed = await issueReclaimDiscovery(root, volumes)
    const removalPath = await realpath('/bin/rm')
    const removalBytes = await readFile(removalPath)
    const preview = await planReset({
        stackId, cockpitId, configSha256, coordinationRecord: record,
        expectedCoordinationRevision: record.revision, requesterHolderId: holderId,
        declaredCacheIds: [], resettableVolumes: volumes.map(({ name }) => name), generatedHostPaths: [],
        discovery: observed.discovery, runtimeExecutable: observed.executable,
        selectionAuthority: observed.selection,
        pathExecutable: { canonicalPath: removalPath, invocationPath: '/bin/rm', sha256: sha(removalBytes), executionMode: 'verified-path' },
        cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 30_000,
    })
    const projection = preview.kind === 'preview' ? projectResetActionTargets(preview) : undefined
    if (!projection) throw new Error('reset target projection unavailable')
    return projection
}

async function issueDrainInputs(namespace: StateNamespace, topology: RuntimeTopologyEvidence) {
    const runtime = projectRuntimeLifecycle(topology)
    if (!runtime) throw new Error('runtime projection unavailable')
    return { runtime, ports: await issuePortProjection(namespace) }
}

describe('lifecycle owner integration', () => {
    it('accepts owner projections once and independently refuses every up projection copy and replay', async () => {
        const root = await temporaryRoot('cockpit-lifecycle-integration-up-')
        const namespace = await stateNamespace(root)
        const topology = await issueRuntimeTopology(root)
        await issuePortProjection(namespace)
        const before = await coordinationSnapshot(namespace)

        for (const owner of ['lifecycleStage', 'runtime', 'ports'] as const) {
            const consumed = await issueUpInput(namespace, topology)
            expect(planUp(consumed)).toMatchObject({ kind: 'execute', mode: 'start' })

            const replayAttempt = await issueUpInput(namespace, topology)
            expect(planUp({ ...replayAttempt, [owner]: consumed[owner] })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
            })

            const authentic = await issueUpInput(namespace, topology)
            const copyAttempt = await issueUpInput(namespace, topology)
            expect(planUp({ ...copyAttempt, [owner]: { ...authentic[owner] } as never })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
            })
        }
        const after = await coordinationSnapshot(namespace)
        expect(after.record.revision).toBe(before.record.revision)
        expect(after.bytes.equals(before.bytes)).toBe(true)
    })

    it('independently refuses copied and replayed teardown and reset target projections', async () => {
        for (const verb of ['down', 'reset'] as const) {
            const root = await temporaryRoot(`cockpit-lifecycle-integration-${verb}-authority-`)
            const namespace = await stateNamespace(root)
            const topology = await issueRuntimeTopology(root)
            await issuePortProjection(namespace)
            const { record } = await coordinationSnapshot(namespace)
            const issueReclaim = () => verb === 'down'
                ? issueTeardownProjection(root, record)
                : issueResetProjection(root, record)
            const plan = verb === 'down' ? planDown : planResetLifecycle

            const consumed = await issueReclaim()
            const acceptedInputs = await issueDrainInputs(namespace, topology)
            expect(plan({ ...acceptedInputs, reclaim: consumed, operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000 }))
                .toMatchObject({ kind: 'drain' })

            const replayInputs = await issueDrainInputs(namespace, topology)
            expect(plan({ ...replayInputs, reclaim: consumed, operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000 }))
                .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })

            const authentic = await issueReclaim()
            const copyInputs = await issueDrainInputs(namespace, topology)
            expect(plan({ ...copyInputs, reclaim: { ...authentic } as never, operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000 }))
                .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        }
    })

    it('hands each generated drain request to the claims owner without mutating planning state', async () => {
        const cases = ['sleep', 'down', 'reset'] as const
        for (const verb of cases) {
            const root = await temporaryRoot(`cockpit-lifecycle-integration-${verb}-`)
            const namespace = await stateNamespace(root)
            const topology = await issueRuntimeTopology(root)
            const { runtime, ports } = await issueDrainInputs(namespace, topology)
            const before = await coordinationSnapshot(namespace)
            let result
            if (verb === 'sleep') {
                result = planSleep({ runtime, ports, operationGeneration: generation, runtimeStopValidForMs: 30_000 })
            } else {
                const coordination = coordinationValue(before.record)
                if (verb === 'down') {
                    const reclaim = await issueTeardownProjection(root, before.record)
                    result = planDown({ runtime, ports, reclaim, operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000 })
                } else {
                    const reclaim = await issueResetProjection(root, before.record)
                    result = planResetLifecycle({ runtime, ports, reclaim, operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000 })
                }
                expect(coordination.holders).toHaveLength(1)
            }
            expect(result).toMatchObject({ kind: 'drain' })
            if (result.kind !== 'drain') throw new Error(`${verb} drain planning unavailable`)
            if (verb === 'down') {
                expect(result.request.targetIds).toEqual([
                    'build-cache:abcdefghijklmnopqrstuvwxy', 'container:container-2', stackId,
                ])
                expect(result.request.actions.map(({ stage, targetId }) => ({ stage, targetId }))).toEqual([
                    { stage: 'runtime-stop', targetId: stackId },
                    { stage: 'reclaim', targetId: 'build-cache:abcdefghijklmnopqrstuvwxy' },
                    { stage: 'reclaim', targetId: 'container:container-2' },
                ])
            }
            if (verb === 'reset') {
                expect(result.request.targetIds).toEqual([stackId, 'volume:alpha-data', 'volume:zeta-data'])
                expect(result.request.actions.map(({ stage, targetId }) => ({ stage, targetId }))).toEqual([
                    { stage: 'runtime-stop', targetId: stackId },
                    { stage: 'reclaim', targetId: 'volume:alpha-data' },
                    { stage: 'reclaim', targetId: 'volume:zeta-data' },
                ])
            }
            const afterPlan = await coordinationSnapshot(namespace)
            expect(afterPlan.record.revision).toBe(before.record.revision)
            expect(afterPlan.bytes.equals(before.bytes)).toBe(true)
            expect(await reserveDrain({ namespace, request: result.request })).toMatchObject({ kind: 'complete' })
        }
    })
})
