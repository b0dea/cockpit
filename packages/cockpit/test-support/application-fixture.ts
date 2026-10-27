import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { loadCockpitConfig, type LoadedCockpitConfig } from '../src/config/load.js'
import {
    issueLifecycleRunContext,
    issueSetupRunContext,
    type LifecycleRunContext,
    type LifecycleRunContextInput,
    type SetupCommandAdapters,
    type SetupRunContext,
    type SetupRunContextInput,
} from '../src/environment/application.js'
import type { SetupObservation, SetupResult } from '../src/environment/setup.js'
import { observeSetupCheckout, withSetupCheckoutProjection } from '../src/environment/setup-observation.js'
import { selectStateRoot } from '../src/environment/state.js'
import { checkoutId, cockpitId, holderId, stackId } from '../src/environment/identity.js'
import { CockpitConfig, type InstallPolicy, type Sibling } from '../src/schema.js'
import type { EnvironmentSeedPlan } from '../src/environment/templates.js'

export type UnissuedSetupContext = Pick<
    SetupRunContext,
    | 'source'
    | 'mainCheckoutPath'
    | 'siblingsRoot'
    | 'siblings'
    | 'policyCatalog'
    | 'env'
    | 'gitExecutable'
> & { readonly observedAt: string }

export function createApplicationFixtureSupport(
    scratch: string[],
    gitExecutable: SetupRunContextInput['gitExecutable'],
) {
function fixture(source?: string): { configPath: string; target: string } {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-setup-application-'))
    scratch.push(directory)
    const configPath = join(directory, 'cockpit.toml')
    execFileSync('git', ['init', '--quiet', directory])
    writeFileSync(configPath, source ?? [
        '[cockpit]', 'name = "synthetic-cockpit"', `siblings_root = ${JSON.stringify(directory)}`, '',
        '[[sibling]]', 'slug = "api"', 'dir = "api"',
        'remote = "ssh://example.invalid/api.git"', 'acquire = "auto"',
        'mount = "always"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
        '[ports]', 'bases = { APP_PORT = 4100 }', '',
    ].join('\n'))
    return { configPath, target: join(directory, 'api') }
}

function derivedRegistrySource(): string {
    const config = parse(readFileSync(new URL('../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')) as any
    const service = structuredClone(config.environment.generated.services[0])
    const policy = structuredClone(config.environment.install_policies[0])
    const provenance = structuredClone(service.provenance)
    for (const operation of [service.image.manifest_probe, service.image.registry_auth_probe, service.health.probe, service.health.tool_probe]) {
        if (operation) operation.service = 'worker'
    }
    service.ports = [{ name: 'http', host_variable: 'WORKER_HOST_PORT', internal: 3000 }]
    const { id: _id, sibling: _sibling, mounts: _mounts, profiles: _profiles, ...derivedService } = service
    void _id
    void _sibling
    void _mounts
    void _profiles
    const decision = (id: string, subject: string, subject_id: string) => ({
        id, subject, subject_id, decided_on: '2026-09-26', decision: `Synthetic ${subject}`,
        rejected: ['Undeclared structure'], reason: 'Reproducible environment',
        reviewer: 'consumer-maintainer', provenance,
    })
    config.sibling.push({
        slug: 'worker', dir: 'worker', mount: 'profile:worker', acquire: 'none', var: 'WORKER_DIR',
        toolchain: 'node', purpose: 'Synthetic profile worker',
        derives: { generated: {
            service: derivedService,
            checkout_mount: { target: '/workspace/worker', source_type: 'directory' },
            additional_mounts: [{ kind: 'volume', source: 'worker-dependencies', target: '/workspace/node_modules' }],
            // 4200 would be stack 1's APP_HOST_PORT under the default step of 100.
            port_defaults: { WORKER_HOST_PORT: 4250 },
            entrypoints: [{ name: 'worker-origin', kind: 'origin', port: 'WORKER_HOST_PORT', path: '/' }],
            volumes: [{ id: 'worker-dependencies', purpose: 'dependencies', install_policy: 'worker-dependencies', target: '/workspace/node_modules', provenance }],
            install_policies: [{ ...policy, volume: 'worker-dependencies', lockfile: 'worker/package-lock.json' }],
            decisions: [
                decision('service-worker', 'service', 'worker'),
                decision('volume-worker-dependencies', 'volume', 'worker-dependencies'),
                decision('mount-worker-checkout', 'mount', 'worker:bind:worker:/workspace/worker'),
                decision('mount-worker-dependencies', 'mount', 'worker:volume:worker-dependencies:/workspace/node_modules'),
                decision('port-worker-http', 'port', 'worker:http'),
            ],
            provenance,
        } },
    })
    return stringify(config)
}

async function unissuedContextFixture(source?: string): Promise<{
    configPath: string
    loaded: LoadedCockpitConfig
    candidate: UnissuedSetupContext
}> {
    const { configPath } = fixture(source)
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')
    const mainCheckoutPath = realpathSync(resolve(configPath, '..'))
    return {
        configPath,
        loaded: loaded.result,
        candidate: {
            source: { ...loaded.result.source },
            mainCheckoutPath,
            siblingsRoot: resolve(mainCheckoutPath, loaded.result.config.cockpit.siblings_root),
            siblings: loaded.result.config.sibling,
            policyCatalog: loaded.result.config.environment.install_policies,
            env: {},
            gitExecutable,
            observedAt: new Date().toISOString(),
        },
    }
}

async function authorizeContext(
    candidate: UnissuedSetupContext,
    loaded: LoadedCockpitConfig,
): Promise<SetupRunContext> {
    const issued = await issueContext(candidate, loaded)
    if (issued.kind !== 'complete') throw new Error('run context was not issued')
    return issued.result
}

async function runContextInput(
    candidate: UnissuedSetupContext,
    loaded: LoadedCockpitConfig,
): Promise<Omit<SetupRunContextInput, 'checkout'>> {
    const currentCheckoutPath = realpathSync(candidate.mainCheckoutPath)
    const currentCockpitId = cockpitId({ name: loaded.config.cockpit.name, mainCheckoutPath: currentCheckoutPath })
    const currentCheckoutId = checkoutId({ checkoutPath: currentCheckoutPath })
    const stateHome = mkdtempSync(join(tmpdir(), 'cockpit-application-state-'))
    scratch.push(stateHome)
    const xdgStateHome = join(stateHome, 'state')
    mkdirSync(xdgStateHome, { recursive: true })
    const selected = await selectStateRoot({
        platform: process.platform === 'darwin' ? 'darwin' : 'linux',
        home: stateHome,
        xdgStateHome,
        checkoutRoot: currentCheckoutPath,
        cockpitId: currentCockpitId,
    })
    if (selected.kind !== 'complete') throw new Error('state namespace was not issued')
    const currentStackId = stackId({
        cockpitId: currentCockpitId,
        checkoutId: currentCheckoutId,
        variant: { kind: 'shared' },
    })
    const sessionId = 'synthetic-session'
    return {
        configuration: loaded,
        env: candidate.env,
        gitExecutable: candidate.gitExecutable,
        namespace: selected.value,
        observedAt: candidate.observedAt,
        currentCheckoutPath,
        mainCheckoutPath: currentCheckoutPath,
        cockpitId: currentCockpitId,
        checkoutId: currentCheckoutId,
        stackId: currentStackId,
        holderId: holderId({ stackId: currentStackId, checkoutId: currentCheckoutId, sessionId }),
        sessionId,
    }
}

async function issueContext(
    candidate: UnissuedSetupContext,
    loaded: LoadedCockpitConfig,
    change: (input: SetupRunContextInput) => SetupRunContextInput = (input) => input,
): Promise<ReturnType<typeof issueSetupRunContext>> {
    const input = await runContextInput(candidate, loaded)
    return issueFromFreshCheckout(candidate, loaded, input, change)
}

async function lifecycleContextFixture(source?: string): Promise<{ configPath: string; context: LifecycleRunContext }> {
    const value = await unissuedContextFixture(source)
    const fresh = await loadCockpitConfig(value.configPath)
    if (fresh.kind !== 'complete') throw new Error('fixture configuration did not reload')
    const identity = await runContextInput(value.candidate, fresh.result)
    const issued = await issueLifecycleContext(value.candidate, fresh.result, identity, fresh.result.source.path)
    if (issued.kind !== 'complete') throw new Error('lifecycle context was not issued')
    return { configPath: fresh.result.source.path, context: issued.result }
}

async function issueLifecycleContext(
    candidate: UnissuedSetupContext,
    loaded: LoadedCockpitConfig,
    identity: Omit<SetupRunContextInput, 'checkout'>,
    configPath: string,
    change: (input: LifecycleRunContextInput) => LifecycleRunContextInput = (input) => input,
): Promise<ReturnType<typeof issueLifecycleRunContext>> {
    const observed = await observeSetupCheckout({
        source: candidate.source,
        cockpitName: loaded.config.cockpit.name,
        observedAt: candidate.observedAt,
        env: candidate.env,
        gitExecutable: candidate.gitExecutable,
    })
    return await withSetupCheckoutProjection(observed, {
        source: candidate.source,
        cockpitName: loaded.config.cockpit.name,
        evaluatedAt: Date.parse(candidate.observedAt),
    }, (checkout) => issueLifecycleRunContext(change({
        checkout,
        configPath,
        configuration: loaded,
        namespace: identity.namespace,
        stackId: identity.stackId,
        holderId: identity.holderId,
        sessionId: identity.sessionId,
    }))) ?? { kind: 'refusal', status: 2, diagnostics: [], result: null }
}

async function issueFromFreshCheckout(
    candidate: UnissuedSetupContext,
    loaded: LoadedCockpitConfig,
    input: Omit<SetupRunContextInput, 'checkout'>,
    change: (input: SetupRunContextInput) => SetupRunContextInput = (value) => value,
): Promise<ReturnType<typeof issueSetupRunContext>> {
    const observed = await observeSetupCheckout({
        source: candidate.source,
        cockpitName: loaded.config.cockpit.name,
        observedAt: candidate.observedAt,
        env: candidate.env,
        gitExecutable: candidate.gitExecutable,
    })
    const issued = await withSetupCheckoutProjection(observed, {
        source: candidate.source,
        cockpitName: loaded.config.cockpit.name,
        evaluatedAt: Date.parse(candidate.observedAt),
    }, (projection) => issueSetupRunContext(change({ ...input, checkout: projection })))
    return issued ?? {
        kind: 'refusal', status: 2, diagnostics: [], result: null,
    }
}

function available(kind: 'absent' | 'repository'): SetupObservation {
    return {
        state: 'available',
        value: kind === 'repository'
            ? { kind, remotes: { origin: 'ssh://example.invalid/api.git' } }
            : { kind },
        observedAt: '2026-09-07T00:00:00.000Z',
        producer: 'synthetic-test',
    }
}

function cloneObservations(): () => Promise<SetupObservation> {
    let count = 0
    return async () => {
        count += 1
        return available(count === 1 ? 'absent' : 'repository')
    }
}

const fileIdentity = Object.freeze({
    dev: '1', ino: '2', mode: '33152', size: '16', mtimeNs: '3', ctimeNs: '4',
})

function readySeed(siblingRoot: string): Extract<EnvironmentSeedPlan, { kind: 'ready' }> {
    return {
        kind: 'ready',
        siblingRoot,
        canonicalRoot: siblingRoot,
        source: resolve(siblingRoot, '.env.example'),
        destination: resolve(siblingRoot, '.env'),
        rootIdentity: fileIdentity,
        sourceIdentity: fileIdentity,
        destinationParentIdentity: fileIdentity,
    }
}

const baseSibling = {
    slug: 'api', dir: 'api', remote: 'ssh://example.invalid/api.git', acquire: 'auto',
    mount: 'always', var: 'API_DIR', toolchain: 'none', guides: [], purpose: 'Synthetic API',
} satisfies Sibling

function tomlValue(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
    if (value && typeof value === 'object') {
        return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${tomlValue(item)}`).join(', ')} }`
    }
    return JSON.stringify(value)
}

function sequenceSource(
    siblingChanges: Partial<Sibling>,
    policyCatalog: readonly InstallPolicy[],
    extraSiblings: readonly Partial<Sibling>[],
): string {
    const siblings = [
        { ...baseSibling, ...siblingChanges },
        ...extraSiblings.map((extra) => ({ ...baseSibling, ...extra })),
    ]
    const lines = ['[cockpit]', 'name = "synthetic-cockpit"', 'siblings_root = "."', '']
    for (const sibling of siblings) {
        lines.push('[[sibling]]')
        for (const [key, value] of Object.entries(sibling)) {
            if (value !== undefined) lines.push(`${key} = ${tomlValue(value)}`)
        }
        lines.push('')
    }
    lines.push('[ports]', 'bases = { APP_PORT = 4100 }', '')
    if (policyCatalog.length > 0) {
        lines.push('[environment]', `install_policies = ${tomlValue(policyCatalog)}`, '')
    }
    return lines.join('\n')
}

async function sequenceFixture(
    siblingChanges: Partial<SetupRunContext['siblings'][number]> = {},
    policyCatalog: SetupRunContext['policyCatalog'] = [],
    extraSiblings: readonly Partial<SetupRunContext['siblings'][number]>[] = [],
): Promise<{ configPath: string; context: SetupRunContext; adapters: SetupCommandAdapters }> {
    const { configPath, loaded, candidate } = await unissuedContextFixture(
        sequenceSource(siblingChanges, policyCatalog, extraSiblings),
    )
    const context = await authorizeContext(candidate, loaded)
    const sibling = context.siblings[0]!
    const result: SetupResult = {
        sibling: sibling.slug,
        target: resolve(context.siblingsRoot, sibling.dir),
        observed: 'repository',
        action: 'report',
        changed: false,
    }
    const adapters: SetupCommandAdapters = {
        load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
        observedAt: () => new Date().toISOString(),
        observeGit: async () => available('repository'),
        planGit: async () => ({ kind: 'complete', status: 0, diagnostics: [], result }),
        execute: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { steps: [] } }),
        observeSource: async () => ({ state: 'available', ...context.source }),
        recordStarted: async () => ({ kind: 'unchanged', record: {} as never }),
        withIgnore: async (_input, use) => use(),
        planSeed: async () => ({ kind: 'none' }),
        seed: () => ({ kind: 'none' }),
        observePolicy: async () => ({ state: 'available' } as never),
        withPolicy: async (_observation, _input, use) => use({} as never),
        resolvePolicy: () => ({ kind: 'complete', bindings: [] }),
    }
    return { configPath, context, adapters }
}

return {
    fixture,
    derivedRegistrySource,
    unissuedContextFixture,
    authorizeContext,
    runContextInput,
    issueContext,
    lifecycleContextFixture,
    issueLifecycleContext,
    issueFromFreshCheckout,
    available,
    cloneObservations,
    fileIdentity,
    readySeed,
    baseSibling,
    tomlValue,
    sequenceSource,
    sequenceFixture,
}
}
