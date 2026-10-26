import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import type { ExecutionStep } from '../environment/contract.js'
import type { ResolvedExecutable } from '../environment/executable.js'
import { relative, resolve } from 'node:path'
import { consumeComparisonPostState, type BoundedComparisonLifecycle, type BoundedComparisonLifecycleResult } from '../environment/destructive-composition.js'
import { resolvedGitExecutable } from '../environment/executable.js'
import { createGitAncestryObservationStep, createGitObservationStep, observeGit, observeGitAncestry } from '../environment/git-observation.js'
import { consumeSetupCheckoutProjection, observeSetupCheckout, withSetupCheckoutProjection,
    type ConsumedSetupCheckoutObservation, type SetupCheckoutObservationContext } from '../environment/setup-observation.js'
import { nodeAuthority, readAnchoredBatches } from '../generated-environment/transaction.js'
import { normalizeComparisonOutput } from './normalize.js'
import { parseComparisonFixture, type ComparisonFixture } from './contract.js'
import { installedPackageMetadata } from '../package-metadata.js'

export const mechanism = {
    id: 'comparison-runner',
    module: 'packages/cockpit/src/comparison/runner.ts',
    exports: ['observeComparisonSubject', 'runComparison'],
} as const

declare const comparisonSubjectBrand: unique symbol
export type ComparisonSubjectProjection = Readonly<{ readonly [comparisonSubjectBrand]: true }>
type ComparisonSubjectRecord = Readonly<{ fixture: ComparisonFixture; checkoutId: string; checkoutRoot: string;
    currentRevision: string; legacyRevision: string; cockpitRevision: string;
    trackedDirtyCount: number; untrackedCount: number; packagePath: string; fixturePath: string;
    packageIntegrity: string; fixtureSha256: string;
    inputs: readonly Readonly<{ path: string; sha256: string }>[];
    executables: readonly Readonly<{ declaration: string; identity: ResolvedExecutable }>[] }>
const issuedSubjects = new WeakMap<object, ComparisonSubjectRecord>()

export interface ComparisonSubjectObservationInput {
    readonly fixture: ComparisonFixture
    readonly lifecycle: BoundedComparisonLifecycle
    readonly packagePath: string
    readonly fixturePath: string
    readonly checkout: Readonly<{ input: unknown; context: SetupCheckoutObservationContext }>
}

export interface ComparisonRunnerDependencies {
    refresh(lifecycle: BoundedComparisonLifecycle): Promise<ComparisonSubjectProjection | undefined>
    withLifecycle<T>(use: (lifecycle: BoundedComparisonLifecycle) => Promise<T>): Promise<BoundedComparisonLifecycleResult<T>>
    decideReset?: (preview: unknown) => Promise<'approve' | 'decline'>
}

export type ComparisonCommandEvidence = Readonly<{
    implementation: 'legacy' | 'cockpit'
    command: string
    exitCode: number
    stdout: string
    stderr: string
    normalizedStdout: string
    normalizedStderr: string
    postStateSha256: string
    source: 'process' | 'owner'
    ownerOutcome?: unknown
}>

export type ComparisonRunResult =
    | Readonly<{ kind: 'complete'; evidence: readonly ComparisonCommandEvidence[]; retainCheckout: false }>
    | Readonly<{ kind: 'refusal'; reason: string; evidence: readonly ComparisonCommandEvidence[]; retainCheckout: true }>

function refusal(reason: string, evidence: readonly ComparisonCommandEvidence[] = []): ComparisonRunResult {
    return Object.freeze({ kind: 'refusal', reason, evidence: Object.freeze([...evidence]), retainCheckout: true })
}

