import { SURFACE_TARGETS } from './surfaces/contract.js'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { resolve } from 'node:path'
import { isSensitiveGuardName, WRAPPING_COMMANDS } from './guards/evaluator.js'
import { GUARD_HANDLER_ARGV } from './guards/harness-adapter.js'

export function isRecordedAnswerField(value: string): boolean {
    return value.length <= 256 && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)
}

export type WorkHandlerIdentifier =
    | 'work-status' | 'work-accept' | 'work-check' | 'work-note' | 'work-decide' | 'work-answer' | 'work-acknowledge' | 'work-grade' | 'work-signoff' | 'work-retry' | 'work-recover' | 'work-verify' | 'grade-criteria'
    | 'browser-drive' | 'browser-screenshot' | 'test-run'

export type HandlerIdentifier = WorkHandlerIdentifier
    | 'check'
    | 'docs-check'
    | 'env-keys'
    | 'env-schema'
    | 'doctor'
    | 'down'
    | 'exec'
    | 'init'
    | 'logs'
    | 'preflight'
    | 'ps'
    | 'rebuild'
    | 'reset'
    | 'restart'
    | 'setup'
    | 'sibling'
    | 'tool'
    | 'session'
    | 'sleep'
    | 'stacks'
    | 'sync'
    | 'up'
    | 'upgrade'
    | 'use'
    | 'pull'

type CommandStage = 'set-up' | 'generate-and-verify' | 'run-the-stack' | 'diagnose' | 'test-and-grade'

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
    { name: 'env', summary: 'Read what environment schemas declare with nothing resolved: variable names, or one schema\'s text' },
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
    agent?: AgentLimits
}

const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
    'accept-reset': 'Accept the displayed answer reset with its exact SHA-256 digest',
    abandon: 'Close the order as abandoned; --note says why',
    clear: 'Serve the sibling from its declared checkout again',
    answers: 'Path to the init answers file',
    ask: 'Record the note as an open question, which blocks the order until it is answered',
    apply: 'Apply the displayed reversible operation',
    command: 'With --scaffold-compose: the command that starts the app, as words separated by spaces',
    config: 'Path to cockpit.toml',
    create: 'Create a new local sibling repository',
    decision: 'With work note: record the text as a decision the order made, resolved with work decide before signoff. With work decide: number of the decision to resolve, as work status lists it',
    criteria: 'Path to a file whose YAML front-matter lists the criteria to grade',
    dir: 'Directory for the sibling checkout',
    evaluator: 'Grade with only this agent tool (codexcli, claudecode or opencode), with no fallback to another',
    'dry-run': 'Preview without writing or installing anything',
    follow: 'Continue collecting logs until cancelled',
    from: 'Path to an existing local repository',
    gate: 'Declared product gate to run',
    'instruction-pointer': 'Offer a marked AGENTS.md link for this separate sibling',
    interactive: 'Ask for explicit approval in a terminal',
    json: 'Emit one machine-readable JSON response',
    mode: 'Declared gate execution mode',
    mount: 'How the stack uses the sibling: always, none or profile:<name>',
    note: 'What was checked, or what was and was not done',
    path: 'The schema to print: <slug>:<relative directory>/.env.schema in a sibling, or .env.schema in the cockpit root, as env keys prints it',
    partial: 'Close the order as partly done; --note says what is left',
    port: 'With --scaffold-compose: the port the app listens on inside its container',
    profile: 'Compose profile to activate beside environment.profiles; repeat it for several',
    purpose: 'Short purpose of the sibling repository',
    question: 'Number of the open question to answer, as work status lists it',
    reason: 'With --none: why the decision is not a lasting one',
    record: 'Write a new decision record under [docs] decisions for the decision',
    'record-file': 'An existing decision record under [docs] decisions that cites the order',
    supersedes: 'With --record: the number of the decision record the new one supersedes, which is marked superseded',
    none: 'Resolve the decision as not lasting; --reason says why',
    'reset-answer': 'Preview clearing one recorded init answer field',
    remote: 'Repository remote URL recorded for the sibling',
    'replace-from': 'With env schema: replace that schema with this draft file, or create it, instead of printing it',
    role: 'Declared browser role',
    'from-subagent': 'Under [work] grading = "subagent": states that --verdict and --note came from the evaluator subagent you spawned; cockpit cannot verify it',
    'fail-on-findings': 'Exit 2 when a route has console errors, uncaught errors or failed requests, for a criterion that wants a clean route',
    route: 'Declared browser route to visit, by name or path; every declared route when omitted',
    'scaffold-compose': 'Write a starting compose.yml for the app in this directory, relative to the root, once; it refuses when a Compose file exists',
    select: 'Optional subset of the gate to run',
    service: 'Declared Compose service the command acts on',
    since: 'Collect logs no older than this duration',
    tail: 'Maximum number of log records to collect',
    target: 'Agent tool to set up; comma-separate several (claudecode,opencode)',
    text: 'Text of the note or answer',
    var: 'Environment variable mapping for the sibling',
    verdict: 'Under [work] grading = "self" or "subagent": met or unmet',
    with: 'With --scaffold-compose: backing services to add, from postgres and redis, separated by commas',
    'work-order': 'Work-order identifier',
    'write-instruction-pointers': 'Write the reviewed instruction links into opted-in sibling guides',
    'write-instruction-files': 'Write the reviewed AGENTS.md and CLAUDE.md changes that let every agent tool load a sibling\'s instructions',
})

