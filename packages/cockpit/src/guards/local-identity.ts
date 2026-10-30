// Owns the machine-local guard identity file: its path, its bytes and how `sync` writes it.
// Tracked guard bytes must be identical on every clone, so everything that names this machine
// (Node, the installed cockpit module, root and configuration device and inode numbers) lives here,
// in a directory that ignores itself. It decides nothing: the guard application authenticates the
// file against the running process and the published surfaces before any policy is resolved.
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readBoundedInput } from '../config/load.js'

export const mechanism = {
    id: 'guard-local-identity', module: 'packages/cockpit/src/guards/local-identity.ts',
    exports: ['GUARD_LOCAL_PATHS', 'encodeGuardLocalIdentity', 'parseGuardLocalIdentity', 'writeGuardLocalIdentity'],
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
