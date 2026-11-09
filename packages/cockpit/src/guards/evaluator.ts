import { posix } from 'node:path'
import { DOTENV_DOCUMENTATION, errorCause, snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_INPUT_LIMITS, isParsedGuardInput, shownGuardWord, type ParsedInvocation } from './invocation-parser.js'
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
     * holds, or null when Git could not say.
     */
    /** `list` reads names only; it is asked for a listing outside the roots, where a directory may be listed but not read. */
    readonly operation: 'cwd' | 'write' | 'stage' | 'read' | 'list' | 'remove' | 'search' | 'unignored-search' | 'repository' | 'branch'
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
function within(path: string, root: string): boolean { return path === root || path.startsWith(root + '/') }
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
    if (!record(p) || !keys(p, ['canonicalRoot', 'configPath', 'allowedRoots', 'instances', 'templates', 'protectedIdentities', 'protectedBranches', 'hostedDatabaseHosts', 'vendorHosts', 'declaredAllows', 'declaredDenies', 'ripgrepConfigActive', 'executionDirectories', 'searchDirectories', 'searchPathRelativeEntry', 'secretFileIdentities', 'protectedFilesLinked', 'cockpitInvocations', 'cockpitLaunchers', 'projectCommands', ...p.mcpAllowedTools === undefined ? [] : ['mcpAllowedTools'], ...p.externalReads === undefined ? [] : ['externalReads'], ...p.readPaths === undefined ? [] : ['readPaths'], ...p.defaultDecision === undefined ? [] : ['defaultDecision'], ...p.homeDirectory === undefined ? [] : ['homeDirectory']])
        || p.readPaths !== undefined && (!strings(p.readPaths) || p.readPaths.length > 64 || !p.readPaths.every(canonical))
        || p.externalReads !== undefined && p.externalReads !== 'grant' && p.externalReads !== 'native'
        || p.defaultDecision !== undefined && p.defaultDecision !== 'allow' && p.defaultDecision !== 'ask'
        || p.homeDirectory !== undefined && (!canonical(p.homeDirectory) || p.homeDirectory === '/')
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
    const expected = new Set([...p.instances.map((item) => (item as JsonSnapshotObject).path as string), p.configPath as string,
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
export const GUARD_BRANCH_VERBS: ReadonlySet<string> = new Set(['push', 'commit', 'rebase', 'reset', 'filter-branch', 'filter-repo'])
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

const REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'trash'])

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

function tarExtractionWrites(args: readonly string[]): VisibleWrites {
    let extraction = false
    let destination = '.'
    let archive: string | undefined
    let uncertain = false
    let options = true
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (options && arg === '--') { options = false; continue }
        if (!options || !arg.startsWith('-') || arg === '-') continue
        if (arg === '-x' || arg === '--extract' || arg === '--get') { extraction = true; continue }
        if (arg === '-xf') {
            extraction = true
            archive = args[++index]
            if (archive === undefined) uncertain = true
            continue
        }
        if (arg === '-f' || arg === '--file') {
            archive = args[++index]
            if (archive === undefined) uncertain = true
            continue
        }
        if (arg.startsWith('--file=')) {
            archive = arg.slice('--file='.length)
            if (!archive) uncertain = true
            continue
        }
        if (arg === '-C' || arg === '--directory') {
            const value = args[++index]
            if (value === undefined) uncertain = true
            else destination = value
            continue
        }
        if (arg.startsWith('--directory=')) {
            const value = arg.slice('--directory='.length)
            if (!value) uncertain = true
            else destination = value
            continue
        }
        if (/^-[^-]*x/.test(arg) || arg.startsWith('--extract=') || arg.startsWith('--get=')) extraction = true
        uncertain = true
    }
    return { paths: extraction ? [destination] : [], reads: archive === undefined ? [] : [archive], removes: false, uncertain: uncertain || !extraction }
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
        return { paths: transfer.writes, reads: name === 'mv' ? [] : transfer.sources, removes: false, uncertain: transfer.uncertain }
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
    if (name === 'tar') return tarExtractionWrites(invocation.argv)
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

/** The repository's current branch and where a bare `git push` goes, as full ref names, or null when Git could not say. */
interface BranchFacts { readonly head: string | null; readonly push: string | null }

const PUSH_FORCE = /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes)$/
const PUSH_DELETE = /^(?:-d|--delete|--prune|--mirror)$/

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
    for (let i = 0; i < args.length; i++) {
        const value = args[i]!
        if (options && value === '--') { options = false; continue }
        if (options && value.startsWith('-')) {
            if (PUSH_FORCE.test(value)) forced = true
            else if (PUSH_DELETE.test(value)) { deleting = true; if (value === '--mirror') allBranches = true }
            else if (value === '--no-verify') return deny('Refusing `--no-verify`: it skips the repository\'s pre-push hook. Push without it.')
            else if (/^--(?:receive-pack|exec)(?:=|$)/.test(value)) return deny('Refusing a push that names the program to run on the receiving side. Push without --receive-pack or --exec.')
            else if (value === '--all') allBranches = true
            else if (['-o', '--push-option', '--repo'].includes(value)) {
                if (args[++i] === undefined) { uncertain = true; continue }
                // --repo supplies the remote rather than a positional remote.
                if (value === '--repo') positionals.unshift(args[i]!)
            } else if (value.startsWith('--push-option=')) continue
            else if (value.startsWith('--repo=')) positionals.unshift(value.slice(7))
            else if (!['-u', '--set-upstream', '--tags', '--follow-tags', '--dry-run', '-n', '-v', '--verbose', '-q', '--quiet', '--atomic', '--porcelain'].includes(value)) uncertain = true
        } else positionals.push(value)
    }
    const protectedDenial = deny('Refusing push to a declared protected branch.')
    if (allBranches && branches.length) return protectedDenial
    const protectedRef = (ref: string) => branches.some((branch) => ref === branch || ref === `refs/heads/${branch}`)
    for (const ref of positionals.slice(1)) {
        if (ref.startsWith('+')) forced = true
        const spec = ref.replace(/^\+/, '')
        const colon = spec.indexOf(':')
        if (colon === 0) deleting = true
        const source = colon < 0 ? spec : spec.slice(0, colon)
        let destination = colon < 0 ? spec : spec.slice(colon + 1)
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
        if (!facts?.push) uncertain = true
    }
    if (forced) return deny('Refusing a force push: it can discard commits on the remote. Push new commits instead, or a person runs it.')
    if (deleting) return deny('Refusing to delete remote branches: `--delete`, `:<branch>`, `--prune` and `--mirror` remove branches on the remote. A person runs it.')
    if (uncertain) return ask('The guard could not tell which remote branch this push updates. Name it: `git push origin <branch>:<branch>`.')
    return undefined
}

