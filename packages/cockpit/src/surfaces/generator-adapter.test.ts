import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, expect, it, vi } from 'vitest'
import * as ts from '@typescript/typescript6'

import { authenticatedExecutionOutcome, executeProbe } from '../environment-exec/execute.js'
import { snapshotExecutionStep, type ExecutionStep } from '../environment/contract.js'
import { SURFACE_FILE_MAX_BYTES } from './contract.js'
import { generateSurfaceBatch, generateSurfaceEstate, RULESYNC_VERSION } from './generator-adapter.js'

const authorityFault = vi.hoisted(() => ({
    kind: 'none' as 'none' | 'grown-bundle' | 'tampered-bundle' | 'node-close' | 'bundle-close' | 'stage-variance' | 'warning-stage-variance' | 'warning-receipt-bounds',
    observedReadBytes: [] as number[],
    bundleCloseFailed: false,
    stagedRuleWrites: 0,
    observeTargetConcurrency: false,
    activeTargetPipelines: [] as string[],
    completedTargetPipelines: [] as string[],
    stageOrder: {} as Record<string, string[]>,
    maxActiveTargetPipelines: 0,
    activeGeneratorExecutions: 0,
    maxActiveGeneratorExecutions: 0,
    cleanupActiveTargetPipelines: [] as number[],
    observedGrokFeatures: [] as string[],
    releaseFirstTarget: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            const path = String(args[0])
            if (authorityFault.kind === 'stage-variance' && path.endsWith('/input/rules/base.md')) {
                authorityFault.stagedRuleWrites += 1
                if (authorityFault.stagedRuleWrites === 2) {
                    const changed = '---\nroot: true\ntargets: ["*"]\n---\nRead the changed synthetic contract before editing.\n'
                    return Reflect.apply(actual.writeFile, actual, [args[0], changed, args[2]])
                }
            }
            return actual.writeFile(...args)
        },
        open: async (...args: Parameters<typeof actual.open>) => {
            const handle = await actual.open(...args)
            const path = String(args[0])
            const rulesyncBundle = path.endsWith('/libexec/rulesync-generator.cjs')
            const failClose = authorityFault.kind === 'node-close' && !path.endsWith('.json')
                || authorityFault.kind === 'bundle-close' && rulesyncBundle
            if (failClose) {
                return new Proxy(handle, {
                    get(target, property) {
                        if (property === 'close') {
                            return async () => {
                                await target.close()
                                if (rulesyncBundle) authorityFault.bundleCloseFailed = true
                                throw new Error('synthetic close failure')
                            }
                        }
                        const value = Reflect.get(target, property, target) as unknown
                        return typeof value === 'function' ? value.bind(target) : value
                    },
                })
            }
            if (authorityFault.kind === 'grown-bundle' && rulesyncBundle) {
                return new Proxy(handle, {
                    get(target, property) {
                        if (property === 'readFile') {
                            return async () => {
                                throw new Error('unexpected unbounded bundle read')
                            }
                        }
                        if (property === 'read') {
                            return async (buffer: Buffer, offset: number, length: number) => {
                                authorityFault.observedReadBytes.push(length)
                                buffer.fill(0x20, offset, offset + length)
                                return { bytesRead: length, buffer }
                            }
                        }
                        const value = Reflect.get(target, property, target) as unknown
                        return typeof value === 'function' ? value.bind(target) : value
                    },
                })
            }
            if (authorityFault.kind === 'tampered-bundle' && rulesyncBundle) {
                let position = 0
                return new Proxy(handle, {
                    get(target, property) {
                        if (property === 'read') {
                            return async (buffer: Buffer, offset: number, length: number) => {
                                const result = await target.read(buffer, offset, length, position)
                                position += result.bytesRead
                                if (result.bytesRead > 0) buffer[offset] = buffer[offset]! ^ 0xff
                                return result
                            }
                        }
                        const value = Reflect.get(target, property, target) as unknown
                        return typeof value === 'function' ? value.bind(target) : value
                    },
                })
            }
            return handle
        },
    }
})

vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    const stage = (step: ExecutionStep): { pass: 'first' | 'second'; target: string } | undefined => {
        const estate = step.cwd.match(/\/(first|second)$/)
        if (estate) return { pass: estate[1] as 'first' | 'second', target: estate[1]! }
        const legacy = step.cwd.match(/\/(first|second)\/([^/]+)(?:\/output)?$/)
        return legacy ? { pass: legacy[1] as 'first' | 'second', target: legacy[2]! } : undefined
    }
    return {
        ...actual,
        executeProbe: async (...args: Parameters<typeof actual.executeProbe>) => {
            const step = args[0]
            const current = stage(step)
            const generation = step.id.startsWith('surface-generate-') || step.id.startsWith('surface-estate-generate-')
            const read = step.id.startsWith('surface-read-') || step.id.startsWith('surface-estate-read-')
            if (step.id.startsWith('surface-estate-generate-')) {
                const request = JSON.parse(step.argv[3]!) as { jobs: Array<{ target: string; features: string[] }> }
                authorityFault.observedGrokFeatures = request.jobs.find(job => job.target === 'grokcli')?.features ?? []
            }
            if (authorityFault.observeTargetConcurrency && generation && current) {
                const order = authorityFault.stageOrder[current.target] ?? []
                order.push(current.pass)
                authorityFault.stageOrder[current.target] = order
                if (step.id.startsWith('surface-estate-generate-') || current.pass === 'first') {
                    authorityFault.activeTargetPipelines.push(current.target)
                    authorityFault.maxActiveTargetPipelines = Math.max(
                        authorityFault.maxActiveTargetPipelines,
                        authorityFault.activeTargetPipelines.length,
                    )
                    if (authorityFault.activeTargetPipelines.length === 1) {
                        await Promise.race([
                            new Promise<void>(resolve => { authorityFault.releaseFirstTarget = resolve }),
                            new Promise<void>(resolve => setTimeout(resolve, 100)),
                        ])
                    } else {
                        authorityFault.releaseFirstTarget?.()
                        authorityFault.releaseFirstTarget = undefined
                    }
                }
                authorityFault.activeGeneratorExecutions += 1
                authorityFault.maxActiveGeneratorExecutions = Math.max(
                    authorityFault.maxActiveGeneratorExecutions,
                    authorityFault.activeGeneratorExecutions,
                )
            }
            if (authorityFault.observeTargetConcurrency && step.id.startsWith('surface-cleanup-')) {
                authorityFault.cleanupActiveTargetPipelines.push(authorityFault.activeTargetPipelines.length)
            }
            try {
                return await actual.executeProbe(...args)
            } finally {
                if (authorityFault.observeTargetConcurrency && generation && current) {
                    authorityFault.activeGeneratorExecutions -= 1
                }
                if (authorityFault.observeTargetConcurrency && read && current
                    && (step.id.startsWith('surface-estate-read-') || current.pass === 'second')) {
                    authorityFault.completedTargetPipelines.push(current.target)
                    authorityFault.activeTargetPipelines = authorityFault.activeTargetPipelines.filter(target => target !== current.target)
                }
            }
        },
        authenticatedExecutionOutcome: (...args: Parameters<typeof actual.authenticatedExecutionOutcome>) => {
            const outcome = actual.authenticatedExecutionOutcome(...args)
            const step = args[1]
            if (!outcome || outcome.kind !== 'complete' || !step.id.startsWith('surface-estate-generate-')
                || !['warning-stage-variance', 'warning-receipt-bounds'].includes(authorityFault.kind)) return outcome
            const summary = JSON.parse(outcome.stdout.toString()) as {
                jobs: Array<{ id: string; bytes: number; sha256: string }>
            }
            const row = summary.jobs.find(job => job.id === 'batch-claudecode')
            const request = JSON.parse(step.argv[3]!) as { jobs: Array<{ id: string; receiptOutput: string }> }
            const receiptPath = request.jobs.find(job => job.id === 'batch-claudecode')?.receiptOutput
            if (!row || !receiptPath) return outcome
            if (authorityFault.kind === 'warning-receipt-bounds' && authorityFault.stagedRuleWrites > 0) return outcome
            authorityFault.stagedRuleWrites += 1
            const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { warnings?: Array<Record<string, unknown>> }
            const warning = receipt.warnings?.[0]
            if (!warning) return outcome
            if (authorityFault.kind === 'warning-stage-variance' && authorityFault.stagedRuleWrites === 2) {
                warning.message = `${String(warning.message)} `
            }
            if (authorityFault.kind === 'warning-receipt-bounds') {
                receipt.warnings = Array.from({ length: 17 }, () => ({ ...warning }))
            }
            const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
            writeFileSync(receiptPath, receiptBytes)
            row.bytes = receiptBytes.length
            row.sha256 = createHash('sha256').update(receiptBytes).digest('hex')
            return { ...outcome, stdout: Buffer.from(`${JSON.stringify(summary)}\n`) }
        },
    }
})

