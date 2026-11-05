import { describe, expect, it } from 'vitest'
import { diagnosticInventory } from '../../../scripts/diagnostic-inventory.ts'
import { commands } from './command-table.js'
import { READINESS_CATALOGUE, readinessReport } from './readiness.js'

describe('readiness catalogue', () => {
    // The catalogue explains prerequisites; it must never name a code nothing emits, or call a
    // prerequisite required without naming the code that refuses without it.
    it('names only emitted codes, and each required prerequisite names the code that refuses it', () => {
        const inventory = diagnosticInventory(process.cwd())
        for (const entry of READINESS_CATALOGUE) {
            for (const code of entry.codes) expect(inventory.owners.has(code), `${entry.id}: ${code}`).toBe(true)
            if (entry.level === 'recommended') {
                expect(entry.refusedBy, entry.id).toBeUndefined()
                continue
            }
            expect(entry.refusedBy, entry.id).toBeDefined()
            expect(entry.codes, entry.id).toContain(entry.refusedBy!.code)
            expect(commands.map(command => command.handler), entry.id).toContain(entry.refusedBy!.command)
        }
    })

    it('rates an absent optional tool below a schema that fails, on either kind of cockpit', () => {
        const report = readinessReport('surfaces-only', [
            { severity: 'error', code: 'ENV_SCHEMA_UNHEALTHY', message: 'schema failed' },
            { severity: 'warning', code: 'ENV_SCHEMA_TOOL_MISSING', message: 'no varlock' },
        ], [])
        expect(report.gaps.map(({ id, level }) => [id, level])).toEqual([['env-schema', 'required'], ['env-schema-tool', 'recommended']])
        expect(readinessReport('surfaces-only', [], []).noFinding).toEqual(expect.arrayContaining(['env-schema', 'env-schema-tool']))
    })

    it('groups reported diagnostics under the prerequisite they name and keeps their own fix', () => {
        const report = readinessReport('surfaces-only', [
            { severity: 'error', code: 'GIT_STATE_UNHEALTHY', message: 'no commits yet', target: 'cockpit.toml', fix: 'commit it' },
            { severity: 'warning', code: 'COCKPIT_NOT_INSTALLED', message: 'not installed' },
            { severity: 'info', code: 'ENVIRONMENT_NOT_DECLARED', message: 'no runtime' },
        ], ['claudecode', 'codexcli', 'opencode'])
        expect(report.gaps.map(({ id }) => id)).toEqual(['cockpit-committed', 'cockpit-installed'])
        expect(report.gaps[0]!.findings).toEqual([{ code: 'GIT_STATE_UNHEALTHY', severity: 'error', target: 'cockpit.toml',
            message: 'no commits yet', fix: 'commit it' }])
        expect(report.gaps[1]!.findings[0]!.fix).toBe(READINESS_CATALOGUE.find(({ id }) => id === 'cockpit-installed')!.fix)
        // A runtime prerequisite does not apply where none is declared.
        expect(report.noFinding).not.toContain('machine-floor')
        expect(report.noFinding).toContain('siblings-present')
        // A prerequisite of one tool is reported only while that tool is listed.
        expect(report.noFinding).toContain('codex-hook-trusted')
        expect(readinessReport('surfaces-only', [], ['claudecode']).noFinding).not.toContain('codex-hook-trusted')
    })
})
