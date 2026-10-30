import { constants, type BigIntStats, type PathLike, type StatOptions, type Stats } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { readFile, readdir, rm, stat, symlink, writeFile, mkdir, rename, lstat, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { observeConfigSource } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { applyGeneratedEnvironmentRepair, checkGeneratedEnvironment, prepareGeneratedEnvironmentCurrentness, syncGeneratedEnvironment, syncTeamGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { roots, cleanup, publicationGroups, consumer, digest, ownership, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
    it('publishes a standalone directory without Git and refuses invalid enclosing Git metadata', async () => {
        const { root, configPath } = await consumer('standalone-identity')
        const previousPath = process.env.PATH
        process.env.PATH = root
        try {
            expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
            expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
            if (previousPath === undefined) delete process.env.PATH
            else process.env.PATH = previousPath
            await writeFile(join(root, '.git'), 'gitdir: missing-administration\n')
            const refused = await syncGeneratedEnvironment({ configPath })
            expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
                code: 'GENERATED_INPUT_INVALID', message: expect.stringContaining('checkout identity'),
            })] })
        } finally {
            if (previousPath === undefined) delete process.env.PATH
            else process.env.PATH = previousPath
        }
    })

    it('refuses a prepared publication when an enclosing Git anchor appears', async () => {
        const { root, configPath } = await consumer('identity-changed')
        const prepared = await prepareGeneratedEnvironmentCurrentness({ configPath })
        if (!prepared.repairAuthority) throw new Error('generated repair authority unavailable')
        await writeFile(join(root, '.git'), 'gitdir: missing-administration\n')
        expect(await applyGeneratedEnvironmentRepair(prepared.repairAuthority)).toMatchObject({
            kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })],
        })
        await expect(lstat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('keeps the restore command when team sync finds the configuration deleted', async () => {
        const { root, configPath } = await consumer('deleted-config')
        expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        await rm(configPath)
        const refused = await syncTeamGeneratedEnvironment({ configPath })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'CONFIG_NOT_FOUND', fix: `git -C ${root} restore -- cockpit.toml (it is committed), then retry`,
        })] })
    })

    it('rejects proxy command inputs without evaluating traps', async () => {
        let traps = 0
        const input = new Proxy({ configPath: 'unused.toml' }, {
            ownKeys(target) { traps += 1; return Reflect.ownKeys(target) },
            getOwnPropertyDescriptor(target, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(target, key) },
        })
        const results = await Promise.all([syncGeneratedEnvironment(input), syncTeamGeneratedEnvironment(input), checkGeneratedEnvironment(input)])
        expect(traps).toBe(0)
        expect(results).toEqual(results.map(() => expect.objectContaining({
            kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_INPUT_INVALID' })],
        })))
    })

    it('refuses a recomputed ownership ledger that claims an unrelated confined file', async () => {
        const { root, configPath } = await consumer('forged-ledger-stale-file')
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial, JSON.stringify(initial)).toMatchObject({ kind: 'complete' })
        if (initial.kind !== 'complete') return

        const unrelatedPath = 'README.md'
        const unrelatedBytes = '# Consumer documentation\n'
        await writeFile(join(root, unrelatedPath), unrelatedBytes)
        const prior = await ownership(root)
        if (!Array.isArray(prior.entries)) throw new Error('ownership entries are unavailable')
        const entries = [...prior.entries, {
            kind: 'file', path: unrelatedPath, ownership: 'whole-file', sha256: digest(unrelatedBytes),
        }].sort((left, right) => String(left.path) < String(right.path) ? -1 : String(left.path) > String(right.path) ? 1 : 0)
        const payload = {
            format: prior.format,
            cockpitId: prior.cockpitId,
            generation: prior.generation,
            source: prior.source,
            personaSource: prior.personaSource,
            producer: prior.producer,
            entries,
        }
        await writeFile(join(root, '.cockpit/generated-environment-ownership.json'), `${JSON.stringify({
            ...payload, integrity: digest(JSON.stringify(payload)),
        }, null, 2)}\n`)

        const preview = await syncGeneratedEnvironment({ configPath, dryRun: true })
        expect(preview).toMatchObject({
            kind: 'complete',
            result: {
                staleRemoval: {
                    format: 'cockpit-stale-removal-request/v1',
                    entries: [{
                        path: unrelatedPath,
                        operation: 'remove-file',
                        current: { kind: 'file', sha256: digest(unrelatedBytes) },
                    }],
                },
            },
        })
        if (preview.kind !== 'complete' || !preview.result.staleRemoval) return
        expect(preview.result.staleRemoval.digest).toMatch(/^[a-f0-9]{64}$/)

        let preparations = 0
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (step.labels.action === 'prepare') preparations += 1
                return executeProbe(step)
            },
        })

        expect(preparations).toBe(0)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_APPROVAL_REQUIRED', target: unrelatedPath })],
        })
        expect(await readFile(join(root, unrelatedPath), 'utf8')).toBe(unrelatedBytes)
    })

    it('refuses ownership aliases of authenticated inputs on case-insensitive filesystems', async (context) => {
        const { root, configPath } = await consumer('input-case-alias')
        const alias = join(root, 'Cockpit.toml')
        const originalIdentity = await lstat(configPath)
        let aliasIdentity: Awaited<ReturnType<typeof lstat>>
        try { aliasIdentity = await lstat(alias) } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                context.skip()
                return
            }
            throw error
        }
        expect(aliasIdentity.dev).toBe(originalIdentity.dev)
        expect(aliasIdentity.ino).toBe(originalIdentity.ino)
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return
        const prior = await ownership(root)
        const before = await bytes(root, initial.result.paths)
        const input = await readFile(configPath)
        if (!Array.isArray(prior.entries)) throw new Error('ownership entries are unavailable')
        const entries = [...prior.entries, {
            kind: 'file', path: 'Cockpit.toml', ownership: 'whole-file', sha256: digest(input),
        }].sort((left, right) => String(left.path) < String(right.path) ? -1 : String(left.path) > String(right.path) ? 1 : 0)
        const payload = { format: prior.format, cockpitId: prior.cockpitId, generation: prior.generation,
            source: prior.source, personaSource: prior.personaSource, producer: prior.producer, entries }
        await writeFile(join(root, '.cockpit/generated-environment-ownership.json'), JSON.stringify({
            ...payload, integrity: digest(JSON.stringify(payload)),
        }))
        let preparations = 0
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (step.labels.action === 'prepare') preparations += 1
                return executeProbe(step)
            },
        })
        expect(preparations).toBe(0)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_OWNERSHIP_INVALID', target: 'Cockpit.toml' })] })
        expect(await readFile(configPath)).toEqual(input)
        expect((await lstat(configPath)).ino).toBe(originalIdentity.ino)
        expect(await bytes(root, initial.result.paths)).toEqual(before)
    })

    for (const swap of ['input', 'root'] as const) {
        it(`refuses ownership alias checks during a restored ${swap} namespace swap`, async (context) => {
            const { root, configPath } = await consumer(`input-alias-${swap}-swap`)
            let aliasIdentity: Awaited<ReturnType<typeof lstat>>
            try { aliasIdentity = await lstat(join(root, 'Cockpit.toml')) } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    context.skip()
                    return
                }
                throw error
            }
            expect(aliasIdentity.ino).toBe((await lstat(configPath)).ino)
            const initial = await syncGeneratedEnvironment({ configPath })
            expect(initial.kind).toBe('complete')
            if (initial.kind !== 'complete') return
            const prior = await ownership(root)
            const input = await readFile(configPath)
            const before = await bytes(root, initial.result.paths)
            if (!Array.isArray(prior.entries)) throw new Error('ownership entries are unavailable')
            const entries = [...prior.entries, {
                kind: 'file', path: 'Cockpit.toml', ownership: 'whole-file', sha256: digest(input),
            }].sort((left, right) => String(left.path) < String(right.path) ? -1 : String(left.path) > String(right.path) ? 1 : 0)
            const payload = { format: prior.format, cockpitId: prior.cockpitId, generation: prior.generation,
                source: prior.source, personaSource: prior.personaSource, producer: prior.producer, entries }
            await writeFile(join(root, '.cockpit/generated-environment-ownership.json'), JSON.stringify({
                ...payload, integrity: digest(JSON.stringify(payload)),
            }))
            const originalLstat = fsPromises.lstat
            const originalOpen = fsPromises.open
            let swapped = false
            let aliasCheckStarted = false
            let preparations = 0
            function swappingLstat(path: PathLike, options?: StatOptions & { bigint?: false }): Promise<Stats>
            function swappingLstat(path: PathLike, options: StatOptions & { bigint: true }): Promise<BigIntStats>
            function swappingLstat(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>
            async function swappingLstat(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats> {
                if (!aliasCheckStarted || swapped || path !== configPath) return originalLstat(path, options)
                swapped = true
                const held = swap === 'input' ? `${configPath}.held` : `${root}-held`
                if (swap === 'root') roots.push(held)
                await rename(swap === 'input' ? configPath : root, held)
                if (swap === 'root') await mkdir(root)
                try {
                    await writeFile(configPath, 'temporary decoy\n')
                    return await originalLstat(path, options)
                } finally {
                    await rm(swap === 'input' ? configPath : root, { recursive: swap === 'root' })
                    await rename(held, swap === 'input' ? configPath : root)
                }
            }
            const spy = vi.spyOn(fsPromises, 'lstat').mockImplementation(swappingLstat)
            const opening = vi.spyOn(fsPromises, 'open').mockImplementation(async (...arguments_) => {
                const [path, flags] = arguments_
                if (path === root && typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0) aliasCheckStarted = true
                return originalOpen(...arguments_)
            })
            syncBuiltinESMExports()
            try {
                const result = await syncGeneratedEnvironment({ configPath }, {
                    execute: async step => {
                        if (step.labels.action === 'prepare') preparations += 1
                        return executeProbe(step)
                    },
                })
                expect(swapped).toBe(true)
                expect(preparations).toBe(0)
                expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_OWNERSHIP_INVALID' })] })
                expect(await readFile(configPath)).toEqual(input)
                expect(await bytes(root, initial.result.paths)).toEqual(before)
            } finally {
                spy.mockRestore()
                opening.mockRestore()
                syncBuiltinESMExports()
            }
        })
    }

    it('refuses a configured guide that appears after preparation', async () => {
        const { root, configPath } = await consumer('missing-guide-race')
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return
        const before = await bytes(root, initial.result.paths)
        const ledger = await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        let appeared = false
        let publications = 0
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                const outcome = await executeProbe(step)
                publications += publicationGroups(step, 'publish').length
                if (!appeared && step.labels.action === 'prepare' && step.labels.parent === '.cockpit') {
                    appeared = true
                    await writeFile(join(root, 'app/AGENTS.md'), 'New synthetic guide.\n')
                }
                return outcome
            },
        })
        expect(appeared).toBe(true)
        expect(publications).toBe(0)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })] })
        expect(await bytes(root, initial.result.paths)).toEqual(before)
        expect(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(ledger)
        expect(await readFile(join(root, 'app/AGENTS.md'), 'utf8')).toBe('New synthetic guide.\n')
    })

    it('retains backups when a prepared preimage changes identity and mode', async () => {
        const { root, configPath } = await consumer('rollback-preimage-identity')
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return
        const target = join(root, 'fixtures/personas.generated.ts')
        const before = await readFile(target, 'utf8')
        const originalIdentity = await lstat(target)
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        let replaced = false
        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async step => {
                if (replaced && step.labels.action === 'prepare' && step.labels.parent === '.cockpit') {
                    return executeProbe(Object.freeze({ ...step, cwd: root }))
                }
                const outcome = await executeProbe(step)
                if (!replaced && step.labels.action === 'prepare' && step.labels.parent === 'fixtures') {
                    replaced = true
                    await rename(target, join(root, 'fixtures/personas-held.ts'))
                    await writeFile(target, before, { mode: 0o400 })
                }
                return outcome
            },
        })
        expect(replaced).toBe(true)
        expect((await lstat(target)).ino).not.toBe(originalIdentity.ino)
        expect((await lstat(target)).mode & 0o777).toBe(0o400)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_COMPENSATION_FAILED' })] })
        const backups = (await readdir(join(root, 'fixtures'))).filter(name => name.startsWith('.cockpit-backup-'))
        expect(backups.length).toBeGreaterThan(0)
        expect(await readFile(join(root, 'fixtures', backups[0]!), 'utf8')).toBe(before)
        const recovery = result.diagnostics[0]?.target?.split('; inputs=')[1]
        expect(recovery).toBeDefined()
        if (recovery) roots.push(recovery)
        expect(await readFile(target, 'utf8')).toBe(before)
    })

    it('rejects oversized anchored entry output before reading it', async () => {
        const { root, configPath } = await consumer('entry-output-growth')
        const initial = await syncGeneratedEnvironment({ configPath })
        expect(initial.kind).toBe('complete')
        if (initial.kind !== 'complete') return
        const probe = await open(join(root, 'unmanaged.txt'), 'r')
        const prototype = Object.getPrototypeOf(probe)
        const originalReadFile = prototype.readFile
        let oversized: { dev: number; ino: number } | undefined
        let reads = 0
        const spy = vi.spyOn(prototype, 'readFile').mockImplementation(async function(this: typeof probe, ...args) {
            const identity = await this.stat()
            if (oversized && identity.dev === oversized.dev && identity.ino === oversized.ino) reads += 1
            return originalReadFile.apply(this, args)
        })
        let grew = false
        try {
            const result = await syncGeneratedEnvironment({ configPath }, {
                execute: async step => {
                    const outcome = await executeProbe(step)
                    const envelope = JSON.parse(step.argv[3]!)
                    const request = envelope.action === 'read-batch'
                        ? envelope.entries.find((entry: { action: string; name: string }) => entry.action === 'read-entry' && entry.name === 'compose.generated.yml')
                        : envelope
                    if (!grew && request?.action === 'read-entry' && request.name === 'compose.generated.yml') {
                        grew = true
                        await writeFile(request.output, Buffer.alloc(request.maxBytes + 1))
                        oversized = await lstat(request.output)
                    }
                    return outcome
                },
            })
            expect(grew).toBe(true)
            expect(reads).toBe(0)
            expect(result.kind).toBe('refusal')
            expect(await readFile(join(root, 'unmanaged.txt'), 'utf8')).toBe('keep\n')
        } finally {
            spy.mockRestore()
            await probe.close()
        }
    })

    it('refuses a persona source replaced with identical bytes before publication', async () => {
        const { root, configPath } = await consumer('persona-swap')
        const source = join(root, 'fixtures/personas.json')
        const held = join(root, 'fixtures/personas-held.json')
        let swapped = false
        const result = await syncGeneratedEnvironment({ configPath }, {
            observeSource: async (path) => {
                if (!swapped) {
                    swapped = true
                    const original = await readFile(source)
                    await rename(source, held)
                    await writeFile(source, original)
                }
                return observeConfigSource(path)
            },
        })
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED', target: 'fixtures/personas.json' })],
        })
        expect(swapped).toBe(true)
        await expect(stat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses a persona source larger than 16 MiB', async () => {
        const { root, configPath } = await consumer('persona-large')
        await writeFile(join(root, 'fixtures/personas.json'), JSON.stringify([{ id: 'x'.repeat(16_777_216) }]))
        const result = await syncGeneratedEnvironment({ configPath })
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_PERSONA_SOURCE_UNAVAILABLE', target: 'fixtures/personas.json' })],
        })
    })

    it('refuses a persona source whose parent was replaced with identical bytes', async () => {
        const { root, configPath } = await consumer('persona-parent-swap')
        const source = join(root, 'fixtures/personas.json')
        let swapped = false
        const result = await syncGeneratedEnvironment({ configPath }, {
            observeSource: async (path) => {
                if (!swapped) {
                    swapped = true
                    const original = await readFile(source)
                    await rename(join(root, 'fixtures'), join(root, 'fixtures-held'))
                    await mkdir(join(root, 'fixtures'))
                    await writeFile(source, original)
                }
                return observeConfigSource(path)
            },
        })
        expect(swapped).toBe(true)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED', target: 'fixtures/personas.json' })],
        })
        await expect(stat(join(root, 'compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses an ownership leaf replaced by a symlink before its anchored read', async () => {
        const { root, configPath } = await consumer('ownership-leaf-swap')
        expect((await syncGeneratedEnvironment({ configPath })).kind).toBe('complete')
        const ownership = join(root, '.cockpit/generated-environment-ownership.json')
        const held = join(root, '.cockpit/generated-environment-ownership-held.json')
        const outsideRoot = await mkdtemp(join(tmpdir(), 'cockpit-generated-ownership-leaf-outside-'))
        roots.push(outsideRoot)
        const outside = join(outsideRoot, 'ownership.json')
        await writeFile(outside, await readFile(ownership))
        let swapped = false

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                const request = JSON.parse(step.argv[3]!) as { action?: string; name?: string }
                if (!swapped && request.action === 'read-file' && request.name === 'generated-environment-ownership.json') {
                    swapped = true
                    await rename(ownership, held)
                    await symlink(outside, ownership)
                }
                return executeProbe(step)
            },
        })

        expect(swapped).toBe(true)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_OWNERSHIP_INVALID' })],
        })
    })

    it('refuses an ownership ancestor replaced by a symlink before its anchored read', async () => {
        const { root, configPath } = await consumer('ownership-parent-swap')
        expect((await syncGeneratedEnvironment({ configPath })).kind).toBe('complete')
        const cockpit = join(root, '.cockpit')
        const held = join(root, '.cockpit-held')
        const outside = await mkdtemp(join(tmpdir(), 'cockpit-generated-ownership-outside-'))
        roots.push(outside)
        await writeFile(join(outside, 'generated-environment-ownership.json'), await readFile(join(cockpit, 'generated-environment-ownership.json')))
        let swapped = false

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                const request = JSON.parse(step.argv[3]!) as { action?: string; name?: string }
                if (!swapped && request.action === 'read-file' && request.name === 'generated-environment-ownership.json') {
                    swapped = true
                    await rename(cockpit, held)
                    await symlink(outside, cockpit)
                }
                return executeProbe(step)
            },
        })

        expect(swapped).toBe(true)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_OWNERSHIP_INVALID' })],
        })
    })

    it('refuses an oversized generated artifact without reading it into memory', async () => {
        const { root, configPath } = await consumer('generated-oversize')
        expect((await syncGeneratedEnvironment({ configPath })).kind).toBe('complete')
        await writeFile(join(root, 'compose.generated.yml'), Buffer.alloc(16_777_217, 0x20))

        const result = await checkGeneratedEnvironment({ configPath })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_MISSING', target: 'compose.generated.yml' })],
        })
    })

    it('refuses a stale artifact that grows before its descriptor-anchored read', async () => {
        const { root, configPath } = await consumer('stale-growth')
        expect((await syncGeneratedEnvironment({ configPath })).kind).toBe('complete')
        const declaration = await readFile(configPath, 'utf8')
        await writeFile(configPath, declaration.replace(
            'path = "fixtures/personas.generated.ts"',
            'path = "fixtures/personas.generated.json"',
        ).replace('format = "typescript"', 'format = "json"'))
        let grew = false

        const result = await syncGeneratedEnvironment({ configPath }, {
            execute: async (step) => {
                const envelope = JSON.parse(step.argv[3]!) as { action?: string; name?: string; entries?: Array<{ action: string; name: string }> }
                const request = envelope.action === 'read-batch'
                    ? envelope.entries?.find(entry => entry.action === 'read-entry' && entry.name === 'personas.generated.ts')
                    : envelope
                if (!grew && request?.action === 'read-entry' && request.name === 'personas.generated.ts') {
                    grew = true
                    await writeFile(join(root, 'fixtures/personas.generated.ts'), 'growth\n', { flag: 'a' })
                }
                return executeProbe(step)
            },
        })

        expect(grew).toBe(true)
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_ARTIFACT_DRIFT', target: 'fixtures/personas.generated.ts' })],
        })
    })

})
