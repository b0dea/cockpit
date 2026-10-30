import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENTRYPOINT_KINDS } from '../entrypoint-kinds.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT, type EntrypointDerivative } from '../schema.js'
import { acquireClaim, coordinationStateRecord, decodeCoordinationRecord, readRootPortInventory, releaseClaim, reserveDrain, reserveDrainAttempt } from './claims.js'
import {
    ENVIRONMENT_CODES,
    type CheckoutId,
    type CockpitId,
    type HolderId,
    type StackId,
} from './contract.js'
import {
    deriveEntrypoints,
    compensateAcquiredPortHolder,
    consumePortLeaseProjection,
    inspectPortLeaseProjection,
    leasePortFamily as decidePortFamily,
    observePortFamily,
    observePortListeners,
    observeRetainedPortFamily,
    projectRetainedPortFamilyResult,
    projectPortLeaseResult,
    revalidatePortLeaseProjection,
    releasePortFamily,
    type PortListenerEvidenceInput,
} from './ports.js'
import { readState, selectStateRoot, transactState, type StateNamespace } from './state.js'

const publicationGate = vi.hoisted(() => ({
    prefix: undefined as string | undefined,
    reached: undefined as (() => void) | undefined,
    continuation: undefined as Promise<void> | undefined,
}))
const listenerGate = vi.hoisted(() => ({ listening: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
            if (typeof args[0] === 'string' && publicationGate.prefix
                && args[0].startsWith(publicationGate.prefix) && args[0].endsWith('.tmp')) {
                publicationGate.prefix = undefined
                publicationGate.reached?.()
                await publicationGate.continuation
            }
            return actual.open(...args)
        },
    }
})

// These cases own lease decisions, while observations.test.ts exercises the real loopback
// corroboration against an ephemeral listening server. Keep unrelated host services from choosing
// a different family than the synthetic listener evidence declared by this fixture.
vi.mock('node:net', async () => {
    const actual = await vi.importActual<typeof import('node:net')>('node:net')
    const { EventEmitter } = await import('node:events')
    return {
        ...actual,
        createConnection: (options: { host?: string; port?: number }) => {
            const socket = new EventEmitter() as unknown as ReturnType<typeof actual.createConnection>
            socket.destroy = () => socket
            socket.setTimeout = () => socket
            queueMicrotask(() => listenerGate.listening.has(`${options.host}:${options.port}`)
                ? socket.emit('connect')
                : socket.emit('error', Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })))
            return socket
        },
    }
})

const cockpitId = `cockpit:ports-a1:${'a'.repeat(64)}` as CockpitId
const otherCockpitId = `cockpit:ports-b2:${'b'.repeat(64)}` as CockpitId
const checkoutId = `checkout:${'b'.repeat(64)}` as CheckoutId
const holderA = `holder:${'c'.repeat(64)}:session` as HolderId
const holderB = `holder:${'d'.repeat(64)}:session` as HolderId
const stackA = `stack:${'e'.repeat(64)}` as StackId
const stackB = `stack:${'f'.repeat(64)}` as StackId
const roots: string[] = []
const now = '2026-09-07T12:00:00.000Z'
const config = { step: 100, count: 3, bases: { WEB: 3000, API: 4000 } }

afterEach(async () => {
    publicationGate.prefix = undefined
    publicationGate.reached = undefined
    publicationGate.continuation = undefined
    listenerGate.listening.clear()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('current listener evidence', () => {
    it('observes exact IPv4 and IPv6 listening and free expectations without mutating ports', async () => {
        listenerGate.listening.add('127.0.0.1:3100')
        listenerGate.listening.add('::1:4100')

        await expect(observePortListeners({
            bindings: [
                { hostIp: '0.0.0.0', port: 3100, expected: 'listening' },
                { hostIp: '::', port: 4100, expected: 'listening' },
                { hostIp: '127.0.0.1', port: 5100, expected: 'free' },
                { hostIp: '::1', port: 5100, expected: 'free' },
            ],
            timeoutMs: 1_000,
        })).resolves.toMatchObject({
            kind: 'complete',
            rows: [
                { hostIp: '0.0.0.0', probeHost: '127.0.0.1', port: 3100, listening: true },
                { hostIp: '::', probeHost: '::1', port: 4100, listening: true },
                { hostIp: '127.0.0.1', probeHost: '127.0.0.1', port: 5100, listening: false },
                { hostIp: '::1', probeHost: '::1', port: 5100, listening: false },
            ],
            observedAt: expect.any(String),
        })
    })
})

async function namespace(): Promise<StateNamespace> {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-ports-'))
    roots.push(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
    if (selected.kind !== 'complete') throw new Error(`state root unavailable: ${selected.kind}`)
    return selected.value
}

async function independentNamespaces() {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-ports-'))
    roots.push(home)
    const states = await Promise.all([cockpitId, otherCockpitId].map(async (identity) => {
        const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: identity })
        if (selected.kind !== 'complete') throw new Error(`state root unavailable: ${selected.kind}`)
        return selected.value
    }))
    return { home, left: states[0]!, right: states[1]! }
}

async function interceptDirectorySync(directoryPath: string, intercept: () => Promise<void> | void) {
    const handle = await open(directoryPath, 'r')
    const expected = await handle.stat()
    const prototype = Object.getPrototypeOf(handle) as { sync: typeof handle.sync }
    const realSync = prototype.sync
    await handle.close()
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof handle) {
        const actual = await this.stat()
        if (actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino) await intercept()
        await realSync.call(this)
    })
    return () => spy.mockRestore()
}

async function claim(state: StateNamespace, stackId: StackId, holderId: HolderId): Promise<void> {
    const result = await acquireClaim({
        namespace: state,
        stackId,
        holder: { holderId, checkoutId },
        now,
    })
    if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
}

const noListeners = async (ports: readonly number[]) => ({
    state: 'available' as const,
    value: ports.filter(() => false),
    observedAt: now,
    producer: 'test-listener-probe',
})

type ResolverInput = Omit<Parameters<typeof decidePortFamily>[0], 'listenerEvidence'> & {
    readonly observeListeners: (
        ports: readonly number[],
        budgetMs: number,
    ) => Promise<PortListenerEvidenceInput['observation']>
}

async function leasePortFamily(input: ResolverInput): ReturnType<typeof decidePortFamily> {
    const { observeListeners, ...decision } = input
    const listenerEvidence: PortListenerEvidenceInput[] = []
    const baseCount = Object.keys(input.config.bases).length
    if (
        Number.isSafeInteger(input.config.count)
        && input.config.count > 0
        && Number.isSafeInteger(input.config.count * baseCount)
        && input.config.count * baseCount <= STRUCTURED_INPUT_ENTRY_LIMIT
    ) {
        const current = await readState(input.namespace.paths.coordination(input.stackId))
        const activeOffset = current.kind === 'complete'
            ? (current.value.value as { lease?: { offset?: number; released?: boolean } }).lease
            : undefined
        const indexes = activeOffset && !activeOffset.released && Number.isSafeInteger(activeOffset.offset)
            ? [activeOffset.offset! / input.config.step]
            : Array.from({ length: input.config.count }, (_, index) => index)
        for (const index of indexes) {
            const offset = index * input.config.step
            const ports = Object.values(input.config.bases).map((base) => base + offset)
            if (ports.every((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535)) {
                listenerEvidence.push({ ports, observation: await observeListeners(ports, input.listenerTimeoutMs) })
            }
        }
    }
    return decidePortFamily({ ...decision, listenerEvidence })
}

function runLease(input: {
    home: string
    stackId: StackId
    holderId: HolderId
    cockpitId?: CockpitId
    ready?: () => Promise<void>
}): Promise<void> {
    const portsFixtureModule = fileURLToPath(new URL('../../test-support/port-lease-fixture.ts', import.meta.url))
    const stateModule = fileURLToPath(new URL('./state.ts', import.meta.url))
    const source = `
        import { leasePortFamilyFixture } from ${JSON.stringify(portsFixtureModule)}
        import { selectStateRoot } from ${JSON.stringify(stateModule)}
        const [home, cockpitId, stackId, holderId, checkoutId] = process.argv.slice(1)
        const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
        if (selected.kind !== 'complete') throw new Error(JSON.stringify(selected))
        process.send('ready')
        await new Promise((resolve) => process.once('message', resolve))
        const lease = await leasePortFamilyFixture({
            namespace: selected.value, stackId, holderId, checkoutId,
            config: ${JSON.stringify(config)}, now: ${JSON.stringify(now)}, listenerTimeoutMs: 100,
            listenerEvidence: [0, 100, 200].map((offset) => ({
                ports: [3000 + offset, 4000 + offset],
                observation: { state: 'available', value: [], observedAt: ${JSON.stringify(now)}, producer: 'process-control' },
            })),
        })
        if (lease.kind !== 'complete') throw new Error(JSON.stringify(lease))
    `
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            '--import', 'tsx', '--input-type=module', '--eval', source,
            input.home, input.cockpitId ?? cockpitId, input.stackId, input.holderId, checkoutId,
        ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
        let stderr = ''
        child.once('error', reject)
        if (!child.stderr) {
            child.kill()
            reject(new Error('lease subprocess stderr was not piped'))
            return
        }
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => { stderr += chunk })
        child.once('message', async () => {
            try {
                await input.ready?.()
                child.send('allocate')
                child.disconnect()
            } catch (error) {
                child.kill()
                reject(error)
            }
        })
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)))
    })
}

