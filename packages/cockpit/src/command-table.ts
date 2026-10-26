import { SURFACE_TARGETS } from './surfaces/contract.js'
import type { ParseArgsConfig } from 'node:util'
import { isAbsolute, normalize, resolve } from 'node:path'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from './environment/contract.js'
import type { GuardInvocationProfile } from './guards/evaluator.js'
import { GUARD_HANDLER_ARGV } from './guards/harness-adapter.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'

export const mechanism = {
    id: 'command-metadata',
    module: 'packages/cockpit/src/command-table.ts',
    exports: ['commands', 'internalCommands', 'resolveOrdinaryInvocation', 'isWorkHandler'],
} as const

export type WorkHandlerIdentifier =
    | 'work-intake' | 'work-status' | 'work-accept' | 'work-renew' | 'work-resume'
    | 'work-recover' | 'work-execute' | 'work-record' | 'work-review' | 'work-sweep' | 'work-reverse' | 'work-programme-mint' | 'work-metrics' | 'work-grade'
    | 'browser-drive' | 'browser-accessibility' | 'browser-screenshot' | 'browser-debugger' | 'test-run'

export type HandlerIdentifier = WorkHandlerIdentifier
    | 'baseline-record'
    | 'check'
    | 'compare'
    | 'doctor'
    | 'document'
    | 'down'
    | 'init'
    | 'logs'
    | 'preflight'
    | 'registry-resolve'
    | 'reset'
    | 'setup'
    | 'selftest'
    | 'session'
    | 'sleep'
    | 'sync'
    | 'up'
    | 'upgrade'

export interface CommandDefinition {
    name: string
    summary: string
    handler: HandlerIdentifier
    options: NonNullable<ParseArgsConfig['options']>
    visibility: 'public'
    ordinary: OrdinaryCommandMetadata
}

type OrdinaryValueRole = 'confined-path' | 'resolved-config' | 'declared-service' | 'tail' | 'since' | 'sha256' | 'surface-target'
export interface OrdinaryOption {
    readonly kind: 'flag' | 'value'
    readonly role: 'boolean' | OrdinaryValueRole
    readonly repetition: 'singleton'
    readonly required?: true
}
export type OrdinaryCommandMetadata = Readonly<{ availability: 'unavailable'; reason: string }> | Readonly<{
    availability: 'available'
    executableRole: 'installed-cockpit'
    command: HandlerIdentifier
    positional: Readonly<{ min: number; max: number; roles: readonly ['confined-root'] | readonly ['compare-operation'] | readonly [] }>
    options: Readonly<Record<string, OrdinaryOption>>
    cwdRole: 'canonical-root'
    configuration: 'resolved' | 'none'
    forbidden: Readonly<{ presence: readonly string[]; values: readonly { option: string; predicate: 'not-lowercase-sha256' }[] }>
    operationVariants?: Readonly<Record<'validate' | 'run' | 'status', Readonly<{
        options: Readonly<Record<string, OrdinaryOption>>
        configuration: 'resolved' | 'none'
    }>>>
    selection?: 'root-xor-registry' | 'release-evidence-pair'
}>

const flag: OrdinaryOption = Object.freeze({ kind: 'flag', role: 'boolean', repetition: 'singleton' })
function value(role: OrdinaryValueRole, required = false): OrdinaryOption {
    return Object.freeze({ kind: 'value', role, repetition: 'singleton', ...(required ? { required: true as const } : {}) })
}
const configured = Object.freeze({ config: value('resolved-config', true), json: flag })
function ordinary(command: HandlerIdentifier, options: Readonly<Record<string, OrdinaryOption>> = configured,
    extra: Partial<Extract<OrdinaryCommandMetadata, { availability: 'available' }>> = {}): OrdinaryCommandMetadata {
    return Object.freeze({ availability: 'available', executableRole: 'installed-cockpit', command,
        positional: Object.freeze({ min: 0, max: 0, roles: Object.freeze([] as const) }), options: Object.freeze(options),
        cwdRole: 'canonical-root', configuration: 'resolved',
        forbidden: Object.freeze({ presence: Object.freeze([]), values: Object.freeze([]) }), ...extra })
}
function unavailable(reason: string): OrdinaryCommandMetadata { return Object.freeze({ availability: 'unavailable', reason }) }

