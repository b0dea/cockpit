import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, normalize } from 'node:path'
import { errorCause } from './contract.js'
import { fileFingerprint, recordVerifiedDigest, verifiedDigest } from '../environment-exec/verified-digest.js'

export const mechanism = {
    id: 'resolved-executable-identity',
    module: 'packages/cockpit/src/environment/executable.ts',
    exports: ['GUARD_EXECUTABLE_SEARCH_PATH', 'resolvedExecutable', 'resolvedDockerExecutable', 'resolvedGitExecutable', 'isResolvedExecutable', 'isResolvedDockerExecutable', 'isResolvedGitExecutable', 'resolveExecutable', 'resolveExecutablePath', 'resolveDiskCapacityExecutable', 'resolveDockerExecutable', 'resolveGitExecutable', 'resolvePathRemovalExecutable'],
} as const

// A guard runs inside the agent's hook with an environment the agent controls, so the tools it
// observes with are found on this fixed search path rather than the inherited PATH.
export const GUARD_EXECUTABLE_SEARCH_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'

// Every executable runs from its own path. The executor re-checks the file's identity and digest
// immediately before each spawn, and the process-wide digest memo makes that re-check cost a stat
// unless the file's device, inode, size, mode or times moved. Docker used to be copied into a
// private snapshot and re-hashed before every call; on a 74 MB client that cost one to two seconds
// per call and made `down` take minutes. The snapshot only closed the instant between the final
// check and spawn against a same-user writer, which the executor's cooperative-filesystem model
// does not defend for Git or Node either.
export interface ResolvedExecutable {
    readonly canonicalPath: string
    readonly invocationPath: string
    readonly sha256: string
    readonly executionMode: 'verified-path'
}

const SHA256 = /^[a-f0-9]{64}$/

function exactKeys(value: object, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const keys = [...expected].sort()
    return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

export function resolvedExecutable(value: unknown): ResolvedExecutable | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)
            || !exactKeys(value, ['canonicalPath', 'invocationPath', 'sha256', 'executionMode'])) return undefined
        const { canonicalPath, invocationPath, sha256, executionMode } = value as Partial<ResolvedExecutable>
        return typeof canonicalPath === 'string' && isAbsolute(canonicalPath) && normalize(canonicalPath) === canonicalPath
            && !canonicalPath.includes('\0') && typeof invocationPath === 'string' && isAbsolute(invocationPath)
            && normalize(invocationPath) === invocationPath && !invocationPath.includes('\0')
            && typeof sha256 === 'string' && SHA256.test(sha256)
            && executionMode === 'verified-path'
            ? Object.freeze({ canonicalPath, invocationPath, sha256, executionMode })
            : undefined
    } catch {
        // A throwing accessor or proxy trap means the identity is malformed.
        return undefined
    }
}

export function isResolvedExecutable(value: unknown): boolean {
    return resolvedExecutable(value) !== undefined
}

export function resolvedDockerExecutable(value: unknown): ResolvedExecutable | undefined {
    const executable = resolvedExecutable(value)
    return executable !== undefined && basename(executable.invocationPath) === 'docker' ? executable : undefined
}

export function isResolvedDockerExecutable(value: unknown): boolean {
    return resolvedDockerExecutable(value) !== undefined
}

export function resolvedGitExecutable(value: unknown): ResolvedExecutable | undefined {
    const executable = resolvedExecutable(value)
    return executable !== undefined && basename(executable.invocationPath) === 'git' ? executable : undefined
}

export function isResolvedGitExecutable(value: unknown): boolean {
    return resolvedGitExecutable(value) !== undefined
}

export type ExecutableResolution = Readonly<{ state: 'available'; value: ResolvedExecutable }>
    | Readonly<{ state: 'unavailable'; reason: string }>

const EXECUTABLE_BYTE_LIMIT = 536_870_912
const PATH_ENTRY_LIMIT = 256

function searchPath(env: Readonly<Record<string, string | undefined>>): Readonly<{ kind: 'selected'; path: unknown }> | Readonly<{ kind: 'unreadable' }> {
    try { return { kind: 'selected', path: env.PATH } } catch { /* A throwing PATH getter means the environment is unreadable; the caller reports it as unavailable. */ return { kind: 'unreadable' } }
}

function unavailable(reason: string): ExecutableResolution {
    return Object.freeze({ state: 'unavailable', reason })
}

