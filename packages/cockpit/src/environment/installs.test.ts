import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./dependency-runtime.js', async () => {
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const { authenticatedExecutionOutcome } = await import('../environment-exec/execute.js')
    const { snapshotExecutionStep } = await import('./contract.js')
    const step = (role: string, argv: readonly [string, ...string[]], env: Readonly<Record<string, string>>, timeoutMs: number, stdoutLimitBytes: number, stderrLimitBytes: number) => {
        const canonicalPath = argv[0]
        const sha256 = createHash('sha256').update(readFileSync(canonicalPath)).digest('hex')
        return snapshotExecutionStep({
            id: `test-dependency-${role}`,
            argv, argv0: canonicalPath, cwd: process.cwd(), env, timeoutMs,
            stdoutLimitBytes, stderrLimitBytes,
            paths: [], ports: [], labels: { role }, expected: [],
            consumedFiles: [{ path: canonicalPath, sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'staged' }],
            filesystemChecks: [], compensation: [],
        })!
    }
    return {
        admitDependencyExecution(input: { step: Parameters<typeof authenticatedExecutionOutcome>[1]; outcome: Parameters<typeof authenticatedExecutionOutcome>[0] }) {
            return authenticatedExecutionOutcome(input.outcome, input.step)
        },
        createDependencyExecutionPlan(input: {
            binding: { variant?: string; source?: string; volume?: string }
            install: readonly [string, ...string[]]
            load: readonly [string, ...string[]]
            env: Readonly<Record<string, string>>
            installTimeoutMs: number
            loadTimeoutMs: number
            stdoutLimitBytes: number
            stderrLimitBytes: number
        }) {
            const variant = input.binding.variant ?? 'one'
            return {
                kind: 'complete',
                install: step('install', input.install, input.env, input.installTimeoutMs, input.stdoutLimitBytes, input.stderrLimitBytes),
                load: step('load', input.load, input.env, input.loadTimeoutMs, input.stdoutLimitBytes, input.stderrLimitBytes),
                compatibility: {
                    imageId: `sha256:${variant.padEnd(64, '1').slice(0, 64)}`,
                    architecture: 'x86_64', abi: 'glibc:2.39', source: input.binding.source ?? 'dependencies',
                    volume: input.binding.volume ?? 'synthetic_dependencies',
                    target: '/workspace/node_modules', stackId: `stack:${'4'.repeat(64)}`,
                    configSha256: '2'.repeat(64), generation: variant.padEnd(64, '3').slice(0, 64),
                },
            }
        },
        createDependencyLoadPlan(input: {
            binding: { variant?: string; source?: string; volume?: string }
            load: readonly [string, ...string[]]
            env: Readonly<Record<string, string>>
            timeoutMs: number
            stdoutLimitBytes: number
            stderrLimitBytes: number
        }) {
            const variant = input.binding.variant ?? 'one'
            return {
                kind: 'planned',
                step: step('load', input.load, input.env, input.timeoutMs, input.stdoutLimitBytes, input.stderrLimitBytes),
                compatibility: {
                    imageId: `sha256:${variant.padEnd(64, '1').slice(0, 64)}`,
                    architecture: 'x86_64', abi: 'glibc:2.39', source: input.binding.source ?? 'dependencies',
                    volume: input.binding.volume ?? 'synthetic_dependencies',
                    target: '/workspace/node_modules', stackId: `stack:${'4'.repeat(64)}`,
                    configSha256: '2'.repeat(64), generation: variant.padEnd(64, '3').slice(0, 64),
                },
            }
        },
        admitDependencyLoad(input: { plan: { step: Parameters<typeof authenticatedExecutionOutcome>[1] }; outcome: Parameters<typeof authenticatedExecutionOutcome>[0] }) {
            const outcome = authenticatedExecutionOutcome(input.outcome, input.plan.step)
            return outcome?.kind === 'complete' ? { kind: 'complete' } : { kind: 'refusal', reason: 'load failed' }
        },
    }
})
import { executeProbe } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, type CheckoutId, type HolderId, type StackId } from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { deriveCacheKey, isInstallObservation, observeDependencyInstall, observeDependencyLoad, planInstall, projectInstallProgress, resolveInstallExecutables, verifyInstall, type PlanInstallInput } from './installs.js'
import type { DependencyRuntimeBinding } from './dependency-runtime.js'
import type { StateNamespace } from './state.js'

const checkoutId = `checkout:${'1'.repeat(64)}` as CheckoutId
const holderA = `holder:${'2'.repeat(64)}:session` as HolderId
const holderB = `holder:${'3'.repeat(64)}:session` as HolderId
const helperPath = fileURLToPath(new URL('../../libexec/install-filesystem.cjs', import.meta.url))
const scratch: string[] = []

describe('installed dependency helper identity', () => {
    it('resolves the installed helper with current Node and rejects changed or accessor identities', async () => {
        const canonicalPath = await realpath(process.execPath)
        const node = { canonicalPath, invocationPath: process.execPath,
            sha256: await digest(canonicalPath), executionMode: 'verified-path' as const }
        const candidate = await resolveInstallExecutables(node)
        expect(candidate).toMatchObject({ kind: 'complete', executables: { node,
            helper: { path: helperPath, sha256: await digest(helperPath) } } })
        expect(await resolveInstallExecutables({ ...node, sha256: '0'.repeat(64) })).toMatchObject({ kind: 'refusal' })
        const read = vi.fn(() => node.canonicalPath)
        expect(await resolveInstallExecutables({ ...node, get canonicalPath() { return read() } })).toMatchObject({ kind: 'refusal' })
        expect(read).not.toHaveBeenCalled()
    })
})

