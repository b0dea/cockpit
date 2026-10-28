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
    const runFrom = (from: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, from, ...args], {
        cwd: root, encoding: 'utf8', env: { ...process.env, CAPTURE_PATH: capture },
    })
    const run = (...args: string[]) => runFrom(base, ...args)
    const dispatched = () => (JSON.parse(readFileSync(capture, 'utf8')) as string[]).filter(argument => argument.endsWith('.test.ts'))
    return { root, base, capture, run, runFrom, dispatched }
}

describe('changed adjacent-owner test runner', () => {
    it.each(['vitest.config.ts', 'packages/cockpit/src/test-support/git-isolation.ts'])(
        'selects every package test when shared test configuration %s changes', path => {
            const fixture = repository({
                [path]: 'before\n',
                'packages/cockpit/src/first.test.ts': 'first\n',
                'packages/cockpit/src/nested/second.test.ts': 'second\n',
            })
            writeFileSync(join(fixture.root, path), 'after\n')
            const result = fixture.run()
            expect(result.status, result.stderr).toBe(0)
            expect(fixture.dispatched()).toEqual([ARCHITECTURE, 'packages/cockpit/src/first.test.ts',
                'packages/cockpit/src/nested/second.test.ts'])
        },
    )

    it('finds exact transitive owners of a changed test-support module', () => {
        const path = 'packages/cockpit/test-support/factory.ts'
        const fixture = repository({
            [path]: 'export const factory = 1\n',
            'packages/cockpit/test-support/compose.ts': "export { factory } from './factory.js'\nexport { estate } from './estate.js'\n",
            'packages/cockpit/test-support/estate.ts': "export { factory } from './compose.js'\n",
            'packages/cockpit/src/owner.test.ts': "import { factory } from '../test-support/estate.js'\n",
            'packages/cockpit/src/other.test.ts': 'other\n',
            'packages/cockpit/src/other/factory.ts': 'export const factory = 3\n',
            'packages/cockpit/src/unrelated.test.ts': "import { factory } from './other/factory.js'\n",
        })
        writeFileSync(join(fixture.root, path), 'export const factory = 2\n')
        const result = fixture.run()
        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual(['packages/cockpit/src/owner.test.ts'])
    })

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
        expect(result.stdout).toContain([ARCHITECTURE, 'packages/cockpit/src/example.test.ts', 'packages/cockpit/src/shared.test.ts',
            'packages/cockpit/src/untracked.test.ts'].join('\n'))
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
            'packages/cockpit/src/generated-environment/adopt.test.ts': "import { fixture } from '../../test-support/generated-fixtures.js'\n",
        })
        writeFileSync(join(fixture.root, 'packages/cockpit/test-support/generated-fixtures.ts'), 'export const fixture = 2\n')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(fixture.capture, 'utf8'))).toEqual(expect.arrayContaining([
            'packages/cockpit/src/generated-environment/command.test.ts',
            'packages/cockpit/src/generated-environment/command.publication.test.ts',
            'packages/cockpit/src/generated-environment/adopt.test.ts',
        ]))
    })

    it('accepts any commit-ish as the base and keeps the ancestor check', () => {
        const fixture = repository({
            'packages/cockpit/src/example.ts': 'export const value = 1\n',
            'packages/cockpit/src/example.test.ts': 'example\n',
        })
        execFileSync('git', ['branch', 'base-branch'], { cwd: fixture.root })
        writeFileSync(join(fixture.root, 'packages/cockpit/src/example.ts'), 'export const value = 2\n')

        for (const from of ['base-branch', 'HEAD', fixture.base.slice(0, 12)]) {
            const result = fixture.runFrom(from)
            expect(result.status, `${from}: ${result.stderr}`).toBe(0)
            expect(fixture.dispatched()).toContain('packages/cockpit/src/example.test.ts')
            // The runner's own report is untracked output; clear it so the next base sees only the edit.
            rmSync(fixture.capture)
            rmSync(join(fixture.root, '.vitest-reports'), { recursive: true, force: true })
        }

        const unknown = fixture.runFrom('no-such-revision')
        expect(unknown.status).toBe(2)
        expect(unknown.stderr).toContain('CHANGED_TEST_SELECTION_INVALID: base does not identify a commit: no-such-revision')

        execFileSync('git', ['checkout', '--quiet', '--orphan', 'unrelated'], { cwd: fixture.root })
        execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'unrelated root'], { cwd: fixture.root })
        const notAncestor = fixture.runFrom('base-branch')
        expect(notAncestor.status).toBe(2)
        expect(notAncestor.stderr).toContain('base must be an ancestor of HEAD')
    })

    it('names every path without an owner and refuses before dispatch', () => {
        const fixture = repository({
            'scripts/orphan.mjs': 'export const value = 1\n',
            'scripts/task.sh': '#!/bin/sh\nexit 0\n',
            'tools/helper.txt': 'before\n',
            'fixtures/lonely/data.json': '{}\n',
        })
        writeFileSync(join(fixture.root, 'scripts/orphan.mjs'), 'export const value = 2\n')
        writeFileSync(join(fixture.root, 'scripts/task.sh'), '#!/bin/sh\nexit 1\n')
        writeFileSync(join(fixture.root, 'tools/helper.txt'), 'after\n')
        writeFileSync(join(fixture.root, 'fixtures/lonely/data.json'), '{"changed":true}\n')

        const result = fixture.run()

        expect(result.status).toBe(2)
        expect(result.stderr.match(/CHANGED_TEST_OWNER_UNMAPPED:/g)).toHaveLength(4)
        for (const path of ['fixtures/lonely/data.json', 'scripts/orphan.mjs', 'scripts/task.sh', 'tools/helper.txt']) {
            expect(result.stderr).toContain(`CHANGED_TEST_OWNER_UNMAPPED: ${path}`)
        }
        expect(result.stderr).toContain('--extra-test adds supplemental affected owners but does not resolve an unmapped path')
        expect(existsSync(fixture.capture)).toBe(false)
    })

    const DOCS_TESTS = [
        'packages/cockpit/src/docs-lint.contracts.test.ts', 'packages/cockpit/src/docs-lint.prose.test.ts',
        'packages/cockpit/src/docs-ownership.test.ts', 'packages/cockpit/src/example-cockpit.test.ts',
    ]
    const OTHER = { 'packages/cockpit/src/unrelated.test.ts': 'unrelated\n' }
    const withOwners = (files: Record<string, string>) => repository({
        ...Object.fromEntries(DOCS_TESTS.map(path => [path, 'docs\n'])),
        'packages/cockpit/src/packaging.test.ts': 'packaging\n',
        'packages/cockpit/src/supply-chain.test.ts': 'supply\n',
        'packages/cockpit/src/test-protection.test.ts': 'protection\n',
        ...OTHER, ...files,
    })
    const edit = (root: string, path: string) => writeFileSync(join(root, path), 'after\n')

    it.each([
        ['root', 'README.md'],
        ['docs tree', 'docs/guide/page.md'],
        ['examples tree', 'examples/demo/README.md'],
        ['package', 'packages/cockpit/README.md'],
        ['agent index', 'llms.txt'],
    ])('runs the documentation tests when %s markdown changes', (_name, path) => {
        const fixture = withOwners({ [path]: 'before\n' })
        edit(fixture.root, path)

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual(DOCS_TESTS)
    })

    it.each(['package.json', 'package-lock.json', 'packages/cockpit/package.json', 'packages/cockpit/package-lock.json'])(
        'runs the packaging and supply-chain tests when %s changes', (path) => {
            const fixture = withOwners({ [path]: '{}\n' })
            edit(fixture.root, path)

            const result = fixture.run()

            expect(result.status, result.stderr).toBe(0)
            expect(fixture.dispatched()).toEqual(['packages/cockpit/src/packaging.test.ts', 'packages/cockpit/src/supply-chain.test.ts'])
        })

    it('runs the supply-chain, workflow-contract and test-protection tests when a workflow changes', () => {
        const fixture = withOwners({ '.github/workflows/ci.yml': 'before\n' })
        edit(fixture.root, '.github/workflows/ci.yml')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual([
            'packages/cockpit/src/docs-lint.contracts.test.ts', 'packages/cockpit/src/supply-chain.test.ts',
            'packages/cockpit/src/test-protection.test.ts',
        ])
    })

    it('runs the tests that import a changed script', () => {
        const fixture = withOwners({
            'scripts/task.mjs': 'export const value = 1\n',
            'scripts/task.d.mts': 'export const value: number\n',
            'packages/cockpit/src/task.test.ts': "import { value } from '../../../scripts/task.mjs'\n",
        })
        edit(fixture.root, 'scripts/task.mjs')
        edit(fixture.root, 'scripts/task.d.mts')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual(['packages/cockpit/src/task.test.ts'])
    })

    it.each(['scripts/build-cockpit.mjs', 'packages/cockpit/scripts/build.mjs', 'packages/cockpit/scripts/build-helper.mjs'])(
        'runs the exact test owner importing changed package script %s', path => {
            const fixture = withOwners({
                'scripts/build-cockpit.mjs': 'export const cleanOwnedPackageDist = () => undefined\n',
                'packages/cockpit/scripts/build.mjs': "export { build } from './build-helper.mjs'\n",
                'packages/cockpit/scripts/build-helper.mjs': 'export const build = 1\n',
                'packages/cockpit/src/package-build.test.ts': "import { cleanOwnedPackageDist } from '../../../scripts/build-cockpit.mjs'\nimport { build } from '../scripts/build.mjs'\n",
                'packages/cockpit/src/unrelated/build-helper.mjs': 'export const build = 2\n',
                'packages/cockpit/src/unrelated.test.ts': "import { build } from './unrelated/build-helper.mjs'\n",
            })
            edit(fixture.root, path)

            const result = fixture.run()

            expect(result.status, result.stderr).toBe(0)
            expect(fixture.dispatched()).toEqual(['packages/cockpit/src/package-build.test.ts'])
        },
    )

    it('runs the surfaces tests when a shipped surface changes', () => {
        const fixture = withOwners({
            'packages/cockpit/surfaces/template.txt': 'before\n',
            'packages/cockpit/surfaces/skills/cockpit-fix.skill.md': 'before\n',
            'packages/cockpit/src/surfaces/render.test.ts': 'render\n',
            'packages/cockpit/src/surfaces/nested/deep.test.ts': 'deep\n',
        })
        edit(fixture.root, 'packages/cockpit/surfaces/template.txt')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual(['packages/cockpit/src/surfaces/nested/deep.test.ts', 'packages/cockpit/src/surfaces/render.test.ts'])
    })

    it('runs the tests that read a changed fixture directly or through test support', () => {
        const fixture = withOwners({
            'fixtures/estates/one/estate.json': '{}\n',
            'packages/cockpit/src/direct.test.ts': "const dir = 'fixtures/estates'\n",
            'packages/cockpit/test-support/estate-fixture.ts': "export const dir = 'fixtures/estates'\n",
            'packages/cockpit/src/indirect.test.ts': "import { dir } from '../test-support/estate-fixture.js'\n",
            'packages/cockpit/test-support/fixture-chain.ts': "export { dir } from './estate-fixture.js'\n",
            'packages/cockpit/src/chained.test.ts': "import { dir } from '../test-support/fixture-chain.js'\n",
        })
        edit(fixture.root, 'fixtures/estates/one/estate.json')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual(['packages/cockpit/src/chained.test.ts', 'packages/cockpit/src/direct.test.ts', 'packages/cockpit/src/indirect.test.ts'])
    })

    it('runs the tests that import a source file named differently from its tests, directly or through one module', () => {
        const fixture = withOwners({
            'packages/cockpit/src/table.ts': 'export const table = 1\n',
            'packages/cockpit/src/config/table.ts': 'export const other = 1\n',
            'packages/cockpit/src/commands.test.ts': "import { table } from './table.js'\n",
            'packages/cockpit/src/barrel.ts': "export { table } from './table.js'\n",
            'packages/cockpit/src/barrel-user.test.ts': "import { table } from './barrel.js'\n",
            'packages/cockpit/test-support/table-helper.ts': "import { table } from '../src/table.js'\n",
            'packages/cockpit/src/helper-user.test.ts': "import { build } from '../test-support/table-helper.js'\n",
            'packages/cockpit/src/config-user.test.ts': "import { other } from './config/table.js'\n",
        })
        edit(fixture.root, 'packages/cockpit/src/table.ts')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual([
            ARCHITECTURE, 'packages/cockpit/src/barrel-user.test.ts', 'packages/cockpit/src/commands.test.ts',
            'packages/cockpit/src/helper-user.test.ts',
        ])
    })

    it('refuses a source file that no test imports', () => {
        const fixture = withOwners({
            'packages/cockpit/src/lonely.ts': 'export const lonely = 1\n',
            'packages/cockpit/src/user.test.ts': "import { other } from './other.js'\n",
        })
        edit(fixture.root, 'packages/cockpit/src/lonely.ts')

        const result = fixture.run()

        expect(result.status).toBe(2)
        expect(result.stderr).toContain('CHANGED_TEST_OWNER_UNMAPPED: packages/cockpit/src/lonely.ts')
        expect(existsSync(fixture.capture)).toBe(false)
    })

    it('runs the tests that read the checked-in schema when it changes', () => {
        const fixture = withOwners({
            'packages/cockpit/cockpit.schema.json': '{}\n',
            'packages/cockpit/src/schema-json.test.ts': "new URL('../cockpit.schema.json', import.meta.url)\n",
        })
        edit(fixture.root, 'packages/cockpit/cockpit.schema.json')

        const result = fixture.run()

        expect(result.status, result.stderr).toBe(0)
        expect(fixture.dispatched()).toEqual(['packages/cockpit/src/schema-json.test.ts'])
    })

    it.each(['examples/demo/api/server.mjs', 'examples/demo/cockpit.toml'])(
        'runs the example tests and the tests that read the example when %s changes', (path) => {
            const fixture = withOwners({
                [path]: 'before\n',
                'packages/cockpit/src/reader.test.ts': "const dir = '../../../examples/demo'\n",
                'packages/cockpit/src/other-reader.test.ts': "const dir = '../../../examples/elsewhere'\n",
            })
            edit(fixture.root, path)

            const result = fixture.run()

            expect(result.status, result.stderr).toBe(0)
            expect(fixture.dispatched()).toEqual(['packages/cockpit/src/example-cockpit.test.ts', 'packages/cockpit/src/reader.test.ts'])
        })
})
