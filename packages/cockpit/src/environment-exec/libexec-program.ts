// Locates and fingerprints the programs cockpit ships in packages/cockpit/libexec/. A step that runs
// one lists it as a consumed file with this digest, so the executor runs a private snapshot of exactly
// the bytes hashed here and refuses a program edited or replaced in between. The snapshot runs outside
// libexec/, so a program launched this way must not require its sibling files.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const mechanism = {
    id: 'libexec-program',
    module: 'packages/cockpit/src/environment-exec/libexec-program.ts',
    exports: ['libexecProgram'],
} as const

const PROGRAM_MAX_BYTES = 1_048_576

export interface LibexecProgram {
    readonly path: string
    readonly sha256: string
    readonly maxBytes: number
}

export function libexecProgram(name: string): LibexecProgram {
    const path = fileURLToPath(new URL(`../../libexec/${name}`, import.meta.url))
    let descriptor: number | undefined
    try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || opened.size > PROGRAM_MAX_BYTES) throw new Error(`not a regular file of at most ${PROGRAM_MAX_BYTES} bytes`)
        const bytes = Buffer.alloc(opened.size + 1)
        let length = 0
        while (length < bytes.length) {
            const read = readSync(descriptor, bytes, length, bytes.length - length, null)
            if (read === 0) break
            length += read
        }
        const named = lstatSync(path)
        if (length !== opened.size || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('changed while it was read')
        return Object.freeze({ path, sha256: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'), maxBytes: PROGRAM_MAX_BYTES })
    } catch (error) {
        throw new Error(`cockpit's bundled program ${path} cannot be authenticated (${error instanceof Error ? error.message : String(error)}); `
            + 'cockpit runs only bundled programs whose bytes it hashed — fix: reinstall @b0dea/cockpit', { cause: error })
    } finally {
        if (descriptor !== undefined) closeSync(descriptor)
    }
}
