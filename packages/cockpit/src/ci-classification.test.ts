import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// The release workflow publishes beside CI, so only a pull request's required check can stop it, and
// this step alone decides which cells that check waits for. These run the workflow's own step text
// against a real repository, with the registry and the GitHub API standing in on PATH.
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))
const workflow = readFileSync(join(REPOSITORY, '.github/workflows/ci.yml'), 'utf8')
const from = workflow.indexOf('HEAD_REF: ${{ github.head_ref }}')
const step = /\n {8}run: \|\n(?<body>(?: {10}.*\n|\n)+)/.exec(workflow.slice(from))?.groups?.body ?? ''
const SLUG = 'synthetic/cockpit'
const LINUX = ['1/4', '2/4', '3/4', '4/4'].map(shard => `ubuntu-latest, node 22.22.0, full ${shard}`)
const PLATFORMS = ['macos-latest, node 22.22.0, full', 'ubuntu-latest, node 24, compatibility', 'ubuntu-latest, node 26, compatibility']
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const scratch = (name: string) => {
    const root = mkdtempSync(join(tmpdir(), `ci-classification-${name}-`))
    roots.push(root)
    return root
}
const manifest = (version: string) => `{\n  "name": "synthetic",\n  "version": "${version}"\n}\n`
const BASE_FILES: Record<string, string> = {
    'packages/cockpit/package.json': manifest('1.0.0'),
    'README.md': 'base\n',
    'src.ts': 'base\n',
    '.changeset/pending.md': 'pending\n',
    'CHANGELOG.md': 'base\n',
    '.github/scripts/check-version-pr-scope.sh': readFileSync(join(REPOSITORY, '.github/scripts/check-version-pr-scope.sh'), 'utf8'),
    '.github/scripts/tested-tree.mjs': readFileSync(join(REPOSITORY, '.github/scripts/tested-tree.mjs'), 'utf8'),
}
const VERSION_BUMP = { 'packages/cockpit/package.json': manifest('1.1.0'), 'CHANGELOG.md': 'release\n', '.changeset/pending.md': null }

type Cell = { os: string; node: string; gate: string; shard?: string }
// How the test job's name spells its matrix row, and so what tested-tree.mjs reads back.
const cellName = ({ os, node, gate, shard }: Cell) => `${os}, node ${node}, ${gate}${shard ? ` ${shard}` : ''}`
/** A ci.yml run the API reports. By default a push to the default branch, whose head commit has the tree of its sha. */
type Run = Readonly<{ sha: string; jobs: readonly { name: string; conclusion?: string }[]; conclusion?: string; path?: string; repository?: string
    event?: 'push' | 'pull_request'; branch?: string; base?: string; tree?: string }>
const cellJobs = (cells: readonly string[], tree: string) => cells.map(cell => ({ name: `test (${cell}) tree ${tree}` }))
const CI_OK = { name: 'ci-ok' }
/** The trees and commits of the last commit and its parent, and the first commit's when `before` puts one between them. */
type Trees = { base: string; head: string; start: string; baseSha: string; headSha: string; startSha: string }

type Scenario = Readonly<{
    changed: Record<string, string | null>
    env?: Record<string, string>
    published?: string | null
    /** The whole stand-in npm, for a case that depends on how it was called. */
    npm?: string
    /** Runs the API reports, from the base and head trees; `null` makes every API call fail. */
    runs?: ((trees: Trees) => readonly Run[]) | null
    baseFiles?: Record<string, string>
    /** A commit between the base files and `changed`, so the last commit's parent is not the base. */
    before?: Record<string, string | null>
}>

