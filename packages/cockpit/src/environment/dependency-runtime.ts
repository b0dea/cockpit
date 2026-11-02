import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { isProxy } from 'node:util/types'
import {
    errorCause,
    isCanonicalTimestamp,
    snapshotExecutionStep,
    type ExecutionFailureCode,
    type ExecutionStep,
    type StackId,
} from './contract.js'
import {
    consumeDependencyRuntimeProjection,
    type DependencyRuntimeEnvelope,
    type DependencyRuntimeProjection,
} from './runtime.js'

export const mechanism = {
    id: 'dependency-runtime',
    module: 'packages/cockpit/src/environment/dependency-runtime.ts',
    exports: ['createDependencyRuntimePlan', 'admitDependencyRuntime', 'createDependencyExecutionPlan', 'admitDependencyExecution', 'createDependencyLoadPlan', 'admitDependencyLoad'],
} as const

const ARCHITECTURE = /^(?:x86_64|aarch64|amd64|arm64)$/
const ABI = /^(?:glibc|musl):[^\s]{1,128}$/
const MAX_ARGV = 1_024
const MAX_ARG_BYTES = 65_536

export type DependencyRuntimeRefusal = Readonly<{
    kind: 'refusal'
    code: 'DEPENDENCY_RUNTIME_UNAVAILABLE' | 'DEPENDENCY_RUNTIME_STALE' | 'DEPENDENCY_RUNTIME_UNMOUNTED' | 'DEPENDENCY_RUNTIME_INCOMPATIBLE' | ExecutionFailureCode
    reason: string
}>

export type DependencyRuntimePlan = Readonly<{
    kind: 'planned'
    inspect: ExecutionStep
    architecture: ExecutionStep
    abi: ExecutionStep
}> | DependencyRuntimeRefusal

declare const dependencyRuntimeBindingBrand: unique symbol
export interface DependencyRuntimeBinding {
    readonly [dependencyRuntimeBindingBrand]: true
}

export type DependencyRuntimeAdmission = Readonly<{
    kind: 'complete'
    binding: DependencyRuntimeBinding
    compatibility: Readonly<{
        imageId: string
        architecture: string
        abi: string
        source: string
        volume: string
        target: string
        stackId: StackId
        configSha256: string
        generation: string
    }>
}> | DependencyRuntimeRefusal

interface RuntimeAuthority {
    readonly envelope: DependencyRuntimeEnvelope
    readonly compatibility: Extract<DependencyRuntimeAdmission, { kind: 'complete' }>['compatibility']
}

const issuedPlans = new WeakMap<object, DependencyRuntimeEnvelope>()
const consumedPlans = new WeakSet<object>()
const issuedBindings = new WeakMap<object, RuntimeAuthority>()
const consumedBindings = new WeakSet<object>()
const issuedExecutionSteps = new WeakMap<object, DependencyRuntimeEnvelope['observationWindow']>()
const consumedExecutionSteps = new WeakSet<object>()
const issuedLoadPlans = new WeakMap<object, Readonly<{
    step: ExecutionStep
    observationWindow: DependencyRuntimeEnvelope['observationWindow']
}>>()
const consumedLoadPlans = new WeakSet<object>()

function refusal(code: DependencyRuntimeRefusal['code'], reason: string): DependencyRuntimeRefusal {
    return Object.freeze({ kind: 'refusal', code, reason })
}