export function describePublicOption(name: string): string {
    const description = FLAG_DESCRIPTIONS[name]
    if (!description) throw new Error(`Public option --${name} has no help description.`)
    return description
}

/**
 * What keeps an agent from running a command unprompted: it changes what agents may do, or it waits for
 * a person. The guard asks a person for such a spelling; it treats every other cockpit command as an
 * ordinary program, judged by the words it spells.
 */
type AgentLimits = Readonly<{
    /** Why the command is never an agent's. */
    person?: string
    /** The only subcommand words an agent may run; another is a person's. */
    operations?: readonly string[]
    /** Flags only a person passes. */
    personFlags?: readonly string[]
    /** The positional, by index, that names a directory an agent may name only inside the allowed roots. */
    confined?: number
    // Admitted only where cockpit.toml grants it: browser preapproval, on by default for and allowed
    // only on isolated data that cannot reach production, or the fixed rule: reset only where a seed is
    // declared. A dry run writes nothing, so no grant gates it.
    requires?: OrdinaryGrant
    // These flags, which the command otherwise lets an agent run, are admitted where cockpit.toml grants it.
    flagGrant?: Readonly<{ flags: readonly string[]; grant: OrdinaryGrant }>
}>

/** One row per CLI flag: how the parser reads it. */
type Flag = Readonly<{ type: 'string' | 'boolean'; default?: string | boolean; multiple?: true }>
const str = (fallback?: string): Flag => ({ type: 'string', ...fallback === undefined ? {} : { default: fallback } })
const bool = (): Flag => ({ type: 'boolean', default: false })
const configFlag = str()
const jsonFlag = bool()
const configured = { config: configFlag, json: jsonFlag } as const
const workOrderFlag = str()
const profileFlag: Flag = { type: 'string', multiple: true }
const serviceFlag = str()

// `<slug>:` and plain directories, ending in exactly this name: no `.` or `..` segment can climb out.
const SCHEMA_REFERENCE = /^(?:[a-z0-9][a-z0-9-]{0,63}:)?(?:(?!\.\.?\/)[A-Za-z0-9._@+-]+\/)*\.env\.schema$/

/**
 * The `.env.schema` file an `env schema --path` names, given as the file or as its directory (`.` for
 * the cockpit root, `<slug>:` for a sibling's): an agent's secret guard that refuses any word
 * containing `.env` refused the file spelling, and with it the documented route for writing a schema.
 * The file name is fixed, so a directory is unambiguous; one whose own name reads as a secret is not.
 */
export function schemaFileReference(text: string): string | undefined {
    const slug = /^[a-z0-9][a-z0-9-]{0,63}:/.exec(text)?.[0] ?? ''
    const path = text.slice(slug.length)
    const directory = SCHEMA_REFERENCE.test(text) ? path.split('/').slice(0, -1).join('/') : path
    if (directory.split('/').some(isSensitiveGuardName)) return undefined
    const file = `${slug}${directory === '' || directory === '.' ? '' : `${directory}/`}.env.schema`
    return SCHEMA_REFERENCE.test(file) ? file : undefined
}

const browserAdmission: AgentLimits = Object.freeze({ requires: 'browser-preapproval' })
// --interactive asks for a person at a terminal, so an agent invocation never carries it.
const personFlag: AgentLimits = Object.freeze({ personFlags: Object.freeze(['interactive']) })


