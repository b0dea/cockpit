import { posix } from 'node:path'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_INPUT_LIMITS, isParsedGuardInput, type ParsedInvocation } from './invocation-parser.js'
import { GUARD_HOST_LIMITS, isGuardHost, normalizeGuardHost } from './host.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from '../environment/install-policy.js'
import { GUARD_LOCAL_PATHS } from './local-identity.js'
import { classifyReadOnlyInvocation, type ReadOnlyAccess } from './read-only.js'
import { SURFACE_EXECUTION_CONTROL_PATHS } from '../surfaces/harness-registry.js'

export const mechanism = {
    id: 'guard-evaluator', module: 'packages/cockpit/src/guards/evaluator.ts', exports: ['evaluateGuard', 'GUARD_ROOT_PROTECTIONS', 'guardIdentity'],
} as const

export interface GuardInvocationProfile {
    readonly executable: string
    readonly cwd: string
    readonly argv: readonly string[]
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
    readonly protectedIdentities: readonly GuardProtectedIdentity[]
    readonly protectedBranches: readonly string[]
    readonly hostedDatabaseHosts: readonly string[]
    readonly vendorHosts: readonly string[]
    readonly declaredAllows: readonly GuardDeclaredAllow[]
    readonly declaredDenies: readonly GuardDeclaredDeny[]
    readonly ripgrepConfigActive: boolean
    readonly cockpitInvocations: readonly GuardInvocationProfile[]
    readonly projectCommands: readonly GuardProjectCommand[]
}
export interface PathInspectionRequest {
    readonly path: string
    readonly cwd: string
    readonly operation: 'cwd' | 'write' | 'stage' | 'read' | 'remove'
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
// bundle carries its own MCP servers and hook registration, so no file below them is data. The
// machine-local guard identity names the handler the guard launches, so it is a control as well.
const GUARD_CONTROL_DIRECTORIES = ['.opencode/plugin', '.opencode/plugins', '.cockpit/bundles/claudecode-plugin', GUARD_LOCAL_PATHS.directory] as const
const SECRETS_ROOT = 'env/.secrets'
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
function fold(path: string): string {
    return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}
const unavailable = (reason: string): GuardDecision => ({ decision: 'unavailable', reason })
const ask = (reason: string): GuardDecision => ({ decision: 'ask', reason })
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
    if (!record(p) || !keys(p, ['canonicalRoot', 'configPath', 'allowedRoots', 'instances', 'protectedIdentities', 'protectedBranches', 'hostedDatabaseHosts', 'vendorHosts', 'declaredAllows', 'declaredDenies', 'ripgrepConfigActive', 'cockpitInvocations', 'projectCommands'])
        || !canonical(p.canonicalRoot) || !canonical(p.configPath) || posix.dirname(p.configPath) !== p.canonicalRoot || !strings(p.allowedRoots) || !p.allowedRoots.includes(p.canonicalRoot) || !p.allowedRoots.every(canonical)
        || !strings(p.protectedBranches) || !strings(p.hostedDatabaseHosts) || !strings(p.vendorHosts)
        || !Array.isArray(p.instances) || !Array.isArray(p.protectedIdentities) || !Array.isArray(p.declaredAllows) || !Array.isArray(p.declaredDenies)
        || typeof p.ripgrepConfigActive !== 'boolean' || !Array.isArray(p.cockpitInvocations) || !Array.isArray(p.projectCommands)) return undefined
    const roots = p.allowedRoots
    const confined = (value: JsonSnapshot | undefined): value is string => canonical(value) && roots.some((root) => within(value, root))
    if ([p.hostedDatabaseHosts, p.vendorHosts].some((hosts) => hosts.length > GUARD_HOST_LIMITS.rows
        || !hosts.every(isGuardHost) || new Set(hosts.map(normalizeGuardHost)).size !== hosts.length)
        || p.protectedBranches.some((branch) => /[\s:*?\[\\]/.test(branch))
        || p.instances.some((item) => !record(item) || !keys(item, ['name', 'path']) || !scalar(item.name) || !confined(item.path))
        || p.declaredAllows.length > 64 || p.declaredAllows.some((item) => !record(item)
            || !keys(item, item.cwd === undefined ? ['argv', 'reason'] : ['argv', 'reason', 'cwd'])
            || !ruleArgv(item.argv) || !scalar(item.reason) || item.cwd !== undefined && !confined(item.cwd))
        || p.declaredDenies.length > 64 || p.declaredDenies.some((item) => !record(item)
            || !keys(item, item.fix === undefined ? ['match', 'argv', 'reason'] : ['match', 'argv', 'reason', 'fix'])
            || !['prefix', 'contains'].includes(String(item.match)) || !ruleArgv(item.argv) || !scalar(item.reason)
            || item.fix !== undefined && !scalar(item.fix))
        || p.cockpitInvocations.some((item) => !record(item) || !keys(item, ['executable', 'cwd', 'argv']) || !scalar(item.executable) || item.executable.includes('*') || !confined(item.cwd) || !argv(item.argv))
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
    const lower = value.toLowerCase()
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

/** Visible source and destination paths for copy/install/move without inferring filesystem state. */
function transferOperands(command: 'cp' | 'install' | 'mv', args: readonly string[]): TransferOperands {
    const operands: string[] = []
    let targetDirectory: string | undefined
    let noTargetDirectory = false
    let installDirectories = false
    let uncertain = false
    let options = true
    const plainShort = command === 'cp' ? 'afHiLlnPpRrsvXx' : command === 'mv' ? 'fhinuv' : 'bCcpSsUv'
    const valueShort = command === 'install' ? new Set(['f', 'g', 'm', 'o', 'M', 'h', 'B', 'l', 'N']) : new Set<string>()
    const plainLong = new Set(command === 'cp' ? ['archive', 'force', 'interactive', 'link', 'no-clobber', 'no-dereference', 'preserve', 'recursive', 'reflink', 'remove-destination', 'sparse', 'symbolic-link', 'update', 'verbose']
        : command === 'mv' ? ['force', 'interactive', 'no-clobber', 'no-target-directory', 'update', 'verbose']
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
                if (valueAt !== letters.length - 1) uncertain = true
                else if (args[++index] === undefined) uncertain = true
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
    if (operands.length < 2) return { sources: [], writes: [], uncertain: true }
    const sources = operands.slice(0, -1)
    const destination = operands.at(-1)!
    return {
        sources,
        writes: [destination, ...(!noTargetDirectory ? sources.map(source => posix.join(destination, posix.basename(source))) : [])],
        uncertain,
    }
}

interface VisibleWrites { readonly paths: readonly string[]; readonly reads?: readonly string[]; readonly uncertain: boolean }

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
    return { paths: extraction ? [destination] : [], reads: archive === undefined ? [] : [archive], uncertain: uncertain || !extraction }
}

/** Destinations exposed directly by bounded filesystem writer grammars. */
function visibleWrites(invocation: ParsedInvocation): VisibleWrites | undefined {
    if (invocation.executable === null) return undefined
    const name = posix.basename(invocation.executable)
    if (name === 'cp' || name === 'install' || name === 'mv') {
        const transfer = transferOperands(name, invocation.argv)
        return { paths: transfer.writes, reads: name === 'mv' ? [] : transfer.sources, uncertain: transfer.uncertain }
    }
    if (name === 'dd') {
        const paths = invocation.argv.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)).filter(Boolean)
        const reads = invocation.argv.filter(arg => arg.startsWith('if=')).map(arg => arg.slice(3)).filter(Boolean)
        return { paths, reads, uncertain: invocation.argv.some(arg => !/^[a-z_]+=/i.test(arg)) }
    }
    if (name === 'tar') return tarExtractionWrites(invocation.argv)
    const scan = (plain: Set<string>, valued: Set<string>) => {
        const operands: string[] = []
        let uncertain = false
        let options = true
        for (let index = 0; index < invocation.argv.length; index++) {
            const arg = invocation.argv[index]!
            if (options && arg === '--') { options = false; continue }
            if (options && arg.startsWith('-') && arg !== '-') {
                const option = arg.split('=')[0]!
                if (valued.has(option)) {
                    if (!arg.includes('=') && invocation.argv[++index] === undefined) uncertain = true
                } else if (option.startsWith('--') ? !plain.has(option) : [...option.slice(1)].some(letter => !plain.has(`-${letter}`))) uncertain = true
                continue
            }
            operands.push(arg)
        }
        return { operands, uncertain }
    }
    if (name === 'tee') {
        const result = scan(new Set(['-a', '-i', '-p', '--append', '--ignore-interrupts', '--output-error']), new Set())
        return { paths: result.operands, uncertain: result.uncertain }
    }
    if (name === 'touch') {
        const result = scan(new Set(['-a', '-c', '-h', '-m', '--no-create']), new Set(['-A', '-d', '-r', '-t', '--date', '--reference', '--time']))
        return { paths: result.operands, uncertain: result.uncertain }
    }
    if (name === 'truncate') {
        const result = scan(new Set(['-c', '--no-create']), new Set(['-r', '-s', '--reference', '--size']))
        return { paths: result.operands, uncertain: result.uncertain }
    }
    if (name === 'chmod') {
        const result = scan(new Set(['-f', '-h', '-v', '-R', '-H', '-L', '-P', '-E', '-C', '-N', '-i', '-I']), new Set(['--reference']))
        const hasMode = result.operands.length > 1 && /^(?:[0-7]{3,4}|[ugoa]*[-+=][rwxXstugo,]+)$/.test(result.operands[0]!)
        return { paths: result.operands.slice(hasMode ? 1 : 0), uncertain: result.uncertain || result.operands.length === 0 }
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
    const structuralDenial = deny(`Refusing to delete, rename or truncate ${posix.basename(resolved.configPath)} or ${GUARD_CONTROL_FILES[1]}: every later guarded call reads them, so losing either holds the agent until a human restores it. Edit ${posix.basename(resolved.configPath)} in place instead.`)
    let authorityUnavailable: GuardDecision | undefined
    let hardDeny: GuardDecision | undefined
    const hold = (decision: GuardDecision) => {
        if (decision.decision === 'deny') hardDeny = decision
        else if (decision.decision === 'unavailable' && !authorityUnavailable) authorityUnavailable = decision
    }
    const askDecisions = new Map<ParsedInvocation, GuardDecision>()
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
    const resolvedEvidence = (request: PathInspectionRequest): JsonSnapshotObject | undefined => {
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect(Object.freeze(request))) }
        catch { return undefined }
        const lexical = posix.resolve(request.cwd, request.path)
        return record(evidence) && keys(evidence, ['status', 'path', 'symlink', 'identity', 'ancestors']) && evidence.status === 'resolved'
            && evidence.path === lexical && evidence.symlink === false && (evidence.identity === null || identity(evidence.identity))
            && Array.isArray(evidence.ancestors) && evidence.ancestors.every(identity) ? evidence : undefined
    }
    let pathCount = input.paths.length + input.invocations.reduce((sum, item) => sum + item.redirects.length, 0)
    const inspectPath = (request: PathInspectionRequest, controlCoverage = false) => {
        if (!scalar(request.path) || Buffer.byteLength(request.path) > GUARD_INPUT_LIMITS.pathBytes || !canonical(request.cwd)) {
            hold(unavailable('Guard path or working directory is malformed.'))
            return
        }
        const lexical = posix.resolve(request.cwd, request.path)
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) {
            hold(unavailable('Guard path escapes configured roots.'))
            return
        }
        const mutating = request.operation !== 'cwd'
        const staging = request.operation === 'stage'
        // Spelling checks run before inspection so a hard denial survives missing evidence; they
        // cover leaves that do not exist yet, which have no identity to compare.
        const folded = fold(lexical)
        if (mutating && (folded.split('/').includes('.secrets') || staging && within(fold(secretRoot), folded))) hold(secretDenial)
        if (mutating && resolved.instances.some((item) => folded === fold(item.path) || staging && within(fold(item.path), folded))) hold(instanceDenial)
        if (request.operation === 'write' && (controlFiles.some((path) => folded === fold(path) || controlCoverage && within(fold(path), folded))
            || controlDirectories.some((path) => within(folded, fold(path)) || controlCoverage && within(fold(path), folded)))) hold(controlDenial)
        if (mutating && folded.split('/').includes('.git')) hold(gitMetadataDenial)
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect(Object.freeze(request))) }
        catch { hold(unavailable('Guard path inspection failed.')); return }
        if (!record(evidence) || !keys(evidence, ['status', 'path', 'symlink', 'identity', 'ancestors']) || evidence.status !== 'resolved' || !canonical(evidence.path)
            || evidence.path !== lexical || evidence.symlink !== false || !resolved.allowedRoots.some((root) => within(evidence.path as string, root))
            || evidence.identity !== null && !identity(evidence.identity) || !Array.isArray(evidence.ancestors) || !evidence.ancestors.every(identity)) {
            hold(unavailable('Guard path evidence is missing, escaped, symlinked or mismatched.'))
            return
        }
        if (!mutating) return
        // Identity catches every spelling the volume resolves to a protected entry, including ones
        // the shared normalisation does not equate, such as a hard link.
        const { is, below, covers } = evidenceFacts(evidence)
        if (below(secretRoot) || staging && covers(secretRoot)) hold(secretDenial)
        if (resolved.instances.some((item) => is(item.path) || staging && covers(item.path))) hold(instanceDenial)
        if (request.operation === 'write' && (controlFiles.some(is) || controlDirectories.some(below)
            || controlCoverage && (controlFiles.some(covers) || controlDirectories.some(covers)))) hold(controlDenial)
    }
    // Removing a control, anything below a control directory, or a directory containing one can
    // disable the guard before its next invocation. Missing evidence never softens a spelling denial.
    const inspectRemoval = (path: string, cwd: string) => {
        if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes) return
        const lexical = posix.resolve(cwd, path)
        if (structural.some((target) => within(fold(target), fold(lexical)))) { hold(structuralDenial); return }
        if (controlFiles.some((target) => within(fold(target), fold(lexical)))
            || controlDirectories.some((target) => within(fold(target), fold(lexical)) || within(fold(lexical), fold(target)))) {
            hold(controlDenial)
            return
        }
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) return
        const evidence = resolvedEvidence({ path, cwd, operation: 'remove' })
        if (!evidence) return
        const { below, covers } = evidenceFacts(evidence)
        if (structural.some(covers)) { hold(structuralDenial); return }
        if (controlFiles.some(covers) || controlDirectories.some((target) => covers(target) || below(target))) hold(controlDenial)
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
    // A read-only command is allowed only when every path it touches is evidenced inside the
    // configured roots; reading a protected instance is a hard denial, anything doubtful is not safe.
    const inspectReadOnly = (access: ReadOnlyAccess): boolean => {
        let safe = true
        const visit = (path: string, kind: 'read' | 'tree' | 'listing') => {
            const lexical = posix.resolve(access.cwd, path)
            if (!scalar(path) || Buffer.byteLength(path) > GUARD_INPUT_LIMITS.pathBytes || !resolved.allowedRoots.some((root) => within(lexical, root))) { safe = false; return }
            pathCount++
            const folded = fold(lexical)
            const protectedRead = folded.split('/').includes('.secrets') || resolved.instances.some((item) => folded === fold(item.path))
            if (kind === 'read' && protectedRead) hold(readDenial)
            // An undeclared `.env*` file is not a known instance, but it is not known to be data either.
            if (kind === 'read' && /^\.env/.test(posix.basename(folded))) safe = false
            if (kind === 'tree' && [secretRoot, ...resolved.instances.map((item) => item.path)].some((path) => within(fold(path), folded))) safe = false
            const evidence = resolvedEvidence({ path, cwd: access.cwd, operation: 'read' })
            if (!evidence) { safe = false; return }
            const { is, below, covers } = evidenceFacts(evidence)
            if (kind === 'read' && (below(secretRoot) || resolved.instances.some((item) => is(item.path)))) hold(readDenial)
            if (kind === 'tree' && (covers(secretRoot) || resolved.instances.some((item) => covers(item.path)))) safe = false
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
    let possibleControlCount = 0
    inspectPath({ path: input.cwd, cwd: input.cwd, operation: 'cwd' })
    for (const path of input.removed) inspectRemoval(path, input.cwd)
    for (const path of input.paths) inspectPath({ path, cwd: input.cwd, operation: 'write' })
    for (const invocation of input.invocations) {
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
        for (const path of removed?.paths ?? []) inspectRemoval(path, removed!.cwd)
        const access = classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: resolved.ripgrepConfigActive })
        const writes = git?.verb === 'mv' ? (() => {
            const transfer = transferOperands('mv', git.args)
            return { paths: transfer.writes, reads: [], uncertain: transfer.uncertain }
        })() : visibleWrites(invocation)
        if (writes) {
            for (const path of writes.paths) {
                pathCount++
                inspectPath({ path, cwd: invocation.cwd, operation: 'write' }, true)
            }
            if (writes.reads?.length && !inspectReadOnly({ cwd: invocation.cwd, reads: writes.reads, trees: [], listings: [] })) {
                hold(unavailable('Visible writer source is unavailable or unsafe to read.'))
            }
            if (writes.uncertain) hold(unavailable('Unsupported visible writer option.'))
        } else if (!access) {
            for (const arg of git?.args ?? invocation.argv) {
                if (++possibleControlCount <= GUARD_INPUT_LIMITS.paths) {
                    inspectPossibleControlOperand(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg, invocation.cwd)
                }
            }
            if (possibleControlCount > GUARD_INPUT_LIMITS.paths) hold(unavailable('Potential guard control operand limit exceeded.'))
        }
        if (access && inspectReadOnly(access)) readOnly.add(invocation)
        if (!git) continue
        inspectPath({ path: git.cwd, cwd: invocation.cwd, operation: 'cwd' })
        if (git.uncertain) holdAsk(invocation, ask('Git execution context is not an exact resolved profile.'))
        if (git.verb === 'push') {
            const decision = pushDecision(git.args, resolved.protectedBranches)
            if (decision?.decision === 'deny') hold(decision)
            else if (decision) holdAsk(invocation, decision)
        }
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
    for (const invocation of input.invocations) {
        const declared = resolved.declaredDenies.find(rule => ruleMatches(invocation, rule))
        if (declared) return deny(`${declared.reason}${declared.fix ? ` Fix: ${declared.fix}` : ''}`)
    }
    if (authorityUnavailable) return authorityUnavailable
    const declaredReasons: string[] = []
    for (const invocation of input.invocations) {
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
            && !resolved.projectCommands.some((profile) => matches(profile, profile.checkoutRoot))) return ask('Invocation does not match an exact permitted profile.')
    }
    return declaredReasons.length === 1 ? { decision: 'allow', reason: declaredReasons[0]! } : allowed
}
