import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isProxy } from 'node:util/types'
import { parse as parseYaml } from 'yaml'

import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { libexecProgram } from '../environment-exec/libexec-program.js'
import { decisionSubjects, type GeneratedEnvironment as GeneratedEnvironmentDeclaration } from '../schema.js'
import { ENVIRONMENT_CODES, inStackCommand, snapshotEnvironmentObservation, snapshotExecutionStep, snapshotGeneratedJson, type EnvironmentObservation, type ExecutionStep, type StackId } from './contract.js'
import { resolvedDockerExecutable, resolvedExecutable, type ResolvedExecutable } from './executable.js'
import {
    authenticateGeneratedRender,
    projectGeneratedComposeArtifactAuthority,
    renderGeneratedEnvironment,
    type GeneratedComposeArtifactAuthority,
    type GeneratedEnvironmentInput,
    type GeneratedEnvironmentResult,
    type GeneratedObservationPlan,
    type GeneratedOwnedFile,
} from './generated-render.js'
import { redactSensitiveText } from './sensitive.js'
import { isRuntimeServiceEvidence, isRuntimeTopologyEvidence, projectRuntimeExecutionEnvironment, type RuntimeServiceEvidence, type RuntimeTopologyEvidence } from './runtime.js'
import { composeProcessEnvironment } from './compose-environment.js'

export { projectGeneratedComposeArtifactAuthority, renderGeneratedEnvironment } from './generated-render.js'
export type {
    GeneratedComposeArtifactAuthority,
    GeneratedEnvironmentInput,
    GeneratedEnvironmentResult,
    GeneratedObservationPlan,
    GeneratedOwnedFile,
} from './generated-render.js'

export const mechanism = {
    id: 'generated-environment',
    module: 'packages/cockpit/src/environment/generated-stack.ts',
    exports: ['renderGeneratedEnvironment', 'inspectGeneratedEnvironment', 'undecidedGeneratedDecisions', 'projectGeneratedComposeArtifactAuthority', 'projectGeneratedRuntimeAuthority', 'inspectGeneratedRuntimeAuthority', 'resolveGeneratedDataOperation', 'createGeneratedObservationExecution', 'admitGeneratedObservation', 'isGeneratedObservationAdmission', 'observeGeneratedEnvironmentHealth', 'observeGeneratedEnvironment', 'isGeneratedObservation', 'isGeneratedRegistryAuthenticationObservation', 'observationDeclarations', 'registryAuthenticationObservationDeclarations'],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'generated-environment', owner: mechanism.id, postures: ['generated-environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE, isIssued: isGeneratedObservation, issuedAt: generatedObservationIssuedAt },
] as const)