afterEach(async () => {
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function digest(path: string): Promise<string> {
    return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function executable(path: string, executionMode: ResolvedExecutable['executionMode'] = 'staged'): Promise<ResolvedExecutable> {
    return Object.freeze({ canonicalPath: path, invocationPath: path, sha256: await digest(path), executionMode })
}

async function helperProcess(root: string, request: object, extra: string[] = []): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [helperPath, JSON.stringify(request), ...extra], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''; let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
}

async function helperWithPreload(root: string, request: object, preload: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', preload, helperPath, JSON.stringify(request)], {
            cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''; let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
}

function namespace(stateRoot: string): StateNamespace {
    const cockpitRoot = join(stateRoot, 'cockpits', `cockpit:${'4'.repeat(64)}`)
    const unused = () => { throw new Error('unused state address') }
    return Object.freeze({
        root: stateRoot,
        cockpitRoot,
        paths: Object.freeze({
            claim: unused,
            lease: unused,
            coordination: unused,
            lifecycle: unused,
            dataOutcome: unused,
            stateLock: join(cockpitRoot, 'locks', 'state.lock'),
            installLock: (cacheId: string) => join(cockpitRoot, 'locks', 'install', `${cacheId}.lock`),
            cache: (checkout: CheckoutId, lockfileSha256: string) => ({
                path: join(cockpitRoot, 'cache', checkout, `${lockfileSha256}.json`),
                stateRoot,
                cockpitRoot,
                kind: 'cache',
                cockpitId: `cockpit:${'4'.repeat(64)}`,
                subjectId: checkout,
                qualifier: lockfileSha256,
            }),
            baseline: unused,
        }),
    }) as unknown as StateNamespace
}

type InstallFixture = PlanInstallInput & {
    readonly installExecutable: ResolvedExecutable
    readonly loadProbeExecutable: ResolvedExecutable
}

async function fixture(holderId = holderA, variant = 'one'): Promise<InstallFixture> {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-install-'))
    scratch.push(root)
    const checkoutRoot = join(root, 'checkout')
    const stateRoot = join(root, 'state')
    const tools = join(root, 'tools')
    await Promise.all([mkdir(checkoutRoot), mkdir(stateRoot), mkdir(tools)])
    const lockfilePath = join(checkoutRoot, 'package-lock.json')
    await writeFile(lockfilePath, '{"lockfileVersion":3}\n')
    const installPath = join(tools, 'install-ok')
    const probePath = join(tools, 'probe-ok')
    await writeFile(installPath, '#!/bin/sh\nexit 0\n')
    await writeFile(probePath, '#!/bin/sh\nexit 0\n')
    await Promise.all([chmod(installPath, 0o700), chmod(probePath, 0o700)])
    const input: PlanInstallInput = {
        checkoutId,
        holderId,
        pid: process.pid,
        checkoutRoot,
        lockfilePath,
        state: namespace(stateRoot),
        runtime: { variant, volume: 'dependencies' } as unknown as DependencyRuntimeBinding,
        policy: {
            volume: 'dependencies',
            lockfile: 'package-lock.json',
            install: [installPath],
            load_probe: [probePath],
        },
        executables: {
            node: await executable(process.execPath, 'verified-path'),
            helper: { path: helperPath, sha256: await digest(helperPath) },
        },
        execution: {
            env: {}, installTimeoutMs: 5_000, probeTimeoutMs: 5_000,
            helperTimeoutMs: 5_000, stdoutLimitBytes: 16_384, stderrLimitBytes: 16_384,
        },
        observeHolder: async () => 'unknown',
    }
    Object.defineProperties(input, {
        installExecutable: { value: await executable(installPath), enumerable: false },
        loadProbeExecutable: { value: await executable(probePath), enumerable: false },
    })
    return input as InstallFixture
}

describe('dependency cache identity', () => {
    it('binds install observations to their authentic checkout and runtime identity', async () => {
        const input = await fixture(holderA, 'a')
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error('fixture install plan was refused')
        const observation = await observeDependencyInstall({
            planned,
            options: { execute: executeProbe },
            stackId: `stack:${'5'.repeat(64)}` as StackId,
            observedAt: '2026-09-08T00:00:00.000Z',
        })
        const expected = {
            checkoutId,
            lockfilePath: input.lockfilePath,
            stackId: `stack:${'4'.repeat(64)}` as StackId,
            configSha256: '2'.repeat(64),
            generation: 'a'.padEnd(64, '3'),
            target: '/workspace/node_modules',
            policy: input.policy,
        }
        expect(isInstallObservation(observation, expected)).toBe(true)
        expect(isInstallObservation(observation, { ...expected, checkoutId: `checkout:${'9'.repeat(64)}` as CheckoutId })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, lockfilePath: `${input.lockfilePath}.other` })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, stackId: `stack:${'9'.repeat(64)}` as StackId })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, configSha256: '9'.repeat(64) })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, generation: '9'.repeat(64) })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, target: '/workspace/other' })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, policy: { ...expected.policy, volume: 'other-dependencies' } })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, policy: { ...expected.policy, install: ['/other-install'] } })).toBe(false)
        expect(isInstallObservation(observation, { ...expected, policy: { ...expected.policy, load_probe: ['/other-load'] } })).toBe(false)
        expect(isInstallObservation({ ...observation }, expected)).toBe(false)

        const loadOnly = await observeDependencyLoad({
            binding: input.runtime,
            load: [input.loadProbeExecutable.canonicalPath],
            env: {}, timeoutMs: 5_000, stdoutLimitBytes: 16_384, stderrLimitBytes: 16_384,
        }, { execute: executeProbe })
        expect(isInstallObservation(loadOnly)).toBe(true)
        expect(isInstallObservation(loadOnly, expected)).toBe(false)

        const getter = { ...expected }
        Object.defineProperty(getter, 'checkoutId', { enumerable: true, get: () => checkoutId })
        expect(isInstallObservation(observation, getter)).toBe(false)
        expect(isInstallObservation(observation, new Proxy(expected, {}))).toBe(false)
        expect(isInstallObservation(observation, { ...expected, extra: true } as typeof expected)).toBe(false)
    })

    it('issues install health only after the authentic plan completes', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error('fixture install plan was refused')
        const observation = await observeDependencyInstall({
            planned,
            options: { execute: executeProbe },
            stackId: `stack:${'5'.repeat(64)}` as StackId,
            observedAt: '2026-09-08T00:00:00.000Z',
        })
        expect(observation).toMatchObject({ code: ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY, observed: { state: 'available', value: true } })
        await expect(observeDependencyInstall({ ...({ planned, options: { execute: executeProbe }, stackId: observation.stackId, observedAt: observation.observed.observedAt }) }))
            .resolves.toMatchObject({ observed: { state: 'failed' } })
    })
    it('uses only canonical checkout identity and exact lockfile bytes', () => {
        const first = deriveCacheKey({ checkoutId, lockfileBytes: Buffer.from('one') })
        const same = deriveCacheKey({ checkoutId, lockfileBytes: Buffer.from('one') })
        const changed = deriveCacheKey({ checkoutId, lockfileBytes: Buffer.from('two') })
        expect(first).toEqual(same)
        expect(changed.cacheId).not.toBe(first.cacheId)
    })

    it('derives cache and lock authority without accepting caller paths', async () => {
        let input = await fixture()
        const helperSteps: import('./contract.js').ExecutionStep[] = []
        const planned = await planInstall(input, { execute: async (step) => {
            if (step.id.startsWith('install-filesystem-')) helperSteps.push(step)
            return executeProbe(step)
        } })
        expect(planned.kind).toBe('complete')
        if (planned.kind !== 'complete') return
        expect(planned.stampPath).toBe(input.state.paths.cache(input.checkoutId, planned.identity.lockfileSha256).path)
        expect(planned.lock?.path).toBe(input.state.paths.installLock(planned.identity.cacheId))
        expect(helperSteps.length).toBeGreaterThan(0)
        expect(helperSteps[0]?.argv).toHaveLength(3)
        expect(helperSteps[0]?.consumedFiles).toEqual([
            expect.objectContaining({ path: input.executables.node.canonicalPath, executable: true, argvIndexes: [0] }),
            { path: helperPath, sha256: input.executables.helper.sha256, maxBytes: 1_048_576, argvIndexes: [1], executable: false },
        ])
        expect(Buffer.byteLength(helperSteps[0]!.argv[2])).toBeLessThanOrEqual(65_536)
    })

    it.each(['lock', 'stamp'] as const)('refuses derived %s authority outside the state root', async (kind) => {
        const input = await fixture()
        const outside = join(dirname(input.state.root), `outside-${kind}`)
        const paths = kind === 'lock'
            ? { ...input.state.paths, installLock: () => join(outside, 'install.lock') }
            : { ...input.state.paths, cache: (subjectId: CheckoutId, qualifier: string) => ({
                ...input.state.paths.cache(subjectId, qualifier), path: join(outside, 'stamp.json'),
            }) }
        const result = await planInstall({ ...input, state: { ...input.state, paths } as StateNamespace }, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID })
    })

    it('refuses a filesystem root as checkout or cache authority', async () => {
        const input = await fixture()
        await expect(planInstall({ ...input, checkoutRoot: '/', lockfilePath: '/package-lock.json' }, { execute: executeProbe })).resolves.toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
    })

    it('refuses an oversized lockfile without reading it', async () => {
        const input = await fixture()
        const file = await open(input.lockfilePath, 'w')
        await file.truncate(536_870_913)
        await file.close()
        expect(await planInstall(input, { execute: executeProbe })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_STALE_PATH,
        })
    })

    it('accepts the schema-supported dependency volume vocabulary', async () => {
        const input = await fixture()
        expect(await planInstall({
            ...input,
            runtime: { variant: 'one', source: 'node_modules.v1', volume: 'synthetic_node_modules.v1' } as unknown as DependencyRuntimeBinding,
            policy: { ...input.policy, volume: 'node_modules.v1' },
        }, { execute: executeProbe })).toMatchObject({
            kind: 'complete',
        })
    })

    it('refuses a policy volume that does not match the authenticated runtime mount', async () => {
        const input = await fixture()
        const result = await planInstall({
            ...input,
            runtime: { variant: 'one', source: 'other-dependencies', volume: 'synthetic_other_dependencies' } as unknown as DependencyRuntimeBinding,
        }, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_STALE_PATH })
        const identity = deriveCacheKey({ checkoutId, lockfileBytes: await readFile(input.lockfilePath) })
        await expect(lstat(input.state.paths.installLock(identity.cacheId))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.each([
        ['sparse argv', (input: PlanInstallInput) => {
            const install = new Array(2) as [string, string]
            install[0] = input.policy.install[0]
            return { ...input, policy: { ...input.policy, install } }
        }],
        ['oversized argv', (input: PlanInstallInput) => ({
            ...input, policy: { ...input.policy, install: [input.policy.install[0], 'x'.repeat(65_537)] as [string, string] },
        })],
        ['oversized environment value', (input: PlanInstallInput) => ({
            ...input, execution: { ...input.execution, env: { VALUE: 'x'.repeat(65_537) } },
        })],
    ] as const)('refuses %s before issuing a plan', async (_kind, alter) => {
        const input = await fixture()
        expect(await planInstall(alter(input), { execute: executeProbe })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
    })

    it('refuses unknown public contract fields that would otherwise do nothing', async () => {
        const input = await fixture()
        const execution = { ...input.execution, ignored: true }
        expect(await planInstall({ ...input, execution } as PlanInstallInput, { execute: executeProbe })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
        expect(await planInstall({ ...input, observeHolder: 'live' as never }, { execute: executeProbe })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
    })

    it.each([
        ['checkout', 1, 'complete'],
        ['argv', 0, 'refusal'],
        ['environment', 0, 'refusal'],
    ] as const)('handles volatile %s input without unsafe nested reads', async (kind, expectedReads, expectedKind) => {
        const input = await fixture()
        let reads = 0
        if (kind === 'checkout') Object.defineProperty(input, 'checkoutId', {
            enumerable: true, get: () => ++reads === 1 ? checkoutId : 'not-canonical',
        })
        if (kind === 'argv') Object.defineProperty(input.policy.install, '1', {
            enumerable: true, get: () => { reads += 1; if (reads > 1) throw new Error('argv reread'); return '--harmless' },
        })
        if (kind === 'environment') Object.defineProperty(input.execution.env, 'VALUE', {
            enumerable: true, get: () => { reads += 1; if (reads > 1) throw new Error('environment reread'); return 'safe' },
        })
        const result = await planInstall(input, { execute: executeProbe })
        expect(reads).toBe(expectedReads)
        expect(result).toMatchObject(expectedKind === 'complete'
            ? { kind: 'complete' }
            : { kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID })
    })

    it.each([
        ['aggregate argv', (input: PlanInstallInput) => ({
            ...input, policy: { ...input.policy, install: [input.policy.install[0], ...Array.from({ length: 17 }, () => 'x'.repeat(65_000))] as [string, ...string[]] },
        })],
        ['oversized volume', (input: PlanInstallInput) => ({
            ...input, policy: { ...input.policy, volume: `v${'x'.repeat(65_536)}` },
        })],
    ] as const)('refuses %s before acquiring install authority', async (_kind, alter) => {
        const input = await fixture()
        const result = await planInstall(alter(input), { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID })
        const identity = deriveCacheKey({ checkoutId, lockfileBytes: await readFile(input.lockfilePath) })
        await expect(lstat(input.state.paths.installLock(identity.cacheId))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})

describe('install serialization', () => {
    it('serializes two independent helper processes racing for one lock', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-race-'))
        scratch.push(root)
        const request = (holderId: HolderId) => JSON.stringify({
            version: 1, requestId: randomUUID(), operation: 'acquire', root,
            segments: ['locks', 'shared.lock'],
            ownerBase64: Buffer.from(`${JSON.stringify({
                format: 'cockpit-install-lock/v1', holderId, pid: process.pid,
                acquiredAt: '2000-01-01T00:00:00.000Z', token: randomUUID(),
            })}\n`).toString('base64'),
        })
        const run = (encoded: string) => new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [helperPath, encoded], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
            let stdout = ''; let stderr = ''
            child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
            child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
            child.on('error', reject)
            child.on('close', (status) => stderr ? reject(new Error(stderr)) : resolve({ status, stdout }))
        })
        const outcomes = await Promise.all([run(request(holderA)), run(request(holderB))])
        expect(outcomes.every(({ status }) => status === 0)).toBe(true)
        expect(outcomes.map(({ stdout }) => JSON.parse(stdout).kind).sort()).toEqual(['acquired', 'exists'])
    })

    it('grants one authority to concurrent processes and names the other holder', async () => {
        const firstInput = await fixture(holderA)
        const secondInput = { ...firstInput, holderId: holderB }
        const [first, second] = await Promise.all([
            planInstall(firstInput, { execute: executeProbe }),
            planInstall(secondInput, { execute: executeProbe }),
        ])
        const outcomes = [first, second]
        expect(outcomes.filter((result) => result.kind === 'complete')).toHaveLength(1)
        expect(outcomes.filter((result) => result.kind === 'refusal')).toHaveLength(1)
        expect(outcomes.find((result) => result.kind === 'refusal')).toMatchObject({
            code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
    })

    it.each([
        ['live', ENVIRONMENT_CODES.INSTALL_LOCK_HELD],
        ['unknown', ENVIRONMENT_CODES.INSTALL_LOCK_INVALID],
        ['dead', ENVIRONMENT_CODES.INSTALL_STALE_PATH],
    ] as const)('distinguishes %s holder evidence and never steals by age', async (holderState, code) => {
        const input = await fixture(holderA)
        const first = await planInstall(input, { execute: executeProbe })
        expect(first.kind).toBe('complete')
        const old = new Date('2000-01-01T00:00:00.000Z')
        if (first.kind !== 'complete' || !first.lock) return
        const lockPath = first.lock.path
        await import('node:fs/promises').then(({ utimes }) => utimes(lockPath, old, old))
        const result = await planInstall({ ...input, holderId: holderB, observeHolder: async () => holderState }, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code, target: lockPath })
        expect((await lstat(lockPath)).isDirectory()).toBe(true)
    })

    it('passes the exact recorded holder to liveness observation and fails closed when observation throws', async () => {
        const input = await fixture(holderA)
        const first = await planInstall(input, { execute: executeProbe })
        if (first.kind !== 'complete' || !first.lock) throw new Error('expected lock')
        const observed: { holderId: HolderId; pid: number }[] = []
        const result = await planInstall({
            ...input,
            holderId: holderB,
            observeHolder: async (holder) => { observed.push(holder); throw new Error('unavailable') },
        }, { execute: executeProbe })
        expect(observed).toEqual([{ holderId: holderA, pid: process.pid }])
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID })
    })

    it.each(['symlink', 'hardlink'] as const)('refuses a %s lockfile without reading through it', async (kind) => {
        const input = await fixture()
        const original = `${input.lockfilePath}.original`
        await import('node:fs/promises').then(({ rename }) => rename(input.lockfilePath, original))
        if (kind === 'symlink') await symlink(original, input.lockfilePath)
        else await link(original, input.lockfilePath)
        const result = await planInstall(input, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_STALE_PATH })
    })

    it('refuses ownerless residue and preserves its evidence path', async () => {
        let input = await fixture()
        const identity = deriveCacheKey({ checkoutId, lockfileBytes: await readFile(input.lockfilePath) })
        const lockPath = input.state.paths.installLock(identity.cacheId)
        await mkdir(lockPath, { recursive: true })
        const result = await planInstall(input, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, target: lockPath })
        expect((await lstat(lockPath)).isDirectory()).toBe(true)
    })

    it.each(['extra', 'invalid-utf8', 'symlink', 'hardlink'] as const)('refuses %s owner evidence without deleting it', async (kind) => {
        const input = await fixture()
        const identity = deriveCacheKey({ checkoutId, lockfileBytes: await readFile(input.lockfilePath) })
        const lockPath = input.state.paths.installLock(identity.cacheId)
        const ownerPath = join(lockPath, 'owner.json')
        await mkdir(lockPath, { recursive: true })
        const valid = Buffer.from(`${JSON.stringify({
            format: 'cockpit-install-lock/v1', holderId: holderA, pid: 7,
            acquiredAt: '2000-01-01T00:00:00.000Z', token: randomUUID(),
        })}\n`)
        if (kind === 'invalid-utf8') await writeFile(ownerPath, Buffer.from([0xff]))
        else if (kind === 'symlink') {
            const outside = join(dirname(lockPath), 'outside-owner')
            await writeFile(outside, valid)
            await symlink(outside, ownerPath)
        } else if (kind === 'hardlink') {
            const outside = join(dirname(lockPath), 'outside-owner')
            await writeFile(outside, valid)
            await link(outside, ownerPath)
        } else {
            await writeFile(ownerPath, valid)
            await writeFile(join(lockPath, 'unexpected'), 'preserve')
        }
        const result = await planInstall(input, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal' })
        expect((await lstat(lockPath)).isDirectory()).toBe(true)
    })

    it.each([
        ['noncanonical timestamp', '2020-01-01', randomUUID()],
        ['invalid token', '2020-01-01T00:00:00.000Z', 'token'],
    ])('rejects owner evidence with %s before asking for liveness', async (_label, acquiredAt, token) => {
        const input = await fixture()
        const identity = deriveCacheKey({ checkoutId, lockfileBytes: await readFile(input.lockfilePath) })
        const lockPath = input.state.paths.installLock(identity.cacheId)
        await mkdir(lockPath, { recursive: true })
        await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({
            format: 'cockpit-install-lock/v1', holderId: holderA, pid: 7, acquiredAt, token,
        })}\n`)
        let observed = false
        const result = await planInstall({ ...input, observeHolder: async () => { observed = true; return 'live' } }, { execute: executeProbe })
        expect(observed).toBe(false)
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID })
    })

    it('requires the exact canonical owner record bytes', async () => {
        const input = await fixture()
        const identity = deriveCacheKey({ checkoutId, lockfileBytes: await readFile(input.lockfilePath) })
        const lockPath = input.state.paths.installLock(identity.cacheId)
        await mkdir(lockPath, { recursive: true })
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
            format: 'cockpit-install-lock/v1', holderId: holderA, pid: 7,
            acquiredAt: '2020-01-01T00:00:00.000Z', token: randomUUID(),
        }, null, 2))
        let observed = false
        const result = await planInstall({ ...input, observeHolder: async () => { observed = true; return 'live' } }, { execute: executeProbe })
        expect(observed).toBe(false)
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID })
    })
})

describe('install verification', () => {
    it('stamps only after authenticated install and same-mount load succeed', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const order: string[] = []
        const result = await verifyInstall(planned, { execute: async (step) => {
            if (step === planned.installStep) {
                order.push('install')
                await expect(readFile(planned.stampPath)).rejects.toMatchObject({ code: 'ENOENT' })
            } else if (step.id.includes('-stamp-')) {
                order.push('stamp')
            } else if (step === planned.loadProbeStep) {
                order.push('probe')
            }
            return executeProbe(step)
        } })
        expect(result).toMatchObject({ kind: 'complete', disposition: 'installed' })
        expect(order).toEqual(['install', 'probe', 'stamp'])
        expect(JSON.parse(await readFile(planned.stampPath, 'utf8'))).toMatchObject({ cacheId: planned.identity.cacheId })
        await expect(lstat(planned.lock!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('never stamps an install failure and preserves its exact executor code', async () => {
        const input = await fixture()
        await writeFile(input.installExecutable.canonicalPath, '#!/bin/sh\nexit 7\n')
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const result = await verifyInstall(planned, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED })
        expect(projectInstallProgress(result)).toEqual({ applied: [], attempted: ['install'], notApplied: ['load', 'stamp'] })
        expect(projectInstallProgress({ ...result })).toBeUndefined()
        await expect(readFile(planned.stampPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(planned.lock!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.each(['install', 'probe'] as const)('reports %s lockfile mutation before its command refusal', async (command) => {
        const input = await fixture()
        const path = command === 'install' ? input.installExecutable.canonicalPath : input.loadProbeExecutable.canonicalPath
        await writeFile(path, `#!/bin/sh\nprintf changed > ${JSON.stringify(input.lockfilePath)}\nexit 9\n`)
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED,
        })
    })

    it.each([
        ['#!/bin/sh\nsleep 1\n', 50, 16_384, ENVIRONMENT_CODES.EXECUTION_TIMEOUT],
        ['#!/bin/sh\nyes x | head -c 10000\n', 5_000, 32, ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT],
        ['#!/bin/sh\nyes x | head -c 10000 >&2\n', 5_000, 32, ENVIRONMENT_CODES.EXECUTION_STDERR_LIMIT],
    ] as const)('preserves bounded executor refusal %s', async (source, timeoutMs, stdoutLimitBytes, code) => {
        const input = await fixture()
        await writeFile(input.installExecutable.canonicalPath, source)
        const request = {
            ...input,
            execution: { ...input.execution, installTimeoutMs: timeoutMs, stdoutLimitBytes, stderrLimitBytes: stdoutLimitBytes },
        }
        const planned = await planInstall(request, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({ kind: 'refusal', code })
    })

    it('preserves an exact staging refusal at the install boundary', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const previous = process.env.TMPDIR
        process.env.TMPDIR = join(input.checkoutRoot, 'missing', 'staging')
        try {
            expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({
                kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_STAGING_FAILED,
            })
        } finally {
            if (previous === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previous
        }
    })

    it.skipIf(process.platform === 'win32')('preserves an exact staging-cleanup refusal at the install boundary', async () => {
        const input = await fixture()
        const source = '#!/bin/sh\nstaging=$(dirname "$0")\nprintf %s "$staging"\nchmod 500 "$staging"\n'
        await writeFile(input.installExecutable.canonicalPath, source)
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        let installOutcome: Awaited<ReturnType<typeof executeProbe>> | undefined
        const result = await verifyInstall(planned, { execute: async (step) => {
            const outcome = await executeProbe(step)
            if (step === planned.installStep) installOutcome = outcome
            return outcome
        } })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED })
        if (installOutcome) {
            const staging = installOutcome.stdout.toString()
            await chmod(staging, 0o700)
            await rm(staging, { recursive: true, force: true })
        }
    })

    it('does not publish a stamp when the same-mount load probe fails', async () => {
        const input = await fixture()
        await writeFile(input.loadProbeExecutable.canonicalPath, '#!/bin/sh\nexit 9\n')
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const result = await verifyInstall(planned, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED })
        await expect(readFile(planned.stampPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('keeps a failed load probe nonpass when projected as install health', async () => {
        const input = await fixture()
        await writeFile(input.loadProbeExecutable.canonicalPath, '#!/bin/sh\nexit 9\n')
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)

        const observation = await observeDependencyInstall({
            planned,
            options: { execute: executeProbe },
            stackId: `stack:${'5'.repeat(64)}` as StackId,
            observedAt: '2026-09-08T00:00:00.000Z',
        })

        expect(observation).toMatchObject({
            code: ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY,
            observed: { state: 'failed', reason: 'dependency load probe failed' },
        })
        expect(projectInstallProgress(observation)).toEqual({ applied: ['install'], attempted: ['load'], notApplied: ['stamp'] })
    })

    it('runs the load probe when a valid stamped cache is reused', async () => {
        const input = await fixture()
        const first = await planInstall(input, { execute: executeProbe })
        if (first.kind !== 'complete') throw new Error(first.message)
        expect(await verifyInstall(first, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
        const reused = await planInstall({ ...input, holderId: holderB }, { execute: executeProbe })
        expect(reused).toMatchObject({ kind: 'complete', disposition: 'reuse', installStep: null })
        if (reused.kind !== 'complete') return
        let installs = 0; let probes = 0
        expect(await verifyInstall(reused, { execute: async (step) => {
            if (step.id.startsWith('install-')) installs += 1
            if (step === reused.loadProbeStep) probes += 1
            return executeProbe(step)
        } })).toMatchObject({ kind: 'complete', disposition: 'reused' })
        expect({ installs, probes }).toEqual({ installs: 0, probes: 1 })
    })

    it('does not reuse a stamp produced for a different install policy', async () => {
        const input = await fixture()
        const first = await planInstall(input, { execute: executeProbe })
        if (first.kind !== 'complete') throw new Error(first.message)
        expect(await verifyInstall(first, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
        const changed = await planInstall({
            ...input,
            holderId: holderB,
            policy: { ...input.policy, install: [input.policy.install[0], '--different'] },
        }, { execute: executeProbe })
        expect(changed).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_STALE_PATH })
    })

    it('treats equivalent environment key order as one policy', async () => {
        const input = await fixture()
        const firstInput = { ...input, execution: { ...input.execution, env: { SECOND: '2', FIRST: '1' } } }
        const first = await planInstall(firstInput, { execute: executeProbe })
        if (first.kind !== 'complete') throw new Error(first.message)
        expect(await verifyInstall(first, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
        const second = await planInstall({
            ...input, holderId: holderB, execution: { ...input.execution, env: { FIRST: '1', SECOND: '2' } },
        }, { execute: executeProbe })
        expect(second).toMatchObject({ kind: 'complete', disposition: 'reuse' })
    })

    it.each(['volume', 'install-command', 'probe-command', 'runtime'] as const)(
        'binds the stamp to changed %s policy', async (kind) => {
            const input = await fixture()
            const first = await planInstall(input, { execute: executeProbe })
            if (first.kind !== 'complete') throw new Error(first.message)
            expect(await verifyInstall(first, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
            const changed = {
                ...input, holderId: holderB,
                policy: {
                    ...input.policy,
                    ...(kind === 'volume' ? { volume: 'other-dependencies' } : {}),
                    ...(kind === 'install-command' ? { install: [input.policy.install[0], '--changed'] as [string, ...string[]] } : {}),
                    ...(kind === 'probe-command' ? { load_probe: [input.policy.load_probe[0], '--changed'] as [string, ...string[]] } : {}),
                },
                ...(kind === 'runtime' ? { runtime: { variant: 'changed', volume: 'dependencies' } as unknown as DependencyRuntimeBinding } : {}),
            }
            expect(await planInstall(changed, { execute: executeProbe })).toMatchObject({
                kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_STALE_PATH,
            })
        },
    )

    it.each([
        Buffer.from('{'),
        Buffer.from([0xff]),
        Buffer.from('{"format":"cockpit-install-stamp/v1","extra":true}\n'),
    ])('refuses malformed or partial stamp bytes without replacing them', async (replacement) => {
        const input = await fixture()
        const first = await planInstall(input, { execute: executeProbe })
        if (first.kind !== 'complete') throw new Error(first.message)
        expect(await verifyInstall(first, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
        await writeFile(first.stampPath, replacement)
        const result = await planInstall({ ...input, holderId: holderB }, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_STALE_PATH, target: first.stampPath })
        expect(await readFile(first.stampPath)).toEqual(replacement)
    })

    it('detects lockfile mutation by the load probe and does not repair it', async () => {
        const input = await fixture()
        const mutator = input.loadProbeExecutable.canonicalPath
        await writeFile(mutator, `#!/bin/sh\nprintf probe-changed > ${JSON.stringify(input.lockfilePath)}\n`)
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED,
        })
        expect(await readFile(input.lockfilePath, 'utf8')).toBe('probe-changed')
    })

    it('preserves an issued receiptless precondition refusal exactly', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete' || !planned.installStep) throw new Error('expected install plan')
        await writeFile(input.installExecutable.canonicalPath, '#!/bin/sh\nexit 0\n# changed\n')
        const result = await verifyInstall(planned, { execute: executeProbe })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED })
    })

    it('refuses malformed public input instead of throwing', async () => {
        const input = await fixture()
        await expect(planInstall({ ...input, checkoutId: 'not-canonical' as CheckoutId }, { execute: executeProbe })).resolves.toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
        await expect(planInstall({ ...input, execution: { ...input.execution, helperTimeoutMs: Number.NaN } }, { execute: executeProbe })).resolves.toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
        })
    })

    it('preserves a primary executor refusal when exact-lock cleanup also fails', async () => {
        const input = await fixture()
        await writeFile(input.installExecutable.canonicalPath, '#!/bin/sh\nsleep 1\n')
        const request = {
            ...input,
            execution: { ...input.execution, installTimeoutMs: 50 },
        }
        const planned = await planInstall(request, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const result = await verifyInstall(planned, { execute: async (step) => {
            if (step.id.includes('-release-')) return {
                kind: 'complete', execution: { id: step.id, exitCode: 0, signal: null, started: true,
                    stdoutBytes: 0, stderrBytes: 0, stdoutObservedBytes: 0, stderrObservedBytes: 0,
                    stdoutRetainedBytes: 0, stderrRetainedBytes: 0 },
                receipt: { stepId: step.id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), receiptMatches: () => true },
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
            }
            return executeProbe(step)
        } })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_TIMEOUT })
        if (result.kind !== 'refusal') throw new Error('expected refusal')
        expect(result.recovery).toContain(planned.lock!.path)
    })

    it('keeps the snapshotted helper identity when caller-owned input is mutated', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        ;(input.executables.helper as { path: string }).path = join(input.checkoutRoot, 'redirected-helper')

        expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
    })

    it('reports cleanup uncertainty when cache preparation and exact-lock release both fail', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const result = await verifyInstall(planned, { execute: async (step) => {
            if (!step.id.includes('-ensure-directory-') && !step.id.includes('-release-')) return executeProbe(step)
            return {
                kind: 'complete', execution: { id: step.id, exitCode: 0, signal: null, started: true,
                    stdoutBytes: 0, stderrBytes: 0, stdoutObservedBytes: 0, stderrObservedBytes: 0,
                    stdoutRetainedBytes: 0, stderrRetainedBytes: 0 },
                receipt: { stepId: step.id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), receiptMatches: () => true },
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
            }
        } })
        expect(result).toMatchObject({ kind: 'refusal' })
        if (result.kind !== 'refusal') throw new Error('expected refusal')
        expect(result.recovery).toContain('release')
    })

    it('issues frozen exact steps with one resolved executable and bounded helper input', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete' || !planned.installStep) throw new Error('expected install plan')
        expect(Object.isFrozen(planned)).toBe(true)
        expect(Object.isFrozen(planned.installStep)).toBe(true)
        expect(planned.installStep.argv[0]).toBe(input.installExecutable.canonicalPath)
        expect(planned.installStep.argv0).toBe(input.installExecutable.invocationPath)
        expect(planned.installStep.consumedFiles).toHaveLength(1)
        expect(planned.installStep.consumedFiles[0]).toMatchObject({ maxBytes: 536_870_912, executable: true })
    })

    it('keeps private release evidence when the public byte snapshot is mutated', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete' || !planned.lock) throw new Error('expected install lock')
        planned.lock.ownerBytes.fill(0)
        expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({ kind: 'complete' })
        await expect(lstat(planned.lock.path)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses lockfile mutation without repairing product bytes', async () => {
        const input = await fixture()
        const mutator = input.installExecutable.canonicalPath
        await writeFile(mutator, `#!/bin/sh\nprintf changed > ${JSON.stringify(input.lockfilePath)}\n`)
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const result = await verifyInstall(planned, { execute: executeProbe })
        expect(result).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED,
            message: expect.stringContaining(mutator),
        })
        expect(await readFile(input.lockfilePath, 'utf8')).toBe('changed')
    })

    it.each(['inode', 'mode'] as const)('refuses a same-byte lockfile %s change after execution', async (kind) => {
        const input = await fixture()
        if (kind === 'mode') await chmod(input.lockfilePath, 0o644)
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        const original = await readFile(input.lockfilePath)
        const result = await verifyInstall(planned, { execute: async (step) => {
            const outcome = await executeProbe(step)
            if (step === planned.installStep) {
                if (kind === 'inode') {
                    const replacement = `${input.lockfilePath}.replacement`
                    await writeFile(replacement, original)
                    await import('node:fs/promises').then(({ rename }) => rename(replacement, input.lockfilePath))
                } else await chmod(input.lockfilePath, 0o600)
            }
            return outcome
        } })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED })
        expect(await readFile(input.lockfilePath)).toEqual(original)
    })

    it('rejects forged outcomes through the sole executor authenticator', async () => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        let calls = 0
        const result = await verifyInstall(planned, { execute: async (step) => {
            calls += 1
            return {
                kind: 'complete', execution: { id: step.id, exitCode: 0, signal: null, started: true,
                    stdoutBytes: 0, stderrBytes: 0, stdoutObservedBytes: 0, stderrObservedBytes: 0,
                    stdoutRetainedBytes: 0, stderrRetainedBytes: 0 },
                receipt: { stepId: step.id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), receiptMatches: () => true },
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
            }
        } })
        expect(calls).toBe(2)
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED })
    })

    it.each(['copied', 'mismatched', 'receiptless'] as const)('rejects a %s executor outcome', async (kind) => {
        const input = await fixture()
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete' || !planned.installStep) throw new Error('expected install plan')
        const installOutcome = await executeProbe(planned.installStep)
        const otherOutcome = await executeProbe(planned.loadProbeStep)
        const receiptless = {
            kind: 'refusal' as const, code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            execution: { id: planned.installStep.id, exitCode: 1, signal: null, started: false,
                stdoutBytes: 0, stderrBytes: 0, stdoutObservedBytes: 0, stderrObservedBytes: 0,
                stdoutRetainedBytes: 0, stderrRetainedBytes: 0 },
            stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        }
        const selected = kind === 'copied' ? { ...installOutcome }
            : kind === 'mismatched' ? otherOutcome : receiptless
        const result = await verifyInstall(planned, { execute: async (step) => step === planned.installStep ? selected : executeProbe(step) })
        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED })
    })
})

