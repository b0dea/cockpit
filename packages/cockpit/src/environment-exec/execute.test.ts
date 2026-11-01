import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { chmodSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_CODES, snapshotJson, type ExecutionPlan, type ExecutionStep } from '../environment/contract.js'
import { resolveExecutablePath } from '../environment/executable.js'
import { cleanupFencedExecution, consumeFencedExecutionTermination, executeForegroundProcess, executePlan, executeProbe, executionOutcomeMatches, executionReceiptMatches, repairFencedExecution } from './execute.js'

const nodeStep = (id: string, script: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep => ({
    id, argv: [process.execPath, '-e', script], argv0: process.execPath, cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000, stdoutLimitBytes: 1_024, stderrLimitBytes: 1_024,
    paths: [], ports: [], labels: {}, expected: [], consumedFiles: [], filesystemChecks: [], compensation: [], ...overrides,
})
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

// The fixtures that ignore SIGTERM outlive an interrupted run, when nothing is left to SIGKILL them, and have run on for
// days. Their keep-alive also exits once this test worker is gone; while it lives, every termination assertion holds.
const KEEP_ALIVE = `setInterval(() => { try { process.kill(${process.pid}, 0) } catch { process.exit(0) } }, 1000)`

function stagedProcess(marker: string): { pid: number; staging: string } {
    const [staging, pid] = readFileSync(marker, 'utf8').trim().split('\n')
    return { staging, pid: Number(pid) }
}

function cleanupStagedProcess(pid: number | undefined, staging: string | undefined): void {
    let cleanupError: unknown
    if (pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = error
        }
        try { process.kill(pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && cleanupError === undefined) cleanupError = error
        }
    }
    if (staging !== undefined && dirname(staging) === tmpdir() && basename(staging).startsWith('cockpit-execution-')) {
        rmSync(staging, { recursive: true, force: true })
    }
    if (cleanupError !== undefined) throw cleanupError
}

const scratch: string[] = []

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`process did not publish readiness at ${path}`)
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

// A fixture publishes a pid by rename because writeFileSync creates the file before it writes it: a
// reader polling for the path can read it empty, and Number('') is 0, which kill() takes as the
// caller's own process group — so a liveness probe passes and a cleanup SIGKILL hits the test runner.
const publishPid = (path: string, pid = 'process.pid'): string => [
    `require('node:fs').writeFileSync(${JSON.stringify(`${path}.pending`)}, String(${pid}))`,
    `require('node:fs').renameSync(${JSON.stringify(`${path}.pending`)}, ${JSON.stringify(path)})`,
].join(';')

