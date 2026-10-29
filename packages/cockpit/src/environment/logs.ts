import { randomBytes } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { parseLocalDockerEndpoint } from './docker-endpoint.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, snapshotExecutionStep, snapshotJson, type ExecutionFailureCode, type ExecutionStep, type StackId } from './contract.js'
import { isRuntimeEvidenceAuthentic, type CapturedRuntimeEvidence } from './evidence.js'
import { consumeRuntimeServiceFailureForLogs, consumeRuntimeServiceObservationForFailureLogs, createRuntimeAdapter, type ComposeArtifact, type RuntimeAdapterAuthority, type RuntimeServiceFailureEvidence, type RuntimeServiceFailureLogContext, type RuntimeServiceObservation } from './runtime.js'
import { redactSensitiveMessage } from './sensitive.js'
import { isResolvedDockerExecutable, type ResolvedExecutable } from './executable.js'
import type { GeneratedComposeArtifactAuthority } from './generated-compose-authority.js'
import { inspectPortLeaseProjection, type PortLeaseProjection } from './ports.js'

export const mechanism = { id: 'runtime-logs', module: 'packages/cockpit/src/environment/logs.ts', exports: ['planLogs', 'collectLogs', 'planFailureLogs', 'admitFailureLogs'] } as const

export interface LogRequest {
    runtime: 'docker-compose'
    executable: ResolvedExecutable
    cwd: string
    stackId: StackId
    configSha256: string
    batchId: string
    containerId: string
    runtimeVersion: string
    composeVersion: string
    restartBatches?: readonly [string, string]
    projectName: string
    composeFiles: readonly ComposeArtifact[]
    services: readonly string[]
    service: string
    since: string
    tail: number
    follow: boolean
    timeoutMs: number
    outputLimitBytes: number
    env: Readonly<Record<string, string>>
}

export type LogPlan = { kind: 'planned'; step: ExecutionStep }
    | { kind: 'unavailable'; code: typeof ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE | typeof ENVIRONMENT_CODES.RUNTIME_UNMEASURED; reason: string }

const SERVICE = /^[a-z0-9][a-z0-9_.-]*$/
const RELATIVE_SINCE = /^\d+(?:\.\d+)?[smhd]$/
const SHA256 = /^[a-f0-9]{64}$/
const STACK_ID = /^stack:[a-f0-9]{64}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/
const issuedLogPlans = new WeakSet<object>()

function validInstant(value: string): boolean {
    const match = RFC3339.exec(value)
    if (match === null) return false
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
    if (Number.isNaN(calendar.valueOf()) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month
        || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute
        || calendar.getUTCSeconds() !== second) return false
    if (match[8] !== 'Z') {
        const offsetHour = Number(match[10]); const offsetMinute = Number(match[11])
        if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false
    }
    return Number.isFinite(Date.parse(value))
}

function exactKeys(value: object, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const keys = [...expected].sort()
    return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function captureOwnValues(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, keys)) return undefined
        const captured: Record<string, unknown> = {}
        for (const key of keys) captured[key] = (value as Record<string, unknown>)[key]
        return Object.freeze(captured)
    } catch {
        return undefined
    }
}

function stringRecord(value: unknown): value is Readonly<Record<string, string>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.entries(value).every(([name, item]) => name.length > 0 && typeof item === 'string')
}

