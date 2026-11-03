import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CheckoutId, type StackId } from './contract.js'
import { executeProbe } from '../environment-exec/execute.js'
import { resolveGitExecutable } from './executable.js'
import { resolvedExecutable } from './executable.js'
import { observationSatisfiesExpectation } from './observations.js'
import { loadCockpitConfig } from '../config/load.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'
import { syncGeneratedEnvironment } from './generated-application.js'
import { observeSetupCheckout, withSetupCheckoutProjection } from './setup-observation.js'
import { createHash } from 'node:crypto'
import { cockpitId, checkoutId as deriveCheckoutId, stackId as deriveStackId } from './identity.js'
import { admitRuntimeTopology, createRuntimeAdapter, createRuntimeTopologyPlan } from './runtime.js'
import {
    createComparisonRemoteRefStep,
    createGitAncestryObservationStep,
    createGitObservationStep,
    observeComparisonRemoteRef,
    observeComparisonRemoteRevalidation,
    observeComparisonRemoteUrl,
    decodeGitObservation,
    inspectTrackedSecretFiles,
    observeGit,
    observeGitAncestry,
    observeRunningCheckout,
} from './git-observation.js'

const stackId = `stack:${'4'.repeat(64)}` as StackId
const checkoutId = `checkout:${'6'.repeat(64)}` as CheckoutId
const observedAt = '2026-09-08T02:00:00.000Z'
const revision = 'a'.repeat(40)
const context = { stackId, observedAt, source: '/workspace/service', checkoutRoot: '/workspace' }

function decode(lines: string) {
    return decodeGitObservation(Buffer.from(lines.replaceAll('abcdef', revision)), context)
}

