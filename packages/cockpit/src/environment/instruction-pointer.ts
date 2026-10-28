import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import { readBoundedInput } from '../config/load.js'

const BEGIN = '<!-- cockpit:instruction-pointer:start -->'
const END = '<!-- cockpit:instruction-pointer:end -->'

export type InstructionPointerResult = Readonly<{
    kind: 'offered' | 'written' | 'unchanged'
    path: string
    target: string
}> | Readonly<{ kind: 'refusal'; path: string; reason: string }>

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const block = (target: string): string => `${BEGIN}\nRead [the cockpit instructions](<${target}>) before editing this repository.\n${END}`

async function syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
}

/** Appends one bounded marked block; bytes outside that block always remain product-owned. */
export async function synchronizeInstructionPointer(input: Readonly<{
    cockpitRoot: string
    siblingRoot: string
    write: boolean
}>): Promise<InstructionPointerResult> {
    const path = join(input.siblingRoot, 'AGENTS.md')
    try {
        const [cockpitRoot, siblingRoot] = await Promise.all([realpath(input.cockpitRoot), realpath(input.siblingRoot)])
        if (cockpitRoot !== input.cockpitRoot || siblingRoot !== input.siblingRoot) {
            return { kind: 'refusal', path, reason: 'instruction pointer roots must be canonical directories without symlink redirects' }
        }
        const directories = new Map<string, Readonly<{ dev: number; ino: number }>>()
        for (const root of [cockpitRoot, siblingRoot]) {
            for (let parent = root;; parent = dirname(parent)) {
                const status = await lstat(parent)
                if (!status.isDirectory() || status.isSymbolicLink()) return { kind: 'refusal', path, reason: 'instruction pointer ancestry is not ordinary directories' }
                directories.set(parent, { dev: status.dev, ino: status.ino })
                if (dirname(parent) === parent) break
                if (directories.size > 128) return { kind: 'refusal', path, reason: 'instruction pointer ancestry exceeds the verification bound' }
            }
        }
        const directoriesCurrent = async (): Promise<boolean> => {
            for (const [directory, expected] of directories) {
                const current = await lstat(directory)
                if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) return false
            }
            return true
        }
        if (cockpitRoot === siblingRoot) {
            return { kind: 'refusal', path, reason: 'instruction pointer roots are not distinct ordinary directories' }
        }
        const target = relative(siblingRoot, join(cockpitRoot, 'AGENTS.md')).split(sep).join('/')
        if (target.length === 0 || target.startsWith('/')) return { kind: 'refusal', path, reason: 'instruction pointer target is not relative' }
        const desired = block(target)
        let before: Awaited<ReturnType<typeof lstat>> | undefined
        try { before = await lstat(path) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (before?.isSymbolicLink() || before && !before.isFile()) return { kind: 'refusal', path, reason: 'AGENTS.md is not an ordinary file' }
        const read = before ? await readBoundedInput(path) : undefined
        if (before && read?.kind !== 'complete') return { kind: 'refusal', path, reason: 'AGENTS.md could not be read as bounded UTF-8 input' }
        const original = read?.kind === 'complete' ? new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) : ''
        const starts = original.split(BEGIN).length - 1
        const ends = original.split(END).length - 1
        if (starts !== ends || starts > 1) return { kind: 'refusal', path, reason: 'instruction pointer markers are partial or duplicated' }
        if (starts === 1) {
            const start = original.indexOf(BEGIN)
            const end = original.indexOf(END, start) + END.length
            if (original.slice(start, end) !== desired) return { kind: 'refusal', path, reason: 'the existing instruction pointer was edited' }
            return { kind: 'unchanged', path, target }
        }
        if (!input.write) return { kind: 'offered', path, target }
        if (!await directoriesCurrent()) return { kind: 'refusal', path, reason: 'instruction pointer roots changed before writing' }
        const next = `${original}${original.length === 0 || original.endsWith('\n') ? '' : '\n'}${desired}\n`
        const originalSha256 = read?.kind === 'complete' ? digest(read.bytes) : undefined
        const temporary = join(dirname(path), `.${basename(path)}.cockpit-pointer-${randomBytes(8).toString('hex')}`)
        let temporaryCreated = false
        try {
            const temporaryHandle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before ? Number(before.mode) & 0o777 : 0o644)
            temporaryCreated = true
            try { await temporaryHandle.writeFile(next); await temporaryHandle.sync() } finally { await temporaryHandle.close() }
            if (!await directoriesCurrent()) return { kind: 'refusal', path, reason: 'instruction pointer roots changed before publication' }
            if (before) {
                const current = await lstat(path)
                const reread = await readBoundedInput(path)
                if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
                    || current.mtimeMs !== before.mtimeMs || reread.kind !== 'complete' || digest(reread.bytes) !== originalSha256) {
                    return { kind: 'refusal', path, reason: 'AGENTS.md changed before the pointer could be written' }
                }
                await rename(temporary, path)
                temporaryCreated = false
            } else {
                const destination = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
                try { await destination.writeFile(next); await destination.sync() } finally { await destination.close() }
            }
            await syncDirectory(dirname(path))
        } finally {
            if (temporaryCreated) await unlink(temporary)
        }
        if (!await directoriesCurrent()) return { kind: 'refusal', path, reason: 'instruction pointer roots changed during publication' }
        const written = await readBoundedInput(path)
        if (written.kind !== 'complete' || written.bytes.toString('utf8') !== next) {
            return { kind: 'refusal', path, reason: 'instruction pointer postcheck failed' }
        }
        return { kind: 'written', path, target }
    } catch (error) {
        return { kind: 'refusal', path, reason: error instanceof Error ? error.message : 'instruction pointer operation failed' }
    }
}
