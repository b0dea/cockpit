import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { CockpitConfig } from '../schema.js'
import { loadCockpitConfig } from '../config/load.js'
import { browserRuntimeCoordination } from '../browser/runtime.js'
import { prepareGeneratedEnvironmentCurrentness, syncGeneratedEnvironment } from '../generated-environment/command.js'
import type { HolderId } from '../environment/contract.js'
import { cockpitId, checkoutId, stackId } from '../environment/identity.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { recordLifecycleStarted } from '../environment/lifecycle-stage.js'
import { selectStateRoot, transactState } from '../environment/state.js'
import { runWorkApplication } from './application.js'
import { createConfiguredWorkApplicationComposition } from './composition.js'
import { parseWorkOrder, type ParsedWorkOrder } from './contract.js'
import { observeWorkOrderIdentity, type WorkOrderIdentityGit } from './identity-observation.js'
import { intakeWorkOrder } from './intake.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { createWorkCompositionFixtureSupport, gitWithObjectId, reidentifyWorkOrder } from '../../test-support/work-composition-fixture.js'

const filesystemRace = vi.hoisted(() => ({
    path: '', descriptor: -1, armed: false, mutated: false, replaceWithFifo: false, openFlags: -1,
    ancestorPath: '', ancestorTarget: '', heldAncestorPath: '', ancestorAnchored: false, leafLstatCalls: 0,
    restoreAncestorAfterOpen: false, siblingEntryPath: '',
}))
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    const childProcess = await import('node:child_process')
    return {
        ...actual,
        openSync: (...args: unknown[]) => {
            if (filesystemRace.armed && filesystemRace.ancestorPath && args[0] === filesystemRace.ancestorPath) {
                filesystemRace.ancestorAnchored = true
            }
            if (filesystemRace.armed && args[0] === filesystemRace.path && filesystemRace.replaceWithFifo) {
                filesystemRace.openFlags = Number(args[1])
                actual.renameSync(filesystemRace.path, `${filesystemRace.path}.regular`)
                const replacement = childProcess.spawnSync('/usr/bin/mkfifo', [filesystemRace.path], {
                    cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
                })
                if (replacement.status !== 0) throw new Error('fixture could not replace the source with a FIFO')
                filesystemRace.mutated = true
                if ((filesystemRace.openFlags & actual.constants.O_NONBLOCK) === 0) throw new Error('source open would block on a FIFO replacement')
            }
            if (filesystemRace.armed && !filesystemRace.mutated && filesystemRace.siblingEntryPath && args[0] === filesystemRace.path) {
                actual.writeFileSync(filesystemRace.siblingEntryPath, 'Synthetic unrelated directory entry.\n')
                filesystemRace.mutated = true
            }
            const descriptor = Reflect.apply(actual.openSync, actual, args) as number
            if (filesystemRace.armed && filesystemRace.restoreAncestorAfterOpen && args[0] === filesystemRace.path) {
                actual.unlinkSync(filesystemRace.ancestorPath)
                actual.renameSync(filesystemRace.heldAncestorPath, filesystemRace.ancestorPath)
            }
            if (filesystemRace.armed && args[0] === filesystemRace.path) filesystemRace.descriptor = descriptor
            return descriptor
        },
        fstatSync: (...args: unknown[]) => {
            const status = Reflect.apply(actual.fstatSync, actual, args) as ReturnType<typeof actual.fstatSync>
            if (filesystemRace.armed && !filesystemRace.mutated && args[0] === filesystemRace.descriptor) {
                actual.appendFileSync(filesystemRace.path, ' '.repeat(262_145))
                filesystemRace.mutated = true
            }
            return status
        },
        lstatSync: (...args: unknown[]) => {
            if (filesystemRace.armed && filesystemRace.ancestorPath && args[0] === filesystemRace.path) {
                filesystemRace.leafLstatCalls += 1
                const replacementCall = filesystemRace.ancestorAnchored ? 1 : 2
                if (!filesystemRace.mutated && filesystemRace.leafLstatCalls === replacementCall) {
                    actual.renameSync(filesystemRace.ancestorPath, filesystemRace.heldAncestorPath)
                    actual.symlinkSync(filesystemRace.ancestorTarget, filesystemRace.ancestorPath, 'dir')
                    filesystemRace.mutated = true
                }
            }
            return Reflect.apply(actual.lstatSync, actual, args) as ReturnType<typeof actual.lstatSync>
        },
    }
})

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const { configuredFixture } = createWorkCompositionFixtureSupport(roots)

