import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { mergeSurfaceDeclarations, surfaceDeclarationSha256 } from './merge.js'

const source = (path: string, bytes: string) => ({ path, bytes })
const declaration = (name: string, feature: 'rules' | 'skills', bytes: string, path = `${feature}/${name}.md`) => ({
    name,
    feature,
    sources: [source(path, bytes)],
    source: `surfaces/${name}.json`,
})

describe('surface merge authority', () => {
    it('selects a named overlay without mutation and reports changed core provenance', () => {
        const original = declaration('review', 'skills', 'core bytes', 'skills/review/SKILL.md')
        const overlay = {
            ...declaration('review', 'skills', 'overlay bytes', 'skills/review/SKILL.md'),
            replaces: { name: 'review', sha256: '0'.repeat(64) },
        }
        const core = [original]
        const overlays = [overlay]

        const result = mergeSurfaceDeclarations(core, overlays)

        expect(result).toEqual({
            kind: 'complete',
            surfaces: [overlay],
            overrides: [{
                name: 'review',
                feature: 'skills',
                originalSha256: surfaceDeclarationSha256(original),
                recordedSha256: '0'.repeat(64),
                overlaySource: 'surfaces/review.json',
            }],
            findings: [{
                code: 'OVERRIDDEN_CORE_CHANGED',
                name: 'review',
                recordedSha256: '0'.repeat(64),
                currentSha256: surfaceDeclarationSha256(original),
                overlaySource: 'surfaces/review.json',
            }],
        })
        expect(core).toEqual([original])
        expect(overlays).toEqual([overlay])
    })

    it('accepts a custom consumer surface without requiring a core declaration', () => {
        const custom = declaration('consumer-guide', 'rules', 'consumer bytes')
        expect(mergeSurfaceDeclarations([], [custom])).toMatchObject({
            kind: 'complete',
            surfaces: [custom],
            overrides: [],
            findings: [],
        })
    })

    it.each([
        ['duplicate core name', [declaration('same', 'rules', 'one'), declaration('same', 'rules', 'two')], []],
        ['different feature for one name', [declaration('same', 'rules', 'one')], [declaration('same', 'skills', 'two')]],
        ['conflicting path ownership', [declaration('one', 'rules', 'one', 'rules/shared.md')], [declaration('two', 'rules', 'two', 'rules/shared.md')]],
        ['traversal', [declaration('unsafe', 'rules', 'one', '../outside.md')], []],
    ])('refuses %s', (_label, core, overlays) => {
        expect(mergeSurfaceDeclarations(core, overlays)).toMatchObject({ kind: 'refusal' })
    })

    it.each([
        ['cross-feature sources', declaration('mixed', 'rules', 'bytes', 'skills/mixed/SKILL.md')],
        ['unknown source namespace', declaration('unknown', 'rules', 'bytes', 'guide.md')],
        ['missing skill definition', declaration('incomplete', 'skills', 'bytes', 'skills/incomplete/references/use.md')],
    ])('refuses %s before admitting merged sources', (_label, value) => {
        expect(mergeSurfaceDeclarations([value], [])).toMatchObject({ kind: 'refusal' })
        expect(mergeSurfaceDeclarations([], [value])).toMatchObject({ kind: 'refusal' })
    })

    it.each(['mcp', 'permissions'] as const)('keeps %s authority in core and refuses raw consumer overrides', (feature) => {
        const value = {
            name: 'authority', feature, source: 'surfaces/authority.json',
            sources: [{ path: feature === 'mcp' ? 'mcp.jsonc' : 'permissions.jsonc', bytes: '{}' }],
        }
        expect(mergeSurfaceDeclarations([value], [])).toMatchObject({ kind: 'complete' })
        expect(mergeSurfaceDeclarations([], [value])).toMatchObject({ kind: 'refusal' })
        expect(mergeSurfaceDeclarations([value], [{
            ...value, replaces: { name: value.name, sha256: surfaceDeclarationSha256(value) },
        }])).toMatchObject({ kind: 'refusal' })
    })

    it('refuses accessor, proxy, and oversized inputs without invoking caller code', () => {
        let reads = 0
        const accessor = Object.defineProperty({}, 'name', {
            enumerable: true,
            get: () => { reads += 1; return 'unsafe' },
        })
        expect(mergeSurfaceDeclarations([accessor] as never, [])).toMatchObject({ kind: 'refusal' })
        expect(mergeSurfaceDeclarations(new Proxy([], {
            get: () => { reads += 1; throw new Error('must not run') },
        }), [])).toMatchObject({ kind: 'refusal' })
        expect(mergeSurfaceDeclarations([declaration('large', 'rules', 'x'.repeat(65_537))], [])).toMatchObject({
            kind: 'refusal',
        })
        expect(reads).toBe(0)
    })

    it('hashes the exact neutral declaration rather than only its source bytes', () => {
        const value = declaration('review', 'skills', 'same', 'skills/review/SKILL.md')
        expect(surfaceDeclarationSha256(value)).toBe(createHash('sha256').update(JSON.stringify(value)).digest('hex'))
        expect(surfaceDeclarationSha256({ ...value, name: 'other' })).not.toBe(surfaceDeclarationSha256(value))
    })
})
