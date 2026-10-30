import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from '../generated-environment/command.js'
import { publicationRequestGroups, stagedPublicationInputs } from '../../test-support/generated-fixtures.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')
const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type BatchAction = 'publish-batch' | 'verify-batch' | 'commit-batch'

interface BatchEntry {
    readonly chain: readonly { readonly name: string }[]
    readonly name: string
    readonly backup?: string | null
    readonly priorSha256?: string | null
}

interface BatchGroup {
    readonly nonce: string
    readonly parent: string
    readonly identity: { readonly dev: number; readonly ino: number }
    readonly chain: readonly { readonly name: string; readonly dev: number; readonly ino: number }[]
    readonly entries: readonly BatchEntry[]
}

interface BatchRequest {
    readonly version: number
    readonly nonce: string
    readonly action: BatchAction
    readonly identity: { readonly dev: number; readonly ino: number }
    readonly groups: readonly BatchGroup[]
}

interface BatchRecord {
    readonly action: BatchAction
    readonly bytes: number
    readonly request: BatchRequest
}

async function consumer(name: string): Promise<{ root: string; configPath: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `cockpit-${name}-`)))
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

function rows(request: BatchRequest): readonly { parent: string; names: readonly string[] }[] {
    return request.groups.map(group => ({ parent: group.parent, names: group.entries.map(entry => entry.name) }))
}

