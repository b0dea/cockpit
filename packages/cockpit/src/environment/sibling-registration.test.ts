import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import { runSiblingAdd, runSiblingRemove, type SiblingAddInput } from './sibling-registration.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

// The generated service pins `api` as referenced; `docs` is declared and unreferenced.
const CONFIG = [
    '# Estate layout: keep the comments below, they belong to the maintainers.',
    '[cockpit]', 'name = "synthetic-siblings"', 'siblings_root = "siblings"', '',
    '# The API.',
    '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "always"', 'acquire = "none"',
    'var = "API_DIR"', 'purpose = "Synthetic API"', '',
    '# The docs site.',
    '[[sibling]]', 'slug = "docs"', 'dir = "docs"', 'mount = "none"', 'acquire = "none"',
    'var = "DOCS_DIR"', 'purpose = "Synthetic docs"', '',
    '# Port leases.',
    '[ports.bases]', 'API_HOST_PORT = 4100', '',
    '# Machine floor, measured once.',
    '[environment.machine]', 'runtime_memory_mb = 512', 'runtime_cpus = 1', 'free_disk_mb = 1024', 'cold_start_seconds = 60', '',
    '[environment.generated]', 'compose_file = "compose.generated.yml"', '',
    '[[environment.generated.services]]', 'id = "api"', 'sibling = "api"', 'build = { context = "." }',
    'command = ["node", "server.mjs"]',
    'ports = [{ name = "http", host_variable = "API_HOST_PORT", internal = 3000 }]', '',
    '[environment.generated.services.health]', 'property = "GET /health returns 200"',
    'probe = { location = "in-stack", service = "api", cwd = ".", argv = ["node", "-e", "process.exit(0)"], timeout_seconds = 10 }',
    'interval_seconds = 5', 'timeout_seconds = 3', 'retries = 4', 'start_period_seconds = 20', '',
].join('\n')

async function estate() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-test-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, CONFIG)
    await mkdir(join(root, 'siblings', 'api'), { recursive: true })
    await mkdir(join(root, 'siblings', 'docs'), { recursive: true })
    return { root, configPath, siblings: join(root, 'siblings') }
}

const env = { PATH: process.env.PATH }
const add = (input: Pick<SiblingAddInput, 'configPath' | 'slug'> & Partial<SiblingAddInput>) =>
    runSiblingAdd({ create: false, env, ...input }, { execute: executeProbe })

async function loaded(configPath: string) {
    const result = await loadCockpitConfig(configPath)
    if (result.kind !== 'complete') throw new Error(`fixture config is invalid: ${result.diagnostics[0]?.message}`)
    return result.result.config
}

async function treeDigest(root: string): Promise<string> {
    const hash = createHash('sha256')
    const walk = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const path = join(directory, entry.name)
            hash.update(path)
            if (entry.isDirectory()) await walk(path)
            else hash.update(await readFile(path))
        }
    }
    await walk(root)
    return hash.digest('hex')
}

