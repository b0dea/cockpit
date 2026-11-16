import { agentSessionVariable, confirmYes } from '../operator-confirmation.js'
import { renderHumanValue } from '../diagnostics.js'
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
    /** The environment the command runs with, which says whether an agent tool started it. */
    readonly env: Readonly<Record<string, string | undefined>>
    readonly stdin?: NodeJS.ReadStream
    readonly confirmWidening?: (preview: WideningPreview) => Promise<boolean>
}

export interface GeneratedEnvironmentOperatorOptions {
    readonly interactive: boolean
    readonly json: boolean
    readonly ci: string | undefined
}

/** Writes why a terminal confirmation is refused inside an agent tool's session, and says whether it was. */
function agentRefusal(io: GeneratedEnvironmentOperatorIo): boolean {
    const variable = agentSessionVariable(io.env)
    if (variable) io.stderr.write(`Refusing a terminal confirmation inside an agent session (${variable} is set): a person confirms it in a terminal of their own, outside the agent.\n`)
    return variable !== undefined
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
        terminal: io.confirmWidening !== undefined || io.stdin?.isTTY === true,
    }, {
        synchronize: handler,
        policy,
        confirmWidening: async (preview) => {
            if (io.confirmWidening) return io.confirmWidening(preview)
            if (!io.stdin || agentRefusal(io)) return false
            io.stderr.write(renderHumanValue({ ...preview.widens.length ? { widens: preview.widens } : {},
                ...preview.unrecorded ? { unrecorded: `cockpit cannot show what changed since the last sync, as ${GUARD_LOCAL_PATHS.generatedConfig} is missing or no longer loads; read cockpit.toml before answering` } : {},
                ...preview.mcpServers.length ? { enablesMcpServers: preview.mcpServers.map(({ name, runs, environment, headers, sources }) => ({ name, runs,
                    ...environment.length ? { environment } : {}, ...headers.length ? { headers } : {}, declaredIn: sources })) } : {} }))
            return confirmYes(io, 'Apply this change to what agents may do?')
        },
    })
}
