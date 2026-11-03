import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// A skipped or todo test is a test that silently stopped guarding something. Only the skips
// listed here, each with its reason, may exist; any other fails the run.
const EXPECTED_SKIPS = [
    // Case-insensitive filesystem behaviour cannot be reproduced on Linux.
    ...(process.platform === 'linux' ? [
        /refuses ownership aliases of authenticated inputs on case-insensitive filesystems$/,
        /refuses ownership alias checks during a restored (?:input|root) namespace swap$/,
    ] : []),
]
// Needs the maintainer's private material, which a clean public clone does not have.
const NEEDS_INTERNAL = /configures the site-specific list, having the material for it$/

export default class SkipAllowlistReporter {
    onInit(vitest) {
        this.vitest = vitest
    }

    onTestRunEnd(testModules) {
        const { root, testNamePattern } = this.vitest.config
        // A name filter skips every other case by design.
        if (testNamePattern) return
        const allowed = [...EXPECTED_SKIPS, ...(existsSync(resolve(root, 'internal')) ? [] : [NEEDS_INTERNAL])]
        const unexpected = []
        for (const module of testModules) {
            for (const test of module.children.allTests()) {
                const skipped = test.result().state === 'skipped' || test.options.mode === 'todo'
                if (skipped && !allowed.some((pattern) => pattern.test(test.fullName))) {
                    unexpected.push(`${module.relativeModuleId} > ${test.fullName}`)
                }
            }
        }
        if (unexpected.length === 0) return
        this.vitest.logger.error(`\nSKIPPED_TEST_NOT_ALLOWED: skipped or todo tests must be listed in scripts/skip-allowlist-reporter.mjs:\n  ${unexpected.join('\n  ')}`)
        process.exitCode = 1
    }
}
