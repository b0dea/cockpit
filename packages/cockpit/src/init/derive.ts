// Proposes interview answers from files a repository already carries. It owns reading those files
// and attributing each proposed value to its source; it must not decide or write anything. Every
// fact is inferred: init surfaces it with its source and the operator confirms it, because a
// config that looks complete but holds guesses is the failure cockpit exists to prevent.
// Deliberately cheap and exact: Dockerfile, env template variable names, Compose files and CI
// service containers, test entry points and run scripts from build and package manifests, Node
// lockfiles, and each repository's origin remote from .git/config. It starts no process. Orchestrator
// manifests are not parsed; their shape is too varied to read reliably.
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative as pathRelative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readBoundedInput } from '../config/load.js'
import { errorCause, hasErrorCode } from '../environment/contract.js'
import { bindHolder, composeBindPath, composeProjectDirectory, splitComposeShort } from '../environment/compose-topology.js'
import { repositoryIdentity } from '../environment/repository-identity.js'
import { redactSensitiveText } from '../environment/sensitive.js'
import { formatShellCommand, initCommand } from '../fix-catalogue.js'
import { deriveSiblingVariable, TestingName } from '../schema.js'

export interface InferredProvenance {
    readonly kind: 'inferred'
    readonly source: string
    readonly reason: string
}

export interface InferredFact {
    /** Interview fields this fact helps answer. */
    readonly fields: readonly string[]
    readonly target: string
    readonly value: unknown
    readonly provenance: InferredProvenance
}

export interface SkippedInference {
    readonly source: string
    readonly reason: string
}

export interface InferenceResult {
    readonly facts: readonly InferredFact[]
    readonly skipped: readonly SkippedInference[]
}

export interface InferenceInput {
    /** Files must stay under this observed authority root. */
    readonly root: string
    /** Paths surfaced for confirmation are relative to the cockpit that will store them. */
    readonly configurationRoot?: string
    readonly repositories: readonly Readonly<{ slug: string; path: string }>[]
}

const MAX_BYTES = 1024 * 1024
const MAX_WORKFLOWS = 32
export const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SIBLING_SLUG = /^[a-z][a-z0-9-]*$/
// .env.example, .env.staging.example, .env.sample, .env.production.template and the like: files
// meant to be committed, so their names are safe to read. Their values never are.
const ENV_TEMPLATE = /^\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|sample|template)$/
const MAX_ENV_TEMPLATES = 16
// Names only suggest; the human says which host of which non-local environment each points at.
const DATABASE_VARIABLE = /(?:^|_)(?:DATABASE|DB|POSTGRES(?:QL)?|PG|MYSQL|MARIADB|MONGO(?:DB)?|REDIS)(?:_[A-Z0-9]+)*_(?:URL|URI|DSN|HOST)$|^(?:DATABASE_URL|PGHOST|MONGO_URL|REDIS_URL)$/
const VENDOR_VARIABLE = /_(?:API_)?(?:BASE|BASE_URL|URL|ENDPOINT|HOST)$/

type Read = { kind: 'absent' } | { kind: 'skipped'; reason: string } | { kind: 'text'; text: string }
type DirectoryRead = { kind: 'absent' } | { kind: 'skipped'; reason: string }
    | { kind: 'complete'; path: string; dev: number; ino: number }

async function inspectDirectory(root: string, directory: string): Promise<DirectoryRead> {
    const canonicalRoot = resolve(root)
    const path = resolve(canonicalRoot, directory)
    const confined = pathRelative(canonicalRoot, path)
    if (canonicalRoot !== root || confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined)) {
        return { kind: 'skipped', reason: 'escapes the canonical inference root' }
    }
    try {
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'skipped', reason: 'is a redirected directory' }
        const expected = resolve(await realpath(canonicalRoot), directory)
        if (await realpath(path) !== expected) return { kind: 'skipped', reason: 'is a redirected directory' }
        return { kind: 'complete', path, dev: stat.dev, ino: stat.ino }
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { kind: 'absent' }
        return { kind: 'skipped', reason: `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` }
    }
}

function sameDirectory(left: DirectoryRead, right: DirectoryRead): boolean {
    return left.kind === 'complete' && right.kind === 'complete'
        && left.path === right.path && left.dev === right.dev && left.ino === right.ino
}

async function readBounded(root: string, directory: string, name: string): Promise<Read> {
    const parent = await inspectDirectory(root, directory)
    if (parent.kind !== 'complete') return parent
    try {
        const read = await readBoundedInput(resolve(parent.path, name))
        if (read.kind === 'too-large' || read.bytes.byteLength > MAX_BYTES) {
            return { kind: 'skipped', reason: `exceeds the ${MAX_BYTES}-byte inference limit` }
        }
        if (!sameDirectory(parent, await inspectDirectory(root, directory))) {
            return { kind: 'skipped', reason: 'directory changed while the file was read' }
        }
        try { return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } }
        catch { return { kind: 'skipped', reason: 'is not valid UTF-8' } } // Fatal decoding throws only for invalid UTF-8, which the reason names.
    }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { kind: 'absent' }
        if (code === 'ELOOP' || (error instanceof Error && error.message === 'structured input is not a regular file')) {
            return { kind: 'skipped', reason: 'is not a regular file' }
        }
        return { kind: 'skipped', reason: `could not be read (${code ?? 'unknown I/O error'})` }
    }
}