async function waitForPid(path: string): Promise<number> {
    await waitForPath(path)
    const raw = readFileSync(path, 'utf8')
    const pid = Number(raw)
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${path} holds ${JSON.stringify(raw)}, not a process id`)
    return pid
}

async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
        try { process.kill(pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
            throw error
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    return false
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('mechanical environment executor', () => {
    it('cancels a delayed fenced starter before any destructive effect can begin', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-cancel-race-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const fence = { attemptId, markerPath: join(directory, 'executor.json'), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
        const effect = join(directory, 'effect')

        const execution = executeProbe(nodeStep('fenced-cancel-race',
            `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'started')`, { executionFence: fence }))
        const repaired = await repairFencedExecution(fence)
        const outcome = await execution

        expect(repaired.kind).toBe('complete')
        expect(outcome).toMatchObject({ kind: 'refusal', execution: { started: false } })
        expect(existsSync(effect)).toBe(false)
    })

    it.each(['parent', 'supervisor', 'runner'] as const)(
        'refuses expiry at the fenced %s release without retaining execution authority', async boundary => {
            const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-expiry-'))
            scratch.push(directory)
            const attemptId = sha256(directory)
            const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
            const fence = { attemptId, markerPath: join(directory, 'executor.json'), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
            const effect = join(directory, 'effect')
            const clockHit = join(directory, 'clock-hit')
            const preload = join(directory, 'clock.cjs')
            const deadline = Date.now() + 60_000
            // Real child startup and marker publication advance the clock at the OS boundary.
            writeFileSync(preload, `
                const fs = require('node:fs')
                const marker = ${JSON.stringify(fence.markerPath)}
                const selected = fs.existsSync(marker) === ${boundary === 'runner'}
                const now = Date.now
                Date.now = () => {
                    if (selected && fs.existsSync(marker)) {
                        fs.writeFileSync(${JSON.stringify(clockHit)}, String(process.pid))
                        return ${deadline + 1}
                    }
                    return now()
                }
            `)
            const step = nodeStep('fenced-expiry', `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'started')`, {
                executionFence: fence, spawnNotAfter: new Date(deadline).toISOString(),
                ...(boundary === 'parent' ? {} : { env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }),
            })
            const now = Date.now
            const clock = boundary === 'parent' ? vi.spyOn(Date, 'now').mockImplementation(() => {
                if (existsSync(fence.markerPath)) {
                    writeFileSync(clockHit, String(process.pid))
                    return deadline + 1
                }
                return now()
            }) : undefined
            let outcome: Awaited<ReturnType<typeof executeProbe>>
            try { outcome = await executeProbe(step) } finally { clock?.mockRestore() }

            expect(existsSync(effect)).toBe(false)
            expect(outcome).toMatchObject({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED', execution: { started: false } })
            expect(outcome.receipt).toBeUndefined()
            expect(executionOutcomeMatches(outcome, step)).toBe(true)
            expect(existsSync(clockHit)).toBe(true)
            const marker = JSON.parse(readFileSync(fence.markerPath, 'utf8')) as { status: string; supervisorPid: number }
            expect(marker.status).toBe('terminated')
            expect(await waitForProcessGone(-marker.supervisorPid)).toBe(true)
            if (boundary === 'runner') expect(await waitForProcessGone(-Number(readFileSync(clockHit, 'utf8')))).toBe(true)
            expect(existsSync(fence.socketPath)).toBe(false)
            const repaired = await repairFencedExecution(fence)
            expect(repaired.kind).toBe('complete')
            if (repaired.kind !== 'complete') throw new Error('expired fenced execution remains unrepaired')
            expect(consumeFencedExecutionTermination(repaired.evidence, fence)).toBe(true)
            expect(consumeFencedExecutionTermination(repaired.evidence, fence)).toBe(false)
            await expect(cleanupFencedExecution(fence)).resolves.toBe(true)
            expect(existsSync(fence.markerPath)).toBe(false)
        },
    )

    it('refuses swapped, oversized and blocking execution markers', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-hostile-marker-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const fence = { attemptId, markerPath: join(directory, 'executor.json'), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
        const target = join(directory, 'target')
        writeFileSync(target, '{}')
        symlinkSync(target, fence.markerPath)
        await expect(repairFencedExecution(fence)).resolves.toMatchObject({ kind: 'refusal' })

        rmSync(fence.markerPath, { force: true })
        writeFileSync(fence.markerPath, 'x'.repeat(2_048))
        await expect(repairFencedExecution(fence)).resolves.toMatchObject({ kind: 'refusal' })

        rmSync(fence.markerPath, { force: true })
        execFileSync('mkfifo', [fence.markerPath])
        await expect(repairFencedExecution(fence)).resolves.toMatchObject({ kind: 'refusal' })

        rmSync(fence.markerPath, { force: true })
        writeFileSync(fence.markerPath, '{}')
        const identity = statSync(fence.markerPath, { bigint: true })
        const parent = statSync(directory, { bigint: true })
        writeFileSync(fence.markerPath, `${JSON.stringify({ format: 'cockpit-executor/v1', attemptId,
            supervisorPid: process.pid, markerDev: String(identity.dev), markerIno: String(identity.ino + 1n),
            parentDev: String(parent.dev), parentIno: String(parent.ino), status: 'active' })}\n`)
        await expect(repairFencedExecution(fence)).resolves.toMatchObject({ kind: 'refusal' })
    })

    it('repairs an exact attempt that ended before durable execution acknowledgement', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-unstarted-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const fence = {
            attemptId,
            markerPath: join(directory, 'executor.json'),
            socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`),
        }

        const repaired = await repairFencedExecution(fence)
        expect(repaired.kind).toBe('complete')
        if (repaired.kind !== 'complete') throw new Error('unstarted fenced repair unavailable')
        expect(consumeFencedExecutionTermination(repaired.evidence, fence)).toBe(true)
    })

    it('starts no effect when durable fence acknowledgement is refused', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-gate-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const markerPath = join(directory, 'executor.json')
        const effect = join(directory, 'effect')
        writeFileSync(markerPath, 'occupied')
        const outcome = await executeProbe(nodeStep('fenced-gate',
            `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'started')`, {
                executionFence: { attemptId, markerPath, socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) },
            }))
        expect(outcome).toMatchObject({ kind: 'refusal', execution: { started: false } })
        expect(existsSync(effect)).toBe(false)
    })

    it('repairs an orphaned fenced executor only after its exact action group is gone', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-orphan-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const fence = {
            attemptId,
            markerPath: join(directory, 'executor.json'),
            socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`),
        }
        const effect = join(directory, 'effect')
        const step = nodeStep('fenced-orphan', [
            publishPid(effect),
            "process.on('SIGTERM', () => {})",
            KEEP_ALIVE,
        ].join(';'), { timeoutMs: 30_000, executionFence: fence })
        const executeModule = fileURLToPath(new URL('./execute.ts', import.meta.url))
        const source = `import { executeProbe } from ${JSON.stringify(executeModule)}; await executeProbe(JSON.parse(process.argv[1]))`
        const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(step)], { stdio: 'ignore' })
        try {
            const actionPid = await waitForPid(effect)
            expect(() => process.kill(actionPid, 0)).not.toThrow()
            parent.kill('SIGKILL')
            await new Promise<void>((resolve, reject) => { parent.once('exit', () => resolve()); parent.once('error', reject) })

            const mismatch = await repairFencedExecution({ ...fence, attemptId: 'f'.repeat(64) })
            expect(mismatch).toEqual({ kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED })
            expect(() => process.kill(actionPid, 0)).not.toThrow()

            const repaired = await repairFencedExecution(fence)
            expect(repaired.kind).toBe('complete')
            if (repaired.kind !== 'complete') throw new Error('fenced repair unavailable')
            expect(consumeFencedExecutionTermination(repaired.evidence, fence)).toBe(true)
            expect(consumeFencedExecutionTermination(repaired.evidence, fence)).toBe(false)
            expect(() => process.kill(actionPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
            await expect(cleanupFencedExecution(fence)).resolves.toBe(true)
            expect(existsSync(fence.markerPath)).toBe(false)
        } finally {
            if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
            try {
                const actionPid = Number(readFileSync(effect, 'utf8'))
                process.kill(-actionPid, 'SIGKILL')
            } catch { /* repaired or never started */ }
        }
    })

    it('confirms the fenced action group is gone before issuing a timeout receipt', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-timeout-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const effect = join(directory, 'effect')
        const outcome = await executeProbe(nodeStep('fenced-timeout', [
            publishPid(effect),
            "process.on('SIGTERM', () => {})",
            KEEP_ALIVE,
        ].join(';'), {
            timeoutMs: 500,
            executionFence: {
                attemptId,
                markerPath: join(directory, 'executor.json'),
                socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`),
            },
        }))
        const actionPid = Number(readFileSync(effect, 'utf8'))
        expect(outcome).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_TIMEOUT,
            execution: { started: true }, receipt: expect.any(Object) })
        expect(() => process.kill(actionPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    })

    it('retains the fenced group leader until same-group descendants are gone', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-group-leader-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const descendant = join(directory, 'descendant')
        const script = [
            "const { spawn } = require('node:child_process')",
            "const { writeFileSync } = require('node:fs')",
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); ${KEEP_ALIVE}`)}], { stdio: 'ignore' })`,
            'child.unref()',
            `writeFileSync(${JSON.stringify(descendant)}, String(child.pid))`,
        ].join(';')
        const outcome = await executeProbe(nodeStep('fenced-group-leader', script, {
            executionFence: { attemptId, markerPath: join(directory, 'executor.json'),
                socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) },
        }))
        const descendantPid = Number(readFileSync(descendant, 'utf8'))
        expect(outcome).toMatchObject({ kind: 'complete', receipt: expect.any(Object) })
        expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    })

    it('stops the action group and leaves durable repair evidence when the supervisor pipe is lost', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-pipe-loss-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const action = join(directory, 'action')
        const descendant = join(directory, 'descendant')
        const fence = { attemptId, markerPath: join(directory, 'executor.json'), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
        const script = [
            "const { spawn } = require('node:child_process')",
            publishPid(action),
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); ${KEEP_ALIVE}`)}], { stdio: 'ignore' })`,
            publishPid(descendant, 'child.pid'),
            "process.on('SIGTERM', () => {})",
            KEEP_ALIVE,
        ].join(';')
        const execution = executeProbe(nodeStep('fenced-pipe-loss', script, { timeoutMs: 30_000, executionFence: fence }))
        let actionPid: number | undefined
        let descendantPid: number | undefined
        try {
            actionPid = await waitForPid(action)
            descendantPid = await waitForPid(descendant)
            const marker = JSON.parse(readFileSync(fence.markerPath, 'utf8')) as { supervisorPid: number }
            process.kill(marker.supervisorPid, 'SIGKILL')
            await execution

            expect(await waitForProcessGone(actionPid)).toBe(true)
            expect(await waitForProcessGone(descendantPid)).toBe(true)
            const repaired = await repairFencedExecution(fence)
            expect(repaired.kind).toBe('complete')
            if (repaired.kind !== 'complete') throw new Error('pipe-loss repair unavailable')
            expect(consumeFencedExecutionTermination(repaired.evidence, fence)).toBe(true)
            await expect(cleanupFencedExecution(fence)).resolves.toBe(true)
        } finally {
            for (const pid of [actionPid, descendantPid]) {
                if (pid !== undefined) try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
            }
        }
    })

    it('stops the action even when pipe-loss evidence cannot be published', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-fenced-pipe-loss-refusal-'))
        scratch.push(directory)
        const attemptId = sha256(directory)
        const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
        const effect = join(directory, 'effect')
        const fence = { attemptId, markerPath: join(directory, 'executor.json'), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
        const execution = executeProbe(nodeStep('fenced-pipe-loss-refusal', [
            publishPid(effect),
            "process.on('SIGTERM', () => {})",
            KEEP_ALIVE,
        ].join(';'), { timeoutMs: 30_000, executionFence: fence }))
        let actionPid: number | undefined
        try {
            actionPid = await waitForPid(effect)
            const marker = JSON.parse(readFileSync(fence.markerPath, 'utf8')) as { supervisorPid: number }
            chmodSync(directory, 0o500)
            process.kill(marker.supervisorPid, 'SIGKILL')
            await execution

            expect(await waitForProcessGone(actionPid)).toBe(true)
            chmodSync(directory, 0o700)
            await expect(repairFencedExecution(fence)).resolves.toEqual({
                kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
            })
        } finally {
            chmodSync(directory, 0o700)
            if (actionPid !== undefined) try { process.kill(actionPid, 'SIGKILL') } catch { /* already stopped */ }
        }
    })

    it('treats a live silent foreground process as active and confirms its process group is gone', async () => {
        const resolved = await resolveExecutablePath(process.execPath)
        expect(resolved.state).toBe('available')
        if (resolved.state !== 'available') return
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-live-foreground-'))
        scratch.push(directory)
        const ready = join(directory, 'ready')
        const release = join(directory, 'release')
        const controller = new AbortController()
        let settled = false
        const pending = executeForegroundProcess({
            executable: resolved.value,
            argv: ['-e', [
                "const { existsSync, writeFileSync } = require('node:fs')",
                `writeFileSync(${JSON.stringify(ready)}, 'ready')`,
                `const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0) } }, 10)`,
            ].join(';')],
            cwd: process.cwd(),
            env: { PATH: process.env.PATH ?? '' },
        }, { signal: controller.signal }).then(outcome => {
            settled = true
            return outcome
        })

        try {
            await waitForPath(ready)
            expect(settled).toBe(false)
            writeFileSync(release, 'release')
            await expect(pending).resolves.toEqual({
                kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true,
            })
        } finally {
            controller.abort()
            await pending
        }
    })

    it('aborts only the owned foreground process group and confirms it is gone', async () => {
        const resolved = await resolveExecutablePath(process.execPath)
        expect(resolved.state).toBe('available')
        if (resolved.state !== 'available') return
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-abort-foreground-'))
        scratch.push(directory)
        const ready = join(directory, 'ready')
        const controller = new AbortController()
        const pending = executeForegroundProcess({
            executable: resolved.value,
            argv: ['-e', [
                "const { writeFileSync } = require('node:fs')",
                "process.on('SIGTERM', () => {})",
                `writeFileSync(${JSON.stringify(ready)}, 'ready')`,
                KEEP_ALIVE,
            ].join(';')],
            cwd: process.cwd(),
            env: { PATH: process.env.PATH ?? '' },
        }, { signal: controller.signal })
        try {
            await waitForPath(ready)
            controller.abort()
            await expect(pending).resolves.toMatchObject({
                kind: 'refusal', code: 'EXECUTION_ABORTED', started: true, terminationConfirmed: true,
            })
        } finally {
            controller.abort()
            await pending
        }
    })

    it('refuses an already-expired step before spawning it', async () => {
        const marker = join(mkdtempSync(join(tmpdir(), 'cockpit-expired-step-')), 'spawned')
        scratch.push(dirname(marker))
        const outcome = await executeProbe(nodeStep('expired-before-spawn', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`, {
            spawnNotAfter: new Date(Date.now() - 1).toISOString(),
        }))

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED', execution: expect.objectContaining({ started: false }),
        }))
        expect(existsSync(marker)).toBe(false)
    })

    it('rechecks expiry after awaited preconditions and immediately before spawn', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-expiry-race-'))
        scratch.push(directory)
        const checked = join(directory, 'checked.bin')
        const marker = join(directory, 'spawned')
        const contents = Buffer.alloc(8 * 1_024 * 1_024, 7)
        writeFileSync(checked, contents)
        const outcome = await executeProbe(nodeStep('expires-during-check', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`, {
            spawnNotAfter: new Date(Date.now() + 1).toISOString(),
            filesystemChecks: [{ path: checked, expected: 'file', sha256: sha256(contents), maxBytes: contents.byteLength }],
        }))

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED', execution: expect.objectContaining({ started: false }),
        }))
        expect(existsSync(marker)).toBe(false)
    })

    it('issues an authentic spawn refusal when the child working directory disappears', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-spawn-refusal-'))
        scratch.push(directory)
        const step = nodeStep('spawn-refusal-control', '', { cwd: join(directory, 'missing') })

        const outcome = await executeProbe(step)

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'refusal', code: 'EXECUTION_SPAWN_FAILED',
            execution: expect.objectContaining({ exitCode: 1, started: false }),
        }))
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
    })

    it('returns bounded probe output on refusal so callers can classify the failed control', async () => {
        const probe = await executeProbe(nodeStep(
            'broken-control',
            "process.stdout.write('candidate'); process.stderr.write('control-specific-refusal'); process.exit(7)",
            { stdoutLimitBytes: 9, stderrLimitBytes: 24 },
        ))

        expect(probe).toEqual(expect.objectContaining({
            kind: 'refusal',
            code: 'EXECUTION_STEP_FAILED',
            stdout: Buffer.from('candidate'),
            stderr: Buffer.from('control-specific-refusal'),
        }))
        expect(probe.execution).toEqual(expect.objectContaining({ stdoutBytes: 9, stderrBytes: 24 }))
    })

    it('issues an immutable execution receipt from the step that actually ran', async () => {
        const step = nodeStep('receipt-control', "process.stdout.write('ok')", {
            labels: { batchId: 'resolved-batch', configSha256: 'resolved-config' },
        })

        const probe = await executeProbe(step)

        expect(probe.kind).toBe('complete')
        if (probe.kind !== 'complete') return
        expect(probe.receipt).toEqual(expect.objectContaining({
            stepId: step.id,
            startedAt: expect.stringMatching(/Z$/),
            finishedAt: expect.stringMatching(/Z$/),
        }))
        expect(Object.isFrozen(probe.receipt)).toBe(true)
        expect(probe.receipt.receiptMatches(step)).toBe(true)
        expect(probe.receipt.receiptMatches({ ...step, labels: { ...step.labels, batchId: 'caller-relabelled' } })).toBe(false)
        expect(executionReceiptMatches(probe.receipt, step)).toBe(true)
        expect(executionReceiptMatches({ ...probe.receipt }, step)).toBe(false)
    })

    it('binds every enumerable record key without prototype interpretation', async () => {
        const step = nodeStep('record-key-control', '')
        const labels = { ...step.labels }
        Object.defineProperty(labels, '__proto__', { enumerable: true, value: 'safe' })
        step.labels = labels

        const outcome = await executeProbe(step)

        expect(outcome.kind).toBe('complete')
        if (outcome.kind !== 'complete') return
        const alteredLabels = { ...labels }
        Object.defineProperty(alteredLabels, '__proto__', { enumerable: true, value: 'altered' })
        expect(executionReceiptMatches(outcome.receipt, step)).toBe(true)
        expect(executionReceiptMatches(outcome.receipt, { ...step, labels: alteredLabels })).toBe(false)
    })

    it('refuses caller-owned step accessors without invoking them', async () => {
        const safe = nodeStep('snapshot-control', "process.stdout.write(`${process.cwd()}:${process.env.CONTROL}`)")
        const reads = new Map<string, number>()
        const volatile = { ...safe } as ExecutionStep
        const varying = <Value>(name: string, first: Value, later: Value) => ({
            enumerable: true,
            get: () => {
                const count = (reads.get(name) ?? 0) + 1
                reads.set(name, count)
                return count === 1 ? first : later
            },
        })
        Object.defineProperties(volatile, {
            argv: varying('argv', safe.argv, [process.execPath, '-e', "process.stdout.write('altered-argv')"]),
            cwd: varying('cwd', safe.cwd, '/path/that/must/not/run'),
            env: varying('env', { ...safe.env, CONTROL: 'safe' }, { ...safe.env, CONTROL: 'altered' }),
            timeoutMs: varying('timeoutMs', 2_000, 1),
            stdoutLimitBytes: varying('stdoutLimitBytes', 1_024, 1),
            stderrLimitBytes: varying('stderrLimitBytes', 1_024, 1),
        })

        const outcome = await executeProbe(volatile)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
        expect(outcome.stdout).toHaveLength(0)
        expect(reads.size).toBe(0)
    })

    it('refuses a nested argv accessor without invoking it', async () => {
        const step = nodeStep('argv-control', '')
        let scriptReads = 0
        const argv: [string, ...string[]] = [...step.argv]
        Object.defineProperty(argv, 2, {
            enumerable: true,
            get: () => ++scriptReads === 1 ? "process.stdout.write('safe')" : "process.stdout.write('altered')",
        })

        const outcome = await executeProbe({ ...step, argv })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
        expect(outcome.stdout).toHaveLength(0)
        expect(scriptReads).toBe(0)
    })

    it('refuses sparse execution arrays before spawning', async () => {
        const step = nodeStep('sparse-control', "process.stdout.write('must-not-run')")
        const argv = [process.execPath, , step.argv[2]] as unknown as [string, ...string[]]

        const outcome = await executeProbe({ ...step, argv })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
        expect(outcome.stdout).toHaveLength(0)
    })

    it('refuses a nested environment accessor without invoking it', async () => {
        const step = nodeStep('environment-control', "process.stdout.write(process.env.CONTROL ?? '')")
        let valueReads = 0
        const env = { ...step.env }
        Object.defineProperty(env, 'CONTROL', {
            enumerable: true,
            get: () => ++valueReads === 1 ? 'safe' : 'altered',
        })

        const outcome = await executeProbe({ ...step, env })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
        expect(outcome.stdout).toHaveLength(0)
        expect(valueReads).toBe(0)
    })

    it('keeps returned output and execution observations immutable', async () => {
        const outcome = await executeProbe(nodeStep('observation-control', "process.stdout.write('safe')"))

        expect(outcome.kind).toBe('complete')
        if (outcome.kind !== 'complete') return
        const callerCopy = outcome.stdout
        callerCopy.fill(0)
        expect(outcome.stdout.toString()).toBe('safe')
        expect(Object.isFrozen(outcome)).toBe(true)
        expect(Object.isFrozen(outcome.execution)).toBe(true)
    })

    it('authenticates only the exact issued outcome and its resolved step', async () => {
        const step = nodeStep('outcome-control', "process.stdout.write('safe')")
        const outcome = await executeProbe(step)

        expect(executionOutcomeMatches(outcome, step)).toBe(true)
        expect(executionOutcomeMatches({ ...outcome, stdout: Buffer.from('altered') }, step)).toBe(false)
        expect(executionOutcomeMatches({ ...outcome, execution: { ...outcome.execution, exitCode: 7 } }, step)).toBe(false)
        expect(executionOutcomeMatches(outcome, { ...step, cwd: '/altered' })).toBe(false)
        expect(executionOutcomeMatches(outcome, { ...step, argv0: '/altered/invocation' })).toBe(false)
    })

    it('authenticates an issued receiptless refusal against the resolved input', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-refusal-binding-'))
        scratch.push(directory)
        const executable = join(directory, 'runtime')
        const source = '#!/bin/sh\nprintf safe\n'
        writeFileSync(executable, source, { mode: 0o700 })
        const step = nodeStep('replacement-control', '', {
            argv: [executable],
            consumedFiles: [{
                path: executable, sha256: sha256(source), maxBytes: 536_870_912,
                argvIndexes: [0], executable: true, executionMode: 'verified-path',
            }],
        })
        writeFileSync(executable, '#!/bin/sh\nprintf replaced\n', { mode: 0o700 })

        const outcome = await executeProbe(step)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
        expect(executionOutcomeMatches({ ...outcome }, step)).toBe(false)
        expect(executionOutcomeMatches(outcome, { ...step, cwd: '/altered' })).toBe(false)
    })

    it('passes a data input to the process as its private content-addressed snapshot', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-consumed-file-'))
        scratch.push(directory)
        const input = join(directory, 'input')
        writeFileSync(input, 'verified')
        const script = "process.stdout.write(process.argv[1] + '\\n' + require('node:fs').readFileSync(process.argv[1], 'utf8'))"
        const step = nodeStep('consumed-control', script, {
            argv: [process.execPath, '-e', script, input],
            consumedFiles: [
                { path: process.execPath, sha256: sha256(readFileSync(process.execPath)), maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                { path: input, sha256: sha256('verified'), maxBytes: 64, argvIndexes: [3], executable: false },
            ],
        })

        const outcome = await executeProbe(step)

        expect(outcome.kind).toBe('complete')
        if (outcome.kind !== 'complete') return
        const [snapshot, content] = outcome.stdout.toString().split('\n')
        expect(snapshot).not.toBe(input)
        expect(dirname(dirname(snapshot!))).toBe(tmpdir())
        expect(basename(dirname(snapshot!))).toMatch(/^cockpit-execution-/)
        expect(content).toBe('verified')
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
    })

    it('runs a verified executable from its own path and binds its digest into the receipt', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-verified-path-'))
        scratch.push(directory)
        const executable = join(directory, 'runtime')
        const source = '#!/bin/sh\nprintf %s "$0"\n'
        writeFileSync(executable, source, { mode: 0o700 })
        const step = nodeStep('verified-path-control', '', {
            argv: [executable],
            consumedFiles: [{
                path: executable, sha256: sha256(source), maxBytes: 536_870_912,
                argvIndexes: [0], executable: true, executionMode: 'verified-path',
            }],
        })

        const outcome = await executeProbe(step)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', stdout: Buffer.from(executable) }))
        if (outcome.kind !== 'complete') return
        const rebound = { ...step, consumedFiles: [{ ...step.consumedFiles[0]!, sha256: sha256('other') }] }
        expect(executionReceiptMatches(outcome.receipt, rebound as ExecutionStep)).toBe(false)
        expect(executionOutcomeMatches(outcome, rebound as ExecutionStep)).toBe(false)
    })

    it('re-hashes a verified executable whose bytes changed under a restored size and modification time', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-verified-memo-'))
        scratch.push(directory)
        const executable = join(directory, 'runtime')
        const source = '#!/bin/sh\nprintf safe\n'
        writeFileSync(executable, source, { mode: 0o700 })
        // Whole seconds survive utimes exactly, so only the change time can tell the rewrite apart.
        utimesSync(executable, 1_700_000_000, 1_700_000_000)
        const step = nodeStep('verified-memo-control', '', {
            argv: [executable],
            consumedFiles: [{
                path: executable, sha256: sha256(source), maxBytes: 536_870_912,
                argvIndexes: [0], executable: true, executionMode: 'verified-path',
            }],
        })
        expect(await executeProbe(step)).toEqual(expect.objectContaining({ kind: 'complete', stdout: Buffer.from('safe') }))
        // A same-length rewrite with its timestamps put back still moves the change time, so the
        // remembered digest no longer applies and the re-hash catches the new bytes.
        writeFileSync(executable, '#!/bin/sh\nprintf evil\n')
        utimesSync(executable, 1_700_000_000, 1_700_000_000)
        expect(statSync(executable).mtimeMs).toBe(1_700_000_000_000)
        expect(await executeProbe(step)).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
    })

    it('refuses an unreadable execution mode without propagating the getter failure', async () => {
        const consumed = { path: process.execPath, sha256: sha256('synthetic'), maxBytes: 536_870_912, argvIndexes: [0], executable: true }
        Object.defineProperty(consumed, 'executionMode', { enumerable: true, get: () => { throw new Error('unreadable') } })
        const step = nodeStep('unreadable-mode', '', { consumedFiles: [consumed as never] })

        await expect(executeProbe(step)).resolves.toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
    })

    it('passes a separate logical invocation identity to the process', async () => {
        const step = nodeStep('logical-invocation', '', {
            argv: ['/bin/sh', '-c', '[ "$0" = /usr/local/bin/synthetic-runtime ] || exit 9; printf %s "$0"'],
            argv0: '/usr/local/bin/synthetic-runtime',
            consumedFiles: [],
        })

        const outcome = await executeProbe(step)

        expect(outcome.kind).toBe('complete')
        expect(outcome.stdout.toString('utf8')).toBe('/usr/local/bin/synthetic-runtime')
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
    })

    it('preserves project-relative resolution while staging a compose command', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-compose-boundary-'))
        scratch.push(directory)
        const executable = join(directory, 'compose-runtime')
        const compose = join(directory, 'compose.yml')
        const marker = join(directory, 'Dockerfile')
        const executableSource = `#!/bin/sh
project=
file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-directory) project=$2; shift 2 ;;
    --file) file=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -f "$project/Dockerfile" ] && grep -q 'build: .' "$file"
`
        const composeSource = 'services:\n  api:\n    build: .\n'
        writeFileSync(executable, executableSource)
        writeFileSync(compose, composeSource)
        writeFileSync(marker, 'FROM scratch\n')
        chmodSync(executable, 0o755)
        const step = nodeStep('compose-relative-control', '', {
            argv: [executable, 'compose', '--project-directory', directory, '--file', compose, 'config'],
            cwd: directory,
            consumedFiles: [
                { path: executable, sha256: sha256(executableSource), maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                { path: compose, sha256: sha256(composeSource), maxBytes: 1_048_576, argvIndexes: [5], executable: false },
            ],
        })

        expect((await executeProbe(step)).kind).toBe('complete')
    })

    it('reports staging cleanup failure without deleting an unrelated path', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-cleanup-control-'))
        scratch.push(directory)
        const executable = join(directory, 'runtime')
        const unrelated = join(directory, 'unrelated')
        writeFileSync(unrelated, 'safe')
        const input = join(directory, 'input')
        writeFileSync(input, 'input')
        const source = '#!/bin/sh\nstaging=$(dirname "$1")\nprintf %s "$staging"\nchmod 500 "$staging"\n'
        writeFileSync(executable, source)
        chmodSync(executable, 0o755)
        const step = nodeStep('cleanup-control', '', {
            argv: [executable, input],
            consumedFiles: [
                { path: executable, sha256: sha256(source), maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                { path: input, sha256: sha256('input'), maxBytes: 16, argvIndexes: [1], executable: false },
            ],
        })
        const outcome = await executeProbe(step)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_STAGING_CLEANUP_FAILED' }))
        expect(outcome.execution.exitCode).toBe(1)
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
        expect(readFileSync(unrelated, 'utf8')).toBe('safe')
        const staging = outcome.stdout.toString()
        chmodSync(staging, 0o700)
        rmSync(staging, { recursive: true, force: true })
        expect(dirname(staging)).toBe(tmpdir())
    })

    it('never exposes a zero exit code on a refused probe', async () => {
        const aborted = new AbortController()
        aborted.abort()
        const outcomes = await Promise.all([
            executeProbe(nodeStep('step-failure', 'process.exit(7)')),
            executeProbe(nodeStep('aborted', ''), { signal: aborted.signal }),
            executeProbe({ ...nodeStep('malformed', ''), argv: [] } as never),
            executeProbe(nodeStep('stdout-limit', "process.stdout.write('too much')", { stdoutLimitBytes: 1 })),
        ])

        for (const outcome of outcomes) {
            expect(outcome.kind).toBe('refusal')
            expect(outcome.execution.exitCode).not.toBe(0)
        }
    })

    it('executes without temporary storage when no input needs staging', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-no-staging-'))
        scratch.push(directory)
        const previous = process.env.TMPDIR
        process.env.TMPDIR = join(directory, 'missing-staging-parent', 'nested')
        try {
            const outcome = await executeProbe(nodeStep('no-staging-control', 'process.stdout.write("ok")'))
            expect(outcome).toMatchObject({ kind: 'complete', stdout: Buffer.from('ok') })
        } finally {
            if (previous === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previous
        }
    })

    it('reports a staging creation failure as distinct from changed input', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-staging-required-'))
        scratch.push(directory)
        const input = join(directory, 'input')
        writeFileSync(input, 'input')
        const previous = process.env.TMPDIR
        process.env.TMPDIR = join(directory, 'missing-staging-parent', 'nested')
        try {
            const outcome = await executeProbe(nodeStep('staging-failure-control', '', {
                argv: [process.execPath, '-e', '', input],
                consumedFiles: [
                    { path: process.execPath, sha256: sha256(readFileSync(process.execPath)), maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                    { path: input, sha256: sha256('input'), maxBytes: 16, argvIndexes: [3], executable: false },
                ],
            }))
            expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_STAGING_FAILED' }))
        } finally {
            if (previous === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previous
        }
    })

    it('executes exact steps and returns bounded observations', async () => {
        const outcome = await executePlan({ steps: [nodeStep('one', "process.stdout.write('ok')")] })
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind === 'complete') {
            expect(outcome.result.steps[0]).toEqual(expect.objectContaining({
                id: 'one', stdoutBytes: 2, stderrBytes: 0, exitCode: 0,
            }))
            expect(outcome.result.steps[0]).not.toHaveProperty('stdout')
            expect(outcome.result.steps[0]).not.toHaveProperty('stderr')
            expect(outcome.result.steps[0]).not.toHaveProperty('resolvedStep')
        }
    })

    it('refuses a plan step id accessor without invoking it', async () => {
        const step = nodeStep('stable-id', 'process.exit(7)')
        let idReads = 0
        Object.defineProperty(step, 'id', {
            enumerable: true,
            get: () => ++idReads === 1 ? 'stable-id' : 'altered-id',
        })

        const outcome = await executePlan({ steps: [step] })

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'refusal', status: 2,
            diagnostics: [expect.objectContaining({ code: 'EXECUTION_PRECONDITION_CHANGED' })],
            execution: expect.objectContaining({ failedStep: { id: 'execution-input', started: false } }),
        }))
        expect(idReads).toBe(0)
    })

    it('snapshots and validates every step before the first process starts', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-plan-snapshot-'))
        scratch.push(directory)
        const firstMarker = join(directory, 'first')
        const safeMarker = join(directory, 'safe')
        const alteredMarker = join(directory, 'altered')
        const later = nodeStep('later', `require('node:fs').writeFileSync(${JSON.stringify(safeMarker)}, 'safe')`)
        const execution = executePlan({ steps: [
            nodeStep('first', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(firstMarker)}, 'first'), 50)`, { timeoutMs: 1_000 }),
            later,
        ] })
        later.argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(alteredMarker)}, 'altered')`]

        const outcome = await execution

        expect(outcome.kind).toBe('complete')
        expect(existsSync(firstMarker)).toBe(true)
        expect(existsSync(safeMarker)).toBe(true)
        expect(existsSync(alteredMarker)).toBe(false)
    })

    it('refuses a malformed later step before executing a valid prefix', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-plan-preflight-'))
        scratch.push(directory)
        const marker = join(directory, 'must-not-run')
        const malformed = nodeStep('malformed', '')
        malformed.argv = [process.execPath, , ''] as unknown as [string, ...string[]]

        const outcome = await executePlan({ steps: [
            nodeStep('first', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
            malformed,
        ] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(existsSync(marker)).toBe(false)
    })

    it('refuses an oversized plan before executing its valid prefix', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-plan-limit-'))
        scratch.push(directory)
        const marker = join(directory, 'must-not-run')
        const steps = Array.from({ length: 257 }, (_, index) => nodeStep(
            `bounded-${index}`,
            index === 0 ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` : '',
        ))

        const outcome = await executePlan({ steps })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(existsSync(marker)).toBe(false)
    })

    it('refuses duplicate step identities before executing a valid prefix', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-plan-identity-'))
        scratch.push(directory)
        const marker = join(directory, 'must-not-run')
        const outcome = await executePlan({ steps: [
            nodeStep('duplicate', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
            nodeStep('duplicate', ''),
        ] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(existsSync(marker)).toBe(false)
    })

    it('enforces scalar and aggregate UTF-8 snapshot budgets', () => {
        expect(snapshotJson('x'.repeat(65_537))).toBeUndefined()
        let reads = 0
        const values = Array.from({ length: 4_096 }, () => Object.defineProperty({}, 'value', {
            enumerable: true, get: () => { reads += 1; return 'x'.repeat(300) },
        }))

        expect(snapshotJson(values)).toBeUndefined()
        expect(reads).toBeLessThan(values.length)
    })

    it('does not traverse entries after a collection exceeds its budget', () => {
        let reads = 0
        const value = Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => {
            const child = Object.defineProperty({}, 'value', { enumerable: true, get: () => { reads += 1; return index } })
            return [`entry-${index}`, child]
        }))

        expect(snapshotJson(value)).toBeUndefined()
        expect(reads).toBe(0)
    })

    it('refuses an oversized consumed file before spawning it', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-consumed-limit-'))
        scratch.push(directory)
        const executable = join(directory, 'oversized')
        const source = '#!/bin/sh\nprintf should-not-run\n'
        writeFileSync(executable, source, { mode: 0o700 })
        const outcome = await executeProbe(nodeStep('oversized-consumed', '', {
            argv: [executable],
            consumedFiles: [{ path: executable, sha256: sha256(source), maxBytes: 1, argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
        }))

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
    })

    it('captures the cancellation signal once for the entire plan', async () => {
        const controller = new AbortController()
        controller.abort()
        let reads = 0
        const options = Object.defineProperty({}, 'signal', {
            enumerable: true,
            get: () => ++reads === 1 ? undefined : controller.signal,
        }) as { signal?: AbortSignal }

        const outcome = await executePlan({ steps: [nodeStep('one', ''), nodeStep('two', '')] }, options)

        expect(outcome.kind).toBe('complete')
        expect(reads).toBe(1)
    })

    it('returns a typed refusal when cancellation state is unreadable', async () => {
        const options = Object.defineProperty({}, 'signal', { get: () => { throw new Error('revoked') } }) as { signal?: AbortSignal }
        await expect(executeProbe(nodeStep('unreadable-signal', ''), options)).resolves.toEqual(expect.objectContaining({
            kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED',
        }))
        await expect(executePlan({ steps: [nodeStep('unreadable-plan-signal', '')] }, options)).resolves.toEqual(expect.objectContaining({ kind: 'refusal' }))
    })

    it.each([
        ['empty command', { argv: ['', 'arg'] }],
        ['NUL command', { argv: ['node\0hidden', 'arg'] }],
        ['NUL argument', { argv: [process.execPath, 'arg\0hidden'] }],
        ['empty invocation identity', { argv0: '' }],
        ['NUL invocation identity', { argv0: 'node\0hidden' }],
        ['empty working directory', { cwd: '' }],
        ['relative working directory', { cwd: 'relative' }],
        ['NUL working directory', { cwd: '/tmp/synthetic\0hidden' }],
        ['empty environment name', { env: { '': 'value' } }],
        ['invalid environment name', { env: { 'NAME=OTHER': 'value' } }],
        ['NUL environment name', { env: { 'NAME\0HIDDEN': 'value' } }],
        ['NUL environment value', { env: { NAME: 'value\0hidden' } }],
    ] as const)('returns a typed pre-spawn refusal for %s', async (_label, patch) => {
        const outcome = await executeProbe(nodeStep('invalid-input', '', patch as Partial<ExecutionStep>))

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        expect(outcome).not.toHaveProperty('receipt')
    })

    it('rejects undeclared decision fields and incomplete consumed-file identities', async () => {
        const step = nodeStep('strict-boundary', '')
        const cases: unknown[] = [
            { ...step, decisionRule: 'caller-owned' },
            Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'argv0')),
            { ...step, consumedFiles: [{ path: '/tmp/input', sha256: sha256('input'), maxBytes: 1_048_576, argvIndexes: [1], executable: false }] },
            { ...step, filesystemChecks: [{ path: '/tmp/input', expected: 'file', ignored: true }] },
        ]

        for (const candidate of cases) {
            await expect(executeProbe(candidate as ExecutionStep)).resolves.toEqual(expect.objectContaining({
                kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED',
            }))
        }
        await expect(executePlan({ steps: [step], selectionRule: 'caller-owned' } as unknown as ExecutionPlan)).resolves.toEqual(expect.objectContaining({ kind: 'refusal' }))
    })

    it.each([
        ['timeout', nodeStep('slow', 'setInterval(() => {}, 1000)', { timeoutMs: 20 }), 'EXECUTION_TIMEOUT'],
        ['stdout cap', nodeStep('loud', "process.stdout.write('12345')", { stdoutLimitBytes: 4 }), 'EXECUTION_STDOUT_LIMIT'],
        ['stderr cap', nodeStep('loud', "process.stderr.write('12345')", { stderrLimitBytes: 4 }), 'EXECUTION_STDERR_LIMIT'],
    ])('refuses %s', async (_label, step, code) => {
        const outcome = await executePlan({ steps: [step as ExecutionStep] })
        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code })])
    })

    it.each([
        ['stdout', "process.stdout.write('12345')", { stdoutLimitBytes: 4 }, 'EXECUTION_STDOUT_LIMIT'],
        ['stderr', "process.stderr.write('12345')", { stderrLimitBytes: 4 }, 'EXECUTION_STDERR_LIMIT'],
    ] as const)('retains the exact bounded %s prefix when one chunk crosses the cap', async (stream, script, limits, code) => {
        const outcome = await executeProbe(nodeStep(`limit-${stream}`, script, limits))

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code }))
        expect(outcome.execution).toEqual(expect.objectContaining({
            exitCode: 1,
            signal: 'SIGTERM',
            [`${stream}Bytes`]: 4,
            [`${stream}ObservedBytes`]: 5,
            [`${stream}RetainedBytes`]: 4,
        }))
        expect(outcome[stream].toString()).toBe('1234')
        expect(executionOutcomeMatches(outcome, nodeStep(`limit-${stream}`, script, limits))).toBe(true)
    })

    it('never classifies a signal-terminated child as successful', async () => {
        const step = nodeStep('signal-control', "process.kill(process.pid, 'SIGKILL')")
        const outcome = await executeProbe(step)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED' }))
        expect(outcome.execution).toEqual(expect.objectContaining({ exitCode: 1, signal: 'SIGKILL' }))
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
    })

    it('keeps a controller refusal nonzero when the child handles termination by exiting zero', async () => {
        const step = nodeStep(
            'handled-termination-control',
            "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
            { timeoutMs: 500 },
        )

        const outcome = await executeProbe(step)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_TIMEOUT' }))
        expect(outcome.execution).toEqual(expect.objectContaining({ exitCode: 1, signal: null }))
        expect(executionOutcomeMatches(outcome, step)).toBe(true)
    })

    it('stops at first failure and runs only declared compensation in supplied order', async () => {
        const compensation = [nodeStep('undo-a', ''), nodeStep('undo-b', '')]
        const plan: ExecutionPlan = { steps: [
            nodeStep('fails', 'process.exit(7)', { compensation }),
            nodeStep('must-not-run', "process.stdout.write('wrong')"),
        ] }
        const outcome = await executePlan(plan)
        expect(outcome.kind).toBe('refusal')
        if (outcome.kind === 'refusal') {
            expect(outcome.result).toBeNull()
            expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'EXECUTION_STEP_FAILED' }))
            expect(outcome.execution).toEqual({
                completedStepIds: [],
                failedStep: { id: 'fails', started: true },
                compensation: {
                    attemptedStepIds: ['undo-a', 'undo-b'],
                    completedStepIds: ['undo-a', 'undo-b'],
                    failed: [],
                },
            })
        }
    })

    it('reports that a failed first step started when it may already have mutated', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-failed-step-evidence-'))
        scratch.push(directory)
        const marker = join(directory, 'mutated')

        const outcome = await executePlan({ steps: [nodeStep(
            'mutates-then-fails',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'changed'); process.exit(7)`,
        )] })

        expect(existsSync(marker)).toBe(true)
        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        if (outcome.kind !== 'refusal') return
        expect(outcome.execution).toEqual({
            completedStepIds: [],
            failedStep: { id: 'mutates-then-fails', started: true },
            compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
        })
    })

    it('refuses a pre-aborted signal before spawning', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-pre-abort-'))
        scratch.push(directory)
        const marker = join(directory, 'spawned')
        const controller = new AbortController()
        controller.abort()

        const outcome = await executePlan({ steps: [nodeStep(
            'must-not-spawn',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
        )] }, { signal: controller.signal })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'EXECUTION_ABORTED' })])
        if (outcome.kind === 'refusal') {
            expect(outcome.execution.failedStep).toEqual({ id: 'must-not-spawn', started: false })
        }
        expect(existsSync(marker)).toBe(false)
    })

    it('runs declared compensation after an in-flight abort', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-abort-compensation-'))
        scratch.push(directory)
        const started = join(directory, 'started')
        const compensated = join(directory, 'compensated')
        const controller = new AbortController()
        const execution = executePlan({ steps: [nodeStep('primary', [
            `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')`,
            'setInterval(() => {}, 1000)',
        ].join(';'), {
            compensation: [nodeStep(
                'undo-primary',
                `require('node:fs').writeFileSync(${JSON.stringify(compensated)}, 'done')`,
            )],
        })] }, { signal: controller.signal })
        await expect.poll(() => existsSync(started)).toBe(true)

        controller.abort()
        const outcome = await execution

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(existsSync(compensated)).toBe(true)
        if (outcome.kind === 'refusal') {
            expect(outcome.execution.compensation).toEqual({
                attemptedStepIds: ['undo-primary'],
                completedStepIds: ['undo-primary'],
                failed: [],
            })
        }
    })

    it('preserves staging and skips compensation when termination cannot be confirmed', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-unconfirmed-termination-'))
        scratch.push(directory)
        const executable = join(directory, 'primary')
        const stagingMarker = join(directory, 'staging')
        const compensationMarker = join(directory, 'compensated')
        const source = `#!/bin/sh
trap '' TERM
printf '%s\n%s\n' "$(dirname "$1")" "$$" > ${JSON.stringify(`${stagingMarker}.pending`)}
mv ${JSON.stringify(`${stagingMarker}.pending`)} ${JSON.stringify(stagingMarker)}
while :; do sleep 1; done
`
        writeFileSync(executable, source, { mode: 0o700 })
        const input = join(directory, 'input')
        writeFileSync(input, 'input')
        const controller = new AbortController()
        const nativeKill = process.kill
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid < 0 && (signal === 'SIGKILL' || signal === 0)) {
                throw Object.assign(new Error('synthetic signal refusal'), { code: 'EPERM' })
            }
            return nativeKill(pid, signal)
        }) as typeof process.kill
        let outcome
        let primaryPid: number | undefined
        let staging: string | undefined
        try {
            try {
                const execution = executePlan({ steps: [nodeStep('primary', '', {
                    argv: [executable, input],
                    argv0: executable,
                    consumedFiles: [{
                        path: executable, sha256: sha256(source), maxBytes: 1_024,
                        argvIndexes: [0], executable: true, executionMode: 'verified-path',
                    }, { path: input, sha256: sha256('input'), maxBytes: 16, argvIndexes: [1], executable: false }],
                    compensation: [nodeStep(
                        'must-not-compensate',
                        `require('node:fs').writeFileSync(${JSON.stringify(compensationMarker)}, 'ran')`,
                    )],
                })] }, { signal: controller.signal })
                await expect.poll(() => existsSync(stagingMarker)).toBe(true)
                controller.abort()
                outcome = await execution
            } finally {
                process.kill = nativeKill
            }

            ;({ staging, pid: primaryPid } = stagedProcess(stagingMarker))
            expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
            expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'EXECUTION_TERMINATION_UNCONFIRMED' })])
            expect(existsSync(compensationMarker)).toBe(false)
            if (outcome.kind !== 'refusal') return
            expect(outcome.execution.compensation.attemptedStepIds).toEqual([])
            expect(dirname(staging)).toBe(tmpdir())
            expect(existsSync(staging)).toBe(true)
        } finally {
            process.kill = nativeKill
            if ((primaryPid === undefined || staging === undefined) && existsSync(stagingMarker)) {
                ;({ staging, pid: primaryPid } = stagedProcess(stagingMarker))
            }
            cleanupStagedProcess(primaryPid, staging)
        }
    })

    it('withholds a finished receipt when termination cannot be confirmed', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-unconfirmed-receipt-'))
        scratch.push(directory)
        const started = join(directory, 'started')
        const executable = join(directory, 'primary')
        const source = `#!/bin/sh
trap '' TERM
printf '%s\n%s\n' "$(dirname "$1")" "$$" > ${JSON.stringify(`${started}.pending`)}
mv ${JSON.stringify(`${started}.pending`)} ${JSON.stringify(started)}
while :; do sleep 1; done
`
        writeFileSync(executable, source, { mode: 0o700 })
        const input = join(directory, 'input')
        writeFileSync(input, 'input')
        const controller = new AbortController()
        const step = nodeStep('unconfirmed-receipt', '', {
            argv: [executable, input],
            argv0: executable,
            consumedFiles: [{
                path: executable, sha256: sha256(source), maxBytes: 1_024,
                argvIndexes: [0], executable: true, executionMode: 'verified-path',
            }, { path: input, sha256: sha256('input'), maxBytes: 16, argvIndexes: [1], executable: false }],
        })
        const nativeKill = process.kill
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid < 0 && (signal === 'SIGKILL' || signal === 0)) {
                throw Object.assign(new Error('synthetic signal refusal'), { code: 'EPERM' })
            }
            return nativeKill(pid, signal)
        }) as typeof process.kill
        let outcome
        let primaryPid: number | undefined
        let staging: string | undefined
        try {
            try {
                const execution = executeProbe(step, { signal: controller.signal })
                await expect.poll(() => existsSync(started)).toBe(true)
                controller.abort()
                outcome = await execution
            } finally {
                process.kill = nativeKill
            }

            ;({ staging, pid: primaryPid } = stagedProcess(started))
            expect(outcome).toEqual(expect.objectContaining({
                kind: 'refusal', code: 'EXECUTION_TERMINATION_UNCONFIRMED',
            }))
            expect(outcome).not.toHaveProperty('receipt')
            expect(executionOutcomeMatches(outcome, step)).toBe(true)
            expect(basename(staging)).toMatch(/^cockpit-execution-/)
            expect(existsSync(staging)).toBe(true)
        } finally {
            process.kill = nativeKill
            if ((primaryPid === undefined || staging === undefined) && existsSync(started)) {
                ;({ staging, pid: primaryPid } = stagedProcess(started))
            }
            cleanupStagedProcess(primaryPid, staging)
        }
    })

    it('confirms the process group is gone before issuing a successful receipt', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-successful-group-'))
        scratch.push(directory)
        const executable = join(directory, 'leader')
        const stagingMarker = join(directory, 'staging')
        const descendantMarker = join(directory, 'descendant')
        const descendant = [
            "process.on('SIGTERM', () => {})",
            `require('node:fs').writeFileSync(${JSON.stringify(`${descendantMarker}.pending`)}, String(process.pid))`,
            `require('node:fs').renameSync(${JSON.stringify(`${descendantMarker}.pending`)}, ${JSON.stringify(descendantMarker)})`,
            KEEP_ALIVE,
        ].join(';')
        const source = `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(${JSON.stringify(stagingMarker)}, path.dirname(process.argv[2]) + '\\n' + process.pid)
spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: false, stdio: 'ignore' })
const ready = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(descendantMarker)})) return
    clearInterval(ready)
    process.exit(0)
}, 5)
`
        writeFileSync(executable, source, { mode: 0o700 })
        const input = join(directory, 'input')
        writeFileSync(input, 'input')
        const step = nodeStep('successful-leader', '', {
            argv: [executable, input],
            argv0: executable,
            consumedFiles: [{
                path: executable, sha256: sha256(source), maxBytes: 4_096,
                argvIndexes: [0], executable: true, executionMode: 'verified-path',
            }, { path: input, sha256: sha256('input'), maxBytes: 16, argvIndexes: [1], executable: false }],
        })
        let descendantPid: number | undefined
        let leaderPid: number | undefined
        let staging: string | undefined
        try {
            const outcome = await executeProbe(step)
            descendantPid = Number(readFileSync(descendantMarker, 'utf8'))
            ;({ staging, pid: leaderPid } = stagedProcess(stagingMarker))

            expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', receipt: expect.any(Object) }))
            expect(outcome.execution).toEqual(expect.objectContaining({ exitCode: 0, signal: null }))
            expect(() => process.kill(descendantPid as number, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
            expect(basename(staging)).toMatch(/^cockpit-execution-/)
            expect(existsSync(staging)).toBe(false)
        } finally {
            if ((descendantPid === undefined || leaderPid === undefined || staging === undefined)
                && existsSync(descendantMarker) && existsSync(stagingMarker)) {
                descendantPid = Number(readFileSync(descendantMarker, 'utf8'))
                ;({ staging, pid: leaderPid } = stagedProcess(stagingMarker))
            }
            cleanupStagedProcess(leaderPid, staging)
            if (descendantPid !== undefined) {
                try { process.kill(descendantPid, 'SIGKILL') } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
                }
            }
        }
    })

    it('definitively terminates a process that ignores SIGTERM', async () => {
        const started = Date.now()
        const outcome = await executePlan({ steps: [nodeStep(
            'ignores-term',
            `process.on('SIGTERM', () => {}); ${KEEP_ALIVE}`,
            { timeoutMs: 30 },
        )] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'EXECUTION_TIMEOUT' })])
        expect(Date.now() - started).toBeLessThan(1_500)
    })

    it('terminates descendants that keep inherited output pipes open', async () => {
        const started = Date.now()
        const outcome = await executePlan({ steps: [nodeStep(
            'descendant-pipes',
            [
                "const { spawn } = require('node:child_process')",
                "spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); " + KEEP_ALIVE + "\"], { stdio: ['ignore', 'inherit', 'inherit'] })",
                "process.on('SIGTERM', () => {})",
                KEEP_ALIVE,
            ].join(';'),
            { timeoutMs: 30 },
        )] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(Date.now() - started).toBeLessThan(1_500)
    })

    it('kills a detached descendant after the leader closes during termination', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-descendant-kill-'))
        scratch.push(directory)
        const marker = join(directory, 'survived')
        const childScript = [
            "process.on('SIGTERM', () => {})",
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 400)`,
            KEEP_ALIVE,
        ].join(';')
        const leaderScript = [
            "const { spawn } = require('node:child_process')",
            `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
            "process.on('SIGTERM', () => process.exit(0))",
            'setInterval(() => {}, 1000)',
        ].join(';')

        const outcome = await executePlan({ steps: [nodeStep('leader-closes', leaderScript, { timeoutMs: 80 })] })
        await new Promise((resolve) => setTimeout(resolve, 550))

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(existsSync(marker)).toBe(false)
    })

    it('does not compensate when a precondition changes before the primary process starts', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-precondition-compensation-'))
        scratch.push(directory)
        const missing = join(directory, 'missing')
        const marker = join(directory, 'compensated')
        const outcome = await executePlan({ steps: [nodeStep('primary', '', {
            filesystemChecks: [{ path: missing, expected: 'directory' }],
            compensation: [nodeStep(
                'must-not-compensate',
                `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            )],
        })] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'EXECUTION_PRECONDITION_CHANGED' })])
        if (outcome.kind === 'refusal') {
            expect(outcome.execution.compensation.attemptedStepIds).toEqual([])
        }
        expect(existsSync(marker)).toBe(false)
    })

    it.each([
        'target', 'ancestor', 'file', 'target-symlink', 'target-absent',
        'ancestor-symlink', 'ancestor-absent', 'malformed-copy',
    ] as const)(
        'refuses when an identity-bound removal %s changes before execution', async (change) => {
            const root = mkdtempSync(join(tmpdir(), 'cockpit-removal-identity-'))
            scratch.push(root)
            const ancestor = join(root, 'generated')
            const target = join(ancestor, 'session')
            const marker = join(root, 'spawned')
            mkdirSync(target, { recursive: true })
            const rootStatus = lstatSync(root)
            const ancestorStatus = lstatSync(ancestor)
            const targetStatus = lstatSync(target)
            const identity = {
                dev: targetStatus.dev,
                ino: targetStatus.ino,
                ancestors: [
                    { path: root, dev: rootStatus.dev, ino: rootStatus.ino },
                    { path: ancestor, dev: ancestorStatus.dev, ino: ancestorStatus.ino },
                ],
            }
            let suppliedIdentity: Record<string, unknown> = identity
            if (change === 'ancestor' || change === 'ancestor-symlink' || change === 'ancestor-absent') {
                const held = join(root, 'held-generated')
                renameSync(ancestor, held)
                if (change !== 'ancestor-absent') {
                    const replacementAncestor = change === 'ancestor-symlink' ? join(root, 'replacement-generated') : ancestor
                    mkdirSync(join(replacementAncestor, 'session'), { recursive: true })
                    writeFileSync(join(replacementAncestor, 'session', 'replacement'), 'preserved')
                    if (change === 'ancestor-symlink') symlinkSync(replacementAncestor, ancestor)
                }
            } else {
                // ext4 hands a new directory the inode the removed one just freed, so
                // recreating the path in place can reproduce the very identity this check is
                // bound to. Staging the replacement while the original still exists keeps the
                // two distinct on every filesystem; APFS only hid this by not reusing inodes.
                const staged = join(root, 'staged-session')
                if (change === 'target' || change === 'malformed-copy') {
                    mkdirSync(staged)
                    writeFileSync(join(staged, 'replacement'), 'preserved')
                }
                rmSync(target, { recursive: true })
                if (change === 'target' || change === 'malformed-copy') renameSync(staged, target)
                if (change === 'file') writeFileSync(target, 'preserved')
                if (change === 'target-symlink') symlinkSync(join(root, 'held-target'), target)
                if (change === 'malformed-copy') {
                    const replacement = lstatSync(target)
                    suppliedIdentity = { ...identity, dev: replacement.dev, ino: replacement.ino, extra: true }
                }
            }
            const outcome = await executeProbe(nodeStep('identity-bound-removal', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`, {
                filesystemChecks: [{ path: target, expected: 'directory', identity: suppliedIdentity as typeof identity }],
            }))

            expect(outcome).toEqual(expect.objectContaining({
                kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED', execution: expect.objectContaining({ started: false }),
            }))
            expect(outcome).not.toHaveProperty('receipt')
            expect(existsSync(marker)).toBe(false)
            if (change === 'target' || change === 'ancestor' || change === 'ancestor-symlink' || change === 'malformed-copy') {
                expect(readFileSync(join(target, 'replacement'), 'utf8')).toBe('preserved')
            }
            if (change === 'file') expect(readFileSync(target, 'utf8')).toBe('preserved')
            if (change === 'target-symlink') expect(lstatSync(target).isSymbolicLink()).toBe(true)
        },
    )

    it('executes when the identity-bound path and ancestor chain are unchanged', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-removal-identity-control-'))
        scratch.push(root)
        const ancestor = join(root, 'generated')
        const target = join(ancestor, 'session')
        mkdirSync(target, { recursive: true })
        const rootStatus = lstatSync(root)
        const ancestorStatus = lstatSync(ancestor)
        const targetStatus = lstatSync(target)

        const outcome = await executeProbe(nodeStep('identity-bound-removal-control', '', {
            filesystemChecks: [{
                path: target,
                expected: 'directory',
                identity: {
                    dev: targetStatus.dev,
                    ino: targetStatus.ino,
                    ancestors: [
                        { path: root, dev: rootStatus.dev, ino: rootStatus.ino },
                        { path: ancestor, dev: ancestorStatus.dev, ino: ancestorStatus.ino },
                    ],
                },
            }],
        }))

        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', receipt: expect.any(Object) }))
    })

    it('requires and enforces a byte ceiling for digest-bearing preconditions', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-precondition-limit-'))
        scratch.push(directory)
        const file = join(directory, 'input')
        writeFileSync(file, 'two bytes')
        const base = nodeStep('bounded-precondition', '', {
            filesystemChecks: [{ path: file, expected: 'file', sha256: sha256('two bytes'), maxBytes: 1 }],
        })

        await expect(executeProbe(base)).resolves.toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }))
        await expect(executeProbe({ ...base, filesystemChecks: [{ path: file, expected: 'file', sha256: sha256('two bytes') }] })).resolves.toEqual(
            expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_PRECONDITION_CHANGED' }),
        )
    })

    it('records failed compensation as attempted and failed, never completed', async () => {
        const plan: ExecutionPlan = { steps: [nodeStep('primary', 'process.exit(9)', {
            compensation: [nodeStep('undo-fails', 'process.exit(8)')],
        })] }

        const outcome = await executePlan(plan)

        expect(outcome.kind).toBe('refusal')
        if (outcome.kind !== 'refusal') return
        expect(outcome.execution.compensation).toEqual({
            attemptedStepIds: ['undo-fails'],
            completedStepIds: [],
            failed: [{ id: 'undo-fails', code: 'EXECUTION_STEP_FAILED' }],
        })
        expect(outcome.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'EXECUTION_COMPENSATION_STEP_FAILED', target: 'undo-fails' }),
        ]))
    })

    it('propagates compensation timeout evidence', async () => {
        const plan: ExecutionPlan = { steps: [nodeStep('primary', 'process.exit(9)', {
            compensation: [nodeStep('undo-times-out', 'setInterval(() => {}, 1000)', { timeoutMs: 20 })],
        })] }

        const outcome = await executePlan(plan)

        expect(outcome.kind).toBe('refusal')
        if (outcome.kind !== 'refusal') return
        expect(outcome.execution.compensation.failed).toEqual([
            { id: 'undo-times-out', code: 'EXECUTION_TIMEOUT' },
        ])
        expect(outcome.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'EXECUTION_COMPENSATION_TIMEOUT', target: 'undo-times-out' }),
        ]))
    })

    it('never exposes raw subprocess output through results, diagnostics, or errors', async () => {
        const canary = 'subprocess-secret-canary'
        const outcome = await executePlan({ steps: [nodeStep(
            'secret-output',
            `process.stdout.write(${JSON.stringify(canary)}); process.stderr.write(${JSON.stringify(canary)}); process.exit(7)`,
        )] })

        const publicShape = JSON.stringify(outcome)
        expect(publicShape).not.toContain(canary)
        expect(publicShape).not.toContain('stdout')
        expect(publicShape).not.toContain('stderr')
    })
})
