import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    authenticatedExecutionOutcome,
    executeProbe,
    type ExecutePlanOutcome,
    type ExecuteProbeOutcome,
    type ForegroundProcessInput,
    type ForegroundProcessOutcome,
} from '../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    type CheckoutId,
    type ConfigSourceSnapshot,
    type EnvironmentCommandOutcome,
    type ExecutionPlan,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type ExecutionStep,
    type HolderId,
    type LifecycleProgress,
    type SetupExecutionEvidence,
    type SetupRefusalEvidence,
    type SourceProvenance,
    type StackId,
    snapshotJson,
} from './contract.js'
import { gitEnvironment, type SetupObservation, type SetupResult } from './setup.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveDockerExecutable, resolvedExecutable, resolvedGitExecutable, type ExecutableResolution, type ResolvedExecutable } from './executable.js'
import { CockpitConfig, type EntrypointDerivative, type InstallPolicy, type Sibling } from '../schema.js'
import { evaluateGuard, GUARD_ROOT_PROTECTIONS, guardIdentity, type GuardDecision, type GuardEvaluationPolicy, type GuardProtectedIdentity, type GuardInvocationProfile, type GuardProjectCommand } from '../guards/evaluator.js'
import { resolveOrdinaryInvocation } from '../command-table.js'
import { issueResolvedAutonomyGrants, type ResolvedAutonomyGrants } from '../autonomy/launcher.js'
import { GUARD_INPUT_LIMITS, parseGuardInput } from '../guards/invocation-parser.js'
import { readAnchoredFile, readAnchoredBatches, nodeAuthority } from '../generated-environment/transaction.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity, type GuardHandlerIdentity } from '../guards/local-identity.js'
import type { SurfaceTarget } from '../surfaces/contract.js'
import type { FixContext } from '../fix-catalogue.js'
import { completeGuardTransport, planGuardTransport, type NativeGuardOutput } from '../guards/harness-adapter.js'
import {
    abortStateTransaction,
    authenticateStateNamespace,
    readState,
    transactState,
    type StateRecord,
    type StateResult,
    type StateNamespace,
} from './state.js'
import {
    decodeLifecycleRecord,
    recordLifecycleSeeded,
    recordLifecycleStarted,
    resolveLifecycleStage,
    type CurrentLifecycleRecord,
    type GeneratedLifecycleReplay,
    type LifecycleHistoryTransition,
    type LifecycleRecordValue,
} from './lifecycle-stage.js'
import { generatedApplicationProjection, prepareGeneratedEnvironmentCurrentness, type GeneratedApplicationProjection, type GeneratedEnvironmentCurrentness } from './generated-application.js'
import { observeComposeTopology } from './compose-topology.js'
import { declaredRuntime, RuntimeNotDeclaredError } from './declaration.js'
import type { ReleaseFreshness } from '../freshness.js'
import { proposeGeneratedEnvironmentRepair } from '../repair.js'
import type { ActiveSurfaceOverride, SurfaceUpgradeFinding } from '../surfaces/merge.js'
import { SURFACE_FEATURES } from '../surfaces/contract.js'
import { isInstallObservation, projectInstallProgress, type PlanInstallInput } from './installs.js'
import { isHostObservation } from './host-observation.js'
import { isGeneratedObservation } from './generated-stack.js'
import type { GeneratedComposeArtifactAuthority } from './generated-compose-authority.js'
import { isDataModeCompletion, isDataModeObservation, readDataModeOutcome, consumeDataModeOutcomeProjection, type DataModeExecutionResult } from './data-plane.js'
import { isExternalDependencyObservation, isExternalDependencyObservationProjection, projectExternalDependencyProgress } from './external-dependencies.js'
import type { EnvironmentSeedPlan, EnvironmentSeedResult } from './templates.js'
import {
    observeInstallPolicyLockfiles,
    withInstallPolicyProjection,
    type InstallPolicyLockfileObservation,
    type InstallPolicyProjection,
} from './install-policy-observation.js'
import { resolveInstallPolicies, renderGuardProjectCommand, type InstallPolicyResolution, type ResolvedInstallPolicyBinding } from './install-policy.js'
import {
    cockpitId as deriveCockpitId,
    checkoutId as deriveCheckoutId,
    holderId as deriveHolderId,
    stackId as deriveStackId,
} from './identity.js'
import {
    consumeSetupCheckoutProjection,
    observeSetupCheckout,
    withSetupCheckoutProjection,
    type EnvironmentIgnoreRefusal,
    type ConsumedSetupCheckoutObservation,
    type SetupCheckoutProjection,
    type SetupCheckoutObservation,
} from './setup-observation.js'
import {
    loadCockpitConfig,
    consumeLoadedConfigProjection,
    type LoadedConfigProjection,
} from '../config/load.js'
import { deriveRegistry, type RegistryDerivationResult } from '../registry-derivation.js'
import type { LifecycleStageProjection } from './lifecycle-stage.js'
import {
    compensateAcquiredPortHolder,
    deriveEntrypoints,
    inspectPortLeaseTransfer,
    observeRetainedPortFamily,
    projectRetainedPortFamilyResult,
    releasePortFamily,
    type LeasePortFamilyResult,
    type PortFamilyConfig,
    type PortLeaseProjection,
} from './ports.js'
import {
    consumeLifecycleIssuance,
    planDown,
    planResetLifecycle,
    planSleep,
    admitUpProgress,
    planAdmittedUp,
} from './lifecycle.js'
import {
    admitRuntimeServiceHealth,
    admitRuntimeServiceInspectFailure,
    admitRuntimeServiceObservation,
    admitRuntimeServiceStageOutcome,
    admitRuntimeServiceRevalidationStatus,
    admitRuntimeServiceRevalidation,
    createRuntimeServiceHealthPlan,
    createRuntimeServicePlan,
    admitBuiltImageLauncher,
    createRuntimeServiceRevalidationPlan,
    observeRuntimeServiceColdStart,
    resolveRuntimeServiceOrder,
    admitRuntimeStopped,
    admitRuntimeStopFailure,
    consumeRuntimeStopped,
    consumeRuntimeStopFailure,
    createRuntimeStopObservationPlan,
    createRuntimeStopPlan,
    type RuntimeLifecycleProjection,
    type RuntimeServiceEvidence,
    type RuntimeServiceFailureEvidence,
    type RuntimeServiceHealthPlan,
    type RuntimeServiceObservation,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { admitFailureLogs, planFailureLogs } from './logs.js'
import {
    finalizeDrainOutcome,
    inspectDestructiveDrainRecovery,
    inspectSleepDrainRecovery,
    prepareDrainOutcomePublication,
    recoverDrainReservation,
    recoverSleepDrainReservation,
    reserveDrain,
    reserveDrainAttempt,
    type DrainOutcomeAuthority,
    type DrainReservationRequest,
} from './claims.js'
import {
    admitReclaimFailure,
    consumeReclaimCompleted,
    consumeReclaimFailure,
    planReset,
    planTeardown,
    projectResetActionTargets,
    projectTeardownActionTargets,
    reconcileReclaimAction,
    redeemReclaimAction,
    type PlanResetInput,
    type PlanTeardownInput,
    type ReclaimDiscoverySnapshot,
    type ResetPreview,
    type ResetPlanResult,
    type ResetTargetInput,
    type TeardownPlanResult,
} from './reclaim.js'
import {
    selectDestructiveInstance,
    type SelectDestructiveInstanceInput,
} from './instance.js'
import {
    aggregateObservations,
    observationSatisfiesExpectation,
    projectDoctor,
    type DoctorCheck,
    type EvaluatedObservation,
    type PreflightContext,
    type PreflightEvaluation,
} from './observations.js'
import { envSchemaToolMissing, VARLOCK_INSTALL_URL } from './env-schema-observation.js'
import {
    createComparisonRemoteRefStep,
    createGitObservationStep,
    observeComparisonRemoteRef,
    observeComparisonRemoteRevalidation,
    observeComparisonRemoteUrl,
    observeGit,
    type ComparisonRemoteResult,
} from './git-observation.js'
import {
    collectLogs,
    planLogs,
    type LogRecord,
    type LogRequest,
    type RestartWindow,
} from './logs.js'
import {
    environmentBaselineConfirmation,
    recordEnvironmentBaseline,
    type CapturedRuntimeEvidence,
    type EnvironmentBaseline,
    type EnvironmentSnapshot,
} from './evidence.js'

export const mechanism = {
    id: 'environment-application',
    module: 'packages/cockpit/src/environment/application.ts',
    exports: [
        'setupEnvironment', 'issueSetupRunContext', 'runSetup',
        'issueLifecycleRunContext', 'withLifecycleConfiguration', 'decodeLifecycleRecord', 'revalidateService', 'runUp', 'runSession', 'runSleep',
        'issueDestructiveRunContext', 'runDown', 'runReset', 'beginOperatorReset',
        'runPreflight', 'runDoctor', 'runLogs', 'runBaselineRecord', 'beginOperatorBaselineRecord',
        'prepareGuardEvaluationPolicy',
        'runGuardEvaluationApplication',
    ],
} as const

export interface GuardEvaluationApplicationInput {
    readonly identity: unknown
    /** The checkout the invoked guard script resolved from its own location. */
    readonly guardRoot: string
    readonly payload: unknown
    readonly harness: SurfaceTarget
    readonly cwd: string
    readonly transport?: boolean
    readonly askIsDeny?: boolean
}

export interface GuardEvaluationApplicationAdapters {
    readonly loadConfig: typeof loadCockpitConfig
    readonly observeCheckout: typeof observeSetupCheckout
    readonly resolveGit: () => Promise<import('./executable.js').ExecutableResolution>
    /** Needed only by a compose-first cockpit, whose service list is read from its Compose files. */
    readonly resolveDocker?: () => Promise<import('./executable.js').ExecutableResolution>
    readonly execute?: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
}

// `cockpit logs --service <id>` is an ordinary invocation only for a declared service. A generated
// stack declares its services; a compose-first cockpit's services are whatever its own Compose files
// resolve to, so they are read from Compose rather than guessed, and an unreadable topology refuses.
async function guardServiceIds(
    config: CockpitConfig,
    root: string,
    observe: Readonly<{
        node: ResolvedExecutable
        resolveDocker?: () => Promise<ExecutableResolution>
        execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    }>,
): Promise<readonly string[] | string> {
    const runtime = declaredRuntime(config.environment)
    if (runtime === 'generated') return config.environment.generated!.services.map(service => service.id)
    if (runtime === 'none') return Object.freeze([])
    const docker = observe.resolveDocker ? await observe.resolveDocker() : undefined
    if (docker?.state !== 'available') return docker?.reason ?? 'no Docker executable resolver is bound'
    const topology = await observeComposeTopology({ root, references: config.environment.compose_files,
        projectName: config.cockpit.name, docker: docker.value, node: observe.node, env: { PATH: GUARD_EXECUTABLE_SEARCH_PATH } }, observe.execute)
    return topology.kind === 'complete' ? topology.services.map(service => service.id) : topology.reason
}

export interface GuardEvaluationApplicationResult {
    readonly decision: GuardDecision
    readonly diagnostics: readonly import('./contract.js').Diagnostic[]
    readonly fixContext?: FixContext
    readonly native?: NativeGuardOutput
}

// Every refusal below holds all of the agent's calls, `git restore` included, so each says what
// failed, why that blocks everything, and the human action that clears it. Regeneration is a human
// step on purpose: guard policy comes from cockpit.toml, and an agent able to apply its own edit
// could loosen its guard.
type GuardFix = { readonly kind: 'sync' } | { readonly kind: 'restore'; readonly path: string; readonly thenSync: boolean }
function guardHeld(identity: GuardHandlerIdentity, what: string, why: string, fix: GuardFix): string {
    const sync = `\`cockpit sync --config ${identity.configPath}\` in a terminal, outside the agent`
    const action = fix.kind === 'sync' ? `a human must run ${sync}, then commit any regenerated files`
        : fix.thenSync
            // A restored file is a new file, so its identity must be authenticated again.
            ? `a human must restore it with \`git -C ${identity.root} restore ${fix.path}\` (it is committed) and then run ${sync}`
            : `a human must restore it with \`git -C ${identity.root} restore ${fix.path}\` (it is committed), or run ${sync}`
    return `${what}; ${why}, so every tool call is held, including \`cockpit sync\` run through this agent. Fix: ${action}.`
}

const GUARD_RESTORABLE = new Set(['.cockpit/generated-environment-ownership.json', '.cockpit/guards/bash-guard.sh',
    '.claude/settings.json', '.codex/hooks.json', '.opencode/plugin/cockpit-guards.js'])

/** Installed bytes are authority only while their source, roots and publication still match. */
export async function runGuardEvaluationApplication(
    input: GuardEvaluationApplicationInput,
    adapters: GuardEvaluationApplicationAdapters,
): Promise<GuardEvaluationApplicationResult> {
    const unavailable = (reason: string): GuardEvaluationApplicationResult => ({
        decision: { decision: 'unavailable', reason },
        diagnostics: [{ severity: 'error', code: 'GUARD_AUTHORITY_UNAVAILABLE', message: reason, target: 'guard' }],
    })
    try {
        const data = ownDataValues(snapshotJson(input), ['cwd', 'guardRoot', 'harness', 'identity', 'payload'], ['transport', 'askIsDeny'])
        if (!data
            || data.transport !== undefined && typeof data.transport !== 'boolean'
            || data.askIsDeny !== undefined && typeof data.askIsDeny !== 'boolean'
            || !['claudecode', 'codexcli', 'opencode'].includes(String(data.harness))) return unavailable('Guard request is malformed.')
        const harness = data.harness as SurfaceTarget
        const captured = ownDataValues(snapshotJson(data.identity), ['root', 'rootDevice', 'rootInode', 'configPath', 'configSha256', 'configDevice', 'configInode', 'node', 'nodeSha256', 'module', 'moduleSha256'])
        if (!captured
            || !Object.values(captured).every(value => typeof value === 'string')
            || !['configSha256', 'nodeSha256', 'moduleSha256'].every(key => /^[a-f0-9]{64}$/.test(String(captured[key])))) return unavailable('Installed guard identity is missing or malformed.')
        const identity = captured as unknown as GuardHandlerIdentity
        if ([identity.root, identity.configPath, identity.node, identity.module].some(path => !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f-\x9f]/.test(path))
            || dirname(identity.configPath) !== identity.root || typeof data.cwd !== 'string' || realpathSync(data.cwd) !== data.cwd
            // A local identity copied from another checkout would evaluate this one under that one's policy.
            || data.guardRoot !== identity.root
            ) return unavailable('Installed guard location does not match this application.')
        const configFile = relative(identity.root, identity.configPath)
        const changed = (what: string) => unavailable(guardHeld(identity, `${what} since the guards were generated`,
            'the guard trusts only the cockpit, Node and configuration it was generated for', { kind: 'sync' }))
        if (realpathSync(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))) !== identity.module) return changed('a different cockpit installation is running')
        const roots = new Map<string, Stats>()
        for (const [path, device, inode, directory] of [
            [identity.root, identity.rootDevice, identity.rootInode, true],
            [identity.configPath, identity.configDevice, identity.configInode, false],
        ] as const) {
            let status: Stats
            try { status = lstatSync(path) }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !directory) return unavailable(guardHeld(identity,
                    `${identity.configPath} is missing`, 'guard policy comes from it', { kind: 'restore', path: configFile, thenSync: true }))
                throw error
            }
            if (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile())
                || String(status.dev) !== device || String(status.ino) !== inode || realpathSync(path) !== path) {
                return changed(directory ? `the cockpit checkout ${path} was moved or replaced` : `${path} was replaced`)
            }
            roots.set(path, status)
        }
        const node = await nodeAuthority()
        if (!node || node.canonicalPath !== identity.node || node.sha256 !== identity.nodeSha256) return changed(`the Node executable changed (now ${node?.canonicalPath ?? 'unreadable'})`)
        const read = async (root: string, path: string, maxBytes: number) => {
            const result = await readAnchoredFile(root, path, maxBytes, node, { execute: adapters.execute ?? executeProbe })
            if (result.kind !== 'complete') throw new Error('Guard authority file is missing, changed, oversized or crosses a symlink boundary.')
            return result
        }
        const module = await read(dirname(identity.module), basename(identity.module), 16_777_216)
        if (module.sha256 !== identity.moduleSha256) return changed('the installed cockpit version changed (its handler bytes differ)')
        const loaded = await adapters.loadConfig(identity.configPath)
        if (loaded.kind !== 'complete' || loaded.result.source.path !== identity.configPath || loaded.result.source.sha256 !== identity.configSha256) {
            return unavailable(guardHeld(identity, `${identity.configPath} changed since the guards were generated`,
                'guard policy comes from it and an edit takes effect only once a human approves it', { kind: 'sync' }))
        }
        const config = loaded.result.config
        const manifestPath = '.cockpit/generated-environment-ownership.json'
        const registration = { claudecode: '.claude/settings.json', codexcli: '.codex/hooks.json', opencode: '.opencode/plugin/cockpit-guards.js' }[harness]
        const publicationRequests = [manifestPath, '.cockpit/guards/bash-guard.sh', registration, GUARD_LOCAL_PATHS.identity].map(path => ({
            path, action: 'read-file' as const, maxBytes: path === manifestPath ? 1_048_576 : 65_536,
        }))
        const readPublication = async () => {
            const batch = await readAnchoredBatches(identity.root, publicationRequests, node, { execute: adapters.execute ?? executeProbe })
            if (batch?.kind !== 'complete' || batch.results.length !== publicationRequests.length) throw new Error('Guard publication read could not be authenticated.')
            return new Map(publicationRequests.map((request, index) => {
                const result = batch.results[index]
                if (result?.kind === 'missing') throw new GuardFileMissing(request.path)
                if (result?.kind !== 'complete') throw new Error('Guard authority file is missing, changed, oversized or crosses a symlink boundary.')
                return [request.path, result] as const
            }))
        }
        let publication: Awaited<ReturnType<typeof readPublication>>
        try { publication = await readPublication() }
        catch (error) {
            if (!(error instanceof GuardFileMissing)) throw error
            return unavailable(GUARD_RESTORABLE.has(error.path)
                ? guardHeld(identity, `${error.path} is missing`, 'it authenticates the guard and the hook that launches it', { kind: 'restore', path: error.path, thenSync: false })
                : guardHeld(identity, `${error.path} is missing`, 'it records the Node executable and cockpit handler on this machine, which committed files cannot carry', { kind: 'sync' }))
        }
        const local = parseGuardLocalIdentity(publication.get(GUARD_LOCAL_PATHS.identity)!.bytes.toString('utf8'))
        if (!local || !isDeepStrictEqual(local, identity)) return unavailable('Installed guard identity does not match its machine-local record.')
        const manifestRead = publication.get(manifestPath)!
        const ownership = parseOwnershipManifest(manifestRead.bytes.toString('utf8'), {
            root: identity.root, configPath: identity.configPath,
            cockpitId: deriveCockpitId({ name: config.cockpit.name, mainCheckoutPath: identity.root }),
        })
        if (ownership.kind !== 'complete' || ownership.manifest.source.sha256 !== identity.configSha256) return unavailable('Installed guard publication is stale or unauthenticated.')
        const producer = ownership.manifest.producer
        if (ownership.manifest.format !== 'cockpit-generated-ownership/v3' || !producer
            || producer.package !== installedPackageMetadata.name
            || producer.version !== installedPackageMetadata.version
            || producer.sourceRevision !== installedPackageMetadata.cockpitSourceRevision) return changed(`the installed cockpit version changed (the guards were generated by ${producer ? `${producer.package} ${producer.version}` : 'an unknown producer'}, ${installedPackageMetadata.name} ${installedPackageMetadata.version} is installed)`)
        const published = new Map<string, string>()
        for (const path of ['.cockpit/guards/bash-guard.sh', registration]) {
            const entry = ownership.manifest.entries.find(entry => entry.path === path)
            const actual = publication.get(path)!
            if (!entry || entry.kind !== 'file' || entry.sha256 !== actual.sha256) return unavailable('Installed guard registration or transport bytes drifted.')
            published.set(path, actual.sha256)
        }
        if (data.transport === true) {
            const plan = planGuardTransport({ target: harness, handler: identity.module, cwd: data.cwd, stdin: data.payload })
            if (plan.kind !== 'complete') return unavailable(plan.message)
            const guard = join(identity.root, '.cockpit/guards/bash-guard.sh')
            const shell = realpathSync('/bin/bash')
            const shellStatus = lstatSync(shell)
            if (!shellStatus.isFile() || shellStatus.isSymbolicLink() || !(shellStatus.mode & 0o111)
                || shellStatus.size > 16_777_216) return unavailable('Guard transport shell identity is unavailable.')
            const shellSha256 = createHash('sha256').update(readFileSync(shell)).digest('hex')
            const step: ExecutionStep = {
                id: 'guard-handler', argv: [shell, guard, '--handler-stdio', ...plan.argv.slice(1)], argv0: '/bin/bash',
                cwd: plan.cwd, env: { COCKPIT_GUARD_STDIN: plan.stdin, COCKPIT_GUARD_ROOT: identity.root, COCKPIT_ASK_IS_DENY: data.askIsDeny ? '1' : '0' },
                timeoutMs: plan.timeoutMs, stdoutLimitBytes: plan.stdoutBytes, stderrLimitBytes: plan.stderrBytes,
                paths: [], ports: [], labels: { action: 'guard-handler' }, expected: [],
                consumedFiles: [
                    { path: shell, sha256: shellSha256, maxBytes: 16_777_216, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                    { path: guard, sha256: published.get('.cockpit/guards/bash-guard.sh')!, maxBytes: 65_536, argvIndexes: [1], executable: false },
                ],
                filesystemChecks: [], compensation: [],
            }
            const outcome = authenticatedExecutionOutcome(await (adapters.execute ?? executeProbe)(step), step)
            if (!outcome) return unavailable('Guard handler execution evidence is unauthenticated or changed.')
            const native = completeGuardTransport(plan, {
                exitCode: outcome.kind === 'complete' ? outcome.execution.exitCode : 2,
                signal: outcome.execution.signal,
                stdout: new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout),
                stderr: new TextDecoder('utf-8', { fatal: true }).decode(outcome.stderr),
            })
            return { decision: { decision: native.decision, reason: 'Guard transport completed its bounded handler dispatch.' }, diagnostics: [], native }
        }
        const git = await adapters.resolveGit()
        if (git.state !== 'available') return unavailable('Guard checkout observation requires an authenticated Git executable.')
        const checkout = await adapters.observeCheckout({ source: loaded.result.source, cockpitName: config.cockpit.name,
            observedAt: new Date().toISOString(), env: {}, gitExecutable: git.value })
        const parsed = parseGuardInput(data.payload)
        if (parsed.status !== 'parsed') return unavailable(parsed.reason)
        if (parsed.cwd !== data.cwd) return unavailable('Guard request cwd does not match its invocation authority.')
        const prepared = await prepareGuardEvaluationPolicy({ configuration: loaded.result, checkout })
        if (prepared.kind !== 'complete') return unavailable('Guard policy authority could not be authenticated.')
        const inspected = new Map<string, Stats>()
        const inspect: import('../guards/evaluator.js').PathInspection = request => {
            const path = resolve(request.cwd, request.path)
            const root = prepared.result.policy.allowedRoots.filter(root => confinedPath(root, path)).sort((a, b) => b.length - a.length)[0]
            if (!root) return { status: 'unavailable', path, symlink: false }
            let cursor = root
            const rootStatus = lstatSync(root)
            inspected.set(root, rootStatus)
            // Identities let the evaluator recognise a protected entry under any spelling the volume
            // resolves to it; a missing leaf reports its nearest existing ancestors only.
            const chain = [guardIdentity(rootStatus)]
            let exists = true
            for (const component of relative(root, path).split(sep).filter(Boolean)) {
                cursor = join(cursor, component)
                let status: Stats
                try { status = lstatSync(cursor) }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { exists = false; break }
                    throw error
                }
                if (status.isSymbolicLink()) return { status: 'resolved', path, symlink: true }
                inspected.set(cursor, status)
                chain.push(guardIdentity(status))
            }
            return { status: 'resolved', path, symlink: false, identity: exists ? chain.at(-1)! : null, ancestors: exists ? chain.slice(0, -1) : chain }
        }
        const cockpitInvocations: GuardInvocationProfile[] = []
        const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
        let launcherSha256: string | undefined
        if (parsed.invocations.some(invocation => invocation.executable === launcher)) {
            const status = lstatSync(launcher)
            if (!status.isFile() || status.isSymbolicLink() || !(status.mode & 0o111) || realpathSync(launcher) !== launcher) {
                return unavailable('Guard ordinary command executable is unavailable or ambiguous.')
            }
            launcherSha256 = (await read(dirname(launcher), basename(launcher), 65_536)).sha256
            inspected.set(launcher, status)
            const services = await guardServiceIds(config, identity.root,
                { node, resolveDocker: adapters.resolveDocker, execute: adapters.execute ?? executeProbe })
            if (typeof services === 'string') return unavailable(`Guard could not read the Compose service list: ${services}`)
            const authority = { executable: launcher, canonicalRoot: identity.root, configPath: identity.configPath,
                allowedRoots: prepared.result.policy.allowedRoots, services }
            for (const invocation of parsed.invocations) {
                const candidate = resolveOrdinaryInvocation({ executable: invocation.executable ?? '', cwd: invocation.cwd, argv: invocation.argv }, authority, path => {
                    const fact = inspect({ path, cwd: invocation.cwd, operation: 'write' })
                    return !!fact && typeof fact === 'object' && 'status' in fact && fact.status === 'resolved'
                        && 'symlink' in fact && fact.symlink === false
                })
                if (candidate) cockpitInvocations.push(candidate)
            }
        }
        if (cockpitInvocations.length + prepared.result.policy.projectCommands.length > GUARD_INPUT_LIMITS.invocations) return unavailable('Guard candidates exceed the invocation bound.')
        const decision = evaluateGuard(parsed, { ...prepared.result.policy, cockpitInvocations }, inspect)
        const current = await adapters.loadConfig(identity.configPath)
        if (current.kind !== 'complete' || current.result.source.sha256 !== identity.configSha256) return unavailable('Guard configuration changed during evaluation.')
        for (const [path, before] of [...roots, ...inspected]) {
            const after = lstatSync(path)
            // Directories may receive unrelated leaves, but replacement and file changes invalidate evidence.
            if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                || before.isFile() && (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)) return unavailable('Guard filesystem authority changed during evaluation.')
        }
        const currentPublication = await readPublication()
        for (const [path, hash] of [[manifestPath, manifestRead.sha256], [GUARD_LOCAL_PATHS.identity, publication.get(GUARD_LOCAL_PATHS.identity)!.sha256], ...published] as const) {
            if (currentPublication.get(path)!.sha256 !== hash) return unavailable('Guard publication changed during evaluation.')
        }
        if ((await read(dirname(identity.module), basename(identity.module), 16_777_216)).sha256 !== identity.moduleSha256) return unavailable('Guard handler changed during evaluation.')
        if (launcherSha256 && (await read(dirname(launcher), basename(launcher), 65_536)).sha256 !== launcherSha256) return unavailable('Guard ordinary command executable changed during evaluation.')
        return { decision, diagnostics: decision.decision === 'allow' ? [] : [{ severity: 'error', code: 'GUARD_REFUSED', message: decision.reason, target: 'guard' }] }
    } catch {
        return unavailable('Guard authority could not be read or revalidated.')
    }
}

