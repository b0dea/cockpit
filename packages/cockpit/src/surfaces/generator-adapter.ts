import { createHash, randomBytes } from 'node:crypto'
import { sha256Hex } from '../sha256.js'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { libexecProgram, type LibexecProgram } from '../environment-exec/libexec-program.js'
import { ENVIRONMENT_CODES, snapshotExecutionStep, snapshotGeneratedJson, type ExecutionStep, type JsonSnapshotObject, RefusalError, errorCause, tryParseJson, hasErrorCode } from '../environment/contract.js'
import {
    bundleSurfaceFiles,
    captureSurfaceBundleBatch,
    captureSurfaceBatch,
    SURFACE_FILE_MAX_BYTES,
    SURFACE_OUTPUT_MAX_BYTES,
    SURFACE_OUTPUT_MAX_FILES,
    type RenderedSurfaceFile,
    type SurfaceBatch,
    type SurfaceBundleFormat,
    type SurfaceFeature,
    type SurfaceTarget,
} from './contract.js'
import { harnessFact, type HarnessRegistryRow } from './harness-registry.js'
import { hasTargetMcpServers } from './mcp.js'

export interface SurfaceGenerationDiagnostic {
    readonly severity: 'error'
    readonly code: string
    readonly message: string
    readonly target?: string
    readonly cause: 'input' | 'package' | 'timeout' | 'signal' | 'nonzero' | 'stderr' | 'worker-output' | 'coverage' | 'artifact' | 'cleanup'
    readonly stderr?: string
}

export interface SurfaceGenerationWarning {
    readonly severity: 'warning'
    readonly code: 'SURFACE_GENERATOR_TRUST_WARNING'
    readonly target: SurfaceTarget
    readonly path: '.claude/settings.json'
    readonly message: string
}

export type SurfaceGenerationOutcome =
    | Readonly<{
        kind: 'complete'
        status: 0
        diagnostics: readonly []
        mechanism: Readonly<{ package: 'rulesync'; version: '43.1.2'; role: 'spelling' }>
        files: readonly RenderedSurfaceFile[]
        warnings?: readonly SurfaceGenerationWarning[]
    }>
    | Readonly<{
        kind: 'refusal'
        status: 2
        diagnostics: readonly SurfaceGenerationDiagnostic[]
        files: readonly []
    }>
    | Readonly<{
        kind: 'unavailable'
        status: 3
        diagnostics: readonly SurfaceGenerationDiagnostic[]
        files: readonly []
    }>

export interface RenderedSurfaceBundleFile {
    readonly path: string
    readonly bytes: string
    readonly sha256: string
}

export type SurfaceBundleGenerationOutcome =
    | Readonly<{
        kind: 'complete'
        status: 0
        diagnostics: readonly []
        format: SurfaceBundleFormat
        mechanism: Readonly<{ package: 'rulesync'; version: '43.1.2'; role: 'packaging' }>
        files: readonly RenderedSurfaceBundleFile[]
    }>
    | Exclude<SurfaceGenerationOutcome, { kind: 'complete' }>

export type SurfaceEstateGenerationOutcome =
    | Readonly<{
        kind: 'complete'
        batch?: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>
        bundle?: Extract<SurfaceBundleGenerationOutcome, { kind: 'complete' }>
    }>
    | Exclude<SurfaceGenerationOutcome, { kind: 'complete' }>

type GeneratorTarget = HarnessRegistryRow['rulesyncTarget'] | SurfaceBundleFormat

interface NodeAuthority {
    readonly path: string
    readonly sha256: string
}

interface BundleAuthority {
    readonly path: string
    readonly sha256: string
    readonly maxBytes: number
}

interface AuthenticatedFile {
    readonly path: string
    readonly sha256: string
    readonly maxBytes: number
}

interface WorkerFeature {
    readonly feature: SurfaceFeature
    readonly count: number
    readonly paths: readonly string[]
}

interface WorkerFile {
    readonly path: string
    readonly bytes: number
    readonly sha256: string
}

interface WorkerReceipt {
    readonly version: 1
    readonly target: GeneratorTarget
    readonly features: readonly WorkerFeature[]
    readonly reportedPaths: readonly string[]
    readonly actualFiles: readonly WorkerFile[]
    readonly warnings: readonly SurfaceGenerationWarning[]
}

interface TargetGeneration {
    readonly files: readonly RenderedSurfaceFile[]
    readonly warnings: readonly SurfaceGenerationWarning[]
}

interface ReadFileReceipt extends WorkerFile {
    readonly bytesBase64: string
}

interface DirectoryIdentity {
    readonly dev: number
    readonly ino: number
}

interface EstateJob {
    readonly id: string
    readonly kind: 'batch' | 'bundle'
    readonly target: SurfaceTarget
    readonly generatorTarget: GeneratorTarget
    readonly batch: SurfaceBatch
    readonly features: readonly SurfaceFeature[]
    readonly expected: readonly string[]
}

interface StagedEstateJob extends EstateJob {
    readonly cwd: string
    readonly inputRoot: string
    readonly outputRoot: string
    readonly outputIdentity: DirectoryIdentity
    readonly generatorReceipt: string
    readonly readerReceipt: string
}

interface ReceiptSummary {
    readonly id: string
    readonly target: GeneratorTarget
    readonly bytes: number
    readonly sha256: string
}

interface EstatePassResult {
    readonly preserveScratch?: true
    readonly jobs: ReadonlyMap<string, TargetGeneration | SurfaceGenerationDiagnostic>
}

