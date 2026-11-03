/**
 * Owns the text edit `tool add` and `tool remove` make to cockpit.toml: set the one `tools` line of
 * the `[surfaces]` table, adding the table when the file has none. Every other byte is left alone.
 * The verified write re-parses the result and refuses anything beyond that one change; a layout this
 * module cannot locate the list in (a multi-line array, an inline or dotted `surfaces`) is refused by
 * name rather than guessed at.
 */
import { scanHeaders, type SiblingEdit } from './sibling-toml.js'

const TOOLS_KEY = /^\s*tools\s*=/
const SINGLE_LINE_ARRAY = /^\s*tools\s*=\s*\[[^\]#]*\]\s*(#.*)?$/

export function setSurfaceTools(text: string, tools: readonly string[]): SiblingEdit {
    const line = `tools = [${tools.map(tool => JSON.stringify(tool)).join(', ')}]`
    const lines = text.split('\n')
    const headers = scanHeaders(lines)
    const firstHeader = headers[0]?.line ?? lines.length
    if (lines.slice(0, firstHeader).some(row => /^\s*surfaces\s*[.=]/.test(row))) {
        return { kind: 'unsupported', reason: 'surfaces is written as a top-level inline table or dotted key, and cockpit edits only a [surfaces] table' }
    }
    const index = headers.findIndex(header => !header.array && header.path === 'surfaces')
    if (index < 0) {
        const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
        return { kind: 'edited', text: `${text}${separator}[surfaces]\n${line}\n` }
    }
    const start = headers[index]!.line
    const end = headers[index + 1]?.line ?? lines.length
    const keys = lines.slice(start + 1, end).flatMap((row, offset) => TOOLS_KEY.test(row) ? [start + 1 + offset] : [])
    if (keys.length === 0) {
        lines.splice(start + 1, 0, line)
        return { kind: 'edited', text: lines.join('\n') }
    }
    const current = SINGLE_LINE_ARRAY.exec(lines[keys[0]!]!)
    if (keys.length > 1 || !current) {
        return { kind: 'unsupported', reason: 'the [surfaces] tools list is not written on one line as tools = [...]' }
    }
    lines[keys[0]!] = current[1] === undefined ? line : `${line} ${current[1]}`
    return { kind: 'edited', text: lines.join('\n') }
}
