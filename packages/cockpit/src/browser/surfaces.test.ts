import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import { cockpitId, checkoutId, holderId, stackId } from '../environment/identity.js'
import { observeConfiguration, selectStateRoot, type StateNamespace } from '../environment/state.js'
import { resolveLifecycleStage } from '../environment/lifecycle-stage.js'
import { resolveObservationPostures } from '../environment/observations.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { isPackageDescendant } from './package-paths.js'
import { bindBrowserRuntimePortLease, resolveBrowserRuntime } from './runtime.js'
import { executeBrowserProjectOperation, observeBrowserProjectPackage, renderBrowserSurfaces, withBrowserProjectOperationAdmission,
    type BrowserSurfaceInput } from './surfaces.js'

const roots: string[] = []
const fixtureStates = new WeakMap<object, Readonly<{ namespace: StateNamespace; stackId: ReturnType<typeof stackId>; ownerId: ReturnType<typeof holderId> }>>()
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(authentication: 'real' | 'bypassed' = 'bypassed', preapprove = true,
    localHostname = false, nestedProject = false, policy: 'serialized' | 'per-worker' = 'serialized', moduleEntry = 'index.js'): Promise<BrowserSurfaceInput> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-surface-')))
    roots.push(root)
    const id = cockpitId({ name: 'fixture', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: id, checkoutId: checkout, variant: { kind: 'shared' } })
    const configPath = join(root, 'cockpit.toml')
    const addressing = localHostname ? 'hostname' : 'port'
    await writeFile(configPath, `[cockpit]\nname = "fixture"\n[[sibling]]\nslug = "web"\ndir = "web"\nmount = "none"\nacquire = "none"\nvar = "WEB_DIR"\npurpose = "Synthetic web"\n[ports.bases]\nWEB = 3000\n[environment]\naddressing = "${addressing}"\nauthentication = "${authentication}"\nposture_requirements = [{ requirement = "synthetic-browser", addressing = "${addressing}", authentication = "${authentication}" }]\n`)
    const now = new Date().toISOString()
    const configuration = (await observeConfiguration({ path: configPath, stackId: stack, observedAt: now })).find(row => row.code === 'CONFIG_STALE')!
    const authority = await resolveObservationPostures({ configuration, cockpitId: id, checkoutPath: root, variant: { kind: 'shared' } })
    const namespace = await selectStateRoot({ platform: 'linux', home: root, cockpitId: id })
    if (namespace.kind !== 'complete') throw Error('fixture namespace refused')
    const stage = await resolveLifecycleStage({ namespace: namespace.value, stackId: stack, observedAt: now })
    if (stage.kind !== 'complete') throw Error('fixture stage refused')
    await mkdir(join(root, '.browser/auth'), { recursive: true })
    await writeFile(join(root, '.browser/auth/shared.json'), '{}', { mode: 0o600 })
    await writeFile(join(root, '.browser/auth/auditor.json'), '{}', { mode: 0o600 })
    const projectRoot = nestedProject ? join(root, 'app') : root
    const projectManifest = JSON.stringify({ name: 'synthetic-browser-project', dependencies: { '@playwright/test': '1.2.3' } })
    const lockBytes = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } })
    if (nestedProject) await mkdir(projectRoot)
    await writeFile(join(projectRoot, 'package.json'), projectManifest)
    await writeFile(join(projectRoot, 'package-lock.json'), lockBytes)
    const image = `synthetic.invalid/browser@sha256:${'a'.repeat(64)}`
    const unresolved = resolveBrowserRuntime({
        postures: { authorities: [authority], stages: [stage.authority] },
        images: { runner: { reference: image, driverVersion: '1.2.3' }, mcp: { reference: image, driverVersion: '1.2.3' } },
        project: { lockfile: nestedProject ? 'app/package-lock.json' : 'package-lock.json', sha256: digest(lockBytes), driverVersion: '1.2.3',
            ...(nestedProject ? { manifest: 'app/package.json', manifestSha256: digest(projectManifest) } : {}) },
        ...(localHostname ? {} : { endpoint: 'ws://localhost:3001/' }), maxClients: policy === 'per-worker' ? 2 : 1,
        proxy: { serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] },
        resolver: localHostname ? [{ hostname: 'app.example.invalid', address: '127.0.0.1' }] : [],
        authentication: authentication === 'real' ? { policy, states: policy === 'serialized'
            ? [{ worker: 'shared', path: '.browser/auth/shared.json', source: 'seeded' }]
            : [{ worker: 'shared', path: '.browser/auth/shared.json', source: 'seeded' }, { worker: 'auditor', path: '.browser/auth/auditor.json', source: 'seeded' }] } : { policy: 'none', states: [] },
        data: { mode: preapprove ? 'seeded' : 'restored', isolated: true, reachesProduction: false },
        requestPreapproval: preapprove, headed: false,
        artifacts: { runner: '.browser/runner', mcp: '.playwright-mcp', cli: '.playwright-cli', auth: '.browser/auth', debugger: '.browser/debugger' },
    }, authentication === 'real' ? namespace.value : undefined)
    const owner = holderId({ stackId: stack, checkoutId: checkout, sessionId: 'browser-surface-fixture' })
    const lease = await leasePortFamilyFixture({ namespace: namespace.value, stackId: stack,
        holderId: owner, checkoutId: checkout,
        config: { step: 100, count: 1, bases: { BROWSER_PROXY: 3001 } }, now, listenerTimeoutMs: 100,
        listenerEvidence: [{ ports: [3001], observation: { state: 'available', value: [], observedAt: now, producer: 'browser-surface-fixture' } }],
    })
    if (lease.kind !== 'complete') throw new Error('browser surface lease fixture refused')
    const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
    if (entrypoints.kind !== 'complete') throw new Error('browser surface entrypoint fixture refused')
    const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
    const runtime = localHostname ? unresolved : projection && bindBrowserRuntimePortLease(unresolved, projection)
    if (!runtime) throw new Error('browser surface runtime lease binding refused')
    if (!localHostname && runtime.connection.kind !== 'remote') throw new Error('fixture expected a remote browser endpoint')
    const manifest = JSON.stringify({ name: '@playwright/test', version: '1.2.3', main: moduleEntry, bin: { playwright: 'cli.js' } })
    const moduleBytes = localHostname ? `module.exports = { chromium: { launch: async options => {
  if (JSON.stringify(options.args) !== JSON.stringify(['--host-resolver-rules=MAP app.example.invalid 127.0.0.1'])) throw new Error('resolver rules missing')
  let handler; const frame = {}; const response = url => ({ url: () => url, status: () => 200, headers: () => ({}), ok: () => true })
  const page = { route: async () => { throw new Error('page route bypasses context guard') }, mainFrame: () => frame, on: () => undefined,
    goto: async url => { let fulfilled; await handler({ continue: async () => { fulfilled = response(url) }, abort: async () => {},
      fetch: async options => response(options.url), fulfill: async options => { fulfilled = options.response ?? response(url, options.status) } },
      { isNavigationRequest: () => true, frame: () => frame, url: () => url }); return fulfilled },
    url: () => 'https://app.example.invalid/', close: async () => {} }
  const context = { route: async (_pattern, value) => { handler = value }, routeWebSocket: async () => {}, newPage: async () => page, close: async () => {} }
  return { newContext: async () => context, close: async () => {} }
} } }\n` : 'module.exports = { chromium: {} }\n'
    await mkdir(join(projectRoot, 'node_modules/@playwright/test'), { recursive: true })
    await mkdir(join(root, '.playwright-cli'), { recursive: true })
    await writeFile(join(projectRoot, 'node_modules/@playwright/test/package.json'), manifest)
    await writeFile(join(projectRoot, 'node_modules/@playwright/test/cli.js'), '/* synthetic pinned CLI */')
    await writeFile(join(projectRoot, 'node_modules/@playwright/test', moduleEntry), moduleBytes)
    const input: BrowserSurfaceInput = {
        runtime, cockpitDirectory: root,
        harnesses: [{ target: 'claudecode', version: '2.1.220' }, { target: 'codexcli', version: '0.149.0' }, { target: 'opencode', version: '1.18.15' }],
        mcp: { name: 'playwright', command: 'docker', args: ['run', '--rm', '-i', image,
            ...(runtime.connection.kind === 'remote' ? ['--endpoint', runtime.connection.endpoint] : [])], cwd: root, envNames: [], source: { kind: 'core', path: 'mcp.jsonc', sha256: digest('synthetic declaration') } },
        approved: true,
        testPackage: observeBrowserProjectPackage({ runtime, cockpitDirectory: root, artifactRoot: '.playwright-cli' }),
        skillTemplate: await readFile('packages/cockpit/surfaces/skills/cockpit-browser.skill.md', 'utf8'),
    }
    fixtureStates.set(input, Object.freeze({ namespace: namespace.value, stackId: stack, ownerId: owner }))
    return input
}