const PINNED_VERSION = '43.1.2'
const OPERATION_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 2_000
const MAX_NODE_BYTES = 536_870_912
const MAX_GENERATOR_BUNDLE_BYTES = 4_194_304
const MAX_WORKER_STDOUT_BYTES = 8_388_608
const MAX_WORKER_STDERR_BYTES = 65_536
const MAX_WARNING_COUNT = 16
const MAX_WARNING_BYTES = 4_096
const MAX_WARNING_TOTAL_BYTES = 16_384
const SHA256 = /^[a-f0-9]{64}$/
const FEATURES = new Set<SurfaceFeature>(['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'])
const EMPTY_FILES = Object.freeze([]) as readonly []
const EMPTY_DIAGNOSTICS = Object.freeze([]) as readonly []
const EMPTY_WARNINGS = Object.freeze([]) as readonly SurfaceGenerationWarning[]
// This digest binds the checked-in, self-contained generator asset. The build-time package
// tree is deliberately absent from the runtime authority boundary.
const PINNED_GENERATOR_BUNDLE_SHA256 = '01781a4b3952c24a1ec3ec749985eccf895728e932bc41a3bea4ab1d901fe4a5'
// The worker programs enforce these bounds; they receive them in each request so the limits keep
// one owner here.
const WORKER_OUTPUT_LIMITS = Object.freeze({
    fileMaxBytes: SURFACE_FILE_MAX_BYTES,
    outputMaxFiles: SURFACE_OUTPUT_MAX_FILES,
    outputMaxBytes: SURFACE_OUTPUT_MAX_BYTES,
    stdoutMaxBytes: MAX_WORKER_STDOUT_BYTES,
})
const GENERATOR_LIMITS = Object.freeze({
    ...WORKER_OUTPUT_LIMITS,
    stderrMaxBytes: MAX_WORKER_STDERR_BYTES,
    warningCount: MAX_WARNING_COUNT,
    warningBytes: MAX_WARNING_BYTES,
    warningTotalBytes: MAX_WARNING_TOTAL_BYTES,
})

interface SurfacePrograms {
    readonly generate: LibexecProgram
    readonly read: LibexecProgram
    readonly cleanup: LibexecProgram
}

function diagnostic(
    code: string,
    message: string,
    cause: SurfaceGenerationDiagnostic['cause'],
    target?: string,
    stderr?: string,
): SurfaceGenerationDiagnostic {
    return {
        severity: 'error' as const,
        code,
        message,
        cause,
        ...(target === undefined ? {} : { target }),
        ...(stderr === undefined ? {} : { stderr }),
    }
}

function refuse(item: SurfaceGenerationDiagnostic): Extract<SurfaceGenerationOutcome, { kind: 'refusal' }> {
    return { kind: 'refusal', status: 2, diagnostics: [item], files: EMPTY_FILES }
}

function unavailable(item: SurfaceGenerationDiagnostic): Extract<SurfaceGenerationOutcome, { kind: 'unavailable' }> {
    return { kind: 'unavailable', status: 3, diagnostics: [item], files: EMPTY_FILES }
}

function complete(files: readonly RenderedSurfaceFile[], warnings: readonly SurfaceGenerationWarning[]): Extract<SurfaceGenerationOutcome, { kind: 'complete' }> {
    return {
        kind: 'complete',
        status: 0,
        diagnostics: EMPTY_DIAGNOSTICS,
        mechanism: { package: 'rulesync' as const, version: PINNED_VERSION, role: 'spelling' as const },
        files: files.map(file => ({ ...file })),
        warnings: warnings.length === 0 ? EMPTY_WARNINGS : warnings.map(warning => ({ ...warning })),
    }
}

function completeBundle(
    format: SurfaceBundleFormat,
    files: readonly RenderedSurfaceFile[],
): Extract<SurfaceBundleGenerationOutcome, { kind: 'complete' }> {
    return {
        kind: 'complete',
        status: 0,
        diagnostics: EMPTY_DIAGNOSTICS,
        format,
        mechanism: { package: 'rulesync' as const, version: PINNED_VERSION, role: 'packaging' as const },
        files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    }
}

// Each refusal names what differed so the unavailable diagnostic can say why authority failed.
async function digestFile(path: string, maxBytes: number, executable = false): Promise<string> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        if (constants.O_NOFOLLOW === undefined) throw new RefusalError('this platform cannot open files without following symbolic links')
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink()) throw new RefusalError(`${path} is not a regular file`)
        if (before.size > maxBytes) throw new RefusalError(`${path} exceeds ${maxBytes} bytes`)
        if (executable && (before.mode & 0o111) === 0) throw new RefusalError(`${path} is not executable`)
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
            throw new RefusalError(`${path} changed while it was opened`)
        }
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1, 1_048_576))
        let total = 0
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > maxBytes) throw new RefusalError(`${path} grew past ${maxBytes} bytes while it was read`)
            hash.update(chunk.subarray(0, bytesRead))
        }
        const after = await handle.stat()
        if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
            throw new RefusalError(`${path} changed while it was read`)
        }
        return hash.digest('hex')
    } finally {
        await handle?.close()
    }
}

async function nodeAuthority(): Promise<NodeAuthority> {
    const path = await realpath(process.execPath)
    return { path, sha256: await digestFile(path, MAX_NODE_BYTES, true) }
}

async function bundleAuthority(): Promise<BundleAuthority> {
    const path = fileURLToPath(new URL('../../libexec/rulesync-generator.cjs', import.meta.url))
    if (await realpath(path) !== path) throw new RefusalError(`${path} is reached through a symbolic link`)
    const digest = await digestFile(path, MAX_GENERATOR_BUNDLE_BYTES)
    if (digest !== PINNED_GENERATOR_BUNDLE_SHA256) throw new RefusalError(`${path} differs from the pinned bundle digest`)
    return { path, sha256: digest, maxBytes: MAX_GENERATOR_BUNDLE_BYTES }
}

