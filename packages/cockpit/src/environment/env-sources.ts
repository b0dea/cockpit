// Owns: `cockpit env keys` and `cockpit env schema`, the agent's route to what a schema declares and
// to changing it. A broad native secret denial also refuses the documentation names, and no rule-only
// exception is safe, so the names, the text and a replacement come through a guarded command instead.
// Must not: run Varlock or any resolver, read a name outside the four below except a draft that passes
// `draftRefusal`, follow a link, or let a value, a default, a resolver expression, a comment's text
// or an unparsed line reach `env keys` output.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'

import { readBoundedFile } from '../bounded-read.js'
import { loadCockpitConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { refusalOutcome } from '../refusal.js'
import { REPOSITORY_FILE, splitRepositoryPath } from '../repository-path.js'
import { guardProtectedLocations, isSensitiveGuardName, foldGuardSpelling } from '../guards/evaluator.js'
import { deriveRegistry } from '../registry-derivation.js'
import { ENVIRONMENT_CODES, errorCause, isMissing, type Diagnostic, type ExecutionStep } from './contract.js'
import { discoverSchemaRoots, entryName, reasonName, type SchemaRoot } from './env-schema-observation.js'
import { observationSearchPath, resolveGitExecutable } from './executable.js'
import { loadServedSiblings, servedPath } from './sibling-checkouts.js'

type Execute = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
interface EnvCommandInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
}
interface EnvCommandOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

const SCHEMA_FILE = '.env.schema'
const TEMPLATE_FILES = ['.env.example', '.env.sample', '.env.template'] as const
const LOOKED_FOR = [SCHEMA_FILE, ...TEMPLATE_FILES]
const GIT_TIMEOUT_MS = 30_000
const FILE_LIMIT_BYTES = 1_048_576
// Together these stay well inside what a result may hold, so a large estate is cut here and says so.
const KEY_OUTPUT_LIMIT = 2_048
const SOURCE_OUTPUT_LIMIT = 256
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const CALL_START = /[A-Za-z_][A-Za-z0-9_-]*\(/y
const DECORATOR_NAME = /[A-Za-z][A-Za-z0-9_]*/y

export interface EnvKey {
    readonly name: string
    readonly required?: boolean
    readonly sensitive?: boolean
    readonly type?: string
}
type DecoratorValue =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'word'; text: string }>
    | Readonly<{ kind: 'call'; callee: string }>
    | Readonly<{ kind: 'opaque' }>
type Decorator = Readonly<{ name: string; value: DecoratorValue }>

function quoteAt(text: string, index: number): string | undefined {
    const character = text[index]
    if (character !== '"' && character !== "'" && character !== '`') return undefined
    return text.startsWith(character.repeat(3), index) ? character.repeat(3) : character
}

// A backslash escapes in every quote style. Reading `\'` as a closing quote could end a value early
// and show its remaining lines as keys; reading it as an escape can only swallow keys, which are
// then counted as unparsed.
function afterQuote(text: string, index: number, quote: string): number {
    for (let cursor = index + quote.length; cursor < text.length; cursor++) {
        if (text[cursor] === '\\') cursor++
        else if (text.startsWith(quote, cursor)) return cursor + quote.length
    }
    return -1
}

function afterBrackets(text: string, open: number): number {
    let depth = 0
    for (let cursor = open; cursor < text.length; cursor++) {
        const quote = quoteAt(text, cursor)
        if (quote !== undefined) {
            const end = afterQuote(text, cursor, quote)
            if (end < 0) return -1
            cursor = end - 1
        } else if ('([{'.includes(text[cursor]!)) depth++
        else if (')]}'.includes(text[cursor]!) && --depth === 0) return cursor + 1
    }
    return -1
}

function callAt(text: string, index: number): string | undefined {
    CALL_START.lastIndex = index
    return CALL_START.exec(text)?.[0].slice(0, -1)
}

