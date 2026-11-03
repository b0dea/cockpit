import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { isProxy } from 'node:util/types'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    RefusalError,
    ENVIRONMENT_CODES,
    EXECUTION_FAILURE_CODES,
    snapshotJson,
    snapshotExecutionPlan,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type ExecutionFailureCode,
    type ExecutionPlan,
    type ExecutionStep,
    type StackId,
} from './contract.js'
import { classifyResolvedRuntimeLiterals } from './runtime.js'
import { isSensitiveField, redactSensitiveText } from './sensitive.js'
import { isResolvedDockerExecutable, type ResolvedExecutable } from './executable.js'

const SHA256 = /^[a-f0-9]{64}$/
const STACK_ID = /^stack:[a-f0-9]{64}$/
const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const MAX_TIMEOUT_MS = 30_000
// Exported so a caller passes the capture's own bound: the capture prints one stat line and one
// digest line, and a general output limit sized for logs exceeds what this planner admits.
export const STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES = 65_536
const UNAVAILABLE_EVIDENCE_CODES = new Set<string>([ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, ...EXECUTION_FAILURE_CODES])
const PROCESS_STEP_PREFIX = 'evidence:process-identity:'
const CONTENT_STEP_PREFIX = 'evidence:content-hash:'
const PROCESS_SCRIPT = 'IFS= read -r stat < /proc/1/stat; pid=${stat%% *}; rest=${stat##*) }; set -- $rest; printf "%s %s\\n" "$pid" "${20}"'
// -H follows a symlink named as a content path: /proc/1/exe is one, and without -H find skips it,
// hashes nothing, and the capture fails with an empty corpus on every real container.
const CONTENT_SCRIPT = 'tmp=${TMPDIR:-/tmp}/cockpit-content-$$; cockpit_hash_failure=$tmp.failed; export cockpit_hash_failure; trap \'rm -f "$tmp.raw" "$tmp.sorted" "$tmp.failed"\' EXIT HUP INT TERM; find -H "$@" -type f -exec sh -c \'sha256sum -- "$@" || { : > "$cockpit_hash_failure"; exit 1; }\' sh {} + > "$tmp.raw"; [ ! -e "$tmp.failed" ] && [ -s "$tmp.raw" ]; LC_ALL=C sort "$tmp.raw" > "$tmp.sorted"; sha256sum "$tmp.sorted"'

type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function stableValue(value: JsonValue): string {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`).join(',')}}`
    }
    return JSON.stringify(value)
}

function ownedObject<Value extends object>(value: unknown): Value | undefined {
    const snapshot = snapshotJson(value)
    return snapshot !== undefined && snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
        ? snapshot as unknown as Value
        : undefined
}

function exactKeys(value: object, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const keys = [...expected].sort()
    return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function sanitize(value: JsonValue, key = ''): JsonValue {
    if (isSensitiveField(key)) return '[redacted]'
    if (Array.isArray(value)) return Object.freeze(value.map((item) => sanitize(item)))
    if (value !== null && typeof value === 'object') {
        return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitize(child, name)])))
    }
    return typeof value === 'string' ? redactSensitiveText(value) : value
}

function validInstant(value: string): boolean {
    if (!ISO_INSTANT.test(value)) return false
    const date = new Date(value)
    const canonical = value.includes('.') ? value : value.replace('Z', '.000Z')
    return !Number.isNaN(date.valueOf()) && date.toISOString() === canonical
}

function instantMs(value: string): number { return new Date(value).valueOf() }

function diagnostic(message: string, target: string): EnvironmentDiagnostic {
    return Object.freeze({ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, message, target })
}

function refusal<T>(message: string, target: string): EnvironmentCommandOutcome<T> {
    return Object.freeze({ kind: 'refusal', status: 2, diagnostics: Object.freeze([diagnostic(message, target)]), result: null })
}

export interface EnvironmentSnapshotInput {
    readonly stackId: StackId
    readonly configSha256: string
    readonly createdAt: string
    readonly creationSource: 'resolved-config'
    readonly intendedState: JsonValue
}

export interface EnvironmentSnapshot {
    readonly artifact: 'generated-environment-snapshot'
    readonly schemaVersion: 1
    readonly stackId: StackId
    readonly configSha256: string
    readonly createdAt: string
    readonly creationSource: string
    readonly intendedState: JsonValue
    readonly snapshotSha256: string
}

