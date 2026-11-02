import { posix } from 'node:path'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_INPUT_LIMITS, isParsedGuardInput, type ParsedInvocation } from './invocation-parser.js'
import { GUARD_HOST_LIMITS, isGuardHost, normalizeGuardHost } from './host.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from '../environment/install-policy.js'
import { GUARD_LOCAL_PATHS } from './local-identity.js'
import { classifyReadOnlyInvocation, cockpitLauncherPrefix, type ReadOnlyAccess } from './read-only.js'
import { SURFACE_EXECUTION_CONTROL_PATHS } from '../surfaces/harness-registry.js'

export const mechanism = {
    id: 'guard-evaluator', module: 'packages/cockpit/src/guards/evaluator.ts',
    exports: ['evaluateGuard', 'GUARD_ROOT_PROTECTIONS', 'GUARD_PROTECTED_LOCATION_LIMIT', 'GUARD_SECRET_FILE_LIMIT', 'foldGuardSpelling', 'guardIdentity'],
} as const

export interface GuardInvocationProfile {
    readonly executable: string
    readonly cwd: string
    readonly argv: readonly string[]
    /** Files the admitted command reads and may echo back, checked like a read-only command's reads. */
    readonly reads?: readonly string[]
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
export interface GuardDeclaredAllow {
    readonly argv: readonly string[]
    readonly reason: string
    readonly cwd?: string
}
export interface GuardDeclaredDeny {
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
}
export interface PathInspectionRequest {
    readonly path: string
    readonly cwd: string
    /** A `search` is a recursive read; its evidence also carries `sensitive`, every existing path at or below it named `.env*` or `.secrets`, or null past the walk's bound. */
    readonly operation: 'cwd' | 'write' | 'stage' | 'read' | 'remove' | 'search'
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
] as const
// OpenCode loads every module in its plugin directories at start, and the generated Claude plugin
// bundle carries its own MCP servers and hook registration, so no file below them is data. Every
// harness starts the generated MCP wrapper scripts as the server program, so overwriting one changes
// what runs before the next guarded call. The machine-local guard identity names the handler the
// guard launches, so it is a control as well. The work-order store holds accepted contracts, state,
// answers and completions whose digests are unkeyed, so a record an agent wrote there, signed as
// the operator, would be accepted by the next `cockpit work` command: only cockpit writes it.
const GUARD_CONTROL_DIRECTORIES = ['.opencode/plugin', '.opencode/plugins', '.cockpit/bundles/claudecode-plugin', '.cockpit/mcp', GUARD_LOCAL_PATHS.directory,
    '.cockpit/work-orders', '.cockpit/transactions', '.cockpit/actors'] as const
const SECRETS_ROOT = 'env/.secrets'
/** Bounds on the policy's installed-code and search path directories and on the secrets files it enumerates. */
export const GUARD_PROTECTED_LOCATION_LIMIT = 256
export const GUARD_SECRET_FILE_LIMIT = 512
/** Root-relative paths whose identity every policy carries beside each instance's. */
export const GUARD_ROOT_PROTECTIONS: readonly { readonly path: string; readonly type: 'file' | 'directory' }[] = Object.freeze([
    ...GUARD_CONTROL_FILES.map((path) => Object.freeze({ path, type: 'file' as const })),
    ...[...GUARD_CONTROL_DIRECTORIES, SECRETS_ROOT].map((path) => Object.freeze({ path, type: 'directory' as const })),
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
const unavailable = (reason: string): GuardDecision => ({ decision: 'unavailable', reason })
const ask = (reason: string): GuardDecision => ({ decision: 'ask', reason })
const UNPROVEN_LAUNCHER = 'This cockpit command requires human approval: the guard could not prove it starts the installed cockpit. '
    + 'npx --no cockpit counts only from the cockpit root with no root .npmrc and no bin in the root package.json, and bare cockpit only when '
    + 'the command search path finds the installed package; a path such as ./node_modules/.bin/cockpit counts whenever it resolves to the installed package.'
const deny = (reason: string): GuardDecision => ({ decision: 'deny', reason })
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
    if (!record(p) || !keys(p, ['canonicalRoot', 'configPath', 'allowedRoots', 'instances', 'templates', 'protectedIdentities', 'protectedBranches', 'hostedDatabaseHosts', 'vendorHosts', 'declaredAllows', 'declaredDenies', 'ripgrepConfigActive', 'executionDirectories', 'searchDirectories', 'searchPathRelativeEntry', 'secretFileIdentities', 'protectedFilesLinked', 'cockpitInvocations', 'cockpitLaunchers', 'projectCommands'])
        || !canonical(p.canonicalRoot) || !canonical(p.configPath) || posix.dirname(p.configPath) !== p.canonicalRoot || !strings(p.allowedRoots) || !p.allowedRoots.includes(p.canonicalRoot) || !p.allowedRoots.every(canonical)
        || !strings(p.protectedBranches) || !strings(p.hostedDatabaseHosts) || !strings(p.vendorHosts)
        || !Array.isArray(p.instances) || !strings(p.templates) || p.templates.length > GUARD_PROTECTED_LOCATION_LIMIT || !Array.isArray(p.protectedIdentities) || !Array.isArray(p.declaredAllows) || !Array.isArray(p.declaredDenies)
        || typeof p.ripgrepConfigActive !== 'boolean' || typeof p.protectedFilesLinked !== 'boolean' || !Array.isArray(p.cockpitInvocations) || !Array.isArray(p.cockpitLaunchers) || !Array.isArray(p.projectCommands)
        || !strings(p.executionDirectories) || p.executionDirectories.length > GUARD_PROTECTED_LOCATION_LIMIT
        || !strings(p.searchDirectories) || p.searchDirectories.length > GUARD_PROTECTED_LOCATION_LIMIT
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
        || p.cockpitInvocations.some((item) => !record(item) || !keys(item, item.reads === undefined ? ['executable', 'cwd', 'argv'] : ['executable', 'cwd', 'argv', 'reads'])
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

function ruleMatches(invocation: ParsedInvocation, rule: GuardDeclaredAllow | GuardDeclaredDeny): boolean {
    if (invocation.executable === null) return false
    const words = [invocation.executable, ...invocation.argv]
    if ('cwd' in rule && rule.cwd !== undefined && rule.cwd !== invocation.cwd) return false
    if (!('match' in rule) || rule.match === 'prefix') return rule.argv.every((word, index) => words[index] === word)
    return words.some((_, start) => rule.argv.every((word, index) => words[start + index] === word))
}

interface GitInvocation { verb: string; args: readonly string[]; cwd: string; uncertain: boolean }
function gitInvocation(invocation: ParsedInvocation): GitInvocation | undefined {
    if (invocation.executable === null || posix.basename(invocation.executable) !== 'git') return undefined
    const args = invocation.argv
    let cursor = 0
    let cwd = invocation.cwd
    let uncertain = false
    while (args[cursor]?.startsWith('-')) {
        const option = args[cursor++]
        if (option === '--') break
        if (option === '-C') {
            const directory = args[cursor++]
            if (directory === undefined) return { verb: '', args: [], cwd, uncertain: true }
            cwd = posix.resolve(cwd, directory)
        } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option)) {
            cursor++
            uncertain = true
        } else if (['--no-pager', '--paginate', '--no-optional-locks'].includes(option)) {
            continue
        } else if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(option)) {
            uncertain = true
        } else return { verb: '', args: [], cwd, uncertain: true }
    }
    return { verb: args[cursor++] ?? '', args: args.slice(cursor), cwd, uncertain }
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

function pushDecision(args: readonly string[], branches: readonly string[]): GuardDecision | undefined {
    const positionals: string[] = []
    let options = true
    let uncertain = false
    let allBranches = false
    for (let i = 0; i < args.length; i++) {
        const value = args[i]
        if (options && value === '--') { options = false; continue }
        if (options && value.startsWith('-')) {
            if (['--all', '--mirror'].includes(value)) allBranches = true
            else if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(value)) {
                if (args[++i] === undefined) { uncertain = true; continue }
                // --repo supplies the remote rather than a positional remote.
                if (value === '--repo') positionals.unshift(args[i])
            } else if (/^--(?:push-option|receive-pack|exec)=/.test(value)) continue
            else if (value.startsWith('--repo=')) positionals.unshift(value.slice(7))
            else if (!['-f', '--force', '--force-with-lease', '--force-if-includes', '-u', '--set-upstream', '-d', '--delete', '--tags', '--follow-tags', '--dry-run', '-n', '-v', '--verbose', '-q', '--quiet', '--atomic', '--porcelain', '--no-verify', '--prune'].includes(value)
                && !value.startsWith('--force-with-lease=')) uncertain = true
        } else positionals.push(value)
    }
    if (allBranches && branches.length) return deny('Refusing push to a declared protected branch.')
    for (const ref of positionals.slice(1)) {
        const withoutForce = ref.replace(/^\+/, '')
        const colon = withoutForce.indexOf(':')
        const destination = colon < 0 ? withoutForce : withoutForce.slice(colon + 1)
        if (branches.some((branch) => destination === branch || destination === `refs/heads/${branch}`)) return deny('Refusing push to a declared protected branch.')
        if (!destination || destination.includes('*')) uncertain = true
        // Source-only revisions and symbolic aliases need repository state to name a destination;
        // an exact argv grant cannot supply that evidence.
        if (colon < 0 && (/(?:^|\/)[A-Z_]+$|[@~^{}]|\.\./.test(withoutForce)
            || /^[a-f0-9]+$/i.test(withoutForce) || /-\d+-g[a-f0-9]+$/i.test(withoutForce)
            || /^(?:heads|tags|remotes)\//.test(withoutForce))) uncertain = true
    }
    if (uncertain || positionals.length < 2) return ask('Push destination requires human approval.')
    return undefined
}

/** Hard boundaries are independent of grants and are evaluated across the complete capture. */
export function evaluateGuard(input: unknown, policy: unknown, inspect: PathInspection): GuardDecision {
    if (!isParsedGuardInput(input)) return unavailable('Guard input is unavailable or was not captured by the invocation parser.')
    const resolved = capturePolicy(policy)
    if (!resolved) return unavailable('Guard policy is incomplete or malformed.')
    const absolute = (path: string) => `${resolved.canonicalRoot}/${path}`
    const secretRoot = absolute(SECRETS_ROOT)
    const controlFiles = GUARD_CONTROL_FILES.map(absolute)
    const controlDirectories = GUARD_CONTROL_DIRECTORIES.map(absolute)
    const identities = new Map(resolved.protectedIdentities.map((item) => [item.path, item]))
    const identityOf = (path: string) => identities.get(path)!.identity
    const chainOf = (path: string) => { const item = identities.get(path)!; return item.identity === null ? item.ancestors : [...item.ancestors, item.identity] }
    const secretDenial = deny('Refusing mutation or staging below a secrets directory.')
    const instanceDenial = deny('Refusing mutation or staging of a declared environment instance.')
    const controlDenial = deny('Refusing mutation of the guard, its hook registration or its ownership manifest.')
    const gitMetadataDenial = deny('Refusing direct mutation of Git metadata: its configuration chooses programs that read-only Git commands run.')
    const readDenial = deny('Refusing to read a declared environment instance or secrets directory into the agent context.')
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
    // A throwing inspector is missing evidence, which every caller treats as unsafe.
    const resolvedEvidence = (request: PathInspectionRequest): JsonSnapshotObject | undefined => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect(Object.freeze(request))) }
        catch { return undefined }
        const lexical = posix.resolve(request.cwd, request.path)
        const search = request.operation === 'search'
        return record(evidence) && keys(evidence, ['status', 'path', 'symlink', 'identity', 'ancestors', ...(search ? ['sensitive'] : [])]) && evidence.status === 'resolved'
            && evidence.path === lexical && evidence.symlink === false && (evidence.identity === null || identity(evidence.identity))
            && Array.isArray(evidence.ancestors) && evidence.ancestors.every(identity)
            && (!search || evidence.sensitive === null || Array.isArray(evidence.sensitive) && evidence.sensitive.length <= GUARD_PROTECTED_LOCATION_LIMIT
                && evidence.sensitive.every((path) => canonical(path) && within(path, lexical))) ? evidence : undefined
    }
    let pathCount = input.paths.length + input.invocations.reduce((sum, item) => sum + item.redirects.length, 0)
    const inspectPath = (request: PathInspectionRequest, controlCoverage = false): JsonSnapshotObject | undefined => {
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
        if (mutating && (folded.split('/').includes('.secrets') || (staging || removing) && within(fold(secretRoot), folded))) hold(secretDenial)
        if (mutating && resolved.instances.some((item) => folded === fold(item.path) || (staging || removing) && within(fold(item.path), folded))) hold(instanceDenial)
        if (request.operation === 'write' && (controlFiles.some((path) => folded === fold(path) || controlCoverage && within(fold(path), folded))
            || controlDirectories.some((path) => within(folded, fold(path)) || controlCoverage && within(fold(path), folded)))) hold(controlDenial)
        if (request.operation === 'write' && executes(folded, controlCoverage)) hold(executionDenial)
        if (request.operation === 'write' && posix.basename(folded) === '.npmrc') hold(npmrcDenial)
        if (mutating && folded.split('/').includes('.git')) hold(gitMetadataDenial)
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) {
            hold(unavailable('Guard path escapes configured roots.'))
            return
        }
        const evidence = resolvedEvidence(request)
        if (!evidence) {
            hold(unavailable('Guard path inspection failed, or its evidence is missing, symlinked or mismatched.'))
            return
        }
        if (!mutating) return evidence
        // Identity catches every spelling the volume resolves to a protected entry, including ones
        // the shared normalisation does not equate, such as a hard link.
        const { is, below, covers } = evidenceFacts(evidence)
        if (below(secretRoot) || secretFile(evidence) || (staging || removing) && covers(secretRoot)) hold(secretDenial)
        if (resolved.instances.some((item) => is(item.path) || (staging || removing) && covers(item.path))) hold(instanceDenial)
        if (request.operation === 'write' && (controlFiles.some(is) || controlDirectories.some(below)
            || controlCoverage && (controlFiles.some(covers) || controlDirectories.some(covers)))) hold(controlDenial)
        return evidence
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
    const templates = new Set(resolved.templates.map(fold))
    const searchedProtections = [secretRoot, ...resolved.instances.map((item) => item.path)]
    // Why the last inspected search was not safe, when one protected path is the reason.
    let searchBlocker: GuardDecision | undefined
    // A read-only command is allowed only when every path it touches is evidenced inside the
    // configured roots; reading a protected instance is a hard denial, anything doubtful is not safe.
    // `chainReadOnly` says no other command in the call can create a protected path before the
    // search runs, which is what lets an absent one be ignored.
    const inspectReadOnly = (access: ReadOnlyAccess, chainReadOnly = false): boolean => {
        let safe = true
        searchBlocker = undefined
        const visit = (path: string, kind: 'read' | 'tree' | 'listing') => {
            if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) { safe = false; return }
            const lexical = posix.resolve(access.cwd, path)
            const folded = fold(lexical)
            // A search rooted at or below a protected path reads it as surely as `cat` does; only a
            // listing, which reports names, may name one.
            const protectedRead = folded.split('/').includes('.secrets') || resolved.instances.some((item) => within(folded, fold(item.path)))
            if (kind !== 'listing' && protectedRead) hold(readDenial)
            if (!resolved.allowedRoots.some((root) => within(lexical, root))) { safe = false; return }
            pathCount++
            // An undeclared `.env*` file is not a known instance, but it is not known to be data either.
            // A declared template is: the configuration names it as the instance's documentation.
            if (kind === 'read' && /^\.env/.test(posix.basename(folded)) && !templates.has(folded)) safe = false
            // Unenumerated secrets leave every content read unproven, and a second hard link to a
            // protected file leaves every recursive search unproven: either may reach it unnamed.
            if (kind !== 'listing' && !secretFiles || kind === 'tree' && resolved.protectedFilesLinked) safe = false
            const evidence = resolvedEvidence({ path, cwd: access.cwd, operation: kind === 'tree' ? 'search' : 'read' })
            if (!evidence) { safe = false; return }
            const { is, below, covers } = evidenceFacts(evidence)
            if (kind !== 'listing' && (is(secretRoot) || below(secretRoot) || secretFile(evidence) || resolved.instances.some((item) => is(item.path)))) hold(readDenial)
            if (kind !== 'tree') return
            // The search cannot be told which files to skip: ripgrep's hidden-file filter yields to a
            // whitelist in an agent-writable ignore file, and grep has none. So a tree that holds an
            // existing protected path is not safe, and one that would hold an absent one is safe only
            // when nothing else in the call can create it first. The same holds for every `.env*` file
            // and `.secrets` directory the inspector's walk found in it: `grep -r KEY .` once printed an
            // undeclared sibling `.env.local` that `cat` would have stopped at.
            const reached = searchedProtections.filter((target) => within(fold(target), folded) || covers(target))
            const present = reached.find((target) => identityOf(target) !== null)
            const sensitive = evidence.sensitive as readonly string[] | null
            const unseen = sensitive?.find((found) => !templates.has(fold(found)))
            const absent = chainReadOnly ? undefined : reached[0]
            if (present === undefined && sensitive !== null && unseen === undefined && absent === undefined) return
            safe = false
            const shown = (target: string) => posix.relative(access.cwd, target) || '.'
            searchBlocker = ask(present !== undefined
                ? `A recursive search of ${path} would read ${shown(present)}, a declared environment instance or secrets directory. Search a path that does not contain it.`
                : sensitive === null
                    ? `A recursive search of ${path} covers more than the guard walks to prove it reads no environment file or secrets directory. Search a narrower path.`
                    : unseen !== undefined
                        ? `A recursive search of ${path} would read ${shown(unseen)}, an environment file or secrets directory that is not a declared template. Search a path that does not contain it.`
                        : `A recursive search of ${path} could read ${shown(absent!)}, a declared environment instance or secrets directory, if another command in this call created it first. Run the search on its own.`)
        }
        for (const path of access.requires ?? []) {
            const evidence = resolvedEvidence({ path, cwd: access.cwd, operation: 'read' })
            if (!evidence || evidence.identity === null) safe = false
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
    // A session runs the words after `--` as a command, with no shell, in its own directory, so
    // that command is judged as one more invocation: the session never admits more than it would.
    const invocations = input.invocations.flatMap((invocation): ParsedInvocation[] => {
        const cockpit = provenCockpit(invocation)
        const separator = cockpit?.[0] === 'session' ? cockpit.indexOf('--') : -1
        const command = separator < 0 ? [] : cockpit!.slice(separator + 1)
        if (!command.length) return [invocation]
        return [invocation, { executable: command[0]!, argv: command.slice(1), cwd: invocation.cwd, wrapped: false, redirects: [],
            words: command.map((value, index) => ({ role: index ? 'argument' as const : 'executable' as const, value })) }]
    })
    const accesses = new Map(invocations.map((invocation) => {
        const cockpit = provenCockpit(invocation)
        return [invocation, classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: resolved.ripgrepConfigActive, ...(cockpit ? { cockpit } : {}) })]
    }))
    const chainReadOnly = [...accesses.values()].every((access) => access !== undefined)
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
        } else if (!access) {
            for (const arg of git?.args ?? operands) {
                if (++possibleControlCount <= GUARD_INPUT_LIMITS.paths) {
                    inspectPossibleControlOperand(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg, git?.cwd ?? invocation.cwd)
                }
            }
            if (possibleControlCount > GUARD_INPUT_LIMITS.paths) hold(unavailable('Potential guard control operand limit exceeded.'))
        }
        if (access && inspectReadOnly(access, chainReadOnly)) readOnly.add(invocation)
        else if (searchBlocker) searchRefusals.set(invocation, searchBlocker)
        // A cockpit command that parses a named file can quote it in a refusal, so the file is read
        // into the agent context as surely as `cat` would read it.
        for (const profile of resolved.cockpitInvocations) {
            if (!profile.reads?.length || profile.executable !== invocation.executable || profile.cwd !== invocation.cwd
                || profile.argv.length !== invocation.argv.length || profile.argv.some((word, i) => word !== invocation.argv[i])) continue
            if (!inspectReadOnly({ cwd: profile.cwd, reads: profile.reads, trees: [], listings: [] })) {
                holdAsk(invocation, ask('This cockpit command reads a file the guard cannot prove safe to read: a symlink, an undeclared .env file or one outside the configured roots.'))
            }
        }
        if (!git) continue
        inspectPath({ path: git.cwd, cwd: invocation.cwd, operation: 'cwd' })
        if (git.uncertain) holdAsk(invocation, ask('Git execution context is not an exact resolved profile.'))
        if (git.verb === 'push') {
            const decision = pushDecision(git.args, resolved.protectedBranches)
            if (decision?.decision === 'deny') hold(decision)
            else if (decision) holdAsk(invocation, decision)
        }
        if (git.verb === 'config' && !gitConfigReads(git.args)) hold(gitMetadataDenial)
        if (git.verb === 'reset' && git.args.includes('--hard') || git.verb === 'clean' && git.args.some((arg) => /^-[^-]*[fdxX]/.test(arg) || arg === '--force')) holdAsk(invocation, ask('Destructive Git operation requires human approval.'))
        if (git.verb === 'add') {
            let options = true
            let operands = 0
            for (const arg of git.args) {
                if (options && arg === '--') { options = false; continue }
                if (options && arg.startsWith('-')) {
                    if (['-A', '--all', '-u', '--update'].includes(arg)) {
                        // These forms can stage an instance even without a literal operand.
                        inspectPath({ path: '.', cwd: git.cwd, operation: 'stage' })
                    } else if (!['-f', '--force', '-v', '--verbose', '-n', '--dry-run'].includes(arg)) hold(unavailable('Unsupported Git staging option.'))
                } else {
                    operands++
                    pathCount++
                    if (arg.startsWith(':') || /[*?\[]/.test(arg)) hold(unavailable('Unproven Git staging pathspec grammar.'))
                    else inspectPath({ path: arg, cwd: git.cwd, operation: 'stage' })
                }
            }
            if (!operands) holdAsk(invocation, ask('Staging without explicit paths requires human approval.'))
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
        // protection covers it: a file the agent wrote as packages/web/git runs as `git` there.
        if (resolved.searchPathRelativeEntry !== null && invocation.executable !== null && !invocation.executable.includes('/')) {
            return ask(`The command search path the agent runs with holds the relative entry ${JSON.stringify(resolved.searchPathRelativeEntry)}${resolved.searchPathRelativeEntry === '' ? ' (an empty entry is the working directory)' : ''}, so ${invocation.executable} may run a file the agent wrote instead of the permitted program. Remove relative entries from the PATH the agent harness starts with.`)
        }
        const declared = !invocation.wrapped && !invocation.words.some((word) => word.role === 'environment-assignment-value')
            ? resolved.declaredAllows.find(rule => ruleMatches(invocation, rule)) : undefined
        if (declared) { declaredReasons.push(declared.reason); continue }
        const pending = askDecisions.get(invocation)
        if (pending) return pending
        if (invocation.wrapped || invocation.words.some((word) => word.role === 'environment-assignment-value')) return ask('Wrapped or environment-modifying invocation requires human approval.')
        if (invocation.executable === null) continue
        const matches = (profile: { executable: string; argv: readonly string[] }, cwd: string) => profile.executable === invocation.executable
            && cwd === invocation.cwd && profile.argv.length === invocation.argv.length && profile.argv.every((word, i) => word === invocation.argv[i])
        if (!readOnly.has(invocation) && !resolved.cockpitInvocations.some((profile) => matches(profile, profile.cwd))
            && !resolved.projectCommands.some((profile) => matches(profile, profile.checkoutRoot))) return searchRefusals.get(invocation) ?? ask('Invocation does not match an exact permitted profile.')
    }
    return declaredReasons.length === 1 ? { decision: 'allow', reason: declaredReasons[0]! } : allowed
}
