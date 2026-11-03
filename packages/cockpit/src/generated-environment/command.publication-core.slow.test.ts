import { readFile, rm, writeFile, mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'smol-toml'

import { executeProbe } from '../environment-exec/execute.js'
import { cockpitId } from '../environment/identity.js'
import { generatedApplicationProjection } from '../environment/generated-application/authorities.js'
import { observeGeneratedApplicationSurfaces } from '../environment/generated-application/surface-observation.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import * as publicationTransaction from './transaction.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { cleanup, consumer, surfaceConsumer, digest, ownership, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
    it('refuses a newer ownership manifest by name without touching outputs', async () => {
        const { root, configPath } = await consumer('newer-ownership')
        await mkdir(join(root, '.cockpit'), { recursive: true })
        const ledger = '{"format":"cockpit-generated-ownership/v4"}\n'
        await writeFile(join(root, '.cockpit/generated-environment-ownership.json'), ledger)
        for (const run of [syncGeneratedEnvironment, checkGeneratedEnvironment]) {
            expect(await run({ configPath })).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
                code: 'GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', target: '.cockpit/generated-environment-ownership.json',
            })] })
            expect(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(ledger)
            await expect(lstat(join(root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        }
    })

    it('names cockpit.guide_cap with the measured lines when the root or a linked sibling guide outgrows it', async () => {
        const fixture = await surfaceConsumer('guide-cap')
        const config = await readFile(fixture.configPath, 'utf8')
        const capped = (cap: number) => config.replace('[cockpit]\n', `[cockpit]\nguide_cap = ${cap}\n`)
        expect(capped(5)).not.toBe(config)
        await writeFile(fixture.configPath, capped(5))
        expect(await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })).toMatchObject({ kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GUIDE_CAP_EXCEEDED', target: 'cockpit.guide_cap', message: expect.stringMatching(/ \d+ lines, over cockpit\.guide_cap 5;/) })] })
        await writeFile(fixture.configPath, capped(150))
        expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
        await writeFile(join(fixture.siblingDirectory, 'AGENTS.md'), 'A rule the sibling team added.\n'.repeat(200))
        expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GUIDE_CAP_EXCEEDED', message: expect.stringMatching(/ \d+ lines, over cockpit\.guide_cap 150;/) })] })
    })

    // Codex 0.166.0 silently dropped what followed the first 32 KiB of a project AGENTS.md, so a copied
    // guide past it would read as loaded and reach Codex only in part.
    it('refuses copied sibling guides that push cockpit\'s AGENTS.md region past what Codex loads, naming its bytes', async () => {
        const fixture = await surfaceConsumer('guide-bytes')
        const config = await readFile(fixture.configPath, 'utf8')
        await writeFile(fixture.configPath, config.replace('[cockpit]\n', '[cockpit]\nguide_cap = 10000\n'))
        await writeFile(join(fixture.siblingDirectory, 'AGENTS.md'), `${'x'.repeat(199)}\n`.repeat(170))
        expect(await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })).toMatchObject({ kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GUIDE_CAP_EXCEEDED', target: 'AGENTS.md', message: expect.stringContaining('the first 32768 bytes') })] })
        await writeFile(join(fixture.siblingDirectory, 'AGENTS.md'), `${'x'.repeat(199)}\n`.repeat(100))
        expect(await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })).toMatchObject({ kind: 'complete' })
    })

    it('writes a rules overlay with Rulesync frontmatter into the always-loaded guide and refuses a scoped one by name', async () => {
        const fixture = await surfaceConsumer('rules-frontmatter', { rules: true })
        const config = await readFile(fixture.configPath, 'utf8')
        const plain = 'bytes = "Read the synthetic sibling guide before editing.\\n"'
        expect(config).toContain(plain)
        const withFrontmatter = (frontmatter: string) => config.replace(plain,
            `bytes = ${JSON.stringify(`---\n${frontmatter}---\nRead the synthetic sibling guide before editing.\n`)}`)
        await writeFile(fixture.configPath, withFrontmatter('root: false\ntargets: ["*"]\ndescription: Synthetic rule\nglobs: ["**/*"]\n'))
        const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
        expect(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8')).toContain('Read the synthetic sibling guide before editing.')
        await writeFile(fixture.configPath, withFrontmatter('root: false\nglobs: ["src/**"]\n'))
        expect(await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })).toMatchObject({ kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'SURFACE_RULE_SCOPE_UNSUPPORTED', target: 'rules/synthetic.md' })] })
    })

    it('binds shared ownership markers to the cockpit and refuses copied identities before publication', async () => {
        const fixture = await surfaceConsumer('shared-owner-binding', { rules: true })
        const preview = await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })
        expect(preview).toMatchObject({ kind: 'complete' })
        if (preview.kind !== 'complete') throw new Error('expected preview')
        expect(preview.result.application.generatedPaths.every(fact => fact.declaration?.applicability === 'declared-before-sync')).toBe(true)
        const first = await syncGeneratedEnvironment({ configPath: fixture.configPath })
        expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete' })
        if (first.kind !== 'complete') throw new Error('expected publication')
        const ledgerPath = join(fixture.root, '.cockpit/generated-environment-ownership.json')
        const ledger = await readFile(ledgerPath, 'utf8')
        const id = JSON.parse(ledger).cockpitId as string
        const markdownPath = join(fixture.root, 'CLAUDE.md')
        const openCodePath = join(fixture.root, 'opencode.jsonc')
        const markdown = await readFile(markdownPath, 'utf8')
        const openCode = await readFile(openCodePath, 'utf8')
        expect(markdown).toContain(`<!-- cockpit:owner:${id}:start -->`)
        expect(openCode).toContain(`/* cockpit:owner:${id}:start */`)
        const foreign = `cockpit:foreign:${'f'.repeat(64)}`
        await writeFile(markdownPath, markdown.replaceAll(id, foreign))
        await writeFile(openCodePath, openCode.replaceAll(id, foreign))
        const refused = await syncGeneratedEnvironment({ configPath: fixture.configPath })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_STATE_CONFLICT' })] })
        expect(await readFile(ledgerPath, 'utf8')).toBe(ledger)
        expect(await readFile(markdownPath, 'utf8')).toBe(markdown.replaceAll(id, foreign))
        expect(await readFile(openCodePath, 'utf8')).toBe(openCode.replaceAll(id, foreign))
    })

    it('migrates authenticated static shared regions and reports a missing published output', async () => {
        const fixture = await surfaceConsumer('shared-owner-migration', { rules: true })
        const firstInstant = '2026-10-22T12:00:00.000Z'
        const migrationInstant = '2026-10-23T12:00:00.000Z'
        await writeFile(join(fixture.root, 'CLAUDE.md'), 'Human instructions\n')
        await writeFile(join(fixture.root, 'opencode.jsonc'), '{\n  "theme": "dark"\n}\n')
        const first = await syncGeneratedEnvironment({ configPath: fixture.configPath }, { now: () => firstInstant })
        expect(first).toMatchObject({ kind: 'complete' })
        const ledgerPath = join(fixture.root, '.cockpit/generated-environment-ownership.json')
        const original = await readFile(ledgerPath, 'utf8')
        const { integrity: _integrity, ...payload } = JSON.parse(original)
        const markdownPath = join(fixture.root, 'CLAUDE.md')
        const openCodePath = join(fixture.root, 'opencode.jsonc')
        const markdown = await readFile(markdownPath, 'utf8')
        const openCode = await readFile(openCodePath, 'utf8')
        const legacyMarkdown = markdown.replace(`<!-- cockpit:owner:${payload.cockpitId}:start -->\n`, '')
            .replace(`<!-- cockpit:owner:${payload.cockpitId}:end -->\n`, '')
        const legacyOpenCode = openCode.replace(`/* cockpit:owner:${payload.cockpitId}:start */`, '')
            .replace(`/* cockpit:owner:${payload.cockpitId}:end */`, '')
        for (const entry of payload.entries) {
            if (entry.path === 'CLAUDE.md') entry.region.sha256 = digest(legacyMarkdown.split(`${entry.region.begin}\n`)[1]!.split(entry.region.end)[0]!)
            if (entry.path === 'opencode.jsonc') entry.regionId = 'cockpit-opencode-root-properties'
        }
        await writeFile(markdownPath, legacyMarkdown)
        await writeFile(openCodePath, legacyOpenCode)
        await writeFile(ledgerPath, `${JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) }, null, 2)}\n`)
        const migrated = await syncGeneratedEnvironment({ configPath: fixture.configPath }, { now: () => migrationInstant })
        expect(migrated, JSON.stringify(migrated.diagnostics)).toMatchObject({ kind: 'complete' })
        expect(await readFile(markdownPath, 'utf8')).toBe(markdown)
        expect(await readFile(openCodePath, 'utf8')).toBe(openCode)
        const { integrity: _originalIntegrity, ...migratedPayload } = JSON.parse(original)
        const migratedLedger = `${JSON.stringify({ ...migratedPayload, integrity: digest(JSON.stringify(migratedPayload)) }, null, 2)}\n`
        expect(await readFile(ledgerPath, 'utf8')).toBe(migratedLedger)
        await rm(markdownPath)
        const missing = await checkGeneratedEnvironment({ configPath: fixture.configPath })
        expect(missing).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', target: 'CLAUDE.md' })] })
        expect(await readFile(ledgerPath, 'utf8')).toBe(migratedLedger)
        await expect(readFile(markdownPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('synchronizes one owned manifest idempotently and checks without mutation', async () => {
        const { root, configPath } = await consumer('complete')
        const first = await syncGeneratedEnvironment({ configPath })
        expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete', status: 0, result: { action: 'sync' } })
        if (first.kind !== 'complete') return
        expect(first.result.application.generatedPaths.every(fact => fact.declaration?.applicability === 'required-after-sync')).toBe(true)
        expect(new Set(first.result.application.generatedPaths.map(fact => fact.declaration?.producer))).toEqual(new Set(['surface-render']))
        expect(generatedApplicationProjection(first.result.application)).toBe(first.result.application)
        expect(generatedApplicationProjection({ ...first.result.application })).toBeUndefined()
        expect(first.result.application).toMatchObject({
            sourceSha256: first.result.sourceSha256,
            generation: first.result.generation,
            inspection: { kind: 'passed' },
        })
        expect(first.result.paths).toEqual([
            '.agents/skills/cockpit-setup/SKILL.md',
            '.agents/skills/cockpit-setup/agents/openai.yaml',
            '.agents/skills/cockpit-setup/procedures/setup.md',
            '.agents/skills/cockpit-setup/references/test-data-and-personas.md',
            '.agents/skills/cockpit-explain/SKILL.md',
            '.agents/skills/cockpit-explain/agents/openai.yaml',
            '.agents/skills/cockpit-explain/procedures/explain.md',
            '.agents/skills/cockpit-fix/SKILL.md',
            '.agents/skills/cockpit-fix/agents/openai.yaml',
            '.agents/skills/cockpit-fix/procedures/fix.md',
            '.agents/skills/cockpit-work/SKILL.md',
            '.agents/skills/cockpit-work/agents/openai.yaml',
            '.agents/skills/cockpit-work/procedures/work.md',
            '.claude/agents/evaluator.md',
            '.claude/settings.json',
            '.claude/skills/cockpit-setup/SKILL.md',
            '.claude/skills/cockpit-setup/procedures/setup.md',
            '.claude/skills/cockpit-setup/references/test-data-and-personas.md',
            '.claude/skills/cockpit-explain/SKILL.md',
            '.claude/skills/cockpit-explain/procedures/explain.md',
            '.claude/skills/cockpit-fix/SKILL.md',
            '.claude/skills/cockpit-fix/procedures/fix.md',
            '.claude/skills/cockpit-work/SKILL.md',
            '.claude/skills/cockpit-work/procedures/work.md',
            '.cockpit/guards/bash-guard.sh',
            '.codex/agents/evaluator.toml',
            '.codex/config.toml',
            '.codex/hooks.json',
            '.opencode/agents/evaluator.md',
            '.opencode/plugin/cockpit-guards.js',
            '.opencode/skills/cockpit-setup/SKILL.md',
            '.opencode/skills/cockpit-setup/procedures/setup.md',
            '.opencode/skills/cockpit-setup/references/test-data-and-personas.md',
            '.opencode/skills/cockpit-explain/SKILL.md',
            '.opencode/skills/cockpit-explain/procedures/explain.md',
            '.opencode/skills/cockpit-fix/SKILL.md',
            '.opencode/skills/cockpit-fix/procedures/fix.md',
            '.opencode/skills/cockpit-work/SKILL.md',
            '.opencode/skills/cockpit-work/procedures/work.md',
            'AGENTS.md',
            'CLAUDE.md',
            'opencode.jsonc',
        ].sort())
        expect(await readFile(join(root, 'unmanaged.txt'), 'utf8')).toBe('keep\n')

        const before = await bytes(root, first.result.paths)
        const checked = await checkGeneratedEnvironment({ configPath })
        expect(checked, JSON.stringify(checked.diagnostics)).toMatchObject({ kind: 'complete', status: 0, result: { action: 'check', paths: first.result.paths } })
        expect(await bytes(root, first.result.paths)).toEqual(before)

        const second = await syncGeneratedEnvironment({ configPath })
        expect(second).toMatchObject({ kind: 'complete', result: { paths: first.result.paths } })
        expect(await bytes(root, first.result.paths)).toEqual(before)

        const guard = join(root, '.cockpit/guards/bash-guard.sh')
        await writeFile(guard, `${await readFile(guard, 'utf8')}# edited by hand\n`)
        const edited = await bytes(root, first.result.paths)
        const drift = await checkGeneratedEnvironment({ configPath })
        expect(drift).toMatchObject({ kind: 'refusal', status: 2, diagnostics: [expect.objectContaining({ target: '.cockpit/guards/bash-guard.sh' })] })
        expect(await bytes(root, first.result.paths)).toEqual(edited)
    }, 120_000)

    it('derives optional Codex sidecar inventory before skill contract validation', async () => {
        const overlay = `
[[surfaces.overlays]]
name = "synthetic-skill"
feature = "skills"
source = "surfaces/synthetic-skill.json"
sources = [{ path = "skills/alpha/SKILL.md", bytes = "---\\nname: alpha\\ndescription: Synthetic alpha skill.\\n---\\nUse synthetic alpha.\\n" }]
`
        const { configPath } = await surfaceConsumer('skill-without-codex-sidecar', { custom: overlay })

        const result = await syncGeneratedEnvironment({ configPath })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'SKILL_FRONTMATTER_INVALID', target: 'skills/alpha/SKILL.md' })],
        })
    })

    it.each([['executable-frontmatter', ''], ['bom-executable-frontmatter', '\uFEFF']])('refuses executable Markdown frontmatter before generator dispatch (%s)', async (name, prefix) => {
        const fixture = await consumer(name)
        const marker = join(fixture.root, 'frontmatter-executed')
        const overlay = `
[[surfaces.overlays]]
name = "synthetic-agent"
feature = "subagents"
source = "surfaces/synthetic-agent.json"
sources = [{ path = "subagents/synthetic-agent.md", bytes = ${JSON.stringify(`${prefix}---javascript\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'), { name: 'synthetic-agent' }\n---\nSynthetic instructions.\n`)} }]
`
        await writeFile(fixture.configPath, `${await readFile(fixture.configPath, 'utf8')}${overlay}`)

        const result = await syncGeneratedEnvironment({ configPath: fixture.configPath })

        await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'CONFIG_SCHEMA_INVALID' })],
        })
    })

    it('previews the complete ordered publication without mutation', async () => {
        const { root, configPath } = await consumer('dry-run')
        const actions: string[] = []

        const preview = await syncGeneratedEnvironment({ configPath, dryRun: true }, {
            execute: async (step) => {
                if (step.labels.action) actions.push(step.labels.action)
                return executeProbe(step)
            },
        })

        expect(preview, JSON.stringify(preview)).toMatchObject({ kind: 'complete', result: { action: 'sync', dryRun: true } })
        if (preview.kind !== 'complete') return
        expect(preview.result.changes.at(-1)).toEqual({ operation: 'write', path: '.cockpit/generated-environment-ownership.json' })
        expect(preview.result.changes.map(change => change.path)).toEqual([...new Set(preview.result.changes.map(change => change.path))])
        expect(actions).not.toContain('prepare-batch')
        expect(actions).not.toContain('publish')
        expect(actions).not.toContain('commit')
        expect(actions).not.toContain('publish-batch')
        expect(actions).not.toContain('verify-batch')
        expect(actions).not.toContain('commit-batch')
        expect(observeGeneratedApplicationSurfaces(preview.result.application)).toBeUndefined()
        await expect(lstat(join(root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })

        const applied = await syncGeneratedEnvironment({ configPath })
        expect(applied).toMatchObject({ kind: 'complete', result: { action: 'sync', dryRun: false, changes: preview.result.changes } })
    }, 120_000)

    it('routes canonical publication through one admitted transaction owner', async () => {
        const { root, configPath } = await consumer('transaction-owner')
        const admit = vi.spyOn(publicationTransaction, 'admitPublicationPlan')
        const apply = vi.spyOn(publicationTransaction, 'runPublicationPlan')
        try {
            const result = await syncGeneratedEnvironment({ configPath })
            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
            expect(admit).toHaveBeenCalledTimes(1)
            expect(apply).toHaveBeenCalledTimes(1)
            const admitted = await admit.mock.results[0]!.value
            expect(admitted.kind).toBe('complete')
            if (admitted.kind !== 'complete' || result.kind !== 'complete') return
            expect(apply.mock.calls[0]![0]).toBe(admitted.plan)
            expect(result.result.changes).toEqual(admitted.plan.changes)
            const ledger = JSON.parse(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8'))
            expect(ledger.entries.map((row: { path: string }) => row.path)).toEqual(result.result.paths)
        } finally {
            admit.mockRestore()
            apply.mockRestore()
        }
    })


})