function logRequest(value: unknown): LogRequest | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const input = value as Partial<LogRequest>
    const keys = ['runtime', 'executable', 'cwd', 'stackId', 'configSha256', 'batchId', 'containerId', 'runtimeVersion', 'composeVersion',
        'projectName', 'composeFiles', 'services', 'service', 'since', 'tail', 'follow', 'timeoutMs', 'outputLimitBytes', 'env']
    if (!exactKeys(value, input.restartBatches === undefined ? keys : [...keys, 'restartBatches'])
        || !isResolvedDockerExecutable(input.executable) || typeof input.runtime !== 'string' || typeof input.cwd !== 'string'
        || typeof input.stackId !== 'string' || typeof input.configSha256 !== 'string' || typeof input.batchId !== 'string'
        || typeof input.containerId !== 'string' || typeof input.runtimeVersion !== 'string' || typeof input.composeVersion !== 'string'
        || typeof input.projectName !== 'string' || typeof input.service !== 'string' || typeof input.since !== 'string'
        || typeof input.tail !== 'number' || typeof input.follow !== 'boolean' || typeof input.timeoutMs !== 'number'
        || typeof input.outputLimitBytes !== 'number' || !stringRecord(input.env) || !Array.isArray(input.services)
        || input.services.some((service) => typeof service !== 'string') || !Array.isArray(input.composeFiles)
        || input.composeFiles.some((artifact) => artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)
            || !exactKeys(artifact, ['reference', 'canonicalPath', 'source', 'sha256'])
            || Object.values(artifact).some((part) => typeof part !== 'string'))
        || (input.restartBatches !== undefined && (!Array.isArray(input.restartBatches) || input.restartBatches.length !== 2
            || input.restartBatches.some((batch) => typeof batch !== 'string')))) return undefined
    return input as LogRequest
}

// Logs must read the daemon the lifecycle started, so they accept the same local selection: a named
// context, Unix socket or local Windows named pipe. TLS and remote endpoints stay refused.
function localDockerSelection(name: string, value: string): boolean {
    return name === 'DOCKER_HOST' ? parseLocalDockerEndpoint(value) !== undefined
        : name === 'DOCKER_CONTEXT' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)
}

export function planLogs(
    rawInput: LogRequest,
    generatedComposeAuthority?: GeneratedComposeArtifactAuthority,
    ownComposeAuthority?: Extract<RuntimeAdapterAuthority, { ownComposeFiles: true }>,
): LogPlan {
    const input = logRequest(snapshotJson(rawInput))
    if (input === undefined) return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'log request must be readable JSON data' }
    if (input.runtime !== 'docker-compose') return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, reason: 'runtime does not expose a measured log adapter' }
    if (!STACK_ID.test(input.stackId) || !SHA256.test(input.configSha256) || !SERVICE.test(input.projectName) || !SERVICE.test(input.service) || !input.services.includes(input.service) || input.services.some((service) => !SERVICE.test(service)) || !(RELATIVE_SINCE.test(input.since) || validInstant(input.since)) || !isAbsolute(input.cwd)
        || !isResolvedDockerExecutable(input.executable)
        || !SHA256.test(input.batchId) || !SERVICE.test(input.containerId) || !/^\d+\.\d+\.\d+$/.test(input.runtimeVersion) || !/^\d+\.\d+\.\d+$/.test(input.composeVersion)
        || (input.restartBatches !== undefined && (input.restartBatches.length !== 2 || input.restartBatches.some((batch) => !SHA256.test(batch)) || input.restartBatches[0] === input.restartBatches[1]))
        || !Number.isInteger(input.tail) || input.tail < 1 || input.tail > 10_000
        || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 300_000
        || !Number.isInteger(input.outputLimitBytes) || input.outputLimitBytes <= 0 || input.outputLimitBytes > 16_777_216
        || input.composeFiles.length === 0
        || Object.entries(input.env).some(([name, value]) => name.startsWith('COMPOSE_') || name.includes('\0') || value.includes('\0')
            || name.startsWith('DOCKER_') && !localDockerSelection(name, value))) {
        return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'log request must be resolved and bounded' }
    }
    if (generatedComposeAuthority !== undefined && ownComposeAuthority !== undefined) {
        return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'log request has conflicting compose authority' }
    }
    let suppliedPortProjection: PortLeaseProjection | undefined
    try {
        const descriptor = ownComposeAuthority === undefined
            ? undefined : Object.getOwnPropertyDescriptor(ownComposeAuthority, 'portLeaseProjection')
        if (descriptor && !('value' in descriptor)) {
            return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'compose-first log port authority is malformed' }
        }
        suppliedPortProjection = descriptor?.value as PortLeaseProjection | undefined
    } catch {
        return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'compose-first log port authority is malformed' }
    }
    const portProjection = suppliedPortProjection === undefined ? undefined : inspectPortLeaseProjection(suppliedPortProjection)
    if (suppliedPortProjection !== undefined && portProjection === undefined) {
        return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'compose-first log port authority is malformed' }
    }
    const projectedPorts = portProjection ? Object.values(portProjection.lease.ports) : []
    const composeBoundary = createRuntimeAdapter({
        runtime: { name: 'docker', version: input.runtimeVersion, executableSha256: input.executable.sha256 },
        composeVersion: input.composeVersion, executable: input.executable, operation: 'validate', cwd: input.cwd,
        composeFiles: input.composeFiles, projectName: input.projectName, env: input.env, ports: projectedPorts,
        labels: generatedComposeAuthority ? { configSha256: input.configSha256 } : {}, timeoutMs: input.timeoutMs,
    }, generatedComposeAuthority ? { generatedComposeAuthority } : ownComposeAuthority)
    if (composeBoundary.kind === 'refusal') return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: composeBoundary.diagnostics[0].message }
    const argv = [input.executable.canonicalPath, 'container', 'logs', '--timestamps', '--since', input.since, '--tail', String(input.tail), ...(input.follow ? ['--follow'] : []), input.containerId] as [string, ...string[]]
    const step: ExecutionStep = Object.freeze({
        id: `runtime:logs:${input.projectName}:${input.service}`, argv: Object.freeze(argv) as readonly [string, ...string[]], argv0: input.executable.invocationPath, cwd: input.cwd,
        env: Object.freeze({ ...input.env }), timeoutMs: input.timeoutMs, stdoutLimitBytes: input.outputLimitBytes,
        stderrLimitBytes: Math.min(input.outputLimitBytes, 65_536), paths: Object.freeze([]), ports: Object.freeze([]),
        labels: Object.freeze({ stackId: input.stackId, configSha256: input.configSha256, batchId: input.batchId, containerId: input.containerId, service: input.service, since: input.since, runtimeVersion: input.runtimeVersion, executableSha256: input.executable.sha256, ...(input.restartBatches === undefined ? {} : { restartBeforeBatch: input.restartBatches[0], restartAfterBatch: input.restartBatches[1] }) }), expected: Object.freeze([]),
        consumedFiles: Object.freeze([
            Object.freeze({ path: input.executable.canonicalPath, sha256: input.executable.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: input.executable.executionMode }),
        ]),
        filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    })
    const resolvedStep = snapshotExecutionStep(step)
    if (resolvedStep === undefined) return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason: 'log request did not produce a valid execution plan' }
    const plan = Object.freeze({ kind: 'planned' as const, step: resolvedStep })
    issuedLogPlans.add(plan)
    return plan
}

