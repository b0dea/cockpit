import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'
import { publicationRequestGroups, stagedPublicationInputs } from '../../test-support/generated-fixtures.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')
const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function consumer(name: string): Promise<{ root: string; configPath: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `cockpit-nested-${name}-`)))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, (await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    ))
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    return { root, configPath }
}

describe('nested generated publication', () => {
    it('compacts only authenticated built-in surface parents without changing the published inventory', async () => {
        const { root, configPath } = await consumer('built-in')
        const parents: string[] = []
        const preparedPaths: string[] = []
        const committedParents: string[] = []

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                for (const group of publicationRequestGroups(step, 'prepare')) {
                    parents.push(group.parent)
                    const entries = group.entries as Array<{ chain?: Array<{ name: string }>; name: string; segments?: string[] }>
                    preparedPaths.push(...entries.map(entry => [group.parent === '.' ? '' : group.parent,
                        ...(entry.chain ?? []).map(row => row.name), ...(entry.segments ?? []), entry.name].filter(Boolean).join('/')))
                }
                if (step.labels.action === 'commit-batch') {
                    const request = JSON.parse(step.argv[3]!) as { groups: Array<{ parent: string }> }
                    committedParents.push(...request.groups.map(group => group.parent))
                }
                return executeProbe(step)
            },
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(parents).toEqual([
            '.', '.agents', '.agents/skills/cockpit-setup/references',
            '.claude', '.claude/skills/cockpit-setup/references', '.cockpit/guards',
            '.codex', '.codex/agents', '.opencode', '.opencode/plugin',
            '.opencode/skills/cockpit-setup/references',
            'app', 'docs/cockpit', 'env/.secrets', 'fixtures', '.cockpit',
        ])
        expect(committedParents).toEqual(parents)
        const publishedPaths = preparedPaths.filter(path => path !== '.cockpit/generated-environment-ownership.json')
        const presentPaths = await Promise.all(result.result.paths.map(async path => {
            await readFile(join(root, path))
            return path
        }))
        expect([...publishedPaths].sort()).toEqual(presentPaths.sort())
    })

    it('refuses a nested ancestor replacement and preserves the replacement', async () => {
        const { root, configPath } = await consumer('replacement')
        const held = join(root, '.agents-skills-held')
        const replacement = join(root, '.agents/skills')
        let replaced = false

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                const outcome = await executeProbe(step)
                if (!replaced && publicationRequestGroups(step, 'prepare').some(group => group.parent === '.cockpit')) {
                    await rename(replacement, held)
                    await mkdir(replacement)
                    await writeFile(join(replacement, 'sentinel'), 'replacement\n')
                    replaced = true
                }
                return outcome
            },
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_COMPENSATION_FAILED' })] })
        await expect(readFile(join(replacement, 'sentinel'), 'utf8')).resolves.toBe('replacement\n')
        await expect(access(held)).resolves.toBeUndefined()
    })

    it('removes shared request-created ancestors after a later staged input is corrupted', async () => {
        const { root, configPath } = await consumer('prepare-cleanup')
        let corrupted = false

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                const group = publicationRequestGroups(step, 'prepare').find(row => row.parent === '.agents')
                if (!corrupted && group) {
                    const input = [...group.entries].reverse().find(entry => entry.input !== null)?.input
                    if (typeof input === 'number') {
                        await writeFile(stagedPublicationInputs(step)[input]!, 'corrupted\n')
                        corrupted = true
                    }
                }
                return executeProbe(step)
            },
        })

        expect(corrupted).toBe(true)
        expect(result).toMatchObject({ kind: 'refusal' })
        await expect(access(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses a nested request and receipt pair forged at the execution boundary', async () => {
        const { root, configPath } = await consumer('forged-receipt')
        let forged = false
        let publishes = 0

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (step.labels.action === 'publish-batch') publishes += 1
                if (!forged && publicationRequestGroups(step, 'prepare').some(group => group.parent === '.agents')) {
                    const argv = [...step.argv]
                    const request = JSON.parse(argv[3]!) as { groups: Array<{ parent: string; entries: Array<{ segments: string[] }> }> }
                    const nested = request.groups.find(group => group.parent === '.agents')?.entries.find(entry => entry.segments.length > 0)?.segments
                    if (nested) {
                        nested[0] = '..'
                        argv[3] = JSON.stringify(request)
                        forged = true
                        return executeProbe(Object.freeze({ ...step, argv: Object.freeze(argv) as typeof step.argv }))
                    }
                }
                return executeProbe(step)
            },
        })

        expect(forged).toBe(true)
        expect(publishes).toBe(0)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
        await expect(access(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rolls back all compacted entries when a nested stage is corrupted', async () => {
        const { root, configPath } = await consumer('rollback')
        let corrupted = false

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (!corrupted && step.labels.action === 'publish-batch') {
                    const request = JSON.parse(step.argv[3]!) as {
                        groups: Array<{ parent: string; entries: Array<{ chain: Array<{ name: string }>; stage: string | null }> }>
                    }
                    const group = request.groups.find(row => row.parent === '.agents')
                    const entry = group?.entries.find(row => row.stage !== null)
                    if (group && entry?.stage) {
                        await writeFile(join(root, group.parent, ...entry.chain.map(row => row.name), entry.stage), 'corrupted\n')
                        corrupted = true
                    }
                }
                return executeProbe(step)
            },
        })

        expect(corrupted).toBe(true)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_PUBLICATION_FAILED' })] })
        await expect(access(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
