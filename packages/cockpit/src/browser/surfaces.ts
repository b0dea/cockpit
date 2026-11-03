import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { z } from 'zod'
import { errorCause, filesystemObjectIdentity, snapshotJson, type ExecutionStep, type FilesystemIdentity, type HolderId, type StackId, RefusalError } from '../environment/contract.js'
import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { libexecProgram } from '../environment-exec/libexec-program.js'
import { abortStateTransaction, authenticateStateNamespace, issueStateScopedLock, readState, transactState, withStateScopedLock,
    type StateNamespace, type StateRecord } from '../environment/state.js'
import { GeneratedHostPath } from '../schema.js'
import type { RenderedSurfaceFile } from '../surfaces/contract.js'
import { GUARD_SURFACE_TARGETS, type GuardSurfaceTarget } from '../surfaces/harness-registry.js'
import { collectMcpDeclarations, mcpApprovalDigest, type McpDeclaration } from '../surfaces/mcp.js'
import { isPackageDescendant } from './package-paths.js'
import { assertBrowserStorageStateCurrent, browserRuntimeControlAuthorities, browserRuntimeControlPorts, browserRuntimeCoordination, browserRuntimeExecutionReady, type BrowserRuntimeProjection } from './runtime.js'

export const mechanism = {
    id: 'browser-surfaces',
    module: 'packages/cockpit/src/browser/surfaces.ts',
    exports: ['authenticateBrowserProjectClient', 'executeBrowserProjectOperation', 'measuredBrowserHarnessVersions', 'observeBrowserProjectPackage', 'renderBrowserSurfaces', 'withBrowserProjectOperationAdmission'],
} as const

export type BrowserTestPackage = Readonly<{
    directory: string
    manifest: { readonly bytes: string; readonly sha256: string }
    cli: { readonly path: string; readonly bytes: string; readonly sha256: string }
}> & (Readonly<{ artifactRoot?: never; module?: never }> | Readonly<{
    artifactRoot: string
    module: { readonly path: string; readonly bytes: string; readonly sha256: string }
}>)

export interface BrowserSurfaceInput {
    readonly runtime: BrowserRuntimeProjection
    readonly cockpitDirectory: string
    readonly harnesses: readonly { readonly target: GuardSurfaceTarget; readonly version: string }[]
    readonly mcp: McpDeclaration
    readonly approved: boolean
    readonly testPackage: BrowserTestPackage | null
    readonly skillTemplate: string
}

export interface BrowserTransportRow {
    readonly target: GuardSurfaceTarget
    readonly version: string
    readonly transport: 'mcp' | 'cli'
    readonly measuredOn: string
    readonly measuredVersion: string
    readonly declaration: 'instructed' | 'unavailable'
    readonly callable: 'human_needed' | 'unavailable'
    readonly productState: 'instructed'
    readonly reason: string
    readonly tool: string | null
    readonly cli: Readonly<{ package: '@playwright/test'; version: string; argv: readonly string[]; sha256: string }> | null
}

export interface BrowserProjectClient {
    readonly package: '@playwright/test'
    readonly target: GuardSurfaceTarget
    readonly version: string
    readonly cwd: string
    readonly artifactRoot: string
    readonly node: Readonly<{ path: string; sha256: string; maxBytes: number }>
    readonly module: Readonly<{ path: string; sha256: string; maxBytes: number }>
    readonly manifest: Readonly<{ path: string; sha256: string; maxBytes: number }>
    readonly lock: Readonly<{ path: string; sha256: string; maxBytes: number }>
}

export interface BrowserProjectOperation {
    readonly kind: 'drive' | 'screenshot'
    readonly surface: Readonly<{ name: string; url: string }>
    readonly deadline: number
    readonly role?: string
    readonly output?: string
}

export interface BrowserProjectOperationAuthorization {
    readonly kind: 'browser-project-operation-authorization'
}

export interface BrowserProjectOperationAdmissionInput {
    readonly origin: string
    readonly role?: string
    readonly state?: Readonly<{ namespace: StateNamespace; stackId: StackId; ownerId: HolderId }>
}

const issuedClients = new WeakMap<BrowserProjectClient, BrowserRuntimeProjection>()
const issuedOperationAuthorizations = new WeakMap<object, {
    client: BrowserProjectClient
    runtime: BrowserRuntimeProjection
    origin: string
    role?: string
    statePath?: string
    active: boolean
    pending: Set<Promise<unknown>>
}>()

// Historical measurements seed spelling only; every current invocation still needs its paired control.
const MEASURED = {
    claudecode: { version: '2.1.220', date: '2026-08-25', tool: 'mcp__playwright__browser_navigate', cli: true },
    codexcli: { version: '0.149.0', date: '2026-08-25', tool: 'mcp__playwright__browser_navigate', cli: false },
    opencode: { version: '1.18.15', date: '2026-08-25', tool: 'playwright_browser_navigate', cli: true },
} as const