class GuardFileMissing extends Error {
    constructor(readonly path: string) { super(`${path} is missing`) }
}

export interface PendingGuardEvaluationPolicy {
    readonly status: 'pending_integration'
    readonly policy: GuardEvaluationPolicy
    readonly autonomy?: ResolvedAutonomyGrants
}

export interface GuardPolicyCommandAuthority {
    readonly executable: ResolvedExecutable
    readonly invocations: readonly GuardInvocationProfile[]
    readonly autonomy?: Pick<ResolvedAutonomyGrants, 'target' | 'nativeReads' | 'guardRegistration'>
}

export interface GuardEvaluationPolicyInput {
    readonly configuration: LoadedConfigProjection
    readonly checkout: SetupCheckoutObservation
    readonly commands?: GuardPolicyCommandAuthority
}

function guardPolicyRefusal(message: string): EnvironmentCommandOutcome<PendingGuardEvaluationPolicy> {
    return { kind: 'refusal', status: 2, result: null, diagnostics: [ownerDiagnostic(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, message, 'guard-policy',
    )] }
}

/** Source projections share authenticated authority; installed consumption is admitted separately. */
export async function prepareGuardEvaluationPolicy(
    input: GuardEvaluationPolicyInput,
): Promise<EnvironmentCommandOutcome<PendingGuardEvaluationPolicy>> {
    const inputData = ownDataValues(input, ['configuration', 'checkout'], ['commands'])
    const data = inputData && Object.hasOwn(inputData, 'configuration') && Object.hasOwn(inputData, 'checkout') ? inputData : undefined
    if (!data) return guardPolicyRefusal('guard policy requires own-data configuration and checkout observations')
    const configuration = data.configuration as LoadedConfigProjection
    const exposed = snapshotJson(configuration)
    const loaded = consumeLoadedConfigProjection(configuration)
    if (!loaded || !exposed || !isDeepStrictEqual(exposed, snapshotJson(loaded))) {
        return guardPolicyRefusal('guard policy configuration authority is copied, changed or already consumed')
    }
    const derived = deriveRegistry(loaded.config)
    if (derived.kind !== 'complete') return guardPolicyRefusal(`guard policy registry refused (${derived.code}): ${derived.message}`)
    const guardConfig = CockpitConfig.parse(derived.result.config)
    const observed = snapshotJson(data.checkout) as SetupCheckoutObservation | undefined
    if (observed?.state !== 'available') return guardPolicyRefusal('guard policy checkout observation is unavailable')
    try {
        const identities = new Map<string, Stats>()
        let siblingsRoot: string | undefined
        const result = await withSetupCheckoutProjection(data.checkout, {
            source: loaded.source, cockpitName: loaded.config.cockpit.name, evaluatedAt: Date.parse(observed.observedAt),
        }, (projection) => {
            const checkout = consumeSetupCheckoutProjection(projection)
            if (!checkout || !sameSource(checkout.source, loaded.source)) {
                return guardPolicyRefusal('guard policy checkout does not match configuration authority')
            }
            const config = guardConfig
            const protectedIdentities = new Map<string, GuardProtectedIdentity>()
            // Records the identity of every existing component so the evaluator can match a protected
            // entry by inode rather than by spelling.
            const protect = (root: string, path: string, leaf: 'file' | 'directory', label: string) => {
                const segments = relative(root, path).split(sep)
                const chain = [guardIdentity(identities.get(root)!)]
                let cursor = root
                let exists = true
                for (const [index, segment] of segments.entries()) {
                    cursor = join(cursor, segment)
                    let status: Stats
                    try { status = lstatSync(cursor) }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { exists = false; break }
                        throw error
                    }
                    if (status.isSymbolicLink() || (index < segments.length - 1 || leaf === 'directory' ? !status.isDirectory() : !status.isFile())) {
                        throw new Error(`guard policy ${label} path has a symlink or unexpected file type`)
                    }
                    identities.set(cursor, status)
                    chain.push(guardIdentity(status))
                }
                protectedIdentities.set(path, Object.freeze({ path, identity: exists ? chain.at(-1)! : null,
                    ancestors: Object.freeze(exists ? chain.slice(0, -1) : chain) }))
            }
            const directory = (path: string) => {
                const before = lstatSync(path)
                if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(path) !== path
                    || !isAbsolute(path) || path === '/' || /[\x00-\x1f\x7f]/.test(path)) {
                    throw new Error('guard policy requires canonical directory authority')
                }
                identities.set(path, before)
                return path
            }
            const canonicalRoot = directory(checkout.currentCheckoutPath)
            siblingsRoot = directory(resolve(checkout.mainCheckoutPath, config.cockpit.siblings_root))
            const allowedRoots = new Set([canonicalRoot])
            const instances: Array<{ readonly name: string; readonly path: string }> = []
            for (const sibling of config.sibling) {
                const root = resolve(siblingsRoot, sibling.dir)
                if (!confinedPath(siblingsRoot, root)) throw new Error('guard policy sibling escapes its declared root')
                allowedRoots.add(directory(root))
                for (const file of derived.result.secretPaths.filter(row => row.slug === sibling.slug)) {
                    const path = resolve(root, file.path)
                    if (!confinedPath(root, path) || path === root) throw new Error('guard policy instance escapes its sibling root')
                    protect(root, path, 'file', 'instance')
                    instances.push(Object.freeze({ name: `${sibling.slug}-${createHash('sha256').update(file.path).digest('hex').slice(0, 12)}`, path }))
                }
            }
            if (allowedRoots.size > 256 || instances.length > 256) throw new Error('guard policy exceeds restriction root or instance bounds')
            for (const { path, type } of GUARD_ROOT_PROTECTIONS) protect(canonicalRoot, join(canonicalRoot, path), type, 'guard control or secrets')
            // The configuration's own identity lets the evaluator recognise its deletion under any spelling.
            const configPath = join(canonicalRoot, basename(loaded.source.path))
            protect(canonicalRoot, configPath, 'file', 'configuration')
            for (const [path, before] of identities) {
                const after = lstatSync(path)
                if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
                    throw new Error('guard policy root or instance identity changed during construction')
                }
            }
            const policy = Object.freeze({ canonicalRoot, configPath,
                allowedRoots: Object.freeze([...allowedRoots]), instances: Object.freeze(instances),
                protectedIdentities: Object.freeze([...protectedIdentities.values()]),
                protectedBranches: Object.freeze([...config.guards.protected_branches]),
                hostedDatabaseHosts: Object.freeze([...config.guards.hosted_db_hosts]),
                vendorHosts: Object.freeze([...config.guards.vendor_endpoint_hosts]),
                cockpitInvocations: Object.freeze([]), projectCommands: Object.freeze([]),
            })
            return { kind: 'complete' as const, status: 0 as const, diagnostics: [],
                result: Object.freeze({ status: 'pending_integration' as const, policy }) }
        })
        if (!result || result.kind !== 'complete' || !siblingsRoot) {
            return result ?? guardPolicyRefusal('guard policy checkout authority is copied, changed, expired or already consumed')
        }
        const boundaries = result.result.policy
        const projectCommands: GuardProjectCommand[] = []
        for (const [siblingIndex, sibling] of guardConfig.sibling.entries()) {
            const policies = guardConfig.environment.install_policies
            if (!policies.some(policy => policy.toolchain === sibling.toolchain && (policy.build || policy.test))) continue
            const checkoutRoot = resolve(siblingsRoot, sibling.dir)
            const checkoutId = deriveCheckoutId({ checkoutPath: checkoutRoot })
            const evaluatedAt = Date.now()
            const observation = await observeInstallPolicyLockfiles({ source: loaded.source, siblingIndex, siblingSlug: sibling.slug,
                checkoutRoot, checkoutId, policies, observedAt: new Date(evaluatedAt).toISOString() })
            const resolution = await withInstallPolicyProjection(observation, {
                source: loaded.source, siblingIndex, siblingSlug: sibling.slug, checkoutRoot, checkoutId, policies, evaluatedAt,
            }, projection => resolveInstallPolicies({ source: loaded.source, siblingIndex, sibling, checkoutRoot, checkoutId, policies, projection }))
            if (resolution?.kind !== 'complete' || resolution.bindings.length !== 1) {
                return guardPolicyRefusal(`guard project command policy is unavailable for ${sibling.slug}`)
            }
            for (const kind of ['build', 'test'] as const) {
                const argv = resolution.bindings[0]!.policy[kind]
                if (!argv) continue
                if (renderGuardProjectCommand(argv).kind !== 'complete') return guardPolicyRefusal(`guard ${kind} command exceeds its rendering bound`)
                projectCommands.push(Object.freeze({ executable: argv[0]!, checkoutRoot, kind, argv: Object.freeze(argv.slice(1)) }))
            }
        }
        let commandAuthority: GuardPolicyCommandAuthority | undefined
        const cockpitInvocations: GuardInvocationProfile[] = []
        if (Object.hasOwn(data, 'commands')) {
            const captured = ownDataValues(snapshotJson(data.commands), ['executable', 'invocations'], ['autonomy'])
            if (!captured) {
                return guardPolicyRefusal('guard command authority must be closed own data')
            }
            const executable = resolvedExecutable(captured.executable)
            if (!executable || !Array.isArray(captured.invocations) || captured.invocations.length > GUARD_INPUT_LIMITS.invocations) {
                return guardPolicyRefusal('guard command authority requires a resolved executable and bounded exact invocations')
            }
            const status = lstatSync(executable.canonicalPath)
            if (!status.isFile() || status.isSymbolicLink() || !(status.mode & 0o111)
                || realpathSync(executable.invocationPath) !== executable.canonicalPath
                || createHash('sha256').update(readFileSync(executable.canonicalPath)).digest('hex') !== executable.sha256) {
                return guardPolicyRefusal('guard command executable identity changed or is unavailable')
            }
            identities.set(executable.canonicalPath, status)
            const node = await nodeAuthority()
            if (!node) return guardPolicyRefusal('guard command authority requires an authenticated Node executable')
            const services = await guardServiceIds(guardConfig, boundaries.canonicalRoot, { node, execute: executeProbe,
                resolveDocker: () => resolveDockerExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }) })
            if (typeof services === 'string') return guardPolicyRefusal(`guard command authority could not read the Compose service list: ${services}`)
            const authority = { executable: executable.invocationPath, canonicalRoot: boundaries.canonicalRoot,
                allowedRoots: boundaries.allowedRoots, configPath: loaded.source.path, services }
            commandAuthority = captured as unknown as GuardPolicyCommandAuthority
            const inspectPath = (path: string) => {
                const root = boundaries.allowedRoots.filter(root => confinedPath(root, path)).sort((a, b) => b.length - a.length)[0]
                if (!root) throw new Error('guard command path escapes its authenticated roots')
                let cursor = root
                const segments = relative(root, path).split(sep).filter(Boolean)
                for (const [index, segment] of segments.entries()) {
                    cursor = join(cursor, segment)
                    let status: Stats
                    try { status = lstatSync(cursor) }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
                        throw error
                    }
                    if (status.isSymbolicLink() || (index < segments.length - 1 ? !status.isDirectory() : !status.isDirectory() && !status.isFile())) {
                        throw new Error('guard command path has a symlink or unexpected file type')
                    }
                    identities.set(cursor, status)
                }
                return true
            }
            for (const invocation of captured.invocations) {
                const resolved = resolveOrdinaryInvocation(invocation as unknown as GuardInvocationProfile, authority, inspectPath)
                if (!resolved) return guardPolicyRefusal('guard command candidate is not an ordinary exact invocation')
                cockpitInvocations.push(resolved)
            }
        }
        if (cockpitInvocations.length + projectCommands.length > GUARD_INPUT_LIMITS.invocations) return guardPolicyRefusal('guard candidates exceed the invocation bound')
        const current = await loadCockpitConfig(loaded.source.path)
        const revalidated = current.kind === 'complete' ? consumeLoadedConfigProjection(current.result) : undefined
        if (!revalidated || !sameSource(revalidated.source, loaded.source)) return guardPolicyRefusal('guard configuration source changed during command construction')
        for (const [path, before] of identities) {
            const after = lstatSync(path)
            if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
                return guardPolicyRefusal('guard root, instance or executable identity changed during command construction')
            }
        }
        const policy: GuardEvaluationPolicy = Object.freeze({ ...boundaries,
            cockpitInvocations: Object.freeze(cockpitInvocations), projectCommands: Object.freeze(projectCommands) })
        let autonomy: ResolvedAutonomyGrants | undefined
        if (commandAuthority && Object.hasOwn(commandAuthority, 'autonomy')) {
            const authority = commandAuthority.autonomy
            if (!authority || !isDeepStrictEqual(Object.keys(authority).sort(), ['guardRegistration', 'nativeReads', 'target'])
                || resolve(boundaries.canonicalRoot, authority.guardRegistration?.wiring?.handler?.path ?? '') !== commandAuthority.executable.invocationPath
                || authority.guardRegistration?.wiring?.handler?.sha256 !== commandAuthority.executable.sha256) {
                return guardPolicyRefusal('autonomy registration does not match the authenticated guard handler')
            }
            autonomy = issueResolvedAutonomyGrants({ ...authority, cockpitInvocations, projectCommands })
            if (!autonomy) return guardPolicyRefusal('autonomy representation has unavailable registration or native read spellings')
        }
        return { kind: 'complete', status: 0, diagnostics: [], result: Object.freeze({ status: 'pending_integration', policy, ...(autonomy ? { autonomy } : {}) }) }
    } catch (error) {
        return guardPolicyRefusal(error instanceof Error ? `guard policy construction failed: ${error.message}` : 'guard policy construction failed')
    }
}

export interface UpCommandInput {
    readonly configPath: string
}

export interface SleepCommandInput {
    readonly configPath: string
}

export interface SessionCommandInput {
    readonly configPath: string
    readonly argv: readonly [string, ...string[]]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
}

export interface LifecycleRunContext {
    readonly configPath: string
    readonly source: SourceProvenance
    readonly namespace: StateNamespace
    readonly cockpitId: ConsumedSetupCheckoutObservation['cockpitId']
    readonly checkoutId: CheckoutId
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly ports: PortFamilyConfig
    readonly entrypointDerivatives: readonly EntrypointDerivative[]
}

export interface LifecycleRunContextInput {
    readonly configPath: string
    readonly checkout: SetupCheckoutProjection
    readonly configuration: LoadedConfigProjection
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly sessionId: string
}

export interface RuntimeReadiness {
    readonly topology: RuntimeTopologyEvidence
    readonly lifecycle: RuntimeLifecycleProjection
    readonly hostObservations: readonly EnvironmentObservation[]
    readonly runtimeObservations: readonly EnvironmentObservation[]
}

interface AcquiredPorts {
    readonly leaseResult: LeasePortFamilyResult
    readonly projection: PortLeaseProjection
}

interface GeneratedProgress {
    readonly applied: readonly string[]
    readonly notApplied: readonly string[]
    readonly attempted?: readonly string[]
}

type GeneratedCommandOutcome<T> = EnvironmentCommandOutcome<T> & {
    readonly progressEvidence?: readonly unknown[]
}

// Readiness adapters resolve to undefined when they cannot vouch for their evidence. When the
// owner they consulted refused with its own diagnostics (an occupied port family, a held state
// lock, a stopped runtime), they hand those to `refuse` instead: collapsing them into a generic
// evidence refusal left the user with no hint of which port, lock or daemon to fix.
export type ReadinessRefusal<T> = (diagnostics: readonly EnvironmentDiagnostic[]) => T

interface LifecycleCommandAdapters {
    load(input: UpCommandInput | SleepCommandInput): Promise<EnvironmentCommandOutcome<LifecycleRunContext>>
    execute(step: ExecutionStep): Promise<ExecuteProbeOutcome>
    withRuntimeReadiness<T>(context: LifecycleRunContext, use: (runtime: RuntimeReadiness) => Promise<T>, ports?: PortLeaseProjection, refuse?: ReadinessRefusal<T>): Promise<T | undefined>
}

export interface UpCommandAdapters extends LifecycleCommandAdapters {
    withMachineFloorReadiness?<T>(context: LifecycleRunContext, use: (observations: readonly EnvironmentObservation[]) => Promise<T>, refuse?: ReadinessRefusal<T>): Promise<T | undefined>
    prepareGeneratedEnvironment?(context: LifecycleRunContext, ports: PortLeaseProjection): Promise<GeneratedApplicationProjection | undefined>
    completeGeneratedEnvironment?(context: LifecycleRunContext, runtime: RuntimeReadiness, services: readonly RuntimeServiceEvidence[], projection: GeneratedApplicationProjection): Promise<EnvironmentCommandOutcome<EnvironmentObservation>>
    completeGeneratedDependencies?(context: LifecycleRunContext, runtime: RuntimeReadiness, services: readonly RuntimeServiceEvidence[], projection: GeneratedApplicationProjection): Promise<GeneratedCommandOutcome<readonly EnvironmentObservation[]>>
    completeGeneratedData?(context: LifecycleRunContext, runtime: RuntimeReadiness, services: readonly RuntimeServiceEvidence[], projection: GeneratedApplicationProjection): Promise<EnvironmentCommandOutcome<DataModeExecutionResult | EnvironmentObservation>>
    completeGeneratedVendors?(context: LifecycleRunContext, runtime: RuntimeReadiness, services: readonly RuntimeServiceEvidence[], projection: GeneratedApplicationProjection): Promise<GeneratedCommandOutcome<EnvironmentObservation>>
    withLifecycleStage<T>(context: LifecycleRunContext, use: (stage: LifecycleStageProjection) => Promise<T>, refuse?: ReadinessRefusal<T>): Promise<T | undefined>
    withAcquiredPorts<T>(context: LifecycleRunContext, use: (ports: AcquiredPorts) => Promise<T>, refuse?: ReadinessRefusal<T>): Promise<T | undefined>
}

export interface SleepCommandAdapters extends LifecycleCommandAdapters {}

