export const RUN_VERDICTS = ['PASS', 'FAIL', 'PARTIAL', 'DEGRADED', 'VOID'] as const
export type RunVerdict = typeof RUN_VERDICTS[number]

export type StageResult =
    | Readonly<{ kind: 'executed'; exitCode: number; signal: string | null; outputBytes: number; assertion: 'passed' | 'failed' | 'missing' }>
    | Readonly<{ kind: 'unavailable'; reason: string }>
export type StageObservation = StageResult & Readonly<{ id: string }>

export interface RunInput {
    readonly declared: readonly string[]
    readonly selected: readonly string[]
    readonly observations: readonly StageObservation[]
    readonly scope: 'full' | 'subset' | 'staged'
    readonly stability: 'stable' | 'void' | 'stale' | 'unavailable'
}
export interface RunClassification {
    readonly verdict: RunVerdict
    readonly satisfiesGate: boolean
    readonly executed: number
    readonly reasons: readonly string[]
}

export function classifyRun(input: RunInput): RunClassification {
    const declared = new Set(input.declared)
    const selected = new Set(input.selected)
    const seen = new Set<string>()
    const reasons: string[] = []
    let failed = false
    let executed = 0
    let degraded = !declared.size || declared.size !== input.declared.length || !selected.size
        || selected.size !== input.selected.length || input.selected.some(id => !declared.has(id))
        || !['full', 'subset', 'staged'].includes(input.scope) || !['stable', 'void', 'stale', 'unavailable'].includes(input.stability)
    if (degraded) reasons.push('stage selection must be nonempty, unique and declared')
    for (const row of input.observations) {
        const first = !seen.has(row.id)
        if (!selected.has(row.id) || seen.has(row.id)) {
            degraded = true
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
            reasons.push(`${row.id}: ${row.reason}`)
        } else if (row.kind !== 'executed' || row.signal !== null || !Number.isInteger(row.exitCode) || row.exitCode < 0) {
            degraded = true
            reasons.push(`${row.id}: execution interrupted or invalid (${row.signal ?? row.exitCode})`)
        } else {
            // The authenticated exit status of a process that ran to completion proves the stage ran;
            // its output does not. Grading silence as unproven made tsc --noEmit, node --check and quiet
            // linters unable to satisfy a gate. A runner that selects no tests reports that through its
            // own exit status, and a narrowed run is PARTIAL whatever it prints.
            if (first && selected.has(row.id)) executed++
            if (row.assertion !== 'passed' && row.assertion !== 'failed') {
                degraded = true
                reasons.push(`${row.id}: no structured assertion result`)
            }
        }
    }
    for (const id of selected) if (!seen.has(id)) { degraded = true; reasons.push(`${id}: selected stage never ran`) }
    if (input.stability === 'unavailable') { degraded = true; reasons.push('subject stability evidence unavailable') }
    const voided = input.stability === 'void' || input.stability === 'stale'
    if (voided) reasons.push('subject changed or evidence authority is stale; evidence satisfies no gate')
    const partial = input.scope !== 'full' || selected.size !== declared.size
    const verdict: RunVerdict = failed ? 'FAIL' : degraded ? 'DEGRADED' : voided ? 'VOID' : partial ? 'PARTIAL' : 'PASS'
    return { verdict, satisfiesGate: verdict === 'PASS', executed, reasons }
}
