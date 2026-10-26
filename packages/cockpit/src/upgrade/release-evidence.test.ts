import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { upgradeCommand } from './command.js'
import { createReleaseEvidenceDiscovery, type AuthenticatedCurrentOverrideProjection } from './release-evidence.js'

const roots: string[] = []
const sha = (character: string): string => character.repeat(64)
const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const installed = () => ({ package: '@b0dea/cockpit', version: '1.4.2' } as const)

const projection = (): AuthenticatedCurrentOverrideProjection => Object.freeze({
    activeOverrides: Object.freeze([Object.freeze({
        name: 'review',
        feature: 'skills' as const,
        originalSha256: sha('1'),
        recordedSha256: sha('1'),
        overlaySource: 'surfaces/review.json',
    })]),
})

const evidence = () => ({
    schema: 'cockpit-upgrade-release-evidence/v1',
    current: {
        package: '@b0dea/cockpit',
        version: '1.4.2',
        integrity: `sha256-${createHash('sha256').update('a').digest('base64')}`,
        originals: [{ name: 'review', feature: 'skills', sha256: sha('1') }],
    },
    candidate: {
        package: '@b0dea/cockpit',
        version: '1.5.0',
        integrity: `sha512-${createHash('sha512').update('b').digest('base64')}`,
        originals: [{ name: 'review', feature: 'skills', sha256: sha('2') }],
    },
})

