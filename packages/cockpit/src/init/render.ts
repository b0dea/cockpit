import { AUTONOMY_DEFAULTS, GATE_DEFAULTS } from '../autonomy.js'
import { unconfirmedFix } from '../guards/answer-confirmation.js'
import type { CockpitConfig, configurationDefaults, UNCONFIRMABLE_ANSWERS } from '../schema.js'
import { emitGaps, emitToml, toSiblingRows } from '../emit.js'
import type { DocumentedSibling, Gap } from '../registry-resolve/registry.js'

/**
 * Who gave an interview answer: a person, the setup agent choosing a default it was allowed to
 * choose, no one known (an answers file that does not attribute a value cockpit never proposes, or that
 * supplies a trust decision, which the file cannot show a person made), or
 * the setup agent accepting the value init read from exact sources, which init checks against what
 * it reads. A person's answer is written as stated and a derived one with its source; the others
 * are listed under `unconfirmed`.
 */
export const ANSWER_PROVENANCES = ['operator-confirmed', 'agent-default', 'unattributed', 'derived'] as const
export type AnswerProvenance = typeof ANSWER_PROVENANCES[number]
export type UnconfirmableAnswer = typeof UNCONFIRMABLE_ANSWERS[number]
export type UnconfirmedAnswer = Readonly<{ field: UnconfirmableAnswer; provenance: 'agent-default' | 'unattributed' }>
/** An answer accepted as read: the field and the file, as file:line where one line holds it, it was read from. */
export type DerivedAnswer = Readonly<{ field: UnconfirmableAnswer; source: string }>

export function unconfirmedReason(row: UnconfirmedAnswer): string {
    return row.provenance === 'agent-default'
        ? `${row.field} was chosen by the setup agent as a default; no person stated it`
        : `${row.field} came from an answers file, which cannot show who chose it; no person is known to have stated it`
}

function renderUnconfirmed(rows: readonly UnconfirmedAnswer[] = []): string {
    if (rows.length === 0) return ''
    return `${rows.map(row => `# Unconfirmed: ${unconfirmedReason(row)}.\n`).join('')}# To confirm: ${unconfirmedFix(rows.map(row => row.field))}; until then doctor warns.\n`
}

function renderDerived(rows: readonly DerivedAnswer[]): string {
    return rows.map(row => `# Derived: ${row.field} was read from ${row.source} and accepted by the setup agent; bring-up proves it.\n`).join('')
}

/** Every decision with its default, commented out: flip one to "person" to take that decision yourself. */
function renderDecisionDefaults(): string {
    const table = (name: string, defaults: Readonly<Record<string, string>>) =>
        [`# [${name}]`, ...Object.entries(defaults).map(([key, value]) => `# ${key} = "${value}"`)]
    return `\n${[
        '# Who takes each decision. All default to "agent" except reset and mcp_approve; set one to "person" to take it yourself.',
        '# mcp_approve = "agent" lets an agent start processes outside the guard: sync then enables every server',
        '# a sibling MCP source declares, and an agent can write that file.',
        ...table('work.gates', GATE_DEFAULTS), ...table('autonomy', AUTONOMY_DEFAULTS),
    ].join('\n')}\n`
}

export interface Attribution {
    target: string
    value: unknown
    from: 'inferred' | 'default'
    because: string
}

// A wrong value in one of these widens what an agent may do or delete, so a person confirms it.
const PERSON_CONFIRMED_TARGETS: ReadonlySet<string> = new Set(['guards.protected_branches', 'guards.allow', 'guards.deny',
    'mcp.approved', 'environment.resettable_volumes', 'environment.generated_host_paths'])

/**
 * Who confirms a surfaced value: the setup agent for a schema default or the cockpit's own layout,
 * which bring-up proves, and a person for a security boundary or a value a registry dialect left
 * to a guess.
 */
export function confirmedBy(attribution: Attribution): 'agent' | 'person' {
    if (PERSON_CONFIRMED_TARGETS.has(attribution.target)) return 'person'
    return attribution.from === 'default' || attribution.target === 'cockpit.siblings_root' ? 'agent' : 'person'
}

