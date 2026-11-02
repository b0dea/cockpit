import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionStep } from '../environment/contract.js'
import { prepareGeneratedEnvironmentCurrentness } from '../generated-environment/command.js'
import { runWorkApplication } from './application.js'
import { createConfiguredWorkApplicationComposition } from './composition.js'
import { parseWorkOrder } from './contract.js'
import { createWorkCompositionFixtureSupport, reidentifyWorkOrder } from '../../test-support/work-composition-fixture.js'

const executionBoundary = vi.hoisted(() => ({ steps: [] as ExecutionStep[] }))
vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    return { ...actual, executeProbe: async (step: ExecutionStep) => {
        executionBoundary.steps.push(step)
        return actual.executeProbe(step)
    } }
})

const roots: string[] = []
afterEach(async () => {
    executionBoundary.steps.length = 0
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const { configuredFixture } = createWorkCompositionFixtureSupport(roots)

describe('configured durable work application composition', () => {
    it('executes an authenticated symlinked configured tool with only the bounded configured PATH', async () => {
        const fixture = await configuredFixture()
        const tools = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-configured-tool-'))); roots.push(tools)
        const configuredPath = `${tools}${delimiter}${join(fixture.root, 'tools')}${delimiter}${resolve(process.execPath, '..')}`
        const target = join(tools, 'npm-real')
        await writeFile(target, `#!/usr/bin/env node\nprocess.stdout.write(process.env.PATH === ${JSON.stringify(configuredPath)} ? 'passed\\n' : 'unexpected path\\n')\n`)
        await chmod(target, 0o700)
        await symlink('npm-real', join(tools, 'npm'))
        const declaration = await readFile(fixture.configPath, 'utf8')
        await writeFile(fixture.configPath, declaration.replace('requires_stack = false }', 'requires_stack = false, select = { file = ["{value}"] } }'))
        const configured = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath,
            env: Object.freeze({ PATH: configuredPath }) })
        if (configured.kind !== 'complete') throw new Error(configured.reason)
        const result = await runWorkApplication({ operation: 'test-run', gate: 'focused', mode: 'canonical' }, configured.composition)
        if (result.kind !== 'complete') throw new Error(`configured symlinked tool refused: ${result.kind === 'refusal' ? result.reason : result.kind}`)
        expect(result).toMatchObject({ kind: 'complete', operation: 'test-run', value: { verdict: 'PASS', satisfiesGate: true } })
        const execution = executionBoundary.steps.find(step => step.labels.owner === 'work-application' && step.argv0 === target)
        expect(execution?.consumedFiles).toContainEqual(expect.objectContaining({
            path: target,
            maxBytes: (await lstat(target)).size,
            executable: true,
            executionMode: 'verified-path',
        }))
        expect(execution).toMatchObject({ cwd: fixture.root, argv: [target, 'test', '--', 'cache-1'], timeoutMs: 1_800_000 })

        // A stock runner rejects options it does not know, so the selection arrives only as the
        // arguments the stage declared for that kind, in the runner's own spelling.
        executionBoundary.steps.length = 0
        await expect(runWorkApplication({ operation: 'test-run', gate: 'focused', mode: 'canonical',
            select: { kind: 'file', value: 'src/a b.ts' } }, configured.composition))
            .resolves.toMatchObject({ kind: 'unsatisfied', reason: expect.stringContaining('PARTIAL'), value: { verdict: 'PARTIAL' } })
        expect(executionBoundary.steps.find(step => step.argv0 === target)?.argv)
            .toEqual([target, 'test', '--', 'cache-1', 'src/a b.ts'])
    }, 120_000)

    it('keeps non-browser work available without an active configured browser lease', async () => {
        const fixture = await configuredFixture()
        const manifest = JSON.stringify({ dependencies: { '@playwright/test': '1.2.3' } })
        const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } })
        const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
        await Promise.all([writeFile(join(fixture.root, 'app/package.json'), manifest), writeFile(join(fixture.root, 'app/package-lock.json'), lockfile)])
        const source = await readFile(fixture.configPath, 'utf8')
        await writeFile(fixture.configPath, source.replace('[environment.generated]', `[environment]
addressing = "port"
authentication = "bypassed"
posture_requirements = [{ requirement = "synthetic-browser", addressing = "port", authentication = "bypassed" }]
generated_host_paths = [".browser/runner", ".browser/mcp", ".browser/cli", ".browser/auth", ".browser/debugger"]
[environment.generated]`) + `
[browser]
harnesses = [{ target = "codexcli", version = "0.149.0" }]
images = { runner = { reference = "synthetic.invalid/browser@sha256:${'a'.repeat(64)}", driver_version = "1.2.3", architectures = ["arm64"] }, mcp = { reference = "synthetic.invalid/browser@sha256:${'a'.repeat(64)}", driver_version = "1.2.3" } }
runner_health_measurement = { duration_seconds = 15, provenance = { source = "synthetic-browser.toml", observed_on = "2026-10-24", kind = "measured", reason = "Synthetic browser readiness measurement" } }
project = { manifest = "app/package.json", manifest_sha256 = "${hash(manifest)}", lockfile = "app/package-lock.json", sha256 = "${hash(lockfile)}", driver_version = "1.2.3" }
endpoint = "ws://localhost:4100/"
max_clients = 1
proxy = { host_variable = "APP_HOST_PORT", server_port = 4099, proxy_port = 4100, allowed_hosts = ["localhost:4100"] }
resolver = []
authentication = { policy = "none", states = [] }
data = { mode = "empty", isolated = true, reaches_production = false }
request_preapproval = true
headed = false
artifacts = { runner = ".browser/runner", mcp = ".browser/mcp", cli = ".browser/cli", auth = ".browser/auth", debugger = ".browser/debugger" }
`)
        const browserCurrentness = await prepareGeneratedEnvironmentCurrentness({ configPath: fixture.configPath })
        expect(browserCurrentness.outcome).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'GENERATED_INPUT_INVALID', message: expect.stringContaining('current port lease'),
        })] })
        const configured = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        expect(configured).toMatchObject({ kind: 'complete' })
        if (configured.kind !== 'complete') throw new Error(configured.reason)
        for (const operation of ['work-status', 'work-metrics'] as const) {
            await expect(runWorkApplication({ operation }, configured.composition)).resolves.toMatchObject({ kind: 'complete', operation })
        }
        await expect(runWorkApplication({ operation: 'test-run', gate: 'focused', mode: 'canonical' }, configured.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'browser-drive' }, configured.composition)).resolves.toMatchObject({ kind: 'refusal' })
    })

    it('reads only qualified artifacts from an admitted external sibling repository', async () => {
        const fixture = await configuredFixture({ externalSibling: true, authority: ['siblings/app/src/external.ts'] })
        await Promise.all([reidentifyWorkOrder(fixture.root, 'WO-001', 'WO-101'), reidentifyWorkOrder(fixture.root, 'WO-002', 'WO-102')])
        await writeFile(join(fixture.root, '.native-expect-artifact'), 'authenticated sibling artifact')
        const acceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-101' }, fixture.composition)
        if (acceptance.kind !== 'human-needed') throw new Error(`external sibling acceptance continuation unavailable: ${acceptance.kind === 'refusal' ? acceptance.reason : acceptance.kind}`)
        await expect(acceptance.continuation.decide(`accept ${acceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        for (const approach of ['authenticate sibling step one', 'authenticate sibling step two']) {
            await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-101', approach }, fixture.composition))
                .resolves.toMatchObject({ kind: 'complete' })
        }
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-101' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-review', value: { reviews: expect.any(Array) },
        })

        const original = await readFile(join(fixture.root, 'workorders/WO-102.md'), 'utf8')
        await writeFile(join(fixture.root, 'workorders/WO-102.md'), original.replace('- siblings/app/src/external.ts', '- siblings/unknown/src/external.ts'))
        const unknownAcceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-102' }, fixture.composition)
        if (unknownAcceptance.kind !== 'human-needed') throw new Error('unknown sibling acceptance continuation unavailable')
        await expect(unknownAcceptance.continuation.decide(`accept ${unknownAcceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-102' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('unknown sibling'),
        })
        await writeFile(join(fixture.root, 'workorders/WO-102.md'), original.replace('- siblings/app/src/external.ts', '- siblings/app/../src/external.ts'))
        await expect(runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-102' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('WO_AUTHORITY_INVALID'),
        })
    }, 120_000)

    it('refuses ignored credential artifacts before native review or grading dispatch', async () => {
        const fixture = await configuredFixture({ authority: ['.npmrc'] })
        await Promise.all([reidentifyWorkOrder(fixture.root, 'WO-001', 'WO-201'), reidentifyWorkOrder(fixture.root, 'WO-002', 'WO-202')])
        await writeFile(join(fixture.root, '.npmrc'), 'synthetic-token=must-not-be-read\n')
        await writeFile(join(fixture.root, '.gitignore'), `${await readFile(join(fixture.root, '.gitignore'), 'utf8')}.npmrc\n.env\n`)
        const acceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-201' }, fixture.composition)
        if (acceptance.kind !== 'human-needed') throw new Error('credential refusal acceptance continuation unavailable')
        await expect(acceptance.continuation.decide(`accept ${acceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-201' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('credential-shaped path'),
        })
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-201' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('credential-shaped path'),
        })
        await expect(readFile(join(fixture.root, '.native-calls'))).rejects.toMatchObject({ code: 'ENOENT' })

        const secondPath = join(fixture.root, 'workorders/WO-202.md')
        await writeFile(secondPath, (await readFile(secondPath, 'utf8')).replace('- .npmrc', '- siblings/app/.env'))
        await writeFile(join(fixture.applicationRoot, '.env'), 'SYNTHETIC_PRIVATE_VALUE=not-read\n')
        const secondAcceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-202' }, fixture.composition)
        if (secondAcceptance.kind !== 'human-needed') throw new Error('declared-instance refusal acceptance continuation unavailable')
        await expect(secondAcceptance.continuation.decide(`accept ${secondAcceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-202' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('declared environment instance'),
        })

        await reidentifyWorkOrder(fixture.root, 'WO-003', 'WO-203')
        const nestedPath = join(fixture.root, 'workorders/WO-203.md')
        await writeFile(nestedPath, (await readFile(nestedPath, 'utf8')).replace('- .npmrc', '- .env.local/.env.example'))
        await mkdir(join(fixture.root, '.env.local'))
        await writeFile(join(fixture.root, '.env.local/.env.example'), 'SYNTHETIC_PRIVATE_VALUE=not-read\n')
        await writeFile(join(fixture.root, '.gitignore'), `${await readFile(join(fixture.root, '.gitignore'), 'utf8')}.env.local/\n`)
        const nestedAcceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-203' }, fixture.composition)
        if (nestedAcceptance.kind !== 'human-needed') throw new Error('nested credential refusal acceptance continuation unavailable')
        await expect(nestedAcceptance.continuation.decide(`accept ${nestedAcceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-203' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('credential-shaped path'),
        })

    }, 120_000)

    it('executes whichever accepted order is selected and records creation history for an order copied from another', async () => {
        const fixture = await configuredFixture()
        // A published order is usually a near-copy of its draft or an earlier order; Git's copy detection
        // must not hide that the order was added.
        const copied = (await readFile(join(fixture.root, 'workorders/WO-001.md'), 'utf8')).replaceAll('WO-001', 'WO-008')
        await writeFile(join(fixture.root, 'workorders/WO-008.md'), copied)
        await writeFile(join(fixture.root, 'workorders/WO-008.source-audit.json'), await readFile(join(fixture.root, 'workorders/WO-001.source-audit.json')))
        // Stay within the default WIP cap of three orders.
        await Promise.all([rm(join(fixture.root, 'workorders/WO-003.md')), rm(join(fixture.root, 'workorders/WO-003.source-audit.json'))])
        for (const argv of [['add', '--all', 'workorders'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'publish copied order']]) {
            const result = spawnSync('/usr/bin/git', argv, { cwd: fixture.root, encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(0)
        }
        for (const id of ['WO-001', 'WO-008']) {
            const started = await runWorkApplication({ operation: 'work-accept', workOrderId: id }, fixture.composition)
            if (started.kind !== 'human-needed') throw new Error(`${id} acceptance unavailable: ${started.kind === 'refusal' ? started.reason : started.kind}`)
            await expect(started.continuation.decide(`accept ${started.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        }
        for (const id of ['WO-008', 'WO-001']) {
            const executed = await runWorkApplication({ operation: 'work-execute', workOrderId: id, approach: `reproduce through ${id}` }, fixture.composition)
            expect(executed, executed.kind === 'refusal' ? executed.reason : executed.kind).toMatchObject({ kind: 'complete', value: { step: 1 } })
        }
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { metrics: { history: { observedOrders: 2 } } },
        })
    }, 120_000)

    it('routes current source-bound work through acceptance, native grading, CAS refusal and the completion sentinel', async () => {
        const fixture = await configuredFixture()
        const ordersPath = join(fixture.root, 'workorders'); const heldOrdersPath = join(fixture.root, 'workorders-held')
        await rename(ordersPath, heldOrdersPath)
        try {
            const fixIntake = await runWorkApplication({ operation: 'work-intake', intent: 'intents/fix.json', candidate: 'candidates/missing.md' }, fixture.composition)
            expect(fixIntake, fixIntake.kind === 'refusal' ? fixIntake.reason : fixIntake.kind).toMatchObject({
                kind: 'complete', operation: 'work-intake', value: { kind: 'fix' },
            })
            await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json' }, fixture.composition)).resolves.toMatchObject({
                kind: 'complete', operation: 'work-intake', value: { candidateRequired: true },
            })
            await expect(readdir(ordersPath)).rejects.toMatchObject({ code: 'ENOENT' })
        } finally { await rename(heldOrdersPath, ordersPath) }
        const afterFirstUse = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (afterFirstUse.kind !== 'complete') throw new Error(afterFirstUse.reason)
        fixture.composition = afterFirstUse.composition
        const contractPath = join(fixture.root, 'workorders/WO-001.md'); const contractBytes = await readFile(contractPath)
        const journalDirectory = join(fixture.root, '.cockpit/transactions'); const orderDirectory = join(fixture.root, '.cockpit/work-orders/WO-001')
        await Promise.all([mkdir(journalDirectory, { recursive: true }), mkdir(orderDirectory, { recursive: true })])
        const configBytes = await readFile(fixture.configPath)
        const journalPath = join(journalDirectory, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json')
        await writeFile(journalPath, JSON.stringify({ version: 1, kind: 'work-order', owner: 'WO-001', stage: 'committed', entries: [
            { path: 'cockpit.toml', before: configBytes.toString('base64'), beforeDigest: createHash('sha256').update(configBytes).digest('hex'),
                after: configBytes.toString('base64'), afterDigest: createHash('sha256').update(configBytes).digest('hex') },
            { path: '.cockpit/work-orders/WO-001/current.json', before: null, beforeDigest: null,
                after: Buffer.from('{}').toString('base64'), afterDigest: createHash('sha256').update('{}').digest('hex') },
        ] }))
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('malformed'),
        })
        await expect(readFile(fixture.configPath)).resolves.toEqual(configBytes)
        await rm(journalPath)
        const afterMalformed = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (afterMalformed.kind !== 'complete') throw new Error(afterMalformed.reason)
        fixture.composition = afterMalformed.composition
        const crashedContract = Buffer.from(contractBytes.toString('utf8').replace(/^status: .*$/m, 'status: parked'))
        const crashedParsed = parseWorkOrder(crashedContract); if (!crashedParsed.ok) throw new Error('crash fixture contract refused')
        const crashedManifest = Buffer.from(JSON.stringify({ version: 1, generation: 1, contractPath: 'workorders/WO-001.md',
            contractDigest: crashedParsed.value.digest, files: { 'contract.md': createHash('sha256').update(crashedContract).digest('hex') } }))
        const crashedGeneration = join(orderDirectory, 'generation-00000001')
        await mkdir(crashedGeneration)
        await writeFile(join(crashedGeneration, 'contract.md'), crashedContract)
        const divergentCurrent = Buffer.from('{"operator":"divergent"}')
        await Promise.all([writeFile(contractPath, crashedContract), writeFile(join(orderDirectory, 'current.json'), divergentCurrent)])
        const divergentJournal = JSON.stringify({ version: 1, kind: 'work-order', owner: 'WO-001', stage: 'prepared', entries: [
            { path: 'workorders/WO-001.md', before: contractBytes.toString('base64'), beforeDigest: createHash('sha256').update(contractBytes).digest('hex'),
                after: crashedContract.toString('base64'), afterDigest: createHash('sha256').update(crashedContract).digest('hex') },
            { path: '.cockpit/work-orders/WO-001/current.json', before: null, beforeDigest: null,
                after: crashedManifest.toString('base64'), afterDigest: createHash('sha256').update(crashedManifest).digest('hex') },
        ] })
        await writeFile(journalPath, divergentJournal)
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('diverged'),
        })
        await expect(readFile(contractPath)).resolves.toEqual(crashedContract)
        await expect(readFile(join(orderDirectory, 'current.json'))).resolves.toEqual(divergentCurrent)
        await expect(readFile(journalPath, 'utf8')).resolves.toBe(divergentJournal)
        await rm(join(orderDirectory, 'current.json'))
        await writeFile(contractPath, crashedContract)
        await writeFile(journalPath, JSON.stringify({ version: 1, kind: 'work-order', owner: 'WO-001', stage: 'prepared', entries: [
            { path: 'workorders/WO-001.md', before: contractBytes.toString('base64'), beforeDigest: createHash('sha256').update(contractBytes).digest('hex'),
                after: crashedContract.toString('base64'), afterDigest: createHash('sha256').update(crashedContract).digest('hex') },
            { path: '.cockpit/work-orders/WO-001/current.json', before: null, beforeDigest: null,
                after: crashedManifest.toString('base64'), afterDigest: createHash('sha256').update(crashedManifest).digest('hex') },
        ] }))
        const afterDivergence = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (afterDivergence.kind !== 'complete') throw new Error(afterDivergence.reason)
        fixture.composition = afterDivergence.composition
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({ kind: 'complete' })
        await expect(readFile(contractPath)).resolves.toEqual(contractBytes)
        await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readdir(crashedGeneration)).rejects.toMatchObject({ code: 'ENOENT' })
        const afterCrash = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (afterCrash.kind !== 'complete') throw new Error(afterCrash.reason)
        fixture.composition = afterCrash.composition
        await writeFile(journalPath, JSON.stringify({ version: 1, kind: 'work-order', owner: 'WO-001', stage: 'prepared', entries: [
            { path: 'workorders/WO-001.md', before: contractBytes.toString('base64'), beforeDigest: createHash('sha256').update(contractBytes).digest('hex'),
                after: crashedContract.toString('base64'), afterDigest: createHash('sha256').update(crashedContract).digest('hex') },
            { path: '.cockpit/work-orders/WO-001/current.json', before: null, beforeDigest: null,
                after: crashedManifest.toString('base64'), afterDigest: createHash('sha256').update(crashedManifest).digest('hex') },
        ] }))
        const lockPath = join(orderDirectory, 'transaction.lock'); await writeFile(lockPath, 'live', { flag: 'wx' })
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('contended'),
        })
        await expect(readFile(contractPath)).resolves.toEqual(contractBytes)
        await expect(readFile(journalPath, 'utf8')).resolves.toContain('WO-001')
        await Promise.all([rm(lockPath), rm(journalPath)])
        const recovered = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (recovered.kind !== 'complete') throw new Error(recovered.reason)
        fixture.composition = recovered.composition
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/fix.json', candidate: 'candidates/missing.md' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-intake', value: { kind: 'fix' },
        })
        await expect(readFile(join(fixture.root, 'workorders/WO-004.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        const privateOrders = join(fixture.root, '.cockpit/work-orders')
        const beforeInvalid = await readdir(privateOrders).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw error
        })
        const inherited = Object.assign(Object.create({ operation: 'work-status' }), { workOrderId: 'WO-001' })
        for (const request of [inherited, { operation: 'constructor' }, { operation: 'work-accept' }, { operation: 'work-accept', workOrderId: undefined }]) {
            await expect(runWorkApplication(request as never, fixture.composition)).resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
        }
        const afterInvalid = await readdir(privateOrders).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw error
        })
        expect(afterInvalid).toEqual(beforeInvalid)
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-metrics', value: { metrics: { kind: 'metrics' } },
        })
        await writeFile(join(fixture.root, 'app/.env'), 'SYNTHETIC=true\n')
        await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-status', reason: expect.stringContaining('refuses declared environment instance: app/.env'),
        })
        await rm(join(fixture.root, 'app/.env'))
        await expect(runWorkApplication({ operation: 'test-run', gate: 'focused', mode: 'canonical' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'test-run', value: { verdict: 'PASS', satisfiesGate: true },
        })
        await writeFile(join(fixture.root, '.gate-mutate'), 'mutate')
        await expect(runWorkApplication({ operation: 'test-run', gate: 'focused', mode: 'canonical' }, fixture.composition)).resolves.toMatchObject({
            kind: 'unsatisfied', operation: 'test-run', reason: expect.stringContaining('VOID'), value: { verdict: 'VOID', satisfiesGate: false,
                observations: [expect.objectContaining({ id: 'unit', exitCode: 0 })] },
        })
        await Promise.all([rm(join(fixture.root, '.gate-mutate')), writeFile(join(fixture.root, 'src/cache.ts'), "export function refresh() { return 'fresh' }\n")])
        await expect(runWorkApplication({ operation: 'test-run', gate: 'stacked', mode: 'canonical' }, fixture.composition)).resolves.toMatchObject({
            kind: 'unsatisfied', operation: 'test-run', reason: expect.stringContaining('stack unavailable'), value: { verdict: 'DEGRADED' },
        })
        const firstAuditPath = join(fixture.root, 'workorders/WO-001.source-audit.json'); const firstAudit = await readFile(firstAuditPath)
        const decodedAudit = JSON.parse(firstAudit.toString('utf8')) as { sources: unknown; gaps: unknown }
        await writeFile(firstAuditPath, JSON.stringify({ sources: decodedAudit.sources, gaps: decodedAudit.gaps }))
        await expect(runWorkApplication({ operation: 'work-intake', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-intake', reason: expect.stringContaining('source audit'),
        })
        await writeFile(firstAuditPath, firstAudit)
        await expect(runWorkApplication({ operation: 'work-intake', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-intake', value: { skills: { kind: 'references', references: [{
                reference: 'repository:cache-planning', category: 'planning', applicable: true,
                reason: expect.stringContaining('fixture-auditor/operator-confirmed'),
            }] } },
        })
        let accessorReads = 0
        const accessor = Object.defineProperty({ workOrderId: 'WO-001' }, 'operation', {
            enumerable: true, get: () => { accessorReads += 1; return 'work-status' },
        })
        await expect(runWorkApplication(accessor as never, fixture.composition)).resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
        expect(accessorReads).toBe(0)

        const started = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (started.kind !== 'human-needed') throw new Error(`acceptance continuation unavailable: ${started.kind === 'refusal' ? started.reason : started.kind}`)
        await expect(started.continuation.decide(`accept ${started.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await writeFile(join(fixture.root, 'src/cache.ts'), "export function refresh() { return 'fresh-after-head-change' }\n")
        const committed = spawnSync('/usr/bin/git', ['add', 'src/cache.ts'], { cwd: fixture.root, encoding: 'utf8' })
        expect(committed.status, committed.stderr).toBe(0)
        const advanced = spawnSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'advance synthetic source'], {
            cwd: fixture.root, encoding: 'utf8',
        })
        expect(advanced.status, advanced.stderr).toBe(0)
        const heartbeat = await runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/heartbeat.json' }, fixture.composition)
        expect(heartbeat, heartbeat.kind === 'refusal' ? heartbeat.reason : heartbeat.kind).toMatchObject({
            kind: 'complete', operation: 'work-record', value: { value: { revision: 1 } },
        })
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/forged-runtime-evidence.json' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-record', reason: expect.stringContaining('contained source file'),
        })
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/source-evidence.json' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-record', value: { value: { revision: 2, evidence: [expect.objectContaining({
                layer: 'source', reference: expect.stringMatching(/^src\/cache\.ts#sha256=[a-f0-9]{64}$/),
            })] } },
        })
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'current' })] } }] },
        })
        await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach: 'current checked proof' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-execute' })
        const currentSource = await readFile(join(fixture.root, 'src/cache.ts'))
        await writeFile(join(fixture.root, 'src/cache.ts'), "export function refresh() { return 'same-head-change' }\n")
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ drift: expect.arrayContaining([expect.objectContaining({ expected: expect.any(String), actual: expect.any(String),
                expectedWorktreeDigest: expect.any(String), actualWorktreeDigest: expect.any(String) })]),
            layers: { source: [expect.objectContaining({ freshness: 'stale' })] } }] },
        })
        await expect(runWorkApplication({ operation: 'work-resume' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-resume', value: { replay: true },
        })
        await writeFile(join(fixture.root, 'src/cache.ts'), currentSource)
        await writeFile(join(fixture.root, 'src/auth-tokenizer.ts'), 'export const currentness = true\n')
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'stale' })] } }] },
        })
        await expect(runWorkApplication({ operation: 'work-resume' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-resume', value: { replay: true },
        })
        await rm(join(fixture.root, 'src/auth-tokenizer.ts'))
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'current' })] } }] },
        })
        // The documented place for progress events is coordination state, so recording one keeps step proof current.
        await mkdir(join(fixture.root, 'workorders/events'))
        await writeFile(join(fixture.root, 'workorders/events/progress.json'), JSON.stringify({ kind: 'heartbeat' }))
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'workorders/events/progress.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-record' })
        await expect(runWorkApplication({ operation: 'work-resume' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-resume', value: { step: 2, replay: false },
        })
        const afterHeartbeat = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (afterHeartbeat.kind !== 'complete') throw new Error(afterHeartbeat.reason)
        await expect(runWorkApplication({ operation: 'work-resume' }, afterHeartbeat.composition)).resolves.toMatchObject({ kind: 'complete', operation: 'work-resume' })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-review', reason: expect.stringContaining('current checked proof for every step'),
        })
        await expect(readFile(join(fixture.root, '.native-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(join(fixture.root, '.verification-fail'), 'fail')
        await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach: 'bounded failure control' }, fixture.composition)).resolves.toMatchObject({
            kind: 'unsatisfied', operation: 'work-execute', reason: 'Declared verification failed with exit 1',
            value: { kind: 'paused', verification: { exitCode: 1, stdout: 'cache-1 failed: stale value\n' } },
        })
        await rm(join(fixture.root, '.verification-fail'))
        await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach: 'current checked proof for final step' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-execute' })
        await expect(runWorkApplication({ operation: 'work-resume' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('current checked proof for every step'),
        })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-review', value: { reviews: expect.arrayContaining([expect.objectContaining({ kind: 'simplification',
                findings: expect.arrayContaining([expect.objectContaining({ id: 'simplification-advisory' })]),
                dispositions: expect.arrayContaining([expect.objectContaining({ findingId: 'simplification-advisory', outcome: 'accepted-risk' })]),
            })]) },
        })
        await expect(readFile(join(fixture.root, '.native-calls'), 'utf8')).resolves.toBe('simplification\ncode-spec\nsecurity\n')
        const firstMovement = await runWorkApplication({ operation: 'work-metrics' }, fixture.composition)
        expect(firstMovement).toMatchObject({ kind: 'complete', value: { metrics: {
            history: { coverage: 'partial', observedOrders: 1, totalOrders: 3, writer: 'composition-current-generation-history' },
            heartbeat: { samples: 1, meanMs: expect.any(Number) },
        } } })
        if (firstMovement.kind !== 'complete') throw new Error(firstMovement.kind === 'refusal' ? firstMovement.reason : firstMovement.kind)
        const firstMovementMean = (firstMovement.value as { metrics: { heartbeat: { meanMs: number } } }).metrics.heartbeat.meanMs
        const codexPath = join(fixture.root, 'tools/codex'); const unavailableCodexPath = `${codexPath}.unavailable`
        await rename(codexPath, unavailableCodexPath)
        const optionalCapabilities = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (optionalCapabilities.kind !== 'complete') throw new Error(optionalCapabilities.reason)
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, optionalCapabilities.composition))
            .resolves.toMatchObject({ kind: 'complete', operation: 'work-status' })
        for (const approach of ['authenticate unavailable-evaluator step one', 'authenticate unavailable-evaluator step two']) {
            const executed = await runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach }, fixture.composition)
            expect(executed, executed.kind === 'refusal' ? executed.reason : executed.kind)
                .toMatchObject({ kind: 'complete', operation: 'work-execute' })
        }
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-grade', reason: expect.stringContaining('simplification review did not run: the Codex CLI (codex) is not on PATH'),
        })
        await expect(runWorkApplication({ operation: 'browser-drive' }, optionalCapabilities.composition))
            .resolves.toMatchObject({ kind: 'refusal', operation: 'browser-drive', reason: expect.stringContaining('browser application projection is unavailable') })
        await rename(unavailableCodexPath, codexPath)
        for (const approach of ['reauthenticate restored-evaluator step one', 'reauthenticate restored-evaluator step two']) {
            await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach }, fixture.composition))
                .resolves.toMatchObject({ kind: 'complete', operation: 'work-execute' })
        }
        const actorsPath = join(fixture.root, '.cockpit/actors'); const outsideActors = join(fixture.root, 'outside-actors')
        await Promise.all([rm(actorsPath, { recursive: true }), mkdir(outsideActors)])
        await symlink(outsideActors, actorsPath)
        const graded = await runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, fixture.composition)
        if (graded.kind === 'refusal') throw new Error(`grading refused: ${graded.reason}`)
        expect(graded).toMatchObject({ kind: 'complete', value: { completed: true } })
        await expect(readdir(outsideActors)).resolves.toEqual([])
        await rm(actorsPath)
        await mkdir(actorsPath)
        expect((await readFile(join(fixture.root, '.native-calls'), 'utf8')).trim().split('\n').at(-1)).toBe('grader')
        await expect(runWorkApplication({ operation: 'work-metrics' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { metrics: { heartbeat: { samples: 1, meanMs: firstMovementMean } } },
        })
        const manifest = JSON.parse(await readFile(join(fixture.root, '.cockpit/work-orders/WO-001/current.json'), 'utf8')) as { generation: number }
        const generation = `generation-${String(manifest.generation).padStart(8, '0')}`
        const completion = await readFile(join(fixture.root, '.cockpit/work-orders/WO-001', generation, 'completion.json'), 'utf8')
        expect(completion).toContain('WO-001')
        expect(JSON.parse(completion)).toMatchObject({ evaluatedContractDigest: expect.stringMatching(/^[a-f0-9]{64}$/), completedContractDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
        await expect(readFile(contractPath, 'utf8')).resolves.toMatch(/^---[\s\S]*^status: completed$/m)
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-status', value: { orders: [{ id: 'WO-001', status: 'completed' }] },
        })
        await expect(runWorkApplication({ operation: 'work-resume' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-resume', reason: expect.stringContaining('No active work-order'),
        })
        for (const stale of ['acceptance.json', 'grade.json', 'reviews.json']) {
            await expect(readFile(join(fixture.root, '.cockpit/work-orders/WO-001', generation, stale))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await expect(readdir(join(fixture.root, '.cockpit/actors'))).resolves.toEqual([])

        const stale = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-002' }, fixture.composition)
        if (stale.kind !== 'human-needed') throw new Error('stale acceptance continuation unavailable')
        const changed = fixture.secondBytes.replace('Repair the cache boundary', 'Repair the current cache boundary')
        await writeFile(join(fixture.root, 'workorders/WO-002.md'), changed)
        await expect(stale.continuation.decide(`accept ${stale.continuation.digest}`)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('changed while awaiting'),
        })
        await expect(readFile(join(fixture.root, 'workorders/WO-002.md'), 'utf8')).resolves.toBe(changed)

        const malformed = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-003' }, fixture.composition)
        if (malformed.kind !== 'human-needed') throw new Error('malformed-response acceptance continuation unavailable')
        await expect(malformed.continuation.decide(`accept ${malformed.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        for (const approach of ['reproduce current behavior', 'verify the correction']) {
            await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-003', approach }, fixture.composition))
                .resolves.toMatchObject({ kind: 'complete' })
        }
        await writeFile(join(fixture.root, '.native-mode'), 'extra')
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-003' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal' })
        await expect(readdir(join(fixture.root, '.cockpit/actors'))).resolves.toEqual([])

        await writeFile(join(fixture.root, '.native-mode'), 'complete')
        await writeFile(join(fixture.root, '.verification-fail'), 'fail')
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-003' }, fixture.composition)).resolves.toMatchObject({
            kind: 'unsatisfied', operation: 'work-grade', reason: expect.stringContaining('AC1 failed after execution'),
            value: { criteria: expect.arrayContaining([expect.objectContaining({ criterion: 'AC1', outcome: 'failed after execution',
                reasons: [expect.stringContaining('failed with exit 1')] })]), verification: expect.arrayContaining([expect.objectContaining({ criterion: 'AC1', exitCode: 1 })]) },
        })
        const failedManifest = JSON.parse(await readFile(join(fixture.root, '.cockpit/work-orders/WO-003/current.json'), 'utf8')) as { generation: number }
        await expect(readFile(join(fixture.root, '.cockpit/work-orders/WO-003', `generation-${String(failedManifest.generation).padStart(8, '0')}`, 'grade.json'), 'utf8'))
            .resolves.toContain('failed after execution')
        await expect(readdir(join(fixture.root, '.cockpit/actors'))).resolves.toEqual([])

        await rm(join(fixture.root, '.verification-fail'))
        await writeFile(join(fixture.root, '.native-mode'), 'replay')
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-003' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal' })
        await expect(readdir(join(fixture.root, '.cockpit/actors'))).resolves.toEqual([])

        await writeFile(join(fixture.root, '.native-mode'), 'complete')
        const armedManifest = JSON.parse(await readFile(join(fixture.root, '.cockpit/work-orders/WO-003/current.json'), 'utf8')) as { files: Record<string, string> }
        await writeFile(join(fixture.root, '.completion-artifact-race'), armedManifest.files['grade.json'] ?? 'none')
        const race = runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-003' }, fixture.composition)
        // A subject that changes while completion publishes is a refusal, not an unmet grade.
        await expect(race).resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('Completion failed') })
        await expect(readFile(join(fixture.root, '.completion-observations'), 'utf8')).resolves.toBe('2')
        await expect(readFile(join(fixture.root, 'src/cache.ts'), 'utf8')).resolves.toContain('changed-at-completion')
        const thirdManifest = JSON.parse(await readFile(join(fixture.root, '.cockpit/work-orders/WO-003/current.json'), 'utf8')) as { generation: number }
        await expect(readFile(join(fixture.root, '.cockpit/work-orders/WO-003', `generation-${String(thirdManifest.generation).padStart(8, '0')}`, 'completion.json')))
            .rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readdir(join(fixture.root, '.cockpit/actors'))).resolves.toEqual([])

        await Promise.all([rm(join(fixture.root, 'workorders/WO-001.md')), rm(join(fixture.root, 'workorders/WO-001.source-audit.json')),
            rm(join(fixture.root, 'workorders/WO-002.md')), rm(join(fixture.root, 'workorders/WO-002.source-audit.json'))])
        await expect(runWorkApplication({ operation: 'work-programme-mint', programmeId: 'cache' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-programme-mint', value: { itemKey: 'repair', candidateRequired: true },
        })
        await expect(readFile(join(fixture.root, 'workorders/programmes/cache/repair.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(runWorkApplication({ operation: 'work-programme-mint', programmeId: 'cache', candidate: 'candidates/WO-005.md' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-programme-mint', value: { kind: 'mint', itemKey: 'repair' },
        })
        await expect(readFile(join(fixture.root, 'workorders/WO-005.source-audit.json'), 'utf8')).resolves.toContain('fixture-auditor')
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-intake', value: { candidateRequired: true },
        })
        await expect(readFile(join(fixture.root, 'workorders/WO-004.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(runWorkApplication({ operation: 'work-intake', intent: 'intents/work.json', candidate: 'candidates/WO-004.md' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', operation: 'work-intake', value: { kind: 'draft', skills: { kind: 'references' } },
        })
        await expect(readFile(join(fixture.root, 'workorders/WO-004.source-audit.json'), 'utf8')).resolves.toContain('fixture-auditor')

        await writeFile(fixture.configPath, `${await readFile(fixture.configPath, 'utf8')}\n# drift\n`)
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('source') })
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: '../escape' } as never, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
    }, 300_000)
})