function receiptWithinWindow(
    receipt: Readonly<{ startedAt: string; finishedAt: string }>,
    window: DependencyRuntimeEnvelope['observationWindow'],
): boolean {
    const startedAt = Date.parse(receipt.startedAt)
    const finishedAt = Date.parse(receipt.finishedAt)
    const windowStartedAt = Date.parse(window.startedAt)
    const windowExpiresAt = Date.parse(window.expiresAt)
    const now = Date.now()
    return isCanonicalTimestamp(receipt.startedAt) && isCanonicalTimestamp(receipt.finishedAt)
        && isCanonicalTimestamp(window.startedAt) && isCanonicalTimestamp(window.expiresAt)
        && windowStartedAt <= startedAt && startedAt <= finishedAt && finishedAt <= now
        && now >= windowStartedAt && now <= windowExpiresAt && finishedAt <= windowExpiresAt
}

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(descriptors).sort().join('\0') !== [...keys].sort().join('\0')
        || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function dockerStep(
    envelope: DependencyRuntimeEnvelope,
    id: string,
    argv: readonly [string, ...string[]],
    timeoutMs = envelope.timeoutMs,
    spawnNotAfter = envelope.observationWindow.expiresAt,
    env: Readonly<Record<string, string>> = envelope.env,
    stdoutLimitBytes = envelope.stdoutLimitBytes,
    stderrLimitBytes = envelope.stderrLimitBytes,
): ExecutionStep | undefined {
    return snapshotExecutionStep({
        id,
        argv: Object.freeze([envelope.executable.canonicalPath, ...argv]) as readonly [string, ...string[]],
        argv0: envelope.executable.invocationPath,
        cwd: envelope.cwd,
        env,
        timeoutMs: Math.min(timeoutMs, envelope.timeoutMs),
        spawnNotAfter,
        stdoutLimitBytes: Math.min(stdoutLimitBytes, envelope.stdoutLimitBytes, 1_048_576),
        stderrLimitBytes: Math.min(stderrLimitBytes, envelope.stderrLimitBytes, 1_048_576),
        paths: Object.freeze([]),
        ports: Object.freeze([]),
        labels: Object.freeze({
            stackId: envelope.stackId,
            configSha256: envelope.configSha256,
            batchId: envelope.batchId,
            service: envelope.service,
            containerId: envelope.containerId,
            generation: envelope.generation,
            volume: envelope.mount.name,
            target: envelope.mount.target,
        }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({
            path: envelope.executable.canonicalPath,
            sha256: envelope.executable.sha256,
            maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]),
            executable: true as const,
            executionMode: envelope.executable.executionMode,
        })]),
        filesystemChecks: Object.freeze([]),
        compensation: Object.freeze([]),
    })
}

const INSPECT_FORMAT = '{"ID":{{json .Id}},"Image":{{json .Image}},"ConfigImage":{{json .Config.Image}},"Labels":{"stack":{{json (index .Config.Labels "dev.b0dea.cockpit.stack-id")}},"config":{{json (index .Config.Labels "dev.b0dea.cockpit.config-sha256")}},"generation":{{json (index .Config.Labels "dev.b0dea.cockpit.generation-id")}},"generatedGeneration":{{json (index .Config.Labels "dev.b0.cockpit.generation")}},"source":{{json (index .Config.Labels "dev.b0.cockpit.source-sha256")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}},"Mounts":{{json .Mounts}}}'

export function createDependencyRuntimePlan(input: { readonly runtime: DependencyRuntimeProjection }): DependencyRuntimePlan {
    try {
        const captured = ownData(input, ['runtime'])
        if (!captured) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime request is malformed')
        const envelope = consumeDependencyRuntimeProjection(captured.runtime as DependencyRuntimeProjection)
        if (!envelope) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime authority is unavailable')
        const inspect = dockerStep(envelope, `dependency-runtime:inspect:${envelope.service}`, ['container', 'inspect', '--format', INSPECT_FORMAT, envelope.containerId])
        const architecture = dockerStep(envelope, `dependency-runtime:architecture:${envelope.service}`, ['container', 'exec', envelope.containerId, 'uname', '-m'])
        const abi = dockerStep(envelope, `dependency-runtime:abi:${envelope.service}`, ['container', 'exec', envelope.containerId, '/bin/sh', '-eu', '-c', "if command -v getconf >/dev/null 2>&1 && v=$(getconf GNU_LIBC_VERSION 2>/dev/null); then printf 'glibc:%s\\n' \"${v#* }\"; else out=$(ldd --version 2>&1); printf '%s\\n' \"$out\" | grep -qi musl; v=$(printf '%s\\n' \"$out\" | sed -n 's/^Version[[:space:]]\\+\\([^[:space:]]\\+\\).*$/\\1/p' | sed -n '1p'); test -n \"$v\"; printf 'musl:%s\\n' \"$v\"; fi"])
        if (!inspect || !architecture || !abi) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime inspection plan exceeds its bounds')
        const plan = Object.freeze({ kind: 'planned' as const, inspect, architecture, abi })
        issuedPlans.set(plan, envelope)
        return plan
    } catch (error) {
        return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', `dependency runtime request is unavailable: ${errorCause(error)}`)
    }
}