function consumeCurrentSubject(
    fixture: ComparisonFixture,
    projection: ComparisonSubjectProjection | undefined,
    baseline?: ComparisonSubjectRecord,
): ComparisonSubjectRecord | undefined {
    if (!projection || typeof projection !== 'object') return undefined
    const record = issuedSubjects.get(projection)
    issuedSubjects.delete(projection)
    return record && JSON.stringify(record.fixture) === JSON.stringify(fixture)
        && record.legacyRevision === fixture.subject.revisions.legacy && record.cockpitRevision === fixture.subject.revisions.cockpit
        && record.trackedDirtyCount === 0 && record.untrackedCount === 0
        && record.packageIntegrity === fixture.subject.packageIntegrity
        && JSON.stringify(record.inputs) === JSON.stringify(fixture.subject.inputs)
        && (baseline === undefined || JSON.stringify(record) === JSON.stringify(baseline)) ? record : undefined
}

export async function observeComparisonSubject(input: ComparisonSubjectObservationInput): Promise<ComparisonSubjectProjection | undefined> {
    const checkoutObservation = await observeSetupCheckout(input.checkout.input)
    const checkoutHolder: { value?: ConsumedSetupCheckoutObservation } = {}
    await withSetupCheckoutProjection(checkoutObservation, input.checkout.context, projection => {
        checkoutHolder.value = consumeSetupCheckoutProjection(projection)
    })
    const checkout = checkoutHolder.value
    const overlaps = (left: string, right: string) => {
        const forward = relative(left, right)
        const reverse = relative(right, left)
        return forward === '' || !forward.startsWith('..') && forward !== '..'
            || reverse === '' || !reverse.startsWith('..') && reverse !== '..'
    }
    if (!checkout || checkout.checkoutId !== input.lifecycle.checkout.id
        || checkout.currentCheckoutPath !== input.lifecycle.checkout.root
        || overlaps(checkout.currentCheckoutPath, checkout.mainCheckoutPath)) return undefined
    const resolvedGit = await input.lifecycle.resolveExecutable('git')
    const git = resolvedGit.state === 'available' ? resolvedGitExecutable(resolvedGit.value) : undefined
    if (!git) return undefined
    const step = createGitObservationStep({ executable: git, checkoutRoot: input.lifecycle.checkout.root,
        env: Object.freeze({}),
        timeoutMs: 30_000, stackId: input.lifecycle.stack, source: 'comparison-subject', checkoutId: input.lifecycle.checkout.id })
    if (!step) return undefined
    const observed = observeGit(step, await input.lifecycle.execute(step), {
        stackId: input.lifecycle.stack, checkoutId: input.lifecycle.checkout.id, source: 'comparison-subject',
    })
    if (observed.kind !== 'complete') return undefined
    if (!/^[a-f0-9]{40}$/.test(installedPackageMetadata.cockpitSourceRevision)
        || installedPackageMetadata.cockpitSourceRevision !== input.fixture.subject.revisions.cockpit) return undefined
    const ancestryStep = createGitAncestryObservationStep({ git: observed, ancestor: input.fixture.subject.revisions.legacy })
    if (!ancestryStep || !observeGitAncestry(ancestryStep, await input.lifecycle.execute(ancestryStep))) return undefined
    const node = await nodeAuthority()
    if (!node) return undefined
    const paths = [...input.fixture.subject.inputs.map(row => row.path), input.packagePath, input.fixturePath]
    const reads = await readAnchoredBatches(input.lifecycle.checkout.root,
        paths.map(path => Object.freeze({ path, action: 'read-entry' as const, maxBytes: 8 * 1_048_576 })), node,
        { execute: input.lifecycle.execute })
    if (!reads || reads.kind !== 'complete' || reads.results.length !== paths.length) return undefined
    const rows = reads.results.map((result, index) => result.kind !== 'file'
        ? undefined : Object.freeze({ path: paths[index]!, sha256: result.sha256 }))
    if (rows.some(row => row === undefined)) return undefined
    const presentRows = rows as readonly Readonly<{ path: string; sha256: string }>[]
    const material = presentRows.slice(0, input.fixture.subject.inputs.length)
    const packageRow = presentRows.at(-2)!
    const fixtureRow = presentRows.at(-1)!
    const fixtureRead = reads.results.at(-1)!
    if (JSON.stringify(material) !== JSON.stringify(input.fixture.subject.inputs)
        || packageRow.sha256 !== input.fixture.subject.packageIntegrity || !('bytes' in fixtureRead)) return undefined
    let parsedFixture: unknown
    try { parsedFixture = JSON.parse(fixtureRead.bytes.toString('utf8')) } catch { return undefined }
    const parsed = parseComparisonFixture(parsedFixture)
    if (parsed.kind !== 'complete' || JSON.stringify(parsed.fixture) !== JSON.stringify(input.fixture)) return undefined
    const declarations = [...new Set(input.fixture.implementations.flatMap(implementation => (
        implementation.bindings.map(binding => binding.executable)
    )))]
    const resolvedExecutables = await Promise.all(declarations.map(declaration => input.lifecycle.resolveExecutable(declaration)))
    if (resolvedExecutables.some(result => result.state !== 'available')) return undefined
    const executables = Object.freeze(declarations.map((declaration, index) => Object.freeze({
        declaration,
        identity: (resolvedExecutables[index] as Extract<(typeof resolvedExecutables)[number], { state: 'available' }>).value,
    })))
    const record = Object.freeze({ fixture: input.fixture, checkoutId: input.lifecycle.checkout.id,
        checkoutRoot: input.lifecycle.checkout.root,
        currentRevision: observed.evidence.revision, legacyRevision: input.fixture.subject.revisions.legacy,
        cockpitRevision: installedPackageMetadata.cockpitSourceRevision,
        trackedDirtyCount: observed.evidence.trackedDirtyCount,
        untrackedCount: observed.evidence.untrackedCount, packagePath: input.packagePath, fixturePath: input.fixturePath,
        packageIntegrity: packageRow.sha256,
        fixtureSha256: fixtureRow.sha256, inputs: Object.freeze(material), executables })
    const projection = Object.freeze({}) as ComparisonSubjectProjection
    issuedSubjects.set(projection, record)
    return projection
}

