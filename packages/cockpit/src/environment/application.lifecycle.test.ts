import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { executeForegroundProcess } from '../environment-exec/execute.js'
import { resolveExecutable } from './executable.js'
import type { StackId } from './contract.js'
const applicationOwners = vi.hoisted(() => ({
    lifecycle: {} as Partial<Pick<typeof import('./lifecycle.js'), 'admitUpProgress' | 'consumeLifecycleIssuance' | 'planAdmittedUp'>>,
    runtime: {} as Partial<Pick<typeof import('./runtime.js'), 'admitRuntimeServiceHealth' | 'observeRuntimeServiceColdStart' | 'resolveRuntimeServiceOrder' | 'startRuntimeService'>>,
    ports: {} as Partial<Pick<typeof import('./ports.js'), 'compensateAcquiredPortHolder'>>,
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
        startRuntimeService: (...args: Parameters<typeof actual.startRuntimeService>) => applicationOwners.runtime.startRuntimeService?.(...args) ?? actual.startRuntimeService(...args),
        observeRuntimeServiceColdStart: (...args: Parameters<typeof actual.observeRuntimeServiceColdStart>) => applicationOwners.runtime.observeRuntimeServiceColdStart?.(...args) ?? actual.observeRuntimeServiceColdStart(...args),
        resolveRuntimeServiceOrder: (...args: Parameters<typeof actual.resolveRuntimeServiceOrder>) => applicationOwners.runtime.resolveRuntimeServiceOrder?.(...args) ?? actual.resolveRuntimeServiceOrder(...args),
    }
})
vi.mock('./ports.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./ports.js')>()
    return {
        ...actual,
        compensateAcquiredPortHolder: (...args: Parameters<typeof actual.compensateAcquiredPortHolder>) => applicationOwners.ports.compensateAcquiredPortHolder?.(...args) ?? actual.compensateAcquiredPortHolder(...args),
    }
})
import { consumeLoadedConfigProjection, loadCockpitConfig, type LoadedCockpitConfig } from '../config/load.js'
import { runSleep, runSession, runUp } from './application/lifecycle.js'
import {
    withLifecycleConfiguration,
    type LifecycleRunContextInput,
    type LifecycleRunContext,
    type UpCommandAdapters,
} from './application/lifecycle-context.js'
import { readState } from './state.js'
import { recordLifecycleStarted, recordLifecycleSeeded, resolveLifecycleStage, projectLifecycleStage } from './lifecycle-stage.js'
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

function unavailableRuntimeUpAdapters(
    context: LifecycleRunContext,
    withRuntimeReadiness: UpCommandAdapters['withRuntimeReadiness'],
): Pick<UpCommandAdapters, 'withLifecycleStage' | 'withAcquiredPorts' | 'withRuntimeReadiness'> {
    const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({}) })
    return {
        withLifecycleStage: async (_context, use) => use({} as never),
        withAcquiredPorts: async (_context, use) => use({
            retainOnFailure: vi.fn(),
            leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 1, lease },
            projection: {
                lease,
                ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 1,
                    holderCount: 1, holderIds: [context.holderId] },
                entrypoints: [],
            },
        } as never),
        withRuntimeReadiness,
    }
}

