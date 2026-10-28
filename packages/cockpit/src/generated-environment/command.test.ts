import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, rm, stat, symlink, writeFile, mkdir, rename, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { observeConfigSource } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { bootstrapHolderId, checkoutId } from '../environment/identity.js'
import { selectBootstrapStateRoot, transactState, type BootstrapStateRecord } from '../environment/state.js'
import {
    type GeneratedEnvironmentCommandAdapters,
} from '../environment/generated-application.js'
import { applyGeneratedEnvironmentRepair, applySelectedBootstrapSurface, checkGeneratedEnvironment, prepareGeneratedEnvironmentCurrentness,
    prepareSelectedBootstrapSurface, syncGeneratedEnvironment } from './command.js'
import * as publicationTransaction from './transaction.js'
import * as generatedCommands from './command.js'
import { installedPackageMetadata } from '../package-metadata.js'

import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { roots, cleanup, canonicalOutputRead, publicationGroups, consumer, surfaceConsumer, digest,
    staleRemovalAuthority, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('public generated repair', () => {
    it('previews and explicitly applies identical changes through each exact prepared plan once', async () => {
        const { root, configPath } = await consumer('public-repair')
        const admit = vi.spyOn(publicationTransaction, 'admitPublicationPlan')
        const run = vi.spyOn(publicationTransaction, 'runPublicationPlan')
        try {
            const preview = await prepareGeneratedEnvironmentCurrentness({ configPath })
            expect(preview.repairAuthority).toBeDefined()
            if (!preview.repairAuthority) throw new Error('public repair authority was not issued')
            expect(run).not.toHaveBeenCalled()
            expect(await applyGeneratedEnvironmentRepair({ ...preview.repairAuthority }))
                .toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
            expect(run).not.toHaveBeenCalled()
            const first = await admit.mock.results[0]!.value
            if (first.kind !== 'complete') throw new Error('public repair plan was not admitted')
            const dry = await applyGeneratedEnvironmentRepair(preview.repairAuthority, { dryRun: true })
            expect(dry).toMatchObject({ kind: 'complete', result: { dryRun: true, changes: preview.changes } })
            expect(run.mock.calls[0]![0]).toBe(first.plan)
            expect(admit).toHaveBeenCalledTimes(1)
            await expect(lstat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(lstat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
            const repeated = await applyGeneratedEnvironmentRepair(preview.repairAuthority)
            expect(repeated).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
            expect(run).toHaveBeenCalledTimes(1)

            const actual = await prepareGeneratedEnvironmentCurrentness({ configPath })
            expect(actual.changes).toEqual(preview.changes)
            if (!actual.repairAuthority) throw new Error('explicit apply authority was not issued')
            const second = await admit.mock.results[1]!.value
            if (second.kind !== 'complete') throw new Error('explicit apply plan was not admitted')
            const applied = await applyGeneratedEnvironmentRepair(actual.repairAuthority)
            expect(applied, JSON.stringify(applied.diagnostics)).toMatchObject({ kind: 'complete', result: { dryRun: false, changes: preview.changes } })
            expect(run.mock.calls[1]![0]).toBe(second.plan)
            expect(admit).toHaveBeenCalledTimes(2)
            expect(run).toHaveBeenCalledTimes(2)
            expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
            expect(run).toHaveBeenCalledTimes(2)
        } finally {
            admit.mockRestore()
            run.mockRestore()
        }
    }, 120_000)

    it.each(['source', 'target'] as const)('refuses a changed %s after public repair preparation without publication', async changed => {
        const { root, configPath } = await consumer(`public-repair-${changed}`)
        const current = await prepareGeneratedEnvironmentCurrentness({ configPath })
        if (!current.repairAuthority) throw new Error('changed-after-preparation authority was not issued')
        const path = changed === 'source' ? configPath : join(root, 'compose.generated.yml')
        const bytes = changed === 'source' ? `${await readFile(configPath, 'utf8')}\n# changed after preparation\n` : 'foreign target\n'
        await writeFile(path, bytes)
        const result = await applyGeneratedEnvironmentRepair(current.repairAuthority)
        expect(result).toMatchObject({ kind: 'refusal' })
        expect(result.diagnostics[0]!.code).toBe('GENERATED_SOURCE_CHANGED')
        expect(await readFile(path, 'utf8')).toBe(bytes)
        await expect(lstat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(root, 'fixtures/personas.generated.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})

it('prepares canonical currentness with genuine producer facts and preserves a complete-estate noop timestamp', async () => {
    const { root, configPath } = await consumer('producer-currentness')
    const first = '2026-10-22T12:00:00.000Z'
    const later = '2026-10-23T12:00:00.000Z'
    expect(await syncGeneratedEnvironment({ configPath }, { now: () => first })).toMatchObject({ kind: 'complete' })
    const before = await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')
    expect(JSON.parse(before)).toMatchObject({ format: 'cockpit-generated-ownership/v3', producer: {
        package: installedPackageMetadata.name, version: installedPackageMetadata.version,
        sourceRevision: installedPackageMetadata.cockpitSourceRevision, producedAt: first,
    } })
    const admission = vi.spyOn(publicationTransaction, 'admitPublicationPlan')
    try {
        const outputPaths = ['app/.env.example', 'compose.generated.yml', 'docs/cockpit/environment-decisions.md', 'fixtures/personas.generated.ts']
        const canonicalReads: { action: string; entries: { path: string; maxBytes: number; action: string }[] }[] = []
        const current = await prepareGeneratedEnvironmentCurrentness({ configPath }, {
            now: () => later,
            execute: async step => {
                const read = canonicalOutputRead(step, root, outputPaths)
                if (read) canonicalReads.push(read)
                return executeProbe(step)
            },
        })
        expect(current.outcome).toMatchObject({ kind: 'complete', result: { action: 'check' } })
        expect(current.changes).toEqual([])
        expect(current.storedProducer).toEqual(JSON.parse(before).producer)
        expect(admission).toHaveBeenCalledTimes(1)
        expect(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(before)
        expect(canonicalReads).toEqual([{ action: 'read-batch', entries: outputPaths.map(path => ({ path, maxBytes: 16_777_216, action: 'read-file' })) }])
    } finally { admission.mockRestore() }
})

it('preserves the complete-estate producer timestamp during no-op sync', async () => {
    const { root, configPath } = await consumer('producer-currentness-noop')
    const first = '2026-10-22T12:00:00.000Z'
    const later = '2026-10-23T12:00:00.000Z'
    expect(await syncGeneratedEnvironment({ configPath }, { now: () => first })).toMatchObject({ kind: 'complete' })
    const before = await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')
    const outputPaths = ['app/.env.example', 'compose.generated.yml', 'docs/cockpit/environment-decisions.md', 'fixtures/personas.generated.ts']
    const canonicalReads: { action: string; entries: { path: string; maxBytes: number; action: string }[] }[] = []
    expect(await syncGeneratedEnvironment({ configPath }, {
        now: () => later,
        execute: async step => {
            const read = canonicalOutputRead(step, root, outputPaths)
            if (read) canonicalReads.push(read)
            return executeProbe(step)
        },
    })).toMatchObject({ kind: 'complete', result: { changes: [] } })
    expect(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(before)
    expect(canonicalReads).toHaveLength(1)
})

it('timestamps a changed producer identity with the actual installed producer', async () => {
    const { root, configPath } = await consumer('producer-migration')
    expect(await syncGeneratedEnvironment({ configPath }, { now: () => '2026-10-22T12:00:00.000Z' })).toMatchObject({ kind: 'complete' })
    const path = join(root, '.cockpit/generated-environment-ownership.json')
    const prior = JSON.parse(await readFile(path, 'utf8'))
    delete prior.integrity
    prior.producer.version = '0.0.0-previous'
    await writeFile(path, `${JSON.stringify({ ...prior, integrity: createHash('sha256').update(JSON.stringify(prior)).digest('hex') }, null, 2)}\n`)
    const current = await prepareGeneratedEnvironmentCurrentness({ configPath }, { now: () => '2026-10-23T12:00:00.000Z' })
    expect(current.storedProducer).toEqual(prior.producer)
    expect(current.changes).toEqual([{ operation: 'write', path: '.cockpit/generated-environment-ownership.json' }])
    const outputPaths = ['app/.env.example', 'compose.generated.yml', 'docs/cockpit/environment-decisions.md', 'fixtures/personas.generated.ts']
    const canonicalReads: { action: string; entries: { path: string; maxBytes: number; action: string }[]; afterPublication: boolean }[] = []
    let published = false
    expect(await syncGeneratedEnvironment({ configPath }, {
        now: () => '2026-10-23T12:00:00.000Z',
        execute: async step => {
            const read = canonicalOutputRead(step, root, outputPaths)
            if (read) canonicalReads.push({ ...read, afterPublication: published })
            const result = await executeProbe(step)
            if (step.cwd === root && publicationGroups(step, 'publish').length > 0) published = true
            return result
        },
    })).toMatchObject({ kind: 'complete' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ format: 'cockpit-generated-ownership/v3', producer: {
        package: installedPackageMetadata.name, version: installedPackageMetadata.version,
        sourceRevision: installedPackageMetadata.cockpitSourceRevision, producedAt: '2026-10-23T12:00:00.000Z',
    } })
    expect(canonicalReads).toHaveLength(1)
    expect(canonicalReads).toEqual([{ action: 'read-batch', entries: outputPaths.map(path => ({ path, maxBytes: 16_777_216, action: 'read-file' })), afterPublication: true }])
}, 120_000)


describe('generated sibling-root authority', () => {
    // A lexical escape never reaches the resolver: the schema refuses it at load. A symbolic
    // link inside the root is only visible on disk, so the resolver still owns that case.
    it.each([
        ['lexical escape', 'CONFIG_SCHEMA_INVALID'],
        ['symbolic-link escape', 'GENERATED_SIBLING_ROOT_INVALID'],
    ] as const)('refuses a %s before rendering or publication', async (kind, diagnosticCode) => {
        const { root, configPath } = await consumer(`sibling-${kind.replaceAll(' ', '-')}`)
        const siblings = join(root, 'siblings')
        const outside = join(root, 'outside')
        await mkdir(siblings)
        await mkdir(outside)
        let directory = '../outside'
        if (kind === 'symbolic-link escape') {
            await symlink(outside, join(siblings, 'app'))
            directory = 'app'
        }
        const source = (await readFile(configPath, 'utf8'))
            .replace('siblings_root = "."', 'siblings_root = "siblings"')
            .replace('dir = "app"', `dir = ${JSON.stringify(directory)}`)
        await writeFile(configPath, source)

        const result = await syncGeneratedEnvironment({ configPath })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: diagnosticCode })],
        })
        await expect(lstat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses an absolute sibling directory even when the declared root contains it', async () => {
        const { root, configPath } = await consumer('absolute-contained-sibling')
        const source = (await readFile(configPath, 'utf8')).replace(
            'dir = "app"', `dir = ${JSON.stringify(join(root, 'app'))}`,
        )
        await writeFile(configPath, source)

        const result = await syncGeneratedEnvironment({ configPath })
        expect(result, JSON.stringify(result)).toMatchObject({
            kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'CONFIG_SCHEMA_INVALID' })],
        })
    }, 120_000)

    it('publishes a generated build from an authenticated sibling beside the cockpit without writing into it', async () => {
        const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-build-estate-')))
        roots.push(estate)
        const { root, configPath } = await consumer('sibling-build', estate)
        const sibling = join(estate, 'api')
        await mkdir(sibling)
        const dockerfile = 'FROM synthetic.invalid/runtime@sha256:' + 'a'.repeat(64) + '\n'
        await writeFile(join(sibling, 'Dockerfile'), dockerfile)
        await writeFile(configPath, `
[cockpit]
name = "sibling-build"
siblings_root = ".."

[[sibling]]
slug = "api"
dir = "api"
mount = "always"
acquire = "none"
var = "API_DIR"
purpose = "Synthetic API"

[ports]
bases = {}

[environment.generated]
compose_file = "compose.generated.yml"

[[environment.generated.services]]
id = "api"
sibling = "api"
command = ["node", "server.mjs"]
build = { context = ".", dockerfile = "Dockerfile" }
health = { property = "Synthetic API responds", interval_seconds = 2, timeout_seconds = 2, retries = 10, start_period_seconds = 1, probe = { location = "in-stack", service = "api", cwd = ".", argv = ["node", "--version"], timeout_seconds = 30 } }
`)
        const result = await syncGeneratedEnvironment({ configPath })
        expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, 'compose.generated.yml'), 'utf8')).toContain('context: ../api')
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        expect(await readdir(sibling)).toEqual(['Dockerfile'])
        expect(await readFile(join(sibling, 'Dockerfile'), 'utf8')).toBe(dockerfile)
    }, 120_000)

    it('refuses a vendor template outside the publication root instead of writing a local lookalike', async () => {
        const { root, configPath } = await consumer('external-vendor-template')
        const siblings = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-vendor-siblings-')))
        roots.push(siblings)
        await mkdir(join(siblings, 'app'))
        await writeFile(configPath, (await readFile(configPath, 'utf8')).replace(
            'siblings_root = "."', `siblings_root = ${JSON.stringify(siblings)}`,
        ))

        const result = await syncGeneratedEnvironment({ configPath })

        expect(result).toMatchObject({ kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_TEMPLATE_INVALID' })] })
        for (const path of ['app/.env.example', 'compose.generated.yml', '.cockpit/generated-environment-ownership.json']) {
            await expect(lstat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await expect(lstat(join(siblings, 'app/.env.example'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})


describe('selected bootstrap target', () => {
    it.each([
        ['claudecode', 2],
        ['codexcli', 3],
        ['opencode', 2],
    ] as const)('publishes only the exact %s bootstrap set through one issued authority', async (target, count) => {
        const root = await realpath(await mkdtemp(join(tmpdir(), `cockpit-setup-${target}-`)))
        roots.push(root)
        const prepared = await prepareSelectedBootstrapSurface({ root, target })
        expect(prepared).toMatchObject({ kind: 'complete', result: { root, target } })
        if (prepared.kind !== 'complete') return
        expect(prepared.result.files).toHaveLength(count)
        expect(prepared.result.sources).toHaveLength(8)
        if (target === 'codexcli') expect(prepared.result.files.map(row => row.path))
            .toContain('.agents/skills/cockpit-setup/agents/openai.yaml')
        expect(await applySelectedBootstrapSurface({ ...prepared.authority })).toMatchObject({ kind: 'refusal' })
        const applied = await applySelectedBootstrapSurface(prepared.authority)
        expect(applied).toMatchObject({ kind: 'complete', result: { root, target, files: prepared.result.files } })
        expect(await Promise.all(prepared.result.files.map(row => readFile(join(root, row.path), 'utf8').then(digest))))
            .toEqual(prepared.result.files.map(row => row.sha256))
        await expect(readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await applySelectedBootstrapSurface(prepared.authority)).toMatchObject({ kind: 'refusal' })

        const repeated = await prepareSelectedBootstrapSurface({ root, target })
        expect(repeated).toMatchObject({ kind: 'complete', result: { changes: [] } })
        if (repeated.kind === 'complete') expect(await applySelectedBootstrapSurface(repeated.authority))
            .toMatchObject({ kind: 'complete', result: { changes: [] } })
    }, 120_000)

    it('refuses changed destination preimages and copied preparation data', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-setup-preimage-')))
        roots.push(root)
        const prepared = await prepareSelectedBootstrapSurface({ root, target: 'codexcli' })
        if (prepared.kind !== 'complete') throw new Error('bootstrap preparation was refused')
        await mkdir(dirname(join(root, prepared.result.files[0]!.path)), { recursive: true })
        await writeFile(join(root, prepared.result.files[0]!.path), 'changed\n')
        expect(await applySelectedBootstrapSurface(prepared.authority)).toMatchObject({ kind: 'refusal' })
        expect(await prepareSelectedBootstrapSurface({ ...prepared.result, target: 'codexcli' } as never)).toMatchObject({ kind: 'refusal' })
    }, 120_000)

    it('adopts only the exact state publication and anchored bootstrap outputs during first sync', async () => {
        const { root, configPath } = await consumer('bootstrap-adoption')
        const prepared = await prepareSelectedBootstrapSurface({ root, target: 'codexcli' })
        if (prepared.kind !== 'complete') throw new Error('bootstrap preparation was refused')
        const applied = await applySelectedBootstrapSurface(prepared.authority)
        if (applied.kind !== 'complete') throw new Error('bootstrap publication was refused')
        // The bootstrap skill is consumer output like the full render, so it carries no development markers.
        await expect(readFile(join(root, '.agents/skills/cockpit-setup/SKILL.md'), 'utf8')).resolves.not.toMatch(/cockpit:verified|SHIPPED SURFACE/)

        const stateHome = await mkdtemp(join(tmpdir(), 'cockpit-setup-state-'))
        roots.push(stateHome)
        const selected = await selectBootstrapStateRoot({ platform: 'linux', home: stateHome, checkoutRoot: root, target: 'codexcli' })
        if (selected.kind !== 'complete') throw new Error('bootstrap state selection was refused')
        const address = selected.value.paths.bootstrap('codexcli')
        const record: BootstrapStateRecord = {
            format: 'cockpit-state/v1', kind: 'bootstrap', checkoutId: address.checkoutId, target: 'codexcli', revision: 0,
            updatedAt: '2026-10-25T12:00:00.000Z', value: {
                stage: 'surface-published', checkoutRoot: root, target: 'codexcli',
                sources: prepared.result.sources.map(row => ({ ...row })),
                commandSha256: digest('cockpit init'), previewSha256: prepared.result.previewSha256,
                published: prepared.result.files.map(row => ({ ...row })), destination: null, artifactBytes: null, artifactSha256: null,
            },
        }
        const publication = await transactState(selected.value, address, {
            ownerId: bootstrapHolderId({ checkoutId: address.checkoutId, sessionId: 'adoption' }),
        }, () => record)
        if (publication.kind !== 'complete') throw new Error('bootstrap state publication was refused')

        expect(await syncGeneratedEnvironment({ configPath,
            bootstrapState: { publication: { ...publication }, address } })).toMatchObject({ kind: 'refusal' })
        const first = join(root, prepared.result.files[0]!.path)
        const bytes = await readFile(first)
        await writeFile(first, 'changed after bootstrap publication\n')
        expect(await syncGeneratedEnvironment({ configPath,
            bootstrapState: { publication, address } })).toMatchObject({ kind: 'refusal' })
        await writeFile(first, bytes)

        expect(await generatedCommands.resumeSelectedBootstrapSurface({ root, target: 'codexcli', address }))
            .toMatchObject({ kind: 'pending', canonicalOwnership: false })
        const adopted = await syncGeneratedEnvironment({ configPath, bootstrapState: { publication, address } })
        expect(adopted, JSON.stringify(adopted.diagnostics)).toMatchObject({ kind: 'complete' })
        const manifest = JSON.parse(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8'))
        expect(manifest).toMatchObject({ format: 'cockpit-generated-ownership/v3' })
        expect(manifest.entries.filter((entry: { harnesses?: string[] }) => entry.harnesses))
            .toEqual(expect.arrayContaining(prepared.result.files.map(file => expect.objectContaining({ path: file.path, sha256: file.sha256 }))))
        // One repository is an ordinary estate: adopting the bootstrap skills does not narrow what is published.
        expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining(['AGENTS.md', '.cockpit/guards/bash-guard.sh']))
        await expect(readFile(join(root, 'compose.generated.yml'), 'utf8')).resolves.toContain('services:')
        await expect(readFile(join(root, 'fixtures/personas.generated.ts'), 'utf8')).resolves.toContain('first')
        expect(await syncGeneratedEnvironment({ configPath,
            bootstrapState: { publication, address } })).toMatchObject({ kind: 'refusal' })
        const resumed = await generatedCommands.resumeSelectedBootstrapSurface({ root, target: 'codexcli', address })
        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', canonicalOwnership: true,
            result: { previewSha256: prepared.result.previewSha256, files: prepared.result.files } })
        if (!resumed || resumed.kind !== 'complete') throw new Error('canonical bootstrap resume was refused')
        expect('authority' in resumed).toBe(false)
        expect(await generatedCommands.resumeSelectedBootstrapSurface({ root, target: 'codexcli',
            address: { ...address, checkoutRoot: root + '-other' } })).toMatchObject({ kind: 'refusal' })
        await writeFile(join(root, 'compose.generated.yml'), 'drift after initial sync\n')
        expect(await generatedCommands.resumeSelectedBootstrapSurface({ root, target: 'codexcli', address }))
            .toMatchObject({ kind: 'complete', canonicalOwnership: true })
        expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        await writeFile(join(root, '.cockpit/generated-environment-ownership.json'), '{}')
        expect(await generatedCommands.resumeSelectedBootstrapSurface({ root, target: 'codexcli', address })).toMatchObject({ kind: 'refusal' })
    }, 120_000)
})


it('publishes the guard handler identity only to the ignored machine-local file and detects registration drift', async () => {
    const { root, configPath } = await surfaceConsumer('authenticated-guard')
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0)
    expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    const guard = await readFile(join(root, '.cockpit/guards/bash-guard.sh'), 'utf8')
    expect(guard).not.toContain(await realpath(root))
    expect(guard).not.toContain(digest(await readFile(configPath)))
    const local = await readFile(join(root, '.cockpit/local/guard-identity'), 'utf8')
    expect(local).toContain(await realpath(configPath))
    expect(local).toContain(digest(await readFile(configPath)))
    expect(spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '.cockpit/local/guard-identity']).status).toBe(0)
    expect(guard).not.toContain('check_instance_path')
    expect(guard).not.toContain('hosted_db_hosts_json')
    await writeFile(join(root, '.codex/hooks.json'), '{}\n')
    expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal' })
}, 120_000)

it('names a deleted generated file and ignores a re-created identical configuration', async () => {
    const { root, configPath } = await surfaceConsumer('recreated-config')
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0)
    expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    // `git restore` and editors that save by rename leave the same bytes in a new file; the committed
    // guard used to embed the configuration's inode, so check blamed the guard for that.
    const source = await readFile(configPath)
    await rm(configPath)
    await writeFile(configPath, source)
    expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    const guide = await readFile(join(root, 'AGENTS.md'))
    await rm(join(root, 'AGENTS.md'))
    expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal',
        diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', target: 'AGENTS.md' })] })
    await writeFile(join(root, 'AGENTS.md'), guide)
}, 120_000)

it('consumes vendor and exact build/test authority through installed hook registrations', async () => {
    const { root, configPath } = await surfaceConsumer('installed-authority')
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0)
    await writeFile(join(root, 'app/package-lock.json'), '{}')
    expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    const registered = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8')).hooks.PreToolUse
        .flatMap((row: { hooks: { command: string }[] }) => row.hooks).find((row: { command: string }) => row.command.includes('bash-guard.sh')).command as string
    const hook = await registered('.claude/settings.json')
    const invoke = (command: string, cwd = join(root, 'app'), registration = hook) => {
        const result = spawnSync('/bin/sh', ['-c', registration], {
            cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
        })
        expect(result.stderr).not.toContain('"invocation":')
        return result
    }
    const codexDenied = invoke('curl https://api.vendor.example.test/messages', root, await registered('.codex/hooks.json'))
    expect(codexDenied).toMatchObject({ status: 0, stderr: '' })
    expect(JSON.parse(codexDenied.stdout))
        .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Refusing executable use of a declared vendor host.' } })
    expect(invoke('npm run build')).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(invoke('npm test -- unit.test.ts')).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(invoke('npm run build --extra').stdout).toContain('permissionDecision":"ask')
    expect(invoke('npm run build', root).stdout).toContain('permissionDecision":"ask')
    expect(invoke('curl https://api.vendor.example.test/messages').stdout).toContain('permissionDecision":"deny')
    expect(invoke('curl https://other.vendor.example.test/messages').stdout).toContain('permissionDecision":"ask')
    expect(invoke('npm run build; curl https://api.vendor.example.test/messages').stdout).toContain('permissionDecision":"deny')
    expect(invoke('git push origin main').stdout).toContain('permissionDecision":"deny')
    expect(invoke('git reset --hard HEAD').stdout).toContain('permissionDecision":"ask')
    expect(invoke('git add .env').stdout).toContain('permissionDecision":"deny')
    const launcher = fileURLToPath(new URL('../../bin/cockpit.mjs', import.meta.url))
    expect(invoke(`${JSON.stringify(launcher)} check --config ${JSON.stringify(configPath)}`, root)).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(invoke(`${JSON.stringify(launcher)} check --config ${JSON.stringify(configPath)} --unknown`, root).stdout).toContain('permissionDecision":"ask')
    expect(invoke(`${JSON.stringify(launcher)} down --config ${JSON.stringify(configPath)}`, root).stdout).toContain('permissionDecision":"ask')
    const original = await readFile(configPath, 'utf8')
    await writeFile(configPath, original.replace('api.vendor.example.test', 'replacement.vendor.example.test')
        .replace('build = [ "npm", "run", "build" ]\n', '').replace('test = [ "npm", "test", "--", "unit.test.ts" ]\n', ''))
    expect(invoke('npm run build')).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining(`Fix: a human must run \`cockpit sync --config ${await realpath(configPath)}\` in a terminal`) })
    expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    expect(invoke('npm run build').stdout).toContain('permissionDecision":"ask')
    expect(invoke('npm test -- unit.test.ts').stdout).toContain('permissionDecision":"ask')
    expect(invoke('curl https://api.vendor.example.test/messages').stdout).toContain('permissionDecision":"ask')
    expect(invoke('curl https://replacement.vendor.example.test/messages').stdout).toContain('permissionDecision":"deny')
    await writeFile(join(root, '.claude/settings.json'), '{}\n')
    expect(invoke('npm run build')).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('drifted') })
}, 120_000)

