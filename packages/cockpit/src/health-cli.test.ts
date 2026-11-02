import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli, type CliIo } from './cli.js'

function captureIo(confirmBaseline?: CliIo['confirmBaseline']) {
    let stdout = ''
    let stderr = ''
    const io: CliIo = {
        stdout: { write: (text) => ((stdout += text), true) },
        stderr: { write: (text) => ((stderr += text), true) },
        ...(confirmBaseline ? { confirmBaseline } : {}),
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

    it.each([
        ['missing --interactive', ['baseline-record', '--config', '/synthetic/cockpit.toml']],
        ['removed --confirmation', [
            'baseline-record', '--config', '/synthetic/cockpit.toml', '--confirmation', '4'.repeat(64),
        ]],
    ] as const)('refuses %s before baseline observation or writing', async (_name, args) => {
        const beginOperatorBaselineRecord = vi.fn()
        const baselineRecord = vi.fn()
        const capture = captureIo(async () => true)

        const status = await runCli(
            args,
            capture.io,
            { beginOperatorBaselineRecord, 'baseline-record': baselineRecord },
            { env: {} },
        )

        expect(status).toBe(2)
        expect(beginOperatorBaselineRecord).not.toHaveBeenCalled()
        expect(baselineRecord).not.toHaveBeenCalled()
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

    it('keeps baseline recording explicit and separate from read-only health', async () => {
        const preflight = vi.fn()
        const doctor = vi.fn()
        const baselineRecord = vi.fn()
        const decide = vi.fn(async () => ({
            kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]),
            result: Object.freeze({ stackId: `stack:${'1'.repeat(64)}` }),
        }))
        const beginOperatorBaselineRecord = vi.fn(async () => Object.freeze({
            preview: Object.freeze({
                kind: 'preview' as const, status: 0 as const, diagnostics: Object.freeze([]),
                result: Object.freeze({ confirmation: '4'.repeat(64), stackId: `stack:${'1'.repeat(64)}` }),
            }),
            decide,
        }))
        const capture = captureIo(async () => true)

        const status = await runCli([
            'baseline-record', '--config', '/synthetic/cockpit.toml', '--interactive',
        ], capture.io, { preflight, doctor, 'baseline-record': baselineRecord, beginOperatorBaselineRecord }, { env: {} })

        expect(status).toBe(0)
        expect(preflight).not.toHaveBeenCalled()
        expect(doctor).not.toHaveBeenCalled()
        expect(baselineRecord).not.toHaveBeenCalled()
        expect(beginOperatorBaselineRecord).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledWith('approve')
    })

    it.each([
        ['approve', true],
        ['decline', false],
    ] as const)('confirms one exact baseline observation interactively for %s', async (decision, approved) => {
        const preview = Object.freeze({
            kind: 'preview' as const, status: 0 as const, diagnostics: Object.freeze([]),
            result: Object.freeze({ confirmation: '4'.repeat(64), stackId: `stack:${'1'.repeat(64)}` }),
        })
        const decide = vi.fn(async () => ({
            kind: approved ? 'complete' as const : 'refusal' as const,
            status: approved ? 0 as const : 2 as const,
            diagnostics: Object.freeze([]), result: approved ? Object.freeze({
                artifact: 'environment-baseline', schemaVersion: 1, stackId: `stack:${'1'.repeat(64)}`,
                version: 2, recordedAt: '2026-09-26T00:00:00.000Z',
            }) : null,
        }))
        const beginOperatorBaselineRecord = vi.fn(async () => Object.freeze({ preview, decide }))
        const baselineRecord = vi.fn()
        const confirmBaseline = vi.fn(async (shown) => {
            expect(shown).toBe(preview)
            return approved
        })
        const capture = captureIo(confirmBaseline)

        const status = await runCli(
            ['baseline-record', '--config', '/synthetic/cockpit.toml', '--interactive'],
            capture.io, { 'baseline-record': baselineRecord, beginOperatorBaselineRecord }, { env: {} },
        )

        expect(status).toBe(approved ? 0 : 130)
        // A recorded baseline says so; printing nothing left a person unsure whether anything was written.
        expect(capture.output().stdout).toBe(approved
            ? `Recorded environment baseline version 2 (stack:${'1'.repeat(64)}) at 2026-09-26T00:00:00.000Z.\n` : '')
        expect(baselineRecord).not.toHaveBeenCalled()
        expect(beginOperatorBaselineRecord).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
        expect(confirmBaseline).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledWith(decision)
    })

    it.each([
        ['piped input', { env: {} }, false],
        ['CI', { env: { CI: '1' } }, true],
    ] as const)('refuses interactive baseline in %s before observing', async (_name, runtime, callback) => {
        const beginOperatorBaselineRecord = vi.fn()
        const capture = captureIo(callback ? async () => true : undefined)
        const status = await runCli(
            ['baseline-record', '--config', '/synthetic/cockpit.toml', '--interactive'],
            { ...capture.io, stdin: { isTTY: false } as NodeJS.ReadStream },
            { beginOperatorBaselineRecord }, runtime,
        )
        expect(status).toBe(2)
        expect(beginOperatorBaselineRecord).not.toHaveBeenCalled()
    })

    it('prints the bounded stale-baseline field after interactive approval', async () => {
        const capture = captureIo(async () => true)
        const status = await runCli(
            ['baseline-record', '--config', '/synthetic/cockpit.toml', '--interactive'],
            capture.io, { beginOperatorBaselineRecord: async () => Object.freeze({
                preview: Object.freeze({
                    kind: 'preview' as const, status: 0 as const, diagnostics: Object.freeze([]),
                    result: Object.freeze({ confirmation: '4'.repeat(64), stackId: `stack:${'1'.repeat(64)}` }),
                }),
                decide: async () => Object.freeze({
                    kind: 'refusal' as const, status: 2 as const, result: null,
                    diagnostics: Object.freeze([Object.freeze({
                        code: 'EVIDENCE_UNAVAILABLE' as const, severity: 'error' as const,
                        message: 'baseline runtime topology changed',
                    })]),
                }),
            }) as never }, { env: {} },
        )
        expect(status).toBe(2)
        expect(capture.output().stderr).toContain('baseline runtime topology changed')
    })

    it('refuses interactive baseline in JSON mode before observing', async () => {
        const beginOperatorBaselineRecord = vi.fn()
        const capture = captureIo(async () => true)
        const status = await runCli(
            ['baseline-record', '--config', '/synthetic/cockpit.toml', '--interactive', '--json'],
            capture.io, { beginOperatorBaselineRecord }, { env: {} },
        )
        expect(status).toBe(2)
        expect(beginOperatorBaselineRecord).not.toHaveBeenCalled()
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            result: null, diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }],
        })
    })

    it('refuses the removed digest flag before interactive baseline observation', async () => {
        const beginOperatorBaselineRecord = vi.fn()
        const baselineRecord = vi.fn()
        const capture = captureIo(async () => true)
        const status = await runCli(
            ['baseline-record', '--config', '/synthetic/cockpit.toml', '--interactive', '--confirmation', '4'.repeat(64)],
            capture.io, { beginOperatorBaselineRecord, 'baseline-record': baselineRecord }, { env: {} },
        )
        expect(status).toBe(2)
        expect(beginOperatorBaselineRecord).not.toHaveBeenCalled()
        expect(baselineRecord).not.toHaveBeenCalled()
    })

    it('binds interactive baseline observation to the production evidence source', async () => {
        const capture = captureIo(async () => true)
        const status = await runCli(
            ['baseline-record', '--config', '/synthetic/missing-cockpit.toml', '--interactive'],
            capture.io, {}, { env: {} },
        )
        expect(status).toBe(2)
        expect(capture.output().stderr).toContain('EVIDENCE_UNAVAILABLE')
    })
})
