import { readFile, stat, symlink, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'

import { observeConfigSource } from '../config/load.js'
import {
    type GeneratedEnvironmentCommandAdapters,
} from '../environment/generated-application.js'
import { applyGeneratedEnvironmentRepair, applySelectedBootstrapSurface, prepareGeneratedEnvironmentCurrentness,
    prepareSelectedBootstrapSurface, syncGeneratedEnvironment } from './command.js'

import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { roots, cleanup, consumer, digest, bytes } = createGeneratedCommandFixture()

describe('public generated repair', () => {
    it.each(['source', 'target'] as const)('refuses a changed %s after public repair preparation without publication', async changed => {
        const { root, configPath } = await consumer(`public-repair-${changed}`)
        const current = await prepareGeneratedEnvironmentCurrentness({ configPath })
        if (!current.repairAuthority) throw new Error('changed-after-preparation authority was not issued')
        const path = changed === 'source' ? configPath : join(root, 'AGENTS.md')
        const bytes = changed === 'source' ? `${await readFile(configPath, 'utf8')}\n# changed after preparation\n` : 'foreign target\n'
        await writeFile(path, bytes)
        const result = await applyGeneratedEnvironmentRepair(current.repairAuthority)
        expect(result).toMatchObject({ kind: 'refusal' })
        expect(result.diagnostics[0]!.code).toBe('GENERATED_SOURCE_CHANGED')
        expect(await readFile(path, 'utf8')).toBe(bytes)
        await expect(lstat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})

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
        await expect(lstat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
})


describe('generated environment command', () => {
    it('does not accept a caller-selected freshness clock', async () => {
        const { root, configPath } = await consumer('clock')
        const refused = await syncGeneratedEnvironment({ configPath, now: '2026-01-01' } as never)

        expect(refused).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_INPUT_INVALID' })],
        })
        await expect(stat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
        await expect(stat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