/** The harness version each target's browser transport spelling was measured at, for diagnostics. */
export function measuredBrowserHarnessVersions(): Readonly<Record<GuardSurfaceTarget, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(MEASURED).map(([target, row]) => [target, row.version])) as Record<GuardSurfaceTarget, string>)
}

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/).max(128)
const Asset = z.object({ bytes: z.string().max(65_536), sha256: Sha256 }).strict()
const NativePackage = z.object({
    directory: z.literal('node_modules/@playwright/test'),
    manifest: Asset,
    cli: Asset.extend({ path: GeneratedHostPath }).strict(),
}).strict()
const ProjectPackage = NativePackage.extend({
    artifactRoot: GeneratedHostPath,
    module: Asset.extend({ path: GeneratedHostPath }).strict(),
}).strict()
const Package = z.union([ProjectPackage, NativePackage])
const PackageObservation = z.object({
    cockpitDirectory: z.string().max(4096).refine(path => isAbsolute(path) && path !== '/' && resolve(path) === path && !/[\\\x00-\x1f\x7f]/.test(path)),
    artifactRoot: GeneratedHostPath,
}).strict()
const ProjectOperation = z.object({
    kind: z.enum(['drive', 'screenshot']),
    surface: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), url: z.string().max(4_096) }).strict(),
    deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    role: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
    output: z.string().max(4_096).optional(),
}).strict()
const Input = z.object({
    runtime: z.unknown(),
    cockpitDirectory: z.string().max(4096).refine(path => isAbsolute(path) && path !== '/' && resolve(path) === path && !/[\\\x00-\x1f\x7f]/.test(path)),
    harnesses: z.array(z.object({ target: z.enum(GUARD_SURFACE_TARGETS), version: Version }).strict()).min(1).max(GUARD_SURFACE_TARGETS.length)
        .refine(rows => new Set(rows.map(row => row.target)).size === rows.length),
    mcp: z.unknown(), approved: z.boolean(), testPackage: Package.nullable(), skillTemplate: z.string().max(16_384),
}).strict()
const Manifest = z.object({ name: z.literal('@playwright/test'), version: Version, bin: z.object({ playwright: GeneratedHostPath }) })
const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const MAX_SCREENSHOT_BYTES = 8_388_608
const COMMAND_TIMEOUT_MS = 30_000
function observedFile(path: string, maxBytes: number): Buffer {
    let descriptor: number | undefined
    try {
        if (realpathSync(path) !== path) throw new RefusalError('noncanonical path')
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = fstatSync(descriptor)
        if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new RefusalError('unbounded file')
        const buffer = Buffer.alloc(maxBytes + 1)
        let length = 0
        while (length < buffer.length) {
            const read = readSync(descriptor, buffer, length, buffer.length - length, null)
            if (read === 0) break
            length += read
        }
        const bytes = buffer.subarray(0, length)
        const after = fstatSync(descriptor)
        if (bytes.length > maxBytes || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new RefusalError('changed file')
        return bytes
    } catch { throw new RefusalError('browser test package file is missing, changed, noncanonical or exceeds its read bound') }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
}

function observedBytes(path: string, maxBytes: number): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(observedFile(path, maxBytes))
}

function projectPackagePaths(root: string, runtime: BrowserRuntimeProjection): Readonly<{
    projectManifestPath: string
    packageRoot: string
}> {
    if (!browserRuntimeExecutionReady(runtime)) throw new RefusalError('browser project package requires an issued executable runtime')
    const declaredManifest = runtime.runner.project.manifest
    const projectManifestPath = resolve(root, declaredManifest ?? 'package.json')
    if (!isPackageDescendant(root, projectManifestPath)) throw new RefusalError('browser project manifest escaped its cockpit root')
    if (declaredManifest !== undefined) {
        const manifestBytes = observedBytes(projectManifestPath, 1_048_576)
        if (digest(manifestBytes) !== runtime.runner.project.manifestSha256) {
            throw new RefusalError('browser declared project manifest differs from its issued identity')
        }
    }
    return Object.freeze({ projectManifestPath, packageRoot: resolve(dirname(projectManifestPath), 'node_modules/@playwright/test') })
}

