import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ExecutePlanOutcome } from '../../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    type CheckoutId,
    type ConfigSourceSnapshot,
    type EnvironmentCommandOutcome,
    type ExecutionPlan,
    type EnvironmentDiagnostic,
    type HolderId,
    type SetupExecutionEvidence,
    type SetupRefusalEvidence,
    type SourceProvenance,
    type StackId,
    snapshotJson,
} from '../contract.js'
import { gitEnvironment, resolveLocalRemote, type SetupObservation, type SetupResult } from '../setup.js'
import type { InstructionPointerResult } from '../instruction-pointer.js'
import type { SiblingInstructionFilesResult } from '../sibling-instructions.js'
import { resolvedGitExecutable, type ResolvedExecutable } from '../executable.js'
import type { InstallPolicy, Sibling } from '../../schema.js'
import { authenticateStateNamespace, type StateNamespace } from '../state.js'
import type { LifecycleHistoryTransition } from '../lifecycle-stage.js'
import type { EnvironmentSeedPlan, EnvironmentSeedResult } from '../templates.js'
import type { InstallPolicyLockfileObservation, InstallPolicyProjection } from '../install-policy-observation.js'
import type { InstallPolicyResolution, ResolvedInstallPolicyBinding } from '../install-policy.js'
import { checkoutId as deriveCheckoutId, holderId as deriveHolderId, stackId as deriveStackId } from '../identity.js'
import {
    consumeSetupCheckoutProjection,
    type EnvironmentIgnoreRefusal,
    type ConsumedSetupCheckoutObservation,
    type SetupCheckoutProjection,
} from '../setup-observation.js'
import type { LoadedConfigProjection } from '../../config/load.js'
import { observeGit } from '../git-observation.js'
import { exactEnvironment, ownerDiagnostic, sameSource, uniqueDiagnostics } from './shared.js'
import { consumeEffectiveConfiguration, registryRefusalMessage } from './lifecycle-context.js'

export interface SetupCommandInput {
    configPath: string
    writeInstructionPointers?: boolean
    writeInstructionFiles?: boolean
    env?: Readonly<Record<string, string | undefined>>
    gitExecutable?: ResolvedExecutable
}

export interface SetupCommandResult {
    source: SourceProvenance
    siblings: readonly SetupResult[]
    environmentFiles?: readonly Extract<EnvironmentSeedResult, { kind: 'created' | 'unchanged' }>[]
    installPolicies?: readonly ResolvedInstallPolicyBinding[]
}

export interface SetupRunContext {
    readonly source: SourceProvenance
    readonly mainCheckoutPath: string
    readonly siblingsRoot: string
    readonly siblings: readonly Sibling[]
    readonly policyCatalog: readonly InstallPolicy[]
    readonly env: Readonly<Record<string, string>>
    readonly gitExecutable: ResolvedExecutable
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly writeInstructionPointers: boolean
    readonly writeInstructionFiles: boolean
}

export interface SetupRunContextInput {
    readonly checkout: SetupCheckoutProjection
    readonly configuration: LoadedConfigProjection
    readonly env: Readonly<Record<string, string>>
    readonly gitExecutable: ResolvedExecutable
    readonly namespace: StateNamespace
    readonly observedAt: string
    readonly currentCheckoutPath: string
    readonly mainCheckoutPath: string
    readonly cockpitId: ConsumedSetupCheckoutObservation['cockpitId']
    readonly checkoutId: CheckoutId
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly sessionId: string
    readonly writeInstructionPointers?: boolean
    readonly writeInstructionFiles?: boolean
}

const issuedSetupRuns = new WeakSet<object>()

function contextRefusal(
    target = 'setup',
    message = 'setup run authority is unavailable or does not match the loaded configuration',
): Extract<EnvironmentCommandOutcome<SetupRunContext>, { kind: 'refusal' }> {
    return {
        kind: 'refusal', status: 2, result: null,
        diagnostics: [ownerDiagnostic(
            ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
            message,
            target,
        )],
    }
}

export function issueSetupRunContext(input: SetupRunContextInput): EnvironmentCommandOutcome<SetupRunContext> {
    try {
        const checkout = consumeSetupCheckoutProjection(input.checkout)
        const loaded = consumeEffectiveConfiguration(input.configuration)
        const env = exactEnvironment(input.env)
        const executable = resolvedGitExecutable(input.gitExecutable)
        const namespace = authenticateStateNamespace(input.namespace)
        if (loaded.kind === 'refusal') return contextRefusal(undefined, registryRefusalMessage(loaded))
        if (!checkout || loaded.kind !== 'complete' || !env || !executable || !namespace) return contextRefusal()
        const expectedStackId = deriveStackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        const expectedHolderId = deriveHolderId({
            stackId: expectedStackId,
            checkoutId: checkout.checkoutId,
            sessionId: input.sessionId,
        })
        const expectedSiblingsRoot = resolve(dirname(loaded.source.path), loaded.config.cockpit.siblings_root)
        if (!sameSource(checkout.source, loaded.source)
            || loaded.config.cockpit.name !== checkout.cockpitName
            || input.observedAt !== checkout.observedAt
            || Date.now() > Date.parse(checkout.validThrough)
            || input.currentCheckoutPath !== checkout.currentCheckoutPath
            || input.mainCheckoutPath !== checkout.mainCheckoutPath
            || input.cockpitId !== checkout.cockpitId
            || input.checkoutId !== checkout.checkoutId
            || input.stackId !== expectedStackId
            || input.holderId !== expectedHolderId
            || namespace.paths.lifecycle(expectedStackId).cockpitId !== checkout.cockpitId) {
            return contextRefusal(checkout.source.path)
        }
        const config = loaded.config
        const context = {
            source: {
                path: checkout.source.path,
                byteLength: checkout.source.byteLength,
                sha256: checkout.source.sha256,
            },
            mainCheckoutPath: checkout.mainCheckoutPath,
            siblingsRoot: expectedSiblingsRoot,
            siblings: config.sibling,
            policyCatalog: config.environment.install_policies,
            env,
            gitExecutable: executable,
            namespace,
            stackId: expectedStackId,
            holderId: expectedHolderId,
            writeInstructionPointers: input.writeInstructionPointers === true,
            writeInstructionFiles: input.writeInstructionFiles === true,
        }
        issuedSetupRuns.add(context)
        return { kind: 'complete', status: 0, diagnostics: [], result: context }
    } catch (error) {
        return contextRefusal('setup', `setup run authority could not be read: ${errorCause(error)}`)
    }
}

