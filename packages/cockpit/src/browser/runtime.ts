import { lstatSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { isProxy } from 'node:util/types'
import { GeneratedHostPath, parseBrowserNetworkExposure } from '../schema.js'
import { evaluatePreflight } from '../environment/observations.js'
import { inspectPortLeaseProjection, type PortLeaseProjection } from '../environment/ports.js'
import { authenticateStateNamespace, type StateNamespace } from '../environment/state.js'
import { browserHostAllowed, resolveBrowserProxy, type BrowserProxyInput } from './proxy.js'

export const mechanism = {
    id: 'browser-runtime',
    module: 'packages/cockpit/src/browser/runtime.ts',
    exports: ['assertBrowserArtifactRegistration', 'assertBrowserStorageStateCurrent', 'bindBrowserRuntimePortLease', 'browserClientLimit', 'browserRuntimeControlAuthorities', 'browserRuntimeControlPorts', 'browserRuntimeCoordination', 'browserRuntimeExecutionReady', 'resolveBrowserRuntime'],
} as const

interface BrowserImage {
    readonly reference: string
    readonly driverVersion: string
}

interface BrowserStorageState {
    readonly worker: string
    readonly path: string
    readonly source: 'seeded'
}

export interface BrowserRuntimeInput {
    readonly postures: Parameters<typeof evaluatePreflight>[1]
    readonly images: Readonly<{ runner: BrowserImage; mcp: BrowserImage }>
    readonly project: Readonly<{ lockfile: string; sha256: string; driverVersion: string; manifest?: string; manifestSha256?: string }>
    readonly engine?: 'chromium' | 'firefox' | 'webkit'
    readonly hostVariable?: string
    readonly networkExposure?: string
    readonly networkExposureReason?: string
    readonly endpoint?: string
    readonly maxClients: number
    readonly proxy: BrowserProxyInput
    readonly resolver: readonly Readonly<{ hostname: string; address: string }>[]
    readonly authentication: Readonly<{ policy: 'none' | 'serialized' | 'per-worker'; states: readonly BrowserStorageState[] }>
    readonly data: Readonly<{ mode: 'empty' | 'seeded' | 'restored'; isolated: boolean; reachesProduction: boolean }>
    readonly requestPreapproval: boolean
    readonly headed: boolean
    readonly artifacts: Readonly<Record<'runner' | 'mcp' | 'cli' | 'auth' | 'debugger', string>>
}

interface BrowserRuntimeBinding {
    readonly storage: readonly Readonly<{ path: string; identity: string }>[]
    readonly stackId: import('../environment/contract.js').StackId
    readonly executable: boolean
    readonly remote?: Readonly<{ configuredEndpoint: string; baseProxyPort: number; hostVariable?: string }>
    readonly coordination?: Readonly<{ namespace: StateNamespace; stackId: import('../environment/contract.js').StackId }>
}

const issuedRuntimes = new WeakMap<object, BrowserRuntimeBinding>()

function assertPlainData(value: unknown, depth = 0, budget = { entries: 0 }): void {
    if (depth > 8 || ++budget.entries > 2048) throw new TypeError('browser input data exceeds its bounds')
    if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return
    if (typeof value !== 'object' || isProxy(value)
        || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('browser input must contain plain data')
    const keys = Reflect.ownKeys(value)
    if (keys.length > 2048 || keys.some((key) => typeof key !== 'string')) throw new TypeError('browser input data exceeds its bounds')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value) && keys.length !== value.length + 1) throw new TypeError('browser input data needs dense arrays')
    for (const descriptor of Object.values(descriptors)) {
        if (!('value' in descriptor)) throw new TypeError('browser input must contain plain data without accessors')
        assertPlainData(descriptor.value, depth + 1, budget)
    }
}

function storageIdentity(path: string): string {
    let metadata
    try {
        metadata = lstatSync(path)
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
            && (metadata.mode & 0o7777) === 0o600 && realpathSync(path) === path) {
            return JSON.stringify([metadata.dev, metadata.ino, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs])
        }
    } catch {
        throw new TypeError('browser seeded storage state metadata is unavailable')
    }
    throw new TypeError('browser seeded storage state must be a confined mode-600 regular file')
}

export function browserClientLimit(maxClients: number, policy: BrowserRuntimeInput['authentication']['policy']): number {
    return policy === 'serialized' ? 1 : maxClients
}