function scenario(options: Scenario) {
    const root = scratch('repository')
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], { encoding: 'utf8' }).trim()
    const write = (files: Record<string, string | null>) => {
        for (const [path, bytes] of Object.entries(files)) {
            if (bytes === null) rmSync(join(root, path))
            else { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes) }
        }
        git('add', '-A')
        git('commit', '--quiet', '--allow-empty', '-m', 'synthetic')
    }
    git('init', '--quiet')
    write(options.baseFiles ?? BASE_FILES)
    if (options.before) write(options.before)
    write(options.changed)
    const startSha = git('rev-list', '--max-parents=0', 'HEAD')
    const trees = { base: git('rev-parse', 'HEAD^^{tree}'), head: git('rev-parse', 'HEAD^{tree}'), start: git('rev-parse', `${startSha}^{tree}`),
        baseSha: git('rev-parse', 'HEAD^'), headSha: git('rev-parse', 'HEAD'), startSha }

    const bin = scratch('bin')
    const fixtures = scratch('fixtures')
    const published = options.published === undefined ? '1.0.0' : options.published
    writeFileSync(join(bin, 'npm'), options.npm ?? (published === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${published}\n`), { mode: 0o700 })
    // A path with no fixture fails like an unreachable API.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nf="${fixtures}/$(printf '%s' "$2" | tr '/?&=' '____')"\n[ -f "$f" ] && exec cat "$f"\nexit 1\n`, { mode: 0o700 })
    const fixture = (path: string, value: unknown, directory = fixtures) => writeFileSync(join(directory, path.replace(/[/?&=]/g, '_')), JSON.stringify(value))
    if (options.runs !== null) {
        const runs = options.runs?.(trees) ?? []
        const treeOf = (sha: string) => sha === trees.baseSha ? trees.base : sha === trees.headSha ? trees.head : trees.start
        fixture(`repos/${SLUG}`, { default_branch: 'main' })
        for (const sha of new Set([trees.startSha, trees.baseSha, trees.headSha])) {
            fixture(`repos/${SLUG}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`, { workflow_runs: runs.flatMap((run, index) => run.sha === sha ? [{
                id: index + 1, path: run.path ?? '.github/workflows/ci.yml', conclusion: run.conclusion ?? 'success', head_repository: { full_name: run.repository ?? SLUG },
                event: run.event ?? 'push', head_branch: run.branch ?? 'main', head_commit: { id: sha, tree_id: run.tree ?? treeOf(sha) },
                pull_requests: run.event === 'pull_request' ? [{ base: { ref: run.base ?? 'main' } }] : [],
            }] : []) })
        }
        runs.forEach((run, index) => fixture(`repos/${SLUG}/actions/runs/${index + 1}/jobs?per_page=100`, { jobs: run.jobs.map(job => ({ conclusion: 'success', ...job })) }))
    }
    return { root, trees, bin, fixtures, fixture, env: { ...process.env, GITHUB_REPOSITORY: SLUG, PATH: `${bin}:${process.env.PATH}`, ...options.env } }
}

function classify(options: Scenario) {
    const { root, trees, env } = scenario(options)
    const output = join(scratch('output'), 'github-output')
    const ran = spawnSync('bash', ['-c', step], { cwd: root, encoding: 'utf8', env: {
        EVENT_NAME: 'pull_request', HEAD_REF: 'ordinary', MACOS_LABEL: 'false', ...env, GITHUB_OUTPUT: output, RUNNER_TEMP: scratch('temp') } })
    expect(ran.status, ran.stderr).toBe(0)
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    const cells = (JSON.parse(values.cells!) as Cell[]).map(cellName)
    return { code: values.code, smoke: values.smoke, tree: values.tree, cells, trees }
}
const everyCellPassedOnBase = ({ base, baseSha }: { base: string; baseSha: string }) => [{ sha: baseSha, jobs: cellJobs([...LINUX, ...PLATFORMS], base) }]