describe('sibling add', () => {
    it('--create initialises a repository, records acquire none, and prints how to publish it', async () => {
        const { configPath, siblings } = await estate()

        const outcome = await add({ configPath, slug: 'billing-api', create: true, purpose: 'Billing service' })

        expect(outcome.diagnostics).toEqual([])
        expect(outcome.status).toBe(0)
        expect((await stat(join(siblings, 'billing-api', '.git'))).isDirectory()).toBe(true)
        const row = (await loaded(configPath)).sibling.find((sibling) => sibling.slug === 'billing-api')
        expect(row).toMatchObject({ dir: 'billing-api', acquire: 'none', mount: 'always', var: 'BILLING_API_DIR', purpose: 'Billing service' })
        expect(row?.remote).toBeUndefined()
        expect(outcome.artifact).toContain('gh repo create <owner>/billing-api')
        expect(outcome.artifact).toContain('sibling add billing-api')
        expect(outcome.artifact).toContain('--remote <url>')
    })

    it('--create grows a cockpit whose only sibling is its own root', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-genesis-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, ['[cockpit]', 'name = "genesis"', 'siblings_root = "."', '',
            '[[sibling]]', 'slug = "genesis"', 'dir = "."', 'mount = "none"', 'acquire = "none"',
            'var = "GENESIS_DIR"', 'purpose = "Product notes"', '', '[ports]', 'bases = {}', ''].join('\n'))

        const outcome = await add({ configPath, slug: 'api', create: true, purpose: 'HTTP API' })

        expect(outcome).toMatchObject({ status: 0, diagnostics: [] })
        expect((await stat(join(root, 'api', '.git'))).isDirectory()).toBe(true)
        expect((await loaded(configPath)).sibling.map((row) => [row.slug, row.dir])).toEqual([['genesis', '.'], ['api', 'api']])
    })

    it('--create refuses a path that already has content and changes nothing', async () => {
        const { configPath, siblings } = await estate()
        await mkdir(join(siblings, 'ledger'))
        await writeFile(join(siblings, 'ledger', 'notes.txt'), 'keep me')
        const before = await readFile(configPath, 'utf8')

        const outcome = await add({ configPath, slug: 'ledger', create: true, purpose: 'Ledger' })

        expect(outcome.status).toBe(2)
        expect(outcome.diagnostics[0]?.code).toBe('SIBLING_PATH_NOT_EMPTY')
        expect(await readFile(configPath, 'utf8')).toBe(before)
        await expect(stat(join(siblings, 'ledger', '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(siblings, 'ledger', 'notes.txt'), 'utf8')).toBe('keep me')
    })

    it('--from records the origin of a checkout elsewhere and leaves that checkout byte-identical', async () => {
        const { root, configPath, siblings } = await estate()
        const scattered = join(root, 'elsewhere', 'widgets')
        await mkdir(scattered, { recursive: true })
        execFileSync('git', ['init', '--quiet', scattered])
        execFileSync('git', ['-C', scattered, 'remote', 'add', 'origin', 'https://git.invalid/team/widgets.git'])
        await writeFile(join(scattered, 'README.md'), 'widgets')
        const before = await treeDigest(scattered)

        const outcome = await add({ configPath, slug: 'widgets', from: scattered, purpose: 'Widgets' })

        expect(outcome.diagnostics).toEqual([])
        expect(await treeDigest(scattered)).toBe(before)
        const row = (await loaded(configPath)).sibling.find((sibling) => sibling.slug === 'widgets')
        expect(row).toMatchObject({ dir: 'widgets', acquire: 'auto', remote: 'https://git.invalid/team/widgets.git', mount: 'always' })
        await expect(stat(join(siblings, 'widgets'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('--from refuses a checkout with no origin and says how to proceed', async () => {
        const { root, configPath } = await estate()
        const local = join(root, 'elsewhere', 'scratch')
        await mkdir(local, { recursive: true })
        execFileSync('git', ['init', '--quiet', local])
        const before = await readFile(configPath, 'utf8')

        const outcome = await add({ configPath, slug: 'scratch', from: local, purpose: 'Scratch' })

        expect(outcome.status).toBe(2)
        expect(outcome.diagnostics[0]).toMatchObject({ code: 'SIBLING_REMOTE_MISSING' })
        expect(outcome.diagnostics[0]?.message).toContain('--dir')
        expect(outcome.diagnostics[0]?.message).toContain('remote add origin')
        expect(await readFile(configPath, 'utf8')).toBe(before)
    })

    it('--remote turns an existing acquire none sibling into a recorded remote without cloning', async () => {
        const { configPath, siblings } = await estate()
        await writeFile(join(siblings, 'docs', 'index.md'), 'already here')
        const before = await treeDigest(siblings)

        const outcome = await add({ configPath, slug: 'docs', remote: 'https://git.invalid/team/docs.git' })

        expect(outcome.diagnostics).toEqual([])
        expect(await treeDigest(siblings)).toBe(before)
        const row = (await loaded(configPath)).sibling.find((sibling) => sibling.slug === 'docs')
        expect(row).toMatchObject({ acquire: 'auto', remote: 'https://git.invalid/team/docs.git', dir: 'docs', mount: 'none' })
        expect((await loaded(configPath)).sibling).toHaveLength(2)
    })

    it('refuses a slug that is already declared, naming it', async () => {
        const { configPath } = await estate()
        const before = await readFile(configPath, 'utf8')

        const outcome = await add({ configPath, slug: 'api', create: true, purpose: 'Again' })

        expect(outcome.status).toBe(2)
        expect(outcome.diagnostics[0]).toMatchObject({ code: 'SIBLING_SLUG_DUPLICATE', target: 'api' })
        expect(await readFile(configPath, 'utf8')).toBe(before)
    })

    it('keeps comments and layout elsewhere in the file when it appends a table', async () => {
        const { configPath, siblings } = await estate()
        await mkdir(join(siblings, 'queue'))

        const outcome = await add({ configPath, slug: 'queue', purpose: 'Job queue' })

        expect(outcome.diagnostics).toEqual([])
        const after = await readFile(configPath, 'utf8')
        // Every original line is still there, in order, with the new table slotted in beside its siblings.
        const remaining = after.split('\n')
        let cursor = 0
        for (const line of CONFIG.split('\n')) {
            cursor = remaining.indexOf(line, cursor)
            expect(cursor, `original line lost or reordered: ${line}`).toBeGreaterThanOrEqual(0)
        }
        expect(after.indexOf('slug = "queue"')).toBeLessThan(after.indexOf('[ports.bases]'))
        expect(after).toContain('# Machine floor, measured once.')
        expect((await loaded(configPath)).sibling.map((sibling) => sibling.slug)).toEqual(['api', 'docs', 'queue'])
    })
})

describe('sibling add purpose', () => {
    it('refuses a new sibling without --purpose and shows an example, writing nothing', async () => {
        const { configPath, siblings } = await estate()
        await mkdir(join(siblings, 'orders'))
        const before = await readFile(configPath, 'utf8')

        const outcome = await add({ configPath, slug: 'orders' })

        expect(outcome.status).toBe(2)
        expect(outcome.diagnostics[0]).toMatchObject({ code: 'CLI_USAGE_INVALID', target: '--purpose' })
        expect(outcome.diagnostics[0]?.message).toContain('--purpose "HTTP API for orders"')
        expect(await readFile(configPath, 'utf8')).toBe(before)
    })
})

describe('sibling remove', () => {
    it('refuses while a generated service references the sibling, and removes an unreferenced one leaving the checkout and comments alone', async () => {
        const { configPath, siblings } = await estate()
        await writeFile(join(siblings, 'docs', 'index.md'), 'checkout content')
        const before = await readFile(configPath, 'utf8')

        const blocked = await runSiblingRemove({ configPath, slug: 'api' })

        expect(blocked.status).toBe(2)
        expect(blocked.diagnostics[0]?.code).toBe('SIBLING_REFERENCED')
        expect(blocked.diagnostics[0]?.message).toContain('environment.generated.services[0].sibling')
        expect(await readFile(configPath, 'utf8')).toBe(before)

        const removed = await runSiblingRemove({ configPath, slug: 'docs' })

        expect(removed.diagnostics).toEqual([])
        expect(removed.status).toBe(0)
        expect((await loaded(configPath)).sibling.map((sibling) => sibling.slug)).toEqual(['api'])
        expect(await readFile(join(siblings, 'docs', 'index.md'), 'utf8')).toBe('checkout content')
        const after = await readFile(configPath, 'utf8')
        expect(after).not.toContain('slug = "docs"')
        expect(after).toContain('# Machine floor, measured once.')
        expect(after).toContain('# Port leases.\n[ports.bases]')
        expect(removed.artifact).toContain('sync --dry-run')
        expect(removed.artifact).toContain('.sibling-docs-CLAUDE.md')
    })
})
