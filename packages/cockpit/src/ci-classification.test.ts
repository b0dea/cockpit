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

type Run = Readonly<{ sha: string; jobs: readonly { name: string; conclusion?: string }[]; conclusion?: string; path?: string; repository?: string }>
const cellJobs = (cells: readonly string[], tree: string) => cells.map(cell => ({ name: `test (${cell}) tree ${tree}` }))

type Scenario = Readonly<{
    changed: Record<string, string | null>
    env?: Record<string, string>
    published?: string | null
    /** The whole stand-in npm, for a case that depends on how it was called. */
    npm?: string
    /** Runs the API reports, from the base and head trees; `null` makes every API call fail. */
    runs?: ((trees: { base: string; head: string; baseSha: string; headSha: string }) => readonly Run[]) | null
    baseFiles?: Record<string, string>
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
    write(options.changed)
    const trees = { base: git('rev-parse', 'HEAD^^{tree}'), head: git('rev-parse', 'HEAD^{tree}'), baseSha: git('rev-parse', 'HEAD^'), headSha: git('rev-parse', 'HEAD') }

    const bin = scratch('bin')
    const fixtures = scratch('fixtures')
    const published = options.published === undefined ? '1.0.0' : options.published
    writeFileSync(join(bin, 'npm'), options.npm ?? (published === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${published}\n`), { mode: 0o700 })
    // A path with no fixture fails like an unreachable API.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nf="${fixtures}/$(printf '%s' "$2" | tr '/?&=' '____')"\n[ -f "$f" ] && exec cat "$f"\nexit 1\n`, { mode: 0o700 })
    const fixture = (path: string, value: unknown) => writeFileSync(join(fixtures, path.replace(/[/?&=]/g, '_')), JSON.stringify(value))
    if (options.runs !== null) {
        const runs = options.runs?.(trees) ?? []
        for (const sha of [trees.baseSha, trees.headSha]) {
            fixture(`repos/${SLUG}/commits/${sha}/pulls`, [])
            fixture(`repos/${SLUG}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`, { workflow_runs: runs.flatMap((run, index) => run.sha === sha ? [{
                id: index + 1, path: run.path ?? '.github/workflows/ci.yml', conclusion: run.conclusion ?? 'success', head_repository: { full_name: run.repository ?? SLUG },
            }] : []) })
        }
        runs.forEach((run, index) => fixture(`repos/${SLUG}/actions/runs/${index + 1}/jobs?per_page=100`, { jobs: run.jobs.map(job => ({ conclusion: 'success', ...job })) }))
    }
    return { root, trees, env: { ...process.env, GITHUB_REPOSITORY: SLUG, PATH: `${bin}:${process.env.PATH}`, ...options.env } }
}

function classify(options: Scenario) {
    const { root, trees, env } = scenario(options)
    const output = join(scratch('output'), 'github-output')
    const ran = spawnSync('bash', ['-c', step], { cwd: root, encoding: 'utf8', env: {
        EVENT_NAME: 'pull_request', HEAD_REF: 'ordinary', MACOS_LABEL: 'false', ...env, GITHUB_OUTPUT: output, RUNNER_TEMP: scratch('temp') } })
    expect(ran.status, ran.stderr).toBe(0)
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    const cells = (JSON.parse(values.cells!) as { os: string; node: string; gate: string; shard?: string }[])
        .map(({ os, node, gate, shard }) => `${os}, node ${node}, ${gate}${shard ? ` ${shard}` : ''}`)
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

    it('runs no cell for a documentation change or a merged version bump', () => {
        expect(classify({ changed: { 'README.md': 'changed\n' }, env: push, runs: null })).toMatchObject({ code: 'false', cells: [] })
        expect(classify({ changed: VERSION_BUMP, env: push, runs: null })).toMatchObject({ code: 'false', cells: [] })
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

    it('runs the scope check on the short path and on the version branch whatever the diff holds', () => {
        const scope = /\n  version-pr-scope:\n(?<body>[\s\S]*?)\n {4}runs-on/.exec(workflow)?.groups?.body ?? ''
        expect(scope).toContain("github.head_ref == 'changeset-release/main' || needs.changes.outputs.smoke == 'true'")
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
        ['every cell passed on this tree', source, ({ head, headSha }: { head: string; headSha: string }) => [{ sha: headSha, jobs: cellJobs([...LINUX, ...PLATFORMS], head) }]],
        ['this commit only moves the version and every cell passed on its parent', VERSION_BUMP, everyCellPassedOnBase],
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
    ] as const)('refuses when %s', (_name, changed, runs) => {
        const ran = gate({ changed, runs: runs as never })
        expect(ran.status).toBe(1)
        expect(ran.stderr).toContain('Refusing to publish')
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

describe('the weekly run', () => {
    it('runs the upper edge of the Node range whatever the commit changed', () => {
        expect(classify({ changed: { 'README.md': 'changed\n' }, env: { EVENT_NAME: 'schedule', HEAD_REF: '' }, runs: null }))
            .toMatchObject({ code: 'true', cells: ['ubuntu-latest, node 26, full'] })
    })
})
