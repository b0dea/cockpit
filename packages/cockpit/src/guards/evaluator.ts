import { posix } from 'node:path'
import { DOTENV_DOCUMENTATION, errorCause, snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_INPUT_LIMITS, isParsedGuardInput, shownGuardWord, XARGS_INPUT, type ParsedInvocation } from './invocation-parser.js'
import { GUARD_HOST_LIMITS, isGuardHost, normalizeGuardHost } from './host.js'
import { GuardCommandArgv, McpAllowedTools } from '../schema.js'
import { renderGuardProjectCommand } from '../environment/install-policy.js'
import { GUARD_LOCAL_PATHS } from './local-identity.js'
import { classifyReadOnlyInvocation, cockpitLauncherPrefix, type ReadOnlyAccess } from './read-only.js'
import { SURFACE_EXECUTION_CONTROL_PATHS } from '../surfaces/harness-registry.js'

/**
 * The cockpit commands that run the words after their `--` as a command of their own, and where it
 * runs: a session's on the host, exec's inside a product container that mounts the checkouts and
 * may hold their credentials. The guard judges that command as an invocation of its own, so
 * wrapping a command never admits more than running it directly.
 */
export const WRAPPING_COMMANDS: ReadonlyMap<string, 'host' | 'container'> = new Map([['session', 'host'], ['exec', 'container']])

/**
 * The command a wrapping cockpit command runs, from its arguments after the launcher: the words
 * after its first `--`, and where they run. Undefined when the command wraps none or names no
 * command after `--`.
 */
export function innerCommand(argv: readonly string[]): Readonly<{ words: readonly string[]; runs: 'host' | 'container' }> | undefined {
    const runs = argv.length ? WRAPPING_COMMANDS.get(argv[0]!) : undefined
    if (!runs) return undefined
    const separator = argv.indexOf('--')
    return separator < 0 || separator === argv.length - 1 ? undefined : { words: argv.slice(separator + 1), runs }
}

export interface GuardInvocationProfile {
    readonly executable: string
    readonly cwd: string
    readonly argv: readonly string[]
    /** Files the admitted command reads and may echo back, checked like a read-only command's reads. */
    readonly reads?: readonly string[]
    /** Admitted only as the whole call: its reads are proved now, and a chain could change them first. */
    readonly alone?: true
}
export interface GuardProjectCommand {
    readonly executable: string
    readonly checkoutRoot: string
    readonly kind: 'build' | 'test'
    readonly argv: readonly string[]
}
/** Filesystem identity of a protected path: its own when it exists, and every existing directory above it. */
export interface GuardProtectedIdentity {
    readonly path: string
    readonly identity: string | null
    readonly ancestors: readonly string[]
}
interface GuardDeclaredAllow {
    readonly argv: readonly string[]
    readonly reason: string
    readonly cwd?: string
}
interface GuardDeclaredDeny {
    readonly match: 'prefix' | 'contains'
    readonly argv: readonly string[]
    readonly reason: string
    readonly fix?: string
}
export interface GuardEvaluationPolicy {
    readonly canonicalRoot: string
    /** The configuration every guarded call reads; deleting it strands the agent. */
    readonly configPath: string
    readonly allowedRoots: readonly string[]
    readonly instances: readonly { readonly name: string; readonly path: string }[]
    /** Declared environment templates: `.env*` files that are documentation, not data. */
    readonly templates: readonly string[]
    readonly protectedIdentities: readonly GuardProtectedIdentity[]
    readonly protectedBranches: readonly string[]
    readonly hostedDatabaseHosts: readonly string[]
    readonly vendorHosts: readonly string[]
    readonly declaredAllows: readonly GuardDeclaredAllow[]
    readonly declaredDenies: readonly GuardDeclaredDeny[]
    readonly ripgrepConfigActive: boolean
    /**
     * Directories whose code runs as the guard: the installed cockpit package and every package it
     * loads. Every allowed root's `node_modules/.bin` is protected beside them without being listed.
     */
    readonly executionDirectories: readonly string[]
    /** Absolute command search path directories inside the allowed roots, where a planted file shadows a permitted command. */
    readonly searchDirectories: readonly string[]
    /** The first command search path entry that is not absolute, where an empty one is the working directory; null when every entry is absolute. */
    readonly searchPathRelativeEntry: string | null
    /** Identities of every file in the root secrets directory, or null when it held more than the enumeration bound. */
    readonly secretFileIdentities: readonly string[] | null
    /** Some instance or secrets file has another hard link, which a recursive search can read under an unprotected name. */
    readonly protectedFilesLinked: boolean
    readonly cockpitInvocations: readonly GuardInvocationProfile[]
    /**
     * Launcher spellings the application proved start the guard's own installed cockpit when run in
     * `cwd`: the executable and the launcher words after it, such as `npx` with `--no cockpit`. A
     * matching invocation is evaluated as cockpit with the remaining words; no other one is.
     */
    readonly cockpitLaunchers: readonly GuardInvocationProfile[]
    readonly projectCommands: readonly GuardProjectCommand[]
    readonly mcpAllowedTools?: Readonly<Record<string, readonly string[]>>
    /** `native` leaves a named read outside the roots to the agent tool's own permission. */
    readonly externalReads?: 'grant' | 'native'
    /** Canonical files and directories outside the roots whose named files may be read. */
    readonly readPaths?: readonly string[]
    /**
     * `allow` admits every command outside the blocked list; `ask`, the strict mode, admits only the
     * read-only commands it classifies, declared commands and grants. Absent means `ask`.
     */
    readonly defaultDecision?: 'allow' | 'ask'
    /** The home directory of whoever runs the agent, where the credential stores below it live. */
    readonly homeDirectory?: string
    /** The installed cockpit package's own directory under every spelling, wherever it is installed. */
    readonly cockpitPackageDirectories?: readonly string[]
    /** Canonical files and directories inside the roots that `[guards] secret_paths` keeps from agents. */
    readonly secretPaths?: readonly string[]
    /** Canonical checkouts outside the roots that agents may read and inspect with read-only Git, never change. */
    readonly relatedCheckouts?: readonly string[]
    /** `deny` refuses what would otherwise ask, naming the route; absent means `ask`. */
    readonly unresolved?: 'ask' | 'deny'
    /** Canonical files and directories outside the roots below which agents may write. */
    readonly writePaths?: readonly string[]
    /**
     * Every `[guards] related_checkouts` spelling, granted or not, with each ancestor of it that does not
     * exist: writing there could plant a link that a later call would grant as a related checkout.
     */
    readonly relatedReserved?: readonly string[]
    /** Command search path directories outside the roots, where a planted file shadows a command everywhere. */
    readonly externalSearchDirectories?: readonly string[]
    /** The Node executable and install prefix the guard runs with, wherever they are. */
    readonly guardRuntime?: readonly string[]
}
interface PathInspectionRequest {
    readonly path: string
    readonly cwd: string
    /**
     * A `search` is a recursive read; its evidence also carries `sensitive`, every existing path at or
     * below it named `.env*` or `.secrets`, or null past the walk's bound. An `unignored-search` reads
     * only what Git does not ignore, as ripgrep does by default; its `sensitive` holds only what such
     * a search reads, and also every declared instance it reads. A `repository` is the Git repository
     * at the path; its evidence carries `tracked`, every `.env*`, secrets or instance path its index
     * holds, or null when Git could not say. A `branch` is the repository's current branch and push
     * settings; a `remote` says whether a remote URL Git prints for the repository carries a credential;
     * a `patch` is a patch file, and its evidence carries `targets`, every path its headers name. A
     * `tree` asks the repository at `cwd` which protected paths its work tree holds would differ between
     * `from` (HEAD when absent, or the work tree itself) and `revision`; its evidence carries `guarded`,
     * whether the work tree holds any protected path, and `changed`, the protected paths that differ. A
     * `manifest` is the nearest package.json at or above the path: its `name` and its `scripts` names.
     * An `external-write` is a path outside the roots a write may land on; its evidence carries
     * `landsAt`, the path with every existing link on the way resolved.
     */
    /** `list` reads names only; it is asked for a listing outside the roots, where a directory may be listed but not read. */
    readonly operation: 'cwd' | 'write' | 'stage' | 'read' | 'list' | 'remove' | 'search' | 'unignored-search' | 'repository' | 'branch' | 'remote' | 'patch' | 'tree' | 'manifest' | 'external-write'
    readonly revision?: string
    readonly from?: string
    /** For a `manifest`, also the scripts any package of the enclosing workspace declares, as `workspace`. */
    readonly workspace?: true
    /** For a `search`, the reading tool follows links, so a link below the path leaves its `sensitive` unknown (null). */
    readonly followsLinks?: true
}
/** The application supplies current, symlink-aware facts; the evaluator performs no I/O. */
export type PathInspection = (request: PathInspectionRequest) => unknown
export interface GuardDecision {
    readonly decision: 'allow' | 'ask' | 'deny' | 'unavailable'
    readonly reason: string
}

// An agent able to rewrite any of these can switch the guard off, grant itself commands or run code
// when a harness starts: the published guard transport, every harness registration that launches it,
// the manifest that authenticates both, Claude's local settings, where `disableAllHooks` would switch
// the hook off, and every registry-owned native MCP or permission output. These spellings match the
// restriction expansion, the guard application and the generated surface outputs. An adopted copy
// of a registration or configuration file is merged into it on the next sync, so it is a control too.
const GUARD_CONTROL_FILES = [
    '.cockpit/guards/bash-guard.sh', '.cockpit/generated-environment-ownership.json',
    ...SURFACE_EXECUTION_CONTROL_PATHS,
    '.claude/settings.local.json', '.codex/hooks.json', 'opencode.json',
    'cockpit/adopted/.claude/settings.json', 'cockpit/adopted/.codex/hooks.json', 'cockpit/adopted/.codex/config.toml',
    // The policy the last sync accepted: an agent that rewrote it could present its own weakening as accepted.
    '.cockpit/policy.json',
] as const
// OpenCode loads every module in its plugin directories at start, and the generated Claude plugin
// bundle carries its own MCP servers and hook registration, so no file below them is data. Every
// harness starts the generated MCP wrapper scripts as the server program, so overwriting one changes
// what runs before the next guarded call. The machine-local guard identity names the handler the
// guard launches, so it is a control as well. The work-order records hold who accepted, answered and
// signed off each order, unkeyed, so a record an agent wrote there would read as a person's or CI's
// to the next `cockpit work` command: only cockpit writes it.
const GUARD_CONTROL_DIRECTORIES = ['.opencode/plugin', '.opencode/plugins', '.cockpit/bundles/claudecode-plugin', '.cockpit/mcp', GUARD_LOCAL_PATHS.directory,
    '.cockpit/work-orders'] as const
const SECRETS_ROOT = 'env/.secrets'
/**
 * Bounds on the locations the policy and the path inspector carry, one per quantity, each set above
 * what an honest checkout holds so that only an unwalkable tree or a broken install reaches it.
 */
export const GUARD_LOCATION_LIMITS = Object.freeze({
    // The running cockpit and its dependency closure, a few dozen packages, under both spellings.
    packageDirectories: 256,
    // Command search path entries inside the allowed roots, under both spellings; a PATH holds tens.
    searchPathDirectories: 256,
    // Declared environment templates, one per environment file; the policy bounds instances alike.
    templates: 256,
    // Environment files and secrets directories one searched tree or repository index holds. Each is
    // compared against every protected target, and a monorepo keeps one or more per package.
    sensitivePaths: 1024,
    // `[guards] secret_paths` holds 64 entries, each in the cockpit or in every checkout of one sibling.
    secretPaths: 1024,
})
export const GUARD_SECRET_FILE_LIMIT = 512
/** Root-relative paths whose identity every policy carries beside each instance's. */
export const GUARD_ROOT_PROTECTIONS: readonly { readonly path: string; readonly type: 'file' | 'directory' }[] = Object.freeze([
    ...GUARD_CONTROL_FILES.map((path) => ({ path, type: 'file' as const })),
    ...[...GUARD_CONTROL_DIRECTORIES, SECRETS_ROOT].map((path) => ({ path, type: 'directory' as const })),
])
/** One spelling of a file's identity, shared by the policy build and the path inspector. */
export function guardIdentity(status: { readonly dev: number; readonly ino: number }): string {
    return `${status.dev}:${status.ino}`
}
const IDENTITY = /^\d+:\d+$/
// The one normalisation applied to both sides of every spelling comparison: NFC plus full case
// folding. A case-insensitive volume resolves `.ENV` or `.ſecrets` to the protected entry, and
// neither byte equality nor toLowerCase() equates those spellings.
export function foldGuardSpelling(path: string): string {
    return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}
const fold = foldGuardSpelling
/** A name the guard treats as an environment file or secrets directory, under any spelling. */
export function isSensitiveGuardName(name: string): boolean {
    const folded = fold(name)
    return folded.startsWith('.env') || folded === '.secrets'
}
/** Every location the guard protects by path: its controls, the secrets root, the configuration and each declared instance. */
export function guardProtectedLocations(input: Readonly<{ canonicalRoot: string; configPath: string; instances: readonly string[] }>): readonly Readonly<{ path: string; type: 'file' | 'directory' }>[] {
    return [...GUARD_ROOT_PROTECTIONS.map(({ path, type }) => ({ path: posix.join(input.canonicalRoot, path), type })),
        { path: input.configPath, type: 'file' as const }, ...input.instances.map((path) => ({ path, type: 'file' as const }))]
}
const unavailable = (reason: string): GuardDecision => ({ decision: 'unavailable', reason })
const ask = (reason: string): GuardDecision => ({ decision: 'ask', reason })
const UNPROVEN_LAUNCHER = 'This cockpit command requires human approval: the guard could not prove it starts the installed cockpit. '
    + 'npx --no cockpit counts only from the cockpit root with no root .npmrc and no bin in the root package.json, and bare cockpit only when '
    + 'the command search path finds the installed package. From the cockpit root, use the installed package entrypoint, for example '
    + '`./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml`; it counts only when it resolves to the installed package. '
    + 'pnpm writes node_modules/.bin/cockpit as a shell shim, which the guard cannot prove.'
const deny = (reason: string): GuardDecision => ({ decision: 'deny', reason })
// A refusal names the command it judged, so an agent can tell which part of a chain was refused.
const named = (invocation: ParsedInvocation) => {
    const words = invocation.executable === null ? [] : [invocation.executable, ...invocation.argv]
    const shown: string[] = []
    for (const word of words) {
        if (!/^[\w./@+=:,%^~{}-]+$/.test(word) || [...shown, word].join(' ').length > 80) break
        shown.push(word)
    }
    return shown.length ? `\`${shown.join(' ')}${shown.length < words.length ? ' …' : ''}\`` : 'This command'
}
// A word whose value the guard cannot see, as a refusal names it.
const unseen = (value: string) => value === XARGS_INPUT ? 'the arguments xargs reads from standard input' : shownGuardWord(value)
const allowed: GuardDecision = Object.freeze({ decision: 'allow', reason: 'Every invocation matches an exact permitted profile or bounded data operation.' })
function record(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: JsonSnapshotObject, names: string[]): boolean {
    return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
}
function scalar(value: JsonSnapshot | undefined): value is string {
    return typeof value === 'string' && value.length > 0 && !/[\uD800-\uDFFF]/u.test(value) && !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= GUARD_INPUT_LIMITS.wordBytes
}
function canonical(value: JsonSnapshot | undefined): value is string {
    return scalar(value) && value.startsWith('/') && value !== '/' && posix.normalize(value) === value && !value.endsWith('/')
}
function within(path: string, root: string): boolean { return path === root || path.startsWith(root === '/' ? '/' : root + '/') }
function identity(value: JsonSnapshot | undefined): value is string { return typeof value === 'string' && value.length <= 64 && IDENTITY.test(value) }
function strings(value: JsonSnapshot | undefined): value is readonly string[] {
    return Array.isArray(value) && value.every(scalar)
}
function argv(value: JsonSnapshot | undefined): value is readonly string[] {
    return Array.isArray(value) && value.length <= GUARD_INPUT_LIMITS.words && value.every((word) =>
        typeof word === 'string' && !/[\uD800-\uDFFF]/u.test(word) && !/[\x00-\x1f\x7f]/.test(word)
        && Buffer.byteLength(word) <= GUARD_INPUT_LIMITS.wordBytes && word !== '*' && word !== '**')
}
function ruleArgv(value: JsonSnapshot | undefined): value is readonly string[] {
    return Array.isArray(value) && GuardCommandArgv.safeParse(value).success
}
function projectTuple(value: JsonSnapshotObject): boolean {
    if (!Array.isArray(value.argv)) return false
    const tuple = GuardCommandArgv.safeParse([value.executable, ...value.argv])
    return tuple.success && renderGuardProjectCommand(tuple.data).kind === 'complete'
}
function capturePolicy(value: unknown): GuardEvaluationPolicy | undefined {
    const p = snapshotJson(value)
    if (!record(p) || !keys(p, ['canonicalRoot', 'configPath', 'allowedRoots', 'instances', 'templates', 'protectedIdentities', 'protectedBranches', 'hostedDatabaseHosts', 'vendorHosts', 'declaredAllows', 'declaredDenies', 'ripgrepConfigActive', 'executionDirectories', 'searchDirectories', 'searchPathRelativeEntry', 'secretFileIdentities', 'protectedFilesLinked', 'cockpitInvocations', 'cockpitLaunchers', 'projectCommands', ...p.mcpAllowedTools === undefined ? [] : ['mcpAllowedTools'], ...p.externalReads === undefined ? [] : ['externalReads'], ...p.readPaths === undefined ? [] : ['readPaths'], ...p.defaultDecision === undefined ? [] : ['defaultDecision'], ...p.homeDirectory === undefined ? [] : ['homeDirectory'], ...p.cockpitPackageDirectories === undefined ? [] : ['cockpitPackageDirectories'],
        ...['secretPaths', 'relatedCheckouts', 'unresolved', 'writePaths', 'relatedReserved', 'externalSearchDirectories', 'guardRuntime'].filter(key => p[key] !== undefined)])
        || p.readPaths !== undefined && (!strings(p.readPaths) || p.readPaths.length > 64 || !p.readPaths.every(canonical))
        || p.externalReads !== undefined && p.externalReads !== 'grant' && p.externalReads !== 'native'
        || p.unresolved !== undefined && p.unresolved !== 'ask' && p.unresolved !== 'deny'
        || [p.writePaths, p.relatedReserved, p.guardRuntime].some(list => list !== undefined && (!strings(list) || list.length > 64 * 16 || !list.every(canonical)))
        // A write path that is the home directory or above it would admit every shell startup file below.
        || Array.isArray(p.writePaths) && typeof p.homeDirectory === 'string' && (p.writePaths as string[]).some(path => within(p.homeDirectory as string, path))
        || p.secretPaths !== undefined && (!strings(p.secretPaths) || p.secretPaths.length > GUARD_LOCATION_LIMITS.secretPaths || !p.secretPaths.every(canonical))
        || p.relatedCheckouts !== undefined && (!strings(p.relatedCheckouts) || p.relatedCheckouts.length > 16 || !p.relatedCheckouts.every(canonical))
        || p.externalSearchDirectories !== undefined && (!strings(p.externalSearchDirectories) || p.externalSearchDirectories.length > GUARD_LOCATION_LIMITS.searchPathDirectories
            || !p.externalSearchDirectories.every(canonical))
        || p.defaultDecision !== undefined && p.defaultDecision !== 'allow' && p.defaultDecision !== 'ask'
        || p.homeDirectory !== undefined && (!canonical(p.homeDirectory) || p.homeDirectory === '/')
        || p.cockpitPackageDirectories !== undefined && (!strings(p.cockpitPackageDirectories) || p.cockpitPackageDirectories.length > GUARD_LOCATION_LIMITS.packageDirectories
            || !p.cockpitPackageDirectories.every(canonical))
        || p.mcpAllowedTools !== undefined && !McpAllowedTools.safeParse(p.mcpAllowedTools).success
        || !canonical(p.canonicalRoot) || !canonical(p.configPath) || posix.dirname(p.configPath) !== p.canonicalRoot || !strings(p.allowedRoots) || !p.allowedRoots.includes(p.canonicalRoot) || !p.allowedRoots.every(canonical)
        || !strings(p.protectedBranches) || !strings(p.hostedDatabaseHosts) || !strings(p.vendorHosts)
        || !Array.isArray(p.instances) || !strings(p.templates) || p.templates.length > GUARD_LOCATION_LIMITS.templates || !Array.isArray(p.protectedIdentities) || !Array.isArray(p.declaredAllows) || !Array.isArray(p.declaredDenies)
        || typeof p.ripgrepConfigActive !== 'boolean' || typeof p.protectedFilesLinked !== 'boolean' || !Array.isArray(p.cockpitInvocations) || !Array.isArray(p.cockpitLaunchers) || !Array.isArray(p.projectCommands)
        || !strings(p.executionDirectories) || p.executionDirectories.length > GUARD_LOCATION_LIMITS.packageDirectories
        || !strings(p.searchDirectories) || p.searchDirectories.length > GUARD_LOCATION_LIMITS.searchPathDirectories
        || p.searchPathRelativeEntry !== null && (typeof p.searchPathRelativeEntry !== 'string' || p.searchPathRelativeEntry.startsWith('/')
            || /[\x00-\x1f\x7f]/.test(p.searchPathRelativeEntry) || Buffer.byteLength(p.searchPathRelativeEntry) > GUARD_INPUT_LIMITS.wordBytes)
        || p.secretFileIdentities !== null && (!Array.isArray(p.secretFileIdentities) || p.secretFileIdentities.length > GUARD_SECRET_FILE_LIMIT || !p.secretFileIdentities.every(identity))) return undefined
    const roots = p.allowedRoots
    const confined = (value: JsonSnapshot | undefined): value is string => canonical(value) && roots.some((root) => within(value, root))
    if (![...p.executionDirectories, ...p.searchDirectories].every(confined)
        || [p.hostedDatabaseHosts, p.vendorHosts].some((hosts) => hosts.length > GUARD_HOST_LIMITS.rows
        || !hosts.every(isGuardHost) || new Set(hosts.map(normalizeGuardHost)).size !== hosts.length)
        || p.protectedBranches.some((branch) => /[\s:*?\[\\]/.test(branch))
        || p.instances.some((item) => !record(item) || !keys(item, ['name', 'path']) || !scalar(item.name) || !confined(item.path))
        || p.secretPaths !== undefined && !p.secretPaths.every(confined)
        // A related checkout is read-only, so one overlapping a root would make that root unwritable or readable past its bounds.
        || p.relatedCheckouts !== undefined && p.relatedCheckouts.some((path) => roots.some((root) => within(path, root) || within(root, path)))
        || !p.templates.every(confined)
        || p.declaredAllows.length > 64 || p.declaredAllows.some((item) => !record(item)
            || !keys(item, item.cwd === undefined ? ['argv', 'reason'] : ['argv', 'reason', 'cwd'])
            || !ruleArgv(item.argv) || !scalar(item.reason) || item.cwd !== undefined && !confined(item.cwd))
        || p.declaredDenies.length > 64 || p.declaredDenies.some((item) => !record(item)
            || !keys(item, item.fix === undefined ? ['match', 'argv', 'reason'] : ['match', 'argv', 'reason', 'fix'])
            || !['prefix', 'contains'].includes(String(item.match)) || !ruleArgv(item.argv) || !scalar(item.reason)
            || item.fix !== undefined && !scalar(item.fix))
        || p.cockpitInvocations.some((item) => !record(item) || !keys(item, ['executable', 'cwd', 'argv', ...item.reads === undefined ? [] : ['reads'], ...item.alone === undefined ? [] : ['alone']])
            || item.alone !== undefined && item.alone !== true
            || !scalar(item.executable) || item.executable.includes('*') || !confined(item.cwd) || !argv(item.argv)
            || item.reads !== undefined && (!strings(item.reads) || item.reads.length > GUARD_INPUT_LIMITS.paths))
        || p.cockpitLaunchers.length > GUARD_INPUT_LIMITS.invocations || p.cockpitLaunchers.some((item) => !record(item) || !keys(item, ['executable', 'cwd', 'argv'])
            || !scalar(item.executable) || !argv(item.argv) || cockpitLauncherPrefix(item.executable, [...item.argv, 'check']) !== item.argv.length || !confined(item.cwd))
        || p.projectCommands.some((item) => !record(item) || !keys(item, ['executable', 'checkoutRoot', 'kind', 'argv']) || !confined(item.checkoutRoot) || !['build', 'test'].includes(String(item.kind)) || !projectTuple(item))
        || p.protectedIdentities.some((item) => !record(item) || !keys(item, ['path', 'identity', 'ancestors']) || !confined(item.path)
            || item.identity !== null && !identity(item.identity) || !Array.isArray(item.ancestors) || !item.ancestors.every(identity))) return undefined
    // A policy that omits an identity would silently fall back to spellings, so coverage is exact.
    const expected = new Set([...p.instances.map((item) => (item as JsonSnapshotObject).path as string), ...p.secretPaths ?? [], p.configPath as string,
        ...GUARD_ROOT_PROTECTIONS.map((item) => `${p.canonicalRoot}/${item.path}`)])
    const carried = new Set(p.protectedIdentities.map((item) => (item as JsonSnapshotObject).path as string))
    if (carried.size !== p.protectedIdentities.length || carried.size !== expected.size || [...expected].some((path) => !carried.has(path))) return undefined
    // Every field above is captured own data and checked before entering the typed policy core.
    return p as unknown as GuardEvaluationPolicy
}

function hostUsed(value: string, configured: string): boolean {
    const host = normalizeGuardHost(configured)
    // Resolvers apply compatibility normalisation before lookup, so fullwidth letters and the
    // ideographic full stops name the same host as their ASCII spelling.
    const lower = value.normalize('NFKC').replace(/[\u3002\uff0e\uff61]/g, '.').toLowerCase()
    let offset = lower.indexOf(host)
    while (offset >= 0) {
        const before = lower[offset - 1]
        const after = lower[offset + host.length]
        const afterDot = after === '.' ? lower[offset + host.length + 1] : undefined
        if ((before === undefined || !/[a-z0-9_.-]/.test(before) || configured.startsWith('*.') && before === '.')
            && (after === undefined || !/[a-z0-9_.-]/.test(after) || after === '.' && (afterDot === undefined || !/[a-z0-9_.-]/.test(afterDot)))) return true
        offset = lower.indexOf(host, offset + 1)
    }
    return false
}

// Commands whose arguments name files they read, so a rule for one is a rule for reading those files.
const READING_EXECUTABLES = new Set(['cat', 'head', 'tail', 'wc', 'shasum', 'jq', 'sed', 'grep', 'rg', 'fd', 'find', 'ls'])
// Known tools beside those that read, print, copy or send the files their operands name.
const NAME_READERS = new Set(['xxd', 'od', 'sort', 'nl', 'awk', 'cut', 'uniq', 'tr', 'diff', 'sha256sum', 'md5', 'md5sum', 'stat', 'file', 'tree', 'du',
    'scp', 'rsync', 'zip', 'tar', 'unzip', 'gzip', 'gunzip'])

/** The operands of a Git verb, without the values of the options in `valued`. */
function gitOperands(args: readonly string[], valued: readonly string[]): readonly string[] {
    const operands: string[] = []
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (arg === '--') { operands.push(...args.slice(index + 1)); break }
        if (valued.includes(arg)) index++
        else if (!arg.startsWith('-')) operands.push(arg)
    }
    return operands
}

/**
 * Whether a package manager or tool CLI writes the person's own configuration, or installs into their
 * global environment: `refuse`, or `project` for npm's project-local `.npmrc`. npm's node-options and
 * script-shell there run under every later npm and npx command, a person's own `npx --no cockpit` included.
 */
function toolConfigurationWrite(invocation: ParsedInvocation): 'refuse' | 'project' | undefined {
    const name = posix.basename(invocation.executable ?? '')
    const argv = invocation.argv
    const [first, second] = argv.filter(arg => !arg.startsWith('-'))
    const global = argv.some(arg => ['-g', '--global', '--location=global', '--location=user'].includes(arg))
    if (['npm', 'pnpm', 'yarn'].includes(name)) {
        const writesConfig = ['config', 'c'].includes(first ?? '') && ['set', 'delete', 'rm', 'del', 'edit', 'fix'].includes(second ?? '') || name === 'npm' && ['set', 'edit'].includes(first ?? '')
        if (writesConfig) return name === 'npm' && !global && argv.some((arg, at) => arg === '--location=project' || arg === 'project' && argv[at - 1] === '--location') ? 'project' : 'refuse'
        if (global && !['list', 'ls', 'root', 'bin', 'outdated', 'view', 'info', 'prefix', 'config'].includes(first ?? '') || name !== 'pnpm' && ['link', 'ln'].includes(first ?? '')
            || name === 'yarn' && first === 'global') return 'refuse'
    }
    if (name === 'bun' && global && ['add', 'install', 'i', 'link', 'remove', 'update'].includes(first ?? '')) return 'refuse'
    if (name === 'go' && (first === 'install' || first === 'env' && argv.some(arg => /^-[wu]$/.test(arg)))) return 'refuse'
    if (name === 'cargo' && first === 'install') return 'refuse'
    if (name === 'uv' && first === 'tool' && ['install', 'upgrade'].includes(second ?? '')) return 'refuse'
    if (['pip', 'pip3'].includes(name) && first === 'install' && argv.includes('--user')) return 'refuse'
    if (name === 'pipx' && ['install', 'inject', 'upgrade', 'upgrade-all', 'reinstall', 'reinstall-all'].includes(first ?? '')) return 'refuse'
    if (name === 'gh' && (first === 'config' && second === 'set' || first === 'alias' && ['set', 'import'].includes(second ?? '')
        || ['extension', 'extensions', 'ext'].includes(first ?? '') && ['install', 'upgrade'].includes(second ?? ''))) return 'refuse'
    return undefined
}

