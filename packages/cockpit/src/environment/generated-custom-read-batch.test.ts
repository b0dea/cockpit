import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import * as surfaceGenerator from '../surfaces/generator-adapter.js'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { publicationCockpitId } from './identity.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')
const roots: string[] = []
const features = ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function digest(bytes: string): string {
    return createHash('sha256').update(bytes).digest('hex')
}

async function customConsumer(name: string, count: number, extraPath?: string): Promise<{ root: string; configPath: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `cockpit-custom-batch-${name}-`)))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    await mkdir(join(root, 'adapters'), { recursive: true })
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    const outputs = Array.from({ length: count }, (_, index) => {
        const path = `custom/rules-${String(index).padStart(3, '0')}.md`
        const bytes = `${path}\n`
        return { path, bytes, sha256: digest(bytes), scope: 'always' }
    })
    if (extraPath !== undefined) outputs.push({ path: extraPath, bytes: 'extra\n', sha256: digest('extra\n'), scope: 'always' })
    await writeFile(join(root, 'adapters/synthetic.mjs'), `export async function renderRules(input) {
  if (input.harness !== "synthetic-harness" || input.feature !== "rules" || !Array.isArray(input.sources)) throw new Error("invalid custom input")
  return { kind: "complete", files: ${JSON.stringify(outputs)} }
}
`)
    const capabilities = features.map(feature => feature === 'rules'
        ? '{ feature = "rules", state = "instructed", measured_on = "2026-09-26", spelling = "custom/rules-000.md", control = "controls/rules.json", mechanism = { module = "adapters/synthetic.mjs", export = "renderRules" } }'
        : `{ feature = ${JSON.stringify(feature)}, state = "unavailable", measured_on = "2026-09-26", reason = "No synthetic ${feature} mechanism" }`)
    const declaration = (await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    ) + `
[[surfaces.harnesses]]
name = "synthetic-harness"
capabilities = [${capabilities.join(', ')}]
`
    await writeFile(configPath, declaration)
    return { root, configPath }
}

interface BatchRequest {
    readonly entries: readonly {
        readonly action: string
        readonly segments: readonly string[]
        readonly name: string
        readonly maxBytes: number
        readonly output: string
    }[]
}

