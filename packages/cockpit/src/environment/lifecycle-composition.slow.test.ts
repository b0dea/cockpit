import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { decodeLifecycleRecord, runSession, runSleep, runUp } from './application/lifecycle.js'
import type { ExecutionStep } from './contract.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { recordLifecycleStarted } from './lifecycle-stage.js'
import { readState } from './state.js'
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

const { runStackScenario } = createLifecycleCompositionFixtureSupport(roots, listenerProbeControl)

// Each case drives the real lifecycle owners through dozens of child processes (fenced execution,
// publication helpers, Git and runtime probes), so its wall time scales with machine load rather
// than with the work under test. The budget is sized for four concurrent workers on a busy host.
describe('production lifecycle adapter composition', { timeout: 180_000 }, () => {
    // Two bring-ups plus a session join take 30-55s on an idle machine, so the 60s default is too
    // tight; the hand-off test below carries the same 120s budget.
    it('releases a supervised co-tenant without stopping the original holder runtime', async () => {
        const scenario = await runStackScenario()
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
    }, 120_000)

    // This handoff deliberately reacquires authority across seven loads and five lifecycle calls.
    it('hands an authenticated runtime to the remaining holder and stops after its final release', async () => {
        const scenario = await runStackScenario()
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

    // The seed fills the resettable volumes, so it reruns exactly when one of them is newer than its
    // last success: after reset, a removed volume, or a seed that failed.
    it('seeds on the first up, leaves current data alone, and seeds again once a resettable volume is new', async () => {
        const scenario = await runStackScenario({ seed: ['/bin/sh', '-c', 'printf "%s\\n" "$APP_HOST_PORT" >> seeded.log'] })
        expect(scenario.result, JSON.stringify(scenario.result)).toMatchObject({ kind: 'complete', status: 0, result: { seed: 'ran' } })
        const log = join(scenario.candidate.checkout, 'seeded.log')
        const port = scenario.result.kind === 'complete' ? scenario.result.result.ports.APP_HOST_PORT : undefined
        expect(await readFile(log, 'utf8')).toBe(`${port}\n`)

        const current = await runUp({ configPath: scenario.candidate.configPath }, scenario.adapters)
        expect(current, JSON.stringify(current)).toMatchObject({ kind: 'complete', result: { seed: 'current' } })
        expect(await readFile(log, 'utf8')).toBe(`${port}\n`)

        // Reset removes the volume and the next start creates it again, after the recorded seed.
        await writeFile(join(scenario.candidate.root, 'volume-created-at'), new Date(Date.now() + 5_000).toISOString())
        const recreated = await runUp({ configPath: scenario.candidate.configPath }, scenario.adapters)
        expect(recreated, JSON.stringify(recreated)).toMatchObject({ kind: 'complete', result: { seed: 'ran' } })
        expect(await readFile(log, 'utf8')).toBe(`${port}\n${port}\n`)
    }, 120_000)

    it('refuses an up whose seed fails and runs the seed again on the next up', async () => {
        const scenario = await runStackScenario({ seed: ['/bin/sh', '-c', 'printf x >> attempts.log; exit 3'] })
        expect(scenario.result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DATA_SEED_FAILED', target: 'environment.seed',
            message: 'the seed command exited with status 3; its data may be partly applied, and it runs again on the next up' }] })
        const retried = await runUp({ configPath: scenario.candidate.configPath }, scenario.adapters)
        expect(retried).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DATA_SEED_FAILED' }] })
        expect(await readFile(join(scenario.candidate.checkout, 'attempts.log'), 'utf8')).toBe('xx')
    }, 120_000)

})
