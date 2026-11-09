// What is on disk at a path, where "nothing there" (a missing entry, a missing parent, or a name too
// long for any entry to have) is an answer and any other failure, such as a permission error, is
// raised for its caller to name.
import { lstatSync, type Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { hasErrorCode, isMissing } from './contract.js'

// A component longer than the volume allows cannot exist. The guard probes every word of a command
// this way, so a long commit message or search pattern once held the call as if authority had failed.
const absent = (error: unknown) => isMissing(error) || hasErrorCode(error, 'ENAMETOOLONG')

/** The path's own status, not following a final symbolic link, or undefined when nothing is there. */
export async function lstatIfPresent(path: string): Promise<Stats | undefined> {
    try { return await lstat(path) } catch (error) { if (absent(error)) return undefined; throw error }
}

export function lstatIfPresentSync(path: string): Stats | undefined {
    try { return lstatSync(path) } catch (error) { if (absent(error)) return undefined; throw error }
}
