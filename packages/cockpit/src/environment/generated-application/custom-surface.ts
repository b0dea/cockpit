import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { authenticatedExecutionOutcome } from '../../environment-exec/execute.js'
import type { DerivedRegistry } from '../../registry-derivation.js'
import type { SurfaceSourceFile } from '../../surfaces/contract.js'
import type { OwnershipManifest } from '../../surfaces/ownership.js'
import { surfaceModelSha256, type CustomSurfaceReceipt } from '../../surfaces/render.js'
import { readAnchoredFile, readAnchoredBatches, type DirectoryIdentity } from '../../generated-environment/transaction.js'
import { snapshotExecutionStep, snapshotGeneratedJson, RefusalError, hasErrorCode } from '../contract.js'
import { observationSearchPath, resolveExecutablePath, resolveGitExecutable } from '../executable.js'
import { cockpitId } from '../identity.js'
import { NATIVE_HOOK_COST_SCRIPT, projectNativeHooks, type NativeHookEntry, type NativeHookPolicy } from '../../testing/hooks.js'
import { exactKeys } from '../../exact-keys.js'
import {
    type CustomSourceIdentity,
    type GeneratedEnvironmentCommandAdapters,
    HELPER_TIMEOUT_MS,
    MAX_EXECUTABLE_BYTES,
    MAX_GENERATED_BYTES,
    MAX_HELPER_FRAME_BYTES,
    MAX_SURFACE_FILE_BYTES,
    NATIVE_HOOK_COST_TIMEOUT_MS,
    type PreparedEnvironment,
    SHA256,
    confined,
    ownRecord,
    sha256,
} from './shared.js'

