import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isProxy } from 'node:util/types'
import { snapshotJson, type HolderId, type StackId } from '../environment/contract.js'
import { inspectBrowserDebuggerPreparation, type BrowserDebuggerPreparation } from '../environment/generated-application.js'
import { type StateNamespace } from '../environment/state.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { assertBrowserStorageStateCurrent, browserRuntimeControlAuthorities, browserRuntimeControlPorts, type BrowserRuntimeProjection } from './runtime.js'
import { authenticateBrowserProjectClient, executeBrowserProjectOperation, withBrowserProjectOperationAdmission,
    type BrowserProjectClient, type BrowserProjectOperationAuthorization } from './surfaces.js'

export const mechanism = {
    id: 'browser-command',
    module: 'packages/cockpit/src/browser/commands.ts',
    exports: ['executeBrowserCommand', 'isIssuedBrowserCommandReceipt', 'issueBrowserRoutePolicy'],
} as const

export type BrowserCommandKind = 'drive' | 'accessibility' | 'screenshot'
export interface BrowserRouteDeclaration { readonly name: string; readonly path: string }
export interface BrowserRoutePolicy {
    readonly origin: string
    readonly surfaces: readonly Readonly<{ name: string; url: string }>[]
}
export interface BrowserCommandInput {
    readonly runtime: BrowserRuntimeProjection
    readonly client: BrowserProjectClient
    readonly policy: BrowserRoutePolicy
    readonly kind: BrowserCommandKind
    readonly role?: string
    readonly headed?: boolean
    readonly debugger?: BrowserDebuggerPreparation
    readonly state?: Readonly<{ namespace: StateNamespace; stackId: StackId; ownerId: HolderId }>
}
export interface BrowserCommandSurfaceReceipt {
    readonly name: string
    readonly url: string
    readonly accessibility?: Readonly<{ sha256: string; byteLength: number }>
    readonly screenshot?: Readonly<{ path: string; sha256: string; byteLength: number }>
}
export interface BrowserCommandReceipt {
    readonly kind: BrowserCommandKind
    readonly activation: 'application'
    readonly authentication: Readonly<{ posture: 'bypassed' | 'none' } | { posture: 'real'; role: string; policy: 'serialized' | 'per-worker' }>
    readonly surfaces: readonly Readonly<BrowserCommandSurfaceReceipt>[]
}
export type BrowserCommandResult = Readonly<{ kind: 'complete'; receipt: BrowserCommandReceipt }>
    | Readonly<{ kind: 'debugger-preparation'; preparation: BrowserDebuggerPreparation; reason: string }>
    | Readonly<{ kind: 'refusal'; reason: string }>

const issuedPolicies = new WeakMap<BrowserRoutePolicy, BrowserRuntimeProjection>()
const issuedReceipts = new WeakSet<object>()
const kinds = new Set<BrowserCommandKind>(['drive', 'accessibility', 'screenshot'])
const sha256 = /^[a-f0-9]{64}$/
const MAX_ARIA_BYTES = 65_536
const MAX_SCREENSHOT_BYTES = 8_388_608
const COMMAND_TIMEOUT_MS = 30_000
const browserFailureCategories = Object.freeze({
    connect: 'availability', context: 'setup', navigation: 'navigation', accessibility: 'observation',
    screenshot: 'observation', artifact: 'artifact', cleanup: 'cleanup',
} as const)
function refusal(reason: string): BrowserCommandResult {
    return Object.freeze({ kind: 'refusal', reason })
}

// The reason vocabulary the operation program may report: identifiers only, never page text.
const FAILURE_REASON = /^(?:ERR_[A-Z0-9_]{1,64}|HTTP_[1-5][0-9]{2}|TIMEOUT)$/
const UNANSWERED = new Set(['ERR_CONNECTION_REFUSED', 'ERR_SOCKS_CONNECTION_FAILED', 'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_CLOSED', 'ERR_EMPTY_RESPONSE', 'ERR_ADDRESS_UNREACHABLE'])

function parseBrowserFailure(value: Buffer): Readonly<{
    phase: keyof typeof browserFailureCategories
    category: (typeof browserFailureCategories)[keyof typeof browserFailureCategories]
    cleanup: boolean
    reason?: string
}> | undefined {
    if (value.byteLength === 0 || value.byteLength > 1_024) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) } catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const row = parsed as Record<string, unknown>
    const keys = Object.keys(row).sort().join(',')
    if (keys !== 'category,cleanup,phase,schema' && keys !== 'category,cleanup,phase,reason,schema'
        || row.schema !== 'cockpit-browser-failure/v1' || typeof row.phase !== 'string'
        || !(row.phase in browserFailureCategories) || typeof row.cleanup !== 'boolean'
        || row.reason !== undefined && (typeof row.reason !== 'string' || !FAILURE_REASON.test(row.reason))) return undefined
    const phase = row.phase as keyof typeof browserFailureCategories
    const category = browserFailureCategories[phase]
    return row.category === category
        ? Object.freeze({ phase, category, cleanup: row.cleanup, ...(typeof row.reason === 'string' ? { reason: row.reason } : {}) })
        : undefined
}