function text(outcome: ExecuteProbeOutcome, step: ExecutionStep, envelope: DependencyRuntimeEnvelope): Readonly<{ value: string; startedAt: string; finishedAt: string }> | undefined {
    const authenticated = authenticatedExecutionOutcome(outcome, step)
    if (!authenticated || authenticated.kind !== 'complete' || authenticated.stderr.byteLength !== 0
        || !receiptWithinWindow(authenticated.receipt, envelope.observationWindow)) return undefined
    try {
        return Object.freeze({
            value: new TextDecoder('utf-8', { fatal: true }).decode(authenticated.stdout),
            startedAt: authenticated.receipt.startedAt,
            finishedAt: authenticated.receipt.finishedAt,
        })
    } catch {
        // Undecodable output is refused by the caller as unavailable compatibility evidence.
        return undefined
    }
}

function inspectIdentity(source: string, envelope: DependencyRuntimeEnvelope): { readonly imageId: string } | DependencyRuntimeRefusal {
    try {
        const parsed: unknown = JSON.parse(source.endsWith('\n') ? source.slice(0, -1) : source)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        const value = parsed as Record<string, unknown>
        const labels = value.Labels
        const mounts = value.Mounts
        if (!labels || typeof labels !== 'object' || Array.isArray(labels) || !Array.isArray(mounts)
            || value.ID !== envelope.containerId || typeof value.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.Image)
            || value.ConfigImage !== envelope.image) return refusal('DEPENDENCY_RUNTIME_STALE', 'runtime container or image identity changed')
        const named = labels as Record<string, unknown>
        if (named.stack !== envelope.stackId || named.config !== envelope.configSha256
            || named.generation !== envelope.generation || named.generatedGeneration !== envelope.generation
            || named.source !== envelope.sourceSha256 || named.project !== envelope.projectName || named.service !== envelope.service) {
            return refusal('DEPENDENCY_RUNTIME_STALE', 'runtime labels no longer match the admitted generated identity')
        }
        const matches = mounts.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
            && (item as Record<string, unknown>).Type === 'volume'
            && (item as Record<string, unknown>).Name === envelope.mount.name
            && (item as Record<string, unknown>).Destination === envelope.mount.target)
        if (matches.length !== 1) return refusal('DEPENDENCY_RUNTIME_UNMOUNTED', 'the admitted dependency volume is not mounted at its declared target')
        return Object.freeze({ imageId: value.Image })
    } catch (error) {
        return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', `runtime inspection output is malformed: ${errorCause(error)}`)
    }
}

