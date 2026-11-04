// The grammar of one decision record: how its file name numbers it, where its status is stated and
// which records it supersedes. `docs check` reads records with it and `work decide` writes them with
// it, so a record one accepts is a record the other can number and mark superseded.
import { posix } from 'node:path'
import { parseDocument } from 'yaml'
import { resolveLinkTarget, walkMarkdownProse } from './markdown.js'

// Dated names (2026-09-<slug>.md) order by date and carry no number to collide.
const DATED = /^(?:19|20)\d{2}-\d{2}(?:-\d{2})?(?=[-_.])/
const NUMBERED = /^(\d+)(?=[-_. ])/
const STATUS_LINE = /^(\s*(?:[-*]\s+)?(?:\*\*|__)?status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*)(.*)$/i
const STATUS_HEADING = /^#{1,6}\s+status\s*$/i
const FRONT_MATTER_STATUS = /^(status\s*:\s*)/i
const KEYWORD = /\b(supersedes|superseded\s+by)\b/gi
// A link (rewritten to [[target]]), a file name, `ADR-12`, `#12`, or a zero-padded `of 0012`; a bare
// number counts only right after the keyword, so a year later in the sentence is not read as a record.
const REFERENCE = /\[\[([^\]]+)\]\]|(?:\b(?:adr|decision|record)s?[-\s]?#?|#|\b(?:of|in)\s+(?=0))(\d{1,5})\b|([\w./-]+\.md)\b/gi

/** Whether a record file is named by date, and so carries no number. */
export const isDatedRecordName = (name: string) => DATED.test(name)

/** The digits a record file is numbered by, or undefined for a dated or unnumbered name. */
export function recordNumber(name: string): string | undefined {
    return DATED.test(name) ? undefined : NUMBERED.exec(name)?.[1]
}

/** The first word of a status, lowercased: `accepted` for "**Accepted** (2026-01-02)". */
export function leadingWord(value: string): string {
    return value.replace(/[*_`[\]]/g, '').trim().split(/[\s,.;:()]/, 1)[0]!.toLowerCase()
}

type SupersedesReference = Readonly<{ line: number; text: string; full: boolean; number?: number; file?: string }>

/** Where a status is stated: a front-matter field, a `Status:` line, or the line under a `## Status` heading. */
type RecordStatus = Readonly<{ line: number; value: string; form: 'front-matter' | 'line' | 'heading' }>

export interface ParsedRecord {
    readonly status?: RecordStatus
    readonly supersedes: readonly SupersedesReference[]
}

// A link becomes [[target]] so its target survives as one token; code spans keep their text.
function referenceText(prose: string): string {
    return prose.replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_match, _label: string, target: string) => ` [[${target}]] `).replace(/`/g, ' ')
}

function referencesIn(line: number, text: string, record: string): SupersedesReference[] {
    const found: SupersedesReference[] = []
    const keywords = [...text.matchAll(KEYWORD)]
    keywords.forEach((keyword, position) => {
        const start = keyword.index + keyword[0].length
        // The clause the keyword governs: up to the next keyword, a semicolon or a sentence end.
        const end = Math.min(keywords[position + 1]?.index ?? text.length,
            ...[/;/, /\.(?:\s|$)/].map(pattern => { const at = text.slice(start).search(pattern); return at === -1 ? text.length : start + at }))
        const clause = text.slice(start, end)
        const outgoing = keyword[1]!.toLowerCase() === 'supersedes'
        // "Supersedes 0012" names the whole record; "supersedes the cache clause of 0012" only a part.
        // A number that runs on into a name (`2026-09-cache.md`, `0012-x.md`) is a file name, read below.
        const bare = /^\s*:?\s*(\d{1,5})\b(?![-.]\w)/.exec(clause)
        const leading = /^\s*:?\s*(?:\[\[|(?:adr|decision|record)s?\b|#|[\w./-]+\.md\b)/i.test(clause) || bare !== null
        // "Supersedes 0012 (ADR-0012)" names one record twice; it is one reference.
        const add = (reference: Omit<SupersedesReference, 'line' | 'text' | 'full'>, text: string) => {
            if (!found.some(row => row.number === reference.number && row.file === reference.file)) found.push({ line, text, full: outgoing && leading, ...reference })
        }
        if (bare) add({ number: Number(bare[1]) }, bare[1]!)
        for (const match of clause.matchAll(REFERENCE)) {
            const target = match[1] ?? match[3]
            if (target !== undefined) {
                const file = resolveLinkTarget(posix.dirname(record), target)
                if (file?.endsWith('.md')) add({ file }, target)
            } else add({ number: Number(match[2]) }, match[0].trim())
        }
    })
    return found
}

/** A record's status and supersedes references, or why it cannot be read. `name` is its path inside the records' directory. */
export function parseDecisionRecord(name: string, body: string): ParsedRecord | Readonly<{ unreadable: string }> {
    let walked
    try { walked = walkMarkdownProse(body) } catch (error) { return { unreadable: (error as Error).message } }
    const rows = body.split(/\r?\n/)
    let status: RecordStatus | undefined
    const supersedes: SupersedesReference[] = []
    if (rows[0] === '---') {
        const end = rows.indexOf('---', 1)
        const front = rows.slice(1, end === -1 ? 1 : end)
        const parsed = parseDocument(front.join('\n'))
        if (parsed.errors.length > 0) return { unreadable: `its front matter is not valid YAML (${parsed.errors[0]!.message.split('\n', 1)[0]})` }
        const data = parsed.toJS() as Record<string, unknown> | null
        if (data && typeof data === 'object') {
            if (typeof data.status === 'string') {
                // Counted from the opening `---`; 0 where the field is not written on a line of its own.
                const at = front.findIndex(row => FRONT_MATTER_STATUS.test(row))
                status = { line: at === -1 ? 0 : at + 2, value: data.status, form: 'front-matter' }
            }
            for (const [field, text] of [['supersedes', 'Supersedes'], ['superseded_by', 'Superseded by']] as const) {
                for (const value of [data[field]].flat()) {
                    if (typeof value === 'string' || typeof value === 'number') {
                        supersedes.push(...referencesIn(rows.findIndex(row => row.startsWith(`${field}:`)) + 1, `${text} ${value}`, name))
                    }
                }
            }
        }
    }
    walked.lines.forEach((row, position) => {
        const prose = row.prose
        if (status === undefined) {
            const line = STATUS_LINE.exec(prose)
            if (line && line[2]!.trim() !== '') status = { line: row.line, value: line[2]!, form: 'line' }
            else if (STATUS_HEADING.test(prose)) {
                const next = walked.lines.slice(position + 1).find(candidate => candidate.prose.trim() !== '')
                if (next && !/^#/.test(next.prose)) status = { line: next.line, value: next.prose, form: 'heading' }
            }
        }
        supersedes.push(...referencesIn(row.line, referenceText(prose), name))
    })
    return { ...status ? { status } : {}, supersedes }
}

/**
 * The record's text with its status set to `status`, where `parseDecisionRecord` finds it and in the
 * same form; undefined when the record states no status, or states it on a line this cannot rewrite
 * in place (one an HTML comment shares).
 */
export function withStatus(text: string, status: string): string | undefined {
    const parsed = parseDecisionRecord('', text)
    if ('unreadable' in parsed || parsed.status === undefined) return undefined
    const rows = text.split('\n')
    const index = parsed.status.line - 1
    const row = rows[index]
    if (row === undefined) return undefined
    const ending = row.endsWith('\r') ? '\r' : ''
    const raw = ending ? row.slice(0, -1) : row
    const prefix = parsed.status.form === 'heading' ? '' : (parsed.status.form === 'line' ? STATUS_LINE : FRONT_MATTER_STATUS).exec(raw)?.[1]
    if (prefix === undefined) return undefined
    rows[index] = `${prefix}${status}${ending}`
    return rows.join('\n')
}