export function resolveBrowserRuntime(input: BrowserRuntimeInput, coordinationNamespace?: StateNamespace) {
    assertPlainData(input)
    // The existing owner authenticates source, freshness and both directions of the catalog.
    const checked = evaluatePreflight([], input.postures)
    const checks = checked.checks.filter(({ owner }) => owner === 'posture-requirements')
    if (input.postures.authorities.length !== 1 || checks.length !== 2 || checks.some(({ verdict }) => verdict !== 'pass')) {
        throw new TypeError('browser posture requirements must match the selected declarations')
    }
    const authority = input.postures.authorities[0]!
    const namespace = coordinationNamespace === undefined ? undefined : authenticateStateNamespace(coordinationNamespace)
    if (coordinationNamespace !== undefined && !namespace) throw new TypeError('browser runtime coordination namespace must be an issued canonical state namespace')
    const { addressing, authentication } = authority.environmentPostures
    const proxy = resolveBrowserProxy(input.proxy)
    if (!Number.isSafeInteger(input.maxClients) || input.maxClients < 1 || input.maxClients > 64) {
        throw new TypeError('browser client cap must be an integer from 1 through 64')
    }
    const projectKeys = ['lockfile', 'sha256', 'driverVersion', ...(input.project.manifest === undefined ? [] : ['manifest', 'manifestSha256'])]
    if (Object.keys(input.project).length !== projectKeys.length || !projectKeys.every((key) => Object.hasOwn(input.project, key))
        || !GeneratedHostPath.safeParse(input.project.lockfile).success || !/^[a-f0-9]{64}$/.test(input.project.sha256)
        || input.project.manifest !== undefined && (!GeneratedHostPath.safeParse(input.project.manifest).success
            || !/^[a-f0-9]{64}$/.test(input.project.manifestSha256 ?? ''))
        || input.project.manifest === undefined && input.project.manifestSha256 !== undefined) {
        throw new TypeError('browser project lockfile identity is invalid')
    }
    if (!/^\d+\.\d+\.\d+$/.test(input.project.driverVersion)) throw new TypeError('browser project driver version must be exact')
    for (const image of [input.images.runner, input.images.mcp]) {
        if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image.reference)) throw new TypeError('browser images must be digest-pinned')
        if (image.driverVersion !== input.project.driverVersion) throw new TypeError('browser image driver differs from project lock identity')
    }
    const engine = input.engine ?? 'chromium'
    if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new TypeError('browser engine must be chromium, firefox or webkit')
    const networkExposure = parseBrowserNetworkExposure(input.networkExposure, input.networkExposureReason)
    if (input.hostVariable !== undefined && !/^[A-Z][A-Z0-9_]{0,127}$/.test(input.hostVariable)) {
        throw new TypeError('browser proxy host variable must be a canonical environment name')
    }
    let connection: Readonly<{ kind: 'remote'; endpoint: string; launchLocal: false }>
        | Readonly<{ kind: 'local-fallback'; reason: 'endpoint-absent'; launchLocal: true }>
    if (!Object.hasOwn(input, 'endpoint')) {
        connection = Object.freeze({ kind: 'local-fallback', reason: 'endpoint-absent', launchLocal: true })
    } else {
        let endpoint: string
        try {
            const parsed = new URL(input.endpoint!)
            const spelling = /^ws:\/\/([^/?#]+)(\/[^?#]*)$/.exec(input.endpoint!)
            if (parsed.protocol !== 'ws:' || parsed.username || parsed.password || parsed.search || parsed.hash
                || !spelling || spelling[2] !== parsed.pathname || !browserHostAllowed(proxy, spelling[1])) throw Error('invalid')
            endpoint = input.endpoint!
        } catch {
            throw new TypeError('configured browser endpoint must use ws:// with the exact credential-free checking proxy authority; TLS termination is unavailable')
        }
        connection = Object.freeze({ kind: 'remote', endpoint, launchLocal: false })
    }
    if (!Array.isArray(input.resolver) || input.resolver.length > 64
        || (addressing === 'hostname' ? input.resolver.length === 0 : input.resolver.length !== 0)
        || new Set(input.resolver.map(({ hostname }) => hostname)).size !== input.resolver.length
        || input.resolver.some(({ hostname, address }) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(hostname) || isIP(address) === 0)) {
        throw new TypeError('browser resolver rules must match the selected addressing posture')
    }
    if (connection.kind === 'local-fallback' && addressing === 'hostname' && engine !== 'chromium') {
        throw new TypeError('local hostname resolver rules require chromium')
    }
    const artifactKeys = ['runner', 'mcp', 'cli', 'auth', 'debugger'] as const
    const paths = artifactKeys.map((key) => input.artifacts[key])
    if (Object.keys(input.artifacts).length !== artifactKeys.length
        || paths.some((path) => !GeneratedHostPath.safeParse(path).success)
        || paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && (path === other || path.startsWith(`${other}/`))))) {
        throw new TypeError('browser artifact roots must be confined, distinct and non-overlapping')
    }
    const states = input.authentication.states
    const storage: Array<Readonly<{ path: string; identity: string }>> = []
    if (!Array.isArray(states) || states.length > 64) throw new TypeError('browser authentication states are invalid')
    if (authentication === 'bypassed') {
        if (input.authentication.policy !== 'none' || states.length !== 0) throw new TypeError('bypassed authentication cannot declare persona state or login')
    } else {
        if (input.authentication.policy !== 'serialized' && input.authentication.policy !== 'per-worker'
            || states.length !== (input.authentication.policy === 'serialized' ? 1 : input.maxClients)) {
            throw new TypeError('real browser authentication requires serialized or per-worker seeded state')
        }
        if (new Set(states.map(({ worker }) => worker)).size !== states.length || new Set(states.map(({ path }) => path)).size !== states.length) {
            throw new TypeError('per-worker browser state must have distinct workers and paths')
        }
        const root = dirname(authority.source)
        for (const state of states) {
            if (state.source !== 'seeded' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(state.worker)
                || !GeneratedHostPath.safeParse(state.path).success || !state.path.startsWith(`${input.artifacts.auth}/`)) {
                throw new TypeError('browser storage state must come from seeded users inside the auth artifact root')
            }
            const path = resolve(root, state.path)
            storage.push(Object.freeze({ path, identity: storageIdentity(path) }))
        }
    }
    if (!['empty', 'seeded', 'restored'].includes(input.data.mode) || typeof input.data.isolated !== 'boolean'
        || typeof input.data.reachesProduction !== 'boolean' || typeof input.requestPreapproval !== 'boolean' || typeof input.headed !== 'boolean') {
        throw new TypeError('browser data and debugger posture must be explicit')
    }
    if (input.requestPreapproval && (input.data.mode === 'restored' || !input.data.isolated || input.data.reachesProduction)) {
        throw new TypeError('browser preapproval requires isolated empty or seeded data with no production reach')
    }
    const projection = Object.freeze({
        configurationPath: authority.source,
        connection,
        runner: Object.freeze({ image: input.images.runner.reference, project: Object.freeze({
            lockfile: input.project.lockfile, sha256: input.project.sha256, driverVersion: input.project.driverVersion,
            ...(input.project.manifest === undefined ? {} : { manifest: input.project.manifest, manifestSha256: input.project.manifestSha256! }),
        }),
            ...(connection.kind === 'remote' ? { endpoint: connection.endpoint } : {}) }),
        mcp: Object.freeze({ image: input.images.mcp.reference, ...(connection.kind === 'remote' ? { endpoint: connection.endpoint } : {}) }),
        server: Object.freeze({ ...proxy.server, maxClients: browserClientLimit(input.maxClients, input.authentication.policy), engine, headless: true as const }),
        proxy: proxy.proxy,
        addressing: Object.freeze({ posture: addressing, resolverRules: addressing === 'hostname' ? Object.freeze(input.resolver.map(({ hostname, address }) => `MAP ${hostname} ${address}`)) : null }),
        requirements: authority.postureRequirements,
        authentication: authentication === 'bypassed'
            ? Object.freeze({ posture: 'bypassed' as const, policy: 'none' as const, states: Object.freeze([]) })
            : Object.freeze({ posture: 'real' as const, policy: input.authentication.policy, states: Object.freeze(states.map((state) => Object.freeze({ ...state }))), claim: input.authentication.policy === 'serialized' ? 'exclusive' as const : 'per-worker' as const }),
        debugger: input.headed ? Object.freeze({ enabled: true as const, separate: true as const, artifactRoot: input.artifacts.debugger }) : Object.freeze({ enabled: false as const }),
        preapproval: input.requestPreapproval ? 'eligible' as const : 'not-requested' as const,
        networkExposure: networkExposure.value,
        ...(networkExposure.reason ? { networkExposureReason: networkExposure.reason } : {}),
        generatedHostPaths: Object.freeze(paths),
    })
    issuedRuntimes.set(projection, Object.freeze({ storage: Object.freeze(storage), stackId: authority.stackId,
        executable: connection.kind === 'local-fallback',
        ...(connection.kind === 'remote' ? { remote: Object.freeze({ configuredEndpoint: connection.endpoint,
            baseProxyPort: proxy.proxy.port, ...(input.hostVariable ? { hostVariable: input.hostVariable } : {}) }) } : {}),
        ...(namespace ? { coordination: Object.freeze({ namespace, stackId: authority.stackId }) } : {}) }))
    return projection
}

