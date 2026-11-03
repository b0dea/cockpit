import { createInterface } from 'node:readline/promises'
import { renderHumanValue } from '../diagnostics.js'
import type { Diagnostic } from '../diagnostics.js'
import type { PortLeaseProjection } from '../environment/ports.js'
import { loadOperatorPolicy, runSyncOperatorApplication } from '../environment/operator-application.js'
import { runSyncAdoption, type SyncAdoptionInput, type SyncAdoptionOutcome } from './adopt.js'
import {
    checkGeneratedEnvironment as check,
    prepareGeneratedEnvironmentCurrentness as prepareCurrentness,
    applyGeneratedEnvironmentRepair as applyRepair,
    applySelectedBootstrapSurface as applyBootstrap,
    prepareSelectedBootstrapSurface as prepareBootstrap,
    resumeSelectedBootstrapSurface as resumeBootstrap,
    syncGeneratedEnvironment as synchronize,
    syncTeamGeneratedEnvironment as synchronizeTeam,
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
} from '../environment/generated-application.js'

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
} from '../environment/generated-application.js'

export const mechanism = {
    id: 'generated-environment-command',
    module: 'packages/cockpit/src/generated-environment/command.ts',
    exports: ['prepareGeneratedEnvironmentCurrentness', 'applyGeneratedEnvironmentRepair', 'prepareSelectedBootstrapSurface', 'resumeSelectedBootstrapSurface', 'applySelectedBootstrapSurface', 'syncGeneratedEnvironment', 'syncTeamGeneratedEnvironment', 'adoptAndSyncGeneratedEnvironment', 'checkGeneratedEnvironment', 'runSyncOperatorCommand'],
} as const

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
    portLease?: PortLeaseProjection,
): Promise<GeneratedEnvironmentCurrentness> {
    return prepareCurrentness(input, adapters, portLease)
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
    portLease?: PortLeaseProjection,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return synchronize(input, adapters, portLease)
}

export function syncTeamGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapters?: Partial<GeneratedEnvironmentCommandAdapters>,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return synchronizeTeam(input, adapters)
}

/** `sync --adopt`: record the adoption, then run the ordinary sync that renders the merge. */
export function adoptAndSyncGeneratedEnvironment(input: SyncAdoptionInput): Promise<SyncAdoptionOutcome> {
    return runSyncAdoption(input, request => synchronizeTeam(request))
}

export function checkGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
    portLease?: PortLeaseProjection,
): Promise<GeneratedEnvironmentCommandOutcome> {
    return check(input, portLease)
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
    readonly confirmPolicyWeakening?: (request: Readonly<{ weakened: readonly Readonly<{ field: string; from: string; to: string }>[]; digest: string }>) => Promise<string | undefined>
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
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        const answer = await prompt.question('Type the exact stale-removal digest to approve this sync: ')
        return answer.trim()
    } finally {
        prompt.close()
    }
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
        terminal: io.confirmStaleRemoval !== undefined || io.stdin?.isTTY === true,
    }, {
        synchronize: handler,
        confirmStaleRemoval: (request) => confirmStaleRemoval(io, request),
        policy,
        confirmPolicyWeakening: async (request) => {
            if (io.confirmPolicyWeakening) return io.confirmPolicyWeakening(request)
            if (!io.stdin) return undefined
            io.stderr.write(renderHumanValue({ weakens: request.weakened.map(row => `${row.field}: ${row.from} -> ${row.to}`), digest: request.digest }))
            const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
            try { return (await prompt.question('Type the digest to accept this weaker policy: ')).trim() } finally { prompt.close() }
        },
    })
}
