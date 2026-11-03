import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { holderId, cockpitId, checkoutId, stackId } from '../environment/identity.js'
import { resolveLifecycleStage } from '../environment/lifecycle-stage.js'
import { resolveObservationPostures } from '../environment/observations.js'
import { abortStateTransaction, observeConfiguration, readState, selectStateRoot, transactState } from '../environment/state.js'
import { executeBrowserCommand, issueBrowserRoutePolicy } from './commands.js'
import { bindBrowserRuntimePortLease, resolveBrowserRuntime } from './runtime.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { executeBrowserProjectOperation, renderBrowserSurfaces, withBrowserProjectOperationAdmission,
    type BrowserProjectOperationAuthorization } from './surfaces.js'

const roots: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function moduleBytes(logPath: string, mutatePath?: string, mutateOnLoad = false): string {
    return `const fs = require('node:fs')
const log = value => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + '\\n')
${mutateOnLoad && mutatePath ? `fs.writeFileSync(${JSON.stringify(mutatePath)}, '{"changed":true}')` : ''}
const response = url => ({ url: () => url, status: () => 200, headers: () => ({}), ok: () => true })
exports.chromium = { connect: async () => ({
  newContext: async options => { log(['newContext', options ?? null]); let handler; return {
    route: async (_pattern, value) => { handler = value }, routeWebSocket: async () => undefined,
    newPage: async () => { let current = 'about:blank'; const frame = {}; return {
    route: async () => { throw new Error('page route bypasses context guard') }, mainFrame: () => frame, on: () => undefined,
    goto: async url => { current = url; ${mutatePath ? `fs.writeFileSync(${JSON.stringify(mutatePath)}, '{"changed":true}');` : ''}
      let fulfilled, aborted = false
      await handler({ continue: async () => { fulfilled = response(url) }, abort: async () => { aborted = true },
        fetch: async options => response(options.url), fulfill: async options => { fulfilled = options.response ?? response(url, options.status) } },
      { isNavigationRequest: () => true, frame: () => frame, url: () => url })
      if (aborted) throw new Error('synthetic navigation blocked')
      return fulfilled }, url: () => current,
    screenshot: async () => Buffer.from('shot'), close: async () => undefined } }, close: async () => undefined } },
  close: async () => undefined
}) }
`
}