export interface FailureLogRequest {
    readonly evidence: RuntimeServiceObservation | RuntimeServiceFailureEvidence
    readonly tail: number
    readonly timeoutMs: number
    readonly outputLimitBytes: number
}

export type FailureLogPlan = { readonly kind: 'planned'; readonly step: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly reason: string }

interface FailureLogContract {
    readonly evidence: RuntimeServiceObservation | RuntimeServiceFailureLogContext
    readonly step: ExecutionStep
    readonly early: boolean
}

const issuedFailureLogPlans = new WeakMap<object, FailureLogContract>()
const consumedFailureLogPlans = new WeakSet<object>()

function unavailableFailurePlan(): FailureLogPlan {
    return Object.freeze({ kind: 'unavailable', reason: 'failure logs are unavailable' })
}

function composeFailurePrefix(context: RuntimeServiceFailureLogContext): readonly string[] | undefined {
    const prefix = context.composeArgvPrefix
    if (!Array.isArray(prefix) || prefix.length < 7 || prefix[0] !== 'compose'
        || prefix[1] !== '--project-directory' || prefix[2] !== context.cwd
        || prefix.at(-2) !== '--project-name' || prefix.at(-1) !== context.projectName) return undefined
    const fileArgs = prefix.slice(3, -2)
    if (fileArgs.length !== context.paths.length * 2) return undefined
    for (let index = 0; index < context.paths.length; index++) {
        if (fileArgs[index * 2] !== '--file' || fileArgs[index * 2 + 1] !== context.paths[index]) return undefined
    }
    return prefix
}

