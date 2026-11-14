import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import * as surfaceGenerator from '../surfaces/generator-adapter.js'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { publicationCockpitId } from './identity.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')
const roots: string[] = []

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function digest(bytes: string): string {
    return createHash('sha256').update(bytes).digest('hex')
}

async function plainConsumer(name: string): Promise<{ root: string; configPath: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `cockpit-ownership-${name}-`)))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    await writeFile(configPath, (await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    ))
    return { root, configPath }
}

describe('generated ownership admission', () => {
    it.each([
        { name: 'missing ledger preview', existing: false, dryRun: true, replaceIdentity: false },
        { name: 'changed ledger preview', existing: true, dryRun: true, replaceIdentity: false },
        { name: 'changed ledger publication', existing: true, dryRun: false, replaceIdentity: false },
        { name: 'same-byte replacement publication', existing: true, dryRun: false, replaceIdentity: true },
    ])('preserves observed ownership during $name', async ({ existing, dryRun, replaceIdentity }) => {
        const generation = vi.spyOn(surfaceGenerator, 'generateSurfaceEstate')
        const { root, configPath } = await plainConsumer('race')
        const ledgerPath = join(root, '.cockpit/generated-environment-ownership.json')
        await mkdir(join(root, '.cockpit'), { recursive: true })
        let initialBytes = ''
        if (existing) {
            const sourceSha256 = digest(await readFile(configPath, 'utf8'))
            initialBytes = encodeOwnershipManifest({
                root, configPath, cockpitId: publicationCockpitId({ name: 'generated-environment' }),
                generation: digest(`generated-environment\0${sourceSha256}`), sourceSha256,
                owned: [], surfaces: [],
            }).bytes
            await writeFile(ledgerPath, initialBytes)
        }
        const initialIdentity = existing ? await lstat(ledgerPath) : undefined
        const consumerBytes = replaceIdentity ? initialBytes : 'consumer-owned metadata\n'
        let changed = false
        let admissionReads = 0
        let prepared = 0
        let rollbacks = 0
        let publications = 0
        let expectedLedger: unknown
        let replacementInode: number | undefined
        const result = await syncGeneratedEnvironment({ configPath, dryRun }, {
            execute: async step => {
                const action = step.labels.action
                const request = (action ? JSON.parse(step.argv[3]!) : {}) as {
                    name?: string
                    groups?: Array<{ entries: Array<{ name: string; expected: unknown }> }>
                }
                if (step.cwd === root && action === 'read-entry'
                    && request.name === 'generated-environment-ownership.json') admissionReads += 1
                if (action === 'prepare-batch') {
                    prepared += 1
                    const ledger = request.groups?.flatMap(group => group.entries).find(entry => entry.name === 'generated-environment-ownership.json')
                    if (ledger) expectedLedger = ledger.expected
                }
                if (action === 'rollback') rollbacks += 1
                if (action === 'publish-batch') publications += 1
                const outcome = await executeProbe(step)
                if (outcome.kind === 'complete' && !changed && step.cwd === root && action === 'read-file'
                    && request.name === 'generated-environment-ownership.json') {
                    if (replaceIdentity) {
                        await writeFile(`${ledgerPath}.replacement`, consumerBytes)
                        await rename(`${ledgerPath}.replacement`, ledgerPath)
                    } else await writeFile(ledgerPath, consumerBytes)
                    replacementInode = (await lstat(ledgerPath)).ino
                    changed = true
                }
                return outcome
            },
        })

        expect(changed, JSON.stringify(result)).toBe(true)
        expect(generation).not.toHaveBeenCalled()
        expect(admissionReads, JSON.stringify(result)).toBe(1)
        expect(result).toMatchObject({
            kind: 'refusal',
            status: 2,
            diagnostics: [{
                severity: 'error',
                code: 'GENERATED_OWNERSHIP_INVALID',
                message: 'generated ownership metadata changed after observation',
                target: '.cockpit/generated-environment-ownership.json',
            }],
        })
        expect(await readFile(ledgerPath, 'utf8')).toBe(consumerBytes)
        expect((await lstat(ledgerPath)).ino).toBe(replacementInode)
        expect(publications).toBe(0)
        expect(expectedLedger).toBeUndefined()
        expect(prepared).toBe(0)
        expect(rollbacks).toBe(0)
        if (replaceIdentity) expect(replacementInode).not.toBe(initialIdentity!.ino)
    })

    it('refuses ownership changes after preflight during final admission', async () => {
        const { root, configPath } = await plainConsumer('final-admission')
        const generation = vi.spyOn(surfaceGenerator, 'generateSurfaceEstate')
        const ledgerPath = join(root, '.cockpit/generated-environment-ownership.json')
        const sentinelBytes = 'consumer-owned metadata\n'
        let sentinelIdentity: { dev: number; ino: number } | undefined
        let admissionReads = 0
        let prepared = 0
        let publications = 0
        let rollbacks = 0
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                const action = step.labels.action
                const request = (action ? JSON.parse(step.argv[3]!) : {}) as { name?: string }
                if (action === 'prepare-batch') prepared += 1
                if (action === 'publish-batch') publications += 1
                if (action === 'rollback') rollbacks += 1
                const outcome = await executeProbe(step)
                if (step.cwd === root && action === 'read-entry'
                    && request.name === 'generated-environment-ownership.json') {
                    admissionReads += 1
                    expect(outcome.kind).toBe('complete')
                    const observation = JSON.parse(outcome.stdout.toString('utf8'))
                    if (admissionReads === 1) {
                        expect(observation).toMatchObject({ action: 'read-entry', kind: 'missing' })
                        expect(generation).not.toHaveBeenCalled()
                        await mkdir(join(root, '.cockpit'), { recursive: true })
                        await writeFile(ledgerPath, sentinelBytes)
                        const identity = await lstat(ledgerPath)
                        sentinelIdentity = { dev: identity.dev, ino: identity.ino }
                    } else {
                        expect(observation).toMatchObject({ action: 'read-entry', kind: 'file', sha256: digest(sentinelBytes) })
                        expect(generation).toHaveBeenCalledTimes(1)
                    }
                }
                return outcome
            },
        })

        expect(admissionReads, JSON.stringify(result)).toBe(2)
        expect(generation).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
            kind: 'refusal',
            status: 2,
            diagnostics: [{
                severity: 'error',
                code: 'GENERATED_OWNERSHIP_INVALID',
                message: 'generated ownership metadata changed after observation',
                target: '.cockpit/generated-environment-ownership.json',
            }],
        })
        expect(prepared).toBe(0)
        expect(publications).toBe(0)
        expect(rollbacks).toBe(0)
        expect(sentinelIdentity).toBeDefined()
        expect(await readFile(ledgerPath, 'utf8')).toBe(sentinelBytes)
        expect(await lstat(ledgerPath)).toMatchObject(sentinelIdentity!)
    })
})
