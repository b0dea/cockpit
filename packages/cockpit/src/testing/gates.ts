import { compareEnvironmentSnapshot, type EnvironmentSnapshot, type RuntimeEvidence } from '../environment/evidence.js'
import { planSiblingProjection, type ProjectionPlannerInput, type StandingCost } from '../surfaces/projection.js'
import { GUARD_SURFACE_TARGETS } from '../surfaces/harness-registry.js'
import { TESTING_STAGE_TIMEOUT_MAX_SECONDS } from '../schema.js'
import { classifyRun, type RunClassification, type RunInput, type StageObservation, type StageResult } from './verdict.js'

export const mechanism = {
    id: 'testing-gate-registry',
    module: 'packages/cockpit/src/testing/gates.ts',
    exports: ['GATE_SELECTOR_OPTION', 'TESTING_GUIDE_REGISTRY', 'createGateRegistry', 'runGate', 'renderTierGuide'],
} as const

export const GATE_SELECTOR_OPTION = '--select'
const SELECTOR_KINDS = Object.freeze(['spec', 'file', 'test', 'route'] as const)
const SELECTOR_VALUE = '{value}'
export type GateSelector =
    | Readonly<{ kind: 'spec'; value: string }>
    | Readonly<{ kind: 'file'; value: string }>
    | Readonly<{ kind: 'test'; value: string }>
    | Readonly<{ kind: 'route'; value: string }>

export interface GateStage {
    readonly id: string
    readonly command: readonly [string, ...string[]]
    readonly requiresStack: boolean
    readonly timeoutSeconds: number
    // The tool's own arguments for each selection kind; {value} is replaced by the selected value.
    readonly select?: Readonly<Partial<Record<GateSelector['kind'], readonly string[]>>>
}
export interface GateDefinition {
    readonly id: string
    readonly tier: 'targeted' | 'full'
    readonly stages: readonly string[]
    readonly changes: string
}
export interface GateDeclarations {
    readonly stages: readonly GateStage[]
    readonly gates: readonly GateDefinition[]
}
export interface GateRegistry extends GateDeclarations {
    readonly kind: 'bound' | 'unbound'
    readonly tiers: readonly Readonly<{ id: 'none' | 'targeted' | 'full'; title: string; changes: string; gate: string }>[]
}

const tiers: GateRegistry['tiers'] = Object.freeze([
    Object.freeze({ id: 'none', title: 'None', changes: 'Comments or documentation only, when no behavior changes', gate: 'No gate required' }),
    Object.freeze({ id: 'targeted', title: 'Targeted', changes: 'Isolated behavior', gate: 'Select the narrowest proving product gate' }),
    Object.freeze({ id: 'full', title: 'Full', changes: 'Shared or cross-system behavior', gate: 'Run the complete declared product gate' }),
])
const issuedRegistries = new WeakSet<GateRegistry>()
export const TESTING_GUIDE_REGISTRY: GateRegistry = Object.freeze({ kind: 'unbound', tiers, stages: Object.freeze([]), gates: Object.freeze([]) })
issuedRegistries.add(TESTING_GUIDE_REGISTRY)

const NAME = /^[a-z][a-z0-9-]{0,63}$/
const text = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)