export function createEnvironmentSnapshot(input: EnvironmentSnapshotInput): EnvironmentSnapshot {
    const owned = ownedObject<EnvironmentSnapshotInput>(input)
    if (owned === undefined || !exactKeys(owned, ['configSha256', 'createdAt', 'creationSource', 'intendedState', 'stackId'])
        || typeof owned.stackId !== 'string' || typeof owned.configSha256 !== 'string' || typeof owned.createdAt !== 'string'
        || !STACK_ID.test(owned.stackId) || !SHA256.test(owned.configSha256) || !validInstant(owned.createdAt)
        || owned.creationSource !== 'resolved-config') {
        throw new RefusalError('environment snapshot provenance is invalid')
    }
    const intendedState = sanitize(owned.intendedState)
    const snapshotSha256 = digest(stableValue({
        stackId: owned.stackId,
        configSha256: owned.configSha256,
        createdAt: owned.createdAt,
        creationSource: owned.creationSource,
        intendedState,
    }))
    return Object.freeze({
        artifact: 'generated-environment-snapshot', schemaVersion: 1, stackId: owned.stackId,
        configSha256: owned.configSha256, createdAt: owned.createdAt,
        creationSource: owned.creationSource, intendedState, snapshotSha256,
    })
}

export interface StabilityCapturePlanInput {
    readonly stackId: StackId
    readonly configSha256: string
    readonly runtimeExecutable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly containerId: string
    readonly batchId: string
    readonly runtime: { readonly name: string; readonly version: string }
    readonly contentPaths: readonly string[]
    readonly timeoutMs: number
    readonly outputLimitBytes: number
}

function stabilityCapturePlanInput(value: unknown): StabilityCapturePlanInput | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['stackId', 'configSha256', 'runtimeExecutable', 'cwd', 'env', 'containerId', 'batchId', 'runtime', 'contentPaths', 'timeoutMs', 'outputLimitBytes'])) return undefined
    const input = value as Partial<StabilityCapturePlanInput>
    if (!isResolvedDockerExecutable(input.runtimeExecutable)
        || input.runtime === null || typeof input.runtime !== 'object' || Array.isArray(input.runtime)
        || !exactKeys(input.runtime, ['name', 'version']) || Object.values(input.runtime).some((part) => typeof part !== 'string')
        || input.env === null || typeof input.env !== 'object' || Array.isArray(input.env)
        || Object.entries(input.env).some(([name, part]) => name.length === 0 || typeof part !== 'string')
        || !Array.isArray(input.contentPaths) || input.contentPaths.some((path) => typeof path !== 'string')
        || typeof input.stackId !== 'string' || typeof input.configSha256 !== 'string' || typeof input.cwd !== 'string'
        || typeof input.containerId !== 'string' || typeof input.batchId !== 'string'
        || typeof input.timeoutMs !== 'number' || typeof input.outputLimitBytes !== 'number') return undefined
    return input as StabilityCapturePlanInput
}

function captureStep(input: StabilityCapturePlanInput, id: string, argv: readonly [string, ...string[]]): ExecutionStep {
    return Object.freeze({
        id,
        argv: Object.freeze([...argv]) as unknown as readonly [string, ...string[]],
        argv0: input.runtimeExecutable.invocationPath,
        cwd: input.cwd,
        env: Object.freeze({ ...input.env }),
        timeoutMs: input.timeoutMs,
        stdoutLimitBytes: input.outputLimitBytes,
        stderrLimitBytes: input.outputLimitBytes,
        paths: Object.freeze([...input.contentPaths]),
        ports: Object.freeze([]),
        labels: Object.freeze({ stackId: input.stackId, configSha256: input.configSha256, containerId: input.containerId, batchId: input.batchId, runtimeName: input.runtime.name, runtimeVersion: input.runtime.version, executableSha256: input.runtimeExecutable.sha256, evidenceRole: id.startsWith(PROCESS_STEP_PREFIX) ? 'process-identity' : 'content-hash' }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({ path: input.runtimeExecutable.canonicalPath, sha256: input.runtimeExecutable.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: input.runtimeExecutable.executionMode })]),
        filesystemChecks: Object.freeze([]),
        compensation: Object.freeze([]),
    })
}

