import { posix } from 'node:path'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_INPUT_LIMITS, isParsedGuardInput, type ParsedInvocation } from './invocation-parser.js'
import { GUARD_HOST_LIMITS, isGuardHost, normalizeGuardHost } from './host.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from '../environment/install-policy.js'

export const mechanism = {
    id: 'guard-evaluator', module: 'packages/cockpit/src/guards/evaluator.ts', exports: ['evaluateGuard'],
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
export interface GuardEvaluationPolicy {
    readonly canonicalRoot: string
    readonly allowedRoots: readonly string[]
    readonly instances: readonly { readonly name: string; readonly path: string }[]
    readonly protectedBranches: readonly string[]
    readonly hostedDatabaseHosts: readonly string[]
    readonly vendorHosts: readonly string[]
    readonly cockpitInvocations: readonly GuardInvocationProfile[]
    readonly projectCommands: readonly GuardProjectCommand[]
}
export interface PathInspectionRequest {
    readonly path: string
    readonly cwd: string
    readonly operation: 'cwd' | 'write' | 'stage'
}
/** The application supplies current, symlink-aware facts; the evaluator performs no I/O. */
export type PathInspection = (request: PathInspectionRequest) => unknown
export interface GuardDecision {
    readonly decision: 'allow' | 'ask' | 'deny' | 'unavailable'
    readonly reason: string
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
function strings(value: JsonSnapshot | undefined): value is readonly string[] {
    return Array.isArray(value) && value.every(scalar)
}
function argv(value: JsonSnapshot | undefined): value is readonly string[] {
    return Array.isArray(value) && value.length <= GUARD_INPUT_LIMITS.words && value.every((word) =>
        typeof word === 'string' && !/[\uD800-\uDFFF]/u.test(word) && !/[\x00-\x1f\x7f]/.test(word)
        && Buffer.byteLength(word) <= GUARD_INPUT_LIMITS.wordBytes && word !== '*' && word !== '**')
}
function projectTuple(value: JsonSnapshotObject): boolean {
    if (!Array.isArray(value.argv)) return false
    const tuple = GuardCommandArgv.safeParse([value.executable, ...value.argv])
    return tuple.success && renderGuardProjectCommand(tuple.data).kind === 'complete'
}
function capturePolicy(value: unknown): GuardEvaluationPolicy | undefined {
    const p = snapshotJson(value)
    if (!record(p) || !keys(p, ['canonicalRoot', 'allowedRoots', 'instances', 'protectedBranches', 'hostedDatabaseHosts', 'vendorHosts', 'cockpitInvocations', 'projectCommands'])
        || !canonical(p.canonicalRoot) || !strings(p.allowedRoots) || !p.allowedRoots.includes(p.canonicalRoot) || !p.allowedRoots.every(canonical)
        || !strings(p.protectedBranches) || !strings(p.hostedDatabaseHosts) || !strings(p.vendorHosts)
        || !Array.isArray(p.instances) || !Array.isArray(p.cockpitInvocations) || !Array.isArray(p.projectCommands)) return undefined
    const roots = p.allowedRoots
    const confined = (value: JsonSnapshot | undefined): value is string => canonical(value) && roots.some((root) => within(value, root))
    if ([p.hostedDatabaseHosts, p.vendorHosts].some((hosts) => hosts.length > GUARD_HOST_LIMITS.rows
        || !hosts.every(isGuardHost) || new Set(hosts.map(normalizeGuardHost)).size !== hosts.length)
        || p.protectedBranches.some((branch) => /[\s:*?\[\\]/.test(branch))
        || p.instances.some((item) => !record(item) || !keys(item, ['name', 'path']) || !scalar(item.name) || !confined(item.path))
        || p.cockpitInvocations.some((item) => !record(item) || !keys(item, ['executable', 'cwd', 'argv']) || !scalar(item.executable) || item.executable.includes('*') || !confined(item.cwd) || !argv(item.argv))
        || p.projectCommands.some((item) => !record(item) || !keys(item, ['executable', 'checkoutRoot', 'kind', 'argv']) || !confined(item.checkoutRoot) || !['build', 'test'].includes(String(item.kind)) || !projectTuple(item))) return undefined
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
    const secretRoot = `${resolved.canonicalRoot}/env/.secrets`
    let pending: GuardDecision | undefined
    let hardDeny: GuardDecision | undefined
    const hold = (decision: GuardDecision) => {
        if (decision.decision === 'deny') hardDeny = decision
        else if (!pending || decision.decision === 'unavailable') pending = decision
    }
    let pathCount = input.paths.length + input.invocations.reduce((sum, item) => sum + item.redirects.length, 0)
    const inspectPath = (request: PathInspectionRequest) => {
        if (!scalar(request.path) || Buffer.byteLength(request.path) > GUARD_INPUT_LIMITS.pathBytes || !canonical(request.cwd)) {
            hold(unavailable('Guard path or working directory is malformed.'))
            return
        }
        const lexical = posix.resolve(request.cwd, request.path)
        if (!resolved.allowedRoots.some((root) => within(lexical, root))) {
            hold(unavailable('Guard path escapes configured roots.'))
            return
        }
        if (request.operation !== 'cwd' && (lexical.split('/').some((segment) => segment.toLowerCase() === '.secrets')
            || request.operation === 'stage' && within(secretRoot, lexical))) {
            hold(deny('Refusing mutation or staging below a secrets directory.'))
        }
        if (request.operation !== 'cwd' && resolved.instances.some((item) => lexical === item.path || request.operation === 'stage' && within(item.path, lexical))) {
            hold(deny('Refusing mutation or staging of a declared environment instance.'))
        }
        let evidence: JsonSnapshot | undefined
        try { evidence = snapshotJson(inspect(Object.freeze(request))) }
        catch { hold(unavailable('Guard path inspection failed.')); return }
        if (!record(evidence) || !keys(evidence, ['status', 'path', 'symlink']) || evidence.status !== 'resolved' || !canonical(evidence.path)
            || evidence.path !== lexical || evidence.symlink !== false || !resolved.allowedRoots.some((root) => within(evidence.path as string, root))) {
            hold(unavailable('Guard path evidence is missing, escaped, symlinked or mismatched.'))
        }
    }
    inspectPath({ path: input.cwd, cwd: input.cwd, operation: 'cwd' })
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
            if (redirect.write) inspectPath({ path: redirect.target, cwd: invocation.cwd, operation: 'write' })
        }
        const git = gitInvocation(invocation)
        if (!git) continue
        inspectPath({ path: git.cwd, cwd: invocation.cwd, operation: 'cwd' })
        if (git.uncertain) hold(ask('Git execution context is not an exact resolved profile.'))
        if (git.verb === 'push') {
            const decision = pushDecision(git.args, resolved.protectedBranches)
            if (decision) hold(decision)
        }
        if (git.verb === 'reset' && git.args.includes('--hard') || git.verb === 'clean' && git.args.some((arg) => /^-[^-]*[fdxX]/.test(arg) || arg === '--force')) hold(ask('Destructive Git operation requires human approval.'))
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
            if (!operands) hold(ask('Staging without explicit paths requires human approval.'))
        }
    }
    if (pathCount > GUARD_INPUT_LIMITS.paths) hold(unavailable('Guard path limit exceeded.'))
    if (hardDeny) return hardDeny
    if (pending) return pending
    for (const invocation of input.invocations) {
        if (invocation.wrapped || invocation.words.some((word) => word.role === 'environment-assignment-value')) return ask('Wrapped or environment-modifying invocation requires human approval.')
        if (invocation.executable === null) continue
        const matches = (profile: { executable: string; argv: readonly string[] }, cwd: string) => profile.executable === invocation.executable
            && cwd === invocation.cwd && profile.argv.length === invocation.argv.length && profile.argv.every((word, i) => word === invocation.argv[i])
        if (!resolved.cockpitInvocations.some((profile) => matches(profile, profile.cwd))
            && !resolved.projectCommands.some((profile) => matches(profile, profile.checkoutRoot))) return ask('Invocation does not match an exact permitted profile.')
    }
    return allowed
}
