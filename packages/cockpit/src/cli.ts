import { randomUUID } from 'node:crypto'
import { installedPackageMetadata } from './package-metadata.js'
import { validateTeamMetadata, type TeamMetadataResult } from './team-metadata.js'
import { discoverReleaseFreshness, type ReleaseMetadataTransport } from './freshness.js'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { parse as parseToml } from 'smol-toml'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs, types as utilTypes } from 'node:util'
import { createInvocationRecord, EXIT_CODES } from './invocation.js'
import { commands, describePublicOption, internalCommands, isWorkHandler, isRecordedAnswerField, resolveOrdinaryInvocation, type CommandDefinition, type HandlerIdentifier, type WorkHandlerIdentifier } from './command-table.js'
import { GUARD_INPUT_LIMITS } from './guards/invocation-parser.js'
import { adaptGuardDecision, normalizeOpenCodeInput } from './guards/harness-adapter.js'
import { SURFACE_TARGETS, type SurfaceTarget } from './surfaces/contract.js'
import { isGuardSurfaceTarget, type GuardSurfaceTarget } from './surfaces/harness-registry.js'
import type { FixContext } from './fix-catalogue.js'
import { type Diagnostic, renderHumanDiagnostics, renderHumanValue, renderJsonResponse } from './diagnostics.js'
import { classifyEstateObservation, documentCommand, documentObservedCommand, observeCockpitRoot, observePublicEstate, type DocumentCommandInput } from './document/command.js'
import { runInitOperatorCommand, type UnattendedInit } from './init/command.js'
import { deriveInferredFacts } from './init/derive.js'
import { runInitApplication, type InitApplicationInput, type InitApplicationOutcome, type InitResult } from './environment/init-application.js'
import { nodeAuthority, readAnchoredBatches } from './generated-environment/transaction.js'
import {
    registryResolveCommand,
    type RegistryResolveCommandInput,
} from './registry-resolve/command.js'
import { setupCommand, type SetupCommandInput } from './setup/command.js'
import {
    type DoctorCommandInput,
    type DownCommandInput,
    type PreflightCommandInput,
    type ResetCommandInput,
    type SleepCommandInput,
    type UpCommandInput,
    beginOperatorReset as beginOperatorResetApplication,
    beginOperatorBaselineRecord as beginOperatorBaselineRecordApplication,
    runDoctor as runDoctorApplication,
    runDown as runDownApplication,
    runLogs as runLogsApplication,
    runPreflight as runPreflightApplication,
    runReset as runResetApplication,
    runSession as runSessionApplication,
    runSleep as runSleepApplication,
    runUp as runUpApplication,
    runGuardEvaluationApplication,
} from './environment/application.js'
import { executeForegroundProcess, executePlan, executeProbe } from './environment-exec/execute.js'
import { createDestructiveCommandAdapters, selectDestructiveDaemon } from './environment/destructive-composition.js'
import { createHealthCommandAdapters } from './environment/health-composition.js'
import { createLifecycleCommandAdapters } from './environment/lifecycle-composition.js'
import { createReadCommandAdapters } from './environment/read-composition.js'
import { probeInstalledRuntime, runRuntimeMeasure } from './environment/runtime-measurement.js'
import { initializeLocalGitRepository, runSiblingAdd, runSiblingRemove, type SiblingAddInput, type SiblingRemoveInput } from './environment/sibling-registration.js'
import {
    issueSetupRunContext,
    setupEnvironment,
    type SetupCommandAdapters,
    type SetupRunContext,
} from './environment/application.js'
import {
    consumeSetupCheckoutProjection,
    observeEnvironmentIgnore,
    observeSetupCheckout,
    observeSetupPath,
    withSetupCheckoutProjection,
} from './environment/setup-observation.js'
import {
    ENVIRONMENT_CODES,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type SetupRefusalEvidence,
} from './environment/contract.js'
import { loadCockpitConfig, observeConfigSource, readBoundedInput } from './config/load.js'
import { gitEnvironment, planSetup } from './environment/setup.js'
import { synchronizeInstructionPointer } from './environment/instruction-pointer.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolvedGitExecutable, resolveDockerExecutable, resolveExecutable, resolveGitExecutable } from './environment/executable.js'
import { checkoutId, holderId, stackId } from './environment/identity.js'
import { selectStateRoot } from './environment/state.js'
import { recordLifecycleStarted } from './environment/lifecycle-stage.js'
import { planEnvironmentSeed, seedEnvironmentInstanceSync } from './environment/templates.js'
import {
    observeInstallPolicyLockfiles,
    withInstallPolicyProjection,
} from './environment/install-policy-observation.js'
import { resolveInstallPolicies } from './environment/install-policy.js'
import {
    prepareSelectedBootstrapSurface, resumeSelectedBootstrapSurface, applySelectedBootstrapSurface,
    checkGeneratedEnvironment,
    syncTeamGeneratedEnvironment,
    adoptAndSyncGeneratedEnvironment,
    runSyncOperatorCommand,
    type GeneratedEnvironmentCommandInput,
    type GeneratedEnvironmentCommandOutcome,
} from './generated-environment/command.js'
import type {
    GeneratedStaleRemovalApproval,
    GeneratedStaleRemovalApprovalRequest,
} from './environment/generated-application.js'
import { inspectCodexHookTrust } from './environment/codex-hook-trust.js'
import { runConfiguredUpgradeCommand } from './upgrade/command.js'
import { createReleaseEvidenceDiscovery } from './upgrade/release-evidence.js'
import {
    runConfiguredSurfaceSelftestOutcome,
    runSelftestOperatorCommand,
    type SurfaceSelftestExecutableCandidate,
    type SurfaceSelftestProbeSpecificationsCandidate,
} from './selftest/command.js'
import {
    runBaselineOperatorApplication,
    runResetOperatorApplication,
} from './environment/operator-application.js'

import type { WorkApplicationOutcome, WorkApplicationRequest } from './work-orders/application.js'

export const mechanism = {
    id: 'command-dispatch',
    module: 'packages/cockpit/src/cli.ts',
    exports: ['runCli'],
} as const

export interface CliIo {
    stdout: Pick<NodeJS.WriteStream, 'write'>
    stderr: Pick<NodeJS.WriteStream, 'write'>
    stdin?: NodeJS.ReadStream
    confirmInit?: (preview: InitResult) => Promise<string | undefined>
    answerInitQuestion?: (question: NonNullable<InitResult['question']>) => Promise<string | undefined>
    confirmReset?: (preview: CommandOutcome) => Promise<boolean>
    confirmBaseline?: (preview: CommandOutcome) => Promise<boolean>
    confirmWorkOrder?: (candidate: Readonly<{ digest: string; prompt: string }>) => Promise<string | undefined>
    confirmSelftestExecutable?: (candidate: SurfaceSelftestExecutableCandidate) => Promise<string | undefined>
    confirmSelftestProbeSpecifications?: (
        candidate: SurfaceSelftestProbeSpecificationsCandidate,
    ) => Promise<string | undefined>
    confirmStaleRemoval?: (request: GeneratedStaleRemovalApprovalRequest) => Promise<string | undefined>
}

export interface CliRuntime {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly signal?: AbortSignal
    readonly createReleaseMetadataTransport?: () => ReleaseMetadataTransport
}

export interface CommandOutcome {
    artifact?: string | null
    destination?: string | null
    diagnostics: readonly Diagnostic[]
    evidence?: SetupRefusalEvidence
    result: unknown
    status: number
    fixContext?: FixContext
}

interface WorkCommandInput { readonly configPath: string; readonly request: WorkApplicationRequest }

interface HandlerInputById extends Record<WorkHandlerIdentifier, WorkCommandInput> {
    'baseline-record': Readonly<{ configPath: string; confirmation: string; recordedAt: string }>
    check: GeneratedEnvironmentCommandInput
    init: InitApplicationInput & Readonly<{ unattended?: UnattendedInit }>
    doctor: DoctorCommandInput
    document: DocumentCommandInput
    down: DownCommandInput
    logs: Readonly<{
        configPath: string
        service: string
        since: string
        tail: number
        follow: boolean
        json: boolean
    }>
    preflight: PreflightCommandInput
    'registry-resolve': RegistryResolveCommandInput
    reset: ResetCommandInput
    runtime: Readonly<{ configPath: string; image: string }>
    sibling: Readonly<{ operation: 'add'; input: Omit<SiblingAddInput, 'env'> }> | Readonly<{ operation: 'remove'; input: Omit<SiblingRemoveInput, 'env'> }>
    setup: SetupCommandInput
    selftest: Readonly<{
        configPath: string
        probeSpecificationsPath: string
        env: Readonly<Record<string, string | undefined>>
        requestExecutableApproval?: (candidate: SurfaceSelftestExecutableCandidate) => Promise<string | undefined>
        requestProbeSpecificationsApproval?: (
            candidate: SurfaceSelftestProbeSpecificationsCandidate,
        ) => Promise<string | undefined>
    }>
    session: Readonly<{ configPath: string; argv: readonly [string, ...string[]]; sessionId: string }>
    sleep: SleepCommandInput
    sync: GeneratedEnvironmentCommandInput & Readonly<{
        dryRun?: boolean
        adopt?: readonly string[]
        authorizeStaleRemoval?: (
            request: GeneratedStaleRemovalApprovalRequest,
        ) => Promise<GeneratedStaleRemovalApproval | undefined>
    }>
    up: UpCommandInput
    upgrade: Readonly<{
        configPath: string
        releaseEvidencePath?: string
        releaseEvidenceSha256?: string
    }>
}