interface SiblingOperationInput {
    readonly context: SetupRunContext
    readonly siblingIndex: number
    readonly sibling: Sibling
}

interface TimedSiblingOperationInput extends SiblingOperationInput {
    readonly observedAt: string
}

export interface SetupCommandAdapters {
    load(input: SetupCommandInput): Promise<EnvironmentCommandOutcome<SetupRunContext>>
    observedAt(): string
    observeGit(input: SiblingOperationInput): Promise<SetupObservation>
    planGit(input: SiblingOperationInput & { readonly observation: SetupObservation }): Promise<EnvironmentCommandOutcome<SetupResult>>
    syncInstructionPointer?(input: Readonly<{ cockpitRoot: string; siblingRoot: string; write: boolean }>): Promise<InstructionPointerResult>
    syncInstructionFiles(input: Readonly<{ siblingRoot: string; write: boolean }>): Promise<SiblingInstructionFilesResult>
    execute(plan: ExecutionPlan): Promise<ExecutePlanOutcome>
    observeSource(path: string): Promise<ConfigSourceSnapshot>
    recordStarted(input: Pick<SetupRunContext, 'namespace' | 'stackId' | 'holderId'> & {
        readonly observedAt: string
    }): Promise<LifecycleHistoryTransition>
    withIgnore<T>(
        input: TimedSiblingOperationInput & {
            readonly environmentFileIndex: number
            readonly environmentFile: NonNullable<Sibling['environment_files']>[number]
        },
        use: () => T extends PromiseLike<unknown> ? never : T,
    ): Promise<(T extends PromiseLike<unknown> ? never : T) | EnvironmentIgnoreRefusal | undefined>
    planSeed(input: SiblingOperationInput & {
        readonly environmentFileIndex: number
        readonly environmentFile: NonNullable<Sibling['environment_files']>[number]
    }): Promise<EnvironmentSeedPlan>
    seed(plan: EnvironmentSeedPlan): EnvironmentSeedResult
    observePolicy(input: TimedSiblingOperationInput & { readonly checkoutRoot: string; readonly checkoutId: CheckoutId }): Promise<InstallPolicyLockfileObservation>
    withPolicy<T>(
        observation: InstallPolicyLockfileObservation,
        input: TimedSiblingOperationInput & { readonly checkoutRoot: string; readonly checkoutId: CheckoutId },
        use: (projection: InstallPolicyProjection) => T extends PromiseLike<unknown> ? never : T,
    ): Promise<(T extends PromiseLike<unknown> ? never : T) | undefined>
    resolvePolicy(input: SiblingOperationInput & {
        readonly checkoutRoot: string
        readonly checkoutId: CheckoutId
        readonly projection?: InstallPolicyProjection
    }): InstallPolicyResolution
}

export interface SetupApplicationResult extends SetupCommandResult {
    execution?: SetupExecutionEvidence
}

export type SetupApplicationOutcome =
    | Exclude<EnvironmentCommandOutcome<SetupApplicationResult>, { kind: 'refusal' }>
    | {
          kind: 'refusal'
          status: 2
          diagnostics: readonly EnvironmentDiagnostic[]
          result: null
          evidence?: SetupRefusalEvidence
          plan?: never
      }

export function setupEnvironment(
    input?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
    let projected: Readonly<Record<string, string>>
    try {
        const source = input === undefined
            ? process.env
            : input
        const git = gitEnvironment(source)
        const xdgStateHome = source.XDG_STATE_HOME
        projected = {
            ...git,
            ...(xdgStateHome === undefined ? {} : { XDG_STATE_HOME: xdgStateHome }),
        }
    } catch {
        // Only reading a caller-supplied environment can throw; the caller refuses it as invalid data.
        return undefined
    }
    return exactEnvironment(projected)
}

function snapshotMatches(source: SourceProvenance, snapshot: ConfigSourceSnapshot): boolean {
    return snapshot.state === 'available' && sameSource(source, snapshot)
}

function exactSeedReport(
    value: unknown,
    kind: 'created' | 'unchanged',
    siblingRoot: string,
    destination: string,
): Extract<EnvironmentSeedResult, { kind: 'created' | 'unchanged' }> | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const report = snapshot as Record<string, unknown>
    if (Object.keys(report).sort().join('\0') !== ['destination', 'kind', 'siblingRoot'].join('\0')
        || report.kind !== kind || report.siblingRoot !== siblingRoot || report.destination !== destination) return undefined
    return { kind, siblingRoot, destination }
}