// Reads the decorators of one comment line, keeping only each one's name and the shape of its value.
function parseDecorators(line: string): Readonly<{ decorators: readonly Decorator[]; complete: boolean }> {
    const decorators: Decorator[] = []
    let cursor = 0
    while (cursor < line.length) {
        if (line[cursor] === '#') return { decorators, complete: true }
        if (line[cursor] !== '@') return { decorators, complete: false }
        DECORATOR_NAME.lastIndex = cursor + 1
        const name = DECORATOR_NAME.exec(line)?.[0]
        if (name === undefined) return { decorators, complete: false }
        cursor += 1 + name.length
        let value: DecoratorValue = { kind: 'none' }
        if (line[cursor] === '(') {
            cursor = afterBrackets(line, cursor)
            if (cursor < 0) return { decorators, complete: false }
            value = { kind: 'opaque' }
        } else if (line[cursor] === '=') {
            cursor++
            const quote = quoteAt(line, cursor)
            const callee = callAt(line, cursor)
            if (quote !== undefined || callee !== undefined || line[cursor] === '{' || line[cursor] === '[') {
                cursor = quote === undefined ? afterBrackets(line, cursor + (callee?.length ?? 0)) : afterQuote(line, cursor, quote)
                if (cursor < 0) return { decorators, complete: false }
                value = callee === undefined ? { kind: 'opaque' } : { kind: 'call', callee }
            } else {
                const word = /[^\s#]*/y
                word.lastIndex = cursor
                const text = word.exec(line)![0]
                if (text === '') return { decorators, complete: false }
                cursor += text.length
                value = { kind: 'word', text }
            }
        }
        decorators.push({ name, value })
        const before = cursor
        while (line[cursor] === ' ' || line[cursor] === '\t') cursor++
        if (cursor === before && cursor < line.length && line[cursor] !== '#') return { decorators, complete: false }
    }
    return { decorators, complete: true }
}

function literal(value: DecoratorValue): boolean | undefined {
    if (value.kind === 'none') return true
    if (value.kind !== 'word') return undefined
    return value.text === 'true' ? true : value.text === 'false' ? false : undefined
}
const negated = (value: boolean | undefined) => value === undefined ? undefined : !value

type Declared = { required?: boolean | undefined; sensitive?: boolean | undefined; type?: string | undefined }

// A condition such as `@required=forEnv(prod)` is declared but has no static answer, so it overrides
// a default and states nothing: the key `in` the result distinguishes it from no decorator at all.
function itemDeclarations(decorators: readonly Decorator[]): Declared {
    const declared: Declared = {}
    for (const { name, value } of decorators) {
        if (name === 'required') declared.required = literal(value)
        else if (name === 'optional') declared.required = negated(literal(value))
        else if (name === 'sensitive') declared.sensitive = literal(value)
        else if (name === 'public') declared.sensitive = negated(literal(value))
        else if (name === 'type') {
            const text = value.kind === 'word' ? value.text : value.kind === 'call' ? value.callee : undefined
            declared.type = text !== undefined && TYPE_NAME.test(text) ? text : undefined
        }
    }
    return declared
}

function rootDefaults(decorators: readonly Decorator[]): Declared {
    const defaults: Declared = {}
    for (const { name, value } of decorators) {
        if (name === 'defaultRequired') defaults.required = literal(value)
        else if (name === 'defaultSensitive') defaults.sensitive = literal(value)
    }
    return defaults
}

// Where the value that starts at `start` stops, across lines when a quote or a call stays open, so no
// line inside a value is read as a key. `rest` is what follows the value on its last line.
function valueEnd(text: string, start: number): Readonly<{ rest: number }> | undefined {
    let cursor = start
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
    const quote = quoteAt(text, cursor)
    if (quote !== undefined) {
        const end = afterQuote(text, cursor, quote)
        return end < 0 ? undefined : { rest: end }
    }
    const callee = callAt(text, cursor)
    if (callee !== undefined) {
        const end = afterBrackets(text, cursor + callee.length)
        return end < 0 ? undefined : { rest: end }
    }
    return { rest: cursor }
}

const nextLine = (text: string, from: number) => { const end = text.indexOf('\n', from); return end < 0 ? text.length : end }

/** The key names and declared attributes of one schema or template, read statically. */
export function parseEnvKeys(text: string): Readonly<{ keys: readonly EnvKey[]; unparsed: number }> {
    const keys = new Map<string, EnvKey>()
    let unparsed = 0
    let cursor = 0
    let attached: Decorator[] = []
    let header: Decorator[] = []
    let defaults: Declared = {}
    let headerOpen = true
    while (cursor < text.length) {
        const end = nextLine(text, cursor)
        const line = text.slice(cursor, end).trim()
        if (line === '') {
            attached = []
            cursor = end + 1
            continue
        }
        if (line.startsWith('#')) {
            const body = line.slice(1).trim()
            if (/^-{3,}$/.test(body)) {
                if (headerOpen) defaults = rootDefaults(header)
                headerOpen = false
                attached = []
            } else if (body.startsWith('@')) {
                // Only a comment that starts with a decorator declares one: Varlock reads the same line
                // with a decorator in the middle of its prose as a description.
                const parsed = parseDecorators(body)
                if (!parsed.complete) unparsed++
                attached.push(...parsed.decorators)
                if (headerOpen) header.push(...parsed.decorators)
            }
            cursor = end + 1
            continue
        }
        headerOpen = false
        header = []
        const equal = line.indexOf('=')
        const lineStart = cursor + text.slice(cursor, end).indexOf(line)
        const value = valueEnd(text, equal < 0 ? lineStart : lineStart + equal + 1)
        if (value === undefined) {
            // A value that never closes leaves no way to tell keys from its content, so reading stops.
            unparsed++
            break
        }
        const name = /^(?:export[ \t]+)?(.*?)[ \t]*$/.exec(equal < 0 ? '' : line.slice(0, equal))?.[1] ?? ''
        const lastEnd = nextLine(text, value.rest)
        if (equal < 0 || !KEY_NAME.test(name)) {
            unparsed++
        } else {
            const own = itemDeclarations(attached)
            // Varlock also honours a decorator after the value. Those are not read, so a default may be
            // overridden there and is not stated for such a key.
            const inline = /(?:^|\s)#\s*@/.test(text.slice(value.rest, lastEnd))
            const required = 'required' in own ? own.required : inline ? undefined : defaults.required
            const sensitive = 'sensitive' in own ? own.sensitive : inline ? undefined : defaults.sensitive
            keys.set(name, { name, ...required === undefined ? {} : { required }, ...sensitive === undefined ? {} : { sensitive },
                ...own.type === undefined ? {} : { type: own.type } })
        }
        attached = []
        cursor = lastEnd + 1
    }
    return { keys: [...keys.values()], unparsed }
}

type FileRead =
    | Readonly<{ kind: 'text'; text: string }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'symbolic-link' }>
    | Readonly<{ kind: 'not-a-file' }>
    | Readonly<{ kind: 'hard-link' }>
    | Readonly<{ kind: 'too-large' }>
    | Readonly<{ kind: 'unreadable'; reason: string }>