export function observeBrowserProjectPackage(input: Readonly<{
    runtime: BrowserRuntimeProjection
    cockpitDirectory: string
    artifactRoot: string
}>): BrowserTestPackage {
    const captured = snapshotJson({ cockpitDirectory: input.cockpitDirectory, artifactRoot: input.artifactRoot })
    const parsed = PackageObservation.safeParse(captured)
    if (!parsed.success) throw new RefusalError('browser project package observation requires a canonical root and registered relative artifact root')
    const root = parsed.data.cockpitDirectory
    if (realpathSync(root) !== root) throw new RefusalError('browser project package root must be canonical')
    const directory = 'node_modules/@playwright/test' as const
    const { projectManifestPath, packageRoot } = projectPackagePaths(root, input.runtime)
    const manifestBytes = observedBytes(resolve(packageRoot, 'package.json'), 65_536)
    let manifest: unknown
    try { manifest = JSON.parse(manifestBytes) } catch { throw new RefusalError('browser test package manifest is invalid JSON') }
    const declared = Manifest.safeParse(manifest)
    if (!declared.success) throw new RefusalError('browser test package manifest is invalid')
    const cliAbsolute = resolve(packageRoot, declared.data.bin.playwright)
    if (!isPackageDescendant(packageRoot, cliAbsolute)) throw new RefusalError('browser test package CLI escaped its package root')
    let moduleAbsolute: string
    try { moduleAbsolute = realpathSync(createRequire(projectManifestPath).resolve('@playwright/test')) }
    catch { throw new RefusalError('browser project module entry could not be resolved') }
    if (!isPackageDescendant(packageRoot, moduleAbsolute)) throw new RefusalError('browser project module escaped its package root')
    const cliBytes = observedBytes(cliAbsolute, 65_536)
    const moduleBytes = observedBytes(moduleAbsolute, 65_536)
    return Object.freeze({ directory, artifactRoot: parsed.data.artifactRoot,
        manifest: Object.freeze({ bytes: manifestBytes, sha256: digest(manifestBytes) }),
        cli: Object.freeze({ path: relative(packageRoot, cliAbsolute), bytes: cliBytes, sha256: digest(cliBytes) }),
        module: Object.freeze({ path: relative(packageRoot, moduleAbsolute), bytes: moduleBytes, sha256: digest(moduleBytes) }) })
}

function file(target: GuardSurfaceTarget, path: string, bytes: string): RenderedSurfaceFile {
    return Object.freeze({ target, path, bytes, sha256: digest(bytes) })
}

function pinnedCli(value: z.infer<typeof Package> | null, runtime: BrowserRuntimeProjection, root: string): BrowserTransportRow['cli'] {
    if (value === null) return null
    let manifest: unknown
    try { manifest = JSON.parse(value.manifest.bytes) } catch { throw new RefusalError('browser test package manifest is invalid JSON') }
    const parsed = Manifest.safeParse(manifest)
    if (!parsed.success || parsed.data.version !== runtime.runner.project.driverVersion
        || value.cli.path !== parsed.data.bin.playwright || value.manifest.sha256 !== digest(value.manifest.bytes)
        || value.cli.sha256 !== digest(value.cli.bytes)) throw new RefusalError('browser test package does not match the pinned project driver and CLI bytes')
    const { packageRoot } = projectPackagePaths(root, runtime)
    if (observedBytes(resolve(packageRoot, 'package.json'), 65_536) !== value.manifest.bytes
        || observedBytes(resolve(packageRoot, value.cli.path), 65_536) !== value.cli.bytes) throw new RefusalError('browser test package differs from installed bytes')
    const lockBytes = observedBytes(resolve(root, runtime.runner.project.lockfile), 1_048_576)
    let lock: unknown
    try { lock = JSON.parse(lockBytes) } catch { throw new RefusalError('browser test package needs an authenticated npm lockfile') }
    const locked = z.object({ packages: z.record(z.string(), z.unknown()) }).safeParse(lock)
    const entry = locked.success ? z.object({ version: Version }).safeParse(locked.data.packages[value.directory]) : null
    if (digest(lockBytes) !== runtime.runner.project.sha256 || !entry?.success || entry.data.version !== parsed.data.version) {
        throw new RefusalError('browser test package differs from the issued project lock identity')
    }
    return Object.freeze({ package: '@playwright/test', version: parsed.data.version,
        argv: Object.freeze(['node', resolve(packageRoot, value.cli.path)]), sha256: value.cli.sha256 })
}

function projectClient(value: z.infer<typeof ProjectPackage>, row: Pick<BrowserTransportRow, 'target' | 'version'>,
    runtime: BrowserRuntimeProjection, root: string): BrowserProjectClient {
    if (value.artifactRoot !== runtime.generatedHostPaths[2]) throw new RefusalError('browser project client artifact root must be the registered CLI artifact root')
    const { projectManifestPath, packageRoot } = projectPackagePaths(root, runtime)
    let resolvedModule: string
    try { resolvedModule = realpathSync(createRequire(projectManifestPath).resolve('@playwright/test')) }
    catch { throw new RefusalError('browser project module entry could not be resolved') }
    const declaredModule = resolve(packageRoot, value.module.path)
    if (resolvedModule !== declaredModule || !isPackageDescendant(packageRoot, resolvedModule)
        || value.module.sha256 !== digest(value.module.bytes)
        || observedBytes(resolvedModule, 1_048_576) !== value.module.bytes) {
        throw new RefusalError('browser project module entry differs from the installed resolved entry')
    }
    const manifestPath = resolve(packageRoot, 'package.json')
    const lockPath = resolve(root, runtime.runner.project.lockfile)
    const nodePath = realpathSync(process.execPath)
    const nodeBytes = observedFile(nodePath, 536_870_912)
    const client = Object.freeze({
        package: '@playwright/test' as const, target: row.target, version: row.version, cwd: root,
        artifactRoot: resolve(root, value.artifactRoot),
        node: Object.freeze({ path: nodePath, sha256: createHash('sha256').update(nodeBytes).digest('hex'), maxBytes: nodeBytes.byteLength }),
        module: Object.freeze({ path: resolvedModule, sha256: value.module.sha256, maxBytes: 1_048_576 }),
        manifest: Object.freeze({ path: manifestPath, sha256: value.manifest.sha256, maxBytes: 65_536 }),
        lock: Object.freeze({ path: lockPath, sha256: runtime.runner.project.sha256, maxBytes: 1_048_576 }),
    })
    issuedClients.set(client, runtime)
    return client
}

