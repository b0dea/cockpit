import { SURFACE_TARGETS } from './surfaces/contract.js'
import type { ParseArgsConfig } from 'node:util'
import { isAbsolute, normalize, resolve } from 'node:path'
import { WORK_ORDER_ID } from './work-orders/contract.js'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from './environment/contract.js'
import type { GuardInvocationProfile } from './guards/evaluator.js'
import { GUARD_HANDLER_ARGV } from './guards/harness-adapter.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'

export function isRecordedAnswerField(value: string): boolean {
    return value.length <= 256 && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)
}

export type WorkHandlerIdentifier =
    | 'work-status' | 'work-accept' | 'work-check' | 'work-note' | 'work-answer' | 'work-grade' | 'work-signoff' | 'work-recover' | 'work-verify' | 'grade-criteria'
    | 'browser-drive' | 'browser-screenshot' | 'test-run'

export type HandlerIdentifier = WorkHandlerIdentifier
    | 'check'
    | 'docs-check'
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
    { name: 'work', summary: 'Accept, check, grade and close work orders' },
    { name: 'browser', summary: 'Drive, inspect and capture the declared application in a browser' },
    { name: 'docs', summary: 'Check living documents and decision records against the repositories' },
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
    abandon: 'Close the order as abandoned; --note says why',
    adopt: 'Move one existing harness settings path under cockpit ownership',
    adoption: 'Path to the legacy adoption shell data',
    answers: 'Path to the init answers file',
    ask: 'Record the note as an open question, which blocks the order until it is answered',
    apply: 'Apply the displayed reversible operation',
    command: 'With --scaffold-compose: the command that starts the app, as words separated by spaces',
    config: 'Path to cockpit.toml',
    create: 'Create a new local sibling repository',
    criteria: 'Path to a file whose YAML front-matter lists the criteria to grade',
    dir: 'Directory for the sibling checkout',
    evaluator: 'Grade with only this agent tool (codexcli, claudecode or opencode), with no fallback to another',
    'dry-run': 'Preview without writing or installing anything',
    follow: 'Continue collecting logs until cancelled',
    from: 'Path to an existing local repository',
    gate: 'Declared product gate to run',
    image: 'Local container image the runtime measurement probe runs; it is never pulled',
    'instruction-pointer': 'Offer a marked AGENTS.md link for this separate sibling',
    interactive: 'Ask for explicit approval in a terminal',
    json: 'Emit one machine-readable JSON response',
    mode: 'Declared gate execution mode',
    mount: 'How the stack uses the sibling: always, none or profile:<name>',
    note: 'What was checked, or what was and was not done',
    partial: 'Close the order as partly done; --note says what is left',
    port: 'With --scaffold-compose: the port the app listens on inside its container',
    'probe-specifications': 'Path to the harness probe specifications; with --write-probe-specifications, the earlier file whose filled rows for unchanged cells carry forward',
    purpose: 'Short purpose of the sibling repository',
    question: 'Number of the open question to answer, as work status lists it',
    registry: 'Path to the legacy registry input',
    'reset-answer': 'Preview clearing one recorded init answer field',
    remote: 'Repository remote URL recorded for the sibling',
    role: 'Declared browser role',
    'scaffold-compose': 'Write a starting compose.yml for the app in this directory, relative to the root, once; it refuses when a Compose file exists',
    select: 'Optional subset of the gate to run',
    service: 'Declared service whose logs are collected',
    'siblings-root': 'Root directory containing sibling checkouts',
    since: 'Collect logs no older than this duration',
    tail: 'Maximum number of log records to collect',
    target: 'Agent tool to set up; comma-separate several (claudecode,opencode)',
    text: 'Text of the note or answer',
    var: 'Environment variable mapping for the sibling',
    verdict: 'Under [work] grading = "self": met or unmet',
    with: 'With --scaffold-compose: backing services to add, from postgres and redis, separated by commas',
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
    | 'identifier' | 'label' | 'field' | 'tail' | 'since' | 'sha256' | 'surface-target' | 'local-image' | 'evaluator-tool'
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
    // Admitted only where cockpit.toml grants it: browser.request_preapproval, which the schema allows
    // only on isolated data that cannot reach production, or an [autonomy] field set to agent.
    requires?: OrdinaryGrant
}>

