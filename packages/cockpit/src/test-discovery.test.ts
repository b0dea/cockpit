import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const config = join(repoRoot, 'vitest.config.ts')
const vitest = join(repoRoot, 'node_modules/vitest/vitest.mjs')

describe('test discovery stays inside package roots', () => {
    it('includes package tests without collecting tests from a nested linked checkout', () => {
        const scratch = mkdtempSync(join(tmpdir(), 'cockpit-test-discovery-'))
        const included = join(scratch, 'packages/example/src/included.test.ts')
        const nested = join(scratch, '.nested-checkout/probe/packages/example/src/nested.test.ts')

        try {
            mkdirSync(join(included, '..'), { recursive: true })
            mkdirSync(join(nested, '..'), { recursive: true })
            writeFileSync(included, "import { it } from 'vitest'; it('included', () => {})\n")
            writeFileSync(nested, "import { it } from 'vitest'; it('nested', () => {})\n")

            const listed = execFileSync(process.execPath, [vitest, 'list', '--root', scratch, '--config', config], {
                encoding: 'utf8',
            })

            expect(listed).toContain('packages/example/src/included.test.ts')
            expect(listed).not.toContain('nested.test.ts')
        } finally {
            rmSync(scratch, { recursive: true, force: true })
        }
    })

    // A renamed test left the changed-test runner mapping every changeset to a file that no longer
    // existed, so test:changed refused any branch carrying one.
    it('names only existing test files as the changed-test runner\'s fixed owners', () => {
        const runner = readFileSync(join(repoRoot, 'scripts/run-changed-tests.mjs'), 'utf8')
        const named = [...runner.matchAll(/'([a-z0-9.-]+\.test\.ts)'/g)].map(match => match[1]!)
        expect(named.length).toBeGreaterThan(0)
        expect(named.filter(name => !existsSync(join(repoRoot, 'packages/cockpit/src', name)))).toEqual([])
    })
})
