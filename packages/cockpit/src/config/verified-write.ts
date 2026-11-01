/**
 * Owns the one way cockpit rewrites an existing cockpit.toml: edit through a sibling temporary
 * file, re-parse it through the real schema, accept it only when it is exactly the intended
 * change, then rename it over the original.
 *
 * It does not decide what the edit is: callers supply the text edit and the predicate that
 * recognises the intended change. It never spawns a process. Callers: `sibling add` /
 * `sibling remove` and `sync --adopt`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ENVIRONMENT_CODES } from '../environment/contract.js'
import { loadCockpitConfig, readBoundedInput } from './load.js'

export const mechanism = {
    id: 'verified-config-write',
    module: 'packages/cockpit/src/config/verified-write.ts',
    exports: ['writeVerifiedConfig'],
} as const

export interface VerifiedWriteMessages {
    /** Said when the file changed between the caller's read and the write. */
    readonly changedBefore: string
    /** Said when the file changed while the candidate was being prepared. */
    readonly changedDuring: string
    /** Said when the candidate does not parse; `reason` is the loader's own summary. */
    readonly invalid: (reason: string) => string
    /** Said when the candidate parses but is more than the intended change. */
    readonly notExact: string
    /** Said when re-reading the written file shows more than the intended change. */
    readonly writtenMismatch: string
}

export interface VerifiedWriteInput {
    readonly path: string
    /** Digest of the bytes the caller decided from; a different file on disk is never overwritten. */
    readonly expectedSha256: string
    /** Names the temporary file (`.<name>.<tag>-<random>`). */
    readonly temporaryTag: string
    readonly edit: (original: string) => string
    /** True only for a parsed configuration that is the caller's base plus exactly the intended change. */
    readonly isExactChange: (config: unknown) => boolean
    readonly messages: VerifiedWriteMessages
}

export type VerifiedWriteResult =
    | Readonly<{ kind: 'complete' }>
    | Readonly<{ kind: 'refused'; code: string; message: string }>

/**
 * Write through a sibling temporary file and an atomic rename, so a reader sees the old or the new
 * configuration and never half of one. The original's identity and digest are checked again just
 * before the rename: the caller may have run for minutes, and an edit made meanwhile must not be
 * overwritten.
 */
export async function writeVerifiedConfig(input: VerifiedWriteInput): Promise<VerifiedWriteResult> {
    const { path, expectedSha256, messages } = input
    const refuse = (code: string, message: string): VerifiedWriteResult => ({ kind: 'refused', code, message })
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) return refuse(ENVIRONMENT_CODES.CONFIG_UNREADABLE, 'cockpit.toml is not a regular file; nothing was written')
    const read = await readBoundedInput(path)
    if (read.kind !== 'complete') return refuse(ENVIRONMENT_CODES.CONFIG_UNREADABLE, 'cockpit.toml exceeds the input limit; nothing was written')
    if (createHash('sha256').update(read.bytes).digest('hex') !== expectedSha256) {
        return refuse(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, messages.changedBefore)
    }
    const next = input.edit(read.bytes.toString('utf8'))
    // Keep the candidate's basename equal to the real configuration name. Declared provenance
    // may intentionally name cockpit.toml without observed_on; validating it under a random
    // temporary basename would reject bytes that become valid at the atomic destination.
    const temporaryRoot = join(dirname(path), `.${basename(path)}.${input.temporaryTag}-${randomBytes(8).toString('hex')}`)
    const temporary = join(temporaryRoot, basename(path))
    let created = false
    let rootCreated = false
    try {
        await mkdir(temporaryRoot, { mode: 0o700 })
        rootCreated = true
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.mode & 0o777)
        created = true
        try { await handle.writeFile(next); await handle.sync() } finally { await handle.close() }
        const candidate = await loadCockpitConfig(temporary)
        if (candidate.kind !== 'complete') {
            return refuse(candidate.diagnostics[0]?.code ?? ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
                messages.invalid(candidate.diagnostics[0]?.message ?? 'unreadable'))
        }
        if (!input.isExactChange(candidate.result.config)) return refuse(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, messages.notExact)
        const current = await lstat(path)
        const recheck = await readBoundedInput(path)
        if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs
            || recheck.kind !== 'complete' || createHash('sha256').update(recheck.bytes).digest('hex') !== expectedSha256) {
            return refuse(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, messages.changedDuring)
        }
        await rename(temporary, path)
        created = false
        const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
    } finally {
        if (created) await unlink(temporary)
        if (rootCreated) await rmdir(temporaryRoot)
    }
    const written = await loadCockpitConfig(path)
    if (written.kind !== 'complete' || !input.isExactChange(written.result.config)) {
        return refuse(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, messages.writtenMismatch)
    }
    return { kind: 'complete' }
}
