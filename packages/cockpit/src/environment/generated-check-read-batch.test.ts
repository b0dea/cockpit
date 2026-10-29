import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import type { ExecutionStep } from './contract.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './generated-application.js'

const hooks = vi.hoisted(() => ({
    before: undefined as ((step: ExecutionStep) => Promise<void>) | undefined,
    after: undefined as ((step: ExecutionStep, outcome: ExecuteProbeOutcome) => Promise<void>) | undefined,
}))

vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    return {
        ...actual,
        executeProbe: async (step: ExecutionStep) => {
            await hooks.before?.(step)
            const outcome = await actual.executeProbe(step)
            await hooks.after?.(step, outcome)
            return outcome
        },
    }
})

const roots: string[] = []
const fixture = resolve('fixtures/registries/generated-environment.toml')
const generatedPaths = ['app/.env.example', 'compose.generated.yml', 'docs/cockpit/environment-decisions.md']
const personaPaths = ['fixtures/personas.generated.ts', ...Array.from({ length: 7 }, (_, index) => `fixtures/personas-${index}.json`)]

interface ReadRequest {
    readonly nonce: string
    readonly action: string
    readonly segments: readonly string[]
    readonly name: string
    readonly maxBytes: number
    readonly output: string
}

interface BatchRequest {
    readonly nonce: string
    readonly entries: readonly ReadRequest[]
    readonly receiptOutput: string
}

function target(row: ReadRequest): string {
    return [...row.segments, row.name].join('/')
}

function reads(step: ExecutionStep): readonly ReadRequest[] {
    if (step.labels.action === 'read-batch') return (JSON.parse(step.argv[3]!) as BatchRequest).entries
    if (step.labels.action === 'read-file' || step.labels.action === 'read-persona') {
        return [JSON.parse(step.argv[3]!) as ReadRequest]
    }
    return []
}

afterEach(async () => {
    hooks.before = undefined
    hooks.after = undefined
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function consumer() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-check-batch-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    const declaration = (await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    ) + personaPaths.slice(1).map(path => `
[[environment.generated.data.fixtures.persona_outputs]]
path = ${JSON.stringify(path)}
format = "json"
reason = "Synthetic JSON consumer"
`).join('')
    await writeFile(configPath, declaration)
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    const synced = await syncGeneratedEnvironment({ configPath })
    expect(synced, JSON.stringify(synced)).toMatchObject({ kind: 'complete' })
    return { root, configPath }
}

async function composeConsumer() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-check-compose-')))
    roots.push(base)
    const root = join(base, 'compose-first')
    await cp(resolve('examples/compose-first'), root, { recursive: true })
    const configPath = join(root, 'cockpit.toml')
    const synced = await syncGeneratedEnvironment({ configPath })
    expect(synced, JSON.stringify(synced)).toMatchObject({ kind: 'complete' })
    return { root, configPath }
}

