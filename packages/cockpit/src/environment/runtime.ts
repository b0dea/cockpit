import { createHash, randomBytes } from 'node:crypto'
import { platform } from 'node:os'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { MAX_COLD_START_SECONDS } from '../schema.js'
import { consumeMachineFloorConfigProjection, type MachineFloorConfigProjection } from '../config/load.js'
import {
    tryParseJson,
    RefusalError,
    DOCKER_CLIENT_ENVIRONMENT,
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    OBSERVATION_REASON_BYTE_LIMIT,
    snapshotEnvironmentObservation,
    HOST_PROCESS_CONTROL_ENV,
    snapshotExecutionPlan,
    snapshotExecutionStep,
    snapshotJson,
    type EnvironmentCommandOutcome,
    type EnvironmentObservation,
    type ExecutionPlan,
    type ExecutionStep,
    type JsonSnapshot,
    type RefusalCode,
    type CockpitId,
    type StackId,
} from './contract.js'
import { compareBindSources, composeProjectDirectory } from './compose-topology.js'
import { isResolvedDockerExecutable, resolvedDockerExecutable, resolvedExecutable, type ResolvedExecutable } from './executable.js'
import {
    inspectDrainAttemptAuthority,
    inspectDrainExecutionFence,
    openRuntimeDrainExecution,
    settleRuntimeDrainFailure,
    settleRuntimeDrainSuccess,
    type DrainAttemptFailure,
    type DrainAttemptAuthority,
    type RuntimeDrainExecutionAuthority,
    type DrainOutcomeAuthority,
    type DrainReservation,
    type RuntimeStopped,
} from './claims.js'
import { stackId as deriveStackId } from './identity.js'
import {
    inspectPortLeaseProjection,
    observePortListeners,
    revalidatePortLeaseProjection,
    type PortLeaseProjection,
    type PortListenerBinding,
} from './ports.js'
import { cockpitCommand } from '../fix-catalogue.js'
import type { StateNamespace } from './state.js'
import type { LocalRuntimeMeasurements } from './runtime-measurement-record.js'
import { consumeSetupCheckoutProjection, type ConsumedSetupCheckoutObservation, type SetupCheckoutProjection } from './setup-observation.js'
import { composeProcessEnvironment } from './compose-environment.js'
import { exactOwnKeys } from '../exact-keys.js'

const OWNER = 'runtime-planning'

export const observationDeclarations = Object.freeze([
    { id: 'runtime-availability', owner: OWNER, postures: ['mounted', 'host'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, isIssued: isRuntimeObservation, issuedAt: observationIssuedAt },
    { id: 'runtime-measurement', owner: OWNER, postures: ['environment', 'mounted', 'host'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, isIssued: isRuntimeObservation, issuedAt: observationIssuedAt },
    { id: 'mount-posture', owner: OWNER, postures: ['mounted', 'host'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, isIssued: isRuntimeObservation, issuedAt: observationIssuedAt },
] as const)

export const runtimeHealthObservationDeclarations = Object.freeze([
    { id: 'runtime-mount-materialization', owner: OWNER, postures: ['running-stack'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE, isIssued: isRuntimeObservation, issuedAt: observationIssuedAt },
    { id: 'runtime-port-family', owner: OWNER, postures: ['running-stack'], stages: [{ stage: 'bootstrap', disposition: 'not-applicable', reason: 'ports are leased after the first seed' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, isIssued: isRuntimeObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()
interface RuntimeObservationContract {
    readonly operation: RuntimeOperation
    readonly stackId: StackId
    readonly coldStartLimitMillis: number
    readonly expectedMountSources: readonly string[]
    readonly runtimeExecutable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly runtimeVersion: string
    readonly composeVersion: string
    readonly projectName: string
    readonly activeProfiles: readonly string[]
    readonly configSha256: string
    readonly interpolatedNames: readonly string[]
    readonly portLeaseProjection?: PortLeaseProjection
}
const issuedRuntimePlans = new WeakMap<object, RuntimeObservationContract>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== OWNER) throw new RefusalError('runtime observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isRuntimeObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

export function observeRuntimeExecution(input: {
    readonly plan: ExecutionPlan
    readonly outcome: ExecuteProbeOutcome
}): readonly EnvironmentObservation[] {
    let plan: ExecutionPlan
    let suppliedOutcome: ExecuteProbeOutcome
    let owned: JsonSnapshot | undefined
    try {
        plan = input.plan
        suppliedOutcome = input.outcome
        owned = snapshotJson(issuedRuntimePlans.get(plan))
    } catch { throw new RefusalError('runtime execution evidence is not authentic') }
    const values = owned && typeof owned === 'object' && !Array.isArray(owned) ? owned as Readonly<Record<string, JsonSnapshot>> : undefined
    const contract = issuedRuntimePlans.get(plan)
    const step = plan?.steps?.[0]
    const outcome = step ? authenticatedExecutionOutcome(suppliedOutcome, step) : undefined
    if (!contract || !step || !outcome || typeof values?.stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(values.stackId)
        || !Number.isSafeInteger(values.coldStartLimitMillis) || (values.coldStartLimitMillis as number) < 1) {
        throw new RefusalError('runtime execution evidence is not authentic')
    }
    if (!Array.isArray(values.expectedMountSources) || values.expectedMountSources.length > 4_096
        || new Set(values.expectedMountSources).size !== values.expectedMountSources.length
        || values.expectedMountSources.some((path) => typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0'))) {
        throw new RefusalError('runtime mount expectation is malformed')
    }
    const stackId = values.stackId as StackId
    const coldStartLimitMillis = values.coldStartLimitMillis as number
    const expectedMountSources = values.expectedMountSources as readonly string[]
    const observedAt = outcome.receipt?.finishedAt
    if (!observedAt || !isCanonicalTimestamp(observedAt)) throw new RefusalError('runtime execution evidence is not authentic')
    const runtimeAvailable = outcome.kind === 'complete'
    const observations = [issueObservation({
        code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, owner: OWNER, stackId, source: step.argv0,
        observed: { state: 'available', value: runtimeAvailable, observedAt }, expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'mounted' }, freshness: { state: 'current' }, remedy: 'restore the declared runtime executable and retry the bounded probe',
    })]
    let mountObserved: EnvironmentObservation['observed']
    if (contract.operation !== 'validate' || outcome.kind !== 'complete') {
        mountObserved = { state: 'unavailable', reason: 'mount evidence requires a successful runtime validation plan', observedAt }
    } else {
        let sources: readonly string[] | undefined
        let mountCause = ''
        try {
            const source = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout)
            const parsed = parseDocument(source).toJS() as { services?: Record<string, { volumes?: unknown[] }> }
            const values: string[] = []
            if (!parsed || typeof parsed !== 'object' || !parsed.services || typeof parsed.services !== 'object'
                || Object.keys(parsed.services).length > 4_096) throw new RefusalError('invalid services')
            for (const service of Object.values(parsed.services)) {
                if (!service || typeof service !== 'object' || !Array.isArray(service.volumes) || service.volumes.length > 4_096) continue
                for (const volume of service.volumes) {
                    if (typeof volume === 'string') {
                        const source = volume.split(':', 1)[0]!
                        if (isAbsolute(source) && normalize(source) === source && !source.includes('\0')) values.push(source)
                    }
                    else if (volume && typeof volume === 'object' && (volume as { type?: unknown }).type === 'bind'
                        && typeof (volume as { source?: unknown }).source === 'string') values.push((volume as { source: string }).source)
                }
            }
            sources = [...new Set(values)].sort()
        } catch (error) { mountCause = `: ${errorCause(error)}` }
        mountObserved = sources
            ? { state: 'available', value: mountSourcesMatch(sources, expectedMountSources), observedAt }
            : { state: 'failed', reason: `runtime mount output is malformed or unreadable${mountCause}`, observedAt }
    }
    observations.push(issueObservation({
        code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, owner: OWNER, stackId, source: step.id,
        observed: mountObserved, expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'mounted' },
        freshness: { state: 'current' }, remedy: 'restore the declared checkout mount sources',
    }))
    if (contract.operation === 'up') {
        const startedAt = outcome.receipt?.startedAt
        const duration = startedAt ? Date.parse(observedAt) - Date.parse(startedAt) : Number.NaN
        observations.push(issueObservation({
            code: ENVIRONMENT_CODES.MACHINE_COLD_START_EXCEEDED, owner: OWNER, stackId, source: step.id,
            observed: Number.isSafeInteger(duration) && duration >= 0
                ? { state: 'available', value: duration, observedAt }
                : { state: 'failed', reason: 'runtime receipt timestamps are incoherent', observedAt },
            expectation: { kind: 'maximum', value: coldStartLimitMillis }, applicability: { state: 'required', posture: 'environment' },
            freshness: { state: 'current' }, remedy: 'restore the declared cold-start budget',
        }))
    }
    return observations
}

export type RuntimeOperation = 'validate' | 'up' | 'down'

export interface RuntimeAdapterInput {
    runtime: { name: 'docker'; version: string; executableSha256: string }
    composeVersion: string
    executable: ResolvedExecutable
    operation: RuntimeOperation
    cwd: string
    composeFiles: readonly ComposeArtifact[]
    projectName: string
    env: Readonly<Record<string, string>>
    ports: readonly number[]
    labels: Readonly<Record<string, string>>
    timeoutMs: number
    activeProfiles?: readonly string[]
    stackId?: StackId
    coldStartLimitMillis?: number
    expectedMountSources?: readonly string[]
}

export interface RuntimePlanResult {
    runtime: 'docker'
    operation: RuntimeOperation
    projectName: string
}

export interface ComposeArtifact {
    reference: string
    canonicalPath: string
    source: string
    sha256: string
}

/** Each `[[sibling]] var` and the absolute sibling directory it names. */
export type SiblingDirectoryVariables = Readonly<Record<string, string>>

export type RuntimeAdapterAuthority =
    /** A stack's own Compose files, which interpolate the lease, the sibling directories and their own defaults. */
    Readonly<{ ownComposeFiles: true; cockpitId: CockpitId; stackId: StackId; portLeaseProjection?: PortLeaseProjection; siblingDirectories?: SiblingDirectoryVariables }>

const UNRESOLVED_TOKEN = /(?<!\$)\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)|\{\{[^}]*\}\}/

// A cockpit's own Compose file interpolates from the environment cockpit hands Compose: the leased
// [ports.bases] variables and the sibling directory variables, nothing else. A reference with an
// explicit default is the file's own choice; any other reference would resolve to empty, so it
// stays refused.
function composeTokensResolved(source: string, portNames: readonly string[]): boolean {
    const tokens = source.match(new RegExp(UNRESOLVED_TOKEN.source, 'g')) ?? []
    return tokens.every((token) => {
        const match = token.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])[^}]*)?\}$/)
        return match !== null && (match[2]?.endsWith('-') === true || portNames.includes(match[1]!))
    })
}
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/
const REMOTE_REFERENCE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const MAX_TIMEOUT_MS = 300_000
const OUTPUT_LIMIT_BYTES = 65_536
const RUNTIME_OPERATIONS = ['validate', 'up', 'down'] as const
const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^\d+\.\d+\.\d+$/
// What Docker and Compose print: a numeric core and an optional vendor suffix, such as Docker
// Desktop's `2.29.7-desktop.1`. Accepting only the bare core refused every Docker Desktop runtime.
// Floors and comparisons use the core; the full string stays as evidence.
const OBSERVED_VERSION = /^(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$/

/** The numeric core of a version Docker or Compose printed, or undefined when it has none. */
export function observedVersionCore(value: string): string | undefined {
    return value.match(OBSERVED_VERSION)?.[1]
}

function captureOwnValues(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || !exactOwnKeys(value, keys)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const captured: Record<string, unknown> = {}
        for (const key of keys) {
            const descriptor = descriptors[key]
            if (!descriptor || !('value' in descriptor)) return undefined
            captured[key] = descriptor.value
        }
        return captured
    } catch {
        // A throwing accessor or proxy trap makes the input unreadable, which the caller refuses.
        return undefined
    }
}

function runtimeAdapterInput(value: unknown): RuntimeAdapterInput | undefined {
    const baseKeys = ['runtime', 'composeVersion', 'executable', 'operation', 'cwd', 'composeFiles', 'projectName', 'env', 'ports', 'labels', 'timeoutMs']
    const ownedKeys = [...baseKeys, 'stackId', 'coldStartLimitMillis', 'expectedMountSources']
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !([baseKeys, [...baseKeys, 'activeProfiles'], ownedKeys, [...ownedKeys, 'activeProfiles']]
            .some((keys) => exactOwnKeys(value, keys)))) return undefined
    const input = value as Partial<RuntimeAdapterInput>
    if (input.runtime === null || typeof input.runtime !== 'object' || !exactOwnKeys(input.runtime, ['name', 'version', 'executableSha256'])
        || Object.values(input.runtime).some((part) => typeof part !== 'string')
        || !isResolvedDockerExecutable(input.executable)
        || !Array.isArray(input.composeFiles) || !Array.isArray(input.ports)
        || input.env === null || typeof input.env !== 'object' || Array.isArray(input.env)
        || input.labels === null || typeof input.labels !== 'object' || Array.isArray(input.labels)
        || Object.entries(input.env).some(([key, part]) => key.length === 0 || typeof part !== 'string')
        || Object.entries(input.labels).some(([key, part]) => key.length === 0 || typeof part !== 'string')
        || input.ports.some((port) => typeof port !== 'number')
        || typeof input.composeVersion !== 'string' || typeof input.operation !== 'string' || typeof input.cwd !== 'string'
        || typeof input.projectName !== 'string' || typeof input.timeoutMs !== 'number'
        || input.stackId !== undefined && (typeof input.stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(input.stackId))
        || input.coldStartLimitMillis !== undefined && (!Number.isSafeInteger(input.coldStartLimitMillis) || input.coldStartLimitMillis < 1)
        || input.expectedMountSources !== undefined && (!Array.isArray(input.expectedMountSources)
            || input.expectedMountSources.length > 4_096
            || new Set(input.expectedMountSources).size !== input.expectedMountSources.length
            || input.expectedMountSources.some((path) => typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')))
        || input.activeProfiles !== undefined && (!Array.isArray(input.activeProfiles)
            || input.activeProfiles.length > 64 || new Set(input.activeProfiles).size !== input.activeProfiles.length
            || input.activeProfiles.some((profile) => typeof profile !== 'string' || !SERVICE_ID.test(profile)))
        || input.composeFiles.some((artifact) => artifact === null || typeof artifact !== 'object'
            || !exactOwnKeys(artifact, ['reference', 'canonicalPath', 'source', 'sha256'])
            || Object.values(artifact).some((part) => typeof part !== 'string'))) return undefined
    return {
        ...input,
        ...(input.expectedMountSources === undefined
            ? {}
            : { expectedMountSources: [...input.expectedMountSources].sort() }),
        ...(input.activeProfiles === undefined ? {} : { activeProfiles: [...input.activeProfiles].sort() }),
    } as RuntimeAdapterInput
}

export function classifyResolvedRuntimeLiterals(values: readonly string[]): 'resolved' | 'unresolved' | 'unsafe' {
    let captured: unknown[]
    try {
        if (!Array.isArray(values)) return 'unsafe'
        const length = values.length
        const keys = Object.keys(values)
        if (!Number.isSafeInteger(length) || length < 0 || length > 4_096
            || keys.length !== length || keys.some((key, index) => key !== String(index))) return 'unsafe'
        captured = keys.map((key) => (values as unknown as Record<string, unknown>)[key])
    } catch {
        // A throwing accessor or proxy trap makes the list unsafe, which the caller refuses.
        return 'unsafe'
    }
    const owned = snapshotJson(captured)
    if (!Array.isArray(owned) || owned.some((value) => typeof value !== 'string')) return 'unsafe'
    if (owned.some((value) => UNRESOLVED_TOKEN.test(value as string))) return 'unresolved'
    if (owned.some((value) => (value as string).includes('\0'))) return 'unsafe'
    return 'resolved'
}

function refusal<T = RuntimePlanResult>(
    code: RefusalCode,
    message: string,
    target: string,
): EnvironmentCommandOutcome<T> {
    return {
        kind: 'refusal',
        status: 2,
        diagnostics: [{ severity: 'error', code, message, target }],
        result: null,
    }
}

export type MachineFloorPlanInput = {
    readonly runtimeExecutable: ResolvedExecutable
    readonly diskExecutable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly authority?: MachineFloorAuthority
} | {
    readonly runtimePlan: ExecutionPlan
    readonly diskExecutable: ResolvedExecutable
    readonly timeoutMs: number
    readonly authority?: MachineFloorAuthority
}
export interface MachineFloorThresholds {
    readonly memoryBytes: number
    readonly cpuMillis: number
    readonly freeDiskBytes: number
}

declare const machineFloorEvidenceBrand: unique symbol
export interface MachineFloorEvidence {
    readonly [machineFloorEvidenceBrand]: true
    readonly memoryBytes: number
    readonly cpuMillis: number
    readonly freeDiskBytes: number
    readonly observedAt: string
    readonly stackId?: StackId
    readonly floor?: MachineFloorThresholds
}

const issuedMachineFloorEvidence = new WeakSet<object>()
const issuedMachineFloorPlans = new WeakMap<object, { readonly stackId?: StackId; readonly floor?: MachineFloorThresholds }>()

export interface MachineFloorAuthority { readonly kind: 'machine-floor-authority' }
const issuedMachineFloorAuthorities = new WeakMap<object, Readonly<{
    stackId: StackId
    checkoutPath: string
    configSha256: string
    floor: MachineFloorThresholds
}>>()

export function issueMachineFloorAuthority(input: {
    readonly configuration: MachineFloorConfigProjection
    readonly checkout: SetupCheckoutProjection
}): Readonly<{ authority: MachineFloorAuthority; checkout: ConsumedSetupCheckoutObservation }> | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
        || !exactOwnKeys(input, ['configuration', 'checkout'])) return undefined
    const configurationDescriptor = Object.getOwnPropertyDescriptor(input, 'configuration')
    const checkoutDescriptor = Object.getOwnPropertyDescriptor(input, 'checkout')
    if (!configurationDescriptor || !('value' in configurationDescriptor)
        || !checkoutDescriptor || !('value' in checkoutDescriptor)) return undefined
    const configuration = consumeMachineFloorConfigProjection(configurationDescriptor.value)
    const checkout = consumeSetupCheckoutProjection(checkoutDescriptor.value)
    if (!configuration || !checkout || configuration.cockpitName !== checkout.cockpitName
        || configuration.source.path !== checkout.source.path
        || configuration.source.sha256 !== checkout.source.sha256
        || configuration.source.byteLength !== checkout.source.byteLength) return undefined
    const floor = {
        memoryBytes: configuration.floor.runtimeMemoryMb * 1_024 * 1_024,
        cpuMillis: configuration.floor.runtimeCpus * 1_000,
        freeDiskBytes: configuration.floor.freeDiskMb * 1_024 * 1_024,
    }
    if (Object.values(floor).some((value) => !Number.isSafeInteger(value) || value < 1)) return undefined
    const authority = { kind: 'machine-floor-authority' as const }
    issuedMachineFloorAuthorities.set(authority, Object.freeze({
        stackId: deriveStackId({ cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, variant: { kind: 'shared' } }),
        checkoutPath: dirname(configuration.source.path),
        configSha256: configuration.runtimeSha256,
        floor: Object.freeze(floor),
    }))
    return { authority, checkout }
}

export function isMachineFloorEvidence(value: unknown): value is MachineFloorEvidence {
    return value !== null && typeof value === 'object' && issuedMachineFloorEvidence.has(value)
}

type OwnedMachineFloorPlanInput = {
    readonly runtimeExecutable: ResolvedExecutable
    readonly diskExecutable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId?: StackId
    readonly floor?: MachineFloorThresholds
}

const MACHINE_FLOOR_ENV = new Set(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])

// Keep the filesystem query inside the bounded executor; a filesystem stall must not hold the CLI.
const DISK_CAPACITY_COLLECTOR = `
import { statfsSync } from 'node:fs'
if (process.argv.length !== 2) throw new RefusalError('Disk capacity requires one filesystem path')
const status = statfsSync(process.argv[1], { bigint: true })
const bytes = status.bsize * status.bavail
if (status.bsize <= 0n || status.bavail < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RefusalError('Available filesystem capacity is outside the supported byte range')
}
process.stdout.write(bytes.toString() + '\\n')
`

function safeMachineFloorEnvironment(value: unknown): value is Readonly<Record<string, string>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.entries(value).every(([name, item]) => MACHINE_FLOOR_ENV.has(name) && typeof item === 'string' && !item.includes('\0'))
}

function machineFloorEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(value).filter(([name]) => MACHINE_FLOOR_ENV.has(name)),
    )
}

