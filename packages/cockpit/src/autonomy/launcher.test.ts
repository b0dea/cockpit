import { describe, expect, it } from 'vitest'
import { issueResolvedAutonomyGrants, planAutonomyLaunch } from './launcher.js'

const input = () => ({ target: 'claudecode', nativeReads: ['Read', 'Glob', 'Grep'],
    cockpitInvocations: [{ executable: '/workspace/bin/cockpit', cwd: '/workspace/product', argv: ['check'] }],
    projectCommands: [{ executable: 'npm', checkoutRoot: '/workspace/product', kind: 'test', argv: ['test', '--', 'specific.test.ts'] }],
    guardRegistration: { registered: true, wiring: {
        target: 'claudecode', version: '2.1.220', executable: '/workspace/bin/claude', executableSha256: 'a'.repeat(64), generatedManifestSha256: 'b'.repeat(64),
        hook: { path: '.cockpit/guards/bash-guard.sh', sha256: 'c'.repeat(64) },
        handler: { path: 'bin/cockpit', sha256: 'd'.repeat(64) },
        registration: { path: '.claude/settings.json', sha256: 'e'.repeat(64) },
        handlerArgv: ['guard-evaluate', '--harness', 'claudecode'],
    } } })

describe('application-issued autonomy representation', () => {
    it('issues literal project tuple words independently of permission-family restrictions', () => {
        for (const executable of ['npm', 'build tool', 'tool*?[];literal']) {
            const source = input()
            source.projectCommands[0]!.executable = executable
            source.projectCommands[0]!.argv = ['*', '**', '?', '[', ']', 'file[1]?.txt']
            const grants = issueResolvedAutonomyGrants(source)
            expect(grants?.projectCommands, executable).toEqual(source.projectCommands)
            expect(planAutonomyLaunch(grants)).toMatchObject({ kind: 'complete', guardRequired: true })
            source.projectCommands[0]!.argv[0] = 'changed'
            expect(grants?.projectCommands[0]?.argv[0]).toBe('*')
            expect(Object.isFrozen(grants?.projectCommands[0]?.argv)).toBe(true)
            expect(planAutonomyLaunch({ ...grants })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_GRANTS_INVALID' })
            expect(issueResolvedAutonomyGrants({ ...input(), cockpitInvocations: [{ executable, cwd: '/workspace/product', argv: ['*'] }] })).toBeUndefined()
        }
        for (const executable of ['a'.repeat(129), '\x80', '\ud800']) {
            expect(issueResolvedAutonomyGrants({ ...input(), projectCommands: [{ ...input().projectCommands[0], executable }] })).toBeUndefined()
        }
    })
    it('preserves bounded scalar project tuples and refuses controls or setup-only oversized argv', () => {
        const source = input()
        source.projectCommands[0]!.argv = ['😀'.repeat(128), "'".repeat(128)]
        const issued = issueResolvedAutonomyGrants(source)
        expect(issued?.projectCommands[0]?.argv).toEqual(source.projectCommands[0]!.argv)
        for (const argv of [['\x80'], ['\ud800'], ['a'.repeat(129)], Array(32).fill('x')]) {
            expect(issueResolvedAutonomyGrants({ ...input(), projectCommands: [{ ...input().projectCommands[0], argv }] }), JSON.stringify(argv)).toBeUndefined()
        }
        expect(planAutonomyLaunch({ ...issued })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_GRANTS_INVALID' })
    })
    it('defaults to ordinary and represents only captured exact grants with every protection active', () => {
        const source = input()
        const grants = issueResolvedAutonomyGrants(source)
        expect(grants).toBeDefined()
        source.cockpitInvocations[0]!.argv[0] = 'destroy'
        const result = planAutonomyLaunch(grants)
        expect(result).toMatchObject({ kind: 'complete', mode: 'ordinary', target: 'claudecode', guardRequired: true,
            capability: 'instructed', permissionGrants: { nativeReads: ['Read', 'Glob', 'Grep'],
                cockpitInvocations: [{ executable: '/workspace/bin/cockpit', cwd: '/workspace/product', argv: ['check'] }] } })
        if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
        expect(result.activeProtections).toEqual(['hard-deny evaluation', 'always-run guard', 'native ask or ask-to-deny', 'exact invocation grants', 'read-only instructions'])
        expect(Object.isFrozen(result.permissionGrants.cockpitInvocations[0]!.argv)).toBe(true)
        expect(planAutonomyLaunch({ ...grants })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_GRANTS_INVALID' })
    })

    it('refuses missing/unknown explicit modes, absent registration, invalid spellings and family wildcards', () => {
        const grants = issueResolvedAutonomyGrants(input())
        for (const options of [{ mode: 'unknown' }, { mode: null }, { mode: undefined }, { mode: '' }]) {
            expect(planAutonomyLaunch(grants, options)).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_MODE_INVALID' })
        }
        expect(issueResolvedAutonomyGrants({ ...input(), nativeReads: ['Bash(*)'] })).toBeUndefined()
        expect(issueResolvedAutonomyGrants({ ...input(), target: 'codexcli' })).toBeUndefined()
        expect(issueResolvedAutonomyGrants({ ...input(), guardRegistration: { registered: false } })).toBeUndefined()
        expect(issueResolvedAutonomyGrants({ ...input(), cockpitInvocations: [{ executable: 'git', cwd: '/workspace/product', argv: ['*'] }] })).toBeUndefined()
        expect(issueResolvedAutonomyGrants({ ...input(), policy: {} })).toBeUndefined()
        let reads = 0
        const accessor = Object.defineProperty(input(), 'projectCommands', { enumerable: true, get() { reads++; return [] } })
        expect(issueResolvedAutonomyGrants(accessor)).toBeUndefined()
        expect(reads).toBe(0)
        expect(planAutonomyLaunch(grants, { mode: 'ordinary', explicitEscalation: true })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_MODE_INVALID' })
    })

    it('requires an explicit escalation flag and authenticated current exact evidence', () => {
        const grants = issueResolvedAutonomyGrants(input())
        expect(planAutonomyLaunch(grants, { mode: 'escalated' })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_ESCALATION_REQUIRED' })
        expect(planAutonomyLaunch(grants, { mode: 'escalated', explicitEscalation: true })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_EVIDENCE_REQUIRED' })
        expect(planAutonomyLaunch(grants, { mode: 'escalated', explicitEscalation: true, evidence: { kind: 'validated' } })).toMatchObject({ kind: 'refusal', code: 'AUTONOMY_EVIDENCE_REQUIRED' })
    })
})
