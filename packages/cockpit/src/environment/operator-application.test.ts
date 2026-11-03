import { describe, expect, it, vi } from 'vitest'
import {
    runResetOperatorApplication,
    runSyncOperatorApplication,
    type GeneratedEnvironmentSyncHandlerInput,
} from './operator-application.js'

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
            { preview: vi.fn(), begin, confirm: vi.fn() },
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
            { preview: runPreview, begin: vi.fn(), confirm: vi.fn() },
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
            { preview: vi.fn(), begin: vi.fn(async () => Object.freeze({ preview, decide })), confirm },
        )

        expect(confirm).toHaveBeenCalledWith(preview)
        expect(decide).toHaveBeenCalledWith('approve')
    })

    it('awaits reset decline cleanup before returning an empty cancelled outcome', async () => {
        let settle!: (value: typeof preview) => void
        const cleanup = new Promise<typeof preview>(resolve => { settle = resolve })
        const decide = vi.fn(() => cleanup)
        const confirm = vi.fn(async (shown) => { expect(shown).toBe(preview); return false })
        const adapters = { preview: vi.fn(), begin: vi.fn(async () => ({ preview, decide })), confirm }
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
        const adapters = { preview: vi.fn(), begin: vi.fn(async () => ({ preview, decide })), confirm: async () => false }
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
            { synchronize, confirmStaleRemoval: async () => request.digest },
        )

        expect(synchronize).toHaveBeenCalledTimes(2)
    })
})
