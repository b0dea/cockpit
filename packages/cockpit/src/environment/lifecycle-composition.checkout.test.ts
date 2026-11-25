import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createLifecycleCompositionFixtureSupport } from '../../test-support/lifecycle-composition-fixture.js'

// A Git command elsewhere in the repository (an editor's status refresh, another agent's worktree)
// moves the Git directory's timestamps. Landing between the checkout observation and its use is a
// timing no child process can arrange, so the use is wrapped, not replaced, to let it land there.
const concurrentGit = vi.hoisted(() => ({ remaining: 0, gitDirectory: '' }))

vi.mock('./setup-observation.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./setup-observation.js')>()
    const { rm: remove, writeFile: write } = await import('node:fs/promises')
    const { join: joinPath } = await import('node:path')
    return {
        ...actual,
        withSetupCheckoutProjection: (async (...args: Parameters<typeof actual.withSetupCheckoutProjection>) => {
            if (concurrentGit.remaining > 0) {
                concurrentGit.remaining -= 1
                const lock = joinPath(concurrentGit.gitDirectory, 'index.lock')
                await write(lock, '')
                await remove(lock)
            }
            return actual.withSetupCheckoutProjection(...args)
        }) as typeof actual.withSetupCheckoutProjection,
    }
})

const roots: string[] = []
const { fixture } = createLifecycleCompositionFixtureSupport(roots, { enabled: false, active: 0, maximumActive: 0, calls: 0, delayMs: 0 })

afterEach(async () => {
    concurrentGit.remaining = 0
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('lifecycle checkout evidence', () => {
    // down, sleep and up all load through here. A Git command in another worktree between reading the
    // checkout and using it refused down with "authenticated checkout evidence is unavailable", which
    // named neither the cause nor that a retry was all it needed.
    it('reads the checkout again when Git activity moved it, and names that activity when it does not stop', async () => {
        const candidate = await fixture()
        concurrentGit.gitDirectory = join(candidate.checkout, '.git')
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: '/usr/bin:/bin', HOME: candidate.home },
            sessionId: 'checkout-race',
            timeoutMs: 5_000,
        }, executeProbe)

        concurrentGit.remaining = 1
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded, JSON.stringify(loaded)).toMatchObject({ kind: 'complete' })

        concurrentGit.remaining = Number.POSITIVE_INFINITY
        const refused = await adapters.load({ configPath: candidate.configPath })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'LIFECYCLE_EVIDENCE_INVALID', target: candidate.configPath,
            message: expect.stringContaining('a Git command was running in this repository or one of its worktrees'),
        }] })
    }, 60_000)
})
