import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `vitest --changed <base>` selects every test whose import graph reaches a changed file, in both
// tiers, deleted files and shared test configuration included. It cannot see a test that reads a
// file by path (a manifest, a workflow, a shipped template, a fixture, the dependency rules) or one
// that owns prose; this script adds those owners to vitest's own selection and runs them together.
const TEST_PATH = /^packages\/[^/]+\/src\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/
const SOURCE_MODULE = /^packages\/[^/]+\/src\/.+\.[cm]?tsx?$/
const CHANGESET_FRAGMENT = /^\.changeset\/(?!README\.md$)[^/]+\.md$/
const SRC = 'packages/cockpit/src/'
// Shipped templates are rendered by the surfaces tests without being imported by them.
const SURFACE_TEMPLATE = /^packages\/[^/]+\/surfaces\//
// Fixed owners of the files that tests reach without importing them.
const FIXED_OWNERS = [
    [CHANGESET_FRAGMENT, [`${SRC}docs-lint.test.ts`]],
    // A release fragment is checked by the lint owner alone. Other Markdown can affect lint contracts, fact ownership and runnable examples.
    [/^(?!\.changeset\/(?!README\.md$)).+\.md$|^llms\.txt$/, [`${SRC}docs-lint.test.ts`, `${SRC}docs-ownership.test.ts`, `${SRC}example-cockpit.test.ts`, `${SRC}example-cockpit.slow.test.ts`]],
    // A package.json change already re-runs everything under Vitest's default rerun triggers.
    [/^package-lock\.json$/, [`${SRC}packaging.slow.test.ts`, `${SRC}supply-chain.test.ts`]],
    [/^\.github\//, [`${SRC}supply-chain.test.ts`, `${SRC}docs-lint.test.ts`, `${SRC}test-protection.test.ts`]],
    // Source changes can break an import-graph rule anywhere, so the architecture test always runs.
    [SOURCE_MODULE, [`${SRC}architecture.test.ts`]],
]

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

// What a test that reads the file by name would contain: the path, the name, or for a fixture or
// example the directory that holds it.
function needles(path) {
    const directory = /^(?:fixtures|examples)\/[^/]+/.exec(path)?.[0]
    return [path, basename(path), ...(directory ? [directory] : [])]
}

function ownersOutsideImportGraph(changed, tests, read) {
    const owners = new Set()
    for (const path of changed) {
        for (const [pattern, fixed] of FIXED_OWNERS) if (pattern.test(path)) for (const test of fixed) owners.add(test)
        if (SURFACE_TEMPLATE.test(path)) for (const test of tests) if (test.startsWith(`${SRC}surfaces/`)) owners.add(test)
        if (TEST_PATH.test(path) || SOURCE_MODULE.test(path)) continue
        const names = needles(path)
        for (const test of tests) if (names.some(name => read(test).includes(name))) owners.add(test)
    }
    return owners
}

function runChangedTestsCli(argv) {
    const [base, ...rest] = argv
    if (!base || base.startsWith('-')) {
        console.error('CHANGED_TEST_SELECTION_INVALID: usage: npm run test:changed -- <base-commit-ish> [vitest options]')
        return 2
    }
    try {
        const root = git(['rev-parse', '--show-toplevel']).trim()
        const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
        const run = (args, stdio) => spawnSync(process.execPath, [vitest, ...args], { cwd: root, stdio, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        const listed = run(['list', '--filesOnly', '--json', '--changed', base], ['ignore', 'pipe', 'inherit'])
        if (listed.status !== 0) return listed.status ?? 2
        const selected = new Set(JSON.parse(listed.stdout).map(({ file }) => relative(root, file)))

        const changed = [...new Set([
            ...git(['diff', '--no-renames', '--name-only', '-z', base, '--']).split('\0'),
            ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0'),
        ])].filter(Boolean)
        const tests = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages/*/src/**']).split('\0')
            .filter(path => TEST_PATH.test(path) && existsSync(resolve(root, path)))
        const texts = new Map()
        const read = path => texts.get(path) ?? texts.set(path, readFileSync(resolve(root, path), 'utf8')).get(path)
        for (const owner of ownersOutsideImportGraph(changed, tests, read)) if (tests.includes(owner)) selected.add(owner)

        if (selected.size === 0) {
            console.log('changed tests: no test owns a changed file; nothing dispatched')
            return 0
        }
        console.log(`changed tests: ${selected.size} files`)
        // Positional filters are path substrings, so a full path selects exactly that file.
        return run(['run', ...selected, ...rest], 'inherit').status ?? 2
    } catch (error) {
        console.error(`CHANGED_TEST_SELECTION_INVALID: ${error instanceof Error ? error.message : String(error)}`)
        return 2
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exitCode = runChangedTestsCli(process.argv.slice(2))
}
