export const RUN_VERDICTS = ['PASS', 'FAIL', 'PARTIAL', 'DEGRADED', 'VOID'] as const
export type RunVerdict = typeof RUN_VERDICTS[number]

// What a failed stage printed: where its combined output was saved and its last lines. A passing stage
// reports one only when saving failed, so the failure is never silent.
export type StageOutput = Readonly<{ path?: string; saveError?: string; tail?: readonly string[] }>
// `stop` marks a stage a product tool runner could not start for a cause that is the environment's, not the product's: a
// command not on cockpit's search path, or an executor failure. A stage the product stopped, by timing out, printing too
// much or a command file the work removed, carries none, so a slow or broken product still fails.
export type StageResult =
    | Readonly<{ kind: 'executed'; exitCode: number; signal: string | null; outputBytes: number; assertion: 'passed' | 'failed' | 'missing'; output?: StageOutput }>
    | Readonly<{ kind: 'unavailable'; reason: string; stop?: 'command-unavailable' }>
export type StageObservation = StageResult & Readonly<{ id: string }>

export interface RunInput {
    readonly declared: readonly string[]
    readonly selected: readonly string[]
    readonly observations: readonly StageObservation[]
    readonly scope: 'full' | 'subset' | 'staged'
    readonly stability: 'stable' | 'void' | 'stale' | 'unavailable'
    /** The stages the environment kept from running: no running stack, no declared selection, or a runner that could not start them. */
    readonly stopped?: readonly string[]
}
export interface RunClassification {
    readonly verdict: RunVerdict
    readonly satisfiesGate: boolean
    readonly executed: number
    readonly reasons: readonly string[]
    /** DEGRADED only by stages the environment kept from running, so the run says nothing about the product. */
    readonly environmental?: true
}

export function classifyRun(input: RunInput): RunClassification {
    const declared = new Set(input.declared)
    const selected = new Set(input.selected)
    const seen = new Set<string>()
    const reasons: string[] = []
    let failed = false
    let executed = 0
    // Degraded by anything but a stage the environment stopped.
    let otherwise = false
    let degraded = !declared.size || declared.size !== input.declared.length || !selected.size
        || selected.size !== input.selected.length || input.selected.some(id => !declared.has(id))
        || !['full', 'subset', 'staged'].includes(input.scope) || !['stable', 'void', 'stale', 'unavailable'].includes(input.stability)
    if (degraded) { otherwise = true; reasons.push('stage selection must be nonempty, unique and declared') }
    for (const row of input.observations) {
        const first = !seen.has(row.id)
        if (!selected.has(row.id) || seen.has(row.id)) {
            degraded = otherwise = true
            reasons.push(`${row.id}: unexpected or duplicate stage evidence`)
        }
        seen.add(row.id)
        if (row.kind === 'executed' && (row.assertion === 'failed'
            || row.signal === null && Number.isInteger(row.exitCode) && row.exitCode > 0)) {
            failed = true
            reasons.push(`${row.id}: executed check disagreed (exit ${row.exitCode})`)
        }
        if (row.kind === 'unavailable') {
            degraded = true
            if (!input.stopped?.includes(row.id)) otherwise = true
            reasons.push(`${row.id}: ${row.reason}`)
        } else if (row.kind !== 'executed' || row.signal !== null || !Number.isInteger(row.exitCode) || row.exitCode < 0) {
            degraded = otherwise = true
            reasons.push(`${row.id}: execution interrupted or invalid (${row.signal ?? row.exitCode})`)
        } else {
            // The authenticated exit status of a process that ran to completion proves the stage ran;
            // its output does not. Grading silence as unproven made tsc --noEmit, node --check and quiet
            // linters unable to satisfy a gate. A runner that selects no tests reports that through its
            // own exit status, and a narrowed run is PARTIAL whatever it prints.
            if (first && selected.has(row.id)) executed++
            if (row.assertion !== 'passed' && row.assertion !== 'failed') {
                degraded = otherwise = true
                reasons.push(`${row.id}: no structured assertion result`)
            }
        }
    }
    for (const id of selected) if (!seen.has(id)) { degraded = otherwise = true; reasons.push(`${id}: selected stage never ran`) }
    if (input.stability === 'unavailable') { degraded = otherwise = true; reasons.push('subject stability evidence unavailable') }
    const voided = input.stability === 'void' || input.stability === 'stale'
    if (voided) reasons.push('subject changed or evidence authority is stale; evidence satisfies no gate')
    const partial = input.scope !== 'full' || selected.size !== declared.size
    const verdict: RunVerdict = failed ? 'FAIL' : degraded ? 'DEGRADED' : voided ? 'VOID' : partial ? 'PARTIAL' : 'PASS'
    // Checkouts that changed under the gate are the work's to answer for, so a void run is never the environment's.
    return { verdict, satisfiesGate: verdict === 'PASS', executed, reasons, ...verdict === 'DEGRADED' && !otherwise && !voided ? { environmental: true as const } : {} }
}