export function isWorkHandler(value: HandlerIdentifier): value is WorkHandlerIdentifier {
    return value.startsWith('work-') || value.startsWith('browser-') || value === 'test-run' || value === 'grade-criteria'
}

type CommandSource = Omit<CommandDefinition, 'options'> & { flags: Readonly<Record<string, Flag>> }

const sources = [
    {
        name: 'init',
        stage: 'set-up',
        summary: 'Preview a first cockpit setup for one or more agent tools, then write it from answers',
        usage: '[<root>] [options]',
        handler: 'init',
        visibility: 'public',
        agent: { personFlags: ['interactive', 'answers', 'scaffold-compose', 'command', 'port', 'with'] },
        flags: { target: str(),
            interactive: bool(), json: jsonFlag,
            answers: str(),
            'reset-answer': str(), 'accept-reset': str(),
            'scaffold-compose': str(), command: str(), port: str(), with: str() },
    },
    {
        name: 'setup',
        stage: 'set-up',
        summary: 'Clone or locate the declared sibling repositories and link them',
        handler: 'setup',
        visibility: 'public',
        flags: { config: configFlag, 'write-instruction-pointers': bool(), 'write-instruction-files': bool(), json: jsonFlag },
    },
    {
        name: 'use',
        stage: 'set-up',
        summary: 'Serve a sibling from another of its checkouts, such as a worktree',
        usage: '<slug> <checkout> | <slug> --clear [options]',
        handler: 'use',
        visibility: 'public',
        // The checkout must already lie inside a directory the guard lets the agent write, so an agent
        // can point the stack at its own worktree but never widen its reach to a new directory.
        agent: { confined: 1 },
        flags: { config: configFlag, clear: bool(), json: jsonFlag },
    },
    {
        name: 'pull',
        stage: 'set-up',
        summary: 'Fast-forward the cockpit and its siblings to their upstreams',
        handler: 'pull',
        visibility: 'public',
        flags: configured,
    },
    {
        name: 'sibling',
        stage: 'set-up',
        summary: 'Add or remove a repository in cockpit.toml (sibling add, sibling remove)',
        usage: 'add|remove <slug> [options]',
        handler: 'sibling',
        visibility: 'public',
        agent: { person: 'sibling add and remove rewrite cockpit.toml' },
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
        // tool add edits only [surfaces] tools, and an added tool never widens what agents may do, so the
        // agent syncs it. tool remove deletes that tool's guard, so it is a person's.
        agent: { operations: ['add'] },
        flags: { config: configFlag, 'dry-run': bool(), json: jsonFlag },
    },
    {
        name: 'upgrade',
        stage: 'set-up',
        summary: 'Move the exact cockpit pin to a newer version and re-run sync',
        usage: '[<version>] [options]',
        handler: 'upgrade',
        visibility: 'public',
        // The install is exact and its sync child decides as sync does, so an agent runs the real upgrade
        // as it runs sync.
        flags: { config: configFlag, 'dry-run': bool(), json: jsonFlag },
    },
    {
        name: 'sync',
        stage: 'generate-and-verify',
        summary: 'Write the Compose ownership override and agent files from cockpit.toml',
        handler: 'sync',
        visibility: 'public',
        // A real sync applies an edit that widens what agents may do only once a person confirms it with
        // --interactive, so an agent's sync applies everything else.
        agent: { personFlags: ['interactive'] },
        flags: { config: configFlag, 'dry-run': bool(), interactive: bool(), json: jsonFlag },
    },
    {
        name: 'check',
        stage: 'generate-and-verify',
        summary: 'Report generated files that no longer match cockpit.toml',
        handler: 'check',
        visibility: 'public',
        flags: configured,
    },
    {
        name: 'up',
        stage: 'run-the-stack',
        summary: 'Start or resume the declared environment',
        handler: 'up',
        visibility: 'public',
        flags: { ...configured, profile: profileFlag },
    },
    {
        name: 'preflight',
        stage: 'run-the-stack',
        summary: 'Check that the environment is healthy and ready for work',
        handler: 'preflight',
        visibility: 'public',
        flags: configured,
    },
    {
        name: 'session',
        stage: 'run-the-stack',
        summary: 'Keep the environment available for one command, then release it',
        usage: '[options] -- <command> [args...]',
        handler: 'session',
        visibility: 'public',
        // The guard judges the command after `--` as one more invocation.
        flags: { config: str(), profile: { type: 'string', multiple: true } },
    },
    {
        name: 'logs',
        stage: 'run-the-stack',
        summary: 'Show recent logs for one declared service',
        handler: 'logs',
        visibility: 'public',
        flags: { config: configFlag, service: serviceFlag, tail: str('100'), since: str('15m'),
            follow: bool(), json: jsonFlag },
    },
    {
        name: 'ps',
        stage: 'run-the-stack',
        summary: 'Show the state and health of each service in this checkout\'s stack',
        handler: 'ps',
        visibility: 'public',
        flags: configured,
    },
    // The service verbs act only on this checkout's own leased stack, as up does, so an agent runs
    // them as it runs up; reset, which deletes data, stays gated.
    {
        name: 'restart',
        stage: 'run-the-stack',
        summary: 'Restart one service of this checkout\'s stack and wait until it is healthy',
        handler: 'restart',
        visibility: 'public',
        flags: { ...configured, service: serviceFlag },
    },
    {
        name: 'rebuild',
        stage: 'run-the-stack',
        summary: 'Rebuild one service\'s image, replace its container and wait until it is healthy',
        handler: 'rebuild',
        visibility: 'public',
        flags: { ...configured, service: serviceFlag },
    },
    {
        name: 'exec',
        stage: 'run-the-stack',
        summary: 'Run a command inside one service\'s container of this checkout\'s stack',
        usage: '--service <name> [options] -- <command> [args...]',
        handler: 'exec',
        visibility: 'public',
        // The guard judges the container command as one more invocation.
        flags: { config: configFlag, service: serviceFlag },
    },
    {
        name: 'sleep',
        stage: 'run-the-stack',
        summary: 'Release this checkout and stop the stack if no other holder remains',
        handler: 'sleep',
        visibility: 'public',
        flags: configured,
    },
    {
        name: 'down',
        stage: 'run-the-stack',
        summary: 'Stop and remove the stack (on the active local Docker context)',
        handler: 'down',
        visibility: 'public',
        flags: configured,
    },
    {
        name: 'reset',
        stage: 'run-the-stack',
        summary: 'Preview a reset, then approve it interactively, or apply it where a seed is declared (on the active local Docker context)',
        handler: 'reset',
        visibility: 'public',
        // Reset deletes stack data, so an agent applies one only where a declared seed refills it.
        agent: { personFlags: ['interactive'], requires: 'seeded-reset' },
        flags: { config: configFlag, interactive: bool(), apply: bool(), json: jsonFlag },
    },
    {
        name: 'stacks',
        stage: 'run-the-stack',
        summary: 'List every stack on this machine, or preview and remove those whose checkout is gone (stacks prune)',
        usage: '[prune] [options]',
        handler: 'stacks',
        visibility: 'public',
        // --apply removes only stacks whose checkout is gone; the command itself refuses one that
        // deletes volumes unless an agent may reset.
        agent: personFlag,
        flags: { config: configFlag, apply: bool(), interactive: bool(), json: jsonFlag },
    },
    {
        name: 'doctor',
        stage: 'diagnose',
        summary: 'Report environment problems without changing anything',
        handler: 'doctor',
        visibility: 'public',
        flags: configured,
    },
    // Reads four documentation file names statically and runs read-only Git, so an agent gets the names
    // a native read rule refuses without resolving anything.
    { name: 'env keys', handler: 'env-keys', stage: 'diagnose', summary: 'List the variable names env schemas and templates declare, with no value and nothing resolved', visibility: 'public',
        flags: configured },
    // Verbatim on purpose: the guard treats this one name as documentation and Git already reaches a
    // committed copy. The role admits nothing but that exact name; the command proves the directory.
    // Replacing it is unprompted because an uncommitted schema is never run. What must not happen is a
    // secret laundered through a draft and printed back, so a draft is a read the guard proves, and it
    // is admitted only as the whole call.
    { name: 'env schema', handler: 'env-schema', stage: 'diagnose', summary: 'Print one .env.schema a sibling or the cockpit root holds, verbatim and with nothing resolved, or replace it from a draft', visibility: 'public',
        flags: { ...configured, path: str(), 'replace-from': str() } },
    // A gate runs only the stages a person declared in the reviewed cockpit.toml, which is the trust
    // `up` already has; a selector reaches a stage only through the arguments that stage declares.
    { name: 'test-run', handler: 'test-run', stage: 'test-and-grade', summary: 'Run a declared product test gate and report which tests it selected', visibility: 'public',
        flags: { ...configured, gate: str(), mode: str('canonical'), select: str() } },
    // A step that would let the agent lower the bar its own work is held to waits for the digest a
    // person types after --interactive, which no agent invocation carries.
    { name: 'work status', handler: 'work-status', stage: 'test-and-grade', summary: 'Report each work order, its state and how it closed', visibility: 'public',
        flags: { ...configured, 'work-order': str() } },
    { name: 'work accept', handler: 'work-accept', stage: 'test-and-grade', summary: 'Accept a work order, or a change to an accepted one', visibility: 'public',
        agent: personFlag,
        flags: { ...configured, 'work-order': workOrderFlag, interactive: bool() } },
    { name: 'work check', handler: 'work-check', stage: 'test-and-grade', summary: "Run every criterion's check and the order's gates", visibility: 'public',
        flags: { ...configured, 'work-order': workOrderFlag } },
    { name: 'work note', handler: 'work-note', stage: 'test-and-grade', summary: 'Record a note on an order, an open question with --ask, or a decision with --decision', visibility: 'public',
        flags: { ...configured, 'work-order': workOrderFlag, text: str(), ask: bool(), decision: bool() } },
    // Resolving a decision passes no gate of its own: a --none resolution is shown in the signoff prompt, which the signoff gate covers.
    { name: 'work decide', handler: 'work-decide', stage: 'test-and-grade', summary: 'Resolve a recorded decision: write or cite its decision record, or say it is not lasting', visibility: 'public',
        flags: { ...configured, 'work-order': workOrderFlag, decision: str(), record: bool(), 'record-file': str(),
            supersedes: str(), none: bool(), reason: str() } },
    { name: 'work answer', handler: 'work-answer', stage: 'test-and-grade', summary: 'Answer an open question on an order', visibility: 'public',
        flags: { ...configured, 'work-order': workOrderFlag, question: str(), text: str() } },
    { name: 'work acknowledge', handler: 'work-acknowledge', stage: 'test-and-grade', summary: 'Acknowledge that an order weakened tests', visibility: 'public',
        agent: personFlag,
        flags: { ...configured, 'work-order': workOrderFlag, note: str(), interactive: bool() } },
    // Grading hands the order to an evaluator running apart from the agent that did the work, unless
    // [work] grading names checks or self, or the agent submits its subagent's verdict under subagent.
    { name: 'work grade', handler: 'work-grade', stage: 'test-and-grade', summary: 'Grade an accepted order the way [work] grading says', visibility: 'public',
        flags: { ...configured, 'work-order': workOrderFlag, verdict: str(), note: str(), 'from-subagent': bool(), evaluator: str() } },
    { name: 'work signoff', handler: 'work-signoff', stage: 'test-and-grade', summary: 'Close a graded order as done, or any open one as partial or abandoned', visibility: 'public',
        agent: personFlag,
        flags: { ...configured, 'work-order': workOrderFlag, partial: bool(), abandon: bool(), note: str(), interactive: bool() } },
    // The attempt cap stops an agent retrying its own failed work, so fresh attempts at an unchanged contract are always a person's.
    { name: 'work retry', handler: 'work-retry', stage: 'test-and-grade', summary: 'Grant an order at its attempt cap fresh attempts, as a person at a terminal', visibility: 'public',
        agent: personFlag,
        flags: { ...configured, 'work-order': workOrderFlag, note: str(), interactive: bool() } },
    // Inspection only reports the holder. --apply removes the lock only once the command has shown its
    // holder gone where a pid probe cannot see: the lock's host and the containers cockpit labels.
    { name: 'work recover', handler: 'work-recover', stage: 'test-and-grade', summary: "Inspect or remove a crashed command's work-order lock", visibility: 'public',
        flags: { ...configured, 'work-order': workOrderFlag, apply: bool() } },
    { name: 'work verify', handler: 'work-verify', stage: 'test-and-grade', summary: 'Check every record against its order', visibility: 'public',
        flags: configured },
    { name: 'grade', handler: 'grade-criteria', stage: 'test-and-grade', summary: 'Independently grade uncommitted work against a criteria file, with no work order', visibility: 'public',
        flags: { ...configured, criteria: str(), evaluator: str() } },
    // Driving signs in and captures the application, so it runs unprompted only on the data posture a
    // person wrote down as safe for that.
    { name: 'browser drive', handler: 'browser-drive', stage: 'test-and-grade', summary: 'Drive the declared application browser surfaces', visibility: 'public',
        agent: browserAdmission,
        // Findings are evidence by default; this makes them fail the command, for a criterion that wants a clean route.
        flags: { ...configured, role: str(), route: str(), 'fail-on-findings': bool() } },
    { name: 'browser screenshot', handler: 'browser-screenshot', stage: 'test-and-grade', summary: 'Capture the declared application surfaces', visibility: 'public',
        agent: browserAdmission,
        flags: { ...configured, role: str(), route: str() } },
    // Reads documents and runs read-only Git, like check; it writes nothing, so an agent runs it freely.
    { name: 'docs check', handler: 'docs-check', stage: 'test-and-grade', summary: 'Report removed paths and make targets living docs still cite, and broken decision records', visibility: 'public',
        flags: configured },
] as const satisfies readonly CommandSource[]