export interface DockerRuntimeObservationInput {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
}

export type RuntimeIdentity = 'docker-desktop' | 'orbstack' | 'colima' | 'rancher-desktop' | 'docker-engine'

export interface DockerInfoIdentityInput {
    readonly operatingSystem: string
    readonly name: string
    readonly osType: string
    readonly hostPlatform: string
}

/**
 * Name the container runtime product from one `docker info` reading, or null when it is not one we
 * recognise. The identity selects this machine's runtime measurement, so a wrong match would
 * admit a runtime on another product's measurement; anything unrecognised therefore stays null.
 *
 * Provenance of each rule: `orbstack` was observed on a host running OrbStack (OperatingSystem
 * "OrbStack", Name "orbstack", OSType "linux"). The `docker-desktop`, `colima`, `rancher-desktop` and
 * `docker-engine` rules are derived from those vendors' documented `docker info` output and have not
 * been probed on a host here.
 */
export function runtimeIdentity(input: DockerInfoIdentityInput): RuntimeIdentity | null {
    if (input.operatingSystem === 'Docker Desktop') return 'docker-desktop'
    if (input.operatingSystem === 'OrbStack') return 'orbstack'
    // Colima names its VM after the profile: "colima" or "colima-<profile>".
    if (input.name.startsWith('colima')) return 'colima'
    // Rancher Desktop runs its engine in a Lima VM named "lima-rancher-desktop".
    if (input.name.endsWith('rancher-desktop')) return 'rancher-desktop'
    // On a Linux host the daemon is the host's own Docker Engine; on macOS an unrecognised
    // OperatingSystem is some other VM product and must not borrow this identity.
    if (input.hostPlatform === 'linux' && input.osType === 'linux') return 'docker-engine'
    return null
}

const DOCKER_IDENTITY_FORMAT = '[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]'

function dockerIdentityFields(text: string): readonly [string, string, string] | undefined {
    // Unparsable identity output yields no fields; the caller reports the probe as unauthenticated output.
    const parsed = tryParseJson(text)
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
    const [operatingSystem, name, osType] = parsed as unknown[]
    const bounded = (value: unknown, limit: number): value is string => typeof value === 'string'
        && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
    return bounded(operatingSystem, 128) && bounded(name, 128) && bounded(osType, 16)
        ? ([operatingSystem, name, osType] as const) : undefined
}

export type DockerRuntimeObservation =
    | Readonly<{
        kind: 'complete'
        runtime: { readonly name: 'docker'; readonly version: string; readonly executableSha256: string }
        runtimeIdentity: RuntimeIdentity | null
        operatingSystem: string
        name: string
        osType: string
        hostPlatform: string
        composeVersion: string
        observedAt: string
    }>
    | Readonly<{ kind: 'unavailable'; code: typeof ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE; reason: string; fix?: string }>

function runtimeVersionUnavailable(reason: string): DockerRuntimeObservation {
    return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, reason }
}

// The runtime answered, so starting it is the wrong remedy: the installed tool prints a version
// that floors and measurements cannot compare.
function runtimeVersionUnparseable(tool: string, command: string, printed: string): DockerRuntimeObservation {
    return {
        kind: 'unavailable',
        code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
        reason: `${tool} reported version ${JSON.stringify(printed.slice(0, 64))} from \`${command}\`, which has no numeric X.Y.Z core`,
        fix: 'install a Docker Engine and Docker Compose release whose `docker version --format {{.Server.Version}}` and `docker compose version --short` print X.Y.Z (a suffix such as -desktop.1 is fine), then retry',
    }
}

const issuedDockerRuntimeObservations = new WeakSet<object>()
const issuedRuntimeMeasurementAdmissions = new WeakMap<object, Extract<DockerRuntimeObservation, { readonly kind: 'complete' }>>()
export interface RuntimeMeasurementProbeAuthority { readonly kind: 'runtime-measurement-probe-authority' }
const issuedRuntimeMeasurementProbeAuthorities = new WeakMap<object, Extract<DockerRuntimeObservation, { readonly kind: 'complete' }>>()

export function issueRuntimeMeasurementProbeAuthority(observation: DockerRuntimeObservation): RuntimeMeasurementProbeAuthority {
    if (!observation || typeof observation !== 'object' || observation.kind !== 'complete'
        || !issuedDockerRuntimeObservations.has(observation)) throw new RefusalError('runtime measurement probe evidence is not authentic')
    const authority = { kind: 'runtime-measurement-probe-authority' as const }
    issuedRuntimeMeasurementProbeAuthorities.set(authority, observation)
    return authority
}

export function runtimeMeasurementProbeObservation(
    authority: RuntimeMeasurementProbeAuthority,
    executableSha256: string,
): Extract<DockerRuntimeObservation, { readonly kind: 'complete' }> | undefined {
    const issued = authority && typeof authority === 'object' ? issuedRuntimeMeasurementProbeAuthorities.get(authority) : undefined
    if (authority && typeof authority === 'object') issuedRuntimeMeasurementProbeAuthorities.delete(authority)
    const age = issued ? Date.now() - Date.parse(issued.observedAt) : Number.NaN
    return issued && issued.runtime.executableSha256 === executableSha256
        && age >= 0 && age <= 300_000 ? issued : undefined
}

export type RuntimeMeasurementAdmission =
    | Readonly<{ kind: 'admitted'; runtimeIdentity: string; measurement: string }>
    | Readonly<{ kind: 'unavailable'; code: typeof ENVIRONMENT_CODES.RUNTIME_UNMEASURED; reason: string }>

function runtimeUnmeasured(reason: string): RuntimeMeasurementAdmission {
    return { kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED, reason }
}

/** A floor cockpit writes: a bare numeric core. */
export function isVersionFloor(value: string): boolean {
    return VERSION.test(value)
}

/** Whether a version Docker or Compose printed is at least `floor`; false when either is malformed. */
export function versionAtLeast(actual: string, floor: string): boolean {
    const core = observedVersionCore(actual)
    if (core === undefined || !isVersionFloor(floor)) return false
    const left = core.split('.').map(Number)
    const right = floor.split('.').map(Number)
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index]! > right[index]!
    }
    return true
}

export function admitRuntimeMeasurement(
    observation: DockerRuntimeObservation,
    measurements: LocalRuntimeMeasurements,
): RuntimeMeasurementAdmission {
    if (!observation || typeof observation !== 'object' || !issuedDockerRuntimeObservations.has(observation)
        || observation.kind !== 'complete') return runtimeUnmeasured('Docker runtime evidence is unavailable or unauthenticated')
    const refuse = (reason: string): RuntimeMeasurementAdmission => {
        const result = runtimeUnmeasured(reason)
        issuedRuntimeMeasurementAdmissions.set(result, observation)
        return result
    }
    const identity = observation.runtimeIdentity
    const dockerInfo = `docker info: OperatingSystem ${JSON.stringify(observation.operatingSystem)}, Name ${JSON.stringify(observation.name)}, `
        + `OSType ${JSON.stringify(observation.osType)}; engine ${observation.runtime.version}; host ${observation.hostPlatform}`
    const rows = measurements.kind === 'read' ? measurements.rows : []
    const listed = rows.map((row) => `${row.runtime} on ${JSON.stringify(row.daemon.slice(0, 40))} (engine ${row.engineVersion.slice(0, 32)}, Compose floor ${row.composeFloor})`)
    const listedRows = listed.length === 0 ? 'none'
        : `${listed.slice(0, 4).join(', ')}${listed.length > 4 ? ` and ${listed.length - 4} more` : ''}`
    // Every refusal names what was detected and what this machine's record holds, so the operator can
    // act on the message alone; the remedy is always a fresh measurement of this exact runtime. The
    // reason also travels in an observation, whose text is byte-bounded, so the row list yields first.
    const detail = (reason: string, action: string) => {
        const full = `${reason} (${dockerInfo}; measured in ${measurements.path}: ${listedRows}). ${action}`
        return Buffer.byteLength(full) <= OBSERVATION_REASON_BYTE_LIMIT ? full
            : `${reason} (${dockerInfo}; measured in ${measurements.path}: ${rows.length}). ${action}`
    }
    const remeasure = (reason: string) => refuse(detail(reason,
        `Measure it on this machine with: ${cockpitCommand('runtime measure', { args: '--image <local-image>' })}`))
    if (!identity) {
        return refuse(detail('Docker runtime is not a recognised product, so no measurement can apply',
            'Report these docker info values to the cockpit maintainers so the runtime can be identified'))
    }
    if (measurements.kind === 'unreadable') {
        return remeasure(`This machine's runtime measurement record is unreadable: ${measurements.reason}; a new measurement replaces it`)
    }
    const row = rows.find((candidate) => candidate.runtime === identity && candidate.daemon === observation.name)
    if (!row) return remeasure(`Runtime ${identity} on daemon ${JSON.stringify(observation.name)} has not been measured on this machine`)
    // A measurement certifies the engine it ran against; an upgraded or downgraded engine is a
    // different runtime until it passes the probe too.
    if (row.engineVersion !== observation.runtime.version) {
        return remeasure(`Runtime ${identity} was measured with engine ${row.engineVersion} and now runs engine ${observation.runtime.version}`)
    }
    if (!VERSION.test(row.composeFloor) || !versionAtLeast(observation.composeVersion, row.composeFloor)) {
        return remeasure(`Runtime ${identity} runs Docker Compose ${observation.composeVersion}, below the measured floor ${row.composeFloor}`)
    }
    const result = { kind: 'admitted' as const, runtimeIdentity: identity,
        measurement: `${identity} on ${JSON.stringify(observation.name)}, engine ${row.engineVersion}, Compose floor ${row.composeFloor}, measured ${row.measuredOn}` }
    issuedRuntimeMeasurementAdmissions.set(result, observation)
    return result
}

export function observeRuntimeMeasurement(admission: RuntimeMeasurementAdmission, stackId: StackId): EnvironmentObservation {
    const runtime = admission && typeof admission === 'object' ? issuedRuntimeMeasurementAdmissions.get(admission) : undefined
    if (!runtime || typeof stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(stackId)) {
        throw new RefusalError('runtime measurement admission is not authentic')
    }
    return issueObservation({
        code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
        owner: OWNER,
        stackId,
        // An admitted runtime names the measurement that admitted it, so doctor says which runtime is measured.
        source: admission.kind === 'admitted' ? admission.measurement : runtime.operatingSystem,
        observed: admission.kind === 'admitted'
            ? { state: 'available', value: true, observedAt: runtime.observedAt }
            : { state: 'unavailable', reason: admission.reason, observedAt: runtime.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'mounted' },
        freshness: { state: 'current' },
        remedy: 'measure this runtime on this machine: a passing candidate and a rejected broken control for its exact engine and Compose floor',
    })
}

export async function observeDockerRuntime(
    rawInput: DockerRuntimeObservationInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<DockerRuntimeObservation> {
    let input: DockerRuntimeObservationInput
    try {
        const captured = snapshotJson(rawInput)
        if (!captured || typeof captured !== 'object' || Array.isArray(captured)
            || !exactOwnKeys(captured, ['executable', 'cwd', 'env', 'timeoutMs'])) {
            return runtimeVersionUnavailable('Docker runtime version input is malformed')
        }
        const candidate = captured as unknown as DockerRuntimeObservationInput
        const executable = resolvedDockerExecutable(candidate.executable)
        if (!executable || typeof candidate.cwd !== 'string' || !isAbsolute(candidate.cwd)
            || normalize(candidate.cwd) !== candidate.cwd || candidate.cwd.includes('\0')
            || !safeMachineFloorEnvironment(candidate.env)
            || !Number.isSafeInteger(candidate.timeoutMs) || candidate.timeoutMs < 1 || candidate.timeoutMs > 30_000
            || typeof execute !== 'function') {
            return runtimeVersionUnavailable('Docker runtime version input needs a resolved executable, local working directory, and bounded environment')
        }
        input = { ...candidate, executable, env: { ...candidate.env } }
    } catch (error) {
        return runtimeVersionUnavailable(`Docker runtime version input is unreadable: ${errorCause(error)}`)
    }

    const batchId = randomBytes(16).toString('hex')
    const step = (id: string, args: readonly string[], stdoutLimitBytes = 128): ExecutionStep => ({
        id,
        argv: [input.executable.canonicalPath, ...args] as [string, ...string[]],
        argv0: input.executable.invocationPath,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        stdoutLimitBytes,
        stderrLimitBytes: 512,
        paths: [],
        ports: [],
        labels: { purpose: id, batchId },
        expected: [],
        consumedFiles: [{
            path: input.executable.canonicalPath, sha256: input.executable.sha256,
            maxBytes: 536_870_912, argvIndexes: [0], executable: true as const,
            executionMode: input.executable.executionMode,
        }],
        filesystemChecks: [],
        compensation: [],
    })
    const versionStep = step('runtime:docker-server-version', ['version', '--format', '{{.Server.Version}}'])
    const composeStep = step('runtime:docker-compose-version', ['compose', 'version', '--short'])
    // One reading supplies every identity field, so they describe the same daemon. JSON-encoding each
    // field keeps a hostname or product label containing separators from shifting the others.
    const identityStep = step('runtime:docker-operating-system',
        ['info', '--format', DOCKER_IDENTITY_FORMAT], 512)
    // Set only by the probe that threw; every later step returns as soon as a probe fails.
    let probeCause = ''
    const readText = async (probe: ExecutionStep, limit = 128): Promise<{ value: string; observedAt: string } | undefined> => {
        let raw: ExecuteProbeOutcome
        try { raw = await execute(probe) } catch (error) { probeCause = `: ${errorCause(error)}`; return undefined }
        const outcome = authenticatedExecutionOutcome(raw, probe)
        if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0) return undefined
        try {
            const value = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout).trim()
            return value.length > 0 && value.length <= limit && !value.includes('\0')
                ? { value, observedAt: outcome.receipt.finishedAt } : undefined
        } catch {
            // Undecodable output yields no reading; the caller reports the probe as unauthenticated output.
            return undefined
        }
    }
    const server = await readText(versionStep)
    if (!server) return runtimeVersionUnavailable('Docker server version probe failed or returned unauthenticated output' + probeCause)
    if (!OBSERVED_VERSION.test(server.value)) return runtimeVersionUnparseable('Docker Engine', 'docker version --format {{.Server.Version}}', server.value)
    const compose = await readText(composeStep)
    if (!compose) return runtimeVersionUnavailable('Docker Compose version probe failed or returned unauthenticated output' + probeCause)
    if (!OBSERVED_VERSION.test(compose.value)) return runtimeVersionUnparseable('Docker Compose', 'docker compose version --short', compose.value)
    const identityText = await readText(identityStep, 512)
    const fields = identityText === undefined ? undefined : dockerIdentityFields(identityText.value)
    if (!identityText || !fields) return runtimeVersionUnavailable('Docker identity probe (docker info OperatingSystem, Name, OSType) failed or returned unauthenticated output' + probeCause)
    const [operatingSystem, name, osType] = fields
    const hostPlatform = platform()
    const result: DockerRuntimeObservation = {
        kind: 'complete',
        runtime: { name: 'docker', version: server.value, executableSha256: input.executable.sha256 },
        runtimeIdentity: runtimeIdentity({ operatingSystem, name, osType, hostPlatform }),
        operatingSystem,
        name,
        osType,
        hostPlatform,
        composeVersion: compose.value,
        observedAt: [server.observedAt, compose.observedAt, identityText.observedAt].sort().at(-1)!,
    }
    issuedDockerRuntimeObservations.add(result)
    return result
}

function machineFloorPlanInput(value: unknown): OwnedMachineFloorPlanInput | undefined {
    try {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)
            && exactOwnKeys(value, ['runtimePlan', 'diskExecutable', 'timeoutMs', 'authority'])) {
            const runtimeDescriptor = Object.getOwnPropertyDescriptor(value, 'runtimePlan')
            if (!runtimeDescriptor || !('value' in runtimeDescriptor)) return undefined
            const runtime = issuedRuntimePlans.get(runtimeDescriptor.value as object)
            const snapshot = snapshotJson({
                diskExecutable: (value as { diskExecutable?: unknown }).diskExecutable,
                timeoutMs: (value as { timeoutMs?: unknown }).timeoutMs,
            })
            const authorityDescriptor = Object.getOwnPropertyDescriptor(value, 'authority')
            const authority = authorityDescriptor && 'value' in authorityDescriptor
                ? issuedMachineFloorAuthorities.get(authorityDescriptor.value as object) : undefined
            if (!runtime || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
            const candidate = snapshot as unknown as { diskExecutable?: unknown; timeoutMs?: unknown }
            const diskExecutable = resolvedExecutable(candidate.diskExecutable)
            const env = machineFloorEnvironment(runtime.env)
            if (!diskExecutable || !safeMachineFloorEnvironment(env)
                || !authority || authority.stackId !== runtime.stackId || authority.configSha256 !== runtime.configSha256
                || !Number.isSafeInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) < 1 || (candidate.timeoutMs as number) > 30_000) return undefined
            return {
                runtimeExecutable: runtime.runtimeExecutable, diskExecutable, cwd: runtime.cwd,
                env, timeoutMs: candidate.timeoutMs as number, stackId: runtime.stackId,
                floor: authority.floor,
            }
        }
        const snapshot = snapshotJson(value)
        if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
            || !([['runtimeExecutable', 'diskExecutable', 'cwd', 'env', 'timeoutMs'],
                ['runtimeExecutable', 'diskExecutable', 'cwd', 'env', 'timeoutMs', 'authority']]
                .some((keys) => exactOwnKeys(value as object, keys)))) return undefined
        const candidate = snapshot as unknown as Extract<MachineFloorPlanInput, { runtimeExecutable: ResolvedExecutable }>
        const runtimeExecutable = resolvedDockerExecutable(candidate.runtimeExecutable)
        const diskExecutable = resolvedExecutable(candidate.diskExecutable)
        if (runtimeExecutable === undefined || diskExecutable === undefined || typeof candidate.cwd !== 'string'
            || !isAbsolute(candidate.cwd) || normalize(candidate.cwd) !== candidate.cwd || candidate.cwd.includes('\0')
            || !safeMachineFloorEnvironment(candidate.env)
            || !Number.isInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) <= 0 || (candidate.timeoutMs as number) > 30_000) return undefined
        const authorityDescriptor = Object.getOwnPropertyDescriptor(value as object, 'authority')
        const authority = authorityDescriptor && 'value' in authorityDescriptor
            ? issuedMachineFloorAuthorities.get(authorityDescriptor.value as object) : undefined
        if (authorityDescriptor && (!authority || candidate.cwd !== authority.checkoutPath)) return undefined
        return {
            runtimeExecutable, diskExecutable, cwd: candidate.cwd,
            env: { ...candidate.env }, timeoutMs: candidate.timeoutMs as number,
            ...(authority ? { stackId: authority.stackId, floor: authority.floor } : {}),
        }
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

export function createMachineFloorPlan(rawInput: MachineFloorPlanInput): EnvironmentCommandOutcome<null> {
    const input = machineFloorPlanInput(rawInput)
    if (input === undefined) {
        return refusal<null>(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'machine-floor collectors require canonical digest-bound executables and a bounded timeout', 'machine-floor')
    }
    const { runtimeExecutable, diskExecutable } = input
    const makeStep = (id: string, argv: readonly [string, ...string[]], executable: ResolvedExecutable): ExecutionStep => ({
        id, argv: [...argv] as unknown as [string, ...string[]], argv0: executable.invocationPath, cwd: input.cwd,
        env: { ...input.env }, timeoutMs: input.timeoutMs, stdoutLimitBytes: 4096, stderrLimitBytes: 4096,
        paths: [], ports: [], labels: { collector: id }, expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks: [],
        compensation: [],
    })
    const steps = [
        makeStep('runtime:measure:resources', [runtimeExecutable.canonicalPath, 'info', '--format', '{{json .MemTotal}}|{{json .NCPU}}'], runtimeExecutable),
        makeStep('runtime:measure:free-disk', [diskExecutable.canonicalPath, '--input-type=module', '-e', DISK_CAPACITY_COLLECTOR, input.cwd], diskExecutable),
    ]
    const plan = snapshotExecutionPlan({ steps })
    if (plan === undefined) return refusal<null>(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'machine-floor collectors did not produce a valid execution plan', input.cwd)
    issuedMachineFloorPlans.set(plan, Object.freeze({
        ...(input.stackId ? { stackId: input.stackId } : {}),
        ...(input.floor ? { floor: input.floor } : {}),
    }))
    return { kind: 'preview', status: 0, diagnostics: [], result: null, plan }
}

