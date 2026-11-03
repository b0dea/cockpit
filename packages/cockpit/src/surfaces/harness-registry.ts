export const mechanism = {
    id: 'shipped-harness-registry',
    module: 'packages/cockpit/src/surfaces/harness-registry.ts',
    exports: ['HARNESS_REGISTRY', 'SURFACE_TARGETS', 'GUARD_SURFACE_TARGETS', 'SURFACE_EXECUTION_CONTROL_PATHS', 'SURFACE_PUBLICATION_ANCHORS', 'harnessFact', 'isGuardSurfaceTarget', 'isMeasurementDate'],
} as const

// Guard firing and instruction loading for these harnesses are dated runs (the firing records below
// and the projection's instruction capabilities), so this record claims no pending measurement for
// them; what stays open is a person's review of the rendered skills.
const reviewedNative = Object.freeze({
    state: 'instructed' as const,
    reason: 'a person has not yet reviewed whether the tool loads and triggers them as written',
})

// Cockpit writes rules, skills, MCP and permission files for these harnesses through the
// generator, so `unavailable` (nothing emitted) would be false; nothing yet shows the tool reads them.
const generatedNative = Object.freeze({
    state: 'generated' as const,
    measuredOn: '2026-10-28',
    reason: 'cockpit writes the files, but no run of the tool beside a broken control has shown that it loads them',
})
const noGuardAdapter = Object.freeze({
    capability: 'unavailable' as const,
    measuredOn: '2026-10-28',
    reason: 'no guard adapter is checked in, so cockpit generates no guard hook',
})
// A dated run of the real tool against the generated guard. It replaces the adapter's own record in
// the capability matrix only while that adapter stays native; the adapter keeps recording the
// transport shape it was written against.
const claudeFiring = Object.freeze({
    state: 'enforced' as const, evidence: 'not_applicable' as const, measuredOn: '2026-11-01', measuredVersion: '2.1.316',
    provenance: 'with the exact push pre-allowed by permissions, the hook refused git push to a protected branch and the remote stayed empty while git status ran; the same checkout without the hook pushed',
})
const codexFiring = Object.freeze({
    state: 'enforced' as const, evidence: 'human_needed' as const, measuredOn: '2026-11-01', measuredVersion: '0.165.0',
    provenance: 'only after a person trusts the hook: untrusted, Codex skipped it and git push ran; trusted (forced with --dangerously-bypass-hook-trust), it refused the push. Trust is per machine and cockpit doctor warns until it is given',
})
const openCodeFiring = Object.freeze({
    state: 'enforced' as const, evidence: 'not_applicable' as const, measuredOn: '2026-11-01', measuredVersion: '1.19.4',
    provenance: 'the plugin refused git push and a native read of a secrets file while an unprotected read stayed allowed; before read was routed through the guard, the same read returned the file',
})
const completeRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const)
const nonPermissionRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks'] as const)

export const HARNESS_REGISTRY = Object.freeze([
    Object.freeze({
        target: 'claudecode', type: 'agent' as const, displayName: 'Claude Code', rulesyncTarget: 'claudecode',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'CLAUDE.md', skills: '.claude/skills', mcp: '.mcp.json', permissions: Object.freeze(['.claude/settings.json']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: claudeFiring }), native: reviewedNative,
    }),
    Object.freeze({
        target: 'codexcli', type: 'agent' as const, displayName: 'Codex', rulesyncTarget: 'codexcli',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.agents/skills', mcp: '.codex/config.toml', permissions: Object.freeze(['.codex/config.toml']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: codexFiring }), native: reviewedNative,
    }),
    Object.freeze({
        target: 'opencode', type: 'agent' as const, displayName: 'OpenCode', rulesyncTarget: 'opencodev1',
        rulesyncFeatures: nonPermissionRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.opencode/skills', mcp: 'opencode.jsonc', permissions: Object.freeze(['opencode.jsonc']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: openCodeFiring }), native: reviewedNative,
    }),
    Object.freeze({
        target: 'cursor', type: 'agent' as const, displayName: 'Cursor', rulesyncTarget: 'cursor',
        rulesyncFeatures: completeRulesyncFeatures,
        // Rules overlays only: cockpit's own instructions reach Cursor through the root AGENTS.md.
        outputs: Object.freeze({ instruction: '.cursor/rules', skills: '.cursor/skills', mcp: '.cursor/mcp.json', permissions: Object.freeze(['.cursor/cli.json']) }),
        guard: noGuardAdapter, native: generatedNative,
    }),
    Object.freeze({
        target: 'grokcli', type: 'agent' as const, displayName: 'Grok Build', rulesyncTarget: 'grokcli',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.grok/skills', mcp: '.grok/config.toml', permissions: Object.freeze(['.grok/config.toml']) }),
        guard: noGuardAdapter, native: generatedNative,
    }),
] as const)

export type HarnessRegistryRow = typeof HARNESS_REGISTRY[number]
export type SurfaceTarget = HarnessRegistryRow['target']
export type GuardSurfaceTarget = Extract<HarnessRegistryRow, { readonly guard: { readonly capability: 'instructed' } }>['target']

export const SURFACE_TARGETS = Object.freeze(HARNESS_REGISTRY.map(row => row.target)) as readonly SurfaceTarget[]
export const GUARD_SURFACE_TARGETS = Object.freeze(HARNESS_REGISTRY
    .filter((row): row is Extract<HarnessRegistryRow, { readonly guard: { readonly capability: 'instructed' } }> => row.guard.capability === 'instructed')
    .map(row => row.target)) as readonly GuardSurfaceTarget[]
// Native MCP and permission outputs can select executable programs or relax harness authority.
// The guard derives its protected files from this owner so a new harness cannot omit the boundary.
export const SURFACE_EXECUTION_CONTROL_PATHS = Object.freeze([...new Set(HARNESS_REGISTRY.flatMap(row =>
    [row.outputs.mcp, ...row.outputs.permissions]))].sort())
export const SURFACE_PUBLICATION_ANCHORS = Object.freeze([...new Set(HARNESS_REGISTRY.flatMap(row =>
    [row.outputs.instruction, row.outputs.skills, row.outputs.mcp, ...row.outputs.permissions]
        .filter(path => path.includes('/')).map(path => path.split('/')[0]!).filter(path => path.startsWith('.'))))].sort())

export function isGuardSurfaceTarget(value: unknown): value is GuardSurfaceTarget {
    return typeof value === 'string' && GUARD_SURFACE_TARGETS.some(target => target === value)
}

/**
 * A date a capability was measured on: a real calendar day, written YYYY-MM-DD, that is not still
 * to come. Re-measuring a tool changes its date here and in the rows that quote it; the shape is
 * checked rather than pinned to one literal, so a new run does not mean editing a type and a guard.
 */
export function isMeasurementDate(value: unknown, today: Date = new Date()): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && value <= today.toISOString().slice(0, 10)
}

export function harnessFact(target: SurfaceTarget): HarnessRegistryRow {
    return HARNESS_REGISTRY.find(row => row.target === target)!
}