// What a person can do about a failed navigation, keyed by the reason the browser reported.
function failureHint(reason: string | undefined, url: string, runtime: BrowserRuntimeProjection): string {
    if (reason === undefined) return ''
    if (UNANSWERED.has(reason)) {
        return `: nothing answered at ${url} (${reason}); check that the application is up with ${cockpitCommand('doctor', { config: runtime.configurationPath })}`
    }
    if (reason === 'ERR_NAME_NOT_RESOLVED') return `: ${new URL(url).hostname} did not resolve (${reason}); use the declared .localhost hostname or 127.0.0.1`
    if (reason.startsWith('ERR_CERT_')) {
        return `: the browser does not trust the certificate at ${url} (${reason}); add the issuing CA to the ${runtime.connection.kind === 'remote' ? 'browser runner image' : 'host trust store'}`
    }
    if (reason.startsWith('HTTP_')) return `: ${url} answered HTTP ${reason.slice(5)}, and a surface must answer 2xx`
    if (reason === 'TIMEOUT') return `: ${url} did not finish loading within the 30-second command deadline`
    return ` (${reason})`
}

// Mirrors Playwright's exposeNetwork matching: a remote browser reaches an address through the
// connecting client only when a rule covers it, and goes to its own network for everything else.
// Chromium hands the tunnel an IPv6 literal without brackets, which no rule matches (its
// <loopback> names only the bracketed form), so an IPv6 origin is never covered.
function networkExposureCovers(exposure: string, origin: URL): boolean {
    const hostname = origin.hostname.toLowerCase()
    if (hostname.startsWith('[')) return false
    const port = Number(origin.port || (origin.protocol === 'http:' ? '80' : '443'))
    const ip = isIP(hostname) !== 0
    return exposure.split(',').some(rule => {
        const match = /^(.*?)(?::(\d+))?$/.exec(rule)
        if (!match || match[2] !== undefined && Number(match[2]) !== port) return false
        const host = match[1]!.toLowerCase()
        if (host === '<loopback>') return ['localhost', '127.0.0.1'].includes(hostname) || hostname.endsWith('.localhost')
        if (host === '*') return true
        if (isIP(host) !== 0) return host === hostname
        if (ip) return false
        const pattern = host.startsWith('.') ? `*${host}` : host
        return pattern.startsWith('*.') ? hostname.endsWith(pattern.slice(1)) : hostname === pattern
    })
}

function ownDataRecord(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = Reflect.ownKeys(descriptors)
        const allowed = new Set([...required, ...optional])
        if (keys.some(key => typeof key !== 'string' || !allowed.has(key))
            || required.some(key => !(key in descriptors))
            || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) return undefined
        return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    } catch {
        return undefined
    }
}

function captureBrowserCommandInput(value: unknown): Readonly<BrowserCommandInput> | undefined {
    const captured = ownDataRecord(value, ['runtime', 'client', 'policy', 'kind'], ['role', 'headed', 'debugger', 'state'])
    if (!captured || captured.runtime === null || typeof captured.runtime !== 'object' || isProxy(captured.runtime)
        || captured.client === null || typeof captured.client !== 'object' || isProxy(captured.client)
        || captured.policy === null || typeof captured.policy !== 'object' || isProxy(captured.policy)
        || typeof captured.kind !== 'string'
        || (captured.role !== undefined && typeof captured.role !== 'string')
        || (captured.headed !== undefined && typeof captured.headed !== 'boolean')
        || (captured.debugger !== undefined && (captured.debugger === null || typeof captured.debugger !== 'object' || isProxy(captured.debugger)))) return undefined
    let state: BrowserCommandInput['state']
    if (captured.state !== undefined) {
        const row = ownDataRecord(captured.state, ['namespace', 'stackId', 'ownerId'], [])
        if (!row || row.namespace === null || typeof row.namespace !== 'object' || isProxy(row.namespace)
            || typeof row.stackId !== 'string' || typeof row.ownerId !== 'string') return undefined
        state = Object.freeze({ namespace: row.namespace as StateNamespace, stackId: row.stackId as StackId, ownerId: row.ownerId as HolderId })
    }
    return Object.freeze({ runtime: captured.runtime as BrowserRuntimeProjection, client: captured.client as BrowserProjectClient,
        policy: captured.policy as BrowserRoutePolicy, kind: captured.kind as BrowserCommandKind,
        ...(captured.role !== undefined ? { role: captured.role as string } : {}),
        ...(captured.headed !== undefined ? { headed: captured.headed as boolean } : {}),
        ...(captured.debugger !== undefined ? { debugger: captured.debugger as BrowserDebuggerPreparation } : {}), ...(state ? { state } : {}) })
}

