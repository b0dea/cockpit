import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'smol-toml'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { StackId } from './contract.js'
const applicationOwners = vi.hoisted(() => ({
    lifecycle: {} as Partial<Pick<typeof import('./lifecycle.js'), 'admitUpProgress' | 'consumeLifecycleIssuance' | 'planAdmittedUp'>>,
    runtime: {} as Partial<Pick<typeof import('./runtime.js'), 'admitRuntimeServiceHealth' | 'observeRuntimeServiceColdStart' | 'resolveRuntimeServiceOrder' | 'revalidateRuntimeService' | 'startRuntimeService' | 'stopRuntime'>>,
    logs: {} as Partial<Pick<typeof import('./logs.js'), 'admitFailureLogs' | 'planFailureLogs'>>,
    ports: {} as Partial<Pick<typeof import('./ports.js'), 'compensateAcquiredPortHolder' | 'deriveEntrypoints' | 'observeRetainedPortFamily' | 'projectRetainedPortFamilyResult' | 'releasePortFamily'>>,
}))
vi.mock('./lifecycle.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lifecycle.js')>()
    return {
        ...actual,
        admitUpProgress: (...args: Parameters<typeof actual.admitUpProgress>) => applicationOwners.lifecycle.admitUpProgress?.(...args) ?? actual.admitUpProgress(...args),
        consumeLifecycleIssuance: (...args: Parameters<typeof actual.consumeLifecycleIssuance>) => applicationOwners.lifecycle.consumeLifecycleIssuance?.(...args) ?? actual.consumeLifecycleIssuance(...args),
        planAdmittedUp: (...args: Parameters<typeof actual.planAdmittedUp>) => applicationOwners.lifecycle.planAdmittedUp?.(...args) ?? actual.planAdmittedUp(...args),
    }
})
vi.mock('./runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./runtime.js')>()
    return {
        ...actual,
        admitRuntimeServiceHealth: (...args: Parameters<typeof actual.admitRuntimeServiceHealth>) => applicationOwners.runtime.admitRuntimeServiceHealth?.(...args) ?? actual.admitRuntimeServiceHealth(...args),
        revalidateRuntimeService: (...args: Parameters<typeof actual.revalidateRuntimeService>) => applicationOwners.runtime.revalidateRuntimeService?.(...args) ?? actual.revalidateRuntimeService(...args),
        startRuntimeService: (...args: Parameters<typeof actual.startRuntimeService>) => applicationOwners.runtime.startRuntimeService?.(...args) ?? actual.startRuntimeService(...args),
        stopRuntime: (...args: Parameters<typeof actual.stopRuntime>) => applicationOwners.runtime.stopRuntime?.(...args) ?? actual.stopRuntime(...args),
        observeRuntimeServiceColdStart: (...args: Parameters<typeof actual.observeRuntimeServiceColdStart>) => applicationOwners.runtime.observeRuntimeServiceColdStart?.(...args) ?? actual.observeRuntimeServiceColdStart(...args),
        resolveRuntimeServiceOrder: (...args: Parameters<typeof actual.resolveRuntimeServiceOrder>) => applicationOwners.runtime.resolveRuntimeServiceOrder?.(...args) ?? actual.resolveRuntimeServiceOrder(...args),
    }
})
vi.mock('./logs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./logs.js')>()
    return {
        ...actual,
        admitFailureLogs: (...args: Parameters<typeof actual.admitFailureLogs>) => applicationOwners.logs.admitFailureLogs?.(...args) ?? actual.admitFailureLogs(...args),
        planFailureLogs: (...args: Parameters<typeof actual.planFailureLogs>) => applicationOwners.logs.planFailureLogs?.(...args) ?? actual.planFailureLogs(...args),
    }
})
vi.mock('./ports.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./ports.js')>()
    return {
        ...actual,
        compensateAcquiredPortHolder: (...args: Parameters<typeof actual.compensateAcquiredPortHolder>) => applicationOwners.ports.compensateAcquiredPortHolder?.(...args) ?? actual.compensateAcquiredPortHolder(...args),
        deriveEntrypoints: (...args: Parameters<typeof actual.deriveEntrypoints>) => applicationOwners.ports.deriveEntrypoints?.(...args) ?? actual.deriveEntrypoints(...args),
        observeRetainedPortFamily: (...args: Parameters<typeof actual.observeRetainedPortFamily>) => applicationOwners.ports.observeRetainedPortFamily?.(...args) ?? actual.observeRetainedPortFamily(...args),
        projectRetainedPortFamilyResult: (...args: Parameters<typeof actual.projectRetainedPortFamilyResult>) => applicationOwners.ports.projectRetainedPortFamilyResult?.(...args) ?? actual.projectRetainedPortFamilyResult(...args),
        releasePortFamily: (...args: Parameters<typeof actual.releasePortFamily>) => applicationOwners.ports.releasePortFamily?.(...args) ?? actual.releasePortFamily(...args),
    }
})
import { loadCockpitConfig } from '../config/load.js'
import { collectFailureLogs, runSleep, runUp } from './application/lifecycle.js'
import { type LifecycleRunContext } from './application/lifecycle-context.js'
import { readState, transactState, type StateRecord } from './state.js'
import { recordLifecycleStarted } from './lifecycle-stage.js'
import { createApplicationFixtureSupport } from '../../test-support/application-fixture.js'
// The digest of each file a fixture stack is started from, as lifecycle readiness reports it.
const RUNTIME_INPUTS = Object.freeze({ 'cockpit.toml': 'd'.repeat(64) })

