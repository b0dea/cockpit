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
// The session-start drift check is guidance: the tool runs `cockpit check` as a session starts and
// shows its report to the agent, which nothing makes act on it. Each run below put a marker line from
// the hook into the agent's context, beside a misspelled event that never ran.
const claudeSessionStart = Object.freeze({
    state: 'instructed' as const, evidence: 'not_applicable' as const, measuredOn: '2026-11-03', measuredVersion: '2.1.317',
    provenance: 'a SessionStart hook in .claude/settings.json ran under claude -p and the agent quoted its stdout back, while a hook under a misspelled event name never ran and Claude Code named it as ignored',
})
const codexSessionStart = Object.freeze({
    state: 'instructed' as const, evidence: 'human_needed' as const, measuredOn: '2026-11-03', measuredVersion: '0.166.0',
    provenance: 'only after a person trusts the hook, as for the guard: a trusted SessionStart hook in .codex/hooks.json ran under codex exec and the agent quoted its stdout back, while a hook under a misspelled event name never ran',
})
const noSessionStart = (reason: string) => ({ state: 'unavailable' as const, evidence: 'not_applicable' as const, measuredOn: '2026-11-03', measuredVersion: null, provenance: reason })
// What each tool's native MCP file can say for a remote (streamable HTTP) server. A header must come
// from an environment reference or a headers helper, never a literal; a tool that cannot express a
// server's credential gets nothing for that server, because a server written without it would start,
// fail to authenticate and read as configured. Each run connected the tool to a loopback server that
// recorded the request headers, beside a control spelled the way the tool does not read.
const remoteMcpMeasured = (fact: { evidence: 'not_applicable' | 'human_needed'; measuredVersion: string; helper: boolean; provenance: string }) =>
    Object.freeze({ state: 'instructed' as const, headers: true, measuredOn: '2026-11-04', ...fact })
const noRemoteMcp = Object.freeze({ state: 'unavailable' as const, evidence: 'not_applicable' as const, headers: false, helper: false,
    measuredOn: '2026-11-04', measuredVersion: null,
    provenance: 'cockpit writes no remote MCP server for this tool: its remote transport and header spelling have not been checked' })
// Whether `cockpit use` can grant a checkout served from outside the declared one through a
// machine-local file the tool reads. Each run wrote into the granted directory and into an
// ungranted control beside it.
const servedGrant = (fact: { state: 'enforced' | 'unavailable'; evidence: 'not_applicable' | 'human_needed'; measuredVersion: string | null; provenance: string }) =>
    Object.freeze({ measuredOn: '2026-11-04', ...fact })
const noServedGrant = servedGrant({ state: 'unavailable', evidence: 'not_applicable', measuredVersion: null,
    provenance: 'the tool was not installed where this was measured, so cockpit use writes nothing for it' })
const mcpToolRestriction = (fact: { mechanism: 'hook' | 'enabled-tools' | 'unavailable'; state: 'enforced' | 'unavailable';
    evidence: 'not_applicable' | 'human_needed'; measuredVersion: string | null; provenance: string }) => Object.freeze({
    measuredOn: '2026-11-05', ...fact,
})
const noMcpToolRestriction = mcpToolRestriction({ mechanism: 'unavailable', state: 'unavailable', evidence: 'not_applicable', measuredVersion: null,
    provenance: 'no MCP tool restriction transport is implemented; restricted servers are omitted' })
const completeRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const)
const nonPermissionRulesyncFeatures = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks'] as const)

