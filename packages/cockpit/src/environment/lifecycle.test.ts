import { describe, expect, it, vi } from 'vitest'
import type { FilesystemCheck, HolderId, LifecycleProgress, StackId } from './contract.js'
import type { RuntimeLifecycleSemantics, RuntimeServiceEvidence } from './runtime.js'

const owners = vi.hoisted(() => ({
    stages: new WeakMap<object, unknown>(),
    runtimes: new WeakMap<object, unknown>(),
    ports: new WeakMap<object, unknown>(),
    reclaims: new WeakMap<object, unknown>(),
    services: new WeakSet<object>(),
}))

vi.mock('./lifecycle-stage.js', () => ({
    consumeLifecycleStageProjection: (value: object) => {
        const result = owners.stages.get(value)
        owners.stages.delete(value)
        return result
    },
}))
vi.mock('./runtime.js', () => ({
    consumeRuntimeLifecycleProjection: (value: object) => {
        const result = owners.runtimes.get(value)
        owners.runtimes.delete(value)
        return result
    },
    isRuntimeServiceEvidence: (value: object) => owners.services.has(value),
}))
vi.mock('./ports.js', () => ({
    consumePortLeaseProjection: (value: object) => {
        const result = owners.ports.get(value)
        owners.ports.delete(value)
        return result
    },
}))
vi.mock('./reclaim.js', () => ({
    consumeReclaimTargetProjection: (value: object) => {
        const result = owners.reclaims.get(value)
        owners.reclaims.delete(value)
        return result
    },
}))

import {
    admitUpProgress,
    planAdmittedUp,
    consumeLifecycleIssuance,
    planDown,
    planResetLifecycle,
    planSleep,
} from './lifecycle.js'
import { planUp } from '../../test-support/lifecycle-planning.js'

const stackId = `stack:${'1'.repeat(64)}` as StackId
const holderId = `holder:${'3'.repeat(64)}:session` as HolderId
const generation = '4'.repeat(64)

function execution(argv: readonly [string, ...string[]]) {
    return Object.freeze({
        argv, argv0: argv[0], cwd: '/workspace', env: Object.freeze({ PATH: '/bin' }),
        timeoutCeilingMs: 30_000, stdoutLimitBytes: 1024, stderrLimitBytes: 1024,
        paths: Object.freeze(['/workspace/z', '/workspace/a']), ports: Object.freeze([8080, 80]), expected: Object.freeze([]),
        consumedFiles: Object.freeze([]), filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    })
}

function semantics(serviceIds = ['db', 'api']): RuntimeLifecycleSemantics {
    const services = serviceIds.map((id, index) => Object.freeze({
        id,
        start: execution(['/usr/bin/docker', 'compose', 'up', id]),
        status: execution(['/usr/bin/docker', 'compose', 'ps', id]),
        identity: execution(['/usr/bin/docker', 'compose', 'ps', '--format', id]),
        inspect: execution(['/usr/bin/docker', 'inspect', Object.freeze({ kind: 'runtime-container-id' as const, service: id })] as never),
        healthAcceptance: Object.freeze({ state: 'running' as const, health: index === 0 ? null : 'healthy' as const }),
    }))
    return Object.freeze({
        stackId, configSha256: '5'.repeat(64), runtimeVersion: '27.0.0', composeVersion: '2.30.0', projectName: 'example',
        topology: Object.freeze({
            order: Object.freeze([...serviceIds]),
            services: Object.freeze(serviceIds.map((id, index) => Object.freeze({
                id, dependsOn: Object.freeze(index === 0 ? [] : [serviceIds[index - 1]!]),
                bindMountSources: Object.freeze(['/workspace']), healthcheck: index !== 0,
            }))),
        }),
        runtimeChecks: Object.freeze({ coldStartLimitMillis: 1000, expectedMountSources: Object.freeze(['/workspace']) }),
        services: Object.freeze(services),
    })
}