const workOptions = { config: { type: 'string' }, json: { type: 'boolean', default: false } } as const
const workOrderOption = { 'work-order': { type: 'string' } } as const


export function isWorkHandler(value: HandlerIdentifier): value is WorkHandlerIdentifier {
    return value.startsWith('work-') || value.startsWith('browser-') || value === 'test-run'
}

export const commands = [
    {
        name: 'init',
        summary: 'Preview or accept one explicit bootstrap target in an existing checkout',
        handler: 'init',
        visibility: 'public',
        ordinary: ordinary('init', { target: value('surface-target', true), registry: value('confined-path'), json: flag }, {
            configuration: 'none',
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['confined-root'] as const) }),
            forbidden: Object.freeze({ presence: Object.freeze(['interactive']), values: Object.freeze([]) }),
        }),
        options: { target: { type: 'string' }, registry: { type: 'string' },
            interactive: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    },
    {
        name: 'compare',
        summary: 'Validate an isolated comparison, run it, or inspect its operator ledger',
        handler: 'compare',
        visibility: 'public',
        ordinary: ordinary('compare', { fixture: value('confined-path', true), json: flag }, {
            configuration: 'none',
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['compare-operation'] as const) }),
            operationVariants: Object.freeze({
                validate: Object.freeze({ configuration: 'none', options: Object.freeze({ fixture: value('confined-path', true), json: flag }) }),
                run: Object.freeze({ configuration: 'resolved', options: Object.freeze({ fixture: value('confined-path', true), ...configured }) }),
                status: Object.freeze({ configuration: 'none', options: Object.freeze({ fixture: value('confined-path', true), ledger: value('confined-path', true), json: flag }) }),
            }),
        }),
        options: {
            fixture: { type: 'string' }, config: { type: 'string' }, ledger: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'document',
        summary: 'Describe an existing cockpit as attributed cockpit.toml content',
        handler: 'document',
        visibility: 'public',
        ordinary: ordinary('document', { registry: value('confined-path'), json: flag }, {
            configuration: 'none', positional: Object.freeze({ min: 0, max: 1, roles: Object.freeze(['confined-root'] as const) }),
            selection: 'root-xor-registry', forbidden: Object.freeze({ presence: Object.freeze(['output']), values: Object.freeze([]) }),
        }),
        options: {
            registry: { type: 'string' },
            output: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'registry-resolve',
        summary: 'Resolve a validated legacy registry into sourceable shell data',
        handler: 'registry-resolve',
        visibility: 'public',
        ordinary: ordinary('registry-resolve', { registry: value('confined-path', true), 'siblings-root': value('confined-path', true), adoption: value('confined-path', true), json: flag }, { configuration: 'none' }),
        options: {
            registry: { type: 'string' },
            'siblings-root': { type: 'string' },
            adoption: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'setup',
        summary: 'Acquire and wire declared sibling repositories',
        handler: 'setup',
        visibility: 'public',
        ordinary: ordinary('setup'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'sync',
        summary: 'Synchronize canonical generated environment files',
        handler: 'sync',
        visibility: 'public',
        ordinary: ordinary('sync', { ...configured, 'dry-run': flag }, { forbidden: Object.freeze({ presence: Object.freeze(['interactive']), values: Object.freeze([]) }) }),
        options: {
            config: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'check',
        summary: 'Check canonical generated environment files for drift',
        handler: 'check',
        visibility: 'public',
        ordinary: ordinary('check'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'selftest',
        summary: 'Probe generated harness controls with explicit measured specifications',
        handler: 'selftest',
        visibility: 'public',
        ordinary: ordinary('selftest', { ...configured, 'probe-specifications': value('confined-path', true) }, { forbidden: Object.freeze({ presence: Object.freeze(['interactive']), values: Object.freeze([]) }) }),
        options: {
            config: { type: 'string' },
            'probe-specifications': { type: 'string' },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'upgrade',
        summary: 'Inspect a reviewable upgrade sequence without applying changes',
        handler: 'upgrade',
        visibility: 'public',
        ordinary: ordinary('upgrade', { ...configured, 'release-evidence': value('confined-path'), 'release-evidence-sha256': value('sha256') }, {
            selection: 'release-evidence-pair', forbidden: Object.freeze({ presence: Object.freeze([]), values: Object.freeze([{ option: 'release-evidence-sha256', predicate: 'not-lowercase-sha256' as const }]) }),
        }),
        options: {
            config: { type: 'string' },
            'release-evidence': { type: 'string' },
            'release-evidence-sha256': { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'up',
        summary: 'Start or resume the declared environment',
        handler: 'up',
        visibility: 'public',
        ordinary: ordinary('up'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'sleep',
        summary: 'Release this holder and stop an unshared environment',
        handler: 'sleep',
        visibility: 'public',
        ordinary: ordinary('sleep'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'session',
        summary: 'Keep the environment available for one command, then release it',
        handler: 'session',
        visibility: 'public',
        ordinary: unavailable('session wraps an arbitrary foreground command'),
        options: {
            config: { type: 'string' },
        },
    },
    {
        name: 'down',
        summary: 'Remove the selected generated runtime',
        handler: 'down',
        visibility: 'public',
        ordinary: unavailable('destructive commands require separate approval'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'reset',
        summary: 'Preview or interactively approve an exact reset',
        handler: 'reset',
        visibility: 'public',
        ordinary: unavailable('reset requires separate approval'),
        options: {
            config: { type: 'string' },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'preflight',
        summary: 'Evaluate the authenticated environment gate',
        handler: 'preflight',
        visibility: 'public',
        ordinary: ordinary('preflight'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'doctor',
        summary: 'Report read-only environment diagnostics',
        handler: 'doctor',
        visibility: 'public',
        ordinary: ordinary('doctor'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'logs',
        summary: 'Collect bounded logs for one declared service',
        handler: 'logs',
        visibility: 'public',
        ordinary: ordinary('logs', { ...configured, service: value('declared-service', true), tail: value('tail'), since: value('since'), follow: flag }),
        options: {
            config: { type: 'string' },
            service: { type: 'string' },
            tail: { type: 'string', default: '100' },
            since: { type: 'string', default: '15m' },
            follow: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'baseline-record',
        summary: 'Record an explicitly confirmed environment baseline',
        handler: 'baseline-record',
        visibility: 'public',
        ordinary: unavailable('baseline recording requires separate approval'),
        options: {
            config: { type: 'string' },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    { name: 'work-intake', handler: 'work-intake', summary: 'Prepare a source-bound work order', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...workOrderOption, intent: { type: 'string' }, candidate: { type: 'string' } } },
    { name: 'work-status', handler: 'work-status', summary: 'Report current work-order state', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work-accept', handler: 'work-accept', summary: 'Interactively accept the exact current work order', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ ...workOrderOption, interactive: { type: 'boolean', default: false } } } },
    { name: 'work-renew', handler: 'work-renew', summary: 'Interactively renew a changed work-order contract', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ ...workOrderOption, interactive: { type: 'boolean', default: false } } } },
    { name: 'work-resume', handler: 'work-resume', summary: 'Resume the next executable step of the single active work order', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: workOptions },
    { name: 'work-recover', handler: 'work-recover', summary: 'Inspect or explicitly recover one interrupted work lock', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, lock: { type: 'string' }, apply: { type: 'boolean', default: false } } },
    { name: 'work-execute', handler: 'work-execute', summary: 'Execute one admitted work-order step', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ ...workOrderOption, approach: { type: 'string' } } } },
    { name: 'work-record', handler: 'work-record', summary: 'Persist current work-order progress', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...workOrderOption, 'event-file': { type: 'string' } } },
    { name: 'work-review', handler: 'work-review', summary: 'Review the current accepted work order', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work-sweep', handler: 'work-sweep', summary: 'Inspect or apply a reversible work-order sweep', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ apply: { type: 'boolean', default: false } } } },
    { name: 'work-reverse', handler: 'work-reverse', summary: 'Reverse an authenticated work-order sweep', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work-programme-mint', handler: 'work-programme-mint', summary: 'Mint the next declared programme work order', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ programme: { type: 'string' }, item: { type: 'string' }, candidate: { type: 'string' } } } },
    { name: 'work-metrics', handler: 'work-metrics', summary: 'Report attributed work-order metrics', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: workOptions },
    { name: 'work-grade', handler: 'work-grade', summary: 'Independently grade the current accepted work order', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'browser-drive', handler: 'browser-drive', summary: 'Drive the declared application browser surfaces', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser-accessibility', handler: 'browser-accessibility', summary: 'Collect bounded application accessibility observations', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser-screenshot', handler: 'browser-screenshot', summary: 'Capture the declared application surfaces', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser-debugger', handler: 'browser-debugger', summary: 'Prepare an explicitly requested browser debugger', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'test-run', handler: 'test-run', summary: 'Run a declared product gate with honest selection', visibility: 'public',
        ordinary: unavailable('work, browser and product-gate operations require their dedicated admission'),
        options: { ...workOptions, ...{ gate: { type: 'string' }, mode: { type: 'string', default: 'canonical' }, select: { type: 'string' } } } },
] as const satisfies readonly CommandDefinition[]

export interface InternalCommandDefinition {
    readonly name: 'guard-evaluate'
    readonly handler: 'guard-evaluate'
    readonly visibility: 'internal'
    readonly ordinary: Readonly<{ availability: 'unavailable'; reason: string }>
    readonly argv: typeof GUARD_HANDLER_ARGV
    readonly options: Readonly<{ harness: { readonly type: 'string' } }>
}
export const internalCommands: readonly InternalCommandDefinition[] = Object.freeze([Object.freeze({
    name: 'guard-evaluate', handler: 'guard-evaluate', visibility: 'internal',
    ordinary: Object.freeze({ availability: 'unavailable', reason: 'private guard transport never grants ordinary authority' }),
    argv: GUARD_HANDLER_ARGV, options: Object.freeze({ harness: Object.freeze({ type: 'string' }) }),
})])

export interface OrdinaryInvocationAuthority {
    readonly executable: string
    readonly canonicalRoot: string
    readonly allowedRoots: readonly string[]
    readonly configPath: string
    readonly services: readonly string[]
}

function canonicalPath(path: unknown): path is string {
    return typeof path === 'string' && path !== '/' && isAbsolute(path) && normalize(path) === path
        && !path.endsWith('/') && !/[\x00-\x1f\x7f-\x9f\\\uD800-\uDFFF]/u.test(path)
        && Buffer.byteLength(path) <= GUARD_INPUT_LIMITS.pathBytes
}

function record(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Classify one exact candidate; the caller authenticates filesystem and executable authority. */
export function resolveOrdinaryInvocation(input: GuardInvocationProfile, authority: OrdinaryInvocationAuthority,
    inspectPath: (path: string) => boolean): GuardInvocationProfile | undefined {
    const candidate = snapshotJson(input)
    const captured = snapshotJson(authority)
    if (!record(candidate)
        || Object.keys(candidate).sort().join(',') !== 'argv,cwd,executable'
        || !record(captured)
        || Object.keys(captured).sort().join(',') !== 'allowedRoots,canonicalRoot,configPath,executable,services') return undefined
    const source = captured as unknown as OrdinaryInvocationAuthority
    if (!canonicalPath(source.executable) || !canonicalPath(source.canonicalRoot) || !canonicalPath(source.configPath)
        || !Array.isArray(source.allowedRoots) || source.allowedRoots.length > GUARD_INPUT_LIMITS.paths
        || !source.allowedRoots.every(canonicalPath) || !source.allowedRoots.includes(source.canonicalRoot)
        || !Array.isArray(source.services) || !source.services.every(service => typeof service === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(service))
        || candidate.executable !== source.executable || candidate.cwd !== source.canonicalRoot
        || !Array.isArray(candidate.argv) || candidate.argv.length === 0 || candidate.argv.length > GUARD_INPUT_LIMITS.words
        || !candidate.argv.every(arg => typeof arg === 'string' && arg.length > 0
            && Buffer.byteLength(arg) <= GUARD_INPUT_LIMITS.wordBytes && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(arg))) return undefined
    const args = candidate.argv as readonly string[]
    const definition = commands.find(row => row.name === args[0])
    const available: OrdinaryCommandMetadata | undefined = definition?.ordinary
    if (!definition || definition.visibility !== 'public' || available?.availability !== 'available') return undefined
    const operation = args[1]
    const variant = available.operationVariants && (operation === 'validate' || operation === 'run' || operation === 'status')
        ? available.operationVariants[operation] : undefined
    if (available.operationVariants && !variant) return undefined
    const grammar = variant ? { ...available, ...variant } : available
    const paths = new Set<string>()
    const confined = (path: string) => {
        if (!path || path.includes('\\') || path.split('/').includes('..') || /[*?\[\]]/.test(path)) return false
        const absolute = resolve(source.canonicalRoot, path)
        if (!canonicalPath(absolute) || !source.allowedRoots.some(root => absolute === root || absolute.startsWith(root + '/'))) return false
        paths.add(absolute)
        return true
    }
    if (grammar.configuration === 'resolved' && !confined(source.configPath)) return undefined
    const positionals: string[] = []
    const options = new Map<string, string | true>()
    for (let index = 1; index < args.length; index++) {
        const arg = args[index]!
        if (!arg.startsWith('-')) { positionals.push(arg); continue }
        if (!arg.startsWith('--') || arg === '--') return undefined
        const equal = arg.indexOf('=')
        const name = arg.slice(2, equal < 0 ? undefined : equal)
        const option = grammar.options[name]
        if (!option || options.has(name) || grammar.forbidden.presence.includes(name)) return undefined
        if (option.kind === 'flag') {
            if (equal >= 0) return undefined
            options.set(name, true)
            continue
        }
        const text = equal < 0 ? args[++index] : arg.slice(equal + 1)
        if (!text || text.startsWith('-')) return undefined
        const valid = option.role === 'confined-path' ? confined(text)
            : option.role === 'resolved-config' ? confined(text) && resolve(source.canonicalRoot, text) === source.configPath
            : option.role === 'declared-service' ? source.services.includes(text)
            : option.role === 'tail' ? /^[1-9]\d{0,4}$/.test(text) && Number(text) <= 10_000
            : option.role === 'since' ? text.length <= 64 && (/^\d+(?:\.\d+)?[smhd]$/.test(text)
                || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(text) && Number.isFinite(Date.parse(text)))
            : option.role === 'surface-target' ? SURFACE_TARGETS.some(target => target === text)
            : option.role === 'sha256' && /^[a-f0-9]{64}$/.test(text)
        if (!valid) return undefined
        options.set(name, text)
    }
    if (positionals.length < grammar.positional.min || positionals.length > grammar.positional.max
        || positionals.some((path, index) => grammar.positional.roles[index] === 'compare-operation'
            ? path !== operation : grammar.positional.roles[index] !== 'confined-root' || !confined(path))
        || Object.entries(grammar.options).some(([name, option]) => option.required && !options.has(name))
        || grammar.selection === 'root-xor-registry' && (positionals.length === 1) === options.has('registry')
        || grammar.selection === 'release-evidence-pair' && options.has('release-evidence') !== options.has('release-evidence-sha256')
        || grammar.forbidden.values.some(predicate => options.has(predicate.option)
            && predicate.predicate === 'not-lowercase-sha256' && !/^[a-f0-9]{64}$/.test(String(options.get(predicate.option))))
        || typeof inspectPath !== 'function' || [...paths].some(path => !inspectPath(path))) return undefined
    return Object.freeze({ executable: source.executable, cwd: source.canonicalRoot, argv: Object.freeze([...args]) })
}
