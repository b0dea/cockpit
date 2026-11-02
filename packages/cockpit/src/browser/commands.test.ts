import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cockpitId, checkoutId, holderId, stackId } from '../environment/identity.js'
import { resolveLifecycleStage } from '../environment/lifecycle-stage.js'
import { resolveObservationPostures } from '../environment/observations.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { observeConfiguration, selectStateRoot } from '../environment/state.js'
import { executeBrowserCommand, isIssuedBrowserCommandReceipt, issueBrowserRoutePolicy } from './commands.js'
import { bindBrowserRuntimePortLease, resolveBrowserRuntime } from './runtime.js'
import { renderBrowserSurfaces } from './surfaces.js'
import { evaluateUiGate } from './ui-gate.js'

const roots: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

type ModuleMode = 'connect' | 'context' | 'page' | 'goto' | 'aria' | 'screenshot' | 'http-error'
    | 'null-response' | 'redirect-return' | 'final-foreign' | 'same-origin-redirect' | 'popup-cross-origin' | 'control-plane-attempts'
    | 'later-navigation' | 'refused'
    | 'oversize-aria' | 'oversize-screenshot' | 'preexisting-screenshot' | 'swap-root' | 'cleanup' | null

function playwrightModule(input: { logPath: string; serverPath: string; artifactRoot: string; outsideRoot: string; mode: ModuleMode }): string {
    return `const fs = require('node:fs')
const log = value => fs.appendFileSync(${JSON.stringify(input.logPath)}, JSON.stringify(value) + '\\n')
const output = () => { const args = process.argv.slice(1); return args[args.indexOf('--output') + 1] }
const response = (url, status = 200, headers = {}) => ({ url: () => url, status: () => status, headers: () => headers, ok: () => status >= 200 && status < 300 })
const browser = () => ({
    newContext: async options => { log(['newContext', options ?? null]); ${input.mode === 'context' ? "throw new Error('synthetic context failure');" : ''}
      let contextHandler, webSocketHandler
      return { route: async (_pattern, value) => { contextHandler = value }, routeWebSocket: async (_pattern, value) => { webSocketHandler = value },
      newPage: async () => { log(['newPage']); ${input.mode === 'page' ? "throw new Error('synthetic page failure');" : ''}
        let current = 'about:blank', documentSource = 'about:blank', frameNavigatedHandler; const frame = { parentFrame: () => null }
        return {
        route: async () => { throw new Error('page route bypasses context guard') }, mainFrame: () => frame,
        on: (name, handler) => { if (name === 'framenavigated') frameNavigatedHandler = handler },
        goto: async url => { log(['goto', url]); ${input.mode === 'goto' ? "throw new Error('synthetic goto failure');"
          : input.mode === 'refused' ? "throw new Error('page.goto: net::ERR_SOCKS_CONNECTION_FAILED at ' + url + ' synthetic page text');" : 'current = url'};
          if (${JSON.stringify(input.mode)} === 'control-plane-attempts') {
            for (const target of ['http://localhost:3001/control', 'http://127.0.0.1:3000/control', 'http://0.0.0.0:3000/control', 'http://loopback-alias.example.invalid:3000/control', 'https://cdn.example.invalid/asset.js']) await contextHandler({
              abort: async () => log(['blocked-http', target]), continue: async () => log(['network', target])
            }, { url: () => target, isNavigationRequest: () => false, frame: () => ({}) })
            for (const target of ['ws://localhost:3001/control', 'ws://127.0.0.1:3000/control', 'ws://[::ffff:127.0.0.1]:3000/control', 'ws://loopback-alias.example.invalid:3000/control', 'wss://cdn.example.invalid/socket']) await webSocketHandler({
              url: () => target, close: async () => log(['blocked-ws', target]), connectToServer: () => log(['network-ws', target])
            })
          }
          if (${JSON.stringify(input.mode)} === 'popup-cross-origin') {
            const target = 'https://outside.example.invalid/private'
            await contextHandler({ abort: async () => log(['blocked-popup', target]), continue: async () => log(['network', target]) },
              { url: () => target, isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) })
            const childTarget = 'https://cdn.example.invalid/frame'
            await contextHandler({ abort: async () => log(['blocked-child-frame', childTarget]), continue: async () => log(['network-child-frame', childTarget]) },
              { url: () => childTarget, isNavigationRequest: () => true, frame: () => ({ parentFrame: () => frame }) })
          }
          let fulfilled, aborted = false, native = false
          const request = { isNavigationRequest: () => true, frame: () => frame, url: () => url }
          const route = {
            continue: async () => { fulfilled = response(url); native = true }, abort: async () => { aborted = true },
          }
          await contextHandler(route, request)
          if (aborted) throw new Error('synthetic navigation blocked')
          if (native && ${JSON.stringify(input.mode)} === 'redirect-return') {
            log(['network', 'https://outside.example.invalid/private']); log(['network', url]); current = url; documentSource = url; fulfilled = response(url)
          }
          if (native && ${JSON.stringify(input.mode)} === 'final-foreign') {
            current = 'https://outside.example.invalid/private'; documentSource = current; fulfilled = response(current)
          }
          if (native && ${JSON.stringify(input.mode)} === 'same-origin-redirect') {
            current = new URL('/redirected', url).href; documentSource = current; log(['network', current]); fulfilled = response(current)
          }
          if (native) frameNavigatedHandler?.(frame)
          ${input.mode === 'http-error' ? 'fulfilled = response(current, 503)' : ''}
          ${input.mode === 'null-response' ? 'return null' : 'return fulfilled'} },
        url: () => current,
        locator: selector => ({ ariaSnapshot: async () => {
          if (${JSON.stringify(input.mode)} === 'later-navigation') {
            const later = 'http://app.localhost:4000/later'
            let native = false
            await contextHandler({ abort: async () => log(['blocked-later', later]),
              continue: async () => { native = true; log(['network-later', later]) } },
            { url: () => later, isNavigationRequest: () => true, frame: () => frame })
            if (native) documentSource = current + '#pending-navigation'
          }
          log(['ariaSnapshot', selector, current, documentSource]); ${input.mode === 'aria' ? "throw new Error('synthetic aria failure');" : input.mode === 'oversize-aria' ? `return 'x'.repeat(${65_537})` : "return '- document \\\"Synthetic fixture\\\"'"} } }),
        screenshot: async () => { log(['screenshot']); ${input.mode === 'screenshot' ? "throw new Error('synthetic screenshot failure');" : ''}
          ${input.mode === 'preexisting-screenshot' ? "fs.writeFileSync(output(), 'preexisting')" : ''}
          ${input.mode === 'swap-root' ? `fs.renameSync(${JSON.stringify(input.artifactRoot)}, ${JSON.stringify(`${input.artifactRoot}.moved`)}); fs.symlinkSync(${JSON.stringify(input.outsideRoot)}, ${JSON.stringify(input.artifactRoot)})` : ''}
          return ${input.mode === 'oversize-screenshot' ? `Buffer.alloc(${8_388_609})` : "Buffer.from('synthetic screenshot')"} },
        close: async () => { log(['page.close']); ${input.mode === 'cleanup' ? "throw new Error('synthetic cleanup failure')" : ''} }
      } },
      close: async () => log(['context.close'])
    } },
    close: async () => log(['browser.close'])
  })
const browserType = engine => ({
  connect: async (endpoint, options) => {
    ${input.mode === 'connect' ? "throw new Error('synthetic connect failure');" : ''}
    if (!fs.existsSync(${JSON.stringify(input.serverPath)})) throw new Error('shared server unavailable')
    log(['connect', engine, endpoint, options])
    return browser()
  },
  launch: async options => { log(['launch', engine, options]); return browser() }
})
exports.chromium = browserType('chromium')
exports.firefox = browserType('firefox')
exports.webkit = browserType('webkit')
`
}

