import { dirname } from 'node:path'

import { loadCockpitConfig, readBoundedInput } from '../config/load.js'
import { recordMcpApprovals } from '../config/mcp-approved-toml.js'
import { guardWideningUnconfirmedDiagnostic, observeGuardConfigChange } from '../guards/policy-change.js'
import { sha256Hex } from '../sha256.js'
import { ENVIRONMENT_CODES } from './contract.js'
import { EXIT_CODES } from '../invocation.js'
import { refusalOutcome as refusal } from '../refusal.js'
import type { ResetCommandInput } from './application/lifecycle-context.js'
import type { StacksPruneScope } from './stack-inventory-prune.js'
import type {
    GeneratedEnvironmentCommandInput,
    GeneratedEnvironmentSyncInput,
    GeneratedStaleRemovalApproval,
    GeneratedStaleRemovalApprovalRequest,
} from './generated-application/shared.js'
import type { Diagnostic } from './contract.js'

interface OperatorAdmission {
    // A person is answering: the run comes from `cockpit approve`, which checked for one.
    readonly person: boolean
    // `reset --apply`: apply without a person's confirmation, which only a declared seed allows.
    readonly apply?: boolean
}

/** A declared MCP server at sync: what it runs, the digest a person's yes records, and whether cockpit.toml approves it. */
export type McpApproval = Readonly<{ name: string; sha256: string; approved: boolean; sources: readonly string[]; runs: string; environment: readonly string[]; headers: readonly string[] }>

/**
 * What the one fixed rule reads from cockpit.toml as it is on disk: the fields by which it widens
 * the guards this machine was generated from, and whether a seed refills the data a reset deletes.
 * `approveMcp` records a person's approvals in exactly the bytes read here, and returns their digest.
 */
// `unrecorded`: a guard was generated here, but the record of the configuration it was generated from is
// missing or no longer loads, as after an upgrade that changed the schema, so no change can be shown.
export type OperatorPolicy = Readonly<{ configSha256: string; widened: readonly string[]; unrecorded: boolean; seeded: boolean
    approveMcp: (approvals: readonly McpApproval[]) => Promise<string | OperatorCommandOutcome> }>

interface OperatorCommandOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

interface OperatorSession {
    readonly preview: OperatorCommandOutcome
    decide(decision: 'approve' | 'decline'): Promise<OperatorCommandOutcome>
}

interface ResetOperatorApplicationAdapters {
    readonly preview: (input: ResetCommandInput) => Promise<OperatorCommandOutcome>
    readonly begin: (input: ResetCommandInput) => Promise<OperatorSession | OperatorCommandOutcome>
    readonly confirm: (preview: OperatorCommandOutcome) => Promise<boolean>
    readonly policy: (configPath: string) => Promise<OperatorPolicy | OperatorCommandOutcome>
}

export type GeneratedEnvironmentSyncHandlerInput = GeneratedEnvironmentSyncInput & Readonly<{
    authorizeStaleRemoval?: (
        request: GeneratedStaleRemovalApprovalRequest,
    ) => Promise<GeneratedStaleRemovalApproval | undefined>
}>

/** What `cockpit approve` shows a person before a sync's one yes: what widens, and the MCP servers it enables. */
// `unrecorded` says the change since the last sync cannot be shown, so the person reads cockpit.toml itself.
export type WideningPreview = Readonly<{ widens: readonly string[]; unrecorded: boolean; mcpServers: readonly McpApproval[] }>

interface SyncOperatorApplicationAdapters {
    readonly synchronize: (input: GeneratedEnvironmentSyncHandlerInput) => Promise<OperatorCommandOutcome>
    readonly policy: (configPath: string) => Promise<OperatorPolicy | OperatorCommandOutcome>
    readonly confirmWidening: (preview: WideningPreview) => Promise<boolean>
}

const isPolicy = (value: OperatorPolicy | OperatorCommandOutcome): value is OperatorPolicy => 'configSha256' in value

