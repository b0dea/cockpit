// Owns the machine-local guard identity file: its path, its bytes, how `sync` writes it and which
// installed cockpit it may name.
// Tracked guard bytes must be identical on every clone, so everything that names this machine
// (the Node path, the installed cockpit module, root and configuration inode numbers) lives here,
// in a directory that ignores itself. It decides nothing: the guard application authenticates the
// file against the running process and the published surfaces before any policy is resolved.
import { exactKeys } from '../exact-keys.js'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import { readBoundedFile } from '../bounded-read.js'
import { readBoundedInput } from '../config/load.js'
import { errorCause, hasErrorCode } from '../environment/contract.js'

export interface GuardHandlerIdentity {
    readonly root: string
    // No device number: macOS reassigns the APFS Data volume's on every boot, which held every agent
    // until a person ran sync. The canonical path and inode still tell a replaced checkout apart.
    readonly rootInode: string
    readonly configPath: string
    readonly configSha256: string
    readonly configInode: string
    /**
     * The Node the hook runs, by the path the search path of the sync that wrote this names it. Any Node
     * found there runs the guard: a terminal and an agent tool on different Node installs, or a Node
     * upgraded in place, held every guarded call until a person ran sync, and an agent able to replace
     * Node could as well replace the unhashed modules the handler imports.
     */
    readonly node: string
    /** The digest of the Node file sync ran, only to spare the guard re-hashing it while its fingerprint holds. */
    readonly nodeSha256: string
    readonly nodeFingerprint: string
    readonly module: string
    readonly moduleSha256: string
}

export const GUARD_LOCAL_PATHS = Object.freeze({
    directory: '.cockpit/local',
    identity: '.cockpit/local/guard-identity',
    // The exact configuration the guards were generated from, so a later edit can be compared with it.
    generatedConfig: '.cockpit/local/guard-config',
    ignore: '.cockpit/local/.gitignore',
} as const)

// The guard script reads this file with `read` one line at a time, so the layout is lines rather
// than JSON: a format line, the two executables it launches, then the identity the application checks.
export const GUARD_LOCAL_FORMAT = 'cockpit-guard-local/v1'
const FORMAT = GUARD_LOCAL_FORMAT
const LOCAL_FILE_MAX_BYTES = 65_536
const KEYS = ['root', 'rootInode', 'configPath', 'configSha256', 'configInode',
    'node', 'nodeSha256', 'nodeFingerprint', 'module', 'moduleSha256'] as const satisfies readonly (keyof GuardHandlerIdentity)[]
const IGNORE_BYTES = '# cockpit-owned: machine-local files, written by `cockpit sync`, never committed\n*\n'
const INSTALLED_HANDLER = 'node_modules/@b00dea/cockpit/dist/cli.js'

/** The canonical handler of the cockpit installed under `root`, or undefined when none is installed there. */
export function installedGuardHandler(root: string): string | undefined {
    try { return realpathSync(join(root, INSTALLED_HANDLER)) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return undefined
        throw error
    }
}

function describeHandler(handler: string): string {
    const directory = dirname(dirname(handler))
    let version: unknown
    try {
        const read = readBoundedFile(join(directory, 'package.json'), LOCAL_FILE_MAX_BYTES)
        if (read.kind === 'complete') version = (JSON.parse(read.bytes.toString('utf8')) as { version?: unknown } | null)?.version
    } catch (error) {
        // The version only words the message; without it the directory still names the copy.
        if (!(error instanceof SyntaxError) && !hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'ELOOP', 'EIO')) throw error
    }
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? `@b00dea/cockpit ${version} at ${directory}` : `the cockpit at ${directory}`
}

/**
 * What changed when the cockpit installed under `root` is no longer the handler sync bound the guard to,
 * or undefined while it is, or while none is installed there. A package manager that keeps each version
 * at its own path, as pnpm does, leaves the bound one in place after an upgrade, so its bytes still
 * authenticate and nothing else shows that the install moved on.
 */
export function guardHandlerSuperseded(root: string, bound: string): string | undefined {
    const installed = installedGuardHandler(root)
    if (installed === undefined || installed === bound) return undefined
    // A worktree bound to its main checkout's cockpit, outside the worktree, that later installs the same handler bytes
    // itself has not moved on: its guard still runs the cockpit it was bound to.
    const digest = (path: string) => {
        const read = readBoundedFile(path, 16_777_216)
        return read.kind === 'complete' ? createHash('sha256').update(read.bytes).digest('hex') : undefined
    }
    const outside = relative(root, bound).startsWith('..') || isAbsolute(relative(root, bound))
    try { if (outside && digest(installed) === digest(bound)) return undefined }
    catch (error) { if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR')) throw error }
    return `the installed cockpit changed since the guards were generated: sync bound the guard to ${describeHandler(bound)}, and ${describeHandler(installed)} is installed now`
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
    try { value = JSON.parse(lines[3]!) }
    catch (error) {
        if (error instanceof SyntaxError) return undefined // not the current format
        throw error
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (!exactKeys(record, KEYS) || !KEYS.every(key => typeof record[key] === 'string')) return undefined
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
        return hasErrorCode(error, 'ENOENT') ? { kind: 'absent' } : { kind: 'invalid' }
    }
}

async function directoryAt(path: string, create: boolean): Promise<string | undefined> {
    try {
        const status = await lstat(path)
        return status.isDirectory() && !status.isSymbolicLink() ? undefined : `${path} is not a plain directory`
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT') || !create) return `${path} is unavailable (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`
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

/**
 * Publish the identity after the tracked surfaces it authenticates, with the configuration text it
 * names written first; the reason names what failed.
 */
export async function writeGuardLocalIdentity(root: string, identity: GuardHandlerIdentity, configText: string): Promise<{ readonly kind: 'complete' } | { readonly kind: 'refusal'; readonly message: string }> {
    return writeCockpitLocalFiles(root, [{ name: basename(GUARD_LOCAL_PATHS.generatedConfig), bytes: configText },
        { name: basename(GUARD_LOCAL_PATHS.identity), bytes: encodeGuardLocalIdentity(identity) }])
}

/** Replace machine-local files under `.cockpit/local`, a directory that ignores itself; the reason names what failed. */
export async function writeCockpitLocalFiles(root: string, files: readonly Readonly<{ name: string; bytes: string }>[]): Promise<{ readonly kind: 'complete' } | { readonly kind: 'refusal'; readonly message: string }> {
    let current: string = GUARD_LOCAL_PATHS.directory
    try {
        const parent = await directoryAt(join(root, '.cockpit'), false)
        if (parent) return { kind: 'refusal', message: parent }
        const directory = join(root, GUARD_LOCAL_PATHS.directory)
        const local = await directoryAt(directory, true)
        if (local) return { kind: 'refusal', message: local }
        current = GUARD_LOCAL_PATHS.ignore
        const ignore = join(root, GUARD_LOCAL_PATHS.ignore)
        const currentIgnore = await observeLocalFile(ignore)
        if (currentIgnore.kind !== 'complete' || currentIgnore.bytes.toString('utf8') !== IGNORE_BYTES) {
            await replaceFile(directory, '.gitignore', IGNORE_BYTES)
        }
        for (const file of files) {
            current = `${GUARD_LOCAL_PATHS.directory}/${file.name}`
            if (!/^[a-z0-9][a-z0-9-]*$/.test(file.name)) return { kind: 'refusal', message: `${current} is not a plain local file name` }
            await replaceFile(directory, file.name, file.bytes)
        }
        return { kind: 'complete' }
    } catch (error) {
        return { kind: 'refusal', message: `${current} could not be written (${errorCause(error)})` }
    }
}
