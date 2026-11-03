import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const launcher = fileURLToPath(new URL('../bin/cockpit.mjs', import.meta.url))

function runWithVersion(version: string | undefined, traceImports: boolean) {
    const value = version === undefined ? 'undefined' : JSON.stringify(version)
    const source = [
        `Object.defineProperty(process.versions, 'node', { value: ${value} })`,
        `process.argv = [process.execPath, ${JSON.stringify(launcher)}, '--help']`,
        `await import(${JSON.stringify(new URL('../bin/cockpit.mjs', import.meta.url).href)})`,
    ].join(';')

    return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: traceImports ? 'esm' : '' },
        maxBuffer: 16 * 1024 * 1024,
    })
}

describe('the installed launcher runtime floor', () => {
    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['malformed', 'twenty-two'],
        ['below the floor', '21.99.0'],
        ['below the minor floor', '22.21.9'],
    ])('refuses %s runtime data before importing compiled code', (_name, version) => {
        const result = runWithVersion(version, true)

        expect(result.error, `launcher child failed: ${result.error?.message}`).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('COCKPIT_NODE_VERSION_UNSUPPORTED')
        expect(result.stderr).toContain('^22.22.0')
        expect(result.stderr).not.toContain('dist/cli.js')
    })

    it('imports the compiled CLI only after a supported runtime value', () => {
        const result = runWithVersion('22.22.0', false)

        expect(result.error, `launcher child failed: ${result.error?.message}`).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Usage: cockpit')
        // Human mode writes no invocation record; it is part of the --json envelope only.
        expect(result.stderr).toBe('')
    })

    it('supplies cancellation to follow logs before authenticating the environment', () => {
        const result = spawnSync(process.execPath, [launcher, 'logs', '--config',
            '/synthetic/missing-cockpit.toml', '--service', 'api', '--follow', '--json'], {
            encoding: 'utf8', timeout: 10_000,
        })

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(2)
        expect(JSON.parse(result.stdout)).toMatchObject({
            result: null,
            diagnostics: [{ code: 'CONFIG_NOT_FOUND' }],
        })
    })
})

describe('the compiled CLI entry', () => {
    // npm link and workspaces reach dist/cli.js through a symlink; the entry check compared an
    // unresolved argv path with the resolved module URL and silently did nothing.
    it('runs when invoked through a symlink', () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-entry-'))
        try {
            const link = join(directory, 'cli.js')
            symlinkSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), link)
            const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
            expect(result.error).toBeUndefined()
            expect(result.status).toBe(0)
            expect(result.stdout).toContain('Usage: cockpit')
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })
})