export function createStabilityCapturePlan(rawInput: StabilityCapturePlanInput): EnvironmentCommandOutcome<null> {
    const input = stabilityCapturePlanInput(snapshotJson(rawInput))
    if (input === undefined) return refusal('stability capture input must be readable JSON data', 'stability-capture')
    const pathsValid = input.contentPaths.length > 0 && new Set(input.contentPaths).size === input.contentPaths.length
        && input.contentPaths.every((path) => isAbsolute(path) && normalize(path) === path && !path.includes('\0'))
    if (!STACK_ID.test(input.stackId) || !SHA256.test(input.configSha256)
        || !isResolvedDockerExecutable(input.runtimeExecutable)
        || !isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd || !CONTAINER_ID.test(input.containerId) || !SHA256.test(input.batchId)
        || input.runtime.name !== 'docker' || !/^\d+\.\d+\.\d+$/.test(input.runtime.version)
        || !pathsValid || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS
        || !Number.isInteger(input.outputLimitBytes) || input.outputLimitBytes < 1 || input.outputLimitBytes > STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES) {
        return refusal('stability capture requires resolved in-container targets and bounded execution', input.containerId)
    }
    if (Object.keys(input.env).some((name) => name.startsWith('DOCKER_') || name.startsWith('COMPOSE_'))
        || classifyResolvedRuntimeLiterals([...Object.keys(input.env), ...Object.values(input.env)]) !== 'resolved') {
        return refusal('stability capture cannot accept decision-bearing runtime environment', input.containerId)
    }
    const steps = Object.freeze([
        captureStep(input, `${PROCESS_STEP_PREFIX}${input.containerId}`, [
            input.runtimeExecutable.canonicalPath, 'exec', '--', input.containerId,
            '/bin/sh', '-eu', '-c', PROCESS_SCRIPT,
        ]),
        captureStep(input, `${CONTENT_STEP_PREFIX}${input.containerId}`, [
            input.runtimeExecutable.canonicalPath, 'exec', '--', input.containerId,
            '/bin/sh', '-eu', '-c', CONTENT_SCRIPT, 'cockpit-content-hash', ...input.contentPaths,
        ]),
    ])
    const plan = snapshotExecutionPlan({ steps })
    return plan === undefined
        ? refusal('stability capture did not produce a valid execution plan', input.containerId)
        : Object.freeze({ kind: 'preview', status: 0, diagnostics: Object.freeze([]), result: null, plan })
}

const authenticatedCaptureBrand: unique symbol = Symbol('authenticated-stability-capture')
export interface AuthenticatedStabilityCapture {
    readonly [authenticatedCaptureBrand]: true
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly containerId: string
    readonly runtime: Readonly<{ name: string; version: string; executableSha256: string }>
    readonly startedAt: string
    readonly finishedAt: string
    readonly command: Readonly<{ stepIds: readonly [string, string]; timeoutMs: number; stdoutLimitBytes: number; stderrLimitBytes: number }>
    readonly observedBytes: Readonly<{ stdout: number; stderr: number }>
    readonly processIdentity: string
    readonly contentHash: string
}

type AuthenticatedStabilityCapturePayload = Omit<AuthenticatedStabilityCapture, typeof authenticatedCaptureBrand>
const issuedCaptures = new WeakMap<AuthenticatedStabilityCapture, AuthenticatedStabilityCapturePayload>()

export type StabilityStepResult = ExecuteProbeOutcome

function ownedResults(value: unknown): readonly StabilityStepResult[] | undefined {
    try {
        if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
        const keys = Reflect.ownKeys(value)
        const first = Object.getOwnPropertyDescriptor(value, '0')
        const second = Object.getOwnPropertyDescriptor(value, '1')
        const length = Object.getOwnPropertyDescriptor(value, 'length')
        if (keys.length !== 3 || !keys.includes('0') || !keys.includes('1') || !keys.includes('length')
            || first === undefined || !first.enumerable || !('value' in first)
            || second === undefined || !second.enumerable || !('value' in second)
            || length === undefined || length.enumerable || !('value' in length) || length.value !== 2) return undefined
        return Object.freeze([first.value as StabilityStepResult, second.value as StabilityStepResult])
    } catch {
        // A throwing accessor or proxy trap means the result pair is malformed.
        return undefined
    }
}

function captureAuthenticationInput(value: unknown): { readonly plan: unknown; readonly results: unknown } | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
        const keys = Reflect.ownKeys(value)
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const plan = descriptors.plan; const results = descriptors.results
        if (keys.length !== 2 || !keys.includes('plan') || !keys.includes('results')
            || plan === undefined || !plan.enumerable || !('value' in plan)
            || results === undefined || !results.enumerable || !('value' in results)) return undefined
        return { plan: plan.value, results: results.value }
    } catch {
        // A throwing accessor or proxy trap means the capture input is malformed.
        return undefined
    }
}