function projections(options: { holders?: number; services?: string[]; change?: 'acquired' | 'unchanged' } = {}) {
    const stage = Object.freeze({}); const runtime = Object.freeze({}); const ports = Object.freeze({})
    const values = semantics(options.services)
    owners.stages.set(stage, Object.freeze({ stackId, stage: 'steady' }))
    const topology = Object.freeze({ batchId: 'batch', executableSha256: '6'.repeat(64), ...values,
        observationWindow: Object.freeze({ startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() }),
    })
    owners.runtimes.set(runtime, Object.freeze({ topology, semantics: values }))
    const holderCount = options.holders ?? 1
    owners.ports.set(ports, Object.freeze({
        lease: Object.freeze({ stackId, offset: 0, ports: Object.freeze({ APP_PORT: 8080 }) }),
        ownership: Object.freeze({
            change: options.change ?? 'acquired', holderId, recordRevision: 7, holderCount,
            holderIds: Object.freeze(Array.from({ length: holderCount }, (_, index) => index === 0 ? holderId : `holder:${String(index).padStart(64, '7')}:session` as HolderId)),
        }),
        entrypoints: Object.freeze([Object.freeze({ name: 'app', kind: 'entrypoint', port: 'APP_PORT', value: 'http://127.0.0.1:8080' })]),
    }))
    return { stage, runtime, ports, semantics: values, topology }
}

function serviceEvidence(service: string, container = service === 'db' ? 'a'.repeat(64) : 'b'.repeat(64)): RuntimeServiceEvidence {
    const evidence = Object.freeze({
        stackId, configSha256: '5'.repeat(64), batchId: 'batch', runtimeVersion: '27.0.0', composeVersion: '2.30.0',
        executableSha256: '6'.repeat(64), projectName: 'example', service, containerId: container,
        state: 'running' as const, health: service === 'db' ? null : 'healthy' as const,
        observedAt: '2026-09-09T00:00:00.000Z', observationWindow: Object.freeze({ startedAt: '2026-09-09T00:00:00.000Z', expiresAt: '2026-09-09T00:05:00.000Z' }),
    })
    owners.services.add(evidence)
    return evidence
}

function reclaim(purpose: 'down' | 'reset', targetIds = ['volume:data']) {
    const projection = Object.freeze({})
    owners.reclaims.set(projection, Object.freeze({
        purpose, stackId, configSha256: '5'.repeat(64), planDigest: '7'.repeat(64),
        commitments: Object.freeze(targetIds.map((targetId) => Object.freeze({ targetId, format: 'cockpit-reclaim-target/v1', sha256: '8'.repeat(64), body: '{}' }))),
    }))
    return projection
}

