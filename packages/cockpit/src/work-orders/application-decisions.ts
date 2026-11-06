// The decisions an order records: which are unresolved, whether a cited record still stands for its
// decision, the records that bear on an order's scope, and `work decide`, which writes or cites one.
import { posix } from 'node:path'

import { RefusalError } from '../environment/contract.js'
import { recordNumber, withStatus } from '../docs/decision-record.js'
import { splitRepositoryPath } from '../repository-path.js'
import type { WorkOrder } from './contract.js'
import { citedOrders, holdsPlaceholders, namesScope, nextRecordName, recordTitle, scaffoldRecord } from './decisions.js'
import type { WorkRecord } from './store.js'
import type { WorkApplicationComposition } from './composition.js'
import { complete, now, refusal, TERMINAL, type WorkApplicationOutcome, type WorkContext, type WorkRequest } from './application-context.js'

// Decisions recorded on an order, each with its latest resolution.
export const DECISIONS_UNDECLARED = 'decision records need a directory: declare one in cockpit.toml, for example [docs] decisions = "docs/adr", '
    + 'with decisions_index = "docs/adr/README.md" if the records have an index'
export function decisions(record: WorkRecord) {
    return record.notes.flatMap((row, index) => row.kind !== 'decision' ? [] : [{ decision: index + 1, title: recordTitle(row.text),
        resolution: record.notes.findLast(note => note.kind === 'resolution' && note.resolves === index + 1) }])
}
// Why a cited record no longer stands for its decision; `filled` also requires that the template's placeholders are gone.
export function recordProblem(text: string | undefined, reference: string, orderId: string, filled: boolean): string | undefined {
    if (text === undefined) return `its record ${reference} does not exist`
    if (!citedOrders(text).includes(orderId)) return `its record ${reference} does not cite ${orderId}; add the line "Work order: ${orderId}"`
    return filled && holdsPlaceholders(text) ? `its record ${reference} still holds the template's placeholders; replace each "<!-- cockpit: replace this ... -->" comment` : undefined
}
export async function unresolvedDecisions(record: WorkRecord, composition: WorkApplicationComposition): Promise<readonly string[]> {
    const rows: string[] = []
    for (const row of decisions(record)) {
        const name = `decision ${row.decision} (${row.title})`
        if (!row.resolution) rows.push(`${name} is unresolved; run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work decide --config <your cockpit.toml> --work-order ${record.id} --decision ${row.decision} --record, or with --none --reason "<why>"`)
        else if (row.resolution.record) {
            const problem = recordProblem(await composition.readDocsFile(row.resolution.record), row.resolution.record, record.id, true)
            if (problem) rows.push(`${name}: ${problem}`)
        }
    }
    return rows
}

// Decision records whose text names a path the order may change, so earlier decisions about that code are in front of the agent.
export async function relatedDecisions(context: WorkContext, order: WorkOrder): Promise<Readonly<{ relatedDecisions?: readonly string[]; relatedDecisionsUnavailable?: string }>> {
    const { composition } = context
    const directory = composition.docs?.decisions
    if (!directory) return {}
    const { slug } = splitRepositoryPath(directory)
    const prefix = slug === undefined ? '' : `${slug}:`
    let read: ReadonlyMap<string, string>
    // The listing is advice, so a directory cockpit cannot read is reported here and refused where a record is written.
    try { read = await context.decisionRecords() }
    catch (error) { if (!(error instanceof RefusalError)) throw error; return { relatedDecisionsUnavailable: error.message } }
    return { relatedDecisions: [...read.entries()]
        .filter(([reference, text]) => reference !== composition.docs?.decisionsIndex && namesScope(text, order.scope, prefix)).map(([reference]) => reference) }
}

