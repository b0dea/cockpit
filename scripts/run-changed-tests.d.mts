export const mechanism: Readonly<{
    id: 'changed-adjacent-owner-tests'
    module: 'scripts/run-changed-tests.mjs'
    exports: readonly ['SLOW_TEST_PATH', 'runChangedTestsCli']
}>

export const SLOW_TEST_PATH: RegExp
export function runChangedTestsCli(argv: readonly string[]): Promise<number>