export function planFailureLogs(input: FailureLogRequest): FailureLogPlan {
    try {
        const captured = captureOwnValues(input, ['evidence', 'tail', 'timeoutMs', 'outputLimitBytes'])
        const evidenceInput = captured?.evidence as RuntimeServiceObservation | RuntimeServiceFailureEvidence | undefined
        const tail = captured?.tail
        const timeoutMs = captured?.timeoutMs
        const outputLimitBytes = captured?.outputLimitBytes
        if (!Number.isInteger(tail) || (tail as number) < 0 || (tail as number) > 100_000
            || !Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > 300_000
            || !Number.isInteger(outputLimitBytes) || (outputLimitBytes as number) <= 0 || (outputLimitBytes as number) > 16_777_216) {
            return unavailableFailurePlan()
        }
        const failureContext = evidenceInput ? consumeRuntimeServiceFailureForLogs(evidenceInput as RuntimeServiceFailureEvidence) : undefined
        const observationContext = failureContext || !evidenceInput
            ? undefined
            : consumeRuntimeServiceObservationForFailureLogs(evidenceInput as RuntimeServiceObservation)
        const context = failureContext ?? observationContext
        if (!context) return unavailableFailurePlan()
        const evidence = failureContext ?? observationContext!.observation
        const containerId = evidence.containerId
        const composePrefix = failureContext && containerId === null ? composeFailurePrefix(failureContext) : undefined
        if (failureContext && containerId === null && !composePrefix) return unavailableFailurePlan()
        const argv = Object.freeze(containerId === null ? [
            context.executable.canonicalPath,
            ...composePrefix!,
            'logs',
            '--no-color',
            '--no-log-prefix',
            '--timestamps',
            '--since',
            evidence.observationWindow.startedAt,
            '--until',
            evidence.observationWindow.expiresAt,
            '--tail',
            String(tail),
            '--follow=false',
            '--',
            evidence.service,
        ] : [
            context.executable.canonicalPath,
            'container',
            'logs',
            '--follow=false',
            '--timestamps',
            '--since',
            evidence.observationWindow.startedAt,
            '--until',
            evidence.observationWindow.expiresAt,
            '--tail',
            String(tail),
            evidence.containerId,
        ]) as readonly [string, ...string[]]
        const executableConsumedFile = Object.freeze({
            path: context.executable.canonicalPath,
            sha256: context.executable.sha256,
            maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]),
            executable: true,
            executionMode: context.executable.executionMode,
        })
        const inheritedConsumedFiles = failureContext && containerId === null
            ? failureContext.consumedFiles
            : Object.freeze([])
        const consumedFiles = inheritedConsumedFiles.some(({ path }) => path === context.executable.canonicalPath)
            ? inheritedConsumedFiles
            : Object.freeze([executableConsumedFile, ...inheritedConsumedFiles])
        const step = snapshotExecutionStep(Object.freeze({
            id: `runtime:failure-logs:${containerId ?? `${evidence.projectName}:${evidence.service}`}`,
            argv,
            argv0: context.executable.invocationPath,
            cwd: context.cwd,
            env: context.env,
            timeoutMs: timeoutMs as number,
            stdoutLimitBytes: outputLimitBytes as number,
            stderrLimitBytes: Math.min(outputLimitBytes as number, 65_536),
            paths: failureContext && containerId === null ? failureContext.paths : Object.freeze([]),
            ports: Object.freeze([]),
            labels: Object.freeze({
                stackId: evidence.stackId,
                configSha256: evidence.configSha256,
                batchId: evidence.batchId,
                ...(containerId === null ? {} : { containerId }),
                service: evidence.service,
                runtimeVersion: evidence.runtimeVersion,
                composeVersion: evidence.composeVersion,
                executableSha256: evidence.executableSha256,
                projectName: evidence.projectName,
                since: evidence.observationWindow.startedAt,
                until: evidence.observationWindow.expiresAt,
                follow: 'false',
                issuanceId: randomBytes(32).toString('hex'),
            }),
            expected: Object.freeze([]),
            consumedFiles,
            filesystemChecks: failureContext && containerId === null ? failureContext.filesystemChecks : Object.freeze([]),
            compensation: Object.freeze([]),
        }))
        if (!step) return unavailableFailurePlan()
        const plan = Object.freeze({ kind: 'planned' as const, step })
        issuedFailureLogPlans.set(plan, Object.freeze({ evidence, step, early: failureContext !== undefined }))
        return plan
    } catch {
        return unavailableFailurePlan()
    }
}