function sameFileObservation(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function stableFileSha256(root: string, path: string): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let result: string | undefined
    try {
        const canonicalRoot = await realpath(root)
        const target = resolve(canonicalRoot, path)
        const fromRoot = relative(canonicalRoot, target)
        if (fromRoot === '..' || fromRoot.startsWith('../') || resolve(await realpath(target)) !== target) return undefined
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = await handle.stat()
        const pathBefore = await stat(target)
        if (!before.isFile() || !sameFileObservation(before, pathBefore) || before.size > 8 * 1_048_576) {
            throw new Error('comparison source is not a bounded stable file')
        }
        const buffer = Buffer.alloc(65_536)
        const hash = createHash('sha256')
        let offset = 0
        while (offset < before.size) {
            const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
            if (read.bytesRead === 0) break
            hash.update(buffer.subarray(0, read.bytesRead))
            offset += read.bytesRead
        }
        const after = await handle.stat()
        const pathAfter = await stat(target)
        if (offset !== before.size || !sameFileObservation(before, after) || !sameFileObservation(after, pathAfter)
            || await realpath(root) !== canonicalRoot || resolve(await realpath(target)) !== target) {
            throw new Error('comparison source changed during its bounded read')
        }
        result = hash.digest('hex')
    } catch {
        result = undefined
    } finally {
        if (handle) {
            try { await handle.close() } catch { result = undefined }
        }
    }
    return result
}