export interface SessionCommandAdapters {
    up(input: UpCommandInput): Promise<UpCommandResult>
    sleep(input: SleepCommandInput): Promise<SleepCommandResult>
    resolveExecutable(name: string, env: Readonly<Record<string, string>>): Promise<ExecutableResolution>
    executeForeground(input: ForegroundProcessInput, options: { signal?: AbortSignal }): Promise<ForegroundProcessOutcome>
    readonly signal?: AbortSignal
}

export interface DownCommandInput {
    readonly configPath: string
}

export interface ResetCommandInput {
    readonly configPath: string
}

export interface DestructiveRunContext extends LifecycleRunContext {
    readonly instance: SelectDestructiveInstanceInput
}

export interface DestructiveObservation {
    readonly instance: SelectDestructiveInstanceInput
    readonly runtime: RuntimeLifecycleProjection
    readonly ports: PortLeaseProjection
    readonly down: Omit<PlanTeardownInput, 'expectedDiscoveryDigest' | 'consent' | 'continuation' | 'recoveryAuthority'>
    readonly reset: Omit<PlanResetInput, 'confirmationDigest' | 'consent' | 'continuation' | 'recoveryAuthority'>
}

/** The evidence a step of an already-reserved drain re-reads: no runtime readiness, no ports. */
export type DestructiveReclaimObservation = Pick<DestructiveObservation, 'instance' | 'down' | 'reset'>

interface DestructiveCommandAdapters {
    load(input: DownCommandInput | ResetCommandInput): Promise<EnvironmentCommandOutcome<DestructiveRunContext>>
    observe(context: DestructiveRunContext): Promise<DestructiveObservation | DestructiveObservationRefusal | undefined>
    /** Reclaim evidence only, after `observe` measured the runtime for the same context. */
    observeReclaim?(context: DestructiveRunContext): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined>
    execute(step: ExecutionStep): Promise<ExecuteProbeOutcome>
}

export type DestructiveObservationRefusal = Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }>

export interface DownCommandAdapters extends DestructiveCommandAdapters {}
export interface ResetCommandAdapters extends DestructiveCommandAdapters {}

export type DownCommandResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'removed' | 'unchanged'
}>>

export interface ResetPreviewResult {
    readonly stackId: StackId
    readonly planDigest: string
    readonly targets: readonly ResetTargetInput[]
    readonly noop: boolean
}

export type ResetCommandResult =
    | Readonly<{ kind: 'preview'; status: 0; diagnostics: readonly EnvironmentDiagnostic[]; result: ResetPreviewResult }>
    | Readonly<{ kind: 'refusal'; status: 2; diagnostics: readonly EnvironmentDiagnostic[]; result: null }>

export type OperatorResetResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'reset' | 'unchanged'
}>>

export interface OperatorResetSession {
    readonly preview: Extract<ResetCommandResult, { kind: 'preview' }>
    decide(decision: 'approve' | 'decline'): Promise<OperatorResetResult>
}

export interface DestructiveRunContextInput {
    readonly lifecycle: LifecycleRunContext
    readonly instance: SelectDestructiveInstanceInput
}

export type UpCommandResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'started' | 'resumed' | 'unchanged'
    entrypoints: PortLeaseProjection['entrypoints']
    coldStart?: Readonly<{ measuredMillis: number; limitMillis: number; headroomMillis: number }>
}>> & { readonly progress?: GeneratedProgress }

export type SleepCommandResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'retained' | 'released' | 'stopped'
}>>

export type SessionCommandResult =
    | Readonly<{ kind: 'complete'; status: 0; diagnostics: readonly EnvironmentDiagnostic[]; result: Readonly<{
        child: Readonly<{ exitCode: number; signal: NodeJS.Signals | null }>
        sleep: Extract<SleepCommandResult, { kind: 'complete' }>['result']
    }> }>
    | Readonly<{ kind: 'refusal'; status: 2 | 130; diagnostics: readonly EnvironmentDiagnostic[]; result: null }>

const issuedLifecycleRuns = new WeakSet<object>()
const lifecycleConfigurationSources = new WeakMap<object, Readonly<{ source: SourceProvenance; siblingsRoot: string }>>()
const issuedDestructiveRuns = new WeakSet<object>()

type EffectiveConfigurationResult =
    | Readonly<{ kind: 'complete'; source: SourceProvenance; config: CockpitConfig }>
    | Readonly<{ kind: 'unavailable' }>
    | Extract<RegistryDerivationResult, { kind: 'refusal' }>

function consumeEffectiveConfiguration(configuration: LoadedConfigProjection): EffectiveConfigurationResult {
    const loaded = consumeLoadedConfigProjection(configuration)
    if (!loaded) return Object.freeze({ kind: 'unavailable' })
    const derived = deriveRegistry(loaded.config)
    return derived.kind === 'complete'
        ? Object.freeze({ kind: 'complete', source: loaded.source, config: derived.result.config as CockpitConfig })
        : derived
}

function registryRefusalMessage(result: Extract<EffectiveConfigurationResult, { kind: 'refusal' }>): string {
    return `effective registry refused (${result.code}): ${result.message}`
}

export function issueDestructiveRunContext(input: DestructiveRunContextInput): EnvironmentCommandOutcome<DestructiveRunContext> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return lifecycleContextRefusal()
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2
            || !('value' in descriptors.lifecycle!) || !('value' in descriptors.instance!)) return lifecycleContextRefusal()
        const lifecycle = descriptors.lifecycle!.value as LifecycleRunContext
        const instance = descriptors.instance!.value as SelectDestructiveInstanceInput
        const namespace = authenticateStateNamespace(lifecycle?.namespace)
        const selected = selectDestructiveInstance(instance)
        if (!namespace || selected.kind !== 'selected' || selected.stackId !== lifecycle.stackId
            || selected.checkoutId !== lifecycle.checkoutId || lifecycle.configPath !== resolve(lifecycle.configPath)) {
            return lifecycleContextRefusal()
        }
        const context = Object.freeze({ ...lifecycle, namespace, instance })
        issuedDestructiveRuns.add(context)
        return Object.freeze({ kind: 'complete', status: 0, diagnostics: Object.freeze([]), result: context })
    } catch {
        return lifecycleContextRefusal()
    }
}

export function issueLifecycleRunContext(input: LifecycleRunContextInput): EnvironmentCommandOutcome<LifecycleRunContext> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return lifecycleContextRefusal()
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = ['checkout', 'configPath', 'configuration', 'namespace', 'stackId', 'holderId', 'sessionId']
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))) return lifecycleContextRefusal()
        const checkout = consumeSetupCheckoutProjection(descriptors.checkout!.value as SetupCheckoutProjection)
        const requestedConfigPath = descriptors.configPath!.value
        const loaded = consumeEffectiveConfiguration(descriptors.configuration!.value as LoadedConfigProjection)
        const namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const stackId = descriptors.stackId!.value
        const holderId = descriptors.holderId!.value
        const sessionId = descriptors.sessionId!.value
        if (loaded.kind === 'refusal') return lifecycleContextRefusal(registryRefusalMessage(loaded))
        if (!checkout || loaded.kind !== 'complete' || !namespace || typeof requestedConfigPath !== 'string' || requestedConfigPath.length === 0
            || requestedConfigPath.includes('\0') || resolve(requestedConfigPath) !== loaded.source.path
            || typeof sessionId !== 'string'
            || !sameSource(checkout.source, loaded.source)
            || loaded.config.cockpit.name !== checkout.cockpitName) return lifecycleContextRefusal()
        const expectedStackId = deriveStackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        const expectedHolderId = deriveHolderId({
            stackId: expectedStackId,
            checkoutId: checkout.checkoutId,
            sessionId,
        })
        if (stackId !== expectedStackId || holderId !== expectedHolderId
            || namespace.paths.lifecycle(expectedStackId).cockpitId !== checkout.cockpitId) {
            return lifecycleContextRefusal()
        }
        const context = Object.freeze({
            configPath: resolve(requestedConfigPath),
            source: Object.freeze({ ...loaded.source }),
            namespace,
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            stackId: expectedStackId,
            holderId: expectedHolderId,
            ports: Object.freeze({
                step: loaded.config.ports.step,
                count: loaded.config.ports.count,
                bases: Object.freeze({ ...loaded.config.ports.bases }),
            }),
            entrypointDerivatives: Object.freeze(loaded.config.environment.entrypoint_derivatives.map((value) => Object.freeze({ ...value }))),
        })
        issuedLifecycleRuns.add(context)
        lifecycleConfigurationSources.set(context, Object.freeze({ source: context.source,
            siblingsRoot: resolve(checkout.mainCheckoutPath, loaded.config.cockpit.siblings_root) }))
        return { kind: 'complete', status: 0, diagnostics: [], result: context }
    } catch {
        return lifecycleContextRefusal()
    }
}

export async function withLifecycleConfiguration<T>(
    context: LifecycleRunContext,
    use: (configuration: LoadedConfigProjection) => Promise<T>,
): Promise<T | undefined> {
    if (!context || typeof context !== 'object') return undefined
    const expected = lifecycleConfigurationSources.get(context)
    if (!expected) return undefined
    // Each leaf consumes its own loader-issued handle; a copied parsed config has no authority.
    const loaded = await loadCockpitConfig(expected.source.path)
    if (loaded.kind !== 'complete' || !sameSource(expected.source, loaded.result.source)) return undefined
    try { return await use(loaded.result) }
    finally { consumeLoadedConfigProjection(loaded.result) }
}

function lifecycleContextRefusal(
    message = 'lifecycle run authority is unavailable or does not match the loaded configuration',
): Extract<EnvironmentCommandOutcome<LifecycleRunContext>, { kind: 'refusal' }> {
    return {
        kind: 'refusal', status: 2, result: null,
        diagnostics: [ownerDiagnostic(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            message,
            'lifecycle',
        )],
    }
}

export interface SetupCommandInput {
    configPath: string
    env?: Readonly<Record<string, string>>
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
        const expectedSiblingsRoot = resolve(checkout.mainCheckoutPath, loaded.config.cockpit.siblings_root)
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
            || namespace.cockpitRoot !== join(namespace.root, 'cockpits', checkout.cockpitId)) {
            return contextRefusal(checkout.source.path)
        }
        const config = loaded.config
        const context = Object.freeze({
            source: Object.freeze({
                path: checkout.source.path,
                byteLength: checkout.source.byteLength,
                sha256: checkout.source.sha256,
            }),
            mainCheckoutPath: checkout.mainCheckoutPath,
            siblingsRoot: expectedSiblingsRoot,
            siblings: config.sibling,
            policyCatalog: config.environment.install_policies,
            env,
            gitExecutable: executable,
            namespace,
            stackId: expectedStackId,
            holderId: expectedHolderId,
        })
        issuedSetupRuns.add(context)
        return { kind: 'complete', status: 0, diagnostics: [], result: context }
    } catch {
        return contextRefusal()
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

function exactEnvironment(input: unknown): Readonly<Record<string, string>> | undefined {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || Object.entries(snapshot).some(([name, value]) => name.length === 0 || name.includes('\0')
            || name.includes('=') || typeof value !== 'string' || value.includes('\0'))) return undefined
    return Object.freeze({ ...snapshot } as Readonly<Record<string, string>>)
}

export function setupEnvironment(input?: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined {
    let projected: Readonly<Record<string, string>>
    try {
        const source = input === undefined
            ? process.env as Readonly<Record<string, string>>
            : input
        const git = gitEnvironment(source)
        const xdgStateHome = source.XDG_STATE_HOME
        projected = Object.freeze({
            ...git,
            ...(xdgStateHome === undefined ? {} : { XDG_STATE_HOME: xdgStateHome }),
        })
    } catch {
        return undefined
    }
    return exactEnvironment(projected)
}

function uniqueDiagnostics(diagnostics: readonly EnvironmentDiagnostic[]): readonly EnvironmentDiagnostic[] {
    const seen = new Set<string>()
    return diagnostics.filter((diagnostic) => {
        const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.target, diagnostic.fix])
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function sameSource(left: SourceProvenance, right: SourceProvenance): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
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
    return Object.freeze({ kind, siblingRoot, destination })
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
    const remoteMatches = sibling.remote !== undefined && origin === sibling.remote
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
    return Object.freeze({
        sibling: sibling.slug,
        target: result.target as string,
        observed: observed as SetupResult['observed'],
        action: action as SetupResult['action'],
        changed: result.changed,
    })
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
    return Object.freeze({
        dev: identity.dev as string,
        ino: identity.ino as string,
        mode: identity.mode as string,
        size: identity.size as string,
        mtimeNs: identity.mtimeNs as string,
        ctimeNs: identity.ctimeNs as string,
    })
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
            ? Object.freeze({ kind: 'unchanged', siblingRoot, destination })
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
            ? Object.freeze({ kind: 'refusal', code: plan.code, path: plan.path }) as Extract<EnvironmentSeedPlan, { kind: 'refusal' }>
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
        ? Object.freeze({
              kind: 'ready', siblingRoot, canonicalRoot: siblingRoot, source, destination,
              rootIdentity, sourceIdentity, destinationParentIdentity,
          })
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
        ? Object.freeze({ kind: 'refusal', code: result.code, path: result.path }) as EnvironmentSeedRefusal
        : undefined
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
              failedStep: failed.execution.failedStep,
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

function ownerDiagnostic(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
): EnvironmentDiagnostic {
    return { severity: 'error', code, message, target }
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
            return Object.freeze({
                kind: 'refusal',
                code: refusal.code as EnvironmentIgnoreRefusal['code'],
                path: refusal.path,
            })
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
    return Object.freeze([Object.freeze({
        source: context.source,
        siblingIndex,
        diagnostics: Object.freeze({ catalogIndex: catalogIndex as number }),
        siblingSlug: sibling.slug,
        checkoutRoot,
        checkoutId,
        policy: snapshotJson(policy) as unknown as ResolvedInstallPolicyBinding['policy'],
    })])
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
        try {
            observedAt = adapters.observedAt()
        } catch {
            observedAt = undefined
        }
        return isCanonicalTimestamp(observedAt)
            ? observedAt
            : sequenceRefusal(
                  context,
                  adapters,
                  [...diagnostics, ownerDiagnostic(
                      ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
                      'setup operation timestamp is unavailable',
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
                    [...diagnostics, ...execution.diagnostics],
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

function lifecycleRefusal(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
): Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }> {
    return {
        kind: 'refusal',
        status: 2,
        result: null,
        diagnostics: [ownerDiagnostic(code, message, target)],
    }
}

function forwardedRefusal(
    diagnostics: readonly EnvironmentDiagnostic[],
): Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }> {
    return { kind: 'refusal', status: 2, result: null, diagnostics }
}

const generatedBringupRuns = new WeakMap<LifecycleRunContext, GeneratedApplicationProjection>()
const generatedBringupProgress = new WeakMap<LifecycleRunContext, GeneratedProgress>()

function generatedReplay(projection: GeneratedApplicationProjection): GeneratedLifecycleReplay {
    return Object.freeze({ sourceSha256: projection.sourceSha256, generation: projection.generation,
        profiles: projection.profiles, mounts: projection.mounts })
}

export { decodeLifecycleRecord } from './lifecycle-stage.js'

async function readLifecycleRecord(context: LifecycleRunContext): Promise<CurrentLifecycleRecord | null | UpCommandResult> {
    const address = context.namespace.paths.lifecycle(context.stackId)
    const result = await readState(address)
    if (result.kind === 'missing') {
        const stage = await resolveLifecycleStage({
            namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString(),
        })
        if (stage.kind !== 'complete') return {
            kind: 'refusal', status: 2, result: null, diagnostics: stage.diagnostics,
        }
        return stage.authority.stage === 'steady'
            ? lifecycleRefusal(ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'seeded lifecycle history requires persisted progress', address.path)
            : null
    }
    if (result.kind !== 'complete') {
        return lifecycleRefusal(result.code, result.message, result.target)
    }
    return decodeLifecycleRecord(result.value, context) ?? lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        'lifecycle progress record is malformed',
        address.path,
    )
}

function lifecycleStateRecord(
    context: LifecycleRunContext,
    current: StateRecord | null,
    value: LifecycleRecordValue,
    updatedAt: string,
): StateRecord {
    return {
        format: 'cockpit-state/v1',
        kind: 'lifecycle',
        cockpitId: context.cockpitId,
        subjectId: context.stackId,
        revision: current === null ? 0 : current.revision + 1,
        updatedAt,
        value: snapshotJson(value)! as StateRecord['value'],
    }
}

async function publishLifecycleRecord(
    context: LifecycleRunContext,
    expected: StateRecord | null,
    value: LifecycleRecordValue,
    transfer?: Readonly<{ readonly previousHolderId: HolderId; readonly projection: PortLeaseProjection }>,
): Promise<StateResult<StateRecord> | UpCommandResult> {
    const address = context.namespace.paths.lifecycle(context.stackId)
    const expectedBytes = JSON.stringify(expected)
    const result = await transactState(
        context.namespace,
        address,
        { ownerId: context.holderId },
        async (current) => {
            if (JSON.stringify(current) !== expectedBytes) return abortStateTransaction(lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'lifecycle progress changed during execution',
                address.path,
            ))
            if (transfer) {
                const ownership = await inspectPortLeaseTransfer({
                    namespace: context.namespace,
                    stackId: context.stackId,
                    holderId: context.holderId,
                    checkoutId: context.checkoutId,
                    previousHolderId: transfer.previousHolderId,
                    projection: transfer.projection,
                })
                if (ownership.kind === 'refusal') return abortStateTransaction({
                    kind: 'refusal' as const,
                    status: 2 as const,
                    result: null,
                    diagnostics: ownership.diagnostics,
                })
            }
            return lifecycleStateRecord(context, current, value, new Date().toISOString())
        },
    )
    if ('aborted' in result) return result.value
    if (result.kind === 'complete' || result.kind === 'indeterminate') return result
    return result.kind === 'missing'
        ? lifecycleRefusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'lifecycle progress publication returned no record', result.path)
        : lifecycleRefusal(result.code, result.message, result.target)
}

type ServiceAdmission =
    | { readonly kind: 'complete'; readonly evidence: RuntimeServiceEvidence }
    | { readonly kind: 'stale' }
    | { readonly kind: 'failure'; readonly logs?: RuntimeServiceFailureEvidence | RuntimeServiceObservation }

/** A start can also be refused before Compose starts anything, with a diagnostic of its own. */
type ServiceStart = ServiceAdmission | { readonly kind: 'refused'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

async function inspectService(
    healthPlan: Extract<RuntimeServiceHealthPlan, { kind: 'planned' }>,
    adapters: Pick<UpCommandAdapters, 'execute'>,
): Promise<ServiceAdmission> {
    const inspectOutcome = await adapters.execute(healthPlan.step)
    const failure = admitRuntimeServiceInspectFailure({ plan: healthPlan, outcome: inspectOutcome })
    if (failure.kind === 'complete') return { kind: 'failure', logs: failure.evidence }
    const observation = admitRuntimeServiceObservation({ plan: healthPlan, outcome: inspectOutcome })
    if (observation.kind !== 'complete') return { kind: 'failure' }
    const health = admitRuntimeServiceHealth({ observation: observation.observation })
    return health.kind === 'complete'
        ? { kind: 'complete', evidence: health.evidence }
        : { kind: 'failure', logs: observation.observation }
}

export async function revalidateService(
    topology: RuntimeTopologyEvidence,
    completed: LifecycleProgress['completedServices'][number],
    adapters: Pick<UpCommandAdapters, 'execute'>,
): Promise<ServiceAdmission> {
    const plan = createRuntimeServiceRevalidationPlan({
        topology,
        service: completed.service,
        expectedContainerId: completed.containerId,
    })
    if (plan.kind !== 'planned') return { kind: 'failure' }
    const status = await adapters.execute(plan.status)
    const statusAdmission = admitRuntimeServiceRevalidationStatus({ plan, outcome: status })
    if (statusAdmission.kind === 'stale') return { kind: 'stale' }
    if (statusAdmission.kind !== 'admitted') return { kind: 'failure' }
    const identity = await adapters.execute(plan.identity)
    const admitted = admitRuntimeServiceRevalidation({ plan, outcome: status, identityOutcome: identity })
    if (admitted.kind === 'stale') return { kind: 'stale' }
    return admitted.kind === 'planned' ? inspectService(admitted.plan, adapters) : { kind: 'failure' }
}

async function startService(
    topology: RuntimeTopologyEvidence,
    service: string,
    adapters: UpCommandAdapters,
): Promise<ServiceStart> {
    const plan = createRuntimeServicePlan({ topology, service })
    if (plan.kind !== 'planned') return { kind: 'failure' }
    if (plan.build && plan.launcher) {
        const buildOutcome = await adapters.execute(plan.build)
        const admitted = admitBuiltImageLauncher(buildOutcome.kind === 'complete'
            ? { plan, buildOutcome, launcherOutcome: await adapters.execute(plan.launcher) }
            : { plan, buildOutcome })
        if (admitted.kind === 'refusal') return { kind: 'refused', diagnostics: admitted.diagnostics }
    }
    const start = await adapters.execute(plan.start)
    const startAdmission = admitRuntimeServiceStageOutcome({ plan, stage: 'start', outcome: start })
    if (startAdmission.kind === 'failure') return { kind: 'failure', logs: startAdmission.evidence }
    if (startAdmission.kind !== 'admitted') return { kind: 'failure' }
    const status = await adapters.execute(plan.status)
    const statusAdmission = admitRuntimeServiceStageOutcome({ plan, stage: 'status', outcome: status, startOutcome: start })
    if (statusAdmission.kind === 'failure') return { kind: 'failure', logs: statusAdmission.evidence }
    if (statusAdmission.kind !== 'admitted') return { kind: 'failure' }
    const identity = await adapters.execute(plan.identity)
    const identityAdmission = admitRuntimeServiceStageOutcome({
        plan, stage: 'identity', outcome: identity, startOutcome: start, statusOutcome: status,
    })
    if (identityAdmission.kind === 'failure') return { kind: 'failure', logs: identityAdmission.evidence }
    if (identityAdmission.kind !== 'admitted') return { kind: 'failure' }
    const healthPlan = createRuntimeServiceHealthPlan({ plan, startOutcome: start, outcome: status, identityOutcome: identity })
    return healthPlan.kind === 'planned' ? inspectService(healthPlan, adapters) : { kind: 'failure' }
}

async function collectFailureLogs(
    evidence: RuntimeServiceFailureEvidence | RuntimeServiceObservation | undefined,
    service: string,
    adapters: UpCommandAdapters,
): Promise<readonly EnvironmentDiagnostic[]> {
    if (!evidence) return [ownerDiagnostic(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'bounded failure logs are unavailable',
        service,
    )]
    const plan = planFailureLogs({ evidence, tail: 200, timeoutMs: 10_000, outputLimitBytes: 1_048_576 })
    if (plan.kind !== 'planned') return [ownerDiagnostic(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        plan.reason,
        service,
    )]
    const outcome = await adapters.execute(plan.step)
    const admitted = admitFailureLogs({ plan, outcome })
    if (admitted.kind === 'complete') {
        return admitted.records.length > 0
            ? admitted.records.map((record) => ownerDiagnostic(
                  ENVIRONMENT_CODES.EXECUTION_STEP_FAILED,
                  `[${record.timestamp}] ${record.stream}: ${record.message}`,
                  record.service,
              ))
            : [ownerDiagnostic(
                  ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                  'bounded failure logs contained no records',
                  service,
              )]
    }
    return [ownerDiagnostic(
        'code' in admitted ? admitted.code : ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'code' in admitted ? 'failure log collection failed' : 'failure log output could not be admitted',
        'service' in admitted ? admitted.service : service,
    )]
}

function progressValueForPlan(value: LifecycleRecordValue): LifecycleProgress {
    return Object.freeze({
        workBasisSha256: value.workBasisSha256,
        operationGeneration: value.operationGeneration,
        completedServices: value.completedServices,
    })
}

type UpRoundResult =
    | { readonly kind: 'retry'; readonly forceReset: boolean }
    | { readonly kind: 'complete'; readonly result: UpCommandResult }

function matchesPortAcquisition(
    context: LifecycleRunContext,
    leaseResult: LeasePortFamilyResult,
    projection: PortLeaseProjection,
): leaseResult is Extract<LeasePortFamilyResult, { kind: 'complete' }> {
    try {
        return leaseResult.kind === 'complete'
            && leaseResult.lease.stackId === context.stackId
            && projection.lease.stackId === context.stackId
            && leaseResult.holderId === context.holderId
            && projection.ownership.holderId === context.holderId
            && leaseResult.change === projection.ownership.change
            && leaseResult.recordRevision === projection.ownership.recordRevision
            && JSON.stringify(leaseResult.lease) === JSON.stringify(projection.lease)
    } catch {
        return false
    }
}

function orderedRuntimeServices(topology: RuntimeTopologyEvidence): RuntimeTopologyEvidence['services'] | undefined {
    const order = resolveRuntimeServiceOrder(topology)
    const services = topology.services
    if (order.length === 0 || order.length !== services.length || new Set(order).size !== order.length) return undefined
    const byId = new Map(services.map((service) => [service.id, service] as const))
    if (byId.size !== services.length || order.some((serviceId) => !byId.has(serviceId))) return undefined
    return Object.freeze(order.map((serviceId) => byId.get(serviceId)!))
}

async function prepareGeneratedBringup(
    context: LifecycleRunContext,
    adapters: UpCommandAdapters,
    rememberAcquisition: (value: LeasePortFamilyResult) => void,
): Promise<UpCommandResult | undefined> {
    const declared = await withLifecycleConfiguration(context, async (configuration) => {
        const loaded = consumeEffectiveConfiguration(configuration)
        return loaded.kind === 'complete'
            ? Object.freeze({ kind: 'complete' as const, value: loaded.config.environment.generated !== undefined })
            : loaded
    })
    if (declared === undefined) return lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        'lifecycle configuration could not be revalidated', context.configPath)
    if (declared.kind === 'refusal') return lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        registryRefusalMessage(declared), context.configPath)
    if (declared.kind === 'unavailable') return lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        'lifecycle configuration authority was already consumed', context.configPath)
    if (!declared.value) return undefined
    const existing = await readLifecycleRecord(context)
    const completedCoTenant = existing && !('status' in existing) && existing.value.holderId !== context.holderId
        && existing.value.generatedReplay !== undefined
        && existing.value.generatedProgress?.notApplied.length === 0
        && ['publication', 'generated', 'dependencies', 'data', 'external-dependencies', 'seeded']
            .every(stage => existing.value.generatedProgress?.applied.includes(stage))
    if (!adapters.prepareGeneratedEnvironment || !adapters.completeGeneratedEnvironment || !adapters.completeGeneratedDependencies
        || !adapters.completeGeneratedData || !adapters.completeGeneratedVendors) {
        return lifecycleRefusal(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
            'generated lifecycle composition is unavailable', context.configPath)
    }
    let prepared: GeneratedApplicationProjection | undefined
    let portRefusal: readonly EnvironmentDiagnostic[] | undefined
    try {
        prepared = await adapters.withAcquiredPorts(context, async (ports) => {
            if (!matchesPortAcquisition(context, ports.leaseResult, ports.projection)) return undefined
            rememberAcquisition(ports.leaseResult)
            return adapters.prepareGeneratedEnvironment!(context, ports.projection)
        }, (diagnostics) => { portRefusal = diagnostics; return undefined })
    }
    catch (error) { return lifecycleRefusal(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
        `generated publication failed: ${error instanceof Error ? error.message : String(error)}`, context.configPath) }
    if (portRefusal) return forwardedRefusal(portRefusal)
    const projected = generatedApplicationProjection(prepared)
    if (!projected || projected.sourceSha256 !== context.source.sha256) {
        return lifecycleRefusal(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
            'generated publication authority does not match lifecycle configuration', context.configPath)
    }
    generatedBringupRuns.set(context, projected)
    if (completedCoTenant) return undefined
    generatedBringupProgress.set(context, Object.freeze({ applied: Object.freeze(['publication']),
        notApplied: Object.freeze(['generated', 'dependencies', 'data', 'external-dependencies', 'seeded']) }))
    return undefined
}