it('rejects malformed and null Git object identities in refs and worktrees', async () => {
    for (const objectId of ['', '0'.repeat(40), '0'.repeat(64), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40)]) {
        await expect(observeWorkOrderIdentity({
            root: '/synthetic', id: 'WO-001', executeGit: gitWithObjectId(objectId, 'ref'),
        }), `ref ${objectId || '<empty>'}`).rejects.toThrow('work-order identity ref inventory is malformed')
        await expect(observeWorkOrderIdentity({
            root: '/synthetic', id: 'WO-001', executeGit: gitWithObjectId(objectId, 'worktree'),
        }), `worktree ${objectId || '<empty>'}`).rejects.toThrow('work-order identity worktree inventory is malformed')
    }
})

describe('configured durable work application composition', () => {
    it('reports status when Git has another hard link', async () => {
        const fixture = await configuredFixture({ hardlinkedGit: true })
        const git = await lstat(join(fixture.root, 'tools/git'))
        if (!fixture.hardlinkedGitAlias) throw new Error('hardlinked Git fixture alias is unavailable')
        const hardlink = await lstat(fixture.hardlinkedGitAlias)
        expect({ dev: git.dev, ino: git.ino, nlink: git.nlink }).toEqual({ dev: hardlink.dev, ino: hardlink.ino, nlink: 2 })

        const status = await runWorkApplication({ operation: 'work-status' }, fixture.composition)
        expect(status, JSON.stringify(status)).toMatchObject({ kind: 'complete' })
        const selected = await runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)
        expect(selected, JSON.stringify(selected)).toMatchObject({
            kind: 'complete', value: { orders: [{ id: 'WO-001' }] },
        })
    })

    it('admits the configured root as a canonical sibling repository', async () => {
        const fixture = await configuredFixture({ rootSibling: true })
        await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({ kind: 'complete' })
    })

    it('keeps an admitted source current when a neighbouring checkout changes their shared parent', async () => {
        const fixture = await configuredFixture()
        const siblingEntryPath = join(fixture.root, '..', `cockpit-neighbour-${randomUUID()}`)
        Object.assign(filesystemRace, { path: fixture.configPath, descriptor: -1, armed: true, mutated: false, siblingEntryPath })
        try {
            const result = await runWorkApplication({ operation: 'work-status' }, fixture.composition)
            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, { path: '', descriptor: -1, armed: false, mutated: false, siblingEntryPath: '' })
            await rm(siblingEntryPath, { force: true })
        }
    })

    it('keeps an admitted repository current when excluded coordination state changes during observation', async () => {
        const fixture = await configuredFixture()
        const sourcePath = join(fixture.root, 'src/cache.ts')
        const coordinationPath = join(fixture.root, '.cockpit/work-orders/transient-observation')
        await writeFile(sourcePath, "export function refresh() { return 'observed' }\n")
        await mkdir(join(fixture.root, '.cockpit/work-orders'), { recursive: true })
        Object.assign(filesystemRace, {
            path: sourcePath, descriptor: -1, armed: true, mutated: false, siblingEntryPath: coordinationPath,
        })
        try {
            const result = await runWorkApplication({ operation: 'work-status' }, fixture.composition)
            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, { path: '', descriptor: -1, armed: false, mutated: false, siblingEntryPath: '' })
            await rm(coordinationPath, { force: true })
        }
    })

    it('refuses a participating rename when its excluded source changes during observation', async () => {
        const fixture = await configuredFixture()
        const destination = 'src/rename-destination.ts'
        const countPath = join(fixture.root, '.cockpit/work-orders/rename-status-count')
        await mkdir(join(fixture.root, '.cockpit/work-orders'), { recursive: true })
        await writeFile(join(fixture.root, destination), 'export const renamed = true\n')
        await writeFile(join(fixture.root, '.gitignore'), `${await readFile(join(fixture.root, '.gitignore'), 'utf8')}${destination}\n`)
        const git = join(fixture.root, 'tools/git')
        await writeFile(git, `#!${process.execPath}
const fs = require('node:fs'); const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2); const result = spawnSync('/usr/bin/git', argv, { encoding: 'utf8' })
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1) }
if (process.cwd() === ${JSON.stringify(fixture.root)} && argv[0] === 'status' && argv.includes('--porcelain=v2')) {
  const countPath = ${JSON.stringify(countPath)}
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1
  fs.writeFileSync(countPath, String(count))
  const source = count === 1 ? '.cockpit/work-orders/source-a' : '.cockpit/work-orders/source-b'
  process.stdout.write(result.stdout + '2 R. N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R100 ${destination}\\0' + source + '\\0')
} else process.stdout.write(result.stdout)
`)
        await chmod(git, 0o700)
        await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('changed during observation'),
        })
    })

    it('refuses a source read when its owning directory changes during admission', async () => {
        const fixture = await configuredFixture()
        Object.assign(filesystemRace, {
            path: fixture.configPath, descriptor: -1, armed: true, mutated: false,
            siblingEntryPath: join(fixture.root, 'unadmitted-entry'),
        })
        try {
            await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
                kind: 'refusal', reason: expect.stringContaining('configuration source changed after admission'),
            })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, { path: '', descriptor: -1, armed: false, mutated: false, siblingEntryPath: '' })
        }
    })

    it('refuses an outer ancestor swap that opens a different leaf before restoration', async () => {
        const fixture = await configuredFixture({ externalSibling: true })
        const outer = resolve(fixture.root, '..')
        const outside = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-work-outer-outside-'))); roots.push(outside)
        await mkdir(join(outside, 'cockpit'))
        await writeFile(join(outside, 'cockpit/cockpit.toml'), await readFile(fixture.configPath))
        Object.assign(filesystemRace, {
            path: fixture.configPath, descriptor: -1, armed: true, mutated: false,
            ancestorPath: outer, ancestorTarget: outside, heldAncestorPath: `${outer}-held`,
            ancestorAnchored: false, leafLstatCalls: 0, restoreAncestorAfterOpen: true,
        })
        try {
            await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
                kind: 'refusal', reason: expect.stringContaining('configuration source changed after admission'),
            })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, {
                path: '', descriptor: -1, armed: false, mutated: false,
                ancestorPath: '', ancestorTarget: '', heldAncestorPath: '', ancestorAnchored: false,
                leafLstatCalls: 0, restoreAncestorAfterOpen: false,
            })
        }
    })

    it('retains never-started history across sweep reversal', async () => {
        const historyFixture = await configuredFixture()
        await expect(runWorkApplication({ operation: 'work-sweep', apply: true }, historyFixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { kind: 'applied', changes: [{ id: 'WO-002' }, { id: 'WO-003' }] },
        })
        const reversed = await runWorkApplication({ operation: 'work-reverse', workOrderId: 'WO-002' }, historyFixture.composition)
        expect(reversed, JSON.stringify(reversed)).toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-reverse', workOrderId: 'WO-003' }, historyFixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-sweep', apply: false }, historyFixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { kind: 'dry-run', changes: [{ id: 'WO-002' }, { id: 'WO-003' }] },
        })
        const restoredAcceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-002' }, historyFixture.composition)
        if (restoredAcceptance.kind !== 'human-needed') throw new Error(`restored draft acceptance continuation unavailable: ${restoredAcceptance.kind === 'refusal' ? restoredAcceptance.reason : restoredAcceptance.kind}`)
        await expect(restoredAcceptance.continuation.decide(`accept ${restoredAcceptance.continuation.digest}`))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-accept' })
        await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-002', approach: 'restored draft execution' }, historyFixture.composition))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-execute' })
    })

    it('rechecks capacity before restoring a draft', async () => {
        const capacityFixture = await configuredFixture()
        await expect(runWorkApplication({ operation: 'work-sweep', apply: true }, capacityFixture.composition)).resolves.toMatchObject({ kind: 'complete' })
        for (const id of ['WO-004', 'WO-005']) {
            const bytes = workOrderFixture({ status: 'active' }).replaceAll('WO-001', id)
            await writeFile(join(capacityFixture.root, `workorders/${id}.md`), bytes)
        }
        await expect(runWorkApplication({ operation: 'work-reverse', workOrderId: 'WO-002' }, capacityFixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('capacity'),
        })
        await expect(readFile(join(capacityFixture.root, 'workorders/WO-002.md'), 'utf8')).resolves.toMatch(/^status: parked$/m)
    })

    it('binds deduplicated browser routes to the named HTTPS origin at the retained lease offset', async () => {
        const fixture = await configuredFixture()
        const manifest = JSON.stringify({ name: 'synthetic-browser-project', version: '1.0.0', dependencies: { '@playwright/test': '1.2.3' } })
        const packageManifest = JSON.stringify({ name: '@playwright/test', version: '1.2.3', main: 'index.js', bin: { playwright: 'cli.js' } })
        const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } })
        const mcpImage = `synthetic.invalid/browser-mcp@sha256:${'b'.repeat(64)}`
        await Promise.all([
            mkdir(join(fixture.root, 'node_modules/@playwright/test'), { recursive: true }),
            ...['.browser/runner', '.browser/mcp', '.browser/cli', '.browser/auth', '.browser/debugger'].map(path => mkdir(join(fixture.root, path), { recursive: true })),
        ])
        await Promise.all([
            writeFile(join(fixture.root, 'package.json'), manifest), writeFile(join(fixture.root, 'app/package-lock.json'), lockfile),
            writeFile(join(fixture.root, 'node_modules/@playwright/test/package.json'), packageManifest),
            writeFile(join(fixture.root, 'node_modules/@playwright/test/index.js'), 'module.exports = {}\n'),
            writeFile(join(fixture.root, 'node_modules/@playwright/test/cli.js'), '#!/usr/bin/env node\n'),
            writeFile(join(fixture.root, 'browser.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'docker', args: ['run', '--rm', '-i', mcpImage] } } })),
            writeFile(join(fixture.root, '.browser/auth/first.json'), '{}\n', { mode: 0o600 }),
            writeFile(join(fixture.root, '.browser/auth/second.json'), '{}\n', { mode: 0o600 }),
        ])
        const source = await readFile(fixture.configPath, 'utf8')
        const browser = `
[[sibling]]
slug = "browser-source"
dir = "."
mount = "none"
acquire = "none"
var = "BROWSER_SOURCE_DIR"
purpose = "Synthetic browser declaration"

[sibling.derives]
mcp_sources = [{ path = "browser.mcp.json", format = "mcp-json", provenance = { source = "synthetic declaration", observed_on = "2026-10-24", kind = "declared", reason = "Synthetic browser transport" } }]

[mcp]
approved = ["playwright"]

[environment]
addressing = "hostname"
authentication = "real"
posture_requirements = [{ requirement = "synthetic-browser", addressing = "hostname", authentication = "real" }]
generated_host_paths = [".browser/runner", ".browser/mcp", ".browser/cli", ".browser/auth", ".browser/debugger"]
entrypoint_derivatives = [{ name = "application", kind = "origin", port = "APP_HOST_PORT", path = "/", hostname = "app.sample.localhost", scheme = "https" }, { name = "home", kind = "entrypoint", port = "APP_HOST_PORT", path = "/", hostname = "app.sample.localhost", scheme = "https" }, { name = "status", kind = "entrypoint", port = "APP_HOST_PORT", path = "/status", hostname = "app.sample.localhost", scheme = "https" }]

[browser]
harnesses = [{ target = "codexcli", version = "0.149.0" }]
images = { runner = { reference = "synthetic.invalid/browser@sha256:${'a'.repeat(64)}", driver_version = "1.2.3" }, mcp = { reference = "${mcpImage}", driver_version = "1.2.3" } }
project = { lockfile = "app/package-lock.json", sha256 = "${createHash('sha256').update(lockfile).digest('hex')}", driver_version = "1.2.3" }
max_clients = 2
proxy = { server_port = 4099, proxy_port = 4100, allowed_hosts = ["localhost:4100"] }
resolver = [{ hostname = "app.sample.localhost", address = "127.0.0.1" }]
authentication = { policy = "per-worker", states = [{ worker = "first", path = ".browser/auth/first.json", source = "seeded" }, { worker = "second", path = ".browser/auth/second.json", source = "seeded" }] }
data = { mode = "empty", isolated = true, reaches_production = false }
request_preapproval = true
headed = false
artifacts = { runner = ".browser/runner", mcp = ".browser/mcp", cli = ".browser/cli", auth = ".browser/auth", debugger = ".browser/debugger" }
`
        await writeFile(fixture.configPath, source.replace('[environment.generated]', `${browser}\n[environment.generated]`))
        const stateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-work-browser-state-'))); roots.push(stateHome)
        const priorHome = process.env.HOME; const priorState = process.env.XDG_STATE_HOME
        process.env.HOME = stateHome; process.env.XDG_STATE_HOME = join(stateHome, 'state')
        try {
            const ownershipPath = join(fixture.root, '.cockpit/generated-environment-ownership.json')
            const ownership = JSON.parse(await readFile(ownershipPath, 'utf8')) as { entries: { path: string }[] }
            await Promise.all(ownership.entries.map(entry => rm(join(fixture.root, entry.path), { recursive: true, force: true })))
            await rm(ownershipPath)
            const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
            const loaded = await loadCockpitConfig(fixture.configPath)
            if (loaded.kind !== 'complete') throw new Error('browser alias fixture config refused')
            const currentCockpit = cockpitId({ name: loaded.result.config.cockpit.name, mainCheckoutPath: fixture.root })
            const currentCheckout = checkoutId({ checkoutPath: fixture.root })
            const currentStack = stackId({ cockpitId: currentCockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
            if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('browser alias fixture requires a supported state platform')
            const namespace = await selectStateRoot({ platform: process.platform, home: process.env.HOME,
                xdgStateHome: process.env.XDG_STATE_HOME, checkoutRoots: [fixture.root], cockpitId: currentCockpit })
            if (namespace.kind !== 'complete') throw new Error('browser alias fixture state unavailable')
            const holder = `holder:${'c'.repeat(64)}:session` as HolderId; const observedAt = new Date().toISOString()
            const family = loaded.result.config.ports
            const lease = await leasePortFamilyFixture({ namespace: namespace.value, stackId: currentStack, holderId: holder,
                checkoutId: currentCheckout, config: family, now: observedAt, listenerTimeoutMs: 1_000,
                listenerEvidence: Array.from({ length: family.count }, (_, index) => ({
                    ports: Object.values(family.bases).map(base => base + index * family.step),
                    observation: { state: 'available' as const, value: index === 0 ? Object.values(family.bases) : [], observedAt, producer: 'browser-alias-control' },
                })) })
            if (lease.kind !== 'complete') throw new Error('browser alias fixture lease unavailable')
            expect(lease.lease.offset).toBe(family.step)
            const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: loaded.result.config.environment.entrypoint_derivatives })
            if (entrypoints.kind !== 'complete' || !projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })) throw new Error('browser alias fixture entrypoints unavailable')
            const started = await recordLifecycleStarted({ namespace: namespace.value, stackId: currentStack, holderId: holder, observedAt })
            if (started.kind === 'refusal') throw new Error('browser alias fixture lifecycle unavailable')
            const lifecycle = await transactState(namespace.value, namespace.value.paths.lifecycle(currentStack), { ownerId: holder }, () => ({
                format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: currentCockpit, subjectId: currentStack,
                revision: 0, updatedAt: observedAt, value: { holderId: holder, workBasisSha256: 'd'.repeat(64), operationGeneration: 'e'.repeat(64), completedServices: [] },
            }))
            if (lifecycle.kind !== 'complete') throw new Error('browser alias fixture lifecycle state unavailable')
            const configured = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath,
                env: Object.freeze({ ...fixture.environment, HOME: stateHome, XDG_STATE_HOME: process.env.XDG_STATE_HOME }) })
            if (configured.kind !== 'complete') throw new Error(configured.reason)
            const command = await configured.composition.browser('drive', false)
            const origin = `https://app.sample.localhost:${lease.lease.ports.APP_HOST_PORT}`
            expect(command.policy.origin).toBe(origin)
            expect(command.policy.surfaces).toEqual([
                { name: 'application', url: `${origin}/` },
                { name: 'status', url: `${origin}/status` },
            ])
            const binding = browserRuntimeCoordination(command.runtime)
            expect(binding).toBeDefined()
            expect(command.state).toEqual({ namespace: binding!.namespace, stackId: currentStack, ownerId: holder })
            await writeFile(join(fixture.root, '.gitignore'), `${await readFile(join(fixture.root, '.gitignore'), 'utf8')}.browser/auth/\n`)
            await reidentifyWorkOrder(fixture.root, 'WO-001', 'WO-301')
            const contractPath = join(fixture.root, 'workorders/WO-301.md')
            await writeFile(contractPath, (await readFile(contractPath, 'utf8')).replace('- src/cache.ts\n- tests/cache.test.ts', '- .browser/auth/first.json'))
            const acceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-301' }, configured.composition)
            if (acceptance.kind !== 'human-needed') throw new Error(`browser-state refusal acceptance continuation unavailable: ${acceptance.kind === 'refusal' ? acceptance.reason : acceptance.kind}`)
            await expect(acceptance.continuation.decide(`accept ${acceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
            await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-301' }, configured.composition)).resolves.toMatchObject({
                kind: 'refusal', reason: expect.stringContaining('browser authentication state'),
            })
            await expect(readFile(join(fixture.root, '.native-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome
            if (priorState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = priorState
        }
    }, 120_000)

    it('serializes capacity admission and refuses lock paths that escape through an ancestor symlink', async () => {
        const fixture = await configuredFixture()
        const privateOrders = join(fixture.root, '.cockpit/work-orders')
        const outside = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-work-lock-outside-'))); roots.push(outside)
        await rm(join(fixture.root, 'workorders/WO-003.md'))
        await rm(join(fixture.root, 'workorders/WO-003.source-audit.json'))
        await symlink(outside, privateOrders)
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal' })
        await expect(readdir(outside)).resolves.toEqual([])
        await rm(privateOrders)

        const intake = await Promise.all([
            runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition),
            runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-006.md' }, fixture.composition),
        ])
        const intakeContext = JSON.stringify(intake)
        expect(intake.filter(result => result.kind === 'complete'), intakeContext).toHaveLength(1)
        expect(intake.filter(result => result.kind === 'refusal'), intakeContext).toHaveLength(1)
        const publishedIntake = ['WO-004', 'WO-006'].filter(id => existsSync(join(fixture.root, `workorders/${id}.md`)))
        expect(publishedIntake).toHaveLength(1)
        await Promise.all(publishedIntake.flatMap(id => [
            rm(join(fixture.root, `workorders/${id}.md`)), rm(join(fixture.root, `workorders/${id}.source-audit.json`)),
        ]))

        await Promise.all(['WO-001', 'WO-002'].flatMap(id => [
            rm(join(fixture.root, `workorders/${id}.md`)), rm(join(fixture.root, `workorders/${id}.source-audit.json`)),
        ]))
        const programme = await Promise.all([
            runWorkApplication({ operation: 'work-programme-mint', programmeId: 'cache', candidate: 'candidates/WO-005.md' }, fixture.composition),
            runWorkApplication({ operation: 'work-programme-mint', programmeId: 'queue', candidate: 'candidates/WO-007.md' }, fixture.composition),
        ])
        const programmeContext = JSON.stringify(programme)
        expect(programme.filter(result => result.kind === 'complete'), programmeContext).toHaveLength(1)
        expect(programme.filter(result => result.kind === 'refusal'), programmeContext).toHaveLength(1)
        expect(['WO-005', 'WO-007'].filter(id => existsSync(join(fixture.root, `workorders/${id}.md`)))).toHaveLength(1)
        const ledgers = await Promise.all(['cache', 'queue'].map(async id => JSON.parse(await readFile(join(fixture.root, `workorders/programmes/${id}.json`), 'utf8')) as { items: { orderId: string | null }[] }))
        expect(ledgers.filter(ledger => ledger.items[0]?.orderId !== null)).toHaveLength(1)
    }, 120_000)

    it('reserves each new work-order identity across reachable refs and linked worktrees', async () => {
        const fixture = await configuredFixture()
        const linked = join(tmpdir(), `cockpit-work-identity-${randomUUID()}`); roots.push(linked)
        const gitEnvironment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
        const git = (...argv: string[]) => {
            const result = spawnSync('/usr/bin/git', argv, { cwd: fixture.root, env: gitEnvironment, encoding: 'utf8' })
            if (result.status !== 0) throw new Error(`fixture git ${argv.join(' ')} failed: ${result.stderr}`)
        }
        git('worktree', 'add', '--quiet', '-b', 'synthetic-identity-claim', linked, 'HEAD')
        await Promise.all([
            rm(join(fixture.root, 'workorders/WO-003.md')),
            rm(join(fixture.root, 'workorders/WO-003.source-audit.json')),
        ])

        await writeFile(join(linked, '.gitignore'), `${await readFile(join(linked, '.gitignore'), 'utf8')}workorders/WO-004.md\n`)
        await writeFile(join(linked, 'workorders/WO-004.md'), await readFile(join(fixture.root, 'candidates/WO-004.md')))
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('identity is already claimed') })
        await rm(join(linked, 'workorders/WO-004.md'))
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-intake' })

        await writeFile(join(linked, 'workorders/WO-005.md'), await readFile(join(fixture.root, 'candidates/WO-005.md')))
        git('-C', linked, 'add', 'workorders/WO-005.md')
        git('-C', linked, 'commit', '--quiet', '-m', 'claim synthetic work-order identity')
        git('worktree', 'remove', '--force', linked)
        await Promise.all([
            rm(join(fixture.root, 'workorders/WO-001.md')),
            rm(join(fixture.root, 'workorders/WO-001.source-audit.json')),
            rm(join(fixture.root, 'workorders/WO-002.md')),
            rm(join(fixture.root, 'workorders/WO-002.source-audit.json')),
        ])
        await expect(runWorkApplication({ operation: 'work-programme-mint', programmeId: 'cache', candidate: 'candidates/WO-005.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('identity is already claimed') })
    }, 120_000)

    it('serializes the same new identity across linked worktree publications', async () => {
        const fixture = await configuredFixture()
        const linkedRequest = join(tmpdir(), `cockpit-work-identity-race-${randomUUID()}`)
        const gitEnvironment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
        const added = spawnSync('/usr/bin/git', ['worktree', 'add', '--quiet', '-b', 'synthetic-identity-race', linkedRequest, 'HEAD'], {
            cwd: fixture.root, env: gitEnvironment, encoding: 'utf8',
        })
        if (added.status !== 0) throw new Error(`fixture linked worktree failed: ${added.stderr}`)
        const linked = await realpath(linkedRequest); roots.push(linked)
        const linkedConfig = join(linked, 'cockpit.toml')
        const synced = await syncGeneratedEnvironment({ configPath: linkedConfig })
        if (synced.kind !== 'complete') throw new Error(`linked generated fixture sync refused: ${JSON.stringify(synced.diagnostics)}`)
        const linkedComposition = await createConfiguredWorkApplicationComposition({ configPath: linkedConfig, env: {
            ...process.env, PATH: `${join(linked, 'tools')}${delimiter}${process.env.PATH ?? ''}`,
        } })
        if (linkedComposition.kind !== 'complete') throw new Error(linkedComposition.reason)
        await Promise.all([
            rm(join(fixture.root, 'workorders/WO-003.md')), rm(join(fixture.root, 'workorders/WO-003.source-audit.json')),
            rm(join(linked, 'workorders/WO-003.md')), rm(join(linked, 'workorders/WO-003.source-audit.json')),
        ])

        const mainPrepared = await fixture.composition.intent('intents/work.json', 'candidates/WO-006.md')
        const linkedPrepared = await linkedComposition.composition.intent('intents/work.json', 'candidates/WO-006.md')
        if (mainPrepared.origin !== 'intent' || linkedPrepared.origin !== 'intent') throw new Error('fixture identity race did not prepare drafts')
        const mainDraft = intakeWorkOrder({ route: mainPrepared.route, contract: mainPrepared.contract,
            sourceAudit: mainPrepared.sourceAudit, installedSkills: mainPrepared.installedSkills })
        const linkedDraft = intakeWorkOrder({ route: linkedPrepared.route, contract: linkedPrepared.contract,
            sourceAudit: linkedPrepared.sourceAudit, installedSkills: linkedPrepared.installedSkills })
        if (mainDraft.kind === 'refusal' || linkedDraft.kind === 'refusal') throw new Error('fixture identity race drafts were refused')

        const publications = await Promise.allSettled([
            fixture.composition.persistDraft(mainPrepared, mainDraft),
            linkedComposition.composition.persistDraft(linkedPrepared, linkedDraft),
        ])
        expect(publications.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
        const rejected = publications.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (!(rejected?.reason instanceof Error)) throw new Error('fixture identity race did not retain a rejection reason')
        expect(rejected.reason.message).toContain('work-order transaction is contended')
        const winner = [fixture.root, linked].filter(root => existsSync(join(root, 'workorders/WO-006.md')))
        const loser = [fixture.root, linked].filter(root => !existsSync(join(root, 'workorders/WO-006.md')))
        expect(winner).toHaveLength(1); expect(loser).toHaveLength(1)
        expect(existsSync(join(winner[0]!, 'workorders/WO-006.source-audit.json'))).toBe(true)
        expect(existsSync(join(loser[0]!, 'workorders/WO-006.source-audit.json'))).toBe(false)
        await expect(runWorkApplication({ operation: 'work-recover', lockId: '.identity-admission', apply: false }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', value: { kind: 'unlocked', lockId: '.identity-admission' } })
    }, 120_000)

    // `sibling add --create` makes a repository with no commits; every work command then refused with
    // an unnamed "repository revision is unavailable" and no way forward.
    it('names the repository and its first commit as the fix when a sibling has no commits yet', async () => {
        const fixture = await configuredFixture({ externalSibling: true })
        await rm(join(fixture.applicationRoot, '.git'), { recursive: true, force: true })
        expect(spawnSync('/usr/bin/git', ['init', '--quiet'], { cwd: fixture.applicationRoot }).status).toBe(0)
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining(`has no commits yet; fix: commit once in ${fixture.applicationRoot}`) })
    }, 120_000)

    it('fails closed when repository identity evidence is unavailable, malformed, or changes before publication', async () => {
        const fixture = await configuredFixture()
        const faultHelper = join(fixture.root, 'tools/git-faults.cjs')
        const unavailableFaultHelper = `${faultHelper}.unavailable`
        const unrelatedMarker = join(fixture.root, '.identity-inventory-unavailable')
        await writeFile(unrelatedMarker, 'armed')
        await rename(faultHelper, unavailableFaultHelper)
        try {
            const unrelated = spawnSync(join(fixture.root, 'tools/git'), ['--version'], { cwd: fixture.root, encoding: 'utf8' })
            expect(unrelated).toMatchObject({ status: 0, stdout: expect.stringMatching(/^git version /) })
        } finally {
            await rename(unavailableFaultHelper, faultHelper)
            await rm(unrelatedMarker)
        }
        await Promise.all([
            rm(join(fixture.root, 'workorders/WO-003.md')),
            rm(join(fixture.root, 'workorders/WO-003.source-audit.json')),
        ])
        for (const [marker, reason] of [
            ['.identity-inventory-unavailable', 'ref inventory is unavailable'],
            ['.identity-inventory-malformed', 'ref inventory is malformed'],
            ['.identity-worktree-malformed', 'worktree inventory is malformed'],
        ] as const) {
            await writeFile(join(fixture.root, marker), 'armed')
            await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
                .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining(reason) })
            await rm(join(fixture.root, marker))
        }

        await writeFile(join(fixture.root, '.repository-status-malformed'), 'armed')
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('repository revision is unavailable') })
        await rm(join(fixture.root, '.repository-status-malformed'))

        await writeFile(join(fixture.root, '.identity-inventory-change'), 'armed')
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('changed before publication') })
        await expect(readFile(join(fixture.root, 'workorders/WO-004.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('publishes the public guide examples as an unaccepted draft with its matching audit', async () => {
        const guide = await readFile(resolve('docs/work-and-browser.md'), 'utf8')
        const example = (heading: string, language: string): string => {
            const section = guide.split(`### ${heading}\n`)[1]
            const bytes = section?.split(`\`\`\`${language}\n`)[1]?.split('\n\`\`\`')[0]
            if (!bytes) throw new Error(`Public work guide is missing the ${heading} example`)
            return `${bytes}\n`
        }
        const intent = example('Intent descriptor', 'json')
        const upstream = example('Upstream task', 'text')
        const candidate = example('Draft contract', 'markdown')
        const audit = example('Adjacent source audit', 'json')
        const fixture = await configuredFixture()
        await Promise.all(['WO-001', 'WO-002', 'WO-003'].flatMap(id => [
            rm(join(fixture.root, `workorders/${id}.md`)), rm(join(fixture.root, `workorders/${id}.source-audit.json`)),
        ]))
        await mkdir(join(fixture.root, 'specs'))
        await mkdir(join(fixture.root, 'drafts'))
        await writeFile(join(fixture.root, 'specs/cache-refresh.md'), upstream)
        await writeFile(join(fixture.root, 'intents/task.json'), intent)
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/task.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', value: { route: { kind: 'work-order' }, candidateRequired: true } })
        await expect(readdir(join(fixture.root, 'workorders'))).resolves.toEqual(['programmes'])
        await writeFile(join(fixture.root, 'drafts/task.md'), candidate)
        await writeFile(join(fixture.root, 'drafts/task.source-audit.json'), audit)
        const published = await runWorkApplication({ operation: 'work-intake', intent: 'intents/task.json', candidate: 'drafts/task.md' }, fixture.composition)
        expect(published, JSON.stringify(published)).toMatchObject({ kind: 'complete', value: { kind: 'draft', skills: { kind: 'absent' }, gaps: [] } })
        const parsed = parseWorkOrder(Buffer.from(candidate))
        if (!parsed.ok) throw new Error('Published public example did not parse')
        const id = parsed.value.frontmatter.id
        await expect(readFile(join(fixture.root, `workorders/${id}.md`), 'utf8')).resolves.toBe(candidate)
        await expect(readFile(join(fixture.root, `workorders/${id}.source-audit.json`), 'utf8')).resolves.toBe(audit)
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: id }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { active: [], orders: [{ id, status: 'draft', state: null,
                layers: { source: [], local: [], ci: [], runtime: [], deployment: [] } }] },
        })
        await expect(runWorkApplication({ operation: 'work-accept', workOrderId: id }, fixture.composition))
            .resolves.toMatchObject({ kind: 'human-needed' })
    }, 120_000)

    it('retains actionable parser findings for inventory, intent and programme inputs', async () => {
        const fixture = await configuredFixture()
        await writeFile(join(fixture.root, 'intents/invalid.json'), '{}')
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/invalid.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('Intent descriptor section of ./node_modules/@b0dea/cockpit/docs/work-and-browser.md') })
        const invalid = (bytes: string) => bytes.replace('## Non-goals\nChanging the storage provider.\n', '')

        const inventoryPath = join(fixture.root, 'workorders/WO-001.md')
        const inventoryBytes = await readFile(inventoryPath, 'utf8')
        await writeFile(inventoryPath, invalid(inventoryBytes))
        await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toEqual({
            kind: 'refusal', operation: 'work-status',
            reason: 'invalid work order workorders/WO-001.md: WO_SECTION_MISSING [Non-goals]: Required section is missing; WO_SECTION_INVALID [Non-goals]: Section requires explicit content',
        })
        await writeFile(inventoryPath, inventoryBytes)
        await Promise.all([
            rm(join(fixture.root, 'workorders/WO-003.md')),
            rm(join(fixture.root, 'workorders/WO-003.source-audit.json')),
        ])

        const intentPath = join(fixture.root, 'candidates/WO-004.md')
        const intentBytes = await readFile(intentPath, 'utf8')
        await writeFile(intentPath, invalid(intentBytes))
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition)).resolves.toEqual({
            kind: 'refusal', operation: 'work-intake',
            reason: 'invalid work order candidates/WO-004.md: WO_SECTION_MISSING [Non-goals]: Required section is missing; WO_SECTION_INVALID [Non-goals]: Section requires explicit content',
        })
        await writeFile(intentPath, intentBytes.replace('status: draft', 'status: ready'))
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition)).resolves.toEqual({
            kind: 'refusal', operation: 'work-intake', reason: 'intent candidate candidates/WO-004.md is not a draft work order',
        })

        const programmePath = join(fixture.root, 'candidates/WO-005.md')
        const programmeBytes = await readFile(programmePath, 'utf8')
        await writeFile(programmePath, invalid(programmeBytes))
        await expect(runWorkApplication({ operation: 'work-programme-mint', programmeId: 'cache', candidate: 'candidates/WO-005.md' }, fixture.composition)).resolves.toEqual({
            kind: 'refusal', operation: 'work-programme-mint',
            reason: 'invalid work order candidates/WO-005.md: WO_SECTION_MISSING [Non-goals]: Required section is missing; WO_SECTION_INVALID [Non-goals]: Section requires explicit content',
        })
        await writeFile(programmePath, programmeBytes.replace('status: draft', 'status: active'))
        await expect(runWorkApplication({ operation: 'work-programme-mint', programmeId: 'cache', candidate: 'candidates/WO-005.md' }, fixture.composition)).resolves.toEqual({
            kind: 'refusal', operation: 'work-programme-mint', reason: 'programme candidate candidates/WO-005.md is not a draft work order',
        })
    }, 120_000)

})