export function authenticateBrowserProjectClient(value: unknown, runtime: BrowserRuntimeProjection): BrowserProjectClient | undefined {
    return value !== null && typeof value === 'object' && issuedClients.get(value as BrowserProjectClient) === runtime
        ? value as BrowserProjectClient : undefined
}

// Returns undefined for a path that is not a confined directory; a filesystem error is thrown for the caller to name.
function artifactDirectoryIdentity(path: string): FilesystemIdentity | undefined {
    const directory = lstatSync(path, { bigint: true })
    const parentPath = dirname(path)
    const parent = lstatSync(parentPath, { bigint: true })
    if (!directory.isDirectory() || directory.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
        || realpathSync(path) !== path || realpathSync(parentPath) !== parentPath) return undefined
    return Object.freeze({ ...filesystemObjectIdentity(directory),
        ancestors: Object.freeze([Object.freeze({ path: parentPath, ...filesystemObjectIdentity(parent) })]) })
}

function operationStatePath(runtime: BrowserRuntimeProjection, client: BrowserProjectClient, role: string | undefined): string | null | undefined {
    if (runtime.authentication.posture !== 'real') return role === undefined ? undefined : null
    if (role === undefined || runtime.authentication.policy === 'none') return null
    const state = runtime.authentication.states.find(candidate => candidate.worker === role)
    if (!state) return null
    const path = resolve(client.cwd, state.path)
    return path.startsWith(`${client.cwd}${sep}`) ? path : null
}

function operationStep(client: BrowserProjectClient, runtime: BrowserRuntimeProjection, operation: z.infer<typeof ProjectOperation>,
    remaining: number, origin: string, statePath: string | undefined, stateBytes: Buffer | undefined,
    artifactIdentity: FilesystemIdentity | undefined): ExecutionStep {
    const controlAuthorities = browserRuntimeControlAuthorities(runtime)
    const controlPorts = browserRuntimeControlPorts(runtime)
    if (!controlAuthorities || !controlPorts) throw new RefusalError('browser operation requires issued control authorities')
    const program = libexecProgram('browser-operation.cjs')
    // '--' ends Node's own options, so the program path can never be read as one.
    const argv = [client.node.path, '--', program.path, '--screenshot-limit', String(MAX_SCREENSHOT_BYTES),
        '--module-proof', client.module.path, '--module', client.module.path,
        '--manifest-proof', client.manifest.path, '--lock-proof', client.lock.path, '--operation', operation.kind,
        '--engine', runtime.server.engine, '--connection', runtime.connection.kind === 'remote' ? 'remote' : 'local',
        ...(runtime.connection.kind === 'remote' ? ['--endpoint', runtime.connection.endpoint, '--expose-network', runtime.networkExposure] : []),
        ...(runtime.connection.kind === 'local-fallback' && runtime.addressing.resolverRules
            ? ['--resolver-rule', runtime.addressing.resolverRules.join(',')] : []),
        '--control-authorities', JSON.stringify(controlAuthorities),
        '--control-ports', JSON.stringify(controlPorts),
        '--url', operation.surface.url, '--origin', origin, '--timeout', String(remaining),
        ...(statePath ? ['--state-proof', statePath] : []),
        ...(operation.output && artifactIdentity ? ['--output', operation.output, '--output-name', basename(operation.output),
            '--artifact-root', client.artifactRoot, '--artifact-dev', String(artifactIdentity.dev), '--artifact-ino', String(artifactIdentity.ino),
            '--artifact-birthtime-ns', artifactIdentity.birthtimeNs] : [])] as [string, ...string[]]
    const index = (value: string): number => argv.indexOf(value)
    const env: Readonly<Record<string, string>> = statePath ? { COCKPIT_BROWSER_STORAGE_STATE: statePath } : {}
    return Object.freeze({
        id: `browser-${operation.kind}-${operation.surface.name}`, argv: Object.freeze(argv), argv0: client.node.path,
        cwd: client.cwd, env: Object.freeze(env),
        timeoutMs: remaining, spawnNotAfter: new Date(operation.deadline).toISOString(), stdoutLimitBytes: 16_384, stderrLimitBytes: 16_384,
        paths: Object.freeze(operation.output ? [operation.output] : []), ports: Object.freeze([]),
        labels: Object.freeze({ browser: operation.kind }), expected: Object.freeze([]),
        consumedFiles: Object.freeze([
            { path: client.node.path, sha256: client.node.sha256, maxBytes: client.node.maxBytes, argvIndexes: Object.freeze([0]), executable: true as const, executionMode: 'verified-path' as const },
            { path: program.path, sha256: program.sha256, maxBytes: program.maxBytes, argvIndexes: Object.freeze([2]), executable: false as const },
            { path: client.module.path, sha256: client.module.sha256, maxBytes: client.module.maxBytes, argvIndexes: Object.freeze([index(client.module.path)]), executable: false as const },
            { path: client.manifest.path, sha256: client.manifest.sha256, maxBytes: client.manifest.maxBytes, argvIndexes: Object.freeze([index(client.manifest.path)]), executable: false as const },
            { path: client.lock.path, sha256: client.lock.sha256, maxBytes: client.lock.maxBytes, argvIndexes: Object.freeze([index(client.lock.path)]), executable: false as const },
            ...(statePath && stateBytes ? [{ path: statePath, sha256: digest(stateBytes), maxBytes: 1_048_576,
                argvIndexes: Object.freeze([index(statePath)]), executable: false as const }] : []),
        ]),
        filesystemChecks: Object.freeze([{ path: client.artifactRoot, expected: 'directory' as const,
            ...(artifactIdentity ? { identity: artifactIdentity } : {}) }]), compensation: Object.freeze([]),
    })
}

