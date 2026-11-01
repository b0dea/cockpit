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
    exports: ['commands', 'internalCommands', 'describePublicOption', 'resolveOrdinaryInvocation', 'ordinarySessionCommand', 'isWorkHandler', 'isRecordedAnswerField'],
} as const

export function isRecordedAnswerField(value: string): boolean {
    return value.length <= 256 && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)
}

export type WorkHandlerIdentifier =
    | 'work-intake' | 'work-status' | 'work-accept' | 'work-renew' | 'work-resume'
    | 'work-recover' | 'work-execute' | 'work-record' | 'work-review' | 'work-sweep' | 'work-reverse' | 'work-programme-mint' | 'work-metrics' | 'work-grade'
    | 'browser-drive' | 'browser-accessibility' | 'browser-screenshot' | 'browser-debugger' | 'test-run'

export type HandlerIdentifier = WorkHandlerIdentifier
    | 'baseline-record'
    | 'check'
    | 'doctor'
    | 'document'
    | 'down'
    | 'init'
    | 'logs'
    | 'preflight'
    | 'registry-resolve'
    | 'reset'
    | 'runtime'
    | 'setup'
    | 'selftest'
    | 'sibling'
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
    experimental?: true
    ordinary: OrdinaryCommandMetadata
}

const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
    'accept-defaults': 'Accept the displayed defaults with their exact SHA-256 digest',
    'accept-preview': 'Accept the displayed init preview with its exact SHA-256 digest',
    'accept-reset': 'Accept the displayed answer reset with its exact SHA-256 digest',
    adopt: 'Move one existing harness settings path under cockpit ownership',
    adoption: 'Path to the legacy adoption shell data',
    answers: 'Path to the init answers file',
    apply: 'Apply the displayed reversible operation',
    approach: 'Record the selected work approach',
    candidate: 'Relative path to the candidate source',
    config: 'Path to cockpit.toml',
    create: 'Create a new local sibling repository',
    dir: 'Directory for the sibling checkout',
    'dry-run': 'Preview generated changes without writing them',
    'event-file': 'Path to the work event file',
    follow: 'Continue collecting logs until cancelled',
    from: 'Path to an existing local repository',
    gate: 'Declared product gate to run',
    image: 'Local container image the runtime measurement probe runs; it is never pulled',
    intent: 'Relative path to the closed JSON intent descriptor; see https://github.com/b0dea/cockpit/blob/main/docs/work-and-browser.md#intent-descriptor',
    'instruction-pointer': 'Offer a marked AGENTS.md link for this separate sibling',
    interactive: 'Ask for explicit approval in a terminal',
    item: 'Declared programme item key',
    json: 'Emit one machine-readable JSON response',
    lock: 'Interrupted work lock identifier',
    mode: 'Declared gate execution mode',
    mount: 'How the stack uses the sibling: always, none or profile:<name>',
    output: 'Write the generated artifact to this new file',
    'probe-specifications': 'Path to the harness probe specifications',
    programme: 'Declared programme identifier',
    purpose: 'Short purpose of the sibling repository',
    registry: 'Path to the legacy registry input',
    'reset-answer': 'Preview clearing one recorded init answer field',
    'release-evidence': "Path to the target version's release-evidence file",
    'release-evidence-sha256': 'Expected SHA-256 of that file',
    remote: 'Repository remote URL recorded for the sibling',
    role: 'Declared browser role',
    select: 'Optional subset of the gate to run',
    service: 'Declared service whose logs are collected',
    'siblings-root': 'Root directory containing sibling checkouts',
    since: 'Collect logs no older than this duration',
    tail: 'Maximum number of log records to collect',
    target: 'Agent surface target to initialize',
    var: 'Environment variable mapping for the sibling',
    'work-order': 'Work-order identifier',
    'write-instruction-pointers': 'Write the reviewed instruction links into opted-in sibling guides',
})

