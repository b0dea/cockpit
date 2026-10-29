import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_CODES, type CheckoutId, type CockpitId, type HolderId, type StackId } from './contract.js'
import {
    abortStateTransaction,
    authenticateStatePublication,
    lifecycleHistoryAddress,
    readState,
    resetBootstrapAnswer,
    inspectStateLock,
    issueStateScopedLock,
    SERIALIZED_RECORD_BYTE_LIMIT,
    selectBootstrapStateRoot,
    selectStateRoot,
    snapshotBootstrapStateNamespace,
    transactState,
    withStateScopedLock,
    withStateRootPortLock,
    type BootstrapStateAddress,
    type BootstrapStateNamespace,
    type BootstrapStateRecord,
    type StateAddress,
    type StateNamespace,
    type StateRecord,
} from './state.js'
import { bootstrapHolderId, checkoutId as deriveCheckoutId } from './identity.js'

const executeFile = promisify(execFile)

// Acquisition re-checks for a release quarantine right after creating its lock directory; no
// public seam opens between those two steps, so the race is staged inside mkdir itself.
const lockAcquisitionControl = vi.hoisted(() => ({
    afterLockCreated: undefined as undefined | ((lockPath: string) => Promise<void>),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    const mkdir = (async (...args: Parameters<typeof actual.mkdir>) => {
        const created = await actual.mkdir(...args)
        const hook = lockAcquisitionControl.afterLockCreated
        if (hook && String(args[0]).endsWith('/state.lock')) {
            lockAcquisitionControl.afterLockCreated = undefined
            await hook(String(args[0]))
        }
        return created
    }) as typeof actual.mkdir
    return { ...actual, mkdir, default: { ...actual, mkdir } }
})

const temporaryPaths: string[] = []

afterEach(async () => {
    lockAcquisitionControl.afterLockCreated = undefined
    await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'cockpit-state-'))
    temporaryPaths.push(path)
    return path
}

const cockpitId = `cockpit:sample:${'a'.repeat(64)}` as CockpitId
const stackId = `stack:${'b'.repeat(64)}` as StackId
const checkoutId = `checkout:${'c'.repeat(64)}` as CheckoutId
const holderA = `holder:${'d'.repeat(64)}:session` as HolderId
const holderB = `holder:${'e'.repeat(64)}:session` as HolderId

function bootstrapRecord(address: BootstrapStateAddress, revision = 0): BootstrapStateRecord {
    const artifactBytes = 'name = "synthetic"\n'
    return {
        format: 'cockpit-state/v1', kind: 'bootstrap', checkoutId: address.checkoutId, target: address.target,
        revision, updatedAt: '2026-09-07T12:00:00.000Z', value: {
            stage: 'draft-prepared', checkoutRoot: address.checkoutRoot, target: address.target,
            sources: [{ path: 'skills/collection.json', sha256: '1'.repeat(64) }],
            commandSha256: '2'.repeat(64), previewSha256: '3'.repeat(64),
            published: [{ path: '.codex/skills/cockpit-setup/SKILL.md', sha256: '4'.repeat(64) }],
            destination: 'cockpit.toml', artifactBytes,
            artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'),
        },
    }
}

async function selectedBootstrapNamespace(target: 'claudecode' | 'codexcli' | 'opencode' = 'codexcli'):
Promise<{ namespace: BootstrapStateNamespace; address: BootstrapStateAddress }> {
    const parent = await temporaryDirectory()
    const home = join(parent, 'home'); const checkoutPath = join(parent, 'checkout')
    await Promise.all([mkdir(home), mkdir(checkoutPath)])
    const checkoutRoot = await realpath(checkoutPath)
    const selected = await selectBootstrapStateRoot({ platform: 'linux', home, checkoutRoot, target })
    if (selected.kind !== 'complete') throw new Error('expected a selected bootstrap state root')
    return { namespace: selected.value, address: selected.value.paths.bootstrap(target) }
}

function lifecycleRecord(revision: number, count: number): StateRecord {
    return {
        format: 'cockpit-state/v1',
        kind: 'lifecycle',
        cockpitId,
        subjectId: stackId,
        revision,
        updatedAt: '2026-09-07T12:00:00.000Z',
        value: { count },
    }
}

async function selectedNamespace(): Promise<{ namespace: StateNamespace; address: StateAddress }> {
    const parent = await temporaryDirectory()
    const home = join(parent, 'home')
    await mkdir(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
    if (selected.kind !== 'complete') throw new Error('expected a selected state root')
    return { namespace: selected.value, address: selected.value.paths.lifecycle(stackId) }
}

function expectWindowsSafeStatePath(root: string, path: string): void {
    for (const segment of relative(root, path).split(sep)) {
        expect(segment).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/)
        expect(segment).not.toMatch(/[. ]$/)
        expect(segment).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i)
    }
}

async function interceptDirectorySync(
    directoryPath: string,
    intercept: (call: number) => Promise<void> | void,
    targetIdentity?: () => { readonly dev: number; readonly ino: number } | undefined,
): Promise<{ readonly calls: () => number; readonly restore: () => void }> {
    const handle = await open(directoryPath, 'r')
    const expected = await handle.stat()
    const prototype = Object.getPrototypeOf(handle) as { sync: typeof handle.sync }
    const realSync = prototype.sync
    await handle.close()
    let calls = 0
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof handle) {
        const actual = await this.stat()
        const target = targetIdentity ? targetIdentity() : expected
        if (target && actual.isDirectory() && actual.dev === target.dev && actual.ino === target.ino) {
            calls += 1
            await intercept(calls)
        }
        await realSync.call(this)
    })
    return { calls: () => calls, restore: () => spy.mockRestore() }
}