describe('a version-only pull request', () => {
    it('gets only the scope check and the package smoke, from any branch, once its base passed every cell', () => {
        expect(classify({ changed: VERSION_BUMP, runs: everyCellPassedOnBase })).toMatchObject({ code: 'false', smoke: 'true', cells: [] })
        expect(classify({ changed: VERSION_BUMP, runs: everyCellPassedOnBase, env: { HEAD_REF: 'changeset-release/main' } }))
            .toMatchObject({ code: 'false', smoke: 'true', cells: [] })
    })

    it.each([
        ['a source file', { ...VERSION_BUMP, 'src.ts': 'hidden\n' }],
        ['a dependency beside the version', { ...VERSION_BUMP, 'packages/cockpit/package.json': manifest('1.1.0').replace('"synthetic",', '"synthetic",\n  "dependencies": { "extra": "1.0.0" },') }],
        ['the guard itself', { ...VERSION_BUMP, '.github/scripts/check-version-pr-scope.sh': 'exit 0\n' }],
        ['an added changeset', { ...VERSION_BUMP, '.changeset/another.md': 'added\n' }],
        ['a deleted file that is no changeset', { ...VERSION_BUMP, 'README.md': null }],
    ])('falls back to the full matrix on the version branch when it also changes %s', (_name, changed) => {
        expect(classify({ changed, runs: everyCellPassedOnBase, env: { HEAD_REF: 'changeset-release/main' } }))
            .toMatchObject({ code: 'true', smoke: 'false', cells: [...LINUX, ...PLATFORMS] })
    })

    it.each([
        ['no run reports its base', () => []],
        ['the macOS cell did not pass on its base', ({ base, baseSha }: { base: string; baseSha: string }) => [{ sha: baseSha, jobs: [...cellJobs([...LINUX, ...PLATFORMS.slice(1)], base), { name: `test (${PLATFORMS[0]}) tree ${base}`, conclusion: 'failure' }] }]],
        ['the cells passed on another tree', ({ baseSha }: { baseSha: string }) => [{ sha: baseSha, jobs: cellJobs([...LINUX, ...PLATFORMS], 'a'.repeat(40)) }]],
        ['the run that holds them failed', ({ base, baseSha }: { base: string; baseSha: string }) => [{ sha: baseSha, conclusion: 'failure', jobs: cellJobs([...LINUX, ...PLATFORMS], base) }]],
        ['the run came from a fork', ({ base, baseSha }: { base: string; baseSha: string }) => [{ sha: baseSha, repository: 'stranger/cockpit', jobs: cellJobs([...LINUX, ...PLATFORMS], base) }]],
        ['the run is another workflow', ({ base, baseSha }: { base: string; baseSha: string }) => [{ sha: baseSha, path: '.github/workflows/other.yml', jobs: cellJobs([...LINUX, ...PLATFORMS], base) }]],
        // A branch's own ci.yml names its jobs, and which base a pull request run merged with cannot be proven once it closes.
        ['the run is a pull request, even into the default branch', ({ base, baseSha }: Trees) => [{ sha: baseSha, event: 'pull_request', jobs: cellJobs([...LINUX, ...PLATFORMS], base) }]],
        ['the run is a push to another branch', ({ base, baseSha }: Trees) => [{ sha: baseSha, branch: 'scratch', jobs: cellJobs([...LINUX, ...PLATFORMS], base) }]],
        ['the API cannot answer', null],
    ] as const)('falls back to the full matrix when %s', (_name, runs) => {
        expect(classify({ changed: VERSION_BUMP, runs: runs as never })).toMatchObject({ code: 'true', smoke: 'false', cells: [...LINUX, ...PLATFORMS] })
    })

    it('falls back to the full matrix when the base holds no guard to judge it with', () => {
        const { '.github/scripts/check-version-pr-scope.sh': _guard, ...baseFiles } = BASE_FILES
        expect(classify({ baseFiles, changed: VERSION_BUMP, runs: everyCellPassedOnBase })).toMatchObject({ smoke: 'false', cells: [...LINUX, ...PLATFORMS] })
    })

    it.each([
        ['the current version is unpublished', { published: '' }],
        ['the registry cannot answer', { published: null }],
        ['the macOS label is set', { env: { MACOS_LABEL: 'true' } }],
    ])('falls back to the full matrix when %s', (_name, options) => {
        expect(classify({ changed: VERSION_BUMP, runs: everyCellPassedOnBase, ...options })).toMatchObject({ smoke: 'false', cells: [...LINUX, ...PLATFORMS] })
    })
})

