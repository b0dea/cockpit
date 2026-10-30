import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fsPromises from 'node:fs/promises'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { resolveGitExecutable } from '../environment/executable.js'
import { bootstrapHolderId } from '../environment/identity.js'
import { selectBootstrapStateRoot, transactState, type BootstrapStateRecord } from '../environment/state.js'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { stagedPublicationInputs } from '../../test-support/generated-fixtures.js'
import * as ownership from '../surfaces/ownership.js'
import { inspectSkillSet, projectInspectedSkillOutputs } from '../surfaces/skill-contract.js'
import { admitPublicationPlan, authorizePublicationPlan, captureReferenceBootstrap, encodeReferenceManifest, nodeAuthority, referenceBootstrapFiles, relocateAnchoredFile, readPersonaSource, restoreAnchoredFile,
    revalidateReferenceBootstrap, runPublicationPlan } from './transaction.js'

const roots: string[] = []
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const ledgerPath = '.cockpit/generated-environment-ownership.json'
const referenceLedgerPath = '.cockpit/generated-reference-ownership.json'

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('anchored file relocation', () => {
    it('refuses a source replaced by a FIFO before relocation without blocking or creating the destination', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-relocation-race-')))
        roots.push(root)
        const source = 'source/settings.json'
        const destination = 'cockpit/adopted/source/settings.json'
        const sourcePath = join(root, source)
        await mkdir(dirname(sourcePath), { recursive: true })
        const bytes = '{"setting":true}\n'
        await writeFile(sourcePath, bytes)
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')
        let replaced = false
        const started = Date.now()

        const relocated = await relocateAnchoredFile(root, source, destination, 1024, digest(bytes), node, {
            execute: async step => {
                if (!replaced && step.labels.action === 'relocate-file') {
                    replaced = true
                    await rm(sourcePath)
                    execFileSync('mkfifo', [sourcePath])
                }
                return executeProbe(step)
            },
        })

        expect(relocated).toMatchObject({ kind: 'refusal', recovery: 'unchanged', failure: 'source-identity' })
        expect(Date.now() - started).toBeLessThan(3000)
        expect((await lstat(sourcePath)).isFIFO()).toBe(true)
        await expect(lstat(join(root, destination))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('preserves a source replacement made after the original is quarantined', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-relocation-source-replacement-')))
        roots.push(root)
        const source = 'source/settings.json'
        const destination = 'cockpit/adopted/source/settings.json'
        const sourcePath = join(root, source)
        const destinationPath = join(root, destination)
        await mkdir(dirname(sourcePath), { recursive: true })
        const bytes = Buffer.alloc(64 * 1024, 0x61)
        const replacement = 'replacement written at the mutation boundary\n'
        await writeFile(sourcePath, bytes)
        const writer = spawn(process.execPath, ['-e', `
            const fs = require('node:fs')
            const [directory, source, replacement] = process.argv.slice(1)
            const deadline = Date.now() + 10000
            const attempt = () => {
                if (fs.readdirSync(directory).some(name => name.startsWith('.cockpit-adopt-source-'))) {
                    try { fs.writeFileSync(source, replacement, { flag: 'wx' }); return }
                    catch (error) { console.error(error); process.exitCode = 1; return }
                }
                if (Date.now() >= deadline) { console.error('source was not quarantined'); process.exitCode = 2; return }
                setTimeout(attempt, 1)
            }
            attempt()
        `, dirname(sourcePath), sourcePath, replacement], { stdio: ['ignore', 'ignore', 'inherit'] })
        const writerExit = once(writer, 'exit')
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')

        const relocated = await relocateAnchoredFile(root, source, destination, bytes.byteLength, digest(bytes), node, { execute: executeProbe })
        const [writerCode] = await writerExit

        expect(writerCode).toBe(0)
        expect(relocated).toMatchObject({ kind: 'refusal', recovery: 'indeterminate', retainedPaths: [expect.stringContaining('.cockpit-adopt-source-')] })
        expect(await readFile(sourcePath, 'utf8')).toBe(replacement)
        const captures = (await readdir(dirname(sourcePath))).filter(name => name.startsWith('.cockpit-adopt-source-'))
        expect(captures).toHaveLength(1)
        expect(await readFile(join(dirname(sourcePath), captures[0]!))).toEqual(bytes)
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('keeps an unexpected destination replacement made after the destination link', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-relocation-destination-replacement-')))
        roots.push(root)
        const source = 'source/settings.json'
        const destination = 'cockpit/adopted/source/settings.json'
        const sourcePath = join(root, source)
        const destinationPath = join(root, destination)
        const displacedPath = join(root, 'displaced-open-destination')
        await mkdir(dirname(sourcePath), { recursive: true })
        const bytes = Buffer.alloc(8 * 1024 * 1024, 0x62)
        const replacement = 'unexpected destination replacement\n'
        await writeFile(sourcePath, bytes)
        const writer = spawn(process.execPath, ['-e', `
            const fs = require('node:fs')
            const [destination, displaced, replacement] = process.argv.slice(1)
            const deadline = Date.now() + 10000
            const attempt = () => {
                if (fs.existsSync(destination)) {
                    try {
                        fs.renameSync(destination, displaced)
                        fs.writeFileSync(destination, replacement, { flag: 'wx' })
                        return
                    } catch (error) { console.error(error); process.exitCode = 1; return }
                }
                if (Date.now() >= deadline) { console.error('destination was not created'); process.exitCode = 2; return }
                setTimeout(attempt, 1)
            }
            attempt()
        `, destinationPath, displacedPath, replacement], { stdio: ['ignore', 'ignore', 'inherit'] })
        const writerExit = once(writer, 'exit')
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')

        const relocated = await relocateAnchoredFile(root, source, destination, bytes.byteLength, digest(bytes), node, { execute: executeProbe })
        const [writerCode] = await writerExit

        expect(writerCode).toBe(0)
        expect(relocated).toMatchObject({ kind: 'refusal', recovery: 'indeterminate' })
        expect(await readFile(sourcePath)).toEqual(bytes)
        expect(await readFile(destinationPath, 'utf8')).toBe(replacement)
        expect(await readFile(displacedPath)).toEqual(bytes)
    })

    it('preserves a destination replacement made between link and first identity observation', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-relocation-link-observation-race-')))
        roots.push(root)
        const source = 'source/settings.json'
        const destination = 'cockpit/adopted/source/settings.json'
        const sourcePath = join(root, source)
        const destinationPath = join(root, destination)
        const displacedPath = join(root, 'displaced-linked-destination')
        const preloadPath = join(root, 'replace-before-observation.cjs')
        await mkdir(dirname(sourcePath), { recursive: true })
        const bytes = Buffer.from('{"setting":true}\n')
        const replacement = 'replacement before identity observation\n'
        await writeFile(sourcePath, bytes)
        await writeFile(preloadPath, `
            const fs = require('node:fs')
            const path = require('node:path')
            const request = JSON.parse(process.argv[2])
            if (request.action === 'relocate-file') {
                const original = fs.lstatSync
                let destinationChecks = 0
                fs.lstatSync = (target, ...rest) => {
                    const inDestination = process.cwd().endsWith(path.join(...request.destination.segments))
                    if (inDestination && target === request.destination.name && ++destinationChecks === 2) {
                        fs.renameSync(target, ${JSON.stringify(displacedPath)})
                        fs.writeFileSync(target, ${JSON.stringify(replacement)}, { flag: 'wx' })
                    }
                    return original(target, ...rest)
                }
            }
        `)
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')
        let injected = false

        const relocated = await relocateAnchoredFile(root, source, destination, bytes.byteLength, digest(bytes), node, {
            execute: step => {
                if (step.labels.action !== 'relocate-file') return executeProbe(step)
                injected = true
                return executeProbe({ ...step, env: { ...step.env, NODE_OPTIONS: `--require=${preloadPath}` } })
            },
        })

        expect(injected).toBe(true)
        expect(relocated).toMatchObject({ kind: 'refusal', recovery: 'indeterminate' })
        expect(await readFile(sourcePath)).toEqual(bytes)
        expect(await readFile(destinationPath, 'utf8')).toBe(replacement)
        expect((await readdir(dirname(destinationPath))).filter(name => name.startsWith('.cockpit-adopt-destination-'))).toEqual([])
        expect(await readFile(displacedPath)).toEqual(bytes)
    })

    it('retains exact recovery links when destination cleanup fails after linking', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-relocation-post-link-fault-')))
        roots.push(root)
        const source = 'source/settings.json'
        const destination = 'cockpit/adopted/source/settings.json'
        const sourcePath = join(root, source)
        const destinationPath = join(root, destination)
        const preloadPath = join(root, 'post-link-fault.cjs')
        await mkdir(dirname(sourcePath), { recursive: true })
        const bytes = Buffer.alloc(256 * 1024, 0x63)
        await writeFile(sourcePath, bytes)
        await chmod(sourcePath, 0o640)
        const sourceMode = (await lstat(sourcePath)).mode & 0o777
        await writeFile(preloadPath, `
            const fs = require('node:fs')
            const path = require('node:path')
            const request = JSON.parse(process.argv[2])
            if (request.action === 'relocate-file') {
                const originalLstat = fs.lstatSync
                const originalUnlink = fs.unlinkSync
                let destinationChecks = 0
                fs.lstatSync = (target, ...rest) => {
                    const inDestination = process.cwd().endsWith(path.join(...request.destination.segments))
                    if (inDestination && target === request.destination.name && ++destinationChecks === 2) {
                        throw Object.assign(new Error('synthetic post-link observation failure'), { code: 'EIO' })
                    }
                    return originalLstat(target, ...rest)
                }
                fs.unlinkSync = (target, ...rest) => {
                    if (typeof target === 'string' && target.startsWith('.cockpit-adopt-destination-')) {
                        throw Object.assign(new Error('synthetic destination capture cleanup failure'), { code: 'EIO' })
                    }
                    return originalUnlink(target, ...rest)
                }
            }
        `)
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')
        let injected = false

        const relocated = await relocateAnchoredFile(root, source, destination, bytes.byteLength, digest(bytes), node, {
            execute: step => {
                if (step.labels.action !== 'relocate-file') return executeProbe(step)
                injected = true
                // The changed environment intentionally makes the receipt unauthenticated to the caller;
                // filesystem assertions below verify the helper's recovery at the injected system boundary.
                return executeProbe({ ...step, env: { ...step.env, NODE_OPTIONS: `--require=${preloadPath}` } })
            },
        })

        expect(injected).toBe(true)
        expect(relocated).toMatchObject({ kind: 'refusal', recovery: 'indeterminate', failure: 'filesystem-helper-receipt-unavailable' })
        expect(await readFile(sourcePath)).toEqual(bytes)
        expect((await lstat(sourcePath)).mode & 0o777).toBe(sourceMode)
        const sourceCaptures = (await readdir(dirname(sourcePath))).filter(name => name.startsWith('.cockpit-adopt-source-'))
        expect(sourceCaptures).toHaveLength(1)
        expect(await readFile(join(dirname(sourcePath), sourceCaptures[0]!))).toEqual(bytes)
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
        const destinationCaptures = (await readdir(dirname(destinationPath))).filter(name => name.startsWith('.cockpit-adopt-destination-'))
        expect(destinationCaptures).toHaveLength(1)
        expect(await readFile(join(dirname(destinationPath), destinationCaptures[0]!))).toEqual(bytes)
        expect(relocated.kind === 'refusal' && relocated.retainedPaths).toEqual(expect.arrayContaining([
            join('source', sourceCaptures[0]!), join('cockpit/adopted/source', destinationCaptures[0]!),
        ]))
    })

    it('keeps writes through an already-open source descriptor at an authenticated name', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-relocation-open-writer-')))
        roots.push(root)
        const source = 'source/settings.json'
        const destination = 'cockpit/adopted/source/settings.json'
        const sourcePath = join(root, source)
        const destinationPath = join(root, destination)
        await mkdir(dirname(sourcePath), { recursive: true })
        const bytes = Buffer.alloc(64 * 1024, 0x64)
        await writeFile(sourcePath, bytes)
        await chmod(sourcePath, 0o640)
        const original = await lstat(sourcePath)
        const writer = await open(sourcePath, 'r+')
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')
        const updatedByte = Buffer.from([0x65])

        const relocated = await relocateAnchoredFile(root, source, destination, bytes.byteLength, digest(bytes), node, { execute: executeProbe })
        expect(relocated).toMatchObject({ kind: 'complete' })
        await writer.write(updatedByte, 0, 1, bytes.byteLength - 1)
        await writer.sync()
        await writer.close()

        await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
        const destinationStatus = await lstat(destinationPath)
        expect({ dev: destinationStatus.dev, ino: destinationStatus.ino }).toEqual({ dev: original.dev, ino: original.ino })
        expect(destinationStatus.mode & 0o777).toBe(0o640)
        expect((await readFile(destinationPath)).at(-1)).toBe(updatedByte[0])
    })
})

