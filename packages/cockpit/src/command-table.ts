import { SURFACE_TARGETS } from './surfaces/contract.js'
import type { ParseArgsConfig } from 'node:util'
import { isAbsolute, normalize, resolve } from 'node:path'
import { WORK_ORDER_ID, WORK_ORDER_LOCKS } from './work-orders/contract.js'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from './environment/contract.js'
import type { GuardInvocationProfile } from './guards/evaluator.js'
import { GUARD_HANDLER_ARGV } from './guards/harness-adapter.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'

export const mechanism = {
    id: 'command-metadata',
    module: 'packages/cockpit/src/command-table.ts',
    exports: ['commands', 'commandStages', 'commandGroups', 'commandSpelling', 'internalCommands', 'describePublicOption', 'resolveOrdinaryInvocation', 'ordinarySessionCommand', 'isWorkHandler', 'isRecordedAnswerField'],
} as const

export function isRecordedAnswerField(value: string): boolean {
    return value.length <= 256 && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)
}

export type WorkHandlerIdentifier =
    | 'work-intake' | 'work-status' | 'work-accept' | 'work-renew' | 'work-resume'
    | 'work-recover' | 'work-execute' | 'work-record' | 'work-answer' | 'work-review' | 'work-sweep' | 'work-reverse' | 'work-programme-mint' | 'work-metrics' | 'work-grade'
    | 'browser-drive' | 'browser-screenshot' | 'browser-debugger' | 'test-run'

export type HandlerIdentifier = WorkHandlerIdentifier
    | 'check'
    | 'doctor'
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
    | 'tool'
    | 'session'
    | 'sleep'
    | 'sync'
    | 'up'
    | 'upgrade'

export type CommandStage = 'set-up' | 'generate-and-verify' | 'run-the-stack' | 'diagnose' | 'test-and-grade'

/** The order a newcomer meets the commands in, as the README's "Commands at a glance" table names it. */
export const commandStages: readonly Readonly<{ id: CommandStage; title: string }>[] = Object.freeze([
    { id: 'set-up', title: 'Set up' },
    { id: 'generate-and-verify', title: 'Generate and verify' },
    { id: 'run-the-stack', title: 'Run the stack' },
    { id: 'diagnose', title: 'Diagnose' },
    { id: 'test-and-grade', title: 'Test and grade' },
])

/**
 * A group is a first command word whose commands are named `<group> <subcommand>`. Each subcommand
 * keeps its own row, options and handler, so an option one subcommand reads is never accepted and
 * ignored by another.
 */
export const commandGroups: readonly Readonly<{ name: string; summary: string }>[] = Object.freeze([
    { name: 'work', summary: 'Prepare, accept, execute, review and grade work orders' },
    { name: 'browser', summary: 'Drive, inspect and capture the declared application in a browser' },
])

/**
 * The public command an argv names, and the arguments after it. A group word takes the next word
 * as its subcommand; `subcommand` is absent when none follows, so the caller can show the group.
 */
export function commandSpelling(args: readonly string[]): Readonly<{ name: string | undefined; group?: string; rest: readonly string[] }> {
    const [first, second, ...rest] = args
    const group = commandGroups.find(row => row.name === first)
    if (!group) return { name: first, rest: second === undefined ? [] : [second, ...rest] }
    if (second === undefined || second.startsWith('-')) return { name: undefined, group: group.name, rest: second === undefined ? [] : [second, ...rest] }
    return { name: `${group.name} ${second}`, group: group.name, rest }
}