export interface DocumentModel {
    name?: string
    defaults: ReturnType<typeof configurationDefaults>
    siblings: readonly DocumentedSibling[]
    attributions: readonly Attribution[]
    gaps: readonly Gap[]
    unconfirmed?: readonly UnconfirmedAnswer[]
    /** Values read from the cockpit root's own files, keyed by their target. */
    inferred?: Readonly<Partial<Record<'ports.bases' | 'environment.compose_files', unknown>>>
}

function renderAttributions(attributions: readonly Attribution[]): string {
    if (attributions.length === 0) return ''
    const lines = ['# Provenance — every unread value names its source and reason.']
    for (const [by, heading] of [['agent', '# The setup agent accepts these: schema defaults and the cockpit\'s own layout, which bring-up proves.'],
        ['person', '# A person confirms these, and the defaults digest covers only them: each bounds what an agent may do.']] as const) {
        const rows = attributions.filter(row => confirmedBy(row) === by)
        if (rows.length === 0) continue
        lines.push(heading, ...rows.map(row => `# [${row.from}] ${row.target} = ${JSON.stringify(row.value)}: ${row.because}`))
    }
    return `${lines.join('\n')}\n`
}

function draftConfig(model: DocumentModel): Record<string, unknown> {
    // Written, the guard hosts read as a decision that none exists, even as the schema default [].
    const { hosted_db_hosts: _hosted, vendor_endpoint_hosts: _vendors, ...guards } = model.defaults.guards
    // No registry dialect records the work-order time budgets, grading, gates, evaluator tools or
    // autonomy, so a draft that wrote the schema's values would present them as this product's
    // decisions; left out, the loader applies the same defaults.
    const { autonomy: _autonomy, ...defaults } = model.defaults
    const work = { attempt_cap: model.defaults.work.attempt_cap, wip_cap: model.defaults.work.wip_cap }
    const bases = model.inferred?.['ports.bases']
    const composeFiles = model.inferred?.['environment.compose_files']
    return {
        ...defaults,
        cockpit: {
            ...model.defaults.cockpit,
            ...(model.name ? { name: model.name } : {}),
        },
        sibling: toSiblingRows(model.siblings).map((sibling) => ({
            ...sibling,
            ...model.defaults.sibling,
        })),
        ports: { ...model.defaults.ports, ...(bases === undefined ? {} : { bases }) },
        guards,
        work,
        environment: { ...model.defaults.environment, ...(composeFiles === undefined ? {} : { compose_files: composeFiles }) },
    }
}

export function renderIncompleteDocument(
    model: DocumentModel, schemaDirective: string, configuration?: CockpitConfig,
): string {
    const config = configuration ?? draftConfig(model)
    return [
        `#:schema ${schemaDirective}\n`,
        configuration || !model.gaps.some(gap => gap.blocking)
            ? '# COCKPIT DOCUMENT: REVIEW DRAFT — confirm the inferred and default values before publication.\n'
            : '# COCKPIT DOCUMENT: INCOMPLETE DRAFT — this file intentionally fails validation.\n',
        renderAttributions(model.attributions),
        renderUnconfirmed(model.unconfirmed),
        emitGaps(model.gaps),
        emitToml(config as CockpitConfig),
        renderDecisionDefaults(),
    ].join('')
}

/** Decisions are comments: the schema has no field for them, and the reader of the file needs them. */
export function renderCompleteDocument(
    config: CockpitConfig, schemaDirective: string, decisions: readonly string[] = [], unconfirmed: readonly UnconfirmedAnswer[] = [],
    derived: readonly DerivedAnswer[] = [],
): string {
    return `#:schema ${schemaDirective}\n${decisions.map(decision => `# Decision: ${decision}\n`).join('')}${renderDerived(derived)}${renderUnconfirmed(unconfirmed)}${emitToml(config)}${renderDecisionDefaults()}`
}