export function collectMachineFloorEvidence(
    plan: ExecutionPlan,
    outcomes: readonly [ExecuteProbeOutcome, ExecuteProbeOutcome],
): MachineFloorEvidence | undefined {
    const contract = issuedMachineFloorPlans.get(plan)
    if (!contract) return undefined
    const ownedPlan = snapshotExecutionPlan(plan)
    if (!ownedPlan || ownedPlan.steps.length !== 2
        || ownedPlan.steps[0]?.id !== 'runtime:measure:resources'
        || ownedPlan.steps[1]?.id !== 'runtime:measure:free-disk') return undefined
    const resources = authenticatedExecutionOutcome(outcomes[0], ownedPlan.steps[0])
    const disk = authenticatedExecutionOutcome(outcomes[1], ownedPlan.steps[1])
    if (!resources || resources.kind !== 'complete' || !disk || disk.kind !== 'complete') return undefined
    let resourceText: string
    let diskText: string
    try {
        resourceText = new TextDecoder('utf-8', { fatal: true }).decode(resources.stdout).trim()
        diskText = new TextDecoder('utf-8', { fatal: true }).decode(disk.stdout)
    } catch {
        // Undecodable output yields no measurement, which the caller reports as unavailable.
        return undefined
    }
    const resourceMatch = resourceText.match(/^(\d+)\|(\d+(?:\.\d{1,3})?)$/)
    if (!resourceMatch || !/^(?:0|[1-9]\d{0,15})\n$/.test(diskText) || disk.stderr.byteLength !== 0) return undefined
    const memoryBytes = Number(resourceMatch[1])
    const cpuMillis = Number(resourceMatch[2]) * 1_000
    const freeDiskBytes = Number(diskText)
    if (![memoryBytes, cpuMillis, freeDiskBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined
    const evidence = {
        memoryBytes, cpuMillis, freeDiskBytes,
        observedAt: resources.receipt.finishedAt > disk.receipt.finishedAt ? resources.receipt.finishedAt : disk.receipt.finishedAt,
        ...(contract.stackId ? { stackId: contract.stackId } : {}),
        ...(contract.floor ? { floor: contract.floor } : {}),
    } as MachineFloorEvidence
    issuedMachineFloorEvidence.add(evidence)
    return evidence
}

function localComposePath(cwd: string, source: ComposeArtifact): string | undefined {
    if (
        source.reference.length === 0
        || isAbsolute(source.reference)
        || REMOTE_REFERENCE.test(source.reference)
        || source.reference.includes('\\')
        || source.reference.includes('\0')
    ) return undefined
    const target = resolve(cwd, source.reference)
    const fromCwd = relative(cwd, source.canonicalPath)
    if (target !== source.canonicalPath || fromCwd === '..' || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) return undefined
    return source.canonicalPath
}

function composeArgv(
    command: readonly [string, ...string[]],
    files: readonly string[],
    projectDirectory: string,
    projectName: string,
    operation: RuntimeOperation,
    activeProfiles: readonly string[],
): readonly [string, ...string[]] {
    const fileArgs = files.flatMap((file) => ['--file', file])
    const profileArgs = activeProfiles.flatMap((profile) => ['--profile', profile])
    const operationArgs = operation === 'validate'
        ? ['config', '--quiet']
        : operation === 'up'
            ? ['up', '--detach', '--wait']
            : ['down', '--remove-orphans']
    return [...command, '--project-directory', projectDirectory, ...fileArgs, '--project-name', projectName, ...profileArgs, ...operationArgs]
}

function composeStep(
    input: RuntimeAdapterInput,
    files: readonly string[],
    projectDirectory: string,
    operation: RuntimeOperation,
    compensation: readonly ExecutionStep[],
): ExecutionStep {
    const step: ExecutionStep = {
        id: `runtime:docker-compose:${operation}:${input.projectName}`,
        argv: [...composeArgv([input.executable.canonicalPath, 'compose'], files, projectDirectory, input.projectName, operation, input.activeProfiles ?? [])] as unknown as [string, ...string[]],
        argv0: input.executable.invocationPath,
        cwd: input.cwd,
        env: { ...input.env },
        timeoutMs: input.timeoutMs,
        stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
        stderrLimitBytes: OUTPUT_LIMIT_BYTES,
        paths: [...files],
        ports: [...input.ports],
        labels: { ...input.labels, operation, runtime: input.runtime.name, composeVersion: input.composeVersion },
        expected: [],
        consumedFiles: [
        { path: input.executable.canonicalPath, sha256: input.executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: input.executable.executionMode },
            ...input.composeFiles.map(({ canonicalPath: path, sha256 }, index) => ({ path, sha256, maxBytes: 1_048_576, argvIndexes: [5 + index * 2], executable: false as const })),
        ],
        filesystemChecks: [],
        compensation: [...compensation],
    }
    return step
}

function exactInputValues(input: RuntimeAdapterInput): readonly string[] {
    return [
        input.executable.canonicalPath,
        input.executable.invocationPath,
        input.cwd,
        input.projectName,
        ...Object.keys(input.env),
        ...Object.values(input.env),
        ...Object.keys(input.labels),
        ...Object.values(input.labels),
        ...(input.activeProfiles ?? []),
    ]
}

function hasUnresolvedInput(input: RuntimeAdapterInput): boolean {
    return classifyResolvedRuntimeLiterals(exactInputValues(input)) === 'unresolved'
}

function localBuildContext(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0 && !value.includes('\0')
        && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/\s]+@[^:]+:/i.test(value)
}

function composeBuildContextsSafe(source: string): boolean {
    try {
        if (Buffer.byteLength(source) > 1_048_576) return false
        const document = parseDocument(source, { merge: true })
        if (document.errors.length > 0 || document.warnings.length > 0) return false
        const root = document.toJS({ maxAliasCount: 100 }) as unknown
        if (root === null || typeof root !== 'object' || Array.isArray(root)) return false
        const rootRecord = root as Record<string, unknown>
        if (rootRecord.include !== undefined) return false
        const services = rootRecord.services
        if (services === undefined) return true
        if (services === null || typeof services !== 'object' || Array.isArray(services)) return false
        for (const service of Object.values(services as Record<string, unknown>)) {
            if (service === null || typeof service !== 'object' || Array.isArray(service)) return false
            const serviceRecord = service as Record<string, unknown>
            if (serviceRecord.extends !== undefined) return false
            const build = serviceRecord.build
            if (build === undefined) continue
            if (typeof build === 'string') {
                if (!localBuildContext(build)) return false
                continue
            }
            if (build === null || typeof build !== 'object' || Array.isArray(build)) return false
            const buildRecord = build as Record<string, unknown>
            if (buildRecord.context !== undefined && !localBuildContext(buildRecord.context)) return false
            const additional = buildRecord.additional_contexts
            if (additional === undefined) continue
            if (Array.isArray(additional)) {
                if (additional.some((entry) => typeof entry !== 'string' || !entry.includes('=') || !localBuildContext(entry.slice(entry.indexOf('=') + 1)))) return false
            } else if (additional !== null && typeof additional === 'object') {
                if (Object.values(additional as Record<string, unknown>).some((entry) => !localBuildContext(entry))) return false
            } else return false
        }
        return true
    } catch {
        // Unparsable Compose source is not a local-build declaration; the caller refuses it.
        return false
    }
}

export function createRuntimeAdapter(
    rawInput: RuntimeAdapterInput,
    authority?: RuntimeAdapterAuthority,
): EnvironmentCommandOutcome<RuntimePlanResult> {
    let input = runtimeAdapterInput(snapshotJson(rawInput))
    if (input === undefined) return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime input must be bounded readable JSON data', 'runtime-input')
    const capturedAuthority = authority === undefined ? undefined
        : captureOwnValues(authority, ['ownComposeFiles', 'cockpitId', 'stackId'])
            ?? captureOwnValues(authority, ['ownComposeFiles', 'cockpitId', 'stackId', 'portLeaseProjection'])
            ?? captureOwnValues(authority, ['ownComposeFiles', 'cockpitId', 'stackId', 'siblingDirectories'])
            ?? captureOwnValues(authority, ['ownComposeFiles', 'cockpitId', 'stackId', 'portLeaseProjection', 'siblingDirectories'])
    const ownComposeFiles = capturedAuthority?.ownComposeFiles === true
    const suppliedPortProjection = capturedAuthority?.portLeaseProjection as PortLeaseProjection | undefined
    const portProjection = suppliedPortProjection === undefined ? undefined : inspectPortLeaseProjection(suppliedPortProjection)
    if ((authority !== undefined && (!capturedAuthority || !ownComposeFiles))
        || (suppliedPortProjection !== undefined && portProjection === undefined)) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime artifact authority is malformed', 'runtime-input')
    }
    let interpolatedNames: readonly string[] = []
    if (portProjection !== undefined) {
        const originalEnv = input.env
        const entries = Object.entries(portProjection.lease.ports).sort(([left], [right]) => left.localeCompare(right))
        const projectedPorts = entries.map(([, port]) => port).sort((left, right) => left - right)
        const requestedPorts = [...input.ports].sort((left, right) => left - right)
        if (input.stackId !== undefined && input.stackId !== portProjection.lease.stackId
            || entries.length === 0 || entries.some(([name]) => !/^[A-Z][A-Z0-9_]*$/.test(name)
                || HOST_PROCESS_CONTROL_ENV.test(name) || Object.hasOwn(originalEnv, name))
            || JSON.stringify(projectedPorts) !== JSON.stringify(requestedPorts)) {
            return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime port authority does not match the stack', input.projectName)
        }
        interpolatedNames = entries.map(([name]) => name)
        input = {
            ...input,
            env: { ...originalEnv, ...Object.fromEntries(entries.map(([name, port]) => [name, String(port)])) },
        }
    }
    // Sibling directories reach Compose the way the lease does: as named variables every derived
    // step keeps, so `${API_DIR}` in a cockpit's own file resolves instead of falling back.
    const suppliedSiblings = snapshotJson(capturedAuthority?.siblingDirectories)
    if (suppliedSiblings !== undefined) {
        const originalEnv = input.env
        const entries = suppliedSiblings !== null && typeof suppliedSiblings === 'object' && !Array.isArray(suppliedSiblings)
            ? Object.entries(suppliedSiblings as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)) : undefined
        if (entries === undefined || entries.some(([name, path]) => !/^[A-Z][A-Z0-9_]*$/.test(name)
            || HOST_PROCESS_CONTROL_ENV.test(name) || Object.hasOwn(originalEnv, name)
            || typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0'))) {
            return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime sibling directory authority is malformed', input.projectName)
        }
        interpolatedNames = [...interpolatedNames, ...entries.map(([name]) => name)]
        input = { ...input, env: { ...originalEnv, ...Object.fromEntries(entries) as Record<string, string> } }
    }
    if (ownComposeFiles) {
        const runtimeStackId = capturedAuthority?.stackId
        const runtimeCockpitId = capturedAuthority?.cockpitId
        if (typeof runtimeStackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(runtimeStackId)
            || typeof runtimeCockpitId !== 'string' || !/^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/.test(runtimeCockpitId)) {
            return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime identity labels are unavailable', input.projectName)
        }
        interpolatedNames = [...interpolatedNames, 'COCKPIT_OWNER_ID', 'COCKPIT_STACK_ID']
        input = { ...input, env: { ...input.env,
            COCKPIT_OWNER_ID: runtimeCockpitId, COCKPIT_STACK_ID: runtimeStackId } }
    }
    if (hasUnresolvedInput(input)) {
        return refusal(
            ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            'runtime plan contains an unresolved placeholder',
            'runtime-input',
        )
    }
    if (
        classifyResolvedRuntimeLiterals(exactInputValues(input)) === 'unsafe'
        || Object.keys(input.env).some((name) => name.startsWith('COMPOSE_'))
    ) {
        return refusal(
            ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            'runtime plan contains an unsafe literal or a compose environment override',
            'runtime-input',
        )
    }
    input = { ...input, env: composeProcessEnvironment(input.env) }
    if (!isAbsolute(input.cwd)) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime working directory must be absolute', input.cwd)
    }
    if (input.runtime.name !== 'docker' || !RUNTIME_OPERATIONS.includes(input.operation)) {
        return refusal(
            ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            'runtime and operation must be explicitly supported',
            `${input.runtime.name}:${input.operation}`,
        )
    }
    if (
        !isResolvedDockerExecutable(input.executable)
        || input.executable.sha256 !== input.runtime.executableSha256
        || !OBSERVED_VERSION.test(input.runtime.version)
        || !OBSERVED_VERSION.test(input.composeVersion)
        || !PROJECT_NAME.test(input.projectName)
    ) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime command or project name is invalid', input.projectName)
    }
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime timeout must be bounded to at most five minutes', String(input.timeoutMs))
    }
    if (input.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
        || new Set(input.ports).size !== input.ports.length) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime ports must be unique resolved host ports', input.projectName)
    }
    if (input.composeFiles.length === 0) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime plan needs at least one local compose file', input.cwd)
    }
    const unresolvedCompose = input.composeFiles.find((source) => UNRESOLVED_TOKEN.test(source.reference))
    if (unresolvedCompose !== undefined) {
        return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'compose reference contains an unresolved placeholder', unresolvedCompose.reference)
    }
    const files: string[] = []
    for (const source of input.composeFiles) {
        // Only the cockpit's own Compose files, declared as such by readiness, interpolate.
        if ((UNRESOLVED_TOKEN.test(source.source) && !(ownComposeFiles && composeTokensResolved(source.source, interpolatedNames)))
            || source.source.includes('\0')) {
            return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'compose artifact contains unresolved or unsafe data', source.reference)
        }
        if (createHash('sha256').update(source.source).digest('hex') !== source.sha256) {
            return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'compose artifact digest does not match its source', source.reference)
        }
        if (!composeBuildContextsSafe(source.source)) {
            return refusal(ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE, 'compose build contexts must be local, parseable, and structurally supported', source.reference)
        }
        const local = localComposePath(input.cwd, source)
        if (local === undefined) {
            return refusal(
                ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE,
                'compose references must be confined local files; remote and escaped references are refused',
                source.reference,
            )
        }
        files.push(local)
    }

    // A cockpit's own files resolve their relative paths as Compose does for the first file it is
    // given; without that authority the plan runs from the given directory.
    const projectDirectory = ownComposeFiles ? composeProjectDirectory(input.cwd, files) : input.cwd
    const compensation = input.operation === 'up'
        ? [composeStep(input, files, projectDirectory, 'down', [])]
        : []
    const step = composeStep(input, files, projectDirectory, input.operation, compensation)
    const plan = snapshotExecutionPlan({ steps: [step] })
    if (plan === undefined) return refusal(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, 'runtime input did not produce a valid execution plan', input.projectName)
    if (input.stackId && input.coldStartLimitMillis && input.expectedMountSources) {
        issuedRuntimePlans.set(plan, Object.freeze({
            operation: input.operation,
            stackId: input.stackId,
            coldStartLimitMillis: input.coldStartLimitMillis,
            expectedMountSources: Object.freeze([...input.expectedMountSources]),
            runtimeExecutable: Object.freeze({ ...input.executable }),
            cwd: input.cwd,
            env: Object.freeze({ ...input.env }),
            runtimeVersion: input.runtime.version,
            composeVersion: input.composeVersion,
            projectName: input.projectName,
            activeProfiles: Object.freeze([...(input.activeProfiles ?? [])]),
            configSha256: input.labels.configSha256 ?? '',
            interpolatedNames,
            ...(portProjection === undefined ? {} : { portLeaseProjection: portProjection }),
        }))
    }
    return {
        kind: 'preview',
        status: 0,
        diagnostics: [],
        result: { runtime: input.runtime.name, operation: input.operation, projectName: input.projectName },
        plan,
    }
}

export interface RuntimeObservationWindow {
    readonly startedAt: string
    readonly expiresAt: string
}

export interface RuntimeTopologyService {
    readonly id: string
    readonly dependsOn: readonly string[]
    readonly bindMountSources: readonly string[]
    readonly namedVolumeMounts?: readonly Readonly<{ readonly source: string; readonly name: string; readonly target: string }>[]
    readonly healthcheck: boolean
}

export interface RuntimeTopologyEvidence {
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly runtimeVersion: string
    readonly composeVersion: string
    readonly executableSha256: string
    readonly projectName: string
    readonly cwd: string
    readonly observationWindow: RuntimeObservationWindow
    readonly services: readonly RuntimeTopologyService[]
}

export type RuntimeTopologyPlan =
    | { readonly kind: 'planned'; readonly step: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly reason: string }

interface TopologyPlanContract {
    readonly runtimePlan: ExecutionPlan
    readonly runtime: RuntimeObservationContract
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly observationWindow: RuntimeObservationWindow
}

interface TopologyEvidenceContract extends TopologyPlanContract {
    readonly step: ExecutionStep
    readonly order: readonly string[]
    readonly services: ReadonlyMap<string, RuntimeTopologyService>
    readonly runtimeHealth: ReadonlyMap<string, RuntimeHealthServiceExpectation>
}

interface RuntimeBindMount {
    readonly source: string
    readonly target: string
}

interface RuntimePublishedPort {
    readonly hostIp: '127.0.0.1' | '::1' | '0.0.0.0' | '::'
    readonly target: number
    readonly published: number
    readonly protocol: 'tcp'
}

interface RuntimeHealthServiceExpectation {
    readonly bindMounts: readonly RuntimeBindMount[]
    readonly publishedPorts: readonly RuntimePublishedPort[]
}

const issuedTopologyPlans = new WeakMap<object, TopologyPlanContract>()
const consumedTopologyPlans = new WeakSet<object>()
const issuedTopologyEvidence = new WeakMap<object, TopologyEvidenceContract>()
const MAX_TOPOLOGY_BYTES = 1_048_576
const MAX_TOPOLOGY_SERVICES = 4_096
const MAX_TOPOLOGY_EDGES = 16_384
// One `up` starts every service inside a single observation window: the declared cold start plus
// headroom for stop graces and the ordinary probes around each start.
export const OBSERVATION_WINDOW_HEADROOM_MS = 300_000
const MAX_OBSERVATION_WINDOW_MS = MAX_COLD_START_SECONDS * 1_000 + OBSERVATION_WINDOW_HEADROOM_MS
// `compose stop` waits up to each service's stop grace (Compose default 10s) before it kills a
// process that ignores SIGTERM, which a shell or Node.js running as PID 1 does. It stops dependents
// before their dependencies, one dependency level at a time, so the grace is paid once per level. A
// stop held to the ordinary 10s command budget timed out on such a service and left the drain
// attempt for repair; one grace for a two-level stack timed out the same way.
const COMPOSE_STOP_GRACE_MS = 10_000

function dependencyLevels(services: ReadonlyMap<string, RuntimeTopologyService>): number {
    const levels = new Map<string, number>()
    const level = (id: string): number => {
        const known = levels.get(id)
        if (known !== undefined) return known
        const value = 1 + Math.max(0, ...(services.get(id)?.dependsOn ?? []).map(level))
        levels.set(id, value)
        return value
    }
    return Math.max(1, ...[...services.keys()].map(level))
}
const SERVICE_ID = /^[a-z0-9][a-z0-9_.-]*$/
const CONTAINER_ID = /^[a-f0-9]{64}$/
const SHORT_CONTAINER_ID = /^[a-f0-9]{12}$/

function unavailableReason(base: string, error?: unknown): string {
    return error === undefined ? base : `${base}: ${errorCause(error)}`
}

function unavailableTopology(reason = 'runtime topology is unavailable'): RuntimeTopologyPlan {
    return { kind: 'unavailable', reason }
}

function canonicalWindow(value: RuntimeObservationWindow): RuntimeObservationWindow | undefined {
    try {
        const captured = captureOwnValues(value, ['startedAt', 'expiresAt'])
        const startedAtValue = captured?.startedAt
        const expiresAtValue = captured?.expiresAt
        if (typeof startedAtValue !== 'string' || typeof expiresAtValue !== 'string'
            || !isCanonicalTimestamp(startedAtValue) || !isCanonicalTimestamp(expiresAtValue)) return undefined
        const startedAt = Date.parse(startedAtValue)
        const expiresAt = Date.parse(expiresAtValue)
        if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)
            || Math.abs(expiresAt - startedAt) > MAX_OBSERVATION_WINDOW_MS) return undefined
        return { startedAt: startedAtValue, expiresAt: expiresAtValue }
    } catch {
        // A throwing accessor or proxy trap makes the window malformed, which the caller refuses.
        return undefined
    }
}

function runtimeCommandEnvironment(
    env: Readonly<Record<string, string>>,
    interpolatedNames: readonly string[],
): Readonly<Record<string, string>> {
    const allowed = new Set([...DOCKER_CLIENT_ENVIRONMENT, ...interpolatedNames])
    return Object.fromEntries(Object.entries(env).filter(([name]) => allowed.has(name)))
}