// Mirrors EvaluatorTool in schema.ts, which this data table may not import.
const EVALUATOR_TOOLS: readonly string[] = ['codexcli', 'claudecode', 'opencode']
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const flag: OrdinaryOption = Object.freeze({ kind: 'flag', role: 'boolean', repetition: 'singleton' })
function value(role: OrdinaryValueRole, required = false): OrdinaryOption {
    return { kind: 'value', role, repetition: 'singleton', ...(required ? { required: true as const } : {}) }
}
/**
 * One row per CLI flag: how the parser reads it and, when an agent may pass it, the role its value
 * must satisfy. A flag with no `agent` role is never admitted in an ordinary agent invocation.
 */
type Flag = Readonly<{ type: 'string' | 'boolean'; default?: string | boolean; multiple?: true; agent?: OrdinaryOption }>
const str = (agent?: OrdinaryOption, fallback?: string): Flag => ({ type: 'string', ...fallback === undefined ? {} : { default: fallback }, ...agent ? { agent } : {} })
const bool = (agent?: OrdinaryOption): Flag => ({ type: 'boolean', default: false, ...agent ? { agent } : {} })
const configFlag = str(value('resolved-config', true))
const jsonFlag = bool(flag)
const configured = { config: configFlag, json: jsonFlag } as const
const workOrderFlag = str(value('identifier', true))

// The flags and their roles are filled in from `flags` when the table is built.
function ordinary(command: HandlerIdentifier, extra: Partial<Extract<OrdinaryCommandMetadata, { availability: 'available' }>> = {}): OrdinaryCommandMetadata {
    return { availability: 'available', executableRole: 'installed-cockpit', command,
        positional: { min: 0, max: 0, roles: [] as const }, options: {},
        cwdRole: 'canonical-root', configuration: 'resolved',
        forbidden: { presence: [] }, ...extra }
}
function unavailable(reason: string): OrdinaryCommandMetadata { return { availability: 'unavailable', reason } }

const browserAdmission = Object.freeze({ requires: 'browser-preapproval' as const })
// --interactive asks for a person at a terminal, so an agent invocation never carries it.
const personFlag = Object.freeze({ forbidden: Object.freeze({ presence: Object.freeze(['interactive']) }) })


export function isWorkHandler(value: HandlerIdentifier): value is WorkHandlerIdentifier {
    return value.startsWith('work-') || value.startsWith('browser-') || value === 'test-run' || value === 'grade-criteria'
}

type CommandSource = Omit<CommandDefinition, 'options'> & { flags: Readonly<Record<string, Flag>> }

