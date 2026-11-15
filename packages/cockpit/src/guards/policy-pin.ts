// Owns how the guard applies an edit, write or patch of cockpit.toml to its current text, for the two
// edits it admits while the configuration differs from the one the guards were generated from: one
// that restores exactly the recorded bytes, and one that corrects a file that does not load. Neither
// grants anything: once the file loads, an edit that widens what agents may do waits for a person's
// `sync --interactive`, and the guard judges calls under the configuration last synced until then.
import { posix } from 'node:path'

import { sha256Hex } from '../sha256.js'
import type { GuardFileContent } from './invocation-parser.js'

/** Applies one `*** Update File` section of a patch to `text`, or undefined when a hunk does not match exactly once. */
function applyPatchSection(text: string, lines: readonly string[]): string | undefined {
    let result = text
    const hunks: string[][] = []
    for (const line of lines) {
        if (line.startsWith('@@')) hunks.push([])
        else if (line !== '*** End of File') (hunks.at(-1) ?? (hunks.push([]), hunks.at(-1)!)).push(line)
    }
    for (const hunk of hunks) {
        const before = hunk.filter(line => !line.startsWith('+')).map(line => line.slice(1)).join('\n')
        const after = hunk.filter(line => !line.startsWith('-')).map(line => line.slice(1)).join('\n')
        const first = result.indexOf(before)
        if (first < 0 || result.indexOf(before, first + 1) >= 0) return undefined
        result = result.slice(0, first) + after + result.slice(first + before.length)
    }
    return result
}

/** The text `content` leaves in the file `isConfig` names: undefined when it does not apply exactly once, 'untouched' when it names no such file. */
export function proposedText(content: GuardFileContent, isConfig: (path: string) => boolean, current: string): string | undefined | 'untouched' {
    if (content.kind === 'write') return isConfig(content.path) ? content.content : 'untouched'
    if (content.kind === 'replace') {
        if (!isConfig(content.path)) return 'untouched'
        if (!content.old) return undefined
        const first = current.indexOf(content.old)
        if (first < 0 || !content.all && current.indexOf(content.old, first + 1) >= 0) return undefined
        return content.all ? current.split(content.old).join(content.new) : current.slice(0, first) + content.new + current.slice(first + content.old.length)
    }
    const lines = content.text.trimEnd().split('\n').slice(1, -1)
    let section: string[] | undefined
    let target: 'update' | 'add' | undefined
    let touched = false
    let next = current
    const flush = () => {
        if (!section || !target) return true
        if (target === 'add') { next = section.map(line => line.slice(1)).join('\n') + '\n'; return true }
        const applied = applyPatchSection(next, section)
        if (applied === undefined) return false
        next = applied
        return true
    }
    for (const line of lines) {
        const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
        if (!header) { section?.push(line); continue }
        if (!flush()) return undefined
        section = undefined; target = undefined
        if (!isConfig(header[2]!)) continue
        touched = true
        // Deleting or moving the configuration is the structural denial's; either way its tables would change.
        if (header[1] === 'Delete File' || header[1] === 'Move to') return undefined
        section = []
        target = header[1] === 'Add File' ? 'add' : 'update'
    }
    if (!flush()) return undefined
    return touched ? next : 'untouched'
}

/**
 * Whether this edit leaves the configuration exactly the bytes `recordedSha256` names, the ones the
 * guards were generated from. An agent can restore only what was recorded, so authority never exceeds
 * the recorded policy, though this may also discard a person's unsynced narrowing edit. It is the way
 * out of an edit the guard admitted and sync then refused. Every target must be the
 * canonical path itself: a `..` can leave through a link, and a hard link or another spelling is left
 * to the ordinary hold. An edit that does not apply exactly once proves nothing and is not admitted.
 */
export function restoresRecordedConfiguration(input: Readonly<{ cwd: string; content?: GuardFileContent; paths: readonly string[] }>,
    current: string, configPath: string, recordedSha256: string): boolean {
    const isConfig = (path: string) => !path.split('/').includes('..') && posix.resolve(input.cwd, path) === configPath
    if (!input.content || !input.paths.length || !input.paths.every(isConfig)) return false
    const proposed = proposedText(input.content, isConfig, current)
    return proposed !== undefined && sha256Hex(proposed) === recordedSha256
}

/**
 * Whether the guard admits this call while the configuration does not load, which otherwise holds
 * every guarded call until it does: one edit, write or patch of the canonical file alone. Admitting
 * the correction grants nothing, as an edit that widens what agents may do still waits for a
 * person's sync once the file loads.
 */
export function correctsHeldConfiguration(input: Readonly<{ tool: string; cwd: string; content?: GuardFileContent; paths: readonly string[]; removed: readonly string[] }>,
    configPath: string): boolean {
    const isConfig = (path: string) => !path.split('/').includes('..') && posix.resolve(input.cwd, path) === configPath
    return input.tool !== 'Bash' && input.tool !== 'NotebookEdit' && input.content !== undefined && input.paths.length > 0
        && input.paths.every(isConfig) && input.removed.length === 0
}