async function completeGeneratedBringup(
    context: LifecycleRunContext,
    adapters: UpCommandAdapters,
    runtime: RuntimeReadiness,
    services: readonly RuntimeServiceEvidence[],
): Promise<UpCommandResult | undefined> {
    const projection = generatedBringupRuns.get(context)
    if (!projection) return undefined
    const selection = await withLifecycleConfiguration(context, async (configuration) => {
        const loaded = consumeEffectiveConfiguration(configuration)
        if (loaded.kind !== 'complete') return loaded
        const generated = loaded.config.environment.generated
        const binding = lifecycleConfigurationSources.get(context)
        if (!generated || !binding) return Object.freeze({ kind: 'unavailable' as const })
        const dependencies: { slug: string; checkoutId: CheckoutId; lockfilePath: string; target: string; policy: PlanInstallInput['policy'] }[] = []
        for (const sibling of loaded.config.sibling.filter(({ toolchain }) => toolchain !== 'none')) {
            const services = generated.services.filter(({ sibling: owner }) => owner === sibling.slug)
            if (services.length !== 1) return Object.freeze({ kind: 'unavailable' as const })
            const policies = services[0]!.mounts.flatMap((mount) => {
                if (mount.kind !== 'volume') return []
                const volume = generated.volumes.find(({ id }) => id === mount.source)
                if (!volume || volume.purpose !== 'dependencies' || !volume.install_policy) return []
                const policy = loaded.config.environment.install_policies.find((candidate) =>
                    candidate.volume === volume.install_policy && candidate.toolchain === sibling.toolchain)
                return policy ? [{ policy, target: mount.target }] : []
            })
            if (policies.length !== 1) return Object.freeze({ kind: 'unavailable' as const })
            const selected = policies[0]!
            if (selected.policy.install.length === 0 || selected.policy.load_probe.length === 0) {
                return Object.freeze({ kind: 'unavailable' as const })
            }
            const checkoutRoot = resolve(binding.siblingsRoot, sibling.dir)
            const lockfilePath = resolve(checkoutRoot, selected.policy.lockfile)
            if (!confinedPath(binding.siblingsRoot, checkoutRoot) || !confinedPath(checkoutRoot, lockfilePath)) {
                return Object.freeze({ kind: 'unavailable' as const })
            }
            dependencies.push({ slug: sibling.slug, checkoutId: deriveCheckoutId({ checkoutPath: checkoutRoot }),
                lockfilePath, target: selected.target, policy: {
                    volume: selected.policy.volume, lockfile: selected.policy.lockfile,
                    install: Object.freeze([...selected.policy.install]) as readonly [string, ...string[]],
                    load_probe: Object.freeze([...selected.policy.load_probe]) as readonly [string, ...string[]],
                } })
        }
        return Object.freeze({ kind: 'complete' as const, dependencies, mode: generated.data?.default_mode,
            vendors: generated.vendors.map(({ id }) => id) })
    })
    if (selection?.kind === 'refusal') return lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        registryRefusalMessage(selection), context.stackId)
    if (!selection || selection.kind !== 'complete' || runtime.topology.stackId !== context.stackId
        || runtime.topology.configSha256 !== projection.sourceSha256
        || runtime.topology.services.some((service) => service.generation !== projection.generation
            || service.sourceSha256 !== projection.sourceSha256)) {
        return lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'generated lifecycle source or runtime identity changed', context.stackId)
    }
    const current = (value: EnvironmentObservation, issued: (value: unknown) => boolean) => issued(value)
        && value.stackId === context.stackId && value.observed.state === 'available'
        && value.freshness.state === 'current'
        && observationSatisfiesExpectation(value)
        && isCanonicalTimestamp(value.observed.observedAt)
        && Date.parse(value.observed.observedAt) <= Date.now()
        && Date.parse(value.observed.observedAt) >= Date.parse(runtime.topology.observationWindow.startedAt)
    const stages = ['publication', 'generated', 'dependencies', 'data', 'external-dependencies', 'seeded']
    const previous = await readLifecycleRecord(context)
    if (!previous || 'status' in previous) return previous ?? lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID, 'generated completion requires persisted lifecycle progress', context.stackId)
    if (previous.value.holderId !== context.holderId
        || !isDeepStrictEqual(previous.value.generatedReplay, generatedReplay(projection))) return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID, 'generated progress identity changed', context.stackId)
    let persistedProgress = previous
    const applied = [...new Set(['publication', ...(previous.value.generatedProgress?.applied ?? [])])]
    const pending = new Set(previous.value.generatedProgress?.notApplied ?? [])
    const attempted = new Set(previous.value.generatedProgress?.attempted ?? [])
    const progress = (): GeneratedProgress => Object.freeze({ applied: Object.freeze([...applied]),
        notApplied: Object.freeze([...new Set([...stages, ...pending])].filter((stage) => !applied.includes(stage) && !attempted.has(stage))),
        ...(attempted.size ? { attempted: Object.freeze([...attempted].filter((step) => !applied.includes(step))) } : {}) })
    const merge = (value: GeneratedProgress | undefined) => {
        if (!value) return
        for (const step of value.applied) {
            if (!applied.includes(step)) applied.push(step)
            pending.delete(step)
            attempted.delete(step)
        }
        for (const step of value.notApplied) if (!applied.includes(step)) pending.add(step)
        for (const step of value.attempted ?? []) if (!applied.includes(step)) attempted.add(step)
    }
    const checkpoint = async (): Promise<UpCommandResult | undefined> => {
        const value = progress()
        generatedBringupProgress.set(context, value)
        const publication = await publishLifecycleRecord(context, persistedProgress.record,
            Object.freeze({ ...persistedProgress.value, generatedProgress: value }))
        if ('status' in publication) return publication
        if (publication.kind === 'indeterminate') return lifecycleRefusal(
            ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE, publication.message, publication.target)
        if (publication.kind !== 'complete') return lifecycleRefusal(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'generated progress publication returned no record', context.stackId)
        const current = decodeLifecycleRecord(publication.value, context)
        if (!current) return lifecycleRefusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'published generated progress is malformed', context.stackId)
        persistedProgress = current
        return undefined
    }
    const refusal = async (result: UpCommandResult): Promise<UpCommandResult> => {
        const failure = await checkpoint()
        return { ...result, progress: progress(),
            ...(failure ? { diagnostics: uniqueDiagnostics([...result.diagnostics, ...failure.diagnostics]) } : {}) }
    }
    const unavailable = (code: EnvironmentDiagnostic['code'], stage: string) => refusal(lifecycleRefusal(code,
        `generated ${stage} evidence is unavailable or does not match current lifecycle authority`, context.stackId))
    try {
        const generated = await adapters.completeGeneratedEnvironment!(context, runtime, services, projection)
        if (generated.kind === 'refusal') return refusal(generated)
        if (generated.kind !== 'complete' || !current(generated.result, isGeneratedObservation)) {
            return unavailable(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE, 'runtime')
        }
        if (!applied.includes('generated')) applied.push('generated')
        const generatedCheckpoint = await checkpoint()
        if (generatedCheckpoint) return { ...generatedCheckpoint, progress: progress() }
        const dependencies = await adapters.completeGeneratedDependencies!(context, runtime, services, projection)
        const dependencyEvidence = dependencies.kind === 'complete' ? dependencies.result : dependencies.progressEvidence ?? []
        if (!Array.isArray(dependencyEvidence) || dependencyEvidence.length > selection.dependencies.length) {
            return unavailable(ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY, 'dependency progress')
        }
        const dependencySlugs = new Set<string>()
        for (const observation of dependencyEvidence) {
            const matching = selection.dependencies.filter(({ checkoutId, lockfilePath, target, policy }) => isInstallObservation(observation, {
                checkoutId, lockfilePath, target, policy, stackId: context.stackId,
                configSha256: projection.sourceSha256, generation: projection.generation,
            }))
            if (matching.length !== 1 || !isInstallObservation(observation)
                || observation.stackId !== context.stackId || observation.freshness.state !== 'current'
                || !isCanonicalTimestamp(observation.observed.observedAt)
                || Date.parse(observation.observed.observedAt) < Date.parse(runtime.topology.observationWindow.startedAt)
                || Date.parse(observation.observed.observedAt) > Date.now()) {
                return unavailable(ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY, 'dependency progress')
            }
            const slug = matching[0]!.slug
            const verified = projectInstallProgress(observation)
            if (!verified || dependencySlugs.has(slug)) return unavailable(ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY, 'dependency progress')
            dependencySlugs.add(slug)
            merge({ applied: verified.applied.map((role) => `dependency:${slug}:${role}`),
                notApplied: verified.notApplied.map((role) => `dependency:${slug}:${role}`),
                attempted: verified.attempted?.map((role) => `dependency:${slug}:${role}`) })
        }
        merge({ applied: [], notApplied: selection.dependencies.flatMap(({ slug }) => ['install', 'load', 'stamp'].map((role) => `dependency:${slug}:${role}`)) })
        if (dependencies.kind === 'refusal') return refusal(dependencies)
        if (dependencies.kind !== 'complete' || dependencies.result.length !== selection.dependencies.length
            || dependencies.result.some((value) => !current(value, isInstallObservation))) {
            return unavailable(ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY, 'dependencies')
        }
        if (!applied.includes('dependencies')) applied.push('dependencies')
        const dependencyCheckpoint = await checkpoint()
        if (dependencyCheckpoint) return { ...dependencyCheckpoint, progress: progress() }
        // A stack that declares no data has no data step; the stage completes with nothing applied,
        // as external dependencies do for a stack without vendors.
        const mode = selection.mode
        if (mode === undefined) merge({ applied: ['data'], notApplied: [] })
        else {
            const data = await adapters.completeGeneratedData!(context, runtime, services, projection)
            if (data.kind === 'refusal') {
                const failed = await readDataModeOutcome({ namespace: context.namespace, stackId: context.stackId,
                    configSha256: projection.sourceSha256, generation: projection.generation, mode })
                const recorded = failed && consumeDataModeOutcomeProjection(failed)
                if (recorded?.outcome.kind === 'refusal' && isCanonicalTimestamp(recorded.observedAt)
                    && Date.parse(recorded.observedAt) >= Date.parse(runtime.topology.observationWindow.startedAt)
                    && Date.parse(recorded.observedAt) <= Date.now()) {
                    merge({ ...recorded.outcome, attempted: recorded.outcome.attempted.map(({ id }) => id) })
                }
                return refusal(data)
            }
            if (data.kind !== 'complete'
                || !((isDataModeCompletion(data.result, {
                        stackId: context.stackId, configSha256: projection.sourceSha256,
                        generation: projection.generation, mode,
                        earliestMs: Date.parse(runtime.topology.observationWindow.startedAt), latestMs: Date.now(),
                    }) && data.result.mode === mode)
                    || (isDataModeObservation(data.result) && current(data.result, isDataModeObservation)
                        && data.result.source === `data-mode:${projection.sourceSha256}:${projection.generation}`))) {
                return unavailable(ENVIRONMENT_CODES.DATA_MODE_UNAVAILABLE, 'data')
            }
            const persisted = await readDataModeOutcome({ namespace: context.namespace, stackId: context.stackId,
                configSha256: projection.sourceSha256, generation: projection.generation, mode })
            const durable = persisted && consumeDataModeOutcomeProjection(persisted)
            if (!durable || durable.outcome.kind !== 'complete') return unavailable(ENVIRONMENT_CODES.DATA_MODE_UNAVAILABLE, 'data history')
            merge({ applied: ['data', ...durable.outcome.applied], notApplied: [] })
        }
        const dataCheckpoint = await checkpoint()
        if (dataCheckpoint) return { ...dataCheckpoint, progress: progress() }
        if (selection.vendors.length > 0) {
            const vendors = await adapters.completeGeneratedVendors!(context, runtime, services, projection)
            const vendorEvidence = vendors.progressEvidence ?? []
            if (!Array.isArray(vendorEvidence) || vendorEvidence.length > selection.vendors.length) {
                return unavailable(ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE, 'vendor progress')
            }
            const vendorIds = new Set<string>()
            let vendorsAvailable = true
            for (const observation of vendorEvidence) {
                if (!isExternalDependencyObservationProjection(observation) || !observation.dependency
                    || !selection.vendors.includes(observation.dependency.id)
                    || !isExternalDependencyObservationProjection(observation, {
                        stackId: context.stackId, sourceSha256: projection.sourceSha256, generation: projection.generation,
                        purpose: 'startup', dependencyId: observation.dependency.id,
                    })
                    || !isCanonicalTimestamp(observation.observedAt)
                    || Date.parse(observation.observedAt) < Date.parse(runtime.topology.observationWindow.startedAt)
                    || Date.parse(observation.observedAt) > Date.now()) {
                    return unavailable(ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE, 'vendor progress')
                }
                const id = observation.dependency.id
                const verified = projectExternalDependencyProgress(observation)
                if (!verified || vendorIds.has(id)) return unavailable(ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE, 'vendor progress')
                vendorIds.add(id)
                vendorsAvailable &&= observation.state === 'available'
                merge({ applied: verified.applied.map((role) => `vendor:${id}:${role}`),
                    notApplied: verified.notApplied.map((role) => `vendor:${id}:${role}`),
                    attempted: verified.attempted?.map((role) => `vendor:${id}:${role}`) })
            }
            if (vendors.kind === 'refusal') return refusal(vendors)
            if (vendors.kind !== 'complete' || !vendorsAvailable || vendorIds.size !== selection.vendors.length
                || !current(vendors.result, (value) => isExternalDependencyObservation(value, 'startup'))) {
                return unavailable(ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE, 'external dependencies')
            }
        }
        if (!applied.includes('external-dependencies')) applied.push('external-dependencies')
        const vendorCheckpoint = await checkpoint()
        if (vendorCheckpoint) return { ...vendorCheckpoint, progress: progress() }
        const sourceCurrent = await withLifecycleConfiguration(context, async () => true)
        if (!sourceCurrent) return unavailable(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, 'configuration')
        for (const service of services) {
            const revalidated = await revalidateService(runtime.topology, { service: service.service, containerId: service.containerId }, adapters)
            if (revalidated.kind !== 'complete') return unavailable(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'runtime service')
        }
        const retained = await observeRetainedPortFamily({ namespace: context.namespace, stackId: context.stackId,
            holderId: context.holderId, checkoutId: context.checkoutId, config: context.ports })
        if (retained.kind !== 'complete') return refusal({ kind: 'refusal', status: 2, result: null, diagnostics: retained.diagnostics })
        const seeded = await recordLifecycleSeeded({ namespace: context.namespace, stackId: context.stackId,
            holderId: context.holderId, observedAt: new Date().toISOString() })
        if (seeded.kind === 'refusal') return refusal({ kind: 'refusal', status: 2, result: null, diagnostics: seeded.diagnostics })
        if (!applied.includes('seeded')) applied.push('seeded')
        const seededCheckpoint = await checkpoint()
        return seededCheckpoint ? { ...seededCheckpoint, progress: progress() } : undefined
    } catch (error) {
        return refusal(lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED,
            `generated lifecycle completion failed: ${error instanceof Error ? error.message : String(error)}`, context.stackId))
    }
}