afterEach(() => {
    authorityFault.kind = 'none'
    authorityFault.observedReadBytes.length = 0
    authorityFault.bundleCloseFailed = false
    authorityFault.stagedRuleWrites = 0
    authorityFault.observeTargetConcurrency = false
    authorityFault.activeTargetPipelines.length = 0
    authorityFault.completedTargetPipelines.length = 0
    authorityFault.stageOrder = {}
    authorityFault.maxActiveTargetPipelines = 0
    authorityFault.activeGeneratorExecutions = 0
    authorityFault.maxActiveGeneratorExecutions = 0
    authorityFault.cleanupActiveTargetPipelines.length = 0
    authorityFault.observedGrokFeatures.length = 0
    authorityFault.releaseFirstTarget?.()
    authorityFault.releaseFirstTarget = undefined
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
    claudecode: [
        '.claude/agents/reviewer.md',
        '.claude/settings.json',
        '.claude/skills/check/SKILL.md',
        '.mcp.json',
        'CLAUDE.md',
    ],
    codexcli: [
        '.agents/skills/check/SKILL.md',
        '.codex/agents/reviewer.toml',
        '.codex/config.toml',
        '.codex/hooks.json',
        '.codex/rules/rulesync.rules',
        'AGENTS.md',
    ],
    opencode: [
        '.opencode/agents/reviewer.md',
        '.opencode/plugins/rulesync-hooks.js',
        '.opencode/skills/check/SKILL.md',
        'AGENTS.md',
        'opencode.jsonc',
    ],
} as const

const trustPermissionSource = {
    path: 'permissions.jsonc',
    bytes: '{"permission":{},"claudecode":{"permissions":{"additionalDirectories":["../shared"]},"enabledMcpjsonServers":["synthetic"]}}\n',
} as const

const expectedTrustWarning = "Claude Code permissions: writing 2 trust-affecting settings to .claude/settings.json; review them as you would a hook because synced agent settings can widen filesystem access, approve project servers or run commands without asking. 'permissions.additionalDirectories' — moves the boundary of what Claude Code may read and edit outside the project: \"../shared\"; 'enabledMcpjsonServers' — auto-approves the named servers in the project `.mcp.json`: \"synthetic\"."

function completeBatch() {
    return {
        targets: ['claudecode', 'codexcli', 'opencode'],
        features: ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'],
        sources,
        expectedOutputs,
    } as const
}

function nextHarnessRulesBatch(expected: Readonly<Record<'cursor' | 'grokcli', readonly string[]>> = {
    cursor: ['.cursor/rules/base.mdc'],
    grokcli: ['AGENTS.md'],
} as const) {
    return {
        targets: ['cursor', 'grokcli'],
        features: ['rules'],
        sources: sources.filter(source => source.path.startsWith('rules/')),
        expectedOutputs: expected,
    } as const
}

function claudePluginBundle() {
    return {
        format: 'claudecode-plugin',
        features: ['mcp', 'subagents', 'skills', 'hooks'],
        sources: sources.filter(source => !source.path.startsWith('rules/') && source.path !== 'permissions.jsonc'),
        expectedOutputs: ['.mcp.json', 'agents/reviewer.md', 'hooks/hooks.json', 'skills/check/SKILL.md'],
    } as const
}

it('bounds generator bundle growth before refusing its authority', async () => {
    authorityFault.kind = 'grown-bundle'

    const outcome = await generateSurfaceBatch(completeBatch())

    expect(authorityFault.observedReadBytes.reduce((total, bytes) => total + bytes, 0)).toBe(4_194_305)
    expect(outcome).toEqual(expect.objectContaining({ kind: 'unavailable', files: [] }))
})

it('refuses a changed checked-in generator bundle before execution', async () => {
    authorityFault.kind = 'tampered-bundle'

    const outcome = await generateSurfaceBatch(completeBatch())

    expect(outcome).toEqual(expect.objectContaining({ kind: 'unavailable', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'SURFACE_PACKAGE_UNAVAILABLE' }))
})

it('refuses Node authority when closing its authenticated handle fails', async () => {
    authorityFault.kind = 'node-close'

    const outcome = await generateSurfaceBatch(completeBatch())

    expect(outcome).toEqual(expect.objectContaining({ kind: 'unavailable', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'SURFACE_NODE_UNAVAILABLE' }))
})

it('refuses bundle authority when its authenticated handle does not close cleanly', async () => {
    authorityFault.kind = 'bundle-close'

    const outcome = await generateSurfaceBatch(completeBatch())

    expect(authorityFault.bundleCloseFailed).toBe(true)
    expect(outcome).toEqual(expect.objectContaining({ kind: 'unavailable', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'SURFACE_PACKAGE_UNAVAILABLE' }))
})

it('renders one deterministic complete batch through the authenticated generator bundle', async () => {
    const first = await generateSurfaceBatch(completeBatch())
    const second = await generateSurfaceBatch(completeBatch())

    expect(first.diagnostics).toEqual([])
    expect(second.diagnostics).toEqual([])
    expect(first.kind).toBe('complete')
    expect(second.kind).toBe('complete')
    if (first.kind !== 'complete' || second.kind !== 'complete') return
    // package.json is the pin's one source, so the recorded provenance must follow it.
    const pinned = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).devDependencies.rulesync
    expect(RULESYNC_VERSION).toBe(pinned)
    expect(first.mechanism).toEqual({ package: 'rulesync', version: pinned, role: 'spelling' })
    expect(first.files).toEqual(second.files)
    expect(first.files.map(({ target, path }) => `${target}:${path}`)).toEqual([
        ...expectedOutputs.claudecode.map(path => `claudecode:${path}`),
        ...expectedOutputs.codexcli.map(path => `codexcli:${path}`),
        ...expectedOutputs.opencode.map(path => `opencode:${path}`),
    ])
    expect(first.files.every(file => file.sha256 === createHash('sha256').update(file.bytes).digest('hex'))).toBe(true)
    expect(first.warnings).toEqual([])
    expect(Object.isFrozen(first.warnings)).toBe(true)
})

