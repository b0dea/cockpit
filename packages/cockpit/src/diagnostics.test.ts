import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderHumanDiagnostics, renderHumanValue, renderJsonResponse } from './diagnostics.js'

describe('diagnostic envelope', () => {
    it('explains the common refusal families as what failed, why it matters, and how to fix it', () => {
        const codes = [
            'INIT_CANONICAL_OWNERSHIP_MISSING', 'SURFACE_SOURCE_UNAVAILABLE', 'SURFACE_OWNERSHIP_INVALID',
            'SURFACE_STATE_CONFLICT', 'GENERATED_ARTIFACT_DRIFT', 'GENERATED_OWNERSHIP_INVALID',
            'GUARD_AUTHORITY_UNAVAILABLE', 'GUARD_REFUSED', 'RUNTIME_UNAVAILABLE', 'RUNTIME_UNMEASURED',
            'CLAIM_CO_TENANT', 'PORT_FAMILY_COLLISION', 'PORT_LEASE_EXHAUSTED', 'SETUP_MANUAL_MISSING',
            'SETUP_REMOTE_MISMATCH',
        ] as const

        for (const code of codes) {
            const rendered = renderHumanDiagnostics([{ severity: 'error', code, message: 'synthetic failure', target: 'subject' }])
            expect(rendered).toContain(`ERROR ${code} [subject]\n`)
            expect(rendered).toContain('What failed: synthetic failure\n')
            expect(rendered).toMatch(/Why it matters: .+\n/)
            expect(rendered).toMatch(/Fix: .+\n/)
            // An agent followed a remedy that said to delete a file without asking anyone.
            const fix = /Fix: (.+)\n/.exec(rendered)![1]!
            if (/\b(delete|remove|rm)\b/.test(fix)) expect(fix, code).toMatch(/\bask the person\b/)
        }
        // The same holds for a fix written beside its code that hands the agent a recursive delete.
        const sources = readdirSync(new URL('.', import.meta.url), { recursive: true, encoding: 'utf8' })
            .filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'))
            .map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
        const deletions = (source: string) => [...source.matchAll(/\bfix: (`[^`]*`|'[^']*')/g)].map(match => match[1]!)
            .filter(fix => /\brm -r/.test(fix))
        // The scan must still see a recursive delete written beside its code, whether or not one ships today.
        expect(deletions("fix: 'stop the stack, then rm -rf /synthetic/state'")).toHaveLength(1)
        for (const fix of sources.flatMap(deletions)) expect(fix).toMatch(/\bask the person\b/)
    })

    it('prints the runtime measure remedy bare, since a wrapped command prompts and some agents treat a prompt as a denial', () => {
        expect(renderHumanDiagnostics([{ severity: 'error', code: 'RUNTIME_UNMEASURED', message: 'synthetic failure' }],
            undefined, { resolvedConfigPath: '/synthetic/cockpit.toml', generatedTargets: [] }))
            .toContain('Fix: run npx --no cockpit runtime measure --config /synthetic/cockpit.toml --image <local-image>, which records the result for this machine only, then retry\n')
    })

    it('summarises a successful lifecycle command and preflight in one readable line', () => {
        const stackId = `stack:${'a'.repeat(64)}`
        const review = (command: string, result: unknown) => renderHumanDiagnostics([], { command, outcome: { status: 0, result } })

        expect(review('up', { stackId, change: 'started', coldStart: { measuredMillis: 5_813, limitMillis: 120_000, headroomMillis: 114_187 },
            entrypoints: [{ name: 'api-host-port', kind: 'entrypoint', port: 'API_HOST_PORT', value: 'http://127.0.0.1:4200/' }] }))
            .toBe(`Stack started (${stackId}); cold start 5.8s of the 120s limit.\n  api-host-port: http://127.0.0.1:4200/\n`)
        expect(review('up', { stackId, change: 'unchanged', entrypoints: [] })).toBe(`Stack already running (${stackId}).\n`)
        expect(review('preflight', { verdict: 'pass', revision: 'r', comparisons: [],
            checks: [{ verdict: 'pass' }, { verdict: 'pass' }, { verdict: 'not-applicable' }] }))
            .toBe('Preflight passed: 2 checks pass, 1 not applicable.\n')
        expect(review('sleep', { stackId, change: 'retained' }))
            .toBe(`Released this checkout's hold; another holder keeps the stack running (${stackId}).\n`)
        expect(review('sleep', { stackId, change: 'stopped' })).toBe(`Stack stopped (${stackId}).\n`)
        expect(review('down', { stackId, change: 'removed' })).toBe(`Stack removed (${stackId}).\n`)
        expect(review('reset', { stackId, planDigest: 'd'.repeat(64), targets: [], noop: true }))
            .toBe(`Nothing to reset (${stackId}).\n`)
        expect(review('reset', { stackId, planDigest: 'd'.repeat(64), noop: false, targets: [
            { kind: 'volume', identity: 'demo-1a2b_data', declaration: 'data' },
            { kind: 'container', identity: 'demo-1a2b-api-1', declaration: 'demo-1a2b-api-1' },
        ] })).toBe(`Reset would remove 2 targets (${stackId}); plan ${'d'.repeat(64)}:\n`
            + '  volume demo-1a2b_data (data)\n  container demo-1a2b-api-1\n'
            + 'Nothing was changed. To apply this plan, run the same command with --interactive and approve it.\n')
        expect(review('reset', { stackId, change: 'reset', targets: [{ kind: 'volume', identity: 'demo-1a2b_data', declaration: 'data' }] }))
            .toBe(`Reset removed 1 target (${stackId}):\n  volume demo-1a2b_data (data)\n`
                + 'The next up recreates the removed volumes and, where environment.seed is declared, runs the seed to fill them.\n')
        expect(review('reset', { stackId, change: 'unchanged' })).toBe(`Nothing to reset (${stackId}).\n`)
        // A result outside the known shape prints nothing rather than a guess.
        expect(review('up', { stackId, change: 'invented' })).toBe('')
    })

    it('prints the result of a work, grade, browser or test command, including one that did not meet its bar', () => {
        const review = (command: string, status: number, result: unknown) => renderHumanDiagnostics([], { command, outcome: { status, result } })
        expect(review('test-run', 0, { verdict: 'PASS', satisfiesGate: true })).toBe('satisfiesGate: true\nverdict: PASS\n')
        expect(review('work grade', 2, { criteria: [{ id: 'AC1', verdict: 'unmet' }] })).toBe('criteria:\n  -\n    id: AC1\n    verdict: unmet\n')
        expect(review('grade', 0, { criteria: [{ id: 'AC1', verdict: 'met' }] })).toBe('criteria:\n  -\n    id: AC1\n    verdict: met\n')
        expect(review('browser drive', 0, { kind: 'complete' })).toBe('kind: complete\n')
        expect(review('sync', 2, { dryRun: true, changes: [] })).toBe('')
    })

    it.each(['constructor', 'toString'])('treats inherited object keys such as %s as unregistered diagnostics', (code) => {
        expect(renderHumanDiagnostics([{ severity: 'error', code, message: 'synthetic failure' }]))
            .toBe(`ERROR ${code}: synthetic failure\n`)
    })

    it('renders nested human review data as terminal-safe text rather than JSON', () => {
        const rendered = renderHumanValue({ verdict: 'pass', checks: [{ code: 'READY', detail: 'safe\u202e' }] })

        expect(rendered).toBe('checks:\n  -\n    code: READY\n    detail: safe\\u202e\nverdict: pass\n')
        expect(rendered).not.toContain('{')
        expect(rendered).not.toContain('}')
        expect(rendered).not.toContain('"verdict"')
    })

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
        for (const command of ['doctor', 'selftest', 'sync', 'init']) {
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
            message: 'Owned artifact differs', target: 'fixtures/personas.generated.ts', fix: 'run npx --no cockpit sync --config <your cockpit.toml>' })
        const context = { resolvedConfigPath: '/workspace/demo config.toml', generatedTargets: ['fixtures/personas.generated.ts'] }
        const outcome = { result: { resolvedConfigPath: context.resolvedConfigPath }, diagnostics: [diagnostic] }
        const command = "npx --no cockpit sync --config '/workspace/demo config.toml'"
        expect(JSON.parse(renderJsonResponse(outcome, context))).toEqual({ result: outcome.result,
            diagnostics: [{ ...diagnostic, fix: command }] })
        expect(renderHumanDiagnostics([diagnostic], undefined, context)).toBe(
            'ERROR GENERATED_ARTIFACT_DRIFT [fixtures/personas.generated.ts]\n'
            + 'What failed: Owned artifact differs\n'
            + 'Why it matters: generated files no longer match the canonical cockpit configuration\n'
            + `Fix: ${command}\n`,
        )
        const unbound = JSON.parse(renderJsonResponse(outcome))
        expect(unbound.diagnostics[0]).not.toHaveProperty('fix')
        expect(unbound.guidance).toEqual([{ code: diagnostic.code, target: diagnostic.target, text: diagnostic.fix }])
        expect(diagnostic.fix).toBe('run npx --no cockpit sync --config <your cockpit.toml>')
    })
})
