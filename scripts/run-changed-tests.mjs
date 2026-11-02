import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestsCli } from './run-tests.mjs'

export const mechanism = {
    id: 'changed-adjacent-owner-tests', module: 'scripts/run-changed-tests.mjs', exports: ['SLOW_TEST_PATH', 'runChangedTestsCli'],
}

const TEST_PATH = /^packages\/[^/]+\/src\/.+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/
// The slow tier (packaging, the installed tarball, end-to-end CLI and composition runs, real Docker)
// runs in the full suite. The changed-test loop defers it unless --wide asks for it.
export const SLOW_TEST_PATH = /\.slow\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/
const SOURCE_PATH = /^(packages\/[^/]+\/src\/.+)\.([cm]?[jt]s|[jt]sx)$/
const MARKDOWN_PATH = /\.md$/
const CHANGESET_FRAGMENT = /^\.changeset\/(?!README\.md$)[^/]+\.md$/
// llms.txt is the Markdown index agents read first; the documentation tests check where it points.
const LLMS_INDEX = 'llms.txt'
const MANIFEST_PATH = /^(?:packages\/[^/]+\/)?package(?:-lock)?\.json$/
const SCRIPT_PATH = /^scripts\/([^/]+)\.(?:mjs|d\.mts)$/
const SURFACES_PATH = /^packages\/[^/]+\/surfaces\/.+/
const LIBEXEC_PATH = /^packages\/[^/]+\/libexec\/[^/]+$/
const FIXTURE_PATH = /^fixtures\/([^/]+)\/.+/
// Data files beside the tests that read them, e.g. packages/cockpit/src/surfaces/fixtures/one-row.toml.
const PACKAGE_FIXTURE_PATH = /^packages\/[^/]+\/src\/(?:.+\/)?fixtures\/(.+)$/
const EXAMPLE_PATH = /^examples\/([^/]+)\/.+/
const SCHEMA_ARTIFACT = 'packages/cockpit/cockpit.schema.json'
const EXAMPLE_TESTS = ['example-cockpit.test.ts', 'example-cockpit.slow.test.ts']
const MODULE_PATH = /^packages\/[^/]+\/(?:src|test-support)\/.+\.[cm]?tsx?$/
const PACKAGE_SCRIPT_MODULE_PATH = /^packages\/[^/]+\/scripts\/.+\.[cm]?js$/
const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g
const TEST_DIRECTORY = 'packages/cockpit/src'
// General Markdown can affect lint contracts, fact ownership, and runnable examples.
const DOCUMENTATION_TESTS = [/^docs-lint(?:\..+)?\.test\.ts$/, /^docs-ownership\.test\.ts$/, /^example-cockpit(?:\.slow)?\.test\.ts$/]
// Release fragments cannot change linter mechanisms or runnable examples; lint:docs validates
// their bytes while the prose owner pins their estate.
const CHANGESET_FRAGMENT_TEST = 'docs-lint.prose.test.ts'
const MANIFEST_TESTS = ['packaging.slow.test.ts', 'supply-chain.test.ts']
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
        throw new Error('usage: node scripts/run-changed-tests.mjs <base-commit-ish> [--list] [--wide] [--extra-test <test-path>]...; '
            + '--wide also runs the slow tier and every test that imports a changed file, directly or through other modules')
    }
    const extraTests = []
    const flags = new Set()
    for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--list' || rest[index] === '--wide') {
            if (flags.has(rest[index])) throw new Error(`${rest[index]} was provided more than once`)
            flags.add(rest[index])
            continue
        }
        if (rest[index] !== '--extra-test' || !rest[index + 1] || rest[index + 1].startsWith('-')) {
            throw new Error('extra affected owners require --extra-test <test-path>')
        }
        extraTests.push(rest[++index])
    }
    return { base, extraTests, list: flags.has('--list'), wide: flags.has('--wide') }
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

// A test reaches a script through the scripts that import it as well (docs-lint.mjs re-exports
// diagnostic-inventory.mjs), so the tests naming any of those importers own it too.
function testsReferencingScript(root, name) {
    const scripts = readdirSync(resolve(root, 'scripts')).filter(entry => entry.endsWith('.mjs'))
        .map(entry => entry.slice(0, -'.mjs'.length))
    const visited = new Set([name])
    const pending = [name]
    const tests = new Set()
    while (pending.length) {
        const current = pending.pop()
        for (const test of testsReferencing(root, `${current}.mjs`)) tests.add(test)
        for (const importer of scripts) {
            if (visited.has(importer) || !readFileSync(resolve(root, 'scripts', `${importer}.mjs`), 'utf8').includes(`./${current}.mjs`)) continue
            visited.add(importer)
            pending.push(importer)
        }
    }
    return [...tests]
}