async function fixture(value: unknown = evidence()): Promise<{ path: string; bytes: string }> {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-release-evidence-'))
    roots.push(root)
    const path = join(root, 'release-evidence.json')
    const bytes = JSON.stringify(value)
    await writeFile(path, bytes)
    return { path, bytes }
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('authenticated release evidence discovery', () => {
    it('reports only candidate changes to every authenticated active override', async () => {
        const { path, bytes } = await fixture()
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml',
            evidencePath: path,
            expectedSha256: digest(bytes),
            projection: projection(),
            installed: installed(),
        })

        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toEqual({
            kind: 'complete',
            current: {
                package: '@b0dea/cockpit', version: '1.4.2', integrity: `sha256-${createHash('sha256').update('a').digest('base64')}`,
            },
            candidate: {
                package: '@b0dea/cockpit', version: '1.5.0', integrity: `sha512-${createHash('sha512').update('b').digest('base64')}`,
            },
            affectedOverrideOriginals: [{
                name: 'review', feature: 'skills', recordedSha256: sha('1'),
                currentSha256: sha('2'), overlaySource: 'surfaces/review.json',
            }],
        })
    })

    it('returns no affected override when the candidate keeps the authenticated original', async () => {
        const value = evidence()
        value.candidate.originals[0]!.sha256 = sha('1')
        const { path, bytes } = await fixture(value)
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: path, expectedSha256: digest(bytes), projection: projection(),
            installed: installed(),
        })

        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toMatchObject({
            kind: 'complete', affectedOverrideOriginals: [],
        })
    })

    it.each([
        ['package', { package: '@scope/other', version: '1.4.2' }],
        ['version', { package: '@b0dea/cockpit', version: '1.4.1' }],
        ['available integrity', { package: '@b0dea/cockpit', version: '1.4.2', integrity: `sha256-${createHash('sha256').update('c').digest('base64')}` }],
    ] as const)('refuses evidence whose current release does not match the installed %s', async (_field, identity) => {
        const { path, bytes } = await fixture()
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: path,
            expectedSha256: digest(bytes), projection: projection(),
            installed: identity,
        })

        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toMatchObject({
            kind: 'refusal', code: 'UPGRADE_AUTH_FAILED',
            reason: 'release evidence current release does not match the installed package identity',
        })
    })

    it('refuses when the installed package identity is unavailable', async () => {
        const { path, bytes } = await fixture()
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: path,
            expectedSha256: digest(bytes), projection: projection(),
        })

        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toMatchObject({
            kind: 'refusal', code: 'UPGRADE_AUTH_FAILED',
            reason: 'installed package identity is unavailable or invalid',
        })
    })

    it('plugs into the review-only upgrade command without changing its discovery contract', async () => {
        const { path, bytes } = await fixture()
        const discoverAuthenticated = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: path,
            expectedSha256: digest(bytes), projection: projection(),
            installed: installed(),
        })

        const outcome = await upgradeCommand({ configPath: 'cockpit.toml' }, { discoverAuthenticated })

        expect(outcome).toMatchObject({
            kind: 'complete',
            status: 0,
            result: {
                current: { version: '1.4.2' },
                candidate: { version: '1.5.0' },
                affectedOverrideOriginals: [{ name: 'review', currentSha256: sha('2') }],
            },
        })
    })

    it.each([
        ['truncated release integrity', async () => {
            const value = evidence()
            value.candidate.integrity = 'sha512-AA=='
            const created = await fixture(value)
            return { ...created, expectedSha256: digest(created.bytes) }
        }, 'UPGRADE_REPAIR_UNVERIFIED'],
        ['changed evidence bytes', async () => {
            const created = await fixture()
            return { ...created, expectedSha256: sha('0') }
        }, 'UPGRADE_AUTH_FAILED'],
        ['current original unlike the authenticated projection', async () => {
            const value = evidence()
            value.current.originals[0]!.sha256 = sha('3')
            const created = await fixture(value)
            return { ...created, expectedSha256: digest(created.bytes) }
        }, 'UPGRADE_REPAIR_UNVERIFIED'],
        ['stale overlay review hash', async () => {
            const created = await fixture()
            const stale = projection()
            return {
                ...created,
                expectedSha256: digest(created.bytes),
                projection: { activeOverrides: [{ ...stale.activeOverrides[0]!, recordedSha256: sha('4') }] },
            }
        }, 'UPGRADE_REPAIR_UNVERIFIED'],
        ['missing candidate original', async () => {
            const value = evidence()
            value.candidate.originals = []
            const created = await fixture(value)
            return { ...created, expectedSha256: digest(created.bytes) }
        }, 'UPGRADE_REPAIR_UNVERIFIED'],
        ['duplicate current original', async () => {
            const value = evidence()
            value.current.originals.push({ ...value.current.originals[0]! })
            const created = await fixture(value)
            return { ...created, expectedSha256: digest(created.bytes) }
        }, 'UPGRADE_REPAIR_UNVERIFIED'],
        ['unknown evidence field', async () => {
            const value = { ...evidence(), mutableTag: 'latest' }
            const created = await fixture(value)
            return { ...created, expectedSha256: digest(created.bytes) }
        }, 'UPGRADE_REPAIR_UNVERIFIED'],
    ] as const)('refuses %s without returning a partial discovery', async (_label, arrange, code) => {
        const created = await arrange()
        const currentProjection: AuthenticatedCurrentOverrideProjection = 'projection' in created
            ? created.projection as AuthenticatedCurrentOverrideProjection
            : projection()
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml',
            evidencePath: created.path,
            expectedSha256: created.expectedSha256,
            projection: currentProjection,
            installed: installed(),
        })

        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toMatchObject({ kind: 'refusal', code })
    })

    it('refuses a symlink evidence path before reading its target', async () => {
        const created = await fixture()
        const link = join(created.path, '..', 'linked-evidence.json')
        await symlink(created.path, link)
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: link, expectedSha256: digest(created.bytes), projection: projection(),
            installed: installed(),
        })

        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toMatchObject({
            kind: 'refusal', code: 'UPGRADE_AUTH_FAILED',
        })
    })

    it('refuses FIFO evidence without waiting for a writer', async () => {
        const created = await fixture()
        const fifo = join(created.path, '..', 'evidence.pipe')
        execFileSync('mkfifo', [fifo])
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: fifo, expectedSha256: digest(created.bytes),
            projection: projection(), installed: installed(),
        })
        const pending = discover({ configPath: 'cockpit.toml' })
        let timer: ReturnType<typeof setTimeout> | undefined
        let result: Awaited<typeof pending> | undefined
        try {
            result = await Promise.race([pending, new Promise<undefined>(resolve => {
                timer = setTimeout(() => resolve(undefined), 2_000)
            })])
        } finally {
            clearTimeout(timer)
            if (!result) {
                const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK)
                await pending
                await writer.close()
            }
        }
        expect(result).toMatchObject({ kind: 'refusal', code: 'UPGRADE_AUTH_FAILED' })
    })

    it('binds one discovery to its exact configuration path', async () => {
        const created = await fixture()
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath: created.path,
            expectedSha256: digest(created.bytes), projection: projection(),
            installed: installed(),
        })

        await expect(discover({ configPath: 'other.toml' })).resolves.toMatchObject({
            kind: 'refusal', code: 'UPGRADE_AUTH_FAILED',
        })
    })
})
