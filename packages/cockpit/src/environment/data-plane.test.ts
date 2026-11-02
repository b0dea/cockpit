import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'smol-toml'
import { executeProbe } from '../environment-exec/execute.js'
import { acquireClaim, coordinationStateRecord, type CoordinationRecord } from './claims.js'
import { type CheckoutId, type CockpitId, type ExecutionStep, type HolderId, type StackId } from './contract.js'
import { consumeDataModeOutcomeProjection, executeDataMode, isDataModeCompletion, isDataModeObservation, observeDataMode, planDataMode, projectDataModeObservationSteps, projectPersonaOutputs, readDataModeOutcome } from './data-plane.js'
import { readState, selectStateRoot, transactState, type StateNamespace } from './state.js'
import { GeneratedEnvironment } from '../schema.js'
import { loadCockpitConfig } from '../config/load.js'

const provenance = { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared', reason: 'Synthetic overlay declaration' }
const overlay = { location: 'host', cwd: '.', argv: ['node', '-e', 'void 0'], timeout_seconds: 30, provenance }
const freshVolumeOverlay = {
    ...overlay,
    argv: ['node', '-e', `process.stdout.write(JSON.stringify({volume:'product-data',state:'empty',generation:'${'9'.repeat(64)}'}))`],
}
const stackOverlay = { ...overlay, location: 'in-stack', service: 'app' }
const structuralDecisions = [
    ['service-app', 'service', 'app'], ['volume-product-data', 'volume', 'product-data'],
    ['data-default', 'data-default', 'seeded'], ['data-mode-empty', 'data-mode', 'empty'],
    ['data-mode-seeded', 'data-mode', 'seeded'], ['data-mode-restored', 'data-mode', 'restored'],
    ['restore-policy', 'restore', 'policy'], ['mount-product-data', 'mount', 'app:volume:product-data:/app/data'],
].map(([id, subject, subject_id]) => ({
    id, subject, subject_id, decided_on: '2026-09-26', decision: `Synthetic ${subject}`,
    rejected: ['Undeclared structure'], reason: 'Reproducible environment', reviewer: 'consumer-maintainer', provenance,
}))

const environment = {
    compose_file: 'compose.generated.yml',
    services: [{
        id: 'app', sibling: 'app', role: 'service', profiles: [], command: ['node', 'server.mjs'],
        image: { reference: `example.invalid/synthetic@sha256:${'a'.repeat(64)}`, reason: 'Stable synthetic runtime', architectures: ['amd64'], manifest_probe: overlay, provenance },
        ports: [], mounts: [{ kind: 'volume', source: 'product-data', target: '/app/data' }], dependencies: [],
        health: { property: 'Synthetic route resolves', probe: stackOverlay, tool_probe: stackOverlay, interval_seconds: 5, timeout_seconds: 3, retries: 3, start_period_seconds: 20, measurement: { duration_seconds: 15, provenance } },
        toolchain_pins: [], provenance,
    }],
    volumes: [{ id: 'product-data', purpose: 'product-data', target: '/app/data', provenance }],
    data: {
        volume: 'product-data', default_mode: 'seeded',
        modes: ['empty', 'seeded', 'restored'].map((mode) => ({
            mode,
            operations: (mode === 'empty' ? ['schema'] : mode === 'seeded' ? ['schema', 'sweep', 'fixtures'] : ['schema', 'restore', 'rewrite']).map((kind, index, kinds) => ({
                id: kind, kind, operation: overlay, prerequisites: index === 0 ? [mode === 'restored' ? freshVolumeOverlay : overlay] : [],
                after: kinds.slice(0, index), fresh_volume_only: mode === 'restored', provenance,
            })),
            probes: [overlay], provenance,
        })),
        fixtures: {
            persona_source: 'fixtures/personas.json',
            persona_outputs: [{ path: 'fixtures/personas.generated.ts', format: 'typescript', reason: 'Synthetic importer cannot read JSON' }],
            volume_tag: 'synthetic-volume', pagination_warning: 'Default fixtures do not cover large lists',
            volume_operations: [overlay], volume_probes: [overlay], provenance,
        },
        restore: {
            rewrites: [{ category: 'object-store', operation: overlay, reason: 'Use local synthetic storage' }],
            untouched: ['identities', 'third-party-ids', 'personal-data', 'timer-state'], provenance,
        },
    },
    vendors: [],
    decisions: { path: 'docs/cockpit/environment-decisions.md', entries: structuralDecisions },
}

const cockpitId = `cockpit:data-plane-a1:${'a'.repeat(64)}` as CockpitId
const stackId = `stack:${'b'.repeat(64)}` as StackId
const checkoutA = `checkout:${'c'.repeat(64)}` as CheckoutId
const checkoutB = `checkout:${'d'.repeat(64)}` as CheckoutId
const holderA = `holder:${'e'.repeat(64)}:session` as HolderId
const holderB = `holder:${'f'.repeat(64)}:session` as HolderId
const roots: string[] = []
const nodeSha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const generation = '9'.repeat(64)
const observedAt = '2026-09-26T06:10:00.000Z'

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function namespace(): Promise<StateNamespace> {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-data-plane-'))
    roots.push(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
    if (selected.kind !== 'complete') throw new Error('state namespace unavailable')
    return selected.value
}

async function seedSoleHolder(state: StateNamespace): Promise<void> {
    const value: CoordinationRecord = {
        holders: [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-26T06:00:00.000Z' }],
        lease: { offset: 0, ports: { WEB: 4100 }, released: false, declaration: { step: 100, count: 3, bases: { WEB: 4100 } } },
        lastReleasedHolder: null, drain: null,
    }
    const result = await transactState(state, state.paths.coordination(stackId), { ownerId: holderA }, (current) =>
        coordinationStateRecord(state, stackId, current, '2026-09-26T06:00:00.000Z', value))
    if (result.kind !== 'complete') throw new Error('coordination seed failed')
}

function nodeStep(id: string, cwd: string, script = ''): ExecutionStep {
    return {
        id, argv: [process.execPath, '-e', script], argv0: process.execPath, cwd, env: {},
        timeoutMs: 2_000, stdoutLimitBytes: 1_024, stderrLimitBytes: 1_024,
        paths: [], ports: [], labels: {}, expected: [],
        consumedFiles: [{
            path: process.execPath, sha256: nodeSha256, maxBytes: 536_870_912,
            argvIndexes: [0], executable: true, executionMode: 'verified-path',
        }],
        filesystemChecks: [], compensation: [],
    }
}

const validCockpitConfig = '[cockpit]\nname = "synthetic-cockpit"\nsiblings_root = "siblings"\n\n[[sibling]]\nslug = "app"\ndir = "app-service"\nremote = "ssh://example.invalid/app.git"\nbranch = "main"\nmount = "always"\nacquire = "auto"\nvar = "APP_DIR"\ntoolchain = "node"\npurpose = "Synthetic application"\n\n[ports]\nstep = 100\ncount = 4\nbases = { APP_PORT = 4100 }\n'

async function configuration(declaration: typeof environment = environment) {
    const directory = await mkdtemp(join(tmpdir(), 'cockpit-data-config-'))
    roots.push(directory)
    const configPath = join(directory, 'cockpit.toml')
    await writeFile(configPath, `${validCockpitConfig}\n${stringify({ environment: { generated: declaration } })}`)
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') throw new Error(`configuration unavailable: ${JSON.stringify(loaded)}`)
    return loaded.result
}

async function planned(
    mode: 'empty' | 'seeded' | 'restored',
    state: StateNamespace,
    options: { includeFixtureVolume?: boolean; declaration?: typeof environment } = {},
) {
    const declaration = options.declaration ?? environment
    const parsed = GeneratedEnvironment.safeParse(declaration)
    if (!parsed.success) throw new Error(parsed.error.message)
    const result = planDataMode({
        environment: declaration, mode, checkoutRoot: process.cwd(),
        includeFixtureVolume: options.includeFixtureVolume ?? false,
        namespace: state, stackId, holderId: holderA, configuration: await configuration(declaration), generation, observedAt,
        resolve: (operation, context) => ({
            ...nodeStep(context.id, process.cwd()),
            argv: [process.execPath, ...operation.argv.slice(1)], argv0: process.execPath,
        }),
    })
    if (result.kind !== 'preview') throw new Error(JSON.stringify(result))
    return result.plan
}

describe('data mode execution', () => {
    it('admits a complete seeded overlay plan in declared order', async () => {
        const state = await namespace()
        const plan = await planned('seeded', state)
        const result = await executeDataMode(plan, executeProbe)

        expect(result).toMatchObject({
            kind: 'complete', mode: 'seeded',
            fixtureProvenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            applied: [
                'data:seeded:schema:prerequisite:0', 'data:seeded:schema', 'data:seeded:sweep',
                'data:seeded:fixtures', 'data:seeded:probe:0',
            ],
        })
        expect(isDataModeCompletion(result)).toBe(true)
        expect(isDataModeCompletion({ ...result })).toBe(false)
        expect(result).not.toHaveProperty('fixtureProvenance')

        const stored = await readState(state.paths.dataOutcome(stackId))
        if (stored.kind !== 'complete' || !stored.value.value || typeof stored.value.value !== 'object') {
            throw new Error('data outcome was not durable')
        }
        const configSha256 = (stored.value.value as { configSha256: string }).configSha256
        const completionTime = Date.parse(stored.value.updatedAt)
        expect(isDataModeCompletion(result, {
            stackId, configSha256, generation, mode: 'seeded',
            earliestMs: completionTime - 1, latestMs: completionTime + 1,
        })).toBe(true)
        expect(isDataModeCompletion(result, {
            stackId: `stack:${'f'.repeat(64)}` as StackId, configSha256, generation, mode: 'seeded',
            earliestMs: completionTime - 1, latestMs: completionTime + 1,
        })).toBe(false)
        expect(isDataModeCompletion(result, {
            stackId, configSha256, generation, mode: 'seeded',
            earliestMs: completionTime + 1, latestMs: completionTime + 2,
        })).toBe(false)
        expect(stored.value.updatedAt).not.toBe(observedAt)
        expect(await readDataModeOutcome({
            namespace: state, stackId, configSha256, generation: '8'.repeat(64), mode: 'seeded',
        })).toBeUndefined()
        const projection = await readDataModeOutcome({ namespace: state, stackId, configSha256, generation, mode: 'seeded' })
        expect(consumeDataModeOutcomeProjection(projection!)).toMatchObject({
            stackId, configSha256, generation, mode: 'seeded', outcome: { kind: 'complete' },
        })
        expect(consumeDataModeOutcomeProjection(projection!)).toBeUndefined()
        expect(consumeDataModeOutcomeProjection({ ...projection! })).toBeUndefined()
        let accessorEvaluations = 0
        const accessorInput = Object.defineProperty({
            stackId, configSha256, generation, mode: 'seeded',
        }, 'namespace', { enumerable: true, get: () => { accessorEvaluations += 1; return state } })
        expect(await readDataModeOutcome(accessorInput as never)).toBeUndefined()
        expect(accessorEvaluations).toBe(0)
        const proxyInput = new Proxy({ namespace: state, stackId, configSha256, generation, mode: 'seeded' as const }, {
            ownKeys: () => { accessorEvaluations += 1; throw new Error('must not run') },
        })
        expect(await readDataModeOutcome(proxyInput)).toBeUndefined()
        expect(accessorEvaluations).toBe(0)
        const priorHealthPlan = await planned('seeded', state)
        const priorProbeSteps = priorHealthPlan.steps.flatMap((metadata, index) => metadata.phase === 'probe' ? [priorHealthPlan.execution.steps[index]!] : [])
        const priorOutcomes = await Promise.all(priorProbeSteps.map((step) => executeProbe(step)))
        const healthProjection = await readDataModeOutcome({ namespace: state, stackId, configSha256, generation, mode: 'seeded' })
        const healthPlan = await planned('seeded', state)
        const observation = observeDataMode({
            plan: healthPlan, projection: healthProjection!, outcomes: priorOutcomes,
        })
        expect(observation).toMatchObject({ observed: { state: 'unavailable' }, applicability: { posture: 'data-plane' } })
        expect(isDataModeObservation(observation)).toBe(true)
        expect(isDataModeObservation({ ...observation! })).toBe(false)
        await expect(executeDataMode(healthPlan, executeProbe)).resolves.toMatchObject({ kind: 'refusal' })
        const currentProjection = await readDataModeOutcome({ namespace: state, stackId, configSha256, generation, mode: 'seeded' })
        const currentPlan = await planned('seeded', state)
        const currentProbeSteps = currentPlan.steps.flatMap((metadata, index) => metadata.phase === 'probe' ? [currentPlan.execution.steps[index]!] : [])
        expect(observeDataMode({
            plan: currentPlan, projection: currentProjection!,
            outcomes: await Promise.all(currentProbeSteps.map((step) => executeProbe(step))),
        })).toMatchObject({ observed: { state: 'available' } })
    })

    it('rejects a resolver that prepends undeclared host work', async () => {
        const state = await namespace()
        expect(planDataMode({
            environment, mode: 'seeded', checkoutRoot: process.cwd(), includeFixtureVolume: false,
            namespace: state, stackId, holderId: holderA, configuration: await configuration(), generation, observedAt,
            resolve: (operation, context) => ({
                ...nodeStep(context.id, process.cwd()),
                argv: [process.execPath, '-e', 'process.exit(9)', ...operation.argv], argv0: process.execPath,
            }),
        })).toMatchObject({ kind: 'refusal' })
    })

    it('rejects caller data that differs from the authenticated generated declaration', async () => {
        const state = await namespace()
        const changed = structuredClone(environment)
        changed.data.fixtures.pagination_warning = 'caller-selected warning'
        expect(planDataMode({
            environment: changed, mode: 'seeded', checkoutRoot: process.cwd(), includeFixtureVolume: false,
            namespace: state, stackId, holderId: holderA, configuration: await configuration(environment), generation, observedAt,
            resolve: (operation, context) => ({
                ...nodeStep(context.id, process.cwd()),
                argv: [process.execPath, ...operation.argv.slice(1)], argv0: process.execPath,
            }),
        })).toMatchObject({ kind: 'refusal' })
    })

    // A field read only to be hashed into history looks consumed to the static schema-consumer
    // check, so each fixture field must change the plan the product's operations run from.
    it.each([
        ['volume_tag', (fixtures: typeof environment.data.fixtures) => { fixtures.volume_tag = 'other-volume' }],
        ['pagination_warning', (fixtures: typeof environment.data.fixtures) => { fixtures.pagination_warning = 'Other fixtures warning' }],
        ['volume_operations', (fixtures: typeof environment.data.fixtures) => { fixtures.volume_operations = [{ ...overlay, argv: [...overlay.argv, 'other'] }] }],
        ['volume_probes', (fixtures: typeof environment.data.fixtures) => { fixtures.volume_probes = [{ ...overlay, argv: [...overlay.argv, 'probe'] }] }],
    ] as const)('changes the seeded plan beyond its digests when fixtures.%s changes', async (_field, mutate) => {
        const state = await namespace()
        const changed = structuredClone(environment)
        mutate(changed.data.fixtures)
        const observed = async (declaration: typeof environment) => JSON.stringify(await planned('seeded', state, { includeFixtureVolume: true, declaration }))
            .replace(/[a-f0-9]{64}/g, '<digest>')
        expect(await observed(changed)).not.toBe(await observed(environment))
    })

    it.each([
        ['an unbound host executable', (step: ExecutionStep) => ({ ...step, consumedFiles: [] })],
        ['a resolver-selected preload variable', (step: ExecutionStep) => ({ ...step, env: { ...step.env, NODE_OPTIONS: '--require=synthetic' } })],
        ['a resolver-selected Docker endpoint', (step: ExecutionStep) => ({ ...step, env: { ...step.env, DOCKER_HOST: 'unix:///tmp/other.sock' } })],
        ['a resolver-selected PATH value', (step: ExecutionStep) => ({ ...step, env: { PATH: '/tmp/synthetic-secret-canary' } })],
        ['resolver-owned public labels', (step: ExecutionStep) => ({ ...step, labels: { secretCanary: 'synthetic-secret-canary' } })],
    ] as const)('rejects %s', async (_label, mutate) => {
        const state = await namespace()
        expect(planDataMode({
            environment, mode: 'seeded', checkoutRoot: process.cwd(), includeFixtureVolume: false,
            namespace: state, stackId, holderId: holderA, configuration: await configuration(), generation, observedAt,
            resolve: (operation, context) => mutate({
                ...nodeStep(context.id, process.cwd()),
                argv: [process.execPath, ...operation.argv.slice(1)], argv0: process.execPath,
            }),
        })).toMatchObject({ kind: 'refusal' })
    })

    it('names applied and not-applied steps after the first authenticated failure', async () => {
        const state = await namespace()
        const declaration = structuredClone(environment)
        const seeded = declaration.data.modes.find(({ mode }) => mode === 'seeded')!
        const sweep = seeded.operations.find(({ id }) => id === 'sweep')!
        sweep.operation = { ...sweep.operation, argv: ['node', '-e', 'process.exit(7)'] }
        const plan = await planned('seeded', state, { declaration })
        const result = await executeDataMode(plan, executeProbe)

        expect(result).toMatchObject({
            kind: 'refusal',
            applied: ['data:seeded:schema:prerequisite:0', 'data:seeded:schema'],
            attempted: [expect.objectContaining({ id: 'data:seeded:sweep', exitCode: 7 })],
            notApplied: ['data:seeded:fixtures', 'data:seeded:probe:0'],
        })
        expect(isDataModeCompletion(result)).toBe(false)
        const stored = await readState(state.paths.dataOutcome(stackId))
        if (stored.kind !== 'complete' || !stored.value.value || typeof stored.value.value !== 'object') {
            throw new Error('refused data outcome was not durable')
        }
        const configSha256 = (stored.value.value as { configSha256: string }).configSha256
        const projection = await readDataModeOutcome({ namespace: state, stackId, configSha256, generation, mode: 'seeded' })
        expect(consumeDataModeOutcomeProjection(projection!)).toMatchObject({
            outcome: {
                kind: 'refusal', applied: ['data:seeded:schema:prerequisite:0', 'data:seeded:schema'],
                attempted: [expect.objectContaining({ id: 'data:seeded:sweep', exitCode: 7 })],
                notApplied: ['data:seeded:fixtures', 'data:seeded:probe:0'],
            },
        })
    })

    it('rechecks sole-holder authority immediately before restore execution', async () => {
        const state = await namespace()
        await seedSoleHolder(state)
        const plan = await planned('restored', state)
        const executed: string[] = []
        const result = await executeDataMode(plan, async (step) => {
            executed.push(step.id)
            const outcome = await executeProbe(step)
            if (step.id === 'data:restored:schema') {
                const joined = await acquireClaim({
                    namespace: state, stackId, holder: { holderId: holderB, checkoutId: checkoutB }, now: '2026-09-26T06:01:00.000Z',
                })
                if (joined.kind !== 'complete') throw new Error('co-tenant join failed')
            }
            return outcome
        })

        expect(result).toMatchObject({ kind: 'refusal', notApplied: ['data:restored:restore', 'data:restored:rewrite', 'data:restored:rewrite:object-store', 'data:restored:probe:0'] })
        expect(executed).not.toContain('data:restored:restore')
    })

    it('blocks a co-tenant for the complete restore mutation and releases after settlement', async () => {
        const state = await namespace()
        await seedSoleHolder(state)
        const plan = await planned('restored', state)
        const blocked: string[] = []
        const result = await executeDataMode(plan, async (step) => {
            if (step.id === 'data:restored:restore' || step.id.startsWith('data:restored:rewrite')) {
                const joined = await acquireClaim({
                    namespace: state, stackId, holder: { holderId: holderB, checkoutId: checkoutB }, now: '2026-09-26T06:02:00.000Z',
                })
                if (joined.kind === 'refusal') blocked.push(step.id)
            }
            return executeProbe(step)
        })

        expect(result.kind).toBe('complete')
        expect(blocked).toEqual(['data:restored:restore', 'data:restored:rewrite', 'data:restored:rewrite:object-store'])
        await expect(acquireClaim({
            namespace: state, stackId, holder: { holderId: holderB, checkoutId: checkoutB }, now: '2026-09-26T06:03:00.000Z',
        })).resolves.toMatchObject({ kind: 'complete' })
    })

    it('holds one reservation across multiple restore operations and releases it after completion', async () => {
        const state = await namespace()
        await seedSoleHolder(state)
        const declaration = structuredClone(environment)
        const restored = declaration.data.modes.find(({ mode }) => mode === 'restored')!
        const firstRestore = restored.operations.find(({ kind }) => kind === 'restore')!
        restored.operations.splice(restored.operations.indexOf(firstRestore) + 1, 0, {
            ...structuredClone(firstRestore), id: 'restore-second', prerequisites: [], after: ['schema', 'restore'],
        })
        const plan = await planned('restored', state, { declaration })

        await expect(executeDataMode(plan, executeProbe)).resolves.toMatchObject({ kind: 'complete' })
        await expect(acquireClaim({
            namespace: state, stackId, holder: { holderId: holderB, checkoutId: checkoutB }, now: '2026-09-26T06:04:00.000Z',
        })).resolves.toMatchObject({ kind: 'complete' })
    })

    it('releases the restore reservation when execution throws', async () => {
        const state = await namespace()
        await seedSoleHolder(state)
        const plan = await planned('restored', state)
        const result = await executeDataMode(plan, async (step) => {
            if (step.id === 'data:restored:restore') throw new Error('synthetic executor failure')
            return executeProbe(step)
        })

        expect(result).toMatchObject({ kind: 'refusal' })
        await expect(acquireClaim({
            namespace: state, stackId, holder: { holderId: holderB, checkoutId: checkoutB }, now: '2026-09-26T06:05:00.000Z',
        })).resolves.toMatchObject({ kind: 'complete' })
    })

    it('keeps fixture volume separate and names the wipe remedy for fresh-only work', async () => {
        const state = await namespace()
        const seeded = await planned('seeded', state, { includeFixtureVolume: true })
        expect(seeded.fixtureVolume).toMatchObject({ included: true, tag: 'synthetic-volume' })
        expect(seeded.steps.slice(-2).map(({ id }) => id)).toEqual(['data:volume:operation:0', 'data:volume:probe:0'])
        await expect(executeDataMode(seeded, executeProbe)).resolves.toMatchObject({ kind: 'complete' })
        const stored = await readState(state.paths.dataOutcome(stackId))
        if (stored.kind !== 'complete' || !stored.value.value || typeof stored.value.value !== 'object') throw new Error('data outcome was not durable')
        const configSha256 = (stored.value.value as { configSha256: string }).configSha256
        const projection = await readDataModeOutcome({ namespace: state, stackId, configSha256, generation, mode: 'seeded' })
        const healthPlan = await planned('seeded', state, { includeFixtureVolume: true })
        expect(projectDataModeObservationSteps({ plan: healthPlan, projection: projection! })?.map(({ id }) => id)).toEqual([
            'data:seeded:probe:0', 'data:volume:probe:0',
        ])
        expect(projectDataModeObservationSteps({ plan: { ...healthPlan }, projection: projection! })).toBeUndefined()
        const primaryProbe = healthPlan.steps.findIndex(({ phase }) => phase === 'probe')
        const incomplete = observeDataMode({
            plan: healthPlan, projection: projection!,
            outcomes: [await executeProbe(healthPlan.execution.steps[primaryProbe]!)],
        })
        expect(incomplete).toMatchObject({ observed: { state: 'unavailable', reason: 'current data probe evidence is incomplete or unauthentic' } })

        const declaration = structuredClone(environment)
        declaration.data.modes.find(({ mode }) => mode === 'restored')!.operations[0]!.prerequisites = []
        const restored = await planned('restored', state, { declaration })
        const result = await executeDataMode(restored, executeProbe)
        expect(result).toMatchObject({
            kind: 'refusal', applied: [],
            diagnostics: [{ fix: 'wipe the declared product-data volume before retrying' }],
        })
    })

    it('refuses fresh-only restore work when the volume probe reports another generation', async () => {
        const state = await namespace()
        await seedSoleHolder(state)
        const declaration = structuredClone(environment)
        declaration.data.modes.find(({ mode }) => mode === 'restored')!.operations[0]!.prerequisites[0] = {
            ...freshVolumeOverlay,
            argv: ['node', '-e', `process.stdout.write(JSON.stringify({volume:'product-data',state:'empty',generation:'${'8'.repeat(64)}'}))`],
        }
        const plan = await planned('restored', state, { declaration })
        const executed: string[] = []
        const result = await executeDataMode(plan, async (step) => {
            executed.push(step.id)
            return executeProbe(step)
        })

        expect(executed).toEqual(['data:restored:schema:prerequisite:0'])
        expect(result).toMatchObject({
            kind: 'refusal', mode: 'restored',
            applied: ['data:restored:schema:prerequisite:0'], attempted: [],
            notApplied: [
                'data:restored:schema', 'data:restored:restore', 'data:restored:rewrite',
                'data:restored:rewrite:object-store', 'data:restored:probe:0',
            ],
        })
        expect(isDataModeCompletion(result)).toBe(false)
        expect(await readState(state.paths.dataOutcome(stackId))).toMatchObject({
            kind: 'complete', value: { value: { generation, outcome: { kind: 'refusal' } } },
        })
        expect(await readState(state.paths.lifecycle(stackId))).toMatchObject({ kind: 'missing' })
    })

    it('projects every declared persona target from the seeder source', () => {
        const source = Buffer.from('[{"id":"stable"}]')
        const projection = projectPersonaOutputs(
            environment,
            { path: 'fixtures/personas.json', bytes: source },
            (_output, bytes) => Buffer.from(`export default ${bytes.toString('utf8')} as const\n`),
        )
        expect(projection).toMatchObject({
            source: { path: 'fixtures/personas.json', sha256: createHash('sha256').update(source).digest('hex') },
            outputs: [{ path: 'fixtures/personas.generated.ts', format: 'typescript' }],
        })
        expect(projection?.outputs[0]?.sha256).toBe(createHash('sha256').update(
            Buffer.from(projection!.outputs[0]!.bytesBase64, 'base64'),
        ).digest('hex'))
    })
})