/** The production policy adapter, read from cockpit.toml and the guard record of this machine. */
export async function loadOperatorPolicy(configPath: string): Promise<OperatorPolicy | OperatorCommandOutcome> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') return { status: 2, result: null, diagnostics: loaded.diagnostics }
    const { config, source } = loaded.result
    const change = await observeGuardConfigChange(dirname(source.path), { sha256: source.sha256, config })
    return { configSha256: source.sha256, widened: change?.kind === 'widening' ? change.fields : [], unrecorded: change?.kind === 'unrecorded',
        seeded: config.environment.seed !== undefined,
        approveMcp: async approvals => {
            const read = await readBoundedInput(source.path)
            if (read.kind !== 'complete' || sha256Hex(read.bytes) !== source.sha256) return refusal(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION,
                'cockpit.toml changed during review; nothing was written', source.path)
            const written = await recordMcpApprovals(source.path, read.bytes.toString('utf8'), source.sha256, config,
                Object.fromEntries(approvals.map(row => [row.name, row.sha256])))
            return written.kind === 'complete' ? written.sha256 : { status: 2, result: null, diagnostics: [{ severity: 'error' as const,
                code: written.code as Diagnostic['code'], message: written.message, fix: written.fix, target: source.path } as Diagnostic] }
        } }
}

// A reset deletes stack data. An agent applies one where a declared seed refills it, and only while
// cockpit.toml carries no edit that widens what agents may do: an agent could declare a volume
// resettable and a seed in the same edit.
function resetRefusal(policy: OperatorPolicy, configPath: string, unchanged: string): OperatorCommandOutcome | undefined {
    if (policy.widened.length || policy.unrecorded) {
        const diagnostic = guardWideningUnconfirmedDiagnostic(policy.unrecorded ? 'unrecorded' : policy.widened, configPath)
        return { status: 2, result: null, diagnostics: [{ ...diagnostic, message: `${diagnostic.message}; ${unchanged}` }] }
    }
    if (policy.seeded) return undefined
    return { status: 2, result: null, diagnostics: [{ severity: 'error' as const, target: 'environment.seed',
        code: ENVIRONMENT_CODES.RESET_CONFIRMATION_REQUIRED,
        message: `cockpit.toml declares no [environment] seed to refill the data a reset deletes, so this run cannot apply it without a person; ${unchanged}`,
        fix: 'this needs a person: they run npx --no cockpit approve in <the cockpit root>, from a terminal outside the agent, or the team declares [environment] seed in cockpit.toml' }] }
}

export async function runResetOperatorApplication(
    input: ResetCommandInput,
    admission: OperatorAdmission,
    adapters: ResetOperatorApplicationAdapters,
): Promise<OperatorCommandOutcome> {
    if (!admission.person && admission.apply) {
        const policy = await adapters.policy(input.configPath)
        if (!isPolicy(policy)) return policy
        const refused = resetRefusal(policy, input.configPath, 'nothing was reset')
        if (refused) return refused
        const opened = await adapters.begin(input)
        return 'decide' in opened ? opened.decide('approve') : opened
    }
    if (!admission.person) return adapters.preview(input)
    const opened = await adapters.begin(input)
    if (!('decide' in opened)) return opened
    const approved = await adapters.confirm(opened.preview)
    if (approved) return opened.decide('approve')
    await opened.decide('decline')
    return { status: EXIT_CODES.cancelled, diagnostics: [], result: null }
}

export interface StacksPruneOperatorSession {
    readonly preview: OperatorCommandOutcome
    readonly digest: string
    readonly empty: boolean
    readonly deletesData: boolean
    apply(): Promise<OperatorCommandOutcome>
}

interface StacksPruneOperatorAdapters {
    readonly begin: (input: Readonly<{ configPath: string; scope: StacksPruneScope }>) => Promise<StacksPruneOperatorSession | OperatorCommandOutcome>
    /** Shows the preview to a person at a terminal and returns whether they answered yes. */
    readonly confirm: (preview: OperatorCommandOutcome) => Promise<boolean>
    readonly policy: (configPath: string) => Promise<OperatorPolicy | OperatorCommandOutcome>
}

/**
 * `stacks prune`: a preview by default. Removing an orphan whose checkout is gone is housekeeping
 * anyone can undo by bringing the stack up again, so `--apply` passes for an agent; a prune that
 * deletes volumes deletes data, and passes only where this cockpit lets an agent reset. That rule is
 * this cockpit's, so an agent's `--apply` covers only this cockpit's stacks: another cockpit may
 * require a person for the same removal. A person's yes at `cockpit approve` covers the exact
 * preview, and every stack on the machine.
 */
