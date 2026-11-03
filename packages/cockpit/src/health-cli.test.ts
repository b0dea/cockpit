import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli, type CliIo } from './cli.js'

function captureIo() {
    let stdout = ''
    let stderr = ''
    const io: CliIo = {
        stdout: { write: (text) => ((stdout += text), true) },
        stderr: { write: (text) => ((stderr += text), true) },
    }
    return { io, output: () => ({ stdout, stderr }) }
}

describe('health CLI boundary', () => {
    it('binds logs to authenticated production observation', async () => {
        const capture = captureIo()
        const status = await runCli([
            'logs', '--config', '/synthetic/missing-cockpit.toml', '--service', 'api', '--json',
        ], capture.io, {}, { env: {} })

        expect(status).toBe(2)
        // The production observation loads the configuration first, so a missing file is named as
        // missing rather than reported as an unmeasured runtime.
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            diagnostics: [{ code: 'CONFIG_NOT_FOUND', target: '/synthetic/missing-cockpit.toml' }], result: null,
        })
    })

    it.each(['preflight', 'doctor'] as const)('binds %s to the production observation composition and fails on an unreadable config', async (verb) => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-health-config-')))
        try {
            const unparseable = join(directory, 'package.json')
            writeFileSync(unparseable, '{"name": "synthetic"}\n')
            for (const [configPath, code] of [[join(directory, 'missing-cockpit.toml'), 'CONFIG_NOT_FOUND'], [unparseable, 'CONFIG_PARSE_INVALID']]) {
                const capture = captureIo()
                const status = await runCli([verb, '--config', configPath, '--json'], capture.io, {}, { env: {} })

                // A report on no configuration is a failure, so `doctor && ...` cannot proceed past it.
                expect(status).toBe(2)
                // The owner's config refusal is forwarded rather than replaced by a generic evidence code.
                expect(JSON.parse(capture.output().stdout)).toMatchObject({
                    diagnostics: [{ code }],
                    result: { verdict: 'unavailable' },
                })
                expect(capture.output().stderr).toBe('')
            }
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it.each(['preflight', 'doctor'] as const)('dispatches %s as a read-only config request', async (verb) => {
        const handler = vi.fn(async () => ({
            kind: 'complete' as const,
            status: 0 as const,
            diagnostics: Object.freeze([]),
            result: Object.freeze({ verdict: 'pass' }),
        }))
        const capture = captureIo()

        const status = await runCli(
            [verb, '--config', '/synthetic/cockpit.toml', '--json'],
            capture.io,
            { [verb]: handler },
        )

        expect(status).toBe(0)
        expect(handler).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
        expect(JSON.parse(capture.output().stdout)).toMatchObject({ result: { verdict: 'pass' } })
        expect(capture.output().stderr).toBe('')
    })

    it('validates and forwards bounded log flags without transporting runtime authority', async () => {
        const logs = vi.fn(async () => ({
            kind: 'complete' as const,
            status: 0 as const,
            diagnostics: Object.freeze([]),
            result: Object.freeze({ json: true, records: Object.freeze([]) }),
        }))
        const capture = captureIo()

        const status = await runCli([
            'logs', '--config', '/synthetic/cockpit.toml', '--service', 'api',
            '--tail', '25', '--since', '2026-09-25T00:00:00.000Z', '--json',
        ], capture.io, { logs })

        expect(status).toBe(0)
        expect(logs).toHaveBeenCalledWith({
            configPath: '/synthetic/cockpit.toml',
            service: 'api',
            tail: 25,
            follow: false,
            since: '2026-09-25T00:00:00.000Z',
            json: true,
        })
        expect(capture.output().stderr).toBe('')
    })

    it.each(['0', '-1', '1.5', '10001', 'bytes'])(
        'refuses invalid --tail=%s before invoking logs',
        async (tail) => {
            const logs = vi.fn()
            const capture = captureIo()

            const status = await runCli([
                'logs', '--config', '/synthetic/cockpit.toml', '--service', 'api', `--tail=${tail}`, '--json',
            ], capture.io, { logs })

            expect(status).toBe(2)
            expect(logs).not.toHaveBeenCalled()
            expect(JSON.parse(capture.output().stdout)).toMatchObject({
                diagnostics: [{ code: 'CLI_USAGE_INVALID', target: '--tail' }],
            })
        },
    )

    it('requires a cancellation signal before invoking follow logs', async () => {
        const logs = vi.fn()
        const capture = captureIo()

        const status = await runCli([
            'logs', '--config', '/synthetic/cockpit.toml', '--service', 'api', '--follow', '--json',
        ], capture.io, { logs })

        expect(status).toBe(2)
        expect(logs).not.toHaveBeenCalled()
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            diagnostics: [{ code: 'CLI_USAGE_INVALID', target: '--follow' }],
        })
    })

    it('keeps the cancellation signal in the CLI composition boundary', async () => {
        const logs = vi.fn(async () => ({
            kind: 'complete' as const,
            status: 0 as const,
            diagnostics: Object.freeze([]),
            result: Object.freeze({ json: false, records: Object.freeze([]) }),
        }))
        const capture = captureIo()
        const controller = new AbortController()

        const status = await runCli([
            'logs', '--config', '/synthetic/cockpit.toml', '--service', 'api', '--follow',
        ], capture.io, { logs }, { signal: controller.signal, env: {} })

        expect(status).toBe(0)
        expect(logs).toHaveBeenCalledWith({
            configPath: '/synthetic/cockpit.toml',
            service: 'api', tail: 100, since: '15m', follow: true, json: false,
        })
    })
})
