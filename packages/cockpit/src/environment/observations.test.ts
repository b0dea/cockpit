import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { createServer } from 'node:net'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { execFileSync, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_CODES, type CheckoutId, type CockpitId, type EnvironmentObservation, type HolderId, type ObservationDeclaration, type StackId } from './contract.js'
import {
    aggregateObservations,
    allObservationDeclarations,
    evaluatePreflight,
    observationSatisfiesExpectation,
    projectDoctor,
    refreshObservationPostures,
    resolveObservationPostures,
    validateObservationDeclarations,
} from './observations.js'
import { observeConfiguration, selectStateRoot, transactState } from './state.js'
import { coordinationStateRecord, observeClaimState } from './claims.js'
import { leasePortFamily, observePortFamily } from './ports.js'
import { observeEnvironmentKeys, observeSiblingPresence } from './templates.js'
import { createRuntimeAdapter, observeRuntimeExecution } from './runtime.js'
import { resolveGitExecutable, resolvedExecutable } from './executable.js'
import { createGitObservationStep, observeGit } from './git-observation.js'
import { executeProbe } from '../environment-exec/execute.js'
import { observeStateSeed, recordLifecycleSeeded, recordLifecycleStarted, resolveLifecycleStage } from './lifecycle-stage.js'
import { checkoutId as deriveCheckoutId, cockpitId as deriveCockpitId, stackId as deriveStackId } from './identity.js'

const authorityRoot = join(realpathSync(tmpdir()), `cockpit-observation-authority-${process.pid}`)
const authorityCockpitId = deriveCockpitId({ name: 'fixture', mainCheckoutPath: join(authorityRoot, 'main') })
const stackFor = (name: string) => deriveStackId({
    cockpitId: authorityCockpitId,
    checkoutId: deriveCheckoutId({ checkoutPath: join(authorityRoot, name) }),
    variant: { kind: 'shared' },
})
const stackId = stackFor('first')
const otherStackId = stackFor('second')
const checkoutId = `checkout:${'8'.repeat(64)}` as CheckoutId
const firstHolder = `holder:${'9'.repeat(64)}:session` as HolderId
const secondHolder = `holder:${'a'.repeat(64)}:session` as HolderId
const now = new Date().toISOString()
const validConfigSource = `[cockpit]\nname = "fixture"\n\n[[sibling]]\nslug = "service"\ndir = "service"\nremote = "https://example.invalid/service.git"\nmount = "always"\nacquire = "manual"\nvar = "SERVICE_DIR"\npurpose = "synthetic service"\n\n[ports.bases]\nWEB = 3000\n\n[environment]\naddressing = "hostname"\nauthentication = "real"\nposture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]\n`
const revision = createHash('sha256').update(validConfigSource).digest('hex')
const temporaryPaths: string[] = []

afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function namespace() {
    const parent = await mkdtemp(join(tmpdir(), 'cockpit-observations-'))
    temporaryPaths.push(parent)
    const home = join(parent, 'home')
    await mkdir(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: authorityCockpitId })
    if (selected.kind !== 'complete') throw new Error('fixture state root was refused')
    return selected.value
}

async function context(targetStackId: StackId = stackId, mount = 'always', source = validConfigSource, evaluatedAt = now) {
    const checkoutPath = targetStackId === stackId ? join(authorityRoot, 'first')
        : targetStackId === otherStackId ? join(authorityRoot, 'second')
        : join(authorityRoot, 'third')
    temporaryPaths.push(authorityRoot)
    await mkdir(checkoutPath, { recursive: true })
    const configPath = join(checkoutPath, 'cockpit.toml')
    const mountedSource = source.replace('mount = "always"', `mount = "${mount}"`)
        .replace('purpose = "synthetic service"', mount === 'host'
            ? 'purpose = "synthetic service"\nhost_reason = "requires host facilities"\ngate = "operator"'
            : 'purpose = "synthetic service"')
    await writeFile(configPath, mountedSource)
    const configuration = (await observeConfiguration({ stackId: targetStackId, observedAt: evaluatedAt, path: configPath }))
        .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
    const posture = await resolveObservationPostures({
        configuration, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
    })
    const state = await namespace()
    const stage = await resolveLifecycleStage({ namespace: state, stackId: targetStackId, observedAt: evaluatedAt })
    if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
    return { authorities: [posture], stages: [stage.authority] }
}

async function observation(input: {
    readonly stackId?: StackId
    readonly observedAt?: string
} = {}): Promise<EnvironmentObservation> {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-config-observation-'))
    temporaryPaths.push(root)
    const path = join(root, 'cockpit.toml')
    await writeFile(path, validConfigSource)
    const values = await observeConfiguration({ path, stackId: input.stackId ?? stackId, observedAt: input.observedAt ?? now })
    return values.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
}

async function unavailableConfiguration() {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-missing-config-observation-'))
    temporaryPaths.push(root)
    return (await observeConfiguration({ path: join(root, 'missing.toml'), stackId, observedAt: now }))
        .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
}

async function evaluateFixture(values: readonly EnvironmentObservation[]) {
    const stackIds = [...new Set(values.map(({ stackId: value }) => value))]
    const contexts = await Promise.all(stackIds.map((value) => context(value)))
    return evaluatePreflight(values, {
        authorities: contexts.map(({ authorities }) => authorities[0]!),
        stages: contexts.map(({ stages }) => stages[0]!),
    })
}

const neverIssued: ObservationDeclaration['isIssued'] = (_value: unknown): _value is EnvironmentObservation => false
const everyStage = Object.freeze([
    { stage: 'bootstrap', disposition: 'required' },
    { stage: 'steady', disposition: 'required' },
] as const)