it('compiles Cursor and Grok Build rules while rejecting a mismatched output control', async () => {
    const generated = await generateSurfaceBatch(nextHarnessRulesBatch())

    expect(generated.kind, JSON.stringify(generated)).toBe('complete')
    if (generated.kind !== 'complete') return
    expect(generated.files.map(({ target, path }) => `${target}:${path}`)).toEqual([
        'cursor:.cursor/rules/base.mdc',
        'grokcli:AGENTS.md',
    ])

    const broken = await generateSurfaceBatch(nextHarnessRulesBatch({
        cursor: ['AGENTS.md'],
        grokcli: ['AGENTS.md'],
    }))
    expect(broken).toMatchObject({ kind: 'refusal', diagnostics: [
        expect.objectContaining({ code: 'SURFACE_OUTPUT_COVERAGE', target: 'cursor' }),
    ] })
})

it('covers every supported Cursor and Grok Build feature without claiming native enforcement', async () => {
    const generated = await generateSurfaceBatch({
        targets: ['cursor', 'grokcli'],
        features: ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'],
        sources,
        expectedOutputs: {
            cursor: ['.cursor/agents/reviewer.md', '.cursor/cli.json', '.cursor/hooks.json', '.cursor/mcp.json',
                '.cursor/rules/base.mdc', '.cursor/skills/check/SKILL.md'],
            grokcli: ['.grok/agents/reviewer.md', '.grok/config.toml', '.grok/hooks/rulesync.json',
                '.grok/skills/check/SKILL.md', 'AGENTS.md'],
        },
    })

    expect(generated.kind, JSON.stringify(generated)).toBe('complete')
    if (generated.kind !== 'complete') return
    expect(generated.files.map(({ target, path }) => `${target}:${path}`)).toEqual([
        'cursor:.cursor/agents/reviewer.md',
        'cursor:.cursor/cli.json',
        'cursor:.cursor/hooks.json',
        'cursor:.cursor/mcp.json',
        'cursor:.cursor/rules/base.mdc',
        'cursor:.cursor/skills/check/SKILL.md',
        'grokcli:.grok/agents/reviewer.md',
        'grokcli:.grok/config.toml',
        'grokcli:.grok/hooks/rulesync.json',
        'grokcli:.grok/skills/check/SKILL.md',
        'grokcli:AGENTS.md',
    ])
})

it('runs the two estate passes concurrently and settles both readers before cleanup', async () => {
    authorityFault.observeTargetConcurrency = true

    const outcome = await generateSurfaceBatch(completeBatch())

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    expect(authorityFault.maxActiveTargetPipelines).toBe(2)
    expect(authorityFault.maxActiveGeneratorExecutions).toBe(2)
    expect([...authorityFault.completedTargetPipelines].sort()).toEqual(['first', 'second'])
    expect(authorityFault.stageOrder).toEqual({
        first: ['first'],
        second: ['second'],
    })
    expect(authorityFault.cleanupActiveTargetPipelines).toEqual([0])
})