export type CommandHandlers = {
    [Identifier in HandlerIdentifier]: (
        input: HandlerInputById[Identifier],
    ) => Promise<Identifier extends 'init' ? InitApplicationOutcome : CommandOutcome>
}

interface OperatorResetBinding {
    readonly preview: CommandOutcome
    decide(decision: 'approve' | 'decline'): Promise<CommandOutcome>
}

interface OperatorBaselineBinding {
    readonly preview: CommandOutcome
    decide(decision: 'approve' | 'decline'): Promise<CommandOutcome>
}

interface OperatorWorkBinding { readonly digest: string; readonly prompt: string; decide(answer: string): Promise<CommandOutcome> }

export type CliHandlerOverrides = Partial<CommandHandlers> & Readonly<{
    beginOperatorWorkApplication?: (input: WorkCommandInput) => Promise<OperatorWorkBinding | CommandOutcome>
    beginOperatorReset?: (input: ResetCommandInput) => Promise<OperatorResetBinding | CommandOutcome>
    beginOperatorBaselineRecord?: (input: { readonly configPath: string }) => Promise<OperatorBaselineBinding | CommandOutcome>
}>

type OperatorHandlers = Pick<CliHandlerOverrides, 'beginOperatorReset' | 'beginOperatorBaselineRecord' | 'beginOperatorWorkApplication'>

type HandlerRequest = {
    [Identifier in Exclude<HandlerIdentifier, 'baseline-record'>]: {
        handler: Identifier
        input: HandlerInputById[Identifier]
    }
}[Exclude<HandlerIdentifier, 'baseline-record'>] | Readonly<{
    handler: 'baseline-record'
    input: Readonly<{ configPath: string }>
}>

interface ParsedCommandArguments {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>
    positionals: string[]
}

function setupDiagnostic(code: EnvironmentDiagnostic['code'], message: string, target: string): EnvironmentDiagnostic {
    return { severity: 'error', code, message, target }
}

function setupRefusal(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
): EnvironmentCommandOutcome<SetupRunContext> {
    return { kind: 'refusal', status: 2, diagnostics: [setupDiagnostic(code, message, target)], result: null }
}

async function loadSetupContext(input: SetupCommandInput): Promise<EnvironmentCommandOutcome<SetupRunContext>> {
    let configPath: string
    let searchEnvironment: Readonly<Record<string, string | undefined>>
    let suppliedExecutable: unknown
    try {
        configPath = input.configPath
        const suppliedEnvironment = input.env
        searchEnvironment = suppliedEnvironment === undefined ? process.env : suppliedEnvironment
        suppliedExecutable = input.gitExecutable
    } catch {
        return setupRefusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, 'setup input is not readable', 'setup')
    }
    const ambient = setupEnvironment(searchEnvironment)
    if (!ambient) {
        return setupRefusal(
            ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
            'setup environment is not valid bounded data',
            'setup-environment',
        )
    }
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind === 'refusal') return loaded
    const supplied = suppliedExecutable === undefined ? undefined : resolvedGitExecutable(suppliedExecutable)
    const executable = suppliedExecutable === undefined
        ? await resolveGitExecutable(searchEnvironment)
        : supplied
            ? { state: 'available' as const, value: supplied }
            : { state: 'unavailable' as const, reason: 'Git executable identity is invalid' }
    if (executable.state === 'unavailable') {
        return setupRefusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, executable.reason, loaded.result.source.path)
    }

    const observedAt = new Date().toISOString()
    const setupCheckout = await observeSetupCheckout({
        source: loaded.result.source,
        cockpitName: loaded.result.config.cockpit.name,
        observedAt,
        env: ambient,
        gitExecutable: executable.value,
    })
    const checkout = await withSetupCheckoutProjection(
        setupCheckout,
        {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(observedAt),
        },
        consumeSetupCheckoutProjection,
    )
    if (!checkout) {
        const reason = setupCheckout.state === 'failed'
            ? setupCheckout.reason
            : 'setup checkout evidence is unavailable'
        return setupRefusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, reason, loaded.result.source.path)
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return setupRefusal(
            ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            'state root is unavailable on this platform',
            process.platform,
        )
    }
    const selected = await selectStateRoot({
        platform: process.platform,
        home: ambient.HOME,
        xdgStateHome: ambient.XDG_STATE_HOME,
        checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath],
        cockpitId: checkout.cockpitId,
    })
    if (selected.kind !== 'complete') {
        return setupRefusal(
            selected.kind === 'refusal' ? selected.code : ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            selected.kind === 'refusal' ? selected.message : 'state root is unavailable',
            selected.kind === 'refusal' ? selected.target : loaded.result.source.path,
        )
    }
    const currentStackId = stackId({
        cockpitId: checkout.cockpitId,
        checkoutId: checkout.checkoutId,
        variant: { kind: 'shared' },
    })
    const sessionId = randomUUID()
    const confirmedSetupCheckout = await observeSetupCheckout({
        source: loaded.result.source,
        cockpitName: loaded.result.config.cockpit.name,
        observedAt,
        env: ambient,
        gitExecutable: executable.value,
    })
    const issued = await withSetupCheckoutProjection(
        confirmedSetupCheckout,
        {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(observedAt),
        },
        (projection) => issueSetupRunContext({
            checkout: projection,
            configuration: loaded.result,
            env: gitEnvironment(ambient),
            gitExecutable: executable.value,
            namespace: selected.value,
            observedAt,
            currentCheckoutPath: checkout.currentCheckoutPath,
            mainCheckoutPath: checkout.mainCheckoutPath,
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            stackId: currentStackId,
            holderId: holderId({ stackId: currentStackId, checkoutId: checkout.checkoutId, sessionId }),
            sessionId,
            writeInstructionPointers: input.writeInstructionPointers === true,
        }),
    )
    if (!issued) {
        const reason = confirmedSetupCheckout.state === 'failed'
            ? confirmedSetupCheckout.reason
            : 'confirmed setup checkout evidence is unavailable'
        return setupRefusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, reason, loaded.result.source.path)
    }
    return issued.kind === 'complete' ? { ...issued, diagnostics: loaded.diagnostics } : issued
}

const defaultSetupAdapters: SetupCommandAdapters = {
    load: loadSetupContext,
    observedAt: () => new Date().toISOString(),
    observeGit: ({ context, sibling }) => observeSetupPath(
        resolve(context.siblingsRoot, sibling.dir),
        context.siblingsRoot,
        context.env,
        context.gitExecutable,
    ),
    planGit: ({ context, sibling, observation }) => planSetup({
        siblingsRoot: context.siblingsRoot,
        sibling,
        observation,
        env: context.env,
        gitExecutable: context.gitExecutable,
    }),
    syncInstructionPointer: synchronizeInstructionPointer,
    execute: executePlan,
    observeSource: observeConfigSource,
    recordStarted: recordLifecycleStarted,
    withIgnore: async ({ context, siblingIndex, sibling, environmentFileIndex, environmentFile, observedAt }, use) => {
        const siblingRoot = resolve(context.siblingsRoot, sibling.dir)
        const siblingCheckoutId = checkoutId({ checkoutPath: siblingRoot })
        return observeEnvironmentIgnore({
            source: context.source,
            siblingIndex,
            siblingSlug: sibling.slug,
            mainCheckoutPath: context.mainCheckoutPath,
            siblingsRoot: context.siblingsRoot,
            siblingRoot,
            checkoutId: siblingCheckoutId,
            environmentFileIndex,
            environmentFile,
            observedAt,
            env: context.env,
            gitExecutable: context.gitExecutable,
        }, use)
    },
    planSeed: ({ context, sibling, environmentFile }) => planEnvironmentSeed({
        siblingRoot: resolve(context.siblingsRoot, sibling.dir),
        environmentFile,
    }),
    seed: seedEnvironmentInstanceSync,
    observePolicy: ({ context, siblingIndex, sibling, checkoutRoot, checkoutId, observedAt }) => observeInstallPolicyLockfiles({
        source: context.source,
        policies: context.policyCatalog,
        siblingIndex,
        siblingSlug: sibling.slug,
        checkoutRoot,
        checkoutId,
        observedAt,
    }),
    withPolicy: (observation, { context, siblingIndex, sibling, checkoutRoot, checkoutId, observedAt }, use) =>
        withInstallPolicyProjection(observation, {
            source: context.source,
            policies: context.policyCatalog,
            siblingIndex,
            siblingSlug: sibling.slug,
            checkoutRoot,
            checkoutId,
            evaluatedAt: Date.parse(observedAt),
        }, use),
    resolvePolicy: ({ context, siblingIndex, sibling, checkoutRoot, checkoutId, projection }) =>
        resolveInstallPolicies({
            source: context.source,
            policies: context.policyCatalog,
            siblingIndex,
            sibling,
            checkoutRoot,
            checkoutId,
            projection,
        }),
}

// The budget for one runtime query or command step (a Docker listing, an inspection, a Compose
// config read). Scoped to the stack's own resources, those finish in well under a second even on
// a daemon running a hundred other containers, so ten seconds is ample headroom while a hung
// daemon still fails the step closed quickly. Service starts are bounded by cold_start_seconds instead.
const RUNTIME_STEP_TIMEOUT_MS = 10_000