const sources = [
    {
        name: 'init',
        stage: 'set-up',
        summary: 'Preview, then accept, a first cockpit setup for one or more agent tools',
        usage: '[<root>] [options]',
        handler: 'init',
        visibility: 'public',
        ordinary: ordinary('init', {
            configuration: 'none',
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['confined-root'] as const) }),
            forbidden: Object.freeze({ presence: Object.freeze(['interactive', 'answers', 'accept-preview', 'accept-defaults']) }),
        }),
        flags: { target: str(value('surface-target', true)), registry: str(value('confined-path')),
            interactive: bool(), json: jsonFlag,
            answers: str(), 'accept-preview': str(), 'accept-defaults': str(),
            'reset-answer': str(value('field')), 'accept-reset': str(value('sha256')),
            'scaffold-compose': str(), command: str(), port: str(), with: str() },
    },
    {
        name: 'setup',
        stage: 'set-up',
        summary: 'Clone or locate the declared sibling repositories and link them',
        handler: 'setup',
        visibility: 'public',
        ordinary: ordinary('setup', { forbidden: Object.freeze({ presence: Object.freeze(['write-instruction-pointers', 'write-instruction-files']) }) }),
        flags: { config: configFlag, 'write-instruction-pointers': bool(), 'write-instruction-files': bool(), json: jsonFlag },
    },
    {
        name: 'sibling',
        stage: 'set-up',
        summary: 'Add or remove a repository in cockpit.toml (sibling add, sibling remove)',
        usage: 'add|remove <slug> [options]',
        handler: 'sibling',
        visibility: 'public',
        ordinary: unavailable('sibling add and remove rewrite cockpit.toml'),
        flags: { config: str(), create: bool(), from: str(), remote: str(), dir: str(), var: str(), purpose: str(), mount: str(),
            'instruction-pointer': bool(), json: bool() },
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
        flags: { config: str(), 'dry-run': bool(), json: bool() },
    },
    {
        name: 'registry-resolve',
        stage: 'set-up',
        summary: 'Turn a validated shell registry into data shell scripts can source',
        handler: 'registry-resolve',
        visibility: 'public',
        ordinary: ordinary('registry-resolve', { configuration: 'none' }),
        flags: { registry: str(value('confined-path', true)), 'siblings-root': str(value('confined-path', true)), adoption: str(value('confined-path', true)), json: jsonFlag },
    },
    {
        name: 'upgrade',
        stage: 'set-up',
        summary: 'Move the exact cockpit pin to a newer version and re-run sync',
        usage: '[<version>] [options]',
        handler: 'upgrade',
        visibility: 'public',
        // The install is exact and its sync child decides as sync does, so an agent runs the real upgrade
        // exactly where [autonomy] sync lets it sync; the version is the one positional.
        ordinary: ordinary('upgrade', {
            positional: Object.freeze({ min: 0, max: 1, roles: Object.freeze(['version'] as const) }), requires: 'autonomy-sync' }),
        flags: { config: configFlag, 'dry-run': bool(flag) },
    },
    {
        name: 'sync',
        stage: 'generate-and-verify',
        summary: 'Write the Compose ownership override and agent files from cockpit.toml',
        handler: 'sync',
        visibility: 'public',
        // Adoption rewrites cockpit.toml and moves a team's harness settings, so it stays a person's. A
        // real sync rewrites the guard's own files from a configuration the guard already pins and
        // holds every call after an edit to, so it is an agent's only where [autonomy] sync = "agent".
        ordinary: ordinary('sync', { forbidden: Object.freeze({ presence: Object.freeze(['interactive', 'adopt']) }), requires: 'autonomy-sync' }),
        flags: { config: configFlag, 'dry-run': bool(flag), adopt: { type: 'string', multiple: true }, interactive: bool(), json: jsonFlag },
    },
    {
        name: 'check',
        stage: 'generate-and-verify',
        summary: 'Report generated files that no longer match cockpit.toml',
        handler: 'check',
        visibility: 'public',
        ordinary: ordinary('check'),
        flags: configured,
    },
    {
        name: 'selftest',
        stage: 'generate-and-verify',
        summary: 'Test whether agent tools enforce the generated controls',
        handler: 'selftest',
        visibility: 'public',
        ordinary: ordinary('selftest', { forbidden: Object.freeze({ presence: Object.freeze(['interactive']) }) }),
        flags: { config: configFlag, 'probe-specifications': str(value('confined-path', true)), 'write-probe-specifications': str(),
            interactive: bool(), json: jsonFlag },
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
        ordinary: ordinary('runtime', {
            positional: Object.freeze({ min: 1, max: 1, roles: Object.freeze(['operation'] as const), operations: Object.freeze(['measure']) }),
        }),
        flags: { config: configFlag, image: str(value('local-image', true)), json: jsonFlag },
    },
    {
        name: 'up',
        stage: 'run-the-stack',
        summary: 'Start or resume the declared environment',
        handler: 'up',
        visibility: 'public',
        ordinary: ordinary('up'),
        flags: configured,
    },
    {
        name: 'preflight',
        stage: 'run-the-stack',
        summary: 'Check that the environment is healthy and ready for work',
        handler: 'preflight',
        visibility: 'public',
        ordinary: ordinary('preflight'),
        flags: configured,
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
        flags: { config: str() },
    },
    {
        name: 'logs',
        stage: 'run-the-stack',
        summary: 'Show recent logs for one declared service',
        handler: 'logs',
        visibility: 'public',
        ordinary: ordinary('logs'),
        flags: { config: configFlag, service: str(value('declared-service', true)), tail: str(value('tail'), '100'), since: str(value('since'), '15m'),
            follow: bool(flag), json: jsonFlag },
    },
    {
        name: 'sleep',
        stage: 'run-the-stack',
        summary: 'Release this checkout and stop the stack if no other holder remains',
        handler: 'sleep',
        visibility: 'public',
        ordinary: ordinary('sleep'),
        flags: configured,
    },
    {
        name: 'down',
        stage: 'run-the-stack',
        summary: 'Stop and remove the stack (on the active local Docker context)',
        handler: 'down',
        visibility: 'public',
        // down removes only the containers and networks cockpit created; reset, which deletes data, stays out.
        ordinary: ordinary('down'),
        flags: configured,
    },
    {
        name: 'reset',
        stage: 'run-the-stack',
        summary: 'Preview a reset, then approve it interactively or apply it as [autonomy] reset allows (on the active local Docker context)',
        handler: 'reset',
        visibility: 'public',
        // Reset deletes stack data, so an agent applies one only where [autonomy] reset = "agent".
        ordinary: ordinary('reset', { requires: 'autonomy-reset' }),
        flags: { config: configFlag, interactive: bool(), apply: bool(Object.freeze({ ...flag, required: true as const })), json: jsonFlag },
    },
    {
        name: 'doctor',
        stage: 'diagnose',
        summary: 'Report environment problems without changing anything',
        handler: 'doctor',
        visibility: 'public',
        ordinary: ordinary('doctor'),
        flags: configured,
    },
    // A gate runs only the stages a person declared in the reviewed cockpit.toml, which is the trust
    // `up` already has; a selector reaches a stage only through the arguments that stage declares.
    { name: 'test-run', handler: 'test-run', stage: 'test-and-grade', summary: 'Run a declared product test gate and report which tests it selected', visibility: 'public',
        ordinary: ordinary('test-run'),
        flags: { ...configured, gate: str(value('declared-gate', true)), mode: str(value('gate-mode'), 'canonical'), select: str(value('gate-selector')) } },
    // A gated step passes for the agent only where [work.gates] says agent; under person the command
    // waits for the digest a person types after --interactive, which no agent invocation carries.
    { name: 'work status', handler: 'work-status', stage: 'test-and-grade', summary: 'Report each work order, its state and how it closed', visibility: 'public',
        ordinary: ordinary('work-status'),
        flags: { ...configured, 'work-order': str(value('identifier')) } },
    { name: 'work accept', handler: 'work-accept', stage: 'test-and-grade', summary: 'Accept a work order, or a change to an accepted one, as [work.gates] allows', visibility: 'public',
        ordinary: ordinary('work-accept', personFlag),
        flags: { ...configured, 'work-order': workOrderFlag, interactive: bool() } },
    { name: 'work check', handler: 'work-check', stage: 'test-and-grade', summary: "Run every criterion's check and the order's gates", visibility: 'public',
        ordinary: ordinary('work-check'),
        flags: { ...configured, 'work-order': workOrderFlag } },
    { name: 'work note', handler: 'work-note', stage: 'test-and-grade', summary: 'Record a note on an order, or with --ask an open question that blocks it', visibility: 'public',
        ordinary: ordinary('work-note'),
        flags: { ...configured, 'work-order': workOrderFlag, text: str(value('label', true)), ask: bool(flag) } },
    { name: 'work answer', handler: 'work-answer', stage: 'test-and-grade', summary: 'Answer an open question on an order, as [work.gates] allows', visibility: 'public',
        ordinary: ordinary('work-answer', personFlag),
        flags: { ...configured, 'work-order': workOrderFlag, question: str(value('tail', true)), text: str(value('label', true)), interactive: bool() } },
    // Grading hands the order to an evaluator running apart from the agent that did the work, unless
    // [work] grading names checks or self.
    { name: 'work grade', handler: 'work-grade', stage: 'test-and-grade', summary: 'Grade an accepted order the way [work] grading says', visibility: 'public',
        ordinary: ordinary('work-grade'),
        flags: { ...configured, 'work-order': workOrderFlag, verdict: str(value('label')), note: str(value('label')), evaluator: str(value('evaluator-tool')) } },
    { name: 'work signoff', handler: 'work-signoff', stage: 'test-and-grade', summary: 'Close a graded order as done, or any open one as partial or abandoned', visibility: 'public',
        ordinary: ordinary('work-signoff', personFlag),
        flags: { ...configured, 'work-order': workOrderFlag, partial: bool(flag), abandon: bool(flag), note: str(value('label')), interactive: bool() } },
    // Inspection only reports the holder. --apply deletes the lock once a pid probe calls its holder
    // dead, and that probe sees only this machine's process table: a holder running in a container or
    // on another host that shares the checkout looks dead to it, so a person confirms it is gone.
    { name: 'work recover', handler: 'work-recover', stage: 'test-and-grade', summary: "Inspect or remove a crashed command's work-order lock", visibility: 'public',
        ordinary: ordinary('work-recover', { forbidden: Object.freeze({ presence: Object.freeze(['apply']) }) }),
        flags: { ...configured, 'work-order': workOrderFlag, apply: bool() } },
    { name: 'work verify', handler: 'work-verify', stage: 'test-and-grade', summary: 'Check every record against its order; in CI, pass the steps gated on ci', visibility: 'public',
        ordinary: ordinary('work-verify'),
        flags: configured },
    { name: 'grade', handler: 'grade-criteria', stage: 'test-and-grade', summary: 'Independently grade uncommitted work against a criteria file, with no work order', visibility: 'public',
        ordinary: ordinary('grade-criteria'),
        flags: { ...configured, criteria: str(value('confined-path', true)), evaluator: str(value('evaluator-tool')) } },
    // Driving signs in and captures the application, so it runs unprompted only on the data posture a
    // person wrote down as safe for that.
    { name: 'browser drive', handler: 'browser-drive', stage: 'test-and-grade', summary: 'Drive the declared application browser surfaces', visibility: 'public',
        ordinary: ordinary('browser-drive', browserAdmission),
        flags: { ...configured, role: str(value('identifier')) } },
    { name: 'browser screenshot', handler: 'browser-screenshot', stage: 'test-and-grade', summary: 'Capture the declared application surfaces', visibility: 'public',
        ordinary: ordinary('browser-screenshot', browserAdmission),
        flags: { ...configured, role: str(value('identifier')) } },
    // Reads documents and runs read-only Git, like check; it writes nothing, so an agent runs it freely.
    { name: 'docs check', handler: 'docs-check', stage: 'test-and-grade', summary: 'Report removed paths and make targets living docs still cite, and broken decision records', visibility: 'public',
        ordinary: ordinary('docs-check'),
        flags: configured },
] as const satisfies readonly CommandSource[]