// A prerequisite the operation could not inspect; errorCause keeps the operation and path of a system
// error and only the class of anything else.
export type BrowserProjectOperationNotAdmitted = Readonly<{ kind: 'unadmitted'; cause: string }>

function notAdmitted(what: string, error: unknown): BrowserProjectOperationNotAdmitted {
    return Object.freeze({ kind: 'unadmitted', cause: `${what}: ${errorCause(error)}` })
}

export async function executeBrowserProjectOperation(client: BrowserProjectClient, runtime: BrowserRuntimeProjection,
    input: BrowserProjectOperation, authorization?: BrowserProjectOperationAuthorization): Promise<ExecuteProbeOutcome | BrowserProjectOperationNotAdmitted | undefined> {
    if (issuedClients.get(client) !== runtime) return undefined
    const admitted = authorization && issuedOperationAuthorizations.get(authorization)
    if (!admitted || admitted.client !== client || admitted.runtime !== runtime || admitted.active) return undefined
    const captured = snapshotJson(input)
    const parsed = ProjectOperation.safeParse(captured)
    if (!parsed.success) return undefined
    const operation = parsed.data
    const remaining = operation.deadline - Date.now()
    if (remaining <= 0 || remaining > COMMAND_TIMEOUT_MS) return undefined
    let url: URL
    // The surface address was already validated by the schema; the URL error would quote it, so the
    // caller's fixed not-admitted message stands.
    try { url = new URL(operation.surface.url) } catch { return undefined }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.origin !== admitted.origin
        || operation.role !== admitted.role) return undefined
    const statePath = admitted.statePath
    const screenshot = operation.kind === 'screenshot'
    if (screenshot !== (operation.output !== undefined)) return undefined
    let artifactIdentity: FilesystemIdentity | undefined
    if (screenshot) {
        try { artifactIdentity = artifactDirectoryIdentity(client.artifactRoot) } catch (error) { return notAdmitted('the screenshot artifact root could not be inspected', error) }
    }
    if (screenshot && (!artifactIdentity || dirname(operation.output!) !== client.artifactRoot
        || !/^screenshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/.test(basename(operation.output!)))) return undefined
    // The revalidation throws only its own fixed-text TypeError, whose class says nothing the caller's
    // refusal does not, so the admission is simply withheld.
    try { assertBrowserStorageStateCurrent(runtime) } catch { return undefined }
    let stateBytes: Buffer | undefined
    try { stateBytes = statePath ? observedFile(statePath, 1_048_576) : undefined } catch (error) { return notAdmitted('the seeded storage state could not be read', error) }
    const step = operationStep(client, runtime, operation, remaining, admitted.origin, statePath, stateBytes, artifactIdentity)
    try { assertBrowserStorageStateCurrent(runtime) } catch { return undefined } // fixed-text TypeError, as above
    admitted.active = true
    const pending = executeProbe(step).then(outcome => authenticatedExecutionOutcome(outcome, step))
    admitted.pending.add(pending)
    try { return await pending }
    finally { admitted.pending.delete(pending); admitted.active = false }
}

type BrowserProjectOperationAdmissionResult<T> = Readonly<{ kind: 'admitted'; value: T }> | Readonly<{ kind: 'refusal'; reason: string }>

function currentCoordination(record: StateRecord | null, stackId: StackId, ownerId: HolderId): boolean {
    if (!record || record.kind !== 'coordination' || record.subjectId !== stackId || !record.value || typeof record.value !== 'object') return false
    const holders = (record.value as { holders?: unknown }).holders
    return Array.isArray(holders) && holders.some(holder => holder && typeof holder === 'object' && (holder as { holderId?: unknown }).holderId === ownerId)
}