describe('any other pull request', () => {
    it.each([
        ['an ordinary change', {}, { 'src.ts': 'changed\n' }, 'true', LINUX],
        ['a manifest change that keeps the version', {}, { 'packages/cockpit/package.json': manifest('1.0.0').replace('synthetic', 'renamed') }, 'true', LINUX],
        ['a documentation change', {}, { 'README.md': 'changed\n' }, 'false', []],
        ['a change too long for one pipe write', {}, Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [`src/${String(index).padStart(60, '0')}.ts`, 'new\n'])), 'true', LINUX],
        ['the macOS label', { env: { MACOS_LABEL: 'true' } }, { 'src.ts': 'changed\n' }, 'true', [...LINUX, ...PLATFORMS]],
        // After a failed publish, the next merge is what the release workflow publishes.
        ['a documentation change while the version is unpublished', { published: '' }, { 'README.md': 'changed\n' }, 'true', [...LINUX, ...PLATFORMS]],
        ['an ordinary change when the registry cannot answer', { published: null }, { 'src.ts': 'changed\n' }, 'true', [...LINUX, ...PLATFORMS]],
        ['a version move with other changes on one manifest line', {}, { 'packages/cockpit/package.json': '{ "name": "synthetic", "version": "2.0.0" }\n', 'src.ts': 'changed\n' }, 'true', [...LINUX, ...PLATFORMS]],
    ] as const)('classifies %s', (_name, options, changed, code, cells) => {
        expect(classify({ changed, ...options })).toMatchObject({ code, smoke: 'false', cells })
    })

    it('does not let the change answer for the registry or receive the token through its own npm configuration', () => {
        const tokenSeen = join(scratch('token'), 'seen')
        // Answers "published" only inside the checkout, where npm would read the change's .npmrc.
        const npm = `#!/bin/sh\n[ -z "$GH_TOKEN" ] || : > ${tokenSeen}\n[ -f .npmrc ] && echo 1.0.0\nexit 0\n`
        expect(classify({ changed: { 'src.ts': 'changed\n', '.npmrc': 'registry=https://forged.invalid/\n' }, npm, env: { GH_TOKEN: 'synthetic' } }))
            .toMatchObject({ cells: [...LINUX, ...PLATFORMS] })
        expect(existsSync(tokenSeen)).toBe(false)
    })

    it('reports the tree of the commit it checked out, for a later run to compare', () => {
        const { tree, trees } = classify({ changed: { 'src.ts': 'changed\n' } })
        expect(tree).toBe(trees.head)
    })
})