async function bootstrapPublication() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-setup-publication-')))
    roots.push(root)
    const assetRoot = new URL('../../surfaces/', import.meta.url)
    const assets = [
        'skills/collection.json', 'skills/cockpit-setup.skill.md', 'skills/cockpit-explain.skill.md',
        'skills/cockpit-fix.skill.md', 'skills/cockpit-work.skill.md', 'skills/procedures/onboarding.md',
    ] as const
    const bytes = new Map(await Promise.all(assets.map(async path => [path, await readFile(new URL(path, assetRoot), 'utf8')] as const)))
    const terminal = bytes.get('skills/procedures/onboarding.md')!
    const sources = [
        ['skills/cockpit-setup/SKILL.md', bytes.get('skills/cockpit-setup.skill.md')!],
        ['skills/cockpit-setup/procedures/onboarding.md', terminal],
        ['skills/cockpit-explain/SKILL.md', bytes.get('skills/cockpit-explain.skill.md')!],
        ['skills/cockpit-explain/procedures/onboarding.md', terminal],
        ['skills/cockpit-fix/SKILL.md', bytes.get('skills/cockpit-fix.skill.md')!],
        ['skills/cockpit-fix/procedures/onboarding.md', terminal],
        ['skills/cockpit-work/SKILL.md', bytes.get('skills/cockpit-work.skill.md')!],
        ['skills/cockpit-work/procedures/onboarding.md', terminal],
    ].map(([path, body]) => ({ path, bytes: body }))
    const collectionBytes = bytes.get('skills/collection.json')!
    const inspected = await inspectSkillSet({ sources, collection: { path: 'skills/collection.json', bytes: collectionBytes, sha256: digest(collectionBytes) },
        terminal: { path: 'skills/procedures/onboarding.md', bytes: terminal, sha256: digest(terminal) } })
    if (inspected.kind !== 'complete') throw new Error(JSON.stringify(inspected))
    const projection = projectInspectedSkillOutputs(inspected, 'codexcli', 'cockpit-setup')
    if (projection.kind !== 'complete') throw new Error(JSON.stringify(projection))
    const desired = projection.files.map(file => ({ kind: 'file' as const, path: file.path, harnesses: ['codexcli'] as ['codexcli'],
        scope: 'always' as const, capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const,
        ownership: 'whole-file' as const, bytes: file.bytes, sha256: file.sha256 }))
    const rootStatus = await lstat(root)
    const node = await nodeAuthority()
    if (!node) throw new Error('Node authority unavailable')
    return { root, desired, inspected: projection, node, rootIdentity: { dev: rootStatus.dev, ino: rootStatus.ino } }
}

describe('bootstrap publication', () => {
    it('publishes one complete selected target without an ownership manifest and reruns idempotently', async () => {
        const fixture = await bootstrapPublication()
        const mutations = fixture.desired.map(row => ({ path: row.path, phase: 'desired' as const, operation: 'write-file' as const,
            bytes: row.bytes, sha256: row.sha256, expected: { kind: 'missing' as const } }))
        const admitted = await admitPublicationPlan({ mode: 'bootstrap', root: fixture.root, inspected: fixture.inspected, node: fixture.node,
            rootIdentity: fixture.rootIdentity, mutations }, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete', plan: { changes: fixture.desired.map(row => ({ operation: 'write', path: row.path })) } })
        if (admitted.kind !== 'complete') return
        await expect(runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true }))
            .resolves.toMatchObject({ kind: 'complete', committedPaths: fixture.desired.map(row => row.path) })
        await expect(readFile(join(fixture.root, ledgerPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await Promise.all(fixture.desired.map(row => readFile(join(fixture.root, row.path), 'utf8')))).toEqual(fixture.desired.map(row => row.bytes))

        const rerun = await admitPublicationPlan({ mode: 'bootstrap', root: fixture.root, inspected: fixture.inspected, node: fixture.node,
            rootIdentity: fixture.rootIdentity, mutations: [] }, { execute: executeProbe })
        expect(rerun).toMatchObject({ kind: 'complete', plan: { changes: [] } })
        if (rerun.kind !== 'complete') return
        await expect(runPublicationPlan(rerun.plan, { execute: executeProbe, revalidate: async () => true }))
            .resolves.toEqual({ kind: 'complete', changes: [], committedPaths: [] })
    }, 120_000)

    it('refuses copied inspection identity and an incomplete selected-target output set', async () => {
        const fixture = await bootstrapPublication()
        await expect(admitPublicationPlan({ mode: 'bootstrap', root: fixture.root, inspected: { ...fixture.inspected },
            node: fixture.node, rootIdentity: fixture.rootIdentity, mutations: [] }, { execute: executeProbe })).resolves.toMatchObject({ kind: 'refusal' })
        const incomplete = fixture.desired.slice(0, 2).map(row => ({ path: row.path, phase: 'desired' as const, operation: 'write-file' as const,
            bytes: row.bytes, sha256: row.sha256, expected: { kind: 'missing' as const } }))
        await expect(admitPublicationPlan({ mode: 'bootstrap', root: fixture.root, inspected: fixture.inspected,
            node: fixture.node, rootIdentity: fixture.rootIdentity, mutations: incomplete }, { execute: executeProbe })).resolves.toMatchObject({ kind: 'refusal' })
    }, 120_000)

    it('replaces exact prior bootstrap bytes only with a matching durable surface publication', async () => {
        const fixture = await bootstrapPublication()
        const prior = fixture.desired.map(row => ({ path: row.path, bytes: `${row.bytes}\nPrior bootstrap bytes.\n` }))
        for (const row of prior) {
            await mkdir(dirname(join(fixture.root, row.path)), { recursive: true })
            await writeFile(join(fixture.root, row.path), row.bytes)
        }
        const mutations = await Promise.all(fixture.desired.map(async (row, index) => {
            const status = await lstat(join(fixture.root, row.path))
            return { path: row.path, phase: 'desired' as const, operation: 'write-file' as const,
                bytes: row.bytes, sha256: row.sha256, expected: { kind: 'file' as const,
                    sha256: digest(prior[index]!.bytes), identity: { dev: status.dev, ino: status.ino } } }
        }))
        const input = { mode: 'bootstrap' as const, root: fixture.root, inspected: fixture.inspected, node: fixture.node,
            rootIdentity: fixture.rootIdentity, mutations }
        await expect(admitPublicationPlan(input, { execute: executeProbe })).resolves.toMatchObject({ kind: 'refusal' })

        const stateHome = await mkdtemp(join(tmpdir(), 'cockpit-bootstrap-transaction-state-'))
        roots.push(stateHome)
        const selected = await selectBootstrapStateRoot({ platform: 'linux', home: stateHome,
            checkoutRoot: fixture.root, target: fixture.inspected.target })
        if (selected.kind !== 'complete') throw new Error('bootstrap state selection was refused')
        const address = selected.value.paths.bootstrap(fixture.inspected.target)
        const published = prior.map(row => ({ path: row.path, sha256: digest(row.bytes) }))
        const sources = [{ path: 'synthetic', sha256: digest('synthetic') }]
        const commandSha256 = digest('cockpit init')
        const previewSha256 = digest(JSON.stringify({ target: fixture.inspected.target, sources, files: published }))
        const record: BootstrapStateRecord = { format: 'cockpit-state/v1', kind: 'bootstrap', checkoutId: address.checkoutId,
            target: fixture.inspected.target, revision: 0, updatedAt: '2026-10-25T12:00:00.000Z', value: {
                stage: 'surface-published', checkoutRoot: fixture.root, target: fixture.inspected.target,
                sources, commandSha256, previewSha256, published, destination: null, artifactBytes: null, artifactSha256: null,
            } }
        const persisted = await transactState(selected.value, address, {
            ownerId: bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'bootstrap-refresh' }),
        }, () => record)
        if (persisted.kind !== 'complete') throw new Error('bootstrap state publication was refused')
        const admitted = await admitPublicationPlan({ ...input, refresh: { address, revision: persisted.value.revision,
            commandSha256 } }, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete', plan: {
            changes: fixture.desired.map(row => ({ operation: 'write', path: row.path })),
        } })
    })
})