export async function withBrowserProjectOperationAdmission<T>(client: BrowserProjectClient, runtime: BrowserRuntimeProjection,
    input: BrowserProjectOperationAdmissionInput,
    operation: (authorization: BrowserProjectOperationAuthorization) => Promise<T>): Promise<BrowserProjectOperationAdmissionResult<T>> {
    if (issuedClients.get(client) !== runtime || typeof operation !== 'function' || !input || typeof input !== 'object' || isProxy(input)) {
        return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires an issued project client and closed authority' })
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const allowed = new Set(['origin', 'role', 'state'])
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key))
        || !descriptors.origin || !('value' in descriptors.origin)
        || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) {
        return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires an issued project client and closed authority' })
    }
    const captured = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as {
        origin: unknown
        role?: unknown
        state?: unknown
    }
    let state: BrowserProjectOperationAdmissionInput['state']
    if (captured.state !== undefined) {
        if (!captured.state || typeof captured.state !== 'object' || isProxy(captured.state)) {
            return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires closed coordination authority' })
        }
        const stateDescriptors = Object.getOwnPropertyDescriptors(captured.state)
        if (Object.keys(stateDescriptors).sort().join(',') !== 'namespace,ownerId,stackId'
            || Object.values(stateDescriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) {
            return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires closed coordination authority' })
        }
        const values = Object.fromEntries(Object.entries(stateDescriptors).map(([key, descriptor]) => [key, descriptor.value]))
        if (!values.namespace || typeof values.namespace !== 'object' || isProxy(values.namespace)
            || typeof values.stackId !== 'string' || typeof values.ownerId !== 'string') {
            return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires closed coordination authority' })
        }
        state = Object.freeze({ namespace: values.namespace as StateNamespace, stackId: values.stackId as StackId, ownerId: values.ownerId as HolderId })
    }
    let origin: URL
    // The URL error quotes the caller's origin; the refusal below names the expected shape instead.
    try { origin = new URL(captured.origin as string) } catch {
        return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires an issued HTTP application origin' })
    }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/'
        || origin.search || origin.hash || origin.origin !== captured.origin) {
        return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires an issued HTTP application origin' })
    }
    const controlAuthorities = browserRuntimeControlAuthorities(runtime)
    const controlPorts = browserRuntimeControlPorts(runtime)
    const originPort = Number(origin.port || (origin.protocol === 'http:' ? '80' : '443'))
    if (!controlAuthorities || !controlPorts || controlAuthorities.includes(origin.host) || controlPorts.includes(originPort)) {
        return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission refuses the browser-control proxy authority' })
    }
    const auth = runtime.authentication
    const role = typeof captured.role === 'string' ? captured.role : undefined
    const statePath = operationStatePath(runtime, client, role)
    if (statePath === null || captured.role !== undefined && role === undefined
        || auth.posture !== 'real' && (role !== undefined || state !== undefined)
        || auth.posture === 'real' && (role === undefined || auth.policy === 'none')
        || auth.posture === 'real' && state === undefined) {
        return Object.freeze({ kind: 'refusal', reason: 'Browser operation admission requires current declared authentication authority' })
    }
    const invoke = async (): Promise<BrowserProjectOperationAdmissionResult<T>> => {
        // Only the runtime's fixed-text TypeError escapes the revalidation; the refusal names the condition.
        try { assertBrowserStorageStateCurrent(runtime) } catch {
            return Object.freeze({ kind: 'refusal', reason: 'Browser seeded state changed before operation dispatch' })
        }
        const authorization = Object.freeze({ kind: 'browser-project-operation-authorization' as const })
        const authorizationState = { client, runtime, origin: origin.origin, ...(role ? { role } : {}),
            ...(statePath ? { statePath } : {}), active: false, pending: new Set<Promise<unknown>>() }
        issuedOperationAuthorizations.set(authorization, authorizationState)
        try {
            const value = await operation(authorization)
            return Object.freeze({ kind: 'admitted' as const, value })
        } finally {
            issuedOperationAuthorizations.delete(authorization)
            await Promise.allSettled([...authorizationState.pending])
        }
    }
    if (auth.posture !== 'real') return invoke()
    const binding = browserRuntimeCoordination(runtime)
    const namespace = authenticateStateNamespace(state?.namespace)
    if (!binding || !namespace || !state || namespace !== binding.namespace || state.stackId !== binding.stackId) {
        return Object.freeze({ kind: 'refusal', reason: 'Browser authentication refuses coordination authority from a different runtime stack' })
    }
    const address = binding.namespace.paths.coordination(binding.stackId)
    if (auth.policy === 'per-worker') {
        const scope = issueStateScopedLock(namespace, { owner: 'browser-worker', identity: digest(`${binding.stackId}\0${role!}`) })
        if (!scope) return Object.freeze({ kind: 'refusal', reason: 'Per-worker browser authentication could not issue its canonical worker claim' })
        const locked = await withStateScopedLock(namespace, scope, { ownerId: state.ownerId, contentionTimeoutMs: 0 }, async () => {
            const before = await readState(address)
            if (before.kind !== 'complete' || !currentCoordination(before.value, binding.stackId, state.ownerId)) {
                return Object.freeze({ kind: 'refusal' as const, reason: 'Per-worker browser authentication requires the current coordination record and owner' })
            }
            const admitted = await invoke()
            const after = await readState(address)
            return after.kind === 'complete' && after.value.revision === before.value.revision
                && currentCoordination(after.value, binding.stackId, state.ownerId)
                ? admitted
                : Object.freeze({ kind: 'refusal' as const, reason: 'Per-worker browser coordination changed during the operation' })
        })
        const detail = locked.kind === 'refusal' ? `: ${locked.message} [${locked.target}]${locked.recovery ? `; ${locked.recovery}` : ''}` : ''
        return locked.kind === 'complete' ? locked.value : Object.freeze({ kind: 'refusal', reason: (locked.kind === 'refusal' && locked.code.endsWith('LOCKED')
            ? 'Per-worker browser authentication refused because its canonical worker claim is contended'
            : 'Per-worker browser authentication could not authenticate its canonical worker claim') + detail })
    }
    const locked = await transactState<BrowserProjectOperationAdmissionResult<T>>(namespace, address,
        { ownerId: state.ownerId, contentionTimeoutMs: 0 }, async current => abortStateTransaction(
            currentCoordination(current, binding.stackId, state!.ownerId)
                ? await invoke()
                : Object.freeze({ kind: 'refusal' as const, reason: 'Serialized browser authentication requires the current coordination record and owner' }),
        ))
    if ('aborted' in locked) return locked.value
    const detail = locked.kind === 'refusal' ? `: ${locked.message} [${locked.target}]${locked.recovery ? `; ${locked.recovery}` : ''}` : ''
    return Object.freeze({ kind: 'refusal', reason: (locked.kind === 'refusal' && locked.code.endsWith('LOCKED')
        ? 'Serialized browser authentication refused because the canonical state lock is contended'
        : 'Serialized browser authentication could not authenticate the canonical coordination state') + detail })
}