describe('selectStateRoot', () => {
    it('keeps accepted cache identifiers out of Windows device-name aliases', async () => {
        const { namespace } = await selectedNamespace()
        for (const cacheId of ['con', 'nul.foo', 'com1', 'lpt9', 'cache.']) {
            const path = namespace.paths.installLock(cacheId)
            expectWindowsSafeStatePath(namespace.root, path)
            expect(path).toBe(join(namespace.cockpitRoot, 'locks', 'install', `cache-${cacheId}.lock`))
        }
    })

    it('round-trips logical identities through Windows-safe state filenames', async () => {
        const { namespace } = await selectedNamespace()
        const history = lifecycleHistoryAddress(namespace, stackId)
        if (!history) throw new Error('expected lifecycle history address')
        const addresses = [
            namespace.paths.coordination(stackId), namespace.paths.lifecycle(stackId),
            namespace.paths.dataOutcome(stackId), history, namespace.paths.baseline(stackId),
            namespace.paths.cache(checkoutId, 'f'.repeat(64)),
        ]
        expectWindowsSafeStatePath(namespace.root, namespace.paths.stateLock)
        expectWindowsSafeStatePath(namespace.root, namespace.paths.installLock('f'.repeat(64)))
        for (const address of addresses) {
            expectWindowsSafeStatePath(namespace.root, address.path)
            const record: StateRecord = { ...lifecycleRecord(0, 1), kind: address.kind, subjectId: address.subjectId }
            let temporaryObserved = false
            const written = await transactState(namespace, address, { ownerId: holderA, beforePublish: async temporaryPath => {
                temporaryObserved = true
                expectWindowsSafeStatePath(namespace.root, temporaryPath)
                expect(JSON.parse(await readFile(temporaryPath, 'utf8'))).toEqual(record)
            } }, () => record)
            expect(temporaryObserved).toBe(true)
            expect(written).toEqual({ kind: 'complete', value: record })
            expect(await readState(address)).toEqual({ kind: 'complete', value: record })
            expect(JSON.parse(await readFile(address.path, 'utf8'))).toEqual(record)
            const raw = { ...address,
                cockpitRoot: join(namespace.root, 'cockpits', cockpitId),
                path: join(namespace.root, relative(namespace.root, address.path).replaceAll('_', ':')),
            }
            await expect(readState(raw)).resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
            await expect(transactState(namespace, raw, { ownerId: holderA }, () => record))
                .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        }
        expect(new Set(addresses.map(address => address.path)).size).toBe(addresses.length)
        const otherStack = `stack:${'1'.repeat(64)}` as StackId
        expect(namespace.paths.lifecycle(otherStack).path).not.toBe(namespace.paths.lifecycle(stackId).path)
        expect(() => namespace.paths.lifecycle(stackId.replace(':', '_') as StackId)).toThrow('canonical environment identity')
    })

    it.each([0o770, 0o777])('refuses state roots writable by another user (%s)', async (mode) => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        const xdg = join(parent, 'state')
        await mkdir(home)
        await mkdir(xdg)
        await chmod(home, mode)
        await chmod(xdg, mode)
        for (const input of [{ platform: 'linux' as const, home, cockpitId }, { platform: 'linux' as const, home: undefined, xdgStateHome: xdg, cockpitId }]) {
            expect(await selectStateRoot(input)).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })
        }
    })

    it('refuses an unsafe existing descendant of an otherwise private state base', async () => {
        const parent = await temporaryDirectory()
        const xdg = join(parent, 'state')
        await mkdir(join(xdg, 'cockpit', 'v1'), { recursive: true })
        await chmod(join(xdg, 'cockpit'), 0o770)
        expect(await selectStateRoot({ platform: 'linux', home: undefined, xdgStateHome: xdg, cockpitId })).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        })
    })

    it('snapshots every selection input before filesystem checks yield', async () => {
        const parent = await temporaryDirectory()
        const firstHome = join(parent, 'first-home')
        const secondHome = join(parent, 'second-home')
        await mkdir(firstHome)
        await mkdir(secondHome)
        const mutable = { platform: 'linux' as const, home: firstHome, cockpitId }

        const selection = selectStateRoot(mutable)
        mutable.home = secondHome

        await expect(selection).resolves.toMatchObject({
            kind: 'complete',
            value: { root: join(firstHome, '.local', 'state', 'cockpit', 'v1') },
        })
    })

    it('returns a named refusal when a selection input getter throws', async () => {
        const hostile = { platform: 'linux', cockpitId } as unknown as {
            platform: 'linux'
            home: string
            cockpitId: CockpitId
        }
        Object.defineProperty(hostile, 'home', { get: () => { throw new Error('hostile home getter') } })

        await expect(selectStateRoot(hostile)).resolves.toEqual({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            message: 'state root input could not be read safely',
            target: 'state root input',
        })
    })

    it('selects the exact Darwin and Linux versioned roots', async () => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        const xdg = join(parent, 'state')
        const absentXdg = join(parent, 'new-state')
        await mkdir(home)
        await mkdir(xdg)

        const darwin = await selectStateRoot({ platform: 'darwin', home, cockpitId })
        const linuxXdg = await selectStateRoot({ platform: 'linux', home, xdgStateHome: xdg, cockpitId })
        const linuxXdgWithoutHome = await selectStateRoot({ platform: 'linux', home: undefined, xdgStateHome: xdg, cockpitId })
        const linuxAbsentXdg = await selectStateRoot({ platform: 'linux', home: undefined, xdgStateHome: absentXdg, cockpitId })
        const linuxHome = await selectStateRoot({ platform: 'linux', home, cockpitId })

        expect(darwin).toMatchObject({
            kind: 'complete',
            value: { root: join(home, 'Library', 'Application Support', 'cockpit', 'state', 'v1') },
        })
        expect(linuxXdg).toMatchObject({ kind: 'complete', value: { root: join(xdg, 'cockpit', 'v1') } })
        expect(linuxXdgWithoutHome).toMatchObject({ kind: 'complete', value: { root: join(xdg, 'cockpit', 'v1') } })
        expect(linuxAbsentXdg).toMatchObject({ kind: 'complete', value: { root: join(absentXdg, 'cockpit', 'v1') } })
        expect(linuxHome).toMatchObject({
            kind: 'complete',
            value: { root: join(home, '.local', 'state', 'cockpit', 'v1') },
        })
    })

    it('refuses an unsafe present XDG path and never falls back to a temporary root', async () => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        await mkdir(home)

        const relativeXdg = await selectStateRoot({
            platform: 'linux',
            home,
            xdgStateHome: 'relative-state',
            cockpitId,
        })
        const missingHome = await selectStateRoot({ platform: 'linux', home: '', cockpitId })

        expect(relativeXdg).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })
        expect(missingHome).toEqual({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            message: 'state root requires an absolute usable home directory',
            target: '',
        })
        expect(JSON.stringify(missingHome)).not.toContain(tmpdir())
    })

    it('refuses symlinked, wrong-type, unwritable, and checkout-contained selected roots', async () => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        const target = join(parent, 'target')
        const linkedXdg = join(parent, 'linked-state')
        const fileXdg = join(parent, 'file-state')
        const unwritableXdg = join(parent, 'unwritable-state')
        const xdgWithUnwritableRoot = join(parent, 'state-with-readonly-root')
        await mkdir(home)
        await mkdir(target)
        await symlink(target, linkedXdg)
        await writeFile(fileXdg, 'not a directory')
        await mkdir(unwritableXdg, { mode: 0o500 })
        await mkdir(join(xdgWithUnwritableRoot, 'cockpit', 'v1'), { recursive: true })
        await chmod(join(xdgWithUnwritableRoot, 'cockpit', 'v1'), 0o500)

        const linked = await selectStateRoot({ platform: 'linux', home, xdgStateHome: linkedXdg, cockpitId })
        const file = await selectStateRoot({ platform: 'linux', home, xdgStateHome: fileXdg, cockpitId })
        const unwritable = await selectStateRoot({
            platform: 'linux', home, xdgStateHome: unwritableXdg, cockpitId,
        })
        const contained = await selectStateRoot({ platform: 'linux', home, cockpitId, checkoutRoot: parent })
        const containedInOneOfMany = await selectStateRoot({
            platform: 'linux', home, cockpitId, checkoutRoots: [target, parent],
        })
        const unwritableRoot = await selectStateRoot({
            platform: 'linux', home, xdgStateHome: xdgWithUnwritableRoot, cockpitId,
        })

        expect(linked).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })
        expect(file).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })
        expect(unwritable).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })
        expect(contained).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })
        expect(containedInOneOfMany).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        })
        expect(unwritableRoot).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE })

        await chmod(unwritableXdg, 0o700)
        await chmod(join(xdgWithUnwritableRoot, 'cockpit', 'v1'), 0o700)
    })

    it('scopes every pinned path beneath the supplied branded cockpit id', async () => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        await mkdir(home)
        const result = await selectStateRoot({ platform: 'linux', home, cockpitId })
        if (result.kind !== 'complete') throw new Error('expected a selected state root')
        const base = join(home, '.local', 'state', 'cockpit', 'v1', 'cockpits', `cockpit_sample_${'a'.repeat(64)}`)

        expect(result.value.cockpitRoot).toBe(base)
        expect(Object.keys(result.value.paths).sort()).toEqual([
            'baseline', 'cache', 'coordination', 'dataOutcome', 'installLock', 'lifecycle', 'stateLock',
        ])
        expect(result.value.paths.coordination(stackId).path).toBe(join(base, 'records', 'coordination', `stack_${'b'.repeat(64)}.json`))
        expect(result.value.paths.lifecycle(stackId).path).toBe(join(base, 'records', 'lifecycle', `stack_${'b'.repeat(64)}.json`))
        expect(result.value.paths.dataOutcome(stackId).path).toBe(join(base, 'records', 'data-outcome', `stack_${'b'.repeat(64)}.json`))
        expect(lifecycleHistoryAddress(result.value, stackId)?.path).toBe(join(base, 'records', 'lifecycle-history', `stack_${'b'.repeat(64)}.json`))
        expect(result.value.paths.stateLock).toBe(join(base, 'locks', 'state.lock'))
        expect(result.value.paths.installLock('cache-a')).toBe(join(base, 'locks', 'install', 'cache-cache-a.lock'))
        expect(result.value.paths.cache(checkoutId, 'a'.repeat(64)).path).toBe(
            join(base, 'cache', `checkout_${'c'.repeat(64)}`, `${'a'.repeat(64)}.json`),
        )
        expect(result.value.paths.baseline(stackId).path).toBe(join(base, 'evidence', 'baselines', `stack_${'b'.repeat(64)}.json`))
    })
})

