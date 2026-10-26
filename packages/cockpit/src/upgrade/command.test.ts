import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
    unavailableUpgradeDiscovery,
    runConfiguredUpgradeCommand,
    upgradeCommand,
    type AuthenticatedUpgradeDiscoveryComplete,
} from './command.js'

const sha = (character: string): string => character.repeat(64)

const completeDiscovery = (): AuthenticatedUpgradeDiscoveryComplete => ({
    kind: 'complete',
    current: {
        package: '@b0dea/cockpit',
        version: '1.4.2',
        integrity: `sha256-${createHash('sha256').update('1').digest('base64')}`,
    },
    candidate: {
        package: '@b0dea/cockpit',
        version: '1.5.0',
        integrity: `sha512-${createHash('sha512').update('2').digest('base64')}`,
    },
    affectedOverrideOriginals: [{
        name: 'review',
        feature: 'skills',
        recordedSha256: sha('3'),
        currentSha256: sha('4'),
        overlaySource: 'surfaces/review.json',
    }],
})

describe('reviewable upgrade plan', () => {
    it('provides a production-safe refusal while no authenticated release source exists', async () => {
        await expect(unavailableUpgradeDiscovery({ configPath: 'cockpit.toml' })).resolves.toEqual({
            kind: 'refusal',
            code: 'UPGRADE_VERSION_AMBIGUOUS',
            reason: 'candidate release identity is unavailable from an authenticated release source',
        })
    })

    it('discovers once and returns identities, affected originals, and the literal review sequence without mutation', async () => {
        const discovered = completeDiscovery()
        const original = structuredClone(discovered)
        const discoverAuthenticated = vi.fn(async () => discovered)

        const outcome = await upgradeCommand(
            { configPath: 'cockpit.toml' },
            { discoverAuthenticated },
        )

        expect(discoverAuthenticated).toHaveBeenCalledTimes(1)
        expect(discoverAuthenticated).toHaveBeenCalledWith({ configPath: 'cockpit.toml' })
        expect(outcome).toEqual({
            kind: 'complete',
            status: 0,
            result: {
                current: discovered.current,
                candidate: discovered.candidate,
                affectedOverrideOriginals: discovered.affectedOverrideOriginals,
                commands: [
                    "cockpit sync --config 'cockpit.toml' --dry-run",
                    "cockpit sync --config 'cockpit.toml'",
                    "cockpit preflight --config 'cockpit.toml'",
                ],
            },
            diagnostics: [],
        })
        expect(discovered).toEqual(original)
        expect(Object.isFrozen(outcome)).toBe(true)
        if (outcome.kind !== 'complete') throw new Error('expected a complete upgrade plan')
        expect(Object.isFrozen(outcome.result)).toBe(true)
        expect(Object.isFrozen(outcome.result.affectedOverrideOriginals[0])).toBe(true)
    })

    it('binds every review command to the discovered config without allowing shell expansion', async () => {
        const configPath = "configs/review path;$(touch escaped)'s.toml"

        const outcome = await upgradeCommand(
            { configPath },
            { discoverAuthenticated: async () => completeDiscovery() },
        )

        expect(outcome.kind).toBe('complete')
        if (outcome.kind !== 'complete') throw new Error('expected a complete upgrade plan')
        expect(outcome.result.commands).toEqual([
            `cockpit sync --config 'configs/review path;$(touch escaped)'"'"'s.toml' --dry-run`,
            `cockpit sync --config 'configs/review path;$(touch escaped)'"'"'s.toml'`,
            `cockpit preflight --config 'configs/review path;$(touch escaped)'"'"'s.toml'`,
        ])
    })

    it('takes versions and affected override originals only from authenticated discovery', async () => {
        const discoverAuthenticated = vi.fn(async () => completeDiscovery())
        const untrusted = {
            configPath: 'cockpit.toml',
            current: { package: 'untrusted', version: '99.0.0', integrity: `sha256-${createHash('sha256').update('a').digest('base64')}` },
            affectedOverrideOriginals: [{ name: 'untrusted' }],
        }

        const outcome = await upgradeCommand(untrusted, { discoverAuthenticated })

        expect(outcome.kind).toBe('complete')
        if (outcome.kind !== 'complete') throw new Error('expected a complete upgrade plan')
        expect(outcome.result.current.package).toBe('@b0dea/cockpit')
        expect(outcome.result.affectedOverrideOriginals).toHaveLength(1)
        expect(outcome.result.affectedOverrideOriginals[0]?.name).toBe('review')
        expect(discoverAuthenticated).toHaveBeenCalledWith({ configPath: 'cockpit.toml' })
    })

    it.each([
        ['network', 'UPGRADE_NETWORK_FAILED'],
        ['authentication', 'UPGRADE_AUTH_FAILED'],
        ['ambiguous version', 'UPGRADE_VERSION_AMBIGUOUS'],
        ['unverified repair', 'UPGRADE_REPAIR_UNVERIFIED'],
    ] as const)('names a %s refusal and returns no partial plan', async (_label, code) => {
        const outcome = await upgradeCommand({ configPath: 'cockpit.toml' }, {
            discoverAuthenticated: async () => ({ kind: 'refusal', code, reason: `${_label} refused` }),
        })

        expect(outcome).toEqual({
            kind: 'refusal',
            status: 2,
            result: null,
            diagnostics: [{ severity: 'error', code, message: `${_label} refused`, target: 'cockpit.toml' }],
        })
    })

    it.each([
        ['mismatched package identities', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), candidate: { ...completeDiscovery().candidate, package: '@scope/other' } })],
        ['malformed current version', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), current: { ...completeDiscovery().current, version: 'latest' } })],
        ['older candidate version', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), candidate: { ...completeDiscovery().candidate, version: '1.3.9' } })],
        ['equal candidate version', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), candidate: { ...completeDiscovery().candidate, version: '1.4.2' } })],
        ['malformed artifact integrity', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), candidate: { ...completeDiscovery().candidate, integrity: 'unverified' } })],
        ['truncated artifact digest', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), candidate: { ...completeDiscovery().candidate, integrity: 'sha256-AA==' } })],
        ['noncanonical artifact digest', 'UPGRADE_VERSION_AMBIGUOUS', () => ({ ...completeDiscovery(), candidate: { ...completeDiscovery().candidate, integrity: `sha256-${'A'.repeat(42)}B=` } })],
        ['malformed affected original', 'UPGRADE_DISCOVERY_INVALID', () => ({ ...completeDiscovery(), affectedOverrideOriginals: [{ ...completeDiscovery().affectedOverrideOriginals[0], currentSha256: 'short' }] })],
    ] as const)('fails closed on %s', async (_label, code, discovery) => {
        const outcome = await upgradeCommand({ configPath: 'cockpit.toml' }, {
            discoverAuthenticated: async () => discovery(),
        })

        expect(outcome).toMatchObject({
            kind: 'refusal',
            status: 2,
            result: null,
            diagnostics: [{ severity: 'error', code, target: 'cockpit.toml' }],
        })
    })

    it('turns a discovery transport exception into a named refusal without retrying', async () => {
        const discoverAuthenticated = vi.fn(async () => {
            throw new Error('synthetic registry outage')
        })

        const outcome = await upgradeCommand({ configPath: 'cockpit.toml' }, { discoverAuthenticated })

        expect(discoverAuthenticated).toHaveBeenCalledTimes(1)
        expect(outcome).toEqual({
            kind: 'refusal',
            status: 2,
            result: null,
            diagnostics: [{
                severity: 'error',
                code: 'UPGRADE_NETWORK_FAILED',
                message: 'upgrade discovery failed: synthetic registry outage',
                target: 'cockpit.toml',
            }],
        })
    })

    it('refuses malformed command input before discovery', async () => {
        const discoverAuthenticated = vi.fn(async () => completeDiscovery())

        const outcome = await upgradeCommand({ configPath: '' }, { discoverAuthenticated })

        expect(discoverAuthenticated).not.toHaveBeenCalled()
        expect(outcome).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: 'UPGRADE_SOURCE_INVALID' }],
        })
    })
})

