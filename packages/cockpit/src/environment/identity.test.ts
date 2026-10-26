import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CheckoutId, HolderId, StackId } from './contract.js'
import type { BootstrapLockOwnerId, CanonicalCheckoutEvidence, CanonicalMainCheckoutEvidence } from './identity.js'
import { bootstrapHolderId, cockpitId, checkoutId, holderId, stackId } from './identity.js'
import { resolveInstance } from './instance.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-identity-'))
    temporaryDirectories.push(directory)
    return directory
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
        },
    }).trim()
}

function canonicalGitEvidence(
    mainCheckout: string,
    checkout: string = mainCheckout,
): CanonicalMainCheckoutEvidence & CanonicalCheckoutEvidence {
    return {
        mainCheckoutPath: realpathSync(git(mainCheckout, 'rev-parse', '--path-format=absolute', '--show-toplevel')),
        checkoutPath: realpathSync(git(checkout, 'rev-parse', '--path-format=absolute', '--show-toplevel')),
    }
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('canonical environment identities', () => {
    it('shares cockpit identity across real Git worktrees without collapsing checkout identity', () => {
        const root = temporaryDirectory()
        const main = join(root, 'main')
        const worktree = join(root, 'worktree')
        mkdirSync(main)
        git(main, 'init', '--initial-branch=main')
        git(main, 'config', 'user.name', 'Synthetic Maintainer')
        git(main, 'config', 'user.email', 'maintainer@example.invalid')
        git(main, 'commit', '--allow-empty', '-m', 'initial')
        git(main, 'worktree', 'add', '--detach', worktree)

        const mainEvidence = canonicalGitEvidence(main)
        const worktreeEvidence = canonicalGitEvidence(main, worktree)
        const mainCommonDirectory = realpathSync(git(main, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
        const worktreeCommonDirectory = realpathSync(git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'))

        expect(mainCommonDirectory).toBe(worktreeCommonDirectory)
        expect(cockpitId({ name: 'sample-cockpit', mainCheckoutPath: mainEvidence.mainCheckoutPath }))
            .toBe(cockpitId({ name: 'sample-cockpit', mainCheckoutPath: worktreeEvidence.mainCheckoutPath }))
        expect(checkoutId({ checkoutPath: mainEvidence.checkoutPath }))
            .not.toBe(checkoutId({ checkoutPath: worktreeEvidence.checkoutPath }))
    })

    it('uses the native top-level evidence when Git stores its directory separately', () => {
        const root = temporaryDirectory()
        const checkout = join(root, 'checkout')
        const gitDirectory = join(root, 'metadata', 'repository.git')
        mkdirSync(dirname(gitDirectory), { recursive: true })
        git(root, 'init', '--initial-branch=main', `--separate-git-dir=${gitDirectory}`, checkout)

        const evidence = canonicalGitEvidence(checkout)
        const commonDirectory = realpathSync(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'))

        expect(evidence.mainCheckoutPath).toBe(realpathSync(checkout))
        expect(evidence.mainCheckoutPath).not.toBe(realpathSync(dirname(commonDirectory)))
        expect(cockpitId({ name: 'sample-cockpit', mainCheckoutPath: evidence.mainCheckoutPath }))
            .toMatch(/^cockpit:sample-cockpit:[a-f0-9]{64}$/)
    })

    it('does not collapse unrelated canonical paths with the same basename', () => {
        const root = temporaryDirectory()
        const first = join(root, 'first', 'service')
        const second = join(root, 'second', 'service')
        mkdirSync(first, { recursive: true })
        mkdirSync(second, { recursive: true })

        expect(checkoutId({ checkoutPath: realpathSync(first) }))
            .not.toBe(checkoutId({ checkoutPath: realpathSync(second) }))
    })

    it('binds the declared cockpit name without retaining a raw checkout path', () => {
        const first = cockpitId({ name: 'first-cockpit', mainCheckoutPath: '/srv/cockpit' })
        const second = cockpitId({ name: 'second-cockpit', mainCheckoutPath: '/srv/cockpit' })

        expect(first).not.toBe(second)
        expect(first).toMatch(/^cockpit:first-cockpit:[a-f0-9]{64}$/)
        expect(first).not.toContain('/srv/cockpit')
    })

    it('keeps session holders distinct and spells the no-session compatibility holder explicitly', () => {
        const cockpit = cockpitId({ name: 'sample-cockpit', mainCheckoutPath: '/srv/cockpit' })
        const checkout = checkoutId({ checkoutPath: '/srv/cockpit' })
        const stack = stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } })

        const first = holderId({ stackId: stack, checkoutId: checkout, sessionId: 'session-one' })
        const second = holderId({ stackId: stack, checkoutId: checkout, sessionId: 'session-two' })
        const compatibility = holderId({ stackId: stack, checkoutId: checkout })

        expect(first).not.toBe(second)
        expect(compatibility).toMatch(/:compat$/)
        expect(compatibility).not.toBe(holderId({ stackId: stack, checkoutId: checkout, sessionId: 'compat' }))
    })

    it('derives a bootstrap-only lock owner from checkout and session without runtime authority', () => {
        const checkout = checkoutId({ checkoutPath: '/srv/cockpit' })
        const first = bootstrapHolderId({ checkoutId: checkout, sessionId: 'session-one' })
        const second = bootstrapHolderId({ checkoutId: checkout, sessionId: 'session-two' })

        expect(first).toMatch(/^bootstrap-holder:[a-f0-9]{64}:session$/)
        expect(first).not.toBe(second)
        expect(() => bootstrapHolderId({ checkoutId: 'checkout:bad' as CheckoutId, sessionId: 'session-one' })).toThrow('checkoutId')
        expect(() => bootstrapHolderId({ checkoutId: checkout, sessionId: '' })).toThrow('sessionId')

        // @ts-expect-error Bootstrap lock ownership must not become runtime lifecycle ownership.
        const runtimeHolder: HolderId = first
        expect(runtimeHolder).toBe(first as BootstrapLockOwnerId)
    })

    it('round-trips shared and named stacks with stackId as the environment target', () => {
        const cockpit = cockpitId({ name: 'sample-cockpit', mainCheckoutPath: '/srv/cockpit' })
        const checkout = checkoutId({ checkoutPath: '/srv/cockpit' })
        const variants = [{ kind: 'shared' }, { kind: 'named', name: 'review-2' }] as const

        const records = variants.map((variant) => {
            const target = stackId({ cockpitId: cockpit, checkoutId: checkout, variant })
            return {
                stackId: target,
                checkoutId: checkout,
                holderId: holderId({ stackId: target, checkoutId: checkout, sessionId: 'session-one' }),
            }
        })

        expect(records[0].stackId).not.toBe(records[1].stackId)
        expect(records[0].checkoutId).toBe(records[1].checkoutId)
        expect(JSON.parse(JSON.stringify(records))).toEqual(records)
        expect(records.every(({ stackId: target }) => target.startsWith('stack:'))).toBe(true)
    })

    it('refuses malformed evidence rather than inventing an identity', () => {
        expect(() => cockpitId({ name: 'Invalid Name', mainCheckoutPath: '/srv/cockpit' })).toThrow('cockpit name')
        expect(() => checkoutId({ checkoutPath: 'relative/checkout' })).toThrow('canonical absolute path')
        expect(() => checkoutId({ checkoutPath: '/srv/../srv/cockpit' })).toThrow('canonical absolute path')
        expect(() => holderId({
            stackId: 'stack:not-a-digest' as never,
            checkoutId: 'checkout:not-a-digest' as never,
        })).toThrow('stackId')
    })
})

describe('attach-or-isolate resolution', () => {
    const cockpit = cockpitId({ name: 'sample-cockpit', mainCheckoutPath: '/srv/cockpit' })
    const servedCheckout = checkoutId({ checkoutPath: '/srv/cockpit/served' })
    const launcherCheckout = checkoutId({ checkoutPath: '/srv/cockpit/launcher' })
    const explicitCheckout = checkoutId({ checkoutPath: '/srv/cockpit/explicit' })
    const served = {
        stackId: stackId({ cockpitId: cockpit, checkoutId: servedCheckout, variant: { kind: 'shared' } }),
        checkoutId: servedCheckout,
    }
    const launcher = {
        stackId: stackId({ cockpitId: cockpit, checkoutId: launcherCheckout, variant: { kind: 'shared' } }),
        checkoutId: launcherCheckout,
    }
    const explicit = {
        stackId: stackId({ cockpitId: cockpit, checkoutId: explicitCheckout, variant: { kind: 'named', name: 'requested' } }),
        checkoutId: explicitCheckout,
    }

    it.each([
        {
            name: 'explicit identity wins even when served and launcher are mounted',
            input: { explicit, served, launcher, mountedSet: [servedCheckout, launcherCheckout] },
            expected: { kind: 'isolate', source: 'explicit', ...explicit },
        },
        {
            name: 'served identity wins when it is mounted',
            input: { served, launcher, mountedSet: [servedCheckout, launcherCheckout] },
            expected: { kind: 'attach', source: 'served', ...served },
        },
        {
            name: 'launcher identity attaches when served is not mounted',
            input: { served, launcher, mountedSet: [launcherCheckout] },
            expected: { kind: 'attach', source: 'launcher', ...launcher },
        },
        {
            name: 'empty mounted set selects the canonical launcher identity',
            input: { served, launcher, mountedSet: [] },
            expected: { kind: 'isolate', source: 'launcher', ...launcher },
        },
        {
            name: 'equal served and launcher identities attach with served precedence',
            input: { served, launcher: served, mountedSet: [servedCheckout] },
            expected: { kind: 'attach', source: 'served', ...served },
        },
    ] as const)('$name', ({ input, expected }) => {
        expect(resolveInstance(input)).toEqual(expected)
    })

    it('allows profiles to affect resolution only through the supplied mounted set', () => {
        const defaultResolution = resolveInstance({ served, launcher, mountedSet: [servedCheckout] })
        const profileResolution = resolveInstance({ served, launcher, mountedSet: [launcherCheckout] })

        expect(defaultResolution).toEqual({ kind: 'attach', source: 'served', ...served })
        expect(profileResolution).toEqual({ kind: 'attach', source: 'launcher', ...launcher })
    })

    it('is byte-invariant when forbidden environmental evidence is changed', () => {
        const allowed = { served, launcher, mountedSet: [servedCheckout] }
        const withForbiddenEvidence = {
            ...allowed,
            worktreePresent: true,
            acquire: 'manual',
            setupState: 'partial',
            runtimeAvailable: false,
        }
        const changedForbiddenEvidence = {
            ...allowed,
            worktreePresent: false,
            acquire: 'auto',
            setupState: 'complete',
            runtimeAvailable: true,
        }

        expect(JSON.stringify(resolveInstance(withForbiddenEvidence)))
            .toBe(JSON.stringify(resolveInstance(changedForbiddenEvidence)))
    })

    it('refuses null or malformed candidates and mounted-set values', () => {
        expect(() => resolveInstance({ served: null as never, launcher, mountedSet: [] })).toThrow('served')
        expect(() => resolveInstance({ served, launcher, mountedSet: ['checkout:bad' as CheckoutId] })).toThrow('mountedSet')
        expect(() => resolveInstance({
            explicit: { stackId: 'stack:bad' as StackId, checkoutId: explicitCheckout },
            served,
            launcher,
            mountedSet: [],
        })).toThrow('explicit')
    })

    it.each([
        [[servedCheckout]],
        [new String(servedCheckout)],
        [{ toString: () => servedCheckout }],
    ])('refuses a non-string mounted identity before regular-expression coercion', (value) => {
        expect(() => resolveInstance({
            served,
            launcher,
            mountedSet: [value as never],
        })).toThrow('mountedSet')
    })

    if (false) {
        // @ts-expect-error Worktree presence is not part of the decision contract.
        resolveInstance({ served, launcher, mountedSet: [], worktreePresent: true })
        // @ts-expect-error Runtime availability is not part of the decision contract.
        resolveInstance({ served, launcher, mountedSet: [], runtimeAvailable: true })
    }
})
