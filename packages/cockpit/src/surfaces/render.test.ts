import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { renderSurfaceSet, surfaceModelSha256 } from './render.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const file = (target: string, path: string, bytes: string) => ({ target, path, bytes, sha256: digest(bytes) })

function input() {
    const mcpResult = { servers: [], wrappers: [], harnesses: [] }
    const grants: unknown[] = []
    const guard = { path: '.cockpit/guards/bash-guard.sh', bytes: '# guard\n', sha256: digest('# guard\n') }
    return {
        configuredHarnesses: ['claudecode', 'codexcli', 'cursor', 'grokcli', 'opencode'],
        merge: { kind: 'complete', surfaces: [], overrides: [], findings: [] },
        generated: { kind: 'complete', status: 0, diagnostics: [], mechanism: { package: 'rulesync', version: '43.1.2', role: 'spelling' }, files: [
            file('codexcli', 'AGENTS.md', 'base instructions\n'),
            file('opencode', 'AGENTS.md', 'base instructions\n'),
            file('opencode', 'opencode.jsonc', '{"$schema":"schema.json","instructions":[]}\n'),
            file('cursor', '.cursor/rules/base.mdc', 'base instructions\n'),
            file('grokcli', 'AGENTS.md', 'base instructions\n'),
        ] },
        projection: { kind: 'complete', links: [], native: [
            { target: 'codexcli', path: 'AGENTS.md', spelling: 'Read ./peer.md before editing peer.', capability: 'instructed' },
            { target: 'opencode', path: 'opencode.jsonc', spelling: 'peer.md', capability: 'instructed' },
        ], grants },
        mcp: { kind: 'complete', result: mcpResult, diagnostics: [] },
        restrictions: { kind: 'complete', sharedGuard: guard, targets: [
            { target: 'claudecode', capability: 'instructed', files: [], readonly: { fragment: null } },
        ] },
        nativeMcp: { modelSha256: surfaceModelSha256(mcpResult)!, fragments: [] },
        nativeGrants: { modelSha256: surfaceModelSha256(grants)!, fragments: [] },
        browser: null,
        browserReference: null,
        skillReferences: [],
        browserRunner: null,
        testing: null,
        instructions: null,
        customHarnesses: [], customReceipts: [], sourceEvidence: [],
    }
}