// Key spellings Git reads as a program to run, or as a place it loads more configuration from: set by
// an agent, they would make the person's later Git commands run agent-written code.
const GIT_PROGRAM_KEY = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|attributesfile)|sequence\.editor|.*\.helper|alias\..*|filter\..*|diff\..*\.(?:command|textconv)|merge\..*\.driver|gpg\..*|include(?:if)?\..*|protocol\..*|url\..*|remote\..*|credential\..*|uploadpack\..*|receive\..*|ssh\..*|pager\..*|interactive\..*|man\..*|web\..*|difftool\..*|mergetool\..*|instaweb\..*|sendemail\..*)$/i
// Configuration writes an agent may make in the checkout's own configuration under the allow default.
const GIT_PLAIN_KEY = /^(?:user\.(?:name|email)|init\.defaultbranch|pull\.(?:rebase|ff)|push\.(?:default|autosetupremote|followtags)|rebase\.(?:autostash|autosquash|updaterefs)|merge\.(?:ff|conflictstyle)|branch\.[^.\s]+\.(?:merge|rebase)|color\.[a-z.]+|advice\.[a-z]+|status\.[a-z]+|log\.[a-z]+|commit\.(?:verbose|cleanup)|fetch\.prune|rerere\.enabled|core\.(?:autocrlf|filemode|ignorecase|quotepath|eol|safecrlf))$/i

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
    /^\.claude\/\.credentials\.json$/, /^\.config\/gcloud\//, /^\.azure\//, /^library\/keychains\//, /^\.git-credentials$/]
const KEY_FILE = /^(?:.*\.(?:pem|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?!.*\.pub$).*)$/

function credentialStore(folded: string, home: string | undefined): boolean {
    if (KEY_FILE.test(posix.basename(folded))) return true
    if (home === undefined) return false
    const foldedHome = fold(home)
    return within(folded, foldedHome) && folded !== foldedHome && HOME_CREDENTIALS.some(pattern => pattern.test(folded.slice(foldedHome.length + 1)))
}

/**
 * Files a command writes through an option rather than an operand: Git's patch output, downloads,
 * sorted output and in-place edits. Each is judged as a write, whatever grant admits the command.
 */