const scratch: string[] = []
const gitDirectory = mkdtempSync(join(tmpdir(), 'cockpit-application-git-'))
const gitCanonicalPath = join(gitDirectory, 'git-executable')
const gitInvocationPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
writeFileSync(gitCanonicalPath, `#!/bin/sh\nexec ${JSON.stringify(gitInvocationPath)} "$@"\n`, { mode: 0o700 })
const gitExecutable = {
    canonicalPath: gitCanonicalPath,
    invocationPath: gitInvocationPath,
    sha256: createHash('sha256').update(readFileSync(gitCanonicalPath)).digest('hex'),
    executionMode: 'verified-path' as const,
}

function stubUpPlanner(planner: typeof import('../../test-support/lifecycle-planning.js').planUp): void {
    const inputs = new WeakMap<object, Parameters<typeof import('./lifecycle.js').admitUpProgress>[0]>()
    applicationOwners.lifecycle.admitUpProgress = (input) => {
        const authority = Object.freeze({}) as import('./lifecycle.js').UpPlanningAuthority
        inputs.set(authority, input)
        return { kind: 'admitted', authority }
    }
    applicationOwners.lifecycle.planAdmittedUp = ({ authority, completedServices }) => {
        const input = inputs.get(authority)
        if (!input) throw new Error('fixture up authority was not admitted')
        inputs.delete(authority)
        return planner({ ...input, completedServices })
    }
}

function stubColdStart(stackId: StackId, measuredMillis = 1_250, limitMillis = 30_000): void {
    applicationOwners.runtime.observeRuntimeServiceColdStart = () => ({
        code: 'MACHINE_COLD_START_EXCEEDED', owner: 'runtime-planning', stackId, source: 'api',
        observed: { state: 'available', value: measuredMillis, observedAt: new Date().toISOString() },
        expectation: { kind: 'maximum', value: limitMillis }, applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' }, remedy: 'restore the declared cold-start budget',
    } as never)
}

