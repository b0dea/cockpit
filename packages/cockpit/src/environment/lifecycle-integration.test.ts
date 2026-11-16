import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import {
    type CheckoutId,
    type CockpitId,
    type HolderId,
    type StackId,
} from './contract.js'
import { planUp } from '../../test-support/lifecycle-planning.js'
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
    createRuntimeAdapter,
    observeRuntimeTopology,
    projectRuntimeLifecycle,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { readState, selectStateRoot, type StateNamespace } from './state.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cockpitId = `cockpit:integration:${sha('cockpit')}` as CockpitId
const stackId = `stack:${sha('stack')}` as StackId
const holderId = `holder:${sha('holder')}:session` as HolderId
const checkoutId = `checkout:${sha('checkout')}` as CheckoutId
const configSha256 = sha('configuration')
const batchId = sha('runtime batch')
const generation = sha('operation generation')
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
    const admitted = await observeRuntimeTopology({
        execute: executeProbe,
        runtimePlan: runtime.plan,
        stackId,
        configSha256,
        batchId,
        observationWindow: {
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
    })
    if (admitted.kind !== 'complete') throw new Error(`runtime topology unavailable: ${admitted.reason}`)
    return admitted.topology
}

async function coordinationSnapshot(namespace: StateNamespace) {
    const result = await readState(namespace.paths.coordination(stackId))
    if (result.kind !== 'complete') throw new Error('coordination state unavailable')
    return {
        bytes: await readFile(namespace.paths.coordination(stackId).path),
        record: result.value,
    }
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

describe('lifecycle owner integration', () => {
    it('accepts stage and port projections once and independently refuses their copies and replays', async () => {
        const root = await temporaryRoot('cockpit-lifecycle-integration-up-')
        const namespace = await stateNamespace(root)
        const topology = await issueRuntimeTopology(root)
        await issuePortProjection(namespace)
        const before = await coordinationSnapshot(namespace)

        for (const owner of ['lifecycleStage', 'ports'] as const) {
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
})
