import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { GeneratedSurfaceSelftestProjection } from '../environment/generated-application/shared.js'
import { classifySurfaceOwnership, type SurfaceDesiredEntry } from './ownership.js'
import {
    planSurfaceSelftest,
    surfaceSelftestExpectation,
    surfaceSelftestHumanNeeded,
    surfaceSelftestReviews,
    type SelftestProbeSpecification,
} from './selftest.js'

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function file(path: string, harness: 'claudecode' | 'codexcli' | 'opencode'): SurfaceDesiredEntry {
    const skill = path.split('/').at(-2)!
    const bytes = `---\nname: ${skill}\n---\nSynthetic ${skill} skill.\n`
    return Object.freeze({
        kind: 'file', ownership: 'whole-file', path, harnesses: Object.freeze([harness] as const),
        scope: 'always', capability: 'instructed', writer: 'cockpit', schemaVersion: 1,
        bytes, sha256: sha256(bytes),
    })
}

function projection(): GeneratedSurfaceSelftestProjection {
    const configuredHarnesses = Object.freeze(['claudecode', 'codexcli', 'opencode'])
    const entries = ['alpha', 'bootstrap', 'zeta'].flatMap((skill) => [
        file(`.agents/skills/${skill}/SKILL.md`, 'codexcli'),
        file(`.claude/skills/${skill}/SKILL.md`, 'claudecode'),
        file(`.opencode/skills/${skill}/skill.md`, 'opencode'),
    ]).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const ownership = classifySurfaceOwnership({ configuredHarnesses, entries })
    if (ownership.kind !== 'complete') throw new Error(ownership.diagnostic.message)
    const payload = {
        schema: 'cockpit-generated-surface-selftest/v1' as const, configuredHarnesses, entries: ownership.entries,
    }
    return Object.freeze({ ...payload, manifestSha256: sha256(JSON.stringify(payload)) })
}

function specifications(source: GeneratedSurfaceSelftestProjection): readonly SelftestProbeSpecification[] {
    const expectation = surfaceSelftestExpectation(source)!
    return expectation.cells.map((cell) => ({
        harness: cell.harness,
        capability: cell.capability,
        invocation: ['{executable}', '--probe', cell.capability, '{control}'],
        versionCommand: ['{executable}', '--version'],
        helpCommand: ['{executable}', '--help'],
        candidateCode: cell.capability === 'guard-firing' ? 'GUARD_FIRED'
            : cell.capability === 'skill-parity' ? 'SKILL_PARITY_CANARY' : 'INSTRUCTION_CANARY',
        brokenCode: 'BROKEN_CONTROL_REJECTED',
        unavailableCode: `${cell.capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`,
        sample: cell.capability === 'skill-parity'
            ? { skill: cell.skill, features: ['name', 'trigger', 'body-load', 'tools', 'non-goals'] }
            : null,
    }))
}

describe('surface selftest planning', () => {
    it('keeps unavailable shipped harnesses in the estate without inventing native probe cells', () => {
        const source = projection()
        const payload = { ...source, configuredHarnesses: [...source.configuredHarnesses, 'cursor', 'grokcli'].sort() }
        const complete = { ...payload, manifestSha256: sha256(JSON.stringify({
            schema: payload.schema, configuredHarnesses: payload.configuredHarnesses, entries: payload.entries,
        })) }
        const expectation = surfaceSelftestExpectation(complete)
        expect(expectation).toBeDefined()
        expect(expectation?.cells.some(cell => ['cursor', 'grokcli'].includes(cell.harness.target))).toBe(false)
    })

    it('derives the closed built-in matrix and refuses altered source authority', () => {
        const source = projection()
        const expectation = surfaceSelftestExpectation(source)
        expect(expectation).toEqual(expect.objectContaining({
            generatedManifestSha256: source.manifestSha256,
            shippedSkills: ['alpha', 'bootstrap', 'zeta'],
            cells: expect.arrayContaining([
                expect.objectContaining({ capability: 'instruction-loading' }),
                expect.objectContaining({ capability: 'guard-firing' }),
                expect.objectContaining({ capability: 'skill-parity' }),
            ]),
        }))
        expect(expectation?.cells).toHaveLength(15)
        expect(surfaceSelftestExpectation({ ...source, manifestSha256: '0'.repeat(64) })).toBeUndefined()
    })

    it('requires exact probe coverage and preserves operator-only remainders', () => {
        const source = projection()
        const specs = specifications(source)
        const planned = planSurfaceSelftest(source, specs)
        expect(planned.kind).toBe('complete')
        if (planned.kind !== 'complete') return
        expect(planned.probes).toHaveLength(15)
        expect(planSurfaceSelftest(source, specs.slice(1))).toEqual(expect.objectContaining({ kind: 'refusal' }))
        expect(planSurfaceSelftest(source, [...specs.slice(0, -1), specs[0]!])).toEqual(expect.objectContaining({ kind: 'refusal' }))

        expect(surfaceSelftestHumanNeeded(
            planned.expectation, planned.expectation.cells[0]!, 'authentication_required',
            '2026-09-27T10:00:00.000Z', 'Authenticate the harness and rerun the probe',
        )).toEqual(expect.objectContaining({ kind: 'human_needed', reason: 'authentication_required' }))
        expect(surfaceSelftestReviews(planned.expectation, [])).toHaveLength(6)
    })
})