export type LogExecution = ExecuteProbeOutcome
export type LogRecord = Readonly<{
    stackId: StackId
    configSha256: string
    batchId: string
    containerId: string
    service: string
    runtimeVersion: string
    executableSha256: string
    timestamp: string
    message: string
    stream: 'stdout' | 'stderr'
    restart: boolean
}>

export type EarlyFailureLogRecord = Readonly<Omit<LogRecord, 'containerId'> & { containerId: null }>
export type FailureLogRecord = LogRecord | EarlyFailureLogRecord

export type FailureLogAdmission =
    | { readonly kind: 'complete'; readonly records: readonly FailureLogRecord[] }
    | { readonly kind: 'unavailable'; readonly records: readonly FailureLogRecord[] }
    | { readonly kind: 'unavailable'; readonly code: ExecutionFailureCode; readonly service: string; readonly records: readonly FailureLogRecord[] }

export function admitFailureLogs(input: {
    readonly plan: FailureLogPlan
    readonly outcome: ExecuteProbeOutcome
}): FailureLogAdmission {
    const unavailable = () => Object.freeze({ kind: 'unavailable' as const, records: Object.freeze([]) as readonly FailureLogRecord[] })
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as FailureLogPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (!plan || plan.kind !== 'planned' || consumedFailureLogPlans.has(plan)) return unavailable()
        const contract = issuedFailureLogPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, contract.step) : undefined
        if (!contract || !outcome) return unavailable()
        consumedFailureLogPlans.add(plan)
        if (outcome.kind !== 'complete') {
            if (contract.early) return Object.freeze({
                kind: 'unavailable' as const,
                code: outcome.code,
                service: contract.evidence.service,
                records: Object.freeze([]) as readonly FailureLogRecord[],
            })
            return unavailable()
        }
        if (outcome.stdout.byteLength + outcome.stderr.byteLength > contract.step.stdoutLimitBytes) return unavailable()
        const windowStart = Date.parse(contract.evidence.observationWindow.startedAt)
        const windowEnd = Date.parse(contract.evidence.observationWindow.expiresAt)
        const windowStartNanoseconds = instantNanoseconds(contract.evidence.observationWindow.startedAt)
        const windowEndNanoseconds = instantNanoseconds(contract.evidence.observationWindow.expiresAt)
        const receiptStart = Date.parse(outcome.receipt.startedAt)
        const receiptEnd = Date.parse(outcome.receipt.finishedAt)
        const now = Date.now()
        if (!validInstant(outcome.receipt.startedAt) || !validInstant(outcome.receipt.finishedAt)
            || windowStart > receiptStart || receiptStart > receiptEnd || receiptEnd > now || receiptEnd > windowEnd
            || now < windowStart || now > windowEnd) return unavailable()
        const records: FailureLogRecord[] = []
        for (const [stream, output] of [['stdout', outcome.stdout], ['stderr', outcome.stderr]] as const) {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(output)
            for (const line of text.split('\n').filter(Boolean)) {
                const match = line.match(/^(\S+)\s+(.*)$/)
                if (!match || !validInstant(match[1])) return unavailable()
                const timestamp = instantNanoseconds(match[1])
                if (timestamp < windowStartNanoseconds || timestamp > windowEndNanoseconds) return unavailable()
                const message = redactSensitiveMessage(match[2])
                if (message === undefined) return unavailable()
                records.push(Object.freeze({
                    stackId: contract.evidence.stackId,
                    configSha256: contract.evidence.configSha256,
                    batchId: contract.evidence.batchId,
                    containerId: contract.evidence.containerId,
                    service: contract.evidence.service,
                    runtimeVersion: contract.evidence.runtimeVersion,
                    executableSha256: contract.evidence.executableSha256,
                    timestamp: match[1],
                    message,
                    stream,
                    restart: false,
                }))
            }
        }
        records.sort((left, right) => compareInstants(left.timestamp, right.timestamp)
            || (left.stream === right.stream ? 0 : left.stream === 'stdout' ? -1 : 1))
        return Object.freeze({ kind: 'complete', records: Object.freeze(records) })
    } catch {
        return unavailable()
    }
}