export const commands: readonly CommandDefinition[] = sources.map(({ flags, ...command }): CommandDefinition => {
    const entries = Object.entries(flags as Readonly<Record<string, Flag>>)
    return { ...command,
        options: Object.fromEntries(entries.map(([name, { agent: _agent, ...option }]) => [name, option])),
        ordinary: command.ordinary.availability === 'available'
            ? { ...command.ordinary, options: Object.fromEntries(entries.flatMap(([name, { agent }]) => agent ? [[name, agent]] : [])) }
            : command.ordinary }
})

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
    /** What the configuration grants an agent: browser preapproval, and the [autonomy] decisions set to agent. */
    readonly grants: readonly OrdinaryGrant[]
}
export type OrdinaryGrant = 'browser-preapproval' | 'autonomy-sync' | 'autonomy-reset'
const ORDINARY_GRANTS: readonly OrdinaryGrant[] = ['browser-preapproval', 'autonomy-sync', 'autonomy-reset']

// An image reference or ID as Docker spells it; the command itself refuses one that is not local.
const LOCAL_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/
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
        || Object.keys(captured).sort().join(',') !== 'allowedRoots,canonicalRoot,configPath,executable,gates,grants,services') return undefined
    const source = captured as unknown as OrdinaryInvocationAuthority
    if (!canonicalPath(source.executable) || !canonicalPath(source.canonicalRoot) || !canonicalPath(source.configPath)
        || !Array.isArray(source.allowedRoots) || source.allowedRoots.length > GUARD_INPUT_LIMITS.paths
        || !source.allowedRoots.every(canonicalPath) || !source.allowedRoots.includes(source.canonicalRoot)
        || !Array.isArray(source.services) || !source.services.every(service => typeof service === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(service))
        || !Array.isArray(source.gates) || !source.gates.every(gate => typeof gate === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(gate))
        || !Array.isArray(source.grants) || !source.grants.every(grant => ORDINARY_GRANTS.includes(grant))
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
            : option.role === 'label' ? true
            : option.role === 'field' ? isRecordedAnswerField(text)
            : option.role === 'tail' ? /^[1-9]\d{0,4}$/.test(text) && Number(text) <= 10_000
            : option.role === 'since' ? text.length <= 64 && (/^\d+(?:\.\d+)?[smhd]$/.test(text)
                || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(text) && Number.isFinite(Date.parse(text)))
            : option.role === 'surface-target' ? text.split(',').every(tool => SURFACE_TARGETS.some(target => target === tool))
            : option.role === 'evaluator-tool' ? EVALUATOR_TOOLS.includes(text)
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
        // A dry run writes nothing, so no grant gates it.
        || grammar.requires !== undefined && !options.has('dry-run') && !source.grants.includes(grammar.requires)
        || typeof inspectPath !== 'function' || [...paths].some(path => !inspectPath(path))) return undefined
    return { executable: source.executable, cwd: source.canonicalRoot, argv: [...args],
        ...(reads.length ? { reads } : {}) }
}
