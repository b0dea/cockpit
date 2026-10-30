import { createHash } from 'node:crypto'
import { readFile, rename, mkdir, writeFile, rm, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import type { ExecutionStep } from '../environment/contract.js'
import { generateSurfaceEstate } from './generator-adapter.js'

const dispatch = vi.hoisted(() => ({
    active: 0,
    cleanupActive: -1,
    events: [] as string[],
    steps: [] as ExecutionStep[],
    retained: [] as string[],
    fault: 'none' as 'none' | 'job-failures' | 'root-replaced' | 'receipt-tampered' | 'close-failure' | 'termination-generate' | 'termination-read',
}))

vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    return {
        ...actual,
        authenticatedExecutionOutcome: (...args: Parameters<typeof actual.authenticatedExecutionOutcome>) => {
            const outcome = actual.authenticatedExecutionOutcome(...args)
            const step = args[1]
            const prefix = dispatch.fault === 'termination-generate' ? 'surface-estate-generate-' : dispatch.fault === 'termination-read' ? 'surface-estate-read-' : undefined
            if (outcome && prefix && step.id.startsWith(prefix) && step.cwd.endsWith('/first')) {
                dispatch.retained.push(dirname(step.cwd))
                return { kind: 'refusal' as const, code: 'EXECUTION_TERMINATION_UNCONFIRMED' as const,
                    execution: outcome.execution, stdout: outcome.stdout, stderr: outcome.stderr }
            }
            return outcome
        },
        executeProbe: async (...args: Parameters<typeof actual.executeProbe>) => {
            const step = args[0]
            dispatch.steps.push(step)
            const role = step.id.startsWith('surface-estate-generate-') ? 'generate'
                : step.id.startsWith('surface-estate-read-') ? 'read'
                    : step.id.startsWith('surface-cleanup-') ? 'cleanup' : 'other'
            dispatch.events.push(`start:${role}:${step.cwd}`)
            if (role === 'cleanup') dispatch.cleanupActive = dispatch.active
            else dispatch.active += 1
            try {
                if (role === 'generate' && dispatch.fault === 'job-failures') {
                    const request = JSON.parse(step.argv[3]!) as { jobs: Array<{ id: string; inputRoot: string }> }
                    const failed = request.jobs.find(job => job.id === (step.cwd.endsWith('/first') ? 'batch-codexcli' : 'batch-claudecode'))!
                    await writeFile(join(failed.inputRoot, 'mcp.jsonc'), '{')
                }
                if (role === 'read' && dispatch.fault === 'root-replaced' && step.cwd.endsWith('/first')) {
                    const request = JSON.parse(step.argv[3]!) as { jobs: Array<{ outputRoot: string }> }
                    const root = request.jobs[0]!.outputRoot
                    await rename(root, `${root}-original`)
                    await mkdir(root)
                }
                const result = await actual.executeProbe(...args)
                if (role === 'generate' && ['receipt-tampered', 'close-failure'].includes(dispatch.fault) && step.cwd.endsWith('/first')) {
                    const request = JSON.parse(step.argv[3]!) as { jobs: Array<{ receiptOutput: string }> }
                    const path = request.jobs[0]!.receiptOutput
                    await writeFile(path, `${await readFile(path, 'utf8')} `)
                }
                return result
            } finally {
                if (role !== 'cleanup') dispatch.active -= 1
                dispatch.events.push(`end:${role}:${step.cwd}`)
            }
        },
    }
})

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args)
        if (dispatch.fault !== 'close-failure' || !String(args[0]).includes('/second/') || !String(args[0]).endsWith('/generator-receipt.json')) return handle
        return new Proxy(handle, { get(target, key) {
            if (key === 'close') return async () => { await target.close(); throw new Error('synthetic receipt close failure') }
            const value = Reflect.get(target, key, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
        } })
    } }
})

afterEach(async () => {
    for (const root of dispatch.retained) await rm(root, { recursive: true, force: true })
    dispatch.retained.length = 0
    dispatch.fault = 'none'
    dispatch.active = 0
    dispatch.cleanupActive = -1
    dispatch.events.length = 0
    dispatch.steps.length = 0
})