async function publication() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-transaction-')))
    roots.push(root)
    const authority = { root, cockpitId: 'synthetic-publication', configPath: join(root, 'cockpit.toml') }
    const sourceSha256 = digest('source')
    const generation = digest('generation')
    const shared = { kind: 'shared-region' as const, path: 'z-shared.md', harnesses: ['codexcli'] as const, scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const, ownership: 'shared-region' as const,
        regionId: 'synthetic', region: { format: 'markdown-delimited' as const, begin: '<!-- synthetic:begin -->', end: '<!-- synthetic:end -->',
            bytes: 'owned\n', sha256: digest('owned\n') } }
    const before = 'foreign\n' + shared.region.begin + '\n' + shared.region.bytes + shared.region.end + '\nretained\n'
    const postimage = 'foreign\n\nretained\n'
    const common = { ...authority, generation, sourceSha256, personaSource: { path: 'source.json', sha256: sourceSha256 } }
    const prior = encodeOwnershipManifest({ ...common, owned: [{ path: 'a-stale.txt', sha256: digest('old') }], surfaces: [shared] })
    await mkdir(join(root, '.cockpit'))
    await writeFile(join(root, ledgerPath), prior.bytes)
    await writeFile(join(root, 'a-stale.txt'), 'old')
    await writeFile(join(root, shared.path), before)
    const next = encodeOwnershipManifest({ ...common, owned: [{ path: 'nested/new.txt', sha256: digest('new') }], surfaces: [] })
    const expected = async (path: string, bytes: string) => {
        const status = await lstat(join(root, path))
        return { kind: 'file' as const, sha256: digest(bytes), identity: { dev: status.dev, ino: status.ino } }
    }
    const status = await lstat(root)
    const node = await nodeAuthority()
    if (!node) throw new Error('Node authority unavailable')
    const input = { authority, generation, sourceSha256, rootIdentity: { dev: status.dev, ino: status.ino }, node,
        mode: 'sync' as const, ledgerExpected: await expected(ledgerPath, prior.bytes), nextLedgerBytes: next.bytes,
        mutations: [
            { path: 'nested/new.txt', phase: 'desired' as const, operation: 'write-file' as const, bytes: 'new', sha256: digest('new'), expected: { kind: 'missing' as const } },
            { path: 'a-stale.txt', phase: 'stale' as const, operation: 'remove-file' as const, expected: await expected('a-stale.txt', 'old') },
            { path: shared.path, phase: 'stale' as const, operation: 'write-file' as const, bytes: postimage, sha256: digest(postimage), expected: await expected(shared.path, before) },
        ] }
    return { root, input, prior, before, postimage, common, shared }
}

async function unchangedPublication() {
    const fixture = await publication()
    const admitted = await admitPublicationPlan({ ...fixture.input, nextLedgerBytes: fixture.prior.bytes, mutations: [] }, { execute: executeProbe })
    expect(admitted).toMatchObject({ kind: 'complete', plan: { changes: [] } })
    if (admitted.kind !== 'complete') throw new Error('Unchanged publication refused')
    return { ...fixture, plan: admitted.plan }
}

async function smallFilePublication() {
    const fixture = await publication()
    const owned = Array.from({ length: 66 }, (_, index) => ({ path: `owned-${String(index).padStart(2, '0')}.txt`, bytes: `owned ${index}\n` }))
    for (const row of owned) await writeFile(join(fixture.root, row.path), row.bytes)
    const ledger = encodeOwnershipManifest({ ...fixture.common,
        owned: owned.map(row => ({ path: row.path, sha256: digest(row.bytes) })), surfaces: [] })
    await writeFile(join(fixture.root, ledgerPath), ledger.bytes)
    const { dev, ino } = await lstat(join(fixture.root, ledgerPath))
    return { ...fixture, owned, ledger, input: { ...fixture.input, nextLedgerBytes: ledger.bytes, mutations: [],
        ledgerExpected: { kind: 'file' as const, sha256: digest(ledger.bytes), identity: { dev, ino } } } }
}

async function compactPublication(options: { count?: number; segmentLength?: number; preexisting?: boolean; paths?: readonly string[] } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-compact-transaction-')))
    roots.push(root)
    await mkdir(join(root, '.cursor'))
    const authority = { root, cockpitId: 'synthetic-publication', configPath: join(root, 'cockpit.toml') }
    const sourceSha256 = digest('compact-source')
    const generation = digest('compact-generation')
    const files = Array.from({ length: options.paths?.length ?? options.count ?? 61 }, (_, index) => ({
        path: options.paths?.[index] ?? `.cursor/${(`skill-${String(index).padStart(3, '0')}`).padEnd(options.segmentLength ?? 9, 'x')}/SKILL.md`, bytes: `skill ${index}\n`,
    }))
    if (options.preexisting) await Promise.all(files.map(file => mkdir(dirname(join(root, file.path)), { recursive: true })))
    const ledger = encodeOwnershipManifest({ ...authority, generation, sourceSha256,
        personaSource: { path: 'source.json', sha256: sourceSha256 },
        owned: files.map(file => ({ path: file.path, sha256: digest(file.bytes) })), surfaces: [] })
    const status = await lstat(root)
    const node = await nodeAuthority()
    if (!node) throw new Error('Node authority unavailable')
    return { root, files, input: {
        authority, generation, sourceSha256, rootIdentity: { dev: status.dev, ino: status.ino }, node,
        mode: 'sync' as const, ledgerExpected: { kind: 'missing' as const }, nextLedgerBytes: ledger.bytes,
        mutations: files.map(file => ({ path: file.path, phase: 'desired' as const, operation: 'write-file' as const,
            bytes: file.bytes, sha256: digest(file.bytes), expected: { kind: 'missing' as const }, compactAnchor: '.cursor' })),
    } }
}

describe('portable publication names', () => {
    it('preserves native source names while publishing a portable destination', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-publication-source-')))
        roots.push(root)
        const source = 'source:store/CON.txt'
        const destination = 'adopted/source.txt'
        const bytes = 'synthetic source\n'
        await mkdir(dirname(join(root, source)), { recursive: true })
        await writeFile(join(root, source), bytes)
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')
        const read = await readPersonaSource(root, source, node, { execute: executeProbe })
        expect(read?.bytes.toString()).toBe(bytes)
        await expect(relocateAnchoredFile(root, source, destination, 1024, digest(bytes), node, { execute: executeProbe }))
            .resolves.toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, destination), 'utf8')).toBe(bytes)
        await expect(lstat(join(root, source))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(restoreAnchoredFile(root, source, destination, 1024, digest(bytes), node, { execute: executeProbe }))
            .resolves.toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, source), 'utf8')).toBe(bytes)
        await expect(lstat(join(root, destination))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses nonportable authored names before creating any output', async () => {
        const outcomes: Array<{ segment: string; kind: string }> = []
        for (const segment of ['CON', 'aux.txt', 'NUL.md', 'COM¹.txt', 'LPT²', 'settings:stream', 'trailing.', 'trailing ', 'quote"name', 'left<name', 'pipe|name', '.gıt', 'node_moduleſ']) {
            const fixture = await compactPublication({ paths: [`.cursor/${segment}/SKILL.md`] })
            const admitted = await admitPublicationPlan(fixture.input, { execute: executeProbe })
            outcomes.push({ segment, kind: admitted.kind })
            expect(await readdir(join(fixture.root, '.cursor')), segment).toEqual([])
            await expect(lstat(join(fixture.root, ledgerPath))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        expect(outcomes).toEqual(outcomes.map(({ segment }) => ({ segment, kind: 'refusal' })))
    }, 120_000)

    it('publishes an output under internal/ and refuses one under a case-folded .git', async () => {
        const allowed = await compactPublication({ paths: ['internal/notes.md'] })
        const admitted = await admitPublicationPlan(allowed.input, { execute: executeProbe })
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') return
        expect(await runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true }))
            .toMatchObject({ kind: 'complete' })
        expect(await readFile(join(allowed.root, 'internal/notes.md'), 'utf8')).toBe(allowed.files[0]!.bytes)

        // The ownership encoder already refuses to record such a path, so the write names it directly.
        const reserved = await compactPublication({ paths: ['notes.md'] })
        const input = { ...reserved.input, mutations: [{ ...reserved.input.mutations[0]!, path: '.GIT/x' }] }
        expect(await admitPublicationPlan(input, { execute: executeProbe })).toMatchObject({ kind: 'refusal', diagnostics: [
            expect.objectContaining({ message: 'publication contains an undeclared or non-exact operation' }),
        ] })
        await expect(lstat(join(reserved.root, '.GIT'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses normalized and case-folded directory aliases while preserving distinct dotted outputs', async () => {
        for (const paths of [
            ['.cursor/Skills/one.md', '.cursor/skills/two.md'],
            ['.cursor/Σ/one.md', '.cursor/ς/two.md'],
            ['.cursor/café/one.md', '.cursor/cafe\u0301/two.md'],
        ]) {
            const fixture = await compactPublication({ paths })
            await expect(admitPublicationPlan(fixture.input, { execute: executeProbe })).resolves.toMatchObject({ kind: 'refusal' })
            expect(await readdir(join(fixture.root, '.cursor'))).toEqual([])
        }
        const control = await compactPublication({ paths: ['.cursor/skills.v2/one.test.md', '.cursor/skills.v2/two.md'] })
        const admitted = await admitPublicationPlan(control.input, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') throw new Error('valid dotted publication was refused')
        await expect(runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true })).resolves.toMatchObject({ kind: 'complete' })
        for (const file of control.files) expect(await readFile(join(control.root, file.path), 'utf8')).toBe(file.bytes)
    }, 120_000)

    it('publishes a 255-byte component and refuses 256 bytes through portable admission', async () => {
        const maximum = `${'é'.repeat(127)}a`
        const overlong = 'é'.repeat(128)
        expect(Buffer.byteLength(maximum)).toBe(255)
        expect(Buffer.byteLength(overlong)).toBe(256)

        const accepted = await compactPublication({ paths: [`.cursor/portable/${maximum}`], preexisting: true })
        const admitted = await admitPublicationPlan(accepted.input, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') throw new Error('maximum portable publication was refused')
        await expect(runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true }))
            .resolves.toMatchObject({ kind: 'complete' })
        expect(await readFile(join(accepted.root, accepted.files[0]!.path), 'utf8')).toBe(accepted.files[0]!.bytes)

        const refused = await compactPublication({ paths: [`.cursor/portable/${overlong}`], preexisting: true })
        await expect(admitPublicationPlan(refused.input, { execute: executeProbe })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [expect.objectContaining({
                code: 'GENERATED_PUBLICATION_FAILED', message: expect.stringContaining('cannot be transferred'),
            })],
        })
        expect(await readdir(join(refused.root, '.cursor', 'portable'))).toEqual([])
        await expect(lstat(join(refused.root, ledgerPath))).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)
})

