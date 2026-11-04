import { decide, policyWeakening, policyWeakeningDiagnostic, weakeningDigest, writeRecordedPolicy, type EffectivePolicy, type PolicyWeakening } from '../autonomy.js'
import { loadAutonomyPolicy } from '../config/load.js'
import type { Decider } from '../schema.js'
import { ENVIRONMENT_CODES, type Diagnostic } from './contract.js'
import { EXIT_CODES } from '../invocation.js'
import { refusalOutcome as refusal } from '../refusal.js'
import type { ResetCommandInput } from './application/lifecycle-context.js'
import type { StacksPruneScope } from './stack-inventory.js'
import type {
    GeneratedEnvironmentCommandInput,
    GeneratedEnvironmentSyncInput,
    GeneratedStaleRemovalApproval,
    GeneratedStaleRemovalApprovalRequest,
} from './generated-application/shared.js'

interface OperatorAdmission {
    readonly interactive: boolean
    readonly json: boolean
    readonly ci: string | undefined
    readonly terminal: boolean
    // `reset --apply`: apply without a person's confirmation, which only [autonomy] reset can allow.
    readonly apply?: boolean
}

/** The autonomy policy a gated command reads, or the refusal that it could not be read. */
type OperatorPolicy = Readonly<{ current: EffectivePolicy; recorded?: EffectivePolicy; record: () => Promise<void> }>

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

interface SyncOperatorApplicationAdapters {
    readonly synchronize: (input: GeneratedEnvironmentSyncHandlerInput) => Promise<OperatorCommandOutcome>
    readonly confirmStaleRemoval: (request: GeneratedStaleRemovalApprovalRequest) => Promise<string | undefined>
    readonly policy: (configPath: string) => Promise<OperatorPolicy | OperatorCommandOutcome>
    readonly confirmPolicyWeakening: (request: Readonly<{ weakened: readonly PolicyWeakening[]; digest: string }>) => Promise<string | undefined>
}


const isPolicy = (value: OperatorPolicy | OperatorCommandOutcome): value is OperatorPolicy => 'current' in value

/** The production policy adapter: cockpit.toml's policy now, the recorded one, and how to record the current one. */
export async function loadOperatorPolicy(configPath: string): Promise<OperatorPolicy | OperatorCommandOutcome> {
    const loaded = await loadAutonomyPolicy(configPath)
    if ('refusal' in loaded) return { status: 2, result: null, diagnostics: [loaded.refusal] }
    return { current: loaded.current, ...loaded.recorded ? { recorded: loaded.recorded } : {}, record: () => writeRecordedPolicy(loaded.root, loaded.current) }
}

/** Why `decider` does not let this run pass the decision, as the refusal a command returns, or undefined when it does. */
function autonomyRefusal(field: string, decider: Decider, admission: OperatorAdmission): OperatorCommandOutcome | undefined {
    const decision = decide(decider, { CI: admission.ci })
    if (decision === 'proceed') return undefined
    // Each code is a literal so the diagnostic inventory reads its fix beside it.
    return decision === 'person'
        ? { status: 2, result: null, diagnostics: [{ severity: 'error' as const, target: field,
            code: 'AUTONOMY_PERSON_REQUIRED' as const satisfies typeof ENVIRONMENT_CODES.AUTONOMY_PERSON_REQUIRED,
            message: `[autonomy] ${field} = "person" in cockpit.toml: this run cannot take the decision without a person`,
            fix: 'a person runs the same command with --interactive in a terminal outside CI, or a person changes the field in cockpit.toml and accepts the change at sync' }] }
        : { status: 2, result: null, diagnostics: [{ severity: 'error' as const, target: field,
            code: 'AUTONOMY_CI_ONLY' as const satisfies typeof ENVIRONMENT_CODES.AUTONOMY_CI_ONLY,
            message: `[autonomy] ${field} = "ci" in cockpit.toml: this decision is taken only in CI, behind the reviewers of its protected environment`,
            fix: 'push the change and let the CI job run the command, or have a person change the field in cockpit.toml and accept the change at sync' }] }
}