describe('lifecycle application contracts', () => {
    it('refuses lifecycle transfer when the previous holder reacquires after the port projection', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const previousHolder = `holder:${'f'.repeat(64)}:session` as const
        const now = new Date().toISOString()
        const lifecycleAddress = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, lifecycleAddress, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: now,
            value: {
                holderId: previousHolder, workBasisSha256: 'a'.repeat(64),
                operationGeneration: 'b'.repeat(64), completedServices: [],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const coordinationAddress = context.namespace.paths.coordination(context.stackId)
        await transactState(context.namespace, coordinationAddress, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: now,
            value: {
                holders: [
                    { holderId: context.holderId, checkoutId: context.checkoutId, claimedAt: now },
                    { holderId: previousHolder, checkoutId: context.checkoutId, claimedAt: now },
                ],
                lease: {
                    offset: lease.offset, ports: lease.ports, released: false,
                    declaration: { step: context.ports.step, count: context.ports.count, bases: { ...context.ports.bases } },
                },
                lastReleasedHolder: null,
            },
        }))
        stubUpPlanner(() => ({
            kind: 'noop', mode: 'resume',
            plan: {
                progress: { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64), completedServices: [] },
                diagnostics: [],
            },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 1,
            portOwnership: { holderId: context.holderId },
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: { services: [{ id: 'api' }] }, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: {
                    kind: 'complete', change: 'unchanged', holderId: context.holderId,
                    recordRevision: 0, lease, observation: 'resolved-listener-evidence-accepted',
                },
                projection: {
                    lease,
                    ownership: {
                        change: 'unchanged', holderId: context.holderId, recordRevision: 0,
                        holderCount: 1, holderIds: [context.holderId],
                    },
                    entrypoints: [],
                },
            } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'CLAIM_CO_TENANT',
            message: `lifecycle progress belongs to another active session; run \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config ${configPath}\` to resume it or \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config ${configPath}\` to release it`,
        }] })
        expect(await readState(lifecycleAddress)).toMatchObject({
            kind: 'complete', value: { value: { holderId: previousHolder } },
        })
    })

    it('refuses stale completed progress retained by an active co-tenant after one readiness round', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const previousHolder = `holder:${'f'.repeat(64)}:session` as const
        const lifecycleAddress = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, lifecycleAddress, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: previousHolder, workBasisSha256: 'a'.repeat(64),
                operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }],
            },
        }))
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        applicationOwners.runtime.revalidateRuntimeService = async ({ execute }) => {
            await execute({ id: 'api:status' } as never)
            return { kind: 'stale' } as never
        }
        const readinessCounts = { runtime: 0, stage: 0, ports: 0 }
        const executed: string[] = []

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => {
                readinessCounts.runtime += 1
                return use({ topology, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never)
            },
            withLifecycleStage: async (_context, use) => {
                readinessCounts.stage += 1
                return use({} as never)
            },
            withAcquiredPorts: async (_context, use) => {
                readinessCounts.ports += 1
                return use({
                    retainOnFailure: vi.fn(),
                    leaseResult: {
                        kind: 'complete', change: 'unchanged', holderId: context.holderId,
                        recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted',
                    },
                    projection: {
                        lease,
                        ownership: {
                            change: 'unchanged', holderId: context.holderId, recordRevision: 2,
                            holderCount: 2, holderIds: [context.holderId, previousHolder],
                        },
                        entrypoints: [],
                    },
                } as never)
            },
            execute: async (step) => {
                executed.push(step.id)
                return {} as never
            },
        })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [{
                code: 'CLAIM_CO_TENANT',
                message: 'completed lifecycle progress belongs to an active holder but its runtime evidence is stale',
                target: context.stackId,
            }],
        })
        expect(readinessCounts).toEqual({ runtime: 1, stage: 1, ports: 1 })
        expect(executed).toEqual(['api:status'])
        expect(await readState(lifecycleAddress)).toMatchObject({
            kind: 'complete', value: { value: { holderId: previousHolder } },
        })
    })

    it('surfaces failure to compensate the holder acquired by this invocation', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const leaseResult = Object.freeze({
            kind: 'complete' as const, change: 'acquired' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'acquired' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        stubUpPlanner(() => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_EVIDENCE_INVALID', message: 'invalid' }],
        } as never))
        applicationOwners.ports.compensateAcquiredPortHolder = async () => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'CLAIM_CO_TENANT', message: 'coordination changed', target: context.stackId }],
        })

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [
                { code: 'LIFECYCLE_EVIDENCE_INVALID' },
                { code: 'CLAIM_CO_TENANT', message: 'coordination changed' },
            ],
        })
    })

    it.each(['', 'holder:anything:session', 'holder:\0:session'])('rejects malformed persisted holder identity %j', async (persistedHolder) => {
        const { configPath, context } = await lifecycleContextFixture()
        const address = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, address, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: persistedHolder, workBasisSha256: 'a'.repeat(64),
                operationGeneration: 'b'.repeat(64), completedServices: [],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const leaseResult = Object.freeze({
            kind: 'complete' as const, change: 'unchanged' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'STATE_RECORD_MALFORMED' }] })
    })

    it('resets changed lifecycle work of a partial startup before revalidating its old containers', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const address = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, address, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: context.holderId, workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const leaseResult = Object.freeze({
            kind: 'complete' as const, change: 'unchanged' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        const events: string[] = []
        const plannerInputs: unknown[] = []
        applicationOwners.lifecycle.admitUpProgress = (input) => {
            plannerInputs.push(input)
            if (input.progress !== null) {
                events.push('admission-refusal')
                return { kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_PROGRESS_INVALID', message: 'work changed' }] }
            }
            events.push('reset-admission')
            return { kind: 'admitted', authority: Object.freeze({}) as never }
        }
        applicationOwners.lifecycle.planAdmittedUp = ({ completedServices }) => {
            events.push('reset-finalization')
            expect(completedServices).toEqual([])
            return {
                kind: 'execute', mode: 'start',
                plan: {
                    progress: { workBasisSha256: 'd'.repeat(64), operationGeneration: (plannerInputs[1] as { operationGeneration: string }).operationGeneration, completedServices: [] },
                    diagnostics: [],
                },
            } as never
        }
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId },
        } as never)
        applicationOwners.runtime.revalidateRuntimeService = async () => {
            events.push('revalidate')
            return { kind: 'failure' } as never
        }
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.runtime.startRuntimeService = async ({ execute }) => {
            for (const id of ['start', 'status', 'identity', 'inspect']) await execute({ id } as never)
            return { kind: 'observed', observation: { service: 'api', containerId: 'e'.repeat(64) } } as never
        }
        applicationOwners.runtime.admitRuntimeServiceHealth = (observation) => observation as never
        stubColdStart(context.stackId)

        await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: { services: [{ id: 'db' }, { id: 'api' }] }, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: async (step) => {
                if (step.id === 'start') {
                    events.push('start')
                    expect(await readState(address)).toMatchObject({
                        kind: 'complete',
                        value: {
                            value: {
                                workBasisSha256: 'd'.repeat(64),
                                operationGeneration: (plannerInputs[1] as { operationGeneration: string }).operationGeneration,
                                completedServices: [],
                            },
                        },
                    })
                }
                return {} as never
            },
        })

        expect(events).toEqual(['admission-refusal', 'reset-admission', 'reset-finalization', 'start'])
        expect(plannerInputs).toEqual([
            expect.objectContaining({ progress: { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64), completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }] } }),
            expect.objectContaining({ progress: null }),
        ])
    })

    // A fully started compose-first stack whose declaration changed was restarted from scratch, which
    // recreated healthy containers and stopped them when their labels no longer matched.
    it('refuses changed work on a fully started compose-first stack and starts nothing', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        await transactState(context.namespace, context.namespace.paths.lifecycle(context.stackId), { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: context.holderId, workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }],
                runtimeInputs: { 'cockpit.toml': 'd'.repeat(64), 'compose.yml': 'e'.repeat(64) },
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const projection = Object.freeze({
            lease, entrypoints: Object.freeze([]),
            ownership: Object.freeze({ change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2, holderCount: 1, holderIds: Object.freeze([context.holderId]) }),
        })
        const leaseResult = Object.freeze({ kind: 'complete' as const, change: 'unchanged' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const })
        applicationOwners.lifecycle.admitUpProgress = () => ({ kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_PROGRESS_INVALID', message: 'work changed' }] })
        const execute = vi.fn(async () => ({}) as never)

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: { services: [{ id: 'api' }] }, lifecycle: {}, hostObservations: [],
                inputs: { 'cockpit.toml': 'd'.repeat(64), 'compose.yml': 'f'.repeat(64) }, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute,
        })

        // The edit was to compose.yml, so the refusal names it rather than cockpit.toml.
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID',
            message: expect.stringContaining('services, ports, mounts or images: compose.yml changed since it started, and up does not replace a running stack') }] })
        expect(execute).not.toHaveBeenCalled()
    })

    it('resumes a completed dependency prefix in one readiness round', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const address = context.namespace.paths.lifecycle(context.stackId)
        const completedContainerId = 'c'.repeat(64)
        const observedAt = new Date().toISOString()
        expect(await recordLifecycleStarted({
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            observedAt,
        })).toMatchObject({ kind: 'complete' })
        await transactState(context.namespace, address, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: observedAt,
            value: {
                holderId: context.holderId, workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: completedContainerId }],
            },
        }))
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }, { id: 'web' }]) })
        let revalidated: unknown
        const events: string[] = []
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        stubUpPlanner((input) => {
            events.push('finalize')
            expect(input.progress).toMatchObject({ completedServices: [{ service: 'api', containerId: completedContainerId }] })
            expect(input.completedServices).toEqual([revalidated])
            expect(input.completedServices[0]).toBe(revalidated)
            return {
                kind: 'execute', mode: 'resume',
                plan: {
                    progress: {
                        workBasisSha256: 'a'.repeat(64),
                        operationGeneration: input.operationGeneration,
                        completedServices: [{ service: 'api', containerId: completedContainerId }],
                    },
                    diagnostics: [],
                },
            } as never
        })
        const admit = applicationOwners.lifecycle.admitUpProgress!
        applicationOwners.lifecycle.admitUpProgress = (input) => { events.push('admit'); return admit(input) }
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology,
            firstIncompleteServiceIndex: 1,
            portOwnership: { holderId: context.holderId },
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api', 'web']
        applicationOwners.runtime.revalidateRuntimeService = async ({ execute }) => {
            events.push('revalidate')
            for (const id of ['api:status', 'api:identity', 'api:inspect']) await execute({ id } as never)
            return { kind: 'observed', observation: { service: 'api', containerId: completedContainerId } } as never
        }
        applicationOwners.runtime.startRuntimeService = async ({ service, execute }) => {
            for (const stage of ['start', 'status', 'identity', 'inspect']) await execute({ id: `${service}:${stage}` } as never)
            return { kind: 'observed', observation: { service, containerId: 'd'.repeat(64) } } as never
        }
        applicationOwners.runtime.admitRuntimeServiceHealth = (observation) => {
            if (observation.service === 'api') revalidated = observation
            return observation as never
        }
        stubColdStart(context.stackId)
        const executed: string[] = []
        const readinessCounts = { runtime: 0, stage: 0, ports: 0 }

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => { readinessCounts.runtime += 1; return use({ topology, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never) },
            withLifecycleStage: async (_context, use) => { readinessCounts.stage += 1; return use({} as never) },
            withAcquiredPorts: async (_context, use) => { readinessCounts.ports += 1; return use({
                retainOnFailure: vi.fn(),
                leaseResult: {
                    kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2,
                    lease, observation: 'resolved-listener-evidence-accepted',
                },
                projection: {
                    lease,
                    ownership: {
                        change: 'unchanged', holderId: context.holderId, recordRevision: 2,
                        holderCount: 1, holderIds: [context.holderId],
                    },
                    entrypoints: [],
                },
            } as never) },
            execute: async (step) => {
                if (step.id === 'web:start') events.push('start')
                executed.push(step.id)
                return {} as never
            },
        })

        expect(events).toEqual(['admit', 'revalidate', 'finalize', 'start'])
        expect(readinessCounts).toEqual({ runtime: 1, stage: 1, ports: 1 })
        expect(result).toMatchObject({ kind: 'complete', result: { change: 'resumed' } })
        expect(executed).toEqual([
            'api:status', 'api:identity', 'api:inspect',
            'web:start', 'web:status', 'web:identity', 'web:inspect',
        ])
    })

    it('surfaces a failure log collection failure for a failed runtime service', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        const servicePlan = Object.freeze({ start: Object.freeze({ id: 'start' }) })
        const failureEvidence = Object.freeze({ service: 'api' })
        const logPlan = Object.freeze({ kind: 'planned' as const, step: Object.freeze({ id: 'logs' }) })
        stubUpPlanner((input) => ({
            kind: 'execute', mode: 'start',
            plan: { progress: { workBasisSha256: 'd'.repeat(64), operationGeneration: input.operationGeneration, completedServices: [] }, diagnostics: [] },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId },
        } as never)
        applicationOwners.runtime.startRuntimeService = async ({ execute }) => {
            await execute(servicePlan.start as never)
            return { kind: 'failure', logs: failureEvidence } as never
        }
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.logs.planFailureLogs = () => logPlan as never
        applicationOwners.logs.admitFailureLogs = () => ({ kind: 'unavailable', code: 'EXECUTION_TIMEOUT', service: 'api', records: [] }) as never

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2, lease },
                projection,
            } as never),
            execute: async () => ({}) as never,
        })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('failure log collection failed'), target: 'api',
                fix: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs logs --config ${configPath} --service api` })]),
        })
        // With no evidence at all there is nothing to plan from, and the diagnostic still names where the logs are.
        expect(await collectFailureLogs(undefined, 'api', { execute: vi.fn() }, configPath)).toEqual([expect.objectContaining({
            message: 'bounded failure logs are unavailable', target: 'api',
            fix: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs logs --config ${configPath} --service api` })])
    })

    // A failed up left the failing container restart-looping until down, and turned each of its
    // log lines into its own diagnostic.
    it('stops the service a failed up started and reports its logs as one bounded diagnostic', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        stubUpPlanner((input) => ({
            kind: 'execute', mode: 'start',
            plan: { progress: { workBasisSha256: 'd'.repeat(64), operationGeneration: input.operationGeneration, completedServices: [] }, diagnostics: [] },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId },
        } as never)
        applicationOwners.runtime.startRuntimeService = async ({ execute }) => {
            await execute({ id: 'start' } as never)
            return { kind: 'failure', logs: { service: 'api' }, stop: { id: 'stop' } } as never
        }
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.logs.planFailureLogs = () => ({ kind: 'planned', step: { id: 'logs' } } as never)
        const records = Array.from({ length: 69 }, (_, index) => ({ service: 'api',
            timestamp: '2026-09-10T08:00:00.000Z', stream: 'stderr', message: `record-${index}-${'x'.repeat(index === 68 ? 5_000 : 10)}` }))
        applicationOwners.logs.admitFailureLogs = () => ({ kind: 'complete', records } as never)
        const executed: string[] = []

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2, lease },
                projection,
            } as never),
            execute: async (step) => {
                executed.push(step.id)
                return { kind: step.id === 'stop' ? 'complete' : 'refusal' } as never
            },
        })

        expect(executed).toEqual(['start', 'logs', 'stop'])
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: 'LIFECYCLE_EVIDENCE_INVALID', target: 'api', message: 'runtime service did not become healthy' },
            { code: 'EXECUTION_STEP_FAILED', target: 'api', message: expect.stringContaining('69 log lines') },
        ] })
        expect(result.diagnostics).toHaveLength(2)
        const excerpt = result.diagnostics[1]!.message
        expect(excerpt).toContain('record-59-')
        expect(excerpt).toContain('record-68-')
        expect(excerpt).not.toContain('record-58-')
        expect(excerpt.length).toBeLessThan(4_096)
        expect(result.diagnostics[1]!.fix).toContain('stopped')
    })

    it('keeps the lease of a partial startup that reached Compose and completes from its durable prefix on the next invocation', async () => {
        const value = await unissuedContextFixture()
        const firstLoaded = await loadCockpitConfig(value.configPath)
        if (firstLoaded.kind !== 'complete') throw new Error('fixture configuration did not load')
        const identity = await runContextInput(value.candidate, firstLoaded.result)
        const firstIssued = await issueLifecycleContext(value.candidate, firstLoaded.result, identity, firstLoaded.result.source.path)
        const secondLoaded = await loadCockpitConfig(value.configPath)
        if (firstIssued.kind !== 'complete' || secondLoaded.kind !== 'complete') throw new Error('first lifecycle context was not issued')
        const secondIssued = await issueLifecycleContext(value.candidate, secondLoaded.result, identity, secondLoaded.result.source.path)
        if (secondIssued.kind !== 'complete') throw new Error('second lifecycle context was not issued')
        const firstContext = firstIssued.result
        const secondContext = secondIssued.result
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        const lease = Object.freeze({ stackId: firstContext.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const acquired = Object.freeze({
            kind: 'complete' as const, change: 'acquired' as const, holderId: firstContext.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const unchanged = Object.freeze({ ...acquired, change: 'unchanged' as const, recordRevision: 3 })
        const projection = (change: 'acquired' | 'unchanged', recordRevision: number) => Object.freeze({
            lease,
            ownership: Object.freeze({
                change, holderId: firstContext.holderId, recordRevision,
                holderCount: 1, holderIds: Object.freeze([firstContext.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        const workBasisSha256 = 'd'.repeat(64)
        let planning = 0
        stubUpPlanner((input) => {
            planning += 1
            return {
                kind: 'execute', mode: planning === 2 ? 'resume' : 'start',
                plan: {
                    progress: {
                        workBasisSha256,
                        operationGeneration: input.progress?.operationGeneration ?? input.operationGeneration,
                        completedServices: [],
                    },
                    diagnostics: [],
                },
            } as never
        })
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: firstContext.holderId },
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        let failing = true
        applicationOwners.runtime.startRuntimeService = async ({ execute }) => {
            if (failing) {
                await execute({ id: 'start' } as never)
                return { kind: 'failure', logs: { service: 'api' } } as never
            }
            for (const id of ['start', 'status', 'identity', 'inspect']) await execute({ id } as never)
            return { kind: 'observed', observation: { service: 'api', containerId: 'e'.repeat(64) } } as never
        }
        applicationOwners.runtime.admitRuntimeServiceHealth = (observation) => observation as never
        stubColdStart(firstContext.stackId)
        applicationOwners.logs.planFailureLogs = () => ({ kind: 'unavailable', code: 'LOG_EVIDENCE_INVALID', service: 'api' } as never)
        const compensate = vi.fn(async ({ leaseResult }) => {
            expect(leaseResult).toBe(acquired)
            return { kind: 'complete' as const, change: 'compensated' as const, recordRevision: 3, remainingHolderIds: [] }
        })
        applicationOwners.ports.compensateAcquiredPortHolder = compensate
        const readiness = async (_context: LifecycleRunContext, use: (value: unknown) => Promise<unknown>) => use({ topology, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] })
        const stage = async (_context: LifecycleRunContext, use: (value: unknown) => Promise<unknown>) => use({})

        const first = await runUp({ configPath: firstContext.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: firstContext }),
            withRuntimeReadiness: readiness,
            withLifecycleStage: stage,
            withAcquiredPorts: async (_context: never, use: (value: never) => Promise<unknown>) => use({ leaseResult: acquired, projection: projection('acquired', 2), retainOnFailure: vi.fn() } as never),
            execute: async () => ({}) as never,
        } as never)
        failing = false
        const executed: string[] = []
        const second = await runUp({ configPath: secondContext.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: secondContext }),
            withRuntimeReadiness: readiness,
            withLifecycleStage: stage,
            withAcquiredPorts: async (_context: never, use: (value: never) => Promise<unknown>) => use({ leaseResult: unchanged, projection: projection('unchanged', 3), retainOnFailure: vi.fn() } as never),
            execute: async (step: { id: string }) => {
                executed.push(step.id)
                return {} as never
            },
        } as never)

        expect(first).toMatchObject({
            kind: 'refusal',
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID' })]),
        })
        // The failed start may have left containers on the leased ports, so the holder keeps them.
        expect(compensate).not.toHaveBeenCalled()
        expect(second).toMatchObject({ kind: 'complete', result: { change: 'resumed' } })
        expect(executed).toEqual(['start', 'status', 'identity', 'inspect'])
        expect(await readState(secondContext.namespace.paths.lifecycle(secondContext.stackId))).toMatchObject({
            kind: 'complete',
            value: { value: { workBasisSha256, completedServices: [{ service: 'api', containerId: 'e'.repeat(64) }] } },
        })
    })

    it.each([
        ['an earlier hold from the same checkout', true, 'this-checkout'],
        ['a hold from another checkout', false, 'other-checkouts'],
    ] as const)('releases only the calling holder and reports %s as what retains the runtime', async (_case, sameCheckout, remaining) => {
        const { configPath, context } = await lifecycleContextFixture()
        const now = new Date().toISOString()
        await transactState(context.namespace, context.namespace.paths.coordination(context.stackId), { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: now,
            value: {
                holders: [{
                    holderId: `holder:${'f'.repeat(64)}:session`,
                    checkoutId: sameCheckout ? context.checkoutId : `checkout:${'e'.repeat(64)}`, claimedAt: now,
                }],
                lease: { offset: 0, ports: { APP_PORT: 4100 }, released: false,
                    declaration: { step: context.ports.step, count: context.ports.count, bases: { ...context.ports.bases } } },
                lastReleasedHolder: null,
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const retained = Object.freeze({ kind: 'complete' as const, holderId: context.holderId, recordRevision: 4, lease })
        const entrypointResult = Object.freeze({ kind: 'complete' as const, values: Object.freeze([]), diagnostics: Object.freeze([]) })
        const projection = Object.freeze({ ownership: Object.freeze({ holderId: context.holderId, holderCount: 2 }), entrypoints: Object.freeze([]) })
        applicationOwners.ports.observeRetainedPortFamily = async () => retained
        applicationOwners.ports.deriveEntrypoints = () => entrypointResult
        applicationOwners.ports.projectRetainedPortFamilyResult = async () => projection as never
        applicationOwners.ports.releasePortFamily = async () => ({ kind: 'complete', change: 'retained' })
        const execute = vi.fn()

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            execute,
        })

        expect(execute).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'complete', result: { stackId: context.stackId, change: 'retained', remainingHolders: remaining } })
    })

    it('stops the final-holder runtime, clears its startup progress, then releases the stack', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const events: string[] = []
        const now = new Date().toISOString()
        await transactState(context.namespace, context.namespace.paths.coordination(context.stackId), { ownerId: context.holderId }, (): StateRecord => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: context.cockpitId, subjectId: context.stackId,
            revision: 0, updatedAt: now, value: {
                holders: [{ holderId: context.holderId, checkoutId: context.checkoutId, claimedAt: now }],
                lease: { offset: 0, ports: { APP_PORT: 4100 }, released: false, declaration: { step: 100, count: 1, bases: { APP_PORT: 4100 } } },
                lastReleasedHolder: null,
            },
        }))
        await transactState(context.namespace, context.namespace.paths.lifecycle(context.stackId), { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId, subjectId: context.stackId,
            revision: 0, updatedAt: now, value: { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }], holderId: context.holderId },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        applicationOwners.ports.observeRetainedPortFamily = async () => ({
            kind: 'complete', holderId: context.holderId, recordRevision: 0, lease,
        }) as never
        applicationOwners.ports.deriveEntrypoints = () => ({ kind: 'complete', values: [], diagnostics: [] }) as never
        applicationOwners.ports.projectRetainedPortFamilyResult = async () => ({
            lease,
            ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 0, holderCount: 1, holderIds: [context.holderId] },
            entrypoints: [],
        }) as never
        applicationOwners.runtime.stopRuntime = async ({ execute }) => {
            await execute({ id: 'stop' } as never)
            await execute({ id: 'postcheck' } as never)
            return { kind: 'stopped' }
        }

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS, activeProfiles: [] } as never),
            execute: async (step) => {
                events.push(step.id)
                return {} as never
            },
        })

        expect(events).toEqual(['stop', 'postcheck'])
        expect(result).toMatchObject({ kind: 'complete', result: { stackId: context.stackId, change: 'stopped' } })
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({
            kind: 'complete', value: { value: { holderId: context.holderId, completedServices: [] } },
        })
        expect(await readState(context.namespace.paths.coordination(context.stackId))).toMatchObject({
            kind: 'complete', value: { value: { holders: [], lease: { released: true }, lastReleasedHolder: context.holderId } },
        })
    })
})

afterEach(() => {
    vi.restoreAllMocks()
    applicationOwners.lifecycle = {}
    applicationOwners.runtime = {}
    applicationOwners.logs = {}
    applicationOwners.ports = {}
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(gitDirectory, { recursive: true, force: true }))

const { unissuedContextFixture, runContextInput, lifecycleContextFixture, issueLifecycleContext } = createApplicationFixtureSupport(scratch, gitExecutable)