async function referencePublication() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-reference-transaction-')))
    roots.push(root)
    const packageBytes = '{"name":"synthetic-reference-root","private":true}\n'
    const before = '# Troubleshooting\n\nforeign prefix\n<!-- cockpit:diagnostic-index:begin -->\nold\n<!-- cockpit:diagnostic-index:end -->\nforeign suffix\n'
    const region = 'new diagnostic index\n'
    const postimage = before.replace('old\n', region)
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'package.json'), packageBytes)
    await writeFile(join(root, 'docs/troubleshooting.md'), before)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '--', 'package.json', 'docs/troubleshooting.md'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic fixture'], { cwd: root })
    const resolved = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
    if (resolved.state !== 'available') throw new Error('Git unavailable for reference transaction fixture')
    const captured = await captureReferenceBootstrap(root, resolved.value, { execute: executeProbe })
    if (captured.kind !== 'complete') throw new Error(JSON.stringify(captured))
    const files = referenceBootstrapFiles(captured.bootstrap)
    if (!files?.some(row => row.path === 'docs/troubleshooting.md')) throw new Error('fixed bootstrap did not return troubleshooting')
    const outputs = [
        ['docs/cli-reference.md', 'cli\n'],
        ['docs/configuration-reference.md', 'configuration\n'],
        ['docs/command-list.md', 'commands\n'],
        ['docs/capability-matrix.md', 'capabilities\n'],
        ['skills/adopt-cockpit/SKILL.md', 'skill\n'],
    ] as const
    const sourceSha256 = digest(packageBytes)
    const generation = digest('reference-generation')
    const encoded = encodeReferenceManifest({ generation, sourceSha256,
        files: outputs.map(([path, bytes]) => ({ path, sha256: digest(bytes) })), troubleshootingSha256: digest(region) })
    const status = await lstat(root)
    const trouble = await lstat(join(root, 'docs/troubleshooting.md'))
    const node = await nodeAuthority()
    if (!node) throw new Error('Node authority unavailable')
    const input = {
        authority: { root, cockpitId: 'maintainer-references', configPath: join(root, 'package.json') }, generation, sourceSha256,
        rootIdentity: { dev: status.dev, ino: status.ino }, node, mode: 'reference' as const,
        ledgerExpected: { kind: 'missing' as const }, nextLedgerBytes: encoded.bytes, referenceBootstrap: captured.bootstrap,
        references: [
            ...outputs.map(([path, bytes]) => ({ kind: 'file' as const, path, sha256: digest(bytes) })),
            { kind: 'markdown-region' as const, path: 'docs/troubleshooting.md' as const,
                begin: '<!-- cockpit:diagnostic-index:begin -->' as const, end: '<!-- cockpit:diagnostic-index:end -->' as const,
                preimageSha256: digest(before), regionSha256: digest(region), postimageSha256: digest(postimage) },
        ],
        mutations: [
            ...outputs.map(([path, bytes]) => ({ path, phase: 'desired' as const, operation: 'write-file' as const,
                bytes, sha256: digest(bytes), expected: { kind: 'missing' as const } })),
            { path: 'docs/troubleshooting.md', phase: 'desired' as const, operation: 'write-file' as const, bytes: postimage,
                sha256: digest(postimage), expected: { kind: 'file' as const, sha256: digest(before), identity: { dev: trouble.dev, ino: trouble.ino } } },
        ],
    }
    return { root, input, bootstrap: captured.bootstrap, before, postimage }
}

async function syntheticBootstrap(variant: 'sha256' | 'unsupported-format' | 'nonblob' | 'oversize' | 'malformed' | 'duplicate' | 'nonzero-stage' | 'unsupported-mode' | 'different-blob' | 'two-rows' | 'leading-nul' | 'interior-nul' | 'trailing-nul' | 'missing-nul' | 'empty-stream') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-reference-git-boundary-')))
    roots.push(root)
    const bytes = Buffer.from('tracked troubleshooting\n')
    const objectFormat = variant === 'unsupported-format' ? 'md5' : 'sha256'
    const oid = createHash('sha256').update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest('hex')
    const head = 'a'.repeat(64)
    const validRow = `100644 ${oid} 0\tdocs/troubleshooting.md\0`
    const secondRow = `100644 ${oid} 0\tdocs/cli-reference.md\0`
    const rows = variant === 'malformed' ? `not-an-index-row\0`
        : variant === 'duplicate' ? validRow + validRow
            : variant === 'nonzero-stage' ? `100644 ${oid} 2\tdocs/troubleshooting.md\0`
                : variant === 'unsupported-mode' ? `120000 ${oid} 0\tdocs/troubleshooting.md\0`
                    : variant === 'leading-nul' ? '\0' + validRow
                        : variant === 'interior-nul' ? validRow + '\0' + secondRow
                            : variant === 'trailing-nul' ? validRow + '\0'
                                : variant === 'missing-nul' ? validRow.slice(0, -1)
                                    : variant === 'empty-stream' ? ''
                                        : variant === 'two-rows' ? validRow + secondRow : validRow
    const listingPath = join(root, 'committed-tree-rows')
    await writeFile(listingPath, rows.replace(/(100644|100755) ([a-f0-9]+) 0\t/g, '$1 blob $2\t'))
    const script = `#!${process.execPath}\n` +
        `const args=process.argv.slice(2);const out=value=>process.stdout.write(value);` +
        `if(args[0]==='rev-parse'&&args[1]==='--show-object-format')out(${JSON.stringify(objectFormat + '\n')});` +
        `else if(args[0]==='rev-parse')out(${JSON.stringify(head + '\n')});` +
        `else if(args[0]==='ls-tree')out(require('node:fs').readFileSync(${JSON.stringify(listingPath)}));` +
        `else if(args[0]==='cat-file'){` +
        (variant === 'nonblob' ? `process.stderr.write('not a blob');process.exitCode=1;`
            : variant === 'oversize' ? `out(Buffer.alloc(16777217,97));`
                : `out(Buffer.from(${JSON.stringify(Buffer.from(variant === 'different-blob' ? 'different\n' : bytes).toString('base64'))},'base64'));`) +
        `}else{process.stderr.write('unexpected argv');process.exitCode=1;}\n`
    const executable = join(root, 'git')
    await writeFile(executable, script)
    await chmod(executable, 0o755)
    const resolved = await resolveGitExecutable({ PATH: root })
    if (resolved.state !== 'available') throw new Error(`synthetic Git unavailable: ${resolved.reason}`)
    return { result: await captureReferenceBootstrap(root, resolved.value, { execute: executeProbe }), bytes, listingPath, validRow, secondRow }
}

const approve = async (request: { digest: string }) => ({ format: 'cockpit-stale-removal-approval/v1' as const, digest: request.digest })