// down and reset delete, so the daemon is fixed once, before any adapter exists, and every step of
// the command addresses that one daemon.
async function destructiveAdapters(configPath: string, runtime: CliRuntime, sessionId: string) {
    const env = runtime.env ?? process.env
    const daemon = await selectDestructiveDaemon(env, RUNTIME_STEP_TIMEOUT_MS, executeProbe)
    return daemon.kind === 'refusal' ? daemon.adapters : createDestructiveCommandAdapters({
        configPath,
        env,
        sessionId,
        timeoutMs: RUNTIME_STEP_TIMEOUT_MS,
        dockerContext: daemon.dockerContext,
    }, executeProbe)
}

function readAdapters(configPath: string, runtime: CliRuntime, sessionId: string) {
    return createReadCommandAdapters({
        configPath,
        env: runtime.env ?? process.env,
        sessionId,
        timeoutMs: RUNTIME_STEP_TIMEOUT_MS,
        ...(runtime.signal ? { signal: runtime.signal } : {}),
    }, executeProbe)
}

function workCommandOutcome(outcome: WorkApplicationOutcome): CommandOutcome {
    return outcome.kind === 'complete' ? { status: 0, result: outcome.value, diagnostics: [] }
        : usageOutcome('WORK_APPLICATION_REFUSED', outcome.kind === 'refusal' ? outcome.reason : 'Work-order acceptance requires an interactive operator continuation')
}

async function configuredWorkApplication(input: WorkCommandInput, runtime: CliRuntime): Promise<WorkApplicationOutcome> {
    const { createConfiguredWorkApplicationComposition } = await import('./work-orders/composition.js')
    const { runWorkApplication } = await import('./work-orders/application.js')
    const configured = await createConfiguredWorkApplicationComposition({ configPath: resolve(input.configPath), env: runtime.env ?? process.env })
    return configured.kind === 'refusal' ? { kind: 'refusal', operation: input.request.operation, reason: configured.reason }
        : runWorkApplication(input.request, configured.composition)
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function inheritedSessionId(env: Readonly<Record<string, string | undefined>>): string | null | undefined {
    const value = env.COCKPIT_SESSION_ID
    return value === undefined ? undefined : SESSION_ID.test(value) ? value : null
}

function concreteEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)))
}

function teamMetadataOutcome(result: Extract<TeamMetadataResult, { kind: 'refusal' }>): GeneratedEnvironmentCommandOutcome
function teamMetadataOutcome(result: TeamMetadataResult): GeneratedEnvironmentCommandOutcome | undefined
function teamMetadataOutcome(result: TeamMetadataResult): GeneratedEnvironmentCommandOutcome | undefined {
    if (result.kind === 'complete') return undefined
    return {
        kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
        diagnostics: [{ severity: 'error', code: result.code, message: result.message, target: result.target }],
    }
}

function defaultHandlers(runtime: CliRuntime): Partial<CommandHandlers> {
    const env = runtime.env ?? process.env
    const inherited = inheritedSessionId(env)
    const ordinarySessionId = inherited === undefined ? 'cockpit-cli' : inherited
    const lifecycleAdapters = (configPath: string, sessionId: string) => createLifecycleCommandAdapters({
        configPath,
        env,
        sessionId,
        timeoutMs: RUNTIME_STEP_TIMEOUT_MS,
    }, executeProbe)
    const healthAdapters = (configPath: string) => createHealthCommandAdapters({
        configPath,
        env,
        timeoutMs: RUNTIME_STEP_TIMEOUT_MS,
    }, executeProbe)
    const workHandlers: Partial<Pick<CommandHandlers, WorkHandlerIdentifier>> = {}
    for (const command of commands) if (isWorkHandler(command.handler)) {
        workHandlers[command.handler] = async input => workCommandOutcome(await configuredWorkApplication(input, runtime))
    }
    return {
        ...workHandlers,
        document: documentCommand,
        init: input => runInitApplication(input, {
            now: () => new Date().toISOString(),
            prepareBootstrap: prepareSelectedBootstrapSurface,
            resumeBootstrap: resumeSelectedBootstrapSurface,
            applyBootstrap: applySelectedBootstrapSurface,
            document: documentObservedCommand,
            classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
            observeRoot: observeCockpitRoot,
            infer: deriveInferredFacts,
            observeDestination: async ({ path, byteLimit }) => {
                const node = await nodeAuthority()
                const read = node ? await readAnchoredBatches(dirname(path), [
                    { path: basename(path), action: 'read-entry', maxBytes: byteLimit },
                ], node, { execute: executeProbe }) : undefined
                const entry = read?.kind === 'complete' ? read.results[0] : undefined
                if (entry?.kind === 'missing') return { kind: 'absent' }
                if (entry?.kind === 'file') return { kind: 'available', sha256: entry.sha256 }
                return { kind: 'refusal', diagnostics: [{ severity: 'error', code: 'INIT_DESTINATION_UNAVAILABLE',
                    message: 'cockpit.toml could not be authenticated as an absent or bounded regular file', target: path }] }
            },
            validateConfig: loadCockpitConfig,
            synchronize: syncTeamGeneratedEnvironment,
            check: async input => {
                const metadata = teamMetadataOutcome(await validateTeamMetadata(input.configPath))
                return metadata ?? checkGeneratedEnvironment(input)
            },
            preflight: ({ configPath }) => runPreflightApplication({ configPath }, healthAdapters(configPath)),
        }),
        'registry-resolve': registryResolveCommand,
        setup: (input) => setupCommand({ ...input, env }, defaultSetupAdapters),
        sync: async ({ authorizeStaleRemoval, adopt, ...input }) => {
            if (adopt) return adoptAndSyncGeneratedEnvironment({ configPath: input.configPath, adopt })
            return syncTeamGeneratedEnvironment(input, authorizeStaleRemoval ? { authorizeStaleRemoval } : {})
        },
        check: async input => {
            const loaded = await loadCockpitConfig(input.configPath)
            if (loaded.kind !== 'complete') return loaded
            const metadata = teamMetadataOutcome(await validateTeamMetadata(input.configPath))
            if (metadata) return metadata
            const [outcome, hookTrust] = await Promise.all([checkGeneratedEnvironment(input),
                inspectCodexHookTrust({ root: dirname(resolve(input.configPath)), env })])
            return { ...outcome, diagnostics: [...outcome.diagnostics, ...hookTrust], result: outcome.report
                ? outcome.kind === 'complete' ? { ...outcome.result, currentness: outcome.report } : outcome.report
                : outcome.result }
        },
        selftest: runConfiguredSurfaceSelftestOutcome,
        upgrade: (input) => runConfiguredUpgradeCommand(input, {
            createReleaseEvidenceDiscovery,
            installed: { package: installedPackageMetadata.name, version: installedPackageMetadata.version },
        }),
        up: (input) => {
            const sessionId = ordinarySessionId
            if (sessionId === null) return Promise.resolve(usageOutcome(
                'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID'))
            const configPath = resolve(input.configPath)
            return runUpApplication({ configPath }, lifecycleAdapters(configPath, sessionId))
        },
        sleep: (input) => {
            const sessionId = ordinarySessionId
            if (sessionId === null) return Promise.resolve(usageOutcome(
                'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID'))
            const configPath = resolve(input.configPath)
            return runSleepApplication({ configPath }, lifecycleAdapters(configPath, sessionId))
        },
        session: (input) => {
            if (inherited === null) return Promise.resolve(usageOutcome(
                'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID'))
            const configPath = resolve(input.configPath)
            const sessionId = input.sessionId
            const sessionEnvironment = Object.freeze({ ...env, COCKPIT_SESSION_ID: sessionId })
            const childEnv = concreteEnvironment(sessionEnvironment)
            const adapters = createLifecycleCommandAdapters({
                configPath,
                env: sessionEnvironment,
                sessionId,
                timeoutMs: RUNTIME_STEP_TIMEOUT_MS,
            }, executeProbe)
            return runSessionApplication({ ...input, configPath, cwd: process.cwd(), env: childEnv }, {
                up: (request) => runUpApplication(request, adapters),
                sleep: (request) => runSleepApplication(request, adapters),
                resolveExecutable: (name) => resolveExecutable(name, sessionEnvironment),
                executeForeground: executeForegroundProcess,
                ...(runtime.signal ? { signal: runtime.signal } : {}),
            })
        },
        down: async (input) => {
            if (ordinarySessionId === null) return usageOutcome(
                'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID')
            const configPath = resolve(input.configPath)
            return runDownApplication({ configPath }, await destructiveAdapters(configPath, runtime, ordinarySessionId))
        },
        reset: async (input) => {
            if (ordinarySessionId === null) return usageOutcome(
                'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID')
            const configPath = resolve(input.configPath)
            return runResetApplication({ configPath }, await destructiveAdapters(configPath, runtime, ordinarySessionId))
        },
        preflight: (input) => {
            const configPath = resolve(input.configPath)
            return runPreflightApplication({ configPath }, healthAdapters(configPath))
        },
        doctor: (input) => {
            const configPath = resolve(input.configPath)
            return runDoctorApplication({ configPath }, {
                ...healthAdapters(configPath),
                discoverReleaseFreshness: () => discoverReleaseFreshness({ verb: 'doctor', env,
                    ...(runtime.createReleaseMetadataTransport ? { createTransport: runtime.createReleaseMetadataTransport } : {}) }),
            })
        },
        runtime: (input) => runRuntimeMeasure({ ...input, env }, { execute: executeProbe, probe: probeInstalledRuntime }),
        sibling: (request) => request.operation === 'add'
            ? runSiblingAdd({ ...request.input, env }, { execute: executeProbe })
            : runSiblingRemove({ ...request.input, env }),
        logs: (input) => {
            if (ordinarySessionId === null) return Promise.resolve(usageOutcome(
                'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID'))
            const configPath = resolve(input.configPath)
            return runLogsApplication({ ...input, configPath }, readAdapters(configPath, runtime, ordinarySessionId).logs)
        },
    }
}