// Fixture readers can be shared through several helpers; use the same exact import graph as sources.
function testsReadingFixtures(root, needle, imports) {
    const readers = walkFiles(root, 'packages')
        .filter(path => /\.ts$/.test(path) && /\/(?:src|test-support)\//.test(path))
        .filter(path => readFileSync(resolve(root, path), 'utf8').includes(needle))
    return [...new Set(readers.flatMap(path => TEST_PATH.test(path) ? [path] : testsImporting(root, imports, path)))]
}

// A libexec program is spawned or required by path, never imported, so its owners are the tests
// that name it, the owners of modules that name it, and the owners of programs that name it.
function testsNamingLibexecProgram(root, program, imports) {
    const directory = dirname(program)
    const programs = readdirSync(resolve(root, directory)).map(name => posix.join(directory, name))
        .filter(path => existingFile(root, path))
    const modules = walkFiles(root, 'packages').filter(path => /\.ts$/.test(path) && /\/(?:src|test-support)\//.test(path))
    const tests = new Set()
    const visited = new Set([program])
    const pending = [program]
    while (pending.length) {
        const name = basename(pending.pop())
        for (const path of modules.filter(candidate => readFileSync(resolve(root, candidate), 'utf8').includes(name))) {
            const owners = TEST_PATH.test(path) ? [path] : SOURCE_PATH.test(path) ? sourceOwners(root, path, () => imports, imports.wide) : testsImporting(root, imports, path)
            for (const test of owners) tests.add(test)
        }
        for (const path of programs.filter(candidate => !visited.has(candidate) && readFileSync(resolve(root, candidate), 'utf8').includes(name))) {
            visited.add(path)
            pending.push(path)
        }
    }
    return [...tests]
}

// A source file whose tests carry another name is owned by the tests that import it, directly or
// through re-exports and test-support helpers. Static specifiers are
// resolved against the importing file, so a same-named file in another directory never matches.
function importedModules(root, wide) {
    const imports = new Map()
    for (const path of walkFiles(root, 'packages').filter(candidate =>
        (MODULE_PATH.test(candidate) || PACKAGE_SCRIPT_MODULE_PATH.test(candidate)) && !candidate.endsWith('.d.ts'))) {
        const targets = new Set()
        for (const match of readFileSync(resolve(root, path), 'utf8').matchAll(IMPORT_SPECIFIER)) {
            targets.add(posix.join(dirname(path), match[1]).replace(MODULE_EXTENSION, ''))
        }
        imports.set(path, targets)
    }
    return { modules: imports, wide }
}

// The walk stops at an importer with adjacent tests: those tests own the path through it. Walking
// on past it selected every test above a widely imported module (one guard helper reached most
// of the suite through the CLI), which is the full suite under another name. --wide walks on.
function testsImporting(root, imports, source) {
    const importers = module => {
        const stem = module.replace(MODULE_EXTENSION, '')
        const names = new Set([stem, stem.replace(/\/index$/, '')])
        return [...imports.modules].filter(([, targets]) => [...names].some(name => targets.has(name))).map(([path]) => path)
    }
    const visited = new Set([source])
    const pending = [source]
    const tests = new Set()
    while (pending.length) {
        for (const path of importers(pending.pop())) {
            if (visited.has(path)) continue
            visited.add(path)
            if (TEST_PATH.test(path)) {
                tests.add(path)
                continue
            }
            // An importer whose adjacent tests are all slow does not stop the walk: stopping there
            // would leave the change with no fast owner above it.
            const adjacent = imports.wide ? [] : adjacentTests(root, path)
            for (const test of adjacent) tests.add(test)
            if (!adjacent.some(test => !SLOW_TEST_PATH.test(test))) pending.push(path)
        }
    }
    return [...tests]
}

function adjacentTests(root, path) {
    const source = SOURCE_PATH.exec(path)
    if (!source || TEST_PATH.test(path)) return []
    const directory = dirname(source[1])
    const stem = basename(source[1])
    return readdirSync(resolve(root, directory))
        .filter(name => name === `${stem}.test.${source[2]}` || name === `${stem}.spec.${source[2]}`
            || (name.startsWith(`${stem}.`) && (name.endsWith(`.test.${source[2]}`) || name.endsWith(`.spec.${source[2]}`))))
        .map(name => posix.join(directory, name))
        .filter(candidate => existingFile(root, candidate))
}

// A source file is owned by its adjacent tests. When none of them is fast, or --wide asks for every
// test above the change, the tests that import it own it too, by the same walk as an importer's.
function sourceOwners(root, path, imports, wide) {
    const adjacent = adjacentTests(root, path)
    return wide || !adjacent.some(test => !SLOW_TEST_PATH.test(test)) ? [...adjacent, ...testsImporting(root, imports(), path)] : adjacent
}

function ownerTests(root, paths, extras, wide) {
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
            imports ??= importedModules(root, wide)
            for (const test of testsImporting(root, imports, path)) selected.add(test)
            continue
        }
        if (TEST_PATH.test(path)) {
            if (existingFile(root, path)) selected.add(path)
            else unmapped.push(path)
            continue
        }
        if (SOURCE_PATH.test(path)) {
            sourceChanged = true
            const owners = sourceOwners(root, path, () => imports ??= importedModules(root, wide), wide)
            if (owners.length) for (const candidate of owners) selected.add(candidate)
            else unmapped.push(path)
            continue
        }
        const script = SCRIPT_PATH.exec(path)
        const fixture = FIXTURE_PATH.exec(path)
        const packageFixture = PACKAGE_FIXTURE_PATH.exec(path)
        const example = EXAMPLE_PATH.exec(path)
        const mapped = []
        if (MODULE_PATH.test(path) || PACKAGE_SCRIPT_MODULE_PATH.test(path)) {
            imports ??= importedModules(root, wide)
            mapped.push(...testsImporting(root, imports, path))
        }
        if (CHANGESET_FRAGMENT.test(path)) mapped.push(...testsInDirectory(root, [CHANGESET_FRAGMENT_TEST]))
        else if (MARKDOWN_PATH.test(path) || path === LLMS_INDEX) mapped.push(...testsInDirectory(root, DOCUMENTATION_TESTS))
        if (MANIFEST_PATH.test(path)) mapped.push(...testsInDirectory(root, MANIFEST_TESTS))
        if (path.startsWith('.github/')) mapped.push(...testsInDirectory(root, WORKFLOW_TESTS))
        if (SURFACES_PATH.test(path)) {
            mapped.push(...packageTestFiles(root).filter(candidate => candidate.startsWith(`${TEST_DIRECTORY}/surfaces/`)))
        }
        if (script) mapped.push(...testsReferencingScript(root, script[1]))
        if (LIBEXEC_PATH.test(path)) {
            imports ??= importedModules(root, wide)
            mapped.push(...testsNamingLibexecProgram(root, path, imports))
        }
        if (path === SCHEMA_ARTIFACT) mapped.push(...testsReferencing(root, 'cockpit.schema.json'))
        if (example && !MARKDOWN_PATH.test(path)) {
            mapped.push(...testsReferencing(root, `examples/${example[1]}`), ...testsInDirectory(root, EXAMPLE_TESTS))
        }
        if (fixture || packageFixture) {
            imports ??= importedModules(root, wide)
            mapped.push(...testsReadingFixtures(root, fixture ? `fixtures/${fixture[1]}` : `fixtures/${packageFixture[1]}`, imports))
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
        const { base, extraTests, list, wide } = parseArguments(argv)
        const root = repositoryRoot()
        const paths = changedPaths(root, base)
        const owners = ownerTests(root, paths, extraTests, wide)
        if (owners.unmapped.length) {
            for (const path of owners.unmapped) console.error(`CHANGED_TEST_OWNER_UNMAPPED: ${path}`)
            console.error('adjacent-owner tests refused before dispatch; --extra-test adds supplemental affected owners but does not resolve an unmapped path')
            return 2
        }
        // An owner named with --extra-test was asked for, so it runs whatever its tier.
        const deferred = wide ? [] : owners.selected.filter(path => SLOW_TEST_PATH.test(path) && !extraTests.includes(path))
        const dispatched = owners.selected.filter(path => !deferred.includes(path))
        const reportDeferred = () => {
            if (!deferred.length) return
            console.error(`Slow-tier owners not run (${deferred.length}); npm test runs them, or rerun with --wide:`)
            console.error(`npm test -- ${deferred.join(' ')}`)
        }
        if (list) {
            console.log(JSON.stringify(dispatched))
            reportDeferred()
            return 0
        }
        if (!dispatched.length) {
            console.log(owners.selected.length
                ? 'adjacent-owner tests: every changed owner is in the slow tier; no tests dispatched'
                : 'adjacent-owner tests: no executable or test owners changed; no tests dispatched')
            reportDeferred()
            return 0
        }
        console.log(`adjacent-owner tests: ${dispatched.length} owner files`)
        for (const path of dispatched) console.log(path)
        console.log('Adjacent tests only; review non-adjacent dependents and shared seams separately.')
        const status = await runTestsCli(dispatched, { root })
        reportDeferred()
        return status
    } catch (error) {
        console.error(`CHANGED_TEST_SELECTION_INVALID: ${error instanceof Error ? error.message : String(error)}`)
        return 2
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exitCode = await runChangedTestsCli(process.argv.slice(2))
}
