import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { readBoundedFile } from '../bounded-read.js'
import { isIP } from 'node:net'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { errorCause, snapshotJson, type HolderId, type StackId, RefusalError, hasErrorCode } from '../environment/contract.js'
import { type StateNamespace } from '../environment/state.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { assertBrowserStorageStateCurrent, browserRuntimeControlAuthorities, browserRuntimeControlPorts, type BrowserRuntimeProjection } from './runtime.js'
import { authenticateBrowserProjectClient, executeBrowserProjectOperation, withBrowserProjectOperationAdmission,
    type BrowserProjectClient, type BrowserProjectOperationAuthorization } from './surfaces.js'

export type BrowserCommandKind = 'drive' | 'screenshot'
interface BrowserRouteDeclaration { readonly name: string; readonly path: string }
export interface BrowserRoutePolicy {
    readonly origin: string
    readonly surfaces: readonly Readonly<{ name: string; url: string }>[]
}
type BrowserDiagnosticEntry =
    | Readonly<{ kind: 'console'; path?: string; line?: number }>
    | Readonly<{ kind: 'pageerror'; name: string }>
    | Readonly<{ kind: 'request'; method: string; path: string; status: number } | { kind: 'request'; method: string; path: string; failure: string }>
/**
 * Console and uncaught error text, capped in count and bytes. It is page content, so a reader treats
 * it as data and never as instructions. Present only for a data posture that is isolated, not
 * restored and not reaching production; otherwise `omitted` says why there is none.
 */
type BrowserMessageExcerpt =
    | Readonly<{ trust: 'untrusted-page-content'; messages: readonly Readonly<{ kind: 'console' | 'pageerror'; text: string }>[] }>
    | Readonly<{ omitted: string }>
/** What a route's page did wrong. Identifiers and counts, plus a message excerpt where the data posture allows it: never bodies, headers or cookies. */
interface BrowserRouteDiagnostics {
    readonly consoleErrors: number
    readonly consoleWarnings: number
    readonly pageErrors: number
    readonly failedRequests: number
    readonly abortedRequests: number
    readonly thirdParty: Readonly<{ requests: number; failed: number }>
    readonly entries: readonly BrowserDiagnosticEntry[]
    readonly omitted: number
    readonly excerpt: BrowserMessageExcerpt
}
type BrowserRouteVerdict = 'clean' | 'findings'
export interface BrowserCommandInput {
    readonly runtime: BrowserRuntimeProjection
    readonly client: BrowserProjectClient
    readonly policy: BrowserRoutePolicy
    readonly kind: BrowserCommandKind
    /** A declared route's name or path; every declared route is driven when absent. */
    readonly route?: string
    readonly role?: string
    readonly state?: Readonly<{ namespace: StateNamespace; stackId: StackId; ownerId: HolderId }>
}
interface BrowserCommandSurfaceReceipt {
    readonly name: string
    readonly url: string
    readonly screenshot?: Readonly<{ path: string; sha256: string; byteLength: number }>
    readonly diagnostics?: BrowserRouteDiagnostics
    readonly verdict?: BrowserRouteVerdict
}
export interface BrowserCommandReceipt {
    readonly kind: BrowserCommandKind
    readonly activation: 'application'
    readonly authentication: Readonly<{ posture: 'bypassed' | 'none' } | { posture: 'real'; role: string; policy: 'serialized' | 'per-worker' }>
    readonly surfaces: readonly Readonly<BrowserCommandSurfaceReceipt>[]
    /** drive only: findings when any route has console errors, uncaught errors or failed own-origin requests. */
    readonly verdict?: BrowserRouteVerdict
}
export type BrowserCommandResult = Readonly<{ kind: 'complete'; receipt: BrowserCommandReceipt }>
    | Readonly<{ kind: 'refusal'; reason: string }>

