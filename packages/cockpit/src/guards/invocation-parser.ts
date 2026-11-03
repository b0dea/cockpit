import { posix } from 'node:path'
import { isProxy, isUint8Array } from 'node:util/types'
import { hasErrorCode, RefusalError, snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'

export const mechanism = {
    id: 'guard-invocation-parser', module: 'packages/cockpit/src/guards/invocation-parser.ts',
    exports: ['GUARD_INPUT_LIMITS', 'parseGuardInput', 'isParsedGuardInput', 'shownGuardWord'],
} as const

export const GUARD_INPUT_LIMITS = Object.freeze({ inputBytes: 65_536, invocations: 256, words: 4_096, wordBytes: 4_096, paths: 256, pathBytes: 4_096 })

export type InvocationRole = 'executable' | 'argument' | 'environment-assignment-value' | 'wrapper-option-value'
    | 'redirect-target' | 'heredoc-body' | 'comment' | 'definition' | 'directory'
export interface InvocationWord { readonly role: InvocationRole; readonly value: string }
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
}
/** The new text a file tool call carries, as the payload spells it, kept so the policy pin can apply it. */
export type GuardFileContent =
    | Readonly<{ kind: 'replace'; path: string; old: string; new: string; all: boolean }>
    | Readonly<{ kind: 'write'; path: string; content: string }>
    | Readonly<{ kind: 'patch'; text: string }>
export type GuardParseResult = {
    readonly status: 'parsed'
    readonly tool: 'Bash' | 'Edit' | 'Write' | 'NotebookEdit' | 'apply_patch'
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
function keys(value: JsonSnapshotObject, required: string[], optional: string[] = []): boolean {
    return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}
function text(value: JsonSnapshot | undefined): value is string {
    return typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value) && !value.includes('\0')
}
function path(value: string): string {
    if (!value || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > GUARD_INPUT_LIMITS.pathBytes) refuse('Invalid or oversized guard path.')
    return value
}

interface Token { kind: 'word' | 'op' | 'comment' | 'body' | 'descriptor'; value: string; quoted?: boolean; dynamic?: boolean; status?: boolean }
function lex(command: string): Token[] {
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) refuse('Unsupported shell control character.')
    const tokens: Token[] = []
    const documents: { delimiter: string; quoted: boolean; tabs: boolean }[] = []
    let awaitingDocument: boolean | undefined
    let words = 0
    let index = 0
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
                if (!document.quoted && /[$`\\]/.test(body)) refuse('Dynamic heredoc expansion is unsupported.')
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
        // A brace is a group delimiter only as a word of its own; inside a word it is literal text
        // unless it forms a brace expansion, which the word loop refuses.
        const operator = /^(?:&&|\|\||<<-|<<|>>|>&|<&|<>|>\||[;&|<>()]|[{}](?=[ \t\n;&|<>()]|$))/.exec(command.slice(index))?.[0]
        if (operator) {
            if (awaitingDocument !== undefined) refuse('Missing heredoc delimiter.')
            tokens.push({ kind: 'op', value: operator })
            if (operator === '<<' || operator === '<<-') awaitingDocument = operator === '<<-'
            index += operator.length
            continue
        }
        // zsh, the default macOS shell, expands an unquoted word starting with `=` to a command's path.
        const equals = command[index] === '='
        let value = ''
        let quote = ''
        let quoted = false
        let dynamic = false
        let status = false
        const braces: number[] = []
        while (index < command.length) {
            const c = command[index]
            if (!quote && /[ \t\n;&|<>()]/.test(c)) break
            if (c === "'" && quote !== '"' || c === '"' && quote !== "'") {
                quoted = true
                quote = quote ? '' : c
                index++
                continue
            }
            if (c === '\\' && quote !== "'") {
                const next = command[++index]
                if (next === undefined) refuse('Incomplete shell escape.')
                if (next === '\n') { index++; continue }
                if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) value += '\\'
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
            // Bash and zsh expand `{a,b}` and `{1..3}` only; `@{u}` and `HEAD@{1}` stay literal. A comma
            // or `..` anywhere inside, quoted or not, counts, which refuses a few literal spellings too.
            if (!quote && c === '{') braces.push(value.length + 1)
            if (!quote && c === '}' && braces.length && /,|\.\./.test(value.slice(braces.pop()))) {
                refuse(`Unsupported brace expansion in ${shown(value + c)}: the shell turns it into several words the guard does not see. Write each word out.`)
            }
            // A tilde expands only where a word starts, or after `=` or `:` in an assignment; `HEAD~1` stays literal.
            if (quote !== "'" && (c === '$' || c === '`' || !quote && (/[*?\[]/.test(c) || c === '~' && (value === '' && !quoted || /[=:]$/.test(value))))) dynamic = true
            value += c
            index++
        }
        if (quote) refuse('Unterminated shell quote.')
        if (equals && value.length > 1) dynamic = true
        if (++words > GUARD_INPUT_LIMITS.words || Buffer.byteLength(value) > GUARD_INPUT_LIMITS.wordBytes) refuse('Guard word limit exceeded.')
        tokens.push({ kind: 'word', value, quoted, dynamic, status })
        if (awaitingDocument !== undefined) {
            if (dynamic || status || !value) refuse('Unsupported heredoc delimiter.')
            documents.push({ delimiter: value, quoted, tabs: awaitingDocument })
            awaitingDocument = undefined
        }
    }
    if (documents.length || awaitingDocument !== undefined) refuse('Unterminated heredoc.')
    return tokens
}

