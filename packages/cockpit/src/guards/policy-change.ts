// Owns whether an edit of cockpit.toml widens what agents may do. Once the configuration differs from
// the one the guards were generated from, this classification decides whether only a sync an agent may
// run is needed (the edit does not widen, and the guard judges calls under it at once) or a person must
// confirm it at sync (it widens, and the guard keeps judging calls under the configuration last synced).
// It is the one rule for who may change what agents may do: an agent may apply everything else, and
// a widening waits for a person's yes at `cockpit approve`.
// It fails closed: a field with no rule here widens whenever it changes, so a field added to the
// schema later is a person's decision until someone writes down why it is not. A rule exists only
// for a field that cannot widen the guard's trust inputs (the commands agents run unprompted, the
// roots they write, the secrets they are kept from, what grades their work) in the direction it
// admits. Work, testing, browser and command fields remain person-held. Guard and MCP changes are
// admitted only in the restrictive directions named below.
// The rules read the configuration rather than compare the guard policy each side would build: most
// of what they judge (Compose files and profiles, resettable volumes, the tools guarded, a sibling's
// operator gate) never reaches that policy, and building it observes the checkouts on disk.
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { parseCockpitConfigBytes, readBoundedInput } from '../config/load.js'
import type { ENVIRONMENT_CODES, EnvironmentDiagnostic } from '../environment/contract.js'
import { hasErrorCode } from '../environment/contract.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { McpAllowedTools, type CockpitConfig } from '../schema.js'
import { sha256Hex } from '../sha256.js'
import { GUARD_HELD_CALLS, GUARD_UNHELD_CALLS } from '../surfaces/harness-registry.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity } from './local-identity.js'
import { relatedCheckoutHoldsRoot, relatedCheckoutPath } from './related-checkouts.js'

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

// Revoking an approval or narrowing a tool list never needs a person; starts_stack only sets how long
// Codex waits for a server to answer.
const mcpPolicyWideningFields: Rule = (before: unknown, after: unknown, at: string) =>
    walk(before ?? {}, after ?? {}, { approved: approvalRemovals, allowed_tools: toolRestrictionNarrowing, starts_stack: safe }, at)

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
    'cockpit.guide_cap': safe,
    'guards.allow': onlyRemoves,
    'guards.deny': onlyAdds,
    'guards.read_paths': onlyRemoves,
    // Handing named external reads to the agent tool's own permissions widens; returning to grants narrows.
    'guards.external_reads': (before: string | undefined, after: string | undefined, at: string) => after === 'native' && before !== 'native' ? [at] : [],
    // A secret path keeps agents out of it; removing one hands its contents back to them.
    'guards.secret_paths': onlyAdds,
    // A related checkout is a location agents may read.
    'guards.related_checkouts': onlyRemoves,
    // Refusing what would ask narrows; going back to asking lets a person approve, which widens.
    'guards.unresolved': (before: string | undefined, after: string | undefined, at: string) => before === 'deny' && after !== 'deny' ? [at] : [],
    // A write path is a location outside the roots agents may write.
    'guards.write_paths': onlyRemoves,
    'guards.hosted_db_hosts': onlyAdds,
    'guards.vendor_endpoint_hosts': onlyAdds,
    'guards.protected_branches': onlyAdds,
    // Only guard prove reads it, to check the guard's answers; it changes none of them.
    'guards.cases': safe,
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

/** Where the configuration applies: the cockpit root and the home directory its paths resolve from. */
export type PolicyChangeContext = Readonly<{ root: string; home: string }>

/**
 * The related checkouts as the guard resolves them for `context`, without an entry that is or holds the cockpit root
 * or a declared sibling's, which the guard drops. A sibling a checkout serves from elsewhere is left out of the
 * roots, so an entry naming it still counts.
 */
function relatedCheckouts(config: CockpitConfig, { root, home }: PolicyChangeContext): readonly string[] {
    const siblings = resolve(root, config.cockpit.siblings_root)
    const roots = [root, ...config.sibling.map(sibling => resolve(siblings, sibling.dir))]
    return [...new Set(config.guards.related_checkouts.map(spelled => relatedCheckoutPath(spelled, root, home)))]
        .filter(path => !relatedCheckoutHoldsRoot(path, roots))
}

/**
 * Whether `after` lets agents do anything `before` did not, over the loaded configurations. Only a
 * difference a rule above proves safe is non-widening; every other difference widens. With `context`,
 * related checkouts are compared as the guard resolves them there; without it, as spelled.
 */
export function policyChange(before: CockpitConfig, after: CockpitConfig, context?: PolicyChangeContext): PolicyChange {
    const resolved = (config: CockpitConfig) => context
        ? { ...config, guards: { ...config.guards, related_checkouts: relatedCheckouts(config, context) } } : config
    const fields = walk(resolved(before), resolved(after), CHANGE_RULES, '')
    return fields.length ? { kind: 'widening', fields: [...new Set(fields)] } : { kind: 'non-widening' }
}