// The worker runs in its own process and cannot import modules; `safe` mirrors safeSurfacePath in
// surfaces/contract.ts, including its case-folded reserved segments.
const CUSTOM_SURFACE_WORKER = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const request = JSON.parse(process.argv[1]);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const own = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safe = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..' && !['.GIT','NODE_MODULES'].includes(part.normalize('NFC').toUpperCase()));
(async () => {
  const source = fs.readFileSync(process.argv[2]);
  if (digest(source) !== request.sourceSha256) throw new RefusalError('module changed');
  const imported = await import('data:text/javascript;base64,' + source.toString('base64'));
  const fn = imported[request.export]; if (typeof fn !== 'function') throw new RefusalError('export');
  const result = await fn(request.input);
  if (!own(result) || Object.keys(result).sort().join(',') !== 'files,kind' || result.kind !== 'complete' || !Array.isArray(result.files) || result.files.length === 0 || result.files.length > 256) throw new RefusalError('result');
  let total = 0; let spelling = false; const files = [];
  for (const [index, file] of result.files.entries()) {
    if (!own(file) || Object.keys(file).sort().join(',') !== 'bytes,path,scope,sha256' || !safe(file.path) || typeof file.bytes !== 'string' || Buffer.byteLength(file.bytes) > 65536 || digest(file.bytes) !== file.sha256 || !['always','scoped'].includes(file.scope)) throw new RefusalError('file');
    spelling = spelling || file.path === request.spelling || file.bytes.includes(request.spelling);
    total += Buffer.byteLength(file.bytes); if (total > 4194304) throw new RefusalError('limit');
    const output = path.join(request.output, String(index)); fs.writeFileSync(output, file.bytes, { flag: 'wx', mode: 0o600 });
    files.push({ path: file.path, sha256: file.sha256, scope: file.scope, output: String(index) });
  }
  if (!spelling) throw new RefusalError('spelling');
  process.stdout.write(JSON.stringify({ version: 1, files }) + '\n');
})().catch(() => { process.stdout.write(JSON.stringify({ version: 1, refusal: true }) + '\n'); });
`

export async function executeCustomCapability(
    prepared: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters,
    harness: string,
    capability: Extract<DerivedRegistry['config']['surfaces']['harnesses'][number]['capabilities'][number], { state: 'enforced' | 'instructed' }>,
    sources: readonly SurfaceSourceFile[],
): Promise<{ receipt: CustomSurfaceReceipt; sources: readonly CustomSourceIdentity[]; evidence?: Readonly<{ reference: string; sha256: string }> } | undefined> {
    let evidenceSource: CustomSourceIdentity | undefined
    if (capability.state === 'enforced') {
        const evidenceRead = await readAnchoredFile(
            prepared.root, capability.evidence.reference, MAX_SURFACE_FILE_BYTES, prepared.node, adapters,
        )
        if (evidenceRead.kind !== 'complete' || evidenceRead.sha256 !== capability.evidence.sha256) return undefined
        evidenceSource = { harness, feature: capability.feature, path: capability.evidence.reference,
            sha256: evidenceRead.sha256, identity: evidenceRead.identity, maxBytes: MAX_SURFACE_FILE_BYTES }
    }
    const moduleRead = await readAnchoredFile(prepared.root, capability.mechanism.module, MAX_GENERATED_BYTES, prepared.node, adapters)
    if (moduleRead.kind !== 'complete') return undefined
    const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
        : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : undefined
    if (!permissionFlag || !process.allowedNodeEnvironmentFlags.has('--allow-fs-read')
        || !process.allowedNodeEnvironmentFlags.has('--allow-fs-write')) return undefined
    let scratch: string | undefined
    let scratchIdentity: DirectoryIdentity | undefined
    try {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-custom-surface-')))
        const scratchStatus = await lstat(scratch)
        if (!scratchStatus.isDirectory() || scratchStatus.isSymbolicLink()) return undefined
        scratchIdentity = { dev: scratchStatus.dev, ino: scratchStatus.ino }
        const input = snapshotGeneratedJson({ harness, feature: capability.feature, sources })
        if (!input) return undefined
        const absoluteModule = confined(prepared.root, capability.mechanism.module)
        if (!absoluteModule || [scratch, absoluteModule].some(path => path.includes('*'))) return undefined
        const request = { export: capability.mechanism.export, input, output: scratch,
            sourceSha256: moduleRead.sha256, spelling: capability.spelling }
        const raw = JSON.stringify(request)
        if (Buffer.byteLength(raw) > MAX_HELPER_FRAME_BYTES) return undefined
        const step = snapshotExecutionStep({
            id: `custom-surface-${harness}-${capability.feature}`, argv: [prepared.node.canonicalPath, permissionFlag,
                '--allow-fs-read', absoluteModule, `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`,
                '-e', CUSTOM_SURFACE_WORKER, raw, absoluteModule],
            argv0: prepared.node.invocationPath, cwd: scratch, env: {}, timeoutMs: HELPER_TIMEOUT_MS,
            spawnNotAfter: new Date(Date.now() + HELPER_TIMEOUT_MS).toISOString(), stdoutLimitBytes: MAX_HELPER_FRAME_BYTES,
            stderrLimitBytes: 16_384, paths: [prepared.root, scratch], ports: [], labels: { harness, feature: capability.feature }, expected: [],
            consumedFiles: [
                { path: prepared.node.canonicalPath, sha256: prepared.node.sha256, maxBytes: MAX_EXECUTABLE_BYTES, argvIndexes: [0], executable: true, executionMode: prepared.node.executionMode },
                { path: absoluteModule, sha256: moduleRead.sha256, maxBytes: MAX_GENERATED_BYTES, argvIndexes: [3, 9], executable: false },
            ], filesystemChecks: [{ path: scratch, expected: 'directory' }], compensation: [],
        })
        if (!step) return undefined
        const outcome = authenticatedExecutionOutcome(await adapters.execute(step), step)
        if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0) return undefined
        const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout)
        const record = ownRecord(JSON.parse(text))
        if (!record || !exactKeys(record, ['version', 'files']) || record.version !== 1 || !Array.isArray(record.files)) return undefined
        const descriptors: Readonly<{ path: string; sha256: string; scope: 'always' | 'scoped'; output: string }>[] = []
        for (const [index, value] of record.files.entries()) {
            const row = ownRecord(value)
            if (!row || !exactKeys(row, ['path', 'sha256', 'scope', 'output']) || row.output !== String(index)
                || typeof row.path !== 'string' || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)
                || row.scope !== 'always' && row.scope !== 'scoped') return undefined
            descriptors.push({ path: row.path, sha256: row.sha256, scope: row.scope, output: row.output })
        }
        const reads = await readAnchoredBatches(scratch, descriptors.map(row => ({
            path: row.output, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), prepared.node, adapters)
        if (!reads || reads.kind !== 'complete' || reads.results.length !== descriptors.length) return undefined
        const files: CustomSurfaceReceipt['files'][number][] = []
        for (const [index, row] of descriptors.entries()) {
            const read = reads.results[index]!
            if (read.kind !== 'complete' || read.sha256 !== row.sha256
                || read.identity.root.dev !== scratchIdentity.dev || read.identity.root.ino !== scratchIdentity.ino) return undefined
            const bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
            files.push({ path: row.path, bytes, sha256: row.sha256, scope: row.scope })
        }
        if (files.length === 0 || !files.some(file => file.path === capability.spelling || file.bytes.includes(capability.spelling))) return undefined
        const resultSha256 = surfaceModelSha256(files)
        if (!resultSha256) return undefined
        return {
            receipt: { harness, feature: capability.feature, state: capability.state, measuredOn: capability.measured_on,
                module: capability.mechanism.module, export: capability.mechanism.export, sourceSha256: moduleRead.sha256,
                resultSha256, files },
            sources: [
                { harness, feature: capability.feature, path: capability.mechanism.module,
                    sha256: moduleRead.sha256, identity: moduleRead.identity, maxBytes: MAX_GENERATED_BYTES },
                ...(evidenceSource ? [evidenceSource] : []),
            ],
            ...(capability.state === 'enforced' ? { evidence: { ...capability.evidence } } : {}),
        }
    } catch { /* an unavailable authority is refused by the caller. */ return undefined } finally {
        if (scratch && scratchIdentity) {
            try {
                const current = await lstat(scratch)
                if (current.isDirectory() && !current.isSymbolicLink()
                    && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) {
                    await rm(scratch, { recursive: true, force: true })
                }
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error
            }
        }
    }
}

export async function projectExplicitNativeHooks(
    prepared: PreparedEnvironment,
    manifest: OwnershipManifest | undefined,
    adapters: GeneratedEnvironmentCommandAdapters,
    policyDeclaration: Readonly<{ path: string; sha256: string }>,
    harnesses: readonly string[],
) {
    if (!manifest) return undefined
    const policyRead = await readAnchoredFile(prepared.root, policyDeclaration.path, MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
    if (policyRead.kind !== 'complete' || policyRead.sha256 !== policyDeclaration.sha256) return undefined
    let policyBytes: string
    try { policyBytes = new TextDecoder('utf-8', { fatal: true }).decode(policyRead.bytes) } catch { /* undecodable bytes are malformed input the caller refuses. */ return undefined }
    const policy: NativeHookPolicy = {
        manifest,
        authority: { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath },
        declarations: [],
        path: policyDeclaration.path,
        exists: true,
        bytes: policyBytes,
    }
    const source = { path: policyDeclaration.path, sha256: policyRead.sha256, identity: policyRead.identity }
    const environment = adapters.observationEnv ?? process.env
    const search = observationSearchPath(environment)
    const git = search.state === 'available' ? await resolveGitExecutable({ ...environment, PATH: search.path }) : search
    if (git.state !== 'available') return {
        projection: { kind: 'refusal' as const, reason: git.reason },
        source,
    }
    const revisionStep = snapshotExecutionStep({
        id: 'native-hook-revisions',
        argv: [git.value.invocationPath, 'rev-list', '--max-count=2', 'HEAD'],
        argv0: git.value.invocationPath,
        cwd: prepared.root,
        env: {},
        timeoutMs: HELPER_TIMEOUT_MS,
        spawnNotAfter: new Date(Date.now() + HELPER_TIMEOUT_MS).toISOString(),
        stdoutLimitBytes: 256,
        stderrLimitBytes: 4_096,
        paths: [prepared.root],
        ports: [],
        labels: { action: 'native-hook-revisions' },
        expected: [],
        consumedFiles: [{ path: git.value.canonicalPath, sha256: git.value.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
            argvIndexes: [0], executable: true, executionMode: git.value.executionMode }],
        filesystemChecks: [{ path: prepared.root, expected: 'directory' }],
        compensation: [],
    })
    if (!revisionStep) return undefined
    const revisionOutcome = authenticatedExecutionOutcome(await adapters.execute(revisionStep), revisionStep)
    if (!revisionOutcome || revisionOutcome.kind !== 'complete' || revisionOutcome.stderr.byteLength !== 0) return undefined
    let revisions: string[]
    try { revisions = new TextDecoder('utf-8', { fatal: true }).decode(revisionOutcome.stdout).trim().split('\n') } catch { /* undecodable bytes are malformed input the caller refuses. */ return undefined }
    if (revisions.length !== 2 || revisions[0] === revisions[1]
        || revisions.some(value => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || !/[1-9a-f]/.test(value))) return undefined
    let scratch: string | undefined
    let scratchIdentity: DirectoryIdentity | undefined
    try {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-hook-cost-')))
        const status = await lstat(scratch)
        if (!status.isDirectory() || status.isSymbolicLink()) return undefined
        scratchIdentity = { dev: status.dev, ino: status.ino }
        const shell = await resolveExecutablePath('/bin/sh')
        if (shell.state !== 'available') return undefined
        const projection = await projectNativeHooks({
            cockpitId: prepared.cockpitId,
            harnesses,
            install: 'explicit-native',
            budget: {
                policy,
                prepareMeasurement: async (entry: NativeHookEntry) => {
                    const path = join(scratch!, 'pre-push')
                    await writeFile(path, entry.bytes, { flag: 'wx', mode: 0o700 })
                    await chmod(path, 0o700)
                    const step = snapshotExecutionStep({
                        id: 'native-hook-cost',
                        argv: [shell.value.canonicalPath, '-c', NATIVE_HOOK_COST_SCRIPT, 'native-hook-cost', path, revisions[0]!, revisions[1]!],
                        argv0: shell.value.canonicalPath,
                        cwd: prepared.root,
                        env: { PATH: dirname(git.value.canonicalPath) },
                        timeoutMs: NATIVE_HOOK_COST_TIMEOUT_MS,
                        spawnNotAfter: new Date(Date.now() + HELPER_TIMEOUT_MS).toISOString(),
                        stdoutLimitBytes: 4_096,
                        stderrLimitBytes: 4_096,
                        paths: [prepared.root, scratch!],
                        ports: [],
                        labels: { action: 'native-hook-cost' },
                        expected: [],
                        consumedFiles: [
                            { path: shell.value.canonicalPath, sha256: shell.value.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
                                argvIndexes: [0], executable: true, executionMode: shell.value.executionMode },
                            { path, sha256: entry.sha256, maxBytes: Buffer.byteLength(entry.bytes), argvIndexes: [4], executable: false },
                        ],
                        filesystemChecks: [{ path: prepared.root, expected: 'directory' }, { path: scratch!, expected: 'directory' }],
                        compensation: [],
                    })
                    if (!step) throw new RefusalError('native hook cost measurement could not be admitted')
                    return step
                },
            },
        })
        return {
            projection,
            source,
        }
    } finally {
        if (scratch && scratchIdentity) {
            try {
                const current = await lstat(scratch)
                if (current.isDirectory() && !current.isSymbolicLink()
                    && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) {
                    await rm(scratch, { recursive: true, force: true })
                }
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error
            }
        }
    }
}
