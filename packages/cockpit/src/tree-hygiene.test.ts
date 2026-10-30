import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseNpmPackJson } from './test-support/npm-pack-json.js'
import {
    ALLOWED,
    FIXTURE,
    INTERNAL,
    ROOT,
    ROOT_URL,
    SITE_NEEDLES,
    buildNeedle,
    coverage,
    hasInternal,
    scanPathText,
    scanPublicationPathText,
    scanText,
    scanGitHistory,
    siteTerms,
    trackedContents,
    untrackedPaths,
} from '../../../scripts/hygiene-scan.mjs'

// Universal credential and private-path patterns apply in every clone. Site identifiers
// belong in an ignored local list; they must never be embedded in the published detector.
// The test, index hook, and history scan share one implementation and report coverage gaps.

const HOOK = '.githooks/pre-commit'
const COMMIT_MESSAGE_HOOK = '.githooks/commit-msg'
const SCANNER = fileURLToPath(new URL('scripts/hygiene-scan.mjs', ROOT_URL))

const site = siteTerms()
const COVERAGE = coverage(site)
if (site === null) {
    // The one thing a green run must not be allowed to mean is "fully scanned".
    console.warn(`[tree-hygiene] ${COVERAGE}`)
}

describe('reachable history hygiene', () => {
    function repository() {
        const root = mkdtempSync(join(tmpdir(), 'hygiene-history-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
        git('init', '--quiet')
        git('config', 'user.name', 'Synthetic Maintainer')
        git('config', 'user.email', 'maintainer@example.invalid')
        git('config', 'core.hooksPath', '/dev/null')
        return { root, git }
    }

    it('finds a removed ancestor leak while the current tree and package content are clean', () => {
        const { root, git } = repository()
        try {
            writeFileSync(join(root, 'removed.txt'), readFileSync(new URL(FIXTURE, ROOT_URL)))
            git('add', '--', 'removed.txt'); git('commit', '--quiet', '-m', 'Add synthetic content')
            const ancestor = git('rev-parse', 'HEAD')
            git('rm', '--quiet', '--', 'removed.txt')
            writeFileSync(join(root, 'package.json'), '{"name":"synthetic-history","version":"1.0.0","files":["clean.txt"]}\n')
            writeFileSync(join(root, 'clean.txt'), 'ordinary synthetic prose\n')
            git('add', '--', 'package.json', 'clean.txt'); git('commit', '--quiet', '-m', 'Keep clean content')
            expect([...trackedContents(root)].flatMap(([path, body]) => scanPathText(path, body, []))).toEqual([])
            const packed = parseNpmPackJson(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
                cwd: root, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(tmpdir(), 'cockpit-history-npm-cache') },
            }))
            expect(packed.files.map((row: { path: string }) => row.path).sort()).toEqual(['clean.txt', 'package.json'])
            git('tag', '-a', 'synthetic-tag', '-m', readFileSync(new URL(FIXTURE, ROOT_URL), 'utf8'))
            git('tag', 'sk_' + 'live_synthetic_tag')
            git('branch', 'sk_' + 'live_synthetic_branch')
            const report = scanGitHistory(root)
            expect(report.complete).toBe(true)
            expect(report.clean).toBe(false)
            expect(report.commits).toBe(2)
            expect(report.findings).toContainEqual(expect.objectContaining({ commit: ancestor, path: 'removed.txt', kind: 'consumer-identifier' }))
            expect(report.findings).toContainEqual(expect.objectContaining({ path: '(tag)', kind: 'consumer-identifier' }))
            expect(report.findings).toContainEqual(expect.objectContaining({ path: '(ref:tags)', kind: 'consumer-identifier' }))
            expect(report.findings).toContainEqual(expect.objectContaining({ path: '(ref:heads)', kind: 'consumer-identifier' }))
            expect(JSON.stringify(report)).not.toContain('sk_' + 'live_')
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('finds development ceremony in reachable commit messages', () => {
        const { root, git } = repository()
        try {
            writeFileSync(join(root, 'clean.txt'), 'ordinary synthetic prose\n')
            git('add', '--', 'clean.txt'); git('commit', '--quiet', '-m', 'Add clean content', '-m', 'Claude-' + 'Session: 01AbCdEf')
            const leaking = git('rev-parse', 'HEAD')
            git('commit', '--quiet', '--allow-empty', '-m', 'Keep ordinary history')
            const report = scanGitHistory(root)
            expect(report).toMatchObject({ complete: true, clean: false, commits: 2 })
            expect(report.findings).toEqual([expect.objectContaining({ commit: leaking, path: '(commit)', kind: 'development-ceremony' })])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('accepts complete clean history and rejects shallow, binary and oversized coverage', () => {
        const { root, git } = repository()
        try {
            writeFileSync(join(root, 'clean.txt'), 'ordinary synthetic prose\n')
            git('add', '--', 'clean.txt'); git('commit', '--quiet', '-m', 'Clean history')
            expect(scanGitHistory(root)).toMatchObject({ complete: true, clean: true, commits: 1, findings: [], gaps: [] })
            const head = git('rev-parse', 'HEAD')
            writeFileSync(join(root, '.git/shallow'), `${head}\n`)
            expect(scanGitHistory(root)).toMatchObject({ complete: false, clean: false, gaps: ['history is shallow'] })
            rmSync(join(root, '.git/shallow'))
            writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 1]))
            writeFileSync(join(root, 'oversized.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 65))
            git('add', '--', 'binary.bin', 'oversized.txt'); git('commit', '--quiet', '-m', 'Bounded coverage controls')
            expect(scanGitHistory(root)).toMatchObject({ complete: false, clean: false,
                gaps: expect.arrayContaining([expect.stringContaining('binary.bin'), expect.stringContaining('oversized.txt')]) })
            const rawName = Buffer.from([0x62, 0x61, 0x64, 0xff])
            const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
                cwd: root, encoding: 'utf8', input: 'ordinary synthetic prose\n',
            }).trim()
            // Git permits pathname bytes that the host filesystem cannot materialize.
            const tree = execFileSync('git', ['mktree', '-z'], { cwd: root, encoding: 'utf8',
                input: Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), rawName, Buffer.from([0])]),
            }).trim()
            const parent = git('rev-parse', 'HEAD')
            git('update-ref', 'HEAD', git('commit-tree', tree, '-p', parent, '-m', 'Invalid pathname coverage control'), parent)
            expect(scanGitHistory(root)).toMatchObject({ complete: false, clean: false,
                gaps: expect.arrayContaining([expect.stringContaining('invalid UTF-8 pathname')]) })
            expect(() => scanGitHistory(join(root, 'absent'))).toThrow(/history.*git|git.*history/i)
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('scans every object when reachable history exceeds one process buffer', () => {
        const { root, git } = repository()
        try {
            const cleanBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
                cwd: root, encoding: 'utf8', input: Buffer.alloc(7 * 1024 * 1024, 97),
            }).trim()
            const lateBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
                cwd: root, encoding: 'utf8', input: 'token: sk_' + 'live_late_history\n',
            }).trim()
            const entries = [
                ...Array.from({ length: 19 }, (_, index) =>
                    Buffer.from(`100644 blob ${cleanBlob}\tbulk-${String(index).padStart(2, '0')}.txt\0`)),
                Buffer.from(`100644 blob ${lateBlob}\tzz-late.txt\0`),
            ]
            const tree = execFileSync('git', ['mktree', '-z'], { cwd: root, encoding: 'utf8',
                input: Buffer.concat(entries) }).trim()
            git('update-ref', 'HEAD', git('commit-tree', tree, '-m', 'Large logical history'))

            const report = scanGitHistory(root)
            expect(report).toMatchObject({ complete: true, clean: false, commits: 1, blobs: 20, gaps: [] })
            expect(report.findings).toContainEqual(expect.objectContaining({
                path: 'zz-late.txt', kind: 'consumer-identifier',
            }))
        } finally { rmSync(root, { recursive: true, force: true }) }
    })
})

