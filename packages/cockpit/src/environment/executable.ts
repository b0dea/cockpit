import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, normalize, win32 } from 'node:path'

export const mechanism = {
    id: 'resolved-executable-identity',
    module: 'packages/cockpit/src/environment/executable.ts',
    exports: ['GUARD_EXECUTABLE_SEARCH_PATH', 'resolvedExecutable', 'resolvedDockerExecutable', 'resolvedGitExecutable', 'isResolvedExecutable', 'isResolvedDockerExecutable', 'isResolvedGitExecutable', 'resolveExecutable', 'resolveExecutablePath', 'resolveDiskCapacityExecutable', 'resolveDockerExecutable', 'resolveGitExecutable', 'resolvePathRemovalExecutable'],
} as const

// A guard runs inside the agent's hook with an environment the agent controls, so the tools it
// observes with are found on this fixed search path rather than the inherited PATH.
export const GUARD_EXECUTABLE_SEARCH_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'

export interface ResolvedExecutable {
    readonly canonicalPath: string
    readonly invocationPath: string
    readonly sha256: string
    readonly executionMode: 'staged' | 'verified-path'
}

const SHA256 = /^[a-f0-9]{64}$/
type HostPolicy = 'posix' | 'windows'

function currentHostPolicy(): HostPolicy {
    return process.platform === 'win32' ? 'windows' : 'posix'
}

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
            && (executionMode === 'staged' || executionMode === 'verified-path')
            ? Object.freeze({ canonicalPath, invocationPath, sha256, executionMode })
            : undefined
    } catch {
        return undefined
    }
}

export function isResolvedExecutable(value: unknown): boolean {
    return resolvedExecutable(value) !== undefined
}

export function resolvedDockerExecutable(value: unknown): ResolvedExecutable | undefined {
    const executable = resolvedExecutable(value)
    const host = currentHostPolicy()
    const name = executable && (host === 'windows'
        ? win32.basename(executable.invocationPath).toLowerCase()
        : basename(executable.invocationPath))
    const accepted = host === 'windows' ? name === 'docker.exe' || name === 'docker.com' : name === 'docker'
    return executable !== undefined && accepted && executable.executionMode === 'staged'
        ? executable : undefined
}

export function isResolvedDockerExecutable(value: unknown): boolean {
    return resolvedDockerExecutable(value) !== undefined
}

export function resolvedGitExecutable(value: unknown): ResolvedExecutable | undefined {
    const executable = resolvedExecutable(value)
    const host = currentHostPolicy()
    const name = executable && (host === 'windows'
        ? win32.basename(executable.invocationPath).toLowerCase()
        : basename(executable.invocationPath))
    const accepted = host === 'windows' ? name === 'git.exe' || name === 'git.com' : name === 'git'
    return executable !== undefined && accepted ? executable : undefined
}

export function isResolvedGitExecutable(value: unknown): boolean {
    return resolvedGitExecutable(value) !== undefined
}

export type ExecutableResolution = Readonly<{ state: 'available'; value: ResolvedExecutable }>
    | Readonly<{ state: 'unavailable'; reason: string }>

const EXECUTABLE_BYTE_LIMIT = 536_870_912
const PATH_ENTRY_LIMIT = 256

type SearchEnvironmentSelection = Readonly<{ kind: 'selected'; path: unknown; pathExt: unknown }>
    | Readonly<{ kind: 'ambiguous'; name: 'PATH' | 'PATHEXT' }>
    | Readonly<{ kind: 'unreadable' }>

function selectSearchEnvironment(env: Readonly<Record<string, string | undefined>>, host: HostPolicy): SearchEnvironmentSelection {
    let pathName = 'PATH'
    let pathExtName: string | undefined
    if (host === 'windows') {
        let keys: string[]
        try { keys = Object.keys(env) } catch { return { kind: 'unreadable' } }
        const pathNames = keys.filter((candidate) => candidate.toUpperCase() === 'PATH')
        const pathExtNames = keys.filter((candidate) => candidate.toUpperCase() === 'PATHEXT')
        if (pathNames.length > 1) return { kind: 'ambiguous', name: 'PATH' }
        if (pathExtNames.length > 1) return { kind: 'ambiguous', name: 'PATHEXT' }
        if (pathNames[0] !== undefined) pathName = pathNames[0]
        pathExtName = pathExtNames[0]
    }
    try {
        return { kind: 'selected', path: env[pathName], pathExt: pathExtName === undefined ? undefined : env[pathExtName] }
    } catch { return { kind: 'unreadable' } }
}

type WindowsCandidate = Readonly<{ kind: 'native' | 'batch'; path: string }>
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'invalid'; reason: string }>

const WINDOWS_EXECUTABLE_SUFFIXES: ReadonlyMap<string, 'native' | 'batch'> = new Map([
    ['.exe', 'native'],
    ['.com', 'native'],
    ['.cmd', 'batch'],
    ['.bat', 'batch'],
] as const)

function windowsDriveAbsolute(path: string): boolean {
    return /^[A-Za-z]:\\/.test(path) && win32.normalize(path) === path
}

