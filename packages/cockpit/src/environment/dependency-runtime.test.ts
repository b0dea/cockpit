import { describe, expect, it } from 'vitest'

import { createDependencyRuntimePlan } from './dependency-runtime.js'

describe('dependency runtime authority', () => {
    it('refuses forged, accessor-backed, and replay-shaped runtime projections without evaluating input', () => {
        expect(createDependencyRuntimePlan({ runtime: {} as never })).toMatchObject({
            kind: 'refusal', code: 'DEPENDENCY_RUNTIME_UNAVAILABLE',
        })
        let reads = 0
        const accessor = Object.defineProperty({}, 'runtime', {
            enumerable: true,
            get() { reads += 1; return {} },
        })
        expect(createDependencyRuntimePlan(accessor as never)).toMatchObject({
            kind: 'refusal', code: 'DEPENDENCY_RUNTIME_UNAVAILABLE',
        })
        expect(reads).toBe(0)
    })
})