async function executeUpRound(
    context: LifecycleRunContext,
    adapters: UpCommandAdapters,
    forceReset: boolean,
    rememberAcquisition: (value: LeasePortFamilyResult) => void,
    rememberRuntimeStart: () => void,
): Promise<UpRoundResult> {
    const operate = async (runtime: RuntimeReadiness, stage: LifecycleStageProjection, ports: AcquiredPorts): Promise<UpRoundResult> => {
        const current = await readLifecycleRecord(context)
        if (current !== null && 'kind' in current && current.kind !== 'complete') {
            return { kind: 'complete' as const, result: current }
        }
        const stored = current as CurrentLifecycleRecord | null
        const generated = generatedBringupRuns.get(context)
        if (stored && generated && !isDeepStrictEqual(stored.value.generatedReplay, generatedReplay(generated))) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'generated environment identity changed since lifecycle progress was recorded', context.stackId) }
        }
        const completedServiceIds = stored ? new Set(stored.value.completedServices.map(({ service }) => service)) : undefined
        const progressComplete = stored !== null && completedServiceIds?.size === runtime.topology.services.length
            && runtime.topology.services.every(({ id }) => completedServiceIds.has(id))
            && (stored.value.generatedReplay === undefined
                || stored.value.generatedProgress !== undefined && stored.value.generatedProgress.notApplied.length === 0)
        const previousHolderActive = stored !== null
            && ports.projection.ownership.holderIds.includes(stored.value.holderId)
        const currentHolderActive = ports.projection.ownership.holderIds.includes(context.holderId)
        const completedCoTenant = stored !== null && stored.value.holderId !== context.holderId && progressComplete
            && previousHolderActive && currentHolderActive
        if (stored && stored.value.holderId !== context.holderId
            && (previousHolderActive || !currentHolderActive) && !completedCoTenant) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                'lifecycle progress belongs to an active holder',
                context.stackId,
            ) }
        }

        const operationGeneration = stored && !forceReset
            ? stored.value.operationGeneration
            : randomBytes(32).toString('hex')
        const revalidateCompletedServices = async (): Promise<
            | Readonly<{ kind: 'complete'; evidence: readonly RuntimeServiceEvidence[] }>
            | Readonly<{ kind: 'retry' }>
            | Readonly<{ kind: 'refusal'; result: UpCommandResult }>
        > => {
            const evidence: RuntimeServiceEvidence[] = []
            if (!stored || forceReset) return { kind: 'complete', evidence }
            for (const completed of stored.value.completedServices) {
                const admitted = await revalidateService(runtime.topology, completed, adapters)
                if (admitted.kind === 'stale') return { kind: 'retry' }
                if (admitted.kind !== 'complete') {
                    const logDiagnostics = await collectFailureLogs(admitted.logs, completed.service, adapters)
                    const primary = lifecycleRefusal(
                        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                        'completed runtime service could not be revalidated',
                        completed.service,
                    )
                    return { kind: 'refusal', result: {
                        ...primary,
                        diagnostics: uniqueDiagnostics([...primary.diagnostics, ...logDiagnostics]),
                    } }
                }
                evidence.push(admitted.evidence)
            }
            return { kind: 'complete', evidence }
        }
        if (completedCoTenant) {
            const revalidated = await revalidateCompletedServices()
            if (revalidated.kind === 'retry') return { kind: 'complete', result: lifecycleRefusal(
                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                'completed lifecycle progress belongs to an active holder but its runtime evidence is stale',
                context.stackId,
            ) }
            if (revalidated.kind === 'refusal') return { kind: 'complete', result: revalidated.result }
            return { kind: 'complete' as const, result: {
                kind: 'complete', status: 0, diagnostics: [],
                result: { stackId: context.stackId, change: 'unchanged', entrypoints: ports.projection.entrypoints },
            } }
        }

        const admission = admitUpProgress({
            lifecycleStage: stage,
            runtime: runtime.lifecycle,
            ports: ports.projection,
            progress: stored && !forceReset ? progressValueForPlan(stored.value) : null,
            operationGeneration,
        })
        if (admission.kind === 'refusal') {
            return stored && !forceReset
                ? { kind: 'retry' as const, forceReset: true }
                : { kind: 'complete' as const, result: {
                    kind: 'refusal' as const, status: 2 as const, result: null, diagnostics: admission.diagnostics,
                } }
        }

        const revalidated = await revalidateCompletedServices()
        if (revalidated.kind === 'retry') return { kind: 'retry', forceReset: true }
        if (revalidated.kind === 'refusal') return { kind: 'complete', result: revalidated.result }
        let completedEvidence = [...revalidated.evidence]

        const planned = planAdmittedUp({ authority: admission.authority, completedServices: completedEvidence })
        if (planned.kind === 'refusal') {
            return stored && !forceReset
                ? { kind: 'retry' as const, forceReset: true }
                : { kind: 'complete' as const, result: lifecycleRefusal(
                      ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                      'current lifecycle work could not be planned',
                      context.stackId,
                  ) }
        }
        const issuance = consumeLifecycleIssuance(planned.plan)
        if (!issuance || issuance.drainRequest !== null || issuance.reclaim !== null) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'lifecycle plan authority is unavailable',
                context.stackId,
            ) }
        }
        const orderedServices = orderedRuntimeServices(issuance.topology)
        if (!orderedServices || issuance.firstIncompleteServiceIndex < 0
            || issuance.firstIncompleteServiceIndex > orderedServices.length) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'runtime service dependency order is unavailable',
                context.stackId,
            ) }
        }
        let published = stored
        const startedEvidence: RuntimeServiceEvidence[] = []
        const plannedValue: LifecycleRecordValue = Object.freeze({
            holderId: context.holderId,
            ...planned.plan.progress,
            ...(generated ? { generatedReplay: generatedReplay(generated),
                ...(stored?.value.generatedProgress ? { generatedProgress: stored.value.generatedProgress } : {}) } : {}),
        })
        if (!stored || forceReset || stored.value.holderId !== context.holderId && !completedCoTenant) {
            // The first lifecycle data starts its durable history, as `setup` does (an existing
            // `started` is unchanged), so lifecycle data without history keeps meaning that history
            // was lost. Publishing data alone let a first `up` pass and every resume refuse.
            if (!stored) {
                const started = await recordLifecycleStarted({ namespace: context.namespace, stackId: context.stackId,
                    holderId: context.holderId, observedAt: new Date().toISOString() })
                if (started.kind === 'refusal') return { kind: 'complete' as const, result: {
                    kind: 'refusal' as const, status: 2 as const, result: null, diagnostics: started.diagnostics,
                } }
            }
            const publication = await publishLifecycleRecord(
                context,
                stored?.record ?? null,
                plannedValue,
                stored && stored.value.holderId !== context.holderId
                    ? { previousHolderId: stored.value.holderId, projection: ports.projection }
                    : undefined,
            )
            if ('status' in publication) return { kind: 'complete' as const, result: publication }
            if (publication.kind === 'indeterminate') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                publication.message,
                publication.target,
            ) }
            if (publication.kind !== 'complete') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'lifecycle progress publication returned no record',
                context.stackId,
            ) }
            published = decodeLifecycleRecord(publication.value, context) ?? null
            if (!published) return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'published lifecycle progress is malformed',
                context.stackId,
            ) }
        }
        if (planned.kind === 'noop') {
            const generatedCompletion = await completeGeneratedBringup(context, adapters, runtime, completedEvidence)
            if (generatedCompletion) return { kind: 'complete' as const, result: generatedCompletion }
            return { kind: 'complete' as const, result: {
                kind: 'complete', status: 0, diagnostics: planned.plan.diagnostics,
                result: { stackId: context.stackId, change: 'unchanged', entrypoints: ports.projection.entrypoints },
                ...(generatedBringupProgress.has(context) ? { progress: generatedBringupProgress.get(context) } : {}),
            } satisfies UpCommandResult }
        }
        for (let index = issuance.firstIncompleteServiceIndex; index < orderedServices.length; index += 1) {
            const service = orderedServices[index]!
            rememberRuntimeStart()
            const admitted = await startService(issuance.topology, service.id, adapters)
            if (admitted.kind === 'refused') return { kind: 'complete' as const, result: forwardedRefusal(admitted.diagnostics) }
            if (admitted.kind !== 'complete') {
                const logDiagnostics = await collectFailureLogs(
                    admitted.kind === 'failure' ? admitted.logs : undefined,
                    service.id,
                    adapters,
                )
                const primary = lifecycleRefusal(
                    ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                    'runtime service did not become healthy',
                    service.id,
                )
                return { kind: 'complete' as const, result: {
                    ...primary,
                    diagnostics: uniqueDiagnostics([...primary.diagnostics, ...logDiagnostics]),
                } }
            }
            completedEvidence.push(admitted.evidence)
            startedEvidence.push(admitted.evidence)
            const nextValue: LifecycleRecordValue = Object.freeze({
                ...plannedValue,
                completedServices: Object.freeze([
                    ...published!.value.completedServices,
                    Object.freeze({ service: admitted.evidence.service, containerId: admitted.evidence.containerId }),
                ]),
            })
            const publication = await publishLifecycleRecord(context, published!.record, nextValue)
            if ('status' in publication) return { kind: 'complete' as const, result: publication }
            if (publication.kind === 'indeterminate') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                publication.message,
                publication.target,
            ) }
            if (publication.kind !== 'complete') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'lifecycle progress publication returned no record',
                context.stackId,
            ) }
            published = decodeLifecycleRecord(publication.value, context) ?? null
            if (!published) return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'published lifecycle progress is malformed',
                context.stackId,
            ) }
        }
        const coldStartObservation = observeRuntimeServiceColdStart({ services: startedEvidence })
        if (coldStartObservation.observed.state !== 'available'
            || typeof coldStartObservation.observed.value !== 'number'
            || coldStartObservation.expectation.kind !== 'maximum') {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'runtime cold-start evidence is unavailable',
                context.stackId,
            ) }
        }
        if (!observationSatisfiesExpectation(coldStartObservation)) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                coldStartObservation.code,
                'runtime cold start exceeded the declared budget',
                coldStartObservation.source,
            ) }
        }
        const coldStart = Object.freeze({
            measuredMillis: coldStartObservation.observed.value,
            limitMillis: coldStartObservation.expectation.value,
            headroomMillis: coldStartObservation.expectation.value - coldStartObservation.observed.value,
        })
        const generatedCompletion = await completeGeneratedBringup(context, adapters, runtime, completedEvidence)
        if (generatedCompletion) return { kind: 'complete' as const, result: generatedCompletion }
        return { kind: 'complete' as const, result: {
            kind: 'complete', status: 0, diagnostics: planned.plan.diagnostics,
            result: {
                stackId: context.stackId,
                change: planned.mode === 'start' ? 'started' : 'resumed',
                entrypoints: ports.projection.entrypoints,
                coldStart,
            },
            ...(generatedBringupProgress.has(context) ? { progress: generatedBringupProgress.get(context) } : {}),
        } satisfies UpCommandResult }
    }
    const unavailable = () => ({ kind: 'complete' as const, result: lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'lifecycle, port or runtime readiness authority is unavailable', context.stackId,
    ) })
    const refused: ReadinessRefusal<UpRoundResult> = (diagnostics) => ({ kind: 'complete', result: forwardedRefusal(diagnostics) })
    if (generatedBringupRuns.has(context)) {
        const earliest = Date.now()
        const expected = new Set<string>([
            ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR,
            ENVIRONMENT_CODES.MACHINE_CPU_BELOW_FLOOR,
            ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR,
        ])
        const floor = await adapters.withMachineFloorReadiness?.(context, async (observations) => {
            const now = Date.now()
            if (observations.length !== expected.size || !observations.every(isHostObservation)
                || new Set(observations.map(({ code }) => code)).size !== expected.size
                || observations.some((observation) => !expected.has(observation.code)
                    || observation.stackId !== context.stackId || observation.observed.state !== 'available'
                    || observation.freshness.state !== 'current' || !isCanonicalTimestamp(observation.observed.observedAt)
                    || Date.parse(observation.observed.observedAt) < earliest || Date.parse(observation.observed.observedAt) > now)) return undefined
            const failed = observations.find((observation) => !observationSatisfiesExpectation(observation))
            return failed ? lifecycleRefusal(failed.code, 'host capacity is below the declared floor', failed.source) : true
        }, forwardedRefusal)
        if (floor !== true) return floor ? { kind: 'complete', result: floor } : unavailable()
        return await adapters.withLifecycleStage(context, async (stage) => await adapters.withAcquiredPorts(context, async (ports) => {
            if (!matchesPortAcquisition(context, ports.leaseResult, ports.projection)) {
                return { kind: 'complete' as const, result: lifecycleRefusal(
                    ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                    'port acquisition does not match the current lifecycle authority',
                    context.stackId,
                ) }
            }
            rememberAcquisition(ports.leaseResult)
            return await adapters.withRuntimeReadiness(context, (runtime) => operate(runtime, stage, ports), ports.projection, refused) ?? unavailable()
        }, refused) ?? unavailable(), refused) ?? unavailable()
    }
    return await adapters.withRuntimeReadiness(context, async (runtime) => await adapters.withLifecycleStage(context, async (stage) =>
        await adapters.withAcquiredPorts(context, async (ports) => {
            if (!matchesPortAcquisition(context, ports.leaseResult, ports.projection)) {
                return { kind: 'complete' as const, result: lifecycleRefusal(
                    ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                    'port acquisition does not match the current lifecycle authority',
                    context.stackId,
                ) }
            }
            rememberAcquisition(ports.leaseResult)
            return operate(runtime, stage, ports)
        }, refused) ?? unavailable(), refused) ?? unavailable(), undefined, refused) ?? unavailable()
}

export async function runUp(
    input: UpCommandInput,
    adapters: UpCommandAdapters,
): Promise<UpCommandResult> {
    const configPath = exactCommandConfigPath(input)
    if (!configPath) return lifecycleContextRefusal()
    const loaded = await adapters.load(Object.freeze({ configPath }))
    if (loaded.kind === 'refusal') return loaded
    if (loaded.kind === 'preview') return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'lifecycle run context was not fully resolved',
        input.configPath,
    )
    if (loaded.result.configPath !== configPath || !issuedLifecycleRuns.delete(loaded.result)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'lifecycle run authority is unavailable',
            configPath,
        )
    }
    const context = loaded.result
    type AcquiredLeaseResult = Extract<LeasePortFamilyResult, { kind: 'complete' }> & { readonly change: 'acquired' }
    let acquired: AcquiredLeaseResult | undefined
    const rememberAcquisition = (lease: LeasePortFamilyResult) => {
        if (!acquired && lease.kind === 'complete' && lease.change === 'acquired') acquired = lease as AcquiredLeaseResult
    }
    // The holder claim and its lease are what own the stack's runtime: `down` and `reset` act only
    // for a holder, and the next `up` resumes from the holder's durable progress. Once this `up`
    // has asked Compose to start a service, containers may exist on the leased ports, so a refusal
    // keeps the claim rather than compensating it. Releasing it orphaned those containers: the
    // next `up` leased the same family and collided with its own ports, and `down` had no holder.
    let runtimeStarted = false
    const rememberRuntimeStart = () => { runtimeStarted = true }
    const releasable = () => acquired !== undefined && !runtimeStarted
    const generatedPreparation = await prepareGeneratedBringup(context, adapters, rememberAcquisition)
    if (generatedPreparation) {
        if (!acquired) return generatedPreparation
        const compensation = await compensateAcquiredPortHolder({
            namespace: context.namespace,
            leaseResult: acquired,
            now: new Date().toISOString(),
        })
        return compensation.kind === 'refusal' ? {
            ...generatedPreparation,
            diagnostics: uniqueDiagnostics([...generatedPreparation.diagnostics, ...compensation.diagnostics]),
        } : generatedPreparation
    }
    let forceReset = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const round = await executeUpRound(context, adapters, forceReset, rememberAcquisition, rememberRuntimeStart)
        if (round.kind === 'retry') {
            forceReset = round.forceReset
            continue
        }
        const result: UpCommandResult = round.result.progress || !generatedBringupProgress.has(context)
            ? round.result : { ...round.result, progress: generatedBringupProgress.get(context) }
        if (result.kind === 'refusal' && releasable()) {
            const compensation = await compensateAcquiredPortHolder({
                namespace: context.namespace,
                leaseResult: acquired!,
                now: new Date().toISOString(),
            })
            if (compensation.kind === 'refusal') return {
                ...result,
                diagnostics: uniqueDiagnostics([...result.diagnostics, ...compensation.diagnostics]),
            }
        }
        return result
    }
    if (releasable()) {
        const compensation = await compensateAcquiredPortHolder({
            namespace: context.namespace,
            leaseResult: acquired!,
            now: new Date().toISOString(),
        })
        if (compensation.kind === 'refusal') {
            const primary = lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'lifecycle progress could not be reset from fresh evidence',
                context.stackId,
            )
            return {
                ...primary,
                diagnostics: uniqueDiagnostics([...primary.diagnostics, ...compensation.diagnostics]),
                ...(generatedBringupProgress.has(context) ? { progress: generatedBringupProgress.get(context) } : {}),
            }
        }
    }
    return { ...lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
        'lifecycle progress could not be reset from fresh evidence',
        context.stackId,
    ), ...(generatedBringupProgress.has(context) ? { progress: generatedBringupProgress.get(context) } : {}) }
}

export async function runSession(
    input: SessionCommandInput,
    adapters: SessionCommandAdapters,
): Promise<SessionCommandResult> {
    if (adapters.signal?.aborted) return Object.freeze({
        kind: 'refusal' as const, status: 130 as const, result: null,
        diagnostics: Object.freeze([{ severity: 'error' as const, code: ENVIRONMENT_CODES.EXECUTION_ABORTED,
            message: 'the supervised session was cancelled before environment bring-up', target: input.argv[0] }]),
    })
    const executable = await adapters.resolveExecutable(input.argv[0], input.env)
    if (executable.state === 'unavailable') return lifecycleRefusal(
        ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        executable.reason,
        input.argv[0],
    )
    const up = await adapters.up({ configPath: input.configPath })
    if (up.kind === 'refusal') return up
    if (up.kind !== 'complete') return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'session bring-up did not reach a terminal result',
        input.configPath,
    )

    const child = await adapters.executeForeground({
        executable: executable.value,
        argv: Object.freeze(input.argv.slice(1)),
        cwd: input.cwd,
        env: input.env,
    }, { ...(adapters.signal ? { signal: adapters.signal } : {}) })
    if (!child.terminationConfirmed) return lifecycleRefusal(
        ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED,
        'the owned session process group could not be confirmed stopped; lifecycle ownership was preserved',
        input.argv[0],
    )

    const sleep = await adapters.sleep({ configPath: input.configPath })
    const cleanup = sleep.kind === 'complete' ? `; environment cleanup ${sleep.result.change}` : ''
    const childDiagnostic = child.kind === 'refusal'
        ? { severity: 'error' as const, code: child.code,
            message: `the supervised session process failed${cleanup}`, target: input.argv[0] }
        : child.exitCode === 0 ? undefined : {
            severity: 'error' as const, code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED,
            message: `the supervised session process exited with status ${child.exitCode}${cleanup}`, target: input.argv[0],
        }
    if (sleep.kind !== 'complete' || childDiagnostic) return {
        kind: 'refusal', status: sleep.kind === 'complete' && child.kind === 'refusal'
            && child.code === ENVIRONMENT_CODES.EXECUTION_ABORTED ? 130 : 2, result: null,
        diagnostics: Object.freeze([
            ...(childDiagnostic ? [childDiagnostic] : []),
            ...sleep.diagnostics,
        ]),
    }
    return Object.freeze({
        kind: 'complete' as const,
        status: 0 as const,
        diagnostics: Object.freeze([...up.diagnostics, ...sleep.diagnostics]),
        result: Object.freeze({
            child: Object.freeze({ exitCode: child.exitCode, signal: child.signal }),
            sleep: sleep.result,
        }),
    })
}

export async function runSleep(
    input: SleepCommandInput,
    adapters: SleepCommandAdapters,
): Promise<SleepCommandResult> {
    const configPath = exactCommandConfigPath(input)
    if (!configPath) return lifecycleContextRefusal()
    const loaded = await adapters.load(Object.freeze({ configPath }))
    if (loaded.kind === 'refusal') return loaded
    if (loaded.kind === 'preview') return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'lifecycle run context was not fully resolved',
        input.configPath,
    )
    if (loaded.result.configPath !== configPath || !issuedLifecycleRuns.delete(loaded.result)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'lifecycle run authority is unavailable',
            configPath,
        )
    }
    const context = loaded.result
    const recovery = await inspectSleepDrainRecovery({
        namespace: context.namespace,
        stackId: context.stackId,
        holderId: context.holderId,
    })
    if (recovery.kind === 'refusal') return {
        kind: 'refusal', status: 2, result: null, diagnostics: recovery.diagnostics,
    }

    const retained = await observeRetainedPortFamily({
        namespace: context.namespace,
        stackId: context.stackId,
        holderId: context.holderId,
        checkoutId: context.checkoutId,
        config: context.ports,
    })
    if (retained.kind !== 'complete') return lifecycleRefusal(
        retained.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        retained.diagnostics[0]?.message ?? 'retained port authority is unavailable',
        retained.diagnostics[0]?.target ?? context.stackId,
    )
    const entrypoints = deriveEntrypoints({
        lease: retained.lease,
        declarations: context.entrypointDerivatives,
    })
    if (entrypoints.kind !== 'complete') return lifecycleRefusal(
        entrypoints.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        entrypoints.diagnostics[0]?.message ?? 'entrypoint authority is unavailable',
        entrypoints.diagnostics[0]?.target ?? context.stackId,
    )
    const ports = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
    if (!ports) return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'retained port projection is unavailable',
        context.stackId,
    )
    const result = await adapters.withRuntimeReadiness(context, async (runtime) => {
        const generation = recovery.kind === 'recoverable'
            ? recovery.generation : randomBytes(32).toString('hex')
        const planned = planSleep({
            runtime: runtime.lifecycle,
            ports,
            operationGeneration: generation,
            runtimeStopValidForMs: recovery.kind === 'recoverable'
                ? recovery.runtimeStopValidForMs : 60_000,
        })
        if (planned.kind === 'refusal') return {
            kind: 'refusal' as const, status: 2 as const, result: null,
            diagnostics: planned.diagnostics,
        }
        const issuance = consumeLifecycleIssuance(planned.plan)
        if (!issuance || issuance.reclaim !== null || issuance.portOwnership.holderId !== context.holderId) {
            return lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'sleep lifecycle authority is unavailable',
                context.stackId,
            )
        }
        if (planned.kind === 'release-only') {
            if (recovery.kind === 'recoverable') return lifecycleRefusal(
                ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
                'persisted lifecycle work no longer matches current ownership',
                context.stackId,
            )
            const released = await releasePortFamily({
                namespace: context.namespace,
                stackId: context.stackId,
                requesterId: context.holderId,
                holderId: context.holderId,
                now: new Date().toISOString(),
            })
            if (released.kind !== 'complete' || released.change !== 'retained') return lifecycleRefusal(
                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                'shared lifecycle ownership changed before release',
                context.stackId,
            )
            return {
                kind: 'complete' as const, status: 0 as const, diagnostics: planned.plan.diagnostics,
                result: Object.freeze({ stackId: context.stackId, change: 'retained' as const }),
            }
        }
        if (!issuance.drainRequest) return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'sleep drain authority is unavailable',
            context.stackId,
        )
        let reserved
        if (recovery.kind === 'recoverable') {
            reserved = await recoverSleepDrainReservation({
                namespace: context.namespace,
                authority: recovery.authority,
                request: planned.request,
            })
        } else {
            reserved = await reserveDrain({ namespace: context.namespace, request: planned.request })
        }
        if (reserved.kind !== 'complete') return lifecycleRefusal(
            reserved.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            reserved.diagnostics[0]?.message ?? 'sleep drain could not be reserved',
            reserved.diagnostics[0]?.target ?? context.stackId,
        )
        const attempted = await reserveDrainAttempt({ namespace: context.namespace, authority: reserved.authority })
        if (attempted.kind !== 'complete') return lifecycleRefusal(
            attempted.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            attempted.diagnostics[0]?.message ?? 'sleep attempt could not be reserved',
            attempted.diagnostics[0]?.target ?? context.stackId,
        )
        const stop = createRuntimeStopPlan({ topology: issuance.topology, attempt: attempted.authority })
        if (stop.kind !== 'planned') return repairRequired(context)
        const stopped = await adapters.execute(stop.step)
        if (stopped.kind === 'refusal') {
            const failure = admitRuntimeStopFailure({ plan: stop, outcome: stopped })
            if (failure.kind !== 'complete') return repairRequired(context)
            const authority = consumeRuntimeStopFailure(failure.authority)
            if (!authority) return repairRequired(context)
            const finalized = await publishDrainOutcome(context, authority)
            return finalized ?? lifecycleRefusal(stopped.code, 'runtime stop did not start', context.stackId)
        }
        const observationPlan = createRuntimeStopObservationPlan({ plan: stop, outcome: stopped })
        if (observationPlan.kind !== 'planned') return repairRequired(context)
        const observation = await adapters.execute(observationPlan.step)
        const admitted = admitRuntimeStopped({ plan: observationPlan, outcome: observation })
        if (admitted.kind !== 'complete') return repairRequired(context)
        const authority = consumeRuntimeStopped(admitted.authority)
        if (!authority) return repairRequired(context)
        const invalidated = await invalidateCompletedLifecycle(
            context,
            planned.request.operationBasis,
            planned.request.generation,
        )
        if (invalidated) return invalidated
        const finalized = await publishDrainOutcome(context, authority)
        if (finalized) return finalized
        return {
            kind: 'complete' as const, status: 0 as const, diagnostics: planned.plan.diagnostics,
            result: Object.freeze({ stackId: context.stackId, change: 'stopped' as const }),
        }
    }, ports, forwardedRefusal)
    return result ?? lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'runtime readiness authority is unavailable',
        context.stackId,
    )
}

