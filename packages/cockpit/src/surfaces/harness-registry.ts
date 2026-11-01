export const mechanism = {
    id: 'shipped-harness-registry',
    module: 'packages/cockpit/src/surfaces/harness-registry.ts',
    exports: ['HARNESS_REGISTRY', 'SURFACE_TARGETS', 'GUARD_SURFACE_TARGETS', 'SURFACE_EXECUTION_CONTROL_PATHS', 'SURFACE_PUBLICATION_ANCHORS', 'harnessFact', 'isGuardSurfaceTarget'],
} as const

const pendingNative = (measuredOn: '2026-09-26') => Object.freeze({
    state: 'pending_evidence' as const,
    measuredOn,
    reason: 'native loading and enforcement require a paired candidate and broken-control probe',
})

// Cockpit writes rules, skills, MCP and permission files for these harnesses through the
// generator, so `unavailable` (nothing emitted) would be false; nothing yet shows the tool reads them.
const generatedNative = Object.freeze({
    state: 'generated' as const,
    measuredOn: '2026-10-28' as const,
    reason: 'cockpit generates this file; no paired candidate and broken-control probe has verified that the tool loads it',
})
const noGuardAdapter = Object.freeze({
    capability: 'unavailable' as const,
    measuredOn: '2026-10-28' as const,
    reason: 'no guard adapter is checked in, so cockpit generates no guard hook',
})
// A dated run of the real tool against the generated guard. It replaces the adapter's own record in
// the capability matrix only while that adapter stays native; the adapter keeps recording the
// transport shape it was written against.
const codexFiring = Object.freeze({
    state: 'enforced' as const, evidence: 'human_needed' as const, measuredOn: '2026-11-01' as const, measuredVersion: '0.165.0',
    provenance: 'only after a person trusts the hook: untrusted, Codex skipped it and git push ran; trusted (forced with --dangerously-bypass-hook-trust), it refused the push. Trust is per machine and cockpit doctor warns until it is given',
})
const openCodeFiring = Object.freeze({
    state: 'enforced' as const, evidence: 'not_applicable' as const, measuredOn: '2026-11-01' as const, measuredVersion: '1.19.4',
    provenance: 'the plugin refused git push and a native read of a secrets file while an unprotected read stayed allowed; before read was routed through the guard, the same read returned the file',
})
const completeRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const)
const nonPermissionRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks'] as const)

export const HARNESS_REGISTRY = Object.freeze([
    Object.freeze({
        target: 'claudecode', type: 'agent' as const, displayName: 'Claude Code', rulesyncTarget: 'claudecode',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'CLAUDE.md', skills: '.claude/skills', mcp: '.mcp.json', permissions: Object.freeze(['.claude/settings.json']) }),
        guard: Object.freeze({ capability: 'instructed' as const }), native: pendingNative('2026-09-26'),
    }),
    Object.freeze({
        target: 'codexcli', type: 'agent' as const, displayName: 'Codex', rulesyncTarget: 'codexcli',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.agents/skills', mcp: '.codex/config.toml', permissions: Object.freeze(['.codex/config.toml']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: codexFiring }), native: pendingNative('2026-09-26'),
    }),
    Object.freeze({
        target: 'opencode', type: 'agent' as const, displayName: 'OpenCode', rulesyncTarget: 'opencodev1',
        rulesyncFeatures: nonPermissionRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.opencode/skills', mcp: 'opencode.jsonc', permissions: Object.freeze(['opencode.jsonc']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: openCodeFiring }), native: pendingNative('2026-09-26'),
    }),
    Object.freeze({
        target: 'cursor', type: 'agent' as const, displayName: 'Cursor', rulesyncTarget: 'cursor',
        rulesyncFeatures: completeRulesyncFeatures,
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

export function harnessFact(target: SurfaceTarget): HarnessRegistryRow {
    return HARNESS_REGISTRY.find(row => row.target === target)!
}
