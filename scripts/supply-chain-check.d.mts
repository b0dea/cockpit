export interface SupplyChainDiagnostic {
    readonly code: string
    readonly path: string
    readonly message: string
}

export function expectedPackageFiles(root: string): readonly string[]
