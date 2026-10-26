import { z } from 'zod'
import { snapshotJson } from '../environment/contract.js'
import type { RunVerdict } from '../testing/verdict.js'

export const mechanism = {
    id: 'comparison-startup',
    module: 'packages/cockpit/src/comparison/startup.ts',
    exports: ['COMPARISON_DATA_MODES', 'classifyStartupComparison'],
} as const

export const COMPARISON_DATA_MODES = Object.freeze(['empty', 'seeded', 'restored'] as const)
const sha256 = /^[a-f0-9]{64}$/

const StateSchema = z.object({
    dataSha256: z.string().regex(sha256),
    imageSha256: z.string().regex(sha256),
    cacheSha256: z.string().regex(sha256),
    lockSha256: z.string().regex(sha256),
    resourceSha256: z.string().regex(sha256),
    healthSha256: z.string().regex(sha256),
}).strict()
const EquivalenceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('equivalent'), state: StateSchema }).strict(),
    z.object({ kind: z.literal('unavailable'), reason: z.string().min(1).max(1_024) }).strict(),
])
const MeasurementSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('healthy'), invokedAtMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
        healthyAtMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
    z.object({ kind: z.enum(['failure', 'timeout', 'unhealthy']), reason: z.string().min(1).max(1_024) }).strict(),
])
const PairSchema = z.object({
    pair: z.number().int().min(1).max(5),
    order: z.enum(['legacy-first', 'cockpit-first']),
    equivalence: EquivalenceSchema,
    legacy: MeasurementSchema,
    cockpit: MeasurementSchema,
}).strict()
const StartupComparisonSchema = z.object({
    modes: z.array(z.object({ mode: z.enum(COMPARISON_DATA_MODES), pairs: z.array(PairSchema).length(5) }).strict())
        .length(COMPARISON_DATA_MODES.length),
}).strict()

export type StartupComparisonInput = z.input<typeof StartupComparisonSchema>
type StartupPairResult = Readonly<{
    pair: number
    order: 'legacy-first' | 'cockpit-first'
    legacyElapsedMs: number
    cockpitElapsedMs: number
}>
type StartupModeResult = Readonly<{
    mode: typeof COMPARISON_DATA_MODES[number]
    legacyMedianMs: number
    cockpitMedianMs: number
    pairs: readonly StartupPairResult[]
}>
export type StartupComparisonResult =
    | Readonly<{ kind: 'complete'; verdict: Extract<RunVerdict, 'PASS' | 'FAIL'>; satisfiesGate: boolean;
        modes: readonly StartupModeResult[] }>
    | Readonly<{ kind: 'refusal'; verdict: Extract<RunVerdict, 'DEGRADED'>; satisfiesGate: false; reasons: readonly string[] }>

function refusal(reasons: readonly string[]): StartupComparisonResult {
    return Object.freeze({ kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false,
        reasons: Object.freeze([...reasons]) })
}

function median(values: readonly number[]): number {
    return [...values].sort((left, right) => left - right)[2]!
}

export function classifyStartupComparison(input: unknown): StartupComparisonResult {
    const captured = snapshotJson(input)
    const parsed = StartupComparisonSchema.safeParse(captured)
    if (!parsed.success) return refusal(['startup evidence must contain exactly five bounded pairs for every data mode'])
    const modes = parsed.data.modes
    if (modes.some((row, index) => row.mode !== COMPARISON_DATA_MODES[index])) {
        return refusal(['startup data modes must be complete, unique and ordered empty, seeded, restored'])
    }
    const results: StartupModeResult[] = []
    const reasons: string[] = []
    for (const mode of modes) {
        const firstOrder = mode.pairs[0]!.order
        const expectedState = mode.pairs[0]!.equivalence.kind === 'equivalent'
            ? JSON.stringify(mode.pairs[0]!.equivalence.state) : undefined
        const pairs: StartupPairResult[] = []
        for (const [index, pair] of mode.pairs.entries()) {
            const expectedOrder = index % 2 === 0
                ? firstOrder
                : firstOrder === 'legacy-first' ? 'cockpit-first' : 'legacy-first'
            if (pair.pair !== index + 1 || pair.order !== expectedOrder) {
                reasons.push(`${mode.mode}: startup pairs must be numbered and alternate execution order`)
                continue
            }
            if (pair.equivalence.kind !== 'equivalent') {
                reasons.push(`${mode.mode} pair ${pair.pair}: equivalent initial state is unavailable`)
                continue
            }
            if (expectedState === undefined || JSON.stringify(pair.equivalence.state) !== expectedState) {
                reasons.push(`${mode.mode} pair ${pair.pair}: declared initial state differs within the paired series`)
                continue
            }
            if (pair.legacy.kind !== 'healthy' || pair.cockpit.kind !== 'healthy') {
                reasons.push(`${mode.mode} pair ${pair.pair}: both implementations must return healthy before their bound ends`)
                continue
            }
            const legacyElapsedMs = pair.legacy.healthyAtMs - pair.legacy.invokedAtMs
            const cockpitElapsedMs = pair.cockpit.healthyAtMs - pair.cockpit.invokedAtMs
            if (legacyElapsedMs < 0 || cockpitElapsedMs < 0) {
                reasons.push(`${mode.mode} pair ${pair.pair}: monotonic healthy return precedes invocation`)
                continue
            }
            const observedOrder = pair.legacy.healthyAtMs <= pair.cockpit.invokedAtMs
                ? 'legacy-first'
                : pair.cockpit.healthyAtMs <= pair.legacy.invokedAtMs ? 'cockpit-first' : undefined
            if (observedOrder !== pair.order) {
                reasons.push(`${mode.mode} pair ${pair.pair}: invocation-to-healthy intervals do not prove the declared order`)
                continue
            }
            pairs.push(Object.freeze({ pair: pair.pair, order: pair.order, legacyElapsedMs, cockpitElapsedMs }))
        }
        if (pairs.length !== 5) continue
        results.push(Object.freeze({ mode: mode.mode,
            legacyMedianMs: median(pairs.map(pair => pair.legacyElapsedMs)),
            cockpitMedianMs: median(pairs.map(pair => pair.cockpitElapsedMs)),
            pairs: Object.freeze(pairs) }))
    }
    if (reasons.length || results.length !== COMPARISON_DATA_MODES.length) return refusal(reasons.length ? reasons : ['startup evidence is incomplete'])
    const failed = results.some(row => row.cockpitMedianMs > row.legacyMedianMs)
    return Object.freeze({ kind: 'complete', verdict: failed ? 'FAIL' : 'PASS', satisfiesGate: !failed,
        modes: Object.freeze(results) })
}