function runtimeComposeEnvironment(
    env: Readonly<Record<string, string>>,
    interpolatedNames: readonly string[],
): Readonly<Record<string, string>> {
    return composeProcessEnvironment(runtimeCommandEnvironment(env, interpolatedNames))
}

function derivedComposeStep(base: ExecutionStep, id: string, operation: string, operationArgs: readonly string[], stdoutLimitBytes: number, issuanceId: string, timeoutLimitMs = MAX_OBSERVATION_WINDOW_MS, spawnNotAfter?: string, interpolatedNames: readonly string[] = []): ExecutionStep | undefined {
    const configIndex = base.argv.lastIndexOf('config')
    const suffix = base.argv.slice(configIndex)
    if (configIndex < 1 || !(suffix.length === 2 && suffix[1] === '--quiet')
        && !(suffix.length === 4 && suffix[1] === '--format' && suffix[2] === 'json'
            && suffix[3] === '--no-env-resolution')) return undefined
    const env = runtimeComposeEnvironment(base.env, interpolatedNames)
    const step: ExecutionStep = {
        ...base,
        id,
        argv: [...base.argv.slice(0, configIndex), ...operationArgs] as [string, ...string[]],
        env,
        timeoutMs: Math.min(base.timeoutMs, MAX_OBSERVATION_WINDOW_MS, timeoutLimitMs),
        ...(spawnNotAfter === undefined ? {} : { spawnNotAfter }),
        stdoutLimitBytes,
        stderrLimitBytes: OUTPUT_LIMIT_BYTES,
        ports: [],
        labels: { ...base.labels, operation, issuanceId },
        compensation: [],
    }
    return snapshotExecutionPlan({ steps: [step] })?.steps[0]
}

export function createRuntimeTopologyPlan(input: {
    readonly runtimePlan: ExecutionPlan
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly observationWindow: RuntimeObservationWindow
}): RuntimeTopologyPlan {
    try {
        const captured = captureOwnValues(input, ['runtimePlan', 'stackId', 'configSha256', 'batchId', 'observationWindow'])
        const runtimePlan = captured?.runtimePlan as ExecutionPlan | undefined
        const stackId = captured?.stackId
        const configSha256 = captured?.configSha256
        const batchId = captured?.batchId
        const runtime = runtimePlan && typeof runtimePlan === 'object' ? issuedRuntimePlans.get(runtimePlan) : undefined
        const base = runtimePlan?.steps?.[0]
        const window = canonicalWindow(captured?.observationWindow as RuntimeObservationWindow)
        if (!runtime || runtime.operation !== 'validate' || !base || !window
            || typeof stackId !== 'string' || stackId !== runtime.stackId
            || typeof configSha256 !== 'string' || !SHA256.test(configSha256)
            || typeof batchId !== 'string' || !SHA256.test(batchId)
            || base.labels.stackId !== stackId || base.labels.configSha256 !== configSha256
            || base.labels.batchId !== batchId || base.labels.composeVersion !== runtime.composeVersion
            || base.cwd !== runtime.cwd || base.argv0 !== runtime.runtimeExecutable.invocationPath) return unavailableTopology()
        const issuanceId = randomBytes(32).toString('hex')
        const step = derivedComposeStep(
            base,
            `runtime:docker-compose:topology:${runtime.projectName}`,
            'config',
            ['config', '--format', 'json', '--no-env-resolution'],
            MAX_TOPOLOGY_BYTES,
            issuanceId,
            MAX_OBSERVATION_WINDOW_MS,
            undefined,
            runtime.interpolatedNames,
        )
        if (!step) return unavailableTopology()
        const plan = { kind: 'planned' as const, step }
        issuedTopologyPlans.set(plan, Object.freeze({
            runtimePlan,
            runtime,
            stackId: stackId as StackId,
            configSha256,
            batchId,
            observationWindow: window,
        }))
        return plan
    } catch (error) {
        return unavailableTopology(unavailableReason('runtime topology is unavailable', error))
    }
}

function healthcheckEnabled(value: unknown): boolean | undefined {
    if (value === undefined) return false
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const healthcheck = value as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(healthcheck, 'disable') && typeof healthcheck.disable !== 'boolean') return undefined
    if (Object.prototype.hasOwnProperty.call(healthcheck, 'test')) {
        if (!Array.isArray(healthcheck.test) || healthcheck.test.length > MAX_TOPOLOGY_SERVICES
            || healthcheck.test.some((part) => !(typeof part === 'string' && part.length <= OUTPUT_LIMIT_BYTES)
                && typeof part !== 'boolean' && !(typeof part === 'number' && Number.isFinite(part)))) return undefined
    }
    return healthcheck.disable !== true && !(Array.isArray(healthcheck.test) && healthcheck.test[0] === 'NONE')
}

function dependencyNames(value: unknown): readonly string[] | undefined {
    if (value === undefined) return []
    if (Array.isArray(value)) {
        if (value.some((item) => typeof item !== 'string' || !SERVICE_ID.test(item))) return undefined
        return [...new Set(value)].sort()
    }
    if (value === null || typeof value !== 'object') return undefined
    const names = Object.keys(value)
    if (names.some((name) => !SERVICE_ID.test(name))) return undefined
    return [...new Set(names)].sort()
}

function profileNames(value: unknown): readonly string[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_TOPOLOGY_SERVICES
        || value.some((name) => typeof name !== 'string' || !SERVICE_ID.test(name))) return undefined
    return [...new Set(value)].sort()
}

function bindMountSources(value: unknown): readonly string[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_TOPOLOGY_EDGES) return undefined
    const sources: string[] = []
    for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
        const volume = item as Record<string, unknown>
        if (volume.type !== 'bind') continue
        if (typeof volume.source !== 'string' || !isAbsolute(volume.source)
            || normalize(volume.source) !== volume.source || volume.source.includes('\0')) return undefined
        sources.push(volume.source)
    }
    return [...new Set(sources)].sort()
}

function bindMounts(value: unknown): readonly RuntimeBindMount[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_TOPOLOGY_EDGES) return undefined
    const mounts: RuntimeBindMount[] = []
    for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
        const volume = item as Record<string, unknown>
        if (volume.type !== 'bind') continue
        if (typeof volume.source !== 'string' || !isAbsolute(volume.source)
            || normalize(volume.source) !== volume.source || volume.source.includes('\0')
            || typeof volume.target !== 'string' || !CONTAINER_PATH.test(volume.target)) return undefined
        mounts.push({ source: volume.source, target: volume.target })
    }
    const identities = mounts.map(({ source, target }) => `${source}\0${target}`)
    if (new Set(identities).size !== identities.length) return undefined
    return [...mounts].sort((left, right) => `${left.source}\0${left.target}`.localeCompare(`${right.source}\0${right.target}`))
}

const PUBLISHED_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

function composePublishedPorts(value: unknown): readonly RuntimePublishedPort[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_TOPOLOGY_EDGES) return undefined
    const ports: RuntimePublishedPort[] = []
    for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
        const row = item as Record<string, unknown>
        const target = row.target
        const rawPublished = row.published
        const published = typeof rawPublished === 'string' && /^[1-9]\d{0,4}$/.test(rawPublished)
            ? Number(rawPublished) : rawPublished
        const hostIp = row.host_ip ?? '0.0.0.0'
        const protocol = row.protocol ?? 'tcp'
        if (!Number.isSafeInteger(target) || (target as number) < 1 || (target as number) > 65_535
            || !Number.isSafeInteger(published) || (published as number) < 1 || (published as number) > 65_535
            || typeof hostIp !== 'string' || !PUBLISHED_HOSTS.has(hostIp) || protocol !== 'tcp') return undefined
        ports.push({
            hostIp: hostIp as RuntimePublishedPort['hostIp'],
            target: target as number,
            published: published as number,
            protocol: 'tcp',
        })
    }
    const identities = ports.map(({ hostIp, target, published, protocol }) => `${hostIp}\0${published}\0${target}\0${protocol}`)
    if (new Set(identities).size !== identities.length) return undefined
    return [...ports].sort((left, right) =>
        `${left.hostIp}\0${left.published}\0${left.target}`.localeCompare(`${right.hostIp}\0${right.published}\0${right.target}`))
}

const RUNTIME_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const CONTAINER_PATH = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*[\\\x00-\x1f\x7f])\S+$/

function runtimeVolumeNames(value: unknown): ReadonlyMap<string, string> | undefined {
    if (value === undefined) return new Map()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value)
    if (entries.length > MAX_TOPOLOGY_EDGES) return undefined
    const names = new Map<string, string>()
    for (const [source, candidate] of entries) {
        if (!SERVICE_ID.test(source) || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
        const name = (candidate as Record<string, unknown>).name
        if (typeof name !== 'string' || !RUNTIME_VOLUME.test(name)) return undefined
        names.set(source, name)
    }
    return names
}

function namedVolumeMounts(
    value: unknown,
    volumeNames: ReadonlyMap<string, string>,
): readonly Readonly<{ readonly source: string; readonly name: string; readonly target: string }>[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_TOPOLOGY_EDGES) return undefined
    const mounts: Readonly<{ readonly source: string; readonly name: string; readonly target: string }>[] = []
    for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
        const volume = item as Record<string, unknown>
        if (volume.type !== 'volume') continue
        const source = volume.source
        const target = volume.target
        const name = typeof source === 'string' ? volumeNames.get(source) : undefined
        if (typeof source !== 'string' || !SERVICE_ID.test(source) || !name
            || typeof target !== 'string' || !CONTAINER_PATH.test(target)) return undefined
        mounts.push({ source, name, target })
    }
    const identities = mounts.map(({ source, target }) => `${source}\0${target}`)
    if (new Set(identities).size !== identities.length) return undefined
    return [...mounts].sort((left, right) => `${left.source}\0${left.target}`.localeCompare(`${right.source}\0${right.target}`))
}

// Compose prints labels as a mapping, but as a `KEY=VALUE` list once an override merges labels into
// a service that already has some; reading only the mapping refused every such merged service.
function composeLabels(value: unknown): Readonly<Record<string, unknown>> | null | undefined {
    if (!Array.isArray(value)) return value as Readonly<Record<string, unknown>> | null | undefined
    const entries: [string, string][] = []
    for (const item of value) {
        if (typeof item !== 'string' || !item.includes('=')) return null
        entries.push([item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)])
    }
    const labels = Object.fromEntries(entries)
    return Object.keys(labels).length === entries.length ? labels : null
}

function parseTopology(stdout: Buffer, stackId: StackId, configSha256: string, activeProfiles: readonly string[]): {
    readonly services: readonly RuntimeTopologyService[]
    readonly order: readonly string[]
    readonly byId: ReadonlyMap<string, RuntimeTopologyService>
    readonly runtimeHealth: ReadonlyMap<string, RuntimeHealthServiceExpectation>
} | undefined {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
        const parsed: unknown = JSON.parse(source)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
        const rawServices = (parsed as Record<string, unknown>).services
        if (rawServices === null || typeof rawServices !== 'object' || Array.isArray(rawServices)) return undefined
        const volumeNames = runtimeVolumeNames((parsed as Record<string, unknown>).volumes)
        if (!volumeNames) return undefined
        const declaredNames = Object.keys(rawServices)
        if (declaredNames.length === 0 || declaredNames.length > MAX_TOPOLOGY_SERVICES || declaredNames.some((name) => !SERVICE_ID.test(name))) return undefined
        const profiles = new Map<string, readonly string[]>()
        for (const name of declaredNames) {
            const raw = (rawServices as Record<string, unknown>)[name]
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
            const selected = profileNames((raw as Record<string, unknown>).profiles)
            if (!selected) return undefined
            profiles.set(name, selected)
        }
        const active = new Set(activeProfiles)
        const names = declaredNames.filter((name) => {
            const serviceProfiles = profiles.get(name) ?? []
            return serviceProfiles.length === 0 || serviceProfiles.some((profile) => active.has(profile))
        })
        if (names.length === 0) return undefined
        names.sort()
        const known = new Set(names)
        const byId = new Map<string, RuntimeTopologyService>()
        const runtimeHealth = new Map<string, RuntimeHealthServiceExpectation>()
        let edgeCount = 0
        for (const id of names) {
            const raw = (rawServices as Record<string, unknown>)[id]
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
            const service = raw as Record<string, unknown>
            const dependsOn = dependencyNames(service.depends_on)
            const mounts = bindMountSources(service.volumes)
            const exactBindMounts = bindMounts(service.volumes)
            const namedMounts = namedVolumeMounts(service.volumes, volumeNames)
            const publishedPorts = composePublishedPorts(service.ports)
            const healthcheck = healthcheckEnabled(service.healthcheck)
            const labels = composeLabels(service.labels)
            if (!dependsOn || !mounts || !exactBindMounts || !namedMounts || !publishedPorts || healthcheck === undefined || dependsOn.includes(id) || dependsOn.some((name) => !known.has(name))
                || labels === null || typeof labels !== 'object' || Array.isArray(labels)
                || (labels as Record<string, unknown>)['dev.b0dea.cockpit.stack-id'] !== stackId
                || (labels as Record<string, unknown>)['dev.b0dea.cockpit.config-sha256'] !== configSha256) return undefined
            edgeCount += dependsOn.length + mounts.length + namedMounts.length + publishedPorts.length
            if (edgeCount > MAX_TOPOLOGY_EDGES) return undefined
            byId.set(id, {
                id,
                dependsOn,
                bindMountSources: mounts,
                namedVolumeMounts: namedMounts,
                healthcheck,
            })
            runtimeHealth.set(id, { bindMounts: exactBindMounts, publishedPorts })
        }
        const indegree = new Map(names.map((name) => [name, byId.get(name)?.dependsOn.length ?? 0]))
        const dependents = new Map(names.map((name) => [name, [] as string[]]))
        for (const service of byId.values()) for (const dependency of service.dependsOn) dependents.get(dependency)?.push(service.id)
        for (const values of dependents.values()) values.sort()
        const ready = names.filter((name) => indegree.get(name) === 0)
        const order: string[] = []
        while (ready.length > 0) {
            const next = ready.shift()
            if (next === undefined) return undefined
            order.push(next)
            for (const dependent of dependents.get(next) ?? []) {
                const remaining = (indegree.get(dependent) ?? 0) - 1
                indegree.set(dependent, remaining)
                if (remaining === 0) {
                    ready.push(dependent)
                    ready.sort()
                }
            }
        }
        if (order.length !== names.length) return undefined
        return { services: names.map((name) => byId.get(name) as RuntimeTopologyService), order, byId, runtimeHealth }
    } catch {
        // A malformed declaration shape yields no topology, which the caller reports as unavailable.
        return undefined
    }
}

/** Declared mount sources no service binds inside, and bind sources inside no declared one. */
export type RuntimeMountMismatch = Readonly<{ missing: readonly string[]; unexpected: readonly string[] }>

function mountSourcesMatch(binds: readonly string[], declared: readonly string[]): boolean {
    const { missing, unexpected } = compareBindSources(binds, declared)
    return missing.length === 0 && unexpected.length === 0
}

export function admitRuntimeTopology(input: {
    readonly plan: RuntimeTopologyPlan
    readonly outcome: ExecuteProbeOutcome
}): { readonly kind: 'complete'; readonly topology: RuntimeTopologyEvidence; readonly observations: readonly EnvironmentObservation[] }
    | { readonly kind: 'unavailable'; readonly reason: string; readonly mounts?: RuntimeMountMismatch } {
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, reason: unavailableReason('runtime topology is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as RuntimeTopologyPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (!plan || plan.kind !== 'planned' || consumedTopologyPlans.has(plan)) return unavailable()
        const contract = issuedTopologyPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.step) : undefined
        if (!contract || !outcome) return unavailable()
        consumedTopologyPlans.add(plan)
        if (outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0 || !outcome.receipt) return unavailable()
        const { startedAt, finishedAt } = outcome.receipt
        const windowStart = Date.parse(contract.observationWindow.startedAt)
        const windowEnd = Date.parse(contract.observationWindow.expiresAt)
        const receiptStart = Date.parse(startedAt)
        const receiptEnd = Date.parse(finishedAt)
        const now = Date.now()
        if (!isCanonicalTimestamp(startedAt) || !isCanonicalTimestamp(finishedAt)
            || windowStart > receiptStart || receiptStart > receiptEnd || receiptEnd > now || receiptEnd > windowEnd
            || now < windowStart || now > windowEnd) return unavailable()
        const projected = parseTopology(outcome.stdout, contract.stackId, contract.configSha256, contract.runtime.activeProfiles)
        if (!projected) return unavailable()
        const mounts = compareBindSources(projected.services.flatMap(({ bindMountSources }) => bindMountSources),
            contract.runtime.expectedMountSources)
        // The caller can name the sibling or host path behind each difference; a bare refusal here
        // left `up` reporting only that readiness authority was unavailable.
        if (mounts.missing.length > 0 || mounts.unexpected.length > 0) return {
            kind: 'unavailable' as const,
            reason: 'the bind mounts Compose resolves differ from the declared mount sources',
            mounts,
        }
        const topology = {
            stackId: contract.stackId,
            configSha256: contract.configSha256,
            batchId: contract.batchId,
            runtimeVersion: contract.runtime.runtimeVersion,
            composeVersion: contract.runtime.composeVersion,
            executableSha256: contract.runtime.runtimeExecutable.sha256,
            projectName: contract.runtime.projectName,
            cwd: contract.runtime.cwd,
            observationWindow: contract.observationWindow,
            services: projected.services,
        }
        issuedTopologyEvidence.set(topology, Object.freeze({
            ...contract,
            step: plan.step,
            order: projected.order,
            services: projected.byId,
            runtimeHealth: projected.runtimeHealth,
        }))
        const observations = [
            issueObservation({
                code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
                owner: OWNER,
                stackId: contract.stackId,
                source: plan.step.argv0,
                observed: { state: 'available', value: true, observedAt: finishedAt },
                expectation: { kind: 'equal', value: true },
                applicability: { state: 'required', posture: 'mounted' },
                freshness: { state: 'current' },
                remedy: 'restore the declared runtime executable and retry the bounded probe',
            }),
            issueObservation({
                code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE,
                owner: OWNER,
                stackId: contract.stackId,
                source: plan.step.id,
                observed: { state: 'available', value: true, observedAt: finishedAt },
                expectation: { kind: 'equal', value: true },
                applicability: { state: 'required', posture: 'mounted' },
                freshness: { state: 'current' },
                remedy: 'restore every declared bind source and refuse undeclared host binds',
            }),
        ]
        return { kind: 'complete', topology, observations }
    } catch (error) {
        return unavailable(error)
    }
}

export function isRuntimeTopologyEvidence(value: unknown): value is RuntimeTopologyEvidence {
    if (value === null || typeof value !== 'object') return false
    const contract = issuedTopologyEvidence.get(value)
    const now = Date.now()
    return contract !== undefined && Date.parse(contract.observationWindow.startedAt) <= now
        && now <= Date.parse(contract.observationWindow.expiresAt)
}

export function resolveRuntimeServiceOrder(topology: RuntimeTopologyEvidence): readonly string[] {
    const contract = topology !== null && typeof topology === 'object' ? issuedTopologyEvidence.get(topology) : undefined
    const now = Date.now()
    return contract && Date.parse(contract.observationWindow.startedAt) <= now
        && now <= Date.parse(contract.observationWindow.expiresAt) ? [...contract.order] : []
}

export function projectRuntimeExecutionEnvironment(
    topology: RuntimeTopologyEvidence,
    namespace?: StateNamespace,
): Readonly<Record<string, string>> | undefined {
    const contract = topology !== null && typeof topology === 'object' ? issuedTopologyEvidence.get(topology) : undefined
    if (namespace !== undefined && (!contract?.runtime.portLeaseProjection
        || !inspectPortLeaseProjection(contract.runtime.portLeaseProjection, namespace))) return undefined
    const now = Date.now()
    return contract && Date.parse(contract.observationWindow.startedAt) <= now
        && now <= Date.parse(contract.observationWindow.expiresAt)
        ? runtimeCommandEnvironment(contract.runtime.env, contract.runtime.interpolatedNames)
        : undefined
}

export type RuntimeContainerIdSlot = Readonly<{ kind: 'runtime-container-id'; service: string }>

export interface RuntimeLifecycleExecutionSemantics {
    readonly argv: readonly [string | RuntimeContainerIdSlot, ...(string | RuntimeContainerIdSlot)[]]
    readonly argv0: string
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutCeilingMs: number
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
    readonly paths: readonly string[]
    readonly ports: readonly number[]
    readonly expected: ExecutionStep['expected']
    readonly consumedFiles: ExecutionStep['consumedFiles']
    readonly filesystemChecks: ExecutionStep['filesystemChecks']
    readonly compensation: readonly RuntimeLifecycleExecutionSemantics[]
}

