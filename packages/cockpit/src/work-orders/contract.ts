// Owns the work-order file: `workorders/<id>.md`, whose YAML front-matter is the whole contract an
// order is accepted, checked and graded against, and whose Markdown body is free notes cockpit never
// reads. One schema validates the front-matter; the digest binds it with the bytes of every source a
// criterion cites and the commit each repository stood at when the order was accepted.
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { REPOSITORY_PATH } from '../repository-path.js'

// One inert word, never a path or an option: the CLI, the guard and the store each admit it before it names a file.
export const WORK_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const WORK_ORDER_LIMITS = Object.freeze({ bytes: 65_536, criteria: 12, scope: 64, textBytes: 2_048, arguments: 32, argumentBytes: 2_048 })

const PRINTABLE = /^[^\x00-\x08\x0b-\x1f\x7f]*$/
const text = z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= WORK_ORDER_LIMITS.textBytes && PRINTABLE.test(value),
    `at most ${WORK_ORDER_LIMITS.textBytes} bytes without control characters`)
const repositoryPath = z.string().max(1_024).regex(REPOSITORY_PATH, 'a relative path, optionally <sibling slug>:path, without .. or a leading /')
const sourcePath = repositoryPath.refine(value => !/[*?]/.test(value), 'a source names one file, without wildcards')
const argument = z.string().min(1).refine(value => Buffer.byteLength(value) <= WORK_ORDER_LIMITS.argumentBytes && !/[\x00-\x1f\x7f]/.test(value), 'a bounded argument without control characters')
const GateCheck = z.object({
    gate: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'a declared [testing] gate id'),
    // A selected value that starts with `-` would reach the product's tool as an option of its own.
    select: z.string().max(4_096).regex(/^(?:spec|file|test|route):[^-]/, 'spec|file|test|route:<value>').optional(),
}).strict()
const Check = z.union([GateCheck, z.array(argument).min(1).max(WORK_ORDER_LIMITS.arguments)])
export type WorkOrderCheck = z.infer<typeof Check>
const Criterion = z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, 'a short identifier such as AC1'),
    text,
    check: Check.optional(),
    source: sourcePath.optional(),
}).strict()
const Criteria = z.array(Criterion).min(1).max(WORK_ORDER_LIMITS.criteria)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'each criterion id is used once')

export const WorkOrderFrontMatter = z.object({
    id: z.string().regex(WORK_ORDER_ID, 'letters, digits, dot, underscore or hyphen, at most 128'),
    objective: text,
    scope: z.array(repositoryPath).min(1).max(WORK_ORDER_LIMITS.scope).describe('Paths and globs the work may change.'),
    depends_on: z.array(z.string().regex(WORK_ORDER_ID)).max(32).default([]),
    gates: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(16).default([]).describe('Declared [testing] gates that must pass at work check.'),
    criteria: Criteria,
    non_goals: z.array(text).max(32).default([]),
}).strict()
export type WorkOrder = z.infer<typeof WorkOrderFrontMatter>
export type WorkOrderCriterion = WorkOrder['criteria'][number]

export type ParsedFile<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; problems: readonly string[] }>

function frontMatter(bytes: Uint8Array): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; problems: readonly string[] }> {
    if (bytes.byteLength > WORK_ORDER_LIMITS.bytes) return { ok: false, problems: [`the file exceeds ${WORK_ORDER_LIMITS.bytes} bytes`] }
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch (error) {
        if (!(error instanceof TypeError)) throw error
        return { ok: false, problems: ['the file is not UTF-8'] }
    }
    const lines = source.replace(/^﻿/, '').split(/\r?\n/)
    const end = lines.indexOf('---', 1)
    if (lines[0] !== '---' || end < 0) return { ok: false, problems: ['the file must start with YAML front-matter between two --- lines'] }
    const document = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true, prettyErrors: false })
    if (document.errors.length) return { ok: false, problems: document.errors.map(error => `front-matter is not YAML: ${error.message.split('\n')[0]}`) }
    return { ok: true, value: document.toJS({ maxAliasCount: 0 }) }
}

