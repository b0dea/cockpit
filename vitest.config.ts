import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const SLOW = '**/*.slow.test.ts'

export default defineConfig({
    test: {
        // Never more workers than cores, and never more than four: four workers on a two-core hosted
        // runner ran the suite out of memory and past its per-test timeouts, and several agent
        // sessions share one machine.
        maxWorkers: Math.min(4, availableParallelism()),
        // Prior-duration ordering clusters subprocess-heavy files and increases I/O contention.
        // Keep scheduling independent of earlier runs; transformed modules remain cached.
        cache: false,
        allowOnly: false,
        // An absolute path: the discovery test runs this config against a scratch root.
        reporters: ['default', fileURLToPath(new URL('./scripts/skip-allowlist-reporter.mjs', import.meta.url))],
        projects: [
            {
                extends: true,
                test: {
                    name: 'fast',
                    include: configDefaults.include.map((pattern) => `packages/*/${pattern}`),
                    exclude: [...configDefaults.exclude, SLOW],
                },
            },
            {
                // Packaging, the installed tarball, end-to-end CLI and composition runs, real Docker.
                extends: true,
                test: {
                    name: 'slow',
                    include: [`packages/*/${SLOW}`],
                },
            },
        ],
        setupFiles: ['packages/cockpit/src/test-support/git-isolation.ts'],
        // Real process and filesystem integration needs a larger budget than in-memory tests.
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
})
