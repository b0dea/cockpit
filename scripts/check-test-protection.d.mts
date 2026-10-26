export const mechanism: Readonly<{
    id: 'test-protection'
    module: 'scripts/check-test-protection.mjs'
    exports: readonly ['classifyTestProtection', 'runTestProtectionCli']
}>
export interface TestProtectionFinding {
    readonly path: string
    readonly reason: string
}
export interface TestProtectionResult {
    readonly findings: readonly TestProtectionFinding[]
    readonly acknowledged: boolean
    readonly allowed: boolean
}
export function classifyTestProtection(diff: string, commitMessages?: string): TestProtectionResult
export function runTestProtectionCli(argv: readonly string[]): 0 | 1 | 2
