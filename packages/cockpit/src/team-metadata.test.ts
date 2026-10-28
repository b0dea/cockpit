import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installedPackageMetadata } from './package-metadata.js'
import { initializeTeamMetadata, validateTeamMetadata } from './team-metadata.js'

const roots: string[] = []
async function fixture(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-team-metadata-'))); roots.push(root)
    const config = await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')
    await writeFile(join(root, 'cockpit.toml'), config.replace('name = "generated-environment"', 'name = "portable"\nsiblings_root = "repositories"'))
    return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('team metadata', () => {
    it('adds exact package scripts and a narrow managed ignore block without changing user data', async () => {
        const root = await fixture()
        await writeFile(join(root, 'package.json'), '{"private":true,"scripts":{"test":"vitest"}}\n')
        await writeFile(join(root, '.gitignore'), 'operator-owned\n')
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toEqual({ kind: 'complete', changed: true })
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        expect(manifest).toEqual({ private: true, scripts: { test: 'vitest', 'cockpit:setup': 'cockpit setup --config cockpit.toml',
            'cockpit:sync': 'cockpit sync --config cockpit.toml', 'cockpit:check': 'cockpit check --config cockpit.toml' },
        devDependencies: { [installedPackageMetadata.name]: installedPackageMetadata.version } })
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('operator-owned\n# cockpit:ignore:start\n/node_modules/\n/.cockpit/local/\n/env/.secrets/*\n!/env/.secrets/.gitignore\n/repositories/\n# cockpit:ignore:end\n')
        expect(await initializeTeamMetadata(join(root, 'cockpit.toml'))).toEqual({ kind: 'complete', changed: false })
    })

    it('refuses version drift with an actionable exact install command', async () => {
        const root = await fixture()
        await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { [installedPackageMetadata.name]: '9.9.9' } }))
        expect(await validateTeamMetadata(join(root, 'cockpit.toml'))).toMatchObject({ kind: 'refusal', code: 'COCKPIT_VERSION_MISMATCH',
            message: expect.stringContaining(`npm install --save-dev --save-exact ${installedPackageMetadata.name}@${installedPackageMetadata.version}`) })
    })

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