async function readDocumentationFile(path: string): Promise<FileRead> {
    try {
        const status = await lstat(path)
        if (status.isSymbolicLink()) return { kind: 'symbolic-link' }
        if (!status.isFile()) return { kind: 'not-a-file' }
        // Another name for the same bytes may be a secret file, which this name would print.
        if (status.nlink > 1) return { kind: 'hard-link' }
        const read = readBoundedFile(path, FILE_LIMIT_BYTES)
        if (read.kind === 'too-large') return read
        return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) }
    } catch (error) {
        if (isMissing(error)) return { kind: 'missing' }
        if (error instanceof TypeError) return { kind: 'unreadable', reason: 'it is not valid UTF-8' }
        return { kind: 'unreadable', reason: `it could not be read (${errorCause(error)})` }
    }
}

// A tracked directory can be replaced by a link in the working tree, which would lead a read elsewhere.
async function linkedComponent(schema: SchemaRoot): Promise<string | undefined> {
    let cursor = schema.root
    for (const _segment of schema.relative === '' ? [] : schema.relative.split('/')) {
        try {
            if ((await lstat(cursor)).isSymbolicLink()) return cursor
        } catch (error) {
            if (!isMissing(error)) throw error
        }
        cursor = dirname(cursor)
    }
    return undefined
}

