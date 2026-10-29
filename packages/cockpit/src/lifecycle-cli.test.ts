import { describe, expect, it, vi } from 'vitest'
import { commands } from './command-table.js'
import { runCli, type CliIo } from './cli.js'

function captureIo(confirmReset?: CliIo['confirmReset']) {
    let stdout = ''
    let stderr = ''
    const io: CliIo = {
        stdout: { write: (text) => ((stdout += text), true) },
        stderr: { write: (text) => ((stderr += text), true) },
        ...(confirmReset ? { confirmReset } : {}),
    }
    return { io, output: () => ({ stdout, stderr }) }
}

function complete(change: string) {
    return Object.freeze({
        kind: 'complete' as const,
        status: 0 as const,
        diagnostics: Object.freeze([]),
        result: Object.freeze({ change }),
    })
}

describe('lifecycle CLI composition', () => {
    it.each(['up', 'sleep'] as const)('binds %s to its production runner', async (verb) => {
        const capture = captureIo()
        const status = await runCli(
            [verb, '--config', '/synthetic/missing-cockpit.toml', '--json'],
            capture.io,
            {},
            { env: {} },
        )

        expect(status).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            diagnostics: [{ code: 'CONFIG_NOT_FOUND' }],
            result: null,
        })
        expect(capture.output().stderr).toBe('')
    })

    it.each(['down', 'reset'] as const)('binds %s to its production runner with an explicit runtime context', async (verb) => {
        const capture = captureIo()
        const status = await runCli(
            [verb, '--config', '/synthetic/missing-cockpit.toml', '--json'],
            capture.io,
            {},
            { env: { DOCKER_CONTEXT: 'synthetic' } },
        )

        expect(status).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            diagnostics: [{ code: 'CONFIG_NOT_FOUND' }],
            result: null,
        })
        expect(capture.output().stderr).toBe('')
    })

    it.each(['down', 'reset'] as const)('names the missing Docker daemon selection for %s', async (verb) => {
        const capture = captureIo()
        const status = await runCli([verb, '--config', '/synthetic/missing-cockpit.toml', '--json'], capture.io, {}, { env: {} })

        expect(status).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            diagnostics: [{ code: 'CLI_USAGE_INVALID', target: 'DOCKER_CONTEXT', message: expect.stringContaining('docker context show') }],
        })
    })

    it.each(['down', 'reset'] as const)('admits local endpoint syntax and refuses remote pipe hosts for %s', async (verb) => {
        for (const host of ['unix:///synthetic home/docker.sock', 'npipe:////./pipe/dockerDesktopLinuxEngine']) {
            const capture = captureIo()
            expect(await runCli([verb, '--config', '/synthetic/missing-cockpit.toml', '--json'], capture.io, {},
                { env: { DOCKER_HOST: host } })).toBe(2)
            expect(JSON.parse(capture.output().stdout)).toMatchObject({ diagnostics: [{ code: 'CONFIG_NOT_FOUND' }] })
        }
        const capture = captureIo()
        expect(await runCli([verb, '--config', '/synthetic/missing-cockpit.toml', '--json'], capture.io, {},
            { env: { DOCKER_HOST: 'npipe:////synthetic.invalid/pipe/docker_engine' } })).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toMatchObject({ diagnostics: [{
            code: 'CLI_USAGE_INVALID', target: 'DOCKER_HOST', message: expect.stringContaining('local Docker endpoint'),
        }] })
    })

    it('opens the production reset session only from the interactive branch', async () => {
        const capture = captureIo(async () => true)
        const status = await runCli(
            ['reset', '--config', '/synthetic/missing-cockpit.toml', '--interactive'],
            capture.io,
            {},
            { env: { DOCKER_CONTEXT: 'synthetic' } },
        )

        expect(status).toBe(2)
        expect(capture.output().stderr).toContain('CONFIG_NOT_FOUND')
    })

    it('registers every lifecycle verb as metadata without importing command handlers', () => {
        expect(commands.map(({ name }) => name)).toEqual(expect.arrayContaining([
            'setup', 'up', 'session', 'sleep', 'down', 'reset',
        ]))
        expect(commands.map(({ handler }) => handler)).toEqual(expect.arrayContaining([
            'setup', 'up', 'session', 'sleep', 'down', 'reset',
        ]))
    })

    it('dispatches one foreground command as the session tail without offering JSON mode', async () => {
        const session = vi.fn(async () => complete('stopped'))
        const capture = captureIo()

        expect(await runCli([
            'session', '--config', '/synthetic/cockpit.toml', '--', 'synthetic-agent', '--work', 'one',
        ], capture.io, { session })).toBe(0)
        expect(session).toHaveBeenCalledWith(expect.objectContaining({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent', '--work', 'one'],
            sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }))
        const nested = vi.fn(async () => complete('stopped'))
        const nestedCapture = captureIo()
        expect(await runCli([
            'session', '--config', '/synthetic/cockpit.toml', '--', 'synthetic-agent',
        ], nestedCapture.io, { session: nested }, {
            env: { COCKPIT_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        })).toBe(2)
        expect(nested).not.toHaveBeenCalled()
        expect(nestedCapture.output().stderr).toContain('cannot be nested')
        expect(await runCli([
            'session', '--config', '/synthetic/cockpit.toml', '--json', '--', 'synthetic-agent',
        ], captureIo().io, { session })).toBe(2)
    })

    it('refuses a malformed inherited lifecycle session instead of leaking a default holder', async () => {
        const capture = captureIo()
        expect(await runCli(['up', '--config', '/synthetic/cockpit.toml'], capture.io, {}, {
            env: { COCKPIT_SESSION_ID: 'not-a-session' },
        })).toBe(2)
        expect(capture.output().stderr).toContain('COCKPIT_SESSION_ID')
        expect(capture.output().stderr).not.toContain('CONFIG_NOT_FOUND')
    })

    it.each(['up', 'sleep', 'down'] as const)('dispatches %s with the exact config path', async (verb) => {
        const handler = vi.fn(async () => complete(verb))
        const capture = captureIo()

        const status = await runCli(
            [verb, '--config', '/synthetic/cockpit.toml', '--json'],
            capture.io,
            { [verb]: handler },
        )

        expect(status).toBe(0)
        expect(handler).toHaveBeenCalledOnce()
        expect(handler).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
        expect(JSON.parse(capture.output().stdout)).toMatchObject({ result: { change: verb } })
        expect(capture.output().stderr).toBe('')
    })

    it('keeps ordinary and JSON reset on the preview-only runner', async () => {
        const reset = vi.fn(async () => ({
            kind: 'preview' as const,
            status: 0 as const,
            diagnostics: Object.freeze([]),
            result: Object.freeze({
                stackId: `stack:${'1'.repeat(64)}`,
                planDigest: '2'.repeat(64),
                targets: Object.freeze([]),
                noop: true,
            }),
        }))
        const beginOperatorReset = vi.fn()
        const capture = captureIo()

        const status = await runCli(
            ['reset', '--config', '/synthetic/cockpit.toml', '--json'],
            capture.io,
            { reset, beginOperatorReset },
        )

        expect(status).toBe(0)
        expect(reset).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
        expect(beginOperatorReset).not.toHaveBeenCalled()
        expect(JSON.parse(capture.output().stdout)).toMatchObject({ result: { noop: true } })
    })

    it.each([
        ['approve', true],
        ['decline', false],
    ] as const)('keeps the interactive reset continuation in process for %s', async (decision, approved) => {
        const decide = vi.fn(async () => complete(approved ? 'reset' : 'unchanged'))
        const preview = Object.freeze({
            kind: 'preview' as const,
            status: 0 as const,
            diagnostics: Object.freeze([]),
            result: Object.freeze({
                stackId: `stack:${'3'.repeat(64)}`,
                planDigest: '4'.repeat(64),
                targets: Object.freeze([{ kind: 'volume', name: 'synthetic-cache' }]),
                noop: false,
            }),
        })
        const beginOperatorReset = vi.fn(async () => Object.freeze({ preview, decide }))
        const reset = vi.fn()
        const confirmReset = vi.fn(async (shown) => {
            expect(shown).toBe(preview)
            return approved
        })
        const capture = captureIo(confirmReset)

        const status = await runCli(
            ['reset', '--config', '/synthetic/cockpit.toml', '--interactive'],
            capture.io,
            { reset, beginOperatorReset },
            { env: {} },
        )

        expect(status).toBe(approved ? 0 : 130)
        expect(reset).not.toHaveBeenCalled()
        expect(beginOperatorReset).toHaveBeenCalledOnce()
        expect(beginOperatorReset).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
        expect(confirmReset).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledWith(decision)
        expect(capture.output().stdout).toBe('')
        expect(capture.output().stderr).toBe('')
        expect(JSON.stringify(capture.output())).not.toMatch(/continuation|authority|decide/)
    })

    it.each(['reset', 'baseline-record'] as const)('records %s human decline as cancellation and cleanup throw as failure', async verb => {
        for (const throws of [false, true]) {
            const decide = vi.fn(async () => {
                if (throws) throw new Error('synthetic cleanup failed')
                return complete('unchanged')
            })
            const capture = captureIo(async () => false)
            const io = { ...capture.io, confirmBaseline: async () => false }
            const begin = async () => ({ preview: complete('preview'), decide })
            const status = await runCli([verb, '--config', '/synthetic/cockpit.toml', '--interactive'], io,
                { beginOperatorReset: begin, beginOperatorBaselineRecord: begin }, { env: {} })
            expect(status).toBe(throws ? 2 : 130)
            expect(decide).toHaveBeenCalledExactlyOnceWith('decline')
            expect(decide).not.toHaveBeenCalledWith('approve')
            expect(capture.output().stdout).toBe('')
            expect(capture.output().stderr).not.toContain('"invocation"')
            if (throws) expect(capture.output().stderr).toContain('CLI_INTERNAL_ERROR')
            else expect(capture.output().stderr).toBe('')
        }
    })

    it('does not open an operator reset session from piped input', async () => {
        const capture = captureIo()
        const beginOperatorReset = vi.fn()
        const status = await runCli(
            ['reset', '--config', '/synthetic/cockpit.toml', '--interactive'],
            { ...capture.io, stdin: { isTTY: false } as NodeJS.ReadStream },
            { beginOperatorReset },
            { env: {} },
        )
        expect(status).toBe(2)
        expect(beginOperatorReset).not.toHaveBeenCalled()
    })

    it.each([
        ['JSON', ['reset', '--config', '/synthetic/cockpit.toml', '--interactive', '--json']],
        ['CI', ['reset', '--config', '/synthetic/cockpit.toml', '--interactive']],
    ] as const)('does not mint an operator continuation in %s mode', async (mode, args) => {
        const reset = vi.fn()
        const beginOperatorReset = vi.fn()
        const capture = captureIo(async () => true)

        const status = await runCli(args, capture.io, { reset, beginOperatorReset }, {
            env: mode === 'CI' ? { CI: 'true' } : {},
        })

        expect(status).toBe(2)
        expect(reset).not.toHaveBeenCalled()
        expect(beginOperatorReset).not.toHaveBeenCalled()
        const output = mode === 'JSON' ? JSON.parse(capture.output().stdout) : capture.output().stderr
        expect(JSON.stringify(output)).toContain('RESET_CONFIRMATION_MISMATCH')
    })
})