describe('lifecycle application contracts', () => {
    it('keeps one foreground session active through exit and surfaces child and sleep failures together', async () => {
        const events: string[] = []
        const stack = `stack:${'1'.repeat(64)}` as StackId
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml',
            argv: ['synthetic-agent', '--work'],
            cwd: '/synthetic',
            env: { PATH: '/synthetic/bin', COCKPIT_SESSION_ID: '11111111-1111-4111-8111-111111111111' },
        }, {
            up: async () => {
                events.push('up')
                return { kind: 'complete', status: 0, diagnostics: [], result: { stackId: stack, change: 'started', ports: {}, entrypoints: [] } }
            },
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '2'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async input => {
                events.push('child')
                expect(input.argv).toEqual(['--work'])
                expect(input.env.COCKPIT_SESSION_ID).toBe('11111111-1111-4111-8111-111111111111')
                return { kind: 'complete', exitCode: 7, signal: null, terminationConfirmed: true }
            },
            sleep: async () => {
                events.push('sleep')
                return { kind: 'refusal', status: 2, result: null, diagnostics: [{
                    severity: 'error', code: 'CLAIM_CO_TENANT', message: 'synthetic ownership changed', target: stack,
                }] }
            },
        })

        expect(events).toEqual(['up', 'child', 'sleep'])
        expect(outcome).toMatchObject({
            kind: 'refusal', status: 2, result: null,
            diagnostics: [{ code: 'EXECUTION_STEP_FAILED' }, { code: 'CLAIM_CO_TENANT' }],
        })
    })

    it.each([
        ['a nonzero exit', 'exit 7', 7, { exitCode: 7, signal: null }],
        ['a signal', 'kill -TERM $$', 143, { signal: 'SIGTERM' }],
    ] as const)('ends normally with the supervised command status after %s', async (_case, script, status, child) => {
        const stack = `stack:${'7'.repeat(64)}` as StackId
        const sleep = vi.fn(async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [],
            result: { stackId: stack, change: 'stopped' as const } }))
        const env = { PATH: '/usr/bin:/bin' }
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['sh', '-c', script], cwd: tmpdir(), env,
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', ports: {}, entrypoints: [],
            } }),
            resolveExecutable: (name) => resolveExecutable(name, env),
            executeForeground: executeForegroundProcess,
            sleep,
        })

        expect(sleep).toHaveBeenCalledOnce()
        expect(outcome).toMatchObject({ kind: 'complete', status, diagnostics: [],
            result: { child, sleep: { change: 'stopped' } } })
    })

    it('says why the stack keeps running when another holder outlives the session', async () => {
        const stack = `stack:${'8'.repeat(64)}` as StackId
        const env = { PATH: '/usr/bin:/bin' }
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['sh', '-c', 'exit 0'], cwd: tmpdir(), env,
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'unchanged', ports: {}, entrypoints: [],
            } }),
            resolveExecutable: (name) => resolveExecutable(name, env),
            executeForeground: executeForegroundProcess,
            sleep: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { stackId: stack, change: 'retained' } }),
        })

        expect(outcome).toMatchObject({ kind: 'complete', status: 0, result: { sleep: { change: 'retained' } },
            diagnostics: [{ severity: 'info', code: 'SESSION_STACK_RETAINED', target: stack,
                fix: 'run npx --no cockpit sleep --config <your cockpit.toml> to release this checkout\'s remaining hold' }] })
    })

    it('hands the supervised command the leased ports and entrypoints, over values its caller set', async () => {
        const stack = `stack:${'9'.repeat(64)}` as StackId
        const children: Readonly<Record<string, string>>[] = []
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic',
            env: { PATH: '/synthetic/bin', SHOP_HOST_PORT: '80', COCKPIT_ENTRYPOINT_APPLICATION: 'http://stale.localhost/' },
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', ports: { SHOP_HOST_PORT: 8180, ADMIN_HOST_PORT: 8181 },
                entrypoints: [
                    { name: 'shop-host-port', kind: 'entrypoint', port: 'SHOP_HOST_PORT', value: 'http://127.0.0.1:8180/' },
                    { name: 'admin-host-port', kind: 'entrypoint', port: 'ADMIN_HOST_PORT', value: 'http://127.0.0.1:8181/' },
                    { name: 'application', kind: 'origin', port: 'ADMIN_HOST_PORT', value: 'https://app.sample.localhost:8181/' },
                ],
            } }),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '9'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async input => {
                children.push(input.env)
                return { kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true }
            },
            sleep: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { stackId: stack, change: 'stopped' } }),
        })

        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
        expect(children).toEqual([{
            PATH: '/synthetic/bin',
            SHOP_HOST_PORT: '8180',
            ADMIN_HOST_PORT: '8181',
            COCKPIT_ENTRYPOINT_SHOP_HOST_PORT: 'http://127.0.0.1:8180/',
            COCKPIT_ENTRYPOINT_ADMIN_HOST_PORT: 'http://127.0.0.1:8181/',
            COCKPIT_ENTRYPOINT_APPLICATION: 'https://app.sample.localhost:8181/',
        }])
    })

    it('runs a relative command path from its working directory and refuses one that escapes it or is missing', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-session-relative-')))
        try {
            mkdirSync(join(root, 'work', 'node_modules', '.bin'), { recursive: true })
            writeFileSync(join(root, 'work', 'node_modules', '.bin', 'tool'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
            writeFileSync(join(root, 'outside'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
            const stack = `stack:${'8'.repeat(64)}` as StackId
            const env = { PATH: '/usr/bin:/bin' }
            const up = vi.fn(async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: {
                stackId: stack, change: 'started' as const, ports: {}, entrypoints: [] } }))
            const sleep = vi.fn(async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [],
                result: { stackId: stack, change: 'stopped' as const } }))
            const session = (argv0: string) => runSession({ configPath: '/synthetic/cockpit.toml', argv: [argv0], cwd: join(root, 'work'), env },
                { up, sleep, resolveExecutable: (name) => resolveExecutable(name, env), executeForeground: executeForegroundProcess })

            expect(await session('./node_modules/.bin/tool')).toMatchObject({ kind: 'complete', status: 3, result: { child: { exitCode: 3 } } })
            expect(up).toHaveBeenCalledOnce()
            for (const [argv0, reason] of [['../outside', /outside the session working directory/], ['./node_modules/.bin/missing', /unavailable/]] as const) {
                expect(await session(argv0)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EXECUTION_PRECONDITION_CHANGED',
                    message: expect.stringMatching(reason), target: argv0, fix: expect.stringContaining('name the command after --') }] })
            }
            expect(up).toHaveBeenCalledOnce()
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('preserves lifecycle ownership when the owned session process group cannot be confirmed stopped', async () => {
        const sleep = vi.fn()
        const stack = `stack:${'3'.repeat(64)}` as StackId
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic', env: { PATH: '/synthetic/bin' },
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', ports: {}, entrypoints: [],
            } }),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '4'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => ({ kind: 'refusal', code: 'EXECUTION_TERMINATION_UNCONFIRMED',
                exitCode: 1, signal: null, started: true, terminationConfirmed: false }),
            sleep,
        })

        expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EXECUTION_TERMINATION_UNCONFIRMED' }] })
        expect(sleep).not.toHaveBeenCalled()
    })

    it('returns the cancellation status only after releasing confirmed session ownership', async () => {
        const stack = `stack:${'5'.repeat(64)}` as StackId
        // A co-tenant keeps the stack, but the session's own hold is gone; "cleanup retained" read
        // as the hold having been kept.
        const sleep = vi.fn(async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [],
            result: { stackId: stack, change: 'retained' as const } }))
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic', env: { PATH: '/synthetic/bin' },
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', ports: {}, entrypoints: [],
            } }),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '6'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => ({ kind: 'refusal', code: 'EXECUTION_ABORTED',
                exitCode: 130, signal: 'SIGINT', started: true, terminationConfirmed: true }),
            sleep,
        })

        expect(sleep).toHaveBeenCalledOnce()
        expect(outcome).toMatchObject({ kind: 'refusal', status: 130, diagnostics: [{
            code: 'EXECUTION_ABORTED', message: expect.stringContaining('its hold was released and another holder keeps the stack running'),
        }] })

        const controller = new AbortController()
        controller.abort()
        const up = vi.fn()
        const cancelledBeforeUp = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic', env: { PATH: '/synthetic/bin' },
        }, { up, sleep, resolveExecutable: vi.fn(), executeForeground: vi.fn(), signal: controller.signal } as never)
        expect(cancelledBeforeUp).toMatchObject({
            kind: 'refusal', status: 130, diagnostics: [{ code: 'EXECUTION_ABORTED' }],
        })
        expect(up).not.toHaveBeenCalled()
    })

    it('acquires ports before runtime readiness and compensates a newly acquired holder when readiness fails', async () => {
        const { context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_HOST_PORT: 4100 }) })
        const leaseResult = Object.freeze({ kind: 'complete' as const, change: 'acquired' as const,
            holderId: context.holderId, recordRevision: 2, lease })
        const projection = Object.freeze({ lease, ownership: Object.freeze({ change: 'acquired' as const,
            holderId: context.holderId, recordRevision: 2, holderCount: 1, holderIds: Object.freeze([context.holderId]) }),
            entrypoints: Object.freeze([]) })
        const events: string[] = []
        const compensate = vi.fn(async () => {
            events.push('compensate')
            return { kind: 'complete' as const, change: 'compensated' as const, recordRevision: 3, remainingHolderIds: [] }
        })
        applicationOwners.ports.compensateAcquiredPortHolder = compensate
        const result = await runUp({ configPath: context.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withLifecycleStage: async (_context: typeof context, use: (stage: never) => Promise<unknown>) => use({} as never),
            withAcquiredPorts: async (
                _context: typeof context,
                use: (ports: { leaseResult: typeof leaseResult; projection: typeof projection; retainOnFailure: () => void }) => Promise<unknown>,
            ) => { events.push('ports'); return use({ leaseResult, projection, retainOnFailure: vi.fn() }) },
            withRuntimeReadiness: async (_context: typeof context, _use: unknown, currentPorts: typeof projection) => {
                events.push('readiness')
                expect(currentPorts).toBe(projection)
                return undefined
            },
            execute: vi.fn(),
        } as never)
        expect(result).toMatchObject({ kind: 'refusal' })
        expect(events).toEqual(['ports', 'readiness', 'compensate'])
        expect(compensate).toHaveBeenCalledOnce()
    })

    it('reissues exact lifecycle configuration to independent leaf owners', async () => {
        const { context } = await lifecycleContextFixture()
        await runUp({ configPath: context.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            ...unavailableRuntimeUpAdapters(context, async () => undefined),
        } as never)
        for (let index = 0; index < 2; index += 1) {
            const consumed = await withLifecycleConfiguration(context, async (configuration) => {
                const loaded = consumeLoadedConfigProjection(configuration)
                expect(consumeLoadedConfigProjection(configuration)).toBeUndefined()
                return loaded
            })
            expect(consumed?.source).toEqual(context.source)
            expect(consumed?.config.cockpit.name).toBeTruthy()
        }
    })

    it('invalidates escaped lifecycle configuration after callback success or failure', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const returned = await withLifecycleConfiguration(context, async (configuration) => configuration)
        let retained: LoadedCockpitConfig | undefined
        await expect(withLifecycleConfiguration(context, async (configuration) => {
            retained = configuration
            throw new Error('leaf refused')
        })).rejects.toThrow('leaf refused')
        writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n# later source revision\n')
        expect(returned).toBeDefined()
        expect(retained).toBeDefined()
        expect(consumeLoadedConfigProjection(returned!)).toBeUndefined()
        expect(consumeLoadedConfigProjection(retained!)).toBeUndefined()
    })

    it('refuses copied lifecycle configuration handles and current source drift', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const use = vi.fn(async (configuration: LoadedCockpitConfig) => consumeLoadedConfigProjection(configuration))
        const getter = vi.fn(() => configPath)
        const copied = { ...context }
        Object.defineProperty(copied, 'configPath', { get: getter })
        expect(await withLifecycleConfiguration(copied, use)).toBeUndefined()
        expect(getter).not.toHaveBeenCalled()
        writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n# changed source bytes\n')
        expect(await withLifecycleConfiguration(context, use)).toBeUndefined()
        expect(use).not.toHaveBeenCalled()
    })

    it.each([['up', runUp], ['sleep', runSleep]] as const)('preserves an unavailable %s context as a refusal', async (_command, run) => {
        const refusal = Object.freeze({
            kind: 'refusal' as const,
            status: 2 as const,
            result: null,
            diagnostics: Object.freeze([{ severity: 'error' as const, code: 'STATE_ROOT_UNAVAILABLE' as const, message: 'unavailable' }]),
        })

        await expect(run(
            { configPath: '/synthetic/cockpit.toml' },
            { load: async () => refusal } as never,
        )).resolves.toBe(refusal)
    })

    it('accepts an exact loaded configuration once and rejects replay', async () => {
        const value = await unissuedContextFixture()
        const fresh = await loadCockpitConfig(value.configPath)
        if (fresh.kind !== 'complete') throw new Error('fixture configuration did not reload')
        const identity = await runContextInput(value.candidate, fresh.result)
        const issued = await issueLifecycleContext(value.candidate, fresh.result, identity, fresh.result.source.path)
        expect(issued.kind).toBe('complete')
        if (issued.kind !== 'complete') throw new Error('lifecycle context was not issued')
        const load = async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: issued.result })
        const unavailableReadiness: UpCommandAdapters['withRuntimeReadiness'] = async () => undefined

        const copied = await runUp(
            { configPath: fresh.result.source.path },
            { load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { ...issued.result } }),
                ...unavailableRuntimeUpAdapters(issued.result, unavailableReadiness) } as never,
        )
        const swapped = await runSleep(
            { configPath: join(resolve(fresh.result.source.path, '..'), 'other.toml') },
            { load } as never,
        )
        const first = await runUp({ configPath: fresh.result.source.path }, { load,
            ...unavailableRuntimeUpAdapters(issued.result, unavailableReadiness) } as never)
        const replay = await runUp({ configPath: fresh.result.source.path }, { load,
            ...unavailableRuntimeUpAdapters(issued.result, unavailableReadiness) } as never)

        expect(copied).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(swapped).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(first).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID', target: identity.stackId }] })
        expect(replay).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID', target: fresh.result.source.path }] })
    })

    it('leaves other cockpits\' unreadable namespaces to doctor, and says nothing about them on up or sleep', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        // A machine that ran older development builds carries several such directories; naming them
        // on every up (and so every session) buried each result under lines about other cockpits.
        // Doctor names them once, with one cleanup command.
        const cockpits = dirname(context.namespace.cockpitRoot)
        const legacy = [`cockpit:legacy:${'a'.repeat(64)}`, `cockpit:legacy:${'b'.repeat(64)}`].map(name => join(cockpits, name))
        for (const path of legacy) mkdirSync(path, { recursive: true, mode: 0o700 })

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            ...unavailableRuntimeUpAdapters(context, async () => undefined),
        } as never)

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID' })] })
        expect(result.diagnostics.filter(({ code }) => code === 'STATE_RECORD_MALFORMED')).toEqual([])

        const sleeping = await lifecycleContextFixture()
        for (const path of legacy) mkdirSync(join(dirname(sleeping.context.namespace.cockpitRoot), basename(path)), { recursive: true, mode: 0o700 })
        const slept = await runSleep({ configPath: sleeping.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: sleeping.context }),
        } as never)
        expect(slept.diagnostics.filter(({ code, severity }) => code === 'STATE_RECORD_MALFORMED' && severity === 'warning')).toEqual([])
    })

    it('refuses before execution when runtime readiness is absent', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const execute = vi.fn()
        const withRuntimeReadiness = vi.fn(async () => undefined)

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            execute,
            ...unavailableRuntimeUpAdapters(context, withRuntimeReadiness),
        } as never)

        expect(withRuntimeReadiness).toHaveBeenCalledOnce()
        expect(execute).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('rejects checkout/configuration mismatch and accessor inputs', async () => {
        const first = await unissuedContextFixture()
        const second = await unissuedContextFixture()
        const firstLoaded = await loadCockpitConfig(first.configPath)
        const secondLoaded = await loadCockpitConfig(second.configPath)
        if (firstLoaded.kind !== 'complete' || secondLoaded.kind !== 'complete') throw new Error('fixture configuration did not load')
        const identity = await runContextInput(first.candidate, firstLoaded.result)

        const mismatched = await issueLifecycleContext(first.candidate, secondLoaded.result, identity, secondLoaded.result.source.path)
        const fresh = await loadCockpitConfig(first.configPath)
        if (fresh.kind !== 'complete') throw new Error('fixture configuration did not reload')
        const accessor = await issueLifecycleContext(first.candidate, fresh.result, identity, fresh.result.source.path, (input) => {
            const hostile = { ...input } as Record<string, unknown>
            Object.defineProperty(hostile, 'stackId', { enumerable: true, get: () => input.stackId })
            return hostile as unknown as LifecycleRunContextInput
        })
        const substitutedSource = await loadCockpitConfig(first.configPath)
        if (substitutedSource.kind !== 'complete') throw new Error('fixture configuration did not reload')
        const substituted = await issueLifecycleContext(
            first.candidate,
            substitutedSource.result,
            identity,
            join(resolve(first.configPath, '..'), 'other.toml'),
        )

        expect(mismatched).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(accessor).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(substituted).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('refuses missing persisted progress after lifecycle history was seeded', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const observedAt = new Date().toISOString()
        expect(await recordLifecycleStarted({ namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, observedAt })).toMatchObject({ kind: 'complete' })
        expect(await recordLifecycleSeeded({ namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, observedAt })).toMatchObject({ kind: 'complete' })
        const planner = vi.fn()
        stubUpPlanner(planner)
        const execute = vi.fn()
        const lease = { stackId: context.stackId, offset: 0, ports: { APP_PORT: 4100 } }
        const ownership = { change: 'unchanged', holderId: context.holderId,
            recordRevision: 2, holderCount: 1, holderIds: [context.holderId] }
        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS } as never),
            withLifecycleStage: async (_context, use) => {
                const stage = await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString() })
                if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
                const projection = projectLifecycleStage({ authority: stage.authority, stackId: context.stackId,
                    cockpitId: context.cockpitId, earliest: Date.parse(stage.authority.observedAt),
                    latest: Date.parse(stage.authority.validThrough), evaluatedAt: Date.now() })
                if (!projection) throw new Error('fixture lifecycle stage projection was refused')
                return use(projection)
            },
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', lease, change: 'unchanged', holderId: context.holderId, recordRevision: 2 },
                projection: { lease, ownership, entrypoints: [] },
            } as never),
            execute,
        })
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID' }] })
        expect(planner).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({ kind: 'missing' })
    })

    it.each([
        ['within budget', 1_250, 30_000, 'complete'],
        ['over budget', 30_049, 30_000, 'refusal'],
    ] as const)('commits empty progress before service work and reports a cold start %s', async (_case, measuredMillis, limitMillis, expectedKind) => {
        const { configPath, context } = await lifecycleContextFixture()
        const containerId = '2'.repeat(64)
        const entrypoints = Object.freeze([{ name: 'app', kind: 'entrypoint' as const, port: 'APP_PORT', value: 'http://127.0.0.1:4100/' }])
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const plan = Object.freeze({
            verb: 'up' as const,
            progress: Object.freeze({ workBasisSha256: '3'.repeat(64), operationGeneration: '1'.repeat(64), completedServices: Object.freeze([]) }),
            steps: Object.freeze([]), resumeBoundary: Object.freeze({ completedStepIds: Object.freeze([]), nextStepId: 'service' }),
            compensation: Object.freeze([]), diagnostics: Object.freeze([]),
        })
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        const steps = Object.freeze({ start: Object.freeze({ id: 'start' }), status: Object.freeze({ id: 'status' }), identity: Object.freeze({ id: 'identity' }), inspect: Object.freeze({ id: 'inspect' }) })
        const observation = Object.freeze({ service: 'api', containerId })
        const evidence = Object.freeze({ service: 'api', containerId })
        stubUpPlanner(() => ({ kind: 'execute', mode: 'start', plan } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({ topology, firstIncompleteServiceIndex: 0, portOwnership: {}, drainRequest: null, reclaim: null } as never)
        applicationOwners.runtime.startRuntimeService = async ({ execute }) => {
            for (const step of [steps.start, steps.status, steps.identity, steps.inspect]) await execute(step as never)
            return { kind: 'observed', observation } as never
        }
        applicationOwners.runtime.admitRuntimeServiceHealth = () => evidence as never
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        stubColdStart(context.stackId, measuredMillis, limitMillis)
        const executed: string[] = []
        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
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
                    entrypoints,
                },
            } as never),
            execute: async (step) => {
                if (step === steps.start) {
                    expect(await readState(context.namespace.paths.lifecycle(context.stackId)))
                        .toMatchObject({ kind: 'complete', value: { value: { completedServices: [] } } })
                }
                executed.push(step.id)
                return {} as never
            },
        })

        expect(result).toMatchObject(expectedKind === 'complete'
            ? { kind: 'complete', result: { change: 'started', ports: { APP_PORT: 4100 }, entrypoints,
                coldStart: { measuredMillis, limitMillis, headroomMillis: limitMillis - measuredMillis } } }
            : { kind: 'refusal', diagnostics: [{ code: 'MACHINE_COLD_START_EXCEEDED', target: 'api',
                message: 'the runtime took 30.049 s to start its services, over the 30 s that environment.machine.cold_start_seconds allows',
                fix: expect.stringContaining('raise environment.machine.cold_start_seconds') }] })
        expect(executed).toEqual(['start', 'status', 'identity', 'inspect'])
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({
            kind: 'complete', value: { value: { holderId: context.holderId, completedServices: [{ service: 'api', containerId }] } },
        })
        // Only a successful first up seeds durable history; a refused cold start remains bootstrap.
        expect(await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString() }))
            .toMatchObject({ kind: 'complete', authority: { stage: expectedKind === 'complete' ? 'steady' : 'bootstrap' } })
    })

    it.each(['stack', 'holder'] as const)('rejects an acquired lease paired with another %s', async (mismatch) => {
        const { configPath, context } = await lifecycleContextFixture()
        const otherHolder = `holder:${'f'.repeat(64)}:session`
        const lease = Object.freeze({
            stackId: mismatch === 'stack' ? `stack:${'e'.repeat(64)}` : context.stackId,
            offset: 0,
            ports: Object.freeze({ APP_PORT: 4100 }),
        })
        const leaseResult = Object.freeze({
            kind: 'complete' as const,
            change: 'acquired' as const,
            holderId: mismatch === 'holder' ? otherHolder : context.holderId,
            recordRevision: 2,
            lease,
            observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease: Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) }),
            ownership: Object.freeze({
                change: 'acquired' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        stubUpPlanner(() => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_EVIDENCE_INVALID', message: 'invalid' }],
        } as never))
        const compensate = vi.fn(async () => ({ kind: 'complete' as const, change: 'compensated' as const, recordRevision: 3, remainingHolderIds: [] }))
        applicationOwners.ports.compensateAcquiredPortHolder = compensate

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {}, hostObservations: [], inputs: RUNTIME_INPUTS } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(compensate).not.toHaveBeenCalled()
    })
})

afterEach(() => {
    vi.restoreAllMocks()
    applicationOwners.lifecycle = {}
    applicationOwners.runtime = {}
    applicationOwners.ports = {}
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(gitDirectory, { recursive: true, force: true }))

const { derivedRegistrySource, unissuedContextFixture, runContextInput, lifecycleContextFixture, issueLifecycleContext } = createApplicationFixtureSupport(scratch, gitExecutable)
