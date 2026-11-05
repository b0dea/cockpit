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
import { GRADING, type CockpitConfig, type Decider, type WorkGrading } from './schema.js'

export type WorkGate = 'accept' | 'amend' | 'answer' | 'signoff' | 'acknowledge'
type AutonomyDecision = 'sync' | 'stale_delete' | 'reset' | 'mcp_approve' | 'confirm_answers' | 'instruction_files'
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
// Confirming a non-trust answer and writing sibling instruction files are process gates a team may
// hand to the agent; they default to a person because a recorded policy that predates them reads them
// as person, and any other default would hold every existing cockpit for a weakening nobody made.
export const GATE_DEFAULTS: Readonly<Record<WorkGate, Decider>> = Object.freeze({ accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'agent', acknowledge: 'agent' })
export const AUTONOMY_DEFAULTS: Readonly<Record<AutonomyDecision, Decider>> = Object.freeze({ sync: 'agent', stale_delete: 'agent', reset: 'person', mcp_approve: 'person',
    confirm_answers: 'person', instruction_files: 'person' })

/** A trust answer listed under `unconfirmed` that cockpit holds at a stronger value until a person confirms it. */
export interface HeldAnswer { readonly field: 'work.grading' | 'environment.install_policies'; readonly declared: string; readonly inForce: string }
type TrustDeclarations = Readonly<{ unconfirmed?: Readonly<CockpitConfig['unconfirmed']>; work: Readonly<Pick<CockpitConfig['work'], 'grading'>>
    environment?: Readonly<Pick<CockpitConfig['environment'], 'install_policies'>> }>

/**
 * The trust answers in force. One listed under `unconfirmed` (an agent chose it, or an answers file,
 * which cannot show who wrote it, supplied it) waits for a person, and until one confirms it the
 * stronger of it and the default holds, so an agent cannot lower a bar by writing an answer. Each
 * trust answer init records:
 * - work.grading: independent, the default and the strongest mode.
 * - environment.install_policies: none, the default, for the build and test commands the guard admits.
 *   Setup still selects a policy by lockfile to install, since the install command is the toolchain's, not the answer's.
 * - guards: as declared; its hosts only add denials to the default, which denies none.
 * - testing: as declared; a gate only adds a bar, and the agent writes its criteria's checks anyway.
 * - sibling and environment.posture: as declared; neither has a default to fall back to (posture states
 *   facts that preflight judges), so doctor names them until a person confirms them.
 */
export function trustInForce(config: TrustDeclarations): Readonly<{ grading: WorkGrading
    installPolicies: CockpitConfig['environment']['install_policies']; held: readonly HeldAnswer[] }> {
    const waiting = new Set<string>(config.unconfirmed ?? [])
    const declaredPolicies = config.environment?.install_policies ?? []
    const grading = waiting.has('work.grading') ? 'independent' : config.work.grading
    const installPolicies = waiting.has('environment.install_policies') ? [] : declaredPolicies
    return { grading, installPolicies, held: [
        ...grading !== config.work.grading ? [{ field: 'work.grading' as const, declared: config.work.grading, inForce: grading }] : [],
        ...installPolicies.length < declaredPolicies.length ? [{ field: 'environment.install_policies' as const,
            declared: `${declaredPolicies.length} polic${declaredPolicies.length === 1 ? 'y' : 'ies'}`, inForce: 'none' }] : [],
    ] }
}

