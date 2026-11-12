import { posix } from 'node:path'
import { isProxy, isUint8Array } from 'node:util/types'
import { hasErrorCode, RefusalError, snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { exactKeys } from '../exact-keys.js'

export const GUARD_INPUT_LIMITS = Object.freeze({ inputBytes: 65_536, invocations: 256, words: 4_096, wordBytes: 4_096, paths: 256, pathBytes: 4_096 })

export type InvocationRole = 'executable' | 'argument' | 'environment-assignment-value' | 'wrapper-option-value'
    | 'redirect-target' | 'heredoc-body' | 'comment' | 'definition' | 'directory'
export interface InvocationWord {
    readonly role: InvocationRole
    /** The word after quote removal; for a dynamic word, its expansions as the command spells them. */
    readonly value: string
    /** The word holds a variable, command substitution, glob, tilde or zsh `=command` the guard cannot expand. */
    readonly dynamic?: true
    /** The variable an environment assignment sets, on `environment-assignment-value` words. */
    readonly name?: string
}
export interface GuardParseOptions {
    /** `mark` emits a word whose expansion the guard cannot see, flagged `dynamic`, where `refuse` (the default) refuses the command. */
    readonly dynamicWords?: 'refuse' | 'mark'
    /** HOME of the process that runs the command: a leading `~` or `~/`, `$HOME` and `${HOME}` expand to it. */
    readonly home?: string
    /** CDPATH of that process; when empty, `cd name` resolves from the working directory. */
    readonly cdpath?: string
}
export interface ParsedInvocation {
    readonly executable: string | null
    readonly argv: readonly string[]
    readonly cwd: string
    readonly wrapped: boolean
    readonly words: readonly InvocationWord[]
    /** `truncate` marks `>` and `>|`, which empty an existing file before anything is written. */
    readonly redirects: readonly { readonly target: string; readonly write: boolean; readonly truncate: boolean }[]
    /**
     * An argument, assignment or wrapper option holds `$?`, the previous command's exit status. It expands to digits the guard
     * cannot see, so a word holding it is never proven to name a path.
     */
    readonly expandsStatus?: true
    /** A word of this invocation is dynamic; only `dynamicWords: 'mark'` emits one. */
    readonly dynamic?: true
}
/** The new text a file tool call carries, as the payload spells it, kept so the policy pin can apply it. */
export type GuardFileContent =
    | Readonly<{ kind: 'replace'; path: string; old: string; new: string; all: boolean }>
    | Readonly<{ kind: 'write'; path: string; content: string }>
    | Readonly<{ kind: 'patch'; text: string }>
export type GuardParseResult = {
    readonly status: 'parsed'
    readonly tool: 'Bash' | 'Edit' | 'Write' | 'NotebookEdit' | 'apply_patch' | `mcp__${string}`
    readonly cwd: string
    readonly invocations: readonly ParsedInvocation[]
    readonly paths: readonly string[]
    /** Targets deleted, moved away from or emptied, as opposed to edited in place. */
    readonly removed: readonly string[]
    readonly content?: GuardFileContent
} | { readonly status: 'unavailable'; readonly reason: string }

const parsedInputs = new WeakSet<object>()
export function isParsedGuardInput(value: unknown): value is Extract<GuardParseResult, { status: 'parsed' }> {
    return typeof value === 'object' && value !== null && parsedInputs.has(value)
}

const shown = (word: string) => shownGuardWord(word)
function refuse(reason: string): never { throw new RefusalError(reason) }
/** A word as a refusal quotes it: JSON-escaped, with the controls a harness rejects in a reason escaped too, and bounded. */
export function shownGuardWord(word: string): string {
    const characters = [...word]
    const quoted = JSON.stringify(characters.length > 80 ? `${characters.slice(0, 80).join('')}…` : word)
    return quoted.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
function record(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: JsonSnapshot | undefined): value is string {
    return typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value) && !value.includes('\0')
}
function mcpTool(value: JsonSnapshot | undefined): value is `mcp__${string}` {
    return typeof value === 'string' && value.length <= 263 && /^mcp__[a-zA-Z0-9][a-zA-Z0-9_-]*__[a-zA-Z0-9_.-]+$/.test(value)
}
function path(value: string): string {
    if (!value || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > GUARD_INPUT_LIMITS.pathBytes) refuse('Invalid or oversized guard path.')
    return value
}

interface Token {
    kind: 'word' | 'op' | 'comment' | 'body' | 'descriptor'
    value: string
    quoted?: boolean
    dynamic?: boolean
    status?: boolean
    /** Which way forward a refusal of this dynamic word names. */
    hint?: 'heredoc' | 'glob'
    /** Command text of each `$(…)` or backquote substitution in the word, run where the command runs. */
    substitutions?: string[]
    /** One of several words a brace expansion produced. */
    braced?: boolean
    /** An expansion that can itself run code: arithmetic on a subscript, a prompt or zsh flag expansion, a zsh glob from a value. */
    evaluates?: boolean
}
/** The file a process substitution `<(…)` hands its command: a pipe the shell opens, never a file in the tree. */
export const PROCESS_SUBSTITUTION = '/dev/fd/63'
/** The word xargs appends to the command it runs: whatever it reads from standard input, which the guard cannot see. */
export const XARGS_INPUT = '$(xargs input)'

// Substitutions, `bash -c` strings and loop bodies nest; past this depth the guard stops reading.
const NESTING_LIMIT = 8
// The most words one numeric brace range may produce.
const BRACE_RANGE_LIMIT = 256
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'aria2c'])
// awk runs what it reads through system(), and each of the others runs a script read from standard input.
const INTERPRETERS = /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python[\d.]*|node|nodejs|bun|deno|perl|ruby|php|osascript|[gmn]?awk|tclsh[\d.]*|lua[\d.]*|Rscript)$/
const FETCHED_CODE = 'Refusing to run downloaded text as code: a download feeds a shell or interpreter, so what runs is whatever the server sends. '
    + 'Download the file into the cockpit, read it, then run it by path.'
// A URL, or a package spelled as a Git source, runs code no registry name or path the guard can read stands for.
const REMOTE_SOURCE = /:\/\/|^(?:git\+|github:|gitlab:|bitbucket:|gist:)/i
const fetchedSource = (word: string): never => refuse(`${shown(word)} runs code fetched from a URL or a Git host, which the guard cannot read. Download it into the cockpit, read it, then run it by path.`)

/** Whether a command list starts a fetcher anywhere a command starts, judged from its words alone. */
function startsFetcher(tokens: readonly Token[]): boolean {
    let start = true
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!
        if (token.kind === 'op') { start = separators.has(token.value); continue }
        if (token.kind !== 'word' || !start) continue
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue
        const name = posix.basename(token.value)
        if (FETCHERS.has(name) || name === 'gh' && tokens[i + 1]?.value === 'api') return true
        start = false
    }
    return false
}

const ANSI_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

/** The text of a `$'…'` word part from `start`, just after its opening quote, as bash decodes it, and where it ends. */
function ansiQuoted(command: string, start: number): { text: string; end: number } {
    let text = ''
    for (let index = start; index < command.length;) {
        const c = command[index]!
        if (c === "'") return { text, end: index + 1 }
        if (c !== '\\') { text += c; index++; continue }
        const next = command[index + 1]
        if (next === undefined) break
        const numeric = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(command.slice(index + 1))
        if (numeric) {
            const code = numeric[4] !== undefined ? parseInt(numeric[4], 8) : parseInt(numeric[1] ?? numeric[2] ?? numeric[3]!, 16)
            if (code === 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) refuse(`Unsupported escape in ${shown(command.slice(start - 2, index + 1 + numeric[0].length))}. Write the text out.`)
            text += String.fromCodePoint(code)
            index += 1 + numeric[0].length
        } else if (Object.hasOwn(ANSI_ESCAPES, next)) {
            text += ANSI_ESCAPES[next]
            index += 2
        } else if (next === 'c') refuse(`Unsupported control escape in ${shown(command.slice(start - 2, index + 3))}. Write the text out.`)
        else {
            // bash keeps an unknown escape as written.
            text += `\\${next}`
            index += 2
        }
    }
    refuse('Unterminated shell quote.')
}

/** The user name a tilde at the start of `rest` names, empty for the running user, or undefined when it names none. */
const tildeUser = (rest: string) => /^[A-Za-z0-9._-]*(?=[/ \t\n;&|<>()]|$)/.exec(rest)?.[0]
const tildeHome = (home: string, user: string) => user ? posix.join(posix.dirname(home), user) : home

