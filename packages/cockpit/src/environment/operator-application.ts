import { ENVIRONMENT_CODES, type Diagnostic } from './contract.js'
import { EXIT_CODES } from '../invocation.js'
import type {
    ResetCommandInput,
} from './application.js'
import type {
    GeneratedEnvironmentCommandInput,
    GeneratedEnvironmentSyncInput,
    GeneratedStaleRemovalApproval,
    GeneratedStaleRemovalApprovalRequest,
} from './generated-application.js'

export const mechanism = {
    id: 'environment-operator-application',
    module: 'packages/cockpit/src/environment/operator-application.ts',
    exports: ['runResetOperatorApplication', 'runSyncOperatorApplication'],
} as const

export interface OperatorAdmission {
    readonly interactive: boolean
    readonly json: boolean
    readonly ci: string | undefined
    readonly terminal: boolean
}

export interface OperatorCommandOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

export interface OperatorSession {
    readonly preview: OperatorCommandOutcome
    decide(decision: 'approve' | 'decline'): Promise<OperatorCommandOutcome>
}

export interface ResetOperatorApplicationAdapters {
    readonly preview: (input: ResetCommandInput) => Promise<OperatorCommandOutcome>
    readonly begin: (input: ResetCommandInput) => Promise<OperatorSession | OperatorCommandOutcome>
    readonly confirm: (preview: OperatorCommandOutcome) => Promise<boolean>
}

export type GeneratedEnvironmentSyncHandlerInput = GeneratedEnvironmentSyncInput & Readonly<{
    authorizeStaleRemoval?: (
        request: GeneratedStaleRemovalApprovalRequest,
    ) => Promise<GeneratedStaleRemovalApproval | undefined>
}>

export interface SyncOperatorApplicationAdapters {
    readonly synchronize: (input: GeneratedEnvironmentSyncHandlerInput) => Promise<OperatorCommandOutcome>
    readonly confirmStaleRemoval: (request: GeneratedStaleRemovalApprovalRequest) => Promise<string | undefined>
}

function refusal(
    code: string,
    message: string,
    target: string,
): OperatorCommandOutcome {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error' as const, code, message, target })]),
    })
}

export async function runResetOperatorApplication(
    input: ResetCommandInput,
    admission: OperatorAdmission,
    adapters: ResetOperatorApplicationAdapters,
): Promise<OperatorCommandOutcome> {
    if (!admission.interactive) return adapters.preview(input)
    if (admission.json || admission.ci && admission.ci.length > 0) {
        return refusal(
            ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
            'interactive reset requires a human terminal outside CI and JSON modes',
            'reset',
        )
    }
    if (!admission.terminal) {
        return refusal(
            ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
            'interactive reset requires terminal input',
            'reset',
        )
    }
    const opened = await adapters.begin(input)
    if (!('decide' in opened)) return opened
    const approved = await adapters.confirm(opened.preview)
    if (approved) return opened.decide('approve')
    await opened.decide('decline')
    return { status: EXIT_CODES.cancelled, diagnostics: [], result: null }
}

function staleRemovalRefusal(message: string): OperatorCommandOutcome {
    return refusal('GENERATED_STALE_APPROVAL_REQUIRED', message, 'generated-environment')
}

function previewedStaleRemoval(outcome: OperatorCommandOutcome):
    | Readonly<{ state: 'none' }>
    | Readonly<{ state: 'invalid' }>
    | Readonly<{ state: 'stale'; request: GeneratedStaleRemovalApprovalRequest }> {
    if (outcome.status !== 0 || !outcome.result || typeof outcome.result !== 'object') return { state: 'invalid' }
    const result = outcome.result as Record<string, unknown>
    if (result.dryRun !== true) return { state: 'invalid' }
    if (!Object.hasOwn(result, 'staleRemoval')) return { state: 'none' }
    const candidate = result.staleRemoval
    if (!candidate || typeof candidate !== 'object') return { state: 'invalid' }
    const request = candidate as Record<string, unknown>
    if (request.format !== 'cockpit-stale-removal-request/v1'
        || typeof request.cockpitId !== 'string' || request.cockpitId.length === 0
        || typeof request.generation !== 'string' || request.generation.length === 0
        || typeof request.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.sourceSha256)
        || typeof request.digest !== 'string' || !/^[a-f0-9]{64}$/.test(request.digest)
        || !Array.isArray(request.entries) || request.entries.length === 0) return { state: 'invalid' }
    return { state: 'stale', request: candidate as GeneratedStaleRemovalApprovalRequest }
}

export async function runSyncOperatorApplication(
    input: GeneratedEnvironmentCommandInput,
    admission: OperatorAdmission,
    adapters: SyncOperatorApplicationAdapters,
): Promise<OperatorCommandOutcome> {
    if (!admission.interactive) return adapters.synchronize(input)
    if (admission.json || admission.ci && admission.ci.length > 0) {
        return staleRemovalRefusal('interactive sync requires a human terminal outside CI and JSON modes')
    }
    if (!admission.terminal) {
        return staleRemovalRefusal('interactive sync requires terminal input')
    }
    const preview = await adapters.synchronize({ ...input, dryRun: true })
    if (preview.status !== 0) return preview
    const inspected = previewedStaleRemoval(preview)
    if (inspected.state === 'invalid') {
        return refusal('CLI_INTERNAL_ERROR', 'interactive sync received an invalid dry-run result', 'sync')
    }
    if (inspected.state === 'none') return adapters.synchronize(input)
    const typedDigest = await adapters.confirmStaleRemoval(inspected.request)
    if (typedDigest !== inspected.request.digest) {
        return staleRemovalRefusal('the typed stale-removal digest did not match the exact preview')
    }
    const previewBytes = JSON.stringify(inspected.request)
    return adapters.synchronize({
        ...input,
        authorizeStaleRemoval: async (request) => request.digest === inspected.request.digest
            && JSON.stringify(request) === previewBytes
            ? { format: 'cockpit-stale-removal-approval/v1', digest: request.digest }
            : undefined,
    })
}
