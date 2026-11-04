// The integrity of a decision-record set: numbering, the index, statuses and supersedes links.
// Decision records drift in ways nothing else notices: concurrent branches each take the next
// free number, a record lands without an index line, and a record superseded in full keeps
// reading "Accepted" because only the newer one was edited.
import { posix } from 'node:path'
import { ENVIRONMENT_CODES, type Diagnostic } from '../environment/contract.js'
import { leadingWord, parseDecisionRecord, recordNumber, type ParsedRecord } from './decision-record.js'
import { resolveLinkTarget, walkMarkdownProse } from './markdown.js'

const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated', 'rejected'] as const

interface DecisionRecordSet {
    /** Prefixed onto every reported path: '' in the cockpit's own repository, `<slug>:` in a sibling. */
    readonly repository: string
    /** The records' directory, relative to the repository root. */
    readonly directory: string
    /** Each Markdown file directly inside the directory, by file name. */
    readonly files: ReadonlyMap<string, string>
    readonly index?: Readonly<{ path: string; body: string }>
}

const numberOf = (name: string) => { const digits = recordNumber(name); return digits === undefined ? undefined : Number(digits) }

/** Every integrity finding in one decision-record set. Index and template files are not records. */
export function inspectDecisionRecords(set: DecisionRecordSet): Diagnostic[] {
    const findings: Diagnostic[] = []
    const at = (name: string, line?: number) => `${set.repository}${posix.join(set.directory, name)}${line ? `:${line}` : ''}`
    const indexName = set.index && posix.dirname(set.index.path) === set.directory ? posix.basename(set.index.path) : undefined
    // A README or index page lists the records, and a template is the shape of one; neither decides anything.
    const names = [...set.files.keys()].filter(name => name !== indexName && !/^(?:readme|index)\.md$/i.test(name) && !/template/i.test(name)).sort()
    const records = new Map<string, ParsedRecord>()
    for (const name of names) {
        const parsed = parseDecisionRecord(name, set.files.get(name)!)
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
        const number = numberOf(name)
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
                : names.find(candidate => numberOf(candidate) === reference.number)
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
            const resolved = resolveLinkTarget(posix.dirname(set.index.path), link.target)
            if (resolved === undefined || !resolved.endsWith('.md') || posix.dirname(resolved) !== set.directory) continue
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