describe('lifecycle planning', () => {
    it('plans dependency-ordered startup with entrypoints last and acquired-only compensation', () => {
        const input = projections()
        const reordered = {
            ...input.semantics,
            topology: { ...input.semantics.topology, services: [...input.semantics.topology.services].reverse() },
        }
        owners.runtimes.set(input.runtime, Object.freeze({ topology: input.topology, semantics: reordered }))
        const result = planUp({
            lifecycleStage: input.stage as never, runtime: input.runtime as never, ports: input.ports as never,
            progress: null, completedServices: [], operationGeneration: generation,
        })
        expect(result).toMatchObject({ kind: 'execute', mode: 'start' })
        if (result.kind !== 'execute') return
        expect(result.plan.steps.map((step) => step.kind === 'service' ? step.service : step.kind))
            .toEqual(['preflight', 'claim', 'db', 'api', 'publish-entrypoints'])
        expect(result.plan.steps.at(-1)).toMatchObject({ kind: 'publish-entrypoints', values: [{ name: 'app' }] })
        expect(result.plan.compensation).toEqual([{
            step: { id: 'lifecycle:claim:release', kind: 'claim', action: 'release' },
            ownership: { stackId, holderId, recordRevision: 7, change: 'acquired' },
        }])
        const issuance = consumeLifecycleIssuance(result.plan)
        expect(Object.keys(issuance ?? {}).sort()).toEqual([
            'drainRequest', 'firstIncompleteServiceIndex', 'portOwnership', 'reclaim', 'topology',
        ])
        expect(issuance).toMatchObject({ topology: input.topology, firstIncompleteServiceIndex: 0, drainRequest: null, reclaim: null })
        expect(consumeLifecycleIssuance(result.plan)).toBeUndefined()
        expect(consumeLifecycleIssuance({ ...result.plan })).toBeUndefined()
    })

    it('resumes only an authenticated exact completed prefix and no-ops when complete', () => {
        const first = projections({ change: 'unchanged' })
        const db = serviceEvidence('db')
        const initial = planUp({
            lifecycleStage: first.stage as never, runtime: first.runtime as never, ports: first.ports as never,
            progress: null, completedServices: [], operationGeneration: generation,
        })
        if (initial.kind !== 'execute') throw new Error('initial plan unavailable')
        expect(initial.plan.compensation).toEqual([])
        const progress: LifecycleProgress = {
            workBasisSha256: initial.plan.progress.workBasisSha256,
            operationGeneration: generation,
            completedServices: [{ service: 'db', containerId: db.containerId }],
        }
        const resumed = projections({ change: 'unchanged' })
        const result = planUp({
            lifecycleStage: resumed.stage as never, runtime: resumed.runtime as never, ports: resumed.ports as never,
            progress, completedServices: [db], operationGeneration: generation,
        })
        expect(result).toMatchObject({ kind: 'execute', mode: 'resume', plan: { resumeBoundary: { nextStepId: 'lifecycle:service:api' } } })

        const api = serviceEvidence('api')
        const complete = projections({ change: 'unchanged' })
        const noop = planUp({
            lifecycleStage: complete.stage as never, runtime: complete.runtime as never, ports: complete.ports as never,
            progress: { ...progress, completedServices: [...progress.completedServices, { service: 'api', containerId: api.containerId }] },
            completedServices: [db, api], operationGeneration: generation,
        })
        expect(noop).toMatchObject({ kind: 'noop', plan: { resumeBoundary: { nextStepId: null } } })
    })

    it('fails closed on copied, replayed, stale-prefix, and changed-basis inputs', () => {
        const copied = projections()
        expect(planUp({
            lifecycleStage: { ...copied.stage } as never, runtime: copied.runtime as never, ports: copied.ports as never,
            progress: null, completedServices: [], operationGeneration: generation,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })

        const replayed = projections()
        const replayInput = {
            lifecycleStage: replayed.stage as never, runtime: replayed.runtime as never, ports: replayed.ports as never,
            progress: null, completedServices: [], operationGeneration: generation,
        }
        expect(planUp(replayInput)).toMatchObject({ kind: 'execute' })
        expect(planUp(replayInput)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })

        const stale = projections({ change: 'unchanged' })
        expect(planUp({
            lifecycleStage: stale.stage as never, runtime: stale.runtime as never, ports: stale.ports as never,
            progress: { workBasisSha256: '9'.repeat(64), operationGeneration: generation, completedServices: [] },
            completedServices: [], operationGeneration: generation,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID' }] })

        const prefix = projections({ change: 'unchanged' })
        const authentic = serviceEvidence('db')
        const seed = planUp({ lifecycleStage: prefix.stage as never, runtime: prefix.runtime as never, ports: prefix.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        if (seed.kind !== 'execute') throw new Error('prefix seed unavailable')
        const retry = projections({ change: 'unchanged' })
        expect(planUp({
            lifecycleStage: retry.stage as never, runtime: retry.runtime as never, ports: retry.ports as never,
            progress: {
                workBasisSha256: seed.plan.progress.workBasisSha256, operationGeneration: generation,
                completedServices: [{ service: 'db', containerId: authentic.containerId }],
            },
            completedServices: [{ ...authentic }], operationGeneration: generation,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('admits matching progress once and finalizes only its authenticated completed prefix', () => {
        const seed = projections({ change: 'unchanged' })
        const initial = planUp({ lifecycleStage: seed.stage as never, runtime: seed.runtime as never,
            ports: seed.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        if (initial.kind !== 'execute') throw new Error('initial plan unavailable')
        const db = serviceEvidence('db')
        const progress = { ...initial.plan.progress, completedServices: [{ service: 'db', containerId: db.containerId }] }
        const fresh = projections({ change: 'unchanged' })
        const input = { lifecycleStage: fresh.stage as never, runtime: fresh.runtime as never,
            ports: fresh.ports as never, progress, operationGeneration: generation }
        const admitted = admitUpProgress(input)
        expect(admitted.kind).toBe('admitted')
        if (admitted.kind !== 'admitted') throw new Error('matching progress was not admitted')
        expect(Reflect.ownKeys(admitted.authority)).toEqual([])
        expect(admitUpProgress(input)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(planAdmittedUp({ authority: { ...admitted.authority }, completedServices: [db] }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        const result = planAdmittedUp({ authority: admitted.authority, completedServices: [db] })
        expect(result).toMatchObject({ kind: 'execute', mode: 'resume', plan: { resumeBoundary: { nextStepId: 'lifecycle:service:api' } } })
        if (result.kind !== 'execute') throw new Error('matching prefix was refused')
        expect(consumeLifecycleIssuance(result.plan)).toMatchObject({ topology: fresh.topology, firstIncompleteServiceIndex: 1 })
        expect(planAdmittedUp({ authority: admitted.authority, completedServices: [db] }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        const compatible = projections({ change: 'unchanged' })
        const wrapped = planUp({ lifecycleStage: compatible.stage as never, runtime: compatible.runtime as never,
            ports: compatible.ports as never, progress, completedServices: [db], operationGeneration: generation })
        expect(wrapped).toEqual(result)
    })

    it.each(['basis', 'generation'] as const)('refuses stale %s at admission and consumes the upstream projections', (changed) => {
        const fresh = projections()
        const seed = projections()
        const initial = planUp({ lifecycleStage: seed.stage as never, runtime: seed.runtime as never,
            ports: seed.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        if (initial.kind !== 'execute') throw new Error('initial plan unavailable')
        const input = { lifecycleStage: fresh.stage as never, runtime: fresh.runtime as never, ports: fresh.ports as never,
            progress: { ...initial.plan.progress, ...(changed === 'basis' ? { workBasisSha256: '9'.repeat(64) } : { operationGeneration: '9'.repeat(64) }) },
            operationGeneration: generation }
        expect(admitUpProgress(input)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID' }] })
        expect(owners.stages.has(fresh.stage)).toBe(false)
        expect(owners.runtimes.has(fresh.runtime)).toBe(false)
        expect(owners.ports.has(fresh.ports)).toBe(false)
        expect(admitUpProgress(input)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it.each(['before', 'after'] as const)('consumes finalization authority %s its original topology window', (side) => {
        const fresh = projections()
        const admitted = admitUpProgress({ lifecycleStage: fresh.stage as never, runtime: fresh.runtime as never,
            ports: fresh.ports as never, progress: null, operationGeneration: generation })
        if (admitted.kind !== 'admitted') throw new Error('initial admission unavailable')
        const bound = Date.parse(side === 'before' ? fresh.topology.observationWindow.startedAt : fresh.topology.observationWindow.expiresAt)
        const clock = vi.spyOn(Date, 'now').mockReturnValue(bound + (side === 'before' ? -1 : 1))
        try {
            expect(planAdmittedUp({ authority: admitted.authority, completedServices: [] }))
                .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        } finally { clock.mockRestore() }
        expect(planAdmittedUp({ authority: admitted.authority, completedServices: [] }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it.each(['missing', 'wrong-container', 'wrong-batch', 'copy'] as const)(
        'consumes authority when finalization refuses %s completed evidence', (invalid) => {
            const seed = projections()
            const initial = planUp({ lifecycleStage: seed.stage as never, runtime: seed.runtime as never,
                ports: seed.ports as never, progress: null, completedServices: [], operationGeneration: generation })
            if (initial.kind !== 'execute') throw new Error('initial plan unavailable')
            const db = serviceEvidence('db')
            const fresh = projections()
            const admitted = admitUpProgress({ lifecycleStage: fresh.stage as never, runtime: fresh.runtime as never,
                ports: fresh.ports as never, progress: { ...initial.plan.progress, completedServices: [{ service: 'db', containerId: db.containerId }] },
                operationGeneration: generation })
            if (admitted.kind !== 'admitted') throw new Error('matching progress was not admitted')
            const wrongBatch = Object.freeze({ ...db, batchId: 'other-batch' })
            owners.services.add(wrongBatch)
            const evidence = invalid === 'missing' ? [] : [invalid === 'wrong-container' ? serviceEvidence('db', 'f'.repeat(64))
                : invalid === 'wrong-batch' ? wrongBatch : invalid === 'copy' ? { ...db } : db]
            expect(planAdmittedUp({ authority: admitted.authority, completedServices: evidence })).toMatchObject({ kind: 'refusal', diagnostics: [{ code:
                invalid === 'copy' ? 'LIFECYCLE_EVIDENCE_INVALID' : 'LIFECYCLE_PROGRESS_INVALID' }] })
            expect(planAdmittedUp({ authority: admitted.authority, completedServices: [db] }))
                .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        },
    )

    it('keeps canonically distinct Unicode bytes distinct without normalization', () => {
        const composed = projections()
        const composedSemantics = { ...composed.semantics, services: composed.semantics.services.map((service, index) => index === 0
            ? { ...service, start: { ...service.start, cwd: '/workspace/caf\u00e9' } } : service) }
        owners.runtimes.set(composed.runtime, Object.freeze({ topology: composed.topology, semantics: composedSemantics }))
        const first = planUp({ lifecycleStage: composed.stage as never, runtime: composed.runtime as never, ports: composed.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        const decomposed = projections()
        const decomposedSemantics = { ...decomposed.semantics, services: decomposed.semantics.services.map((service, index) => index === 0
            ? { ...service, start: { ...service.start, cwd: '/workspace/cafe\u0301' } } : service) }
        owners.runtimes.set(decomposed.runtime, Object.freeze({ topology: decomposed.topology, semantics: decomposedSemantics }))
        const second = planUp({ lifecycleStage: decomposed.stage as never, runtime: decomposed.runtime as never, ports: decomposed.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        expect(first.kind).toBe('execute')
        expect(second.kind).toBe('execute')
        if (first.kind === 'execute' && second.kind === 'execute') {
            expect(first.plan.progress.workBasisSha256).not.toBe(second.plan.progress.workBasisSha256)
        }
    })

    // The first `up` moves the stage from bootstrap to steady itself. When the stage was part of the
    // work, the second `up` refused its own progress, re-ran every start and reported a fresh start.
    it('keeps a complete first up current after it moves the lifecycle stage to steady', () => {
        const bootstrap = projections()
        owners.stages.set(bootstrap.stage, Object.freeze({ stackId, stage: 'bootstrap' }))
        const first = planUp({ lifecycleStage: bootstrap.stage as never, runtime: bootstrap.runtime as never, ports: bootstrap.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        if (first.kind !== 'execute') throw new Error('first up plan unavailable')
        const [db, api] = [serviceEvidence('db'), serviceEvidence('api')]
        const steady = projections()
        expect(planUp({
            lifecycleStage: steady.stage as never, runtime: steady.runtime as never, ports: steady.ports as never,
            progress: { ...first.plan.progress, completedServices: [db, api].map(({ service, containerId }) => ({ service, containerId })) },
            completedServices: [db, api], operationGeneration: generation,
        })).toMatchObject({ kind: 'noop' })
    })

    it('gives reordered set-like execution values one canonical work basis', () => {
        const first = projections()
        const left = planUp({ lifecycleStage: first.stage as never, runtime: first.runtime as never, ports: first.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        const second = projections()
        const reordered = {
            ...second.semantics,
            services: second.semantics.services.map((service, index) => index === 0 ? {
                ...service,
                start: { ...service.start, paths: [...service.start.paths].reverse(), ports: [...service.start.ports].reverse() },
            } : service),
        }
        owners.runtimes.set(second.runtime, Object.freeze({ topology: second.topology, semantics: reordered }))
        const right = planUp({ lifecycleStage: second.stage as never, runtime: second.runtime as never, ports: second.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        expect(left.kind).toBe('execute')
        expect(right.kind).toBe('execute')
        if (left.kind === 'execute' && right.kind === 'execute') {
            expect(left.plan.progress.workBasisSha256).toBe(right.plan.progress.workBasisSha256)
        }
    })

    it('canonicalizes expected checks and refuses duplicate expected or filesystem checks', () => {
        const checks = [
            { kind: 'path' as const, target: '/workspace/z', state: 'directory' as const },
            { kind: 'path' as const, target: '/workspace/a', state: 'repository' as const },
        ]
        const digest = (expected: typeof checks, filesystemChecks: readonly FilesystemCheck[] = []) => {
            const input = projections()
            owners.runtimes.set(input.runtime, Object.freeze({
                topology: input.topology,
                semantics: {
                    ...input.semantics,
                    services: input.semantics.services.map((service, index) => index === 0
                        ? { ...service, start: { ...service.start, expected, filesystemChecks } } : service),
                },
            }))
            return planUp({ lifecycleStage: input.stage as never, runtime: input.runtime as never, ports: input.ports as never, progress: null, completedServices: [], operationGeneration: generation })
        }
        const forward = digest(checks)
        const reverse = digest([...checks].reverse())
        expect(forward.kind).toBe('execute')
        expect(reverse.kind).toBe('execute')
        if (forward.kind === 'execute' && reverse.kind === 'execute') {
            expect(forward.plan.progress.workBasisSha256).toBe(reverse.plan.progress.workBasisSha256)
        }
        expect(digest([checks[0]!, checks[0]!])).toMatchObject({ kind: 'refusal' })
        expect(digest([], [
            { path: '/workspace/config', expected: 'file' },
            { path: '/workspace/config', expected: 'directory' },
        ])).toMatchObject({ kind: 'refusal' })
        const identityCheck = (ino: number): FilesystemCheck => ({
            path: '/workspace/config', expected: 'file',
            identity: { dev: 1, ino, birthtimeNs: '0', ancestors: [{ path: '/workspace', dev: 1, ino: 2, birthtimeNs: '0' }] },
        })
        const firstIdentity = digest([], [identityCheck(3)])
        const secondIdentity = digest([], [identityCheck(4)])
        expect(firstIdentity.kind).toBe('execute')
        expect(secondIdentity.kind).toBe('execute')
        if (firstIdentity.kind === 'execute' && secondIdentity.kind === 'execute') {
            expect(firstIdentity.plan.progress.workBasisSha256).not.toBe(secondIdentity.plan.progress.workBasisSha256)
        }
    })

    it('changes the work basis for leased port, execution, dependency, and mount bytes', () => {
        const digest = (change: 'port' | 'execution' | 'dependency' | 'mount' | null) => {
            const input = projections()
            const changed = change === 'port'
                ? input.semantics
                : {
                    ...input.semantics,
                    topology: change === 'dependency' || change === 'mount' ? {
                        ...input.semantics.topology,
                        services: input.semantics.topology.services.map((service, index) => index === 1 ? {
                            ...service,
                            ...(change === 'dependency' ? { dependsOn: [] } : { bindMountSources: ['/workspace/changed'] }),
                        } : service),
                    } : input.semantics.topology,
                    services: change === 'execution' ? input.semantics.services.map((service, index) => index === 0
                        ? { ...service, start: { ...service.start, argv: [...service.start.argv, '--changed'] } } : service)
                        : input.semantics.services,
                }
            owners.runtimes.set(input.runtime, Object.freeze({ topology: input.topology, semantics: changed }))
            if (change === 'port') {
                owners.ports.set(input.ports, Object.freeze({
                    lease: Object.freeze({ stackId, offset: 1, ports: Object.freeze({ APP_PORT: 8081 }) }),
                    ownership: Object.freeze({ change: 'unchanged', holderId, recordRevision: 7, holderCount: 1, holderIds: Object.freeze([holderId]) }),
                    entrypoints: Object.freeze([Object.freeze({ name: 'app', kind: 'entrypoint', port: 'APP_PORT', value: 'http://127.0.0.1:8081' })]),
                }))
            }
            const result = planUp({ lifecycleStage: input.stage as never, runtime: input.runtime as never, ports: input.ports as never, progress: null, completedServices: [], operationGeneration: generation })
            if (result.kind !== 'execute') throw new Error(`basis unavailable for ${change}`)
            return result.plan.progress.workBasisSha256
        }
        const baseline = digest(null)
        expect(digest('port')).not.toBe(baseline)
        expect(digest('execution')).not.toBe(baseline)
        expect(digest('dependency')).not.toBe(baseline)
        expect(digest('mount')).not.toBe(baseline)
    })

    it('plans co-tenant sleep as release-only and last-holder sleep as runtime drain', () => {
        const shared = projections({ holders: 2, change: 'unchanged' })
        const release = planSleep({ runtime: shared.runtime as never, ports: shared.ports as never, operationGeneration: generation, runtimeStopValidForMs: 30_000 })
        expect(release).toMatchObject({ kind: 'release-only', plan: { verb: 'sleep' } })

        const last = projections({ holders: 1, change: 'unchanged' })
        const drain = planSleep({ runtime: last.runtime as never, ports: last.ports as never, operationGeneration: generation, runtimeStopValidForMs: 30_000 })
        expect(drain).toMatchObject({ kind: 'drain', request: { purpose: 'sleep', targetIds: [stackId], actions: [{ stage: 'runtime-stop', targetId: stackId }] } })
        if (drain.kind === 'drain') {
            expect(drain.request.planDigest).toBe(drain.plan.progress.workBasisSha256)
            expect(consumeLifecycleIssuance(drain.plan)).toMatchObject({ drainRequest: drain.request, reclaim: null })
            expect(consumeLifecycleIssuance(drain.plan)).toBeUndefined()
        }

        const empty = projections({ holders: 0, change: 'unchanged' })
        expect(planSleep({ runtime: empty.runtime as never, ports: empty.ports as never, operationGeneration: generation, runtimeStopValidForMs: 30_000 }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('rejects wrong-stack and copied owner projections', () => {
        const wrongStage = projections()
        owners.stages.set(wrongStage.stage, Object.freeze({ stackId: `stack:${'9'.repeat(64)}`, stage: 'steady' }))
        expect(planUp({ lifecycleStage: wrongStage.stage as never, runtime: wrongStage.runtime as never, ports: wrongStage.ports as never, progress: null, completedServices: [], operationGeneration: generation }))
            .toMatchObject({ kind: 'refusal' })

        const copiedRuntime = projections()
        expect(planSleep({ runtime: { ...copiedRuntime.runtime } as never, ports: copiedRuntime.ports as never, operationGeneration: generation, runtimeStopValidForMs: 30_000 }))
            .toMatchObject({ kind: 'refusal' })
        const copiedPorts = projections()
        expect(planSleep({ runtime: copiedPorts.runtime as never, ports: { ...copiedPorts.ports } as never, operationGeneration: generation, runtimeStopValidForMs: 30_000 }))
            .toMatchObject({ kind: 'refusal' })
        const copiedReclaim = projections({ change: 'unchanged' })
        const reclaimProjection = reclaim('down')
        expect(planDown({ runtime: copiedReclaim.runtime as never, ports: copiedReclaim.ports as never, reclaim: { ...reclaimProjection } as never, operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000 }))
            .toMatchObject({ kind: 'refusal' })
    })

    it.each([
        ['down', planDown, 'down'],
        ['reset', planResetLifecycle, 'reset'],
    ] as const)('plans %s runtime-first with exact reclaim order and rejects co-tenancy', (_name, planner, purpose) => {
        const input = projections({ change: 'unchanged' })
        const result = planner({
            runtime: input.runtime as never, ports: input.ports as never, reclaim: reclaim(purpose) as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 60_000,
        })
        expect(result).toMatchObject({
            kind: 'drain', request: {
                purpose, targetIds: [stackId, 'volume:data'],
                actions: [{ stage: 'runtime-stop', targetId: stackId }, { stage: 'reclaim', targetId: 'volume:data' }],
            },
        })
        if (result.kind === 'drain') {
            const issuance = consumeLifecycleIssuance(result.plan)
            expect(issuance).toMatchObject({ reclaim: { purpose }, drainRequest: result.request })
            expect(consumeLifecycleIssuance(result.plan)).toBeUndefined()
        }

        const shared = projections({ holders: 2, change: 'unchanged' })
        expect(planner({
            runtime: shared.runtime as never, ports: shared.ports as never, reclaim: reclaim(purpose) as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 60_000,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CLAIM_CO_TENANT' }] })
    })

    it('reports invalid reclaim evidence before co-tenant policy', () => {
        const shared = projections({ holders: 2, change: 'unchanged' })
        const authentic = reclaim('down')
        expect(planDown({
            runtime: shared.runtime as never, ports: shared.ports as never, reclaim: { ...authentic } as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000,
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
        })
    })

    it('sorts drain target identity while retaining runtime-first action order', () => {
        const input = projections({ change: 'unchanged' })
        const result = planDown({
            runtime: input.runtime as never, ports: input.ports as never,
            reclaim: reclaim('down', ['container:service', 'volume:data']) as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000,
        })
        expect(result).toMatchObject({
            kind: 'drain',
            request: {
                targetIds: ['container:service', stackId, 'volume:data'],
                actions: [
                    { stage: 'runtime-stop', targetId: stackId },
                    { stage: 'reclaim', targetId: 'container:service' },
                    { stage: 'reclaim', targetId: 'volume:data' },
                ],
            },
        })
    })

    it('binds the exact reclaim plan and targets into destructive work identity', () => {
        const first = projections({ change: 'unchanged' })
        const left = planDown({
            runtime: first.runtime as never, ports: first.ports as never, reclaim: reclaim('down', ['volume:data']) as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000,
        })
        const second = projections({ change: 'unchanged' })
        const changed = reclaim('down', ['volume:other'])
        owners.reclaims.set(changed, Object.freeze({
            purpose: 'down', stackId, configSha256: '5'.repeat(64), planDigest: '9'.repeat(64),
            commitments: Object.freeze([Object.freeze({ targetId: 'volume:other', format: 'cockpit-reclaim-target/v1', sha256: 'a'.repeat(64), body: '{"changed":true}' })]),
        }))
        const right = planDown({
            runtime: second.runtime as never, ports: second.ports as never, reclaim: changed as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000,
        })
        expect(left.kind).toBe('drain')
        expect(right.kind).toBe('drain')
        if (left.kind === 'drain' && right.kind === 'drain') {
            expect(left.request.operationBasis).not.toBe(right.request.operationBasis)
            expect(left.plan.progress.workBasisSha256).toBe(left.request.operationBasis)
            expect(right.plan.progress.workBasisSha256).toBe(right.request.operationBasis)
        }
    })

    it('rejects invalid drain validity, duplicate targets, and empty reset targets', () => {
        for (const validity of [0, 300_001]) {
            const sleep = projections({ change: 'unchanged' })
            expect(planSleep({ runtime: sleep.runtime as never, ports: sleep.ports as never, operationGeneration: generation, runtimeStopValidForMs: validity }))
                .toMatchObject({ kind: 'refusal' })
        }
        const duplicate = projections({ change: 'unchanged' })
        expect(planDown({
            runtime: duplicate.runtime as never, ports: duplicate.ports as never,
            reclaim: reclaim('down', ['volume:data', 'volume:data']) as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000,
        })).toMatchObject({ kind: 'refusal' })
        const empty = projections({ change: 'unchanged' })
        expect(planResetLifecycle({
            runtime: empty.runtime as never, ports: empty.ports as never, reclaim: reclaim('reset', []) as never,
            operationGeneration: generation, runtimeStopValidForMs: 30_000, reclaimValidForMs: 30_000,
        })).toMatchObject({ kind: 'refusal' })
    })

    it('rejects duplicate dependency edges before hashing', () => {
        const input = projections()
        const bad = { ...input.semantics, topology: { ...input.semantics.topology, services: [
            { ...input.semantics.topology.services[0]!, dependsOn: [] },
            { ...input.semantics.topology.services[1]!, dependsOn: ['db', 'db'] },
        ] } }
        owners.runtimes.set(input.runtime, Object.freeze({ topology: input.topology, semantics: bad }))
        expect(planUp({ lifecycleStage: input.stage as never, runtime: input.runtime as never, ports: input.ports as never, progress: null, completedServices: [], operationGeneration: generation }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('enforces the semantic envelope, service, and edge bounds', () => {
        const oversized = projections()
        const huge = 'x'.repeat(1_048_576)
        owners.runtimes.set(oversized.runtime, Object.freeze({
            topology: oversized.topology,
            semantics: { ...oversized.semantics, services: oversized.semantics.services.map((service, index) => index === 0
                ? { ...service, start: { ...service.start, argv: ['/usr/bin/docker', huge] } } : service) },
        }))
        expect(planUp({ lifecycleStage: oversized.stage as never, runtime: oversized.runtime as never, ports: oversized.ports as never, progress: null, completedServices: [], operationGeneration: generation }))
            .toMatchObject({ kind: 'refusal' })

        const tooMany = projections({ services: Array.from({ length: 4_097 }, (_, index) => `service-${index}`) })
        expect(planUp({ lifecycleStage: tooMany.stage as never, runtime: tooMany.runtime as never, ports: tooMany.ports as never, progress: null, completedServices: [], operationGeneration: generation }))
            .toMatchObject({ kind: 'refusal' })

        const edged = projections({ services: Array.from({ length: 130 }, (_, index) => `service-${index}`) })
        const allIds = edged.semantics.topology.order
        owners.runtimes.set(edged.runtime, Object.freeze({
            topology: edged.topology,
            semantics: {
                ...edged.semantics,
                topology: {
                    ...edged.semantics.topology,
                    services: edged.semantics.topology.services.map((service) => ({ ...service, dependsOn: allIds.filter((id) => id !== service.id) })),
                },
            },
        }))
        expect(planUp({ lifecycleStage: edged.stage as never, runtime: edged.runtime as never, ports: edged.ports as never, progress: null, completedServices: [], operationGeneration: generation }))
            .toMatchObject({ kind: 'refusal' })
    })
})
