import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
