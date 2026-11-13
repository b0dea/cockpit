// Owns the guard's pin on the autonomy policy: an agent tool call that would change cockpit.toml's
// [work] (with [work.gates]) or [autonomy] table, or widens [mcp] while a person approves MCP servers,
// is a hard denial. An edit, write or patch is applied to the current text and the tables compared; a
// shell command that names the file and can visibly write it cannot be applied, so it is denied too.
// Any other command naming it reads it: refusing `diff`, `sort` or a `pnpm exec cockpit check` with
// advice to edit the file left the agent nowhere to go.
// The decision is pure: the guard application supplies the current text and which targets are the
// configuration under another name.
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { pinnedPolicyTables } from '../autonomy.js'
import { sha256Hex } from '../sha256.js'
import { mcpPolicyWideningFields } from './policy-change.js'
import { innerCommand, type GuardDecision } from './evaluator.js'
import type { GuardFileContent, ParsedInvocation } from './invocation-parser.js'
import { classifyReadOnlyInvocation, cockpitLauncherPrefix } from './read-only.js'

const denial = (reason: string): GuardDecision => ({ decision: 'deny', reason })
const PINNED = '[work], [work.gates], [autonomy] and MCP tool restrictions (also MCP approvals while mcp_approve is not agent)'

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

// An editing tool's input is JSON, which decodes `\u2014` to the character before the tool sees it,
// while a TOML basic string may keep the escape in the file. How an editor then matches one against the
// other is the editor's own and unmeasured, so the guard does not guess the span: it names the cause.
function escapedText(content: GuardFileContent, current: string): boolean {
    if (content.kind !== 'replace' || !content.old || current.includes(content.old)) return false
    const decoded = current.replace(/\\(\\|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/g, (escape, body: string) => {
        if (body === '\\') return escape
        const point = Number.parseInt(body.slice(1), 16)
        return point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : escape
    })
    return decoded !== current && decoded.includes(content.old)
}

const GIT_RECORDING = new Set(['add', 'commit', 'diff', 'log', 'show', 'status', 'blame'])
// Programs that write the files they name, by basename, whatever runs them (`timeout`, `xargs`, `find
// -exec`). `git` here is every other Git command and any program spelled `git` by path.
const WRITERS = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'dd', 'tee', 'touch', 'truncate', 'rm', 'unlink', 'shred',
    'chmod', 'chown', 'chgrp', 'patch', 'ed', 'ex', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'sponge', 'tar', 'unzip', 'cpio', 'git'])
const IN_PLACE_EDITORS = new Set(['sed', 'perl', 'ruby'])
// Options by which an otherwise unknown program writes a file: `-o FILE`, `-oFILE`, `--output[=FILE]`.
const WRITE_OPTION = /^(?:-o.*|--(?:out|output|outfile|out-file|output-file|in-place|inplace|write|fix)(?:=.*)?|-delete)$/

/** Whether an invocation that names the configuration can write it, as far as its words show. */
function canWrite(invocation: ParsedInvocation): boolean {
    // A program the guard cannot name could be anything.
    if (invocation.executable === null) return true
    const words = [invocation.executable, ...invocation.argv]
    const programs = words.map(word => posix.basename(word))
    return programs.some(program => WRITERS.has(program)) || words.some(word => WRITE_OPTION.test(word))
        // `-i`, `-i.bak`, `-pi` and `--in-place` edit their operands in place.
        || programs.some(program => IN_PLACE_EDITORS.has(program)) && words.some(word => /^-[A-Za-z]*i/.test(word))
}
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
 * The invocations the pin judges. A cockpit session or exec runs the words after its `--` as a
 * command of its own, so that command is judged as one more invocation and the wrapper by the words
 * before it.
 */