export function issueBrowserRoutePolicy(runtime: BrowserRuntimeProjection, input: Readonly<{ origin: string; routes: readonly BrowserRouteDeclaration[] }>): BrowserRoutePolicy {
    assertBrowserStorageStateCurrent(runtime)
    const captured = snapshotJson(input) as { origin?: unknown; routes?: unknown } | undefined
    if (!captured || Object.keys(captured).sort().join(',') !== 'origin,routes') {
        throw new TypeError('browser route policy requires closed origin and route declarations')
    }
    if (typeof captured.origin !== 'string' || !Array.isArray(captured.routes)
        || captured.routes.length === 0 || captured.routes.length > 64) throw new TypeError('browser route policy requires bounded declared routes')
    let origin: URL
    try { origin = new URL(captured.origin) } catch { throw new TypeError('browser application origin must be an absolute HTTP(S) origin') }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/'
        || origin.search || origin.hash || origin.origin !== captured.origin.replace(/\/$/, '')) {
        throw new TypeError('browser application origin must be an absolute HTTP(S) origin without credentials, path, query or fragment')
    }
    const controlAuthorities = browserRuntimeControlAuthorities(runtime)
    const controlPorts = browserRuntimeControlPorts(runtime)
    const originPort = Number(origin.port || (origin.protocol === 'http:' ? '80' : '443'))
    const originAuthority = `${origin.hostname}:${originPort}`
    if (!controlAuthorities || !controlPorts || controlAuthorities.includes(originAuthority) || controlPorts.includes(originPort)) {
        throw new TypeError('browser application origin must be distinct from the browser-control proxy authority')
    }
    const names = new Set<string>(); const urls = new Set<string>()
    const surfaces: Array<Readonly<{ name: string; url: string }>> = []
    for (const candidate of captured.routes) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError('browser routes must be declared relative paths')
        const row = candidate as { name?: unknown; path?: unknown }
        if (Object.keys(row).sort().join(',') !== 'name,path') throw new TypeError('browser route policy requires closed route declarations')
        if (typeof row.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.name)
            || typeof row.path !== 'string' || !row.path.startsWith('/') || row.path.startsWith('//') || row.path.includes('#')) {
            throw new TypeError('browser routes must use unique names and declared relative HTTP paths without fragments')
        }
        const url = new URL(row.path, origin)
        if (url.origin !== origin.origin || url.username || url.password || url.hash || names.has(row.name) || urls.has(url.href)) {
            throw new TypeError('browser routes must remain unique and relative to the application origin')
        }
        names.add(row.name); urls.add(url.href)
        surfaces.push(Object.freeze({ name: row.name, url: url.href }))
    }
    const policy = Object.freeze({ origin: origin.origin, surfaces: Object.freeze(surfaces) })
    issuedPolicies.set(policy, runtime)
    return policy
}

function authentication(input: BrowserCommandInput): Readonly<{ posture: 'bypassed' | 'none'; statePath?: undefined } | {
    posture: 'real'; role: string; policy: 'serialized' | 'per-worker'; statePath: string
}> | undefined {
    const auth = input.runtime.authentication
    if (auth.posture !== 'real') return input.role === undefined && input.state === undefined ? Object.freeze({ posture: auth.posture }) : undefined
    if (typeof input.role !== 'string' || auth.policy === 'none') return undefined
    const state = auth.states.find(candidate => candidate.worker === input.role)
    if (!state) return undefined
    return Object.freeze({ posture: 'real' as const, role: input.role, policy: auth.policy, statePath: resolve(input.client.cwd, state.path) })
}

function publicAuthentication(value: NonNullable<ReturnType<typeof authentication>>): BrowserCommandReceipt['authentication'] {
    return value.posture !== 'real' ? Object.freeze({ posture: value.posture })
        : Object.freeze({ posture: 'real' as const, role: value.role, policy: value.policy })
}