function evaluatingReference(command: string, at: number): boolean {
    const pattern = /[~=[]|[A-Za-z_][A-Za-z0-9_]*\[/y
    pattern.lastIndex = at
    return pattern.test(command)
}

/** The text `$(cat <<'EOF' … EOF)` prints: a quoted delimiter keeps the body literal, and the shell drops trailing newlines. */
function literalHeredoc(tokens: readonly Token[]): string | undefined {
    const [cat, operator, delimiter, body, ...rest] = tokens
    if (cat?.kind !== 'word' || cat.value !== 'cat' || cat.dynamic || operator?.kind !== 'op' || !operator.value.startsWith('<<')
        || delimiter?.kind !== 'word' || !delimiter.quoted || body?.kind !== 'body' || rest.some((token) => token.kind !== 'op' || token.value !== '\n')) return undefined
    return body.value.replace(/\n+$/, '')
}

function lex(command: string, options: GuardParseOptions, start = 0, depth = 0): { tokens: Token[]; end: number } {
    if (depth > NESTING_LIMIT) refuse(`Commands nested more than ${NESTING_LIMIT} levels deep are unsupported.`)
    // A substitution is a slice of the command already checked.
    if (!depth && /[\x00-\x08\x0b-\x1f\x7f]/.test(command)) refuse('Unsupported shell control character.')
    const nested = depth > 0
    const home = options.home
    // Unquoted, a parameter's value is split on whitespace and globbed in bash, so only a plain HOME expands there exactly.
    const plainHome = home !== undefined && !/[\s*?[\]{}]/.test(home)
    const tokens: Token[] = []
    const documents: { delimiter: string; quoted: boolean; tabs: boolean }[] = []
    let awaitingDocument: boolean | undefined
    let words = 0
    let parens = 0
    let index = start
    while (index < command.length) {
        const char = command[index]
        if (char === ' ' || char === '\t') { index++; continue }
        if (char === '\n') {
            index++
            for (const document of documents) {
                let body = ''
                let closed = false
                while (index <= command.length) {
                    const end = command.indexOf('\n', index)
                    const line = command.slice(index, end < 0 ? command.length : end)
                    const content = document.tabs ? line.replace(/^\t+/, '') : line
                    index = end < 0 ? command.length + 1 : end + 1
                    if (content === document.delimiter) { closed = true; break }
                    body += content + (end < 0 ? '' : '\n')
                }
                if (!closed) refuse('Unterminated heredoc.')
                if (!document.quoted && /[$`\\]/.test(body)) {
                    refuse("Dynamic heredoc expansion is unsupported: an unquoted delimiter expands $, ` and \\ in the body. Quote the delimiter (<<'EOF') so the body is literal; "
                        + "for a commit message, pass it on standard input with git commit -F - <<'EOF'.")
                }
                tokens.push({ kind: 'body', value: body })
            }
            documents.length = 0
            tokens.push({ kind: 'op', value: '\n' })
            continue
        }
        if (char === '#') {
            const end = command.indexOf('\n', index)
            tokens.push({ kind: 'comment', value: command.slice(index + 1, end < 0 ? command.length : end) })
            index = end < 0 ? command.length : end
            continue
        }
        const descriptor = /^\d+(?=[<>])/.exec(command.slice(index))?.[0]
        if (descriptor) {
            tokens.push({ kind: 'descriptor', value: descriptor })
            index += descriptor.length
            continue
        }
        if (/^[<>]\(/.test(command.slice(index, index + 2))) {
            const inner = lex(command, options, index + 2, depth + 1)
            if (startsFetcher(inner.tokens)) refuse(FETCHED_CODE)
            // `<(…)` is a word naming a pipe the command reads; its commands are judged where it runs. Joined to other text
            // it names a path the guard does not spell, and `>(…)` runs a command on what the program writes.
            if (command[index] === '>' || awaitingDocument !== undefined || index > start && !/[ \t\n;&|<>(]/.test(command[index - 1]!)
                || inner.end < command.length && !/[ \t\n;&|<>)]/.test(command[inner.end]!)) {
                refuse('Process substitution is read only as a whole word `<(…)`, which a command reads as a file. Write the output to a file inside the cockpit first, or pipe it.')
            }
            if (++words > GUARD_INPUT_LIMITS.words) refuse('Guard word limit exceeded.')
            tokens.push({ kind: 'word', value: PROCESS_SUBSTITUTION, quoted: false, dynamic: false, status: false, substitutions: [command.slice(index + 2, inner.end - 1)] })
            index = inner.end
            continue
        }
        // A brace is a group delimiter only as a word of its own; inside a word it is literal text
        // unless it forms a brace expansion, which the word loop expands.
        const operator = /^(?:&&|\|\||<<-|<<|>>|>&|<&|<>|>\||[;&|<>()]|[{}](?=[ \t\n;&|<>()]|$))/.exec(command.slice(index))?.[0]
        if (operator) {
            if (command.startsWith('<<<', index)) refuse('Here-strings (<<<) are unsupported. Pipe the text instead: `printf \'%s\\n\' "<text>" | <command>`.')
            if (awaitingDocument !== undefined) refuse('Missing heredoc delimiter.')
            index += operator.length
            if (nested && operator === ')' && !parens--) {
                if (documents.length) refuse('Unterminated heredoc.')
                return { tokens, end: index }
            }
            if (operator === '(') parens++
            tokens.push({ kind: 'op', value: operator })
            if (operator === '<<' || operator === '<<-') awaitingDocument = operator === '<<-'
            continue
        }
        // zsh, the default macOS shell, expands an unquoted word starting with `=` to a command's path.
        const equals = command[index] === '='
        const wordStart = index
        let value = ''
        let quote = ''
        let quoted = false
        let dynamic = false
        let status = false
        let evaluates = false
        let hint: Token['hint']
        const substitutions: string[] = []
        // Open braces by position in `value`, with the unquoted commas directly inside each and whether any of it was quoted.
        const braces: { at: number; commas: number[]; quoted: boolean }[] = []
        let expansion: { at: number; end: number; items: string[] } | undefined
        while (index < command.length) {
            const c = command[index]
            if (!quote && /[ \t\n;&|<>()]/.test(c)) break
            if (c === "'" && quote !== '"' || c === '"' && quote !== "'") {
                quoted = true
                quote = quote ? '' : c
                for (const brace of braces) brace.quoted = true
                index++
                continue
            }
            if (c === '\\' && quote !== "'") {
                const next = command[++index]
                if (next === undefined) refuse('Incomplete shell escape.')
                if (next === '\n') { index++; continue }
                if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) value += '\\'
                for (const brace of braces) brace.quoted = true
                value += next
                index++
                continue
            }
            // `$?` is the previous command's exit status: digits, never a word, glob or command.
            if (quote !== "'" && c === '$' && command[index + 1] === '?') {
                status = true
                value += '$?'
                index += 2
                continue
            }
            // bash drops a backslash-newline before it reads `$(`, so `$\` and a newline still opens a substitution.
            if (quote !== "'" && c === '$' && command.startsWith('\\\n', index + 1)) refuse('A line continuation inside an expansion is unsupported. Write the expansion on one line.')
            if (quote !== "'" && c === '$' && command[index + 1] === '(') {
                if (command[index + 2] === '(') refuse('Arithmetic expansion $((…)) is unsupported. Compute the number and write it out.')
                const inner = lex(command, options, index + 2, depth + 1)
                const text = command.slice(index + 2, inner.end - 1)
                // A heredoc opened before the substitution would take its body from inside it.
                if (documents.length && text.includes('\n')) refuse('A heredoc whose body starts inside a command substitution is unsupported.')
                substitutions.push(text)
                // Unquoted, the output is split into words and globbed, so only a double-quoted one is exactly the text.
                const literal = quote === '"' ? literalHeredoc(inner.tokens) : undefined
                if (literal !== undefined) value += literal
                else {
                    dynamic = true
                    if (inner.tokens.some((token) => token.kind === 'op' && token.value.startsWith('<<'))) hint = 'heredoc'
                    value += `$(${text})`
                }
                index = inner.end
                continue
            }
            if (quote !== "'" && c === '`') {
                let inner = ''
                let end = index + 1
                while (end < command.length && command[end] !== '`') {
                    const escaped = command[end] === '\\' && ['$', '`', '\\', ...quote === '"' ? ['"'] : []].includes(command[end + 1] ?? '')
                    inner += command[escaped ? end + 1 : end]
                    end += escaped ? 2 : 1
                }
                if (end >= command.length) refuse('Unterminated command substitution.')
                substitutions.push(inner)
                dynamic = true
                value += command.slice(index, end + 1)
                index = end + 1
                continue
            }
            if (quote !== "'" && c === '$' && command[index + 1] === '{') {
                const close = command.indexOf('}', index)
                const name = close < 0 ? '' : command.slice(index + 2, close)
                // A default or replacement can hold a command substitution; only a plain parameter reference is read.
                if (!name || /[{$`'"\\\s]/.test(name)) refuse(`Unsupported parameter expansion in ${shown(command.slice(index, close < 0 ? undefined : close + 1))}. Write the value out.`)
                // Anything but a plain reference can evaluate: `${x:y}`, `${a[i]}` and `${!y}` do arithmetic, `${x@P}` and zsh `${(e)x}` substitute commands.
                // A literal index or `@`, as in `${PIPESTATUS[0]}`, is no arithmetic that can run anything.
                if (!/^(?:[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+|[@*])\])?|\d+|[@*#?$!-])$/.test(name)) evaluates = true
                if (name === 'HOME' && home !== undefined && (quote || plainHome)) value += home
                else {
                    dynamic = true
                    value += `\${${name}}`
                }
                index = close + 1
                continue
            }
            // zsh applies `$HOME:h` modifiers and `$HOME[1]` subscripts, so only a bare reference expands.
            if (quote !== "'" && c === '$' && /^HOME(?![A-Za-z0-9_:[])/.test(command.slice(index + 1, index + 7)) && home !== undefined && (quote || plainHome)) {
                value += home
                index += 5
                continue
            }
            // `~` or `~/` where a word starts names HOME, and `~name` the home directory named `name` beside it:
            // a user's own name reaches their credential stores as `~` does.
            const user = !quote && c === '~' && index === wordStart && home !== undefined ? tildeUser(command.slice(index + 1)) : undefined
            if (user !== undefined) {
                value += tildeHome(home!, user)
                index += 1 + user.length
                continue
            }
            // `$'…'` is quoted text whose backslash escapes bash and zsh decode, so `$'\x2e'env` names `.env`.
            if (!quote && c === '$' && command[index + 1] === "'") {
                const decoded = ansiQuoted(command, index + 2)
                quoted = true
                for (const brace of braces) brace.quoted = true
                value += decoded.text
                index = decoded.end
                continue
            }
            // Bash and zsh expand `{a,b}` and `{1..3}` only; `@{u}` and `HEAD@{1}` stay literal.
            if (!quote && c === '{') braces.push({ at: value.length, commas: [], quoted: false })
            if (!quote && c === ',' && braces.length) braces.at(-1)!.commas.push(value.length)
            if (!quote && c === '}' && braces.length) {
                const open = braces.pop()!
                const content = value.slice(open.at + 1)
                if (open.commas.length || content.includes('..')) {
                    const unsupported = () => refuse(`Unsupported brace expansion in ${shown(value + c)}: the guard expands one comma list or bounded numeric range per word, unnested. Write each word out.`)
                    const range = open.quoted || open.commas.length ? null : /^(-?(?:0|[1-9]\d*))\.\.(-?(?:0|[1-9]\d*))$/.exec(content)
                    if (braces.length || expansion || /[{}]/.test(content) || !open.commas.length && !range) unsupported()
                    let items: string[]
                    if (range) {
                        const [from, to] = [Number(range[1]), Number(range[2])]
                        if (Math.abs(to - from) >= BRACE_RANGE_LIMIT) unsupported()
                        items = Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => String(from + (to >= from ? i : -i)))
                    } else {
                        const cuts = [open.at, ...open.commas, value.length]
                        items = cuts.slice(1).map((cut, i) => value.slice(cuts[i]! + 1, cut))
                    }
                    // A tilde or zsh `=` at the start of an item expands after the braces do.
                    if (!open.at && items.some((item) => /^[~=]/.test(item))) unsupported()
                    expansion = { at: open.at, end: value.length, items }
                }
            }
            // zsh reads `$~x` and `$=x` as glob and split flags, `$[…]` is arithmetic, and `$x[…]` a subscript evaluated as arithmetic.
            if (quote !== "'" && c === '$' && evaluatingReference(command, index + 1)) evaluates = true
            // A tilde expands only where a word starts, or after `=` or `:` in an assignment; `HEAD~1` stays literal.
            if (quote !== "'" && (c === '$' || !quote && (/[*?\[]/.test(c) || c === '~' && (value === '' && !quoted || /[=:]$/.test(value))))) {
                dynamic = true
                if (/[*?\[]/.test(c)) hint ??= 'glob'
            }
            value += c
            index++
        }
        if (quote) refuse('Unterminated shell quote.')
        if (equals && value.length > 1) dynamic = true
        const values = expansion
            ? expansion.items.map((item) => value.slice(0, expansion!.at) + item + value.slice(expansion!.end + 1))
            : [value]
        // Bash drops a word an expansion leaves empty, and a quoted one it keeps.
        if (expansion && values.some((item) => !item)) refuse(`Unsupported brace expansion in ${shown(value)}: it leaves an empty word. Write each word out.`)
        for (const [i, item] of values.entries()) {
            if (++words > GUARD_INPUT_LIMITS.words || Buffer.byteLength(item) > GUARD_INPUT_LIMITS.wordBytes) refuse('Guard word limit exceeded.')
            tokens.push({ kind: 'word', value: item, quoted, dynamic, status, ...evaluates ? { evaluates } : {},
                ...hint ? { hint } : {}, ...substitutions.length && !i ? { substitutions } : {}, ...expansion ? { braced: true } : {} })
        }
        if (awaitingDocument !== undefined) {
            if (dynamic || status || !value || expansion || substitutions.length) refuse('Unsupported heredoc delimiter.')
            documents.push({ delimiter: value, quoted, tabs: awaitingDocument })
            awaitingDocument = undefined
        }
    }
    if (nested) refuse('Unterminated command substitution.')
    if (documents.length || awaitingDocument !== undefined) refuse('Unterminated heredoc.')
    return { tokens, end: index }
}

const separators = new Set([';', '\n', '&&', '||', '|', '&'])
const redirects = new Set(['<', '>', '>>', '<<', '<<-', '>&', '<&', '<>', '>|'])
// `-` is zsh's precommand modifier that runs the command as a login shell would name it.
// xargs runs its command with words read from standard input appended, which the command is judged with as a word it cannot see.
const wrappers = new Set(['timeout', 'nice', 'nohup', 'setsid', 'env', 'command', 'exec', 'time', 'caffeinate', 'stdbuf', 'ionice', 'noglob', 'nocorrect', '-', 'xargs'])
// Each runs a command or code from its arguments that the guard does not follow: an evaluating builtin, a shell it does
// not read, or a program that runs the rest of its command line in a form the guard does not read as a wrapper.
const dynamicExecutables = new Set(['eval', 'source', '.', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'mksh', 'yash', 'busybox', 'pwsh', 'builtin',
    'trap', 'let', 'chrt', 'taskset', 'unbuffer', 'watch', 'script', 'flock', 'parallel', 'entr'])
/**
 * Package and environment managers that run a program named on their line, by their words before it. Only the options
 * listed are read: any other may pick a shell, a directory, an environment file or another package. npm and yarn read an
 * option anywhere on the line before `--`, so a command after them takes options only behind `--`. A launcher that fetches
 * resolves `owner/repo` from a Git host.
 */
type Launcher = Readonly<{ plain?: readonly string[]; values?: readonly string[]; anywhere?: true; fetches?: true; separatesAfter?: true }>
// npm ends its own options at the first `--`, wherever it falls, and drops it, so the program gets every word after it.
const npmExec: Launcher = { plain: ['--no', '--yes', '-y'], values: ['--package'], anywhere: true, fetches: true, separatesAfter: true }
const bunx: Launcher = { plain: ['--bun'], values: ['-p', '--package'], fetches: true }
const launchers: Readonly<Record<string, Launcher>> = {
    npx: { plain: ['--no', '--yes', '-y'], values: ['-p', '--package'], fetches: true }, 'npm exec': npmExec, 'npm x': npmExec,
    'pnpm exec': {}, 'pnpm dlx': { values: ['--package'], fetches: true }, pnpx: { fetches: true },
    'yarn exec': { anywhere: true }, 'yarn dlx': { anywhere: true, fetches: true }, bunx, 'bun x': bunx, 'bun run': { plain: ['--bun', '-b', '--silent'] },
    uvx: { values: ['--from'] }, 'uv tool run': { values: ['--from'] }, 'uv run': {}, 'poetry run': {}, 'pipenv run': {}, 'bundle exec': {},
}
// The subcommand words of each manager above that launch a program.
const launcherVerbs = new Map<string, Set<string>>()
for (const spelling of Object.keys(launchers)) {
    const [manager, verb] = spelling.split(' ')
    if (verb) launcherVerbs.set(manager!, new Set([...launcherVerbs.get(manager!) ?? [], verb]))
}
// pnpm runs a word that names none of its own commands as `pnpm exec` would. Only long-standing commands count, so a
// pnpm older than one of its newer commands never has that word read as its own while it runs the program of that name.
const pnpmCommands = new Set(['add', 'audit', 'bin', 'config', 'c', 'create', 'dedupe', 'deploy', 'doctor', 'env', 'fetch', 'help', 'import', 'init',
    'install', 'i', 'install-test', 'it', 'licenses', 'link', 'ln', 'list', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'prune', 'publish',
    'rebuild', 'rb', 'remove', 'rm', 'uninstall', 'un', 'root', 'run', 'server', 'setup', 'start', 'stop', 'restart', 'store', 'test', 't', 'tst',
    'unlink', 'update', 'up', 'upgrade', 'why', 'access', 'adduser', 'bugs', 'deprecate', 'dist-tag', 'docs', 'edit', 'info', 'login', 'logout',
    'owner', 'ping', 'prefix', 'profile', 'pkg', 'repo', 's', 'search', 'set-script', 'star', 'stars', 'team', 'token', 'unpublish', 'unstar', 'v',
    'view', 'whoami', 'xmas'])
// pnpm's options before its command, as its help lists them, and the older -s and --silent; recursive, multi and m run the
// command in every package as -r does.
const pnpmValueOptions = new Set(['-C', '--dir', '-F', '--filter', '--filter-prod', '--reporter', '--loglevel', '--workspace-concurrency'])
const pnpmFlags = new Set(['-r', '--recursive', 'recursive', 'multi', 'm', '-w', '--workspace-root', '--stream', '--parallel', '--aggregate-output',
    '--sort', '--no-sort', '--reverse', '--fail-if-no-match', '--include-workspace-root', '--ignore-workspace', '-y', '--yes', '--color',
    '-s', '--silent', '-v', '--version', '-h', '--help'])
// Options of git itself, ahead of its subcommand, that take the next word.
const gitValueOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])
// Builtins that take a variable name, whose array subscript bash evaluates as arithmetic, and arithmetic runs `$(…)`.
const subscriptEvaluators = new Set(['unset', 'read', 'declare', 'typeset', 'local', 'export', 'readonly', 'printf', 'mapfile', 'readarray', 'test', '['])
// A shell reads a script by path or a literal `-c` string, both of which the guard follows.
const scriptShells = new Set(['sh', 'bash', 'zsh'])
const privileged = new Set(['sudo', 'sudoedit', 'doas', 'su', 'pkexec', 'run0', 'runuser'])
// Builtins that move the shell as `cd` does, which only `cd` is judged as.
const directoryChangers = new Set(['cd', 'pushd', 'popd', 'chdir'])
const CD_REFUSAL = 'cd is judged only as `cd <dir> && <command>` (or `;`), alone in its command, with one literal directory that is absolute or starts '
    + 'with ./ or ../. A bare name such as `cd api` may resolve through CDPATH, which the guard cannot see: write `cd ./api`, or `git -C api` for Git.'
const LOOP_REFUSAL = 'A for loop is parsed only as `for NAME in WORDS; do COMMANDS; done`, followed by redirects, a separator or the end of the command.'
const WHILE_REFUSAL = 'A while or until loop is parsed only as `while COMMANDS; do COMMANDS; done`, followed by redirects, a separator or the end of the command.'
const SUBSHELL_REFUSAL = 'A subshell is parsed only as `( COMMANDS )`, followed by redirects, a separator or the end of the command; `((` is arithmetic, which the guard does not read.'
const XARGS_REFUSAL = 'xargs is read only with -0, -r, -t, -x, -o, -p, -n, -L, -P, -s, -d and -E before its command: -I and -J place its input inside the command\'s words, '
    + 'and -a reads it from a file. Run the command on each file by name.'
// Writing to these discards or forwards output and reading /dev/null yields nothing, so they touch
// no file; only these exact spellings qualify.
const DEVICE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const reserved = new Set(['if', 'then', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'time', '!', 'coproc', 'repeat', '[['])

function dynamicRefusal(token: Token): never {
    const forward = token.hint === 'heredoc'
        ? "For a commit message, quote the heredoc delimiter (<<'EOF') so the text is literal, or pass it on standard input with git commit -F - <<'EOF'."
        : token.hint === 'glob' ? "Write the paths out, or list them first with rg --files -g '<glob>' or fd." : 'Write the command and its paths out literally.'
    refuse(`Dynamic command construction is unsupported: ${shown(token.value)} holds a variable, command substitution, glob, home-directory tilde or zsh =command whose expansion the guard cannot see. ${forward}`)
}
function evaluationRefusal(token: Token): never {
    refuse(`${shown(token.value)} holds an expansion that can run code the guard cannot see: arithmetic on a subscript, a prompt or zsh flag expansion, or a zsh glob made from a value. Write the value out.`)
}
const word = (role: InvocationRole, token: Token): InvocationWord => token.dynamic ? { role, value: token.value, dynamic: true } : { role, value: token.value }
const fetches = (item: ParsedInvocation) => item.executable !== null && (FETCHERS.has(posix.basename(item.executable))
    || posix.basename(item.executable) === 'gh' && item.argv.find((value) => !value.startsWith('-')) === 'api')
const interprets = (item: ParsedInvocation) => item.executable !== null && INTERPRETERS.test(posix.basename(item.executable))

/**
 * Where the program a launcher at `at` runs starts, or undefined when the words there launch nothing the guard unwraps. A
 * cockpit launcher stays whole: the application proves which of its spellings start the installed cockpit.
 */
function launchedCommand(args: readonly Token[], at: number): { readonly index: number; readonly dropped?: number } | undefined {
    const words = args.map((token) => token.value)
    const manager = posix.basename(words[at]!)
    let index = at + 1
    let spelling = Object.hasOwn(launchers, manager) ? manager : undefined
    if (manager === 'pnpm') {
        let directory = false
        while (index < words.length && (words[index]!.startsWith('-') || pnpmFlags.has(words[index]!))) {
            const [flag, attached] = words[index]!.split(/=(.*)/s)
            if (pnpmValueOptions.has(flag!)) index += attached === undefined ? 2 : 1
            else if (pnpmFlags.has(words[index]!)) index++
            else refuse(`Unsupported pnpm option ${shown(words[index]!)} before its command. Write it after the command, or run the program itself.`)
            if (['-C', '--dir'].includes(flag!)) directory = true
        }
        const verb = words[index]
        if (verb === undefined || pnpmCommands.has(verb)) return undefined
        if (verb === 'with') refuse('pnpm with runs another pnpm version on the rest of its line, which the guard does not read. Run the command with the installed pnpm.')
        // `-r` and `--filter` run the program in workspace packages below the workspace root, so a path it names
        // resolves below there too, except one that climbs with `..`; `-C` moves to a directory of its own.
        if (directory || words.slice(index).some((word) => word.split('/').includes('..'))) {
            refuse(`pnpm with ${directory ? '-C or --dir' : 'workspace selection and a path that climbs with ..'} before ${shown(verb)} runs a program in a directory or workspace packages where the guard cannot resolve its paths. `
                + 'Use pnpm <options> run <script> for a script, or run the program from its own directory.')
        }
        if (verb === 'exec' || verb === 'dlx') spelling = `pnpm ${verb}`
        // Any other word is the program itself.
        if (spelling) index++
    } else if (spelling === undefined) {
        const verbs = launcherVerbs.get(manager)
        if (!verbs) return undefined
        const verb = words.slice(index).find((word) => verbs.has(word))
        if (words[index]?.startsWith('-') && verb) refuse(`${manager} options before its ${verb} subcommand can change the directory or the program it runs. Write \`${manager} ${verb}\` first, or run the program itself.`)
        spelling = [`${manager} ${words[index]} ${words[index + 1]}`, `${manager} ${words[index]}`].find((candidate) => Object.hasOwn(launchers, candidate))
        if (spelling === undefined) return undefined
        index += spelling.split(' ').length - 1
    }
    const name = spelling ?? manager
    const launcher: Launcher = spelling === undefined ? {} : launchers[spelling]!
    const sources: string[] = []
    let separated = false
    while (words[index]?.startsWith('-')) {
        const option = words[index++]!
        if (option === '--') { separated = true; break }
        const [flag, attached] = option.split(/=(.*)/s)
        if (launcher.values?.includes(flag!)) {
            const value = attached ?? words[index++]
            if (value === undefined) refuse(`Missing ${name} ${flag} value.`)
            sources.push(value)
        } else if (!launcher.plain?.includes(option)) {
            const known = [...launcher.plain ?? [], ...launcher.values ?? []]
            refuse(`Unsupported ${name} option ${shown(option)}: the guard reads ${name} only with ${known.length ? known.join(', ') : 'no options'} before the program it runs. Run the program itself.`)
        }
    }
    const command = args[index]
    if (command === undefined) return undefined
    const hidden = args.slice(at + 1, index).find((token) => token.dynamic)
    if (hidden) refuse(`${name} option ${shown(hidden.value)} holds an expansion the guard cannot see. Write it out.`)
    // A program named through an expansion is refused where the executable is read.
    if (command.dynamic) return { index }
    if (posix.basename(command.value.replace(/(.)@[^/]*$/, '$1')) === 'cockpit') return undefined
    for (const source of [command.value, ...sources]) if (REMOTE_SOURCE.test(source) || launcher.fetches && /^[^@./][^/]*\/[^/]/.test(source)) fetchedSource(source)
    // yarn and pnpm's shell mode run the program's name as shell code.
    if (/[^\w@%+=:,./^~-]/.test(command.value)) refuse(`${name} runs ${shown(command.value)}, which holds shell syntax the guard does not read as a program name. Run the command itself.`)
    // npm takes an option anywhere before its `--`, so only one between the program and that `--` is ambiguous.
    const after = words.slice(index + 1)
    const separator = launcher.separatesAfter && !separated && after.includes('--') ? index + 1 + after.indexOf('--') : undefined
    if (launcher.anywhere && !separated && words.slice(index + 1, separator).some((word) => word.startsWith('-'))) {
        refuse(`${name} reads an option anywhere before \`--\`, so the guard cannot tell its options from the program's. Write \`${name} -- ${command.value} …\`.`)
    }
    return separator === undefined ? { index } : { index, dropped: separator }
}

/** Why git refuses here: these run a shell command from the top of the working tree or in each submodule, not where git runs. */
function gitShellRefusal(argv: readonly string[]): string | undefined {
    let at = 0
    while (argv[at]?.startsWith('-')) at += gitValueOptions.has(argv[at]!) ? 2 : 1
    const [verb, ...rest] = argv.slice(at)
    const options = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
    // git accepts a long option by any unique prefix, and a short one bundled after others.
    if (verb === 'rebase' && options.some((word) => /^--ex(?:ec?)?(?:=|$)/.test(word) || /^-[^-]*x/.test(word))) {
        return 'git rebase --exec runs its command with a shell from the top of the working tree after each commit, which the guard does not follow. Rebase without --exec, then run the command yourself.'
    }
    if (verb === 'bisect' && rest[0] === 'run') {
        return 'git bisect run runs its command from the top of the working tree at each step, which the guard does not follow. Run the command yourself, then mark the step with git bisect good or git bisect bad.'
    }
    if (verb === 'submodule' && rest.includes('foreach')) {
        return 'git submodule foreach runs its command with a shell inside each submodule, which the guard does not follow. Run it in each submodule with git -C <path>, or cd ./<path> && <command>.'
    }
    return undefined
}

interface Context { readonly options: GuardParseOptions; readonly definitions: Set<string>; readonly depth: number }

function invocation(tokens: Token[], cwd: string, context: Context): ParsedInvocation[] {
    const { definitions, options } = context
    const words: InvocationWord[] = []
    const redirectPaths: { target: string; write: boolean; truncate: boolean }[] = []
    const args: Token[] = []
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.kind === 'comment' || token.kind === 'body') {
            words.push({ role: token.kind === 'body' ? 'heredoc-body' : 'comment', value: token.value })
        } else if (token.kind === 'descriptor') {
            if (tokens[i + 1]?.kind !== 'op' || !redirects.has(tokens[i + 1].value)) refuse('Descriptor lacks a redirect.')
        } else if (token.kind === 'op' && redirects.has(token.value)) {
            const target = tokens[++i]
            if (!target || target.kind !== 'word' || target.dynamic || target.status || target.braced) refuse('Missing or dynamic redirect target. Write the path out: the guard does not follow a variable into a redirect.')
            words.push({ role: 'redirect-target', value: target.value })
            if (!token.value.startsWith('<<') && !['>&', '<&'].includes(token.value)
                && !(token.value === '<' ? target.value === '/dev/null' : DEVICE_SINKS.has(target.value))) {
                redirectPaths.push({ target: path(target.value), write: token.value !== '<', truncate: token.value === '>' || token.value === '>|' })
            } else if (['>&', '<&'].includes(token.value) && !/^(?:\d+|-)$/.test(target.value)) refuse('Unsupported descriptor redirect.')
        } else if (token.kind !== 'word') refuse('Unsupported shell operator.')
        else args.push(token)
    }
    // Definitions are data until invoked. Never guess the shell's alias expansion mode.
    if (args[0]?.value === 'alias') {
        for (const item of args.slice(1)) {
            const match = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/s.exec(item.value)
            if (!match || item.dynamic || item.braced) refuse('Unsupported alias definition.')
            definitions.add(match[1])
        }
        return [{ executable: null, argv: [], cwd, wrapped: false, words: [...words, ...args.map(({ value }) => ({ role: 'definition' as const, value }))], redirects: redirectPaths }]
    }
    if (options.dynamicWords !== 'mark') {
        const expanded = args.find((token) => token.dynamic)
        if (expanded) dynamicRefusal(expanded)
    }
    const evaluating = args.find((token) => token.evaluates)
    if (evaluating) evaluationRefusal(evaluating)
    let cursor = 0
    // The program a launcher runs inherits these.
    const assigned: Token[] = []
    const assignments = () => {
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[cursor]?.value ?? '')) {
            const token = args[cursor++]
            // Bash and zsh do not brace-expand an assignment, so the expanded words misstate it.
            if (token.braced) refuse(`Unsupported brace expansion in the assignment ${shown(token.value)}. Write the value out.`)
            const at = token.value.indexOf('=')
            const raw = token.value.slice(at + 1)
            // Bash and zsh expand a leading tilde in an assignment's value as at the start of a word.
            const user = !token.quoted && token.dynamic && options.home !== undefined && raw.startsWith('~') ? tildeUser(raw.slice(1)) : undefined
            const rest = user === undefined ? '' : raw.slice(1 + user.length)
            const value = user !== undefined && !/[$`*?[~]/.test(rest) ? tildeHome(options.home!, user) + rest : undefined
            const expanded = value === undefined ? token : { ...token, value: `${token.value.slice(0, at + 1)}${value}`, dynamic: false }
            assigned.push(expanded)
            words.push({ ...word('environment-assignment-value', { ...expanded, value: expanded.value.slice(at + 1) }), name: token.value.slice(0, at) })
        }
    }
    assignments()
    let wrapped = false
    while (cursor < args.length && wrappers.has(posix.basename(args[cursor].value)) && !args[cursor].dynamic) {
        // `command -v NAME` and `command -V NAME` only print where a command is.
        if (posix.basename(args[cursor].value) === 'command' && /^-[vV]$/.test(args[cursor + 1]?.value ?? '')
            && args.length > cursor + 2 && args.slice(cursor + 2).every((token) => !token.value.startsWith('-'))) break
        const wrapper = posix.basename(args[cursor++].value)
        wrapped = true
        const take = () => {
            const token = args[cursor++]
            if (!token) refuse(`Missing ${wrapper} operand.`)
            if (token.dynamic) refuse(`${wrapper} option ${shown(token.value)} holds an expansion the guard cannot see. Write it out.`)
            words.push({ role: 'wrapper-option-value', value: token.value })
            return token
        }
        while (args[cursor]?.value.startsWith('-')) {
            const optionToken = take()
            const option = optionToken.value
            if (option === '--') break
            let [flag, attached] = option.split(/=(.*)/s)
            const valueFlags = wrapper === 'timeout' ? ['-s', '--signal', '-k', '--kill-after']
                : wrapper === 'nice' ? ['-n', '--adjustment']
                : wrapper === 'env' ? ['-C', '--chdir', '-u', '--unset']
                : wrapper === 'exec' ? ['-a']
                : wrapper === 'caffeinate' ? ['-t', '-w']
                : wrapper === 'stdbuf' ? ['-i', '-o', '-e', '--input', '--output', '--error']
                : wrapper === 'ionice' ? ['-c', '-n', '--class', '--classdata']
                : wrapper === 'xargs' ? ['-n', '-L', '-P', '-s', '-d', '-E', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--eof'] : []
            const plainFlags = wrapper === 'timeout' ? ['--foreground', '--preserve-status', '-v', '--verbose']
                : wrapper === 'env' ? ['-i', '--ignore-environment']
                : wrapper === 'setsid' ? ['-f', '--fork', '-w', '--wait']
                : wrapper === 'command' || wrapper === 'time' ? ['-p'] : wrapper === 'exec' ? ['-c', '-l']
                : wrapper === 'caffeinate' ? ['-d', '-i', '-m', '-s', '-u']
                : wrapper === 'ionice' ? ['-t', '--ignore']
                : wrapper === 'xargs' ? ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-x', '--exit', '-o', '--open-tty', '-p', '--interactive'] : []
            // As getopt reads them: a short option's value may be attached (`-oL`), and plain short flags may be grouped (`-dims`).
            if (attached === undefined && /^-[^-]./.test(flag) && valueFlags.includes(flag.slice(0, 2))) [flag, attached] = [flag.slice(0, 2), flag.slice(2)]
            const grouped = attached === undefined && /^-[^-]{2,}$/.test(flag) && [...flag.slice(1)].every((letter) => plainFlags.includes(`-${letter}`))
            if (valueFlags.includes(flag)) {
                const valueToken = attached === undefined ? take() : optionToken
                const value = attached === undefined ? valueToken.value : attached
                if (!value) refuse(`Empty ${wrapper} option value.`)
                if (wrapper === 'env' && ['-C', '--chdir'].includes(flag)) {
                    // Every path the command names resolves from this directory, so it must be known.
                    if (valueToken.status) refuse(`env ${flag} holding $? runs the command in a directory the guard cannot see. Write the directory out.`)
                    // env changes directory as the system does, resolving `..` from where a link leads.
                    if (climbsOutOfName(value)) refuse(`env ${flag} ${shown(value)} climbs out of a named directory with .., which resolves from wherever a link there leads. Write the directory without it.`)
                    cwd = path(posix.resolve(cwd, value))
                }
            } else if (!(attached === undefined && (plainFlags.includes(flag) || grouped || wrapper === 'nice' && /^-\d+$/.test(flag)))) {
                refuse(wrapper === 'command'
                    ? 'command is parsed only as `command -v NAME` or `command -V NAME`, which print where a command is, and as `command [-p] <command>`. Run the command itself.'
                    : wrapper === 'xargs' ? XARGS_REFUSAL : `Unsupported ${wrapper} option.`)
            }
        }
        if (wrapper === 'timeout' && !/^\d+(?:\.\d+)?[smhd]?$/.test(take().value)) refuse('Invalid timeout duration.')
        if (wrapper === 'env') assignments()
        if (cursor >= args.length) {
            refuse(wrapper === 'env' ? 'env without a command prints the whole environment, which can hold credentials. Print one named variable that holds no secret instead, such as printenv PATH.'
                : `Missing ${wrapper} executable.`)
        }
        if (wrapper === 'xargs') {
            const input: Token = { kind: 'word', value: XARGS_INPUT, quoted: false, dynamic: true, status: false }
            if (options.dynamicWords !== 'mark') dynamicRefusal(input)
            args.push(input)
        }
    }
    const executableToken = args[cursor]
    const executable = executableToken?.value ?? null
    let nested: ParsedInvocation[] = []
    // The launcher stays an invocation of its own, so a rule naming its spelling still applies, and the program it runs
    // follows it as a wrapped invocation carrying the launcher's words, as a `sh -c` string's commands do.
    const launched = executableToken && !executableToken.dynamic ? launchedCommand(args, cursor) : undefined
    if (launched !== undefined) {
        const [program, ...rest] = invocation([...assigned, ...args.slice(launched.index).filter((_, at) => launched.index + at !== launched.dropped)], cwd, context)
        const launcherWords = args.slice(cursor + 1, launched.index).map((token) => ({ role: 'wrapper-option-value' as const, value: token.value }))
        nested = [{ ...program!, wrapped: true, words: [...launcherWords, ...program!.words] }, ...rest]
    }
    if (executable !== null) {
        if (executableToken!.dynamic) refuse(`${shown(executable)} chooses the program to run through an expansion the guard cannot see. Write the program name out.`)
        if (!executable || executableToken!.status || definitions.has(executable)) refuse('Unsupported executable or defined command invocation.')
        if (directoryChangers.has(executable)) refuse(CD_REFUSAL)
        const name = posix.basename(executable)
        if (privileged.has(name) || name === 'osascript' && args.slice(cursor + 1).some((token) => /administrator\s+privileges/i.test(token.value))) refuse(`${shown(executable)} runs a command with another user's privileges. Privilege escalation is a person's action: ask them to run it in their own terminal.`)
        if (scriptShells.has(name)) {
            const [first, script, ...rest] = args.slice(cursor + 1)
            if (first?.value === '-c') {
                if (!script || rest.length || script.dynamic || script.status) refuse(`${shown(executable)} -c is parsed only with one literal command string and nothing after it. Write the string in single quotes, or run the command itself.`)
                // The string runs in a child shell: its commands are judged as these are, and its `cd` moves only that shell.
                nested = parseShell(script.value, cwd, { ...context, depth: context.depth + 1 }).map((item) => ({ ...item, wrapped: true }))
            } else if (!first || /^[-+]/.test(first.value) || first.dynamic) {
                refuse(`${shown(executable)} is parsed only as \`${name} SCRIPT [ARGUMENTS]\` or \`${name} -c '<command>'\` with a literal command string: with no script it runs whatever it reads. Run the command itself.`)
            }
        }
        const gitRefusal = name === 'git' ? gitShellRefusal(args.slice(cursor + 1).map((token) => token.value)) : undefined
        if (gitRefusal) refuse(gitRefusal)
        const remote = name === 'deno' ? args.slice(cursor + 1).find((token) => !token.value.startsWith('-') && REMOTE_SOURCE.test(token.value)) : undefined
        if (remote) fetchedSource(remote.value)
        if (subscriptEvaluators.has(name) && args.slice(cursor + 1).some((token) => /\[.*[$`]/s.test(token.value))) {
            refuse(`${shown(executable)} evaluates an array subscript as arithmetic, which runs any command substitution in it. Write the index as a number.`)
        }
        if (dynamicExecutables.has(name)) refuse(`${shown(executable)} runs a command or script built from its arguments, which the guard does not parse. Run the command itself.`)
        if (reserved.has(executable)) refuse(`Shell control flow (${executable}) is not parsed by the guard. Run each command on its own.`)
        words.push({ role: 'executable', value: executable })
        cursor++
    }
    const operands = args.slice(cursor)
    words.push(...operands.map((token) => word('argument', token)))
    return [{ executable, argv: operands.map(({ value }) => value), cwd, wrapped, words, redirects: redirectPaths,
        ...args.some((token) => token.status) ? { expandsStatus: true as const } : {},
        ...words.some((item) => item.dynamic) ? { dynamic: true as const } : {} }, ...nested]
}

/**
 * Whether `..` follows a named component, as in `a/../b`. The system resolves such a `..` from where
 * a link named `a` leads, which the spelling cannot show; only a leading `..` leaves a directory the
 * guard has already inspected as the working directory.
 */
function climbsOutOfName(directory: string): boolean {
    return directory.split('/').some((name, index, names) => name === '..' && names.slice(0, index).some((before) => !['', '.', '..'].includes(before)))
}

/** The directory a command that is exactly `cd <dir>` moves to, as written, or undefined for any other command. */
function changedDirectory(tokens: readonly Token[], context: Context): string | undefined {
    if (tokens[0]?.kind !== 'word' || tokens[0].value !== 'cd' || context.definitions.has('cd')) return undefined
    const operands = tokens.slice(1).filter((token) => token.kind !== 'comment')
    if (operands[0]?.kind === 'word' && operands[0].value === '--') operands.shift()
    // A substitution in the directory runs a command that the cd alone would hide.
    const target = operands.length === 1 && operands[0]!.kind === 'word' && !operands[0]!.dynamic && !operands[0]!.status && !operands[0]!.substitutions ? operands[0]!.value : undefined
    // Both shells search CDPATH before the working directory for any other relative spelling; an empty one leaves only the working directory.
    // `cd -` goes to OLDPWD, and `-P`, `-L` and zsh's `+N` and `-N` are options or stack entries, never a directory.
    if (target === undefined || /^[-+]/.test(target) || context.options.cdpath !== '' && !/^(?:\/|\.\.?(?:\/|$))/.test(target)) refuse(CD_REFUSAL)
    // Both shells resolve `cd` by spelling unless set to follow links (`set -P`, zsh's chase_links),
    // which the guard cannot see, as it cannot see CDPATH.
    if (climbsOutOfName(target)) refuse(`${CD_REFUSAL} A .. after a directory name is not: a shell set to follow links resolves it from wherever a link there leads.`)
    return target
}

/**
 * A compound command the guard reads whole: a `for` loop, its BODY judged with `$NAME` as a dynamic word; a `while` or
 * `until` loop, its condition and BODY judged as the commands they are; or a subshell `( … )`. `redirects` are the
 * redirect tokens after it, which apply to every command inside.
 */
type Compound = (
    | { readonly kind: 'for'; readonly name: string; readonly items: readonly Token[]; readonly body: Token[] }
    | { readonly kind: 'while'; readonly condition: Token[]; readonly body: Token[] }
    | { readonly kind: 'subshell'; readonly body: Token[] }
) & { readonly redirects: Token[] }
const keyword = (tokens: readonly Token[], index: number, value: string) => tokens[index]?.kind === 'word' && tokens[index]!.value === value && !tokens[index]!.quoted
/** Where a command starts: at `start`, or after a separator or brace. */
const commandStart = (tokens: readonly Token[], index: number, start: number) => index === start
    || tokens[index - 1]!.kind === 'op' && [...separators, '{', '}'].includes(tokens[index - 1]!.value)

/** The loop body from `start`, just after its `do`, to the `done` that closes it. */
function loopBody(tokens: readonly Token[], start: number, refusal: string): { body: Token[]; end: number } {
    // `do` and `done` count only where a command starts, as `echo done` shows.
    for (let depth = 0, index = start; index < tokens.length; index++) {
        if (commandStart(tokens, index, start) && keyword(tokens, index, 'do')) depth++
        if (commandStart(tokens, index, start) && keyword(tokens, index, 'done') && !depth--) return { body: tokens.slice(start, index), end: index }
    }
    refuse(refusal)
}

function readLoop(tokens: readonly Token[], at: number): { compound: Compound; end: number } {
    const name = tokens[at + 1]
    if (name?.kind !== 'word' || name.quoted || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.value) || !keyword(tokens, at + 2, 'in')) refuse(LOOP_REFUSAL)
    let index = at + 3
    const items: Token[] = []
    while (tokens[index]?.kind === 'word') items.push(tokens[index++]!)
    if (tokens[index]?.kind !== 'op' || ![';', '\n'].includes(tokens[index]!.value)) refuse(LOOP_REFUSAL)
    while (tokens[++index]?.kind === 'op' && tokens[index]!.value === '\n');
    if (!keyword(tokens, index, 'do')) refuse(LOOP_REFUSAL)
    const { body, end } = loopBody(tokens, index + 1, 'Unterminated for loop.')
    return { compound: { kind: 'for', name: name.value, items, body, redirects: [] }, end }
}

function readWhile(tokens: readonly Token[], at: number): { compound: Compound; end: number } {
    const start = at + 1
    let index = start
    // The condition ends at the first `do` where a command starts; a loop inside the condition is not read.
    for (; index < tokens.length && !(commandStart(tokens, index, start) && keyword(tokens, index, 'do')); index++) {
        if (commandStart(tokens, index, start) && ['for', 'while', 'until', 'do', 'done'].some((word) => keyword(tokens, index, word))) refuse(WHILE_REFUSAL)
    }
    const condition = tokens.slice(start, index)
    if (index === tokens.length || !condition.some((token) => token.kind === 'word')) refuse(WHILE_REFUSAL)
    const { body, end } = loopBody(tokens, index + 1, 'Unterminated while loop.')
    return { compound: { kind: 'while', condition, body, redirects: [] }, end }
}

function readSubshell(tokens: readonly Token[], at: number): { compound: Compound; end: number } {
    for (let depth = 0, index = at + 1; index < tokens.length; index++) {
        const token = tokens[index]!
        if (token.kind === 'op' && token.value === '(') depth++
        if (token.kind === 'op' && token.value === ')' && !depth--) {
            const body = tokens.slice(at + 1, index)
            // `((` opens arithmetic, which the shell evaluates rather than runs.
            if (!body.some((item) => item.kind === 'word') || body[0]!.kind === 'op' && body[0]!.value === '(') refuse(SUBSHELL_REFUSAL)
            return { compound: { kind: 'subshell', body, redirects: [] }, end: index }
        }
    }
    refuse('Unterminated subshell.')
}

/** Every token a compound command holds, for the checks that read a command's words. */
function compoundTokens(compound: Compound): readonly Token[] {
    return [...compound.kind === 'for' ? compound.items : compound.kind === 'while' ? compound.condition : [], ...compound.body, ...compound.redirects]
}

// Builtins that set a variable they are handed by name, which may be HOME or CDPATH when the guard cannot see the name.
const variableSetters = new Set(['export', 'declare', 'typeset', 'readonly', 'local', 'read', 'unset', 'getopts', 'mapfile', 'readarray', 'printf'])
const NAMES_HOME = /(?<!\$\{?)\bHOME\b/
const CHANGES_CD = /cdpath|cdable|shopt|setopt/i

/** Whether a command in the list hands a variable-setting builtin a word the guard cannot see. */
function setsHiddenName(tokens: readonly Token[]): boolean {
    let command: Token[] = []
    for (const token of [...tokens, undefined]) {
        if (token?.kind === 'word') command.push(token)
        else if (!token || token.kind === 'op' && !redirects.has(token.value)) {
            if (command.some((item) => variableSetters.has(item.value)) && command.some((item) => item.dynamic)) return true
            command = []
        }
    }
    return false
}

function parseShell(command: string, cwd: string, context: Context): ParsedInvocation[] {
    let { options } = context
    if (options.home !== undefined || options.cdpath !== undefined) {
        // A command that sets or names HOME or CDPATH, or a shell option that changes cd, makes the hook's values wrong for it.
        // The shell reads a name after quote removal, so `export HO''ME=x` sets HOME too, as may a setter handed a variable.
        const tokens = lex(command, { ...options, home: undefined }).tokens
        const hidden = setsHiddenName(tokens)
        const names = (pattern: RegExp) => hidden || pattern.test(command) || tokens.some((token) => token.kind === 'word' && pattern.test(token.value))
        options = { ...options, ...names(NAMES_HOME) ? { home: undefined } : {}, ...names(CHANGES_CD) ? { cdpath: undefined } : {} }
    }
    return parseTokens(lex(command, options).tokens, cwd, { ...context, options }, true)
}

function parseTokens(tokens: readonly Token[], cwd: string, context: Context, cdAllowed: boolean): ParsedInvocation[] {
    const { definitions, options } = context
    if (context.depth > NESTING_LIMIT) refuse(`Commands nested more than ${NESTING_LIMIT} levels deep are unsupported.`)
    const deeper = { ...context, depth: context.depth + 1 }
    const result: ParsedInvocation[] = []
    let current: Token[] = []
    let compound: Compound | undefined
    // Where each open brace group's commands start in `result`.
    const groups: number[] = []
    // A group just closed, so a separator may follow it; `piped` holds its commands when it feeds a pipeline.
    let closed: { piped?: readonly ParsedInvocation[] } | undefined
    let needsCommand = false
    // The commands of each function the list defines.
    const functions: Token[][] = []
    // Every directory the shell may be in, each with whether the last command there may have
    // succeeded or failed. `&&` and `||` have equal precedence and group left to right, so a command
    // after one runs only where the status allows it; a command it skips, a `cd` included, leaves
    // directory and status as they were for the rest of the list. Nothing here assumes a command,
    // `cd` included, succeeds.
    type State = { readonly directory: string; readonly ok: boolean }
    let states: readonly State[] = [{ directory: cwd, ok: true }]
    // The operator before the current command: `&&`, `||`, `|`, or undefined where it always runs.
    let gate: string | undefined
    // Where the previous command ran, which is where a pipeline's next stage runs.
    let ran: readonly string[] = [cwd]
    // A list ending in `&` runs in a background subshell, so its cd moves nothing after it.
    let list = states
    // An earlier stage of the current pipeline downloads.
    let fetched = false
    const append = (item: ParsedInvocation) => {
        if (result.length === GUARD_INPUT_LIMITS.invocations) refuse('Guard invocation limit exceeded.')
        result.push(item)
    }
    // A substitution runs before its command, in the same directory, and a fetched one is code from the network.
    const substituted = (items: readonly Token[], directory: string) => {
        const inner = items.flatMap((token) => token.substitutions ?? []).flatMap((text) => parseShell(text, directory, deeper))
        if (inner.some(fetches)) refuse(FETCHED_CODE)
        return inner
    }
    const stage = (directory: string): ParsedInvocation[] => {
        if (!compound) return [...substituted(current, directory), ...invocation(current, directory, context)]
        // Redirects after a compound command apply to every command inside, so they are judged once as a bare redirect.
        const redirected = compound.redirects.length ? [...substituted(compound.redirects, directory), ...invocation(compound.redirects, directory, context)] : []
        if (compound.kind === 'subshell') return [...parseTokens(compound.body, directory, deeper, true), ...redirected]
        // A cd in a loop would move every later pass, so its commands are judged once only without one.
        if (compound.kind === 'while') return [...parseTokens(compound.condition, directory, deeper, false), ...parseTokens(compound.body, directory, deeper, false), ...redirected]
        const evaluating = compound.items.find((token) => token.evaluates)
        if (evaluating) evaluationRefusal(evaluating)
        const header: ParsedInvocation = { executable: null, argv: [], cwd: directory, wrapped: false, redirects: [],
            words: [{ role: 'definition', value: compound.name }, ...compound.items.map((token) => word('argument', token))],
            ...compound.items.some((token) => token.status) ? { expandsStatus: true as const } : {},
            ...compound.items.some((token) => token.dynamic) ? { dynamic: true as const } : {} }
        return [...substituted(compound.items, directory), header, ...parseTokens(compound.body, directory, deeper, false), ...redirected]
    }
    const flush = (separator?: string) => {
        // Any word naming an interpreter counts, so a program that runs the rest of its line cannot hide one, and it is
        // named before the stage is read, so a bare `| bash` is refused for what it runs.
        const words = compound ? compoundTokens(compound) : current
        if (gate === '|' && fetched && words.some((token) => token.kind === 'word' && INTERPRETERS.test(posix.basename(token.value)))) refuse(FETCHED_CODE)
        const target = current.length ? changedDirectory(current, context) : undefined
        if (target !== undefined && !cdAllowed) refuse(`${CD_REFUSAL} A cd inside a loop is not.`)
        // A pipeline or background job runs `cd` in a subshell in bash, and the last stage of a pipeline in the current shell in zsh.
        if (target !== undefined && (gate === '|' || separator === '|' || separator === '&')) refuse(`${CD_REFUSAL} A cd in a pipeline or background job is not.`)
        // Appended as produced, so the invocation limit bounds the work.
        const first = result.length
        const emit = (...items: ParsedInvocation[]) => items.forEach(append)
        if ((current.length || compound) && gate === '|') for (const directory of ran) emit(...stage(directory))
        else if (current.length || compound) {
            const runs = states.filter((state) => gate === undefined || state.ok === (gate === '&&'))
            ran = [...new Set(runs.map((state) => state.directory))]
            const next = states.filter((state) => !runs.includes(state))
            if (target !== undefined) {
                const moved = [...new Set(ran.map((directory) => path(posix.resolve(directory, target))))]
                // The directory itself is inspected as each later command's working directory is.
                for (const directory of moved) emit({ executable: null, argv: [], cwd: directory, wrapped: false, words: [{ role: 'directory', value: target }], redirects: [] })
                next.push(...ran.map((directory) => ({ directory, ok: false })), ...moved.map((directory) => ({ directory, ok: true })))
            } else {
                for (const directory of ran) emit(...stage(directory))
                next.push(...ran.flatMap((directory) => [{ directory, ok: true }, { directory, ok: false }]))
            }
            states = [...new Map(next.map((state) => [`${state.ok}\0${state.directory}`, state])).values()]
        }
        // A group that feeds a pipeline is that pipeline's stage, with any redirect after it.
        const stageItems = [...closed?.piped ?? [], ...result.slice(first)]
        if (gate === '|' && fetched && stageItems.some(interprets)) refuse(FETCHED_CODE)
        fetched = (gate === '|' && fetched) || stageItems.some(fetches)
        current = []
        compound = undefined
        closed = undefined
        if (separator === '&') states = list
        if (separator === '&&' || separator === '||' || separator === '|') gate = separator
        else {
            gate = undefined
            list = states
        }
    }
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (compound && !(token.kind === 'op' && separators.has(token.value))) {
            if (token.kind === 'comment') continue
            // Only redirects may follow a compound command before its separator; a redirect's target is the word after it.
            const last = compound.redirects.at(-1)
            if (token.kind === 'descriptor' || token.kind === 'body' || token.kind === 'op' && redirects.has(token.value)
                || token.kind === 'word' && last?.kind === 'op' && redirects.has(last.value)) {
                compound.redirects.push(token)
                continue
            }
            refuse(compound.kind === 'for' ? LOOP_REFUSAL : compound.kind === 'while' ? WHILE_REFUSAL : SUBSHELL_REFUSAL)
        }
        if (!current.length && !compound && token.kind === 'word' && !token.quoted && (token.value === 'for' && options.dynamicWords === 'mark' || token.value === 'while' || token.value === 'until')) {
            ({ compound, end: i } = token.value === 'for' ? readLoop(tokens, i) : readWhile(tokens, i))
            needsCommand = false
            closed = undefined
            continue
        }
        if (!current.length && !compound && token.kind === 'op' && token.value === '(') {
            ({ compound, end: i } = readSubshell(tokens, i))
            needsCommand = false
            closed = undefined
            continue
        }
        const functionStyle = token.value === 'function' && token.kind === 'word'
        if (!current.length && token.kind === 'word' && (functionStyle || tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === ')')) {
            const name = functionStyle ? tokens[++i]?.value : token.value
            if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuse('Invalid function definition.')
            if (tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === ')') i += 2
            if (tokens[++i]?.value !== '{') refuse('Unsupported function body.')
            // A function defined in a loop outlives the pass that defined it, wherever the shell goes next.
            if (!cdAllowed) refuse('A function defined inside a loop is not read. Define it before the loop.')
            const body: InvocationWord[] = [{ role: 'definition', value: name }]
            const commands: Token[] = []
            let depth = 1
            while (++i < tokens.length && depth) {
                const item = tokens[i]
                // A brace is a reserved word only where a command starts; elsewhere bash reads it as an
                // argument, so counting it would hide the commands after the body inside it.
                if (item.kind === 'op' && ['{', '}'].includes(item.value)
                    && !(tokens[i - 1]?.kind === 'op' && ['{', '}', ';', '\n', '&&', '||', '|', '&'].includes(tokens[i - 1]!.value))) refuse('Unsupported function body.')
                if (item.kind === 'op' && item.value === '{') depth++
                if (item.kind === 'op' && item.value === '}') depth--
                body.push({ role: 'definition', value: item.value })
                if (depth) commands.push(item)
            }
            if (depth) refuse('Unterminated function definition.')
            i--
            definitions.add(name)
            functions.push(commands)
            append({ executable: null, argv: [], cwd: states[0]!.directory, wrapped: false, words: body, redirects: [] })
            needsCommand = false
            continue
        }
        if (token.kind === 'op' && separators.has(token.value)) {
            // A newline after `&&`, `||` or `|` continues the list, as a line continuation would.
            if (token.value === '\n' && needsCommand) continue
            if (['&&', '||', '|', '&'].includes(token.value) && !current.length && !compound && !closed) refuse('Missing shell command before separator.')
            flush(token.value)
            if (token.value !== '\n') needsCommand = ['&&', '||', '|'].includes(token.value)
        } else if (token.kind === 'op' && token.value === '{') {
            if (current.length) refuse('A standalone { is parsed only where it opens a command group, `{ command; }`. Quote a literal brace.')
            // Every command in the group reads the download, past the separators that end a pipeline stage.
            if (gate === '|' && fetched) refuse(FETCHED_CODE)
            groups.push(result.length)
            closed = undefined
        } else if (token.kind === 'op' && token.value === '}') {
            if (!groups.length || current.length || needsCommand) refuse('Malformed brace group.')
            const start = groups.pop()!
            // The separator after the group and any redirects on it.
            let next = i + 1
            for (let item = tokens[next]; item; item = tokens[next]) {
                if (item.kind === 'op' && redirects.has(item.value)) next += 2
                else if (['descriptor', 'body', 'comment'].includes(item.kind)) next++
                else break
            }
            const after = tokens[next]
            // A group feeding a pipeline, or run in the background, runs in a subshell: a cd there moves nothing after it.
            if (after?.kind === 'op' && ['|', '&'].includes(after.value)) {
                const items = result.slice(start)
                if (items.some((item) => item.words[0]?.role === 'directory')) refuse(`${CD_REFUSAL} A cd in a group that feeds a pipeline or runs in the background is not.`)
                closed = { piped: items }
            } else closed = {}
        } else {
            // A redirect on a closed group keeps the group as the stage it ends.
            const previous = current.at(-1)
            const redirecting = token.kind === 'descriptor' || token.kind === 'body' || token.kind === 'op' && redirects.has(token.value)
                || token.kind === 'word' && previous?.kind === 'op' && redirects.has(previous.value)
            current.push(token)
            if (!redirecting) closed = undefined
            if (token.kind === 'word') needsCommand = false
        }
    }
    if (groups.length || needsCommand) refuse('Incomplete shell command.')
    flush()
    if (!result.length) refuse('Empty shell command.')
    // zsh runs TRAPEXIT, zshexit, precmd and the like without being asked, at any point the shell reaches, so each body is
    // judged as if it ran in every directory the list visits.
    const visited = [...new Set([cwd, ...result.map((item) => item.cwd), ...states.map((state) => state.directory)])]
    for (const commands of functions) for (const directory of visited) parseTokens(commands, directory, deeper, false).forEach(append)
    // Definitions can affect commands regardless of textual order in compound forms.
    if (result.some((item) => item.executable !== null && definitions.has(item.executable) || definitions.has('cd') && item.words[0]?.role === 'directory')) {
        refuse('Defined command invocation is unsupported.')
    }
    return result
}

function patchPaths(command: string): { paths: string[]; removed: string[] } {
    const lines = command.trimEnd().split('\n')
    if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') refuse('Malformed patch envelope.')
    const paths: string[] = []
    const removed: string[] = []
    let update = false
    for (const line of lines) {
        const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
        if (header) {
            if (header[1] === 'Move to' && !update) refuse('Patch move lacks an update source.')
            if (header[1] === 'Move to') removed.push(paths.at(-1)!)
            if (header[1] === 'Delete File') removed.push(path(header[2]))
            paths.push(path(header[2]))
            update = header[1] === 'Update File'
        } else if (!paths.length || !(line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('@@') || line === '*** End of File' || line === '')) {
            refuse('Unsupported patch structure.')
        }
    }
    if (!paths.length) refuse('Patch has no targets.')
    return { paths, removed }
}

function captureBytes(input: Uint8Array): Uint8Array {
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) refuse('Foreign guard byte prototype.')
    // Native accessors bypass shadow properties; copying happens only after own-shape validation.
    const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!.call(input) as number
    if (length > GUARD_INPUT_LIMITS.inputBytes) refuse('Guard input byte limit exceeded.')
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.length !== length || ownKeys.some((key) => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)
        || Number(key) >= length || !('value' in descriptors[key]))) refuse('Guard bytes must have only native indexed data.')
    const copy = new Uint8Array(length)
    Uint8Array.prototype.set.call(copy, input)
    return copy
}

/** Capture once: the evaluator never consumes native payloads or reparses shell text. */
export function parseGuardInput(input: unknown, options: GuardParseOptions = {}): GuardParseResult {
    try {
        if (![undefined, 'refuse', 'mark'].includes(options.dynamicWords)) refuse('Unknown guard dynamic word mode.')
        if (options.home !== undefined && !posix.isAbsolute(path(options.home))) refuse('The guard was given a HOME that is not an absolute path.')
        let decoded = input
        if (typeof input === 'object' && input !== null && isProxy(input)) refuse('Guard input must be own data.')
        if (isUint8Array(input)) {
            const bytes = captureBytes(input)
            try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
            catch (error) {
                if (!hasErrorCode(error, 'ERR_ENCODING_INVALID_ENCODED_DATA')) throw error
                refuse('Guard input is not valid UTF-8.')
            }
        }
        if (typeof decoded === 'string') {
            if (/[\uD800-\uDFFF]/u.test(decoded) || Buffer.byteLength(decoded) > GUARD_INPUT_LIMITS.inputBytes) refuse('Invalid or oversized guard input.')
            try { decoded = JSON.parse(decoded) }
            catch (error) {
                if (!(error instanceof SyntaxError)) throw error
                refuse('Guard input is not valid JSON.')
            }
        }
        const captured = snapshotJson(decoded)
        if (!record(captured) || Buffer.byteLength(JSON.stringify(captured)) > GUARD_INPUT_LIMITS.inputBytes) refuse('Guard input must be bounded own data.')
        if (!exactKeys(captured, ['hook_event_name', 'tool_name', 'tool_input', 'cwd']) || captured.hook_event_name !== 'PreToolUse'
            || !text(captured.cwd) || !posix.isAbsolute(path(captured.cwd)) || !record(captured.tool_input)) refuse('Malformed normalized guard payload.')
        const cwd = captured.cwd
        const tool = captured.tool_name
        const fields = captured.tool_input
        let paths: string[] = []
        let removed: string[] = []
        let invocations: ParsedInvocation[] = []
        let content: GuardFileContent | undefined
        if (tool === 'Bash' || tool === 'apply_patch') {
            // Native Bash calls carry execution options beside the command; they are type-checked
            // and otherwise ignored, because the command text alone decides what runs.
            const fieldChecks: Record<string, (value: JsonSnapshot | undefined) => boolean> = tool === 'Bash' ? {
                description: text, timeout: (value) => typeof value === 'number' && Number.isFinite(value),
                run_in_background: (value) => typeof value === 'boolean', dangerouslyDisableSandbox: (value) => typeof value === 'boolean',
            } : {}
            if (!exactKeys(fields, ['command'], Object.keys(fieldChecks)) || !text(fields.command) || !fields.command
                || Object.entries(fieldChecks).some(([key, valid]) => Object.hasOwn(fields, key) && !valid(fields[key]))) refuse('Malformed command payload.')
            if (tool === 'Bash') invocations = parseShell(fields.command, cwd, { options, definitions: new Set(), depth: 0 })
            else {
                ({ paths, removed } = patchPaths(fields.command))
                content = { kind: 'patch', text: fields.command }
            }
        } else if (tool === 'NotebookEdit') {
            if (!exactKeys(fields, ['notebook_path', 'new_source'], ['cell_id', 'cell_type', 'edit_mode'])
                || !text(fields.notebook_path) || !posix.isAbsolute(fields.notebook_path)
                || Object.values(fields).some(value => !text(value))
                || fields.cell_type !== undefined && !['code', 'markdown'].includes(String(fields.cell_type))
                || fields.edit_mode !== undefined && !['replace', 'insert', 'delete'].includes(String(fields.edit_mode))) refuse('Malformed notebook payload.')
            paths = [path(fields.notebook_path)]
        } else if (tool === 'Edit' || tool === 'Write') {
            if (!exactKeys(fields, ['file_path'], tool === 'Edit' ? ['old_string', 'new_string', 'replace_all'] : ['content'])
                || !text(fields.file_path)) refuse('Malformed file payload.')
            if (Object.entries(fields).some(([key, value]) => key === 'replace_all' ? typeof value !== 'boolean' : !text(value))) refuse('Malformed file field.')
            paths = [path(fields.file_path)]
            // Writing nothing empties the file, which is the shell's `: > file`.
            if (tool === 'Write' && fields.content === '') removed = [...paths]
            // OpenCode's plugin passes new text only for the configuration file, so a payload may lack it.
            if (tool === 'Write' && typeof fields.content === 'string') content = { kind: 'write', path: paths[0]!, content: fields.content }
            if (tool === 'Edit' && typeof fields.old_string === 'string' && typeof fields.new_string === 'string') {
                content = { kind: 'replace', path: paths[0]!, old: fields.old_string, new: fields.new_string, all: fields.replace_all === true }
            }
        } else if (!mcpTool(tool)) refuse('Unsupported guard tool.')
        if (paths.length + invocations.reduce((sum, item) => sum + item.redirects.length, 0) > GUARD_INPUT_LIMITS.paths) refuse('Guard path limit exceeded.')
        for (const item of invocations) {
            Object.freeze(item.argv)
            item.words.forEach(Object.freeze)
            Object.freeze(item.words)
            item.redirects.forEach(Object.freeze)
            Object.freeze(item.redirects)
            Object.freeze(item)
        }
        const result: GuardParseResult = { status: 'parsed', tool, cwd, paths, removed, invocations,
            ...content ? { content } : {} }
        parsedInputs.add(result)
        return result
    } catch (error) {
        return { status: 'unavailable', reason: error instanceof RefusalError ? error.message : 'Guard input capture failed.' }
    }
}
