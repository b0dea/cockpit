// Owns the autonomy policy: who may pass each decision point cockpit gates, as cockpit.toml's [work]
// and [autonomy] tables declare it, what an unset field means, which change weakens it, and the
// record of the policy the last sync accepted. Every command that gates a decision asks `decide`
// here, so a field cannot mean one thing to sync and another to the guard.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml, TomlError } from 'smol-toml'

import { type BoundedRead, readBoundedFile } from './bounded-read.js'
import { type EnvironmentDiagnostic, type ENVIRONMENT_CODES, hasErrorCode, RefusalError } from './environment/contract.js'
import type { CockpitConfig, Decider, WorkGrading } from './schema.js'

export type WorkGate = 'accept' | 'amend' | 'answer' | 'signoff' | 'acknowledge'
export type AutonomyDecision = 'sync' | 'stale_delete' | 'reset' | 'mcp_approve'
export interface EffectivePolicy {
    readonly grading: WorkGrading
    readonly gates: Readonly<Record<WorkGate, Decider>>
    readonly autonomy: Readonly<Record<AutonomyDecision, Decider>>
}

// The owner's defaults: an agent runs cockpit end to end except where stack data is lost or a process
// would start outside the guard, and a team opts into person or CI gates field by field. A sibling's
// MCP source is an ordinary file an agent writes, and a harness starts an enabled server outside every
// guard boundary, so an agent approving MCP servers could run any command it wrote there. Test
// weakening is judged by the grading model where one grades, so acknowledging it is the agent's too.
export const GATE_DEFAULTS: Readonly<Record<WorkGate, Decider>> = Object.freeze({ accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'agent', acknowledge: 'agent' })
export const AUTONOMY_DEFAULTS: Readonly<Record<AutonomyDecision, Decider>> = Object.freeze({ sync: 'agent', stale_delete: 'agent', reset: 'person', mcp_approve: 'person' })

export function effectivePolicy(config: Readonly<{ work: Readonly<Pick<CockpitConfig['work'], 'grading'> & { gates: Readonly<CockpitConfig['work']['gates']> }>
    autonomy: Readonly<CockpitConfig['autonomy']> }>): EffectivePolicy {
    const pick = <K extends string>(declared: Partial<Record<K, Decider>>, defaults: Readonly<Record<K, Decider>>) => Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [key, declared[key as K] ?? value])) as Record<K, Decider>
    return {
        grading: config.work.grading,
        gates: pick<WorkGate>(config.work.gates, GATE_DEFAULTS),
        autonomy: pick<AutonomyDecision>({ sync: config.autonomy.sync, stale_delete: config.autonomy.stale_delete,
            reset: config.autonomy.reset, mcp_approve: config.autonomy.mcp_approve }, AUTONOMY_DEFAULTS),
    }
}

/** cockpit detects CI from the CI variable, as every hosted runner sets it; an agent can set it too. */
export function runningInCi(env: Readonly<Record<string, string | undefined>>): boolean {
    return typeof env.CI === 'string' && env.CI.length > 0 && env.CI !== 'false' && env.CI !== '0'
}

/**
 * Whether this run may pass the decision without a person. A `person` decision is never passed here:
 * its caller asks for the typed digest. A `ci` decision passes only under CI, where a protected
 * environment's reviewers are the human gate; locally that is best-effort, as an agent can set CI too.
 */
export function decide(decider: Decider, env: Readonly<Record<string, string | undefined>>): 'proceed' | 'person' | 'ci-only' {
    if (decider === 'agent') return 'proceed'
    if (decider === 'person') return 'person'
    return runningInCi(env) ? 'proceed' : 'ci-only'
}

// Stronger is later: an agent decision is the weakest, CI behind reviewers the strongest.
const DECIDER_RANK: Readonly<Record<Decider, number>> = Object.freeze({ agent: 0, person: 1, ci: 2 })
const GRADING_RANK: Readonly<Record<WorkGrading, number>> = Object.freeze({ self: 0, checks: 1, independent: 2 })


export interface PolicyWeakening { readonly field: string; readonly from: string; readonly to: string }

/** Every field `current` sets weaker than `recorded`, named as cockpit.toml spells it. */
export function policyWeakening(recorded: EffectivePolicy, current: EffectivePolicy): readonly PolicyWeakening[] {
    const rows: PolicyWeakening[] = []
    if (GRADING_RANK[current.grading] < GRADING_RANK[recorded.grading]) rows.push({ field: 'work.grading', from: recorded.grading, to: current.grading })
    for (const [table, field] of [['gates', 'work.gates'], ['autonomy', 'autonomy']] as const) {
        for (const [key, was] of Object.entries(recorded[table]) as [string, Decider][]) {
            const now = (current[table] as Record<string, Decider>)[key]!
            if (DECIDER_RANK[now] < DECIDER_RANK[was]) rows.push({ field: `${field}.${key}`, from: was, to: now })
        }
    }
    return rows
}