describe('bootstrap state', () => {
    it('round-trips bootstrap identity through Windows-safe state filenames', async () => {
        const { namespace, address } = await selectedBootstrapNamespace()
        const ownerId = bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'portable-state' })
        const record = bootstrapRecord(address)
        expectWindowsSafeStatePath(namespace.root, address.path)
        expectWindowsSafeStatePath(namespace.root, namespace.paths.stateLock)
        let temporaryObserved = false
        const written = await transactState(namespace, address, { ownerId, beforePublish: async temporaryPath => {
            temporaryObserved = true
            expectWindowsSafeStatePath(namespace.root, temporaryPath)
            expect(JSON.parse(await readFile(temporaryPath, 'utf8'))).toEqual(record)
        } }, () => record)
        expect(temporaryObserved).toBe(true)
        expect(written).toEqual({ kind: 'complete', value: record })
        expect(await readState(address)).toEqual({ kind: 'complete', value: record })
        const raw = { ...address, path: join(namespace.root, relative(namespace.root, address.path).replaceAll('_', ':')) }
        await expect(readState(raw)).resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        await expect(transactState(namespace, raw, { ownerId }, () => record))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
    })

    it('selects checkout-scoped state without cockpit or stack identity and refuses copied authority', async () => {
        const parent = await temporaryDirectory(); const home = join(parent, 'home'); const checkoutPath = join(parent, 'checkout')
        await Promise.all([mkdir(home), mkdir(checkoutPath)])
        const checkoutRoot = await realpath(checkoutPath)
        const selected = await selectBootstrapStateRoot({ platform: 'linux', home, checkoutRoot, target: 'codexcli' })
        if (selected.kind !== 'complete') throw new Error('expected bootstrap state selection')
        const expectedCheckout = deriveCheckoutId({ checkoutPath: checkoutRoot })
        const address = selected.value.paths.bootstrap('codexcli')
        expect(address).toEqual({
            path: join(selected.value.root, 'checkouts', expectedCheckout.replace(':', '_'), 'records', 'bootstrap', 'codexcli.json'),
            stateRoot: selected.value.root, checkoutRoot: selected.value.checkoutRoot,
            kind: 'bootstrap', checkoutId: expectedCheckout, target: 'codexcli',
        })
        expect(JSON.stringify(selected.value)).not.toContain('cockpit:')
        expect(JSON.stringify(selected.value)).not.toContain('stack:')
        await expect(transactState({ ...selected.value } as BootstrapStateNamespace, address,
            { ownerId: bootstrapHolderId({ checkoutId: expectedCheckout, sessionId: 'copy' }) }, () => bootstrapRecord(address)))
            .resolves.toMatchObject({ kind: 'refusal' })
        expect(snapshotBootstrapStateNamespace({ ...selected.value, paths: { stateLock: selected.value.paths.stateLock } } as never))
            .toBeUndefined()
        expect(() => selected.value.paths.bootstrap('opencode')).toThrow('selected bootstrap target')
        expect(() => selected.value.paths.bootstrap('unknown' as never)).toThrow('surface target')
    })

    it('round-trips a bounded crash-safe bootstrap record and authenticates its publication', async () => {
        const { namespace, address } = await selectedBootstrapNamespace()
        const ownerId = bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'init-session' })
        const written = await transactState(namespace, address, { ownerId }, () => bootstrapRecord(address))
        expect(written).toMatchObject({ kind: 'complete', value: bootstrapRecord(address) })
        expect(await readState(address)).toEqual({ kind: 'complete', value: bootstrapRecord(address) })
        expect(written.kind === 'complete' && authenticateStatePublication({ publication: written, address })).toEqual({
            status: 'complete', record: bootstrapRecord(address),
        })

        const rereadNamespace = await selectBootstrapStateRoot({
            platform: 'linux', home: dirname(dirname(dirname(dirname(namespace.root)))), checkoutRoot: address.checkoutRoot, target: address.target,
        })
        expect(rereadNamespace.kind).toBe('complete')
        if (rereadNamespace.kind === 'complete') expect(await readState(rereadNamespace.value.paths.bootstrap(address.target)))
            .toEqual({ kind: 'complete', value: bootstrapRecord(address) })

        await expect(transactState(namespace, address, { ownerId }, current => ({
            ...bootstrapRecord(address, 1),
            value: { ...(current as BootstrapStateRecord).value,
                sources: [{ path: 'cockpit.toml', sha256: 'f'.repeat(64) }] },
        }))).resolves.toMatchObject({ kind: 'refusal' })
        expect(await readState(address)).toEqual({ kind: 'complete', value: bootstrapRecord(address) })
    })

    it('persists provenance-bound greenfield answers and refuses changed or skipped interview evidence', async () => {
        const { namespace, address } = await selectedBootstrapNamespace()
        const ownerId = bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'greenfield-session' })
        const question = { id: `question:${'5'.repeat(64)}`, field: 'api.runnable', source: 'api/package.json', why: 'runnable command is unknown' }
        const answer = { questionId: question.id, bytes: 'npm run dev', sha256: createHash('sha256').update('npm run dev').digest('hex'), provenance: 'operator-confirmed' as const }
        const pending: BootstrapStateRecord = { ...bootstrapRecord(address), value: { ...bootstrapRecord(address).value,
            stage: 'surface-published', destination: null, artifactBytes: null, artifactSha256: null,
            greenfield: { stage: 'question-pending', classification: 'incomplete-multi-repository',
                sourceObservationSha256: '6'.repeat(64), notice: 'observation is incomplete',
                questions: [question], answers: [] },
        } }
        await expect(transactState(namespace, address, { ownerId }, () => ({ ...pending, value: { ...pending.value,
            greenfield: { ...pending.value.greenfield!, stage: 'answers-recorded' as const, answers: [answer] },
        } }))).resolves.toMatchObject({ kind: 'refusal' })
        const written = await transactState(namespace, address, { ownerId }, () => pending)
        expect(written).toMatchObject({ kind: 'complete' })
        await expect(transactState(namespace, address, { ownerId }, () => ({ ...pending, revision: 1,
            value: { ...pending.value, stage: 'draft-observed' as const },
        }))).resolves.toMatchObject({ kind: 'refusal' })
        const answered: BootstrapStateRecord = { ...pending, revision: 1, value: { ...pending.value,
            greenfield: { ...pending.value.greenfield!, stage: 'answers-recorded', answers: [answer] },
        } }
        await expect(transactState(namespace, address, { ownerId }, () => answered)).resolves.toMatchObject({ kind: 'complete' })
        for (const changed of [
            { ...answered, revision: 2, value: { ...answered.value, greenfield: { ...answered.value.greenfield!, sourceObservationSha256: '7'.repeat(64) } } },
            { ...answered, revision: 2, value: { ...answered.value, greenfield: { ...answered.value.greenfield!, answers: [] } } },
            { ...answered, revision: 2, value: { ...answered.value, greenfield: { ...answered.value.greenfield!, answers: [{ ...answer, bytes: 'changed' }] } } },
            { ...answered, revision: 2, value: { ...answered.value, greenfield: { ...answered.value.greenfield!, answers: [{
                ...answer, bytes: 'token=synthetic-secret', sha256: createHash('sha256').update('token=synthetic-secret').digest('hex'),
            }] } } },
        ]) await expect(transactState(namespace, address, { ownerId }, () => changed as BootstrapStateRecord))
            .resolves.toMatchObject({ kind: 'refusal' })
    })

    it('resets one recorded bootstrap answer only through an exact revision-bound owner operation', async () => {
        const { namespace, address } = await selectedBootstrapNamespace()
        const ownerId = bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'reset-session' })
        const questions = ['sibling', 'ports.bases', 'guards'].map((field, index) => ({
            id: `question:${String(index + 1).repeat(64)}`, field, source: `configuration:${index}`, why: `${field} is unresolved`,
        }))
        const answers = questions.map((question, index) => {
            const bytes = JSON.stringify({ value: index })
            return { questionId: question.id, bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
                provenance: 'operator-confirmed' as const }
        })
        const base: BootstrapStateRecord = { ...bootstrapRecord(address), value: { ...bootstrapRecord(address).value,
            stage: 'surface-published', destination: null, artifactBytes: null, artifactSha256: null,
        } }
        expect(await transactState(namespace, address, { ownerId }, () => base)).toMatchObject({ kind: 'complete' })
        let recorded: BootstrapStateRecord = { ...base, revision: 1, value: { ...base.value,
            greenfield: { stage: 'question-pending' as const,
                classification: 'incomplete-multi-repository' as const, sourceObservationSha256: '6'.repeat(64),
                notice: 'configuration answers were recorded',
                questions: questions.slice(0, 1), answers: [] },
        } }
        expect(await transactState(namespace, address, { ownerId }, () => recorded)).toMatchObject({ kind: 'complete' })
        for (let index = 1; index < questions.length; index += 1) {
            const next = { ...recorded, revision: recorded.revision + 1, value: { ...recorded.value,
                greenfield: { stage: 'question-pending' as const,
                    classification: 'incomplete-multi-repository' as const, sourceObservationSha256: '6'.repeat(64),
                    notice: 'configuration answers were recorded',
                    questions: questions.slice(0, index + 1), answers: answers.slice(0, index) },
            } }
            const written = await transactState(namespace, address, { ownerId }, () => next)
            expect(written).toMatchObject({ kind: 'complete' })
            recorded = next
        }
        recorded = { ...recorded, revision: recorded.revision + 1, value: { ...recorded.value,
            greenfield: { ...recorded.value.greenfield!, stage: 'answers-recorded', answers },
        } }
        expect(await transactState(namespace, address, { ownerId }, () => recorded)).toMatchObject({ kind: 'complete' })

        const preview = await resetBootstrapAnswer(namespace, address, { ownerId, field: 'ports.bases', updatedAt: '2026-09-07T12:01:00.000Z' })
        expect(preview).toMatchObject({ kind: 'pending', preview: { revision: 4, field: 'ports.bases',
            invalidatedFields: ['ports.bases', 'guards'], previewSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } })
        expect(await readState(address)).toEqual({ kind: 'complete', value: recorded })

        await expect(transactState(namespace, address, { ownerId }, current => ({ ...current!, revision: current!.revision + 1,
            value: { ...current!.value, greenfield: { ...current!.value.greenfield!, stage: 'question-pending' as const,
                questions: questions.slice(0, 2), answers: answers.slice(0, 1) } },
        }))).resolves.toMatchObject({ kind: 'refusal' })
        const accepted = await resetBootstrapAnswer(namespace, address, { ownerId, field: 'ports.bases', updatedAt: '2026-09-07T12:01:00.000Z',
            acceptedPreviewSha256: preview.kind === 'pending' ? preview.preview.previewSha256 : '' })
        expect(accepted).toMatchObject({ kind: 'complete', preview: { revision: 4, field: 'ports.bases' }, record: {
            revision: 5, value: { stage: 'surface-published', greenfield: { stage: 'question-pending',
                questions: questions.slice(0, 2), answers: answers.slice(0, 1) } } } })
        expect(await resetBootstrapAnswer(namespace, address, { ownerId, field: 'ports.bases', updatedAt: '2026-09-07T12:01:00.000Z',
            acceptedPreviewSha256: preview.kind === 'pending' ? preview.preview.previewSha256 : '' }))
            .toMatchObject({ kind: 'refusal', code: 'BOOTSTRAP_ANSWER_RESET_STALE' })
    })

    it('refuses target, root, record, owner, size and filesystem authority substitution', async () => {
        const { namespace, address } = await selectedBootstrapNamespace('claudecode')
        const ownerId = bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'init-session' })
        const record = bootstrapRecord(address)
        const changedTarget = { ...address, target: 'opencode' as const }
        const changedRoot = { ...address, checkoutRoot: join(address.checkoutRoot, 'foreign') }
        const changedCheckout = { ...address, checkoutId: `checkout:${'f'.repeat(64)}` as CheckoutId }
        const lostTarget = Object.fromEntries(Object.entries(address).filter(([key]) => key !== 'target')) as unknown as BootstrapStateAddress
        const runtimeSubstitution = { ...address, cockpitId, subjectId: stackId }
        for (const candidate of [changedTarget, changedRoot, changedCheckout, lostTarget, runtimeSubstitution]) {
            await expect(transactState(namespace, candidate, { ownerId }, () => record)).resolves.toMatchObject({ kind: 'refusal' })
        }
        await expect(transactState(namespace, address, { ownerId: holderA }, () => record)).resolves.toMatchObject({ kind: 'refusal' })
        await expect(transactState(namespace, address, { ownerId }, () => ({ ...record, target: 'opencode' } as never)))
            .resolves.toMatchObject({ kind: 'refusal' })
        await expect(transactState(namespace, address, { ownerId }, () => ({ ...record,
            value: { ...record.value, artifactBytes: 'x'.repeat(SERIALIZED_RECORD_BYTE_LIMIT) },
        }))).resolves.toMatchObject({ kind: 'refusal' })

        await mkdir(dirname(address.path), { recursive: true })
        const outside = join(await temporaryDirectory(), 'outside.json'); await writeFile(outside, JSON.stringify(record))
        await symlink(outside, address.path)
        await expect(readState(address)).resolves.toMatchObject({ kind: 'refusal' })
        await rm(address.path); await writeFile(address.path, JSON.stringify(record)); await chmod(address.path, 0o666)
        await expect(readState(address)).resolves.toMatchObject({ kind: 'refusal' })
        await chmod(address.path, 0o600)
    })
})