export function authenticateStabilityCapture(input: {
    readonly plan: Extract<EnvironmentCommandOutcome<null>, { kind: 'preview' }>
    readonly results: readonly StabilityStepResult[]
}): AuthenticatedStabilityCapture | UnavailableRuntimeEvidence {
    const ownedInput = captureAuthenticationInput(input)
    if (ownedInput === undefined) return unavailable('stability capture input is not readable')
    const plan = ownedObject<Extract<EnvironmentCommandOutcome<null>, { kind: 'preview' }>>(ownedInput.plan)
    const capturedResults = ownedResults(ownedInput.results)
    if (plan === undefined || capturedResults === undefined || !exactKeys(plan, ['kind', 'status', 'diagnostics', 'result', 'plan'])
        || plan.kind !== 'preview' || plan.status !== 0 || plan.result !== null || !Array.isArray(plan.diagnostics) || plan.diagnostics.length !== 0) {
        return unavailable('stability capture input is not readable')
    }
    const executionPlan = snapshotExecutionPlan(plan.plan)
    if (executionPlan === undefined) return unavailable('stability capture input is not readable')
    const steps = executionPlan.steps
    if (steps.length !== 2) {
        return unavailable('stability capture requires two complete planned execution results')
    }
    try {
    const authenticatedResults = capturedResults.map((result, index) => authenticatedExecutionOutcome(result, steps[index]))
    if (authenticatedResults.some((result) => result === undefined)) {
        return unavailable('stability results do not authenticate against one planned execution cohort')
    }
    const refused = authenticatedResults.find((result) => result?.kind === 'refusal')
    if (refused?.kind === 'refusal') return unavailable('stability capture execution was refused', refused.code)
    const results = authenticatedResults as unknown as readonly [Extract<StabilityStepResult, { kind: 'complete' }>, Extract<StabilityStepResult, { kind: 'complete' }>]
    const [first, second] = results
    const labels = steps[0].labels
    const sameCohort = steps.every((step) => step.labels.stackId === labels.stackId
        && step.labels.configSha256 === labels.configSha256 && step.labels.batchId === labels.batchId
        && step.labels.containerId === labels.containerId && step.labels.runtimeName === labels.runtimeName
        && step.labels.runtimeVersion === labels.runtimeVersion && step.labels.executableSha256 === labels.executableSha256
        && step.argv0 === steps[0].argv0)
    const executable = steps[0].argv[0]
    const exactCommands = steps[0].argv.length === 8 && steps[0].argv.slice(1).join('\0') === ['exec', '--', labels.containerId, '/bin/sh', '-eu', '-c', PROCESS_SCRIPT].join('\0')
        && steps[1].argv.length > 9 && steps[1].argv.slice(1, 8).join('\0') === ['exec', '--', labels.containerId, '/bin/sh', '-eu', '-c', CONTENT_SCRIPT].join('\0')
        && steps[1].argv[8] === 'cockpit-content-hash'
        && isAbsolute(steps[0].argv0) && normalize(steps[0].argv0) === steps[0].argv0
        && steps.every((step) => step.argv[0] === executable && step.filesystemChecks.length === 0
            && step.consumedFiles.length === 1 && step.consumedFiles[0].path === executable
            && step.consumedFiles[0].sha256 === labels.executableSha256
            && step.consumedFiles[0].executable && step.consumedFiles[0].argvIndexes.length === 1
            && step.consumedFiles[0].argvIndexes[0] === 0)
    if (!sameCohort || !exactCommands || !STACK_ID.test(labels.stackId ?? '') || !SHA256.test(labels.configSha256 ?? '')
        || !SHA256.test(labels.batchId ?? '') || !CONTAINER_ID.test(labels.containerId ?? '') || labels.runtimeName !== 'docker'
        || !/^\d+\.\d+\.\d+$/.test(labels.runtimeVersion ?? '') || !SHA256.test(labels.executableSha256 ?? '')
        || steps[0].labels.evidenceRole !== 'process-identity' || steps[1].labels.evidenceRole !== 'content-hash'
        || !validInstant(first.receipt.startedAt) || !validInstant(first.receipt.finishedAt)
        || !validInstant(second.receipt.startedAt) || !validInstant(second.receipt.finishedAt)
        || instantMs(first.receipt.startedAt) > instantMs(first.receipt.finishedAt) || instantMs(first.receipt.finishedAt) > instantMs(second.receipt.startedAt)
        || instantMs(second.receipt.startedAt) > instantMs(second.receipt.finishedAt)
        || steps[0].id !== `${PROCESS_STEP_PREFIX}${labels.containerId}` || steps[1].id !== `${CONTENT_STEP_PREFIX}${labels.containerId}`
        || first.receipt.stepId !== steps[0].id || second.receipt.stepId !== steps[1].id) {
        return unavailable('stability results do not authenticate against one planned execution cohort')
    }
    const stdout = first.stdout.byteLength + second.stdout.byteLength
    const stderr = first.stderr.byteLength + second.stderr.byteLength
    if (results.some((result, index) => result.stdout.byteLength > steps[index].stdoutLimitBytes || result.stderr.byteLength > steps[index].stderrLimitBytes
        || result.execution.stdoutRetainedBytes !== result.stdout.byteLength || result.execution.stderrRetainedBytes !== result.stderr.byteLength
        || result.execution.stdoutObservedBytes !== result.stdout.byteLength || result.execution.stderrObservedBytes !== result.stderr.byteLength)) return unavailable('stability result exceeded its planned limit')
    let processIdentity: string; let contentHash: string
    try {
        processIdentity = new TextDecoder('utf-8', { fatal: true }).decode(first.stdout).trim()
        contentHash = new TextDecoder('utf-8', { fatal: true }).decode(second.stdout).trim().split(/\s+/)[0]
    } catch { /* Invalid UTF-8 is the only throw here and is what the message names. */ return unavailable('stability result encoding is invalid') }
    if (!/^\d+ \d+$/.test(processIdentity) || !SHA256.test(contentHash)) return unavailable('stability result shape is invalid')
    const payload = Object.freeze({
        stackId: labels.stackId as StackId, configSha256: labels.configSha256,
        batchId: labels.batchId, containerId: labels.containerId,
        runtime: Object.freeze({ name: labels.runtimeName, version: labels.runtimeVersion, executableSha256: labels.executableSha256 }), startedAt: first.receipt.startedAt, finishedAt: second.receipt.finishedAt,
        command: Object.freeze({ stepIds: Object.freeze([steps[0].id, steps[1].id]) as readonly [string, string], timeoutMs: Math.max(...steps.map(({ timeoutMs }) => timeoutMs)), stdoutLimitBytes: steps.reduce((sum, step) => sum + step.stdoutLimitBytes, 0), stderrLimitBytes: steps.reduce((sum, step) => sum + step.stderrLimitBytes, 0) }),
        observedBytes: Object.freeze({ stdout, stderr }), processIdentity, contentHash,
    })
    const capture = Object.freeze({ [authenticatedCaptureBrand]: true as const, ...payload })
    issuedCaptures.set(capture, payload)
    return capture
    } catch {
        // A throwing accessor or proxy trap means the capture input is not readable, which the message names.
        return unavailable('stability capture input is not readable')
    }
}