const separators = new Set([';', '\n', '&&', '||', '|', '&'])
const redirects = new Set(['<', '>', '>>', '<<', '<<-', '>&', '<&', '<>', '>|'])
const wrappers = new Set(['timeout', 'nice', 'nohup', 'setsid', 'env', 'command', 'exec'])
const dynamicExecutables = new Set(['eval', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'sudo', 'doas', 'xargs', 'builtin'])
// Builtins that move the shell as `cd` does, which only `cd` is judged as.
const directoryChangers = new Set(['cd', 'pushd', 'popd', 'chdir'])
const CD_REFUSAL = 'cd is judged only as `cd <dir> && <command>` (or `;`), alone in its command, with one literal directory that is absolute or starts '
    + 'with ./ or ../. A bare name such as `cd api` may resolve through CDPATH, which the guard cannot see: write `cd ./api`, or `git -C api` for Git.'
// Writing to these discards or forwards output and reading /dev/null yields nothing, so they touch
// no file; only these exact spellings qualify.
const DEVICE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const reserved = new Set(['if', 'then', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'time', '!'])

function invocation(tokens: Token[], cwd: string, definitions: Set<string>): ParsedInvocation {
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
            if (!target || target.kind !== 'word' || target.dynamic || target.status) refuse('Missing or dynamic redirect target.')
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
            if (!match || item.dynamic) refuse('Unsupported alias definition.')
            definitions.add(match[1])
        }
        return { executable: null, argv: [], cwd, wrapped: false, words: [...words, ...args.map(({ value }) => ({ role: 'definition' as const, value }))], redirects: redirectPaths }
    }
    const expanded = args.find((token) => token.dynamic)
    if (expanded) refuse(`Dynamic command construction is unsupported: ${shown(expanded.value)} holds a variable, command substitution, glob, home-directory tilde or zsh =command whose expansion the guard cannot see. Write the command and its paths out literally.`)
    let cursor = 0
    const assignments = () => {
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[cursor]?.value ?? '')) {
            const value = args[cursor++].value
            words.push({ role: 'environment-assignment-value', value: value.slice(value.indexOf('=') + 1) })
        }
    }
    assignments()
    let wrapped = false
    while (cursor < args.length && wrappers.has(posix.basename(args[cursor].value))) {
        const wrapper = posix.basename(args[cursor++].value)
        wrapped = true
        const take = () => {
            const token = args[cursor++]
            if (!token) refuse(`Missing ${wrapper} operand.`)
            words.push({ role: 'wrapper-option-value', value: token.value })
            return token
        }
        while (args[cursor]?.value.startsWith('-')) {
            const optionToken = take()
            const option = optionToken.value
            if (option === '--') break
            const [flag, attached] = option.split(/=(.*)/s)
            const valueFlags = wrapper === 'timeout' ? ['-s', '--signal', '-k', '--kill-after']
                : wrapper === 'nice' ? ['-n', '--adjustment']
                : wrapper === 'env' ? ['-C', '--chdir', '-u', '--unset']
                : wrapper === 'exec' ? ['-a'] : []
            const plainFlags = wrapper === 'timeout' ? ['--foreground', '--preserve-status', '-v', '--verbose']
                : wrapper === 'env' ? ['-i', '--ignore-environment']
                : wrapper === 'setsid' ? ['-f', '--fork', '-w', '--wait']
                : wrapper === 'command' ? ['-p'] : wrapper === 'exec' ? ['-c', '-l'] : []
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
            } else if (!(attached === undefined && (plainFlags.includes(flag) || wrapper === 'nice' && /^-\d+$/.test(flag)))) {
                refuse(`Unsupported ${wrapper} option.`)
            }
        }
        if (wrapper === 'timeout' && !/^\d+(?:\.\d+)?[smhd]?$/.test(take().value)) refuse('Invalid timeout duration.')
        if (wrapper === 'env') assignments()
        if (cursor >= args.length) refuse(`Missing ${wrapper} executable.`)
    }
    const executable = args[cursor]?.value ?? null
    if (executable !== null) {
        if (!executable || args[cursor]!.status || definitions.has(executable)) refuse('Unsupported executable or defined command invocation.')
        if (directoryChangers.has(executable)) refuse(CD_REFUSAL)
        if (dynamicExecutables.has(posix.basename(executable))) refuse(`${shown(executable)} runs a command or script built from its arguments, which the guard does not parse. Run the command itself.`)
        if (reserved.has(executable)) refuse(`Shell control flow (${executable}) is not parsed by the guard. Run each command on its own.`)
        words.push({ role: 'executable', value: executable })
        cursor++
    }
    const operands = args.slice(cursor)
    const argv = operands.map(({ value }) => value)
    words.push(...argv.map((value) => ({ role: 'argument' as const, value })))
    return { executable, argv, cwd, wrapped, words, redirects: redirectPaths, ...(args.some((token) => token.status) ? { expandsStatus: true as const } : {}) }
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
function changedDirectory(tokens: readonly Token[], definitions: ReadonlySet<string>): string | undefined {
    if (tokens[0]?.kind !== 'word' || tokens[0].value !== 'cd' || definitions.has('cd')) return undefined
    const operands = tokens.slice(1).filter((token) => token.kind !== 'comment')
    if (operands[0]?.kind === 'word' && operands[0].value === '--') operands.shift()
    const target = operands.length === 1 && operands[0]!.kind === 'word' && !operands[0]!.dynamic && !operands[0]!.status ? operands[0]!.value : undefined
    // Both shells search CDPATH before the working directory for any other relative spelling.
    if (target === undefined || !/^(?:\/|\.\.?(?:\/|$))/.test(target)) refuse(CD_REFUSAL)
    // Both shells resolve `cd` by spelling unless set to follow links (`set -P`, zsh's chase_links),
    // which the guard cannot see, as it cannot see CDPATH.
    if (climbsOutOfName(target)) refuse(`${CD_REFUSAL} A .. after a directory name is not: a shell set to follow links resolves it from wherever a link there leads.`)
    return target
}

