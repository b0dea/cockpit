export const mechanism = {
    id: 'shipped-harness-registry',
    module: 'packages/cockpit/src/surfaces/harness-registry.ts',
    exports: ['HARNESS_REGISTRY', 'SURFACE_TARGETS', 'GUARD_SURFACE_TARGETS', 'harnessFact', 'isGuardSurfaceTarget'],
} as const

const pendingNative = (measuredOn: '2026-09-26') => Object.freeze({
    state: 'pending_evidence' as const,
    measuredOn,
    reason: 'native loading and enforcement require a paired candidate and broken-control probe',
})

const unavailableNative = Object.freeze({
    state: 'unavailable' as const,
    measuredOn: '2026-10-28' as const,
    reason: 'no authenticated native candidate and broken-control probe is committed',
})
const completeRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const)
const unguardedRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks'] as const)

export const HARNESS_REGISTRY = Object.freeze([
    Object.freeze({
        target: 'claudecode', type: 'agent' as const, displayName: 'Claude Code', rulesyncTarget: 'claudecode',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'CLAUDE.md', skills: '.claude/skills', mcp: '.mcp.json' }),
        guard: Object.freeze({ capability: 'instructed' as const }), native: pendingNative('2026-09-26'),
    }),
    Object.freeze({
        target: 'codexcli', type: 'agent' as const, displayName: 'Codex', rulesyncTarget: 'codexcli',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.agents/skills', mcp: '.codex/config.toml' }),
        guard: Object.freeze({ capability: 'instructed' as const }), native: pendingNative('2026-09-26'),
    }),
    Object.freeze({
        target: 'opencode', type: 'agent' as const, displayName: 'OpenCode', rulesyncTarget: 'opencode',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.opencode/skills', mcp: 'opencode.jsonc' }),
        guard: Object.freeze({ capability: 'instructed' as const }), native: pendingNative('2026-09-26'),
    }),
    Object.freeze({
        target: 'cursor', type: 'agent' as const, displayName: 'Cursor', rulesyncTarget: 'cursor',
        rulesyncFeatures: unguardedRulesyncFeatures,
        outputs: Object.freeze({ instruction: '.cursor/rules', skills: '.cursor/skills', mcp: '.cursor/mcp.json' }),
        guard: Object.freeze({ capability: 'unavailable' as const }), native: unavailableNative,
    }),
    Object.freeze({
        target: 'grokcli', type: 'agent' as const, displayName: 'Grok Build', rulesyncTarget: 'grokcli',
        rulesyncFeatures: unguardedRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.grok/skills', mcp: '.grok/config.toml' }),
        guard: Object.freeze({ capability: 'unavailable' as const }), native: unavailableNative,
    }),
] as const)

export type HarnessRegistryRow = typeof HARNESS_REGISTRY[number]
export type SurfaceTarget = HarnessRegistryRow['target']
export type GuardSurfaceTarget = Extract<HarnessRegistryRow, { readonly guard: { readonly capability: 'instructed' } }>['target']

export const SURFACE_TARGETS = Object.freeze(HARNESS_REGISTRY.map(row => row.target)) as readonly SurfaceTarget[]
export const GUARD_SURFACE_TARGETS = Object.freeze(HARNESS_REGISTRY
    .filter((row): row is Extract<HarnessRegistryRow, { readonly guard: { readonly capability: 'instructed' } }> => row.guard.capability === 'instructed')
    .map(row => row.target)) as readonly GuardSurfaceTarget[]

export function isGuardSurfaceTarget(value: unknown): value is GuardSurfaceTarget {
    return typeof value === 'string' && GUARD_SURFACE_TARGETS.some(target => target === value)
}

export function harnessFact(target: SurfaceTarget): HarnessRegistryRow {
    return HARNESS_REGISTRY.find(row => row.target === target)!
}
