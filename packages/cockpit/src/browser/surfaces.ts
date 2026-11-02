import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { z } from 'zod'
import { filesystemObjectIdentity, isCanonicalTimestamp, snapshotJson, type ExecutionStep, type FilesystemIdentity, type HolderId, type StackId } from '../environment/contract.js'
import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { libexecProgram } from '../environment-exec/libexec-program.js'
import { abortStateTransaction, authenticateStateNamespace, issueStateScopedLock, readState, transactState, withStateScopedLock,
    type StateNamespace, type StateRecord } from '../environment/state.js'
import { GeneratedHostPath } from '../schema.js'
import type { RenderedSurfaceFile } from '../surfaces/contract.js'
import { GUARD_SURFACE_TARGETS, type GuardSurfaceTarget } from '../surfaces/harness-registry.js'
import { collectMcpDeclarations, type McpDeclaration } from '../surfaces/mcp.js'
import { isPackageDescendant } from './package-paths.js'
import { assertBrowserArtifactRegistration, assertBrowserStorageStateCurrent, browserRuntimeControlAuthorities, browserRuntimeControlPorts, browserRuntimeCoordination, browserRuntimeExecutionReady, type BrowserRuntimeProjection } from './runtime.js'

export const mechanism = {
    id: 'browser-surfaces',
    module: 'packages/cockpit/src/browser/surfaces.ts',
    exports: ['authenticateBrowserProjectClient', 'executeBrowserProjectOperation', 'observeBrowserProjectPackage', 'renderBrowserSurfaces', 'validateBrowserNativeReceipt', 'withBrowserProjectOperationAdmission'],
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
    readonly kind: 'drive' | 'accessibility' | 'screenshot'
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

export interface BrowserNativeProbe {
    readonly target: GuardSurfaceTarget
    readonly transport: 'mcp' | 'cli'
    readonly version: string
    readonly status: 'human_needed'
    readonly subjectSha256: string
    readonly rendered: readonly Readonly<{ path: string; sha256: string }>[]
    readonly candidate: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly brokenControl: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly versionArgv: readonly string[]
    readonly transportVersionArgv: readonly string[] | null
    readonly transportHelpArgv: readonly (readonly string[])[] | null
    readonly cockpitDirectory: string
    readonly transportIdentity: Readonly<{ kind: 'test-package'; path: string; sha256: string; version: string;
        manifest: Readonly<{ path: string; sha256: string }>; lock: Readonly<{ path: string; sha256: string }> }>
        | Readonly<{ kind: 'mcp-image'; image: string; endpoint: string }>
    readonly harnessCwd: string
    readonly resetArgv: readonly ['cockpit', 'reset', '--config', string, '--interactive']
    readonly invocation: Readonly<{ kind: 'mcp'; tool: string; arguments: Readonly<{ url: 'about:blank' }>; declarationPath: string }>
        | Readonly<{ kind: 'cli'; prepareArgv: readonly string[]; argv: readonly string[]; cleanupArgv: readonly string[] }>
    readonly brokenInvocation: BrowserNativeProbe['invocation']
    readonly bounds: Readonly<{ timeoutMs: 30_000; outputBytes: 16_384; receiptBytes: 65_536 }>
    readonly artifactRoots: readonly string[]
}

const issuedProbes = new WeakMap<BrowserNativeProbe, BrowserRuntimeProjection>()
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
    kind: z.enum(['drive', 'accessibility', 'screenshot']),
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
const MAX_ARIA_BYTES = 65_536
const MAX_SCREENSHOT_BYTES = 8_388_608
const COMMAND_TIMEOUT_MS = 30_000
function observedFile(path: string, maxBytes: number): Buffer {
    let descriptor: number | undefined
    try {
        if (realpathSync(path) !== path) throw new TypeError('noncanonical path')
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = fstatSync(descriptor)
        if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new TypeError('unbounded file')
        const buffer = Buffer.alloc(maxBytes + 1)
        let length = 0
        while (length < buffer.length) {
            const read = readSync(descriptor, buffer, length, buffer.length - length, null)
            if (read === 0) break
            length += read
        }
        const bytes = buffer.subarray(0, length)
        const after = fstatSync(descriptor)
        if (bytes.length > maxBytes || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new TypeError('changed file')
        return bytes
    } catch { throw new TypeError('browser test package file is missing, changed, noncanonical or exceeds its read bound') }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
}

function observedBytes(path: string, maxBytes: number): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(observedFile(path, maxBytes))
}

function projectPackagePaths(root: string, runtime: BrowserRuntimeProjection): Readonly<{
    projectManifestPath: string
    packageRoot: string
}> {
    if (!browserRuntimeExecutionReady(runtime)) throw new TypeError('browser project package requires an issued executable runtime')
    const declaredManifest = runtime.runner.project.manifest
    const projectManifestPath = resolve(root, declaredManifest ?? 'package.json')
    if (!isPackageDescendant(root, projectManifestPath)) throw new TypeError('browser project manifest escaped its cockpit root')
    if (declaredManifest !== undefined) {
        const manifestBytes = observedBytes(projectManifestPath, 1_048_576)
        if (digest(manifestBytes) !== runtime.runner.project.manifestSha256) {
            throw new TypeError('browser declared project manifest differs from its issued identity')
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
    if (!parsed.success) throw new TypeError('browser project package observation requires a canonical root and registered relative artifact root')
    const root = parsed.data.cockpitDirectory
    if (realpathSync(root) !== root) throw new TypeError('browser project package root must be canonical')
    const directory = 'node_modules/@playwright/test' as const
    const { projectManifestPath, packageRoot } = projectPackagePaths(root, input.runtime)
    const manifestBytes = observedBytes(resolve(packageRoot, 'package.json'), 65_536)
    let manifest: unknown
    try { manifest = JSON.parse(manifestBytes) } catch { throw new TypeError('browser test package manifest is invalid JSON') }
    const declared = Manifest.safeParse(manifest)
    if (!declared.success) throw new TypeError('browser test package manifest is invalid')
    const cliAbsolute = resolve(packageRoot, declared.data.bin.playwright)
    if (!isPackageDescendant(packageRoot, cliAbsolute)) throw new TypeError('browser test package CLI escaped its package root')
    let moduleAbsolute: string
    try { moduleAbsolute = realpathSync(createRequire(projectManifestPath).resolve('@playwright/test')) }
    catch { throw new TypeError('browser project module entry could not be resolved') }
    if (!isPackageDescendant(packageRoot, moduleAbsolute)) throw new TypeError('browser project module escaped its package root')
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
    try { manifest = JSON.parse(value.manifest.bytes) } catch { throw new TypeError('browser test package manifest is invalid JSON') }
    const parsed = Manifest.safeParse(manifest)
    if (!parsed.success || parsed.data.version !== runtime.runner.project.driverVersion
        || value.cli.path !== parsed.data.bin.playwright || value.manifest.sha256 !== digest(value.manifest.bytes)
        || value.cli.sha256 !== digest(value.cli.bytes)) throw new TypeError('browser test package does not match the pinned project driver and CLI bytes')
    const { packageRoot } = projectPackagePaths(root, runtime)
    if (observedBytes(resolve(packageRoot, 'package.json'), 65_536) !== value.manifest.bytes
        || observedBytes(resolve(packageRoot, value.cli.path), 65_536) !== value.cli.bytes) throw new TypeError('browser test package differs from installed bytes')
    const lockBytes = observedBytes(resolve(root, runtime.runner.project.lockfile), 1_048_576)
    let lock: unknown
    try { lock = JSON.parse(lockBytes) } catch { throw new TypeError('browser test package needs an authenticated npm lockfile') }
    const locked = z.object({ packages: z.record(z.string(), z.unknown()) }).safeParse(lock)
    const entry = locked.success ? z.object({ version: Version }).safeParse(locked.data.packages[value.directory]) : null
    if (digest(lockBytes) !== runtime.runner.project.sha256 || !entry?.success || entry.data.version !== parsed.data.version) {
        throw new TypeError('browser test package differs from the issued project lock identity')
    }
    return Object.freeze({ package: '@playwright/test', version: parsed.data.version,
        argv: Object.freeze(['node', resolve(packageRoot, value.cli.path)]), sha256: value.cli.sha256 })
}

function projectClient(value: z.infer<typeof ProjectPackage>, row: Pick<BrowserTransportRow, 'target' | 'version'>,
    runtime: BrowserRuntimeProjection, root: string): BrowserProjectClient {
    if (value.artifactRoot !== runtime.generatedHostPaths[2]) throw new TypeError('browser project client artifact root must be the registered CLI artifact root')
    const { projectManifestPath, packageRoot } = projectPackagePaths(root, runtime)
    let resolvedModule: string
    try { resolvedModule = realpathSync(createRequire(projectManifestPath).resolve('@playwright/test')) }
    catch { throw new TypeError('browser project module entry could not be resolved') }
    const declaredModule = resolve(packageRoot, value.module.path)
    if (resolvedModule !== declaredModule || !isPackageDescendant(packageRoot, resolvedModule)
        || value.module.sha256 !== digest(value.module.bytes)
        || observedBytes(resolvedModule, 1_048_576) !== value.module.bytes) {
        throw new TypeError('browser project module entry differs from the installed resolved entry')
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

function artifactDirectoryIdentity(path: string): FilesystemIdentity | undefined {
    try {
        const directory = lstatSync(path, { bigint: true })
        const parentPath = dirname(path)
        const parent = lstatSync(parentPath, { bigint: true })
        if (!directory.isDirectory() || directory.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
            || realpathSync(path) !== path || realpathSync(parentPath) !== parentPath) return undefined
        return Object.freeze({ ...filesystemObjectIdentity(directory),
            ancestors: Object.freeze([Object.freeze({ path: parentPath, ...filesystemObjectIdentity(parent) })]) })
    } catch { return undefined }
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
    if (!controlAuthorities || !controlPorts) throw new TypeError('browser operation requires issued control authorities')
    const program = libexecProgram('browser-operation.cjs')
    // '--' ends Node's own options, so the program path can never be read as one.
    const argv = [client.node.path, '--', program.path, '--aria-limit', String(MAX_ARIA_BYTES), '--screenshot-limit', String(MAX_SCREENSHOT_BYTES),
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

export async function executeBrowserProjectOperation(client: BrowserProjectClient, runtime: BrowserRuntimeProjection,
    input: BrowserProjectOperation, authorization?: BrowserProjectOperationAuthorization): Promise<ExecuteProbeOutcome | undefined> {
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
    try { url = new URL(operation.surface.url) } catch { return undefined }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.origin !== admitted.origin
        || operation.role !== admitted.role) return undefined
    const statePath = admitted.statePath
    const screenshot = operation.kind === 'screenshot'
    if (screenshot !== (operation.output !== undefined)) return undefined
    const artifactIdentity = screenshot ? artifactDirectoryIdentity(client.artifactRoot) : undefined
    if (screenshot && (!artifactIdentity || dirname(operation.output!) !== client.artifactRoot
        || !/^screenshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/.test(basename(operation.output!)))) return undefined
    try { assertBrowserStorageStateCurrent(runtime) } catch { return undefined }
    let stateBytes: Buffer | undefined
    try { stateBytes = statePath ? observedFile(statePath, 1_048_576) : undefined } catch { return undefined }
    const step = operationStep(client, runtime, operation, remaining, admitted.origin, statePath, stateBytes, artifactIdentity)
    try { assertBrowserStorageStateCurrent(runtime) } catch { return undefined }
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
        throw new TypeError('browser skill template must contain one browser marker and retain browser tools')
    }
    const auth = runtime.authentication.posture !== 'real'
        ? `Sign-in and persona selection are inapplicable: ${runtime.authentication.posture === 'none' ? 'the product has no sign-in' : 'authentication is bypassed'}.`
        : `Use mode-600 stored state from seeded users with transcript-safe sign-in; never print credentials or state contents. The active state policy is ${runtime.authentication.policy}.`
    const addressing = runtime.addressing.posture === 'port' ? 'Browser resolver rules: inapplicable for port addressing.'
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

function nativeProbe(row: BrowserTransportRow, files: readonly RenderedSurfaceFile[], wrappers: readonly Readonly<{ path: string; sha256: string }>[], runtime: BrowserRuntimeProjection, packageSha256: string | null, cockpitDirectory: string): BrowserNativeProbe {
    if (runtime.connection.kind !== 'remote') throw new TypeError('browser native transport probes require an issued remote endpoint')
    const endpoint = runtime.connection.endpoint
    const native = files.find(file => file.target === row.target && !file.path.endsWith('/SKILL.md'))
    const root = runtime.generatedHostPaths[row.transport === 'mcp' ? 1 : 2]!
    const path = `${root}/${row.target}/${row.transport === 'cli' ? 'config.json' : native!.path}`
    const bytes = row.transport === 'cli' ? '{}\n' : native!.bytes
    const candidate = { path, bytes, sha256: digest(bytes) }
    const brokenBytes = row.target === 'codexcli' ? '[\n' : '{\n'
    const brokenControl = { path: `${dirname(path)}/broken-control.${path.endsWith('.toml') ? 'toml' : 'json'}`, bytes: brokenBytes, sha256: digest(brokenBytes) }
    const rendered = [...files.filter(file => file.target === row.target), ...wrappers].map(file => ({ path: file.path, sha256: file.sha256 }))
    const argv = row.cli ? [...row.cli.argv, 'cli'] : []
    const session = `--session=cockpit-${row.target}-probe`
    const invocation: BrowserNativeProbe['invocation'] = row.transport === 'mcp'
        ? { kind: 'mcp', tool: row.tool!, arguments: { url: 'about:blank' }, declarationPath: path }
        : { kind: 'cli', prepareArgv: [...argv, 'attach', `--endpoint=${endpoint}`, session, `--config=${path}`],
            argv: [...argv, session, 'goto', 'about:blank'], cleanupArgv: [...argv, session, 'close'] }
    const brokenInvocation: BrowserNativeProbe['invocation'] = invocation.kind === 'mcp'
        ? { ...invocation, declarationPath: brokenControl.path }
        : { ...invocation, prepareArgv: [], argv: invocation.prepareArgv.map(arg => arg === `--config=${path}` ? `--config=${brokenControl.path}` : arg) }
    const packageManifestPath = resolve(projectPackagePaths(cockpitDirectory, runtime).packageRoot, 'package.json')
    const probe = snapshotJson({ target: row.target, transport: row.transport, version: row.version, status: 'human_needed',
        subjectSha256: digest(JSON.stringify({ row, runtime, rendered, packageSha256 })), rendered, candidate, brokenControl,
        versionArgv: [row.target === 'claudecode' ? 'claude' : row.target === 'codexcli' ? 'codex' : 'opencode', '--version'],
        transportVersionArgv: row.transport === 'cli' ? [...row.cli!.argv, '--version'] : null,
        transportHelpArgv: row.transport === 'cli' ? [[...row.cli!.argv, 'cli', '--help'], [...row.cli!.argv, 'cli', 'attach', '--help']] : null, cockpitDirectory,
        transportIdentity: row.transport === 'cli'
            ? { kind: 'test-package', path: row.cli!.argv[1], sha256: row.cli!.sha256, version: row.cli!.version,
                manifest: { path: packageManifestPath, sha256: packageSha256! },
                lock: { path: resolve(cockpitDirectory, runtime.runner.project.lockfile), sha256: runtime.runner.project.sha256 } }
            : { kind: 'mcp-image', image: runtime.mcp.image, endpoint },
        harnessCwd: `${root}/${row.target}`,
        resetArgv: ['cockpit', 'reset', '--config', runtime.configurationPath, '--interactive'],
        invocation, brokenInvocation, bounds: { timeoutMs: 30_000, outputBytes: 16_384, receiptBytes: 65_536 }, artifactRoots: runtime.generatedHostPaths,
    }) as unknown as BrowserNativeProbe
    issuedProbes.set(probe, runtime)
    return probe
}

export function renderBrowserSurfaces(input: BrowserSurfaceInput) {
    const captured = snapshotJson(input)
    if (captured === undefined) throw new TypeError('browser surfaces require bounded plain data without accessors')
    const parsed = Input.safeParse(captured)
    if (!parsed.success) throw new TypeError('browser surfaces require canonical harness, test package and template data')
    const data = parsed.data
    const runtime = input.runtime
    assertBrowserStorageStateCurrent(runtime)
    if (!browserRuntimeExecutionReady(runtime)) throw new TypeError('remote browser surfaces require an authenticated retained port lease')
    const cli = pinnedCli(data.testPackage, runtime, data.cockpitDirectory)
    const collected = collectMcpDeclarations({ cockpitDirectory: data.cockpitDirectory, declarations: [data.mcp],
        approved: data.approved ? ['playwright'] : [], targets: data.harnesses.map(row => row.target) })
    if (collected.kind !== 'complete') throw new TypeError(`browser MCP declaration refused: ${collected.diagnostic.code}`)
    const server = collected.result.servers[0]!
    if (server.name !== 'playwright' || server.cwd !== data.cockpitDirectory
        || !server.args.includes(runtime.mcp.image)
        || runtime.connection.kind === 'remote' && !server.args.includes(runtime.connection.endpoint)) {
        throw new TypeError('browser MCP declaration must bind the issued image, endpoint and working directory')
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
        approved: targets.length ? ['playwright'] : [], targets: targets.length ? targets : data.harnesses.map(row => row.target) })
    if (mcp.kind !== 'complete') throw new TypeError(`browser MCP collection refused: ${mcp.diagnostic.code}`)
    const probes = rows.filter(row => row.declaration === 'instructed').map(row => nativeProbe(row, files, mcp.result.wrappers, runtime, data.testPackage?.manifest.sha256 ?? null, data.cockpitDirectory))
    const projectPackage = data.testPackage !== null && 'artifactRoot' in data.testPackage && 'module' in data.testPackage
        ? data.testPackage as z.infer<typeof ProjectPackage> : null
    const clients = projectPackage === null || cli === null ? [] : data.harnesses
        .filter(harness => harness.version === MEASURED[harness.target].version)
        .map(harness => projectClient(projectPackage, harness, runtime, data.cockpitDirectory))
    return Object.freeze({ rows: Object.freeze(rows), files: Object.freeze(files), mcp, probes: Object.freeze(probes),
        clients: Object.freeze(clients), graderBrowserAccess: 'retained' as const })
}

const Executable = z.object({
    path: z.string().max(4096).refine(path => isAbsolute(path) && resolve(path) === path && !/[\\\x00-\x1f\x7f]/.test(path)),
    sha256: Sha256, version: Version,
}).strict()
const Timestamp = z.string().refine(isCanonicalTimestamp)
const NativeContext = z.object({ executable: Executable, now: Timestamp }).strict()
const CommandObservation = z.object({
    argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
    exitCode: z.number().int().min(0).max(255), timedOut: z.literal(false), truncated: z.literal(false),
    durationMs: z.number().int().min(0).max(30_000), stdout: z.string(), stderr: z.string(), completedAt: Timestamp,
}).strict()
const Output = CommandObservation.omit({ argv: true }).extend({ path: GeneratedHostPath, sha256: Sha256 }).strict()
const Launch = z.object({
    cwd: GeneratedHostPath, argv: z.array(z.string().min(1).max(4096)).min(1).max(64), isolatedHome: z.literal(true),
})
const HarnessLaunch = z.union([
    Launch.extend({ selectedDeclaration: GeneratedHostPath, loader: z.enum(['explicit-config', 'fixed-path']),
        loadedPath: GeneratedHostPath, loadedSha256: Sha256 }).strict(),
    Launch.extend({ loader: z.literal('shell') }).strict(),
])
const Paths = z.array(GeneratedHostPath).min(1).max(1024).refine(paths => new Set(paths).size === paths.length)
const Receipt = z.object({
    schema: z.literal('cockpit-browser-native-receipt/v1'), subjectSha256: Sha256,
    target: z.enum(GUARD_SURFACE_TARGETS), transport: z.enum(['mcp', 'cli']), version: Version, observedAt: Timestamp,
    executable: Executable, harnessVersion: CommandObservation,
    transportIdentity: z.unknown(),
    transportVersion: CommandObservation.nullable(), transportHelp: z.array(CommandObservation).length(2).nullable(),
    rendered: z.array(z.object({ path: GeneratedHostPath, sha256: Sha256 }).strict()).min(1).max(16),
    candidate: Output.extend({ invocation: z.unknown(), launch: HarnessLaunch, cliPreparation: CommandObservation.nullable(), observedUrl: z.literal('about:blank') }).strict(),
    brokenControl: Output.extend({ discoveredPath: GeneratedHostPath, invocation: z.unknown(), launch: HarnessLaunch }).strict(),
    bounds: z.object({ timeoutMs: z.literal(30_000), outputBytes: z.literal(16_384), receiptBytes: z.literal(65_536) }).strict(),
    cleanup: z.object({ producedPaths: Paths, removedPaths: Paths, unregisteredControl: GeneratedHostPath,
        unregisteredControlPreserved: z.literal(true), candidateClosed: z.literal(true),
        reset: z.object({ cwd: Input.shape.cockpitDirectory, argv: z.array(z.string()).length(5), exitCode: z.literal(0), timedOut: z.literal(false), truncated: z.literal(false),
            stdout: z.string().max(16_384), stderr: z.string().max(16_384), completedAt: Timestamp }).strict(),
        readback: z.array(z.object({ cwd: Input.shape.cockpitDirectory, path: GeneratedHostPath, state: z.enum(['absent', 'present']), observedAt: Timestamp }).strict()).min(1).max(2048),
    }).strict(),
}).strict()

export type BrowserNativeReceiptResult = Readonly<{ kind: 'refusal'; reason: string }>
    | Readonly<{ kind: 'validated'; callable: 'human_needed'; operatorAuthentication: 'required'; subjectSha256: string }>

export function validateBrowserNativeReceipt(probe: BrowserNativeProbe, receipt: unknown, context: unknown): BrowserNativeReceiptResult {
    const refuse = (reason: string): BrowserNativeReceiptResult => Object.freeze({ kind: 'refusal', reason })
    const runtime = issuedProbes.get(probe)
    if (!runtime) return refuse('browser receipt requires an issued current probe')
    const captured = snapshotJson(receipt)
    const current = NativeContext.safeParse(snapshotJson(context))
    if (captured === undefined || Buffer.byteLength(JSON.stringify(captured)) > probe.bounds.receiptBytes || !current.success) {
        return refuse('browser receipt or authenticated observation context exceeds its bounded data contract')
    }
    const parsed = Receipt.safeParse(captured)
    if (!parsed.success) return refuse('browser receipt is malformed, incomplete, timed out or truncated')
    const value = parsed.data
    const age = Date.parse(current.data.now) - Date.parse(value.observedAt)
    if (age < 0 || age > 300_000 || value.subjectSha256 !== probe.subjectSha256 || value.target !== probe.target
        || value.transport !== probe.transport || value.version !== probe.version || value.executable.version !== probe.version
        || value.executable.path !== current.data.executable.path || value.executable.sha256 !== current.data.executable.sha256
        || value.executable.version !== current.data.executable.version
        || JSON.stringify(value.transportIdentity) !== JSON.stringify(probe.transportIdentity)
        || JSON.stringify(value.rendered) !== JSON.stringify(probe.rendered)
        || JSON.stringify(value.candidate.invocation) !== JSON.stringify(probe.invocation)
        || JSON.stringify(value.brokenControl.invocation) !== JSON.stringify(probe.brokenInvocation)
        || value.candidate.path !== probe.candidate.path || value.candidate.sha256 !== probe.candidate.sha256
        || value.brokenControl.path !== probe.brokenControl.path || value.brokenControl.sha256 !== probe.brokenControl.sha256) {
        return refuse('browser receipt is stale or differs from the current executable, rendered bytes or invocation')
    }
    const boundedCommand = (observation: z.infer<typeof CommandObservation>, argv: readonly string[]) =>
        observation.exitCode === 0 && JSON.stringify(observation.argv) === JSON.stringify(argv)
        && Buffer.byteLength(observation.stdout) + Buffer.byteLength(observation.stderr) <= probe.bounds.outputBytes
        && observation.stdout.trim().length + observation.stderr.trim().length > 0
        && Date.parse(observation.completedAt) <= Date.parse(value.candidate.completedAt)
        && Date.parse(value.observedAt) - Date.parse(observation.completedAt) <= 300_000
    const observedVersion = (observation: z.infer<typeof CommandObservation>, version: string) =>
        `${observation.stdout} ${observation.stderr}`.trim().split(/\s+/).includes(version)
    if (!boundedCommand(value.harnessVersion, [value.executable.path, ...probe.versionArgv.slice(1)])
        || !observedVersion(value.harnessVersion, probe.version)) return refuse('browser harness version command is missing or differs from the current executable')
    const candidateLaunch = value.candidate.launch
    const brokenLaunch = value.brokenControl.launch
    if (candidateLaunch.cwd !== probe.harnessCwd || brokenLaunch.cwd !== probe.harnessCwd
        || candidateLaunch.argv[0] !== value.executable.path || brokenLaunch.argv[0] !== value.executable.path) {
        return refuse('browser paired controls require the current harness in its isolated working directory')
    }
    let brokenLoadedPath: string
    if (probe.transport === 'mcp') {
        if (candidateLaunch.loader === 'shell' || brokenLaunch.loader === 'shell'
            || candidateLaunch.selectedDeclaration !== probe.candidate.path || brokenLaunch.selectedDeclaration !== probe.brokenControl.path
            || candidateLaunch.loadedSha256 !== probe.candidate.sha256 || brokenLaunch.loadedSha256 !== probe.brokenControl.sha256
            || candidateLaunch.loader !== brokenLaunch.loader || candidateLaunch.loadedPath !== probe.candidate.path
            || (candidateLaunch.loader === 'explicit-config'
                ? !candidateLaunch.argv.includes(probe.candidate.path) || !brokenLaunch.argv.includes(probe.brokenControl.path)
                    || brokenLaunch.loadedPath !== probe.brokenControl.path
                    || JSON.stringify(brokenLaunch.argv) !== JSON.stringify(candidateLaunch.argv.map(arg => arg === probe.candidate.path ? probe.brokenControl.path : arg))
                : brokenLaunch.loadedPath !== probe.candidate.path || JSON.stringify(brokenLaunch.argv) !== JSON.stringify(candidateLaunch.argv))
            || value.candidate.cliPreparation !== null || value.transportVersion !== null || value.transportHelp !== null) {
            return refuse('browser MCP controls must select their declarations through the same isolated native loader')
        }
        brokenLoadedPath = brokenLaunch.loadedPath
    } else {
        if (candidateLaunch.loader !== 'shell' || brokenLaunch.loader !== 'shell'
            || JSON.stringify(candidateLaunch.argv) !== JSON.stringify(brokenLaunch.argv)
            || probe.invocation.kind !== 'cli' || !value.candidate.cliPreparation
            || !boundedCommand(value.candidate.cliPreparation, probe.invocation.prepareArgv)
            || !value.transportVersion || !value.transportHelp || !probe.transportVersionArgv || !probe.transportHelpArgv
            || !boundedCommand(value.transportVersion, probe.transportVersionArgv)
            || !value.transportHelp.every((observation, index) => boundedCommand(observation, probe.transportHelpArgv![index]!))
            || probe.transportIdentity.kind !== 'test-package' || !observedVersion(value.transportVersion, probe.transportIdentity.version)
            || !['attach', 'goto', 'close', '--endpoint', '--config'].every(word => value.transportHelp!.map(row => `${row.stdout} ${row.stderr}`).join(' ').includes(word))) {
            return refuse('browser CLI requires harness shell execution and bounded pinned version, protocol and preparation observations')
        }
        brokenLoadedPath = probe.brokenControl.path
        try {
            if (digest(observedBytes(probe.transportIdentity.path, 65_536)) !== probe.transportIdentity.sha256
                || digest(observedBytes(probe.transportIdentity.manifest.path, 65_536)) !== probe.transportIdentity.manifest.sha256
                || digest(observedBytes(probe.transportIdentity.lock.path, 1_048_576)) !== probe.transportIdentity.lock.sha256) {
                return refuse('browser pinned CLI, package manifest or lock bytes changed after projection')
            }
        } catch (error) { return refuse(error instanceof Error ? error.message : 'browser pinned CLI observation failed') }
    }
    for (const output of [value.candidate, value.brokenControl]) {
        if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > probe.bounds.outputBytes
            || output.stdout.trim().length + output.stderr.trim().length === 0) return refuse('browser observation is silent or exceeds its output bound')
    }
    if (value.candidate.exitCode !== 0 || !`${value.candidate.stdout}\n${value.candidate.stderr}`.includes('about:blank')
        || value.brokenControl.exitCode === 0 || value.brokenControl.discoveredPath !== brokenLoadedPath
        || !`${value.brokenControl.stdout}\n${value.brokenControl.stderr}`.includes(brokenLoadedPath)) {
        return refuse('browser candidate did not observe the harmless page or the broken control was not discovered and rejected')
    }
    const expectedRemoved = new Set([...value.cleanup.producedPaths, probe.candidate.path, probe.brokenControl.path])
    if (expectedRemoved.size !== value.cleanup.removedPaths.length || value.cleanup.removedPaths.some(path => !expectedRemoved.has(path))) {
        return refuse('browser cleanup readback does not account for every produced artifact and paired control')
    }
    const reset = value.cleanup.reset
    const resetAt = Date.parse(reset.completedAt)
    const expectedAbsent = new Set([...expectedRemoved, ...probe.artifactRoots])
    const readback = value.cleanup.readback
    if (reset.cwd !== probe.cockpitDirectory || JSON.stringify(reset.argv) !== JSON.stringify(probe.resetArgv)
        || Date.parse(value.candidate.completedAt) > resetAt || Date.parse(value.brokenControl.completedAt) > resetAt
        || Date.parse(value.observedAt) - Date.parse(value.candidate.completedAt) > 300_000
        || Date.parse(value.observedAt) - Date.parse(value.brokenControl.completedAt) > 300_000
        || Buffer.byteLength(reset.stdout) + Buffer.byteLength(reset.stderr) > probe.bounds.outputBytes
        || !`${reset.stdout}\n${reset.stderr}`.trim() || resetAt > Date.parse(value.observedAt) || Date.parse(value.observedAt) - resetAt > 300_000
        || readback.length !== expectedAbsent.size + 1 || new Set(readback.map(row => row.path)).size !== readback.length
        || readback.some(row => row.cwd !== probe.cockpitDirectory || Date.parse(row.observedAt) < resetAt || Date.parse(row.observedAt) > Date.parse(value.observedAt)
            || (row.path === value.cleanup.unregisteredControl ? row.state !== 'present' : !expectedAbsent.has(row.path) || row.state !== 'absent'))) {
        return refuse('browser cleanup requires the public reset result and complete subsequent filesystem readback')
    }
    try {
        assertBrowserArtifactRegistration(runtime, value.cleanup.producedPaths)
    } catch (error) {
        return refuse(`browser receipt ownership refused: ${error instanceof Error ? error.message : 'unknown observation error'}`)
    }
    let unregistered = false
    try { assertBrowserArtifactRegistration(runtime, [...value.cleanup.producedPaths, value.cleanup.unregisteredControl]) }
    catch (error) {
        if (!(error instanceof TypeError) || !error.message.includes('unregistered')) return refuse('browser negative registration control failed unexpectedly')
        unregistered = true
    }
    if (!unregistered || expectedRemoved.has(value.cleanup.unregisteredControl)) return refuse('browser negative control is registered or was removed')
    // Structural agreement cannot authenticate who observed it or what the native harness actually did.
    return Object.freeze({ kind: 'validated', callable: 'human_needed', operatorAuthentication: 'required', subjectSha256: probe.subjectSha256 })
}
