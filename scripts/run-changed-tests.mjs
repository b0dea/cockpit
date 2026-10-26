import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestsCli } from './run-tests.mjs'

export const mechanism = {
    id: 'changed-adjacent-owner-tests', module: 'scripts/run-changed-tests.mjs', exports: ['runChangedTestsCli'],
}

const TEST_PATH = /^packages\/[^/]+\/src\/.+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/
const SOURCE_PATH = /^(packages\/[^/]+\/src\/.+)\.([cm]?[jt]s|[jt]sx)$/
const DOCUMENTATION_PATH = /^(?:[^/]+|docs\/.+)\.md$/
const GENERATED_FIXTURES = 'packages/cockpit/test-support/generated-fixtures.ts'
const GENERATED_COMMAND_TEST = /^command(?:\..+)?\.test\.ts$/

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
    if (!base || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base) || /^0+$/.test(base)) {
        throw new Error('usage: node scripts/run-changed-tests.mjs <40-or-64-character-base-commit> [--extra-test <test-path>]...')
    }
    const extraTests = []
    for (let index = 0; index < rest.length; index += 2) {
        if (rest[index] !== '--extra-test' || !rest[index + 1]) throw new Error('extra affected owners require --extra-test <test-path>')
        extraTests.push(rest[index + 1])
    }
    return { base, extraTests }
}

function changedPaths(root, base) {
    if (git(root, ['cat-file', '-t', base]).trim() !== 'commit') throw new Error('base does not identify a commit')
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: root, stdio: 'ignore' })
    if (ancestor.status !== 0) throw new Error('base must be an ancestor of HEAD')
    const tracked = git(root, ['diff', '--no-renames', '--name-only', '-z', '--diff-filter=ACDMRTUXB', base, '--']).split('\0').filter(Boolean)
    const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    return [...new Set([...tracked, ...untracked])].sort()
}

function ownerTests(root, paths, extras) {
    const selected = new Set()
    const unmapped = []
    let sourceChanged = false
    for (const path of paths) {
        if (path === GENERATED_FIXTURES) {
            const directory = 'packages/cockpit/src/generated-environment'
            for (const name of readdirSync(resolve(root, directory)).filter(name => GENERATED_COMMAND_TEST.test(name))) {
                const candidate = posix.join(directory, name)
                if (existingFile(root, candidate)) selected.add(candidate)
            }
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
            else unmapped.push(path)
            continue
        }
        if (!DOCUMENTATION_PATH.test(path)) unmapped.push(path)
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