describe('readState', () => {
    it('returns a named refusal when an address getter throws', async () => {
        const { address } = await selectedNamespace()
        const hostile = { ...address }
        Object.defineProperty(hostile, 'path', { get: () => { throw new Error('hostile address getter') } })

        await expect(readState(hostile)).resolves.toEqual({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            message: 'state record address could not be read safely',
            target: 'state record address',
        })
    })

    it('distinguishes missing state from a valid strict record', async () => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        await mkdir(home)
        const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
        if (selected.kind !== 'complete') throw new Error('expected a selected state root')
        const address = selected.value.paths.lifecycle(stackId)

        expect(await readState(address)).toEqual({ kind: 'missing', path: address.path })

        await mkdir(dirname(address.path), { recursive: true })
        const record = {
            format: 'cockpit-state/v1',
            kind: 'lifecycle',
            cockpitId,
            subjectId: stackId,
            revision: 0,
            updatedAt: '2026-09-07T12:00:00.000Z',
            value: { holders: [] },
        }
        await writeFile(address.path, `${JSON.stringify(record)}\n`)
        expect(await readState(address)).toEqual({ kind: 'complete', value: record })
    })

    it('uses one address snapshot for record authority and diagnostics', async () => {
        const { address } = await selectedNamespace()
        await mkdir(dirname(address.path), { recursive: true })
        await writeFile(address.path, `${JSON.stringify(lifecycleRecord(0, 7))}\n`)
        const originalPath = address.path
        const mutable = { ...address }
        const reading = readState(mutable)
        Object.assign(mutable, {
            path: join(dirname(originalPath), 'mutated.json'),
            kind: 'baseline',
            cockpitId: `cockpit:mutated:${'f'.repeat(64)}`,
            subjectId: `stack:${'f'.repeat(64)}`,
        })
        expect(await reading).toEqual({ kind: 'complete', value: lifecycleRecord(0, 7) })

        await writeFile(originalPath, '{')
        const malformedAddress = { ...address }
        const malformedReading = readState(malformedAddress)
        Object.assign(malformedAddress, {
            path: join(dirname(originalPath), 'other.json'),
            kind: 'baseline',
            cockpitId: `cockpit:other:${'e'.repeat(64)}`,
            subjectId: `stack:${'e'.repeat(64)}`,
        })
        expect(await malformedReading).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, target: originalPath,
        })
    })

    it.each([
        ['invalid UTF-8', Buffer.from([0xc3, 0x28]), ENVIRONMENT_CODES.STATE_RECORD_MALFORMED],
        ['malformed JSON', Buffer.from('{'), ENVIRONMENT_CODES.STATE_RECORD_MALFORMED],
        ['unknown key', Buffer.from(JSON.stringify({ format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId, subjectId: stackId, revision: 0, updatedAt: '2026-09-07T12:00:00.000Z', value: {}, extra: true })), ENVIRONMENT_CODES.STATE_RECORD_MALFORMED],
        ['newer version', Buffer.from(JSON.stringify({ format: 'cockpit-state/v2', kind: 'lifecycle' })), ENVIRONMENT_CODES.STATE_FORMAT_UNSUPPORTED],
        ['wrong identity', Buffer.from(JSON.stringify({ format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: 'other-a1', subjectId: stackId, revision: 0, updatedAt: '2026-09-07T12:00:00.000Z', value: {} })), ENVIRONMENT_CODES.STATE_RECORD_MALFORMED],
    ])('fails closed for %s', async (_label, bytes, code) => {
        const parent = await temporaryDirectory()
        const home = join(parent, 'home')
        await mkdir(home)
        const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
        if (selected.kind !== 'complete') throw new Error('expected a selected state root')
        const address = selected.value.paths.lifecycle(stackId)
        await mkdir(dirname(address.path), { recursive: true })
        await writeFile(address.path, bytes)

        expect(await readState(address)).toMatchObject({ kind: 'refusal', code })
    })

    it('refuses a record kind outside the current state format', async () => {
        const { address } = await selectedNamespace()
        await mkdir(dirname(address.path), { recursive: true })
        const bytes = JSON.stringify({
            format: 'cockpit-state/v1', kind: 'unsupported', cockpitId, subjectId: stackId,
            revision: 0, updatedAt: '2026-09-07T12:00:00.000Z', value: {},
        })
        await writeFile(address.path, bytes)
        expect(await readState(address)).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, target: address.path })
        expect(await readFile(address.path, 'utf8')).toBe(bytes)
    })

    it('refuses a symlinked record without reading its target', async () => {
        const { address } = await selectedNamespace()
        const outside = join(await temporaryDirectory(), 'outside.json')
        await writeFile(outside, `${JSON.stringify(lifecycleRecord(0, 7))}\n`)
        await mkdir(dirname(address.path), { recursive: true })
        await symlink(outside, address.path)

        expect(await readState(address)).toMatchObject({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        })
    })

    it('refuses a symlinked cockpit namespace before following its record path', async () => {
        const { namespace, address } = await selectedNamespace()
        const outside = join(await temporaryDirectory(), 'outside')
        await mkdir(join(outside, 'records', 'lifecycle'), { recursive: true })
        await writeFile(join(outside, 'records', 'lifecycle', `stack_${'b'.repeat(64)}.json`), `${JSON.stringify(lifecycleRecord(0, 7))}\n`)
        await mkdir(join(namespace.root, 'cockpits'), { recursive: true })
        await symlink(outside, namespace.cockpitRoot)

        expect(await readState(address)).toMatchObject({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        })
    })

    it('does not follow a record swapped to a symlink after path validation', async () => {
        const { address } = await selectedNamespace()
        const outside = join(await temporaryDirectory(), 'outside.json')
        await mkdir(dirname(address.path), { recursive: true })
        await writeFile(address.path, `${JSON.stringify(lifecycleRecord(0, 1))}\n`)
        await writeFile(outside, `${JSON.stringify(lifecycleRecord(0, 99))}\n`)

        let baselineAccesses = 0
        const countedAddress = {
            ...address,
            get path() {
                baselineAccesses += 1
                return address.path
            },
        }
        expect(await readState(countedAddress)).toMatchObject({ kind: 'complete' })

        let swapAccesses = 0
        const swappedAddress = {
            ...address,
            get path() {
                swapAccesses += 1
                if (swapAccesses === baselineAccesses) {
                    unlinkSync(address.path)
                    symlinkSync(outside, address.path)
                }
                return address.path
            },
        }

        expect(await readState(swappedAddress)).toMatchObject({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        })
    })

    it('delegates identity construction and keeps repository discovery outside the state module', async () => {
        const source = await readFile(new URL('./state.ts', import.meta.url), 'utf8')

        expect(source).toMatch(/checkoutId as deriveCheckoutId[^\n]+from ['"]\.\/identity\.js['"]/)
        expect(source).not.toMatch(/node:child_process|\bgit\b|common-dir|rev-parse/i)
        expect(source).not.toMatch(/function\s+(?:create|derive|discover|resolve)CockpitId\b/)
    })
})

