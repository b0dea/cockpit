import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../../scripts/run-changed-tests.mjs', import.meta.url))
const ARCHITECTURE = 'packages/cockpit/src/architecture-contract.test.ts'
const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(files: Record<string, string>, objectFormat: 'sha1' | 'sha256' = 'sha1') {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-changed-tests-'))
    roots.push(root)
    execFileSync('git', ['init', '--quiet', ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : [])], { cwd: root })
    execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'synthetic@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Synthetic'], { cwd: root })
    const tracked = { '.gitignore': 'node_modules/\n', [ARCHITECTURE]: 'architecture\n', ...files }
    for (const [path, bytes] of Object.entries(tracked)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), bytes)
    }
    mkdirSync(join(root, 'node_modules/vitest'), { recursive: true })
    writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'),
        `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)))
const report = process.argv.find(argument => argument.startsWith('--outputFile.json=')).split('=', 2)[1]
writeFileSync(report, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: [{ assertionResults: [{ status: 'passed', fullName: 'synthetic passes' }] }] }))
`)
    execFileSync('git', ['add', ...Object.keys(tracked)], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'synthetic base'], { cwd: root })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const capture = join(root, 'capture.json')
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, base, ...args], {
        cwd: root, encoding: 'utf8', env: { ...process.env, CAPTURE_PATH: capture },
    })
    return { root, base, capture, run }
}

describe('changed adjacent-owner test runner', () => {
    it('accepts a base commit from a SHA-256 repository', () => {
        const fixture = repository({
            'packages/cockpit/src/example.ts': 'export const value = 1\n',
            'packages/cockpit/src/example.test.ts': 'example\n',
        }, 'sha256')
        expect(fixture.base).toMatch(/^[a-f0-9]{64}$/)
        writeFileSync(join(fixture.root, 'packages/cockpit/src/example.ts'), 'export const value = 2\n')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(fixture.capture, 'utf8'))).toContain('packages/cockpit/src/example.test.ts')
    })

    it('dispatches changed and explicitly affected owners once with bounded workers', () => {
        const fixture = repository({
            'packages/cockpit/src/example.ts': 'export const value = 1\n',
            'packages/cockpit/src/example.test.ts': 'example\n',
            'packages/cockpit/src/shared.test.ts': 'shared\n',
        })
        writeFileSync(join(fixture.root, 'packages/cockpit/src/example.ts'), 'export const value = 2\n')
        writeFileSync(join(fixture.root, 'packages/cockpit/src/untracked.test.ts'), 'untracked\n')

        const result = fixture.run('--extra-test', 'packages/cockpit/src/shared.test.ts', '--extra-test', 'packages/cockpit/src/shared.test.ts')

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(fixture.capture, 'utf8'))).toEqual([
            'run', ARCHITECTURE, 'packages/cockpit/src/example.test.ts', 'packages/cockpit/src/shared.test.ts',
            'packages/cockpit/src/untracked.test.ts', '--maxWorkers=4', '--allowOnly=false',
            '--reporter=default', `--reporter=${join(dirname(SCRIPT), 'immediate-failure-reporter.mjs')}`,
            '--reporter=json', expect.stringMatching(/^--outputFile\.json=/),
        ])
        expect(result.stdout).toContain('adjacent-owner tests: 4 owner files')
        expect(result.stdout).toContain('Adjacent tests only; review non-adjacent dependents and shared seams separately.')
    })

    it('selects every split adjacent owner for one changed implementation', () => {
        const fixture = repository({
            'packages/cockpit/src/example.ts': 'export const value = 1\n',
            'packages/cockpit/src/example.test.ts': 'core\n',
            'packages/cockpit/src/example.publication.test.ts': 'publication\n',
            'packages/cockpit/src/example.repair.spec.ts': 'repair\n',
        })
        writeFileSync(join(fixture.root, 'packages/cockpit/src/example.ts'), 'export const value = 2\n')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(fixture.capture, 'utf8'))).toEqual(expect.arrayContaining([
            'packages/cockpit/src/example.test.ts',
            'packages/cockpit/src/example.publication.test.ts',
            'packages/cockpit/src/example.repair.spec.ts',
        ]))
    })

    it('selects every generated command owner when their shared fixtures change', () => {
        const fixture = repository({
            'packages/cockpit/test-support/generated-fixtures.ts': 'export const fixture = 1\n',
            'packages/cockpit/src/generated-environment/command.test.ts': 'core\n',
            'packages/cockpit/src/generated-environment/command.publication.test.ts': 'publication\n',
        })
        writeFileSync(join(fixture.root, 'packages/cockpit/test-support/generated-fixtures.ts'), 'export const fixture = 2\n')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(fixture.capture, 'utf8'))).toEqual(expect.arrayContaining([
            'packages/cockpit/src/generated-environment/command.test.ts',
            'packages/cockpit/src/generated-environment/command.publication.test.ts',
        ]))
    })

    it('names every non-documentation path without an owner and refuses before dispatch', () => {
        const fixture = repository({
            'scripts/task.mjs': 'export const value = 1\n',
            'scripts/task.sh': '#!/bin/sh\nexit 0\n',
            'packages/cockpit/surfaces/template.txt': 'before\n',
            'packages/cockpit/surfaces/skills/fix.skill.md': 'before\n',
            'package-lock.json': '{}\n',
        })
        writeFileSync(join(fixture.root, 'scripts/task.mjs'), 'export const value = 2\n')
        writeFileSync(join(fixture.root, 'scripts/task.sh'), '#!/bin/sh\nexit 1\n')
        writeFileSync(join(fixture.root, 'packages/cockpit/surfaces/template.txt'), 'after\n')
        writeFileSync(join(fixture.root, 'packages/cockpit/surfaces/skills/fix.skill.md'), 'after\n')
        writeFileSync(join(fixture.root, 'package-lock.json'), '{"changed":true}\n')

        const result = fixture.run()

        expect(result.status).toBe(2)
        expect(result.stderr.match(/CHANGED_TEST_OWNER_UNMAPPED:/g)).toHaveLength(5)
        for (const path of ['package-lock.json', 'packages/cockpit/surfaces/skills/fix.skill.md',
            'packages/cockpit/surfaces/template.txt', 'scripts/task.mjs', 'scripts/task.sh']) {
            expect(result.stderr).toContain(`CHANGED_TEST_OWNER_UNMAPPED: ${path}`)
        }
        expect(result.stderr).toContain('--extra-test adds supplemental affected owners but does not resolve an unmapped path')
        expect(existsSync(fixture.capture)).toBe(false)
    })

    it('reports documentation-only changes without dispatching or claiming a gate', () => {
        const fixture = repository({ 'docs/guide.md': 'before\n' })
        writeFileSync(join(fixture.root, 'docs/guide.md'), 'after\n')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('adjacent-owner tests: no executable or test owners changed; no tests dispatched')
        expect(result.stdout).not.toContain('PASS')
        expect(existsSync(fixture.capture)).toBe(false)
    })
})