function nativeMcp(target: GuardSurfaceTarget, command: string, args: readonly string[]): RenderedSurfaceFile {
    if (target === 'claudecode') return file(target, '.mcp.json', JSON.stringify({ mcpServers: { playwright: { command, args } } }, null, 2) + '\n')
    if (target === 'opencode') return file(target, 'opencode.jsonc', JSON.stringify({ mcp: { playwright: { type: 'local', command: [command, ...args], enabled: true } } }, null, 2) + '\n')
    return file(target, '.codex/config.toml', `[mcp_servers.playwright]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenabled = true\ndefault_tools_approval_mode = "approve"\n`)
}

function renderSkill(template: string, target: GuardSurfaceTarget, rows: readonly BrowserTransportRow[], runtime: BrowserRuntimeProjection): RenderedSurfaceFile {
    if (template.split('{{browser}}').length !== 2 || /{{|}}/.test(template.replace('{{browser}}', ''))
        || !template.startsWith('---\nname: cockpit-browser\n') || /^(?:allowed-tools|tools|disallowedTools):/m.test(template)) {
        throw new RefusalError('browser skill template must contain one browser marker and retain browser tools')
    }
    const auth = runtime.authentication.posture !== 'real'
        ? `Sign-in and persona selection are inapplicable: ${runtime.authentication.posture === 'none' ? 'the product has no sign-in' : 'authentication is bypassed'}.`
        : `Use mode-600 stored state from seeded users with transcript-safe sign-in; never print credentials or state contents. The active state policy is ${runtime.authentication.policy}.`
    const addressing = runtime.addressing.posture === 'port' ? 'Browser resolver rules: inapplicable for port addressing.'
        : runtime.connection.kind === 'remote'
            ? `The generated runner resolves application names on the host, so its browser opens the same URLs a person does; the resolver rules (${runtime.addressing.resolverRules!.join('; ')}) apply only to the headed debugger.`
            : `Apply browser resolver rules: ${runtime.addressing.resolverRules!.join('; ')}.`
    const transports = rows.map(row => `${row.transport}: ${row.declaration}; callable: ${row.callable}; harness: ${target} ${row.version}; historical measurement: ${row.measuredVersion} on ${row.measuredOn}. ${row.reason}${row.tool ? ` Tool: ${row.tool}.` : ''}${row.cli ? ` Pinned CLI argv: ${JSON.stringify(row.cli.argv)}; package: ${row.cli.package} ${row.cli.version}.` : ''}`)
    const guidance = [
        '# Drive the application', ...transports, auth, addressing,
        'Use the declared shared headless browser connection. A headed debugger is an explicit separate escape hatch.',
        'Prefer the eligible pinned CLI for identity-sensitive or concurrent work; keep the declared per-worker or serialized state policy.',
        'Retain browser access for the independent grader. File read-only controls do not restrain product state; product-state restraint remains instructed.',
        'Read the browser reference before sign-in, artifact cleanup, or a paired native probe. Current callable rows remain held for operator measurement.',
    ].join('\n\n')
    const prefix = target === 'claudecode' ? '.claude' : target === 'codexcli' ? '.agents' : '.opencode'
    return file(target, `${prefix}/skills/cockpit-browser/SKILL.md`, template.replace('{{browser}}', () => guidance))
}