// macOS reaches /tmp through a symlink to /private/tmp, and TMPDIR is unset under launchd, cron and
// `env -i`; staging must still complete and leave nothing behind.
it('completes and removes its staging when the temporary root is a symbolic link', async () => {
    const real = await realpath(mkdtempSync(join(tmpdir(), 'cockpit-linked-tmp-')))
    const linked = `${real}-link`
    symlinkSync(real, linked)
    const previous = process.env.TMPDIR
    process.env.TMPDIR = linked
    try {
        const outcome = await generateSurfaceBatch(completeBatch())

        expect(outcome.kind, JSON.stringify(outcome.diagnostics)).toBe('complete')
        expect(readdirSync(real)).toEqual([])
    } finally {
        if (previous === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previous
        rmSync(linked)
        rmSync(real, { recursive: true, force: true })
    }
})

it('renders an authenticated Claude plugin component inventory from the same neutral sources', async () => {
    const [firstEstate, secondEstate] = [
        await generateSurfaceEstate({ bundle: claudePluginBundle() }),
        await generateSurfaceEstate({ bundle: claudePluginBundle() }),
    ]
    const first = firstEstate.kind === 'complete' ? firstEstate.bundle : undefined
    const second = secondEstate.kind === 'complete' ? secondEstate.bundle : undefined

    expect(first?.kind, JSON.stringify(firstEstate)).toBe('complete')
    expect(second?.kind, JSON.stringify(secondEstate)).toBe('complete')
    if (!first || !second) return
    expect(first.format).toBe('claudecode-plugin')
    expect(first.files).toEqual(second.files)
    expect(first.files.map(file => file.path)).toEqual(claudePluginBundle().expectedOutputs)
    expect(first.files.every(file => file.sha256 === createHash('sha256').update(file.bytes).digest('hex'))).toBe(true)
    expect(first.files.some(file => file.path === '.claude-plugin/plugin.json')).toBe(false)
})

it('retains authenticated Claude trust warnings with their native generated bytes', async () => {
    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['permissions'],
        sources: [trustPermissionSource],
        expectedOutputs: { claudecode: ['.claude/settings.json'] },
    })

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.warnings).toEqual([{
        severity: 'warning',
        code: 'SURFACE_GENERATOR_TRUST_WARNING',
        target: 'claudecode',
        path: '.claude/settings.json',
        message: expectedTrustWarning,
    }])
    expect(JSON.parse(outcome.files[0]?.bytes ?? '')).toEqual({
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        permissions: { additionalDirectories: ['../shared'] },
        enabledMcpjsonServers: ['synthetic'],
    })
})

it('names only what the Claude settings grant, and warns about nothing when they grant nothing', async () => {
    const generate = (claudecode: object) => generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['permissions'],
        sources: [{ path: 'permissions.jsonc', bytes: `${JSON.stringify({ permission: {}, claudecode })}\n` }],
        expectedOutputs: { claudecode: ['.claude/settings.json'] },
    })
    // Rulesync warns about a present empty server list; it approves nothing, so cockpit leaves it out.
    const granted = await generate({ permissions: { additionalDirectories: ['../shared'] }, enabledMcpjsonServers: [], permission: { bash: { 'npm test': 'allow' } } })
    expect(granted.kind, JSON.stringify(granted)).toBe('complete')
    if (granted.kind !== 'complete') return
    expect(granted.warnings).toEqual([expect.objectContaining({ code: 'SURFACE_GENERATOR_TRUST_WARNING',
        message: "Claude Code permissions: writing 2 trust-affecting settings to .claude/settings.json; review them as you would a hook because synced agent settings can widen filesystem access, approve project servers or run commands without asking. 'permissions.additionalDirectories' — moves the boundary of what Claude Code may read and edit outside the project: \"../shared\"; 'permissions.allow' — lets Claude Code run 1 command pattern without asking; the file lists each one.",
    })])
    expect(JSON.parse(granted.files[0]?.bytes ?? '')).toMatchObject({ permissions: { additionalDirectories: ['../shared'], allow: ['Bash(npm test)'] }, enabledMcpjsonServers: [] })

    const nothing = await generate({ permissions: { additionalDirectories: [] }, enabledMcpjsonServers: [] })
    expect(nothing).toMatchObject({ kind: 'complete', warnings: [] })
})

it.each([
    { name: 'empty', bytes: '{\n  // no generic rules\n  "permission": {},\n}\n', expected: [] },
    { name: 'nonempty', bytes: '{\n  // one generic rule\n  "permission": { "read": { "./**": "allow" } },\n}\n', expected: ['.grok/config.toml'] },
])('matches Grok Build permission output for a $name JSONC source', async ({ bytes, expected }) => {
    const outcome = await generateSurfaceBatch({
        targets: ['grokcli'],
        features: ['rules', 'permissions'],
        sources: [sources[0], { path: 'permissions.jsonc', bytes }],
        expectedOutputs: { grokcli: ['AGENTS.md', ...expected] },
    })

    if (expected.length === 0) {
        expect(outcome).toMatchObject({ kind: 'refusal', files: [], diagnostics: [expect.objectContaining({
            code: 'SURFACE_FEATURE_COVERAGE', target: 'grokcli',
        })] })
        return
    }
    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.files.map(file => file.path)).toEqual(['AGENTS.md', ...expected])
})

