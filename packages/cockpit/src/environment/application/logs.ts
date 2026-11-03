import type { ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import { ENVIRONMENT_CODES, errorCause, type EnvironmentCommandOutcome, type EnvironmentDiagnostic, type ExecutionStep } from '../contract.js'
import { DeclarationRefusalError } from '../declaration.js'
import type { RuntimeAdapterAuthority } from '../runtime.js'
import { collectLogs, planLogs, type LogRecord, type LogRequest, type RestartWindow } from '../logs.js'
import { applicationDiagnostic } from './health.js'
import { ownDataValues } from './shared.js'

export interface LogsCommandInput {
    readonly configPath: string
    readonly service: string
    readonly since: string
    readonly tail: number
    readonly follow: boolean
    readonly json: boolean
}

export type LogRequestBase = Omit<LogRequest, 'since' | 'tail' | 'follow'>

export interface LogObservation {
    readonly ownComposeAuthority?: Extract<RuntimeAdapterAuthority, { ownComposeFiles: true }>
    readonly request: LogRequestBase
    readonly restart?: RestartWindow
}

export interface LogsCommandAdapters {
    readonly observe: (input: {
        readonly configPath: string
        readonly service: string
    }) => Promise<LogObservation>
    readonly execute: (
        step: ExecutionStep,
        options: { readonly signal?: AbortSignal },
    ) => Promise<ExecuteProbeOutcome>
    readonly signal?: AbortSignal
}

export type LogsCommandResult = EnvironmentCommandOutcome<Readonly<{
    readonly json: boolean
    readonly records: readonly LogRecord[]
    readonly truncated: boolean
}>> | Readonly<{
    kind: 'cancelled'
    status: 130
    diagnostics: readonly EnvironmentDiagnostic[]
    result: Readonly<{ json: boolean; records: readonly LogRecord[]; truncated: boolean }>
}>

function logsRefusal(code: EnvironmentDiagnostic['code'], message: string): Extract<LogsCommandResult, { kind: 'refusal' }> {
    return {
        kind: 'refusal', status: 2, result: null,
        diagnostics: [applicationDiagnostic(code, message, 'logs')],
    }
}

const logRequestBaseKeys = Object.freeze([
    'runtime', 'executable', 'cwd', 'stackId', 'configSha256', 'batchId', 'containerId',
    'runtimeVersion', 'composeVersion', 'projectName', 'composeFiles', 'services', 'service',
    'timeoutMs', 'outputLimitBytes', 'env',
] as const)
const logService = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const relativeLogSince = /^\d+(?:\.\d+)?[smhd]$/
const absoluteLogSince = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/

function validAbsoluteLogSince(value: string): boolean {
    const match = absoluteLogSince.exec(value)
    if (!match) return false
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
    if (Number.isNaN(calendar.valueOf()) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month
        || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute
        || calendar.getUTCSeconds() !== second) return false
    const offsetHour = match[8] === 'Z' ? 0 : Number(match[10])
    const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11])
    return offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0)
        && Number.isFinite(Date.parse(value))
}

function validPublicLogOptions(service: string, since: string, tail: number): boolean {
    return logService.test(service) && since.length <= 64
        && (relativeLogSince.test(since) || validAbsoluteLogSince(since))
        && Number.isInteger(tail) && tail >= 1 && tail <= 10_000
}

function logsCancelled(json: boolean): Extract<LogsCommandResult, { kind: 'cancelled' }> {
    return {
        kind: 'cancelled', status: 130, diagnostics: [],
        result: { json, records: [], truncated: false },
    }
}

function logsTruncated(service: string, shown: number, step: ExecutionStep): readonly EnvironmentDiagnostic[] {
    return [{
        severity: 'warning' as const,
        code: 'LOGS_TRUNCATED' as const satisfies typeof ENVIRONMENT_CODES.LOGS_TRUNCATED,
        message: `the logs of service ${service} exceeded the output limit of ${step.stdoutLimitBytes} bytes of stdout and ${step.stderrLimitBytes} of stderr, so only the newest ${shown} record${shown === 1 ? '' : 's'} are shown and older records in the requested range are not`,
        target: 'logs',
        fix: 'lower --tail to the number of recent records you need, or read the older records from the container runtime directly',
    }]
}

export async function runLogs(
    input: LogsCommandInput,
    adapters: LogsCommandAdapters,
): Promise<LogsCommandResult> {
    let captured: Readonly<Record<string, unknown>> | undefined
    let signal: AbortSignal | undefined
    let observe: LogsCommandAdapters['observe']
    let execute: LogsCommandAdapters['execute']
    try {
        captured = ownDataValues(input, ['configPath', 'service', 'since', 'tail', 'follow', 'json'])
        signal = adapters.signal
        observe = adapters.observe
        execute = adapters.execute
    } catch (error) {
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `log request must be readable: ${errorCause(error)}`)
    }
    const configPath = captured?.configPath
    const service = captured?.service
    const since = captured?.since
    const tail = captured?.tail
    const follow = captured?.follow
    const json = captured?.json
    if (typeof configPath !== 'string' || typeof service !== 'string' || typeof since !== 'string'
        || typeof tail !== 'number' || typeof follow !== 'boolean' || typeof json !== 'boolean'
        || typeof observe !== 'function' || typeof execute !== 'function') {
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, 'log request must contain exact public options')
    }
    if (!validPublicLogOptions(service, since, tail)) {
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, 'log service, time range, and tail must be valid and bounded')
    }
    if (follow && signal === undefined) {
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, 'follow logs require a cancellation signal')
    }
    if (signal?.aborted) return logsCancelled(json)
    let observation: LogObservation
    try {
        observation = await observe({ configPath, service })
    } catch (error) {
        if (signal?.aborted) return logsCancelled(json)
        if (error instanceof DeclarationRefusalError) return { kind: 'refusal', status: 2, result: null,
            diagnostics: [error.diagnostic] }
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `log observation is unavailable for service ${service}: ${errorCause(error)}`)
    }
    if (signal?.aborted) return logsCancelled(json)
    const observed = ownDataValues(observation, ['request'], ['restart', 'ownComposeAuthority'])
    const request = ownDataValues(observed?.request, logRequestBaseKeys, ['restartBatches'])
    if (!request || request.service !== service) {
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `log observation does not match service ${service}`)
    }
    const resolvedRequest = { ...request, since, tail, follow } as unknown as LogRequest
    const plan = planLogs(
        resolvedRequest,
        observed?.ownComposeAuthority as Extract<RuntimeAdapterAuthority, { ownComposeFiles: true }> | undefined,
    )
    if (plan.kind !== 'planned') return logsRefusal(plan.code, plan.reason)
    let collected: Awaited<ReturnType<typeof collectLogs>>
    try {
        collected = await collectLogs(plan, execute, signal, observed?.restart as RestartWindow | undefined)
    } catch (error) {
        return logsRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `log collection failed for service ${service}: ${errorCause(error)}`)
    }
    if (collected.kind === 'unavailable') {
        return logsRefusal(collected.code, `the logs of service ${service} are unavailable: ${collected.reason}`)
    }
    const diagnostics = collected.truncated
        ? logsTruncated(service, collected.records.length, plan.step) : []
    const result = { json, records: collected.records, truncated: collected.truncated }
    if (collected.kind === 'cancelled') return { kind: 'cancelled', status: 130, diagnostics, result }
    return { kind: 'complete', status: 0, diagnostics, result }
}
