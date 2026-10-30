import { spawnSync } from 'node:child_process'
import { readFile, rm, stat, writeFile, mkdir, chmod, realpath, lstat, rename, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'smol-toml'

import { loadCockpitConfig } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { createGeneratedObservationExecution, inspectGeneratedRuntimeAuthority, projectGeneratedRuntimeAuthority } from '../environment/generated-stack.js'
import { cockpitId } from '../environment/identity.js'
import {
    generatedApplicationProjection,
    observeGeneratedApplication,
    observeGeneratedApplicationHealth,
    observeGeneratedApplicationSurfaces,
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

        const surfaceObservations = observeGeneratedApplicationSurfaces(application)
        expect(surfaceObservations?.map(({ code, observed }) => [code, observed.state])).toEqual([
            ['HARNESS_SURFACE_UNAVAILABLE', 'available'],
            ['DIRECTORY_GRANTS_UNAVAILABLE', 'available'],
            ['GUIDE_CAP_EXCEEDED', 'available'],
            ['SKILL_BUDGET_UNAVAILABLE', 'available'],
        ])
        expect(surfaceObservations?.find(({ code }) => code === 'HARNESS_SURFACE_UNAVAILABLE')).toMatchObject({
            observed: { state: 'available', value: { manifestSha256: application.surfaceSelftest.manifestSha256, entries: expect.any(Number) } },
        })
        expect(surfaceObservations?.find(({ code }) => code === 'DIRECTORY_GRANTS_UNAVAILABLE')).toMatchObject({
            observed: { state: 'available', value: { grants: expect.any(Number), generatedFragments: expect.any(Number), modelSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        })
        expect(surfaceObservations?.find(({ code }) => code === 'GUIDE_CAP_EXCEEDED')).toMatchObject({
            observed: { state: 'available', value: expect.any(Number) }, expectation: { kind: 'maximum', value: 200 },
        })
        const guideValue = surfaceObservations?.find(({ code }) => code === 'GUIDE_CAP_EXCEEDED')?.observed
        expect(guideValue?.state === 'available' ? guideValue.value : 0).toBeGreaterThan(0)
        const rootGuide = application.surfaceSelftest.entries.find(entry => entry.path === 'AGENTS.md')
        if (!rootGuide || rootGuide.kind !== 'shared-region' || rootGuide.region.format !== 'markdown-delimited') {
            throw new Error('generated root guide unavailable')
        }
        expect(guideValue?.state === 'available' ? guideValue.value : 0)
            .toBe(rootGuide.region.bytes.trimEnd().split('\n').length)
        expect(surfaceObservations?.find(({ code }) => code === 'SKILL_BUDGET_UNAVAILABLE')).toMatchObject({
            observed: { state: 'available', value: { coreCollectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), costs: expect.arrayContaining([
                expect.objectContaining({ metric: 'frontmatter_bytes', value: expect.any(Number), cap: expect.any(Number) }),
            ]) } },
        })
        expect(observeGeneratedApplicationSurfaces({ ...application })).toBeUndefined()

        const fresh = await checkGeneratedEnvironment({ configPath })
        if (fresh.kind !== 'complete') throw new Error(fresh.diagnostics[0]?.message)
        const freshApplication = fresh.result.application
        const freshHarness = await generatedRuntime(root, freshApplication)
        let executions = 0
        const health = await observeGeneratedApplicationHealth(freshApplication, freshHarness, async step => {
            executions += 1
            return executeProbe(step)
        })
        expect(executions).toBe(health ? inspectGeneratedRuntimeAuthority(
            projectGeneratedApplicationRuntimeAuthority(freshApplication, freshHarness)!,
        )!.rendered.observations.length : 0)
        expect(health).toMatchObject({
            environment: { code: 'GENERATED_ENVIRONMENT_UNAVAILABLE' },
            registryAuthentication: { code: 'REGISTRY_AUTH_UNAVAILABLE' },
        })

        const mismatched = await generatedRuntime(root, application, 'f'.repeat(64))
        expect(projectGeneratedApplicationRuntimeAuthority(application, mismatched)).toBeUndefined()
    })

    it.each([true, false])('measures sibling host inputs and refuses cockpit controls and redirected sibling paths (mount: %s)', async hasMount => {
        const estate = await consumer('mount-estate')
        const { root, configPath } = await consumer('sibling-inputs', estate.root)
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') throw new Error('fixture unavailable')
        const config = structuredClone(loaded.result.config)
        config.cockpit.siblings_root = '..'
        const generated = config.environment.generated!
        generated.vendors = []
        generated.decisions.entries = generated.decisions.entries.filter(({ subject }) => subject !== 'vendor' && subject !== 'mount')
        const service = generated.services[0]!
        service.mounts = service.mounts.filter(({ kind }) => kind === 'volume')
        if (hasMount) service.mounts.push({ kind: 'bind', source: 'src/module', target: '/workspace/source', source_type: 'directory' })
        service.toolchain_pins[0]!.path = 'src/.node-version'
        await writeFile(configPath, stringify(config))
        const sibling = join(estate.root, 'app')
        await mkdir(join(sibling, 'src/module'), { recursive: true })
        await writeFile(join(sibling, 'src/.node-version'), service.toolchain_pins[0]!.pinned)
        const outcome = await syncGeneratedEnvironment({ configPath })
        if (outcome.kind !== 'complete') throw new Error(JSON.stringify(outcome.diagnostics))
        const application = outcome.result.application
        const harness = await generatedRuntime(root, application)
        const authority = projectGeneratedApplicationRuntimeAuthority(application, harness)
        if (!authority) throw new Error('generated runtime authority unavailable')
        const envelope = inspectGeneratedRuntimeAuthority(authority)!
        expect(projectGeneratedRuntimeAuthority({ rendered: envelope.rendered, ...harness })).toBeUndefined()
        const injectedRoots = { ...harness, hostInputRoots: envelope.hostInputRoots }
        expect(projectGeneratedApplicationRuntimeAuthority(application, injectedRoots)).toBeUndefined()
        const boundInput = { rendered: envelope.rendered, ...harness }
        expect(projectGeneratedRuntimeAuthority({ ...boundInput, hostInputRoots: {
            ...envelope.hostInputRoots, undeclared: envelope.hostInputRoots.app!,
        } })).toBeUndefined()
        expect(projectGeneratedRuntimeAuthority({ ...boundInput, hostInputRoots: {
            app: { ...envelope.hostInputRoots.app!, path: root },
        } })).toBeUndefined()
        const inputs: [string, string][] = hasMount ? [['mount:app:/workspace/source', 'src/module']] : []
        inputs.push(['toolchain:app:src/.node-version', 'src/.node-version'])
        for (const [id, source] of inputs) {
            const observation = envelope.rendered.observations.find(candidate => candidate.id === id)!
            expect(createGeneratedObservationExecution({ authority, observation: { ...observation, target: '../outside' } }))
                .toMatchObject({ kind: 'unavailable' })
            const execution = createGeneratedObservationExecution({ authority, observation })
            if (execution.kind !== 'planned') throw new Error(execution.reason)
            expect(await executeProbe(execution.step)).toMatchObject({ kind: 'complete' })
            expect(execution.step.paths).toContain(join(sibling, source))
            await rename(join(sibling, source), join(sibling, `${source}.saved`))
            if (source === 'src/module') await mkdir(join(root, source), { recursive: true })
            else {
                await mkdir(join(root, 'src'), { recursive: true })
                await writeFile(join(root, source), service.toolchain_pins[0]!.pinned)
            }
            const missing = await executeProbe(execution.step)
            expect(missing).toMatchObject({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED', execution: { started: true } })
            expect(missing.stderr.toString()).toContain('ENOENT')
            await symlink(join(root, source), join(sibling, source))
            const redirected = await executeProbe(execution.step)
            expect(redirected).toMatchObject({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED', execution: { started: true } })
            expect(redirected.stderr.toString()).toContain('generated host input is a symbolic entry')
            await rm(join(sibling, source))
            await rename(join(sibling, `${source}.saved`), join(sibling, source))
        }
        const mount = envelope.rendered.observations.find(candidate => candidate.id === (hasMount ? 'mount:app:/workspace/source' : 'toolchain:app:src/.node-version'))!
        const execution = createGeneratedObservationExecution({ authority, observation: mount })
        if (execution.kind !== 'planned') throw new Error(execution.reason)
        await rename(join(sibling, 'src'), join(sibling, 'src.saved'))
        await symlink(join(root, 'src'), join(sibling, 'src'))
        const intermediate = await executeProbe(execution.step)
        expect(intermediate).toMatchObject({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED', execution: { started: true } })
        expect(intermediate.stderr.toString()).toContain('generated host input crosses a symbolic or non-directory entry')
        await rm(join(sibling, 'src'))
        await rename(join(sibling, 'src.saved'), join(sibling, 'src'))
        await rename(sibling, `${sibling}.saved`)
        await mkdir(sibling)
        await mkdir(join(sibling, 'src/module'), { recursive: true })
        await writeFile(join(sibling, 'src/.node-version'), service.toolchain_pins[0]!.pinned)
        const replaced = await executeProbe(execution.step)
        expect(replaced).toMatchObject({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED', execution: { started: true } })
        expect(replaced.stderr.toString()).toContain('generated host input root changed')
    })

    it('binds topology sources to each service rather than only the global source set', async () => {
        const { root, configPath } = await consumer('service-mount-binding')
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') throw new Error('fixture unavailable')
        const config = structuredClone(loaded.result.config)
        config.sibling.push({ ...config.sibling[0]!, slug: 'worker', dir: 'worker', var: 'WORKER_DIR' })
        const service = structuredClone(config.environment.generated!.services[0]!)
        service.id = 'worker'
        service.sibling = 'worker'
        service.ports = []
        for (const operation of [service.image!.manifest_probe, service.image!.registry_auth_probe, service.health.probe, service.health.tool_probe]) {
            if (operation) operation.service = 'worker'
        }
        config.environment.generated!.services.push(service)
        await mkdir(join(root, 'worker'))
        await writeFile(configPath, stringify(config))
        const outcome = await syncGeneratedEnvironment({ configPath })
        if (outcome.kind !== 'complete') throw new Error(JSON.stringify(outcome.diagnostics))
        const application = outcome.result.application
        const correct = await generatedRuntime(root, application)
        expect(projectGeneratedApplicationRuntimeAuthority(application, correct)).toMatchObject({ kind: 'generated-runtime-authority' })
        const sourceSets = Object.fromEntries(correct.topology.services.map(service => [service.id, service.bindMountSources]))
        const swapped = await generatedRuntime(root, application, application.generation, { app: sourceSets.worker!, worker: sourceSets.app! })
        expect([...new Set(swapped.topology.services.flatMap(service => service.bindMountSources))].sort())
            .toEqual([...new Set(correct.topology.services.flatMap(service => service.bindMountSources))].sort())
        expect(projectGeneratedApplicationRuntimeAuthority(application, swapped)).toBeUndefined()
        const wrongCockpit = await generatedRuntime(root, application, application.generation, { app: [root, join(root, '.env')] })
        expect(projectGeneratedApplicationRuntimeAuthority(application, wrongCockpit)).toBeUndefined()
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
            '.agents/skills/cockpit-setup/SKILL.md',
            '.agents/skills/cockpit-setup/agents/openai.yaml',
            '.agents/skills/cockpit-setup/procedures/onboarding.md',
            '.agents/skills/cockpit-setup/references/identity-provider-clerk.md',
            '.agents/skills/cockpit-setup/references/test-data-and-personas.md',
            '.agents/skills/cockpit-explain/SKILL.md',
            '.agents/skills/cockpit-explain/agents/openai.yaml',
            '.agents/skills/cockpit-explain/procedures/onboarding.md',
            '.agents/skills/cockpit-fix/SKILL.md',
            '.agents/skills/cockpit-fix/agents/openai.yaml',
            '.agents/skills/cockpit-fix/procedures/onboarding.md',
            '.agents/skills/cockpit-work/SKILL.md',
            '.agents/skills/cockpit-work/agents/openai.yaml',
            '.agents/skills/cockpit-work/procedures/onboarding.md',
            '.claude/agents/evaluator.md',
            '.claude/settings.json',
            '.claude/skills/cockpit-setup/SKILL.md',
            '.claude/skills/cockpit-setup/procedures/onboarding.md',
            '.claude/skills/cockpit-setup/references/identity-provider-clerk.md',
            '.claude/skills/cockpit-setup/references/test-data-and-personas.md',
            '.claude/skills/cockpit-explain/SKILL.md',
            '.claude/skills/cockpit-explain/procedures/onboarding.md',
            '.claude/skills/cockpit-fix/SKILL.md',
            '.claude/skills/cockpit-fix/procedures/onboarding.md',
            '.claude/skills/cockpit-work/SKILL.md',
            '.claude/skills/cockpit-work/procedures/onboarding.md',
            '.cockpit/guards/bash-guard.sh',
            '.codex/agents/evaluator.toml',
            '.codex/config.toml',
            '.codex/hooks.json',
            '.cursor/agents/evaluator.md',
            '.cursor/skills/cockpit-setup/SKILL.md',
            '.cursor/skills/cockpit-setup/procedures/onboarding.md',
            '.cursor/skills/cockpit-setup/references/identity-provider-clerk.md',
            '.cursor/skills/cockpit-setup/references/test-data-and-personas.md',
            '.cursor/skills/cockpit-explain/SKILL.md',
            '.cursor/skills/cockpit-explain/procedures/onboarding.md',
            '.cursor/skills/cockpit-fix/SKILL.md',
            '.cursor/skills/cockpit-fix/procedures/onboarding.md',
            '.cursor/skills/cockpit-work/SKILL.md',
            '.cursor/skills/cockpit-work/procedures/onboarding.md',
            '.cursor/cli.json',
            '.grok/agents/evaluator.md',
            '.grok/skills/cockpit-setup/SKILL.md',
            '.grok/skills/cockpit-setup/procedures/onboarding.md',
            '.grok/skills/cockpit-setup/references/identity-provider-clerk.md',
            '.grok/skills/cockpit-setup/references/test-data-and-personas.md',
            '.grok/skills/cockpit-explain/SKILL.md',
            '.grok/skills/cockpit-explain/procedures/onboarding.md',
            '.grok/skills/cockpit-fix/SKILL.md',
            '.grok/skills/cockpit-fix/procedures/onboarding.md',
            '.grok/skills/cockpit-work/SKILL.md',
            '.grok/skills/cockpit-work/procedures/onboarding.md',
            '.grok/config.toml',
            '.opencode/agents/evaluator.md',
            '.opencode/plugin/cockpit-guards.js',
            '.opencode/skills/cockpit-setup/SKILL.md',
            '.opencode/skills/cockpit-setup/procedures/onboarding.md',
            '.opencode/skills/cockpit-setup/references/identity-provider-clerk.md',
            '.opencode/skills/cockpit-setup/references/test-data-and-personas.md',
            '.opencode/skills/cockpit-explain/SKILL.md',
            '.opencode/skills/cockpit-explain/procedures/onboarding.md',
            '.opencode/skills/cockpit-fix/SKILL.md',
            '.opencode/skills/cockpit-fix/procedures/onboarding.md',
            '.opencode/skills/cockpit-work/SKILL.md',
            '.opencode/skills/cockpit-work/procedures/onboarding.md',
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
        expect(actions).not.toContain('prepare-batch')
        expect(actions).not.toContain('publish')
        expect(actions).not.toContain('commit')
        expect(actions).not.toContain('publish-batch')
        expect(actions).not.toContain('verify-batch')
        expect(actions).not.toContain('commit-batch')
        expect(observeGeneratedApplicationSurfaces(preview.result.application)).toBeUndefined()
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