describe('filesystem helper protocol', () => {
    it('accepts one harmless request and rejects a malformed control', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-'))
        scratch.push(root)
        const valid = JSON.stringify({ version: 1, requestId: randomUUID(), operation: 'ensure-directory', root, segments: ['cache'] })
        const step = async (request: string) => executeProbe({
            id: `helper-${randomUUID()}`,
            argv: [process.execPath, helperPath, request], argv0: process.execPath, cwd: root, env: {}, timeoutMs: 5_000,
            stdoutLimitBytes: 16_384, stderrLimitBytes: 16_384, paths: [root], ports: [], labels: {}, expected: [],
            consumedFiles: [
                { path: process.execPath, sha256: await digest(process.execPath), maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                { path: helperPath, sha256: await digest(helperPath), maxBytes: 1_048_576, argvIndexes: [1], executable: false },
            ], filesystemChecks: [{ path: root, expected: 'directory' }], compensation: [],
        })
        const accepted = await step(valid)
        const rejected = await step('{"version":1}')
        expect(accepted.kind).toBe('complete')
        expect(accepted.stdout.toString()).toContain('"kind":"complete"')
        expect(rejected.kind).toBe('refusal')
    })

    it('rejects a valid request carrying an extra process argument', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-argv-'))
        scratch.push(root)
        const request = JSON.stringify({ version: 1, requestId: randomUUID(), operation: 'ensure-directory', root, segments: ['cache'] })
        const outcome = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [helperPath, request, 'unexpected'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
            let stdout = ''; let stderr = ''
            child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
            child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
            child.on('error', reject)
            child.on('close', (status) => resolve({ status, stdout, stderr }))
        })
        expect(outcome).toMatchObject({ status: 2, stdout: '' })
        expect(outcome.stderr).toContain('install-filesystem:')
    })

    it.skipIf(process.platform === 'win32')('refuses FIFO owner evidence without blocking', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-fifo-'))
        scratch.push(root)
        const lock = join(root, 'locks', 'shared.lock')
        await mkdir(lock, { recursive: true })
        execFileSync('mkfifo', [join(lock, 'owner.json')])
        const outcome = await helperProcess(root, {
            version: 1, requestId: randomUUID(), operation: 'acquire', root,
            segments: ['locks', 'shared.lock'], ownerBase64: Buffer.from('owner').toString('base64'),
        })
        expect(outcome.status).toBe(2)
        expect(outcome.stdout).toBe('')
    })

    it('publishes no stamp over an existing name', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-stamp-'))
        scratch.push(root)
        await mkdir(join(root, 'stamps'))
        const stamp = join(root, 'stamps', 'cache.json')
        await writeFile(stamp, 'original')
        const outcome = await helperProcess(root, {
            version: 1, requestId: randomUUID(), operation: 'stamp', root,
            segments: ['stamps'], name: 'cache.json', bytesBase64: Buffer.from('replacement').toString('base64'),
        })
        expect(outcome.status).toBe(2)
        expect(await readFile(stamp, 'utf8')).toBe('original')
    })

    it.each(['isolated', 'residue'] as const)('releases only the exact lock and preserves %s evidence', async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-release-'))
        scratch.push(root)
        const owner = Buffer.from('owner')
        const acquire = async (name: string) => {
            const request = { version: 1, requestId: randomUUID(), operation: 'acquire', root,
                segments: ['locks', name], ownerBase64: owner.toString('base64') }
            const outcome = await helperProcess(root, request)
            expect(outcome.status).toBe(0)
            return JSON.parse(outcome.stdout).lock as { path: string; dev: number; ino: number; ownerBase64: string }
        }
        const selected = await acquire('selected.lock')
        const other = await acquire('other.lock')
        if (kind === 'residue') await writeFile(join(selected.path, 'unexpected'), 'preserve')
        const quarantine = `.release-selected-${randomUUID()}`
        const outcome = await helperProcess(root, {
            version: 1, requestId: randomUUID(), operation: 'release', root,
            segments: ['locks', 'selected.lock'], dev: selected.dev, ino: selected.ino,
            ownerBase64: selected.ownerBase64, quarantine,
        })
        expect(outcome.status).toBe(0)
        expect((await lstat(other.path)).isDirectory()).toBe(true)
        const response = JSON.parse(outcome.stdout) as { kind: string; path: string; entries?: string[] }
        if (kind === 'isolated') expect(response).toMatchObject({ kind: 'released', path: selected.path })
        else {
            expect(response).toMatchObject({ kind: 'residue', path: join(root, 'locks', quarantine) })
            expect(await readFile(join(response.path, 'unexpected'), 'utf8')).toBe('preserve')
        }
    })

    it('rejects root and lock-name replacement against recorded inode authority', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-replaced-'))
        scratch.push(root)
        const requestId = randomUUID()
        const acquired = await helperProcess(root, { version: 1, requestId, operation: 'acquire', root,
            segments: ['locks', 'selected.lock'], ownerBase64: Buffer.from('owner').toString('base64') })
        const lock = JSON.parse(acquired.stdout).lock as { path: string; dev: number; ino: number; ownerBase64: string }
        const original = `${lock.path}.original`
        await rename(lock.path, original)
        await mkdir(lock.path)
        await writeFile(join(lock.path, 'owner.json'), 'replacement')
        const released = await helperProcess(root, { version: 1, requestId: randomUUID(), operation: 'release', root,
            segments: ['locks', 'selected.lock'], dev: lock.dev, ino: lock.ino, ownerBase64: lock.ownerBase64,
            quarantine: `.release-replaced-${randomUUID()}` })
        expect(released.status).toBe(2)
        expect(await readFile(join(lock.path, 'owner.json'), 'utf8')).toBe('replacement')

        const realRoot = `${root}.real`
        await rename(root, realRoot)
        await symlink(realRoot, root)
        const rootOutcome = await helperProcess(realRoot, { version: 1, requestId: randomUUID(), operation: 'ensure-directory', root,
            segments: ['escaped'] })
        expect(rootOutcome.status).toBe(2)
    })

    it.each(['root', 'parent'] as const)('refuses %s replacement after pinning during directory creation', async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-pin-'))
        scratch.push(root)
        const preload = join(root, 'replace.cjs')
        const trigger = kind === 'root' ? join(root, 'first') : join(root, 'first', 'second')
        const replaced = kind === 'root' ? root : join(root, 'first')
        const moved = `${replaced}.pinned`
        await writeFile(preload, `const fs = require('node:fs')
const mkdir = fs.mkdirSync.bind(fs)
fs.mkdirSync = function (path, options) {
  const result = mkdir(path, options)
  if (path === process.env.COCKPIT_TRIGGER) {
    fs.renameSync(process.env.COCKPIT_REPLACED, process.env.COCKPIT_MOVED)
    mkdir(process.env.COCKPIT_REPLACED, { mode: 0o700 })
  }
  return result
}
`)
        const outcome = await helperWithPreload(root, {
            version: 1, requestId: randomUUID(), operation: 'ensure-directory', root,
            segments: ['first', 'second', 'third'],
        }, preload, { COCKPIT_TRIGGER: trigger, COCKPIT_REPLACED: replaced, COCKPIT_MOVED: moved })
        expect(outcome.status).toBe(2)
        expect(outcome.stdout).toBe('')
        expect((await lstat(moved)).isDirectory()).toBe(true)
    })

    it('refuses lock-name replacement immediately after owner publication', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-helper-owner-race-'))
        scratch.push(root)
        const preload = join(root, 'replace.cjs')
        const lock = join(root, 'locks', 'selected.lock')
        const moved = `${lock}.published`
        await writeFile(preload, `const fs = require('node:fs')
const link = fs.linkSync.bind(fs)
fs.linkSync = function (source, target) {
  const result = link(source, target)
  const lock = require('node:path').dirname(target)
  fs.renameSync(lock, process.env.COCKPIT_MOVED)
  fs.mkdirSync(lock, { mode: 0o700 })
  return result
}
`)
        const outcome = await helperWithPreload(root, {
            version: 1, requestId: randomUUID(), operation: 'acquire', root,
            segments: ['locks', 'selected.lock'], ownerBase64: Buffer.from('owner').toString('base64'),
        }, preload, { COCKPIT_MOVED: moved })
        expect(outcome.status).toBe(2)
        expect(outcome.stdout).toBe('')
        expect((await lstat(moved)).isDirectory()).toBe(true)
        expect((await readFile(join(moved, 'owner.json'))).toString()).toBe('owner')
    })

    it.each(['wrong-request', 'extra-key', 'nested-key', 'wrong-path', 'multiple-output', 'stderr', 'nonzero'] as const)(
        'refuses digest-bound helper evidence with %s', async (kind) => {
            const input = await fixture()
            const malicious = join(dirname(input.installExecutable.canonicalPath), `helper-${kind}`)
            const mutation = kind === 'wrong-request' ? "response.requestId = '11111111-1111-4111-8111-111111111111'"
                : kind === 'extra-key' ? 'response.extra = true'
                    : kind === 'nested-key' ? 'response.lock.extra = true'
                        : kind === 'wrong-path' ? "response.lock.path = '/wrong'"
                            : ''
            const trailer = kind === 'multiple-output' ? "process.stdout.write(JSON.stringify(response) + '\\n{}\\n')"
                : kind === 'stderr' ? "process.stderr.write('unexpected\\n'); process.stdout.write(JSON.stringify(response) + '\\n')"
                    : kind === 'nonzero' ? "process.stdout.write(JSON.stringify(response) + '\\n'); process.exitCode = 7"
                        : "process.stdout.write(JSON.stringify(response) + '\\n')"
            await writeFile(malicious, `const { join } = require('node:path')
const request = JSON.parse(process.argv[2])
const response = { version: 1, requestId: request.requestId, kind: 'acquired', lock: {
  path: join(request.root, ...request.segments), dev: 1, ino: 1, ownerBase64: request.ownerBase64
} }
${mutation}
${trailer}
`)
            const result = await planInstall({
                ...input,
                executables: { ...input.executables, helper: { path: malicious, sha256: await digest(malicious) } },
            }, { execute: executeProbe })
            expect(result).toMatchObject({
                kind: 'refusal',
                code: kind === 'nonzero' ? ENVIRONMENT_CODES.EXECUTION_STEP_FAILED : ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
            })
        },
    )

    it.each([
        ['signal', '#!/bin/sh\nkill -TERM $$\n', ENVIRONMENT_CODES.EXECUTION_STEP_FAILED],
        ['missing interpreter', '#!/definitely/missing\n', ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED],
    ] as const)('preserves a real %s executor refusal', async (_kind, source, code) => {
        const input = await fixture()
        await writeFile(input.installExecutable.canonicalPath, source)
        await chmod(input.installExecutable.canonicalPath, 0o700)
        const planned = await planInstall(input, { execute: executeProbe })
        if (planned.kind !== 'complete') throw new Error(planned.message)
        expect(await verifyInstall(planned, { execute: executeProbe })).toMatchObject({ kind: 'refusal', code })
    })
})
