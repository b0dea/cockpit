import { describe, expect, it } from 'vitest'
import { GUARD_HOST_LIMITS, isGuardHost, normalizeGuardHost } from './host.js'

describe('guard host vocabulary', () => {
    it('bounds the normalized hostname and every label independently', () => {
        const exact = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
        expect(GUARD_HOST_LIMITS).toEqual({ hostnameBytes: 253, labelBytes: 63, rows: 128 })
        for (const host of ['localhost', 'db.example.test', '*.vendor.example.test', exact, `*.${exact}`]) {
            expect(isGuardHost(host), host).toBe(true)
        }
        for (const host of [undefined, '', `${exact}a`, `*.${exact}a`, `${'a'.repeat(64)}.test`,
            'DB.example.test', 'https://db.example.test', 'user@db.example.test', 'db.example.test:443',
            'db.example.test/path', 'db.example.test?q=1', 'db.example.test#x', 'db..example.test',
            '.db.test', 'db.test.', '-db.test', 'db-.test', '**.db.test', '*.*.db.test',
            'db.test\n', 'db.test\0', 'db.\u0085test', 'déb.test']) {
            expect(isGuardHost(host), String(host)).toBe(false)
        }
    })

    it('removes exactly one leading wildcard without rewriting other content', () => {
        expect(normalizeGuardHost('*.db.example.test')).toBe('db.example.test')
        expect(normalizeGuardHost('db.example.test')).toBe('db.example.test')
        expect(normalizeGuardHost('*.*.db.example.test')).toBe('*.db.example.test')
        expect(normalizeGuardHost('DB.example.test')).toBe('DB.example.test')
    })
})