type Discovered = Readonly<{
    cockpitRoot: string
    configPath: string
    instances: readonly string[]
    lookedIn: readonly string[]
    roots: Awaited<ReturnType<typeof discoverSchemaRoots>>
}>

async function discover(input: EnvCommandInput, command: 'env keys' | 'env schema', execute: Execute): Promise<Discovered | EnvCommandOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return loaded
    const { config, source } = loaded.result
    const search = observationSearchPath(input.env)
    const git = search.state === 'available' ? await resolveGitExecutable({ ...input.env, PATH: search.path }) : undefined
    if (git?.state !== 'available') {
        const reason = git === undefined ? (search as { reason: string }).reason : (git as { reason: string }).reason
        return refusalOutcome(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `${command} asks Git which schemas each sibling tracks, and Git is unavailable: ${reason}`, 'git',
            `put Git in an absolute PATH directory and remove noncanonical absolute entries, then rerun ${cockpitCommand(command)}`)
    }
    const cockpitRoot = dirname(source.path)
    // A sibling `cockpit use` serves from another checkout is read there, as the env-schema probe does.
    const served = await loadServedSiblings(cockpitRoot, config)
    if (served.kind !== 'complete') return { status: 2, diagnostics: [served.diagnostic], result: null }
    const siblings = config.sibling.map((sibling) => ({ slug: sibling.slug, root: servedPath(served.siblings, sibling.slug) }))
    const roots = await discoverSchemaRoots({ cockpit: { root: cockpitRoot, name: config.cockpit.name }, siblings, git: git.value, timeoutMs: GIT_TIMEOUT_MS }, execute)
    // The guard's own derivation of declared instances, below the same served checkouts.
    const derived = deriveRegistry(config)
    const instances = derived.kind === 'complete'
        ? derived.result.secretPaths.map(({ slug, path }) => resolve(servedPath(served.siblings, slug), path)) : undefined
    if (instances === undefined) return refusalOutcome(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `${command} could not derive the declared instances from ${source.path}`, 'config', 'fix the configuration, then rerun the command')
    return { cockpitRoot, configPath: source.path, instances, roots, lookedIn: [...new Set([cockpitRoot, ...siblings.map(({ root }) => root), ...roots.map(({ schema }) => schema.root)])].slice(0, SOURCE_OUTPUT_LIMIT) }
}

function schemaReference(schema: SchemaRoot): string {
    const file = schema.relative === '' ? SCHEMA_FILE : `${schema.relative}/${SCHEMA_FILE}`
    return schema.owner === 'cockpit root' ? file : `${schema.owner}:${file}`
}

type Source = Readonly<Record<string, unknown>>

