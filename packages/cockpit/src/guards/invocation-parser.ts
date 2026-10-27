import { posix } from 'node:path'
import { isProxy, isUint8Array } from 'node:util/types'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'

export const mechanism = {
    id: 'guard-invocation-parser', module: 'packages/cockpit/src/guards/invocation-parser.ts',
    exports: ['GUARD_INPUT_LIMITS', 'parseGuardInput', 'isParsedGuardInput'],
} as const

export const GUARD_INPUT_LIMITS = Object.freeze({ inputBytes: 65_536, invocations: 256, words: 4_096, wordBytes: 4_096, paths: 256, pathBytes: 4_096 })

export type InvocationRole = 'executable' | 'argument' | 'environment-assignment-value' | 'wrapper-option-value'
    | 'redirect-target' | 'heredoc-body' | 'comment' | 'definition'
export interface InvocationWord { readonly role: InvocationRole; readonly value: string }
export interface ParsedInvocation {
    readonly executable: string | null
    readonly argv: readonly string[]
    readonly cwd: string
    readonly wrapped: boolean
    readonly words: readonly InvocationWord[]
    /** `truncate` marks `>` and `>|`, which empty an existing file before anything is written. */
    readonly redirects: readonly { readonly target: string; readonly write: boolean; readonly truncate: boolean }[]
}
export type GuardParseResult = {
    readonly status: 'parsed'
    readonly tool: 'Bash' | 'Edit' | 'Write' | 'apply_patch'
    readonly cwd: string
    readonly invocations: readonly ParsedInvocation[]
    readonly paths: readonly string[]
    /** Patch targets deleted, or moved away from, as opposed to edited in place. */
    readonly removed: readonly string[]
} | { readonly status: 'unavailable'; readonly reason: string }

const parsedInputs = new WeakSet<object>()
export function isParsedGuardInput(value: unknown): value is Extract<GuardParseResult, { status: 'parsed' }> {
    return typeof value === 'object' && value !== null && parsedInputs.has(value)
}

class ParseFailure extends Error {}
function refuse(reason: string): never { throw new ParseFailure(reason) }
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

interface Token { kind: 'word' | 'op' | 'comment' | 'body' | 'descriptor'; value: string; quoted?: boolean; dynamic?: boolean }
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
        const operator = /^(?:&&|\|\||<<-|<<|>>|>&|<&|<>|>\||[;&|<>(){}])/.exec(command.slice(index))?.[0]
        if (operator) {
            if (awaitingDocument !== undefined) refuse('Missing heredoc delimiter.')
            tokens.push({ kind: 'op', value: operator })
            if (operator === '<<' || operator === '<<-') awaitingDocument = operator === '<<-'
            index += operator.length
            continue
        }
        let value = ''
        let quote = ''
        let quoted = false
        let dynamic = false
        while (index < command.length) {
            const c = command[index]
            if (!quote && /[ \t\n;&|<>(){}]/.test(c)) break
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
            if (quote !== "'" && (c === '$' || c === '`' || !quote && /[*?\[~]/.test(c))) dynamic = true
            value += c
            index++
        }
        if (quote) refuse('Unterminated shell quote.')
        if (++words > GUARD_INPUT_LIMITS.words || Buffer.byteLength(value) > GUARD_INPUT_LIMITS.wordBytes) refuse('Guard word limit exceeded.')
        tokens.push({ kind: 'word', value, quoted, dynamic })
        if (awaitingDocument !== undefined) {
            if (dynamic || !value) refuse('Unsupported heredoc delimiter.')
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
const dynamicExecutables = new Set(['eval', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'sudo', 'doas', 'xargs', 'cd'])
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
            if (!target || target.kind !== 'word' || target.dynamic) refuse('Missing or dynamic redirect target.')
            words.push({ role: 'redirect-target', value: target.value })
            if (!token.value.startsWith('<<') && !['>&', '<&'].includes(token.value)) {
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
    if (args.some((token) => token.dynamic)) refuse('Dynamic command construction is unsupported.')
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
            return token.value
        }
        while (args[cursor]?.value.startsWith('-')) {
            const option = take()
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
                const value = attached === undefined ? take() : attached
                if (!value) refuse(`Empty ${wrapper} option value.`)
                if (wrapper === 'env' && ['-C', '--chdir'].includes(flag)) cwd = path(posix.resolve(cwd, value))
            } else if (!(attached === undefined && (plainFlags.includes(flag) || wrapper === 'nice' && /^-\d+$/.test(flag)))) {
                refuse(`Unsupported ${wrapper} option.`)
            }
        }
        if (wrapper === 'timeout' && !/^\d+(?:\.\d+)?[smhd]?$/.test(take())) refuse('Invalid timeout duration.')
        if (wrapper === 'env') assignments()
        if (cursor >= args.length) refuse(`Missing ${wrapper} executable.`)
    }
    const executable = args[cursor++]?.value ?? null
    if (executable !== null) {
        if (!executable || dynamicExecutables.has(posix.basename(executable)) || reserved.has(executable) || definitions.has(executable)) refuse('Unsupported executable or defined command invocation.')
        words.push({ role: 'executable', value: executable })
    }
    const argv = args.slice(cursor).map(({ value }) => value)
    words.push(...argv.map((value) => ({ role: 'argument' as const, value })))
    return { executable, argv, cwd, wrapped, words, redirects: redirectPaths }
}