function parseObservation(value: Buffer, kind: BrowserCommandKind, origin: string): Readonly<{ finalUrl: string; evidence?: { sha256: string; byteLength: number } }> | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) } catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const row = parsed as Record<string, unknown>
    const expected = kind === 'drive' ? ['finalUrl', 'operation', 'schema'] : ['evidence', 'finalUrl', 'operation', 'schema']
    if (Object.keys(row).sort().join(',') !== expected.sort().join(',') || row.schema !== 'cockpit-browser-observation/v1' || row.operation !== kind || typeof row.finalUrl !== 'string') return undefined
    let final: URL
    try { final = new URL(row.finalUrl) } catch { return undefined }
    if (final.origin !== origin || final.username || final.password || final.hash) return undefined
    if (kind === 'drive') return Object.freeze({ finalUrl: final.href })
    if (!row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) return undefined
    const evidence = row.evidence as Record<string, unknown>
    if (Object.keys(evidence).sort().join(',') !== 'byteLength,sha256' || typeof evidence.sha256 !== 'string' || !sha256.test(evidence.sha256)
        || !Number.isSafeInteger(evidence.byteLength) || (evidence.byteLength as number) < 0
        || (kind === 'accessibility' ? (evidence.byteLength as number) > MAX_ARIA_BYTES : (evidence.byteLength as number) > MAX_SCREENSHOT_BYTES)) return undefined
    return Object.freeze({ finalUrl: final.href, evidence: Object.freeze({ sha256: evidence.sha256, byteLength: evidence.byteLength as number }) })
}

function postcheckScreenshot(root: string, cockpitRoot: string, path: string, expected: { sha256: string; byteLength: number }): string | undefined {
    let descriptor: number | undefined
    try {
        const rootStat = lstatSync(root)
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) return undefined
        const rel = relative(root, path)
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || resolve(root, rel) !== path || realpathSync(path) !== path) return undefined
        const before = lstatSync(path)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size !== expected.byteLength) return undefined
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = fstatSync(descriptor)
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return undefined
        const bytes = Buffer.alloc(expected.byteLength)
        let offset = 0
        while (offset < bytes.length) { const read = readSync(descriptor, bytes, offset, bytes.length - offset, null); if (read === 0) break; offset += read }
        if (offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) return undefined
        const after = fstatSync(descriptor)
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return undefined
        const receiptPath = relative(cockpitRoot, path)
        return receiptPath && !receiptPath.startsWith('..') && !isAbsolute(receiptPath) ? receiptPath : undefined
    } catch { return undefined }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
}

export function isIssuedBrowserCommandReceipt(value: unknown): value is BrowserCommandReceipt {
    return value !== null && typeof value === 'object' && issuedReceipts.has(value)
}

// The artifact root is declared, not shipped, so the first screenshot meets a missing directory.
// Create it here, at the one place that writes into it, from the nearest existing ancestor, which
// must be a real directory: the operation re-authenticates the root's identity before it writes.
function ensureArtifactRoot(root: string): string | undefined {
    let ancestor = root
    for (;;) {
        try {
            const status = lstatSync(ancestor)
            if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(ancestor) !== ancestor) {
                return `Browser screenshot artifact root ${root} lies behind ${ancestor}, which is not a real directory`
            }
            break
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `Browser screenshot artifact root ${root} could not be inspected at ${ancestor}: ${(error as Error).message}`
            const parent = dirname(ancestor)
            if (parent === ancestor) return `Browser screenshot artifact root ${root} has no existing ancestor`
            ancestor = parent
        }
    }
    try { mkdirSync(root, { recursive: true, mode: 0o700 }) } catch (error) {
        return `Browser screenshot artifact root ${root} could not be created: ${(error as Error).message}`
    }
    return undefined
}

