// Locates and fingerprints the programs cockpit ships in packages/cockpit/libexec/. A step that runs
// one lists it as a consumed file with this digest, so the executor runs a private snapshot of exactly
// the bytes hashed here and refuses a program edited or replaced in between. The snapshot runs outside
// libexec/, so a program launched this way must not require its sibling files.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { RefusalError, errorCause } from '../environment/contract.js'
import { readBoundedFile } from '../bounded-read.js'

const PROGRAM_MAX_BYTES = 1_048_576

export interface LibexecProgram {
    readonly path: string
    readonly sha256: string
    readonly maxBytes: number
}

export function libexecProgram(name: string): LibexecProgram {
    const path = fileURLToPath(new URL(`../../libexec/${name}`, import.meta.url))
    try {
        const read = readBoundedFile(path, PROGRAM_MAX_BYTES)
        if (read.kind !== 'complete') throw new RefusalError(`larger than ${PROGRAM_MAX_BYTES} bytes`)
        return { path, sha256: createHash('sha256').update(read.bytes).digest('hex'), maxBytes: PROGRAM_MAX_BYTES }
    } catch (error) {
        throw new RefusalError(`cockpit's bundled program ${path} cannot be authenticated (${errorCause(error)}); `
            + 'cockpit runs only bundled programs whose bytes it hashed — fix: reinstall @b00dea/cockpit', { cause: error })
    }
}
