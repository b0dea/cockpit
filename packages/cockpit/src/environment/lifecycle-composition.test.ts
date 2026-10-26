import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { decodeLifecycleRecord, runDoctor, runSession, runSleep, runUp } from './application.js'
import type { ExecutionStep } from './contract.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { recordLifecycleStarted, resolveLifecycleStage } from './lifecycle-stage.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { readState } from './state.js'
import { admitDependencyRuntime, createDependencyRuntimePlan } from './dependency-runtime.js'
import { observeDependencyLoad } from './installs.js'
import { generatedApplicationProjection } from './generated-application.js'
import { checkoutId } from './identity.js'
import {
    issueRuntimeMeasurementProbeAuthority,
    observeDockerRuntime,
    projectDependencyRuntime,
    resolveRuntimeServiceOrder,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { createLifecycleCompositionFixtureSupport } from '../../test-support/lifecycle-composition-fixture.js'

const run = promisify(execFile)
const roots: string[] = []

const listenerProbeControl = vi.hoisted(() => ({
    enabled: false,
    active: 0,
    maximumActive: 0,
    calls: 0,
    delayMs: 0,
}))

vi.mock('node:net', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:net')>()
    const { EventEmitter } = await import('node:events')
    const createConnection: typeof actual.createConnection = ((..._arguments: Parameters<typeof actual.createConnection>) => {
        if (!listenerProbeControl.enabled) return actual.createConnection(..._arguments)
        listenerProbeControl.calls += 1
        listenerProbeControl.active += 1
        listenerProbeControl.maximumActive = Math.max(listenerProbeControl.maximumActive, listenerProbeControl.active)
        const socket = new EventEmitter() as ReturnType<typeof actual.createConnection>
        let finished = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        let result: ReturnType<typeof setTimeout> | undefined
        socket.destroy = (() => {
            if (!finished) {
                finished = true
                listenerProbeControl.active -= 1
            }
            if (timeout) clearTimeout(timeout)
            if (result) clearTimeout(result)
            return socket
        }) as typeof socket.destroy
        socket.setTimeout = ((milliseconds: number, callback?: () => void) => {
            if (callback) timeout = setTimeout(callback, milliseconds)
            return socket
        }) as typeof socket.setTimeout
        result = setTimeout(() => {
            const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
            socket.emit('error', error)
        }, listenerProbeControl.delayMs)
        return socket
    }) as typeof actual.createConnection
    return { ...actual, createConnection }
})