const sources = [
    {
        path: 'rules/base.md',
        bytes: '---\nroot: true\ntargets: ["*"]\n---\nRead the synthetic service contract before editing.\n',
    },
    {
        path: 'mcp.jsonc',
        bytes: '{"mcpServers":{"synthetic":{"command":"node","args":["synthetic-server.mjs"]}}}\n',
    },
    {
        path: 'subagents/reviewer.md',
        bytes: '---\nname: reviewer\ndescription: Reviews synthetic changes.\ntargets: ["*"]\n---\nReview the synthetic change.\n',
    },
    {
        path: 'skills/check/SKILL.md',
        bytes: '---\nname: check\ndescription: Checks a synthetic fixture.\ntargets: ["*"]\n---\nInspect the synthetic fixture.\n',
    },
    {
        path: 'hooks.jsonc',
        bytes: '{"hooks":{"preToolUse":[{"type":"command","command":"true","matcher":"Write"}]}}\n',
    },
    {
        path: 'permissions.jsonc',
        bytes: '{"permission":{"read":{"./**":"allow",".git/**":"deny"},"edit":{"./**":"allow",".git/**":"deny"},"webfetch":{"*":"allow"}}}\n',
    },
] as const

const expectedOutputs = {
    claudecode: ['.claude/agents/reviewer.md', '.claude/settings.json', '.claude/skills/check/SKILL.md', '.mcp.json', 'CLAUDE.md'],
    codexcli: ['.agents/skills/check/SKILL.md', '.codex/agents/reviewer.toml', '.codex/config.toml', '.codex/hooks.json', '.codex/rules/rulesync.rules', 'AGENTS.md'],
    opencode: ['.opencode/agents/reviewer.md', '.opencode/plugins/rulesync-hooks.js', '.opencode/skills/check/SKILL.md', 'AGENTS.md', 'opencode.jsonc'],
} as const

it('dispatches a complete core and plugin estate through two generators, two readers, and one settled cleanup', async () => {
    const outcome = await generateSurfaceEstate({
        batch: {
            targets: ['claudecode', 'codexcli', 'opencode'],
            features: ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'],
            sources,
            expectedOutputs,
        },
        bundle: {
            format: 'claudecode-plugin',
            features: ['mcp', 'subagents', 'skills', 'hooks'],
            sources: sources.filter(source => !source.path.startsWith('rules/') && source.path !== 'permissions.jsonc'),
            expectedOutputs: ['.mcp.json', 'agents/reviewer.md', 'hooks/hooks.json', 'skills/check/SKILL.md'],
        },
    })

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.batch).toBeDefined()
    if (!outcome.batch) return
    expect(outcome.batch.files.every(file => file.sha256 === createHash('sha256').update(file.bytes).digest('hex'))).toBe(true)
    expect(outcome.bundle?.files).toHaveLength(4)
    expect(outcome.bundle?.files.every(file => file.sha256 === createHash('sha256').update(file.bytes).digest('hex'))).toBe(true)

    const generators = dispatch.steps.filter(step => step.id.startsWith('surface-estate-generate-'))
    const readers = dispatch.steps.filter(step => step.id.startsWith('surface-estate-read-'))
    const cleanups = dispatch.steps.filter(step => step.id.startsWith('surface-cleanup-'))
    expect([generators.length, readers.length, cleanups.length]).toEqual([2, 2, 1])
    expect(new Set(generators.map(step => step.cwd)).size).toBe(2)
    const consumedNames = (step: ExecutionStep): string[] => step.consumedFiles.slice(1).map(file => file.path.slice(file.path.lastIndexOf('/') + 1))
    expect(generators.map(consumedNames)).toEqual([0, 1].map(() => ['surface-generator-worker.cjs', 'rulesync-generator.cjs']))
    expect(readers.map(consumedNames)).toEqual([0, 1].map(() => ['surface-output-reader.cjs']))
    for (const reader of readers) {
        expect(dispatch.events.indexOf(`start:read:${reader.cwd}`)).toBeGreaterThan(
            dispatch.events.indexOf(`end:generate:${reader.cwd}`),
        )
        const request = JSON.parse(reader.argv[3]!) as { jobs: Array<{ outputRoot: string; identity: { dev: number; ino: number } }> }
        expect(request.jobs).toHaveLength(4)
        expect(new Set(request.jobs.map(job => job.outputRoot)).size).toBe(4)
        expect(request.jobs.every(job => Number.isSafeInteger(job.identity.dev) && Number.isSafeInteger(job.identity.ino))).toBe(true)
    }
    expect(dispatch.cleanupActive).toBe(0)
})