function surfacePrograms(): SurfacePrograms {
    return {
        generate: libexecProgram('surface-generator-worker.cjs'),
        read: libexecProgram('surface-output-reader.cjs'),
        cleanup: libexecProgram('surface-scratch-cleanup.cjs'),
    }
}

function step(
    node: NodeAuthority,
    id: string,
    cwd: string,
    program: LibexecProgram,
    request: string,
    deadline: number,
    stdoutLimitBytes = MAX_WORKER_STDOUT_BYTES,
    authenticatedFiles: readonly AuthenticatedFile[] = [],
): ExecutionStep | undefined {
    const remaining = deadline - Date.now()
    if (remaining <= 0 || Buffer.byteLength(request) > 1_048_576) return undefined
    return snapshotExecutionStep({
        id,
        // '--' ends Node's own options, so the program path can never be read as one.
        argv: [node.path, '--', program.path, request, ...authenticatedFiles.map(file => file.path)],
        argv0: node.path,
        cwd,
        env: { NODE_ENV: 'production' },
        timeoutMs: Math.min(OPERATION_TIMEOUT_MS, remaining),
        spawnNotAfter: new Date(deadline).toISOString(),
        stdoutLimitBytes,
        stderrLimitBytes: MAX_WORKER_STDERR_BYTES,
        paths: [cwd],
        ports: [],
        labels: { operation: 'surface-generation' },
        expected: [],
        consumedFiles: [
            {
                path: node.path,
                sha256: node.sha256,
                maxBytes: MAX_NODE_BYTES,
                argvIndexes: [0],
                executable: true,
                executionMode: 'verified-path',
            },
            { path: program.path, sha256: program.sha256, maxBytes: program.maxBytes, argvIndexes: [2], executable: false },
            ...authenticatedFiles.map((file, index) => ({
                path: file.path,
                sha256: file.sha256,
                maxBytes: file.maxBytes,
                argvIndexes: [4 + index],
                executable: false as const,
            })),
        ],
        filesystemChecks: [
            { path: cwd, expected: 'directory' },
        ],
        compensation: [],
    })
}

function outputText(bytes: Buffer): string | undefined {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        // undecodable bytes are malformed input the caller refuses.
        return undefined
    }
}

function executionFailure(outcome: ExecuteProbeOutcome, target: string): SurfaceGenerationDiagnostic {
    const stderr = outputText(outcome.stderr)
    if (outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED) {
        return diagnostic(outcome.code, 'surface worker termination could not be confirmed', 'signal', target, stderr)
    }
    if (outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_TIMEOUT) {
        return diagnostic('SURFACE_WORKER_TIMEOUT', 'surface generator worker exceeded the batch deadline', 'timeout', target, stderr)
    }
    if (outcome.execution.signal !== null) {
        return diagnostic('SURFACE_WORKER_SIGNAL', `surface generator worker ended by ${outcome.execution.signal}`, 'signal', target, stderr)
    }
    return diagnostic('SURFACE_WORKER_NONZERO', 'surface generator worker did not complete successfully', 'nonzero', target, stderr)
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined
}

function permissionRulesForTarget(sources: SurfaceBatch['sources'], target: 'codexcli' | 'grokcli'): boolean {
    const source = sources.find(candidate => candidate.path === 'permissions.jsonc')
    if (!source) return false
    try {
        const record = ownRecord(JSON.parse(source.bytes))
        const sections = [ownRecord(record?.permission), ownRecord(ownRecord(record?.[target])?.permission)]
        return sections.some(permission => permission !== undefined && Object.values(permission).some(value => {
            const rules = ownRecord(value)
            return rules !== undefined && Object.keys(rules).length > 0
        }))
    } catch {
        // Retain malformed input so Rulesync's authenticated parser error is returned to the caller.
        return true
    }
}

function stringArray(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

function workerFile(value: unknown): WorkerFile | undefined {
    const record = ownRecord(value)
    const keys = record ? Object.keys(record).sort() : []
    return record && keys.join(',') === 'bytes,path,sha256'
        && typeof record.path === 'string' && typeof record.bytes === 'number' && Number.isSafeInteger(record.bytes)
        && record.bytes >= 0 && record.bytes <= SURFACE_FILE_MAX_BYTES && typeof record.sha256 === 'string' && SHA256.test(record.sha256)
        ? { path: record.path, bytes: record.bytes, sha256: record.sha256 } : undefined
}

function workerWarnings(value: unknown, target: GeneratorTarget): readonly SurfaceGenerationWarning[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_WARNING_COUNT) return undefined
    if (target !== 'claudecode') return value.length === 0 ? EMPTY_WARNINGS : undefined
    const warnings: SurfaceGenerationWarning[] = []
    let total = 0
    for (const item of value) {
        const record = ownRecord(item)
        if (!record || Object.keys(record).sort().join(',') !== 'code,message,path,severity,target'
            || record.severity !== 'warning' || record.code !== 'SURFACE_GENERATOR_TRUST_WARNING'
            || record.target !== target || record.path !== '.claude/settings.json' || typeof record.message !== 'string') return undefined
        const bytes = Buffer.byteLength(record.message)
        total += bytes
        if (bytes > MAX_WARNING_BYTES || total > MAX_WARNING_TOTAL_BYTES) return undefined
        warnings.push({
            severity: 'warning',
            code: 'SURFACE_GENERATOR_TRUST_WARNING',
            target,
            path: '.claude/settings.json',
            message: record.message,
        })
    }
    return warnings
}

