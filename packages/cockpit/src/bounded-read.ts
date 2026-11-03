import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { RefusalError } from './environment/contract.js'

export type BoundedRead = Readonly<{ kind: 'complete'; bytes: Buffer }> | Readonly<{ kind: 'too-large' }>

function sameFile(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

/**
 * Reads a whole regular file without following a symbolic link at its last component and without
 * blocking on a FIFO, so an agent-writable path cannot redirect or stall the read. A file larger
 * than maxBytes is `too-large`. One that is not regular is refused with code EISDIR; one whose
 * identity, size or times change while it is read, or whose name stops naming the opened file, with
 * code EIO. Open errors such as ENOENT or ELOOP propagate.
 */
export function readBoundedFile(path: string, maxBytes: number): BoundedRead {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const opened = fstatSync(descriptor)
        if (!opened.isFile()) throw Object.assign(new RefusalError(`${path} is not a regular file`), { code: 'EISDIR' })
        if (opened.size > maxBytes) return { kind: 'too-large' }
        // One byte past the observed size shows a file that grew while it was read.
        const buffer = Buffer.alloc(opened.size + 1)
        let length = 0
        while (length < buffer.length) {
            const read = readSync(descriptor, buffer, length, buffer.length - length, null)
            if (read === 0) break
            length += read
        }
        if (length > maxBytes) return { kind: 'too-large' }
        const named = lstatSync(path)
        if (length !== opened.size || !sameFile(opened, fstatSync(descriptor)) || named.isSymbolicLink() || !sameFile(opened, named)) {
            throw Object.assign(new RefusalError(`${path} changed while it was read`), { code: 'EIO' })
        }
        return { kind: 'complete', bytes: buffer.subarray(0, length) }
    } finally {
        closeSync(descriptor)
    }
}