export type BrowserRuntimeProjection = ReturnType<typeof resolveBrowserRuntime>

export function browserRuntimeExecutionReady(runtime: BrowserRuntimeProjection): boolean {
    return issuedRuntimes.get(runtime)?.executable === true
}

function controlAuthority(value: string, defaultPort: number): string {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`)
    return `${parsed.hostname}:${parsed.port || defaultPort}`
}

export function browserRuntimeControlAuthorities(runtime: BrowserRuntimeProjection): readonly string[] | undefined {
    if (!issuedRuntimes.has(runtime)) return undefined
    return Object.freeze([...new Set([
        ...(runtime.connection.kind === 'remote' ? [controlAuthority(runtime.connection.endpoint, 80),
            `127.0.0.1:${runtime.server.port}`, `localhost:${runtime.server.port}`] : []),
        ...runtime.proxy.allowedHosts.map(value => controlAuthority(value, 80)),
    ])])
}

export function browserRuntimeControlPorts(runtime: BrowserRuntimeProjection): readonly number[] | undefined {
    if (!issuedRuntimes.has(runtime)) return undefined
    return Object.freeze(runtime.connection.kind === 'remote' ? [runtime.server.port] : [])
}

export function bindBrowserRuntimePortLease(runtime: BrowserRuntimeProjection,
    projection: PortLeaseProjection): BrowserRuntimeProjection | undefined {
    const binding = issuedRuntimes.get(runtime)
    const ports = inspectPortLeaseProjection(projection)
    if (!binding?.remote || binding.executable || !ports || ports.lease.stackId !== binding.stackId) return undefined
    const candidates = Object.entries(ports.lease.ports)
        .filter(([, value]) => value - ports.lease.offset === binding.remote!.baseProxyPort)
    const selected = binding.remote.hostVariable === undefined
        ? candidates.length === 1 ? candidates[0] : undefined
        : candidates.find(([name]) => name === binding.remote!.hostVariable)
    if (!selected || selected[1] - ports.lease.offset !== binding.remote.baseProxyPort) return undefined
    const configured = new URL(binding.remote.configuredEndpoint)
    const endpoint = `${configured.protocol}//${configured.hostname}:${selected[1]}${configured.pathname}`
    const authority = (value: string) => {
        const parsed = new URL(`http://${value}`)
        return `${parsed.hostname}:${selected[1]}`
    }
    const rebound = Object.freeze({
        ...runtime,
        connection: Object.freeze({ kind: 'remote' as const, endpoint, launchLocal: false as const }),
        runner: Object.freeze({ ...runtime.runner, endpoint }),
        mcp: Object.freeze({ ...runtime.mcp, endpoint }),
        proxy: Object.freeze({ ...runtime.proxy, port: selected[1],
            allowedHosts: Object.freeze(runtime.proxy.allowedHosts.map(authority)) }),
    })
    issuedRuntimes.set(rebound, Object.freeze({ ...binding, executable: true }))
    return rebound
}