export interface RuntimeEvidenceInput {
    readonly capture: AuthenticatedStabilityCapture
}

export interface CapturedEvidenceCommand {
    readonly batchId: string
    readonly containerId: string
    readonly stepIds: readonly [string, string]
    readonly timeoutMs: number
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
}

export interface CapturedRuntimeEvidence {
    readonly state: 'available'
    readonly artifact: 'captured-runtime-evidence'
    readonly schemaVersion: 1
    readonly stackId: StackId
    readonly configSha256: string
    readonly runtime: Readonly<{ name: string; version: string; executableSha256: string }>
    readonly observedAt: string
    readonly captureStartedAt: string
    readonly command: Readonly<CapturedEvidenceCommand>
    readonly observedBytes: Readonly<{ stdout: number; stderr: number }>
    readonly stability: Readonly<{ processIdentitySha256: string; contentHash: string }>
    readonly evidenceSha256: string
}

export interface UnavailableRuntimeEvidence {
    readonly state: 'unavailable'
    readonly code: typeof ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE | ExecutionFailureCode
    readonly reason: string
}

export type RuntimeEvidence = CapturedRuntimeEvidence | UnavailableRuntimeEvidence

function unavailable(reason: string, code: UnavailableRuntimeEvidence['code'] = ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE): UnavailableRuntimeEvidence {
    return Object.freeze({ state: 'unavailable', code, reason })
}

export function captureRuntimeEvidence(input: RuntimeEvidenceInput): RuntimeEvidence {
    let capture: AuthenticatedStabilityCapturePayload | undefined
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
            return unavailable('runtime evidence capture is not readable')
        }
        const keys = Reflect.ownKeys(input)
        const descriptor = Object.getOwnPropertyDescriptor(input, 'capture')
        if (keys.length !== 1 || keys[0] !== 'capture' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
            || descriptor.value === null || typeof descriptor.value !== 'object' || isProxy(descriptor.value)) {
            return unavailable('runtime evidence capture is not readable')
        }
        capture = issuedCaptures.get(descriptor.value as AuthenticatedStabilityCapture)
        if (capture === undefined) {
            return unavailable('runtime evidence was not produced by an authenticated capture')
        }
    } catch { /* A throwing accessor or proxy trap means the capture is not readable, which the message names. */ return unavailable('runtime evidence capture is not readable') }
    if (!validAuthenticatedCapture(capture)) return unavailable('runtime evidence provenance is invalid')
    const [processStepId, contentStepId] = capture.command.stepIds
    if (!STACK_ID.test(capture.stackId) || !SHA256.test(capture.configSha256)
        || !SHA256.test(capture.runtime.executableSha256) || !/^\d+\.\d+\.\d+$/.test(capture.runtime.version)
        || capture.runtime.name.length === 0 || !SHA256.test(capture.batchId) || !CONTAINER_ID.test(capture.containerId)
        || processStepId !== `${PROCESS_STEP_PREFIX}${capture.containerId}` || contentStepId !== `${CONTENT_STEP_PREFIX}${capture.containerId}`) return unavailable('runtime evidence provenance is invalid')
    if (!Number.isSafeInteger(capture.observedBytes.stdout) || !Number.isSafeInteger(capture.observedBytes.stderr)) {
        return unavailable('runtime evidence exceeded or omitted its declared execution limits')
    }
    const observedAt = capture.finishedAt
    const command = Object.freeze({ ...capture.command, batchId: capture.batchId, containerId: capture.containerId, stepIds: Object.freeze([...capture.command.stepIds]) as unknown as readonly [string, string] })
    const observedBytes = Object.freeze({ ...capture.observedBytes })
    const runtime = Object.freeze({ ...capture.runtime })
    const stability = Object.freeze({
        processIdentitySha256: digest(capture.processIdentity),
        contentHash: capture.contentHash,
    })
    const captureStartedAt = capture.startedAt
    const core = { stackId: capture.stackId, configSha256: capture.configSha256, runtime, observedAt, captureStartedAt, command, observedBytes, stability }
    return Object.freeze({ state: 'available', artifact: 'captured-runtime-evidence', schemaVersion: 1, ...core, evidenceSha256: digest(stableValue(core as unknown as JsonValue)) })
}