function renderHelp(): string {
    const commandWidth = Math.max(...commands.map((command) => command.name.length))
    const commandLines = commands.map(
        (command) => `  ${command.name.padEnd(commandWidth)}  ${command.summary}${'experimental' in command && command.experimental ? ' (experimental)' : ''}`,
    )
    return ['Usage: cockpit <command> [options]', '', 'Commands:', ...commandLines, ''].join('\n')
}

function renderCommandHelp(definition: CommandDefinition): string {
    const optionLines = Object.entries(definition.options).map(([name, option]) => {
        const usage = option.type === 'string' ? `--${name} <value>` : `--${name}`
        const fallback = option.default === undefined || option.default === false ? '' : ` (default: ${String(option.default)})`
        return [usage, `${describePublicOption(name)}${fallback}`] as const
    })
    const width = Math.max(...optionLines.map(([usage]) => usage.length), '-h, --help'.length)
    return [`Usage: cockpit ${definition.name} ${definition.usage ?? '[options]'}`, '', definition.summary,
        ...(definition.experimental ? ['', 'Status: experimental. This interface may change before a stable release.'] : []), '', 'Options:',
        ...optionLines.map(([usage, note]) => `  ${usage.padEnd(width)}  ${note}`.trimEnd()),
        `  ${'-h, --help'.padEnd(width)}  Show this help`, ''].join('\n')
}

function renderVersion(): string {
    return `${installedPackageMetadata.name} ${installedPackageMetadata.version} (Node ${installedPackageMetadata.engines.node}; source ${installedPackageMetadata.cockpitSourceRevision})\n`
}

function usageOutcome(code: string, message: string, target?: string): CommandOutcome {
    return {
        artifact: null,
        destination: null,
        diagnostics: [{ severity: 'error', code, message, target }],
        result: null,
        status: 2,
    }
}

async function executeOutcome(outcome: CommandOutcome): Promise<CommandOutcome> {
    if (!outcome.artifact || !outcome.destination) return outcome
    try {
        await writeFile(outcome.destination, outcome.artifact, { encoding: 'utf8', flag: 'wx' })
        return outcome
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const diagnostic: Diagnostic = code === 'EEXIST'
            ? {
                severity: 'error',
                code: 'OUTPUT_EXISTS',
                message: 'the output path already exists and was not changed',
                target: outcome.destination,
                fix: 'choose a new path; replacement requires a future explicit option',
            }
            : {
                severity: 'error',
                code: 'OUTPUT_WRITE_FAILED',
                message: `the resolved output could not be created (${code ?? 'unknown I/O error'})`,
                target: outcome.destination,
            }
        return {
            artifact: null,
            destination: null,
            diagnostics: [...outcome.diagnostics, diagnostic],
            result: null,
            status: 2,
        }
    }
}

function optionCount(args: readonly string[], name: string): number {
    const option = `--${name}`
    return args.filter((arg) => arg === option || arg.startsWith(`${option}=`)).length
}

const ANSWERS_FILE_BYTE_LIMIT = 262_144

/** The only path init creates outside its root: the previewed dedicated repository, never its parents. */
async function createDedicatedCockpitRoot(path: string, env: Readonly<Record<string, string | undefined>>): Promise<void> {
    try { await mkdir(path, { mode: 0o755 }) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const status = await lstat(path)
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== path) {
        throw new Error(`${path} exists and is not a plain directory`)
    }
    const initialised = await initializeLocalGitRepository({ path, env }, { execute: executeProbe })
    if (initialised.kind === 'refusal') throw new Error(initialised.reason)
}

/** Reads the consent digests and answers file of an unattended init; absent flags mean a terminal run. */
async function decodeUnattendedInit(values: {
    interactive?: boolean; answers?: string; 'accept-preview'?: string; 'accept-defaults'?: string
}): Promise<{ value?: UnattendedInit } | CommandOutcome> {
    const { answers: answersPath, 'accept-preview': previewSha256, 'accept-defaults': defaultsSha256 } = values
    if (answersPath === undefined && previewSha256 === undefined && defaultsSha256 === undefined) return {}
    if (values.interactive) return usageOutcome('CLI_USAGE_INVALID',
        'init --interactive asks a person; --answers, --accept-preview and --accept-defaults are for a caller without a terminal', '--interactive')
    if (previewSha256 === undefined) return usageOutcome('CLI_USAGE_INVALID',
        '--answers and --accept-defaults require --accept-preview: run init --json first and pass the preview digest it prints', '--accept-preview')
    for (const [name, digest] of [['--accept-preview', previewSha256], ['--accept-defaults', defaultsSha256]] as const) {
        if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) return usageOutcome('CLI_USAGE_INVALID',
            `${name} must be a lowercase sha256 digest printed by a pending init run`, name)
    }
    let answers: Record<string, unknown> = {}
    if (answersPath !== undefined) {
        const path = resolve(answersPath)
        try {
            const read = await readBoundedInput(path)
            if (read.kind === 'too-large' || read.bytes.byteLength > ANSWERS_FILE_BYTE_LIMIT) return usageOutcome('CLI_USAGE_INVALID',
                `--answers file exceeds ${ANSWERS_FILE_BYTE_LIMIT} bytes; replace it with a plain TOML file within that limit and retry`, '--answers')
            let text: string
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) }
            catch {
                return usageOutcome('CLI_USAGE_INVALID',
                    `--answers ${path} is not valid UTF-8; replace it with a plain UTF-8 TOML file and retry`, '--answers')
            }
            answers = parseToml(text)
        } catch (error) {
            return usageOutcome('CLI_USAGE_INVALID',
                `--answers ${path} could not be read as one bounded regular TOML file (${error instanceof Error ? error.message : 'unknown error'}); replace it with a plain TOML file and retry`, '--answers')
        }
    }
    return { value: { previewSha256, answers, ...(defaultsSha256 === undefined ? {} : { defaultsSha256 }) } }
}