function exactSetupResult(
    value: unknown,
    sibling: Sibling,
    siblingsRoot: string,
    outcomeKind: 'complete' | 'preview',
    precedingObservation: SetupObservation,
): SetupResult | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const result = snapshot as Record<string, unknown>
    const observed = result.observed
    const action = result.action
    const observation = snapshotJson(precedingObservation)
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return undefined
    const observedSnapshot = observation as Record<string, unknown>
    if (observedSnapshot.state !== 'available'
        || !observedSnapshot.value || typeof observedSnapshot.value !== 'object'
        || Array.isArray(observedSnapshot.value)) return undefined
    const evidence = observedSnapshot.value as Record<string, unknown>
    const observedKind = evidence.kind
    const origin = evidence.remotes && typeof evidence.remotes === 'object' && !Array.isArray(evidence.remotes)
        ? (evidence.remotes as Record<string, unknown>).origin
        : undefined
    const originResolution = typeof origin === 'string' ? resolveLocalRemote(origin, siblingsRoot) : undefined
    const declaredResolution = sibling.remote === undefined ? undefined : resolveLocalRemote(sibling.remote, siblingsRoot)
    const remoteMatches = originResolution?.kind === 'resolved' && declaredResolution?.kind === 'resolved'
        && originResolution.remote === declaredResolution.remote
    const allowed = outcomeKind === 'complete' && action === 'report' && (
        sibling.acquire === 'none' && ['absent', 'directory', 'repository'].includes(observedKind as string)
        || sibling.acquire === 'manual' && observedKind === 'absent'
        || observedKind === 'repository' && remoteMatches
    ) || outcomeKind === 'preview' && (
        action === 'clone' && sibling.acquire === 'auto' && observedKind === 'absent' && evidence.missingParent === undefined
        || action === 'wire-remote' && sibling.acquire === 'manual' && observedKind === 'repository' && !remoteMatches
    )
    if (Object.keys(result).sort().join('\0') !== ['action', 'changed', 'observed', 'sibling', 'target'].join('\0')
        || result.sibling !== sibling.slug || result.target !== resolve(siblingsRoot, sibling.dir)
        || result.observed !== observedKind || !allowed
        || !['absent', 'directory', 'repository', 'symlink'].includes(observed as string)
        || !['clone', 'wire-remote', 'report'].includes(action as string)
        || typeof result.changed !== 'boolean'
        || result.changed !== (action !== 'report')
        || outcomeKind === 'complete' && action !== 'report'
        || outcomeKind === 'preview' && !(
            action === 'clone' && observed === 'absent'
            || action === 'wire-remote' && observed === 'repository'
        )) return undefined
    return {
        sibling: sibling.slug,
        target: result.target as string,
        observed: observed as SetupResult['observed'],
        action: action as SetupResult['action'],
        changed: result.changed,
    }
}

function exactInstructionPointerResult(
    value: unknown,
    cockpitRoot: string,
    siblingRoot: string,
): InstructionPointerResult | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const result = snapshot as Record<string, unknown>
    const path = resolve(siblingRoot, 'AGENTS.md')
    if (result.kind === 'refusal') {
        if (Object.keys(result).sort().join('\0') !== ['kind', 'path', 'reason'].join('\0')
            || result.path !== path || typeof result.reason !== 'string' || result.reason.length === 0
            || Buffer.byteLength(result.reason) > 4_096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(result.reason)) return undefined
        return { kind: 'refusal', path, reason: result.reason }
    }
    const target = relative(siblingRoot, resolve(cockpitRoot, 'AGENTS.md')).split(sep).join('/')
    if (Object.keys(result).sort().join('\0') !== ['kind', 'path', 'target'].join('\0')
        || !['offered', 'written', 'unchanged'].includes(result.kind as string)
        || result.path !== path || result.target !== target) return undefined
    return { kind: result.kind as 'offered' | 'written' | 'unchanged', path, target }
}

function exactInstructionFilesResult(value: unknown, siblingRoot: string): SiblingInstructionFilesResult | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const result = snapshot as Record<string, unknown>
    const keys = Object.keys(result).sort().join('\0')
    if (result.root !== siblingRoot) return undefined
    if (result.kind === 'none' && keys === ['kind', 'root'].join('\0')) return { kind: 'none', root: siblingRoot }
    if (result.kind === 'refusal') {
        if (keys !== ['kind', 'reason', 'root'].join('\0') || typeof result.reason !== 'string' || result.reason.length === 0
            || Buffer.byteLength(result.reason) > 4_096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(result.reason)) return undefined
        return { kind: 'refusal', root: siblingRoot, reason: result.reason }
    }
    if (keys !== ['change', 'kind', 'root'].join('\0') || (result.kind !== 'offered' && result.kind !== 'written')
        || (result.change !== 'claude-import' && result.change !== 'move-to-agents')) return undefined
    return { kind: result.kind, root: siblingRoot, change: result.change }
}

type ReadyEnvironmentSeedPlan = Extract<EnvironmentSeedPlan, { kind: 'ready' }>
type EnvironmentSeedIdentity = ReadyEnvironmentSeedPlan['rootIdentity']
type EnvironmentSeedRefusal = Extract<EnvironmentSeedPlan, { kind: 'refusal' }>

function exactSeedIdentity(value: unknown): EnvironmentSeedIdentity | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || Object.keys(snapshot).sort().join('\0') !== ['ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'size'].join('\0')) {
        return undefined
    }
    const identity = snapshot as Record<string, unknown>
    if (Object.values(identity).some((field) => typeof field !== 'string' || !/^\d+$/.test(field))) return undefined
    return {
        dev: identity.dev as string,
        ino: identity.ino as string,
        mode: identity.mode as string,
        size: identity.size as string,
        mtimeNs: identity.mtimeNs as string,
        ctimeNs: identity.ctimeNs as string,
    }
}