async function digestRegularFile(path: string): Promise<string | undefined> {
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(path)
        if (before.isSymbolicLink() || !before.isFile() || before.size > EXECUTABLE_BYTE_LIMIT || (before.mode & 0o111) === 0) return undefined
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await file.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > EXECUTABLE_BYTE_LIMIT) return undefined
        const fingerprint = fileFingerprint(path, opened)
        const remembered = verifiedDigest(fingerprint)
        if (remembered !== undefined) return fileFingerprint(path, await lstat(path)) === fingerprint ? remembered : undefined
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(1_048_576)
        let total = 0
        while (true) {
            const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.byteLength, EXECUTABLE_BYTE_LIMIT - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > EXECUTABLE_BYTE_LIMIT) return undefined
            hash.update(chunk.subarray(0, bytesRead))
        }
        const after = await file.stat()
        const linked = await lstat(path)
        const sha256 = total === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs
            && linked.dev === opened.dev && linked.ino === opened.ino && linked.size === opened.size && linked.mtimeMs === opened.mtimeMs
            ? hash.digest('hex')
            : undefined
        if (sha256 !== undefined && fileFingerprint(path, after) === fingerprint) recordVerifiedDigest(fingerprint, sha256)
        await file.close()
        file = undefined
        return sha256
    } catch {
        // Any read failure means no digest; the caller reports the executable identity as unavailable.
        return undefined
    } finally {
        try { await file?.close() } catch { /* The caller receives unavailable; no descriptor authority survives. */ }
    }
}

export async function resolveExecutablePath(path: string): Promise<ExecutableResolution> {
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
        return unavailable('Executable path must be an exact absolute path')
    }
    let invocation
    try { invocation = await lstat(path) } catch (error) { return unavailable(`Executable is unavailable: ${path}: ${errorCause(error)}`) }
    if (!(invocation.isFile() || invocation.isSymbolicLink()) || invocation.isFile() && (invocation.mode & 0o111) === 0) {
        return unavailable(`Executable is unavailable: ${path}`)
    }
    let canonicalPath: string
    try { canonicalPath = await realpath(path) } catch (error) { return unavailable(`Executable is unavailable: ${path}: ${errorCause(error)}`) }
    const sha256 = await digestRegularFile(canonicalPath)
    if (sha256 === undefined) return unavailable(`Executable identity is unavailable: ${path}`)
    const value = resolvedExecutable({ canonicalPath, invocationPath: path, sha256, executionMode: 'verified-path' })
    return value ? Object.freeze({ state: 'available', value }) : unavailable(`Executable identity is invalid: ${path}`)
}

export async function resolveExecutable(name: string, env: Readonly<Record<string, string | undefined>>): Promise<ExecutableResolution> {
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return unavailable('Executable name is invalid')
    if (isAbsolute(name)) return resolveExecutablePath(name)
    if (basename(name) !== name) return unavailable('Executable name must be absolute or a PATH entry name')
    const selected = searchPath(env)
    if (selected.kind === 'unreadable') return unavailable('Executable search path is not readable')
    const pathValue = selected.path
    if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.includes('\0') || Buffer.byteLength(pathValue) > 65_536) {
        return unavailable('Executable search path is missing or invalid')
    }
    const directories = pathValue.split(delimiter)
    if (directories.length > PATH_ENTRY_LIMIT || directories.some(path => !isAbsolute(path) || normalize(path) !== path)) {
        return unavailable('Executable search path must contain bounded absolute directories')
    }
    for (const directory of directories) {
        const result = await resolveExecutablePath(join(directory, name))
        if (result.state === 'available') return result
    }
    return unavailable(`Executable was not found in the supplied search path: ${name}`)
}

export async function resolveGitExecutable(env: Readonly<Record<string, string | undefined>>): Promise<ExecutableResolution> {
    return resolveExecutable('git', env)
}

export async function resolveDiskCapacityExecutable(): Promise<ExecutableResolution> {
    return resolveExecutablePath(process.execPath)
}

export async function resolveDockerExecutable(env: Readonly<Record<string, string | undefined>>): Promise<ExecutableResolution> {
    return resolveExecutable('docker', env)
}

export async function resolvePathRemovalExecutable(): Promise<ExecutableResolution> {
    return resolveExecutablePath('/bin/rm')
}