export function createGateRegistry(input: GateDeclarations): GateRegistry {
    if (!Array.isArray(input.stages) || !Array.isArray(input.gates) || !input.stages.length || !input.gates.length
        || input.stages.length > 128 || input.gates.length > 128) throw new Error('gate registry requires bounded nonempty stages and gates')
    const stageIds = new Set(input.stages.map(stage => stage.id))
    if (stageIds.size !== input.stages.length || new Set(input.gates.map(gate => gate.id)).size !== input.gates.length
        || input.stages.some(stage => !NAME.test(stage.id) || !Array.isArray(stage.command) || !stage.command.length
            || stage.command.length > 128 || !stage.command.every(text) || typeof stage.requiresStack !== 'boolean'
            || !Number.isSafeInteger(stage.timeoutSeconds) || stage.timeoutSeconds < 1 || stage.timeoutSeconds > TESTING_STAGE_TIMEOUT_MAX_SECONDS
            || stage.select !== undefined && (typeof stage.select !== 'object' || stage.select === null
                || Object.entries(stage.select).some(([kind, argv]) => !(SELECTOR_KINDS as readonly string[]).includes(kind) || !Array.isArray(argv)
                    || !argv.length || argv.length > 32 || !argv.every(text) || !argv.some(value => value.includes(SELECTOR_VALUE)))))
        || input.gates.some(gate => !NAME.test(gate.id) || !['targeted', 'full'].includes(gate.tier) || !text(gate.changes)
            || !Array.isArray(gate.stages) || !gate.stages.length || new Set(gate.stages).size !== gate.stages.length
            || gate.stages.some((id: string) => !stageIds.has(id)))) throw new Error('gate registry contains invalid or duplicate declarations')
    const registry: GateRegistry = Object.freeze({ kind: 'bound', tiers,
        stages: Object.freeze(input.stages.map(stage => Object.freeze({ ...stage, command: Object.freeze([...stage.command]) as readonly [string, ...string[]],
            ...(stage.select === undefined ? {} : { select: Object.freeze(Object.fromEntries(Object.entries(stage.select)
                .map(([kind, argv]) => [kind, Object.freeze([...argv as readonly string[]])]))) }) }))),
        gates: Object.freeze(input.gates.map(gate => Object.freeze({ ...gate, stages: Object.freeze([...gate.stages]) }))),
    })
    issuedRegistries.add(registry)
    return registry
}

export interface ProductGateInvocation {
    readonly gate: string
    readonly stage: string
    readonly command: readonly [string, ...string[]]
    readonly timeoutSeconds: number
    readonly select: GateSelector | null
}
export interface GateRequest {
    readonly gate: string
    readonly stages?: readonly string[]
    readonly select?: GateSelector
    readonly staged?: boolean
    readonly stack?: Readonly<{ state: 'available' }> | Readonly<{ state: 'unavailable'; reason: string }>
}
export interface GateDependencies {
    readonly subject: () => Promise<string>
    readonly runProductTool: (invocation: ProductGateInvocation) => Promise<StageResult>
    readonly runtime?: Readonly<{ snapshot: EnvironmentSnapshot; capture: () => Promise<RuntimeEvidence> }>
}
export interface GateRun extends RunClassification {
    readonly observations: readonly StageObservation[]
}

