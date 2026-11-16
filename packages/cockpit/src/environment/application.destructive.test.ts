import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cockpitCommand } from '../fix-catalogue.js'
const applicationOwners = vi.hoisted(() => ({
    runtime: {} as Partial<Pick<typeof import('./runtime.js'), 'stopRuntime'>>,
    reclaim: {} as Partial<Pick<typeof import('./reclaim.js'), 'keptTeardownResources' | 'planReset' | 'planTeardown'>>,
}))
vi.mock('./runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./runtime.js')>()
    return {
        ...actual,
        stopRuntime: (...args: Parameters<typeof actual.stopRuntime>) => applicationOwners.runtime.stopRuntime?.(...args) ?? actual.stopRuntime(...args),
    }
})
vi.mock('./reclaim.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./reclaim.js')>()
    return {
        ...actual,
        keptTeardownResources: (...args: Parameters<typeof actual.keptTeardownResources>) => applicationOwners.reclaim.keptTeardownResources?.(...args) ?? actual.keptTeardownResources(...args),
        planReset: (...args: Parameters<typeof actual.planReset>) => applicationOwners.reclaim.planReset?.(...args) ?? actual.planReset(...args),
        planTeardown: (...args: Parameters<typeof actual.planTeardown>) => applicationOwners.reclaim.planTeardown?.(...args) ?? actual.planTeardown(...args),
    }
})
import { beginOperatorReset, runDown, runReset } from './application/destructive.js'
import { issueDestructiveRunContext } from './application/lifecycle-context.js'
import { decodeCoordinationRecord, withStackTeardown } from './claims.js'
import { readState, transactState, type StateRecord } from './state.js'
import { resolveLifecycleStage } from './lifecycle-stage.js'
import { createApplicationFixtureSupport } from '../../test-support/application-fixture.js'

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