function parseShell(command: string, cwd: string): ParsedInvocation[] {
    const tokens = lex(command)
    const result: ParsedInvocation[] = []
    const definitions = new Set<string>()
    let current: Token[] = []
    let braces = 0
    let needsCommand = false
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
    const append = (item: ParsedInvocation) => {
        if (result.length === GUARD_INPUT_LIMITS.invocations) refuse('Guard invocation limit exceeded.')
        result.push(item)
    }
    const flush = (separator?: string) => {
        const target = current.length ? changedDirectory(current, definitions) : undefined
        // A pipeline or background job runs `cd` in a subshell in bash, and the last stage of a pipeline in the current shell in zsh.
        if (target !== undefined && (gate === '|' || separator === '|' || separator === '&')) refuse(`${CD_REFUSAL} A cd in a pipeline or background job is not.`)
        if (current.length && gate === '|') for (const directory of ran) append(invocation(current, directory, definitions))
        else if (current.length) {
            const runs = states.filter((state) => gate === undefined || state.ok === (gate === '&&'))
            ran = [...new Set(runs.map((state) => state.directory))]
            const next = states.filter((state) => !runs.includes(state))
            if (target !== undefined) {
                const moved = [...new Set(ran.map((directory) => path(posix.resolve(directory, target))))]
                // The directory itself is inspected as each later command's working directory is.
                for (const directory of moved) append({ executable: null, argv: [], cwd: directory, wrapped: false, words: [{ role: 'directory', value: target }], redirects: [] })
                next.push(...ran.map((directory) => ({ directory, ok: false })), ...moved.map((directory) => ({ directory, ok: true })))
            } else {
                for (const directory of ran) append(invocation(current, directory, definitions))
                next.push(...ran.flatMap((directory) => [{ directory, ok: true }, { directory, ok: false }]))
            }
            states = [...new Map(next.map((state) => [`${state.ok}\0${state.directory}`, state])).values()]
        }
        current = []
        if (separator === '&') states = list
        if (separator === '&&' || separator === '||' || separator === '|') gate = separator
        else {
            gate = undefined
            list = states
        }
    }
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        const functionStyle = token.value === 'function' && token.kind === 'word'
        if (!current.length && token.kind === 'word' && (functionStyle || tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === ')')) {
            const name = functionStyle ? tokens[++i]?.value : token.value
            if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuse('Invalid function definition.')
            if (tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === ')') i += 2
            if (tokens[++i]?.value !== '{') refuse('Unsupported function body.')
            const body: InvocationWord[] = [{ role: 'definition', value: name }]
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
            }
            if (depth) refuse('Unterminated function definition.')
            i--
            definitions.add(name)
            append({ executable: null, argv: [], cwd: states[0]!.directory, wrapped: false, words: body, redirects: [] })
            needsCommand = false
            continue
        }
        if (token.kind === 'op' && separators.has(token.value)) {
            // A newline after `&&`, `||` or `|` continues the list, as a line continuation would.
            if (token.value === '\n' && needsCommand) continue
            if (['&&', '||', '|', '&'].includes(token.value) && !current.length) refuse('Missing shell command before separator.')
            flush(token.value)
            if (token.value !== '\n') needsCommand = ['&&', '||', '|'].includes(token.value)
        } else if (token.kind === 'op' && token.value === '{') {
            if (current.length) refuse('A standalone { is parsed only where it opens a command group, `{ command; }`. Quote a literal brace.')
            braces++
        } else if (token.kind === 'op' && token.value === '}') {
            if (!braces || current.length || needsCommand) refuse('Malformed brace group.')
            braces--
        } else {
            current.push(token)
            if (token.kind === 'word') needsCommand = false
        }
    }
    if (braces || needsCommand) refuse('Incomplete shell command.')
    flush()
    if (!result.length) refuse('Empty shell command.')
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
export function parseGuardInput(input: unknown): GuardParseResult {
    try {
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
        if (!keys(captured, ['hook_event_name', 'tool_name', 'tool_input', 'cwd']) || captured.hook_event_name !== 'PreToolUse'
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
            const options: Record<string, (value: JsonSnapshot | undefined) => boolean> = tool === 'Bash' ? {
                description: text, timeout: (value) => typeof value === 'number' && Number.isFinite(value),
                run_in_background: (value) => typeof value === 'boolean', dangerouslyDisableSandbox: (value) => typeof value === 'boolean',
            } : {}
            if (!keys(fields, ['command'], Object.keys(options)) || !text(fields.command) || !fields.command
                || Object.entries(options).some(([key, valid]) => Object.hasOwn(fields, key) && !valid(fields[key]))) refuse('Malformed command payload.')
            if (tool === 'Bash') invocations = parseShell(fields.command, cwd)
            else {
                ({ paths, removed } = patchPaths(fields.command))
                content = Object.freeze({ kind: 'patch', text: fields.command })
            }
        } else if (tool === 'NotebookEdit') {
            if (!keys(fields, ['notebook_path', 'new_source'], ['cell_id', 'cell_type', 'edit_mode'])
                || !text(fields.notebook_path) || !posix.isAbsolute(fields.notebook_path)
                || Object.values(fields).some(value => !text(value))
                || fields.cell_type !== undefined && !['code', 'markdown'].includes(String(fields.cell_type))
                || fields.edit_mode !== undefined && !['replace', 'insert', 'delete'].includes(String(fields.edit_mode))) refuse('Malformed notebook payload.')
            paths = [path(fields.notebook_path)]
        } else if (tool === 'Edit' || tool === 'Write') {
            if (!keys(fields, ['file_path'], tool === 'Edit' ? ['old_string', 'new_string', 'replace_all'] : ['content'])
                || !text(fields.file_path)) refuse('Malformed file payload.')
            if (Object.entries(fields).some(([key, value]) => key === 'replace_all' ? typeof value !== 'boolean' : !text(value))) refuse('Malformed file field.')
            paths = [path(fields.file_path)]
            // Writing nothing empties the file, which is the shell's `: > file`.
            if (tool === 'Write' && fields.content === '') removed = [...paths]
            // OpenCode's plugin passes new text only for the configuration file, so a payload may lack it.
            if (tool === 'Write' && typeof fields.content === 'string') content = Object.freeze({ kind: 'write', path: paths[0]!, content: fields.content })
            if (tool === 'Edit' && typeof fields.old_string === 'string' && typeof fields.new_string === 'string') {
                content = Object.freeze({ kind: 'replace', path: paths[0]!, old: fields.old_string, new: fields.new_string, all: fields.replace_all === true })
            }
        } else refuse('Unsupported guard tool.')
        if (paths.length + invocations.reduce((sum, item) => sum + item.redirects.length, 0) > GUARD_INPUT_LIMITS.paths) refuse('Guard path limit exceeded.')
        for (const item of invocations) {
            Object.freeze(item.argv)
            item.words.forEach(Object.freeze)
            Object.freeze(item.words)
            item.redirects.forEach(Object.freeze)
            Object.freeze(item.redirects)
            Object.freeze(item)
        }
        const result = Object.freeze({ status: 'parsed' as const, tool, cwd, paths: Object.freeze(paths), removed: Object.freeze(removed), invocations: Object.freeze(invocations),
            ...content ? { content } : {} })
        parsedInputs.add(result)
        return result
    } catch (error) {
        return { status: 'unavailable', reason: error instanceof RefusalError ? error.message : 'Guard input capture failed.' }
    }
}