async function decodeRequest(
    handler: HandlerIdentifier,
    parsed: ParsedCommandArguments,
    runtimeEnv: Readonly<Record<string, string | undefined>>,
): Promise<HandlerRequest | CommandOutcome> {
    if (isWorkHandler(handler)) {
        const values = parsed.values
        if (parsed.positionals.length || typeof values.config !== 'string' || !values.config) {
            return usageOutcome('CLI_USAGE_INVALID', 'work, browser and testing commands require --config and named selectors only')
        }
        const text = (key: string): string | undefined => typeof values[key] === 'string' ? values[key] as string : undefined
        const workOrderId = text('work-order')
        let request: WorkApplicationRequest
        if (['work-accept', 'work-renew', 'work-grade', 'work-review', 'work-record', 'work-reverse', 'work-execute'].includes(handler) && !workOrderId) {
            return usageOutcome('CLI_USAGE_INVALID', 'provide --work-order <id>', '--work-order')
        }
        if (handler === 'work-intake') {
            const intent = text('intent'), candidate = text('candidate')
            if (values.intent !== undefined) {
                if (!intent || values['work-order'] !== undefined || values.candidate !== undefined && !candidate) {
                    return usageOutcome('CLI_USAGE_INVALID', '--intent requires a relative path, excludes --work-order and permits one relative --candidate')
                }
                request = { operation: handler, intent, ...(candidate ? { candidate } : {}) }
            } else {
                if (!workOrderId || values.candidate !== undefined) return usageOutcome('CLI_USAGE_INVALID', 'provide --work-order <id> or --intent <relative-file> [--candidate <relative-file>]')
                request = { operation: handler, workOrderId }
            }
        } else if (handler === 'work-record') {
            const eventFile = text('event-file')
            if (!eventFile) return usageOutcome('CLI_USAGE_INVALID', 'provide --event-file <relative-file>', '--event-file')
            request = { operation: handler, workOrderId: workOrderId!, eventFile }
        } else if (handler === 'work-accept' || handler === 'work-renew' || handler === 'work-grade' || handler === 'work-review' || handler === 'work-reverse') {
            request = { operation: handler, workOrderId: workOrderId! }
        } else if (handler === 'work-status') {
            if (values['work-order'] !== undefined && !workOrderId) return usageOutcome('CLI_USAGE_INVALID', '--work-order requires a bounded identifier')
            request = { operation: handler, ...(workOrderId ? { workOrderId } : {}) }
        } else if (handler === 'work-resume' || handler === 'work-metrics') request = { operation: handler }
        else if (handler === 'work-recover') {
            const lockId = text('lock')
            if (!lockId) return usageOutcome('CLI_USAGE_INVALID', 'provide --lock <lock-id>', '--lock')
            request = { operation: handler, lockId, apply: values.apply === true }
        }
        else if (handler === 'work-execute') {
            const approach = text('approach')
            if (!approach) return usageOutcome('CLI_USAGE_INVALID', 'provide --approach <description>', '--approach')
            request = { operation: handler, workOrderId: workOrderId!, approach }
        } else if (handler === 'work-sweep') request = { operation: handler, apply: values.apply === true }
        else if (handler === 'work-programme-mint') {
            const programmeId = text('programme'), itemKey = text('item')
            const candidate = text('candidate')
            if (!programmeId || values.item !== undefined && !itemKey || values.candidate !== undefined && !candidate) {
                return usageOutcome('CLI_USAGE_INVALID', 'provide --programme <id>, an optional --item <key> and an optional relative --candidate')
            }
            request = { operation: handler, programmeId, ...(itemKey ? { itemKey } : {}), ...(candidate ? { candidate } : {}) }
        } else if (handler === 'test-run') {
            const gate = text('gate'), mode = values.mode
            if (!gate || mode !== 'canonical' && mode !== 'full' && mode !== 'staged') return usageOutcome('CLI_USAGE_INVALID', 'provide --gate and --mode canonical|full|staged')
            let select: Extract<WorkApplicationRequest, { operation: 'test-run' }>['select']
            if (values.select !== undefined) {
                const selector = text('select'), separator = selector?.indexOf(':') ?? -1
                const kind = selector?.slice(0, separator), value = selector?.slice(separator + 1)
                if (!value || kind !== 'spec' && kind !== 'file' && kind !== 'test' && kind !== 'route') return usageOutcome('CLI_USAGE_INVALID', '--select requires spec|file|test|route:<value>')
                select = { kind, value }
            }
            request = { operation: handler, gate, mode, ...(select ? { select } : {}) }
        } else {
            const role = text('role')
            if (values.role !== undefined && !role) return usageOutcome('CLI_USAGE_INVALID', '--role requires a bounded identifier')
            request = { operation: handler, ...(role ? { role } : {}) }
        }
        const { captureWorkApplicationRequest } = await import('./work-orders/application.js')
        const captured = captureWorkApplicationRequest(request)
        if (!captured) return usageOutcome('CLI_USAGE_INVALID', 'work, browser and testing commands require bounded selectors of the declared kind')
        return { handler, input: { configPath: values.config, request: captured } }
    }
    if (handler === 'init') {
        const [root, ...extraRoots] = parsed.positionals
        const target = parsed.values.target, registry = parsed.values.registry
        if (!root || extraRoots.length || !SURFACE_TARGETS.some(value => value === target)
            || registry !== undefined && (typeof registry !== 'string' || registry.length === 0)) {
            return usageOutcome('CLI_USAGE_INVALID', `init requires one explicit root and --target ${SURFACE_TARGETS.join('|')}`)
        }
        const absoluteRoot = resolve(root)
        try {
            if (await realpath(absoluteRoot) !== absoluteRoot) return usageOutcome('CLI_USAGE_INVALID', 'init root must name its canonical directory')
        } catch { return usageOutcome('CLI_USAGE_INVALID', 'init root must be an existing canonical directory') }
        if (process.platform !== 'darwin' && process.platform !== 'linux') {
            return usageOutcome('CLI_USAGE_INVALID', 'init supports macOS and Linux state ownership')
        }
        const resetField = parsed.values['reset-answer']
        const acceptedReset = parsed.values['accept-reset']
        if (resetField !== undefined || acceptedReset !== undefined) {
            if (typeof resetField !== 'string' || !isRecordedAnswerField(resetField) || acceptedReset !== undefined
                    && (typeof acceptedReset !== 'string' || !/^[a-f0-9]{64}$/.test(acceptedReset))) {
                return usageOutcome('CLI_USAGE_INVALID', '--reset-answer requires one recorded field; --accept-reset requires its printed sha256 digest')
            }
            if (parsed.values.interactive || parsed.values.answers !== undefined || parsed.values['accept-preview'] !== undefined
                || parsed.values['accept-defaults'] !== undefined) {
                return usageOutcome('CLI_USAGE_INVALID', '--reset-answer is a standalone preview or exact acceptance operation')
            }
            return { handler, input: { root: absoluteRoot, target: target as SurfaceTarget,
                ...(typeof registry === 'string' ? { registry: resolve(absoluteRoot, registry) } : {}),
                accepted: false, sessionId: randomUUID(), platform: process.platform, home: runtimeEnv.HOME,
                ...(runtimeEnv.XDG_STATE_HOME ? { xdgStateHome: runtimeEnv.XDG_STATE_HOME } : {}),
                resetAnswer: { field: resetField, ...(typeof acceptedReset === 'string'
                    ? { acceptedPreviewSha256: acceptedReset } : {}) } } }
        }
        const unattended = await decodeUnattendedInit(parsed.values as {
            interactive?: boolean; answers?: string; 'accept-preview'?: string; 'accept-defaults'?: string })
        if ('status' in unattended) return unattended
        return { handler, input: { root: absoluteRoot, target: target as SurfaceTarget,
            ...(typeof registry === 'string' ? { registry: resolve(absoluteRoot, registry) } : {}),
            accepted: false, sessionId: randomUUID(), platform: process.platform, home: runtimeEnv.HOME,
            ...(runtimeEnv.XDG_STATE_HOME ? { xdgStateHome: runtimeEnv.XDG_STATE_HOME } : {}),
            ...(unattended.value ? { unattended: unattended.value } : {}) } }
    }
    if (handler === 'document') {
        const values = parsed.values as { registry?: string; output?: string; json?: boolean }
        const [root, ...extraRoots] = parsed.positionals
        if (extraRoots.length > 0) {
            return usageOutcome('DOCUMENT_ROOT_COUNT', 'document accepts at most one cockpit root')
        }
        if (root && values.registry) {
            return usageOutcome('DOCUMENT_SOURCE_CONFLICT', 'a cockpit root and --registry are mutually exclusive')
        }
        if (!root && !values.registry) {
            return usageOutcome('DOCUMENT_SOURCE_REQUIRED', 'provide one cockpit root or --registry <file>')
        }
        if (values.output !== undefined && values.output.length === 0) {
            return usageOutcome('CLI_USAGE_INVALID', '--output requires a non-empty path', '--output')
        }
        return { handler, input: { root, registry: values.registry, output: values.output } }
    }

    if (handler === 'setup') {
        const values = parsed.values as { config?: string; json?: boolean; 'write-instruction-pointers'?: boolean }
        if (parsed.positionals.length > 0) {
            return usageOutcome(ENVIRONMENT_CODES.SETUP_POSITIONAL_UNSUPPORTED, 'setup accepts named inputs only')
        }
        if (!values.config) return usageOutcome(ENVIRONMENT_CODES.SETUP_CONFIG_REQUIRED, 'provide --config <file>', '--config')
        return { handler, input: { configPath: values.config,
            ...(values['write-instruction-pointers'] === true ? { writeInstructionPointers: true } : {}) } }
    }

    if (handler === 'sync') {
        const values = parsed.values as { config?: string; 'dry-run'?: boolean; interactive?: boolean; adopt?: string[] }
        if (parsed.positionals.length > 0) return usageOutcome('CLI_USAGE_INVALID', 'sync accepts named inputs only')
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (values['dry-run'] && values.interactive) {
            return usageOutcome('CLI_USAGE_INVALID', 'sync --dry-run and --interactive are mutually exclusive', '--interactive')
        }
        if (values.adopt && (values['dry-run'] || values.interactive)) {
            return usageOutcome('CLI_USAGE_INVALID', 'sync --adopt moves files and records them in cockpit.toml, so it cannot be a dry run or interactive; a refused adoption is rolled back', '--adopt')
        }
        return { handler, input: { configPath: values.config, ...(values['dry-run'] === true ? { dryRun: true } : {}),
            ...(values.adopt ? { adopt: Object.freeze([...values.adopt]) } : {}) } }
    }

    if (handler === 'selftest') {
        const values = parsed.values as { config?: string; 'probe-specifications'?: string }
        if (parsed.positionals.length > 0) return usageOutcome('CLI_USAGE_INVALID', 'selftest accepts named inputs only')
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (!values['probe-specifications']) return usageOutcome('CLI_USAGE_INVALID', 'provide --probe-specifications <file>', '--probe-specifications')
        const invalidEnvironment = () => usageOutcome('CLI_USAGE_INVALID',
            'selftest executable search inputs must be bounded own string or undefined values; supply PATH without accessors and run npx --no cockpit selftest --help to retry')
        const env: Record<string, string | undefined> = {}
        try {
            if (runtimeEnv === null || typeof runtimeEnv !== 'object' || Array.isArray(runtimeEnv)
                || utilTypes.isProxy(runtimeEnv)) return invalidEnvironment()
            const keys = Reflect.ownKeys(runtimeEnv)
            if (keys.length > 4_096) return invalidEnvironment()
            for (const key of keys) {
                if (key !== 'PATH') continue
                const descriptor = Object.getOwnPropertyDescriptor(runtimeEnv, key)
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
                    || descriptor.value !== undefined && (typeof descriptor.value !== 'string'
                        || Buffer.byteLength(descriptor.value) > 65_536)) return invalidEnvironment()
                env[key] = descriptor.value
            }
        } catch { return invalidEnvironment() }
        return { handler, input: { configPath: values.config, probeSpecificationsPath: values['probe-specifications'], env: Object.freeze(env) } }
    }

    if (handler === 'upgrade') {
        const values = parsed.values as {
            config?: string
            'release-evidence'?: string
            'release-evidence-sha256'?: string
        }
        if (parsed.positionals.length > 0) return usageOutcome('CLI_USAGE_INVALID', 'upgrade accepts named inputs only')
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        const evidencePath = values['release-evidence']
        const evidenceSha256 = values['release-evidence-sha256']
        if ((evidencePath === undefined) !== (evidenceSha256 === undefined)) {
            return usageOutcome(
                'CLI_USAGE_INVALID',
                '--release-evidence and --release-evidence-sha256 must be supplied together',
                '--release-evidence',
            )
        }
        if (evidencePath !== undefined && evidencePath.length === 0) {
            return usageOutcome('CLI_USAGE_INVALID', '--release-evidence requires a non-empty path', '--release-evidence')
        }
        if (evidenceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(evidenceSha256)) {
            return usageOutcome(
                'CLI_USAGE_INVALID',
                '--release-evidence-sha256 requires one lowercase SHA-256 digest',
                '--release-evidence-sha256',
            )
        }
        return {
            handler,
            input: {
                configPath: values.config,
                ...(evidencePath && evidenceSha256
                    ? { releaseEvidencePath: evidencePath, releaseEvidenceSha256: evidenceSha256 }
                    : {}),
            },
        }
    }

    if (handler === 'session') {
        const values = parsed.values as { config?: string }
        const [command, ...argv] = parsed.positionals
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (!command) return usageOutcome('CLI_USAGE_INVALID', 'session requires a command after --', 'session')
        const inherited = inheritedSessionId(runtimeEnv)
        if (inherited === null) return usageOutcome(
            'CLI_USAGE_INVALID', 'COCKPIT_SESSION_ID must be a canonical UUID', 'COCKPIT_SESSION_ID')
        if (inherited !== undefined) return usageOutcome(
            'CLI_USAGE_INVALID', 'session cannot be nested inside another supervised session', 'session')
        return { handler, input: { configPath: values.config, argv: [command, ...argv], sessionId: randomUUID() } }
    }

    if (handler === 'check' || handler === 'up' || handler === 'sleep' || handler === 'down' || handler === 'reset'
        || handler === 'preflight' || handler === 'doctor') {
        const values = parsed.values as { config?: string; json?: boolean }
        if (parsed.positionals.length > 0) {
            return usageOutcome('CLI_USAGE_INVALID', `${handler} accepts named inputs only`)
        }
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        return { handler, input: { configPath: values.config } } as HandlerRequest
    }

    if (handler === 'logs') {
        const values = parsed.values as {
            config?: string
            service?: string
            tail?: string
            since?: string
            follow?: boolean
            json?: boolean
        }
        if (parsed.positionals.length > 0) return usageOutcome('CLI_USAGE_INVALID', 'logs accepts named inputs only')
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (!values.service) return usageOutcome('CLI_USAGE_INVALID', 'provide --service <name>', '--service')
        const tail = Number(values.tail)
        if (!Number.isSafeInteger(tail) || tail < 1 || tail > 10_000) {
            return usageOutcome('CLI_USAGE_INVALID', '--tail must be an integer from 1 through 10000', '--tail')
        }
        if (!values.since) return usageOutcome('CLI_USAGE_INVALID', '--since requires a non-empty value', '--since')
        return {
            handler,
            input: {
                configPath: values.config,
                service: values.service,
                tail,
                since: values.since,
                follow: values.follow === true,
                json: values.json === true,
            },
        }
    }

    if (handler === 'runtime') {
        const values = parsed.values as { config?: string; image?: string }
        const [operation, ...extra] = parsed.positionals
        if (operation !== 'measure' || extra.length > 0) {
            return usageOutcome('CLI_USAGE_INVALID', 'runtime requires the measure operation: npx --no cockpit runtime measure --config <your cockpit.toml> --image <local-image>')
        }
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (!values.image) return usageOutcome('CLI_USAGE_INVALID', 'provide --image <local-image>; the probe never pulls', '--image')
        return { handler, input: { configPath: values.config, image: values.image } }
    }

    if (handler === 'sibling') {
        const values = parsed.values as { config?: string; create?: boolean; from?: string; remote?: string; dir?: string; var?: string; purpose?: string; mount?: string; 'instruction-pointer'?: boolean }
        const [operation, slug, ...extra] = parsed.positionals
        const shape = 'npx --no cockpit sibling add <slug> --config <your cockpit.toml> [--create | --from <path> | --remote <url>] [--dir <relative dir>] [--var <NAME>] [--purpose "<text>"] [--mount <always|none|profile:NAME>] [--instruction-pointer], or npx --no cockpit sibling remove <slug> --config <your cockpit.toml>'
        if ((operation !== 'add' && operation !== 'remove') || !slug || extra.length > 0) {
            return usageOutcome('CLI_USAGE_INVALID', `sibling requires an operation and one slug: ${shape}`)
        }
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (operation === 'remove') {
            const stray = ['create', 'from', 'remote', 'dir', 'var', 'purpose', 'mount', 'instruction-pointer'].find((name) => (values as Record<string, unknown>)[name] !== undefined && (values as Record<string, unknown>)[name] !== false)
            if (stray) return usageOutcome('CLI_USAGE_INVALID', `sibling remove takes only --config and --json; --${stray} belongs to sibling add`, `--${stray}`)
            return { handler, input: { operation, input: { configPath: values.config, slug } } }
        }
        return { handler, input: { operation, input: {
            configPath: values.config, slug, create: values.create === true,
            ...(values.from === undefined ? {} : { from: values.from }), ...(values.remote === undefined ? {} : { remote: values.remote }),
            ...(values.dir === undefined ? {} : { dir: values.dir }), ...(values.var === undefined ? {} : { varName: values.var }),
            ...(values.purpose === undefined ? {} : { purpose: values.purpose }),
            ...(values.mount === undefined ? {} : { mount: values.mount }),
            ...(values['instruction-pointer'] === true ? { instructionPointer: true } : {}),
        } } }
    }

    if (handler === 'baseline-record') {
        const values = parsed.values as { config?: string; interactive?: boolean; json?: boolean }
        if (parsed.positionals.length > 0) {
            return usageOutcome('CLI_USAGE_INVALID', 'baseline-record accepts named inputs only')
        }
        if (!values.config) return usageOutcome('CLI_USAGE_INVALID', 'provide --config <file>', '--config')
        if (!values.interactive) {
            return usageOutcome('CLI_USAGE_INVALID', 'baseline-record requires --interactive', '--interactive')
        }
        return { handler, input: { configPath: values.config } }
    }

    const values = parsed.values as {
        registry?: string
        'siblings-root'?: string
        adoption?: string
        json?: boolean
    }
    if (parsed.positionals.length > 0) {
        return usageOutcome('REGISTRY_POSITIONAL_UNSUPPORTED', 'registry-resolve accepts named inputs only')
    }
    if (!values.registry) {
        return usageOutcome('REGISTRY_SOURCE_REQUIRED', 'provide --registry <file>', '--registry')
    }
    if (!values['siblings-root']) {
        return usageOutcome('REGISTRY_SIBLINGS_ROOT_REQUIRED', 'provide --siblings-root <path>', '--siblings-root')
    }
    if (!values.adoption) {
        return usageOutcome('REGISTRY_ADOPTION_REQUIRED',
            'provide --adoption <file>: five lines registry=, environment=, surfaces=, guards=, grading=, each migrated or documented-only (see the adoption guide)', '--adoption')
    }
    return {
        handler,
        input: {
            registry: values.registry,
            siblingsRoot: values['siblings-root'],
            adoption: values.adoption,
        },
    }
}