async function refreshSubject(
    lifecycle: BoundedComparisonLifecycle,
    subject: ComparisonSubjectRecord,
    state: 'bound' | 'released',
): Promise<boolean> {
    if (lifecycle.checkout.id !== subject.checkoutId || lifecycle.checkout.root !== subject.checkoutRoot
        || installedPackageMetadata.cockpitSourceRevision !== subject.cockpitRevision) return false
    const gitResolution = await lifecycle.resolveExecutable('git')
    const git = gitResolution.state === 'available' ? resolvedGitExecutable(gitResolution.value) : undefined
    if (!git) return false
    const observeCurrentGit = async () => {
        let step: ExecutionStep | undefined
        let outcome: ExecuteProbeOutcome | undefined
        if (state === 'released') {
            const issued = await lifecycle.observeReleasedGit(git)
            step = issued?.step
            outcome = issued?.outcome
        } else {
            step = createGitObservationStep({ executable: git, checkoutRoot: lifecycle.checkout.root,
                env: Object.freeze({}), timeoutMs: 30_000, stackId: lifecycle.stack,
                source: 'comparison-subject', checkoutId: lifecycle.checkout.id })
            if (step) outcome = await lifecycle.execute(step)
        }
        if (!step || !outcome) return false
        const observed = observeGit(step, outcome, {
            stackId: lifecycle.stack, checkoutId: lifecycle.checkout.id, source: 'comparison-subject',
        })
        return observed.kind === 'complete' && observed.evidence.revision === subject.currentRevision
            && observed.evidence.trackedDirtyCount === subject.trackedDirtyCount
            && observed.evidence.untrackedCount === subject.untrackedCount
    }
    if (!await observeCurrentGit()) return false
    const paths = [...subject.inputs.map(row => row.path), subject.packagePath, subject.fixturePath]
    const expected = [...subject.inputs.map(row => row.sha256), subject.packageIntegrity, subject.fixtureSha256]
    for (const [index, path] of paths.entries()) {
        if (await stableFileSha256(subject.checkoutRoot, path) !== expected[index]) return false
    }
    const resolvedExecutables = await Promise.all(subject.executables.map(row => lifecycle.resolveExecutable(row.declaration)))
    return resolvedExecutables.every((result, index) => result.state === 'available'
        && JSON.stringify(result.value) === JSON.stringify(subject.executables[index]!.identity))
        && await observeCurrentGit()
}

function executionStep(
    lifecycle: BoundedComparisonLifecycle,
    implementation: 'legacy' | 'cockpit',
    command: string,
    binding: ComparisonFixture['implementations'][number]['bindings'][number],
    executable: ResolvedExecutable,
): ExecutionStep {
    return Object.freeze({
        id: `comparison-${implementation}-${command}`,
        argv: Object.freeze([executable.canonicalPath, ...binding.argv]) as readonly [string, ...string[]],
        argv0: executable.invocationPath,
        cwd: lifecycle.checkout.root,
        env: Object.freeze({}),
        timeoutMs: 30_000,
        stdoutLimitBytes: 1_048_576,
        stderrLimitBytes: 1_048_576,
        paths: Object.freeze([]), ports: Object.freeze([]),
        labels: Object.freeze({ operation: 'comparison', implementation, command, stackId: lifecycle.stack }),
        expected: Object.freeze([]), consumedFiles: Object.freeze([Object.freeze({
            path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]), executable: true as const, executionMode: executable.executionMode,
        })]), filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    })
}