describe('transactState', () => {
    it('serialises root port operations across issued cockpit namespaces before local transactions', async () => {
        const { namespace, address } = await selectedNamespace()
        const other = await selectStateRoot({ platform: 'linux', home: undefined,
            xdgStateHome: dirname(dirname(namespace.root)), cockpitId: `cockpit:other:${'f'.repeat(64)}` as CockpitId })
        if (other.kind !== 'complete') throw new Error('expected another issued namespace')
        let entered!: () => void
        let release!: () => void
        const acquired = new Promise<void>((resolve) => { entered = resolve })
        const held = new Promise<void>((resolve) => { release = resolve })
        const first = withStateRootPortLock(namespace, { ownerId: holderA }, async () => {
            const published = await transactState(namespace, address, { ownerId: holderA }, async () => {
                expect(JSON.parse(await readFile(join(namespace.root, 'locks', 'ports', 'state.lock', 'owner.json'), 'utf8')))
                    .toMatchObject({ ownerId: holderA, pid: process.pid })
                expect(JSON.parse(await readFile(join(namespace.paths.stateLock, 'owner.json'), 'utf8')))
                    .toMatchObject({ ownerId: holderA, pid: process.pid })
                entered()
                await held
                return lifecycleRecord(0, 1)
            })
            return published
        })
        await acquired
        const forbidden = vi.fn(() => 'overlap')
        try {
            await expect(withStateRootPortLock(other.value, { ownerId: holderB, contentionTimeoutMs: 0 }, forbidden))
                .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED })
            await expect(withStateRootPortLock({ ...namespace }, { ownerId: holderB }, forbidden))
                .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
            expect(forbidden).not.toHaveBeenCalled()
        } finally { release() }
        await expect(first).resolves.toMatchObject({ kind: 'complete', value: { kind: 'complete', value: lifecycleRecord(0, 1) } })
        await expect(withStateRootPortLock(other.value, { ownerId: holderB, contentionTimeoutMs: 0 }, () => 'later'))
            .resolves.toEqual({ kind: 'complete', value: 'later' })
    })

    it('preserves a committed record and owner evidence when the root port lock release fails', async () => {
        const { namespace, address } = await selectedNamespace()
        const result = await withStateRootPortLock(namespace, { ownerId: holderA,
            beforeRelease: async () => { throw new Error('injected root release failure') },
        }, () => transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 1)))
        expect(result).toMatchObject({ kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            value: { kind: 'complete', value: lifecycleRecord(0, 1) }, recovery: expect.stringContaining('lock') })
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: lifecycleRecord(0, 1) })
        if (result.kind !== 'indeterminate') throw new Error('expected retained root lock evidence')
        expect(JSON.parse(await readFile(join(result.target, 'owner.json'), 'utf8')))
            .toMatchObject({ ownerId: holderA, pid: process.pid })
        await expect(withStateRootPortLock(namespace, { ownerId: holderB, contentionTimeoutMs: 0 }, () => 'unsafe'))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED })
    })

    it('holds the same issued scope exclusively while allowing a different scope concurrently', async () => {
        const { namespace } = await selectedNamespace()
        const firstScope = issueStateScopedLock(namespace, { owner: 'browser-worker', identity: 'a'.repeat(64) })!
        const sameScope = issueStateScopedLock(namespace, { owner: 'browser-worker', identity: 'a'.repeat(64) })!
        const otherScope = issueStateScopedLock(namespace, { owner: 'browser-worker', identity: 'b'.repeat(64) })!
        let entered!: () => void
        let release!: () => void
        const acquired = new Promise<void>(resolve => { entered = resolve })
        const held = new Promise<void>(resolve => { release = resolve })
        const first = withStateScopedLock(namespace, firstScope, { ownerId: holderA }, async () => {
            entered()
            await held
            return 'first'
        })
        await acquired

        await expect(withStateScopedLock(namespace, sameScope, { ownerId: holderB, contentionTimeoutMs: 0 }, () => 'same'))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED })
        await expect(withStateScopedLock(namespace, otherScope, { ownerId: holderB }, () => 'other'))
            .resolves.toEqual({ kind: 'complete', value: 'other' })
        await expect(withStateScopedLock(namespace, { ...firstScope }, { ownerId: holderB }, () => 'forged'))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })

        release()
        await expect(first).resolves.toEqual({ kind: 'complete', value: 'first' })
        await expect(withStateScopedLock(namespace, sameScope, { ownerId: holderB }, () => 'later'))
            .resolves.toEqual({ kind: 'complete', value: 'later' })
    })

    it('rethrows a scoped operation failure unchanged after releasing the lock', async () => {
        const { namespace } = await selectedNamespace()
        const scope = issueStateScopedLock(namespace, { owner: 'browser-worker', identity: 'c'.repeat(64) })!
        const failure = new TypeError('synthetic operation failure')

        await expect(withStateScopedLock(namespace, scope, { ownerId: holderA }, () => { throw failure }))
            .rejects.toBe(failure)
        await expect(withStateScopedLock(namespace, scope, { ownerId: holderB, contentionTimeoutMs: 0 }, () => 'next'))
            .resolves.toEqual({ kind: 'complete', value: 'next' })
    })

    it('keeps a completed scoped result when its lock cannot be released', async () => {
        const { namespace } = await selectedNamespace()
        const scope = issueStateScopedLock(namespace, { owner: 'browser-worker', identity: 'c'.repeat(64) })!

        const result = await withStateScopedLock(namespace, scope, {
            ownerId: holderA,
            beforeRelease: async () => { throw new Error('injected release failure') },
        }, () => 'admitted')

        expect(result).toMatchObject({
            kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE, value: 'admitted',
            recovery: expect.stringContaining('lock'),
        })
    })

    it('names a lock directory it created but could not remove when a release quarantine races acquisition', async () => {
        const { namespace, address } = await selectedNamespace()
        const lockPath = namespace.paths.stateLock
        const quarantine = join(dirname(lockPath), '.state.lock.release-synthetic')
        lockAcquisitionControl.afterLockCreated = async (created) => {
            await mkdir(quarantine, { mode: 0o700 })
            await writeFile(join(created, 'unexpected-entry'), 'occupied')
        }
        const update = vi.fn(() => lifecycleRecord(0, 1))

        const result = await transactState(namespace, address, { ownerId: holderA }, update)

        expect(result).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED, target: quarantine,
            message: expect.stringContaining(`lock directory this acquisition created at ${lockPath} could not be removed`),
        })
        expect(update).not.toHaveBeenCalled()
    })

    it('rejects a transaction address kind outside the current namespace', async () => {
        const { namespace, address } = await selectedNamespace()
        const unsupported = { ...address, kind: 'unsupported' } as unknown as StateAddress

        await expect(transactState(namespace, unsupported, { ownerId: holderA }, () => lifecycleRecord(0, 1)))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        await expect(readState(unsupported))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
    })

    it('returns an exact typed abort without creating a missing record and releases the lock', async () => {
        const { namespace, address } = await selectedNamespace()
        const reason = { code: 'occupied-family', ports: [4173, 5173] } as const

        const aborted = await transactState(
            namespace,
            address,
            { ownerId: holderA },
            () => abortStateTransaction(reason),
        )

        expect(aborted).toEqual({ aborted: true, value: reason })
        expect(await readState(address)).toEqual({ kind: 'missing', path: address.path })

        const retry = await transactState(namespace, address, { ownerId: holderB }, () => lifecycleRecord(0, 1))
        expect(retry).toMatchObject({ kind: 'complete', value: { revision: 0, value: { count: 1 } } })
    })

    it('preserves existing bytes and revision when an update aborts', async () => {
        const { namespace, address } = await selectedNamespace()
        await mkdir(dirname(address.path), { recursive: true })
        const prior = `${JSON.stringify(lifecycleRecord(0, 1))}\n`
        await writeFile(address.path, prior)

        const aborted = await transactState(
            namespace,
            address,
            { ownerId: holderA },
            () => abortStateTransaction({ reason: 'listener-observed' as const }),
        )

        expect(aborted).toEqual({ aborted: true, value: { reason: 'listener-observed' } })
        expect(await readFile(address.path, 'utf8')).toBe(prior)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: { revision: 0 } })
    })

    it('rethrows a callback exception unchanged after releasing the transaction lock', async () => {
        const { namespace, address } = await selectedNamespace()
        const failure = new Error('unexpected callback failure')

        await expect(transactState(namespace, address, { ownerId: holderA }, () => { throw failure }))
            .rejects.toBe(failure)
        await expect(transactState(namespace, address, { ownerId: holderB, contentionTimeoutMs: 0 },
            () => lifecycleRecord(0, 1))).resolves.toMatchObject({ kind: 'complete' })
    })

    it('rejects a structural lookalike of the private transaction abort', async () => {
        const { namespace, address } = await selectedNamespace()
        const result = await transactState(namespace, address, { ownerId: holderA }, () => ({
            aborted: true,
            value: { reason: 'forged-abort' },
        }) as never)

        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        expect(result).not.toHaveProperty('aborted')
        expect(await readState(address)).toEqual({ kind: 'missing', path: address.path })
    })

    it('serializes two real processes updating one record', async () => {
        const { namespace, address } = await selectedNamespace()
        const stateModule = new URL('./state.ts', import.meta.url).href
        const worker = `
            import { transactState } from ${JSON.stringify(stateModule)}
            const namespace = JSON.parse(process.argv[1])
            const address = JSON.parse(process.argv[2])
            const ownerId = process.argv[3]
            const result = await transactState(namespace, address, { ownerId, contentionTimeoutMs: 2_000 }, async (current) => {
                await new Promise((resolve) => setTimeout(resolve, 100))
                const count = current?.value?.count ?? 0
                return {
                    format: 'cockpit-state/v1', kind: address.kind, cockpitId: address.cockpitId,
                    subjectId: address.subjectId, revision: (current?.revision ?? -1) + 1,
                    updatedAt: '2026-09-07T12:00:00.000Z', value: { count: count + 1 },
                }
            })
            if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
        `
        const args = ['--import', 'tsx', '--input-type=module', '--eval', worker, JSON.stringify(namespace), JSON.stringify(address)]

        await Promise.all([
            executeFile(process.execPath, [...args, holderA], { cwd: process.cwd() }),
            executeFile(process.execPath, [...args, holderB], { cwd: process.cwd() }),
        ])

        const result = await readState(address)
        expect(result).toMatchObject({ kind: 'complete', value: { revision: 1, value: { count: 2 } } })
    }, 10_000)

    it('waits with a bounded backoff for the global lock owner', async () => {
        const { namespace, address } = await selectedNamespace()
        let entered!: () => void
        let release!: () => void
        const lockHeld = new Promise<void>((resolve) => { entered = resolve })
        const mayPublish = new Promise<void>((resolve) => { release = resolve })
        const first = transactState(namespace, address, { ownerId: holderA }, async () => {
            entered()
            await mayPublish
            return lifecycleRecord(0, 1)
        })
        await lockHeld
        const second = transactState(namespace, address, { ownerId: holderB, contentionTimeoutMs: 1_000 }, (current) => (
            lifecycleRecord((current?.revision ?? -1) + 1, 2)
        ))
        setTimeout(release, 30)

        expect(await second).toMatchObject({ kind: 'complete', value: { revision: 1 } })
        await first
    })

    it('validates before publication and preserves the prior bytes on failure', async () => {
        const { namespace, address } = await selectedNamespace()
        await mkdir(dirname(address.path), { recursive: true })
        const prior = `${JSON.stringify(lifecycleRecord(0, 1))}\n`
        await writeFile(address.path, prior)

        const result = await transactState(namespace, address, { ownerId: holderA }, () => ({
            ...lifecycleRecord(1, 2),
            cockpitId: 'wrong-id' as CockpitId,
        }))

        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        expect(await readFile(address.path, 'utf8')).toBe(prior)
    })

    it('authenticates only the exact issued publication identity, address, revision, and value', async () => {
        const { namespace, address } = await selectedNamespace()
        const result = await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 2))
        if (result.kind !== 'complete') throw new Error('expected durable publication')
        const expectation = { publication: result, address }

        expect(authenticateStatePublication(expectation)).toEqual({ status: 'complete', record: lifecycleRecord(0, 2) })
        expect(authenticateStatePublication({ ...expectation, publication: { ...result } })).toBeUndefined()
        expect(authenticateStatePublication({ ...expectation, address: { ...address, subjectId: `stack:${'c'.repeat(64)}` as StackId } })).toBeUndefined()
        const mutableRecord = result.value as { updatedAt: string }
        mutableRecord.updatedAt = '2026-09-07T11:59:59.999Z'
        expect(authenticateStatePublication(expectation)).toEqual({ status: 'complete', record: lifecycleRecord(0, 2) })

        let reads = 0
        const accessor = { address }
        Object.defineProperty(accessor, 'publication', { enumerable: true, get: () => { reads += 1; return result } })
        expect(authenticateStatePublication(accessor as never)).toBeUndefined()
        expect(reads).toBe(0)
    })

    it('reports indeterminate durability when the parent directory sync fails after rename', async () => {
        const { namespace, address } = await selectedNamespace()
        const publicationParent = dirname(address.path)
        await mkdir(publicationParent, { recursive: true })
        const sync = await interceptDirectorySync(publicationParent, () => {
            throw new Error('injected parent directory sync failure')
        })
        let result
        try {
            result = await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 2))
        } finally {
            sync.restore()
        }

        expect(result).toMatchObject({
            kind: 'indeterminate',
            code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            value: lifecycleRecord(0, 2),
        })
        expect(JSON.stringify(result)).toContain('read the record before deciding whether to retry')
        expect(await readState(address)).toMatchObject({
            kind: 'complete',
            value: { revision: 0, value: { count: 2 } },
        })
        expect(authenticateStatePublication({ publication: result, address }))
            .toEqual({ status: 'indeterminate', record: lifecycleRecord(0, 2) })
    })

    it('reports complete only after syncing the exact publication parent', async () => {
        const { namespace, address } = await selectedNamespace()
        const publicationParent = dirname(address.path)
        await mkdir(publicationParent, { recursive: true })
        const sync = await interceptDirectorySync(publicationParent, () => undefined)
        let result
        try {
            result = await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 2))
        } finally {
            sync.restore()
        }

        expect(result).toMatchObject({ kind: 'complete', value: lifecycleRecord(0, 2) })
        expect(sync.calls()).toBe(1)
    })

    it.each(['EINVAL', 'ENOTSUP', 'EBADF'])('does not reinterpret directory sync %s as durable', async (code) => {
        const { namespace, address } = await selectedNamespace()
        const publicationParent = dirname(address.path)
        await mkdir(publicationParent, { recursive: true })
        const sync = await interceptDirectorySync(publicationParent, () => {
            throw Object.assign(new Error('directory sync unsupported'), { code })
        })
        let result
        try {
            result = await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 6))
        } finally {
            sync.restore()
        }

        expect(result).toMatchObject({
            kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        })
    })

    it.each([
        [
            'durable publication',
            false,
            'read the committed record and reconcile its revision before deciding whether to retry the transaction',
        ],
        [
            'already-indeterminate publication',
            true,
            'read the record before deciding whether to retry the transaction',
        ],
    ])('composes committed-record and lock recovery for a %s', async (_label, failPublicationSync, publicationRecovery) => {
        const { namespace, address } = await selectedNamespace()
        const publicationParent = dirname(address.path)
        await mkdir(publicationParent, { recursive: true })
        const sync = failPublicationSync
            ? await interceptDirectorySync(publicationParent, () => { throw new Error('injected directory sync failure') })
            : undefined
        let result
        try {
            result = await transactState(namespace, address, {
                ownerId: holderA,
                beforeRelease: async () => {
                    await writeFile(join(namespace.paths.stateLock, 'unexpected-entry'), 'occupied')
                },
            }, () => lifecycleRecord(0, 9))
        } finally {
            sync?.restore()
        }

        expect(result).toEqual({
            kind: 'indeterminate',
            code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            message: failPublicationSync
                ? 'state bytes were renamed but parent directory durability could not be confirmed; the state lock also could not be released safely'
                : 'state bytes were committed but the state lock could not be released safely',
            target: address.path,
            recovery: `${publicationRecovery}; inspect the quarantined lock holder and restore or reclaim it using positive owner evidence`,
            value: lifecycleRecord(0, 9),
        })
        const quarantines = (await readdir(dirname(namespace.paths.stateLock)))
            .filter((name) => name.startsWith('.state.lock.release-'))
        expect(quarantines).toHaveLength(1)
        expect(await readFile(join(dirname(namespace.paths.stateLock), quarantines[0]!, 'owner.json'), 'utf8'))
            .toContain(holderA)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: lifecycleRecord(0, 9) })
    })

    it.each([2, 3, 4, 5, 6])('preserves exact owner evidence when release directory sync %i fails', async (failedSync) => {
        const { namespace, address } = await selectedNamespace()
        const releaseRoot = dirname(namespace.paths.stateLock)
        await mkdir(releaseRoot, { recursive: true })
        let tombstoneIdentity: { readonly dev: number; readonly ino: number } | undefined
        const releaseRootCall = new Map([[2, 1], [3, 2], [5, 3], [6, 4]]).get(failedSync)
        const sync = await interceptDirectorySync(
            releaseRoot,
            (call) => {
                if (call === (releaseRootCall ?? 1)) throw new Error(`injected sync failure ${failedSync}`)
            },
            failedSync === 4 ? () => tombstoneIdentity : undefined,
        )
        let result
        try {
            result = await transactState(namespace, address, {
                ownerId: holderA,
                ...(failedSync === 4 ? { beforeRelease: async () => {
                    const handle = await open(namespace.paths.stateLock, 'r')
                    try {
                        const identity = await handle.stat()
                        tombstoneIdentity = { dev: identity.dev, ino: identity.ino }
                    } finally {
                        await handle.close()
                    }
                } } : {}),
            }, () => lifecycleRecord(0, failedSync))
        } finally {
            sync.restore()
        }

        expect(result).toMatchObject({
            kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            value: lifecycleRecord(0, failedSync),
        })
        const locksRoot = dirname(namespace.paths.stateLock)
        const residues = (await readdir(locksRoot)).filter((name) => name.startsWith('.state.lock.release-'))
        expect(residues.length).toBeGreaterThan(0)
        const evidence: string[] = []
        for (const residue of residues) {
            const path = join(locksRoot, residue)
            try {
                evidence.push(await readFile(path, 'utf8'))
            } catch {
                try {
                    evidence.push(await readFile(join(path, 'owner.json'), 'utf8'))
                } catch {
                    // A sibling residue carries the same inode-bound evidence.
                }
            }
        }
        expect(evidence).toContainEqual(expect.stringContaining(holderA))
        await expect(transactState(namespace, address, { ownerId: holderB }, () => lifecycleRecord(1, 9)))
            .resolves.toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED })
    })

    it('snapshots the complete transaction address before invoking the update', async () => {
        const { namespace, address } = await selectedNamespace()
        const outside = await temporaryDirectory()
        const sentinel = join(outside, 'sentinel.json')
        await writeFile(sentinel, 'outside-bytes')
        const originalPath = address.path
        const mutable = { ...address }
        const otherCockpit = `cockpit:other:${'f'.repeat(64)}` as CockpitId
        const otherStack = `stack:${'f'.repeat(64)}` as StackId

        const result = await transactState(namespace, mutable, { ownerId: holderA }, () => {
            Object.assign(mutable, {
                path: sentinel,
                kind: 'coordination',
                cockpitId: otherCockpit,
                subjectId: otherStack,
                qualifier: 'mutated',
            })
            return {
                format: 'cockpit-state/v1',
                kind: 'coordination',
                cockpitId: otherCockpit,
                subjectId: otherStack,
                revision: 0,
                updatedAt: '2026-09-07T12:00:00.000Z',
                value: {},
            }
        })

        expect(result).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, target: originalPath,
        })
        expect(await readFile(sentinel, 'utf8')).toBe('outside-bytes')
        expect(await readState(address)).toEqual({ kind: 'missing', path: originalPath })
    })

    it('snapshots transaction namespace and hooks before invoking the update', async () => {
        const { namespace, address } = await selectedNamespace()
        const outside = await temporaryDirectory()
        const sentinel = join(outside, 'state.lock')
        await writeFile(sentinel, 'outside-bytes')
        const mutableNamespace = {
            ...namespace,
            paths: { ...namespace.paths },
        }
        let beforePublishCalls = 0
        let beforeReleaseCalls = 0
        const mutableOptions = {
            ownerId: holderA,
            beforePublish: async () => { beforePublishCalls += 1 },
            beforeRelease: async () => { beforeReleaseCalls += 1 },
        }

        const result = await transactState(mutableNamespace, address, mutableOptions, () => {
            mutableNamespace.paths.stateLock = sentinel
            mutableOptions.ownerId = holderB
            mutableOptions.beforePublish = async () => { throw new Error('mutated publish hook') }
            mutableOptions.beforeRelease = async () => { throw new Error('mutated release hook') }
            return lifecycleRecord(0, 3)
        })

        expect(result).toMatchObject({ kind: 'complete', value: lifecycleRecord(0, 3) })
        expect({ beforePublishCalls, beforeReleaseCalls }).toEqual({ beforePublishCalls: 1, beforeReleaseCalls: 1 })
        expect(await readFile(sentinel, 'utf8')).toBe('outside-bytes')
        await expect(readFile(namespace.paths.stateLock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('fails closed when transaction input getters throw', async () => {
        const { namespace, address } = await selectedNamespace()
        const hostile = { ...address }
        Object.defineProperty(hostile, 'path', { get: () => { throw new Error('hostile path getter') } })

        await expect(transactState(namespace, hostile, { ownerId: holderA }, () => lifecycleRecord(0, 1)))
            .resolves.toMatchObject({
                kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, target: 'state transaction input',
            })
    })

    it('preserves the lock owner when an adjacent evidence path already exists', async () => {
        const { namespace, address } = await selectedNamespace()
        let tombstone = ''
        const result = await transactState(namespace, address, {
            ownerId: holderA,
            beforeRelease: async () => {
                const owner = JSON.parse(await readFile(join(namespace.paths.stateLock, 'owner.json'), 'utf8')) as { token: string }
                tombstone = join(dirname(namespace.paths.stateLock), `.state.lock.release-${owner.token}`)
                await writeFile(`${tombstone}.owner.json`, 'occupied')
            },
        }, () => lifecycleRecord(0, 4))

        expect(result).toMatchObject({ kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE })
        expect(await readFile(join(tombstone, 'owner.json'), 'utf8')).toContain(holderA)
        expect(await readFile(`${tombstone}.owner.json`, 'utf8')).toBe('occupied')
    })

    it('blocks on crash-equivalent adjacent owner evidence without deleting it', async () => {
        const { namespace, address } = await selectedNamespace()
        const locksRoot = dirname(namespace.paths.stateLock)
        const tombstone = join(locksRoot, `.state.lock.release-${crypto.randomUUID()}`)
        const evidence = `${tombstone}.owner.json`
        await mkdir(tombstone, { recursive: true })
        await writeFile(evidence, 'durable-owner-evidence')

        expect(await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 1))).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED, target: tombstone,
            recovery: expect.stringContaining(evidence),
        })
        expect(await readFile(evidence, 'utf8')).toBe('durable-owner-evidence')
    })

    it.each([
        ['typed no-write abort', () => abortStateTransaction({ reason: 'no-write' as const })],
        ['invalid proposed record', () => ({ ...lifecycleRecord(0, 1), revision: 99 })],
    ])('keeps %s retry refusal semantics when lock release fails', async (_label, update) => {
        const { namespace, address } = await selectedNamespace()
        const result = await transactState(namespace, address, {
            ownerId: holderA,
            beforeRelease: async () => { throw new Error('injected release failure') },
        }, update)

        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED })
        expect(await readState(address)).toEqual({ kind: 'missing', path: address.path })
    })

    it('bounds state bytes before reading or publishing them', async () => {
        const { namespace, address } = await selectedNamespace()
        await mkdir(dirname(address.path), { recursive: true })
        await writeFile(address.path, Buffer.alloc(1_048_577, 0x20))
        expect(await readState(address)).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        })

        await rm(address.path)
        const oversized = lifecycleRecord(0, 1)
        oversized.value = { payload: 'x'.repeat(1_048_576) }
        expect(await transactState(namespace, address, { ownerId: holderA }, () => oversized)).toMatchObject({
            kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        })
        expect(await readState(address)).toEqual({ kind: 'missing', path: address.path })
    })

    it('leaves the prior bytes intact when a process is interrupted after fsync but before rename', async () => {
        const { namespace, address } = await selectedNamespace()
        await mkdir(dirname(address.path), { recursive: true })
        const prior = `${JSON.stringify(lifecycleRecord(0, 1))}\n`
        await writeFile(address.path, prior)
        const marker = join(dirname(address.path), 'publication-ready')
        const stateModule = new URL('./state.ts', import.meta.url).href
        const worker = `
            import { rename, writeFile } from 'node:fs/promises'
            import { transactState } from ${JSON.stringify(stateModule)}
            const namespace = JSON.parse(process.argv[1])
            const address = JSON.parse(process.argv[2])
            const marker = process.argv[3]
            await transactState(namespace, address, {
                ownerId: ${JSON.stringify(holderA)},
                beforePublish: async () => {
                    await writeFile(marker + '.tmp', 'ready')
                    await rename(marker + '.tmp', marker)
                    await new Promise(() => {})
                },
            }, (current) => ({ ...current, revision: current.revision + 1, value: { count: 2 } }))
        `
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', worker, JSON.stringify(namespace), JSON.stringify(address), marker],
            { cwd: process.cwd(), stdio: 'ignore' },
        )
        for (let attempts = 0; attempts < 100; attempts += 1) {
            try {
                await readFile(marker)
                break
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
        }
        expect(await readFile(marker, 'utf8')).toBe('ready')
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
            expect(child.kill('SIGKILL')).toBe(true)
            await Promise.race([
                exited,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('child did not exit')), 2_000)),
            ])
        }

        expect(await readFile(address.path, 'utf8')).toBe(prior)
    }, 10_000)

    it('preserves a replacement at the temporary publication pathname', async () => {
        const { namespace, address } = await selectedNamespace()
        let displaced = ''
        let temporary = ''
        const result = await transactState(namespace, address, {
            ownerId: holderA,
            beforePublish: async (temporaryPath) => {
                temporary = temporaryPath
                displaced = `${temporaryPath}.displaced`
                await rename(temporaryPath, displaced)
                await writeFile(temporaryPath, 'replacement-bytes')
                throw new Error('injected publication failure')
            },
        }, () => lifecycleRecord(0, 5))

        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        expect(await readFile(temporary, 'utf8')).toBe('replacement-bytes')
        expect(await readFile(displaced, 'utf8')).toContain('"count":5')
        await expect(readState(address)).resolves.toMatchObject({ kind: 'missing' })
    })

    it.each([
        ['malformed', '{', undefined],
        ['old but positively dead', JSON.stringify({ format: 'cockpit-state/v1', kind: 'state-lock', ownerId: holderA, pid: 123, acquiredAt: '2000-01-01T00:00:00.000Z', token: '6de0e288-72c8-4f62-92e1-719d7c11bc1a' }), async () => 'dead' as const],
    ])('does not take over a %s lock', async (_label, owner, observeHolder) => {
        const { namespace, address } = await selectedNamespace()
        await mkdir(namespace.paths.stateLock, { recursive: true })
        await writeFile(join(namespace.paths.stateLock, 'owner.json'), owner)

        const result = await transactState(
            namespace,
            address,
            { ownerId: holderB, observeHolder },
            () => lifecycleRecord(0, 1),
        )

        expect(result).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_LOCKED })
        expect(await readFile(join(namespace.paths.stateLock, 'owner.json'), 'utf8')).toBe(owner)
        expect(JSON.stringify(result)).toContain('recovery')
    })

    it('refuses an arbitrary lock owner label even when cast to the branded boundary', async () => {
        const { namespace, address } = await selectedNamespace()

        const result = await transactState(
            namespace,
            address,
            { ownerId: 'consumer-label' as HolderId },
            () => lifecycleRecord(0, 1),
        )

        expect(result).toMatchObject({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_LOCKED,
            message: 'state lock owner is invalid',
        })
    })

    it('never deletes a competing holder swapped in after release verification', async () => {
        const { namespace, address } = await selectedNamespace()
        const locksRoot = dirname(namespace.paths.stateLock)
        const originalLock = join(locksRoot, 'original-holder.lock')
        const verifiedMarker = join(locksRoot, 'release-verified')
        const continueMarker = join(locksRoot, 'continue-release')
        const stateModule = new URL('./state.ts', import.meta.url).href
        const worker = `
            import { readFile, rename, writeFile } from 'node:fs/promises'
            import { transactState } from ${JSON.stringify(stateModule)}
            const namespace = JSON.parse(process.argv[1])
            const address = JSON.parse(process.argv[2])
            const verifiedMarker = process.argv[3]
            const continueMarker = process.argv[4]
            const result = await transactState(namespace, address, {
                ownerId: ${JSON.stringify(holderA)},
                beforeRelease: async () => {
                    await writeFile(verifiedMarker + '.tmp', 'verified')
                    await rename(verifiedMarker + '.tmp', verifiedMarker)
                    for (;;) {
                        try {
                            await readFile(continueMarker)
                            break
                        } catch {
                            await new Promise((resolve) => setTimeout(resolve, 10))
                        }
                    }
                },
            }, () => (${JSON.stringify(lifecycleRecord(0, 1))}))
            process.stdout.write(JSON.stringify(result))
        `
        const childResult = executeFile(
            process.execPath,
            [
                '--import', 'tsx', '--input-type=module', '--eval', worker,
                JSON.stringify(namespace), JSON.stringify(address), verifiedMarker, continueMarker,
            ],
            { cwd: process.cwd() },
        )

        for (let attempts = 0; attempts < 200; attempts += 1) {
            try {
                await readFile(verifiedMarker)
                break
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
        }
        expect(await readFile(verifiedMarker, 'utf8')).toBe('verified')

        await rename(namespace.paths.stateLock, originalLock)
        await mkdir(namespace.paths.stateLock)
        const replacementOwner = `${JSON.stringify({
            format: 'cockpit-state/v1',
            kind: 'state-lock',
            ownerId: holderB,
            pid: process.pid,
            acquiredAt: '2026-09-07T12:00:00.000Z',
            token: 'ddfb3ed5-6a5c-4622-b90d-838743a53ef3',
        })}\n`
        await writeFile(join(namespace.paths.stateLock, 'owner.json'), replacementOwner)
        await writeFile(continueMarker, 'continue')

        const completed = JSON.parse((await childResult).stdout)
        expect(completed).toMatchObject({
            kind: 'indeterminate',
            code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            value: lifecycleRecord(0, 1),
        })
        const remainingLocks = await readdir(locksRoot)
        const ownerFiles = remainingLocks
            .filter((name) => name === 'state.lock' || name.startsWith('.state.lock.release-'))
            .map((name) => join(locksRoot, name, 'owner.json'))
        const remainingOwners = await Promise.all(ownerFiles.map((path) => readFile(path, 'utf8')))
        expect(remainingOwners).toContain(replacementOwner)
        expect(await readFile(join(originalLock, 'owner.json'), 'utf8')).toContain(holderA)

        let updateCalled = false
        const retry = await transactState(namespace, address, { ownerId: holderA }, (current) => {
            updateCalled = true
            return lifecycleRecord((current?.revision ?? -1) + 1, 2)
        })
        expect(retry).toMatchObject({
            kind: 'refusal',
            code: ENVIRONMENT_CODES.STATE_LOCKED,
            message: `state is locked by ${holderB} (unknown)`,
            target: namespace.paths.stateLock,
        })
        expect(await readFile(join(namespace.paths.stateLock, 'owner.json'), 'utf8')).toBe(replacementOwner)
        expect((await readdir(locksRoot)).some((name) => name.startsWith('.state.lock.release-'))).toBe(false)
        expect(updateCalled).toBe(false)
        expect(await readState(address)).toMatchObject({
            kind: 'complete',
            value: { revision: 0, value: { count: 1 } },
        })
    }, 10_000)

    it('preserves cooperative pre-syscall replacements without claiming a malicious same-UID guarantee', async () => {
        const { namespace, address } = await selectedNamespace()
        let tombstone = ''
        const replacementOwner = `${JSON.stringify({
            format: 'cockpit-state/v1', kind: 'state-lock', ownerId: holderB, pid: process.pid,
            acquiredAt: '2026-09-07T12:00:00.000Z', token: 'ddfb3ed5-6a5c-4622-b90d-838743a53ef3',
        })}\n`
        const result = await transactState(namespace, address, {
            ownerId: holderA,
            beforeRelease: async () => {
                const owner = JSON.parse(await readFile(join(namespace.paths.stateLock, 'owner.json'), 'utf8')) as { token: string }
                tombstone = join(dirname(namespace.paths.stateLock), `.state.lock.release-${owner.token}`)
            },
            beforeLockMetadata: async (operation) => {
                if (operation !== 'owner-unlink') return
                await rename(join(tombstone, 'owner.json'), join(tombstone, 'verified-owner.json'))
                await writeFile(join(tombstone, 'owner.json'), replacementOwner)
            },
        }, () => lifecycleRecord(0, 7))

        expect(result).toMatchObject({ kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE })
        expect(await readFile(join(tombstone, 'owner.json'), 'utf8')).toBe(replacementOwner)
        expect(await readFile(join(tombstone, 'verified-owner.json'), 'utf8')).toContain(holderA)
        expect(await readFile(`${tombstone}.owner.json`, 'utf8')).toContain(holderA)
    })

    it.each(['tombstone-rmdir', 'owner-restore-link', 'backup-unlink'] as const)(
        'keeps owner evidence when %s metadata handling fails',
        async (failedOperation) => {
            const { namespace, address } = await selectedNamespace()
            const releaseRoot = dirname(namespace.paths.stateLock)
            await mkdir(releaseRoot, { recursive: true })
            let tombstoneIdentity: { readonly dev: number; readonly ino: number } | undefined
            const sync = failedOperation === 'owner-restore-link'
                ? await interceptDirectorySync(
                    releaseRoot, () => { throw new Error('force restoration') }, () => tombstoneIdentity,
                )
                : undefined
            let result
            try {
                result = await transactState(namespace, address, {
                    ownerId: holderA,
                    ...(sync ? { beforeRelease: async () => {
                        const handle = await open(namespace.paths.stateLock, 'r')
                        try {
                            const identity = await handle.stat()
                            tombstoneIdentity = { dev: identity.dev, ino: identity.ino }
                        } finally {
                            await handle.close()
                        }
                    } } : {}),
                    beforeLockMetadata: async (operation) => {
                        if (operation === failedOperation) throw new Error(`injected ${operation} failure`)
                    },
                }, () => lifecycleRecord(0, 8))
            } finally {
                sync?.restore()
            }

            expect(result).toMatchObject({ kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE })
            const residues = (await readdir(dirname(namespace.paths.stateLock)))
                .filter((name) => name.startsWith('.state.lock.release-'))
            expect(residues.length).toBeGreaterThan(0)
            const contents = await Promise.all(residues.map(async (name) => {
                const path = join(dirname(namespace.paths.stateLock), name)
                try { return await readFile(path, 'utf8') } catch {
                    try { return await readFile(join(path, 'owner.json'), 'utf8') } catch { return '' }
                }
            }))
            expect(contents).toContainEqual(expect.stringContaining(holderA))
        },
    )
})


