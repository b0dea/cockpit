import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { resolveNamedPath } from './named.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const authority = { root: '/synthetic/cockpit', cockpitId: 'synthetic', configPath: '/synthetic/cockpit/cockpit.toml' }
const encoded = encodeOwnershipManifest({ ...authority, generation: digest('generation'), sourceSha256: digest('source'),
    owned: [{ path: 'compose.generated.yml', sha256: digest('compose') }], surfaces: [] })
const manifest = encoded.manifest
const entry = manifest.entries[0]!
const declarations = [{ producer: 'generated-environment' as const, applicability: 'declared-before-sync' as const, entry }]
const base = { authority, manifest, declarations }

describe('typed named reference resolution', () => {
    it('allows only exact declared applicable generated absence across the four generated-absence controls', () => {
        expect(resolveNamedPath({ ...base, path: entry.path, exists: false })).toMatchObject({ kind: 'declared-before-sync', producer: 'generated-environment' })
        expect(resolveNamedPath({ ...base, path: 'compose.genereted.yml', exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, declarations: [{ producer: 'generated-environment', applicability: 'sibling-unavailable', path: entry.path }], path: entry.path, exists: false })).toMatchObject({ kind: 'unavailable' })
        expect(resolveNamedPath({ ...base, declarations: [{ ...declarations[0], applicability: 'required-after-sync' }], path: entry.path, exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, declarations: [], path: entry.path, exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, manifest: { ...manifest }, path: entry.path, exists: false })).toMatchObject({ kind: 'refusal' })
        expect(resolveNamedPath({ ...base, path: entry.path, exists: true })).toMatchObject({ kind: 'resolved' })
    })
})