type GuardConfigChange = Readonly<{ kind: 'unchanged' | 'unrecorded' }> | PolicyChange

/**
 * How the current configuration differs from the one the guards were generated from. `recorded` is
 * the copy sync kept of that configuration; one missing, or not the configuration `generatedSha256`
 * names, cannot show the edit is safe.
 */
export function guardConfigChange(generatedSha256: string, recorded: Uint8Array | undefined,
    current: Readonly<{ sha256: string; config: CockpitConfig }>, context?: PolicyChangeContext): GuardConfigChange {
    if (current.sha256 === generatedSha256) return { kind: 'unchanged' }
    const before = recorded && sha256Hex(recorded) === generatedSha256 ? parseCockpitConfigBytes(recorded) : undefined
    return before ? policyChange(before, current.config, context) : { kind: 'unrecorded' }
}

/** Why a changed configuration needs a person before the guard applies it, for a hold or a check. */
export function guardConfigHeldReason(change: Exclude<GuardConfigChange, Readonly<{ kind: 'unchanged' | 'non-widening' }>>): string {
    return change.kind === 'widening'
        ? `it widens what agents may do (${change.fields.join(', ')})`
        : `the configuration they were generated from is missing from ${GUARD_LOCAL_PATHS.generatedConfig} or no longer loads there, so the edit cannot be shown not to widen what agents may do`
}


/**
 * How the configuration on disk differs from the one the guards on this machine were generated from,
 * or undefined where no guard was generated here: nothing holds an agent there, as on a first sync.
 */
export async function observeGuardConfigChange(root: string,
    current: Readonly<{ sha256: string; config: CockpitConfig }>): Promise<GuardConfigChange | undefined> {
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
    const identity = identityBytes && parseGuardLocalIdentity(identityBytes.toString('utf8'))
    if (!identity) return undefined
    // The guard resolves related checkouts from the real cockpit root and the home directory.
    const context = { root: await realpath(root), home: homedir() }
    return guardConfigChange(identity.configSha256, await local(GUARD_LOCAL_PATHS.generatedConfig), current, context)
}

/**
 * Sync's refusal of an edit that widens the guard, or of one it cannot compare because the record of the
 * configuration last synced is missing or no longer loads, until a person confirms it.
 */
export function guardWideningUnconfirmedDiagnostic(fields: readonly string[] | 'unrecorded', configPath: string): EnvironmentDiagnostic {
    const reason = fields === 'unrecorded' ? guardConfigHeldReason({ kind: 'unrecorded' }) : `widens what agents may do (${fields.join(', ')})`
    return { severity: 'error' as const, target: 'guard',
        code: 'GUARD_CONFIG_WIDENED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_WIDENED,
        message: `cockpit.toml changed since the guards were generated and ${reason}; nothing was written, as sync applies it only once a person confirms it`,
        fix: 'this needs a person: they run npx --no cockpit approve in <the cockpit root>, from a terminal outside the agent, or the change is reverted' }
}

/** What `check` reports about an edit the guards were not regenerated for, or nothing. */
export async function inspectGuardConfigChange(root: string, configPath: string,
    current: Readonly<{ sha256: string; config: CockpitConfig }>): Promise<readonly EnvironmentDiagnostic[]> {
    const change = await observeGuardConfigChange(root, current)
    if (!change || change.kind === 'unchanged') return []
    if (change.kind === 'non-widening') return [{ severity: 'warning' as const, target: 'guard',
        code: 'GUARD_CONFIG_UNSYNCED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_UNSYNCED,
        message: 'cockpit.toml changed since the guards were generated without widening what agents may do; the guard judges agent calls under it, while the generated files still follow the configuration last synced until it is synced',
        fix: `run ${cockpitCommand('sync', { config: configPath })}; an agent may run it while the guard can build its policy from the edit. Where it cannot, calls are judged under the configuration last synced and an agent's sync is refused: correct or revert the edit, or a person runs npx --no cockpit approve in <the cockpit root>, from a terminal outside the agent` }]
    return [{ severity: 'error' as const, target: 'guard',
        code: 'GUARD_CONFIG_WIDENED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_WIDENED,
        message: `cockpit.toml changed since the guards were generated and ${guardConfigHeldReason(change)}; ${change.kind === 'widening'
            ? 'the guard judges agent calls under the configuration last synced, and refuses an agent\'s sync or upgrade, until a person syncs'
            : `the guard holds ${GUARD_HELD_CALLS} until a person syncs, while ${GUARD_UNHELD_CALLS} continue`}`,
        fix: change.kind === 'widening'
            ? 'this needs a person: they run npx --no cockpit approve in <the cockpit root>, from a terminal outside the agent, or the change is reverted'
            : `a person reads the change and runs ${cockpitCommand('sync', { config: configPath })} in a terminal outside the agent, or the change is reverted` }]
}