describe('observation contract and applicability', () => {
    it('keeps producer-issued unavailable configuration through preflight and doctor mandatory checks', async () => {
        const value = await unavailableConfiguration()
        expect(observationSatisfiesExpectation(value)).toBe(false)
        const preflight = aggregateObservations([[value]], await context())
        for (const projection of [preflight, projectDoctor(preflight)]) {
            const check = projection.checks.find(({ owner, code }) => owner === value.owner && code === value.code)
            expect(check).toMatchObject({ verdict: 'unavailable' })
            expect(check).not.toHaveProperty('measured')
            expect(projection.verdict).toBe('unavailable')
        }
    })

    it('permits successful empty evidence only when the declared expectation permits absence', () => {
        const observed = (state: EnvironmentObservation['observed']): EnvironmentObservation => ({
            code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            owner: 'synthetic-owner',
            stackId,
            source: 'synthetic-source',
            observed: state,
            expectation: { kind: 'present' },
            applicability: { state: 'required', posture: 'environment' },
            freshness: { state: 'current' },
            remedy: 'restore the synthetic observation',
        })
        const empty = observed({ state: 'available', value: [], observedAt: now })

        expect(observationSatisfiesExpectation(empty)).toBe(false)
        expect(observationSatisfiesExpectation({ ...empty, expectation: { kind: 'equal', value: [] } })).toBe(true)
        expect(observationSatisfiesExpectation({ ...empty, expectation: { kind: 'one-of', values: [[], ['occupied']] } })).toBe(true)
        expect(observationSatisfiesExpectation(observed({ state: 'available', value: ['occupied'], observedAt: now }))).toBe(true)
        expect(observationSatisfiesExpectation(observed({ state: 'unavailable', reason: 'transport unavailable', observedAt: now }))).toBe(false)
        expect(observationSatisfiesExpectation(observed({ state: 'unavailable', reason: 'authentication unavailable', observedAt: now }))).toBe(false)
        expect(observationSatisfiesExpectation(observed({ state: 'failed', reason: 'explicit unhealthy response', observedAt: now }))).toBe(false)
    })

    it('derives leaf applicability only from the current declared configuration', async () => {
        const plain = await context()
        expect(plain.authorities[0]!.postures).toEqual(['directory-grants', 'environment', 'mounted'])
        const generatedSource = (await readFile(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8'))
            .replace('name = "generated-environment"', 'name = "fixture"')
        const declared = await context(stackId, 'always', generatedSource)
        expect(declared.authorities[0]!.postures).toEqual([
            'data-plane', 'dependencies', 'directory-grants', 'environment', 'external-dependencies', 'generated-environment', 'mounted',
            'registry-authentication', 'running-stack',
        ])
    })

    it('does not issue posture authority from caller-authored mount and revision facts', async () => {
        await expect(resolveObservationPostures({
            stackId, evaluatedAt: now, revision, source: 'cockpit.toml', mounts: ['none'], activeProfiles: [],
        } as never)).rejects.toThrow('configuration source')
    })

    it('carries exact addressing and authentication declarations separately from lifecycle applicability', async () => {
        const declared = await context(stackId, 'always', validConfigSource)
        expect(declared.authorities[0]).toEqual(expect.objectContaining({
            postures: ['directory-grants', 'environment', 'mounted'],
            environmentPostures: { addressing: 'hostname', authentication: 'real' },
        }))

        const omitted = await context(otherStackId, 'always', validConfigSource
            .replace('addressing = "hostname"\n', '')
            .replace('authentication = "real"\n', '')
            .replace('posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]\n', ''))
        expect(omitted.authorities[0]).toEqual(expect.objectContaining({
            environmentPostures: { addressing: null, authentication: null },
        }))
    })

    it('fails preflight when selected postures lack exact bidirectional requirement tags', async () => {
        const complete = await context()
        const completeResult = evaluatePreflight([], complete)
        expect(completeResult.checks.filter(({ owner }) => owner === 'posture-requirements')).toEqual([
            expect.objectContaining({ verdict: 'pass', measured: 'hostname' }),
            expect.objectContaining({ verdict: 'pass', measured: 'real' }),
        ])

        const missing = await context(otherStackId, 'always', validConfigSource
            .replace('posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]\n', ''))
        const missingResult = evaluatePreflight([], missing)
        expect(missingResult.verdict).toBe('fail')
        expect(missingResult.checks.filter(({ owner }) => owner === 'posture-requirements')).toEqual([
            expect.objectContaining({ verdict: 'fail', reason: 'posture requirement catalog is not declared' }),
            expect.objectContaining({ verdict: 'fail', reason: 'posture requirement catalog is not declared' }),
        ])

        const cases = [
            {
                source: validConfigSource.replace(
                    'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]',
                    'posture_requirements = [{ requirement = "synthetic-route", authentication = "real" }]',
                ),
                reason: 'addressing posture hostname is not named by a requirement',
            },
            {
                source: validConfigSource.replace(
                    'addressing = "hostname"\n',
                    'addressing = "port"\n',
                ),
                reason: 'addressing requirement tags do not match selected posture port',
            },
            {
                source: validConfigSource.replace('addressing = "hostname"\n', ''),
                reason: 'addressing posture is not declared',
            },
        ]
        for (const testCase of cases) {
            const issued = await context(stackId, 'always', testCase.source)
            expect(evaluatePreflight([], issued).checks).toEqual(expect.arrayContaining([
                expect.objectContaining({ owner: 'posture-requirements', verdict: 'fail', reason: testCase.reason }),
            ]))
        }
    })

    it('passes a stack with no authentication without inventing a requirement that depends on it', async () => {
        const open = validConfigSource
            .replace('authentication = "real"\n', 'authentication = "none"\n')
            .replace('posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]',
                'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname" }]')
        const passed = evaluatePreflight([], await context(stackId, 'always', open))
        expect(passed.checks.filter(({ owner }) => owner === 'posture-requirements')).toEqual([
            expect.objectContaining({ verdict: 'pass', measured: 'hostname' }),
            expect.objectContaining({ verdict: 'pass', measured: 'none', reason: 'no authentication is declared, and no requirement depends on one' }),
        ])

        // A requirement tagged with a sign-in posture contradicts a stack that has none.
        const contradicted = evaluatePreflight([], await context(otherStackId, 'always', open.replace(
            'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname" }]',
            'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]')))
        expect(contradicted.checks).toEqual(expect.arrayContaining([expect.objectContaining({ owner: 'posture-requirements',
            verdict: 'fail', reason: 'authentication requirement tags do not match selected posture none' })]))
    })

    it('rejects posture authority after the authoritative config changes', async () => {
        const issued = await context(stackId, 'always', validConfigSource, new Date().toISOString())
        const authority = issued.authorities[0]!
        await writeFile(authority.source, validConfigSource.replace('purpose = "synthetic service"', 'purpose = "changed service"'))
        expect(() => evaluatePreflight([], issued)).toThrow('configuration changed after posture resolution')
    })

    it('keeps healthy delayed observations inside one authenticated bounded window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime('2026-09-26T08:00:00.000Z')
        const checkoutPath = join(authorityRoot, 'first')
        temporaryPaths.push(authorityRoot)
        await mkdir(checkoutPath, { recursive: true })
        const configPath = join(checkoutPath, 'cockpit.toml')
        await writeFile(configPath, validConfigSource)
        const initialObservedAt = new Date().toISOString()
        const initialConfiguration = (await observeConfiguration({ stackId, observedAt: initialObservedAt, path: configPath }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
        const initial = await resolveObservationPostures({
            configuration: initialConfiguration, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })
        vi.setSystemTime('2026-09-26T08:00:01.000Z')
        const delayedObservationAt = new Date().toISOString()
        const delayed = (await observeConfiguration({ stackId, observedAt: delayedObservationAt, path: configPath }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!

        vi.setSystemTime('2026-09-26T08:00:31.000Z')
        const currentConfiguration = (await observeConfiguration({ stackId, observedAt: new Date().toISOString(), path: configPath }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
        const refreshed = await refreshObservationPostures({
            previous: initial, configuration: currentConfiguration,
            cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })
        const state = await namespace()
        const stage = await resolveLifecycleStage({ namespace: state, stackId, observedAt: new Date().toISOString() })
        if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')

        expect(refreshed.evaluatedAt).toBe(initialObservedAt)
        expect(evaluatePreflight([delayed], { authorities: [refreshed], stages: [stage.authority] }).checks)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: ENVIRONMENT_CODES.CONFIG_STALE, verdict: 'pass' })]))
    })

    it('refuses bounded posture refresh after config drift or the absolute window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime('2026-09-26T08:00:00.000Z')
        const issued = await context(stackId, 'always', validConfigSource, new Date().toISOString())
        const previous = issued.authorities[0]!
        const checkoutPath = dirname(previous.source)
        await writeFile(previous.source, validConfigSource.replace('purpose = "synthetic service"', 'purpose = "changed service"'))
        let current = (await observeConfiguration({ stackId, observedAt: new Date().toISOString(), path: previous.source }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
        await expect(refreshObservationPostures({
            previous, configuration: current, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })).rejects.toThrow('does not match its initial authority')

        await writeFile(previous.source, validConfigSource)
        vi.setSystemTime('2026-09-26T08:05:00.001Z')
        current = (await observeConfiguration({ stackId, observedAt: new Date().toISOString(), path: previous.source }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
        await expect(refreshObservationPostures({
            previous, configuration: current, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })).rejects.toThrow('refresh window expired')
    })

    it('rejects a symlink substituted for the authoritative config', async () => {
        const issued = await context()
        const authority = issued.authorities[0]!
        const replacement = join(dirname(authority.source), 'replacement.toml')
        await writeFile(replacement, validConfigSource)
        await rm(authority.source)
        await symlink(replacement, authority.source)
        expect(() => evaluatePreflight([], issued)).toThrow('configuration changed after posture resolution')
    })

    it('rejects a fifo substituted for the authoritative config without waiting for its contents', async () => {
        const issued = await context()
        const authority = issued.authorities[0]!
        await rm(authority.source)
        await new Promise<void>((resolve, reject) => {
            const child = spawn('mkfifo', [authority.source], { stdio: 'ignore' })
            child.once('error', reject)
            child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)))
        })
        const writer = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))", authority.source, Buffer.from(validConfigSource).toString('base64')], { stdio: 'ignore' })
        try {
            expect(() => evaluatePreflight([], issued)).toThrow('configuration changed after posture resolution')
        } finally {
            writer.kill()
        }
    })

    it('rejects an oversized authoritative config before hashing it', async () => {
        const issued = await context()
        const authority = issued.authorities[0]!
        await writeFile(authority.source, Buffer.alloc(1_048_577, 0x20))
        expect(() => evaluatePreflight([], issued)).toThrow('configuration changed after posture resolution')
    })

    it('rejects stale or substituted configuration evidence for a stack', async () => {
        const checkoutPath = join(authorityRoot, 'first')
        const alternate = join(authorityRoot, 'alternate')
        const adjacent = join(authorityRoot, 'first-neighbor')
        await mkdir(checkoutPath, { recursive: true })
        await mkdir(alternate, { recursive: true })
        await mkdir(adjacent, { recursive: true })
        temporaryPaths.push(authorityRoot)
        await writeFile(join(checkoutPath, 'cockpit.toml'), validConfigSource)
        await writeFile(join(alternate, 'cockpit.toml'), validConfigSource.replace('mount = "always"', 'mount = "none"'))
        await writeFile(join(adjacent, 'cockpit.toml'), validConfigSource)
        await symlink(alternate, join(checkoutPath, 'redirected'), 'dir')
        const ancient = (await observeConfiguration({ stackId, observedAt: '2001-01-01T00:00:00.000Z', path: join(checkoutPath, 'cockpit.toml') }))[1]!
        await expect(resolveObservationPostures({
            configuration: ancient, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })).rejects.toThrow('configuration source')
        for (const path of [
            join(alternate, 'cockpit.toml'),
            join(adjacent, 'cockpit.toml'),
            [checkoutPath, '..', 'alternate', 'cockpit.toml'].join(sep),
            join(checkoutPath, 'redirected', 'cockpit.toml'),
        ]) {
            const substituted = (await observeConfiguration({ stackId, observedAt: new Date().toISOString(), path }))[1]!
            await expect(resolveObservationPostures({
                configuration: substituted, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
            }), path).rejects.toThrow('configuration source')
        }
        const nested = join(checkoutPath, 'control')
        await mkdir(nested)
        await writeFile(join(nested, 'cockpit.toml'), validConfigSource)
        const observedBeforeRedirect = (await observeConfiguration({ stackId, observedAt: new Date().toISOString(), path: join(nested, 'cockpit.toml') }))[1]!
        await rm(nested, { recursive: true })
        await symlink(adjacent, nested, 'dir')
        await expect(resolveObservationPostures({
            configuration: observedBeforeRedirect, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })).rejects.toThrow('configuration changed after observation')
    })

    it('rejects configuration evidence dated after posture authority issuance', async () => {
        const checkoutPath = join(authorityRoot, 'future')
        await mkdir(checkoutPath, { recursive: true })
        temporaryPaths.push(authorityRoot)
        const configPath = join(checkoutPath, 'cockpit.toml')
        await writeFile(configPath, validConfigSource)
        const future = new Date(Date.now() + 20_000).toISOString()
        const configuration = (await observeConfiguration({ stackId: stackFor('future'), observedAt: future, path: configPath }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
        await expect(resolveObservationPostures({
            configuration, cockpitId: authorityCockpitId, checkoutPath, variant: { kind: 'shared' },
        })).rejects.toThrow('configuration source')
    })

    it('rejects an observation minted by the shared contract for another producer', async () => {
        const forged = {
            ...await observation(),
            code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            owner: 'runtime-planning',
            source: 'forged-runtime',
        }

        const evaluationContext = await context()
        expect(() => evaluatePreflight([forged], evaluationContext)).toThrow('producer-issued')
    })

    it('rejects runtime health derived from a caller-authored plan and outcome', () => {
        expect(() => observeRuntimeExecution({
            plan: { steps: [] }, outcome: {}, stackId, coldStartLimitMillis: 1,
        } as never)).toThrow('runtime execution evidence is not authentic')
    })

    it('projects tri-state healthy runtime and mount health only from an executed runtime plan', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-runtime-observation-'))
        temporaryPaths.push(root)
        const dockerPath = join(root, 'docker')
        const script = `#!/bin/sh\nprintf 'services:\\n  app:\\n    volumes:\\n      - /tmp/source:/workspace\\n'\n`
        const composeSource = 'services: {}\n'
        const composePath = join(root, 'compose.yml')
        await writeFile(dockerPath, script)
        await chmod(dockerPath, 0o755)
        await writeFile(composePath, composeSource)
        const executable = resolvedExecutable({
            canonicalPath: dockerPath, invocationPath: dockerPath,
            sha256: createHash('sha256').update(script).digest('hex'), executionMode: 'staged',
        })!
        const planned = createRuntimeAdapter({
            runtime: { name: 'docker', version: '27.1.2', executableSha256: executable.sha256 }, composeVersion: '2.39.2',
            executable, operation: 'validate', cwd: root, stackId, coldStartLimitMillis: 10_000, expectedMountSources: ['/tmp/source'],
            composeFiles: [{ reference: 'compose.yml', canonicalPath: composePath, source: composeSource, sha256: createHash('sha256').update(composeSource).digest('hex') }],
            projectName: 'synthetic-stack', env: {}, ports: [], labels: {}, timeoutMs: 10_000,
        })
        expect(planned.kind).toBe('preview')
        if (planned.kind !== 'preview') return
        const evaluationContext = await context(stackId, 'always', validConfigSource, new Date().toISOString())
        const outcome = await executeProbe(planned.plan.steps[0]!)
        const values = observeRuntimeExecution({ plan: planned.plan, outcome })
        expect(values.map(({ observed }) => observed)).toEqual([
            expect.objectContaining({ state: 'available', value: true }),
            expect.objectContaining({ state: 'available', value: true }),
        ])
        const preflight = aggregateObservations([values], evaluationContext)
        for (const projection of [preflight, projectDoctor(preflight)]) {
            expect(projection.checks.filter(({ owner, code }) => values.some((value) => value.owner === owner && value.code === code)))
                .toEqual(expect.arrayContaining(values.map(({ owner, code }) => expect.objectContaining({ owner, code, verdict: 'pass', measured: true }))))
        }
    })

    it('keeps explicit runtime failure distinct from dependent transport unavailability', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-runtime-failure-observation-'))
        temporaryPaths.push(root)
        const dockerPath = join(root, 'docker')
        const script = '#!/bin/sh\nexit 9\n'
        const composeSource = 'services: {}\n'
        const composePath = join(root, 'compose.yml')
        await writeFile(dockerPath, script)
        await chmod(dockerPath, 0o755)
        await writeFile(composePath, composeSource)
        const executable = resolvedExecutable({
            canonicalPath: dockerPath, invocationPath: dockerPath,
            sha256: createHash('sha256').update(script).digest('hex'), executionMode: 'staged',
        })!
        const planned = createRuntimeAdapter({
            runtime: { name: 'docker', version: '27.1.2', executableSha256: executable.sha256 }, composeVersion: '2.39.2',
            executable, operation: 'validate', cwd: root, stackId, coldStartLimitMillis: 10_000, expectedMountSources: ['/tmp/source'],
            composeFiles: [{ reference: 'compose.yml', canonicalPath: composePath, source: composeSource, sha256: createHash('sha256').update(composeSource).digest('hex') }],
            projectName: 'synthetic-stack', env: {}, ports: [], labels: {}, timeoutMs: 10_000,
        })
        expect(planned.kind).toBe('preview')
        if (planned.kind !== 'preview') return
        const outcome = await executeProbe(planned.plan.steps[0]!)
        const values = observeRuntimeExecution({ plan: planned.plan, outcome })
        const preflight = aggregateObservations([values], await context(stackId, 'always', validConfigSource, new Date().toISOString()))
        for (const projection of [preflight, projectDoctor(preflight)]) {
            expect(projection.checks.find(({ code }) => code === ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE))
                .toMatchObject({ owner: 'runtime-planning', verdict: 'fail', measured: false })
            const unknown = projection.checks.find(({ code }) => code === ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE)
            expect(unknown).toMatchObject({ owner: 'runtime-planning', verdict: 'unavailable' })
            expect(unknown).not.toHaveProperty('measured')
        }
        expect(preflight.verdict).not.toBe('pass')
    })

    it('has local producers for configuration and sibling checks', async () => {
        const siblingRoot = await mkdtemp(join(tmpdir(), 'cockpit-siblings-'))
        temporaryPaths.push(siblingRoot)
        await mkdir(join(siblingRoot, 'service'))
        expect((await observeConfiguration({ stackId, observedAt: now, path: join(siblingRoot, 'missing.toml') }))[1]?.code)
            .toBe(ENVIRONMENT_CODES.CONFIG_STALE)
        expect((await observeSiblingPresence({
            stackId, observedAt: now, siblingRoot,
            sibling: { slug: 'service', dir: 'service', remote: 'https://example.invalid/service.git', mount: 'always', acquire: 'manual', var: 'SERVICE_DIR', purpose: 'synthetic service' },
        })).code)
            .toBe(ENVIRONMENT_CODES.SIBLING_MISSING)
        let rootReads = 0
        const mutableSibling = Object.defineProperty({
            stackId, observedAt: now,
            sibling: { slug: 'service', dir: 'service', remote: 'https://example.invalid/service.git', mount: 'always', acquire: 'manual', var: 'SERVICE_DIR', purpose: 'synthetic service' },
        }, 'siblingRoot', { enumerable: true, get: () => ++rootReads === 1 ? siblingRoot : join(siblingRoot, 'missing') })
        await expect(observeSiblingPresence(mutableSibling as never)).rejects.toThrow('sibling presence input is malformed')
        expect(rootReads).toBe(0)
    })

    it('keeps operation timing and undeclared artifact ceilings outside read-only health', async () => {
        const result = evaluatePreflight([], await context())
        expect(result.checks.map(({ code }) => code)).not.toContain(ENVIRONMENT_CODES.MACHINE_COLD_START_EXCEEDED)
        expect(result.checks.map(({ code }) => code)).not.toContain('DISK_BUDGET_EXCEEDED')
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR)?.verdict).toBe('not-applicable')
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED)).toMatchObject({
            owner: 'generated-environment-application', verdict: 'unavailable',
        })
        expect(ENVIRONMENT_CODES.MACHINE_COLD_START_EXCEEDED).toBe('MACHINE_COLD_START_EXCEEDED')
    })

    it('collects claim, port, and seed state through their owning read paths', async () => {
        const state = await namespace()
        const items = await Promise.all([
            observeClaimState({ namespace: state, stackId, observedAt: now }),
            observePortFamily({ namespace: state, stackId, observedAt: now }),
            observeStateSeed({ namespace: state, stackId, observedAt: now }),
        ])
        expect(items.map(({ code }) => code)).toEqual([
            ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY,
            ENVIRONMENT_CODES.PORT_FAMILY_COLLISION,
            ENVIRONMENT_CODES.STATE_UNSEEDED,
        ])
        const evaluationContext = await context()
        const healthItems = items.filter(({ code }) => code !== ENVIRONMENT_CODES.PORT_FAMILY_COLLISION)
        expect(() => evaluatePreflight(healthItems.map((item) => ({ ...item })), evaluationContext)).toThrow('producer-issued')
        const acquisitionContext = await context()
        expect(() => evaluatePreflight([items[1]!], acquisitionContext)).toThrow('no declared producer authority')
        expect(evaluatePreflight(healthItems, await context()).checks.filter(({ code }) => healthItems.some((item) => item.code === code)).map(({ verdict }) => verdict))
            .toEqual(['not-applicable', 'not-applicable'])
    })

    it('keeps locally required observations active after the first seed', async () => {
        const state = await namespace()
        await recordLifecycleStarted({ namespace: state, stackId, holderId: firstHolder, observedAt: now })
        await recordLifecycleSeeded({ namespace: state, stackId, holderId: firstHolder, observedAt: now })
        const stage = await resolveLifecycleStage({ namespace: state, stackId, observedAt: now })
        if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const generatedSource = (await readFile(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8'))
            .replace('name = "generated-environment"', 'name = "fixture"')
        const posture = await context(stackId, 'always', generatedSource)
        expect(posture.authorities[0]!.postures).toContain('dependencies')
        const checks = evaluatePreflight([stage.observation], {
            authorities: posture.authorities,
            stages: [stage.authority],
        }).checks
        expect(checks.find(({ code }) => code === ENVIRONMENT_CODES.STATE_UNSEEDED)?.verdict).toBe('fail')
        for (const code of [
            ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY,
            ENVIRONMENT_CODES.PORT_FAMILY_COLLISION,
            ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY,
            ENVIRONMENT_CODES.RUNNING_CHECKOUT_MISMATCH,
        ]) expect(checks.find((check) => check.code === code)?.verdict).toBe('unavailable')
    })

    it('keeps empty acquisition listener evidence separate from current runtime health', async () => {
        const state = await namespace()
        const leaseEvidence = await leasePortFamilyFixture({
            namespace: state, stackId, holderId: firstHolder, checkoutId,
            config: { step: 100, count: 2, bases: { WEB: 3000 } }, now, listenerTimeoutMs: 100,
            listenerEvidence: [
                { ports: [3000], observation: { state: 'available', value: [], observedAt: now, producer: 'synthetic-listener-probe' } },
                { ports: [3100], observation: { state: 'available', value: [], observedAt: now, producer: 'synthetic-listener-probe' } },
            ],
        })
        expect(leaseEvidence.kind).toBe('complete')
        if (leaseEvidence.kind !== 'complete') return
        expect((await observePortFamily({ namespace: state, stackId, observedAt: now, leaseEvidence })).observed)
            .toEqual({ state: 'available', value: true, observedAt: now })
        for (const transition of [recordLifecycleStarted, recordLifecycleSeeded]) {
            expect((await transition({ namespace: state, stackId, holderId: firstHolder, observedAt: now })).kind).toBe('complete')
        }
        const stage = await resolveLifecycleStage({ namespace: state, stackId, observedAt: now })
        if (stage.kind !== 'complete') throw new Error('empty listener lifecycle authority was refused')
        const authorities = (await context()).authorities
        const absence = await observePortFamily({ namespace: state, stackId, observedAt: now, leaseEvidence })
        expect(() => aggregateObservations([[absence]], { authorities, stages: [stage.authority] }))
            .toThrow('no declared producer authority')
        expect((await observePortFamily({ namespace: state, stackId, observedAt: now, leaseEvidence: { ...leaseEvidence } })).observed.state)
            .toBe('unavailable')

        const written = await transactState(state, state.paths.coordination(otherStackId), { ownerId: secondHolder, contentionTimeoutMs: 2_000 }, (current) =>
            coordinationStateRecord(state, otherStackId, current, now, {
                holders: [{ holderId: secondHolder, checkoutId, claimedAt: now }],
                lease: { offset: 0, ports: { WEB: 3000 }, released: false, declaration: { step: 100, count: 2, bases: { WEB: 3000 } } },
                lastReleasedHolder: null,
            }))
        expect(written.kind).toBe('complete')
        expect((await observePortFamily({ namespace: state, stackId, observedAt: now, leaseEvidence })).observed)
            .toEqual({ state: 'available', value: false, observedAt: now })
    })

    it('rejects forged-empty listener evidence when a loopback port is occupied', async () => {
        const server = createServer()
        await new Promise<void>((resolveListen, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolveListen)
        })
        try {
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('listener address unavailable')
            const state = await namespace()
            const observedAt = new Date().toISOString()
            const result = await leasePortFamily({
                namespace: state, stackId, holderId: firstHolder, checkoutId,
                config: { step: 1, count: 1, bases: { WEB: address.port } }, now: observedAt, listenerTimeoutMs: 250,
                listenerEvidence: [{ ports: [address.port], observation: {
                    state: 'available', value: [], observedAt, producer: 'caller-authored-empty-evidence',
                } }],
            })
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION }] })
        } finally {
            await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
        }
    })

    it('derives secret presence and key freshness without accepting secret values', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-environment-'))
        temporaryPaths.push(root)
        await writeFile(join(root, '.env.example'), 'PUBLIC_NAME=\nPRIVATE_TOKEN=\n')
        const observations = await observeEnvironmentKeys({
            stackId, observedAt: now, siblingRoot: root,
            declaration: { template: '.env.example', instance: '.env' },
        })
        expect(observations.map(({ code }) => code)).toEqual([
            ENVIRONMENT_CODES.ENVIRONMENT_KEYS_STALE,
            ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND,
        ])
        expect(observations.map(({ observed }) => observed)).toEqual([
            { state: 'available', value: false, observedAt: now },
            { state: 'available', value: false, observedAt: now },
        ])
        expect(JSON.stringify(observations)).not.toContain('PRIVATE_TOKEN=')
        expect(evaluatePreflight(observations, await context()).checks.filter(({ code }) => observations.some((item) => item.code === code)).map(({ verdict }) => verdict))
            .toEqual(['fail', 'fail'])
        let declarationReads = 0
        const mutableDeclaration = Object.defineProperty({ stackId, observedAt: now, siblingRoot: root }, 'declaration', {
            enumerable: true,
            get: () => ++declarationReads === 1 ? { template: '.env.example', instance: '.env' } : { template: 'other', instance: 'other' },
        })
        await expect(observeEnvironmentKeys(mutableDeclaration as never)).rejects.toThrow('environment-key observation input is malformed')
        expect(declarationReads).toBe(0)
    })

    it('derives schema validity from the configuration loader', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-configuration-'))
        temporaryPaths.push(root)
        const path = join(root, 'cockpit.toml')
        await writeFile(path, '[cockpit]\nname = 7\n')
        const observations = await observeConfiguration({ stackId, observedAt: now, path })
        expect(observations.map(({ code }) => code)).toEqual([
            ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            ENVIRONMENT_CODES.CONFIG_STALE,
        ])
        expect(observations.every(({ observed }) => observed.state !== 'available')).toBe(true)
        const evaluationContext = await context()
        expect(() => evaluatePreflight(observations.map((item) => ({ ...item })), evaluationContext)).toThrow('producer-issued')
        const validPath = join(root, 'valid.toml')
        await writeFile(validPath, validConfigSource)
        let pathReads = 0
        const mutablePath = Object.defineProperty({ stackId, observedAt: now }, 'path', {
            enumerable: true, get: () => ++pathReads === 1 ? validPath : path,
        })
        await expect(observeConfiguration(mutablePath as never)).rejects.toThrow('configuration observation input is malformed')
        expect(pathReads).toBe(0)
    })
    it('rejects duplicate mechanism owners and incomplete posture directions', () => {
        expect(validateObservationDeclarations([
            { id: 'machine-memory', owner: 'host-observation', postures: ['environment'], stages: everyStage, code: ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR, isIssued: neverIssued },
            { id: 'other-memory', owner: 'other-owner', postures: ['environment'], stages: everyStage, code: ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR, isIssued: neverIssued },
        ])).toEqual({ kind: 'invalid', reason: `duplicate observation code: ${ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR}` })

        expect(validateObservationDeclarations([
            { id: 'mount-state', owner: 'runtime-planning', postures: ['mounted'], stages: everyStage, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, isIssued: neverIssued },
        ], ['mounted', 'host'])).toEqual({ kind: 'invalid', reason: 'mount-state does not declare posture host' })
    })

    it('requires one bounded, non-contradictory disposition for both lifecycle stages', () => {
        const declaration = {
            id: 'mount-state', owner: 'runtime-planning', postures: ['environment'], stages: everyStage,
            code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, isIssued: neverIssued,
        }
        expect(validateObservationDeclarations([{ ...declaration, stages: everyStage.slice(1) }])).toEqual({
            kind: 'invalid', reason: 'mount-state does not declare lifecycle stage bootstrap',
        })
        expect(validateObservationDeclarations([{ ...declaration, stages: [...everyStage, everyStage[0]] }])).toEqual({
            kind: 'invalid', reason: 'mount-state declares lifecycle stage bootstrap more than once',
        })
        expect(validateObservationDeclarations([{ ...declaration, stages: [
            ...everyStage, { stage: 'retired', disposition: 'required' },
        ] as never }])).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([{ ...declaration, stages: [
            { stage: 'bootstrap', disposition: 'required', reason: 'contradictory' }, everyStage[1],
        ] as never }])).toMatchObject({ kind: 'invalid' })
        for (const reason of ['', 'bad\0reason', 'x'.repeat(1_025)]) {
            expect(validateObservationDeclarations([{ ...declaration, stages: [
                { stage: 'bootstrap', disposition: 'not-applicable', reason }, everyStage[1],
            ] }])).toMatchObject({ kind: 'invalid' })
        }
    })

    it('rejects hostile declaration collections without invoking iterators or accessors', () => {
        const declaration = {
            id: 'mount-state', owner: 'runtime-planning', postures: ['environment'], stages: everyStage,
            code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, isIssued: neverIssued,
        }
        let iteratorCalls = 0
        const declarations = [declaration]
        Object.defineProperty(declarations, Symbol.iterator, { value: () => {
            iteratorCalls += 1
            throw new Error('declaration iterator invoked')
        } })
        expect(validateObservationDeclarations(declarations)).toMatchObject({ kind: 'invalid' })

        const requiredPostures = ['environment']
        Object.defineProperty(requiredPostures, Symbol.iterator, { value: () => {
            iteratorCalls += 1
            throw new Error('posture iterator invoked')
        } })
        expect(validateObservationDeclarations([declaration], requiredPostures)).toMatchObject({ kind: 'invalid' })

        let accessorCalls = 0
        const postures: string[] = []
        Object.defineProperty(postures, '0', { configurable: true, enumerable: true, get: () => {
            accessorCalls += 1
            return 'environment'
        } })
        Object.defineProperty(postures, 'length', { value: 1 })
        expect(validateObservationDeclarations([{ ...declaration, postures }])).toMatchObject({ kind: 'invalid' })

        const accessorDeclaration = { ...declaration }
        Object.defineProperty(accessorDeclaration, 'id', { enumerable: true, get: () => {
            accessorCalls += 1
            return 'mount-state'
        } })
        expect(validateObservationDeclarations([accessorDeclaration])).toMatchObject({ kind: 'invalid' })

        const { proxy, revoke } = Proxy.revocable([declaration], {})
        revoke()
        expect(validateObservationDeclarations(proxy)).toMatchObject({ kind: 'invalid' })

        let proxyTrapCalls = 0
        const traps: ProxyHandler<object> = {
            ownKeys(target) {
                proxyTrapCalls += 1
                return Reflect.ownKeys(target)
            },
            getOwnPropertyDescriptor(target, key) {
                proxyTrapCalls += 1
                return Reflect.getOwnPropertyDescriptor(target, key)
            },
        }
        expect(validateObservationDeclarations(new Proxy([declaration], traps) as never)).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([declaration], new Proxy(['environment'], traps) as never)).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([new Proxy(declaration, traps) as never])).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([{ ...declaration, postures: new Proxy(['environment'], traps) as never }])).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([{ ...declaration, stages: new Proxy([...everyStage], traps) as never }])).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([{ ...declaration, stages: [new Proxy(everyStage[0], traps) as never, everyStage[1]] }])).toMatchObject({ kind: 'invalid' })
        const accessorStages = [...everyStage]
        Object.defineProperty(accessorStages, '0', { enumerable: true, get: () => {
            accessorCalls += 1
            return everyStage[0]
        } })
        expect(validateObservationDeclarations([{ ...declaration, stages: accessorStages }])).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([{ ...declaration, id: Symbol('mount-state') as never }])).toMatchObject({ kind: 'invalid' })
        expect(validateObservationDeclarations([{ ...declaration, postures: [Symbol('environment') as never] }])).toMatchObject({ kind: 'invalid' })
        expect(iteratorCalls).toBe(0)
        expect(accessorCalls).toBe(0)
        expect(proxyTrapCalls).toBe(0)
    })

    it('aggregates each implemented producer from its local declaration', () => {
        expect(validateObservationDeclarations(allObservationDeclarations)).toMatchObject({ kind: 'valid' })
        expect(new Set(allObservationDeclarations.map(({ id }) => id)).size).toBe(allObservationDeclarations.length)
        expect(allObservationDeclarations).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'generated-environment', code: ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE }),
            expect.objectContaining({ id: 'data-mode', code: ENVIRONMENT_CODES.DATA_MODE_UNAVAILABLE }),
            expect.objectContaining({ id: 'external-dependencies', code: ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE }),
        ]))
    })

    it('never turns unavailable or stale required evidence green', async () => {
        const unavailable = await unavailableConfiguration()
        const stale = await observation()
        expect((await evaluateFixture([unavailable])).checks.find(({ code }) => code === unavailable.code)?.verdict).toBe('unavailable')
        const changedSource = `${validConfigSource}# changed\n`
        expect(evaluatePreflight([stale], await context(stackId, 'always', changedSource)).checks.find(({ code }) => code === stale.code)?.verdict).toBe('fail')
    })

    it('keeps not-applicable evidence distinct from missing required evidence', async () => {
        const result = evaluatePreflight([], await context(stackId, 'none'))
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE)?.verdict).toBe('not-applicable')
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)?.verdict).toBe('unavailable')
        expect(evaluatePreflight([], await context(stackId, 'host')).checks.find(({ code }) => code === ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE)?.verdict).toBe('unavailable')
        expect(evaluatePreflight([], await context(stackId, 'profile:web')).checks.find(({ code }) => code === ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE)?.verdict).toBe('unavailable')
    })

    it('requires real surface owners and rejects a fabricated passing surface row', async () => {
        const codes = [ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED,
            ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE,
            ENVIRONMENT_CODES.REGISTRY_AUTH_UNAVAILABLE, ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE]
        for (const code of codes) {
            const declaration = allObservationDeclarations.find(row => row.code === code)
            expect(declaration, code).toBeDefined()
            expect(declaration!.isIssued({ code, observed: { state: 'available', value: true } })).toBe(false)
        }
        const result = evaluatePreflight([], await context())
        expect(result.verdict).toBe('unavailable')
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE)?.verdict).toBe('unavailable')
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE)?.verdict).toBe('unavailable')
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.REGISTRY_AUTH_UNAVAILABLE)?.verdict).toBe('not-applicable')
    })

    it('projects doctor from the same verdict and only adds evidence', async () => {
        const preflight = await evaluateFixture([await observation()])
        const doctor = projectDoctor(preflight)
        expect(doctor.verdict).toBe(preflight.verdict)
        expect(doctor.checks.map(({ verdict }) => verdict)).toEqual(preflight.checks.map(({ verdict }) => verdict))
        expect(doctor.checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)?.evidence).toContain(`measured="${revision}"`)
    })
})

