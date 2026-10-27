// Owns: removing this repository's own maintenance markers from text that is rendered into a
// consumer's checkout. Must not: touch the shipped source files, because this repository's
// docs lint and tree hygiene read those markers to keep the templates verified and shipped-only.
// Hands off to: render.ts, which applies it to every generated file before ownership is planned.
//
// Why: a consumer's agent loads these files into every session. A `cockpit:verified version=`
// line is a bookkeeping claim about cockpit's own docs, and a "SHIPPED SURFACE" note is a
// message to cockpit maintainers; to the consumer both are noise that costs context and reads
// as an instruction they cannot act on.

export const mechanism = {
    id: 'development-markers',
    module: 'packages/cockpit/src/surfaces/development-markers.ts',
    exports: ['stripDevelopmentMarkers'],
} as const

// Each pattern also eats the blank line that followed the marker, so removal leaves no gap.
const MARKERS: readonly RegExp[] = [
    /^<!-- cockpit:verified version=\S+ -->\n(?:\n)?/gm,
    /^<!-- SHIPPED SURFACE\b[^\n]*-->\n(?:\n)?/gm,
    /^\{\{! SHIPPED SURFACE\b[\s\S]*?\}\}\n(?:\n)?/gm,
]

export function stripDevelopmentMarkers(text: string): string {
    return MARKERS.reduce((current, marker) => current.replace(marker, ''), text)
}
