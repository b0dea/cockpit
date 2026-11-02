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
export declare function inspectInternalLinks(input: { path: string; body: string; readTarget(path: string): string }): DocsLintDiagnostic[]

export declare const ROOT_URL: URL
export declare const ROOT: string
export declare const IMPLEMENTED_MECHANISMS: readonly { id: string; exports: readonly string[] }[]
export declare function classifyMarkdownPath(path: string): MarkdownEstate | null
export declare function lintMarkdown(path: string, body: string): DocsLintDiagnostic[]
export declare function resolveCodeOwners(paths: readonly string[], source: string): DocsOwnership[]
export declare function repositoryMarkdownPaths(root?: string): string[]