export const registryAuthenticationObservationDeclarations = Object.freeze([
    { id: 'registry-authentication', owner: mechanism.id, postures: ['registry-authentication'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.REGISTRY_AUTH_UNAVAILABLE, isIssued: isGeneratedRegistryAuthenticationObservation, issuedAt: generatedRegistryAuthenticationObservationIssuedAt },
] as const)

const SHA256 = /^[a-f0-9]{64}$/
const SENSITIVE_TEXT = /(?:\/Users\/|\/home\/|[A-Za-z]:\\|-----BEGIN [A-Z ]+-----|https?:\/\/[^\s/:]+:[^\s/@]+@)/i
const DECISION_MAX_AGE_DAYS = 366
const MAX_CAPTURE_NODES = 100_000
const MAX_CAPTURE_STRING_BYTES = 16_777_216
const MAX_CAPTURE_BYTES = 33_554_432
const issuedRegistryAuthenticationObservations = new WeakMap<object, number>()


export interface GeneratedArtifactCandidate {
    readonly path: string
    readonly bytes: string
}

export type GeneratedInspectionResult = Readonly<{
    kind: 'passed'
}> | Readonly<{
    kind: 'refusal' | 'unavailable'
    code: string
    target: string
    reason: string
}>

export interface GeneratedObservationRuntime {
    readonly root: string
    readonly executable: ResolvedExecutable
    readonly composeFiles: readonly Readonly<{ path: string; sha256: string }>[]
    readonly projectName: string
    readonly publicEnv: Readonly<Record<string, string>>
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
    readonly hostExecutables?: Readonly<Record<string, ResolvedExecutable>>
    readonly serviceAuthority?: Readonly<{ topology: RuntimeTopologyEvidence; evidence: RuntimeServiceEvidence }>
}

export interface GeneratedHostInputRoot {
    readonly path: string
    readonly dev: number
    readonly ino: number
}

export interface GeneratedRuntimeAuthority { readonly kind: 'generated-runtime-authority' }
type GeneratedDataDeclaration = NonNullable<GeneratedEnvironmentDeclaration['data']>
export type GeneratedDataOperation = GeneratedDataDeclaration['modes'][number]['operations'][number]['operation']
export type GeneratedDataStepContext = Readonly<{
    readonly id: string
    readonly phase: 'prerequisite' | 'operation' | 'probe' | 'restore-rewrite' | 'fixture-volume-operation' | 'fixture-volume-probe'
    readonly operationId?: string
    readonly operationKind?: GeneratedDataDeclaration['modes'][number]['operations'][number]['kind']
    readonly after?: readonly string[]
    readonly provenance?: Readonly<{ source: string; reason: string }>
}>

export type GeneratedRuntimeEnvelope = Readonly<{
    rendered: Extract<GeneratedEnvironmentResult, { kind: 'complete' }>
    declaration: GeneratedEnvironmentDeclaration
    topology: RuntimeTopologyEvidence
    runtime: GeneratedObservationRuntime
    hostInputRoots: Readonly<Record<string, GeneratedHostInputRoot>>
    stackId: StackId
    sourceSha256: string
    generation: string
}>

export type GeneratedObservationExecution = Readonly<{
    kind: 'planned'
    id: string
    step: ExecutionStep
}> | Readonly<{
    kind: 'unavailable'
    id: string
    reason: string
}>

export type GeneratedObservationAdmission = Readonly<{
    kind: 'complete' | 'failed' | 'unavailable'
    id: string
    target: string
    stackId: StackId
    sourceSha256: string
    generation: string
    observedAt: string
    expected: Readonly<Record<string, unknown>>
    reason: string
}>

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

const issuedInspections = new WeakMap<object, object>()
const consumedInspections = new WeakSet<object>()
const issuedRuntimeAuthorities = new WeakMap<object, Readonly<{
    rendered: object
    declaration: GeneratedEnvironmentDeclaration
    topology: RuntimeTopologyEvidence
    runtime: GeneratedObservationRuntime
    hostInputRoots: Readonly<Record<string, GeneratedHostInputRoot>>
    stackId: StackId
    sourceSha256: string
    generation: string
}>>()
const issuedObservationExecutions = new WeakMap<object, Readonly<{ plan: GeneratedObservationPlan; rendered: object; stackId: StackId; sourceSha256: string; generation: string; step: ExecutionStep }>>()
const consumedObservationExecutions = new WeakSet<object>()
const issuedObservationAdmissions = new WeakMap<object, object>()
const consumedObservationAdmissions = new WeakSet<object>()
const issuedGeneratedObservations = new WeakMap<object, number>()

function generatedObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedGeneratedObservations.get(value) : undefined
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function captureData(value: unknown): unknown | undefined {
    let nodes = 0
    let bytes = 0
    const visit = (candidate: unknown): unknown | undefined => {
        nodes += 1
        if (nodes > MAX_CAPTURE_NODES) return undefined
        if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number') return candidate
        if (typeof candidate === 'string') {
            const stringBytes = Buffer.byteLength(candidate, 'utf8')
            bytes += stringBytes
            return stringBytes <= MAX_CAPTURE_STRING_BYTES && bytes <= MAX_CAPTURE_BYTES ? candidate : undefined
        }
        if (typeof candidate !== 'object' || isProxy(candidate)) return undefined
        if (Array.isArray(candidate)) {
            if (Object.getOwnPropertySymbols(candidate).length > 0) return undefined
            if (candidate.length > MAX_CAPTURE_NODES) return undefined
            const descriptors = Object.getOwnPropertyDescriptors(candidate)
            const keys = Object.keys(descriptors).filter((key) => key !== 'length')
            if (keys.length !== candidate.length || keys.some((key, index) => key !== String(index))) return undefined
            const values: unknown[] = []
            for (const key of keys) {
                const descriptor = descriptors[key]!
                if (descriptor.get || descriptor.set || !descriptor.enumerable) return undefined
                const captured = visit(descriptor.value)
                if (captured === undefined) return undefined
                values.push(captured)
            }
            return Object.freeze(values)
        }
        const record = ownRecord(candidate)
        if (!record) return undefined
        const captured: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(record)) {
            const value = visit(item)
            if (value === undefined) return undefined
            captured[key] = value
        }
        return Object.freeze(captured)
    }
    return visit(value)
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function sensitiveDecisionSource(declaration: GeneratedEnvironmentDeclaration): boolean {
    const visit = (value: unknown): boolean => typeof value === 'string'
        ? SENSITIVE_TEXT.test(value) || redactSensitiveText(value) !== value
        : Array.isArray(value)
            ? value.some(visit)
            : value !== null && typeof value === 'object'
                ? Object.values(value).some(visit)
                : false
    return visit(declaration.decisions.entries)
        || visit(declaration.vendors.map(({ reason, provenance }) => ({ reason, provenance })))
}


function decisionInspection(declaration: GeneratedEnvironmentDeclaration, bytes: string, now: string): GeneratedInspectionResult | undefined {
    const headings = [...bytes.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1]!)
    // Undecided subjects are rendered too, so the log covers every subject, decided or not.
    const expected = decisionSubjects(declaration).map(({ subject, subjectId }) => `${subject}:${subjectId}`).sort()
    if (new Set(headings).size !== headings.length) return { kind: 'refusal', code: 'GENERATED_DECISION_DUPLICATE', target: declaration.decisions.path, reason: 'decision log contains a duplicate entry' }
    if (headings.length !== expected.length || headings.sort().some((heading, index) => heading !== expected[index])) return { kind: 'refusal', code: 'GENERATED_DECISION_COVERAGE', target: declaration.decisions.path, reason: 'decision log does not cover the declaration exactly' }
    const today = Date.parse(`${now}T00:00:00.000Z`)
    if (!Number.isFinite(today)) return { kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID', target: declaration.decisions.path, reason: 'inspection date is invalid' }
    for (const entry of declaration.decisions.entries) {
        const decided = Date.parse(`${entry.decided_on}T00:00:00.000Z`)
        if (decided > today) return { kind: 'refusal', code: 'GENERATED_DECISION_FUTURE', target: entry.id, reason: 'decision date is in the future' }
        if ((today - decided) / 86_400_000 > DECISION_MAX_AGE_DAYS) return { kind: 'refusal', code: 'GENERATED_DECISION_STALE', target: entry.id, reason: 'decision entry requires review' }
    }
    if (sensitiveDecisionSource(declaration) || SENSITIVE_TEXT.test(bytes) || redactSensitiveText(bytes) !== bytes) return { kind: 'refusal', code: 'GENERATED_DECISION_SENSITIVE', target: declaration.decisions.path, reason: 'decision log contains a machine-local path or secret material' }
    return undefined
}

/** The decision-log subjects of an issued render that have no entry, for check to report. */
export function undecidedGeneratedDecisions(rendered: GeneratedEnvironmentResult): Readonly<{ path: string; undecided: number; subjects: readonly string[] }> | undefined {
    const declaration = authenticateGeneratedRender(rendered)?.declaration
    if (!declaration) return undefined
    const decided = new Set(declaration.decisions.entries.map((entry) => `${entry.subject}:${entry.subject_id}`))
    const subjects = Object.freeze(decisionSubjects(declaration).map(({ subject, subjectId }) => `${subject}:${subjectId}`).filter((key) => !decided.has(key)))
    return Object.freeze({ path: declaration.decisions.path, undecided: subjects.length, subjects })
}

export function inspectGeneratedEnvironment(input: {
    readonly rendered: GeneratedEnvironmentResult
    readonly candidates: readonly GeneratedArtifactCandidate[]
    readonly now: string
}): GeneratedInspectionResult {
    const outer = ownRecord(input)
    if (!outer || !exactKeys(outer, ['rendered', 'candidates', 'now']) || typeof outer.now !== 'string') return { kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID', target: 'generated-environment', reason: 'generated environment inspection input is invalid' }
    const rawRendered = outer.rendered
    if (rawRendered === null || typeof rawRendered !== 'object' || isProxy(rawRendered)) return { kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID', target: 'generated-environment', reason: 'generated environment inspection input is invalid' }
    const authority = authenticateGeneratedRender(rawRendered as GeneratedEnvironmentResult)
    if (!authority) {
        const refusal = ownRecord(rawRendered)
        if (refusal?.kind === 'refusal' && typeof refusal.code === 'string' && typeof refusal.reason === 'string') return { kind: 'refusal', code: refusal.code, target: 'generated-environment', reason: refusal.reason }
        return { kind: 'refusal', code: 'GENERATED_RENDER_UNAUTHENTICATED', target: 'generated-environment', reason: 'generated environment result was not issued by the renderer' }
    }
    const rendered = rawRendered as Extract<GeneratedEnvironmentResult, { kind: 'complete' }>
    const declaration = authority?.declaration
    if (!declaration) return { kind: 'refusal', code: 'GENERATED_RENDER_UNAUTHENTICATED', target: 'generated-environment', reason: 'generated environment result was not issued by the renderer' }
    const capturedCandidates = captureData(outer.candidates)
    if (!Array.isArray(capturedCandidates) || capturedCandidates.length > 1_024) return { kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID', target: 'generated-environment', reason: 'generated artifact candidates are invalid or exceed their bound' }
    const rows = capturedCandidates.map(ownRecord)
    if (rows.some((row) => !row || !exactKeys(row, ['path', 'bytes']) || typeof row.path !== 'string' || typeof row.bytes !== 'string')) return { kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID', target: 'generated-environment', reason: 'generated artifact candidates are invalid or exceed their bound' }
    const candidates = new Map(rows.map((candidate) => [candidate!.path as string, candidate!.bytes as string]))
    if (candidates.size !== rows.length || [...candidates].some(([path]) => !rendered.manifest.some((file) => file.path === path))) return { kind: 'refusal', code: 'GENERATED_PATH_UNOWNED', target: 'generated-environment', reason: 'candidate contains an unowned or duplicate path' }
    for (const file of rendered.manifest) {
        const bytes = candidates.get(file.path)
        if (bytes === undefined) return { kind: 'refusal', code: 'GENERATED_ARTIFACT_MISSING', target: file.path, reason: 'owned generated artifact is missing' }
        if (file.path === declaration.decisions.path) {
            const decision = decisionInspection(declaration, bytes, outer.now)
            if (decision) return decision
        }
        if (sha256(bytes) !== file.sha256) return { kind: 'refusal', code: 'GENERATED_ARTIFACT_DRIFT', target: file.path, reason: 'owned generated artifact differs from canonical bytes' }
    }
    try {
        const parsedCompose = parseYaml(rendered.compose)
        if (parsedCompose === null || typeof parsedCompose !== 'object') throw new TypeError('not a mapping')
    } catch {
        return { kind: 'refusal', code: 'GENERATED_COMPOSE_INVALID', target: declaration.compose_file, reason: 'generated Compose is not valid YAML' }
    }
    const inspection = Object.freeze({ kind: 'passed' as const })
    issuedInspections.set(inspection, rendered)
    return inspection
}


const SAFE_RUNTIME_ENV = new Set(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
const GENERATED_RUNTIME_IDENTITY_ENV = new Set(['COCKPIT_OWNER_ID', 'COCKPIT_STACK_ID'])

function generatedComposePrefix(
    runtime: GeneratedObservationRuntime,
    docker: ResolvedExecutable,
    activeProfiles: readonly string[],
): readonly [string, ...string[]] {
    const fileArgs = runtime.composeFiles.flatMap(({ path }) => ['--file', path])
    const profileArgs = [...new Set(activeProfiles)].sort().flatMap((profile) => ['--profile', profile])
    const prefix: [string, ...string[]] = [
        docker.canonicalPath, 'compose', '--project-directory', runtime.root, ...fileArgs,
        '--project-name', runtime.projectName, ...profileArgs,
    ]
    return Object.freeze(prefix)
}

function generatedObservationStep(
    observation: GeneratedObservationPlan,
    runtime: GeneratedObservationRuntime,
    activeProfiles: readonly string[],
    declaredPortVariables: ReadonlySet<string>,
    hostInputRoots: Readonly<Record<string, GeneratedHostInputRoot>>,
): ExecutionStep | undefined {
    const docker = resolvedDockerExecutable(runtime.executable)
    if (!docker || !isAbsolute(runtime.root) || normalize(runtime.root) !== runtime.root
        || !/^[a-z0-9][a-z0-9_-]*$/.test(runtime.projectName)
        || runtime.composeFiles.length === 0
        || runtime.composeFiles.some(({ path, sha256: digest }) => !isAbsolute(path) || normalize(path) !== path || !SHA256.test(digest))
        || Object.entries(runtime.publicEnv).some(([name, value]) => (!SAFE_RUNTIME_ENV.has(name)
            && !GENERATED_RUNTIME_IDENTITY_ENV.has(name) && !declaredPortVariables.has(name))
            || typeof value !== 'string' || value.includes('\0'))
        || !Number.isSafeInteger(runtime.stdoutLimitBytes) || runtime.stdoutLimitBytes < 0 || runtime.stdoutLimitBytes > 16_777_216
        || !Number.isSafeInteger(runtime.stderrLimitBytes) || runtime.stderrLimitBytes < 0 || runtime.stderrLimitBytes > 16_777_216) return undefined
    let argv: readonly [string, ...string[]]
    let argv0: string
    let cwd = runtime.root
    let timeoutMs: number
    let consumedFiles: ExecutionStep['consumedFiles']
    let usesCompose = false
    let measuredPaths: readonly string[] = []
    if (observation.kind === 'mount-lstat' || observation.kind === 'toolchain-pin') {
        const currentNode = realpathSync(process.execPath)
        const node = Object.values(runtime.hostExecutables ?? {})
            .map((value) => resolvedExecutable(value)).find((value) => value?.canonicalPath === currentNode)
        const root = typeof observation.expected.service === 'string' ? hostInputRoots[observation.expected.service] : undefined
        if (!node || !root) return undefined
        const target = resolve(root.path, observation.target)
        const relation = relative(root.path, target)
        if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return undefined
        const expectedType = observation.expected.type
        const observed = observation.expected.observed
        const pinned = observation.expected.pinned
        if (observation.kind === 'mount-lstat' && expectedType !== 'file' && expectedType !== 'directory'
            || observation.kind === 'toolchain-pin' && (typeof observed !== 'string' || typeof pinned !== 'string')) return undefined
        measuredPaths = Object.freeze([target])
        // Throws with the cause; the planner reports it as the observation's unavailable reason.
        const probe = libexecProgram('host-input-probe.cjs')
        // '--' ends Node's own options, so the program path can never be read as one.
        argv = Object.freeze([node.canonicalPath, '--', probe.path, target, JSON.stringify(root), observation.kind,
            ...(observation.kind === 'mount-lstat' ? [expectedType as string] : [observed as string, pinned as string])]) as readonly [string, ...string[]]
        argv0 = node.invocationPath
        timeoutMs = 5_000
        consumedFiles = Object.freeze([{
            path: node.canonicalPath, sha256: node.sha256, maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]), executable: true, executionMode: node.executionMode,
        }, {
            path: probe.path, sha256: probe.sha256, maxBytes: probe.maxBytes,
            argvIndexes: Object.freeze([2]), executable: false,
        }])
    } else if (observation.kind === 'image-startup-launcher') {
        argv = Object.freeze([
            docker.canonicalPath, 'run', '--rm', '--entrypoint', observation.launcher.entrypoint,
            observation.launcher.image, ...observation.launcher.argv,
        ]) as readonly [string, ...string[]]
        argv0 = docker.invocationPath
        timeoutMs = observation.launcher.timeoutSeconds * 1_000
        consumedFiles = Object.freeze([{
            path: docker.canonicalPath, sha256: docker.sha256, maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]), executable: true, executionMode: docker.executionMode,
        }])
    } else if (observation.kind === 'compose-variable') {
        usesCompose = true
        argv = Object.freeze([
            ...generatedComposePrefix(runtime, docker, activeProfiles), 'config', '--format', 'json',
        ]) as readonly [string, ...string[]]
        argv0 = docker.invocationPath
        timeoutMs = 5_000
        consumedFiles = Object.freeze([
            { path: docker.canonicalPath, sha256: docker.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: docker.executionMode },
            ...runtime.composeFiles.map(({ path, sha256: digest }, index) => ({ path, sha256: digest, maxBytes: 1_048_576, argvIndexes: Object.freeze([5 + index * 2]), executable: false as const })),
        ])
    } else {
        const operation = observation.operation
        if (!operation) return undefined
        const resolvedCwd = resolve(runtime.root, operation.cwd)
        const relation = relative(runtime.root, resolvedCwd)
        if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return undefined
        cwd = resolvedCwd
        timeoutMs = operation.timeout_seconds * 1_000
        if (operation.location === 'host') {
            const executable = resolvedExecutable(runtime.hostExecutables?.[operation.argv[0]])
            if (!executable) return undefined
            argv = Object.freeze([executable.canonicalPath, ...operation.argv.slice(1)]) as readonly [string, ...string[]]
            argv0 = executable.invocationPath
            consumedFiles = Object.freeze([{
                path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
                argvIndexes: Object.freeze([0]), executable: true, executionMode: executable.executionMode,
            }])
        } else {
            usesCompose = true
            argv = Object.freeze([
                ...generatedComposePrefix(runtime, docker, activeProfiles),
                'exec', '-T', operation.service!, ...inStackCommand(operation.cwd, operation.argv),
            ]) as readonly [string, ...string[]]
            argv0 = docker.invocationPath
            consumedFiles = Object.freeze([
                { path: docker.canonicalPath, sha256: docker.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: docker.executionMode },
                ...runtime.composeFiles.map(({ path, sha256: digest }, index) => ({ path, sha256: digest, maxBytes: 1_048_576, argvIndexes: Object.freeze([5 + index * 2]), executable: false as const })),
            ])
        }
    }
    const env = usesCompose
        ? composeProcessEnvironment(runtime.publicEnv)
        : Object.freeze({ ...runtime.publicEnv })
    return snapshotExecutionStep({
        id: `generated-observation:${observation.id}`,
        argv, argv0, cwd, env, timeoutMs,
        stdoutLimitBytes: runtime.stdoutLimitBytes, stderrLimitBytes: runtime.stderrLimitBytes,
        paths: Object.freeze([...runtime.composeFiles.map(({ path }) => path), ...measuredPaths]), ports: Object.freeze([]),
        labels: Object.freeze({ generatedObservationId: observation.id, generatedObservationKind: observation.kind }),
        expected: Object.freeze([]), consumedFiles, filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    })
}

function effectiveObservationPlan(
    plan: GeneratedObservationPlan,
    runtime: GeneratedObservationRuntime,
): GeneratedObservationPlan | undefined {
    if (plan.kind !== 'compose-variable') return plan
    const ports = plan.expected.ports
    if (!Array.isArray(ports)) return undefined
    const effective = ports.map((value) => {
        const row = ownRecord(value)
        if (!row || !exactKeys(row, ['published', 'service', 'target', 'variable'])
            || typeof row.variable !== 'string' || typeof row.service !== 'string'
            || !Number.isSafeInteger(row.published) || !Number.isSafeInteger(row.target)) return undefined
        const selected = runtime.publicEnv[row.variable]
        const published = selected === undefined ? row.published
            : /^\d+$/.test(selected) ? Number(selected) : undefined
        if (!Number.isSafeInteger(published) || (published as number) < 1 || (published as number) > 65_535) return undefined
        return Object.freeze({ ...row, published })
    })
    if (effective.some((value) => value === undefined)) return undefined
    return Object.freeze({ ...plan, expected: Object.freeze({ ports: Object.freeze(effective) }) })
}

function composePortsMatch(stdout: Buffer, expected: Readonly<Record<string, unknown>>): boolean {
    try {
        const ports = expected.ports
        if (!Array.isArray(ports)) return false
        const declared = ports.map((value) => {
            const row = ownRecord(value)
            if (!row || !exactKeys(row, ['published', 'service', 'target', 'variable'])
                || typeof row.service !== 'string' || typeof row.variable !== 'string'
                || !Number.isSafeInteger(row.published) || !Number.isSafeInteger(row.target)) return undefined
            return `${row.service}:${row.published}:${row.target}`
        })
        if (declared.some((value) => value === undefined)) return false
        const parsed = ownRecord(JSON.parse(stdout.toString('utf8')))
        const services = parsed && ownRecord(parsed.services)
        if (!services) return false
        const actual: string[] = []
        for (const [service, value] of Object.entries(services)) {
            const definition = ownRecord(value)
            if (!definition || definition.ports === undefined) continue
            if (!Array.isArray(definition.ports)) return false
            for (const candidate of definition.ports) {
                const port = ownRecord(candidate)
                const published = port?.published
                const target = port?.target
                const numericPublished = typeof published === 'string' && /^\d+$/.test(published) ? Number(published) : published
                if (!Number.isSafeInteger(numericPublished) || !Number.isSafeInteger(target)) return false
                actual.push(`${service}:${numericPublished}:${target}`)
            }
        }
        return actual.sort().join('\n') === (declared as string[]).sort().join('\n')
    } catch {
        return false
    }
}

function capturedGeneratedRuntime(value: unknown): GeneratedObservationRuntime | undefined {
    const runtime = ownRecord(value)
    const required = ['composeFiles', 'executable', 'projectName', 'publicEnv', 'root', 'stderrLimitBytes', 'stdoutLimitBytes']
    const allowed = new Set([...required, 'hostExecutables', 'serviceAuthority'])
    if (!runtime || required.some((key) => !Object.hasOwn(runtime, key)) || Object.keys(runtime).some((key) => !allowed.has(key))) return undefined
    const captured = captureData({
        root: runtime.root,
        composeFiles: runtime.composeFiles,
        projectName: runtime.projectName,
        publicEnv: runtime.publicEnv,
        stdoutLimitBytes: runtime.stdoutLimitBytes,
        stderrLimitBytes: runtime.stderrLimitBytes,
    })
    const record = ownRecord(captured)
    if (!record) return undefined
    const executableRecord = ownRecord(runtime.executable)
    const executable = executableRecord && resolvedDockerExecutable(executableRecord)
    if (!executable) return undefined
    const hostExecutables = runtime.hostExecutables === undefined ? undefined : ownRecord(runtime.hostExecutables)
    const capturedHostExecutables = hostExecutables === undefined ? undefined : Object.fromEntries(Object.entries(hostExecutables).map(([name, candidate]) => {
        const record = ownRecord(candidate)
        const resolved = record && resolvedExecutable(record)
        return [name, resolved]
    }))
    if (runtime.hostExecutables !== undefined && (!capturedHostExecutables
        || Object.values(capturedHostExecutables).some((candidate) => candidate === undefined))) return undefined
    const serviceAuthority = runtime.serviceAuthority === undefined ? undefined : ownRecord(runtime.serviceAuthority)
    if (runtime.serviceAuthority !== undefined && (!serviceAuthority || !exactKeys(serviceAuthority, ['evidence', 'topology']))) return undefined
    return Object.freeze({
        ...(record as unknown as Omit<GeneratedObservationRuntime, 'executable' | 'hostExecutables'>),
        executable,
        ...(capturedHostExecutables === undefined ? {} : { hostExecutables: Object.freeze({ ...capturedHostExecutables }) as Readonly<Record<string, ResolvedExecutable>> }),
        ...(serviceAuthority === undefined ? {} : { serviceAuthority: Object.freeze({
            topology: serviceAuthority.topology as RuntimeTopologyEvidence,
            evidence: serviceAuthority.evidence as RuntimeServiceEvidence,
        }) }),
    })
}

export function projectGeneratedRuntimeAuthority(input: {
    readonly rendered: GeneratedEnvironmentResult
    readonly topology: RuntimeTopologyEvidence
    readonly runtime: GeneratedObservationRuntime
    readonly hostInputRoots?: Readonly<Record<string, GeneratedHostInputRoot>>
}): GeneratedRuntimeAuthority | undefined {
    const captured = ownRecord(input)
    if (!captured || !exactKeys(captured, ['rendered', 'runtime', 'topology', ...(Object.hasOwn(captured, 'hostInputRoots') ? ['hostInputRoots'] : [])])) return undefined
    const rendered = captured.rendered
    const topology = captured.topology
    const authority = authenticateGeneratedRender(rendered as GeneratedEnvironmentResult)
    const runtime = capturedGeneratedRuntime(captured.runtime)
    if (!authority || !runtime || !topology || typeof topology !== 'object' || !isRuntimeTopologyEvidence(topology as RuntimeTopologyEvidence)) return undefined
    const current = topology as RuntimeTopologyEvidence
    const declaration = authority.declaration
    const roots = ownRecord(captureData(captured.hostInputRoots ?? {}))
    const hostServices = Object.keys(authority.hostInputDirectories)
    if (!roots || !exactKeys(roots, hostServices)) return undefined
    for (const service of declaration.services) {
        const directory = authority.hostInputDirectories[service.id]
        const root = directory === undefined ? undefined : ownRecord(roots[service.id])
        if (directory !== undefined && (!root || !exactKeys(root, ['path', 'dev', 'ino'])
            || typeof root.path !== 'string' || !isAbsolute(root.path) || normalize(root.path) !== root.path
            || root.path !== resolve(runtime.root, directory)
            || !Number.isSafeInteger(root.dev) || (root.dev as number) < 0
            || !Number.isSafeInteger(root.ino) || (root.ino as number) < 0)) return undefined
        const sources = [...new Set(service.mounts.filter(mount => mount.kind !== 'volume')
            .map(mount => resolve(root!.path as string, mount.source)))].sort()
        const observed = current.services.find(candidate => candidate.id === service.id)
        if (!observed || !isDeepStrictEqual(observed.bindMountSources, sources)) return undefined
    }
    const hostInputRoots = Object.freeze(roots) as unknown as Readonly<Record<string, GeneratedHostInputRoot>>

    const declaredPortVariables = new Set(declaration.services.flatMap((service) => service.ports.map(({ host_variable }) => host_variable)))
    const executionEnvironment = projectRuntimeExecutionEnvironment(current)
    const expectedExecutionEnvironment = executionEnvironment && Object.freeze({ ...executionEnvironment,
        COCKPIT_OWNER_ID: authority.cockpitId, COCKPIT_STACK_ID: authority.stackId })
    if (!expectedExecutionEnvironment || !isDeepStrictEqual(runtime.publicEnv, expectedExecutionEnvironment)
        || runtime.publicEnv.COCKPIT_OWNER_ID !== authority.cockpitId
        || runtime.publicEnv.COCKPIT_STACK_ID !== authority.stackId
        || [...declaredPortVariables].some((name) => !Object.hasOwn(runtime.publicEnv, name)
            || !/^\d+$/.test(runtime.publicEnv[name]!) || Number(runtime.publicEnv[name]) < 1 || Number(runtime.publicEnv[name]) > 65_535)
        || Object.entries(runtime.publicEnv).some(([name, value]) => {
            if (SAFE_RUNTIME_ENV.has(name)) return false
            if (GENERATED_RUNTIME_IDENTITY_ENV.has(name)) return false
            return !declaredPortVariables.has(name) || !/^\d+$/.test(value)
                || Number(value) < 1 || Number(value) > 65_535
        })) return undefined
    const compose = (rendered as Extract<GeneratedEnvironmentResult, { kind: 'complete' }>).manifest.find(({ path }) => path === declaration.compose_file)
    if (!compose || current.stackId !== authority.stackId || current.configSha256 !== authority.sourceSha256
        || current.projectName !== runtime.projectName || current.cwd !== runtime.root
        || current.executableSha256 !== runtime.executable.sha256
        || runtime.composeFiles.length !== 1 || runtime.composeFiles[0]?.path !== resolve(runtime.root, declaration.compose_file)
        || runtime.composeFiles[0]?.sha256 !== compose.sha256) return undefined
    const declaredServices = declaration.services.map(({ id }) => id).sort()
    if (JSON.stringify(current.services.map(({ id }) => id).sort()) !== JSON.stringify(declaredServices)) return undefined
    if (current.services.some((service) => service.generation !== authority.generation
        || service.sourceSha256 !== authority.sourceSha256)) return undefined
    if (runtime.serviceAuthority !== undefined && (runtime.serviceAuthority.topology !== current
        || !isRuntimeServiceEvidence(runtime.serviceAuthority.evidence))) return undefined
    const projection = Object.freeze({ kind: 'generated-runtime-authority' as const })
    issuedRuntimeAuthorities.set(projection, Object.freeze({
        rendered: rendered as object, declaration, topology: current, runtime, hostInputRoots,
        stackId: authority.stackId, sourceSha256: authority.sourceSha256, generation: authority.generation,
    }))
    return projection
}

export function inspectGeneratedRuntimeAuthority(authority: GeneratedRuntimeAuthority): GeneratedRuntimeEnvelope | undefined {
    if (authority === null || typeof authority !== 'object') return undefined
    const envelope = issuedRuntimeAuthorities.get(authority)
    if (!envelope || !isRuntimeTopologyEvidence(envelope.topology)) return undefined
    return Object.freeze({ ...envelope, rendered: envelope.rendered as Extract<GeneratedEnvironmentResult, { kind: 'complete' }> })
}

function declaredDataOperations(declaration: GeneratedEnvironmentDeclaration): readonly GeneratedDataOperation[] {
    const data = declaration.data
    return [
        ...(data?.modes ?? []).flatMap(({ operations, probes }) => [
            ...operations.flatMap(({ operation, prerequisites }) => [operation, ...prerequisites]),
            ...probes,
        ]),
        ...(data?.fixtures?.volume_operations ?? []),
        ...(data?.fixtures?.volume_probes ?? []),
        ...(data?.restore?.rewrites ?? []).map(({ operation }) => operation),
    ]
}

export function resolveGeneratedDataOperation(input: {
    readonly authority: GeneratedRuntimeAuthority
    readonly operation: GeneratedDataOperation
    readonly context: GeneratedDataStepContext
}): ExecutionStep | undefined {
    const captured = ownRecord(input)
    const context = ownRecord(captured?.context)
    const envelope = captured?.authority && typeof captured.authority === 'object'
        ? issuedRuntimeAuthorities.get(captured.authority as object) : undefined
    const operation = snapshotGeneratedJson(captured?.operation) as GeneratedDataOperation | undefined
    const contextKeys = new Set(['after', 'id', 'operationId', 'operationKind', 'phase', 'provenance'])
    if (!envelope || !context || !Object.keys(context).every((key) => contextKeys.has(key))
        || typeof context.id !== 'string' || typeof context.phase !== 'string'
        || context.id.length === 0 || context.id.length > 256 || operation === undefined
        || !declaredDataOperations(envelope.declaration).some((candidate) => isDeepStrictEqual(candidate, operation))) return undefined
    const runtime = envelope.runtime
    const cwd = resolve(runtime.root, operation.cwd)
    const relation = relative(runtime.root, cwd)
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return undefined
    let argv: readonly [string, ...string[]]
    let argv0: string
    let stepCwd: string
    let consumedFiles: ExecutionStep['consumedFiles']
    if (operation.location === 'host') {
        const executable = resolvedExecutable(runtime.hostExecutables?.[operation.argv[0]])
        if (!executable) return undefined
        argv = Object.freeze([executable.canonicalPath, ...operation.argv.slice(1)]) as readonly [string, ...string[]]
        argv0 = executable.invocationPath
        stepCwd = cwd
        consumedFiles = Object.freeze([{
            path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]), executable: true, executionMode: executable.executionMode,
        }])
    } else {
        const docker = resolvedDockerExecutable(runtime.executable)
        if (!docker || operation.service === undefined) return undefined
        const activeProfiles = envelope.declaration.services.flatMap(({ profiles }) => profiles)
        argv = Object.freeze([
            ...generatedComposePrefix(runtime, docker, activeProfiles),
            'exec', '--no-TTY', operation.service, ...inStackCommand(operation.cwd, operation.argv),
        ]) as readonly [string, ...string[]]
        argv0 = docker.invocationPath
        stepCwd = runtime.root
        consumedFiles = Object.freeze([
            { path: docker.canonicalPath, sha256: docker.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: docker.executionMode },
            ...runtime.composeFiles.map(({ path, sha256: digest }, index) => ({ path, sha256: digest, maxBytes: 1_048_576, argvIndexes: Object.freeze([5 + index * 2]), executable: false as const })),
        ])
    }
    return snapshotExecutionStep({
        id: context.id, argv, argv0, cwd: stepCwd, env: Object.freeze({}),
        timeoutMs: operation.timeout_seconds * 1_000,
        stdoutLimitBytes: runtime.stdoutLimitBytes, stderrLimitBytes: runtime.stderrLimitBytes,
        paths: Object.freeze(runtime.composeFiles.map(({ path }) => path)), ports: Object.freeze([]),
        labels: Object.freeze({}), expected: Object.freeze([]), consumedFiles,
        filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    })
}