async function fixture(authentication: 'real' | 'bypassed', mutateState: false | 'navigate' | 'module-load' = false,
    policy: 'serialized' | 'per-worker' = 'serialized') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-auth-command-')))
    roots.push(root)
    const listener = createServer()
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('browser authentication fixture port is unavailable')
    const webPort = address.port
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    const id = cockpitId({ name: 'fixture', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: id, checkoutId: checkout, variant: { kind: 'shared' } })
    const owner = holderId({ stackId: stack, checkoutId: checkout, sessionId: 'browser-command-test' })
    const config = join(root, 'cockpit.toml')
    await writeFile(config, `[cockpit]\nname = "fixture"\n[[sibling]]\nslug = "web"\ndir = "web"\nmount = "none"\nacquire = "none"\nvar = "WEB_DIR"\npurpose = "Synthetic web"\n[ports]\nstep = 100\ncount = 1\n[ports.bases]\nWEB = ${webPort}\nBROWSER_PROXY = 3001\n[environment]\naddressing = "port"\nauthentication = "${authentication}"\nposture_requirements = [{ requirement = "synthetic-browser", addressing = "port", authentication = "${authentication}" }]\n`)
    const now = new Date().toISOString()
    const observed = (await observeConfiguration({ path: config, stackId: stack, observedAt: now })).find(row => row.code === 'CONFIG_STALE')!
    const authority = await resolveObservationPostures({ configuration: observed, cockpitId: id, checkoutPath: root, variant: { kind: 'shared' } })
    const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId: id })
    if (selected.kind !== 'complete') throw Error('state root refused')
    const stage = await resolveLifecycleStage({ namespace: selected.value, stackId: stack, observedAt: now })
    if (stage.kind !== 'complete') throw Error('lifecycle refused')
    const statePath = join(root, '.browser/auth/operator.json')
    await mkdir(join(root, '.browser/auth'), { recursive: true })
    await mkdir(join(root, '.playwright-cli'), { recursive: true })
    await writeFile(statePath, '{"synthetic":true}', { mode: 0o600 })
    await writeFile(join(root, '.browser/auth/auditor.json'), '{"synthetic":true}', { mode: 0o600 })
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } })
    await writeFile(join(root, 'package-lock.json'), lock)
    const logPath = join(root, 'playwright-calls.jsonl')
    const module = moduleBytes(logPath, mutateState ? statePath : undefined, mutateState === 'module-load')
    const manifest = JSON.stringify({ name: '@playwright/test', version: '1.2.3', main: 'index.js', bin: { playwright: 'cli.js' } })
    await mkdir(join(root, 'node_modules/@playwright/test'), { recursive: true })
    await writeFile(join(root, 'node_modules/@playwright/test/package.json'), manifest)
    await writeFile(join(root, 'node_modules/@playwright/test/cli.js'), '/* synthetic pinned CLI */')
    await writeFile(join(root, 'node_modules/@playwright/test/index.js'), module)
    const image = `synthetic.invalid/browser@sha256:${'a'.repeat(64)}`
    const unresolved = resolveBrowserRuntime({
        postures: { authorities: [authority], stages: [stage.authority] }, images: { mcp: { reference: image, driverVersion: '1.2.3' } },
        project: { lockfile: 'package-lock.json', sha256: digest(lock), driverVersion: '1.2.3' }, endpoint: 'ws://localhost:3001/', maxClients: policy === 'per-worker' ? 2 : 1,
        proxy: { serverPort: webPort, proxyPort: 3001, allowedHosts: ['localhost:3001'] }, resolver: [],
        authentication: authentication === 'real' ? { policy, states: policy === 'serialized'
            ? [{ worker: 'operator', path: '.browser/auth/operator.json' }]
            : [{ worker: 'operator', path: '.browser/auth/operator.json' }, { worker: 'auditor', path: '.browser/auth/auditor.json' }] } : { policy: 'none', states: [] },
        data: { mode: 'seeded', isolated: true, reachesProduction: false }, requestPreapproval: true,
        artifacts: { mcp: '.playwright-mcp', cli: '.playwright-cli', auth: '.browser/auth' },
    }, authentication === 'real' ? selected.value : undefined)
    const lease = await leasePortFamilyFixture({ namespace: selected.value, stackId: stack, holderId: owner, checkoutId: checkout,
        config: { step: 100, count: 1, bases: { WEB: webPort, BROWSER_PROXY: 3001 } }, now, listenerTimeoutMs: 100,
        listenerEvidence: [{ ports: [webPort, 3001], observation: { state: 'available', value: [], observedAt: now, producer: 'browser-auth-fixture' } }],
    })
    if (lease.kind !== 'complete') throw new Error(`browser authentication lease fixture refused: ${JSON.stringify(lease)}`)
    const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
    if (entrypoints.kind !== 'complete') throw new Error('browser authentication entrypoint fixture refused')
    const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
    const runtime = projection && bindBrowserRuntimePortLease(unresolved, projection)
    if (!runtime) throw new Error('browser authentication runtime lease binding refused')
    if (runtime.connection.kind !== 'remote') throw new Error('fixture expected a remote browser endpoint')
    const rendered = renderBrowserSurfaces({ runtime, cockpitDirectory: root, harnesses: [{ target: 'opencode', version: '1.18.15' }],
        mcp: { name: 'playwright', command: 'docker', args: ['run', '--rm', '-i', image, '--endpoint', runtime.connection.endpoint], cwd: root, envNames: [], source: { kind: 'core', path: 'mcp.jsonc', sha256: digest('synthetic declaration') } }, approved: true,
        testPackage: { directory: 'node_modules/@playwright/test', artifactRoot: '.playwright-cli', manifest: { bytes: manifest, sha256: digest(manifest) },
            cli: { path: 'cli.js', bytes: '/* synthetic pinned CLI */', sha256: digest('/* synthetic pinned CLI */') }, module: { path: 'index.js', bytes: module, sha256: digest(module) } },
        skillTemplate: await readFile('packages/cockpit/surfaces/skills/cockpit-browser.skill.md', 'utf8') })
    return { runtime, client: rendered.clients[0]!, policy: issueBrowserRoutePolicy(runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'account', path: '/account' }] }),
        state: { namespace: selected.value, stackId: stack, ownerId: owner }, statePath, logPath, address: selected.value.paths.coordination(stack) }
}