function judgedInvocations(invocations: readonly ParsedInvocation[]): ParsedInvocation[] {
    const judged: ParsedInvocation[] = []
    const pending = [...invocations]
    for (let invocation = pending.shift(); invocation; invocation = pending.shift()) {
        const prefix = invocation.executable === null ? undefined : cockpitLauncherPrefix(invocation.executable, invocation.argv)
        const inner = prefix === undefined ? undefined : innerCommand(invocation.argv.slice(prefix))
        if (!inner) { judged.push(invocation); continue }
        judged.push({ ...invocation, argv: invocation.argv.slice(0, invocation.argv.length - inner.words.length - 1) })
        pending.push({ executable: inner.words[0]!, argv: inner.words.slice(1), cwd: invocation.cwd, wrapped: false, redirects: [],
            words: inner.words.map((value, index) => ({ role: index ? 'argument' as const : 'executable' as const, value })) })
    }
    return judged
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
 * How the guard answers an edit of a configuration that does not load, which otherwise holds every
 * guarded call until it does: `admit` for one edit, write or patch of the canonical file alone that
 * changes no pinned table, the pin's denial for one that does, and undefined for any other call.
 * The tables are compared with the current text, or with the recorded one when the current text is
 * not TOML at all. Admitting the correction grants nothing: once the file loads, an edit that widens
 * what agents may do still waits for a person's sync.
 */
export function correctsHeldConfiguration(input: Readonly<{ tool: string; cwd: string; content?: GuardFileContent; paths: readonly string[]; removed: readonly string[] }>,
    current: string | undefined, recorded: string, configPath: string): 'admit' | GuardDecision | undefined {
    const isConfig = (path: string) => !path.split('/').includes('..') && posix.resolve(input.cwd, path) === configPath
    if (input.tool === 'Bash' || input.tool === 'NotebookEdit' || !input.paths.length || !input.paths.every(isConfig) || input.removed.length) return undefined
    // An unreadable file offers no text an edit can match; a write is compared with the recorded text.
    const denied = pinnedPolicyDenial({ ...input, invocations: [] }, current ?? '', isConfig, current !== undefined && pinnedPolicyTables(current) ? current : recorded)
    return denied ?? 'admit'
}

/**
 * The denial for a tool call that would change the pinned policy tables, or undefined. `isConfig`
 * says whether a lexically resolved path is the configuration, by spelling or by file identity.
 */
export function pinnedPolicyDenial(input: Readonly<{
    tool: string; cwd: string; content?: GuardFileContent; paths: readonly string[]; invocations: readonly ParsedInvocation[]
}>, current: string, isConfig: (path: string) => boolean, base = current): GuardDecision | undefined {
    const resolved = (cwd: string) => (path: string) => isConfig(posix.resolve(cwd, path))
    if (input.tool === 'Bash') {
        for (const invocation of judgedInvocations(input.invocations)) {
            const names = resolved(invocation.cwd)
            // `--out=cockpit.toml` names the file as surely as a bare operand does.
            const naming = invocation.argv.some(word => names(word) || word.includes('=') && names(word.slice(word.indexOf('=') + 1)))
            const redirected = invocation.redirects.some(redirect => redirect.write && names(redirect.target))
            if (!redirected && !naming) continue
            // A proven read leaves the file as it is, and staging or committing it records the text the
            // guard already checked. Cockpit's own commands that rewrite it (sibling add, tool add,
            // confirm, sync --adopt) accept only their one intended change, through config/verified-write.ts.
            if (!redirected && (classifyReadOnlyInvocation(invocation) || recordsWithoutWriting(invocation) || !canWrite(invocation))) continue
            return denial(`Refusing a shell command that can write the cockpit configuration: the guard cannot tell whether it changes ${PINNED} in a way that grants new authority. Use your editing tool so the guard can compare the exact change; reading the file is not refused.`)
        }
        return undefined
    }
    if (!input.paths.some(resolved(input.cwd))) return undefined
    if (!input.content) return denial(`Refusing an edit of the cockpit configuration whose new text the guard was not given, so it cannot prove the change to ${PINNED} is permitted.`)
    const proposed = proposedText(input.content, resolved(input.cwd), current)
    if (proposed === 'untouched') return undefined
    if (proposed === undefined) return denial(escapedText(input.content, current)
        ? `Refusing an edit of the cockpit configuration whose old text matches its current text only once the file's TOML \\u escapes are read as the characters they stand for: the file spells a character as an escape such as \\u2014, and the edit's old text holds the character itself, which tool input decodes from \\u2014. The guard matches the text exactly, so it cannot prove which span changes and whether the change to ${PINNED} is permitted. Spell the escape with its backslash in the old and new text (\\\\u2014 inside the tool's JSON), or edit a span without escapes.`
        : `Refusing an edit of the cockpit configuration that does not apply exactly once to its current text, so the guard cannot prove the change to ${PINNED} is permitted.`)
    const before = pinnedPolicyTables(base)
    const after = pinnedPolicyTables(proposed)
    if (!before || !after) return denial(`Refusing an edit that leaves the cockpit configuration unparseable, so the guard cannot prove the change to ${PINNED} is permitted.`)
    const { mcp: beforeMcp, ...beforePinned } = before
    const { mcp: afterMcp, ...afterPinned } = after
    if (!isDeepStrictEqual(beforePinned, afterPinned) || mcpPolicyWideningFields(beforeMcp, afterMcp).length) {
        return denial(`Refusing to change gate authority or widen MCP access in ${PINNED}: a person must review this change outside the agent and run sync. Only unchanged MCP approval removals and exact tool restrictions may narrow access without that review.`)
    }
    return undefined
}
