// Owns: observing the env-schema status of siblings that have adopted Varlock (they contain a
// `.env.schema`). Must not: read, keep or print a resolved value, decide the health verdict
// (observations.ts), or spawn a process itself (environment-exec/execute.ts runs the step).
// Varlock is optional, so a sibling without `.env.schema` is not observed at all and an absent
// binary is advisory. Handed off to: health-composition.ts (producer) and application/health.ts (rows,
// diagnostics).
//
// `varlock load --agent` still prints partial values, and its error messages can quote a value, so
// the report is reduced to key names, the sensitive flag and a validity category the moment it is
// parsed. Nothing else leaves this module.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

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
import { resolveExecutable, type ResolvedExecutable } from './executable.js'

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
    /** Directory as declared in cockpit.toml; only used to tell the operator where to run varlock. */
    readonly dir: string
    readonly root: string
}

const STDOUT_LIMIT_BYTES = 262_144
const STDERR_LIMIT_BYTES = 16_384
const KEY_LIMIT = 4_096
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const REASON_BUDGET_BYTES = 900

type KeyProblem = 'missing-required' | 'invalid'
interface KeyFailure { readonly key: string; readonly problem: KeyProblem }

type SiblingStatus =
    | { readonly state: 'valid'; readonly keys: number }
    | { readonly state: 'tool-missing' }
    | { readonly state: 'invalid'; readonly failures: readonly KeyFailure[]; readonly schemaError: boolean }
    | { readonly state: 'unavailable'; readonly cause: string }

type Report =
    | { readonly kind: 'report'; readonly keys: number; readonly failures: readonly KeyFailure[]; readonly schemaError: boolean }
    | { readonly kind: 'malformed' }

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
                failures.push({ key, problem: /required/i.test(message) ? 'missing-required' : 'invalid' })
            }
        }
        if (failures.length === 0) schemaError = true
    }
    return { kind: 'report', keys: names.length, failures: failures.sort((a, b) => a.key < b.key ? -1 : 1), schemaError }
}

async function hasEnvSchema(root: string): Promise<{ adopted: boolean; unreadable?: string }> {
    try {
        return { adopted: (await stat(join(root, ENV_SCHEMA_FILE))).isFile() }
    } catch (error) {
        if (isMissing(error)) return { adopted: false }
        return { adopted: true, unreadable: `${ENV_SCHEMA_FILE} could not be inspected (${errorCause(error)})` }
    }
}