export async function runStacksPruneOperatorApplication(
    input: Readonly<{ configPath: string }>,
    admission: OperatorAdmission,
    adapters: StacksPruneOperatorAdapters,
): Promise<OperatorCommandOutcome> {
    const opened = await adapters.begin({ configPath: input.configPath, scope: !admission.person && admission.apply ? 'this-cockpit' : 'machine' })
    if (!('apply' in opened)) return opened
    if (!admission.person && !admission.apply || opened.empty) return opened.preview
    if (admission.person) {
        if (!await adapters.confirm(opened.preview)) return { status: EXIT_CODES.cancelled, diagnostics: [], result: null }
        return opened.apply()
    }
    if (opened.deletesData) {
        const policy = await adapters.policy(input.configPath)
        if (!isPolicy(policy)) return policy
        const refused = resetRefusal(policy, input.configPath, 'nothing was pruned')
        if (refused) return refused
    }
    return opened.apply()
}

// Removing files cockpit generated and no longer generates narrows what is written, so it never waits.
const approveStaleRemoval = async (request: GeneratedStaleRemovalApprovalRequest) =>
    ({ format: 'cockpit-stale-removal-approval/v1' as const, digest: request.digest })

/** The MCP servers a dry run that previewed every declared server as approved reports as not yet approved. */
function previewedApprovals(outcome: OperatorCommandOutcome): readonly McpApproval[] | undefined {
    const result = outcome.result as { dryRun?: unknown; mcpApprovals?: unknown } | null
    if (outcome.status !== 0 || result?.dryRun !== true) return undefined
    const rows = result.mcpApprovals ?? []
    return Array.isArray(rows) && rows.every(row => typeof row?.name === 'string' && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)
        && typeof row.approved === 'boolean' && typeof row.runs === 'string' && Array.isArray(row.sources)
        && [row.environment, row.headers].every(list => Array.isArray(list) && list.every((item: unknown) => typeof item === 'string'))) ? rows as McpApproval[] : undefined
}

// The one place sync's decision lives. A dry run writes nothing and passes untouched. An agent's sync
// applies every change that does not widen what agents may do; the team sync refuses one that does.
// A person's run, from `cockpit approve`, shows one preview of what widens and the MCP servers a yes
// enables, and on yes records the approvals in cockpit.toml and applies exactly the bytes shown. The
// yes is a bar, not a proof of a person: an agent that allocates a pseudo-terminal can answer it, which
// is why approve also refuses inside a session an agent tool marks.
export async function runSyncOperatorApplication(
    input: GeneratedEnvironmentCommandInput & Readonly<{ dryRun?: boolean }>,
    admission: OperatorAdmission,
    adapters: SyncOperatorApplicationAdapters,
): Promise<OperatorCommandOutcome> {
    if (input.dryRun === true) return adapters.synchronize(input)
    if (!admission.person) return adapters.synchronize({ ...input, authorizeStaleRemoval: approveStaleRemoval })
    const preview = await adapters.synchronize({ ...input, dryRun: true, approveDeclaredMcp: true })
    if (preview.status !== 0) return preview
    const declared = previewedApprovals(preview)
    if (!declared) return refusal('CLI_INTERNAL_ERROR', 'sync received an invalid dry-run result to show the person', 'sync')
    const policy = await adapters.policy(input.configPath)
    if (!isPolicy(policy)) return policy
    // The yes records the servers cockpit.toml does not approve yet, and the person also sees each one an
    // unsynced edit approved: a digest typed into the file by an agent starts the same process.
    const approvals = declared.filter(row => !row.approved)
    // Where the change since the last sync cannot be shown, every server the yes leaves enabled is listed.
    const mcpServers = declared.filter(row => !row.approved || policy.unrecorded || policy.widened.includes(`mcp.approved.${row.name}`))
    const changed = () => refusal(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, 'cockpit.toml changed during review; nothing was written', input.configPath,
        'run npx --no cockpit approve in <the cockpit root> again and review the fresh preview')
    if ((preview.result as { sourceSha256?: unknown }).sourceSha256 !== policy.configSha256) return changed()
    let configSha256 = policy.configSha256
    if (policy.widened.length || policy.unrecorded || mcpServers.length) {
        if (!await adapters.confirmWidening({ widens: policy.widened, unrecorded: policy.unrecorded, mcpServers })) {
            return { status: EXIT_CODES.cancelled, diagnostics: [], result: null }
        }
        if (approvals.length) {
            const written = await policy.approveMcp(approvals)
            if (typeof written !== 'string') return written
            configSha256 = written
            const latest = await adapters.policy(input.configPath)
            if (!isPolicy(latest)) return latest
            if (latest.configSha256 !== configSha256) return changed()
        }
    }
    // The team sync publishes a widening only as exactly the bytes the person approved.
    return adapters.synchronize({ ...input, guardWidening: { configSha256 }, authorizeStaleRemoval: approveStaleRemoval })
}