// A URL, or a package spelled as a Git source, as the parser's launchers judge it.
const REMOTE_PACKAGE = /:\/\/|^(?:git\+|github:|gitlab:|bitbucket:|gist:)/i
/** The first package an install fetches from a URL or a Git host rather than a registry, whose install scripts then run. */
function remoteInstallSource(invocation: ParsedInvocation): string | undefined {
    const name = posix.basename(invocation.executable ?? '')
    const argv = name === 'uv' && invocation.argv[0] === 'pip' ? invocation.argv.slice(1) : invocation.argv
    const operands = argv.filter(arg => !arg.startsWith('-'))
    if (['pip', 'pip3'].includes(name) || name === 'uv' && invocation.argv[0] === 'pip') return operands[0] === 'install' ? operands.slice(1).find(arg => REMOTE_PACKAGE.test(arg)) : undefined
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(name) || !['i', 'install', 'add', 'update', 'up'].includes(operands[0] ?? '')) return undefined
    // npm and its peers read `owner/repo` as a GitHub repository.
    return operands.slice(1).find(arg => REMOTE_PACKAGE.test(arg) || /^[^@./][^/]*\/[^/]/.test(arg))
}

function ruleMatches(invocation: ParsedInvocation, rule: GuardDeclaredAllow | GuardDeclaredDeny): boolean {
    if (invocation.executable === null) return false
    const words = [invocation.executable, ...invocation.argv]
    if ('cwd' in rule && rule.cwd !== undefined && rule.cwd !== invocation.cwd) return false
    if (!('match' in rule) || rule.match === 'prefix') return rule.argv.every((word, index) => words[index] === word)
    return words.some((_, start) => rule.argv.every((word, index) => words[start + index] === word))
}


/** A complete cwd-bound command approval supplies the paths this invocation may inspect. */
export function approvedReadOnlyInvocation(invocation: ParsedInvocation, policy: Pick<GuardEvaluationPolicy, 'declaredAllows' | 'ripgrepConfigActive'>): ReadOnlyAccess | undefined {
    if (invocation.redirects.length || !policy.declaredAllows.some(rule => rule.cwd === invocation.cwd && rule.argv.length === invocation.argv.length + 1
        && rule.argv[0] === invocation.executable && invocation.argv.every((word, index) => word === rule.argv[index + 1]))) return undefined
    return classifyReadOnlyInvocation(invocation, policy)
}

/** `directories` holds each `-C` operand as spelled, with the directory it resolves from. */
export interface GitInvocation { verb: string; args: readonly string[]; cwd: string; directories: readonly { path: string; cwd: string }[]; uncertain: boolean }
// Git verbs whose decision depends on the repository's current branch or push destination.
export const GUARD_BRANCH_VERBS: ReadonlySet<string> = new Set(['push', 'commit', 'rebase', 'reset', 'pull', 'filter-branch', 'filter-repo'])
export function gitInvocation(invocation: ParsedInvocation): GitInvocation | undefined {
    if (invocation.executable === null || posix.basename(invocation.executable) !== 'git') return undefined
    const args = invocation.argv
    let cursor = 0
    let cwd = invocation.cwd
    let uncertain = false
    const directories: { path: string; cwd: string }[] = []
    while (args[cursor]?.startsWith('-')) {
        const option = args[cursor++]
        if (option === '--') break
        if (option === '-C') {
            const directory = args[cursor++]
            if (directory === undefined) return { verb: '', args: [], cwd, directories, uncertain: true }
            directories.push({ path: directory, cwd })
            cwd = posix.resolve(cwd, directory)
        } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option)) {
            cursor++
            uncertain = true
        } else if (['--no-pager', '--paginate', '--no-optional-locks'].includes(option)) {
            continue
        } else if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(option)) {
            uncertain = true
        } else return { verb: '', args: [], cwd, directories, uncertain: true }
    }
    return { verb: args[cursor++] ?? '', args: args.slice(cursor), cwd, directories, uncertain }
}

/**
 * A revision whose content a Git verb writes into the working tree, and what it is compared with: HEAD
 * by default, since Git keeps or refuses a local change a merge or checkout would overwrite;
 * `worktree` for a verb that overwrites local changes; or another revision for a verb that applies the
 * difference between two, where a `from` that names no commit means every file `revision` holds.
 */
export interface GitTreeTarget { readonly revision: string; readonly from?: string }
/**
 * What a Git verb writes into the working tree from revisions: `targets` to compare, and `unnamed` when
 * the content arrives only as the command runs (a pull that fetches), so no comparison made first can
 * name it. Undefined for a verb that writes nothing from a revision; a pathspec form is judged by its
 * operands instead.
 */
export function gitTreeTargets(git: GitInvocation): Readonly<{ targets: readonly GitTreeTarget[]; unnamed: boolean }> | undefined {
    const control = git.args.some(arg => /^--(?:abort|continue|skip|quit|edit-todo|show-current-patch)$/.test(arg))
    const head = (revisions: readonly string[]) => ({ targets: revisions.map(revision => ({ revision })), unnamed: false })
    const previous = (revision: string) => revision === '-' ? '@{-1}' : revision
    if (git.verb === 'merge' && !control) {
        const revisions = gitOperands(git.args, ['-m', '-F', '-s', '-X', '--strategy', '--strategy-option', '--file', '--message', '--into-name'])
        return head(revisions.length ? revisions.map(previous) : ['@{upstream}'])
    }
    if (git.verb === 'checkout' || git.verb === 'switch') {
        if (git.args.includes('--')) return undefined
        const created = git.args.some(arg => ['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan'].includes(arg))
        const operands = gitOperands(git.args, ['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan', '--conflict'])
        // A new branch starts at its start point, or HEAD when none is named.
        const revision = created ? operands[1] : operands.length === 1 ? operands[0] : undefined
        return revision === undefined ? undefined : head([previous(revision)])
    }
    if (git.verb === 'reset' && git.args.some(arg => /^--(?:hard|merge|keep)$/.test(arg))) {
        const end = git.args.indexOf('--')
        const revision = (end < 0 ? git.args : git.args.slice(0, end)).find(arg => !arg.startsWith('-')) ?? 'HEAD'
        return { targets: [{ revision, from: 'worktree' }], unnamed: false }
    }
    if ((git.verb === 'cherry-pick' || git.verb === 'revert') && !control) {
        const targets = gitOperands(git.args, ['-m', '--mainline', '-X', '--strategy', '--strategy-option']).map(operand => {
            const range = /^(.+?)\.\.(.+)$/.exec(operand)
            const [from, to] = range ? [range[1]!, range[2]!] : [`${operand}^`, operand]
            return git.verb === 'revert' ? { revision: from, from: to } : { revision: to, from }
        })
        return { targets, unnamed: false }
    }
    if (git.verb === 'rebase' && !control) {
        const operands = gitOperands(git.args, ['--onto', '-s', '--strategy', '-X', '--strategy-option'])
        const onto = git.args[git.args.indexOf('--onto') + 1]
        const base = git.args.includes('--onto') ? onto : operands[0] ?? (git.args.includes('--root') ? undefined : '@{upstream}')
        return head([...base === undefined ? [] : [base], ...operands.slice(1, 2)])
    }
    if (git.verb === 'stash') {
        const [verb, stash = 'stash@{0}'] = gitOperands(git.args, ['-m', '--message', '--pathspec-from-file'])
        // Applying a stash applies what it changed against its base, and restores the untracked files it took.
        if (['pop', 'apply'].includes(verb ?? '')) return { targets: [{ revision: stash, from: `${stash}^1` }, { revision: `${stash}^3`, from: `${stash}^3^` }], unnamed: false }
        // Stashing returns the working tree to HEAD.
        if (verb === undefined || ['push', 'save'].includes(verb)) return { targets: [{ revision: 'HEAD', from: 'worktree' }], unnamed: false }
        return undefined
    }
    if (git.verb === 'pull') {
        // Only a fast-forward to a configured remote's branch can be named before the fetch; its
        // remote-tracking ref holds what was last fetched or pushed there.
        const operands = gitOperands(git.args, ['-s', '--strategy', '-X', '--strategy-option', '--depth', '-j', '--jobs', '-o', '--server-option'])
        const fastForward = git.args.includes('--ff-only') && !git.args.some(arg => /^--rebase(?:=(?!false$)|$)|^-r$/.test(arg))
        if (fastForward && operands.length === 0) return head(['@{upstream}'])
        if (fastForward && operands.length === 2 && /^[\w.-]+$/.test(operands[0]!) && operands[0] !== '.' && /^[\w./-]+$/.test(operands[1]!)) return head([`${operands[0]}/${operands[1]}`])
        return { targets: [{ revision: 'HEAD' }], unnamed: true }
    }
    return undefined
}

const REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'trash', 'rimraf', 'del-cli'])
// Git's own commands an agent runs in development. Another verb is an alias, which can run a shell
// command, or a command that runs hooks, tools or servers of its own, and asks.
const GIT_VERBS = new Set(['add', 'am', 'annotate', 'apply', 'archive', 'backfill', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore',
    'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'clean', 'clone', 'column', 'commit', 'commit-graph', 'commit-tree',
    'config', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'fetch', 'filter-branch', 'filter-repo', 'fmt-merge-msg', 'for-each-ref',
    'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'interpret-trailers', 'lfs', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge',
    'merge-base', 'merge-file', 'merge-tree', 'mktag', 'mktree', 'mv', 'name-rev', 'notes', 'pack-refs', 'patch-id', 'prune', 'pull', 'push', 'range-diff', 'read-tree',
    'rebase', 'reflog', 'refs', 'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'send-pack', 'shortlog', 'show',
    'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var',
    'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree'])

interface TransferOperands { readonly sources: readonly string[]; readonly writes: readonly string[]; readonly uncertain: boolean }

/** Visible source and destination paths for copy/install/move/link without inferring filesystem state. */
function transferOperands(command: 'cp' | 'install' | 'mv' | 'ln', args: readonly string[]): TransferOperands {
    const operands: string[] = []
    let targetDirectory: string | undefined
    let noTargetDirectory = false
    let installDirectories = false
    let uncertain = false
    let options = true
    const plainShort = command === 'cp' ? 'afHiLlnPpRrsvXx' : command === 'mv' ? 'fhinuv' : command === 'ln' ? 'bdFfhiLnPrsvw' : 'bCcpSsUv'
    const valueShort = command === 'install' ? new Set(['f', 'g', 'm', 'o', 'M', 'h', 'B', 'l', 'N']) : command === 'ln' ? new Set(['S', 't']) : new Set<string>()
    const plainLong = new Set(command === 'cp' ? ['archive', 'force', 'interactive', 'link', 'no-clobber', 'no-dereference', 'preserve', 'recursive', 'reflink', 'remove-destination', 'sparse', 'symbolic-link', 'update', 'verbose']
        : command === 'mv' ? ['force', 'interactive', 'no-clobber', 'no-target-directory', 'update', 'verbose']
            : command === 'ln' ? ['backup', 'directory', 'force', 'interactive', 'logical', 'no-dereference', 'physical', 'relative', 'symbolic', 'verbose']
                : ['backup', 'compare', 'directory', 'preserve-timestamps', 'strip', 'verbose'])
    const valueLong = new Set(command === 'install' ? ['group', 'mode', 'owner', 'suffix'] : ['suffix'])
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (options && arg === '--') { options = false; continue }
        if (options && (arg === '-t' || arg === '--target-directory')) {
            targetDirectory = args[++index]
            if (targetDirectory === undefined) uncertain = true
            continue
        }
        if (options && arg.startsWith('--target-directory=')) {
            targetDirectory = arg.slice('--target-directory='.length)
            if (!targetDirectory) uncertain = true
            continue
        }
        if (options && (arg === '-T' || arg === '--no-target-directory')) { noTargetDirectory = true; continue }
        if (options && command === 'install' && (arg === '-d' || arg === '--directory')) { installDirectories = true; continue }
        if (options && arg.startsWith('--')) {
            const [option, attached] = arg.slice(2).split(/=(.*)/s)
            if (valueLong.has(option!)) {
                if (attached === undefined && args[++index] === undefined) uncertain = true
            } else if (!plainLong.has(option!)) uncertain = true
            if (command === 'cp' && ['recursive', 'archive'].includes(option!)) uncertain = true
            continue
        }
        if (options && arg.startsWith('-') && arg !== '-') {
            const letters = arg.slice(1)
            const valueAt = [...letters].findIndex(letter => valueShort.has(letter))
            if (valueAt >= 0) {
                const value = valueAt === letters.length - 1 ? args[++index] : undefined
                if (value === undefined) uncertain = true
                // `ln -sft dir source` names the target directory inside a cluster.
                else if (letters[valueAt] === 't') targetDirectory = value
            } else if ([...letters].some(letter => !plainShort.includes(letter))) uncertain = true
            if (command === 'cp' && /[Rr]/.test(letters)) uncertain = true
            continue
        }
        operands.push(arg)
    }
    if (installDirectories) return { sources: [], writes: operands, uncertain: uncertain || targetDirectory !== undefined || noTargetDirectory }
    if (targetDirectory !== undefined) return {
        sources: operands,
        writes: [targetDirectory, ...operands.map(source => posix.join(targetDirectory!, posix.basename(source)))],
        uncertain: uncertain || noTargetDirectory,
    }
    // `ln source` links into the working directory under the source's own name.
    if (command === 'ln' && operands.length === 1) return { sources: operands, writes: [posix.basename(operands[0]!)], uncertain: uncertain || noTargetDirectory }
    if (operands.length < 2) return { sources: [], writes: [], uncertain: true }
    const sources = operands.slice(0, -1)
    const destination = operands.at(-1)!
    return {
        sources,
        writes: [destination, ...(!noTargetDirectory ? sources.map(source => posix.join(destination, posix.basename(source))) : [])],
        uncertain,
    }
}

// Git verbs that write files from a revision or a patch into a work tree, where a symbolic link can arrive.
const GIT_TREE_WRITERS = new Set(['checkout', 'switch', 'restore', 'reset', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'stash', 'am', 'apply',
    'clone', 'worktree', 'read-tree', 'checkout-index', 'submodule', 'mv', 'bisect', 'sparse-checkout'])

/**
 * Whether an invocation can create a symbolic link: `ln`, a copy that keeps or makes links, a sync or
 * an extraction that can carry one, or Git writing a revision's files. A link's text resolves where the
 * link lies, so one made or moved in a call can point anywhere once it is moved, and every later path
 * in that call is judged against the filesystem as it was before the call.
 */
function createsLink(invocation: ParsedInvocation, git: GitInvocation | undefined): boolean {
    if (invocation.executable === null) return false
    if (git) {
        if (!GIT_TREE_WRITERS.has(git.verb)) return false
        const operands = git.args.filter(arg => !arg.startsWith('-'))
        // Forms that write only the index or refs leave the work tree, and every link in it, as it was.
        if (['checkout', 'switch'].includes(git.verb) && git.args.some(arg => ['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan'].includes(arg)) && operands.length <= 1) return false
        if (git.verb === 'restore' && git.args.some(arg => arg === '--staged' || arg === '-S') && !git.args.some(arg => arg === '--worktree' || arg === '-W')) return false
        if (git.verb === 'reset' && !git.args.some(arg => /^--(?:hard|merge|keep)$/.test(arg))) return false
        if (git.verb === 'stash' && ['list', 'show'].includes(operands[0] ?? '')) return false
        if (git.verb === 'worktree' && operands[0] !== 'add') return false
        if (git.verb === 'submodule' && !['update', 'add'].includes(operands[0] ?? '')) return false
        if (git.verb === 'bisect' && ['log', 'visualize', 'view'].includes(operands[0] ?? '')) return false
        return true
    }
    const name = posix.basename(invocation.executable)
    if (['ln', 'link', 'rsync', 'unzip', 'cpio', 'pax', 'ditto', 'bsdtar', 'gtar', '7z', '7za', '7zz'].includes(name)) return true
    if (name === 'tar') return invocation.argv.some(arg => arg === '--extract' || arg === '--get' || /^-?[A-Za-z]*x/.test(arg) && !arg.startsWith('--'))
    // `cp -l` makes hard links, `-s` symbolic ones, and the rest keep the links they copy.
    if (name === 'cp') return invocation.argv.some(arg => /^--(?:link|symbolic-link|no-dereference|archive|recursive|preserve(?:=.*links.*)?)$/.test(arg)
        || /^-[A-Za-z]*[sPadRrl]/.test(arg))
    // BSD `install -l` makes a hard or symbolic link in place of the copy.
    if (name === 'install') return invocation.argv.some(arg => /^-[A-Za-z]*l/.test(arg) && !arg.startsWith('--'))
    // A clone or a downloaded archive brings whatever links the repository or artifact holds.
    if (name === 'gh') return materialisesRepository(invocation)
    return false
}

/** `gh repo clone`, `gh repo fork --clone`, `gh gist clone`, `gh release download` and `gh run download`. */
function materialisesRepository(invocation: ParsedInvocation): boolean {
    const words = invocation.argv.filter(arg => !arg.startsWith('-'))
    const [group, verb] = words
    return (group === 'repo' || group === 'gist') && verb === 'clone' || group === 'repo' && verb === 'fork' && invocation.argv.some(arg => /^--clone(?:=true)?$/.test(arg))
        || (group === 'release' || group === 'run') && verb === 'download'
}

/**
 * A writer whose member names the guard cannot see: an extraction, a sync of a directory, a recursive
 * copy, a clone or a download of an archive. Outside the roots a write path admits only a write that
 * names each file, so none of these writes there.
 */
function writesUnseenMembers(invocation: ParsedInvocation, git: GitInvocation | undefined): boolean {
    if (invocation.executable === null) return false
    if (git) return ['clone', 'worktree', 'submodule', 'bundle'].includes(git.verb)
    const name = posix.basename(invocation.executable)
    if (['rsync', 'unzip', 'cpio', 'pax', 'ditto', 'bsdtar', 'gtar', '7z', '7za', '7zz', 'scp'].includes(name)) return true
    if (name === 'tar') return createsLink(invocation, undefined)
    if (name === 'cp') return invocation.argv.some(arg => /^--(?:archive|recursive)$/.test(arg) || /^-[A-Za-z]*[aRr]/.test(arg))
    if (name === 'gh') return materialisesRepository(invocation)
    if (name === 'wget') return invocation.argv.some(arg => /^--(?:recursive|mirror|page-requisites)$/.test(arg) || /^-[A-Za-z]*[rmp]/.test(arg))
    return false
}

interface VisibleWrites {
    readonly paths: readonly string[]
    readonly reads?: readonly string[]
    /** Link targets, which must not reach anything protected under a new name. */
    readonly links?: readonly string[]
    /** Each destination is emptied, replaced by a link or made unreadable, so it is checked as a removal too. */
    readonly removes: boolean
    readonly uncertain: boolean
}

/** Git abbreviates long options and bundles short ones, so output recognition must consume every known option value. */
function gitArchiveWrites(args: readonly string[]): VisibleWrites | undefined {
    const longOptions = [
        { name: 'format', valued: true },
        { name: 'prefix', valued: true },
        { name: 'add-file', valued: true },
        { name: 'add-virtual-file', valued: true },
        { name: 'output', valued: true },
        { name: 'worktree-attributes', valued: false },
        { name: 'verbose', valued: false },
        { name: 'mtime', valued: true },
        { name: 'list', valued: false },
        { name: 'remote', valued: true },
        { name: 'exec', valued: true },
    ] as const
    const paths: string[] = []
    let output = false
    let uncertain = false
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (arg === '--') break
        if (arg.startsWith('--')) {
            const [spelling, attached] = arg.slice(2).split(/=(.*)/s)
            if (spelling!.startsWith('no-')) {
                const name = spelling!.slice(3)
                const matches = longOptions.filter(option => option.name !== 'mtime' && option.name.startsWith(name))
                if (matches.length !== 1 || attached !== undefined) uncertain = true
                continue
            }
            const matches = longOptions.filter(option => option.name.startsWith(spelling!))
            if (matches.length !== 1) { uncertain = true; continue }
            const option = matches[0]!
            if (!option.valued) {
                if (attached !== undefined) uncertain = true
                continue
            }
            const value = attached ?? args[++index]
            if (!value) uncertain = true
            else if (option.name === 'output') { output = true; paths.push(value) }
            continue
        }
        if (/^-[0-9]+$/.test(arg)) continue
        if (arg.startsWith('-') && arg !== '-') {
            const options = arg.slice(1)
            for (let offset = 0; offset < options.length; offset++) {
                const option = options[offset]!
                if (option === 'v' || option === 'l') continue
                if (option === 'o') {
                    output = true
                    const value = options.slice(offset + 1) || args[++index]
                    if (value) paths.push(value)
                    else uncertain = true
                    break
                }
                uncertain = true
                break
            }
        }
    }
    return output || uncertain ? { paths, removes: true, uncertain } : undefined
}

/**
 * What tar writes: an extraction writes every member below its destination, the working directory or
 * `-C`; a creation or update writes the archive `-f` names; a listing writes nothing. Options bundle as
 * `-czf` or, in the first word, without a dash (`xzf`); `f` and `C` take the next word.
 */
function tarWrites(args: readonly string[]): VisibleWrites & { readonly mode: string | undefined; readonly sources: readonly string[] } {
    let mode: string | undefined
    let destination = '.'
    let archive: string | undefined
    let uncertain = false
    let options = true
    const sources: string[] = []
    const modes: Readonly<Record<string, string>> = { '--extract': 'x', '--get': 'x', '--create': 'c', '--list': 't', '--append': 'r', '--update': 'u' }
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (options && arg === '--') { options = false; continue }
        const cluster = options && (/^-[a-zA-Z]+$/.test(arg) || index === 0 && /^[a-zA-Z]+$/.test(arg)) ? arg.replace(/^-/, '') : undefined
        if (cluster !== undefined) {
            for (const letter of cluster) {
                if ('xctru'.includes(letter)) { if (mode && mode !== letter) uncertain = true; mode = letter }
                else if (letter === 'f') { archive = args[++index]; if (archive === undefined) uncertain = true }
                else if (letter === 'C') { const value = args[++index]; if (value === undefined) uncertain = true; else destination = value }
                // Compression, verbosity and keeping permissions change nothing about where tar writes.
                else if (!'zjJvpkm'.includes(letter)) uncertain = true
            }
            continue
        }
        if (!options || !arg.startsWith('--')) { sources.push(arg); continue }
        const [option, value] = arg.split(/=(.*)/s)
        if (modes[option!] !== undefined && value === undefined) { if (mode && mode !== modes[option!]) uncertain = true; mode = modes[option!] }
        else if (option === '--file' || option === '--directory') {
            const given = value ?? args[++index]
            if (!given) uncertain = true
            else if (option === '--file') archive = given
            else destination = given
        } else if (!['--gzip', '--bzip2', '--xz', '--verbose', '--keep-old-files', '--preserve-permissions'].includes(arg)) uncertain = true
    }
    const writesArchive = mode === 'c' || mode === 'r' || mode === 'u'
    // An archive written to standard output names no file.
    const written = writesArchive ? (archive === undefined || archive === '-' ? [] : [archive]) : mode === 'x' ? [destination] : []
    return { mode, paths: written, reads: mode === 'x' || mode === 't' ? (archive === undefined || archive === '-' ? [] : [archive]) : [], removes: false,
        sources: writesArchive ? sources : [], uncertain: uncertain || mode === undefined || mode === 'x' && archive === undefined }
}

/** unzip writes every member below its destination, the working directory or `-d`; listing, testing and printing write nothing. */
function unzipWrites(args: readonly string[]): VisibleWrites | undefined {
    let destination = '.'
    let archive: string | undefined
    let uncertain = false
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        // What follows -x names members to leave out, not paths.
        if (arg === '-x') break
        if (arg === '-d' || arg === '-P') {
            const value = args[++index]
            if (value === undefined) uncertain = true
            else if (arg === '-d') destination = value
        } else if (/^-d./.test(arg)) destination = arg.slice(2)
        else if (/^-[a-zA-Z]+$/.test(arg)) {
            if (/[lptvcZz]/.test(arg)) return undefined
        } else if (arg.startsWith('-')) uncertain = true
        // Words after the archive name its members.
        else archive ??= arg
    }
    return { paths: [destination], reads: archive === undefined ? [] : [archive], removes: false, uncertain: uncertain || archive === undefined }
}

const CHMOD_CLAUSE = '[ugoa]*(?:[-+=][rwxXstugo]*)+'
const CHMOD_MODE = new RegExp(`^(?:[0-7]{1,4}|${CHMOD_CLAUSE}(?:,${CHMOD_CLAUSE})*)$`)

function keepsOwnerRead(mode: string): boolean {
    if (/^[0-7]+$/.test(mode)) return (Number(mode.padStart(4, '0')[1]) & 4) !== 0
    return mode.split(',').every((clause) => {
        const match = /^([ugoa]*)((?:[-+=][rwxXst]*)+)$/.exec(clause)
        if (!match) return false
        if (match[1] !== '' && !/[ua]/.test(match[1])) return true
        return [...match[2]!.matchAll(/([-+=])([rwxXst]*)/g)].every(([, operator, permissions]) =>
            operator === '+' || operator === '-' && !permissions!.includes('r') || operator === '=' && permissions!.includes('r'))
    })
}

const GIT_CONFIG_READ_ACTIONS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l'])
const GIT_CONFIG_READ_OPTIONS = new Set(['--global', '--system', '--local', '--worktree', '--includes', '--no-includes', '--show-origin',
    '--show-scope', '--name-only', '-z', '--null', '--bool', '--int', '--bool-or-int', '--path', '--expiry-date', '--fixed-value', '--all'])
const GIT_CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default'])

/** Whether a `git config` invocation is a proven read; every other form may write configuration. */
function gitConfigReads(args: readonly string[]): boolean {
    const subcommand = args[0] === 'get' || args[0] === 'list'
    let action = subcommand
    const positionals: string[] = []
    for (let index = subcommand ? 1 : 0; index < args.length; index++) {
        const arg = args[index]!
        if (!arg.startsWith('-')) { positionals.push(arg); continue }
        const name = arg.split('=')[0]!
        if (GIT_CONFIG_READ_ACTIONS.has(name)) action = true
        else if (GIT_CONFIG_VALUE_OPTIONS.has(name)) { if (!arg.includes('=')) index++ }
        else if (!GIT_CONFIG_READ_OPTIONS.has(name)) return false
    }
    // A lone `section.key` reads it; a lone word such as `edit` is a subcommand that writes.
    return action || positionals.length === 1 && positionals[0]!.includes('.')
}

/** Destinations exposed directly by bounded filesystem writer grammars. */
function visibleWrites(invocation: ParsedInvocation): VisibleWrites | undefined {
    if (invocation.executable === null) return undefined
    const name = posix.basename(invocation.executable)
    if (name === 'cp' || name === 'install' || name === 'mv') {
        const transfer = transferOperands(name, invocation.argv)
        // `cp -s` and `cp -l` make each destination a symbolic or hard link to its source, as `ln` does, and so does BSD `install -l`.
        const linking = name === 'cp' && invocation.argv.some(arg => ['--symbolic-link', '--link'].includes(arg) || /^-[A-Za-z]*[sl]/.test(arg))
            || name === 'install' && invocation.argv.some(arg => /^-[A-Za-z]*l/.test(arg) && !arg.startsWith('--'))
        return { paths: transfer.writes, reads: name === 'mv' ? [] : transfer.sources, removes: linking, uncertain: transfer.uncertain,
            ...linking ? { links: transfer.sources } : {} }
    }
    // `link <file> <name>` makes a hard link, as `ln` without options does.
    if (name === 'link') {
        const operands = invocation.argv.filter(arg => arg !== '--')
        return { paths: operands.slice(1, 2), links: operands.slice(0, 1), removes: true, uncertain: operands.length !== 2 || invocation.argv.some(arg => arg.startsWith('-') && arg !== '--') }
    }
    if (name === 'ln') {
        const transfer = transferOperands('ln', invocation.argv)
        return { paths: transfer.writes, links: transfer.sources, removes: true, uncertain: transfer.uncertain }
    }
    if (name === 'dd') {
        const paths = invocation.argv.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)).filter(Boolean)
        const reads = invocation.argv.filter(arg => arg.startsWith('if=')).map(arg => arg.slice(3)).filter(Boolean)
        const operands = new Set(['if', 'of', 'bs', 'ibs', 'obs', 'cbs', 'count', 'skip', 'seek', 'iseek', 'oseek', 'files', 'fillchar', 'speed', 'status', 'conv', 'iflag', 'oflag'])
        const conversions = new Set(['ascii', 'ebcdic', 'ibm', 'block', 'unblock', 'lcase', 'ucase', 'swab', 'noerror', 'notrunc', 'sync',
            'osync', 'sparse', 'fsync', 'fdatasync', 'excl', 'nocreat', 'oldascii', 'oldebcdic', 'oldibm', 'pareven', 'parnone', 'parodd', 'parset'])
        const flags = new Set(['append', 'binary', 'cio', 'direct', 'directory', 'dsync', 'noatime', 'nocache', 'noctty', 'nofollow',
            'nolinks', 'nonblock', 'sync', 'text', 'fullblock', 'count_bytes', 'skip_bytes', 'seek_bytes', 'fsync'])
        let removes = true
        let uncertain = false
        for (const arg of invocation.argv) {
            const [operand, value] = arg.split(/=(.*)/s)
            if (!operands.has(operand!) || !value) { uncertain = true; continue }
            if (operand === 'conv') {
                const values = value.split(',')
                if (values.some(value => !conversions.has(value))) uncertain = true
                // GNU and BSD accumulate conversions across operands; later conv= cannot undo notrunc.
                if (values.includes('notrunc')) removes = false
            } else if (operand === 'iflag' || operand === 'oflag') {
                if (value.split(',').some(value => !flags.has(value))) uncertain = true
            }
        }
        return { paths, reads, removes, uncertain }
    }
    if (name === 'tar') return tarWrites(invocation.argv)
    if (name === 'unzip') return unzipWrites(invocation.argv)
    const scan = (plain: Set<string>, valued: Set<string>) => {
        const operands: string[] = []
        const optionArguments: string[] = []
        let optionsAfterOperand = false
        let uncertain = false
        let options = true
        for (let index = 0; index < invocation.argv.length; index++) {
            const arg = invocation.argv[index]!
            if (options && arg === '--') { options = false; continue }
            if (options && arg.startsWith('-') && arg !== '-') {
                optionArguments.push(arg)
                if (operands.length) optionsAfterOperand = true
                const option = arg.split('=')[0]!
                if (valued.has(option)) {
                    if (!arg.includes('=') && invocation.argv[++index] === undefined) uncertain = true
                } else if (option.startsWith('--') ? !plain.has(option) : [...option.slice(1)].some(letter => !plain.has(`-${letter}`))) uncertain = true
                continue
            }
            operands.push(arg)
        }
        return { operands, optionArguments, optionsAfterOperand, uncertain }
    }
    if (name === 'tee') {
        const result = scan(new Set(['-a', '-i', '-p', '--append', '--ignore-interrupts', '--output-error']), new Set())
        // BSD stops option parsing at the first filename; GNU may permute later options.
        const append = !result.optionsAfterOperand && result.optionArguments.some(arg => arg === '--append' || /^-[aip]*a[aip]*$/.test(arg))
        return { paths: result.operands, removes: !append, uncertain: result.uncertain || result.optionsAfterOperand
            || result.optionArguments.some(arg => arg.includes('=') && !/^--output-error=(?:warn|warn-nopipe|exit|exit-nopipe)$/.test(arg)) }
    }
    if (name === 'touch') {
        const result = scan(new Set(['-a', '-c', '-h', '-m', '--no-create']), new Set(['-A', '-d', '-r', '-t', '--date', '--reference', '--time']))
        return { paths: result.operands, removes: false, uncertain: result.uncertain }
    }
    if (name === 'mkdir') {
        const result = scan(new Set(['-p', '-v', '--parents', '--verbose']), new Set(['-m', '--mode']))
        return { paths: result.operands, removes: false, uncertain: result.uncertain }
    }
    if (name === 'truncate') {
        const result = scan(new Set(['-c', '--no-create']), new Set(['-r', '-s', '--reference', '--size']))
        return { paths: result.operands, removes: true, uncertain: result.uncertain }
    }
    if (name === 'chmod') {
        const result = scan(new Set(['-f', '-h', '-v', '-R', '-H', '-L', '-P', '-E', '-C', '-N', '-i', '-I']), new Set(['--reference']))
        const reference = result.optionArguments.some(arg => arg.startsWith('--reference'))
        const mode = !reference && result.operands.length > 1 && CHMOD_MODE.test(result.operands[0]!) ? result.operands[0] : undefined
        // A mode taken from another file, or one that drops the owner's read, can leave a file unloadable.
        return { paths: result.operands.slice(mode === undefined ? 0 : 1), removes: mode === undefined || !keepsOwnerRead(mode),
            uncertain: result.uncertain || result.operands.length === 0 }
    }
    return undefined
}

