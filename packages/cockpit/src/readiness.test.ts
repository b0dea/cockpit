import { describe, expect, it } from 'vitest'
import { diagnosticInventory } from '../../../scripts/docs-lint.mjs'
import { READINESS_CATALOGUE, readinessReport } from './readiness.js'

describe('readiness catalogue', () => {
    // The catalogue explains prerequisites; it must never name a code nothing emits, or call a
    // prerequisite required while no command refuses without it.
    it('names only emitted codes, and each required prerequisite is refused by the command it names', () => {
        const inventory = diagnosticInventory(process.cwd(), 'HEAD') as {
            owners: ReadonlyMap<string, unknown>
            commandDiagnostics: ReadonlyMap<string, ReadonlySet<string>>
        }
        for (const entry of READINESS_CATALOGUE) {
            for (const code of entry.codes) expect(inventory.owners.has(code), `${entry.id}: ${code}`).toBe(true)
            if (entry.level === 'recommended') {
                expect(entry.refusedBy, entry.id).toBeUndefined()
                continue
            }
            expect(entry.refusedBy, entry.id).toBeDefined()
            expect(entry.codes, entry.id).toContain(entry.refusedBy!.code)
            expect(inventory.commandDiagnostics.get(entry.refusedBy!.command)?.has(entry.refusedBy!.code),
                `${entry.id}: ${entry.refusedBy!.command} ${entry.refusedBy!.code}`).toBe(true)
        }
    })

    it('groups reported diagnostics under the prerequisite they name and keeps their own fix', () => {
        const report = readinessReport('surfaces-only', [
            { severity: 'error', code: 'GIT_STATE_UNHEALTHY', message: 'no commits yet', target: 'cockpit.toml', fix: 'commit it' },
            { severity: 'warning', code: 'COCKPIT_NOT_INSTALLED', message: 'not installed' },
            { severity: 'info', code: 'ENVIRONMENT_NOT_DECLARED', message: 'no runtime' },
        ])
        expect(report.gaps.map(({ id }) => id)).toEqual(['cockpit-committed', 'cockpit-installed'])
        expect(report.gaps[0]!.findings).toEqual([{ code: 'GIT_STATE_UNHEALTHY', severity: 'error', target: 'cockpit.toml',
            message: 'no commits yet', fix: 'commit it' }])
        expect(report.gaps[1]!.findings[0]!.fix).toBe(READINESS_CATALOGUE.find(({ id }) => id === 'cockpit-installed')!.fix)
        // A runtime prerequisite does not apply where none is declared.
        expect(report.noFinding).not.toContain('machine-floor')
        expect(report.noFinding).toContain('siblings-present')
    })
})
