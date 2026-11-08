import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { runCli } from './cli.js'
import type { InitApplicationInput, InitApplicationOutcome } from './environment/init-application.js'

it('accepts an init preview and its concrete defaults without transcribing either fingerprint', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stdout = Object.assign(new PassThrough(), { isTTY: true })
    const shown: string[] = []
    const requests: InitApplicationInput[] = []
    const digest = 'a'.repeat(64)
    const defaults = 'b'.repeat(64)
    const status = await runCli(['init', process.cwd(), '--target', 'codexcli', '--interactive'], {
        stdin: stdin as unknown as NodeJS.ReadStream, stdout,
        stderr: Object.assign(new Writable({ write: (bytes, _encoding, done) => {
            const text = String(bytes)
            shown.push(text)
            if (text.includes('[yes/no]') || text.includes('Type the')) setImmediate(() => stdin.write('yes\n'))
            done()
        } }), { isTTY: true }),
    }, { init: async (input): Promise<InitApplicationOutcome> => {
        requests.push(input)
        const result = { stage: 'surface-previewed' as const, root: input.root, target: input.target,
            previewSha256: digest, files: [{ path: 'AGENTS.md', sha256: 'c'.repeat(64) }] }
        if (!input.accepted) return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [], result }
        if (!input.greenfieldAnswer) return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [],
            result: { ...result, question: { id: `question:${defaults}`, field: 'configuration.defaults',
                source: 'configuration', why: 'Review defaults', expectedSha256: defaults } } }
        return { kind: 'complete', status: 0, artifact: null, destination: null, diagnostics: [], result }
    } }, { env: {} })
    expect(status, shown.join('')).toBe(0)
    expect(requests[1]?.acceptedPreviewSha256).toBe(digest)
    expect(requests[2]?.greenfieldAnswer).toMatchObject({ bytes: JSON.stringify({ confirmed: true, sha256: defaults }), provenance: 'operator-confirmed' })
    expect(shown.join('')).toContain(digest)
    expect(shown.join('')).toContain(defaults)
    stdin.destroy()
    stdout.destroy()
})

it('binds terminal confirmations to the displayed sync policy and removal previews', async () => {
    const { runSyncOperatorCommand } = await import('./generated-environment/command.js')
    const { effectivePolicy } = await import('./autonomy.js')
    const { Autonomy, Work } = await import('./schema.js')
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const staleRemoval = { format: 'cockpit-stale-removal-request/v1' as const, cockpitId: 'synthetic',
        generation: 'generation-1', sourceSha256: 'a'.repeat(64), digest: 'b'.repeat(64),
        entries: [{ path: 'old-guide.md', operation: 'remove-file' as const,
            current: { kind: 'file' as const, sha256: 'c'.repeat(64), dev: 1, ino: 2 } }] }
    let applied = false
    const shown: string[] = []
    const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' },
        { interactive: true, json: false, ci: undefined }, {
            stdin: stdin as unknown as NodeJS.ReadStream,
            stderr: Object.assign(new Writable({ write: (bytes, _encoding, done) => {
                const text = String(bytes)
                shown.push(text)
                if (text.includes('[yes/no]') || text.includes('Type the')) setImmediate(() => stdin.write('yes\n'))
                done()
            } }), { isTTY: true }),
        }, async input => {
            if (input.dryRun) return { status: 0, diagnostics: [], result: { dryRun: true, changes: [], staleRemoval } }
            expect(await input.authorizeStaleRemoval?.(staleRemoval)).toEqual({ format: 'cockpit-stale-removal-approval/v1', digest: staleRemoval.digest })
            applied = true
            return { status: 0, diagnostics: [], result: null }
        }, async () => ({ current: effectivePolicy({ work: Work.parse({}), autonomy: Autonomy.parse({ sync: 'agent', stale_delete: 'person' }) }),
            recorded: effectivePolicy({ work: Work.parse({}), autonomy: Autonomy.parse({ sync: 'person', stale_delete: 'person' }) }), record: async () => {} }))
    expect(outcome.status, shown.join('')).toBe(0)
    expect(applied).toBe(true)
    expect(shown.join('')).toContain('autonomy.sync: person -> agent')
    expect(shown.join('')).toContain('old-guide.md')
    expect(shown.join('')).toContain(staleRemoval.digest)
    stdin.destroy()
})

it('refuses a yes when the preview it approves is not shown on a terminal', async () => {
    const { runSyncOperatorCommand } = await import('./generated-environment/command.js')
    const { effectivePolicy } = await import('./autonomy.js')
    const { Autonomy, Work } = await import('./schema.js')
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    // stdin is a terminal but stderr, where the preview goes, is redirected away from the person.
    const stderr = new Writable({ write: (_bytes, _encoding, done) => { setImmediate(() => stdin.write('yes\n')); done() } })
    let applied = false
    const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' },
        { interactive: true, json: false, ci: undefined }, { stdin: stdin as unknown as NodeJS.ReadStream, stderr },
        async () => { applied = true; return { status: 0, diagnostics: [], result: null } },
        async () => ({ current: effectivePolicy({ work: Work.parse({}), autonomy: Autonomy.parse({ sync: 'agent' }) }),
            recorded: effectivePolicy({ work: Work.parse({}), autonomy: Autonomy.parse({ sync: 'person' }) }), record: async () => {} }))
    expect(applied).toBe(false)
    expect(outcome.status).not.toBe(0)
    stdin.destroy()
})