/** `cockpit env keys`: the names each schema, or a root's templates where it has none, declares. */
export async function runEnvKeys(input: EnvCommandInput, dependencies: Readonly<{ execute: Execute }>): Promise<EnvCommandOutcome> {
    const found = await discover(input, 'env keys', dependencies.execute)
    if ('status' in found) return found
    const diagnostics: Diagnostic[] = []
    const sources: Source[] = []
    let keysLeft = KEY_OUTPUT_LIMIT
    let keysOmitted = 0
    let rootsOmitted = 0
    const rerun = cockpitCommand('env keys')
    for (const { schema, status } of found.roots) {
        if (status !== undefined) {
            diagnostics.push({ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, target: entryName(schema),
                message: `the sources of ${reasonName(schema)} could not be listed: ${status.cause}`,
                fix: `fix what the message names, then rerun ${rerun}` })
            continue
        }
        if (sources.length >= SOURCE_OUTPUT_LIMIT) { rootsOmitted++; continue }
        const owner = entryName(schema)
        const linked = await linkedComponent(schema)
        if (linked !== undefined) {
            sources.push({ owner, path: linked, kind: 'schema', state: 'symbolic-link' })
            diagnostics.push(skipped(owner, linked))
            continue
        }
        let names: readonly [string, 'schema' | 'template'][] = [[SCHEMA_FILE, 'schema']]
        let reads = await Promise.all(names.map(([name]) => readDocumentationFile(join(schema.root, name))))
        if (reads[0]!.kind === 'missing') {
            names = TEMPLATE_FILES.map((name) => [name, 'template'])
            reads = await Promise.all(names.map(([name]) => readDocumentationFile(join(schema.root, name))))
        }
        reads.forEach((read, index) => {
            if (read.kind === 'missing') return
            const [name, kind] = names[index]!
            const path = join(schema.root, name)
            const base = { owner, path, kind, ...kind === 'schema' ? { reference: schemaReference(schema) } : {} }
            if (read.kind === 'text') {
                const { keys, unparsed } = parseEnvKeys(read.text)
                const kept = keys.slice(0, keysLeft)
                keysLeft -= kept.length
                keysOmitted += keys.length - kept.length
                sources.push({ ...base, state: 'read', keys: kept, unparsed, ...kept.length < keys.length ? { keysOmitted: keys.length - kept.length } : {} })
            } else if (read.kind === 'symbolic-link' || read.kind === 'not-a-file' || read.kind === 'hard-link') {
                sources.push({ ...base, state: read.kind })
                diagnostics.push(skipped(owner, path))
            } else {
                const reason = read.kind === 'too-large' ? `it is larger than ${FILE_LIMIT_BYTES} bytes` : read.reason
                sources.push({ ...base, state: 'unreadable', reason })
                diagnostics.push({ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, target: owner,
                    message: `${path} was not read: ${reason}`, fix: `fix or shrink the file, then rerun ${rerun}` })
            }
        })
    }
    const truncated = keysOmitted > 0 || rootsOmitted > 0
        ? `output stops at ${KEY_OUTPUT_LIMIT} keys and ${SOURCE_OUTPUT_LIMIT} sources: ${keysOmitted} keys and ${rootsOmitted} directories were left out` : undefined
    return {
        status: diagnostics.some(({ severity }) => severity === 'error') ? 2 : 0,
        diagnostics,
        result: {
            summary: sources.length === 0
                ? `no source found: looked for ${new Intl.ListFormat('en', { type: 'disjunction' }).format(LOOKED_FOR)} in each directory below`
                : `${sources.length} sources read statically; no value is shown and nothing was resolved`,
            sources, lookedFor: LOOKED_FOR, lookedIn: found.lookedIn, ...truncated === undefined ? {} : { truncated },
        },
    }
}

function skipped(owner: string, path: string): Diagnostic {
    return { severity: 'warning', code: ENVIRONMENT_CODES.ENV_KEYS_SOURCE_SKIPPED, target: owner,
        message: `${path} is a symbolic link, a hard link or not a regular file, so it was not read`,
        fix: 'replace it with a regular file in that directory' }
}

function refused(reference: string, why: string, fix: string): EnvCommandOutcome {
    return refusalOutcome(ENVIRONMENT_CODES.ENV_SCHEMA_READ_REFUSED, `${reference} was not printed: ${why}`, reference, fix)
}

/**
 * `cockpit env schema`: one schema's text, verbatim. A schema is documentation that must hold no
 * value: the guard treats the name that way and a committed one is already readable through Git.
 */