async function fixture(options: { headed?: boolean; mode?: ModuleMode; engine?: 'chromium' | 'firefox' | 'webkit'; local?: boolean; artifactRoot?: string } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-command-')))
    roots.push(root)
    const id = cockpitId({ name: 'fixture', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: id, checkoutId: checkout, variant: { kind: 'shared' } })
    const config = join(root, 'cockpit.toml')
    await writeFile(config, '[cockpit]\nname = "fixture"\n[[sibling]]\nslug = "web"\ndir = "web"\nmount = "none"\nacquire = "none"\nvar = "WEB_DIR"\npurpose = "Synthetic web"\n[ports.bases]\nWEB = 3000\n[environment]\naddressing = "port"\nauthentication = "bypassed"\nposture_requirements = [{ requirement = "synthetic-browser", addressing = "port", authentication = "bypassed" }]\n')
    const now = new Date().toISOString()
    const observed = (await observeConfiguration({ path: config, stackId: stack, observedAt: now })).find(row => row.code === 'CONFIG_STALE')!
    const authority = await resolveObservationPostures({ configuration: observed, cockpitId: id, checkoutPath: root, variant: { kind: 'shared' } })
    const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId: id })
    if (selected.kind !== 'complete') throw Error('state root refused')
    const stage = await resolveLifecycleStage({ namespace: selected.value, stackId: stack, observedAt: now })
    if (stage.kind !== 'complete') throw Error('lifecycle refused')
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } })
    await writeFile(join(root, 'package-lock.json'), lock)
    const logPath = join(root, 'playwright-calls.jsonl')
    const serverPath = join(root, 'shared-browser-server')
    const outsideRoot = join(root, 'outside-artifacts')
    const artifactRelative = options.artifactRoot ?? '.playwright-cli'
    const artifactRoot = join(root, artifactRelative)
    await writeFile(serverPath, 'alive')
    await mkdir(outsideRoot)
    const moduleBytes = playwrightModule({ logPath, serverPath, artifactRoot, outsideRoot, mode: options.mode ?? null })
    const manifest = JSON.stringify({ name: '@playwright/test', version: '1.2.3', main: 'index.js', bin: { playwright: 'cli.js' } })
    await mkdir(join(root, 'node_modules/@playwright/test'), { recursive: true })
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(join(root, 'node_modules/@playwright/test/package.json'), manifest)
    await writeFile(join(root, 'node_modules/@playwright/test/cli.js'), '/* synthetic pinned CLI */')
    await writeFile(join(root, 'node_modules/@playwright/test/index.js'), moduleBytes)
    const image = `synthetic.invalid/browser@sha256:${'a'.repeat(64)}`
    let runtime = resolveBrowserRuntime({
        postures: { authorities: [authority], stages: [stage.authority] }, images: { runner: { reference: image, driverVersion: '1.2.3' }, mcp: { reference: image, driverVersion: '1.2.3' } },
        project: { lockfile: 'package-lock.json', sha256: digest(lock), driverVersion: '1.2.3' },
        ...(!options.local ? { endpoint: 'ws://localhost:3001/' } : {}), ...(options.engine ? { engine: options.engine } : {}), maxClients: 1,
        proxy: { serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] }, resolver: [], authentication: { policy: 'none', states: [] },
        data: { mode: 'empty', isolated: true, reachesProduction: false }, requestPreapproval: true, headed: options.headed ?? false,
        artifacts: { runner: '.browser/runner', mcp: '.playwright-mcp', cli: artifactRelative, auth: '.browser/auth', debugger: '.browser/debugger' },
    })
    if (runtime.connection.kind === 'remote') {
        const lease = await leasePortFamilyFixture({ namespace: selected.value, stackId: stack,
            holderId: holderId({ stackId: stack, checkoutId: checkout, sessionId: 'browser-command-fixture' }), checkoutId: checkout,
            config: { step: 100, count: 1, bases: { BROWSER_PROXY: 3001 } }, now, listenerTimeoutMs: 100,
            listenerEvidence: [{ ports: [3001], observation: { state: 'available', value: [], observedAt: now, producer: 'browser-command-fixture' } }],
        })
        if (lease.kind !== 'complete') throw new Error('browser command lease fixture refused')
        const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
        if (entrypoints.kind !== 'complete') throw new Error('browser command entrypoint fixture refused')
        const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
        const bound = projection && bindBrowserRuntimePortLease(runtime, projection)
        if (!bound) throw new Error('browser command runtime lease binding refused')
        runtime = bound
    }
    const rendered = renderBrowserSurfaces({ runtime, cockpitDirectory: root, harnesses: [{ target: 'claudecode', version: '2.1.220' }],
        mcp: { name: 'playwright', command: 'docker', args: runtime.connection.kind === 'remote'
            ? ['run', '--rm', '-i', image, '--endpoint', runtime.connection.endpoint] : ['run', '--rm', '-i', image],
            cwd: root, envNames: [], source: { kind: 'core', path: 'mcp.jsonc', sha256: digest('synthetic declaration') } },
        approved: true, testPackage: { directory: 'node_modules/@playwright/test', artifactRoot: artifactRelative,
            manifest: { bytes: manifest, sha256: digest(manifest) }, cli: { path: 'cli.js', bytes: '/* synthetic pinned CLI */', sha256: digest('/* synthetic pinned CLI */') },
            module: { path: 'index.js', bytes: moduleBytes, sha256: digest(moduleBytes) } },
        skillTemplate: await readFile('packages/cockpit/surfaces/skills/cockpit-browser.skill.md', 'utf8') })
    const policy = issueBrowserRoutePolicy(runtime, { origin: 'http://app.localhost:4000', routes: [
        { name: 'home', path: '/' }, { name: 'settings', path: '/settings' }, { name: 'dashboard', path: '/dashboard' },
    ] })
    return { root, runtime, client: rendered.clients[0]!, policy, logPath, serverPath, outsideRoot, artifactRoot }
}