describe('independent cockpits sharing a state root', () => {
    it('never publishes a duplicate foreign reservation while another publication is paused', async () => {
        const { left, right } = await independentNamespaces()
        let prepared!: () => void
        let release!: () => void
        const preparing = new Promise<void>((resolve) => { prepared = resolve })
        publicationGate.prefix = join(dirname(left.paths.coordination(stackA).path), '.')
        publicationGate.reached = prepared
        publicationGate.continuation = new Promise<void>((resolve) => { release = resolve })
        const first = leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        let second: Awaited<ReturnType<typeof leasePortFamily>>
        try {
            await preparing
            second = await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: noListeners })
        } finally { release() }
        const accepted = await first
        if (accepted.kind !== 'complete') throw new Error(JSON.stringify(accepted))
        if (second.kind === 'refusal') {
            expect(second.diagnostics).toMatchObject([{ code: ENVIRONMENT_CODES.STATE_LOCKED }])
            second = await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: noListeners })
        }
        expect(second).toMatchObject({ kind: 'complete' })
        if (second.kind !== 'complete') throw new Error(JSON.stringify(second))
        const secondPorts = Object.values(second.lease.ports)
        expect(Object.values(accepted.lease.ports).every((port) => !secondPorts.includes(port))).toBe(true)
    })

    it('serialises concurrent equal-stack requests before any listener starts', async () => {
        const { left, right } = await independentNamespaces()
        expect(left.root).toBe(right.root)
        let arrivals = 0
        let release!: () => void
        const bothReady = new Promise<void>((resolve) => { release = resolve })
        const observe = () => {
            let first = true
            return async (ports: readonly number[]) => {
                if (first) {
                    first = false
                    if (++arrivals === 2) release()
                    await bothReady
                }
                return noListeners(ports)
            }
        }
        const leases = await Promise.all([
            leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: observe() }),
            leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: observe() }),
        ])
        expect(leases.map(({ kind }) => kind)).toEqual(['complete', 'complete'])
        if (leases[0]!.kind !== 'complete' || leases[1]!.kind !== 'complete') throw new Error('expected both independent leases')
        expect(new Set(leases.flatMap((lease) => lease.kind === 'complete' ? Object.values(lease.lease.ports) : [])).size).toBe(4)
        expect(leases[0]!.lease.offset).not.toBe(leases[1]!.lease.offset)
    })

    it('preserves disjoint reservations across independent processes with equal stack IDs', async () => {
        const { home, left, right } = await independentNamespaces()
        let arrivals = 0
        let release!: () => void
        const bothReady = new Promise<void>((resolve) => { release = resolve })
        const ready = async () => {
            if (++arrivals === 2) release()
            await bothReady
        }
        await Promise.all([
            runLease({ home, cockpitId, stackId: stackA, holderId: holderA, ready }),
            runLease({ home, cockpitId: otherCockpitId, stackId: stackA, holderId: holderB, ready }),
        ])
        const records = await Promise.all([readState(left.paths.coordination(stackA)), readState(right.paths.coordination(stackA))])
        const ports = records.map((record) => {
            if (record.kind !== 'complete') throw new Error('expected both published coordination records')
            const value = decodeCoordinationRecord(record.value, stackA)
            if (!value?.lease) throw new Error('expected both published leases')
            return Object.values(value.lease.ports)
        })
        expect(ports[0]!.every((port) => !ports[1]!.includes(port))).toBe(true)
    })

    it('refuses a foreign no-listener reservation when the only family is occupied', async () => {
        const { left, right } = await independentNamespaces()
        const oneFamily = { ...config, count: 1 }
        expect(await leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config: oneFamily, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete', lease: { offset: 0 } })
        expect(await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config: oneFamily, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED }],
        })
        expect(await readState(right.paths.coordination(stackA))).toMatchObject({ kind: 'missing' })
    })

    it('counts only local stacks when foreign families do not overlap', async () => {
        const { left, right } = await independentNamespaces()
        const foreignConfig = { ...config, count: 1, bases: { WEB: 7000, API: 8000 } }
        const localConfig = { ...config, count: 1, bases: { WEB: 9000, API: 10000 } }
        expect(await leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config: foreignConfig, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete' })
        expect(await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config: localConfig, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete', lease: { offset: 0 } })
        expect(await leasePortFamily({ namespace: right, stackId: stackB, holderId: holderA, checkoutId, config: localConfig, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED }],
        })
    })

    it('retains compensated foreign reservations and reuses only released families', async () => {
        const { left, right } = await independentNamespaces()
        const first = await leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        const second = await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        expect(first).toMatchObject({ kind: 'complete', lease: { offset: 0 } })
        expect(second).toMatchObject({ kind: 'complete', lease: { offset: 100 } })
        if (first.kind !== 'complete' || second.kind !== 'complete') throw new Error('expected both independent leases')
        const before = await readFile(right.paths.coordination(stackA).path)
        expect(await compensateAcquiredPortHolder({ namespace: right, leaseResult: first, now })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
        })
        expect(await releasePortFamily({ namespace: right, stackId: stackA, requesterId: holderA, holderId: holderB, now })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }],
        })
        expect(await readFile(right.paths.coordination(stackA).path)).toEqual(before)
        expect(await compensateAcquiredPortHolder({ namespace: left, leaseResult: first, now })).toMatchObject({
            kind: 'complete', change: 'compensated', remainingHolderIds: [],
        })
        expect(await readState(left.paths.coordination(stackA))).toMatchObject({
            kind: 'complete', value: { value: { holders: [], lease: { offset: 0, released: false } } },
        })
        expect(await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete', change: 'unchanged', lease: { offset: 100 } })
        expect(await readFile(right.paths.coordination(stackA).path)).toEqual(before)
        expect(await leasePortFamily({ namespace: left, stackId: stackB, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete', lease: { offset: 200 } })
        expect(await transactState(left, left.paths.coordination(stackA), { ownerId: holderA }, (current) => {
            const value = decodeCoordinationRecord(current, stackA)
            if (!value?.lease || value.holders.length !== 0) throw new Error('expected an unheld retained reservation fixture')
            return coordinationStateRecord(left, stackA, current, now, { ...value, lease: { ...value.lease, released: true } })
        })).toMatchObject({ kind: 'complete' })
        expect(await leasePortFamily({ namespace: right, stackId: stackB, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete', lease: { offset: 0 } })
        expect(await readFile(right.paths.coordination(stackA).path)).toEqual(before)
    })

    it.each(['retained acquisition', 'retained observation', 'health observation'] as const)('refuses a persisted foreign collision during %s', async (boundary) => {
        const { left, right } = await independentNamespaces()
        const first = await leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        expect(await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete' })
        if (first.kind !== 'complete') throw new Error('expected initial lease')
        expect(await transactState(right, right.paths.coordination(stackA), { ownerId: holderB }, (current) => {
            const value = decodeCoordinationRecord(current, stackA)
            if (!value?.lease) throw new Error('expected foreign lease')
            return coordinationStateRecord(right, stackA, current, now, {
                ...value, lease: { ...value.lease, offset: first.lease.offset, ports: { ...first.lease.ports } },
            })
        })).toMatchObject({ kind: 'complete' })
        const before = await readFile(left.paths.coordination(stackA).path)
        if (boundary === 'retained acquisition') {
            expect(await leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED }],
            })
        } else if (boundary === 'retained observation') {
            expect(await observeRetainedPortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION }],
            })
        } else {
            expect(await observePortFamily({ namespace: left, stackId: stackA, observedAt: now, leaseEvidence: first })).toMatchObject({
                observed: { state: 'available', value: false },
            })
        }
        expect(await readFile(left.paths.coordination(stackA).path)).toEqual(before)
    })

    // Refusing here let one unreadable namespace of another cockpit block every cockpit on the
    // machine. Its reservation is ignored, so the inventory names it for the caller to report.
    it.each(['malformed JSON', 'wrong cockpit identity', 'linked record', 'linked namespace', 'unsafe record mode', 'publication residue'] as const)(
        'leases past a foreign %s and names the skipped namespace', async (damage) => {
            const { home, left, right } = await independentNamespaces()
            expect(await leasePortFamily({ namespace: right, stackId: stackA, holderId: holderB, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete' })
            const path = right.paths.coordination(stackA).path
            if (damage === 'malformed JSON') await writeFile(path, '{')
            if (damage === 'wrong cockpit identity') {
                const record = JSON.parse(await readFile(path, 'utf8'))
                await writeFile(path, JSON.stringify({ ...record, cockpitId }))
            }
            if (damage === 'linked record') {
                const moved = join(home, 'foreign-record.json')
                await rename(path, moved)
                await symlink(moved, path)
            }
            if (damage === 'linked namespace') {
                const moved = join(home, 'foreign-store')
                await rename(right.cockpitRoot, moved)
                await symlink(moved, right.cockpitRoot)
            }
            if (damage === 'unsafe record mode') await chmod(path, 0o666)
            if (damage === 'publication residue') {
                await writeFile(join(dirname(path), `.stack_${'f'.repeat(64)}.11111111-1111-4111-8111-111111111111.tmp`), '{}', { mode: 0o600 })
            }
            expect(await leasePortFamily({ namespace: left, stackId: stackA, holderId: holderA, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete' })
            expect(await readRootPortInventory(left)).toMatchObject({ kind: 'complete',
                skipped: [{ path: right.cockpitRoot, reason: expect.any(String) }] })
        },
    )
})

describe('whole-family port leases', () => {
    it.each(['sleep', 'down', 'reset'] as const)('blocks claim and lease acquisition and every release during a %s drain', async (purpose) => {
        const state = await namespace()
        const lease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        if (lease.kind !== 'complete') throw new Error('lease fixture unavailable')
        const reserved = await reserveDrain({ namespace: state, request: {
            purpose, stackId: stackA, holderId: holderA, requesterId: holderA,
            configSha256: '1'.repeat(64), planDigest: '2'.repeat(64), operationBasis: '3'.repeat(64),
            generation: '4'.repeat(64), targetIds: [stackA],
            actions: [{ stage: 'runtime-stop', targetId: stackA, validForMs: 30_000 }],
            expectedCoordinationRevision: lease.recordRevision,
        } })
        expect(reserved.kind).toBe('complete')
        const before = await readState(state.paths.coordination(stackA))
        expect(await acquireClaim({ namespace: state, stackId: stackA, holder: { holderId: holderA, checkoutId }, now }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        for (const release of [
            () => releaseClaim({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA, now }),
            () => releaseClaim({ namespace: state, stackId: stackA, requesterId: holderB, holderId: holderB, now }),
            () => releaseClaim({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderB, now }),
            () => releasePortFamily({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA, now }),
            () => releasePortFamily({ namespace: state, stackId: stackA, requesterId: holderB, holderId: holderB, now }),
        ]) {
            expect(await release()).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        }
        expect(await readState(state.paths.coordination(stackA))).toEqual(before)
    })
    it('returns committed holder and revision provenance without inference', async () => {
        const state = await namespace()
        const first = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        const second = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        const secondHolder = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderB, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        expect(first).toMatchObject({ kind: 'complete', change: 'acquired', holderId: holderA, recordRevision: 0, lease: { stackId: stackA } })
        expect(second).toMatchObject({ kind: 'complete', change: 'unchanged', holderId: holderA, recordRevision: 0, lease: { stackId: stackA } })
        expect(secondHolder).toMatchObject({ kind: 'complete', change: 'acquired', holderId: holderB, recordRevision: 1, lease: { stackId: stackA } })
    })

    it('accepts exact selected or complete declared listener evidence for an active lease', async () => {
        const state = await namespace()
        const first = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (first.kind !== 'complete') throw new Error('lease fixture unavailable')
        const observedAt = '2026-09-07T12:00:01.000Z'
        const entry = (ports: readonly number[]): PortListenerEvidenceInput => ({
            ports,
            observation: { state: 'available', value: [], observedAt, producer: 'test-listener-probe' },
        })
        const full = [entry([3000, 4000]), entry([3100, 4100]), entry([3200, 4200])]
        const decide = (listenerEvidence: readonly PortListenerEvidenceInput[]) => decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config,
            now: observedAt, listenerTimeoutMs: 100, listenerEvidence,
        })

        await expect(decide(full)).resolves.toMatchObject({ kind: 'complete', change: 'unchanged' })
        await expect(decide([full[0]!])).resolves.toMatchObject({ kind: 'complete', change: 'unchanged' })
        for (const listenerEvidence of [
            [full[0]!, full[1]!],
            [full[0]!, entry([3300, 4300])],
            [full[0]!, full[0]!],
        ]) {
            await expect(decide(listenerEvidence)).resolves.toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
            })
        }
    })

    it('projects only an authentic lease with its authentic resolved entrypoints', async () => {
        const state = await namespace()
        const lease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        if (lease.kind !== 'complete') throw new Error('lease fixture unavailable')
        const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
        if (entrypoints.kind !== 'complete') throw new Error('entrypoint fixture unavailable')
        expect(Object.isFrozen(lease)).toBe(true)
        expect(Object.isFrozen(lease.lease)).toBe(true)
        expect(Object.isFrozen(lease.lease.ports)).toBe(true)
        expect(Reflect.set(lease.lease.ports, 'WEB', 3999)).toBe(false)

        expect(projectPortLeaseResult({ leaseResult: { ...lease }, entrypointResult: entrypoints } as never)).toBeUndefined()
        expect(projectPortLeaseResult({ leaseResult: lease, entrypointResult: { ...entrypoints } } as never)).toBeUndefined()
        const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
        expect(projection).toMatchObject({
            lease: { stackId: stackA, ports: { WEB: 3000, API: 4000 } },
            ownership: { change: 'acquired', holderId: holderA, recordRevision: 0, holderCount: 1, holderIds: [holderA] },
        })
        expect(projection?.entrypoints).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'web', port: 'WEB', value: 'http://127.0.0.1:3000/' }),
        ]))
        expect(inspectPortLeaseProjection({ ...projection } as never)).toBeUndefined()
        expect(inspectPortLeaseProjection(projection!)).toBe(projection)
        expect(inspectPortLeaseProjection(projection!)).toBe(projection)
        expect(consumePortLeaseProjection({ ...projection } as never)).toBeUndefined()
        expect(consumePortLeaseProjection(projection!)).toBe(projection)
        expect(inspectPortLeaseProjection(projection!)).toBeUndefined()
        expect(consumePortLeaseProjection(projection!)).toBeUndefined()
        expect(inspectPortLeaseProjection(projection!, state)).toBe(projection)
        expect(inspectPortLeaseProjection(projection!, await namespace())).toBeUndefined()
        expect(inspectPortLeaseProjection({ ...projection } as never, state)).toBeUndefined()
        expect(inspectPortLeaseProjection(projection!)).toBeUndefined()
        expect(consumePortLeaseProjection(projection!)).toBeUndefined()

        const secondLease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderB, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        if (secondLease.kind !== 'complete') throw new Error('second lease fixture unavailable')
        const secondEntrypoints = deriveEntrypoints({ lease: secondLease.lease, declarations: [] })
        if (secondEntrypoints.kind !== 'complete') throw new Error('second entrypoint fixture unavailable')
        expect(projectPortLeaseResult({ leaseResult: secondLease, entrypointResult: secondEntrypoints })).toMatchObject({
            ownership: { change: 'acquired', holderId: holderB, recordRevision: 1, holderCount: 2, holderIds: [holderA, holderB] },
        })
    })

    it('returns a named refusal when a derivative lease getter throws', () => {
        const hostile = {} as Parameters<typeof deriveEntrypoints>[0]
        Object.defineProperty(hostile, 'lease', { get: () => { throw new Error('hostile lease getter') } })

        const result = deriveEntrypoints(hostile)
        expect(result).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }],
        })
    })

    it('ignores unrelated record directories during allocation', async () => {
        const state = await namespace()
        const path = join(state.cockpitRoot, 'records', 'leases', `${stackA.replace(':', '_')}.json`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify({
            format: 'cockpit-state/v1', kind: 'lease', cockpitId, subjectId: stackA,
            revision: 0, updatedAt: now, value: { offset: 0, ports: { WEB: 3000 }, released: false },
        }))
        expect(await leasePortFamily({
            namespace: state, stackId: stackB, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })).toMatchObject({ kind: 'complete', lease: { stackId: stackB } })
    })

    it('snapshots mutable configuration before observation and persists one coherent declaration', async () => {
        const state = await namespace()
        const bases = { WEB: 3000, API: 4000 }
        const supplied = { step: 100, count: 1, bases }
        const result = await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config: supplied, now,
            listenerTimeoutMs: 100,
            get listenerEvidence() {
                bases.WEB = 5000
                return [{
                    ports: [3000, 4000],
                    observation: { state: 'available' as const, value: [], observedAt: now, producer: 'test-listener-probe' },
                }]
            },
        })
        expect(result).toMatchObject({ kind: 'complete', lease: { ports: { WEB: 3000, API: 4000 } } })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete',
            value: { value: { lease: { ports: { WEB: 3000, API: 4000 }, declaration: { bases: { WEB: 3000, API: 4000 } } } } },
        })

        const alternateState = await namespace()
        let baseReads = 0
        const alternating = {
            step: 100,
            count: 1,
            get bases() {
                baseReads += 1
                return baseReads === 1 ? { WEB: 3100, API: 4100 } : { WEB: 5100, API: 6100 }
            },
        }
        expect(await decidePortFamily({
            namespace: alternateState, stackId: stackA, holderId: holderA, checkoutId,
            config: alternating, now, listenerTimeoutMs: 100,
            listenerEvidence: [{ ports: [3100, 4100], observation: await noListeners([3100, 4100]) }],
        })).toMatchObject({ kind: 'complete', lease: { ports: { WEB: 3100, API: 4100 } } })
        expect(baseReads).toBe(1)
    })

    it('accepts 65 candidates and the largest host-range-valid structural boundary', async () => {
        for (const { count, base } of [
            { count: 65, base: 3_000 },
            { count: STRUCTURED_INPUT_ENTRY_LIMIT, base: 61_440 },
        ]) {
            const state = await namespace()
            const listenerEvidence = Array.from({ length: count }, (_, index) => ({
                ports: [base + index],
                observation: { state: 'available' as const, value: [] as number[], observedAt: now, producer: 'listener-probe' },
            }))
            expect(await decidePortFamily({
                namespace: state, stackId: stackA, holderId: holderA, checkoutId,
                config: { step: 1, count, bases: { WEB: base } }, now, listenerTimeoutMs: 100,
                listenerEvidence,
            })).toMatchObject({ kind: 'complete', lease: { ports: { WEB: base } } })
        }
    })

    it('refuses an oversized candidate-member cross-product before evidence or state access', async () => {
        const configs = [
            {
                step: 100,
                count: 65,
                bases: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`PORT_${index}`, 1_000 + index])),
            },
            { step: 1, count: STRUCTURED_INPUT_ENTRY_LIMIT + 1, bases: { WEB: 1_000 } },
            { step: 1, count: Number.MAX_SAFE_INTEGER, bases: { WEB: 1_000, API: 2_000 } },
        ]
        for (const invalidConfig of configs) {
            const state = await namespace()
            let evidenceReads = 0
            let statePathReads = 0
            const guardedNamespace = {
                ...state,
                paths: new Proxy(state.paths, {
                    get(target, property, receiver) {
                        statePathReads += 1
                        return Reflect.get(target, property, receiver)
                    },
                }),
            }
            const result = await decidePortFamily({
                namespace: guardedNamespace, stackId: stackA, holderId: holderA, checkoutId,
                config: invalidConfig, now, listenerTimeoutMs: 100,
                get listenerEvidence() {
                    evidenceReads += 1
                    return []
                },
            })
            expect(result).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }],
            })
            expect(evidenceReads).toBe(0)
            expect(statePathReads).toBe(0)
        }
    })

    it('refuses overlapping candidate families before reading evidence or state', async () => {
        const state = await namespace()
        let evidenceReads = 0
        const result = await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { step: 100, count: 2, bases: { WEB: 3000, API: 3100 } }, now,
            listenerTimeoutMs: 100,
            get listenerEvidence() {
                evidenceReads += 1
                return []
            },
        })
        expect(result).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }],
        })
        expect(evidenceReads).toBe(0)
        await expect(lstat(state.paths.stateLock)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('bounds base and evidence breadth plus diagnostic strings before snapshotting', async () => {
        const state = await namespace()
        const excessiveMembers = Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`PORT_${index}`, 10_000 + index]))
        const excessiveBytes = { [`PORT_${'X'.repeat(1_048_577)}`]: 10_000 }
        for (const bases of [excessiveMembers, excessiveBytes]) {
            expect(await decidePortFamily({
                namespace: state, stackId: stackA, holderId: holderA, checkoutId,
                config: { step: 100, count: 1, bases }, now,
                listenerTimeoutMs: 100, listenerEvidence: [],
            })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }],
            })
        }

        for (const observation of [
            { state: 'available', value: Array.from({ length: 33 }, (_, index) => 3000 + index), observedAt: now, producer: 'probe' },
            { state: 'available', value: [], observedAt: now, producer: 'p'.repeat(257) },
            { state: 'unavailable', reason: 'r'.repeat(1_025), producer: 'probe' },
        ]) {
            expect(await decidePortFamily({
                namespace: state, stackId: stackA, holderId: holderA, checkoutId,
                config: { step: 100, count: 1, bases: { WEB: 3000 } }, now,
                listenerTimeoutMs: 100,
                listenerEvidence: [{ ports: [3000], observation }] as never,
            })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
            })
        }
    })

    it('accepts listener provenance and reasons at their exact byte limits', async () => {
        const availableState = await namespace()
        expect(await decidePortFamily({
            namespace: availableState, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            listenerEvidence: [{
                ports: [3000, 4000],
                observation: { state: 'available', value: [], observedAt: now, producer: 'p'.repeat(256) },
            }],
        })).toMatchObject({ kind: 'complete' })

        const unavailableState = await namespace()
        expect(await decidePortFamily({
            namespace: unavailableState, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            listenerEvidence: [{
                ports: [3000, 4000],
                observation: { state: 'unavailable', reason: 'r'.repeat(1_024), producer: 'p'.repeat(256) },
            }],
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION }],
        })
    })

    it('requires exact resolved family coverage while preserving declared first-fit order', async () => {
        const state = await namespace()
        const available = (observedAt = now): PortListenerEvidenceInput['observation'] => ({
            state: 'available', value: [], observedAt, producer: 'resolved-listener-probe',
        })
        const reversed: PortListenerEvidenceInput[] = [
            { ports: [4200, 3200], observation: available() },
            { ports: [4100, 3100], observation: available() },
            { ports: [4000, 3000], observation: available() },
        ]
        expect(await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, listenerEvidence: reversed,
        })).toMatchObject({ kind: 'complete', lease: { offset: 0 } })

        for (const listenerEvidence of [
            [],
            [reversed[2], reversed[2]],
            [{ ports: [9999, 10000], observation: available() }],
            [{ ports: [3000, 4000], observation: available(), ignored: true }],
        ]) {
            const isolated = await namespace()
            expect(await decidePortFamily({
                namespace: isolated, stackId: stackA, holderId: holderA, checkoutId,
                config: { ...config, count: 1 }, now,
                listenerTimeoutMs: 100, listenerEvidence: listenerEvidence as never,
            })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
            })
        }
    })

    it('bounds resolved family evidence before traversing entries or consulting array-like lengths', async () => {
        const state = await namespace()
        let observationReads = 0
        const oversized = Array.from({ length: 65 }, () => ({
            ports: [3000, 4000],
            get observation() {
                observationReads += 1
                return { state: 'available' as const, value: [], observedAt: now, producer: 'listener-probe' }
            },
        }))
        expect(await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            listenerEvidence: oversized,
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
        })
        expect(observationReads).toBe(0)

        let lengthReads = 0
        const arrayLike = {
            get length() {
                lengthReads += 1
                return 1
            },
        }
        expect(await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            listenerEvidence: arrayLike as never,
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
        })
        expect(lengthReads).toBe(0)

        const revoked = Proxy.revocable([], {})
        revoked.revoke()
        expect(await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            listenerEvidence: revoked.proxy,
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
        })
    })

    it('owns a deep snapshot of resolved family evidence before state reads', async () => {
        const state = await namespace()
        const mutable = [{
            ports: [3000, 4000],
            observation: { state: 'available' as const, value: [] as number[], observedAt: now, producer: 'resolved-listener-probe' },
        }]
        const deciding = decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now,
            listenerTimeoutMs: 100, listenerEvidence: mutable,
        })
        mutable[0]!.ports[0] = 9999
        mutable[0]!.observation.producer = ''
        expect(await deciding).toMatchObject({ kind: 'complete', lease: { ports: { WEB: 3000, API: 4000 } } })
    })

    it('binds publication to the namespace captured before listener evidence getters run', async () => {
        const first = await namespace()
        const second = await namespace()
        const mutableNamespace = { ...first, paths: { ...first.paths } }
        const request = {
            namespace: mutableNamespace,
            stackId: stackA,
            holderId: holderA,
            checkoutId,
            config: { ...config, count: 1 },
            now,
            listenerTimeoutMs: 100,
        } as unknown as Parameters<typeof decidePortFamily>[0]
        Object.defineProperty(request, 'listenerEvidence', {
            get: () => {
                Object.assign(mutableNamespace, { root: second.root, cockpitRoot: second.cockpitRoot })
                Object.assign(mutableNamespace.paths, second.paths)
                return [{
                    ports: [3000, 4000],
                    observation: { state: 'available', value: [], observedAt: now, producer: 'listener-probe' },
                }]
            },
        })

        await expect(decidePortFamily(request)).resolves.toMatchObject({ kind: 'complete' })
        await expect(readState(first.paths.coordination(stackA))).resolves.toMatchObject({ kind: 'complete' })
        await expect(readState(second.paths.coordination(stackA))).resolves.toMatchObject({ kind: 'missing' })
    })

    it('binds the canonical namespace before configuration getters can redirect it', async () => {
        const first = await namespace()
        const second = await namespace()
        const mutableNamespace = { ...first, paths: { ...first.paths } }
        const configWithRedirect = {
            get step() {
                Object.assign(mutableNamespace, { root: second.root, cockpitRoot: second.cockpitRoot })
                Object.assign(mutableNamespace.paths, second.paths)
                return 100
            },
            count: 1,
            bases: { WEB: 3000, API: 4000 },
        }

        await expect(decidePortFamily({
            namespace: mutableNamespace, stackId: stackA, holderId: holderA, checkoutId,
            config: configWithRedirect, now, listenerTimeoutMs: 100,
            listenerEvidence: [{
                ports: [3000, 4000],
                observation: { state: 'available', value: [], observedAt: now, producer: 'listener-probe' },
            }],
        })).resolves.toMatchObject({ kind: 'complete' })
        await expect(readState(first.paths.coordination(stackA))).resolves.toMatchObject({ kind: 'complete' })
        await expect(readState(second.paths.coordination(stackA))).resolves.toMatchObject({ kind: 'missing' })
    })

    it.each(['altered root', 'unissued coordination function', 'mixed issued paths'] as const)(
        'refuses a captured namespace with %s', async (mutation) => {
            const first = await namespace()
            const second = await namespace()
            const supplied = { ...first, paths: { ...first.paths } }
            if (mutation === 'altered root') supplied.root = second.root
            else if (mutation === 'unissued coordination function') {
                supplied.paths.coordination = (stack) => first.paths.coordination(stack)
            } else supplied.paths.lifecycle = second.paths.lifecycle

            await expect(decidePortFamily({
                namespace: supplied, stackId: stackA, holderId: holderA, checkoutId,
                config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
                listenerEvidence: [{ ports: [3000, 4000], observation: {
                    state: 'available', value: [], observedAt: now, producer: 'listener-probe',
                } }],
            })).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, message: 'port lease input is invalid',
            }] })
            await expect(readState(first.paths.coordination(stackA))).resolves.toMatchObject({ kind: 'missing' })
            await expect(readState(second.paths.coordination(stackA))).resolves.toMatchObject({ kind: 'missing' })
        },
    )

    it.each([
        ['lease', () => {
            const hostile = {} as Parameters<typeof decidePortFamily>[0]
            Object.defineProperty(hostile, 'namespace', { get: () => { throw new Error('hostile namespace getter') } })
            return decidePortFamily(hostile)
        }],
        ['release', () => {
            const hostile = {} as Parameters<typeof releasePortFamily>[0]
            Object.defineProperty(hostile, 'namespace', { get: () => { throw new Error('hostile namespace getter') } })
            return releasePortFamily(hostile)
        }],
    ])('returns a named refusal when a port %s getter throws', async (_label, operation) => {
        await expect(operation()).resolves.toMatchObject({ kind: 'refusal' })
    })

    it('reads bounded listener arrays by captured indexes without invoking iterators', async () => {
        const state = await namespace()
        let iteratorCalls = 0
        const withoutIterator = <T>(values: T[]): T[] => {
            Object.defineProperty(values, Symbol.iterator, {
                value: () => {
                    iteratorCalls += 1
                    throw new Error('iterator must not be called')
                },
            })
            return values
        }
        const ports = withoutIterator([3000, 4000])
        const occupied = withoutIterator<number>([])
        const listenerEvidence = withoutIterator([{
            ports,
            observation: { state: 'available' as const, value: occupied, observedAt: now, producer: 'listener-probe' },
        }])

        expect(await decidePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100, listenerEvidence,
        })).toMatchObject({ kind: 'complete', lease: { ports: { WEB: 3000, API: 4000 } } })
        expect(iteratorCalls).toBe(0)
    })

    it.each(['entry', 'ports', 'occupied'] as const)('refuses sparse %s evidence inherited from the array prototype', async (level) => {
        const state = await namespace()
        const entry = {
            ports: [3000, 4000] as number[],
            observation: { state: 'available' as const, value: [] as number[], observedAt: now, producer: 'listener-probe' },
        }
        let listenerEvidence = [entry]
        const inherited = level === 'entry' ? entry : 3000
        if (level === 'entry') listenerEvidence = new Array(1) as typeof listenerEvidence
        if (level === 'ports') {
            entry.ports = new Array(2)
            entry.ports[1] = 4000
        }
        if (level === 'occupied') entry.observation.value = new Array(1)
        const prior = Object.getOwnPropertyDescriptor(Array.prototype, '0')
        Object.defineProperty(Array.prototype, '0', { configurable: true, writable: true, value: inherited })
        try {
            expect(await decidePortFamily({
                namespace: state, stackId: stackA, holderId: holderA, checkoutId,
                config: { ...config, count: 1 }, now, listenerTimeoutMs: 100, listenerEvidence,
            })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }] })
        } finally {
            if (prior) Object.defineProperty(Array.prototype, '0', prior)
            else delete (Array.prototype as unknown as Record<string, unknown>)['0']
        }
    })

    it('observes listeners before taking the global state lock', async () => {
        const state = await namespace()
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            observeListeners: async (ports) => {
                await expect(lstat(state.paths.stateLock)).rejects.toMatchObject({ code: 'ENOENT' })
                return noListeners(ports)
            },
        })).toMatchObject({ kind: 'complete' })
    })

    it('publishes the initial holder and lease together without legacy mirrors', async () => {
        const state = await namespace()
        const result = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        expect(result.kind).toBe('complete')
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete',
            value: { value: { holders: [{ holderId: holderA }], lease: { released: false } } },
        })
        await expect(lstat(join(state.cockpitRoot, 'records', 'claims', `${stackA.replace(':', '_')}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(state.cockpitRoot, 'records', 'leases', `${stackA.replace(':', '_')}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('publishes neither holder nor lease when initial allocation refuses', async () => {
        const state = await namespace()
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            observeListeners: async () => ({ state: 'available', value: [3000], observedAt: now, producer: 'test' }),
        })).toMatchObject({ kind: 'refusal' })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({ kind: 'missing' })
    })

    it('allocates first-fit families and rejects the complete candidate when one member is occupied', async () => {
        const state = await namespace()

        const result = await leasePortFamily({
            namespace: state,
            stackId: stackA,
            holderId: holderA, checkoutId,
            config,
            now,
            listenerTimeoutMs: 100,
            observeListeners: async (ports) => ({
                state: 'available', value: ports.includes(4000) ? [4000] : [], observedAt: now, producer: 'test',
            }),
        })

        expect(result).toMatchObject({ kind: 'complete', lease: { offset: 100, ports: { WEB: 3100, API: 4100 } } })
    })

    it('does not let unused later evidence override a valid first-fit family', async () => {
        const state = await namespace()
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100,
            observeListeners: async (ports) => ports.includes(3000)
                ? noListeners(ports)
                : { state: 'unavailable', reason: 'later family not observed', producer: 'test-listener-probe' },
        })).toMatchObject({ kind: 'complete', lease: { offset: 0 } })
    })

    it('does not recycle a family through an ordinary final release', async () => {
        const state = await namespace()
        const first = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        expect(first).toMatchObject({ kind: 'complete', lease: { offset: 0 } })
        expect(await releasePortFamily({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA, now }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })

        // The holder still retains its family, so its own published port does not collide and the
        // family is returned to it unchanged rather than handed out afresh.
        const returned = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100,
            observeListeners: async (ports) => ({
                state: 'available', value: ports.includes(3000) ? [3000] : [], observedAt: now, producer: 'test',
            }),
        })
        expect(returned).toMatchObject({ kind: 'complete', change: 'unchanged', lease: { offset: 0 } })
    })

    it('serialises concurrent lease decisions into disjoint families', async () => {
        const state = await namespace()

        const [left, right] = await Promise.all([
            leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners }),
            leasePortFamily({ namespace: state, stackId: stackB, holderId: holderB, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners }),
        ])
        expect(left.kind).toBe('complete')
        expect(right.kind).toBe('complete')
        if (left.kind !== 'complete' || right.kind !== 'complete') return
        expect(new Set([...Object.values(left.lease.ports), ...Object.values(right.lease.ports)]).size).toBe(4)
        expect(left.lease.offset).not.toBe(right.lease.offset)
    })

    it('preserves disjoint families across concurrent processes', async () => {
        const state = await namespace()
        const home = dirname(dirname(dirname(dirname(state.root))))
        await Promise.all([
            runLease({ home, stackId: stackA, holderId: holderA }),
            runLease({ home, stackId: stackB, holderId: holderB }),
        ])
        const [left, right] = await Promise.all([
            readState(state.paths.coordination(stackA)),
            readState(state.paths.coordination(stackB)),
        ])
        expect(left.kind).toBe('complete')
        expect(right.kind).toBe('complete')
        if (left.kind !== 'complete' || right.kind !== 'complete') return
        const leftPorts = Object.values((left.value.value as { lease: { ports: Record<string, number> } }).lease.ports)
        const rightPorts = Object.values((right.value.value as { lease: { ports: Record<string, number> } }).lease.ports)
        expect(leftPorts.every((port) => !rightPorts.includes(port))).toBe(true)
    })

    it('keeps listener observation outside and lease publication inside the global transaction', async () => {
        const state = await namespace()
        let entered!: () => void
        let continueProbe!: () => void
        const probeEntered = new Promise<void>((resolve) => { entered = resolve })
        const probeMayContinue = new Promise<void>((resolve) => { continueProbe = resolve })
        const leasing = leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now, listenerTimeoutMs: 100,
            observeListeners: async (ports) => {
                entered()
                await probeMayContinue
                return noListeners(ports)
            },
        })
        await probeEntered
        const release = await releaseClaim({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA, now })
        expect(release).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({ kind: 'missing' })
        continueProbe()
        const lease = await leasing
        expect(lease.kind).toBe('complete')
        expect((await readState(state.paths.coordination(stackA))).kind).toBe('complete')
    })

    it('retains the stack-wide lease until the final co-tenant releases', async () => {
        const state = await namespace()
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })).toMatchObject({ kind: 'complete' })
        expect(await acquireClaim({
            namespace: state, stackId: stackA,
            holder: { holderId: holderB, checkoutId }, now,
        })).toMatchObject({ kind: 'complete', change: 'acquired' })

        expect(await releasePortFamily({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA, now }))
            .toEqual({ kind: 'complete', change: 'retained' })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete',
            value: { value: { holders: [{ holderId: holderB }], lease: { released: false } } },
        })
        expect(await releasePortFamily({ namespace: state, stackId: stackA, requesterId: holderB, holderId: holderB, now }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete',
            value: { value: { holders: [{ holderId: holderB }], lease: { released: false } } },
        })
    })

    it('does not make capacity available through an ordinary final release', async () => {
        const state = await namespace()
        const oneStack = { ...config, count: 1 }
        await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config: oneStack, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        const blocked = await leasePortFamily({ namespace: state, stackId: stackB, holderId: holderB, checkoutId, config: oneStack, now, listenerTimeoutMs: 100, observeListeners: noListeners })
        expect(blocked).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED }] })
        if (blocked.kind === 'refusal') {
            expect(blocked.diagnostics[0]?.message).toContain('maximum 1')
            expect(blocked.diagnostics[0]?.fix).toContain('release')
        }
        await releasePortFamily({ namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA, now })
        expect(await leasePortFamily({ namespace: state, stackId: stackB, holderId: holderB, checkoutId, config: oneStack, now, listenerTimeoutMs: 100, observeListeners: noListeners }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED }] })
    })

    it('refuses release by a holder without a claim on the target stack', async () => {
        const state = await namespace()
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })).toMatchObject({ kind: 'complete' })

        expect(await releasePortFamily({
            namespace: state, stackId: stackA, requesterId: holderA, holderId: holderB, now,
        })).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT, target: holderB }],
        })
        expect((await readState(state.paths.coordination(stackA))).kind).toBe('complete')
    })

    it('rejects non-canonical timestamps before allocation and release no-ops', async () => {
        const state = await namespace()
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config,
            now: '2026-09-07T12:00:00Z', listenerTimeoutMs: 100, observeListeners: noListeners,
        })).toMatchObject({ kind: 'refusal' })
        expect(await releasePortFamily({
            namespace: state, stackId: stackA, requesterId: holderA, holderId: holderA,
            now: '2026-09-07T14:00:00.000+02:00',
        })).toMatchObject({ kind: 'refusal' })
    })

    it('refuses unsafe-integer, overflow, occupied, and unknown-listener inputs', async () => {
        const state = await namespace()
        const cases = [
            { config: { ...config, count: 1 }, observeListeners: async () => ({ state: 'available' as const, value: [3000], observedAt: now, producer: 'test' }), code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION },
            { config: { ...config, count: 1.5 }, observeListeners: noListeners, code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE },
            { config: { ...config, bases: { WEB: 65530 }, step: 10, count: 2 }, observeListeners: async () => ({ state: 'available' as const, value: [65530], observedAt: now, producer: 'test' }), code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE },
            { config, observeListeners: async () => ({ state: 'unavailable' as const, reason: 'probe missing', producer: 'test' }), code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION },
        ]
        for (const row of cases) {
            const result = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config: row.config, now, listenerTimeoutMs: 100, observeListeners: row.observeListeners })
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: row.code }] })
        }
        expect(await leasePortFamily({ namespace: state, stackId: stackB, holderId: holderB, checkoutId, config, now, listenerTimeoutMs: 100, observeListeners: noListeners })).toMatchObject({ kind: 'complete' })
    })

    it('refuses overlapping family members and malformed listener evidence', async () => {
        const state = await namespace()

        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, bases: { WEB: 3000, API: 3000 } }, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }] })

        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: ['3000'], observedAt: 'invalid', producer: '',
            }) as never,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }] })

        for (const observation of [
            { state: 'invented', value: [], observedAt: now, producer: 'listener-probe' },
            { state: 'available', value: [3000, 3000], observedAt: now, producer: 'listener-probe' },
        ]) {
            const isolated = await namespace()
            expect(await decidePortFamily({
                namespace: isolated, stackId: stackA, holderId: holderA, checkoutId,
                config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
                listenerEvidence: [{ ports: [3000, 4000], observation }] as never,
            })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }],
            })
        }

        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: async () => null as never,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }] })

        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: [], observedAt: '2026-09-07T11:59:59.999Z', producer: 'stale-probe',
            }),
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }] })

        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: [], observedAt: '2026-09-07T12:00:00.050Z', producer: 'fresh-probe',
            }),
        })).toMatchObject({ kind: 'complete' })

        const otherState = await namespace()
        expect(await leasePortFamily({
            namespace: otherState, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, count: 1 }, now, listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: [], observedAt: '2026-09-07T12:00:00.101Z', producer: 'future-probe',
            }),
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID }] })
    })

    it('refuses to rewrite an unreleased family when its declaration changes', async () => {
        const state = await namespace()
        await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        const before = await readState(state.paths.coordination(stackA))
        const changed = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId,
            config: { ...config, bases: { WEB: 3200, API: 4200 } }, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        expect(changed).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION }],
        })
        expect(await readState(state.paths.coordination(stackA))).toEqual(before)
    })

    it('reobserves and reuses the exact active family without rewriting state', async () => {
        const state = await namespace()
        await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        const before = await readFile(state.paths.coordination(stackA).path)
        const observed: number[][] = []
        const result = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config,
            now: '2026-09-07T12:01:00.000Z', listenerTimeoutMs: 100,
            // The running stack publishes its own leased ports, so they are occupied on re-entry.
            observeListeners: async (ports) => {
                observed.push([...ports])
                return { state: 'available', value: [...ports], observedAt: '2026-09-07T12:01:00.000Z', producer: 'test-listener-probe' }
            },
        })
        expect(result).toMatchObject({ kind: 'complete', lease: { offset: 0, ports: { WEB: 3000, API: 4000 } } })
        expect(observed).toEqual([[3000, 4000]])
        expect(await readFile(state.paths.coordination(stackA).path)).toEqual(before)
    })

    it('refuses a persisted lease containing duplicate ports', async () => {
        const state = await namespace()
        const seeded = await transactState(
            state,
            state.paths.coordination(stackA),
            { ownerId: holderA },
            () => ({
                format: 'cockpit-state/v1' as const,
                kind: 'coordination' as const,
                cockpitId,
                subjectId: stackA,
                revision: 0,
                updatedAt: now,
                value: {
                    holders: [{ holderId: holderA, checkoutId, claimedAt: now }],
                    lease: {
                        offset: 0,
                        ports: { WEB: 3000, API: 3000 },
                        released: false,
                        declaration: { step: 100, count: 3, bases: { WEB: 3000, API: 4000 } },
                    },
                    lastReleasedHolder: null,
                },
            }),
        )
        expect(seeded.kind).toBe('complete')
        expect(await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })
    })

    it('uses deterministic code-point order rather than locale collation', async () => {
        const source = await readFile(fileURLToPath(new URL('./claims.ts', import.meta.url)), 'utf8')
        expect(source).not.toContain('.localeCompare(')
    })
})