export function effectivePolicy(config: Readonly<{ unconfirmed?: Readonly<CockpitConfig['unconfirmed']>
    work: Readonly<Pick<CockpitConfig['work'], 'grading'> & { gates: Readonly<CockpitConfig['work']['gates']> }>
    autonomy: Readonly<CockpitConfig['autonomy']> }>): EffectivePolicy {
    const pick = <K extends string>(declared: Partial<Record<K, Decider>>, defaults: Readonly<Record<K, Decider>>) => Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [key, declared[key as K] ?? value])) as Record<K, Decider>
    return {
        grading: trustInForce(config).grading,
        gates: pick<WorkGate>(config.work.gates, GATE_DEFAULTS),
        autonomy: pick<AutonomyDecision>({ sync: config.autonomy.sync, stale_delete: config.autonomy.stale_delete,
            reset: config.autonomy.reset, mcp_approve: config.autonomy.mcp_approve,
            confirm_answers: config.autonomy.confirm_answers, instruction_files: config.autonomy.instruction_files }, AUTONOMY_DEFAULTS),
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

export interface PolicyWeakening { readonly field: string; readonly from: string; readonly to: string }

/** Every field `current` sets weaker than `recorded`, named as cockpit.toml spells it. */
export function policyWeakening(recorded: EffectivePolicy, current: EffectivePolicy): readonly PolicyWeakening[] {
    const rows: PolicyWeakening[] = []
    if (GRADING[current.grading].rank < GRADING[recorded.grading].rank) rows.push({ field: 'work.grading', from: recorded.grading, to: current.grading })
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

// A record written before a decision point existed lacks its key: the 0.1.0 record has no
// `acknowledge`. The missing decider is read as `person`, so a default that now hands it to the agent
// is reported as a weakening a person accepts once at sync, not refused for good nor passed unseen. An
// unknown key or value was not written by cockpit and refuses.
function recordedPolicy(value: unknown): EffectivePolicy | undefined {
    const deciders = <K extends string>(table: unknown, defaults: Readonly<Record<K, Decider>>): Record<K, Decider> | undefined => {
        if (typeof table !== 'object' || table === null || Array.isArray(table)) return undefined
        if (Object.entries(table).some(([key, entry]) => !Object.hasOwn(defaults, key) || !Object.hasOwn(DECIDER_RANK, entry as string))) return undefined
        const declared = table as Partial<Record<K, Decider>>
        return Object.fromEntries(Object.keys(defaults).map(key => [key, declared[key as K] ?? 'person'])) as Record<K, Decider>
    }
    if (typeof value !== 'object' || value === null || Object.keys(value).sort().join() !== 'autonomy,gates,grading') return undefined
    const row = value as Record<keyof EffectivePolicy, unknown>
    const gates = deciders(row.gates, GATE_DEFAULTS)
    const autonomy = deciders(row.autonomy, AUTONOMY_DEFAULTS)
    return Object.hasOwn(GRADING, row.grading as string) && gates && autonomy ? { grading: row.grading as WorkGrading, gates, autonomy } : undefined
}

// Restoring the committed copy helps only where the damage is uncommitted; where the committed copy is the
// damaged one, the record is a person's to remove, after which the next sync records cockpit.toml's policy.
const DAMAGED_RECORD_REMEDY = `restore the committed copy with git restore -- ${POLICY_RECORD_PATH}, or if that copy is the damaged one, `
    + `a person deletes ${POLICY_RECORD_PATH} and runs npx --no cockpit sync --config <your cockpit.toml> --interactive to record the policy cockpit.toml declares`

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
        throw new RefusalError(`${POLICY_RECORD_PATH} is not JSON; ${DAMAGED_RECORD_REMEDY}`)
    }
    const record = parsed as { format?: unknown; policy?: unknown } | null
    const policy = record?.format === RECORD_FORMAT ? recordedPolicy(record.policy) : undefined
    if (!policy) throw new RefusalError(`${POLICY_RECORD_PATH} is not a ${RECORD_FORMAT} record (an unknown format, table, key, decider or grading); ${DAMAGED_RECORD_REMEDY}`)
    return policy
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
 * undefined when the text is not TOML. Agent server approval exempts only mcp.approved;
 * tool restrictions and future MCP authority fields remain pinned.
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
    const mcp = parsed.mcp
    const pinnedMcp = mcpByAgent && mcp !== null && typeof mcp === 'object' && !Array.isArray(mcp)
        ? Object.fromEntries(Object.entries(mcp).filter(([key]) => key !== 'approved')) : mcp
    return { work: parsed.work, autonomy: parsed.autonomy, mcp: pinnedMcp }
}
