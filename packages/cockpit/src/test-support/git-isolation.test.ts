import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const PROBE = 'COCKPIT_GIT_ISOLATION_PROBE'
const root = resolve(import.meta.dirname, '../../../..')
const scratch: string[] = []

afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('test git isolation', () => {
    it('keeps fixture git writes away from the repository named by an inherited GIT_DIR', () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-git-isolation-'))
        scratch.push(directory)
        execFileSync('git', ['init', '--quiet', join(directory, 'outer')])
        const outer = join(directory, 'outer', '.git')

        const run = spawnSync(join(root, 'node_modules/.bin/vitest'),
            ['run', 'packages/cockpit/src/test-support/git-isolation.test.ts', '-t', 'fixture writes its own config'],
            { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_DIR: outer, [PROBE]: directory } })

        expect(run.status, run.stderr + run.stdout).toBe(0)
        const leaked = spawnSync('git', ['--git-dir', outer, 'config', 'cockpit.probe'], { encoding: 'utf8' })
        expect(leaked.stdout.trim()).toBe('')
    })

    it('keeps the developer shell startup file out of the shells fixtures spawn', () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-shell-isolation-'))
        scratch.push(directory)
        const startup = join(directory, 'startup.sh')
        writeFileSync(startup, `: > ${JSON.stringify(join(directory, 'sourced'))}\n`)

        const run = spawnSync(join(root, 'node_modules/.bin/vitest'),
            ['run', 'packages/cockpit/src/test-support/git-isolation.test.ts', '-t', 'fixture runs a shell'],
            { cwd: root, encoding: 'utf8', env: { ...process.env, BASH_ENV: startup, ENV: startup, [PROBE]: directory } })

        expect(run.status, run.stderr + run.stdout).toBe(0)
        expect(existsSync(join(directory, 'sourced'))).toBe(false)
    })

    // These run as children of the cases above; in an ordinary run there is no fixture directory
    // and nothing to do, and the runner forbids skipped tests, so they return early instead.
    it('fixture runs a shell', () => {
        if (!process.env[PROBE]) return
        execFileSync('bash', ['-c', 'true'])
        execFileSync('sh', ['-c', 'true'])
    })

    it('fixture writes its own config', () => {
        const directory = process.env[PROBE]
        if (!directory) return
        const fixture = join(directory, 'fixture')
        execFileSync('git', ['init', '--quiet', fixture])
        execFileSync('git', ['-C', fixture, 'config', 'cockpit.probe', 'fixture'])
    })
})