async function runStep(
    fixture: ComparisonFixture,
    lifecycle: BoundedComparisonLifecycle,
    implementation: ComparisonFixture['implementations'][number],
    command: string,
    dependencies: ComparisonRunnerDependencies,
    subject: ComparisonSubjectRecord,
): Promise<ComparisonCommandEvidence | string> {
    const binding = implementation.bindings.find(row => row.command === command)
    const declaredPostState = implementation.postStates.find(row => row.command === command)?.observationSha256
    if (!binding || !declaredPostState) return `${implementation.id} ${command} is not bound by the fixture`
    const observePostState = async () => consumeComparisonPostState(
        await lifecycle.observePostState(implementation.id, command),
        { stackId: lifecycle.stack, checkoutId: lifecycle.checkout.id, implementation: implementation.id, command },
    )
    if (implementation.id === 'cockpit' && command === 'reset') {
        const reset = await lifecycle.beginReset()
        if (!('preview' in reset)) return Object.freeze({ implementation: implementation.id, command,
            exitCode: reset.status, stdout: '', stderr: '', normalizedStdout: '', normalizedStderr: '',
            postStateSha256: '', source: 'owner' as const, ownerOutcome: reset })
        if (!dependencies.decideReset) return 'cockpit reset requires explicit operator approval'
        const decision = await dependencies.decideReset(reset.preview)
        const outcome = await reset.decide(decision)
        if (decision !== 'approve' || outcome.kind !== 'complete') return Object.freeze({ implementation: implementation.id, command,
            exitCode: outcome.status, stdout: '', stderr: '', normalizedStdout: '', normalizedStderr: '',
            postStateSha256: '', source: 'owner' as const, ownerOutcome: outcome })
        const postStateSha256 = await observePostState()
        if (postStateSha256 !== declaredPostState) return 'cockpit reset post-state differs from the fixture'
        return Object.freeze({ implementation: implementation.id, command, exitCode: outcome.status,
            stdout: '', stderr: '', normalizedStdout: '', normalizedStderr: '', postStateSha256,
            source: 'owner' as const, ownerOutcome: outcome })
    }
    let outcome: ExecuteProbeOutcome
    if (implementation.id === 'cockpit' && (command === 'up' || command === 'down')) {
        const lifecycleOutcome = command === 'up' ? await lifecycle.up() : await lifecycle.down()
        if (lifecycleOutcome.kind !== 'complete') return Object.freeze({ implementation: implementation.id, command,
            exitCode: lifecycleOutcome.status, stdout: '', stderr: '', normalizedStdout: '', normalizedStderr: '',
            postStateSha256: '', source: 'owner' as const, ownerOutcome: lifecycleOutcome })
        const postStateSha256 = await observePostState()
        if (postStateSha256 !== declaredPostState) return `cockpit ${command} post-state differs from the fixture`
        return Object.freeze({ implementation: implementation.id, command, exitCode: lifecycleOutcome.status,
            stdout: '', stderr: '', normalizedStdout: '', normalizedStderr: '', postStateSha256,
            source: 'owner' as const, ownerOutcome: lifecycleOutcome })
    }
    const executable = subject.executables.find(row => row.declaration === binding.executable)?.identity
    if (!executable) return `${implementation.id} ${command} executable identity is unavailable`
    const step = executionStep(lifecycle, implementation.id, command, binding, executable)
    outcome = await lifecycle.execute(step)
    const authenticated = authenticatedExecutionOutcome(outcome, step)
    if (!authenticated) return `${implementation.id} ${command} returned unauthenticated execution evidence`
    const postStateSha256 = await observePostState()
    if (postStateSha256 !== declaredPostState) return `${implementation.id} ${command} post-state differs from the fixture`
    const stdout = authenticated.stdout.toString('utf8')
    const stderr = authenticated.stderr.toString('utf8')
    const normalizedStdout = normalizeComparisonOutput(stdout, fixture.normalization)
    const normalizedStderr = normalizeComparisonOutput(stderr, fixture.normalization)
    if (normalizedStdout.kind !== 'complete' || normalizedStderr.kind !== 'complete') {
        return `${implementation.id} ${command} output is not safely normalizable`
    }
    return Object.freeze({
        implementation: implementation.id, command, exitCode: authenticated.execution.exitCode,
        stdout, stderr, normalizedStdout: normalizedStdout.normalized, normalizedStderr: normalizedStderr.normalized,
        postStateSha256, source: 'process' as const,
    })
}