function exactSeedPlan(
    value: unknown,
    siblingRoot: string,
    environmentFile: NonNullable<Sibling['environment_files']>[number],
): Exclude<EnvironmentSeedPlan, { kind: 'none' }> | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const plan = snapshot as Record<string, unknown>
    const source = resolve(siblingRoot, environmentFile.template)
    const destination = resolve(siblingRoot, environmentFile.instance)
    if (plan.kind === 'unchanged') {
        return Object.keys(plan).sort().join('\0') === ['destination', 'kind', 'siblingRoot'].join('\0')
            && plan.siblingRoot === siblingRoot && plan.destination === destination
            ? { kind: 'unchanged', siblingRoot, destination }
            : undefined
    }
    if (plan.kind === 'refusal') {
        const authenticRefusal = plan.code === ENVIRONMENT_CODES.TEMPLATE_NOT_FOUND
            ? plan.path === source
            : plan.code === ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT
                && [siblingRoot, source, destination].includes(plan.path as string)
        return Object.keys(plan).sort().join('\0') === ['code', 'kind', 'path'].join('\0')
            && typeof plan.path === 'string'
            && authenticRefusal
            ? { kind: 'refusal', code: plan.code, path: plan.path } as Extract<EnvironmentSeedPlan, { kind: 'refusal' }>
            : undefined
    }
    if (plan.kind !== 'ready'
        || Object.keys(plan).sort().join('\0') !== [
            'canonicalRoot', 'destination', 'destinationParentIdentity', 'kind', 'rootIdentity',
            'siblingRoot', 'source', 'sourceIdentity',
        ].join('\0')
        || plan.siblingRoot !== siblingRoot || plan.canonicalRoot !== siblingRoot
        || plan.source !== source || plan.destination !== destination) return undefined
    const rootIdentity = exactSeedIdentity(plan.rootIdentity)
    const sourceIdentity = exactSeedIdentity(plan.sourceIdentity)
    const destinationParentIdentity = exactSeedIdentity(plan.destinationParentIdentity)
    return rootIdentity && sourceIdentity && destinationParentIdentity
        ? {
              kind: 'ready', siblingRoot, canonicalRoot: siblingRoot, source, destination,
              rootIdentity, sourceIdentity, destinationParentIdentity,
          }
        : undefined
}

function exactSeedOutcome(
    value: unknown,
    siblingRoot: string,
    source: string,
    destination: string,
): Exclude<EnvironmentSeedResult, { kind: 'none' }> | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const result = snapshot as Record<string, unknown>
    if (result.kind === 'created' || result.kind === 'unchanged') {
        return exactSeedReport(result, result.kind, siblingRoot, destination)
    }
    const authenticRefusal = result.code === ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT
        ? [source, destination].includes(result.path as string)
        : result.code === ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED
            ? result.path === source
            : result.code === ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED && result.path === destination
    return result.kind === 'refusal'
        && Object.keys(result).sort().join('\0') === ['code', 'kind', 'path'].join('\0')
        && typeof result.path === 'string'
        && authenticRefusal
        ? { kind: 'refusal', code: result.code, path: result.path } as EnvironmentSeedRefusal
        : undefined
}

// A failed clone is the step a person most often has to fix by hand, and the executor's generic
// step failure named neither the remote nor git's reason, nor that earlier clones had succeeded.
function cloneFailureDiagnostics(
    failed: Extract<ExecutePlanOutcome, { kind: 'refusal' }>,
    sibling: Sibling,
    siblingsRoot: string,
    completedStepIds: readonly string[],
): readonly EnvironmentDiagnostic[] {
    const { id, started, stderr } = failed.execution.failedStep
    // Only a git that ran and exited non-zero failed to clone; a timeout, an abort or an unconfirmed
    // termination keeps the executor's own code, because cloning by hand could race a live git.
    const own = failed.diagnostics.find(diagnostic => diagnostic.target === id)
    if (id !== `setup:${sibling.slug}:clone` || !started || own?.code !== ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) return failed.diagnostics
    const cloned = completedStepIds.flatMap(step => /^setup:(.+):clone$/.exec(step)?.[1] ?? [])
    const target = resolve(siblingsRoot, sibling.dir)
    return [
        {
            severity: 'error',
            code: ENVIRONMENT_CODES.SETUP_CLONE_FAILED,
            message: `git could not clone ${sibling.remote?.replace(/(\w+:\/\/)[^/@\s]+@/, '$1[redacted]@')} into ${target}: ${stderr ?? 'git reported no error text'}`
                + (cloned.length === 0 ? '' : `; already cloned and left in place: ${cloned.join(', ')}`),
            target,
            fix: 'check that this machine can reach the remote (git ls-remote <remote>) and that the sibling remote in cockpit.toml is right, or clone it into the named directory yourself; then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> again',
        },
        ...failed.diagnostics.filter(diagnostic => diagnostic.target !== id),
    ]
}

function configChangedDiagnostic(source: SourceProvenance): EnvironmentDiagnostic {
    return {
        severity: 'error',
        code: ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION,
        message: 'cockpit configuration changed during setup execution',
        target: source.path,
    }
}

function refusal(
    diagnostics: readonly EnvironmentDiagnostic[],
    evidence: SetupRefusalEvidence,
): SetupApplicationOutcome {
    return { kind: 'refusal', status: 2, diagnostics: uniqueDiagnostics(diagnostics), result: null, evidence }
}

function executionEvidence(
    completedStepIds: readonly string[],
    mutationMayHaveOccurred: boolean,
    failed?: Extract<ExecutePlanOutcome, { kind: 'refusal' }>,
): SetupExecutionEvidence {
    return failed
        ? {
              mutationMayHaveOccurred: mutationMayHaveOccurred
                  || failed.execution.failedStep.started
                  || completedStepIds.length > 0,
              completedStepIds,
              failedStep: { id: failed.execution.failedStep.id, started: failed.execution.failedStep.started },
              compensation: failed.execution.compensation,
          }
        : {
              mutationMayHaveOccurred,
              completedStepIds,
              compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
          }
}

async function sequenceRefusal(
    context: SetupRunContext,
    adapters: SetupCommandAdapters,
    diagnostics: readonly EnvironmentDiagnostic[],
    evidence: SetupExecutionEvidence,
): Promise<SetupApplicationOutcome> {
    const after = await adapters.observeSource(context.source.path)
    const allDiagnostics = [...diagnostics]
    if (!snapshotMatches(context.source, after)) allDiagnostics.push(configChangedDiagnostic(context.source))
    return refusal(allDiagnostics, { execution: evidence, source: { before: context.source, after } })
}

