/**
 * Owns the text edits `sibling add` and `sibling remove` make to cockpit.toml: append one
 * `[[sibling]]` table, delete one table with its sub-tables, or switch one `acquire = "none"`
 * row to a recorded remote.
 *
 * It edits lines and leaves every other byte alone, so comments and formatting elsewhere in the
 * file survive. It does not judge the result: `verified-write.ts` re-parses the edited file through
 * the real schema and refuses anything that is not exactly the intended change. A layout this
 * module cannot locate rows in (an inline `sibling = [...]` array, dotted keys) is refused by name
 * rather than guessed at.
 */

export interface SiblingTableRow {
    readonly slug: string
    readonly dir: string
    readonly remote?: string
    readonly mount: string
    readonly acquire: string
    readonly var: string
    readonly toolchain: string
    readonly instruction_pointer?: boolean
    readonly purpose: string
}

export interface SiblingTableLocation {
    /** Zero-based line of the `[[sibling]]` header. */
    readonly start: number
    /** Zero-based line of the last content line owned by the row, sub-tables included. */
    readonly end: number
    /** First sub-table header after the row's own keys, or `end + 1` when it has none. */
    readonly ownKeysEnd: number
}

export type SiblingEdit =
    | Readonly<{ kind: 'edited'; text: string }>
    | Readonly<{ kind: 'unsupported'; reason: string }>

const HEADER = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/

/** Remove strings and comments so bracket counting sees only structure. */
function structuralText(line: string): string {
    let out = ''
    let quote: '"' | "'" | null = null
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index]!
        if (quote !== null) {
            if (quote === '"' && char === '\\') index += 1
            else if (char === quote) quote = null
            continue
        }
        if (char === '"' || char === "'") quote = char
        else if (char === '#') break
        else out += char
    }
    return out
}

function delimiterCount(line: string, delimiter: string): number {
    return line.split(delimiter).length - 1
}

export interface Header { readonly line: number; readonly array: boolean; readonly path: string }

/** Every table header outside multi-line strings and open arrays, by zero-based line. */
export function scanHeaders(lines: readonly string[]): Header[] {
    const headers: Header[] = []
    let multiline: '"""' | "'''" | null = null
    let depth = 0
    for (const [line, text] of lines.entries()) {
        if (multiline !== null) {
            if (delimiterCount(text, multiline) % 2 === 1) multiline = null
            continue
        }
        const match = depth === 0 ? HEADER.exec(text) : null
        if (match) {
            headers.push({ line, array: match[1] === '[[', path: match[2]! })
            continue
        }
        for (const delimiter of ['"""', "'''"] as const) {
            if (multiline === null && delimiterCount(text, delimiter) % 2 === 1) multiline = delimiter
        }
        if (multiline !== null) continue
        const structure = structuralText(text)
        depth = Math.max(0, depth + (structure.match(/[[{]/g)?.length ?? 0) - (structure.match(/[\]}]/g)?.length ?? 0))
    }
    return headers
}

const isSiblingRow = (header: Header) => header.array && header.path === 'sibling'
const isSiblingSubtable = (header: Header) => /^sibling\s*\./.test(header.path)

function locateSiblingTables(text: string): readonly SiblingTableLocation[] {
    const lines = text.split('\n')
    const headers = scanHeaders(lines)
    const locations: SiblingTableLocation[] = []
    for (const [index, header] of headers.entries()) {
        if (!isSiblingRow(header)) continue
        let nextOwn = lines.length
        let next = lines.length
        for (const following of headers.slice(index + 1)) {
            if (nextOwn === lines.length) nextOwn = following.line
            if (isSiblingSubtable(following)) continue
            next = following.line
            break
        }
        // Blank lines and comments just before the next header introduce that header, not this row.
        let end = next - 1
        while (end > header.line && /^\s*(?:#.*)?$/.test(lines[end]!)) end -= 1
        locations.push({ start: header.line, end, ownKeysEnd: Math.min(nextOwn, end + 1) })
    }
    return locations
}

const quote = (value: string) => JSON.stringify(value)

function siblingTable(row: SiblingTableRow): string {
    return ['[[sibling]]',
        `slug = ${quote(row.slug)}`,
        `dir = ${quote(row.dir)}`,
        ...(row.remote === undefined ? [] : [`remote = ${quote(row.remote)}`]),
        `mount = ${quote(row.mount)}`,
        `acquire = ${quote(row.acquire)}`,
        `var = ${quote(row.var)}`,
        `toolchain = ${quote(row.toolchain)}`,
        ...(row.instruction_pointer === true ? ['instruction_pointer = true'] : []),
        `purpose = ${quote(row.purpose)}`, ''].join('\n')
}

function unsupported(reason: string): SiblingEdit {
    return { kind: 'unsupported', reason }
}

/** `expected` is how many sibling rows the parsed configuration has; every one must be a `[[sibling]]` table. */
function locateAll(text: string, expected: number): readonly SiblingTableLocation[] | string {
    const found = locateSiblingTables(text)
    return found.length === expected ? found
        : `found ${found.length} \`[[sibling]]\` tables for ${expected} parsed siblings; the file declares siblings some other way (an inline array or dotted keys) and cockpit will not guess at it`
}

/** Placed after the last sibling row so the siblings stay together; the first row when the file has none. */
export function appendSiblingTable(text: string, row: SiblingTableRow, existingRows: number): SiblingEdit {
    const located = locateAll(text, existingRows)
    if (typeof located === 'string') return unsupported(located)
    const lines = text.split('\n')
    const last = located.at(-1)
    if (last === undefined) {
        const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
        return { kind: 'edited', text: `${text}${separator}${siblingTable(row)}` }
    }
    lines.splice(last.end + 1, 0, '', ...siblingTable(row).split('\n').slice(0, -1))
    return { kind: 'edited', text: lines.join('\n') }
}

export function removeSiblingTable(text: string, index: number, existingRows: number): SiblingEdit {
    const located = locateAll(text, existingRows)
    if (typeof located === 'string') return unsupported(located)
    const { start, end } = located[index]!
    const lines = text.split('\n')
    let after = end + 1
    while (after < lines.length && lines[after]!.trim() === '') after += 1
    const kept = [...lines.slice(0, start), ...lines.slice(after)]
    // Removing the last table must not leave the blank line that separated it from the table before.
    if (after >= lines.length) {
        while (kept.length > 0 && kept.at(-1)!.trim() === '') kept.pop()
        kept.push('')
    }
    return { kind: 'edited', text: kept.join('\n') }
}

export function recordSiblingRemote(text: string, index: number, existingRows: number, remote: string): SiblingEdit {
    const located = locateAll(text, existingRows)
    if (typeof located === 'string') return unsupported(located)
    const { start, ownKeysEnd } = located[index]!
    const lines = text.split('\n')
    const own = (pattern: RegExp) => lines.slice(start + 1, ownKeysEnd).flatMap((line, offset) => pattern.test(line) ? [start + 1 + offset] : [])
    const acquire = own(/^\s*acquire\s*=\s*"none"\s*(?:#.*)?$/)
    if (acquire.length !== 1) return unsupported('the row has no single `acquire = "none"` line to switch; edit it by hand')
    const dir = own(/^\s*dir\s*=/)
    lines[acquire[0]!] = lines[acquire[0]!]!.replace('"none"', '"auto"')
    lines.splice((dir[0] ?? acquire[0]!) + 1, 0, `remote = ${quote(remote)}`)
    return { kind: 'edited', text: lines.join('\n') }
}