describe('deterministic preflight and doctor', () => {
    it('uses one evaluation instant for every authority boundary check', async () => {
        const issued = await context()
        const instant = Date.parse(issued.authorities[0]!.evaluatedAt)
        const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(instant).mockReturnValue(instant + 60_000)
        try {
            expect(() => evaluatePreflight([], issued)).not.toThrow()
            expect(clock).toHaveBeenCalledTimes(1)
        } finally {
            clock.mockRestore()
        }
    })

    it('marks producer evidence from after the evaluation instant stale', async () => {
        const evaluationTime = '2026-09-08T06:00:00.000Z'
        vi.useFakeTimers()
        vi.setSystemTime(evaluationTime)
        const future = new Date(Date.parse(evaluationTime) + 1_000).toISOString()
        const result = evaluatePreflight(
            [await observation({ observedAt: future })],
            await context(stackId, 'always', validConfigSource, evaluationTime),
        )
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)?.verdict).toBe('fail')
    })

    it('does not let future-dated producer evidence age into validity', async () => {
        const issuedAt = Date.parse('2026-09-08T06:00:00.000Z')
        vi.useFakeTimers()
        vi.setSystemTime(issuedAt)
        const future = new Date(issuedAt + 1_000).toISOString()
        const evidence = await observation({ observedAt: future })
        const evaluationContext = await context(stackId, 'always', validConfigSource, new Date(issuedAt).toISOString())
        expect(evaluatePreflight(
            [evidence],
            evaluationContext,
        ).checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)?.verdict).toBe('fail')

        vi.setSystemTime(issuedAt + 2_000)
        const laterContext = await context(stackId, 'always', validConfigSource, new Date(issuedAt).toISOString())
        expect(evaluatePreflight(
            [evidence],
            laterContext,
        ).checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)?.verdict).toBe('fail')
    })

    it('bounds aggregate inputs without invoking collection accessors or iterators', async () => {
        const issued = await context()
        let iteratorCalls = 0
        const groups = {
            [Symbol.iterator]() {
                iteratorCalls += 1
                return [][Symbol.iterator]()
            },
        }
        expect(() => aggregateObservations(groups as never, issued)).toThrow('bounded dense array')
        expect(iteratorCalls).toBe(0)

        const current = await observation()
        const group = [current]
        Object.defineProperty(group, Symbol.iterator, {
            value: () => {
                iteratorCalls += 1
                return [current][Symbol.iterator]()
            },
        })
        expect(() => aggregateObservations([group], issued)).toThrow('bounded dense array')
        expect(iteratorCalls).toBe(0)

        let accessorCalls = 0
        const oversized = Array(4_097).fill([])
        Object.defineProperty(oversized, '4096', {
            configurable: true,
            enumerable: true,
            get: () => {
                accessorCalls += 1
                return []
            },
        })
        expect(() => aggregateObservations(oversized, issued)).toThrow('bounded dense array')
        expect(accessorCalls).toBe(0)

        let ownKeyCalls = 0
        const hostileOversized = new Proxy(Array(4_097).fill([]), {
            ownKeys() {
                ownKeyCalls += 1
                throw new Error('own keys must not be inspected beyond the collection bound')
            },
        })
        expect(() => aggregateObservations(hostileOversized, issued)).toThrow('bounded dense array')
        expect(ownKeyCalls).toBe(0)
    })

    it('rejects non-array and oversized observation collections without invoking accessors or iterators', async () => {
        const current = await observation()
        const issued = await context()
        let iteratorCalls = 0
        const iterable = {
            [Symbol.iterator]() {
                iteratorCalls += 1
                return [current][Symbol.iterator]()
            },
        }
        expect(() => evaluatePreflight(iterable as never, issued)).toThrow('bounded dense array')
        expect(iteratorCalls).toBe(0)

        let accessorCalls = 0
        const oversized = Array(4_097).fill(current)
        Object.defineProperty(oversized, '4096', {
            configurable: true,
            enumerable: true,
            get: () => {
                accessorCalls += 1
                return current
            },
        })
        expect(() => evaluatePreflight(oversized, issued)).toThrow('bounded dense array')
        expect(accessorCalls).toBe(0)
    })

    it('reports every omitted required declaration as unavailable', async () => {
        const result = evaluatePreflight([], await context())
        expect(result.verdict).toBe('unavailable')
        expect(result.checks.length).toBe(allObservationDeclarations.length + 2)
        expect(result.checks.filter(({ owner }) => owner === 'posture-requirements').every(({ verdict }) => verdict === 'pass')).toBe(true)
        expect(result.checks.filter(({ verdict }) => verdict === 'unavailable').length).toBeGreaterThan(0)
    })

    it('names the differing measured fields when a checkout working tree fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-observation-git-'))
        temporaryPaths.push(root)
        execFileSync('git', ['init', '-b', 'main'], { cwd: root })
        await writeFile(join(root, 'tracked.txt'), 'stable\n')
        execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root })
        await writeFile(join(root, 'tracked.txt'), 'changed\n')
        await writeFile(join(root, 'first.txt'), 'new\n')
        await writeFile(join(root, 'second.txt'), 'new\n')
        const posture = await context(stackId, 'always', validConfigSource, new Date().toISOString())
        const resolved = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
        if (resolved.state !== 'available') throw new Error('fixture Git executable unavailable')
        const step = createGitObservationStep({ executable: resolved.value, checkoutRoot: root, env: {}, timeoutMs: 10_000,
            stackId, source: root, checkoutId })
        if (!step) throw new Error('fixture Git step unavailable')
        const observed = observeGit(step, await executeProbe(step), { stackId, checkoutId, source: root })
        if (observed.kind !== 'complete') throw new Error('fixture Git evidence unavailable')
        expect(evaluatePreflight(observed.observations, posture).checks.find(({ code }) => code === ENVIRONMENT_CODES.GIT_STATE_UNHEALTHY))
            .toMatchObject({
                verdict: 'fail',
                reason: 'observed value does not satisfy the expectation: trackedDirtyCount is 1 (expected 0), untrackedCount is 2 (expected 0)',
            })
    })

    it('makes state seeding not applicable only under issued bootstrap authority', async () => {
        const state = await namespace()
        const stage = await resolveLifecycleStage({ namespace: state, stackId, observedAt: now })
        if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const posture = await context()
        const result = evaluatePreflight([stage.observation], {
            authorities: posture.authorities, stages: [stage.authority],
        })
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.STATE_UNSEEDED)).toMatchObject({
            verdict: 'not-applicable', reason: 'the first seed has not completed',
        })
    })

    it('keeps missing lifecycle data as a steady-state failure after seed history exists', async () => {
        const state = await namespace()
        await recordLifecycleStarted({ namespace: state, stackId, holderId: firstHolder, observedAt: now })
        await recordLifecycleSeeded({ namespace: state, stackId, holderId: firstHolder, observedAt: now })
        const stage = await resolveLifecycleStage({ namespace: state, stackId, observedAt: now })
        if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const posture = await context()
        const result = evaluatePreflight([stage.observation], {
            authorities: posture.authorities, stages: [stage.authority],
        })
        expect(result.checks.find(({ code }) => code === ENVIRONMENT_CODES.STATE_UNSEEDED)).toMatchObject({
            verdict: 'fail', measured: false,
        })
    })

    it('rejects copied, replayed, expired, missing, and wrong-stack stage authority', async () => {
        const firstState = await namespace()
        const firstStage = await resolveLifecycleStage({ namespace: firstState, stackId, observedAt: now })
        if (firstStage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const firstPosture = await context()
        expect(() => evaluatePreflight([], {
            authorities: firstPosture.authorities, stages: [{ ...firstStage.authority }],
        })).toThrow('lifecycle stage authority')
        let proxyTrapCalls = 0
        const proxiedAuthority = new Proxy(firstStage.authority, {
            getOwnPropertyDescriptor: (target, key) => {
                proxyTrapCalls += 1
                return Reflect.getOwnPropertyDescriptor(target, key)
            },
        })
        expect(() => evaluatePreflight([], {
            authorities: firstPosture.authorities, stages: [proxiedAuthority],
        })).toThrow('lifecycle stage authority')
        expect(proxyTrapCalls).toBe(0)
        expect(() => evaluatePreflight([], { authorities: firstPosture.authorities, stages: [] })).toThrow('lifecycle stage authority')

        const replayState = await namespace()
        const replayStage = await resolveLifecycleStage({ namespace: replayState, stackId, observedAt: now })
        if (replayStage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const replayPosture = await context()
        evaluatePreflight([replayStage.observation], { authorities: replayPosture.authorities, stages: [replayStage.authority] })
        const nextPosture = await context()
        expect(() => evaluatePreflight([], {
            authorities: nextPosture.authorities, stages: [replayStage.authority],
        })).toThrow('lifecycle stage authority')

        const otherState = await namespace()
        const otherStage = await resolveLifecycleStage({ namespace: otherState, stackId: otherStackId, observedAt: now })
        if (otherStage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const wrongStackPosture = await context()
        expect(() => evaluatePreflight([], {
            authorities: wrongStackPosture.authorities, stages: [otherStage.authority],
        })).toThrow('lifecycle stage authority')

        vi.useFakeTimers()
        vi.setSystemTime(new Date())
        const expiringState = await namespace()
        const expiring = await resolveLifecycleStage({ namespace: expiringState, stackId, observedAt: new Date().toISOString() })
        if (expiring.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        vi.advanceTimersByTime(31_000)
        const currentPosture = await context(stackId, 'always', validConfigSource, new Date().toISOString())
        expect(() => evaluatePreflight([], {
            authorities: currentPosture.authorities, stages: [expiring.authority],
        })).toThrow('lifecycle stage authority')
    })

    it('uses the complete production declaration set', async () => {
        const result = evaluatePreflight([], await context())
        expect(result.checks).toHaveLength(allObservationDeclarations.length + 2)
    })

    it('requires an explicit timestamp whenever missing evidence is synthesized', async () => {
        const current = await observation()
        const issued = await context()
        expect(() => evaluatePreflight([current], {} as never)).toThrow('resolved posture authority')
        expect(() => evaluatePreflight([current], { authorities: [{ ...issued.authorities[0] }] } as never)).toThrow('resolved posture authority')
    })

    it('derives temporal freshness and is stable across differing timestamp permutations', async () => {
        const otherStack = stackFor('third')
        const later = new Date().toISOString()
        const first = await observation()
        const second = await observation({ stackId: otherStack, observedAt: later })
        const contexts = [await context(stackId, 'always', validConfigSource, later), await context(otherStack, 'always', validConfigSource, later)]
        const result = evaluatePreflight([first, second], {
            authorities: contexts.map(({ authorities }) => authorities[0]!),
            stages: contexts.map(({ stages }) => stages[0]!),
        })
        const reverseContexts = [await context(otherStack, 'always', validConfigSource, later), await context(stackId, 'always', validConfigSource, later)]
        expect(result).toEqual(evaluatePreflight([second, first], {
            authorities: reverseContexts.map(({ authorities }) => authorities[0]!),
            stages: reverseContexts.map(({ stages }) => stages[0]!),
        }))
        expect(result.checks.find(({ stackId: target, code }) => target === stackId && code === ENVIRONMENT_CODES.CONFIG_STALE)?.verdict).toBe('fail')
        expect(evaluatePreflight([second], await context(otherStack)).checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)?.verdict).toBe('pass')
    })

    it('accepts independently completed observations inside overlapping issued windows', async () => {
        const otherStack = stackFor('third')
        const later = new Date().toISOString()
        const first = await observation({ observedAt: now })
        const second = await observation({ stackId: otherStack, observedAt: later })
        const contexts = [await context(stackId, 'always', validConfigSource, now), await context(otherStack, 'always', validConfigSource, later)]
        const checks = evaluatePreflight([first, second], {
            authorities: contexts.map(({ authorities }) => authorities[0]!),
            stages: contexts.map(({ stages }) => stages[0]!),
        }).checks
            .filter(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)
        expect(checks.map(({ verdict }) => verdict)).toEqual(['pass', 'pass'])
    })

    it('keeps mandatory missing owner evidence in the production aggregate', async () => {
        const result = aggregateObservations([], await context())
        expect(result.checks.map(({ code }) => code)).toEqual(expect.arrayContaining([
            ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE,
            ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE, ENVIRONMENT_CODES.REGISTRY_AUTH_UNAVAILABLE, ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE,
        ]))
        expect(result.verdict).toBe('unavailable')
    })

    it('isolates concurrent stacks and canonicalizes completion order', async () => {
        const otherStack = stackFor('third')
        const first = await observation({ stackId: otherStack })
        const second = await observation({ stackId })
        expect(await evaluateFixture([first, second])).toEqual(await evaluateFixture([second, first]))
        const orderedStacks = [stackId, otherStack].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        expect((await evaluateFixture([first, second])).checks.map((check) => check.stackId)).toEqual(
            orderedStacks.flatMap((value) => Array(allObservationDeclarations.length + 2).fill(value)),
        )
    })

    it('represents an empty generated-artifact set without inventing drift', async () => {
        const result = evaluatePreflight([], await context(stackId, 'none'))
        expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
        expect(result.checks.some(({ source }) => source === 'generated-artifacts')).toBe(false)
    })

    it('preserves one nonzero verdict when doctor adds evidence', async () => {
        const mismatch = await observation()
        const preflight = evaluatePreflight([mismatch], await context(stackId, 'always', `${validConfigSource}# changed\n`))
        expect(preflight.verdict).toBe('fail')
        expect(projectDoctor(preflight).checks.find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)).toMatchObject({ verdict: 'fail' })
        expect(() => projectDoctor({ ...preflight })).toThrow('preflight evaluation is not authentic')
    })

    it('orders by code units without consulting the host locale', async () => {
        const original = String.prototype.localeCompare
        String.prototype.localeCompare = () => { throw new Error('locale must not decide protocol order') }
        try {
            expect(evaluatePreflight([await observation() ], {
                ...await context(),
            }).checks).toHaveLength(allObservationDeclarations.length + 2)
        } finally {
            String.prototype.localeCompare = original
        }
    })
})
