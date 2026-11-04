// The integrity of a decision-record set: numbering, the index, statuses and supersedes links.
// Decision records drift in ways nothing else notices: concurrent branches each take the next
// free number, a record lands without an index line, and a record superseded in full keeps
// reading "Accepted" because only the newer one was edited.
import { posix } from 'node:path'
import { parseDocument } from 'yaml'
import { ENVIRONMENT_CODES, type Diagnostic } from '../environment/contract.js'
import { walkMarkdownProse } from './markdown.js'

export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated', 'rejected'] as const

export interface DecisionRecordSet {
    /** Prefixed onto every reported path: '' in the cockpit's own repository, `<slug>:` in a sibling. */
    readonly repository: string
    /** The records' directory, relative to the repository root. */
    readonly directory: string
    /** Each Markdown file directly inside the directory, by file name. */
    readonly files: ReadonlyMap<string, string>
    readonly index?: Readonly<{ path: string; body: string }>
}

// Dated names (2026-09-<slug>.md) order by date and carry no number to collide.
const DATED = /^(?:19|20)\d{2}-\d{2}(?:-\d{2})?(?=[-_.])/
const NUMBERED = /^(\d+)(?=[-_. ])/
const STATUS_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i
const STATUS_HEADING = /^#{1,6}\s+status\s*$/i
const KEYWORD = /\b(supersedes|superseded\s+by)\b/gi
// A link (rewritten to [[target]]), a file name, `ADR-12`, `#12`, or a zero-padded `of 0012`; a bare
// number counts only right after the keyword, so a year later in the sentence is not read as a record.
const REFERENCE = /\[\[([^\]]+)\]\]|(?:\b(?:adr|decision|record)s?[-\s]?#?|#|\b(?:of|in)\s+(?=0))(\d{1,5})\b|([\w./-]+\.md)\b/gi

function recordNumber(name: string): number | undefined {
    if (DATED.test(name)) return undefined
    const match = NUMBERED.exec(name)
    return match ? Number(match[1]) : undefined
}

function leadingWord(value: string): string {
    return value.replace(/[*_`[\]]/g, '').trim().split(/[\s,.;:()]/, 1)[0]!.toLowerCase()
}

type Reference = Readonly<{ line: number; text: string; full: boolean; number?: number; file?: string }>

interface ParsedRecord {
    readonly status?: Readonly<{ line: number; value: string }>
    readonly supersedes: readonly Reference[]
}

// A link becomes [[target]] so its target survives as one token; code spans keep their text.
function referenceText(prose: string): string {
    return prose.replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_match, _label: string, target: string) => ` [[${target}]] `).replace(/`/g, ' ')
}

function referencesIn(line: number, text: string, record: string): Reference[] {
    const found: Reference[] = []
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
        const add = (reference: Omit<Reference, 'line' | 'text' | 'full'>, text: string) => {
            if (!found.some(row => row.number === reference.number && row.file === reference.file)) found.push({ line, text, full: outgoing && leading, ...reference })
        }
        if (bare) add({ number: Number(bare[1]) }, bare[1]!)
        for (const match of clause.matchAll(REFERENCE)) {
            const target = match[1] ?? match[3]
            if (target !== undefined) {
                if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !target.split('#', 1)[0]!.endsWith('.md')) continue
                add({ file: posix.normalize(posix.join(posix.dirname(record), target.split('#', 1)[0]!)) }, target)
            } else add({ number: Number(match[2]) }, match[0].trim())
        }
    })
    return found
}

function parseRecord(name: string, body: string): ParsedRecord | Readonly<{ unreadable: string }> {
    let walked
    try { walked = walkMarkdownProse(body) } catch (error) { return { unreadable: (error as Error).message } }
    const rows = body.split(/\r?\n/)
    let status: ParsedRecord['status']
    const supersedes: Reference[] = []
    if (rows[0] === '---') {
        const end = rows.indexOf('---', 1)
        const front = parseDocument(rows.slice(1, end === -1 ? 1 : end).join('\n'))
        if (front.errors.length > 0) return { unreadable: `its front matter is not valid YAML (${front.errors[0]!.message.split('\n', 1)[0]})` }
        const data = front.toJS() as Record<string, unknown> | null
        if (data && typeof data === 'object') {
            if (typeof data.status === 'string') status = { line: rows.findIndex(row => /^status\s*:/i.test(row)) + 1, value: data.status }
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
            if (line && line[1]!.trim() !== '') status = { line: row.line, value: line[1]! }
            else if (STATUS_HEADING.test(prose)) {
                const next = walked.lines.slice(position + 1).find(candidate => candidate.prose.trim() !== '')
                if (next && !/^#/.test(next.prose)) status = { line: next.line, value: next.prose }
            }
        }
        supersedes.push(...referencesIn(row.line, referenceText(prose), name))
    })
    return { ...status ? { status } : {}, supersedes }
}

