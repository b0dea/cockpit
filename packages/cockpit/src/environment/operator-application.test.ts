import { describe, expect, it, vi } from 'vitest'
import { effectivePolicy, weakeningDigest } from '../autonomy.js'
import { Autonomy, Work } from '../schema.js'
import {
    runResetOperatorApplication,
    runSyncOperatorApplication,
    type GeneratedEnvironmentSyncHandlerInput,
} from './operator-application.js'

const policyOf = (autonomy: Record<string, string> = {}, work: Record<string, unknown> = {}) => effectivePolicy({ work: Work.parse(work), autonomy: Autonomy.parse(autonomy) })
// The policy adapter in place of cockpit.toml on disk; `record` stands for writing the recorded policy.
const policyAdapter = (current = policyOf(), recorded?: ReturnType<typeof policyOf>) => {
    const record = vi.fn(async () => {})
    return { record, load: vi.fn(async () => ({ current, ...recorded ? { recorded } : {}, record })) }
}

const preview = Object.freeze({
    kind: 'preview' as const,
    status: 0 as const,
    diagnostics: Object.freeze([]),
    result: Object.freeze({ planDigest: 'a'.repeat(64) }),
})

describe('operator application admission', () => {
    it.each([
        ['JSON', { interactive: true, json: true, ci: undefined, terminal: true }],
        ['CI', { interactive: true, json: false, ci: '1', terminal: true }],
        ['piped input', { interactive: true, json: false, ci: undefined, terminal: false }],
    ] as const)('refuses reset in %s before opening a session', async (_name, admission) => {
        const begin = vi.fn()
        const outcome = await runResetOperatorApplication(
            { configPath: '/synthetic/cockpit.toml' },
            admission,
            { preview: vi.fn(), begin, confirm: vi.fn(), policy: policyAdapter().load },
        )

        expect(outcome.status).toBe(2)
        expect(begin).not.toHaveBeenCalled()
    })

    it('uses the preview-only reset runner outside interactive mode', async () => {
        const outcome = Object.freeze({ ...preview, result: Object.freeze({ noop: true }) })
        const runPreview = vi.fn(async () => outcome)

        await expect(runResetOperatorApplication(
            { configPath: '/synthetic/cockpit.toml' },
            { interactive: false, json: false, ci: undefined, terminal: false },
            { preview: runPreview, begin: vi.fn(), confirm: vi.fn(), policy: policyAdapter().load },
        )).resolves.toBe(outcome)
        expect(runPreview).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
    })

    it('binds reset approval to the opened session preview', async () => {
        const decide = vi.fn(async () => Object.freeze({
            kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]),
            result: Object.freeze({ change: 'reset' as const }),
        }))
        const confirm = vi.fn(async (shown) => shown === preview)

        await runResetOperatorApplication(
            { configPath: '/synthetic/cockpit.toml' },
            { interactive: true, json: false, ci: undefined, terminal: true },
            { preview: vi.fn(), begin: vi.fn(async () => Object.freeze({ preview, decide })), confirm, policy: policyAdapter().load },
        )

        expect(confirm).toHaveBeenCalledWith(preview)
        expect(decide).toHaveBeenCalledWith('approve')
    })

    it('awaits reset decline cleanup before returning an empty cancelled outcome', async () => {
        let settle!: (value: typeof preview) => void
        const cleanup = new Promise<typeof preview>(resolve => { settle = resolve })
        const decide = vi.fn(() => cleanup)
        const confirm = vi.fn(async (shown) => { expect(shown).toBe(preview); return false })
        const adapters = { preview: vi.fn(), begin: vi.fn(async () => ({ preview, decide })), confirm, policy: policyAdapter().load }
        let completed = false
        const pending = runResetOperatorApplication({ configPath: '/synthetic/cockpit.toml' },
            { interactive: true, json: false, ci: undefined, terminal: true }, adapters)
            .then(outcome => { completed = true; return outcome })
        await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('decline'))
        expect(completed).toBe(false)
        settle(preview)
        expect(await pending).toEqual({ status: 130, result: null, diagnostics: [] })
        expect(decide).toHaveBeenCalledOnce()
        expect(decide).not.toHaveBeenCalledWith('approve')
    })

    it('propagates reset decline cleanup errors instead of claiming cancellation', async () => {
        const failure = new Error('synthetic cleanup failed')
        const decide = vi.fn(async () => { throw failure })
        const adapters = { preview: vi.fn(), begin: vi.fn(async () => ({ preview, decide })), confirm: async () => false, policy: policyAdapter().load }
        await expect(runResetOperatorApplication({ configPath: '/synthetic/cockpit.toml' },
            { interactive: true, json: false, ci: undefined, terminal: true }, adapters)).rejects.toBe(failure)
        expect(decide).toHaveBeenCalledWith('decline')
    })

    it('binds stale-removal approval to the exact previewed request', async () => {
        const request = {
            format: 'cockpit-stale-removal-request/v1' as const,
            cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: {
                kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2,
            } }],
            digest: 'c'.repeat(64),
        }
        const changed = { ...request, entries: [{ ...request.entries[0]!, path: 'other' }] }
        const synchronize = vi.fn(async (input: GeneratedEnvironmentSyncHandlerInput) => {
            if (input.dryRun) {
                return { status: 0, diagnostics: [], result: { dryRun: true, staleRemoval: request } }
            }
            expect(await input.authorizeStaleRemoval?.(changed)).toBeUndefined()
            expect(await input.authorizeStaleRemoval?.(request)).toEqual({
                format: 'cockpit-stale-removal-approval/v1', digest: request.digest,
            })
            return { status: 2, diagnostics: [], result: null }
        })

        await runSyncOperatorApplication(
            { configPath: 'cockpit.toml' },
            { interactive: true, json: false, ci: undefined, terminal: true },
            { synchronize, confirmStaleRemoval: async () => request.digest, policy: policyAdapter(policyOf({ stale_delete: 'person' })).load, confirmPolicyWeakening: vi.fn() },
        )

        expect(synchronize).toHaveBeenCalledTimes(2)
    })

    it('applies a reset without a person only where [autonomy] reset allows it', async () => {
        const decide = vi.fn(async () => Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]), result: null }))
        const run = (reset: string, ci?: string, recorded?: string) => {
            const begin = vi.fn(async () => Object.freeze({ preview, decide }))
            const confirm = vi.fn()
            return { begin, confirm, outcome: runResetOperatorApplication({ configPath: '/synthetic/cockpit.toml' },
                { interactive: false, apply: true, json: false, ci, terminal: false },
                { preview: vi.fn(), begin, confirm, policy: policyAdapter(policyOf({ reset }), recorded ? policyOf({ reset: recorded }) : undefined).load }) }
        }
        const agent = run('agent')
        expect((await agent.outcome).status).toBe(0)
        expect(decide).toHaveBeenCalledExactlyOnceWith('approve')
        expect(agent.confirm).not.toHaveBeenCalled()
        // cockpit.toml weakened to agent after sync recorded person: the recorded decider stands until sync accepts it.
        for (const [reset, ci, code, recorded] of [['person', undefined, 'AUTONOMY_PERSON_REQUIRED', undefined], ['ci', undefined, 'AUTONOMY_CI_ONLY', undefined],
            ['agent', undefined, 'POLICY_WEAKENING_UNCONFIRMED', 'person']] as const) {
            const refused = run(reset, ci, recorded)
            expect((await refused.outcome).diagnostics[0]?.code, reset).toBe(code)
            expect(refused.begin).not.toHaveBeenCalled()
        }
        decide.mockClear()
        expect((await run('ci', 'true').outcome).status).toBe(0)
        expect(decide).toHaveBeenCalledExactlyOnceWith('approve')
    })

    it('removes stale generated files without a person only where [autonomy] stale_delete allows it', async () => {
        const request = { format: 'cockpit-stale-removal-request/v1' as const, cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: { kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2 } }], digest: 'c'.repeat(64) }
        const approvals: unknown[] = []
        const synchronize = vi.fn(async (input: GeneratedEnvironmentSyncHandlerInput) => {
            approvals.push(await input.authorizeStaleRemoval?.(request))
            return { status: 0, diagnostics: [], result: null }
        })
        const admission = { interactive: false, json: false, ci: undefined, terminal: false }
        await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, admission,
            { synchronize, confirmStaleRemoval: vi.fn(), policy: policyAdapter(policyOf({ stale_delete: 'agent' })).load, confirmPolicyWeakening: vi.fn() })
        await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, admission,
            { synchronize, confirmStaleRemoval: vi.fn(), policy: policyAdapter(policyOf({ stale_delete: 'person' })).load, confirmPolicyWeakening: vi.fn() })
        expect(approvals).toEqual([{ format: 'cockpit-stale-removal-approval/v1', digest: request.digest }, undefined])
    })

    it('writes nothing for a policy weakened since the last sync until a person types its digest', async () => {
        const recorded = policyOf({}, { gates: { accept: 'person' } })
        const weakened = policyOf({}, { gates: { accept: 'agent' } })
        const synchronize = vi.fn(async () => ({ status: 0, diagnostics: [], result: null }))
        const quiet = policyAdapter(weakened, recorded)
        const refused = await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, { interactive: false, json: false, ci: undefined, terminal: false },
            { synchronize, confirmStaleRemoval: vi.fn(), policy: quiet.load, confirmPolicyWeakening: vi.fn() })
        expect(refused).toMatchObject({ status: 2, diagnostics: [{ code: 'POLICY_WEAKENING_UNCONFIRMED' }],
            result: { weakened: [{ field: 'work.gates.accept', from: 'person', to: 'agent' }], digest: weakeningDigest(recorded, weakened) } })
        const interactive = { interactive: true, json: false, ci: undefined, terminal: true }
        const wrong = policyAdapter(weakened, recorded)
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, interactive,
            { synchronize, confirmStaleRemoval: vi.fn(), policy: wrong.load, confirmPolicyWeakening: async () => 'd'.repeat(64) })).status).toBe(2)
        expect(synchronize).not.toHaveBeenCalled()
        expect([quiet.record, wrong.record].every(record => record.mock.calls.length === 0)).toBe(true)
        const accepted = policyAdapter(weakened, recorded)
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, interactive,
            { synchronize, confirmStaleRemoval: vi.fn(), policy: accepted.load, confirmPolicyWeakening: async request => request.digest })).status).toBe(0)
        expect(accepted.record).toHaveBeenCalledOnce()
        // A stronger policy needs nobody: it takes effect at the next sync, which records it.
        const strengthened = policyAdapter(recorded, weakened)
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, { interactive: false, json: false, ci: undefined, terminal: false },
            { synchronize, confirmStaleRemoval: vi.fn(), policy: strengthened.load, confirmPolicyWeakening: vi.fn() })).status).toBe(0)
        expect(strengthened.record).toHaveBeenCalledOnce()
    })

    it('refuses a writing sync outside CI under [autonomy] sync = "ci" and passes a dry run', async () => {
        const synchronize = vi.fn(async () => ({ status: 0, diagnostics: [], result: null }))
        const adapters = { synchronize, confirmStaleRemoval: vi.fn(), policy: policyAdapter(policyOf({ sync: 'ci' })).load, confirmPolicyWeakening: vi.fn() }
        const local = { interactive: false, json: false, ci: undefined, terminal: false }
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, local, adapters)).diagnostics[0]?.code).toBe('AUTONOMY_CI_ONLY')
        expect(synchronize).not.toHaveBeenCalled()
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml', dryRun: true }, local, adapters)).status).toBe(0)
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, { ...local, ci: 'true' }, adapters)).status).toBe(0)
    })
})
