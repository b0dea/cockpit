import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cockpitId, checkoutId, holderId, stackId } from '../environment/identity.js'
import { observeConfiguration, selectStateRoot } from '../environment/state.js'
import { resolveLifecycleStage } from '../environment/lifecycle-stage.js'
import { resolveObservationPostures } from '../environment/observations.js'
import { bindBrowserRuntimePortLease, resolveBrowserRuntime } from './runtime.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { renderBrowserSurfaces, validateBrowserNativeReceipt, type BrowserSurfaceInput, type BrowserNativeProbe } from './surfaces.js'

const roots: string[] = []
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(authentication: 'real' | 'bypassed' = 'bypassed', preapprove = true): Promise<BrowserSurfaceInput> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-surface-')))
    roots.push(root)
    const id = cockpitId({ name: 'fixture', mainCheckoutPath: root })
    const checkout = checkoutId({ checkoutPath: root })
    const stack = stackId({ cockpitId: id, checkoutId: checkout, variant: { kind: 'shared' } })
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, `[cockpit]\nname = "fixture"\n[[sibling]]\nslug = "web"\ndir = "web"\nmount = "none"\nacquire = "none"\nvar = "WEB_DIR"\npurpose = "Synthetic web"\n[ports.bases]\nWEB = 3000\n[environment]\naddressing = "port"\nauthentication = "${authentication}"\nposture_requirements = [{ requirement = "synthetic-browser", addressing = "port", authentication = "${authentication}" }]\n`)
    const now = new Date().toISOString()
    const configuration = (await observeConfiguration({ path: configPath, stackId: stack, observedAt: now })).find(row => row.code === 'CONFIG_STALE')!
    const authority = await resolveObservationPostures({ configuration, cockpitId: id, checkoutPath: root, variant: { kind: 'shared' } })
    const namespace = await selectStateRoot({ platform: 'linux', home: root, cockpitId: id })
    if (namespace.kind !== 'complete') throw Error('fixture namespace refused')
    const stage = await resolveLifecycleStage({ namespace: namespace.value, stackId: stack, observedAt: now })
    if (stage.kind !== 'complete') throw Error('fixture stage refused')
    await mkdir(join(root, '.browser/auth'), { recursive: true })
    await writeFile(join(root, '.browser/auth/shared.json'), '{}', { mode: 0o600 })
    const lockBytes = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } })
    await writeFile(join(root, 'package-lock.json'), lockBytes)
    const image = `synthetic.invalid/browser@sha256:${'a'.repeat(64)}`
    const unresolved = resolveBrowserRuntime({
        postures: { authorities: [authority], stages: [stage.authority] },
        images: { runner: { reference: image, driverVersion: '1.2.3' }, mcp: { reference: image, driverVersion: '1.2.3' } },
        project: { lockfile: 'package-lock.json', sha256: digest(lockBytes), driverVersion: '1.2.3' },
        endpoint: 'ws://localhost:3001/', maxClients: 1,
        proxy: { serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] }, resolver: [],
        authentication: authentication === 'real' ? { policy: 'serialized', states: [{ worker: 'shared', path: '.browser/auth/shared.json' }] } : { policy: 'none', states: [] },
        data: { mode: preapprove ? 'seeded' : 'restored', isolated: true, reachesProduction: false },
        requestPreapproval: preapprove, headed: false,
        artifacts: { runner: '.browser/runner', mcp: '.playwright-mcp', cli: '.playwright-cli', auth: '.browser/auth', debugger: '.browser/debugger' },
    })
    const lease = await leasePortFamilyFixture({ namespace: namespace.value, stackId: stack,
        holderId: holderId({ stackId: stack, checkoutId: checkout, sessionId: 'browser-native-fixture' }), checkoutId: checkout,
        config: { step: 100, count: 1, bases: { BROWSER_PROXY: 3001 } }, now, listenerTimeoutMs: 100,
        listenerEvidence: [{ ports: [3001], observation: { state: 'available', value: [], observedAt: now, producer: 'browser-native-fixture' } }],
    })
    if (lease.kind !== 'complete') throw new Error('browser native evidence lease fixture refused')
    const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
    if (entrypoints.kind !== 'complete') throw new Error('browser native evidence entrypoint fixture refused')
    const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
    const runtime = projection && bindBrowserRuntimePortLease(unresolved, projection)
    if (!runtime) throw new Error('browser native evidence runtime lease binding refused')
    if (runtime.connection.kind !== 'remote') throw new Error('fixture expected a remote browser endpoint')
    const manifest = JSON.stringify({ name: '@playwright/test', version: '1.2.3', bin: { playwright: 'cli.js' } })
    await mkdir(join(root, 'node_modules/@playwright/test'), { recursive: true })
    await writeFile(join(root, 'node_modules/@playwright/test/package.json'), manifest)
    await writeFile(join(root, 'node_modules/@playwright/test/cli.js'), '/* synthetic pinned CLI */')
    return {
        runtime, cockpitDirectory: root,
        harnesses: [{ target: 'claudecode', version: '2.1.220' }, { target: 'codexcli', version: '0.149.0' }, { target: 'opencode', version: '1.18.15' }],
        mcp: { name: 'playwright', command: 'docker', args: ['run', '--rm', '-i', image, '--endpoint', runtime.connection.endpoint], cwd: root, envNames: [], source: { kind: 'core', path: 'mcp.jsonc', sha256: digest('synthetic declaration') } },
        approved: true,
        testPackage: { directory: 'node_modules/@playwright/test', manifest: { bytes: manifest, sha256: digest(manifest) }, cli: { path: 'cli.js', bytes: '/* synthetic pinned CLI */', sha256: digest('/* synthetic pinned CLI */') } },
        skillTemplate: await readFile('packages/cockpit/surfaces/skills/cockpit-browser.skill.md', 'utf8'),
    }
}