export interface RuntimeLifecycleServiceSemantics {
    readonly id: string
    readonly start: RuntimeLifecycleExecutionSemantics
    readonly status: RuntimeLifecycleExecutionSemantics
    readonly identity: RuntimeLifecycleExecutionSemantics
    readonly inspect: RuntimeLifecycleExecutionSemantics
    readonly healthAcceptance: Readonly<{ state: 'running'; health: 'healthy' | null }>
}

export interface RuntimeLifecycleSemantics {
    readonly stackId: StackId
    readonly configSha256: string
    readonly runtimeVersion: string
    readonly composeVersion: string
    readonly projectName: string
    readonly topology: Readonly<{
        order: readonly string[]
        services: readonly RuntimeTopologyService[]
    }>
    readonly runtimeChecks: Readonly<{
        coldStartLimitMillis: number
        expectedMountSources: readonly string[]
    }>
    readonly services: readonly RuntimeLifecycleServiceSemantics[]
}

declare const runtimeLifecycleProjectionBrand: unique symbol
export interface RuntimeLifecycleProjection {
    readonly [runtimeLifecycleProjectionBrand]: true
}

export interface RuntimeLifecycleEnvelope {
    readonly topology: RuntimeTopologyEvidence
    readonly semantics: RuntimeLifecycleSemantics
}

interface RuntimeLifecycleProjectionContract {
    readonly topology: RuntimeTopologyEvidence
    readonly semantics: RuntimeLifecycleSemantics
    readonly observationWindow: RuntimeObservationWindow
}

const issuedRuntimeLifecycleProjections = new WeakMap<object, RuntimeLifecycleProjectionContract>()
const consumedRuntimeLifecycleProjections = new WeakSet<object>()

function freezeRuntimeValue<Value>(value: Value): Value {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const item of Object.values(value)) freezeRuntimeValue(item)
    return value
}

function projectRuntimeExecutionStep(step: ExecutionStep, slot?: Readonly<{ index: number; service: string }>): RuntimeLifecycleExecutionSemantics | undefined {
    const argv = step.argv.map((value, index) => slot?.index === index
        ? { kind: 'runtime-container-id' as const, service: slot.service }
        : value)
    if (argv.length === 0 || slot && (slot.index < 0 || slot.index >= argv.length)) return undefined
    const compensation = step.compensation.map((item) => projectRuntimeExecutionStep(item))
    if (compensation.some((item) => item === undefined)) return undefined
    return freezeRuntimeValue({
        argv: argv as [string | RuntimeContainerIdSlot, ...(string | RuntimeContainerIdSlot)[]],
        argv0: step.argv0,
        cwd: step.cwd,
        env: { ...step.env },
        timeoutCeilingMs: step.timeoutMs,
        stdoutLimitBytes: step.stdoutLimitBytes,
        stderrLimitBytes: step.stderrLimitBytes,
        paths: [...step.paths],
        ports: [...step.ports],
        expected: step.expected.map((item) => ({ ...item })),
        consumedFiles: step.consumedFiles.map((item) => ({ ...item, argvIndexes: [...item.argvIndexes] })),
        filesystemChecks: step.filesystemChecks.map((item) => ({ ...item })),
        compensation: compensation as RuntimeLifecycleExecutionSemantics[],
    })
}

export type RuntimeServicePlan =
    | { readonly kind: 'planned'; readonly service: string; readonly start: ExecutionStep; readonly status: ExecutionStep; readonly identity: ExecutionStep
        /** Stops, without removing, the service this plan started when it did not become healthy. */
        readonly stop: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

export type RuntimeServiceHealthPlan =
    | { readonly kind: 'planned'; readonly service: string; readonly step: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

export type RuntimeServiceRevalidationPlan =
    | { readonly kind: 'planned'; readonly service: string; readonly expectedContainerId: string; readonly status: ExecutionStep; readonly identity: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

export type RuntimeServiceRevalidationResult =
    | { readonly kind: 'planned'; readonly service: string; readonly expectedContainerId: string; readonly plan: Extract<RuntimeServiceHealthPlan, { readonly kind: 'planned' }> }
    | { readonly kind: 'stale'; readonly service: string; readonly expectedContainerId: string }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

declare const runtimeServiceFailureEvidenceBrand: unique symbol
export interface RuntimeServiceFailureEvidence {
    readonly [runtimeServiceFailureEvidenceBrand]: true
}

export interface RuntimeServiceEvidence {
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly runtimeVersion: string
    readonly composeVersion: string
    readonly executableSha256: string
    readonly projectName: string
    readonly service: string
    readonly containerId: string
    readonly state: 'running'
    readonly health: 'healthy' | null
    readonly observedAt: string
    readonly observationWindow: RuntimeObservationWindow
}

export interface RuntimeServiceObservation {
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly runtimeVersion: string
    readonly composeVersion: string
    readonly executableSha256: string
    readonly projectName: string
    readonly service: string
    readonly containerId: string
    readonly state: 'created' | 'running' | 'restarting' | 'paused' | 'exited' | 'dead' | 'removing'
    readonly health: 'healthy' | 'starting' | 'unhealthy' | null
    readonly observedAt: string
    readonly observationWindow: RuntimeObservationWindow
}

interface RuntimeServicePlanContract {
    readonly topology: RuntimeTopologyEvidence
    readonly topologyContract: TopologyEvidenceContract
    readonly service: RuntimeTopologyService
}

interface RuntimeServiceHealthPlanContract extends RuntimeServicePlanContract {
    readonly containerId: string
    readonly startStartedAt?: string
    readonly identityFinishedAt: string
}

interface RuntimeServiceRevalidationPlanContract extends RuntimeServicePlanContract {
    readonly expectedContainerId: string
}

const issuedRuntimeServicePlans = new WeakMap<object, RuntimeServicePlanContract>()
const consumedRuntimeServicePlans = new WeakSet<object>()
const admittedRuntimeServiceStages = new WeakMap<object, {
    readonly startOutcome: object
    readonly statusOutcome?: object
    readonly identityOutcome?: object
}>()
const issuedRuntimeServiceRevalidationPlans = new WeakMap<object, RuntimeServiceRevalidationPlanContract>()
const consumedRuntimeServiceRevalidationPlans = new WeakSet<object>()
const admittedRuntimeServiceRevalidationStatuses = new WeakMap<object, object>()
const issuedRuntimeServiceHealthPlans = new WeakMap<object, RuntimeServiceHealthPlanContract>()
const consumedRuntimeServiceHealthPlans = new WeakSet<object>()
const issuedRuntimeServiceObservations = new WeakMap<object, RuntimeServiceEvidenceContract>()
const consumedRuntimeServiceHealthObservations = new WeakSet<object>()
const consumedRuntimeServiceFailureObservations = new WeakSet<object>()
const issuedRuntimeServiceEvidence = new WeakMap<object, RuntimeServiceEvidenceContract>()
const issuedRuntimeServiceFailures = new WeakMap<object, RuntimeServiceFailureLogContext>()

function unavailableRuntimeService(service: unknown, error?: unknown): RuntimeServicePlan {
    return { kind: 'unavailable', service: typeof service === 'string' ? service : '', reason: unavailableReason('runtime service is unavailable', error) }
}

interface RuntimeServiceInitialSteps {
    readonly start: ExecutionStep
    readonly stop: ExecutionStep
    readonly status: ExecutionStep
    readonly identity: ExecutionStep
}

interface RuntimeServiceLookupSteps {
    readonly status: ExecutionStep
    readonly identity: ExecutionStep
}

function runtimeServiceLookupSteps(
    topologyContract: TopologyEvidenceContract,
    service: RuntimeTopologyService,
    issuanceId: string,
): RuntimeServiceLookupSteps | undefined {
    const status = derivedComposeStep(
        topologyContract.step,
        `runtime:docker-compose:status:${service.id}`,
        'ps',
        ['ps', '--format', 'json', '--all', service.id],
        OUTPUT_LIMIT_BYTES,
        issuanceId,
        MAX_OBSERVATION_WINDOW_MS,
        undefined,
        topologyContract.runtime.interpolatedNames,
    )
    const identity = derivedComposeStep(
        topologyContract.step,
        `runtime:docker-compose:identity:${service.id}`,
        'ps',
        ['ps', '--quiet', '--all', service.id],
        128,
        issuanceId,
        MAX_OBSERVATION_WINDOW_MS,
        undefined,
        topologyContract.runtime.interpolatedNames,
    )
    return status && identity ? { status, identity } : undefined
}

function runtimeServiceInitialSteps(
    topologyContract: TopologyEvidenceContract,
    service: RuntimeTopologyService,
    issuanceId: string,
): RuntimeServiceInitialSteps | undefined {
    // `up --wait` returns only once the service runs and its healthcheck passes, after Compose has
    // built or pulled its image, and the declared cold_start_seconds bounds exactly that. The
    // ordinary command budget does not: a first `up` was killed and reported "did not become
    // healthy" seconds before its container turned healthy. When the service's configuration
    // changed since its container was created, `up` first stops that container and pays its stop
    // grace; a start without that grace was killed mid-recreate, leaving the replacement container
    // created but never started.
    const start = derivedComposeStep(
        { ...topologyContract.step, timeoutMs: COMPOSE_STOP_GRACE_MS
            + Math.max(topologyContract.step.timeoutMs, topologyContract.runtime.coldStartLimitMillis) },
        `runtime:docker-compose:start:${service.id}`,
        'up',
        ['--progress', 'quiet', 'up', '--detach', '--wait', '--no-deps', service.id],
        OUTPUT_LIMIT_BYTES,
        issuanceId,
        MAX_OBSERVATION_WINDOW_MS,
        undefined,
        topologyContract.runtime.interpolatedNames,
    )
    // A service that failed its start under a restart policy restarts forever until `down`. The
    // failed `up` stops it and keeps the container, so its logs stay readable and the next `up`
    // starts it again.
    const stop = derivedComposeStep(
        { ...topologyContract.step, timeoutMs: COMPOSE_STOP_GRACE_MS + topologyContract.step.timeoutMs },
        `runtime:docker-compose:stop:${service.id}`,
        'stop',
        ['--progress', 'quiet', 'stop', service.id],
        OUTPUT_LIMIT_BYTES,
        issuanceId,
        MAX_OBSERVATION_WINDOW_MS,
        undefined,
        topologyContract.runtime.interpolatedNames,
    )
    const lookup = runtimeServiceLookupSteps(topologyContract, service, issuanceId)
    return start && stop && lookup ? { start, stop, ...lookup } : undefined
}

export function createRuntimeServicePlan(input: { readonly topology: RuntimeTopologyEvidence; readonly service: string }): RuntimeServicePlan {
    try {
        const captured = captureOwnValues(input, ['topology', 'service'])
        const topology = captured?.topology as RuntimeTopologyEvidence | undefined
        const serviceId = captured?.service
        const topologyContract = topology && typeof topology === 'object' ? issuedTopologyEvidence.get(topology) : undefined
        const service = typeof serviceId === 'string' ? topologyContract?.services.get(serviceId) : undefined
        if (!topology || !topologyContract || !service || typeof serviceId !== 'string' || !SERVICE_ID.test(serviceId)
            || Date.now() < Date.parse(topologyContract.observationWindow.startedAt)
            || Date.now() > Date.parse(topologyContract.observationWindow.expiresAt)) return unavailableRuntimeService(serviceId)
        const issuanceId = randomBytes(32).toString('hex')
        const steps = runtimeServiceInitialSteps(topologyContract, service, issuanceId)
        if (!steps) return unavailableRuntimeService(serviceId)
        const plan = { kind: 'planned' as const, service: serviceId, ...steps }
        issuedRuntimeServicePlans.set(plan, Object.freeze({ topology, topologyContract, service }))
        return plan
    } catch (error) {
        return unavailableRuntimeService('', error)
    }
}

export function createRuntimeServiceRevalidationPlan(input: {
    readonly topology: RuntimeTopologyEvidence
    readonly service: string
    readonly expectedContainerId: string
}): RuntimeServiceRevalidationPlan {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service revalidation is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['topology', 'service', 'expectedContainerId'])
        const topology = captured?.topology as RuntimeTopologyEvidence | undefined
        const serviceId = captured?.service
        const expectedContainerId = captured?.expectedContainerId
        if (typeof serviceId === 'string') serviceName = serviceId
        const topologyContract = topology && typeof topology === 'object' ? issuedTopologyEvidence.get(topology) : undefined
        const service = typeof serviceId === 'string' ? topologyContract?.services.get(serviceId) : undefined
        const now = Date.now()
        if (!topology || !topologyContract || !service || typeof serviceId !== 'string' || !SERVICE_ID.test(serviceId)
            || typeof expectedContainerId !== 'string' || !CONTAINER_ID.test(expectedContainerId)
            || now < Date.parse(topologyContract.observationWindow.startedAt)
            || now > Date.parse(topologyContract.observationWindow.expiresAt)) return unavailable()
        const steps = runtimeServiceLookupSteps(topologyContract, service, randomBytes(32).toString('hex'))
        if (!steps) return unavailable()
        const plan = { kind: 'planned' as const, service: serviceId, expectedContainerId, ...steps }
        issuedRuntimeServiceRevalidationPlans.set(plan, Object.freeze({ topology, topologyContract, service, expectedContainerId }))
        return plan
    } catch (error) {
        return unavailable(error)
    }
}

type RuntimeServiceOutput<Value> =
    | { readonly kind: 'empty' }
    | { readonly kind: 'valid'; readonly value: Value }
    | { readonly kind: 'malformed' }

function classifyComposeStatus(stdout: Buffer, projectName: string, service: string): RuntimeServiceOutput<string> {
    if (stdout.byteLength === 0) return { kind: 'empty' }
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
        const lines = source.split('\n')
        if (lines.at(-1) === '') lines.pop()
        if (lines.length !== 1 || lines[0]?.length === 0) return { kind: 'malformed' }
        const parsed: unknown = JSON.parse(lines[0] as string)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'malformed' }
        const value = parsed as Record<string, unknown>
        if (typeof value.ID !== 'string' || !SHORT_CONTAINER_ID.test(value.ID)
            || value.Project !== projectName || value.Service !== service) return { kind: 'malformed' }
        return { kind: 'valid', value: value.ID }
    } catch {
        // Unparsable output is the malformed verdict.
        return { kind: 'malformed' }
    }
}

function parseComposeStatus(stdout: Buffer, projectName: string, service: string): string | undefined {
    const result = classifyComposeStatus(stdout, projectName, service)
    return result.kind === 'valid' ? result.value : undefined
}

function classifyContainerIdentity(stdout: Buffer, shortId: string): RuntimeServiceOutput<string> {
    if (stdout.byteLength === 0) return { kind: 'empty' }
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
        const lines = source.split('\n')
        if (lines.at(-1) === '') lines.pop()
        if (lines.length !== 1 || !CONTAINER_ID.test(lines[0] ?? '') || !lines[0]?.startsWith(shortId)) return { kind: 'malformed' }
        return { kind: 'valid', value: lines[0] as string }
    } catch {
        // Undecodable output is the malformed verdict.
        return { kind: 'malformed' }
    }
}

function parseContainerIdentity(stdout: Buffer, shortId: string): string | undefined {
    const result = classifyContainerIdentity(stdout, shortId)
    return result.kind === 'valid' ? result.value : undefined
}

function classifyRuntimeServiceStageEvidence(
    outcome: ExecuteProbeOutcome,
    stage: 'start' | 'status' | 'identity',
    projectName: string,
    service: string,
    shortId?: string,
): 'clean' | 'failure' | 'unavailable' {
    if (outcome.kind === 'refusal' || outcome.stderr.byteLength !== 0) return 'failure'
    if (stage === 'start') return 'clean'
    const parsed = stage === 'status'
        ? classifyComposeStatus(outcome.stdout, projectName, service)
        : shortId === undefined
            ? { kind: 'malformed' as const }
            : classifyContainerIdentity(outcome.stdout, shortId)
    return parsed.kind === 'valid' ? 'clean' : parsed.kind === 'empty' ? 'failure' : 'unavailable'
}

type RuntimeServiceLookupObservation =
    | { readonly kind: 'missing' }
    | { readonly kind: 'present'; readonly shortId: string; readonly containerId: string }

function parseRuntimeServiceLookup(
    status: Buffer,
    identity: Buffer,
    projectName: string,
    service: string,
): RuntimeServiceLookupObservation | undefined {
    if (status.byteLength === 0) return identity.byteLength === 0 ? { kind: 'missing' } : undefined
    const shortId = parseComposeStatus(status, projectName, service)
    const containerId = shortId ? parseContainerIdentity(identity, shortId) : undefined
    return shortId && containerId ? { kind: 'present', shortId, containerId } : undefined
}

function receiptWithinWindow(outcome: Extract<ExecuteProbeOutcome, { kind: 'complete' }>, window: RuntimeObservationWindow, now: number): boolean {
    const startedAt = outcome.receipt.startedAt
    const finishedAt = outcome.receipt.finishedAt
    const windowStart = Date.parse(window.startedAt)
    const windowEnd = Date.parse(window.expiresAt)
    const receiptStart = Date.parse(startedAt)
    const receiptEnd = Date.parse(finishedAt)
    return isCanonicalTimestamp(startedAt) && isCanonicalTimestamp(finishedAt)
        && windowStart <= receiptStart && receiptStart <= receiptEnd && receiptEnd <= now
        && receiptEnd <= windowEnd && windowStart <= now && now <= windowEnd
}

export function admitRuntimeServiceRevalidation(input: {
    readonly plan: RuntimeServiceRevalidationPlan
    readonly outcome: ExecuteProbeOutcome
    readonly identityOutcome: ExecuteProbeOutcome
}): RuntimeServiceRevalidationResult {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service revalidation is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome', 'identityOutcome'])
        const plan = captured?.plan as RuntimeServiceRevalidationPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        const suppliedIdentityOutcome = captured?.identityOutcome as ExecuteProbeOutcome | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServiceRevalidationPlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServiceRevalidationPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.status) : undefined
        const identityOutcome = contract && suppliedIdentityOutcome ? authenticatedExecutionOutcome(suppliedIdentityOutcome, plan.identity) : undefined
        const admittedStatus = admittedRuntimeServiceRevalidationStatuses.get(plan)
        if (!contract || !outcome || !identityOutcome || admittedStatus !== suppliedOutcome) {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            admittedRuntimeServiceRevalidationStatuses.delete(plan)
            return unavailable()
        }
        consumedRuntimeServiceRevalidationPlans.add(plan)
        admittedRuntimeServiceRevalidationStatuses.delete(plan)
        const now = Date.now()
        if (outcome.kind !== 'complete' || identityOutcome.kind !== 'complete'
            || outcome.stderr.byteLength !== 0 || identityOutcome.stderr.byteLength !== 0
            || !receiptWithinWindow(outcome, contract.topologyContract.observationWindow, now)
            || !receiptWithinWindow(identityOutcome, contract.topologyContract.observationWindow, now)
            || Date.parse(outcome.receipt.finishedAt) > Date.parse(identityOutcome.receipt.startedAt)) return unavailable()
        const observed = parseRuntimeServiceLookup(
            outcome.stdout,
            identityOutcome.stdout,
            contract.topologyContract.runtime.projectName,
            contract.service.id,
        )
        if (!observed) return unavailable()
        if (observed.kind === 'missing' || observed.containerId !== contract.expectedContainerId) {
            return {
                kind: 'stale' as const,
                service: contract.service.id,
                expectedContainerId: contract.expectedContainerId,
            }
        }
        const step = runtimeServiceInspectStep(
            contract.topologyContract,
            contract.service,
            observed.containerId,
            randomBytes(32).toString('hex'),
            Math.min(
                contract.topologyContract.step.timeoutMs,
                Math.max(1, Date.parse(contract.topologyContract.observationWindow.expiresAt) - now),
            ),
        )
        if (!step) return unavailable()
        const healthPlan = { kind: 'planned' as const, service: contract.service.id, step }
        issuedRuntimeServiceHealthPlans.set(healthPlan, Object.freeze({
            ...contract,
            containerId: observed.containerId,
            identityFinishedAt: identityOutcome.receipt.finishedAt,
        }))
        return {
            kind: 'planned' as const,
            service: contract.service.id,
            expectedContainerId: contract.expectedContainerId,
            plan: healthPlan,
        }
    } catch (error) {
        return unavailable(error)
    }
}

