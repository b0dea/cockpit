import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cockpitId, checkoutId, holderId, stackId } from '../environment/identity.js'
import { observeConfiguration, selectStateRoot } from '../environment/state.js'
import { resolveLifecycleStage } from '../environment/lifecycle-stage.js'
import { resolveObservationPostures } from '../environment/observations.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { assertBrowserStorageStateCurrent, assertBrowserArtifactRegistration, browserRuntimeControlAuthorities, browserRuntimeCoordination, resolveBrowserRuntime, type BrowserRuntimeInput } from './runtime.js'
import { bindBrowserRuntimePortLease, browserRuntimeExecutionReady } from './runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(addressing = 'hostname', authentication = 'real', tags?: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-')))
    roots.push(root)
    const id = cockpitId({ name: 'fixture', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: id, checkoutId: checkout, variant: { kind: 'shared' } })
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, `[cockpit]\nname = "fixture"\n[[sibling]]\nslug = "web"\ndir = "web"\nmount = "none"\nacquire = "none"\nvar = "WEB_DIR"\npurpose = "Synthetic web"\n[ports.bases]\nWEB = 3000\n[environment]\naddressing = "${addressing}"\nauthentication = "${authentication}"\n${tags === "missing" ? "" : `posture_requirements = ${tags ?? `[{ requirement = "synthetic-browser", addressing = "${addressing}", authentication = "${authentication}" }]`}`}\n` )
    const now = new Date().toISOString()
    const configuration = (await observeConfiguration({ path: configPath, stackId: stack, observedAt: now })).find(({ code }) => code === 'CONFIG_STALE')!
    const authority = await resolveObservationPostures({ configuration, cockpitId: id, checkoutPath: root, variant: { kind: 'shared' } })
    const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId: id })
    if (selected.kind !== 'complete') throw Error('fixture state root refused')
    const stage = await resolveLifecycleStage({ namespace: selected.value, stackId: stack, observedAt: now })
    if (stage.kind !== 'complete') throw Error('fixture lifecycle refused')
    await mkdir(join(root, '.browser/auth'), { recursive: true })
    await writeFile(join(root, '.browser/auth/worker.json'), '{}', { mode: 0o600 })
    const image = (name: string) => ({ reference: `synthetic.invalid/${name}@sha256:${'a'.repeat(64)}`, driverVersion: '1.2.3' })
    const input: BrowserRuntimeInput = {
        postures: { authorities: [authority], stages: [stage.authority] },
        images: { runner: image('runner'), mcp: image('mcp') },
        project: { lockfile: 'package-lock.json', sha256: 'b'.repeat(64), driverVersion: '1.2.3' },
        endpoint: 'ws://localhost:3001/', maxClients: 2,
        proxy: { serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] },
        resolver: addressing === 'hostname' ? [{ hostname: 'app.example.invalid', address: '127.0.0.1' }] : [],
        authentication: authentication === 'real' ? { policy: 'serialized', states: [{ worker: 'shared', path: '.browser/auth/worker.json', source: 'seeded' }] } : { policy: 'none', states: [] },
        data: { mode: 'seeded', isolated: true, reachesProduction: false },
        requestPreapproval: false, headed: false,
        artifacts: { runner: '.browser/runner', mcp: '.playwright-mcp', cli: '.playwright-cli', auth: '.browser/auth', debugger: '.browser/debugger' },
    }
    return { input, root, configPath, namespace: selected.value, stack, checkout }
}

async function attempt(input: BrowserRuntimeInput, coordinationNamespace?: Parameters<typeof resolveBrowserRuntime>[1]) {
    const authority = input.postures.authorities[0]!
    const root = dirname(authority.source)
    const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId: cockpitId({ name: 'fixture', mainCheckoutPath: root }) })
    if (selected.kind !== 'complete') throw Error('fixture state root refused')
    const stage = await resolveLifecycleStage({ namespace: selected.value, stackId: authority.stackId, observedAt: new Date().toISOString() })
    if (stage.kind !== 'complete') throw Error('fixture lifecycle refused')
    return resolveBrowserRuntime({ ...input, postures: { ...input.postures, stages: [stage.authority] } }, coordinationNamespace)
}