export const HARNESS_REGISTRY = Object.freeze([
    Object.freeze({
        target: 'claudecode', type: 'agent' as const, displayName: 'Claude Code', rulesyncTarget: 'claudecode',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'CLAUDE.md', skills: '.claude/skills', mcp: '.mcp.json', permissions: Object.freeze(['.claude/settings.json']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: claudeFiring }), native: reviewedNative, sessionStart: claudeSessionStart,
        mcpToolRestriction: mcpToolRestriction({ mechanism: 'hook', state: 'enforced', evidence: 'human_needed', measuredVersion: '2.1.318',
            provenance: 'claude -p with generated settings and a loopback synthetic model left the listed read tool denied by native permissions without a grant; with a grant it called only that tool, including with large arguments, and denied write, dispatcher and new tools despite readOnlyHint annotations. Unrestricted server tools ran even with a missing guard; restricted calls were held, an oversized envelope was refused, and a broken hook file was named. Project hooks still require workspace trust. Claude Code rewrites a dot in a tool name to an underscore before the hook sees it and keeps only the first of two tools that collide, so read.record and read_record are one name here' }),
        remoteMcp: remoteMcpMeasured({ evidence: 'human_needed', measuredVersion: '2.1.318', helper: true,
            provenance: 'from a project .mcp.json, Claude Code sent the Authorization header a ${NAME} reference named while a $NAME control went out literally; it ran a headersHelper given with --mcp-config, but refused to run one from the project file until a person trusts the workspace, and a misspelled headerHelper sent nothing' }),
        servedCheckoutGrant: servedGrant({ state: 'enforced', evidence: 'human_needed', measuredVersion: '2.1.318',
            provenance: 'a directory in .claude/settings.local.json permissions.additionalDirectories was written and the control refused, and a malformed twin granted nothing; measured in an untrusted workspace, so whether it combines with the committed list once a person trusts the workspace is unmeasured' }),
    }),
    Object.freeze({
        target: 'codexcli', type: 'agent' as const, displayName: 'Codex', rulesyncTarget: 'codexcli',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.agents/skills', mcp: '.codex/config.toml', permissions: Object.freeze(['.codex/config.toml']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: codexFiring }), native: reviewedNative, sessionStart: codexSessionStart,
        mcpToolRestriction: mcpToolRestriction({ mechanism: 'enabled-tools', state: 'enforced', evidence: 'not_applicable', measuredVersion: '0.166.0',
            provenance: 'codex exec with generated project enabled_tools and a loopback synthetic model called the listed read tool and rejected forced write, dispatcher and new tool calls as unsupported. The unrestricted control called all four; a string-valued enabled_tools twin was named and rejected before startup. enabled_tools matches the server\'s raw tool name, so read.record and read_record stay distinct. No hook trust was granted' }),
        remoteMcp: remoteMcpMeasured({ evidence: 'not_applicable', measuredVersion: '0.166.0', helper: true,
            provenance: 'from a project .codex/config.toml in a directory Codex had not been told to trust, codex exec sent the bearer_token_env_var and env_http_headers values and the http_headers_helper output, named a misspelled http_header_helper as ignored, and sent a ${NAME} written in http_headers literally' }),
        servedCheckoutGrant: servedGrant({ state: 'unavailable', evidence: 'not_applicable', measuredVersion: '0.166.0',
            provenance: 'Codex reads no machine-local project file; --add-dir at start made the worktree writable and without it the write was refused, so cockpit use prints that flag and writes nothing' }),
    }),
    Object.freeze({
        target: 'opencode', type: 'agent' as const, displayName: 'OpenCode', rulesyncTarget: 'opencodev1',
        rulesyncFeatures: nonPermissionRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.opencode/skills', mcp: 'opencode.jsonc', permissions: Object.freeze(['opencode.jsonc']) }),
        guard: Object.freeze({ capability: 'instructed' as const, firing: openCodeFiring }), native: reviewedNative,
        mcpToolRestriction: noMcpToolRestriction,
        // OpenCode 1.19.5 delivered session.created to a project plugin beside a misspelled hook that
        // never ran, but its model call failed, so no plugin hook was shown to put text in the agent's context.
        sessionStart: noSessionStart('OpenCode 1.19.5 delivers session.created to a plugin, but no run has shown a plugin putting text in the agent\'s context, so cockpit generates no session-start check'),
        remoteMcp: remoteMcpMeasured({ evidence: 'not_applicable', measuredVersion: '1.19.5', helper: false,
            provenance: 'opencode mcp list sent headers expanded from {env:NAME} in a project opencode.jsonc while a ${NAME} control went out literally; its remote server schema has no headers helper, so a server that declares one is not written for it' }),
        servedCheckoutGrant: servedGrant({ state: 'enforced', evidence: 'not_applicable', measuredVersion: '1.19.5',
            provenance: 'the machine-local grant file holding the worktree path allowed the write and the control was denied, and a pattern naming a missing grant file stopped OpenCode at start, naming the file' }),
    }),
    Object.freeze({
        target: 'cursor', type: 'agent' as const, displayName: 'Cursor', rulesyncTarget: 'cursor',
        rulesyncFeatures: completeRulesyncFeatures,
        // Rules overlays only: cockpit's own instructions reach Cursor through the root AGENTS.md.
        outputs: Object.freeze({ instruction: '.cursor/rules', skills: '.cursor/skills', mcp: '.cursor/mcp.json', permissions: Object.freeze(['.cursor/cli.json']) }),
        guard: noGuardAdapter, native: generatedNative, sessionStart: noSessionStart('cockpit generates no hook for this tool'),
        mcpToolRestriction: noMcpToolRestriction,
        remoteMcp: noRemoteMcp, servedCheckoutGrant: noServedGrant,
    }),
    Object.freeze({
        target: 'grokcli', type: 'agent' as const, displayName: 'Grok Build', rulesyncTarget: 'grokcli',
        rulesyncFeatures: completeRulesyncFeatures,
        outputs: Object.freeze({ instruction: 'AGENTS.md', skills: '.grok/skills', mcp: '.grok/config.toml', permissions: Object.freeze(['.grok/config.toml']) }),
        guard: noGuardAdapter, native: generatedNative, sessionStart: noSessionStart('cockpit generates no hook for this tool'),
        mcpToolRestriction: noMcpToolRestriction,
        remoteMcp: noRemoteMcp, servedCheckoutGrant: noServedGrant,
    }),
] as const)