export const commands: readonly CommandDefinition[] = sources.map(({ flags, ...command }): CommandDefinition => ({ ...command, options: flags }))

interface InternalCommandDefinition {
    readonly name: 'guard-evaluate'
    readonly handler: 'guard-evaluate'
    readonly visibility: 'internal'
    readonly agent: AgentLimits
    readonly argv: typeof GUARD_HANDLER_ARGV
    readonly options: Readonly<{ harness: { readonly type: 'string' } }>
}
export const internalCommands: readonly InternalCommandDefinition[] = Object.freeze([Object.freeze({
    name: 'guard-evaluate', handler: 'guard-evaluate', visibility: 'internal',
    agent: Object.freeze({ person: 'the guard hook calls this internally; it is not a user command' }),
    argv: GUARD_HANDLER_ARGV, options: Object.freeze({ harness: Object.freeze({ type: 'string' }) }),
})])

export type OrdinaryGrant = 'browser-preapproval' | 'seeded-reset'

/**
 * Whether an agent may run the cockpit command `args` spell (the words after the launcher) in `cwd`
 * without a person. `grants` is what cockpit.toml grants an agent; `profiles` the Compose profiles an
 * agent may name with --profile, since any other starts services no person declared for it; `roots`
 * the allowed roots. A spelling the table does not know is an ordinary program, which the CLI refuses itself.
 */