/** Every integrity finding in one decision-record set. Index and template files are not records. */
export function inspectDecisionRecords(set: DecisionRecordSet): Diagnostic[] {
    const findings: Diagnostic[] = []
    const at = (name: string, line?: number) => `${set.repository}${posix.join(set.directory, name)}${line ? `:${line}` : ''}`
    const indexName = set.index && posix.dirname(set.index.path) === set.directory ? posix.basename(set.index.path) : undefined
    // A README or index page lists the records, and a template is the shape of one; neither decides anything.
    const names = [...set.files.keys()].filter(name => name !== indexName && !/^(?:readme|index)\.md$/i.test(name) && !/template/i.test(name)).sort()
    const records = new Map<string, ParsedRecord>()
    for (const name of names) {
        const parsed = parseRecord(name, set.files.get(name)!)
        if ('unreadable' in parsed) {
            findings.push({ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                message: `decision record ${at(name)} could not be read: ${parsed.unreadable}`, target: at(name),
                fix: 'correct the record so it parses as Markdown with optional YAML front matter, then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
            continue
        }
        records.set(name, parsed)
    }

    const byNumber = new Map<number, string[]>()
    for (const name of names) {
        const number = recordNumber(name)
        if (number !== undefined) byNumber.set(number, [...byNumber.get(number) ?? [], name])
    }
    for (const [number, shared] of byNumber) {
        if (shared.length < 2) continue
        // Not "_DUPLICATE": the CLI reads that suffix as a repeated option and prints a usage hint.
        findings.push({ severity: 'error', code: 'DECISION_NUMBER_REUSED' satisfies typeof ENVIRONMENT_CODES.DECISION_NUMBER_REUSED, target: at(shared[1]!),
            message: `decision records ${shared.map(name => at(name)).join(' and ')} share number ${number}`,
            fix: 'renumber the later record to the next free number, then update the index and every supersedes line that cites it' })
    }

    for (const [name, record] of records) {
        const status = record.status === undefined ? undefined : leadingWord(record.status.value)
        if (!DECISION_STATUSES.some(known => known === status)) {
            findings.push({ severity: 'error', code: 'DECISION_STATUS_MISSING' satisfies typeof ENVIRONMENT_CODES.DECISION_STATUS_MISSING, target: at(name, record.status?.line),
                message: record.status === undefined ? `decision record ${at(name)} states no status`
                    : `decision record ${at(name)} has status "${record.status.value.trim()}", which starts with none of ${DECISION_STATUSES.join(', ')}`,
                fix: `give the record a status line such as "Status: Accepted", or status: accepted in its front matter, starting with one of ${DECISION_STATUSES.join(', ')}` })
        }
        for (const reference of record.supersedes) {
            const target = reference.file !== undefined
                ? posix.dirname(reference.file) === '.' && records.has(reference.file) ? reference.file : undefined
                : names.find(candidate => recordNumber(candidate) === reference.number)
            if (target === undefined) {
                findings.push({ severity: 'error', code: 'DECISION_LINK_UNRESOLVED' satisfies typeof ENVIRONMENT_CODES.DECISION_LINK_UNRESOLVED, target: at(name, reference.line),
                    message: `decision record ${at(name, reference.line)} cites ${reference.text}, which names no record in ${set.repository}${set.directory}`,
                    fix: 'correct the number or link to name an existing record, or restore the record it names' })
                continue
            }
            const superseded = records.get(target)?.status
            // Only an accepted record replaces another; a proposed or rejected one leaves it standing.
            if (reference.full && ['accepted', 'superseded', 'deprecated'].includes(status ?? '') && superseded && leadingWord(superseded.value) === 'accepted') {
                findings.push({ severity: 'error', code: 'DECISION_SUPERSEDED_STALE' satisfies typeof ENVIRONMENT_CODES.DECISION_SUPERSEDED_STALE, target: at(target, superseded.line),
                    message: `decision record ${at(target)} still has status "${superseded.value.trim()}", but ${at(name, reference.line)} supersedes it`,
                    fix: `change the superseded record's status to "Superseded by" the newer record; if only part of it is replaced, say which part in the newer record's supersedes line, such as "supersedes the retry clause of ${target}"` })
            }
        }
    }

    if (set.index) {
        let links
        try { links = walkMarkdownProse(set.index.body).links } catch (error) {
            findings.push({ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                message: `decision index ${set.repository}${set.index.path} could not be read: ${(error as Error).message}`, target: `${set.repository}${set.index.path}`,
                fix: 'close the HTML comment the message names, then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
            return findings
        }
        const linked = new Set<string>()
        for (const link of links) {
            const target = link.target.split('#', 1)[0]!
            if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target === '' || !target.endsWith('.md')) continue
            let decoded = target
            // A `%` that starts no valid escape is part of the file name, as CommonMark reads it.
            try { decoded = decodeURI(target) } catch (error) { if (!(error instanceof URIError)) throw error }
            const resolved = posix.normalize(posix.join(posix.dirname(set.index.path), decoded))
            if (posix.dirname(resolved) !== set.directory) continue
            const name = posix.basename(resolved)
            linked.add(name)
            if (!set.files.has(name)) {
                findings.push({ severity: 'error', code: 'DECISION_INDEX_ENTRY_MISSING' satisfies typeof ENVIRONMENT_CODES.DECISION_INDEX_ENTRY_MISSING, target: `${set.repository}${set.index.path}:${link.line}`,
                    message: `decision index ${set.repository}${set.index.path}:${link.line} links ${link.target}, which does not exist`,
                    fix: 'correct the link to the record\'s current file name, or remove the entry if the record was deleted on purpose' })
            }
        }
        for (const name of names) {
            if (linked.has(name)) continue
            findings.push({ severity: 'error', code: 'DECISION_UNINDEXED' satisfies typeof ENVIRONMENT_CODES.DECISION_UNINDEXED, target: at(name),
                message: `decision record ${at(name)} is not linked from ${set.repository}${set.index.path}`,
                fix: 'add a line linking the record to the decision index' })
        }
    }
    return findings
}
