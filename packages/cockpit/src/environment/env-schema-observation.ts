// Owns: observing the env-schema status of every schema a cockpit holds: each one a sibling tracks,
// a sibling's untracked root schema, and the cockpit root's own. Must not: read, keep or print a
// resolved value, read inside a central resolver directory, decide the health verdict
// (observations.ts), or spawn a process itself (environment-exec/execute.ts runs the step).
// Varlock is optional, so a directory without `.env.schema` is not observed at all and an absent
// binary is advisory. Loading a schema runs its resolvers, including `exec()`, so only a schema Git
// shows as committed and unchanged is loaded: a schema is exempt from the secret-file denial, and an
// agent could otherwise edit one and have `doctor` run it. Handed off to: health-composition.ts
// (producer) and application/health.ts (rows, diagnostics).
//
// `varlock load --agent` still prints partial values, and its error messages can quote a value, so
// the report is reduced to key names, the sensitive flag and a validity category the moment it is
// parsed. Nothing else leaves this module.
import { lstat, stat } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'

import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    isMissing,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    snapshotEnvironmentObservation,
    snapshotExecutionStep,
    type EnvironmentObservation,
    type ExecutionStep,
    type JsonSnapshot,
    type StackId,
} from './contract.js'
import { cockpitCommand, formatShellCommand } from '../fix-catalogue.js'
import { resolveExecutable, type ResolvedExecutable } from './executable.js'
import { inspectSchemaCommit, listTrackedEnvSchemas, mainCheckoutDirectory, type SchemaCommitState, type TrackedEnvSchemas } from './git-observation.js'

const OWNER = 'env-schema-observation'

const ENV_SCHEMA_FILE = '.env.schema'
export const VARLOCK_INSTALL_URL = 'https://varlock.dev'

