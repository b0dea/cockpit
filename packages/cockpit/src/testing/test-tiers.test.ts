import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// vitest.config.ts routes this name to the slow project.
const SLOW_TEST_PATH = /\.slow\.test\.ts$/
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
// This file names the mechanisms in its synthetic cases.
const SELF = relative(ROOT, fileURLToPath(import.meta.url))

// Mechanisms whose cost is set by the outside world rather than by the code under test. A test
// file that uses one belongs in the slow tier, which `npm run test:fast` skips. A file can also be
// slow from many short subprocesses, which no source pattern shows;
// that half of the rule is a review judgment, measured as described in docs/contributing/testing.md.
const SLOW_MECHANISMS = [
    ['packs or installs a package with npm', /['"]npm['"],\s*\[\s*['"](?:pack|install|ci)['"](?![^\]]*['"]--dry-run['"])/],
    ['runs the host Docker', /resolveDockerExecutable\(\s*(?:process\.env\b|\{\s*PATH:\s*process\.env\.PATH\b)|['"]which['"],\s*\[\s*['"]docker['"]/],
] as const

function slowMechanisms(source: string): string[] {
    return SLOW_MECHANISMS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name)
}

function packageTests(directory = join(ROOT, 'packages')): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name === 'dist') return []
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return packageTests(path)
        return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [relative(ROOT, path)] : []
    })
}

describe('test tiers', () => {
    it('keeps every test that packs, installs or runs the host Docker in a .slow.test.ts file', () => {
        const tests = packageTests()
        expect(tests.filter((path) => SLOW_TEST_PATH.test(path)).length, 'no slow tier exists to defer').toBeGreaterThan(0)

        const misplaced = tests.filter((path) => !SLOW_TEST_PATH.test(path) && path !== SELF)
            .flatMap((path) => slowMechanisms(readFileSync(join(ROOT, path), 'utf8')).map((mechanism) => `${path} ${mechanism}`))

        expect(misplaced).toEqual([])
    })

    it('recognises each slow mechanism and leaves a dry-run pack in the fast tier', () => {
        expect(slowMechanisms("execFileSync('npm', ['pack', '--ignore-scripts', '--json'])")).toEqual(['packs or installs a package with npm'])
        expect(slowMechanisms("execFileSync('npm', ['ci', '--ignore-scripts'])")).toEqual(['packs or installs a package with npm'])
        expect(slowMechanisms("execFileSync('npm', ['pack', '--dry-run', '--json'])")).toEqual([])
        expect(slowMechanisms('const docker = await resolveDockerExecutable(process.env)')).toEqual(['runs the host Docker'])
        expect(slowMechanisms("execFileSync('which', ['docker'])")).toEqual(['runs the host Docker'])
        expect(slowMechanisms('await resolveDockerExecutable({ PATH: root })')).toEqual([])
    })
})