describe('shared browser runtime', () => {
    it('binds both pinned clients to one capped server and the exact project lock identity', async () => {
        const { input, configPath } = await fixture()
        const runtime = await attempt(input)
        expect(runtime.configurationPath).toBe(configPath)
        expect(runtime.connection).toEqual({ kind: 'remote', endpoint: input.endpoint, launchLocal: false })
        expect(runtime.runner).toEqual({ image: input.images.runner.reference, project: input.project, endpoint: input.endpoint })
        expect(runtime.mcp).toEqual({ image: input.images.mcp.reference, endpoint: input.endpoint })
        expect(runtime.server).toMatchObject({ maxClients: 1, bind: '127.0.0.1', publish: false })
        expect(runtime.addressing).toEqual({ posture: 'hostname', resolverRules: ['MAP app.example.invalid 127.0.0.1'] })
        expect(runtime.requirements).toEqual([{ requirement: 'synthetic-browser', addressing: 'hostname', authentication: 'real' }])
    })

    it('retains an optional exact issued coordination namespace with the authenticated authority stack', async () => {
        const { input, namespace } = await fixture()
        const runtime = await attempt(input, namespace)
        expect(browserRuntimeCoordination(runtime)).toEqual({ namespace, stackId: input.postures.authorities[0]!.stackId })
        expect(browserRuntimeCoordination(await attempt(input))).toBeUndefined()
        expect(browserRuntimeCoordination({ ...runtime })).toBeUndefined()
        await expect(attempt(input, { ...namespace } as never)).rejects.toThrow('issued canonical')
    })

    it('distinguishes endpoint absence from configured invalid endpoints', async () => {
        const { input } = await fixture('port', 'bypassed')
        const { endpoint: _endpoint, ...withoutEndpoint } = input
        const local = await attempt(withoutEndpoint)
        expect(local.connection).toEqual({ kind: 'local-fallback', reason: 'endpoint-absent', launchLocal: true })
        expect(local.runner).not.toHaveProperty('endpoint')
        expect(local.mcp).not.toHaveProperty('endpoint')
        expect((await attempt(input)).addressing).toEqual({ posture: 'port', resolverRules: null })
        for (const endpoint of ['', 'undefined', 'ws://undefined:3001/', 'http://localhost:3001/', 'ws://user:pass@localhost:3001/', 'ws://localhost:3001/?token=x', 'ws://attacker.invalid:3001/', 'ws://localhost:3002/', 'wss://localhost:3001/']) {
            await expect(attempt({ ...input, endpoint }), endpoint).rejects.toThrow('endpoint')
        }
    })

    it('defaults to chromium and retains only a closed selected browser engine', async () => {
        const { input } = await fixture('port', 'bypassed')
        expect(await attempt(input)).toMatchObject({ server: { engine: 'chromium' }, networkExposure: '<loopback>' })
        for (const engine of ['firefox', 'webkit'] as const) {
            expect((await attempt({ ...input, engine })).server.engine).toBe(engine)
        }
        await expect(attempt({ ...input, engine: 'opera' } as never)).rejects.toThrow('engine')
    })

    it('requires an explicit reason for bounded wider remote network exposure', async () => {
        const { input } = await fixture('port', 'bypassed')
        await expect(attempt({ ...input, networkExposure: '*.example.invalid:443,127.0.0.1:8080',
            networkExposureReason: 'The declared application spans both synthetic endpoints.' }))
            .resolves.toMatchObject({ networkExposure: '*.example.invalid:443,127.0.0.1:8080',
                networkExposureReason: 'The declared application spans both synthetic endpoints.' })
        for (const candidate of [
            { networkExposure: '*' },
            { networkExposure: '<loopback>', networkExposureReason: 'unnecessary' },
            { networkExposure: 'https://example.invalid', networkExposureReason: 'Synthetic wider decision.' },
            { networkExposure: 'example.invalid,', networkExposureReason: 'Synthetic wider decision.' },
            { networkExposure: 'example.invalid/', networkExposureReason: 'Synthetic wider decision.' },
            { networkExposure: '%65xample.invalid', networkExposureReason: 'Synthetic wider decision.' },
            { networkExposure: 'example.invalid:0', networkExposureReason: 'Synthetic wider decision.' },
            { networkExposure: '*.127.0.0.1', networkExposureReason: 'Synthetic wider decision.' },
        ]) await expect(attempt({ ...input, ...candidate })).rejects.toThrow('network exposure')
    })

    it('binds a remote endpoint to the exact retained checkout lease before execution', async () => {
        const { input, namespace, stack, checkout } = await fixture('port', 'bypassed')
        const runtime = await attempt({ ...input, hostVariable: 'BROWSER_PROXY' })
        expect(browserRuntimeExecutionReady(runtime)).toBe(false)
        const observedAt = new Date().toISOString()
        const lease = await leasePortFamilyFixture({ namespace, stackId: stack,
            holderId: holderId({ stackId: stack, checkoutId: checkout, sessionId: 'browser-runtime-fixture' }), checkoutId: checkout,
            config: { step: 100, count: 2, bases: { BROWSER_PROXY: 3001 } }, now: observedAt, listenerTimeoutMs: 100,
            listenerEvidence: [
                { ports: [3001], observation: { state: 'available', value: [3001], observedAt, producer: 'browser-runtime-fixture' } },
                { ports: [3101], observation: { state: 'available', value: [], observedAt, producer: 'browser-runtime-fixture' } },
            ],
        })
        if (lease.kind !== 'complete') throw new Error('browser runtime lease fixture refused')
        const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
        if (entrypoints.kind !== 'complete') throw new Error('browser runtime entrypoint fixture refused')
        const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
        if (!projection) throw new Error('browser runtime projection fixture refused')
        const bound = bindBrowserRuntimePortLease(runtime, projection)
        expect(bound).toMatchObject({ connection: { kind: 'remote', endpoint: 'ws://localhost:3101/' },
            proxy: { port: 3101, allowedHosts: ['localhost:3101'] } })
        expect(browserRuntimeControlAuthorities(bound!)).toContain('localhost:3101')
        expect(browserRuntimeExecutionReady(bound!)).toBe(true)
        expect(bindBrowserRuntimePortLease(runtime, { ...projection } as never)).toBeUndefined()

        const standard = await fixture('port', 'bypassed')
        const standardRuntime = await attempt({ ...standard.input, endpoint: 'ws://localhost:80/session', hostVariable: 'BROWSER_PROXY',
            proxy: { ...standard.input.proxy, proxyPort: 80, allowedHosts: ['localhost:80', '[::1]:80'] } })
        const standardObservedAt = new Date().toISOString()
        const standardLease = await leasePortFamilyFixture({ namespace: standard.namespace, stackId: standard.stack,
            holderId: holderId({ stackId: standard.stack, checkoutId: standard.checkout, sessionId: 'browser-standard-port-fixture' }), checkoutId: standard.checkout,
            config: { step: 100, count: 1, bases: { BROWSER_PROXY: 80 } }, now: standardObservedAt, listenerTimeoutMs: 100,
            listenerEvidence: [{ ports: [80], observation: { state: 'available', value: [], observedAt: standardObservedAt, producer: 'browser-standard-port-fixture' } }],
        })
        if (standardLease.kind !== 'complete') throw new Error('browser standard port lease fixture refused')
        const standardEntrypoints = deriveEntrypoints({ lease: standardLease.lease, declarations: [] })
        if (standardEntrypoints.kind !== 'complete') throw new Error('browser standard port entrypoint fixture refused')
        const standardProjection = projectPortLeaseResult({ leaseResult: standardLease, entrypointResult: standardEntrypoints })
        const standardBound = bindBrowserRuntimePortLease(standardRuntime, standardProjection!)!
        expect(standardBound).toMatchObject({ connection: { endpoint: 'ws://localhost:80/session' },
            proxy: { port: 80, allowedHosts: ['localhost:80', '[::1]:80'] } })
        expect(browserRuntimeControlAuthorities(standardBound)).toEqual(expect.arrayContaining(['localhost:80', '[::1]:80']))
        expect(browserRuntimeControlAuthorities(standardBound)).not.toEqual(expect.arrayContaining(['localhost', '[::1]']))

        const tlsDefault = await fixture('port', 'bypassed')
        const tlsDefaultRuntime = await attempt({ ...tlsDefault.input, endpoint: 'ws://localhost:443/session',
            proxy: { ...tlsDefault.input.proxy, proxyPort: 443, allowedHosts: ['localhost:443'] } })
        expect(browserRuntimeControlAuthorities(tlsDefaultRuntime)).toEqual(expect.arrayContaining(['localhost:443']))
        expect(browserRuntimeControlAuthorities(tlsDefaultRuntime)).not.toContain('localhost')
    })

    it('rejects unpinned images, drifted drivers and invalid client caps', async () => {
        const { input } = await fixture()
        await expect(attempt({ ...input, images: { ...input.images, runner: { ...input.images.runner, reference: 'synthetic.invalid/runner:latest' } } })).rejects.toThrow('pinned')
        await expect(attempt({ ...input, images: { ...input.images, mcp: { ...input.images.mcp, driverVersion: '1.2.4' } } })).rejects.toThrow('driver')
        await expect(attempt({ ...input, project: { ...input.project, sha256: '' } })).rejects.toThrow('lock')
        for (const maxClients of [0, -1, 1.5, Number.NaN, 65]) await expect(attempt({ ...input, maxClients })).rejects.toThrow('cap')
    })

    it('uses the owner checker for missing, mismatched, forged and stale posture authority', async () => {
        for (const tags of ['missing', '[{ requirement = "synthetic-browser", addressing = "port", authentication = "real" }]']) {
            const { input } = await fixture('hostname', 'real', tags)
            await expect(attempt(input)).rejects.toThrow('posture')
        }
        const { input, configPath } = await fixture()
        await expect(attempt({ ...input, postures: { ...input.postures, authorities: [{ ...input.postures.authorities[0]! }] } })).rejects.toThrow('authority')
        await writeFile(configPath, '# changed')
        await expect(attempt(input)).rejects.toThrow('configuration changed')
    })

    it('refuses missing hostname resolution and resolver injection in port posture', async () => {
        const host = await fixture()
        await expect(attempt({ ...host.input, resolver: [] })).rejects.toThrow('resolver')
        const { endpoint: _endpoint, ...localHost } = host.input
        for (const engine of ['firefox', 'webkit'] as const) {
            await expect(attempt({ ...localHost, engine })).rejects.toThrow('local hostname resolver rules require chromium')
        }
        await expect(attempt({ ...host.input, engine: 'firefox' })).resolves.toMatchObject({ server: { engine: 'firefox' } })
        const port = await fixture('port', 'bypassed')
        await expect(attempt({ ...port.input, resolver: host.input.resolver })).rejects.toThrow('resolver')
    })

    it('requires mode-600 seeded states and reports serialization or distinct per-worker state', async () => {
        const { input, root } = await fixture()
        expect((await attempt(input)).authentication).toEqual({ posture: 'real', policy: 'serialized', states: input.authentication.states, claim: 'exclusive' })
        await writeFile(join(root, '.browser/auth/second.json'), '{}', { mode: 0o600 })
        const perWorker = { ...input, authentication: { policy: 'per-worker' as const, states: [...input.authentication.states, { worker: 'second', path: '.browser/auth/second.json', source: 'seeded' as const }] } }
        expect((await attempt(perWorker)).server.maxClients).toBe(2)
        await expect(attempt({ ...perWorker, authentication: { ...perWorker.authentication, states: [input.authentication.states[0]!, input.authentication.states[0]!] } })).rejects.toThrow('distinct')
        await chmod(join(root, '.browser/auth/worker.json'), 0o644)
        await expect(attempt(input)).rejects.toThrow('600')
    })

    it('emits no persona or login path for bypassed auth and keeps headed debugging separate', async () => {
        const { input } = await fixture('port', 'bypassed')
        expect((await attempt(input)).authentication).toEqual({ posture: 'bypassed', policy: 'none', states: [] })
        expect((await attempt(input)).debugger).toEqual({ enabled: false })
        expect((await attempt({ ...input, headed: true })).debugger).toEqual({ enabled: true, separate: true, artifactRoot: '.browser/debugger' })
        await expect(attempt({ ...input, authentication: { policy: 'serialized', states: [] } })).rejects.toThrow('bypassed')
        // A product with no sign-in drives the browser signed out, like a bypassed one, and says which it is.
        const open = await fixture('port', 'none', '[{ requirement = "synthetic-browser", addressing = "port" }]')
        expect((await attempt(open.input)).authentication).toEqual({ posture: 'none', policy: 'none', states: [] })
    })

    it('never grants preapproval to restored, shared or production-reaching data', async () => {
        const { input } = await fixture('port', 'bypassed')
        for (const mode of ['empty', 'seeded'] as const) expect((await attempt({ ...input, requestPreapproval: true, data: { ...input.data, mode } })).preapproval).toBe('eligible')
        for (const data of [{ ...input.data, mode: 'restored' as const }, { ...input.data, isolated: false }, { ...input.data, reachesProduction: true }]) {
            await expect(attempt({ ...input, requestPreapproval: true, data })).rejects.toThrow('preapproval')
        }
        expect((await attempt(input)).preapproval).toBe('not-requested')
    })

    it('returns every transport artifact as a confined, non-overlapping reset declaration', async () => {
        const { input } = await fixture()
        expect((await attempt(input)).generatedHostPaths).toEqual(Object.values(input.artifacts))
        for (const mcp of ['../escape', '/escape', '.browser/auth/nested', '.browser/auth']) {
            await expect(attempt({ ...input, artifacts: { ...input.artifacts, mcp } })).rejects.toThrow('artifact')
        }
    })

    it('refuses accessor-backed inputs before executing the accessor', async () => {
        const { input } = await fixture()
        let calls = 0
        const images = { ...input.images, get runner() { calls += 1; return input.images.runner } }
        await expect(attempt({ ...input, images })).rejects.toThrow('data')
        expect(calls).toBe(0)
    })

    it('requires an issued runtime and a produced output for each transport root', async () => {
        const { input } = await fixture()
        const runtime = await attempt(input)
        const produced = runtime.generatedHostPaths.map((root) => `${root}/output.json`)
        expect(() => assertBrowserArtifactRegistration(runtime, produced)).not.toThrow()
        expect(() => assertBrowserArtifactRegistration({ ...runtime }, produced)).toThrow('issued')
        expect(() => assertBrowserArtifactRegistration(runtime, produced.slice(1))).toThrow('produced')
        expect(() => assertBrowserArtifactRegistration(runtime, [...produced, '.playwright-mcp-neighbor/output.json'])).toThrow('unregistered')
    })

    it('revalidates auth file identity before use without reading its contents', async () => {
        const { input, root } = await fixture()
        const runtime = await attempt(input)
        expect(() => assertBrowserStorageStateCurrent(runtime)).not.toThrow()
        expect(() => assertBrowserStorageStateCurrent({ ...runtime })).toThrow('issued')
        const state = join(root, input.authentication.states[0]!.path)
        await rename(state, `${state}.old`)
        await writeFile(state, '{}', { mode: 0o600 })
        expect(() => assertBrowserStorageStateCurrent(runtime)).toThrow('changed')
    })
})
