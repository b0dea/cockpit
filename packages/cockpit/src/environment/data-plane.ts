import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isProxy } from 'node:util/types'
import { GeneratedEnvironment, type DataMode, type GeneratedEnvironment as GeneratedEnvironmentDeclaration, type Provenance } from '../schema.js'
import { consumeLoadedConfigProjection, type LoadedConfigProjection } from '../config/load.js'
import { formatShellCommand } from '../fix-catalogue.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    inStackCommand,
    isCanonicalTimestamp,
    snapshotEnvironmentObservation,
    snapshotJson,
    snapshotExecutionPlan,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type ExecutionPlan,
    type ExecutionStep,
    type HolderId,
    type StackId,
} from './contract.js'
import {
    consumeRestoreExecutionAuthority,
    issueRestoreExecutionAuthority,
    settleRestoreExecutionAuthority,
    type RestoreExecutionLease,
} from './claims.js'
import { authenticateStateNamespace, readState, transactState, type StateNamespace, type StateRecord } from './state.js'
import { inspectGeneratedRuntimeAuthority, resolveGeneratedDataOperation, type GeneratedRuntimeAuthority } from './generated-stack.js'
import { composeProcessEnvironment } from './compose-environment.js'
import { projectRuntimeExecutionEnvironment } from './runtime.js'

export const mechanism = {
    id: 'environment-data-plane',
    module: 'packages/cockpit/src/environment/data-plane.ts',
    exports: ['planDataMode', 'executeDataMode', 'isDataModeCompletion', 'readDataModeOutcome', 'consumeDataModeOutcomeProjection', 'projectDataModeObservationSteps', 'observeDataMode', 'isDataModeObservation', 'projectPersonaOutputs', 'observationDeclarations'],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'data-mode', owner: mechanism.id, postures: ['data-plane'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.DATA_MODE_UNAVAILABLE, isIssued: isDataModeObservation, issuedAt: dataModeObservationIssuedAt },
] as const)

type DataDeclaration = NonNullable<GeneratedEnvironmentDeclaration['data']>
type FixtureDeclaration = NonNullable<DataDeclaration['fixtures']>
type DataOperation = DataDeclaration['modes'][number]['operations'][number]
type OverlayOperation = DataOperation['operation']

export interface DataStepContext {
    readonly id: string
    readonly phase: 'prerequisite' | 'operation' | 'probe' | 'restore-rewrite' | 'fixture-volume-operation' | 'fixture-volume-probe'
    readonly operationId?: string
    readonly operationKind?: DataOperation['kind']
    readonly after?: readonly string[]
    readonly provenance?: Readonly<{ source: string; reason: string }>
}

export interface DataModePlan {
    readonly mode: DataMode
    readonly execution: ExecutionPlan
    readonly steps: readonly Readonly<{
        id: string
        phase: DataStepContext['phase']
        operationId?: string
        operationKind?: DataOperation['kind']
        freshVolumeOnly: boolean
        after?: readonly string[]
        provenance?: Readonly<{ source: string; reason: string }>
    }>[]
    // Absent when the declaration has no fixtures: a stack without a seeded mode has no fixture volume.
    readonly fixtureVolume?: Readonly<{ included: boolean; tag: string; warning: string }>
}

interface PlannedContract {
    readonly mode: DataMode
    readonly execution: ExecutionPlan
    readonly steps: DataModePlan['steps']
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly configPath: string
    readonly configSha256: string
    readonly generation: string
    readonly observedAt: string
    readonly issuedAtMs: number
    readonly dataVolume: string
    readonly fixtures?: Readonly<{
        stableKey: string
        randomSeed?: string
        provenance: Provenance
        volume: NonNullable<DataModePlan['fixtureVolume']>
    }>
    readonly rewired: readonly string[]
    readonly untouched: readonly string[]
}

export type DataModePlanResult =
    | { readonly kind: 'preview'; readonly plan: DataModePlan }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

type DataStepAttempt = Readonly<{
    id: string
    code: string
    exitCode: number
    signal: NodeJS.Signals | null
    startedAt?: string
    finishedAt?: string
}>

export type DataModeExecutionResult =
    | {
          readonly kind: 'complete'
          readonly mode: DataMode
          readonly applied: readonly string[]
          // The fixture identity fields are present exactly when fixtures are declared.
          readonly stableKeySha256?: string
          readonly randomSeedSha256?: string
          readonly fixtureProvenanceSha256?: string
          readonly fixtureVolume?: DataModePlan['fixtureVolume']
          readonly restore: Readonly<{ rewired: readonly string[]; untouched: readonly string[] }>
      }
    | {
          readonly kind: 'refusal'
          readonly mode: DataMode
          readonly applied: readonly string[]
          readonly notApplied: readonly string[]
          readonly attempted: readonly DataStepAttempt[]
          readonly diagnostics: readonly EnvironmentDiagnostic[]
      }

export interface DataModeOutcomeProjection { readonly kind: 'data-mode-outcome-projection' }

export interface DataModeOutcomeEnvelope {
    readonly stackId: StackId
    readonly configSha256: string
    readonly generation: string
    readonly mode: DataMode
    readonly outcome: DataModeExecutionResult
    readonly observedAt: string
}

export interface PersonaProjection {
    readonly source: Readonly<{ path: string; sha256: string }>
    readonly outputs: readonly Readonly<{ path: string; format: 'json' | 'typescript'; reason: string; bytesBase64: string; sha256: string }>[]
}