const issuedPolicies = new WeakMap<BrowserRoutePolicy, BrowserRuntimeProjection>()
const issuedReceipts = new WeakSet<object>()
const kinds = new Set<BrowserCommandKind>(['drive', 'screenshot'])
const sha256 = /^[a-f0-9]{64}$/
const MAX_SCREENSHOT_BYTES = 8_388_608
const COMMAND_TIMEOUT_MS = 30_000
const browserFailureCategories = Object.freeze({
    connect: 'availability', context: 'setup', navigation: 'navigation',
    screenshot: 'observation', artifact: 'artifact', cleanup: 'cleanup',
} as const)
function refusal(reason: string): BrowserCommandResult {
    return { kind: 'refusal', reason }
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
    // The bytes come from the child's stderr and a parse error can quote them; the caller reports
    // the failure from its own fixed text when this returns undefined.
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
        ? { phase, category, cleanup: row.cleanup, ...(typeof row.reason === 'string' ? { reason: row.reason } : {}) }
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
        return `: the browser does not trust the certificate at ${url} (${reason}); add the issuing CA to the ${runtime.connection.kind === 'remote' ? 'remote browser\'s image' : 'host trust store'}`
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

export function issueBrowserRoutePolicy(runtime: BrowserRuntimeProjection, input: Readonly<{ origin: string; routes: readonly BrowserRouteDeclaration[] }>): BrowserRoutePolicy {
    assertBrowserStorageStateCurrent(runtime)
    const captured = snapshotJson(input) as { origin?: unknown; routes?: unknown } | undefined
    if (!captured || Object.keys(captured).sort().join(',') !== 'origin,routes') {
        throw new RefusalError('browser route policy requires closed origin and route declarations')
    }
    if (typeof captured.origin !== 'string' || !Array.isArray(captured.routes)
        || captured.routes.length === 0 || captured.routes.length > 64) throw new RefusalError('browser route policy requires bounded declared routes')
    let origin: URL
    try { origin = new URL(captured.origin) } catch { throw new RefusalError('browser application origin must be an absolute HTTP(S) origin') }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/'
        || origin.search || origin.hash || origin.origin !== captured.origin.replace(/\/$/, '')) {
        throw new RefusalError('browser application origin must be an absolute HTTP(S) origin without credentials, path, query or fragment')
    }
    const controlAuthorities = browserRuntimeControlAuthorities(runtime)
    const controlPorts = browserRuntimeControlPorts(runtime)
    const originPort = Number(origin.port || (origin.protocol === 'http:' ? '80' : '443'))
    const originAuthority = `${origin.hostname}:${originPort}`
    if (!controlAuthorities || !controlPorts || controlAuthorities.includes(originAuthority) || controlPorts.includes(originPort)) {
        throw new RefusalError('browser application origin must be distinct from the browser-control proxy authority')
    }
    const names = new Set<string>(); const urls = new Set<string>()
    const surfaces: Array<Readonly<{ name: string; url: string }>> = []
    for (const candidate of captured.routes) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new RefusalError('browser routes must be declared relative paths')
        const row = candidate as { name?: unknown; path?: unknown }
        if (Object.keys(row).sort().join(',') !== 'name,path') throw new RefusalError('browser route policy requires closed route declarations')
        if (typeof row.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.name)
            || typeof row.path !== 'string' || !row.path.startsWith('/') || row.path.startsWith('//') || row.path.includes('#')) {
            throw new RefusalError('browser routes must use unique names and declared relative HTTP paths without fragments')
        }
        const url = new URL(row.path, origin)
        if (url.origin !== origin.origin || url.username || url.password || url.hash || names.has(row.name) || urls.has(url.href)) {
            throw new RefusalError('browser routes must remain unique and relative to the application origin')
        }
        names.add(row.name); urls.add(url.href)
        surfaces.push({ name: row.name, url: url.href })
    }
    const policy = { origin: origin.origin, surfaces }
    issuedPolicies.set(policy, runtime)
    return policy
}

function authentication(input: BrowserCommandInput): Readonly<{ posture: 'bypassed' | 'none'; statePath?: undefined } | {
    posture: 'real'; role: string; policy: 'serialized' | 'per-worker'; statePath: string
}> | undefined {
    const auth = input.runtime.authentication
    if (auth.posture !== 'real') return input.role === undefined && input.state === undefined ? { posture: auth.posture } : undefined
    if (typeof input.role !== 'string' || auth.policy === 'none') return undefined
    const state = auth.states.find(candidate => candidate.worker === input.role)
    if (!state) return undefined
    return { posture: 'real' as const, role: input.role, policy: auth.policy, statePath: resolve(input.client.cwd, state.path) }
}

function publicAuthentication(value: NonNullable<ReturnType<typeof authentication>>): BrowserCommandReceipt['authentication'] {
    return value.posture !== 'real' ? { posture: value.posture }
        : { posture: 'real' as const, role: value.role, policy: value.policy }
}

