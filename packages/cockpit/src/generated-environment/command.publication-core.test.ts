import { spawnSync } from 'node:child_process'
import { readFile, rm, stat, writeFile, mkdir, chmod, realpath, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { cockpitId } from '../environment/identity.js'
import {
    generatedApplicationProjection,
    observeGeneratedApplication,
    projectGeneratedApplicationNodeExecutable,
    projectGeneratedApplicationRuntimeAuthority,
    resolveGeneratedApplicationOperation,
} from '../environment/generated-application.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import * as publicationTransaction from './transaction.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { cleanup, consumer, surfaceConsumer, digest, ownership, bytes, generatedRuntime } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
    it('projects only genuine generated runtime, operation, and aggregate authority', async () => {
        const { root, configPath } = await consumer('runtime-authority')
        const outcome = await syncGeneratedEnvironment({ configPath })
        if (outcome.kind !== 'complete') throw new Error(outcome.diagnostics[0]?.message)
        const application = outcome.result.application
        expect(application.generatedComposeAuthority).toMatchObject({ kind: 'generated-compose-artifact-authority' })
        const node = projectGeneratedApplicationNodeExecutable(application)
        expect(node).toMatchObject({ canonicalPath: await realpath(process.execPath), executionMode: 'verified-path' })
        expect(projectGeneratedApplicationNodeExecutable({ ...application })).toBeUndefined()

        const harness = await generatedRuntime(root, application)
        expect(projectGeneratedApplicationRuntimeAuthority(application, harness)).toMatchObject({ kind: 'generated-runtime-authority' })
        expect(projectGeneratedApplicationRuntimeAuthority({ ...application }, harness)).toBeUndefined()
        let activeInputEvaluations = 0
        const activeInput = new Proxy(harness, { get: () => { activeInputEvaluations += 1; throw new Error('must not run') } })
        const activeRuntime = new Proxy(harness.runtime, { get: () => { activeInputEvaluations += 1; throw new Error('must not run') } })
        expect(projectGeneratedApplicationRuntimeAuthority(application, activeInput)).toBeUndefined()
        expect(projectGeneratedApplicationRuntimeAuthority(application, { ...harness, runtime: activeRuntime })).toBeUndefined()
        expect(activeInputEvaluations).toBe(0)

        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) throw new Error('generated declaration unavailable')
        const operation = loaded.result.config.environment.generated.data!.modes[0]!.operations[0]!.operation
        const step = resolveGeneratedApplicationOperation(application, harness, operation, {
            id: 'generated-data-operation', phase: 'operation', operationId: 'empty-schema', operationKind: 'schema',
        })
        expect(step).toMatchObject({ id: 'generated-data-operation', env: {}, ports: [], compensation: [] })
        expect(step?.argv).toEqual(expect.arrayContaining(['exec', '--no-TTY', 'app', ...operation.argv]))

        await expect(observeGeneratedApplication(application, harness, async () => {
            throw new Error('executor failure')
        })).rejects.toThrow('executor failure')
        const observation = await observeGeneratedApplication(application, harness, executeProbe)
        expect(observation).toMatchObject({ observed: { state: 'failed' }, applicability: { posture: 'generated-environment' } })
        expect(await observeGeneratedApplication({ ...application }, harness, executeProbe)).toBeUndefined()

        const mismatched = await generatedRuntime(root, application, 'f'.repeat(64))
        expect(projectGeneratedApplicationRuntimeAuthority(application, mismatched)).toBeUndefined()
    })

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
            await expect(lstat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
        }
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
        migratedPayload.producer.producedAt = migrationInstant
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
        const secretRoot = join(root, 'env/.secrets')
        const existingReference = join(secretRoot, 'generated-environment/runtime/provider-reference')
        await mkdir(dirname(existingReference), { recursive: true, mode: 0o700 })
        await chmod(secretRoot, 0o500)
        expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_PATH_UNSAFE', target: 'env/.secrets' })],
        })
        await chmod(secretRoot, 0o700)
        await writeFile(existingReference, 'synthetic-provider-reference\n')
        const first = await syncGeneratedEnvironment({ configPath })
        expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete', status: 0, result: { action: 'sync' } })
        if (first.kind !== 'complete') return
        expect(first.result.application.generatedPaths.every(fact => fact.declaration?.applicability === 'required-after-sync')).toBe(true)
        expect(new Set(first.result.application.generatedPaths.map(fact => fact.declaration?.producer))).toEqual(new Set([
            'generated-environment', 'environment-data-plane', 'surface-render',
        ]))
        expect(generatedApplicationProjection(first.result.application)).toBe(first.result.application)
        expect(generatedApplicationProjection({ ...first.result.application })).toBeUndefined()
        expect(first.result.application).toMatchObject({
            sourceSha256: first.result.sourceSha256,
            generation: first.result.generation,
            inspection: { kind: 'passed' },
        })
        expect(first.result.paths).toEqual([
            '.agents/skills/bootstrap/SKILL.md',
            '.agents/skills/bootstrap/agents/openai.yaml',
            '.agents/skills/bootstrap/procedures/onboarding.md',
            '.agents/skills/explain/SKILL.md',
            '.agents/skills/explain/agents/openai.yaml',
            '.agents/skills/explain/procedures/onboarding.md',
            '.agents/skills/fix/SKILL.md',
            '.agents/skills/fix/agents/openai.yaml',
            '.agents/skills/fix/procedures/onboarding.md',
            '.claude/agents/evaluator.md',
            '.claude/settings.json',
            '.claude/skills/bootstrap/SKILL.md',
            '.claude/skills/bootstrap/procedures/onboarding.md',
            '.claude/skills/explain/SKILL.md',
            '.claude/skills/explain/procedures/onboarding.md',
            '.claude/skills/fix/SKILL.md',
            '.claude/skills/fix/procedures/onboarding.md',
            '.cockpit/guards/bash-guard.sh',
            '.codex/agents/evaluator.toml',
            '.codex/config.toml',
            '.codex/hooks.json',
            '.codex/rules/rulesync.rules',
            '.opencode/agents/evaluator.md',
            '.opencode/plugin/cockpit-guards.js',
            '.opencode/skills/bootstrap/SKILL.md',
            '.opencode/skills/bootstrap/procedures/onboarding.md',
            '.opencode/skills/explain/SKILL.md',
            '.opencode/skills/explain/procedures/onboarding.md',
            '.opencode/skills/fix/SKILL.md',
            '.opencode/skills/fix/procedures/onboarding.md',
            'AGENTS.md',
            'CLAUDE.md',
            'app/.env.example',
            'compose.generated.yml',
            'docs/cockpit/environment-decisions.md',
            'env/.secrets/.gitignore',
            'fixtures/personas.generated.ts',
            'opencode.jsonc',
        ].sort())
        expect(await readFile(join(root, 'unmanaged.txt'), 'utf8')).toBe('keep\n')
        expect(await readFile(existingReference, 'utf8')).toBe('synthetic-provider-reference\n')
        expect((await stat(secretRoot)).mode & 0o777).toBe(0o700)
        expect((await ownership(root)).entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'file', path: 'env/.secrets/.gitignore', ownership: 'whole-file' }),
        ]))
        expect(await readFile(join(root, 'fixtures/personas.generated.ts'), 'utf8')).toBe('export default [\n  {\n    "id": "first"\n  }\n] as const\n')

        const before = await bytes(root, first.result.paths)
        const checked = await checkGeneratedEnvironment({ configPath })
        expect(checked, JSON.stringify(checked.diagnostics)).toMatchObject({ kind: 'complete', status: 0, result: { action: 'check', paths: first.result.paths } })
        expect(await bytes(root, first.result.paths)).toEqual(before)

        const second = await syncGeneratedEnvironment({ configPath })
        expect(second).toMatchObject({ kind: 'complete', result: { paths: first.result.paths } })
        expect(await bytes(root, first.result.paths)).toEqual(before)

        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"second"}]\n')
        const drift = await checkGeneratedEnvironment({ configPath })
        expect(drift).toMatchObject({ kind: 'refusal', status: 2, diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', target: 'fixtures/personas.generated.ts' })] })
        expect(await bytes(root, first.result.paths)).toEqual(before)

        expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0)
        expect(spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--',
            'env/.secrets/generated-environment/runtime/future-resolver']).status).toBe(0)
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

    it('refuses executable Markdown frontmatter before generator dispatch', async () => {
        const fixture = await consumer('executable-frontmatter')
        const marker = join(fixture.root, 'frontmatter-executed')
        const overlay = `
[[surfaces.overlays]]
name = "synthetic-agent"
feature = "subagents"
source = "surfaces/synthetic-agent.json"
sources = [{ path = "subagents/synthetic-agent.md", bytes = ${JSON.stringify(`---javascript\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'), { name: 'synthetic-agent' }\n---\nSynthetic instructions.\n`)} }]
`
        await writeFile(fixture.configPath, `${await readFile(fixture.configPath, 'utf8')}${overlay}`)

        const result = await syncGeneratedEnvironment({ configPath: fixture.configPath })

        await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'CONFIG_SCHEMA_INVALID' })],
        })
    })

    it('refuses BOM-prefixed executable Markdown frontmatter before generator dispatch', async () => {
        const fixture = await consumer('bom-executable-frontmatter')
        const marker = join(fixture.root, 'frontmatter-executed')
        const overlay = `
[[surfaces.overlays]]
name = "synthetic-agent"
feature = "subagents"
source = "surfaces/synthetic-agent.json"
sources = [{ path = "subagents/synthetic-agent.md", bytes = ${JSON.stringify(`\uFEFF---javascript\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'), { name: 'synthetic-agent' }\n---\nSynthetic instructions.\n`)} }]
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
        expect(actions).not.toContain('prepare')
        expect(actions).not.toContain('publish')
        expect(actions).not.toContain('commit')
        expect(actions).not.toContain('publish-batch')
        expect(actions).not.toContain('verify-batch')
        expect(actions).not.toContain('commit-batch')
        await expect(lstat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
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

    it('reports missing and structural decision drift without creating bytes', async () => {
        const { root, configPath } = await consumer('check')
        const synced = await syncGeneratedEnvironment({ configPath })
        expect(synced.kind).toBe('complete')
        await rm(join(root, 'compose.generated.yml'))

        const missing = await checkGeneratedEnvironment({ configPath })
        expect(missing).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_MISSING', target: 'compose.generated.yml' })] })
        await expect(stat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })

        await syncGeneratedEnvironment({ configPath })
        const decisions = join(root, 'docs/cockpit/environment-decisions.md')
        await writeFile(decisions, '# Environment decisions\n')
        const structural = await checkGeneratedEnvironment({ configPath })
        expect(structural).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_DECISION_COVERAGE', target: 'docs/cockpit/environment-decisions.md' })] })
        expect(await readFile(decisions, 'utf8')).toBe('# Environment decisions\n')
    }, 120_000)

})