describe('a push to main', () => {
    const push = { EVENT_NAME: 'push', HEAD_REF: '' }
    const changed = { 'src.ts': 'changed\n' }

    it('skips every cell that passed on its exact tree, on any commit, and runs the rest', () => {
        expect(classify({ changed, env: push, runs: ({ head, headSha }) => [{ sha: headSha, jobs: cellJobs([...LINUX, ...PLATFORMS], head) }] }))
            .toMatchObject({ code: 'false', cells: [] })
        expect(classify({ changed, env: push, runs: ({ head, headSha }) => [{ sha: headSha, jobs: cellJobs(LINUX, head) }] }))
            .toMatchObject({ code: 'true', cells: PLATFORMS })
    })

    it('never counts a pull request run, even one into the default branch on this exact tree', () => {
        expect(classify({ changed, env: push, runs: ({ head, headSha }) => [{ sha: headSha, event: 'pull_request', jobs: cellJobs([...LINUX, ...PLATFORMS], head) }] }))
            .toMatchObject({ code: 'true', smoke: 'false', cells: [...LINUX, ...PLATFORMS] })
    })

    it('runs no cell for a version-only commit whose parent passed every cell, only the scope check and the package smoke', () => {
        expect(classify({ changed: VERSION_BUMP, env: push, runs: everyCellPassedOnBase })).toMatchObject({ code: 'false', smoke: 'true', cells: [] })
    })

    // The last commit's parent was never pushed alone, so the earlier commit's evidence says nothing about it.
    it('runs the missing cells for a push of several commits ending in a version bump', () => {
        expect(classify({ before: changed, changed: VERSION_BUMP, env: push,
            runs: ({ head, headSha, start, startSha }) => [{ sha: startSha, jobs: cellJobs([...LINUX, ...PLATFORMS], start) }, { sha: headSha, jobs: cellJobs(LINUX, head) }] }))
            .toMatchObject({ code: 'true', smoke: 'false', cells: PLATFORMS })
    })

    it.each([
        ['the tree differs because main moved', ({ headSha }: { headSha: string }) => [{ sha: headSha, jobs: cellJobs([...LINUX, ...PLATFORMS], 'b'.repeat(40)) }]],
        ['no run exists', () => []],
        ['a shard is missing', ({ head, headSha }: { head: string; headSha: string }) => [{ sha: headSha, jobs: cellJobs([...LINUX.slice(1), ...PLATFORMS], head) }]],
        ['the API cannot answer', null],
    ] as const)('runs every cell it cannot prove when %s', (_name, runs) => {
        const outcome = classify({ changed, env: push, runs: runs as never })
        expect(outcome.code).toBe('true')
        expect(outcome.cells).toEqual(expect.arrayContaining(LINUX))
    })

    // The last commit's diff says nothing about what was tested, so only the tree can skip a cell.
    it.each([
        ['a push of several commits whose last changes only documentation', { before: changed, changed: { 'README.md': 'changed\n' } }, () => []],
        ['a documentation push that cancelled the run of the code push before it', { before: changed, changed: { 'README.md': 'changed\n' } },
            ({ base, baseSha }: Trees) => [{ sha: baseSha, conclusion: 'cancelled', jobs: cellJobs([...LINUX, ...PLATFORMS], base).map(job => ({ ...job, conclusion: 'cancelled' })) }]],
        ['a merged version bump', { changed: VERSION_BUMP }, () => []],
    ] as const)('runs every cell for %s whose tree no run tested', (_name, commits, runs) => {
        expect(classify({ ...commits, env: push, runs })).toMatchObject({ code: 'true', cells: [...LINUX, ...PLATFORMS] })
    })
})

// A cell renamed on one side only would never count as passed, or would let a run skip a cell it never ran.
describe('the tested-tree lookup', () => {
    const declared = (variable: string) => (JSON.parse(`[${new RegExp(`\\n *${variable}='([^']*)'`).exec(step)?.[1] ?? ''}]`) as Cell[]).map(cellName)
    const missing = (passed: readonly string[]) => {
        const { root, trees, env } = scenario({ changed: { 'src.ts': 'changed\n' }, runs: ({ head, headSha }) => [{ sha: headSha, jobs: cellJobs(passed, head) }] })
        return execFileSync('node', [join(REPOSITORY, '.github/scripts/tested-tree.mjs'), trees.headSha, trees.head], { cwd: root, env, encoding: 'utf8' }).trim()
    }

    it('counts exactly the cells the workflow runs, each in its group', () => {
        const groups = { linux: declared('linux_cells'), platforms: declared('platform_cells') }
        expect(groups.linux).toEqual(LINUX)
        expect(groups.platforms).toEqual(PLATFORMS)
        expect(missing([...groups.linux, ...groups.platforms])).toBe('none')
        for (const [group, cells] of Object.entries(groups)) for (const cell of cells) {
            expect(missing([...groups.linux, ...groups.platforms].filter(row => row !== cell)), cell).toBe(group)
        }
    })
})