afterEach(async () => {
    expect(listenerProbeControl.active, 'listener probes must settle before fixture cleanup').toBe(0)
    listenerProbeControl.enabled = false
    listenerProbeControl.active = 0
    listenerProbeControl.maximumActive = 0
    listenerProbeControl.calls = 0
    listenerProbeControl.delayMs = 0
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const { fixture, generatedFixture, configureGeneratedDocker, runGeneratedScenario } = createLifecycleCompositionFixtureSupport(roots, listenerProbeControl)

describe('production lifecycle adapter composition', () => {
    it('releases a supervised co-tenant without stopping the original holder runtime', async () => {
        const scenario = await runGeneratedScenario()
        expect(scenario.result, JSON.stringify(scenario.result)).toMatchObject({ kind: 'complete', status: 0 })
        const env = { PATH: `${scenario.candidate.root}:/usr/bin:/bin`, HOME: scenario.candidate.home,
            COCKPIT_SESSION_ID: '11111111-1111-4111-8111-111111111111' }
        const sessionSteps: ExecutionStep[] = []
        const sessionAdapters = createLifecycleCommandAdapters({
            configPath: scenario.candidate.configPath,
            env,
            sessionId: env.COCKPIT_SESSION_ID,
            timeoutMs: 5_000,
        }, async step => {
            sessionSteps.push(step)
            return executeProbe(step)
        })
        const sessionContext = await sessionAdapters.load({ configPath: scenario.candidate.configPath })
        expect(sessionContext.kind).toBe('complete')
        if (sessionContext.kind !== 'complete') return
        expect(scenario.context.holderId).not.toBe(sessionContext.result.holderId)

        const wrapped = await runSession({
            configPath: scenario.candidate.configPath,
            argv: ['synthetic-agent'],
            cwd: scenario.candidate.checkout,
            env,
        }, {
            up: input => runUp(input, sessionAdapters),
            sleep: input => runSleep(input, sessionAdapters),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: process.execPath, invocationPath: process.execPath,
                sha256: '1'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => ({ kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true }),
        })

        expect(wrapped, JSON.stringify(wrapped)).toMatchObject({
            kind: 'complete', result: { sleep: { stackId: scenario.context.stackId, change: 'retained' } },
        })
        expect(sessionSteps.some(({ id }) => id.includes(':stop:'))).toBe(false)

        const retained = await readState(sessionContext.result.namespace.paths.lifecycle(sessionContext.result.stackId))
        expect(retained.kind).toBe('complete')
        if (retained.kind === 'complete') {
            expect(decodeLifecycleRecord(retained.value, sessionContext.result)?.value.holderId)
                .toBe(scenario.context.holderId)
        }

        const rejoined = await runUp({ configPath: scenario.candidate.configPath }, sessionAdapters)
        expect(rejoined, JSON.stringify(rejoined)).toMatchObject({ kind: 'complete', result: { change: 'unchanged' } })
    })

    // This handoff deliberately reacquires authority across seven loads and five lifecycle calls.
    it('hands an authenticated runtime to the remaining holder and stops after its final release', async () => {
        const scenario = await runGeneratedScenario()
        expect(scenario.result, JSON.stringify(scenario.result)).toMatchObject({ kind: 'complete', status: 0 })
        const env = { PATH: `${scenario.candidate.root}:/usr/bin:/bin`, HOME: scenario.candidate.home,
            COCKPIT_SESSION_ID: '11111111-1111-4111-8111-111111111111' }
        const sessionSteps: ExecutionStep[] = []
        const sessionAdapters = createLifecycleCommandAdapters({
            configPath: scenario.candidate.configPath,
            env,
            sessionId: env.COCKPIT_SESSION_ID,
            timeoutMs: 5_000,
        }, async step => {
            sessionSteps.push(step)
            return executeProbe(step)
        })
        const sessionContext = await sessionAdapters.load({ configPath: scenario.candidate.configPath })
        expect(sessionContext.kind).toBe('complete')
        if (sessionContext.kind !== 'complete') return
        expect(scenario.context.holderId).not.toBe(sessionContext.result.holderId)

        const rejoined = await runUp({ configPath: scenario.candidate.configPath }, sessionAdapters)
        expect(rejoined, JSON.stringify(rejoined)).toMatchObject({ kind: 'complete', result: { change: 'unchanged' } })
        const originalReleased = await runSleep({ configPath: scenario.candidate.configPath }, scenario.adapters)
        expect(originalReleased, JSON.stringify(originalReleased)).toMatchObject({
            kind: 'complete', result: { stackId: scenario.context.stackId, change: 'retained' },
        })
        const remainingReentry = await runUp({ configPath: scenario.candidate.configPath }, sessionAdapters)
        expect(remainingReentry, JSON.stringify(remainingReentry)).toMatchObject({ kind: 'complete' })
        const rebound = await readState(sessionContext.result.namespace.paths.lifecycle(sessionContext.result.stackId))
        expect(rebound.kind).toBe('complete')
        if (rebound.kind === 'complete') {
            expect(decodeLifecycleRecord(rebound.value, sessionContext.result)?.value.holderId)
                .toBe(sessionContext.result.holderId)
        }
        const final = await runSleep({ configPath: scenario.candidate.configPath }, sessionAdapters)
        expect(final, JSON.stringify(final)).toMatchObject({
            kind: 'complete', result: { stackId: scenario.context.stackId, change: 'stopped' },
        })
        expect(sessionSteps.filter(({ id }) => id.includes(':stop:'))).toHaveLength(1)
    }, 120_000)

    it.each(['empty', 'seeded', 'restored'] as const)('runs the declared %s data mode without selecting the fixture volume', async (dataMode) => {
        const scenario = await runGeneratedScenario({ dataMode })
        const dataSteps = scenario.steps.map(({ id }) => id).filter((id) => id.startsWith('data:'))
        expect(dataSteps).toContain(`data:${dataMode}:${dataMode}-schema`)
        expect(dataSteps).not.toContain('data:volume:operation:0')
        expect(dataSteps).not.toContain('data:volume:probe:0')
        expect(scenario.result, JSON.stringify(scenario.result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(scenario.result.progress?.applied).toContain(`data:${dataMode}:${dataMode}-schema`)
        await expect(resolveLifecycleStage({ namespace: scenario.context.namespace,
            stackId: scenario.context.stackId, observedAt: new Date().toISOString() }))
            .resolves.toMatchObject({ kind: 'complete', authority: { stage: 'steady' } })
    })

    it('refuses failed vendor leaves paired with an earlier healthy aggregate', async () => {
        const failed = await runGeneratedScenario({ failedVendorEvidence: true })
        expect(failed.result, JSON.stringify(failed.result)).toMatchObject({
            kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'EXTERNAL_DEPENDENCIES_UNAVAILABLE' })],
        })
        expect(failed.result.progress?.applied).not.toContain('seeded')
        await expect(resolveLifecycleStage({ namespace: failed.context.namespace,
            stackId: failed.context.stackId, observedAt: new Date().toISOString() }))
            .resolves.toMatchObject({ kind: 'complete', authority: { stage: 'bootstrap' } })
    })
    it('derives durable progress from issued observations instead of callback labels', async () => {
        const passed = await runGeneratedScenario({ forgedProgress: true })
        expect(passed.result, JSON.stringify(passed.result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(passed.result.progress?.applied).toEqual(expect.arrayContaining(['dependency:app:stamp', 'vendor:messages:loader']))
        const stages = [...passed.result.progress?.applied ?? [], ...passed.result.progress?.notApplied ?? [], ...passed.result.progress?.attempted ?? []]
        expect(stages.some((stage) => stage.includes(':other:'))).toBe(false)
        const stored = await readState(passed.context.namespace.paths.lifecycle(passed.context.stackId))
        expect(stored.kind).toBe('complete')
        if (stored.kind === 'complete') expect(decodeLifecycleRecord(stored.value, passed.context)?.value.generatedProgress).toEqual(passed.result.progress)
    })
    it('refuses a genuine load observation in place of the declared dependency installation', async () => {
        const candidate = await runGeneratedScenario({ dependencyLoadOnly: true })
        expect(candidate.result, JSON.stringify(candidate.result)).toMatchObject({
            kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'INSTALL_STATE_UNHEALTHY' })],
        })
        expect(candidate.steps.some(({ id }) => id.startsWith('data:'))).toBe(false)
        await expect(resolveLifecycleStage({ namespace: candidate.context.namespace,
            stackId: candidate.context.stackId, observedAt: new Date().toISOString() }))
            .resolves.toMatchObject({ kind: 'complete', authority: { stage: 'bootstrap' } })
    })

    it('keeps identical sibling lockfiles in checkout-specific dependency caches', async () => {
        const passed = await runGeneratedScenario({ secondSibling: true })
        expect(passed.result, JSON.stringify(passed.result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(passed.dependencyOutcome, JSON.stringify(passed.dependencyOutcome)).toMatchObject({
            kind: 'complete',
        })
        expect(passed.result.progress?.applied).toEqual(expect.arrayContaining([
            'dependency:app:install',
            'dependency:app:load',
            'dependency:app:stamp',
            'dependency:worker:install',
            'dependency:worker:load',
            'dependency:worker:stamp',
        ]))
        const lockfileSha256 = createHash('sha256').update('{"lockfileVersion":3}\n').digest('hex')
        const appCheckout = checkoutId({ checkoutPath: join(passed.candidate.checkout, 'app') })
        const workerCheckout = checkoutId({ checkoutPath: join(passed.candidate.checkout, 'worker') })
        const appStamp = passed.context.namespace.paths.cache(appCheckout, lockfileSha256).path
        const workerStamp = passed.context.namespace.paths.cache(workerCheckout, lockfileSha256).path
        expect(appStamp).not.toBe(workerStamp)
        await expect(readFile(appStamp, 'utf8')).resolves.toContain(`"checkoutId":"${appCheckout}"`)
        await expect(readFile(workerStamp, 'utf8')).resolves.toContain(`"checkoutId":"${workerCheckout}"`)
        expect(passed.steps.map(({ id }) => id)).toEqual(expect.arrayContaining([
            'dependency-runtime:inspect:app',
            'dependency-runtime:inspect:worker',
        ]))
    })

})
