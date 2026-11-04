// Owns whether an edit of cockpit.toml widens what agents may do. The guard holds every agent call
// once the configuration differs from the one it was generated from; this classification decides
// whether that hold needs a person (the edit widens) or only a sync an agent may run (it does not).
// It fails closed: a field with no rule here widens whenever it changes, so a field added to the
// schema later is a person's decision until someone writes down why it is not.
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { effectivePolicy, policyWeakening } from '../autonomy.js'
import { parseCockpitConfigBytes, readBoundedInput } from '../config/load.js'
import type { ENVIRONMENT_CODES, EnvironmentDiagnostic } from '../environment/contract.js'
import { hasErrorCode } from '../environment/contract.js'
import { cockpitCommand } from '../fix-catalogue.js'
import type { CockpitConfig } from '../schema.js'
import { sha256Hex } from '../sha256.js'
import { normalizeGuardHost } from './host.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity } from './local-identity.js'

export type PolicyChange = Readonly<{ kind: 'non-widening' }> | Readonly<{ kind: 'widening'; fields: readonly string[] }>

// Each rule returns the field paths that widen; `at` is the path as cockpit.toml spells it. A rule
// declares the shape it reads, and the walk hands it the values found at its path.
type Rule = (before: never, after: never, at: string) => readonly string[]
type Rules = Readonly<Record<string, Rule>>

const safe: Rule = () => []
/** A list that may lose rows but not gain one; `key` is what makes two rows the same grant. */
function onlyRemoves<T>(key: (row: T) => unknown = row => row): Rule {
    return (before: readonly T[] = [], after: readonly T[] = [], at: string) =>
        after.some(row => !before.some(was => isDeepStrictEqual(key(was), key(row)))) ? [at] : []
}
/** A list that may gain rows but not lose one. */
function onlyAdds<T>(key?: (row: T) => unknown): Rule {
    const removes = onlyRemoves(key) as (before?: readonly T[], after?: readonly T[], at?: string) => readonly string[]
    return (before: readonly T[] = [], after: readonly T[] = [], at: string) => removes(after, before, at)
}
const notRaised: Rule = (before: number, after: number, at: string) => after > before ? [at] : []

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

// A sibling's root is a directory the agent may write, and its environment files decide which
// instances the guard protects and which templates it lets the agent read; its derived MCP sources
// start processes outside the guard. The descriptive fields below say what the sibling is for.
const SIBLING_RULES: Rules = {
    purpose: safe,
    guides: safe,
    host_reason: safe,
    // Only the stale-stack warning reads these.
    rebuild_inputs: safe,
    // An operator gate keeps a sibling out of default runs; adding one narrows, removing one widens.
    gate: (before, after, at) => before !== undefined && after === undefined ? [at] : [],
}
// A new sibling adds a writable root inside the siblings root, which this classification admits.
// These are the fields such a row may carry; any other field, an environment file or a derived MCP
// source among them, is reviewed by a person.
const NEW_SIBLING_FIELDS: ReadonlySet<string> = new Set(['slug', 'dir', 'remote', 'branch', 'mount', 'acquire', 'var', 'toolchain',
    'gate', 'host_reason', 'guides', 'instruction_pointer', 'purpose', 'rebuild_inputs'])

const siblings: Rule = (before: CockpitConfig['sibling'], after: CockpitConfig['sibling'], at: string) => {
    const fields: string[] = []
    for (const row of before) {
        const now = after.find(candidate => candidate.slug === row.slug)
        // A removed sibling takes its instance protection with it, and its directory leaves the guard's view.
        if (!now) fields.push(`${at}.${row.slug}`)
        else fields.push(...walk(row, now, SIBLING_RULES, `${at}.${row.slug}`))
    }
    for (const row of after) {
        if (before.some(candidate => candidate.slug === row.slug)) continue
        // `.` is the siblings root itself, which would make every directory beside the cockpit writable.
        if (row.dir === '.') fields.push(`${at}.${row.slug}.dir`)
        fields.push(...Object.keys(row).filter(field => !NEW_SIBLING_FIELDS.has(field)).map(field => `${at}.${row.slug}.${field}`))
    }
    return fields
}

// Stages and gates may be added, as the trust test-run gives a declared stage is the trust any test
// the agent writes into an existing stage already has; changing or removing one is a person's.
const testing: Rule = (before: CockpitConfig['testing'], after: CockpitConfig['testing'], at: string) => {
    if (!after) return before ? [at] : []
    const was = before ?? { stages: [], gates: [], native_hooks: { install: 'inspect' as const } }
    const kept = (list: 'stages' | 'gates') => was[list].filter(row => !after[list].some(now => isDeepStrictEqual(now, row)))
        .map(row => `${at}.${list}.${row.id}`)
    return [...kept('stages'), ...kept('gates'), ...walk(was, after, { stages: safe, gates: safe }, at)]
}