export async function runComparison(
    inputFixture: unknown,
    dependencies: ComparisonRunnerDependencies,
): Promise<ComparisonRunResult> {
    const parsed = parseComparisonFixture(inputFixture)
    if (parsed.kind !== 'complete') return refusal(parsed.message)
    const fixture = parsed.fixture
    const evidence: ComparisonCommandEvidence[] = []
    const bounded = await dependencies.withLifecycle(async lifecycle => {
        const refreshed = await dependencies.refresh(lifecycle)
        const baseline = consumeCurrentSubject(fixture, refreshed)
        if (!baseline) return refusal('comparison subject identity changed before execution')
        if (lifecycle.checkout.id !== baseline.checkoutId || lifecycle.checkout.root !== baseline.checkoutRoot) {
            return refusal('comparison lifecycle does not match the observed subject', evidence)
        }
        const declaredCommands = [...fixture.commands.shared, ...fixture.commands.extras]
        const commands = ['up', 'reset', ...declaredCommands.filter(command => !['up', 'reset', 'down'].includes(command)), 'down']
        const subjectIsCurrent = () => refreshSubject(lifecycle, baseline, 'bound')
        for (const [index, command] of commands.entries()) {
            const ordered = command === 'up' || command === 'reset'
                ? [...fixture.implementations].reverse()
                : command === 'down' || index % 2 === 0 ? fixture.implementations : [...fixture.implementations].reverse()
            const paired: ComparisonCommandEvidence[] = []
            for (const implementation of ordered) {
                if (!await subjectIsCurrent()) {
                    return refusal('comparison subject identity changed during execution', evidence)
                }
                const result = await runStep(fixture, lifecycle, implementation, command, dependencies, baseline)
                const current = implementation.id === 'cockpit' && command === 'down'
                    ? await refreshSubject(lifecycle, baseline, 'released')
                    : await subjectIsCurrent()
                if (!current) {
                    return refusal('comparison subject identity changed during execution', evidence)
                }
                if (typeof result === 'string') {
                    if (implementation.id === 'legacy' && command === 'up') {
                        if (!await subjectIsCurrent()) {
                            return refusal('comparison subject identity changed during execution', evidence)
                        }
                        const cleanup = await runStep(fixture, lifecycle, implementation, 'down', dependencies, baseline)
                        if (!await subjectIsCurrent()) {
                            return refusal('comparison subject identity changed during execution', evidence)
                        }
                        if (typeof cleanup === 'string' || cleanup.exitCode !== 0) lifecycle.retainInspection()
                        else evidence.push(cleanup)
                    }
                    return refusal(result, evidence)
                }
                evidence.push(result)
                paired.push(result)
                if (implementation.id === 'legacy' && command === 'up') {
                    if (!await subjectIsCurrent()) {
                        return refusal('comparison subject identity changed during execution', evidence)
                    }
                    const cleanup = await runStep(fixture, lifecycle, implementation, 'down', dependencies, baseline)
                    if (!await subjectIsCurrent()) {
                        return refusal('comparison subject identity changed during execution', evidence)
                    }
                    if (typeof cleanup === 'string' || cleanup.exitCode !== 0) {
                        lifecycle.retainInspection()
                        return refusal(typeof cleanup === 'string' ? cleanup : 'legacy teardown failed', evidence)
                    }
                    evidence.push(cleanup)
                }
                if (result.exitCode !== 0) return refusal(`${implementation.id} ${command} exited nonzero`, evidence)
            }
            const legacy = paired.find(row => row.implementation === 'legacy')
            const cockpit = paired.find(row => row.implementation === 'cockpit')
            if (!legacy || !cockpit || legacy.exitCode !== cockpit.exitCode
                || legacy.normalizedStdout !== cockpit.normalizedStdout
                || legacy.normalizedStderr !== cockpit.normalizedStderr
                || legacy.postStateSha256 !== cockpit.postStateSha256) {
                return refusal(`${command} differs between legacy and cockpit`, evidence)
            }
        }
        return Object.freeze({ kind: 'complete' as const, evidence: Object.freeze(evidence), retainCheckout: false as const })
    })
    return bounded.kind === 'complete' ? bounded.result : refusal(bounded.reason, evidence)
}
