import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkoutId, cockpitId, holderId, stackId } from '../environment/identity.js'
import { selectStateRoot, transactState } from '../environment/state.js'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import * as removal from './uninstall.js'
import { forgetGeneratedEnvironment, uninstallGeneratedEnvironment } from './uninstall-command.js'

const roots: string[] = []
const ledgerPath = '.cockpit/generated-environment-ownership.json'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const approve: NonNullable<removal.GeneratedRemovalAdapters['authorizeStaleRemoval']> = async request => ({ format: 'cockpit-stale-removal-approval/v1', digest: request.digest })

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function consumer() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-removal-command-')))
    roots.push(root)
    const source = (await readFile('fixtures/registries/generated-environment.toml', 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, source)
    const cockpit = cockpitId({ name: 'generated-environment', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } })
    const ownerId = holderId({ stackId: stack, checkoutId: checkout, sessionId: 'synthetic-removal' })
    const home = join(root, 'home')
    await mkdir(home)
    const state = await selectStateRoot({ platform: 'linux', home, cockpitId: cockpit })
    if (state.kind !== 'complete') throw new Error('removal command namespace was refused')
    const ownedPath = 'generated/leaf.txt'
    await mkdir(join(root, 'generated'))
    await mkdir(join(root, '.cockpit'))
    await writeFile(join(root, ownedPath), 'owned')
    await writeFile(join(root, 'generated/foreign.txt'), 'foreign')
    const ledger = encodeOwnershipManifest({ root, cockpitId: cockpit, configPath, generation: digest('generation'),
        sourceSha256: digest(source), personaSource: { path: 'fixtures/personas.json', sha256: digest('[]') },
        owned: [{ path: ownedPath, sha256: digest('owned') }], surfaces: [] })
    await writeFile(join(root, ledgerPath), ledger.bytes)
    return { root, configPath, cockpit, checkout, stack, ownerId, ownedPath, ledger, context: { namespace: state.value, ownerId } }
}

describe('public generated removal', () => {
    it('forwards dry-run and exact uninstall to the real owner with identical context and changes', async () => {
        const c = await consumer()
        const owner = vi.spyOn(removal, 'uninstallGeneratedEnvironment')
        const adapters = { authorizeStaleRemoval: approve }
        const previewInput = { configPath: c.configPath, dryRun: true }
        const preview = await uninstallGeneratedEnvironment(previewInput, c.context, adapters)
        expect(owner.mock.calls[0]).toEqual([previewInput, c.context, adapters])
        expect(owner.mock.calls[0]![0]).toBe(previewInput)
        expect(owner.mock.calls[0]![1]).toBe(c.context)
        expect(preview).toBe(await owner.mock.results[0]!.value)
        expect(preview, JSON.stringify(preview)).toMatchObject({ kind: 'complete', committedPaths: [] })
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('owned')
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        const input = { configPath: c.configPath }
        const applied = await uninstallGeneratedEnvironment(input, c.context, adapters)
        expect(owner.mock.calls[1]).toEqual([input, c.context, adapters])
        expect(applied).toBe(await owner.mock.results[1]!.value)
        expect(applied).toMatchObject({ kind: 'complete', changes: preview.kind === 'complete' ? preview.changes : [] })
        await expect(lstat(join(c.root, c.ownedPath))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(c.root, ledgerPath))).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(join(c.root, 'generated'))).isDirectory()).toBe(true)
        expect(await readFile(join(c.root, 'generated/foreign.txt'), 'utf8')).toBe('foreign')
    })

    it('forwards ledger-only forget dry-run and apply while retaining modified targets', async () => {
        const c = await consumer()
        await writeFile(join(c.root, c.ownedPath), 'modified')
        const owner = vi.spyOn(removal, 'forgetGeneratedEnvironment')
        const input = { configPath: c.configPath, dryRun: true }
        const preview = await forgetGeneratedEnvironment(input, c.context)
        expect(owner.mock.calls[0]![0]).toBe(input)
        expect(owner.mock.calls[0]![1]).toBe(c.context)
        expect(preview).toBe(await owner.mock.results[0]!.value)
        expect(preview).toMatchObject({ kind: 'complete', committedPaths: [], changes: [{ operation: 'remove', path: ledgerPath }] })
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        expect(await forgetGeneratedEnvironment({ configPath: c.configPath }, c.context))
            .toMatchObject({ kind: 'complete', committedPaths: [ledgerPath] })
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('modified')
    })

    it('preserves the real held-claim refusal naming stack, holder and down for preview and apply', async () => {
        const c = await consumer()
        const held = await transactState(c.context.namespace, c.context.namespace.paths.coordination(c.stack), { ownerId: c.ownerId }, () => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: c.cockpit, subjectId: c.stack, revision: 0, updatedAt: '2000-01-01T00:00:00.000Z',
            value: { holders: [{ holderId: c.ownerId, checkoutId: c.checkout, claimedAt: '2000-01-01T00:00:00.000Z' }],
                lease: { offset: 0, ports: { WEB: 3000 }, released: false, declaration: { step: 100, count: 3, bases: { WEB: 3000 } } }, lastReleasedHolder: null },
        }))
        expect(held.kind).toBe('complete')
        for (const dryRun of [true, false]) {
            const result = await uninstallGeneratedEnvironment({ configPath: c.configPath, dryRun }, c.context)
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_UNINSTALL_HELD' })] })
            if (result.kind !== 'refusal') throw new Error('held uninstall was not refused')
            expect(result.diagnostics[0]!.message).toContain(c.stack)
            expect(result.diagnostics[0]!.message).toContain(c.ownerId)
            expect(result.diagnostics[0]!.message).toContain('cockpit down')
        }
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('owned')
    })

    it('refuses a same-byte target replacement after confirmation through the real transaction', async () => {
        const c = await consumer()
        const authorize = vi.fn(async (request: Parameters<typeof approve>[0]) => {
            await rename(join(c.root, c.ownedPath), join(c.root, 'held.txt'))
            await writeFile(join(c.root, c.ownedPath), 'owned')
            return approve(request)
        })
        const result = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: authorize })
        expect(authorize).toHaveBeenCalledOnce()
        expect(result).toMatchObject({ kind: 'refusal' })
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('owned')
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
    })
})