export interface RestartWindow { readonly before: CapturedRuntimeEvidence; readonly after: CapturedRuntimeEvidence }

function instantMs(value: string): number { return Date.parse(value) }

function instantNanoseconds(value: string): bigint {
    const match = RFC3339.exec(value)
    if (match === null) throw new TypeError('invalid timestamp')
    const baseMilliseconds = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
    if (!Number.isFinite(baseMilliseconds)) throw new TypeError('invalid timestamp')
    const fraction = BigInt((match[7] ?? '').padEnd(9, '0') || '0')
    const offsetMagnitude = match[8] === 'Z' ? 0n : BigInt((Number(match[10]) * 60 + Number(match[11])) * 60)
    const offsetSeconds = match[9] === '-' ? -offsetMagnitude : offsetMagnitude
    return (BigInt(baseMilliseconds / 1_000) - offsetSeconds) * 1_000_000_000n + fraction
}

function compareInstants(left: string, right: string): number {
    const leftNanoseconds = instantNanoseconds(left)
    const rightNanoseconds = instantNanoseconds(right)
    return leftNanoseconds < rightNanoseconds ? -1 : leftNanoseconds > rightNanoseconds ? 1 : 0
}

function ownedRestartWindow(value: unknown): RestartWindow | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || !exactKeys(snapshot, ['before', 'after'])) return undefined
    const candidate = snapshot as unknown as Partial<RestartWindow>
    return candidate.before !== null && typeof candidate.before === 'object'
        && candidate.after !== null && typeof candidate.after === 'object'
        ? candidate as RestartWindow : undefined
}

function ownedLogPlan(value: unknown): Extract<LogPlan, { kind: 'planned' }> | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const plan = snapshot as unknown as Extract<LogPlan, { kind: 'planned' }>
    const labels = plan.step?.labels
    if (plan.kind !== 'planned' || labels === undefined || !STACK_ID.test(labels.stackId ?? '')
        || !SHA256.test(labels.configSha256 ?? '') || !SHA256.test(labels.batchId ?? '')
        || !SERVICE.test(labels.containerId ?? '') || !SERVICE.test(labels.service ?? '')
        || !(RELATIVE_SINCE.test(labels.since ?? '') || validInstant(labels.since ?? '')) || !/^\d+\.\d+\.\d+$/.test(labels.runtimeVersion ?? '')
        || !SHA256.test(labels.executableSha256 ?? '')
        || ((labels.restartBeforeBatch === undefined) !== (labels.restartAfterBatch === undefined))
        || (labels.restartBeforeBatch !== undefined && (!SHA256.test(labels.restartBeforeBatch)
            || !SHA256.test(labels.restartAfterBatch ?? '') || labels.restartBeforeBatch === labels.restartAfterBatch))) return undefined
    return plan
}