it('compiles target-specific Cursor and Grok Build directory grant fragments', async () => {
    const shared = '../shared/**'
    const outcome = await generateSurfaceBatch({
        targets: ['cursor', 'grokcli'],
        features: ['permissions'],
        sources: [{ path: 'permissions.jsonc', bytes: `${JSON.stringify({
            permission: {},
            cursor: { permission: { read: { [shared]: 'allow' }, write: { [shared]: 'allow' } } },
            grokcli: { permission: { read: { [shared]: 'allow' }, edit: { [shared]: 'allow' } } },
        }, null, 2)}\n` }],
        expectedOutputs: { cursor: ['.cursor/cli.json'], grokcli: ['.grok/config.toml'] },
    })

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.files).toHaveLength(2)
    expect(outcome.files.every(file => file.bytes.includes('../shared'))).toBe(true)
})

it('does not infer a Grok Build permission feature from its shared MCP output path', async () => {
    const outcome = await generateSurfaceEstate({ batch: {
        targets: ['grokcli'],
        features: ['mcp', 'permissions'],
        sources: [sources[1], { path: 'permissions.jsonc', bytes: '{"permission":{}}\n' }],
        expectedOutputs: { grokcli: ['.grok/config.toml'] },
    } })

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(authorityFault.observedGrokFeatures).toEqual(['mcp'])
    expect(outcome.batch?.files.map(file => file.path)).toEqual(['.grok/config.toml'])
})

it('omits MCP generation for a target whose only server is explicitly removed', async () => {
    const outcome = await generateSurfaceEstate({ batch: {
        targets: ['cursor', 'grokcli'],
        features: ['rules', 'mcp'],
        sources: [sources[0], { path: 'mcp.jsonc', bytes: JSON.stringify({
            mcpServers: { synthetic: { command: 'node', args: ['synthetic-server.mjs'] } },
            grokcli: { mcpServers: { synthetic: null } },
        }) + '\n' }],
        expectedOutputs: { cursor: ['.cursor/mcp.json', '.cursor/rules/base.mdc'], grokcli: ['AGENTS.md'] },
    } })

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(authorityFault.observedGrokFeatures).toEqual(['rules'])
    expect(outcome.batch?.files.map(file => `${file.target}:${file.path}`)).toEqual([
        'cursor:.cursor/mcp.json', 'cursor:.cursor/rules/base.mdc', 'grokcli:AGENTS.md',
    ])
})

it.each([
    ['missing', '{}'],
    ['null', '{"mcpServers":null}'],
])('refuses a %s shared MCP map even when only rule outputs are expected', async (_name, bytes) => {
    const outcome = await generateSurfaceEstate({ batch: {
        targets: ['grokcli'], features: ['rules', 'mcp'],
        sources: [sources[0], { path: 'mcp.jsonc', bytes }],
        expectedOutputs: { grokcli: ['AGENTS.md'] },
    } })

    expect(outcome).toMatchObject({ kind: 'refusal', files: [], diagnostics: [expect.objectContaining({
        code: 'SURFACE_WORKER_STDERR', cause: 'stderr',
    })] })
})

it('requires MCP output when a target replaces its removed shared server', async () => {
    const batch = {
        targets: ['grokcli'], features: ['rules', 'mcp'],
        sources: [sources[0], { path: 'mcp.jsonc', bytes: JSON.stringify({
            mcpServers: { synthetic: { command: 'node', args: ['synthetic-server.mjs'] } },
            grokcli: { mcpServers: { synthetic: null, replacement: { command: 'node', args: ['replacement.mjs'] } } },
        }) + '\n' }],
        expectedOutputs: { grokcli: ['.grok/config.toml', 'AGENTS.md'] },
    }
    const outcome = await generateSurfaceEstate({ batch })

    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(authorityFault.observedGrokFeatures).toEqual(['rules', 'mcp'])
    expect(outcome.batch?.files.find(file => file.path === '.grok/config.toml')?.bytes).toContain('replacement.mjs')
    const missing = await generateSurfaceEstate({ batch: { ...batch, expectedOutputs: { grokcli: ['AGENTS.md'] } } })
    expect(missing).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_OUTPUT_COVERAGE', target: 'grokcli' })], files: [] })
})

it('refuses an unrecognized Rulesync warning without admitting generated bytes', async () => {
    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['permissions'],
        sources: [{
            path: 'permissions.jsonc',
            bytes: '{"permission":{},"claudecode":{"apiKeyHelper":"synthetic-command"}}\n',
        }],
        expectedOutputs: { claudecode: ['.claude/settings.json'] },
    })

    expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'SURFACE_WORKER_STDERR', cause: 'stderr' }))
})

it('refuses a warning receipt beyond the bounded channel without admitting generated bytes', async () => {
    authorityFault.kind = 'warning-receipt-bounds'
    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['permissions'],
        sources: [trustPermissionSource],
        expectedOutputs: { claudecode: ['.claude/settings.json'] },
    })

    expect(authorityFault.stagedRuleWrites).toBe(1)
    expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'SURFACE_WORKER_OUTPUT', cause: 'worker-output' }))
})