describe('retained port-family projection', () => {
    it('revalidates only the exact unchanged active lease projection', async () => {
        const state = await namespace()
        const lease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        if (lease.kind !== 'complete') throw new Error('lease fixture unavailable')
        const retained = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        if (retained.kind !== 'complete') throw new Error('retained lease fixture unavailable')
        const projection = await projectRetainedPortFamilyResult({
            retainedResult: retained,
            entrypointResult: deriveEntrypoints({ lease: retained.lease, declarations: [] }),
        })
        if (!projection) throw new Error('retained projection fixture unavailable')

        await expect(revalidatePortLeaseProjection({ projection: { ...projection } as never, namespace: state })).resolves.toBe(false)
        await expect(revalidatePortLeaseProjection({ projection, namespace: await namespace() })).resolves.toBe(false)
        await expect(revalidatePortLeaseProjection({ projection, namespace: state })).resolves.toBe(true)
        const reserved = await reserveDrain({ namespace: state, request: {
            purpose: 'sleep', stackId: stackA, holderId: holderA, requesterId: holderA,
            configSha256: '1'.repeat(64), planDigest: '2'.repeat(64), operationBasis: '3'.repeat(64),
            generation: '4'.repeat(64), targetIds: [stackA],
            actions: [{ stage: 'runtime-stop', targetId: stackA, validForMs: 30_000 }],
            expectedCoordinationRevision: lease.recordRevision,
        } })
        expect(reserved.kind).toBe('complete')
        await expect(revalidatePortLeaseProjection({ projection, namespace: state })).resolves.toBe(false)
    })

    it('projects a named HTTPS route from the exact retained offset without rewriting its record', async () => {
        const state = await namespace()
        await leasePortFamily({ namespace: state, stackId: stackB, holderId: holderB, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        const before = await readFile(state.paths.coordination(stackA).path)
        const retained = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        if (retained.kind !== 'complete') throw new Error('retained lease fixture unavailable')
        const entrypoints = deriveEntrypoints({
            lease: retained.lease,
            declarations: [{ name: 'dashboard', kind: 'entrypoint', port: 'WEB', path: '/dashboard',
                hostname: 'app.sample.localhost', scheme: 'https' }],
        })
        const projection = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })

        expect(projection).toMatchObject({
            lease: { stackId: stackA, offset: 100, ports: { WEB: 3100, API: 4100 } },
            ownership: { change: 'unchanged', holderId: holderA, recordRevision: 0, holderIds: [holderA] },
            entrypoints: expect.arrayContaining([
                { name: 'dashboard', kind: 'entrypoint', port: 'WEB', value: 'https://app.sample.localhost:3100/dashboard' },
            ]),
        })
        expect(consumePortLeaseProjection(projection!)).toBe(projection)
        expect(inspectPortLeaseProjection(projection!, state)).toBe(projection)
        expect(inspectPortLeaseProjection(projection!, await namespace())).toBeUndefined()
        expect(inspectPortLeaseProjection(projection!)).toBeUndefined()
        expect(consumePortLeaseProjection(projection!)).toBeUndefined()
        expect(await readFile(state.paths.coordination(stackA).path)).toEqual(before)
    })

    it('burns a retained observation when coordination changes before projection', async () => {
        const state = await namespace()
        const lease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        if (lease.kind !== 'complete') throw new Error('lease fixture unavailable')
        const retained = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        if (retained.kind !== 'complete') throw new Error('retained lease fixture unavailable')
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: [] })
        await reserveDrain({ namespace: state, request: {
            purpose: 'sleep', stackId: stackA, holderId: holderA, requesterId: holderA,
            configSha256: '1'.repeat(64), planDigest: '2'.repeat(64), operationBasis: '3'.repeat(64),
            generation: '4'.repeat(64), targetIds: [stackA],
            actions: [{ stage: 'runtime-stop', targetId: stackA, validForMs: 30_000 }],
            expectedCoordinationRevision: lease.recordRevision,
        } })

        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })).toBeUndefined()
        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })).toBeUndefined()
        const refreshed = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        expect(await projectRetainedPortFamilyResult({ retainedResult: refreshed, entrypointResult: entrypoints }))
            .toMatchObject({ ownership: { recordRevision: 1 } })
    })

    it('burns a retained observation after a same-revision record replacement', async () => {
        const state = await namespace()
        await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        const retained = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        if (retained.kind !== 'complete') throw new Error('retained lease fixture unavailable')
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: [] })
        const path = state.paths.coordination(stackA).path
        const replacement = JSON.parse(await readFile(path, 'utf8')) as { updatedAt: string }
        replacement.updatedAt = '2026-09-07T12:01:00.000Z'
        await writeFile(path, `${JSON.stringify(replacement)}\n`, 'utf8')

        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })).toBeUndefined()
        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })).toBeUndefined()
    })

    it('projects during an active drain attempt', async () => {
        const state = await namespace()
        const lease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        if (lease.kind !== 'complete') throw new Error('lease fixture unavailable')
        const reserved = await reserveDrain({ namespace: state, request: {
            purpose: 'sleep', stackId: stackA, holderId: holderA, requesterId: holderA,
            configSha256: '1'.repeat(64), planDigest: '2'.repeat(64), operationBasis: '3'.repeat(64),
            generation: '4'.repeat(64), targetIds: [stackA],
            actions: [{ stage: 'runtime-stop', targetId: stackA, validForMs: 30_000 }],
            expectedCoordinationRevision: lease.recordRevision,
        } })
        if (reserved.kind !== 'complete') throw new Error('drain fixture unavailable')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('drain attempt fixture unavailable')
        const before = await readFile(state.paths.coordination(stackA).path)
        const retained = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        if (retained.kind !== 'complete') throw new Error('retained lease fixture unavailable')
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: [] })

        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints }))
            .toMatchObject({ ownership: { recordRevision: attempted.attempt.committedRevision } })
        expect(await readFile(state.paths.coordination(stackA).path)).toEqual(before)
    })

    it('rejects copied authority, mismatched entrypoints, and replay', async () => {
        const state = await namespace()
        await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        const retained = await observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config })
        if (retained.kind !== 'complete') throw new Error('retained lease fixture unavailable')
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: [] })
        const otherEntrypoints = deriveEntrypoints({ lease: { ...retained.lease, stackId: stackB }, declarations: [] })

        expect(await projectRetainedPortFamilyResult({ retainedResult: { ...retained }, entrypointResult: entrypoints } as never)).toBeUndefined()
        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: { ...entrypoints } } as never)).toBeUndefined()
        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: otherEntrypoints })).toBeUndefined()
        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })).toBeDefined()
        expect(await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })).toBeUndefined()
    })

    it('maps malformed identity, absent records, holder mismatch, release, declaration drift, and malformed state', async () => {
        const state = await namespace()
        const otherState = await namespace()
        await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners })
        const input = { namespace: state, stackId: stackA, holderId: holderA, checkoutId, config }

        await expect(observeRetainedPortFamily({ ...input, namespace: { ...state } as StateNamespace }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }] })
        await expect(observeRetainedPortFamily({ ...input, namespace: otherState }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        await expect(observeRetainedPortFamily({ ...input, stackId: stackB }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        await expect(observeRetainedPortFamily({ ...input, holderId: holderB }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        await expect(observeRetainedPortFamily({ ...input, checkoutId: `checkout:${'9'.repeat(64)}` as CheckoutId }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        await expect(observeRetainedPortFamily({ ...input, config: { ...config, step: 200 } }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION }] })

        const path = state.paths.coordination(stackA).path
        const released = JSON.parse(await readFile(path, 'utf8')) as {
            value: { holders: unknown[]; lease: { released: boolean }; lastReleasedHolder: HolderId | null }
        }
        released.value.holders = []
        released.value.lease.released = true
        released.value.lastReleasedHolder = holderA
        await writeFile(path, `${JSON.stringify(released)}\n`, 'utf8')
        await expect(observeRetainedPortFamily(input))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        await writeFile(path, '{}\n', 'utf8')
        await expect(observeRetainedPortFamily(input))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
    })

    it('re-reads a retained lease after its publication durability was indeterminate', async () => {
        const state = await namespace()
        const path = state.paths.coordination(stackA).path
        await mkdir(dirname(path), { recursive: true })
        const restore = await interceptDirectorySync(dirname(path), () => {
            throw new Error('injected coordination directory sync failure')
        })
        let lease
        try {
            lease = await leasePortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
                listenerTimeoutMs: 100, observeListeners: noListeners })
        } finally {
            restore()
        }
        expect(lease).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE }],
        })
        const before = await readFile(path)

        await expect(observeRetainedPortFamily({ namespace: state, stackId: stackA, holderId: holderA, checkoutId, config }))
            .resolves.toMatchObject({ kind: 'complete', recordRevision: 0, lease: { ports: { WEB: 3000, API: 4000 } } })
        expect(await readFile(path)).toEqual(before)
    })
})

