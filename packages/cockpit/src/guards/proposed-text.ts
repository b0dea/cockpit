// Owns how the guard applies an edit, write or patch to a file's current text, so it can judge the
// text the call would leave there.
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

/** The text `content` leaves in the file `isTarget` names: undefined when it does not apply exactly once, 'untouched' when it names no such file. */
export function proposedText(content: GuardFileContent, isTarget: (path: string) => boolean, current: string): string | undefined | 'untouched' {
    if (content.kind === 'write') return isTarget(content.path) ? content.content : 'untouched'
    if (content.kind === 'replace') {
        if (!isTarget(content.path)) return 'untouched'
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
        if (!isTarget(header[2]!)) continue
        touched = true
        // Deleting or moving the file leaves no text to judge.
        if (header[1] === 'Delete File' || header[1] === 'Move to') return undefined
        section = []
        target = header[1] === 'Add File' ? 'add' : 'update'
    }
    if (!flush()) return undefined
    return touched ? next : 'untouched'
}
