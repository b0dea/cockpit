import { createHash } from 'node:crypto'
import type { BigIntStats, PathLike, StatOptions, Stats } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { readFile, readdir, rm, symlink, writeFile, mkdir, rename, realpath, lstat, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { CockpitConfig } from '../schema.js'
import { executeProbe } from '../environment-exec/execute.js'
import {
    generatedApplicationProjection,
    observeGeneratedApplicationSurfaces,
    type GeneratedStaleRemovalApprovalRequest,
} from '../environment/generated-application.js'
import { surfaceDeclarationSha256 } from '../surfaces/merge.js'
import { SURFACE_TARGETS } from '../surfaces/harness-registry.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment, syncTeamGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { roots, cleanup, publicationGroups, consumer, customHarness, enforcedCustomHarness,
    unavailableCustomHarness, surfaceConsumer, digest, writeCustomModule, ownership, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
describe('public surface publication transaction', () => {
        it.each([
            { path: 'package.json', state: 'missing' },
            { path: 'package.json', state: 'unchanged' },
            { path: 'package.json', state: 'stale' },
            { path: '.GITIGNORE', state: 'missing' },
        ])('preserves metadata when its $state destination overlaps generated $path', async ({ path, state }) => {
            const manifest = '{"private":true}\n'
            const fixture = await surfaceConsumer('metadata-output', {
                custom: customHarness('adapters/synthetic.mjs', 'renderRules', path),
            })
            await writeCustomModule(fixture.root, [{ path, bytes: manifest }])
            if (state !== 'missing') {
                expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
                if (state === 'stale') {
                    const config = await readFile(fixture.configPath, 'utf8')
                    await writeFile(fixture.configPath, config.slice(0, config.indexOf('[[surfaces.harnesses]]')))
                }
            }
            const outcome = await syncTeamGeneratedEnvironment({ configPath: fixture.configPath }, {
                authorizeStaleRemoval: async request => ({ format: 'cockpit-stale-removal-approval/v1', digest: request.digest }),
            })
            if (state === 'missing') await expect(lstat(join(fixture.root, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
            else expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toBe(manifest)
            await expect(lstat(join(fixture.root, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' })
            expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'TEAM_METADATA_UNAVAILABLE' })] })
        })

        it('refuses pending metadata writes that are authenticated custom inputs', async () => {
            const manifest = '{"private":true}\n'
            const fixture = await surfaceConsumer('metadata-input', {
                custom: enforcedCustomHarness('adapters/synthetic.mjs', digest(manifest), 'package.json'),
            })
            await writeCustomModule(fixture.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\n' }])
            await writeFile(join(fixture.root, 'package.json'), manifest)
            await writeFile(join(fixture.root, '.gitignore'), 'operator-owned\n')

            expect(await syncTeamGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'TEAM_METADATA_UNAVAILABLE', target: 'package.json' })],
            })
            expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toBe(manifest)
            expect(await readFile(join(fixture.root, '.gitignore'), 'utf8')).toBe('operator-owned\n')
            await expect(lstat(join(fixture.root, 'custom/rules.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('admits exact stale removal once before applying pending team metadata', async () => {
            const fixture = await surfaceConsumer('metadata-stale-approval', { custom: customHarness('adapters/synthetic.mjs') })
            await writeCustomModule(fixture.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\n' }])
            expect(await syncTeamGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            const config = await readFile(fixture.configPath, 'utf8')
            await writeFile(fixture.configPath, config.slice(0, config.indexOf('[[surfaces.harnesses]]')))
            const manifest = '{"private":true}\n'
            await writeFile(join(fixture.root, 'package.json'), manifest)
            const before = await bytes(fixture.root, ['package.json', '.gitignore', 'custom/rules.md', '.cockpit/generated-environment-ownership.json'])
            expect(await syncTeamGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_APPROVAL_REQUIRED' })],
            })
            expect(await bytes(fixture.root, Object.keys(before))).toEqual(before)
            let approvals = 0
            const outcome = await syncTeamGeneratedEnvironment({ configPath: fixture.configPath }, {
                authorizeStaleRemoval: async request => {
                    approvals += 1
                    expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toBe(manifest)
                    return { format: 'cockpit-stale-removal-approval/v1', digest: request.digest }
                },
            })
            expect(outcome, JSON.stringify(outcome.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(approvals).toBe(1)
            expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).not.toBe(manifest)
            await expect(lstat(join(fixture.root, 'custom/rules.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('confines custom check writes to scratch for a self-contained module', async () => {
            const fixture = await surfaceConsumer('custom-read-only', { custom: customHarness('adapters/synthetic.mjs', 'renderRules', 'custom/alpha/SKILL.md') })
            const output = [{ path: 'custom/alpha/SKILL.md', bytes: 'custom/alpha/SKILL.md\nscratch verified\n' }]
            const modulePath = join(fixture.root, await writeCustomModule(fixture.root, output))
            const original = await readFile(modulePath, 'utf8')
            await writeFile(modulePath, `import { writeFile, readFile } from 'node:fs/promises'
const marker = "scratch verified"
${original.replace('  return {', `  await writeFile('scratch-proof', marker)
  if (await readFile('scratch-proof', 'utf8') !== marker) throw new Error('scratch readback')
  return {`)}`)
            const steps: Parameters<typeof executeProbe>[0][] = []
            const adapters = { execute: async (step: Parameters<typeof executeProbe>[0]) => {
                if (step.id.startsWith('custom-surface-')) steps.push(step)
                return executeProbe(step)
            } }
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath }, adapters)
            expect(synced, JSON.stringify(synced)).toMatchObject({ kind: 'complete' })
            if (synced.kind !== 'complete') throw new Error('custom publication unavailable')
            const skills = observeGeneratedApplicationSurfaces(synced.result.application)
                ?.find(row => row.code === 'SKILL_BUDGET_UNAVAILABLE')
            expect(skills).toMatchObject({ observed: { state: 'available', value: {
                inventory: expect.any(Array), costs: expect.any(Array),
            } } })
            expect(JSON.stringify(skills)).not.toContain('custom/alpha/SKILL.md')
            expect(synced.result.application.surfaceSelftest.entries).toContainEqual(expect.objectContaining({
                path: 'custom/alpha/SKILL.md', sha256: digest(output[0].bytes),
            }))
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true }, adapters)).toMatchObject({ kind: 'complete' })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(steps).toHaveLength(2)
            for (const step of steps) {
                expect(step.cwd).not.toBe(fixture.root)
                expect(step.argv).toContain(`--allow-fs-write=${step.cwd}`)
                expect(step.argv.filter(argument => argument.startsWith('--allow-fs-write='))).toHaveLength(1)
                expect(step.argv.some(argument => argument === '--permission' || argument === '--experimental-permission')).toBe(true)
                expect(step.argv).not.toEqual(expect.arrayContaining(['--allow-child-process', '--allow-worker', '--allow-addons']))
                for (const grant of ['--allow-child-process', '--allow-worker', '--allow-addons']) expect(step.argv).not.toContain(grant)
                await expect(lstat(step.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
            }
            await expect(lstat(join(fixture.root, 'scratch-proof'))).rejects.toMatchObject({ code: 'ENOENT' })
            const before = await readFile(join(fixture.root, 'unmanaged.txt'), 'utf8')
            for (const target of ['unmanaged.txt', 'attempted-output.txt']) {
                await writeFile(modulePath, `import { writeFile } from 'node:fs/promises'
${original.replace('  return {', `  await writeFile(${JSON.stringify(join(fixture.root, target))}, 'attempted consumer write')
  return {`)}`)
                expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({
                    kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })],
                })
                expect(await readFile(join(fixture.root, 'unmanaged.txt'), 'utf8')).toBe(before)
                await expect(lstat(join(fixture.root, 'attempted-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
            }
        }, 240_000)

        it('refuses a custom module with an adjacent dependency', async () => {
            const fixture = await surfaceConsumer('custom-adjacent-dependency', { custom: customHarness('adapters/synthetic.mjs') })
            const modulePath = join(fixture.root, await writeCustomModule(fixture.root, [{ path: 'custom/seed.md', bytes: 'custom/rules.md\n' }]))
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            await writeCustomModule(fixture.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\n' }])
            const original = await readFile(modulePath, 'utf8')
            await writeFile(join(fixture.root, 'adapters/dependency.mjs'), 'export const marker = "dependency loaded"\n')
            await writeFile(modulePath, `import { marker } from './dependency.mjs'\n${original.replace('  return {', `  if (marker !== 'dependency loaded') throw new Error('dependency')\n  return {`)}`)

            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })],
            })
            await expect(lstat(join(fixture.root, 'custom/rules.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        }, 120_000)

        it('refuses custom dispatch when filesystem permission flags are unsupported', async () => {
            const fixture = await surfaceConsumer('custom-permission-unavailable', { custom: customHarness('adapters/synthetic.mjs') })
            await writeCustomModule(fixture.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\n' }])
            let invocations = 0
            const descriptor = Object.getOwnPropertyDescriptor(process, 'allowedNodeEnvironmentFlags')!
            const adapters = { execute: async (step: Parameters<typeof executeProbe>[0]) => {
                if (step.id.startsWith('custom-surface-')) invocations += 1
                return executeProbe(step)
            } }
            try {
                Object.defineProperty(process, 'allowedNodeEnvironmentFlags', { configurable: true, value: new Set() })
                expect(await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true }, adapters)).toMatchObject({
                    kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })],
                })
                expect(invocations).toBe(0)
            } finally {
                Object.defineProperty(process, 'allowedNodeEnvironmentFlags', descriptor)
            }
        }, 120_000)

        it.each([false, true])('issues active surface overrides and changed originals only from the authenticated merge (additional skill: %s)', async additionalSkill => {
            const fixture = await surfaceConsumer('surface-override-projection')
            const entryPoint = await readFile(resolve('packages/cockpit/surfaces/skills/cockpit-setup.skill.md'), 'utf8')
            const procedure = await readFile(resolve('packages/cockpit/surfaces/skills/procedures/onboarding.md'), 'utf8')
            const originalSha256 = surfaceDeclarationSha256({
                name: 'cockpit-setup',
                feature: 'skills',
                source: 'skills/cockpit-setup.skill.md',
                sources: [
                    { path: 'skills/cockpit-setup/SKILL.md', bytes: entryPoint },
                    { path: 'skills/cockpit-setup/procedures/onboarding.md', bytes: procedure },
                ],
            })
            const recordedSha256 = 'a'.repeat(64)
            const replacementSources = [
                { path: 'skills/cockpit-setup/SKILL.md', bytes: entryPoint.replace('Bootstrap this cockpit', 'Bootstrap this synthetic cockpit') },
                { path: 'skills/cockpit-setup/procedures/onboarding.md', bytes: procedure },
                ...(additionalSkill ? [
                    { path: 'skills/inspect/SKILL.md', bytes: entryPoint.replace('name: cockpit-setup', 'name: inspect') },
                    { path: 'skills/inspect/procedures/onboarding.md', bytes: procedure },
                ] : []),
            ]
            const declaration = await readFile(fixture.configPath, 'utf8')
            await writeFile(fixture.configPath, `${declaration}
[[surfaces.overlays]]
name = "cockpit-setup"
feature = "skills"
source = "surfaces/bootstrap-override.json"
replaces = { name = "cockpit-setup", sha256 = "${recordedSha256}" }
sources = [
${replacementSources.map(source => `  { path = ${JSON.stringify(source.path)}, bytes = ${JSON.stringify(source.bytes)} },`).join('\n')}
]
`)

            // The pin records which built-in the overlay was reviewed against: a preview names the
            // change, and sync and check refuse until the pin is updated.
            const pinnedConfig = (await readFile(fixture.configPath, 'utf8')).replace(recordedSha256, originalSha256)
            const staleConfig = await readFile(fixture.configPath, 'utf8')
            await writeFile(fixture.configPath, pinnedConfig)
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            await writeFile(fixture.configPath, staleConfig)
            const changed = expect.objectContaining({ code: 'OVERRIDDEN_CORE_CHANGED', target: 'surfaces/bootstrap-override.json',
                message: expect.stringContaining(originalSha256) })
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'refusal', diagnostics: [changed] })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'refusal', diagnostics: [changed] })
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })
            expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
            if (synced.kind !== 'complete') return
            expect(synced.diagnostics).toContainEqual(changed)
            if (additionalSkill) expect(synced.result.paths).toContain('.agents/skills/inspect/SKILL.md')
            const application = generatedApplicationProjection(synced.result.application)
            expect(application?.activeSurfaceOverrides).toEqual([{
                name: 'cockpit-setup', feature: 'skills', originalSha256, recordedSha256,
                overlaySource: 'surfaces/bootstrap-override.json',
            }])
            expect(application?.changedOverrideOriginals).toEqual([{
                code: 'OVERRIDDEN_CORE_CHANGED', name: 'cockpit-setup', recordedSha256,
                currentSha256: originalSha256, overlaySource: 'surfaces/bootstrap-override.json',
            }])
            expect(Object.isFrozen(application?.activeSurfaceOverrides)).toBe(true)
            expect(Object.isFrozen(application?.changedOverrideOriginals)).toBe(true)
            expect(generatedApplicationProjection({ ...synced.result.application })).toBeUndefined()
            await writeFile(fixture.configPath, pinnedConfig)
            const pinned = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(pinned, JSON.stringify(pinned.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(pinned.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'OVERRIDDEN_CORE_CHANGED' }))
        }, 120_000)

        it('authenticates enforced custom evidence before invoking its declared module', async () => {
            const module = 'adapters/synthetic.mjs'
            const evidenceReference = 'evidence/rules.json'
            const evidenceBytes = '{"harness":"synthetic-harness","feature":"rules","measuredOn":"2026-09-26"}\n'
            const evidenceSha256 = digest(evidenceBytes)
            const fixture = await surfaceConsumer('custom-enforced-evidence', {
                custom: enforcedCustomHarness(module, evidenceSha256, evidenceReference),
            })
            await writeCustomModule(fixture.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\nenforced\n' }])
            let invocations = 0
            const adapters = {
                execute: async (step: Parameters<typeof executeProbe>[0]) => {
                    if (step.id.startsWith('custom-surface-')) invocations += 1
                    return executeProbe(step)
                },
            }

            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath }, adapters)).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })],
            })
            expect(invocations).toBe(0)
            await mkdir(join(fixture.root, 'evidence'))
            await writeFile(join(fixture.root, evidenceReference), 'mismatched evidence\n')
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath }, adapters)).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_CUSTOM_REFUSED' })],
            })
            expect(invocations).toBe(0)

            await writeFile(join(fixture.root, evidenceReference), evidenceBytes)
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath }, adapters)
            expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(invocations).toBe(1)
            if (synced.kind !== 'complete') return
            expect(synced.result.application.surfaceSelftest.custom).toContainEqual(expect.objectContaining({
                harness: 'synthetic-harness', feature: 'rules', state: 'enforced', measuredOn: '2026-09-26',
                evidence: { reference: evidenceReference, sha256: evidenceSha256 },
            }))
        }, 240_000)

        it('publishes an opted-in Claude plugin bundle without claiming unmanaged bundle files', async () => {
            const fixture = await surfaceConsumer('claude-plugin-bundle', { bundles: true })
            const bundleRoot = '.cockpit/bundles/claudecode-plugin'
            const manifest = `${bundleRoot}/.claude-plugin/plugin.json`
            const skill = `${bundleRoot}/skills/cockpit-setup/SKILL.md`
            const unmanaged = `${bundleRoot}/consumer-note.txt`

            const preview = await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })
            expect(preview, JSON.stringify(preview.diagnostics)).toMatchObject({ kind: 'complete', result: { dryRun: true } })
            if (preview.kind !== 'complete') return
            expect(preview.result.changes).toEqual(expect.arrayContaining([
                { operation: 'write', path: manifest },
                { operation: 'write', path: skill },
                // The skill tells the agent to read this reference, so the bundle carries it.
                { operation: 'write', path: `${bundleRoot}/skills/cockpit-setup/references/test-data-and-personas.md` },
            ]))
            await expect(lstat(join(fixture.root, manifest))).rejects.toMatchObject({ code: 'ENOENT' })

            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synced).toMatchObject({ kind: 'complete' })
            if (synced.kind !== 'complete') throw new Error('plugin publication unavailable')
            const skills = observeGeneratedApplicationSurfaces(synced.result.application)
                ?.find(row => row.code === 'SKILL_BUDGET_UNAVAILABLE')
            expect(skills).toMatchObject({ observed: { state: 'available', value: { inventory: expect.any(Array) } } })
            expect(JSON.stringify(skills)).not.toContain(bundleRoot)
            expect(synced.result.application.surfaceSelftest.entries).toContainEqual(expect.objectContaining({ path: skill }))
            expect(JSON.parse(await readFile(join(fixture.root, manifest), 'utf8'))).toEqual({
                name: 'cockpit-surfaces',
                description: 'Generated cockpit agent surfaces.',
            })
            await writeFile(join(fixture.root, unmanaged), 'consumer owned\n')
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(fixture.root, unmanaged), 'utf8')).toBe('consumer owned\n')

            await writeFile(join(fixture.root, skill), 'changed\n')
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ target: skill })],
            })
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ target: skill })],
            })
            expect(await readFile(join(fixture.root, skill), 'utf8')).toBe('changed\n')
            expect(await readFile(join(fixture.root, unmanaged), 'utf8')).toBe('consumer owned\n')
        }, 360_000)

        it('projects authenticated selftest inputs without issuing cloned authority', async () => {
            const fixture = await surfaceConsumer('selftest-projection', {
                rules: true, custom: customHarness('adapters/synthetic.mjs'),
            })
            await writeCustomModule(fixture.root, [{ path: 'custom/rules.md', bytes: 'synthetic custom rules\n' }])
            const unavailable = await surfaceConsumer('selftest-unavailable', { custom: unavailableCustomHarness() })
            const [synced, absent] = await Promise.all([
                syncGeneratedEnvironment({ configPath: fixture.configPath }),
                syncGeneratedEnvironment({ configPath: unavailable.configPath }),
            ])
            expect(synced.kind).toBe('complete')
            expect(absent.kind).toBe('complete')
            if (synced.kind !== 'complete' || absent.kind !== 'complete') throw new Error('selftest projection producer refused')
            const application = generatedApplicationProjection(synced.result.application)
            expect(application).toBe(synced.result.application)
            expect(generatedApplicationProjection({ ...application })).toBeUndefined()
            const projection = application!.surfaceSelftest
            const { schema, configuredHarnesses, declarations, entries, custom } = projection
            expect(projection.manifestSha256).toBe(createHash('sha256').update(JSON.stringify({
                schema, configuredHarnesses, declarations, entries, custom,
            })).digest('hex'))
            expect(configuredHarnesses).toEqual([...SURFACE_TARGETS, 'synthetic-harness'].sort())
            expect(declarations).toHaveLength(1)
            expect(declarations[0]?.capabilities).toHaveLength(6)
            expect(custom).toHaveLength(1)
            expect(custom[0]).toMatchObject({
                harness: 'synthetic-harness', feature: 'rules', state: 'instructed',
                module: 'adapters/synthetic.mjs', export: 'renderRules', measuredOn: '2026-09-26',
                sourceSha256: createHash('sha256').update(await readFile(join(fixture.root, 'adapters/synthetic.mjs'))).digest('hex'),
                sources: [{ path: 'rules/synthetic.md', bytes: 'Read the synthetic sibling guide before editing.\n' }],
            })
            expect(entries).toContainEqual(expect.objectContaining({ path: 'custom/rules.md', bytes: 'synthetic custom rules\n' }))
            const immutable = (value: unknown): boolean => value === null || typeof value !== 'object'
                || Object.isFrozen(value) && Object.values(value).every(immutable)
            expect(immutable(projection)).toBe(true)
            const checked = await checkGeneratedEnvironment({ configPath: fixture.configPath })
            expect(checked.kind).toBe('complete')
            if (checked.kind !== 'complete') throw new Error('selftest projection check refused')
            expect(checked.result.application.surfaceSelftest).toEqual(projection)
            const unavailableProjection = absent.result.application.surfaceSelftest
            expect(unavailableProjection.custom).toEqual([])
            expect(unavailableProjection.declarations[0]?.capabilities.every(row => row.state === 'unavailable')).toBe(true)
            expect(unavailableProjection.entries.some(row => row.harnesses.includes('synthetic-harness'))).toBe(false)
        }, 180_000)

        it('reconciles generated whole files and sibling symlinks and removes exact stale ownership', async () => {
            const module = 'adapters/synthetic.mjs'
            const first = await surfaceConsumer('surface-reconcile', { rules: true, custom: customHarness(module) })
            await writeCustomModule(first.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\nfirst\n' }])

            const synced = await syncGeneratedEnvironment({ configPath: first.configPath })
            expect(synced).toMatchObject({ kind: 'complete' })
            if (synced.kind !== 'complete') return
            expect(synced.result.paths).toEqual(expect.arrayContaining(['custom/rules.md', '.sibling-app-AGENTS.md']))
            const customRules = await readFile(join(first.root, 'custom/rules.md'))
            expect((await lstat(join(first.root, '.sibling-app-AGENTS.md'))).isSymbolicLink()).toBe(true)
            expect(await readlink(join(first.root, '.sibling-app-AGENTS.md'))).toBe('app/AGENTS.md')
            const ledger = await ownership(first.root)
            const reconciledPaths = new Set(['custom/rules.md', '.sibling-app-AGENTS.md'])
            const reconciledOwnership = (ledger.entries as readonly { path: string }[])
                .filter(({ path }) => reconciledPaths.has(path))
            expect(ledger).toMatchObject({ format: 'cockpit-generated-ownership/v3' })
            expect(JSON.stringify(ledger)).toContain('custom/rules.md')
            expect(JSON.stringify(ledger)).toContain('.sibling-app-AGENTS.md')
            expect((await readdir(join(first.root, '.cockpit'))).filter((path) => path.includes('ownership'))).toEqual([
                'generated-environment-ownership.json',
            ])

            await Promise.all([
                rm(join(first.root, 'custom/rules.md')),
                rm(join(first.root, '.sibling-app-AGENTS.md')),
            ])
            await expect(lstat(join(first.root, 'custom/rules.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(lstat(join(first.root, '.sibling-app-AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            const repaired = await syncGeneratedEnvironment({ configPath: first.configPath })
            expect(repaired, JSON.stringify(repaired.diagnostics)).toMatchObject({ kind: 'complete' })
            await expect(readFile(join(first.root, 'custom/rules.md'))).resolves.toEqual(customRules)
            expect((await lstat(join(first.root, '.sibling-app-AGENTS.md'))).isSymbolicLink()).toBe(true)
            expect(await readlink(join(first.root, '.sibling-app-AGENTS.md'))).toBe('app/AGENTS.md')
            const repairedLedger = await ownership(first.root)
            expect((repairedLedger.entries as readonly { path: string }[]).filter(({ path }) => reconciledPaths.has(path)))
                .toEqual(reconciledOwnership)
            expect(JSON.stringify(repairedLedger)).not.toContain(first.root)

            // The guide is the sibling team's file: edits to it, a checkout that replaces it, and a
            // clone of the whole workspace at another path leave cockpit's link and record current.
            const ledgerBytes = await readFile(join(first.root, '.cockpit/generated-environment-ownership.json'), 'utf8')
            await writeFile(join(first.root, 'app/AGENTS.md'), 'Synthetic sibling guide.\nA rule the sibling team added.\n')
            await writeFile(join(first.root, 'app/AGENTS.md.next'), 'Synthetic sibling guide.\nA rule from a checkout.\n')
            await rename(join(first.root, 'app/AGENTS.md.next'), join(first.root, 'app/AGENTS.md'))
            const edited = await checkGeneratedEnvironment({ configPath: first.configPath })
            expect(edited, JSON.stringify(edited.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(first.root, '.sibling-app-AGENTS.md'), 'utf8')).toContain('A rule from a checkout.')
            expect(await syncGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(first.root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(ledgerBytes)
            const clone = `${first.root}-clone`
            await rename(first.root, clone)
            try {
                const cloned = await checkGeneratedEnvironment({ configPath: join(clone, basename(first.configPath)) })
                expect(cloned, JSON.stringify(cloned.diagnostics)).toMatchObject({ kind: 'complete' })
            } finally {
                await rename(clone, first.root)
            }
            await rm(join(first.root, '.sibling-app-AGENTS.md'))
            await writeFile(join(first.root, '.sibling-app-AGENTS.md'), 'Synthetic sibling guide.\nA rule from a checkout.\n')
            expect(await checkGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_STATE_CONFLICT', target: '.sibling-app-AGENTS.md' })],
            })
            await rm(join(first.root, '.sibling-app-AGENTS.md'))
            await symlink('app/CLAUDE.md', join(first.root, '.sibling-app-AGENTS.md'))
            expect((await checkGeneratedEnvironment({ configPath: first.configPath })).kind).toBe('refusal')
            await rm(join(first.root, '.sibling-app-AGENTS.md'))
            expect(await syncGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({ kind: 'complete' })

            const active = await readFile(first.configPath, 'utf8')
            const withoutSurfaces = active
                .slice(0, active.indexOf('[[surfaces.harnesses]]'))
                .replace('guides = ["AGENTS.md"]', 'guides = []')
            await writeFile(first.configPath, withoutSurfaces)
            // Plain sync refuses a stale removal, so check names the command that can approve it.
            expect(await checkGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({ kind: 'refusal',
                diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', fix: expect.stringContaining('sync --config <your cockpit.toml> --interactive') })] })
            const staleCustom = await readFile(join(first.root, 'custom/rules.md'))
            const staleClaudeLocal = await readFile(join(first.root, 'CLAUDE.local.md'))
            let staleApprovalRequest: GeneratedStaleRemovalApprovalRequest | undefined
            const removed = await syncGeneratedEnvironment({ configPath: first.configPath }, {
                authorizeStaleRemoval: async request => {
                    staleApprovalRequest = request
                    return Object.freeze({ format: 'cockpit-stale-removal-approval/v1', digest: request.digest })
                },
            })
            expect(removed, JSON.stringify(removed.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(staleApprovalRequest).toMatchObject({
                entries: [
                    { path: '.sibling-app-AGENTS.md', current: { kind: 'symlink', target: 'app/AGENTS.md' } },
                    {
                        path: 'CLAUDE.local.md',
                        operation: 'write-file',
                        current: { kind: 'file', sha256: digest(staleClaudeLocal) },
                        resultSha256: digest('\n'),
                    },
                    { path: 'custom/rules.md', current: { kind: 'file', sha256: digest(staleCustom) } },
                ],
            })
            await expect(lstat(join(first.root, 'custom/rules.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(lstat(join(first.root, '.sibling-app-AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })

        }, 180_000)

        it('keeps an active in-repo sibling runnable without projecting root instruction files into themselves', async () => {
            const fixture = await surfaceConsumer('in-repo-active-sibling')
            await mkdir(join(fixture.root, 'docs'))
            await writeFile(join(fixture.root, 'docs/CONVENTIONS.md'), 'Synthetic product conventions.\n')
            const declaration = await readFile(fixture.configPath, 'utf8')
            await writeFile(fixture.configPath, declaration
                .replace('dir = "app"', 'dir = "."')
                .replace('guides = ["AGENTS.md"]', 'guides = ["CLAUDE.md", "AGENTS.md", "docs/CONVENTIONS.md"]'))

            const first = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })

            await expect(lstat(join(fixture.root, '.sibling-app-CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(lstat(join(fixture.root, '.sibling-app-AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await readlink(join(fixture.root, '.sibling-app-docs-CONVENTIONS.md'))).toBe('docs/CONVENTIONS.md')
            expect(parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8'))).toEqual({
                sandbox_mode: 'workspace-write',
                sandbox_workspace_write: { writable_roots: ['..'] },
            })
        }, 180_000)

        it('refuses changed stale ownership and preserves consumer bytes', async () => {
            const module = 'adapters/synthetic.mjs'
            const changed = await surfaceConsumer('surface-stale-changed', { custom: customHarness(module) })
            await writeCustomModule(changed.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\nowned\n' }])
            expect(await syncGeneratedEnvironment({ configPath: changed.configPath })).toMatchObject({ kind: 'complete' })
            const changedConfig = await readFile(changed.configPath, 'utf8')
            await writeFile(changed.configPath, changedConfig.slice(0, changedConfig.indexOf('[[surfaces.harnesses]]')))
            await writeFile(join(changed.root, 'custom/rules.md'), 'consumer bytes\n')
            expect(await syncGeneratedEnvironment({ configPath: changed.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ target: 'custom/rules.md' })],
            })
            expect(await readFile(join(changed.root, 'custom/rules.md'), 'utf8')).toBe('consumer bytes\n')
        })

        it('preserves an active unmanaged Claude import without claiming ownership', async () => {
            const imported = await surfaceConsumer('existing-claude-import', { rules: true })
            const teamGuide = '# Team notes\n\n@AGENTS.md\n\nKeep this text.\n'
            await writeFile(join(imported.root, 'CLAUDE.md'), teamGuide)
            expect(await syncGeneratedEnvironment({ configPath: imported.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(imported.root, 'CLAUDE.md'), 'utf8')).toBe(teamGuide)
            const importedOwnership = await ownership(imported.root) as { entries: readonly { path: string }[] }
            expect(importedOwnership.entries.some(entry => entry.path === 'CLAUDE.md')).toBe(false)
            expect(await checkGeneratedEnvironment({ configPath: imported.configPath })).toMatchObject({ kind: 'complete' })
            await writeFile(join(imported.root, 'CLAUDE.md'), '# Team notes\n\nKeep this text.\n')
            expect(await checkGeneratedEnvironment({ configPath: imported.configPath })).toMatchObject({ kind: 'refusal' })
        })

        it('removes a superseded owned Claude region when an active import exists', async () => {
            const migratedImport = await surfaceConsumer('migrated-claude-import', { rules: true })
            await writeFile(join(migratedImport.root, 'CLAUDE.md'), '# Team guide\n')
            expect(await syncGeneratedEnvironment({ configPath: migratedImport.configPath })).toMatchObject({ kind: 'complete' })
            const ownedClaude = await readFile(join(migratedImport.root, 'CLAUDE.md'), 'utf8')
            await writeFile(join(migratedImport.root, 'CLAUDE.md'), `${ownedClaude}@AGENTS.md\n`)
            expect(await syncGeneratedEnvironment({ configPath: migratedImport.configPath }, {
                authorizeStaleRemoval: async request => Object.freeze({ format: 'cockpit-stale-removal-approval/v1', digest: request.digest }),
            })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(migratedImport.root, 'CLAUDE.md'), 'utf8')).toBe('# Team guide\n\n@AGENTS.md\n')
            const migratedOwnership = await ownership(migratedImport.root) as { entries: readonly { path: string }[] }
            expect(migratedOwnership.entries.some(entry => entry.path === 'CLAUDE.md')).toBe(false)
        })

        it('preserves shared outside bytes and refuses ambiguous OpenCode ownership', async () => {
            const accepted = await surfaceConsumer('shared-preservation', { rules: true })
            const markdown = 'consumer heading\n\nconsumer tail\n'
            const openCode = '{\n  "theme": "dark"\n}\n'
            await writeFile(join(accepted.root, 'CLAUDE.md'), markdown)
            await writeFile(join(accepted.root, 'opencode.jsonc'), openCode)

            expect(await syncGeneratedEnvironment({ configPath: accepted.configPath })).toMatchObject({ kind: 'complete' })
            const publishedMarkdown = await readFile(join(accepted.root, 'CLAUDE.md'), 'utf8')
            const publishedOpenCode = await readFile(join(accepted.root, 'opencode.jsonc'), 'utf8')
            expect(publishedMarkdown.slice(0, publishedMarkdown.indexOf('<!-- cockpit:instructions:start -->'))).toBe(markdown)
            expect(publishedOpenCode.startsWith('{')).toBe(true)
            expect(publishedOpenCode.endsWith(openCode.slice(1))).toBe(true)
            expect(await checkGeneratedEnvironment({ configPath: accepted.configPath })).toMatchObject({ kind: 'complete' })

            const controls = await Promise.all([
                surfaceConsumer('opencode-duplicate', { rules: true }),
                surfaceConsumer('opencode-unowned', { rules: true }),
                surfaceConsumer('opencode-alternate', { rules: true }),
            ])
            const candidates = [
                ['opencode.jsonc', '{"theme":"dark","theme":"light"}\n'],
                ['opencode.jsonc', '{"instructions":[]}\n'],
                ['opencode.json', '{}\n'],
            ] as const
            await Promise.all(controls.map((control, index) =>
                writeFile(join(control.root, candidates[index]![0]), candidates[index]![1])))
            const refused = await Promise.all(controls.map((control) => syncGeneratedEnvironment({ configPath: control.configPath })))
            expect(refused).toEqual(refused.map(() => expect.objectContaining({ kind: 'refusal' })))
            await Promise.all(controls.map(async (control, index) => {
                expect(await readFile(join(control.root, candidates[index]![0]), 'utf8')).toBe(candidates[index]![1])
                await expect(lstat(join(control.root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
            }))
        })

        it('refuses duplicate Claude imports and does not treat a fenced import as active', async () => {
            const duplicateImport = await surfaceConsumer('duplicate-claude-import', { rules: true })
            await writeFile(join(duplicateImport.root, 'CLAUDE.md'), '@AGENTS.md\n\n@AGENTS.md\n')
            expect(await syncGeneratedEnvironment({ configPath: duplicateImport.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_STATE_CONFLICT' })],
            })

            const fencedImport = await surfaceConsumer('fenced-claude-import', { rules: true })
            await writeFile(join(fencedImport.root, 'CLAUDE.md'), '# Team guide\n\n````text\n```\n@AGENTS.md\n````\n')
            expect(await syncGeneratedEnvironment({ configPath: fencedImport.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(fencedImport.root, 'CLAUDE.md'), 'utf8')).toContain('<!-- cockpit:instructions:start -->')

            const commentedExample = await surfaceConsumer('commented-claude-example', { rules: true })
            const activeGuide = '# Team guide\n\n```text\n<!-- example only\n```\n\n@AGENTS.md\n'
            await writeFile(join(commentedExample.root, 'CLAUDE.md'), activeGuide)
            expect(await syncGeneratedEnvironment({ configPath: commentedExample.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(commentedExample.root, 'CLAUDE.md'), 'utf8')).toBe(activeGuide)
        })

        it('refuses a replaced guide after every publication group is prepared', async () => {
            const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-generated-guide-estate-')))
            roots.push(estate)
            const siblingRoot = join(estate, 'external')
            const fixture = await surfaceConsumer('guide-pre-publish-freshness', {
                rules: true, siblingDirectory: siblingRoot, parentDirectory: estate,
            })
            expect(dirname(fixture.root)).toBe(estate)
            expect(dirname(siblingRoot)).toBe(estate)
            const declaration = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            declaration.cockpit.siblings_root = estate
            declaration.sibling.find(sibling => sibling.slug === 'app')!.dir = relative(estate, join(fixture.root, 'app'))
            declaration.environment.generated!.vendors = []
            declaration.environment.generated!.decisions.entries = declaration.environment.generated!.decisions.entries
                .filter(entry => entry.subject !== 'vendor')
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))
            await writeFile(join(siblingRoot, 'sentinel.txt'), 'outside bytes\n')
            const initial = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(initial, JSON.stringify(initial.diagnostics)).toMatchObject({ kind: 'complete' })
            if (initial.kind !== 'complete') return
            const authored = await bytes(fixture.root, initial.result.paths)
            const ledgerPath = join(fixture.root, '.cockpit/generated-environment-ownership.json')
            const ledger = await readFile(ledgerPath, 'utf8')
            await writeFile(join(fixture.root, 'fixtures/personas.json'), '[{"id":"second"}]\n')
            const guidePath = join(siblingRoot, 'AGENTS.md')
            const heldGuidePath = join(siblingRoot, 'AGENTS-held.md')
            let replaced = false
            let publishAttempts = 0
            const preparedParents: string[] = []

            const refused = await syncGeneratedEnvironment({ configPath: fixture.configPath }, {
                execute: async (step) => {
                    const outcome = await executeProbe(step)
                    publishAttempts += publicationGroups(step, 'publish').length
                    const prepared = publicationGroups(step, 'prepare').map(group => group.parent)
                    if (prepared.length > 0) {
                        preparedParents.push(...prepared)
                        if (!replaced && prepared.includes('.cockpit')) {
                            replaced = true
                            const guide = await readFile(guidePath)
                            await rename(guidePath, heldGuidePath)
                            await writeFile(guidePath, guide)
                        }
                    }
                    return outcome
                },
            })

            expect(replaced).toBe(true)
            expect(preparedParents.length).toBeGreaterThan(1)
            expect(preparedParents.at(-1)).toBe('.cockpit')
            expect(publishAttempts).toBe(0)
            expect(refused).toMatchObject({
                kind: 'refusal',
                diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED', target: 'generated-environment' })],
            })
            expect(await bytes(fixture.root, initial.result.paths)).toEqual(authored)
            expect(await readFile(ledgerPath, 'utf8')).toBe(ledger)
            expect(await readFile(guidePath, 'utf8')).toBe('Synthetic sibling guide.\n')
            expect(await readFile(heldGuidePath, 'utf8')).toBe('Synthetic sibling guide.\n')
            expect(await readFile(join(siblingRoot, 'sentinel.txt'), 'utf8')).toBe('outside bytes\n')
            expect((await readdir(siblingRoot)).sort()).toEqual(['AGENTS-held.md', 'AGENTS.md', 'sentinel.txt'])
        })

        it('refuses a sibling-root ancestor redirected between configuration and surface authentication', async () => {
            const declaredRoot = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-generated-sibling-authority-')))
            const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-generated-sibling-escape-')))
            roots.push(declaredRoot, outsideRoot)
            const appRoot = join(declaredRoot, 'app')
            const siblingRoot = join(declaredRoot, 'external')
            await mkdir(appRoot)
            await writeFile(join(appRoot, 'AGENTS.md'), 'Synthetic application guide.\n')
            const fixture = await surfaceConsumer('sibling-ancestor-pre-publish-freshness', {
                rules: true, siblingDirectory: siblingRoot,
            })
            const declaration = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            declaration.cockpit.siblings_root = declaredRoot
            declaration.sibling.find(sibling => sibling.slug === 'app')!.dir = relative(declaredRoot, appRoot)
            declaration.environment.generated!.vendors = []
            declaration.environment.generated!.decisions.entries = declaration.environment.generated!.decisions.entries
                .filter(entry => entry.subject !== 'vendor')
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))

            const initial = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(initial, JSON.stringify(initial.diagnostics)).toMatchObject({ kind: 'complete' })
            if (initial.kind !== 'complete') return
            const authored = await bytes(fixture.root, initial.result.paths)
            await writeFile(join(fixture.root, 'fixtures/personas.json'), '[{"id":"second"}]\n')
            const escapedRoot = join(outsideRoot, 'escaped')
            let replaced = false
            let publishAttempts = 0
            const originalLstat = fsPromises.lstat
            function swappingLstat(path: PathLike, options?: StatOptions & { bigint?: false }): Promise<Stats>
            function swappingLstat(path: PathLike, options: StatOptions & { bigint: true }): Promise<BigIntStats>
            function swappingLstat(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>
            async function swappingLstat(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats> {
                const observed = await originalLstat(path, options)
                if (!replaced && path === siblingRoot) {
                    replaced = true
                    await rename(declaredRoot, escapedRoot)
                    await symlink(escapedRoot, declaredRoot, 'dir')
                }
                return observed
            }
            const spy = vi.spyOn(fsPromises, 'lstat').mockImplementation(swappingLstat)
            syncBuiltinESMExports()
            try {
                const refused = await syncGeneratedEnvironment({ configPath: fixture.configPath }, {
                    execute: async (step) => {
                        const outcome = await executeProbe(step)
                        publishAttempts += publicationGroups(step, 'publish').length
                        return outcome
                    },
                })

                expect(replaced).toBe(true)
                expect(publishAttempts).toBe(0)
                expect(refused).toMatchObject({
                    kind: 'refusal',
                    diagnostics: [expect.objectContaining({ code: 'GENERATED_SIBLING_ROOT_INVALID', target: 'sibling' })],
                })
                expect(await bytes(fixture.root, initial.result.paths)).toEqual(authored)
            } finally {
                spy.mockRestore()
                syncBuiltinESMExports()
            }
        })
})
})