describe('custom surface output authentication batching', () => {
    it.each([
        { name: 'missing ledger preview', existing: false, dryRun: true, replaceIdentity: false },
        { name: 'changed ledger preview', existing: true, dryRun: true, replaceIdentity: false },
        { name: 'changed ledger publication', existing: true, dryRun: false, replaceIdentity: false },
        { name: 'same-byte replacement publication', existing: true, dryRun: false, replaceIdentity: true },
    ])('preserves observed ownership during $name', async ({ existing, dryRun, replaceIdentity }) => {
        const generation = vi.spyOn(surfaceGenerator, 'generateSurfaceEstate')
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-ownership-race-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        await mkdir(join(root, 'app'))
        await mkdir(join(root, 'fixtures'))
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
        await writeFile(configPath, (await readFile(fixture, 'utf8')).replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        ))
        const ledgerPath = join(root, '.cockpit/generated-environment-ownership.json')
        await mkdir(join(root, '.cockpit'), { recursive: true })
        let initialBytes = ''
        if (existing) {
            const sourceSha256 = digest(await readFile(configPath, 'utf8'))
            initialBytes = encodeOwnershipManifest({
                root, configPath, cockpitId: publicationCockpitId({ name: 'generated-environment' }),
                generation: digest(`generated-environment\0${sourceSha256}`), sourceSha256,
                personaSource: { path: 'fixtures/personas.json', sha256: digest(await readFile(join(root, 'fixtures/personas.json'), 'utf8')) },
                owned: [], surfaces: [],
            }).bytes
            await writeFile(ledgerPath, initialBytes)
        }
        const initialIdentity = existing ? await lstat(ledgerPath) : undefined
        const consumerBytes = replaceIdentity ? initialBytes : 'consumer-owned metadata\n'
        let changed = false
        let admissionReads = 0
        let prepared = 0
        let rollbacks = 0
        let publications = 0
        let expectedLedger: unknown
        let replacementInode: number | undefined
        const result = await syncGeneratedEnvironment({ configPath, dryRun }, {
            execute: async step => {
                const action = step.labels.action
                const request = (action ? JSON.parse(step.argv[3]!) : {}) as {
                    name?: string
                    groups?: Array<{ entries: Array<{ name: string; expected: unknown }> }>
                }
                if (step.cwd === root && action === 'read-entry'
                    && request.name === 'generated-environment-ownership.json') admissionReads += 1
                if (action === 'prepare-batch') {
                    prepared += 1
                    const ledger = request.groups?.flatMap(group => group.entries).find(entry => entry.name === 'generated-environment-ownership.json')
                    if (ledger) expectedLedger = ledger.expected
                }
                if (action === 'rollback') rollbacks += 1
                if (action === 'publish-batch') publications += 1
                const outcome = await executeProbe(step)
                if (outcome.kind === 'complete' && !changed && step.cwd === root && action === 'read-file'
                    && request.name === 'generated-environment-ownership.json') {
                    if (replaceIdentity) {
                        await writeFile(`${ledgerPath}.replacement`, consumerBytes)
                        await rename(`${ledgerPath}.replacement`, ledgerPath)
                    } else await writeFile(ledgerPath, consumerBytes)
                    replacementInode = (await lstat(ledgerPath)).ino
                    changed = true
                }
                return outcome
            },
        })

        expect(changed, JSON.stringify(result)).toBe(true)
        expect(generation).not.toHaveBeenCalled()
        expect(admissionReads, JSON.stringify(result)).toBe(1)
        expect(result).toMatchObject({
            kind: 'refusal',
            status: 2,
            diagnostics: [{
                severity: 'error',
                code: 'GENERATED_OWNERSHIP_INVALID',
                message: 'generated ownership metadata changed after observation',
                target: '.cockpit/generated-environment-ownership.json',
            }],
        })
        expect(await readFile(ledgerPath, 'utf8')).toBe(consumerBytes)
        expect((await lstat(ledgerPath)).ino).toBe(replacementInode)
        expect(publications).toBe(0)
        expect(expectedLedger).toBeUndefined()
        expect(prepared).toBe(0)
        expect(rollbacks).toBe(0)
        if (replaceIdentity) expect(replacementInode).not.toBe(initialIdentity!.ino)
    })

    it('refuses ownership changes after preflight during final admission', async () => {
        const { root, configPath } = await customConsumer('ownership', 1)
        const generation = vi.spyOn(surfaceGenerator, 'generateSurfaceEstate')
        const ledgerPath = join(root, '.cockpit/generated-environment-ownership.json')
        const sentinelBytes = 'consumer-owned metadata\n'
        let sentinelIdentity: { dev: number; ino: number } | undefined
        let admissionReads = 0
        let prepared = 0
        let publications = 0
        let rollbacks = 0
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                const action = step.labels.action
                const request = (action ? JSON.parse(step.argv[3]!) : {}) as { name?: string }
                if (action === 'prepare-batch') prepared += 1
                if (action === 'publish-batch') publications += 1
                if (action === 'rollback') rollbacks += 1
                const outcome = await executeProbe(step)
                if (step.cwd === root && action === 'read-entry'
                    && request.name === 'generated-environment-ownership.json') {
                    admissionReads += 1
                    expect(outcome.kind).toBe('complete')
                    const observation = JSON.parse(outcome.stdout.toString('utf8'))
                    if (admissionReads === 1) {
                        expect(observation).toMatchObject({ action: 'read-entry', kind: 'missing' })
                        expect(generation).not.toHaveBeenCalled()
                        await mkdir(join(root, '.cockpit'), { recursive: true })
                        await writeFile(ledgerPath, sentinelBytes)
                        const identity = await lstat(ledgerPath)
                        sentinelIdentity = { dev: identity.dev, ino: identity.ino }
                    } else {
                        expect(observation).toMatchObject({ action: 'read-entry', kind: 'file', sha256: digest(sentinelBytes) })
                        expect(generation).toHaveBeenCalledTimes(1)
                    }
                }
                return outcome
            },
        })

        expect(admissionReads, JSON.stringify(result)).toBe(2)
        expect(generation).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
            kind: 'refusal',
            status: 2,
            diagnostics: [{
                severity: 'error',
                code: 'GENERATED_OWNERSHIP_INVALID',
                message: 'generated ownership metadata changed after observation',
                target: '.cockpit/generated-environment-ownership.json',
            }],
        })
        expect(prepared).toBe(0)
        expect(publications).toBe(0)
        expect(rollbacks).toBe(0)
        expect(sentinelIdentity).toBeDefined()
        expect(await readFile(ledgerPath, 'utf8')).toBe(sentinelBytes)
        expect(await lstat(ledgerPath)).toMatchObject(sentinelIdentity!)
    })

    it.each([false, true])('batches local source freshness and refuses changed custom bytes: %s', async change => {
        const { root, configPath } = await customConsumer('freshness', 1)
        const batches: BatchRequest[] = []
        let changed = false
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (step.cwd === root && step.labels.action === 'read-batch') {
                    const request = JSON.parse(step.argv[3]!) as BatchRequest
                    if (request.entries[0]?.action === 'read-persona') {
                        batches.push(request)
                        if (change && batches.length === 2) {
                            await writeFile(join(root, 'adapters/synthetic.mjs'), 'export const replaced = true\n')
                            changed = true
                        }
                    }
                }
                return executeProbe(step)
            },
        })

        expect(batches.map(batch => batch.entries.map(entry => ({
            path: [...entry.segments, entry.name].join('/'), action: entry.action, maxBytes: entry.maxBytes,
        })))).toEqual(Array.from({ length: change ? 2 : 3 }, () => [
            // With no persona source declared, the configuration file is the source that anchors freshness.
            { path: 'cockpit.toml', action: 'read-persona', maxBytes: 16_777_216 },
            { path: 'adapters/synthetic.mjs', action: 'read-file', maxBytes: 16_777_216 },
        ]))
        expect(changed).toBe(change)
        if (change) {
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })] })
            await expect(readFile(join(root, 'custom/rules-000.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(readFile(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await readFile(join(root, 'adapters/synthetic.mjs'), 'utf8')).toBe('export const replaced = true\n')
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(root, 'custom/rules-000.md'), 'utf8')).toBe('custom/rules-000.md\n')
        }
    })

    it('refuses custom source changes during final MCP observation', async () => {
        const { root, configPath } = await customConsumer('mcp-freshness', 1)
        await writeFile(join(root, 'app/.mcp.json'), '{"mcpServers":{"synthetic-server":{"command":"/usr/bin/true"}}}\n')
        await writeFile(configPath, `${await readFile(configPath, 'utf8')}
[sibling.derives]
mcp_sources = [{ path = ".mcp.json", provenance = { source = "synthetic declaration", observed_on = "2026-09-26", kind = "declared", reason = "Synthetic MCP source" } }]
`)
        const modulePath = join(root, 'adapters/synthetic.mjs')
        const original = await readFile(modulePath, 'utf8')
        let mcpReads = 0
        const result = await syncGeneratedEnvironment({ configPath, dryRun: true }, {
            execute: async step => {
                if (step.cwd === join(root, 'app') && step.labels.action === 'read-file') {
                    const request = JSON.parse(step.argv[3]!) as { name: string }
                    if (request.name === '.mcp.json' && ++mcpReads === 2) await writeFile(modulePath, `${original}\n`)
                }
                return executeProbe(step)
            },
        })

        expect(mcpReads).toBe(2)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })] })
        expect(await readFile(modulePath, 'utf8')).toBe(`${original}\n`)
        await expect(readFile(join(root, 'custom/rules-000.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.each([
        { path: 'custom/.GIT/hooks/pre-commit' },
        { path: 'custom/Node_Modules/rules.md' },
    ])('refuses custom output $path through a case-folded reserved segment', async ({ path }) => {
        const { configPath } = await customConsumer('reserved', 1, path)
        const result = await syncGeneratedEnvironment({ configPath, dryRun: true }, { execute: executeProbe })
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })] })
    })

    it('authenticates thirty-two ordered custom outputs in one bounded batch', async () => {
        const { configPath } = await customConsumer('count', 32)
        let scratch: string | undefined
        const batches: BatchRequest[] = []
        let singles = 0

        const result = await syncGeneratedEnvironment({ configPath, dryRun: true }, {
            execute: async step => {
                if (step.id.startsWith('custom-surface-')) scratch = step.cwd
                if (scratch && step.cwd === scratch && step.labels.action === 'read-batch') batches.push(JSON.parse(step.argv[3]!))
                if (scratch && step.cwd === scratch && step.labels.action === 'read-file') singles += 1
                return executeProbe(step)
            },
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', result: { dryRun: true } })
        expect(batches).toHaveLength(1)
        expect(singles).toBe(0)
        const entries = batches.flatMap(batch => batch.entries)
        expect(entries).toHaveLength(32)
        expect(entries.map(entry => entry.name)).toEqual(Array.from({ length: 32 }, (_, index) => String(index)))
        expect(entries.every(entry => entry.action === 'read-file' && entry.segments.length === 0 && entry.maxBytes === 65_536)).toBe(true)
        expect(new Set(entries.map(entry => entry.output)).size).toBe(entries.length)
    })

    it('refuses custom output bytes changed before authenticated batch reading', async () => {
        const { configPath } = await customConsumer('digest', 32)
        let scratch: string | undefined
        let changed = false
        let batches = 0

        const result = await syncGeneratedEnvironment({ configPath, dryRun: true }, {
            execute: async step => {
                if (step.id.startsWith('custom-surface-')) scratch = step.cwd
                if (scratch && step.cwd === scratch && step.labels.action === 'read-batch') {
                    batches += 1
                    if (!changed) {
                        const request = JSON.parse(step.argv[3]!) as BatchRequest
                        await writeFile(join(scratch, request.entries[0]!.name), 'changed\n')
                        changed = true
                    }
                }
                return executeProbe(step)
            },
        })

        expect(changed).toBe(true)
        expect(batches).toBe(1)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })] })
    })

    it('refuses a substituted scratch root between authenticated batches', async () => {
        const { configPath } = await customConsumer('root', 128)
        let scratch: string | undefined
        let held: string | undefined
        let batches = 0

        const result = await syncGeneratedEnvironment({ configPath, dryRun: true }, {
            execute: async step => {
                if (step.id.startsWith('custom-surface-')) scratch = step.cwd
                if (!scratch || step.cwd !== scratch || step.labels.action !== 'read-batch') return executeProbe(step)
                batches += 1
                const outcome = await executeProbe(step)
                if (batches === 1) {
                    held = `${scratch}-held`
                    roots.push(held)
                    await rename(scratch, held)
                    await mkdir(scratch)
                    roots.push(scratch)
                    await writeFile(join(scratch, 'foreign-sentinel'), 'preserve\n')
                    for (let index = 64; index < 128; index += 1) {
                        await writeFile(join(scratch, String(index)), await readFile(join(held, String(index))))
                    }
                }
                return outcome
            },
        })

        expect(held).toBeDefined()
        expect(batches).toBe(2)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })] })
        await expect(readFile(join(scratch!, 'foreign-sentinel'), 'utf8')).resolves.toBe('preserve\n')
    })
})
