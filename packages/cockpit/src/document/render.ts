import type { CockpitConfig, configurationDefaults } from '../schema.js'
import { emitGaps, emitToml, toSiblingRows } from '../emit.js'
import type { DocumentedSibling, Gap } from './registry.js'

export const mechanism = {
    id: 'document-rendering',
    module: 'packages/cockpit/src/document/render.ts',
    exports: ['renderIncompleteDocument', 'renderCompleteDocument'],
} as const

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
    return {
        ...model.defaults,
        cockpit: {
            ...model.defaults.cockpit,
            ...(model.name ? { name: model.name } : {}),
        },
        sibling: toSiblingRows(model.siblings).map((sibling) => ({
            ...sibling,
            ...model.defaults.sibling,
        })),
    }
}

export function renderIncompleteDocument(
    model: DocumentModel, schemaDirective: string, configuration?: CockpitConfig,
): string {
    const config = configuration ?? draftConfig(model)
    return [
        `#:schema ${schemaDirective}\n`,
        configuration
            ? '# COCKPIT DOCUMENT: REVIEW DRAFT — confirm the inferred and default values before publication.\n'
            : '# COCKPIT DOCUMENT: INCOMPLETE DRAFT — this file intentionally fails validation.\n',
        renderAttributions(model.attributions),
        emitGaps(model.gaps),
        emitToml(config as CockpitConfig),
    ].join('')
}

/** Decisions are comments: the schema has no field for them, and the reader of the file needs them. */
export function renderCompleteDocument(config: CockpitConfig, schemaDirective: string, decisions: readonly string[] = []): string {
    return `#:schema ${schemaDirective}\n${decisions.map(decision => `# Decision: ${decision}\n`).join('')}${emitToml(config)}`
}