function parseWorkerReceipt(bytes: Buffer, target: GeneratorTarget, requested: readonly SurfaceFeature[]): WorkerReceipt | undefined {
    const text = outputText(bytes)
    const record = text === undefined ? undefined : ownRecord(tryParseJson(text))
    if (!record || Object.keys(record).sort().join(',') !== 'actualFiles,features,reportedPaths,target,version,warnings'
        || record.version !== 1 || record.target !== target || !Array.isArray(record.features) || record.features.length !== requested.length
        || !Array.isArray(record.actualFiles) || record.actualFiles.length > SURFACE_OUTPUT_MAX_FILES) return undefined
    const reportedPaths = stringArray(record.reportedPaths)
    const actualFiles = record.actualFiles.map(workerFile)
    const warnings = workerWarnings(record.warnings, target)
    if (!reportedPaths || !warnings || new Set(reportedPaths).size !== reportedPaths.length || actualFiles.some(file => !file)) return undefined
    const features: WorkerFeature[] = []
    for (const [index, value] of record.features.entries()) {
        const feature = ownRecord(value)
        if (!feature || Object.keys(feature).sort().join(',') !== 'count,feature,paths' || feature.feature !== requested[index]
            || !FEATURES.has(feature.feature as SurfaceFeature) || !Number.isSafeInteger(feature.count) || (feature.count as number) < 0) return undefined
        const paths = stringArray(feature.paths)
        if (!paths || new Set(paths).size !== paths.length) return undefined
        features.push({ feature: feature.feature as SurfaceFeature, count: feature.count as number, paths })
    }
    return {
        version: 1,
        target,
        features,
        reportedPaths: [...reportedPaths],
        actualFiles: actualFiles as WorkerFile[],
        warnings,
    }
}

function parseReadReceipt(bytes: Buffer): readonly ReadFileReceipt[] | undefined {
    const text = outputText(bytes)
    const record = text === undefined ? undefined : ownRecord(tryParseJson(text))
    if (!record || Object.keys(record).sort().join(',') !== 'files,version' || record.version !== 1
        || !Array.isArray(record.files) || record.files.length > SURFACE_OUTPUT_MAX_FILES) return undefined
    const files: ReadFileReceipt[] = []
    let total = 0
    for (const value of record.files) {
        const item = ownRecord(value)
        if (!item || Object.keys(item).sort().join(',') !== 'bytes,bytesBase64,path,sha256' || typeof item.bytesBase64 !== 'string') return undefined
        const file = workerFile({ path: item.path, bytes: item.bytes, sha256: item.sha256 })
        if (!file) return undefined
        const decoded = Buffer.from(item.bytesBase64, 'base64')
        total += decoded.byteLength
        if (decoded.byteLength !== file.bytes || total > SURFACE_OUTPUT_MAX_BYTES || sha256Hex(decoded) !== file.sha256) return undefined
        files.push({ ...file, bytesBase64: item.bytesBase64 })
    }
    return files
}

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
    if (actual.length !== expected.length) return false
    const sortedActual = [...actual].sort((left, right) => left.localeCompare(right))
    const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right))
    return sortedActual.every((path, index) => path === sortedExpected[index])
}

function sameRenderedFiles(left: readonly RenderedSurfaceFile[], right: readonly RenderedSurfaceFile[]): boolean {
    if (left.length !== right.length) return false
    const key = (file: RenderedSurfaceFile): string => `${file.target}\0${file.path}`
    const sortedLeft = [...left].sort((a, b) => key(a).localeCompare(key(b)))
    const sortedRight = [...right].sort((a, b) => key(a).localeCompare(key(b)))
    return sortedLeft.every((file, index) => {
        const other = sortedRight[index]
        return other !== undefined && file.target === other.target && file.path === other.path
            && file.bytes === other.bytes && file.sha256 === other.sha256
    })
}

function sameWarnings(left: readonly SurfaceGenerationWarning[], right: readonly SurfaceGenerationWarning[]): boolean {
    return left.length === right.length && left.every((warning, index) => {
        const other = right[index]
        return other !== undefined && warning.severity === other.severity && warning.code === other.code
            && warning.target === other.target && warning.path === other.path && warning.message === other.message
    })
}

async function writeSources(root: string, batch: SurfaceBatch): Promise<void> {
    for (const source of batch.sources) {
        const target = resolve(root, source.path)
        const offset = relative(root, target)
        if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new RefusalError('source path escaped staging')
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, source.bytes, { mode: 0o600, flag: 'wx' })
    }
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
    try {
        const status = await lstat(path)
        return status.isDirectory() && !status.isSymbolicLink()
            ? { dev: status.dev, ino: status.ino } : undefined
    } catch {
        // an unobservable directory has no identity; the caller refuses.
        return undefined
    }
}

function canonicalReceipt(bytes: Buffer): boolean {
    const text = outputText(bytes)
    if (text === undefined || !text.endsWith('\n')) return false
    const value = tryParseJson(text)
    return value !== undefined && `${JSON.stringify(value)}\n` === text
}

async function readPrivateReceipt(path: string, summary: ReceiptSummary): Promise<Buffer | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        if (constants.O_NOFOLLOW === undefined || summary.bytes < 1 || summary.bytes > MAX_WORKER_STDOUT_BYTES) return undefined
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink() || before.size !== summary.bytes) return undefined
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== summary.bytes) return undefined
        const bytes = Buffer.allocUnsafe(summary.bytes)
        let offset = 0
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
            if (bytesRead === 0) return undefined
            offset += bytesRead
        }
        const after = await handle.stat()
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
            || sha256Hex(bytes) !== summary.sha256 || !canonicalReceipt(bytes)) return undefined
        return bytes
    } catch {
        // an unavailable authority is refused by the caller.
        return undefined
    } finally {
        try { await handle?.close() } catch { /* an unavailable authority is refused by the caller. */ return undefined }
    }
}

