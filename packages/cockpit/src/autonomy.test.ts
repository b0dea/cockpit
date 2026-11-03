import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decide, effectivePolicy, policyWeakening, readRecordedPolicy, writeRecordedPolicy } from './autonomy.js'
import { Autonomy, Work } from './schema.js'

const policy = (autonomy: Record<string, string> = {}, work: Record<string, unknown> = {}) => effectivePolicy({ work: Work.parse(work), autonomy: Autonomy.parse(autonomy) })

describe('autonomy policy', () => {
    it('defaults every decision to an agent but reset and MCP approval, and a declared field overrides its default', () => {
        expect(policy()).toEqual({ grading: 'independent', gates: { accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'agent' },
            autonomy: { sync: 'agent', stale_delete: 'agent', reset: 'person', mcp_approve: 'person' } })
        expect(policy({ reset: 'ci' }, { gates: { signoff: 'person' } })).toEqual({ grading: 'independent',
            gates: { accept: 'agent', amend: 'agent', answer: 'agent', signoff: 'person' },
            autonomy: { sync: 'agent', stale_delete: 'agent', reset: 'ci', mcp_approve: 'person' } })
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

    it('records the accepted policy and refuses a record it cannot read', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-policy-'))
        try {
            expect(await readRecordedPolicy(root)).toBeUndefined()
            await writeRecordedPolicy(root, policy({ reset: 'ci' }))
            expect(await readRecordedPolicy(root)).toEqual(policy({ reset: 'ci' }))
            writeFileSync(join(root, '.cockpit/policy.json'), JSON.stringify({ format: 'cockpit-policy/v1', policy: { ...policy(), grading: 'lenient' } }))
            await expect(readRecordedPolicy(root)).rejects.toThrow(/not a cockpit-policy\/v1 record; restore it/)
        } finally { rmSync(root, { recursive: true }) }
    })
})
