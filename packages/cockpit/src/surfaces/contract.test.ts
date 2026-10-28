import { createHash } from 'node:crypto'

import { expect, expectTypeOf, it } from 'vitest'

import {
    bundleSurfaceFiles,
    captureSurfaceBundleBatch,
    captureSurfaceBatch,
    SURFACE_FILE_MAX_BYTES,
    SURFACE_OUTPUT_MAX_BYTES,
    type RenderedSurfaceFile,
    type SurfaceBatch,
    type SurfaceFeature,
    type SurfaceSourceFile,
    type SurfaceTarget,
} from './contract.js'

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

const completeBatch = () => ({
    targets: ['claudecode', 'codexcli', 'opencode'],
    features: ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'],
    sources: [
        { path: 'rules/base.md', bytes: '# Shared rules\n' },
        { path: 'mcp.jsonc', bytes: '{}\n' },
        { path: 'subagents/reviewer.md', bytes: '# Reviewer\n' },
        { path: 'skills/check/SKILL.md', bytes: '# Check\n' },
        { path: 'skills/check/references/usage.md', bytes: '# Usage\n' },
        { path: 'hooks.jsonc', bytes: '{}\n' },
        { path: 'permissions.jsonc', bytes: '{}\n' },
    ],
    expectedOutputs: {
        claudecode: ['CLAUDE.md', '.claude/agents/reviewer.md'],
        codexcli: ['AGENTS.md', '.codex/config.toml'],
        opencode: ['AGENTS.md', 'opencode.jsonc'],
    },
})

const rulesBatch = (sources = [{ path: 'rules/base.md', bytes: '# Shared rules\n' }]) => ({
    targets: ['codexcli'],
    features: ['rules'],
    sources,
    expectedOutputs: { codexcli: ['AGENTS.md'] },
})

it('captures one exact complete batch as immutable caller-independent data', () => {
    const input = completeBatch()
    const captured = captureSurfaceBatch(input)

    expect(captured).toEqual(input)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured?.sources)).toBe(true)
    expect(Object.isFrozen(captured?.sources[0])).toBe(true)
    expect(Object.isFrozen(captured?.expectedOutputs)).toBe(true)
    expect(Object.isFrozen(captured?.expectedOutputs.claudecode)).toBe(true)
    input.sources[0]!.bytes = 'changed'
    input.expectedOutputs.claudecode[0] = 'changed'
    expect(captured?.sources[0]?.bytes).toBe('# Shared rules\n')
    expect(captured?.expectedOutputs.claudecode?.[0]).toBe('CLAUDE.md')

    expectTypeOf(captured).toEqualTypeOf<SurfaceBatch | undefined>()
    expectTypeOf<SurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode' | 'cursor' | 'grokcli'>()
    expectTypeOf<SurfaceFeature>().toEqualTypeOf<'rules' | 'mcp' | 'subagents' | 'skills' | 'hooks' | 'permissions'>()
    expectTypeOf<SurfaceSourceFile>().toMatchTypeOf<Readonly<{ path: string; bytes: string }>>()
})

it('captures only measured Claude plugin component families as an opt-in bundle', () => {
    const batch = completeBatch()
    const input = {
        format: 'claudecode-plugin',
        features: ['mcp', 'subagents', 'skills', 'hooks'],
        sources: batch.sources.filter(source => !source.path.startsWith('rules/') && source.path !== 'permissions.jsonc'),
        expectedOutputs: ['.mcp.json', 'agents/reviewer.md', 'hooks/hooks.json', 'skills/check/SKILL.md'],
    }

    const captured = captureSurfaceBundleBatch(input)

    expect(captured).toEqual(input)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured?.features)).toBe(true)
    expect(Object.isFrozen(captured?.sources)).toBe(true)
    expect(Object.isFrozen(captured?.expectedOutputs)).toBe(true)
    expect(captureSurfaceBundleBatch({ ...input, features: ['rules'] })).toBeUndefined()
    expect(captureSurfaceBundleBatch({ ...input, format: 'unknown' })).toBeUndefined()
    expect(captureSurfaceBundleBatch({ ...input, expectedOutputs: [] })).toBeUndefined()
})

it('rejects non-own input without invoking accessors', () => {
    const valid = completeBatch()
    expect(captureSurfaceBatch(new Proxy(valid, {}))).toBeUndefined()

    let reads = 0
    const accessor = { ...valid } as Record<string, unknown>
    Object.defineProperty(accessor, 'sources', {
        enumerable: true,
        get: () => {
            reads += 1
            return valid.sources
        },
    })
    expect(captureSurfaceBatch(accessor)).toBeUndefined()
    expect(reads).toBe(0)
})

