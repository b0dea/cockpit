import { describe, expect, it } from 'vitest'
import { renderHumanDiagnostics, renderJsonResponse } from './diagnostics.js'

describe('diagnostic envelope', () => {
    it('preserves partial lifecycle progress in a JSON refusal', () => {
        const progress = { applied: ['publication', 'generated'], attempted: ['dependency:app:load'], notApplied: ['dependencies', 'data', 'seeded'] }
        const outcome = { result: null, diagnostics: [{ severity: 'error' as const,
            code: 'EXECUTION_STEP_FAILED' as const, message: 'dependency command failed' }], progress }
        expect(JSON.parse(renderJsonResponse(outcome))).toEqual(outcome)
    })

    it('escapes hostile diagnostic identities and every human review surface', () => {
        const hostile = '\u001b\n\r\0\u0085\u202e\u2028\u2066'
        const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/
        const diagnostic = { severity: 'error' as const, code: `CODE${hostile}`, message: hostile,
            target: hostile, fix: hostile }
        const rendered = renderHumanDiagnostics([diagnostic])
        expect(rendered.slice(0, -1)).not.toMatch(unsafe)
        expect(rendered).toContain('CODE\\u001b\\n\\r\\u0000\\u0085\\u202e\\u2028\\u2066')
        for (const command of ['doctor', 'selftest', 'upgrade', 'sync', 'init']) {
            const review = renderHumanDiagnostics([], { command, outcome: { status: 0,
                result: { path: hostile, dryRun: true, changes: [{ operation: 'write', path: hostile }] } } })
            expect(review).toContain('\\u202e')
            expect(review.replaceAll('\n', '')).not.toMatch(unsafe)
        }
    })

    it('emits one terminal-safe JSON document with invocation and producer evidence intact', () => {
        const outcome = { result: { value: '\u009b\u202e\u2028' }, diagnostics: [],
            invocation: { verb: 'check', durationMs: 17, exitCode: 2 as const, resolvedConfigPath: '/workspace/cockpit.toml' } }
        const rendered = renderJsonResponse(outcome)
        expect(rendered.split('\n')).toHaveLength(2)
        expect(rendered).not.toMatch(/[\u007f-\u009f\u2028-\u202e]/)
        expect(JSON.parse(rendered)).toEqual(outcome)
    })

    it('preserves unregistered remedies as guidance without granting execution or mutating producers', () => {
        const diagnostic = Object.freeze({ severity: 'error' as const, code: 'UNKNOWN', message: 'Cannot continue',
            target: 'app', fix: 'Review the file\nthen ask\u202e' })
        const outcome = { result: null, diagnostics: [diagnostic, diagnostic] }
        expect(JSON.parse(renderJsonResponse(outcome))).toEqual({ result: null,
            diagnostics: [{ severity: 'error', code: 'UNKNOWN', message: 'Cannot continue', target: 'app' }],
            guidance: [{ code: 'UNKNOWN', target: 'app', text: 'Review the file\nthen ask\u202e' }] })
        expect(renderHumanDiagnostics(outcome.diagnostics)).toBe(
            'ERROR UNKNOWN [app]: Cannot continue Guidance: Review the file\\nthen ask\\u202e\n',
        )
        expect(diagnostic.fix).toBe('Review the file\nthen ask\u202e')
    })

    it('projects the same exact admitted command in human and JSON output only with explicit bound inputs', () => {
        const diagnostic = Object.freeze({ severity: 'error' as const, code: 'GENERATED_ARTIFACT_DRIFT',
            message: 'Owned artifact differs', target: 'fixtures/personas.generated.ts', fix: 'run cockpit sync --config <file>' })
        const context = { resolvedConfigPath: '/workspace/demo config.toml', generatedTargets: ['fixtures/personas.generated.ts'] }
        const outcome = { result: { resolvedConfigPath: context.resolvedConfigPath }, diagnostics: [diagnostic] }
        const command = "cockpit sync --config '/workspace/demo config.toml'"
        expect(JSON.parse(renderJsonResponse(outcome, context))).toEqual({ result: outcome.result,
            diagnostics: [{ ...diagnostic, fix: command }] })
        expect(renderHumanDiagnostics([diagnostic], undefined, context)).toBe(
            `ERROR GENERATED_ARTIFACT_DRIFT [fixtures/personas.generated.ts]: Owned artifact differs Fix: ${command}\n`,
        )
        const unbound = JSON.parse(renderJsonResponse(outcome))
        expect(unbound.diagnostics[0]).not.toHaveProperty('fix')
        expect(unbound.guidance).toEqual([{ code: diagnostic.code, target: diagnostic.target, text: diagnostic.fix }])
        expect(diagnostic.fix).toBe('run cockpit sync --config <file>')
    })
})