export function admitDependencyRuntime(input: {
    readonly plan: DependencyRuntimePlan
    readonly inspectOutcome: ExecuteProbeOutcome
    readonly architectureOutcome: ExecuteProbeOutcome
    readonly abiOutcome: ExecuteProbeOutcome
}): DependencyRuntimeAdmission {
    try {
        const captured = ownData(input, ['plan', 'inspectOutcome', 'architectureOutcome', 'abiOutcome'])
        if (!captured) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime admission is malformed')
        const plan = captured?.plan as DependencyRuntimePlan | undefined
        if (!plan) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime admission is malformed')
        if (plan.kind !== 'planned' || consumedPlans.has(plan)) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime plan is unauthentic or already consumed')
        const envelope = issuedPlans.get(plan)
        consumedPlans.add(plan)
        if (!envelope) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime plan is unauthentic or already consumed')
        const inspect = text(captured.inspectOutcome as ExecuteProbeOutcome, plan.inspect, envelope)
        const architectureEvidence = text(captured.architectureOutcome as ExecuteProbeOutcome, plan.architecture, envelope)
        const abiEvidence = text(captured.abiOutcome as ExecuteProbeOutcome, plan.abi, envelope)
        if (inspect === undefined || architectureEvidence === undefined || abiEvidence === undefined
            || Date.parse(inspect.finishedAt) > Date.parse(architectureEvidence.startedAt)
            || Date.parse(inspect.finishedAt) > Date.parse(abiEvidence.startedAt)) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'runtime compatibility evidence is unavailable')
        const architecture = architectureEvidence.value.trim()
        const abi = abiEvidence.value.trim()
        const identity = inspectIdentity(inspect.value, envelope)
        if ('kind' in identity) return identity
        if (!ARCHITECTURE.test(architecture) || !ABI.test(abi)) return refusal('DEPENDENCY_RUNTIME_INCOMPATIBLE', 'runtime architecture or ABI evidence is invalid')
        const compatibility = Object.freeze({
            imageId: identity.imageId,
            architecture,
            abi,
            source: envelope.mount.source,
            volume: envelope.mount.name,
            target: envelope.mount.target,
            stackId: envelope.stackId,
            configSha256: envelope.configSha256,
            generation: envelope.generation,
        })
        const binding = Object.freeze({}) as DependencyRuntimeBinding
        issuedBindings.set(binding, Object.freeze({ envelope, compatibility }))
        return Object.freeze({ kind: 'complete' as const, binding, compatibility })
    } catch (error) {
        return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', `runtime compatibility evidence is unavailable: ${errorCause(error)}`)
    }
}

function command(value: unknown): readonly [string, ...string[]] | undefined {
    if (!Array.isArray(value) || isProxy(value) || value.length < 1 || value.length > MAX_ARGV) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors).filter((key) => key !== 'length')
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return undefined
    const values = keys.map((key) => descriptors[key]!)
    if (values.some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable
        || typeof descriptor.value !== 'string' || descriptor.value.length === 0 || descriptor.value.includes('\0')
        || Buffer.byteLength(descriptor.value, 'utf8') > MAX_ARG_BYTES)) return undefined
    return Object.freeze(values.map((descriptor) => descriptor.value)) as readonly [string, ...string[]]
}

function executionStep(authority: RuntimeAuthority, role: 'install' | 'load', argv: readonly [string, ...string[]], timeoutMs: number, spawnNotAfter: string, env: Readonly<Record<string, string>>, stdoutLimitBytes: number, stderrLimitBytes: number): ExecutionStep | undefined {
    const entries = Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
    return dockerStep(authority.envelope, `dependency-runtime:${role}:${authority.envelope.service}`, [
        'container', 'exec', ...entries.flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--workdir', authority.envelope.mount.target, authority.envelope.containerId, ...argv,
    ], timeoutMs, spawnNotAfter, authority.envelope.env, stdoutLimitBytes, stderrLimitBytes)
}

function commandEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length > 0
        || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
    const captured = Object.fromEntries(Object.entries(descriptors).map(([name, descriptor]) => [name, descriptor.value]))
    if (Object.keys(captured).length > MAX_ARGV || Buffer.byteLength(JSON.stringify(captured), 'utf8') > 1_048_576
        || Object.entries(captured).some(([name, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
            || name.startsWith('DOCKER_') || name.startsWith('COMPOSE_')
            || /^(?:LD_|DYLD_|LIBPATH$|SHLIB_PATH$)/.test(name)
            || typeof item !== 'string' || item.includes('\0'))) return undefined
    return Object.freeze(Object.fromEntries(Object.entries(captured).sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>)
}

export type DependencyExecutionPlan = Readonly<{
    kind: 'complete'
    install: ExecutionStep
    load: ExecutionStep
    compatibility: RuntimeAuthority['compatibility']
}> | DependencyRuntimeRefusal

export function createDependencyExecutionPlan(input: {
    readonly binding: DependencyRuntimeBinding
    readonly install: readonly [string, ...string[]]
    readonly load: readonly [string, ...string[]]
    readonly env: Readonly<Record<string, string>>
    readonly installTimeoutMs: number
    readonly loadTimeoutMs: number
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
}): DependencyExecutionPlan {
    try {
        const captured = ownData(input, ['binding', 'install', 'load', 'env', 'installTimeoutMs', 'loadTimeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes'])
        if (!captured) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency execution plan is malformed')
        const binding = captured?.binding as DependencyRuntimeBinding | undefined
        const authority = binding ? issuedBindings.get(binding) : undefined
        if (!binding || !authority || consumedBindings.has(binding)
            || Date.now() > Date.parse(authority.envelope.observationWindow.expiresAt)) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime binding is unauthentic, expired, or already consumed')
        consumedBindings.add(binding)
        const install = command(captured.install)
        const load = command(captured.load)
        const env = commandEnvironment(captured.env)
        const installTimeoutMs = captured.installTimeoutMs
        const loadTimeoutMs = captured.loadTimeoutMs
        const stdoutLimitBytes = captured.stdoutLimitBytes
        const stderrLimitBytes = captured.stderrLimitBytes
        if (!install || !load || !env || !Number.isSafeInteger(installTimeoutMs) || (installTimeoutMs as number) < 1 || (installTimeoutMs as number) > 300_000
            || !Number.isSafeInteger(loadTimeoutMs) || (loadTimeoutMs as number) < 1 || (loadTimeoutMs as number) > 300_000
            || !Number.isSafeInteger(stdoutLimitBytes) || (stdoutLimitBytes as number) < 0 || (stdoutLimitBytes as number) > 16_777_216
            || !Number.isSafeInteger(stderrLimitBytes) || (stderrLimitBytes as number) < 0 || (stderrLimitBytes as number) > 16_777_216) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency commands are invalid')
        const requestedDeadline = Date.now() + (installTimeoutMs as number) + (loadTimeoutMs as number)
        const spawnNotAfter = new Date(Math.min(requestedDeadline, Date.parse(authority.envelope.observationWindow.expiresAt))).toISOString()
        const installStep = executionStep(authority, 'install', install, installTimeoutMs as number, spawnNotAfter, env, stdoutLimitBytes as number, stderrLimitBytes as number)
        const loadStep = executionStep(authority, 'load', load, loadTimeoutMs as number, spawnNotAfter, env, stdoutLimitBytes as number, stderrLimitBytes as number)
        if (!installStep || !loadStep) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency execution plan exceeds its bounds')
        issuedExecutionSteps.set(installStep, authority.envelope.observationWindow)
        issuedExecutionSteps.set(loadStep, authority.envelope.observationWindow)
        return Object.freeze({ kind: 'complete' as const, install: installStep, load: loadStep, compatibility: authority.compatibility })
    } catch (error) {
        return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', `dependency execution plan is unavailable: ${errorCause(error)}`)
    }
}

export function admitDependencyExecution(input: {
    readonly step: ExecutionStep
    readonly outcome: ExecuteProbeOutcome
}): ExecuteProbeOutcome | undefined {
    const captured = ownData(input, ['step', 'outcome'])
    const step = captured?.step as ExecutionStep | undefined
    if (!step || consumedExecutionSteps.has(step)) return undefined
    const window = issuedExecutionSteps.get(step)
    consumedExecutionSteps.add(step)
    if (!window) return undefined
    const outcome = authenticatedExecutionOutcome(captured?.outcome as ExecuteProbeOutcome, step)
    return outcome?.receipt && receiptWithinWindow(outcome.receipt, window) ? outcome : undefined
}

export type DependencyLoadPlan = Readonly<{ kind: 'planned'; step: ExecutionStep; compatibility: RuntimeAuthority['compatibility'] }> | DependencyRuntimeRefusal

export function createDependencyLoadPlan(input: {
    readonly binding: DependencyRuntimeBinding
    readonly load: readonly [string, ...string[]]
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
}): DependencyLoadPlan {
    try {
        const captured = ownData(input, ['binding', 'load', 'env', 'timeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes'])
        if (!captured) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency load plan is malformed')
        const binding = captured?.binding as DependencyRuntimeBinding | undefined
        const authority = binding ? issuedBindings.get(binding) : undefined
        if (!binding || !authority || consumedBindings.has(binding)
            || Date.now() > Date.parse(authority.envelope.observationWindow.expiresAt)) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency runtime binding is unauthentic, expired, or already consumed')
        consumedBindings.add(binding)
        const load = command(captured.load)
        const env = commandEnvironment(captured.env)
        const timeoutMs = captured.timeoutMs
        const stdoutLimitBytes = captured.stdoutLimitBytes
        const stderrLimitBytes = captured.stderrLimitBytes
        if (!load || !env || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300_000
            || !Number.isSafeInteger(stdoutLimitBytes) || (stdoutLimitBytes as number) < 0 || (stdoutLimitBytes as number) > 16_777_216
            || !Number.isSafeInteger(stderrLimitBytes) || (stderrLimitBytes as number) < 0 || (stderrLimitBytes as number) > 16_777_216) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency load command is invalid')
        const requestedDeadline = Date.now() + (timeoutMs as number)
        const spawnNotAfter = new Date(Math.min(requestedDeadline, Date.parse(authority.envelope.observationWindow.expiresAt))).toISOString()
        const step = executionStep(authority, 'load', load, timeoutMs as number, spawnNotAfter, env, stdoutLimitBytes as number, stderrLimitBytes as number)
        if (!step) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency load plan exceeds its bounds')
        const plan = Object.freeze({ kind: 'planned' as const, step, compatibility: authority.compatibility })
        issuedLoadPlans.set(plan, Object.freeze({ step, observationWindow: authority.envelope.observationWindow }))
        return plan
    } catch (error) {
        return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', `dependency load plan is unavailable: ${errorCause(error)}`)
    }
}

export function admitDependencyLoad(input: { readonly plan: DependencyLoadPlan; readonly outcome: ExecuteProbeOutcome }): Readonly<{ kind: 'complete'; compatibility: RuntimeAuthority['compatibility'] }> | DependencyRuntimeRefusal {
    const captured = ownData(input, ['plan', 'outcome'])
    if (!captured) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency load admission is malformed')
    const plan = captured?.plan as DependencyLoadPlan | undefined
    if (!plan || plan.kind !== 'planned' || consumedLoadPlans.has(plan)) return refusal('DEPENDENCY_RUNTIME_UNAVAILABLE', 'dependency load plan is unauthentic or already consumed')
    const authority = issuedLoadPlans.get(plan)
    consumedLoadPlans.add(plan)
    const outcome = authority ? authenticatedExecutionOutcome(captured.outcome as ExecuteProbeOutcome, authority.step) : undefined
    return outcome?.kind === 'complete' && outcome.stderr.byteLength === 0
        && authority !== undefined && receiptWithinWindow(outcome.receipt, authority.observationWindow)
        ? Object.freeze({ kind: 'complete' as const, compatibility: plan.compatibility })
        : refusal(outcome?.kind === 'refusal' ? outcome.code : 'DEPENDENCY_RUNTIME_INCOMPATIBLE', 'dependency load probe did not complete in the admitted mount')
}