describe('Git adjacency evidence', () => {
    it.each([
        ['# branch.oid abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n', 'clean', 'aligned'],
        ['# branch.oid abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n', 'clean', 'ahead'],
        ['# branch.oid abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -3\n', 'clean', 'behind'],
        ['# branch.oid abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n', 'clean', 'diverged'],
        ['# branch.oid abcdef\n# branch.head main\n1 .M N... 100644 100644 100644 a b file.ts\n', 'dirty', 'untracked-upstream'],
        ['# branch.oid abcdef\n# branch.head main\n? new.ts\n', 'untracked', 'untracked-upstream'],
    ])('distinguishes neighboring states', (source, workingTree, adjacency) => {
        expect(decode(source)).toMatchObject({ kind: 'complete', evidence: { workingTree, adjacency } })
    })

    it('refuses malformed UTF-8 and unbounded output', () => {
        expect(decodeGitObservation(Buffer.from([0xff]), context)).toMatchObject({ kind: 'unavailable' })
        expect(decodeGitObservation(Buffer.alloc(65_537, 0x61), context)).toMatchObject({ kind: 'unavailable' })
        expect(decodeGitObservation(Buffer.from(`# branch.oid ${revision}\n# branch.head ${'é'.repeat(600)}\n`), context)).toMatchObject({ kind: 'unavailable' })
    })

    it('rejects duplicate identity and adjacency headers', () => {
        expect(decode('# branch.oid one\n# branch.oid two\n# branch.head main\n')).toMatchObject({ kind: 'unavailable' })
        expect(decode('# branch.oid one\n# branch.head main\n# branch.ab +0 -0\n# branch.ab +0 -0\n')).toMatchObject({ kind: 'unavailable' })
    })

    it('observes a repository with no commits yet as one failed working tree with the commands that commit it', () => {
        const result = decode('# branch.oid (initial)\n# branch.head main\n1 A. N... 000000 100644 100644 0 b cockpit.toml\n? AGENTS.md\n')
        expect(result).toMatchObject({ kind: 'complete', evidence: { revision: null, branch: 'main', trackedDirtyCount: 1, untrackedCount: 1 } })
        if (result.kind !== 'complete') throw new Error('unborn Git evidence is unavailable')
        const [workingTree, adjacency] = result.observations
        expect(workingTree).toMatchObject({
            code: 'GIT_STATE_UNHEALTHY',
            observed: { state: 'failed', reason: expect.stringContaining('/workspace has no commits yet') },
            remedy: expect.stringContaining('`git -C /workspace add -A && git -C /workspace commit -m \'Add the cockpit\'`'),
        })
        expect(observationSatisfiesExpectation(workingTree!)).toBe(false)
        expect(adjacency).toMatchObject({ observed: { state: 'available', value: { revision: null, adjacency: 'untracked-upstream' } } })
        expect(observationSatisfiesExpectation(adjacency!)).toBe(true)
    })

    it('accepts only a bounded outcome issued for the resolved Git step', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-git-health-'))
        try {
            execFileSync('git', ['init', '-b', 'main'], { cwd: root })
            await writeFile(join(root, 'tracked.txt'), 'stable\n')
            execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root })
            const resolved = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            expect(resolved.state).toBe('available')
            if (resolved.state !== 'available') return
            const step = createGitObservationStep({ executable: resolved.value, checkoutRoot: root, env: {}, timeoutMs: 10_000, stackId, source: root, checkoutId })
            expect(step).toBeDefined()
            if (!step) return
            const outcome = await executeProbe(step)
            expect(observeGit(step, outcome, { stackId, checkoutId, source: root })).toMatchObject({
                kind: 'complete', evidence: { workingTree: 'clean' },
            })
            const local = observeGit(step, outcome, { stackId, checkoutId, source: root })
            expect(local).toMatchObject({ kind: 'complete', evidence: { upstream: null, adjacency: 'untracked-upstream' } })
            if (local.kind !== 'complete') throw new Error('local Git evidence is unavailable')
            const adjacency = local.observations.find(({ code }) => code === 'CHECKOUT_ADJACENCY_UNHEALTHY')!
            expect(adjacency.observed).toMatchObject({ state: 'available', value: { upstream: null, adjacency: 'untracked-upstream' } })
            expect(observationSatisfiesExpectation(adjacency)).toBe(true)
            execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/synthetic.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=origin/main'], { cwd: root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'ahead'], { cwd: root })
            const ahead = observeGit(step, await executeProbe(step), { stackId, checkoutId, source: root })
            expect(ahead).toMatchObject({ kind: 'complete', evidence: { upstream: 'origin/main', adjacency: 'ahead' } })
            if (ahead.kind !== 'complete') throw new Error('selected upstream evidence is unavailable')
            expect(observationSatisfiesExpectation(ahead.observations.find(({ code }) => code === 'CHECKOUT_ADJACENCY_UNHEALTHY')!)).toBe(false)
            execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: root })
            const gone = observeGit(step, await executeProbe(step), { stackId, checkoutId, source: root })
            expect(gone).toMatchObject({ kind: 'complete', evidence: { upstream: 'origin/main', adjacency: 'upstream-gone' } })
            if (gone.kind !== 'complete') throw new Error('gone upstream evidence is unavailable')
            const goneAdjacency = gone.observations.find(({ code }) => code === 'CHECKOUT_ADJACENCY_UNHEALTHY')!
            expect(observationSatisfiesExpectation(goneAdjacency)).toBe(false)
            expect(goneAdjacency.remedy).toContain(`git -C ${root} branch --unset-upstream`)
            expect(observeGit(step, { ...outcome }, { stackId, checkoutId, source: root })).toEqual({
                kind: 'unavailable', reason: 'Git execution evidence is unavailable or unauthenticated',
            })
            expect(observeGit(step, outcome, { stackId: `stack:${'9'.repeat(64)}` as StackId, checkoutId, source: `${root}-other` }))
                .toMatchObject({ kind: 'unavailable' })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('keeps repository controls out of the observation process', async () => {
        const first = await mkdtemp(join(tmpdir(), 'cockpit-git-first-'))
        const second = await mkdtemp(join(tmpdir(), 'cockpit-git-second-'))
        try {
            execFileSync('git', ['init', '-b', 'main'], { cwd: first })
            execFileSync('git', ['init', '-b', 'other'], { cwd: second })
            for (const root of [first, second]) {
                await writeFile(join(root, 'tracked.txt'), `${root === first ? 'first' : 'second'}\n`)
                execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
                execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root })
            }
            const resolved = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            expect(resolved.state).toBe('available')
            if (resolved.state !== 'available') return
            expect(createGitObservationStep({
                executable: resolved.value,
                checkoutRoot: first,
                env: { GIT_DIR: join(second, '.git') },
                timeoutMs: 10_000,
                stackId, source: first, checkoutId,
            })).toBeUndefined()
            const valid = createGitObservationStep({ executable: resolved.value, checkoutRoot: first, env: {}, timeoutMs: 10_000, stackId, source: first, checkoutId })
            expect(valid).toBeDefined()
            if (!valid) return
            const result = observeGit(valid, await executeProbe(valid), { stackId, checkoutId, source: first })
            expect(result).toMatchObject({ kind: 'complete', evidence: { branch: 'main' } })
            if (result.kind === 'complete') {
                expect(result.evidence.revision).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: first, encoding: 'utf8' }).trim())
                expect(result.evidence.revision).not.toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: second, encoding: 'utf8' }).trim())
            }
        } finally {
            await rm(first, { recursive: true, force: true })
            await rm(second, { recursive: true, force: true })
        }
    })

    it('admits ancestry only from the exact issued clean status and merge-base outcome', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-git-ancestry-'))
        try {
            execFileSync('git', ['init', '-b', 'main'], { cwd: root })
            await writeFile(join(root, 'tracked.txt'), 'base\n')
            execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], { cwd: root })
            const ancestor = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
            await writeFile(join(root, 'tracked.txt'), 'current\n')
            execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'current'], { cwd: root })
            const executable = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            expect(executable.state).toBe('available')
            if (executable.state !== 'available') return
            const statusStep = createGitObservationStep({ executable: executable.value, checkoutRoot: root, env: {},
                timeoutMs: 10_000, stackId, source: root, checkoutId })
            if (!statusStep) throw new Error('Git status step unavailable')
            const status = observeGit(statusStep, await executeProbe(statusStep), { stackId, checkoutId, source: root })
            const ancestryStep = createGitAncestryObservationStep({ git: status, ancestor })
            expect(ancestryStep).toBeDefined()
            if (!ancestryStep) return
            const outcome = await executeProbe(ancestryStep)
            expect(observeGitAncestry(ancestryStep, outcome)).toBeDefined()
            expect(observeGitAncestry({ ...ancestryStep } as never, outcome)).toBeUndefined()
            expect(createGitAncestryObservationStep({ git: { ...status } as never, ancestor })).toBeUndefined()
            const unrelated = 'f'.repeat(40)
            const refusedStep = createGitAncestryObservationStep({ git: status, ancestor: unrelated })
            expect(refusedStep).toBeDefined()
            if (refusedStep) expect(observeGitAncestry(refusedStep, await executeProbe(refusedStep))).toBeUndefined()
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('keeps exact dirty counts and repository identity in both observations', () => {
        const result = decode('# branch.oid abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n1 .M N... 100644 100644 100644 a b file.ts\n? new.ts\n')
        expect(result).toMatchObject({
            kind: 'complete',
            evidence: { trackedDirtyCount: 1, untrackedCount: 1 },
            observations: [
                { observed: { value: { revision, branch: 'main', trackedDirtyCount: 1, untrackedCount: 1 } },
                    remedy: expect.stringContaining('`git -C /workspace status --short`') },
                { observed: { value: { revision, branch: 'main', adjacency: 'aligned' } } },
            ],
        })
    })

    it('authenticates running topology against the current checkout and its runtime declarations', async () => {
        const support = createGeneratedCommandFixture()
        try {
            const candidate = await support.consumer('running-checkout')
            execFileSync('git', ['init', '-b', 'main'], { cwd: candidate.root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: candidate.root })
            const published = await syncGeneratedEnvironment({ configPath: candidate.configPath })
            if (published.kind !== 'complete') throw new Error(JSON.stringify(published.diagnostics))
            const runtime = await support.generatedRuntime(candidate.root, published.result.application)
            const executable = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            if (executable.state !== 'available') throw new Error('fixture Git executable unavailable')
            const observe = async (topology = runtime.topology, configPath = candidate.configPath, copiedCheckout = false) => {
                const loaded = await loadCockpitConfig(configPath)
                if (loaded.kind !== 'complete') throw new Error('fixture configuration unavailable')
                const observedAt = new Date().toISOString()
                const checkout = await observeSetupCheckout({ source: loaded.result.source,
                    cockpitName: loaded.result.config.cockpit.name, observedAt, env: {}, gitExecutable: executable.value })
                return withSetupCheckoutProjection(checkout, { source: loaded.result.source,
                    cockpitName: loaded.result.config.cockpit.name, evaluatedAt: Date.parse(observedAt) },
                projection => observeRunningCheckout(topology, copiedCheckout ? { ...projection } : projection, loaded.result.runtimeSha256, new Date().toISOString()))
            }
            const current = await observe()
            expect(current).toMatchObject({ kind: 'complete' })
            if (current?.kind !== 'complete') throw new Error('running checkout observation unavailable')
            expect(observationSatisfiesExpectation(current.observation)).toBe(true)
            expect(await observe({ ...runtime.topology })).toMatchObject({ kind: 'unavailable' })
            expect(await observe(runtime.topology, candidate.configPath, true)).toMatchObject({ kind: 'unavailable' })
            const foreign = await support.consumer('foreign-running-checkout')
            execFileSync('git', ['init', '-b', 'main'], { cwd: foreign.root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: foreign.root })
            const foreignResult = await observe(runtime.topology, foreign.configPath)
            expect(foreignResult).toMatchObject({ kind: 'complete' })
            if (foreignResult?.kind !== 'complete') throw new Error('foreign checkout comparison unavailable')
            expect(observationSatisfiesExpectation(foreignResult.observation)).toBe(false)
            const declared = await readFile(candidate.configPath, 'utf8')
            await writeFile(candidate.configPath, `${declared}\n# reworded comment\n`)
            const commented = await observe()
            if (commented?.kind !== 'complete') throw new Error('commented configuration comparison unavailable')
            expect(observationSatisfiesExpectation(commented.observation)).toBe(true)
            await writeFile(candidate.configPath, declared.replace('APP_HOST_PORT = 4100', 'APP_HOST_PORT = 4200'))
            const changed = await observe()
            expect(changed).toMatchObject({ kind: 'complete' })
            if (changed?.kind !== 'complete') throw new Error('changed configuration comparison unavailable')
            expect(observationSatisfiesExpectation(changed.observation)).toBe(false)
            const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(runtime.topology.observationWindow.expiresAt) + 1)
            try { expect(await observe()).toMatchObject({ kind: 'unavailable' }) }
            finally { clock.mockRestore() }
        } finally { await support.cleanup() }
    })


    it('accepts a nested configuration cwd and refuses a different authenticated runtime cwd', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-nested-runtime-checkout-')))
        try {
            const nested = join(root, 'cockpit')
            await mkdir(nested)
            execFileSync('git', ['init', '-b', 'main'], { cwd: root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: root })
            const configPath = join(nested, 'cockpit.toml')
            await writeFile(configPath, '[cockpit]\nname = "synthetic"\n[[sibling]]\nslug = "api"\ndir = "."\nvar = "API_DIR"\nmount = "none"\nacquire = "none"\npurpose = "Synthetic service"\n[ports]\nbases = {}\n')
            const loaded = await loadCockpitConfig(configPath)
            if (loaded.kind !== 'complete') throw new Error('nested fixture config unavailable')
            const currentStack = deriveStackId({ cockpitId: cockpitId({ name: 'synthetic', mainCheckoutPath: root }),
                checkoutId: deriveCheckoutId({ checkoutPath: root }), variant: { kind: 'shared' } })
            const sourceSha256 = loaded.result.runtimeSha256
            const labels = { 'dev.b0dea.cockpit.stack-id': currentStack, 'dev.b0dea.cockpit.config-sha256': sourceSha256 }
            const probe = join(root, 'docker')
            const body = `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ services: { api: { labels, healthcheck: { test: ['CMD', 'true'] } } } }))})\n`
            await writeFile(probe, body); await chmod(probe, 0o755)
            const executable = resolvedExecutable({ canonicalPath: probe, invocationPath: probe,
                sha256: createHash('sha256').update(body).digest('hex'), executionMode: 'verified-path' })!
            const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            if (git.state !== 'available') throw new Error('nested fixture Git unavailable')
            for (const cwd of [nested, root]) {
                const composePath = join(cwd, 'compose.yml')
                const source = 'services: {}\n'
                await writeFile(composePath, source)
                const batchId = 'a'.repeat(64)
                const runtime = createRuntimeAdapter({
                    runtime: { name: 'docker', version: '27.1.2', executableSha256: executable.sha256 },
                    composeVersion: '2.39.2', executable, operation: 'validate', cwd,
                    composeFiles: [{ reference: 'compose.yml', canonicalPath: composePath, source, sha256: createHash('sha256').update(source).digest('hex') }],
                    projectName: 'synthetic', env: {}, ports: [], labels: { stackId: currentStack, configSha256: sourceSha256, batchId },
                    timeoutMs: 5_000, stackId: currentStack, coldStartLimitMillis: 30_000, expectedMountSources: [],
                })
                if (runtime.kind !== 'preview') throw new Error(JSON.stringify(runtime.diagnostics))
                const plan = createRuntimeTopologyPlan({ runtimePlan: runtime.plan, stackId: currentStack,
                    configSha256: sourceSha256, batchId,
                    observationWindow: { startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } })
                if (plan.kind !== 'planned') throw new Error(plan.reason)
                const topology = admitRuntimeTopology({ plan, outcome: await executeProbe(plan.step) })
                if (topology.kind !== 'complete') throw new Error(topology.reason)
                const observedAt = new Date().toISOString()
                const checkout = await observeSetupCheckout({ source: loaded.result.source, cockpitName: 'synthetic',
                    observedAt, env: {}, gitExecutable: git.value })
                const result = await withSetupCheckoutProjection(checkout, { source: loaded.result.source,
                    cockpitName: 'synthetic', evaluatedAt: Date.parse(observedAt) },
                projection => observeRunningCheckout(topology.topology, projection, loaded.result.runtimeSha256, new Date().toISOString()))
                expect(result).toMatchObject({ kind: 'complete' })
                if (result?.kind !== 'complete') throw new Error('nested running checkout comparison unavailable')
                expect(observationSatisfiesExpectation(result.observation), JSON.stringify(result)).toBe(cwd === nested)
            }
        } finally { await rm(root, { recursive: true, force: true }) }
    })

})

