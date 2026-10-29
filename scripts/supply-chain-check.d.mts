export interface SupplyChainDiagnostic {
    readonly code: string
    readonly path: string
    readonly message: string
}

export function expectedPackageFiles(root: string): readonly string[]

export interface NpmLaunchRuntime {
    readonly platform: NodeJS.Platform
    readonly nodePath: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface NpmLaunch {
    readonly executable: string
    readonly prefix: readonly string[]
}

export function resolveNpmLaunch(runtime?: Partial<NpmLaunchRuntime>): NpmLaunch

export function runSupplyChainCheck(root: string): number

export function generateSbom(root: string, output: string): void
