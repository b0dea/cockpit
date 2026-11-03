import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { type StackId } from './contract.js'
import {
    authenticateStabilityCapture, captureRuntimeEvidence, compareEnvironmentSnapshot,
    createEnvironmentSnapshot, createStabilityCapturePlan, isRuntimeEvidenceAuthentic, type AuthenticatedStabilityCapture,
    type CapturedRuntimeEvidence,
} from './evidence.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const bytes = (value: string) => new TextEncoder().encode(value)
const stackId = `stack:${sha('synthetic-stack')}` as StackId
const configSha256 = sha('synthetic-config')
const observedAt = '2026-09-07T12:00:00.000Z'
const runtimeDirectory = mkdtempSync(join(tmpdir(), 'cockpit-evidence-runtime-'))
const runtimePath = join(runtimeDirectory, 'runtime')
const runtimeInvocationPath = join(runtimeDirectory, 'docker')
const runtimeSource = `#!/bin/sh
case "$*" in
  *'/proc/1/stat'*) printf '%s\\n' "\${COCKPIT_PROCESS_IDENTITY:-777 12345}" ;;
  *'cockpit-content-hash'*) printf '%s  -\\n' "\${COCKPIT_CONTENT_HASH}" ;;
  *) exit 9 ;;
esac
`
writeFileSync(runtimePath, runtimeSource)
chmodSync(runtimePath, 0o755)
afterAll(() => rmSync(runtimeDirectory, { recursive: true, force: true }))
const executableSha256 = sha(runtimeSource)
const runtime = { name: 'docker', version: '27.1.2', executableSha256 }

const generated = () => createEnvironmentSnapshot({
    stackId, configSha256, createdAt: observedAt, creationSource: 'resolved-config',
    intendedState: { services: ['api', 'worker'], posture: 'isolated' },
})

function stabilityPlan(batchId: string, containerId = 'synthetic', env: Readonly<Record<string, string>> = { PATH: '/usr/bin', COCKPIT_CONTENT_HASH: sha('tree') }, config = configSha256) {
    const plan = createStabilityCapturePlan({
        stackId, configSha256: config, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: executableSha256, executionMode: 'verified-path' },
        cwd: runtimeDirectory, env, containerId, batchId,
        runtime: { name: runtime.name, version: runtime.version }, contentPaths: ['/workspace/api'],
        timeoutMs: 15_000, outputLimitBytes: 4096,
    })
    if (plan.kind !== 'preview') throw new Error('synthetic stability plan must preview')
    return plan
}

async function capture(options: {
    batch?: string; container?: string; config?: string; process?: string; content?: string; stdoutPadding?: number
} = {}): Promise<ReturnType<typeof authenticateStabilityCapture>> {
    const batchId = options.batch ?? sha('capture-batch')
    const containerId = options.container ?? 'synthetic'
    const plan = stabilityPlan(batchId, containerId, {
        PATH: '/usr/bin', COCKPIT_PROCESS_IDENTITY: `${options.process ?? '777 12345'}${'x'.repeat(options.stdoutPadding ?? 0)}`,
        COCKPIT_CONTENT_HASH: options.content ?? sha('tree'),
    }, options.config)
    const results = []
    for (const step of plan.plan.steps) results.push(await executeProbe(step))
    return authenticateStabilityCapture({ plan, results })
}

async function available(options: Parameters<typeof capture>[0] = {}): Promise<CapturedRuntimeEvidence> {
    const authenticated = await capture(options)
    if ('state' in authenticated) throw new Error(authenticated.reason)
    const evidence = captureRuntimeEvidence({ capture: authenticated })
    if (evidence.state !== 'available') throw new Error(evidence.reason)
    return evidence
}