it('refuses trust-warning variance across independent staging runs', async () => {
    authorityFault.kind = 'warning-stage-variance'

    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['permissions'],
        sources: [trustPermissionSource],
        expectedOutputs: { claudecode: ['.claude/settings.json'] },
    })

    expect(authorityFault.stagedRuleWrites).toBe(2)
    expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({
        code: 'SURFACE_STAGE_VARIANCE', target: 'claudecode', cause: 'artifact',
    }))
    expect(outcome.diagnostics[0]?.message).toContain('warning')
})

it('refuses stage variance within one generation call without admitting bytes', async () => {
    authorityFault.kind = 'stage-variance'

    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['rules'],
        sources: [sources[0]],
        expectedOutputs: { claudecode: ['CLAUDE.md'] },
    })

    expect(authorityFault.stagedRuleWrites).toBe(2)
    expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({
        code: 'SURFACE_STAGE_VARIANCE', target: 'claudecode', cause: 'artifact',
    }))
})

it('refuses generated output over the neutral file limit before completion', async () => {
    const bytes = 'x'.repeat(SURFACE_FILE_MAX_BYTES)

    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['rules'],
        sources: [{ path: 'rules/base.md', bytes }],
        expectedOutputs: { claudecode: ['CLAUDE.md'] },
    })

    expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ target: 'claudecode' }))
})

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

it('evaluates the authenticated generator bytes when the bundle path can change before load', () => {
    const worker = resolve(ROOT, 'packages/cockpit/libexec/surface-generator-worker.cjs')
    const scratch = mkdtempSync(join(tmpdir(), 'cockpit-rulesync-load-'))
    const bundle = join(scratch, 'generator.cjs')
    const authenticated = "module.exports = { marker: 'authenticated' };\n"
    const changed = "module.exports = { marker: 'changed' };\n"
    try {
        writeFileSync(bundle, authenticated)
        const script = [
            `const fs = require('node:fs'); const worker = require(${JSON.stringify(worker)})`,
            `const [bundlePath, sha256] = process.argv.slice(1)`,
            'const bytes = worker.authenticateBundle(bundlePath, sha256, 1024)',
            `fs.writeFileSync(bundlePath, ${JSON.stringify(changed)})`,
            'process.stdout.write(worker.loadAuthenticatedBundle(bundlePath, bytes).marker)',
        ].join('\n')
        const digest = createHash('sha256').update(authenticated).digest('hex')

        expect(execFileSync(process.execPath, ['-e', script, bundle, digest], { encoding: 'utf8' })).toBe('authenticated')
        expect(readFileSync(bundle, 'utf8')).toBe(changed)
        expect(readFileSync(worker, 'utf8')).not.toContain('require(bundlePath)')
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
})

function nativeGeneratorAccesses(sources: ReadonlyMap<string, string>): string[] {
    const accesses: string[] = []
    for (const [path, source] of sources) {
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        let found = false
        const visit = (node: ts.Node): void => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
                && (node.moduleSpecifier.text === 'rulesync' || node.moduleSpecifier.text.startsWith('rulesync/'))) found = true
            if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
                && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)
                && (node.moduleReference.expression.text === 'rulesync'
                    || node.moduleReference.expression.text.startsWith('rulesync/'))) found = true
            if (ts.isCallExpression(node)) {
                const [argument] = node.arguments
                if (argument && ts.isStringLiteralLike(argument)
                    && (argument.text === 'rulesync' || argument.text.startsWith('rulesync/'))
                    && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                        || node.expression.getText(sourceFile) === 'require'
                        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve')) found = true
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        if (found) accesses.push(path)
    }
    return accesses.sort()
}

