import { describe, expect, it, vi } from 'vitest'
import {
    runResetOperatorApplication,
    runStacksPruneOperatorApplication,
    runSyncOperatorApplication,
    type GeneratedEnvironmentSyncHandlerInput,
    type McpApproval,
    type OperatorPolicy,
} from './operator-application.js'

// The policy adapter in place of cockpit.toml on disk and this machine's guard record.
const policyOf = (policy: Partial<OperatorPolicy> = {}): OperatorPolicy =>
    ({ configSha256: 'a'.repeat(64), widened: [], seeded: false, approveMcp: vi.fn(async () => 'e'.repeat(64)), ...policy })
const policyAdapter = (policy = policyOf()) => ({ load: vi.fn(async () => policy) })

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

    it('applies a reset without a person only where a seed refills the data and cockpit.toml carries no unsynced widening', async () => {
        const decide = vi.fn(async () => Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]), result: null }))
        const run = (policy: Partial<OperatorPolicy>) => {
            const begin = vi.fn(async () => Object.freeze({ preview, decide }))
            const confirm = vi.fn()
            return { begin, confirm, outcome: runResetOperatorApplication({ configPath: '/synthetic/cockpit.toml' },
                { interactive: false, apply: true, json: false, ci: undefined, terminal: false },
                { preview: vi.fn(), begin, confirm, policy: policyAdapter(policyOf(policy)).load }) }
        }
        const seeded = run({ seeded: true })
        expect((await seeded.outcome).status).toBe(0)
        expect(decide).toHaveBeenCalledExactlyOnceWith('approve')
        expect(seeded.confirm).not.toHaveBeenCalled()
        // An agent could declare a volume resettable and a seed in the same edit.
        for (const [policy, code] of [[{ seeded: false }, 'RESET_CONFIRMATION_REQUIRED'],
            [{ seeded: true, widened: ['environment.resettable_volumes'] }, 'GUARD_CONFIG_WIDENED']] as const) {
            const refused = run(policy)
            expect((await refused.outcome).diagnostics[0]?.code, code).toBe(code)
            expect(refused.begin).not.toHaveBeenCalled()
        }
    })

    it('prunes orphaned stacks for an agent, and deletes volumes only where an agent may reset or a person answers yes', async () => {
        const run = (deletesData: boolean, seeded: boolean, admission: Partial<{ interactive: boolean; apply: boolean; yes: boolean }> = { apply: true }) => {
            const apply = vi.fn(async () => Object.freeze({ status: 0, diagnostics: Object.freeze([]), result: { removed: [] } }))
            const begin = vi.fn(async () => Object.freeze({ preview, digest: 'b'.repeat(64), empty: false, deletesData, apply }))
            const outcome = runStacksPruneOperatorApplication({ configPath: '/synthetic/cockpit.toml' },
                { interactive: admission.interactive ?? false, apply: admission.apply ?? false, json: false, ci: undefined, terminal: true },
                { begin, confirm: vi.fn(async () => admission.yes === true), policy: policyAdapter(policyOf({ seeded })).load })
            return { apply, begin, outcome }
        }
        const previewed = run(true, false, {})
        expect(await previewed.outcome).toBe(preview)
        expect(previewed.apply).not.toHaveBeenCalled()
        expect(previewed.begin).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml', scope: 'machine' })
        const housekeeping = run(false, false)
        expect((await housekeeping.outcome).status).toBe(0)
        expect(housekeeping.apply).toHaveBeenCalledOnce()
        // Another cockpit's rule is not this one's, so an agent's apply covers only this cockpit's stacks.
        expect(housekeeping.begin).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml', scope: 'this-cockpit' })
        const data = run(true, false)
        expect((await data.outcome).diagnostics[0]?.code).toBe('RESET_CONFIRMATION_REQUIRED')
        expect(data.apply).not.toHaveBeenCalled()
        expect((await run(true, true).outcome).status).toBe(0)
        const declined = run(true, false, { interactive: true, yes: false })
        expect((await declined.outcome).diagnostics[0]?.code).toBe('STACKS_PRUNE_UNCONFIRMED')
        expect(declined.apply).not.toHaveBeenCalled()
        const approved = run(true, false, { interactive: true, yes: true })
        expect((await approved.outcome).status).toBe(0)
        expect(approved.begin).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml', scope: 'machine' })
    })

    it('removes stale generated files on every sync, as removing them narrows what is written', async () => {
        const request = { format: 'cockpit-stale-removal-request/v1' as const, cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: { kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2 } }], digest: 'c'.repeat(64) }
        const approvals: unknown[] = []
        const synchronize = vi.fn(async (input: GeneratedEnvironmentSyncHandlerInput) => {
            if (!input.dryRun) approvals.push(await input.authorizeStaleRemoval?.(request))
            return { status: 0, diagnostics: [], result: { dryRun: input.dryRun === true, sourceSha256: 'a'.repeat(64) } }
        })
        await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, { interactive: false, json: false, ci: undefined, terminal: false },
            { synchronize, policy: policyAdapter().load, confirmWidening: vi.fn() })
        await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, { interactive: true, json: false, ci: undefined, terminal: true },
            { synchronize, policy: policyAdapter().load, confirmWidening: vi.fn() })
        expect(approvals).toEqual([{ format: 'cockpit-stale-removal-approval/v1', digest: request.digest }, { format: 'cockpit-stale-removal-approval/v1', digest: request.digest }])
    })

    it('applies a widening and enables MCP servers only on one yes, recording the approvals and binding the sync to the bytes that hold them', async () => {
        const server: McpApproval = { name: 'docs', sha256: 'd'.repeat(64), approved: false, sources: ['web:.mcp.json'], runs: 'node docs-server.mjs (in web)' }
        const interactive = { interactive: true, json: false, ci: undefined, terminal: true }
        const run = async (yes: boolean) => {
            const approveMcp = vi.fn(async () => 'e'.repeat(64))
            const before = policyOf({ widened: ['guards.allow'], approveMcp })
            const after = policyOf({ configSha256: 'e'.repeat(64), widened: ['guards.allow', 'mcp.approved.docs'] })
            const policy = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after)
            const writes: GeneratedEnvironmentSyncHandlerInput[] = []
            const synchronize = vi.fn(async (input: GeneratedEnvironmentSyncHandlerInput) => {
                if (input.dryRun) return { status: 0, diagnostics: [], result: input.approveDeclaredMcp
                    ? { dryRun: true, sourceSha256: 'a'.repeat(64), mcpApprovals: [server] } : { dryRun: true, sourceSha256: 'a'.repeat(64) } }
                writes.push(input)
                return { status: 0, diagnostics: [], result: null }
            })
            const confirmWidening = vi.fn(async () => yes)
            const outcome = await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, interactive, { synchronize, policy, confirmWidening })
            return { outcome, writes, approveMcp, confirmWidening }
        }
        const approved = await run(true)
        expect(approved.outcome.status).toBe(0)
        expect(approved.confirmWidening).toHaveBeenCalledExactlyOnceWith({ widens: ['guards.allow'], mcpServers: [server] })
        expect(approved.approveMcp).toHaveBeenCalledExactlyOnceWith([server])
        expect(approved.writes).toEqual([expect.objectContaining({ guardWidening: { configSha256: 'e'.repeat(64) } })])
        const declined = await run(false)
        expect(declined.outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'GUARD_CONFIG_WIDENED' }] })
        expect(declined.approveMcp).not.toHaveBeenCalled()
        expect(declined.writes).toEqual([])
        // A server whose approval an unsynced edit typed into cockpit.toml is shown with what it starts, and needs no second write.
        const typed = { ...server, name: 'maps', approved: true }
        const confirmWidening = vi.fn(async () => true)
        const approveMcp = vi.fn(async () => 'e'.repeat(64))
        const synchronize = vi.fn(async (input: GeneratedEnvironmentSyncHandlerInput) => ({ status: 0, diagnostics: [],
            result: input.dryRun ? { dryRun: true, sourceSha256: 'a'.repeat(64), mcpApprovals: [typed] } : null }))
        expect((await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, interactive, { synchronize, confirmWidening,
            policy: async () => policyOf({ widened: ['mcp.approved.maps'], approveMcp }) })).status).toBe(0)
        expect(confirmWidening).toHaveBeenCalledExactlyOnceWith({ widens: ['mcp.approved.maps'], mcpServers: [typed] })
        expect(approveMcp).not.toHaveBeenCalled()
    })

    it('leaves an agent\'s sync to the team sync, which refuses a widening, and asks nothing', async () => {
        const synchronize = vi.fn(async (_input: GeneratedEnvironmentSyncHandlerInput) => ({ status: 0, diagnostics: [], result: null }))
        const confirmWidening = vi.fn()
        const policy = policyAdapter(policyOf({ widened: ['guards.allow'] }))
        await runSyncOperatorApplication({ configPath: 'cockpit.toml' }, { interactive: false, json: false, ci: undefined, terminal: false },
            { synchronize, policy: policy.load, confirmWidening })
        expect(synchronize).toHaveBeenCalledOnce()
        expect(synchronize.mock.calls[0]![0].guardWidening).toBeUndefined()
        expect(confirmWidening).not.toHaveBeenCalled()
    })

    it('refuses when cockpit.toml changes while the person reviews it', async () => {
        const server: McpApproval = { name: 'docs', sha256: 'd'.repeat(64), approved: false, sources: ['web:.mcp.json'], runs: 'node docs-server.mjs (in web)' }
        const synchronize = vi.fn(async (input: GeneratedEnvironmentSyncHandlerInput) => ({ status: 0, diagnostics: [],
            result: input.dryRun ? { dryRun: true, sourceSha256: 'a'.repeat(64), mcpApprovals: [server] } : null }))
        // The file on disk after the approvals were written is not the one they were written to.
        const policy = vi.fn().mockResolvedValueOnce(policyOf()).mockResolvedValue(policyOf({ configSha256: 'f'.repeat(64) }))
        const outcome = await runSyncOperatorApplication({ configPath: 'cockpit.toml' },
            { interactive: true, json: false, ci: undefined, terminal: true }, { synchronize, policy, confirmWidening: async () => true })
        expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'CONFIG_CHANGED_DURING_EXECUTION' }] })
        expect(synchronize.mock.calls.every(([input]) => input.dryRun === true)).toBe(true)
    })
})
