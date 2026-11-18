/**
 * Owns the text edit `cockpit approve` makes to cockpit.toml when a person approves MCP servers:
 * set one `name = "<sha256>"` line per server in the `[mcp.approved]` table, adding the table when
 * the file has none. Every other byte is left alone. The verified write re-parses the result and
 * refuses anything beyond those approvals; a layout this module cannot locate the table in (an
 * inline or dotted `approved`) is refused by name rather than guessed at.
 */
import { canonicalJson } from '../canonical-json.js'
import { sha256Hex } from '../sha256.js'
import { ENVIRONMENT_CODES } from '../environment/contract.js'
import type { CockpitConfig } from '../schema.js'
import { scanHeaders, type SiblingEdit } from './sibling-toml.js'
import { writeVerifiedConfig, type VerifiedWriteResult } from './verified-write.js'

export function setMcpApprovals(text: string, approvals: Readonly<Record<string, string>>): SiblingEdit {
    const lines = text.split('\n')
    const headers = scanHeaders(lines)
    const firstHeader = headers[0]?.line ?? lines.length
    if (lines.slice(0, firstHeader).some(row => /^\s*mcp\s*[.=]/.test(row))) {
        return { kind: 'unsupported', reason: 'mcp is written as a top-level inline table or dotted key, and cockpit edits only an [mcp.approved] table' }
    }
    const mcp = headers.findIndex(header => !header.array && header.path === 'mcp')
    if (mcp >= 0 && lines.slice(headers[mcp]!.line + 1, headers[mcp + 1]?.line ?? lines.length).some(row => /^\s*approved\s*[.=]/.test(row))) {
        return { kind: 'unsupported', reason: 'approved is written inside [mcp] as an inline table or dotted key, and cockpit edits only an [mcp.approved] table' }
    }
    const index = headers.findIndex(header => !header.array && header.path === 'mcp.approved')
    const entry = (name: string) => `${name} = ${JSON.stringify(approvals[name])}`
    if (index < 0) {
        const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
        return { kind: 'edited', text: `${text}${separator}[mcp.approved]\n${Object.keys(approvals).map(entry).join('\n')}\n` }
    }
    const start = headers[index]!.line
    const end = headers[index + 1]?.line ?? lines.length
    for (const name of Object.keys(approvals)) {
        const key = new RegExp(`^\\s*(?:${name}|"${name}")\\s*=`)
        const found = lines.slice(start + 1, end).flatMap((row, offset) => key.test(row) ? [start + 1 + offset] : [])
        if (found.length > 1) return { kind: 'unsupported', reason: `[mcp.approved] sets ${name} more than once` }
        if (found.length === 1) lines[found[0]!] = entry(name)
        else lines.splice(start + 1, 0, entry(name))
    }
    return { kind: 'edited', text: lines.join('\n') }
}

/**
 * Records a person's approval of exactly these server digests in cockpit.toml, whose bytes the caller
 * read as `text` with digest `expectedSha256` and parsed as `config`. A completed write returns the
 * digest of the bytes it wrote, so the caller binds the sync to those and not to a later read.
 */
export async function recordMcpApprovals(path: string, text: string, expectedSha256: string, config: CockpitConfig,
    approvals: Readonly<Record<string, string>>): Promise<Exclude<VerifiedWriteResult, { kind: 'complete' }> | Readonly<{ kind: 'complete'; sha256: string }>> {
    const byHand = 'set each approval under [mcp.approved] in cockpit.toml by hand, as name = "<the sha256 sync --dry-run --json reports>", then run npx --no cockpit approve again'
    const edited = setMcpApprovals(text, approvals)
    if (edited.kind === 'unsupported') return { kind: 'refused', code: ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
        message: `cockpit.toml cannot be edited safely: ${edited.reason}; nothing was written`, fix: byHand }
    const expected = canonicalJson({ ...config, mcp: { ...config.mcp, approved: { ...config.mcp.approved, ...approvals } } })
    const rerun = 'run npx --no cockpit approve again and review the fresh preview'
    const written = await writeVerifiedConfig({
        path, expectedSha256, temporaryTag: 'mcp',
        edit: () => edited.text,
        isExactChange: candidate => canonicalJson(candidate) === expected,
        messages: {
            changedBefore: { message: 'cockpit.toml changed since the preview was shown; nothing was written', fix: rerun },
            changedDuring: { message: 'cockpit.toml changed while the approvals were being written; nothing was written', fix: rerun },
            invalid: reason => ({ message: `recording the approvals would leave cockpit.toml invalid (${reason}); nothing was written`, fix: byHand }),
            notExact: { message: 'recording the approvals would change more than [mcp.approved]; nothing was written', fix: byHand },
            writtenMismatch: { message: 'the approvals were written, but re-reading cockpit.toml shows a change beyond them',
                fix: 'review cockpit.toml for the change you did not make, then run npx --no cockpit approve again' },
        },
    })
    return written.kind === 'complete' ? { kind: 'complete', sha256: sha256Hex(edited.text) } : written
}