function errorReason(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export async function runGate(registry: GateRegistry, request: GateRequest, deps: GateDependencies): Promise<GateRun> {
    if (!issuedRegistries.has(registry) || registry.kind !== 'bound') throw new Error('gate execution requires an issued product-bound registry')
    const gate = registry.gates.find(gate => gate.id === request.gate)
    const requested = request.stages ?? gate?.stages ?? []
    if (!gate || !requested.length || requested.some(id => !gate.stages.includes(id))) throw new Error('gate selection is empty or unknown')
    const select = request.select === undefined ? null : Object.freeze({ ...request.select })
    if (select && (!(SELECTOR_KINDS as readonly string[]).includes(select.kind) || !text(select.value))) throw new Error('gate selection has an invalid selector')
    const selected = gate.stages.filter(id => requested.includes(id))
    const observations: StageObservation[] = []
    let before: string | undefined
    let stability: RunInput['stability'] = 'stable'
    const stabilityReasons: string[] = []
    const needsRuntime = selected.some(id => registry.stages.find(stage => stage.id === id)!.requiresStack)
    let runtimeBefore: RuntimeEvidence | undefined
    let runtimeFresh = true
    const capture = async (): Promise<RuntimeEvidence | undefined> => {
        try {
            if (!deps.runtime) throw new Error('runtime stability capture not supplied')
            const startedAt = Date.now()
            const evidence = await deps.runtime.capture()
            if (evidence.state === 'available' && (Date.parse(evidence.captureStartedAt) < startedAt || Date.parse(evidence.observedAt) > Date.now())) runtimeFresh = false
            return evidence
        } catch (error) {
            stabilityReasons.push(`runtime stability unavailable: ${errorReason(error)}`)
            stability = 'unavailable'
            return undefined
        }
    }
    try { before = await deps.subject(); if (!/^[a-f0-9]{64}$/.test(before)) throw new Error('subject digest must be SHA-256') }
    catch (error) { stability = 'unavailable'; stabilityReasons.push(`subject before: ${errorReason(error)}`) }
    if (needsRuntime) runtimeBefore = await capture()
    for (const id of selected) {
        const stage = registry.stages.find(stage => stage.id === id)!
        let result: StageResult
        const selection = select ? stage.select?.[select.kind] : undefined
        if (stage.requiresStack && request.stack?.state !== 'available') {
            result = { kind: 'unavailable', reason: `stack unavailable: ${request.stack?.state === 'unavailable' ? request.stack.reason : 'no current stack observation'}` }
        } else if (select && !selection) {
            // Running the whole stage would report a selection that never happened.
            result = { kind: 'unavailable', reason: `stage ${id} declares no ${select.kind} selection; add testing.stages[].select.${select.kind} with the tool's own arguments` }
        } else {
            const command = Object.freeze([...stage.command, ...(selection ?? []).map(value => value.replaceAll(SELECTOR_VALUE, select!.value))]) as readonly [string, ...string[]]
            try { result = await deps.runProductTool(Object.freeze({ gate: gate.id, stage: id, command, timeoutSeconds: stage.timeoutSeconds, select })) }
            catch (error) { result = { kind: 'unavailable', reason: `product tooling could not run: ${errorReason(error)}` } }
        }
        observations.push(Object.freeze({ ...result, id }))
    }
    try {
        const after = await deps.subject()
        if (!/^[a-f0-9]{64}$/.test(after)) throw new Error('subject digest must be SHA-256')
        if (before !== undefined && before !== after && stability !== 'unavailable') stability = 'void'
    } catch (error) { stability = 'unavailable'; stabilityReasons.push(`subject after: ${errorReason(error)}`) }
    if (needsRuntime) {
        const runtimeAfter = await capture()
        if (deps.runtime && runtimeBefore && runtimeAfter) {
            const comparison = compareEnvironmentSnapshot(deps.runtime.snapshot, runtimeBefore, runtimeAfter)
            stabilityReasons.push(...comparison.diagnostics.map(row => row.message))
            if (comparison.verdict === 'unavailable') stability = 'unavailable'
            else if (stability !== 'unavailable' && comparison.verdict !== 'stable') stability = comparison.verdict
            if (!runtimeFresh && stability !== 'unavailable') {
                stability = 'stale'
                stabilityReasons.push('runtime capture predates the gate or is in the future')
            }
        } else stability = 'unavailable'
    }
    const result = classifyRun({ declared: gate.stages, selected, observations,
        scope: request.staged ? 'staged' : select ? 'subset' : 'full', stability })
    return Object.freeze({ ...result, observations: Object.freeze(observations), reasons: Object.freeze([...result.reasons, ...stabilityReasons]) })
}

// Without a declared gate there is nothing for test-run to run, and a tier table would send agents
// looking for a gate that does not exist; so the guide says what to do instead and never promises PASS.
const NO_GATE_GUIDE = '# Testing tiers\n\n'
    + 'This cockpit declares no product test gate, so no change can be graded PASS.\n\n'
    + 'Before changing behavior, add a characterization test at the nearest public boundary in the product\'s existing test runner and run it with that runner. If the product has no test runner, propose one to a person; do not add a test framework unasked. Comments or documentation changes that leave behavior unchanged need no test.\n\n'
    + 'Never report work as verified or passing: report which tests you ran and how they exited, and that no gate graded them.\n\n'
    + 'Ask a person to declare `[testing]` stages and gates in cockpit.toml, as the *Choose the proving test tier* section of `./node_modules/@b0dea/cockpit/docs/work-and-browser.md` describes.\n'

export type TierGuideResult = Readonly<{ kind: 'complete'; bytes: string; lines: number; costs: readonly StandingCost[] }>
    | Readonly<{ kind: 'refusal'; reason: string; exceeded?: Readonly<{ target: string; value: number; cap: number }> }>

export function renderTierGuide(registry: GateRegistry, projection: ProjectionPlannerInput): TierGuideResult {
    if (!issuedRegistries.has(registry)) throw new Error('testing guide requires an issued registry')
    const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('`', '')
    const rows = registry.tiers.map(tier => {
        const gates = registry.gates.filter(gate => gate.tier === tier.id)
        return `| ${tier.title} | ${gates.map(gate => cell(gate.changes)).join('; ') || tier.changes} | ${gates.map(gate => `\`${gate.id}\` (${gate.stages.join(', ')})`).join('; ') || tier.gate} |`
    })
    const bytes = registry.kind === 'unbound' ? NO_GATE_GUIDE : `# Testing tiers\n\nChoose the narrowest product-owned gate that proves the change.\n\n`
        + '| Tier | Change | Gate and ordered stages |\n| --- | --- | --- |\n' + rows.join('\n') + '\n\n'
        + 'Extend an existing behavior test at the nearest public boundary when it can prove the change; add a test only when no existing test owns that behavior. Each test must fail when that behavior regresses. Do not duplicate proof already supplied by a stronger test.\n\n'
        + `Run a gate with \`npx --no cockpit test-run --config cockpit.toml --gate <id>\`. Narrow it with \`npx --no cockpit test-run --config cockpit.toml --gate <id> ${GATE_SELECTOR_OPTION} <kind>:<value>\`, where kind is spec, file, test, or route. Each stage receives the value through its declared \`select\` arguments in its own tool's spelling; a stage that declares none for that kind is reported unavailable rather than run unselected.\n\n`
        + 'Use the targeted gate while iterating. When a stage runs the affected or changed-since selection of the product build or test tool, let that tool choose the tests instead of narrowing by hand. If the declared tier is Full, run the complete gate once after implementation and review stabilize, before handing back. A targeted tier ends with its declared targeted gate.\n\n'
        + 'Only the complete declared gate can PASS. Subsets and staged selftest are PARTIAL; unavailable checks are DEGRADED; changed subjects are VOID. Executed failures remain FAIL.\n\n'
        + 'All selected stages run. Stack-dependent stages name an unavailable stack. Generated hooks run no tests; call correctness gates explicitly or through CI.\n'
    const lines = bytes.trimEnd().split('\n').length
    const guidePath = 'packages/cockpit/surfaces/references/testing-tiers.md'
    const checked = planSiblingProjection({ ...projection, standingSources: [...projection.standingSources.filter(source => source.path !== guidePath),
        ...GUARD_SURFACE_TARGETS.map(target => ({ target,
            path: guidePath, content: bytes, scope: 'always' as const }))] })
    if (checked.kind === 'refusal') return Object.freeze({ kind: 'refusal', reason: checked.diagnostic.message })
    const exceeded = checked.costs.find(cost => cost.status === 'exceeded')
    if (exceeded?.status === 'exceeded') return Object.freeze({ kind: 'refusal',
        reason: `the instructions ${exceeded.target} loads at start are ${exceeded.value} lines, over cockpit.guide_cap ${exceeded.cap}`,
        exceeded: Object.freeze({ target: exceeded.target, value: exceeded.value, cap: exceeded.cap }) })
    if (checked.costs.some(cost => cost.status !== 'within_cap')) return Object.freeze({ kind: 'refusal', reason: 'combined instruction cost is not characterized for every harness' })
    return Object.freeze({ kind: 'complete', bytes, lines, costs: checked.costs })
}