describe('product test stages', () => {
    // Replaces the fixture's product tool and optionally extends the first declared stage, so each case
    // drives a real stage process through test-run.
    async function productStage(script: string, options: Readonly<{ stageFields?: string; env?: Readonly<Record<string, string | undefined>> }> = {}) {
        const fixture = await configuredFixture()
        await writeFile(join(fixture.root, 'tools/npm'), `#!/bin/sh\n${script}\n`)
        await chmod(join(fixture.root, 'tools/npm'), 0o700)
        if (options.stageFields) {
            const source = await readFile(fixture.configPath, 'utf8')
            await writeFile(fixture.configPath, source.replace('requires_stack = false }', `requires_stack = false, ${options.stageFields} }`))
        }
        const configured = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: { ...fixture.environment, ...options.env } })
        if (configured.kind !== 'complete') throw new Error(configured.reason)
        return { fixture, run: () => runWorkApplication({ operation: 'test-run', gate: 'focused', mode: 'canonical' }, configured.composition) }
    }

    it('stops a stage at its declared timeout and names the field to raise', async () => {
        const { run } = await productStage("sleep 5\nprintf 'passed\\n'", { stageFields: 'timeout_seconds = 1' })
        const started = Date.now()
        await expect(run()).resolves.toMatchObject({ kind: 'unsatisfied',
            reason: expect.stringContaining('unit: timed out after 1 seconds; raise testing.stages[].timeout_seconds') })
        expect(Date.now() - started).toBeLessThan(4_500)
    }, 120_000)

    it('judges a stage by its exit status when its output exceeds the capture limit', async () => {
        const passing = await productStage('/usr/bin/yes x | /usr/bin/head -c 200000\nexit 0')
        await expect(passing.run()).resolves.toMatchObject({ kind: 'complete', value: { verdict: 'PASS',
            observations: [expect.objectContaining({ id: 'unit', exitCode: 0, outputBytes: 200_000 })] } })
        const failing = await productStage('/usr/bin/yes x | /usr/bin/head -c 200000\nexit 3')
        await expect(failing.run()).resolves.toMatchObject({ kind: 'unsatisfied', reason: expect.stringMatching(/^FAIL/),
            value: { verdict: 'FAIL', observations: [expect.objectContaining({ id: 'unit', exitCode: 3 })] } })
    }, 120_000)

    it('passes build-tool variables such as HOME to a stage and strips every other parent variable', async () => {
        const capture = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-stage-env-'))); roots.push(capture)
        const { run } = await productStage(`printf '%s|%s' "$HOME" "\${SYNTHETIC_API_TOKEN-unset}" > ${join(capture, 'env')}\nprintf 'passed\\n'`, {
            env: { HOME: '/synthetic-home', SYNTHETIC_API_TOKEN: 'synthetic-secret' } })
        await expect(run()).resolves.toMatchObject({ kind: 'complete', value: { verdict: 'PASS' } })
        await expect(readFile(join(capture, 'env'), 'utf8')).resolves.toBe('/synthetic-home|unset')
    }, 120_000)
})
