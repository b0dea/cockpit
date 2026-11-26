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
import { generatedApplicationProjection } from '../environment/generated-application/authorities.js'
import { type GeneratedStaleRemovalApprovalRequest } from '../environment/generated-application/shared.js'
import { surfaceDeclarationSha256 } from '../surfaces/merge.js'
import { DEFAULT_SURFACE_TOOLS } from '../surfaces/harness-registry.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment, syncTeamGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { roots, cleanup, publicationGroups, consumer, surfaceConsumer, digest, ownership, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

// Cursor is listed beside the default tools so that dropping it again leaves its whole files stale.
const WITH_CURSOR = '\n[surfaces]\ntools = ["claudecode", "codexcli", "opencode", "cursor"]\n'
const withoutCursor = (declaration: string) => declaration.replace(', "cursor"]', ']')

describe('generated environment command', () => {
describe('public surface publication transaction', () => {
        it('admits exact stale removal once before applying pending team metadata', async () => {
            const fixture = await surfaceConsumer('metadata-stale-approval', { custom: WITH_CURSOR })
            const first = await syncTeamGeneratedEnvironment({ configPath: fixture.configPath })
            expect(first).toMatchObject({ kind: 'complete' })
            if (first.kind !== 'complete') return
            const cursorFile = ('paths' in first.result ? first.result.paths : []).find(path => path.startsWith('.cursor/'))!
            expect(cursorFile).toBeDefined()
            const removed = withoutCursor(await readFile(fixture.configPath, 'utf8'))
            await writeFile(fixture.configPath, removed)
            // Dropping a tool may widen what agents do, so this stands for the sync a person confirmed.
            const confirmed = { configPath: fixture.configPath, guardWidening: { configSha256: createHash('sha256').update(removed).digest('hex') } }
            const manifest = '{"private":true}\n'
            await writeFile(join(fixture.root, 'package.json'), manifest)
            const before = await bytes(fixture.root, ['package.json', '.gitignore', cursorFile, '.cockpit/generated-environment-ownership.json'])
            expect(await syncTeamGeneratedEnvironment(confirmed)).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_APPROVAL_REQUIRED' })],
            })
            expect(await bytes(fixture.root, Object.keys(before))).toEqual(before)
            let approvals = 0
            const outcome = await syncTeamGeneratedEnvironment(confirmed, {
                authorizeStaleRemoval: async request => {
                    approvals += 1
                    expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toBe(manifest)
                    return { format: 'cockpit-stale-removal-approval/v1', digest: request.digest }
                },
            })
            expect(outcome, JSON.stringify(outcome.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(approvals).toBe(1)
            expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).not.toBe(manifest)
            await expect(lstat(join(fixture.root, cursorFile))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it.each([false, true])('issues active surface overrides and changed originals only from the authenticated merge (additional skill: %s)', async additionalSkill => {
            const fixture = await surfaceConsumer('surface-override-projection')
            const entryPoint = (await readFile(resolve('packages/cockpit/surfaces/skills/cockpit-setup.skill.md'), 'utf8')).replace('{{tool-equivalence}}', 'Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.')
            const procedure = await readFile(resolve('packages/cockpit/surfaces/skills/procedures/setup.md'), 'utf8')
            const originalSha256 = surfaceDeclarationSha256({
                name: 'cockpit-setup',
                feature: 'skills',
                source: 'skills/cockpit-setup.skill.md',
                sources: [
                    { path: 'skills/cockpit-setup/SKILL.md', bytes: entryPoint },
                    { path: 'skills/cockpit-setup/procedures/setup.md', bytes: procedure },
                ],
            })
            const recordedSha256 = 'a'.repeat(64)
            const replacementSources = [
                { path: 'skills/cockpit-setup/SKILL.md', bytes: entryPoint.replace('Bootstrap this cockpit', 'Bootstrap this synthetic cockpit') },
                { path: 'skills/cockpit-setup/procedures/setup.md', bytes: procedure },
                ...(additionalSkill ? [
                    { path: 'skills/inspect/SKILL.md', bytes: entryPoint.replace('name: cockpit-setup', 'name: inspect') },
                    { path: 'skills/inspect/procedures/setup.md', bytes: procedure },
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
            expect(generatedApplicationProjection({ ...synced.result.application })).toBeUndefined()
            await writeFile(fixture.configPath, pinnedConfig)
            const pinned = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(pinned, JSON.stringify(pinned.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(pinned.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'OVERRIDDEN_CORE_CHANGED' }))
        }, 120_000)

        it('projects the authenticated surface manifest without issuing cloned authority', async () => {
            const fixture = await surfaceConsumer('surface-manifest', { rules: true })
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synced.kind).toBe('complete')
            if (synced.kind !== 'complete') throw new Error('surface manifest producer refused')
            const application = generatedApplicationProjection(synced.result.application)
            expect(application).toBe(synced.result.application)
            expect(generatedApplicationProjection({ ...application })).toBeUndefined()
            const projection = application!.surfaceManifest
            const { schema, configuredHarnesses, entries } = projection
            expect(projection.manifestSha256).toBe(createHash('sha256').update(JSON.stringify({ schema, configuredHarnesses, entries })).digest('hex'))
            // The exact command of cockpit's own Claude Code registration stays the same across releases.
            const settings = entries.find(entry => entry.path === '.claude/settings.json')
            expect(settings?.kind === 'file' && JSON.stringify(JSON.parse(settings.bytes).hooks.PreToolUse)).toContain('/.cockpit/guards/check.sh')
            expect(configuredHarnesses).toEqual([...DEFAULT_SURFACE_TOOLS].sort())
            const checked = await checkGeneratedEnvironment({ configPath: fixture.configPath })
            expect(checked.kind).toBe('complete')
            if (checked.kind !== 'complete') throw new Error('surface manifest check refused')
            expect(checked.result.application.surfaceManifest).toEqual(projection)
        }, 180_000)

        it('reconciles generated whole files and copied sibling guides and removes exact stale ownership', async () => {
            const first = await surfaceConsumer('surface-reconcile', { rules: true, custom: `\n${WITH_CURSOR}` })

            const synced = await syncGeneratedEnvironment({ configPath: first.configPath })
            expect(synced).toMatchObject({ kind: 'complete' })
            if (synced.kind !== 'complete') return
            const cursorFiles = synced.result.paths.filter(path => path.startsWith('.cursor/'))
            const cursorFile = cursorFiles[0]!
            expect(synced.result.paths).toEqual(expect.arrayContaining([cursorFile, 'AGENTS.md']))
            expect(synced.result.paths.some(path => path.startsWith('.sibling-'))).toBe(false)
            const cursorBytes = await readFile(join(first.root, cursorFile))
            expect(await readFile(join(first.root, 'AGENTS.md'), 'utf8')).toContain('## Instructions for sibling `app` (its AGENTS.md)')
            const ledger = await ownership(first.root)
            const reconciledPaths = new Set([cursorFile])
            const reconciledOwnership = (ledger.entries as readonly { path: string }[])
                .filter(({ path }) => reconciledPaths.has(path))
            expect(ledger).toMatchObject({ format: 'cockpit-generated-ownership/v3' })
            expect(JSON.stringify(ledger)).toContain(cursorFile)
            expect((await readdir(join(first.root, '.cockpit'))).filter((path) => path.includes('ownership'))).toEqual([
                'generated-environment-ownership.json',
            ])

            await rm(join(first.root, cursorFile))
            await expect(lstat(join(first.root, cursorFile))).rejects.toMatchObject({ code: 'ENOENT' })
            const repaired = await syncGeneratedEnvironment({ configPath: first.configPath })
            expect(repaired, JSON.stringify(repaired.diagnostics)).toMatchObject({ kind: 'complete' })
            await expect(readFile(join(first.root, cursorFile))).resolves.toEqual(cursorBytes)
            const repairedLedger = await ownership(first.root)
            expect((repairedLedger.entries as readonly { path: string }[]).filter(({ path }) => reconciledPaths.has(path)))
                .toEqual(reconciledOwnership)
            expect(JSON.stringify(repairedLedger)).not.toContain(first.root)

            // The guide is the sibling team's file, and what every agent session loads: its edit makes
            // check name the stale copy until a person syncs, and the copy names no machine path, so a
            // clone of the whole workspace at another path stays current.
            await writeFile(join(first.root, 'app/AGENTS.md.next'), 'Synthetic sibling guide.\nA rule from a checkout.\n')
            await rename(join(first.root, 'app/AGENTS.md.next'), join(first.root, 'app/AGENTS.md'))
            expect(await checkGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({
                    code: 'GENERATED_ARTIFACT_DRIFT', target: 'AGENTS.md', message: expect.stringContaining('app/AGENTS.md') })],
            })
            expect(await syncGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(first.root, 'AGENTS.md'), 'utf8')).toContain('A rule from a checkout.')
            expect(await checkGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({ kind: 'complete' })
            const clone = `${first.root}-clone`
            await rename(first.root, clone)
            try {
                const cloned = await checkGeneratedEnvironment({ configPath: join(clone, basename(first.configPath)) })
                expect(cloned, JSON.stringify(cloned.diagnostics)).toMatchObject({ kind: 'complete' })
            } finally {
                await rename(clone, first.root)
            }

            const withoutSurfaces = withoutCursor(await readFile(first.configPath, 'utf8'))
                .replace('guides = ["AGENTS.md"]', 'guides = []')
            await writeFile(first.configPath, withoutSurfaces)
            // A stale file stays until sync removes it, so check names sync.
            expect(await checkGeneratedEnvironment({ configPath: first.configPath })).toMatchObject({ kind: 'refusal',
                diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' })] })
            let staleApprovalRequest: GeneratedStaleRemovalApprovalRequest | undefined
            const removed = await syncGeneratedEnvironment({ configPath: first.configPath }, {
                authorizeStaleRemoval: async request => {
                    staleApprovalRequest = request
                    return Object.freeze({ format: 'cockpit-stale-removal-approval/v1', digest: request.digest })
                },
            })
            expect(removed, JSON.stringify(removed.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(staleApprovalRequest?.entries.map(entry => entry.path).sort()).toEqual([...cursorFiles].sort())
            expect(staleApprovalRequest?.entries).toContainEqual(expect.objectContaining({ path: cursorFile, current: expect.objectContaining({ kind: 'file', sha256: digest(cursorBytes) }) }))
            for (const path of cursorFiles) await expect(lstat(join(first.root, path))).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await readFile(join(first.root, 'AGENTS.md'), 'utf8')).not.toContain('Instructions for sibling `app`')
        }, 180_000)

        it('keeps an active in-repo sibling runnable without projecting root instruction files into themselves', async () => {
            const fixture = await surfaceConsumer('in-repo-active-sibling')
            await mkdir(join(fixture.root, 'docs'))
            await writeFile(join(fixture.root, 'docs/CONVENTIONS.md'), 'Synthetic product conventions.\n')
            const declaration = await readFile(fixture.configPath, 'utf8')
            const declare = (guides: string) => writeFile(fixture.configPath, declaration
                .replace('dir = "app"', 'dir = "."')
                .replace('guides = ["AGENTS.md"]', `guides = ${guides}`))
            // A misspelled guide copies nothing, so it is refused rather than skipped like an absent default.
            await declare('["CLAUDE.md", "AGENTS.md", "docs/CONVENTONS.md"]')
            for (const result of [await syncGeneratedEnvironment({ configPath: fixture.configPath }), await checkGeneratedEnvironment({ configPath: fixture.configPath })]) {
                expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
                    code: 'SIBLING_GUIDE_MISSING', target: 'sibling.app.guides', message: expect.stringContaining('docs/CONVENTONS.md') })] })
            }
            await declare('["CLAUDE.md", "AGENTS.md", "docs/CONVENTIONS.md"]')

            const first = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })

            const rootGuide = await readFile(join(fixture.root, 'AGENTS.md'), 'utf8')
            expect(rootGuide).toContain('## Instructions for sibling `app` (its docs/CONVENTIONS.md)')
            expect(rootGuide).toContain('Synthetic product conventions.')
            expect(rootGuide).not.toContain('(its AGENTS.md)')
            expect(rootGuide).not.toContain('(its CLAUDE.md)')
            expect(parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8'))).toEqual({
                sandbox_mode: 'workspace-write',
                sandbox_workspace_write: { writable_roots: ['..'] },
            })
        }, 180_000)

        it('refuses changed stale ownership and preserves consumer bytes', async () => {
            const changed = await surfaceConsumer('surface-stale-changed', { custom: WITH_CURSOR })
            const synced = await syncGeneratedEnvironment({ configPath: changed.configPath })
            expect(synced).toMatchObject({ kind: 'complete' })
            if (synced.kind !== 'complete') return
            const cursorFile = synced.result.paths.find(path => path.startsWith('.cursor/'))!
            await writeFile(changed.configPath, withoutCursor(await readFile(changed.configPath, 'utf8')))
            await writeFile(join(changed.root, cursorFile), 'consumer bytes\n')
            expect(await syncGeneratedEnvironment({ configPath: changed.configPath })).toMatchObject({
                kind: 'refusal', diagnostics: [expect.objectContaining({ target: cursorFile })],
            })
            expect(await readFile(join(changed.root, cursorFile), 'utf8')).toBe('consumer bytes\n')
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
                // cockpit owns `permission`; a team's own key with that name is ambiguous ownership.
                ['opencode.jsonc', '{"permission":{}}\n'],
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
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))
            await writeFile(join(siblingRoot, 'sentinel.txt'), 'outside bytes\n')
            const initial = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(initial, JSON.stringify(initial.diagnostics)).toMatchObject({ kind: 'complete' })
            if (initial.kind !== 'complete') return
            const authored = await bytes(fixture.root, initial.result.paths)
            const ledgerPath = join(fixture.root, '.cockpit/generated-environment-ownership.json')
            const ledger = await readFile(ledgerPath, 'utf8')
            // A new guarded host changes the generated guards, so sync has a publication to prepare.
            const guarded = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            guarded.guards.vendor_endpoint_hosts = [...guarded.guards.vendor_endpoint_hosts, 'second.vendor.example.test']
            await writeFile(fixture.configPath, stringifyToml(guarded))
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
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))

            const initial = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(initial, JSON.stringify(initial.diagnostics)).toMatchObject({ kind: 'complete' })
            if (initial.kind !== 'complete') return
            const authored = await bytes(fixture.root, initial.result.paths)
            // A new guarded host changes the generated guards, so sync has a publication to prepare.
            const guarded = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            guarded.guards.vendor_endpoint_hosts = [...guarded.guards.vendor_endpoint_hosts, 'second.vendor.example.test']
            await writeFile(fixture.configPath, stringifyToml(guarded))
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