async function run(input: BrowserCommandInput, client: BrowserProjectClient, policy: BrowserRoutePolicy,
    auth: NonNullable<ReturnType<typeof authentication>>, deadline: number,
    authorization: BrowserProjectOperationAuthorization): Promise<BrowserCommandResult> {
    const receipts: BrowserCommandSurfaceReceipt[] = []
    if (input.kind === 'screenshot') {
        const unavailable = ensureArtifactRoot(client.artifactRoot)
        if (unavailable) return refusal(unavailable)
    }
    for (const surface of policy.surfaces) {
        try { assertBrowserStorageStateCurrent(input.runtime) } catch { return refusal('Browser seeded state changed before application driving') }
        const output = input.kind === 'screenshot' ? resolve(client.artifactRoot, `screenshot-${randomUUID()}.png`) : undefined
        if (deadline <= Date.now()) return refusal('Browser command exceeded its total 30-second deadline')
        const authenticated = await executeBrowserProjectOperation(client, input.runtime, Object.freeze({
            kind: input.kind, surface, deadline, ...(auth.posture === 'real' ? { role: auth.role } : {}), ...(output ? { output } : {}),
        }), authorization)
        if (!authenticated) return refusal(`Browser ${input.kind} operation was not admitted to the bounded executor for ${surface.name}`)
        const failure = authenticated.execution.exitCode === 0 ? undefined : parseBrowserFailure(authenticated.stderr)
        if (failure) {
            return refusal(`Browser ${input.kind} operation failed during ${failure.phase} (${failure.category})${failure.cleanup && failure.phase !== 'cleanup'
                ? ' and cleanup also failed' : ''} for ${surface.name}${failureHint(failure.reason, surface.url, input.runtime)}`)
        }
        if (authenticated.kind !== 'complete') {
            return refusal(`Browser ${input.kind} operation was refused by the bounded executor for ${surface.name}`)
        }
        if (authenticated.execution.exitCode !== 0) {
            return refusal(`Browser ${input.kind} operation failed without a valid bounded diagnostic for ${surface.name}`)
        }
        const observation = parseObservation(authenticated.stdout, input.kind, policy.origin)
        if (!observation) return refusal(`Browser ${input.kind} returned no bound application-driving observation for ${surface.name}`)
        try { assertBrowserStorageStateCurrent(input.runtime) } catch { return refusal('Browser seeded state changed while the application was being driven') }
        const base = { name: surface.name, url: observation.finalUrl }
        if (input.kind === 'accessibility') receipts.push(Object.freeze({ ...base, accessibility: observation.evidence! }))
        else if (input.kind === 'screenshot') {
            const path = postcheckScreenshot(client.artifactRoot, client.cwd, output!, observation.evidence!)
            if (!path) return refusal(`Browser screenshot output failed its contained mode-600 postcheck for ${surface.name}`)
            receipts.push(Object.freeze({ ...base, screenshot: Object.freeze({ path, ...observation.evidence! }) }))
        } else receipts.push(Object.freeze(base))
    }
    const receipt = Object.freeze({ kind: input.kind, activation: 'application' as const,
        authentication: publicAuthentication(auth), surfaces: Object.freeze(receipts) })
    issuedReceipts.add(receipt)
    return Object.freeze({ kind: 'complete', receipt })
}

export async function executeBrowserCommand(value: BrowserCommandInput): Promise<BrowserCommandResult> {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    const input = captureBrowserCommandInput(value)
    if (!input) return refusal('Browser command requires a closed own-data input')
    if (!kinds.has(input.kind)) return refusal('Browser command kind is unsupported')
    let client: BrowserProjectClient | undefined
    try { client = authenticateBrowserProjectClient(input.client, input.runtime) } catch { client = undefined }
    if (!client) return refusal('Browser command requires an issued project module client')
    if (issuedPolicies.get(input.policy) !== input.runtime) return refusal('Browser command requires an issued route policy for the current runtime')
    if (input.runtime.connection.kind === 'remote' && !networkExposureCovers(input.runtime.networkExposure, new URL(input.policy.origin))) {
        return refusal(`Browser application origin ${input.policy.origin} is outside browser.network_exposure (${input.runtime.networkExposure}): `
            + 'the generated runner reaches host addresses only through that exposure, so the browser would look for the application inside its own container. '
            + 'Use a 127.0.0.1, localhost or .localhost origin (an IPv6 literal is never tunnelled), or widen network_exposure with a network_exposure_reason')
    }
    if (input.headed === true) {
        if (!input.runtime.debugger.enabled) return refusal('Headed browser use was not enabled by the runtime')
        const preparation = inspectBrowserDebuggerPreparation(input.debugger, input.runtime)
        if (!preparation || preparation.cwd !== client.cwd) {
            return refusal('Headed browser use requires an authenticated foreground debugger preparation for the current runtime')
        }
        return Object.freeze({ kind: 'debugger-preparation', preparation,
            reason: 'Run the authenticated foreground command to open a headed browser; preparation does not produce UI evidence' })
    }
    const auth = authentication(input)
    if (!auth) return refusal(input.runtime.authentication.posture === 'real'
        ? 'Browser command requires a declared seeded role and matching coordination authority' : 'Bypassed browser authentication cannot accept role or state input')
    const admitted = await withBrowserProjectOperationAdmission(client, input.runtime, Object.freeze({
        origin: input.policy.origin, ...(auth.posture === 'real' ? { role: auth.role } : {}), ...(input.state ? { state: input.state } : {}),
    }), authorization => run(input, client!, input.policy, auth, deadline, authorization))
    return admitted.kind === 'admitted' ? admitted.value : refusal(admitted.reason)
}