export interface CommandDefinition {
    /** The words a person types: one word, or `<group> <subcommand>` for a member of commandGroups. */
    name: string
    stage: CommandStage
    summary: string
    /** What follows the command name in its help usage line, when it takes more than options. */
    usage?: string
    handler: HandlerIdentifier
    options: NonNullable<ParseArgsConfig['options']>
    visibility: 'public'
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
    'dry-run': 'Preview without writing or installing anything',
    'event-file': 'Path to the work event file',
    follow: 'Continue collecting logs until cancelled',
    from: 'Path to an existing local repository',
    gate: 'Declared product gate to run',
    image: 'Local container image the runtime measurement probe runs; it is never pulled',
    intent: 'Relative path to the closed JSON intent descriptor; see the Intent descriptor section of ./node_modules/@b00dea/cockpit/docs/work-and-browser.md',
    'instruction-pointer': 'Offer a marked AGENTS.md link for this separate sibling',
    interactive: 'Ask for explicit approval in a terminal',
    item: 'Declared programme item key',
    json: 'Emit one machine-readable JSON response',
    lock: 'Interrupted work lock identifier',
    mode: 'Declared gate execution mode',
    mount: 'How the stack uses the sibling: always, none or profile:<name>',
    'probe-specifications': 'Path to the harness probe specifications; with --write-probe-specifications, the earlier file whose filled rows for unchanged cells carry forward',
    programme: 'Declared programme identifier',
    purpose: 'Short purpose of the sibling repository',
    registry: 'Path to the legacy registry input',
    'reset-answer': 'Preview clearing one recorded init answer field',
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
    'write-probe-specifications': 'Write a probe-specification file for the current manifest to this new path, with the probe fields left for you',
    'write-instruction-pointers': 'Write the reviewed instruction links into opted-in sibling guides',
    'write-instruction-files': 'Write the reviewed AGENTS.md and CLAUDE.md changes that let every agent tool load a sibling\'s instructions',
})

export function describePublicOption(name: string): string {
    const description = FLAG_DESCRIPTIONS[name]
    if (!description) throw new Error(`Public option --${name} has no help description.`)
    return description
}

type OrdinaryValueRole = 'confined-path' | 'resolved-config' | 'declared-service' | 'declared-gate' | 'gate-mode' | 'gate-selector'
    | 'identifier' | 'work-lock' | 'label' | 'field' | 'tail' | 'since' | 'sha256' | 'surface-target' | 'local-image'
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
    positional: Readonly<{ min: number; max: number; roles: readonly ['confined-root'] | readonly ['operation'] | readonly ['version'] | readonly []; operations?: readonly string[] }>
    options: Readonly<Record<string, OrdinaryOption>>
    cwdRole: 'canonical-root'
    configuration: 'resolved' | 'none'
    forbidden: Readonly<{ presence: readonly string[] }>
    selection?: 'intent-xor-work-order'
    // Admitted only where cockpit.toml sets browser.request_preapproval, which the schema grants only
    // on isolated data that cannot reach production.
    requires?: 'browser-preapproval'
}>

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
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
        forbidden: Object.freeze({ presence: Object.freeze([]) }), ...extra })
}
function unavailable(reason: string): OrdinaryCommandMetadata { return Object.freeze({ availability: 'unavailable', reason }) }

const workOptions = { config: { type: 'string' }, json: { type: 'boolean', default: false } } as const
const workOrderOption = { 'work-order': { type: 'string' } } as const
const workOrderOptions = Object.freeze({ ...configured, 'work-order': value('identifier', true) })
const browserOptions = Object.freeze({ ...configured, role: value('identifier') })
const browserAdmission = Object.freeze({ requires: 'browser-preapproval' as const })


export function isWorkHandler(value: HandlerIdentifier): value is WorkHandlerIdentifier {
    return value.startsWith('work-') || value.startsWith('browser-') || value === 'test-run'
}