function repairRequired(context: LifecycleRunContext): SleepCommandResult {
    return lifecycleRefusal(
        ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
        'the active lifecycle attempt requires explicit repair',
        context.stackId,
    )
}

async function invalidateCompletedLifecycle(
    context: LifecycleRunContext,
    workBasisSha256: string,
    operationGeneration: string,
): Promise<SleepCommandResult | undefined> {
    const current = await readLifecycleRecord(context)
    if (current !== null && 'kind' in current) return {
        kind: 'refusal', status: 2, result: null, diagnostics: current.diagnostics,
    }
    const stored = current as CurrentLifecycleRecord | null
    // Stopped services are no longer complete, but the generated identity they ran stays: readiness
    // admits a generated resume only against it, so dropping it refused every resume after sleep.
    const value: LifecycleRecordValue = Object.freeze({
        holderId: context.holderId,
        workBasisSha256,
        operationGeneration,
        completedServices: Object.freeze([]),
        ...(stored?.value.generatedReplay ? { generatedReplay: stored.value.generatedReplay } : {}),
    })
    const publication = await publishLifecycleRecord(context, stored?.record ?? null, value)
    if ('status' in publication) return {
        kind: 'refusal', status: 2, result: null, diagnostics: publication.diagnostics,
    }
    if (publication.kind === 'indeterminate') return lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        publication.message,
        publication.target,
    )
    if (publication.kind !== 'complete' || !decodeLifecycleRecord(publication.value, context)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'stopped lifecycle invalidation could not be verified',
            context.namespace.paths.lifecycle(context.stackId).path,
        )
    }
    return undefined
}

async function publishDrainOutcome(
    context: LifecycleRunContext,
    authority: DrainOutcomeAuthority,
): Promise<SleepCommandResult | undefined> {
    const publication = await prepareDrainOutcomePublication({
        authority,
        namespace: context.namespace,
        stackId: context.stackId,
    })
    if ('diagnostics' in publication) {
        return { kind: 'refusal', status: 2, result: null, diagnostics: publication.diagnostics }
    }
    if (publication.kind === 'indeterminate') return lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        publication.message,
        publication.target,
    )
    if (publication.kind !== 'complete') {
        return publication.kind === 'missing'
            ? lifecycleRefusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain outcome publication returned no record', publication.path)
            : lifecycleRefusal(publication.code, publication.message, publication.target)
    }
    const finalized = finalizeDrainOutcome({
        authority,
        publication,
        address: context.namespace.paths.coordination(context.stackId),
    })
    return finalized ? undefined : repairRequired(context)
}

function exactCommandConfigPath(input: unknown): string | undefined {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.configPath || !('value' in descriptors.configPath)
            || typeof descriptors.configPath.value !== 'string' || descriptors.configPath.value.length === 0
            || descriptors.configPath.value.includes('\0')) return undefined
        return resolve(descriptors.configPath.value)
    } catch {
        return undefined
    }
}

type DestructivePlan = Extract<TeardownPlanResult | ResetPlanResult, { kind: 'complete' }>

function destructiveRefusal(
    diagnostics: readonly EnvironmentDiagnostic[],
): Extract<DownCommandResult, { kind: 'refusal' }> {
    return Object.freeze({ kind: 'refusal', status: 2, result: null, diagnostics })
}

function destructiveRepairRequired(context: DestructiveRunContext): Extract<DownCommandResult, { kind: 'refusal' }> {
    return lifecycleRefusal(
        ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
        'the active destructive attempt requires explicit repair',
        context.stackId,
    )
}

async function loadDestructiveContext(
    input: DownCommandInput | ResetCommandInput,
    adapters: DestructiveCommandAdapters,
): Promise<EnvironmentCommandOutcome<DestructiveRunContext>> {
    const configPath = exactCommandConfigPath(input)
    if (!configPath) return lifecycleContextRefusal()
    const loaded = await adapters.load(Object.freeze({ configPath }))
    if (loaded.kind !== 'complete') return loaded.kind === 'refusal' ? loaded : lifecycleContextRefusal()
    if (loaded.result.configPath !== configPath || !issuedDestructiveRuns.delete(loaded.result)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'destructive run authority is unavailable',
            configPath,
        )
    }
    return loaded
}

function selectedObservation<Observation extends DestructiveReclaimObservation>(
    context: DestructiveRunContext,
    observation: Observation | undefined,
): Observation | undefined {
    if (!observation) return undefined
    try {
        const selected = selectDestructiveInstance(observation.instance)
        return selected.kind === 'selected' && selected.stackId === context.stackId
            && selected.checkoutId === context.checkoutId ? observation : undefined
    } catch {
        return undefined
    }
}

async function observeDestructive(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
): Promise<DestructiveObservation | DestructiveObservationRefusal | undefined> {
    const observed = await adapters.observe(context)
    return observed && 'diagnostics' in observed ? observed : selectedObservation(context, observed)
}

// Each removal is proven by a fresh discovery, but re-measuring the runtime and re-listing the
// daemon twice per removal made `down` take minutes on a busy shared daemon. A reserved drain's
// steps re-read only reclaim evidence, and one discovery both reconciles a removal and plans the next.
async function observeDestructiveReclaim(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined> {
    const observed = adapters.observeReclaim ? await adapters.observeReclaim(context) : await adapters.observe(context)
    return observed && 'diagnostics' in observed ? observed : selectedObservation(context, observed)
}

// Before this run reserves a drain there is no attempt of its own to repair, so a missing
// observation is an evidence failure. Reporting DRAIN_ATTEMPT_REPAIR_REQUIRED here sent the
// operator of a stopped runtime looking for an interrupted attempt that did not exist.
function destructivePreconditionRefusal(
    context: DestructiveRunContext,
    observed: DestructiveObservationRefusal | undefined,
): Extract<DownCommandResult, { kind: 'refusal' }> {
    return observed ?? lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'destructive preconditions (configuration, retained ports, runtime readiness or reclaim discovery) could not be observed; this run reserved no destructive attempt',
        context.stackId,
    )
}

// After a reservation the attempt is real and must be repaired; the owner's own diagnostics
// still say why the observation failed.
function destructiveRepairAfterObservation(
    context: DestructiveRunContext,
    observed: DestructiveObservationRefusal | undefined,
): Extract<DownCommandResult, { kind: 'refusal' }> {
    const repair = destructiveRepairRequired(context)
    return observed ? destructiveRefusal(uniqueDiagnostics([...repair.diagnostics, ...observed.diagnostics])) : repair
}

async function publishDestructiveOutcome(
    context: DestructiveRunContext,
    authority: DrainOutcomeAuthority,
): Promise<Extract<DownCommandResult, { kind: 'refusal' }> | undefined> {
    const result = await publishDrainOutcome(context, authority)
    return result?.kind === 'refusal' ? result : undefined
}

async function executeRuntimeDrain(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
    topology: RuntimeTopologyEvidence,
    attempt: Awaited<ReturnType<typeof reserveDrainAttempt>>,
): Promise<DrainOutcomeAuthority | Extract<DownCommandResult, { kind: 'refusal' }>> {
    if (attempt.kind !== 'complete') return destructiveRefusal(attempt.diagnostics)
    const stop = createRuntimeStopPlan({ topology, attempt: attempt.authority })
    if (stop.kind !== 'planned') return destructiveRepairRequired(context)
    const outcome = await adapters.execute(stop.step)
    if (outcome.kind === 'refusal') {
        const failure = admitRuntimeStopFailure({ plan: stop, outcome })
        if (failure.kind !== 'complete') return destructiveRepairRequired(context)
        const authority = consumeRuntimeStopFailure(failure.authority)
        return authority ?? destructiveRepairRequired(context)
    }
    const observationPlan = createRuntimeStopObservationPlan({ plan: stop, outcome })
    if (observationPlan.kind !== 'planned') return destructiveRepairRequired(context)
    const observed = await adapters.execute(observationPlan.step)
    const admitted = admitRuntimeStopped({ plan: observationPlan, outcome: observed })
    if (admitted.kind !== 'complete') return destructiveRepairRequired(context)
    return consumeRuntimeStopped(admitted.authority) ?? destructiveRepairRequired(context)
}

async function executeDestructivePlan(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
    purpose: 'down' | 'reset',
    lifecyclePlan: ReturnType<typeof planDown>,
    firstPlan: DestructivePlan,
    recoveredReservation?: Extract<Awaited<ReturnType<typeof recoverDrainReservation>>, { kind: 'complete' }>,
    recoveredRequest?: DrainReservationRequest,
): Promise<DownCommandResult | OperatorResetResult> {
    if (lifecyclePlan.kind !== 'drain') return destructiveRefusal(lifecyclePlan.diagnostics)
    const issuance = consumeLifecycleIssuance(lifecyclePlan.plan)
    if (!issuance?.drainRequest || !issuance.reclaim || issuance.reclaim.purpose !== purpose) {
        return destructiveRepairRequired(context)
    }
    const request = recoveredRequest ?? lifecyclePlan.request
    const reserved = recoveredReservation ?? await reserveDrain({ namespace: context.namespace, request })
    if (reserved.kind !== 'complete') return destructiveRefusal(reserved.diagnostics)
    let availableReservation = reserved.reservation.completedActionCount === 0 ? undefined : reserved
    if (reserved.reservation.completedActionCount === 0) {
        const runtimeAttempt = await reserveDrainAttempt({ namespace: context.namespace, authority: reserved.authority })
        const runtimeOutcome = await executeRuntimeDrain(context, adapters, issuance.topology, runtimeAttempt)
        if ('kind' in runtimeOutcome) return runtimeOutcome
        const runtimePublished = await publishDestructiveOutcome(context, runtimeOutcome)
        if (runtimePublished) return runtimePublished
    }

    let plan = firstPlan
    while (plan.actionAuthority !== null) {
        const recovered = availableReservation ?? await recoverDrainReservation({ namespace: context.namespace, request })
        availableReservation = undefined
        if (recovered.kind !== 'complete') return destructiveRefusal(recovered.diagnostics)
        const attempt = await reserveDrainAttempt({ namespace: context.namespace, authority: recovered.authority })
        if (attempt.kind !== 'complete') return destructiveRefusal(attempt.diagnostics)
        const execution = await redeemReclaimAction({ actionAuthority: plan.actionAuthority, attempt: attempt.authority })
        if (!execution) return destructiveRepairRequired(context)
        const outcome = await adapters.execute(execution.step)
        if (outcome.kind === 'refusal') {
            const admitted = admitReclaimFailure({ authority: execution.authority, outcome })
            if (admitted.kind !== 'complete') return destructiveRepairRequired(context)
            const authority = consumeReclaimFailure(admitted.authority)
            if (!authority) return destructiveRepairRequired(context)
            const published = await publishDestructiveOutcome(context, authority)
            return published ?? destructiveRefusal(Object.freeze([Object.freeze({
                severity: 'error', code: outcome.code,
                message: 'destructive action did not start', target: context.stackId,
            })]))
        }
        const postAction = await observeDestructiveReclaim(context, adapters)
        if (!postAction || 'diagnostics' in postAction) return destructiveRepairAfterObservation(context, postAction)
        const reconciled = reconcileReclaimAction({
            authority: execution.authority,
            outcome,
            discovery: (purpose === 'down' ? postAction.down.discovery : postAction.reset.discovery) as ReclaimDiscoverySnapshot,
        })
        if (reconciled.kind === 'refusal' || reconciled.authority === null) return destructiveRepairRequired(context)
        const authority = consumeReclaimCompleted(reconciled.authority)
        if (!authority) return destructiveRepairRequired(context)
        const published = await publishDestructiveOutcome(context, authority)
        if (published) return published
        if (reconciled.continuation === null) {
            plan = Object.freeze({ ...plan, actionAuthority: null, continuation: null, remaining: 0 })
            break
        }
        // The discovery that reconciled this removal plans the next; only the coordination record
        // moved since, by the outcome just published, so it is read again.
        const coordination = await readState(context.namespace.paths.coordination(context.stackId))
        if (coordination.kind !== 'complete') return destructiveRepairRequired(context)
        const next = purpose === 'down'
            ? await planTeardown({ ...postAction.down, coordinationRecord: coordination.value,
                expectedDiscoveryDigest: request.planDigest, continuation: reconciled.continuation })
            : await planReset({ ...postAction.reset, coordinationRecord: coordination.value,
                expectedCoordinationRevision: coordination.value.revision,
                confirmationDigest: request.planDigest, continuation: reconciled.continuation })
        if (next.kind !== 'complete') return next.kind === 'refusal'
            ? destructiveRefusal(next.diagnostics) : destructiveRepairRequired(context)
        plan = next
    }
    return purpose === 'down'
        ? Object.freeze({
            kind: 'complete' as const, status: 0 as const, diagnostics: lifecyclePlan.plan.diagnostics,
            result: Object.freeze({ stackId: context.stackId, change: 'removed' as const }),
        })
        : Object.freeze({
            kind: 'complete' as const, status: 0 as const, diagnostics: lifecyclePlan.plan.diagnostics,
            result: Object.freeze({ stackId: context.stackId, change: 'reset' as const }),
        })
}

function destructivePlanningBasis(request: DrainReservationRequest | undefined): Readonly<{
    generation: string
    runtimeStopValidForMs: number
    reclaimValidForMs: number
}> {
    const runtimeStop = request?.actions.find(({ stage }) => stage === 'runtime-stop')
    const reclaim = request?.actions.find(({ stage }) => stage === 'reclaim')
    return Object.freeze({
        generation: request?.generation ?? randomBytes(32).toString('hex'),
        runtimeStopValidForMs: runtimeStop?.validForMs ?? 60_000,
        reclaimValidForMs: reclaim?.validForMs ?? 60_000,
    })
}

function matchesPersistedDrainRequest(
    planned: DrainReservationRequest,
    persisted: DrainReservationRequest | undefined,
): boolean {
    if (persisted === undefined) return true
    const { expectedCoordinationRevision: plannedRevision, ...plannedWork } = planned
    const { expectedCoordinationRevision: persistedRevision, ...persistedWork } = persisted
    return plannedRevision >= persistedRevision && isDeepStrictEqual(plannedWork, persistedWork)
}

async function prepareDown(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
): Promise<{
    runtime: DestructiveObservation['runtime']
    ports: DestructiveObservation['ports']
    observation: DestructiveReclaimObservation
    preview: Extract<TeardownPlanResult, { kind: 'complete' }>
} | Extract<DownCommandResult, { kind: 'refusal' }>> {
    const previewObservation = await observeDestructive(context, adapters)
    if (!previewObservation || 'diagnostics' in previewObservation) return destructivePreconditionRefusal(context, previewObservation)
    const preview = await planTeardown(previewObservation.down)
    if (preview.kind !== 'complete') return destructiveRefusal(preview.diagnostics)
    // The plan needs a discovery after the preview's consent; the runtime the preview measured
    // seconds ago still stands for planning the drain.
    const observation = await observeDestructiveReclaim(context, adapters)
    if (!observation || 'diagnostics' in observation) return destructivePreconditionRefusal(context, observation)
    return { runtime: previewObservation.runtime, ports: previewObservation.ports, observation, preview }
}

export async function runDown(
    input: DownCommandInput,
    adapters: DownCommandAdapters,
): Promise<DownCommandResult> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as DownCommandResult
    const context = loaded.result
    const prepared = await prepareDown(context, adapters)
    if ('diagnostics' in prepared) return prepared
    const projection = projectTeardownActionTargets(prepared.preview)
    if (!projection) return destructivePreconditionRefusal(context, undefined)
    const inspection = await inspectDestructiveDrainRecovery({
        namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, purpose: 'down',
    })
    if (inspection.kind === 'refusal') return destructiveRefusal(inspection.diagnostics)
    const persistedRequest = inspection.kind === 'recoverable' ? inspection.request : undefined
    const basis = destructivePlanningBasis(persistedRequest)
    const lifecycle = planDown({
        runtime: prepared.runtime,
        ports: prepared.ports,
        reclaim: projection,
        operationGeneration: basis.generation,
        runtimeStopValidForMs: basis.runtimeStopValidForMs,
        reclaimValidForMs: basis.reclaimValidForMs,
    })
    if (lifecycle.kind !== 'drain') return destructiveRefusal(lifecycle.diagnostics)
    if (!matchesPersistedDrainRequest(lifecycle.request, persistedRequest)) return destructiveRepairRequired(context)
    const recovered = persistedRequest === undefined ? undefined
        : await recoverDrainReservation({ namespace: context.namespace, request: persistedRequest })
    if (recovered?.kind === 'refusal') return destructiveRefusal(recovered.diagnostics)
    const plan = await planTeardown({
        ...prepared.observation.down,
        expectedDiscoveryDigest: prepared.preview.discoveryDigest,
        ...(recovered?.kind === 'complete'
            ? { recoveryAuthority: recovered.authority }
            : prepared.preview.consent === null ? {} : { consent: prepared.preview.consent }),
    })
    if (plan.kind !== 'complete') return destructiveRefusal(plan.diagnostics)
    return executeDestructivePlan(
        context, adapters, 'down', lifecycle, plan,
        recovered?.kind === 'complete' ? recovered : undefined,
        persistedRequest,
    ) as Promise<DownCommandResult>
}

interface PrivateResetSession {
    readonly context: DestructiveRunContext
    readonly adapters: ResetCommandAdapters
    readonly preview: ResetPreview
}

const privateResetSessions = new WeakMap<object, PrivateResetSession>()

async function resetPreview(
    context: DestructiveRunContext,
    adapters: ResetCommandAdapters,
): Promise<ResetPreview | Extract<ResetCommandResult, { kind: 'refusal' }>> {
    const observation = await observeDestructive(context, adapters)
    if (!observation || 'diagnostics' in observation) return destructivePreconditionRefusal(context, observation)
    const preview = await planReset(observation.reset)
    return preview.kind === 'preview' ? preview : preview.kind === 'refusal'
        ? destructiveRefusal(preview.diagnostics) : destructivePreconditionRefusal(context, undefined)
}

function publicResetPreview(context: DestructiveRunContext, preview: ResetPreview): Extract<ResetCommandResult, { kind: 'preview' }> {
    return Object.freeze({
        kind: 'preview', status: 0, diagnostics: Object.freeze([]),
        result: Object.freeze({
            stackId: context.stackId, planDigest: preview.digest,
            targets: Object.freeze(preview.targets.map((target) => Object.freeze({ ...target }))),
            noop: preview.noop,
        }),
    })
}

export async function runReset(
    input: ResetCommandInput,
    adapters: ResetCommandAdapters,
): Promise<ResetCommandResult> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as ResetCommandResult
    const preview = await resetPreview(loaded.result, adapters)
    return 'status' in preview ? preview : publicResetPreview(loaded.result, preview)
}

export async function beginOperatorReset(
    input: ResetCommandInput,
    adapters: ResetCommandAdapters,
): Promise<OperatorResetSession | Extract<ResetCommandResult, { kind: 'refusal' }>> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as Extract<ResetCommandResult, { kind: 'refusal' }>
    const context = loaded.result
    const preview = await resetPreview(context, adapters)
    if ('status' in preview) return preview
    const token = Object.freeze({})
    privateResetSessions.set(token, Object.freeze({ context, adapters, preview }))
    const session = Object.freeze({
        preview: publicResetPreview(context, preview),
        decide: (decision: 'approve' | 'decline') => continueOperatorReset(token, decision),
    })
    return session
}

async function continueOperatorReset(token: object, decision: 'approve' | 'decline'): Promise<OperatorResetResult> {
    const session = privateResetSessions.get(token)
    privateResetSessions.delete(token)
    if (!session || decision !== 'approve') return destructiveRefusal(Object.freeze([Object.freeze({
        severity: 'error', code: ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
        message: decision === 'decline' ? 'reset was declined' : 'reset operator session is unavailable', target: 'reset',
    })]))
    const observation = await observeDestructive(session.context, session.adapters)
    if (!observation || 'diagnostics' in observation) return destructivePreconditionRefusal(session.context, observation)
    if (session.preview.noop) {
        const noop = await planReset({
            ...observation.reset,
            confirmationDigest: session.preview.digest,
            consent: session.preview.consent,
        })
        if (noop.kind !== 'complete' || !noop.noop || noop.actionAuthority !== null) {
            return noop.kind === 'refusal' ? destructiveRefusal(noop.diagnostics) : destructivePreconditionRefusal(session.context, undefined)
        }
        const inspection = await inspectDestructiveDrainRecovery({
            namespace: session.context.namespace, stackId: session.context.stackId,
            holderId: session.context.holderId, purpose: 'reset',
        })
        if (inspection.kind !== 'none') return inspection.kind === 'refusal'
            ? destructiveRefusal(inspection.diagnostics) : destructiveRepairRequired(session.context)
        return Object.freeze({
            kind: 'complete', status: 0, diagnostics: Object.freeze([]),
            result: Object.freeze({ stackId: session.context.stackId, change: 'unchanged' }),
        })
    }
    const inspection = await inspectDestructiveDrainRecovery({
        namespace: session.context.namespace, stackId: session.context.stackId,
        holderId: session.context.holderId, purpose: 'reset',
    })
    if (inspection.kind === 'refusal') return destructiveRefusal(inspection.diagnostics)
    const persistedRequest = inspection.kind === 'recoverable' ? inspection.request : undefined
    const recovered = persistedRequest === undefined ? undefined
        : await recoverDrainReservation({ namespace: session.context.namespace, request: persistedRequest })
    if (recovered?.kind === 'refusal') return destructiveRefusal(recovered.diagnostics)
    const projection = projectResetActionTargets(session.preview)
    if (!projection) return destructiveRepairRequired(session.context)
    const basis = destructivePlanningBasis(persistedRequest)
    const lifecycle = planResetLifecycle({
        runtime: observation.runtime,
        ports: observation.ports,
        reclaim: projection,
        operationGeneration: basis.generation,
        runtimeStopValidForMs: basis.runtimeStopValidForMs,
        reclaimValidForMs: basis.reclaimValidForMs,
    })
    if (lifecycle.kind !== 'drain') return destructiveRefusal(lifecycle.diagnostics)
    if (!matchesPersistedDrainRequest(lifecycle.request, persistedRequest)) return destructiveRepairRequired(session.context)
    const actionablePlan = await planReset({
        ...observation.reset,
        confirmationDigest: session.preview.digest,
        ...(recovered?.kind === 'complete'
            ? { recoveryAuthority: recovered.authority }
            : { consent: session.preview.consent }),
    })
    if (actionablePlan.kind !== 'complete') return actionablePlan.kind === 'refusal'
        ? destructiveRefusal(actionablePlan.diagnostics) : destructiveRepairRequired(session.context)
    return executeDestructivePlan(
        session.context, session.adapters, 'reset', lifecycle, actionablePlan,
        recovered?.kind === 'complete' ? recovered : undefined,
        persistedRequest,
    ) as Promise<OperatorResetResult>
}

