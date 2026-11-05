// Owns whether an edit of cockpit.toml widens what agents may do. The guard holds every agent call
// once the configuration differs from the one it was generated from; this classification decides
// whether that hold needs a person (the edit widens) or only a sync an agent may run (it does not).
// It fails closed: a field with no rule here widens whenever it changes, so a field added to the
// schema later is a person's decision until someone writes down why it is not. A rule exists only
// for a field that cannot widen the guard's trust inputs (the commands agents run unprompted, the
// roots they write, the secrets they are kept from, who passes a gate) in the direction it admits.
// Work gates, autonomy, testing, browser and command fields remain person-held. Guard and MCP
// changes are admitted only in the restrictive directions named below, and MCP approvals in any
// direction while both configurations delegate them to the agent.
// The rules read the configuration rather than compare the guard policy each side would build: most
// of what they judge (Compose files and profiles, resettable volumes, the tools guarded, a sibling's
// operator gate) never reaches that policy, and building it observes the checkouts on disk.
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { effectivePolicy } from '../autonomy.js'
import { UNSYNCED_ADMITTED_PROSE } from '../command-table.js'
import { parseCockpitConfigBytes, readBoundedInput } from '../config/load.js'
import type { ENVIRONMENT_CODES, EnvironmentDiagnostic } from '../environment/contract.js'
import { hasErrorCode } from '../environment/contract.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { McpAllowedTools, type CockpitConfig } from '../schema.js'
import { sha256Hex } from '../sha256.js'
import { ANSWER_CONFIRMATION_PATH, confirmedAnswers } from './answer-confirmation.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity } from './local-identity.js'

type PolicyChange = Readonly<{ kind: 'non-widening' }> | Readonly<{ kind: 'widening'; fields: readonly string[] }>

// Each rule returns the field paths that widen; `at` is the path as cockpit.toml spells it. A rule
// declares the shape it reads, and the walk hands it the values found at its path.
type Rule = (before: never, after: never, at: string) => readonly string[]
type Rules = Readonly<Record<string, Rule>>

const safe: Rule = () => []
const gains = (from: readonly unknown[], to: readonly unknown[]) => to.some(row => !from.some(was => isDeepStrictEqual(was, row)))
/** A list that may lose rows but not gain one. */
const onlyRemoves: Rule = (before: readonly unknown[] = [], after: readonly unknown[] = [], at: string) => gains(before, after) ? [at] : []
/** A list that may gain rows but not lose one. */
const onlyAdds: Rule = (before: readonly unknown[] = [], after: readonly unknown[] = [], at: string) => gains(after, before) ? [at] : []

function plainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The paths under `at` that differ in a way no rule admits; a rule is looked up by its path from the walk's root. */
function walk(before: unknown, after: unknown, rules: Rules, at: string, key = ''): string[] {
    const rule = rules[key]
    if (rule) return [...rule(before as never, after as never, at)]
    if (plainObject(before) && plainObject(after)) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(name =>
            walk(before[name], after[name], rules, at ? `${at}.${name}` : name, key ? `${key}.${name}` : name))
    }
    return isDeepStrictEqual(before, after) ? [] : [at]
}

// Removing an unchanged approval disables a server; a changed digest or new name admits a new process.
const approvalRemovals: Rule = (before: unknown, after: unknown, at: string) => {
    const from = before ?? {}
    const to = after ?? {}
    if (!plainObject(from) || !plainObject(to)) return [at]
    return Object.keys(to).filter(name => !Object.hasOwn(from, name) || !isDeepStrictEqual(from[name], to[name]))
        .map(name => `${at}.${name}`)
}

// Absence permits every tool; an explicit list may only retain or lose names.
const toolRestrictionNarrowing: Rule = (before: unknown, after: unknown, at: string) => {
    const from = McpAllowedTools.safeParse(before === undefined ? {} : before)
    const to = McpAllowedTools.safeParse(after === undefined ? {} : after)
    if (!from.success || !to.success) return [at]
    return Object.keys(from.data).filter(name => !Object.hasOwn(to.data, name)
        || gains(from.data[name]!, to.data[name]!)).map(name => `${at}.${name}`)
}

/** Shared by the edit pin and the unsynced-policy hold so revocation never needs a second approval. */
export function mcpPolicyWideningFields(before: unknown, after: unknown, at = 'mcp'): readonly string[] {
    return walk(before ?? {}, after ?? {}, { approved: approvalRemovals, allowed_tools: toolRestrictionNarrowing }, at)
}