/** Paths an invocation deletes or renames away; undefined when it does neither. */
function removedOperands(invocation: ParsedInvocation, git: GitInvocation | undefined): { readonly cwd: string; readonly paths: readonly string[] } | undefined {
    if (invocation.executable === null) return undefined
    const name = posix.basename(invocation.executable)
    const positionals = (args: readonly string[]) => {
        const end = args.indexOf('--')
        return [...(end < 0 ? args : args.slice(0, end)).filter((arg) => !arg.startsWith('-')), ...(end < 0 ? [] : args.slice(end + 1))]
    }
    if (REMOVERS.has(name)) return { cwd: invocation.cwd, paths: positionals(invocation.argv) }
    if (name === 'mv') return { cwd: invocation.cwd, paths: transferOperands('mv', invocation.argv).sources }
    if (name === 'find' && invocation.argv.includes('-delete')) {
        const roots = []
        for (const arg of invocation.argv) { if (arg.startsWith('-') || arg === '!' || arg === '(') break; roots.push(arg) }
        return { cwd: invocation.cwd, paths: roots.length ? roots : ['.'] }
    }
    if (git?.verb === 'rm') return { cwd: git.cwd, paths: positionals(git.args) }
    if (git?.verb === 'mv') return { cwd: git.cwd, paths: positionals(git.args).slice(0, -1) }
    return undefined
}

/**
 * The repository's current branch and where a bare `git push` goes, as full ref names, or null when Git
 * could not say; `push.default`, whether a remote has configured push refspecs, and whether `git pull`
 * rebases the current branch.
 */
interface BranchFacts { readonly head: string | null; readonly push: string | null; readonly pushDefault: string | null; readonly pushRefspecs: boolean; readonly pullRebase: boolean }

const PUSH_FORCE = /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes)$/
const PUSH_DELETE = /^(?:-d|--delete|--prune|--mirror)$/
// Git accepts any unambiguous prefix of a long option: `--for` and `--forc` can only be a force option.
const forceAbbreviation = (value: string) => value.length >= 5 && ['--force', '--force-with-lease', '--force-if-includes'].some(option => option.startsWith(value.split('=')[0]!))

/**
 * Whether a push may run: force pushes and remote branch deletion are refused outright, a
 * protected branch is never a destination, and a destination the command leaves implicit is
 * resolved from the repository instead of being guessed.
 */
