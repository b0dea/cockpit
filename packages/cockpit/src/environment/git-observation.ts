import { dirname } from 'node:path'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    snapshotEnvironmentObservation,
    isCanonicalTimestamp,
    snapshotExecutionStep,
    type CheckoutId,
    type EnvironmentObservation,
    type ExecutionStep,
    type StackId,
} from './contract.js'
import { resolvedGitExecutable, type ResolvedExecutable } from './executable.js'
import { repositoryIdentity, type RepositoryIdentity } from './repository-identity.js'
import { stackId as deriveStackId } from './identity.js'
import { isRuntimeTopologyEvidence, type RuntimeTopologyEvidence } from './runtime.js'
import { consumeSetupCheckoutProjection, type SetupCheckoutProjection } from './setup-observation.js'

export const mechanism = {
    id: 'git-observation',
    module: 'packages/cockpit/src/environment/git-observation.ts',
    exports: ['createComparisonRemoteRefStep', 'createGitAncestryObservationStep', 'createGitObservationStep', 'decodeGitObservation', 'observeComparisonRemoteRef', 'observeComparisonRemoteRevalidation', 'observeComparisonRemoteUrl', 'observeGit', 'observeGitAncestry', 'observeRunningCheckout', 'isGitObservation', 'observationDeclarations'],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'git-working-tree', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.GIT_STATE_UNHEALTHY, isIssued: isGitObservation, issuedAt: observationIssuedAt },
    { id: 'git-adjacency', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CHECKOUT_ADJACENCY_UNHEALTHY, isIssued: isGitObservation, issuedAt: observationIssuedAt },
    { id: 'running-checkout', owner: mechanism.id, postures: ['running-stack'], stages: [{ stage: 'bootstrap', disposition: 'not-applicable', reason: 'no running checkout exists before the first seed' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.RUNNING_CHECKOUT_MISMATCH, isIssued: isGitObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new TypeError('Git observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isGitObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

export interface GitObservationEvidence {
    readonly revision: string
    readonly branch: string
    readonly upstream: string | null
    readonly ahead: number
    readonly behind: number
    readonly trackedDirtyCount: number
    readonly untrackedCount: number
    readonly workingTree: 'clean' | 'dirty' | 'untracked' | 'dirty-and-untracked'
    readonly adjacency: 'aligned' | 'ahead' | 'behind' | 'diverged' | 'untracked-upstream'
}

export type GitObservationResult =
    | { readonly kind: 'complete'; readonly evidence: GitObservationEvidence; readonly observations: readonly EnvironmentObservation[] }
    | { readonly kind: 'unavailable'; readonly reason: string }

const OUTPUT_LIMIT = 65_536
interface ObservationBinding {
    readonly stackId: StackId
    readonly source: string
    readonly checkoutId: CheckoutId
}
interface GitBinding extends ObservationBinding {
    readonly checkoutRoot: string
    readonly executable: ResolvedExecutable
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
}
const issuedGitSteps = new WeakMap<object, GitBinding>()
const issuedGitResults = new WeakMap<object, GitBinding & { readonly evidence: GitObservationEvidence }>()

function safeObservationEnvironment(env: Readonly<Record<string, string>>): readonly [string, string][] | undefined {
    const entries = Object.entries(env)
    return entries.some(([name, value]) => !['LANG', 'LC_ALL', 'TZ'].includes(name)
        || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 1_024) ? undefined : entries
}

export function createGitObservationStep(input: {
    readonly executable: ResolvedExecutable
    readonly checkoutRoot: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
    readonly source: string
    readonly checkoutId: CheckoutId
}): ExecutionStep | undefined {
    const executable = resolvedGitExecutable(input.executable)
    const safeEnvironment = safeObservationEnvironment(input.env)
    if (!executable || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000
        || !/^stack:[a-f0-9]{64}$/.test(input.stackId) || !/^checkout:[a-f0-9]{64}$/.test(input.checkoutId)
        || typeof input.source !== 'string' || Buffer.byteLength(`${input.source}:adjacency`) > 1_024 || /[\x00-\x1f\x7f]/.test(input.source)
        || !safeEnvironment) return undefined
    const step = snapshotExecutionStep({
        id: 'git-health',
        argv: [executable.canonicalPath, '-C', input.checkoutRoot, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
        argv0: executable.invocationPath,
        cwd: input.checkoutRoot,
        env: Object.fromEntries(safeEnvironment),
        timeoutMs: input.timeoutMs,
        stdoutLimitBytes: OUTPUT_LIMIT,
        stderrLimitBytes: OUTPUT_LIMIT,
        paths: [input.checkoutRoot],
        ports: [],
        labels: { stackId: input.stackId, source: input.source, checkoutId: input.checkoutId },
        expected: [{ kind: 'path', target: input.checkoutRoot, state: 'repository' }],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks: [],
        compensation: [],
    })
    if (step) issuedGitSteps.set(step, Object.freeze({
        stackId: input.stackId, source: input.source, checkoutId: input.checkoutId,
        checkoutRoot: input.checkoutRoot, executable, env: Object.freeze(Object.fromEntries(safeEnvironment)), timeoutMs: input.timeoutMs,
    }))
    return step
}

function unavailable(reason: string): GitObservationResult {
    return { kind: 'unavailable', reason }
}

export function decodeGitObservation(
    bytes: Buffer,
    context: { readonly stackId: StackId; readonly observedAt: string; readonly source: string },
): GitObservationResult {
    if (bytes.byteLength > OUTPUT_LIMIT || !/^stack:[a-f0-9]{64}$/.test(context.stackId)
        || !isCanonicalTimestamp(context.observedAt) || typeof context.source !== 'string'
        || context.source.length === 0 || Buffer.byteLength(`${context.source}:working-tree`) > 1_024
        || Buffer.byteLength(`${context.source}:adjacency`) > 1_024 || /[\x00-\x1f\x7f]/.test(context.source)) {
        return unavailable('Git evidence exceeds its declared boundary')
    }
    let source: string
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return unavailable('Git evidence is not valid UTF-8')
    }
    let revision: string | undefined
    let branch: string | undefined
    let upstream: string | null = null
    let ahead = 0
    let behind = 0
    let trackedDirtyCount = 0
    let untrackedCount = 0
    const headers = new Set<string>()
    for (const line of source.split(/\r?\n/)) {
        if (line === '') continue
        if (line.startsWith('# branch.oid ')) {
            if (headers.has('oid')) return unavailable('Git evidence contains a duplicate branch header')
            headers.add('oid'); revision = line.slice(13)
        } else if (line.startsWith('# branch.head ')) {
            if (headers.has('head')) return unavailable('Git evidence contains a duplicate branch header')
            headers.add('head'); branch = line.slice(14)
        } else if (line.startsWith('# branch.upstream ')) {
            if (headers.has('upstream')) return unavailable('Git evidence contains a duplicate branch header')
            headers.add('upstream'); upstream = line.slice(18)
        }
        else if (line.startsWith('# branch.ab ')) {
            if (headers.has('adjacency')) return unavailable('Git evidence contains a duplicate branch header')
            headers.add('adjacency')
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
            if (!match) return unavailable('Git adjacency evidence is malformed')
            ahead = Number(match[1]); behind = Number(match[2])
            if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return unavailable('Git adjacency evidence exceeds exact integer bounds')
        } else if (line.startsWith('? ')) untrackedCount += 1
        else if (/^[12u] /.test(line)) trackedDirtyCount += 1
        else if (!line.startsWith('! ')) return unavailable('Git status evidence contains an unknown record')
    }
    const validIdentity = (value: string) => Buffer.byteLength(value) <= 1_024 && !/[\x00-\x1f\x7f]/.test(value)
    if (!revision || !branch || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision) || !validIdentity(branch)
        || upstream !== null && !validIdentity(upstream)
        || upstream === null && headers.has('adjacency')
        || upstream !== null && !headers.has('adjacency')) {
        return unavailable('Git evidence omitted or malformed repository identity')
    }
    const workingTree = trackedDirtyCount > 0 && untrackedCount > 0 ? 'dirty-and-untracked'
        : trackedDirtyCount > 0 ? 'dirty' : untrackedCount > 0 ? 'untracked' : 'clean'
    const adjacency = upstream === null ? 'untracked-upstream'
        : ahead > 0 && behind > 0 ? 'diverged'
            : ahead > 0 ? 'ahead' : behind > 0 ? 'behind' : 'aligned'
    const evidence = Object.freeze({ revision, branch, upstream, ahead, behind, trackedDirtyCount, untrackedCount, workingTree, adjacency })
    const common = {
        owner: mechanism.id,
        stackId: context.stackId,
        observedAt: context.observedAt,
        applicability: { state: 'required' as const, posture: 'environment' },
        freshness: { state: 'current' as const },
    }
    const workingTreeValue = Object.freeze({ revision, branch, trackedDirtyCount, untrackedCount })
    const workingTreeExpected = Object.freeze({ revision, branch, trackedDirtyCount: 0, untrackedCount: 0 })
    const adjacencyValue = Object.freeze({ revision, branch, upstream, ahead, behind, adjacency })
    const adjacencyExpected = Object.freeze({ revision, branch, upstream, ahead: 0, behind: 0,
        adjacency: upstream === null ? 'untracked-upstream' : 'aligned' })
    const observations: readonly EnvironmentObservation[] = Object.freeze([
        {
            code: ENVIRONMENT_CODES.GIT_STATE_UNHEALTHY,
            owner: common.owner,
            stackId: common.stackId,
            source: `${context.source}:working-tree`,
            observed: { state: 'available', value: workingTreeValue, observedAt: common.observedAt },
            expectation: { kind: 'equal', value: workingTreeExpected },
            applicability: common.applicability,
            freshness: common.freshness,
            remedy: 'commit, discard, or deliberately retain the named checkout changes',
        },
        {
            code: ENVIRONMENT_CODES.CHECKOUT_ADJACENCY_UNHEALTHY,
            owner: common.owner,
            stackId: common.stackId,
            source: `${context.source}:adjacency`,
            observed: { state: 'available', value: adjacencyValue, observedAt: common.observedAt },
            expectation: { kind: 'equal', value: adjacencyExpected },
            applicability: common.applicability,
            freshness: common.freshness,
            remedy: 'reconcile the checkout with its declared upstream',
        },
    ])
    return { kind: 'complete', evidence, observations }
}

export function observeGit(
    step: ExecutionStep,
    outcome: ExecuteProbeOutcome,
    context: { readonly stackId: StackId; readonly checkoutId: CheckoutId; readonly source: string },
): GitObservationResult {
    const binding = issuedGitSteps.get(step)
    if (!binding || binding.stackId !== context.stackId || binding.checkoutId !== context.checkoutId || binding.source !== context.source) return unavailable('Git observation context does not match its issued plan')
    const authenticated = authenticatedExecutionOutcome(outcome, step)
    if (!authenticated || authenticated.kind !== 'complete') return unavailable('Git execution evidence is unavailable or unauthenticated')
    const decoded = decodeGitObservation(authenticated.stdout, { stackId: context.stackId, observedAt: authenticated.receipt.finishedAt, source: context.source })
    if (decoded.kind !== 'complete') return decoded
    const result = Object.freeze({
        kind: 'complete' as const,
        evidence: decoded.evidence,
        observations: Object.freeze(decoded.observations.map(issueObservation)),
    })
    issuedGitResults.set(result, Object.freeze({ ...binding, evidence: decoded.evidence }))
    return result
}

type AcquirePosture = 'auto' | 'manual' | 'none'
type ComparisonRemoteCode = typeof ENVIRONMENT_CODES.GIT_COMPARISON_REMOTE_MISMATCH

export type ComparisonRemoteResult =
    | Readonly<{ kind: 'complete'; code: ComparisonRemoteCode; state: 'match'; remoteName: string }>
    | Readonly<{ kind: 'complete'; code: ComparisonRemoteCode; state: 'mismatch'; remoteName: string; reason: string }>
    | Readonly<{ kind: 'not-applicable'; code: ComparisonRemoteCode; reason: string }>
    | Readonly<{ kind: 'unavailable'; code: ComparisonRemoteCode; reason: string; remoteName?: string }>

export type ComparisonRemoteRefStage =
    | Readonly<{ kind: 'probe'; step: ExecutionStep }>
    | Extract<ComparisonRemoteResult, { kind: 'not-applicable' | 'unavailable' }>

export type ComparisonRemoteUrlStage =
    | Readonly<{ kind: 'probe'; step: ExecutionStep; remoteName: string }>
    | Extract<ComparisonRemoteResult, { kind: 'unavailable' }>

export type ComparisonRemoteRevalidationStage =
    | Readonly<{ kind: 'probe'; step: ExecutionStep; remoteName: string }>
    | Extract<ComparisonRemoteResult, { kind: 'unavailable' }>

interface ComparisonBinding extends GitBinding {
    readonly sibling: string
    readonly expected: Readonly<RepositoryIdentity>
    readonly branch: string
    readonly revision: string
    readonly upstream: string
}

const issuedComparisonRefs = new WeakMap<object, ComparisonBinding>()
const issuedComparisonUrls = new WeakMap<object, ComparisonBinding & { readonly remoteName: string }>()
const issuedComparisonRevalidations = new WeakMap<object, ComparisonBinding & {
    readonly remoteName: string
    readonly state: 'match' | 'mismatch'
}>()
declare const gitAncestryObservationBrand: unique symbol
export type GitAncestryObservation = Readonly<{ readonly [gitAncestryObservationBrand]: true }>
const issuedGitAncestrySteps = new WeakMap<object, GitBinding & { readonly ancestor: string; readonly revision: string }>()
const issuedGitAncestryObservations = new WeakSet<object>()
const COMPARISON_OUTPUT_LIMIT = 4_096
const comparisonCode = ENVIRONMENT_CODES.GIT_COMPARISON_REMOTE_MISMATCH

function comparisonUnavailable(reason: string, remoteName?: string): Extract<ComparisonRemoteResult, { kind: 'unavailable' }> {
    return Object.freeze(remoteName === undefined
        ? { kind: 'unavailable' as const, code: comparisonCode, reason }
        : { kind: 'unavailable' as const, code: comparisonCode, reason, remoteName })
}

function safeSibling(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(value)
}

function safeRemoteName(value: string): boolean {
    return /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/.test(value)
        && !value.includes('//') && !value.includes('..') && !value.endsWith('/')
}

function comparisonStep(input: {
    readonly id: string
    readonly argv: readonly [string, ...string[]]
    readonly binding: GitBinding
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
}): ExecutionStep | undefined {
    const environment = safeObservationEnvironment(input.env)
    if (!environment || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) return undefined
    return snapshotExecutionStep({
        id: input.id, argv: input.argv, argv0: input.binding.executable.invocationPath,
        cwd: input.binding.checkoutRoot, env: Object.fromEntries(environment), timeoutMs: input.timeoutMs,
        stdoutLimitBytes: COMPARISON_OUTPUT_LIMIT, stderrLimitBytes: COMPARISON_OUTPUT_LIMIT,
        paths: [input.binding.checkoutRoot], ports: [],
        labels: { stackId: input.binding.stackId, source: input.binding.source, checkoutId: input.binding.checkoutId },
        expected: [{ kind: 'path', target: input.binding.checkoutRoot, state: 'repository' }],
        consumedFiles: [{
            path: input.binding.executable.canonicalPath, sha256: input.binding.executable.sha256,
            maxBytes: 536_870_912, argvIndexes: [0], executable: true,
            executionMode: input.binding.executable.executionMode,
        }],
        filesystemChecks: [], compensation: [],
    })
}

export function createGitAncestryObservationStep(input: {
    readonly git: GitObservationResult
    readonly ancestor: string
}): ExecutionStep | undefined {
    const git = input.git.kind === 'complete' ? issuedGitResults.get(input.git) : undefined
    if (!git || !/^[a-f0-9]{40}$/.test(input.ancestor) || !/^[a-f0-9]{40}$/.test(git.evidence.revision)) return undefined
    const step = comparisonStep({
        id: 'git:comparison-ancestry', binding: git, env: git.env, timeoutMs: git.timeoutMs,
        argv: [git.executable.canonicalPath, '-C', git.checkoutRoot, 'merge-base', '--is-ancestor', input.ancestor, git.evidence.revision],
    })
    if (step) issuedGitAncestrySteps.set(step, Object.freeze({ ...git, ancestor: input.ancestor, revision: git.evidence.revision }))
    return step
}

export function observeGitAncestry(step: ExecutionStep, outcome: ExecuteProbeOutcome): GitAncestryObservation | undefined {
    const binding = issuedGitAncestrySteps.get(step)
    if (!binding) return undefined
    const authenticated = authenticatedExecutionOutcome(outcome, step)
    if (!authenticated || authenticated.kind !== 'complete' || authenticated.stdout.byteLength !== 0
        || authenticated.stderr.byteLength !== 0) return undefined
    const observation = Object.freeze({}) as GitAncestryObservation
    issuedGitAncestryObservations.add(observation)
    return observation
}

export function createComparisonRemoteRefStep(input: {
    readonly executable: ResolvedExecutable
    readonly checkoutRoot: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
    readonly checkoutId: CheckoutId
    readonly source: string
    readonly sibling: string
    readonly acquire: AcquirePosture
    readonly declaredRemote?: string
    readonly git?: GitObservationResult
}): ComparisonRemoteRefStage {
    if (!safeSibling(input.sibling)) return comparisonUnavailable('comparison sibling identity is unavailable')
    if (input.declaredRemote === undefined) {
        return input.acquire === 'none'
            ? Object.freeze({ kind: 'not-applicable', code: comparisonCode, reason: `sibling ${input.sibling} has no declared comparison remote` })
            : comparisonUnavailable(`declared repository identity is unavailable for sibling ${input.sibling}`)
    }
    const expected = repositoryIdentity(input.declaredRemote)
    if (expected.kind !== 'known') return comparisonUnavailable(`declared repository identity is unavailable for sibling ${input.sibling}`)
    const git = input.git && issuedGitResults.get(input.git)
    const executable = resolvedGitExecutable(input.executable)
    if (!git || !executable || git.stackId !== input.stackId || git.checkoutId !== input.checkoutId
        || git.source !== input.source || git.checkoutRoot !== input.checkoutRoot
        || git.executable.canonicalPath !== executable.canonicalPath || git.executable.sha256 !== executable.sha256) {
        return comparisonUnavailable(`Git status evidence is unavailable for sibling ${input.sibling}`)
    }
    const { branch, revision, upstream } = git.evidence
    if (upstream === null || branch === '(detached)') {
        return comparisonUnavailable(`comparison upstream is unavailable for sibling ${input.sibling}`)
    }
    const binding = Object.freeze({ ...git, sibling: input.sibling, expected: expected.identity, branch, revision, upstream })
    const step = comparisonStep({
        id: `git:${input.sibling}:comparison-ref`, binding, env: input.env, timeoutMs: input.timeoutMs,
        argv: [executable.canonicalPath, '-C', input.checkoutRoot, 'for-each-ref',
            '--format=%(objectname)%00%(refname)%00%(upstream:short)%00%(upstream:remotename)',
            '--count=1', '--', `refs/heads/${branch}`],
    })
    if (!step) return comparisonUnavailable(`comparison ref probe is unavailable for sibling ${input.sibling}`)
    const stage = Object.freeze({ kind: 'probe' as const, step })
    issuedComparisonRefs.set(stage, binding)
    return stage
}

function decodeComparisonRef(bytes: Buffer, binding: ComparisonBinding): string | undefined {
    if (bytes.byteLength === 0 || bytes.byteLength > COMPARISON_OUTPUT_LIMIT) return undefined
    let value: string
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return undefined }
    const lines = value.replace(/\n$/, '').split(/\r?\n/)
    if (lines.length !== 1) return undefined
    const fields = lines[0].split('\0')
    if (fields.length !== 4) return undefined
    const [revision, ref, upstream, remoteName] = fields
    if (revision !== binding.revision || ref !== `refs/heads/${binding.branch}` || upstream !== binding.upstream
        || !safeRemoteName(remoteName)) return undefined
    return remoteName
}

export function observeComparisonRemoteRef(stage: ComparisonRemoteRefStage, outcome: ExecuteProbeOutcome): ComparisonRemoteUrlStage {
    const binding = issuedComparisonRefs.get(stage)
    if (!binding || stage.kind !== 'probe') return comparisonUnavailable('comparison ref evidence is unavailable or unauthenticated')
    const authenticated = authenticatedExecutionOutcome(outcome, stage.step)
    if (!authenticated || authenticated.kind !== 'complete') {
        return comparisonUnavailable(`comparison ref evidence is unavailable for sibling ${binding.sibling}`)
    }
    const remoteName = decodeComparisonRef(authenticated.stdout, binding)
    if (!remoteName) return comparisonUnavailable(`comparison upstream is unavailable for sibling ${binding.sibling}`)
    const step = comparisonStep({
        id: `git:${binding.sibling}:comparison-url`, binding, env: stage.step.env, timeoutMs: stage.step.timeoutMs,
        argv: [binding.executable.canonicalPath, '-C', binding.checkoutRoot, 'remote', 'get-url', '--', remoteName],
    })
    if (!step) return comparisonUnavailable(`comparison remote probe is unavailable for sibling ${binding.sibling}`, remoteName)
    const next = Object.freeze({ kind: 'probe' as const, step, remoteName })
    issuedComparisonUrls.set(next, Object.freeze({ ...binding, remoteName }))
    return next
}

export function observeComparisonRemoteUrl(stage: ComparisonRemoteUrlStage, outcome: ExecuteProbeOutcome): ComparisonRemoteRevalidationStage {
    const binding = issuedComparisonUrls.get(stage)
    if (!binding || stage.kind !== 'probe') return comparisonUnavailable('comparison remote evidence is unavailable or unauthenticated')
    const authenticated = authenticatedExecutionOutcome(outcome, stage.step)
    if (!authenticated || authenticated.kind !== 'complete') {
        return comparisonUnavailable(`comparison remote evidence is unavailable for sibling ${binding.sibling}`, binding.remoteName)
    }
    if (authenticated.stdout.byteLength === 0 || authenticated.stdout.byteLength > COMPARISON_OUTPUT_LIMIT) {
        return comparisonUnavailable(`comparison remote identity is unavailable for sibling ${binding.sibling}`, binding.remoteName)
    }
    let raw: string
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(authenticated.stdout) } catch {
        return comparisonUnavailable(`comparison remote identity is unavailable for sibling ${binding.sibling}`, binding.remoteName)
    }
    const lines = raw.replace(/\n$/, '').split(/\r?\n/)
    const observed = lines.length === 1 ? repositoryIdentity(lines[0]) : undefined
    if (!observed || observed.kind !== 'known') {
        return comparisonUnavailable(`comparison remote identity is unavailable for sibling ${binding.sibling}`, binding.remoteName)
    }
    const state = observed.identity.host === binding.expected.host
        && observed.identity.owner === binding.expected.owner
        && observed.identity.repository === binding.expected.repository ? 'match' : 'mismatch'
    const step = comparisonStep({
        id: `git:${binding.sibling}:comparison-revalidate`, binding, env: stage.step.env, timeoutMs: stage.step.timeoutMs,
        argv: [binding.executable.canonicalPath, '-C', binding.checkoutRoot, 'for-each-ref',
            '--format=%(objectname)%00%(refname)%00%(upstream:short)%00%(upstream:remotename)',
            '--count=1', '--', `refs/heads/${binding.branch}`],
    })
    if (!step) return comparisonUnavailable(`comparison revalidation probe is unavailable for sibling ${binding.sibling}`, binding.remoteName)
    const next = Object.freeze({ kind: 'probe' as const, step, remoteName: binding.remoteName })
    issuedComparisonRevalidations.set(next, Object.freeze({ ...binding, state }))
    return next
}

export function observeComparisonRemoteRevalidation(
    stage: ComparisonRemoteRevalidationStage,
    outcome: ExecuteProbeOutcome,
): ComparisonRemoteResult {
    const binding = issuedComparisonRevalidations.get(stage)
    if (!binding || stage.kind !== 'probe') {
        return comparisonUnavailable('comparison revalidation evidence is unavailable or unauthenticated')
    }
    const authenticated = authenticatedExecutionOutcome(outcome, stage.step)
    if (!authenticated || authenticated.kind !== 'complete'
        || decodeComparisonRef(authenticated.stdout, binding) !== binding.remoteName) {
        return comparisonUnavailable(`comparison upstream changed while authenticating sibling ${binding.sibling}`, binding.remoteName)
    }
    return binding.state === 'match'
        ? Object.freeze({ kind: 'complete', code: comparisonCode, state: binding.state, remoteName: binding.remoteName })
        : Object.freeze({
            kind: 'complete', code: comparisonCode, state: binding.state, remoteName: binding.remoteName,
            reason: `comparison remote ${binding.remoteName} does not match the declared repository for sibling ${binding.sibling}`,
        })
}

export type RunningCheckoutObservationResult =
    | { readonly kind: 'complete'; readonly observation: EnvironmentObservation }
    | { readonly kind: 'unavailable'; readonly reason: string }

export function observeRunningCheckout(
    topology: RuntimeTopologyEvidence,
    checkoutProjection: SetupCheckoutProjection,
    observedAt: string,
): RunningCheckoutObservationResult {
    const checkout = consumeSetupCheckoutProjection(checkoutProjection)
    const now = Date.now()
    const observed = Date.parse(observedAt)
    if (!checkout || !isRuntimeTopologyEvidence(topology) || !isCanonicalTimestamp(observedAt)
        || observed > now || observed < Date.parse(checkout.observedAt)
        || now > Date.parse(checkout.validThrough)
        || observed < Date.parse(topology.observationWindow.startedAt)
        || observed > Date.parse(topology.observationWindow.expiresAt)) {
        return { kind: 'unavailable', reason: 'running checkout needs current authenticated topology and checkout evidence' }
    }
    const expectedStack = deriveStackId({ cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, variant: { kind: 'shared' } })
    const measured = Object.freeze({ stackId: topology.stackId, configSha256: topology.configSha256,
        checkoutMatches: topology.cwd === dirname(checkout.source.path) })
    const expected = Object.freeze({ stackId: expectedStack, configSha256: checkout.source.sha256, checkoutMatches: true })
    const observation: EnvironmentObservation = {
        code: ENVIRONMENT_CODES.RUNNING_CHECKOUT_MISMATCH, owner: mechanism.id, stackId: expectedStack,
        source: `${checkout.source.path}:running-checkout`, observed: { state: 'available', value: measured, observedAt },
        expectation: { kind: 'equal', value: expected }, applicability: { state: 'required', posture: 'running-stack' },
        freshness: { state: 'current' }, remedy: 'restart the stack from the current checkout and configuration',
    }
    return { kind: 'complete', observation: issueObservation(observation) }
}