type InvocationOptions = { readonly interactive: boolean; readonly json: boolean; readonly ci: string | undefined;
    readonly env: Readonly<Record<string, string | undefined>> }

// Printed remedies name a configuration placeholder; every outcome of a configured command binds it
// to the path this invocation was given, not only the outcomes whose handler built a fix context.
async function invokeHandler(
    request: HandlerRequest,
    handlers: Partial<CommandHandlers>,
    operators: OperatorHandlers,
    options: InvocationOptions,
    io: CliIo,
): Promise<CommandOutcome> {
    const outcome = await dispatchHandler(request, handlers, operators, options, io)
    const input: unknown = request.input
    const configPath = input !== null && typeof input === 'object' && 'configPath' in input && typeof input.configPath === 'string'
        ? resolve(input.configPath) : null
    if (configPath === null) return outcome
    return { ...outcome, fixContext: outcome.fixContext
        ? { ...outcome.fixContext, resolvedConfigPath: outcome.fixContext.resolvedConfigPath ?? configPath }
        : { resolvedConfigPath: configPath, generatedTargets: [] } }
}

async function dispatchHandler(
    request: HandlerRequest,
    handlers: Partial<CommandHandlers>,
    operators: OperatorHandlers,
    options: InvocationOptions,
    io: CliIo,
): Promise<CommandOutcome> {
    const unavailable = (): CommandOutcome => usageOutcome(
        'CLI_INTERNAL_ERROR',
        `the "${request.handler}" command is unavailable`,
        request.handler,
    )
    if (isWorkHandler(request.handler) && 'request' in request.input) {
        if (request.handler === 'work-accept' || request.handler === 'work-renew') {
            const terminal = io.confirmWorkOrder !== undefined || io.stdin?.isTTY === true && 'isTTY' in io.stdout && io.stdout.isTTY === true
            if (!options.interactive || options.json || options.ci && options.ci.length > 0 || !terminal) {
                return usageOutcome('WORK_OPERATOR_REQUIRED', 'Acceptance requires --interactive in a human terminal outside CI and JSON modes')
            }
            const opened = await operators.beginOperatorWorkApplication?.(request.input)
            if (!opened) return unavailable()
            if (!('decide' in opened)) return opened
            let answer: string | undefined
            if (io.confirmWorkOrder) answer = await io.confirmWorkOrder({ digest: opened.digest, prompt: opened.prompt })
            else if (io.stdin) {
                const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
                try { answer = await prompt.question(`${opened.prompt}\n`) } finally { prompt.close() }
            }
            return opened.decide(answer ?? '')
        }
        const handler = handlers[request.handler]
        return handler?.(request.input) ?? unavailable()
    }
    if (request.handler === 'init') return runInitOperatorCommand(request.input, { ...options, unattended: request.input.unattended }, {
        terminal: io.confirmInit !== undefined || io.answerInitQuestion !== undefined
            || io.stdin?.isTTY === true && 'isTTY' in io.stdout && io.stdout.isTTY === true,
        confirm: async preview => {
            if (io.confirmInit) return io.confirmInit(preview)
            if (!io.stdin) return undefined
            io.stderr.write(renderHumanValue(preview))
            const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
            try { return await prompt.question('Type the exact bootstrap preview digest to accept: ') } finally { prompt.close() }
        },
        writeArtifact: (destination, artifact) => writeFile(destination, artifact, { flag: 'wx', mode: 0o600 }),
        createCockpitRoot: path => createDedicatedCockpitRoot(path, options.env),
        chooseCockpitRoot: async question => {
            if (!io.stdin) return undefined
            io.stderr.write(renderHumanValue(question))
            const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
            try { return (await prompt.question(`Where does the cockpit live? Type ${question.options.map(row => row.answer === question.recommended ? `${row.answer} (recommended)` : row.answer).join(' or ')}: `)).trim().replace(/ \(recommended\)$/, '') } finally { prompt.close() }
        },
        answerQuestion: async question => {
            if (io.answerInitQuestion) return io.answerInitQuestion(question)
            if (!io.stdin) return undefined
            io.stderr.write(renderHumanValue(question))
            const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
            try { return await prompt.question(`Enter a JSON value for ${question.field} (strings need quotes): `) } finally { prompt.close() }
        },
    }, handlers.init ?? (async () => ({ kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: [{ severity: 'error', code: 'INIT_UNAVAILABLE', message: 'init application is unavailable' }], result: null })))
    if (request.handler === 'document') return handlers.document?.(request.input) ?? unavailable()
    if (request.handler === 'registry-resolve') return handlers['registry-resolve']?.(request.input) ?? unavailable()
    if (request.handler === 'setup') return handlers.setup?.(request.input) ?? unavailable()
    if (request.handler === 'sync') return runSyncOperatorCommand(request.input, options, io, handlers.sync ?? (async () => unavailable()))
    if (request.handler === 'check') return handlers.check?.(request.input) ?? unavailable()
    if (request.handler === 'selftest') return runSelftestOperatorCommand(request.input, options, io, handlers.selftest ?? (async () => unavailable()))
    if (request.handler === 'upgrade') return handlers.upgrade?.(request.input) ?? unavailable()
    if (request.handler === 'up') return handlers.up?.(request.input) ?? unavailable()
    if (request.handler === 'sleep') return handlers.sleep?.(request.input) ?? unavailable()
    if (request.handler === 'session') return handlers.session?.(request.input) ?? unavailable()
    if (request.handler === 'down') return handlers.down?.(request.input) ?? unavailable()
    if (request.handler === 'reset') return runResetOperatorApplication(request.input, {
        ...options,
        terminal: io.confirmReset !== undefined || io.stdin?.isTTY === true,
    }, {
        preview: handlers.reset ?? (async () => unavailable()),
        begin: operators.beginOperatorReset ?? (async () => operatorRefusal('interactive reset is unavailable')),
        confirm: (preview) => confirmOperatorReset(io, preview),
    })
    if (request.handler === 'preflight') return handlers.preflight?.(request.input) ?? unavailable()
    if (request.handler === 'doctor') return handlers.doctor?.(request.input) ?? unavailable()
    if (request.handler === 'logs') return handlers.logs?.(request.input) ?? unavailable()
    if (request.handler === 'runtime') return handlers.runtime?.(request.input) ?? unavailable()
    if (request.handler === 'sibling') return handlers.sibling?.(request.input) ?? unavailable()
    if (request.handler === 'baseline-record') return runBaselineOperatorApplication(request.input, {
        ...options,
        terminal: io.confirmBaseline !== undefined || io.stdin?.isTTY === true,
    }, {
        begin: operators.beginOperatorBaselineRecord
            ?? (async () => baselineOperatorRefusal('interactive baseline recording is unavailable')),
        confirm: (preview) => confirmOperatorBaseline(io, preview),
    })
    return unavailable()
}

