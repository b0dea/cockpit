import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestsCli } from './run-tests.mjs'

export const mechanism = {
    id: 'changed-adjacent-owner-tests', module: 'scripts/run-changed-tests.mjs', exports: ['runChangedTestsCli'],
}

const TEST_PATH = /^packages\/[^/]+\/src\/.+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/
const SOURCE_PATH = /^(packages\/[^/]+\/src\/.+)\.([cm]?[jt]s|[jt]sx)$/
const MARKDOWN_PATH = /\.md$/
const CHANGESET_FRAGMENT = /^\.changeset\/(?!README\.md$)[^/]+\.md$/
// llms.txt is the Markdown index agents read first; the documentation tests check where it points.
const LLMS_INDEX = 'llms.txt'
const MANIFEST_PATH = /^(?:packages\/[^/]+\/)?package(?:-lock)?\.json$/
const SCRIPT_PATH = /^scripts\/([^/]+)\.(?:mjs|d\.mts)$/
const SURFACES_PATH = /^packages\/[^/]+\/surfaces\/.+/
const FIXTURE_PATH = /^fixtures\/([^/]+)\/.+/
const EXAMPLE_PATH = /^examples\/([^/]+)\/.+/
const SCHEMA_ARTIFACT = 'packages/cockpit/cockpit.schema.json'
const EXAMPLE_TEST = 'example-cockpit.test.ts'
const MODULE_PATH = /^packages\/[^/]+\/(?:src|test-support)\/.+\.[cm]?tsx?$/
const PACKAGE_SCRIPT_MODULE_PATH = /^packages\/[^/]+\/scripts\/.+\.[cm]?js$/
const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g
const TEST_DIRECTORY = 'packages/cockpit/src'
// General Markdown can affect lint contracts, fact ownership, and runnable examples.
const DOCUMENTATION_TESTS = [/^docs-lint(?:\..+)?\.test\.ts$/, /^docs-ownership\.test\.ts$/, /^example-cockpit\.test\.ts$/]
// Release fragments cannot change linter mechanisms or runnable examples; lint:docs validates
// their bytes while the prose owner pins their estate.
const CHANGESET_FRAGMENT_TEST = 'docs-lint.prose.test.ts'
const MANIFEST_TESTS = ['packaging.test.ts', 'supply-chain.test.ts']
const WORKFLOW_TESTS = ['supply-chain.test.ts', 'docs-lint.contracts.test.ts', 'test-protection.test.ts']
const GENERATED_FIXTURES = 'packages/cockpit/test-support/generated-fixtures.ts'
const GENERATED_COMMAND_TEST = /^command(?:\..+)?\.test\.ts$/
const SHARED_TEST_CONFIGURATION = new Set(['vitest.config.ts', 'packages/cockpit/src/test-support/git-isolation.ts'])

function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function repositoryRoot() {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
    if (!root || realpathSync(root) !== root) throw new Error('repository root is not canonical')
    return root
}

function existingFile(root, path) {
    const absolute = resolve(root, path)
    if (relative(root, absolute).startsWith(`..${sep}`) || relative(root, absolute) === '..') return false
    try {
        const status = lstatSync(absolute)
        return status.isFile() && !status.isSymbolicLink() && realpathSync(dirname(absolute)).startsWith(`${root}${sep}`)
    } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
    }
}

function parseArguments(argv) {
    const [base, ...rest] = argv
    if (!base || base.startsWith('-')) {
        throw new Error('usage: node scripts/run-changed-tests.mjs <base-commit-ish> [--extra-test <test-path>]...')
    }
    const extraTests = []
    for (let index = 0; index < rest.length; index += 2) {
        if (rest[index] !== '--extra-test' || !rest[index + 1]) throw new Error('extra affected owners require --extra-test <test-path>')
        extraTests.push(rest[index + 1])
    }
    return { base, extraTests }
}

function changedPaths(root, baseCommitIsh) {
    let base
    try {
        base = git(root, ['rev-parse', '--verify', '--quiet', `${baseCommitIsh}^{commit}`]).trim()
    } catch (error) {
        throw new Error(`base does not identify a commit: ${baseCommitIsh} (${error.status === 1 ? 'unknown revision' : error.message})`)
    }
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: root, stdio: 'ignore' })
    if (ancestor.status !== 0) throw new Error('base must be an ancestor of HEAD')
    const tracked = git(root, ['diff', '--no-renames', '--name-only', '-z', '--diff-filter=ACDMRTUXB', base, '--']).split('\0').filter(Boolean)
    const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    return [...new Set([...tracked, ...untracked])].sort()
}