function receiptSummaries(
    bytes: Buffer,
    jobs: readonly EstateJob[],
): ReadonlyMap<string, ReceiptSummary | SurfaceGenerationDiagnostic> | undefined {
    const text = outputText(bytes)
    const record = text === undefined ? undefined : ownRecord(tryParseJson(text))
    if (!record || Object.keys(record).sort().join(',') !== 'jobs,version' || record.version !== 1
        || !Array.isArray(record.jobs) || record.jobs.length !== jobs.length) return undefined
    const summaries = new Map<string, ReceiptSummary | SurfaceGenerationDiagnostic>()
    for (let index = 0; index < jobs.length; index += 1) {
        const expected = jobs[index]!
        const row = ownRecord(record.jobs[index])
        if (!row || row.id !== expected.id || row.target !== expected.generatorTarget || summaries.has(expected.id)
            || row.kind !== 'complete' && row.kind !== 'error') return undefined
        if (row.kind === 'error') {
            if (Object.keys(row).sort().join(',') !== 'cause,id,kind,message,target'
                || row.cause !== 'nonzero' && row.cause !== 'stderr' && row.cause !== 'artifact'
                || typeof row.message !== 'string'
                || Buffer.byteLength(row.message) > 4_096) return undefined
            summaries.set(expected.id, row.cause === 'stderr'
                ? diagnostic('SURFACE_WORKER_STDERR', 'surface generator emitted a diagnostic; partial output was refused', 'stderr', expected.generatorTarget, row.message)
                : row.cause === 'artifact'
                    ? diagnostic('SURFACE_ARTIFACT_INVALID', 'surface output could not be authenticated', 'artifact', expected.generatorTarget, row.message)
                    : diagnostic('SURFACE_WORKER_NONZERO', 'surface generator worker did not complete successfully', 'nonzero', expected.generatorTarget, row.message))
            continue
        }
        if (Object.keys(row).sort().join(',') !== 'bytes,id,kind,sha256,target'
            || !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 1 || (row.bytes as number) > MAX_WORKER_STDOUT_BYTES
            || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) return undefined
        summaries.set(expected.id, {
            id: expected.id,
            target: expected.generatorTarget,
            bytes: row.bytes as number,
            sha256: row.sha256,
        })
    }
    return summaries
}

async function stageEstatePass(root: string, jobs: readonly EstateJob[]): Promise<readonly StagedEstateJob[] | undefined> {
    const staged: StagedEstateJob[] = []
    for (const job of jobs) {
        const cwd = join(root, job.id)
        const inputRoot = join(cwd, 'input')
        const outputRoot = join(cwd, 'output')
        await mkdir(inputRoot, { recursive: true, mode: 0o700 })
        await mkdir(outputRoot, { recursive: true, mode: 0o700 })
        await chmod(cwd, 0o700)
        await writeFile(join(cwd, 'rulesync.jsonc'), '{}\n', { mode: 0o600, flag: 'wx' })
        await writeSources(inputRoot, job.batch)
        const outputIdentity = await directoryIdentity(outputRoot)
        if (!outputIdentity) return undefined
        staged.push({
            ...job,
            cwd,
            inputRoot,
            outputRoot,
            outputIdentity,
            generatorReceipt: join(cwd, 'generator-receipt.json'),
            readerReceipt: join(cwd, 'reader-receipt.json'),
        })
    }
    return staged
}


