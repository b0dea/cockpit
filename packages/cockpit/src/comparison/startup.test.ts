import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseComparisonFixture } from './contract.js'
import { classifyStartupComparison, COMPARISON_DATA_MODES, mechanism, type StartupComparisonInput } from './startup.js'

const sha = (value: string): string => value.repeat(64)
const state = Object.freeze({
    dataSha256: sha('1'), imageSha256: sha('2'), cacheSha256: sha('3'),
    lockSha256: sha('4'), resourceSha256: sha('5'), healthSha256: sha('6'),
})
const alternate = parseComparisonFixture(JSON.parse(readFileSync(new URL('../../../../fixtures/comparison/second-shape.json', import.meta.url), 'utf8')))
if (alternate.kind !== 'complete') throw new Error(alternate.message)

function input(cockpit = [9, 11, 10, 12, 8], legacy = [10, 12, 11, 13, 9],
    states: readonly typeof state[] = COMPARISON_DATA_MODES.map(() => state)): StartupComparisonInput {
    return {
        modes: COMPARISON_DATA_MODES.map((mode, modeIndex) => ({
            mode: mode as 'empty' | 'seeded' | 'restored',
            pairs: legacy.map((legacyDuration, index) => ({
                pair: index + 1,
                order: index % 2 === 0 ? 'legacy-first' as const : 'cockpit-first' as const,
                equivalence: { kind: 'equivalent' as const, state: states[modeIndex]! },
                legacy: index % 2 === 0
                    ? { kind: 'healthy' as const, invokedAtMs: index * 100, healthyAtMs: index * 100 + legacyDuration }
                    : { kind: 'healthy' as const, invokedAtMs: index * 100 + cockpit[index]! + 1,
                        healthyAtMs: index * 100 + cockpit[index]! + 1 + legacyDuration },
                cockpit: index % 2 === 0
                    ? { kind: 'healthy' as const, invokedAtMs: index * 100 + legacyDuration + 1,
                        healthyAtMs: index * 100 + legacyDuration + 1 + cockpit[index]! }
                    : { kind: 'healthy' as const, invokedAtMs: index * 100, healthyAtMs: index * 100 + cockpit[index]! },
            })),
        })),
    }
}

describe('startup comparison', () => {
    it('classifies fixture-derived states through the unchanged three canonical modes', () => {
        expect(mechanism.exports).toEqual(['COMPARISON_DATA_MODES', 'classifyStartupComparison'])
        const states = COMPARISON_DATA_MODES.map(mode => Object.freeze(Object.fromEntries(
            ['dataSha256', 'imageSha256', 'cacheSha256', 'lockSha256', 'resourceSha256', 'healthSha256']
                .map(field => [field, createHash('sha256').update(JSON.stringify({
                    fixtureId: alternate.fixture.fixtureId, inputs: alternate.fixture.subject.inputs, mode, field,
                })).digest('hex')]),
        ) as typeof state))
        const result = classifyStartupComparison(input(undefined, undefined, states))
        expect(result).toMatchObject({ kind: 'complete', verdict: 'PASS', satisfiesGate: true })
        if (result.kind === 'complete') expect(result.modes.every(row => row.pairs.length === 5)).toBe(true)
        const missingMode = structuredClone(input(undefined, undefined, states))
        missingMode.modes.pop()
        expect(classifyStartupComparison(missingMode)).toMatchObject({
            kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false,
        })
        expect(classifyStartupComparison(input([11, 13, 12, 14, 10], undefined, states)))
            .toMatchObject({ kind: 'complete', verdict: 'FAIL', satisfiesGate: false })
    })

    it('passes equal or faster medians per mode while retaining all alternating paired timings', () => {
        const result = classifyStartupComparison(input())
        expect(result).toMatchObject({ kind: 'complete', verdict: 'PASS', satisfiesGate: true })
        if (result.kind !== 'complete') throw new Error('expected startup classification')
        expect(result.modes).toEqual(['empty', 'seeded', 'restored'].map(mode => expect.objectContaining({
            mode, legacyMedianMs: 11, cockpitMedianMs: 10,
            pairs: expect.arrayContaining([expect.objectContaining({ pair: 1, legacyElapsedMs: 10, cockpitElapsedMs: 9 })]),
        })))
        expect(result.modes.every(row => row.pairs.length === 5)).toBe(true)
    })

    it('fails a planted one-millisecond slower framework median with zero tolerance', () => {
        expect(classifyStartupComparison(input([11, 13, 12, 14, 10])))
            .toMatchObject({ kind: 'complete', verdict: 'FAIL', satisfiesGate: false,
                modes: expect.arrayContaining([expect.objectContaining({ legacyMedianMs: 11, cockpitMedianMs: 12 })]) })
    })

    it.each([
        ['unavailable equivalence', (value: StartupComparisonInput) => value.modes[0]!.pairs[0]!.equivalence = { kind: 'unavailable', reason: 'state unavailable' }],
        ['failed health', (value: StartupComparisonInput) => value.modes[0]!.pairs[0]!.cockpit = { kind: 'timeout', reason: 'bounded timeout' }],
        ['missing pair', (value: StartupComparisonInput) => value.modes[0]!.pairs.pop()],
        ['order drift', (value: StartupComparisonInput) => value.modes[0]!.pairs[1]!.order = 'legacy-first'],
        ['invocation order drift', (value: StartupComparisonInput) => value.modes[0]!.pairs[1]!.legacy = {
            kind: 'healthy', invokedAtMs: 100, healthyAtMs: 112,
        }],
    ])('cannot count %s', (_label, mutate) => {
        const value = structuredClone(input())
        mutate(value)
        expect(classifyStartupComparison(value)).toMatchObject({ kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false })
    })
})
