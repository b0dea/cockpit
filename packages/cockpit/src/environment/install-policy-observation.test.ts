import { randomUUID } from 'node:crypto'
import { link, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InstallPolicy } from '../schema.js'
import { checkoutId } from './identity.js'
import {
    consumeInstallPolicyProjection,
    observeInstallPolicyLockfiles,
    withInstallPolicyProjection,
    type InstallPolicyProjection,
} from './install-policy-observation.js'

const scratch: string[] = []
const source = { path: '/synthetic/cockpit.toml', byteLength: 17, sha256: 'a'.repeat(64) }
const policies: readonly InstallPolicy[] = [{
    toolchain: 'node', volume: 'node-modules', lockfile: 'package-lock.json',
    install: ['npm', 'ci'], load_probe: ['node', '--version'],
}]

async function checkout(): Promise<string> {
    const root = join(tmpdir(), `cockpit-policy-${randomUUID()}`)
    scratch.push(root)
    await mkdir(root)
    return realpath(root)
}

function times(now = Date.now()) {
    return { observedAt: new Date(now).toISOString(), evaluatedAt: now }
}

async function issue(root: string, catalog: readonly InstallPolicy[] = policies) {
    const checkoutIdentity = checkoutId({ checkoutPath: root })
    const time = times()
    const observation = await observeInstallPolicyLockfiles({
        source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: root,
        checkoutId: checkoutIdentity, policies: catalog, observedAt: time.observedAt,
    })
    return {
        observation,
        expected: {
            source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: root,
            checkoutId: checkoutIdentity, policies: catalog, evaluatedAt: time.evaluatedAt,
        },
    }
}

afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('install policy lockfile observation', () => {
    it('projects fresh evidence and lets the pure consumer authenticate it once', async () => {
        const root = await checkout()
        await writeFile(join(root, 'package-lock.json'), '{}')
        const { observation, expected } = await issue(root)

        let escaped: Parameters<typeof consumeInstallPolicyProjection>[0] | undefined
        const evidence = await withInstallPolicyProjection(observation, expected, (projection) => {
            escaped = projection
            expect(Reflect.ownKeys(projection)).toEqual([])
            expect(consumeInstallPolicyProjection({ ...projection } as never)).toBeUndefined()
            return consumeInstallPolicyProjection(projection)
        })
        expect(evidence).toMatchObject({
            source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: root,
            checkoutId: expected.checkoutId,
            lockfiles: [{ state: 'available', relativePath: 'package-lock.json', canonicalPath: join(root, 'package-lock.json') }],
        })
        expect(consumeInstallPolicyProjection(escaped!)).toBeUndefined()
        expect(await withInstallPolicyProjection(observation, expected, () => 'replayed')).toBeUndefined()
    })

    it('rejects copied, mismatched and replaced observations', async () => {
        const root = await checkout()
        const lockfile = join(root, 'package-lock.json')
        await writeFile(lockfile, '{}')

        const copied = await issue(root)
        expect(await withInstallPolicyProjection(structuredClone(copied.observation), copied.expected, () => 'used')).toBeUndefined()

        for (const change of [
            { siblingSlug: 'other' },
            { source: { ...source, sha256: 'f'.repeat(64) } },
            { checkoutRoot: join(root, 'other') },
            { checkoutId: checkoutId({ checkoutPath: join(root, 'other') }) },
        ]) {
            const issued = await issue(root)
            expect(await withInstallPolicyProjection(issued.observation, { ...issued.expected, ...change }, () => 'used')).toBeUndefined()
        }

        const replaced = await issue(root)
        await rm(lockfile)
        await writeFile(lockfile, '{"replaced":true}')
        expect(await withInstallPolicyProjection(replaced.observation, replaced.expected, () => 'used')).toBeUndefined()
    })

    it('uses trusted current time for issue and projection expiry', async () => {
        const root = await checkout()
        await writeFile(join(root, 'package-lock.json'), '{}')
        const now = Date.now()
        vi.useFakeTimers()
        vi.setSystemTime(now)
        const checkoutIdentity = checkoutId({ checkoutPath: root })
        const common = { source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: root, checkoutId: checkoutIdentity, policies }

        await expect(observeInstallPolicyLockfiles({
            ...common, observedAt: new Date(now - 60_001).toISOString(),
        })).resolves.toMatchObject({ state: 'failed', code: 'INSTALL_POLICY_OBSERVATION_INVALID' })
        await expect(observeInstallPolicyLockfiles({
            ...common, observedAt: new Date(now + 1).toISOString(),
        })).resolves.toMatchObject({ state: 'failed', code: 'INSTALL_POLICY_OBSERVATION_INVALID' })

        const observation = await observeInstallPolicyLockfiles({ ...common, observedAt: new Date(now).toISOString() })
        vi.setSystemTime(now + 60_001)
        expect(await withInstallPolicyProjection(observation, {
            ...common, evaluatedAt: now,
        }, () => 'used')).toBeUndefined()

        vi.setSystemTime(now)
        const mismatched = await observeInstallPolicyLockfiles({ ...common, observedAt: new Date(now).toISOString() })
        expect(await withInstallPolicyProjection(mismatched, {
            ...common, evaluatedAt: now + 1,
        }, () => 'used')).toBeUndefined()
    })

    it('rejects asynchronous projection callbacks at compile time and runtime', async () => {
        const root = await checkout()
        await writeFile(join(root, 'package-lock.json'), '{}')
        const issued = await issue(root)
        let escaped: Parameters<typeof consumeInstallPolicyProjection>[0] | undefined

        await expect(withInstallPolicyProjection(issued.observation, issued.expected, ((projection: InstallPolicyProjection) => {
            escaped = projection
            return Promise.resolve('late')
        }) as never)).rejects.toThrow('install policy projection callback must be synchronous')
        expect(consumeInstallPolicyProjection(escaped!)).toBeUndefined()

        const neverSettles = await issue(root)
        const bounded = Promise.race([
            withInstallPolicyProjection(
                neverSettles.observation,
                neverSettles.expected,
                (() => new Promise(() => undefined)) as never,
            ),
            new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
        ])
        await expect(bounded).rejects.toThrow('install policy projection callback must be synchronous')

        const thenable = await issue(root)
        await expect(withInstallPolicyProjection(
            thenable.observation,
            thenable.expected,
            (() => ({ then: () => undefined })) as never,
        )).rejects.toThrow('install policy projection callback must be synchronous')

        if (false) {
            // @ts-expect-error an asynchronous callback would outlive the authenticated filesystem scope
            await withInstallPolicyProjection(issued.observation, issued.expected, async () => 'late')
        }
    })

    it('refuses symlinks, hardlinks, directories and path escapes without retaining bytes', async () => {
        const root = await checkout()
        await writeFile(join(root, 'original.lock'), 'credential-shaped-canary')
        await link(join(root, 'original.lock'), join(root, 'hardlink.lock'))
        await mkdir(join(root, 'directory.lock'))
        await symlink('original.lock', join(root, 'linked.lock'))
        const checkoutIdentity = checkoutId({ checkoutPath: root })
        const common = {
            source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: root,
            checkoutId: checkoutIdentity, observedAt: new Date().toISOString(),
        }

        for (const lockfile of ['hardlink.lock', 'directory.lock', 'linked.lock', '../outside.lock']) {
            const result = await observeInstallPolicyLockfiles({ ...common, policies: [{ ...policies[0]!, lockfile }] })
            expect(result).toMatchObject({ state: 'failed', code: 'INSTALL_POLICY_OBSERVATION_INVALID' })
        }

        let reads = 0
        const hostile = Object.defineProperty({ ...common, policies }, 'checkoutRoot', {
            enumerable: true,
            get: () => { reads += 1; return root },
        })
        await expect(observeInstallPolicyLockfiles(hostile)).resolves.toMatchObject({ state: 'failed' })
        expect(reads).toBe(0)

        const result = await observeInstallPolicyLockfiles({
            ...common, policies: [{ ...policies[0]!, lockfile: 'original.lock' }],
        })
        expect(JSON.stringify(result)).not.toContain('credential-shaped-canary')
    })

    it('reports an unavailable checkout without inventing lockfile absence', async () => {
        const root = await checkout()
        const missingRoot = join(root, 'missing')
        await expect(observeInstallPolicyLockfiles({
            source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: missingRoot,
            checkoutId: checkoutId({ checkoutPath: missingRoot }), policies,
            observedAt: new Date().toISOString(),
        })).resolves.toMatchObject({ state: 'unavailable', code: 'INSTALL_POLICY_OBSERVATION_UNAVAILABLE' })
    })

    it('invalidates absence and nested ancestry when either changes before projection', async () => {
        const root = await checkout()
        await mkdir(join(root, 'locks'))
        await writeFile(join(root, 'locks', 'package-lock.json'), '{}')
        const catalog = [
            { ...policies[0]!, lockfile: 'locks/package-lock.json' },
            { ...policies[0]!, volume: 'shrinkwrap', lockfile: 'locks/npm-shrinkwrap.json' },
        ]
        const absence = await issue(root, catalog)
        await writeFile(join(root, 'locks', 'npm-shrinkwrap.json'), '{}')
        expect(await withInstallPolicyProjection(absence.observation, absence.expected, () => 'used')).toBeUndefined()

        await rm(join(root, 'locks', 'npm-shrinkwrap.json'))
        const ancestry = await issue(root, catalog)
        await rm(join(root, 'locks'), { recursive: true })
        await mkdir(join(root, 'old-locks'))
        await writeFile(join(root, 'old-locks', 'package-lock.json'), '{}')
        await symlink('old-locks', join(root, 'locks'))
        expect(await withInstallPolicyProjection(ancestry.observation, ancestry.expected, () => 'used')).toBeUndefined()
    })

    it('authenticates a reordered but otherwise identical catalog', async () => {
        const root = await checkout()
        await writeFile(join(root, 'package-lock.json'), '{}')
        const catalog = [policies[0]!, { ...policies[0]!, toolchain: 'python' as const, volume: 'python', lockfile: 'requirements.lock' }]
        const issued = await issue(root, catalog)
        const result = await withInstallPolicyProjection(
            issued.observation,
            { ...issued.expected, policies: [...catalog].reverse() },
            () => 'authenticated',
        )
        expect(result).toBe('authenticated')
    })

    it('rejects duplicate runtime catalog volumes before observing files', async () => {
        const root = await checkout()
        const duplicateVolume = [policies[0]!, { ...policies[0]!, toolchain: 'python' as const, lockfile: 'requirements.lock' }]
        await expect(observeInstallPolicyLockfiles({
            source, siblingIndex: 0, siblingSlug: 'service', checkoutRoot: root,
            checkoutId: checkoutId({ checkoutPath: root }), policies: duplicateVolume,
            observedAt: new Date().toISOString(),
        })).resolves.toMatchObject({ state: 'failed', code: 'INSTALL_POLICY_OBSERVATION_INVALID' })
    })
})
