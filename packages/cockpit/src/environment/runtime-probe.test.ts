import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseNpmPackJson } from '../test-support/npm-pack-json.js'
import { currentCoordinationCleanupVerdict, probeRuntimeSupport, type RuntimeProbeRequest, type RuntimeProbeVerdict } from './runtime-probe.js'
import { ENVIRONMENT_CODES, type CheckoutId, type CockpitId, type HolderId, type StackId } from './contract.js'

const packageRoot = new URL('../../', import.meta.url)
const repositoryRoot = realpathSync(new URL('../../../../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'cockpit-runtime-probe-'))
const artifactDirectory = join(scratch, 'artifact')
const installation = join(scratch, 'installation')
const isolatedRepository = join(scratch, 'package-source')
const isolatedPackageRoot = join(isolatedRepository, 'packages', 'cockpit')
const liveDirectory = join(scratch, 'installed-child')
let installedModulePath = ''
let installedModuleSha = ''
let packageSha = ''
let dockerPath = ''
let dockerInvocationPath = ''
let dockerSha = ''
let gitPath = ''
let gitInvocationPath = ''
let gitSha = ''
let imageId = ''
let slowDockerPath = ''
let slowDockerSha = ''

function sha256(value: Buffer | string): string {
    return createHash('sha256').update(value).digest('hex')
}

function npmEnvironment(): NodeJS.ProcessEnv {
    return { ...process.env, npm_config_cache: join(scratch, 'npm-cache') }
}

beforeAll(() => {
    mkdirSync(artifactDirectory)
    mkdirSync(liveDirectory)
    mkdirSync(join(isolatedRepository, 'packages'), { recursive: true })
    cpSync(realpathSync(packageRoot), isolatedPackageRoot, { recursive: true })
    cpSync(join(repositoryRoot, 'scripts'), join(isolatedRepository, 'scripts'), { recursive: true })
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) {
        cpSync(join(repositoryRoot, name), join(isolatedRepository, name))
    }
    const esbuildPackage = realpathSync(createRequire(import.meta.url).resolve('esbuild/package.json'))
    symlinkSync(dirname(dirname(esbuildPackage)), join(isolatedRepository, 'node_modules'), 'dir')
    const sourceCli = join(realpathSync(packageRoot), 'dist', 'cli.js')
    const sourceCliBeforePack = statSync(sourceCli, { bigint: true })
    const packed = parseNpmPackJson(execFileSync(
        // The built installed artifact is the fixture. Re-running prepack here duplicates the
        // repository build inside the process-heavy full suite and can exhaust the hook budget.
        'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactDirectory],
        { cwd: isolatedPackageRoot, env: npmEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    ))
    const sourceCliAfterPack = statSync(sourceCli, { bigint: true })
    expect({ ino: sourceCliAfterPack.ino, mtimeNs: sourceCliAfterPack.mtimeNs }).toEqual({
        ino: sourceCliBeforePack.ino,
        mtimeNs: sourceCliBeforePack.mtimeNs,
    })
    const tarball = join(artifactDirectory, packed.filename)
    packageSha = sha256(readFileSync(tarball))
    execFileSync('npm', [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
        '--prefix', installation, tarball,
    ], { env: npmEnvironment(), stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 })
    installedModulePath = realpathSync(join(installation, 'node_modules/@b0dea/cockpit/dist/environment/runtime-probe.js'))
    installedModuleSha = sha256(readFileSync(installedModulePath))
    gitInvocationPath = execFileSync('which', ['git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    gitPath = realpathSync(gitInvocationPath)
    gitSha = sha256(readFileSync(gitPath))
    try {
        dockerInvocationPath = execFileSync('which', ['docker'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        dockerPath = realpathSync(dockerInvocationPath)
        dockerSha = sha256(readFileSync(dockerPath))
        const imageReference = process.env.COCKPIT_RUNTIME_TEST_IMAGE ?? 'alpine:latest'
        imageId = execFileSync(dockerInvocationPath, ['image', 'inspect', imageReference, '--format', '{{.Id}}'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
        }).trim()
    } catch {
        dockerPath = '/runtime-unavailable/docker'
        dockerInvocationPath = '/runtime-unavailable/docker'
        dockerSha = '0'.repeat(64)
        imageId = `sha256:${'0'.repeat(64)}`
    }
    slowDockerPath = join(scratch, 'docker')
    writeFileSync(slowDockerPath, '#!/bin/sh\nsleep 1\n', { mode: 0o700 })
    chmodSync(slowDockerPath, 0o700)
    slowDockerSha = sha256(readFileSync(slowDockerPath))
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function runtimeEnvironment(): Readonly<Record<string, string>> {
    const names = ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'LANG', 'LC_ALL'] as const
    return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
}

function request(overrides: Partial<RuntimeProbeRequest> = {}): RuntimeProbeRequest {
    return {
        executable: {
            canonicalPath: dockerPath,
            invocationPath: dockerInvocationPath,
            sha256: dockerSha,
            executionMode: 'staged',
        },
        gitExecutable: {
            canonicalPath: gitPath,
            invocationPath: gitInvocationPath,
            sha256: gitSha,
            executionMode: 'verified-path',
        },
        cwd: realpathSync(liveDirectory),
        env: runtimeEnvironment(),
        composeFloor: '2.20.0',
        measuredOn: new Date().toISOString().slice(0, 10),
        timeoutMs: 30_000,
        image: { reference: imageId, id: imageId },
        installedModule: { canonicalPath: installedModulePath, sha256: installedModuleSha },
        ...overrides,
    }
}

function installedChildProbe(input: unknown): RuntimeProbeVerdict {
    const script = [
        "import { readFileSync } from 'node:fs'",
        `const module = await import(${JSON.stringify(pathToFileURL(installedModulePath).href)})`,
        "const input = JSON.parse(readFileSync(0, 'utf8'))",
        'const verdict = await module.probeRuntimeSupport(input)',
        'process.stdout.write(JSON.stringify(verdict))',
    ].join(';')
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: liveDirectory,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '' },
        input: JSON.stringify(input), encoding: 'utf8', timeout: 330_000,
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(child.stderr).toBe('')
    return JSON.parse(child.stdout) as RuntimeProbeVerdict
}

function persistEvidence(verdict: RuntimeProbeVerdict): void {
    const destination = process.env.COCKPIT_RUNTIME_EVIDENCE_PATH
    if (!destination) return
    const evidence = verdict.evidence
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim()
    const record = {
        schema_version: 1,
        source_head: sourceHead,
        package_sha256: packageSha,
        installed_module: installedModulePath,
        installed_module_sha256: installedModuleSha,
        runtime_path: evidence?.runtimePath ?? null,
        runtime_sha256: evidence?.runtimeExecutableSha256 ?? null,
        runtime_version: evidence?.runtimeVersion ?? null,
        compose_version: evidence?.composeVersion ?? null,
        candidate: evidence === null ? { outcome: 'failed' } : {
            outcome: verdict.candidate,
            sha256: evidence.candidateSha256,
            checks: evidence.candidateChecks,
        },
        broken_control: evidence === null ? { outcome: verdict.brokenControl } : {
            outcome: verdict.brokenControl,
            sha256: evidence.brokenControlSha256,
        },
        expires_at: evidence?.expiresAt ?? null,
        batch_id: evidence?.batchId ?? null,
        project_name: evidence?.projectName ?? null,
        operating_system: evidence?.operatingSystem ?? null,
        architecture: evidence?.architecture ?? null,
        started_at: evidence?.startedAt ?? new Date().toISOString(),
        finished_at: evidence?.finishedAt ?? new Date().toISOString(),
        cleanup: evidence?.cleanup ?? { ownedSurvivors: ['unavailable'], resourcesEqual: false, claimsEqual: false, leasesEqual: false },
        disposition: verdict.status,
        ...(verdict.status === 'unavailable' ? {
            unavailable_code: verdict.operatorAction?.code ?? 'RUNTIME_UNAVAILABLE',
            unavailable_reason: verdict.operatorAction?.reason ?? 'runtime evidence is unavailable',
        } : {}),
    }
    const absolute = resolve(destination)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

describe('installed container-runtime capability promotion', () => {
    it.each([
        ['ordinary released cleanup', 'complete', 'complete', 'missing', 'released', true, true],
        ['explicit empty lease cleanup', 'complete', 'complete', 'empty', 'empty', true, true],
        ['active lease left behind', 'complete', 'complete', 'missing', 'active', true, false],
        ['pre-existing active lease', 'complete', 'complete', 'active', 'active', true, false],
        ['malformed coordination', 'complete', 'complete', 'missing', 'malformed', true, false],
        ['indeterminate coordination observation', 'complete', 'complete', 'missing', 'indeterminate', true, false],
        ['refused coordination observation', 'complete', 'complete', 'missing', 'refusal', true, false],
        ['changed complete claim inventory', 'complete', 'changed', 'missing', 'missing', false, true],
        ['matching inventory refusals', 'refusal', 'refusal', 'missing', 'missing', false, true],
    ] as const)('%s has a truthful current coordination verdict', (
        _label, beforeClaimsKind, afterClaimsKind, beforeLeaseKind, afterLeaseKind, claimsEqual, leasesEqual,
    ) => {
        const stackId = `stack:${'b'.repeat(64)}` as StackId
        const cockpitId = `cockpit:probe:${'a'.repeat(64)}` as CockpitId
        const holderId = `holder:${'c'.repeat(64)}:session` as HolderId
        const checkoutId = `checkout:${'d'.repeat(64)}` as CheckoutId
        const activeLease = {
            offset: 0, ports: { PROBE_PORT: 40_000 }, released: false,
            declaration: { step: 1, count: 1, bases: { PROBE_PORT: 40_000 } },
        }
        type InventoryRead = Parameters<typeof currentCoordinationCleanupVerdict>[0]
        type ActiveCoordination = Extract<InventoryRead, { readonly kind: 'complete' }>['value'][number]['record']
        const activeCoordination = {
            holders: [{ holderId, checkoutId, claimedAt: '2026-09-07T12:00:00.000Z' }],
            lease: activeLease, lastReleasedHolder: null, drain: null, restore: null,
        } satisfies ActiveCoordination
        const inventories: Record<'complete' | 'changed' | 'refusal', InventoryRead> = {
            complete: { kind: 'complete', value: [] },
            changed: { kind: 'complete', value: [{ stackId, record: activeCoordination }] },
            refusal: { kind: 'refusal', diagnostics: [{ severity: 'error', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'synthetic malformed inventory', target: 'synthetic' }] },
        }
        type CoordinationRead = Parameters<typeof currentCoordinationCleanupVerdict>[2]
        type CompleteCoordination = Extract<CoordinationRead, { readonly kind: 'complete' }>['value']
        const emptyRecord = { format: 'cockpit-state/v1', kind: 'coordination', cockpitId,
            subjectId: stackId, revision: 1, updatedAt: '2026-09-07T12:00:00.000Z',
            value: { holders: [], lease: null, lastReleasedHolder: null, drain: null, restore: null } } satisfies CompleteCoordination
        const states: Record<'missing' | 'empty' | 'released' | 'active' | 'malformed' | 'indeterminate' | 'refusal', CoordinationRead> = {
            missing: { kind: 'missing', path: 'synthetic' },
            empty: { kind: 'complete', value: emptyRecord },
            released: { kind: 'complete', value: { format: 'cockpit-state/v1', kind: 'coordination', cockpitId,
                subjectId: stackId, revision: 1, updatedAt: '2026-09-07T12:00:00.000Z',
                value: { holders: [], lease: { ...activeLease, released: true }, lastReleasedHolder: null, drain: null, restore: null } } },
            active: { kind: 'complete', value: { format: 'cockpit-state/v1', kind: 'coordination', cockpitId,
                subjectId: stackId, revision: 1, updatedAt: '2026-09-07T12:00:00.000Z',
                value: activeCoordination } },
            malformed: { kind: 'complete', value: { format: 'cockpit-state/v1', kind: 'coordination', cockpitId,
                subjectId: stackId, revision: 1, updatedAt: '2026-09-07T12:00:00.000Z', value: {} } },
            indeterminate: { kind: 'indeterminate', code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                message: 'synthetic durability uncertainty', target: 'synthetic',
                recovery: 're-read the current coordination record', value: emptyRecord },
            refusal: { kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'synthetic malformed state', target: 'synthetic' },
        }

        expect(currentCoordinationCleanupVerdict(
            inventories[beforeClaimsKind], inventories[afterClaimsKind],
            states[beforeLeaseKind], states[afterLeaseKind], stackId,
        )).toEqual({ claimsEqual, leasesEqual })
    })

    it('does not promote an executor-authenticated parser-only four-step run', async () => {
        const verdict = await probeRuntimeSupport({
            executable: { canonicalPath: '/tmp/docker', invocationPath: '/tmp/docker', sha256: 'a'.repeat(64), executionMode: 'staged' },
            gitExecutable: { canonicalPath: '/tmp/git', invocationPath: '/tmp/git', sha256: 'e'.repeat(64), executionMode: 'staged' },
            cwd: '/tmp', env: {}, projectName: 'runtime-probe',
            candidate: { canonicalPath: '/tmp/candidate.yml', sha256: 'c'.repeat(64) },
            brokenControl: { canonicalPath: '/tmp/control.yml', sha256: 'd'.repeat(64) },
            composeFloor: '2.20.0', measuredOn: '2026-09-07', timeoutMs: 10_000,
        } as unknown as RuntimeProbeRequest)

        expect(verdict).toEqual(expect.objectContaining({
            status: 'unavailable', candidate: 'failed', brokenControl: 'inconclusive', evidence: null,
            operatorAction: expect.objectContaining({ required: true }),
        }))
    })

    it.each([
        ['source checkout module', { installedModule: { canonicalPath: realpathSync(new URL('./runtime-probe.ts', import.meta.url)), sha256: sha256(readFileSync(new URL('./runtime-probe.ts', import.meta.url))) } }],
        ['remote endpoint', { env: { ...runtimeEnvironment(), DOCKER_HOST: 'ssh://synthetic.invalid' } }],
        ['secret-bearing environment', { env: { ...runtimeEnvironment(), API_SECRET: 'probe-secret-canary' } }],
        ['future measurement', { measuredOn: '9999-01-01' }],
        ['fake executor path', { executable: { canonicalPath: '/tmp/docker', invocationPath: '/tmp/docker', sha256: 'a'.repeat(64), executionMode: 'staged' as const } }],
    ])('keeps %s unavailable without retaining caller values', async (_name, overrides) => {
        const verdict = await probeRuntimeSupport(request(overrides as Partial<RuntimeProbeRequest>))
        expect(verdict.status).toBe('unavailable')
        expect(verdict.evidence).toBeNull()
        expect(JSON.stringify(verdict)).not.toContain('probe-secret-canary')
    })

    it('rejects context overrides before installed runtime mutation', () => {
        const verdict = installedChildProbe(request({ env: { ...runtimeEnvironment(), DOCKER_CONTEXT: 'synthetic-override' } }))
        expect(verdict.status).toBe('unavailable')
        expect(verdict.evidence).toBeNull()
        expect(verdict.operatorAction?.reason).toBe('runtime probe input is malformed or contains an unsafe environment')
    })

    it.each(['tcp://127.0.0.1:2375', 'npipe:////./pipe/dockerDesktopLinuxEngine'])(
        'refuses an unavailable host transport %s before any runtime command', (host) => {
            const verdict = installedChildProbe(request({ env: { ...runtimeEnvironment(), DOCKER_HOST: host } }))
            expect(verdict.status).toBe('unavailable')
            expect(verdict.operatorAction?.reason).toBe('DOCKER_HOST does not name a local Docker endpoint; unset it or point it at a local Unix socket or Windows named pipe')
            expect(verdict.evidence?.runtimeVersion).toBeNull()
            expect(readdirSync(liveDirectory)).toEqual([])
        })

    it('rejects a caller-added package digest at the installed-child boundary', () => {
        const verdict = installedChildProbe({ ...request(), packageArtifactSha256: 'f'.repeat(64) })
        expect(verdict).toEqual(expect.objectContaining({ status: 'unavailable', evidence: null }))
    })

    it('bounds a slow installed command before mutation and leaves no owned runtime identity', () => {
        const verdict = installedChildProbe(request({
            executable: { canonicalPath: slowDockerPath, invocationPath: slowDockerPath, sha256: slowDockerSha, executionMode: 'staged' },
            timeoutMs: 25,
        }))
        expect(verdict).toEqual(expect.objectContaining({
            status: 'unavailable',
            operatorAction: expect.objectContaining({ code: 'RUNTIME_PROBE_TIMEOUT' }),
            evidence: expect.objectContaining({ cleanup: expect.objectContaining({ ownedSurvivors: [] }) }),
        }))
        expect(readdirSync(liveDirectory)).toEqual([])
    })

    it('installed current runtime emits checksum-bound candidate and broken-control evidence', () => {
        const verdict = installedChildProbe(request())
        persistEvidence(verdict)

        const evidenceDestination = process.env.COCKPIT_RUNTIME_EVIDENCE_PATH
        if (evidenceDestination) {
            const persisted = JSON.parse(readFileSync(resolve(evidenceDestination), 'utf8')) as Record<string, unknown>
            expect(persisted).toEqual(expect.objectContaining({
                source_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
                expires_at: verdict.evidence?.expiresAt ?? null,
                batch_id: verdict.evidence?.batchId ?? null,
                project_name: verdict.evidence?.projectName ?? null,
                operating_system: verdict.evidence?.operatingSystem ?? null,
                architecture: verdict.evidence?.architecture ?? null,
            }))
        }

        if (dockerPath.startsWith('/runtime-unavailable/')) {
            expect(verdict).toEqual(expect.objectContaining({ status: 'unavailable', operatorAction: expect.objectContaining({ required: true }) }))
            return
        }
        expect(['supported', 'unavailable']).toContain(verdict.status)
        expect(verdict.brokenControl, JSON.stringify(verdict)).toBe('rejected')
        expect(verdict.evidence).toEqual(expect.objectContaining({
            installedModuleSha256: installedModuleSha,
            runtimeExecutableSha256: dockerSha,
            brokenControlRejected: true,
            cleanup: expect.objectContaining({ ownedSurvivors: [] }),
        }))
        const checks = verdict.evidence!.candidateChecks
        if (checks.localRuntime && checks.imagePreexisting && checks.topology) {
            expect(checks.profile, JSON.stringify(verdict)).toBe(true)
        }
        // A runtime that brought the candidate up and recovered it must also preview its reset
        // and tear it down through the production owners; a refusal there is a probe or owner
        // defect, not a property of the runtime.
        if (checks.recovery) {
            expect(checks.resetPreview, JSON.stringify(verdict)).toBe(true)
            expect(checks.teardown, JSON.stringify(verdict)).toBe(true)
        }
        if (checks.applicationUp) {
            expect(checks.mountHostToContainer, JSON.stringify(verdict)).toBe(true)
            expect(checks.mountContainerToHost, JSON.stringify(verdict)).toBe(true)
        }
        if (verdict.status === 'supported') {
            expect(verdict.operatorAction).toBeNull()
            expect(Object.values(verdict.evidence!.candidateChecks)).not.toContain(false)
            expect(verdict.evidence!.cleanup).toEqual({ ownedSurvivors: [], resourcesEqual: true, claimsEqual: true, leasesEqual: true })
        } else {
            expect(verdict.operatorAction).toEqual(expect.objectContaining({ required: true }))
        }
        expect(readdirSync(liveDirectory)).toEqual([])
    }, 350_000)
})