function operatorRefusal(message: string): CommandOutcome {
    return usageOutcome(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, message, 'reset')
}

async function confirmOperatorReset(io: CliIo, preview: CommandOutcome): Promise<boolean> {
    if (io.confirmReset) return io.confirmReset(preview)
    if (!io.stdin) return false
    io.stderr.write(renderHumanValue(preview.result))
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        return (await prompt.question('Approve this exact reset? [y/N] ')).trim().toLowerCase() === 'y'
    } finally {
        prompt.close()
    }
}

function baselineOperatorRefusal(message: string): CommandOutcome {
    return usageOutcome(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, message, 'environment-baseline')
}

async function confirmOperatorBaseline(io: CliIo, preview: CommandOutcome): Promise<boolean> {
    if (io.confirmBaseline) return io.confirmBaseline(preview)
    if (!io.stdin) return false
    io.stderr.write(renderHumanValue(preview.result))
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        return (await prompt.question('Record this exact environment baseline? [y/N] ')).trim().toLowerCase() === 'y'
    } finally {
        prompt.close()
    }
}

function defaultOperatorHandlers(runtime: CliRuntime): OperatorHandlers {
    const inherited = inheritedSessionId(runtime.env ?? process.env)
    const sessionId = inherited === undefined ? 'cockpit-cli' : inherited
    return {
        beginOperatorWorkApplication: async input => {
            const outcome = await configuredWorkApplication(input, runtime)
            if (outcome.kind !== 'human-needed') return workCommandOutcome(outcome)
            return { digest: outcome.continuation.digest, prompt: outcome.continuation.prompt,
                decide: async answer => workCommandOutcome(await outcome.continuation.decide(answer)) }
        },
        beginOperatorReset: async (input) => {
            if (sessionId === null) return operatorRefusal('COCKPIT_SESSION_ID must be a canonical UUID')
            const configPath = resolve(input.configPath)
            return beginOperatorResetApplication({ configPath }, await destructiveAdapters(configPath, runtime, sessionId))
        },
        beginOperatorBaselineRecord: (input) => {
            if (sessionId === null) return Promise.resolve(baselineOperatorRefusal('COCKPIT_SESSION_ID must be a canonical UUID'))
            const configPath = resolve(input.configPath)
            return beginOperatorBaselineRecordApplication(
                { configPath },
                readAdapters(configPath, runtime, sessionId).baseline,
            )
        },
    }
}

