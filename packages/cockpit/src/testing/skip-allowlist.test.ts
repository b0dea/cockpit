import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const vitest = join(REPO, 'node_modules/vitest/vitest.mjs')
const reporter = join(REPO, 'scripts/skip-allowlist-reporter.mjs')

describe('skip allowlist reporter', () => {
    it('fails a run containing a skipped or todo test that is not on the allowlist, unless a name filter chose the skips', () => {
        const scratch = mkdtempSync(join(tmpdir(), 'cockpit-skip-allowlist-'))
        const run = (...args: string[]) => spawnSync(process.execPath, [vitest, 'run', '--root', scratch, '--reporter', reporter, ...args], { encoding: 'utf8' })
        try {
            writeFileSync(join(scratch, 'ok.test.ts'), "import { it } from 'vitest'; it('runs', () => {})\n")
            const clean = run()
            expect(clean.status, clean.stdout + clean.stderr).toBe(0)

            writeFileSync(join(scratch, 'hidden.test.ts'),
                "import { it } from 'vitest'; it.skip('is skipped without a reason', () => {}); it.todo('is a todo')\n")
            const hidden = run()
            expect(hidden.status).toBe(1)
            expect(hidden.stdout + hidden.stderr).toContain('SKIPPED_TEST_NOT_ALLOWED')
            expect(hidden.stdout + hidden.stderr).toContain('hidden.test.ts > is skipped without a reason')
            expect(hidden.stdout + hidden.stderr).toContain('hidden.test.ts > is a todo')

            expect(run('-t', 'runs').status).toBe(0)
        } finally {
            rmSync(scratch, { recursive: true, force: true })
        }
    })
})