describe('acquired port-holder compensation', () => {
    it('removes a sole acquired holder, retains its lease, and reattaches on retry', async () => {
        const state = await namespace()
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')

        const compensated = await compensateAcquiredPortHolder({
            namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:01.000Z',
        })
        expect(compensated).toEqual({
            kind: 'complete', change: 'compensated', recordRevision: 1, remainingHolderIds: [],
        })
        expect(Object.isFrozen(compensated)).toBe(true)
        if (compensated.kind !== 'complete') throw new Error('expected compensated holder')
        expect(Object.isFrozen(compensated.remainingHolderIds)).toBe(true)
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete', value: { value: {
                holders: [], lease: { offset: 0, released: false }, lastReleasedHolder: holderA,
            } },
        })

        const retry = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config,
            now: '2026-09-07T12:00:02.000Z', listenerTimeoutMs: 100,
            observeListeners: async (ports) => ({
                state: 'available', value: [], observedAt: '2026-09-07T12:00:02.000Z', producer: 'test-listener-probe',
            }),
        })
        expect(retry).toMatchObject({ kind: 'complete', change: 'acquired', lease: { offset: 0 } })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete', value: { value: { holders: [{ holderId: holderA }], lastReleasedHolder: null } },
        })
    })

    it('removes only the holder acquired by the exact multi-holder lease result', async () => {
        const state = await namespace()
        await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderB, checkoutId, config,
            now: '2026-09-07T12:00:01.000Z', listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: [], observedAt: '2026-09-07T12:00:01.000Z', producer: 'test-listener-probe',
            }),
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')

        expect(await compensateAcquiredPortHolder({
            namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:02.000Z',
        })).toEqual({
            kind: 'complete', change: 'compensated', recordRevision: 2, remainingHolderIds: [holderA],
        })
        expect(await readState(state.paths.coordination(stackA))).toMatchObject({
            kind: 'complete', value: { value: {
                holders: [{ holderId: holderA }], lease: { released: false }, lastReleasedHolder: holderB,
            } },
        })
    })

    it('refuses unchanged, copied, replayed, and cross-namespace lease results', async () => {
        const state = await namespace()
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')
        const unchanged = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config,
            now: '2026-09-07T12:00:01.000Z', listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: [], observedAt: '2026-09-07T12:00:01.000Z', producer: 'test-listener-probe',
            }),
        })
        if (unchanged.kind !== 'complete') throw new Error('expected unchanged lease')
        const otherState = await namespace()

        for (const input of [
            { namespace: state, leaseResult: unchanged },
            { namespace: state, leaseResult: { ...acquired } as typeof acquired },
            { namespace: otherState, leaseResult: acquired },
        ]) {
            expect(await compensateAcquiredPortHolder({
                ...input, now: '2026-09-07T12:00:02.000Z',
            })).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
            })
        }

        expect(await compensateAcquiredPortHolder({
            namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:02.000Z',
        })).toMatchObject({ kind: 'complete' })
        expect(await compensateAcquiredPortHolder({
            namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:03.000Z',
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
        })
    })

    it('requires the exact issued state namespace without consuming lease authority', async () => {
        const state = await namespace()
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')
        const before = await readFile(state.paths.coordination(stackA).path)

        expect(await compensateAcquiredPortHolder({
            namespace: { ...state }, leaseResult: acquired, now: '2026-09-07T12:00:01.000Z',
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
        })
        expect(await readFile(state.paths.coordination(stackA).path)).toEqual(before)

        expect(await compensateAcquiredPortHolder({
            namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:02.000Z',
        })).toMatchObject({ kind: 'complete', change: 'compensated' })
    })

    it('leaves state unchanged when the exact acquisition is stale or its record bytes changed', async () => {
        const staleState = await namespace()
        const stale = await leasePortFamily({
            namespace: staleState, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (stale.kind !== 'complete') throw new Error('expected acquired lease')
        await leasePortFamily({
            namespace: staleState, stackId: stackA, holderId: holderB, checkoutId, config,
            now: '2026-09-07T12:00:01.000Z', listenerTimeoutMs: 100,
            observeListeners: async () => ({
                state: 'available', value: [], observedAt: '2026-09-07T12:00:01.000Z', producer: 'test-listener-probe',
            }),
        })
        const staleBytes = await readFile(staleState.paths.coordination(stackA).path)
        expect(await compensateAcquiredPortHolder({
            namespace: staleState, leaseResult: stale, now: '2026-09-07T12:00:02.000Z',
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readFile(staleState.paths.coordination(stackA).path)).toEqual(staleBytes)

        const changedState = await namespace()
        const changed = await leasePortFamily({
            namespace: changedState, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (changed.kind !== 'complete') throw new Error('expected acquired lease')
        const stored = await readState(changedState.paths.coordination(stackA))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        await writeFile(changedState.paths.coordination(stackA).path, `${JSON.stringify({
            ...stored.value, updatedAt: '2026-09-07T12:00:00.001Z',
        })}\n`)
        const changedBytes = await readFile(changedState.paths.coordination(stackA).path)
        expect(await compensateAcquiredPortHolder({
            namespace: changedState, leaseResult: changed, now: '2026-09-07T12:00:02.000Z',
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readFile(changedState.paths.coordination(stackA).path)).toEqual(changedBytes)
    })

    it('refuses hostile getters without touching state', async () => {
        const state = await namespace()
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')
        const before = await readFile(state.paths.coordination(stackA).path)
        const hostile = { namespace: state, now: '2026-09-07T12:00:01.000Z' } as Record<string, unknown>
        Object.defineProperty(hostile, 'leaseResult', { enumerable: true, get: () => { throw new Error('hostile lease getter') } })

        expect(await compensateAcquiredPortHolder(hostile as never)).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
        })
        expect(await readFile(state.paths.coordination(stackA).path)).toEqual(before)
    })

    it('refuses an unissued lease result without reading its fields', async () => {
        const state = await namespace()
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')
        const before = await readFile(state.paths.coordination(stackA).path)
        const hostileLeaseResult = {} as Record<string, unknown>
        Object.defineProperty(hostileLeaseResult, 'kind', {
            enumerable: true,
            get: () => { throw new Error('hostile lease-result kind getter') },
        })

        expect(await compensateAcquiredPortHolder({
            namespace: state,
            leaseResult: hostileLeaseResult as never,
            now: '2026-09-07T12:00:01.000Z',
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
        })
        expect(await readFile(state.paths.coordination(stackA).path)).toEqual(before)
    })

    it('burns compensation authority when publication durability is indeterminate', async () => {
        const state = await namespace()
        const acquired = await leasePortFamily({
            namespace: state, stackId: stackA, holderId: holderA, checkoutId, config, now,
            listenerTimeoutMs: 100, observeListeners: noListeners,
        })
        if (acquired.kind !== 'complete') throw new Error('expected acquired lease')
        const restore = await interceptDirectorySync(dirname(state.paths.coordination(stackA).path), () => {
            throw new Error('injected coordination directory sync failure')
        })
        let result
        try {
            result = await compensateAcquiredPortHolder({
                namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:01.000Z',
            })
        } finally {
            restore()
        }
        expect(result).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE }],
        })
        expect(await compensateAcquiredPortHolder({
            namespace: state, leaseResult: acquired, now: '2026-09-07T12:00:02.000Z',
        })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }],
        })
    })
})

