import { readFile, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { cleanup, publicationGroups, consumer, skillSurfaces, surfaceConsumer, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
describe('public surface publication transaction', () => {
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
                const fixture = await surfaceConsumer('markdown-delimiter', { custom: `
    [[surfaces.overlays]]
    name = "delimiter-rules"
    feature = "rules"
    source = "surfaces/delimiter-rules.json"
    sources = [{ path = "rules/delimiter.md", bytes = ${JSON.stringify(`${marker}
`)} }]
    ` })
                const existing = 'consumer instructions\n'
                await writeFile(join(fixture.root, 'AGENTS.md'), existing)
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

        it('compensates both estates on source change', async () => {
            // The Compose override is the generated estate; the copied sibling guide in AGENTS.md is the surface estate.
            const compensated = await surfaceConsumer('cross-estate-compensation', { rules: true,
                custom: '\n[environment]\ncompose_files = ["compose.yml"]\n' })
            const compose = join(compensated.root, 'compose.yml')
            await writeFile(compose, `services:\n  app:\n    image: node@sha256:${'8'.repeat(64)}\n    volumes: ["./app:/app"]\n`)
            expect(await syncGeneratedEnvironment({ configPath: compensated.configPath })).toMatchObject({ kind: 'complete' })
            const observed = await bytes(compensated.root, ['compose.cockpit.yml', 'AGENTS.md'])
            const ledger = await readFile(join(compensated.root, '.cockpit/generated-environment-ownership.json'), 'utf8')
            await writeFile(compose, `${await readFile(compose, 'utf8')}  worker:\n    image: node@sha256:${'9'.repeat(64)}\n`)
            await writeFile(join(compensated.siblingDirectory, 'AGENTS.md'), 'Second synthetic sibling guide.\n')
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