function attributePlannerDiagnostics(
    diagnostics: readonly EnvironmentDiagnostic[],
    sourcePath: string,
): readonly EnvironmentDiagnostic[] {
    return diagnostics.map((diagnostic) => {
        const originalTarget = diagnostic.target
        const suffix = originalTarget && originalTarget !== sourcePath ? ` (${originalTarget})` : ''
        return {
            ...diagnostic,
            message: suffix && !diagnostic.message.endsWith(suffix)
                ? `${diagnostic.message}${suffix}`
                : diagnostic.message,
            target: sourcePath,
        }
    })
}

function exactIgnoreRefusal(
    value: unknown,
    environmentFile: NonNullable<Sibling['environment_files']>[number],
): EnvironmentIgnoreRefusal | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
        && Object.keys(snapshot).sort().join('\0') === ['code', 'kind', 'path'].join('\0')) {
        const refusal = snapshot as Record<string, unknown>
        if (refusal.kind === 'refusal'
            && [
                ENVIRONMENT_CODES.TEMPLATE_NOT_TRACKED,
                ENVIRONMENT_CODES.TEMPLATE_IGNORED,
                ENVIRONMENT_CODES.INSTANCE_NOT_IGNORED,
            ].includes(refusal.code as never)
            && refusal.path === (refusal.code === ENVIRONMENT_CODES.INSTANCE_NOT_IGNORED
                ? environmentFile.instance
                : environmentFile.template)) {
            return {
                kind: 'refusal',
                code: refusal.code as EnvironmentIgnoreRefusal['code'],
                path: refusal.path,
            }
        }
    }
    return undefined
}

function ignoreDiagnostic(
    value: unknown,
    environmentFile: NonNullable<Sibling['environment_files']>[number],
    unavailableTarget: string,
    refusalMessage: string,
): EnvironmentDiagnostic | undefined {
    if (value === true) return undefined
    const refusal = exactIgnoreRefusal(value, environmentFile)
    if (refusal) return ownerDiagnostic(refusal.code, refusalMessage, refusal.path)
    return ownerDiagnostic(
        ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
        'environment ignore evidence is unavailable',
        unavailableTarget,
    )
}

function exactPolicyBindings(
    value: readonly ResolvedInstallPolicyBinding[],
    context: SetupRunContext,
    siblingIndex: number,
    sibling: Sibling,
    checkoutRoot: string,
    checkoutId: CheckoutId,
): readonly ResolvedInstallPolicyBinding[] | undefined {
    const snapshot = snapshotJson(value)
    if (!Array.isArray(snapshot) || snapshot.length !== 1) return undefined
    const binding = snapshot[0]
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return undefined
    const candidate = binding as unknown as ResolvedInstallPolicyBinding
    const catalogIndex = candidate.diagnostics?.catalogIndex
    const policy = Number.isSafeInteger(catalogIndex) ? context.policyCatalog[catalogIndex] : undefined
    if (Object.keys(binding).sort().join('\0') !== [
        'checkoutId', 'checkoutRoot', 'diagnostics', 'policy', 'siblingIndex', 'siblingSlug', 'source',
    ].sort().join('\0')
        || !candidate.source || Object.keys(candidate.source).sort().join('\0') !== ['byteLength', 'path', 'sha256'].join('\0')
        || !candidate.diagnostics || Object.keys(candidate.diagnostics).join('\0') !== 'catalogIndex'
        || !policy || !sameSource(candidate.source, context.source)
        || candidate.siblingIndex !== siblingIndex || candidate.siblingSlug !== sibling.slug
        || candidate.checkoutRoot !== checkoutRoot || candidate.checkoutId !== checkoutId
        || JSON.stringify(snapshotJson(candidate.policy)) !== JSON.stringify(snapshotJson(policy))) return undefined
    return [{
        source: context.source,
        siblingIndex,
        diagnostics: { catalogIndex: catalogIndex as number },
        siblingSlug: sibling.slug,
        checkoutRoot,
        checkoutId,
        policy: snapshotJson(policy) as unknown as ResolvedInstallPolicyBinding['policy'],
    }]
}

