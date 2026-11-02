import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { inspectProseReferences, walkMarkdownProse, type ProsePathState, type ProseReferenceAuthority } from '../../../../scripts/docs-lint.mjs'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { resolveNamedPath, type NamedPathInput } from './named.js'

type NamedReferenceInput = Omit<NamedPathInput, 'path' | 'exists'> & {
    documentPath: string; body: string; references: ProseReferenceAuthority
    existing: readonly { path: string; body?: string }[]; today?: string
}

// The repository checker's composition: a path resolves through the generated-path authority, and an
// existing document carrying a retired marker reads as retired.
function inspectNamedReferences({ documentPath, body, references, existing, today, ...named }: NamedReferenceInput) {
    const resolvePath = (path: string): ProsePathState => {
        const entry = existing.find(candidate => candidate.path === path)
        const resolution = resolveNamedPath({ ...named, path, exists: entry !== undefined })
        if (resolution.kind === 'refusal') return 'missing'
        if (resolution.kind !== 'resolved') return resolution.kind
        if (entry?.body !== undefined && walkMarkdownProse(path, entry.body).lines
            .some(row => row.comments.some(comment => /^cockpit:retired(?: |$)/.test(comment)))) return 'retired'
        return 'present'
    }
    return inspectProseReferences({ path: documentPath, body, authority: references, resolvePath, ...(today === undefined ? {} : { today }) })
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const authority = { root: '/synthetic/cockpit', cockpitId: 'synthetic', configPath: '/synthetic/cockpit/cockpit.toml' }
const encoded = encodeOwnershipManifest({ ...authority, generation: digest('generation'), sourceSha256: digest('source'),
    personaSource: { path: 'personas.json', sha256: digest('personas') }, owned: [{ path: 'compose.generated.yml', sha256: digest('compose') }], surfaces: [] })
const manifest = encoded.manifest
const entry = manifest.entries[0]!
const declarations = [{ producer: 'generated-environment' as const, applicability: 'declared-before-sync' as const, entry }]
const base = { authority, manifest, declarations }
const referenceAuthority = { commands: new Set(['sync']), diagnostics: new Set(['SYNTHETIC_FAILURE']), identifiers: new Set(['DOCKER_CONTEXT']), flags: new Set(['--json']) }

describe('typed named reference resolution', () => {
    it('allows only exact declared applicable generated absence across the four A08 controls', () => {
        expect(resolveNamedPath({ ...base, path: entry.path, exists: false })).toMatchObject({ kind: 'declared-before-sync', producer: 'generated-environment' })
        expect(resolveNamedPath({ ...base, path: 'compose.genereted.yml', exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, declarations: [{ producer: 'generated-environment', applicability: 'sibling-unavailable', path: entry.path }], path: entry.path, exists: false })).toMatchObject({ kind: 'unavailable' })
        expect(resolveNamedPath({ ...base, declarations: [{ ...declarations[0], applicability: 'required-after-sync' }], path: entry.path, exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, declarations: [], path: entry.path, exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, manifest: { ...manifest }, path: entry.path, exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, path: entry.path, exists: true })).toMatchObject({ kind: 'resolved' })
    })

    it('shares prose resolution for commands, flags, diagnostic codes and declared paths', () => {
        const result = inspectNamedReferences({ ...base, documentPath: 'docs/synthetic.md',
            body: '# Synthetic\n\nRun `cockpit sync`. Use `--json`, `SYNTHETIC_FAILURE` and `compose.generated.yml`. Version `16.17.0` is informational.\n',
            existing: [], authority: base.authority, references: referenceAuthority })
        expect(result).toEqual([])
        const failures = inspectNamedReferences({ ...base, documentPath: 'docs/synthetic.md',
            body: 'Run `cockpit typo`. Use `--typo` and `TYPO_FAILURE`. See `docs/missing.md`.\n', existing: [], references: referenceAuthority })
        expect(failures.map(row => row.message)).toEqual(expect.arrayContaining([
            expect.stringContaining('cockpit typo'), expect.stringContaining('--typo'), expect.stringContaining('TYPO_FAILURE'), expect.stringContaining('docs/missing.md'),
        ]))
    })

    it.each(['```', '~~~'])('keeps examples and raw elements inert using %s fences', fence => {
        const body = `${fence}md\nRun \`cockpit typo\`. \`TYPO_FAILURE\` \`--typo\` \`docs/missing.md\`\n${fence}\n<template>\n\`TYPO_FAILURE\`\n</template>\nRun \`cockpit sync\`.\n`
        expect(inspectNamedReferences({ ...base, documentPath: 'docs/synthetic.md', body, existing: [], references: referenceAuthority })).toEqual([])
    })

    it('rejects malformed fence transitions instead of treating their contents as visible prose', () => {
        const errors = inspectNamedReferences({ ...base, documentPath: 'docs/synthetic.md', body: '```md\n~~~\n`TYPO_FAILURE`\n', existing: [], references: referenceAuthority })
        expect(errors).toMatchObject([{ code: 'DOC031_UNCLOSED_FENCE', line: 1 }])
    })

    it('checks structured comment references without interpreting ordinary comments or fenced directives', () => {
        const body = '<!-- ordinary `TYPO_FAILURE` -->\n<!-- cockpit:ref path=docs/missing.md -->\n~~~md\n<!-- cockpit:ref path=docs/ignored.md -->\n~~~\n'
        const errors = inspectNamedReferences({ ...base, documentPath: 'docs/synthetic.md', body, existing: [], references: referenceAuthority })
        expect(errors).toMatchObject([{ line: 2, message: expect.stringContaining('docs/missing.md') }])
    })

    it.each([
        { kind: 'reference', body: 'Read the guide.\n<!-- cockpit:ref\n path=docs/missing.md -->\n', existing: [], code: 'DOCEV050_NAMED_REFERENCE_MISSING', message: 'docs/missing.md' },
        { kind: 'hazard', body: 'Read the guide.\n<!-- cockpit:hazard\n expires=2026-10-01 -->\n', existing: [], code: 'REFERENCE_HAZARD_EXPIRED', message: '2026-10-01' },
        { kind: 'retirement', body: 'Read the guide.\nRead `docs/old.md`.\n', existing: [{ path: 'docs/old.md', body: '<!-- cockpit:retired\n replacement=docs/current.md -->\n' }], code: 'REFERENCE_RETIRED', message: 'docs/old.md' },
    ])('checks a multiline $kind directive through the shared walker', ({ body, existing, code, message }) => {
        expect(inspectNamedReferences({ ...base, documentPath: 'AGENTS.md', body, existing, references: referenceAuthority, today: '2026-10-22' }))
            .toMatchObject([{ code, line: 2, message }])
    })

    it('keeps multiline ordinary comments and structured examples inert', () => {
        for (const fence of ['```', '~~~']) {
            const directives = '<!-- cockpit:ref\n path=docs/missing.md -->\n<!-- cockpit:hazard\n expires=2026-10-01 -->\n'
            const retired = '<!-- cockpit:retired\n replacement=docs/old.md -->\n'
            const body = '<!-- ordinary\nRun `cockpit typo`. `TYPO_FAILURE` `--typo` `docs/missing.md`\n-->\n'
                + `${fence}md\n${directives}${fence}\n<template>\n${directives}</template>\nRead \`docs/current.md\`.\n`
            const existing = [{ path: 'docs/current.md', body: `${fence}md\n${retired}${fence}\n<template>\n${retired}</template>\n` }]
            expect(inspectNamedReferences({ ...base, documentPath: 'AGENTS.md', body, existing, references: referenceAuthority, today: '2026-10-22' })).toEqual([])
        }
    })

    it('refuses an unterminated multiline structured directive', () => {
        const body = '<!-- cockpit:ref\n path=compose.generated.yml\n'
        expect(inspectNamedReferences({ ...base, documentPath: 'AGENTS.md', body, existing: [], references: referenceAuthority }))
            .toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING', line: 1, message: expect.stringContaining('not closed') }])
    })

    it('refuses retired citations and checkably expired hazards, leaving non-checkable conditions explicit', () => {
        const existing = [{ path: 'docs/old.md', body: '<!-- cockpit:retired replacement=docs/current.md -->\n' }]
        const body = 'Read `docs/old.md`.\n<!-- cockpit:hazard expires=2026-10-01 -->\n<!-- cockpit:hazard expires=when-vendor-changes -->\n'
        const errors = inspectNamedReferences({ ...base, documentPath: 'AGENTS.md', body, existing, references: referenceAuthority, today: '2026-10-22' })
        expect(errors).toMatchObject([{ code: 'REFERENCE_RETIRED', line: 1 }, { code: 'REFERENCE_HAZARD_EXPIRED', line: 2 }])
    })
})