const issuedPlans = new WeakMap<object, PlannedContract>()
const issuedCompletions = new WeakMap<object, Readonly<{
    stackId: StackId
    configSha256: string
    generation: string
    mode: DataMode
    observedAt: string
}>>()
const issuedOutcomeProjections = new WeakMap<object, DataModeOutcomeEnvelope>()
const issuedDataModeObservations = new WeakMap<object, number>()
const sha256Identity = /^[a-f0-9]{64}$/
const stackIdentity = /^stack:[a-f0-9]{64}$/
const holderIdentity = /^holder:[a-f0-9]{64}:session$/
const canonicalExecutionEnvironment = Object.freeze({})

function dataModeObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedDataModeObservations.get(value) : undefined
}

function diagnostic(code: EnvironmentDiagnostic['code'], message: string, target: string, fix?: string): EnvironmentDiagnostic {
    return Object.freeze({ severity: 'error', code, message, target, ...(fix ? { fix } : {}) })
}

function refusal(message: string, target: string, fix?: string): DataModePlanResult {
    return Object.freeze({
        kind: 'refusal',
        diagnostics: Object.freeze([diagnostic(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, message, target, fix)]),
    })
}

function inside(root: string, path: string): boolean {
    const offset = relative(root, path)
    return offset === '' || offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset)
}

function operationDigest(operation: OverlayOperation): string {
    return createHash('sha256').update(JSON.stringify(operation)).digest('hex')
}

function stepDigest(step: ExecutionStep): string {
    return createHash('sha256').update(JSON.stringify(step)).digest('hex')
}

function observedFreshVolume(outcome: Extract<ExecuteProbeOutcome, { kind: 'complete' }>, volume: string, generation: string): boolean {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout)
        const value = JSON.parse(text) as unknown
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
        const record = value as Record<string, unknown>
        return Object.keys(record).sort().join('\0') === 'generation\0state\0volume'
            && record.volume === volume && record.state === 'empty'
            && typeof record.generation === 'string' && sha256Identity.test(record.generation)
            && record.generation === generation
    } catch {
        return false
    }
}

function exactComposePrefix(argv: readonly string[], checkoutRoot: string): boolean {
    if (argv.length < 6 || argv[1] !== 'compose' || argv[2] !== '--project-directory'
        || argv[3] !== checkoutRoot) return false
    const projectIndex = argv.indexOf('--project-name', 4)
    const projectName = argv[projectIndex + 1]
    if (projectIndex < 6 || typeof projectName !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(projectName)) return false
    const fileArgs = argv.slice(4, projectIndex)
    if (fileArgs.length % 2 !== 0) return false
    for (let index = 0; index < fileArgs.length; index += 2) {
        const path = fileArgs[index + 1]
        if (fileArgs[index] !== '--file' || path === undefined || !isAbsolute(path) || !inside(checkoutRoot, path)) return false
    }
    const profileArgs = argv.slice(projectIndex + 2)
    if (profileArgs.length % 2 !== 0) return false
    const profiles = []
    for (let index = 0; index < profileArgs.length; index += 2) {
        const profile = profileArgs[index + 1]
        if (profileArgs[index] !== '--profile' || typeof profile !== 'string'
            || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(profile)) return false
        profiles.push(profile)
    }
    return new Set(profiles).size === profiles.length
}

function hasBoundExecutable(step: ExecutionStep): boolean {
    return step.consumedFiles.some((file) => file.executable && file.path === step.argv[0]
        && file.argvIndexes.length === 1 && file.argvIndexes[0] === 0)
}

function hasLeafOwnedExecutionMetadata(step: ExecutionStep): boolean {
    return Reflect.ownKeys(step.env).length === 0 && Reflect.ownKeys(step.labels).length === 0
}

function freezeStep(step: ExecutionStep): ExecutionStep {
    return Object.freeze({
        ...step,
        argv: Object.freeze([...step.argv]) as readonly [string, ...string[]],
        env: Object.freeze({ ...step.env }), paths: Object.freeze([...step.paths]), ports: Object.freeze([...step.ports]),
        labels: Object.freeze({ ...step.labels }), expected: Object.freeze(step.expected.map((value) => Object.freeze({ ...value }))),
        consumedFiles: Object.freeze(step.consumedFiles.map((value) => Object.freeze({ ...value, argvIndexes: Object.freeze([...value.argvIndexes]) }))),
        filesystemChecks: Object.freeze(step.filesystemChecks.map((value) => Object.freeze({
            ...value,
            ...(value.identity === undefined ? {} : {
                identity: Object.freeze({
                    ...value.identity,
                    ancestors: Object.freeze(value.identity.ancestors.map((ancestor) => Object.freeze({ ...ancestor }))),
                }),
            }),
        }))),
        compensation: Object.freeze(step.compensation.map(freezeStep)),
    })
}

interface DataModePlanInput {
    readonly environment: unknown
    readonly mode: DataMode
    readonly checkoutRoot: string
    readonly includeFixtureVolume: boolean
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly configuration: LoadedConfigProjection
    readonly generation: string
    readonly observedAt: string
    readonly runtimeAuthority?: GeneratedRuntimeAuthority
    readonly resolve: (operation: OverlayOperation, context: DataStepContext) => ExecutionStep
}