describe('destructive application contracts', () => {
    async function destructiveFixture(otherHolder = false) {
        const { configPath, context: lifecycle } = await lifecycleContextFixture()
        const candidate = Object.freeze({ stackId: lifecycle.stackId, checkoutId: lifecycle.checkoutId })
        const instance = Object.freeze({ served: candidate, launcher: candidate, claimInventory: Object.freeze([candidate]) })
        const issued = issueDestructiveRunContext({ lifecycle, instance })
        if (issued.kind !== 'complete') throw new Error('destructive context was not issued')
        const now = new Date().toISOString()
        const holders: { holderId: string; checkoutId: string; claimedAt: string; pid?: number }[] = [
            { holderId: issued.result.holderId, checkoutId: issued.result.checkoutId, claimedAt: now },
            ...otherHolder ? [{ holderId: `holder:${'9'.repeat(64)}:session`, checkoutId: `checkout:${'8'.repeat(64)}`, claimedAt: now, pid: 4242 }] : [],
        ]
        const seeded = await transactState(
            issued.result.namespace,
            issued.result.namespace.paths.coordination(issued.result.stackId),
            { ownerId: issued.result.holderId },
            (): StateRecord => ({
                format: 'cockpit-state/v1', kind: 'coordination', cockpitId: issued.result.cockpitId,
                subjectId: issued.result.stackId, revision: 0, updatedAt: now,
                value: {
                    holders,
                    lease: { offset: 0, ports: { APP_PORT: 4100 }, released: false,
                        declaration: { step: 100, count: 1, bases: { APP_PORT: 4100 } } },
                    lastReleasedHolder: null,
                },
            }),
        )
        if (seeded.kind !== 'complete') throw new Error('destructive coordination fixture was not seeded')
        return { configPath, context: issued.result, instance, record: seeded.value }
    }

    // The reclaim owners are stubbed, so the observation's discovery is an opaque stand-in.
    function observation(
        instance: Awaited<ReturnType<typeof destructiveFixture>>['instance'],
        coordinationRecord: StateRecord,
        resources: readonly object[] = [],
    ) {
        const observed = Object.freeze({ coordinationRecord, discovery: Object.freeze({ resources }) })
        return Object.freeze({ instance, runtime: Object.freeze({}), ports: Object.freeze({}), down: observed, reset: observed }) as never
    }

    const removal = (id: string) => Object.freeze({ kind: 'container', id, name: `synthetic-${id}`, step: Object.freeze({ id: `remove:${id}` }) })
    const resetPlan = (digest: string, noop = false) => Object.freeze({
        kind: 'complete', digest, noop,
        targets: Object.freeze(noop ? [] : [Object.freeze({ kind: 'volume', identity: 'synthetic-volume', declaration: 'data' })]),
        removals: Object.freeze(noop ? [] : [removal('volume-1')]),
    }) as never

    async function holders(context: Awaited<ReturnType<typeof destructiveFixture>>['context']) {
        const stored = await readState(context.namespace.paths.coordination(context.stackId))
        if (stored.kind !== 'complete') throw new Error('coordination record unavailable')
        return decodeCoordinationRecord(stored.value, context.stackId)?.holders.map(({ holderId }) => holderId)
    }

    it('returns reset preview data and nothing that can act on it', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => resetPlan('1'.repeat(64))
        const execute = vi.fn()

        const result = await runReset({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => observation(instance, record),
            execute,
        })

        expect(result).toMatchObject({
            kind: 'preview', result: { stackId: context.stackId, planDigest: '1'.repeat(64), noop: false },
        })
        expect(JSON.stringify(result)).not.toMatch(/removals|step|decide/)
        expect(execute).not.toHaveBeenCalled()
    })

    it.each([['down', runDown], ['reset', runReset]] as const)(
        'reports an unobservable %s precondition as evidence and runs nothing', async (_command, run) => {
            const { configPath, context } = await destructiveFixture()
            const execute = vi.fn()

            const result = await run({ configPath }, {
                load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
                observe: async () => undefined,
                execute,
            })

            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
            expect(execute).not.toHaveBeenCalled()
        })

    it('keeps a declined operator session one-shot and performs no destructive work', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => resetPlan('2'.repeat(64))
        const stop = vi.fn()
        applicationOwners.runtime.stopRuntime = stop
        const execute = vi.fn()

        const session = await beginOperatorReset({ configPath }, {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => observation(instance, record),
            execute,
        })
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('decline')).resolves.toMatchObject({ kind: 'refusal' })
        await expect(session.decide('approve')).resolves.toMatchObject({ kind: 'refusal' })

        expect(stop).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('completes an approved noop reset as unchanged without stopping the stack', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => resetPlan('7'.repeat(64), true)
        const stop = vi.fn()
        applicationOwners.runtime.stopRuntime = stop
        const execute = vi.fn()

        const session = await beginOperatorReset({ configPath }, {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => observation(instance, record), execute,
        })
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('approve')).resolves.toMatchObject({
            kind: 'complete', result: { stackId: context.stackId, change: 'unchanged' },
        })
        expect(stop).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('refuses an approved reset when the stack changed after the preview, and removes nothing', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        let calls = 0
        applicationOwners.reclaim.planReset = async () => resetPlan((calls++ === 0 ? '7' : '8').repeat(64))
        const stop = vi.fn()
        applicationOwners.runtime.stopRuntime = stop
        const execute = vi.fn()

        const session = await beginOperatorReset({ configPath }, {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => observation(instance, record), execute,
        })
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('approve')).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'RESET_CONFIRMATION_MISMATCH', fix: 'run reset again to see and approve the current targets' }],
        })
        expect(stop).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(await holders(context)).toEqual([context.holderId])
    })

    it('removes an approved reset\'s targets after stopping the stack, and releases it', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => resetPlan('5'.repeat(64))
        const events: string[] = []
        applicationOwners.runtime.stopRuntime = async () => { events.push('stop'); return { kind: 'stopped' } }

        const session = await beginOperatorReset({ configPath }, {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => observation(instance, record),
            observeReclaim: async () => observation(instance, record),
            execute: async (step) => { events.push(step.id); return { kind: 'complete' } as never },
        })
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('approve')).resolves.toMatchObject({
            kind: 'complete', result: { change: 'reset', targets: [{ kind: 'volume', identity: 'synthetic-volume' }] },
        })
        expect(events).toEqual(['stop', 'remove:volume-1'])
        expect(await holders(context)).toEqual([])
    })

    it.each([['down', runDown], ['reset', runReset]] as const)(
        'refuses %s while another session holds the stack, before stopping anything', async (command, run) => {
            const { configPath, context, instance, record } = await destructiveFixture(true)
            applicationOwners.reclaim.planReset = async () => resetPlan('4'.repeat(64))
            const stop = vi.fn()
            applicationOwners.runtime.stopRuntime = stop
            const adapters = {
                load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
                observe: async () => observation(instance, record),
                execute: vi.fn(),
            }
            if (command === 'down') {
                expect(await run({ configPath }, adapters)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CLAIM_CO_TENANT' }] })
            } else {
                const session = await beginOperatorReset({ configPath }, adapters)
                if (!('decide' in session)) throw new Error('operator reset session was not issued')
                expect(await session.decide('approve')).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CLAIM_CO_TENANT' }] })
            }
            expect(stop).not.toHaveBeenCalled()
            expect(adapters.execute).not.toHaveBeenCalled()
        })

    it('refuses while another sleep, down or reset of the stack runs, and runs nothing', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        const execute = vi.fn()
        const result = await withStackTeardown(context.namespace, context.stackId, context.holderId, () => runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => observation(instance, record),
            execute,
        }))
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'STATE_LOCKED', message: expect.stringContaining('a sleep, down or reset of this stack is running') }] })
        expect(execute).not.toHaveBeenCalled()
    })

    it('retires a stack that never started without writing a lifecycle record up would refuse', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        applicationOwners.reclaim.planTeardown = () => ({ kind: 'complete', targets: [removal('container-1')] }) as never
        // The discoveries here are opaque stand-ins, so the kept-resource classification is too.
        applicationOwners.reclaim.keptTeardownResources = () => []
        applicationOwners.runtime.stopRuntime = async () => ({ kind: 'stopped' })
        const stackInputs = join(dirname(configPath), '.cockpit/local/stack-inputs')
        mkdirSync(dirname(stackInputs), { recursive: true })
        writeFileSync(stackInputs, '{}')

        const result = await runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => observation(instance, record, [{ kind: 'container', id: 'container-1' }]),
            observeReclaim: async () => observation(instance, record),
            execute: async () => ({ kind: 'complete' }) as never,
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        expect(await holders(context)).toEqual([])
        // Nothing runs that a later doctor could call stale.
        expect(() => readFileSync(stackInputs)).toThrow()
        // Nothing ever started, so down leaves no lifecycle record and the next up starts afresh.
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({ kind: 'missing' })
        expect(await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString() }))
            .toMatchObject({ kind: 'complete', authority: { stage: 'bootstrap' } })
    })

    it('keeps the stack held when a removal reported success but a fresh discovery still lists it', async () => {
        const { configPath, context, instance, record } = await destructiveFixture()
        applicationOwners.reclaim.planTeardown = () => ({ kind: 'complete', targets: [removal('container-1')] }) as never
        applicationOwners.runtime.stopRuntime = async () => ({ kind: 'stopped' })
        const still = observation(instance, record, [{ kind: 'container', id: 'container-1' }])

        const result = await runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => still,
            observeReclaim: async () => still,
            execute: async () => ({ kind: 'complete' }) as never,
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'RECLAIM_ACCOUNTING_MISMATCH', message: expect.stringContaining('container synthetic-container-1 (container-1)'),
            fix: expect.stringContaining(cockpitCommand('down', { config: context.source.path })),
        }] })
        expect(await holders(context)).toEqual([context.holderId])
    })

    it('refuses to report the stack removed while a resource it owns remains, and names what it kept', async () => {
        const downWith = async (resources: (labels: Record<string, string>) => readonly object[]) => {
            const { configPath, context, instance, record } = await destructiveFixture()
            applicationOwners.reclaim.planTeardown = () => ({ kind: 'complete', targets: [] }) as never
            applicationOwners.runtime.stopRuntime = async () => ({ kind: 'stopped' })
            const observed = Object.freeze({
                stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.source.sha256,
                coordinationRecord: record, declaredCacheIds: [],
                discovery: { observedAt: new Date().toISOString(), producer: 'runtime-resource-discovery', resources: resources({
                    'dev.b0dea.cockpit.stack-id': context.stackId,
                    'dev.b0dea.cockpit.config-sha256': context.source.sha256,
                    'dev.b0dea.cockpit.owner-id': context.cockpitId,
                }) },
            })
            const result = await runDown({ configPath }, {
                load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
                observe: async () => Object.freeze({ instance, runtime: {}, ports: {}, down: observed, reset: observed }) as never,
                execute: async () => ({ kind: 'complete' }) as never,
            })
            return { result, context }
        }
        const volume = (labels: Record<string, string>) => ({ id: 'synthetic_data', name: 'synthetic_data', kind: 'volume', labels, referenced: false, bytes: null, dataBearing: true })
        const network = (labels: Record<string, string>) => ({ id: 'network-held', name: 'synthetic_default', kind: 'network', labels, referenced: true, bytes: null })

        // A volume stays for reset to remove, so it does not keep down from finishing.
        expect((await downWith((labels) => [volume(labels)])).result).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        const { result: kept, context } = await downWith((labels) => [volume(labels), network(labels)])

        expect(kept).toMatchObject({ kind: 'refusal', status: 2, result: null, diagnostics: [{
            code: 'DOWN_RESOURCES_KEPT', target: context.stackId,
            message: expect.stringContaining('network synthetic_default (network-held): a container outside this stack is still attached to it'),
            fix: expect.stringContaining(cockpitCommand('down', { config: context.source.path })),
        }] })
        expect(kept.diagnostics[0]!.message).not.toContain('synthetic_data')
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    applicationOwners.runtime = {}
    applicationOwners.reclaim = {}
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(gitDirectory, { recursive: true, force: true }))

const { lifecycleContextFixture } = createApplicationFixtureSupport(scratch, gitExecutable)