// The edit pin strips mcp.approved from both sides under the same condition, so an approval it lets
// through is not then held for a person. Tool restrictions stay compared: delegating which servers run
// does not delegate what their tools may do.
const delegatedMcpPolicyWideningFields: Rule = (before: unknown, after: unknown, at: string) =>
    walk(before ?? {}, after ?? {}, { approved: safe, allowed_tools: toolRestrictionNarrowing }, at)

// The fields of an existing sibling that say what it is for. Everything else about a sibling decides
// what the agent may write or read: its directory is a writable root, its environment files are the
// instances the guard protects, its guides are copied into every agent's instructions, and its derived
// MCP sources start processes outside the guard.
const SIBLING_RULES: Rules = {
    purpose: safe,
    host_reason: safe,
    // Only the stale-stack warning reads these.
    rebuild_inputs: safe,
    // An operator gate keeps a sibling out of default runs; adding one narrows, removing one widens.
    gate: (before, after, at) => before !== undefined && after === undefined ? [at] : [],
}

// A new sibling is a new root the agent may write, wherever its directory is, so only a removed or
// described one is compared field by field.
const siblings: Rule = (before: CockpitConfig['sibling'], after: CockpitConfig['sibling'], at: string) => [
    ...before.flatMap(row => {
        const now = after.find(candidate => candidate.slug === row.slug)
        // A removed sibling takes its instance protection with it, and its directory leaves the guard's view.
        return now ? walk(row, now, SIBLING_RULES, `${at}.${row.slug}`) : [`${at}.${row.slug}`]
    }),
    ...after.filter(row => !before.some(candidate => candidate.slug === row.slug)).map(row => `${at}.${row.slug}`),
]

// A policy row admits its build and test commands in every sibling of its toolchain.
const installPolicies: Rule = (before: CockpitConfig['environment']['install_policies'],
    after: CockpitConfig['environment']['install_policies'], at: string) => after.flatMap(row => {
    const was = before.find(candidate => candidate.toolchain === row.toolchain && candidate.lockfile === row.lockfile)
    return (['build', 'test'] as const).filter(kind => row[kind] !== undefined && !isDeepStrictEqual(row[kind], was?.[kind]))
        .map(kind => `${at}.${row.toolchain}:${row.lockfile}.${kind}`)
})

// Keyed by schema path from the configuration's root.
const CHANGE_RULES: Rules = {
    // Removing an entry would claim a person stated an answer nobody stated; policyChange admits the
    // removal of one an observation recorded as confirmed for exactly the new configuration.
    unconfirmed: onlyAdds,
    'cockpit.guide_cap': safe,
    'guards.allow': onlyRemoves,
    'guards.deny': onlyAdds,
    'guards.hosted_db_hosts': onlyAdds,
    'guards.vendor_endpoint_hosts': onlyAdds,
    'guards.protected_branches': onlyAdds,
    mcp: mcpPolicyWideningFields,
    sibling: siblings,
    ports: safe,
    'environment.compose_files': onlyRemoves,
    // A profile starts more of the Compose files' services, as a new Compose file does.
    'environment.profiles': onlyRemoves,
    'environment.install_policies': installPolicies,
    // Reset deletes exactly these volumes.
    'environment.resettable_volumes': onlyRemoves,
    // Addresses derived from leased ports, and the floor the host is held to: neither reaches the guard.
    'environment.entrypoint_derivatives': safe,
    'environment.machine': safe,
    // Removing a tool deletes its guard registration.
    'surfaces.tools': onlyAdds,
    // Only docs check reads living documents. The decision paths stay a person's: work orders
    // never count changes under them as out of scope.
    'docs.living': safe,
}

/**
 * Every schema path a rule names, so a test can hold each to a field the schema still has: a rule
 * whose path was renamed away never matches, and its field silently falls back to the default.
 * Paths under `sibling[].` name a field of a sibling row.
 */
export const POLICY_CHANGE_RULE_PATHS: readonly string[] = Object.freeze([...Object.keys(CHANGE_RULES),
    ...Object.keys(SIBLING_RULES).map(field => `sibling[].${field}`)])

/**
 * Whether `after` lets agents do anything `before` did not, over the loaded configurations. Only a
 * difference a rule above proves safe is non-widening; every other difference widens. `confirmed`
 * names the answers whose recorded observation matches `after`; only those may leave `unconfirmed`.
 */