export function createGeneratedObservationExecution(input: {
    readonly authority: GeneratedRuntimeAuthority
    readonly observation: GeneratedObservationPlan
}): GeneratedObservationExecution {
    const captured = ownRecord(input)
    if (!captured || !exactKeys(captured, ['authority', 'observation'])) {
        return Object.freeze({ kind: 'unavailable', id: 'generated-observation', reason: 'generated observation input is malformed' })
    }
    const generatedAuthority = captured.authority && typeof captured.authority === 'object'
        ? issuedRuntimeAuthorities.get(captured.authority as object) : undefined
    const observation = captured.observation
    if (!generatedAuthority || !isRuntimeTopologyEvidence(generatedAuthority.topology) || !observation || typeof observation !== 'object'
        || !(generatedAuthority.rendered as Extract<GeneratedEnvironmentResult, { kind: 'complete' }>).observations.includes(observation as GeneratedObservationPlan)) {
        return Object.freeze({ kind: 'unavailable', id: 'generated-observation', reason: 'generated observation authority is unavailable' })
    }
    const declaredPortVariables = new Set(generatedAuthority.declaration.services
        .flatMap((service) => service.ports.map(({ host_variable }) => host_variable)))
    const activeProfiles = generatedAuthority.declaration.services.flatMap(({ profiles }) => profiles)
    const plan = effectiveObservationPlan(observation as GeneratedObservationPlan, generatedAuthority.runtime)
    if (!plan) return Object.freeze({ kind: 'unavailable', id: (observation as GeneratedObservationPlan).id, reason: 'generated observation has no authentic executable plan' })
    let step: ExecutionStep | undefined
    try {
        step = generatedObservationStep(plan, generatedAuthority.runtime, activeProfiles, declaredPortVariables, generatedAuthority.hostInputRoots)
    } catch (error) {
        return Object.freeze({ kind: 'unavailable', id: plan.id, reason: error instanceof Error ? error.message : String(error) })
    }
    if (!step) return Object.freeze({ kind: 'unavailable', id: plan.id, reason: 'generated observation has no authentic executable plan' })
    const execution = Object.freeze({ kind: 'planned' as const, id: plan.id, step })
    issuedObservationExecutions.set(execution, Object.freeze({
        plan, rendered: generatedAuthority.rendered, stackId: generatedAuthority.stackId, sourceSha256: generatedAuthority.sourceSha256,
        generation: generatedAuthority.generation, step,
    }))
    return execution
}

