// The lines Claude reads as instructions: outside fenced code blocks and HTML comments, each without
// its line ending. Sync's adoption rule and the sibling projection read files this way.
export function claudeActiveLines(bytes: string): { index: number; line: string }[] {
    const active: { index: number; line: string }[] = []
    let fence: { marker: string; length: number } | undefined
    let inComment = false
    for (const [index, raw] of bytes.split('\n').entries()) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        const trimmed = line.trimStart()
        const marker = /^ {0,3}(?<fence>`{3,}|~{3,})(?<suffix>.*)$/u.exec(line)?.groups
        if (fence) {
            if (marker?.fence?.[0] === fence.marker && marker.fence.length >= fence.length && marker.suffix?.trim() === '') fence = undefined
            continue
        }
        if (inComment) {
            if (trimmed.includes('-->')) inComment = false
            continue
        }
        if (trimmed.startsWith('<!--')) {
            if (!trimmed.includes('-->')) inComment = true
            continue
        }
        if (marker?.fence && (marker.fence[0] !== '`' || !marker.suffix?.includes('`'))) {
            fence = { marker: marker.fence[0]!, length: marker.fence.length }
            continue
        }
        active.push({ index, line })
    }
    return active
}

// An `@` token starting a word, outside code spans, that names a file: a path with a directory part,
// a home or relative prefix, or a file extension. Prose such as "ask @oncall" names no file.
const IMPORT_TOKEN = /(^|\s)@([^\s`]+)/g
const importPath = (path: string) => /^(?:~|\/|\.{1,2}\/)/.test(path) || path.includes('/') || /\.[A-Za-z0-9]+$/.test(path)

/** The bytes with each active file import replaced by what `replace` returns for its path; undefined keeps it. */
export function mapClaudeImports(bytes: string, replace: (path: string) => string | undefined): string {
    const active = new Set(claudeActiveLines(bytes).map(row => row.index))
    return bytes.split('\n').map((line, index) => !active.has(index) ? line : line.split(/(`+[^`]*`+)/).map((part, segment) =>
        segment % 2 === 1 ? part : part.replace(IMPORT_TOKEN, (token, lead: string, path: string) => {
            if (!importPath(path)) return token
            const replaced = replace(path)
            return replaced === undefined ? token : `${lead}${replaced}`
        })).join('')).join('\n')
}

/** Every file Claude would import from these bytes, in order. */
export function claudeImportPaths(bytes: string): string[] {
    const paths: string[] = []
    mapClaudeImports(bytes, path => { paths.push(path); return undefined })
    return paths
}
