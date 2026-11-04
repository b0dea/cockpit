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
import { resolveBrowserRuntime } from './runtime.js'
import { renderBrowserSurfaces } from './surfaces.js'
import { evaluateUiGate } from './ui-gate.js'

const roots: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

type ModuleMode = 'connect' | 'context' | 'page' | 'goto' | 'screenshot' | 'http-error'
    | 'null-response' | 'redirect-return' | 'final-foreign' | 'same-origin-redirect' | 'popup-cross-origin' | 'control-plane-attempts'
    | 'later-navigation' | 'refused' | 'findings' | 'flood'
    | 'oversize-screenshot' | 'preexisting-screenshot' | 'swap-root' | 'remove-screenshot' | 'cleanup' | null

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
        const handlers = {}; const emit = (name, value) => { for (const handler of handlers[name] ?? []) handler(value) }
        return {
        route: async () => { throw new Error('page route bypasses context guard') }, mainFrame: () => frame,
        waitForLoadState: async () => undefined,
        on: (name, handler) => { if (name === 'framenavigated') frameNavigatedHandler = handler; (handlers[name] ??= []).push(handler) },
        goto: async url => { log(['goto', url]); ${input.mode === 'goto' ? "throw new Error('synthetic goto failure');"
          : input.mode === 'refused' ? "throw new Error('page.goto: net::ERR_SOCKS_CONNECTION_FAILED at ' + url + ' synthetic page text');" : 'current = url'};
          if (${JSON.stringify(input.mode)} === 'control-plane-attempts') {
            for (const target of ['http://localhost:3001/control', 'http://127.0.0.1:3000/control', 'http://0.0.0.0:3000/control', 'http://loopback-alias.example.invalid:3000/control', 'https://cdn.example.invalid/asset.js',
              'http://127.0.0.1:5432/private', 'http://api.localhost:4000/data', 'http://[::1]:8080/private', 'http://app.localhost:4000/asset.js', 'data:text/plain,inline']) await contextHandler({
              abort: async () => log(['blocked-http', target]), continue: async () => log(['network', target])
            }, { url: () => target, isNavigationRequest: () => false, frame: () => ({}) })
            for (const target of ['ws://localhost:3001/control', 'ws://127.0.0.1:3000/control', 'ws://[::ffff:127.0.0.1]:3000/control', 'ws://loopback-alias.example.invalid:3000/control', 'wss://cdn.example.invalid/socket',
              'ws://localhost:6000/socket', 'ws://app.localhost:4000/live']) await webSocketHandler({
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
          if (${JSON.stringify(input.mode)} === 'findings' && url.endsWith('/settings')) {
            // Every sensitive part is present so a leak into the observation would show: query strings, console text, error messages, bodies, headers.
            const own = (path, method = 'GET') => ({ url: () => 'http://app.localhost:4000' + path, method: () => method, isNavigationRequest: () => false, frame: () => frame,
              failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }) })
            const reply = (request, status) => ({ url: request.url, status: () => status, request: () => request, text: async () => 'secret-body', headers: () => ({ authorization: 'secret-header' }) })
            const message = (type, line) => ({ type: () => type, text: () => 'secret console text', location: () => ({ url: 'http://app.localhost:4000/assets/app.js?token=secret', lineNumber: line }) })
            emit('console', message('error', 12)); emit('console', message('warning', 3)); emit('console', message('warning', 4)); emit('console', message('log', 5))
            emit('pageerror', Object.assign(new TypeError('secret error message'), { stack: 'secret stack' }))
            emit('response', reply(own('/api/items?token=secret'), 404)); emit('response', reply(own('/api/ok'), 200))
            emit('requestfailed', own('/api/save', 'POST'))
            emit('requestfailed', { ...own('/api/slow'), failure: () => ({ errorText: 'net::ERR_ABORTED' }) })
            const foreign = path => ({ ...own(path), url: () => 'https://cdn.example.test' + path })
            emit('request', foreign('/lib.js')); emit('request', foreign('/pixel.gif')); emit('request', own('/api/items'))
            emit('response', reply(foreign('/lib.js'), 500)); emit('requestfailed', foreign('/pixel.gif'))
            emit('response', reply({ ...own('/settings'), isNavigationRequest: () => true, frame: () => frame }, 404))
          }
          if (${JSON.stringify(input.mode)} === 'flood') for (let line = 0; line < 25; line++) emit('console', { type: () => 'error', location: () => ({ url: 'http://app.localhost:4000/app.js', lineNumber: line }) })
          ${input.mode === 'http-error' ? 'fulfilled = response(current, 503)' : ''}
          ${input.mode === 'null-response' ? 'return null' : 'return fulfilled'} },
        url: () => current,
        screenshot: async () => {
          if (${JSON.stringify(input.mode)} === 'later-navigation') {
            const later = 'http://app.localhost:4000/later'
            let native = false
            await contextHandler({ abort: async () => log(['blocked-later', later]),
              continue: async () => { native = true; log(['network-later', later]) } },
            { url: () => later, isNavigationRequest: () => true, frame: () => frame })
            if (native) documentSource = current + '#pending-navigation'
          }
          log(['screenshot', current, documentSource]); ${input.mode === 'screenshot' ? "throw new Error('synthetic screenshot failure');" : ''}
          ${input.mode === 'preexisting-screenshot' ? "fs.writeFileSync(output(), 'preexisting')" : ''}
          ${input.mode === 'swap-root' ? `fs.renameSync(${JSON.stringify(input.artifactRoot)}, ${JSON.stringify(`${input.artifactRoot}.moved`)}); fs.symlinkSync(${JSON.stringify(input.outsideRoot)}, ${JSON.stringify(input.artifactRoot)})` : ''}
          return ${input.mode === 'oversize-screenshot' ? `Buffer.alloc(${8_388_609})` : "Buffer.from('synthetic screenshot')"} },
        close: async () => { log(['page.close']); ${input.mode === 'remove-screenshot' ? 'fs.rmSync(output())' : ''}; ${input.mode === 'cleanup' ? "throw new Error('synthetic cleanup failure')" : ''} }
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

async function fixture(options: { mode?: ModuleMode; engine?: 'chromium' | 'firefox' | 'webkit'; local?: boolean; artifactRoot?: string; absentArtifactRoot?: boolean } = {}) {
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
    if (!options.absentArtifactRoot) await mkdir(artifactRoot, { recursive: true })
    await writeFile(join(root, 'node_modules/@playwright/test/package.json'), manifest)
    await writeFile(join(root, 'node_modules/@playwright/test/cli.js'), '/* synthetic pinned CLI */')
    await writeFile(join(root, 'node_modules/@playwright/test/index.js'), moduleBytes)
    const image = `synthetic.invalid/browser@sha256:${'a'.repeat(64)}`
    const runtime = resolveBrowserRuntime({
        postures: { authorities: [authority], stages: [stage.authority] }, images: { mcp: { reference: image, driverVersion: '1.2.3' } },
        project: { lockfile: 'package-lock.json', sha256: digest(lock), driverVersion: '1.2.3' },
        ...(!options.local ? { endpoint: 'ws://localhost:3001/' } : {}), ...(options.engine ? { engine: options.engine } : {}), maxClients: 1,
        proxy: { serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] }, resolver: [], authentication: { policy: 'none', states: [] },
        data: { mode: 'empty', isolated: true, reachesProduction: false }, requestPreapproval: true,
        artifacts: { mcp: '.playwright-mcp', cli: artifactRelative, auth: '.browser/auth' },
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

const cleanRoute = { verdict: 'clean', diagnostics: { consoleErrors: 0, consoleWarnings: 0, pageErrors: 0, failedRequests: 0, abortedRequests: 0,
    thirdParty: { requests: 0, failed: 0 }, entries: [], omitted: 0 } }

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
        expect(result.receipt.surfaces.map(row => [row.verdict, row.diagnostics])).toEqual(Array(3).fill([cleanRoute.verdict, cleanRoute.diagnostics]))
        expect(result.receipt.verdict).toBe('clean')
        expect(isIssuedBrowserCommandReceipt(result.receipt)).toBe(true)
        expect(isIssuedBrowserCommandReceipt({ ...result.receipt })).toBe(false)
        expect(evaluateUiGate({ activating: 'drive', receipts: [result.receipt] })).toEqual({ kind: 'satisfied', activating: 'drive', receipt: result.receipt })
    })

    it('reports per-route findings as identifiers and counts, keeps third parties apart and caps the entries', async () => {
        const found = await fixture({ mode: 'findings' })
        const result = await executeBrowserCommand({ runtime: found.runtime, client: found.client, policy: found.policy, kind: 'drive' })
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.receipt.verdict).toBe('findings')
        expect(result.receipt.surfaces.map(row => [row.name, row.verdict])).toEqual([['home', 'clean'], ['settings', 'findings'], ['dashboard', 'clean']])
        // Query strings, console and error text, bodies and headers never reach the receipt; warnings, aborted
        // requests and third-party failures are counted but are not findings.
        expect(result.receipt.surfaces[1]!.diagnostics).toEqual({
            consoleErrors: 1, consoleWarnings: 2, pageErrors: 1, failedRequests: 2, abortedRequests: 1,
            thirdParty: { requests: 2, failed: 2 }, omitted: 0,
            entries: [{ kind: 'console', path: '/assets/app.js', line: 12 }, { kind: 'pageerror', name: 'TypeError' },
                { kind: 'request', method: 'GET', path: '/api/items', status: 404 }, { kind: 'request', method: 'POST', path: '/api/save', failure: 'ERR_CONNECTION_REFUSED' }],
        })
        expect(JSON.stringify(result.receipt)).not.toMatch(/secret|token/)

        const flood = await fixture({ mode: 'flood' })
        const capped = await executeBrowserCommand({ runtime: flood.runtime, client: flood.client, policy: flood.policy, kind: 'drive' })
        if (capped.kind !== 'complete') throw new Error('flood drive refused')
        expect(capped.receipt.surfaces[0]!.diagnostics).toMatchObject({ consoleErrors: 25, omitted: 5 })
        expect(capped.receipt.surfaces[0]!.diagnostics!.entries).toHaveLength(20)
    })

    it('drives only the route named by its declared name or path and refuses an undeclared one before launching', async () => {
        const { runtime, client, policy, logPath } = await fixture()
        for (const route of ['settings', '/settings']) {
            const result = await executeBrowserCommand({ runtime, client, policy, kind: 'drive', route })
            expect(result.kind === 'complete' && result.receipt.surfaces.map(row => row.name)).toEqual(['settings'])
        }
        expect((await calls(logPath)).filter(call => Array.isArray(call) && call[0] === 'goto')).toEqual([
            ['goto', 'http://app.localhost:4000/settings'], ['goto', 'http://app.localhost:4000/settings']])
        const before = (await calls(logPath)).length
        expect(await executeBrowserCommand({ runtime, client, policy, kind: 'drive', route: 'billing' })).toEqual({ kind: 'refusal',
            reason: 'Browser route "billing" is not declared; declared routes are home (/), settings (/settings), dashboard (/dashboard)' })
        expect((await calls(logPath)).length).toBe(before)
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

    it('returns a bounded hash and a postchecked mode-600 screenshot', async () => {
        const screenshot = await fixture()
        const shot = await executeBrowserCommand({ runtime: screenshot.runtime, client: screenshot.client,
            policy: issueBrowserRoutePolicy(screenshot.runtime, { origin: 'http://app.localhost:4000', routes: [{ name: 'dashboard', path: '/dashboard' }] }), kind: 'screenshot' })
        expect(shot.kind).toBe('complete')
        if (shot.kind !== 'complete') return
        const evidence = shot.receipt.surfaces[0]!.screenshot!
        expect(evidence.path).toMatch(/^\.playwright-cli\/screenshot-/)
        expect(evidence).toMatchObject({ sha256: digest('synthetic screenshot'), byteLength: 20 })
        expect((await stat(join(screenshot.root, evidence.path))).mode & 0o777).toBe(0o600)

        const nested = await fixture({ artifactRoot: '.browser/cli', absentArtifactRoot: true })
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
            { name: 'home', url: 'http://app.localhost:4000/', ...cleanRoute },
            { name: 'settings', url: 'http://app.localhost:4000/settings', ...cleanRoute },
            { name: 'dashboard', url: 'http://app.localhost:4000/dashboard', ...cleanRoute },
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

    it('blocks browser control-plane and other host traffic while retaining application and external traffic', async () => {
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

        // Another loopback origin is the host, through the runner's tunnel or directly for a local
        // browser, and the operation was given only the application's origin on it.
        const local = await fixture({ mode: 'control-plane-attempts', local: true })
        await expect(executeBrowserCommand({ runtime: local.runtime, client: local.client,
            policy: local.policy, kind: 'drive' })).resolves.toMatchObject({ kind: 'complete' })
        for (const host of [observed, await calls(local.logPath)]) {
            for (const target of ['http://127.0.0.1:5432/private', 'http://api.localhost:4000/data', 'http://[::1]:8080/private']) {
                expect(host).toContainEqual(['blocked-http', target]); expect(host).not.toContainEqual(['network', target])
            }
            expect(host).toContainEqual(['blocked-ws', 'ws://localhost:6000/socket'])
            for (const target of ['http://app.localhost:4000/asset.js', 'data:text/plain,inline']) expect(host).toContainEqual(['network', target])
            expect(host).toContainEqual(['network-ws', 'ws://app.localhost:4000/live'])
        }
    })

    it('follows same-origin redirects and reports the validated terminal response URL', async () => {
        const redirected = await fixture({ mode: 'same-origin-redirect' })
        const policy = issueBrowserRoutePolicy(redirected.runtime, {
            origin: 'http://app.localhost:4000', routes: [{ name: 'start', path: '/start' }],
        })
        const result = await executeBrowserCommand({ runtime: redirected.runtime, client: redirected.client, policy, kind: 'drive' })
        expect(result).toMatchObject({ kind: 'complete' })
        if (result.kind === 'complete') expect(result.receipt.surfaces).toEqual([
            { name: 'start', url: 'http://app.localhost:4000/redirected', ...cleanRoute },
        ])
        expect(await calls(redirected.logPath)).toContainEqual(['network', 'http://app.localhost:4000/redirected'])

        const later = await fixture({ mode: 'later-navigation' })
        const laterPolicy = issueBrowserRoutePolicy(later.runtime, {
            origin: 'http://app.localhost:4000', routes: [{ name: 'start', path: '/start' }],
        })
        const laterResult = await executeBrowserCommand({ runtime: later.runtime, client: later.client,
            policy: laterPolicy, kind: 'screenshot' })
        expect(laterResult).toMatchObject({ kind: 'refusal' })
        expect(await calls(later.logPath)).toContainEqual([
            'screenshot', 'http://app.localhost:4000/start', 'http://app.localhost:4000/start#pending-navigation',
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
            ['oversize-screenshot', 'screenshot'], ['preexisting-screenshot', 'screenshot'],
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

    it('names the filesystem error when the written screenshot cannot be postchecked', async () => {
        // The file vanishes after the operation wrote it and before the postcheck reads it back.
        const gone = await fixture({ mode: 'remove-screenshot' })
        const result = await executeBrowserCommand({ runtime: gone.runtime, client: gone.client, policy: gone.policy, kind: 'screenshot' })
        expect(result).toMatchObject({ kind: 'refusal', reason: expect.stringMatching(
            /^Browser screenshot output failed its contained mode-600 postcheck for home \(ENOENT: .*screenshot-[0-9a-f-]+\.png'\)$/) })
    })

    it('reports the sanitized failing phase and closes every resource created before a failure', async () => {
        for (const [mode, expected, phase, category] of [
            ['connect', [], 'connect', 'availability'],
            ['context', [['browser.close']], 'context', 'setup'],
            ['page', [['context.close'], ['browser.close']], 'navigation', 'navigation'],
            ['goto', [['page.close'], ['context.close'], ['browser.close']], 'navigation', 'navigation'],
            ['screenshot', [['page.close'], ['context.close'], ['browser.close']], 'screenshot', 'observation'],
            ['preexisting-screenshot', [['page.close'], ['context.close'], ['browser.close']], 'artifact', 'artifact'],
            ['cleanup', [['page.close'], ['context.close'], ['browser.close']], 'cleanup', 'cleanup'],
        ] as const) {
            const failed = await fixture({ mode })
            const kind = mode === 'screenshot' || mode === 'preexisting-screenshot' ? 'screenshot' : 'drive'
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
})