/** Presence only: a lockfile or build marker can exceed the read limit and is never parsed here. */
async function fileExists(root: string, directory: string, name: string): Promise<Read['kind'] | 'present'> {
    const parent = await inspectDirectory(root, directory)
    if (parent.kind !== 'complete') return parent.kind
    try { return (await lstat(resolve(parent.path, name))).isFile() ? 'present' : 'skipped' }
    catch (error) { return hasErrorCode(error, 'ENOENT') ? 'absent' : 'skipped' }
}

function joinLogical(text: string): string[] {
    const lines: string[] = []
    let pending = ''
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (pending === '' && (line === '' || line.startsWith('#'))) continue
        if (line.endsWith('\\')) { pending += `${line.slice(0, -1)} `; continue }
        lines.push((pending + line).trim())
        pending = ''
    }
    if (pending.trim() !== '') lines.push(pending.trim())
    return lines
}

function instructionArgv(argument: string): string[] | undefined {
    if (argument === '') return undefined
    // Docker reads an instruction that is not a valid JSON array of strings as shell form.
    const shellForm = ['sh', '-c', argument]
    if (!argument.startsWith('[')) return shellForm
    try {
        const parsed: unknown = JSON.parse(argument)
        return Array.isArray(parsed) && parsed.length > 0 && parsed.every(part => typeof part === 'string') ? parsed as string[] : shellForm
    } catch { return shellForm } // Docker itself reads an instruction that is not a JSON array as shell form.
}

export interface DockerfileFacts {
    readonly command?: string[]
    readonly ports: number[]
}

export function readDockerfileFacts(text: string): DockerfileFacts {
    // Only the final build stage describes the image that runs.
    let ports: number[] = []
    let entrypoint: string[] | undefined
    let cmd: string[] | undefined
    for (const line of joinLogical(text)) {
        const [keyword = '', ...rest] = line.split(/\s+/)
        const argument = line.slice(keyword.length).trim()
        switch (keyword.toUpperCase()) {
            case 'FROM': ports = []; entrypoint = undefined; cmd = undefined; break
            case 'EXPOSE':
                for (const token of rest) {
                    const match = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(token)
                    if (match && Number(match[1]) >= 1 && Number(match[1]) <= 65535) ports.push(Number(match[1]))
                }
                break
            case 'ENTRYPOINT': entrypoint = instructionArgv(argument); break
            case 'CMD': cmd = instructionArgv(argument); break
        }
    }
    // A shell-form ENTRYPOINT ignores CMD; an exec-form one receives CMD as arguments.
    const shellEntrypoint = entrypoint?.[0] === 'sh' && entrypoint[1] === '-c' && entrypoint.length === 3
    const command = entrypoint === undefined ? cmd : shellEntrypoint ? entrypoint : [...entrypoint, ...(cmd ?? [])]
    return { ...(command === undefined ? {} : { command }), ports: [...new Set(ports)] }
}


function envNames(text: string): string[] {
    const names = new Set<string>()
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([^=\s#]+)\s*=/.exec(line)
        if (match && ENV_NAME.test(match[1]!)) names.add(match[1]!)
    }
    return [...names].sort()
}

function workflowServices(document: unknown): Array<{ job: string; name: string; image: string }> {
    const jobs = (document as { jobs?: unknown } | null)?.jobs
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return []
    const found: Array<{ job: string; name: string; image: string }> = []
    for (const [job, definition] of Object.entries(jobs as Record<string, unknown>)) {
        const services = (definition as { services?: unknown } | null)?.services
        if (!services || typeof services !== 'object' || Array.isArray(services)) continue
        for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
            const image = (service as { image?: unknown } | null)?.image
            if (typeof image === 'string' && image.trim() !== '') found.push({ job, name, image: image.trim() })
        }
    }
    return found
}

// Test entry points, in the order they take precedence within one repository. A build tool that
// selects what a change affects wins over a plain runner, so the targeted gate can rely on it.
const TEST_ENTRY_LOOKED_FOR = 'MODULE.bazel or WORKSPACE, nx.json, turbo.json with a test task, a Makefile test target, a package.json test script, pytest configuration in pyproject.toml or pytest.ini, go.mod and Cargo.toml'
const NODE_LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']] as const
/** The lockfiles a toolchain is proposed from, all of them Node's: the only ones this module maps to a schema toolchain. */
export const NODE_LOCKFILE_NAMES: readonly string[] = NODE_LOCKFILES.map(([name]) => name)
type NodeManager = typeof NODE_LOCKFILES[number][1]
type NodeLockfile = Readonly<{ manager: NodeManager; lockfile: string }>
const PACKAGE_RUN_SCRIPTS = ['start', 'serve', 'dev'] as const