export async function collectLogs(plan: Extract<LogPlan, { kind: 'planned' }>, execute: (step: ExecutionStep, options: { signal?: AbortSignal }) => Promise<LogExecution>, signal?: AbortSignal, restart?: RestartWindow) {
    const resolvedPlan = ownedLogPlan(plan)
    if (resolvedPlan === undefined || !issuedLogPlans.has(plan)) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
    const resolvedRestart = restart === undefined ? undefined : ownedRestartWindow(restart)
    if (restart !== undefined && resolvedRestart === undefined) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
    let rawOutcome: unknown
    try { rawOutcome = await execute(resolvedPlan.step, { signal }) } catch {
        return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
    }
    const outcome = authenticatedExecutionOutcome(rawOutcome, resolvedPlan.step)
    const authority = resolvedPlan.step.labels
    const restartBatches = authority.restartBeforeBatch === undefined ? undefined : [authority.restartBeforeBatch, authority.restartAfterBatch] as const
    if (outcome === undefined) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
    const cancelled = outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_ABORTED
    if (outcome.kind === 'refusal' && !cancelled) return { kind: 'unavailable' as const, code: outcome.code, records: Object.freeze([]) }
    if (cancelled && !outcome.execution.started) return { kind: 'cancelled' as const, records: Object.freeze([]) }
    if (outcome.stdout.byteLength > resolvedPlan.step.stdoutLimitBytes) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT, records: Object.freeze([]) }
    if (outcome.stderr.byteLength > resolvedPlan.step.stderrLimitBytes) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.EXECUTION_STDERR_LIMIT, records: Object.freeze([]) }
    if (!outcome.receipt || outcome.receipt.stepId !== resolvedPlan.step.id
        || !validInstant(outcome.receipt.startedAt) || !validInstant(outcome.receipt.finishedAt)
        || instantMs(outcome.receipt.startedAt) > instantMs(outcome.receipt.finishedAt)) {
        return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
    }
    const records: LogRecord[] = []
    for (const [stream, output] of [['stdout', outcome.stdout], ['stderr', outcome.stderr]] as const) {
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(output) } catch { return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) } }
        for (const line of text.split('\n').filter(Boolean)) {
            const match = line.match(/^(\S+)\s+(.*)$/)
            if (match === null || !validInstant(match[1])) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
            const message = redactSensitiveMessage(match[2])
            if (message === undefined) return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
            records.push(Object.freeze({
                stackId: authority.stackId as StackId, configSha256: authority.configSha256,
                batchId: authority.batchId, containerId: authority.containerId,
                service: authority.service, runtimeVersion: authority.runtimeVersion,
                executableSha256: authority.executableSha256,
                timestamp: match[1], message, restart: false, stream,
            }))
        }
    }
    if (resolvedRestart !== undefined) {
        const { before, after } = resolvedRestart
        if (restartBatches === undefined || !isRuntimeEvidenceAuthentic(before) || !isRuntimeEvidenceAuthentic(after)
            || before.stackId !== authority.stackId || after.stackId !== authority.stackId
            || before.configSha256 !== authority.configSha256 || after.configSha256 !== authority.configSha256
            || before.command.containerId !== authority.containerId || after.command.containerId !== authority.containerId
            || before.runtime.name !== 'docker' || after.runtime.name !== 'docker'
            || before.runtime.version !== authority.runtimeVersion || after.runtime.version !== authority.runtimeVersion
            || before.runtime.executableSha256 !== authority.executableSha256 || after.runtime.executableSha256 !== authority.executableSha256
            || before.command.batchId !== restartBatches[0] || after.command.batchId !== restartBatches[1]
            || before.command.batchId === after.command.batchId || instantMs(before.observedAt) > instantMs(outcome.receipt.startedAt)
            || instantMs(outcome.receipt.finishedAt) > instantMs(after.captureStartedAt)) {
            return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
        }
        if (before.stability.processIdentitySha256 !== after.stability.processIdentitySha256) {
            records.push(Object.freeze({
                stackId: authority.stackId as StackId, configSha256: authority.configSha256,
                batchId: authority.batchId, containerId: authority.containerId,
                service: authority.service, runtimeVersion: authority.runtimeVersion,
                executableSha256: authority.executableSha256,
                timestamp: after.observedAt, message: 'runtime restart observed', stream: 'stdout', restart: true,
            }))
        }
    }
    if (resolvedRestart === undefined && restartBatches !== undefined) {
        return { kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, records: Object.freeze([]) }
    }
    records.sort((left, right) => compareInstants(left.timestamp, right.timestamp)
        || (left.stream === right.stream ? 0 : left.stream === 'stdout' ? -1 : 1))
    return { kind: cancelled ? 'cancelled' as const : 'complete' as const, records: Object.freeze(records) }
}