function capturePlanInput(input: DataModePlanInput): DataModePlanInput | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const expected = [
            'environment', 'mode', 'checkoutRoot', 'includeFixtureVolume',
            'namespace', 'stackId', 'holderId', 'configuration', 'generation', 'observedAt', 'resolve',
        ]
        if (Object.hasOwn(descriptors, 'runtimeAuthority')) expected.push('runtimeAuthority')
        if (Reflect.ownKeys(descriptors).length !== expected.length
            || expected.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return undefined
        return Object.freeze(Object.fromEntries(expected.map((key) => [key, descriptors[key]!.value]))) as unknown as DataModePlanInput
    } catch { return undefined }
}

export function planDataMode(input: DataModePlanInput): DataModePlanResult {
    const captured = capturePlanInput(input)
    if (!captured) return refusal('data planning input is malformed', 'data planning input')
    input = captured
    const namespace = authenticateStateNamespace(input.namespace)
    const configuration = consumeLoadedConfigProjection(input.configuration)
    let parsed: GeneratedEnvironmentDeclaration
    try {
        parsed = GeneratedEnvironment.parse(snapshotJson(input.environment))
    } catch {
        return refusal('generated environment data declaration is malformed', 'generated environment')
    }
    if (!isAbsolute(input.checkoutRoot) || resolve(input.checkoutRoot) !== input.checkoutRoot
        || typeof input.includeFixtureVolume !== 'boolean'
        || !namespace || !stackIdentity.test(input.stackId) || !holderIdentity.test(input.holderId)
        || !configuration || !sha256Identity.test(configuration.source.sha256)
        || !sha256Identity.test(input.generation) || !isCanonicalTimestamp(input.observedAt)
        || typeof input.resolve !== 'function') {
        return refusal('data planning input is malformed', 'data planning input')
    }
    if (!configuration.config.environment.generated
        || !isDeepStrictEqual(snapshotJson(parsed), snapshotJson(configuration.config.environment.generated))) {
        return refusal('generated environment data declaration does not match the authenticated configuration', 'generated environment')
    }
    const runtime = input.runtimeAuthority === undefined ? undefined : inspectGeneratedRuntimeAuthority(input.runtimeAuthority)
    const runtimeEnvironment = runtime && projectRuntimeExecutionEnvironment(runtime.topology, input.namespace)
    if (input.runtimeAuthority !== undefined && (!runtime
        || !runtimeEnvironment || !isDeepStrictEqual(runtimeEnvironment, runtime.runtime.publicEnv)
        || runtime.runtime.root !== input.checkoutRoot || dirname(configuration.source.path) !== input.checkoutRoot
        || runtime.stackId !== input.stackId || runtime.sourceSha256 !== configuration.source.sha256
        || runtime.generation !== input.generation
        || runtime.runtime.publicEnv.COCKPIT_OWNER_ID !== namespace.paths.coordination(input.stackId).cockpitId
        || !isDeepStrictEqual(snapshotJson(runtime.declaration), snapshotJson(parsed)))) {
        return refusal('generated data runtime authority does not match this checkout, coordination namespace, stack, configuration and generation; data work could target another runtime',
            'generated data runtime', formatShellCommand(['./node_modules/.bin/cockpit', 'up', '--config', configuration.source.path]))
    }
    const data = parsed.data
    if (!data) return refusal('the generated environment declares no data modes', 'environment.generated.data')
    const selected = data.modes.find(({ mode }) => mode === input.mode)
    if (!selected) return refusal('selected data mode is not declared', String(input.mode))
    const planId = randomBytes(32).toString('hex')
    const metadata: Array<DataModePlan['steps'][number]> = []
    const steps: ExecutionStep[] = []
    const append = (
        operation: OverlayOperation,
        context: DataStepContext,
        freshVolumeOnly: boolean,
    ): boolean => {
        let resolvedStep: ExecutionStep
        try { resolvedStep = input.resolve(operation, Object.freeze({ ...context })) } catch { return false }
        const execution = snapshotExecutionPlan({ steps: [resolvedStep] })?.steps[0]
        if (!execution) return false
        // Runtime variables must never be attached to a resolver-selected executable or Compose project.
        if (operation.location === 'in-stack' && (!runtime || !input.runtimeAuthority
            || !isDeepStrictEqual(execution, resolveGeneratedDataOperation({ authority: input.runtimeAuthority, operation, context })))) return false
        const declaredArgv = operation.argv
        const declaredCwd = resolve(input.checkoutRoot, operation.cwd)
        const exactHostCommand = operation.location === 'host'
            && execution.argv.length === declaredArgv.length
            && execution.argv.every((value, index) => value === declaredArgv[index])
            && execution.argv0 === declaredArgv[0]
            && execution.cwd === declaredCwd
            && hasBoundExecutable(execution)
        const stackArgv = inStackCommand(operation.cwd, declaredArgv)
        const commandStart = execution.argv.length - stackArgv.length
        const serviceIndex = commandStart - 1
        const exactStackCommand = operation.location === 'in-stack'
            && operation.service !== undefined
            && commandStart >= 3
            && exactComposePrefix(execution.argv.slice(0, commandStart - 3), input.checkoutRoot)
            && execution.argv[commandStart - 3] === 'exec'
            && execution.argv[commandStart - 2] === '--no-TTY'
            && execution.argv[serviceIndex] === operation.service
            && execution.argv.slice(commandStart).every((value, index) => value === stackArgv[index])
            && execution.cwd === input.checkoutRoot
            && hasBoundExecutable(execution)
        if (execution.id !== context.id || execution.timeoutMs > operation.timeout_seconds * 1_000
            || !inside(input.checkoutRoot, execution.cwd)
            || (!exactHostCommand && !exactStackCommand)
            || !hasLeafOwnedExecutionMetadata(execution)
            || execution.ports.length !== 0 || execution.compensation.length !== 0) return false
        const labels = Object.freeze({
            dataPlanId: planId,
            dataStepId: context.id,
            overlayLocation: operation.location,
            overlayCwd: operation.cwd,
            overlaySha256: operationDigest(operation),
            ...(operation.service === undefined ? {} : { overlayService: operation.service }),
        })
        const env = operation.location === 'in-stack' && runtimeEnvironment
            ? composeProcessEnvironment(runtimeEnvironment)
            : canonicalExecutionEnvironment
        if (!env) return false
        const bound = snapshotExecutionPlan({ steps: [{ ...execution, env, labels }] })?.steps[0]
        if (!bound || steps.some(({ id }) => id === bound.id)) return false
        steps.push(bound)
        metadata.push(Object.freeze({ ...context, freshVolumeOnly }))
        return true
    }
    for (const operation of selected.operations) {
        for (const [index, prerequisite] of operation.prerequisites.entries()) {
            if (!append(prerequisite, {
                id: `data:${input.mode}:${operation.id}:prerequisite:${index}`,
                phase: 'prerequisite', operationId: operation.id, operationKind: operation.kind,
            }, false)) return refusal('data prerequisite did not resolve to a confined execution step', operation.id)
        }
        if (!append(operation.operation, {
            id: `data:${input.mode}:${operation.id}`,
            phase: 'operation', operationId: operation.id, operationKind: operation.kind,
            after: Object.freeze([...operation.after]),
            provenance: Object.freeze({ source: (operation.provenance ?? selected.provenance).source, reason: (operation.provenance ?? selected.provenance).reason }),
        }, operation.fresh_volume_only)) return refusal('data operation did not resolve to a confined execution step', operation.id)
    }
    if (input.mode === 'restored') {
        if (!data.restore) return refusal('the restored data mode has no restore declaration', 'environment.generated.data.restore')
        for (const rewrite of data.restore.rewrites) {
            if (!append(rewrite.operation, {
                id: `data:restored:rewrite:${rewrite.category}`,
                phase: 'restore-rewrite', operationId: rewrite.category, operationKind: 'rewrite',
            }, false)) return refusal('restore rewrite did not resolve to a confined execution step', rewrite.category)
        }
    }
    for (const [index, probe] of selected.probes.entries()) {
        if (!append(probe, { id: `data:${input.mode}:probe:${index}`, phase: 'probe' }, false)) {
            return refusal('data probe did not resolve to a confined execution step', `probe:${index}`)
        }
    }
    if (input.includeFixtureVolume && input.mode !== 'seeded') {
        return refusal('fixture volume is available only beside the seeded data mode', input.mode)
    }
    const fixtures = data.fixtures
    if (input.includeFixtureVolume) {
        if (!fixtures) return refusal('the fixture volume requires a fixtures declaration', 'environment.generated.data.fixtures')
        for (const [index, operation] of fixtures.volume_operations.entries()) {
            if (!append(operation, { id: `data:volume:operation:${index}`, phase: 'fixture-volume-operation' }, false)) {
                return refusal('fixture-volume operation did not resolve to a confined execution step', `fixture-volume:${index}`)
            }
        }
        for (const [index, probe] of fixtures.volume_probes.entries()) {
            if (!append(probe, { id: `data:volume:probe:${index}`, phase: 'fixture-volume-probe' }, false)) {
                return refusal('fixture-volume probe did not resolve to a confined execution step', `fixture-volume-probe:${index}`)
            }
        }
    }
    const capturedExecution = snapshotExecutionPlan({ steps })
    if (!capturedExecution) return refusal('resolved data execution plan is malformed', 'data execution plan')
    const execution = Object.freeze({ steps: Object.freeze(capturedExecution.steps.map(freezeStep)) })
    const fixtureVolume = fixtures && Object.freeze({
        included: input.includeFixtureVolume,
        tag: fixtures.volume_tag,
        warning: fixtures.pagination_warning,
    })
    const plan = Object.freeze({ mode: input.mode, execution, steps: Object.freeze(metadata), ...(fixtureVolume ? { fixtureVolume } : {}) })
    issuedPlans.set(plan, Object.freeze({
        mode: input.mode, execution, steps: plan.steps, namespace,
        stackId: input.stackId, holderId: input.holderId,
        configPath: configuration.source.path, configSha256: configuration.source.sha256,
        generation: input.generation, observedAt: input.observedAt, issuedAtMs: Date.now(),
        dataVolume: data.volume,
        ...(fixtures && fixtureVolume ? { fixtures: Object.freeze({
            stableKey: fixtures.stable_key,
            ...(fixtures.random_seed === undefined ? {} : { randomSeed: fixtures.random_seed }),
            provenance: Object.freeze({ ...fixtures.provenance }),
            volume: fixtureVolume,
        }) } : {}),
        rewired: Object.freeze(input.mode === 'restored' && data.restore ? data.restore.rewrites.map(({ category }) => category) : []),
        untouched: Object.freeze(input.mode === 'restored' && data.restore ? [...data.restore.untouched] : []),
    }))
    return Object.freeze({ kind: 'preview', plan })
}