async function nodeLockfile(present: (name: string) => Promise<boolean>): Promise<NodeLockfile | undefined> {
    for (const [lockfile, manager] of NODE_LOCKFILES) if (await present(lockfile)) return { manager, lockfile }
    return undefined
}

const managerReason = (node: NodeLockfile | undefined) => node ? `${node.lockfile} selects ${node.manager}` : 'no lockfile names a package manager, so npm runs it'
// `bun test` runs Bun's own runner instead of the script, so Bun runs the script by name.
const NODE_TEST: Readonly<Record<NodeManager, readonly string[]>> = { npm: ['npm', 'test'], pnpm: ['pnpm', 'test'], yarn: ['yarn', 'test'], bun: ['bun', 'run', 'test'] }
// --no keeps npx from downloading a tool the repository does not install.
const NODE_EXEC: Readonly<Record<NodeManager, readonly string[]>> = { npm: ['npx', '--no'], pnpm: ['pnpm', 'exec'], yarn: ['yarn'], bun: ['bun', 'x'] }
// `npm init` writes this placeholder; proposing it would declare a gate that always fails.
const NPM_PLACEHOLDER_TEST = /no test specified/

type TestEntry = Readonly<{ file: string; full: readonly string[]; affected?: readonly string[]; tool: string; reason: string }>

/** A stage command runs from the cockpit root, so a repository elsewhere is entered first. */
function stageCommand(directory: string, argv: readonly string[]): readonly string[] {
    return directory === '.' ? argv : ['sh', '-c', `cd ${formatShellCommand([directory])} && exec ${formatShellCommand(argv)}`]
}