function issues(error: z.ZodError): readonly string[] {
    return error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : 'front-matter'}: ${issue.message}`)
}

/** Parses `workorders/<id>.md`; the id the file declares must be the name it is stored under. */
export function parseWorkOrder(bytes: Uint8Array, fileId: string): ParsedFile<WorkOrder> {
    const read = frontMatter(bytes)
    if (!read.ok) return read
    const parsed = WorkOrderFrontMatter.safeParse(read.value)
    if (!parsed.success) return { ok: false, problems: issues(parsed.error) }
    if (parsed.data.id !== fileId) return { ok: false, problems: [`id: the file workorders/${fileId}.md declares id ${parsed.data.id}; they must match`] }
    if (parsed.data.depends_on.includes(parsed.data.id)) return { ok: false, problems: ['depends_on: an order cannot depend on itself'] }
    return { ok: true, value: parsed.data }
}

/** The quick-path file `cockpit grade --criteria` reads: front-matter with criteria, and optionally scope and gates. */
const CriteriaFile = z.object({ criteria: Criteria, scope: z.array(repositoryPath).max(WORK_ORDER_LIMITS.scope).default([]),
    gates: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(16).default([]), objective: text.optional() }).strict()
export function parseCriteriaFile(bytes: Uint8Array): ParsedFile<z.infer<typeof CriteriaFile>> {
    const read = frontMatter(bytes)
    if (!read.ok) return read
    const parsed = CriteriaFile.safeParse(read.value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problems: issues(parsed.error) }
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
}

/** The digest an acceptance binds: the contract, each cited source's bytes, and the base commits. */
export function workOrderDigest(order: WorkOrder, sources: Readonly<Record<string, string>>, base: Readonly<Record<string, string>>): string {
    return createHash('sha256').update(JSON.stringify(canonical({ order, sources, base }))).digest('hex')
}

/** One part of a contract an amendment changed in a way that may lower the bar, as it read before and after. */
export type AmendmentReview = Readonly<{ field: string; before: string; after: string }>
type ContractAmendment = Readonly<{ removed: readonly string[]; review: readonly AmendmentReview[] }>

const criterionText = (row: WorkOrderCriterion) =>
    `${row.text}${row.check ? ` [check: ${JSON.stringify(row.check)}]` : ''}${row.source ? ` [source: ${row.source}]` : ''}`

/**
 * How a changed contract moves the bar. Dropping an accepted criterion or gate lowers it in every
 * reading, so it is `removed`. A rewritten criterion, a widened scope, a dropped or reworded non-goal
 * or a new objective may lower it or only clarify it: no byte comparison can tell which, so each is
 * returned for review with its text before and after. Adding a criterion or gate, narrowing scope and
 * adding a non-goal only raise the bar.
 */
export function contractAmendment(accepted: WorkOrder, changed: WorkOrder): ContractAmendment {
    const removed = [...accepted.criteria.filter(before => !changed.criteria.some(row => row.id === before.id)).map(row => `${row.id} is removed`),
        ...accepted.gates.filter(gate => !changed.gates.includes(gate)).map(gate => `gate ${gate} is removed`)]
    const review: AmendmentReview[] = accepted.criteria.flatMap(before => {
        const after = changed.criteria.find(row => row.id === before.id)
        return after && JSON.stringify(canonical(after)) !== JSON.stringify(canonical(before))
            ? [{ field: `criteria.${before.id}`, before: criterionText(before), after: criterionText(after) }] : []
    })
    if (changed.scope.some(entry => !accepted.scope.includes(entry))) review.push({ field: 'scope', before: accepted.scope.join(', '), after: changed.scope.join(', ') })
    if (accepted.non_goals.some(goal => !changed.non_goals.includes(goal))) review.push({ field: 'non_goals', before: accepted.non_goals.join('; '), after: changed.non_goals.join('; ') })
    if (accepted.objective !== changed.objective) review.push({ field: 'objective', before: accepted.objective, after: changed.objective })
    return { removed, review }
}

/** The review fields a `checks` grade enforces: the criteria's checks and the scope. Objective and non-goals bind only where a model grades. */
export const checksBindsField = (field: string) => field === 'scope' || field.startsWith('criteria.')

// `**` crosses directories, `*` and `?` stay within one; a plain entry also covers what is below it.
/** Whether a path falls in `scope`, with each glob compiled once for the many paths a caller tests. */
export function scopeMatcher(scope: readonly string[]): (path: string) => boolean {
    const tests = scope.map((entry): (path: string) => boolean => {
        if (!/[*?]/.test(entry)) {
            const directory = `${entry.replace(/\/$/, '')}/`
            return path => path === entry || path.startsWith(directory)
        }
        const pattern = entry.split(/(\*\*\/?|\*|\?)/).map(part => part === '**' || part === '**/' ? '(?:.*/)?' + (part === '**' ? '.*' : '')
            : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')
        const compiled = new RegExp(`^${pattern}$`)
        return path => compiled.test(path)
    })
    return path => tests.some(test => test(path))
}

export const scopeMatches = (scope: readonly string[], path: string): boolean => scopeMatcher(scope)(path)