describe('generated publication transaction', () => {
    it('refuses a compact cluster whose longer pre-existing-directory receipts exceed the frame bound', async () => {
        const nearLimit = await compactPublication({ count: 144, segmentLength: 12, preexisting: true })
        const admitted = await admitPublicationPlan(nearLimit.input, { execute: executeProbe })

        expect(admitted).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'GENERATED_PUBLICATION_FAILED',
            message: 'generated publication exceeds the bounded helper schedule',
        })] })
        await Promise.all(nearLimit.files.map(file => expect(lstat(join(nearLimit.root, file.path))).rejects.toMatchObject({ code: 'ENOENT' })))
    })

    it('publishes more than sixty bounded parents as one compact helper unit and refuses a partial rollback', async () => {
        const successful = await compactPublication()
        const admitted = await admitPublicationPlan(successful.input, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') return
        expect(await runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true }))
            .toMatchObject({ kind: 'complete' })
        expect(await Promise.all(successful.files.map(file => readFile(join(successful.root, file.path), 'utf8'))))
            .toEqual(successful.files.map(file => file.bytes))

        const interrupted = await compactPublication()
        const interruptedPlan = await admitPublicationPlan(interrupted.input, { execute: executeProbe })
        expect(interruptedPlan).toMatchObject({ kind: 'complete' })
        if (interruptedPlan.kind !== 'complete') return
        const actions: string[] = []
        let damaged = false
        const result = await runPublicationPlan(interruptedPlan.plan, { revalidate: async () => true,
            execute: async step => {
                actions.push(step.labels.action!)
                // One compact unit commits in one call, which verifies every group before retiring any backup.
                if (!damaged && step.labels.action === 'commit-batch') {
                    damaged = true
                    await writeFile(join(interrupted.root, interrupted.files[0]!.path), 'damaged\n')
                }
                return executeProbe(step)
            } })
        expect(damaged).toBe(true)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_COMPENSATION_FAILED' })] })
        expect(actions).toContain('rollback')
        expect(await readFile(join(interrupted.root, interrupted.files[0]!.path), 'utf8')).toBe('damaged\n')
        expect(await Promise.all(interrupted.files.slice(1).map(file => readFile(join(interrupted.root, file.path), 'utf8'))))
            .toEqual(interrupted.files.slice(1).map(file => file.bytes))
        await expect(lstat(join(interrupted.root, ledgerPath))).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('admits small owned files with the minimum bounded authenticated helper count', async () => {
        const { input, owned, ledger } = await smallFilePublication()
        const batches: Array<Array<{ action: string; segments: string[]; name: string; maxBytes: number }>> = []
        const adapters = {
            execute: async (step: Parameters<typeof executeProbe>[0]) => {
                if (step.labels.action === 'read-batch') batches.push(JSON.parse(step.argv[3]!).entries)
                if (step.labels.action === 'read-entry') {
                    const request = JSON.parse(step.argv[3]!) as { action: string; segments: string[]; name: string; maxBytes: number }
                    if ([...request.segments, request.name].join('/') !== ledgerPath) batches.push([request])
                }
                return executeProbe(step)
            },
        }
        const result = await admitPublicationPlan(input, adapters)

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', plan: { changes: [] } })
        expect(batches.flatMap(batch => batch.map(entry => [...entry.segments, entry.name].join('/')))).toEqual(owned.map(row => row.path))
        for (const batch of batches) {
            expect(batch.length).toBeGreaterThan(0)
            expect(batch.length).toBeLessThanOrEqual(64)
            expect(batch.every(entry => entry.action === 'read-entry')).toBe(true)
            expect(batch.reduce((total, entry) => total + entry.maxBytes, 0)).toBeLessThanOrEqual(67_108_864)
        }
        expect(batches).toHaveLength(2)
        if (result.kind !== 'complete') throw new Error('Small-file publication refused')
        batches.length = 0
        const preview = await runPublicationPlan(result.plan, { ...adapters, dryRun: true, revalidate: async () => true })
        expect(preview).toEqual({ kind: 'complete', changes: [], committedPaths: [] })
        expect(batches).toHaveLength(2)
        expect(batches.map(batch => batch.length)).toEqual([64, 3])
        expect(batches.flatMap(batch => batch.map(entry => ({ action: entry.action,
            path: [...entry.segments, entry.name].join('/'), maxBytes: entry.maxBytes })))).toEqual([
            ...owned.map(row => ({ action: 'read-entry', path: row.path, maxBytes: Buffer.byteLength(row.bytes) })),
            { action: 'read-entry', path: ledgerPath, maxBytes: Buffer.byteLength(ledger.bytes) },
        ])
    })

    it('refuses admission growth beyond its allocation hint without publication or retry', async () => {
        const { root, input, owned, ledger, before } = await smallFilePublication()
        const target = owned[0]!
        const grown = target.bytes + 'growth\n'
        const actions: string[] = []
        let attempts = 0
        const result = await admitPublicationPlan(input, {
            execute: async step => {
                actions.push(step.labels.action!)
                if (step.labels.action === 'read-batch') {
                    const request = JSON.parse(step.argv[3]!) as { entries: Array<{ segments: string[]; name: string; maxBytes: number }> }
                    const entry = request.entries.find(row => [...row.segments, row.name].join('/') === target.path)
                    if (entry) {
                        attempts += 1
                        expect(entry.maxBytes).toBe(Buffer.byteLength(target.bytes))
                        if (attempts === 1) await writeFile(join(root, target.path), grown)
                    }
                }
                return executeProbe(step)
            },
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GENERATED_PUBLICATION_FAILED', target: 'generated-environment' }] })
        expect(attempts).toBe(1)
        expect(actions).toEqual(['read-entry', 'read-batch'])
        expect(await readFile(join(root, target.path), 'utf8')).toBe(grown)
        expect(await Promise.all(owned.slice(1).map(row => readFile(join(root, row.path), 'utf8')))).toEqual(owned.slice(1).map(row => row.bytes))
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(ledger.bytes)
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(before)
    })

    it('refuses target growth at the fresh currentness boundary without publication', async () => {
        const { root, input, owned, ledger, before } = await smallFilePublication()
        const admitted = await admitPublicationPlan(input, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') throw new Error('Small-file publication refused')
        const target = owned[0]!
        const grown = target.bytes + 'growth\n'
        const actions: string[] = []
        const stages: Array<string | undefined> = []
        let attempts = 0
        const result = await runPublicationPlan(admitted.plan, {
            revalidate: async (_deadline, stage) => { stages.push(stage); return true },
            execute: async step => {
                actions.push(step.labels.action!)
                if (step.labels.action === 'read-batch') {
                    const request = JSON.parse(step.argv[3]!) as { entries: Array<{ segments: string[]; name: string; maxBytes: number }> }
                    const entry = request.entries.find(row => [...row.segments, row.name].join('/') === target.path)
                    if (entry) {
                        attempts += 1
                        expect(entry.maxBytes).toBe(Buffer.byteLength(target.bytes))
                        await writeFile(join(root, target.path), grown)
                    }
                }
                return executeProbe(step)
            },
        })
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GENERATED_SOURCE_CHANGED' }] })
        expect(attempts).toBe(1)
        expect(stages).toEqual(['after-publish'])
        expect(actions).toEqual(['read-batch'])
        expect(await readFile(join(root, target.path), 'utf8')).toBe(grown)
        expect(await Promise.all(owned.slice(1).map(row => readFile(join(root, row.path), 'utf8')))).toEqual(owned.slice(1).map(row => row.bytes))
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(ledger.bytes)
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(before)
    })

    it('prevalidates every backup before retiring an earlier group', async () => {
        const { root, input, postimage } = await publication()
        const seeded = await admitPublicationPlan(input, { execute: executeProbe })
        expect(seeded, JSON.stringify(seeded)).toMatchObject({ kind: 'complete' })
        if (seeded.kind !== 'complete') throw new Error('Publication admission refused')

        const corruptedBytes = Buffer.from('corrupted later backup\n')
        let stagedInput: string | undefined
        let earlierBackup: string | undefined
        let earlierBytes: Buffer | undefined
        let corruptedBackup: string | undefined
        let injected = false
        let rollbacks = 0
        const result = await runPublicationPlan(seeded.plan, {
            revalidate: async () => true,
            authorizeStaleRemoval: approve,
            execute: async step => {
                if (!stagedInput) {
                    stagedInput = stagedPublicationInputs(step)[0]
                    if (stagedInput) roots.push(dirname(stagedInput))
                }
                if (step.labels.action === 'rollback') rollbacks += 1
                if (!injected && step.labels.action === 'commit-batch') {
                    type Entry = { chain: Array<{ name: string }>; backup: string | null }
                    const request = JSON.parse(step.argv[3]!) as { groups: Array<{ parent: string; entries: Entry[] }> }
                    const groups = request.groups.map(group => ({
                        parent: group.parent,
                        entries: group.entries.filter((entry): entry is Entry & { backup: string } => typeof entry.backup === 'string'),
                    })).filter(group => group.entries.length > 0)
                    expect(groups.length).toBeGreaterThanOrEqual(2)
                    const first = groups[0]!
                    const later = groups.at(-1)!
                    earlierBackup = join(root, first.parent === '.' ? '' : first.parent, ...first.entries[0]!.chain.map(entry => entry.name), first.entries[0]!.backup)
                    corruptedBackup = join(root, later.parent === '.' ? '' : later.parent, ...later.entries.at(-1)!.chain.map(entry => entry.name), later.entries.at(-1)!.backup)
                    earlierBytes = await readFile(earlierBackup)
                    await writeFile(corruptedBackup, corruptedBytes)
                    injected = true
                }
                return executeProbe(step)
            },
        })

        expect(injected).toBe(true)
        // Commit verified the corrupted backup before retiring any, so it tried a rollback, and the
        // rollback refused before restoring anything because that backup no longer matches.
        expect(rollbacks).toBe(1)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_COMPENSATION_FAILED' })],
        })
        await expect(readFile(earlierBackup!)).resolves.toEqual(earlierBytes)
        expect(await readFile(corruptedBackup!)).toEqual(corruptedBytes)
        expect(stagedInput).toBeDefined()
        await expect(stat(stagedInput!)).resolves.toMatchObject({ isFile: expect.any(Function) })
        expect((await readdir(dirname(stagedInput!))).some(name => name.startsWith('recovery-'))).toBe(true)
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(postimage)
        expect(await readFile(join(root, 'nested/new.txt'), 'utf8')).toBe('new')
        await expect(lstat(join(root, 'a-stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(input.nextLedgerBytes)
    })

    it('validates unchanged publication once without staging or mutation work and retains exact bytes', async () => {
        const { root, plan, prior, before } = await unchangedPublication()
        const paths = ['a-stale.txt', 'z-shared.md', ledgerPath]
        const identities = await Promise.all(paths.map(async path => {
            const { dev, ino, mtimeMs } = await lstat(join(root, path))
            return { dev, ino, mtimeMs }
        }))
        const stages: Array<string | undefined> = []
        const actions: string[] = []
        const started = Date.now()
        // Observe real temporary-directory creation; the spy calls the native filesystem.
        const directories = vi.spyOn(fsPromises, 'mkdtemp')
        syncBuiltinESMExports()
        try {
            const result = await runPublicationPlan(plan, {
                revalidate: async (deadline, stage) => {
                    stages.push(stage)
                    expect(deadline).toBeGreaterThan(started)
                    expect(deadline).toBeLessThanOrEqual(Date.now() + 180_000)
                    return true
                },
                execute: async step => { actions.push(step.labels.action!); return executeProbe(step) },
            })
            expect(result).toEqual({ kind: 'complete', changes: [], committedPaths: [] })
            expect(stages).toEqual(['after-publish'])
            expect(actions).toEqual(['read-batch'])
            expect(directories.mock.calls.filter(([prefix]) => String(prefix).includes('cockpit-generated-input-'))).toEqual([])
        } finally {
            directories.mockRestore()
            syncBuiltinESMExports()
        }
        expect(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))).toEqual(['old', before, prior.bytes])
        expect(await Promise.all(paths.map(async path => {
            const { dev, ino, mtimeMs } = await lstat(join(root, path))
            return { dev, ino, mtimeMs }
        }))).toEqual(identities)
        expect(await runPublicationPlan(plan, { execute: executeProbe, revalidate: async () => { throw new Error('replayed authority reached validation') } }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GENERATED_PUBLICATION_FAILED' }] })
    })

    it('shares exact approval across concurrent admission and one-use publication', async () => {
        const { input } = await publication()
        const admitted = await admitPublicationPlan(input, { execute: executeProbe })
        if (admitted.kind !== 'complete') throw new Error('expected publication plan')
        const authorizeStaleRemoval = vi.fn(approve)
        const adapters = { execute: executeProbe, authorizeStaleRemoval, revalidate: async () => true }
        expect(await authorizePublicationPlan({ ...admitted.plan }, adapters)).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'GENERATED_PUBLICATION_FAILED' }],
        })
        expect(authorizeStaleRemoval).not.toHaveBeenCalled()
        expect(await Promise.all([
            authorizePublicationPlan(admitted.plan, adapters), authorizePublicationPlan(admitted.plan, adapters),
        ])).toEqual([true, true])
        expect(await runPublicationPlan(admitted.plan, adapters)).toMatchObject({ kind: 'complete' })
        expect(authorizeStaleRemoval).toHaveBeenCalledTimes(1)
        expect(await authorizePublicationPlan(admitted.plan, adapters)).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'GENERATED_PUBLICATION_FAILED' }],
        })
        expect(await runPublicationPlan(admitted.plan, adapters)).toMatchObject({ kind: 'refusal' })
        expect(authorizeStaleRemoval).toHaveBeenCalledTimes(1)
    })

    it('consumes a denied approval before metadata admission can retry it', async () => {
        const { root, input, prior } = await publication()
        const admitted = await admitPublicationPlan(input, { execute: executeProbe })
        if (admitted.kind !== 'complete') throw new Error('expected publication plan')
        const authorizeStaleRemoval = vi.fn(async () => undefined)
        expect(await authorizePublicationPlan(admitted.plan, { execute: executeProbe, authorizeStaleRemoval })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'GENERATED_STALE_APPROVAL_REQUIRED' }],
        })
        expect(await runPublicationPlan(admitted.plan, { execute: executeProbe, authorizeStaleRemoval: approve, revalidate: async () => true }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GENERATED_PUBLICATION_FAILED' }] })
        expect(authorizeStaleRemoval).toHaveBeenCalledTimes(1)
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
    })

    it('previews unchanged publication without consuming its one-use apply authority', async () => {
        const { plan } = await unchangedPublication()
        const stages: Array<string | undefined> = []
        const adapters = { execute: executeProbe, revalidate: async (_deadline?: number, stage?: string) => { stages.push(stage); return true } }
        expect(await runPublicationPlan(plan, { ...adapters, dryRun: true })).toEqual({ kind: 'complete', changes: [], committedPaths: [] })
        expect(await runPublicationPlan(plan, adapters)).toEqual({ kind: 'complete', changes: [], committedPaths: [] })
        expect(stages).toEqual(['preview', 'after-publish'])
    })

    it.each(['target bytes', 'target identity', 'ledger identity'] as const)('refuses unchanged publication after admitted %s change', async changed => {
        const { root, plan, prior, before } = await unchangedPublication()
        const path = changed === 'ledger identity' ? ledgerPath : 'a-stale.txt'
        const bytes = changed === 'ledger identity' ? prior.bytes : changed === 'target bytes' ? 'changed' : 'old'
        const original = await lstat(join(root, path))
        if (changed !== 'target bytes') await rename(join(root, path), join(root, 'held-original.txt'))
        await writeFile(join(root, path), bytes)
        if (changed === 'target bytes') expect(await lstat(join(root, path))).toMatchObject({ dev: original.dev, ino: original.ino })
        const stages: Array<string | undefined> = []
        const result = await runPublicationPlan(plan, { execute: executeProbe, revalidate: async (_deadline, stage) => { stages.push(stage); return true } })
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GENERATED_SOURCE_CHANGED' }] })
        expect(stages).toEqual(['after-publish'])
        expect(await readFile(join(root, path), 'utf8')).toBe(bytes)
        if (changed !== 'target bytes') expect(await readFile(join(root, 'held-original.txt'), 'utf8')).toBe(changed === 'ledger identity' ? prior.bytes : 'old')
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(before)
    })

    it.each(['before validation', 'during validation', 'after target check'] as const)('authenticates the unchanged publication root %s', async when => {
        const { root, plan, prior, before } = await unchangedPublication()
        const held = `${root}-held`
        roots.push(held)
        const replaceRoot = async () => {
            await rename(root, held)
            if (when === 'during validation') await symlink(held, root)
            else await mkdir(root)
        }
        if (when === 'before validation') await replaceRoot()
        let validations = 0
        const result = await runPublicationPlan(plan, {
            revalidate: async () => {
                validations++
                if (when === 'during validation') await replaceRoot()
                return true
            },
            execute: async step => {
                const outcome = await executeProbe(step)
                if (when === 'after target check') await replaceRoot()
                return outcome
            },
        })
        expect(result.kind).toBe('refusal')
        expect(validations).toBe(when === 'before validation' ? 0 : 1)
        expect(await readFile(join(held, ledgerPath), 'utf8')).toBe(prior.bytes)
        expect(await readFile(join(held, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(held, 'z-shared.md'), 'utf8')).toBe(before)
    })

    it('propagates the exact final source-input refusal for unchanged publication and consumes authority', async () => {
        const { root, input, prior, before } = await publication()
        await writeFile(join(root, 'source.json'), 'source')
        const admitted = await admitPublicationPlan({ ...input, nextLedgerBytes: prior.bytes, mutations: [] }, { execute: executeProbe })
        if (admitted.kind !== 'complete') throw new Error('Unchanged source-input publication refused')
        await writeFile(join(root, 'source.json'), 'changed source')
        const refusal = { kind: 'refusal' as const, artifact: null, destination: null, result: null, status: 2 as const,
            diagnostics: [{ severity: 'error' as const, code: 'GENERATED_SOURCE_CHANGED', message: 'source input changed', target: 'source.json' }] }
        const stages: Array<string | undefined> = []
        const actions: string[] = []
        expect(await runPublicationPlan(admitted.plan, {
            revalidate: async (_deadline, stage) => {
                stages.push(stage)
                return digest(await readFile(join(root, 'source.json'), 'utf8')) === input.sourceSha256 ? true : refusal
            },
            execute: async step => { actions.push(step.labels.action!); return executeProbe(step) },
        })).toBe(refusal)
        expect(stages).toEqual(['after-publish'])
        expect(actions).toEqual([])
        expect((await runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true })).kind).toBe('refusal')
        expect(await readFile(join(root, 'source.json'), 'utf8')).toBe('changed source')
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(before)
    })

    it('refuses unchanged publication when final validation exhausts its transaction deadline', async () => {
        const { root, plan, prior } = await unchangedPublication()
        const clock = vi.spyOn(Date, 'now')
        try {
            const result = await runPublicationPlan(plan, { execute: executeProbe, revalidate: async deadline => {
                if (!deadline) throw new Error('Unchanged publication has no deadline')
                clock.mockReturnValue(deadline)
                return true
            } })
            expect(result.kind).toBe('refusal')
        } finally { clock.mockRestore() }
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
    })

    it('restores only an exact authenticated v3 whole-file postimage and binds its corrupt preimage', async () => {
        const { root, input, common, shared } = await publication()
        const prior = encodeOwnershipManifest({ ...common, producedAt: '2026-10-22T12:00:00.000Z',
            owned: [{ path: 'a-stale.txt', sha256: digest('old') }], surfaces: [shared] })
        const next = encodeOwnershipManifest({ ...common, producedAt: '2026-10-23T12:00:00.000Z',
            owned: [{ path: 'a-stale.txt', sha256: digest('old') }], surfaces: [shared] })
        await writeFile(join(root, ledgerPath), prior.bytes)
        await writeFile(join(root, 'a-stale.txt'), 'corrupt')
        const identity = async (path: string) => {
            const { dev, ino } = await lstat(join(root, path))
            return { dev, ino }
        }
        const restoration = { ...input, ledgerExpected: { kind: 'file' as const, sha256: digest(prior.bytes), identity: await identity(ledgerPath) },
            nextLedgerBytes: next.bytes, mutations: [{ path: 'a-stale.txt', phase: 'desired' as const, operation: 'write-file' as const,
                bytes: 'old', sha256: digest('old'), expected: { kind: 'file' as const, sha256: digest('corrupt'), identity: await identity('a-stale.txt') } }] }
        const admitted = await admitPublicationPlan(restoration, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') throw new Error('Exact authenticated restoration refused')
        expect(await runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true }))
            .toMatchObject({ kind: 'complete', committedPaths: ['a-stale.txt', ledgerPath] })
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(next.bytes)

        await writeFile(join(root, ledgerPath), prior.bytes)
        await writeFile(join(root, 'a-stale.txt'), 'corrupt')
        const current = { ...restoration, ledgerExpected: { ...restoration.ledgerExpected, identity: await identity(ledgerPath) },
            mutations: [{ ...restoration.mutations[0]!, expected: { ...restoration.mutations[0]!.expected, identity: await identity('a-stale.txt') } }] }
        const changedGeneration = encodeOwnershipManifest({ ...common, generation: digest('other-generation'),
            owned: [{ path: 'a-stale.txt', sha256: digest('old') }], surfaces: [shared] })
        const changedEntries = encodeOwnershipManifest({ ...common,
            owned: [{ path: 'a-stale.txt', sha256: digest('different') }], surfaces: [shared] })
        const changedSource = encodeOwnershipManifest({ ...common, personaSource: { ...common.personaSource, sha256: digest('other-source') },
            owned: [{ path: 'a-stale.txt', sha256: digest('old') }], surfaces: [shared] })
        const changedConfig = encodeOwnershipManifest({ ...common, sourceSha256: digest('other-config'),
            owned: [{ path: 'a-stale.txt', sha256: digest('old') }], surfaces: [shared] })
        const foreign = encodeOwnershipManifest({ ...common, owned: [{ path: 'foreign.txt', sha256: digest('old') }], surfaces: [shared] })
        const raw = JSON.parse(next.bytes)
        raw.producer.version = '99.0.0'
        delete raw.integrity
        const changedProducer = JSON.stringify({ ...raw, integrity: digest(JSON.stringify(raw)) })
        for (const denied of [
            { ...current, generation: changedGeneration.manifest.generation, nextLedgerBytes: changedGeneration.bytes },
            { ...current, nextLedgerBytes: changedEntries.bytes },
            { ...current, nextLedgerBytes: changedSource.bytes },
            { ...current, sourceSha256: changedConfig.manifest.source.sha256, nextLedgerBytes: changedConfig.bytes },
            { ...current, nextLedgerBytes: foreign.bytes },
            { ...current, nextLedgerBytes: changedProducer },
            { ...current, nextLedgerBytes: next.bytes.replace('"version":', '"forged":') },
            { ...current, mode: 'reference' as const, references: [{ kind: 'file' as const, path: 'a-stale.txt', sha256: digest('old') }] },
            { ...current, mutations: [{ ...current.mutations[0]!, phase: 'stale' as const }] },
            { ...current, mutations: [{ ...current.mutations[0]!, operation: 'remove-file' as const }] },
        ]) {
            expect((await admitPublicationPlan(denied, { execute: executeProbe })).kind).toBe('refusal')
            expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('corrupt')
            expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
        }
        for (const version of [1, 2]) {
            const file = { path: 'a-stale.txt', ownership: 'whole-file', sha256: digest('old') }
            const payload = { format: `cockpit-generated-ownership/v${version}`, cockpitId: prior.manifest.cockpitId,
                generation: prior.manifest.generation, source: prior.manifest.source, personaSource: prior.manifest.personaSource,
                ...(version === 1 ? { files: [file] } : { entries: [{ kind: 'file', ...file }] }) }
            const legacy = JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) })
            await writeFile(join(root, ledgerPath), legacy)
            expect(ownership.parseOwnershipManifest(legacy, input.authority).kind, `obsolete v${version}`).toBe('invalid')
            expect((await admitPublicationPlan({ ...current, ledgerExpected: { kind: 'file', sha256: digest(legacy), identity: await identity(ledgerPath) } },
                { execute: executeProbe })).kind).toBe('refusal')
            expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('corrupt')
            expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(legacy)
        }
        await writeFile(join(root, ledgerPath), prior.bytes)
        const changedShared = 'foreign\n' + shared.region.begin + '\nchanged\n' + shared.region.end + '\nretained\n'
        await writeFile(join(root, shared.path), changedShared)
        expect((await admitPublicationPlan(current, { execute: executeProbe })).kind).toBe('refusal')
        await writeFile(join(root, shared.path), 'foreign\n' + shared.region.begin + '\n' + shared.region.bytes + shared.region.end + '\nretained\n')
        await rename(join(root, 'a-stale.txt'), join(root, 'unsafe-original.txt'))
        await symlink('unsafe-original.txt', join(root, 'a-stale.txt'))
        expect((await admitPublicationPlan({ ...current, mutations: [{ ...current.mutations[0]!, expected: {
            kind: 'symlink', target: 'unsafe-original.txt', identity: await identity('a-stale.txt'),
        } }] }, { execute: executeProbe })).kind).toBe('refusal')
        await rm(join(root, 'a-stale.txt'))
        await rename(join(root, 'unsafe-original.txt'), join(root, 'a-stale.txt'))
        const stale = await admitPublicationPlan(current, { execute: executeProbe })
        expect(stale.kind).toBe('complete')
        if (stale.kind !== 'complete') throw new Error('Restoration readmission refused')
        await rename(join(root, 'a-stale.txt'), join(root, 'corrupt-original.txt'))
        await writeFile(join(root, 'a-stale.txt'), 'corrupt')
        expect((await runPublicationPlan(stale.plan, { execute: executeProbe, revalidate: async () => true })).kind).toBe('refusal')
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('corrupt')
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
    })

    it('projects each authenticated manifest once per multi-entry admission', async () => {
        const { input } = await publication()
        const projection = vi.spyOn(ownership, 'projectGeneratedPathFacts')
        try {
            for (let admission = 0; admission < 2; admission++) {
                projection.mockClear()
                const admitted = await admitPublicationPlan(input, { execute: executeProbe })
                expect(admitted).toMatchObject({ kind: 'complete', plan: { changes: [
                    { operation: 'write', path: 'z-shared.md' },
                    { operation: 'write', path: 'nested/new.txt' },
                    { operation: 'remove', path: 'a-stale.txt' },
                    { operation: 'write', path: ledgerPath },
                ] } })
                expect(projection).toHaveBeenCalledTimes(2)
                expect(projection.mock.calls.map(([manifest]) => manifest.entries.map(entry => entry.path)))
                    .toEqual([['a-stale.txt', 'z-shared.md'], ['nested/new.txt']])
            }
        } finally {
            projection.mockRestore()
        }
    })

    it('freezes one classified plan for dry-run and apply and publishes all writes before exact deletion and ledger last', async () => {
        const { root, input, postimage } = await publication()
        await writeFile(join(root, referenceLedgerPath), 'reference estate remains foreign\n')
        const plan = await admitPublicationPlan(input, { execute: executeProbe })
        expect(plan, JSON.stringify(plan)).toMatchObject({ kind: 'complete' })
        if (plan.kind !== 'complete') return
        expect(Object.isFrozen(plan.plan)).toBe(true)
        const preview = await runPublicationPlan(plan.plan, { dryRun: true, execute: executeProbe, revalidate: async () => true })
        expect(preview).toMatchObject({ kind: 'complete', committedPaths: [] })
        const order: string[] = []
        const result = await runPublicationPlan(plan.plan, { execute: async step => {
            if (step.labels.action === 'publish-batch') {
                const request = JSON.parse(step.argv[3]!)
                for (const group of request.groups) for (const entry of group.entries) order.push(entry.operation + ':' + entry.name)
            }
            return executeProbe(step)
        }, revalidate: async () => true, authorizeStaleRemoval: approve })
        expect(result).toMatchObject({ kind: 'complete', changes: preview.kind === 'complete' ? preview.changes : [] })
        expect(order).toEqual(['write-file:z-shared.md', 'write-file:new.txt', 'remove-file:a-stale.txt', 'write-file:generated-environment-ownership.json'])
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(postimage)
        expect(await readFile(join(root, referenceLedgerPath), 'utf8')).toBe('reference estate remains foreign\n')
        await expect(lstat(join(root, 'a-stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(result.kind === 'complete' && result.committedPaths).toEqual(plan.plan.changes.map(row => row.path))
    })

    it('refuses unclassified delete authority and fabricated plans without touching any path', async () => {
        const { root, input, prior } = await publication()
        await writeFile(join(root, 'foreign.txt'), 'foreign')
        const status = await lstat(join(root, 'foreign.txt'))
        const plan = await admitPublicationPlan({ ...input, mutations: [...input.mutations, {
            path: 'foreign.txt', phase: 'stale', operation: 'remove-file', expected: { kind: 'file', sha256: digest('foreign'), identity: { dev: status.dev, ino: status.ino } },
        }] }, { execute: executeProbe })
        expect(plan.kind).toBe('refusal')
        const fake = await runPublicationPlan({ changes: [] } as never, { execute: executeProbe, revalidate: async () => true })
        expect(fake.kind).toBe('refusal')
        expect(await readFile(join(root, 'foreign.txt'), 'utf8')).toBe('foreign')
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
    })

    it('bootstraps only the fixed reference estate from opaque immutable Git evidence', async () => {
        const { root, input, bootstrap, before, postimage } = await referencePublication()
        await mkdir(join(root, '.cockpit'))
        await writeFile(join(root, ledgerPath), 'consumer estate remains foreign\n')
        expect(await revalidateReferenceBootstrap(bootstrap, { execute: executeProbe })).toBe(true)
        expect((await admitPublicationPlan({ ...input, referenceBootstrap: { ...bootstrap } as never }, { execute: executeProbe })).kind).toBe('refusal')
        expect((await admitPublicationPlan({ ...input, references: input.references.slice(1) }, { execute: executeProbe })).kind).toBe('refusal')
        const region = input.references.at(-1)!
        if (region.kind !== 'markdown-region') throw new Error('missing fixed region declaration')
        for (const references of [
            [...input.references.slice(0, -1), { ...region, begin: '<!-- changed -->' }],
            [...input.references.slice(0, -1), { kind: 'file' as const, path: region.path, sha256: region.regionSha256 }],
            [...input.references.slice(0, -1), { ...region, path: 'docs/cli-reference.md' }],
            [...input.references.slice(0, -1), { ...region, preimageSha256: digest('different') }],
            [...input.references.slice(0, -1), { ...region, regionSha256: digest('different') }],
            [...input.references.slice(0, -1), { ...region, postimageSha256: digest('different') }],
        ]) expect((await admitPublicationPlan({ ...input, references }, { execute: executeProbe })).kind).toBe('refusal')
        const regionMutation = input.mutations.at(-1)!
        expect((await admitPublicationPlan({ ...input, mutations: [...input.mutations.slice(0, -1), {
            ...regionMutation, bytes: regionMutation.bytes!.replace('new diagnostic index', 'changed diagnostic index'),
            sha256: digest(regionMutation.bytes!.replace('new diagnostic index', 'changed diagnostic index')),
        }] }, { execute: executeProbe })).kind).toBe('refusal')
        expect((await admitPublicationPlan({ ...input, mode: 'sync' }, { execute: executeProbe })).kind).toBe('refusal')
        await writeFile(join(root, 'docs/troubleshooting.md'), input.mutations.at(-1)!.bytes!.replace(
            '<!-- cockpit:diagnostic-index:end -->', '<!-- cockpit:diagnostic-index:begin -->\n<!-- cockpit:diagnostic-index:end -->'))
        expect((await admitPublicationPlan(input, { execute: executeProbe })).kind).toBe('refusal')
        await writeFile(join(root, 'docs/troubleshooting.md'), before)
        await chmod(join(root, 'docs/troubleshooting.md'), 0o755)
        expect((await admitPublicationPlan(input, { execute: executeProbe })).kind).toBe('refusal')
        await chmod(join(root, 'docs/troubleshooting.md'), 0o644)
        const admitted = await admitPublicationPlan(input, { execute: executeProbe })
        expect(admitted).toMatchObject({ kind: 'complete' })
        if (admitted.kind !== 'complete') throw new Error('exact reference plan refused')
        const result = await runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true })
        expect(result).toMatchObject({ kind: 'complete', committedPaths: [
            'docs/capability-matrix.md', 'docs/cli-reference.md', 'docs/command-list.md', 'docs/configuration-reference.md',
            'docs/troubleshooting.md', 'skills/adopt-cockpit/SKILL.md', referenceLedgerPath,
        ] })
        expect(await readFile(join(root, 'docs/troubleshooting.md'), 'utf8')).toBe(postimage)
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe('consumer estate remains foreign\n')
        expect(JSON.parse(await readFile(join(root, referenceLedgerPath), 'utf8')).entries.at(-1)).toMatchObject({
            kind: 'markdown-region', path: 'docs/troubleshooting.md', regionId: 'diagnostic-index', sha256: digest('new diagnostic index\n'),
        })
    })

    it('refreshes a stale reference ledger only from an entirely committed reference estate', async () => {
        const { root, input, postimage } = await referencePublication()
        const first = await admitPublicationPlan(input, { execute: executeProbe })
        expect(first.kind, JSON.stringify(first)).toBe('complete')
        if (first.kind !== 'complete') return
        expect(await runPublicationPlan(first.plan, { execute: executeProbe, revalidate: async () => true }))
            .toMatchObject({ kind: 'complete' })
        const cliPath = 'docs/cli-reference.md'
        const troublePath = 'docs/troubleshooting.md'
        const rebasedCli = 'committed cli after rebase\n'
        const rebasedTrouble = postimage.replace('new diagnostic index', 'committed diagnostic index after rebase')
        await writeFile(join(root, cliPath), rebasedCli)
        await writeFile(join(root, troublePath), rebasedTrouble)
        execFileSync('git', ['add', '--', ...input.references.map(({ path }) => path)], { cwd: root })
        execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'update generated references'], { cwd: root })
        const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
        if (git.state !== 'available') throw new Error('Git unavailable for reference refresh')
        const captured = await captureReferenceBootstrap(root, git.value, { execute: executeProbe })
        if (captured.kind !== 'complete') throw new Error(JSON.stringify(captured))
        const ledger = await readFile(join(root, referenceLedgerPath), 'utf8')
        const ledgerStat = await lstat(join(root, referenceLedgerPath))
        const cliStat = await lstat(join(root, cliPath))
        const troubleStat = await lstat(join(root, troublePath))
        const next = {
            ...input, referenceBootstrap: captured.bootstrap,
            ledgerExpected: { kind: 'file' as const, sha256: digest(ledger), identity: { dev: ledgerStat.dev, ino: ledgerStat.ino } },
            references: input.references.map(row => row.kind === 'markdown-region' ? { ...row, preimageSha256: digest(rebasedTrouble) } : row),
            mutations: [
                { ...input.mutations[0]!, expected: { kind: 'file' as const, sha256: digest(rebasedCli), identity: { dev: cliStat.dev, ino: cliStat.ino } } },
                { ...input.mutations.at(-1)!, expected: { kind: 'file' as const, sha256: digest(rebasedTrouble), identity: { dev: troubleStat.dev, ino: troubleStat.ino } } },
            ],
        }
        const editedPath = join(root, 'docs/command-list.md')
        const committedBytes = await readFile(editedPath)
        await writeFile(editedPath, 'uncommitted human edit\n')
        expect((await admitPublicationPlan(next, { execute: executeProbe })).kind).toBe('refusal')
        await writeFile(editedPath, committedBytes)

        const stagedCli = 'staged uncommitted cli\n'
        const stagedTrouble = postimage.replace('new diagnostic index', 'staged uncommitted diagnostic index')
        await Promise.all([
            writeFile(join(root, cliPath), stagedCli),
            writeFile(join(root, troublePath), stagedTrouble),
        ])
        execFileSync('git', ['add', '--', ...input.references.map(({ path }) => path)], { cwd: root })
        const stagedBootstrap = await captureReferenceBootstrap(root, git.value, { execute: executeProbe })
        if (stagedBootstrap.kind !== 'complete') throw new Error(JSON.stringify(stagedBootstrap))
        const stagedCliStat = await lstat(join(root, cliPath))
        const stagedTroubleStat = await lstat(join(root, troublePath))
        const staged = {
            ...next,
            referenceBootstrap: stagedBootstrap.bootstrap,
            references: input.references.map(row => row.kind === 'markdown-region' ? { ...row, preimageSha256: digest(stagedTrouble) } : row),
            mutations: [
                { ...input.mutations[0]!, expected: { kind: 'file' as const, sha256: digest(stagedCli), identity: { dev: stagedCliStat.dev, ino: stagedCliStat.ino } } },
                { ...input.mutations.at(-1)!, expected: { kind: 'file' as const, sha256: digest(stagedTrouble), identity: { dev: stagedTroubleStat.dev, ino: stagedTroubleStat.ino } } },
            ],
        }
        expect((await admitPublicationPlan(staged, { execute: executeProbe })).kind).toBe('refusal')
        await Promise.all([
            writeFile(join(root, cliPath), rebasedCli),
            writeFile(join(root, troublePath), rebasedTrouble),
        ])
        execFileSync('git', ['add', '--', ...input.references.map(({ path }) => path)], { cwd: root })

        const refreshed = await admitPublicationPlan(next, { execute: executeProbe })
        expect(refreshed.kind, JSON.stringify(refreshed)).toBe('complete')
        if (refreshed.kind !== 'complete') return
        expect(await runPublicationPlan(refreshed.plan, { execute: executeProbe, revalidate: async () => true }))
            .toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, cliPath), 'utf8')).toBe('cli\n')
        expect(await readFile(join(root, troublePath), 'utf8')).toBe(postimage)
    }, 120_000)

    it('binds bootstrap authority to committed tree rows while retaining immutable blob bytes', async () => {
        const { root, bootstrap } = await referencePublication()
        const captured = referenceBootstrapFiles(bootstrap)!
        await writeFile(join(root, 'docs/cli-reference.md'), 'newly staged\n')
        execFileSync('git', ['add', '--', 'docs/cli-reference.md'], { cwd: root })
        expect(await revalidateReferenceBootstrap(bootstrap, { execute: executeProbe })).toBe(true)
        expect(referenceBootstrapFiles(bootstrap)).toEqual(captured)
    })

    it('revalidates the captured Git rows inside the transaction even when owner revalidation returns true', async () => {
        const { root, input, before } = await referencePublication()
        const admitted = await admitPublicationPlan(input, { execute: executeProbe })
        expect(admitted.kind).toBe('complete')
        if (admitted.kind !== 'complete') return
        await writeFile(join(root, 'docs/cli-reference.md'), 'staged after admission\n')
        execFileSync('git', ['add', '--', 'docs/cli-reference.md'], { cwd: root })
        expect((await runPublicationPlan(admitted.plan, { execute: executeProbe, revalidate: async () => true })).kind).toBe('refusal')
        expect(await readFile(join(root, 'docs/troubleshooting.md'), 'utf8')).toBe(before)
        await expect(lstat(join(root, referenceLedgerPath))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(root, 'docs/configuration-reference.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.each([
        ['sha256', 'complete'],
        ['unsupported-format', 'refusal'],
        ['nonblob', 'refusal'],
        ['oversize', 'refusal'],
        ['malformed', 'refusal'],
        ['duplicate', 'refusal'],
        ['nonzero-stage', 'refusal'],
        ['unsupported-mode', 'refusal'],
        ['different-blob', 'refusal'],
        ['leading-nul', 'refusal'],
        ['interior-nul', 'refusal'],
        ['trailing-nul', 'refusal'],
        ['missing-nul', 'refusal'],
        ['empty-stream', 'refusal'],
    ] as const)('authenticates synthetic Git boundary variant %s', async (variant, expected) => {
        const { result, bytes } = await syntheticBootstrap(variant)
        expect(result.kind).toBe(expected)
        if (result.kind === 'complete') {
            expect(referenceBootstrapFiles(result.bootstrap)).toEqual([expect.objectContaining({
                path: 'docs/troubleshooting.md', oid: createHash('sha256').update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest('hex'),
                bytes,
            })])
        }
    })

    it.each(['leading-nul', 'interior-nul', 'trailing-nul', 'missing-nul', 'empty-stream'] as const)(
        'refuses synthetic Git boundary revalidation variant %s after valid capture', async variant => {
            const { result, listingPath, validRow, secondRow } = await syntheticBootstrap(variant === 'interior-nul' ? 'two-rows' : 'sha256')
            expect(result.kind).toBe('complete')
            if (result.kind !== 'complete') throw new Error('valid bootstrap refused')
            const captured = referenceBootstrapFiles(result.bootstrap)
            const validRows = variant === 'interior-nul' ? validRow + secondRow : validRow
            expect(await revalidateReferenceBootstrap(result.bootstrap, { execute: executeProbe })).toBe(true)
            const malformed = variant === 'leading-nul' ? '\0' + validRows
                : variant === 'interior-nul' ? validRow + '\0' + secondRow
                    : variant === 'trailing-nul' ? validRows + '\0'
                        : variant === 'missing-nul' ? validRows.slice(0, -1) : ''
            await writeFile(listingPath, malformed)
            expect(await revalidateReferenceBootstrap(result.bootstrap, { execute: executeProbe })).toBe(false)
            expect(referenceBootstrapFiles(result.bootstrap)).toEqual(captured)
        })

    it('revalidates exact identities after confirmation and leaves targets and ledger intact', async () => {
        const { root, input, prior } = await publication()
        const plan = await admitPublicationPlan(input, { execute: executeProbe })
        expect(plan, JSON.stringify(plan)).toMatchObject({ kind: 'complete' })
        if (plan.kind !== 'complete') return
        const actions: string[] = []
        const result = await runPublicationPlan(plan.plan, { revalidate: async () => true,
            authorizeStaleRemoval: async request => {
                await rename(join(root, 'a-stale.txt'), join(root, 'held-original.txt'))
                await writeFile(join(root, 'a-stale.txt'), 'old')
                return approve(request)
            },
            execute: async step => { actions.push(step.labels.action!); return executeProbe(step) } })
        expect(result.kind).toBe('refusal')
        expect(actions).not.toContain('prepare-batch')
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, 'held-original.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
        await expect(lstat(join(root, 'nested/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('validates every stage before any publication and compensates destination failure without deleting a source', async () => {
        const { root, input, prior, before } = await publication()
        const plan = await admitPublicationPlan(input, { execute: executeProbe })
        expect(plan, JSON.stringify(plan)).toMatchObject({ kind: 'complete' })
        if (plan.kind !== 'complete') return
        let damaged = false
        let publishedBeforeRollback: string | undefined
        const result = await runPublicationPlan(plan.plan, { revalidate: async () => true, authorizeStaleRemoval: approve,
            execute: async step => {
                const outcome = await executeProbe(step)
                if (!damaged && step.labels.action === 'prepare-batch' && outcome.kind === 'complete') {
                    const receipt = JSON.parse(new TextDecoder().decode(outcome.stdout)) as { groups: Array<{ entries: Array<{ name: string; stage: string | null }> }> }
                    const stage = receipt.groups.flatMap(group => group.entries).find(entry => entry.name === 'new.txt')?.stage
                    if (!stage) throw new Error('the synthetic write stage was not prepared')
                    damaged = true
                    await writeFile(join(root, 'nested', stage), 'damaged')
                }
                // The shared file is published first, so any write before validation would show here.
                if (step.labels.action === 'publish-batch') publishedBeforeRollback = await readFile(join(root, 'z-shared.md'), 'utf8')
                return outcome
            } })
        expect(damaged).toBe(true)
        expect(publishedBeforeRollback).toBe(before)
        expect(result.kind).toBe('refusal')
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(before)
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
        await expect(lstat(join(root, 'nested/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.each([
        { leaf: 'new.txt', sourcePresent: true },
        { leaf: 'generated-environment-ownership.json', sourcePresent: false },
    ])('compensates a publication failure at $leaf and records no uncommitted paths', async ({ leaf, sourcePresent }) => {
        const { root, input, prior, before } = await publication()
        const plan = await admitPublicationPlan(input, { execute: executeProbe })
        expect(plan, JSON.stringify(plan)).toMatchObject({ kind: 'complete' })
        if (plan.kind !== 'complete') return
        // Publication validates every stage before its first rename, so the failure is injected into
        // the rename itself: the helper publishes each earlier entry and then fails at this leaf.
        const preloadPath = join(root, 'fail-publication-rename.cjs')
        await writeFile(preloadPath, `
            const fs = require('node:fs')
            if (JSON.parse(process.argv[2]).action === 'publish-batch') {
                const rename = fs.renameSync
                fs.renameSync = (from, to) => {
                    if (to === ${JSON.stringify(leaf)}) throw Object.assign(new Error('synthetic publication failure'), { code: 'EIO' })
                    return rename(from, to)
                }
            }
        `)
        let injected = false
        let sourceAtFailure: boolean | undefined
        const result = await runPublicationPlan(plan.plan, { revalidate: async () => true, authorizeStaleRemoval: approve,
            execute: async step => {
                if (!injected && step.labels.action === 'publish-batch') {
                    injected = true
                    step = { ...step, env: { ...step.env, NODE_OPTIONS: `--require=${preloadPath}` } }
                }
                const outcome = await executeProbe(step)
                if (injected && step.labels.action === 'publish-batch') {
                    sourceAtFailure = await lstat(join(root, 'a-stale.txt')).then(() => true, error => {
                        if (error.code !== 'ENOENT') throw error
                        return false
                    })
                }
                return outcome
            } })
        expect(injected).toBe(true)
        expect(sourceAtFailure).toBe(sourcePresent)
        expect(result.kind).toBe('refusal')
        expect(result).not.toHaveProperty('committedPaths')
        expect(await readFile(join(root, 'a-stale.txt'), 'utf8')).toBe('old')
        expect(await readFile(join(root, 'z-shared.md'), 'utf8')).toBe(before)
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(prior.bytes)
        await expect(lstat(join(root, 'nested/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