describe('configured upgrade discovery', () => {
    it('refuses absent release evidence before touching configuration or discovery transport', async () => {
        const createReleaseEvidenceDiscovery = vi.fn(() => async () => completeDiscovery())
        const outcome = await runConfiguredUpgradeCommand({ configPath: 'missing/cockpit.toml' }, {
            installed: { package: '@b0dea/cockpit', version: '1.4.2' },
            createReleaseEvidenceDiscovery,
        })
        expect(outcome).toMatchObject({
            kind: 'refusal', status: 2, result: null,
            diagnostics: [{ code: 'UPGRADE_VERSION_AMBIGUOUS' }],
        })
        expect(createReleaseEvidenceDiscovery).not.toHaveBeenCalled()
    })

    it('binds discovery to a read-only current projection and the installed release identity', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-upgrade-command-')))
        try {
            const configPath = join(root, 'cockpit.toml')
            const evidencePath = join(root, 'release-evidence.json')
            const declaration = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8'))
                .replace('name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
            await mkdir(join(root, 'app'))
            await mkdir(join(root, 'fixtures'))
            await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
            await writeFile(configPath, declaration)
            const discovery = vi.fn(async () => completeDiscovery())
            const createReleaseEvidenceDiscovery = vi.fn(() => discovery)
            const outcome = await runConfiguredUpgradeCommand({
                configPath, releaseEvidencePath: evidencePath, releaseEvidenceSha256: sha('a'),
            }, {
                installed: { package: '@b0dea/cockpit', version: '1.4.2' },
                createReleaseEvidenceDiscovery,
            })
            expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
            expect(createReleaseEvidenceDiscovery).toHaveBeenCalledExactlyOnceWith({
                configPath, evidencePath, expectedSha256: sha('a'), projection: { activeOverrides: [] },
                installed: { package: '@b0dea/cockpit', version: '1.4.2' },
            })
            expect(discovery).toHaveBeenCalledExactlyOnceWith({ configPath })
            expect(existsSync(join(root, 'compose.generated.yml'))).toBe(false)
            expect(existsSync(join(root, '.cockpit'))).toBe(false)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 180_000)
})
