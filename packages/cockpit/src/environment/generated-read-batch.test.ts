import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFile, readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { SURFACE_TARGETS } from '../surfaces/harness-registry.js'
import { executeProbe } from '../environment-exec/execute.js'
import { resolveGitExecutable } from './executable.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'
import { nodeAuthority, readAnchoredBatches } from '../generated-environment/transaction.js'
import { cockpitId, publicationCockpitId } from './identity.js'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'

const roots: string[] = []
const fixture = resolve('fixtures/registries/generated-environment.toml')

async function explicitNativeHookFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-hook-outcome-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    const policyPath = '.cockpit/guards/bash-guard.sh'
    const policyBytes = 'native-hook-ms=1\n'
    const policySha256 = createHash('sha256').update(policyBytes).digest('hex')
    const source = `${(await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    )}
[testing]
stages = [{ id = "unit", command = ["npm", "test"], requires_stack = false }]
gates = [{ id = "focused", tier = "targeted", stages = ["unit"], changes = "Synthetic focused change" }]
native_hooks = { install = "explicit-native" }
native_hook_policy = { path = ${JSON.stringify(policyPath)}, sha256 = ${JSON.stringify(policySha256)} }
`
    await writeFile(configPath, source)
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    const personaBytes = '[{"id":"first"}]\n'
    await writeFile(join(root, 'fixtures/personas.json'), personaBytes)
    await mkdir(join(root, '.cockpit/guards'), { recursive: true })
    await writeFile(join(root, policyPath), policyBytes)
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') throw new Error('native hook fixture configuration unavailable')
    const currentCockpit = publicationCockpitId({ name: loaded.result.config.cockpit.name })
    const ownership = encodeOwnershipManifest({ root, cockpitId: currentCockpit, configPath,
        generation: createHash('sha256').update('synthetic native hook generation').digest('hex'),
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        personaSource: { path: 'fixtures/personas.json', sha256: createHash('sha256').update(personaBytes).digest('hex') },
        owned: [{ path: policyPath, sha256: policySha256 }], surfaces: [] })
    const ownershipPath = join(root, '.cockpit/generated-environment-ownership.json')
    await writeFile(ownershipPath, ownership.bytes)
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0)
    expect(spawnSync('git', ['-C', root, 'config', 'user.name', 'Synthetic Fixture']).status).toBe(0)
    expect(spawnSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']).status).toBe(0)
    expect(spawnSync('git', ['-C', root, 'add', 'cockpit.toml', 'fixtures/personas.json']).status).toBe(0)
    expect(spawnSync('git', ['-C', root, 'commit', '--quiet', '-m', 'synthetic fixture']).status).toBe(0)
    expect(spawnSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'synthetic parent']).status).toBe(0)
    const revisions = spawnSync('git', ['-C', root, 'rev-list', '--max-count=2', 'HEAD'], { encoding: 'utf8' })
    expect(revisions.status).toBe(0)
    const [head, parent] = revisions.stdout.trim().split('\n')
    const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
    if (git.state !== 'available') throw new Error('native hook fixture Git authority unavailable')
    const bin = join(root, 'bin')
    const calls = join(root, 'git-calls')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), `#!/bin/sh
if [ "$PWD" != '${root.replaceAll("'", "'\\''")}' ]; then
    printf 'unexpected synthetic git working directory\\n' >&2; exit 64
fi
if [ "$#" -eq 3 ] && [ "$1" = rev-list ] && [ "$2" = --max-count=2 ] && [ "$3" = HEAD ]; then
    printf '%s\\n' "$*" >> '${calls.replaceAll("'", "'\\''")}'
    printf '%s\\n' '${head}' '${parent}'
elif [ "$#" -eq 4 ] && [ "$1" = merge-base ] && [ "$2" = --is-ancestor ] && [ "$3" = '${parent}' ] && [ "$4" = '${head}' ]; then
    printf '%s\\n' "$*" >> '${calls.replaceAll("'", "'\\''")}'
    exit 0
else
    exec '${git.value.canonicalPath.replaceAll("'", "'\\''")}' "$@"
fi
`, { mode: 0o700 })
    return { root, configPath, policyPath, ownership, ownershipPath, bin, calls, head, parent }
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('generated application authenticated read batching', () => {
    async function deepSources() {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cb-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        const directory = Array.from({ length: 450 }, () => 'd').join('/')
        await mkdir(join(root, 'app', directory), { recursive: true })
        await mkdir(join(root, 'fixtures'), { recursive: true })
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
        const sources = Array.from({ length: 16 }, (_, index) => {
            const bytes = JSON.stringify({ mcpServers: { [`server-${index}`]: { command: '/usr/bin/true' } } }) + '\n'
            return { path: `${directory}/${index}.json`, bytes, maxBytes: Buffer.byteLength(bytes) }
        })
        for (const source of sources) await writeFile(join(root, 'app', source.path), source.bytes)
        const declaration = (await readFile(fixture, 'utf8')).replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        ) + `\n[sibling.derives]\nmcp_sources = [${sources.map(source =>
            `{ path = ${JSON.stringify(source.path)}, provenance = { source = "synthetic declaration", observed_on = "2026-09-26", kind = "declared", reason = "Synthetic MCP source" } }`,
        ).join(',')}]\n`
        await writeFile(configPath, declaration)
        return { root, configPath, sources }
    }

    async function exerciseLargePrivateReceipt(fixture: Awaited<ReturnType<typeof deepSources>>, tamper: boolean) {
        const node = await nodeAuthority()
        if (!node) throw new Error('Node authority unavailable')
        const receipts: number[] = []
        const batchSizes: number[] = []
        let changed = false
        // Normal MCP revalidation splits four 16 MiB rows per batch. Exact source bounds keep
        // these 16 rows together so receipt size does not depend on device or inode width.
        const result = await readAnchoredBatches(join(fixture.root, 'app'), fixture.sources.map(source => ({
            path: source.path, maxBytes: source.maxBytes, action: 'read-file' as const,
        })), node, {
            execute: async step => {
                const outcome = await executeProbe(step)
                if (step.labels.action === 'read-batch' && outcome.kind === 'complete') {
                    const request = JSON.parse(step.argv[3]!) as { entries: unknown[]; receiptOutput: string }
                    const receiptBytes = (await readFile(request.receiptOutput)).length
                    batchSizes.push(request.entries.length)
                    receipts.push(receiptBytes)
                    if (tamper && receiptBytes > 65_536) {
                        await writeFile(request.receiptOutput, '{}\n')
                        changed = true
                    }
                }
                return outcome
            },
        })
        return { result, receipts, batchSizes, changed }
    }

    it('authenticates a private batch receipt larger than the process frame', async () => {
        const fixture = await deepSources()
        const batch = await exerciseLargePrivateReceipt(fixture, false)
        expect(batch.result).toMatchObject({ kind: 'complete', results: expect.any(Array) })
        expect(batch.batchSizes).toEqual([16])
        expect(batch.receipts).toHaveLength(1)
        expect(batch.receipts[0]).toBeGreaterThan(65_536)
        const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })
        expect(synchronized, JSON.stringify(synchronized)).toMatchObject({ kind: 'complete', result: { dryRun: true } })
    })

    it('refuses a private batch receipt changed after authenticated execution', async () => {
        const fixture = await deepSources()
        const batch = await exerciseLargePrivateReceipt(fixture, true)
        expect(batch.batchSizes).toEqual([16])
        expect(batch.receipts).toHaveLength(1)
        expect(batch.receipts[0]).toBeGreaterThan(65_536)
        expect(batch.changed).toBe(true)
        expect(batch.result).toBeUndefined()

        let changed = false
        const sourcePaths = new Set(fixture.sources.map(source => source.path))
        const result = await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true }, {
            execute: async step => {
                const outcome = await executeProbe(step)
                if (!changed && step.cwd === join(fixture.root, 'app')
                    && step.labels.action === 'read-batch' && outcome.kind === 'complete') {
                    const request = JSON.parse(step.argv[3]!) as {
                        entries: Array<{ segments: string[]; name: string }>
                        receiptOutput?: string
                    }
                    const readsDeclaredSource = request.entries.some(entry =>
                        sourcePaths.has([...entry.segments, entry.name].join('/')))
                    if (request.receiptOutput && readsDeclaredSource) {
                        await writeFile(request.receiptOutput, '{}\n')
                        changed = true
                    }
                }
                return outcome
            },
        })
        expect(changed).toBe(true)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'GENERATED_SOURCE_CHANGED', target: 'generated-environment',
        })] })
    })

    it.each(['missing', 'changed'])('authenticates collection source %s on revalidation', async fault => {
        const { configPath } = await deepSources()
        let seen = 0
        let faulted = false
        const result = await syncGeneratedEnvironment({ configPath, dryRun: true }, {
            execute: async step => {
                if (step.labels.action === 'read-batch') {
                    const request = JSON.parse(step.argv[3]!) as { entries: Array<{ segments: string[]; name: string; output: string }> }
                    const collection = request.entries.find(entry => [...entry.segments, entry.name].join('/') === 'skills/collection.json')
                    if (collection && ++seen === 2) {
                        faulted = true
                        if (fault === 'missing') return executeProbe({ ...step, argv: [step.argv[0], ...step.argv.slice(1).map((value, index) => index === 2
                            ? JSON.stringify({ ...request, entries: request.entries.map(entry => entry === collection ? { ...entry, name: 'missing-collection.json' } : entry) }) : value)] })
                        const outcome = await executeProbe(step)
                        await writeFile(collection.output, '{}\n')
                        return outcome
                    }
                }
                return executeProbe(step)
            },
        })
        expect(faulted).toBe(true)
        expect(seen).toBe(2)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })] })
    })

    it('observes absent outputs and current sources through bounded authenticated batches', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-generated-read-batch-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        // Every shipped tool is listed so the surface inventory outgrows one 64-entry batch.
        const declaration = `${(await readFile(fixture, 'utf8')).replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        )}\n[surfaces]\ntools = ${JSON.stringify(SURFACE_TARGETS)}\n`
        await writeFile(configPath, declaration)
        await mkdir(join(root, 'app'), { recursive: true })
        await mkdir(join(root, 'fixtures'), { recursive: true })
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')

        const batches: Array<{
            nonce: string
            entries: Array<{
                nonce: string
                action: string
                segments: string[]
                name: string
                maxBytes: number
                output: string
            }>
        }> = []
        const surfaceAssets = new Set([
            'agents/evaluator.agent.md',
            'skills/collection.json',
            'skills/cockpit-setup.skill.md',
            'skills/cockpit-explain.skill.md',
            'skills/cockpit-fix.skill.md',
            'skills/cockpit-work.skill.md',
            'skills/procedures/setup.md',
            'skills/procedures/explain.md',
            'skills/procedures/fix.md',
            'skills/procedures/work.md',
            'references/test-data-and-personas.md',
            'guards/bash-guard.sh',
            'guards/claude.adapter.json',
            'guards/codex.adapter.json',
            'guards/opencode.adapter.json',
            'skills/cockpit-browser.skill.md',
            'references/browser.md',
            'references/testing-tiers.md',
        ])
        const individualSurfaceAssets: string[] = []
        const ownershipReadOffsets: number[] = []
        const singleEntryReads: Array<{ offset: number; path: string }> = []
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                if (step.labels.action === 'read-batch') batches.push(JSON.parse(step.argv[3]!))
                if (step.labels.action === 'read-entry') {
                    const request = JSON.parse(step.argv[3]!) as { segments: string[]; name: string }
                    if ([...request.segments, request.name].join('/') === '.cockpit/generated-environment-ownership.json') {
                        ownershipReadOffsets.push(batches.length)
                    }
                    singleEntryReads.push({ offset: batches.length, path: [...request.segments, request.name].join('/') })
                }
                if (step.labels.action === 'read-file') {
                    const request = JSON.parse(step.argv[3]!) as { segments: string[]; name: string }
                    const path = [...request.segments, request.name].join('/')
                    if (surfaceAssets.has(path)) individualSurfaceAssets.push(path)
                }
                return executeProbe(step)
            },
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
        const entries = batches.flatMap(batch => batch.entries)
        expect(batches.length).toBeGreaterThan(0)
        expect(entries.length).toBeGreaterThan(batches.length)
        expect(entries.some(entry => entry.action === 'read-entry')).toBe(true)
        expect(entries.some(entry => entry.action === 'read-file')).toBe(true)
        if (result.kind !== 'complete') return
        const environmentPaths = new Set([
            'app/.env.example',
            'compose.generated.yml',
            'docs/cockpit/environment-decisions.md',
            'env/.secrets/.gitignore',
            'fixtures/personas.generated.ts',
        ])
        const surfacePaths = new Set(result.result.paths.filter(path => !environmentPaths.has(path)))
        const skills = ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work']
        const skillRoots = ['.agents/skills', '.claude/skills', '.opencode/skills', '.cursor/skills', '.grok/skills']
        const expectedSurfacePaths = [
            ...skillRoots.flatMap(prefix => [
                ...skills.flatMap(name => [`${prefix}/${name}/SKILL.md`, `${prefix}/${name}/procedures/${name.slice('cockpit-'.length)}.md`]),
                `${prefix}/cockpit-setup/references/test-data-and-personas.md`,
            ]),
            ...skills.map(name => `.agents/skills/${name}/agents/openai.yaml`),
            '.claude/agents/evaluator.md', '.codex/agents/evaluator.toml', '.opencode/agents/evaluator.md',
            '.cursor/agents/evaluator.md', '.grok/agents/evaluator.md',
            '.claude/settings.json', '.cockpit/guards/bash-guard.sh', '.codex/config.toml', '.codex/hooks.json',
            '.cursor/cli.json', '.grok/config.toml', '.opencode/plugin/cockpit-guards.js',
            'AGENTS.md', 'CLAUDE.md', 'opencode.jsonc',
        ].sort()
        expect([...surfacePaths].sort()).toEqual(expectedSurfacePaths)
        // The application checks the ledger before surface observation; admission reads it again.
        const admissionBatchOffset = ownershipReadOffsets[1]
        expect(admissionBatchOffset).toBeDefined()
        const surfaceObservationBatches = batches.slice(0, admissionBatchOffset).filter(batch => batch.entries.every(entry => entry.maxBytes === 1)
            && batch.entries.some(entry => entry.action === 'read-entry' && surfacePaths.has([...entry.segments, entry.name].join('/'))))
        const observedSurfaceEntries = surfaceObservationBatches.flatMap(batch => batch.entries)
        // A batch holds at most 64 entries; a single remainder is read on its own.
        expect(surfaceObservationBatches.map(batch => batch.entries.length)).toEqual([64])
        const batched = observedSurfaceEntries.map(entry => [...entry.segments, entry.name].join('/'))
        const remainder = new Set(singleEntryReads.filter(read => read.offset <= admissionBatchOffset! && surfacePaths.has(read.path)
            && !batched.includes(read.path)).map(read => read.path))
        expect([...batched, ...remainder].sort())
            .toEqual([...expectedSurfacePaths, 'opencode.json'].sort())
        expect(observedSurfaceEntries.every(entry => entry.action === 'read-entry')).toBe(true)
        expect(surfaceObservationBatches.flatMap(batch => batch.entries).every(entry => entry.maxBytes === 1)).toBe(true)
        const surfaceAssetBatches = batches.filter(batch => batch.entries.length === surfaceAssets.size
            && batch.entries.every(entry => surfaceAssets.has([...entry.segments, entry.name].join('/'))))
        expect(surfaceAssetBatches).toHaveLength(4)
        expect(individualSurfaceAssets).toEqual([])
        for (const batch of batches) {
            expect(batch.nonce).toMatch(/^[a-f0-9]{32}$/)
            expect(batch.entries.length).toBeGreaterThan(0)
            expect(batch.entries.length).toBeLessThanOrEqual(64)
            expect(batch.entries.reduce((total, entry) => total + entry.maxBytes, 0)).toBeLessThanOrEqual(67_108_864)
            expect(new Set(batch.entries.map(entry => entry.nonce)).size).toBe(batch.entries.length)
            expect(new Set(batch.entries.map(entry => `${entry.segments.join('/')}\0${entry.name}`)).size).toBe(batch.entries.length)
            expect(new Set(batch.entries.map(entry => entry.output)).size).toBe(batch.entries.length)
        }
    })

    it('refuses a surface file that grows beyond its allocation hint without retrying', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-generated-read-growth-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        const declaration = (await readFile(fixture, 'utf8')).replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        )
        await writeFile(configPath, declaration)
        await mkdir(join(root, 'app'), { recursive: true })
        await mkdir(join(root, 'fixtures'), { recursive: true })
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return

        const environmentPaths = new Set([
            'app/.env.example',
            'compose.generated.yml',
            'docs/cockpit/environment-decisions.md',
            'fixtures/personas.generated.ts',
        ])
        const surfacePaths = new Set(initial.result.paths.filter(path => !environmentPaths.has(path)))
        let changed = false
        let targetAttempts = 0
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (step.labels.action === 'read-batch') {
                    const request = JSON.parse(step.argv[3]!) as {
                        entries: Array<{ action: string; segments: string[]; name: string; maxBytes: number }>
                    }
                    const row = request.entries.find(entry => entry.action === 'read-entry'
                        && surfacePaths.has([...entry.segments, entry.name].join('/'))
                        && entry.maxBytes < 16_777_216)
                    if (row) {
                        targetAttempts += 1
                        if (!changed) {
                            await appendFile(join(root, ...row.segments, row.name), '\n')
                            changed = true
                        }
                    }
                }
                return executeProbe(step)
            },
        })

        expect(changed).toBe(true)
        expect(targetAttempts).toBe(1)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'SURFACE_STATE_CONFLICT', target: 'surfaces',
        })] })
    })

    it('refuses an explicit native hook that must move to CI before publication', async () => {
        const { root, configPath, ownership, ownershipPath, bin, calls, head, parent } = await explicitNativeHookFixture()
        const priorPath = process.env.PATH
        let result: Awaited<ReturnType<typeof syncGeneratedEnvironment>>
        try {
            process.env.PATH = bin + (priorPath === undefined ? '' : delimiter + priorPath)
            result = await syncGeneratedEnvironment({ configPath })
        } finally {
            if (priorPath === undefined) delete process.env.PATH
            else process.env.PATH = priorPath
        }
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'SURFACE_INPUT_INVALID', target: '.githooks/pre-push', message: expect.stringContaining('move this check to CI'),
        })] })
        expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual([
            'rev-list --max-count=2 HEAD', ...Array(128).fill(`merge-base --is-ancestor ${parent} ${head}`),
        ])
        expect(await readFile(ownershipPath, 'utf8')).toBe(ownership.bytes)
        await expect(readFile(join(root, 'compose.generated.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)
})
