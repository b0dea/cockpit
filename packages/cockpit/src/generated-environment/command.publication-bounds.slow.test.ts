import { readFile, writeFile, rename, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { cleanup, publicationGroups, consumer, skillSurfaces, customHarness, unavailableCustomHarness,
    surfaceConsumer, writeCustomModule, ownership, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
describe('public surface publication transaction', () => {
        it('refuses an infeasible publication schedule before preparation', async () => {
            const fixture = await surfaceConsumer('publication-schedule-bound', {
                custom: customHarness('adapters/synthetic.mjs', 'renderRules', 'custom/entry-00/output.md'),
            })
            await writeCustomModule(fixture.root, Array.from({ length: 50 }, (_, index) => ({
                path: `custom/entry-${String(index).padStart(2, '0')}/output.md`, bytes: 'bounded synthetic output\n',
            })))
            let preparations = 0
            const result = await syncGeneratedEnvironment({ configPath: fixture.configPath }, {
                execute: async step => {
                    if (step.labels.action === 'prepare-batch') preparations += 1
                    return executeProbe(step)
                },
            })
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
            expect(preparations).toBe(0)
            expect(await readFile(join(fixture.root, 'unmanaged.txt'), 'utf8')).toBe('keep\n')
            await expect(lstat(join(fixture.root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('publishes shipped and extension skills within the bounded sequential schedule', async () => {
            const fixture = await surfaceConsumer('extension-skill-publication', {
                custom: await skillSurfaces(['alpha', 'beta', 'zeta']),
            })

            const result = await syncGeneratedEnvironment({ configPath: fixture.configPath })

            expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ kind: 'complete' })
            if (result.kind !== 'complete') return
            expect(result.result.paths).toEqual(expect.arrayContaining([
                '.agents/skills/alpha/SKILL.md',
                '.agents/skills/beta/SKILL.md',
                '.agents/skills/zeta/SKILL.md',
            ]))
        })

        it('restores prior outputs after the forward publication deadline expires', async () => {
            const fixture = await consumer('forward-deadline')
            const initial = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(initial.kind).toBe('complete')
            if (initial.kind !== 'complete') return
            const ledgerPath = join(fixture.root, '.cockpit/generated-environment-ownership.json')
            const ledger = await readFile(ledgerPath)
            const before = await bytes(fixture.root, initial.result.paths)
            await writeFile(fixture.configPath, (await readFile(fixture.configPath, 'utf8'))
                .replace('purpose = "Synthetic application"', 'purpose = "Second synthetic application"'))
            const realNow = Date.now
            let advanced: number | undefined
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => advanced ?? realNow())
            const prepareDeadlines: number[] = []
            let preparedGroups = 0
            let rollbacks = 0
            let published = false
            try {
                const result = await syncGeneratedEnvironment({ configPath: fixture.configPath }, {
                    execute: async step => {
                        const outcome = await executeProbe(step)
                        if (step.labels.action === 'prepare-batch') {
                            if (!step.spawnNotAfter) throw new Error('publication preparation deadline is missing')
                            prepareDeadlines.push(Date.parse(step.spawnNotAfter))
                            preparedGroups += publicationGroups(step, 'prepare').length
                        }
                        if (step.labels.action === 'rollback') rollbacks += 1
                        if (!published && publicationGroups(step, 'publish').length > 0) {
                            if (!step.spawnNotAfter) throw new Error('publication deadline is missing')
                            // These few groups prepare in one call and publish in one call that spends
                            // the same number of forward slots as the commit call still ahead of it. So
                            // the forward cutoff lies as far after this deadline as preparation lay before it.
                            expect(prepareDeadlines).toHaveLength(1)
                            const publishDeadline = Date.parse(step.spawnNotAfter)
                            advanced = 2 * publishDeadline - prepareDeadlines[0]! + 1
                            published = true
                        }
                        return outcome
                    },
                })
                expect(published).toBe(true)
                expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
                expect(rollbacks).toBe(preparedGroups)
                expect(await bytes(fixture.root, initial.result.paths)).toEqual(before)
                expect(await readFile(ledgerPath)).toEqual(ledger)
            } finally {
                clock.mockRestore()
            }
        })

        it('keeps formatted empty OpenCode outside bytes stable across sync and check', async () => {
            const fixture = await surfaceConsumer('formatted-empty-opencode', { rules: true })
            const path = join(fixture.root, 'opencode.jsonc')
            const outside = '\n  }\n'
            await writeFile(path, `{${outside}`)
            const first = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete' })
            if (first.kind !== 'complete') return
            const published = await readFile(path, 'utf8')
            expect(published.endsWith(outside)).toBe(true)
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(path, 'utf8')).toBe(published)
        })

        it('refuses generated Markdown ownership delimiters before publication', async () => {
            for (const marker of ['<!-- cockpit:instructions:start -->', '<!-- cockpit:instructions:end -->']) {
                const fixture = await surfaceConsumer('markdown-delimiter', {
                    custom: customHarness('adapters/synthetic.mjs', 'renderRules', 'AGENTS.md'),
                })
                const existing = 'consumer instructions\n'
                await writeFile(join(fixture.root, 'AGENTS.md'), existing)
                await writeCustomModule(fixture.root, [{ path: 'AGENTS.md', bytes: `${marker}\n` }])
                let preparations = 0
                const result = await syncGeneratedEnvironment({ configPath: fixture.configPath }, {
                    execute: async step => {
                        if (step.labels.action === 'prepare-batch') preparations += 1
                        return executeProbe(step)
                    },
                })
                expect(result).toMatchObject({ kind: 'refusal' })
                expect(preparations).toBe(0)
                expect(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8')).toBe(existing)
                await expect(lstat(join(fixture.root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
            }
        })

        it('round-trips mixed-case custom paths and scoped ownership', async () => {
            const fixture = await surfaceConsumer('custom-order-scope', {
                custom: customHarness('adapters/synthetic.mjs', 'renderRules', 'custom/a.md'),
            })
            await writeCustomModule(fixture.root, [
                { path: 'custom/a.md', bytes: 'lower\n', scope: 'scoped' },
                { path: 'custom/Z.md', bytes: 'upper\n', scope: 'scoped' },
            ])
            const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
            if (synchronized.kind !== 'complete') return
            expect(synchronized.result.paths.filter(path => path.startsWith('custom/'))).toEqual(['custom/Z.md', 'custom/a.md'])
            const ledger = await ownership(fixture.root)
            expect(ledger).toMatchObject({ entries: expect.arrayContaining([
                expect.objectContaining({ path: 'custom/Z.md', scope: 'scoped' }),
                expect.objectContaining({ path: 'custom/a.md', scope: 'scoped' }),
            ]) })
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await bytes(fixture.root, ['custom/Z.md', 'custom/a.md'])).toEqual({
                'custom/Z.md': 'upper\n', 'custom/a.md': 'lower\n',
            })
        })

        it('revalidates a shared module for each custom harness', async () => {
            const module = 'adapters/synthetic.mjs'
            const fixture = await surfaceConsumer('custom-shared-module', { custom:
                customHarness(module, 'renderRules', 'custom/first.md')
                    + customHarness(module, 'renderSecond', 'custom/second.md').replace('name = "synthetic-harness"', 'name = "other-harness"'),
            })
            const modulePath = join(fixture.root, await writeCustomModule(fixture.root, [{ path: 'custom/first.md', bytes: 'shared\n' }]))
            const original = await readFile(modulePath, 'utf8')
            await writeFile(modulePath, original + original.replace('renderRules', 'renderSecond')
                .replace('"synthetic-harness"', '"other-harness"').replace('custom/first.md', 'custom/second.md'))

            let moduleReads = 0
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath }, {
                execute: async step => {
                    if (step.labels.action === 'read-file' || step.labels.action === 'read-batch') {
                        const request = JSON.parse(step.argv[3]!) as { name?: string; entries?: Array<{ action: string; name: string }> }
                        moduleReads += step.labels.action === 'read-file' ? Number(request.name === 'synthetic.mjs')
                            : (request.entries ?? []).filter(entry => entry.action === 'read-file' && entry.name === 'synthetic.mjs').length
                    }
                    return executeProbe(step)
                },
            })).toMatchObject({ kind: 'complete' })
            expect(moduleReads).toBe(8)
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await bytes(fixture.root, ['custom/first.md', 'custom/second.md'])).toEqual({
                'custom/first.md': 'shared\n', 'custom/second.md': 'shared\n',
            })
        })

        it('authenticates custom modules and does not import unavailable cells', async () => {
            const missing = await surfaceConsumer('custom-missing', { custom: customHarness('adapters/synthetic.mjs') })
            await writeCustomModule(missing.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\n' }], 'otherExport')
            const inert = await surfaceConsumer('custom-inert', { custom: customHarness('adapters/synthetic.mjs') })
            await writeCustomModule(inert.root, [])
            const unavailable = await surfaceConsumer('custom-unavailable', { custom: unavailableCustomHarness() })
            const raced = await surfaceConsumer('custom-race', { custom: customHarness('adapters/synthetic.mjs') })
            const racedModule = join(raced.root, await writeCustomModule(raced.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\n' }]))
            let replaced = false

            const outcomes = await Promise.all([
                syncGeneratedEnvironment({ configPath: missing.configPath }),
                syncGeneratedEnvironment({ configPath: inert.configPath }),
                syncGeneratedEnvironment({ configPath: unavailable.configPath }),
                syncGeneratedEnvironment({ configPath: raced.configPath }, {
                    execute: async (step) => {
                        const invokesModule = step.consumedFiles.some((file) => file.path === racedModule)
                        const outcome = await executeProbe(step)
                        if (invokesModule && !replaced) {
                            replaced = true
                            const original = await readFile(racedModule)
                            await rename(racedModule, `${racedModule}.held`)
                            await writeFile(racedModule, original)
                        }
                        return outcome
                    },
                }),
            ])
            expect(outcomes.map(({ kind }) => kind)).toEqual(['refusal', 'refusal', 'complete', 'refusal'])
            expect(replaced).toBe(true)
            for (const control of [missing, inert, raced]) {
                await expect(lstat(join(control.root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
            }
            await expect(lstat(join(unavailable.root, 'custom/rules.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('preflights combined output bounds before publication', async () => {
            const module = 'adapters/synthetic.mjs'
            const bounded = await surfaceConsumer('combined-bound', { custom: customHarness(module, 'renderRules', 'custom/rules-000.md') })
            await writeCustomModule(bounded.root, Array.from({ length: 253 }, (_, index) => ({
                path: `custom/rules-${String(index).padStart(3, '0')}.md`, bytes: `custom rule ${index}\n`,
            })))
            expect(await syncGeneratedEnvironment({ configPath: bounded.configPath })).toMatchObject({ kind: 'refusal' })
            await expect(lstat(join(bounded.root, 'custom/rules-000.md'))).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(lstat(join(bounded.root, '.cockpit/generated-environment-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('compensates both estates on source change', async () => {
            const module = 'adapters/synthetic.mjs'
            // The Compose override is the generated estate; the custom harness output is the surface estate.
            const compensated = await surfaceConsumer('cross-estate-compensation', { rules: true,
                custom: `${customHarness(module)}\n[environment]\ncompose_files = ["compose.yml"]\n` })
            const compose = join(compensated.root, 'compose.yml')
            await writeFile(compose, `services:\n  app:\n    image: node@sha256:${'8'.repeat(64)}\n    volumes: ["./app:/app"]\n`)
            await writeCustomModule(compensated.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\nfirst\n' }])
            expect(await syncGeneratedEnvironment({ configPath: compensated.configPath })).toMatchObject({ kind: 'complete' })
            const observed = await bytes(compensated.root, ['compose.cockpit.yml', 'custom/rules.md'])
            const ledger = await readFile(join(compensated.root, '.cockpit/generated-environment-ownership.json'), 'utf8')
            await writeFile(compose, `${await readFile(compose, 'utf8')}  worker:\n    image: node@sha256:${'9'.repeat(64)}\n`)
            await writeCustomModule(compensated.root, [{ path: 'custom/rules.md', bytes: 'custom/rules.md\nsecond\n' }])
            let sourceChanged = false
            const refused = await syncGeneratedEnvironment({ configPath: compensated.configPath }, {
                execute: async (step) => {
                    const outcome = await executeProbe(step)
                    if (!sourceChanged && publicationGroups(step, 'publish').length > 0) {
                        sourceChanged = true
                        await writeFile(join(compensated.siblingDirectory, 'AGENTS.md'), 'Changed during publication.\n')
                    }
                    return outcome
                },
            })
            expect(sourceChanged).toBe(true)
            expect(refused).toMatchObject({ kind: 'refusal' })
            expect(await bytes(compensated.root, Object.keys(observed))).toEqual(observed)
            expect(await readFile(join(compensated.root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(ledger)
        })
})
})