function jsonObject(text: string | undefined, onInvalid: (cause: string) => void): Record<string, unknown> | undefined {
    if (text === undefined) return undefined
    try {
        const parsed: unknown = JSON.parse(text)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch (error) {
        onInvalid(errorCause(error))
        return undefined
    }
}

const field = (value: unknown, key: string): unknown =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined

const PORT_VARIABLE = /^\$\{([A-Z][A-Z0-9_]*)(?:(:?-)(\d{1,5}))?\}$|^\$([A-Z][A-Z0-9_]*)$/

function entries(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : []
}

/**
 * Reads the bind sources and published host-port variables of the Compose files init proposes.
 * Bind sources resolve as `up` resolves them: against the first file's directory, with each
 * proposed sibling variable set to its directory and any other variable to its own default.
 */
function composeFacts(
    files: readonly Readonly<{ source: string; document: unknown }>[],
    root: string,
    variables: Readonly<Record<string, string>>,
    skipped: SkippedInference[],
): Readonly<{ binds: readonly Readonly<{ source: string; path: string }>[]; bases: ReadonlyMap<string, Readonly<{ base: number; sources: readonly string[] }>> }> {
    const binds: { source: string; path: string }[] = []
    // Each base keeps every file that publishes it, so the proposal names where each value came from.
    const bases = new Map<string, { base: number; sources: string[] }>()
    const conflicting = new Set<string>()
    for (const { source, document } of files) {
        const services = (document as { services?: unknown } | null)?.services
        if (!services || typeof services !== 'object' || Array.isArray(services)) continue
        for (const service of Object.values(services as Record<string, unknown>)) {
            if (!service || typeof service !== 'object') continue
            for (const volume of entries((service as { volumes?: unknown }).volumes)) {
                const segments = typeof volume === 'string' ? splitComposeShort(volume) : undefined
                const raw = segments && segments.length >= 2 ? segments[0]
                    : volume && typeof volume === 'object' && (volume as { type?: unknown }).type === 'bind'
                        ? (volume as { source?: unknown }).source : undefined
                const path = typeof raw === 'string' ? composeBindPath(raw, composeProjectDirectory(root, files.map(file => file.source)), variables) : undefined
                if (path !== undefined && path !== 'volume') binds.push({ source, path })
            }
            for (const port of entries((service as { ports?: unknown }).ports)) {
                const segments = typeof port === 'string' ? splitComposeShort(port) : undefined
                const published = segments && segments.length >= 2 ? segments[segments.length - 2]
                    : port && typeof port === 'object' ? (port as { published?: unknown }).published : undefined
                // A port with no host side is published on an ephemeral host port, which never collides.
                if (published === undefined || published === '') continue
                const match = typeof published === 'string' ? PORT_VARIABLE.exec(published) : null
                if (!match) {
                    skipped.push({ source, reason: `publishes host port ${String(published)} that is not read from a variable with a default, so every stack would bind the same host port and check refuses it; publish it as \${NAME:-<port>} and declare NAME under [ports.bases]` })
                    continue
                }
                const name = (match[1] ?? match[4])!
                const base = match[3] === undefined ? undefined : Number(match[3])
                if (base === undefined || base < 1 || base > 65_535) {
                    skipped.push({ source, reason: `publishes a host port from \${${name}} with no default, so its base port cannot be read; declare ${name} under [ports.bases]` })
                    continue
                }
                const known = bases.get(name)
                if (known && known.base !== base) conflicting.add(name)
                if (!known) bases.set(name, { base, sources: [source] })
                else if (!known.sources.includes(source)) known.sources.push(source)
            }
        }
    }
    for (const name of conflicting) {
        skipped.push({ source: bases.get(name)!.sources.join(', '), reason: `publishes \${${name}} with different defaults, so its base port cannot be read; declare ${name} under [ports.bases]` })
        bases.delete(name)
    }
    return { binds, bases }
}

async function detectTestEntry(
    read: (name: string) => Promise<string | undefined>,
    readJson: (name: string) => Promise<Record<string, unknown> | undefined>,
    present: (name: string) => Promise<boolean>,
    node: NodeLockfile | undefined,
): Promise<TestEntry | undefined> {
    for (const name of ['MODULE.bazel', 'WORKSPACE.bazel', 'WORKSPACE']) {
        if (await present(name)) return { file: name, tool: 'Bazel', full: ['bazel', 'test', '//...'],
            reason: `${name} makes this a Bazel workspace; Bazel reports cached results for tests whose inputs did not change, so the targeted gate runs the same command` }
    }
    const manager = node?.manager ?? 'npm'
    const exec = NODE_EXEC[manager]
    if (await present('nx.json')) return { file: 'nx.json', tool: 'Nx', affected: [...exec, 'nx', 'affected', '-t', 'test'], full: [...exec, 'nx', 'run-many', '-t', 'test'],
        reason: `nx.json makes this an Nx workspace; nx affected compares its defaultBase (main when unset) with the working tree; ${managerReason(node)}` }
    const turbo = await readJson('turbo.json')
    if (turbo && (field(field(turbo, 'tasks'), 'test') !== undefined || field(field(turbo, 'pipeline'), 'test') !== undefined)) {
        return { file: 'turbo.json', tool: 'Turborepo', affected: [...exec, 'turbo', 'run', 'test', '--affected'], full: [...exec, 'turbo', 'run', 'test'],
            reason: `turbo.json declares a test task; --affected compares main...HEAD, so it sees committed changes only; ${managerReason(node)}` }
    }
    const makefile = await read('Makefile')
    if (makefile !== undefined && /^test\s*:(?!=)/m.test(makefile)) return { file: 'Makefile', tool: 'make', full: ['make', 'test'],
        reason: 'the Makefile has a test target and nothing on disk selects a subset, so the targeted gate runs the same command' }
    const scripts = field(await readJson('package.json'), 'scripts')
    const test = field(scripts, 'test')
    if (typeof test === 'string' && test.trim() !== '' && !NPM_PLACEHOLDER_TEST.test(test)) {
        const others = Object.keys(scripts as Record<string, unknown>).filter(name => name.startsWith('test:')).sort()
        return { file: 'package.json', tool: manager, full: NODE_TEST[manager],
            reason: `package.json has a test script; ${managerReason(node)}; nothing on disk selects a subset, so the targeted gate runs the same command${others.length
                ? `; ${others.join(', ')} are not proposed, so declare any that test does not already run` : ''}` }
    }
    const pyproject = await read('pyproject.toml')
    const pytestFile = pyproject !== undefined && /^\[tool\.pytest\.ini_options\]/m.test(pyproject) ? 'pyproject.toml'
        : await present('pytest.ini') ? 'pytest.ini' : undefined
    if (pytestFile) {
        const uv = await present('uv.lock')
        return { file: pytestFile, tool: 'pytest', full: uv ? ['uv', 'run', 'pytest'] : ['python3', '-m', 'pytest'],
            reason: `${pytestFile} configures pytest${uv ? ' and uv.lock selects uv' : ''}; nothing on disk selects a subset, so the targeted gate runs the same command` }
    }
    if (await present('go.mod')) return { file: 'go.mod', tool: 'go', full: ['go', 'test', './...'],
        reason: 'go.mod makes this a Go module; go test caches results for unchanged packages, so the targeted gate runs the same command' }
    if (await present('Cargo.toml')) return { file: 'Cargo.toml', tool: 'cargo', full: ['cargo', 'test'],
        reason: 'Cargo.toml makes this a Cargo package; nothing on disk selects a subset, so the targeted gate runs the same command' }
    return undefined
}

/**
 * The first url of [remote "origin"]: what git clones from. include.path files and insteadOf rewrites
 * are not followed, so a proposal depends on this one file only.
 */
function originUrl(text: string): string | undefined {
    let origin = false
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (line.startsWith('[')) { origin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line); continue }
        const match = origin ? /^url\s*=\s*(.*)$/i.exec(line) : null
        if (!match) continue
        const value = match[1]!
        const url = value.startsWith('"') ? /^"([^"\\]*)"/.exec(value)?.[1] : value.split(/[#;]/, 1)[0]!.trim()
        return url ? url : undefined
    }
    return undefined
}