async function calls(path: string): Promise<unknown[]> {
    try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

describe('browser driving commands', () => {
    it('drives every declared route through the fixed project module client and issues application evidence', async () => {
        const { runtime, client, policy, logPath } = await fixture()
        const result = await executeBrowserCommand({ runtime, client, policy, kind: 'drive' })
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.receipt).toMatchObject({ kind: 'drive', activation: 'application', authentication: { posture: 'bypassed' } })
        expect(result.receipt.surfaces.map(row => [row.name, row.url])).toEqual([
            ['home', 'http://app.localhost:4000/'], ['settings', 'http://app.localhost:4000/settings'], ['dashboard', 'http://app.localhost:4000/dashboard'],
        ])
        expect(await calls(logPath)).toContainEqual(['browser.close'])
        expect(isIssuedBrowserCommandReceipt(result.receipt)).toBe(true)
        expect(isIssuedBrowserCommandReceipt({ ...result.receipt })).toBe(false)
        expect(evaluateUiGate({ activating: 'drive', receipts: [result.receipt] })).toEqual({ kind: 'satisfied', activating: 'drive', receipt: result.receipt })
    })

    it('uses the issued engine for remote connections and launches it locally when no endpoint is declared', async () => {
        const remote = await fixture({ engine: 'firefox' })
        await expect(executeBrowserCommand({ runtime: remote.runtime, client: remote.client, policy: remote.policy, kind: 'drive' }))
            .resolves.toMatchObject({ kind: 'complete' })
        expect(await calls(remote.logPath)).toContainEqual([
            'connect', 'firefox', 'ws://localhost:3001/', { timeout: expect.any(Number), exposeNetwork: '<loopback>' },
        ])

        const local = await fixture({ engine: 'webkit', local: true })
        await expect(executeBrowserCommand({ runtime: local.runtime, client: local.client, policy: local.policy, kind: 'drive' }))
            .resolves.toMatchObject({ kind: 'complete' })
        const localCalls = await calls(local.logPath)
        expect(localCalls).toContainEqual(['launch', 'webkit', { headless: true, timeout: expect.any(Number) }])
        expect(localCalls.some(call => Array.isArray(call) && call[0] === 'connect')).toBe(false)
    })

    it('returns only bounded hashes for accessibility and a postchecked mode-600 screenshot', async () => {
        const accessibility = await fixture()
        const a11y = await executeBrowserCommand({ runtime: accessibility.runtime, client: accessibility.client,
            policy: issueBrowserRoutePolicy(accessibility.runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'dashboard', path: '/dashboard' }] }), kind: 'accessibility' })
        expect(a11y.kind).toBe('complete')
        expect(JSON.stringify(a11y)).not.toContain('Synthetic fixture')
        if (a11y.kind === 'complete') expect(a11y.receipt.surfaces[0]).toMatchObject({ accessibility: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: 30 } })

        const screenshot = await fixture()
        const shot = await executeBrowserCommand({ runtime: screenshot.runtime, client: screenshot.client,
            policy: issueBrowserRoutePolicy(screenshot.runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'dashboard', path: '/dashboard' }] }), kind: 'screenshot' })
        expect(shot.kind).toBe('complete')
        if (shot.kind !== 'complete') return
        const evidence = shot.receipt.surfaces[0]!.screenshot!
        expect(evidence.path).toMatch(/^\.playwright-cli\/screenshot-/)
        expect(evidence).toMatchObject({ sha256: digest('synthetic screenshot'), byteLength: 20 })
        expect((await stat(join(screenshot.root, evidence.path))).mode & 0o777).toBe(0o600)

        const nested = await fixture({ artifactRoot: '.browser/cli' })
        const nestedShot = await executeBrowserCommand({ runtime: nested.runtime, client: nested.client,
            policy: issueBrowserRoutePolicy(nested.runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'dashboard', path: '/dashboard' }] }), kind: 'screenshot' })
        expect(nestedShot.kind).toBe('complete')
        if (nestedShot.kind === 'complete') {
            expect(nestedShot.receipt.surfaces[0]!.screenshot!.path).toMatch(/^\.browser\/cli\/screenshot-/)
            expect((await stat(join(nested.root, nestedShot.receipt.surfaces[0]!.screenshot!.path))).mode & 0o777).toBe(0o600)
        }
    })

    it('refuses no-op, echo and suite-runner substitutes because only an issued project client can dispatch', async () => {
        const { runtime, client, policy } = await fixture()
        for (const candidate of [{ ...client }, { executable: process.execPath }, { argv: ['vitest', 'run'] }]) {
            await expect(executeBrowserCommand({ runtime, client: candidate as never, policy, kind: 'drive' }))
                .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('issued project module client') })
        }
    })

    it('refuses caller-supplied coordination state when authentication is bypassed', async () => {
        const { runtime, client, policy, logPath } = await fixture()
        await expect(executeBrowserCommand({ runtime, client, policy, kind: 'drive', state: {
            namespace: {} as never, stackId: 'forged' as never, ownerId: 'forged' as never,
        } })).resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('cannot accept role or state') })
        expect(await calls(logPath)).toEqual([])
    })

    it('refuses undeclared, copied, proxy-authority and cross-origin route policies', async () => {
        const { runtime, client, policy, logPath } = await fixture()
        await expect(executeBrowserCommand({ runtime, client, policy: { ...policy } as never, kind: 'drive' }))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('issued route policy') })
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'ws://app.localhost:4000', routes: [{ name: 'home', path: '/' }] })).toThrow('HTTP')
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'http://localhost:3001', routes: [{ name: 'home', path: '/' }] })).toThrow('browser-control')
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'http://127.0.0.1:3000', routes: [{ name: 'home', path: '/' }] })).toThrow('browser-control')
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'http://loopback-alias.example.invalid:3000', routes: [{ name: 'home', path: '/' }] })).toThrow('browser-control')
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'escape', path: '//outside.invalid/' }] })).toThrow('relative')
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'home', path: '/' }], extra: true } as never)).toThrow('closed')
        expect(() => issueBrowserRoutePolicy(runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'home', path: '/', extra: true } as never] })).toThrow('closed')
        // A remote browser reaches only exposed addresses through this client; anything else it would
        // look for inside its own container, so the command refuses before dispatching.
        const outside = issueBrowserRoutePolicy(runtime, { origin: 'http://app.example.invalid:4000', routes: [{ name: 'home', path: '/' }] })
        const refused = await executeBrowserCommand({ runtime, client, policy: outside, kind: 'drive' })
        expect(refused).toMatchObject({ kind: 'refusal', reason: expect.stringContaining(
            'Browser application origin http://app.example.invalid:4000 is outside browser.network_exposure (<loopback>)') })
        expect(await calls(logPath)).toEqual([])
        const literal = issueBrowserRoutePolicy(runtime, { origin: 'http://[::1]:4000', routes: [{ name: 'home', path: '/' }] })
        expect(await executeBrowserCommand({ runtime, client, policy: literal, kind: 'drive' })).toMatchObject({ kind: 'refusal',
            reason: expect.stringContaining('Browser application origin http://[::1]:4000 is outside browser.network_exposure (<loopback>)') })
        expect(await calls(logPath)).toEqual([])
        const local = await fixture({ local: true })
        await expect(executeBrowserCommand({ runtime: local.runtime, client: local.client, kind: 'drive',
            policy: issueBrowserRoutePolicy(local.runtime, { origin: 'http://app.example.invalid:4000', routes: [{ name: 'home', path: '/' }] }) }))
            .resolves.toMatchObject({ kind: 'complete' })
    })

    it('refuses accessor, proxy and non-closed command inputs before reading them or dispatching', async () => {
        const { runtime, client, policy, logPath } = await fixture()
        const forged = { origin: 'http://outside.invalid', surfaces: [{ name: 'outside', url: 'http://outside.invalid/' }] }
        const attempts: unknown[] = []
        let reads = 0
        const accessor = (key: 'runtime' | 'policy' | 'kind' | 'state', value: unknown) => {
            const input = { runtime, client, policy, kind: 'drive' } as Record<string, unknown>
            Object.defineProperty(input, key, { enumerable: true, get: () => { reads += 1; return value } })
            return input
        }
        const swapping = { runtime, client, kind: 'drive' } as Record<string, unknown>
        Object.defineProperty(swapping, 'policy', { enumerable: true, get: () => { reads += 1; return reads === 1 ? policy : forged } })
        attempts.push(swapping, accessor('runtime', runtime), accessor('kind', 'drive'), accessor('state', {
            namespace: {}, stackId: 'forged', ownerId: 'forged',
        }), { runtime, client, policy, kind: 'drive', extra: true })
        const nestedState = { namespace: {}, stackId: 'forged' } as Record<string, unknown>
        Object.defineProperty(nestedState, 'ownerId', { enumerable: true, get: () => { reads += 1; return 'forged' } })
        attempts.push({ runtime, client, policy, kind: 'drive', state: nestedState })
        attempts.push({ runtime, client, policy, kind: 'drive', state: new Proxy({ namespace: {}, stackId: 'forged', ownerId: 'forged' }, {
            get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver) },
        }) })
        attempts.push(new Proxy({ runtime, client, policy, kind: 'drive' }, { get(target, key, receiver) {
            reads += 1
            return Reflect.get(target, key, receiver)
        } }))
        attempts.push({ runtime: new Proxy(runtime, {}), client, policy, kind: 'drive' })
        for (const input of attempts) {
            await expect(executeBrowserCommand(input as never)).resolves.toMatchObject({ kind: 'refusal' })
        }
        expect(reads).toBe(0)
        expect(await calls(logPath)).toEqual([])
    })

    it('requires a successful HTTP navigation response before issuing driving evidence', async () => {
        for (const mode of ['http-error', 'null-response'] as const) {
            const failed = await fixture({ mode })
            await expect(executeBrowserCommand({ runtime: failed.runtime, client: failed.client, policy: failed.policy, kind: 'drive' }))
                .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('drive') })
        }
        const unavailable = await fixture({ mode: 'http-error' })
        expect(await executeBrowserCommand({ runtime: unavailable.runtime, client: unavailable.client, policy: unavailable.policy, kind: 'drive' }))
            .toEqual({ kind: 'refusal', reason: 'Browser drive operation failed during navigation (navigation) for home: '
                + 'http://app.localhost:4000/ answered HTTP 503, and a surface must answer 2xx' })
    })

    it('uses browser-native redirects and issues evidence only for an application document', async () => {
        const redirected = await fixture({ mode: 'redirect-return' })
        const result = await executeBrowserCommand({ runtime: redirected.runtime, client: redirected.client,
            policy: redirected.policy, kind: 'drive' })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind === 'complete') expect(result.receipt.surfaces).toEqual([
            { name: 'home', url: 'http://app.localhost:4000/' },
            { name: 'settings', url: 'http://app.localhost:4000/settings' },
            { name: 'dashboard', url: 'http://app.localhost:4000/dashboard' },
        ])
        expect(await calls(redirected.logPath)).toContainEqual(['network', 'https://outside.example.invalid/private'])

        const foreign = await fixture({ mode: 'final-foreign' })
        await expect(executeBrowserCommand({ runtime: foreign.runtime, client: foreign.client,
            policy: foreign.policy, kind: 'drive' })).resolves.toMatchObject({ kind: 'refusal' })

        const popup = await fixture({ mode: 'popup-cross-origin' })
        await expect(executeBrowserCommand({ runtime: popup.runtime, client: popup.client,
            policy: popup.policy, kind: 'drive' })).resolves.toMatchObject({ kind: 'complete' })
        expect(await calls(popup.logPath)).toContainEqual(['blocked-popup', 'https://outside.example.invalid/private'])
        expect(await calls(popup.logPath)).not.toContainEqual(['network', 'https://outside.example.invalid/private'])
        expect(await calls(popup.logPath)).toContainEqual(['network-child-frame', 'https://cdn.example.invalid/frame'])
        expect(await calls(popup.logPath)).not.toContainEqual(['blocked-child-frame', 'https://cdn.example.invalid/frame'])
    })

    it('blocks browser control-plane HTTP and WebSocket traffic while retaining external application traffic', async () => {
        const attempted = await fixture({ mode: 'control-plane-attempts' })
        await expect(executeBrowserCommand({ runtime: attempted.runtime, client: attempted.client,
            policy: attempted.policy, kind: 'drive' })).resolves.toMatchObject({ kind: 'complete' })
        const observed = await calls(attempted.logPath)
        expect(observed).toContainEqual(['blocked-http', 'http://localhost:3001/control'])
        expect(observed).toContainEqual(['blocked-ws', 'ws://localhost:3001/control'])
        expect(observed).toContainEqual(['blocked-http', 'http://127.0.0.1:3000/control'])
        expect(observed).toContainEqual(['blocked-ws', 'ws://127.0.0.1:3000/control'])
        expect(observed).toContainEqual(['blocked-http', 'http://0.0.0.0:3000/control'])
        expect(observed).toContainEqual(['blocked-http', 'http://loopback-alias.example.invalid:3000/control'])
        expect(observed).toContainEqual(['blocked-ws', 'ws://[::ffff:127.0.0.1]:3000/control'])
        expect(observed).toContainEqual(['blocked-ws', 'ws://loopback-alias.example.invalid:3000/control'])
        expect(observed).not.toContainEqual(['network', 'http://localhost:3001/control'])
        expect(observed).not.toContainEqual(['network-ws', 'ws://localhost:3001/control'])
        expect(observed).not.toContainEqual(['network', 'http://127.0.0.1:3000/control'])
        expect(observed).not.toContainEqual(['network-ws', 'ws://127.0.0.1:3000/control'])
        expect(observed).toContainEqual(['network', 'https://cdn.example.invalid/asset.js'])
        expect(observed).toContainEqual(['network-ws', 'wss://cdn.example.invalid/socket'])
    })

    it('follows same-origin redirects and reports the validated terminal response URL', async () => {
        const redirected = await fixture({ mode: 'same-origin-redirect' })
        const policy = issueBrowserRoutePolicy(redirected.runtime, {
            origin: 'http://app.localhost:4000', routes: [{ name: 'start', path: '/start' }],
        })
        const result = await executeBrowserCommand({ runtime: redirected.runtime, client: redirected.client, policy, kind: 'drive' })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind === 'complete') expect(result.receipt.surfaces).toEqual([
            { name: 'start', url: 'http://app.localhost:4000/redirected' },
        ])
        expect(await calls(redirected.logPath)).toContainEqual(['network', 'http://app.localhost:4000/redirected'])

        const later = await fixture({ mode: 'later-navigation' })
        const laterPolicy = issueBrowserRoutePolicy(later.runtime, {
            origin: 'http://app.localhost:4000', routes: [{ name: 'start', path: '/start' }],
        })
        const laterResult = await executeBrowserCommand({ runtime: later.runtime, client: later.client,
            policy: laterPolicy, kind: 'accessibility' })
        expect(laterResult).toMatchObject({ kind: 'refusal' })
        expect(await calls(later.logPath)).toContainEqual([
            'ariaSnapshot', 'body', 'http://app.localhost:4000/start', 'http://app.localhost:4000/start#pending-navigation',
        ])
    })

    it('disconnects one connected client without destroying the shared server used by the next client', async () => {
        const c = await fixture()
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive' }))
            .resolves.toMatchObject({ kind: 'complete' })
        expect(await readFile(c.serverPath, 'utf8')).toBe('alive')
        await expect(executeBrowserCommand({ runtime: c.runtime, client: c.client, policy: c.policy, kind: 'drive' }))
            .resolves.toMatchObject({ kind: 'complete' })
    })

    it('refuses oversized observations and an output path occupied before exclusive creation', async () => {
        for (const [mode, kind] of [
            ['oversize-aria', 'accessibility'], ['oversize-screenshot', 'screenshot'], ['preexisting-screenshot', 'screenshot'],
        ] as const) {
            const failed = await fixture({ mode })
            await expect(executeBrowserCommand({ runtime: failed.runtime, client: failed.client, policy: failed.policy, kind }))
                .resolves.toMatchObject({ kind: 'refusal' })
        }
    })

    it('creates no outside file when the registered screenshot root is replaced during capture', async () => {
        const linked = await fixture()
        await rm(linked.artifactRoot, { recursive: true })
        await symlink(linked.outsideRoot, linked.artifactRoot)
        await expect(executeBrowserCommand({ runtime: linked.runtime, client: linked.client, policy: linked.policy, kind: 'screenshot' }))
            .resolves.toMatchObject({ kind: 'refusal' })
        expect(await readdir(linked.outsideRoot)).toEqual([])

        const swapped = await fixture({ mode: 'swap-root' })
        await expect(executeBrowserCommand({ runtime: swapped.runtime, client: swapped.client, policy: swapped.policy, kind: 'screenshot' }))
            .resolves.toMatchObject({ kind: 'refusal' })
        expect(await readdir(swapped.outsideRoot)).toEqual([])
    })

    it('reports the sanitized failing phase and closes every resource created before a failure', async () => {
        for (const [mode, expected, phase, category] of [
            ['connect', [], 'connect', 'availability'],
            ['context', [['browser.close']], 'context', 'setup'],
            ['page', [['context.close'], ['browser.close']], 'navigation', 'navigation'],
            ['goto', [['page.close'], ['context.close'], ['browser.close']], 'navigation', 'navigation'],
            ['aria', [['page.close'], ['context.close'], ['browser.close']], 'accessibility', 'observation'],
            ['screenshot', [['page.close'], ['context.close'], ['browser.close']], 'screenshot', 'observation'],
            ['preexisting-screenshot', [['page.close'], ['context.close'], ['browser.close']], 'artifact', 'artifact'],
            ['cleanup', [['page.close'], ['context.close'], ['browser.close']], 'cleanup', 'cleanup'],
        ] as const) {
            const failed = await fixture({ mode })
            const kind = mode === 'aria' ? 'accessibility' : mode === 'screenshot' || mode === 'preexisting-screenshot' ? 'screenshot' : 'drive'
            const result = await executeBrowserCommand({ runtime: failed.runtime, client: failed.client, policy: failed.policy, kind })
            expect(result).toEqual({ kind: 'refusal',
                reason: `Browser ${kind} operation failed during ${phase} (${category}) for home` })
            if (result.kind !== 'refusal') throw new Error('expected browser operation refusal')
            expect(result.reason).not.toContain('synthetic')
            const observed = mode === 'connect' ? [] : await calls(failed.logPath)
            for (const call of expected) expect(observed, `${mode} cleanup`).toContainEqual(call)
        }
        // A browser network error crosses as its code alone, with what to check next.
        const unanswered = await fixture({ mode: 'refused' })
        const config = join(unanswered.root, 'cockpit.toml')
        const result = await executeBrowserCommand({ runtime: unanswered.runtime, client: unanswered.client, policy: unanswered.policy, kind: 'drive' })
        expect(result).toEqual({ kind: 'refusal', reason: 'Browser drive operation failed during navigation (navigation) for home: '
            + 'nothing answered at http://app.localhost:4000/ (ERR_SOCKS_CONNECTION_FAILED); check that the application is up with '
            + `npx --no cockpit doctor --config ${config}` })
        expect(JSON.stringify(result)).not.toContain('synthetic page text')
    })

    it('refuses headed use without an authenticated persistent debugger endpoint', async () => {
        const { runtime, client, policy } = await fixture({ headed: true })
        expect(await executeBrowserCommand({ runtime, client, policy, kind: 'drive', headed: true }))
            .toEqual({ kind: 'refusal', reason: 'Headed browser use requires an authenticated foreground debugger preparation for the current runtime' })
        expect(await executeBrowserCommand({ runtime, client, policy, kind: 'drive', headed: true,
            debugger: Object.freeze({ kind: 'foreground-browser-debugger', cwd: client.cwd,
                launcher: Object.freeze({ path: `${client.cwd}/.cockpit/browser/runner.sh`, sha256: 'a'.repeat(64) }),
                argv: Object.freeze(['forged']), deadlineSeconds: 3600, foreground: true }) as never }))
            .toEqual({ kind: 'refusal', reason: 'Headed browser use requires an authenticated foreground debugger preparation for the current runtime' })
    })
})