export const commands: readonly CommandDefinition[] = [
    {
        name: 'init',
        stage: 'set-up',
        summary: 'Preview, then accept, a first cockpit setup for one agent tool',
        usage: '<root> [options]',
        handler: 'init',
        visibility: 'public',
        ordinary: ordinary('init', { target: value('surface-target', true), registry: value('confined-path'),
            'reset-answer': value('field'), 'accept-reset': value('sha256'), json: flag }, {
            configuration: 'none',
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['confined-root'] as const) }),
            forbidden: Object.freeze({ presence: Object.freeze(['interactive', 'answers', 'accept-preview', 'accept-defaults']) }),
        }),
        options: { target: { type: 'string' }, registry: { type: 'string' },
            interactive: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
            answers: { type: 'string' }, 'accept-preview': { type: 'string' }, 'accept-defaults': { type: 'string' },
            'reset-answer': { type: 'string' }, 'accept-reset': { type: 'string' } },
    },
    {
        name: 'setup',
        stage: 'set-up',
        summary: 'Clone or locate the declared sibling repositories and link them',
        handler: 'setup',
        visibility: 'public',
        ordinary: ordinary('setup', configured, { forbidden: Object.freeze({ presence: Object.freeze(['write-instruction-pointers', 'write-instruction-files']) }) }),
        options: {
            config: { type: 'string' },
            'write-instruction-pointers': { type: 'boolean', default: false },
            'write-instruction-files': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'sibling',
        stage: 'set-up',
        summary: 'Add or remove a repository in cockpit.toml (sibling add, sibling remove)',
        usage: 'add|remove <slug> [options]',
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
        name: 'tool',
        stage: 'set-up',
        summary: 'Add or remove an agent tool in cockpit.toml (tool add, tool remove)',
        usage: `add|remove <${SURFACE_TARGETS.join('|')}> [options]`,
        handler: 'tool',
        visibility: 'public',
        // Classified with sibling add and remove: both rewrite cockpit.toml.
        ordinary: unavailable('tool add and remove rewrite cockpit.toml'),
        options: {
            config: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'registry-resolve',
        stage: 'set-up',
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
        name: 'upgrade',
        stage: 'set-up',
        summary: 'Move the exact cockpit pin to a newer version and re-run sync',
        usage: '[<version>] [options]',
        handler: 'upgrade',
        visibility: 'public',
        // The install is exact and sync keeps its own refusals (stale removals need a digest), so an agent
        // may run the real upgrade; the version is the one positional.
        ordinary: ordinary('upgrade', { config: configured.config, 'dry-run': flag }, {
            positional: Object.freeze({ min: 0, max: 1, roles: Object.freeze(['version'] as const) }) }),
        options: {
            config: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
        },
    },
    {
        name: 'sync',
        stage: 'generate-and-verify',
        summary: 'Write the generated stack and agent files from cockpit.toml',
        handler: 'sync',
        visibility: 'public',
        // Adoption rewrites cockpit.toml and moves a team's harness settings, and a real sync rewrites
        // the guard's own files, so only the dry run is an ordinary agent invocation.
        ordinary: ordinary('sync', { ...configured, 'dry-run': Object.freeze({ ...flag, required: true as const }) }, { forbidden: Object.freeze({ presence: Object.freeze(['interactive', 'adopt']) }) }),
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
        stage: 'generate-and-verify',
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
        stage: 'generate-and-verify',
        summary: 'Test whether agent tools enforce the generated controls',
        handler: 'selftest',
        visibility: 'public',
        ordinary: ordinary('selftest', { ...configured, 'probe-specifications': value('confined-path', true) }, { forbidden: Object.freeze({ presence: Object.freeze(['interactive']) }) }),
        options: {
            config: { type: 'string' },
            'probe-specifications': { type: 'string' },
            'write-probe-specifications': { type: 'string' },
            interactive: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    },
    {
        name: 'runtime',
        stage: 'run-the-stack',
        summary: 'Measure the local container runtime (runtime measure) and record the result for this machine',
        usage: 'measure [options]',
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
        name: 'up',
        stage: 'run-the-stack',
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
        name: 'preflight',
        stage: 'run-the-stack',
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
        name: 'session',
        stage: 'run-the-stack',
        summary: 'Keep the environment available for one command, then release it',
        usage: '[options] -- <command> [args...]',
        handler: 'session',
        visibility: 'public',
        // The guard admits `session --config <file> -- <command>` only when it admits the inner command.
        ordinary: unavailable('session wraps an arbitrary foreground command'),
        options: {
            config: { type: 'string' },
        },
    },
    {
        name: 'logs',
        stage: 'run-the-stack',
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
        name: 'sleep',
        stage: 'run-the-stack',
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
        name: 'down',
        stage: 'run-the-stack',
        summary: 'Stop and remove the stack (on the active local Docker context)',
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
        stage: 'run-the-stack',
        summary: 'Preview a reset, or approve that exact preview interactively (on the active local Docker context)',
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
        name: 'doctor',
        stage: 'diagnose',
        summary: 'Report environment problems without changing anything',
        handler: 'doctor',
        visibility: 'public',
        ordinary: ordinary('doctor'),
        options: {
            config: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    },
    // A gate runs only the stages a person declared in the reviewed cockpit.toml, which is the trust
    // `up` already has; a selector reaches a stage only through the arguments that stage declares.
    { name: 'test-run', handler: 'test-run', stage: 'test-and-grade', summary: 'Run a declared product test gate and report which tests it selected', visibility: 'public',
        ordinary: ordinary('test-run', { ...configured, gate: value('declared-gate', true), mode: value('gate-mode'), select: value('gate-selector') }),
        options: { ...workOptions, ...{ gate: { type: 'string' }, mode: { type: 'string', default: 'canonical' }, select: { type: 'string' } } } },
    // Intake publishes a draft at most; a person accepts it separately.
    { name: 'work intake', handler: 'work-intake', stage: 'test-and-grade', summary: 'Prepare a work order from its source document', visibility: 'public',
        ordinary: ordinary('work-intake', { ...configured, 'work-order': value('identifier'), intent: value('confined-path'), candidate: value('confined-path') },
            { selection: 'intent-xor-work-order' }),
        options: { ...workOptions, ...workOrderOption, intent: { type: 'string' }, candidate: { type: 'string' } } },
    { name: 'work status', handler: 'work-status', stage: 'test-and-grade', summary: 'Report current work-order state', visibility: 'public',
        ordinary: ordinary('work-status', { ...configured, 'work-order': value('identifier') }),
        options: { ...workOptions, ...workOrderOption } },
    { name: 'work accept', handler: 'work-accept', stage: 'test-and-grade', summary: 'Interactively accept the exact current work order', visibility: 'public',
        ordinary: unavailable("acceptance is a person's answer, in an interactive terminal, to the contract digest it displays"),
        options: { ...workOptions, ...{ ...workOrderOption, interactive: { type: 'boolean', default: false } } } },
    { name: 'work renew', handler: 'work-renew', stage: 'test-and-grade', summary: 'Interactively renew a changed work-order contract', visibility: 'public',
        ordinary: unavailable("renewal is a person's answer, in an interactive terminal, to the changed contract digest it displays"),
        options: { ...workOptions, ...{ ...workOrderOption, interactive: { type: 'boolean', default: false } } } },
    { name: 'work resume', handler: 'work-resume', stage: 'test-and-grade', summary: 'Resume the next executable step of the single active work order', visibility: 'public',
        ordinary: ordinary('work-resume'),
        options: workOptions },
    // Inspection only reports the holder. --apply deletes the lock once a pid probe calls its holder
    // dead, and that probe sees only this machine's process table: a holder running in a container or
    // on another host that shares the checkout looks dead to it, so a person confirms it is gone.
    { name: 'work recover', handler: 'work-recover', stage: 'test-and-grade', summary: 'Inspect or explicitly recover one interrupted work lock', visibility: 'public',
        ordinary: ordinary('work-recover', { ...configured, lock: value('work-lock', true) }, { forbidden: Object.freeze({ presence: Object.freeze(['apply']) }) }),
        options: { ...workOptions, lock: { type: 'string' }, apply: { type: 'boolean', default: false } } },
    // Execute runs the verification command of a step in an order a person accepted; the approach is a
    // label it records and selects nothing it runs.
    { name: 'work execute', handler: 'work-execute', stage: 'test-and-grade', summary: 'Execute one accepted work-order step', visibility: 'public',
        ordinary: ordinary('work-execute', { ...workOrderOptions, approach: value('label', true) }),
        options: { ...workOptions, ...{ ...workOrderOption, approach: { type: 'string' } } } },
    { name: 'work record', handler: 'work-record', stage: 'test-and-grade', summary: 'Persist current work-order progress', visibility: 'public',
        ordinary: ordinary('work-record', { ...workOrderOptions, 'event-file': value('confined-path', true) }),
        options: { ...workOptions, ...workOrderOption, 'event-file': { type: 'string' } } },
    // A gap's answer and a decision speak for a person, so a person confirms them in a terminal.
    { name: 'work answer', handler: 'work-answer', stage: 'test-and-grade', summary: "Interactively record a person's answer to an open gap, or their decision", visibility: 'public',
        ordinary: unavailable("an answer or decision is a person's, typed in an interactive terminal against the digest it displays"),
        options: { ...workOptions, ...workOrderOption, 'event-file': { type: 'string' }, interactive: { type: 'boolean', default: false } } },
    { name: 'work review', handler: 'work-review', stage: 'test-and-grade', summary: 'Review the current accepted work order', visibility: 'public',
        ordinary: ordinary('work-review', workOrderOptions),
        options: { ...workOptions, ...workOrderOption } },
    // The preview is a report. Parking or un-parking an order changes which orders count against the
    // work-in-progress cap a person set, so applying a sweep and reversing one stay with a person.
    { name: 'work sweep', handler: 'work-sweep', stage: 'test-and-grade', summary: 'Inspect or apply a reversible work-order sweep', visibility: 'public',
        ordinary: ordinary('work-sweep', configured, { forbidden: Object.freeze({ presence: Object.freeze(['apply']) }) }),
        options: { ...workOptions, ...{ apply: { type: 'boolean', default: false } } } },
    { name: 'work reverse', handler: 'work-reverse', stage: 'test-and-grade', summary: 'Reverse a recorded work-order sweep', visibility: 'public',
        ordinary: unavailable('reversing a sweep un-parks an order, which changes the orders that count against the work-in-progress cap a person set'),
        options: { ...workOptions, ...workOrderOption } },
    // Without a candidate it reports the next item. With one it binds that item of the person's
    // programme ledger to the draft for good, so only the report is an agent's to run.
    { name: 'work programme-mint', handler: 'work-programme-mint', stage: 'test-and-grade', summary: 'Mint the next declared programme work order', visibility: 'public',
        ordinary: ordinary('work-programme-mint', { ...configured, programme: value('identifier', true), item: value('identifier') },
            { forbidden: Object.freeze({ presence: Object.freeze(['candidate']) }) }),
        options: { ...workOptions, ...{ programme: { type: 'string' }, item: { type: 'string' }, candidate: { type: 'string' } } } },
    { name: 'work metrics', handler: 'work-metrics', stage: 'test-and-grade', summary: 'Report work-order metrics', visibility: 'public',
        ordinary: ordinary('work-metrics'),
        options: workOptions },
    // Review and grade hand the order to evaluators running apart from the agent that did the work.
    { name: 'work grade', handler: 'work-grade', stage: 'test-and-grade', summary: 'Independently grade the current accepted work order', visibility: 'public',
        ordinary: ordinary('work-grade', workOrderOptions),
        options: { ...workOptions, ...workOrderOption } },
    // Driving signs in and captures the application, so it runs unprompted only on the data posture a
    // person wrote down as safe for that.
    { name: 'browser drive', handler: 'browser-drive', stage: 'test-and-grade', summary: 'Drive the declared application browser surfaces', visibility: 'public',
        ordinary: ordinary('browser-drive', browserOptions, browserAdmission),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser screenshot', handler: 'browser-screenshot', stage: 'test-and-grade', summary: 'Capture the declared application surfaces', visibility: 'public',
        ordinary: ordinary('browser-screenshot', browserOptions, browserAdmission),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
    { name: 'browser debugger', handler: 'browser-debugger', stage: 'test-and-grade', summary: 'Prepare an explicitly requested browser debugger', visibility: 'public',
        ordinary: unavailable("the debugger opens a headed browser for a person at this machine's display, on that person's explicit request"),
        options: { ...workOptions, ...{ role: { type: 'string' } } } },
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
    /** Test gate ids the configuration declares. */
    readonly gates: readonly string[]
    /** Whether the configuration preapproves browser commands. */
    readonly browserPreapproved: boolean
}

// An image reference or ID as Docker spells it; the command itself refuses one that is not local.
const LOCAL_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/
// A work order, lock, programme, item or browser role id shares the work-order id shape.
const WORK_LOCKS: ReadonlySet<string> = new Set(Object.values(WORK_ORDER_LOCKS))
// A selected value that starts with `-` would reach the product's tool as an option of its own.
const GATE_SELECTOR = /^(?:spec|file|test|route):[^-]/

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
        || Object.keys(captured).sort().join(',') !== 'allowedRoots,browserPreapproved,canonicalRoot,configPath,executable,gates,services') return undefined
    const source = captured as unknown as OrdinaryInvocationAuthority
    if (!canonicalPath(source.executable) || !canonicalPath(source.canonicalRoot) || !canonicalPath(source.configPath)
        || !Array.isArray(source.allowedRoots) || source.allowedRoots.length > GUARD_INPUT_LIMITS.paths
        || !source.allowedRoots.every(canonicalPath) || !source.allowedRoots.includes(source.canonicalRoot)
        || !Array.isArray(source.services) || !source.services.every(service => typeof service === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(service))
        || !Array.isArray(source.gates) || !source.gates.every(gate => typeof gate === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(gate))
        || typeof source.browserPreapproved !== 'boolean'
        || candidate.executable !== source.executable || candidate.cwd !== source.canonicalRoot
        || !Array.isArray(candidate.argv) || candidate.argv.length === 0 || candidate.argv.length > GUARD_INPUT_LIMITS.words
        || !candidate.argv.every(arg => typeof arg === 'string' && arg.length > 0
            && Buffer.byteLength(arg) <= GUARD_INPUT_LIMITS.wordBytes && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(arg))) return undefined
    const args = candidate.argv as readonly string[]
    // A group member is named by its first two words; its options follow both.
    const spelling = commandSpelling(args)
    const definition = commands.find(row => row.name === spelling.name)
    const available: OrdinaryCommandMetadata | undefined = definition?.ordinary
    if (!definition || definition.visibility !== 'public' || available?.availability !== 'available') return undefined
    const grammar = available
    if (grammar.requires === 'browser-preapproval' && !source.browserPreapproved) return undefined
    const paths = new Set<string>()
    const confined = (path: string) => {
        if (!path || path.includes('\\') || path.split('/').includes('..') || /[*?\[\]]/.test(path)) return false
        const absolute = resolve(source.canonicalRoot, path)
        if (!canonicalPath(absolute) || !source.allowedRoots.some(root => absolute === root || absolute.startsWith(root + '/'))) return false
        paths.add(absolute)
        return true
    }
    if (grammar.configuration === 'resolved' && !confined(source.configPath)) return undefined
    const reads: string[] = []
    const positionals: string[] = []
    const options = new Map<string, string | true>()
    const words = spelling.rest
    for (let index = 0; index < words.length; index++) {
        const arg = words[index]!
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
        const text = equal < 0 ? words[++index] : arg.slice(equal + 1)
        if (!text || text.startsWith('-')) return undefined
        if (option.role === 'confined-path') reads.push(resolve(source.canonicalRoot, text))
        const valid = option.role === 'confined-path' ? confined(text)
            : option.role === 'resolved-config' ? confined(text) && resolve(source.canonicalRoot, text) === source.configPath
            : option.role === 'declared-service' ? source.services.includes(text)
            : option.role === 'declared-gate' ? source.gates.includes(text)
            : option.role === 'gate-mode' ? ['canonical', 'full', 'staged'].includes(text)
            : option.role === 'gate-selector' ? GATE_SELECTOR.test(text)
            : option.role === 'identifier' ? WORK_ORDER_ID.test(text)
            : option.role === 'work-lock' ? WORK_ORDER_ID.test(text) || WORK_LOCKS.has(text)
            : option.role === 'label' ? true
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
            : grammar.positional.roles[index] === 'version' ? !EXACT_VERSION.test(word)
            : grammar.positional.roles[index] !== 'confined-root' || !confined(word))
        || Object.entries(grammar.options).some(([name, option]) => option.required && !options.has(name))
        || grammar.selection === 'intent-xor-work-order' && (options.has('intent') === options.has('work-order') || options.has('candidate') && !options.has('intent'))
        || typeof inspectPath !== 'function' || [...paths].some(path => !inspectPath(path))) return undefined
    return Object.freeze({ executable: source.executable, cwd: source.canonicalRoot, argv: Object.freeze([...args]),
        ...(reads.length ? { reads: Object.freeze(reads) } : {}) })
}