function windowsCandidateKind(name: string): 'native' | 'batch' | undefined {
    return WINDOWS_EXECUTABLE_SUFFIXES.get(win32.extname(name).toLowerCase())
}

async function inspectWindowsCandidate(path: string, kind: 'native' | 'batch'): Promise<WindowsCandidate> {
    try {
        const status = await lstat(path)
        return status.isFile() || status.isSymbolicLink()
            ? Object.freeze({ kind, path })
            : Object.freeze({ kind: 'invalid', reason: `Windows executable candidate is not a file: ${path}` })
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? Object.freeze({ kind: 'absent' })
            : Object.freeze({ kind: 'invalid', reason: `Windows executable candidate could not be inspected: ${path}` })
    }
}

async function selectWindowsCandidate(
    name: string,
    env: Readonly<Record<string, string | undefined>>,
    host: HostPolicy,
): Promise<WindowsCandidate> {
    if (Buffer.byteLength(name) > 4_096 || name.includes('\0')) {
        return { kind: 'invalid', reason: 'Windows executable name is invalid' }
    }
    if (windowsDriveAbsolute(name)) {
        const kind = windowsCandidateKind(name)
        return kind ? inspectWindowsCandidate(name, kind)
            : { kind: 'invalid', reason: 'Windows executable name has an unsupported suffix' }
    }
    if (win32.isAbsolute(name) || win32.basename(name) !== name || name.includes('/') || name.includes('\\')) {
        return { kind: 'invalid', reason: 'Windows executable name must be drive-absolute or a PATH entry name' }
    }

    const selected = selectSearchEnvironment(env, host)
    if (selected.kind === 'unreadable') return { kind: 'invalid', reason: 'Executable search environment is not readable' }
    if (selected.kind === 'ambiguous') return { kind: 'invalid', reason: `Executable search environment has ambiguous ${selected.name} spellings` }
    const pathValue = selected.path
    if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.includes('\0') || Buffer.byteLength(pathValue) > 65_536) {
        return { kind: 'invalid', reason: 'Windows executable search path is missing or invalid' }
    }
    const directories = pathValue.split(';')
    if (directories.length > PATH_ENTRY_LIMIT || directories.some(path => !path || !windowsDriveAbsolute(path))) {
        return { kind: 'invalid', reason: 'Windows executable search path must contain bounded drive-absolute directories' }
    }

    const explicitKind = windowsCandidateKind(name)
    const extension = win32.extname(name)
    if (extension && !explicitKind) return { kind: 'invalid', reason: 'Windows executable name has an unsupported suffix' }
    let suffixes: readonly Readonly<{ bytes: string; kind: 'native' | 'batch' }>[]
    if (explicitKind) {
        suffixes = [{ bytes: '', kind: explicitKind }]
    } else {
        const pathExtValue = selected.pathExt
        if (typeof pathExtValue !== 'string' || pathExtValue.length === 0 || pathExtValue.includes('\0')
            || Buffer.byteLength(pathExtValue) > 65_536) {
            return { kind: 'invalid', reason: 'Windows PATHEXT is missing or invalid' }
        }
        const entries = pathExtValue.split(';')
        if (entries.length > PATH_ENTRY_LIMIT || entries.some(entry => !entry || !WINDOWS_EXECUTABLE_SUFFIXES.has(entry.toLowerCase()))) {
            return { kind: 'invalid', reason: 'Windows PATHEXT contains an unsupported executable suffix' }
        }
        suffixes = entries.map(bytes => Object.freeze({
            bytes,
            kind: WINDOWS_EXECUTABLE_SUFFIXES.get(bytes.toLowerCase())!,
        }))
    }

    for (const directory of directories) {
        for (const suffix of suffixes) {
            const candidate = win32.join(directory, `${name}${suffix.bytes}`)
            const inspected = await inspectWindowsCandidate(candidate, suffix.kind)
            if (inspected.kind !== 'absent') return inspected
        }
    }
    return { kind: 'absent' }
}

function windowsCandidateResolution(candidate: WindowsCandidate, name: string): ExecutableResolution {
    if (candidate.kind === 'invalid') return unavailable(candidate.reason)
    if (candidate.kind === 'absent') return unavailable(`Windows executable was not found in the supplied search path: ${name}`)
    return candidate.kind === 'batch'
        ? unavailable(`Windows batch executable requires an authenticated command interpreter: ${candidate.path}`)
        : unavailable(`Windows native executable identity authority is unavailable: ${candidate.path}`)
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
        await file.close()
        file = undefined
        return sha256
    } catch {
        return undefined
    } finally {
        try { await file?.close() } catch { /* The caller receives unavailable; no descriptor authority survives. */ }
    }
}