function walkFiles(root, directory, found = []) {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.isSymbolicLink()) continue
        const path = posix.join(directory, entry.name)
        if (entry.isDirectory()) walkFiles(root, path, found)
        else if (entry.isFile()) found.push(path)
    }
    return found
}

function packageTestFiles(root) {
    return walkFiles(root, 'packages').filter(path => TEST_PATH.test(path))
}

function testsInDirectory(root, names) {
    const directory = resolve(root, TEST_DIRECTORY)
    return readdirSync(directory)
        .filter(name => names.some(match => typeof match === 'string' ? match === name : match.test(name)))
        .map(name => posix.join(TEST_DIRECTORY, name))
        .filter(candidate => existingFile(root, candidate))
}

// Tests that name the script file, found by reading the tests rather than keeping a second list.
function testsReferencing(root, needle) {
    return packageTestFiles(root).filter(path => readFileSync(resolve(root, path), 'utf8').includes(needle))
}

// Fixture readers can be shared through several helpers; use the same exact import graph as sources.
function testsReadingFixtures(root, directory, imports) {
    const needle = `fixtures/${directory}`
    const readers = walkFiles(root, 'packages')
        .filter(path => /\.ts$/.test(path) && /\/(?:src|test-support)\//.test(path))
        .filter(path => readFileSync(resolve(root, path), 'utf8').includes(needle))
    return [...new Set(readers.flatMap(path => TEST_PATH.test(path) ? [path] : testsImporting(imports, path)))]
}

// A source file whose tests carry another name is owned by the tests that import it, directly or
// through re-exports and test-support helpers. Static specifiers are
// resolved against the importing file, so a same-named file in another directory never matches.
function importedModules(root) {
    const imports = new Map()
    for (const path of walkFiles(root, 'packages').filter(candidate =>
        (MODULE_PATH.test(candidate) || PACKAGE_SCRIPT_MODULE_PATH.test(candidate)) && !candidate.endsWith('.d.ts'))) {
        const targets = new Set()
        for (const match of readFileSync(resolve(root, path), 'utf8').matchAll(IMPORT_SPECIFIER)) {
            targets.add(posix.join(dirname(path), match[1]).replace(MODULE_EXTENSION, ''))
        }
        imports.set(path, targets)
    }
    return imports
}

function testsImporting(imports, source) {
    const importers = module => {
        const stem = module.replace(MODULE_EXTENSION, '')
        const names = new Set([stem, stem.replace(/\/index$/, '')])
        return [...imports].filter(([, targets]) => [...names].some(name => targets.has(name))).map(([path]) => path)
    }
    const visited = new Set([source])
    const pending = [source]
    const tests = new Set()
    while (pending.length) {
        for (const path of importers(pending.pop())) {
            if (visited.has(path)) continue
            visited.add(path)
            if (TEST_PATH.test(path)) tests.add(path)
            else pending.push(path)
        }
    }
    return [...tests]
}

function ownerTests(root, paths, extras) {
    const selected = new Set()
    const unmapped = []
    let sourceChanged = false
    let imports
    for (const path of paths) {
        if (SHARED_TEST_CONFIGURATION.has(path)) {
            for (const test of packageTestFiles(root)) selected.add(test)
            continue
        }
        if (path === GENERATED_FIXTURES) {
            const directory = 'packages/cockpit/src/generated-environment'
            for (const name of readdirSync(resolve(root, directory)).filter(name => GENERATED_COMMAND_TEST.test(name))) {
                const candidate = posix.join(directory, name)
                if (existingFile(root, candidate)) selected.add(candidate)
            }
            imports ??= importedModules(root)
            for (const test of testsImporting(imports, path)) selected.add(test)
            continue
        }
        if (TEST_PATH.test(path)) {
            if (existingFile(root, path)) selected.add(path)
            else unmapped.push(path)
            continue
        }
        const source = SOURCE_PATH.exec(path)
        if (source && !TEST_PATH.test(path)) {
            sourceChanged = true
            const directory = dirname(source[1])
            const stem = basename(source[1])
            const candidates = readdirSync(resolve(root, directory))
                .filter(name => name === `${stem}.test.${source[2]}` || name === `${stem}.spec.${source[2]}`
                    || (name.startsWith(`${stem}.`) && (name.endsWith(`.test.${source[2]}`) || name.endsWith(`.spec.${source[2]}`))))
                .map(name => posix.join(directory, name))
                .filter(candidate => existingFile(root, candidate))
            if (candidates.length) for (const candidate of candidates) selected.add(candidate)
            else {
                imports ??= importedModules(root)
                const importing = testsImporting(imports, path)
                if (importing.length) for (const candidate of importing) selected.add(candidate)
                else unmapped.push(path)
            }
            continue
        }
        const script = SCRIPT_PATH.exec(path)
        const fixture = FIXTURE_PATH.exec(path)
        const example = EXAMPLE_PATH.exec(path)
        const mapped = []
        if (MODULE_PATH.test(path) || PACKAGE_SCRIPT_MODULE_PATH.test(path)) {
            imports ??= importedModules(root)
            mapped.push(...testsImporting(imports, path))
        }
        if (CHANGESET_FRAGMENT.test(path)) mapped.push(...testsInDirectory(root, [CHANGESET_FRAGMENT_TEST]))
        else if (MARKDOWN_PATH.test(path) || path === LLMS_INDEX) mapped.push(...testsInDirectory(root, DOCUMENTATION_TESTS))
        if (MANIFEST_PATH.test(path)) mapped.push(...testsInDirectory(root, MANIFEST_TESTS))
        if (path.startsWith('.github/')) mapped.push(...testsInDirectory(root, WORKFLOW_TESTS))
        if (SURFACES_PATH.test(path)) {
            mapped.push(...packageTestFiles(root).filter(candidate => candidate.startsWith(`${TEST_DIRECTORY}/surfaces/`)))
        }
        if (script) mapped.push(...testsReferencing(root, `${script[1]}.mjs`))
        if (path === SCHEMA_ARTIFACT) mapped.push(...testsReferencing(root, 'cockpit.schema.json'))
        if (example && !MARKDOWN_PATH.test(path)) {
            mapped.push(...testsReferencing(root, `examples/${example[1]}`), ...testsInDirectory(root, [EXAMPLE_TEST]))
        }
        if (fixture) {
            imports ??= importedModules(root)
            mapped.push(...testsReadingFixtures(root, fixture[1], imports))
        }
        if (mapped.length) for (const candidate of mapped) selected.add(candidate)
        else unmapped.push(path)
    }
    for (const path of extras) {
        if (posix.normalize(path) !== path || !TEST_PATH.test(path) || !existingFile(root, path)) {
            throw new Error(`extra owner is not one existing package test: ${path}`)
        }
        selected.add(path)
    }
    if (sourceChanged) {
        const architecture = 'packages/cockpit/src/architecture-contract.test.ts'
        if (!existingFile(root, architecture)) unmapped.push(architecture)
        else selected.add(architecture)
    }
    return { selected: [...selected].sort(), unmapped: [...new Set(unmapped)].sort() }
}

export async function runChangedTestsCli(argv) {
    try {
        const { base, extraTests } = parseArguments(argv)
        const root = repositoryRoot()
        const paths = changedPaths(root, base)
        const owners = ownerTests(root, paths, extraTests)
        if (owners.unmapped.length) {
            for (const path of owners.unmapped) console.error(`CHANGED_TEST_OWNER_UNMAPPED: ${path}`)
            console.error('adjacent-owner tests refused before dispatch; --extra-test adds supplemental affected owners but does not resolve an unmapped path')
            return 2
        }
        if (!owners.selected.length) {
            console.log('adjacent-owner tests: no executable or test owners changed; no tests dispatched')
            return 0
        }
        console.log(`adjacent-owner tests: ${owners.selected.length} owner files`)
        for (const path of owners.selected) console.log(path)
        console.log('Adjacent tests only; review non-adjacent dependents and shared seams separately.')
        return await runTestsCli(owners.selected, { root })
    } catch (error) {
        console.error(`CHANGED_TEST_SELECTION_INVALID: ${error instanceof Error ? error.message : String(error)}`)
        return 2
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exitCode = await runChangedTestsCli(process.argv.slice(2))
}
