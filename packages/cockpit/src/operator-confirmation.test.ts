import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import type { GeneratedEnvironmentSyncHandlerInput, OperatorPolicy } from './environment/operator-application.js'

const policy = async (): Promise<OperatorPolicy> => ({ configSha256: 'a'.repeat(64), widened: ['guards.allow'], seeded: false, approveMcp: async () => 'a'.repeat(64) })
const preview = async (input: GeneratedEnvironmentSyncHandlerInput) => ({ status: 0, diagnostics: [], result: input.dryRun
    ? { dryRun: true, sourceSha256: 'a'.repeat(64), mcpApprovals: [{ name: 'docs', sha256: 'd'.repeat(64), approved: false, sources: ['web:.mcp.json'], runs: 'node docs-server.mjs' }] }
    : null })

it('shows one preview of what widens and the MCP servers it enables, and applies it on one typed yes', async () => {
    const { runSyncOperatorCommand } = await import('./generated-environment/command.js')
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const shown: string[] = []
    const prompts: string[] = []
    let applied = false
    const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' },
        { interactive: true, json: false, ci: undefined }, {
            stdin: stdin as unknown as NodeJS.ReadStream, env: {},
            stderr: Object.assign(new Writable({ write: (bytes, _encoding, done) => {
                const text = String(bytes)
                shown.push(text)
                if (text.includes('[yes/no]')) { prompts.push(text); setImmediate(() => stdin.write('yes\n')) }
                done()
            } }), { isTTY: true }),
        }, async input => {
            if (!input.dryRun) applied = true
            return preview(input)
        }, policy)
    expect(outcome.status, shown.join('')).toBe(0)
    expect(applied).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(shown.join('')).toContain('guards.allow')
    expect(shown.join('')).toContain('node docs-server.mjs')
    // The person reads what changes and answers yes; no digest is shown to copy.
    expect(shown.join('')).not.toContain('d'.repeat(64))
    stdin.destroy()
})

it('refuses a yes when the preview it approves is not shown on a terminal', async () => {
    const { runSyncOperatorCommand } = await import('./generated-environment/command.js')
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    // stdin is a terminal but stderr, where the preview goes, is redirected away from the person.
    const stderr = new Writable({ write: (_bytes, _encoding, done) => { setImmediate(() => stdin.write('yes\n')); done() } })
    let applied = false
    const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' },
        { interactive: true, json: false, ci: undefined }, { stdin: stdin as unknown as NodeJS.ReadStream, stderr, env: {} },
        async input => { if (!input.dryRun) applied = true; return preview(input) }, policy)
    expect(applied).toBe(false)
    expect(outcome.status).not.toBe(0)
    stdin.destroy()
})

it('refuses a yes typed into a terminal an agent tool opened', async () => {
    const { runSyncOperatorCommand } = await import('./generated-environment/command.js')
    for (const env of [{ CLAUDECODE: '1' }, { CODEX_THREAD_ID: 'synthetic' }, { OPENCODE: '1' }]) {
        // A pseudo-terminal passes for a person's: both streams are terminals and a yes arrives.
        const stdin = Object.assign(new PassThrough(), { isTTY: true })
        const shown: string[] = []
        const stderr = Object.assign(new Writable({ write: (bytes, _encoding, done) => {
            shown.push(String(bytes))
            setImmediate(() => stdin.write('yes\n'))
            done()
        } }), { isTTY: true })
        let applied = false
        const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' },
            { interactive: true, json: false, ci: undefined }, { stdin: stdin as unknown as NodeJS.ReadStream, stderr, env },
            async input => { if (!input.dryRun) applied = true; return preview(input) }, policy)
        expect(applied, Object.keys(env)[0]).toBe(false)
        expect(outcome.status).not.toBe(0)
        expect(shown.join('')).toContain(`(${Object.keys(env)[0]} is set)`)
        stdin.destroy()
    }
})
