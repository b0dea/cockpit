import type { Approval } from '../operator-confirmation.js'
import type { Diagnostic } from '../diagnostics.js'
import { loadOperatorPolicy, runSyncOperatorApplication, type WideningPreview } from '../environment/operator-application.js'
import { GUARD_LOCAL_PATHS } from '../guards/local-identity.js'
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
    type WorktreeAlreadyBoundOutcome,
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
): Promise<GeneratedEnvironmentCommandOutcome | WorktreeAlreadyBoundOutcome> {
    return synchronizeTeam(input, adapters)
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

/** What a person reads before a sync's one yes: each field that widens, and each MCP server it enables. */
function wideningApproval(preview: WideningPreview): Approval {
    const fields = [...preview.widens, ...preview.mcpServers.map(row => `mcp.approved.${row.name}`)]
    return { title: 'Apply the cockpit.toml change',
        why: preview.unrecorded
            ? `cockpit cannot show what changed since the last sync, as ${GUARD_LOCAL_PATHS.generatedConfig} is missing or no longer loads; read cockpit.toml before answering`
            : `these changes widen what agents may do: ${[...new Set(fields)].join(', ')}`,
        details: [...preview.widens.map(field => `Widens ${field}`), ...preview.mcpServers.flatMap(({ name, runs, environment, headers, sources }) => [
            `MCP server ${name} runs ${runs}`, ...environment.length ? [`  given ${environment.join(', ')}`] : [],
            ...headers.length ? [`  sends ${headers.join(', ')}`] : [], `  declared in ${sources.join(', ')}`])] }
}

export async function runSyncOperatorCommand(
    input: GeneratedEnvironmentSyncHandlerInput,
    // `confirm` is set when a person answers, on a run from `cockpit approve`.
    confirm: ((approval: Approval) => Promise<boolean>) | undefined,
    handler: GeneratedEnvironmentSyncHandler,
    policy: typeof loadOperatorPolicy = loadOperatorPolicy,
): Promise<GeneratedEnvironmentDispatchOutcome> {
    return runSyncOperatorApplication(input, { person: confirm !== undefined }, {
        synchronize: handler,
        policy,
        confirmWidening: async preview => confirm !== undefined && confirm(wideningApproval(preview)),
    })
}