const MAX_DIAGNOSTIC_ENTRIES = 20
const MAX_EXCERPT_MESSAGES = 5
const MAX_EXCERPT_MESSAGE_BYTES = 240
const EXCERPT_OMITTED = 'browser.data is not isolated, non-production and non-restored, so page message text is never read; the counts and entries above still apply'
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const exactKeys = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).sort().join(',') === keys.sort().join(',')
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const diagnosticPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^\/[^\s?#\x00-\x1f\x7f]*$/.test(value)

function parseDiagnosticEntry(value: unknown): BrowserDiagnosticEntry | undefined {
    if (!isRecord(value)) return undefined
    if (value.kind === 'console') {
        const keys = ['kind', ...value.path !== undefined ? ['path'] : [], ...value.line !== undefined ? ['line'] : []]
        if (!exactKeys(value, keys) || value.path !== undefined && !diagnosticPath(value.path) || value.line !== undefined && !isCount(value.line)) return undefined
        return { kind: 'console', ...value.path !== undefined ? { path: value.path as string } : {}, ...value.line !== undefined ? { line: value.line as number } : {} }
    }
    if (value.kind === 'pageerror') {
        return exactKeys(value, ['kind', 'name']) && typeof value.name === 'string' && /^[A-Za-z0-9_$.]{1,64}$/.test(value.name)
            ? { kind: 'pageerror', name: value.name } : undefined
    }
    if (value.kind !== 'request' || typeof value.method !== 'string' || !/^[A-Z]{1,16}$/.test(value.method) || !diagnosticPath(value.path)) return undefined
    if (exactKeys(value, ['kind', 'method', 'path', 'status'])) {
        return Number.isInteger(value.status) && (value.status as number) >= 400 && (value.status as number) <= 599
            ? { kind: 'request', method: value.method, path: value.path, status: value.status as number } : undefined
    }
    return exactKeys(value, ['kind', 'method', 'path', 'failure']) && typeof value.failure === 'string' && /^ERR_[A-Z0-9_]{1,64}$/.test(value.failure)
        ? { kind: 'request', method: value.method, path: value.path, failure: value.failure } : undefined
}

function parseMessages(value: unknown): Extract<BrowserMessageExcerpt, { trust: string }> | undefined {
    if (!Array.isArray(value) || value.length > MAX_EXCERPT_MESSAGES) return undefined
    const messages: Array<{ kind: 'console' | 'pageerror'; text: string }> = []
    for (const row of value) {
        if (!isRecord(row) || !exactKeys(row, ['kind', 'text']) || row.kind !== 'console' && row.kind !== 'pageerror' || typeof row.text !== 'string'
            || row.text.length === 0 || Buffer.byteLength(row.text) > MAX_EXCERPT_MESSAGE_BYTES || /[\x00-\x1f\x7f]/.test(row.text)) return undefined
        messages.push({ kind: row.kind, text: row.text })
    }
    return { trust: 'untrusted-page-content', messages }
}

// The operation reads message text only when asked to, so its presence must match the posture exactly.
function parseDiagnostics(value: unknown, excerptAllowed: boolean): BrowserRouteDiagnostics | undefined {
    if (!isRecord(value) || !exactKeys(value, ['consoleErrors', 'consoleWarnings', 'pageErrors', 'failedRequests', 'abortedRequests', 'thirdParty', 'entries', 'omitted', ...excerptAllowed ? ['messages'] : []])) return undefined
    const { consoleErrors, consoleWarnings, pageErrors, failedRequests, abortedRequests, thirdParty, entries, omitted } = value
    if (![consoleErrors, consoleWarnings, pageErrors, failedRequests, abortedRequests, omitted].every(isCount)
        || !isRecord(thirdParty) || !exactKeys(thirdParty, ['requests', 'failed']) || !isCount(thirdParty.requests) || !isCount(thirdParty.failed)
        || !Array.isArray(entries) || entries.length > MAX_DIAGNOSTIC_ENTRIES) return undefined
    const parsed = entries.map(parseDiagnosticEntry)
    if (parsed.some(entry => entry === undefined)) return undefined
    const excerpt = excerptAllowed ? parseMessages(value.messages) : { omitted: EXCERPT_OMITTED }
    if (!excerpt) return undefined
    // Every finding is either listed or counted as omitted, so the listing can never hide one.
    if (parsed.length + (omitted as number) !== (consoleErrors as number) + (pageErrors as number) + (failedRequests as number)) return undefined
    return { consoleErrors: consoleErrors as number, consoleWarnings: consoleWarnings as number, pageErrors: pageErrors as number,
        failedRequests: failedRequests as number, abortedRequests: abortedRequests as number,
        thirdParty: { requests: thirdParty.requests, failed: thirdParty.failed }, entries: parsed as BrowserDiagnosticEntry[], omitted: omitted as number, excerpt }
}

const routeVerdict = (diagnostics: BrowserRouteDiagnostics): BrowserRouteVerdict =>
    diagnostics.consoleErrors + diagnostics.pageErrors + diagnostics.failedRequests > 0 ? 'findings' : 'clean'

function parseObservation(value: Buffer, kind: BrowserCommandKind, origin: string, excerptAllowed: boolean): Readonly<{ finalUrl: string; diagnostics?: BrowserRouteDiagnostics; evidence?: { sha256: string; byteLength: number } }> | undefined {
    let parsed: unknown
    // Child stdout can be quoted by a parse error; the caller refuses with its own fixed message.
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) } catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const row = parsed as Record<string, unknown>
    const expected = kind === 'drive' ? ['diagnostics', 'finalUrl', 'operation', 'schema'] : ['evidence', 'finalUrl', 'operation', 'schema']
    if (Object.keys(row).sort().join(',') !== expected.sort().join(',') || row.schema !== 'cockpit-browser-observation/v1' || row.operation !== kind || typeof row.finalUrl !== 'string') return undefined
    let final: URL
    // A URL error quotes the child-reported address; the caller refuses with its own fixed message.
    try { final = new URL(row.finalUrl) } catch { return undefined }
    if (final.origin !== origin || final.username || final.password || final.hash) return undefined
    if (kind === 'drive') {
        const diagnostics = parseDiagnostics(row.diagnostics, excerptAllowed)
        return diagnostics ? { finalUrl: final.href, diagnostics } : undefined
    }
    if (!row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) return undefined
    const evidence = row.evidence as Record<string, unknown>
    if (Object.keys(evidence).sort().join(',') !== 'byteLength,sha256' || typeof evidence.sha256 !== 'string' || !sha256.test(evidence.sha256)
        || !Number.isSafeInteger(evidence.byteLength) || (evidence.byteLength as number) < 0
        || (evidence.byteLength as number) > MAX_SCREENSHOT_BYTES) return undefined
    return { finalUrl: final.href, evidence: { sha256: evidence.sha256, byteLength: evidence.byteLength as number } }
}

