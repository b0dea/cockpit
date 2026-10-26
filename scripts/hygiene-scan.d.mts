// Hand-written because the implementation is .mjs — see the header there for why it is not
// TypeScript. tsc resolves this when the test imports the module; it compiles neither file.
export declare const IMPLEMENTED_MECHANISMS: readonly { id: string; exports: readonly string[] }[]
export declare const ROOT_URL: URL
export declare const ROOT: string
export declare const SITE_NEEDLES: string
export declare const INTERNAL: string
export declare const FIXTURE: string
export declare const ALLOWED: { file: string; lineSha256: readonly string[]; why: string }[]
export declare function universalPatterns(): string[]
export declare function siteTerms(rootUrl?: URL): string[] | null
export declare function hasInternal(rootUrl?: URL): boolean
export declare function buildNeedle(terms: string[]): RegExp
export declare function coverage(site: string[] | null): string
export declare function scanText(body: string, needle: RegExp): number[]
export declare function scanPathText(path: string, body: string, site: string[]): number[]
export declare function scanPublicationPathText(path: string, body: string): number[]
export declare function trackedContents(root?: string): Map<string, string>
export declare function untrackedPaths(root?: string): string[]
export declare function scanGitHistory(root?: string): {
    surface: string
    coverage: string
    commits: number
    blobs: number
    complete: boolean
    clean: boolean
    findings: { commit: string; path: string; kind: string; line: number }[]
    gaps: string[]
}
