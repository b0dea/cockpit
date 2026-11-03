import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fsPromises from 'node:fs/promises'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'
import { runSyncAdoption } from './adopt.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'

const { cleanup, surfaceConsumer } = createGeneratedCommandFixture()
const homes: string[] = []
afterEach(async () => {
    await cleanup()
    await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

// A team's own Claude settings: a formatter hook and permission rules cockpit knows nothing about.
const TEAM_SETTINGS = `${JSON.stringify({
    permissions: { allow: ['Bash(npm run lint)'], deny: ['Read(./.env)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npm run format' }] }] },
}, null, 2)}\n`

async function teamConsumer(name: string) {
    const fixture = await surfaceConsumer(name)
    await mkdir(join(fixture.root, '.claude'), { recursive: true })
    await writeFile(join(fixture.root, '.claude/settings.json'), TEAM_SETTINGS)
    return fixture
}

async function adopt(configPath: string) {
    const outcome = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, request => syncGeneratedEnvironment(request))
    expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
    return outcome
}

describe('sync --adopt', () => {
    it('refuses to adopt its own published settings after synchronization without changing them', async () => {
        const { root, configPath } = await surfaceConsumer('adopt-published')
        const synced = await syncGeneratedEnvironment({ configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
        const paths = [configPath, join(root, '.claude/settings.json'), join(root, '.cockpit/generated-environment-ownership.json')]
        const before = await Promise.all(paths.map(path => readFile(path)))

        const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, request => syncGeneratedEnvironment(request))

        expect(refused).toMatchObject({ status: 2, result: null, diagnostics: [expect.objectContaining({
            code: 'SURFACE_ADOPTION_REFUSED', target: '.claude/settings.json',
            message: expect.stringContaining("cockpit's own published output"),
        })] })
        expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
        await expect(readFile(join(root, 'cockpit/adopted/.claude/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('names the adopt command when a team settings file is in the way', async () => {
        const { configPath } = await teamConsumer('adopt-conflict')
        const refused = await syncGeneratedEnvironment({ configPath })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'SURFACE_STATE_CONFLICT', target: '.claude/settings.json',
            message: expect.stringContaining('npx --no cockpit sync --config <your cockpit.toml> --adopt .claude/settings.json'),
        })] })
    })

    it('keeps the team hook and permissions beside the guard hook in the merged file', async () => {
        const { root, configPath } = await teamConsumer('adopt-merge')
        await adopt(configPath)
        expect(await readFile(join(root, 'cockpit/adopted/.claude/settings.json'), 'utf8')).toBe(TEAM_SETTINGS)
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') throw new Error('adopted configuration did not load')
        expect(loaded.result.config.surfaces.adopted).toMatchObject([{ path: '.claude/settings.json', source: 'cockpit/adopted/.claude/settings.json',
            provenance: { kind: 'declared', source: '.claude/settings.json' } }])
        const merged = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
        // The team's rules are kept beside cockpit's command allowances and native read denials, not replaced by them.
        expect(merged.permissions).toMatchObject({ allow: expect.arrayContaining(['Bash(npm run lint)', 'Bash(npx --no cockpit test-run *)']),
            deny: ['Read(//**/.secrets/**)', 'Read(//**/app/.env)', 'Read(./.env)'] })
        expect(merged.hooks.PostToolUse).toEqual(JSON.parse(TEAM_SETTINGS).hooks.PostToolUse)
        expect(JSON.stringify(merged.hooks.PreToolUse)).toContain('.cockpit/guards/bash-guard.sh')
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    })

    // The parser quotes the lines around its failure, and cockpit.toml can hold anything the team
    // pasted into it, so the canary sits where the appended row collides with a static array.
    it('names where cockpit.toml stopped parsing without quoting it, and moves nothing', async () => {
        const { root, configPath } = await teamConsumer('adopt-unparseable')
        const source = await readFile(configPath, 'utf8')
        await writeFile(configPath, `[surfaces]\nadopted = []\n${source}\n# CANARY_SECRET_7f3a\n`)

        const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, request => syncGeneratedEnvironment(request))

        expect(refused).toMatchObject({ status: 2, result: null, diagnostics: [expect.objectContaining({
            code: 'CONFIG_PARSE_INVALID', target: configPath,
            message: expect.stringMatching(/unparseable \(TOML error at line \d+, column \d+\); nothing was moved/),
        })] })
        expect(JSON.stringify(refused)).not.toContain('CANARY_SECRET_7f3a')
        expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(TEAM_SETTINGS)
    })

    it('refuses a redirected adopted-copy ancestor without moving the team file or writing outside the cockpit', async () => {
        const { root, configPath } = await teamConsumer('adopt-redirected-copy')
        const outside = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-adopt-outside-')))
        homes.push(outside)
        await mkdir(join(root, 'cockpit/adopted'), { recursive: true })
        await symlink(outside, join(root, 'cockpit/adopted/.claude'))

        const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, async () => ({
            status: 0, diagnostics: [], result: {},
        }))

        expect(refused).toMatchObject({ status: 2, result: null, diagnostics: [expect.objectContaining({
            code: 'SURFACE_ADOPTION_REFUSED', target: '.claude/settings.json',
        })] })
        expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(TEAM_SETTINGS)
        await expect(readFile(join(outside, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses a FIFO ownership manifest without waiting for a writer', async () => {
        const { root, configPath } = await teamConsumer('adopt-fifo-ownership')
        const ownershipPath = join(root, '.cockpit/generated-environment-ownership.json')
        await mkdir(join(root, '.cockpit'), { recursive: true })
        execFileSync('mkfifo', [ownershipPath])
        const writer = spawn(process.execPath, ['-e', `
            const fs = require('node:fs')
            setTimeout(() => {
                try { fs.closeSync(fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)) }
                catch (error) {
                    if (error && (error.code === 'ENXIO' || error.code === 'ENOENT')) return
                    console.error(error)
                    process.exitCode = 1
                }
            }, 1500)
        `, ownershipPath], { stdio: ['ignore', 'ignore', 'inherit'] })
        const started = Date.now()

        const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, request => syncGeneratedEnvironment(request))
        const elapsed = Date.now() - started
        const [writerCode] = await once(writer, 'exit')

        expect(refused).toMatchObject({ status: 2, result: null, diagnostics: [expect.objectContaining({
            code: 'GENERATED_OWNERSHIP_INVALID', target: '.cockpit/generated-environment-ownership.json',
        })] })
        expect(elapsed).toBeLessThan(1000)
        expect(writerCode).toBe(0)
        expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(TEAM_SETTINGS)
        expect((await lstat(ownershipPath)).isFIFO()).toBe(true)
    })

    it('restores the original bytes and mode when synchronization refuses after an ordinary adoption move', async () => {
        const { root, configPath } = await teamConsumer('adopt-rollback')
        const sourcePath = join(root, '.claude/settings.json')
        const configBefore = await readFile(configPath)
        const modeBefore = (await lstat(sourcePath)).mode & 0o777

        const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, async () => ({
            status: 2, result: null, diagnostics: [{ severity: 'error', code: 'SYNTHETIC_SYNC_REFUSED', message: 'synthetic refusal' }],
        }))

        expect(refused).toMatchObject({ status: 2, result: null, diagnostics: [
            expect.objectContaining({ code: 'SYNTHETIC_SYNC_REFUSED' }),
            expect.objectContaining({ code: 'SURFACE_ADOPTION_REFUSED', message: expect.stringContaining('rolled back') }),
        ] })
        expect(await readFile(sourcePath, 'utf8')).toBe(TEAM_SETTINGS)
        expect((await lstat(sourcePath)).mode & 0o777).toBe(modeBefore)
        expect(await readFile(configPath)).toEqual(configBefore)
        await expect(readFile(join(root, 'cockpit/adopted/.claude/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('attempts owned recovery when the config filesystem write throws', async () => {
        const { root, configPath } = await teamConsumer('adopt-config-write-error')
        const sourcePath = join(root, '.claude/settings.json')
        const configBefore = await readFile(configPath)
        const mkdirOriginal = fsPromises.mkdir
        const mkdirSpy = vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (path, options) => {
            if (typeof path === 'string' && path.startsWith(join(root, '.cockpit.toml.adopt-'))) {
                throw Object.assign(new Error('synthetic config directory refusal'), { code: 'EACCES' })
            }
            return mkdirOriginal(path, options)
        })
        syncBuiltinESMExports()
        try {
            const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, async () => {
                throw new Error('synchronize must not run after the config write fails')
            })

            expect(refused).toMatchObject({ status: 2, diagnostics: [
                expect.objectContaining({ code: 'SURFACE_ADOPTION_REFUSED', message: expect.stringContaining('writing cockpit.toml failed') }),
                expect.objectContaining({ code: 'SURFACE_ADOPTION_REFUSED', message: expect.stringContaining('rolled back') }),
            ] })
            expect(await readFile(sourcePath, 'utf8')).toBe(TEAM_SETTINGS)
            expect(await readFile(configPath)).toEqual(configBefore)
            await expect(readFile(join(root, 'cockpit/adopted/.claude/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            mkdirSpy.mockRestore()
            syncBuiltinESMExports()
        }
    })

    it('keeps rollback indeterminate when a post-link helper fault retains private recovery links', async () => {
        const { root, configPath } = await teamConsumer('adopt-post-link-fault')
        const sourcePath = join(root, '.claude/settings.json')
        const destinationPath = join(root, 'cockpit/adopted/.claude/settings.json')
        const preloadPath = join(root, 'post-link-fault.cjs')
        const configBefore = await readFile(configPath)
        const sourceMode = (await lstat(sourcePath)).mode & 0o777
        await writeFile(preloadPath, `
            const fs = require('node:fs')
            const path = require('node:path')
            const request = JSON.parse(process.argv[2])
            if (request.action === 'relocate-file') {
                const originalLstat = fs.lstatSync
                const originalUnlink = fs.unlinkSync
                let destinationChecks = 0
                fs.lstatSync = (target, ...rest) => {
                    const inDestination = process.cwd().endsWith(path.join(...request.destination.segments))
                    if (inDestination && target === request.destination.name && ++destinationChecks === 2) {
                        throw Object.assign(new Error('synthetic post-link observation failure'), { code: 'EIO' })
                    }
                    return originalLstat(target, ...rest)
                }
                fs.unlinkSync = (target, ...rest) => {
                    if (typeof target === 'string' && target.startsWith('.cockpit-adopt-destination-')) {
                        throw Object.assign(new Error('synthetic destination capture cleanup failure'), { code: 'EIO' })
                    }
                    return originalUnlink(target, ...rest)
                }
            }
        `)
        let synchronized = false
        let injected = false

        const refused = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, async () => {
            synchronized = true
            throw new Error('synchronize must not run after relocation refuses')
        }, { execute: step => {
            if (step.labels.action !== 'relocate-file') return executeProbe(step)
            injected = true
            return executeProbe({ ...step, env: { ...step.env, NODE_OPTIONS: `--require=${preloadPath}` } })
        } })

        expect(injected).toBe(true)
        expect(synchronized).toBe(false)
        expect(refused).toMatchObject({ status: 2, diagnostics: [
            expect.objectContaining({ code: 'SURFACE_ADOPTION_REFUSED', message: expect.stringContaining('could not be confirmed') }),
            expect.objectContaining({ code: 'SURFACE_ADOPTION_REFUSED', message: expect.stringContaining('recovery remains indeterminate') }),
        ] })
        expect(refused.diagnostics.map(diagnostic => diagnostic.message).join('\n')).not.toContain('the adoption was rolled back')
        expect(await readFile(sourcePath, 'utf8')).toBe(TEAM_SETTINGS)
        expect((await lstat(sourcePath)).mode & 0o777).toBe(sourceMode)
        expect(await readFile(configPath)).toEqual(configBefore)
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
        const sourceCaptures = (await readdir(join(root, '.claude'))).filter(name => name.startsWith('.cockpit-adopt-source-'))
        const destinationCaptures = (await readdir(join(root, 'cockpit/adopted/.claude'))).filter(name => name.startsWith('.cockpit-adopt-destination-'))
        expect(sourceCaptures).toHaveLength(1)
        expect(destinationCaptures).toHaveLength(1)
        expect(await readFile(join(root, '.claude', sourceCaptures[0]!), 'utf8')).toBe(TEAM_SETTINGS)
        expect(await readFile(join(root, 'cockpit/adopted/.claude', destinationCaptures[0]!), 'utf8')).toBe(TEAM_SETTINGS)
    })

    it('reports a hand edit to the merged file and points at the adopted copy', async () => {
        const { root, configPath } = await teamConsumer('adopt-drift')
        await adopt(configPath)
        const path = join(root, '.claude/settings.json')
        await writeFile(path, (await readFile(path, 'utf8')).replace('npm run lint', 'npm run anything'))
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'SURFACE_STATE_CONFLICT', target: '.claude/settings.json',
            message: expect.stringContaining('merged from cockpit/adopted/.claude/settings.json: make the change there, then ask the person who owns the cockpit before you delete .claude/settings.json'),
        })] })
    })
})
