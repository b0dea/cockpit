export interface SupplyChainDiagnostic {
    readonly code: string
    readonly path: string
    readonly message: string
}

export function expectedPackageFiles(root: string): readonly string[]

export function runSupplyChainCheck(root: string): number

export function generateSbom(root: string, output: string): void