/** A password, or any user information in an http(s) URL, which is where access tokens are put. */
function carriesCredentials(url: string): boolean {
    if (redactSensitiveText(url) !== url) return true
    const authority = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url)
    if (authority) {
        const at = authority[2]!.lastIndexOf('@')
        return at >= 0 && (authority[2]!.slice(0, at).includes(':') || /^https?$/i.test(authority[1]!))
    }
    const at = url.indexOf('@')
    return at >= 0 && url.slice(0, at).includes(':')
}

// The role leads, so an id starts with a letter even where a sibling slug starts with a digit.
const TESTING_ROLES = ['test', 'affected', 'targeted', 'full'] as const
const testingId = (role: typeof TESTING_ROLES[number], slug: string) => `${role}-${slug}`

/** The [testing] proposal for one repository: a full gate, and a targeted gate on the tool's affected run when it has one. */
function testingProposal(slug: string, entry: TestEntry, directory: string): Readonly<{ stages: unknown[]; gates: unknown[] }> {
    const full = { id: testingId('test', slug), command: stageCommand(directory, entry.full), requires_stack: false }
    const affected = entry.affected ? { id: testingId('affected', slug), command: stageCommand(directory, entry.affected), requires_stack: false } : undefined
    return {
        stages: affected ? [affected, full] : [full],
        gates: [
            { id: testingId('targeted', slug), tier: 'targeted', stages: [(affected ?? full).id],
                changes: affected ? `Isolated behavior in ${slug}; ${entry.tool} selects the affected tests` : `Isolated behavior in ${slug}` },
            { id: testingId('full', slug), tier: 'full', stages: [full.id], changes: `Shared or cross-system behavior in ${slug}` },
        ],
    }
}

