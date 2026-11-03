import { admitDiagnosticFix, type ExecutableFix, type FixContext } from './fix-catalogue.js'
import type { Diagnostic } from './diagnostics.js'

interface RepairInput {
    readonly changes: readonly Readonly<{ operation: 'write' | 'remove'; path: string }>[]
    readonly repairAuthority?: Readonly<{ kind: 'generated-environment-repair' }>
    readonly outcome: Readonly<{ diagnostics: readonly Diagnostic[] }>
    readonly fixContext: FixContext
    readonly repairRefusal?: Readonly<{
        kind: 'refusal'; artifact: null; destination: null
        diagnostics: readonly Diagnostic[]; result: null; status: 2
    }>
}

export function proposeGeneratedEnvironmentRepair(currentness: RepairInput): Readonly<{
    changes: RepairInput['changes']; fixes: readonly ExecutableFix[]
    refusal: RepairInput['repairRefusal'] | null
}> {
    const fixes = currentness.repairAuthority ? currentness.outcome.diagnostics.flatMap(diagnostic => {
        const admitted = admitDiagnosticFix(diagnostic, currentness.fixContext)
        return admitted ? [admitted] : []
    }) : []
    return { changes: currentness.changes, fixes, refusal: currentness.repairRefusal ?? null }
}