// `.Id` is a key of the inspect JSON, not of Docker's typed result, so Docker runs this template on
// the raw JSON. There a container without a healthcheck has no State.Health key, and a field access
// on a missing key fails the whole inspect; `index` yields nothing instead.
const CONTAINER_INSPECT_FORMAT = '{"ID":{{json .Id}},"State":{{json .State.Status}},"Health":{{with index .State "Health"}}{{json .Status}}{{else}}""{{end}},"Labels":{"dev.b0dea.cockpit.stack-id":{{json (index .Config.Labels "dev.b0dea.cockpit.stack-id")}},"dev.b0dea.cockpit.config-sha256":{{json (index .Config.Labels "dev.b0dea.cockpit.config-sha256")}},"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}},"Mounts":{{json .Mounts}},"Ports":{{json .NetworkSettings.Ports}}}'

function runtimeServiceInspectStep(
    topologyContract: TopologyEvidenceContract,
    service: RuntimeTopologyService,
    containerId: string,
    issuanceId: string,
    timeoutMs: number,
): ExecutionStep | undefined {
    const executable = topologyContract.runtime.runtimeExecutable
    return snapshotExecutionPlan({ steps: [{
        id: `runtime:docker-container:health:${service.id}`,
        argv: [executable.canonicalPath, 'container', 'inspect', '--format', CONTAINER_INSPECT_FORMAT, containerId] as [string, ...string[]],
        argv0: executable.invocationPath,
        cwd: topologyContract.runtime.cwd,
        env: runtimeCommandEnvironment(topologyContract.runtime.env, topologyContract.runtime.interpolatedNames),
        timeoutMs,
        stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
        stderrLimitBytes: OUTPUT_LIMIT_BYTES,
        paths: [],
        ports: [],
        labels: {
            stackId: topologyContract.stackId,
            configSha256: topologyContract.configSha256,
            batchId: topologyContract.batchId,
            service: service.id,
            containerId,
            runtimeVersion: topologyContract.runtime.runtimeVersion,
            composeVersion: topologyContract.runtime.composeVersion,
            executableSha256: executable.sha256,
            projectName: topologyContract.runtime.projectName,
            issuanceId,
        },
        expected: [],
        consumedFiles: [{
            path: executable.canonicalPath,
            sha256: executable.sha256,
            maxBytes: 536_870_912,
            argvIndexes: [0],
            executable: true,
            executionMode: executable.executionMode,
        }],
        filesystemChecks: [],
        compensation: [],
    }] })?.steps[0]
}

export function projectRuntimeLifecycle(topology: RuntimeTopologyEvidence): RuntimeLifecycleProjection | undefined {
    try {
        if (topology === null || typeof topology !== 'object') return undefined
        const contract = issuedTopologyEvidence.get(topology)
        const now = Date.now()
        if (!contract || now < Date.parse(contract.observationWindow.startedAt)
            || now > Date.parse(contract.observationWindow.expiresAt)) return undefined
        const services: RuntimeLifecycleServiceSemantics[] = []
        for (const serviceId of contract.order) {
            const service = contract.services.get(serviceId)
            if (!service) return undefined
            const initial = runtimeServiceInitialSteps(contract, service, randomBytes(32).toString('hex'))
            const inspect = runtimeServiceInspectStep(
                contract,
                service,
                '0'.repeat(64),
                randomBytes(32).toString('hex'),
                Math.min(contract.step.timeoutMs, MAX_OBSERVATION_WINDOW_MS),
            )
            if (!initial || !inspect) return undefined
            const start = projectRuntimeExecutionStep(initial.start)
            const status = projectRuntimeExecutionStep(initial.status)
            const identity = projectRuntimeExecutionStep(initial.identity)
            const projectedInspect = projectRuntimeExecutionStep(inspect, { index: inspect.argv.length - 1, service: service.id })
            if (!start || !status || !identity || !projectedInspect) return undefined
            services.push(freezeRuntimeValue({
                id: service.id,
                start,
                status,
                identity,
                inspect: projectedInspect,
                healthAcceptance: { state: 'running' as const, health: service.healthcheck ? 'healthy' as const : null },
            }))
        }
        const semantics = freezeRuntimeValue({
            stackId: contract.stackId,
            configSha256: contract.configSha256,
            runtimeVersion: contract.runtime.runtimeVersion,
            composeVersion: contract.runtime.composeVersion,
            projectName: contract.runtime.projectName,
            topology: {
                order: [...contract.order],
                services: topology.services.map((service) => ({
                    id: service.id,
                    dependsOn: [...service.dependsOn],
                    bindMountSources: [...service.bindMountSources],
                    namedVolumeMounts: service.namedVolumeMounts?.map((mount) => ({ ...mount })) ?? [],
                    healthcheck: service.healthcheck,
                })),
            },
            runtimeChecks: {
                coldStartLimitMillis: contract.runtime.coldStartLimitMillis,
                expectedMountSources: [...contract.runtime.expectedMountSources],
            },
            services,
        }) satisfies RuntimeLifecycleSemantics
        if (Buffer.byteLength(JSON.stringify(semantics), 'utf8') > MAX_TOPOLOGY_BYTES) return undefined
        const projection = {} as RuntimeLifecycleProjection
        issuedRuntimeLifecycleProjections.set(projection, Object.freeze({
            topology,
            semantics,
            observationWindow: contract.observationWindow,
        }))
        return projection
    } catch {
        // A throwing accessor or proxy trap makes the projection input malformed, which the caller refuses.
        return undefined
    }
}

export function consumeRuntimeLifecycleProjection(projection: RuntimeLifecycleProjection): RuntimeLifecycleEnvelope | undefined {
    try {
        if (projection === null || typeof projection !== 'object' || consumedRuntimeLifecycleProjections.has(projection)) return undefined
        const contract = issuedRuntimeLifecycleProjections.get(projection)
        const now = Date.now()
        if (!contract || now < Date.parse(contract.observationWindow.startedAt)
            || now > Date.parse(contract.observationWindow.expiresAt)) return undefined
        consumedRuntimeLifecycleProjections.add(projection)
        return { topology: contract.topology, semantics: contract.semantics }
    } catch {
        // A throwing accessor or proxy trap makes the projection unusable, which the caller refuses.
        return undefined
    }
}

export function createRuntimeServiceHealthPlan(input: {
    readonly plan: RuntimeServicePlan
    readonly startOutcome: ExecuteProbeOutcome
    readonly outcome: ExecuteProbeOutcome
    readonly identityOutcome: ExecuteProbeOutcome
}): RuntimeServiceHealthPlan {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service health is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['plan', 'startOutcome', 'outcome', 'identityOutcome'])
        const plan = captured?.plan as RuntimeServicePlan | undefined
        const suppliedStartOutcome = captured?.startOutcome as ExecuteProbeOutcome | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        const suppliedIdentityOutcome = captured?.identityOutcome as ExecuteProbeOutcome | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServicePlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServicePlans.get(plan)
        const startOutcome = contract && suppliedStartOutcome ? authenticatedExecutionOutcome(suppliedStartOutcome, plan.start) : undefined
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.status) : undefined
        const identityOutcome = contract && suppliedIdentityOutcome ? authenticatedExecutionOutcome(suppliedIdentityOutcome, plan.identity) : undefined
        const admittedStages = admittedRuntimeServiceStages.get(plan)
        if (!contract || !startOutcome || !outcome || !identityOutcome) return unavailable()
        if (!admittedStages || admittedStages.startOutcome !== suppliedStartOutcome
            || admittedStages.statusOutcome !== suppliedOutcome
            || admittedStages.identityOutcome !== suppliedIdentityOutcome) {
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            return unavailable()
        }
        consumedRuntimeServicePlans.add(plan)
        admittedRuntimeServiceStages.delete(plan)
        if (startOutcome.kind !== 'complete' || outcome.kind !== 'complete' || identityOutcome.kind !== 'complete'
            || startOutcome.stderr.byteLength !== 0 || outcome.stderr.byteLength !== 0 || identityOutcome.stderr.byteLength !== 0) return unavailable()
        const windowEnd = Date.parse(contract.topologyContract.observationWindow.expiresAt)
        const now = Date.now()
        if (!receiptWithinWindow(startOutcome, contract.topologyContract.observationWindow, now)
            || !receiptWithinWindow(outcome, contract.topologyContract.observationWindow, now)
            || !receiptWithinWindow(identityOutcome, contract.topologyContract.observationWindow, now)
            || Date.parse(startOutcome.receipt.finishedAt) > Date.parse(outcome.receipt.startedAt)
            || Date.parse(outcome.receipt.finishedAt) > Date.parse(identityOutcome.receipt.startedAt)) return unavailable()
        const shortId = parseComposeStatus(outcome.stdout, contract.topologyContract.runtime.projectName, contract.service.id)
        const containerId = shortId ? parseContainerIdentity(identityOutcome.stdout, shortId) : undefined
        if (!shortId || !containerId) return unavailable()
        const step = runtimeServiceInspectStep(
            contract.topologyContract,
            contract.service,
            containerId,
            randomBytes(32).toString('hex'),
            Math.min(contract.topologyContract.step.timeoutMs, Math.max(1, windowEnd - now)),
        )
        if (!step) return unavailable()
        const healthPlan = { kind: 'planned' as const, service: contract.service.id, step }
        issuedRuntimeServiceHealthPlans.set(healthPlan, Object.freeze({
            ...contract,
            containerId,
            startStartedAt: startOutcome.receipt.startedAt,
            identityFinishedAt: identityOutcome.receipt.finishedAt,
        }))
        return healthPlan
    } catch (error) {
        return unavailable(error)
    }
}

const CONTAINER_STATES = new Set(['created', 'running', 'restarting', 'paused', 'exited', 'dead', 'removing'])
const CONTAINER_HEALTH = new Set(['', 'healthy', 'starting', 'unhealthy'])

interface RuntimeServiceInspection {
    readonly containerId: string
    readonly state: RuntimeServiceObservation['state']
    readonly health: RuntimeServiceObservation['health']
    readonly bindMounts: readonly RuntimeBindMount[]
    readonly publishedPorts: readonly RuntimePublishedPort[]
}

interface RuntimeServiceEvidenceContract extends RuntimeServiceHealthPlanContract {
    readonly inspection: RuntimeServiceInspection
}

function inspectedBindMounts(value: unknown): readonly RuntimeBindMount[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_TOPOLOGY_EDGES) return undefined
    const mounts: RuntimeBindMount[] = []
    for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
        const row = item as Record<string, unknown>
        if (row.Type !== 'bind') continue
        if (typeof row.Source !== 'string' || !isAbsolute(row.Source) || normalize(row.Source) !== row.Source
            || row.Source.includes('\0') || typeof row.Destination !== 'string' || !CONTAINER_PATH.test(row.Destination)) return undefined
        mounts.push({ source: row.Source, target: row.Destination })
    }
    const identities = mounts.map(({ source, target }) => `${source}\0${target}`)
    if (new Set(identities).size !== identities.length) return undefined
    return [...mounts].sort((left, right) =>
        `${left.source}\0${left.target}`.localeCompare(`${right.source}\0${right.target}`))
}

function inspectedPublishedPorts(value: unknown): readonly RuntimePublishedPort[] | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_TOPOLOGY_EDGES) return undefined
    const ports: RuntimePublishedPort[] = []
    for (const [key, bindings] of entries) {
        const match = key.match(/^([1-9]\d{0,4})\/(tcp|udp)$/)
        if (!match || Number(match[1]) > 65_535) return undefined
        if (bindings === null) continue
        if (!Array.isArray(bindings) || bindings.length > MAX_TOPOLOGY_EDGES) return undefined
        if (match[2] !== 'tcp') return undefined
        for (const binding of bindings) {
            if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return undefined
            const row = binding as Record<string, unknown>
            const published = typeof row.HostPort === 'string' && /^[1-9]\d{0,4}$/.test(row.HostPort)
                ? Number(row.HostPort) : undefined
            if (typeof row.HostIp !== 'string' || !PUBLISHED_HOSTS.has(row.HostIp)
                || published === undefined || published > 65_535) return undefined
            ports.push({
                hostIp: row.HostIp as RuntimePublishedPort['hostIp'],
                target: Number(match[1]),
                published,
                protocol: 'tcp',
            })
        }
    }
    const identities = ports.map(({ hostIp, target, published }) => `${hostIp}\0${published}\0${target}`)
    if (new Set(identities).size !== identities.length) return undefined
    return [...ports].sort((left, right) =>
        `${left.hostIp}\0${left.published}\0${left.target}`.localeCompare(`${right.hostIp}\0${right.published}\0${right.target}`))
}

function parseRuntimeServiceInspection(stdout: Buffer, contract: RuntimeServiceHealthPlanContract): RuntimeServiceInspection | undefined {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
        const parsed: unknown = JSON.parse(source)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
        const value = parsed as Record<string, unknown>
        const labels = value.Labels as Record<string, unknown> | null | undefined
        const mounts = inspectedBindMounts(value.Mounts)
        const ports = inspectedPublishedPorts(value.Ports)
        if (value.ID !== contract.containerId || typeof value.State !== 'string' || typeof value.Health !== 'string'
            || !CONTAINER_STATES.has(value.State) || !CONTAINER_HEALTH.has(value.Health)
            || labels === null || typeof labels !== 'object' || Array.isArray(labels)
            || labels['com.docker.compose.project'] !== contract.topologyContract.runtime.projectName
            || labels['com.docker.compose.service'] !== contract.service.id
            || labels['dev.b0dea.cockpit.config-sha256'] !== contract.topologyContract.configSha256
            || labels['dev.b0dea.cockpit.stack-id'] !== contract.topologyContract.stackId
            || !contract.service.healthcheck && value.Health !== '' || !mounts || !ports) return undefined
        return {
            containerId: value.ID,
            state: value.State as RuntimeServiceObservation['state'],
            health: value.Health === '' ? null : value.Health as Exclude<RuntimeServiceObservation['health'], null>,
            bindMounts: mounts,
            publishedPorts: ports,
        }
    } catch {
        // A malformed inspection shape yields no observation, which the caller reports as unavailable.
        return undefined
    }
}

export function admitRuntimeServiceObservation(input: {
    readonly plan: RuntimeServiceHealthPlan
    readonly outcome: ExecuteProbeOutcome
}): { readonly kind: 'complete'; readonly observation: RuntimeServiceObservation } | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string } {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service observation is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as RuntimeServiceHealthPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServiceHealthPlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServiceHealthPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.step) : undefined
        if (!contract || !outcome) return unavailable()
        consumedRuntimeServiceHealthPlans.add(plan)
        if (outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0 || !outcome.receipt) return unavailable()
        const observedAt = outcome.receipt.finishedAt
        const windowStart = Date.parse(contract.topologyContract.observationWindow.startedAt)
        const windowEnd = Date.parse(contract.topologyContract.observationWindow.expiresAt)
        const receiptStart = Date.parse(outcome.receipt.startedAt)
        const receiptEnd = Date.parse(observedAt)
        const now = Date.now()
        if (!isCanonicalTimestamp(outcome.receipt.startedAt) || !isCanonicalTimestamp(observedAt)
            || windowStart > receiptStart || receiptStart > receiptEnd || receiptEnd > now
            || Date.parse(contract.identityFinishedAt) > receiptStart
            || receiptEnd > windowEnd || now < windowStart || now > windowEnd) return unavailable()
        const value = parseRuntimeServiceInspection(outcome.stdout, contract)
        if (!value) return unavailable()
        const observation = {
            stackId: contract.topologyContract.stackId,
            configSha256: contract.topologyContract.configSha256,
            batchId: contract.topologyContract.batchId,
            runtimeVersion: contract.topologyContract.runtime.runtimeVersion,
            composeVersion: contract.topologyContract.runtime.composeVersion,
            executableSha256: contract.topologyContract.runtime.runtimeExecutable.sha256,
            projectName: contract.topologyContract.runtime.projectName,
            service: contract.service.id,
            containerId: value.containerId,
            state: value.state,
            health: value.health,
            observedAt,
            observationWindow: contract.topologyContract.observationWindow,
        }
        issuedRuntimeServiceObservations.set(observation, Object.freeze({ ...contract, inspection: value }))
        return { kind: 'complete', observation }
    } catch (error) {
        return unavailable(error)
    }
}

export function admitRuntimeServiceHealth(input: {
    readonly observation: RuntimeServiceObservation
}): { readonly kind: 'complete'; readonly evidence: RuntimeServiceEvidence } | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string } {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service health is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['observation'])
        const observation = captured?.observation as RuntimeServiceObservation | undefined
        if (observation && typeof observation === 'object' && typeof observation.service === 'string') serviceName = observation.service
        const contract = observation && typeof observation === 'object' ? issuedRuntimeServiceObservations.get(observation) : undefined
        if (!contract || !observation || consumedRuntimeServiceHealthObservations.has(observation)) return unavailable()
        consumedRuntimeServiceHealthObservations.add(observation)
        const now = Date.now()
        if (now < Date.parse(contract.topologyContract.observationWindow.startedAt)
            || now > Date.parse(contract.topologyContract.observationWindow.expiresAt)
            || observation.state !== 'running'
            || (contract.service.healthcheck ? observation.health !== 'healthy' : observation.health !== null)) return unavailable()
        const evidence = {
            stackId: observation.stackId,
            configSha256: observation.configSha256,
            batchId: observation.batchId,
            runtimeVersion: observation.runtimeVersion,
            composeVersion: observation.composeVersion,
            executableSha256: observation.executableSha256,
            projectName: observation.projectName,
            service: observation.service,
            containerId: observation.containerId,
            state: 'running' as const,
            health: observation.health === 'healthy' ? 'healthy' as const : null,
            observedAt: observation.observedAt,
            observationWindow: observation.observationWindow,
        }
        issuedRuntimeServiceEvidence.set(evidence, contract)
        return { kind: 'complete', evidence }
    } catch (error) {
        return unavailable(error)
    }
}

export function isRuntimeServiceEvidence(value: unknown): value is RuntimeServiceEvidence {
    if (value === null || typeof value !== 'object') return false
    const contract = issuedRuntimeServiceEvidence.get(value)
    const now = Date.now()
    return contract !== undefined && Date.parse(contract.topologyContract.observationWindow.startedAt) <= now
        && now <= Date.parse(contract.topologyContract.observationWindow.expiresAt)
}

export function observeRuntimeMountMaterialization(input: {
    readonly topology: RuntimeTopologyEvidence
    readonly services: readonly RuntimeServiceEvidence[]
    readonly observedAt: string
}): EnvironmentObservation {
    const captured = captureOwnValues(input, ['topology', 'services', 'observedAt'])
    const topologyValue = captured?.topology as RuntimeTopologyEvidence | undefined
    const topology = topologyValue && typeof topologyValue === 'object' ? issuedTopologyEvidence.get(topologyValue) : undefined
    const observedAt = captured?.observedAt
    if (!topology) throw new RefusalError('runtime mount evidence is not authentic')
    const fail = (reason: string) => issueObservation({
        code: ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE,
        owner: OWNER,
        stackId: topology.stackId,
        source: topology.runtime.projectName,
        observed: { state: 'unavailable', reason, observedAt: typeof observedAt === 'string' && isCanonicalTimestamp(observedAt) ? observedAt : new Date().toISOString() },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'running-stack' },
        freshness: { state: 'current' },
        remedy: 'restore the exact declared bind mounts and re-observe every runtime service',
    })
    if (!Array.isArray(captured?.services) || captured.services.length !== topology.services.size
        || typeof observedAt !== 'string' || !isCanonicalTimestamp(observedAt)) {
        return fail('runtime mount evidence is incomplete or unauthenticated')
    }
    const now = Date.now()
    if (now < Date.parse(topology.observationWindow.startedAt) || now > Date.parse(topology.observationWindow.expiresAt)
        || Date.parse(observedAt) < Date.parse(topology.observationWindow.startedAt)
        || Date.parse(observedAt) > Math.min(now, Date.parse(topology.observationWindow.expiresAt))) {
        return fail('runtime mount evidence is outside its current observation window')
    }
    const seen = new Set<string>()
    for (const evidence of captured.services as readonly RuntimeServiceEvidence[]) {
        const contract = evidence && typeof evidence === 'object' ? issuedRuntimeServiceEvidence.get(evidence) : undefined
        if (!contract || contract.topologyContract !== topology || seen.has(contract.service.id)
            || evidence.observedAt > observedAt || !isRuntimeServiceEvidence(evidence)) {
            return fail('runtime mount evidence is incomplete or unauthenticated')
        }
        seen.add(contract.service.id)
        const expected = topology.runtimeHealth.get(contract.service.id)?.bindMounts
        if (!expected || JSON.stringify(expected) !== JSON.stringify(contract.inspection.bindMounts)) {
            return issueObservation({
                code: ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE,
                owner: OWNER,
                stackId: topology.stackId,
                source: `${topology.runtime.projectName}:${contract.service.id}`,
                observed: { state: 'available', value: false, observedAt },
                expectation: { kind: 'equal', value: true },
                applicability: { state: 'required', posture: 'running-stack' },
                freshness: { state: 'current' },
                remedy: 'restore the exact declared bind mounts and recreate the affected service',
            })
        }
    }
    if (seen.size !== topology.services.size) return fail('runtime mount evidence is incomplete or unauthenticated')
    return issueObservation({
        code: ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE,
        owner: OWNER,
        stackId: topology.stackId,
        source: `${topology.runtime.projectName}:runtime-mounts`,
        observed: { state: 'available', value: true, observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'running-stack' },
        freshness: { state: 'current' },
        remedy: 'restore the exact declared bind mounts and recreate the affected service',
    })
}