it('keeps native generator imports out of the runtime source tree', () => {
    const paths = execFileSync('git', ['ls-files', '-z', 'packages/cockpit/src'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter(path => path !== '' && /\.[cm]?[jt]s$/.test(path) && !/\.(?:test|spec|d)\.[cm]?[jt]s$/.test(path))
    const sourcesByPath = new Map(paths.map(path => [path, readFileSync(resolve(ROOT, path), 'utf8')]))
    expect(nativeGeneratorAccesses(sourcesByPath)).toEqual([])
    expect(nativeGeneratorAccesses(new Map([
        ...sourcesByPath,
        ['packages/cockpit/src/surfaces/forbidden-control.ts', "import { generate } from 'rulesync'"],
    ]))).toEqual(['packages/cockpit/src/surfaces/forbidden-control.ts'])
})

it('accepts only builtin runtime imports in the generated bundle and rejects a broken control', () => {
    const script = resolve(ROOT, 'packages/cockpit/scripts/build-rulesync-generator.mjs')
    const bundle = resolve(ROOT, 'packages/cockpit/libexec/rulesync-generator.cjs')
    const scratch = mkdtempSync(join(tmpdir(), 'cockpit-rulesync-imports-'))
    const broken = join(scratch, 'broken.cjs')
    try {
        writeFileSync(broken, "require('synthetic-external-runtime')\n")
        expect(execFileSync(process.execPath, [script, '--check-imports', bundle], { encoding: 'utf8' })).toBe('')
        const rejected = spawnSync(process.execPath, [script, '--check-imports', broken], { encoding: 'utf8' })
        expect(rejected.status).toBe(1)
        expect(rejected.stderr).toContain('external runtime imports: synthetic-external-runtime')
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
})

it('refuses malformed MCP after partial generation and admits no bytes', async () => {
    const outcome = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['rules', 'mcp'],
        sources: [sources[0], { path: 'mcp.jsonc', bytes: '{"mcpServers":' }],
        expectedOutputs: { claudecode: ['.mcp.json', 'CLAUDE.md'] },
    })

    expect(outcome.kind).toBe('refusal')
    expect(outcome.files).toEqual([])
    expect(outcome.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SURFACE_WORKER_STDERR', cause: 'stderr' }),
    ]))
})

it('refuses an unsupported requested permission category without disabling the family', async () => {
    const outcome = await generateSurfaceBatch({
        targets: ['codexcli'],
        features: ['permissions'],
        sources: [{ path: 'permissions.jsonc', bytes: '{"permission":{"external_directory":{"../shared/**":"allow"}}}\n' }],
        expectedOutputs: { codexcli: ['.codex/config.toml', '.codex/rules/rulesync.rules'] },
    })

    expect(outcome.kind).toBe('refusal')
    expect(outcome.files).toEqual([])
    expect(outcome.diagnostics[0]).toEqual(expect.objectContaining({ code: 'SURFACE_WORKER_STDERR', cause: 'stderr' }))
    expect(outcome.diagnostics[0]?.stderr).toContain('support only read/edit/write/webfetch')
})

it('refuses invalid, colliding, and incomplete coverage without admitting bytes', async () => {
    const invalid = await generateSurfaceBatch({
        ...completeBatch(),
        sources: [{ path: '../rules.md', bytes: 'unsafe' }],
    })
    const collision = await generateSurfaceBatch({
        ...completeBatch(),
        expectedOutputs: { ...expectedOutputs, codexcli: ['AGENTS.md', 'AGENTS.md'] },
    })
    const incomplete = await generateSurfaceBatch({
        targets: ['claudecode'],
        features: ['rules'],
        sources: [sources[0]],
        expectedOutputs: { claudecode: ['CLAUDE.md', '.claude/missing.md'] },
    })

    expect(invalid).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(collision).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(incomplete).toEqual(expect.objectContaining({ kind: 'refusal', files: [] }))
    expect(incomplete.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SURFACE_OUTPUT_COVERAGE', cause: 'coverage' }),
    ]))
})

async function nodeStep(source: string, timeoutMs: number): Promise<ExecutionStep> {
    const executable = await realpath(process.execPath)
    const executableBytes = await readFile(executable)
    const step = snapshotExecutionStep({
        id: `surface-owner-${timeoutMs}`,
        argv: [executable, '-e', source],
        argv0: executable,
        cwd: process.cwd(),
        env: {},
        timeoutMs,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 1024,
        paths: [process.cwd()],
        ports: [],
        labels: { boundary: 'surface-worker' },
        expected: [],
        consumedFiles: [{
            path: executable,
            sha256: createHash('sha256').update(executableBytes).digest('hex'),
            maxBytes: 536_870_912,
            argvIndexes: [0],
            executable: true,
            executionMode: 'verified-path',
        }],
        filesystemChecks: [{ path: process.cwd(), expected: 'directory' }],
        compensation: [],
    })
    if (!step) throw new TypeError('test could not construct the execution owner input')
    return step
}

it('authenticates actual bounded-owner timeout and nonzero refusals', async () => {
    const timeout = await nodeStep('setInterval(() => {}, 1000)', 25)
    const nonzero = await nodeStep('process.exit(7)', 1_000)
    const timeoutOutcome = await executeProbe(timeout)
    const nonzeroOutcome = await executeProbe(nonzero)

    expect(authenticatedExecutionOutcome(timeoutOutcome, timeout)).toEqual(expect.objectContaining({
        kind: 'refusal', code: 'EXECUTION_TIMEOUT',
    }))
    expect(authenticatedExecutionOutcome(nonzeroOutcome, nonzero)).toEqual(expect.objectContaining({
        kind: 'refusal', code: 'EXECUTION_STEP_FAILED',
    }))
})