function mcpEstate() {
    return { batch: {
        targets: ['claudecode', 'codexcli'], features: ['mcp'],
        sources: [sources[1]], expectedOutputs: { claudecode: ['.mcp.json'], codexcli: ['.codex/config.toml'] },
    } }
}

it('keeps logical job and pass precedence while reading only successful generator jobs', async () => {
    dispatch.fault = 'job-failures'
    const outcome = await generateSurfaceEstate(mcpEstate())
    expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SURFACE_WORKER_STDERR', target: 'claudecode' }] })
    const readers = dispatch.steps.filter(step => step.id.startsWith('surface-estate-read-'))
    expect(readers).toHaveLength(2)
    for (const reader of readers) {
        const request = JSON.parse(reader.argv[3]!) as { jobs: Array<{ id: string }> }
        expect(request.jobs.map(job => job.id)).toEqual([reader.cwd.endsWith('/first') ? 'batch-claudecode' : 'batch-codexcli'])
    }
    expect(dispatch.cleanupActive).toBe(0)
})

it.each(['root-replaced', 'receipt-tampered'] as const)('refuses %s output and cleans up only after both passes settle', async fault => {
    dispatch.fault = fault
    const outcome = await generateSurfaceEstate(mcpEstate())
    expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: fault === 'root-replaced' ? 'SURFACE_ARTIFACT_INVALID' : 'SURFACE_WORKER_OUTPUT', target: 'claudecode' }] })
    expect(dispatch.cleanupActive).toBe(0)
})

it('rejects accessor envelopes without invoking them or spawning a worker', async () => {
    let accessed = false
    const request = Object.defineProperty({}, 'batch', { enumerable: true, get() { accessed = true; throw new Error('accessor must not run') } })
    await expect(generateSurfaceEstate(request)).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SURFACE_INPUT_INVALID' }] })
    expect(accessed).toBe(false)
    expect(dispatch.steps).toEqual([])
})

it('preserves separate accepted input bounds for a large core and plugin pair', async () => {
    const skills = Array.from({ length: 10 }, (_, index) => ({
        path: `skills/check-${index}/SKILL.md`,
        bytes: `---\nname: check-${index}\ndescription: Checks a synthetic fixture.\ntargets: ["*"]\n---\n${'Synthetic guidance. '.repeat(3000)}\n`,
    }))
    const batch = { targets: ['claudecode'], features: ['skills'], sources: skills,
        expectedOutputs: { claudecode: skills.map(source => `.claude/${source.path}`) } }
    const bundle = { format: 'claudecode-plugin', features: ['skills'], sources: skills,
        expectedOutputs: skills.map(source => source.path) }
    expect(Buffer.byteLength(JSON.stringify({ batch, bundle }))).toBeGreaterThan(1_048_576)
    const outcome = await generateSurfaceEstate({ batch, bundle })
    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.batch?.files).toHaveLength(10)
    expect(outcome.bundle?.files).toHaveLength(10)
})

it('keeps an earlier authenticated refusal ahead of a later receipt close failure', async () => {
    dispatch.fault = 'close-failure'
    const outcome = await generateSurfaceEstate(mcpEstate())
    expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SURFACE_WORKER_OUTPUT', target: 'claudecode' }] })
    expect(dispatch.cleanupActive).toBe(0)
})

it.each(['termination-generate', 'termination-read'] as const)('retains staging when %s cannot confirm process termination', async fault => {
    dispatch.fault = fault
    const outcome = await generateSurfaceEstate(mcpEstate())
    expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EXECUTION_TERMINATION_UNCONFIRMED', cause: 'cleanup' }] })
    expect(dispatch.steps.some(step => step.id.startsWith('surface-cleanup-'))).toBe(false)
    expect(dispatch.retained).toHaveLength(1)
    expect((await lstat(dispatch.retained[0]!)).isDirectory()).toBe(true)
})