describe('browser command authentication', () => {
    it('requires current non-replayable lower-level operation admission', async () => {
        const c = await fixture('real')
        const operation = {
            kind: 'drive', surface: { name: 'account', url: 'http://app.localhost:4000/account' },
            deadline: Date.now() + 5_000, role: 'operator',
        } as const
        expect(await executeBrowserProjectOperation(c.client, c.runtime, operation)).toBeUndefined()

        let retained: BrowserProjectOperationAuthorization | undefined
        let firstOutcome: Awaited<ReturnType<typeof executeBrowserProjectOperation>>
        let chainedReplay: Promise<Awaited<ReturnType<typeof executeBrowserProjectOperation>>> | undefined
        const authority = { origin: c.policy.origin, role: 'operator', state: c.state }
        const admission = withBrowserProjectOperationAdmission(c.client, c.runtime, authority, async authorization => {
                retained = authorization
                expect(await executeBrowserProjectOperation(c.client, c.runtime, { ...operation, role: 'auditor' }, authorization)).toBeUndefined()
                const first = executeBrowserProjectOperation(c.client, c.runtime, operation, authorization)
                expect(await executeBrowserProjectOperation(c.client, c.runtime, operation, authorization)).toBeUndefined()
                chainedReplay = first.then(async outcome => {
                    firstOutcome = outcome
                    return executeBrowserProjectOperation(c.client, c.runtime, operation, authorization)
                })
                return 'callback-settled' as const
            })
        authority.role = 'auditor'
        const admitted = await admission
        expect(admitted).toEqual({ kind: 'admitted', value: 'callback-settled' })
        expect(firstOutcome!.kind).toBe('complete')
        expect(await chainedReplay).toBeUndefined()
        expect(await executeBrowserProjectOperation(c.client, c.runtime, operation, retained)).toBeUndefined()

        const replaced = await fixture('real')
        const changed = await withBrowserProjectOperationAdmission(replaced.client, replaced.runtime,
            { origin: replaced.policy.origin, role: 'operator', state: replaced.state }, async authorization => {
                await writeFile(replaced.statePath, '{"changed":true}', { mode: 0o600 })
                return executeBrowserProjectOperation(replaced.client, replaced.runtime, operation, authorization)
            })
        expect(changed.kind === 'admitted' ? changed.value : changed).toBeUndefined()

        await expect(withBrowserProjectOperationAdmission(c.client, c.runtime,
            { origin: 'http://localhost:3001', role: 'operator', state: c.state }, async () => undefined))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('proxy') })
    })

    it('uses seeded state only inside the canonical state lock and publishes no coordination revision', async () => {
        const c = await fixture('real')
        const before = await readState(c.address)
        const result = await executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'operator', state: c.state })
        expect(result.kind).toBe('complete')
        expect(await readState(c.address)).toEqual(before)
        expect(JSON.stringify(result)).not.toMatch(/\.browser\/auth|password|credential|token/i)
        const logged = (await readFile(c.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        expect(logged[0]).toMatchObject(['newContext', { storageState: { synthetic: true }, serviceWorkers: 'block' }])
        if (result.kind === 'complete') expect(result.receipt.authentication).toEqual({ posture: 'real', role: 'operator', policy: 'serialized' })
    })

    it('refuses undeclared roles and a copied or missing coordination authority before dispatch', async () => {
        const c = await fixture('real')
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'missing', state: c.state }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('seeded role') })
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'operator', state: { ...c.state, namespace: { ...c.state.namespace } as never } }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('coordination') })
    })

    it('refuses an authentic coordination record belonging to a different runtime stack', async () => {
        const current = await fixture('real')
        const unrelated = await fixture('real')
        await expect(executeBrowserCommand({ runtime: current.runtime, client: current.client, policy: current.policy,
            kind: 'drive', role: 'operator', state: unrelated.state }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('runtime stack') })
    })

    it('refuses immediate contention, releases the lock, and allows a later authenticated command', async () => {
        const c = await fixture('real')
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        let entered!: () => void
        const acquired = new Promise<void>(resolve => { entered = resolve })
        const unrelatedStack = stackId({ cockpitId: c.address.cockpitId, checkoutId: checkoutId({ checkoutPath: join(c.client.cwd, 'unrelated') }), variant: { kind: 'shared' } })
        const holder = transactState(c.state.namespace, c.state.namespace.paths.coordination(unrelatedStack), { ownerId: c.state.ownerId }, async () => {
            entered(); await held
            return abortStateTransaction({ held: true as const })
        })
        await acquired
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'operator', state: c.state }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('lock') })
        release(); await holder
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'operator', state: c.state }))
            .resolves.toMatchObject({ kind: 'complete' })
    })

    it('runs distinct per-worker roles concurrently without the serialized state lock', async () => {
        const c = await fixture('real', false, 'per-worker')
        const results = await Promise.all(['operator', 'auditor'].map(role => executeBrowserCommand({
            runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role, state: c.state,
        })))
        expect(results).toEqual([expect.objectContaining({ kind: 'complete' }), expect.objectContaining({ kind: 'complete' })])
        expect(results.map(result => result.kind === 'complete' ? result.receipt.authentication : null)).toEqual([
            { posture: 'real', role: 'operator', policy: 'per-worker' }, { posture: 'real', role: 'auditor', policy: 'per-worker' },
        ])
    })

    it('refuses evidence when seeded state changes while the application is being driven', async () => {
        const c = await fixture('real', 'navigate')
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'operator', state: c.state }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('changed while') })
    })

    it('binds seeded-state bytes at process dispatch before loading the browser module', async () => {
        const c = await fixture('real', 'module-load')
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive', role: 'operator', state: c.state }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('drive') })
        await expect(readFile(c.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('creates an empty context for bypassed authentication without sign-in or persona state', async () => {
        const c = await fixture('bypassed')
        const result = await executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive' })
        expect(result.kind).toBe('complete')
        expect(JSON.stringify(result)).not.toMatch(/sign.?in|persona|storageState/i)
        expect((await readFile(c.logPath, 'utf8')).trim()).toContain('["newContext",{"serviceWorkers":"block"}]')
    })
})