export function admitGeneratedObservation(input: {
    readonly execution: GeneratedObservationExecution
    readonly outcome: ExecuteProbeOutcome
}): GeneratedObservationAdmission | undefined {
    const captured = ownRecord(input)
    if (!captured || !exactKeys(captured, ['execution', 'outcome'])) return undefined
    const execution = captured.execution
    if (!execution || typeof execution !== 'object' || consumedObservationExecutions.has(execution as object)) return undefined
    const authority = issuedObservationExecutions.get(execution as object)
    if (!authority) return undefined
    consumedObservationExecutions.add(execution as object)
    const outcome = authenticatedExecutionOutcome(captured.outcome as ExecuteProbeOutcome, authority.step)
    if (!outcome?.receipt) return undefined
    const measured = outcome.kind === 'complete' && authority.plan.kind === 'compose-variable'
        ? composePortsMatch(outcome.stdout, authority.plan.expected)
        : outcome.kind === 'complete'
    const admission = Object.freeze({
        kind: measured ? 'complete' as const : 'failed' as const,
        id: authority.plan.id,
        target: authority.plan.target,
        stackId: authority.stackId,
        sourceSha256: authority.sourceSha256,
        generation: authority.generation,
        observedAt: outcome.receipt.finishedAt,
        expected: authority.plan.expected,
        reason: measured ? 'generated observation probe completed'
            : outcome.kind === 'complete' ? 'generated Compose ports did not match the declared defaults and targets'
            : `generated observation probe was refused: ${outcome.code}`,
    })
    issuedObservationAdmissions.set(admission, authority.rendered)
    return admission
}