// A policy row admits its build and test commands in every sibling of its toolchain.
const installPolicies: Rule = (before: CockpitConfig['environment']['install_policies'],
    after: CockpitConfig['environment']['install_policies'], at: string) => after.flatMap(row => {
    const was = before.find(candidate => candidate.toolchain === row.toolchain && candidate.lockfile === row.lockfile)
    return (['build', 'test'] as const).filter(kind => row[kind] !== undefined && !isDeepStrictEqual(row[kind], was?.[kind]))
        .map(kind => `${at}.${row.toolchain}:${row.lockfile}.${kind}`)
})

const approvals: Rule = (before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>, at: string) =>
    Object.entries(after).filter(([name, digest]) => before[name] !== digest).map(([name]) => `${at}.${name}`)

/**
 * Whether `after` lets agents do anything `before` did not, over the loaded configurations. Only a
 * difference a rule below proves safe is non-widening; every other difference widens.
 */
export function policyChange(before: CockpitConfig, after: CockpitConfig): PolicyChange {
    const weakened = policyWeakening(effectivePolicy(before), effectivePolicy(after)).map(row => row.field)
    const weakenedUnder = (prefix: string): Rule => () => weakened.filter(field => field.startsWith(`${prefix}.`) || field === prefix)
    const rules: Rules = {
        // Removing an entry would claim a person stated an answer nobody stated.
        unconfirmed: onlyAdds(),
        'cockpit.guide_cap': safe,
        sibling: siblings,
        ports: safe,
        'guards.hosted_db_hosts': onlyAdds<string>(normalizeGuardHost),
        'guards.vendor_endpoint_hosts': onlyAdds<string>(normalizeGuardHost),
        'guards.protected_branches': onlyAdds(),
        // The reason is prose; the command prefix and directory are the grant.
        'guards.allow': onlyRemoves<CockpitConfig['guards']['allow'][number]>(row => [row.argv, row.cwd ?? null]),
        'guards.deny': onlyAdds<CockpitConfig['guards']['deny'][number]>(row => 'prefix' in row ? ['prefix', row.prefix] : ['contains', row.contains]),
        'mcp.approved': approvals,
        'work.grading': weakenedUnder('work.grading'),
        'work.gates': weakenedUnder('work.gates'),
        'work.attempt_cap': notRaised,
        'work.wip_cap': notRaised,
        autonomy: weakenedUnder('autonomy'),
        testing,
        'environment.compose_files': onlyRemoves(),
        // A profile starts more of the Compose files' services, as a new Compose file does.
        'environment.profiles': onlyRemoves(),
        'environment.install_policies': installPolicies,
        // Reset deletes exactly these volumes.
        'environment.resettable_volumes': onlyRemoves(),
        // Addresses derived from leased ports, and the floor the host is held to: neither reaches the guard.
        'environment.entrypoint_derivatives': safe,
        'environment.machine': safe,
        // Removing a tool deletes its guard registration.
        'surfaces.tools': onlyAdds(),
        // Only docs check reads living documents. The decision paths stay a person's: work orders
        // never count changes under them as out of scope.
        'docs.living': safe,
    }
    const fields = walk(before, after, rules, '')
    return fields.length ? { kind: 'widening', fields: [...new Set(fields)] } : { kind: 'non-widening' }
}

export type GuardConfigChange = Readonly<{ kind: 'unchanged' | 'unrecorded' }> | PolicyChange

/**
 * How the current configuration differs from the one the guards were generated from. `recorded` is
 * the copy sync kept of that configuration; one missing, or not the configuration `generatedSha256`
 * names, cannot show the edit is safe.
 */
export function guardConfigChange(generatedSha256: string, recorded: Uint8Array | undefined,
    current: Readonly<{ sha256: string; config: CockpitConfig }>): GuardConfigChange {
    if (current.sha256 === generatedSha256) return { kind: 'unchanged' }
    const before = recorded && sha256Hex(recorded) === generatedSha256 ? parseCockpitConfigBytes(recorded) : undefined
    return before ? policyChange(before, current.config) : { kind: 'unrecorded' }
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
    const change = guardConfigChange(identity.configSha256, await local(GUARD_LOCAL_PATHS.generatedConfig), current)
    if (change.kind === 'unchanged') return []
    if (change.kind === 'non-widening') return [{ severity: 'warning' as const, target: 'guard',
        code: 'GUARD_CONFIG_UNSYNCED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_UNSYNCED,
        message: 'cockpit.toml changed since the guards were generated without widening what agents may do; the guard holds every agent tool call except cockpit sync and check until it is synced',
        fix: `run ${cockpitCommand('sync', { config: configPath })}; an agent may run it where [autonomy] sync = "agent"` }]
    return [{ severity: 'error' as const, target: 'guard',
        code: 'GUARD_CONFIG_WIDENED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_WIDENED,
        message: `cockpit.toml changed since the guards were generated and ${guardConfigHeldReason(change)}; the guard holds every agent tool call until a person syncs`,
        fix: `a person reads the change and runs ${cockpitCommand('sync', { config: configPath })} in a terminal outside the agent, or the change is reverted` }]
}
