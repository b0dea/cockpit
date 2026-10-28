import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanOwnedPackageDist } from '../../../scripts/build-cockpit.mjs'

const scratch: string[] = []
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

afterEach(async () => Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))))

function packageFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-build-'))
    scratch.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@b0dea/cockpit' }))
    return root
}

describe('package build output ownership', () => {
    it('cleans stale output before invoking the native compiler', () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-build-entry-'))
        scratch.push(root)
        const packageRoot = join(root, 'packages/cockpit')
        const buildScript = join(root, 'scripts/build-cockpit.mjs')
        const compiler = join(root, 'node_modules/typescript/bin/tsc')
        mkdirSync(join(packageRoot, 'dist'), { recursive: true })
        mkdirSync(dirname(buildScript), { recursive: true })
        mkdirSync(dirname(compiler), { recursive: true })
        writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@b0dea/cockpit' }))
        writeFileSync(join(packageRoot, 'dist/stale-wrapper.js'), 'stale')
        cpSync(join(repositoryRoot, 'scripts/build-cockpit.mjs'), buildScript)
        writeFileSync(compiler, [
            "const { existsSync, mkdirSync, writeFileSync } = require('node:fs')",
            "if (existsSync('dist/stale-wrapper.js')) throw new Error('stale output survived')",
            "mkdirSync('dist', { recursive: true })",
            "writeFileSync('dist/cli.js', 'emitted')",
            "writeFileSync('compiler-arguments.json', JSON.stringify(process.argv.slice(2)))",
        ].join('\n'))

        const result = spawnSync(process.execPath, [realpathSync(buildScript)], { cwd: packageRoot, encoding: 'utf8' })

        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(join(packageRoot, 'dist/cli.js'), 'utf8')).toBe('emitted')
        expect(JSON.parse(readFileSync(join(packageRoot, 'compiler-arguments.json'), 'utf8'))).toEqual([
            '--project', 'tsconfig.build.json', '--declaration', '--singleThreaded',
        ])
        const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'packages/cockpit/package.json'), 'utf8'))
        expect(manifest.scripts.build).toBe('node ../../scripts/build-cockpit.mjs')
    })

    it('refuses a linked dist directory without touching its target', async () => {
        const root = packageFixture()
        const borrowed = mkdtempSync(join(tmpdir(), 'cockpit-build-borrowed-'))
        scratch.push(borrowed)
        writeFileSync(join(borrowed, 'owned-elsewhere.js'), 'keep')
        symlinkSync(borrowed, join(root, 'dist'))

        await expect(cleanOwnedPackageDist(realpathSync(root))).rejects.toThrow('PACKAGE_DIST_INVALID')
        expect(readFileSync(join(borrowed, 'owned-elsewhere.js'), 'utf8')).toBe('keep')
    })
})