describe('environment evidence authority', () => {
    it('keeps generated intent distinct from authenticated captured facts and freezes nested inputs', async () => {
        const intendedState = { services: ['api'], nested: { posture: 'isolated' } }
        const snapshot = createEnvironmentSnapshot({ stackId, configSha256, createdAt: observedAt, creationSource: 'resolved-config', intendedState })
        intendedState.services[0] = 'changed'
        intendedState.nested.posture = 'changed'
        expect(snapshot.intendedState).toEqual({ services: ['api'], nested: { posture: 'isolated' } })
        expect(await available()).not.toHaveProperty('intendedState')
    })

    it('rejects accessors and unreadable graphs without invoking caller code', async () => {
        const base = { stackId, configSha256, createdAt: observedAt, creationSource: 'resolved-config' as const, intendedState: { service: 'safe' } }
        let stateReads = 0
        const volatile = { ...base }
        Object.defineProperty(volatile, 'intendedState', {
            enumerable: true,
            get: () => ++stateReads === 1 ? base.intendedState : { service: 'altered' },
        })
        expect(() => createEnvironmentSnapshot(volatile)).toThrow('provenance')
        expect(stateReads).toBe(0)

        const cyclic: { self?: unknown } = {}
        cyclic.self = cyclic
        expect(() => createEnvironmentSnapshot({ ...base, intendedState: cyclic as never })).toThrow('provenance')
        const revoked = Proxy.revocable(base, {})
        revoked.revoke()
        expect(() => createEnvironmentSnapshot(revoked.proxy)).toThrow('provenance')
        expect(() => createEnvironmentSnapshot({ ...base, extra: true } as never)).toThrow('provenance')
        const { intendedState: _omitted, ...missingState } = base
        expect(() => createEnvironmentSnapshot(missingState as never)).toThrow('provenance')
    })

    it('closes every evidence boundary over null, revoked, extra, and missing nested data', async () => {
        const snapshot = generated()
        const evidence = await available()
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()
        const hostile = [null, 7, {}, { ...snapshot, ignoredDecision: 'accept' }, proxy] as const

        for (const value of hostile) {
            expect(() => compareEnvironmentSnapshot(value as never, evidence, evidence)).not.toThrow()
            expect(compareEnvironmentSnapshot(value as never, evidence, evidence).verdict).toBe('unavailable')
            expect(() => compareEnvironmentSnapshot(snapshot, value as never, evidence)).not.toThrow()
            expect(compareEnvironmentSnapshot(snapshot, value as never, evidence).verdict).toBe('unavailable')
            expect(() => compareEnvironmentSnapshot(snapshot, evidence, value as never)).not.toThrow()
            expect(compareEnvironmentSnapshot(snapshot, evidence, value as never).verdict).toBe('unavailable')
            expect(() => isRuntimeEvidenceAuthentic(value as never)).not.toThrow()
            expect(isRuntimeEvidenceAuthentic(value as never)).toBe(false)
        }
        const malformedEvidence = [
            { ...evidence, runtime: null },
            { ...evidence, runtime: { ...evidence.runtime, ignoredDecision: 'accept' } },
            { ...evidence, command: { ...evidence.command, stepIds: null } },
            { state: 'unavailable', code: 'UNKNOWN', reason: 'synthetic' },
        ] as const
        for (const value of malformedEvidence) {
            expect(() => compareEnvironmentSnapshot(snapshot, value as never, evidence)).not.toThrow()
            expect(compareEnvironmentSnapshot(snapshot, value as never, evidence).verdict).toBe('unavailable')
            expect(() => isRuntimeEvidenceAuthentic(value as never)).not.toThrow()
            expect(isRuntimeEvidenceAuthentic(value as never)).toBe(false)
        }
        expect(() => captureRuntimeEvidence(null as never)).not.toThrow()
        expect(captureRuntimeEvidence(null as never).state).toBe('unavailable')
        expect(() => captureRuntimeEvidence({ capture: evidence, ignoredDecision: 'accept' } as never)).not.toThrow()
        expect(captureRuntimeEvidence({ capture: evidence, ignoredDecision: 'accept' } as never).state).toBe('unavailable')
        expect(() => captureRuntimeEvidence({ capture: proxy } as never)).not.toThrow()
        expect(captureRuntimeEvidence({ capture: proxy } as never).state).toBe('unavailable')
        expect(() => createEnvironmentSnapshot(null as never)).toThrow('environment snapshot provenance is invalid')
        expect(() => createEnvironmentSnapshot({ ...snapshot, intendedState: undefined } as never)).toThrow('environment snapshot provenance is invalid')
    })

    it('rejects oversized evidence before reading its entries', async () => {
        const evidence = await available()
        const oversized = Array(4_097).fill('safe')
        let reads = 0
        Object.defineProperty(oversized, 0, { enumerable: true, get: () => { reads += 1; return 'unsafe' } })
        const snapshot = { ...generated(), intendedState: oversized }

        expect(compareEnvironmentSnapshot(snapshot as never, evidence, evidence).verdict).toBe('unavailable')
        expect(reads).toBe(0)
    })

    it('constructs exact bounded steps bound to one runtime cohort and freezes the outcome', () => {
        const batchId = sha('plan-batch')
        const plan = createStabilityCapturePlan({
            stackId, configSha256, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: executableSha256, executionMode: 'verified-path' as const }, cwd: runtimeDirectory,
            env: { PATH: '/usr/bin' }, containerId: 'synthetic-api-1', batchId,
            runtime: { name: 'docker', version: '27.1.2' }, contentPaths: ['/workspace/api', '/workspace/shared'], timeoutMs: 15_000, outputLimitBytes: 4096,
        })
        expect(plan.kind).toBe('preview')
        if (plan.kind !== 'preview') return
        expect(plan.plan.steps).toHaveLength(2)
        expect(plan.plan.steps[0]).toEqual(expect.objectContaining({
            id: 'evidence:process-identity:synthetic-api-1',
            argv: [runtimePath, 'exec', '--', 'synthetic-api-1', '/bin/sh', '-eu', '-c', expect.stringContaining('/proc/1/stat')],
            labels: expect.objectContaining({ stackId, configSha256, batchId, runtimeName: 'docker', runtimeVersion: '27.1.2', executableSha256, evidenceRole: 'process-identity' }),
            timeoutMs: 15_000, stdoutLimitBytes: 4096, stderrLimitBytes: 4096,
        }))
        expect(plan.plan.steps[0].argv.join(' ')).toContain('${20}')
        expect(plan.plan.steps[1].argv).toEqual([runtimePath, 'exec', '--', 'synthetic-api-1', '/bin/sh', '-eu', '-c', expect.stringContaining('sha256sum'), 'cockpit-content-hash', '/workspace/api', '/workspace/shared'])
        expect(plan.plan.steps[1].argv[7]).toContain('find -H "$@"')
        expect(plan.plan.steps[1].argv[7]).not.toContain(' | ')
        expect(plan.plan.steps[1].argv[7]).toContain('[ -s "$tmp.raw" ]')
    })

    it('rejects capture-plan accessors without invoking caller code', () => {
        const request = {
            stackId, configSha256, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: executableSha256, executionMode: 'verified-path' as const }, cwd: runtimeDirectory,
            env: { PATH: '/usr/bin' }, containerId: 'synthetic-api-1', batchId: sha('snapshot-plan'),
            runtime: { name: 'docker', version: '27.1.2' }, contentPaths: ['/workspace/api'], timeoutMs: 1000, outputLimitBytes: 1024,
        }
        let reads = 0
        Object.defineProperty(request, 'containerId', { enumerable: true, get: () => ++reads === 1 ? 'synthetic-api-1' : 'altered' })
        const plan = createStabilityCapturePlan(request)
        expect(plan.kind).toBe('refusal')
        expect(reads).toBe(0)
    })

    it('refuses malformed capture-plan inputs without dereferencing missing authority', () => {
        const valid = {
            stackId, configSha256, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: executableSha256, executionMode: 'verified-path' }, cwd: runtimeDirectory,
            env: { PATH: '/usr/bin' }, containerId: 'synthetic-api-1', batchId: sha('strict-plan'),
            runtime: { name: 'docker', version: '27.1.2' }, contentPaths: ['/workspace/api'], timeoutMs: 1000, outputLimitBytes: 1024,
        }
        const malformed = [
            {},
            { ...valid, runtimeExecutable: {} },
            { ...valid, runtime: {} },
            { ...valid, ignoredDecision: 'accept' },
            { ...valid, runtimeExecutable: { ...valid.runtimeExecutable, ignoredDecision: 'accept' } },
            { ...valid, runtimeExecutable: { ...valid.runtimeExecutable, invocationPath: 'docker' } },
        ]

        for (const input of malformed) {
            expect(() => createStabilityCapturePlan(input as never)).not.toThrow()
            expect(createStabilityCapturePlan(input as never).kind).toBe('refusal')
        }
    })

    it('refuses a partial content corpus when one member cannot be hashed', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-content-control-'))
        const bin = join(directory, 'bin')
        const corpus = join(directory, 'corpus')
        mkdirSync(bin)
        mkdirSync(corpus)
        writeFileSync(join(corpus, 'a-good'), 'safe')
        writeFileSync(join(corpus, 'z-unreadable'), 'unreadable')
        const fakeHash = join(bin, 'sha256sum')
        writeFileSync(fakeHash, `#!/bin/sh
for value do
  [ "$value" = -- ] && continue
  case "$value" in *z-unreadable) exit 9;; esac
  printf '${sha('member')}  %s\\n' "$value"
done
`)
        chmodSync(fakeHash, 0o755)
        const plan = stabilityPlan(sha('unreadable-control'))
        const contentStep = plan.plan.steps[1]

        const outcome = await executeProbe({
            ...contentStep,
            argv: ['/bin/sh', '-eu', '-c', contentStep.argv[7], 'content-control', corpus],
            env: { PATH: `${bin}:/usr/bin:/bin` }, consumedFiles: [], filesystemChecks: [],
        })
        rmSync(directory, { recursive: true, force: true })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', code: 'EXECUTION_STEP_FAILED' }))
    })

    it('hashes a content path that is a symlink to the file, as /proc/1/exe is', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-content-symlink-'))
        const target = join(directory, 'init')
        const exe = join(directory, 'exe')
        writeFileSync(target, 'synthetic init binary')
        symlinkSync(target, exe)
        const contentStep = stabilityPlan(sha('symlink-control')).plan.steps[1]

        const outcome = await executeProbe({
            ...contentStep,
            argv: ['/bin/sh', '-eu', '-c', contentStep.argv[7], 'content-control', exe],
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, consumedFiles: [], filesystemChecks: [],
        })
        rmSync(directory, { recursive: true, force: true })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete' }))
        if (outcome.kind !== 'complete') return
        expect(new TextDecoder().decode(outcome.stdout)).toMatch(/^[a-f0-9]{64} /)
    })

    it.each([
        ['unsafe container', { containerId: '--privileged' }],
        ['relative content', { contentPaths: ['../host'] }],
        ['empty content', { contentPaths: [] }],
        ['decision environment', { env: { COMPOSE_PROJECT_NAME: 'other' } }],
        ['unresolved environment', { env: { PATH: '$UNRESOLVED' } }],
        ['NUL environment', { env: { PATH: 'safe\0hidden' } }],
    ])('refuses %s before execution', (_label, patch) => {
        const result = createStabilityCapturePlan({
            stackId, configSha256, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: executableSha256, executionMode: 'verified-path' },
            cwd: runtimeDirectory, env: {}, containerId: 'synthetic', batchId: sha('batch'),
            runtime: { name: runtime.name, version: runtime.version }, contentPaths: ['/workspace/api'],
            timeoutMs: 1000, outputLimitBytes: 1024, ...patch,
        })
        expect(result.kind).toBe('refusal')
    })

    it('rejects output-limit refusal before captured evidence exists', async () => {
        expect(await capture({ stdoutPadding: 5000 })).toEqual(expect.objectContaining({ state: 'unavailable', code: 'EXECUTION_STDOUT_LIMIT' }))
    })

    it('rejects results relabelled by authenticating them against another plan', async () => {
        const original = stabilityPlan(sha('original'))
        const results = []
        for (const step of original.plan.steps) results.push(await executeProbe(step))
        const relabelled = stabilityPlan(sha('other'))
        expect(authenticateStabilityCapture({ plan: relabelled, results })).toEqual(expect.objectContaining({ state: 'unavailable' }))
    })

    it('turns missing, refused, and host-constructed capture data into unavailable evidence', async () => {
        const batchId = sha('missing-control')
        const plan = stabilityPlan(batchId)
        expect(authenticateStabilityCapture({ plan, results: [] })).toEqual(expect.objectContaining({ state: 'unavailable' }))
        const refused = await executeProbe({ ...plan.plan.steps[0], argv: [process.execPath, '-e', 'process.exit(1)'], consumedFiles: [], filesystemChecks: [] })
        expect(authenticateStabilityCapture({ plan, results: [refused, refused] })).toEqual(expect.objectContaining({ state: 'unavailable', code: 'EVIDENCE_UNAVAILABLE' }))
        const controller = new AbortController()
        controller.abort()
        const authenticRefusals = await Promise.all(plan.plan.steps.map((step) => executeProbe(step, { signal: controller.signal })))
        expect(authenticateStabilityCapture({ plan, results: authenticRefusals })).toEqual(expect.objectContaining({ state: 'unavailable', code: 'EXECUTION_ABORTED' }))
        expect(authenticateStabilityCapture({ plan, results: authenticRefusals.map((result) => ({ ...result })) })).toEqual(expect.objectContaining({ state: 'unavailable', code: 'EVIDENCE_UNAVAILABLE' }))
        const hostConstructed = JSON.parse(JSON.stringify(await capture())) as AuthenticatedStabilityCapture
        expect(captureRuntimeEvidence({ capture: hostConstructed })).toEqual(expect.objectContaining({ state: 'unavailable' }))
        const authentic = await capture()
        if ('state' in authentic) throw new Error(authentic.reason)
        const first = captureRuntimeEvidence({ capture: authentic })
        expect(first).toEqual(expect.objectContaining({ state: 'available' }))
        expect(captureRuntimeEvidence({ capture: authentic })).toEqual(first)
        const copied = { ...authentic }
        expect(captureRuntimeEvidence({ capture: copied })).toEqual(expect.objectContaining({ state: 'unavailable' }))
    })

    it('refuses malformed capture authentication inputs before copying result entries', () => {
        const plan = stabilityPlan(sha('strict-authentication'))
        const oversized = Array(100_000).fill(null)
        let entryReads = 0
        Object.defineProperty(oversized, 0, { enumerable: true, get: () => { entryReads += 1; return null } })
        const inputs = [
            {},
            { plan: {}, results: [] },
            { plan: { ...plan, ignoredDecision: 'accept' }, results: [] },
            { plan: { ...plan, plan: { ...plan.plan, ignoredDecision: 'accept' } }, results: [] },
            { plan, results: [null, null] },
            { plan, results: oversized },
        ]

        for (const input of inputs) {
            expect(() => authenticateStabilityCapture(input as never)).not.toThrow()
            expect(authenticateStabilityCapture(input as never)).toEqual(expect.objectContaining({ state: 'unavailable' }))
        }
        expect(entryReads).toBe(0)
    })

    it('refuses extra capture authentication fields', async () => {
        const plan = stabilityPlan(sha('hostile-authentication'))
        const genuineResults = []
        for (const step of plan.plan.steps) genuineResults.push(await executeProbe(step))
        expect(authenticateStabilityCapture({ plan, results: genuineResults, ignoredDecision: 'accept' } as never))
            .toEqual(expect.objectContaining({ state: 'unavailable' }))
        expect(authenticateStabilityCapture({ plan, results: genuineResults })).not.toHaveProperty('state')
    })

    it('requires one exact invocation identity across authenticated capture steps', async () => {
        const plan = stabilityPlan(sha('invocation-cohort'))
        const results = []
        for (const step of plan.plan.steps) results.push(await executeProbe(step))
        const altered = {
            ...plan,
            plan: { steps: [plan.plan.steps[0], { ...plan.plan.steps[1], argv0: '/usr/local/bin/other-runtime' }] },
        }

        expect(authenticateStabilityCapture({ plan: altered as typeof plan, results })).toEqual(expect.objectContaining({ state: 'unavailable' }))
    })

    it('rejects normalized impossible calendar dates', () => {
        expect(() => createEnvironmentSnapshot({
            stackId, configSha256, createdAt: '2026-02-30T12:00:00.000Z', creationSource: 'resolved-config', intendedState: {},
        })).toThrow('provenance')
    })

    it.each([
        ['process restart', { process: '888 54321' }],
        ['content movement', { content: sha('changed-tree') }],
    ] as const)('returns void for %s without mutating inputs', async (_label, changed) => {
        const before = await available({ batch: sha('before') })
        const after = await available({ batch: sha('after'), ...changed })
        const serialized = JSON.stringify({ before, after })
        const result = compareEnvironmentSnapshot(generated(), before, after)
        expect(result).toEqual(expect.objectContaining({ verdict: 'void' }))
        expect(JSON.stringify({ before, after })).toBe(serialized)
    })

    it('accepts only distinct ordered stable batches and rejects replay or reversed chronology', async () => {
        const before = await available({ batch: sha('before') })
        const after = await available({ batch: sha('after') })
        expect(compareEnvironmentSnapshot(generated(), before, after)).toEqual({ verdict: 'stable', processIdentity: 'unchanged', contentHash: 'unchanged', diagnostics: [] })
        expect(compareEnvironmentSnapshot(generated(), before, before).verdict).toBe('unavailable')
        expect(compareEnvironmentSnapshot(generated(), after, before).verdict).toBe('unavailable')
    })

    it('returns stale when configuration authority changes', async () => {
        const before = await available({ batch: sha('before') })
        const after = await available({ batch: sha('after'), config: sha('new-config') })
        expect(compareEnvironmentSnapshot(generated(), before, after)).toEqual(expect.objectContaining({ verdict: 'stale' }))
    })

    it('never retains secret-bearing runtime bytes or sensitive intended values', async () => {
        const canary = 'runtime-secret-canary'
        const snapshot = createEnvironmentSnapshot({ stackId, configSha256, createdAt: observedAt, creationSource: 'resolved-config', intendedState: { API_TOKEN: canary, Authorization: `Bearer ${canary}`, passwd: canary, PRIVATE_KEY: canary, note: `token=${canary}` } })
        const rendered = JSON.stringify({ snapshot, evidence: await capture({ process: canary }) })
        expect(rendered).not.toContain(canary)
        expect(rendered).toContain('[redacted]')
    })

    it.each([
        ['password=correct-horse battery-staple', ['correct-horse', 'battery-staple']],
        ['Authorization: Bearer auth-alpha auth-beta', ['auth-alpha', 'auth-beta']],
        ['token=comma-alpha,comma-beta', ['comma-alpha', 'comma-beta']],
        ['secret=semi-alpha;semi-beta', ['semi-alpha', 'semi-beta']],
        ['credential=multi-alpha multi-beta,multi-gamma;multi-delta', ['multi-alpha', 'multi-beta', 'multi-gamma', 'multi-delta']],
    ])('removes the full unstructured secret remainder from snapshots: %s', (note, canaries) => {
        const snapshot = createEnvironmentSnapshot({
            stackId, configSha256, createdAt: observedAt, creationSource: 'resolved-config', intendedState: { note },
        })

        const rendered = JSON.stringify(snapshot)

        for (const canary of canaries) expect(rendered).not.toContain(canary)
        expect(rendered).toContain('[redacted]')
    })

    it('refuses capture input that cannot cross the strict execution boundary', () => {
        expect(createStabilityCapturePlan({
            stackId, configSha256, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: executableSha256, executionMode: 'verified-path' },
            cwd: runtimeDirectory, env: { 'BAD=KEY': 'value' }, containerId: 'synthetic', batchId: sha('invalid-env'),
            runtime, contentPaths: ['/workspace'], timeoutMs: 15_000, outputLimitBytes: 4096,
        }).kind).toBe('refusal')
        expect(createStabilityCapturePlan({
            stackId, configSha256, runtimeExecutable: { canonicalPath: runtimePath, invocationPath: '/tmp/not-docker', sha256: executableSha256, executionMode: 'verified-path' },
            cwd: runtimeDirectory, env: {}, containerId: 'synthetic', batchId: sha('invalid-runtime-name'),
            runtime, contentPaths: ['/workspace'], timeoutMs: 15_000, outputLimitBytes: 4096,
        }).kind).toBe('refusal')
    })
})