export type EnvironmentComparison =
    | { readonly verdict: 'stable'; readonly processIdentity: 'unchanged'; readonly contentHash: 'unchanged'; readonly diagnostics: readonly [] }
    | { readonly verdict: 'void'; readonly processIdentity: 'unchanged' | 'moved'; readonly contentHash: 'unchanged' | 'moved'; readonly diagnostics: readonly EnvironmentDiagnostic[] }
    | { readonly verdict: 'stale' | 'unavailable'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

function sameRuntime(left: CapturedRuntimeEvidence, right: CapturedRuntimeEvidence): boolean {
    return left.runtime.name === right.runtime.name && left.runtime.version === right.runtime.version
        && left.runtime.executableSha256 === right.runtime.executableSha256
}

function validRuntimeEvidence(value: unknown): value is RuntimeEvidence {
    if (validEvidence(value)) return true
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['state', 'code', 'reason'])) return false
    const candidate = value as Partial<UnavailableRuntimeEvidence>
    return candidate.state === 'unavailable' && typeof candidate.code === 'string'
        && UNAVAILABLE_EVIDENCE_CODES.has(candidate.code) && typeof candidate.reason === 'string'
}

export function compareEnvironmentSnapshot(
    rawSnapshot: EnvironmentSnapshot,
    rawBefore: RuntimeEvidence,
    rawAfter: RuntimeEvidence,
): EnvironmentComparison {
    const snapshot = ownedObject<EnvironmentSnapshot>(rawSnapshot)
    const before = ownedObject<RuntimeEvidence>(rawBefore)
    const after = ownedObject<RuntimeEvidence>(rawAfter)
    if (snapshot === undefined || before === undefined || after === undefined) {
        return Object.freeze({ verdict: 'unavailable', diagnostics: Object.freeze([diagnostic('environment evidence is not readable', 'environment-evidence')]) })
    }
    if (!validSnapshot(snapshot)) {
        return Object.freeze({ verdict: 'unavailable', diagnostics: Object.freeze([diagnostic('generated environment snapshot is invalid', 'environment-snapshot')]) })
    }
    if (!validRuntimeEvidence(before) || !validRuntimeEvidence(after)) {
        return Object.freeze({ verdict: 'unavailable', diagnostics: Object.freeze([diagnostic('captured runtime evidence is invalid', snapshot.stackId)]) })
    }
    if (before.state !== 'available' || after.state !== 'available') {
        return Object.freeze({ verdict: 'unavailable', diagnostics: Object.freeze([diagnostic('required runtime evidence is unavailable', snapshot.stackId)]) })
    }
    if (!isRuntimeEvidenceAuthentic(before) || !isRuntimeEvidenceAuthentic(after)) {
        return Object.freeze({ verdict: 'unavailable', diagnostics: Object.freeze([diagnostic('captured runtime evidence is invalid', snapshot.stackId)]) })
    }
    if (snapshot.stackId !== before.stackId || snapshot.stackId !== after.stackId
        || snapshot.configSha256 !== before.configSha256 || snapshot.configSha256 !== after.configSha256
        || !sameRuntime(before, after)) {
        return Object.freeze({ verdict: 'stale', diagnostics: Object.freeze([diagnostic('evidence authorities changed during comparison', snapshot.stackId)]) })
    }
    if (before.command.batchId === after.command.batchId || instantMs(before.observedAt) > instantMs(after.captureStartedAt)) {
        return Object.freeze({ verdict: 'unavailable', diagnostics: Object.freeze([diagnostic('evidence batches are replayed or out of order', snapshot.stackId)]) })
    }
    const processIdentity = before.stability.processIdentitySha256 === after.stability.processIdentitySha256 ? 'unchanged' : 'moved'
    const contentHash = before.stability.contentHash === after.stability.contentHash ? 'unchanged' : 'moved'
    if (processIdentity === 'moved' || contentHash === 'moved') {
        return Object.freeze({
            verdict: 'void', processIdentity, contentHash,
            diagnostics: Object.freeze([diagnostic('test subject changed while evidence was captured', snapshot.stackId)]),
        })
    }
    const diagnostics = Object.freeze([]) as readonly []
    return Object.freeze({ verdict: 'stable', processIdentity, contentHash, diagnostics })
}