describe('state path permissions', () => {
    it.each(['directory', 'record'] as const)('refuses read and publication after %s permissions become unsafe', async (target) => {
        const { namespace, address } = await selectedNamespace()
        expect(await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 7))).toMatchObject({ kind: 'complete' })
        const bytes = await readFile(address.path)
        await chmod(target === 'directory' ? namespace.cockpitRoot : address.path, target === 'directory' ? 0o770 : 0o666)
        expect(await readState(address)).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED })
        const update = vi.fn(() => lifecycleRecord(1, 99))
        expect(await transactState(namespace, address, { ownerId: holderA }, update)).toMatchObject({ kind: 'refusal' })
        expect(update).not.toHaveBeenCalled()
        expect(await readFile(address.path)).toEqual(bytes)
    })

    it('refuses publication through a writable-by-others lock directory', async () => {
        const { namespace, address } = await selectedNamespace()
        await mkdir(dirname(namespace.paths.stateLock), { recursive: true })
        await chmod(dirname(namespace.paths.stateLock), 0o777)
        const update = vi.fn(() => lifecycleRecord(0, 7))
        expect(await transactState(namespace, address, { ownerId: holderA }, update)).toMatchObject({ kind: 'refusal' })
        expect(update).not.toHaveBeenCalled()
        expect(await readdir(dirname(namespace.paths.stateLock))).toEqual([])
    })
})