function receipt(probe: BrowserNativeProbe) {
    const observation = (argv: readonly string[], stdout: string) => ({ argv, exitCode: 0, timedOut: false, truncated: false,
        durationMs: 5, stdout, stderr: '', completedAt: '2026-10-23T11:59:57.000Z' })
    const launch = (broken: boolean) => {
        const asset = broken ? probe.brokenControl : probe.candidate
        const common = { cwd: probe.harnessCwd, argv: ['/synthetic/bin/harness'], isolatedHome: true }
        return probe.transport === 'cli' ? { ...common, loader: 'shell' } : { ...common, loader: 'fixed-path',
            selectedDeclaration: asset.path, loadedPath: probe.candidate.path, loadedSha256: asset.sha256 }
    }
    const brokenLoadedPath = probe.transport === 'mcp' ? probe.candidate.path : probe.brokenControl.path
    return {
        schema: 'cockpit-browser-native-receipt/v1', subjectSha256: probe.subjectSha256,
        target: probe.target, transport: probe.transport, version: probe.version,
        observedAt: '2026-10-23T12:00:00.000Z',
        executable: { path: '/synthetic/bin/harness', sha256: 'c'.repeat(64), version: probe.version },
        harnessVersion: observation(['/synthetic/bin/harness', '--version'], probe.version),
        transportIdentity: probe.transportIdentity,
        transportVersion: probe.transportVersionArgv ? observation(probe.transportVersionArgv, 'Version 1.2.3') : null,
        transportHelp: probe.transportHelpArgv ? probe.transportHelpArgv.map((argv, index) => observation(argv, index === 0 ? 'attach goto close' : 'attach --endpoint --config')) : null,
        rendered: probe.rendered,
        candidate: { launch: launch(false), path: probe.candidate.path, sha256: probe.candidate.sha256, invocation: probe.invocation,
            cliPreparation: probe.invocation.kind === 'cli' ? observation(probe.invocation.prepareArgv, 'Synthetic remote browser attached') : null,
            completedAt: '2026-10-23T11:59:58.000Z',
            exitCode: 0, timedOut: false, truncated: false, durationMs: 12, stdout: 'Page URL: about:blank', stderr: '', observedUrl: 'about:blank' },
        brokenControl: { launch: launch(true), path: probe.brokenControl.path, sha256: probe.brokenControl.sha256,
            invocation: probe.brokenInvocation, completedAt: '2026-10-23T11:59:58.000Z',
            exitCode: 2, timedOut: false, truncated: false, durationMs: 10, stdout: '', stderr: `Invalid declaration: ${brokenLoadedPath}`, discoveredPath: brokenLoadedPath },
        bounds: probe.bounds,
        cleanup: { removedPaths: [...probe.artifactRoots.map(root => `${root}/synthetic-output.json`), probe.candidate.path, probe.brokenControl.path],
            producedPaths: probe.artifactRoots.map(root => `${root}/synthetic-output.json`),
            unregisteredControl: '.unregistered-browser-control/keep.json', unregisteredControlPreserved: true, candidateClosed: true,
            reset: { cwd: probe.cockpitDirectory, argv: probe.resetArgv, exitCode: 0, timedOut: false, truncated: false, stdout: 'Synthetic public reset completed', stderr: '', completedAt: '2026-10-23T11:59:59.000Z' },
            readback: [...probe.artifactRoots.map(root => `${root}/synthetic-output.json`), ...probe.artifactRoots, probe.candidate.path, probe.brokenControl.path]
                .map(path => ({ cwd: probe.cockpitDirectory, path, state: 'absent', observedAt: '2026-10-23T12:00:00.000Z' }))
                .concat([{ cwd: probe.cockpitDirectory, path: '.unregistered-browser-control/keep.json', state: 'present', observedAt: '2026-10-23T12:00:00.000Z' }]),
        },
    }
}

