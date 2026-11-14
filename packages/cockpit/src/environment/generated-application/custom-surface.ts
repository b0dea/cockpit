import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { authenticatedExecutionOutcome } from '../../environment-exec/execute.js'
import type { OwnershipManifest } from '../../surfaces/ownership.js'
import { readAnchoredFile, type DirectoryIdentity } from '../../generated-environment/transaction.js'
import { snapshotExecutionStep, RefusalError, hasErrorCode } from '../contract.js'
import { observationEnvironment, resolveExecutablePath, resolveGitExecutable } from '../executable.js'
import { NATIVE_HOOK_COST_SCRIPT, projectNativeHooks, type NativeHookEntry, type NativeHookPolicy } from '../../testing/hooks.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    HELPER_TIMEOUT_MS,
    MAX_EXECUTABLE_BYTES,
    MAX_SURFACE_FILE_BYTES,
    NATIVE_HOOK_COST_TIMEOUT_MS,
    type PreparedEnvironment,
} from './shared.js'

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
    const search = observationEnvironment(adapters.observationEnv ?? process.env)
    const git = search.state === 'available' ? await resolveGitExecutable(search.env) : search
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