function currentRuntimeServices(
    topology: TopologyEvidenceContract,
    values: unknown,
): ReadonlyMap<string, { readonly evidence: RuntimeServiceEvidence; readonly contract: RuntimeServiceEvidenceContract }> | undefined {
    if (!Array.isArray(values) || values.length !== topology.services.size) return undefined
    const services = new Map<string, { evidence: RuntimeServiceEvidence; contract: RuntimeServiceEvidenceContract }>()
    for (const evidence of values as readonly RuntimeServiceEvidence[]) {
        const contract = evidence && typeof evidence === 'object' ? issuedRuntimeServiceEvidence.get(evidence) : undefined
        if (!contract || contract.topologyContract !== topology || services.has(contract.service.id)
            || !isRuntimeServiceEvidence(evidence)) return undefined
        services.set(contract.service.id, { evidence, contract })
    }
    return services.size === topology.services.size ? services : undefined
}

function exactRuntimePorts(
    expected: readonly RuntimePublishedPort[],
    actual: readonly RuntimePublishedPort[],
): boolean {
    const remaining = new Set(actual.map(({ hostIp, target, published }) => `${hostIp}\0${published}\0${target}`))
    for (const row of expected) {
        const identity = `${row.hostIp}\0${row.published}\0${row.target}`
        if (row.hostIp !== '0.0.0.0') {
            if (!remaining.delete(identity)) return false
            continue
        }
        if (!remaining.delete(identity)) return false
        remaining.delete(`::\0${row.published}\0${row.target}`)
    }
    return remaining.size === 0
}

export async function observeRuntimePortFamily(input: {
    readonly topology: RuntimeTopologyEvidence
    readonly services: readonly RuntimeServiceEvidence[]
    readonly namespace: StateNamespace
    readonly listenerTimeoutMs: number
    readonly revalidate: () => Promise<readonly RuntimeServiceEvidence[]>
}): Promise<EnvironmentObservation> {
    const captured = captureOwnValues(input, ['topology', 'services', 'namespace', 'listenerTimeoutMs', 'revalidate'])
    const topologyValue = captured?.topology as RuntimeTopologyEvidence | undefined
    const topology = topologyValue && typeof topologyValue === 'object' ? issuedTopologyEvidence.get(topologyValue) : undefined
    if (!topology) throw new RefusalError('runtime port evidence is not authentic')
    const now = new Date().toISOString()
    const unavailable = (reason: string, observedAt = now) => issueObservation({
        code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION,
        owner: OWNER,
        stackId: topology.stackId,
        source: topology.runtime.projectName,
        observed: { state: 'unavailable', reason, observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'running-stack' },
        freshness: { state: 'current' },
        remedy: 'restore the retained port lease and the exact declared runtime publication',
    })
    try {
        const services = currentRuntimeServices(topology, captured?.services)
        const namespace = captured?.namespace as StateNamespace | undefined
        const timeoutMs = captured?.listenerTimeoutMs
        const revalidate = captured?.revalidate
        const projection = topology.runtime.portLeaseProjection
        const lease = projection && namespace ? inspectPortLeaseProjection(projection, namespace) : undefined
        if (!services || !namespace || !lease || typeof revalidate !== 'function'
            || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 30_000
            || !await revalidatePortLeaseProjection({ projection: lease, namespace })) {
            return unavailable('runtime port evidence is incomplete or unauthenticated')
        }
        const leased = new Set(Object.values(lease.lease.ports))
        const published = new Set<number>()
        const listeners: PortListenerBinding[] = []
        const listenerKeys = new Set<string>()
        for (const [serviceId, current] of services) {
            const expected = topology.runtimeHealth.get(serviceId)?.publishedPorts
            if (!expected || !exactRuntimePorts(expected, current.contract.inspection.publishedPorts)) {
                return unavailable(`runtime port publication differs from the declared topology for ${serviceId}`)
            }
            const rows = current.contract.inspection.publishedPorts
            for (const row of rows) {
                if (!leased.has(row.published)) return unavailable(`runtime published port ${row.published} is outside the retained lease`)
                published.add(row.published)
                const key = `${row.hostIp}\0${row.published}`
                if (listenerKeys.has(key)) return unavailable('runtime publication contains a duplicate host address')
                listenerKeys.add(key)
                // Compose reports a `::` companion beside every 0.0.0.0 publication, but some
                // runtimes forward only IPv4 loopback, so requiring ::1 to listen failed healthy
                // stacks. The IPv4 row still proves the listener; a companion is not required.
                if (row.hostIp === '::' && rows.some((other) => other.hostIp === '0.0.0.0'
                    && other.published === row.published && other.target === row.target)) continue
                listeners.push({ hostIp: row.hostIp, port: row.published, expected: 'listening' })
            }
        }
        for (const port of leased) {
            if (published.has(port)) continue
            listeners.push({ hostIp: '127.0.0.1', port, expected: 'free' })
            listeners.push({ hostIp: '::1', port, expected: 'free' })
        }
        if (listeners.length === 0) return unavailable('retained port lease contains no observable ports')
        const observed = await observePortListeners({ bindings: listeners, timeoutMs: timeoutMs as number })
        if (observed.kind !== 'complete') return unavailable(observed.reason)
        const mismatched = observed.rows.filter((row, index) => row.listening !== (listeners[index]?.expected === 'listening'))
        if (mismatched.length > 0) {
            const named = mismatched.slice(0, 8).map(({ probeHost, port, listening }) => listening
                ? `${probeHost === '::1' ? `[${probeHost}]` : probeHost}:${port} has a listener outside the stack`
                : `${probeHost === '::1' ? `[${probeHost}]` : probeHost}:${port} has no stack listener`)
            return issueObservation({
                code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, owner: OWNER, stackId: topology.stackId,
                source: `${topology.runtime.projectName}:runtime-ports`,
                observed: { state: 'available', value: false, observedAt: observed.observedAt },
                expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'running-stack' },
                freshness: { state: 'current' },
                remedy: `${named.join('; ')}${mismatched.length > named.length ? `; and ${mismatched.length - named.length} more` : ''}: `
                    + 'stop the process holding a leased port (find it with `lsof -nP -iTCP:<port> -sTCP:LISTEN`), '
                    + 'or restart the stack with `npx --no cockpit up --config <your cockpit.toml>` to restore a missing listener',
            })
        }
        if (!await revalidatePortLeaseProjection({ projection: lease, namespace })) {
            return unavailable('retained port lease changed during listener observation', observed.observedAt)
        }
        const afterValues = await revalidate()
        const after = currentRuntimeServices(topology, afterValues)
        if (!after || after.size !== services.size) return unavailable('runtime service identity changed during listener observation', observed.observedAt)
        for (const [serviceId, before] of services) {
            const current = after.get(serviceId)
            if (!current || current.evidence === before.evidence || current.evidence.containerId !== before.evidence.containerId
                || Date.parse(current.evidence.observedAt) < Date.parse(observed.observedAt)
                || JSON.stringify(current.contract.inspection.bindMounts) !== JSON.stringify(before.contract.inspection.bindMounts)
                || JSON.stringify(current.contract.inspection.publishedPorts) !== JSON.stringify(before.contract.inspection.publishedPorts)) {
                return unavailable('runtime service identity changed during listener observation', observed.observedAt)
            }
        }
        if (!await revalidatePortLeaseProjection({ projection: lease, namespace })) {
            return unavailable('retained port lease changed during service revalidation', observed.observedAt)
        }
        return issueObservation({
            code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, owner: OWNER, stackId: topology.stackId,
            source: `${topology.runtime.projectName}:runtime-ports`, observed: { state: 'available', value: true, observedAt: observed.observedAt },
            expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'running-stack' },
            freshness: { state: 'current' }, remedy: 'restore the retained port lease and the exact declared runtime publication',
        })
    } catch (error) {
        return unavailable(unavailableReason('runtime port observation failed closed', error))
    }
}

export function observeRuntimeServiceColdStart(input: {
    readonly services: readonly RuntimeServiceEvidence[]
}): EnvironmentObservation {
    try {
        const captured = captureOwnValues(input, ['services'])
        const services = captured?.services
        if (!Array.isArray(services) || services.length < 1 || services.length > MAX_TOPOLOGY_SERVICES) {
            throw new RefusalError('runtime cold-start evidence is not authentic')
        }
        let topology: TopologyEvidenceContract | undefined
        let startedAt = Number.POSITIVE_INFINITY
        let finishedAt = Number.NEGATIVE_INFINITY
        let source = ''
        const observedServices = new Set<string>()
        for (const evidence of services) {
            const contract = evidence !== null && typeof evidence === 'object'
                ? issuedRuntimeServiceEvidence.get(evidence)
                : undefined
            if (!contract || topology && contract.topologyContract !== topology
                || observedServices.has(evidence.service)
                || !isRuntimeServiceEvidence(evidence)
                || !isCanonicalTimestamp(contract.startStartedAt)
                || !isCanonicalTimestamp(evidence.observedAt)) {
                throw new RefusalError('runtime cold-start evidence is not authentic')
            }
            topology ??= contract.topologyContract
            observedServices.add(evidence.service)
            const serviceStart = Date.parse(contract.startStartedAt)
            const serviceFinish = Date.parse(evidence.observedAt)
            if (serviceStart > serviceFinish) throw new RefusalError('runtime cold-start evidence is not authentic')
            if (serviceStart < startedAt) {
                startedAt = serviceStart
                source = evidence.service
            }
            finishedAt = Math.max(finishedAt, serviceFinish)
        }
        if (!topology) throw new RefusalError('runtime cold-start evidence is not authentic')
        const duration = finishedAt - startedAt
        const observedAt = new Date(finishedAt).toISOString()
        return issueObservation({
            code: ENVIRONMENT_CODES.MACHINE_COLD_START_EXCEEDED,
            owner: OWNER,
            stackId: topology.stackId,
            source,
            observed: Number.isSafeInteger(duration) && duration >= 0
                ? { state: 'available', value: duration, observedAt }
                : { state: 'failed', reason: 'runtime receipt timestamps are incoherent', observedAt },
            expectation: { kind: 'maximum', value: topology.runtime.coldStartLimitMillis },
            applicability: { state: 'required', posture: 'environment' },
            freshness: { state: 'current' },
            remedy: 'restore the declared cold-start budget',
        })
    } catch (error) {
        if (error instanceof RefusalError && error.message === 'runtime cold-start evidence is not authentic') throw error
        throw new RefusalError('runtime cold-start evidence is not authentic')
    }
}

export interface RuntimeServiceFailureLogContext {
    readonly stage: 'start' | 'status' | 'identity' | 'inspect'
    readonly stackId: StackId
    readonly configSha256: string
    readonly batchId: string
    readonly runtimeVersion: string
    readonly composeVersion: string
    readonly executableSha256: string
    readonly projectName: string
    readonly service: string
    readonly containerId: string | null
    readonly observedAt: string
    readonly observationWindow: RuntimeObservationWindow
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly composeArgvPrefix: readonly string[]
    readonly paths: ExecutionStep['paths']
    readonly consumedFiles: ExecutionStep['consumedFiles']
    readonly filesystemChecks: ExecutionStep['filesystemChecks']
}

type RuntimeServiceFailureResult =
    | { readonly kind: 'complete'; readonly evidence: RuntimeServiceFailureEvidence }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

export type RuntimeServiceStageOutcomeAdmission =
    | { readonly kind: 'admitted'; readonly service: string }
    | { readonly kind: 'failure'; readonly service: string; readonly evidence: RuntimeServiceFailureEvidence }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

export type RuntimeServiceRevalidationStatusAdmission =
    | { readonly kind: 'admitted'; readonly service: string; readonly expectedContainerId: string }
    | { readonly kind: 'stale'; readonly service: string; readonly expectedContainerId: string }
    | { readonly kind: 'unavailable'; readonly service: string; readonly reason: string }

function runtimeServiceFailureContext(
    contract: RuntimeServicePlanContract,
    stage: RuntimeServiceFailureLogContext['stage'],
    observedAt: string,
    containerId: string | null,
): RuntimeServiceFailureLogContext | undefined {
    const topology = contract.topologyContract
    const step = snapshotExecutionPlan({ steps: [topology.step] })?.steps[0]
    const configIndex = step?.argv.lastIndexOf('config') ?? -1
    const suffix = step?.argv.slice(configIndex)
    if (!step || configIndex < 2 || step.argv[1] !== 'compose'
        || !(suffix?.length === 4 && suffix[1] === '--format' && suffix[2] === 'json'
            && suffix[3] === '--no-env-resolution')) return undefined
    return {
        stage,
        stackId: topology.stackId,
        configSha256: topology.configSha256,
        batchId: topology.batchId,
        runtimeVersion: topology.runtime.runtimeVersion,
        composeVersion: topology.runtime.composeVersion,
        executableSha256: topology.runtime.runtimeExecutable.sha256,
        projectName: topology.runtime.projectName,
        service: contract.service.id,
        containerId,
        observedAt,
        observationWindow: topology.observationWindow,
        executable: { ...topology.runtime.runtimeExecutable },
        cwd: topology.runtime.cwd,
        env: runtimeComposeEnvironment(topology.runtime.env, topology.runtime.interpolatedNames),
        composeArgvPrefix: step.argv.slice(1, configIndex),
        paths: step.paths,
        consumedFiles: step.consumedFiles,
        filesystemChecks: step.filesystemChecks,
    }
}

function failedBoundaryObservedAt(
    outcome: ExecuteProbeOutcome,
    window: RuntimeObservationWindow,
    previousFinishedAt?: string,
): string | undefined {
    const now = Date.now()
    const windowStart = Date.parse(window.startedAt)
    const windowEnd = Date.parse(window.expiresAt)
    if (now < windowStart || now > windowEnd) return undefined
    if (!outcome.receipt) return outcome.kind === 'refusal' && !outcome.execution.started && outcome.execution.signal === null
        && (!previousFinishedAt || Date.parse(previousFinishedAt) <= now)
        ? new Date(now).toISOString()
        : undefined
    const startedAt = outcome.receipt.startedAt
    const finishedAt = outcome.receipt.finishedAt
    if (!isCanonicalTimestamp(startedAt) || !isCanonicalTimestamp(finishedAt)
        || Date.parse(startedAt) < windowStart || Date.parse(startedAt) > Date.parse(finishedAt)
        || Date.parse(finishedAt) > now || Date.parse(finishedAt) > windowEnd
        || previousFinishedAt && Date.parse(previousFinishedAt) > Date.parse(startedAt)) return undefined
    return finishedAt
}

function issueRuntimeServiceFailure(context: RuntimeServiceFailureLogContext): RuntimeServiceFailureResult {
    const evidence = {} as RuntimeServiceFailureEvidence
    issuedRuntimeServiceFailures.set(evidence, context)
    return { kind: 'complete', evidence }
}

export function admitRuntimeServiceStageOutcome(input: {
    readonly plan: RuntimeServicePlan
    readonly stage: 'start' | 'status' | 'identity'
    readonly outcome: ExecuteProbeOutcome
    readonly startOutcome?: ExecuteProbeOutcome
    readonly statusOutcome?: ExecuteProbeOutcome
}): RuntimeServiceStageOutcomeAdmission {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service stage evidence is unavailable', error) })
    try {
        const planDescriptor = input !== null && typeof input === 'object'
            ? Object.getOwnPropertyDescriptor(input, 'plan')
            : undefined
        const suppliedPlan = planDescriptor && 'value' in planDescriptor
            ? planDescriptor.value as RuntimeServicePlan
            : undefined
        if (suppliedPlan && typeof suppliedPlan === 'object' && typeof suppliedPlan.service === 'string') serviceName = suppliedPlan.service
        const stage = input !== null && typeof input === 'object'
            ? Object.getOwnPropertyDescriptor(input, 'stage')?.value as unknown
            : undefined
        if (stage !== 'start' && stage !== 'status' && stage !== 'identity') {
            if (suppliedPlan?.kind === 'planned' && issuedRuntimeServicePlans.has(suppliedPlan)) consumedRuntimeServicePlans.add(suppliedPlan)
            return unavailable()
        }
        const keys = stage === 'start' ? ['plan', 'stage', 'outcome']
            : stage === 'status' ? ['plan', 'stage', 'outcome', 'startOutcome']
                : ['plan', 'stage', 'outcome', 'startOutcome', 'statusOutcome']
        const captured = captureOwnValues(input, keys)
        const plan = (captured?.plan ?? suppliedPlan) as RuntimeServicePlan | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServicePlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServicePlans.get(plan)
        if (!contract) return unavailable()
        if (!captured) {
            consumedRuntimeServicePlans.add(plan)
            return unavailable()
        }
        const progress = admittedRuntimeServiceStages.get(plan)
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        const step = stage === 'start' ? plan.start : stage === 'status' ? plan.status : plan.identity
        const outcome = suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, step) : undefined
        const suppliedStart = captured?.startOutcome as ExecuteProbeOutcome | undefined
        const suppliedStatus = captured?.statusOutcome as ExecuteProbeOutcome | undefined
        const start = stage === 'start' ? undefined
            : suppliedStart ? authenticatedExecutionOutcome(suppliedStart, plan.start) : undefined
        const status = stage === 'identity' && suppliedStatus
            ? authenticatedExecutionOutcome(suppliedStatus, plan.status)
            : undefined
        const stageExpected = stage === 'start' ? progress === undefined
            : stage === 'status'
                ? progress !== undefined && progress.startOutcome === suppliedStart && progress.statusOutcome === undefined
                : progress !== undefined && progress.startOutcome === suppliedStart && progress.statusOutcome === suppliedStatus
        if (!outcome || !stageExpected
            || stage !== 'start' && (!start || start.kind !== 'complete' || start.stderr.byteLength !== 0)
            || stage === 'identity' && (!status || status.kind !== 'complete' || status.stderr.byteLength !== 0)) {
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            return unavailable()
        }
        const admittedStart = start?.kind === 'complete' ? start : undefined
        const admittedStatus = status?.kind === 'complete' ? status : undefined
        const now = Date.now()
        const window = contract.topologyContract.observationWindow
        if (stage !== 'start' && admittedStart && !receiptWithinWindow(admittedStart, window, now)
            || stage === 'identity' && admittedStatus && (!receiptWithinWindow(admittedStatus, window, now)
                || admittedStart && Date.parse(admittedStart.receipt.finishedAt) > Date.parse(admittedStatus.receipt.startedAt))) {
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            return unavailable()
        }
        const priorStatus = stage === 'identity' && admittedStatus
            ? classifyComposeStatus(admittedStatus.stdout, contract.topologyContract.runtime.projectName, contract.service.id)
            : undefined
        if (priorStatus && priorStatus.kind !== 'valid') {
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            return unavailable()
        }
        const disposition = classifyRuntimeServiceStageEvidence(
            outcome,
            stage,
            contract.topologyContract.runtime.projectName,
            contract.service.id,
            priorStatus?.kind === 'valid' ? priorStatus.value : undefined,
        )
        if (disposition === 'unavailable') {
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            return unavailable()
        }
        if (disposition === 'failure') {
            const previousFinishedAt = stage === 'start' ? undefined
                : stage === 'status' ? admittedStart?.receipt.finishedAt
                    : admittedStatus?.receipt.finishedAt
            const observedAt = failedBoundaryObservedAt(outcome, window, previousFinishedAt)
            const context = observedAt ? runtimeServiceFailureContext(contract, stage, observedAt, null) : undefined
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            if (!context) return unavailable()
            const failure = issueRuntimeServiceFailure(context)
            return failure.kind === 'complete'
                ? { kind: 'failure' as const, service: contract.service.id, evidence: failure.evidence }
                : unavailable()
        }
        if (outcome.kind !== 'complete' || !receiptWithinWindow(outcome, window, now)
            || stage === 'status' && admittedStart && Date.parse(admittedStart.receipt.finishedAt) > Date.parse(outcome.receipt.startedAt)
            || stage === 'identity' && admittedStatus && Date.parse(admittedStatus.receipt.finishedAt) > Date.parse(outcome.receipt.startedAt)) {
            consumedRuntimeServicePlans.add(plan)
            admittedRuntimeServiceStages.delete(plan)
            return unavailable()
        }
        admittedRuntimeServiceStages.set(plan, stage === 'start'
            ? Object.freeze({ startOutcome: suppliedOutcome as object })
            : stage === 'status'
                ? Object.freeze({ startOutcome: suppliedStart as object, statusOutcome: suppliedOutcome as object })
                : Object.freeze({ ...progress!, identityOutcome: suppliedOutcome as object }))
        return { kind: 'admitted' as const, service: contract.service.id }
    } catch (error) {
        return unavailable(error)
    }
}

