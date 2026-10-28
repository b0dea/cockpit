// Owns the machine-local guard identity file: its path, its bytes and how `sync` writes it.
// Tracked guard bytes must be identical on every clone, so everything that names this machine
// (Node, the installed cockpit module, root and configuration device and inode numbers) lives here,
// in a directory that ignores itself. It decides nothing: the guard application authenticates the
// file against the running process and the published surfaces before any policy is resolved.
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readBoundedInput } from '../config/load.js'

export const mechanism = {
    id: 'guard-local-identity', module: 'packages/cockpit/src/guards/local-identity.ts',
    exports: ['GUARD_LOCAL_PATHS', 'encodeGuardLocalIdentity', 'parseGuardLocalIdentity', 'observeGuardLocalRemoval', 'removeObservedGuardLocal', 'writeGuardLocalIdentity'],
} as const

export interface GuardHandlerIdentity {
    readonly root: string
    readonly rootDevice: string
    readonly rootInode: string
    readonly configPath: string
    readonly configSha256: string
    readonly configDevice: string
    readonly configInode: string
    readonly node: string
    readonly nodeSha256: string
    /** The stat fingerprint of the Node file `sync` hashed; while it holds, the guard skips re-hashing. */
    readonly nodeFingerprint: string
    readonly module: string
    readonly moduleSha256: string
}

export const GUARD_LOCAL_PATHS = Object.freeze({
    directory: '.cockpit/local',
    identity: '.cockpit/local/guard-identity',
    ignore: '.cockpit/local/.gitignore',
} as const)

// The guard script reads this file with `read` one line at a time, so the layout is lines rather
// than JSON: a format line, the two executables it launches, then the identity the application checks.
const FORMAT = 'cockpit-guard-local/v1'
const LOCAL_FILE_MAX_BYTES = 65_536
const KEYS = ['root', 'rootDevice', 'rootInode', 'configPath', 'configSha256', 'configDevice', 'configInode',
    'node', 'nodeSha256', 'nodeFingerprint', 'module', 'moduleSha256'] as const satisfies readonly (keyof GuardHandlerIdentity)[]
const IGNORE_BYTES = '# cockpit-owned: machine-local guard identity, written by `cockpit sync`, never committed\n*\n'

export interface GuardLocalRemoval {
    readonly parent: string
    readonly parentDevice: string
    readonly parentInode: string
    readonly directory: string
    readonly directoryDevice: string
    readonly directoryInode: string
    readonly identity: string
    readonly identityDevice: string
    readonly identityInode: string
    readonly identitySha256: string
    readonly ignore: string
    readonly ignoreDevice: string
    readonly ignoreInode: string
}

export function encodeGuardLocalIdentity(identity: GuardHandlerIdentity): string {
    const ordered = Object.fromEntries(KEYS.map(key => [key, identity[key]]))
    return `${FORMAT}\n${identity.node}\n${identity.module}\n${JSON.stringify(ordered)}\n`
}

/** The exact identity the bytes carry, or undefined when they are not a complete current-format file. */
export function parseGuardLocalIdentity(bytes: string): GuardHandlerIdentity | undefined {
    const lines = bytes.split('\n')
    if (lines.length !== 5 || lines[0] !== FORMAT || lines[4] !== '') return undefined
    let value: unknown
    try { value = JSON.parse(lines[3]!) } catch { return undefined }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== KEYS.length || !KEYS.every(key => typeof record[key] === 'string')) return undefined
    const identity = record as unknown as GuardHandlerIdentity
    return identity.node === lines[1] && identity.module === lines[2] && encodeGuardLocalIdentity(identity) === bytes ? identity : undefined
}

function fingerprint(status: Awaited<ReturnType<typeof lstat>>): Readonly<{ device: string; inode: string }> {
    return Object.freeze({ device: String(status.dev), inode: String(status.ino) })
}

type LocalFileObservation = Readonly<{ kind: 'complete'; status: Awaited<ReturnType<typeof lstat>>; bytes: Buffer }>
    | Readonly<{ kind: 'absent' | 'invalid' }>

async function observeLocalFile(path: string): Promise<LocalFileObservation> {
    try {
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink() || before.size > LOCAL_FILE_MAX_BYTES) return { kind: 'invalid' }
        const read = await readBoundedInput(path)
        if (read.kind !== 'complete' || read.bytes.length > LOCAL_FILE_MAX_BYTES) return { kind: 'invalid' }
        const after = await lstat(path)
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
            || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return { kind: 'invalid' }
        return { kind: 'complete', status: after, bytes: read.bytes }
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid' }
    }
}

/** Observe the exact sync-owned local directory before a wider uninstall transaction mutates anything. */
export async function observeGuardLocalRemoval(root: string, configPath: string, configSha256: string): Promise<
    { readonly kind: 'absent' } | { readonly kind: 'complete'; readonly observation: GuardLocalRemoval } | { readonly kind: 'refusal'; readonly message: string }
> {
    const parent = join(root, '.cockpit')
    const directory = join(root, GUARD_LOCAL_PATHS.directory)
    let directoryStatus: Awaited<ReturnType<typeof lstat>>
    try {
        const parentStatus = await lstat(parent)
        if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) return { kind: 'refusal', message: '.cockpit is not a plain directory' }
        directoryStatus = await lstat(directory)
        const parentIdentity = fingerprint(parentStatus)
        const result = await observeGuardLocalDirectory(root, configPath, configSha256, parent, parentIdentity, directory, directoryStatus)
        return result
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
        return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} could not be observed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
    }
}

