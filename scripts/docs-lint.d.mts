export type MarkdownEstate = 'human' | 'executable' | 'fixture'

export interface DocsLintDiagnostic {
    code: string
    line: number
    message: string
    path: string
}

export interface DocsOwnership {
    owners: string[]
    path: string
}

export type { DiagnosticInventory } from './diagnostic-inventory.mjs'
import type { DiagnosticInventory } from './diagnostic-inventory.mjs'

export declare function diagnosticInventory(root: string, candidate: string): DiagnosticInventory

export interface MarkdownProseLine {
    readonly line: number
    readonly prose: string
    readonly references: string
    readonly comments: readonly string[]
}

export interface MarkdownProseWalk {
    readonly lines: readonly MarkdownProseLine[]
    readonly diagnostics: readonly DocsLintDiagnostic[]
}

export interface ProseReferenceAuthority {
    readonly commands: ReadonlySet<string>
    readonly diagnostics: ReadonlySet<string>
    readonly identifiers: ReadonlySet<string>
    readonly flags: ReadonlySet<string>
    readonly schemaFields?: ReadonlySet<string>
    readonly consumerPaths?: ReadonlySet<string>
}

export type ProsePathState = 'present' | 'declared-before-sync' | 'missing' | 'unavailable' | 'retired'

export interface ProseReferenceInput {
    readonly path: string
    readonly body: string
    readonly authority: ProseReferenceAuthority
    readonly resolvePath: (path: string) => ProsePathState
    readonly today?: string
}

export declare function walkMarkdownProse(path: string, body: string): MarkdownProseWalk
export declare function inspectProseReferences(input: ProseReferenceInput): DocsLintDiagnostic[]

export interface DocumentationInventoryOptions {
    candidate?: string
    /** Independently trusted policy input; this detector verifies identity and ancestry but does not select the baseline. */
    expectedFixedPoint: string
    root?: string
}

export interface DocumentationEvidenceOptions extends DocumentationInventoryOptions {
    /** Independently trusted Ed25519 public key for navigation receipts; never read from the evidence document. */
    navigationPublicKeyPath?: string
    impactLedgerPath?: string
    path: string
}

export interface DocumentationInventory {
    candidate?: string
    errors: string[]
    fixedPoint?: string
    items: string[]
    navigationItems: string[]
    navigationPaths: string[]
    reviewItems: string[]
}

export interface FixedPointEvidenceOptions {
    candidate?: string
    expectedFixedPoint: string
    path: string
    root?: string
}

export interface ContractEvidenceOptions {
    contractPath: string
    inputPath: string
    root?: string
}

export interface ReviewReportsOptions extends DocumentationInventoryOptions {
    manifestPath: string
    reviewPaths: readonly string[]
}

export interface NavigationManifestEvidenceOptions {
    manifestPath: string
    navigationPublicKeyPath?: string
    impactLedgerPath?: string
    path: string
    root?: string
}

export interface EdgeCoverageDocumentsOptions {
    contractPath: string
    coveragePath: string
    root?: string
    sourceInputPath: string
}

export interface AcceptanceDocumentsOptions extends ContractEvidenceOptions {
    artifacts: Readonly<Record<string, string>>
}

export declare const ROOT_URL: URL
export declare const ROOT: string
export declare const IMPLEMENTED_MECHANISMS: readonly { id: string; exports: readonly string[] }[]
export declare function classifyMarkdownPath(path: string): MarkdownEstate | null
export declare function lintMarkdown(path: string, body: string): DocsLintDiagnostic[]
export declare function resolveCodeOwners(paths: readonly string[], source: string): DocsOwnership[]
export declare function repositoryMarkdownPaths(root?: string): string[]
export declare function deriveDocumentationInventory(options: DocumentationInventoryOptions): DocumentationInventory
export declare function validateImpactLedger(options: DocumentationEvidenceOptions): string[]
export declare function validateNavigationEvidence(options: DocumentationEvidenceOptions): string[]
export declare function validateOperatorReviewEvidence(options: DocumentationEvidenceOptions): string[]
export declare function writeReviewManifest(options: FixedPointEvidenceOptions): string[]
export declare function validateReviewEvidence(options: FixedPointEvidenceOptions): string[]
export declare function validateReviewReports(options: ReviewReportsOptions): string[]
export declare function validateRuntimeEvidence(options: FixedPointEvidenceOptions): string[]
export declare function validateEdgeCoverage(options: ContractEvidenceOptions): string[]
export declare function validateEdgeCoverageDocuments(options: EdgeCoverageDocumentsOptions): string[]
export declare function validateAcceptanceEvidence(options: ContractEvidenceOptions): string[]
export declare function validateAcceptanceDocuments(options: AcceptanceDocumentsOptions): string[]
export declare function validateNavigationEvidenceFromManifest(options: NavigationManifestEvidenceOptions): string[]