function trackedFiles(): string[] {
    // Both tracked and not-yet-tracked files, because the first commit has neither.
    return [...trackedContents(ROOT).keys(), ...untrackedPaths(ROOT)]
        .filter((f) => !f.startsWith('node_modules/') && !f.includes('/node_modules/'))
}

function treeContents(): Map<string, string> {
    const contents = trackedContents(ROOT)
    for (const path of untrackedPaths(ROOT)) {
        if (path.startsWith('node_modules/') || path.includes('/node_modules/')) continue
        contents.set(path, readFileSync(new URL(path, ROOT_URL), 'utf8'))
    }
    return contents
}

const PRIVATE_ROOT_SURFACES = ['AGENTS.md', 'CLAUDE.md', '.agents', '.claude', '.codex', '.opencode'] as const

// The contributor guide for agents and humans is the only repository-local tool configuration that
// ships: the guide, its Claude import, and the hand-authored skills (`.claude/skills` is a symlink
// to `.agents/skills`). Everything else under these roots stays private.
const PUBLISHED_ROOT_SURFACES = ['AGENTS.md', 'CLAUDE.md', '.claude/skills'] as const
const PUBLISHED_ROOT_TREES = ['.agents/skills'] as const

function privateDevelopmentPaths(
    paths: readonly string[],
    roots: readonly string[] = PRIVATE_ROOT_SURFACES,
    allowed: { files: readonly string[]; trees: readonly string[] } = {
        files: PUBLISHED_ROOT_SURFACES, trees: PUBLISHED_ROOT_TREES,
    },
): string[] {
    return paths
        .filter((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)))
        .filter((path) => !allowed.files.includes(path)
            && !allowed.trees.some((tree) => path.startsWith(`${tree}/`)))
}