describe('generated publication batching', () => {
    it('batches exact ordered publish, verify, and commit group coverage', async () => {
        const { configPath } = await consumer('publication-batch')
        const actions: string[] = []
        const prepared: Array<{ parent: string; names: readonly string[] }> = []
        const batches: BatchRecord[] = []
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                const action = step.labels.action
                if (action) actions.push(action)
                prepared.push(...publicationRequestGroups(step, 'prepare')
                    .map(group => ({ parent: group.parent, names: group.entries.map(entry => String(entry.name)) })))
                if (action === 'publish-batch' || action === 'verify-batch' || action === 'commit-batch') {
                    const requestBytes = step.argv[3]!
                    batches.push({ action, bytes: Buffer.byteLength(requestBytes), request: JSON.parse(requestBytes) })
                }
                return executeProbe(step)
            },
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
        // More groups than one request holds, so every group is checked before any is published or committed.
        expect(prepared.length).toBeGreaterThan(8)
        expect(actions).not.toContain('publish')
        expect(actions).not.toContain('verify')
        expect(actions).not.toContain('commit')
        for (const action of ['publish-batch', 'verify-batch', 'commit-batch'] as const) {
            const selected = batches.filter(batch => batch.action === action)
            expect(selected.length).toBeGreaterThan(0)
            expect(selected.length).toBeLessThan(prepared.length)
            expect(selected.flatMap(batch => rows(batch.request))).toEqual(prepared)
        }
        expect(actions.lastIndexOf('validate-batch')).toBeLessThan(actions.indexOf('publish-batch'))
        expect(actions.lastIndexOf('verify-batch')).toBeLessThan(actions.indexOf('commit-batch'))
        expect(batches.every(({ bytes, request }) => bytes <= 65_536
            && request.groups.length >= 1 && request.groups.length <= 8)).toBe(true)
        const rootIdentities = new Set(batches.map(({ request }) => JSON.stringify(request.identity)))
        expect(rootIdentities.size).toBe(1)
        for (const { action, request } of batches) {
            expect(Object.keys(request).sort()).toEqual(['action', 'groups', 'identity', 'limits', 'nonce', 'version'])
            expect(request).toMatchObject({ version: 1, action })
            expect(request.nonce).toMatch(/^[a-f0-9]{32}$/)
            expect(new Set(request.groups.map(group => group.nonce)).size).toBe(request.groups.length)
            for (const group of request.groups) {
                expect(Object.keys(group).sort()).toEqual(['chain', 'entries', 'identity', 'nonce', 'parent'])
                expect(group.nonce).toMatch(/^[a-f0-9]{32}$/)
                expect(group.entries.length).toBeGreaterThan(0)
                expect(group.chain.map(entry => entry.name).join('/') || '.').toBe(group.parent)
                expect(group.chain.at(-1) ?? request.identity).toMatchObject(group.identity)
            }
        }
    })

    it('awaits every bounded commit batch and retains recovery while one is unsettled', async () => {
        const { configPath } = await consumer('commit-batch-await')
        let active = 0
        let maximum = 0
        let commitBatches = 0
        let firstStarted!: () => void
        const started = new Promise<void>(resolveStarted => { firstStarted = resolveStarted })
        let releaseFirst!: () => void
        const released = new Promise<void>(resolveReleased => { releaseFirst = resolveReleased })
        let stagedInput: string | undefined
        let completed = false
        const syncing = syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (!stagedInput) {
                    stagedInput = stagedPublicationInputs(step)[0]
                    if (stagedInput) roots.push(dirname(stagedInput))
                }
                if (step.labels.action !== 'commit-batch') return executeProbe(step)
                commitBatches += 1
                active += 1
                maximum = Math.max(maximum, active)
                if (commitBatches === 1) {
                    firstStarted()
                    await released
                }
                try {
                    return await executeProbe(step)
                } finally {
                    active -= 1
                }
            },
        }).finally(() => { completed = true })

        await started
        let heldAssertion: unknown
        try {
            expect(completed).toBe(false)
            expect(stagedInput).toBeDefined()
            await expect(stat(stagedInput!)).resolves.toMatchObject({ isFile: expect.any(Function) })
            expect((await readdir(dirname(stagedInput!))).some(name => name.startsWith('recovery-'))).toBe(true)
        } catch (error) {
            heldAssertion = error
        } finally {
            releaseFirst()
        }
        const result = await syncing
        if (heldAssertion) throw heldAssertion

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
        expect(commitBatches).toBeGreaterThan(1)
        expect(maximum).toBe(1)
        expect(active).toBe(0)
        await expect(stat(stagedInput!)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('retains published recovery state when later batch construction throws', async () => {
        const { root, configPath } = await consumer('commit-batch-construction')
        const heldRoot = `${root}-held`
        roots.push(heldRoot)
        let moved = false
        let publishedGroups = 0
        let stagedInput: string | undefined
        let commitBatches = 0
        let rollbacks = 0
        let result: Awaited<ReturnType<typeof syncGeneratedEnvironment>>
        try {
            result = await syncGeneratedEnvironment({ configPath }, {
                execute: async step => {
                    if (!stagedInput) {
                        stagedInput = stagedPublicationInputs(step)[0]
                        if (stagedInput) roots.push(dirname(stagedInput))
                    }
                    if (step.labels.action === 'publish-batch') {
                        publishedGroups += (JSON.parse(step.argv[3]!) as BatchRequest).groups.length
                    }
                    if (step.labels.action === 'rollback') rollbacks += 1
                    if (step.labels.action === 'commit-batch') {
                        commitBatches += 1
                        const outcome = await executeProbe(step)
                        if (commitBatches === 1) {
                            expect(outcome.kind).toBe('complete')
                            if (outcome.kind !== 'complete') throw new Error('the first commit helper did not complete')
                            expect(JSON.parse(new TextDecoder().decode(outcome.stdout))).toMatchObject({ kind: 'complete', action: 'commit-batch' })
                            expect(publishedGroups).toBeGreaterThan((JSON.parse(step.argv[3]!) as BatchRequest).groups.length)
                            await rename(root, heldRoot)
                            moved = true
                        }
                        return outcome
                    }
                    return executeProbe(step)
                },
            })
        } finally {
            if (moved) await rename(heldRoot, root)
        }

        expect(commitBatches).toBe(1)
        expect(moved).toBe(true)
        expect(rollbacks).toBe(0)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_COMPENSATION_FAILED' })],
        })
        expect(stagedInput).toBeDefined()
        await expect(stat(stagedInput!)).resolves.toMatchObject({ isFile: expect.any(Function) })
        expect((await readdir(dirname(stagedInput!))).some(name => name.startsWith('recovery-'))).toBe(true)
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    })
})
