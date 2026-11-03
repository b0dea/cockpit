import { execFileSync, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { upgradeCommand } from './command.js'
import {
    assembleReleaseEvidence,
    createReleaseEvidenceDiscovery,
    createReleaseRecord,
    type AuthenticatedCurrentOverrideProjection,
} from './release-evidence.js'

const roots: string[] = []
const sha = (character: string): string => character.repeat(64)
const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const installed = () => ({ package: '@b00dea/cockpit', version: '1.4.2' } as const)

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
        package: '@b00dea/cockpit',
        version: '1.4.2',
        integrity: `sha256-${createHash('sha256').update('a').digest('base64')}`,
        originals: [{ name: 'review', feature: 'skills', sha256: sha('1') }],
    },
    candidate: {
        package: '@b00dea/cockpit',
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
    it('ships an offline adapter that writes a record and its digest without replacing output', async () => {
        const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
        const root = await mkdtemp(join(tmpdir(), 'cockpit-release-adapter-'))
        roots.push(root)
        const output = join(root, 'release-evidence.json')
        const script = fileURLToPath(new URL('../../libexec/release-evidence.mjs', import.meta.url))
        const args = ['record', '--package', manifest.name, '--version', manifest.version,
            '--integrity', `sha512-${createHash('sha512').update('published').digest('base64')}`, '--output', output]

        const first = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
        expect(first.status, first.stderr).toBe(0)
        expect(first.stdout).toBe('')
        const bytes = await readFile(output, 'utf8')
        expect(await readFile(`${output}.sha256`, 'utf8')).toBe(`${digest(bytes)}  release-evidence.json\n`)

        const repeated = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
        expect(repeated.status).toBe(2)
        expect(repeated.stderr).toContain('could not be written')
        expect(await readFile(output, 'utf8')).toBe(bytes)

        const conflictedOutput = join(root, 'conflicted.json')
        await writeFile(`${conflictedOutput}.sha256`, 'reviewed digest\n')
        const conflicted = spawnSync(process.execPath, [script, ...args.slice(0, -1), conflictedOutput], { encoding: 'utf8' })
        expect(conflicted.status).toBe(2)
        expect(conflicted.stderr).toContain('EEXIST')
        await expect(readFile(conflictedOutput, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(`${conflictedOutput}.sha256`, 'utf8')).toBe('reviewed digest\n')
    })

    it('assembles independently authenticated release records into evidence the existing discovery accepts', async () => {
        const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
        const current = await createReleaseRecord({
            package: manifest.name,
            version: manifest.version,
            integrity: `sha512-${createHash('sha512').update('current').digest('base64')}`,
        })
        expect(current).toMatchObject({ kind: 'complete' })
        if (current.kind !== 'complete') return
        expect(JSON.parse(current.bytes)).toMatchObject({
            schema: 'cockpit-upgrade-release-record/v1',
            release: {
                package: manifest.name,
                version: manifest.version,
                originals: expect.arrayContaining([
                    expect.objectContaining({ name: 'evaluator', feature: 'subagents' }),
                    expect.objectContaining({ name: 'cockpit-setup', feature: 'skills' }),
                ]),
            },
        })

        const root = await mkdtemp(join(tmpdir(), 'cockpit-release-records-'))
        roots.push(root)
        const currentPath = join(root, 'current.json')
        const candidatePath = join(root, 'candidate.json')
        const evidencePath = join(root, 'release-evidence.json')
        await writeFile(currentPath, current.bytes)
        const candidateValue = JSON.parse(current.bytes)
        candidateValue.release.version = '0.0.1'
        candidateValue.release.integrity = `sha512-${createHash('sha512').update('candidate').digest('base64')}`
        const candidateBytes = `${JSON.stringify(candidateValue)}\n`
        await writeFile(candidatePath, candidateBytes)

        const assembled = await assembleReleaseEvidence({
            currentPath,
            currentSha256: digest(current.bytes),
            candidatePath,
            candidateSha256: digest(candidateBytes),
        })
        expect(assembled).toMatchObject({ kind: 'complete' })
        if (assembled.kind !== 'complete') return
        await writeFile(evidencePath, assembled.bytes)
        const discover = createReleaseEvidenceDiscovery({
            configPath: 'cockpit.toml', evidencePath,
            expectedSha256: digest(assembled.bytes),
            projection: { activeOverrides: [] },
            installed: { package: manifest.name, version: manifest.version,
                integrity: `sha512-${createHash('sha512').update('current').digest('base64')}` },
        })
        await expect(discover({ configPath: 'cockpit.toml' })).resolves.toMatchObject({
            kind: 'complete',
            current: { package: manifest.name, version: manifest.version },
            candidate: { package: manifest.name, version: '0.0.1' },
        })

        await writeFile(candidatePath, `${candidateBytes} `)
        await expect(assembleReleaseEvidence({
            currentPath,
            currentSha256: digest(current.bytes),
            candidatePath,
            candidateSha256: digest(candidateBytes),
        })).resolves.toEqual({ kind: 'refusal', reason: 'candidate release record could not be authenticated' })

        // A malformed record or evidence file is named with where it stopped parsing, not as a bare SyntaxError.
        const truncated = '{\n  "schema": 1,\n}\n'
        await writeFile(candidatePath, truncated)
        await expect(assembleReleaseEvidence({ currentPath, currentSha256: digest(current.bytes), candidatePath, candidateSha256: digest(truncated) }))
            .resolves.toEqual({ kind: 'refusal', reason: 'candidate release record is not valid JSON at line 3, column 1; expected a cockpit-upgrade-release-record/v1 document' })
        await writeFile(evidencePath, truncated)
        await expect(createReleaseEvidenceDiscovery({ configPath: 'cockpit.toml', evidencePath, expectedSha256: digest(truncated),
            projection: { activeOverrides: [] }, installed: { package: manifest.name, version: manifest.version } })({ configPath: 'cockpit.toml' }))
            .resolves.toEqual({ kind: 'refusal', code: 'UPGRADE_REPAIR_UNVERIFIED',
                reason: 'release evidence is not valid JSON at line 3, column 1; expected a cockpit-upgrade-release-evidence/v1 document' })
    })

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
                package: '@b00dea/cockpit', version: '1.4.2', integrity: `sha256-${createHash('sha256').update('a').digest('base64')}`,
            },
            candidate: {
                package: '@b00dea/cockpit', version: '1.5.0', integrity: `sha512-${createHash('sha512').update('b').digest('base64')}`,
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
        ['version', { package: '@b00dea/cockpit', version: '1.4.1' }],
        ['available integrity', { package: '@b00dea/cockpit', version: '1.4.2', integrity: `sha256-${createHash('sha256').update('c').digest('base64')}` }],
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