describe('comparison remote identity evidence', () => {
    async function fixture() {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-comparison-remote-'))
        execFileSync('git', ['init', '-b', 'main'], { cwd: root })
        await writeFile(join(root, 'tracked.txt'), 'stable\n')
        execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root })
        const resolved = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
        if (resolved.state !== 'available') throw new Error('Git unavailable in comparison fixture')
        return { root, executable: resolved.value }
    }

    async function status(root: string, executable: Awaited<ReturnType<typeof fixture>>['executable']) {
        const step = createGitObservationStep({ executable, checkoutRoot: root, env: {}, timeoutMs: 10_000, stackId, source: root, checkoutId })
        if (!step) throw new Error('Git status step unavailable')
        const result = observeGit(step, await executeProbe(step), { stackId, checkoutId, source: root })
        if (result.kind !== 'complete') throw new Error('Git status observation unavailable')
        return result
    }

    async function compare(input: {
        root: string
        executable: Awaited<ReturnType<typeof fixture>>['executable']
        declaredRemote?: string
        acquire?: 'auto' | 'manual' | 'none'
    }) {
        const observed = input.declaredRemote === undefined
            ? undefined
            : await status(input.root, input.executable)
        const started = createComparisonRemoteRefStep({
            executable: input.executable, checkoutRoot: input.root, env: {}, timeoutMs: 10_000,
            stackId, checkoutId, source: input.root, sibling: 'service',
            acquire: input.acquire ?? 'manual', declaredRemote: input.declaredRemote, git: observed,
        })
        if (started.kind !== 'probe') return started
        const selected = observeComparisonRemoteRef(started, await executeProbe(started.step))
        if (selected.kind !== 'probe') return selected
        const validated = observeComparisonRemoteUrl(selected, await executeProbe(selected.step))
        if (validated.kind !== 'probe') return validated
        return observeComparisonRemoteRevalidation(validated, await executeProbe(validated.step))
    }

    it('fails the selected wrong fork even when an unused remote matches the declaration', async () => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'origin', 'https://code.invalid/other/service.git'], { cwd: root })
            execFileSync('git', ['remote', 'add', 'upstream', 'git@code.invalid:team/service.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: root })

            expect(await compare({ root, executable, declaredRemote: 'https://code.invalid/team/service.git' })).toEqual({
                kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'mismatch', remoteName: 'origin',
                reason: 'comparison remote origin does not match the declared repository for sibling service',
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('accepts a configured non-origin upstream and equivalent supported transports', async () => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'origin', 'https://code.invalid/other/service.git'], { cwd: root })
            execFileSync('git', ['remote', 'add', 'upstream', 'ssh://git@code.invalid/team/service.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/upstream/trunk-α', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=upstream/trunk-α', 'main'], { cwd: root })

            expect(await compare({ root, executable, declaredRemote: 'https://CODE.INVALID:443/team/service.git' })).toEqual({
                kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'match', remoteName: 'upstream',
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each([
        ['HTTPS declaration and SSH observation', 'https://CODE.INVALID:443/service.git', 'ssh://git@code.invalid/service.git'],
        ['SSH declaration and SCP observation', 'ssh://git@code.invalid/service.git', 'git@code.invalid:service.git'],
        ['SCP declaration and HTTPS observation', 'git@code.invalid:service.git', 'https://code.invalid/service.git'],
    ])('accepts a selected host-root remote across %s', async (_label, declaredRemote, observedRemote) => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'upstream', observedRemote], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=upstream/main', 'main'], { cwd: root })

            expect(await compare({ root, executable, declaredRemote })).toEqual({
                kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'match', remoteName: 'upstream',
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('keeps acquire=none without a declared remote not applicable without issuing Git steps', async () => {
        const { root, executable } = await fixture()
        try {
            expect(await compare({ root, executable, acquire: 'none' })).toEqual({
                kind: 'not-applicable', code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                reason: 'sibling service has no declared comparison remote',
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('returns safe stable nonpasses for missing upstream and credentialed declarations', async () => {
        const { root, executable } = await fixture()
        try {
            expect(await compare({ root, executable, declaredRemote: 'https://token@code.invalid/team/service.git' })).toEqual({
                kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                reason: 'declared repository identity is unavailable for sibling service: its remote in cockpit.toml carries credentials; declare it without them',
            })
            expect(await compare({ root, executable, declaredRemote: '/srv/remotes/service.git' })).toMatchObject({
                kind: 'unavailable', reason: expect.stringContaining('is a local path or a URL scheme other than https or ssh'),
            })
            const unavailable = await compare({ root, executable, declaredRemote: 'https://code.invalid/team/service.git' })
            expect(unavailable).toEqual({
                kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                reason: 'comparison upstream is unavailable for sibling service',
            })
            expect(JSON.stringify(unavailable)).not.toMatch(/https|token/)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('does not disclose a credentialed selected remote', async () => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'origin', 'https://token@code.invalid/team/service.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: root })

            const result = await compare({ root, executable, declaredRemote: 'https://code.invalid/team/service.git' })
            expect(result).toEqual({
                kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH', remoteName: 'origin',
                reason: 'comparison remote identity is unavailable for sibling service',
            })
            expect(JSON.stringify(result)).not.toMatch(/token|https/)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('rejects repository identity that changes after the status observation', async () => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'origin', 'https://code.invalid/team/service.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: root })
            const git = await status(root, executable)
            await writeFile(join(root, 'second.txt'), 'second\n')
            execFileSync('git', ['add', 'second.txt'], { cwd: root })
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'second'], { cwd: root })
            const started = createComparisonRemoteRefStep({
                executable, checkoutRoot: root, env: {}, timeoutMs: 10_000, stackId, checkoutId,
                source: root, sibling: 'service', acquire: 'manual',
                declaredRemote: 'https://code.invalid/team/service.git', git,
            })
            expect(started.kind).toBe('probe')
            if (started.kind !== 'probe') return
            expect(observeComparisonRemoteRef(started, await executeProbe(started.step))).toEqual({
                kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                reason: 'comparison upstream is unavailable for sibling service',
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it.each(['ahead', 'behind', 'diverged'] as const)('refuses a selected matching remote with %s adjacency', async (adjacency) => {
        const { root, executable } = await fixture()
        try {
            const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
            const base = git(['rev-parse', 'HEAD'])
            const child = (message: string) => git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                'commit-tree', 'HEAD^{tree}', '-p', base, '-m', message])
            const local = child('local')
            const remote = child('remote')
            git(['remote', 'add', 'origin', 'https://code.invalid/team/service.git'])
            git(['update-ref', 'refs/heads/main', adjacency === 'behind' ? base : local])
            git(['update-ref', 'refs/remotes/origin/main', adjacency === 'ahead' ? base : remote])
            git(['branch', '--set-upstream-to=origin/main', 'main'])
            expect(await status(root, executable)).toMatchObject({ evidence: { adjacency } })
            expect(await compare({ root, executable, declaredRemote: 'https://code.invalid/team/service.git' }))
                .toMatchObject({ kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                    reason: expect.stringContaining(adjacency) })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('rejects an upstream tip changed after URL selection without changing local HEAD', async () => {
        const { root, executable } = await fixture()
        try {
            const gitCommand = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
            const originalHead = gitCommand(['rev-parse', 'HEAD'])
            const next = gitCommand(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                'commit-tree', 'HEAD^{tree}', '-p', originalHead, '-m', 'new upstream'])
            gitCommand(['remote', 'add', 'origin', 'https://code.invalid/team/service.git'])
            gitCommand(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
            gitCommand(['branch', '--set-upstream-to=origin/main', 'main'])
            const git = await status(root, executable)
            const started = createComparisonRemoteRefStep({ executable, checkoutRoot: root, env: {}, timeoutMs: 10_000,
                stackId, checkoutId, source: root, sibling: 'service', acquire: 'manual',
                declaredRemote: 'https://code.invalid/team/service.git', git })
            if (started.kind !== 'probe') throw new Error('comparison ref unavailable')
            const selected = observeComparisonRemoteRef(started, await executeProbe(started.step))
            if (selected.kind !== 'probe') throw new Error('comparison URL unavailable')
            const revalidation = observeComparisonRemoteUrl(selected, await executeProbe(selected.step))
            if (revalidation.kind !== 'probe') throw new Error('comparison revalidation unavailable')
            gitCommand(['update-ref', 'refs/remotes/origin/main', next])
            expect(gitCommand(['rev-parse', 'HEAD'])).toBe(originalHead)
            expect(observeComparisonRemoteRevalidation(revalidation, await executeProbe(revalidation.step)))
                .toMatchObject({ kind: 'unavailable', reason: 'comparison upstream changed while authenticating sibling service' })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('rejects an upstream remote changed after URL selection', async () => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'origin', 'https://code.invalid/team/service.git'], { cwd: root })
            execFileSync('git', ['remote', 'add', 'other', 'https://code.invalid/other/service.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/other/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: root })
            const git = await status(root, executable)
            const started = createComparisonRemoteRefStep({
                executable, checkoutRoot: root, env: {}, timeoutMs: 10_000, stackId, checkoutId,
                source: root, sibling: 'service', acquire: 'manual',
                declaredRemote: 'https://code.invalid/team/service.git', git,
            })
            expect(started.kind).toBe('probe')
            if (started.kind !== 'probe') return
            const selected = observeComparisonRemoteRef(started, await executeProbe(started.step))
            expect(selected.kind).toBe('probe')
            if (selected.kind !== 'probe') return
            execFileSync('git', ['branch', '--set-upstream-to=other/main', 'main'], { cwd: root })
            const revalidation = observeComparisonRemoteUrl(selected, await executeProbe(selected.step))
            expect(revalidation.kind).toBe('probe')
            if (revalidation.kind !== 'probe') return
            expect(observeComparisonRemoteRevalidation(revalidation, await executeProbe(revalidation.step))).toEqual({
                kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH', remoteName: 'origin',
                reason: 'comparison upstream changed while authenticating sibling service',
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('rejects copied stage authorities and never executes inside the producer', async () => {
        const { root, executable } = await fixture()
        try {
            execFileSync('git', ['remote', 'add', 'origin', 'https://code.invalid/team/service.git'], { cwd: root })
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: root })
            const git = await status(root, executable)
            const started = createComparisonRemoteRefStep({
                executable, checkoutRoot: root, env: {}, timeoutMs: 10_000, stackId, checkoutId,
                source: root, sibling: 'service', acquire: 'manual',
                declaredRemote: 'https://code.invalid/team/service.git', git,
            })
            expect(started.kind).toBe('probe')
            if (started.kind !== 'probe') return
            const outcome = await executeProbe(started.step)
            expect(observeComparisonRemoteRef({ ...started }, outcome)).toMatchObject({ kind: 'unavailable' })
            const selected = observeComparisonRemoteRef(started, outcome)
            expect(selected.kind).toBe('probe')
            if (selected.kind !== 'probe') return
            const urlOutcome = await executeProbe(selected.step)
            expect(observeComparisonRemoteUrl({ ...selected }, urlOutcome)).toMatchObject({ kind: 'unavailable' })
            expect(observeComparisonRemoteUrl(selected, { ...urlOutcome })).toMatchObject({ kind: 'unavailable' })
            const revalidation = observeComparisonRemoteUrl(selected, urlOutcome)
            expect(revalidation.kind).toBe('probe')
            if (revalidation.kind !== 'probe') return
            const revalidationOutcome = await executeProbe(revalidation.step)
            expect(observeComparisonRemoteRevalidation({ ...revalidation }, revalidationOutcome)).toMatchObject({ kind: 'unavailable' })
            expect(observeComparisonRemoteRevalidation(revalidation, { ...revalidationOutcome })).toMatchObject({ kind: 'unavailable' })
        } finally { await rm(root, { recursive: true, force: true }) }
    })
})

describe('tracked secret files', () => {
    it('names committed secret-shaped files by path only and leaves templates and untracked files alone', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-tracked-secrets-')))
        try {
            const repository = join(root, 'api')
            await mkdir(join(repository, 'config'), { recursive: true })
            const value = 'synthetic-value-never-reported'
            await Promise.all([
                writeFile(join(repository, '.env'), `API_TOKEN=${value}\n`),
                writeFile(join(repository, 'config', '.env.production'), `API_TOKEN=${value}\n`),
                writeFile(join(repository, '.env.example'), 'API_TOKEN=\n'),
                writeFile(join(repository, '.environment-notes'), 'not a secret file\n'),
            ])
            execFileSync('git', ['init', '--quiet', repository])
            execFileSync('git', ['-C', repository, 'add', '--force', '.env', 'config/.env.production', '.env.example', '.environment-notes'])
            await writeFile(join(repository, '.env.local'), `API_TOKEN=${value}\n`)
            const git = await resolveGitExecutable(process.env)
            if (git.state !== 'available') throw new Error('git is unavailable')

            const findings = await inspectTrackedSecretFiles({ executable: git.value, timeoutMs: 5_000,
                repositories: [{ slug: 'api', root: repository }, { slug: 'docs', root }] }, executeProbe)

            expect(findings).toEqual([expect.objectContaining({ severity: 'warning', code: 'SECRET_FILE_TRACKED', target: 'sibling:api',
                message: expect.stringContaining('(.env, config/.env.production)') })])
            expect(JSON.stringify(findings)).not.toContain(value)
            // A probe whose outcome cannot be trusted is not a clean repository.
            const forged = await inspectTrackedSecretFiles({ executable: git.value, timeoutMs: 5_000,
                repositories: [{ slug: 'api', root: repository }] }, async step => ({ ...await executeProbe(step), stdout: Buffer.from('') }))
            expect(forged).toEqual([expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE', target: 'sibling:api' })])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
