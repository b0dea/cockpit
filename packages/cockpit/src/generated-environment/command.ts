import { confirmDigest } from '../operator-confirmation.js'
import { renderHumanValue } from '../diagnostics.js'
import type { Diagnostic } from '../diagnostics.js'
import { loadOperatorPolicy, runSyncOperatorApplication } from '../environment/operator-application.js'
import { runSyncAdoption, type SyncAdoptionInput, type SyncAdoptionOutcome } from './adopt.js'
import {
    applySelectedBootstrapSurface as applyBootstrap,
    prepareSelectedBootstrapSurface as prepareBootstrap,
    resumeSelectedBootstrapSurface as resumeBootstrap,
} from '../environment/generated-application/bootstrap-skill.js'
import {
    checkGeneratedEnvironment as check,
    prepareGeneratedEnvironmentCurrentness as prepareCurrentness,
} from '../environment/generated-application/check.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentChange,
    type GeneratedEnvironmentCommandInput,
    type GeneratedEnvironmentCommandOutcome,
    type GeneratedEnvironmentSyncInput,
    type GeneratedEnvironmentCurrentness,
    type GeneratedEnvironmentRepairAuthority,
    type SelectedBootstrapPublicationAuthority,
    type SelectedBootstrapSurfaceInput,
    type SelectedBootstrapResumeInput,
    type SelectedBootstrapResumeOutcome,
    type SelectedBootstrapSurfaceOutcome,
    type GeneratedStaleRemovalApproval,
    type GeneratedStaleRemovalApprovalRequest,
} from '../environment/generated-application/shared.js'
import {
    applyGeneratedEnvironmentRepair as applyRepair,
    syncGeneratedEnvironment as synchronize,
    syncTeamGeneratedEnvironment as synchronizeTeam,
} from '../environment/generated-application/sync.js'

export type {
    GeneratedEnvironmentCommandAdapters,
    GeneratedEnvironmentChange,
    GeneratedEnvironmentCommandInput,
    GeneratedEnvironmentCommandOutcome,
    GeneratedEnvironmentSyncInput,
    GeneratedEnvironmentCurrentness,
    GeneratedEnvironmentRepairAuthority,
    SelectedBootstrapPublicationAuthority,
    SelectedBootstrapSurfaceInput,
    SelectedBootstrapResumeInput,
    SelectedBootstrapResumeOutcome,
    SelectedBootstrapSurfaceOutcome,
} from '../environment/generated-application/shared.js'

export function prepareSelectedBootstrapSurface(
    input: SelectedBootstrapSurfaceInput,
    adapters?: Partial<GeneratedEnvironmentCommandAdapters>,
): Promise<SelectedBootstrapSurfaceOutcome> {
    return prepareBootstrap(input, adapters)
}

export function resumeSelectedBootstrapSurface(
    input: SelectedBootstrapResumeInput,
    adapters?: Partial<GeneratedEnvironmentCommandAdapters>,
): Promise<SelectedBootstrapResumeOutcome> {
    return resumeBootstrap(input, adapters)
}

export function applySelectedBootstrapSurface(
    authority: SelectedBootstrapPublicationAuthority,
): Promise<SelectedBootstrapSurfaceOutcome> {
    return applyBootstrap(authority)
}

export function prepareGeneratedEnvironmentCurrentness(
    input: GeneratedEnvironmentCommandInput,
    adapters?: Partial<GeneratedEnvironmentCommandAdapters>,
): Promise<GeneratedEnvironmentCurrentness> {
    return prepareCurrentness(input, adapters)
}

export function applyGeneratedEnvironmentRepair(
    authority: GeneratedEnvironmentRepairAuthority,
    options?: Readonly<{ dryRun?: boolean }>,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return applyRepair(authority, options)
}

export function syncGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapters?: Partial<GeneratedEnvironmentCommandAdapters>,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return synchronize(input, adapters)
}

export function syncTeamGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapters?: Partial<GeneratedEnvironmentCommandAdapters>,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return synchronizeTeam(input, adapters)
}

/** `sync --adopt`: record the adoption, then run the ordinary sync that renders the merge. */
export function adoptAndSyncGeneratedEnvironment(input: SyncAdoptionInput): Promise<SyncAdoptionOutcome> {
    // The adoption writes its own rows; anything else that widens the guards waits for a person.
    return runSyncAdoption(input, request => synchronizeTeam({ ...request, guardWidening: { fields: ['surfaces.adopted'] } }))
}

export function checkGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return check(input)
}

export interface GeneratedEnvironmentDispatchOutcome {
    readonly artifact?: string | null
    readonly destination?: string | null
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

export type GeneratedEnvironmentSyncHandlerInput = GeneratedEnvironmentSyncInput & Readonly<{
    authorizeStaleRemoval?: (request: GeneratedStaleRemovalApprovalRequest) => Promise<GeneratedStaleRemovalApproval | undefined>
}>

type GeneratedEnvironmentSyncHandler = (input: GeneratedEnvironmentSyncHandlerInput) => Promise<GeneratedEnvironmentDispatchOutcome>

export interface GeneratedEnvironmentOperatorIo {
    readonly stderr: Pick<NodeJS.WriteStream, 'write'>
    readonly stdin?: NodeJS.ReadStream
    readonly confirmStaleRemoval?: (request: GeneratedStaleRemovalApprovalRequest) => Promise<string | undefined>
    readonly confirmPolicyWeakening?: (request: Readonly<{ weakened: readonly Readonly<{ field: string; from: string; to: string }>[]; widened: readonly string[]; digest: string }>) => Promise<string | undefined>
}

export interface GeneratedEnvironmentOperatorOptions {
    readonly interactive: boolean
    readonly json: boolean
    readonly ci: string | undefined
}

async function confirmStaleRemoval(
    io: GeneratedEnvironmentOperatorIo,
    request: GeneratedStaleRemovalApprovalRequest,
): Promise<string | undefined> {
    if (io.confirmStaleRemoval) return io.confirmStaleRemoval(request)
    if (!io.stdin) return undefined
    io.stderr.write(renderHumanValue(request))
    return confirmDigest(io, request.digest, 'Approve these exact stale-file removals for this sync?')
}

export async function runSyncOperatorCommand(
    input: GeneratedEnvironmentSyncHandlerInput,
    options: GeneratedEnvironmentOperatorOptions,
    io: GeneratedEnvironmentOperatorIo,
    handler: GeneratedEnvironmentSyncHandler,
    policy: typeof loadOperatorPolicy = loadOperatorPolicy,
): Promise<GeneratedEnvironmentDispatchOutcome> {
    return runSyncOperatorApplication(input, {
        ...options,
        terminal: io.confirmStaleRemoval !== undefined || io.confirmPolicyWeakening !== undefined || io.stdin?.isTTY === true,
    }, {
        synchronize: handler,
        confirmStaleRemoval: (request) => confirmStaleRemoval(io, request),
        policy,
        confirmPolicyWeakening: async (request) => {
            if (io.confirmPolicyWeakening) return io.confirmPolicyWeakening(request)
            if (!io.stdin) return undefined
            io.stderr.write(renderHumanValue({ ...request.weakened.length ? { weakens: request.weakened.map(row => `${row.field}: ${row.from} -> ${row.to}`) } : {},
                ...request.widened.length ? { widensGuard: request.widened } : {}, digest: request.digest }))
            return confirmDigest(io, request.digest, request.widened.length ? 'Accept this exact change to what agents may do?' : 'Accept this exact policy weakening?')
        },
    })
}
