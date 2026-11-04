// Owns the decision records a work order cites, read and written as text: how a new record is named,
// the template cockpit scaffolds, whether a record still holds that template's placeholders, which
// order it cites, and which paths it names. The integrity of the whole directory (duplicate numbers,
// an index that misses a file) is the docs check's; this module reads only what an order needs.
import { scopeMatches, WORK_ORDER_ID } from './contract.js'

// A record named by date (2026-09-14-cache-keys.md) has no number to allocate or supersede by.
const DATED = /^\d{4}-\d{2}(?:-\d{2})?-/
const NUMBERED = /^(\d+)-/
// Every placeholder the template writes carries this, so a record nobody filled in is detectable.
const PLACEHOLDER = 'cockpit: replace this'
const STATUS_LINE = /^(\**status\**:\**[ \t]*).*$/im
const FRONT_MATTER_STATUS = /^(status:[ \t]*).*$/m

export type RecordName = Readonly<{ name: string; number?: string }>

/** The number a record file is named by, or undefined for a dated or unnumbered name. */
export function recordNumber(name: string): string | undefined {
    return DATED.test(name) ? undefined : NUMBERED.exec(name)?.[1]
}

/** The next record's file name: the next free number, at least four digits wide, unless the directory names records by date. */
export function nextRecordName(existing: readonly string[], title: string, today: string): RecordName {
    const records = existing.filter(name => name.endsWith('.md'))
    const numbers = records.flatMap(name => recordNumber(name) ?? [])
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '') || 'decision'
    if (!numbers.length && records.some(name => DATED.test(name))) {
        // Two decisions with one title on one day would otherwise share a name.
        let name = `${today}-${slug}.md`
        for (let suffix = 2; records.includes(name); suffix++) name = `${today}-${slug}-${suffix}.md`
        return { name }
    }
    const next = numbers.reduce((max, value) => Math.max(max, Number(value)), 0) + 1
    const number = String(next).padStart(Math.max(4, ...numbers.map(value => value.length)), '0')
    return { name: `${number}-${slug}.md`, number }
}

/** A single-line title, safe inside a heading and a Markdown link label. */
export function recordTitle(text: string): string {
    return text.replace(/\s+/g, ' ').trim().replace(/[[\]]/g, '')
}

export function scaffoldRecord(input: Readonly<{ title: string; number?: string; workOrder: string; supersedes?: string }>): string {
    return [`# ${input.number ? `${input.number}. ` : ''}${input.title}`, '', 'Status: accepted', `Work order: ${input.workOrder}`,
        ...input.supersedes ? [`Supersedes: ${input.supersedes}`] : [], '',
        '## Context', '', `<!-- ${PLACEHOLDER} with what made a decision necessary. -->`, '',
        '## Decision', '', `<!-- ${PLACEHOLDER} with what was decided. -->`, '',
        '## Consequences', '', `<!-- ${PLACEHOLDER} with what becomes easier or harder because of it. -->`, ''].join('\n')
}

export const holdsPlaceholders = (text: string) => text.includes(PLACEHOLDER)

/** The work orders a record cites, from a `Work order:` line or a `work_order:` front-matter field. */
export function citedOrders(text: string): readonly string[] {
    return [...text.matchAll(/^\**work[ _-]order\**:\**[ \t]*(.+)$/gim)]
        .flatMap(match => match[1]!.split(/[\s,`]+/)).filter(id => id && WORK_ORDER_ID.test(id))
}

/** The record's text with its status set to `status`, or undefined when it has no status to set. */
export function withStatus(text: string, status: string): string | undefined {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
    const set = (_line: string, key: string) => `${key}${status}`
    if (front && FRONT_MATTER_STATUS.test(front[1]!)) return text.replace(front[0], () => front[0].replace(FRONT_MATTER_STATUS, set))
    return STATUS_LINE.test(text) ? text.replace(STATUS_LINE, set) : undefined
}

/**
 * Whether a record names a path inside `scope`. A path-like word is one with a slash; a record kept
 * in a sibling names that sibling's paths without its prefix, so `prefix` qualifies them.
 */
export function namesScope(text: string, scope: readonly string[], prefix: string): boolean {
    for (const match of text.matchAll(/(?:^|[\s`(<"'[])((?:[a-z0-9][a-z0-9-]{0,63}:)?[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]*)+)/g)) {
        const path = match[1]!.replace(/^\.\//, '').replace(/[.,;:]+$/, '')
        if (scopeMatches(scope, /^[a-z0-9][a-z0-9-]{0,63}:/.test(path) ? path : `${prefix}${path}`)) return true
    }
    return false
}
