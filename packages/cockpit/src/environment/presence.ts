// What is on disk at a path, where "nothing there" (a missing entry or a missing parent) is an answer
// and any other failure, such as a permission error, is raised for its caller to name.
import { lstatSync, type Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isMissing } from './contract.js'

/** The path's own status, not following a final symbolic link, or undefined when nothing is there. */
export async function lstatIfPresent(path: string): Promise<Stats | undefined> {
    try { return await lstat(path) } catch (error) { if (isMissing(error)) return undefined; throw error }
}

export function lstatIfPresentSync(path: string): Stats | undefined {
    try { return lstatSync(path) } catch (error) { if (isMissing(error)) return undefined; throw error }
}