function parseShell(command: string, cwd: string): ParsedInvocation[] {
    const tokens = lex(command)
    const result: ParsedInvocation[] = []
    const definitions = new Set<string>()
    let current: Token[] = []
    let braces = 0
    let needsCommand = false
    const append = (item: ParsedInvocation) => {
        if (result.length === GUARD_INPUT_LIMITS.invocations) refuse('Guard invocation limit exceeded.')
        result.push(item)
    }
    const flush = () => {
        if (current.length) append(invocation(current, cwd, definitions))
        current = []
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
                if (item.kind === 'op' && item.value === '{') depth++
                if (item.kind === 'op' && item.value === '}') depth--
                body.push({ role: 'definition', value: item.value })
            }
            if (depth) refuse('Unterminated function definition.')
            i--
            definitions.add(name)
            append({ executable: null, argv: [], cwd, wrapped: false, words: body, redirects: [] })
            needsCommand = false
            continue
        }
        if (token.kind === 'op' && separators.has(token.value)) {
            if (['&&', '||', '|', '&'].includes(token.value) && !current.length) refuse('Missing shell command before separator.')
            flush()
            if (token.value !== '\n') needsCommand = ['&&', '||', '|'].includes(token.value)
        } else if (token.kind === 'op' && token.value === '{') {
            if (current.length) refuse('Unsupported brace expansion.')
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
    if (result.some((item) => item.executable !== null && definitions.has(item.executable))) refuse('Defined command invocation is unsupported.')
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
            catch { refuse('Guard input is not valid UTF-8.') }
        }
        if (typeof decoded === 'string') {
            if (/[\uD800-\uDFFF]/u.test(decoded) || Buffer.byteLength(decoded) > GUARD_INPUT_LIMITS.inputBytes) refuse('Invalid or oversized guard input.')
            try { decoded = JSON.parse(decoded) }
            catch { refuse('Guard input is not valid JSON.') }
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
            else ({ paths, removed } = patchPaths(fields.command))
        } else if (tool === 'Edit' || tool === 'Write') {
            if (!keys(fields, ['file_path'], tool === 'Edit' ? ['old_string', 'new_string', 'replace_all'] : ['content'])
                || !text(fields.file_path)) refuse('Malformed file payload.')
            if (Object.entries(fields).some(([key, value]) => key === 'replace_all' ? typeof value !== 'boolean' : !text(value))) refuse('Malformed file field.')
            paths = [path(fields.file_path)]
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
        const result = Object.freeze({ status: 'parsed' as const, tool, cwd, paths: Object.freeze(paths), removed: Object.freeze(removed), invocations: Object.freeze(invocations) })
        parsedInputs.add(result)
        return result
    } catch (error) {
        return { status: 'unavailable', reason: error instanceof ParseFailure ? error.message : 'Guard input capture failed.' }
    }
}
