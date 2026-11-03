import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts/run-changed-tests.mjs')
const SRC = 'packages/cockpit/src/'
const PASSING = "import { it } from 'vitest'; it('passes', () => {})\n"
const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A real repository running the real Vitest: the selection is the union of Vitest's own `--changed`
// and the owners the script adds, so a fake runner would pin neither.
function repository(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-changed-tests-'))
    roots.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.email', 'synthetic@example.invalid')
    git('config', 'user.name', 'Synthetic')
    git('config', 'core.excludesFile', '/dev/null')
    const write = (path: string, bytes: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), bytes)
    }
    for (const [path, bytes] of Object.entries(files)) write(path, bytes)
    write('.gitignore', 'node_modules/\n')
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'))
    git('add', '.')
    git('commit', '--quiet', '-m', 'synthetic base')
    const base = git('rev-parse', 'HEAD').trim()
    const run = (from = base) => {
        const result = spawnSync(process.execPath, [SCRIPT, from, '--reporter=verbose'], { cwd: root, encoding: 'utf8' })
        const ran = [...new Set(result.stdout.match(/packages\/\S+?\.test\.ts/g) ?? [])].sort()
        return { ...result, ran }
    }
    return { root, git, write, run }
}

describe('changed test runner', () => {
    it('runs the tests that import a changed file in either tier, and none of the others', () => {
        const fixture = repository({
            [`${SRC}value.ts`]: 'export const value = 1\n',
            [`${SRC}relay.ts`]: "export { value } from './value.js'\n",
            [`${SRC}direct.test.ts`]: "import './value.js'\n" + PASSING,
            [`${SRC}relayed.slow.test.ts`]: "import './relay.js'\n" + PASSING,
            [`${SRC}unrelated.test.ts`]: PASSING,
        })
        fixture.write(`${SRC}value.ts`, 'export const value = 2\n')

        const result = fixture.run()

        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(result.ran).toEqual([`${SRC}direct.test.ts`, `${SRC}relayed.slow.test.ts`])
    })

    it('adds the owners of files that tests read by name rather than import', () => {
        const owner = (name: string, needle: string) => [`${SRC}${name}.test.ts`, `// reads ${needle}\n${PASSING}`] as const
        const fixture = repository({
            ...Object.fromEntries([
                owner('reads-lockfile', 'package-lock.json'),
                owner('reads-workflow', '.github/workflows/ci.yml'),
                owner('reads-libexec', 'launch-helper'),
                owner('reads-schema', 'cockpit.schema.json'),
                owner('reads-fixture', 'fixtures/estate'),
                owner('reads-example', 'examples/minimal'),
                owner('reads-rules', '.dependency-cruiser.mjs'),
                ['docs-lint.test.ts', PASSING], ['supply-chain.test.ts', PASSING], ['docs-ownership.test.ts', PASSING],
                ['architecture.test.ts', PASSING], ['packaging.slow.test.ts', PASSING], ['test-protection.test.ts', PASSING],
                ['example-cockpit.test.ts', PASSING], ['example-cockpit.slow.test.ts', PASSING],
                ['surfaces/render.test.ts', PASSING],
                ['unrelated.test.ts', PASSING],
            ].map(([name, bytes]) => [`${SRC}${name.replace(`${SRC}`, '')}`, bytes])),
            [`${SRC}mod.ts`]: 'export {}\n',
            'package-lock.json': '{}\n',
            '.github/workflows/ci.yml': 'a: 1\n',
            'packages/cockpit/libexec/launch-helper': 'a\n',
            'packages/cockpit/cockpit.schema.json': '{}\n',
            'fixtures/estate/one.toml': 'a = 1\n',
            'examples/minimal/cockpit.toml': 'a = 1\n',
            '.dependency-cruiser.mjs': 'export default {}\n',
            'packages/cockpit/surfaces/skill.md': 'a\n',
            'docs/guide.md': 'a\n',
            '.changeset/fix-thing.md': 'a\n',
        })
        const only = (changed: string[]) => {
            for (const path of changed) fixture.write(path, path.endsWith('.json') ? '{"changed":true}\n' : 'changed\n')
            const result = fixture.run()
            fixture.git('checkout', '--quiet', '--', '.')
            fixture.git('clean', '--quiet', '-fd', '--exclude=node_modules')
            return result.ran.map(path => path.replace(SRC, ''))
        }

        expect(only(['.changeset/fix-thing.md'])).toEqual(['docs-lint.test.ts'])
        expect(only(['docs/guide.md'])).toEqual(['docs-lint.test.ts', 'docs-ownership.test.ts', 'example-cockpit.slow.test.ts', 'example-cockpit.test.ts'])
        expect(only(['package-lock.json'])).toEqual(['packaging.slow.test.ts', 'reads-lockfile.test.ts', 'supply-chain.test.ts'])
        expect(only(['.github/workflows/ci.yml'])).toEqual(['docs-lint.test.ts', 'reads-workflow.test.ts', 'supply-chain.test.ts', 'test-protection.test.ts'])
        expect(only(['packages/cockpit/libexec/launch-helper'])).toEqual(['reads-libexec.test.ts'])
        expect(only(['packages/cockpit/cockpit.schema.json'])).toEqual(['reads-schema.test.ts'])
        expect(only(['fixtures/estate/one.toml'])).toEqual(['reads-fixture.test.ts'])
        expect(only(['examples/minimal/cockpit.toml'])).toEqual(['reads-example.test.ts'])
        expect(only(['.dependency-cruiser.mjs'])).toEqual(['reads-rules.test.ts'])
        expect(only(['packages/cockpit/surfaces/skill.md'])).toEqual(expect.arrayContaining(['surfaces/render.test.ts']))
        expect(only([`${SRC}mod.ts`])).toEqual(['architecture.test.ts'])
    })

    it('runs nothing for a deleted test, says so when no test owns the change, and refuses an unknown base', () => {
        const fixture = repository({ [`${SRC}gone.test.ts`]: PASSING, [`${SRC}kept.test.ts`]: PASSING, 'notes.txt': 'a\n' })
        fixture.git('rm', '--quiet', `${SRC}gone.test.ts`)
        const deleted = fixture.run()
        expect(deleted.status, deleted.stdout + deleted.stderr).toBe(0)
        expect(deleted.ran).toEqual([])
        expect(deleted.stdout).toContain('nothing dispatched')

        const unknown = fixture.run('no-such-revision')
        expect(unknown.status).not.toBe(0)
        expect(unknown.ran).toEqual([])
    })
})