export async function resolveExecutablePath(path: string): Promise<ExecutableResolution> {
    const host = currentHostPolicy()
    if (host === 'windows') return unavailable('Windows direct-path executable identity authority is unavailable')
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
        return unavailable('Executable path must be an exact absolute path')
    }
    let invocation
    try { invocation = await lstat(path) } catch { return unavailable(`Executable is unavailable: ${path}`) }
    if (!(invocation.isFile() || invocation.isSymbolicLink()) || invocation.isFile() && (invocation.mode & 0o111) === 0) {
        return unavailable(`Executable is unavailable: ${path}`)
    }
    let canonicalPath: string
    try { canonicalPath = await realpath(path) } catch { return unavailable(`Executable is unavailable: ${path}`) }
    const sha256 = await digestRegularFile(canonicalPath)
    if (sha256 === undefined) return unavailable(`Executable identity is unavailable: ${path}`)
    const value = resolvedExecutable({ canonicalPath, invocationPath: path, sha256, executionMode: 'verified-path' })
    return value ? Object.freeze({ state: 'available', value }) : unavailable(`Executable identity is invalid: ${path}`)
}

export async function resolveExecutable(name: string, env: Readonly<Record<string, string | undefined>>): Promise<ExecutableResolution> {
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return unavailable('Executable name is invalid')
    const host = currentHostPolicy()
    if (host === 'windows') return windowsCandidateResolution(await selectWindowsCandidate(name, env, host), name)
    if (isAbsolute(name)) return resolveExecutablePath(name)
    if (basename(name) !== name) return unavailable('Executable name must be absolute or a PATH entry name')
    const selected = selectSearchEnvironment(env, host)
    if (selected.kind === 'unreadable') return unavailable('Executable search path is not readable')
    if (selected.kind === 'ambiguous') return unavailable(`Executable search environment has ambiguous ${selected.name} spellings`)
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
    const host = currentHostPolicy()
    if (host === 'windows') return windowsCandidateResolution(await selectWindowsCandidate('git', env, host), 'git')
    const selected = selectSearchEnvironment(env, host)
    if (selected.kind === 'unreadable') return unavailable('Git executable search path is not readable')
    if (selected.kind === 'ambiguous') return unavailable(`Executable search environment has ambiguous ${selected.name} spellings`)
    const pathValue = selected.path
    if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.includes('\0') || Buffer.byteLength(pathValue) > 65_536) {
        return unavailable('Git executable search path is missing or invalid')
    }
    const directories = pathValue.split(delimiter)
    if (directories.length > PATH_ENTRY_LIMIT || directories.some((path) => !isAbsolute(path) || normalize(path) !== path)) {
        return unavailable('Git executable search path must contain bounded absolute directories')
    }
    for (const directory of directories) {
        const invocationPath = join(directory, 'git')
        let invocation
        try { invocation = await lstat(invocationPath) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            continue
        }
        if (!(invocation.isFile() || invocation.isSymbolicLink()) || (invocation.isFile() && (invocation.mode & 0o111) === 0)) {
            continue
        }
        let canonicalPath: string
        try { canonicalPath = await realpath(invocationPath) } catch { continue }
        const sha256 = await digestRegularFile(canonicalPath)
        if (sha256 === undefined) continue
        const value = Object.freeze({ canonicalPath, invocationPath, sha256, executionMode: 'verified-path' as const })
        return isResolvedGitExecutable(value) ? Object.freeze({ state: 'available', value }) : unavailable('Git executable identity is invalid')
    }
    return unavailable('Git executable was not found in the supplied search path')
}

export async function resolveDiskCapacityExecutable(): Promise<ExecutableResolution> {
    return resolveExecutablePath(process.execPath)
}

export async function resolveDockerExecutable(env: Readonly<Record<string, string | undefined>>): Promise<ExecutableResolution> {
    const host = currentHostPolicy()
    if (host === 'windows') return windowsCandidateResolution(await selectWindowsCandidate('docker', env, host), 'docker')
    const selected = selectSearchEnvironment(env, host)
    if (selected.kind === 'unreadable') return unavailable('Docker executable search path is not readable')
    if (selected.kind === 'ambiguous') return unavailable(`Executable search environment has ambiguous ${selected.name} spellings`)
    const pathValue = selected.path
    if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.includes('\0') || Buffer.byteLength(pathValue) > 65_536) {
        return unavailable('Docker executable search path is missing or invalid')
    }
    const directories = pathValue.split(delimiter)
    if (directories.length > PATH_ENTRY_LIMIT || directories.some((path) => !isAbsolute(path) || normalize(path) !== path)) {
        return unavailable('Docker executable search path must contain bounded absolute directories')
    }
    for (const directory of directories) {
        const invocationPath = join(directory, 'docker')
        let invocation
        try { invocation = await lstat(invocationPath) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            continue
        }
        if (!(invocation.isFile() || invocation.isSymbolicLink()) || (invocation.isFile() && (invocation.mode & 0o111) === 0)) {
            continue
        }
        let canonicalPath: string
        try { canonicalPath = await realpath(invocationPath) } catch { continue }
        const sha256 = await digestRegularFile(canonicalPath)
        if (sha256 === undefined) continue
        const value = Object.freeze({ canonicalPath, invocationPath, sha256, executionMode: 'staged' as const })
        return isResolvedDockerExecutable(value) ? Object.freeze({ state: 'available', value }) : unavailable('Docker executable identity is invalid')
    }
    return unavailable('Docker executable was not found in the supplied search path')
}

export async function resolvePathRemovalExecutable(): Promise<ExecutableResolution> {
    return resolveExecutablePath('/bin/rm')
}