// A weakening the last sync did not accept is not in force: the command it would let through
// refuses, as sync does, until a person accepts it there or the change is reverted.
function weakeningRefusal(weakened: readonly PolicyWeakening[], unchanged: string, result: unknown = null): OperatorCommandOutcome {
    const diagnostic = policyWeakeningDiagnostic(weakened)
    return { status: 2, result, diagnostics: [{ ...diagnostic, message: `${diagnostic.message}; ${unchanged}` }] }
}

export async function runResetOperatorApplication(
    input: ResetCommandInput,
    admission: OperatorAdmission,
    adapters: ResetOperatorApplicationAdapters,
): Promise<OperatorCommandOutcome> {
    if (!admission.interactive && admission.apply) {
        const policy = await adapters.policy(input.configPath)
        if (!isPolicy(policy)) return policy
        const weakened = policy.recorded ? policyWeakening(policy.recorded, policy.current).filter(row => row.field === 'autonomy.reset') : []
        if (weakened.length) return weakeningRefusal(weakened, 'nothing was reset')
        const refused = autonomyRefusal('reset', policy.current.autonomy.reset, admission)
        if (refused) return refused
        const opened = await adapters.begin(input)
        return 'decide' in opened ? opened.decide('approve') : opened
    }
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

export interface StacksPruneOperatorSession {
    readonly preview: OperatorCommandOutcome
    readonly digest: string
    readonly empty: boolean
    readonly deletesData: boolean
    apply(): Promise<OperatorCommandOutcome>
}

interface StacksPruneOperatorAdapters {
    readonly begin: (input: Readonly<{ configPath: string; scope: StacksPruneScope }>) => Promise<StacksPruneOperatorSession | OperatorCommandOutcome>
    /** Shows the preview to a person at a terminal and returns the digest they typed. */
    readonly confirm: (preview: OperatorCommandOutcome) => Promise<string | undefined>
    readonly policy: (configPath: string) => Promise<OperatorPolicy | OperatorCommandOutcome>
}

function pruneUnconfirmed(message: string): OperatorCommandOutcome {
    return { status: 2, result: null, diagnostics: [{ severity: 'error' as const, target: 'stacks',
        code: 'STACKS_PRUNE_UNCONFIRMED' as const satisfies typeof ENVIRONMENT_CODES.STACKS_PRUNE_UNCONFIRMED,
        message, fix: 'a person runs npx --no cockpit stacks prune --config <your cockpit.toml> --interactive in a terminal outside CI, reads the preview and types its digest' }] }
}

/**
 * `stacks prune`: a preview by default. Removing an orphan whose checkout is gone is housekeeping
 * anyone can undo by bringing the stack up again, so `--apply` passes for an agent; a prune that
 * deletes volumes deletes data, and passes only where `[autonomy] reset` lets this run reset. That
 * policy is this cockpit's, so an agent's `--apply` covers only this cockpit's stacks: another
 * cockpit may require a person for the same removal. `--interactive` is a person's approval of the
 * exact preview by its digest, and covers every stack on the machine.
 */
export async function runStacksPruneOperatorApplication(
    input: Readonly<{ configPath: string }>,
    admission: OperatorAdmission,
    adapters: StacksPruneOperatorAdapters,
): Promise<OperatorCommandOutcome> {
    if (admission.interactive && (admission.json || admission.ci && admission.ci.length > 0)) {
        return pruneUnconfirmed('interactive prune requires a human terminal outside CI and JSON modes')
    }
    if (admission.interactive && !admission.terminal) return pruneUnconfirmed('interactive prune requires terminal input')
    const opened = await adapters.begin({ configPath: input.configPath, scope: !admission.interactive && admission.apply ? 'this-cockpit' : 'machine' })
    if (!('apply' in opened)) return opened
    if (!admission.interactive && !admission.apply || opened.empty) return opened.preview
    if (admission.interactive) {
        if (await adapters.confirm(opened.preview) !== opened.digest) return pruneUnconfirmed('the typed digest did not match the prune preview; nothing was removed')
        return opened.apply()
    }
    if (opened.deletesData) {
        const policy = await adapters.policy(input.configPath)
        if (!isPolicy(policy)) return policy
        const weakened = policy.recorded ? policyWeakening(policy.recorded, policy.current).filter(row => row.field === 'autonomy.reset') : []
        if (weakened.length) return weakeningRefusal(weakened, 'nothing was pruned')
        const refused = autonomyRefusal('reset', policy.current.autonomy.reset, admission)
        if (refused) return refused
    }
    return opened.apply()
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

// The one place sync's decision lives: who may write, whether a weakened policy was accepted, and
// whether stale generated files go without a person. A dry run writes nothing and passes untouched.
export async function runSyncOperatorApplication(
    input: GeneratedEnvironmentCommandInput & Readonly<{ dryRun?: boolean }>,
    admission: OperatorAdmission,
    adapters: SyncOperatorApplicationAdapters,
): Promise<OperatorCommandOutcome> {
    if (input.dryRun === true) return adapters.synchronize(input)
    if (admission.interactive && (admission.json || admission.ci && admission.ci.length > 0)) {
        return staleRemovalRefusal('interactive sync requires a human terminal outside CI and JSON modes')
    }
    if (admission.interactive && !admission.terminal) return staleRemovalRefusal('interactive sync requires terminal input')
    const policy = await adapters.policy(input.configPath)
    if (!isPolicy(policy)) return policy
    // A person's sync is the person's decision; only a sync gated on ci is refused outside CI here, and
    // the guard keeps an agent's sync from running unless [autonomy] sync is agent.
    if (policy.current.autonomy.sync === 'ci') {
        const refused = autonomyRefusal('sync', 'ci', admission)
        if (refused) return refused
    }
    const weakened = policy.recorded ? policyWeakening(policy.recorded, policy.current) : []
    if (weakened.length) {
        const digest = weakeningDigest(policy.recorded!, policy.current)
        if (!admission.interactive) return weakeningRefusal(weakened, 'nothing was written', { weakened, digest })
        if (await adapters.confirmPolicyWeakening({ weakened, digest }) !== digest) {
            return refusal('POLICY_WEAKENING_UNCONFIRMED', 'the typed digest did not match the policy weakening shown; nothing was written', 'autonomy')
        }
    }
    // Stale removal an agent may take is approved for exactly the entries this sync computes.
    const staleByPolicy = decide(policy.current.autonomy.stale_delete, { CI: admission.ci }) === 'proceed'
    const approveAll = async (request: GeneratedStaleRemovalApprovalRequest) => ({ format: 'cockpit-stale-removal-approval/v1' as const, digest: request.digest })
    let outcome: OperatorCommandOutcome
    if (!admission.interactive || staleByPolicy) {
        outcome = await adapters.synchronize({ ...input, ...staleByPolicy ? { authorizeStaleRemoval: approveAll } : {} })
    } else {
        const preview = await adapters.synchronize({ ...input, dryRun: true })
        if (preview.status !== 0) return preview
        const inspected = previewedStaleRemoval(preview)
        if (inspected.state === 'invalid') {
            return refusal('CLI_INTERNAL_ERROR', 'interactive sync received an invalid dry-run result', 'sync')
        }
        if (inspected.state === 'none') outcome = await adapters.synchronize(input)
        else {
            const typedDigest = await adapters.confirmStaleRemoval(inspected.request)
            if (typedDigest !== inspected.request.digest) {
                return staleRemovalRefusal('the typed stale-removal digest did not match the exact preview')
            }
            const previewBytes = JSON.stringify(inspected.request)
            outcome = await adapters.synchronize({
                ...input,
                authorizeStaleRemoval: async (request) => request.digest === inspected.request.digest
                    && JSON.stringify(request) === previewBytes
                    ? { format: 'cockpit-stale-removal-approval/v1', digest: request.digest }
                    : undefined,
            })
        }
    }
    if (outcome.status === 0) await policy.record()
    return outcome
}