export function policyChange(before: CockpitConfig, after: CockpitConfig, confirmed: ReadonlySet<string> = new Set()): PolicyChange {
    const unconfirmed: Rule = (from: readonly string[] = [], to: readonly string[] = [], at: string) =>
        gains(to, from.filter(answer => !confirmed.has(answer))) ? [at] : []
    // A changed mcp_approve is compared under autonomy like any other decider, so it stays held either way.
    const delegated = [before, after].every(config => effectivePolicy(config).autonomy.mcp_approve === 'agent')
    const fields = walk(before, after, { ...CHANGE_RULES, unconfirmed, ...delegated ? { mcp: delegatedMcpPolicyWideningFields } : {} }, '')
    return fields.length ? { kind: 'widening', fields: [...new Set(fields)] } : { kind: 'non-widening' }
}

type GuardConfigChange = Readonly<{ kind: 'unchanged' | 'unrecorded' }> | PolicyChange

/**
 * How the current configuration differs from the one the guards were generated from. `recorded` is
 * the copy sync kept of that configuration; one missing, or not the configuration `generatedSha256`
 * names, cannot show the edit is safe. `confirmations` is the machine-local record `cockpit confirm`
 * keeps of the observations that confirmed answers.
 */
export function guardConfigChange(generatedSha256: string, recorded: Uint8Array | undefined,
    current: Readonly<{ sha256: string; config: CockpitConfig }>, confirmations?: Uint8Array): GuardConfigChange {
    if (current.sha256 === generatedSha256) return { kind: 'unchanged' }
    const before = recorded && sha256Hex(recorded) === generatedSha256 ? parseCockpitConfigBytes(recorded) : undefined
    return before ? policyChange(before, current.config, confirmedAnswers(confirmations, current.config)) : { kind: 'unrecorded' }
}

/** Why a changed configuration needs a person before the guard applies it, for a hold or a check. */
export function guardConfigHeldReason(change: Exclude<GuardConfigChange, Readonly<{ kind: 'unchanged' | 'non-widening' }>>): string {
    return change.kind === 'widening'
        ? `it widens what agents may do (${change.fields.join(', ')})`
        : `the configuration they were generated from is not recorded in ${GUARD_LOCAL_PATHS.generatedConfig}, so the edit cannot be shown not to widen what agents may do`
}

/** What `check` reports about an edit the guards were not regenerated for, or nothing. */
export async function inspectGuardConfigChange(root: string, configPath: string,
    current: Readonly<{ sha256: string; config: CockpitConfig }>): Promise<readonly EnvironmentDiagnostic[]> {
    const local = async (path: string) => {
        try {
            const read = await readBoundedInput(join(root, path))
            return read.kind === 'complete' ? read.bytes : undefined
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return undefined
            throw error
        }
    }
    const identityBytes = await local(GUARD_LOCAL_PATHS.identity)
    // No guard was generated on this machine, so nothing holds the agent.
    if (!identityBytes) return []
    const identity = parseGuardLocalIdentity(identityBytes.toString('utf8'))
    if (!identity) return []
    const change = guardConfigChange(identity.configSha256, await local(GUARD_LOCAL_PATHS.generatedConfig), current,
        await local(ANSWER_CONFIRMATION_PATH))
    if (change.kind === 'unchanged') return []
    if (change.kind === 'non-widening') return [{ severity: 'warning' as const, target: 'guard',
        code: 'GUARD_CONFIG_UNSYNCED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_UNSYNCED,
        message: `cockpit.toml changed since the guards were generated without widening what agents may do; the guard holds every agent tool call except ${UNSYNCED_ADMITTED_PROSE} until it is synced`,
        fix: `run ${cockpitCommand('sync', { config: configPath })}; an agent may run it where [autonomy] sync = "agent". If sync refuses the edit, undo it: the guard admits one edit of ${configPath} that leaves it byte-identical to ${GUARD_LOCAL_PATHS.generatedConfig}` }]
    return [{ severity: 'error' as const, target: 'guard',
        code: 'GUARD_CONFIG_WIDENED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_WIDENED,
        message: `cockpit.toml changed since the guards were generated and ${guardConfigHeldReason(change)}; the guard holds every agent tool call until a person syncs`,
        fix: `a person reads the change and runs ${cockpitCommand('sync', { config: configPath })} in a terminal outside the agent, or the change is reverted` }]
}