async function runEstatePass(
    pass: 'first' | 'second',
    root: string,
    jobs: readonly StagedEstateJob[],
    node: NodeAuthority,
    bundle: BundleAuthority,
    programs: SurfacePrograms,
    deadline: number,
): Promise<EstatePassResult> {
    const failures = (item: SurfaceGenerationDiagnostic): EstatePassResult => ({
        ...(item.code === ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED ? { preserveScratch: true as const } : {}),
        jobs: new Map(jobs.map(job => [job.id, { ...item, target: job.generatorTarget }])),
    })
    const identity = await directoryIdentity(root)
    if (!identity) return failures(diagnostic('SURFACE_ARTIFACT_INVALID', 'surface pass root is not a regular directory', 'artifact', pass))
    const generatorJobs = await Promise.all(jobs.map(async job => ({ ...job, cwdIdentity: await directoryIdentity(job.cwd) })))
    if (generatorJobs.some(job => !job.cwdIdentity)) {
        return failures(diagnostic('SURFACE_ARTIFACT_INVALID', 'surface job root is not a regular directory', 'artifact', pass))
    }
    const generatorRequest = JSON.stringify({
        version: 1,
        passRoot: root,
        identity,
        bundleSha256: bundle.sha256,
        bundleMaxBytes: bundle.maxBytes,
        limits: GENERATOR_LIMITS,
        jobs: generatorJobs.map(job => ({
            id: job.id,
            target: job.generatorTarget,
            cwd: job.cwd,
            cwdIdentity: job.cwdIdentity,
            inputRoot: job.inputRoot,
            outputRoot: job.outputRoot,
            identity: job.outputIdentity,
            features: job.features,
            warningSourceSha256: (() => {
                const source = job.batch.sources.find(item => item.path === 'permissions.jsonc')
                return source ? sha256Hex(source.bytes) : null
            })(),
            receiptOutput: job.generatorReceipt,
        })),
    })
    const generationStep = step(node, `surface-estate-generate-${pass}-${randomBytes(8).toString('hex')}`, root,
        programs.generate, generatorRequest, deadline, MAX_WORKER_STDOUT_BYTES, [bundle])
    if (!generationStep) return failures(diagnostic('SURFACE_WORKER_TIMEOUT', 'surface generator batch deadline expired before spawn', 'timeout', pass))
    const generation = authenticatedExecutionOutcome(await executeProbe(generationStep), generationStep)
    if (!generation || generation.kind !== 'complete') {
        return failures(generation ? executionFailure(generation, pass)
            : diagnostic('SURFACE_WORKER_OUTPUT', 'surface generator execution was not authenticated', 'worker-output', pass))
    }
    if (generation.stderr.byteLength > 0) {
        return failures(diagnostic('SURFACE_WORKER_STDERR', 'surface generator emitted a diagnostic; partial output was refused',
            'stderr', pass, outputText(generation.stderr) ?? 'stderr was not valid UTF-8'))
    }
    const generated = receiptSummaries(generation.stdout, jobs)
    if (!generated) return failures(diagnostic('SURFACE_WORKER_OUTPUT', 'surface generator returned an invalid estate receipt', 'worker-output', pass))
    const generatedReceipts = new Map<string, WorkerReceipt>()
    const generatedFailures = new Map<string, SurfaceGenerationDiagnostic>()
    for (const job of jobs) {
        const summary = generated.get(job.id)
        if (!summary || 'severity' in summary) {
            generatedFailures.set(job.id, summary && 'severity' in summary ? summary
                : diagnostic('SURFACE_WORKER_OUTPUT', 'surface generator omitted an estate job receipt', 'worker-output', job.generatorTarget))
            continue
        }
        const bytes = await readPrivateReceipt(job.generatorReceipt, summary)
        const receipt = bytes ? parseWorkerReceipt(bytes, job.generatorTarget, job.features) : undefined
        if (!receipt) {
            generatedFailures.set(job.id, diagnostic('SURFACE_WORKER_OUTPUT', 'surface generator returned an invalid job receipt', 'worker-output', job.generatorTarget))
        } else if (receipt.features.some(feature => feature.count < 1 || feature.paths.length < 1)) {
            const missing = receipt.features.filter(feature => feature.count < 1 || feature.paths.length < 1).map(feature => feature.feature).join(', ')
            generatedFailures.set(job.id, diagnostic('SURFACE_FEATURE_COVERAGE', `surface generator did not cover requested features: ${missing}`, 'coverage', job.generatorTarget))
        } else if (!samePaths(receipt.reportedPaths, job.expected) || !samePaths(receipt.actualFiles.map(file => file.path), job.expected)) {
            const actual = [...new Set([...receipt.reportedPaths, ...receipt.actualFiles.map(file => file.path)])]
            const missing = job.expected.filter(path => !actual.includes(path))
            const unexpected = actual.filter(path => !job.expected.includes(path))
            generatedFailures.set(job.id, diagnostic('SURFACE_OUTPUT_COVERAGE',
                `surface generator output did not exactly match the expected path set (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`,
                'coverage', job.generatorTarget))
        } else generatedReceipts.set(job.id, receipt)
    }
    const readerJobs = jobs.filter(job => !generatedFailures.has(job.id))
    if (readerJobs.length === 0) return { jobs: generatedFailures }
    const readRequest = JSON.stringify({ version: 1, passRoot: root, identity, limits: WORKER_OUTPUT_LIMITS,
        jobs: readerJobs.map(job => ({ id: job.id, target: job.generatorTarget,
            outputRoot: job.outputRoot, identity: job.outputIdentity,
            expected: job.expected, receiptOutput: job.readerReceipt })),
    })
    const readFailures = (item: SurfaceGenerationDiagnostic): EstatePassResult => ({
        ...(item.code === ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED ? { preserveScratch: true as const } : {}),
        jobs: new Map<string, TargetGeneration | SurfaceGenerationDiagnostic>([
            ...generatedFailures,
            ...readerJobs.map(job => [job.id, { ...item, target: job.generatorTarget }] as const),
        ]),
    })
    const readStep = step(node, `surface-estate-read-${pass}-${randomBytes(8).toString('hex')}`, root,
        programs.read, readRequest, deadline)
    if (!readStep) return readFailures(diagnostic('SURFACE_WORKER_TIMEOUT', 'surface generator batch deadline expired before output authentication', 'timeout', pass))
    const read = authenticatedExecutionOutcome(await executeProbe(readStep), readStep)
    if (!read || read.kind !== 'complete') {
        return readFailures(read ? executionFailure(read, pass)
            : diagnostic('SURFACE_WORKER_OUTPUT', 'surface output read was not authenticated', 'worker-output', pass))
    }
    if (read.stderr.byteLength > 0) {
        return readFailures(diagnostic('SURFACE_WORKER_STDERR', 'surface output reader emitted a diagnostic', 'stderr', pass,
            outputText(read.stderr) ?? 'stderr was not valid UTF-8'))
    }
    const readSummaries = receiptSummaries(read.stdout, readerJobs)
    if (!readSummaries) return readFailures(diagnostic('SURFACE_WORKER_OUTPUT', 'surface reader returned an invalid estate receipt', 'worker-output', pass))
    const results = new Map<string, TargetGeneration | SurfaceGenerationDiagnostic>(generatedFailures)
    for (const job of readerJobs) {
        const summary = readSummaries.get(job.id)
        if (!summary || 'severity' in summary) {
            results.set(job.id, summary && 'severity' in summary ? summary
                : diagnostic('SURFACE_WORKER_OUTPUT', 'surface reader omitted an estate job receipt', 'worker-output', job.generatorTarget))
            continue
        }
        const bytes = await readPrivateReceipt(job.readerReceipt, summary)
        const files = bytes ? parseReadReceipt(bytes) : undefined
        const receipt = generatedReceipts.get(job.id)
        if (!files || !receipt || !samePaths(files.map(file => file.path), job.expected)) {
            results.set(job.id, diagnostic('SURFACE_ARTIFACT_INVALID', 'surface output could not be authenticated as the complete expected set', 'artifact', job.generatorTarget))
            continue
        }
        const workerByPath = new Map(receipt.actualFiles.map(file => [file.path, file]))
        const readByPath = new Map(files.map(file => [file.path, file]))
        const rendered: RenderedSurfaceFile[] = []
        let failure: SurfaceGenerationDiagnostic | undefined
        for (const path of job.expected) {
            const worker = workerByPath.get(path)
            const file = readByPath.get(path)
            if (!worker || !file || worker.bytes !== file.bytes || worker.sha256 !== file.sha256) {
                failure = diagnostic('SURFACE_ARTIFACT_INVALID', 'surface output changed between generation and authenticated read', 'artifact', `${job.generatorTarget}:${path}`)
                break
            }
            let content: string
            try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.bytesBase64, 'base64')) } catch {
                // undecodable bytes are malformed input the caller refuses.
                failure = diagnostic('SURFACE_ARTIFACT_INVALID', 'surface output is not valid UTF-8', 'artifact', `${job.generatorTarget}:${path}`)
                break
            }
            rendered.push({ target: job.target, path, bytes: content, sha256: file.sha256 })
        }
        results.set(job.id, failure ?? { files: rendered, warnings: receipt.warnings })
    }
    return { jobs: results }
}