/** The error `check` reports while cockpit.toml sits weaker than the recorded policy; sync would refuse the same change. */
export function policyWeakeningDiagnostic(weakened: readonly PolicyWeakening[]): EnvironmentDiagnostic {
    const shown = weakened.map(row => `${row.field}: ${row.from} -> ${row.to}`).join('; ')
    return { severity: 'error' as const, target: 'autonomy',
        code: 'POLICY_WEAKENING_UNCONFIRMED' as const satisfies typeof ENVIRONMENT_CODES.POLICY_WEAKENING_UNCONFIRMED,
        message: `cockpit.toml weakens the policy the last sync recorded (${shown})`,
        fix: 'a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal outside CI, reads the weakening it shows and types its digest, or the change is reverted' }
}

/** The digest a person types to accept exactly these weakenings of exactly this recorded policy. */
export function weakeningDigest(recorded: EffectivePolicy, current: EffectivePolicy): string {
    return createHash('sha256').update(JSON.stringify({ recorded, current })).digest('hex')
}

// Written only by cockpit: the guard protects `.cockpit/policy.json` as a control, so the policy an
// agent's edit would weaken still stands until a person accepts the weakening at sync.
const POLICY_RECORD_PATH = '.cockpit/policy.json'
const RECORD_FORMAT = 'cockpit-policy/v1'

function validPolicy(value: unknown): value is EffectivePolicy {
    const row = value as EffectivePolicy
    const deciders = (table: unknown, keys: readonly string[]) => typeof table === 'object' && table !== null && !Array.isArray(table)
        && Object.keys(table).sort().join() === [...keys].sort().join()
        && Object.values(table).every(entry => Object.hasOwn(DECIDER_RANK, entry as string))
    return typeof value === 'object' && value !== null && Object.keys(value).sort().join() === 'autonomy,gates,grading'
        && Object.hasOwn(GRADING_RANK, row.grading) && deciders(row.gates, Object.keys(GATE_DEFAULTS)) && deciders(row.autonomy, Object.keys(AUTONOMY_DEFAULTS))
}

/** The policy the last sync recorded, or undefined before the first; an unreadable record refuses. */
export async function readRecordedPolicy(root: string): Promise<EffectivePolicy | undefined> {
    const path = join(root, POLICY_RECORD_PATH)
    const unusable = `${POLICY_RECORD_PATH} is not a regular file of at most 64 KiB; restore it with git restore -- ${POLICY_RECORD_PATH}`
    let read: BoundedRead
    try { read = readBoundedFile(path, 65_536) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined
        if (hasErrorCode(error, 'ELOOP', 'EISDIR', 'EIO')) throw new RefusalError(unusable)
        throw error
    }
    if (read.kind === 'too-large') throw new RefusalError(unusable)
    const bytes = read.bytes
    let parsed: unknown
    try { parsed = JSON.parse(bytes.toString('utf8')) }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        throw new RefusalError(`${POLICY_RECORD_PATH} is not JSON; restore it with git restore -- ${POLICY_RECORD_PATH}`)
    }
    const record = parsed as { format?: unknown; policy?: unknown }
    if (record?.format !== RECORD_FORMAT || !validPolicy(record.policy)) {
        throw new RefusalError(`${POLICY_RECORD_PATH} is not a ${RECORD_FORMAT} record; restore it with git restore -- ${POLICY_RECORD_PATH}`)
    }
    return record.policy
}

export async function writeRecordedPolicy(root: string, policy: EffectivePolicy): Promise<void> {
    const path = join(root, POLICY_RECORD_PATH)
    if (isDeepStrictEqual(await readRecordedPolicy(root), policy)) return
    await mkdir(dirname(path), { recursive: true })
    const staged = `${path}.${randomUUID()}.tmp`
    const handle = await open(staged, 'wx', 0o644)
    try {
        await handle.writeFile(`${JSON.stringify({ format: RECORD_FORMAT, policy }, null, 2)}\n`)
        await handle.sync()
    } finally { await handle.close() }
    try { await rename(staged, path) }
    catch (error) { await rm(staged, { force: true }); throw error }
}

/**
 * The cockpit.toml tables the guard keeps an agent from editing, as parsed values to compare, or
 * undefined when the text is not TOML. [mcp] is pinned only while a person approves MCP servers.
 */
export function pinnedPolicyTables(text: string): Readonly<Record<string, unknown>> | undefined {
    let parsed: Record<string, unknown>
    try { parsed = parseToml(text) as Record<string, unknown> }
    catch (error) {
        if (error instanceof TomlError) return undefined
        throw error
    }
    const autonomy = parsed.autonomy as Record<string, unknown> | undefined
    const mcpByAgent = (autonomy?.mcp_approve ?? AUTONOMY_DEFAULTS.mcp_approve) === 'agent'
    return { work: parsed.work, autonomy: parsed.autonomy, ...(mcpByAgent ? {} : { mcp: parsed.mcp }) }
}
