import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installedPackageMetadata } from './package-metadata.js'
import { initializeTeamMetadata, prepareTeamMetadata, applyTeamMetadata, validateTeamMetadata } from './team-metadata.js'

const roots: string[] = []
async function fixture(siblingsRoot = 'repositories'): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-team-metadata-'))); roots.push(root)
    const config = await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')
    await writeFile(join(root, 'cockpit.toml'), config.replace('name = "generated-environment"', `name = "portable"\nsiblings_root = ${JSON.stringify(siblingsRoot)}`))
    return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('team metadata', () => {
    it('rejects a stale prepared metadata authority before any write and never reuses it', async () => {
        const root = await fixture()
        const manifest = '{"private":true}\n'
        await writeFile(join(root, 'package.json'), manifest)
        await writeFile(join(root, '.gitignore'), 'operator-owned\n')
        const prepared = await prepareTeamMetadata(join(root, 'cockpit.toml'))
        if (prepared.kind !== 'complete') throw new Error(prepared.message)
        await writeFile(join(root, '.gitignore'), 'concurrent edit\n')
        expect(await applyTeamMetadata(prepared.authority)).toMatchObject({ kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE' })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('concurrent edit\n')
        await writeFile(join(root, '.gitignore'), 'operator-owned\n')
        expect(await applyTeamMetadata(prepared.authority)).toMatchObject({ kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE' })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
    })

    it('adds exact package scripts and a narrow managed ignore block without changing user data', async () => {
        const root = await fixture()
        await writeFile(join(root, 'package.json'), '{"private":true,"scripts":{"test":"vitest"}}\n')
        await writeFile(join(root, '.gitignore'), 'operator-owned\n')
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toEqual({ kind: 'complete', changed: true, changes: [
            { operation: 'write', path: 'package.json' }, { operation: 'write', path: '.gitignore' },
        ] })
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        expect(manifest).toEqual({ private: true, scripts: { test: 'vitest', 'cockpit:setup': 'cockpit setup --config cockpit.toml',
            'cockpit:sync': 'cockpit sync --config cockpit.toml', 'cockpit:check': 'cockpit check --config cockpit.toml' },
        devDependencies: { [installedPackageMetadata.name]: installedPackageMetadata.version } })
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('operator-owned\n# cockpit:ignore:start sha256=3c9b045f924e82c1\n/node_modules/\n/.cockpit/local/\n/env/.secrets/*\n!/env/.secrets/.gitignore\n/repositories/\n# cockpit:ignore:end\n')
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toEqual({ kind: 'complete', changed: false, changes: [] })
    })

    it('ignores literal sibling directory names without matching nearby directories', async () => {
        for (const [siblingsRoot, nearby] of [
            ['repositories[1]', 'repositories1'], ['repositories*', 'repositories-extra'],
            ['repositories ', 'repositories'], ['repositories\\archive', 'repositories/archive'],
        ] as const) {
            const root = await fixture(siblingsRoot)
            expect(spawnSync('git', ['-C', root, 'init', '--quiet']).status).toBe(0)
            await mkdir(join(root, siblingsRoot), { recursive: true })
            await mkdir(join(root, nearby), { recursive: true })
            await writeFile(join(root, siblingsRoot, 'probe.txt'), 'literal')
            await writeFile(join(root, nearby, 'probe.txt'), 'nearby')

            expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete', changed: true })
            const ignored = (path: string) => spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', path]).status
            expect(ignored(`${siblingsRoot}/probe.txt`), siblingsRoot).toBe(0)
            expect(ignored(`${nearby}/probe.txt`), nearby).toBe(1)
        }
    })

    it('ignores cloned sibling checkouts inside the cockpit root but not local data directories', async () => {
        const root = await fixture('.')
        await writeFile(join(root, 'cockpit.toml'), `${await readFile(join(root, 'cockpit.toml'), 'utf8')}
[[sibling]]
slug = "web"
dir = "services/web"
mount = "none"
acquire = "auto"
remote = "synthetic-web.git"
var = "WEB_DIR"
purpose = "Synthetic web repository"
`)
        expect(spawnSync('git', ['-C', root, 'init', '--quiet']).status).toBe(0)
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete', changed: true })
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete' })
        const ignored = (path: string) => spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', path]).status
        expect(ignored('services/web/probe.txt')).toBe(0)
        expect(ignored('services/other/probe.txt')).toBe(1)
        expect(ignored('app/probe.txt')).toBe(1)
        expect(ignored('cockpit.toml')).toBe(1)
    })

    it('ignores a local repository recorded without a remote, and updates an unedited block when siblings change', async () => {
        // `sibling add --create` runs git init and records acquire "none" because there is no
        // remote yet; left visible, `git add .` fails on (or embeds) the nested repository.
        const root = await fixture('.')
        expect(spawnSync('git', ['-C', root, 'init', '--quiet']).status).toBe(0)
        await mkdir(join(root, 'app'))
        await writeFile(join(root, 'app/probe.txt'), 'tracked local data')
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete', changed: true })

        expect(spawnSync('git', ['-C', root, 'init', '--quiet', 'services/api']).status).toBe(0)
        await writeFile(join(root, 'cockpit.toml'), `${await readFile(join(root, 'cockpit.toml'), 'utf8')}
[[sibling]]
slug = "api"
dir = "services/api"
mount = "always"
acquire = "none"
var = "API_DIR"
purpose = "Synthetic local repository"
`)
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE' })
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toEqual({ kind: 'complete', changed: true,
            changes: [{ operation: 'write', path: '.gitignore' }] })
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete' })
        const ignored = (path: string) => spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', path]).status
        expect(ignored('services/api/probe.txt')).toBe(0)
        expect(ignored('app/probe.txt')).toBe(1)
        expect(spawnSync('git', ['-C', root, 'add', '--dry-run', '.']).status).toBe(0)
    })

    it('reports the exact initialization writes during a read-only preview', async () => {
        const root = await fixture()
        await writeFile(join(root, 'package.json'), '{"private":true}\n')
        await writeFile(join(root, '.gitignore'), 'operator-owned\n')

        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'), { dryRun: true })).toEqual({
            kind: 'complete', changed: true, changes: [
                { operation: 'write', path: 'package.json' }, { operation: 'write', path: '.gitignore' },
            ],
        })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{"private":true}\n')
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('operator-owned\n')
    })

    it('refuses an unrepresentable sibling ignore path before changing metadata', async () => {
        const root = await fixture('repositories\narchive')
        const manifest = '{"private":true}\n'
        const ignore = 'operator-owned\n'
        await writeFile(join(root, 'package.json'), manifest)
        await writeFile(join(root, '.gitignore'), ignore)

        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({
            kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE', target: 'cockpit.siblings_root',
            message: expect.stringContaining('single-line'),
        })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(ignore)
    })

    it('refuses version drift with an actionable exact install command', async () => {
        const root = await fixture()
        await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { [installedPackageMetadata.name]: '9.9.9' } }))
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'refusal', code: 'COCKPIT_VERSION_MISMATCH',
            message: expect.stringContaining(`npm install --save-dev --save-exact ${installedPackageMetadata.name}@${installedPackageMetadata.version}`) })
    })

    it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
        'refuses the cockpit package in the unowned %s slot without changing team metadata', async (section) => {
            const root = await fixture()
            const manifest = `${JSON.stringify({ private: true,
                [section]: { [installedPackageMetadata.name]: installedPackageMetadata.version } }, null, 2)}\n`
            const lock = '{"lockfileVersion":3,"canary":"unchanged"}\n'
            const ignore = 'operator-owned\n'
            await writeFile(join(root, 'package.json'), manifest)
            await writeFile(join(root, 'package-lock.json'), lock)
            await writeFile(join(root, '.gitignore'), ignore)

            expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({
                kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE', target: join(root, 'package.json'),
                message: expect.stringContaining('devDependencies'),
            })
            expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
            expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe(lock)
            expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(ignore)

            const validationRoot = await fixture()
            expect(await initializeTeamMetadata(join(validationRoot, 'cockpit.toml'))).toMatchObject({ kind: 'complete' })
            const initialized = JSON.parse(await readFile(join(validationRoot, 'package.json'), 'utf8'))
            const validationManifest = `${JSON.stringify({ ...initialized,
                [section]: { [installedPackageMetadata.name]: installedPackageMetadata.version } }, null, 2)}\n`
            const validationLock = '{"lockfileVersion":3,"canary":"validation-unchanged"}\n'
            const validationIgnore = await readFile(join(validationRoot, '.gitignore'), 'utf8')
            await writeFile(join(validationRoot, 'package.json'), validationManifest)
            await writeFile(join(validationRoot, 'package-lock.json'), validationLock)
            expect(await validateTeamMetadata(join(validationRoot, 'cockpit.toml'))).toMatchObject({
                kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE', target: join(validationRoot, 'package.json'),
                message: expect.stringContaining('devDependencies'),
            })
            expect(await readFile(join(validationRoot, 'package.json'), 'utf8')).toBe(validationManifest)
            expect(await readFile(join(validationRoot, 'package-lock.json'), 'utf8')).toBe(validationLock)
            expect(await readFile(join(validationRoot, '.gitignore'), 'utf8')).toBe(validationIgnore)
        },
    )

    it('does not normalize an unauthenticated local package reference', async () => {
        const root = await fixture()
        const spec = 'file:../archives/cockpit.tgz'
        const manifest = `${JSON.stringify({ private: true, devDependencies: { [installedPackageMetadata.name]: spec } }, null, 2)}\n`
        const lock = `${JSON.stringify({ lockfileVersion: 3, packages: {
            '': { devDependencies: { [installedPackageMetadata.name]: spec } },
            [`node_modules/${installedPackageMetadata.name}`]: { version: installedPackageMetadata.version, resolved: spec },
        } }, null, 2)}\n`
        await writeFile(join(root, 'package.json'), manifest)
        await writeFile(join(root, 'package-lock.json'), lock)

        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({
            kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE', target: join(root, 'package.json'),
        })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
        expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe(lock)
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({
            kind: 'refusal', code: 'COCKPIT_VERSION_MISMATCH', message: expect.stringContaining(`pins ${installedPackageMetadata.name} to ${spec}`),
        })
    })

    it('accepts a local-archive pin installed separately from the running copy of the same package', async () => {
        // The bootstrap route runs init from a temporary install, then installs the same archive in
        // the cockpit root; a resumed init from the temporary install must accept that pin.
        const root = await fixture()
        const spec = 'file:../archives/cockpit.tgz'
        const manifest = `${JSON.stringify({ private: true, scripts: {
            'cockpit:setup': 'cockpit setup --config cockpit.toml', 'cockpit:sync': 'cockpit sync --config cockpit.toml',
            'cockpit:check': 'cockpit check --config cockpit.toml',
        }, devDependencies: { [installedPackageMetadata.name]: spec } }, null, 2)}\n`
        await writeFile(join(root, 'package.json'), manifest)
        await writeFile(join(root, 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, packages: {
            '': { devDependencies: { [installedPackageMetadata.name]: spec } },
            [`node_modules/${installedPackageMetadata.name}`]: { version: installedPackageMetadata.version, resolved: spec },
        } }, null, 2)}\n`)
        const installed = join(root, 'node_modules', ...installedPackageMetadata.name.split('/'))
        await mkdir(installed, { recursive: true })
        const runningManifest = await readFile(new URL('../package.json', import.meta.url), 'utf8')
        await writeFile(join(installed, 'package.json'), runningManifest)

        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'complete' })

        await writeFile(join(installed, 'package.json'), runningManifest.replace('"cockpitSourceRevision"', '"rebuilt": true, "cockpitSourceRevision"'))
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'refusal', code: 'COCKPIT_VERSION_MISMATCH' })
    })

    it('refuses redirected metadata without reading or overwriting its target', async () => {
        const root = await fixture()
        const outside = join(root, 'outside'); await writeFile(outside, 'outside-canary')
        await symlink(outside, join(root, 'package.json'))
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE' })
        expect(await readFile(outside, 'utf8')).toBe('outside-canary')
    })

    it('refuses an edited owned ignore region without changing either metadata file', async () => {
        const root = await fixture()
        await writeFile(join(root, 'package.json'), '{"private":true}\n')
        await writeFile(join(root, '.gitignore'), '# cockpit:ignore:start\n/human-edit/\n# cockpit:ignore:end\n')
        const beforePackage = await readFile(join(root, 'package.json'), 'utf8')
        const beforeIgnore = await readFile(join(root, '.gitignore'), 'utf8')

        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({
            kind: 'refusal', code: 'TEAM_METADATA_UNAVAILABLE', message: expect.stringContaining('remove the whole'),
        })
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(beforePackage)
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(beforeIgnore)
    })
})