// ci-ok is the one required check, so the short path is safe only if it reads the jobs that replace the matrix.
describe('the required check', () => {
    const ciOk = /\n  ci-ok:\n(?<body>[\s\S]*)/.exec(workflow)?.groups?.body ?? ''
    const verdict = (needs: Record<string, { result: string }>) => spawnSync('bash', ['-c', /\n {8}run: \|\n(?<body>(?: {10}.*\n)+)/.exec(ciOk)?.groups?.body ?? ''], {
        encoding: 'utf8', env: { ...process.env, NEEDS: JSON.stringify(needs) } }).status
    const skipped = { result: 'skipped' }
    const shortPath = { changes: { result: 'success' }, hygiene: { result: 'success' }, test: skipped, 'test-protection': { result: 'success' }, 'version-pr-scope': { result: 'success' }, 'package-smoke': { result: 'success' } }

    it('passes the short path, and fails it when the scope check, the smoke or the classification fails', () => {
        expect(ciOk).toMatch(/needs: \[[^\]]*\bchanges\b[^\]]*\btest\b[^\]]*\bversion-pr-scope\b[^\]]*\bpackage-smoke\b[^\]]*\]/)
        expect(verdict(shortPath)).toBe(0)
        for (const job of ['version-pr-scope', 'package-smoke', 'changes']) {
            expect(verdict({ ...shortPath, [job]: { result: 'failure' } }), job).toBe(1)
            expect(verdict({ ...shortPath, [job]: { result: 'cancelled' } }), job).toBe(1)
        }
    })

    it('runs the scope check on the short path of a pull request or a push, and on the version branch whatever the diff holds', () => {
        const scope = /\n  version-pr-scope:\n(?<body>[\s\S]*?)\n {4}runs-on/.exec(workflow)?.groups?.body ?? ''
        expect(scope).toContain("if: needs.changes.outputs.smoke == 'true' || (github.event_name == 'pull_request' && github.head_ref == 'changeset-release/main')")
    })
})