export async function runCli(
    args: readonly string[],
    io: CliIo = process,
    handlerOverrides: CliHandlerOverrides = {},
    runtime: CliRuntime = {},
): Promise<number> {
    const startedAt = performance.now()
    const [commandName, ...commandArgs] = args
    const internal = internalCommands.find(command => command.name === commandName)
    const definition = commands.find(command => command.name === commandName)
    const verb = internal?.name ?? definition?.name
        ?? (commandArgs.length === 0 && commandName === '--help' ? 'help'
            : commandArgs.length === 0 && commandName === '--version' ? 'version' : 'unknown')
    let resolvedConfigPath: string | null = null
    // The invocation record is part of the --json envelope on stdout; human-mode runs publish no record.
    // session has no JSON mode and exits with its supervised command's own status, which scripts branch on.
    const finish = (status: number, outcome?: CommandOutcome): number => {
        const exitCode = status === EXIT_CODES.success ? EXIT_CODES.success
            : status === EXIT_CODES.cancelled ? EXIT_CODES.cancelled : EXIT_CODES.failure
        if (outcome) {
            const invocation = createInvocationRecord({ verb, durationMs: Math.floor(performance.now() - startedAt),
                exitCode, resolvedConfigPath })
            io.stdout.write(renderJsonResponse({ ...outcome, invocation }, outcome.fixContext))
        }
        return verb === 'session' && Number.isInteger(status) && status > 0 && status < 256 ? status : exitCode
    }
    // One refusal here instead of per-command checks: process ownership, filesystem publication and
    // the shell guards assume POSIX semantics, so a native Windows run could fail part-way through a
    // mutation rather than up front.
    if (process.platform === 'win32') {
        const outcome = usageOutcome('CLI_PLATFORM_UNSUPPORTED',
            'cockpit does not run on native Windows because its process, filesystem and guard controls assume macOS or Linux; fix: run cockpit on a macOS or Linux host')
        if (args.includes('--json')) return finish(outcome.status, outcome)
        io.stderr.write(renderHumanDiagnostics(outcome.diagnostics))
        return finish(outcome.status)
    }
    if (internal) {
        let harness: GuardSurfaceTarget | undefined
        let response: Awaited<ReturnType<typeof runGuardEvaluationApplication>>
        try {
            if (commandArgs.length !== 2 || commandArgs[0] !== '--harness'
                || !isGuardSurfaceTarget(commandArgs[1])) throw new Error('Invalid private guard arguments.')
            harness = commandArgs[1]
            if (!io.stdin) throw new Error('Guard input stream is missing.')
            const chunks: Buffer[] = []
            let bytes = 0
            for await (const chunk of io.stdin) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                bytes += buffer.length
                if (bytes > GUARD_INPUT_LIMITS.inputBytes) throw new Error('Guard input exceeds its byte bound.')
                chunks.push(buffer)
            }
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
            const reply = (runtime.env ?? process.env).COCKPIT_GUARD_TRANSPORT !== '1'
            let payload: unknown = raw
            if (reply) {
                const native = JSON.parse(raw)
                payload = harness === 'opencode' && native?.tool !== undefined
                    ? normalizeOpenCodeInput(native)
                    : { hook_event_name: native?.hook_event_name, tool_name: native?.tool_name,
                        tool_input: native?.tool_input, cwd: native?.cwd ?? process.cwd() }
            }
            const identityBytes = (runtime.env ?? process.env).COCKPIT_GUARD_IDENTITY
            if (!identityBytes || Buffer.byteLength(identityBytes) > GUARD_INPUT_LIMITS.inputBytes) throw new Error('Installed guard identity is missing or oversized.')
            const guardRoot = (runtime.env ?? process.env).COCKPIT_GUARD_ROOT
            if (!guardRoot) throw new Error('Installed guard root is missing.')
            const guardEnvironment = runtime.env ?? process.env
            response = await runGuardEvaluationApplication({ identity: JSON.parse(identityBytes), guardRoot, payload, harness, cwd: process.cwd(), transport: !reply,
                askIsDeny: guardEnvironment.COCKPIT_ASK_IS_DENY === '1',
                ripgrepConfigActive: Object.hasOwn(guardEnvironment, 'RIPGREP_CONFIG_PATH') || guardEnvironment.COCKPIT_RIPGREP_CONFIG_ACTIVE === '1',
                // The handler runs with a scrubbed environment, so the dispatching process forwards the harness's search path.
                searchPath: (reply ? guardEnvironment.COCKPIT_GUARD_SEARCH_PATH ?? guardEnvironment.PATH : guardEnvironment.PATH) ?? '' }, {
                loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
                resolveGit: () => resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
                resolveDocker: () => resolveDockerExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }),
                execute: executeProbe,
            })
        } catch {
            response = { decision: { decision: 'unavailable', reason: 'Guard input, arguments or installed identity are unavailable or malformed.' },
                diagnostics: [{ severity: 'error', code: 'GUARD_INPUT_UNAVAILABLE', message: 'Guard input, arguments or installed identity are unavailable or malformed.', target: 'guard' }] }
        }
        // Project once at the publication boundary; adapters only spell the closed decision.
        const projected = JSON.parse(renderJsonResponse({ result: response.decision, diagnostics: response.diagnostics }, response.fixContext)) as { result: typeof response.decision }
        const decision = projected.result.decision === 'ask' && (runtime.env ?? process.env).COCKPIT_ASK_IS_DENY === '1'
            ? { ...projected.result, decision: 'deny' as const } : projected.result
        if ((runtime.env ?? process.env).COCKPIT_GUARD_TRANSPORT !== '1') {
            io.stdout.write(JSON.stringify(decision) + '\n')
            return finish(EXIT_CODES.success)
        }
        const output = response.native ?? adaptGuardDecision(harness, decision)
        io.stdout.write(output.stdout)
        io.stderr.write(output.stderr)
        return finish(output.exitCode)
    }
    if (commandName === '--help' && commandArgs.length === 0) {
        io.stdout.write(renderHelp())
        return finish(EXIT_CODES.success)
    }
    if (commandName === '--version' && commandArgs.length === 0) {
        io.stdout.write(renderVersion())
        return finish(EXIT_CODES.success)
    }

    const handlers: Partial<CommandHandlers> = { ...defaultHandlers(runtime), ...handlerOverrides }
    const operators: OperatorHandlers = { ...defaultOperatorHandlers(runtime), ...handlerOverrides }
    const optionTerminator = commandArgs.indexOf('--')
    const optionArgs = commandArgs.slice(0, optionTerminator === -1 ? commandArgs.length : optionTerminator)
    if (definition && optionArgs.some(arg => arg === '--help' || arg === '-h')) {
        io.stdout.write(renderCommandHelp(definition))
        return finish(EXIT_CODES.success)
    }
    // Resolved before dispatch: the publication tail below may only forward outcomes, not decide anything.
    const usageHint = definition ? `Run 'npx --no cockpit ${definition.name} --help' for usage.\n`
        : commandName ? `Run 'npx --no -- cockpit --help' for the command list.\n` : renderHelp()
    let jsonRequested = optionArgs.includes('--json')
    let outcome: CommandOutcome
    const duplicateSetupOption = definition?.handler === 'setup'
        ? ['config', 'write-instruction-pointers'].find(name => optionCount(optionArgs, name) > 1)
        : undefined

    if (!commandName) {
        outcome = usageOutcome('CLI_COMMAND_REQUIRED', 'a command is required')
    } else if (!definition) {
        outcome = usageOutcome('CLI_UNKNOWN_COMMAND', `unknown command "${commandName}"`)
    } else if (definition.handler === 'init' && Object.keys(definition.options).some(name => optionCount(optionArgs, name) > 1)) {
        outcome = usageOutcome('CLI_USAGE_INVALID', 'each init option may be supplied only once')
    } else if (
        definition.handler === 'document' &&
        ['registry', 'output'].some((name) => optionCount(optionArgs, name) > 1)
    ) {
        outcome = usageOutcome('DOCUMENT_OPTION_DUPLICATE', 'each document input or output may be supplied only once')
    } else if (definition.handler === 'document' && jsonRequested && optionCount(optionArgs, 'output') > 0) {
        // --json never writes files; without this refusal --output was dropped silently and the run exited 0.
        outcome = usageOutcome('DOCUMENT_OUTPUT_JSON_UNSUPPORTED', '--json prints the result envelope and does not write --output; drop one of the two options', '--output')
    } else if (definition.handler === 'registry-resolve' && optionCount(optionArgs, 'output') > 0) {
        outcome = usageOutcome('REGISTRY_OUTPUT_UNSUPPORTED', 'registry-resolve writes artifact bytes to stdout', '--output')
    } else if (
        definition.handler === 'registry-resolve' &&
        ['registry', 'siblings-root', 'adoption'].some((name) => optionCount(optionArgs, name) > 1)
    ) {
        outcome = usageOutcome('REGISTRY_OPTION_DUPLICATE', 'each registry-resolve input may be supplied only once')
    } else if (duplicateSetupOption !== undefined) {
        outcome = usageOutcome(ENVIRONMENT_CODES.SETUP_OPTION_DUPLICATE,
            'each setup option may be supplied only once', `--${duplicateSetupOption}`)
    } else if (
        definition.handler !== 'document' && definition.handler !== 'registry-resolve' && definition.handler !== 'setup'
        && Object.entries(definition.options).some(([name, option]) => name !== 'json' && !('multiple' in option && option.multiple === true) && optionCount(optionArgs, name) > 1)
    ) {
        outcome = usageOutcome('CLI_USAGE_INVALID', `each ${definition.name} option may be supplied only once`)
    } else {
        let parsed: ParsedCommandArguments | undefined
        try {
            parsed = parseArgs({
                args: commandArgs,
                strict: true,
                allowPositionals: true,
                options: definition.options,
            }) as ParsedCommandArguments
        } catch (error) {
            const message = error instanceof Error ? error.message : 'invalid command arguments'
            outcome = usageOutcome('CLI_USAGE_INVALID', message)
        }

        if (parsed) {
            jsonRequested = parsed.values.json === true
            let decoded = await decodeRequest(definition.handler, parsed, runtime.env ?? process.env)
            if ('handler' in decoded && 'configPath' in decoded.input && typeof decoded.input.configPath === 'string') {
                try {
                    resolvedConfigPath = createInvocationRecord({ verb, durationMs: 0, exitCode: EXIT_CODES.success,
                        resolvedConfigPath: resolve(decoded.input.configPath) }).resolvedConfigPath
                } catch {
                    decoded = usageOutcome('CLI_USAGE_INVALID', 'config path must be recordable without control characters', '--config')
                }
            }
            if (!('handler' in decoded)) {
                outcome = decoded
            } else if (decoded.handler === 'logs' && decoded.input.follow && !runtime.signal) {
                outcome = usageOutcome('CLI_USAGE_INVALID', '--follow requires a cancellation signal', '--follow')
            } else {
                try {
                    outcome = await invokeHandler(decoded, handlers, operators, {
                        interactive: parsed.values.interactive === true,
                        json: parsed.values.json === true,
                        ci: (runtime.env ?? process.env).CI,
                        env: runtime.env ?? process.env,
                    }, io)
                } catch (error) {
                    outcome = usageOutcome(
                        'CLI_INTERNAL_ERROR',
                        `the "${definition.handler}" command failed unexpectedly (${error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error value thrown'})`,
                        definition.handler,
                    )
                }
            }
            if (!parsed.values.json) {
                try {
                    outcome = await executeOutcome(outcome)
                } catch (error) {
                    outcome = usageOutcome(
                        'CLI_INTERNAL_ERROR',
                        `the "${definition.handler}:output" operation failed unexpectedly (${error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error value thrown'})`,
                        `${definition.handler}:output`,
                    )
                }
            }
        }
    }

    if (jsonRequested) {
        return finish(outcome!.status, outcome!)
    }
    if (outcome!.artifact && !outcome!.destination) io.stdout.write(outcome!.artifact)
    io.stdout.write(renderHumanDiagnostics([], { command: commandName, outcome: outcome! }))
    io.stderr.write(renderHumanDiagnostics(outcome!.diagnostics, undefined, outcome!.fixContext, usageHint))
    return finish(outcome!.status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await runCli(process.argv.slice(2))
}