export function isGeneratedObservationAdmission(value: unknown): value is GeneratedObservationAdmission {
    return value !== null && typeof value === 'object' && issuedObservationAdmissions.has(value)
}

export function observeGeneratedEnvironmentHealth(input: {
    readonly rendered: GeneratedEnvironmentResult
    readonly inspection: GeneratedInspectionResult
    readonly admissions: readonly GeneratedObservationAdmission[]
}): Readonly<{
    environment: EnvironmentObservation
    registryAuthentication: EnvironmentObservation
}> | undefined {
    const captured = ownRecord(input)
    if (!captured || !exactKeys(captured, ['admissions', 'inspection', 'rendered']) || !Array.isArray(captured.admissions)) return undefined
    const rendered = captured.rendered
    const authority = authenticateGeneratedRender(rendered as GeneratedEnvironmentResult)
    const inspection = captured.inspection
    const inspectedRender = inspection && typeof inspection === 'object' ? issuedInspections.get(inspection as object) : undefined
    const admissions = captured.admissions as readonly GeneratedObservationAdmission[]
    if (!authority || inspectedRender !== rendered || consumedInspections.has(inspection as object)
        || admissions.length > 4_096 || new Set(admissions).size !== admissions.length
        || admissions.some((admission) => !isGeneratedObservationAdmission(admission)
            || consumedObservationAdmissions.has(admission)
            || issuedObservationAdmissions.get(admission) !== rendered
            || admission.stackId !== authority.stackId || admission.sourceSha256 !== authority.sourceSha256
            || admission.generation !== authority.generation)) return undefined
    consumedInspections.add(inspection as object)
    admissions.forEach((admission) => consumedObservationAdmissions.add(admission))
    const expectedIds = (rendered as Extract<GeneratedEnvironmentResult, { kind: 'complete' }>).observations.map(({ id }) => id)
    const admittedIds = admissions.map(({ id }) => id)
    const missing = expectedIds.filter((id) => !admittedIds.includes(id))
    const duplicate = new Set(admittedIds).size !== admittedIds.length
    const failed = admissions.filter(({ kind }) => kind !== 'complete')
    const observedAt = admissions.map(({ observedAt }) => observedAt).sort().at(-1) ?? new Date().toISOString()
    const environment = snapshotEnvironmentObservation({
        code: ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
        owner: mechanism.id,
        stackId: authority.stackId,
        source: `generated:${authority.sourceSha256}`,
        observed: missing.length === 0 && !duplicate && failed.length === 0
            ? { state: 'available', value: { generation: authority.generation, observations: admittedIds.sort() }, observedAt }
            : failed.length > 0
                ? { state: 'failed', reason: `generated observations failed: ${failed.map(({ id, expected }) => expected.toolPresence === 'unchecked' ? `${id} (tool presence unchecked)` : id).join(', ')}`, observedAt }
                : { state: 'unavailable', reason: `generated observations are incomplete: ${missing.join(', ') || 'duplicate admission'}`, observedAt },
        expectation: { kind: 'present' },
        applicability: { state: 'required', posture: 'generated-environment' },
        freshness: { state: 'current' },
        remedy: 'execute and admit every observation declared by the current generated environment',
    })
    const registryIds = (rendered as Extract<GeneratedEnvironmentResult, { kind: 'complete' }>).observations
        .filter(({ kind }) => kind === 'registry-auth').map(({ id }) => id)
    const registryAdmissions = admissions.filter(({ id }) => registryIds.includes(id))
    const missingRegistry = registryIds.filter(id => !registryAdmissions.some(admission => admission.id === id))
    const duplicateRegistry = new Set(registryAdmissions.map(({ id }) => id)).size !== registryAdmissions.length
    const failedRegistry = registryAdmissions.filter(({ kind }) => kind !== 'complete')
    const registryAuthentication = snapshotEnvironmentObservation({
        code: ENVIRONMENT_CODES.REGISTRY_AUTH_UNAVAILABLE,
        owner: mechanism.id,
        stackId: authority.stackId,
        source: `generated-registry:${authority.sourceSha256}`,
        observed: missingRegistry.length === 0 && !duplicateRegistry && failedRegistry.length === 0
            ? { state: 'available', value: { generation: authority.generation, observations: registryAdmissions.map(({ id }) => id).sort() }, observedAt }
            : duplicateRegistry
                ? { state: 'unavailable', reason: 'generated registry authentication probes are incomplete: duplicate admission', observedAt }
                : failedRegistry.length > 0
                ? { state: 'failed', reason: `generated registry authentication probes failed: ${failedRegistry.map(({ id }) => id).join(', ')}`, observedAt }
                : { state: 'unavailable', reason: `generated registry authentication probes are incomplete: ${missingRegistry.join(', ')}`, observedAt },
        expectation: { kind: 'present' },
        applicability: registryIds.length > 0
            ? { state: 'required', posture: 'registry-authentication' }
            : { state: 'not-applicable', posture: 'registry-authentication', reason: 'the generated environment declares no registry authentication probe' },
        freshness: { state: 'current' },
        remedy: 'make every declared registry authentication probe succeed, then rerun npx --no cockpit preflight --config <your cockpit.toml>',
    })
    if (!environment || !registryAuthentication) return undefined
    const issuedAt = Date.now()
    issuedGeneratedObservations.set(environment, issuedAt)
    issuedRegistryAuthenticationObservations.set(registryAuthentication, issuedAt)
    return Object.freeze({ environment, registryAuthentication })
}

export function observeGeneratedEnvironment(input: {
    readonly rendered: GeneratedEnvironmentResult
    readonly inspection: GeneratedInspectionResult
    readonly admissions: readonly GeneratedObservationAdmission[]
}): EnvironmentObservation | undefined {
    return observeGeneratedEnvironmentHealth(input)?.environment
}

export function isGeneratedObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedGeneratedObservations.has(value)
}

export function isGeneratedRegistryAuthenticationObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedRegistryAuthenticationObservations.has(value)
}

function generatedRegistryAuthenticationObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedRegistryAuthenticationObservations.get(value) : undefined
}