function createStep(input: {
    readonly executable: ResolvedExecutable
    readonly sibling: EnvSchemaSibling
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
}): ExecutionStep | undefined {
    const { executable, sibling } = input
    return snapshotExecutionStep({
        id: `env-schema:${sibling.slug}`,
        argv: [executable.canonicalPath, 'load', '--agent', '--format', 'json-full', '--path', sibling.root],
        argv0: executable.invocationPath,
        cwd: sibling.root,
        env: { ...input.env, VARLOCK_TELEMETRY_DISABLED: 'true' },
        timeoutMs: input.timeoutMs,
        stdoutLimitBytes: STDOUT_LIMIT_BYTES,
        stderrLimitBytes: STDERR_LIMIT_BYTES,
        paths: [],
        ports: [],
        labels: { producer: 'env-schema', stackId: input.stackId, sibling: sibling.slug },
        expected: [{ kind: 'path', target: sibling.root, state: 'directory' }],
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

async function checkSibling(
    sibling: EnvSchemaSibling,
    executable: ResolvedExecutable | undefined,
    input: { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly stackId: StackId },
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<SiblingStatus> {
    if (!executable) return { state: 'tool-missing' }
    const step = createStep({ executable, sibling, ...input })
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
    if (report.failures.length > 0 || report.schemaError) {
        return { state: 'invalid', failures: report.failures, schemaError: report.schemaError }
    }
    return outcome.kind === 'refusal'
        ? { state: 'unavailable', cause: describeFailure(outcome, input.timeoutMs) }
        : { state: 'valid', keys: report.keys }
}

function bounded(text: string): string {
    if (Buffer.byteLength(text) <= REASON_BUDGET_BYTES) return text
    return `${Buffer.from(text).subarray(0, REASON_BUDGET_BYTES).toString('utf8').replace(/�$/, '')}...`
}

function invalidSummary(sibling: EnvSchemaSibling, status: Extract<SiblingStatus, { state: 'invalid' }>): string {
    const group = (problem: KeyProblem) => status.failures.filter((failure) => failure.problem === problem).map(({ key }) => key)
    const parts = [
        ...(group('missing-required').length > 0 ? [`missing required ${group('missing-required').join(', ')}`] : []),
        ...(group('invalid').length > 0 ? [`invalid ${group('invalid').join(', ')}`] : []),
        ...(status.schemaError && status.failures.length === 0 ? ['schema could not be loaded'] : []),
    ]
    return `${sibling.slug} (${sibling.dir}): ${parts.join('; ')}`
}

/**
 * Observes every sibling that contains `.env.schema`. Returns one aggregate observation per
 * stack, with the per-sibling status in its measured value. `env` is the caller's environment:
 * a secret provider may need its own variables to resolve.
 */
export async function observeEnvSchemas(
    input: {
        readonly stackId: StackId
        readonly siblings: readonly EnvSchemaSibling[]
        readonly env: Readonly<Record<string, string | undefined>>
        readonly timeoutMs: number
    },
    options: { readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome> },
): Promise<readonly EnvironmentObservation[]> {
    const detected = await Promise.all(input.siblings.map(async (sibling) => ({ sibling, ...(await hasEnvSchema(sibling.root)) })))
    const adopted = detected.filter(({ adopted }) => adopted)
    const needsBinary = adopted.some(({ unreadable }) => unreadable === undefined)
    const resolved = needsBinary ? await resolveExecutable('varlock', input.env) : undefined
    const executable = resolved?.state === 'available' ? resolved.value : undefined
    const shared = {
        env: Object.fromEntries(Object.entries(input.env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        timeoutMs: input.timeoutMs,
        stackId: input.stackId,
    }
    const statuses = await Promise.all(adopted.map(async ({ sibling, unreadable }): Promise<readonly [EnvSchemaSibling, SiblingStatus]> =>
        [sibling, unreadable !== undefined
            ? { state: 'unavailable', cause: unreadable }
            : await checkSibling(sibling, executable, shared, options.execute)]))
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
    const invalid = statuses.flatMap(([sibling, status]) => status.state === 'invalid' ? [[sibling, status] as const] : [])
    const unavailable = statuses.flatMap(([sibling, status]) => status.state === 'unavailable' ? [[sibling, status] as const] : [])
    const remedy = 'have a person run `VARLOCK_TELEMETRY_DISABLED=true varlock load` in each named sibling directory and fix the reported keys; agents use cockpit preflight for key-only status'
    if (invalid.length > 0) {
        return [issueObservation({
            ...common,
            observed: { state: 'failed', reason: bounded(`env schema is invalid in ${invalid.map(([sibling, status]) => invalidSummary(sibling, status)).join('; ')}`), observedAt },
            expectation: { kind: 'equal', value: true },
            remedy,
        })]
    }
    if (unavailable.length > 0) {
        return [issueObservation({
            ...common,
            observed: { state: 'unavailable', reason: bounded(`env schema could not be checked: ${unavailable.map(([sibling, status]) => `${sibling.slug} (${sibling.dir}): ${status.cause}`).join('; ')}`), observedAt },
            expectation: { kind: 'equal', value: true },
            remedy,
        })]
    }
    // An absent varlock binary is advisory because varlock is optional; applicationDiagnostics
    // turns it into a warning instead of a failing row.
    const entries: { sibling: string; state: string; keys?: number }[] = statuses
        .map(([sibling, status]) => status.state === 'valid'
            ? { sibling: sibling.slug, state: 'valid', keys: status.keys }
            : { sibling: sibling.slug, state: 'tool-missing' })
        .sort((a, b) => a.sibling < b.sibling ? -1 : 1)
    const measured: JsonSnapshot = entries
    return [issueObservation({
        ...common,
        observed: { state: 'available', value: measured, observedAt },
        expectation: { kind: 'equal', value: measured },
        remedy: `install Varlock (${VARLOCK_INSTALL_URL}) to validate the env schema`,
    })]
}

/** Siblings whose schema was skipped because varlock is not installed, from a passing row. */
export function envSchemaToolMissing(check: {
    readonly owner: string
    readonly verdict: string
    readonly measured?: JsonSnapshot
}): readonly string[] {
    if (check.owner !== OWNER || check.verdict !== 'pass' || !Array.isArray(check.measured)) return []
    return check.measured.flatMap((entry) => isRecord(entry) && entry.state === 'tool-missing' && typeof entry.sibling === 'string'
        ? [entry.sibling] : [])
}