describe('generated check authenticated read batching', () => {
    it('reads generated and persona artifacts in one ordered bounded sequence', async () => {
        const { root, configPath } = await consumer()
        const batches: BatchRequest[] = []
        const singles: string[] = []
        const artifactPaths = new Set([...generatedPaths, ...personaPaths])
        hooks.before = async step => {
            if (step.cwd !== root) return
            if (step.labels.action === 'read-batch') {
                const batch = JSON.parse(step.argv[3]!) as BatchRequest
                if (batch.entries.some(row => row.action === 'read-file' && artifactPaths.has(target(row)))) batches.push(batch)
            }
            if (step.labels.action === 'read-file') {
                const path = target(reads(step)[0]!)
                if (artifactPaths.has(path)) singles.push(path)
            }
        }

        const checked = await checkGeneratedEnvironment({ configPath })
        expect(checked, JSON.stringify(checked)).toMatchObject({ kind: 'complete', result: { action: 'check' } })
        expect(batches.map(batch => batch.entries.map(target))).toEqual([
            [...generatedPaths, personaPaths[0]!], personaPaths.slice(1, 5), personaPaths.slice(5),
        ])
        expect(singles).toEqual([])
        for (const batch of batches) {
            expect(batch.nonce).toMatch(/^[a-f0-9]{32}$/)
            expect(batch.entries.length).toBeLessThanOrEqual(64)
            expect(batch.entries.every(row => row.action === 'read-file' && row.maxBytes === 16_777_216)).toBe(true)
            expect(batch.entries.reduce((total, row) => total + row.maxBytes, 0)).toBeLessThanOrEqual(67_108_864)
            expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(65_536)
            expect(new Set(batch.entries.map(row => row.nonce)).size).toBe(batch.entries.length)
            expect(batch.entries.every(row => /^[a-f0-9]{32}$/.test(row.nonce))).toBe(true)
            expect(new Set(batch.entries.map(row => row.output)).size).toBe(batch.entries.length)
        }
    })

    it.each(['missing', 'invalid UTF8'] as const)('retains the first %s generated target before later read failure and persona drift', async kind => {
        const { root, configPath } = await consumer()
        let changed = false
        hooks.before = async step => {
            if (changed || step.cwd !== root || !reads(step).some(row => generatedPaths.includes(target(row)))) return
            changed = true
            const first = join(root, 'compose.generated.yml')
            if (kind === 'missing') await rm(first)
            else await writeFile(first, Buffer.from([0xc3, 0x28]))
            const later = join(root, 'docs/cockpit/environment-decisions.md')
            await rm(later)
            await symlink(join(root, 'fixtures/personas.json'), later)
            await writeFile(join(root, personaPaths[0]!), 'drift\n')
        }

        const checked = await checkGeneratedEnvironment({ configPath })
        expect(changed).toBe(true)
        expect(checked).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'GENERATED_ARTIFACT_MISSING', target: 'compose.generated.yml',
        })] })
    })

    it('retains first persona drift before a later unreadable persona entry', async () => {
        const { root, configPath } = await consumer()
        let changed = false
        hooks.before = async step => {
            if (changed || step.cwd !== root || !reads(step).some(row => personaPaths.includes(target(row)))) return
            changed = true
            await writeFile(join(root, personaPaths[0]!), 'drift\n')
            const later = join(root, personaPaths[1]!)
            await rm(later)
            await symlink(join(root, 'fixtures/personas.json'), later)
        }

        const checked = await checkGeneratedEnvironment({ configPath })
        expect(changed).toBe(true)
        expect(checked).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'GENERATED_ARTIFACT_DRIFT', target: personaPaths[0],
        })] })
    })

    it('fails closed when a generated batch receipt changes after authenticated execution', async () => {
        const { root, configPath } = await consumer()
        let changed = false
        hooks.after = async (step, outcome) => {
            if (changed || step.cwd !== root || step.labels.action !== 'read-batch' || outcome.kind !== 'complete') return
            const batch = JSON.parse(step.argv[3]!) as BatchRequest
            if (!batch.entries.some(row => row.action === 'read-file' && generatedPaths.includes(target(row)))) return
            await writeFile(batch.receiptOutput, '{}\n')
            changed = true
        }

        const checked = await checkGeneratedEnvironment({ configPath })
        expect(changed).toBe(true)
        expect(checked).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'GENERATED_ARTIFACT_MISSING', target: generatedPaths[0],
        })] })
    })

    it('preserves ambiguous Windows executable search aliases before Compose topology dispatch', async () => {
        const { root, configPath } = await composeConsumer()
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
        if (!descriptor) throw new Error('process.platform descriptor is unavailable')
        const priorPathAlias = process.env.Path
        const priorPathExt = process.env.PATHEXT
        let personaReads = 0
        let inputRevalidationComplete = false
        let simulated = false
        let topologyDispatches = 0
        try {
            process.env.Path = process.env.PATH
            process.env.PATHEXT = '.EXE'
            const checked = await checkGeneratedEnvironment({ configPath }, undefined, {
                execute: async step => {
                    const outcome = await executeProbe(step)
                    if (step.labels.operation === 'compose-topology') topologyDispatches += 1
                    if (step.cwd === root && step.labels.action === 'read-persona'
                        && reads(step).some(row => row.action === 'read-persona' && target(row) === 'cockpit.toml')) {
                        personaReads += 1
                        inputRevalidationComplete = personaReads === 2 && outcome.kind === 'complete'
                    } else if (inputRevalidationComplete && !simulated && step.cwd !== root
                        && step.labels.action === 'read-batch' && outcome.kind === 'complete') {
                        Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
                        simulated = true
                    }
                    return outcome
                },
            })
            expect(personaReads).toBe(2)
            expect(simulated).toBe(true)
            expect(checked).toMatchObject({ kind: 'refusal', diagnostics: expect.arrayContaining([expect.objectContaining({
                code: 'COMPOSE_TOPOLOGY_UNAVAILABLE',
                message: expect.stringContaining('Executable search environment has ambiguous PATH spellings'),
            })]) })
            expect(topologyDispatches).toBe(0)
        } finally {
            Object.defineProperty(process, 'platform', descriptor)
            if (priorPathAlias === undefined) delete process.env.Path
            else process.env.Path = priorPathAlias
            if (priorPathExt === undefined) delete process.env.PATHEXT
            else process.env.PATHEXT = priorPathExt
        }
    }, 120_000)
})