export function browserRuntimeCoordination(runtime: BrowserRuntimeProjection): Readonly<{ namespace: StateNamespace; stackId: import('../environment/contract.js').StackId }> | undefined {
    return issuedRuntimes.get(runtime)?.coordination
}

export function assertBrowserArtifactRegistration(runtime: BrowserRuntimeProjection, producedPaths: readonly string[]): void {
    if (!issuedRuntimes.has(runtime)) throw new TypeError('browser artifact registration requires an issued runtime')
    assertPlainData(producedPaths)
    if (!Array.isArray(producedPaths) || producedPaths.length === 0 || producedPaths.length > 1024) {
        throw new TypeError('browser artifact registration needs a bounded nonempty output inventory')
    }
    for (const path of producedPaths) {
        if (!GeneratedHostPath.safeParse(path).success
            || !runtime.generatedHostPaths.some((root) => path === root || path.startsWith(`${root}/`))) {
            throw new TypeError('browser output is unregistered with reset artifact ownership')
        }
    }
    if (runtime.generatedHostPaths.some((root) => !producedPaths.some((path) => path === root || path.startsWith(`${root}/`)))) {
        throw new TypeError('each browser transport artifact root requires a produced output')
    }
}

export function assertBrowserStorageStateCurrent(runtime: BrowserRuntimeProjection): void {
    const binding = issuedRuntimes.get(runtime)
    if (!binding) throw new TypeError('browser storage state revalidation requires an issued runtime')
    for (const state of binding.storage) {
        if (storageIdentity(state.path) !== state.identity) throw new TypeError('browser seeded storage state changed after resolution')
    }
}