export function agentMayRun(args: readonly string[], authority: Readonly<{ grants: readonly OrdinaryGrant[]; profiles: readonly string[];
    roots: readonly string[]; cwd: string }>): boolean {
    const spelling = commandSpelling(args)
    const definition = [...commands, ...internalCommands].find(row => row.name === spelling.name)
    if (!definition) return true
    // Only cockpit's own words count: what a session or exec runs after `--` is judged as its own invocation.
    // The CLI runs every positional of one as the command, so one before `--` would run unjudged.
    const separator = spelling.rest.indexOf('--')
    const own = separator < 0 ? spelling.rest : spelling.rest.slice(0, separator)
    const { values, positionals } = parseArgs({ args: [...own], options: definition.options, strict: false, allowPositionals: true })
    const limits = definition.agent ?? {}
    const profiles = values.profile === undefined ? [] : [values.profile].flat()
    const confined = limits.confined === undefined ? undefined : positionals[limits.confined]
    return limits.person === undefined
        && (!WRAPPING_COMMANDS.has(definition.name) || separator >= 0 && positionals.length === 0)
        && (limits.operations === undefined || limits.operations.includes(String(positionals[0])))
        && !(limits.personFlags ?? []).some(name => values[name] !== undefined && values[name] !== false)
        && (limits.requires === undefined || values['dry-run'] === true || authority.grants.includes(limits.requires))
        && (limits.flagGrant === undefined || !limits.flagGrant.flags.some(name => values[name] !== undefined && values[name] !== false)
            || authority.grants.includes(limits.flagGrant.grant))
        && (!('profile' in definition.options) || profiles.every(profile => typeof profile === 'string' && authority.profiles.includes(profile)))
        && (confined === undefined || !confined.split('/').includes('..')
            && authority.roots.some(root => resolve(authority.cwd, confined) === root || resolve(authority.cwd, confined).startsWith(`${root}/`)))
}