describe('state permission revalidation', () => {
    it('refuses a record directory made unsafe immediately before commit', async () => {
        const { namespace, address } = await selectedNamespace()
        expect(await transactState(namespace, address, { ownerId: holderA }, () => lifecycleRecord(0, 7))).toMatchObject({ kind: 'complete' })
        const bytes = await readFile(address.path)
        expect(await transactState(namespace, address, {
            ownerId: holderA,
            beforeCommit: () => { chmodSync(dirname(address.path), 0o777); return undefined },
        }, () => lifecycleRecord(1, 99))).toMatchObject({ kind: 'refusal' })
        expect(await readFile(address.path)).toEqual(bytes)
    })

    it('does not authenticate lock metadata beneath an unsafe state namespace', async () => {
        const { namespace } = await selectedNamespace()
        await mkdir(namespace.paths.stateLock, { recursive: true })
        await writeFile(join(namespace.paths.stateLock, 'owner.json'), JSON.stringify({
            format: 'cockpit-state/v1', kind: 'state-lock', ownerId: holderA, pid: process.pid,
            acquiredAt: '2026-09-07T12:00:00.000Z', token: crypto.randomUUID(),
        }))
        await chmod(namespace.cockpitRoot, 0o777)
        const observe = vi.fn(async () => 'dead' as const)
        expect(await inspectStateLock(namespace, observe)).toMatchObject({ holderState: 'invalid' })
        expect(observe).not.toHaveBeenCalled()
    })
})


