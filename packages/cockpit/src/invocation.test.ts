import { describe, expect, it } from 'vitest'
import { createInvocationRecord, EXIT_CODES } from './invocation.js'

describe('invocation record', () => {
    it('records distinct success, failure and cancellation without ambient policy or mutable fields', () => {
        expect(EXIT_CODES).toEqual({ success: 0, failure: 2, cancelled: 130 })
        expect(Object.isFrozen(EXIT_CODES)).toBe(true)
        for (const exitCode of [0, 2, 130] as const) {
            const input = { verb: 'check', durationMs: 41, exitCode, resolvedConfigPath: '/workspace/cockpit.toml' }
            const record = createInvocationRecord(input)
            expect(record).toEqual(input)
            input.verb = 'sync'
            expect(record.verb).toBe('check')
        }
        expect(createInvocationRecord({ verb: 'registry resolve', durationMs: 0, exitCode: 0, resolvedConfigPath: null }))
            .toEqual({ verb: 'registry resolve', durationMs: 0, exitCode: 0, resolvedConfigPath: null })
    })

    it('refuses invalid durations, verbs, exits and unresolved or hostile config paths', () => {
        const valid = { verb: 'check', durationMs: 1, exitCode: 0 as const, resolvedConfigPath: '/workspace/cockpit.toml' }
        for (const durationMs of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => createInvocationRecord({ ...valid, durationMs })).toThrow(/durationMs/)
        }
        for (const verb of ['', ' check', 'check\n', 'check;sync', 'check\u202e']) {
            expect(() => createInvocationRecord({ ...valid, verb })).toThrow(/verb/)
        }
        for (const resolvedConfigPath of ['', 'cockpit.toml', '/workspace/../cockpit.toml', '/workspace/./cockpit.toml', '/tmp/config\0', '/tmp/config\u009b', '/tmp/config\u2028']) {
            expect(() => createInvocationRecord({ ...valid, resolvedConfigPath })).toThrow(/resolvedConfigPath/)
        }
        // A JavaScript caller can supply an exit outside the TypeScript vocabulary.
        // @ts-expect-error Unknown exits are refused at the runtime boundary as well.
        expect(() => createInvocationRecord({ ...valid, exitCode: 1 })).toThrow(/exitCode/)
    })
})