export async function deriveInferredFacts(input: InferenceInput): Promise<InferenceResult> {
    const facts: InferredFact[] = []
    const skipped: SkippedInference[] = []
    const configurationRoot = input.configurationRoot ?? input.root
    // A repository at "." is the cockpit root itself (an in-repo cockpit), so the root is read once, as that repository.
    const ownRoot = configurationRoot === input.root ? input.repositories.find(repository => repository.path === '.') : undefined
    const configurationDirectory = pathRelative(input.root, configurationRoot)
    const directories = [{ slug: ownRoot?.slug, path: configurationDirectory },
        ...input.repositories.filter(repository => repository !== ownRoot)
            .map(repository => ({ slug: repository.slug as string | undefined, path: repository.path }))]
    const relative = (directory: string, name = '') => {
        const source = pathRelative(configurationRoot, resolve(input.root, directory, name))
        return (source === '' ? '.' : source).split(sep).join('/')
    }
    const authorityRelative = (directory: string, name: string) =>
        pathRelative(input.root, resolve(input.root, directory, name)) || '.'
    const read = async (directory: string, name: string): Promise<string | undefined> => {
        const source = relative(directory, name)
        const result = await readBounded(input.root, directory, name)
        if (result.kind === 'skipped') skipped.push({ source, reason: result.reason })
        return result.kind === 'text' ? result.text : undefined
    }
    const parseYamlText = (source: string, text: string): unknown => {
        try { return parseYaml(text) }
        catch (error) {
            skipped.push({ source, reason: `is not valid YAML (${error instanceof Error ? error.name : 'parse error'})` })
            return undefined
        }
    }
    const composeFiles: { source: string; document: unknown }[] = []
    const seenServices = new Set<string>()
    const readOrigin = async (directory: string): Promise<Readonly<{ kind: 'url'; url: string; source: string } | { kind: 'none'; reason: string }>> => {
        const marker = relative(directory, '.git')
        const state = await fileExists(input.root, directory, '.git')
        if (state === 'absent') return { kind: 'none', reason: `${relative(directory)} has no .git directory to read an origin remote from` }
        if (state === 'present') {
            const reason = `${marker} is a file (a worktree or submodule pointer), so no origin remote was read from it`
            skipped.push({ source: marker, reason })
            return { kind: 'none', reason }
        }
        const gitDirectory = authorityRelative(directory, '.git')
        const source = relative(gitDirectory, 'config')
        const text = await read(gitDirectory, 'config')
        if (text === undefined) return { kind: 'none', reason: `${source} could not be read for an origin remote` }
        const url = originUrl(text)
        if (url === undefined) return { kind: 'none', reason: `${source} names no origin remote` }
        if (carriesCredentials(url)) {
            const reason = `the origin URL in ${source} carries credentials, so it is neither proposed nor shown; record the remote without them`
            skipped.push({ source, reason })
            return { kind: 'none', reason }
        }
        // Preflight compares a sibling's upstream with its declared remote by repository identity,
        // which only https and ssh remotes have; a local path also names this machine's disk, which a
        // teammate's clone of the cockpit cannot reach. Proposing one made every preflight refuse.
        if (repositoryIdentity(url).kind !== 'known') return { kind: 'none',
            reason: `the origin remote in ${source} (${url}) is not an https or ssh repository URL, so a teammate's setup cannot clone it and preflight cannot compare the checkout with it; record its hosted remote once it has one` }
        return { kind: 'url', url, source }
    }

    for (const directory of directories) {
        const slug = directory.slug
        if (slug !== undefined) {
            // Each file is read once per repository, so an unreadable one is reported once.
            const reads = new Map<string, Promise<string | undefined>>()
            const readHere = (name: string) => reads.get(name) ?? reads.set(name, read(directory.path, name)).get(name)!
            const parsedJson = new Map<string, Promise<Record<string, unknown> | undefined>>()
            const readJsonHere = (name: string) => parsedJson.get(name) ?? parsedJson.set(name, readHere(name).then(text => jsonObject(text,
                cause => skipped.push({ source: relative(directory.path, name), reason: `is not valid JSON (${cause}), so nothing is inferred from it` })))).get(name)!
            const presence = new Map<string, Promise<boolean>>()
            const present = (name: string) => presence.get(name) ?? presence.set(name, fileExists(input.root, directory.path, name).then(state => {
                if (state === 'skipped') skipped.push({ source: relative(directory.path, name), reason: 'is not a readable regular file' })
                return state === 'present'
            })).get(name)!
            // An unreadable repository directory is already reported by the reads below.
            const readable = (await inspectDirectory(input.root, directory.path)).kind === 'complete'
            const node = readable ? await nodeLockfile(present) : undefined
            const entry = readable ? await detectTestEntry(readHere, readJsonHere, present, node) : undefined
            const invalidId = entry === undefined ? undefined : TESTING_ROLES.map(role => testingId(role, slug)).find(id => !TestingName.safeParse(id).success)
            if (entry && invalidId) skipped.push({ source: relative(directory.path, entry.file),
                reason: `${entry.file} has a test entry point, but the [testing] id ${invalidId} formed from the slug ${slug} is not lowercase letters, digits and hyphens of at most 64 characters starting with a letter, so no gate is proposed for ${slug}; declare its stages and gates under [testing] with ids of that form` })
            else if (entry) facts.push({ fields: ['testing'], target: `testing.${slug}`, value: testingProposal(slug, entry, relative(directory.path)),
                provenance: { kind: 'inferred', source: relative(directory.path, entry.file),
                    reason: `${entry.reason}; requires_stack is false because nothing on disk says these tests need the running stack` } })
            else if (readable) skipped.push({ source: relative(directory.path),
                reason: `no test entry point was found, so no [testing] gate is proposed for ${slug}; looked for ${TEST_ENTRY_LOOKED_FOR}` })
            // setup resolves a non-none toolchain to exactly one install policy and refuses without
            // one, so the toolchain is proposed together with the policy row the interview must hold.
            if (node) facts.push({ fields: ['sibling', 'environment.install_policies'], target: `${slug}.toolchain`, value: 'node',
                provenance: { kind: 'inferred', source: relative(directory.path, node.lockfile),
                    reason: `${node.lockfile} is ${node.manager}'s lockfile, so the node toolchain is proposed; setup then needs exactly one environment.install_policies row with toolchain "node" and lockfile "${node.lockfile}" and refuses INSTALL_POLICY_MISSING without it, or keep toolchain "none", as a cockpit with no runtime environment must, since it is never asked for install policies` } })
            const dockerfile = await readHere('Dockerfile')
            const parsed = dockerfile === undefined ? undefined : readDockerfileFacts(dockerfile)
            if (parsed) {
                const source = relative(directory.path, 'Dockerfile')
                if (parsed.command) facts.push({ fields: ['estate.runnable', 'environment.compose_files'], target: `${slug}.command`,
                    value: parsed.command, provenance: { kind: 'inferred', source,
                        reason: 'the final stage of the Dockerfile sets this ENTRYPOINT/CMD' } })
                if (parsed.ports.length > 0) facts.push({ fields: ['environment.compose_files', 'ports.bases'], target: `${slug}.container_ports`,
                    value: parsed.ports, provenance: { kind: 'inferred', source,
                        reason: 'the final stage of the Dockerfile EXPOSEs these container ports' } })
            }
            // The image's own command wins: a package script is what runs when no Dockerfile says.
            const scripts = parsed?.command ? undefined : field(await readJsonHere('package.json'), 'scripts')
            const runScripts = PACKAGE_RUN_SCRIPTS.filter(name => { const value = field(scripts, name); return typeof value === 'string' && value.trim() !== '' })
            if (runScripts.length > 0) {
                const [script, ...others] = runScripts
                facts.push({ fields: ['estate.runnable', 'environment.compose_files'], target: `${slug}.command`,
                    value: [node?.manager ?? 'npm', 'run', script!], provenance: { kind: 'inferred', source: relative(directory.path, 'package.json'),
                        reason: `package.json has a ${script} script and no Dockerfile in this repository sets ENTRYPOINT/CMD; ${managerReason(node)}${others.length
                            ? `; ${others.join(' and ')} ${others.length === 1 ? 'is' : 'are'} also declared, so replace the command if the stack should run that instead` : ''}` } })
            }
        }
        let templates: string[] = []
        const templateDirectory = await inspectDirectory(input.root, directory.path)
        if (templateDirectory.kind === 'complete') {
            try {
                templates = (await readdir(templateDirectory.path)).filter(name => ENV_TEMPLATE.test(name)).sort()
                if (!sameDirectory(templateDirectory, await inspectDirectory(input.root, directory.path))) {
                    templates = []
                    skipped.push({ source: relative(directory.path), reason: 'directory changed while it was listed' })
                }
            } catch (error) {
                skipped.push({ source: relative(directory.path),
                    reason: `could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` })
            }
        } else if (templateDirectory.kind === 'skipped') {
            skipped.push({ source: relative(directory.path), reason: templateDirectory.reason })
        }
        if (templates.length > MAX_ENV_TEMPLATES) {
            skipped.push({ source: relative(directory.path),
                reason: `holds more than ${MAX_ENV_TEMPLATES} env template files; only the first ${MAX_ENV_TEMPLATES} were read` })
            templates = templates.slice(0, MAX_ENV_TEMPLATES)
        }
        for (const template of templates) {
            const text = await read(directory.path, template)
            if (text === undefined) continue
            const source = relative(directory.path, template)
            const names = envNames(text)
            if (slug !== undefined && template === '.env.example' && names.length > 0) facts.push({ fields: ['environment.compose_files'],
                target: `${slug}.env_names`, value: names,
                provenance: { kind: 'inferred', source, reason: 'these variable names appear in .env.example; their values are never read' } })
            for (const name of names) {
                const target = DATABASE_VARIABLE.test(name) ? 'guards.hosted_db_hosts'
                    : VENDOR_VARIABLE.test(name) ? 'guards.vendor_endpoint_hosts' : undefined
                if (target === undefined) continue
                facts.push({ fields: ['guards'], target, value: { variable: name,
                    ask: `which host does ${name} point at in each non-local environment (production, staging, shared)?` },
                    provenance: { kind: 'inferred', source,
                        reason: `the variable name ${name} suggests ${target === 'guards.hosted_db_hosts' ? 'a database' : 'a vendor API endpoint'}; its value was never read, so the host comes from the human` } })
            }
        }
        for (const name of COMPOSE_NAMES) {
            const source = relative(directory.path, name)
            const text = await read(directory.path, name)
            if (text === undefined) continue
            const document = parseYamlText(source, text)
            if (document !== undefined) {
                if (source === '..' || source.startsWith('../') || isAbsolute(source)) {
                    skipped.push({ source,
                        reason: `is outside the cockpit root, so environment.compose_files cannot represent it; write a compose.yml at the cockpit root that reaches each checkout through its sibling variable${slug === undefined ? '' : ` (such as \${${deriveSiblingVariable(slug)}})`} and answer environment.compose_files = ["compose.yml"]; then rerun ${initCommand({ root: configurationRoot })} with the options you ran it with` })
                } else composeFiles.push({ source, document })
            }
            break
        }
        const workflowDirectory = authorityRelative(directory.path, '.github/workflows')
        const workflowSource = relative(directory.path, '.github/workflows')
        let entries: string[] = []
        const workflow = await inspectDirectory(input.root, workflowDirectory)
        if (workflow.kind === 'complete') {
            try {
                entries = (await readdir(workflow.path)).filter(name => /\.ya?ml$/.test(name)).sort()
                if (!sameDirectory(workflow, await inspectDirectory(input.root, workflowDirectory))) {
                    entries = []
                    skipped.push({ source: workflowSource, reason: 'directory changed while it was listed' })
                }
            } catch (error) {
                skipped.push({ source: workflowSource, reason: `could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` })
            }
        } else if (workflow.kind === 'skipped') {
            skipped.push({ source: workflowSource, reason: workflow.reason })
        }
        if (entries.length > MAX_WORKFLOWS) {
            skipped.push({ source: workflowSource, reason: `holds more than ${MAX_WORKFLOWS} workflows; only the first ${MAX_WORKFLOWS} were read` })
            entries = entries.slice(0, MAX_WORKFLOWS)
        }
        for (const entry of entries) {
            const source = relative(workflowDirectory, entry)
            const text = await read(workflowDirectory, entry)
            if (text === undefined) continue
            for (const service of workflowServices(parseYamlText(source, text))) {
                const key = `${service.name}\0${service.image}`
                if (seenServices.has(key)) continue
                seenServices.add(key)
                facts.push({ fields: ['environment.compose_files'], target: `services.${service.name}`, value: { image: service.image },
                    provenance: { kind: 'inferred', source,
                        reason: `workflow job "${service.job}" runs the backing service "${service.name}" from this image` } })
            }
        }
    }
    // With no repository under the root, the cockpit root is the first one: an empty directory
    // the product will grow in, or a repository of documents. The schema needs one sibling, and
    // declaring the root itself (dir ".") says what is true instead of inventing a child directory
    // or allowing a cockpit with no repositories that every sibling consumer would have to special-case.
    const rootName = basename(configurationRoot)
    const proposesRoot = (input.repositories.length === 0 || ownRoot?.slug === rootName) && SIBLING_SLUG.test(rootName)
    const others = input.repositories.filter(repository => repository !== ownRoot && SIBLING_SLUG.test(repository.slug))
    const siblingPaths = new Map([...proposesRoot ? [[deriveSiblingVariable(rootName), configurationRoot] as const] : [],
        ...others.map(repository => [deriveSiblingVariable(repository.slug), resolve(input.root, repository.path)] as const)])
    const compose = composeFacts(composeFiles, configurationRoot, Object.fromEntries(siblingPaths), skipped)
    if (proposesRoot) {
        // The agent already works in the root, so mounting it buys nothing by itself; but check and
        // up refuse a bind inside a mount = "none" sibling, so a Compose file that binds the root, or
        // a directory of it, makes it a mount = "always" sibling.
        const bind = compose.binds.find(row => bindHolder(row.path, [...siblingPaths.values()]) === configurationRoot)
        const placed = ownRoot ? 'the cockpit lives inside this product repository, so the repository is its own first sibling'
            : 'no directory under the root has a package manifest, so the cockpit root itself is the first repository'
        facts.push({ fields: ['sibling'], target: `sibling.${rootName}`,
            value: { slug: rootName, dir: '.', mount: bind ? 'always' : 'none', acquire: 'none', var: deriveSiblingVariable(rootName) },
            provenance: { kind: 'inferred', source: bind?.source ?? '.', reason: bind
                ? `${placed}; ${bind.source} bind-mounts ${bind.path === configurationRoot ? 'it' : `${pathRelative(configurationRoot, bind.path).split(sep).join('/')} inside it`}, so it is mounted; add its purpose`
                : `${placed}; add its purpose` } })
    }
    // Each observed repository is a checkout the agent works in from the cockpit, so it is mounted.
    // Its origin remote is recorded so a teammate's setup can clone it; without one, acquire "none"
    // leaves a teammate with nothing, and setup cannot say what is missing. The purpose is the human's.
    for (const repository of others) {
        const origin = await readOrigin(repository.path)
        const placed = 'this repository was observed in the estate, so it is proposed as a sibling with its directory name'
        facts.push({ fields: ['sibling'], target: `sibling.${repository.slug}`,
            value: { slug: repository.slug, dir: repository.path, ...(origin.kind === 'url' ? { remote: origin.url } : {}), mount: 'always',
                acquire: origin.kind === 'url' ? 'auto' : 'none', var: deriveSiblingVariable(repository.slug) },
            provenance: { kind: 'inferred', source: origin.kind === 'url' ? origin.source : relative(repository.path),
                reason: origin.kind === 'url'
                    ? `${placed}; acquire "auto" with its origin remote, so setup clones it where a checkout is absent; add its purpose`
                    : `${placed}; acquire "none" because ${origin.reason}; add its purpose` } })
    }
    if (compose.bases.size > 0) {
        const sources = [...new Set([...compose.bases.values()].flatMap(row => row.sources))]
        const publishers = sources.map(source => `${source} publishes ${[...compose.bases].filter(([, row]) => row.sources.includes(source)).map(([name]) => name).join(', ')}`)
        facts.push({ fields: ['ports.bases'], target: 'ports.bases', value: Object.fromEntries([...compose.bases].map(([name, row]) => [name, row.base])),
            provenance: { kind: 'inferred', source: sources.join(', '),
                reason: `${publishers.join('; ')} from variables with these defaults; check requires every published host port to come from a [ports.bases] variable, so each stack leases its own` } })
    }
    // compose-first resolves every relative path against the first listed file's directory, so one
    // product Compose file can be run in place but several cannot be listed together.
    if (composeFiles.length === 1) facts.unshift({ fields: ['environment.compose_files'], target: 'environment.compose_files', value: [composeFiles[0]!.source],
        provenance: { kind: 'inferred', source: composeFiles[0]!.source,
            reason: 'a Compose file already exists, so cockpit can run it as written' } })
    else if (composeFiles.length > 1) skipped.push({ source: composeFiles.map(file => file.source).join(', '),
        reason: `are Compose files in different repositories, and compose-first resolves every relative path against the first listed file's directory, so they cannot be listed together; write one compose.yml at the cockpit root that runs their services, reaching each checkout through its sibling variable (${[...siblingPaths.keys()].map(name => `\${${name}}`).join(', ')}), and answer environment.compose_files = ["compose.yml"]` })
    return { facts, skipped }
}