function executionRefusal(
    contract: PlannedContract,
    index: number,
    diagnosticValue: EnvironmentDiagnostic,
    attempted: readonly DataStepAttempt[] = Object.freeze([]),
): DataModeExecutionResult {
    const attemptedIds = new Set(attempted.map(({ id }) => id))
    return Object.freeze({
        kind: 'refusal', mode: contract.mode,
        applied: Object.freeze(contract.steps.slice(0, index).map(({ id }) => id)),
        notApplied: Object.freeze(contract.steps.slice(index).map(({ id }) => id).filter((id) => !attemptedIds.has(id))),
        attempted: Object.freeze([...attempted]),
        diagnostics: Object.freeze([diagnosticValue]),
    })
}

function persistedOutcome(value: unknown, mode: DataMode): DataModeExecutionResult | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const candidate = snapshot as unknown as Record<string, unknown>
    if (candidate.mode !== mode || candidate.kind !== 'complete' && candidate.kind !== 'refusal') return undefined
    const boundedStrings = (items: unknown): items is readonly string[] => Array.isArray(items)
        && items.length <= 16_384 && items.every((item) => typeof item === 'string' && item.length > 0 && !item.includes('\0'))
    const exactRecord = (item: unknown, keys: readonly string[]): item is Record<string, unknown> => item !== null
        && typeof item === 'object' && !Array.isArray(item)
        && Object.keys(item).sort().join('\0') === [...keys].sort().join('\0')
    if (!boundedStrings(candidate.applied)) return undefined
    if (candidate.kind === 'complete') {
        const keys = Object.keys(candidate).sort().join('\0')
        const restoreValid = exactRecord(candidate.restore, ['rewired', 'untouched'])
            && boundedStrings(candidate.restore.rewired) && boundedStrings(candidate.restore.untouched)
        if (candidate.stableKeySha256 === undefined) {
            return keys === ['applied', 'kind', 'mode', 'restore'].sort().join('\0') && restoreValid
                ? snapshot as unknown as DataModeExecutionResult
                : undefined
        }
        const expected = (candidate.randomSeedSha256 === undefined
            ? ['applied', 'fixtureProvenanceSha256', 'fixtureVolume', 'kind', 'mode', 'restore', 'stableKeySha256']
            : ['applied', 'fixtureProvenanceSha256', 'fixtureVolume', 'kind', 'mode', 'randomSeedSha256', 'restore', 'stableKeySha256']).sort().join('\0')
        return keys === expected && typeof candidate.stableKeySha256 === 'string' && sha256Identity.test(candidate.stableKeySha256)
            && (candidate.randomSeedSha256 === undefined || typeof candidate.randomSeedSha256 === 'string' && sha256Identity.test(candidate.randomSeedSha256))
            && typeof candidate.fixtureProvenanceSha256 === 'string' && sha256Identity.test(candidate.fixtureProvenanceSha256)
            && exactRecord(candidate.fixtureVolume, ['included', 'tag', 'warning'])
            && typeof candidate.fixtureVolume.included === 'boolean' && typeof candidate.fixtureVolume.tag === 'string'
            && typeof candidate.fixtureVolume.warning === 'string'
            && restoreValid
            ? snapshot as unknown as DataModeExecutionResult
            : undefined
    }
    return Object.keys(candidate).sort().join('\0') === ['applied', 'attempted', 'diagnostics', 'kind', 'mode', 'notApplied'].sort().join('\0')
        && boundedStrings(candidate.notApplied) && Array.isArray(candidate.attempted) && candidate.attempted.length <= 16_384
        && candidate.attempted.every((attempt) => exactRecord(attempt, ['id', 'code', 'exitCode', 'signal'])
            || exactRecord(attempt, ['id', 'code', 'exitCode', 'signal', 'startedAt', 'finishedAt']))
        && candidate.attempted.every((attempt) => typeof attempt.id === 'string' && typeof attempt.code === 'string'
            && Number.isSafeInteger(attempt.exitCode) && (attempt.signal === null || typeof attempt.signal === 'string')
            && (attempt.startedAt === undefined || isCanonicalTimestamp(attempt.startedAt))
            && (attempt.finishedAt === undefined || isCanonicalTimestamp(attempt.finishedAt)))
        && Array.isArray(candidate.diagnostics) && candidate.diagnostics.length > 0 && candidate.diagnostics.length <= 16_384
        && candidate.diagnostics.every((item) => exactRecord(item, ['severity', 'code', 'message', 'target'])
            || exactRecord(item, ['severity', 'code', 'message', 'target', 'fix']))
        && candidate.diagnostics.every((item) => item.severity === 'error' && typeof item.code === 'string'
            && typeof item.message === 'string' && typeof item.target === 'string'
            && (item.fix === undefined || typeof item.fix === 'string'))
        ? snapshot as unknown as DataModeExecutionResult
        : undefined
}

