import type { CockpitConfig, configurationDefaults, UNCONFIRMABLE_ANSWERS } from '../schema.js'
import { emitGaps, emitToml, toSiblingRows } from '../emit.js'
import type { DocumentedSibling, Gap } from '../registry-resolve/registry.js'

/**
 * Who gave an interview answer: a person, the setup agent choosing a default it was allowed to
 * choose, or no one said (an answers file that does not attribute a value cockpit never proposes).
 * Only a person's answer is written as stated; the others are listed under `unconfirmed`.
 */
export const ANSWER_PROVENANCES = ['operator-confirmed', 'agent-default', 'unattributed'] as const
export type AnswerProvenance = typeof ANSWER_PROVENANCES[number]
export type UnconfirmableAnswer = typeof UNCONFIRMABLE_ANSWERS[number]
export type UnconfirmedAnswer = Readonly<{ field: UnconfirmableAnswer; provenance: Exclude<AnswerProvenance, 'operator-confirmed'> }>

export function unconfirmedReason(row: UnconfirmedAnswer): string {
    return row.provenance === 'agent-default'
        ? `${row.field} was chosen by the setup agent as a default; no person stated it`
        : `${row.field} came from an answers file that did not say who chose it; no person is known to have stated it`
}

export const UNCONFIRMED_FIX = 'confirm the value with whoever owns the product and correct it in cockpit.toml if it is wrong, then delete its entry from unconfirmed and run npx --no cockpit sync --config <your cockpit.toml>'

function renderUnconfirmed(rows: readonly UnconfirmedAnswer[] = []): string {
    if (rows.length === 0) return ''
    return `${rows.map(row => `# Unconfirmed: ${unconfirmedReason(row)}.\n`).join('')}# To confirm: ${UNCONFIRMED_FIX}; until then doctor warns.\n`
}

export interface Attribution {
    target: string
    value: unknown
    from: 'inferred' | 'default'
    because: string
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
    for (const attribution of attributions) {
        lines.push(
            `# [${attribution.from}] ${attribution.target} = ${JSON.stringify(attribution.value)}: ${attribution.because}`,
        )
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
    ].join('')
}

/** Decisions are comments: the schema has no field for them, and the reader of the file needs them. */
export function renderCompleteDocument(
    config: CockpitConfig, schemaDirective: string, decisions: readonly string[] = [], unconfirmed: readonly UnconfirmedAnswer[] = [],
): string {
    return `#:schema ${schemaDirective}\n${decisions.map(decision => `# Decision: ${decision}\n`).join('')}${renderUnconfirmed(unconfirmed)}${emitToml(config)}`
}