it('rolls back the whole guard publication when a staged registration cannot be published', async () => {
    const { root, configPath } = await surfaceConsumer('guard-rollback')
    const initial = await syncGeneratedEnvironment({ configPath })
    if (initial.kind !== 'complete') throw new Error(JSON.stringify(initial))
    const before = await bytes(root, [...initial.result.paths, '.cockpit/generated-environment-ownership.json'])
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('[guards]', '[guards]\nask_is_deny_on = ["codex", "claude"]'))
    let injected = false
    const result = await syncGeneratedEnvironment({ configPath }, { execute: async step => {
        const groups = publicationGroups(step, 'publish')
        if (!injected && groups.some(group => group.parent === '.claude')) {
            injected = true
            return executeProbe(Object.freeze({ ...step, cwd: join(root, 'missing-publication-directory') }))
        }
        return executeProbe(step)
    } })
    expect(injected).toBe(true)
    expect(result.kind).toBe('refusal')
    expect(await bytes(root, [...initial.result.paths, '.cockpit/generated-environment-ownership.json'])).toEqual(before)
}, 120_000)

it('keeps the installed guard untouched when replacement handler authentication fails before staging', async () => {
    const { root, configPath } = await surfaceConsumer('guard-handler-refusal')
    const initial = await syncGeneratedEnvironment({ configPath })
    if (initial.kind !== 'complete') throw new Error(JSON.stringify(initial))
    const before = await bytes(root, [...initial.result.paths, '.cockpit/generated-environment-ownership.json'])
    await writeFile(configPath, (await readFile(configPath, 'utf8')) + '\n# synthetic source change\n')
    let refused = false
    let preparations = 0
    const moduleDirectory = fileURLToPath(new URL('../../dist/', import.meta.url)).replace(/\/$/, '')
    const result = await syncGeneratedEnvironment({ configPath }, { execute: async step => {
        if (step.labels.action === 'prepare') preparations += 1
        if (!refused && step.cwd === moduleDirectory && step.labels.action === 'read-file') {
            refused = true
            return executeProbe({ ...step, cwd: join(root, 'missing-handler-directory') })
        }
        return executeProbe(step)
    } })
    expect(refused).toBe(true)
    expect(preparations).toBe(0)
    expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_EXECUTABLE_UNAVAILABLE' })] })
    expect(await bytes(root, [...initial.result.paths, '.cockpit/generated-environment-ownership.json'])).toEqual(before)
}, 120_000)