// A required check can be stale when it merges, and an administrator can bypass it. This is what stands between that and npm.
describe('the release gate', () => {
    const gate = (options: Scenario) => {
        const { root, env } = scenario(options)
        return spawnSync('bash', [join(REPOSITORY, '.github/scripts/release-gate.sh')], { cwd: root, encoding: 'utf8', env })
    }
    const source = { 'src.ts': 'changed\n' }

    it.each([
        ['every cell and ci-ok passed on this tree', source, ({ head, headSha }: Trees) => [{ sha: headSha, jobs: [...cellJobs([...LINUX, ...PLATFORMS], head), CI_OK] }]],
        ['this commit only moves the version, every cell passed on its parent, and ci-ok on this commit', VERSION_BUMP,
            (trees: Trees) => [...everyCellPassedOnBase(trees), { sha: trees.headSha, jobs: [CI_OK] }]],
    ] as const)('publishes when %s', (_name, changed, runs) => {
        const ran = gate({ changed, runs: runs as never })
        expect(ran.status, ran.stderr).toBe(0)
    })

    it.each([
        ['a stale green bump merged over a later commit whose macOS cell failed', VERSION_BUMP, ({ base, baseSha }: { base: string; baseSha: string }) => [{ sha: baseSha, jobs: [...cellJobs([...LINUX, ...PLATFORMS.slice(1)], base), { name: `test (${PLATFORMS[0]}) tree ${base}`, conclusion: 'failure' }] }]],
        ['the parent passed but this commit changes source', source, everyCellPassedOnBase],
        ['only the Linux cells passed on this tree', source, ({ head, headSha }: { head: string; headSha: string }) => [{ sha: headSha, jobs: cellJobs(LINUX, head) }]],
        ['the cells passed on another tree', source, ({ headSha }: { headSha: string }) => [{ sha: headSha, jobs: cellJobs([...LINUX, ...PLATFORMS], 'c'.repeat(40)) }]],
        ['the API cannot answer', VERSION_BUMP, null],
        // The cells do not hold the scope check, the package smoke, the scan or test protection.
        ['every cell passed on this tree but ci-ok failed', source, ({ head, headSha }: Trees) => [{ sha: headSha, jobs: [...cellJobs([...LINUX, ...PLATFORMS], head), { ...CI_OK, conclusion: 'failure' }] }]],
        ['ci-ok passed only in a pull request run into the default branch on this commit', VERSION_BUMP,
            (trees: Trees) => [...everyCellPassedOnBase(trees), { sha: trees.headSha, event: 'pull_request', jobs: [CI_OK] }]],
    ] as const)('refuses when %s', (_name, changed, runs) => {
        const ran = gate({ changed, runs: runs as never })
        expect(ran.status).toBe(1)
        expect(ran.stderr).toContain('Refusing to publish')
    })

    // The release workflow starts beside this commit's own CI run, which is where its ci-ok comes from.
    it('waits for this commit\'s CI run to finish before reading what passed', () => {
        const { root, trees, env, bin, fixtures, fixture } = scenario({ changed: VERSION_BUMP, runs: everyCellPassedOnBase })
        const pending = `repos/${SLUG}/actions/workflows/ci.yml/runs?head_sha=${trees.headSha}&event=push&per_page=100`
        fixture(pending, { workflow_runs: [{ status: 'in_progress' }] })
        const finished = scratch('finished')
        fixture(pending, { workflow_runs: [{ status: 'completed' }] }, finished)
        fixture(`repos/${SLUG}/actions/workflows/ci.yml/runs?head_sha=${trees.headSha}&status=success&per_page=100`, { workflow_runs: [{ id: 99, path: '.github/workflows/ci.yml',
            conclusion: 'success', head_repository: { full_name: SLUG }, event: 'push', head_branch: 'main', head_commit: { id: trees.headSha, tree_id: trees.head } }] }, finished)
        fixture(`repos/${SLUG}/actions/runs/99/jobs?per_page=100`, { jobs: [{ ...CI_OK, conclusion: 'success' }] }, finished)
        // The run finishes while the gate sleeps.
        writeFileSync(join(bin, 'sleep'), `#!/bin/sh\ncp ${finished}/* ${fixtures}/\n`, { mode: 0o700 })
        const ran = spawnSync('bash', [join(REPOSITORY, '.github/scripts/release-gate.sh')], { cwd: root, encoding: 'utf8', env })
        expect(ran.status, ran.stderr).toBe(0)
    })

    it('runs before the publish job, which cannot start without it', () => {
        const release = readFileSync(join(REPOSITORY, '.github/workflows/release.yml'), 'utf8')
        expect(/\n  publish:\n(?<body>[\s\S]*)/.exec(release)?.groups?.body).toContain('needs: [select-mode, release-gate]')
        const body = /\n  release-gate:\n(?<body>[\s\S]*?)\n\n/.exec(release)?.groups?.body ?? ''
        expect(body).toContain("if: needs.select-mode.outputs.mode == 'publish'")
        expect(body).toContain('run: bash .github/scripts/release-gate.sh')
        expect(body).not.toContain('id-token')
    })
})