export function admitRuntimeServiceRevalidationStatus(input: {
    readonly plan: RuntimeServiceRevalidationPlan
    readonly outcome: ExecuteProbeOutcome
}): RuntimeServiceRevalidationStatusAdmission {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service revalidation status is unavailable', error) })
    try {
        const planDescriptor = input !== null && typeof input === 'object'
            ? Object.getOwnPropertyDescriptor(input, 'plan')
            : undefined
        const suppliedPlan = planDescriptor && 'value' in planDescriptor
            ? planDescriptor.value as RuntimeServiceRevalidationPlan
            : undefined
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = (captured?.plan ?? suppliedPlan) as RuntimeServiceRevalidationPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServiceRevalidationPlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServiceRevalidationPlans.get(plan)
        if (!contract) return unavailable()
        if (admittedRuntimeServiceRevalidationStatuses.has(plan)) {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            admittedRuntimeServiceRevalidationStatuses.delete(plan)
            return unavailable()
        }
        if (!captured) {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            return unavailable()
        }
        const outcome = suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.status) : undefined
        const now = Date.now()
        if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0
            || !receiptWithinWindow(outcome, contract.topologyContract.observationWindow, now)) {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            return unavailable()
        }
        const status = classifyComposeStatus(outcome.stdout, contract.topologyContract.runtime.projectName, contract.service.id)
        if (status.kind === 'empty') {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            return { kind: 'stale' as const, service: contract.service.id, expectedContainerId: contract.expectedContainerId }
        }
        if (status.kind === 'malformed') {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            return unavailable()
        }
        if (!contract.expectedContainerId.startsWith(status.value)) {
            consumedRuntimeServiceRevalidationPlans.add(plan)
            return { kind: 'stale' as const, service: contract.service.id, expectedContainerId: contract.expectedContainerId }
        }
        admittedRuntimeServiceRevalidationStatuses.set(plan, suppliedOutcome as object)
        return { kind: 'admitted' as const, service: contract.service.id, expectedContainerId: contract.expectedContainerId }
    } catch (error) {
        return unavailable(error)
    }
}

export function admitRuntimeServicePlanFailure(input: {
    readonly plan: RuntimeServicePlan
    readonly stage: 'start' | 'status' | 'identity'
    readonly outcome: ExecuteProbeOutcome
    readonly startOutcome?: ExecuteProbeOutcome
    readonly statusOutcome?: ExecuteProbeOutcome
}): RuntimeServiceFailureResult {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service failure evidence is unavailable', error) })
    try {
        const planDescriptor = input !== null && typeof input === 'object'
            ? Object.getOwnPropertyDescriptor(input, 'plan')
            : undefined
        const suppliedPlan = planDescriptor && 'value' in planDescriptor
            ? planDescriptor.value as RuntimeServicePlan
            : undefined
        if (suppliedPlan && typeof suppliedPlan === 'object' && typeof suppliedPlan.service === 'string') serviceName = suppliedPlan.service
        const stage = input !== null && typeof input === 'object'
            ? Object.getOwnPropertyDescriptor(input, 'stage')?.value as unknown
            : undefined
        if (stage !== 'start' && stage !== 'status' && stage !== 'identity') {
            if (suppliedPlan?.kind === 'planned' && issuedRuntimeServicePlans.has(suppliedPlan)) consumedRuntimeServicePlans.add(suppliedPlan)
            return unavailable()
        }
        const keys = stage === 'start' ? ['plan', 'stage', 'outcome']
            : stage === 'status' ? ['plan', 'stage', 'outcome', 'startOutcome']
                : ['plan', 'stage', 'outcome', 'startOutcome', 'statusOutcome']
        const captured = captureOwnValues(input, keys)
        const plan = (captured?.plan ?? suppliedPlan) as RuntimeServicePlan | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServicePlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServicePlans.get(plan)
        if (!contract) return unavailable()
        if (!captured) {
            consumedRuntimeServicePlans.add(plan)
            return unavailable()
        }
        const failedStep = stage === 'start' ? plan.start : stage === 'status' ? plan.status : stage === 'identity' ? plan.identity : undefined
        const suppliedFailure = captured?.outcome as ExecuteProbeOutcome | undefined
        const failure = failedStep && suppliedFailure ? authenticatedExecutionOutcome(suppliedFailure, failedStep) : undefined
        if (!failure) return unavailable()
        const now = Date.now()
        const window = contract.topologyContract.observationWindow
        let previousFinishedAt: string | undefined
        let shortId: string | undefined
        if (stage === 'status' || stage === 'identity') {
            const suppliedStart = captured?.startOutcome as ExecuteProbeOutcome | undefined
            const start = suppliedStart ? authenticatedExecutionOutcome(suppliedStart, plan.start) : undefined
            if (!start || start.kind !== 'complete' || start.stderr.byteLength !== 0 || !receiptWithinWindow(start, window, now)) return unavailable()
            previousFinishedAt = start.receipt.finishedAt
        }
        if (stage === 'identity') {
            const suppliedStatus = captured?.statusOutcome as ExecuteProbeOutcome | undefined
            const status = suppliedStatus ? authenticatedExecutionOutcome(suppliedStatus, plan.status) : undefined
            const statusValue = status?.kind === 'complete' && status.stderr.byteLength === 0
                ? classifyComposeStatus(status.stdout, contract.topologyContract.runtime.projectName, contract.service.id)
                : undefined
            if (!status || status.kind !== 'complete' || status.stderr.byteLength !== 0 || !receiptWithinWindow(status, window, now)
                || previousFinishedAt && Date.parse(previousFinishedAt) > Date.parse(status.receipt.startedAt)
                || statusValue?.kind !== 'valid') return unavailable()
            shortId = statusValue.value
            previousFinishedAt = status.receipt.finishedAt
        }
        const disposition = classifyRuntimeServiceStageEvidence(
            failure,
            stage,
            contract.topologyContract.runtime.projectName,
            contract.service.id,
            shortId,
        )
        if (disposition === 'clean') return unavailable()
        if (disposition === 'unavailable') {
            consumedRuntimeServicePlans.add(plan)
            return unavailable()
        }
        const observedAt = failedBoundaryObservedAt(failure, window, previousFinishedAt)
        if (!observedAt) return unavailable()
        const context = runtimeServiceFailureContext(contract, stage, observedAt, null)
        if (!context) return unavailable()
        consumedRuntimeServicePlans.add(plan)
        return issueRuntimeServiceFailure(context)
    } catch (error) {
        return unavailable(error)
    }
}

export function admitRuntimeServiceInspectFailure(input: {
    readonly plan: RuntimeServiceHealthPlan
    readonly outcome: ExecuteProbeOutcome
}): RuntimeServiceFailureResult {
    let serviceName = ''
    const unavailable = (error?: unknown) => ({ kind: 'unavailable' as const, service: serviceName, reason: unavailableReason('runtime service failure evidence is unavailable', error) })
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as RuntimeServiceHealthPlan | undefined
        if (plan && typeof plan === 'object' && typeof plan.service === 'string') serviceName = plan.service
        if (!plan || plan.kind !== 'planned' || consumedRuntimeServiceHealthPlans.has(plan)) return unavailable()
        const contract = issuedRuntimeServiceHealthPlans.get(plan)
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.step) : undefined
        if (!contract || !outcome) return unavailable()
        const semanticFailure = outcome.kind === 'refusal' || outcome.stderr.byteLength !== 0
            || !parseRuntimeServiceInspection(outcome.stdout, contract)
        if (!semanticFailure) return unavailable()
        const observedAt = failedBoundaryObservedAt(outcome, contract.topologyContract.observationWindow, contract.identityFinishedAt)
        if (!observedAt) return unavailable()
        const context = runtimeServiceFailureContext(contract, 'inspect', observedAt, contract.containerId)
        if (!context) return unavailable()
        consumedRuntimeServiceHealthPlans.add(plan)
        return issueRuntimeServiceFailure(context)
    } catch (error) {
        return unavailable(error)
    }
}

export function consumeRuntimeServiceFailureForLogs(evidence: RuntimeServiceFailureEvidence): RuntimeServiceFailureLogContext | undefined {
    if (!evidence || typeof evidence !== 'object') return undefined
    const context = issuedRuntimeServiceFailures.get(evidence)
    if (!context) return undefined
    issuedRuntimeServiceFailures.delete(evidence)
    return context
}

export interface RuntimeServiceFailureContext {
    readonly observation: RuntimeServiceObservation
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
}

export function consumeRuntimeServiceObservationForFailureLogs(value: RuntimeServiceObservation): RuntimeServiceFailureContext | undefined {
    try {
        const contract = value !== null && typeof value === 'object' ? issuedRuntimeServiceObservations.get(value) : undefined
        const now = Date.now()
        if (!contract || consumedRuntimeServiceFailureObservations.has(value)
            || now < Date.parse(contract.topologyContract.observationWindow.startedAt)
            || now > Date.parse(contract.topologyContract.observationWindow.expiresAt)) return undefined
        const env = runtimeCommandEnvironment(
            contract.topologyContract.runtime.env,
            contract.topologyContract.runtime.interpolatedNames,
        )
        const context = {
            observation: value,
            executable: { ...contract.topologyContract.runtime.runtimeExecutable },
            cwd: contract.topologyContract.runtime.cwd,
            env,
        }
        consumedRuntimeServiceFailureObservations.add(value)
        return context
    } catch {
        // A throwing accessor or proxy trap makes the failure observation unusable, which the caller refuses.
        return undefined
    }
}

export type RuntimeStopPlan =
    | { readonly kind: 'planned'; readonly step: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly reason: string }

export type RuntimeStopObservationPlan =
    | { readonly kind: 'planned'; readonly step: ExecutionStep }
    | { readonly kind: 'unavailable'; readonly reason: string }

declare const runtimeStoppedAuthorityBrand: unique symbol
export interface RuntimeStoppedAuthority {
    readonly [runtimeStoppedAuthorityBrand]: true
}

declare const runtimeStopFailureAuthorityBrand: unique symbol
export interface RuntimeStopFailureAuthority {
    readonly [runtimeStopFailureAuthorityBrand]: true
}

interface RuntimeStopContract {
    readonly topology: TopologyEvidenceContract
    readonly reservation: DrainReservation
    readonly execution: RuntimeDrainExecutionAuthority
}

interface RuntimeStopObservationContract extends RuntimeStopContract {
    readonly stopFinishedAt: string
}

const issuedRuntimeStopPlans = new WeakMap<object, RuntimeStopContract>()
const consumedRuntimeStopPlans = new WeakSet<object>()
const issuedRuntimeStopObservationPlans = new WeakMap<object, RuntimeStopObservationContract>()
const consumedRuntimeStopObservationPlans = new WeakSet<object>()
const issuedRuntimeStoppedAuthorities = new WeakMap<object, DrainOutcomeAuthority>()
const issuedRuntimeStopFailureAuthorities = new WeakMap<object, DrainOutcomeAuthority>()

function unavailableRuntimeStop(error?: unknown): { readonly kind: 'unavailable'; readonly reason: string } {
    return { kind: 'unavailable', reason: unavailableReason('runtime stop evidence is unavailable', error) }
}

export function createRuntimeStopPlan(input: {
    readonly topology: RuntimeTopologyEvidence
    readonly attempt: DrainAttemptAuthority
}): RuntimeStopPlan {
    try {
        const captured = captureOwnValues(input, ['topology', 'attempt'])
        const topology = captured?.topology as RuntimeTopologyEvidence | undefined
        const attemptAuthority = captured?.attempt as DrainAttemptAuthority | undefined
        const topologyContract = topology && typeof topology === 'object' ? issuedTopologyEvidence.get(topology) : undefined
        const candidate = attemptAuthority && typeof attemptAuthority === 'object'
            ? inspectDrainAttemptAuthority(attemptAuthority) : undefined
        const reservation = candidate?.reservation
        const attempt = candidate?.attempt
        const now = Date.now()
        if (!topologyContract || !reservation || !attempt || attempt.status !== 'active'
            || reservation.stackId !== topologyContract.stackId
            || reservation.configSha256 !== topologyContract.configSha256
            || attempt.currentStage !== 'runtime-stop' || attempt.currentTarget !== reservation.stackId
            || now < Date.parse(topologyContract.observationWindow.startedAt)
            || now > Date.parse(topologyContract.observationWindow.expiresAt)
            || now < Date.parse(attempt.committedAt) || now > Date.parse(attempt.validThrough)) return unavailableRuntimeStop()
        const remainingMs = Date.parse(attempt.validThrough) - now
        const step = derivedComposeStep(
            { ...topologyContract.step, timeoutMs: topologyContract.step.timeoutMs + COMPOSE_STOP_GRACE_MS * dependencyLevels(topologyContract.services) },
            `runtime:docker-compose:stop:${topologyContract.runtime.projectName}`,
            'stop',
            ['--progress', 'quiet', 'stop'],
            OUTPUT_LIMIT_BYTES,
            reservation.generation,
            remainingMs,
            attempt.validThrough,
            topologyContract.runtime.interpolatedNames,
        )
        if (!step) return unavailableRuntimeStop()
        const execution = openRuntimeDrainExecution({ authority: attemptAuthority!, candidate: candidate! })
        if (!execution) return unavailableRuntimeStop()
        const fence = inspectDrainExecutionFence(execution)
        const fencedStep = fence && snapshotExecutionStep({ ...step, executionFence: fence })
        if (!fencedStep) return unavailableRuntimeStop()
        const plan = { kind: 'planned' as const, step: fencedStep }
        issuedRuntimeStopPlans.set(plan, Object.freeze({ topology: topologyContract, reservation, execution }))
        return plan
    } catch (error) { return unavailableRuntimeStop(error) }
}

export function createRuntimeStopObservationPlan(input: {
    readonly plan: RuntimeStopPlan
    readonly outcome: ExecuteProbeOutcome
}): RuntimeStopObservationPlan {
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as RuntimeStopPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (!plan || plan.kind !== 'planned' || consumedRuntimeStopPlans.has(plan)) return unavailableRuntimeStop()
        const contract = issuedRuntimeStopPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.step) : undefined
        consumedRuntimeStopPlans.add(plan)
        if (!contract || !outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0 || !outcome.receipt
            || !isCanonicalTimestamp(outcome.receipt.startedAt) || !isCanonicalTimestamp(outcome.receipt.finishedAt)
            || Date.parse(outcome.receipt.startedAt) < Date.parse(contract.reservation.attempt!.committedAt)
            || Date.parse(outcome.receipt.startedAt) > Date.parse(outcome.receipt.finishedAt)
            || Date.parse(outcome.receipt.finishedAt) > Date.parse(contract.reservation.attempt!.validThrough)
            || Date.parse(outcome.receipt.finishedAt) > Date.now()) return unavailableRuntimeStop()
        const step = derivedComposeStep(
            contract.topology.step,
            `runtime:docker-compose:stopped:${contract.topology.runtime.projectName}`,
            'ps-stopped',
            ['ps', '--format', 'json', '--status', 'running'],
            OUTPUT_LIMIT_BYTES,
            contract.reservation.generation,
            MAX_OBSERVATION_WINDOW_MS,
            undefined,
            contract.topology.runtime.interpolatedNames,
        )
        if (!step) return unavailableRuntimeStop()
        const observation = { kind: 'planned' as const, step }
        issuedRuntimeStopObservationPlans.set(observation, Object.freeze({ ...contract, stopFinishedAt: outcome.receipt.finishedAt }))
        return observation
    } catch (error) { return unavailableRuntimeStop(error) }
}

export function admitRuntimeStopped(input: {
    readonly plan: RuntimeStopObservationPlan
    readonly outcome: ExecuteProbeOutcome
}): { readonly kind: 'complete'; readonly authority: RuntimeStoppedAuthority } | { readonly kind: 'unavailable'; readonly reason: string } {
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as RuntimeStopObservationPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (!plan || plan.kind !== 'planned' || consumedRuntimeStopObservationPlans.has(plan)) return unavailableRuntimeStop()
        const contract = issuedRuntimeStopObservationPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.step) : undefined
        consumedRuntimeStopObservationPlans.add(plan)
        if (!contract || !outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0 || outcome.stdout.byteLength !== 0
            || !outcome.receipt || !isCanonicalTimestamp(outcome.receipt.startedAt) || !isCanonicalTimestamp(outcome.receipt.finishedAt)
            || Date.parse(outcome.receipt.startedAt) < Date.parse(contract.stopFinishedAt)
            || Date.parse(outcome.receipt.startedAt) > Date.parse(outcome.receipt.finishedAt)
            || Date.parse(outcome.receipt.finishedAt) > Date.parse(contract.reservation.attempt!.validThrough)
            || Date.parse(outcome.receipt.finishedAt) > Date.now()) return unavailableRuntimeStop()
        const fact = {
            purpose: contract.reservation.purpose,
            stackId: contract.reservation.stackId,
            configSha256: contract.reservation.configSha256,
            planDigest: contract.reservation.planDigest,
            operationBasis: contract.reservation.operationBasis,
            coordinationRevision: contract.reservation.coordinationRevision,
            reservationId: contract.reservation.reservationId,
            reservedAt: contract.reservation.reservedAt,
            generation: contract.reservation.generation,
            attemptId: contract.reservation.attempt!.attemptId,
            attemptRevision: contract.reservation.attempt!.committedRevision,
            attemptCommittedAt: contract.reservation.attempt!.committedAt,
            validThrough: contract.reservation.attempt!.validThrough,
            actionIndex: contract.reservation.attempt!.actionIndex,
            currentTarget: contract.reservation.attempt!.currentTarget,
            currentStage: contract.reservation.attempt!.currentStage,
            observedAt: outcome.receipt.finishedAt,
        } satisfies RuntimeStopped
        const settled = settleRuntimeDrainSuccess({ authority: contract.execution, fact })
        if (!settled) return unavailableRuntimeStop()
        const authority = {} as RuntimeStoppedAuthority
        issuedRuntimeStoppedAuthorities.set(authority, settled)
        return { kind: 'complete', authority }
    } catch (error) { return unavailableRuntimeStop(error) }
}

export function admitRuntimeStopFailure(input: {
    readonly plan: RuntimeStopPlan
    readonly outcome: ExecuteProbeOutcome
}): { readonly kind: 'complete'; readonly authority: RuntimeStopFailureAuthority } | { readonly kind: 'unavailable'; readonly reason: string } {
    try {
        const captured = captureOwnValues(input, ['plan', 'outcome'])
        const plan = captured?.plan as RuntimeStopPlan | undefined
        const suppliedOutcome = captured?.outcome as ExecuteProbeOutcome | undefined
        if (!plan || plan.kind !== 'planned' || consumedRuntimeStopPlans.has(plan)) return unavailableRuntimeStop()
        const contract = issuedRuntimeStopPlans.get(plan)
        const outcome = contract && suppliedOutcome ? authenticatedExecutionOutcome(suppliedOutcome, plan.step) : undefined
        consumedRuntimeStopPlans.add(plan)
        if (!contract || !outcome || outcome.kind !== 'refusal' || outcome.receipt !== undefined
            || outcome.execution.started || outcome.execution.signal !== null || outcome.execution.exitCode === 0) return unavailableRuntimeStop()
        const attempt = contract.reservation.attempt!
        const failedAt = new Date().toISOString()
        const fact = { ...attempt, failedAt } satisfies DrainAttemptFailure
        const settled = settleRuntimeDrainFailure({ authority: contract.execution, fact })
        if (!settled) return unavailableRuntimeStop()
        const authority = {} as RuntimeStopFailureAuthority
        issuedRuntimeStopFailureAuthorities.set(authority, settled)
        return { kind: 'complete', authority }
    } catch (error) { return unavailableRuntimeStop(error) }
}

export function consumeRuntimeStopFailure(authority: RuntimeStopFailureAuthority): DrainOutcomeAuthority | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const outcome = issuedRuntimeStopFailureAuthorities.get(authority)
    if (!outcome) return undefined
    issuedRuntimeStopFailureAuthorities.delete(authority)
    return outcome
}

export function consumeRuntimeStopped(authority: RuntimeStoppedAuthority): DrainOutcomeAuthority | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const outcome = issuedRuntimeStoppedAuthorities.get(authority)
    if (!outcome) return undefined
    issuedRuntimeStoppedAuthorities.delete(authority)
    return outcome
}
