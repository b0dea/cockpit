import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: configDefaults.include.map((pattern) => `packages/*/${pattern}`),
        // Many suites launch real subprocesses. Bound their aggregate concurrency while
        // allowing independent files to use the four local execution slots.
        maxWorkers: 4,
        // Prior-duration ordering clusters subprocess-heavy files and increases I/O contention.
        // Keep scheduling independent of earlier runs; transformed modules remain cached.
        cache: false,
        allowOnly: false,
        setupFiles: ['packages/cockpit/src/test-support/git-isolation.ts'],
        // Real process and filesystem integration needs a larger budget than in-memory tests.
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
})