export async function decideOrder(request: Extract<WorkRequest, { operation: 'work-decide' }>, context: WorkContext): Promise<WorkApplicationOutcome> {
    const { composition, operation, store } = context
    const directory = composition.docs?.decisions
    if (!directory) return refusal(operation, DECISIONS_UNDECLARED)
    const orderId = request.workOrderId
    const record = await store.read(orderId)
    if (!record || TERMINAL.has(record.state)) return refusal(operation, `${orderId} has no open record to resolve a decision on`)
    const decision = record.notes[request.decision - 1]
    if (decision?.kind !== 'decision') return refusal(operation, `note ${request.decision} on ${orderId} is not a decision; work status lists each order's open decisions`)
    const resolve = (fields: Readonly<{ text: string; record?: string }>, writes?: () => Promise<void>) => store.update(orderId, async existing => {
        if (!existing || TERMINAL.has(existing.state)) throw new RefusalError(`${orderId} closed while its decision was being resolved`)
        await writes?.()
        return { record: { ...existing, notes: [...existing.notes, { at: now(), by: 'agent', kind: 'resolution', resolves: request.decision, ...fields }] }, value: undefined }
    })
    const resolution = request.resolution
    if (resolution.kind === 'none') {
        await resolve({ text: resolution.reason })
        return complete(operation, { id: orderId, decision: request.decision, resolution: 'none', reason: resolution.reason })
    }
    if (resolution.path !== undefined) {
        if (!resolution.path.startsWith(`${directory}/`)) return refusal(operation, `${resolution.path} is not inside [docs] decisions ${directory}; write the record there`)
        if (resolution.supersedes) return refusal(operation, '--supersedes applies when cockpit writes the record; with a path, write the Supersedes line and the old record\'s status yourself')
        const problem = recordProblem(await composition.readDocsFile(resolution.path), resolution.path, orderId, false)
        if (problem) return refusal(operation, `${resolution.path} cannot resolve decision ${request.decision}: ${problem}`)
        await resolve({ text: `recorded in ${resolution.path}`, record: resolution.path })
        return complete(operation, { id: orderId, decision: request.decision, record: resolution.path })
    }
    // Scaffold the record; the agent fills in its body, and signoff refuses while the template's placeholders remain.
    const existing = await context.decisionRecords()
    const names = [...existing.keys()].map(reference => reference.slice(directory.length + 1))
    const title = recordTitle(decision.text)
    const named = nextRecordName(names, title, now().slice(0, 10))
    const reference = `${directory}/${named.name}`
    const writes = [{ reference, create: true, text: '' }]
    let supersedes: string | undefined
    if (resolution.supersedes) {
        if (!named.number) return refusal(operation, `the records in ${directory} are named by date, so none has a number to supersede`)
        const old = names.filter(name => Number(recordNumber(name)) === Number(resolution.supersedes))
        if (old.length !== 1) return refusal(operation, `${directory} has ${old.length ? `${old.length} records` : 'no record'} numbered ${resolution.supersedes}; pass the number of exactly one`)
        supersedes = recordNumber(old[0]!)!
        const marked = withStatus(existing.get(`${directory}/${old[0]}`)!, `superseded by ${named.number}`)
        if (marked === undefined) return refusal(operation, `${directory}/${old[0]} has no Status line to mark superseded; add "Status: accepted" to it`)
        writes.push({ reference: `${directory}/${old[0]}`, create: false, text: marked })
    }
    writes[0]!.text = scaffoldRecord({ title, workOrder: orderId, ...named.number ? { number: named.number } : {}, ...supersedes ? { supersedes } : {} })
    const index = composition.docs?.decisionsIndex
    if (index !== undefined && await composition.readDocsFile(index) === undefined) return refusal(operation, `[docs] decisions_index ${index} does not exist; create it, or remove decisions_index from cockpit.toml`)
    const link = index === undefined ? undefined : posix.relative(posix.dirname(splitRepositoryPath(index).path), splitRepositoryPath(reference).path)
    await resolve({ text: `recorded in ${reference}`, record: reference },
        () => composition.writeDecisionRecords(writes, link === undefined ? undefined : `- [${named.number ? `${named.number}. ` : ''}${title}](${link})`))
    return complete(operation, { id: orderId, decision: request.decision, record: reference, written: writes.map(row => row.reference),
        next: `fill in ${reference}: signoff refuses while its "cockpit: replace this" placeholders remain` })
}