export async function runEnvSchema(input: EnvCommandInput & Readonly<{ reference: string; replaceFrom?: string }>, dependencies: Readonly<{ execute: Execute }>): Promise<EnvCommandOutcome> {
    const { reference } = input
    const list = `run ${cockpitCommand('env keys')} and pass the reference a schema source prints: <slug>:<relative directory>/${SCHEMA_FILE} in a sibling, or ${SCHEMA_FILE} in the cockpit root`
    const { slug, path } = splitRepositoryPath(reference)
    // Decided from the words alone, before anything is touched: a case-insensitive filesystem would
    // otherwise open the real schema, or a secret file, under a name that only resembles it.
    if (!REPOSITORY_FILE.test(reference) || posix.basename(path) !== SCHEMA_FILE || path.split('/').slice(0, -1).some(isSensitiveGuardName)) {
        return refused(reference, `only a file named exactly ${SCHEMA_FILE}, at a path with no . or .. segments, can be read`, list)
    }
    const found = await discover(input, 'env schema', dependencies.execute)
    if ('status' in found) return found
    const directory = posix.dirname(path) === '.' ? '' : posix.dirname(path)
    const owns = ({ schema }: Discovered['roots'][number]) => slug === undefined
        ? resolve(schema.root) === resolve(found.cockpitRoot) : schema.owner === slug
    const unavailable = found.roots.find((entry) => owns(entry) && entry.status !== undefined)
    if (unavailable?.status !== undefined) return refused(reference, `its sibling's schemas could not be listed: ${unavailable.status.cause}`, `fix what the message names, then rerun ${cockpitCommand('env schema', { args: `--path ${reference}` })}`)
    const entry = found.roots.find((candidate) => owns(candidate) && candidate.schema.relative === directory)
    if (entry === undefined) {
        return refused(reference, 'it is not in a directory cockpit discovers: a root, or a directory holding a schema Git tracks', list)
    }
    const linked = await linkedComponent(entry.schema)
    if (linked !== undefined) return refused(reference, `${linked} is a symbolic link`, 'replace the link with a directory')
    const file = join(entry.schema.root, SCHEMA_FILE)
    if (input.replaceFrom !== undefined) return await replaceSchema({ reference, file, draft: input.replaceFrom, found })
    const read = await readDocumentationFile(file)
    switch (read.kind) {
        case 'text': return { status: 0, diagnostics: [], result: { reference, path: file, text: read.text } }
        case 'missing': return refused(reference, `${file} does not exist`, list)
        case 'symbolic-link': return refused(reference, `${file} is a symbolic link`, 'replace the link with a regular file')
        case 'not-a-file': return refused(reference, `${file} is not a regular file`, 'replace it with a regular file')
        case 'hard-link': return refused(reference, `${file} has another hard link, so its bytes may be another file's`, 'replace it with a regular file of its own')
        case 'too-large': return refused(reference, `${file} is larger than ${FILE_LIMIT_BYTES} bytes`, 'shrink the schema: it declares variables and holds no values')
        case 'unreadable': return refused(reference, `${file}: ${read.reason}`, 'fix what the message names, then rerun the command')
    }
}

function protectedLocation(path: string, found: Discovered): boolean {
    const folded = foldGuardSpelling(path)
    return guardProtectedLocations({ canonicalRoot: found.cockpitRoot, configPath: found.configPath, instances: found.instances }).some((location) => {
        const protectedPath = foldGuardSpelling(location.path)
        return folded === protectedPath || location.type === 'directory' && folded.startsWith(`${protectedPath}/`)
    })
}