async function observeGuardLocalDirectory(
    root: string,
    configPath: string,
    configSha256: string,
    parent: string,
    parentIdentity: Readonly<{ device: string; inode: string }>,
    directory: string,
    directoryStatus: Awaited<ReturnType<typeof lstat>>,
): Promise<{ readonly kind: 'complete'; readonly observation: GuardLocalRemoval } | { readonly kind: 'refusal'; readonly message: string }> {
    try {
        if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} is not a plain directory` }
        const names = (await readdir(directory)).sort()
        if (names.join('\n') !== '.gitignore\nguard-identity') return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} contains files cockpit does not own` }
        const identityPath = join(root, GUARD_LOCAL_PATHS.identity)
        const ignorePath = join(root, GUARD_LOCAL_PATHS.ignore)
        const [identityFile, ignoreFile] = await Promise.all([observeLocalFile(identityPath), observeLocalFile(ignorePath)])
        if (identityFile.kind !== 'complete' || ignoreFile.kind !== 'complete') {
            return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} contains a non-regular cockpit file` }
        }
        const identityBytes = identityFile.bytes.toString('utf8')
        const ignoreBytes = ignoreFile.bytes.toString('utf8')
        const identity = parseGuardLocalIdentity(identityBytes)
        if (!identity || identity.root !== root || identity.configPath !== configPath || identity.configSha256 !== configSha256 || ignoreBytes !== IGNORE_BYTES) {
            return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} does not contain the current cockpit identity` }
        }
        const directoryIdentity = fingerprint(directoryStatus)
        const identityIdentity = fingerprint(identityFile.status)
        const ignoreIdentity = fingerprint(ignoreFile.status)
        return { kind: 'complete', observation: Object.freeze({
            parent, parentDevice: parentIdentity.device, parentInode: parentIdentity.inode,
            directory, directoryDevice: directoryIdentity.device, directoryInode: directoryIdentity.inode,
            identity: identityPath, identityDevice: identityIdentity.device, identityInode: identityIdentity.inode,
            identitySha256: createHash('sha256').update(identityBytes).digest('hex'),
            ignore: ignorePath, ignoreDevice: ignoreIdentity.device, ignoreInode: ignoreIdentity.inode,
        }) }
    } catch (error) {
        return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} could not be observed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
    }
}

async function directoryStillMatches(path: string, device: string, inode: string): Promise<boolean> {
    const status = await lstat(path)
    return status.isDirectory() && !status.isSymbolicLink()
        && String(status.dev) === device && String(status.ino) === inode
}

/** Remove only a previously observed exact local identity. */
export async function removeObservedGuardLocal(observation: GuardLocalRemoval): Promise<{ readonly kind: 'complete' } | { readonly kind: 'refusal'; readonly message: string }> {
    try {
        if (!await directoryStillMatches(observation.parent, observation.parentDevice, observation.parentInode)
            || !await directoryStillMatches(observation.directory, observation.directoryDevice, observation.directoryInode)) {
            return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} changed after it was observed` }
        }
        if ((await readdir(observation.directory)).sort().join('\n') !== '.gitignore\nguard-identity') {
            return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} gained files cockpit does not own` }
        }
        const [identity, ignore] = await Promise.all([observeLocalFile(observation.identity), observeLocalFile(observation.ignore)])
        if (identity.kind !== 'complete' || ignore.kind !== 'complete'
            || String(identity.status.dev) !== observation.identityDevice || String(identity.status.ino) !== observation.identityInode
            || String(ignore.status.dev) !== observation.ignoreDevice || String(ignore.status.ino) !== observation.ignoreInode
            || createHash('sha256').update(identity.bytes).digest('hex') !== observation.identitySha256
            || ignore.bytes.toString('utf8') !== IGNORE_BYTES) {
            return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} changed after it was observed` }
        }
        await unlink(observation.identity)
        await unlink(observation.ignore)
        await rmdir(observation.directory)
        return { kind: 'complete' }
    } catch (error) {
        return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.directory} could not be removed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
    }
}

async function directoryAt(path: string, create: boolean): Promise<string | undefined> {
    try {
        const status = await lstat(path)
        return status.isDirectory() && !status.isSymbolicLink() ? undefined : `${path} is not a plain directory`
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) return `${path} is unavailable (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`
    }
    await mkdir(path, { mode: 0o700 })
    return directoryAt(path, false)
}

// Rename replaces a planted symlink at the destination instead of writing through it.
async function replaceFile(directory: string, name: string, bytes: string): Promise<void> {
    const temporary = join(directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
    try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(directory, name))
    } finally {
        await rm(temporary, { force: true })
    }
}

/** Publish the identity after the tracked surfaces it authenticates; the reason names what failed. */
export async function writeGuardLocalIdentity(root: string, identity: GuardHandlerIdentity): Promise<{ readonly kind: 'complete' } | { readonly kind: 'refusal'; readonly message: string }> {
    try {
        const parent = await directoryAt(join(root, '.cockpit'), false)
        if (parent) return { kind: 'refusal', message: parent }
        const directory = join(root, GUARD_LOCAL_PATHS.directory)
        const local = await directoryAt(directory, true)
        if (local) return { kind: 'refusal', message: local }
        const ignore = join(root, GUARD_LOCAL_PATHS.ignore)
        const currentIgnore = await observeLocalFile(ignore)
        if (currentIgnore.kind !== 'complete' || currentIgnore.bytes.toString('utf8') !== IGNORE_BYTES) {
            await replaceFile(directory, '.gitignore', IGNORE_BYTES)
        }
        await replaceFile(directory, 'guard-identity', encodeGuardLocalIdentity(identity))
        return { kind: 'complete' }
    } catch (error) {
        return { kind: 'refusal', message: `${GUARD_LOCAL_PATHS.identity} could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
    }
}
