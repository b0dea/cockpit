import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { acquireClaim } from '../environment/claims.js'
import { checkoutId, cockpitId, holderId, stackId } from '../environment/identity.js'
import { selectStateRoot, transactState } from '../environment/state.js'
import { writeGuardLocalIdentity } from '../guards/local-identity.js'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { observeSiblingGuides } from '../surfaces/projection.js'
import { syncGeneratedEnvironment } from './command.js'
import { forgetGeneratedEnvironment, uninstallGeneratedEnvironment } from './uninstall.js'

const roots: string[] = []
const ledgerPath = '.cockpit/generated-environment-ownership.json'
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const approve = async (request: { digest: string }) => ({ format: 'cockpit-stale-removal-approval/v1' as const, digest: request.digest })

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function consumer() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-removal-')))
    const home = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-removal-state-')))
    roots.push(root, home)
    const configPath = join(root, 'cockpit.toml')
    const source = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
    await writeFile(configPath, source)
    const cockpit = cockpitId({ name: 'generated-environment', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } })
    const ownerId = holderId({ stackId: stack, checkoutId: checkout, sessionId: 'synthetic-removal' })
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: cockpit })
    if (selected.kind !== 'complete') throw new Error('synthetic state namespace unavailable')
    const context = { namespace: selected.value, ownerId }
    const ownedPath = 'generated/leaf.txt'
    const sharedPath = 'notes.md'
    const shared = { kind: 'shared-region' as const, path: sharedPath, harnesses: ['codexcli'] as const, scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const, ownership: 'shared-region' as const,
        regionId: 'synthetic', region: { format: 'markdown-delimited' as const, begin: '<!-- synthetic:begin -->', end: '<!-- synthetic:end -->', bytes: 'owned\n', sha256: digest('owned\n') } }
    const sharedBytes = 'foreign\n' + shared.region.begin + '\nowned\n' + shared.region.end + '\nretained\n'
    const manifestInput = { root, cockpitId: cockpit, configPath, generation: digest('generation'), sourceSha256: digest(source),
        personaSource: { path: 'fixtures/personas.json', sha256: digest('[]') }, owned: [{ path: ownedPath, sha256: digest('owned') }], surfaces: [shared] }
    const ledger = encodeOwnershipManifest(manifestInput)
    await mkdir(join(root, dirname(ownedPath)), { recursive: true })
    await mkdir(join(root, '.cockpit'))
    await writeFile(join(root, ownedPath), 'owned')
    await writeFile(join(root, 'generated/foreign.txt'), 'foreign')
    await writeFile(join(root, sharedPath), sharedBytes)
    await writeFile(join(root, ledgerPath), ledger.bytes)
    return { root, configPath, context, cockpit, checkout, stack, ownerId, ownedPath, sharedPath, sharedBytes, ledger, manifestInput }
}

async function consumerWithGuide() {
    const c = await consumer()
    const guideRoot = join(c.root, 'app')
    const sourcePath = join(guideRoot, 'AGENTS.md')
    await mkdir(guideRoot)
    await writeFile(sourcePath, 'sibling guidance\n')
    const observed = await observeSiblingGuides({ allowedRoots: [guideRoot], requests: [{ slug: 'app', root: guideRoot, sourcePath }] })
    if (observed.kind !== 'complete' || !observed.observations[0]) throw new Error('synthetic guide observation refused')
    const guide = observed.observations[0]
    const link = { kind: 'symlink' as const, path: '.sibling-app-AGENTS.md', harnesses: ['codexcli'] as const, scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const, ownership: 'symlink' as const, target: 'app/AGENTS.md',
        source: { root: guideRoot, path: sourcePath, sha256: guide.contentSha256, identity: guide.contentIdentity } }
    const ledger = encodeOwnershipManifest({ ...c.manifestInput, surfaces: [...c.manifestInput.surfaces, link] })
    await writeFile(join(c.root, ledgerPath), ledger.bytes)
    await symlink(link.target, join(c.root, link.path))
    return { ...c, sourcePath, link, ledger }
}