describe(`nothing consumer-identifying reaches the tracked tree (${COVERAGE})`, () => {
    it('scans a non-trivial number of files — a scan over nothing passes trivially', () => {
        // The one number that must not be derived from the thing it checks: if the file
        // listing breaks, an empty sweep would otherwise report a clean tree.
        expect(trackedFiles().length).toBeGreaterThan(8)
    })

    it('finds no consumer identifier, private path or credential', () => {
        const hits: string[] = []
        for (const [file, body] of treeContents()) {
            for (const line of scanPathText(file, body, site ?? [])) hits.push(`${file}:${line}`)
        }
        expect(hits, `scanned with: ${COVERAGE}`).toEqual([])
    })

    it('reads tracked newline filenames and dangling symlinks as Git blobs', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-git-blobs-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' })
        const newlinePath = 'probe\nline.md'
        const symlinkPath = 'dangling-link'
        try {
            git('init')
            writeFileSync(join(tmp, newlinePath), 'token: sk_' + 'live_newline\n')
            symlinkSync('sk_' + 'live_dangling', join(tmp, symlinkPath))
            git('add', newlinePath, symlinkPath)

            const contents = trackedContents(tmp)
            expect([...contents.keys()]).toEqual([symlinkPath, newlinePath])
            expect(scanPathText(newlinePath, contents.get(newlinePath) ?? '', [])).toEqual([1])
            expect(scanPathText(symlinkPath, contents.get(symlinkPath) ?? '', [])).toEqual([1])
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('fails with the tracked path when Git cannot supply an indexed object', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-missing-object-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' }).trim()
        try {
            git('init')
            writeFileSync(join(tmp, 'unreadable.md'), 'ordinary text\n')
            git('add', 'unreadable.md')
            const object = git('rev-parse', ':unreadable.md')
            renameSync(join(tmp, '.git/objects', object.slice(0, 2), object.slice(2)), join(tmp, 'held-object'))

            expect(() => trackedContents(tmp)).toThrow(/cannot read tracked content of "unreadable\.md": .*missing/)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('proves it can fail, on planted identifiers every clone carries', () => {
        // Silence about the real tree means nothing unless a known-bad string is shown to
        // trip the same needle in the same run. Checked against the universal classes alone,
        // so the proof survives in a clone that has no site list to load.
        const universalOnly = buildNeedle([])
        const planted = readFileSync(new URL(FIXTURE, ROOT_URL), 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '' && !l.startsWith('#'))
        expect(planted.length, `${FIXTURE} plants nothing`).toBeGreaterThan(3)
        for (const line of planted) {
            expect(universalOnly.test(line), `planted but unmatched: ${line}`).toBe(true)
        }
        expect(universalOnly.test('a perfectly ordinary line of prose')).toBe(false)
    })

    it('proves the site-specific class fires, and stays bounded', () => {
        // The configured list cannot be asserted against here without naming its contents, so
        // the mechanism is proven on synthetic terms instead.
        const probe = buildNeedle(['acmewidgets', 'northwind'])
        expect(probe.test('deployed to the acmewidgets cluster')).toBe(true)
        expect(probe.test('a perfectly ordinary line of prose')).toBe(false)
        expect(buildNeedle(['sample']).test('the resampled data'), 'boundaries dropped').toBe(false)
    })

    it('recognises absolute user homes without matching relative path fragments or short token labels', () => {
        const probe = buildNeedle([])
        expect(probe.test('/ho' + 'me/synthetic-operator')).toBe(true)
        expect(probe.test('/ro' + 'ot/private')).toBe(true)
        expect(probe.test('/var/ro' + 'ot/private')).toBe(true)
        expect(probe.test('C:' + '\\Us' + 'ers\\synthetic-operator')).toBe(true)
        expect(probe.test('home/synthetic-operator/private')).toBe(false)
        expect(probe.test('/ro' + 'oted/private')).toBe(false)
        expect(probe.test('/var/ro' + 'oted/private')).toBe(false)
        expect(probe.test('root/private')).toBe(false)
        expect(probe.test('Users/synthetic-operator/private')).toBe(false)
        expect(probe.test('github_' + 'pat_example')).toBe(false)
        expect(probe.test('npm_' + 'install')).toBe(false)
    })

    it('still scans an allowed control fixture for site-specific terms', () => {
        expect(
            scanPathText(FIXTURE, 'token: sk_' + 'live_synthetic syntheticconsumer\n', ['syntheticconsumer']),
        ).toEqual([1])
    })

    it.each([
        ['credential', 'sk_' + 'live_unapproved'],
        ['private path', '/Us' + 'ers/synthetic-operator/secret.txt'],
    ])('scans an additional universal %s appended to the exact controls', (_kind, extra) => {
        const planted = readFileSync(new URL(FIXTURE, ROOT_URL), 'utf8')
        expect(scanPathText(FIXTURE, `${planted}${extra}\n`, [])).toContain(planted.split('\n').length)
    })

    it.skipIf(!hasInternal())('configures the site-specific list, having the material for it', () => {
        // Skipped where `internal/` is absent — a public clone owns none of these names and
        // cannot supply them. Here it is the difference between a scan and a formality.
        expect(
            site,
            `${SITE_NEEDLES} is missing while ${INTERNAL}/ exists: this checkout has the real names, so the scan has silently degraded to what a public clone gets`,
        ).not.toBeNull()
        expect(site?.length ?? 0, `${SITE_NEEDLES} is configured but empty`).toBeGreaterThan(0)
    })

    it('carries no stale allowances', () => {
        for (const a of ALLOWED) {
            expect(trackedFiles(), `${a.file} is allow-listed but no longer tracked`).toContain(a.file)
        }
    })
})

describe(`nothing consumer-identifying reaches the published tarball (${COVERAGE})`, () => {
    // The tree and the tarball are different surfaces, and reading the tree says nothing
    // about the second: `files` in package.json decides what npm ships, a template under
    // `surfaces/` is packed verbatim, and a published tarball cannot be withdrawn.
    const pkgUrl = new URL('packages/cockpit/', ROOT_URL)
    const needle = buildNeedle(site ?? [])
    const packScratch = mkdtempSync(join(tmpdir(), 'cockpit-hygiene-pack-'))
    let packed: string[] | undefined

    afterAll(() => rmSync(packScratch, { recursive: true, force: true }))

    function packedFiles(): string[] {
        // This check needs npm's inventory, not prepack. Running prepack here races the
        // installed-tarball test while both replace dist/ from parallel Vitest workers.
        packed ??= parseNpmPackJson(
            execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
                cwd: fileURLToPath(pkgUrl),
                env: { ...process.env, npm_config_cache: join(packScratch, 'npm-cache') },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }),
        ).files.map((f) => f.path)
        return packed
    }

    it('finds no consumer identifier, private path or credential in what would ship', () => {
        // No allowances here: the planted fixture is not packed, and a hit in a tarball is a
        // publication rather than a working file.
        const files = packedFiles()
        expect(files.length, 'an empty pack would pass this trivially').toBeGreaterThan(3)
        const hits: string[] = []
        for (const file of files) {
            const body = readFileSync(new URL(file, pkgUrl), 'utf8')
            for (const line of scanText(body, needle)) hits.push(`${file}:${line}`)
        }
        expect(hits, `scanned with: ${COVERAGE}`).toEqual([])
    })
})

describe('the commit-time guard', () => {
    it('blocks cross-platform private homes and current tool credentials in CI-only coverage', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-universal-families-'))
        const git = (...args: string[]) =>
            execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const controls = [
            '/ro' + 'ot/private/project.env',
            '/var/ro' + 'ot/private/project.env',
            '/ho' + 'me/synthetic-operator/private/project.env',
            'C:' + '\\Us' + 'ers\\synthetic-operator\\private\\project.env',
            '\\\\' + 'fileserver\\Users\\synthetic-operator\\private\\project.env',
            'github_' + 'pat_' + 'A'.repeat(82),
            'npm_' + 'A'.repeat(36),
            'sk-' + 'proj-' + 'A'.repeat(48),
            'sk-' + 'ant-api03-' + 'A'.repeat(48),
        ]
        try {
            git('init')
            writeFileSync(join(tmp, 'controls.md'), `${controls.join('\n')}\n`)
            git('add', 'controls.md')

            const result = spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(1)
            for (const line of controls.keys()) expect(result.stderr).toContain(`controls.md:${line + 1}`)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('scans renamed and type-changed index blobs', () => {
        const renamedRepo = mkdtempSync(join(tmpdir(), 'hygiene-renamed-index-'))
        const typeChangedRepo = mkdtempSync(join(tmpdir(), 'hygiene-type-changed-index-'))
        const prepare = (root: string) => {
            const git = (...args: string[]) =>
                execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            git('init')
            git('config', 'user.name', 'Synthetic Operator')
            git('config', 'user.email', 'operator@example.invalid')
            mkdirSync(join(root, 'internal'))
            writeFileSync(join(root, SITE_NEEDLES), 'syntheticconsumer\n')
            return git
        }
        try {
            const renamedGit = prepare(renamedRepo)
            const original = Array.from({ length: 20 }, (_, index) => `ordinary line ${index}`).join('\n') + '\n'
            writeFileSync(join(renamedRepo, 'before.md'), original)
            renamedGit('add', 'before.md')
            renamedGit('commit', '-m', 'synthetic baseline')
            renamedGit('mv', 'before.md', 'after.md')
            writeFileSync(join(renamedRepo, 'after.md'), `${original}syntheticconsumer\n`)
            renamedGit('add', 'after.md')
            expect(renamedGit('diff', '--cached', '--name-status')).toMatch(/^R\d+\s+before\.md\s+after\.md/m)

            const typeChangedGit = prepare(typeChangedRepo)
            writeFileSync(join(typeChangedRepo, 'pointer'), 'ordinary text\n')
            typeChangedGit('add', 'pointer')
            typeChangedGit('commit', '-m', 'synthetic baseline')
            rmSync(join(typeChangedRepo, 'pointer'))
            symlinkSync('syntheticconsumer/private.env', join(typeChangedRepo, 'pointer'))
            typeChangedGit('add', 'pointer')
            expect(typeChangedGit('diff', '--cached', '--name-status')).toContain('T\tpointer')

            const renamed = spawnSync(process.execPath, [SCANNER], { cwd: renamedRepo, encoding: 'utf8' })
            const typeChanged = spawnSync(process.execPath, [SCANNER], { cwd: typeChangedRepo, encoding: 'utf8' })
            expect(renamed.status, renamed.stderr).toBe(1)
            expect(renamed.stderr).toContain('after.md:21')
            expect(typeChanged.status, typeChanged.stderr).toBe(1)
            expect(typeChanged.stderr).toContain('pointer:1')
        } finally {
            rmSync(renamedRepo, { recursive: true, force: true })
            rmSync(typeChangedRepo, { recursive: true, force: true })
        }
    })

    it('scans the index rather than the working tree', () => {
        // What a commit carries is what is staged. A file can be staged clean and dirty on
        // disk, and the old hook — which read the tree — would have blocked that commit for
        // material it was not making. Proven in a throwaway repository, so this repository's
        // index is never written to. The planted shape is universal, so the proof holds in a
        // clone with no site list.
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-scan-'))
        const probe = join(tmp, 'probe.md')
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'ignore' })
        const planted = 'token: sk_' + 'live_deadbeefdeadbeef\n'
        try {
            git('init')
            writeFileSync(probe, planted)
            git('add', 'probe.md')
            const staged = spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
            expect(staged.status, staged.stderr).toBe(1)
            expect(staged.stderr).toContain('probe.md:1')

            writeFileSync(probe, 'nothing to see here\n')
            git('add', 'probe.md')
            writeFileSync(probe, planted)
            const treeOnly = spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
            expect(treeOnly.status, `dirty tree blocked a clean index: ${treeOnly.stderr}`).toBe(0)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('blocks a maintainer checkout when its site list is missing, unreadable, or empty', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-site-coverage-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'ignore' })
        const scan = () => spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
        try {
            git('init')
            writeFileSync(join(tmp, 'probe.md'), 'ordinary text\n')
            git('add', 'probe.md')
            mkdirSync(join(tmp, 'internal'))

            expect(scan().status).not.toBe(0)
            writeFileSync(join(tmp, SITE_NEEDLES), '')
            expect(scan().status).not.toBe(0)
            rmSync(join(tmp, SITE_NEEDLES))
            mkdirSync(join(tmp, SITE_NEEDLES))
            expect(scan().status).not.toBe(0)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('scans text content even when the path has a binary-looking suffix', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-binary-suffix-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'ignore' })
        try {
            git('init')
            writeFileSync(join(tmp, 'probe.pdf'), 'token: sk_' + 'live_synthetic\n')
            git('add', 'probe.pdf')
            const result = spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(1)
            expect(result.stderr).toContain('probe.pdf:1')
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('blocks a site term hidden beside a planted universal control', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-allowed-fixture-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'ignore' })
        try {
            git('init')
            mkdirSync(join(tmp, 'internal'))
            writeFileSync(join(tmp, SITE_NEEDLES), 'syntheticconsumer\n')
            mkdirSync(join(tmp, 'fixtures/hygiene'), { recursive: true })
            writeFileSync(join(tmp, FIXTURE), 'token: sk_' + 'live_synthetic syntheticconsumer\n')
            git('add', '-f', FIXTURE)

            const result = spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(1)
            expect(result.stderr).toContain(`${FIXTURE}:1`)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('blocks additional universal bytes appended to the staged control fixture', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'hygiene-bound-controls-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'ignore' })
        try {
            git('init')
            mkdirSync(join(tmp, 'fixtures/hygiene'), { recursive: true })
            const planted = readFileSync(new URL(FIXTURE, ROOT_URL), 'utf8')
            const firstExtraLine = planted.split('\n').length
            writeFileSync(
                join(tmp, FIXTURE),
                `${planted}sk_${'live_unapproved'}\n/Us${'ers/synthetic-operator/secret.txt'}\n`,
            )
            git('add', '-f', FIXTURE)

            const result = spawnSync(process.execPath, [SCANNER], { cwd: tmp, encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(1)
            expect(result.stderr).toContain(`${FIXTURE}:${firstExtraLine}`)
            expect(result.stderr).toContain(`${FIXTURE}:${firstExtraLine + 1}`)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('stays inside the budget it declares', () => {
        // The number lives in the hook because it is the hook's constraint; holding it here
        // instead would give it no owner and let the two drift apart silently. A mandatory
        // guard that outgrows its budget teaches people to bypass, and --no-verify is not
        // selective — it drops the cheap important guards along with the expensive one.
        const hook = readFileSync(new URL(HOOK, ROOT_URL), 'utf8')
        const declared = /^HOOK_BUDGET_MS=(\d+)$/m.exec(hook)
        expect(declared, `${HOOK} declares no HOOK_BUDGET_MS`).not.toBeNull()
        const budget = Number(declared?.[1])

        const started = performance.now()
        // Status ignored: this measures cost. A hook correctly blocking a staged leak must
        // not also be reported as too slow.
        spawnSync('sh', [fileURLToPath(new URL(HOOK, ROOT_URL))], { cwd: ROOT, stdio: 'ignore' })
        const elapsed = performance.now() - started

        expect(
            elapsed,
            `${HOOK} took ${Math.round(elapsed)}ms against the ${budget}ms it declares — make it cheaper or move it to CI, do not raise the number to fit`,
        ).toBeLessThan(budget)
    })
})

describe('machine-local tool state', () => {
    it('is ignored at each repository-local tool root', () => {
        const paths = [
            '.agents/workflow-engine/state.json',
            '.claude/workflow-engine-core/cache.json',
            '.codex/workflow-engine/session.json',
            '.opencode/workflow-engine-core/state.json',
        ]
        const result = spawnSync('git', ['check-ignore', '--stdin'], {
            cwd: ROOT,
            encoding: 'utf8',
            input: `${paths.join('\n')}\n`,
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim().split('\n')).toEqual(paths)
    })
})

describe('published tree contains product truth, not development ceremony', () => {
    it('finds no private workflow or numbered implementation labels', () => {
        const hits: string[] = []
        for (const [file, body] of treeContents()) {
            for (const line of scanPublicationPathText(file, body)) hits.push(`${file}:${line}`)
        }
        expect(hits).toEqual([])
    })

    it.each([
        ['numbered phase', 'Phase ' + '4'],
        ['hyphenated phase', 'phase-' + '3'],
        ['underscored phase', 'phase_' + '3'],
        ['compact phase', 'Phase' + '03'],
        ['phase-prefixed identifier', 'Phase' + '3Diagnostic'],
        ['numbered wave', 'Wave ' + '2'],
        ['hyphenated wave', 'wave-' + '2'],
        ['compact wave', 'Wave' + '02'],
        ['numbered plan', 'Plan ' + '03-07'],
        ['hyphenated plan', 'plan-' + '03-07'],
        ['underscored plan', 'plan_' + '03_07'],
        ['compact plan', 'Plan' + '03-07'],
        ['numbered task', 'Task ' + '03-07-01'],
        ['hyphenated task', 'task-' + '03-07-01'],
        ['underscored task', 'task_' + '03_07_01'],
        ['compact task', 'Task' + '03-07-01'],
        ['milestone shorthand', 'milestone M' + '8'],
        ['requirement shorthand', 'REQ-' + 'F3.9'],
        ['underscored requirement shorthand', 'REQ_' + 'F3.9'],
        ['spaced requirement shorthand', 'REQ ' + 'F3.9'],
        ['local planning path', '.local-notes/' + 'STATE.md'],
        ['local harness worktree', '.claude/work' + 'trees/example'],
        ['alternate local harness worktree', '.codex/work' + 'trees/example'],
        ['suffix-style plan record', '03-07-' + 'PLAN.md'],
        ['suffix-style task record', '03-07-01-' + 'task.md'],
    ])('proves it catches %s', (_kind, planted) => {
        expect(scanPublicationPathText('src/example.ts', planted)).toEqual([1])
    })

    it('does not mistake product terminology for development ceremony', () => {
        for (const ordinary of ['Apple M' + '2 support', 'ISO M' + '2 fastener', 'RFC(12-34)', 'range(03-07)']) {
            expect(scanPublicationPathText('docs/product.md', ordinary), ordinary).toEqual([])
        }
    })

    it('checks suffix-style record paths and scopes commit syntax only to commit messages', () => {
        expect(scanPublicationPathText('docs/03-07-' + 'PLAN.md', 'ordinary text')).toEqual([1])
        expect(scanPublicationPathText('docs/03-07-01-' + 'task.md', 'ordinary text')).toEqual([1])
        expect(scanPublicationPathText('commit-message', 'fix(' + '03-07): internal label')).toEqual([1])
        expect(scanPublicationPathText('docs/product.md', 'range(03-07)')).toEqual([])
    })

    it('allows only necessary ignore rules, not comments or negations, to name private residue', () => {
        expect(scanPublicationPathText('.gitignore', '/.claude/work' + 'trees/')).toEqual([])
        expect(scanPublicationPathText('.gitignore', '# Phase ' + '9 implementation plan')).toEqual([1])
        expect(scanPublicationPathText('.gitignore', '!/.claude/work' + 'trees/state.md')).toEqual([1])
    })

    it.each([
        ['an agent session link', 'Session: https://claude.ai/code/' + 'session_01AbCdEf'],
        ['a session link without a scheme', 'claude.ai/code/' + 'session_01AbCdEf'],
        ['a session trailer', 'Claude-' + 'Session: 01AbCdEf'],
        ['a hosted agent task link', 'chatgpt.com/' + 'codex/tasks/task_e_0123'],
        ['an arbitrary URL', 'Context: https://' + 'tracker.example.invalid/browse/X-1'],
    ])('rejects %s in a commit message only', (_kind, planted) => {
        expect(scanPublicationPathText('commit-message', planted)).toEqual([1])
        expect(scanPublicationPathText('docs/product.md', 'See https://' + 'docs.example.invalid/guide')).toEqual([])
    })

    it('allows links to the public repository in commit messages', () => {
        expect(scanPublicationPathText('commit-message', 'Fixes https://github.com/b0dea/cockpit/issues/12')).toEqual([])
        expect(scanPublicationPathText('commit-message', 'See https://github.com/b0dea/cockpit-fork/pull/1')).toEqual([1])
    })

    it('blocks private development labels and credentials in commit messages', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'cockpit-commit-message-'))
        const bad = join(tmp, 'bad-message')
        const leaked = join(tmp, 'leaked-message')
        const good = join(tmp, 'good-message')
        const hook = (message: string) => spawnSync('sh', [fileURLToPath(new URL(COMMIT_MESSAGE_HOOK, ROOT_URL)), message], {
            cwd: ROOT,
            encoding: 'utf8',
        })
        try {
            writeFileSync(bad, 'fix(' + '03-07): internal label\n')
            writeFileSync(leaked, 'Rotate the key\n\nOld value sk_' + 'live_synthetic\n')
            // Git hands the hook the message before it strips comments, so a verbose commit's diff is still present.
            writeFileSync(good, 'fix: preserve environment lock ownership\n'
                + '# Please enter the commit message. https://' + 'example.invalid/help\n'
                + '# ------------------------ >8 ------------------------\n'
                + '+See https://' + 'example.invalid/diff-line\n')

            const rejected = hook(bad)
            const identified = hook(leaked)
            const accepted = hook(good)

            expect(rejected.status).toBe(1)
            expect(rejected.stderr).toContain('private development ceremony')
            expect(identified.status).toBe(1)
            expect(identified.stderr).toContain('consumer-identifying material')
            expect(identified.stderr).not.toContain('sk_' + 'live_')
            expect(accepted.status, accepted.stderr).toBe(0)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })
})

describe('the public repository boundary', () => {
    const read = (rel: string) => readFileSync(new URL(rel, ROOT_URL), 'utf8')

    it('publishes no repository-local development configuration', () => {
        expect(privateDevelopmentPaths(trackedFiles())).toEqual([])
        expect(privateDevelopmentPaths([
            'AGENTS.md', 'CLAUDE.md', '.claude/skills', '.agents/skills/verify-harness-capability/SKILL.md',
        ])).toEqual([])
        const unpublished = [
            '.claude/settings.json', '.claude/skills/x/SKILL.md',
            '.codex/config.toml', '.opencode/opencode.json', '.agents/other.md', '.agents/skills',
        ]
        expect(privateDevelopmentPaths(unpublished)).toEqual(unpublished)
        const controls = [
            '.agent-runtime/state.json',
            'tools/workflow-engine/cache.json',
            'tools/workflow-engine-core/session.json',
        ]
        expect(privateDevelopmentPaths(controls, [
            '.agent-runtime',
            'tools/workflow-engine',
            'tools/workflow-engine-core',
        ])).toEqual([
            '.agent-runtime/state.json',
            'tools/workflow-engine/cache.json',
            'tools/workflow-engine-core/session.json',
        ])
    })

    it('shipped surfaces are templates, not copies of ours', () => {
        for (const f of ['packages/cockpit/surfaces/skills/cockpit-fix.skill.md', 'packages/cockpit/surfaces/agents/evaluator.agent.md']) {
            const body = read(f)
            expect(body, `${f} must declare itself a shipped surface`).toMatch(/SHIPPED SURFACE/)
        }
    })

    it('a shipped surface never references this repository as the product', () => {
        // The failure this catches: copying repository-maintenance instructions into the shipped tree, so a
        // consumer's agent is told to run this codebase's test suite against their business.
        for (const f of ['packages/cockpit/surfaces/skills/cockpit-fix.skill.md', 'packages/cockpit/surfaces/agents/evaluator.agent.md']) {
            const body = read(f)
            expect(body, f).not.toMatch(/\bnpm run typecheck\b|\bcockpit\.toml['"`]?\s+schema\b|packages\/cockpit\/src/)
        }
    })

    it('proves it can fail, on a control', () => {
        expect(/SHIPPED SURFACE/.test('a file with no such marker')).toBe(false)
    })
})