function validate(probe: BrowserNativeProbe, value: unknown = receipt(probe)) {
    return validateBrowserNativeReceipt(probe, value, {
        executable: { path: '/synthetic/bin/harness', sha256: 'c'.repeat(64), version: probe.version },
        now: '2026-10-23T12:01:00.000Z',
    })
}

describe('bounded browser native receipt preparation', () => {
    it('prepares paired current-version commands without invoking or promoting any native row', async () => {
        const input = await fixture()
        const result = renderBrowserSurfaces(input)
        expect(result.probes).toHaveLength(5)
        for (const probe of result.probes) {
            expect(probe.status).toBe('human_needed')
            expect(probe.candidate.sha256).toBe(digest(probe.candidate.bytes))
            expect(probe.brokenControl.sha256).toBe(digest(probe.brokenControl.bytes))
            expect(probe.brokenControl.path.slice(0, probe.brokenControl.path.lastIndexOf('/'))).toBe(probe.candidate.path.slice(0, probe.candidate.path.lastIndexOf('/')))
            expect(probe.brokenControl.bytes).not.toBe(probe.candidate.bytes)
            expect(probe.bounds).toEqual({ timeoutMs: 30_000, outputBytes: 16_384, receiptBytes: 65_536 })
            expect(probe.resetArgv).toEqual(['cockpit', 'reset', '--config', join(input.cockpitDirectory, 'cockpit.toml'), '--interactive'])
            expect(validate(probe)).toEqual({ kind: 'validated', callable: 'human_needed', operatorAuthentication: 'required', subjectSha256: probe.subjectSha256 })
            expect(result.rows.find(row => row.target === probe.target && row.transport === probe.transport)!.callable).toBe('human_needed')
            if (probe.invocation.kind === 'mcp') expect(probe.invocation.arguments).toEqual({ url: 'about:blank' })
            else {
                expect(probe.invocation.prepareArgv.join(' ')).toContain('cli attach --endpoint=ws://localhost:3001/')
                expect(probe.invocation.argv.slice(-2)).toEqual(['goto', 'about:blank'])
                expect(probe.invocation.cleanupArgv.at(-1)).toBe('close')
                expect(probe.transportIdentity).toMatchObject({ kind: 'test-package', version: '1.2.3' })
                expect(probe.version).not.toBe('1.2.3')
                expect(validate(probe, { ...receipt(probe), transportHelp: null }).kind).toBe('refusal')
                expect(probe.invocation.argv).not.toContain('open')
            }
        }
    })

    it('rejects stale identity, changed rendered bytes, unrelated invocation and undiscovered broken controls', async () => {
        const probe = renderBrowserSurfaces(await fixture()).probes[0]!
        const good = receipt(probe)
        const cases = [
            { ...good, version: '99.0.0' },
            { ...good, observedAt: '2026-10-22T12:00:00.000Z' },
            { ...good, observedAt: '2026-10-23T12:02:00.000Z' },
            { ...good, transportIdentity: { ...probe.transportIdentity, version: '99.0.0' } },
            { ...good, executable: { ...good.executable, sha256: 'd'.repeat(64) } },
            { ...good, rendered: good.rendered.map(row => ({ ...row, sha256: 'e'.repeat(64) })) },
            { ...good, candidate: { ...good.candidate, invocation: { kind: 'mcp', tool: 'wrong', arguments: { url: 'about:blank' } } } },
            { ...good, candidate: { ...good.candidate, observedUrl: 'https://unrelated.invalid' } },
            { ...good, brokenControl: { ...good.brokenControl, discoveredPath: 'unrelated.json' } },
            { ...good, brokenControl: { ...good.brokenControl, stderr: '', stdout: '' } },
            { ...good, brokenControl: { ...good.brokenControl, exitCode: 0 } },
            { ...good, brokenControl: { ...good.brokenControl, launch: good.candidate.launch } },
            { ...good, brokenControl: { ...good.brokenControl, invocation: good.candidate.invocation } },
        ]
        for (const value of cases) expect(validateBrowserNativeReceipt(probe, value, { executable: good.executable, now: '2026-10-23T12:01:00.000Z' }).kind).toBe('refusal')
        expect(validateBrowserNativeReceipt({ ...probe }, good, { executable: good.executable, now: good.observedAt }).kind).toBe('refusal')
    })

    it('binds explicit native loaders and shell-mediated CLI preparation without inventing harness flags', async () => {
        const result = renderBrowserSurfaces(await fixture())
        const probe = result.probes.find(row => row.transport === 'mcp')!
        const good = receipt(probe)
        const value = { ...good,
            candidate: { ...good.candidate, launch: { ...good.candidate.launch, loader: 'explicit-config', argv: [good.executable.path, 'synthetic-config-option', probe.candidate.path] } },
            brokenControl: { ...good.brokenControl, discoveredPath: probe.brokenControl.path, stderr: `Invalid declaration: ${probe.brokenControl.path}`,
                launch: { ...good.brokenControl.launch, loader: 'explicit-config', loadedPath: probe.brokenControl.path,
                    argv: [good.executable.path, 'synthetic-config-option', probe.brokenControl.path] } },
        }
        expect(validate(probe, value).kind).toBe('validated')
        expect(validate(probe, { ...value, brokenControl: { ...value.brokenControl, launch: { ...value.brokenControl.launch, loadedSha256: probe.candidate.sha256 } } }).kind).toBe('refusal')
        const cli = result.probes.find(row => row.transport === 'cli')!
        const shell = receipt(cli)
        expect(shell.candidate.launch).toEqual({ loader: 'shell', argv: [shell.executable.path], cwd: cli.harnessCwd, isolatedHome: true })
        expect(validate(cli, shell).kind).toBe('validated')
        for (const candidate of [
            { ...shell.candidate, cliPreparation: null },
            { ...shell.candidate, cliPreparation: { ...shell.candidate.cliPreparation!, argv: ['unrelated'] } },
            { ...shell.candidate, cliPreparation: { ...shell.candidate.cliPreparation!, exitCode: 1 } },
            { ...shell.candidate, launch: good.candidate.launch },
        ]) expect(validate(cli, { ...shell, candidate }).kind).toBe('refusal')
    })

    it('binds version and protocol observations to bounded exact commands', async () => {
        const probe = renderBrowserSurfaces(await fixture()).probes.find(row => row.transport === 'cli')!
        const good = receipt(probe)
        for (const value of [
            { ...good, harnessVersion: { ...good.harnessVersion, stdout: '99.0.0' } },
            { ...good, transportVersion: null },
            { ...good, transportVersion: { ...good.transportVersion!, argv: ['unrelated'] } },
            { ...good, transportVersion: { ...good.transportVersion!, stdout: 'Version 99.0.0' } },
            { ...good, transportHelp: good.transportHelp!.map(row => ({ ...row, exitCode: 1 })) },
            { ...good, transportHelp: good.transportHelp!.map(row => ({ ...row, argv: ['unrelated'] })) },
            { ...good, transportHelp: good.transportHelp!.map(row => ({ ...row, truncated: true })) },
            { ...good, transportHelp: good.transportHelp!.map(row => ({ ...row, stdout: 'screenshot' })) },
        ]) expect(validate(probe, value).kind).toBe('refusal')
    })

    it('refuses truncated, timed-out, silent, oversized and out-of-budget observations', async () => {
        const probe = renderBrowserSurfaces(await fixture()).probes[0]!
        const good = receipt(probe)
        for (const candidate of [
            { ...good.candidate, truncated: true }, { ...good.candidate, timedOut: true },
            { ...good.candidate, exitCode: 1 }, { ...good.candidate, durationMs: 30_001 },
            { ...good.candidate, stdout: '', stderr: '' }, { ...good.candidate, stdout: 'a'.repeat(16_385) },
        ]) expect(validate(probe, { ...good, candidate }).kind).toBe('refusal')
        expect(validate(probe, { ...good, bounds: { ...good.bounds, outputBytes: 65_536 } }).kind).toBe('refusal')
        expect(validateBrowserNativeReceipt(probe, { ...good, padding: 'x'.repeat(65_537) }, { executable: good.executable, now: good.observedAt }).kind).toBe('refusal')
    })

    it('rejects a package manifest or lockfile changed after issuing the probe', async () => {
        for (const path of ['node_modules/@playwright/test/package.json', 'package-lock.json']) {
            const input = await fixture()
            const probe = renderBrowserSurfaces(input).probes.find(row => row.transport === 'cli')!
            expect(validate(probe).kind).toBe('validated')
            await writeFile(join(input.cockpitDirectory, path), '{}')
            expect(validate(probe).kind).toBe('refusal')
        }
    })

    it('requires complete registered cleanup and preserves an unregistered negative control', async () => {
        const probe = renderBrowserSurfaces(await fixture()).probes[0]!
        const good = receipt(probe)
        for (const cleanup of [
            { ...good.cleanup, producedPaths: good.cleanup.producedPaths.slice(1) },
            { ...good.cleanup, producedPaths: [...good.cleanup.producedPaths, '.unregistered-browser-control/out.json'] },
            { ...good.cleanup, removedPaths: good.cleanup.removedPaths.slice(1) },
            { ...good.cleanup, candidateClosed: false },
            { ...good.cleanup, reset: { ...good.cleanup.reset, argv: ['cockpit', 'reset'] } },
            { ...good.cleanup, reset: { ...good.cleanup.reset, argv: ['cockpit', 'reset', '--config', '/synthetic/other.toml', '--interactive'] } },
            { ...good.cleanup, reset: { ...good.cleanup.reset, exitCode: 1 } },
            { ...good.cleanup, reset: { ...good.cleanup.reset, cwd: '/synthetic/other' } },
            { ...good.cleanup, reset: { ...good.cleanup.reset, completedAt: '2026-10-23T11:59:56.000Z' } },
            { ...good.cleanup, readback: good.cleanup.readback.map(row => ({ ...row, cwd: '/synthetic/other' })) },
            { ...good.cleanup, readback: good.cleanup.readback.slice(1) },
            { ...good.cleanup, readback: good.cleanup.readback.map(row => ({ ...row, state: 'absent' })) },
            { ...good.cleanup, unregisteredControlPreserved: false },
            { ...good.cleanup, unregisteredControl: good.cleanup.producedPaths[0]! },
        ]) expect(validate(probe, { ...good, cleanup }).kind).toBe('refusal')
    })

    it('validates post-reset receipt structure after owned seeded auth state has been removed', async () => {
        const input = await fixture('real')
        const probe = renderBrowserSurfaces(input).probes[0]!
        await rm(join(input.cockpitDirectory, '.browser/auth/shared.json'))
        expect(validate(probe).kind).toBe('validated')
        expect(validate(probe)).toMatchObject({ callable: 'human_needed', operatorAuthentication: 'required' })
    })
})