describe('lease derivatives', () => {
    const lease = { stackId: stackA, offset: 100, ports: { WEB: 3100, API: 4100 } }
    const declarations: EntrypointDerivative[] = [
        { name: 'web-origin', kind: 'origin', port: 'WEB', path: '/' },
        { name: 'oauth-callback', kind: 'callback_url', port: 'API', path: '/oauth/callback' },
        { name: 'cors', kind: 'cors_origin', port: 'WEB', path: '/' },
        { name: 'proxy', kind: 'advertised_listener', port: 'API', path: '/edge' },
        { name: 'public-base', kind: 'public_base_url', port: 'WEB', path: '/v1' },
    ]

    it('derives base entrypoints and every declared edge in stable declared order', () => {
        const result = deriveEntrypoints({ lease, declarations })
        expect(result).toMatchObject({ kind: 'complete', diagnostics: [] })
        if (result.kind !== 'complete') return
        expect(result.values.map((row) => [row.name, row.value])).toEqual([
            ['web', 'http://127.0.0.1:3100/'],
            ['api', 'http://127.0.0.1:4100/'],
            ['web-origin', 'http://127.0.0.1:3100/'],
            ['oauth-callback', 'http://127.0.0.1:4100/oauth/callback'],
            ['cors', 'http://127.0.0.1:3100/'],
            ['proxy', 'http://127.0.0.1:4100/edge'],
            ['public-base', 'http://127.0.0.1:3100/v1'],
        ])
        expect(deriveEntrypoints({ lease, declarations: [] })).toMatchObject({ kind: 'complete', values: [{ name: 'web' }, { name: 'api' }] })
    })

    it('derives every kind in the shared entrypoint vocabulary', () => {
        const allKinds = ENTRYPOINT_KINDS.map((kind, index) => ({
            name: `kind-${index}`,
            kind,
            port: 'WEB',
            path: '/',
        }))

        expect(deriveEntrypoints({ lease, declarations: allKinds })).toMatchObject({
            kind: 'complete',
            values: expect.arrayContaining(allKinds.map(({ name, kind, port }) => (
                expect.objectContaining({ name, kind, port })
            ))),
        })
    })

    it('derives named URLs and corrects stale local addresses from the selected port family', () => {
        const result = deriveEntrypoints({
            lease,
            declarations: [
                { name: 'secure-origin', kind: 'origin', port: 'WEB', path: '/', hostname: 'app.sample.localhost', scheme: 'https' },
                { name: 'local-callback', kind: 'callback_url', port: 'API', path: '/callback', hostname: 'api.sample.localhost' },
                { name: 'secure-address', kind: 'public_base_url', port: 'API', path: '/', scheme: 'https' },
            ],
            declaredValues: {
                'secure-origin': 'https://app.sample.localhost:3000/',
                'local-callback': 'http://api.sample.localhost.example.test:4000/callback',
            },
        })
        expect(result).toEqual({
            kind: 'complete',
            values: [
                { name: 'web', kind: 'entrypoint', port: 'WEB', value: 'http://127.0.0.1:3100/' },
                { name: 'api', kind: 'entrypoint', port: 'API', value: 'http://127.0.0.1:4100/' },
                { name: 'secure-origin', kind: 'origin', port: 'WEB', value: 'https://app.sample.localhost:3100/' },
                { name: 'local-callback', kind: 'callback_url', port: 'API', value: 'http://api.sample.localhost:4100/callback' },
                { name: 'secure-address', kind: 'public_base_url', port: 'API', value: 'https://127.0.0.1:4100/' },
            ],
            diagnostics: [
                expect.objectContaining({ severity: 'warning', code: ENVIRONMENT_CODES.PORT_LOCAL_VALUE_CORRECTED,
                    target: 'secure-origin', fix: 'use https://app.sample.localhost:3100/' }),
                expect.objectContaining({ severity: 'info', code: ENVIRONMENT_CODES.PORT_EXTERNAL_REGISTRATION_GAP,
                    target: 'local-callback', fix: 'update the external registration to http://api.sample.localhost:4100/callback' }),
            ],
        })
    })

    it('refuses direct address declarations outside the local HTTP contract', () => {
        for (const address of [{ hostname: 'app.localhost.example.test' }, { hostname: 'app.localhost\n' }, { scheme: 'file' }]) {
            expect(deriveEntrypoints({ lease,
                declarations: [{ name: 'application', kind: 'origin', port: 'WEB', path: '/', ...address }],
            } as never)).toMatchObject({
                kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }],
            })
        }
    })

    it('refuses kinds outside the shared entrypoint vocabulary', () => {
        expect(deriveEntrypoints({
            lease,
            declarations: [{ name: 'unsupported', kind: 'other', port: 'WEB', path: '/' }],
        } as never)).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, target: 'unsupported' }],
        })
    })

    it('corrects stale loopback values with warnings and reports external registrations as info gaps', () => {
        const result = deriveEntrypoints({
            lease,
            declarations,
            declaredValues: {
                'web-origin': 'http://localhost:3000/',
                'oauth-callback': 'https://identity.example.test/callback',
            },
        })
        expect(result).toMatchObject({
            kind: 'complete',
            diagnostics: [
                { severity: 'warning', code: ENVIRONMENT_CODES.PORT_LOCAL_VALUE_CORRECTED, target: 'web-origin' },
                { severity: 'info', code: ENVIRONMENT_CODES.PORT_EXTERNAL_REGISTRATION_GAP, target: 'oauth-callback' },
            ],
        })
        if (result.kind === 'complete') {
            expect(result.values.find((row) => row.name === 'web-origin')?.value).toBe('http://127.0.0.1:3100/')
            expect(result.values.find((row) => row.name === 'oauth-callback')?.value).toBe('http://127.0.0.1:4100/oauth/callback')
        }
    })

    it('refuses missing lease members instead of falling back to configured bases', () => {
        const result = deriveEntrypoints({
            lease: { stackId: stackA, offset: 0, ports: { WEB: 3000 } },
            declarations: [{ name: 'api', kind: 'entrypoint', port: 'API', path: '/' }],
        })
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, target: 'API' }] })
    })

    it('refuses derivative names that collide with another rendered entrypoint', () => {
        expect(deriveEntrypoints({
            lease,
            declarations: [{ name: 'web', kind: 'origin', port: 'WEB', path: '/' }],
        })).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, target: 'web' }],
        })
    })

    it('rejects duplicate direct lease ports and paths outside the shared URL-path contract', () => {
        expect(deriveEntrypoints({
            lease: { stackId: stackA, offset: 0, ports: { WEB: 3000, API: 3000 } },
            declarations: [],
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }] })
        expect(deriveEntrypoints({
            lease,
            declarations: [{ name: 'escaped', kind: 'callback_url', port: 'WEB', path: '/safe%2fescape' }],
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE }] })
    })
})