describe('surface rendering', () => {
    it('publishes shared instructions once and makes Claude import the common guide', () => {
        const value = input()
        value.generated.files.push(file('claudecode', 'CLAUDE.md', 'base instructions\n'))
        const result = renderSurfaceSet({ ...value, instructions: '# Working here\nUse the cockpit.\n' })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.entries.find(entry => entry.path === 'AGENTS.md')).toMatchObject({
            kind: 'shared-region', harnesses: [...input().configuredHarnesses].sort(),
            region: { bytes: expect.stringContaining('# Working here\nUse the cockpit.\n') },
        })
        expect(result.entries.find(entry => entry.path === 'CLAUDE.md')).toMatchObject({
            kind: 'shared-region', region: { bytes: '@AGENTS.md\n' },
        })
    })

    it('retains unavailable browser rows without emitting an unissued native transport', () => {
        const value = input()
        const browser = {
            rows: [{ target: 'codexcli', transport: 'mcp', declaration: 'unavailable', callable: 'unavailable' }],
            files: [], probes: [], clients: [], graderBrowserAccess: 'retained',
            mcp: { kind: 'complete', result: { servers: [], wrappers: [], harnesses: [] }, diagnostics: [] },
        }
        const rendering = { ...value, browser, browserReference: '# Browser reference\n' }
        expect(renderSurfaceSet(rendering)).toMatchObject({ kind: 'complete' })
        const forged = { ...rendering, mcp: { ...value.mcp, result: { ...value.mcp.result,
            servers: [{ name: 'playwright', enabled: true, sources: [] }],
        } } }
        expect(renderSurfaceSet(forged)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_INPUT_INVALID' } })
    })

    it('renders each skill reference beside its skill on every configured built-in harness and refuses a malformed one', () => {
        const value = input()
        const reference = { skill: 'cockpit-setup', path: 'references/test-data-and-personas.md', bytes: '# Personas\n<!-- cockpit:verified version=0.0.0 -->\n' }
        const result = renderSurfaceSet({ ...value, skillReferences: [reference] })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        const entry = result.entries.find(row => row.path === '.claude/skills/cockpit-setup/references/test-data-and-personas.md')
        expect(entry).toMatchObject({ kind: 'file', ownership: 'whole-file', writer: 'cockpit' })
        expect((entry as { bytes: string }).bytes).not.toContain('cockpit:verified')
        for (const bad of [{ ...reference, path: '../escape.md' }, { ...reference, skill: 'Bad Skill' }, { ...reference, bytes: '' }]) {
            expect(renderSurfaceSet({ ...value, skillReferences: [bad] })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_INPUT_INVALID' } })
        }
    })

    it('publishes the authenticated browser runner through the sole surface transaction', () => {
        const value = input()
        const bytes = '#!/bin/sh\nexec node runner.js\n'
        const result = renderSurfaceSet({ ...value, browserRunner: {
            path: 'scripts/browser-runner.sh', bytes, sha256: digest(bytes),
        } })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.entries.find(entry => entry.path === '.cockpit/browser/runner.sh')).toMatchObject({
            kind: 'file', ownership: 'whole-file', bytes, sha256: digest(bytes), writer: 'cockpit',
        })
    })

    it('retains bounded generator trust warnings and rejects malformed warning records', () => {
        const value = input()
        value.generated.files.push(file('claudecode', '.claude/settings.json', '{"permissions":{"additionalDirectories":["/workspace/peer"]}}\n'))
        const warning = { severity: 'warning', code: 'SURFACE_GENERATOR_TRUST_WARNING', target: 'claudecode',
            path: '.claude/settings.json', message: 'Claude Code permissions require review.' }
        const render = (warnings: unknown) => renderSurfaceSet({ ...value, generated: { ...value.generated, warnings } })
        const result = render([warning])
        expect(result).toMatchObject({ kind: 'complete', warnings: [warning] })
        if (result.kind !== 'complete') return
        expect(Object.isFrozen(result.warnings)).toBe(true)
        expect(Object.isFrozen(result.warnings[0])).toBe(true)
        const original = warning.message
        warning.message = 'changed'
        expect(result.warnings[0]?.message).toBe(original)
        for (const warnings of [
            null,
            [{ ...warning, code: 'UNKNOWN' }], [{ ...warning, severity: 'error' }],
            [{ ...warning, target: 'codexcli' }], [{ ...warning, path: '.codex/config.toml' }],
            [{ ...warning, message: '' }], [{ ...warning, extra: true }],
            [{ ...warning, message: 'x'.repeat(4097) }], Array.from({ length: 17 }, () => warning),
            Array.from({ length: 5 }, () => ({ ...warning, message: 'x'.repeat(4096) })),
        ]) expect(render(warnings)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_INPUT_INVALID' } })
        const noSettings = { ...value, generated: { ...value.generated,
            files: value.generated.files.filter(row => row.path !== '.claude/settings.json'), warnings: [warning] } }
        expect(renderSurfaceSet(noSettings)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_INPUT_INVALID' } })
    })

    it('records a projected guide by sibling and in-sibling path, never by its machine path or content', () => {
        const value = input()
        const path = '.cockpit/siblings/peer.md'
        const guide = '/workspace/peer/AGENTS.md'
        const sha256 = digest('peer guide\n')
        const identity = 'file:peer-guide'
        const result = renderSurfaceSet({
            ...value,
            projection: {
                ...value.projection,
                links: [{ sibling: 'peer', path, target: '../../../peer/AGENTS.md', sourceGuidePath: guide,
                    sourceContentPath: guide, sourceContentSha256: sha256, sourceContentIdentity: identity }],
                native: value.projection.native.map(row => ({ ...row, linkPath: path })),
            },
            sourceEvidence: [{ kind: 'guide', root: '/workspace/peer', path: guide, sha256, identity }],
        })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.entries.find(entry => entry.path === path)).toMatchObject({
            kind: 'symlink', source: { sibling: 'peer', path: 'AGENTS.md' },
        })
    })

    it('deduplicates identical physical instruction bases and combines narrow shared contributions', () => {
        const result = renderSurfaceSet(input())
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        const agents = result.entries.find(entry => entry.path === 'AGENTS.md')
        expect(agents).toMatchObject({
            kind: 'shared-region', harnesses: ['codexcli', 'grokcli', 'opencode'],
            region: { bytes: 'base instructions\nRead ./peer.md before editing peer.\n' },
        })
        expect(result.entries.find(entry => entry.path === 'opencode.jsonc')).toMatchObject({
            kind: 'shared-region', harnesses: ['opencode'],
            region: { format: 'opencode-json-root-properties', members: [
                { key: '$schema', valueBytes: '"schema.json"' },
                { key: 'instructions', valueBytes: '["peer.md"]' },
            ] },
        })
    })

    it('refuses divergent shared bases and a nonempty MCP model without exact bound native fragments', () => {
        const transport = { name: 'synthetic', command: 'node', args: ['synthetic-server.mjs'], cwd: '/workspace', enabled: false }
        const divergent = input()
        divergent.generated.files[1] = file('opencode', 'AGENTS.md', 'different\n')
        expect(renderSurfaceSet(divergent)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_PATH_CONFLICT' } })

        const missing = input()
        missing.mcp.result.servers.push({ name: 'synthetic', enabled: false, sources: [] } as never)
        missing.mcp.result.harnesses.push({ target: 'claudecode', servers: [] } as never)
        missing.nativeMcp.modelSha256 = surfaceModelSha256(missing.mcp.result)!
        expect(renderSurfaceSet(missing)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_INPUT_INVALID' } })

        const admitted = input()
        const nativeBase = '{"mcpServers":{}}\n'
        const nativeFinal = '{"mcpServers":{"synthetic":{"enabled":false}}}\n'
        admitted.generated.files.push(file('claudecode', '.mcp.json', nativeBase))
        admitted.mcp.result.servers.push({ name: 'synthetic', enabled: false, sources: [] } as never)
        admitted.mcp.result.harnesses.push({ target: 'claudecode', servers: [transport] } as never)
        admitted.nativeMcp = { modelSha256: surfaceModelSha256(admitted.mcp.result)!, fragments: [
            { target: 'claudecode', path: '.mcp.json', baseSha256: digest(nativeBase), bytes: nativeFinal, sha256: digest(nativeFinal) } as never,
        ] }
        const admittedResult = renderSurfaceSet(admitted)
        expect(admittedResult).toMatchObject({ kind: 'complete' })
        if (admittedResult.kind === 'complete') expect(admittedResult.entries.find(entry => entry.path === '.mcp.json')).toMatchObject({ bytes: nativeFinal })

        const scopedResult = { ...admitted.mcp.result, harnesses: [
            { target: 'claudecode', servers: [transport] }, { target: 'grokcli', servers: [] },
        ] }
        const scoped = { ...admitted, mcp: { ...admitted.mcp, result: scopedResult },
            nativeMcp: { ...admitted.nativeMcp, modelSha256: surfaceModelSha256(scopedResult)! } }
        const scopedRendering = renderSurfaceSet(scoped)
        expect(scopedRendering).toMatchObject({ kind: 'complete' })
        if (scopedRendering.kind === 'complete') expect(scopedRendering.entries.some(entry => entry.path === '.grok/config.toml')).toBe(false)
        for (const row of [{ target: 'grokcli', servers: [] }, { target: 'cursor' }]) {
            const malformed = { ...scopedResult, harnesses: [...scopedResult.harnesses, row] }
            expect(renderSurfaceSet({ ...scoped, mcp: { ...scoped.mcp, result: malformed },
                nativeMcp: { ...scoped.nativeMcp, modelSha256: surfaceModelSha256(malformed)! },
            })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_INPUT_INVALID' } })
        }
    })

    it('attaches readonly frontmatter and combines only the known hook slot', () => {
        const value = input()
        const agent = '---\nname: grader\n---\nbody\n'
        const settings = '{"permissions":{"allow":[]}}\n'
        const hook = '{"hooks":{"PreToolUse":[{"matcher":"Bash"}]}}\n'
        const readonly = 'disallowedTools: Edit, Write, NotebookEdit\n'
        value.generated.files.push(file('claudecode', '.claude/agents/grader.md', agent), file('claudecode', '.claude/settings.json', settings))
        value.restrictions.targets[0]!.files.push({ path: '.claude/settings.json', bytes: hook, sha256: digest(hook) } as never)
        value.restrictions.targets[0]!.readonly.fragment = { path: '.claude/agents/grader.md', bytes: readonly, sha256: digest(readonly) } as never
        const result = renderSurfaceSet(value)
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.entries.find(entry => entry.path === '.claude/agents/grader.md')).toMatchObject({
            bytes: '---\nname: grader\ndisallowedTools: Edit, Write, NotebookEdit\n---\nbody\n',
        })
        expect(result.entries.find(entry => entry.path === '.claude/settings.json')).toMatchObject({
            bytes: expect.stringContaining('"permissions"'),
        })
        expect(result.entries.find(entry => entry.path === '.claude/settings.json')).toMatchObject({
            bytes: expect.stringContaining('"PreToolUse"'),
        })
    })

    it('orders mixed-case surface paths by code unit', () => {
        const value = input()
        value.generated.files.push(
            file('claudecode', 'custom/a.md', 'lower\n'),
            file('claudecode', 'custom/Z.md', 'upper\n'),
        )
        const result = renderSurfaceSet(value)
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.entries.filter(entry => entry.path.startsWith('custom/')).map(entry => entry.path)).toEqual(['custom/Z.md', 'custom/a.md'])
    })

    it('preserves custom output scope and validates its declared module and result digest', () => {
        const value = input()
        value.configuredHarnesses.push('review-shell')
        value.configuredHarnesses.sort()
        const unavailable = ['mcp', 'subagents', 'skills', 'hooks', 'permissions'].map(feature => ({
            feature, state: 'unavailable', measured_on: '2026-09-26', reason: `No ${feature} mechanism is available`,
        }))
        value.customHarnesses.push({
            name: 'review-shell', features: ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'],
            capabilities: [{ feature: 'rules', state: 'instructed', measured_on: '2026-09-26', spelling: 'review.txt', control: 'controls/review.json', mechanism: { module: 'adapters/review.mjs', export: 'renderRules' } }, ...unavailable],
        } as never)
        const files = [{ path: 'review.txt', bytes: 'review\n', sha256: digest('review\n'), scope: 'scoped' }]
        value.customReceipts.push({ harness: 'review-shell', feature: 'rules', state: 'instructed', measuredOn: '2026-09-26',
            module: 'adapters/review.mjs', export: 'renderRules', sourceSha256: 'a'.repeat(64), resultSha256: surfaceModelSha256(files)!, files } as never)
        const result = renderSurfaceSet(value)
        expect(result).toMatchObject({ kind: 'complete', inputs: [expect.objectContaining({ kind: 'custom-harness', harness: 'review-shell' })] })
        if (result.kind === 'complete') {
            expect(result.entries.find(entry => entry.path === 'review.txt')).toMatchObject({ scope: 'scoped' })
        }

        const conflictingFiles = [
            { path: 'review.txt', bytes: 'review\n', sha256: digest('review\n'), scope: 'scoped' },
            { path: 'review.txt', bytes: 'review\n', sha256: digest('review\n'), scope: 'always' },
        ]
        value.customReceipts[0] = { ...(value.customReceipts[0] as unknown as Record<string, unknown>),
            files: conflictingFiles, resultSha256: surfaceModelSha256(conflictingFiles)! } as never
        expect(renderSurfaceSet(value)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_PATH_CONFLICT', target: 'review.txt' } })

        value.customReceipts[0] = { ...(value.customReceipts[0] as unknown as Record<string, unknown>),
            export: 'missingExport', files, resultSha256: surfaceModelSha256(files)! } as never
        expect(renderSurfaceSet(value)).toMatchObject({ kind: 'refusal' })

        value.customReceipts[0] = { ...(value.customReceipts[0] as unknown as Record<string, unknown>), export: 'renderRules',
            files: [], resultSha256: surfaceModelSha256([])! } as never
        expect(renderSurfaceSet(value)).toMatchObject({ kind: 'refusal' })
    })

    it('merges browser and testing projections through the existing physical owners', () => {
        const value = input()
        const nativeBase = '{"mcpServers":{"existing":{"command":"existing","args":[]}}}\n'
        const nativeFinal = '{"mcpServers":{"existing":{"command":"existing","args":[]}}}\n'
        value.generated.files.push(file('claudecode', '.mcp.json', nativeBase))
        value.mcp.result.servers.push({ name: 'existing', enabled: true, sources: [] } as never)
        value.mcp.result.servers.push({ name: 'playwright', enabled: true, sources: [] } as never)
        value.mcp.result.harnesses.push({ target: 'claudecode', servers: [
            { name: 'existing', command: 'existing', args: [], cwd: '/workspace', enabled: true },
            { name: 'playwright', command: 'docker', args: ['run'], cwd: '/workspace', enabled: true },
        ] } as never)
        value.nativeMcp = { modelSha256: surfaceModelSha256(value.mcp.result)!, fragments: [
            { target: 'claudecode', path: '.mcp.json', baseSha256: digest(nativeBase), bytes: nativeFinal, sha256: digest(nativeFinal) } as never,
        ] }
        const skill = '---\nname: cockpit-browser\n---\nDrive the application.\n'
        const reference = '# Browser reference\n'
        const tierGuide = '# Testing tiers\n'
        const browserMcp = '{"mcpServers":{"playwright":{"command":"docker","args":["run"]}}}\n'
        const hookBytes = '#!/bin/sh\nexit 0\n'
        const browser = {
            files: [file('claudecode', '.mcp.json', browserMcp), file('claudecode', '.claude/skills/cockpit-browser/SKILL.md', skill)],
            rows: [], probes: [], clients: [], graderBrowserAccess: 'retained',
            mcp: { kind: 'complete', result: { servers: [{ name: 'playwright', enabled: true, sources: [] }], wrappers: [], harnesses: [] }, diagnostics: [] },
        }
        const costs = (['claudecode', 'codexcli', 'opencode'] as const).map(target => ({ target, status: 'within_cap', metric: 'lines',
            value: 1, conditionalValue: 0, cap: 100, measuredOn: '2026-10-23', provenance: 'paired instruction-loading measurement',
            scopeSemantics: target === 'claudecode' ? 'conditional' : 'full' }))
        const testing = {
            tierGuide: { kind: 'complete', bytes: tierGuide, lines: 1, costs },
            nativeHooks: { kind: 'complete', entries: [{ path: '.githooks/pre-push', kind: 'file', ownership: 'whole-file',
                harnesses: ['claudecode'], writer: 'cockpit', schemaVersion: 1, scope: 'scoped', capability: 'instructed',
                bytes: hookBytes, sha256: digest(hookBytes) }], cost: { kind: 'within-budget', scope: 'supplied-execution-environment',
                executionSha256: 'a'.repeat(64), limitMs: 100, measuredMs: 1 },
                activation: { kind: 'explicit-native-install', hooksPath: '.githooks', mode: 493 } },
        }
        const rendering = { ...value, browser, browserReference: reference, testing }

        const result = renderSurfaceSet(rendering)
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.entries.find(entry => entry.path === '.mcp.json')).toMatchObject({
            bytes: expect.stringContaining('"existing"'),
        })
        expect(result.entries.find(entry => entry.path === '.mcp.json')).toMatchObject({
            bytes: expect.stringContaining('"playwright"'),
        })
        expect(result.entries.find(entry => entry.path === '.claude/skills/cockpit-browser/SKILL.md')).toMatchObject({ bytes: skill })
        expect(result.entries.find(entry => entry.path === '.claude/skills/cockpit-browser/references/browser.md')).toMatchObject({ bytes: reference })
        expect(result.entries.find(entry => entry.path === 'AGENTS.md')).toMatchObject({
            kind: 'shared-region', region: { bytes: expect.stringContaining(tierGuide.trimEnd()) },
        })
        expect(result.entries.find(entry => entry.path === 'CLAUDE.md')).toMatchObject({
            kind: 'shared-region', region: { bytes: '@AGENTS.md\n' },
        })
        expect(result.entries.find(entry => entry.path === '.githooks/pre-push')).toMatchObject({ bytes: hookBytes })

        const inspectOnly = structuredClone(rendering)
        inspectOnly.testing.nativeHooks = { kind: 'not-installed', reason: 'native hooks require explicit installation' } as never
        const inspected = renderSurfaceSet(inspectOnly)
        expect(inspected).toMatchObject({ kind: 'complete' })
        if (inspected.kind !== 'complete') return
        expect(inspected.entries.some(entry => entry.path === '.githooks/pre-push')).toBe(false)

        const overBudget = structuredClone(rendering)
        overBudget.testing.nativeHooks = { kind: 'ci-required', reason: 'native hook exceeds its measured budget; move this check to CI' } as never
        expect(renderSurfaceSet(overBudget)).toMatchObject({ kind: 'refusal', diagnostic: {
            code: 'SURFACE_INPUT_INVALID',
            message: 'native hook exceeds its measured budget; move this check to CI',
            target: '.githooks/pre-push',
        } })

        const collision = structuredClone(rendering)
        collision.browser.files[0] = file('claudecode', '.mcp.json', '{"mcpServers":{"playwright":{"command":"docker","args":["run"]},"existing":{"command":"other","args":[]}}}\n')
        expect(renderSurfaceSet(collision)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_PATH_CONFLICT' } })
    })
})