export interface ComparisonRemoteInput {
    readonly executable: ResolvedExecutable
    readonly checkoutRoot: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
    readonly checkoutId: CheckoutId
    readonly source: string
    readonly sibling: string
    readonly acquire: 'auto' | 'manual' | 'none'
    readonly declaredRemote?: string
}

export interface HealthObservationProducers {
    readonly generated: () => Promise<readonly EnvironmentObservation[]>
    readonly data: () => Promise<readonly EnvironmentObservation[]>
    readonly envSchema: () => Promise<readonly EnvironmentObservation[]>
    readonly external: () => Promise<readonly EnvironmentObservation[]>
    readonly claims: () => Promise<readonly EnvironmentObservation[]>
    readonly git: () => Promise<readonly EnvironmentObservation[]>
    readonly host: () => Promise<readonly EnvironmentObservation[]>
    readonly installs: () => Promise<readonly EnvironmentObservation[]>
    readonly lifecycle: () => Promise<readonly EnvironmentObservation[]>
    readonly ports: () => Promise<readonly EnvironmentObservation[]>
    readonly runtime: () => Promise<readonly EnvironmentObservation[]>
    readonly state: () => Promise<readonly EnvironmentObservation[]>
    readonly templates: () => Promise<readonly EnvironmentObservation[]>
}

export interface HealthObservationSourceInput {
    readonly checkout: SetupCheckoutProjection
    readonly configuration: LoadedConfigProjection
    readonly preflight: PreflightContext
    readonly env: Readonly<Record<string, string>>
    readonly gitExecutable: ResolvedExecutable
    readonly timeoutMs: number
    readonly producers: HealthObservationProducers
    readonly refreshPreflight: (previous: PreflightContext) => Promise<PreflightContext | undefined>
}

export interface HealthObservationSource {
    readonly kind: 'health-observation-source'
}

interface ObservationCommandAdapters {
    readonly load: (
        input: { readonly configPath: string },
        issue: (source: HealthObservationSourceInput) => HealthObservationSource | undefined,
        refuse?: ReadinessRefusal<undefined>,
    ) => Promise<HealthObservationSource | undefined>
    readonly execute: (
        step: ExecutionStep,
        options: { readonly signal?: AbortSignal },
    ) => Promise<ExecuteProbeOutcome>
}

export interface PreflightCommandInput {
    readonly configPath: string
}

export interface PreflightCommandAdapters extends ObservationCommandAdapters {}

export interface ComparisonRemoteEvaluation {
    readonly sibling: string
    readonly result: ComparisonRemoteResult
}

export interface ApplicationPreflightEvaluation {
    readonly verdict: PreflightEvaluation['verdict']
    readonly revision: string
    readonly checks: readonly EvaluatedObservation[]
    readonly comparisons: readonly ComparisonRemoteEvaluation[]
}

export type PreflightCommandResult =
    | Readonly<{
        kind: 'complete'
        status: 0
        diagnostics: readonly EnvironmentDiagnostic[]
        result: ApplicationPreflightEvaluation
    }>
    | Readonly<{
        kind: 'blocked'
        status: 2
        diagnostics: readonly EnvironmentDiagnostic[]
        result: ApplicationPreflightEvaluation
    }>

export interface DoctorCommandInput {
    readonly configPath: string
}
export interface DoctorSurfaceOverrideInspectionComplete {
    readonly kind: 'complete'
    readonly activeOverrides: readonly ActiveSurfaceOverride[]
    readonly changedOverrideOriginals: readonly SurfaceUpgradeFinding[]
}

export interface DoctorSurfaceOverrideInspectionUnavailable {
    readonly kind: 'unavailable'
    readonly code: string
    readonly reason: string
}

export interface DoctorSurfaceOverrideInspectionRefusal {
    readonly kind: 'refusal'
    readonly code: string
    readonly reason: string
}

export type DoctorSurfaceOverrideInspection =
    | DoctorSurfaceOverrideInspectionComplete
    | DoctorSurfaceOverrideInspectionUnavailable
    | DoctorSurfaceOverrideInspectionRefusal

export interface DoctorCommandAdapters extends ObservationCommandAdapters {
    readonly inspectSurfaceOverrides?: (configPath: string) => Promise<DoctorSurfaceOverrideInspection>
    readonly discoverReleaseFreshness?: () => Promise<ReleaseFreshness>
}

interface DoctorFreshness {
    readonly local: GeneratedEnvironmentCurrentness['outcome']
    readonly changes: GeneratedEnvironmentCurrentness['changes']
    readonly storedProducer: GeneratedEnvironmentCurrentness['storedProducer']
    readonly installedProducer: GeneratedEnvironmentCurrentness['currentProducer']
    readonly release: ReleaseFreshness
    readonly repair?: ReturnType<typeof proposeGeneratedEnvironmentRepair>
}

export interface DoctorDeclaration {
    readonly subject: 'runtime' | 'resource-ceilings' | 'data-modes' | 'vendor-guards'
    readonly state: 'declared' | 'not-declared'
    readonly source: string
    readonly reason: string
}

export interface ApplicationDoctorEvaluation {
    readonly verdict: PreflightEvaluation['verdict']
    readonly checks: readonly DoctorCheck[]
    readonly comparisons: readonly ComparisonRemoteEvaluation[]
    readonly surfaceOverrides: DoctorSurfaceOverrideInspection
    readonly freshness: DoctorFreshness
    /** What the configuration declares, read from cockpit.toml alone; empty when it does not load. */
    readonly declarations: readonly DoctorDeclaration[]
}

// Resource ceilings, data modes and vendor guards are rendered into a generated stack. A cockpit that
// runs its own Compose file, or none, has not declared them, and doctor says so instead of letting an
// absent check read as a passed one.
type LoadedDoctorConfig = Awaited<ReturnType<typeof loadCockpitConfig>>

async function doctorDeclarations(loading: Promise<LoadedDoctorConfig>): Promise<readonly DoctorDeclaration[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete') return Object.freeze([])
    const config = loaded.result.config
    const runtime = declaredRuntime(config.environment)
    const generated = config.environment.generated
    const absent = runtime === 'none' ? 'no runtime environment is declared'
        : runtime === 'compose' ? 'a compose-first cockpit runs its own Compose file; cockpit declares and enforces this only for environment.generated'
            : 'the generated environment declares none'
    const row = (subject: DoctorDeclaration['subject'], declared: boolean, source: string, reason: string): DoctorDeclaration =>
        Object.freeze({ subject, state: declared ? 'declared' as const : 'not-declared' as const, source, reason: declared ? reason : absent })
    return Object.freeze([
        Object.freeze(runtime === 'none'
            ? { subject: 'runtime' as const, state: 'not-declared' as const, source: 'environment',
                reason: 'neither environment.compose_files nor environment.generated is declared; runtime commands refuse' }
            : { subject: 'runtime' as const, state: 'declared' as const,
                source: runtime === 'generated' ? 'environment.generated' : 'environment.compose_files',
                reason: runtime === 'generated' ? 'cockpit renders and owns the Compose file' : 'cockpit runs the declared Compose files' }),
        row('resource-ceilings', !!generated && (generated.services.some(service => service.resources) || !!config.browser?.resources),
            'environment.generated.services[].resources', 'generated services declare resource ceilings'),
        row('data-modes', !!generated?.data, 'environment.generated.data', 'the generated stack declares its data modes'),
        row('vendor-guards', !!generated?.vendors.some(vendor => vendor.egress_guard),
            'environment.generated.vendors[].egress_guard', 'generated vendors declare egress guards'),
    ])
}

// The guard denies agent commands that reach these hosts. Two empty lists deny nothing, and that
// looks exactly like a guard that is working, so doctor says so. A declared runtime is the signal
// that hosted environments exist; generated vendors live under it, so it covers them too.
async function doctorGuardHostDiagnostics(loading: Promise<LoadedDoctorConfig>): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete') return Object.freeze([])
    const { environment, guards } = loaded.result.config
    if (declaredRuntime(environment) === 'none' || guards.hosted_db_hosts.length > 0 || guards.vendor_endpoint_hosts.length > 0) {
        return Object.freeze([])
    }
    return Object.freeze([Object.freeze({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'GUARD_HOSTS_UNDECLARED' satisfies typeof ENVIRONMENT_CODES.GUARD_HOSTS_UNDECLARED,
        message: 'guards.hosted_db_hosts and guards.vendor_endpoint_hosts are both empty, so the guard denies no agent command by host even though this cockpit declares a runtime',
        target: 'guards',
        fix: 'list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, this warning is expected',
    })])
}

export type DoctorCommandResult = Readonly<{
    kind: 'complete'
    status: 0
    diagnostics: readonly EnvironmentDiagnostic[]
    result: ApplicationDoctorEvaluation
}>

export interface LogsCommandInput {
    readonly configPath: string
    readonly service: string
    readonly since: string
    readonly tail: number
    readonly follow: boolean
    readonly json: boolean
}

export type LogRequestBase = Omit<LogRequest, 'since' | 'tail' | 'follow'>

export interface LogObservation {
    readonly generatedComposeAuthority?: GeneratedComposeArtifactAuthority
    readonly request: LogRequestBase
    readonly restart?: RestartWindow
}

export interface LogsCommandAdapters {
    readonly observe: (input: {
        readonly configPath: string
        readonly service: string
    }) => Promise<LogObservation>
    readonly execute: (
        step: ExecutionStep,
        options: { readonly signal?: AbortSignal },
    ) => Promise<ExecuteProbeOutcome>
    readonly signal?: AbortSignal
}

export type LogsCommandResult = EnvironmentCommandOutcome<Readonly<{
    readonly json: boolean
    readonly records: readonly LogRecord[]
}>> | Readonly<{
    kind: 'cancelled'
    status: 130
    diagnostics: readonly EnvironmentDiagnostic[]
    result: Readonly<{ json: boolean; records: readonly LogRecord[] }>
}>

export interface BaselineCommandInput {
    readonly configPath: string
    readonly confirmation: string
    readonly recordedAt: string
}

export interface BaselineObservation {
    readonly snapshot: EnvironmentSnapshot
    readonly evidence: CapturedRuntimeEvidence
    readonly previous?: EnvironmentBaseline
}

export interface BaselineCommandAdapters {
    readonly observe: (input: { readonly configPath: string }) => Promise<BaselineObservation>
    readonly revalidate: (observation: BaselineObservation) => Promise<BaselineObservation>
    readonly write: (baseline: EnvironmentBaseline) => Promise<void>
}

export type BaselineCommandResult = EnvironmentCommandOutcome<EnvironmentBaseline>

export interface OperatorBaselineSession {
    readonly preview: Readonly<{
        readonly kind: 'preview'
        readonly status: 0
        readonly diagnostics: readonly EnvironmentDiagnostic[]
        readonly result: Readonly<{
            readonly stackId: EnvironmentBaseline['stackId']
            readonly version: number
            readonly observedAt: string
            readonly snapshotSha256: string
            readonly evidenceSha256: string
            readonly confirmation: string
        }>
    }>
    decide(decision: 'approve' | 'decline'): Promise<BaselineCommandResult>
}

interface HealthEvaluation {
    readonly preflight: PreflightEvaluation
    readonly comparisons: readonly ComparisonRemoteEvaluation[]
    readonly producerFailures: readonly typeof healthProducerNames[number][]
    readonly verdict: PreflightEvaluation['verdict']
}

interface PreparedHealthObservation {
    readonly configPath: string
    readonly preflight: PreflightContext
    readonly comparisons: readonly ComparisonRemoteInput[]
    readonly producers: HealthObservationProducers
    readonly refreshPreflight: (previous: PreflightContext) => Promise<PreflightContext | undefined>
    readonly expectedPreflight: Readonly<{ stackId: StackId; source: string; revision: string }>
}

const issuedHealthObservationSources = new WeakMap<object, PreparedHealthObservation>()

const healthProducerNames = Object.freeze([
    'claims', 'git', 'host', 'installs', 'lifecycle', 'ports', 'runtime', 'state', 'templates',
    'generated', 'data', 'external', 'envSchema',
] as const)

function applicationDiagnostic(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
    fix?: string,
): EnvironmentDiagnostic {
    return Object.freeze({ severity: 'error', code, message, target, ...(fix === undefined ? {} : { fix }) })
}

function comparisonVerdict(result: ComparisonRemoteResult): PreflightEvaluation['verdict'] {
    if (result.kind === 'complete') return result.state === 'mismatch' ? 'fail' : 'pass'
    return result.kind === 'unavailable' ? 'unavailable' : 'pass'
}

function combinedVerdict(
    preflight: PreflightEvaluation['verdict'],
    comparisons: readonly ComparisonRemoteEvaluation[],
): PreflightEvaluation['verdict'] {
    const verdicts = [preflight, ...comparisons.map(({ result }) => comparisonVerdict(result))]
    return verdicts.includes('fail') ? 'fail' : verdicts.includes('unavailable') ? 'unavailable' : 'pass'
}

function stageMatches(context: PreflightContext, expected: 'steady' | 'bootstrap'): boolean {
    try {
        return Array.isArray(context.stages) && context.stages.every((authority) => authority.stage === expected)
    } catch {
        return false
    }
}

function exactHealthProducers(value: unknown): HealthObservationProducers | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).length !== healthProducerNames.length) return undefined
        const producers: Partial<Record<typeof healthProducerNames[number], () => Promise<readonly EnvironmentObservation[]>>> = {}
        for (const name of healthProducerNames) {
            const descriptor = descriptors[name]
            if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
            producers[name] = descriptor.value as () => Promise<readonly EnvironmentObservation[]>
        }
        return Object.freeze(producers) as HealthObservationProducers
    } catch {
        return undefined
    }
}

function singleDataElement(value: unknown): unknown {
    try {
        if (!Array.isArray(value)) return undefined
        const keys = Reflect.ownKeys(value)
        const element = Object.getOwnPropertyDescriptor(value, '0')
        const length = Object.getOwnPropertyDescriptor(value, 'length')
        if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')
            || !element || !('value' in element) || !length || !('value' in length) || length.value !== 1) return undefined
        return element.value
    } catch {
        return undefined
    }
}

function exactDataObject(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).length !== keys.length) return undefined
        const captured: Record<string, unknown> = {}
        for (const key of keys) {
            const descriptor = descriptors[key]
            if (!descriptor || !('value' in descriptor)) return undefined
            captured[key] = descriptor.value
        }
        return Object.freeze(captured)
    } catch {
        return undefined
    }
}

function boundPreflightContext(
    value: unknown,
    expected: { readonly stackId: StackId; readonly source: string; readonly revision: string },
): PreflightContext | undefined {
    const context = exactDataObject(value, ['authorities', 'stages'])
    const authority = exactDataObject(singleDataElement(context?.authorities), [
        'stackId', 'evaluatedAt', 'validThrough', 'revision', 'source', 'postures', 'environmentPostures', 'postureRequirements',
    ])
    const stage = exactDataObject(singleDataElement(context?.stages), [
        'stackId', 'stage', 'observedAt', 'validThrough',
    ])
    if (!context || !authority || !stage
        || authority.stackId !== expected.stackId || stage.stackId !== expected.stackId
        || authority.source !== expected.source || authority.revision !== expected.revision
        || stage.stage !== 'steady'
        || typeof authority.evaluatedAt !== 'string' || !isCanonicalTimestamp(authority.evaluatedAt)
        || typeof authority.validThrough !== 'string' || !isCanonicalTimestamp(authority.validThrough)
        || typeof stage.observedAt !== 'string' || !isCanonicalTimestamp(stage.observedAt)
        || typeof stage.validThrough !== 'string' || !isCanonicalTimestamp(stage.validThrough)
        || Date.parse(authority.evaluatedAt) > Date.parse(authority.validThrough)
        || Date.parse(stage.observedAt) < Date.parse(authority.evaluatedAt)
        || Date.parse(stage.observedAt) > Date.parse(authority.validThrough)
        || Date.parse(authority.evaluatedAt) > Date.parse(stage.validThrough)) return undefined
    return value as PreflightContext
}

function confinedPath(root: string, candidate: string): boolean {
    const relation = relative(root, candidate)
    return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

function issueHealthObservationSource(
    rawSource: HealthObservationSourceInput,
): HealthObservationSource | undefined {
    try {
        if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(rawSource)
        const keys = ['checkout', 'configuration', 'preflight', 'env', 'gitExecutable', 'timeoutMs', 'producers', 'refreshPreflight'] as const
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))) return undefined
        const checkout = consumeSetupCheckoutProjection(descriptors.checkout!.value as SetupCheckoutProjection)
        const loaded = consumeEffectiveConfiguration(descriptors.configuration!.value as LoadedConfigProjection)
        const rawPreflight = descriptors.preflight!.value
        const env = exactEnvironment(descriptors.env!.value)
        const executable = resolvedGitExecutable(descriptors.gitExecutable!.value as ResolvedExecutable)
        const timeoutMs = descriptors.timeoutMs!.value
        const producers = exactHealthProducers(descriptors.producers!.value)
        const refreshPreflight = descriptors.refreshPreflight!.value
        if (!checkout || loaded.kind !== 'complete' || !env || !executable || !producers
            || typeof refreshPreflight !== 'function'
            || !sameSource(checkout.source, loaded.source) || checkout.cockpitName !== loaded.config.cockpit.name
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
        ) return undefined
        const resolvedTimeoutMs = timeoutMs as number
        const stack = deriveStackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        const preflight = boundPreflightContext(rawPreflight, {
            stackId: stack,
            source: loaded.source.path,
            revision: loaded.source.sha256,
        })
        if (!preflight) return undefined
        const siblingsRoot = resolve(checkout.mainCheckoutPath, loaded.config.cockpit.siblings_root)
        const comparisons = loaded.config.sibling.map((sibling) => {
            const checkoutRoot = resolve(siblingsRoot, sibling.dir)
            if (!confinedPath(siblingsRoot, checkoutRoot)) throw new TypeError('sibling checkout escapes its configured root')
            return Object.freeze({
                executable,
                checkoutRoot,
                env,
                timeoutMs: resolvedTimeoutMs,
                stackId: stack,
                checkoutId: deriveCheckoutId({ checkoutPath: checkoutRoot }),
                source: `${loaded.source.path}:${sibling.slug}`,
                sibling: sibling.slug,
                acquire: sibling.acquire,
                ...(sibling.remote === undefined ? {} : { declaredRemote: sibling.remote }),
            })
        })
        const prepared = Object.freeze({
            configPath: loaded.source.path,
            preflight,
            comparisons: Object.freeze(comparisons),
            producers,
            refreshPreflight: refreshPreflight as (previous: PreflightContext) => Promise<PreflightContext | undefined>,
            expectedPreflight: Object.freeze({ stackId: stack, source: loaded.source.path, revision: loaded.source.sha256 }),
        })
        const source = Object.freeze({ kind: 'health-observation-source' as const })
        issuedHealthObservationSources.set(source, prepared)
        return source
    } catch {
        return undefined
    }
}

function prepareHealthObservation(
    input: { readonly configPath: string },
    source: HealthObservationSource,
): PreparedHealthObservation | undefined {
    try {
        if (!source || typeof source !== 'object') return undefined
        const prepared = issuedHealthObservationSources.get(source)
        issuedHealthObservationSources.delete(source)
        return prepared && typeof input.configPath === 'string' && resolve(input.configPath) === prepared.configPath
            && stageMatches(prepared.preflight, 'steady')
            ? prepared
            : undefined
    } catch {
        return undefined
    }
}

async function executeObservationStep(
    adapters: ObservationCommandAdapters,
    step: ExecutionStep,
): Promise<Readonly<{ kind: 'complete'; outcome: ExecuteProbeOutcome }> | Readonly<{ kind: 'unavailable' }>> {
    try {
        return Object.freeze({ kind: 'complete', outcome: await adapters.execute(step, {}) })
    } catch {
        return Object.freeze({ kind: 'unavailable' })
    }
}

function comparisonProbeUnavailable(input: ComparisonRemoteInput, probe: string): ComparisonRemoteResult {
    return Object.freeze({
        kind: 'unavailable',
        code: ENVIRONMENT_CODES.GIT_COMPARISON_REMOTE_MISMATCH,
        reason: `${probe} execution is unavailable for sibling ${input.sibling}`,
    })
}

async function observeComparisonRemote(
    input: ComparisonRemoteInput,
    adapters: ObservationCommandAdapters,
): Promise<ComparisonRemoteResult> {
    const applicability = createComparisonRemoteRefStep(input)
    if (applicability.kind === 'not-applicable') return applicability
    const statusStep = createGitObservationStep(input)
    if (!statusStep) return comparisonProbeUnavailable(input, 'Git status probe planning')
    const statusExecution = await executeObservationStep(adapters, statusStep)
    if (statusExecution.kind === 'unavailable') return comparisonProbeUnavailable(input, 'Git status probe')
    const git = observeGit(statusStep, statusExecution.outcome, input)
    const ref = createComparisonRemoteRefStep({ ...input, git })
    if (ref.kind !== 'probe') return ref
    const refExecution = await executeObservationStep(adapters, ref.step)
    if (refExecution.kind === 'unavailable') return comparisonProbeUnavailable(input, 'comparison upstream probe')
    const url = observeComparisonRemoteRef(ref, refExecution.outcome)
    if (url.kind !== 'probe') return url
    const urlExecution = await executeObservationStep(adapters, url.step)
    if (urlExecution.kind === 'unavailable') return comparisonProbeUnavailable(input, 'comparison remote URL probe')
    const revalidation = observeComparisonRemoteUrl(url, urlExecution.outcome)
    if (revalidation.kind !== 'probe') return revalidation
    const revalidationExecution = await executeObservationStep(adapters, revalidation.step)
    if (revalidationExecution.kind === 'unavailable') {
        return comparisonProbeUnavailable(input, 'comparison upstream revalidation probe')
    }
    return observeComparisonRemoteRevalidation(revalidation, revalidationExecution.outcome)
}

