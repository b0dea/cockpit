import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decide, effectivePolicy, policyWeakening, readRecordedPolicy, trustInForce, writeRecordedPolicy } from './autonomy.js'
import { Autonomy, Environment, Work } from './schema.js'

const policy = (autonomy: Record<string, string> = {}, work: Record<string, unknown> = {}) => effectivePolicy({ work: Work.parse(work), autonomy: Autonomy.parse(autonomy) })

describe('autonomy policy', () => {
    it('defaults every decision to an agent but reset and MCP approval, and a declared field overrides its default', () => {
        expect(policy()).toEqual({ grading: 'independent', gates: { accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'agent', acknowledge: 'agent' },
            autonomy: { sync: 'agent', stale_delete: 'agent', reset: 'person', mcp_approve: 'person' } })
        expect(policy({ reset: 'ci' }, { gates: { signoff: 'person', acknowledge: 'person' } })).toEqual({ grading: 'independent',
            gates: { accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'person', acknowledge: 'person' },
            autonomy: { sync: 'agent', stale_delete: 'agent', reset: 'ci', mcp_approve: 'person' } })
    })

    it('holds a trust answer no person confirmed at the stronger default, and releases it once it leaves unconfirmed', () => {
        const environment = Environment.parse({ install_policies: [{ toolchain: 'node', lockfile: 'package-lock.json', build: ['npm', 'run', 'build'] }] })
        const declared = { work: Work.parse({ grading: 'off' }), autonomy: Autonomy.parse({}), environment }
        const waiting = { ...declared, unconfirmed: ['work.grading', 'environment.install_policies', 'guards'] as const }
        expect(effectivePolicy(waiting).grading).toBe('independent')
        expect(trustInForce(waiting)).toEqual({ grading: 'independent', installPolicies: [], held: [
            { field: 'work.grading', declared: 'off', inForce: 'independent' }, { field: 'environment.install_policies', declared: '1 policy', inForce: 'none' }] })
        expect(effectivePolicy(declared).grading).toBe('off')
        expect(trustInForce(declared)).toEqual({ grading: 'off', installPolicies: environment.install_policies, held: [] })
    })

    it('passes ci only where CI is set, and never passes person', () => {
        expect([decide('agent', {}), decide('person', { CI: 'true' }), decide('ci', {}), decide('ci', { CI: 'false' }), decide('ci', { CI: 'true' })])
            .toEqual(['proceed', 'person', 'ci-only', 'ci-only', 'proceed'])
    })

    it('names every field moved toward the agent, and none moved away from it', () => {
        const strict = policy({ sync: 'ci' }, { grading: 'independent', gates: { signoff: 'person', accept: 'person' } })
        const loose = policy({ sync: 'person' }, { grading: 'self', gates: { signoff: 'agent', accept: 'ci' } })
        expect(policyWeakening(strict, loose)).toEqual([
            { field: 'work.grading', from: 'independent', to: 'self' },
            { field: 'work.gates.signoff', from: 'person', to: 'agent' },
            { field: 'autonomy.sync', from: 'ci', to: 'person' },
        ])
        expect(policyWeakening(loose, strict)).toEqual([{ field: 'work.gates.accept', from: 'ci', to: 'person' }])
    })

    it('ranks a relayed subagent verdict with the agent\'s own, and off below both, so reaching either from a stronger mode is a weakening', () => {
        const at = (grading: string) => policy({}, { grading })
        const weakening = (from: string, to: string) => policyWeakening(at(from), at(to)).map(row => row.field)
        for (const [from, to] of [['independent', 'subagent'], ['checks', 'subagent'], ['independent', 'off'], ['checks', 'off'], ['self', 'off'], ['subagent', 'off']]) {
            expect(weakening(from!, to!), `${from} to ${to}`).toEqual(['work.grading'])
        }
        for (const [from, to] of [['self', 'subagent'], ['subagent', 'self'], ['subagent', 'checks'], ['subagent', 'independent'], ['off', 'self'], ['off', 'independent']]) {
            expect(weakening(from!, to!), `${from} to ${to}`).toEqual([])
        }
    })

    it('records the accepted policy and refuses a record it cannot read', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-policy-'))
        try {
            expect(await readRecordedPolicy(root)).toBeUndefined()
            await writeRecordedPolicy(root, policy({ reset: 'ci' }))
            expect(await readRecordedPolicy(root)).toEqual(policy({ reset: 'ci' }))
            const malformed = /not a cockpit-policy\/v1 record .*git restore -- \.cockpit\/policy\.json, or if that copy is the damaged one, a person deletes/
            writeFileSync(join(root, '.cockpit/policy.json'), JSON.stringify({ format: 'cockpit-policy/v1', policy: { ...policy(), grading: 'lenient' } }))
            await expect(readRecordedPolicy(root)).rejects.toThrow(malformed)
            writeFileSync(join(root, '.cockpit/policy.json'), JSON.stringify({ format: 'cockpit-policy/v1', policy: { ...policy(), gates: { ...policy().gates, merge: 'agent' } } }))
            await expect(readRecordedPolicy(root)).rejects.toThrow(malformed)
        } finally { rmSync(root, { recursive: true }) }
    })

    it('reads a record from before a gate existed with that gate at person, so the new default reports as a weakening a sync can record', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-policy-'))
        try {
            // The record 0.1.0 wrote, before [work.gates] acknowledge existed.
            mkdirSync(join(root, '.cockpit'))
            writeFileSync(join(root, '.cockpit/policy.json'), JSON.stringify({ format: 'cockpit-policy/v1', policy: { grading: 'independent',
                gates: { accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'agent' }, autonomy: { sync: 'agent', stale_delete: 'agent', reset: 'person', mcp_approve: 'person' } } }))
            const recorded = (await readRecordedPolicy(root))!
            expect(recorded.gates.acknowledge).toBe('person')
            expect(policyWeakening(recorded, policy())).toEqual([{ field: 'work.gates.acknowledge', from: 'person', to: 'agent' }])
            // What a person's sync --interactive records once they accept it.
            await writeRecordedPolicy(root, policy())
            expect(await readRecordedPolicy(root)).toEqual(policy())
        } finally { rmSync(root, { recursive: true }) }
    })
})
