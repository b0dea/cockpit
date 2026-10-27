import { createInterface } from 'node:readline/promises'
import type { Diagnostic } from '../diagnostics.js'
import type { PortLeaseProjection } from '../environment/ports.js'
import { runSyncOperatorApplication } from '../environment/operator-application.js'
import { runSyncAdoption, type SyncAdoptionInput, type SyncAdoptionOutcome } from './adopt.js'
import {
    checkGeneratedEnvironment as check,
    prepareGeneratedEnvironmentCurrentness as prepareCurrentness,
    applyGeneratedEnvironmentRepair as applyRepair,
    applySelectedBootstrapSurface as applyBootstrap,
    prepareSelectedBootstrapSurface as prepareBootstrap,
    resumeSelectedBootstrapSurface as resumeBootstrap,
    syncGeneratedEnvironment as synchronize,
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
    exports: ['prepareGeneratedEnvironmentCurrentness', 'applyGeneratedEnvironmentRepair', 'prepareSelectedBootstrapSurface', 'resumeSelectedBootstrapSurface', 'applySelectedBootstrapSurface', 'syncGeneratedEnvironment', 'adoptAndSyncGeneratedEnvironment', 'checkGeneratedEnvironment', 'runSyncOperatorCommand'],
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

/** `sync --adopt`: record the adoption, then run the ordinary sync that renders the merge. */
export function adoptAndSyncGeneratedEnvironment(input: SyncAdoptionInput): Promise<SyncAdoptionOutcome> {
    return runSyncAdoption(input, request => synchronize(request))
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
    io.stderr.write(`${JSON.stringify(request, null, 2)}\n`)
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
): Promise<GeneratedEnvironmentDispatchOutcome> {
    return runSyncOperatorApplication(input, {
        ...options,
        terminal: io.confirmStaleRemoval !== undefined || io.stdin?.isTTY === true,
    }, {
        synchronize: handler,
        confirmStaleRemoval: (request) => confirmStaleRemoval(io, request),
    })
}