describe('browser transport surfaces', () => {
    it('confines browser package paths to strict descendants of the package root', () => {
        for (const [root, candidate, expected] of [
            ['/Workspace With Spaces/node_modules/@playwright/test', '/Workspace With Spaces/node_modules/@playwright/test/index.js', true],
            ['/packages/test', '/packages/test', false],
            ['/packages/test', '/packages/test-other/index.js', false],
            ['/packages/test', '/packages/test/../outside.js', false],
            ['/packages/test', '/packages/./test/index.js', false],
        ] as const) expect(isPackageDescendant(root, candidate), candidate).toBe(expected)
    })

    it('resolves the authenticated project package relative to a declared nested manifest', async () => {
        const input = await fixture('bypassed', true, false, true)
        const rendered = renderBrowserSurfaces(input)
        const packageRoot = join(input.cockpitDirectory, 'app/node_modules/@playwright/test')
        expect(rendered.rows.find(row => row.cli)?.cli?.argv[1]).toBe(join(packageRoot, 'cli.js'))
        expect(rendered.clients[0]).toMatchObject({ module: { path: join(packageRoot, 'index.js') },
            manifest: { path: join(packageRoot, 'package.json') } })
        expect(rendered.probes.find(probe => probe.transport === 'cli')?.transportIdentity).toMatchObject({
            manifest: { path: join(packageRoot, 'package.json') },
        })
        await expect(fixture('bypassed', true, false, true, 'serialized', '../outside.js'))
            .rejects.toThrow('module escaped its package root')
        await writeFile(join(input.cockpitDirectory, 'app/package.json'), '{}')
        expect(() => renderBrowserSurfaces(input)).toThrow('project manifest')
    })

    it('applies authenticated hostname resolver rules to local Chromium operations', async () => {
        const input = await fixture('bypassed', true, true)
        const client = renderBrowserSurfaces(input).clients[0]!
        const admitted = await withBrowserProjectOperationAdmission(client, input.runtime, { origin: 'https://app.example.invalid' },
            authorization => executeBrowserProjectOperation(client, input.runtime, {
                kind: 'drive', surface: { name: 'app', url: 'https://app.example.invalid/' }, deadline: Date.now() + 30_000,
            }, authorization))
        expect(admitted.kind === 'admitted' ? admitted.value?.execution.exitCode : undefined).toBe(0)
    })

    it('holds one durable per-worker claim while a different declared worker remains concurrent', async () => {
        const input = await fixture('real', true, false, false, 'per-worker')
        const client = renderBrowserSurfaces(input).clients[0]!
        const state = fixtureStates.get(input)!
        let entered!: () => void
        let release!: () => void
        const acquired = new Promise<void>(resolve => { entered = resolve })
        const held = new Promise<void>(resolve => { release = resolve })
        const first = withBrowserProjectOperationAdmission(client, input.runtime,
            { origin: 'https://app.example.invalid', role: 'shared', state }, async () => {
                entered()
                await held
                return 'shared'
            })
        await acquired

        const contention = await withBrowserProjectOperationAdmission(client, input.runtime,
            { origin: 'https://app.example.invalid', role: 'shared', state }, async () => 'overlap')
        expect(contention).toMatchObject({ kind: 'refusal', reason: expect.stringContaining('claim is contended') })
        const scopes = await readdir(join(state.namespace.cockpitRoot, 'locks/scoped'))
        expect(scopes).toHaveLength(1)
        if (contention.kind !== 'refusal') throw new Error('contended worker claim was admitted')
        expect(contention.reason).toContain(join(state.namespace.cockpitRoot, 'locks/scoped', scopes[0]!, 'state.lock'))
        expect(contention.reason).toContain(state.ownerId)
        expect(contention.reason).toContain('inspect the named holder and retry after it releases the state lock')
        await expect(withBrowserProjectOperationAdmission(client, input.runtime,
            { origin: 'https://app.example.invalid', role: 'auditor', state }, async () => 'auditor'))
            .resolves.toEqual({ kind: 'admitted', value: 'auditor' })
        await expect(withBrowserProjectOperationAdmission(client, input.runtime,
            { origin: 'https://app.example.invalid', role: 'auditor' }, async () => 'missing'))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('authentication authority') })

        release()
        await expect(first).resolves.toEqual({ kind: 'admitted', value: 'shared' })
    })

    it('refuses an arbitrary execution step at the issued project-client boundary without starting it', async () => {
        const input = await fixture()
        const client = renderBrowserSurfaces(input).clients[0]!
        const marker = join(input.cockpitDirectory, 'arbitrary-step-started')
        const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`
        const outcome = await executeBrowserProjectOperation(client, input.runtime, {
            id: 'forged-step', argv: [client.node.path, '-e', script], argv0: client.node.path, cwd: client.cwd,
            env: {}, timeoutMs: 1_000, stdoutLimitBytes: 1_024, stderrLimitBytes: 1_024,
            paths: [], ports: [], labels: {}, expected: [], filesystemChecks: [], compensation: [],
            consumedFiles: [{ path: client.node.path, sha256: client.node.sha256, maxBytes: client.node.maxBytes,
                argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
        } as never)
        expect(outcome).toBeUndefined()
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('renders measured spellings through the shared MCP collector and keeps callable proof held', async () => {
        const input = await fixture()
        const result = renderBrowserSurfaces(input)
        expect(result.rows.map(row => [row.target, row.transport, row.declaration, row.callable])).toEqual([
            ['claudecode', 'mcp', 'instructed', 'human_needed'], ['claudecode', 'cli', 'instructed', 'human_needed'],
            ['codexcli', 'mcp', 'instructed', 'human_needed'], ['codexcli', 'cli', 'unavailable', 'unavailable'],
            ['opencode', 'mcp', 'instructed', 'human_needed'], ['opencode', 'cli', 'instructed', 'human_needed'],
        ])
        expect(result.rows.filter(row => row.transport === 'mcp').map(row => row.tool)).toEqual([
            'mcp__playwright__browser_navigate', 'mcp__playwright__browser_navigate', 'playwright_browser_navigate',
        ])
        expect(result.mcp.kind).toBe('complete')
        if (result.mcp.kind !== 'complete') throw Error('collector refused')
        expect(result.mcp.result.wrappers).toHaveLength(1)
        const files = result.files.filter(file => file.path.endsWith('.json') || file.path.endsWith('.toml') || file.path.endsWith('.jsonc'))
        expect(files.map(file => file.path)).toEqual(['.mcp.json', '.codex/config.toml', 'opencode.jsonc'])
        for (const file of files) expect(file.sha256).toBe(digest(file.bytes))
        const claude = JSON.parse(files[0]!.bytes)
        const codex = parseToml(files[1]!.bytes)
        const open = JSON.parse(files[2]!.bytes)
        const wrapper = join(input.cockpitDirectory, result.mcp.result.wrappers[0]!.path)
        expect(claude).toEqual({ mcpServers: { playwright: { command: '/bin/sh', args: [wrapper] } } })
        expect(codex).toEqual({ mcp_servers: { playwright: { command: '/bin/sh', args: [wrapper], enabled: true, default_tools_approval_mode: 'approve' } } })
        expect(open).toEqual({ mcp: { playwright: { type: 'local', command: ['/bin/sh', wrapper], enabled: true } } })
        expect(result.rows.every(row => row.productState === 'instructed')).toBe(true)
        expect(result.graderBrowserAccess).toBe('retained')
        const evaluator = await readFile('packages/cockpit/surfaces/agents/evaluator.agent.md', 'utf8')
        expect(evaluator).toContain('Retain browser tools')
        expect(evaluator).not.toMatch(/^(?:tools|allowed-tools):/m)
    })

    it('emits the pinned test-package CLI only for measured eligible harnesses', async () => {
        const input = await fixture()
        const rows = renderBrowserSurfaces(input).rows.filter(row => row.transport === 'cli')
        expect(rows[0]!.cli).toEqual({ package: '@playwright/test', version: '1.2.3', argv: ['node', join(input.cockpitDirectory, 'node_modules/@playwright/test/cli.js')], sha256: input.testPackage!.cli.sha256 })
        expect(rows[1]!.cli).toBeNull()
        expect(rows[1]!.reason).toContain('sandbox')
        expect(rows[2]!.cli).toEqual(rows[0]!.cli)
        const unavailable = renderBrowserSurfaces({ ...input, testPackage: null })
        expect(unavailable.rows.filter(row => row.transport === 'cli').every(row => row.declaration === 'unavailable' && row.cli === null)).toBe(true)
        for (const testPackage of [
            { ...input.testPackage!, directory: '../other' },
            { ...input.testPackage!, manifest: { bytes: '{}', sha256: digest('{}') } },
            { ...input.testPackage!, cli: { ...input.testPackage!.cli, sha256: 'f'.repeat(64) } },
        ]) expect(() => renderBrowserSurfaces({ ...input, testPackage })).toThrow('test package')
    })


    it('binds the CLI projection to installed entry-point bytes and the issued lockfile', async () => {
        const input = await fixture()
        await writeFile(join(input.cockpitDirectory, 'node_modules/@playwright/test/cli.js'), '/* altered CLI */')
        expect(() => renderBrowserSurfaces(input)).toThrow('installed bytes')
        const other = await fixture()
        await writeFile(join(other.cockpitDirectory, 'package-lock.json'), '{}')
        expect(() => renderBrowserSurfaces(other)).toThrow('lock identity')
    })

    it('issues a project module client for each exact harness without inventing native CLI support', async () => {
        const input = await fixture()
        const testPackage = input.testPackage
        if (!testPackage?.module) throw new Error('fixture requires the authenticated project module')
        const result = renderBrowserSurfaces(input)
        expect(result.clients.map(client => [client.target, client.version])).toEqual([
            ['claudecode', '2.1.220'], ['codexcli', '0.149.0'], ['opencode', '1.18.15'],
        ])
        const codexOnly = renderBrowserSurfaces({ ...input, harnesses: [{ target: 'codexcli', version: '0.149.0' }] })
        expect(codexOnly.clients.map(client => client.target)).toEqual(['codexcli'])
        expect(codexOnly.rows.find(row => row.transport === 'cli')).toMatchObject({ declaration: 'unavailable', cli: null })
        expect(result.clients[0]).toMatchObject({ package: '@playwright/test', cwd: input.cockpitDirectory,
            artifactRoot: join(input.cockpitDirectory, '.playwright-cli'),
            module: { path: join(input.cockpitDirectory, 'node_modules/@playwright/test/index.js'), sha256: input.testPackage!.module!.sha256 },
            manifest: { path: join(input.cockpitDirectory, 'node_modules/@playwright/test/package.json') },
            lock: { path: join(input.cockpitDirectory, 'package-lock.json'), sha256: input.runtime.runner.project.sha256 },
        })
        expect(renderBrowserSurfaces({ ...input, testPackage: null }).clients).toEqual([])
        expect(() => renderBrowserSurfaces({ ...input, testPackage: { ...testPackage, artifactRoot: '.playwright-mcp' } })).toThrow('artifact root')
        expect(() => renderBrowserSurfaces({ ...input, testPackage: { ...testPackage, module: { ...testPackage.module, path: 'other.js' } } })).toThrow('module entry')
    })

    it('keeps native CLI rows and probes when the optional programmatic client pair is absent', async () => {
        const input = await fixture()
        const { artifactRoot: _artifactRoot, module: _module, ...nativePackage } = input.testPackage!
        const result = renderBrowserSurfaces({ ...input, testPackage: nativePackage })
        expect(result.clients).toEqual([])
        expect(result.rows.filter(row => row.transport === 'cli' && row.declaration === 'instructed')).toHaveLength(2)
        expect(result.probes.filter(probe => probe.transport === 'cli')).toHaveLength(2)
        expect(() => renderBrowserSurfaces({ ...input, testPackage: { ...nativePackage, artifactRoot: '.playwright-cli' } as never })).toThrow('canonical')
        expect(() => renderBrowserSurfaces({ ...input, testPackage: { ...nativePackage, module: input.testPackage!.module } as never })).toThrow('canonical')
    })

    it('omits unsupported versions and unapproved servers without inventing controls', async () => {
        const input = await fixture()
        const unknown = renderBrowserSurfaces({ ...input, harnesses: [{ target: 'claudecode', version: '99.0.0' }] })
        expect(unknown.files).toEqual([])
        expect(unknown.rows.every(row => row.declaration === 'unavailable' && row.callable === 'unavailable')).toBe(true)
        const unapproved = renderBrowserSurfaces({ ...input, approved: false })
        expect(unapproved.rows.filter(row => row.transport === 'mcp').every(row => row.declaration === 'unavailable')).toBe(true)
        expect(unapproved.files.some(file => file.path === '.mcp.json' || file.path === '.codex/config.toml' || file.path === 'opencode.jsonc')).toBe(false)
    })

    it('withdraws the measured Codex approval transport for restored data', async () => {
        const input = await fixture('bypassed', false)
        const result = renderBrowserSurfaces(input)
        const row = result.rows.find(row => row.target === 'codexcli' && row.transport === 'mcp')!
        expect(row).toMatchObject({ declaration: 'unavailable', callable: 'unavailable', tool: null })
        expect(row.reason).toContain('approval')
        expect(result.files.some(file => file.path === '.codex/config.toml')).toBe(false)
        expect(result.files.some(file => file.bytes.includes('default_tools_approval_mode'))).toBe(false)
        expect(result.rows.filter(row => row.target !== 'codexcli' && row.transport === 'mcp').every(row => row.callable === 'human_needed')).toBe(true)
    })

    it('renders dated transport guidance and posture-specific authentication without narrowing grader tools', async () => {
        const bypassed = renderBrowserSurfaces(await fixture())
        const skill = bypassed.files.find(file => file.target === 'claudecode' && file.path.endsWith('/SKILL.md'))!.bytes
        expect(skill).toContain('2.1.220')
        expect(skill).toContain('2026-08-25')
        expect(skill).toContain('human_needed')
        expect(skill).toContain('inapplicable: authentication is bypassed')
        expect(skill).not.toContain('.browser/auth/shared.json')
        expect(skill).not.toMatch(/^allowed-tools:/m)
        expect(skill).not.toContain('{{')
        expect(skill).toContain('name: cockpit-browser')
        for (const step of ['Orient before driving', 'Choose your own coverage', 'cockpit browser-drive', 'Every finding carries evidence', 'Never edit code']) expect(skill).toContain(step)
        expect(skill).toContain('../cockpit-setup/references/test-data-and-personas.md')
        const real = renderBrowserSurfaces(await fixture('real'))
        const realSkill = real.files.find(file => file.target === 'opencode' && file.path.endsWith('/SKILL.md'))!.bytes
        expect(realSkill).toContain('mode-600')
        expect(realSkill).toContain('transcript-safe')
        expect(realSkill).toContain('serialized')
        expect(realSkill).toContain('seeded')
        expect(realSkill).toContain('resolver rules: inapplicable')
        expect(realSkill).toContain('headed')
        expect(realSkill).toContain('mcp: instructed; callable: human_needed')
    })

    it('rejects cloned runtime authority, altered auth metadata and accessor-backed inputs', async () => {
        const input = await fixture('real')
        expect(() => renderBrowserSurfaces({ ...input, runtime: { ...input.runtime } })).toThrow('issued')
        await writeFile(join(input.cockpitDirectory, '.browser/auth/shared.json'), '{"changed":true}')
        expect(() => renderBrowserSurfaces(input)).toThrow('changed')
        let reads = 0
        const fresh = await fixture()
        expect(() => renderBrowserSurfaces({ ...fresh, get approved() { reads++; return true } })).toThrow('data')
        expect(reads).toBe(0)
    })
})