async function publishDataModeOutcome(
    contract: PlannedContract,
    outcome: DataModeExecutionResult,
    updatedAt: string,
): Promise<boolean> {
    const address = contract.namespace.paths.dataOutcome(contract.stackId)
    const snapshot = snapshotJson({
        stackId: contract.stackId,
        configSha256: contract.configSha256,
        generation: contract.generation,
        mode: contract.mode,
        outcome,
    })
    if (snapshot === undefined) return false
    const value = JSON.parse(JSON.stringify(snapshot)) as StateRecord['value']
    const result = await transactState(contract.namespace, address, { ownerId: contract.holderId }, (current) => ({
        format: 'cockpit-state/v1' as const,
        kind: 'data-outcome' as const,
        cockpitId: address.cockpitId,
        subjectId: contract.stackId,
        revision: (current?.revision ?? -1) + 1,
        updatedAt,
        value,
    }))
    return result.kind === 'complete'
}

export async function readDataModeOutcome(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly configSha256: string
    readonly generation: string
    readonly mode: DataMode
}): Promise<DataModeOutcomeProjection | undefined> {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
    let descriptors: PropertyDescriptorMap
    try { descriptors = Object.getOwnPropertyDescriptors(input) } catch { return undefined }
    const keys = ['configSha256', 'generation', 'mode', 'namespace', 'stackId']
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return undefined
    const namespaceValue = descriptors.namespace!.value
    const stackId = descriptors.stackId!.value
    const configSha256 = descriptors.configSha256!.value
    const generation = descriptors.generation!.value
    const mode = descriptors.mode!.value
    let namespace: StateNamespace | undefined
    try { namespace = authenticateStateNamespace(namespaceValue) } catch { return undefined }
    if (!namespace || typeof stackId !== 'string' || !stackIdentity.test(stackId)
        || typeof configSha256 !== 'string' || !sha256Identity.test(configSha256)
        || typeof generation !== 'string' || !sha256Identity.test(generation)) return undefined
    const record = await readState(namespace.paths.dataOutcome(stackId as StackId))
    if (record.kind !== 'complete' || record.value.kind !== 'data-outcome'
        || record.value.subjectId !== stackId) return undefined
    const value = snapshotJson(record.value.value)
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== ['configSha256', 'generation', 'mode', 'outcome', 'stackId'].sort().join('\0')) return undefined
    const candidate = value as unknown as Record<string, unknown>
    const outcome = persistedOutcome(candidate.outcome, mode as DataMode)
    if (!outcome || candidate.stackId !== stackId || candidate.configSha256 !== configSha256
        || candidate.generation !== generation || candidate.mode !== mode) return undefined
    const projection = Object.freeze({ kind: 'data-mode-outcome-projection' as const })
    issuedOutcomeProjections.set(projection, Object.freeze({
        stackId: stackId as StackId,
        configSha256,
        generation,
        mode: mode as DataMode,
        outcome,
        observedAt: record.value.updatedAt,
    }))
    return projection
}