// A replaced schema can be printed back with `env schema`, so a draft that could hold a secret would
// launder it. The name decides first, then the guard's own locations, under the path as spelled and
// as resolved, then what the file is: a link or second name may be a protected file under a safe name.
async function draftRefusal(path: string, found: Discovered): Promise<string | undefined> {
    const sensitive = (candidate: string) => candidate.split('/').some(isSensitiveGuardName)
    const forbidden = (candidate: string) => sensitive(candidate)
        ? 'its path has a segment that is .secrets or starts with .env'
        : protectedLocation(candidate, found) ? 'the guard protects it: a declared environment instance, a guard control, the secrets directory or the configuration' : undefined
    const spelled = forbidden(path)
    if (spelled !== undefined) return spelled
    let status
    try { status = await lstat(path) } catch (error) { return `it could not be inspected (${errorCause(error)})` }
    if (status.isSymbolicLink()) return 'it is a symbolic link'
    if (!status.isFile()) return 'it is not a regular file'
    if (status.nlink > 1) return 'it has another hard link, so its bytes may be another file\'s'
    let resolved
    try { resolved = await realpath(path) } catch (error) { return `it could not be resolved (${errorCause(error)})` }
    return forbidden(resolved)
}

/** Replaces or creates one schema atomically from a draft, so a reader sees the old bytes or the new. */
async function replaceSchema(input: Readonly<{ reference: string; file: string; draft: string; found: Discovered }>): Promise<EnvCommandOutcome> {
    const { reference, file, found } = input
    const draft = resolve(found.cockpitRoot, input.draft)
    const refuse = (why: string, fix: string) => refusalOutcome(ENVIRONMENT_CODES.ENV_SCHEMA_REPLACE_REFUSED, `${reference} was not changed: ${why}`, reference, fix)
    const fixDraft = 'write the draft with your normal tools to a regular file of its own, away from environment files and secrets, then rerun the command'
    const refusal = await draftRefusal(draft, found)
    if (refusal !== undefined) return refuse(`the draft ${draft} was not read: ${refusal}`, fixDraft)
    if (protectedLocation(file, found)) return refuse(`${file} is a location the guard protects`, 'change the declaration that protects it, or leave the file to a person')
    let before
    try { before = await lstat(file) } catch (error) { if (!isMissing(error)) return refuse(`${file} could not be inspected (${errorCause(error)})`, 'fix what the message names, then rerun the command') }
    if (before?.isSymbolicLink()) return refuse(`${file} is a symbolic link`, 'replace the link with a regular file')
    if (before && !before.isFile()) return refuse(`${file} is not a regular file`, 'replace it with a regular file')
    if (before && before.nlink > 1) return refuse(`${file} has another hard link, so a replacement would leave the other name behind`, 'replace it with a regular file of its own')
    let bytes
    try {
        const read = readBoundedFile(draft, FILE_LIMIT_BYTES)
        if (read.kind === 'too-large') return refuse(`the draft ${draft} is larger than ${FILE_LIMIT_BYTES} bytes`, fixDraft)
        bytes = read.bytes
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
        return refuse(`the draft ${draft} could not be read: ${error instanceof TypeError ? 'it is not valid UTF-8' : errorCause(error)}`, fixDraft)
    }
    // Not named like a schema: nothing should mistake a half-written file for one, and the guard and
    // every ignore rule treat a `.env*` name as a secret.
    const temporary = join(dirname(file), `.cockpit-schema-replace-${randomBytes(8).toString('hex')}`)
    let created = false
    try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before ? before.mode & 0o777 : 0o644)
        created = true
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        const current = await lstat(file).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error })
        if (current?.ino !== before?.ino || current?.mtimeMs !== before?.mtimeMs || current?.size !== before?.size) {
            return refuse(`${file} changed while the replacement was prepared`, 'rerun the command')
        }
        await rename(temporary, file)
        created = false
        const directory = await open(dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
        return refuse(`the replacement could not be written (${errorCause(error)})`, 'fix what the message names, then rerun the command')
    } finally {
        if (created) await unlink(temporary)
    }
    return { status: 0, diagnostics: [], result: { reference, path: file, action: before ? 'replaced' : 'created', bytes: bytes.length,
        note: `not validated until committed: preflight and doctor run only a committed schema` } }
}