async function evaluateApplicationHealth(
    input: PreparedHealthObservation,
    adapters: ObservationCommandAdapters,
): Promise<HealthEvaluation> {
    const produced = await Promise.allSettled(healthProducerNames.map((name) => input.producers[name]()))
    const producerFailures = Object.freeze(healthProducerNames.filter((_, index) => produced[index]?.status === 'rejected'))
    const observations = produced.map((result) => result.status === 'fulfilled'
        ? result.value
        : Object.freeze([]) as readonly EnvironmentObservation[])
    const refreshed = boundPreflightContext(await input.refreshPreflight(input.preflight), input.expectedPreflight)
    if (!refreshed || refreshed.authorities[0]?.evaluatedAt !== input.preflight.authorities[0]?.evaluatedAt) {
        throw new TypeError('health preflight authority could not preserve its observation window')
    }
    const preflight = aggregateObservations(observations, refreshed)
    const comparisons: ComparisonRemoteEvaluation[] = []
    for (const comparisonInput of input.comparisons) {
        const result = await observeComparisonRemote(comparisonInput, adapters)
        comparisons.push(Object.freeze({ sibling: comparisonInput.sibling, result }))
    }
    const frozenComparisons = Object.freeze(comparisons)
    const observedVerdict = combinedVerdict(preflight.verdict, frozenComparisons)
    return Object.freeze({
        preflight,
        comparisons: frozenComparisons,
        producerFailures,
        verdict: producerFailures.length > 0 && observedVerdict === 'pass' ? 'unavailable' : observedVerdict,
    })
}

function healthDiagnostics(health: HealthEvaluation): readonly EnvironmentDiagnostic[] {
    const checks = health.preflight.checks
        .filter(({ verdict }) => verdict === 'fail' || verdict === 'unavailable')
        .map(({ code, reason, source, remedy }) => applicationDiagnostic(code, reason, source, remedy))
    const comparisons = health.comparisons.flatMap(({ sibling, result }) => {
        if ((result.kind === 'complete' && result.state === 'match') || result.kind === 'not-applicable') return []
        return [applicationDiagnostic(
            result.code,
            result.reason,
            sibling,
            'set the sibling remote to the repository selected by its configured upstream',
        )]
    })
    const producerFailures = health.producerFailures.map((producer) => applicationDiagnostic(
        ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
        `${producer} observation producer failed`,
        producer,
        `restore the ${producer} observation producer`,
    ))
    // Varlock is optional for cockpit, so a sibling that adopted it but cannot be checked here warns
    // instead of failing the row.
    const advisories = health.preflight.checks.flatMap((check) => envSchemaToolMissing(check).map((sibling): EnvironmentDiagnostic => Object.freeze({
        severity: 'warning',
        code: ENVIRONMENT_CODES.ENV_SCHEMA_TOOL_MISSING,
        message: `sibling ${sibling} has an .env.schema but varlock is not installed, so its env schema was not checked`,
        target: sibling,
        fix: `install Varlock (${VARLOCK_INSTALL_URL}) and put it on PATH`,
    })))
    return Object.freeze([...checks, ...advisories, ...producerFailures, ...comparisons])
}

const unavailableSurfaceOverrideInspection = Object.freeze({
    kind: 'unavailable' as const,
    code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
    reason: 'authenticated generated surface override inspection is unavailable',
})

async function inspectDoctorSurfaceOverrides(
    configPath: string,
    adapters: DoctorCommandAdapters,
): Promise<DoctorSurfaceOverrideInspection> {
    if (!adapters.inspectSurfaceOverrides) return unavailableSurfaceOverrideInspection
    try {
        const inspection = await adapters.inspectSurfaceOverrides(configPath)
        const captured = snapshotJson(inspection)
        const record = ownDataValues(captured, ['kind'], ['activeOverrides', 'changedOverrideOriginals', 'code', 'reason'])
        const sha256 = /^[a-f0-9]{64}$/
        const activeOverride = (value: unknown): boolean => {
            const row = ownDataValues(value, ['name', 'feature', 'originalSha256', 'recordedSha256', 'overlaySource'])
            return row !== undefined
                && typeof row.name === 'string' && row.name.length > 0
                && typeof row.feature === 'string' && SURFACE_FEATURES.includes(row.feature as never)
                && typeof row.originalSha256 === 'string' && sha256.test(row.originalSha256)
                && typeof row.recordedSha256 === 'string' && sha256.test(row.recordedSha256)
                && typeof row.overlaySource === 'string' && row.overlaySource.length > 0
        }
        const changedOriginal = (value: unknown): boolean => {
            const row = ownDataValues(value, ['code', 'name', 'recordedSha256', 'currentSha256', 'overlaySource'])
            return row !== undefined && row.code === 'OVERRIDDEN_CORE_CHANGED'
                && typeof row.name === 'string' && row.name.length > 0
                && typeof row.recordedSha256 === 'string' && sha256.test(row.recordedSha256)
                && typeof row.currentSha256 === 'string' && sha256.test(row.currentSha256)
                && typeof row.overlaySource === 'string' && row.overlaySource.length > 0
        }
        const complete = record?.kind === 'complete'
            && Reflect.ownKeys(record).length === 3
            && Array.isArray(record.activeOverrides) && record.activeOverrides.every(activeOverride)
            && Array.isArray(record.changedOverrideOriginals) && record.changedOverrideOriginals.every(changedOriginal)
        const unavailableOrRefusal = (record?.kind === 'unavailable' || record?.kind === 'refusal')
            && Reflect.ownKeys(record).length === 3
            && typeof record.code === 'string' && record.code.length > 0
            && typeof record.reason === 'string' && record.reason.length > 0
        if (!complete && !unavailableOrRefusal) {
            return Object.freeze({
                kind: 'refusal',
                code: 'SURFACE_OVERRIDE_INSPECTION_INVALID',
                reason: 'surface override inspection returned invalid evidence',
            })
        }
        return captured as unknown as DoctorSurfaceOverrideInspection
    } catch {
        return unavailableSurfaceOverrideInspection
    }
}

function unavailableDoctor(
    code: EnvironmentDiagnostic['code'],
    message: string,
    surfaceOverrides: DoctorSurfaceOverrideInspection,
    freshness: DoctorFreshness,
    declarations: readonly DoctorDeclaration[],
    forwarded?: readonly EnvironmentDiagnostic[],
): DoctorCommandResult {
    return Object.freeze({
        kind: 'complete', status: 0,
        diagnostics: forwarded ?? Object.freeze([applicationDiagnostic(code, message, 'preflight')]),
        result: Object.freeze({
            verdict: 'unavailable', checks: Object.freeze([]), comparisons: Object.freeze([]), surfaceOverrides, freshness, declarations,
        }),
    })
}

function unavailablePreflight(message: string, forwarded?: readonly EnvironmentDiagnostic[]): PreflightCommandResult {
    return Object.freeze({
        kind: 'blocked', status: 2,
        diagnostics: forwarded ?? Object.freeze([applicationDiagnostic(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            message,
            'preflight',
        )]),
        result: Object.freeze({
            verdict: 'unavailable', revision: '', checks: Object.freeze([]), comparisons: Object.freeze([]),
        }),
    })
}

export async function runPreflight(
    input: PreflightCommandInput,
    adapters: PreflightCommandAdapters,
): Promise<PreflightCommandResult> {
    let health: HealthEvaluation
    try {
        let refused: readonly EnvironmentDiagnostic[] | undefined
        const source = await adapters.load(input, issueHealthObservationSource, (diagnostics) => { refused = diagnostics; return undefined })
        if (!source) return unavailablePreflight('preflight observation source is unavailable', refused)
        const observed = prepareHealthObservation(input, source)
        if (!observed) return unavailablePreflight('preflight requires authenticated steady lifecycle evidence')
        health = await evaluateApplicationHealth(observed, adapters)
    } catch {
        return unavailablePreflight('preflight requires authentic observation and lifecycle evidence')
    }
    const result = Object.freeze({
        verdict: health.verdict,
        revision: health.preflight.revision,
        checks: health.preflight.checks,
        comparisons: health.comparisons,
    })
    return Object.freeze({
        kind: health.verdict === 'pass' ? 'complete' : 'blocked',
        status: health.verdict === 'pass' ? 0 : 2,
        diagnostics: healthDiagnostics(health),
        result,
    }) as PreflightCommandResult
}

export async function runDoctor(
    input: DoctorCommandInput,
    adapters: DoctorCommandAdapters,
): Promise<DoctorCommandResult> {
    const config = loadCockpitConfig(input.configPath)
    const [outcome, guardHosts] = await Promise.all([doctorHealth(input, adapters, config), doctorGuardHostDiagnostics(config)])
    return guardHosts.length === 0 ? outcome
        : Object.freeze({ ...outcome, diagnostics: Object.freeze([...outcome.diagnostics, ...guardHosts]) })
}

async function doctorHealth(
    input: DoctorCommandInput,
    adapters: DoctorCommandAdapters,
    config: Promise<LoadedDoctorConfig>,
): Promise<DoctorCommandResult> {
    const surfaceOverrides = inspectDoctorSurfaceOverrides(input.configPath, adapters)
    const declarations = doctorDeclarations(config)
    const freshness = Promise.all([
        prepareGeneratedEnvironmentCurrentness(input),
        adapters.discoverReleaseFreshness?.() ?? Promise.resolve(Object.freeze({ kind: 'unknown' as const, reason: 'release discovery is not bound' })),
    ]).then(([currentness, release]): DoctorFreshness => Object.freeze({
        local: currentness.outcome, changes: currentness.changes, storedProducer: currentness.storedProducer,
        installedProducer: currentness.currentProducer, release, repair: proposeGeneratedEnvironmentRepair(currentness),
    }))
    let health: HealthEvaluation
    let doctor: ReturnType<typeof projectDoctor>
    try {
        let refused: readonly EnvironmentDiagnostic[] | undefined
        const source = await adapters.load(input, issueHealthObservationSource, (diagnostics) => { refused = diagnostics; return undefined })
        if (!source) {
            return unavailableDoctor(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'doctor observation source is unavailable',
                await surfaceOverrides,
                await freshness,
                await declarations,
                refused,
            )
        }
        const observed = prepareHealthObservation(input, source)
        if (!observed) {
            return unavailableDoctor(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'doctor requires authenticated steady lifecycle evidence',
                await surfaceOverrides,
                await freshness,
                await declarations,
            )
        }
        health = await evaluateApplicationHealth(observed, adapters)
        doctor = projectDoctor(health.preflight)
    } catch {
        return unavailableDoctor(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'doctor requires authentic observation and lifecycle evidence',
            await surfaceOverrides,
            await freshness,
            await declarations,
        )
    }
    return Object.freeze({
        kind: 'complete', status: 0, diagnostics: healthDiagnostics(health),
        result: Object.freeze({
            verdict: health.verdict,
            checks: doctor.checks,
            comparisons: health.comparisons,
            surfaceOverrides: await surfaceOverrides,
            freshness: await freshness,
            declarations: await declarations,
        }),
    })
}

function logsRefusal(code: EnvironmentDiagnostic['code'], message: string): Extract<LogsCommandResult, { kind: 'refusal' }> {
    return Object.freeze({
        kind: 'refusal', status: 2, result: null,
        diagnostics: Object.freeze([applicationDiagnostic(code, message, 'logs')]),
    })
}

function ownDataValues(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = Object.freeze([]),
): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const actual = Reflect.ownKeys(descriptors)
        if (actual.some((key) => typeof key !== 'string')
            || required.some((key) => !descriptors[key])
            || actual.some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) {
            return undefined
        }
        const captured: Record<string, unknown> = {}
        for (const key of actual as string[]) {
            const descriptor = descriptors[key]
            if (!descriptor || !('value' in descriptor)) return undefined
            captured[key] = descriptor.value
        }
        return Object.freeze(captured)
    } catch {
        return undefined
    }
}

const logRequestBaseKeys = Object.freeze([
    'runtime', 'executable', 'cwd', 'stackId', 'configSha256', 'batchId', 'containerId',
    'runtimeVersion', 'composeVersion', 'projectName', 'composeFiles', 'services', 'service',
    'timeoutMs', 'outputLimitBytes', 'env',
] as const)
const logService = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const relativeLogSince = /^\d+(?:\.\d+)?[smhd]$/
const absoluteLogSince = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/

function validAbsoluteLogSince(value: string): boolean {
    const match = absoluteLogSince.exec(value)
    if (!match) return false
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
    if (Number.isNaN(calendar.valueOf()) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month
        || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute
        || calendar.getUTCSeconds() !== second) return false
    const offsetHour = match[8] === 'Z' ? 0 : Number(match[10])
    const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11])
    return offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0)
        && Number.isFinite(Date.parse(value))
}

function validPublicLogOptions(service: string, since: string, tail: number): boolean {
    return logService.test(service) && since.length <= 64
        && (relativeLogSince.test(since) || validAbsoluteLogSince(since))
        && Number.isInteger(tail) && tail >= 1 && tail <= 10_000
}

function logsCancelled(json: boolean): Extract<LogsCommandResult, { kind: 'cancelled' }> {
    return Object.freeze({
        kind: 'cancelled', status: 130, diagnostics: Object.freeze([]),
        result: Object.freeze({ json, records: Object.freeze([]) }),
    })
}

export async function runLogs(
    input: LogsCommandInput,
    adapters: LogsCommandAdapters,
): Promise<LogsCommandResult> {
    let captured: Readonly<Record<string, unknown>> | undefined
    let signal: AbortSignal | undefined
    let observe: LogsCommandAdapters['observe']
    let execute: LogsCommandAdapters['execute']
    try {
        captured = ownDataValues(input, ['configPath', 'service', 'since', 'tail', 'follow', 'json'])
        signal = adapters.signal
        observe = adapters.observe
        execute = adapters.execute
    } catch {
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'log request must be readable')
    }
    const configPath = captured?.configPath
    const service = captured?.service
    const since = captured?.since
    const tail = captured?.tail
    const follow = captured?.follow
    const json = captured?.json
    if (typeof configPath !== 'string' || typeof service !== 'string' || typeof since !== 'string'
        || typeof tail !== 'number' || typeof follow !== 'boolean' || typeof json !== 'boolean'
        || typeof observe !== 'function' || typeof execute !== 'function') {
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'log request must contain exact public options')
    }
    if (!validPublicLogOptions(service, since, tail)) {
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'log service, time range, and tail must be valid and bounded')
    }
    if (follow && signal === undefined) {
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'follow logs require a cancellation signal')
    }
    if (signal?.aborted) return logsCancelled(json)
    let observation: LogObservation
    try {
        observation = await observe(Object.freeze({ configPath, service }))
    } catch (error) {
        if (signal?.aborted) return logsCancelled(json)
        if (error instanceof RuntimeNotDeclaredError) return Object.freeze({ kind: 'refusal', status: 2, result: null,
            diagnostics: Object.freeze([error.diagnostic]) })
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, `log observation is unavailable for service ${service}`)
    }
    if (signal?.aborted) return logsCancelled(json)
    const observed = ownDataValues(observation, ['request'], ['restart', 'generatedComposeAuthority'])
    const request = ownDataValues(observed?.request, logRequestBaseKeys, ['restartBatches'])
    if (!request || request.service !== service) {
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, `log observation does not match service ${service}`)
    }
    const resolvedRequest = Object.freeze({ ...request, since, tail, follow }) as unknown as LogRequest
    const plan = planLogs(resolvedRequest, observed?.generatedComposeAuthority as GeneratedComposeArtifactAuthority | undefined)
    if (plan.kind !== 'planned') return logsRefusal(plan.code, plan.reason)
    let collected: Awaited<ReturnType<typeof collectLogs>>
    try {
        collected = await collectLogs(plan, execute, signal, observed?.restart as RestartWindow | undefined)
    } catch {
        return logsRefusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, `log collection failed for service ${service}`)
    }
    if (collected.kind === 'unavailable') {
        return logsRefusal(collected.code, 'authenticated log collection is unavailable')
    }
    if (collected.kind === 'cancelled') return Object.freeze({
        kind: 'cancelled', status: 130, diagnostics: Object.freeze([]),
        result: Object.freeze({ json, records: collected.records }),
    })
    return Object.freeze({
        kind: 'complete', status: 0, diagnostics: Object.freeze([]),
        result: Object.freeze({ json, records: collected.records }),
    })
}

export async function runBaselineRecord(
    input: BaselineCommandInput,
    adapters: BaselineCommandAdapters,
): Promise<BaselineCommandResult> {
    const captured = ownDataValues(input, ['configPath', 'confirmation', 'recordedAt'])
    const configPath = captured?.configPath
    const confirmation = captured?.confirmation
    const recordedAt = captured?.recordedAt
    if (typeof configPath !== 'string' || typeof confirmation !== 'string' || typeof recordedAt !== 'string') {
        return Object.freeze({
            kind: 'refusal', status: 2, result: null,
            diagnostics: Object.freeze([applicationDiagnostic(
                ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                'baseline request must contain exact public options',
                'environment-baseline',
            )]),
        })
    }
    let observed: BaselineObservation
    try {
        observed = await adapters.observe(Object.freeze({ configPath }))
    } catch {
        return Object.freeze({
            kind: 'refusal', status: 2, result: null,
            diagnostics: Object.freeze([applicationDiagnostic(
                ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                'baseline evidence observation is unavailable',
                'environment-baseline',
            )]),
        })
    }
    const evidence = ownDataValues(observed, ['snapshot', 'evidence'], ['previous'])
    if (!evidence) {
        return Object.freeze({
            kind: 'refusal', status: 2, result: null,
            diagnostics: Object.freeze([applicationDiagnostic(
                ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                'baseline evidence observation must be readable',
                'environment-baseline',
            )]),
        })
    }
    try {
        const current = await adapters.revalidate(observed)
        if (current !== observed) return baselineOperatorRefusal('baseline evidence changed after confirmation')
    } catch (error) {
        return baselineOperatorRefusal(baselineRevalidationMessage(error))
    }
    const admitted = recordEnvironmentBaseline(Object.freeze({
        snapshot: evidence.snapshot as EnvironmentSnapshot,
        evidence: evidence.evidence as CapturedRuntimeEvidence,
        confirmation,
        recordedAt,
        ...(evidence.previous === undefined ? {} : { previous: evidence.previous as EnvironmentBaseline }),
    }))
    if (admitted.kind !== 'complete') return admitted
    try {
        await adapters.write(admitted.result)
        return admitted
    } catch {
        return Object.freeze({
            kind: 'refusal', status: 2, result: null,
            diagnostics: Object.freeze([applicationDiagnostic(
                ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                'environment baseline durability is indeterminate',
                admitted.result.stackId,
            )]),
        })
    }
}

export async function beginOperatorBaselineRecord(
    input: Pick<BaselineCommandInput, 'configPath'>,
    adapters: BaselineCommandAdapters,
): Promise<OperatorBaselineSession | Extract<BaselineCommandResult, { kind: 'refusal' }>> {
    const captured = ownDataValues(input, ['configPath'])
    if (typeof captured?.configPath !== 'string') {
        return baselineOperatorRefusal('baseline request must contain exact public options')
    }
    let observation: BaselineObservation
    try {
        observation = await adapters.observe(Object.freeze({ configPath: captured.configPath }))
    } catch {
        return baselineOperatorRefusal('baseline evidence observation is unavailable')
    }
    const observed = ownDataValues(observation, ['snapshot', 'evidence'], ['previous'])
    if (!observed) return baselineOperatorRefusal('baseline evidence observation must be readable')
    const snapshot = snapshotJson(observed.snapshot) as EnvironmentSnapshot | undefined
    const evidence = snapshotJson(observed.evidence) as CapturedRuntimeEvidence | undefined
    const previous = observed.previous === undefined
        ? undefined : snapshotJson(observed.previous) as EnvironmentBaseline | undefined
    if (!snapshot || !evidence || observed.previous !== undefined && !previous) {
        return baselineOperatorRefusal('baseline evidence observation must be readable')
    }
    const confirmation = environmentBaselineConfirmation(snapshot, evidence, previous)
    if (!confirmation) return baselineOperatorRefusal('baseline evidence cannot be confirmed')
    let pending = true
    return Object.freeze({
        preview: Object.freeze({
            kind: 'preview' as const, status: 0 as const, diagnostics: Object.freeze([]),
            result: Object.freeze({
                stackId: snapshot.stackId, version: (previous?.version ?? 0) + 1,
                observedAt: evidence.observedAt,
                snapshotSha256: snapshot.snapshotSha256,
                evidenceSha256: evidence.evidenceSha256, confirmation,
            }),
        }),
        decide: async (decision: 'approve' | 'decline'): Promise<BaselineCommandResult> => {
            if (!pending || decision !== 'approve') {
                pending = false
                return baselineOperatorRefusal(decision === 'decline' ? 'baseline recording was declined' : 'baseline operator session is unavailable')
            }
            pending = false
            try {
                const current = await adapters.revalidate(observation)
                if (current !== observation) return baselineOperatorRefusal('baseline evidence changed after confirmation')
            } catch (error) {
                return baselineOperatorRefusal(baselineRevalidationMessage(error))
            }
            const admitted = recordEnvironmentBaseline(Object.freeze({
                snapshot, evidence, confirmation, recordedAt: new Date().toISOString(),
                ...(previous === undefined ? {} : { previous }),
            }))
            if (admitted.kind !== 'complete') return admitted.kind === 'refusal'
                ? admitted : baselineOperatorRefusal('baseline evidence cannot be admitted')
            const baseline = admitted.result
            try {
                await adapters.write(baseline)
                return admitted
            } catch {
                return Object.freeze({
                    kind: 'refusal', status: 2, result: null,
                    diagnostics: Object.freeze([applicationDiagnostic(
                        ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                        'environment baseline durability is indeterminate', baseline.stackId,
                    )]),
                })
            }
        },
    })
}

function baselineRevalidationMessage(error: unknown): string {
    const message = error instanceof TypeError ? error.message : ''
    return [
        'baseline config source changed',
        'baseline runtime topology changed',
        'baseline runtime cohort changed',
        'baseline previous baseline changed',
        'baseline runtime stability changed',
    ].includes(message) ? message : 'baseline evidence changed after confirmation'
}

function baselineOperatorRefusal(message: string): Extract<BaselineCommandResult, { kind: 'refusal' }> {
    return Object.freeze({
        kind: 'refusal', status: 2, result: null,
        diagnostics: Object.freeze([applicationDiagnostic(
            ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, message, 'environment-baseline',
        )]),
    })
}
