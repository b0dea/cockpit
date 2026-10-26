import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ADOPTION_LAYERS, COMPARISON_FORMAT, mechanism, parseComparisonFixture, SHARED_COMPARISON_COMMANDS } from './contract.js'

const source = JSON.parse(readFileSync(new URL('../../../../fixtures/comparison/command-set.json', import.meta.url), 'utf8')) as Record<string, unknown>
const alternate = JSON.parse(readFileSync(new URL('../../../../fixtures/comparison/second-shape.json', import.meta.url), 'utf8')) as Record<string, unknown>
const clone = (): Record<string, unknown> => structuredClone(source)
const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('fixture test expected an object')
    return value as Record<string, unknown>
}
const items = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new TypeError('fixture test expected an array')
    return value
}
const implementation = (value: Record<string, unknown>, index: number) => record(items(value.implementations)[index])

describe('comparison fixture contract', () => {
    it('declares every public runtime export to the mechanism inventory', () => {
        expect(mechanism.exports).toEqual(['ADOPTION_LAYERS', 'COMPARISON_FORMAT', 'SHARED_COMPARISON_COMMANDS', 'parseComparisonFixture'])
        expect([ADOPTION_LAYERS.length, COMPARISON_FORMAT, SHARED_COMPARISON_COMMANDS.length]).toEqual([5, 'cockpit-comparison/v1', 7])
    })

    it('admits the complete versioned synthetic command set', () => {
        const result = parseComparisonFixture(source)
        expect(result).toMatchObject({ kind: 'complete', fixture: { format: 'cockpit-comparison/v1', fixtureId: 'synthetic-parity' } })
        if (result.kind !== 'complete') throw new Error(result.message)
        expect(result.fixture.commands.shared).toEqual(['preflight', 'up', 'down', 'reset', 'doctor', 'logs', 'seed'])
        expect(result.fixture.implementations.map(({ id }) => id)).toEqual(['legacy', 'cockpit'])
        expect(Object.isFrozen(result.fixture)).toBe(true)
    })

    it('preserves distinct source paths when their bytes have the same digest', () => {
        const value = clone()
        const inputs = items(record(value.subject).inputs)
        const sharedDigest = record(inputs[0]).sha256
        record(inputs[1]).sha256 = sharedDigest
        for (const item of items(value.implementations)) {
            for (const binding of items(record(item).bindings)) items(record(binding).inputSha256s)[1] = sharedDigest
        }
        const result = parseComparisonFixture(value)
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error(result.message)
        expect(result.fixture.subject.inputs[0].path).not.toBe(result.fixture.subject.inputs[1].path)
        expect(result.fixture.subject.inputs[0].sha256).toBe(result.fixture.subject.inputs[1].sha256)
    })

    it('records adoption independently for every ordered layer', () => {
        const value = clone()
        items(value.adoption).forEach((row, index) => { record(row).state = index === 0 || index === 4 ? 'migrated' : 'documented-only' })
        const result = parseComparisonFixture(value)
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error(result.message)
        expect(result.fixture.adoption.map(row => row.state)).toEqual(['migrated', 'documented-only', 'documented-only', 'documented-only', 'migrated'])
    })

    it('admits the second source through the unchanged v1 contract', () => {
        const result = parseComparisonFixture(alternate)
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error(result.message)
        expect(result.fixture).toMatchObject({ format: COMPARISON_FORMAT, fixtureId: 'alternate-shape',
            subject: { inputs: [
                { path: 'fixtures/registries/lane-dialect.sh', sha256: 'e7228ae2c094938a689f1fba56d88943c73399604eec79fcf33a6676cb34e2be' },
                { path: 'fixtures/source-material.json', sha256: '2f67f5ca3f865375453777bbea0f7974b588d27accc99f41f691462e15abe0c7' },
            ] } })
        expect(result.fixture).not.toHaveProperty('sourceShape')
        expect(result.fixture.adoption.map(row => row.state)).toEqual(Array(5).fill('documented-only'))
        expect(result.fixture.commands).toEqual({ shared: [...SHARED_COMPARISON_COMMANDS], extras: [] })
    })

    it.each([
        ['missing critical command', (value: Record<string, unknown>) => items(record(value.commands).shared).splice(4, 1)],
        ['orphan binding', (value: Record<string, unknown>) => record(items(implementation(value, 0).bindings)[0]).command = 'orphan'],
        ['missing post-state', (value: Record<string, unknown>) => items(implementation(value, 1).postStates).pop()],
        ['stale revision', (value: Record<string, unknown>) => implementation(value, 1).revision = '3'.repeat(40)],
        ['stale input hash', (value: Record<string, unknown>) => items(record(items(implementation(value, 0).bindings)[2]).inputSha256s)[0] = 'd'.repeat(64)],
        ['out-of-order adoption', (value: Record<string, unknown>) => items(value.adoption).reverse()],
        ['duplicate adoption layer', (value: Record<string, unknown>) => record(items(value.adoption)[4]).layer = 'registry'],
        ['duplicate input path', (value: Record<string, unknown>) => record(items(record(value.subject).inputs)[1]).path = record(items(record(value.subject).inputs)[0]).path],
        ['unsafe normalization candidate', (value: Record<string, unknown>) => record(items(value.normalization)[0]).candidate = 'not-a-time'],
        ['undeclared field', (value: Record<string, unknown>) => record(value.subject).claim = 'unsupported'],
    ])('refuses %s', (_name, mutate) => {
        const value = clone()
        mutate(value)
        expect(parseComparisonFixture(value)).toMatchObject({ kind: 'refusal', code: expect.stringMatching(/^COMPARISON_/) })
    })
})
