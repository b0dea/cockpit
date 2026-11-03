// Owns the guard's pin on the autonomy policy: an agent tool call that would change cockpit.toml's
// [work] (with [work.gates]) or [autonomy] table, or [mcp] while a person approves MCP servers, is a
// hard denial. An edit, write or patch is applied to the current text and the tables compared; a
// shell command that names the file and is not a proven read, a Git record or cockpit's --config
// operand cannot be applied, so it is denied too.
// The decision is pure: the guard application supplies the current text and which targets are the
// configuration under another name.
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { pinnedPolicyTables } from '../autonomy.js'
import type { GuardDecision } from './evaluator.js'
import type { GuardFileContent, ParsedInvocation } from './invocation-parser.js'
import { classifyReadOnlyInvocation, cockpitLauncherPrefix } from './read-only.js'

const denial = (reason: string): GuardDecision => ({ decision: 'deny', reason })
const PINNED = '[work], [work.gates] and [autonomy] (and [mcp] while [autonomy] mcp_approve is not agent)'

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

function proposedText(content: GuardFileContent, isConfig: (path: string) => boolean, current: string): string | undefined | 'untouched' {
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

const GIT_RECORDING = new Set(['add', 'commit', 'diff', 'log', 'show', 'status', 'blame'])
// Only the `git` the command search path finds: a path spelled `git` may be any program.
function recordsWithoutWriting(invocation: ParsedInvocation): boolean {
    if (invocation.executable !== 'git') return false
    const words = invocation.argv
    for (let index = 0; index < words.length; index++) {
        const word = words[index]!
        if (word === '-C' || word === '-c') { index++; continue }
        if (word.startsWith('-')) return false
        return GIT_RECORDING.has(word)
    }
    return false
}

/**
 * The invocations the pin judges. A cockpit session runs the words after its `--` as a command of
 * its own, so that command is judged as one more invocation and the session by the words before it.
 */
function judgedInvocations(invocations: readonly ParsedInvocation[]): ParsedInvocation[] {
    const judged: ParsedInvocation[] = []
    const pending = [...invocations]
    for (let invocation = pending.shift(); invocation; invocation = pending.shift()) {
        const prefix = invocation.executable === null ? undefined : cockpitLauncherPrefix(invocation.executable, invocation.argv)
        const separator = prefix !== undefined && invocation.argv[prefix] === 'session' ? invocation.argv.indexOf('--', prefix) : -1
        if (separator < 0) { judged.push(invocation); continue }
        judged.push({ ...invocation, argv: invocation.argv.slice(0, separator) })
        const command = invocation.argv.slice(separator + 1)
        if (command.length) pending.push({ executable: command[0]!, argv: command.slice(1), cwd: invocation.cwd, wrapped: false, redirects: [],
            words: command.map((value, index) => ({ role: index ? 'argument' as const : 'executable' as const, value })) })
    }
    return judged
}

/**
 * The denial for a tool call that would change the pinned policy tables, or undefined. `isConfig`
 * says whether a lexically resolved path is the configuration, by spelling or by file identity.
 */
export function pinnedPolicyDenial(input: Readonly<{
    tool: string; cwd: string; content?: GuardFileContent; paths: readonly string[]; invocations: readonly ParsedInvocation[]
}>, current: string, isConfig: (path: string) => boolean): GuardDecision | undefined {
    const resolved = (cwd: string) => (path: string) => isConfig(posix.resolve(cwd, path))
    if (input.tool === 'Bash') {
        for (const invocation of judgedInvocations(input.invocations)) {
            const names = resolved(invocation.cwd)
            // `--out=cockpit.toml` names the file as surely as a bare operand does.
            const naming = invocation.argv.flatMap((word, index) => names(word) || word.includes('=') && names(word.slice(word.indexOf('=') + 1)) ? [index] : [])
            const writes = invocation.redirects.some(redirect => redirect.write)
            if (!naming.length && !invocation.redirects.some(redirect => redirect.write && names(redirect.target))) continue
            // A proven read leaves the file as it is, and staging or committing it records the text the
            // guard already checked.
            if (!writes && (classifyReadOnlyInvocation(invocation) || recordsWithoutWriting(invocation))) continue
            // Installed cockpit reads the file it is given with --config, but a path or `node <script>`
            // spells any program as well as cockpit. Whether it starts cockpit is the evaluator's
            // launcher proof, so only the --config operand is left to it; naming the file anywhere
            // else is denied whatever the spelling starts.
            const prefix = invocation.executable === null ? undefined : cockpitLauncherPrefix(invocation.executable, invocation.argv)
            const configOperand = (index: number) => prefix !== undefined && index >= prefix
                && (invocation.argv[index]!.startsWith('--config=') || index > prefix && invocation.argv[index - 1] === '--config')
            if (!writes && naming.every(configOperand)) continue
            return denial(`Refusing a shell command that names the cockpit configuration: the guard cannot tell whether it changes ${PINNED}, which only a person changes. Edit other tables with your editing tool, which the guard can check.`)
        }
        return undefined
    }
    if (!input.paths.some(resolved(input.cwd))) return undefined
    if (!input.content) return denial(`Refusing an edit of the cockpit configuration whose new text the guard was not given, so it cannot show ${PINNED} unchanged.`)
    const proposed = proposedText(input.content, resolved(input.cwd), current)
    if (proposed === 'untouched') return undefined
    if (proposed === undefined) return denial(`Refusing an edit of the cockpit configuration that does not apply exactly once to its current text, so the guard cannot show ${PINNED} unchanged.`)
    const before = pinnedPolicyTables(current)
    const after = pinnedPolicyTables(proposed)
    if (!before || !after) return denial(`Refusing an edit that leaves the cockpit configuration unparseable, so the guard cannot show ${PINNED} unchanged.`)
    if (!isDeepStrictEqual(before, after)) return denial(`Refusing to change ${PINNED} in the cockpit configuration: who may pass a gate is a person's decision, made outside the agent. Ask a person to edit it and run sync.`)
    return undefined
}