function pushDecision(args: readonly string[], branches: readonly string[], facts: BranchFacts | undefined): GuardDecision | undefined {
    const positionals: string[] = []
    let options = true
    let uncertain = false
    let allBranches = false
    let forced = false
    let deleting = false
    let unknownOption: string | undefined
    for (let i = 0; i < args.length; i++) {
        const value = args[i]!
        if (options && value === '--') { options = false; continue }
        if (options && value.startsWith('-')) {
            if (PUSH_FORCE.test(value) || forceAbbreviation(value)) forced = true
            else if (PUSH_DELETE.test(value)) { deleting = true; if (value === '--mirror') allBranches = true }
            // Short flags bundle: `-uf` forces as `-f` does.
            else if (/^-[ufdnvq]{2,}$/.test(value)) { if (value.includes('f')) forced = true; if (value.includes('d')) deleting = true }
            else if (value === '--no-verify') return deny('Refusing `--no-verify`: it skips the repository\'s pre-push hook. Push without it.')
            else if (/^--(?:receive-pack|exec)(?:=|$)/.test(value)) return deny('Refusing a push that names the program to run on the receiving side. Push without --receive-pack or --exec.')
            else if (value === '--all') allBranches = true
            else if (['-o', '--push-option', '--repo'].includes(value)) {
                if (args[++i] === undefined) { uncertain = true; continue }
                // --repo supplies the remote rather than a positional remote.
                if (value === '--repo') positionals.unshift(args[i]!)
            } else if (value.startsWith('--push-option=')) continue
            else if (value.startsWith('--repo=')) positionals.unshift(value.slice(7))
            else if (!['-u', '--set-upstream', '--tags', '--follow-tags', '--dry-run', '-n', '-v', '--verbose', '-q', '--quiet', '--atomic', '--porcelain'].includes(value)) unknownOption ??= value
        } else positionals.push(value)
    }
    const protectedDenial = deny('Refusing push to a declared protected branch.')
    if (allBranches && branches.length) return protectedDenial
    // Git expands a short destination as rev-parse does (`refs/%s`, `refs/heads/%s`), so `heads/main` is main.
    const protectedRef = (ref: string) => branches.some((branch) => [branch, `heads/${branch}`, `refs/heads/${branch}`].includes(ref))
    for (const ref of positionals.slice(1)) {
        if (ref.startsWith('+')) forced = true
        const spec = ref.replace(/^\+/, '')
        const colon = spec.indexOf(':')
        if (colon === 0) deleting = true
        const source = colon < 0 ? spec : spec.slice(0, colon)
        let destination = colon < 0 ? spec : spec.slice(colon + 1)
        // The stash's commits hold the untracked and ignored files `git stash -u` and `-a` took, environment files included.
        if (/^(?:refs\/)?stash(?:@\{|$)/.test(source)) return deny('Refusing to push the stash: its commits can hold untracked and ignored files, environment files included. Push a branch instead.')
        // `HEAD` and `@` push the current branch to the branch of the same name.
        if (colon < 0 && (source === 'HEAD' || source === '@')) {
            if (!facts?.head) { uncertain = true; continue }
            destination = facts.head
        } else if (colon < 0 && (/(?:^|\/)[A-Z_]+$|[@~^{}]|\.\./.test(source) || /^[a-f0-9]+$/i.test(source)
            || /-\d+-g[a-f0-9]+$/i.test(source) || /^(?:heads|tags|remotes)\//.test(source))) {
            // Other symbolic and abbreviated sources need repository state to name a destination.
            uncertain = true
            continue
        }
        if (protectedRef(destination)) return protectedDenial
        if (!destination || destination.includes('*')) uncertain = true
    }
    // With no refspec Git pushes where `@{push}` points: `refs/remotes/<remote>/<branch>`, whose remote
    // name may hold a slash, so any protected tail counts.
    if (positionals.length < 2) {
        if (facts?.push && branches.some((branch) => facts.push!.endsWith(`/${branch}`))) return deny('Refusing push to a declared protected branch: the current branch pushes to it.')
        // `matching` pushes every branch whose name the remote also has, and configured refspecs push what they name.
        if (facts?.pushDefault === 'matching' && branches.length) return deny('Refusing a push without a refspec under push.default=matching: it pushes every branch of the same name, protected ones included. Name the branch: `git push origin <branch>:<branch>`.')
        if (!facts?.push || facts.pushRefspecs) uncertain = true
    }
    if (forced) return deny('Refusing a force push: it can discard commits on the remote. Push new commits instead, or a person runs it.')
    if (deleting) return deny('Refusing to delete remote branches: `--delete`, `:<branch>`, `--prune` and `--mirror` remove branches on the remote. A person runs it.')
    if (unknownOption !== undefined) return ask(`The guard does not know the push option ${shownGuardWord(unknownOption)}, which may change what or where this push sends. Push without it, or a person runs it.`)
    if (uncertain) return ask('The guard could not tell which remote branch this push updates. Name it: `git push origin <branch>:<branch>`.')
    return undefined
}

// Key spellings Git reads as a program to run, or as a place it loads more configuration from: set by
// an agent, they would make the person's later Git commands run agent-written code.
const GIT_PROGRAM_KEY = /^(?:help\.autocorrect|core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|attributesfile|alternaterefscommand)|sequence\.editor|init\.templatedir|diff\.external|submodule\..*|trailer\..*\.(?:command|cmd)|.*\.helper|alias\..*|filter\..*|diff\..*\.(?:command|textconv)|merge\..*\.driver|gpg\..*|include(?:if)?\..*|protocol\..*|url\..*|remote\..*|credential\..*|uploadpack\..*|receive\..*|ssh\..*|pager\..*|interactive\..*|man\..*|web\..*|difftool\..*|mergetool\..*|instaweb\..*|sendemail\..*)$/i
// Configuration writes an agent may make in the checkout's own configuration under the allow default.
const GIT_PLAIN_KEY = /^(?:user\.(?:name|email)|init\.defaultbranch|pull\.(?:rebase|ff)|push\.(?:autosetupremote|followtags)|rebase\.(?:autostash|autosquash|updaterefs)|merge\.(?:ff|conflictstyle)|branch\.[^.\s]+\.rebase|color\.[a-z.]+|advice\.[a-z]+|status\.[a-z]+|log\.[a-z]+|commit\.(?:verbose|cleanup)|fetch\.prune|rerere\.enabled|core\.(?:autocrlf|filemode|ignorecase|quotepath|eol|safecrlf))$/i

/** Whether a `git config` write sets one plain key in the repository's own configuration. */
function gitConfigPlainWrite(args: readonly string[]): boolean {
    const rest = args[0] === 'set' || args[0] === 'unset' ? args.slice(1) : args
    const options = rest.filter(arg => arg.startsWith('-'))
    const [key, ...values] = rest.filter(arg => !arg.startsWith('-'))
    return key !== undefined && GIT_PLAIN_KEY.test(key) && values.length <= 1 && options.every(arg => ['--local', '--unset', '--add', '--replace-all'].includes(arg))
}

// Credential stores outside the managed roots, by their path below the home directory, and key
// files by name anywhere. The guard recognises only these names, so other credential files stay
// the agent tool's own permission to protect.
const HOME_CREDENTIALS = [/^\.ssh\/(?!.*\.pub$|known_hosts$|config$|authorized_keys$)/, /^\.aws\/credentials$/, /^\.aws\/sso\/cache\//, /^\.config\/gh\/hosts\.yml$/,
    /^\.netrc$/, /^\.npmrc$/, /^\.yarnrc(?:\.yml)?$/, /^\.pypirc$/, /^\.docker\/config\.json$/, /^\.kube\/config$/, /^\.codex\/auth\.json$/,
    /^\.claude\/\.credentials\.json$/, /^\.config\/gcloud\//, /^\.azure\//, /^library\/keychains\//, /^\.git-credentials$/,
    /^\.config\/git\/credentials$/, /^\.pgpass$/, /^\.gnupg\//, /^\.vault-token$/, /^\.authinfo(?:\.gpg)?$/, /^\.terraform\.d\/credentials\.tfrc\.json$/,
    /^\.cargo\/credentials(?:\.toml)?$/, /^\.gem\/credentials$/, /^\.m2\/settings\.xml$/, /^\.gradle\/gradle\.properties$/, /^\.config\/op\//,
    // Agent tools and deployment CLIs, each at the path its own source or documentation names; shell
    // histories hold every token a person typed. Matched folded, so `Library` is `library`.
    /^\.local\/share\/opencode\/auth\.json$/, /^\.claude\.json$/, /^\.(?:zsh|bash)_history$/, /^\.local\/share\/fish\/fish_history$/,
    /^\.supabase\/access-token$/, /^\.fly\/config\.yml$/, /^\.config\/configstore\/firebase-tools\.json$/, /^\.sentryclirc$/, /^\.config\/hub$/,
    /^(?:\.config|library\/preferences)\/netlify\/config\.json$/, /^(?:\.config|library\/application support)\/doctl\/config\.yaml$/,
    /^(?:\.config|library\/application support)\/sentry\/sentrycli\.ini$/, /^(?:\.local\/share|library\/application support)\/com\.vercel\.cli\//,
    /^(?:\.config\/|library\/preferences\/)?\.wrangler\//, /^\.config\/stripe\//,
    // Older or alternative locations a tool may no longer write; refusing a path nothing uses costs nothing.
    // GitHub Copilot's editor plugins (apps.json, hosts.json before it), Vercel's `~/.vercel`, Netlify's
    // `~/.netlify` and a Heroku credentials file.
    /^\.config\/github-copilot\//, /^\.vercel\//, /^\.netlify\//, /^\.heroku\//]
// The directories that hold those stores: naming one, or a directory above it, hands a recursive
// tool (`zip -r`, `rsync -a`, `scp -r`) every file below.
const HOME_CREDENTIAL_DIRECTORIES = ['.ssh', '.aws', '.config/gh', '.docker', '.kube', '.codex', '.claude', '.config/gcloud', '.azure', 'library/keychains',
    '.config/git', '.gnupg', '.terraform.d', '.cargo', '.gem', '.m2', '.gradle', '.config/op', '.local/share/opencode', '.local/share/com.vercel.cli',
    'library/application support/com.vercel.cli', '.wrangler', '.config/.wrangler', 'library/preferences/.wrangler', '.config/stripe', '.supabase', '.fly',
    '.config/github-copilot', '.vercel', '.netlify', '.heroku']
const KEY_FILE = /^(?:.*\.(?:pem|p12|pfx|key)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?!.*\.pub$).*)$/

// macOS reaches the home directory also through the Data volume's firmlink, and through the startup
// disk's own name under /Volumes, a link to `/`. The guard cannot tell which name is the startup disk,
// so a path below any volume is judged as the same path from `/` too.
const unfirmlinked = (folded: string) => folded === '/system/volumes/data' ? '/' : folded.startsWith('/system/volumes/data/') ? folded.slice('/system/volumes/data'.length)
    : /^\/volumes\/[^/]+(?:\/|$)/.test(folded) ? folded.replace(/^\/volumes\/[^/]+/, '') || '/' : folded

/** A path spelled through the Data volume's firmlink or a volume under /Volumes, as the same path from `/`; any other path as it is. */
export function guardFirmlinkStripped(path: string): string {
    const stripped = path.replace(/^\/system\/volumes\/data(?=\/|$)/i, '').replace(/^\/volumes\/[^/]+(?=\/|$)/i, '')
    return stripped === path ? path : stripped || '/'
}

function credentialStore(spelled: string, home: string | undefined): boolean {
    const folded = unfirmlinked(spelled)
    if (KEY_FILE.test(posix.basename(folded))) return true
    if (home === undefined) return false
    const foldedHome = fold(home)
    if (within(foldedHome, folded)) return true
    if (!within(folded, foldedHome)) return false
    const below = folded.slice(foldedHome.length + 1)
    return HOME_CREDENTIALS.some(pattern => pattern.test(below)) || HOME_CREDENTIAL_DIRECTORIES.some(directory => within(directory, below))
}

// Under native external writes the agent tool decides a write outside the roots, except where the write
// would change what agents, the shell, Git or the system run later, or reach a credential: those stay
// refused whatever the tool would allow. Matched folded, below the home directory or anywhere.
const HOME_RUN_CONFIGURATION: readonly Readonly<{ path: string; what: string }>[] = [
    ...['.claude', '.claude.json', '.codex', '.config/opencode', '.local/share/opencode', '.local/state/opencode', '.cursor', '.grok', '.gemini',
        '.config/claude', '.config/github-copilot', '.agents', '.mcp.json'].map(path => ({ path, what: 'an agent tool\'s own configuration' })),
    ...['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.inputrc',
        '.config/fish', '.oh-my-zsh', '.config/direnv', '.direnvrc'].map(path => ({ path, what: 'a shell startup file' })),
    ...['.gitconfig', '.config/git', '.config/gh', '.npmrc', '.yarnrc', '.yarnrc.yml', '.config/pnpm', '.bunfig.toml', '.config/pip', '.pip',
        '.cargo/config', '.cargo/config.toml', '.docker', '.ssh', '.config/mise', '.tool-versions'].map(path => ({ path, what: 'a tool configuration that chooses the programs it runs' })),
    ...['library/launchagents', '.config/systemd', '.local/share/systemd', '.config/autostart'].map(path => ({ path, what: 'a launch agent or scheduled job' })),
]
const SYSTEM_RUN_CONFIGURATION = ['/etc', '/private/etc', '/library', '/system', '/usr', '/bin', '/sbin', '/var/at', '/private/var/at', '/var/spool', '/private/var/spool',
    '/var/cron', '/private/var/cron']
// Another checkout's agent configuration and generated guard, Git hooks wherever a repository keeps
// them, and direnv's `.envrc`, which runs when a shell enters its directory.
const NAMED_RUN_CONFIGURATION = new Set(['.cockpit', '.claude', '.codex', '.opencode', '.cursor', '.grok', '.gemini', '.git', '.husky', '.githooks'])
const NAMED_RUN_FILES = new Set(['opencode.json', 'opencode.jsonc', '.envrc', '.mcp.json'])

function externalWriteHazard(spelled: string, home: string | undefined, searchDirectories: readonly string[]): string | undefined {
    const folded = unfirmlinked(spelled)
    if (credentialStore(folded, home)) return 'a credential store'
    if (dotenvName(posix.basename(folded)) || folded.split('/').includes('.secrets')) return 'an environment file or secrets directory'
    if (folded.split('/').some(name => NAMED_RUN_CONFIGURATION.has(name)) || NAMED_RUN_FILES.has(posix.basename(folded))) return 'an agent tool\'s configuration, a cockpit\'s guard or a repository\'s Git hooks'
    if (searchDirectories.some(directory => posix.dirname(folded) === fold(directory) || within(fold(directory), folded))) return 'a command search path directory'
    if (SYSTEM_RUN_CONFIGURATION.some(directory => within(folded, directory))) return 'system configuration, launch daemons or scheduled jobs'
    if (home === undefined) return undefined
    const foldedHome = fold(home)
    if (!within(folded, foldedHome)) return undefined
    const below = folded.slice(foldedHome.length + 1)
    return HOME_RUN_CONFIGURATION.find(item => within(below, item.path) || within(item.path, below))?.what
}
const dotenvName = (name: string) => name === '.env' || name.startsWith('.env.')

/**
 * Files a command writes through an option rather than an operand: Git's patch output, downloads,
 * sorted output and in-place edits. Each is judged as a write, whatever grant admits the command.
 */
function optionWrites(invocation: ParsedInvocation, git: GitInvocation | undefined): { readonly cwd: string; readonly paths: readonly string[]; readonly covered: readonly string[] } | undefined {
    if (invocation.executable === null) return undefined
    const name = posix.basename(invocation.executable)
    const args = git ? git.args : invocation.argv
    const paths: string[] = []
    // Directories a write lands below under a name the guard cannot read.
    const covered: string[] = []
    // Short options bundle (`curl -sSo out`): in a cluster, the first letter that takes a value takes the
    // rest of the cluster or the next word; `takes` lists every letter that does, writing or not.
    const valued = (short: readonly string[], long: readonly string[], takes = '', into = paths) => {
        for (let index = 0; index < args.length; index++) {
            const arg = args[index]!
            if (arg === '--') break
            const equals = arg.indexOf('=')
            if (arg.startsWith('--') && equals > 0 && long.includes(arg.slice(0, equals))) into.push(arg.slice(equals + 1))
            else if (long.includes(arg) || short.includes(arg)) { if (args[index + 1] !== undefined) into.push(args[++index]!) }
            else if (/^-[^-]/.test(arg)) {
                const letters = arg.slice(1)
                const at = [...letters].findIndex(letter => short.includes(`-${letter}`) || takes.includes(letter))
                if (at < 0 || !short.includes(`-${letters[at]}`)) continue
                const value = letters.slice(at + 1)
                if (value) into.push(value)
                else if (args[index + 1] !== undefined) into.push(args[++index]!)
            }
        }
    }
    if (git && ['diff', 'log', 'show', 'format-patch', 'range-diff'].includes(git.verb)) valued(git.verb === 'format-patch' ? ['-o'] : [], ['--output', '--output-directory'])
    else if (name === 'curl') {
        valued(['-o', '-D', '-c'], ['--output', '--output-dir', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--hsts',
            '--alt-svc', '--libcurl'], 'AbCdeEFHKmQrtTuwxXyYz')
        // `-w '%output{file}'` sends the rest of the write-out text to a file, server content or not.
        const writeOuts: string[] = []
        valued(['-w'], ['--write-out'], 'AbCdeEFHKmoQrtTuxXyYzDc', writeOuts)
        for (const text of writeOuts) for (const match of text.matchAll(/%output\{(?:>>)?([^}]*)\}/g)) paths.push(match[1]!)
        // `#1` takes text from a URL glob, which may hold a slash, so the write lands anywhere below the template's directory.
        const globbed = !args.some(arg => arg === '-g' || arg === '--globoff') && args.some(arg => URL_OPERAND.test(arg) && /[[{]/.test(arg))
        for (const [at, path] of paths.entries()) if (globbed && /#\d/.test(path)) { covered.push(posix.dirname(path.slice(0, path.search(/#\d/)) + 'x')); paths[at] = '' }
    } else if (name === 'wget') valued(['-O', '-o', '-a'], ['--output-document', '--output-file', '--append-output'], 'ABDeiIlPQRtTUwX')
    else if (name === 'sort') valued(['-o'], ['--output'], 'kStT')
    else if (name === 'base64') valued(['-o'], ['--output'], 'biw')
    else if (name === 'sed' || name === 'perl') {
        const inPlace = args.some(arg => /^-[a-zA-Z]*i/.test(arg) && !arg.startsWith('--') || arg.startsWith('--in-place'))
        if (!inPlace) return undefined
        // Every operand after the script is a file edited in place; the script is the first operand
        // unless -e or -f named it, and perl's -e takes the next word.
        const operands: string[] = []
        let scripted = false
        for (let index = 0; index < args.length; index++) {
            const arg = args[index]!
            if (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file' || /^-[a-zA-Z]*e$/.test(arg) && name === 'perl') { scripted = true; index++ }
            else if (!arg.startsWith('-')) operands.push(arg)
        }
        paths.push(...scripted ? operands : operands.slice(1))
    } else return undefined
    // Writing to these discards or forwards output, so they name no file.
    const written = paths.filter(path => path && !['/dev/null', '/dev/stdout', '/dev/stderr'].includes(path))
    return written.length || covered.length ? { cwd: git?.cwd ?? invocation.cwd, paths: written, covered } : undefined
}

const URL_OPERAND = /^[a-z][a-z0-9+.-]*:\/\//i
// A descriptor names no file in a tree: `<(…)` hands its command a pipe whose commands are judged on their own, and any
// other descriptor was opened by a redirect, judged as a read or a write.
const descriptor = (path: string) => /^\/dev\/fd\/\d+$/.test(path)
/**
 * Where a download that names its own file writes: `curl -O` and a `wget` without `-O` use the URL's
 * last path segment in the working directory, curl's `--output-dir` or wget's `-P`. `paths` are those
 * files; `directories` are where a server-chosen name (`-J`, `--content-disposition`, a URL glob) or a
 * recursive download (`wget -r`, `-m`, `-x`) lands anywhere below, judged with what they hold.
 */
function downloadWrites(invocation: ParsedInvocation): { readonly paths: readonly string[]; readonly directories: readonly string[] } | undefined {
    const name = posix.basename(invocation.executable ?? '')
    const args = invocation.argv
    const value = (options: readonly string[]) => {
        for (const [at, arg] of args.entries()) {
            if (options.includes(arg)) return args[at + 1]
            const attached = options.find(option => option.startsWith('--') ? arg.startsWith(`${option}=`) : arg.startsWith(option) && arg.length > option.length)
            if (attached) return arg.slice(attached.length + (attached.startsWith('--') ? 1 : 0))
        }
        return undefined
    }
    const urls = args.filter(arg => URL_OPERAND.test(arg))
    // The last segment of the URL's path, as curl and wget name the file; a glob or an empty one leaves the name to the server.
    const named = (url: string, empty: string | undefined) => {
        const segment = url.replace(/[?#].*$/, '').replace(URL_OPERAND, '').split('/').slice(1).at(-1) ?? ''
        return /[[\]{}]/.test(segment) ? undefined : segment || empty
    }
    if (name === 'curl') {
        const remote = args.some(arg => /^(?:--remote-name(?:-all)?|--remote-header-name)$/.test(arg) || /^-[a-zA-Z]*[OJ][a-zA-Z]*$/.test(arg))
        if (!remote) return undefined
        const directory = value(['--output-dir']) ?? '.'
        const header = args.some(arg => arg === '--remote-header-name' || /^-[a-zA-Z]*J/.test(arg))
        const names = urls.map(url => named(url, undefined))
        return header || !urls.length || names.some(item => item === undefined) ? { paths: [], directories: [directory] }
            : { paths: names.map(item => posix.join(directory, item!)), directories: [] }
    }
    if (name !== 'wget' || value(['-O', '--output-document']) !== undefined || args.some(arg => /^-[a-zA-Z]*O/.test(arg) && !arg.startsWith('-n'))) return undefined
    const directory = value(['-P', '--directory-prefix']) ?? '.'
    const recursive = args.some(arg => ['--recursive', '--mirror', '--force-directories', '--page-requisites', '--content-disposition', '--trust-server-names'].includes(arg)
        || /^-[a-zA-Z]*[rmxp]/.test(arg) && !arg.startsWith('-n'))
    const names = urls.map(url => named(url, 'index.html'))
    return recursive || !urls.length || names.some(item => item === undefined) ? { paths: [], directories: [directory] }
        : { paths: names.map(item => posix.join(directory, item!)), directories: [] }
}

/** A shell glob as a regular expression over one name: `*` and `?` stay within it, and `[…]` is a class. */
function globExpression(pattern: string): RegExp {
    return new RegExp(`^${pattern.split(/(\*+|\?|\[[^\]]*\])/).map((part, at) => at % 2
        ? part.startsWith('*') ? '.*' : part === '?' ? '.' : part : part.replace(/[.+^${}()|\\]/g, '\\$&')).join('')}$`)
}

/**
 * Where gh writes what it downloads or clones: `gh release download` writes each asset under its own
 * name, or the `-p` patterns', into `-D` (the working directory by default); `gh run download` extracts
 * artifacts anywhere below `-D`; `gh repo clone` and `gh gist clone` create their directory.
 */
function ghDownloads(invocation: ParsedInvocation): { readonly clones: readonly string[]; readonly directory?: { readonly path: string; readonly patterns: readonly string[] | null; readonly recursive: boolean } } | undefined {
    if (posix.basename(invocation.executable ?? '') !== 'gh') return undefined
    const args = invocation.argv
    const valued = ['-R', '--repo', '-D', '--dir', '-p', '--pattern', '-O', '--output', '-n', '--name', '-A', '--archive', '-u', '--upstream-remote-name']
    const values = (options: readonly string[]) => args.flatMap((arg, at) => options.includes(arg) ? [args[at + 1] ?? ''] : options.flatMap(option => arg.startsWith(`${option}=`) ? [arg.slice(option.length + 1)] : []))
    const end = args.indexOf('--')
    const operands = (end < 0 ? args : args.slice(0, end)).filter((arg, at, list) => !arg.startsWith('-') && !valued.includes(list[at - 1] ?? ''))
    const [group, verb, ...rest] = operands
    if ((group === 'repo' || group === 'gist') && verb === 'clone' && rest[0] !== undefined) {
        return { clones: [rest[1] ?? posix.basename(rest[0]).replace(/\.git$/, '')] }
    }
    if (group === 'repo' && verb === 'fork' && args.some(arg => /^--clone(?:=true)?$/.test(arg))) {
        return { clones: [rest[0] === undefined ? '.' : posix.basename(rest[0]).replace(/\.git$/, '')] }
    }
    if (!['release', 'run'].includes(group ?? '') || verb !== 'download') return undefined
    const path = values(['-D', '--dir']).at(-1) ?? '.'
    const patterns = group === 'release' && !values(['-A', '--archive']).length ? values(['-p', '--pattern']) : []
    return { clones: [], directory: { path, patterns: patterns.length ? patterns : null, recursive: group === 'run' } }
}

/** The file `gunzip`, `gzip -d`, `unxz`, `xz -d` or `bunzip2` writes for each compressed operand: its name without the suffix. */
function decompressedWrites(invocation: ParsedInvocation): readonly string[] {
    const name = posix.basename(invocation.executable ?? '')
    const options = invocation.argv.filter(arg => arg.startsWith('-'))
    const decompresses = ['gunzip', 'unxz', 'bunzip2', 'unlzma'].includes(name) || ['gzip', 'xz', 'bzip2'].includes(name)
        && options.some(arg => arg === '--decompress' || arg === '--uncompress' || /^-[a-zA-Z]*d/.test(arg) && !arg.startsWith('--'))
    // `-c` writes to standard output and `-l`/`-t` only list or test.
    if (!decompresses || options.some(arg => /^-[a-zA-Z]*[clt]/.test(arg) && !arg.startsWith('--') || ['--stdout', '--to-stdout', '--list', '--test'].includes(arg))) return []
    return invocation.argv.filter(arg => !arg.startsWith('-')).flatMap(arg => {
        const match = /^(.*?)(?:\.(?:gz|z|xz|lzma|bz2|tbz2?|tgz|txz))$/i.exec(arg)
        return match && match[1] ? [/\.t(?:gz|xz|bz2?)$/i.test(arg) ? `${match[1]}.tar` : match[1]] : []
    })
}

// Git verbs whose output can be committed file content; the read-only profile proves the forms it can.
const GIT_CONTENT_VERBS = new Set(['grep', 'blame', 'annotate', 'show', 'diff', 'log', 'cat-file', 'archive', 'format-patch', 'whatchanged', 'range-diff'])

function gitPrintsContent(git: GitInvocation | undefined): boolean {
    return git !== undefined && (GIT_CONTENT_VERBS.has(git.verb) || git.verb === 'stash' && git.args[0] === 'show')
}

/** The `-c` keys before a Git verb, and whether any other global option than `-C` and paging appears. */
function gitGlobalOptions(argv: readonly string[]): { readonly keys: readonly string[]; readonly other: boolean } {
    const keys: string[] = []
    let other = false
    for (let index = 0; index < argv.length && argv[index]!.startsWith('-'); index++) {
        const option = argv[index]!
        if (option === '--') break
        if (option === '-C') index++
        else if (option === '-c') { const value = argv[++index]; if (value === undefined) other = true; else keys.push(value.split('=')[0]!) }
        else if (!['--no-pager', '--paginate', '--no-optional-locks'].includes(option)) other = true
    }
    return { keys, other }
}

/**
 * Whether an invocation names the cockpit CLI, however it is launched: by name, or by any path that
 * leads into one of `packages`, the installed package's directories, however it is spelled.
 */
export function cockpitShaped(invocation: ParsedInvocation, packages: readonly string[]): boolean {
    const installed = packages.map(fold)
    // Any word: launchers take options before the program (`pnpm --silent exec cockpit`, `node --no-warnings
    // …/cockpit.mjs`), and sync writes `cockpit:*` package scripts that run it by name. A path is resolved and
    // folded, so `@b00dea/./cockpit`, `@B00DEA/cockpit` and `cockpit/dist/cli.js` from `node_modules/@b00dea` count.
    return [invocation.executable ?? '', ...invocation.argv].some(word => ['cockpit', 'cockpit.mjs'].includes(posix.basename(word))
        || word.includes('@b00dea/cockpit') || word.startsWith('cockpit:')
        || [word, word.slice(word.indexOf('=') + 1)].some(path => path.includes('/') && installed.some(directory => within(fold(posix.resolve(invocation.cwd, path)), directory))))
}

// Commands that print a credential without naming a file. Matched by their leading words, after
// Git's own global options.
const CREDENTIAL_PRINTERS: ReadonlyArray<readonly string[]> = [['gh', 'auth', 'token'], ['gh', 'auth', 'git-credential'],
    ['aws', 'configure', 'export-credentials'], ['aws', 'sts', 'get-session-token'], ['aws', 'sts', 'assume-role'], ['aws', 'sts', 'assume-role-with-web-identity'],
    ['aws', 'sts', 'assume-role-with-saml'], ['aws', 'sts', 'get-federation-token'], ['aws', 'sso', 'get-role-credentials'], ['aws', 'ecr', 'get-login-password'],
    ['gcloud', 'auth', 'print-access-token'], ['gcloud', 'auth', 'print-identity-token'], ['gcloud', 'auth', 'application-default', 'print-access-token'],
    ['gcloud', 'config', 'config-helper'], ['az', 'account', 'get-access-token'], ['git', 'remote', 'show'],
    ['op', 'read'], ['op', 'item', 'get'], ['pass', 'show'], ['docker', 'compose', 'config'], ['docker-compose', 'config']]

/** Whether an invocation prints a remote URL Git has configured: `git remote -v`, `git remote get-url` and `git ls-remote --get-url`. */
function printsRemoteUrl(git: GitInvocation | undefined): boolean {
    // Git takes any unambiguous prefix of a long option: `--verb` is --verbose and `--g` is --get-url.
    const abbreviates = (word: string, option: string, shortest: number) => word.length >= shortest && option.startsWith(word)
    return git?.verb === 'remote' && (git.args[0] === 'get-url' || git.args.some(word => /^-v+$/.test(word) || abbreviates(word, '--verbose', 3)))
        || git?.verb === 'ls-remote' && git.args.some(word => abbreviates(word, '--get-url', 3))
}

/** Whether an invocation prints a credential without naming a file. */
function printsCredential(invocation: ParsedInvocation, git: GitInvocation | undefined): boolean {
    if (invocation.executable === null) return false
    const words = git ? ['git', git.verb, ...git.args] : [posix.basename(invocation.executable), ...invocation.argv]
    if (CREDENTIAL_PRINTERS.some(prefix => prefix.every((word, index) => words[index] === word))) return true
    const [program, first, second, ...rest] = words
    // Git's credential helpers, `git credential` and its `git-credential-*` programs, print what they store, as Docker's do.
    if (program === 'git' && first?.startsWith('credential') || /^(?:git|docker)-credential(?:-|$)/.test(program ?? '')) return true
    // `git var -l` prints every configuration value, remote URLs and http headers included.
    if (program === 'git' && first === 'var' && [second, ...rest].includes('-l')) return true
    if (program === 'gh' && first === 'auth' && second === 'status') return rest.some(word => word === '--show-token' || /^-[a-zA-Z]*t/.test(word))
    if (program === 'kubectl' && first === 'config' && second === 'view') return rest.some(word => word === '--raw' || word === '--flatten')
    // `docker compose config` interpolates the environment files it reads.
    if (program === 'docker' && first === 'compose' && invocation.argv.includes('config')) return true
    // Reading a named setting prints it; only the names that hold a secret are refused.
    if (program === 'aws' && first === 'configure' && second === 'get') return rest.some(word => /secret|token|session/i.test(word))
    if (program === 'npm' && first === 'config' && second === 'get') return rest.some(word => /_auth|_password|token/i.test(word))
    // `-g` prints the attributes and the password, `-w` the password alone, also bundled as `-gw` or `-ga`.
    return program === 'security' && /^find-(?:generic|internet)-password$/.test(first ?? '') && [second, ...rest].some(word => word !== undefined && /^-[a-zA-Z]*[gw]/.test(word))
}

// A live payment secret or restricted key, as the payment processor issues it: a pasted one lands in shell
// history and transcripts. Test keys of the same shape reach only test data.
const LIVE_SECRET_KEY = /(?<![A-Za-z0-9])[sr]k_live_[A-Za-z0-9]{24,}/

// Names a glob is tried against: a pattern that can match one of them may reach a secret.
const SECRET_SAMPLES = ['.env', '.env.local', '.env.production', '.secrets', 'id_rsa', 'id_ed25519', 'credentials', 'server.pem', 'server.key', '.npmrc', '.netrc',
    '.pgpass', 'auth.json', 'hosts.yml', '.git-credentials', '.vault-token']

// A variable name read as words split at `_`: any of these words marks it as a secret, and so does a
// name holding a password, token or secret anywhere (`PGPASSWORD`). A connection string (`*_DSN`,
// `*_URI`) carries its password. `PATH`, `PWD`, `KEYWORD` and `SSH_AUTH_SOCK` stay readable.
const SECRET_NAME_WORDS = new Set(['TOKEN', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD', 'PASS', 'PAT', 'KEY', 'APIKEY', 'CREDENTIAL', 'CREDENTIALS', 'PRIVATE', 'PWD', 'DSN', 'URI'])
const secretVariable = (name: string) => {
    const upper = name.toUpperCase()
    return upper === 'DATABASE_URL' || /PASSWORD|PASSWD|TOKEN|SECRET/.test(upper) || !['PWD', 'OLDPWD'].includes(upper) && upper.split('_').some(word => SECRET_NAME_WORDS.has(word))
}

/** Whether an invocation prints the environment or a secret-named variable. */
function dumpsEnvironment(invocation: ParsedInvocation): boolean {
    const program = posix.basename(invocation.executable ?? '')
    const argv = invocation.argv
    const options = argv.filter(arg => arg.startsWith('-'))
    const names = argv.filter(arg => !arg.startsWith('-'))
    const referenced = (word: string) => [...word.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]!)
    if (program === 'printenv') return names.length === 0 || names.some(secretVariable)
    if (program === 'env' || program === 'set') return argv.length === 0
    // Bare, or with only flags that print: `export -p`, `declare -x`, `typeset -p`, `readonly`; and `-p` with a secret's name prints that one.
    if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(program)) return names.length === 0 && options.every(arg => /^-[xprgaAfFi]*$/.test(arg))
        || options.some(arg => /^-[a-zA-Z]*p/.test(arg)) && names.some(secretVariable)
    // npm's built-in `env` script, which yarn and pnpm run as well, prints the whole environment.
    if (['npm', 'yarn', 'pnpm'].includes(program)) return ['run', 'run-script'].includes(argv[0] ?? '') && argv[1] === 'env'
    // `make -p` prints its database, every environment variable included; -C, -f, -I, -j, -l, -o, -W and -E take a value.
    if (program === 'make') return argv.some(arg => arg === '--print-data-base' || /^-[a-zA-Z]+$/.test(arg) && /^[^CfIjloWE]*p/.test(arg.slice(1)))
    if (['awk', 'gawk', 'mawk', 'nawk'].includes(program)) return argv.some(arg => arg.includes('ENVIRON'))
    // gh's jq filter reads its own environment, the token included, through `env` and `$ENV`.
    if (program === 'gh') return argv.some((arg, at) => (['-q', '--jq'].includes(argv[at - 1] ?? '') || /^--jq=/.test(arg)) && /\benv\b|\$ENV\b/.test(arg))
    // BSD `ps e` and macOS `ps -E` print each process's environment.
    // A bare letter cluster is BSD syntax; a word after -o, -p and the like is that option's value.
    if (program === 'ps') return argv.some((arg, at) => /^[A-Za-z]+$/.test(arg) && arg.includes('e') && !/^-[A-Za-z]*[oOpqUuGgtk]$/.test(argv[at - 1] ?? '')
        || /^-[A-Za-z]*E/.test(arg))
    if (['echo', 'printf'].includes(program)) return invocation.words.some(word => word.role === 'argument' && referenced(word.value).some(secretVariable))
    return false
}

// Programs that write their operands, or a destination operand, without the guard modelling which
// one: every operand outside the roots is judged as a write.
const OUTSIDE_WRITERS = new Set(['rsync', 'ditto', 'scp', 'patch', 'uniq', 'split', 'cpio', 'sponge', 'zip', 'gzip', 'gunzip', 'bunzip2', 'xz', 'unxz', 'csplit'])
// Git verbs whose operand is a directory or file they create.
const GIT_CREATES = new Set(['clone', 'init', 'worktree', 'bundle'])

/** Local paths an outside writer names: not options, URLs or `host:path` remote spellings. */
function writerOperands(invocation: ParsedInvocation, git: GitInvocation | undefined): { readonly cwd: string; readonly paths: readonly string[] } | undefined {
    const local = (word: string) => !word.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(word) && !/^[^/]*:/.test(word)
    if (git && GIT_CREATES.has(git.verb)) {
        const operands = git.args.filter(local)
        const paths = git.verb === 'clone' ? operands.slice(1) : git.verb === 'worktree' ? (operands[0] === 'add' ? operands.slice(1, 2) : [])
            : git.verb === 'bundle' ? (operands[0] === 'create' ? operands.slice(1, 2) : []) : operands.slice(0, 1)
        return { cwd: git.cwd, paths }
    }
    if (invocation.executable === null || !OUTSIDE_WRITERS.has(posix.basename(invocation.executable))) return undefined
    return { cwd: invocation.cwd, paths: invocation.argv.filter(local) }
}

// Options that name a program for Git to run on either side of a transfer.
function gitProgramOption(git: GitInvocation): boolean {
    // A template directory holds hooks the new repository then runs.
    if (['init', 'clone'].includes(git.verb) && git.args.some(arg => /^--template(?:=|$)/.test(arg))) return true
    if (!['fetch', 'pull', 'push', 'send-pack', 'clone', 'ls-remote', 'archive', 'submodule', 'remote'].includes(git.verb)) return false
    return git.args.some(arg => /^--(?:upload-pack|receive-pack|exec)(?:=|$)/.test(arg) || ['clone', 'ls-remote'].includes(git.verb) && arg === '-u')
}

// Git's location and configuration variables point it at state or programs the guard does not inspect,
// HOME and XDG_CONFIG_HOME choose the configuration that names hooks, hook managers' switches skip the
// hooks, a relative PATH entry runs a file the agent wrote, Docker's choose the daemon (any host, or
// one reached over ssh) and the client configuration a known docker read uses, and the agent tools'
// session markers are how a person's terminal confirmation tells itself apart from an agent's.
function steers({ name, value }: { readonly name?: string; readonly value: string }): boolean {
    return name === undefined || /^(?:GIT_.*|DOCKER_.*|HOME|XDG_CONFIG_HOME|BASH_ENV|ENV|HUSKY.*|SKIP|LEFTHOOK.*|OVERCOMMIT_DISABLE|PRE_COMMIT_ALLOW_NO_CONFIG|CLAUDECODE|CODEX_THREAD_ID|OPENCODE)$/.test(name)
        || name === 'PATH' && value.split(':').some(entry => !entry.startsWith('/'))
}

// Programs that run the file named as their first operand.
const SCRIPT_RUNNERS = new Set(['bash', 'sh', 'zsh', 'node', 'nodejs', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun', 'tsx', 'ts-node'])

/** The file an invocation runs: a program spelled as a path, or the script a shell or interpreter is given. */
function executedFile(invocation: ParsedInvocation): string | undefined {
    if (invocation.executable === null) return undefined
    if (invocation.executable.includes('/')) return posix.resolve(invocation.cwd, invocation.executable)
    if (!SCRIPT_RUNNERS.has(posix.basename(invocation.executable))) return undefined
    // `deno run` and `bun run` name the script after their verb.
    const operands = invocation.argv.filter(arg => !arg.startsWith('-'))
    const script = ['run', 'exec'].includes(operands[0] ?? '') ? operands[1] : operands[0]
    return script === undefined ? undefined : posix.resolve(invocation.cwd, script)
}

/** The patch files `git apply` or `git am` applies, none for a mode that writes nothing, or null when the targets cannot be read from them. */
function appliedPatches(git: GitInvocation): readonly string[] | null {
    const options = git.args.filter(arg => arg.startsWith('-'))
    if (git.verb === 'am' && options.some(arg => /^--(?:continue|skip|abort|quit|resolved|retry|show-current-patch|allow-empty)/.test(arg))) return []
    if (git.verb === 'apply' && options.some(arg => /^--(?:check|stat|numstat|summary)$/.test(arg)) && !options.some(arg => /^(?:--apply|--index|--cached|--3way|-3)$/.test(arg))) return []
    if (options.some(arg => /^(?:--directory|--unsafe-paths|-p(?!1$))/.test(arg))) return null
    const files = git.args.filter(arg => !arg.startsWith('-'))
    return files.length ? files : null
}

/** The local source trees an archiver, copier or recursive diff reads, or undefined for any other command. */
function sourceTrees(invocation: ParsedInvocation): readonly string[] | undefined {
    const name = posix.basename(invocation.executable ?? '')
    const local = (word: string) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(word) && !/^[^/]*:/.test(word)
    const operands: string[] = []
    const valued = name === 'zip' ? ['-b', '-n', '-t', '-tt', '-P', '-O'] : name === 'diff' ? ['-x', '-X', '-I', '-F', '-L', '-S', '-C', '-U', '-D'] : name === 'rsync' ? ['-e', '--rsh', '--exclude', '--include', '--filter', '-f'] : name === 'scp' ? ['-i', '-o', '-P', '-F', '-c', '-l', '-J', '-S'] : []
    let options = true
    for (let index = 0; index < invocation.argv.length; index++) {
        const arg = invocation.argv[index]!
        if (options && arg === '--') { options = false; continue }
        if (options && arg.startsWith('-')) { if (valued.includes(arg)) index++; continue }
        operands.push(arg)
    }
    if (name === 'tar') return tarWrites(invocation.argv).sources
    // zip names its archive first; the others name their destination last.
    if (name === 'zip') return operands.slice(1)
    if (['rsync', 'scp', 'ditto'].includes(name)) return operands.slice(0, -1).filter(local)
    if (name === 'diff') return operands
    return undefined
}

// gh commands that publish a release, secret or variable, delete from the host, or start workflow runs, which spend CI minutes.
const GH_PUBLISHES = /^(?:run (?:rerun|delete)|workflow (?:run|enable|disable)|release (?:create|upload|edit|delete|delete-asset)|issue (?:delete|transfer)|cache delete|(?:secret|variable) (?:set|delete|remove)|gist delete|label delete)$/

/** A `gh api` call's endpoint, method, fields, and whether it writes: any method but GET, or a GraphQL mutation or query the guard cannot read. */
function ghApiCall(args: readonly string[]): { readonly endpoint: string; readonly method: string; readonly fields: readonly string[]; readonly writes: boolean } {
    let method: string | undefined
    let endpoint: string | undefined
    let input = false
    const fields: string[] = []
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (arg === '-X' || arg === '--method') method = args[++index]
        else if (/^-X./.test(arg)) method = arg.slice(2)
        else if (arg.startsWith('--method=')) method = arg.slice('--method='.length)
        else if (['-f', '-F', '--field', '--raw-field'].includes(arg)) fields.push(args[++index] ?? '')
        else if (/^-[fF]./.test(arg)) fields.push(arg.slice(2))
        else if (/^--(?:field|raw-field)=/.test(arg)) fields.push(arg.slice(arg.indexOf('=') + 1))
        else if (arg === '--input' || arg.startsWith('--input=')) { input = true; if (arg === '--input') index++ }
        else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(arg)) index++
        else if (!arg.startsWith('-')) endpoint ??= arg
    }
    const resolved = (method ?? (fields.length || input ? 'POST' : 'GET')).toUpperCase()
    const query = fields.find(field => field.startsWith('query='))
    const writes = endpoint === 'graphql' ? input || query === undefined || query.startsWith('query=@') || /\bmutation\b/.test(query) : !['GET', 'HEAD'].includes(resolved)
    return { endpoint: endpoint ?? '', method: resolved, fields, writes }
}

// Development tool families the allow default admits, judged by the guard's rules for them. Anything
// else asks; a person's [guards] allow rule can admit it.
const KNOWN_TOOLS = new Set([
    // Version control and its host.
    'git', 'gh',
    // Package managers and the runners that launch a program, which the parser then follows.
    'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'uv', 'uvx', 'pip', 'pip3', 'poetry', 'pipenv',
    // Languages and build and test tools running project files.
    'node', 'nodejs', 'python', 'python3', 'ruby', 'go', 'cargo', 'rustc', 'deno', 'make', 'tsc', 'tsx', 'ts-node', 'eslint', 'prettier', 'biome',
    'vitest', 'jest', 'mocha', 'playwright', 'pytest', 'ruff', 'mypy', 'turbo', 'nx', 'java', 'javac', 'gradle', 'mvn',
    // Shells running a script, or a `-c` string the parser judged command by command.
    'bash', 'sh', 'zsh',
    // Reading and text utilities.
    'cat', 'head', 'tail', 'rg', 'grep', 'fd', 'find', 'ls', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'jq', 'yq', 'stat', 'file', 'tree',
    'which', 'type', 'command', 'echo', 'printf', 'test', '[', 'true', 'false', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'sleep',
    'pwd', 'ps', 'shasum', 'sha256sum', 'md5', 'md5sum', 'du', 'df', 'uname', 'whoami', 'id', 'hostname', 'seq', 'xxd', 'od', 'awk', 'sed',
    // Shell builtins that set or show shell state.
    'export', 'declare', 'typeset', 'readonly', 'local', 'unset', 'set', 'setopt', 'printenv', 'env',
    // File utilities, judged as writes inside the roots.
    'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'touch', 'ln', 'tee', 'chmod', 'truncate', 'install', 'dd', 'rimraf', 'del-cli', 'trash',
    // Archives and copies, judged by their operands.
    'zip', 'tar', 'rsync', 'scp', 'unzip', 'gzip', 'gunzip',
    // Process and port inspection, and signals to processes the agent started.
    'lsof', 'kill', 'pkill', 'base64',
    // Formatters, linters and runners of project code in other languages; `bundle exec` is followed to the program it runs.
    'gofmt', 'golangci-lint', 'rustup', 'bundle', 'rspec', 'rake', 'pre-commit',
    // A static checker that only reads the scripts it is given.
    'shellcheck',
    // Downloads, judged by their hosts and output options.
    'curl', 'wget',
    // cockpit's own CLI, judged by its command table.
    'cockpit', 'cockpit.mjs',
])
// How each interpreter takes code that is not a file: `inline` options carry it on the command line,
// `values` take the next word (a `--require` of a data: or http: URL is code too), and `script` options
// name what runs instead of a file. With no script operand, or `-`, the interpreter runs standard input.
interface InterpreterOptions { readonly inline: RegExp; readonly values: readonly string[]; readonly attached?: RegExp; readonly script?: RegExp; readonly info: RegExp }
const NODE_OPTIONS: InterpreterOptions = { inline: /^(?:-e|-p|--eval|--print)(?:=|$)|^-[a-zA-Z]*[ep]$/,
    values: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--env-file-if-exists', '--title',
        '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--watch-path', '--inspect-port', '--redirect-warnings', '--disable-warning'],
    script: /^--(?:test|run)(?:=|$)/, info: /^(?:-v|--version|-h|--help|--v8-options)$/ }
const PYTHON_OPTIONS: InterpreterOptions = { inline: /^-[a-zA-Z]*c/, values: ['-X', '-W', '-m'], attached: /^-[XW]./, script: /^-m/, info: /^(?:-V|--version|-h|--help)$/ }
const INTERPRETER_OPTIONS: Readonly<Record<string, InterpreterOptions>> = {
    node: NODE_OPTIONS, nodejs: NODE_OPTIONS, python: PYTHON_OPTIONS, python3: PYTHON_OPTIONS,
    ruby: { inline: /^-[a-zA-Z]*e/, values: ['-I', '-r', '-C', '-E'], attached: /^-[IrCEF]./, info: /^(?:-v|--version|-h|--help)$/ },
}

/** Whether an interpreter runs code given on its command line, through a data or remote URL, or on standard input. */
function interpreterCode(options: InterpreterOptions, argv: readonly string[]): boolean {
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!
        if (arg === '--') return argv[index + 1] === undefined || argv[index + 1] === '-'
        if (arg === '-') return true
        if (!arg.startsWith('-')) return false
        if (options.info.test(arg)) return false
        if (options.attached?.test(arg)) continue
        if (options.inline.test(arg)) return true
        const [option, attached] = arg.split(/=(.*)/s)
        if (options.values.includes(option!)) {
            const value = attached ?? argv[++index]
            if (value === undefined || /^(?:data|https?):/i.test(value)) return true
            if (options.script?.test(option!)) return false
        } else if (options.script?.test(arg)) return false
    }
    return true
}

// A descriptor or standard input as a file, however it is spelled: what a `<(…)` or pipe produced, which the guard never read.
const pipedFile = (cwd: string, word: string) => /^\/(?:dev\/(?:fd\/\d+|stdin)|proc\/self\/fd\/\d+)$/.test(posix.resolve(cwd, word))

/** Whether a known tool runs code the guard cannot read: inline code, a program an option names, or a script on standard input. */
function runsUnreadCode(invocation: ParsedInvocation): boolean {
    const name = posix.basename(invocation.executable ?? '')
    const argv = invocation.argv
    // A script runner takes its script, a module it preloads or a configuration file from any word, an option's value
    // included, so a word naming a pipe is code wherever it stands.
    if (SCRIPT_RUNNERS.has(name) && argv.some(arg => pipedFile(invocation.cwd, arg.slice(arg.indexOf('=') + 1)))) return true
    // make, awk and sed run the program file -f names.
    if (['make', 'awk', 'gawk', 'mawk', 'nawk', 'sed'].includes(name) && argv.some((arg, at) => /^(?:-f|--file|--makefile)$/.test(argv[at - 1] ?? '') && pipedFile(invocation.cwd, arg)
        || pipedFile(invocation.cwd, /^(?:-f|--file=|--makefile=)(.+)$/.exec(arg)?.[1] ?? ''))) return true
    const interpreter = INTERPRETER_OPTIONS[name]
    if (interpreter) return interpreterCode(interpreter, argv)
    if (name === 'bun') return argv.some(arg => /^(?:-e|--eval|-p|--print)(?:=|$)/.test(arg))
    if (name === 'deno') return argv[0] === 'eval'
    // awk runs commands through system(), getline and pipes, and print or printf can redirect to any file.
    if (name === 'awk') return argv.some(arg => /system|getline|\||\bprintf?\b[^;}\n]*>/.test(arg))
    // sed's `e` runs a command and `w` writes a file, as a command or as an `s` flag.
    if (name === 'sed') return argv.some(arg => /(?:^|;|\s)\d*[ew]\b|\/e\b|\/[gpiImM0-9]*[we](?:\s|;|$)/.test(arg))
    // `find -exec` runs a program per match.
    if (name === 'find') return argv.some(arg => /^-(?:exec|execdir|ok|okdir)$/.test(arg))
    if (name === 'make') return argv.some((arg, at) => /^--eval(?:=|$)|^-E/.test(arg) || ['-f', '--file', '--makefile'].includes(argv[at - 1] ?? '') && arg === '-'
        || /^(?:-f|--file=|--makefile=)-$/.test(arg))
    if (name === 'go') return argv.some(arg => /^--?(?:exec|toolexec|vettool)(?:=|$)/.test(arg))
    if (name === 'rsync') return argv.some(arg => /^--rsh(?:=|$)|^-[a-zA-Z]*e/.test(arg))
    // scp runs the program -S names, and ssh options or a configuration file can name a command to run.
    if (name === 'scp') return argv.some((arg, at) => /^-[a-zA-Z]*[SF]/.test(arg) || /(?:Proxy|Local|KnownHosts)Command|PermitLocalCommand/i.test(arg) && (argv[at - 1] === '-o' || arg.startsWith('-o')))
    if (name === 'zip') return argv.some(arg => /^-TT|^--unzip-command(?:=|$)/.test(arg))
    if (name === 'shellcheck') return !shellcheckReads(argv)
    return false
}

/**
 * Whether `argv` is a shellcheck run that only reads and reports. Every option shellcheck lists is a flag or takes a
 * value; none writes a file or runs a program, but a word it does not list is not assumed to be harmless. File and
 * path values (`--rcfile`, `-P`) are judged as reads by the operand rules, like the scripts themselves. What a script
 * sources under `-x` is read by shellcheck as the script's own `source` lines direct, like a shell reading the script.
 */
function shellcheckReads(argv: readonly string[]): boolean {
    const flags = 'axV'
    const valued = 'iefoPsSW'
    const longFlags = /^--(?:check-sourced|external-sources|norc|list-optional|version|help|color(?:=\w+)?|extended-analysis=(?:true|false))$/
    const longValued = new Set(['--include', '--exclude', '--format', '--enable', '--source-path', '--shell', '--severity', '--wiki-link-count', '--rcfile'])
    for (let index = 0; index < argv.length; index++) {
        const word = argv[index]!
        if (word === '--') return true
        if (word === '-' || !word.startsWith('-')) continue
        if (word.startsWith('--')) {
            const [name, attached] = word.split(/=(.*)/s)
            if (longFlags.test(word)) continue
            if (!longValued.has(name!)) return false
            if (attached === undefined && argv[++index] === undefined) return false
            continue
        }
        // A short cluster such as `-xe SC1091`: flags, then at most one value option that takes the rest or the next word.
        for (let at = 1; at < word.length; at++) {
            const letter = word[at]!
            if (flags.includes(letter)) continue
            // `-C[WHEN]` only ever attaches its value.
            if (letter === 'C') break
            if (!valued.includes(letter)) return false
            if (at === word.length - 1 && argv[++index] === undefined) return false
            break
        }
    }
    return true
}

// Docker listings and reports that only read what the daemon holds about images and containers. Anything absent asks: a
// global option (-H, --host, --context, -c) or DOCKER_* variable points at another daemon the guard cannot see, `exec`
// and `run` execute, `pull`, `build` and `login` reach the network or the credential store, and `compose` can mount any
// host path. `docker inspect` and `container inspect` ask because a container's configuration carries the runtime
// environment, which can hold the secrets of an env file. `docker ps` without --no-trunc shows the shortened command only.
const DOCKER_LIST_OPTIONS = {
    flags: new Set(['-a', '--all', '-q', '--quiet', '-s', '--size', '-l', '--latest']),
    values: new Set(['-f', '--filter', '--format', '-n', '--last']),
}
const DOCKER_IMAGE_LIST_OPTIONS = { flags: new Set(['-a', '--all', '-q', '--quiet', '--digests', '--no-trunc']), values: new Set(['-f', '--filter', '--format']) }
// `-f` is --format here and --filter on the listings.
const DOCKER_REPORT_OPTIONS = { flags: new Set<string>(), values: new Set(['-f', '--format']), shortFormat: true as const }
// The top-level fields of `docker image inspect` that are the image's published identity: where it came from, what it is
// and how big. Config, ContainerConfig and the default output carry Env, which a local build can bake from ARG and ENV.
const DOCKER_IMAGE_IDENTITY = new Set(['Id', 'RepoTags', 'RepoDigests', 'Created', 'Size', 'Architecture', 'Os', 'Variant', 'Parent'])

/** Whether a `docker image inspect` template reads only identity fields: no root value, no variable, no other field. */
function dockerIdentityTemplate(template: string): boolean {
    const actions = [...template.matchAll(/\{\{(.*?)\}\}/gs)].map(match => match[1]!)
    if (actions.length === 0 || actions.join('{{').includes('}}')) return false
    return actions.every(action => {
        const fields = [...action.matchAll(/(?<![\w"$])\.([A-Za-z_]\w*)((?:\.\w+)*)/g)]
        // A bare `.` or `$` is the whole image, and a quoted name can be indexed into it.
        return fields.length > 0 && !/(?:^|[\s(|])\.(?![A-Za-z_])|\$|"|'|`/.test(action) && fields.every(field => DOCKER_IMAGE_IDENTITY.has(field[1]!) && field[2] === '')
    })
}

function dockerArguments(argv: readonly string[], table: { readonly flags: ReadonlySet<string>; readonly values: ReadonlySet<string>; readonly shortFormat?: true }): { operands: string[]; format: string | undefined } | undefined {
    const operands: string[] = []
    let format: string | undefined
    for (let index = 0; index < argv.length; index++) {
        const word = argv[index]!
        if (!word.startsWith('-') || word === '-') { operands.push(word); continue }
        const [name, attached] = word.split(/=(.*)/s)
        if (table.flags.has(word)) continue
        if (!table.values.has(name!)) return undefined
        const value = attached ?? argv[++index]
        if (value === undefined) return undefined
        if (name === '--format' || name === '-f' && table.shortFormat) format = value
    }
    return { operands, format }
}

/** Whether a docker invocation is one of the read-only queries above. */
function dockerReads(invocation: ParsedInvocation): boolean {
    // DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG and the TLS variables redirect the client; an unnamed assignment could be any.
    if (invocation.words.some(word => word.role === 'environment-assignment-value' && (word.name === undefined || /^DOCKER_/i.test(word.name)))) return false
    const [first, second, ...rest] = invocation.argv
    if (first === undefined || first.startsWith('-')) return false
    if (first === 'ps' || first === 'container' && (second === 'ls' || second === 'list' || second === 'ps')) {
        return dockerArguments(first === 'ps' ? invocation.argv.slice(1) : rest, DOCKER_LIST_OPTIONS) !== undefined
    }
    if (first === 'images' || first === 'image' && (second === 'ls' || second === 'list')) {
        return dockerArguments(first === 'images' ? invocation.argv.slice(1) : rest, DOCKER_IMAGE_LIST_OPTIONS) !== undefined
    }
    // `info` stays out: it reports the daemon's proxy settings, whose URLs can carry credentials.
    if (first === 'version') return dockerArguments(invocation.argv.slice(1), DOCKER_REPORT_OPTIONS)?.operands.length === 0
    if (first === 'image' && second === 'inspect') {
        const parsed = dockerArguments(rest, DOCKER_REPORT_OPTIONS)
        return parsed !== undefined && parsed.operands.length > 0 && parsed.format !== undefined && dockerIdentityTemplate(parsed.format)
    }
    return false
}

/** Whether an invocation is a development tool the allow default admits, or a program inside the roots. */
function knownTool(invocation: ParsedInvocation, roots: readonly string[]): boolean {
    if (invocation.executable === null) return true
    const name = posix.basename(invocation.executable)
    // A program spelled as a path inside the roots is the project's own, like a file node runs.
    const project = invocation.executable.includes('/') && roots.some(root => within(posix.resolve(invocation.cwd, invocation.executable!), root))
    if (!project && name === 'docker') return dockerReads(invocation)
    if (!project && !KNOWN_TOOLS.has(name)) return false
    const [first, second] = invocation.argv
    // rustup changes the person's toolchains outside the roots unless it only reports.
    if (name === 'rustup') return /^(?:show|which|help|--version|-V)$/.test(first ?? '') || ['toolchain', 'component', 'target'].includes(first ?? '') && second === 'list'
    // kill signals the processes it names, never every process (-1, 0) or a process group (a negative pid).
    if (name === 'kill') return invocation.argv.length > 0 && invocation.argv.every((arg, at) => /^(?:[2-9]|[1-9]\d+|%\d+)$/.test(arg)
        || at === 0 && /^-(?:\d+|[A-Z][A-Z0-9]*|s)$/.test(arg) && arg !== '-1' || at === 1 && first === '-s' && /^[A-Z][A-Z0-9]*$/.test(arg))
    return !runsUnreadCode(invocation)
}

/** Whether `program` is the command the parser followed `launcher` with: its words end the launcher's. */
function launchedBy(program: ParsedInvocation, launcher: ParsedInvocation): boolean {
    if (program.executable === null || launcher.executable === null || program.cwd !== launcher.cwd) return false
    const own = [program.executable, ...program.argv]
    const spelled = [launcher.executable, ...launcher.argv]
    const ends = (words: readonly string[]) => own.length < words.length && own.every((word, at) => word === words[words.length - own.length + at])
    // npm drops the `--` that ends its options from the program's words.
    const separator = spelled.indexOf('--', spelled.length - own.length)
    return ends(spelled) || separator > 0 && ends(spelled.filter((_, at) => at !== separator))
}

/** Hard boundaries are independent of grants and are evaluated across the complete capture. */
/**
 * The guard's decision for one captured call. A command it would ask about also names the
 * `[[guards.allow]]` entries that would admit it, where some would, proved by judging the call again
 * with them; a background agent whose ask turns into a bare refusal then has something to propose.
 * Under `[guards] unresolved = "deny"` such an ask is refused, keeping its reason and that route.
 */
export function evaluateGuard(input: unknown, policy: unknown, inspect: PathInspection): GuardDecision {
    const decision = judgeGuard(input, policy, inspect)
    if (decision.decision !== 'ask' || !isParsedGuardInput(input)) return decision
    const resolved = capturePolicy(policy)!
    const entries = admittingAllowEntries(input, resolved, inspect)
    const configName = posix.basename(resolved.configPath)
    const proposed = entries.length ? ` A person can admit it for good by adding ${entries.length === 1 ? 'this entry' : 'these entries'} to ${configName} (one key per line) and running sync: ${entries.join(' ')}`
        : ''
    // A reason past the adapter's bound would turn the answer into a failure, so a long entry is left out.
    const route = Buffer.byteLength(decision.reason + proposed) <= 3_072 ? proposed : ''
    if (resolved.unresolved !== 'deny') return { decision: 'ask', reason: decision.reason + route }
    return deny(`${decision.reason}${route} [guards] unresolved = "deny" in ${configName} refuses what would wait for a person, so nobody is asked: take the route this names${route ? '' : ', such as a literal local target the guard can judge'}, or a person runs the command.`)
}

/** The fewest exact `[[guards.allow]]` entries, as TOML, that would admit every command in the call, or none. */
function admittingAllowEntries(input: Readonly<{ invocations: readonly ParsedInvocation[] }>, resolved: GuardEvaluationPolicy, inspect: PathInspection): readonly string[] {
    // A rule admits only what it spells: never a launched, wrapped or environment-changing command, nor one whose words the guard cannot see.
    const eligible = input.invocations.filter(invocation => invocation.executable !== null && !invocation.wrapped && !invocation.dynamic
        && !invocation.words.some(word => word.role === 'environment-assignment-value')
        && GuardCommandArgv.safeParse([invocation.executable, ...invocation.argv]).success)
    if (!eligible.length || eligible.length > 8 || resolved.declaredAllows.length + eligible.length > 64) return []
    // A rule's cwd is relative to the cockpit; a sibling's directory cannot be spelled there, so its rule names none.
    const rules = eligible.map(invocation => ({ argv: [invocation.executable!, ...invocation.argv], reason: 'Admitted by a person.',
        ...within(invocation.cwd, resolved.canonicalRoot) ? { cwd: invocation.cwd } : {} }))
    const admits = (chosen: readonly typeof rules[number][]) => judgeGuard(input, { ...resolved, declaredAllows: [...resolved.declaredAllows, ...chosen] }, inspect).decision === 'allow'
    let chosen = [...new Map(rules.map(rule => [JSON.stringify(rule), rule])).values()]
    if (!admits(chosen)) return []
    for (const rule of [...chosen]) {
        const without = chosen.filter(other => other !== rule)
        if (without.length && admits(without)) chosen = without
    }
    return chosen.map(rule => `[[guards.allow]] argv = [${rule.argv.map(word => JSON.stringify(word)).join(', ')}]${rule.cwd === undefined ? ''
        : ` cwd = ${JSON.stringify(posix.relative(resolved.canonicalRoot, rule.cwd) || '.')}`} reason = "<why it is safe>"`)
}

function judgeGuard(input: unknown, policy: unknown, inspect: PathInspection): GuardDecision {
    if (!isParsedGuardInput(input)) return unavailable('Guard input is unavailable or was not captured by the invocation parser.')
    const resolved = capturePolicy(policy)
    if (!resolved) return unavailable('Guard policy is incomplete or malformed.')
    if (input.tool.startsWith('mcp__')) {
        if (resolved.mcpAllowedTools === undefined) return unavailable('MCP tool policy is missing from the authenticated guard request.')
        for (const [server, allowed] of Object.entries(resolved.mcpAllowedTools)) {
            const prefix = `mcp__${server}__`
            // Claude Code calls a tool `read.record` by the native name `read_record`, the only name this hook receives.
            if (input.tool.startsWith(prefix) && !allowed.some(tool => input.tool === `${prefix}${tool.replaceAll('.', '_')}`)) {
                return deny(`MCP tool ${shownGuardWord(input.tool)} is outside the exact allowlist for ${server}. Fix: use a listed tool or have a person review [mcp.allowed_tools] and sync.`)
            }
        }
        return { decision: 'allow', reason: 'MCP tool satisfies the declared tool restrictions.' }
    }
    const absolute = (path: string) => `${resolved.canonicalRoot}/${path}`
    // A word leading into the installed package or a package it loads runs cockpit's own code.
    const cockpitCommand = (invocation: ParsedInvocation) => cockpitShaped(invocation, [...resolved.cockpitPackageDirectories ?? [], ...resolved.executionDirectories])
    const inRoots = (lexical: string) => resolved.allowedRoots.some(root => within(lexical, root))
    const secretRoot = absolute(SECRETS_ROOT)
    const controlFiles = GUARD_CONTROL_FILES.map(absolute)
    const controlDirectories = GUARD_CONTROL_DIRECTORIES.map(absolute)
    const identities = new Map(resolved.protectedIdentities.map((item) => [item.path, item]))
    const identityOf = (path: string) => identities.get(path)!.identity
    const chainOf = (path: string) => { const item = identities.get(path)!; return item.identity === null ? item.ancestors : [...item.ancestors, item.identity] }
    const secretDenial = deny('Refusing mutation or staging below a secrets directory.')
    const instanceDenial = deny('Refusing mutation or staging of a declared environment instance.')
    // `git add -A`, `git add .` and a directory operand stage everything below them.
    const coveringStageDenial = deny(`Refusing to stage a path that contains a secrets directory or a declared environment instance: \`git add -A\`, \`git add .\` and a directory operand stage everything below them. Stage the changed files by name instead.`)
    const controlDenial = deny('Refusing mutation of the guard, its hook registration or its ownership manifest.')
    const gitMetadataDenial = deny('Refusing direct mutation of Git metadata: its configuration chooses programs that read-only Git commands run.')
    const readDenial = deny('Refusing to read a declared environment instance or secrets directory into the agent context.')
    // A path `[guards] secret_paths` names is kept from agents as a `.secrets` directory is, at every spelling.
    const secretPaths = (resolved.secretPaths ?? []).map(fold)
    const inSecretPath = (folded: string) => secretPaths.some((path) => within(folded, path))
    const coversSecretPath = (folded: string) => secretPaths.some((path) => within(path, folded))
    const secretPathDenial = deny(`Refusing to read, write, search or stage a path [guards] secret_paths declares secret in ${posix.basename(resolved.configPath)}: it holds data agents are kept from, as an .env file is. Work with the files beside it, or a person handles it.`)
    // A checkout `[guards] related_checkouts` names is read and inspected, never changed, from this cockpit.
    const relatedCheckouts = (resolved.relatedCheckouts ?? []).map(fold)
    const inRelatedCheckout = (lexical: string) => relatedCheckouts.some((path) => within(fold(lexical), path))
    const relatedDenial = deny(`Refusing to change a checkout [guards] related_checkouts names in ${posix.basename(resolved.configPath)}: agents read it and run read-only Git there, such as \`git -C <checkout> log\`, status, diff or show, but write, commit, push or run anything else there only from a session started in that checkout.`)
    const writePaths = resolved.writePaths ?? []
    // Sync writes a guard script at `.cockpit/guards`, and a Codex session runs the one it finds above it,
    // so no agent writes such a path, nor a directory named `.cockpit` that one could be moved into, anywhere.
    const guardScriptLocation = (folded: string) => {
        const parts = folded.split('/')
        return parts.at(-1) === '.cockpit' || parts.some((part, at) => part === '.cockpit' && parts[at + 1] === 'guards')
    }
    const guardScriptDenial = deny('Refusing to write a path below .cockpit/guards, or a directory named .cockpit: cockpit sync writes the guard script there, and a Codex session runs the one it finds above it. Agents never write one.')
    // A file with another hard link is the same file under a name the guard may not protect: writing it
    // writes that one too, the guard's own code or a control included, however each name is spelled.
    const hardLinkDenial = deny('Refusing to write a file that has another hard link: the write changes every name of the file, and the guard cannot see the others. Write a new file instead, or a person removes the extra link.')
    // The invocation being judged writes files whose names it chooses itself, such as an extraction or a clone.
    let unseenMembers = false
    // Spellings a related checkout is declared under, with their missing ancestors: nothing is written there.
    const relatedReserved = (resolved.relatedReserved ?? []).map(fold)
    const reservedForRelated = (lexical: string) => relatedReserved.some((path) => within(fold(lexical), path))
    // A path spelled through /System/Volumes/Data or /Volumes reaches the cockpit, a related checkout or a write path
    // under a name every rule here compares against the plain spelling, so it is refused rather than judged twice.
    const aliasedLocation = (lexical: string) => {
        const stripped = guardFirmlinkStripped(lexical)
        if (stripped === lexical) return false
        const folded = fold(stripped)
        return [...resolved.allowedRoots, ...resolved.relatedCheckouts ?? [], ...relatedReserved, ...writePaths, ...resolved.secretPaths ?? []]
            .some((path) => within(folded, fold(path)))
    }
    const aliasDenial = (path: string) => deny(`Refusing ${shownGuardWord(path)}: it names the cockpit, a related checkout or a write path through /System/Volumes/Data or /Volumes, a second spelling the guard does not judge. Name the path from /, as the cockpit does.`)
    const templates = new Set(resolved.templates.map(fold))
    // Documentation by its name or by the configuration; the guard checks spellings it was given, folded.
    const documentation = (folded: string) => templates.has(folded) || DOTENV_DOCUMENTATION.has(posix.basename(folded))
    // An undeclared `.env` or `.env.*` file is where a product keeps the values its schema names, so
    // no tool reads or writes one by default: the guard only asked for `cat .env` and allowed an edit.
    const dotenvSecret = (folded: string) => { const name = posix.basename(folded); return (name === '.env' || name.startsWith('.env.')) && !documentation(folded) }
    const dotenvDenial = deny('Refusing to read or write an environment file: `.env` and `.env.*` hold secrets unless named .env.example, .env.sample, .env.template or .env.schema, or declared as a template. '
        + 'Fix: an agent runs the trusted process through a declared project command or script that wraps Varlock; a person in a terminal runs that same command, or `VARLOCK_TELEMETRY_DISABLED=true varlock run -- <cmd>`, without `--redact-stdout`, which Varlock refuses on a terminal. List variable names with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs env keys --config <your cockpit.toml>`.')
    const manifestPath = absolute(GUARD_CONTROL_FILES[1])
    const structural = [resolved.configPath, manifestPath]
    const structuralDenial = deny(`Refusing to delete, rename, truncate, relink or make unreadable ${posix.basename(resolved.configPath)} or ${GUARD_CONTROL_FILES[1]}: every later guarded call reads them, so losing either holds the agent until a human restores it. Edit ${posix.basename(resolved.configPath)} in place instead.`)
    const executionDenial = deny('Refusing to change the installed cockpit, a node_modules/.bin directory or a command search path directory: code there runs as the guard or in place of a permitted command.')
    const linkDenial = deny('Refusing to link to a secrets directory, a declared environment instance, a guard control or the installed cockpit: the link would reach it under a name the guard does not protect.')
    // The guard admits `npx --no cockpit` only from a root without an .npmrc, but checks that before
    // the command runs: `printf … > .npmrc && npx --no cockpit …` planted one in between.
    const npmrcDenial = deny('Refusing to write an .npmrc inside the configured roots: npm applies it to `npx --no cockpit`, and its script-shell or node-options would run other code as the cockpit launcher the guard trusts. A person edits .npmrc.')
    // The guard authenticates only its entry point, so every module it loads is as much a control as
    // its hook registration; an edited adapter once turned every hard denial into an allow.
    const installedDirectories = resolved.executionDirectories.map(fold)
    const installedCode = (folded: string, covering: boolean) => installedDirectories.some((directory) => within(folded, directory) || covering && within(directory, folded))
    const binDirectories = resolved.allowedRoots.map((root) => fold(`${root}/node_modules/.bin`))
    const searchDirectories = resolved.searchDirectories.map(fold)
    // A file runs from a search path directory only as its direct child, which shadows a permitted command.
    const executes = (folded: string, covering: boolean) => installedCode(folded, covering) || binDirectories.some((directory) => within(folded, directory))
        || searchDirectories.some((directory) => folded === directory || posix.dirname(folded) === directory || covering && within(directory, folded))
    const secretFiles = resolved.secretFileIdentities === null ? undefined : new Set(resolved.secretFileIdentities)
    // A hard link to a secrets file shares its identity under a spelling no normalisation equates.
    const secretFile = (evidence: JsonSnapshotObject) => evidence.identity !== null && secretFiles?.has(evidence.identity as string) === true
    let authorityUnavailable: GuardDecision | undefined
    let hardDeny: GuardDecision | undefined
    const hold = (decision: GuardDecision) => {
        if (decision.decision === 'deny') hardDeny = decision
        else if (decision.decision === 'unavailable' && !authorityUnavailable) authorityUnavailable = decision
    }
    const askDecisions = new Map<ParsedInvocation, GuardDecision>()
    const approvalBarriers = new Map<ParsedInvocation, GuardDecision>()
    const holdAsk = (invocation: ParsedInvocation, decision: GuardDecision) => {
        if (!askDecisions.has(invocation)) askDecisions.set(invocation, decision)
    }
    // Asks a hard boundary raised, such as a push whose destination is unknown: no grant discards them.
    const boundaryAsks = new Map<ParsedInvocation, GuardDecision>()
    const holdBoundary = (invocation: ParsedInvocation, decision: GuardDecision) => {
        if (!boundaryAsks.has(invocation)) boundaryAsks.set(invocation, decision)
    }
    const open = resolved.defaultDecision === 'allow'
    const credential = (folded: string) => credentialStore(folded, resolved.homeDirectory)
    const credentialDenial = deny('Refusing to read, print or send a credential store: SSH and cloud keys, token files such as ~/.npmrc, ~/.netrc or ~/.codex/auth.json, agent tool and deployment CLI logins, shell histories, and .pem, .p12 or id_* key files hold credentials. A person handles them.')
    // The current branch and where a bare push goes, for the repository at `cwd`, as Git reports them.
    const branchFacts = (cwd: string): BranchFacts | undefined => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect({ path: '.', cwd, operation: 'branch' })) }
        catch { return undefined } // no answer is an unresolved branch, which only ever asks
        const ref = (value: unknown) => value === null || typeof value === 'string' && /^refs\/[^\s]+$/.test(value)
        return record(evidence) && evidence.status === 'resolved' && evidence.path === cwd && ref(evidence.head) && ref(evidence.push)
            && (evidence.pushDefault === null || typeof evidence.pushDefault === 'string') && typeof evidence.pushRefspecs === 'boolean' && typeof evidence.pullRebase === 'boolean'
            ? { head: evidence.head as string | null, push: evidence.push as string | null, pushDefault: evidence.pushDefault as string | null,
                pushRefspecs: evidence.pushRefspecs, pullRebase: evidence.pullRebase } : undefined
    }
    // Which protected paths a Git verb's revision would change in the working tree at `cwd`, and whether it holds any.
    const treeFacts = (cwd: string, target: GitTreeTarget): { readonly guarded: boolean; readonly changed: readonly string[] } | undefined => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect({ path: '.', cwd, operation: 'tree', revision: target.revision, ...target.from === undefined ? {} : { from: target.from } })) }
        catch { return undefined } // no answer leaves the content unknown, which only ever asks
        return record(evidence) && evidence.status === 'resolved' && evidence.path === cwd && evidence.revision === target.revision && evidence.from === target.from
            && typeof evidence.guarded === 'boolean' && Array.isArray(evidence.changed) && evidence.changed.length <= GUARD_LOCATION_LIMITS.sensitivePaths
            && evidence.changed.every(canonical) ? { guarded: evidence.guarded, changed: evidence.changed as readonly string[] } : undefined
    }
    // The nearest package.json at or above a path: its name and its script names.
    // The nearest package.json at or above a path: its name and its script names, and with `workspace` the
    // scripts any package of the enclosing workspace declares, or null when they could not all be read.
    const manifestFacts = (path: string, cwd: string, workspace = false): { readonly name: string | null; readonly scripts: readonly string[]; readonly workspace: readonly string[] | null } | undefined => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect({ path, cwd, operation: 'manifest', ...workspace ? { workspace: true as const } : {} })) }
        catch { return undefined } // no answer names no package and no script, which only ever asks
        const names = (value: JsonSnapshot | undefined): value is readonly string[] => Array.isArray(value) && value.length <= GUARD_INPUT_LIMITS.words && value.every(scalar)
        return record(evidence) && evidence.status === 'resolved' && evidence.path === posix.resolve(cwd, path) && (evidence.name === null || scalar(evidence.name))
            && names(evidence.scripts) && (!workspace || evidence.workspace === null || names(evidence.workspace))
            ? { name: evidence.name, scripts: evidence.scripts, workspace: workspace && names(evidence.workspace) ? evidence.workspace : null } : undefined
    }
    // Whether a remote URL Git would print for the repository at `cwd` carries a credential; no answer counts as yes.
    const remoteCredentials = (cwd: string): boolean => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect({ path: '.', cwd, operation: 'remote' })) }
        catch { return true }
        return !(record(evidence) && evidence.status === 'resolved' && evidence.path === cwd && evidence.credentials === false)
    }
    // A repository's `.git/config` holds its remote URLs, so reading it prints a credential one carries.
    const gitConfigDenial = deny('Refusing to read a Git configuration whose remote URL or http header carries a credential. Read the setting you need with `git config --get <key>`, or a person reads it.')
    const holdGitConfigRead = (lexical: string) => {
        const folded = fold(lexical)
        if (posix.basename(folded) === 'config' && posix.basename(posix.dirname(folded)) === '.git' && remoteCredentials(posix.dirname(posix.dirname(lexical)))) hold(gitConfigDenial)
    }
    // Identity facts for inspected evidence: the leaf itself, everything above it, and what it covers.
    const evidenceFacts = (evidence: JsonSnapshotObject) => {
        const leaf = evidence.identity as string | null
        const chain = [...evidence.ancestors as string[], ...(leaf === null ? [] : [leaf])]
        return {
            is: (path: string) => leaf !== null && identityOf(path) === leaf,
            below: (path: string) => { const protectedIdentity = identityOf(path); return protectedIdentity !== null && chain.includes(protectedIdentity) },
            covers: (path: string) => leaf !== null && chainOf(path).includes(leaf),
        }
    }
    // A throwing inspector is missing evidence, which every caller treats as unsafe; the cause is
    // kept so the refusal can name it.
    let inspectionFailure: string | undefined
    // The last inspected path leads through a link, which the guard judges only as spelled.
    let inspectedLink = false
    const resolvedEvidence = (request: PathInspectionRequest): JsonSnapshotObject | undefined => {
        let evidence: JsonSnapshot | undefined
        inspectionFailure = undefined
        inspectedLink = false
        try { evidence = snapshotJson(inspect(request)) }
        catch (error) { inspectionFailure = errorCause(error); return undefined }
        inspectedLink = record(evidence) && evidence.symlink === true
        const lexical = posix.resolve(request.cwd, request.path)
        const listed = request.operation === 'search' || request.operation === 'unignored-search' ? 'sensitive' : request.operation === 'repository' ? 'tracked' : undefined
        const canonicalPath = evidence !== undefined && record(evidence) ? evidence.canonicalPath : undefined
        const observedPath = canonicalPath ?? lexical
        const paths = listed && evidence !== undefined && record(evidence) ? evidence[listed] : null
        const linkCount = record(evidence) ? evidence.links : undefined
        return record(evidence) && keys(evidence, ['status', 'path', 'symlink', 'identity', 'ancestors', ...(listed ? [listed] : []), ...(canonicalPath === undefined ? [] : ['canonicalPath']),
            ...(linkCount === undefined ? [] : ['links'])]) && evidence.status === 'resolved'
            && (linkCount === undefined || request.operation === 'write' && typeof linkCount === 'number' && Number.isSafeInteger(linkCount) && linkCount >= 1)
            && (canonicalPath === undefined || ['read', 'search', 'unignored-search'].includes(request.operation) && canonical(canonicalPath)
                && resolved.allowedRoots.some(root => within(lexical, root)) && resolved.allowedRoots.some(root => within(canonicalPath, root)))
            && evidence.path === lexical && evidence.symlink === false && (evidence.identity === null || identity(evidence.identity))
            && Array.isArray(evidence.ancestors) && evidence.ancestors.every(identity)
            && (paths === null || Array.isArray(paths) && paths.length <= GUARD_LOCATION_LIMITS.sensitivePaths
                && paths.every((path) => canonical(path) && typeof observedPath === 'string' && within(path, observedPath))) ? evidence : undefined
    }
    let pathCount = input.paths.length + input.invocations.reduce((sum, item) => sum + item.redirects.length, 0)
    const externalWriteDenial = (path: string, hazard: string) => deny(`Refusing to write ${shownGuardWord(path)}: [guards] write_paths admits writes below the paths it lists, but never into ${hazard}, which changes what agents, the shell or Git run later, or holds credentials. A person makes this change.`)
    const outsideWriteRefusal = unavailable('Guard path escapes configured roots. This command writes outside every root this cockpit manages, and no [guards] write_paths entry covers where it lands: write inside the cockpit, or a person lists the location under [guards] write_paths and syncs, or runs the command.')
    // A write outside the roots is admitted only where it lands below a write path, judged where its
    // existing links lead (as the system resolves them, and from / for a Data volume spelling). One that
    // lands in the roots is judged there; in a related checkout, a secret path or the code the guard runs,
    // it is refused; below a write path the locations that change what runs later stay refused.
    const judgeExternalWrite = (request: PathInspectionRequest, lexical: string) => {
        if (!writePaths.length) {
            hold(unavailable('Guard path escapes configured roots. This command writes outside every root this cockpit manages, and no [guards] allow rule grants a write there: write inside the cockpit, or a person runs the command.'))
            return
        }
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect({ path: request.path, cwd: request.cwd, operation: 'external-write' })) } catch (error) { inspectionFailure = errorCause(error) }
        const reported = record(evidence) && evidence.status === 'resolved' && evidence.path === lexical && canonical(evidence.landsAt)
            && (evidence.links === undefined || typeof evidence.links === 'number' && Number.isSafeInteger(evidence.links) && evidence.links >= 1) ? evidence.landsAt : undefined
        if (reported === undefined) {
            hold(unavailable(`Guard could not tell where a write outside the configured roots lands, so it cannot rule out a link into a location it protects: ${shownGuardWord(request.path)}. Write to a path that exists up to its parent directory, or a person runs it.`))
            return
        }
        const landsAt = guardFirmlinkStripped(reported)
        const folded = fold(landsAt)
        if (inRelatedCheckout(landsAt) || reservedForRelated(landsAt)) { hold(relatedDenial); return }
        if (resolved.allowedRoots.some((root) => within(folded, fold(root)))) {
            // Another spelling of a root, such as its folded case, is judged once as that spelling: inspecting
            // it again would find it outside the roots and come back here.
            if (resolved.allowedRoots.some((root) => within(landsAt, root))) inspectPath({ path: landsAt, cwd: posix.dirname(landsAt), operation: 'write' }, true)
            else hold(unavailable(`Refusing ${shownGuardWord(request.path)}: it names a configured root under another spelling, such as another case. Name it as the cockpit does.`))
            return
        }
        if (guardScriptLocation(folded)) { hold(guardScriptDenial); return }
        if (unseenMembers) {
            hold(deny(`Refusing ${shownGuardWord(request.path)}: the command writes files whose names it chooses itself, as an extraction, a sync of a directory, a recursive copy, a clone or a download of an archive does, and outside the roots a write path admits only writes that name each file. Write it inside the cockpit and copy the files you need by name.`))
            return
        }
        if (evidence !== undefined && record(evidence) && typeof evidence.links === 'number' && evidence.links > 1) { hold(hardLinkDenial); return }
        if ([...resolved.guardRuntime ?? [], ...resolved.cockpitPackageDirectories ?? [], ...resolved.executionDirectories].some((path) => within(folded, fold(path)))) {
            hold(executionDenial)
            return
        }
        const area = writePaths.find((path) => within(landsAt, path))
        if (area === undefined) { hold(outsideWriteRefusal); return }
        const hazard = externalWriteHazard(fold(lexical), resolved.homeDirectory, resolved.externalSearchDirectories ?? [])
            ?? externalWriteHazard(folded, resolved.homeDirectory, resolved.externalSearchDirectories ?? [])
            // A dotfile directly in a write path is how a shell, an editor or an agent tool finds its configuration.
            ?? (landsAt !== area && posix.relative(area, landsAt).split('/')[0]!.startsWith('.') ? 'a dotfile or dot-directory directly in a write path' : undefined)
        if (hazard) hold(externalWriteDenial(request.path, hazard))
    }
    const inspectPath = (request: PathInspectionRequest, controlCoverage = false, approvedReadCwd = false): JsonSnapshotObject | undefined => {
        if (!scalar(request.path) || Buffer.byteLength(request.path) > GUARD_INPUT_LIMITS.pathBytes || !canonical(request.cwd)) {
            hold(unavailable('Guard path or working directory is malformed.'))
            return
        }
        const lexical = posix.resolve(request.cwd, request.path)
        const mutating = request.operation !== 'cwd'
        const staging = request.operation === 'stage'
        const removing = request.operation === 'remove'
        // Spelling checks run before inspection so a hard denial survives missing evidence; they
        // cover leaves that do not exist yet, which have no identity to compare, and folded
        // spellings of a root that a case-insensitive volume resolves to it.
        const folded = fold(lexical)
        if (mutating && (folded.split('/').includes('.secrets') || (staging || removing) && within(fold(secretRoot), folded))) hold(staging && !folded.split('/').includes('.secrets') ? coveringStageDenial : secretDenial)
        // Held first, so a declared instance's own denial, held after it, is the one reported.
        // Held before the control denials, so a control's own denial is the one reported.
        if ((request.operation === 'write' || staging) && guardScriptLocation(folded)) hold(guardScriptDenial)
        if (mutating && dotenvSecret(folded)) hold(dotenvDenial)
        if (mutating && (inSecretPath(folded) || (staging || removing) && coversSecretPath(folded))) hold(staging && !inSecretPath(folded) ? coveringStageDenial : secretPathDenial)
        if (mutating && resolved.instances.some((item) => folded === fold(item.path) || (staging || removing) && within(fold(item.path), folded))) hold(staging && !resolved.instances.some((item) => folded === fold(item.path)) ? coveringStageDenial : instanceDenial)
        if (request.operation === 'write' && (controlFiles.some((path) => folded === fold(path) || controlCoverage && within(fold(path), folded))
            || controlDirectories.some((path) => within(folded, fold(path)) || controlCoverage && within(fold(path), folded)))) hold(controlDenial)
        if (request.operation === 'write' && executes(folded, controlCoverage)) hold(executionDenial)
        if (request.operation === 'write' && posix.basename(folded) === '.npmrc') hold(npmrcDenial)
        if (mutating && folded.split('/').includes('.git')) hold(gitMetadataDenial)
        if (aliasedLocation(lexical)) { hold(aliasDenial(request.path)); return }
        if ((mutating || !approvedReadCwd) && inRelatedCheckout(lexical) || mutating && reservedForRelated(lexical)) { hold(relatedDenial); return }
        if (!resolved.allowedRoots.some((root) => within(lexical, root)) && !(request.operation === 'cwd' && approvedReadCwd)) {
            if (request.operation === 'write') { judgeExternalWrite(request, lexical); return }
            hold(unavailable(request.operation === 'cwd'
                    ? 'Guard path escapes configured roots. A working directory in this command is outside every root this cockpit manages. A person can admit one read-only Git command in a related checkout, such as `git -C <checkout> status --short` or `git -C <checkout> log`, by its complete argv with a managed cwd under [guards] allow and a sync; it then runs only as the whole command. Commands that print file content there, such as diff or show, stay refused. Otherwise work inside the cockpit, or a person runs the command.'
                    : 'Guard path escapes configured roots. A path in this command is outside every root this cockpit manages, which the guard does not judge: work inside the cockpit, or a person runs the command.'))
            return
        }
        const evidence = resolvedEvidence(request)
        if (!evidence) {
            hold(unavailable(request.operation === 'cwd' && inspectedLink
                // A relative path or `..` from such a directory resolves where the link leads, not where it is spelled.
                ? `The working directory ${shownGuardWord(request.path)} leads through a link, and the guard judges paths only as they are spelled. Run the command from the checkout and name the path through the link, as in \`rg <pattern> node_modules/<package>/docs\`.`
                : `Guard path inspection failed, or its evidence is missing, symlinked or mismatched${inspectionFailure === undefined ? '' : ` (${inspectionFailure})`}.`))
            return
        }
        if (!mutating) return evidence
        if (request.operation === 'write' && typeof evidence.links === 'number' && evidence.links > 1) hold(hardLinkDenial)
        // Identity catches every spelling the volume resolves to a protected entry, including ones
        // the shared normalisation does not equate, such as a hard link.
        const { is, below, covers } = evidenceFacts(evidence)
        if (below(secretRoot) || secretFile(evidence)) hold(secretDenial)
        else if ((staging || removing) && covers(secretRoot)) hold(staging ? coveringStageDenial : secretDenial)
        if (resolved.instances.some((item) => is(item.path))) hold(instanceDenial)
        else if ((staging || removing) && resolved.instances.some((item) => covers(item.path))) hold(staging ? coveringStageDenial : instanceDenial)
        if (resolved.secretPaths?.some(below)) hold(secretPathDenial)
        else if ((staging || removing) && resolved.secretPaths?.some(covers)) hold(staging ? coveringStageDenial : secretPathDenial)
        if (request.operation === 'write' && (controlFiles.some(is) || controlDirectories.some(below)
            || controlCoverage && (controlFiles.some(covers) || controlDirectories.some(covers)))) hold(controlDenial)
        return evidence
    }
    // `.`, `-A` and a directory operand stage everything below them, so a secrets directory anywhere
    // in the tree is as much at stake as the root one: `git add services` only asked, and an approved
    // prompt would have staged its contents wherever an ignore rule did not cover them.
    const inspectStage = (invocation: ParsedInvocation, path: string, cwd: string) => {
        if (!inspectPath({ path, cwd, operation: 'stage' })) return
        const walked = resolvedEvidence({ path, cwd, operation: 'search' })
        if (!walked) {
            hold(unavailable(`Guard could not walk ${path} to prove staging it holds no secrets directory${inspectionFailure === undefined ? '' : ` (${inspectionFailure})`}.`))
            return
        }
        const found = walked.sensitive as readonly string[] | null
        if (found === null) holdBoundary(invocation, ask(`Staging ${path} covers more than the guard walks to prove it holds no secrets directory. Stage the changed files by name.`))
        else if (found.some((item) => fold(item).split('/').includes('.secrets'))) hold(coveringStageDenial)
    }
    // Removing a control, anything below a control directory, or a directory containing one can
    // disable the guard before its next invocation. Missing evidence never softens a spelling denial.
    // The return value preserves a prompt for command removals beyond the inspector's authority.
    const inspectRemoval = (path: string, cwd: string): boolean => {
        if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) return false
        const lexical = posix.resolve(cwd, path)
        if (structural.some((target) => within(fold(target), fold(lexical)))) { hold(structuralDenial); return false }
        if (controlFiles.some((target) => within(fold(target), fold(lexical)))
            || controlDirectories.some((target) => within(fold(target), fold(lexical)) || within(fold(lexical), fold(target)))) {
            hold(controlDenial)
            return false
        }
        if (installedCode(fold(lexical), true)) { hold(executionDenial); return false }
        if (aliasedLocation(lexical)) { hold(aliasDenial(path)); return false }
        if (inRelatedCheckout(lexical) || reservedForRelated(lexical)) { hold(relatedDenial); return false }
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) {
            // Removing below a write path, as `mv` does to its source, is a write there; anywhere else outside it asks, as before.
            if (!writePaths.length || !writePaths.some((area) => within(lexical, area))) return true
            judgeExternalWrite({ path, cwd, operation: 'write' }, lexical)
            return false
        }
        const evidence = inspectPath({ path, cwd, operation: 'remove' })
        if (!evidence) return false
        const { below, covers } = evidenceFacts(evidence)
        if (structural.some(covers)) { hold(structuralDenial); return false }
        if (controlFiles.some(covers) || controlDirectories.some((target) => covers(target) || below(target))) hold(controlDenial)
        return false
    }
    // A known tool runs project code that can write anywhere, so a directory operand that merely holds a
    // control (`npx eslint .` at the cockpit root) adds nothing; naming a control itself, or Git's
    // pathspecs, which write the index's or a revision's copy of every file below them, still stops.
    const unclassifiedControl = unavailable('Invocation names a guard control, and the guard does not know whether it writes there. '
        + 'Name the files it needs that are not guard controls, or run it from a subdirectory; otherwise a person runs it.')
    // A directory that only holds a control asks, so a person can approve `git restore --source=<rev> .`;
    // naming a control itself stays a hard stop.
    const inspectPossibleControlOperand = (invocation: ParsedInvocation, path: string, cwd: string, covering: boolean) => {
        if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) return
        const lexical = posix.resolve(cwd, path)
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) return
        const folded = fold(lexical)
        const holdsControl = () => holdBoundary(invocation, ask(`${named(invocation)} names ${shownGuardWord(path)}, which holds guard files, and the guard does not know whether it writes them. `
            + 'Name the files it needs that are not guard controls, or run it from a subdirectory; otherwise a person approves it or runs it.'))
        if (controlFiles.some((target) => folded === fold(target)) || controlDirectories.some((target) => within(folded, fold(target)))) { hold(unclassifiedControl); return }
        if (covering && [...controlFiles, ...controlDirectories].some((target) => within(fold(target), folded))) { holdsControl(); return }
        const evidence = resolvedEvidence({ path, cwd, operation: 'write' })
        if (!evidence) return
        const { is, below, covers } = evidenceFacts(evidence)
        if (controlFiles.some(is) || controlDirectories.some(below)) hold(unclassifiedControl)
        else if (covering && [...controlFiles, ...controlDirectories].some(covers)) holdsControl()
    }
    // A symbolic link's text resolves from the link's own directory and a hard link's from the
    // working directory, so a source is checked from both.
    // Whether a Git pathspec can match a guard control. Git matches a path or any leading directory of
    // it, `*` crosses `/`, and `:(...)`, `:/` and `:!` prefixes are magic; a control directory counts
    // through every file below it.
    const controlPathspec = (spec: string, cwd: string) => {
        const pattern = spec.replace(/^:(?:\([^)]*\)|[/!^]*)/, '')
        const source = fold(posix.resolve(spec.startsWith(':/') ? resolved.canonicalRoot : cwd, pattern))
        const expression = new RegExp(`^${source.split(/(\*+|\?|\[[^\]]*\])/).map((part, at) => at % 2
            ? part.startsWith('*') ? '.*' : part === '?' ? '.' : part : part.replace(/[.+^${}()|\\]/g, '\\$&')).join('')}(?:/.*)?$`)
        return [...controlFiles, ...controlDirectories.map((directory) => `${directory}/x`)].some((target) => expression.test(fold(target)))
    }
    const inspectLinkSource = (invocation: ParsedInvocation, source: string, cwd: string, destinations: readonly string[], symbolic: boolean) => {
        if (!scalar(source) || Buffer.byteLength(source) > GUARD_INPUT_LIMITS.pathBytes) { hold(unavailable('Guard path or working directory is malformed.')); return }
        const protectedTargets = [secretRoot, ...resolved.instances.map((item) => item.path), ...resolved.secretPaths ?? [], ...controlFiles, ...controlDirectories].map(fold)
        const bases = new Set([cwd, ...destinations.flatMap((path) => { const target = posix.resolve(cwd, path); return [target, posix.dirname(target)] })])
        for (const base of bases) {
            const folded = fold(posix.resolve(base, source))
            if (folded.split('/').includes('.secrets') || executes(folded, true) || dotenvSecret(folded) || credential(folded)
                || protectedTargets.some((target) => within(folded, target) || within(target, folded))) { hold(linkDenial); return }
        }
        // A symbolic link resolves from the directory it is made in, a hard link from the working directory.
        const targets = symbolic ? destinations.map(path => posix.resolve(posix.dirname(posix.resolve(cwd, path)), source)) : [posix.resolve(cwd, source)]
        if (targets.some(target => !inRoots(target))) {
            holdBoundary(invocation, ask(`${named(invocation)} links to ${shownGuardWord(source)}, outside the configured roots, which every later command could then read or write through the link. A person makes the link.`))
            return
        }
        pathCount++
        const evidence = resolvedEvidence({ path: source, cwd, operation: 'read' })
        if (!evidence) return
        const { is, below, covers } = evidenceFacts(evidence)
        if (secretFile(evidence) || [secretRoot, ...resolved.secretPaths ?? [], ...controlDirectories].some((path) => is(path) || below(path) || covers(path))
            || [...resolved.instances.map((item) => item.path), ...controlFiles].some((path) => is(path) || covers(path))) hold(linkDenial)
    }
    const searchedProtections = [secretRoot, ...resolved.instances.map((item) => item.path), ...resolved.secretPaths ?? []]
    // Why the last inspected search was not safe, when one protected path is the reason.
    let searchBlocker: GuardDecision | undefined
    // A read-only command is allowed only when every path it touches is evidenced inside the
    // configured roots; reading a protected instance is a hard denial, anything doubtful is not safe.
    // `chainReadOnly` says no other command in the call can create a protected path before the
    // search runs, which is what lets an absent one be ignored.
    // A person's read paths, or native external reads, admit named reads outside the roots; the
    // application then admits only an existing regular file, or a directory to list.
    const readableOutside = (lexical: string) => resolved.externalReads === 'native' || (resolved.readPaths ?? []).some(path => within(lexical, path)) || inRelatedCheckout(lexical)
    const inspectReadOnly = (access: ReadOnlyAccess, chainReadOnly = false, approvedExternalRead = false): boolean => {
        let safe = true
        searchBlocker = undefined
        const visit = (path: string, kind: 'read' | 'tree' | 'listing') => {
            if (descriptor(path)) return
            if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) { safe = false; return }
            const lexical = posix.resolve(access.cwd, path)
            const folded = fold(lexical)
            // A search rooted at or below a protected path reads it as surely as `cat` does; only a
            // listing, which reports names, may name one.
            const protectedRead = folded.split('/').includes('.secrets') || resolved.instances.some((item) => within(folded, fold(item.path)))
            if (kind !== 'listing' && dotenvSecret(folded)) hold(dotenvDenial)
            if (kind !== 'listing' && credential(folded)) hold(credentialDenial)
            if (kind !== 'listing' && protectedRead) hold(readDenial)
            if (kind !== 'listing' && inSecretPath(folded)) hold(secretPathDenial)
            if (kind === 'read') holdGitConfigRead(lexical)
            const external = !resolved.allowedRoots.some((root) => within(lexical, root))
            // The application admits only an existing regular file, or a directory to list, there.
            if (external && !approvedExternalRead && !readableOutside(lexical)) {
                safe = false
                searchBlocker ??= ask(`${shownGuardWord(path)} is outside the configured roots, where the guard cannot prove it holds no secret. A person can list it under [guards] read_paths, hand such reads to the agent tool's own permissions with [guards] external_reads = "native", or admit this complete command with an explicit managed cwd under [guards] allow, then sync. Native permission still applies; trusting hooks again does not add location authority.`)
                return
            }
            pathCount++
            // Another `.env*` name, such as `.envrc`, is not known to hold secrets, nor to be data.
            if (kind === 'read' && /^\.env/.test(posix.basename(folded)) && !documentation(folded)) safe = false
            // Unenumerated secrets leave every content read unproven, and a second hard link to a
            // protected file leaves every recursive search unproven: either may reach it unnamed.
            if (kind !== 'listing' && !secretFiles || kind === 'tree' && resolved.protectedFilesLinked) safe = false
            const evidence = resolvedEvidence({ path, cwd: access.cwd, operation: kind === 'tree' ? access.skipsIgnored ? 'unignored-search' : 'search' : kind === 'listing' && external ? 'list' : 'read',
                ...kind === 'tree' && access.followsLinks ? { followsLinks: true as const } : {} })
            if (!evidence || external && evidence.identity === null && !(kind === 'read' && access.revisionOperands)) {
                if (external && kind === 'tree' && evidence) searchBlocker ??= ask(`${shownGuardWord(path)} does not exist outside the configured roots. Name an existing regular file.`)
                else if (external && kind === 'tree') searchBlocker ??= ask(`A search of ${shownGuardWord(path)} outside the configured roots must name a regular file: there the guard recognises only .env and .secrets names, not other credential files, so it does not search a directory or follow a link. Search the named files instead.`)
                safe = false
                return
            }
            const canonicalName = fold(typeof evidence.canonicalPath === 'string' ? evidence.canonicalPath : lexical)
            if (kind === 'read' && /^\.env/.test(posix.basename(canonicalName)) && !documentation(canonicalName)) safe = false
            if (kind !== 'listing' && dotenvSecret(canonicalName)) hold(dotenvDenial)
            if (kind !== 'listing' && credential(canonicalName)) hold(credentialDenial)
            if (kind !== 'listing' && canonicalName.split('/').includes('.secrets')) hold(readDenial)
            if (kind !== 'listing' && inSecretPath(canonicalName)) hold(secretPathDenial)
            const { is, below, covers } = evidenceFacts(evidence)
            if (kind !== 'listing' && (is(secretRoot) || below(secretRoot) || secretFile(evidence) || resolved.instances.some((item) => is(item.path)))) hold(readDenial)
            if (kind !== 'listing' && resolved.secretPaths?.some(below)) hold(secretPathDenial)
            if (kind !== 'tree') return
            // The search cannot be told which files to skip: ripgrep's hidden-file filter yields to a
            // whitelist in an agent-writable ignore file, and grep has none. So a tree that holds an
            // existing protected path is not safe, and neither is one holding any `.env*` file or
            // `.secrets` directory the inspector's walk found: `grep -r KEY .` once printed an
            // undeclared sibling `.env.local` that `cat` would have stopped at. The walk sees only what
            // exists now, so the search is safe only when nothing else in the call can write first, as
            // `vercel env pull .env.local && rg KEY .` would.
            const sensitive = evidence.sensitive as readonly string[] | null
            // A search that skips what Git ignores reads a protected path only where it is listed.
            const read = (target: string) => !access.skipsIgnored || sensitive === null
                || sensitive.some((found) => within(fold(target), fold(found)) || within(fold(found), fold(target)))
            const reached = searchedProtections.filter((target) => within(fold(target), folded) || covers(target))
            const present = reached.find((target) => identityOf(target) !== null && read(target))
            const unseen = sensitive?.find((found) => !documentation(fold(found)))
            if (present === undefined && sensitive !== null && unseen === undefined && chainReadOnly) return
            safe = false
            const shown = (target: string) => posix.relative(access.cwd, target) || '.'
            searchBlocker = ask(present !== undefined
                ? `A recursive search of ${path} would read ${shown(present)}, ${(resolved.secretPaths ?? []).includes(present) ? 'a path [guards] secret_paths declares secret' : 'a declared environment instance or secrets directory'}. Search a path that does not contain it.`
                : sensitive === null
                    ? `A recursive search of ${path} covers more than the guard walks to prove it reads no environment file or secrets directory. Search a narrower path.`
                    : unseen !== undefined
                        ? `A recursive search of ${path} would read ${shown(unseen)}, an environment file or secrets directory that is not a declared template. Search a path that does not contain it.`
                        : `A recursive search of ${path} could read an environment file or secrets directory that another command in this call creates first. Run the search on its own.`)
        }
        for (const path of access.requires ?? []) {
            const evidence = resolvedEvidence({ path, cwd: access.cwd, operation: 'read' })
            if (!evidence || evidence.identity === null) safe = false
        }
        // Diffs, patches and blobs print committed content, which the path inspection never sees. The
        // index stands for the repository: a file once committed and since removed from it is not seen.
        if (access.trackedContent) {
            const tracked = resolvedEvidence({ path: '.', cwd: access.cwd, operation: 'repository' })?.tracked as readonly string[] | null | undefined
            const limits = access.trackedContent.limitedTo?.map((spec) => fold(posix.resolve(access.cwd, spec)))
            const exposed = tracked?.find((file) => !documentation(fold(file)) && (limits === undefined || limits.some((limit) => within(fold(file), limit))))
            if (!tracked || exposed !== undefined || !chainReadOnly) {
                safe = false
                searchBlocker = ask(!tracked ? 'The guard could not list the environment files and secrets this repository tracks, so it cannot prove this Git command prints none of them.'
                    : exposed !== undefined ? `This Git command can print ${posix.relative(access.cwd, exposed)}, a tracked environment file, secrets file or declared instance. Limit it with \`-- <path>\` to paths that do not hold one.`
                        : 'This Git command prints committed content, and another command in this call can change what the repository tracks first. Run it on its own.')
            }
        }
        for (const path of access.reads) visit(path, 'read')
        for (const path of access.trees) visit(path, 'tree')
        for (const path of access.listings) visit(path, 'listing')
        return safe
    }
    const readOnly = new Set<ParsedInvocation>()
    const searchRefusals = new Map<ParsedInvocation, GuardDecision>()
    // Launcher words name a package or the launcher, never an operand. Only a proven spelling runs
    // the installed cockpit, so only it is evaluated as cockpit; any other may run other code.
    const launcherPrefix = (invocation: ParsedInvocation) => invocation.executable === null ? undefined : cockpitLauncherPrefix(invocation.executable, invocation.argv)
    const provenCockpit = (invocation: ParsedInvocation): readonly string[] | undefined => {
        const prefix = launcherPrefix(invocation)
        return prefix !== undefined && resolved.cockpitLaunchers.some((item) => item.executable === invocation.executable && item.cwd === invocation.cwd
            && item.argv.length === prefix && item.argv.every((word, index) => word === invocation.argv[index])) ? invocation.argv.slice(prefix) : undefined
    }
    const launchedCockpit = (invocation: ParsedInvocation): { readonly cockpit?: readonly string[]; readonly operands: readonly string[] } => {
        const cockpit = provenCockpit(invocation)
        if (cockpit) return { cockpit, operands: cockpit }
        const prefix = launcherPrefix(invocation)
        if (prefix === undefined || !['npx', 'cockpit'].includes(invocation.executable!)) return { operands: invocation.argv }
        holdBoundary(invocation, ask(UNPROVEN_LAUNCHER))
        return { operands: invocation.argv.slice(prefix) }
    }
    // A session runs the words after `--` as a command, with no shell, in its own directory, and exec
    // runs them in a product container that mounts the checkouts and may hold their credentials, so
    // that command is judged as one more invocation: neither admits more than the guard would. The
    // name-based denials apply to exec's command as to any other, but a read-only proof is about the
    // host's files and exec's command sees the container's, so only a declared allow rule or a
    // build or test command admits it.
    const containerCommands = new Set<ParsedInvocation>()
    const invocations = input.invocations.flatMap((invocation): ParsedInvocation[] => {
        const cockpit = provenCockpit(invocation)
        const command = cockpit && innerCommand(cockpit)
        if (!command) return [invocation]
        const inner: ParsedInvocation = { executable: command.words[0]!, argv: command.words.slice(1), cwd: invocation.cwd, wrapped: false, redirects: [],
            words: command.words.map((value, index) => ({ role: index ? 'argument' as const : 'executable' as const, value })) }
        if (command.runs === 'container') containerCommands.add(inner)
        return [invocation, inner]
    })
    const accesses = new Map(invocations.map((invocation) => {
        const cockpit = provenCockpit(invocation)
        return [invocation, classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: resolved.ripgrepConfigActive, wideSearch: open, ...(cockpit ? { cockpit } : {}) })]
    }))
    // A definition or a `cd` runs nothing, so it cannot create a path before a search reads it; a bare redirect writes one.
    const externalGit = (invocation: ParsedInvocation, access: ReadOnlyAccess | undefined) => invocation.executable === 'git' && access !== undefined
        && !resolved.allowedRoots.some(root => within(access.cwd, root))
    // An external Git command is reviewed execution: its repository can configure helpers that write.
    const chainReadOnly = [...accesses].every(([invocation, access]) => access !== undefined && !externalGit(invocation, access)
        || invocation.executable === null && !invocation.redirects.some((redirect) => redirect.write))
    let possibleControlCount = 0
    // Files and directories a download in this call writes, in the order the commands run.
    const fetchedFiles = new Set<string>()
    const fetchedDirectories = new Set<string>()
    // A glob the guard leaves unexpanded: a pattern in the last component only, holding no expansion.
    const plainGlob = (word: { readonly value: string; readonly dynamic?: true }) => word.dynamic === true && /[*?[]/.test(posix.basename(word.value))
        && !/[*?[]/.test(posix.dirname(word.value)) && !/[$`]/.test(word.value)
    // A loop variable whose items are all visible inside the roots: their names are judged on the loop itself.
    const visibleLoops = new Map(invocations.filter(item => item.executable === null && item.words[0]?.role === 'definition'
        && item.words.slice(1).every(word => word.role === 'argument' && (!word.dynamic || plainGlob(word)) && inRoots(posix.resolve(item.cwd, word.value))))
        .map(item => [item.words[0]!.value, item.words.slice(1).map(word => word.value)]))
    // Variables set in this call to a value the guard cannot judge where it is used: a command substitution, or a
    // path outside the roots. `f=~/.aws/credentials; xxd "$f"` reads what the assignment names.
    const opaqueNames = new Set(invocations.flatMap(item => {
        const assigned = item.words.filter(word => word.role === 'environment-assignment-value' && word.name !== undefined).map(word => ({ name: word.name!, value: word.value }))
        if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(posix.basename(item.executable ?? ''))) {
            assigned.push(...item.argv.filter(arg => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)).map(arg => ({ name: arg.slice(0, arg.indexOf('=')), value: arg.slice(arg.indexOf('=') + 1) })))
        }
        // `printf -v NAME FORMAT …` assigns what the format builds, which the guard does not evaluate.
        if (posix.basename(item.executable ?? '') === 'printf' && item.argv[0] === '-v' && item.argv[1] !== undefined) assigned.push({ name: item.argv[1], value: '$(printf)' })
        return assigned.filter(({ value }) => /\$\(|`/.test(value) || posix.isAbsolute(value) && !value.includes(':') && !value.startsWith('/dev/')
            && !inRoots(posix.resolve(item.cwd, value)) && !readableOutside(posix.resolve(item.cwd, value))).map(({ name }) => name)
    }))
    const references = (value: string) => [...value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]!)
    // A glob in a path's last component that a declared secret path, instance or the secrets root could
    // match, or that lies inside one: `rg KEY var/sess*` searches the secret directory it expands to.
    const globReachesProtected = (word: string, cwd: string) => {
        const folded = fold(posix.resolve(cwd, word))
        if (inSecretPath(posix.dirname(folded))) return true
        // Any bracket expression counts as any one character, so a negated class cannot hide a match.
        const pattern = globExpression(posix.basename(folded).replace(/\[[^\]]*\]/g, '?'))
        return [...secretPaths, fold(secretRoot), ...resolved.instances.map((item) => fold(item.path))]
            .some((path) => posix.dirname(path) === posix.dirname(folded) && pattern.test(posix.basename(path)))
    }
    // A call that makes a symbolic link, or moves or copies an existing one, runs nothing else: its link
    // can be moved to where its text reaches a guard control or a secret, and every other path in the call
    // was judged before the link existed there. Commands in a pipeline or in the background run beside it,
    // so the commands before it are held as well as those after.
    const linkMakers = invocations.filter(invocation => {
        const git = gitInvocation(invocation)
        if (createsLink(invocation, git)) return true
        const name = posix.basename(invocation.executable ?? '')
        const sources = git?.verb === 'mv' ? transferOperands('mv', git.args).sources
            : ['mv', 'cp', 'install'].includes(name) ? transferOperands(name as 'mv' | 'cp' | 'install', invocation.argv).sources : []
        return sources.some(source => {
            if (!scalar(source) || Buffer.byteLength(source) > GUARD_INPUT_LIMITS.pathBytes) return true
            const evidence = resolvedEvidence({ path: source, cwd: git?.cwd ?? invocation.cwd, operation: 'read' })
            return inspectedLink || evidence?.canonicalPath !== undefined
        })
    })
    if (linkMakers.length && invocations.some(invocation => !linkMakers.includes(invocation) && (invocation.executable !== null || invocation.redirects.length))
        || linkMakers.length > 1) {
        hold(deny(`Refusing ${named(linkMakers[0]!)} with other commands in one call: it makes or moves a symbolic link, which a later command could move to where its text reaches a guard control or a secret, and the guard judges every other path against the filesystem before the call. Make or move the link on its own, then run the rest in a later call.`))
    }
    // Every path a call names, as a word, an option value, a redirect or a file tool's target, and every
    // directory it runs in, is checked for the Data volume spelling of a location the guard protects.
    for (const [cwd, word] of [[input.cwd, input.cwd] as const, ...input.paths.map(path => [input.cwd, path] as const),
        ...invocations.flatMap(invocation => [invocation.cwd, ...invocation.executable === null ? [] : [invocation.executable], ...invocation.argv,
            ...invocation.redirects.map(redirect => redirect.target)].map(word => [invocation.cwd, word] as const))]) {
        for (const candidate of new Set([word, word.slice(word.indexOf('=') + 1), word.slice(word.lastIndexOf(':') + 1), word.slice(word.lastIndexOf('@') + 1)])) {
            if (candidate && scalar(candidate) && aliasedLocation(posix.resolve(cwd, candidate))) hold(aliasDenial(candidate))
        }
    }
    inspectPath({ path: input.cwd, cwd: input.cwd, operation: 'cwd' })
    for (const path of input.removed) {
        if (inspectRemoval(path, input.cwd)) hold(unavailable('Removal path escapes configured roots.'))
    }
    for (const path of input.paths) inspectPath({ path, cwd: input.cwd, operation: 'write' })
    for (const invocation of invocations) {
        // Redirects, heredocs, comments and definitions are not executable host use.
        // A host passed to printf is still an argument and remains a hard denial.
        // `curl -K -` and `wget -i -` read their URLs from a heredoc.
        const fetcher = ['curl', 'wget'].includes(posix.basename(invocation.executable ?? ''))
        if (invocation.words.some(word => ['executable', 'argument', 'environment-assignment-value', 'wrapper-option-value'].includes(word.role) && LIVE_SECRET_KEY.test(word.value))) {
            hold(deny('Refusing a live secret key written into the command: a command line lands in shell history and agent transcripts. Read the key from the environment the process runs with, for example through `varlock run -- <command>`, and never paste it.'))
        }
        for (const word of invocation.words) {
            if (!['executable', 'argument', 'environment-assignment-value', ...fetcher ? ['heredoc-body'] : []].includes(word.role)) continue
            if (resolved.hostedDatabaseHosts.some((host) => hostUsed(word.value, host))) hold(deny('Refusing executable use of a declared hosted database host.'))
            if (resolved.vendorHosts.some((host) => hostUsed(word.value, host))) hold(deny('Refusing executable use of a declared vendor host.'))
        }
        inspectPath({ path: invocation.cwd, cwd: invocation.cwd, operation: 'cwd' })
        for (const redirect of invocation.redirects) {
            // A control file's own denial names the stronger boundary, so it is held last.
            if (redirect.truncate) inspectRemoval(redirect.target, invocation.cwd)
            if (redirect.write) inspectPath({ path: redirect.target, cwd: invocation.cwd, operation: 'write' })
            // `/dev/tcp/<host>/<port>` opens a connection to that host.
            if (/^\/dev\/(?:tcp|udp)\//.test(redirect.target)) {
                if (resolved.hostedDatabaseHosts.some((host) => hostUsed(redirect.target, host))) hold(deny('Refusing executable use of a declared hosted database host.'))
                if (resolved.vendorHosts.some((host) => hostUsed(redirect.target, host))) hold(deny('Refusing executable use of a declared vendor host.'))
            }
        }
        const git = gitInvocation(invocation)
        unseenMembers = writesUnseenMembers(invocation, git)
        const executableName = posix.basename(invocation.executable ?? '')
        const removed = removedOperands(invocation, git)
        for (const path of removed?.paths ?? []) {
            if (inspectRemoval(path, removed!.cwd) && !approvalBarriers.has(invocation)) {
                approvalBarriers.set(invocation, ask('Removal outside configured roots requires human approval.'))
            }
        }
        const { operands } = launchedCockpit(invocation)
        const access = accesses.get(invocation)
        // An input redirect reads its file into the command whatever the command is: `sort < .env` prints it
        // as surely as `cat .env`, and `$(< .env)` with no command at all. The read-only profile inspects a
        // classified command's inputs; any other command's are inspected here.
        const inputs = invocation.redirects.filter((redirect) => !redirect.write).map((redirect) => redirect.target)
        if (!access && inputs.length && !inspectReadOnly({ cwd: invocation.cwd, reads: inputs, trees: [], listings: [] }, chainReadOnly) && !approvalBarriers.has(invocation)) {
            approvalBarriers.set(invocation, searchBlocker ?? ask(`${named(invocation)} reads ${shownGuardWord(inputs[0]!)} through an input redirect, which the guard cannot prove holds no secret: a link, an undeclared .env name, or a file outside the configured roots. Name a file the read-only profile can inspect.`))
        }
        const writes: VisibleWrites | undefined = git?.verb === 'mv' ? (() => {
            const transfer = transferOperands('mv', git.args)
            return { paths: transfer.writes, reads: [], removes: false, uncertain: transfer.uncertain }
        })() : git?.verb === 'archive' ? gitArchiveWrites(git.args) : visibleWrites(invocation)
        if (writes) {
            const writeCwd = git && ['archive', 'mv'].includes(git.verb) ? git.cwd : invocation.cwd
            for (const path of writes.paths) {
                pathCount++
                inspectPath({ path, cwd: writeCwd, operation: 'write' }, true)
                if (writes.removes) inspectRemoval(path, writeCwd)
            }
            const symbolic = posix.basename(invocation.executable ?? '') === 'ln' && invocation.argv.some(arg => arg === '--symbolic' || /^-[a-zA-Z]*s/.test(arg))
            for (const source of writes.links ?? []) inspectLinkSource(invocation, source, writeCwd, writes.paths, symbolic)
            if (writes.reads?.length && !inspectReadOnly({ cwd: invocation.cwd, reads: writes.reads, trees: [], listings: [] })) {
                hold(unavailable('Visible writer source is unavailable or unsafe to read.'))
            }
            if (writes.uncertain) hold(unavailable(`${named(invocation)} uses a form of this writer the guard does not model, so it cannot tell where it writes. `
                + 'Use one it reads: `tar -xf <archive> -C <dir>`, `tar -czf <archive> <paths>` or `tar -tf <archive>`, `rsync -a <src>/ <dst>/` for a recursive copy, '
                + 'or `cp`, `mv`, `ln` and `install` with plain operands; otherwise a person runs it.'))
        } else if (!access && git?.verb !== 'add') {
            // Staging writes the index, never the named file, and its operands are inspected as staged below.
            for (const arg of git?.args ?? operands) {
                if (++possibleControlCount <= GUARD_INPUT_LIMITS.paths) {
                    inspectPossibleControlOperand(invocation, arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg, git?.cwd ?? invocation.cwd,
                        git !== undefined || OUTSIDE_WRITERS.has(executableName) || !knownTool(invocation, resolved.allowedRoots))
                }
            }
            if (possibleControlCount > GUARD_INPUT_LIMITS.paths) hold(unavailable('Potential guard control operand limit exceeded.'))
        }
        // An output or in-place option writes as surely as an operand does, whatever grant admits the command.
        const optioned = optionWrites(invocation, git)
        for (const path of optioned?.paths ?? []) {
            pathCount++
            inspectPath({ path, cwd: optioned!.cwd, operation: 'write' }, true)
        }
        // A download that names its own file writes that file, and one whose name the server or a glob
        // chooses, or a recursive one, writes anywhere below its directory.
        const downloads = downloadWrites(invocation)
        for (const path of [...downloads?.paths ?? [], ...decompressedWrites(invocation)]) {
            pathCount++
            inspectPath({ path, cwd: invocation.cwd, operation: 'write' }, true)
        }
        const naming = unseenMembers
        unseenMembers = true
        for (const path of [...optioned?.covered ?? [], ...downloads?.directories ?? []]) {
            pathCount++
            inspectPath({ path, cwd: invocation.cwd, operation: 'write' }, true)
        }
        unseenMembers = naming
        // gh writes downloads into a directory and clones into a new one: a clone is judged as a write
        // with what it would hold, and a download by the guard files its names could reach there.
        const ghWrites = ghDownloads(invocation)
        for (const path of ghWrites?.clones ?? []) {
            pathCount++
            inspectPath({ path, cwd: invocation.cwd, operation: 'write' }, true)
        }
        if (ghWrites?.directory) {
            const { path, patterns, recursive } = ghWrites.directory
            pathCount++
            inspectPath({ path, cwd: invocation.cwd, operation: 'write' })
            const folded = fold(posix.resolve(invocation.cwd, path))
            const reached = recursive ? [...controlFiles, ...controlDirectories].filter(target => within(fold(target), folded))
                : controlFiles.filter(target => posix.dirname(fold(target)) === folded)
            if (reached.length && patterns && !recursive) {
                if (reached.some(target => patterns.some(pattern => globExpression(fold(pattern)).test(posix.basename(fold(target)))))) hold(controlDenial)
            } else if (reached.length) {
                holdBoundary(invocation, ask(`${named(invocation)} downloads files whose names the guard cannot see into ${shownGuardWord(path)}, which holds guard files. Download into another directory, such as build/, or name the release assets with -p; otherwise a person runs it.`))
            }
        }
        // A writer the guard does not model writes some operand: one outside the roots is judged as a
        // write there, and a Git verb's new repository, worktree or bundle is a write wherever it is.
        const created = writerOperands(invocation, git)
        for (const path of created?.paths ?? []) {
            pathCount++
            if (git || !inRoots(posix.resolve(created!.cwd, path))) inspectPath({ path, cwd: created!.cwd, operation: 'write' }, true)
            // Inside the roots the operand is not judged as a write, but a link on its way would carry the write outside them.
            else if (!resolvedEvidence({ path, cwd: created!.cwd, operation: 'write' })) {
                hold(unavailable(`${named(invocation)} names ${shownGuardWord(path)}, which leads through a link or could not be inspected, so the guard cannot tell where the write lands.`))
            }
        }
        // Archivers, copiers and recursive diffs read every file below a source, as a recursive search does.
        const sources = sourceTrees(invocation)
        const othersReadOnly = invocations.every(other => other === invocation || accesses.get(other) !== undefined || other.executable === null && !other.redirects.some(redirect => redirect.write))
        if (sources?.length && !inspectReadOnly({ cwd: invocation.cwd, reads: [], trees: sources, listings: [], ...executableName === 'diff' ? { followsLinks: true as const } : {} }, othersReadOnly)
            && !approvalBarriers.has(invocation)) {
            approvalBarriers.set(invocation, searchBlocker ?? ask(`${named(invocation)} reads every file below its sources, which the guard cannot prove hold no secret. Name the files it needs.`))
        }
        if (posix.basename(invocation.executable ?? '') === 'unzip' && invocation.argv.some(arg => /^-[a-zA-Z]*[pc]/.test(arg))) {
            holdBoundary(invocation, ask(`${named(invocation)} prints the files an archive holds, which the guard cannot list. Extract it into the cockpit and read the files by name.`))
        }
        // A word whose expansion the guard cannot see decides nothing it inspects: a path read, written,
        // removed or pushed, or a cockpit command. Elsewhere it is the program's own business.
        // A reader over a loop's visible items reads names the loop was judged by.
        const loopRead = READING_EXECUTABLES.has(executableName) && !writes && !removed?.paths.length && !optioned && !git && !cockpitCommand(invocation)
            && invocation.words.every(word => !word.dynamic || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(word.value) && visibleLoops.has(references(word.value)[0]!))
            && new Set(invocation.words.filter(word => word.dynamic).map(word => word.value)).size <= 1
        // A reader given a glob in its last component inside the roots reads what it matches, judged by the glob's own words.
        const globRead = READING_EXECUTABLES.has(executableName) && invocation.dynamic === true && !writes && !removed?.paths.length && !optioned && !git && !cockpitCommand(invocation)
            && invocation.words.every(word => !word.dynamic || word.role === 'argument' && plainGlob(word) && inRoots(posix.resolve(invocation.cwd, word.value))
                && !globReachesProtected(word.value, invocation.cwd))
        if (invocation.dynamic && !loopRead && !globRead && (writes || removed?.paths.length || optioned || git || READING_EXECUTABLES.has(executableName) || cockpitCommand(invocation)
            || NAME_READERS.has(executableName) || executableName === 'gh' && /^(?:gist (?:create|edit)|release (?:create|upload)|(?:secret|variable) set)$/.test(invocation.argv.slice(0, 2).join(' ')))) {
            const word = invocation.words.find(item => item.dynamic)?.value ?? ''
            holdBoundary(invocation, ask(`${named(invocation)} holds ${unseen(word)}, whose value the guard cannot see, where it decides which file is read or written or which branch is pushed. Write the value out.`))
        }
        // Any program may read what an argument names, so one holding a command substitution, or a variable this
        // call set to one or to a path outside the roots, names a file the guard cannot see; echo and printf only print it.
        const hidden = open && invocation.executable !== null && !['echo', 'printf'].includes(executableName) ? invocation.words.find(word => word.role === 'argument' && word.dynamic
            && (/\$\(|`/.test(word.value) || references(word.value).some(name => opaqueNames.has(name)))) : undefined
        if (hidden) holdBoundary(invocation, ask(hidden.value === XARGS_INPUT
            ? `${named(invocation)} takes the arguments xargs reads from standard input, so the guard cannot see which file they name. Name the files, or run the command on each by name.`
            : `${named(invocation)} holds ${shownGuardWord(hidden.value)}, a command substitution or a variable set to one or to a path outside the configured roots, so the guard cannot see which file it names. Write the value out.`))
        // A variable joined to literal text spells a name neither part shows: `"${F}nv"` with F=app/.e is app/.env.
        const joined = open && invocation.executable !== null && !(executableName === 'echo' || executableName === 'printf' && invocation.argv[0] !== '-v')
            ? invocation.words.find(word => word.role === 'argument' && word.dynamic && !word.value.startsWith('-') && word.value.includes('$')
                && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(word.value)) : undefined
        if (joined) holdBoundary(invocation, ask(`${named(invocation)} holds ${shownGuardWord(joined.value)}, which joins a variable to other text, so the guard cannot see which file it names. Write the path out.`))
        const configuration = toolConfigurationWrite(invocation)
        if (configuration === 'refuse') hold(deny(`Refusing ${named(invocation)}: it changes the person's own tool configuration or installs outside the configured roots, which every later command, a person's included, then runs with. A person runs it.`))
        else if (configuration === 'project') holdBoundary(invocation, ask(`${named(invocation)} writes the project's .npmrc, whose settings npm applies to every later npm and npx command there. A person approves it or edits the file.`))
        const remote = remoteInstallSource(invocation)
        if (remote !== undefined) holdBoundary(invocation, ask(`${named(invocation)} installs ${shownGuardWord(remote)}, a package from a URL or a Git host, whose install scripts run code the guard cannot read. Install it from the registry by name, or download it into the cockpit and read it first.`))
        // Printing the environment, or a variable whose name marks it as a secret, prints credentials.
        if (dumpsEnvironment(invocation)) {
            hold(deny('Refusing to print the environment or a variable named as a secret: its value is a credential. Print a non-secret variable by name, or list names with `cockpit env keys`.'))
        }
        // Hook managers' uninstall removes the hooks a commit runs, as `--no-verify` skips them.
        if (['pre-commit', 'husky', 'lefthook'].includes(posix.basename(invocation.executable ?? '')) && invocation.argv.includes('uninstall')) {
            hold(deny(`Refusing ${named(invocation)}: it removes the repository's hooks, so later commits skip them. A person runs it.`))
        }
        if (printsCredential(invocation, git)) hold(deny(`Refusing ${named(invocation)}: it prints a credential or a URL that can carry one. A person runs it.`))
        // A remote URL is printed as configured, so it is refused only when one carries a password or token.
        else if (printsRemoteUrl(git) && remoteCredentials(git!.cwd)) {
            hold(deny(`Refusing ${named(invocation)}: a remote URL or http header this repository configures carries a credential, which it would print. A person reads it, or moves the credential into a credential helper.`))
        }
        // A copy of cockpit run by node is cockpit under another path: its sync would bind the guard to that
        // copy, which the agent can edit, so sync and upgrade run only from the installed package.
        const nodeScript = ['node', 'nodejs'].includes(executableName) ? invocation.argv.find(arg => !arg.startsWith('-')) : undefined
        const copied = nodeScript !== undefined && inRoots(posix.resolve(invocation.cwd, nodeScript)) && !cockpitCommand(invocation)
            && manifestFacts(nodeScript, invocation.cwd)?.name === '@b00dea/cockpit'
        if (copied && /^(?:sync|upgrade)$/.test(invocation.argv[invocation.argv.indexOf(nodeScript!) + 1] ?? '')) {
            hold(deny(`Refusing ${named(invocation)}: it runs sync or upgrade from a copy of cockpit, which would make the guard run that copy. A person runs \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>\` in a terminal.`))
        } else if (copied) holdBoundary(invocation, ask(`${named(invocation)} runs a copy of cockpit outside the installed package. Run the installed \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs\`, or a person runs it.`))
        // `gh api` writes repository state outside any push the guard sees: a ref, a file committed to a
        // branch, a merge, or branch protection.
        const api = posix.basename(invocation.executable ?? '') === 'gh' && invocation.argv[0] === 'api' ? ghApiCall(invocation.argv.slice(1)) : undefined
        if (api?.writes) {
            const protectedBranch = (name: string | undefined) => name !== undefined && resolved.protectedBranches.includes(decodeURIComponent(name))
            const ref = /git\/refs\/heads\/(.+)$/.exec(api.endpoint)?.[1]
            const fieldBranch = api.fields.map(field => /^(?:branch|base)=(.*)$/.exec(field)?.[1]).find(protectedBranch)
            if (ref !== undefined && (api.method === 'DELETE' || protectedBranch(ref) || api.fields.some(field => /^force=true$/.test(field)))
                || protectedBranch(/(?:^|\/)branches\/([^/?]+)/.exec(api.endpoint)?.[1]) || fieldBranch !== undefined) {
                hold(deny('Refusing a GitHub API write that moves, forces or deletes a branch, commits or merges into a protected branch, or changes branch protection: push to a work branch instead, or a person runs it.'))
            }
            holdBoundary(invocation, ask(`${named(invocation)} writes through the GitHub API (${api.method}${api.endpoint === 'graphql' ? ' GraphQL mutation' : ''}), which changes the repository or its host outside any push the guard judges. A person runs it, or approves it here.`))
        }
        // gh's own commands that merge into, force or delete a repository's branches, or change who may.
        const gh = posix.basename(invocation.executable ?? '') === 'gh' ? invocation.argv.filter((arg, at) => !arg.startsWith('-') && !['-R', '--repo'].includes(invocation.argv[at - 1] ?? '')).slice(0, 2).join(' ') : ''
        if (gh === 'pr merge' && invocation.argv.includes('--admin') || gh === 'repo sync' && invocation.argv.some(arg => arg === '--force' || /^-[a-zA-Z]*f/.test(arg))
            || gh === 'repo delete' || gh === 'repo edit' && invocation.argv.some(arg => /^--(?:default-branch|visibility|enable-|allow-update-branch|delete-branch-on-merge)/.test(arg))) {
            hold(deny(`Refusing ${named(invocation)}: it bypasses branch protection, overwrites or deletes a repository's branches, or changes its default branch, visibility or merge settings. A person runs it.`))
        } else if (gh === 'pr merge') {
            holdBoundary(invocation, ask(`${named(invocation)} merges into the pull request's base branch, which is usually protected and which the guard cannot see. Merging is a person's or CI's decision: a person runs it, or approves it here.`))
        } else if (['repo edit', 'repo rename', 'repo archive', 'repo unarchive'].includes(gh)) {
            holdBoundary(invocation, ask(`${named(invocation)} changes the repository on its host. A person runs it, or approves it here.`))
        } else if (GH_PUBLISHES.test(gh)) {
            holdBoundary(invocation, ask(`${named(invocation)} publishes a release or a secret, deletes from the repository's host, or starts CI runs that spend its minutes. A person runs it, or approves it here.`))
        }
        const prefixed = (invocation.words.filter((word) => word.role === 'environment-assignment-value') as ReadonlyArray<{ readonly value: string; readonly name?: string }>).find(steers)
        if (open && prefixed) holdBoundary(invocation, ask(prefixed.name === undefined ? 'An environment assignment the guard could not name requires human approval.'
            : `${named(invocation)} sets ${prefixed.name}, which changes what Git, its hooks, Docker, the shell or the command search path runs. Run it without that assignment.`))
        // Exported variables reach every later command in the call, so they steer it as a prefix assignment does.
        const program = posix.basename(invocation.executable ?? '')
        if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(program)) {
            const exported = invocation.argv.filter(arg => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)).map(arg => ({ name: arg.slice(0, arg.indexOf('=')), value: arg.slice(arg.indexOf('=') + 1) }))
            const steered = exported.find(steers)
            if (steered) holdBoundary(invocation, ask(`${named(invocation)} sets ${steered.name}, which changes what Git, its hooks, Docker, the shell or the command search path runs for the rest of the call. Run it without that assignment.`))
        }
        // Removing a session marker, or every variable with `env -i`, hides that an agent runs what follows.
        const marker = (word: string) => /^(?:CLAUDECODE|CODEX_THREAD_ID|OPENCODE)$/.test(word)
        if (program === 'unset' && invocation.argv.some(marker)
            || invocation.words.some(word => word.role === 'wrapper-option-value' && (/^(?:-i|--ignore-environment)$/.test(word.value) || marker(word.value)))) {
            holdBoundary(invocation, ask(`${named(invocation)} removes the variable that marks the agent's session, or the whole environment. Run it without removing it.`))
        }
        if (program === 'set' && invocation.argv.some(arg => /^-[a-zA-Z]*a/.test(arg) || arg === 'allexport') || program === 'setopt' && invocation.argv.some(arg => /^(?:allexport|all_export)$/i.test(arg))) {
            holdBoundary(invocation, ask('Exporting every assignment hides which variables steer later commands. Set the variables a command needs as a prefix of that command.'))
        }
        // Assignment values and loop items are visible even where the words that use them are not:
        // `f=.env; nl "$f"` and `for f in .env; do nl "$f"; done` read the names they hold.
        const held = invocation.words.filter((word) => word.role === 'environment-assignment-value' || invocation.executable === null && word.role === 'argument')
        // An unexpanded glob in a command's own words names whatever it matches.
        const globs = open && !access ? invocation.words.filter((word) => word.dynamic && word.role === 'argument' && /[*?[]/.test(word.value) && !word.value.includes('$')) : []
        for (const word of [...held, ...globs]) {
            const lexical = posix.resolve(invocation.cwd, word.value)
            const folded = fold(lexical)
            const glob = (globs.includes(word) || held.includes(word) && plainGlob(word)) && new RegExp(`^${posix.basename(folded).split(/(\*+|\?|\[[^\]]*\])/).map((part, at) => at % 2
                ? part.startsWith('*') ? '.*' : part === '?' ? '.' : part : part.replace(/[.+^${}()|\\]/g, '\\$&')).join('')}$`)
            const secret = glob ? SECRET_SAMPLES.some((name) => glob.test(name)) || credential(posix.dirname(folded))
                : dotenvSecret(folded) || folded.split('/').includes('.secrets') || resolved.instances.some((item) => within(folded, fold(item.path))) || inSecretPath(folded) || credential(folded)
            if (secret && !approvalBarriers.has(invocation)) approvalBarriers.set(invocation, ask(`${invocation.executable === null ? 'This command' : named(invocation)} holds ${shownGuardWord(word.value)}, which names or can match an environment file, secrets directory, declared instance or credential store. Name the files it needs.`))
        }
        // A declared rule admits a command the profile cannot classify, but never past the secret names
        // or the roots: macOS `cat a .env -x` prints .env before it rejects -x, and `git show HEAD:.env`
        // prints a committed one. Each argument is judged whole, after `=` and after `:`.
        // A visible writer's operands already meet the stronger mutation and link denials above.
        if (!access && !writes && !removed?.paths.length && (open || resolved.declaredAllows.some(rule => ruleMatches(invocation, rule)))) {
            // A known tool reads, prints or sends what it names; another program, such as `docker compose
            // --env-file .env`, may only pass the name on, so a person decides it.
            const prints = READING_EXECUTABLES.has(invocation.executable!) || invocation.executable !== null && KNOWN_TOOLS.has(posix.basename(invocation.executable))
            const secretName = (decision: GuardDecision) => prints ? hold(decision)
                : !approvalBarriers.has(invocation) && approvalBarriers.set(invocation, ask(`${named(invocation)} names an environment file, secrets directory or declared instance, so a [guards] allow rule does not admit it. A person approves it or runs it, or declares it as a project command.`))
            // Words of a nested command, after a proven cockpit's `--` or the program a launcher runs, are
            // judged as that command, so they are not paths this one reads; nor is a proven cockpit launcher.
            const followed = invocations[invocations.indexOf(invocation) + 1]
            const nestedFrom = provenCockpit(invocation) ? (invocation.argv.indexOf('--') < 0 ? invocation.argv.length : invocation.argv.indexOf('--'))
                : followed?.wrapped && launchedBy(followed, invocation) ? invocation.argv.length - followed.argv.length - 1 : invocation.argv.length
            // A sed or awk script, or a search pattern, is the program's text, not a path it reads.
            const scriptAt = ['sed', 'awk', 'grep', 'rg', 'jq'].includes(executableName) && !invocation.argv.some(arg => /^(?:-e|-f|--expression|--regexp|--file)(?:=|$)/.test(arg))
                ? invocation.argv.findIndex(arg => !arg.startsWith('-')) : -1
            const launcherPath = (lexical: string) => resolved.cockpitLaunchers.some((item) => [item.executable, ...item.argv]
                .some((spelled) => spelled.includes('/') && posix.resolve(item.cwd, spelled) === lexical))
            for (const [position, word] of invocation.argv.entries()) {
                // An attached short option value, as in `sed -f.env`, is a candidate too.
                const attached = /^-[^-]/.test(word) && word.length > 2 ? [word.slice(2)] : []
                // `@file` is how curl and gh name a file whose content they send.
                for (const candidate of new Set([word, word.slice(word.indexOf('=') + 1), word.slice(word.lastIndexOf(':') + 1), word.slice(word.lastIndexOf('@') + 1), ...attached])) {
                    if (!candidate || candidate.startsWith('-') || !scalar(candidate)) continue
                    const lexical = posix.resolve(invocation.cwd, candidate)
                    const folded = fold(lexical)
                    if (dotenvSecret(folded)) secretName(dotenvDenial)
                    if (credential(folded)) hold(credentialDenial)
                    holdGitConfigRead(lexical)
                    // In the allow default any command may read what it names, so a path outside the roots
                    // follows external_reads for every command, not only the reading ones.
                    if (open && position < nestedFrom && position !== scriptAt && !launcherPath(lexical) && (candidate === word || candidate === word.slice(word.indexOf('=') + 1)) && (posix.isAbsolute(candidate) || candidate.split('/').includes('..'))
                        && !lexical.startsWith('/dev/') && !resolved.allowedRoots.some(root => within(lexical, root)) && !readableOutside(lexical) && !approvalBarriers.has(invocation)) {
                        approvalBarriers.set(invocation, ask(`${named(invocation)} names ${shownGuardWord(candidate)}, outside the configured roots. A person can list the location under [guards] read_paths or set [guards] external_reads = "native", then sync; or a person runs it.`))
                    }
                    if (folded.split('/').includes('.secrets') || resolved.instances.some((item) => within(folded, fold(item.path)))) secretName(readDenial)
                    if (inSecretPath(folded)) secretName(secretPathDenial)
                    if (READING_EXECUTABLES.has(invocation.executable!) && position !== scriptAt && !resolved.allowedRoots.some(root => within(lexical, root)) && !readableOutside(lexical) && !approvalBarriers.has(invocation)) {
                        approvalBarriers.set(invocation, ask(`${named(invocation)} names ${shownGuardWord(candidate)}, outside the configured roots, with words the read-only profile cannot classify, so a [guards] allow rule does not admit it. Run it as the rule names it, or a person reviews and admits this complete argv.`))
                    }
                }
            }
        }
        const externalAccess = access ?? classifyReadOnlyInvocation({ ...invocation, redirects: invocation.redirects.filter(item => !item.write) }, { ripgrepConfigActive: resolved.ripgrepConfigActive })
        const outsideRoots = (read: ReadOnlyAccess | undefined) => read && ([read.cwd].some(path => !resolved.allowedRoots.some(root => within(posix.resolve(read.cwd, path), root)))
            || [...read.reads, ...read.trees, ...read.listings].some(path => { const lexical = posix.resolve(read.cwd, path)
                if (descriptor(lexical)) return false
                return !resolved.allowedRoots.some(root => within(lexical, root)) && !readableOutside(lexical) }))
        // Ambient configuration such as RIPGREP_CONFIG_PATH must not turn an external read grant into generic execution.
        const externalGrant = resolved.declaredAllows.some(rule => rule.cwd === invocation.cwd && ruleMatches(invocation, rule)
            && outsideRoots(classifyReadOnlyInvocation({ ...invocation, argv: rule.argv.slice(1), redirects: [] }, { ripgrepConfigActive: false })))
        const external = outsideRoots(externalAccess) || externalGrant
        const exactGrant = resolved.declaredAllows.some(rule => rule.cwd === invocation.cwd && rule.argv.length === invocation.argv.length + 1
            && rule.argv[0] === invocation.executable && invocation.argv.every((word, index) => word === rule.argv[index + 1]))
        // Native external reads leave a read-only Git command in a repository outside the roots to the
        // agent tool, as they do a named file. Its repository's configured helpers run with it, so as with
        // a grant it runs only as the whole call, and nothing else in the call can change what it prints.
        // A related checkout admits the same read-only Git there without a grant, as native external reads do everywhere.
        const nativeGit = externalGit(invocation, access) && (resolved.externalReads === 'native' || inRelatedCheckout(access!.cwd))
        const alone = invocations.length === 1
        const approvedExternalRead = nativeGit && alone || !!approvedReadOnlyInvocation(invocation, resolved) && (chainReadOnly || externalGit(invocation, access) && alone)
        // A loop body reading `"$f"` is read-only when it is for each item the loop hands it.
        const loopAccesses = loopRead && invocation.dynamic ? (() => {
            const variable = references(invocation.words.find(word => word.dynamic)!.value)[0]!
            const { dynamic: _, ...literal } = invocation
            return visibleLoops.get(variable)!.map(item => classifyReadOnlyInvocation({ ...literal,
                argv: invocation.argv.map(arg => /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(arg) ? item : arg),
                words: invocation.words.map(word => word.dynamic ? { role: word.role, value: item } : word) },
                { ripgrepConfigActive: resolved.ripgrepConfigActive, wideSearch: open }))
        })() : undefined
        const globAccess = globRead ? (() => { const { dynamic: _, ...literal } = invocation
            return classifyReadOnlyInvocation({ ...literal, words: invocation.words.map(({ dynamic: __, ...word }) => word) }, { ripgrepConfigActive: resolved.ripgrepConfigActive, wideSearch: open }) })() : undefined
        if (loopAccesses?.length && loopAccesses.every(item => item !== undefined && inspectReadOnly(item, chainReadOnly))) readOnly.add(invocation)
        else if (globAccess && inspectReadOnly(globAccess, chainReadOnly)) readOnly.add(invocation)
        else if (access && inspectReadOnly(access, chainReadOnly || nativeGit && alone, approvedExternalRead)) readOnly.add(invocation)
        else if (searchBlocker) searchRefusals.set(invocation, searchBlocker)
        // A cockpit command its own table does not admit (sync and upgrade publish policy) is a person's,
        // however it is spelled and whatever a grant says.
        if (cockpitCommand(invocation) && !readOnly.has(invocation) && !resolved.cockpitInvocations.some((profile) => profile.executable === invocation.executable
            && profile.cwd === invocation.cwd && profile.argv.length === invocation.argv.length && profile.argv.every((word, at) => word === invocation.argv[at]))) {
            // A word reaching into the installed package without running it reads or copies the guard's own code.
            const launches = ['cockpit', 'cockpit.mjs', 'node', 'nodejs', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'tsx'].includes(executableName)
                || cockpitShaped({ ...invocation, argv: [] }, [...resolved.cockpitPackageDirectories ?? [], ...resolved.executionDirectories])
            holdBoundary(invocation, ask(launches
                ? `${named(invocation)} is a cockpit command an agent does not run unprompted: \`sync\`, \`upgrade\` and the other commands that change what agents may do are a person's. A person runs it in a terminal.`
                : `${named(invocation)} reads or copies the installed cockpit package, the code the guard runs, and a copy run later is not the installed cockpit. A person runs it.`))
        }
        if (external && (!approvedExternalRead || !readOnly.has(invocation))) approvalBarriers.set(invocation, searchBlocker
            ?? ask(nativeGit
                ? `${named(invocation)} runs Git in a directory outside the configured roots. With native external reads or in a related checkout the guard admits a read-only Git command there only as the whole call, from a directory holding its own .git, with operands that name regular files or revisions rather than directories or links: run it on its own from the repository's top directory.`
                : !exactGrant
                    ? `${named(invocation)} reads outside the configured roots. A person can list the location under [guards] read_paths, set [guards] external_reads = "native", or admit this complete command with an explicit managed cwd under [guards] allow, then sync; native permission still applies.`
                    : invocation.executable === 'git'
                        ? `${named(invocation)} is admitted in another checkout only as the whole command, since its repository can configure helpers that run; Git commands that print file content there, such as diff or show, stay refused.`
                        : `${named(invocation)} matches a [guards] allow rule, but the guard cannot prove this read now: it must run without writes or other commands, name existing regular files rather than directories or links, and run without ambient search configuration such as RIPGREP_CONFIG_PATH.`))
        // A cockpit command that parses a named file can quote it in a refusal, so the file is read
        // into the agent context as surely as `cat` would read it.
        for (const profile of resolved.cockpitInvocations) {
            if (!profile.reads?.length || profile.executable !== invocation.executable || profile.cwd !== invocation.cwd
                || profile.argv.length !== invocation.argv.length || profile.argv.some((word, i) => word !== invocation.argv[i])) continue
            if (!inspectReadOnly({ cwd: profile.cwd, reads: profile.reads, trees: [], listings: [] })) {
                holdAsk(invocation, ask('This cockpit command reads a file the guard cannot prove safe to read: a symlink, an undeclared .env file or one outside the configured roots.'))
            }
            // A command a session runs is not the call itself, whatever the call holds.
            if (profile.alone && (input.invocations.length !== 1 || !input.invocations.includes(invocation) || invocation.redirects.length > 0)) {
                holdAsk(invocation, ask('env schema --replace-from runs without a prompt only as the whole command: another command in this call could change the draft after the guard proved it safe. Run it on its own.'))
            }
        }
        // A config file or URL list names hosts the guard does not read.
        if (fetcher && invocation.argv.some(arg => /^(?:-K|--config|-i|--input-file)(?:=|$)/.test(arg) || /^-K./.test(arg) || /^-i./.test(arg) && executableName === 'wget')) {
            holdBoundary(invocation, ask(`${named(invocation)} reads its URLs or options from a file or standard input, whose hosts the guard does not read. Name the URL on the command line.`))
        }
        // A download run later in the same call runs whatever the server sent before anyone read it.
        const runs = executedFile(invocation)
        if (runs !== undefined && (fetchedFiles.has(runs) || fetchedDirectories.has(posix.dirname(runs)))) {
            holdBoundary(invocation, ask(`${named(invocation)} runs a file this call downloads, so what runs is whatever the server sends. Download it, read it, then run it in a later call.`))
        }
        if (fetcher) {
            const outputs = [...optioned?.paths ?? [], ...downloads?.paths ?? [], ...invocation.redirects.filter(redirect => redirect.write).map(redirect => redirect.target)]
            for (const output of outputs) fetchedFiles.add(posix.resolve(invocation.cwd, output))
            for (const directory of [...downloads?.directories ?? [], ...optioned?.covered ?? []]) fetchedDirectories.add(posix.resolve(invocation.cwd, directory))
        }
        // `go run` of a module path builds and runs code fetched from its host.
        if (executableName === 'go' && invocation.argv[0] === 'run') {
            const target = invocation.argv.slice(1).find(arg => !arg.startsWith('-'))
            if (target !== undefined && (target.includes('@') || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(target))) {
                holdBoundary(invocation, ask(`${named(invocation)} builds and runs a module fetched from its host, which the guard cannot read. Add it to the project and run it by path.`))
            }
        }
        if (!git) continue
        // `git apply` and `git am` write the paths a patch's headers name, below the top of the work tree.
        const patchFiles = ['apply', 'am'].includes(git.verb) ? appliedPatches(git) : undefined
        if (patchFiles === null) holdBoundary(invocation, ask(`${named(invocation)} applies a patch whose target paths the guard cannot read: from standard input, or with -p, --directory or --unsafe-paths. Name a patch file and apply it with the default paths.`))
        for (const file of patchFiles ?? []) {
            let evidence: JsonSnapshot | undefined
            try { evidence = snapshotJson(inspect({ path: file, cwd: git.cwd, operation: 'patch' })) } catch (error) { inspectionFailure = errorCause(error) }
            const targets = record(evidence) && evidence.status === 'resolved' && evidence.path === posix.resolve(git.cwd, file) && strings(evidence.targets) ? evidence.targets : undefined
            // A patch that names no path the guard can read, such as a mail whose body is base64 or
            // quoted-printable, still applies: `git am` decodes it first.
            if (!targets?.length) { holdBoundary(invocation, ask(`${named(invocation)} applies ${shownGuardWord(file)}, whose target paths the guard could not read: an encoded mail body, headers it does not parse, or no diff at all. Apply a patch file inside the cockpit with plain headers.`)); continue }
            // The work tree's top is the working directory or one above it.
            const tops: string[] = []
            for (let directory = git.cwd; inRoots(directory); directory = posix.dirname(directory)) { tops.push(directory); if (directory === '/') break }
            for (const target of targets) for (const top of tops) {
                pathCount++
                inspectPath({ path: target, cwd: top, operation: 'write' })
            }
        }
        // Git changes directory as the system does, resolving `..` from where a link leads, so each
        // directory is inspected as spelled rather than by the path `cwd` names.
        for (const directory of git.directories) inspectPath({ ...directory, operation: 'cwd' }, false, nativeGit || approvedExternalRead && readOnly.has(invocation))
        const globals = gitGlobalOptions(invocation.argv)
        const programKey = globals.keys.find(key => GIT_PROGRAM_KEY.test(key))
        if (programKey) hold(deny(`Refusing \`git -c ${programKey}\`: that key chooses a program Git runs or where it loads configuration from, such as the hooks. Run the command without it.`))
        if (open && git.verb && !GIT_VERBS.has(git.verb)) holdBoundary(invocation, ask(`${named(invocation)} runs \`git ${shownGuardWord(git.verb).slice(1, -1)}\`, which is not one of Git's development commands: an alias can run a shell command. Spell the command out, or a person runs it.`))
        if (git.uncertain && (!open || globals.other)) holdBoundary(invocation, ask('Git execution context is not an exact resolved profile: --git-dir, --work-tree, --namespace and --config-env point Git at state the guard does not inspect. Run Git from the repository, or with -C <directory>.'))
        // Git accepts any unambiguous abbreviation of a long option.
        if (git.args.some(arg => /^--no-veri(?:f|fy)?$/.test(arg)) || git.verb === 'commit' && git.args.some(arg => /^-[a-zA-Z]+$/.test(arg) && /^[^mFcCtSu]*n/.test(arg.slice(1)))) {
            hold(deny('Refusing `--no-verify`: it skips the repository\'s hooks. Run the command without it, and fix what a hook reports.'))
        }
        if (gitProgramOption(git)) hold(deny('Refusing a Git transfer that names the program to run on the other side (--upload-pack, --receive-pack or --exec). Run it without that option.'))
        const protectedName = (name: string | undefined) => name !== undefined && resolved.protectedBranches.some(branch => name === branch || name === `refs/heads/${branch}`)
        // An earlier command in the call (`git switch main && git push`) can move the branch the facts
        // describe, so a decision that rests on the current branch needs every earlier command to be read-only.
        const index = invocations.indexOf(invocation)
        const headMayMove = invocations.slice(0, index).some((earlier) => earlier.executable !== null && !accesses.get(earlier))
        const headMoved = ask('An earlier command in this call can change the current branch, which this command acts on. Run it on its own.')
        if (git.verb === 'push' || git.verb === 'send-pack') {
            const operands = git.args.filter(arg => !arg.startsWith('-'))
            if (headMayMove && (operands.length < 2 || operands.slice(1).some(ref => /^\+?(?:HEAD|@)(?::|$)/.test(ref)))) holdBoundary(invocation, headMoved)
            const decision = pushDecision(git.args, resolved.protectedBranches, branchFacts(git.cwd))
            if (decision?.decision === 'deny') hold(decision)
            else if (decision) holdBoundary(invocation, decision)
        }
        // New commits only append; these rewrite the current branch's history, or move a branch outright.
        const positional = git.args.filter(arg => !arg.startsWith('-'))
        const rewritesHead = git.verb === 'commit' && git.args.includes('--amend') || git.verb === 'filter-branch' || git.verb === 'filter-repo'
            || git.verb === 'rebase' && !git.args.some(arg => ['--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch'].includes(arg))
            // Before `--`, a name with no dot or slash, or a revision spelling, is the commit reset moves to.
            || git.verb === 'reset' && (git.args.indexOf('--') < 0 ? positional : git.args.slice(0, git.args.indexOf('--')).filter(arg => !arg.startsWith('-')))
                .some(arg => !['HEAD', '@'].includes(arg) && (/[~^]|@\{|^[0-9a-f]{7,40}$/i.test(arg) || !/[./]/.test(arg)))
            // With a mode, reset takes no paths: every word before `--` is the commit it moves the branch to.
            || git.verb === 'reset' && git.args.some(arg => /^--(?:hard|soft|keep|merge|mixed)$/.test(arg))
                && (git.args.indexOf('--') < 0 ? positional : git.args.slice(0, git.args.indexOf('--')).filter(arg => !arg.startsWith('-'))).some(arg => !['HEAD', '@'].includes(arg))
            || git.verb === 'pull' && git.args.some(arg => arg === '-r' || arg === '--rebase' || /^--rebase=(?!false$)/.test(arg))
            || git.verb === 'update-ref' && ['HEAD', '@'].includes(positional[0] ?? '')
        // A plain pull rebases where pull.rebase or branch.<name>.rebase says so.
        const configuredRebase = git.verb === 'pull' && !rewritesHead && !git.args.some(arg => /^--(?:no-rebase|ff-only|rebase=false)$/.test(arg))
        if ((rewritesHead || configuredRebase) && headMayMove) holdBoundary(invocation, headMoved)
        if (git.verb === 'update-ref' && git.args.includes('--stdin')) holdBoundary(invocation, ask('`git update-ref --stdin` moves refs the guard cannot see. Name the ref on the command line.'))
        // `git rebase <upstream> <branch>` rewrites that branch.
        if (git.verb === 'rebase' && protectedName(gitOperands(git.args, ['--onto', '-s', '--strategy', '-X', '--strategy-option'])[1])) hold(deny('Refusing to rewrite history on a declared protected branch. Switch to a work branch first.'))
        // A fetch refspec's destination is a local ref: `git fetch . +topic:main` moves or rewrites main.
        if (git.verb === 'fetch' && git.args.some(arg => !arg.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && arg.includes(':')
            && resolved.protectedBranches.some(branch => [branch, `heads/${branch}`, `refs/heads/${branch}`].includes(arg.slice(arg.indexOf(':') + 1))))) {
            hold(deny('Refusing a fetch into a declared protected branch: its refspec moves or rewrites that branch locally. Fetch into a remote-tracking ref or a work branch.'))
        }
        if (rewritesHead || configuredRebase) {
            const facts = branchFacts(git.cwd)
            if ((rewritesHead || facts?.pullRebase) && protectedName(facts?.head ?? undefined)) hold(deny('Refusing to rewrite history on a declared protected branch. Switch to a work branch first.'))
            else if (open && !facts?.head) holdBoundary(invocation, ask('The guard could not tell which branch this rewrites. Run it on a named work branch.'))
        }
        const moved = git.verb === 'branch' && git.args.some(arg => /^-[a-zA-Z]*[fDdmMcC]/.test(arg) || ['--force', '--delete', '--move', '--copy'].includes(arg))
            || ['checkout', 'switch'].includes(git.verb) && git.args.some(arg => ['-B', '-C', '--force-create'].includes(arg))
            || git.verb === 'update-ref'
        if (moved && positional.some(arg => protectedName(arg))) hold(deny('Refusing to move, reset or delete a declared protected branch.'))
        // Merges, checkouts, resets, picks, rebases and stashes write another revision's files into the
        // working tree, where they overwrite a guard control as surely as a write would: a commit made in a
        // second worktree and merged back replaced the guard with every step allowed.
        const tree = gitTreeTargets(git)
        if (tree) {
            const answers = tree.targets.map(target => treeFacts(git.cwd, target))
            const changed = answers.flatMap(answer => answer?.changed ?? [])
            const guarded = answers.some(answer => answer?.guarded)
            if (changed.length) hold(deny(`Refusing ${named(invocation)}: it would write ${shownGuardWord(posix.relative(git.cwd, changed[0]!) || changed[0]!)} into the working tree from another revision, and that path is a guard control, a secrets directory or a declared instance. A person runs it.`))
            else if (answers.some(answer => answer === undefined)) holdBoundary(invocation, ask(`${named(invocation)} writes another revision's files into the working tree, and the guard could not tell whether they include a guard control: the revision does not resolve, or Git did not answer. A person runs it.`))
            else if (guarded && tree.unnamed) holdBoundary(invocation, ask(`${named(invocation)} brings content into a working tree that holds guard controls, which the guard cannot inspect before it is fetched. Fetch first, then \`git merge --ff-only <remote>/<branch>\`; or a person runs it.`))
            else if (guarded && headMayMove) holdBoundary(invocation, ask(`${named(invocation)} writes another revision's files into a working tree that holds guard controls, and an earlier command in this call can change that revision first. Run it on its own.`))
        }
        // A glob or magic pathspec matches guard controls its spelling does not name, and `--cacheinfo`
        // stages a path inside one word; both are judged against every control.
        const pathspecs = [...git.args.filter(arg => !arg.startsWith('-') && (/[*?[]/.test(arg) || arg.startsWith(':'))),
            ...git.args.flatMap((arg, at) => arg === '--cacheinfo' ? [git.args[at + 1]?.split(',')[2] ?? ''] : arg.startsWith('--cacheinfo=') ? [arg.split(',')[2] ?? ''] : [])]
        for (const spec of pathspecs) if (controlPathspec(spec, git.cwd)) hold(controlDenial)
        if (git.verb === 'checkout-index' && git.args.some(arg => arg === '-a' || arg === '--all' || /^-[a-zA-Z]*a/.test(arg))
            || git.verb === 'read-tree' && git.args.some(arg => arg === '-u' || /^-[a-zA-Z]*u/.test(arg))) {
            holdBoundary(invocation, ask(`${named(invocation)} writes every indexed file into the working tree, guard controls included. Check out the files by name.`))
        }
        if (git.verb === 'config' && !gitConfigReads(git.args) && !(open && gitConfigPlainWrite(git.args))) hold(gitMetadataDenial)
        else if (git.verb === 'config' && gitConfigReads(git.args) && !access) holdAsk(invocation, ask(`${named(invocation)} prints configuration the guard cannot bound: a listing, a pattern, another file or a key outside a few sections can print a remote URL, an http header or a credential helper that holds a credential. Read one key with \`git config --get <key>\` from a section such as user, core or init, or a person runs it.`))
        // Git metadata decides what read-only Git commands show and run, so agents do not write it.
        if (git.verb === 'fetch' && !open) holdAsk(invocation, ask(`${named(invocation)} requires human approval: fetching writes objects and refs under .git, which agents do not write. To compare with another repository, read it in place with \`git -C <repository> log --oneline <branch>\`, which outside the configured roots needs [guards] external_reads = "native" or a grant; otherwise a person runs the fetch, or admits its complete argv under [guards] allow in ${posix.basename(resolved.configPath)}.`))
        if (!open && git.verb === 'reset' && git.args.includes('--hard') || git.verb === 'clean' && git.args.some((arg) => /^-[^-]*[fdxX]/.test(arg) || arg === '--force')) holdAsk(invocation, ask('Destructive Git operation requires human approval.'))
        // `git stash -u` and `-a` stage untracked, and with `-a` ignored, files into a commit and remove them, as `git add -A` stages them.
        const stashVerb = git.args.find(arg => !arg.startsWith('-'))
        if (git.verb === 'stash' && (stashVerb === undefined || ['push', 'save'].includes(stashVerb))
            && git.args.some(arg => /^--(?:include-untracked|all)$/.test(arg) || /^-[a-zA-Z]*[ua]/.test(arg) && !arg.startsWith('--'))) inspectStage(invocation, '.', git.cwd)
        // The stash's third parent and a walk of every ref or the reflog print files the index does not list.
        if ((gitPrintsContent(git) || git.verb === 'stash' && stashVerb === 'show' && git.args.some(arg => /^(?:-u|--include-untracked|--only-untracked)$/.test(arg)))
            && (git.args.some(arg => /(?:^|[^\w])stash(?:@\{|$|\^|~)|^refs\/stash/.test(arg)) || git.args.some(arg => /^--(?:all|reflog|walk-reflogs)$|^-g$/.test(arg))
                && (git.verb !== 'log' && git.verb !== 'whatchanged' || git.args.some(arg => /^(?:-p|-u|--patch|--patch-with-stat|--patch-with-raw|--cc|-c|--full-diff)$/.test(arg))))) {
            holdBoundary(invocation, ask(`${named(invocation)} can print the stash or every ref, whose commits hold untracked and ignored files the guard does not list, environment files included. Name a branch or commit.`))
        }
        if (git.verb === 'add') {
            let options = true
            let operands = 0
            for (const arg of git.args) {
                if (options && arg === '--') { options = false; continue }
                if (options && arg.startsWith('-')) {
                    if (['-A', '--all', '-u', '--update'].includes(arg)) {
                        // These forms can stage an instance even without a literal operand.
                        inspectStage(invocation, '.', git.cwd)
                    } else if (!['-f', '--force', '-v', '--verbose', '-n', '--dry-run'].includes(arg)) hold(unavailable('Unsupported Git staging option. Stage with `git add <paths>`, `-A` or `-u`; a person runs any other staging form.'))
                } else {
                    operands++
                    pathCount++
                    if (arg.startsWith(':') || /[*?\[]/.test(arg)) hold(unavailable('Unproven Git staging pathspec grammar.'))
                    else inspectStage(invocation, arg, git.cwd)
                }
            }
            if (!operands) holdBoundary(invocation, ask('Staging without explicit paths requires human approval.'))
        }
    }
    if (pathCount > GUARD_INPUT_LIMITS.paths) hold(unavailable('Guard path limit exceeded.'))
    if (hardDeny) return hardDeny
    for (const invocation of invocations) {
        const declared = resolved.declaredDenies.find(rule => ruleMatches(invocation, rule))
        if (declared) return deny(`${declared.reason}${declared.fix ? ` Fix: ${declared.fix}` : ''}`)
    }
    if (authorityUnavailable) return authorityUnavailable
    const declaredReasons: string[] = []
    for (const invocation of invocations) {
        const barrier = approvalBarriers.get(invocation)
        if (barrier) return barrier
        // A relative entry resolves against whatever directory the command runs in, so no write
        // protection covers it: a file the agent wrote as packages/web/git runs as `git` there, and a
        // path-spelled launcher's `#!/usr/bin/env node` finds a planted `node` the same way.
        if (resolved.searchPathRelativeEntry !== null && invocation.executable !== null) {
            return ask(`The command search path the agent runs with holds the relative entry ${JSON.stringify(resolved.searchPathRelativeEntry)}${resolved.searchPathRelativeEntry === '' ? ' (an empty entry is the working directory)' : ''}, so ${invocation.executable}, or a program it starts by name, may run a file the agent wrote instead of the permitted program. Remove relative entries from the PATH the agent harness starts with.`)
        }
        // Only a proven read-only command may carry `$?`: as any other argument it could name a path the guard never saw.
        if (invocation.expandsStatus && !readOnly.has(invocation)) return ask(`${named(invocation)} has an argument holding $?, whose digits the guard cannot see, so it cannot prove which path the argument names. Write the value out, or print it with echo on its own.`)
        const declared = !invocation.wrapped && !invocation.words.some((word) => word.role === 'environment-assignment-value')
            ? resolved.declaredAllows.find(rule => ruleMatches(invocation, rule)) : undefined
        // A rule admits a command, never a search the guard found would read a secret, nor a hard boundary's ask.
        if (declared && searchRefusals.has(invocation)) return searchRefusals.get(invocation)!
        const boundary = boundaryAsks.get(invocation)
        if (boundary) return boundary
        if (declared) { declaredReasons.push(declared.reason); continue }
        // The parser follows a launcher (`npx`, `pnpm exec`, `bun run`) with the program it runs. A grant
        // or declared command for the launcher spelling admits that program as it always has.
        const launcher = invocations[invocations.indexOf(invocation) - 1]
        if (invocation.wrapped && launcher && launchedBy(invocation, launcher) && (resolved.declaredAllows.some(rule => ruleMatches(launcher, rule))
            || resolved.projectCommands.some((profile) => profile.executable === launcher.executable && profile.checkoutRoot === launcher.cwd
                && profile.argv.length === launcher.argv.length && profile.argv.every((word, at) => word === launcher.argv[at])))) continue
        const pending = askDecisions.get(invocation)
        if (pending) return pending
        const assignments = invocation.words.filter((word) => word.role === 'environment-assignment-value') as ReadonlyArray<{ readonly value: string; readonly name?: string }>
        if (!open && (invocation.wrapped || assignments.length)) return ask('Wrapped or environment-modifying invocation requires human approval.')
        // Git's location variables point it at state the guard does not inspect, HOME and XDG_CONFIG_HOME
        // choose the configuration that names hooks, and a relative PATH entry runs a file the agent wrote.
        const steering = assignments.find(steers)
        if (steering) return ask(steering.name === undefined ? 'An environment assignment the guard could not name requires human approval.'
            : `${named(invocation)} sets ${steering.name}, which changes what Git, the shell or the command search path runs. Run it without that assignment.`)
        if (invocation.executable === null) continue
        const matches = (profile: { executable: string; argv: readonly string[] }, cwd: string) => profile.executable === invocation.executable
            && cwd === invocation.cwd && profile.argv.length === invocation.argv.length && profile.argv.every((word, i) => word === invocation.argv[i])
        if (containerCommands.has(invocation) && !open) {
            if (resolved.projectCommands.some((profile) => matches(profile, profile.checkoutRoot))) continue
            return ask(`${named(invocation)} runs inside the product container, whose filesystem the guard cannot see, so no read-only proof about host paths covers it. `
                + `The guard admits it only as a declared build or test command or under a [guards] allow rule; a person approves it or runs it in a terminal, or admits it for good under [guards] allow in ${posix.basename(resolved.configPath)}.`)
        }
        if (!readOnly.has(invocation) && !resolved.cockpitInvocations.some((profile) => matches(profile, profile.cwd))
            && !resolved.projectCommands.some((profile) => matches(profile, profile.checkoutRoot))) {
            // Under the allow default only three kinds still need a person: a cockpit command its own
            // table does not admit (sync and upgrade publish policy), a reading command whose shape the
            // read-only profile could not prove reads no secret, and Git that prints committed content.
            const executable = posix.basename(invocation.executable)
            // A blocked list over a shell is never complete: a program the guard does not know can do what
            // the list forbids without naming it. So the allow default admits only the development tools
            // it knows, judged by their own rules, and a program running inline code asks.
            // `pnpm build`, `yarn lint` and `bun run test` run the package's script of that name when it has
            // one, and package scripts are the project's own commands; only `exec`, `dlx` and `x` name a program.
            const runner = invocations[invocations.indexOf(invocation) - 1]
            // With -r or --filter pnpm runs the script in workspace packages, so one any of them declares counts.
            const packageScript = (launcher: ParsedInvocation, word: string) => {
                const selects = launcher.argv.slice(0, launcher.argv.length - invocation.argv.length - 1)
                    .some(arg => ['-r', '--recursive', 'recursive', 'multi', 'm', '-F', '--filter', '--filter-prod'].includes(arg) || /^--filter(?:-prod)?=/.test(arg))
                const manifest = manifestFacts('.', launcher.cwd, selects)
                return manifest !== undefined && (manifest.scripts.includes(word) || manifest.workspace?.includes(word) === true)
            }
            // pnpm runs any other word as a program, and `bun run` a file, so a word counts as a script only
            // where the nearest package.json declares it; any other is judged as the program it is.
            const script = invocation.wrapped && runner !== undefined && launchedBy(invocation, runner) && ['pnpm', 'yarn', 'bun', 'npm'].includes(posix.basename(runner.executable ?? ''))
                && !runner.argv.slice(0, runner.argv.length - invocation.argv.length - 1).some(word => ['exec', 'dlx', 'x', '--package', '-p'].includes(word))
                && (packageScript(runner, invocation.executable)
                    || posix.basename(runner.executable ?? '') === 'bun' && /\.[cm]?[jt]sx?$/.test(invocation.executable) && inRoots(posix.resolve(invocation.cwd, invocation.executable)))
            const unknown = open && !script && !knownTool(invocation, resolved.allowedRoots)
            // Compose starts containers that can mount any host path; cockpit's own commands run the declared stack.
            if (unknown && ['docker', 'docker-compose'].includes(executable) && (executable === 'docker-compose' || invocation.argv.includes('compose'))) {
                return ask(`${named(invocation)} runs Docker Compose, whose services can mount any host path, which the guard cannot judge. For the cockpit's own stack, run \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config ${posix.basename(resolved.configPath)}\`, or \`logs <service>\` or \`ps\` the same way; otherwise a person approves it or runs it.`)
            }
            if (unknown && !cockpitCommand(invocation)) return ask(`${named(invocation)} is not a development tool the guard knows, or runs inline code it cannot judge. A person approves it or runs it, or admits it under [guards] allow in ${posix.basename(resolved.configPath)}.`)
            // `cat > file <<'EOF'` writes the heredoc to the file the redirect names, which was judged as a write.
            const heredocWriter = executable === 'cat' && invocation.argv.length === 0 && invocation.redirects.length > 0 && invocation.redirects.every(redirect => redirect.write)
                && invocation.words.some(word => word.role === 'heredoc-body')
            if (open && !containerCommands.has(invocation) && !cockpitCommand(invocation) && (!READING_EXECUTABLES.has(executable) || heredocWriter)
                && !(executable === 'git' && gitPrintsContent(gitInvocation(invocation)))) continue
            if (open && cockpitCommand(invocation)) return ask(`${named(invocation)} is a cockpit command that publishes policy or is not one an agent runs: \`sync\`, \`upgrade\` and the other commands that change what agents may do are a person's. A person runs it in a terminal.`)
            const config = /^[\w./@%+=:,-]+$/.test(resolved.configPath) ? resolved.configPath : `'${resolved.configPath.replaceAll("'", "'\\''")}'`
            if (invocation.executable === 'node' && invocation.argv[0] === '--test') return ask(`${named(invocation)} requires human approval: Node tests execute code. Keep this Node argv: a person admits it under [guards] allow in ${posix.basename(resolved.configPath)}, `
                + `or declares it as a [[testing.stages]] command in a gate that agents run with \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config ${config} --gate <gate>\`; a gate whose stages use another runner does not run this verifier.`)
            // Under the allow default only a reading command or Git printing content reaches here: one whose form the
            // read-only profile cannot prove reads no secret.
            if (open && !containerCommands.has(invocation)) return searchRefusals.get(invocation) ?? ask(`${named(invocation)} reads files in a form the guard cannot prove reads no secret. `
                + 'Use a form it reads: `rg` or `git grep <pattern> -- <path>` to search, `rg -C3` for context, `sed -n \'N,Mp\' <file>` or `tail -n <count> <file>` for a range, '
                + '`git show <rev> -- <path>` or `git show <rev>:<path>` for history, and the Write tool or `tee <file> <<\'EOF\'` to write. A person approves it otherwise.')
            return searchRefusals.get(invocation) ?? ask(`${named(invocation)} requires human approval: the guard admits only the read-only commands it classifies, a declared build or test command run from its checkout, and [guards] allow rules. `
                + `A person approves it or runs it in a terminal. To run tests, use \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config ${config} --gate <gate>\`; a person can admit a command for good under [guards] allow in ${posix.basename(resolved.configPath)}.`)
        }
    }
    return declaredReasons.length === 1 ? { decision: 'allow', reason: declaredReasons[0]! } : allowed
}