// A documentation-only change skips the matrix, so every test that reads the tracked Markdown has to run beside the scan.
describe('the documentation-only path', () => {
    const hygiene = /\n  hygiene:\n(?<body>[\s\S]*?)\n  test:\n/.exec(workflow)?.groups?.body ?? ''

    it('runs the tests that list or open the tracked Markdown, and the packaged guide', () => {
        const contracts = (/name: documentation contracts\n {8}run: npm test -- (?<files>.+)\n/.exec(hygiene)?.groups?.files ?? '').split(' ')
        const readers = execFileSync('git', ['ls-files', '-z', 'packages/*.test.ts'], { cwd: REPOSITORY, encoding: 'utf8' }).split('\0')
            .filter(path => path !== '' && !path.endsWith('.slow.test.ts')).filter(path => {
                const source = readFileSync(join(REPOSITORY, path), 'utf8')
                return /'ls-files'[\s\S]{0,300}?'(?:\*\.md|docs|README\.md|CONTRIBUTING\.md)'/.test(source) || /new URL\('(?:\.\.\/){3}(?:docs\/|[^'/]+\.md')/.test(source)
            })
        expect(readers).toEqual(expect.arrayContaining(['packages/cockpit/src/example-cockpit.test.ts', 'packages/cockpit/src/fix-catalogue.test.ts']))
        expect(contracts).toEqual(expect.arrayContaining(readers))
        // vitest passes a name that matches nothing, so the name has to be the case's.
        const packaged = /run: npm test -- packages\/cockpit\/src\/packaging\.slow\.test\.ts -t '(?<name>[^']+)'\n/.exec(hygiene)?.groups?.name
        expect(packaged).toBeDefined()
        expect(readFileSync(join(REPOSITORY, 'packages/cockpit/src/packaging.slow.test.ts'), 'utf8')).toContain(`it('${packaged}`)
    })
})

describe('the weekly run', () => {
    it('runs the upper edge of the Node range whatever the commit changed', () => {
        expect(classify({ changed: { 'README.md': 'changed\n' }, env: { EVENT_NAME: 'schedule', HEAD_REF: '' }, runs: null }))
            .toMatchObject({ code: 'true', cells: ['ubuntu-latest, node 26, full'] })
    })
})

describe('the signature audit', () => {
    const audit = (replies: readonly (readonly [number, string])[]) => {
        const bin = scratch('audit')
        const calls = join(bin, 'calls')
        const cases = replies.map(([code, text], index) => `  ${index + 1}) echo '${text.replace('<log>', join(bin, 'debug.log'))}'; exit ${code} ;;`).join('\n')
        writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$*" >> '${calls}'\ncase $(wc -l < '${calls}' | tr -d ' ') in\n${cases}\nesac\n`, { mode: 0o755 })
        writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 })
        writeFileSync(join(bin, 'debug.log'), 'http fetch GET 200 synthetic/attestations/@scope%2fpad@1.3.0 40ms (cache hit)\n')
        const result = spawnSync('bash', [join(REPOSITORY, '.github/scripts/audit-signatures.sh')],
            { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } })
        return { code: result.status, output: result.stdout, attempts: readFileSync(calls, 'utf8').trim().split('\n') }
    }
    const MISSING_KEY = [1, 'npm error code EMISSINGSIGNATUREKEY\nnpm error @scope/pad@1.3.0 has attestations but no corresponding public key(s) can be found\nnpm error A complete log of this run can be found in: <log>'] as const

    it('passes when a missing-key report does not recur, and says it retried', () => {
        const { code, output, attempts } = audit([MISSING_KEY, [0, 'all verified']])
        expect(code).toBe(0)
        expect(attempts).toEqual(['audit signatures --prefer-online', 'audit signatures --prefer-online'])
        expect(output).toContain('::warning title=npm audit signatures::EMISSINGSIGNATUREKEY on attempt 1')
        // The cause on a runner is unproven, so each occurrence records how that fetch was answered.
        expect(output).toContain('attestations/@scope%2fpad@1.3.0 40ms (cache hit)')
    })

    it('fails when the key stays missing', () => {
        const { code, attempts } = audit([MISSING_KEY, MISSING_KEY, MISSING_KEY, [0, 'never reached']])
        expect(code).toBe(1)
        expect(attempts).toHaveLength(3)
    })

    it('fails at once on an invalid signature, without another attempt', () => {
        const { code, attempts } = audit([[1, 'packages have invalid registry signatures'], [0, 'never reached']])
        expect(code).toBe(1)
        expect(attempts).toHaveLength(1)
    })
})