// Returns undefined when the file fails a check; a filesystem error is thrown for the caller to name.
function postcheckScreenshot(root: string, cockpitRoot: string, path: string, expected: { sha256: string; byteLength: number }): string | undefined {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) return undefined
    const rel = relative(root, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || resolve(root, rel) !== path || realpathSync(path) !== path) return undefined
    const read = readBoundedFile(path, expected.byteLength)
    const linked = lstatSync(path)
    if (read.kind !== 'complete' || read.bytes.byteLength !== expected.byteLength || linked.nlink !== 1 || (linked.mode & 0o7777) !== 0o600
        || createHash('sha256').update(read.bytes).digest('hex') !== expected.sha256) return undefined
    const receiptPath = relative(cockpitRoot, path)
    return receiptPath && !receiptPath.startsWith('..') && !isAbsolute(receiptPath) ? receiptPath : undefined
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
            if (!hasErrorCode(error, 'ENOENT')) return `Browser screenshot artifact root ${root} could not be inspected at ${ancestor}: ${errorCause(error)}`
            const parent = dirname(ancestor)
            if (parent === ancestor) return `Browser screenshot artifact root ${root} has no existing ancestor`
            ancestor = parent
        }
    }
    try { mkdirSync(root, { recursive: true, mode: 0o700 }) } catch (error) {
        return `Browser screenshot artifact root ${root} could not be created: ${errorCause(error)}`
    }
    return undefined
}