it('requires exact requested coverage and bounded coherent source namespaces', () => {
    const valid = completeBatch()
    const maximumRules = Array.from({ length: 4_096 }, (_, index) => ({ path: `rules/${index}.md`, bytes: 'x' }))
    expect(captureSurfaceBatch(rulesBatch(maximumRules))).toBeDefined()
    expect(captureSurfaceBatch(rulesBatch([{ path: 'rules/large.md', bytes: 'x'.repeat(SURFACE_FILE_MAX_BYTES) }]))).toBeDefined()

    const invalid = [
        { ...valid, extra: true },
        { ...valid, targets: ['codexcli', 'codexcli'] },
        { ...valid, features: ['rules', 'rules'] },
        { ...valid, features: [...valid.features, 'unknown'] },
        { ...valid, features: valid.features.filter(feature => feature !== 'hooks') },
        { ...valid, sources: valid.sources.filter(source => source.path !== 'hooks.jsonc') },
        { ...valid, sources: valid.sources.filter(source => source.path !== 'skills/check/SKILL.md') },
        { ...valid, sources: [...valid.sources, { path: 'rules/base.md', bytes: 'duplicate' }] },
        rulesBatch([{ path: 'rules/../mcp.jsonc', bytes: '{}' }]),
        rulesBatch([{ path: 'rules\\base.md', bytes: '# Rules' }]),
        rulesBatch([{ path: 'internal/rules/base.md', bytes: '# Rules' }]),
        {
            targets: ['codexcli'],
            features: ['skills'],
            sources: [{ path: 'skills/check/assets/icon.svg', bytes: '<svg />' }],
            expectedOutputs: { codexcli: ['.agents/skills/check/SKILL.md'] },
        },
        { ...valid, expectedOutputs: { ...valid.expectedOutputs, extra: ['output.md'] } },
        { ...valid, expectedOutputs: { ...valid.expectedOutputs, codexcli: [] } },
        { ...valid, expectedOutputs: { ...valid.expectedOutputs, codexcli: ['AGENTS.md', 'AGENTS.md'] } },
        { ...valid, expectedOutputs: { ...valid.expectedOutputs, codexcli: ['node_modules/output.md'] } },
        { ...valid, expectedOutputs: { claudecode: valid.expectedOutputs.claudecode } },
        rulesBatch([...maximumRules, { path: 'rules/4096.md', bytes: 'x' }]),
        rulesBatch([{ path: 'rules/large.md', bytes: 'x'.repeat(SURFACE_FILE_MAX_BYTES + 1) }]),
    ]

    for (const candidate of invalid) expect(captureSurfaceBatch(candidate)).toBeUndefined()
})

it('bundles admitted bytes under target prefixes in deterministic path order', () => {
    const rendered: Array<{ target: SurfaceTarget; path: string; bytes: string; sha256: string }> = [
        { target: 'opencode', path: 'AGENTS.md', bytes: 'open', sha256: sha256('open') },
        { target: 'claudecode', path: '.claude/rules/base.md', bytes: 'claude', sha256: sha256('claude') },
        { target: 'codexcli', path: 'AGENTS.md', bytes: 'codex', sha256: sha256('codex') },
    ]

    const bundle = bundleSurfaceFiles(rendered)

    expect(bundle).toEqual([
        { path: 'claudecode/.claude/rules/base.md', bytes: 'claude' },
        { path: 'codexcli/AGENTS.md', bytes: 'codex' },
        { path: 'opencode/AGENTS.md', bytes: 'open' },
    ])
    expect(Object.isFrozen(bundle)).toBe(true)
    expect(Object.isFrozen(bundle?.[0])).toBe(true)
    rendered[0]!.bytes = 'changed'
    expect(bundle?.[2]?.bytes).toBe('open')
})

it('admits a file at the neutral byte limit and refuses one byte over it', () => {
    const exactBytes = 'x'.repeat(SURFACE_FILE_MAX_BYTES)
    const exact = { target: 'codexcli', path: 'AGENTS.md', bytes: exactBytes, sha256: sha256(exactBytes) } as const
    const oversizedBytes = `${exactBytes}x`
    const oversized = { ...exact, bytes: oversizedBytes, sha256: sha256(oversizedBytes) }

    expect(bundleSurfaceFiles([exact])).toEqual([{ path: 'codexcli/AGENTS.md', bytes: exactBytes }])
    expect(bundleSurfaceFiles([oversized])).toBeUndefined()
})

it('admits the declared aggregate byte limit and refuses one file beyond it', () => {
    const bytes = 'x'.repeat(SURFACE_FILE_MAX_BYTES)
    const fileCount = SURFACE_OUTPUT_MAX_BYTES / SURFACE_FILE_MAX_BYTES
    const rendered = Array.from({ length: fileCount + 1 }, (_, index) => ({
        target: 'codexcli' as const,
        path: `rules/${index}.md`,
        bytes,
        sha256: sha256(bytes),
    }))

    expect(bundleSurfaceFiles(rendered.slice(0, fileCount))).toHaveLength(fileCount)
    expect(bundleSurfaceFiles(rendered)).toBeUndefined()
})

it('refuses empty, malformed, colliding, escaped, or hash-incoherent rendered sets', () => {
    const file = { target: 'codexcli', path: 'AGENTS.md', bytes: 'codex', sha256: sha256('codex') } as const
    for (const candidate of [
        [],
        [new Proxy(file, {})],
        [{ ...file, extra: true }],
        [{ ...file, target: 'unknown' }],
        [{ ...file, path: '../AGENTS.md' }],
        [{ ...file, path: '.git/config' }],
        [{ ...file, sha256: '0'.repeat(64) }],
        [file, file],
        Array.from({ length: 4_097 }, (_, index) => ({
            ...file,
            path: `rules/${index}.md`,
            sha256: sha256('codex'),
        })),
    ]) expect(bundleSurfaceFiles(candidate as readonly RenderedSurfaceFile[])).toBeUndefined()
})