export const observationDeclarations = Object.freeze([
    { id: 'env-schema', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.ENV_SCHEMA_UNHEALTHY, isIssued: isEnvSchemaObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== OWNER) throw new RefusalError('env-schema observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

function isEnvSchemaObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

export interface EnvSchemaSibling {
    readonly slug: string
    readonly root: string
}

const STDOUT_LIMIT_BYTES = 262_144
const STDERR_LIMIT_BYTES = 16_384
const KEY_LIMIT = 4_096
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const REASON_BUDGET_BYTES = 900
// Well above the components one repository holds; past it the row says so instead of probing them all.
const SCHEMA_LIMIT_PER_SIBLING = 64
export const ENV_SCHEMA_OVERRIDE_NAME_LIMIT = 32
// The one message that proves a key is empty. Provider messages cannot be enumerated and any of them
// may say "required", so everything else only proves the key could not be validated or resolved.
const REQUIRED_EMPTY_MESSAGE = 'Value is required but is currently empty'
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\ufffd]/

type KeyProblem = 'missing-required' | 'could-not-validate-or-resolve'
interface KeyFailure { readonly key: string; readonly problem: KeyProblem }

type SchemaStatus =
    | { readonly state: 'valid'; readonly keys: number; readonly overrides: readonly string[] }
    | { readonly state: 'tool-missing' }
    | { readonly state: 'not-run'; readonly load: string }
    | { readonly state: 'invalid'; readonly failures: readonly KeyFailure[]; readonly schemaError: boolean }
    | { readonly state: 'unavailable'; readonly cause: string }

type Report =
    | { readonly kind: 'report'; readonly keys: number; readonly failures: readonly KeyFailure[]; readonly schemaError: boolean; readonly overrides: readonly string[] }
    | { readonly kind: 'malformed' }

/** One directory a schema is loaded from, named for the operator. */
export interface SchemaRoot {
    readonly owner: string
    /** Relative to the owner's root; empty for the root itself. */
    readonly relative: string
    readonly root: string
    /** Path segments of its central resolver directory below the cockpit root. */
    readonly central: readonly string[]
}

export function entryName(schema: Pick<SchemaRoot, 'owner' | 'relative'>): string {
    return schema.relative === '' ? schema.owner : `${schema.owner} (${schema.relative})`
}

export function reasonName(schema: Pick<SchemaRoot, 'owner' | 'relative'>): string {
    return `${schema.owner} (${schema.relative === '' ? '.' : schema.relative})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Reads the key names and error categories out of a `--format json-full` report and drops
// everything else, including every `value` and every error message (a message may quote a value).
function reduceReport(stdout: Buffer): Report {
    let parsed: unknown
    try {
        parsed = JSON.parse(stdout.toString('utf8'))
    } catch { // Parser text would quote varlock output, which can hold environment values.
        return { kind: 'malformed' }
    }
    if (!isRecord(parsed) || !isRecord(parsed.config)) return { kind: 'malformed' }
    const names = Object.keys(parsed.config)
    if (names.length > KEY_LIMIT) return { kind: 'malformed' }
    const failures: KeyFailure[] = []
    let schemaError = false
    const errors = parsed.errors
    if (errors !== undefined) {
        const items = isRecord(errors) ? errors.configItems : undefined
        if (isRecord(items)) {
            for (const [key, message] of Object.entries(items)) {
                if (!KEY_NAME.test(key) || typeof message !== 'string') return { kind: 'malformed' }
                failures.push({ key, problem: message === REQUIRED_EMPTY_MESSAGE ? 'missing-required' : 'could-not-validate-or-resolve' })
            }
        }
        if (failures.length === 0 || isRecord(errors) && errors.root !== undefined) schemaError = true
    }
    const overrides = parsed.overrideKeys ?? []
    if (!Array.isArray(overrides) || overrides.length > KEY_LIMIT
        || overrides.some((key) => typeof key !== 'string' || !KEY_NAME.test(key))) return { kind: 'malformed' }
    return { kind: 'report', keys: names.length, failures: failures.sort((a, b) => a.key < b.key ? -1 : 1), schemaError,
        overrides: (overrides as string[]).sort().slice(0, ENV_SCHEMA_OVERRIDE_NAME_LIMIT) }
}

async function hasEnvSchema(root: string): Promise<{ adopted: boolean; unreadable?: string }> {
    try {
        return { adopted: (await stat(join(root, ENV_SCHEMA_FILE))).isFile() }
    } catch (error) {
        if (isMissing(error)) return { adopted: false }
        return { adopted: true, unreadable: `${ENV_SCHEMA_FILE} could not be inspected (${errorCause(error)})` }
    }
}

// Metadata only: whether the central directory exists decides the second `--path`, and nothing
// below it is opened. A symbolic link anywhere on the way could lead the probe to resolver files
// outside the store the guards protect, so it is refused rather than followed.
async function centralDirectory(cockpitRoot: string, segments: readonly string[]): Promise<{ path?: string; cause?: string }> {
    let cursor = cockpitRoot
    for (const segment of segments) {
        cursor = join(cursor, segment)
        try {
            const status = await lstat(cursor)
            if (status.isSymbolicLink()) return { cause: `central resolver path ${cursor} is a symbolic link; replace it with a directory` }
            if (!status.isDirectory()) return { cause: `central resolver path ${cursor} is not a directory` }
        } catch (error) {
            if (isMissing(error)) return {}
            return { cause: `central resolver path ${cursor} could not be inspected (${errorCause(error)})` }
        }
    }
    return { path: cursor }
}

function createStep(input: {
    readonly executable: ResolvedExecutable
    readonly schema: SchemaRoot
    readonly central: string | undefined
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
}): ExecutionStep | undefined {
    const { executable, schema, central } = input
    return snapshotExecutionStep({
        id: `env-schema:${entryName(schema)}`,
        // The later path wins, as it does in the load the docs tell a person to run.
        argv: [executable.canonicalPath, 'load', '--agent', '--format', 'json-full', '--path', schema.root, ...central === undefined ? [] : ['--path', central]],
        argv0: executable.invocationPath,
        cwd: schema.root,
        env: { ...input.env, VARLOCK_TELEMETRY_DISABLED: 'true' },
        timeoutMs: input.timeoutMs,
        stdoutLimitBytes: STDOUT_LIMIT_BYTES,
        stderrLimitBytes: STDERR_LIMIT_BYTES,
        paths: [],
        ports: [],
        labels: { producer: 'env-schema', stackId: input.stackId, sibling: entryName(schema) },
        expected: [{ kind: 'path', target: schema.root, state: 'directory' }],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks: [],
        compensation: [],
    })
}

function describeFailure(outcome: Extract<ExecuteProbeOutcome, { kind: 'refusal' }>, timeoutMs: number): string {
    switch (outcome.code) {
        case ENVIRONMENT_CODES.EXECUTION_TIMEOUT:
            return `varlock timed out after ${timeoutMs} ms (a secret provider may be prompting or unreachable)`
        case ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT:
            return `varlock output exceeded ${STDOUT_LIMIT_BYTES} bytes`
        case ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED:
            return 'varlock could not be started'
        default:
            return `varlock failed (${outcome.code}, exit status ${outcome.execution.exitCode}) without a readable report`
    }
}

type Execute = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
type ProbeInput = { readonly cockpitRoot: string; readonly mainCheckout?: string; readonly env: Readonly<Record<string, string>>; readonly git: ResolvedExecutable; readonly timeoutMs: number; readonly stackId: StackId }

// What a person runs after reading the schema, with the same paths and precedence as the probe.
function manualLoad(schema: SchemaRoot, central: string | undefined): string {
    return `VARLOCK_TELEMETRY_DISABLED=true ${formatShellCommand(['varlock', 'load', '--path', schema.root, ...central === undefined ? [] : ['--path', central]])}`
}

async function schemaCommit(schema: SchemaRoot, input: ProbeInput, execute: Execute): Promise<SchemaCommitState> {
    const path = join(schema.root, ENV_SCHEMA_FILE)
    try {
        // Git compares a link's own text, so the file Varlock would load behind it has passed no commit.
        if ((await lstat(path)).isSymbolicLink()) return { kind: 'uncommitted' }
        return await inspectSchemaCommit({ executable: input.git, label: entryName(schema), directory: schema.root, file: ENV_SCHEMA_FILE, timeoutMs: input.timeoutMs }, execute)
    } catch (error) {
        return { kind: 'unavailable', reason: `whether ${ENV_SCHEMA_FILE} is committed could not be established: ${errorCause(error)}` }
    }
}

async function checkSchema(schema: SchemaRoot, executable: ResolvedExecutable | undefined, input: ProbeInput, execute: Execute): Promise<SchemaStatus> {
    if (!executable) return { state: 'tool-missing' }
    const own = await centralDirectory(input.cockpitRoot, schema.central)
    // The store is gitignored, so a linked worktree starts without one and every provider-backed key
    // would read as missing; its resolvers are the main checkout's unless it keeps its own.
    const central = own.cause === undefined && own.path === undefined && input.mainCheckout !== undefined
        ? await centralDirectory(input.mainCheckout, schema.central) : own
    if (central.cause !== undefined) return { state: 'unavailable', cause: central.cause }
    const commit = await schemaCommit(schema, input, execute)
    if (commit.kind === 'unavailable') return { state: 'unavailable', cause: commit.reason }
    if (commit.kind !== 'committed') return { state: 'not-run', load: manualLoad(schema, central.path) }
    const step = createStep({ executable, schema, central: central.path, env: input.env, timeoutMs: input.timeoutMs, stackId: input.stackId })
    if (!step) return { state: 'unavailable', cause: 'varlock invocation could not be planned' }
    let raw: ExecuteProbeOutcome
    try {
        raw = await execute(step)
    } catch (error) {
        return { state: 'unavailable', cause: `varlock execution is unavailable: ${errorCause(error)}` }
    }
    const outcome = authenticatedExecutionOutcome(raw, step)
    if (!outcome) return { state: 'unavailable', cause: 'varlock execution evidence is unauthenticated' }
    // Varlock exits nonzero when validation fails but still prints the report, so a refusal
    // for a plain nonzero exit is still decoded.
    const exitedNonzero = outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED
        && outcome.execution.signal === null
    if (outcome.kind === 'refusal' && !exitedNonzero) return { state: 'unavailable', cause: describeFailure(outcome, input.timeoutMs) }
    const report = reduceReport(outcome.stdout)
    if (report.kind === 'malformed') {
        return {
            state: 'unavailable',
            cause: outcome.kind === 'refusal'
                ? describeFailure(outcome, input.timeoutMs)
                : 'varlock produced a report in an unrecognised shape',
        }
    }
    if (report.schemaError || report.failures.some(({ problem }) => problem === 'missing-required')) {
        return { state: 'invalid', failures: report.failures, schemaError: report.schemaError }
    }
    // A locked provider cannot resolve any key behind it, which says nothing about the schema.
    if (report.failures.length > 0) return { state: 'unavailable', cause: unresolvedSummary(report.failures) }
    return outcome.kind === 'refusal'
        ? { state: 'unavailable', cause: describeFailure(outcome, input.timeoutMs) }
        : { state: 'valid', keys: report.keys, overrides: report.overrides }
}

function bounded(text: string): string {
    if (Buffer.byteLength(text) <= REASON_BUDGET_BYTES) return text
    return `${Buffer.from(text).subarray(0, REASON_BUDGET_BYTES).toString('utf8').replace(/\uFFFD$/, '')}...`
}

function unresolvedSummary(failures: readonly KeyFailure[]): string {
    return `could not validate or resolve ${failures.filter(({ problem }) => problem === 'could-not-validate-or-resolve').map(({ key }) => key).join(', ')}`
}

function invalidSummary(status: Extract<SchemaStatus, { state: 'invalid' }>): string {
    const missing = status.failures.filter(({ problem }) => problem === 'missing-required').map(({ key }) => key)
    return [
        ...(missing.length > 0 ? [`missing required ${missing.join(', ')}`] : []),
        ...(status.failures.length > missing.length ? [unresolvedSummary(status.failures)] : []),
        ...(status.schemaError ? ['schema could not be loaded'] : []),
    ].join('; ')
}

// Tracked schemas are the declaration of which components use Varlock, so no configuration has to
// repeat them. A root schema counts tracked or not, and a directory that is not a repository has
// only its root to offer.
async function discoverSchemaDirectories(
    sibling: EnvSchemaSibling,
    git: ResolvedExecutable,
    timeoutMs: number,
    execute: Execute,
): Promise<{ readonly relative: readonly string[]; readonly cause?: string }> {
    try {
        if (!(await stat(sibling.root)).isDirectory()) return { relative: [] }
    } catch (error) {
        if (isMissing(error)) return { relative: [] }
        return { relative: [], cause: `the checkout could not be inspected (${errorCause(error)})` }
    }
    let listed: TrackedEnvSchemas
    try {
        listed = await listTrackedEnvSchemas({ executable: git, slug: sibling.slug, root: sibling.root, timeoutMs }, execute)
    } catch (error) {
        return { relative: [], cause: `tracked schemas could not be listed: ${errorCause(error)}` }
    }
    if (listed.kind === 'unavailable') return { relative: [], cause: `tracked schemas could not be listed: ${listed.reason}` }
    const paths = listed.kind === 'listed' ? listed.paths : []
    // A name Git printed that cannot be shown or decoded could hide a schema behind a failed stat.
    if (paths.some((path) => UNSAFE_PATH.test(path))) return { relative: [], cause: 'a tracked schema path holds control or undecodable characters' }
    const relative = new Set(['', ...paths.map((path) => { const directory = posix.dirname(path); return directory === '.' ? '' : directory })])
    if (relative.size > SCHEMA_LIMIT_PER_SIBLING) return { relative: [], cause: `it tracks more than ${SCHEMA_LIMIT_PER_SIBLING} schemas` }
    return { relative: [...relative].sort() }
}

function schemaStore(cockpitName: string): readonly string[] {
    return ['env', '.secrets', cockpitName]
}

/**
 * Every directory the cockpit can hold a schema in, in the checkout `cockpit use` serves: each one a
 * sibling tracks, each sibling's root and the cockpit root. An entry with a status could not be
 * discovered and names why. Nothing here opens a schema.
 */
export async function discoverSchemaRoots(
    input: {
        readonly cockpit: { readonly root: string; readonly name: string }
        readonly siblings: readonly EnvSchemaSibling[]
        readonly git: ResolvedExecutable
        readonly timeoutMs: number
    },
    execute: Execute,
): Promise<readonly Readonly<{ schema: SchemaRoot; status?: Extract<SchemaStatus, { state: 'unavailable' }> }>[]> {
    const store = schemaStore(input.cockpit.name)
    const candidates = (await Promise.all(input.siblings.map(async (sibling) => {
        const { relative, cause } = await discoverSchemaDirectories(sibling, input.git, input.timeoutMs, execute)
        return { sibling, relative, cause }
    })))
    const discovered: Array<{ readonly schema: SchemaRoot; readonly status?: Extract<SchemaStatus, { state: 'unavailable' }> }> = candidates.flatMap(({ sibling, relative, cause }) => [
        ...(cause === undefined ? [] : [{ schema: { owner: sibling.slug, relative: '', root: sibling.root, central: [] }, status: { state: 'unavailable' as const, cause } }]),
        ...relative.map((directory) => ({ schema: {
            owner: sibling.slug, relative: directory, root: directory === '' ? sibling.root : join(sibling.root, directory),
            central: [...store, sibling.slug, ...directory === '' ? [] : directory.split('/')],
        } })),
    ])
    // The cockpit's own schema belongs to no sibling, so its resolvers sit directly in the project's store.
    if (!input.siblings.some(({ root }) => resolve(root) === resolve(input.cockpit.root))) {
        discovered.push({ schema: { owner: 'cockpit root', relative: '', root: input.cockpit.root, central: store } })
    }
    return discovered
}

/**
 * Observes every schema the cockpit holds, and returns one aggregate observation per stack with the
 * per-schema status in its measured value. `env` is the caller's environment: a secret provider may
 * need its own variables to resolve.
 */
export async function observeEnvSchemas(
    input: {
        readonly stackId: StackId
        readonly cockpit: { readonly root: string; readonly name: string }
        readonly siblings: readonly EnvSchemaSibling[]
        readonly git: ResolvedExecutable
        readonly env: Readonly<Record<string, string | undefined>>
        readonly timeoutMs: number
    },
    options: { readonly execute: Execute },
): Promise<readonly EnvironmentObservation[]> {
    const store = schemaStore(input.cockpit.name)
    const discovered = await discoverSchemaRoots(input, options.execute)
    const adopted: Array<{ readonly schema: SchemaRoot; readonly status?: SchemaStatus }> = (await Promise.all(discovered.map(async (entry) => {
        if (entry.status) return entry
        const { adopted: holdsSchema, unreadable } = await hasEnvSchema(entry.schema.root)
        if (!holdsSchema) return undefined
        return unreadable === undefined ? entry : { schema: entry.schema, status: { state: 'unavailable' as const, cause: unreadable } }
    }))).filter((entry) => entry !== undefined)
    const probing = adopted.some(({ status }) => status === undefined)
    const resolved = probing ? await resolveExecutable('varlock', input.env) : undefined
    const executable = resolved?.state === 'available' ? resolved.value : undefined
    const mainCheckout = probing ? await mainCheckoutDirectory({ executable: input.git, directory: input.cockpit.root, timeoutMs: input.timeoutMs }, options.execute) : undefined
    const shared: ProbeInput = {
        cockpitRoot: input.cockpit.root,
        ...mainCheckout === undefined ? {} : { mainCheckout },
        // `_VARLOCK_*` steers Varlock itself: an inherited filter hides every other key's error, so a
        // schema with a missing key would read as valid. Provider variables stay.
        env: Object.fromEntries(Object.entries(input.env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].startsWith('_VARLOCK_'))),
        git: input.git,
        timeoutMs: input.timeoutMs,
        stackId: input.stackId,
    }
    const statuses = await Promise.all(adopted.map(async ({ schema, status }): Promise<readonly [SchemaRoot, SchemaStatus]> =>
        [schema, status ?? await checkSchema(schema, executable, shared, options.execute)]))
    const observedAt = new Date().toISOString()
    if (!isCanonicalTimestamp(observedAt)) throw new RefusalError('env-schema observation timestamp is not canonical')
    const common = {
        code: ENVIRONMENT_CODES.ENV_SCHEMA_UNHEALTHY,
        owner: OWNER,
        stackId: input.stackId,
        source: 'env-schema',
        applicability: { state: 'required' as const, posture: 'environment' },
        freshness: { state: 'current' as const },
    }
    const invalid = statuses.flatMap(([schema, status]) => status.state === 'invalid' ? [[schema, status] as const] : [])
    const unavailable = statuses.flatMap(([schema, status]) => status.state === 'unavailable' ? [[schema, status] as const] : [])
    const uncheckable = unavailable.map(([schema, status]) => `${reasonName(schema)}: ${status.cause}`).join('; ')
    const diagnosis = `have a person run \`VARLOCK_TELEMETRY_DISABLED=true varlock load --path <schema directory> --path <cockpit root>/${store.join('/')}/<slug>[/<relative dir>]\` for each named schema, leaving out the second path where that directory does not exist and using ${store.join('/')} itself for the cockpit root's own schema, and fix the reported keys; agents use cockpit preflight, or cockpit doctor on a cockpit that declares no runtime, for key-only status, and list every declared name with \`${cockpitCommand('env keys')}\`, which marks those a schema writes no value for`
    const unresolved = unavailable.length > 0 || invalid.some(([, status]) => status.failures.some(({ problem }) => problem !== 'missing-required'))
    const remedy = unresolved ? `a secret provider may be signed out or unreachable: sign in to it, then rerun this command. Otherwise ${diagnosis}` : diagnosis
    if (invalid.length > 0) {
        const summaries = invalid.map(([schema, status]) => `${reasonName(schema)}: ${invalidSummary(status)}`).join('; ')
        return [issueObservation({
            ...common,
            observed: { state: 'failed', reason: bounded(`env schema is invalid in ${summaries}${uncheckable === '' ? '' : `; could not be checked: ${uncheckable}`}`), observedAt },
            expectation: { kind: 'equal', value: true },
            remedy,
        })]
    }
    if (unavailable.length > 0) {
        return [issueObservation({
            ...common,
            observed: { state: 'unavailable', reason: bounded(`env schema could not be checked: ${uncheckable}`), observedAt },
            expectation: { kind: 'equal', value: true },
            remedy,
        })]
    }
    // An absent varlock binary is advisory because varlock is optional, and a schema left unrun has not
    // failed; applicationDiagnostics turns each into a warning instead of a failing row, and overridden
    // keys likewise.
    const entries: { sibling: string; state: string; keys?: number; overrides?: string[]; load?: string }[] = statuses
        .map(([schema, status]) => status.state === 'valid'
            ? { sibling: entryName(schema), state: 'valid', keys: status.keys, ...status.overrides.length > 0 ? { overrides: [...status.overrides] } : {} }
            : status.state === 'not-run' ? { sibling: entryName(schema), state: 'not-run', load: status.load }
            : { sibling: entryName(schema), state: 'tool-missing' })
        .sort((a, b) => a.sibling < b.sibling ? -1 : 1)
    const measured: JsonSnapshot = entries
    return [issueObservation({
        ...common,
        observed: { state: 'available', value: measured, observedAt },
        expectation: { kind: 'equal', value: measured },
        remedy: `install Varlock (${VARLOCK_INSTALL_URL}) to validate the env schema`,
    })]
}

/** Schemas skipped because varlock is not installed, from a passing row. */
export function envSchemaToolMissing(check: {
    readonly owner: string
    readonly verdict: string
    readonly measured?: JsonSnapshot
}): readonly string[] {
    if (check.owner !== OWNER || check.verdict !== 'pass' || !Array.isArray(check.measured)) return []
    return check.measured.flatMap((entry) => isRecord(entry) && entry.state === 'tool-missing' && typeof entry.sibling === 'string'
        ? [entry.sibling] : [])
}

/** Schemas left unrun because Git does not show them committed, from a passing row, with the load a person runs instead. */
export function envSchemaNotRun(check: {
    readonly owner: string
    readonly verdict: string
    readonly measured?: JsonSnapshot
}): readonly Readonly<{ schema: string; load: string }>[] {
    if (check.owner !== OWNER || check.verdict !== 'pass' || !Array.isArray(check.measured)) return []
    return check.measured.flatMap((entry) => isRecord(entry) && entry.state === 'not-run' && typeof entry.sibling === 'string' && typeof entry.load === 'string'
        ? [{ schema: entry.sibling, load: entry.load }] : [])
}

/**
 * Keys a passing row saw satisfied by the caller's shell rather than the schema's own sources, by
 * schema. Names only, and at most ENV_SCHEMA_OVERRIDE_NAME_LIMIT of them per schema.
 */
export function envSchemaOverrides(check: {
    readonly owner: string
    readonly verdict: string
    readonly measured?: JsonSnapshot
}): readonly Readonly<{ schema: string; keys: readonly string[] }>[] {
    if (check.owner !== OWNER || check.verdict !== 'pass' || !Array.isArray(check.measured)) return []
    return check.measured.flatMap((entry) => isRecord(entry) && typeof entry.sibling === 'string' && Array.isArray(entry.overrides)
        ? [{ schema: entry.sibling, keys: entry.overrides.filter((key): key is string => typeof key === 'string') }] : [])
}