describe('state release permissions', () => {
    it.each(['root', 'lock', 'owner'] as const)('preserves the lock when %s becomes writable by others before release', async (target) => {
        const { namespace, address } = await selectedNamespace()
        const ownerPath = join(namespace.paths.stateLock, 'owner.json')
        let ownerBytes: Buffer | undefined
        const result = await transactState(namespace, address, {
            ownerId: holderA,
            beforeRelease: async () => {
                ownerBytes = await readFile(ownerPath)
                await chmod(target === 'root' ? dirname(namespace.paths.stateLock) : target === 'lock' ? namespace.paths.stateLock : ownerPath, target === 'owner' ? 0o666 : 0o777)
            },
        }, () => lifecycleRecord(0, 7))
        expect(result).toMatchObject({ kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE })
        expect(await readdir(dirname(namespace.paths.stateLock))).toEqual(['state.lock'])
        expect(await readFile(ownerPath)).toEqual(ownerBytes)
    })

    it.each(['owner-unlink', 'tombstone-rmdir', 'backup-unlink'] as const)('preserves owner evidence when release root permissions change before %s', async (checkpoint) => {
        const { namespace, address } = await selectedNamespace()
        const releaseRoot = dirname(namespace.paths.stateLock)
        let ownerBytes: Buffer | undefined
        const result = await transactState(namespace, address, {
            ownerId: holderA,
            beforeRelease: async () => { ownerBytes = await readFile(join(namespace.paths.stateLock, 'owner.json')) },
            beforeLockMetadata: async (stage) => { if (stage === checkpoint) await chmod(releaseRoot, 0o777) },
        }, () => lifecycleRecord(0, 7))
        expect(result).toMatchObject({ kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE })
        const entries = await readdir(releaseRoot)
        const evidencePaths = entries.flatMap((entry) => entry.endsWith('.owner.json') ? [join(releaseRoot, entry)] : [join(releaseRoot, entry, 'owner.json')])
        const evidence = await Promise.all(evidencePaths.map((path) => readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })))
        expect(evidence.some((bytes) => bytes?.equals(ownerBytes!))).toBe(true)
        if (checkpoint === 'tombstone-rmdir') {
            const tombstone = entries.find((entry) => !entry.endsWith('.owner.json'))!
            expect(await readdir(join(releaseRoot, tombstone))).toEqual([])
        }
    })
})