function validSnapshot(value: unknown): value is EnvironmentSnapshot {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['artifact', 'schemaVersion', 'stackId', 'configSha256', 'createdAt', 'creationSource', 'intendedState', 'snapshotSha256'])) return false
    const snapshot = value as Partial<EnvironmentSnapshot>
    if (typeof snapshot.artifact !== 'string' || typeof snapshot.schemaVersion !== 'number'
        || typeof snapshot.stackId !== 'string' || typeof snapshot.configSha256 !== 'string'
        || typeof snapshot.createdAt !== 'string' || typeof snapshot.creationSource !== 'string'
        || typeof snapshot.snapshotSha256 !== 'string' || snapshot.intendedState === undefined) return false
    const core = {
        stackId: snapshot.stackId, configSha256: snapshot.configSha256, createdAt: snapshot.createdAt,
        creationSource: snapshot.creationSource, intendedState: snapshot.intendedState,
    }
    return snapshot.artifact === 'generated-environment-snapshot' && snapshot.schemaVersion === 1
        && STACK_ID.test(snapshot.stackId) && SHA256.test(snapshot.configSha256) && validInstant(snapshot.createdAt)
        && snapshot.creationSource === 'resolved-config' && stableValue(sanitize(snapshot.intendedState)) === stableValue(snapshot.intendedState)
        && SHA256.test(snapshot.snapshotSha256)
        && snapshot.snapshotSha256 === digest(stableValue(core))
}

function validAuthenticatedCapture(value: unknown): value is Omit<AuthenticatedStabilityCapture, typeof authenticatedCaptureBrand> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['stackId', 'configSha256', 'batchId', 'containerId', 'runtime', 'startedAt', 'finishedAt', 'command', 'observedBytes', 'processIdentity', 'contentHash'])) return false
    const capture = value as Omit<AuthenticatedStabilityCapture, typeof authenticatedCaptureBrand>
    return typeof capture.stackId === 'string' && STACK_ID.test(capture.stackId)
        && typeof capture.configSha256 === 'string' && SHA256.test(capture.configSha256)
        && typeof capture.batchId === 'string' && SHA256.test(capture.batchId)
        && typeof capture.containerId === 'string' && CONTAINER_ID.test(capture.containerId)
        && capture.runtime !== null && typeof capture.runtime === 'object' && !Array.isArray(capture.runtime)
        && exactKeys(capture.runtime, ['name', 'version', 'executableSha256'])
        && typeof capture.runtime.name === 'string' && capture.runtime.name.length > 0
        && typeof capture.runtime.version === 'string' && /^\d+\.\d+\.\d+$/.test(capture.runtime.version)
        && typeof capture.runtime.executableSha256 === 'string' && SHA256.test(capture.runtime.executableSha256)
        && typeof capture.startedAt === 'string' && validInstant(capture.startedAt)
        && typeof capture.finishedAt === 'string' && validInstant(capture.finishedAt)
        && capture.command !== null && typeof capture.command === 'object' && !Array.isArray(capture.command)
        && exactKeys(capture.command, ['stepIds', 'timeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes'])
        && Array.isArray(capture.command.stepIds) && capture.command.stepIds.length === 2
        && capture.command.stepIds.every((id) => typeof id === 'string')
        && Number.isSafeInteger(capture.command.timeoutMs) && capture.command.timeoutMs > 0 && capture.command.timeoutMs <= MAX_TIMEOUT_MS
        && Number.isSafeInteger(capture.command.stdoutLimitBytes) && capture.command.stdoutLimitBytes > 0 && capture.command.stdoutLimitBytes <= STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES * 2
        && Number.isSafeInteger(capture.command.stderrLimitBytes) && capture.command.stderrLimitBytes > 0 && capture.command.stderrLimitBytes <= STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES * 2
        && capture.observedBytes !== null && typeof capture.observedBytes === 'object' && !Array.isArray(capture.observedBytes)
        && exactKeys(capture.observedBytes, ['stdout', 'stderr'])
        && Number.isSafeInteger(capture.observedBytes.stdout) && capture.observedBytes.stdout >= 0
        && Number.isSafeInteger(capture.observedBytes.stderr) && capture.observedBytes.stderr >= 0
        && capture.observedBytes.stdout <= capture.command.stdoutLimitBytes
        && capture.observedBytes.stderr <= capture.command.stderrLimitBytes
        && typeof capture.processIdentity === 'string' && /^\d+ \d+$/.test(capture.processIdentity)
        && typeof capture.contentHash === 'string' && SHA256.test(capture.contentHash)
}