export function renderBrowserSurfaces(input: BrowserSurfaceInput) {
    const captured = snapshotJson(input)
    if (captured === undefined) throw new RefusalError('browser surfaces require bounded plain data without accessors')
    const parsed = Input.safeParse(captured)
    if (!parsed.success) throw new RefusalError('browser surfaces require canonical harness, test package and template data')
    const data = parsed.data
    const runtime = input.runtime
    assertBrowserStorageStateCurrent(runtime)
    if (!browserRuntimeExecutionReady(runtime)) throw new RefusalError('remote browser surfaces require an authenticated retained port lease')
    const cli = pinnedCli(data.testPackage, runtime, data.cockpitDirectory)
    // `approved` says the caller matched the declared server against [mcp.approved]; this one may carry a bound endpoint.
    const approval = { playwright: mcpApprovalDigest(data.mcp as McpDeclaration, data.cockpitDirectory) }
    const collected = collectMcpDeclarations({ cockpitDirectory: data.cockpitDirectory, declarations: [data.mcp],
        approved: data.approved ? approval : {}, targets: data.harnesses.map(row => row.target) })
    if (collected.kind !== 'complete') throw new RefusalError(`browser MCP declaration refused: ${collected.diagnostic.code}`)
    const server = collected.result.servers[0]!
    if (server.name !== 'playwright') throw new RefusalError('browser MCP declaration must be the playwright server')
    if (server.cwd !== data.cockpitDirectory) {
        throw new RefusalError('the playwright MCP declaration must come from a sibling whose dir is the cockpit directory itself (dir = "."), so the server starts there')
    }
    if (!server.args.includes(runtime.mcp.image)) {
        throw new RefusalError(`the playwright MCP server's arguments must include browser.images.mcp.reference (${runtime.mcp.image})`)
    }
    if (runtime.connection.kind === 'remote' && !server.args.includes(runtime.connection.endpoint)) {
        throw new RefusalError('the playwright MCP server\'s arguments must include the bound browser endpoint')
    }
    const rows: BrowserTransportRow[] = []
    const files: RenderedSurfaceFile[] = []
    for (const harness of data.harnesses) {
        const measured = MEASURED[harness.target]
        for (const transport of ['mcp', 'cli'] as const) {
            let reason = 'Declaration only; current paired native invocation is required.'
            let available = harness.version === measured.version
            if (!available) reason = 'Harness version has no measured transport spelling.'
            else if (runtime.connection.kind !== 'remote') { available = false; reason = 'Native transports require a declared remote browser endpoint; application commands use the local project client.' }
            else if (transport === 'cli' && !measured.cli) { available = false; reason = 'Browser CLI is unavailable under the measured workspace sandbox.' }
            else if (transport === 'cli' && cli === null) { available = false; reason = 'Pinned test package CLI identity is unavailable.' }
            else if (transport === 'mcp' && !server.enabled) { available = false; reason = 'Browser MCP server is absent from shared approval.' }
            else if (transport === 'mcp' && harness.target === 'codexcli' && runtime.preapproval !== 'eligible') {
                available = false; reason = 'Measured MCP transport requires approval that this data posture does not authorize.'
            }
            rows.push(Object.freeze({ target: harness.target, version: harness.version, transport,
                measuredOn: measured.date, measuredVersion: measured.version, declaration: available ? 'instructed' : 'unavailable',
                callable: available ? 'human_needed' : 'unavailable', productState: 'instructed', reason,
                tool: available && transport === 'mcp' ? measured.tool : null, cli: available && transport === 'cli' ? cli : null }))
        }
        const ownRows = rows.filter(row => row.target === harness.target)
        if (ownRows.every(row => row.declaration === 'unavailable')) continue
        if (ownRows.some(row => row.transport === 'mcp' && row.declaration === 'instructed')) {
            const native = collected.result.harnesses.find(row => row.target === harness.target)!.servers[0]!
            files.push(nativeMcp(harness.target, native.command, native.args))
        }
        files.push(renderSkill(data.skillTemplate, harness.target, ownRows, runtime))
    }
    const targets = rows.filter(row => row.transport === 'mcp' && row.declaration === 'instructed').map(row => row.target)
    const mcp = collectMcpDeclarations({ cockpitDirectory: data.cockpitDirectory, declarations: targets.length ? [data.mcp] : [],
        approved: targets.length ? approval : {}, targets: targets.length ? targets : data.harnesses.map(row => row.target) })
    if (mcp.kind !== 'complete') throw new RefusalError(`browser MCP collection refused: ${mcp.diagnostic.code}`)
    const projectPackage = data.testPackage !== null && 'artifactRoot' in data.testPackage && 'module' in data.testPackage
        ? data.testPackage as z.infer<typeof ProjectPackage> : null
    const clients = projectPackage === null || cli === null ? [] : data.harnesses
        .filter(harness => harness.version === MEASURED[harness.target].version)
        .map(harness => projectClient(projectPackage, harness, runtime, data.cockpitDirectory))
    return Object.freeze({ rows: Object.freeze(rows), files: Object.freeze(files), mcp,
        clients: Object.freeze(clients), graderBrowserAccess: 'retained' as const })
}