export function describePublicOption(name: string): string {
    const description = FLAG_DESCRIPTIONS[name]
    if (!description) throw new Error(`Public option --${name} has no help description.`)
    return description
}

type OrdinaryValueRole = 'confined-path' | 'resolved-config' | 'declared-service' | 'field' | 'tail' | 'since' | 'sha256' | 'surface-target' | 'local-image'
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
    // An `operation` positional must be one of `operations`, the exact subcommand words.
    positional: Readonly<{ min: number; max: number; roles: readonly ['confined-root'] | readonly ['operation'] | readonly []; operations?: readonly string[] }>
    options: Readonly<Record<string, OrdinaryOption>>
    cwdRole: 'canonical-root'
    configuration: 'resolved' | 'none'
    forbidden: Readonly<{ presence: readonly string[]; values: readonly { option: string; predicate: 'not-lowercase-sha256' }[] }>
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

export const commands: readonly CommandDefinition[] = [
    {
        name: 'init',
        summary: 'Preview, then accept, a first cockpit setup for one agent tool',
        handler: 'init',
        visibility: 'public',
        ordinary: ordinary('init', { target: value('surface-target', true), registry: value('confined-path'),
            'reset-answer': value('field'), 'accept-reset': value('sha256'), json: flag }, {
            configuration: 'none',
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['confined-root'] as const) }),
            forbidden: Object.freeze({ presence: Object.freeze(['interactive', 'answers', 'accept-preview', 'accept-defaults']), values: Object.freeze([]) }),
        }),
        options: { target: { type: 'string' }, registry: { type: 'string' },
            interactive: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
            answers: { type: 'string' }, 'accept-preview': { type: 'string' }, 'accept-defaults': { type: 'string' },
            'reset-answer': { type: 'string' }, 'accept-reset': { type: 'string' } },
    },
    {
        name: 'document',
        summary: 'Draft cockpit.toml from an existing cockpit, marking every inferred value',
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
        summary: 'Turn a validated shell registry into data shell scripts can source',
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
        summary: 'Clone or locate the declared sibling repositories and link them',
        handler: 'setup',
        visibility: 'public',
        ordinary: ordinary('setup', configured, { forbidden: Object.freeze({ presence: Object.freeze(['write-instruction-pointers']), values: Object.freeze([]) }) }),
        options: {
            config: { type: 'string' },
            'write-instruction-pointers': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'sync',
        summary: 'Write the generated stack and agent files from cockpit.toml',
        handler: 'sync',
        visibility: 'public',
        // Adoption rewrites cockpit.toml and moves a team's harness settings, and a real sync rewrites
        // the guard's own files, so only the dry run is an ordinary agent invocation.
        ordinary: ordinary('sync', { ...configured, 'dry-run': Object.freeze({ ...flag, required: true as const }) }, { forbidden: Object.freeze({ presence: Object.freeze(['interactive', 'adopt']), values: Object.freeze([]) }) }),
        options: {
            config: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            adopt: { type: 'string', multiple: true },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'check',
        summary: 'Report generated files that no longer match cockpit.toml',
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
        summary: 'Test whether agent tools enforce the generated controls',
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
        summary: 'Show the steps to upgrade cockpit without applying them',
        handler: 'upgrade',
        visibility: 'public',
        experimental: true,
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
        summary: 'Release this checkout and stop the stack if no other holder remains',
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
        // The guard admits `session --config <file> -- <command>` only when it admits the inner command.
        ordinary: unavailable('session wraps an arbitrary foreground command'),
        options: {
            config: { type: 'string' },
        },
    },
    {
        name: 'down',
        summary: 'Stop and remove the stack (run with DOCKER_CONTEXT set)',
        handler: 'down',
        visibility: 'public',
        // down removes only the containers and networks cockpit created; reset, which deletes data, stays out.
        ordinary: ordinary('down'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'reset',
        summary: 'Preview a reset, or approve that exact preview interactively (run with DOCKER_CONTEXT set)',
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
        name: 'runtime',
        summary: 'Measure the local container runtime (runtime measure) and record the result for this machine',
        handler: 'runtime',
        visibility: 'public',
        // The probe runs a disposable stack under its own project, cleans it up, and records the result
        // only in this machine's ignored state, so an agent can measure before its first `up`.
        ordinary: ordinary('runtime', { ...configured, image: value('local-image', true) }, {
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['operation'] as const), operations: Object.freeze(['measure']) }),
        }),
        options: {
            config: { type: 'string' },
            image: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'sibling',
        summary: 'Add or remove a repository in cockpit.toml (sibling add, sibling remove)',
        handler: 'sibling',
        visibility: 'public',
        ordinary: unavailable('sibling add and remove rewrite cockpit.toml'),
        options: {
            config: { type: 'string' },
            create: { type: 'boolean', default: false },
            from: { type: 'string' },
            remote: { type: 'string' },
            dir: { type: 'string' },
            var: { type: 'string' },
            purpose: { type: 'string' },
            mount: { type: 'string' },
            'instruction-pointer': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'preflight',
        summary: 'Check that the environment is healthy and ready for work',
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
        summary: 'Report environment problems without changing anything',
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
        summary: 'Show recent logs for one declared service',
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
        experimental: true,
        ordinary: unavailable('baseline recording requires separate approval'),
        options: {
            config: { type: 'string' },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    { name: 'work-intake', handler: 'work-intake', summary: 'Prepare a work order from its source document', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...workOrderOption, intent: { type: 'string' }, candidate: { type: 'string' } } },
    { name: 'work-status', handler: 'work-status', summary: 'Report current work-order state', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work-accept', handler: 'work-accept', summary: 'Interactively accept the exact current work order', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ ...workOrderOption, interactive: { type: 'boolean', default: false } } } },
    { name: 'work-renew', handler: 'work-renew', summary: 'Interactively renew a changed work-order contract', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ ...workOrderOption, interactive: { type: 'boolean', default: false } } } },
    { name: 'work-resume', handler: 'work-resume', summary: 'Resume the next executable step of the single active work order', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: workOptions },
    { name: 'work-recover', handler: 'work-recover', summary: 'Inspect or explicitly recover one interrupted work lock', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, lock: { type: 'string' }, apply: { type: 'boolean', default: false } } },
    { name: 'work-execute', handler: 'work-execute', summary: 'Execute one accepted work-order step', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ ...workOrderOption, approach: { type: 'string' } } } },
    { name: 'work-record', handler: 'work-record', summary: 'Persist current work-order progress', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...workOrderOption, 'event-file': { type: 'string' } } },
    { name: 'work-review', handler: 'work-review', summary: 'Review the current accepted work order', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work-sweep', handler: 'work-sweep', summary: 'Inspect or apply a reversible work-order sweep', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ apply: { type: 'boolean', default: false } } } },
    { name: 'work-reverse', handler: 'work-reverse', summary: 'Reverse a recorded work-order sweep', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work-programme-mint', handler: 'work-programme-mint', summary: 'Mint the next declared programme work order', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ programme: { type: 'string' }, item: { type: 'string' }, candidate: { type: 'string' } } } },
    { name: 'work-metrics', handler: 'work-metrics', summary: 'Report work-order metrics', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: workOptions },
    { name: 'work-grade', handler: 'work-grade', summary: 'Independently grade the current accepted work order', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'browser-drive', handler: 'browser-drive', summary: 'Drive the declared application browser surfaces', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser-accessibility', handler: 'browser-accessibility', summary: 'Collect accessibility observations from the application', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser-screenshot', handler: 'browser-screenshot', summary: 'Capture the declared application surfaces', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser-debugger', handler: 'browser-debugger', summary: 'Prepare an explicitly requested browser debugger', visibility: 'public', experimental: true,
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'test-run', handler: 'test-run', summary: 'Run a declared product test gate and report which tests it selected', visibility: 'public',
        ordinary: unavailable('work, browser and test-run commands each have their own approval flow'),
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
    ordinary: Object.freeze({ availability: 'unavailable', reason: 'the guard hook calls this internally; it is not a user command' }),
    argv: GUARD_HANDLER_ARGV, options: Object.freeze({ harness: Object.freeze({ type: 'string' }) }),
})])

