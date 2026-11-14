import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect } from 'vitest'
import { parseNpmPackJson } from '../npm-pack-json.js'

// Adopter journeys drive cockpit the way an adopter does: the packed tarball installed into a fresh
// product repository, every command a separate process of the installed launcher, against a fake
// `docker` first on PATH. They import nothing from cockpit's source, so they keep passing while its
// internals are rewritten, and they assert only what a user sees: exit codes, diagnostic codes,
// files and the Docker calls made. The tarball packs dist as built, so run `npm run build` first.

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const fakeDocker = fileURLToPath(new URL('./fake-docker.mjs', import.meta.url))
const yamlParser = pathToFileURL(join(repositoryRoot, 'node_modules/yaml/dist/index.js')).href

// One scratch directory per test file holds every product, home and fake daemon.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-journey-')))
const daemons: string[] = []

/** Ends the port listeners of every fake container still running, then removes the scratch tree. */
export function removeScratch(): void {
    for (const statePath of daemons) {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as { containers: { listeners?: number[] }[] }
        for (const pid of state.containers.flatMap((container) => container.listeners ?? [])) {
            try { process.kill(pid) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
    }
    rmSync(scratch, { recursive: true, force: true })
}

let tarball: string | undefined
function packedTarball(): string {
    if (tarball) return tarball
    // The tarball packs dist as built; a source edit since the build would be silently untested.
    const source = join(repositoryRoot, 'packages/cockpit/src')
    const built = statSync(join(repositoryRoot, 'packages/cockpit/dist/cli.js')).mtimeMs
    const stale = readdirSync(source, { recursive: true, encoding: 'utf8' })
        .find((path) => /(?<!\.test)\.ts$/.test(path) && !path.startsWith('test-support') && statSync(join(source, path)).mtimeMs > built)
    if (stale) throw new Error(`packages/cockpit/src/${stale} changed after the last build; run npm run build before the journeys`)
    const destination = join(scratch, 'pack')
    mkdirSync(destination)
    const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
        cwd: join(repositoryRoot, 'packages/cockpit'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    })
    tarball = join(destination, parseNpmPackJson(output).filename)
    return tarball
}

// What `npm install --save-dev --save-exact` lays out, without the registry: the tarball's bytes,
// its declared dependencies beside it and the .bin link. Under pnpm the package lives in
// node_modules/.pnpm behind a symlink, .bin holds a shell shim, and a pnpm lockfile is present.
function install(root: string, layout: 'npm' | 'pnpm'): void {
    const modules = join(root, 'node_modules')
    const store = layout === 'npm' ? modules : join(modules, '.pnpm/@b00dea+cockpit/node_modules')
    const installed = join(store, '@b00dea/cockpit')
    mkdirSync(installed, { recursive: true })
    execFileSync('tar', ['-xzf', packedTarball(), '-C', installed, '--strip-components=1'])
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> }
    for (const dependency of Object.keys(manifest.dependencies)) {
        cpSync(join(repositoryRoot, 'node_modules', dependency), join(store, dependency), { recursive: true })
    }
    mkdirSync(join(modules, '.bin'), { recursive: true })
    if (layout === 'npm') {
        symlinkSync('../@b00dea/cockpit/bin/cockpit.mjs', join(modules, '.bin/cockpit'))
    } else {
        mkdirSync(join(modules, '@b00dea'))
        symlinkSync('../.pnpm/@b00dea+cockpit/node_modules/@b00dea/cockpit', join(modules, '@b00dea/cockpit'))
        writeFileSync(join(modules, '.bin/cockpit'), [
            '#!/bin/sh', 'basedir=$(dirname "$0")',
            'exec node "$basedir/../.pnpm/@b00dea+cockpit/node_modules/@b00dea/cockpit/bin/cockpit.mjs" "$@"', '',
        ].join('\n'), { mode: 0o755 })
        writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    pkg.devDependencies = { '@b00dea/cockpit': manifest.version }
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

// A synthetic product: one app directory bind-mounted into one service, a resettable volume beside
// one that is not, a unit stage and a stage that needs the running stack, team instructions and a
// reviewed cockpit.toml that lets an agent apply a reset.
export const PRODUCT_FILES: Readonly<Record<string, string>> = {
    'compose.yml': `services:
  app:
    image: node:22-alpine
    command: ["sh", "-c", "echo app listening; while :; do sleep 3600; done"]
    ports: ["127.0.0.1:\${APP_PORT:-4100}:3000"]
    volumes: ["./app:/app", "data:/data", "cache:/cache"]
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
volumes:
  data: {}
  cache: {}
`,
    'cockpit.toml': `[cockpit]
name = "shop"
siblings_root = "."

[[sibling]]
slug = "app"
dir = "app"
mount = "always"
acquire = "none"
var = "APP_DIR"
purpose = "Synthetic app"

[ports.bases]
APP_PORT = 4100

[environment]
compose_files = ["compose.yml"]
addressing = "port"
authentication = "none"
posture_requirements = [{ requirement = "leased-localhost-ports", addressing = "port" }]
resettable_volumes = ["data"]

[environment.machine]
runtime_memory_mb = 512
runtime_cpus = 1
free_disk_mb = 1024
cold_start_seconds = 120

[testing]
stages = [
  { id = "unit", command = ["npm", "test"], requires_stack = false, select = { test = ["--", "{value}"] } },
  { id = "smoke", command = ["node", "smoke.mjs"], requires_stack = true },
]
gates = [
  { id = "unit", tier = "targeted", stages = ["unit"], changes = "Isolated behaviour of the app" },
  { id = "all", tier = "full", stages = ["unit", "smoke"], changes = "Shared behaviour of the running app" },
]

[work]
grading = "checks"

[autonomy]
reset = "agent"
`,
    'package.json': `${JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node test.mjs' } }, null, 2)}\n`,
    'test.mjs': "console.log('1 test passed')\n",
    'smoke.mjs': "console.log('smoke passed')\n",
    'AGENTS.md': '# Shop\n\nTeam notes stay outside the regions cockpit writes.\n',
    'app/AGENTS.md': '# App\n',
    'app/CLAUDE.md': '@AGENTS.md\n',
    '.gitignore': 'node_modules/\n',
}

export interface Run {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly json: { result?: any; diagnostics?: { severity: string; code: string; message: string }[] } | undefined
    /** Codes of the error diagnostics, the ones that fail a command. */
    readonly errors: string[]
}

export interface FakeDocker {
    /** Every argv cockpit gave docker, oldest first. */
    calls(): string[][]
    /** What the daemon holds now, in the shape `docker inspect` reports it. */
    state(): {
        containers: { Id: string; project: string; service: string; Config: { Labels: Record<string, string> } }[]
        volumes: { Name: string; Labels: Record<string, string> }[]
    }
}

/** One developer machine: its own home, temporary directory and Docker daemon. */
export interface Machine { readonly home: string; readonly tmp: string; readonly path: string; readonly docker: FakeDocker }

export function createMachine(name: string, options: { realDocker?: string } = {}): Machine {
    const root = join(scratch, 'machines', name)
    const home = join(root, 'home')
    const tmp = join(root, 'tmp')
    const bin = join(root, 'bin')
    const state = join(root, 'docker')
    for (const directory of [home, tmp, bin, state]) mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(state, 'calls.jsonl'), '')
    writeFileSync(join(state, 'state.json'), JSON.stringify({
        serverVersion: '29.0.0', composeVersion: '2.40.0', operatingSystem: 'Docker Desktop', memTotal: 8 * 1024 ** 3, cpus: 4, sequence: 1,
        images: { 'node:22-alpine': `sha256:${'a'.repeat(64)}` }, containers: [], volumes: [], networks: [],
    }))
    daemons.push(join(state, 'state.json'))
    if (options.realDocker) symlinkSync(options.realDocker, join(bin, 'docker'))
    else writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec ${[process.execPath, fakeDocker, state, yamlParser].map((arg) => JSON.stringify(arg)).join(' ')} "$@"\n`, { mode: 0o755 })
    return {
        home, tmp,
        // Node first after docker, so `node` and `npm` resolve to the runtime running the suite.
        path: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
        docker: {
            calls: () => readFileSync(join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
            state: () => JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')),
        },
    }
}

export interface Product {
    readonly root: string
    readonly env: NodeJS.ProcessEnv
    readonly docker: FakeDocker
    /** Runs one installed-cockpit command as its own process, with `--config cockpit.toml --json` unless told otherwise. */
    cockpit(args: readonly string[], options?: { launcher?: readonly string[]; json?: boolean; config?: boolean }): Run
    write(path: string, text: string): void
    read(path: string): string
    git(...args: string[]): string
}

export function createProduct(name: string, options: {
    machine?: Machine
    files?: Readonly<Record<string, string | null>>
    layout?: 'npm' | 'pnpm'
} = {}): Product {
    const product = productAt(join(scratch, 'products', name), options.machine ?? createMachine(name))
    for (const [path, text] of Object.entries({ ...PRODUCT_FILES, ...options.files })) if (text !== null) product.write(path, text)
    product.git('init', '--quiet', '--initial-branch=main')
    product.git('add', '--all')
    product.git('commit', '--quiet', '--message', 'Initial product')
    install(product.root, options.layout ?? 'npm')
    return product
}

/** A second checkout of the same product on the same machine, as `git clone` makes one. */
export function cloneProduct(source: Product, name: string, machine: Machine): Product {
    const root = join(scratch, 'products', name)
    execFileSync('git', ['clone', '--quiet', source.root, root], { env: source.env })
    cpSync(join(source.root, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true })
    return productAt(root, machine)
}

function productAt(root: string, machine: Machine): Product {
    // Only what a developer's shell carries: no inherited DOCKER_HOST, CI flag or agent session.
    const env: NodeJS.ProcessEnv = {
        PATH: machine.path, HOME: machine.home, TMPDIR: machine.tmp, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Journey', GIT_AUTHOR_EMAIL: 'journey@example.invalid',
        GIT_COMMITTER_NAME: 'Journey', GIT_COMMITTER_EMAIL: 'journey@example.invalid',
    }
    return {
        root, env, docker: machine.docker,
        cockpit(args, { launcher = ['./node_modules/.bin/cockpit'], json = true, config = true } = {}) {
            const [program, ...prefix] = launcher
            const result = spawnSync(program!, [...prefix, ...args, ...config ? ['--config', 'cockpit.toml'] : [], ...json ? ['--json'] : []], {
                cwd: root, env, encoding: 'utf8', timeout: 120_000,
            })
            if (result.error) throw result.error
            const parsed = json && result.stdout.trim() !== '' ? JSON.parse(result.stdout) as Run['json'] : undefined
            return {
                status: result.status, stdout: result.stdout, stderr: result.stderr, json: parsed,
                errors: (parsed?.diagnostics ?? []).filter((row) => row.severity === 'error').map((row) => row.code),
            }
        },
        write: (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) },
        read: (path) => readFileSync(join(root, path), 'utf8'),
        git: (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }),
    }
}

/** A failure message naming the exit code and every diagnostic. */
export function explain(run: Run): string {
    const diagnostics = run.json?.diagnostics?.map((row) => `${row.severity} ${row.code}: ${row.message}`).join('\n')
    return `exit ${run.status}\n${diagnostics ?? run.stdout}\n${run.stderr}`
}

/** Runs one command and expects it to succeed, naming every diagnostic when it does not. */
export function ok(product: Product, args: readonly string[]): Run {
    const run = product.cockpit(args)
    expect(run.status, `${args.join(' ')}: ${explain(run)}`).toBe(0)
    return run
}

export function exists(product: Product, path: string): boolean {
    return existsSync(join(product.root, path))
}
