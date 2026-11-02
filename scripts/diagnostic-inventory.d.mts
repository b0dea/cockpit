import type ts from '@typescript/typescript6'

/**
 * What the index can say about a code's fix: the one fix every emission states, that emissions
 * state different fixes (or some state none), or that none states a literal fix.
 */
export type DiagnosticRemedy =
    | Readonly<{ kind: 'fixed'; fix: string }>
    | Readonly<{ kind: 'varies' }>
    | Readonly<{ kind: 'none' }>

export interface DiagnosticInventory {
    items: string[]
    owners: Map<string, Set<string>>
    remedies: Map<string, DiagnosticRemedy>
    /** Codes each command handler can emit, keyed by the command table's handler identifier. */
    commandDiagnostics: Map<string, Set<string>>
}

export interface ReferenceDiagnostic {
    readonly severity: 'error'
    readonly code: string
    readonly message: string
    readonly target?: string
}

export type RepositoryReferenceResult =
    | Readonly<{ kind: 'complete'; ok: boolean; diagnostics: readonly ReferenceDiagnostic[]; committed?: readonly Readonly<{ path: string; sha256: string }>[] }>
    | Readonly<{ kind: 'refusal'; status: 2; diagnostics: readonly ReferenceDiagnostic[] }>

export declare const mechanism: Readonly<{
    id: 'maintainer-reference-preparation'
    module: 'scripts/diagnostic-inventory.mjs'
    exports: readonly string[]
}>

export declare function productionTypeScriptPaths(root: string, candidate: string): string[]
export declare function productionTypeScriptSources(root: string, candidate: string): Map<string, string>
export declare function typeScriptSource(path: string, source: string): ts.SourceFile
export declare function exported(node: ts.Node): boolean
export declare function diagnosticInventory(root: string, candidate: string): DiagnosticInventory
export declare function diagnosticInventoryFromSources(paths: string[], sources: Map<string, string>): DiagnosticInventory
export declare function checkRepositoryReferences(root: string, candidate?: string): Promise<RepositoryReferenceResult>
export declare function publishRepositoryReferences(
    root: string,
    options?: Readonly<{ dryRun?: boolean }>,
): Promise<RepositoryReferenceResult>