export interface OrdinaryInvocationAuthority {
    readonly executable: string
    readonly canonicalRoot: string
    readonly allowedRoots: readonly string[]
    readonly configPath: string
    readonly services: readonly string[]
}

// An image reference or ID as Docker spells it; the command itself refuses one that is not local.
const LOCAL_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/

function canonicalPath(path: unknown): path is string {
    return typeof path === 'string' && path !== '/' && isAbsolute(path) && normalize(path) === path
        && !path.endsWith('/') && !/[\x00-\x1f\x7f-\x9f\\\uD800-\uDFFF]/u.test(path)
        && Buffer.byteLength(path) <= GUARD_INPUT_LIMITS.pathBytes
}

function record(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The inner command of an exact `session --config <configured file> -- <command…>` run from the
 * cockpit root, or undefined. The guard admits the session only when it admits the inner command,
 * so a session never runs what the agent could not run directly.
 */
export function ordinarySessionCommand(argv: readonly string[], cwd: string,
    authority: Readonly<{ canonicalRoot: string; configPath: string }>): readonly string[] | undefined {
    const separator = argv.indexOf('--')
    if (argv[0] !== 'session' || separator < 0 || separator === argv.length - 1 || cwd !== authority.canonicalRoot) return undefined
    const options = argv.slice(1, separator)
    const config = options.length === 2 && options[0] === '--config' ? options[1]
        : options.length === 1 && options[0]!.startsWith('--config=') ? options[0]!.slice('--config='.length) : undefined
    return config && resolve(cwd, config) === authority.configPath ? argv.slice(separator + 1) : undefined
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
    const grammar = available
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
            : option.role === 'field' ? isRecordedAnswerField(text)
            : option.role === 'tail' ? /^[1-9]\d{0,4}$/.test(text) && Number(text) <= 10_000
            : option.role === 'since' ? text.length <= 64 && (/^\d+(?:\.\d+)?[smhd]$/.test(text)
                || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(text) && Number.isFinite(Date.parse(text)))
            : option.role === 'surface-target' ? SURFACE_TARGETS.some(target => target === text)
            : option.role === 'local-image' ? LOCAL_IMAGE.test(text)
            : option.role === 'sha256' && /^[a-f0-9]{64}$/.test(text)
        if (!valid) return undefined
        options.set(name, text)
    }
    if (positionals.length < grammar.positional.min || positionals.length > grammar.positional.max
        || positionals.some((word, index) => grammar.positional.roles[index] === 'operation'
            ? !grammar.positional.operations?.includes(word)
            : grammar.positional.roles[index] !== 'confined-root' || !confined(word))
        || Object.entries(grammar.options).some(([name, option]) => option.required && !options.has(name))
        || grammar.selection === 'root-xor-registry' && (positionals.length === 1) === options.has('registry')
        || grammar.selection === 'release-evidence-pair' && options.has('release-evidence') !== options.has('release-evidence-sha256')
        || grammar.forbidden.values.some(predicate => options.has(predicate.option)
            && predicate.predicate === 'not-lowercase-sha256' && !/^[a-f0-9]{64}$/.test(String(options.get(predicate.option))))
        || typeof inspectPath !== 'function' || [...paths].some(path => !inspectPath(path))) return undefined
    return Object.freeze({ executable: source.executable, cwd: source.canonicalRoot, argv: Object.freeze([...args]) })
}