describe('generated environment command', () => {
    it('updates every declared persona projection from the authenticated source', async () => {
        const { root, configPath } = await consumer('personas')
        const declaration = await readFile(configPath, 'utf8')
        await writeFile(configPath, declaration.replace(
            '[[environment.generated.data.fixtures.persona_outputs]]\npath = "fixtures/personas.generated.ts"\nformat = "typescript"\nreason = "Synthetic typed consumer"',
            '[[environment.generated.data.fixtures.persona_outputs]]\npath = "fixtures/personas.generated.ts"\nformat = "typescript"\nreason = "Synthetic typed consumer"\n\n[[environment.generated.data.fixtures.persona_outputs]]\npath = "fixtures/personas.generated.json"\nformat = "json"\nreason = "Synthetic JSON consumer"',
        ))
        const synced = await syncGeneratedEnvironment({ configPath })
        expect(synced).toMatchObject({ kind: 'complete' })
        if (synced.kind !== 'complete') return
        const projected = synced.result.paths.filter((path) => path.startsWith('fixtures/personas.generated.'))
        expect(projected).toEqual(['fixtures/personas.generated.json', 'fixtures/personas.generated.ts'])
        const before = await bytes(root, projected)

        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        const drift = await checkGeneratedEnvironment({ configPath })
        expect(drift).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT' })] })
        const resynced = await syncGeneratedEnvironment({ configPath })
        expect(resynced.kind).toBe('complete')
        const after = await bytes(root, projected)
        expect(after['fixtures/personas.generated.json']).not.toBe(before['fixtures/personas.generated.json'])
        expect(after['fixtures/personas.generated.ts']).not.toBe(before['fixtures/personas.generated.ts'])
    }, 120_000)

    it('removes exact stale outputs after declaration changes', async () => {
        const removable = await consumer('removed-output')
        expect((await syncGeneratedEnvironment({ configPath: removable.configPath })).kind).toBe('complete')
        const declaration = await readFile(removable.configPath, 'utf8')
        await writeFile(removable.configPath, declaration.replace(
            'path = "fixtures/personas.generated.ts"',
            'path = "fixtures/personas.generated.json"',
        ).replace('format = "typescript"', 'format = "json"'))
        const stale = await checkGeneratedEnvironment({ configPath: removable.configPath })
        expect(stale).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_ARTIFACT', target: 'fixtures/personas.generated.ts' })],
        })
        const stalePersona = await readFile(join(removable.root, 'fixtures/personas.generated.ts'))
        const retained = await syncGeneratedEnvironment(
            { configPath: removable.configPath },
            staleRemovalAuthority([{ path: 'fixtures/personas.generated.ts', kind: 'file', sha256: digest(stalePersona) }]),
        )
        expect(retained.kind).toBe('complete')
        await expect(stat(join(removable.root, 'fixtures/personas.generated.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await checkGeneratedEnvironment({ configPath: removable.configPath })).kind).toBe('complete')
    }, 120_000)

    it('preserves changed stale outputs after declaration changes', async () => {
        const changed = await consumer('changed-removed-output')
        expect((await syncGeneratedEnvironment({ configPath: changed.configPath })).kind).toBe('complete')
        const changedDeclaration = await readFile(changed.configPath, 'utf8')
        await writeFile(changed.configPath, changedDeclaration.replace(
            'path = "fixtures/personas.generated.ts"',
            'path = "fixtures/personas.generated.json"',
        ).replace('format = "typescript"', 'format = "json"'))
        await writeFile(join(changed.root, 'fixtures/personas.generated.ts'), 'consumer bytes\n')
        const refused = await syncGeneratedEnvironment({ configPath: changed.configPath })
        expect(refused).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_ARTIFACT_DRIFT', target: 'fixtures/personas.generated.ts' })],
        })
        expect(await readFile(join(changed.root, 'fixtures/personas.generated.ts'), 'utf8')).toBe('consumer bytes\n')
    })

    it('refuses symlink ancestry and compensates a partial publication', async () => {
        const linked = await consumer('symlink')
        const outside = await mkdtemp(join(tmpdir(), 'cockpit-generated-outside-'))
        roots.push(outside)
        await rm(join(linked.root, 'app'), { recursive: true })
        await symlink(outside, join(linked.root, 'app'))
        const refused = await syncGeneratedEnvironment({ configPath: linked.configPath })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SIBLING_ROOT_INVALID', target: 'sibling' })] })
        await expect(stat(join(outside, '.env.example'))).rejects.toMatchObject({ code: 'ENOENT' })

        const partial = await consumer('partial')
        const initial = await syncGeneratedEnvironment({ configPath: partial.configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return
        const original = await bytes(partial.root, initial.result.paths)
        await writeFile(join(partial.root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        let publications = 0
        const adapters: Partial<GeneratedEnvironmentCommandAdapters> = {
            execute: async (step) => {
                if (step.labels.action === 'prepare' && ++publications === 2) {
                    const input = step.consumedFiles.find((file) => !file.executable)
                    if (input) await writeFile(input.path, 'changed before execution\n')
                }
                return executeProbe(step)
            },
        }
        const failed = await syncGeneratedEnvironment({ configPath: partial.configPath }, adapters)
        expect(failed).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
        expect(await bytes(partial.root, initial.result.paths)).toEqual(original)
        expect(await readFile(join(partial.root, 'app/.env.example'), 'utf8')).toBe(original['app/.env.example'])
        expect(await readFile(join(partial.root, 'unmanaged.txt'), 'utf8')).toBe('keep\n')

        const changed = await consumer('changed-ancestry')
        const changedOutside = await mkdtemp(join(tmpdir(), 'cockpit-generated-changed-outside-'))
        roots.push(changedOutside)
        const changedAncestry = await syncGeneratedEnvironment(
            { configPath: changed.configPath },
            {
                observeSource: async (path) => {
                    await rm(join(changed.root, 'app'), { recursive: true })
                    await symlink(changedOutside, join(changed.root, 'app'))
                    return observeConfigSource(path)
                },
            },
        )
        expect(changedAncestry).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })],
        })
        await expect(stat(join(changedOutside, '.env.example'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('does not publish or compensate through a parent replaced during publication', async () => {
        const consumerRoot = await consumer('publication-race')
        expect((await syncGeneratedEnvironment({ configPath: consumerRoot.configPath })).kind).toBe('complete')
        const original = await readFile(join(consumerRoot.root, 'docs/cockpit/environment-decisions.md'), 'utf8')
        const declaration = await readFile(consumerRoot.configPath, 'utf8')
        await writeFile(consumerRoot.configPath, declaration.replace('Keep the synthetic environment reproducible', 'Keep the updated synthetic environment reproducible'))
        let swapped = false
        const held = join(consumerRoot.root, 'docs/cockpit-held')
        const outcome = await syncGeneratedEnvironment(
            { configPath: consumerRoot.configPath },
            {
                execute: async (step) => {
                    if (!swapped && step.labels.action === 'prepare' && step.labels.parent === 'docs/cockpit') {
                        swapped = true
                        await rename(join(consumerRoot.root, 'docs/cockpit'), held)
                        await mkdir(join(consumerRoot.root, 'docs/cockpit'))
                    }
                    return executeProbe(step)
                },
            },
        )

        expect(outcome).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })],
        })
        await expect(stat(join(consumerRoot.root, 'docs/cockpit/environment-decisions.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(held, 'environment-decisions.md'), 'utf8')).toBe(original)
        expect(await readFile(join(consumerRoot.root, 'unmanaged.txt'), 'utf8')).toBe('keep\n')
    })

    it('restores a group when publication fails after its first target mutation', async () => {
        const { root, configPath } = await consumer('interrupted-group')
        const declaration = await readFile(configPath, 'utf8')
        await writeFile(configPath, declaration.replace(
            '[[environment.generated.data.fixtures.persona_outputs]]\npath = "fixtures/personas.generated.ts"\nformat = "typescript"\nreason = "Synthetic typed consumer"',
            '[[environment.generated.data.fixtures.persona_outputs]]\npath = "fixtures/personas.generated.ts"\nformat = "typescript"\nreason = "Synthetic typed consumer"\n\n[[environment.generated.data.fixtures.persona_outputs]]\npath = "fixtures/personas.generated.json"\nformat = "json"\nreason = "Synthetic JSON consumer"',
        ))
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return
        const paths = ['fixtures/personas.generated.json', 'fixtures/personas.generated.ts']
        const before = await bytes(root, paths)
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        let planted = false
        const outcome = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                const group = publicationGroups(step, 'publish').find(group => group.parent === 'fixtures')
                if (!planted && group) {
                    planted = true
                    const stage = group.entries[1]!.stage
                    if (!stage) throw new Error('the synthetic publication stage is missing')
                    await writeFile(join(root, group.parent, stage), 'changed before publication\n')
                }
                return executeProbe(step)
            },
        })

        expect(outcome).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })],
        })
        expect(await bytes(root, paths)).toEqual(before)
        expect((await readdir(join(root, 'fixtures'))).filter((name) => name.startsWith('.cockpit-'))).toEqual([])
    })

    it('retains recovery records when publication finalization is not confirmed', async () => {
        const { root, configPath } = await consumer('finalization-recovery')
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        let refused = false
        const outcome = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                if (!refused && step.labels.action === 'commit-batch') {
                    refused = true
                    return executeProbe(Object.freeze({ ...step, cwd: join(root, 'app') }))
                }
                return executeProbe(step)
            },
        })

        expect(outcome).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_COMPENSATION_FAILED' })],
        })
        expect(refused).toBe(true)
        expect(await readFile(join(root, 'fixtures/personas.generated.ts'), 'utf8')).toBe('export default [\n  {\n    "id": "changed"\n  }\n] as const\n')
        if (outcome.kind !== 'refusal') return
        const target = outcome.diagnostics[0]?.target
        if (!target) throw new Error('compensation diagnostic omitted the recovery target')
        const recovery = target.split('; inputs=')[1]
        if (!recovery) throw new Error('compensation diagnostic omitted the recovery inputs path')
        expect((await readdir(recovery)).some((name) => /^recovery-\d{4}\.json$/.test(name))).toBe(true)
        await rm(recovery, { recursive: true, force: true })
    })

    it.each([
        ['compose.generated.yml', 'duplicate'],
        ['fixtures/personas.json', 'source-overlap'],
    ])('refuses the owned destination %s before publication', async (destination, name) => {
        const { root, configPath } = await consumer(name)
        const declaration = await readFile(configPath, 'utf8')
        await writeFile(configPath, declaration.replace(
            'path = "fixtures/personas.generated.ts"',
            `path = ${JSON.stringify(destination)}`,
        ))

        const refused = await syncGeneratedEnvironment({ configPath })
        expect(refused).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_PATH_DUPLICATE' })],
        })
        if (destination === 'compose.generated.yml') {
            await expect(stat(join(root, destination))).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
            expect(await readFile(join(root, destination), 'utf8')).toBe('[{"id":"first"}]\n')
        }
    })

    it('does not accept a caller-selected freshness clock', async () => {
        const { root, configPath } = await consumer('clock')
        const refused = await syncGeneratedEnvironment({ configPath, now: '2026-01-01' } as never)

        expect(refused).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_INPUT_INVALID' })],
        })
        await expect(stat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses a source change immediately before publication', async () => {
        const { root, configPath } = await consumer('source-change')
        let observations = 0
        const adapters: Partial<GeneratedEnvironmentCommandAdapters> = {
            observeSource: async (path) => {
                observations += 1
                if (observations === 1) await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n`)
                return observeConfigSource(path)
            },
        }
        const result = await syncGeneratedEnvironment({ configPath }, adapters)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })] })
        await expect(stat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })

        const persona = await consumer('persona-source-change')
        const personaResult = await syncGeneratedEnvironment(
            { configPath: persona.configPath },
            {
                observeSource: async (path) => {
                    await writeFile(join(persona.root, 'fixtures/personas.json'), '[{"id":"changed-before-commit"}]\n')
                    return observeConfigSource(path)
                },
            },
        )
        expect(personaResult).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED', target: 'fixtures/personas.json' })],
        })
        await expect(stat(join(persona.root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

})