describe('generated uninstall and forget', () => {
    it('removes only cockpit-owned machine-local guard state during uninstall', async () => {
        const c = await consumer()
        const identity = {
            root: c.root, rootDevice: '1', rootInode: '2', configPath: c.configPath,
            configSha256: digest(await readFile(c.configPath, 'utf8')), configDevice: '3', configInode: '4',
            node: '/synthetic/node', nodeSha256: digest('node'), nodeFingerprint: 'fingerprint',
            module: '/synthetic/cockpit', moduleSha256: digest('module'),
        }
        expect(await writeGuardLocalIdentity(c.root, identity)).toEqual({ kind: 'complete' })
        const preview = await uninstallGeneratedEnvironment({ configPath: c.configPath, dryRun: true }, c.context)
        expect(preview, JSON.stringify(preview)).toMatchObject({ kind: 'complete' })
        expect((await lstat(join(c.root, '.cockpit/local'))).isDirectory()).toBe(true)

        const outcome = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve })
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'complete' })
        await expect(lstat(join(c.root, '.cockpit/local'))).rejects.toMatchObject({ code: 'ENOENT' })

        const planted = await consumer()
        expect(await writeGuardLocalIdentity(planted.root, { ...identity, root: planted.root, configPath: planted.configPath,
            configSha256: digest(await readFile(planted.configPath, 'utf8')) })).toEqual({ kind: 'complete' })
        await writeFile(join(planted.root, '.cockpit/local/foreign'), 'retained')
        const refused = await uninstallGeneratedEnvironment({ configPath: planted.configPath }, planted.context, { authorizeStaleRemoval: approve })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_LOCAL_STATE_CONFLICT' })] })
        expect(await readFile(join(planted.root, planted.ownedPath), 'utf8')).toBe('owned')
        expect(await readFile(join(planted.root, ledgerPath), 'utf8')).toBe(planted.ledger.bytes)
        expect(await readFile(join(planted.root, '.cockpit/local/foreign'), 'utf8')).toBe('retained')

        const redirected = await consumer()
        const local = join(redirected.root, '.cockpit/local')
        const held = `${local}.held`
        expect(await writeGuardLocalIdentity(redirected.root, { ...identity, root: redirected.root, configPath: redirected.configPath,
            configSha256: digest(await readFile(redirected.configPath, 'utf8')) })).toEqual({ kind: 'complete' })
        await rename(local, held)
        await symlink(held, local)
        expect(await uninstallGeneratedEnvironment({ configPath: redirected.configPath }, redirected.context, { authorizeStaleRemoval: approve }))
            .toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_LOCAL_STATE_CONFLICT' })] })
        expect(await readFile(join(held, 'guard-identity'), 'utf8')).toContain('cockpit-guard-local/v1')
        expect(await readFile(join(redirected.root, redirected.ownedPath), 'utf8')).toBe('owned')
    })

    it.each(['symlink', 'fifo', 'oversized'] as const)('refuses a planted %s local identity without reading or removing it', async kind => {
        const c = await consumer()
        const local = join(c.root, '.cockpit/local')
        const identityPath = join(local, 'guard-identity')
        const external = join(c.root, 'external-identity')
        await mkdir(local)
        await writeFile(join(local, '.gitignore'), '# cockpit-owned: machine-local guard identity, written by `cockpit sync`, never committed\n*\n')
        if (kind === 'symlink') {
            await writeFile(external, 'external identity must not be read or removed')
            await symlink(external, identityPath)
        } else if (kind === 'fifo') {
            expect(spawnSync('mkfifo', [identityPath]).status).toBe(0)
        } else {
            await writeFile(identityPath, 'x'.repeat(1_048_577))
        }

        const refused = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_LOCAL_STATE_CONFLICT' })] })
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('owned')
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        const planted = await lstat(identityPath)
        if (kind === 'symlink') {
            expect(planted.isSymbolicLink()).toBe(true)
            expect(await readFile(external, 'utf8')).toBe('external identity must not be read or removed')
        } else if (kind === 'fifo') expect(planted.isFIFO()).toBe(true)
        else expect(planted.size).toBe(1_048_577)
    })

    it('uninstalls exact manifest leaves, preserves foreign bytes and leaves every parent directory', async () => {
        const c = await consumer()
        const input = { configPath: c.configPath }
        const preview = await uninstallGeneratedEnvironment({ ...input, dryRun: true }, c.context)
        expect(preview, JSON.stringify(preview)).toMatchObject({ kind: 'complete', committedPaths: [] })
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('owned')
        const outcome = await uninstallGeneratedEnvironment(input, c.context, { authorizeStaleRemoval: approve })
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'complete', changes: preview.kind === 'complete' ? preview.changes : [] })
        expect(outcome.kind === 'complete' && outcome.committedPaths).toEqual([c.sharedPath, c.ownedPath, ledgerPath])
        await expect(lstat(join(c.root, c.ownedPath))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(c.root, ledgerPath))).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(join(c.root, 'generated'))).isDirectory()).toBe(true)
        expect((await lstat(join(c.root, '.cockpit'))).isDirectory()).toBe(true)
        expect(await readFile(join(c.root, 'generated/foreign.txt'), 'utf8')).toBe('foreign')
        expect(await readFile(join(c.root, c.sharedPath), 'utf8')).toBe('foreign\n\nretained\n')
    })

    it('forgets only the ledger even for modified targets and later sync refuses missing ownership', async () => {
        const c = await consumer()
        await mkdir(join(c.root, 'app'))
        await mkdir(join(c.root, 'fixtures'))
        await writeFile(join(c.root, 'fixtures/personas.json'), '[]')
        await writeFile(join(c.root, 'compose.generated.yml'), 'unregistered output')
        await writeFile(join(c.root, c.ownedPath), 'modified')
        const outcome = await forgetGeneratedEnvironment({ configPath: c.configPath }, c.context)
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'complete', committedPaths: [ledgerPath], changes: [{ operation: 'remove', path: ledgerPath }] })
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('modified')
        expect(await readFile(join(c.root, c.sharedPath), 'utf8')).toBe(c.sharedBytes)
        const later = await syncGeneratedEnvironment({ configPath: c.configPath })
        expect(later).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_OWNERSHIP_MISSING' })] })
    })

    it('removes only an exact sibling symlink with its current observed source identity', async () => {
        const c = await consumerWithGuide()
        const outcome = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve })
        expect(outcome).toMatchObject({ kind: 'complete' })
        await expect(lstat(join(c.root, c.link.path))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(c.sourcePath, 'utf8')).toBe('sibling guidance\n')
        const replaced = await consumerWithGuide()
        await rename(replaced.sourcePath, `${replaced.sourcePath}.held`)
        await writeFile(replaced.sourcePath, 'sibling guidance\n')
        const refused = await uninstallGeneratedEnvironment({ configPath: replaced.configPath }, replaced.context, { authorizeStaleRemoval: approve })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_ARTIFACT_DRIFT' })] })
        expect((await lstat(join(replaced.root, replaced.link.path))).isSymbolicLink()).toBe(true)
        expect(await readFile(join(replaced.root, replaced.ownedPath), 'utf8')).toBe('owned')
        expect(await readFile(join(replaced.root, ledgerPath), 'utf8')).toBe(replaced.ledger.bytes)
    })

    it('refuses modified, replaced and escaping leaves before any uninstall mutation', async () => {
        const c = await consumer()
        await writeFile(join(c.root, c.ownedPath), 'modified')
        const modified = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve })
        expect(modified.kind).toBe('refusal')
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        await writeFile(join(c.root, c.ownedPath), 'owned')
        let confirmed = false
        const replaced = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: async request => {
            confirmed = true
            await rename(join(c.root, c.ownedPath), join(c.root, 'held-leaf.txt'))
            await writeFile(join(c.root, c.ownedPath), 'owned')
            return approve(request)
        } })
        expect(confirmed).toBe(true)
        expect(replaced.kind).toBe('refusal')
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        await rename(join(c.root, 'generated'), join(c.root, 'held-generated'))
        await symlink(join(c.root, 'held-generated'), join(c.root, 'generated'))
        const escaping = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve })
        expect(escaping.kind).toBe('refusal')
        expect(await readFile(join(c.root, 'held-generated/leaf.txt'), 'utf8')).toBe('owned')
        expect(await readFile(join(c.root, c.sharedPath), 'utf8')).toBe(c.sharedBytes)
    })

    it('refuses an old held claim, names its holder and down, and prevents a new claim during removal', async () => {
        const c = await consumer()
        const claimed = await transactState(c.context.namespace, c.context.namespace.paths.coordination(c.stack), { ownerId: c.ownerId }, () => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: c.cockpit, subjectId: c.stack, revision: 0, updatedAt: '2000-01-01T00:00:00.000Z',
            value: { holders: [{ holderId: c.ownerId, checkoutId: c.checkout, claimedAt: '2000-01-01T00:00:00.000Z' }],
                lease: { offset: 0, ports: { WEB: 3000 }, released: false, declaration: { step: 100, count: 3, bases: { WEB: 3000 } } }, lastReleasedHolder: null },
        }))
        expect(claimed.kind).toBe('complete')
        const held = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve })
        expect(held.kind).toBe('refusal')
        if (held.kind === 'refusal') {
            expect(held.diagnostics[0]!.message).toContain(c.ownerId)
            expect(held.diagnostics[0]!.message).toContain('cockpit down')
        }
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
        const idle = await consumer()
        let contention: Awaited<ReturnType<typeof acquireClaim>> | undefined
        const removed = await uninstallGeneratedEnvironment({ configPath: idle.configPath }, idle.context, { authorizeStaleRemoval: async request => {
            contention = await acquireClaim({ namespace: idle.context.namespace, stackId: idle.stack, holder: { holderId: idle.ownerId, checkoutId: idle.checkout },
                now: '2026-10-22T12:00:00.000Z' })
            return approve(request)
        } })
        expect(contention).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'STATE_LOCKED' })] })
        expect(removed, JSON.stringify(removed)).toMatchObject({ kind: 'complete' })
    })

    it('never steals an aged state lock and retains its holder and recovery evidence', async () => {
        const c = await consumer()
        const lock = c.context.namespace.paths.stateLock
        await mkdir(lock, { recursive: true })
        const owner = `${JSON.stringify({ format: 'cockpit-state/v1', kind: 'state-lock', ownerId: c.ownerId,
            pid: process.pid, acquiredAt: '2000-01-01T00:00:00.000Z', token: randomUUID() })}\n`
        await writeFile(join(lock, 'owner.json'), owner)
        const outcome = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context)
        expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'STATE_LOCKED' })] })
        if (outcome.kind === 'refusal') {
            expect(JSON.stringify(outcome.diagnostics)).toContain(c.ownerId)
            expect(JSON.stringify(outcome.diagnostics)).toMatch(/recover|owner|release/)
        }
        expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(owner)
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
    })

    it('rechecks the owner source after publication and compensates every removed leaf and ledger', async () => {
        const c = await consumer()
        let changed = false
        const outcome = await uninstallGeneratedEnvironment({ configPath: c.configPath }, c.context, { authorizeStaleRemoval: approve,
            execute: async step => {
                const result = await executeProbe(step)
                if (!changed && step.labels.action === 'publish-batch') {
                    changed = true
                    await writeFile(c.configPath, (await readFile(c.configPath, 'utf8')) + '\n# changed\n')
                }
                return result
            } })
        expect(changed).toBe(true)
        expect(outcome.kind).toBe('refusal')
        expect(await readFile(join(c.root, c.ownedPath), 'utf8')).toBe('owned')
        expect(await readFile(join(c.root, c.sharedPath), 'utf8')).toBe(c.sharedBytes)
        expect(await readFile(join(c.root, ledgerPath), 'utf8')).toBe(c.ledger.bytes)
    })
})