// What a hold stops and what it does not, as every hold message says it. A generated hook fires only on
// the tools its matcher names, so a hold cannot stop a file read or an unrestricted MCP tool. The first
// phrase is printed from a single-quoted shell string, so it stays free of quotes and percent signs.
export const GUARD_HELD_CALLS = 'shell commands, file edits and writes, and restricted MCP tools under Claude Code'
export const GUARD_UNHELD_CALLS = 'file reads and unrestricted MCP tools'

export type HarnessRegistryRow = typeof HARNESS_REGISTRY[number]
export type SurfaceTarget = HarnessRegistryRow['target']
export type GuardSurfaceTarget = Extract<HarnessRegistryRow, { readonly guard: { readonly capability: 'instructed' } }>['target']

export const SURFACE_TARGETS = Object.freeze(HARNESS_REGISTRY.map(row => row.target)) as readonly SurfaceTarget[]
export const GUARD_SURFACE_TARGETS = Object.freeze(HARNESS_REGISTRY
    .filter((row): row is Extract<HarnessRegistryRow, { readonly guard: { readonly capability: 'instructed' } }> => row.guard.capability === 'instructed')
    .map(row => row.target)) as readonly GuardSurfaceTarget[]
// The tools a cockpit renders when cockpit.toml lists none: the ones whose guard firing is a dated run
// of the real tool. A tool the matrix has not measured is rendered only when a team lists it.
export const DEFAULT_SURFACE_TOOLS = GUARD_SURFACE_TARGETS

/** The listed tools in registry order, so rendering and drift do not depend on how the list is spelled. */
export function listedSurfaceTargets(tools: readonly string[]): readonly SurfaceTarget[] {
    return SURFACE_TARGETS.filter(target => tools.includes(target))
}
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
