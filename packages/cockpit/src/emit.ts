import { stringify } from 'smol-toml'
import type { CockpitConfig } from './schema.js'
import type { DocumentedSibling, Gap } from './document/registry.js'

export const mechanism = {
    id: 'toml-emission',
    module: 'packages/cockpit/src/emit.ts',
    exports: ['emitToml', 'emitGaps', 'toSiblingRows'],
} as const

/**
 * Render a config as `cockpit.toml`.
 *
 * The round trip this closes is the acceptance test for the whole schema: a registry read
 * out of an existing harness, emitted here, and parsed back must mean the same thing. Until
 * this existed the "round trip" stopped at an in-memory object, which proves the parser
 * agrees with itself and nothing else.
 */
export function emitToml(config: CockpitConfig): string {
    return stringify(config as unknown as Record<string, unknown>)
}

/**
 * Render the gaps `document` could not answer, as commented TOML.
 *
 * Deliberately emitted as comments rather than placeholder values: a placeholder is a value,
 * and a value is indistinguishable from an answer the moment the file is read by anything
 * other than the person who generated it. A blocking gap keeps the config invalid on
 * purpose, so the schema refuses it until a human writes the real answer.
 */
export function emitGaps(gaps: readonly Gap[]): string {
    if (gaps.length === 0) return ''
    const lines = ['# Gaps — cockpit could not read these from its sources.', '#']
    for (const g of gaps) {
        const mark = g.blocking ? 'REQUIRED' : 'optional'
        lines.push(`# [${mark}] ${g.slug}.${g.field}: ${g.why}`)
    }
    return lines.join('\n') + '\n'
}

/** The sibling rows as the schema wants them, dropping fields the source did not carry. */
export function toSiblingRows(siblings: readonly DocumentedSibling[]): Record<string, unknown>[] {
    return siblings.map((s) => ({
        slug: s.slug,
        dir: s.dir,
        ...(s.remote ? { remote: s.remote } : {}),
        ...(s.branch ? { branch: s.branch } : {}),
        mount: s.mount.value,
        acquire: s.acquire.value,
        var: s.var,
        purpose: s.purpose,
    }))
}