export function consumeDataModeOutcomeProjection(
    projection: DataModeOutcomeProjection,
): DataModeOutcomeEnvelope | undefined {
    if (projection === null || typeof projection !== 'object') return undefined
    const envelope = issuedOutcomeProjections.get(projection)
    issuedOutcomeProjections.delete(projection as DataModeOutcomeProjection)
    return envelope
}

export function projectDataModeObservationSteps(input: {
    readonly plan: DataModePlan
    readonly projection: DataModeOutcomeProjection
}): readonly ExecutionStep[] | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
    let descriptors: PropertyDescriptorMap
    try { descriptors = Object.getOwnPropertyDescriptors(input) } catch { return undefined }
    const keys = ['plan', 'projection']
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return undefined
    const plan = descriptors.plan!.value
    const projection = descriptors.projection!.value
    const contract = plan && typeof plan === 'object' ? issuedPlans.get(plan) : undefined
    const history = projection && typeof projection === 'object' ? issuedOutcomeProjections.get(projection) : undefined
    if (!contract || !history || contract.stackId !== history.stackId
        || contract.configSha256 !== history.configSha256 || contract.generation !== history.generation
        || contract.mode !== history.mode) return undefined
    const includesFixtureVolume = history.outcome.kind === 'complete' && history.outcome.fixtureVolume?.included === true
    return Object.freeze(contract.steps.flatMap((metadata, index) => metadata.phase === 'probe'
        || includesFixtureVolume && metadata.phase === 'fixture-volume-probe'
        ? [contract.execution.steps[index]!]
        : []))
}

export function observeDataMode(input: {
    readonly plan: DataModePlan
    readonly projection: DataModeOutcomeProjection
    readonly outcomes: readonly ExecuteProbeOutcome[]
}): EnvironmentObservation | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = ['outcomes', 'plan', 'projection']
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return undefined
    const plan = descriptors.plan!.value
    const projection = descriptors.projection!.value
    const outcomes = descriptors.outcomes!.value
    const contract = plan && typeof plan === 'object' ? issuedPlans.get(plan) : undefined
    const history = projection && typeof projection === 'object' ? issuedOutcomeProjections.get(projection) : undefined
    const probeSteps = contract && history ? projectDataModeObservationSteps({
        plan: plan as DataModePlan,
        projection: projection as DataModeOutcomeProjection,
    }) : undefined
    if (!contract || !history || !Array.isArray(outcomes) || outcomes.length > 4_096
        || !probeSteps
        || contract.stackId !== history.stackId || contract.configSha256 !== history.configSha256
        || contract.generation !== history.generation || contract.mode !== history.mode) return undefined
    issuedPlans.delete(plan as object)
    issuedOutcomeProjections.delete(projection as object)
    const now = Date.now()
    const admitted = probeSteps.map((step, index) => {
        const outcome = authenticatedExecutionOutcome(outcomes[index], step)
        const startedAt = outcome?.receipt?.startedAt
        const finishedAt = outcome?.receipt?.finishedAt
        if (startedAt === undefined || finishedAt === undefined) return undefined
        const started = Date.parse(startedAt)
        const finished = Date.parse(finishedAt)
        return Number.isFinite(started) && Number.isFinite(finished) && contract.issuedAtMs <= started
            && started <= finished && finished <= now ? outcome : undefined
    })
    const missing = outcomes.length !== probeSteps.length || probeSteps.length === 0 || admitted.some((outcome) => outcome === undefined)
    const refused = admitted.filter((outcome): outcome is Extract<ExecuteProbeOutcome, { kind: 'refusal' }> => outcome?.kind === 'refusal')
    const receipts = admitted.flatMap((outcome) => outcome?.receipt ? [outcome.receipt] : [])
    const observedAt = receipts.map(({ finishedAt }) => finishedAt).sort().at(-1) ?? history.observedAt
    const observation = snapshotEnvironmentObservation({
        code: ENVIRONMENT_CODES.DATA_MODE_UNAVAILABLE,
        owner: mechanism.id,
        stackId: history.stackId,
        source: `data-mode:${history.configSha256}:${history.generation}`,
        observed: history.outcome.kind === 'refusal'
            ? { state: 'failed', reason: `the durable ${history.mode} data execution did not complete`, observedAt }
            : missing
                ? { state: 'unavailable', reason: 'current data probe evidence is incomplete or unauthentic', observedAt }
                : refused.length > 0
                    ? { state: 'failed', reason: `current data probes failed: ${refused.map(({ code }) => code).join(', ')}`, observedAt }
                    : { state: 'available', value: { mode: history.mode, applied: history.outcome.applied, probeCount: probeSteps.length }, observedAt },
        expectation: { kind: 'present' },
        applicability: { state: 'required', posture: 'data-plane' },
        freshness: { state: 'current' },
        remedy: 'complete the declared data mode and rerun its current read-only probes',
    })
    if (!observation) return undefined
    issuedDataModeObservations.set(observation, Date.now())
    return observation
}