function optionWrites(invocation: ParsedInvocation, git: GitInvocation | undefined): { readonly cwd: string; readonly paths: readonly string[] } | undefined {
    if (invocation.executable === null) return undefined
    const name = posix.basename(invocation.executable)
    const args = git ? git.args : invocation.argv
    const paths: string[] = []
    const valued = (short: readonly string[], long: readonly string[]) => {
        for (let index = 0; index < args.length; index++) {
            const arg = args[index]!
            if (arg === '--') break
            const equals = arg.indexOf('=')
            if (arg.startsWith('--') && equals > 0 && long.includes(arg.slice(0, equals))) paths.push(arg.slice(equals + 1))
            else if (long.includes(arg) || short.includes(arg)) { if (args[index + 1] !== undefined) paths.push(args[++index]!) }
            else if (!arg.startsWith('--') && short.some(flag => arg.startsWith(flag) && arg.length > flag.length)) paths.push(arg.slice(2))
        }
    }
    if (git && ['diff', 'log', 'show', 'format-patch', 'range-diff'].includes(git.verb)) valued(git.verb === 'format-patch' ? ['-o'] : [], ['--output', '--output-directory'])
    else if (name === 'curl') valued(['-o', '-D', '-c'], ['--output', '--output-dir', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--stderr'])
    else if (name === 'wget') valued(['-O', '-P', '-o', '-a'], ['--output-document', '--directory-prefix', '--output-file', '--append-output'])
    else if (name === 'sort') valued(['-o'], ['--output'])
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
    return paths.length ? { cwd: git?.cwd ?? invocation.cwd, paths } : undefined
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

/** Whether an invocation names the cockpit CLI, however it is launched. */
function cockpitShaped(invocation: ParsedInvocation): boolean {
    const words = [invocation.executable ?? '', ...invocation.argv.slice(0, 3)]
    return words.some(word => ['cockpit', 'cockpit.mjs'].includes(posix.basename(word)) || word.includes('@b00dea/cockpit'))
}

// Options that name a program for Git to run on either side of a transfer.
function gitProgramOption(git: GitInvocation): boolean {
    if (!['fetch', 'pull', 'push', 'clone', 'ls-remote', 'archive', 'submodule', 'remote'].includes(git.verb)) return false
    return git.args.some(arg => /^--(?:upload-pack|receive-pack|exec)(?:=|$)/.test(arg) || ['clone', 'ls-remote'].includes(git.verb) && arg === '-u')
}

/** Hard boundaries are independent of grants and are evaluated across the complete capture. */
export function evaluateGuard(input: unknown, policy: unknown, inspect: PathInspection): GuardDecision {
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
    const credentialDenial = deny('Refusing to read, print or send a credential store: SSH and cloud keys, token files such as ~/.npmrc, ~/.netrc or ~/.codex/auth.json, and .pem, .p12 or id_* key files hold credentials. A person handles them.')
    // The current branch and where a bare push goes, for the repository at `cwd`, as Git reports them.
    const branchFacts = (cwd: string): BranchFacts | undefined => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect({ path: '.', cwd, operation: 'branch' })) }
        catch { return undefined } // no answer is an unresolved branch, which only ever asks
        const ref = (value: unknown) => value === null || typeof value === 'string' && /^refs\/[^\s]+$/.test(value)
        return record(evidence) && evidence.status === 'resolved' && evidence.path === cwd && ref(evidence.head) && ref(evidence.push)
            ? { head: evidence.head as string | null, push: evidence.push as string | null } : undefined
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
    const resolvedEvidence = (request: PathInspectionRequest): JsonSnapshotObject | undefined => {
        let evidence: JsonSnapshot | undefined
        inspectionFailure = undefined
        try { evidence = snapshotJson(inspect(request)) }
        catch (error) { inspectionFailure = errorCause(error); return undefined }
        const lexical = posix.resolve(request.cwd, request.path)
        const listed = request.operation === 'search' || request.operation === 'unignored-search' ? 'sensitive' : request.operation === 'repository' ? 'tracked' : undefined
        const canonicalPath = evidence !== undefined && record(evidence) ? evidence.canonicalPath : undefined
        const observedPath = canonicalPath ?? lexical
        const paths = listed && evidence !== undefined && record(evidence) ? evidence[listed] : null
        return record(evidence) && keys(evidence, ['status', 'path', 'symlink', 'identity', 'ancestors', ...(listed ? [listed] : []), ...(canonicalPath === undefined ? [] : ['canonicalPath'])]) && evidence.status === 'resolved'
            && (canonicalPath === undefined || ['read', 'search', 'unignored-search'].includes(request.operation) && canonical(canonicalPath)
                && resolved.allowedRoots.some(root => within(lexical, root)) && resolved.allowedRoots.some(root => within(canonicalPath, root)))
            && evidence.path === lexical && evidence.symlink === false && (evidence.identity === null || identity(evidence.identity))
            && Array.isArray(evidence.ancestors) && evidence.ancestors.every(identity)
            && (paths === null || Array.isArray(paths) && paths.length <= GUARD_LOCATION_LIMITS.sensitivePaths
                && paths.every((path) => canonical(path) && typeof observedPath === 'string' && within(path, observedPath))) ? evidence : undefined
    }
    let pathCount = input.paths.length + input.invocations.reduce((sum, item) => sum + item.redirects.length, 0)
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
        if (mutating && dotenvSecret(folded)) hold(dotenvDenial)
        if (mutating && resolved.instances.some((item) => folded === fold(item.path) || (staging || removing) && within(fold(item.path), folded))) hold(staging && !resolved.instances.some((item) => folded === fold(item.path)) ? coveringStageDenial : instanceDenial)
        if (request.operation === 'write' && (controlFiles.some((path) => folded === fold(path) || controlCoverage && within(fold(path), folded))
            || controlDirectories.some((path) => within(folded, fold(path)) || controlCoverage && within(fold(path), folded)))) hold(controlDenial)
        if (request.operation === 'write' && executes(folded, controlCoverage)) hold(executionDenial)
        if (request.operation === 'write' && posix.basename(folded) === '.npmrc') hold(npmrcDenial)
        if (mutating && folded.split('/').includes('.git')) hold(gitMetadataDenial)
        if (!resolved.allowedRoots.some((root) => within(lexical, root)) && !(request.operation === 'cwd' && approvedReadCwd)) {
            hold(unavailable(request.operation === 'write'
                ? 'Guard path escapes configured roots. This command writes outside every root this cockpit manages, and no [guards] allow rule grants a write there: write inside the cockpit, or a person runs the command.'
                : request.operation === 'cwd'
                    ? 'Guard path escapes configured roots. A working directory in this command is outside every root this cockpit manages. A person can admit one read-only Git command in a related checkout, such as `git -C <checkout> status --short` or `git -C <checkout> log`, by its complete argv with a managed cwd under [guards] allow and a sync; it then runs only as the whole command. Commands that print file content there, such as diff or show, stay refused. Otherwise work inside the cockpit, or a person runs the command.'
                    : 'Guard path escapes configured roots. A path in this command is outside every root this cockpit manages, which the guard does not judge: work inside the cockpit, or a person runs the command.'))
            return
        }
        const evidence = resolvedEvidence(request)
        if (!evidence) {
            hold(unavailable(`Guard path inspection failed, or its evidence is missing, symlinked or mismatched${inspectionFailure === undefined ? '' : ` (${inspectionFailure})`}.`))
            return
        }
        if (!mutating) return evidence
        // Identity catches every spelling the volume resolves to a protected entry, including ones
        // the shared normalisation does not equate, such as a hard link.
        const { is, below, covers } = evidenceFacts(evidence)
        if (below(secretRoot) || secretFile(evidence)) hold(secretDenial)
        else if ((staging || removing) && covers(secretRoot)) hold(staging ? coveringStageDenial : secretDenial)
        if (resolved.instances.some((item) => is(item.path))) hold(instanceDenial)
        else if ((staging || removing) && resolved.instances.some((item) => covers(item.path))) hold(staging ? coveringStageDenial : instanceDenial)
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
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) return true
        const evidence = inspectPath({ path, cwd, operation: 'remove' })
        if (!evidence) return false
        const { below, covers } = evidenceFacts(evidence)
        if (structural.some(covers)) { hold(structuralDenial); return false }
        if (controlFiles.some(covers) || controlDirectories.some((target) => covers(target) || below(target))) hold(controlDenial)
        return false
    }
    const inspectPossibleControlOperand = (path: string, cwd: string) => {
        if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) return
        const lexical = posix.resolve(cwd, path)
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) return
        const folded = fold(lexical)
        if (controlFiles.some((target) => within(fold(target), folded))
            || controlDirectories.some((target) => within(folded, fold(target)) || within(fold(target), folded))) {
            hold(unavailable('Invocation names a guard control but its filesystem effect is not classified.'))
            return
        }
        const evidence = resolvedEvidence({ path, cwd, operation: 'write' })
        if (!evidence) return
        const { is, below, covers } = evidenceFacts(evidence)
        if (controlFiles.some((target) => is(target) || covers(target))
            || controlDirectories.some((target) => below(target) || covers(target))) {
            hold(unavailable('Invocation names a guard control but its filesystem effect is not classified.'))
        }
    }
    // A symbolic link's text resolves from the link's own directory and a hard link's from the
    // working directory, so a source is checked from both.
    const inspectLinkSource = (source: string, cwd: string, destinations: readonly string[]) => {
        if (!scalar(source) || Buffer.byteLength(source) > GUARD_INPUT_LIMITS.pathBytes) { hold(unavailable('Guard path or working directory is malformed.')); return }
        const protectedTargets = [secretRoot, ...resolved.instances.map((item) => item.path), ...controlFiles, ...controlDirectories].map(fold)
        const bases = new Set([cwd, ...destinations.flatMap((path) => { const target = posix.resolve(cwd, path); return [target, posix.dirname(target)] })])
        for (const base of bases) {
            const folded = fold(posix.resolve(base, source))
            if (folded.split('/').includes('.secrets') || executes(folded, true)
                || protectedTargets.some((target) => within(folded, target) || within(target, folded))) { hold(linkDenial); return }
        }
        if (!resolved.allowedRoots.some((root) => within(posix.resolve(cwd, source), root))) return
        pathCount++
        const evidence = resolvedEvidence({ path: source, cwd, operation: 'read' })
        if (!evidence) return
        const { is, below, covers } = evidenceFacts(evidence)
        if (secretFile(evidence) || [secretRoot, ...controlDirectories].some((path) => is(path) || below(path) || covers(path))
            || [...resolved.instances.map((item) => item.path), ...controlFiles].some((path) => is(path) || covers(path))) hold(linkDenial)
    }
    const searchedProtections = [secretRoot, ...resolved.instances.map((item) => item.path)]
    // Why the last inspected search was not safe, when one protected path is the reason.
    let searchBlocker: GuardDecision | undefined
    // A read-only command is allowed only when every path it touches is evidenced inside the
    // configured roots; reading a protected instance is a hard denial, anything doubtful is not safe.
    // `chainReadOnly` says no other command in the call can create a protected path before the
    // search runs, which is what lets an absent one be ignored.
    // A person's read paths, or native external reads, admit named reads outside the roots; the
    // application then admits only an existing regular file, or a directory to list.
    const readableOutside = (lexical: string) => resolved.externalReads === 'native' || (resolved.readPaths ?? []).some(path => within(lexical, path))
    const inspectReadOnly = (access: ReadOnlyAccess, chainReadOnly = false, approvedExternalRead = false): boolean => {
        let safe = true
        searchBlocker = undefined
        const visit = (path: string, kind: 'read' | 'tree' | 'listing') => {
            if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) { safe = false; return }
            const lexical = posix.resolve(access.cwd, path)
            const folded = fold(lexical)
            // A search rooted at or below a protected path reads it as surely as `cat` does; only a
            // listing, which reports names, may name one.
            const protectedRead = folded.split('/').includes('.secrets') || resolved.instances.some((item) => within(folded, fold(item.path)))
            if (kind !== 'listing' && dotenvSecret(folded)) hold(dotenvDenial)
            if (kind !== 'listing' && credential(folded)) hold(credentialDenial)
            if (kind !== 'listing' && protectedRead) hold(readDenial)
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
            const evidence = resolvedEvidence({ path, cwd: access.cwd, operation: kind === 'tree' ? access.skipsIgnored ? 'unignored-search' : 'search' : kind === 'listing' && external ? 'list' : 'read' })
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
            const { is, below, covers } = evidenceFacts(evidence)
            if (kind !== 'listing' && (is(secretRoot) || below(secretRoot) || secretFile(evidence) || resolved.instances.some((item) => is(item.path)))) hold(readDenial)
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
                ? `A recursive search of ${path} would read ${shown(present)}, a declared environment instance or secrets directory. Search a path that does not contain it.`
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
        holdAsk(invocation, ask(UNPROVEN_LAUNCHER))
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
    inspectPath({ path: input.cwd, cwd: input.cwd, operation: 'cwd' })
    for (const path of input.removed) {
        if (inspectRemoval(path, input.cwd)) hold(unavailable('Removal path escapes configured roots.'))
    }
    for (const path of input.paths) inspectPath({ path, cwd: input.cwd, operation: 'write' })
    for (const invocation of invocations) {
        // Redirects, heredocs, comments and definitions are not executable host use.
        // A host passed to printf is still an argument and remains a hard denial.
        for (const word of invocation.words) {
            if (!['executable', 'argument', 'environment-assignment-value'].includes(word.role)) continue
            if (resolved.hostedDatabaseHosts.some((host) => hostUsed(word.value, host))) hold(deny('Refusing executable use of a declared hosted database host.'))
            if (resolved.vendorHosts.some((host) => hostUsed(word.value, host))) hold(deny('Refusing executable use of a declared vendor host.'))
        }
        inspectPath({ path: invocation.cwd, cwd: invocation.cwd, operation: 'cwd' })
        for (const redirect of invocation.redirects) {
            // A control file's own denial names the stronger boundary, so it is held last.
            if (redirect.truncate) inspectRemoval(redirect.target, invocation.cwd)
            if (redirect.write) inspectPath({ path: redirect.target, cwd: invocation.cwd, operation: 'write' })
        }
        const git = gitInvocation(invocation)
        const removed = removedOperands(invocation, git)
        for (const path of removed?.paths ?? []) {
            if (inspectRemoval(path, removed!.cwd) && !approvalBarriers.has(invocation)) {
                approvalBarriers.set(invocation, ask('Removal outside configured roots requires human approval.'))
            }
        }
        const { operands } = launchedCockpit(invocation)
        const access = accesses.get(invocation)
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
            for (const source of writes.links ?? []) inspectLinkSource(source, writeCwd, writes.paths)
            if (writes.reads?.length && !inspectReadOnly({ cwd: invocation.cwd, reads: writes.reads, trees: [], listings: [] })) {
                hold(unavailable('Visible writer source is unavailable or unsafe to read.'))
            }
            if (writes.uncertain) hold(unavailable('Unsupported visible writer option.'))
        } else if (!access && git?.verb !== 'add') {
            // Staging writes the index, never the named file, and its operands are inspected as staged below.
            for (const arg of git?.args ?? operands) {
                if (++possibleControlCount <= GUARD_INPUT_LIMITS.paths) {
                    inspectPossibleControlOperand(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg, git?.cwd ?? invocation.cwd)
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
        // A word whose expansion the guard cannot see decides nothing it inspects: a path read, written,
        // removed or pushed, or a cockpit command. Elsewhere it is the program's own business.
        if (invocation.dynamic && (writes || removed?.paths.length || optioned || git || READING_EXECUTABLES.has(posix.basename(invocation.executable ?? '')) || cockpitShaped(invocation))) {
            const word = invocation.words.find(item => item.dynamic)?.value ?? ''
            holdBoundary(invocation, ask(`${named(invocation)} holds ${shownGuardWord(word)}, whose value the guard cannot see, where it decides which file is read or written or which branch is pushed. Write the value out.`))
        }
        // Printing the environment, or a variable whose name marks it as a secret, prints credentials.
        if (['echo', 'printf', 'printenv'].includes(posix.basename(invocation.executable ?? ''))
            && (invocation.executable === 'printenv' && invocation.argv.length === 0 || invocation.words.some(item => item.role === 'argument'
                && /(?:^|\$\{?|\b)[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|DATABASE_URL)\w*/i.test(item.value)
                && (item.dynamic || invocation.executable === 'printenv')))) {
            hold(deny('Refusing to print the environment or a variable named as a secret: its value is a credential. Print a non-secret variable by name, or list names with `cockpit env keys`.'))
        }
        // A declared rule admits a command the profile cannot classify, but never past the secret names
        // or the roots: macOS `cat a .env -x` prints .env before it rejects -x, and `git show HEAD:.env`
        // prints a committed one. Each argument is judged whole, after `=` and after `:`.
        // A visible writer's operands already meet the stronger mutation and link denials above.
        if (!access && !writes && !removed?.paths.length && (open || resolved.declaredAllows.some(rule => ruleMatches(invocation, rule)))) {
            // A reading command or Git prints what it names; another command, such as `docker compose
            // --env-file .env`, may only pass the name on, so a person decides it.
            const prints = READING_EXECUTABLES.has(invocation.executable!) || invocation.executable === 'git'
            const secretName = (decision: GuardDecision) => prints ? hold(decision)
                : !approvalBarriers.has(invocation) && approvalBarriers.set(invocation, ask(`${named(invocation)} names an environment file, secrets directory or declared instance, so a [guards] allow rule does not admit it. A person approves it or runs it, or declares it as a project command.`))
            for (const word of invocation.argv) {
                // An attached short option value, as in `sed -f.env`, is a candidate too.
                const attached = /^-[^-]/.test(word) && word.length > 2 ? [word.slice(2)] : []
                // `@file` is how curl and gh name a file whose content they send.
                for (const candidate of new Set([word, word.slice(word.indexOf('=') + 1), word.slice(word.lastIndexOf(':') + 1), word.slice(word.lastIndexOf('@') + 1), ...attached])) {
                    if (!candidate || candidate.startsWith('-') || !scalar(candidate)) continue
                    const lexical = posix.resolve(invocation.cwd, candidate)
                    const folded = fold(lexical)
                    if (dotenvSecret(folded)) secretName(dotenvDenial)
                    if (credential(folded)) hold(credentialDenial)
                    if (folded.split('/').includes('.secrets') || resolved.instances.some((item) => within(folded, fold(item.path)))) secretName(readDenial)
                    if (READING_EXECUTABLES.has(invocation.executable!) && !resolved.allowedRoots.some(root => within(lexical, root)) && !readableOutside(lexical) && !approvalBarriers.has(invocation)) {
                        approvalBarriers.set(invocation, ask(`${named(invocation)} names ${shownGuardWord(candidate)}, outside the configured roots, with words the read-only profile cannot classify, so a [guards] allow rule does not admit it. Run it as the rule names it, or a person reviews and admits this complete argv.`))
                    }
                }
            }
        }
        const externalAccess = access ?? classifyReadOnlyInvocation({ ...invocation, redirects: invocation.redirects.filter(item => !item.write) }, { ripgrepConfigActive: resolved.ripgrepConfigActive })
        const outsideRoots = (read: ReadOnlyAccess | undefined) => read && ([read.cwd].some(path => !resolved.allowedRoots.some(root => within(posix.resolve(read.cwd, path), root)))
            || [...read.reads, ...read.trees, ...read.listings].some(path => { const lexical = posix.resolve(read.cwd, path)
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
        const nativeGit = resolved.externalReads === 'native' && externalGit(invocation, access)
        const alone = invocations.length === 1
        const approvedExternalRead = nativeGit && alone || !!approvedReadOnlyInvocation(invocation, resolved) && (chainReadOnly || externalGit(invocation, access) && alone)
        if (access && inspectReadOnly(access, chainReadOnly || nativeGit && alone, approvedExternalRead)) readOnly.add(invocation)
        else if (searchBlocker) searchRefusals.set(invocation, searchBlocker)
        if (external && (!approvedExternalRead || !readOnly.has(invocation))) approvalBarriers.set(invocation, searchBlocker
            ?? ask(nativeGit
                ? `${named(invocation)} runs Git in a directory outside the configured roots. With native external reads the guard leaves a read-only Git command there to the agent tool only as the whole call, from a directory holding its own .git, with operands that name regular files or revisions rather than directories or links: run it on its own from the repository's top directory.`
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
            if (profile.alone && (input.invocations.length !== 1 || invocation.redirects.length > 0)) {
                holdAsk(invocation, ask('env schema --replace-from runs without a prompt only as the whole command: another command in this call could change the draft after the guard proved it safe. Run it on its own.'))
            }
        }
        if (!git) continue
        // Git changes directory as the system does, resolving `..` from where a link leads, so each
        // directory is inspected as spelled rather than by the path `cwd` names.
        for (const directory of git.directories) inspectPath({ ...directory, operation: 'cwd' }, false, nativeGit || approvedExternalRead && readOnly.has(invocation))
        const globals = gitGlobalOptions(invocation.argv)
        const programKey = globals.keys.find(key => GIT_PROGRAM_KEY.test(key))
        if (programKey) hold(deny(`Refusing \`git -c ${programKey}\`: that key chooses a program Git runs or where it loads configuration from, such as the hooks. Run the command without it.`))
        if (git.uncertain && (!open || globals.other)) holdAsk(invocation, ask('Git execution context is not an exact resolved profile: --git-dir, --work-tree, --namespace and --config-env point Git at state the guard does not inspect. Run Git from the repository, or with -C <directory>.'))
        if (git.args.includes('--no-verify') || git.verb === 'commit' && git.args.some(arg => /^-[a-zA-Z]+$/.test(arg) && /^[^mFcCtSu]*n/.test(arg.slice(1)))) {
            hold(deny('Refusing `--no-verify`: it skips the repository\'s hooks. Run the command without it, and fix what a hook reports.'))
        }
        if (gitProgramOption(git)) hold(deny('Refusing a Git transfer that names the program to run on the other side (--upload-pack, --receive-pack or --exec). Run it without that option.'))
        const protectedName = (name: string | undefined) => name !== undefined && resolved.protectedBranches.some(branch => name === branch || name === `refs/heads/${branch}`)
        if (git.verb === 'push') {
            const decision = pushDecision(git.args, resolved.protectedBranches, branchFacts(git.cwd))
            if (decision?.decision === 'deny') hold(decision)
            else if (decision) holdBoundary(invocation, decision)
        }
        // New commits only append; these rewrite the current branch's history, or move a branch outright.
        const positional = git.args.filter(arg => !arg.startsWith('-'))
        const rewritesHead = git.verb === 'commit' && git.args.includes('--amend') || git.verb === 'filter-branch' || git.verb === 'filter-repo'
            || git.verb === 'rebase' && !git.args.some(arg => ['--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch'].includes(arg))
            || git.verb === 'reset' && git.args.some(arg => ['--hard', '--soft', '--mixed', '--keep', '--merge'].includes(arg)) && positional.some(arg => !['HEAD', '@'].includes(arg))
        if (rewritesHead) {
            const facts = branchFacts(git.cwd)
            if (protectedName(facts?.head ?? undefined)) hold(deny('Refusing to rewrite history on a declared protected branch. Switch to a work branch first.'))
            else if (open && !facts?.head) holdBoundary(invocation, ask('The guard could not tell which branch this rewrites. Run it on a named work branch.'))
        }
        const moved = git.verb === 'branch' && git.args.some(arg => /^-[a-zA-Z]*[fDdmMcC]/.test(arg) || ['--force', '--delete', '--move', '--copy'].includes(arg))
            || ['checkout', 'switch'].includes(git.verb) && git.args.some(arg => ['-B', '-C', '--force-create'].includes(arg))
            || git.verb === 'update-ref'
        if (moved && positional.some(arg => protectedName(arg))) hold(deny('Refusing to move, reset or delete a declared protected branch.'))
        if (git.verb === 'config' && !gitConfigReads(git.args) && !(open && gitConfigPlainWrite(git.args))) hold(gitMetadataDenial)
        else if (git.verb === 'config' && gitConfigReads(git.args) && !access) holdAsk(invocation, ask(`${named(invocation)} prints configuration the guard cannot bound: a listing, a pattern, another file or a key outside a few sections can print a remote URL, an http header or a credential helper that holds a credential. Read one key with \`git config --get <key>\` from a section such as user, core or init, or a person runs it.`))
        // Git metadata decides what read-only Git commands show and run, so agents do not write it.
        if (git.verb === 'fetch' && !open) holdAsk(invocation, ask(`${named(invocation)} requires human approval: fetching writes objects and refs under .git, which agents do not write. To compare with another repository, read it in place with \`git -C <repository> log --oneline <branch>\`, which outside the configured roots needs [guards] external_reads = "native" or a grant; otherwise a person runs the fetch, or admits its complete argv under [guards] allow in ${posix.basename(resolved.configPath)}.`))
        if (!open && git.verb === 'reset' && git.args.includes('--hard') || git.verb === 'clean' && git.args.some((arg) => /^-[^-]*[fdxX]/.test(arg) || arg === '--force')) holdAsk(invocation, ask('Destructive Git operation requires human approval.'))
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
        const pending = askDecisions.get(invocation)
        if (pending) return pending
        const assignments = invocation.words.filter((word) => word.role === 'environment-assignment-value') as ReadonlyArray<{ readonly value: string; readonly name?: string }>
        if (!open && (invocation.wrapped || assignments.length)) return ask('Wrapped or environment-modifying invocation requires human approval.')
        // Git's location variables point it at state the guard does not inspect, HOME and XDG_CONFIG_HOME
        // choose the configuration that names hooks, and a relative PATH entry runs a file the agent wrote.
        const steering = assignments.find(({ name, value }) => name === undefined || /^(?:GIT_.*|HOME|XDG_CONFIG_HOME|BASH_ENV|ENV)$/.test(name)
            || name === 'PATH' && value.split(':').some(entry => !entry.startsWith('/')))
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
            if (open && !containerCommands.has(invocation) && !cockpitShaped(invocation) && !READING_EXECUTABLES.has(executable)
                && !(executable === 'git' && gitPrintsContent(gitInvocation(invocation)))) continue
            if (open && cockpitShaped(invocation)) return ask(`${named(invocation)} is a cockpit command that publishes policy or is not one an agent runs: \`sync\`, \`upgrade\` and the other commands that change what agents may do are a person's. A person runs it in a terminal.`)
            const config = /^[\w./@%+=:,-]+$/.test(resolved.configPath) ? resolved.configPath : `'${resolved.configPath.replaceAll("'", "'\\''")}'`
            if (invocation.executable === 'node' && invocation.argv[0] === '--test') return ask(`${named(invocation)} requires human approval: Node tests execute code. Keep this Node argv: a person admits it under [guards] allow in ${posix.basename(resolved.configPath)}, `
                + `or declares it as a [[testing.stages]] command in a gate that agents run with \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config ${config} --gate <gate>\`; a gate whose stages use another runner does not run this verifier.`)
            return searchRefusals.get(invocation) ?? ask(`${named(invocation)} requires human approval: the guard admits only the read-only commands it classifies, a declared build or test command run from its checkout, and [guards] allow rules. `
                + `A person approves it or runs it in a terminal. To run tests, use \`./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config ${config} --gate <gate>\`; a person can admit a command for good under [guards] allow in ${posix.basename(resolved.configPath)}.`)
        }
    }
    return declaredReasons.length === 1 ? { decision: 'allow', reason: declaredReasons[0]! } : allowed
}