function validEvidence(value: unknown): value is CapturedRuntimeEvidence {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['state', 'artifact', 'schemaVersion', 'stackId', 'configSha256', 'runtime', 'observedAt', 'captureStartedAt', 'command', 'observedBytes', 'stability', 'evidenceSha256'])) return false
    const evidence = value as CapturedRuntimeEvidence
    if (evidence.runtime === null || typeof evidence.runtime !== 'object' || Array.isArray(evidence.runtime)
        || !exactKeys(evidence.runtime, ['name', 'version', 'executableSha256'])
        || typeof evidence.runtime.name !== 'string' || typeof evidence.runtime.version !== 'string'
        || typeof evidence.runtime.executableSha256 !== 'string'
        || evidence.command === null || typeof evidence.command !== 'object' || Array.isArray(evidence.command)
        || !exactKeys(evidence.command, ['batchId', 'containerId', 'stepIds', 'timeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes'])
        || typeof evidence.command.batchId !== 'string' || typeof evidence.command.containerId !== 'string'
        || !Array.isArray(evidence.command.stepIds) || evidence.command.stepIds.length !== 2
        || evidence.command.stepIds.some((id) => typeof id !== 'string')
        || evidence.observedBytes === null || typeof evidence.observedBytes !== 'object' || Array.isArray(evidence.observedBytes)
        || !exactKeys(evidence.observedBytes, ['stdout', 'stderr'])
        || evidence.stability === null || typeof evidence.stability !== 'object' || Array.isArray(evidence.stability)
        || !exactKeys(evidence.stability, ['processIdentitySha256', 'contentHash'])
        || typeof evidence.stability.processIdentitySha256 !== 'string' || typeof evidence.stability.contentHash !== 'string'
        || typeof evidence.state !== 'string' || typeof evidence.artifact !== 'string' || typeof evidence.schemaVersion !== 'number'
        || typeof evidence.stackId !== 'string' || typeof evidence.configSha256 !== 'string'
        || typeof evidence.observedAt !== 'string' || typeof evidence.captureStartedAt !== 'string'
        || typeof evidence.evidenceSha256 !== 'string') return false
    const core = {
        stackId: evidence.stackId, configSha256: evidence.configSha256, runtime: evidence.runtime,
        observedAt: evidence.observedAt, captureStartedAt: evidence.captureStartedAt,
        command: evidence.command, observedBytes: evidence.observedBytes,
        stability: evidence.stability,
    }
    return evidence.state === 'available' && evidence.artifact === 'captured-runtime-evidence' && evidence.schemaVersion === 1
        && STACK_ID.test(evidence.stackId) && SHA256.test(evidence.configSha256) && validInstant(evidence.observedAt)
        && validInstant(evidence.captureStartedAt) && instantMs(evidence.captureStartedAt) <= instantMs(evidence.observedAt)
        && evidence.runtime.name === 'docker' && /^\d+\.\d+\.\d+$/.test(evidence.runtime.version)
        && SHA256.test(evidence.runtime.executableSha256) && SHA256.test(evidence.command.batchId)
        && CONTAINER_ID.test(evidence.command.containerId)
        && evidence.command.stepIds.length === 2
        && evidence.command.stepIds[0] === `${PROCESS_STEP_PREFIX}${evidence.command.containerId}`
        && evidence.command.stepIds[1] === `${CONTENT_STEP_PREFIX}${evidence.command.containerId}`
        && Number.isSafeInteger(evidence.command.timeoutMs) && evidence.command.timeoutMs > 0 && evidence.command.timeoutMs <= MAX_TIMEOUT_MS
        && Number.isSafeInteger(evidence.command.stdoutLimitBytes) && evidence.command.stdoutLimitBytes > 0 && evidence.command.stdoutLimitBytes <= STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES * 2
        && Number.isSafeInteger(evidence.command.stderrLimitBytes) && evidence.command.stderrLimitBytes > 0 && evidence.command.stderrLimitBytes <= STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES * 2
        && Number.isSafeInteger(evidence.observedBytes.stdout) && evidence.observedBytes.stdout >= 0
        && Number.isSafeInteger(evidence.observedBytes.stderr) && evidence.observedBytes.stderr >= 0
        && evidence.observedBytes.stdout <= evidence.command.stdoutLimitBytes
        && evidence.observedBytes.stderr <= evidence.command.stderrLimitBytes
        && SHA256.test(evidence.stability.processIdentitySha256) && SHA256.test(evidence.stability.contentHash)
        && SHA256.test(evidence.evidenceSha256) && evidence.evidenceSha256 === digest(stableValue(core as unknown as JsonValue))
}

export function isRuntimeEvidenceAuthentic(rawEvidence: CapturedRuntimeEvidence): boolean {
    const evidence = ownedObject<CapturedRuntimeEvidence>(rawEvidence)
    return evidence !== undefined && validEvidence(evidence)
}
