import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import type { ExecutionStep } from './contract.js'
import { initializeLocalGitRepository, runSiblingAdd, runSiblingRemove, type SiblingAddInput } from './sibling-registration.js'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The cockpit's own compose.yml builds `api`; `docs` is declared and unreferenced.
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
    '[environment]', 'compose_files = ["compose.yml"]', '',
].join('\n')

async function estate() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-test-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, CONFIG)
    await writeFile(join(root, 'compose.yml'), 'services:\n  api:\n    build: ${API_DIR}\n    volumes: ["${API_DIR}:/app"]\n')
    await mkdir(join(root, 'siblings', 'api'), { recursive: true })
    await mkdir(join(root, 'siblings', 'docs'), { recursive: true })
    return { root, configPath, siblings: join(root, 'siblings') }
}

// A private home keeps the lifecycle-state lookup away from the developer's real state root.
const home = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-home-')))
afterAll(() => rm(home, { recursive: true, force: true }))
const env = { PATH: process.env.PATH, HOME: home }
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

describe('sibling Git executable search', () => {
    it('keeps all POSIX sibling Git children restricted to the original PATH', async () => {
        const { root, configPath } = await estate()
        const target = join(root, 'dedicated')
        await mkdir(target)
        const search = { ...env, Path: '/ignored-case-alias',
            GIT_CONFIG_GLOBAL: 'synthetic-config-canary', UNRELATED: 'synthetic-environment-canary' }
        const steps: ExecutionStep[] = []
        const execute = async (step: ExecutionStep) => {
            steps.push(step)
            return executeProbe(step)
        }

        expect(await initializeLocalGitRepository({ path: target, env: search }, { execute })).toEqual({ kind: 'complete' })
        const created = await runSiblingAdd({ configPath, slug: 'worker', create: true, purpose: 'Synthetic worker', env: search }, { execute })
        expect(created.status).toBe(0)
        execFileSync('git', ['-C', target, 'remote', 'add', 'origin', 'https://git.invalid/team/tools.git'])
        const imported = await runSiblingAdd({ configPath, slug: 'tools', create: false, from: target,
            purpose: 'Synthetic tools', env: search }, { execute })
        expect(imported.status).toBe(0)

        expect(steps.map(step => step.id)).toEqual(['repository:init', 'repository:root', 'sibling:init', 'sibling:origin'])
        expect(steps.map(step => step.env)).toEqual(Array.from({ length: 4 }, () => ({ PATH: env.PATH ?? '' })))
    })
})