async function run(input: BrowserCommandInput, client: BrowserProjectClient, surfaces: BrowserRoutePolicy['surfaces'], policy: BrowserRoutePolicy,
    auth: NonNullable<ReturnType<typeof authentication>>, deadline: number,
    authorization: BrowserProjectOperationAuthorization): Promise<BrowserCommandResult> {
    const receipts: BrowserCommandSurfaceReceipt[] = []
    if (input.kind === 'screenshot') {
        const unavailable = ensureArtifactRoot(client.artifactRoot)
        if (unavailable) return refusal(unavailable)
    }
    for (const surface of surfaces) {
        // Only the runtime's own fixed-text TypeError escapes the revalidation (it replaces filesystem
        // errors with that text), so the refusal names the condition instead.
        try { assertBrowserStorageStateCurrent(input.runtime) } catch { return refusal('Browser seeded state changed before application driving') }
        const output = input.kind === 'screenshot' ? resolve(client.artifactRoot, `screenshot-${randomUUID()}.png`) : undefined
        if (deadline <= Date.now()) return refusal('Browser command exceeded its total 30-second deadline')
        const authenticated = await executeBrowserProjectOperation(client, input.runtime, {
            kind: input.kind, surface, deadline, ...(auth.posture === 'real' ? { role: auth.role } : {}), ...(output ? { output } : {}),
        }, authorization)
        if (!authenticated || authenticated.kind === 'unadmitted') {
            return refusal(`Browser ${input.kind} operation was not admitted to the bounded executor for ${surface.name}${authenticated ? ` (${authenticated.cause})` : ''}`)
        }
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
        const observation = parseObservation(authenticated.stdout, input.kind, policy.origin, input.runtime.dataQualifies)
        if (!observation) return refusal(`Browser ${input.kind} returned no bound application-driving observation for ${surface.name}`)
        try { assertBrowserStorageStateCurrent(input.runtime) } catch { return refusal('Browser seeded state changed while the application was being driven') }
        const base = { name: surface.name, url: observation.finalUrl }
        if (input.kind === 'screenshot') {
            let path: string | undefined
            let cause = ''
            try { path = postcheckScreenshot(client.artifactRoot, client.cwd, output!, observation.evidence!) } catch (error) { cause = ` (${errorCause(error)})` }
            if (!path) return refusal(`Browser screenshot output failed its contained mode-600 postcheck for ${surface.name}${cause}`)
            receipts.push({ ...base, screenshot: { path, ...observation.evidence! } })
        } else receipts.push({ ...base, diagnostics: observation.diagnostics!, verdict: routeVerdict(observation.diagnostics!) })
    }
    const receipt = { kind: input.kind, activation: 'application' as const,
        authentication: publicAuthentication(auth), surfaces: receipts,
        ...input.kind === 'drive' ? { verdict: receipts.some(row => row.verdict === 'findings') ? 'findings' as const : 'clean' as const } : {} }
    issuedReceipts.add(receipt)
    return { kind: 'complete', receipt }
}

// A route is chosen by its declared name or its declared path; anything else is refused with the choices.
function selectRoutes(input: BrowserCommandInput): BrowserRoutePolicy['surfaces'] | string {
    if (input.route === undefined) return input.policy.surfaces
    const route = input.route
    const origin = new URL(input.policy.origin)
    let href: string | undefined
    if (route.startsWith('/') && !route.startsWith('//')) { try { href = new URL(route, origin).href } catch { href = undefined } }
    const surface = input.policy.surfaces.find(row => row.name === route || href !== undefined && row.url === href)
    if (surface) return [surface]
    // The route is the caller's own input, so it is safe to echo back.
    return `Browser route ${JSON.stringify(route)} is not declared; declared routes are ${input.policy.surfaces.map(row => `${row.name} (${new URL(row.url).pathname + new URL(row.url).search})`).join(', ')}`
}

export async function executeBrowserCommand(value: BrowserCommandInput): Promise<BrowserCommandResult> {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    const input = value
    if (!kinds.has(input.kind)) return refusal('Browser command kind is unsupported')
    let client: BrowserProjectClient | undefined
    let clientCause = ''
    try { client = authenticateBrowserProjectClient(input.client, input.runtime) } catch (error) { clientCause = ` (${errorCause(error)})` }
    if (!client) return refusal(`Browser command requires an issued project module client${clientCause}`)
    if (issuedPolicies.get(input.policy) !== input.runtime) return refusal('Browser command requires an issued route policy for the current runtime')
    if (input.runtime.connection.kind === 'remote' && !networkExposureCovers(input.runtime.networkExposure, new URL(input.policy.origin))) {
        return refusal(`Browser application origin ${input.policy.origin} is outside browser.network_exposure (${input.runtime.networkExposure}): `
            + 'a remote browser reaches host addresses only through that exposure, so it would look for the application inside its own container. '
            + 'Use a 127.0.0.1, localhost or .localhost origin (an IPv6 literal is never tunnelled), or widen network_exposure with a network_exposure_reason')
    }
    const selected = selectRoutes(input)
    if (typeof selected === 'string') return refusal(selected)
    const auth = authentication(input)
    if (!auth) return refusal(input.runtime.authentication.posture === 'real'
        ? 'Browser command requires a declared seeded role and matching coordination authority' : 'Bypassed browser authentication cannot accept role or state input')
    const admitted = await withBrowserProjectOperationAdmission(client, input.runtime, {
        origin: input.policy.origin, ...(auth.posture === 'real' ? { role: auth.role } : {}), ...(input.state ? { state: input.state } : {}),
    }, authorization => run(input, client!, selected, input.policy, auth, deadline, authorization))
    return admitted.kind === 'admitted' ? admitted.value : refusal(admitted.reason)
}