async function cleanupScratch(scratch: string, node: NodeAuthority, program: LibexecProgram): Promise<boolean> {
    const cleanup = step(
        node,
        `surface-cleanup-${randomBytes(8).toString('hex')}`,
        dirname(scratch),
        program,
        JSON.stringify({ target: scratch, parent: dirname(scratch) }),
        Date.now() + CLEANUP_TIMEOUT_MS,
        1024,
    )
    if (!cleanup) return false
    const outcome = authenticatedExecutionOutcome(await executeProbe(cleanup), cleanup)
    if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength > 0) return false
    try {
        await lstat(scratch)
        return false
    } catch (error) {
        return hasErrorCode(error, 'ENOENT')
    }
}

export async function generateSurfaceEstate(input: unknown): Promise<SurfaceEstateGenerationOutcome> {
    // Each nested request retains its input limit; their envelope must admit both.
    const captured = snapshotGeneratedJson(input)
    const request = captured !== null && typeof captured === 'object' && !Array.isArray(captured)
        ? captured as JsonSnapshotObject : undefined
    const keys = request ? Object.keys(request).sort() : []
    if (!request || keys.length < 1 || keys.length > 2 || keys.some(key => key !== 'batch' && key !== 'bundle')) {
        return refuse(diagnostic('SURFACE_INPUT_INVALID', 'surface estate generation input is invalid', 'input', 'surface-estate'))
    }
    const batch = request.batch === undefined ? undefined : captureSurfaceBatch(request.batch)
    const bundleRequest = request.bundle === undefined ? undefined : captureSurfaceBundleBatch(request.bundle)
    if (request.batch !== undefined && !batch || request.bundle !== undefined && !bundleRequest || !batch && !bundleRequest) {
        return refuse(diagnostic('SURFACE_INPUT_INVALID', 'surface estate generation input is invalid', 'input', 'surface-estate'))
    }
    const bundleBatch = bundleRequest ? captureSurfaceBatch({
        targets: ['claudecode'],
        features: bundleRequest.features,
        sources: bundleRequest.sources,
        expectedOutputs: { claudecode: bundleRequest.expectedOutputs },
    }) : undefined
    if (bundleRequest && !bundleBatch) {
        return refuse(diagnostic('SURFACE_INPUT_INVALID', 'surface bundle input could not be bound to the neutral contract', 'input', bundleRequest.format))
    }
    const jobs: EstateJob[] = [
        ...batch ? batch.targets.map(target => ({
            id: `batch-${target}`,
            kind: 'batch' as const,
            target,
            generatorTarget: harnessFact(target).rulesyncTarget,
            batch,
            features: batch.features.filter(feature => harnessFact(target).rulesyncFeatures.some(candidate => candidate === feature)
                && (feature !== 'mcp' || hasTargetMcpServers(batch.sources, target))
                && (feature !== 'permissions' || (target !== 'codexcli' && target !== 'grokcli')
                    || permissionRulesForTarget(batch.sources, target))),
            expected: batch.expectedOutputs[target] ?? EMPTY_FILES,
        })) : [],
        ...bundleRequest && bundleBatch ? [{
            id: `bundle-${bundleRequest.format}`,
            kind: 'bundle' as const,
            target: 'claudecode' as const,
            generatorTarget: bundleRequest.format,
            batch: bundleBatch,
            features: bundleBatch.features,
            expected: bundleRequest.expectedOutputs,
        }] : [],
    ]
    let node: NodeAuthority
    try { node = await nodeAuthority() } catch (error) {
        return unavailable(diagnostic('SURFACE_NODE_UNAVAILABLE',
            `the Node executable could not be authenticated: ${errorCause(error)}`, 'package', process.execPath))
    }
    let bundle: BundleAuthority
    try { bundle = await bundleAuthority() } catch (error) {
        return unavailable(diagnostic('SURFACE_PACKAGE_UNAVAILABLE',
            `the authenticated Rulesync ${PINNED_VERSION} generator bundle is unavailable: ${errorCause(error)} — fix: reinstall @b00dea/cockpit`,
            'package', 'rulesync-generator.cjs'))
    }
    let programs: SurfacePrograms
    try { programs = surfacePrograms() } catch (error) {
        return unavailable(diagnostic('SURFACE_PACKAGE_UNAVAILABLE',
            `the surface generator workers are unavailable: ${errorCause(error)}`, 'package', 'libexec'))
    }

    let scratch: string
    try {
        // The cleanup worker compares canonical paths, and the temporary root may be reached
        // through a symlink (macOS /tmp is /private/tmp), so the scratch is canonical from birth.
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-surfaces-')))
        await chmod(scratch, 0o700)
    } catch (error) {
        return unavailable(diagnostic('SURFACE_SCRATCH_UNAVAILABLE',
            `private surface staging could not be created: ${errorCause(error)}`, 'package', tmpdir()))
    }

    let outcome: SurfaceEstateGenerationOutcome
    let preserveScratch = false
    const deadline = Date.now() + OPERATION_TIMEOUT_MS
    try {
        const firstRoot = join(scratch, 'first')
        const secondRoot = join(scratch, 'second')
        await mkdir(firstRoot, { mode: 0o700 })
        await mkdir(secondRoot, { mode: 0o700 })
        const firstJobs = await stageEstatePass(firstRoot, jobs)
        const secondJobs = await stageEstatePass(secondRoot, jobs)
        if (!firstJobs || !secondJobs) throw new RefusalError('surface estate roots could not be authenticated')
        const settled = await Promise.allSettled([
            runEstatePass('first', firstRoot, firstJobs, node, bundle, programs, deadline),
            runEstatePass('second', secondRoot, secondJobs, node, bundle, programs, deadline),
        ])
        const passes = settled.map((result): EstatePassResult => result.status === 'fulfilled' ? result.value : {
            preserveScratch: true,
            jobs: new Map(jobs.map(job => [job.id, diagnostic('SURFACE_STAGING_FAILED',
                errorCause(result.reason),
                'artifact', job.generatorTarget)])),
        })
        preserveScratch = passes.some(pass => pass.preserveScratch === true)
        const [first, second] = passes as [EstatePassResult, EstatePassResult]
        let failure: SurfaceGenerationDiagnostic | undefined
        const admitted = new Map<string, TargetGeneration>()
        for (const job of jobs) {
            const firstResult = first.jobs.get(job.id)
            const secondResult = second.jobs.get(job.id)
            if (!firstResult || !('files' in firstResult)) {
                failure = firstResult ?? diagnostic('SURFACE_WORKER_OUTPUT', 'surface estate omitted a first-pass job result', 'worker-output', job.generatorTarget)
                break
            }
            if (!secondResult || !('files' in secondResult)) {
                failure = secondResult ?? diagnostic('SURFACE_WORKER_OUTPUT', 'surface estate omitted a second-pass job result', 'worker-output', job.generatorTarget)
                break
            }
            if (!sameWarnings(firstResult.warnings, secondResult.warnings)
                || !sameRenderedFiles(firstResult.files, secondResult.files)
                || job.kind === 'bundle' && firstResult.warnings.length !== 0) {
                failure = diagnostic(
                    'SURFACE_STAGE_VARIANCE',
                    job.kind === 'bundle'
                        ? 'independent surface bundle staging produced different authenticated results'
                        : 'independent surface staging produced different target, path, byte, hash, or warning sets',
                    'artifact',
                    job.generatorTarget,
                )
                break
            }
            admitted.set(job.id, firstResult)
        }
        if (failure) outcome = refuse(failure)
        else {
            const coreFiles = jobs.filter(job => job.kind === 'batch').flatMap(job => admitted.get(job.id)!.files)
            const warnings = jobs.filter(job => job.kind === 'batch').flatMap(job => admitted.get(job.id)!.warnings)
            const plugin = jobs.find(job => job.kind === 'bundle')
            const pluginFiles = plugin ? admitted.get(plugin.id)!.files : undefined
            if (batch && !bundleSurfaceFiles(coreFiles)) {
                outcome = refuse(diagnostic('SURFACE_ARTIFACT_INVALID', 'surface output failed final bundle admission', 'artifact', 'surface-batch'))
            } else if (pluginFiles && !bundleSurfaceFiles(pluginFiles)) {
                outcome = refuse(diagnostic('SURFACE_ARTIFACT_INVALID', 'surface bundle failed final admission', 'artifact', plugin!.generatorTarget))
            } else outcome = {
                kind: 'complete' as const,
                ...(batch ? { batch: complete(coreFiles, warnings) } : {}),
                ...(bundleRequest && pluginFiles ? { bundle: completeBundle(bundleRequest.format, pluginFiles) } : {}),
            }
        }
    } catch (error) {
        outcome = refuse(diagnostic(
            'SURFACE_STAGING_FAILED',
            `surface estate staging failed: ${errorCause(error)}`,
            'artifact',
            'surface-estate',
        ))
    }

    if (preserveScratch) {
        return refuse(diagnostic(ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED,
            `surface worker termination could not be confirmed; staging retained at ${scratch}; stop remaining workers before removing it`,
            'cleanup', scratch))
    }
    if (!await cleanupScratch(scratch, node, programs.cleanup)) {
        return refuse(diagnostic('SURFACE_CLEANUP_FAILED', 'surface staging cleanup did not complete within its bound', 'cleanup', scratch))
    }
    return outcome
}

export async function generateSurfaceBatch(input: unknown): Promise<SurfaceGenerationOutcome> {
    const batch = captureSurfaceBatch(input)
    if (!batch) return refuse(diagnostic('SURFACE_INPUT_INVALID', 'surface generation input is invalid', 'input', 'surface-batch'))
    const outcome = await generateSurfaceEstate({ batch })
    return outcome.kind === 'complete' && outcome.batch
        ? outcome.batch
        : outcome.kind === 'complete'
            ? refuse(diagnostic('SURFACE_WORKER_OUTPUT', 'surface estate omitted the batch result', 'worker-output', 'surface-batch'))
            : outcome
}