describe('local repository initialization', () => {
    it.each(['symlink', 'gitfile', 'unrelated'] as const)('refuses %s content before adopting a dedicated directory', async kind => {
        const { root } = await estate()
        const target = join(root, 'dedicated')
        const external = join(root, 'external')
        await mkdir(target)
        execFileSync('git', ['init', '--quiet', external])
        if (kind === 'symlink') await symlink(join(external, '.git'), join(target, '.git'), 'dir')
        else if (kind === 'gitfile') await writeFile(join(target, '.git'), `gitdir: ${join(external, '.git')}\n`)
        else await writeFile(join(target, 'notes.txt'), 'unrelated work\n')
        const before = await treeDigest(external)

        const outcome = await initializeLocalGitRepository({ path: target, env }, { execute: executeProbe })

        expect(outcome).toMatchObject({ kind: 'refusal', reason: expect.stringContaining(target) })
        expect(await treeDigest(external)).toBe(before)
        if (kind === 'unrelated') await expect(stat(join(target, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses a replaced dedicated directory before Git can write elsewhere', async () => {
        const { root } = await estate()
        const target = join(root, 'dedicated')
        const external = join(root, 'external')
        await mkdir(target)
        await mkdir(external)
        await writeFile(join(external, 'notes.txt'), 'unrelated work\n')
        const before = await treeDigest(external)
        const outcome = await initializeLocalGitRepository({ path: target, env }, { execute: async step => {
            if (step.argv.includes('init')) {
                await rename(target, `${target}-original`)
                await symlink(external, target, 'dir')
            }
            return executeProbe(step)
        } })

        expect(outcome).toMatchObject({ kind: 'refusal' })
        expect(await treeDigest(external)).toBe(before)
    })

    it('resumes a genuine dedicated repository without reinitializing it', async () => {
        const { root } = await estate()
        const target = join(root, 'dedicated')
        execFileSync('git', ['init', '--quiet', target])
        await writeFile(join(target, 'notes.txt'), 'product notes\n')
        const before = await treeDigest(target)
        const invocations: string[][] = []
        const outcome = await initializeLocalGitRepository({ path: target, env }, { execute: async step => {
            invocations.push([...step.argv])
            return executeProbe(step)
        } })

        expect(outcome).toEqual({ kind: 'complete' })
        expect(invocations.some(argv => argv.includes('init'))).toBe(false)
        expect(await treeDigest(target)).toBe(before)
    })
})

describe('sibling add', () => {
    it('--create initialises a repository, records acquire none, and prints how to publish it', async () => {
        const { configPath, siblings } = await estate()

        const outcome = await add({ configPath, slug: 'billing-api', create: true, purpose: 'Billing service' })

        expect(outcome.diagnostics).toEqual([])
        expect(outcome.status).toBe(0)
        expect((await stat(join(siblings, 'billing-api', '.git'))).isDirectory()).toBe(true)
        const row = (await loaded(configPath)).sibling.find((sibling) => sibling.slug === 'billing-api')
        expect(row).toMatchObject({ dir: 'billing-api', acquire: 'none', mount: 'none', var: 'BILLING_API_DIR', purpose: 'Billing service' })
        expect(row?.remote).toBeUndefined()
        const publish = {
            command: `gh repo create <owner>/billing-api --private --source ${JSON.stringify(join(siblings, 'billing-api'))} --remote origin`,
            recordRemote: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing-api --config ${configPath} --remote <url>`,
        }
        expect(outcome.result).toMatchObject({ action: 'created', publish })
        expect(outcome.artifact).toContain(publish.command)
        expect(outcome.artifact).toContain(publish.recordRemote)
    })

    it('leaves a cockpit.toml edited during --create alone and says to rerun once that edit finishes', async () => {
        const { configPath } = await estate()
        const edited = `${CONFIG}\n# another editor's change\n`
        const outcome = await runSiblingAdd({ configPath, slug: 'billing-api', create: true, purpose: 'Billing service', env }, {
            execute: async (step) => {
                if (step.id === 'sibling:init') await writeFile(configPath, edited)
                return executeProbe(step)
            },
        })

        expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'CONFIG_CHANGED_DURING_EXECUTION',
            message: expect.stringContaining('nothing was written'),
            fix: 'let the other edit finish, then run the same ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add command again' }] })
        expect(await readFile(configPath, 'utf8')).toBe(edited)
    })

    it('derives a safe sibling variable and refuses an explicit runtime control', async () => {
        const { configPath, siblings } = await estate()
        await mkdir(join(siblings, 'compose-product'))

        const outcome = await add({ configPath, slug: 'compose-product', purpose: 'Synthetic Compose application' })

        expect(outcome).toMatchObject({ status: 0, diagnostics: [], result: {
            sibling: { slug: 'compose-product', var: 'SIBLING_COMPOSE_PRODUCT_DIR' },
        } })
        expect((await loaded(configPath)).sibling.find(({ slug }) => slug === 'compose-product')?.var)
            .toBe('SIBLING_COMPOSE_PRODUCT_DIR')
        const before = await readFile(configPath, 'utf8')
        const refused = await add({ configPath, slug: 'worker', purpose: 'Synthetic worker', varName: 'DOCKER_HOST' })
        expect(refused).toMatchObject({ status: 2, diagnostics: [{
            code: 'CLI_USAGE_INVALID', target: '--var',
            message: expect.stringContaining('must not control Docker, Compose or the host process'),
        }] })
        expect(await readFile(configPath, 'utf8')).toBe(before)
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

    it('records a compose-first sibling as mount none unless --mount says otherwise', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-mount-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, [
            '[cockpit]', 'name = "compose-mounts"', 'siblings_root = "."', '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "always"', 'acquire = "none"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
            '[ports.bases]', 'API_HOST_PORT = 4100', '',
            '[environment]', 'compose_files = ["compose.yml"]', '',
        ].join('\n'))

        const defaulted = await add({ configPath, slug: 'worker', create: true, purpose: 'Synthetic worker' })

        expect(defaulted).toMatchObject({ status: 0, diagnostics: [], result: { sibling: { mount: 'none' } } })
        expect((defaulted.result as { sources: { mount: string } }).sources.mount).toContain('compose-first')
        expect(defaulted.artifact).toContain('--mount always')
        expect((await loaded(configPath)).sibling.find(({ slug }) => slug === 'worker')?.mount).toBe('none')

        const explicit = await add({ configPath, slug: 'queue', create: true, purpose: 'Synthetic queue', mount: 'profile:jobs' })
        expect(explicit).toMatchObject({ status: 0, result: { sibling: { mount: 'profile:jobs' }, sources: { mount: '--mount' } } })

        const before = await readFile(configPath, 'utf8')
        for (const [mount, message] of [['sometimes', 'always, none or profile:<name>'], ['host', 'host_reason']] as const) {
            expect(await add({ configPath, slug: 'cache', create: true, purpose: 'Synthetic cache', mount })).toMatchObject({
                status: 2, diagnostics: [{ code: 'CLI_USAGE_INVALID', target: '--mount', message: expect.stringContaining(message) }] })
        }
        expect(await readFile(configPath, 'utf8')).toBe(before)
    })

    it('records an explicitly approved instruction pointer for setup to fulfill', async () => {
        const { configPath, siblings } = await estate()
        await mkdir(join(siblings, 'worker'))

        const outcome = await add({ configPath, slug: 'worker', purpose: 'Synthetic worker', instructionPointer: true })

        expect(outcome).toMatchObject({ status: 0, result: { sibling: { instruction_pointer: true } } })
        expect(await readFile(configPath, 'utf8')).toContain('instruction_pointer = true')
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
        expect(row).toMatchObject({ dir: 'widgets', acquire: 'auto', remote: 'https://git.invalid/team/widgets.git', mount: 'none' })
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
    it('removes an unreferenced sibling, leaving the checkout and comments alone', async () => {
        const { configPath, siblings } = await estate()
        await writeFile(join(siblings, 'docs', 'index.md'), 'checkout content')

        const removed = await runSiblingRemove({ configPath, env, slug: 'docs' })

        expect(removed.diagnostics).toEqual([])
        expect(removed.status).toBe(0)
        expect((await loaded(configPath)).sibling.map((sibling) => sibling.slug)).toEqual(['api'])
        expect(await readFile(join(siblings, 'docs', 'index.md'), 'utf8')).toBe('checkout content')
        const after = await readFile(configPath, 'utf8')
        expect(after).not.toContain('slug = "docs"')
        expect(after).toContain('# Machine floor, measured once.')
        expect(after).toContain('# Port leases.\n[ports.bases]')
        expect(removed.artifact).toContain(`./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${configPath} --dry-run`)
        expect(removed.result).toEqual({ action: 'removed', config: configPath, slug: 'docs', dir: 'docs',
            next: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${configPath} --dry-run` })
    })

    it('refuses while the cockpit\'s own Compose file uses the sibling\'s variable', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-compose-')))
        roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, [
            '[cockpit]', 'name = "compose-siblings"', 'siblings_root = "."', '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "always"', 'acquire = "none"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
            '[[sibling]]', 'slug = "web"', 'dir = "web"', 'mount = "always"', 'acquire = "none"', 'var = "WEB_DIR"', 'purpose = "Synthetic web"', '',
            '[ports.bases]', 'API_HOST_PORT = 4100', '',
            '[environment]', 'compose_files = ["compose.yml"]', '',
        ].join('\n'))
        await mkdir(join(root, 'api'))
        await mkdir(join(root, 'web'))
        await writeFile(join(root, 'compose.yml'), 'services:\n  web:\n    build: ${WEB_DIR}\n  api:\n    build: ${API_DIR}\n')
        const before = await readFile(configPath, 'utf8')

        const blocked = await runSiblingRemove({ configPath, env, slug: 'web' })

        expect(blocked.status).toBe(2)
        expect(blocked.diagnostics[0]).toMatchObject({ code: 'SIBLING_REFERENCED',
            message: expect.stringContaining('compose.yml (mentions WEB_DIR)') })
        expect(await readFile(configPath, 'utf8')).toBe(before)
    })
})