export async function runSetup(
    input: SetupCommandInput,
    adapters: SetupCommandAdapters,
): Promise<SetupApplicationOutcome> {
    const loaded = await adapters.load(input)
    if (loaded.kind === 'refusal') return loaded
    if (loaded.kind === 'preview') {
        return {
            kind: 'refusal', status: 2, result: null,
            diagnostics: [ownerDiagnostic(
                ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
                'setup context was not fully resolved',
                input.configPath,
            )],
        }
    }
    const context = loaded.result
    if (!issuedSetupRuns.has(context)) return contextRefusal()
    issuedSetupRuns.delete(context)
    const diagnostics: EnvironmentDiagnostic[] = [...loaded.diagnostics]
    const siblings: SetupResult[] = []
    const environmentFiles: Extract<EnvironmentSeedResult, { kind: 'created' | 'unchanged' }>[] = []
    const policies: ResolvedInstallPolicyBinding[] = []
    const completedStepIds: string[] = []
    let mutationMayHaveOccurred = false
    let lifecycleStarted = false

    const refuseSourceDrift = async (): Promise<SetupApplicationOutcome | undefined> => {
        const after = await adapters.observeSource(context.source.path)
        return snapshotMatches(context.source, after)
            ? undefined
            : refusal(
                  [...diagnostics, configChangedDiagnostic(context.source)],
                  {
                      execution: executionEvidence(completedStepIds, mutationMayHaveOccurred),
                      source: {
                          before: context.source,
                          after,
                          ...(after.state === 'available'
                              ? { postcheck: { path: after.path, byteLength: after.byteLength, sha256: after.sha256 } }
                              : {}),
                      },
                  },
              )
    }

    const nextOperationTimestamp = async (): Promise<string | SetupApplicationOutcome> => {
        let observedAt: unknown
        let cause = ''
        try {
            observedAt = adapters.observedAt()
        } catch (error) {
            cause = `: ${errorCause(error)}`
        }
        return isCanonicalTimestamp(observedAt)
            ? observedAt
            : sequenceRefusal(
                  context,
                  adapters,
                  [...diagnostics, ownerDiagnostic(
                      ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
                      `setup operation timestamp is unavailable${cause}`,
                      context.source.path,
                  )],
                  executionEvidence(completedStepIds, mutationMayHaveOccurred),
              )
    }

    const startLifecycle = async (): Promise<SetupApplicationOutcome | undefined> => {
        if (lifecycleStarted) return undefined
        const sourceFailure = await refuseSourceDrift()
        if (sourceFailure) return sourceFailure
        const observedAt = await nextOperationTimestamp()
        if (typeof observedAt !== 'string') return observedAt
        const transition = await adapters.recordStarted({
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            observedAt,
        })
        if (transition.kind === 'refusal') {
            return sequenceRefusal(
                context,
                adapters,
                [...diagnostics, ...transition.diagnostics],
                executionEvidence(completedStepIds, mutationMayHaveOccurred),
            )
        }
        mutationMayHaveOccurred ||= transition.kind === 'complete'
        lifecycleStarted = true
        return undefined
    }

    for (const [siblingIndex, sibling] of context.siblings.entries()) {
        const siblingInput = { context, siblingIndex, sibling }
        const observation = await adapters.observeGit(siblingInput)
        const planned = await adapters.planGit({ ...siblingInput, observation })
        if (planned.kind === 'refusal') {
            return sequenceRefusal(
                context,
                adapters,
                [...diagnostics, ...attributePlannerDiagnostics(planned.diagnostics, context.source.path)],
                executionEvidence(completedStepIds, mutationMayHaveOccurred),
            )
        }
        const plannedResult = exactSetupResult(planned.result, sibling, context.siblingsRoot, planned.kind, observation)
        if (!plannedResult) {
            return sequenceRefusal(
                context,
                adapters,
                [...diagnostics, ownerDiagnostic(
                    ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
                    'setup plan returned an invalid repository report',
                    resolve(context.siblingsRoot, sibling.dir),
                )],
                executionEvidence(completedStepIds, mutationMayHaveOccurred),
            )
        }
        diagnostics.push(...planned.diagnostics)
        let siblingResult = plannedResult
        if (planned.kind === 'preview') {
            const lifecycleFailure = await startLifecycle()
            if (lifecycleFailure) return lifecycleFailure
            const sourceFailure = await refuseSourceDrift()
            if (sourceFailure) return sourceFailure
            const execution = await adapters.execute(planned.plan)
            if (execution.kind === 'refusal') {
                return sequenceRefusal(
                    context,
                    adapters,
                    [...diagnostics, ...cloneFailureDiagnostics(execution, sibling, context.siblingsRoot, completedStepIds)],
                    executionEvidence(
                        [...completedStepIds, ...execution.execution.completedStepIds],
                        mutationMayHaveOccurred,
                        execution,
                    ),
                )
            }
            const stepIds = execution.result.steps.map(({ id }) => id)
            completedStepIds.push(...stepIds)
            mutationMayHaveOccurred ||= stepIds.length > 0
            const checkedObservation = await adapters.observeGit(siblingInput)
            const checked = await adapters.planGit({ ...siblingInput, observation: checkedObservation })
            const after = await adapters.observeSource(context.source.path)
            const checkedResult = checked.kind === 'complete'
                ? exactSetupResult(checked.result, sibling, context.siblingsRoot, 'complete', checkedObservation)
                : undefined
            if (!snapshotMatches(context.source, after) || !checkedResult) {
                const checkedDiagnostics = checked.kind === 'refusal'
                    ? attributePlannerDiagnostics(checked.diagnostics, context.source.path)
                    : checked.diagnostics
                return refusal(
                    uniqueDiagnostics([
                        ...diagnostics,
                        ...checkedDiagnostics,
                        !snapshotMatches(context.source, after)
                            ? configChangedDiagnostic(context.source)
                            : ownerDiagnostic(
                                  ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
                                  'setup execution completed but its postcheck did not verify the declared state',
                                  context.source.path,
                              ),
                    ]),
                    {
                        execution: executionEvidence(completedStepIds, mutationMayHaveOccurred),
                        source: {
                            before: context.source,
                            after,
                            ...(checked.kind !== 'refusal' && after.state === 'available'
                                ? { postcheck: { path: after.path, byteLength: after.byteLength, sha256: after.sha256 } }
                                : {}),
                        },
                    },
                )
            }
            diagnostics.push(...checked.diagnostics)
            siblingResult = checkedResult
        }

        // The cockpit's own directory gets its AGENTS.md and CLAUDE.md from sync, not from setup, and a
        // checkout setup leaves absent (acquire = "none") has no files to change.
        if (siblingResult.target !== dirname(context.source.path) && siblingResult.observed !== 'absent') {
            if (context.writeInstructionFiles) {
                const lifecycleFailure = await startLifecycle()
                if (lifecycleFailure) return lifecycleFailure
                const sourceFailure = await refuseSourceDrift()
                if (sourceFailure) return sourceFailure
            }
            const files = exactInstructionFilesResult(await adapters.syncInstructionFiles({
                siblingRoot: siblingResult.target,
                write: context.writeInstructionFiles,
            }), siblingResult.target)
            if (!files || files.kind === 'refusal') {
                return sequenceRefusal(context, adapters, [...diagnostics, ownerDiagnostic(
                    ENVIRONMENT_CODES.SETUP_INSTRUCTION_FILES_INVALID,
                    files ? files.reason : 'sibling instruction file result was not bound to the declared sibling',
                    siblingResult.target,
                )], executionEvidence(completedStepIds, mutationMayHaveOccurred))
            }
            if (files.kind === 'offered') diagnostics.push({
                severity: 'info',
                code: ENVIRONMENT_CODES.SETUP_INSTRUCTION_FILES_OFFERED,
                message: files.change === 'claude-import'
                    ? `sibling ${sibling.slug} has AGENTS.md but no CLAUDE.md; setup would create CLAUDE.md holding the single line @AGENTS.md, so Claude Code loads the same instructions as Codex and OpenCode`
                    : `sibling ${sibling.slug} has CLAUDE.md but no AGENTS.md; setup would copy CLAUDE.md byte for byte to AGENTS.md and replace CLAUDE.md with the single line @AGENTS.md, so Codex and OpenCode load the same instructions as Claude Code`,
                target: siblingResult.target,
                fix: 'review the proposed change with a person, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-files',
            })
            mutationMayHaveOccurred ||= files.kind === 'written'
        }

        if (sibling.instruction_pointer) {
            if (!adapters.syncInstructionPointer) {
                return sequenceRefusal(context, adapters, [...diagnostics, ownerDiagnostic(
                    ENVIRONMENT_CODES.SETUP_INSTRUCTION_POINTER_INVALID,
                    'instruction pointer support is unavailable',
                    siblingResult.target,
                )], executionEvidence(completedStepIds, mutationMayHaveOccurred))
            }
            if (context.writeInstructionPointers) {
                const lifecycleFailure = await startLifecycle()
                if (lifecycleFailure) return lifecycleFailure
                const sourceFailure = await refuseSourceDrift()
                if (sourceFailure) return sourceFailure
            }
            const pointer = exactInstructionPointerResult(await adapters.syncInstructionPointer({
                cockpitRoot: dirname(context.source.path),
                siblingRoot: siblingResult.target,
                write: context.writeInstructionPointers,
            }), dirname(context.source.path), siblingResult.target)
            if (!pointer) {
                return sequenceRefusal(context, adapters, [...diagnostics, ownerDiagnostic(
                    ENVIRONMENT_CODES.SETUP_INSTRUCTION_POINTER_INVALID,
                    'instruction pointer result was not bound to the declared sibling guide',
                    siblingResult.target,
                )], executionEvidence(completedStepIds, mutationMayHaveOccurred))
            }
            if (pointer.kind === 'refusal') {
                return sequenceRefusal(context, adapters, [...diagnostics, ownerDiagnostic(
                    ENVIRONMENT_CODES.SETUP_INSTRUCTION_POINTER_INVALID,
                    pointer.reason,
                    pointer.path,
                )], executionEvidence(completedStepIds, mutationMayHaveOccurred))
            }
            if (pointer.kind === 'offered') diagnostics.push({
                severity: 'info',
                code: ENVIRONMENT_CODES.SETUP_INSTRUCTION_POINTER_OFFERED,
                message: 'the declared sibling has no cockpit instruction pointer',
                target: pointer.path,
                fix: 'review the proposed AGENTS.md block, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-pointers',
            })
            mutationMayHaveOccurred ||= pointer.kind === 'written'
        }

        for (const [environmentFileIndex, environmentFile] of (sibling.environment_files ?? []).entries()) {
            const ignoreInput = { ...siblingInput, environmentFileIndex, environmentFile }
            const expectedSiblingRoot = siblingResult.target
            const expectedDestination = resolve(expectedSiblingRoot, environmentFile.instance)
            const initialObservedAt = await nextOperationTimestamp()
            if (typeof initialObservedAt !== 'string') return initialObservedAt
            const initialAuthority = await adapters.withIgnore({
                ...ignoreInput,
                observedAt: initialObservedAt,
            }, () => true)
            const initialAuthorityDiagnostic = ignoreDiagnostic(
                initialAuthority,
                environmentFile,
                siblingResult.target,
                'environment instance could not be seeded',
            )
            if (initialAuthorityDiagnostic) {
                return sequenceRefusal(
                    context,
                    adapters,
                    [...diagnostics, initialAuthorityDiagnostic],
                    executionEvidence(completedStepIds, mutationMayHaveOccurred),
                )
            }
            let seedPlan = exactSeedPlan(
                await adapters.planSeed(ignoreInput),
                expectedSiblingRoot,
                environmentFile,
            )
            if (!seedPlan) {
                return sequenceRefusal(
                    context,
                    adapters,
                    [...diagnostics, ownerDiagnostic(
                        ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
                        'environment instance plan did not match the declared state',
                        siblingResult.target,
                    )],
                    executionEvidence(completedStepIds, mutationMayHaveOccurred),
                )
            }
            if (seedPlan.kind === 'refusal') {
                return sequenceRefusal(
                    context,
                    adapters,
                    [...diagnostics, ownerDiagnostic(seedPlan.code, 'environment instance could not be seeded', seedPlan.path)],
                    executionEvidence(completedStepIds, mutationMayHaveOccurred),
                )
            }
            if (seedPlan.kind === 'unchanged') {
                const report = exactSeedReport(
                    seedPlan,
                    'unchanged',
                    expectedSiblingRoot,
                    expectedDestination,
                )
                if (!report) {
                    return sequenceRefusal(
                        context,
                        adapters,
                        [...diagnostics, ownerDiagnostic(
                            ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
                            'environment instance report did not match the declared state',
                            siblingResult.target,
                        )],
                        executionEvidence(completedStepIds, mutationMayHaveOccurred),
                    )
                }
                const finalObservedAt = await nextOperationTimestamp()
                if (typeof finalObservedAt !== 'string') return finalObservedAt
                const finalAuthority = await adapters.withIgnore({
                    ...ignoreInput,
                    observedAt: finalObservedAt,
                }, () => true)
                const finalAuthorityDiagnostic = ignoreDiagnostic(
                    finalAuthority,
                    environmentFile,
                    siblingResult.target,
                    'environment instance could not be verified',
                )
                if (finalAuthorityDiagnostic) {
                    return sequenceRefusal(
                        context,
                        adapters,
                        [...diagnostics, finalAuthorityDiagnostic],
                        executionEvidence(completedStepIds, mutationMayHaveOccurred),
                    )
                }
                environmentFiles.push(report)
            }
            if (seedPlan.kind === 'ready') {
                const readyPlan = seedPlan
                const lifecycleFailure = await startLifecycle()
                if (lifecycleFailure) return lifecycleFailure
                const sourceFailure = await refuseSourceDrift()
                if (sourceFailure) return sourceFailure
                const seedObservedAt = await nextOperationTimestamp()
                if (typeof seedObservedAt !== 'string') return seedObservedAt
                const seededValue = await adapters.withIgnore({
                    ...ignoreInput,
                    observedAt: seedObservedAt,
                }, () => adapters.seed(readyPlan))
                if (seededValue === undefined) {
                    return sequenceRefusal(
                        context,
                        adapters,
                        [...diagnostics, ownerDiagnostic(
                            ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
                            'environment ignore evidence is unavailable',
                            siblingResult.target,
                        )],
                        executionEvidence(completedStepIds, mutationMayHaveOccurred),
                    )
                }
                const ignoreRefusal = exactIgnoreRefusal(seededValue, environmentFile)
                if (ignoreRefusal) {
                    return sequenceRefusal(
                        context,
                        adapters,
                        [...diagnostics, ownerDiagnostic(
                            ignoreRefusal.code,
                            'environment instance seed failed',
                            ignoreRefusal.path,
                        )],
                        executionEvidence(completedStepIds, true),
                    )
                }
                const seeded = exactSeedOutcome(
                    seededValue,
                    expectedSiblingRoot,
                    readyPlan.source,
                    expectedDestination,
                )
                if (!seeded) {
                    return sequenceRefusal(
                        context,
                        adapters,
                        [...diagnostics, ownerDiagnostic(
                            ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
                            'environment instance seed returned an invalid report',
                            siblingResult.target,
                        )],
                        executionEvidence(completedStepIds, true),
                    )
                }
                if (seeded.kind === 'refusal') {
                    return sequenceRefusal(
                        context,
                        adapters,
                        [...diagnostics, ownerDiagnostic(seeded.code, 'environment instance seed failed', seeded.path)],
                        executionEvidence(completedStepIds, true),
                    )
                }
                mutationMayHaveOccurred ||= seeded.kind === 'created'
                seedPlan = exactSeedPlan(
                    await adapters.planSeed(ignoreInput),
                    expectedSiblingRoot,
                    environmentFile,
                )
                const postcheckReport = seedPlan?.kind === 'unchanged'
                    ? exactSeedReport(seedPlan, 'unchanged', expectedSiblingRoot, expectedDestination)
                    : undefined
                const finalObservedAt = await nextOperationTimestamp()
                if (typeof finalObservedAt !== 'string') return finalObservedAt
                const finalAuthority = await adapters.withIgnore({
                    ...ignoreInput,
                    observedAt: finalObservedAt,
                }, () => true)
                const afterSeed = await adapters.observeSource(context.source.path)
                if (!snapshotMatches(context.source, afterSeed) || !postcheckReport
                    || finalAuthority !== true) {
                    const authorityDiagnostic = ignoreDiagnostic(
                        finalAuthority,
                        environmentFile,
                        siblingResult.target,
                        'environment instance could not be verified',
                    )
                    return sequenceRefusal(
                        context,
                        adapters,
                        [
                            ...diagnostics,
                            ...(authorityDiagnostic ? [authorityDiagnostic] : []),
                            ...(!snapshotMatches(context.source, afterSeed)
                                ? [configChangedDiagnostic(context.source)]
                                : []),
                            ...(!postcheckReport
                                ? [ownerDiagnostic(
                                      ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
                                      'environment instance postcheck did not verify the declared state',
                                      siblingResult.target,
                                  )]
                                : []),
                        ],
                        executionEvidence(completedStepIds, mutationMayHaveOccurred),
                    )
                }
                environmentFiles.push(seeded)
            }
        }

        const checkoutRoot = siblingResult.target
        const checkoutId = deriveCheckoutId({ checkoutPath: checkoutRoot })
        if (sibling.toolchain !== 'none') {
            const observedAt = await nextOperationTimestamp()
            if (typeof observedAt !== 'string') return observedAt
            const policyInput = { ...siblingInput, checkoutRoot, checkoutId, observedAt }
            const policyObservation = await adapters.observePolicy(policyInput)
            const resolution = await adapters.withPolicy(
                policyObservation,
                policyInput,
                (projection) => adapters.resolvePolicy({ ...siblingInput, checkoutRoot, checkoutId, projection }),
            )
            if (resolution === undefined || resolution.kind === 'unavailable' || resolution.kind === 'refusal') {
                const code = resolution?.code ?? ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE
                const message = resolution?.kind === 'refusal'
                    ? 'declared dependency policy could not be resolved exactly'
                    : resolution?.reason ?? 'dependency policy evidence is unavailable'
                return sequenceRefusal(
                    context,
                    adapters,
                    [...diagnostics, ownerDiagnostic(code, message, checkoutRoot)],
                    executionEvidence(completedStepIds, mutationMayHaveOccurred),
                )
            }
            const bindings = exactPolicyBindings(
                resolution.bindings,
                context,
                siblingIndex,
                sibling,
                checkoutRoot,
                checkoutId,
            )
            if (!bindings) {
                return sequenceRefusal(
                    context,
                    adapters,
                    [...diagnostics, ownerDiagnostic(
                        ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE,
                        'dependency policy binding does not match the sibling authority',
                        checkoutRoot,
                    )],
                    executionEvidence(completedStepIds, mutationMayHaveOccurred),
                )
            }
            policies.push(...bindings)
        }
        siblings.push(siblingResult)
    }

    const sourceFailure = await refuseSourceDrift()
    if (sourceFailure) return sourceFailure

    return {
        kind: 'complete',
        status: 0,
        diagnostics: uniqueDiagnostics(diagnostics),
        result: {
            source: context.source,
            siblings,
            ...(environmentFiles.length > 0 ? { environmentFiles } : {}),
            ...(policies.length > 0 ? { installPolicies: policies } : {}),
            ...(mutationMayHaveOccurred
                ? { execution: executionEvidence(completedStepIds, mutationMayHaveOccurred) }
                : {}),
        },
    }
}