export function isDataModeObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedDataModeObservations.has(value)
}

export async function executeDataMode(
    plan: DataModePlan,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<DataModeExecutionResult> {
    const contract = issuedPlans.get(plan)
    if (!contract || typeof execute !== 'function') {
        return Object.freeze({
            kind: 'refusal', mode: 'empty', applied: Object.freeze([]), notApplied: Object.freeze([]),
            attempted: Object.freeze([]),
            diagnostics: Object.freeze([diagnostic(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, 'data plan is unauthenticated', 'data execution plan')]),
        })
    }
    issuedPlans.delete(plan)
    const freshVolumes = new Set<string>()
    let restoreLease: RestoreExecutionLease | undefined
    let durableObservedAt: string | undefined
    const restoreStepSha256 = createHash('sha256')
        .update(JSON.stringify(contract.execution.steps.map(stepDigest))).digest('hex')
    const persist = async (result: DataModeExecutionResult): Promise<DataModeExecutionResult> => {
        let durable = false
        try { durable = await publishDataModeOutcome(contract, result, durableObservedAt ?? new Date().toISOString()) } catch { durable = false }
        if (durable) return result
        const persistence = diagnostic(
            ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            'data execution history could not be published durably',
            contract.stackId,
        )
        return result.kind === 'refusal'
            ? Object.freeze({ ...result, diagnostics: Object.freeze([...result.diagnostics, persistence]) })
            : executionRefusal(contract, contract.steps.length, persistence)
    }
    const refuseExecution = async (
        index: number,
        diagnosticValue: EnvironmentDiagnostic,
        attempted: readonly DataStepAttempt[] = Object.freeze([]),
    ): Promise<DataModeExecutionResult> => {
        if (restoreLease) {
            const lease = restoreLease
            restoreLease = undefined
            const settled = await settleRestoreExecutionAuthority({ namespace: contract.namespace, lease })
            if (settled.kind !== 'complete') return persist(executionRefusal(contract, index, settled.diagnostics[0]!, attempted))
        }
        return persist(executionRefusal(contract, index, diagnosticValue, attempted))
    }
    for (const [index, metadata] of contract.steps.entries()) {
        const step = contract.execution.steps[index]!
        if (metadata.freshVolumeOnly && !freshVolumes.has(contract.dataVolume)) {
            return refuseExecution(index, diagnostic(
                ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                'data step requires a fresh volume', metadata.id, 'wipe the declared product-data volume before retrying',
            ))
        }
        if (metadata.phase === 'operation' && metadata.operationKind === 'restore' && !restoreLease) {
            const issued = await issueRestoreExecutionAuthority({
                namespace: contract.namespace, stackId: contract.stackId, holderId: contract.holderId,
                requesterId: contract.holderId, configPath: contract.configPath,
                configSha256: contract.configSha256, stepSha256: restoreStepSha256,
            })
            if (issued.kind !== 'complete') return refuseExecution(index, issued.diagnostics[0]!)
            const consumed = await consumeRestoreExecutionAuthority({
                namespace: contract.namespace, authority: issued.authority,
                stackId: contract.stackId, holderId: contract.holderId,
                requesterId: contract.holderId, configPath: contract.configPath,
                configSha256: contract.configSha256, stepSha256: restoreStepSha256,
            })
            if (consumed.kind !== 'complete') return refuseExecution(index, consumed.diagnostics[0]!)
            restoreLease = consumed.lease
        }
        let outcome: ExecuteProbeOutcome
        try { outcome = await execute(step) } catch {
            return refuseExecution(index, diagnostic(
                ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, 'data execution did not return an outcome', metadata.id,
            ))
        }
        const authenticated = authenticatedExecutionOutcome(outcome, step)
        if (!authenticated || authenticated.kind !== 'complete') {
            const schemaFailure = metadata.operationKind === 'schema'
            const attempted = authenticated?.kind === 'refusal' && authenticated.execution.started
                ? Object.freeze([Object.freeze({
                    id: metadata.id, code: authenticated.code, exitCode: authenticated.execution.exitCode,
                    signal: authenticated.execution.signal,
                    ...(authenticated.receipt === undefined ? {} : {
                        startedAt: authenticated.receipt.startedAt, finishedAt: authenticated.receipt.finishedAt,
                    }),
                })])
                : Object.freeze([])
            return refuseExecution(index, diagnostic(
                authenticated?.kind === 'refusal' ? authenticated.code : ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                schemaFailure
                    ? `declared schema step failed after ${metadata.after?.join(', ') || 'no prior data steps'} (${metadata.provenance?.source}: ${metadata.provenance?.reason})`
                    : authenticated?.kind === 'refusal' ? 'data execution step was refused' : 'data execution outcome is unauthenticated',
                metadata.id,
            ), attempted)
        }
        const finishedAt = authenticated.receipt?.finishedAt
        if (finishedAt !== undefined) {
            const finished = Date.parse(finishedAt)
            if (!Number.isFinite(finished) || finished > Date.now()) {
                durableObservedAt = undefined
                return refuseExecution(index, diagnostic(
                    ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                    'data execution receipt clock is invalid', metadata.id,
                ))
            }
            if (durableObservedAt === undefined || Date.parse(durableObservedAt) < finished) durableObservedAt = finishedAt
        }
        if (metadata.phase === 'prerequisite' && observedFreshVolume(authenticated, contract.dataVolume, contract.generation)) {
            freshVolumes.add(contract.dataVolume)
        }
    }
    if (restoreLease) {
        const settled = await settleRestoreExecutionAuthority({ namespace: contract.namespace, lease: restoreLease })
        if (settled.kind !== 'complete') return persist(executionRefusal(contract, contract.steps.length, settled.diagnostics[0]!))
    }
    const result = Object.freeze({
        kind: 'complete' as const, mode: contract.mode,
        applied: Object.freeze(contract.steps.map(({ id }) => id)),
        ...(contract.fixtures === undefined ? {} : {
            stableKeySha256: createHash('sha256').update(contract.fixtures.stableKey).digest('hex'),
            ...(contract.fixtures.randomSeed === undefined ? {} : { randomSeedSha256: createHash('sha256').update(contract.fixtures.randomSeed).digest('hex') }),
            fixtureProvenanceSha256: createHash('sha256').update(JSON.stringify(contract.fixtures.provenance)).digest('hex'),
            fixtureVolume: contract.fixtures.volume,
        }),
        restore: Object.freeze({ rewired: contract.rewired, untouched: contract.untouched }),
    })
    const persisted = await persist(result)
    if (persisted.kind === 'complete' && durableObservedAt !== undefined) issuedCompletions.set(persisted, Object.freeze({
        stackId: contract.stackId,
        configSha256: contract.configSha256,
        generation: contract.generation,
        mode: contract.mode,
        observedAt: durableObservedAt,
    }))
    return persisted
}

export function isDataModeCompletion(
    value: unknown,
    expectation?: Readonly<{
        stackId: StackId
        configSha256: string
        generation: string
        mode: DataMode
        earliestMs: number
        latestMs: number
    }>,
): value is Extract<DataModeExecutionResult, { kind: 'complete' }> {
    const issued = value !== null && typeof value === 'object' ? issuedCompletions.get(value) : undefined
    if (!issued) return false
    if (expectation === undefined) return true
    if (expectation === null || typeof expectation !== 'object' || Array.isArray(expectation) || isProxy(expectation)) return false
    let descriptors: PropertyDescriptorMap
    try { descriptors = Object.getOwnPropertyDescriptors(expectation) } catch { return false }
    const keys = ['configSha256', 'earliestMs', 'generation', 'latestMs', 'mode', 'stackId']
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return false
    const observedAt = Date.parse(issued.observedAt)
    return descriptors.stackId!.value === issued.stackId
        && descriptors.configSha256!.value === issued.configSha256
        && descriptors.generation!.value === issued.generation
        && descriptors.mode!.value === issued.mode
        && Number.isFinite(descriptors.earliestMs!.value) && Number.isFinite(descriptors.latestMs!.value)
        && descriptors.earliestMs!.value <= observedAt && observedAt <= descriptors.latestMs!.value
}

export function projectPersonaOutputs(
    environment: unknown,
    source: { readonly path: string; readonly bytes: Uint8Array },
    render: (output: FixtureDeclaration['persona_outputs'][number], sourceBytes: Buffer) => Uint8Array,
): PersonaProjection | undefined {
    let sourcePath: string
    let sourceBytes: Buffer
    try {
        if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(source)
        if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors.path!) || !('value' in descriptors.bytes!)) return undefined
        sourcePath = descriptors.path.value as string
        const bytes = descriptors.bytes.value
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16_777_216) return undefined
        sourceBytes = Buffer.from(bytes)
    } catch { return undefined }
    const parsed = GeneratedEnvironment.safeParse(snapshotJson(environment))
    const fixtures = parsed.success ? parsed.data.data?.fixtures : undefined
    if (!fixtures || sourcePath !== fixtures.persona_source || typeof render !== 'function') return undefined
    const outputs: PersonaProjection['outputs'][number][] = []
    try {
        for (const output of fixtures.persona_outputs) {
            const bytes = Buffer.from(render(Object.freeze({ ...output }), Buffer.from(sourceBytes)))
            if (bytes.byteLength > 16_777_216) return undefined
            outputs.push(Object.freeze({
                ...output, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
            }))
        }
    } catch { return undefined }
    return Object.freeze({
        source: Object.freeze({ path: sourcePath, sha256: createHash('sha256').update(sourceBytes).digest('hex') }),
        outputs: Object.freeze(outputs),
    })
}
