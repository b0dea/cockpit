import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CheckoutId, type StackId } from './contract.js'
import { executeProbe } from '../environment-exec/execute.js'
import { resolveGitExecutable } from './executable.js'
import { resolvedExecutable } from './executable.js'
import {
    createComparisonRemoteRefStep,
    createGitAncestryObservationStep,
    createGitObservationStep,
    createRunningCheckoutObservationStep,
    observeComparisonRemoteRef,
    observeComparisonRemoteRevalidation,
    observeComparisonRemoteUrl,
    decodeGitObservation,
    observeGit,
    observeGitAncestry,
    observeRunningCheckout,
} from './git-observation.js'

const stackId = `stack:${'4'.repeat(64)}` as StackId
const checkoutId = `checkout:${'6'.repeat(64)}` as CheckoutId
const observedAt = '2026-09-08T02:00:00.000Z'
const revision = 'a'.repeat(40)

function decode(lines: string) {
    return decodeGitObservation(Buffer.from(lines.replaceAll('abcdef', revision)), { stackId, observedAt, source: '/workspace/service' })
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
        expect(decodeGitObservation(Buffer.from([0xff]), { stackId, observedAt, source: '/workspace/service' })).toMatchObject({ kind: 'unavailable' })
        expect(decodeGitObservation(Buffer.alloc(65_537, 0x61), { stackId, observedAt, source: '/workspace/service' })).toMatchObject({ kind: 'unavailable' })
        expect(decodeGitObservation(Buffer.from(`# branch.oid ${revision}\n# branch.head ${'é'.repeat(600)}\n`), { stackId, observedAt, source: '/workspace/service' })).toMatchObject({ kind: 'unavailable' })
    })

    it('rejects duplicate identity and adjacency headers', () => {
        expect(decode('# branch.oid one\n# branch.oid two\n# branch.head main\n')).toMatchObject({ kind: 'unavailable' })
        expect(decode('# branch.oid one\n# branch.head main\n# branch.ab +0 -0\n# branch.ab +0 -0\n')).toMatchObject({ kind: 'unavailable' })
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
                { observed: { value: { revision, branch: 'main', trackedDirtyCount: 1, untrackedCount: 1 } } },
                { observed: { value: { revision, branch: 'main', adjacency: 'aligned' } } },
            ],
        })
    })

    it('authenticates the running stack checkout identity before comparison', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-running-checkout-'))
        try {
            const probe = join(root, 'checkout-identity')
            const body = `#!/bin/sh\nprintf 'checkout:${'a'.repeat(64)}\\n'\n`
            await writeFile(probe, body); await chmod(probe, 0o755)
            const executable = resolvedExecutable({
                canonicalPath: probe, invocationPath: probe,
                sha256: (await import('node:crypto')).createHash('sha256').update(body).digest('hex'),
                executionMode: 'staged',
            })!
            const expectedCheckoutId = `checkout:${'a'.repeat(64)}` as CheckoutId
            const step = createRunningCheckoutObservationStep({ executable, cwd: root, env: {}, timeoutMs: 10_000, stackId, source: root, checkoutId, expectedCheckoutId })
            expect(step).toBeDefined()
            if (!step) return
            const outcome = await executeProbe(step)
            expect(observeRunningCheckout(step, outcome, {
                stackId, checkoutId, source: root, expectedCheckoutId,
            })).toMatchObject({ kind: 'complete', observation: { observed: { value: `checkout:${'a'.repeat(64)}` } } })
            expect(observeRunningCheckout(step, { ...outcome }, {
                stackId, checkoutId, source: root, expectedCheckoutId,
            })).toMatchObject({ kind: 'unavailable' })
            expect(observeRunningCheckout(step, outcome, {
                stackId, checkoutId, source: `${root}-other`, expectedCheckoutId: `checkout:${'b'.repeat(64)}` as CheckoutId,
            })).toMatchObject({ kind: 'unavailable' })
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
            execFileSync('git', ['update-ref', 'refs/remotes/upstream/trunk', 'HEAD'], { cwd: root })
            execFileSync('git', ['branch', '--set-upstream-to=upstream/trunk', 'main'], { cwd: root })

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
                reason: 'declared repository identity is unavailable for sibling service',
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
