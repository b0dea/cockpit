import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const config = join(repoRoot, 'vitest.config.ts')
const vitest = join(repoRoot, 'node_modules/vitest/vitest.mjs')

describe('test discovery stays inside package roots', () => {
    it('includes package tests in the fast or slow project by name without collecting tests from a nested linked checkout', () => {
        const scratch = mkdtempSync(join(tmpdir(), 'cockpit-test-discovery-'))
        const included = join(scratch, 'packages/example/src/included.test.ts')
        const slow = join(scratch, 'packages/example/src/included.slow.test.ts')
        const nested = join(scratch, '.nested-checkout/probe/packages/example/src/nested.test.ts')

        try {
            mkdirSync(join(included, '..'), { recursive: true })
            mkdirSync(join(nested, '..'), { recursive: true })
            writeFileSync(included, "import { it } from 'vitest'; it('included', () => {})\n")
            writeFileSync(slow, "import { it } from 'vitest'; it('slow', () => {})\n")
            writeFileSync(nested, "import { it } from 'vitest'; it('nested', () => {})\n")

            const list = (...args: string[]) => execFileSync(process.execPath,
                [vitest, 'list', '--filesOnly', '--root', scratch, '--config', config, ...args], { encoding: 'utf8', cwd: scratch })

            expect(list('--project', 'fast')).toMatch(/^\[fast\] .*packages\/example\/src\/included\.test\.ts$/m)
            expect(list('--project', 'fast')).not.toContain('included.slow')
            expect(list('--project', 'slow')).toMatch(/^\[slow\] .*packages\/example\/src\/included\.slow\.test\.ts$/m)
            expect(list('--project', 'slow')).not.toContain('included.test.ts')
            expect(list()).not.toContain('nested.test.ts')
        } finally {
            rmSync(scratch, { recursive: true, force: true })
        }
    })

    // A renamed test left the changed-test runner mapping every changeset to a file that no longer
    // existed, so test:changed refused any branch carrying one.
    it('names only existing test files as the changed-test runner\'s fixed owners', () => {
        const runner = readFileSync(join(repoRoot, 'scripts/run-changed-tests.mjs'), 'utf8')
        const named = [...runner.matchAll(/\$\{SRC\}([a-z0-9.-]+\.test\.ts)/g)].map(match => match[1]!)
        expect(named.length).toBeGreaterThan(0)
        expect(named.filter(name => !existsSync(join(repoRoot, 'packages/cockpit/src', name)))).toEqual([])
    })

    // Several agent sessions share one machine, and a two-core hosted runner ran out of memory with four.
    it('caps workers at four', async () => {
        const { default: loaded } = await import(pathToFileURL(config).href) as { default: { test: { maxWorkers: number } } }
        expect(loaded.test.maxWorkers).toBeGreaterThan(0)
        expect(loaded.test.maxWorkers).toBeLessThanOrEqual(4)
    })
})
