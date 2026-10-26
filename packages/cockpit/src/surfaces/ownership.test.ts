import { installedPackageMetadata } from "../package-metadata.js"
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { classifySurfaceOwnership, removeSharedOwnership, renderSharedPostimage, type SurfaceDesiredEntry } from './ownership.js'
import { bindSurfaceOwnershipIdentity, captureLegacySharedOwnership, classifyGeneratedPaths, encodeOwnershipManifest, parseOwnershipManifest, projectGeneratedPathFacts } from './ownership.js'

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

const authority = { root: '/synthetic/cockpit', cockpitId: `cockpit:synthetic:${'a'.repeat(64)}`, configPath: '/synthetic/cockpit/cockpit.toml' }
const manifestInput = () => ({ ...authority, generation: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
    personaSource: { path: 'fixtures/personas.json', sha256: 'd'.repeat(64) },
    producedAt: '2026-10-22T12:00:00.000Z',
    owned: [{ path: 'generated.txt', sha256: digest('generated\n') }], surfaces: [] })

describe('generated ownership manifest', () => {
    it('keeps v2 producer facts unknown and rejects producer integrity and timestamp tampering', () => {
        const encoded = encodeOwnershipManifest(manifestInput())
        const { integrity: _integrity, producer: _producer, ...legacy } = JSON.parse(encoded.bytes)
        const payload = { ...legacy, format: 'cockpit-generated-ownership/v2' }
        expect(parseOwnershipManifest(JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) }), authority)).toMatchObject({
            kind: 'complete', manifest: { format: 'cockpit-generated-ownership/v2', producer: null, migratedFromV1: false },
        })
        expect(parseOwnershipManifest(encoded.bytes.replace('development', 'tampered'), authority)).toEqual({ kind: 'invalid' })
        const changed = JSON.parse(encoded.bytes)
        delete changed.integrity
        changed.producer.producedAt = '2026-02-30T12:00:00.000Z'
        expect(parseOwnershipManifest(JSON.stringify({ ...changed, integrity: digest(JSON.stringify(changed)) }), authority)).toEqual({ kind: 'invalid' })
    })
    it('refuses unknown authority fields at parsing and producer projection boundaries', () => {
        const encoded = encodeOwnershipManifest(manifestInput())
        const untrusted = { ...authority, extra: 'untrusted' }
        expect(parseOwnershipManifest(encoded.bytes, untrusted)).toEqual({ kind: 'invalid' })
        expect(projectGeneratedPathFacts(encoded.manifest, untrusted, [])).toMatchObject({
            kind: 'refusal', diagnostic: expect.objectContaining({ code: 'SURFACE_OWNERSHIP_INVALID' }),
        })
        expect(parseOwnershipManifest(encoded.bytes, authority)).toMatchObject({ kind: 'complete' })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [])).toMatchObject({ kind: 'complete' })
    })
    it('refuses duplicate JSON keys in manifest authority and shared foreign objects', () => {
        const encoded = encodeOwnershipManifest(manifestInput())
        const duplicated = encoded.bytes.replace('"source": {', '"source": { "path": "cockpit.toml",')
        expect(parseOwnershipManifest(duplicated, authority)).toMatchObject({ kind: 'invalid' })
        expect(renderSharedPostimage('{"theme":{"duplicate":1,"duplicate":2}}', opencode([{ key: 'instructions', valueBytes: '[]' }]))).toMatchObject({ kind: 'refusal' })
    })
    it('emits integrity-bound v3 producer facts and authenticates the enclosing authority', () => {
        const input = manifestInput()
        const payload = { format: 'cockpit-generated-ownership/v3', cockpitId: input.cockpitId, generation: input.generation,
            source: { path: 'cockpit.toml', sha256: input.sourceSha256 }, personaSource: input.personaSource,
            producer: { package: installedPackageMetadata.name, version: installedPackageMetadata.version, sourceRevision: installedPackageMetadata.cockpitSourceRevision, producedAt: input.producedAt },
            entries: [{ kind: 'file', path: 'generated.txt', ownership: 'whole-file', sha256: digest('generated\n') }] }
        const encoded = encodeOwnershipManifest(input)
        expect(encoded.bytes).toBe(`${JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) }, null, 2)}\n`)
        expect(parseOwnershipManifest(encoded.bytes, authority)).toMatchObject({ kind: 'complete', manifest: { migratedFromV1: false } })
        for (const changed of [{ ...authority, cockpitId: 'foreign' }, { ...authority, configPath: '/synthetic/cockpit/other.toml' }]) {
            expect(parseOwnershipManifest(encoded.bytes, changed)).toMatchObject({ kind: 'invalid' })
        }
        const unknown = { ...payload, extra: true }
        expect(parseOwnershipManifest(JSON.stringify({ ...unknown, integrity: digest(JSON.stringify(unknown)) }), authority)).toMatchObject({ kind: 'invalid' })
        expect(parseOwnershipManifest('{"format":"cockpit-generated-ownership/v4"}', authority)).toMatchObject({ kind: 'unsupported' })
        for (const bytes of ['{', '{"format":"another/v3"}']) expect(parseOwnershipManifest(bytes, authority)).toMatchObject({ kind: 'invalid' })
    })

    it('preserves legacy integrity and locale ordering while normalizing migrated rows', () => {
        const input = manifestInput()
        const payload = { format: 'cockpit-generated-ownership/v1', cockpitId: input.cockpitId, generation: input.generation,
            source: { path: 'cockpit.toml', sha256: input.sourceSha256 }, personaSource: input.personaSource,
            files: ['a.txt', 'Z.txt'].map(path => ({ path, ownership: 'whole-file', sha256: digest(path) })) }
        const bytes = JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) })
        const parsed = parseOwnershipManifest(bytes, authority)
        expect(parsed).toMatchObject({ kind: 'complete', manifest: { migratedFromV1: true,
            entries: [{ path: 'Z.txt', kind: 'file' }, { path: 'a.txt', kind: 'file' }] } })
        expect(parseOwnershipManifest(bytes.replace('a.txt', 'b.txt'), authority)).toMatchObject({ kind: 'invalid' })
    })

    it('joins immutable producer facts by exact identity and never authorizes historical absence', () => {
        const encoded = encodeOwnershipManifest(manifestInput())
        const entry = encoded.manifest.entries[0]!
        const declarations = [{ producer: 'generated-environment' as const, applicability: 'declared-before-sync' as const, entry }]
        const projected = projectGeneratedPathFacts(encoded.manifest, authority, declarations)
        expect(projected).toMatchObject({ kind: 'complete', facts: [{ path: entry.path, declaration: declarations[0], allowsMissing: true }] })
        if (projected.kind !== 'complete') throw new Error('expected producer facts')
        expect(Object.isFrozen(projected.facts)).toBe(true)
        expect(Object.isFrozen(projected.facts[0])).toBe(true)
        expect(Object.isFrozen(projected.facts[0]!.authority)).toBe(true)
        expect(Object.isFrozen(projected.facts[0]!.declaration)).toBe(true)
        expect(Object.isFrozen(projected.facts[0]!.entry)).toBe(true)
        expect(projectGeneratedPathFacts({ ...encoded.manifest }, authority, declarations)).toMatchObject({ kind: 'refusal' })
        expect(projectGeneratedPathFacts(encoded.manifest, { ...authority, root: '/foreign' }, declarations)).toMatchObject({ kind: 'refusal' })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [...declarations, ...declarations])).toMatchObject({ kind: 'refusal' })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [{ ...declarations[0], entry: { ...entry, sha256: digest('wrong') } }])).toMatchObject({ kind: 'refusal' })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [{ producer: 'generated-environment', applicability: 'declared-before-sync', path: entry.path }])).toMatchObject({ kind: 'refusal' })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [])).toMatchObject({ kind: 'complete', facts: [{ declaration: null, allowsMissing: false }] })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [{ ...declarations[0], applicability: 'required-after-sync' }])).toMatchObject({ kind: 'complete', facts: [{ allowsMissing: false }] })
        expect(projectGeneratedPathFacts(encoded.manifest, authority, [{ producer: 'surface-render', applicability: 'sibling-unavailable', path: entry.path }])).toMatchObject({ kind: 'complete', facts: [{ declaration: { applicability: 'sibling-unavailable' }, allowsMissing: false }] })
    })

    it('binds surface producer facts to shared hashes and complete symlink source identities', () => {
        const link: SurfaceDesiredEntry = { kind: 'symlink', path: 'guide.md', harnesses: ['codexcli'], scope: 'always',
            capability: 'instructed', writer: 'cockpit', schemaVersion: 1, ownership: 'symlink', target: '../sibling/AGENTS.md',
            source: { root: '/synthetic/sibling', path: '/synthetic/sibling/AGENTS.md', sha256: digest('guide'), identity: 'device:inode' } }
        const encoded = encodeOwnershipManifest({ ...manifestInput(), surfaces: [markdown(), link] })
        for (const entry of encoded.manifest.entries.filter(entry => 'harnesses' in entry)) {
            const declaration = { producer: 'surface-render', applicability: 'declared-before-sync', entry }
            const result = projectGeneratedPathFacts(encoded.manifest, authority, [declaration])
            expect(result.kind).toBe('complete')
            if (result.kind !== 'complete') throw new Error('expected surface facts')
            const fact = result.facts.find(fact => fact.path === entry.path)!
            expect(fact.allowsMissing).toBe(true)
            expect('harnesses' in fact.entry && Object.isFrozen(fact.entry.harnesses)).toBe(true)
            const changed = entry.kind === 'symlink' ? [
                { ...entry, target: '../other/AGENTS.md' },
                { ...entry, source: { ...entry.source, sha256: digest('wrong') } },
                { ...entry, source: { ...entry.source, identity: 'another inode' } },
            ] : entry.kind === 'shared-region' ? [{ ...entry, region: { ...entry.region, sha256: digest('wrong') } }] : []
            for (const tampered of changed) expect(projectGeneratedPathFacts(encoded.manifest, authority, [{ ...declaration, entry: tampered }])).toMatchObject({ kind: 'refusal' })
        }
        const payload = JSON.parse(encoded.bytes)
        delete payload.integrity
        payload.entries.push(payload.entries[0])
        expect(parseOwnershipManifest(JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) }), authority)).toMatchObject({ kind: 'invalid' })
    })
})

function markdown(bytes = 'generated\n', path: 'AGENTS.md' | 'CLAUDE.md' | 'CLAUDE.local.md' = 'AGENTS.md'): SurfaceDesiredEntry {
    return {
        kind: 'shared-region', path, harnesses: ['codexcli', 'opencode'], scope: 'always', capability: 'instructed',
        writer: 'cockpit', schemaVersion: 1, ownership: 'shared-region', regionId: 'cockpit-instructions',
        region: { format: 'markdown-delimited', begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->', bytes, sha256: digest(bytes) },
    }
}

function opencode(members: Array<{ key: string; valueBytes: string }>): SurfaceDesiredEntry {
    return {
        kind: 'shared-region', path: 'opencode.jsonc', harnesses: ['opencode'], scope: 'always', capability: 'instructed',
        writer: 'cockpit', schemaVersion: 1, ownership: 'shared-region', regionId: 'cockpit-opencode-root-properties',
        region: { format: 'opencode-json-root-properties', members, sha256: digest(JSON.stringify(members)) },
    }
}

describe('surface ownership', () => {
    it('requires sorted configured harness sets and refuses whole-file ownership of forced shared paths', () => {
        const entry = markdown()
        expect(classifySurfaceOwnership({ configuredHarnesses: ['codexcli', 'opencode'], entries: [entry] })).toMatchObject({ kind: 'complete' })
        expect(classifySurfaceOwnership({ configuredHarnesses: ['opencode', 'codexcli'], entries: [entry] })).toMatchObject({ kind: 'refusal' })
        expect(classifySurfaceOwnership({
            configuredHarnesses: ['codexcli'],
            entries: [{ kind: 'file', path: 'AGENTS.md', harnesses: ['codexcli'], scope: 'always', capability: 'instructed', writer: 'cockpit', schemaVersion: 1, ownership: 'whole-file', bytes: 'x', sha256: digest('x') }],
        })).toMatchObject({ kind: 'refusal' })
    })

    it('preserves every byte outside fixed Markdown markers and rejects ambiguous markers', () => {
        const entry = markdown('replacement\n')
        const before = 'human prefix\n<!-- cockpit:instructions:start -->\nold\n<!-- cockpit:instructions:end -->\nhuman suffix\n'
        const prior = { ...entry, region: { format: 'markdown-delimited' as const, begin: entry.kind === 'shared-region' && entry.region.format === 'markdown-delimited' ? entry.region.begin : '',
            end: entry.kind === 'shared-region' && entry.region.format === 'markdown-delimited' ? entry.region.end : '', sha256: digest('old\n') } }
        expect(renderSharedPostimage(before, entry, prior)).toEqual({
            kind: 'complete', bytes: 'human prefix\n<!-- cockpit:instructions:start -->\nreplacement\n<!-- cockpit:instructions:end -->\nhuman suffix\n',
        })
        expect(renderSharedPostimage('human\n<!-- cockpit:instructions:start -->\n', entry)).toMatchObject({ kind: 'refusal' })
        expect(renderSharedPostimage(`${before}<!-- cockpit:instructions:start -->\n<!-- cockpit:instructions:end -->\n`, entry)).toMatchObject({ kind: 'refusal' })
    })

    it('rejects reserved ownership markers in every forced Markdown body', () => {
        for (const path of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'] as const) {
            for (const marker of ['<!-- cockpit:instructions:start -->', '<!-- cockpit:instructions:end -->']) {
                expect(classifySurfaceOwnership({
                    configuredHarnesses: ['codexcli', 'opencode'],
                    entries: [markdown(`generated\n${marker}\n`, path)],
                })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_OWNERSHIP_INVALID' } })
            }
        }
    })

    it('owns one contiguous OpenCode root group and preserves strict JSON outside bytes', () => {
        const entry = opencode([{ key: 'instructions', valueBytes: '["AGENTS.md"]' }])
        expect(renderSharedPostimage('{\n  "theme": "dark"\n}\n', entry)).toEqual({
            kind: 'complete', bytes: '{"instructions":["AGENTS.md"],\n  "theme": "dark"\n}\n',
        })
        expect(renderSharedPostimage('{"instructions":[],"theme":"dark"}', entry)).toMatchObject({ kind: 'refusal' })
        expect(renderSharedPostimage('{"theme":"a","theme":"b"}', entry)).toMatchObject({ kind: 'refusal' })
        expect(renderSharedPostimage('{// comment\n"theme":"dark"}', entry)).toMatchObject({ kind: 'refusal' })
        expect(renderSharedPostimage('{"theme":"dark",}', entry)).toMatchObject({ kind: 'refusal' })

        const prior = {
            ...opencode([{ key: 'instructions', valueBytes: '[]' }]),
            region: { format: 'opencode-json-root-properties' as const, keys: ['instructions'], sha256: digest(JSON.stringify([{ key: 'instructions', valueBytes: '[]' }])) },
        }
        expect(renderSharedPostimage('{"instructions":[],"theme":"dark"}', entry, prior)).toEqual({
            kind: 'complete', bytes: '{"instructions":["AGENTS.md"],"theme":"dark"}',
        })
    })

    it('preserves formatted empty-object bytes through OpenCode replacement and removal', () => {
        const before = '{\n  }\n'
        const members = [{ key: 'instructions', valueBytes: '[]' }]
        const entry = opencode(members)
        const prior = {
            ...entry,
            region: { format: 'opencode-json-root-properties' as const, keys: ['instructions'], sha256: digest(JSON.stringify(members)) },
        }
        const inserted = renderSharedPostimage(before, entry)
        expect(inserted).toEqual({ kind: 'complete', bytes: '{"instructions":[]\n  }\n' })
        if (inserted.kind !== 'complete') throw new Error('expected OpenCode insertion to complete')
        expect(renderSharedPostimage(inserted.bytes, entry, prior)).toEqual(inserted)
        expect(removeSharedOwnership(inserted.bytes, prior)).toEqual({ kind: 'complete', bytes: before })
    })

    it('preserves whitespace around the owned OpenCode separator', () => {
        const priorMembers = [{ key: 'instructions', valueBytes: '[]' }]
        const prior = {
            ...opencode(priorMembers),
            region: { format: 'opencode-json-root-properties' as const, keys: ['instructions'], sha256: digest(JSON.stringify(priorMembers)) },
        }
        const existing = '{"instructions":[]  , \n  "theme":"dark"}'
        const replacement = opencode([{ key: 'instructions', valueBytes: '["AGENTS.md"]' }])
        expect(renderSharedPostimage(existing, replacement, prior)).toEqual({
            kind: 'complete', bytes: '{"instructions":["AGENTS.md"]  , \n  "theme":"dark"}',
        })
        expect(removeSharedOwnership(existing, prior)).toEqual({ kind: 'complete', bytes: '{   \n  "theme":"dark"}' })
    })

    it('refuses OpenCode expansion into an unowned key', () => {
        const priorMembers = [{ key: 'instructions', valueBytes: '[]' }]
        const prior = {
            ...opencode(priorMembers),
            region: { format: 'opencode-json-root-properties' as const, keys: ['instructions'], sha256: digest(JSON.stringify(priorMembers)) },
        }
        const expanded = opencode([
            { key: 'instructions', valueBytes: '[]' },
            { key: 'mcp', valueBytes: '{"generated":true}' },
        ])
        expect(renderSharedPostimage('{"instructions":[],"mcp":{"human":true}}', expanded, prior)).toMatchObject({
            kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT', target: 'opencode.jsonc' },
        })
    })

    it('returns conflicts for shortened prior OpenCode groups', () => {
        const expanded = opencode([
            { key: 'instructions', valueBytes: '[]' },
            { key: 'mcp', valueBytes: '{"generated":true}' },
        ])
        const fullPriorMembers = [
            { key: 'instructions', valueBytes: '[]' },
            { key: 'mcp', valueBytes: '{}' },
        ]
        const fullPrior = {
            ...opencode(fullPriorMembers),
            region: { format: 'opencode-json-root-properties' as const, keys: ['instructions', 'mcp'], sha256: digest(JSON.stringify(fullPriorMembers)) },
        }
        for (const shortened of ['{"instructions":[]}', '{}']) {
            expect(renderSharedPostimage(shortened, expanded, fullPrior)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT' } })
            expect(removeSharedOwnership(shortened, fullPrior)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT' } })
        }
    })
})

describe('confined generated ownership', () => {
    it('captures native backing bytes without executing byte accessors, iterators or proxy traps', () => {
        const manifest = encodeOwnershipManifest({ ...manifestInput(), owned: [{ path: 'raw.bin', sha256: digest(Uint8Array.of(1)) }] }).manifest
        const projected = projectGeneratedPathFacts(manifest, authority, [])
        if (projected.kind !== 'complete') throw new Error('expected ownership facts')
        const observe = (bytes: unknown) => classifyGeneratedPaths(projected.facts, [
            { path: 'raw.bin', kind: 'file', bytes, confinement: 'confined', identity: 'inode' },
        ])
        expect(observe(Uint8Array.of(1))).toMatchObject({ kind: 'complete', paths: [{ state: 'unchanged' }] })
        expect(observe(Buffer.from([1]))).toMatchObject({ kind: 'complete', paths: [{ state: 'unchanged' }] })
        expect(observe(Uint8Array.of(2))).toMatchObject({ kind: 'complete', paths: [{ state: 'modified', rawSha256: digest(Uint8Array.of(2)) }] })
        let executed = false
        const spoof = Uint8Array.of(2)
        Object.defineProperty(spoof, 'byteLength', { get: () => { executed = true; return 1 } })
        Object.defineProperty(spoof, Symbol.iterator, { value: function* () { executed = true; yield 1 } })
        const iterator = Uint8Array.of(2)
        Object.defineProperty(iterator, Symbol.iterator, { value: function* () { executed = true; yield 1 } })
        const accessor = Uint8Array.of(2)
        Object.defineProperty(accessor, 'extra', { get: () => { executed = true; return 1 } })
        const symbol = Uint8Array.of(2)
        Object.defineProperty(symbol, Symbol('extra'), { value: 1 })
        const proxy = new Proxy(Uint8Array.of(2), { get: () => { executed = true; throw new Error('byte trap invoked') } })
        for (const bytes of [spoof, iterator, accessor, symbol, proxy, new (class extends Uint8Array {})([2])]) {
            expect(observe(bytes)).toMatchObject({ kind: 'complete', paths: [{ state: 'unknown', diagnostics: [
                expect.objectContaining({ code: 'SURFACE_STATE_CONFLICT', target: 'raw.bin' }),
            ] }] })
            expect(executed).toBe(false)
        }
    })
    it('classifies raw invalid UTF-8 bytes and distinguishes missing, modified and unknown without mutation', () => {
        const bytes = Uint8Array.from([0xc3, 0x28])
        const manifest = encodeOwnershipManifest({ ...manifestInput(), owned: [{ path: 'raw.bin', sha256: digest(bytes) }] }).manifest
        const projected = projectGeneratedPathFacts(manifest, authority, [{ producer: 'generated-environment', applicability: 'declared-before-sync', entry: manifest.entries[0] }])
        if (projected.kind !== 'complete') throw new Error('expected facts')
        const observe = (row: unknown) => classifyGeneratedPaths(projected.facts, [row])
        expect(observe({ path: 'raw.bin', kind: 'file', bytes, confinement: 'confined', identity: 'inode' })).toMatchObject({ kind: 'complete', paths: [{ state: 'unchanged' }] })
        expect(observe({ path: 'raw.bin', kind: 'file', bytes: Uint8Array.of(0xff), confinement: 'confined', identity: 'inode' })).toMatchObject({ kind: 'complete', paths: [{ state: 'modified' }] })
        expect(observe({ path: 'raw.bin', kind: 'missing', confinement: 'confined' })).toMatchObject({ kind: 'complete', paths: [{ state: 'missing', diagnostics: [] }] })
        for (const confinement of ['escaping', 'dangling', 'unknown']) {
            expect(observe({ path: 'raw.bin', kind: 'file', bytes, confinement, identity: 'inode' })).toMatchObject({ kind: 'complete', paths: [{ state: 'unknown', diagnostics: [expect.objectContaining({ target: 'raw.bin' })] }] })
        }
        expect(classifyGeneratedPaths([{ ...projected.facts[0] }], [])).toMatchObject({ kind: 'refusal' })
        const required = projectGeneratedPathFacts(manifest, authority, [{ producer: 'generated-environment', applicability: 'required-after-sync', entry: manifest.entries[0] }])
        if (required.kind !== 'complete') throw new Error('expected facts')
        expect(classifyGeneratedPaths(required.facts, [{ path: 'raw.bin', kind: 'missing', confinement: 'confined' }])).toMatchObject({ kind: 'complete', paths: [{ state: 'missing', diagnostics: [expect.objectContaining({ target: 'raw.bin' })] }] })
        expect(bytes).toEqual(Uint8Array.from([0xc3, 0x28]))
    })

    it('rejects undecodable shared bytes and dangling or escaping symlink observations', () => {
        const link: SurfaceDesiredEntry = { kind: 'symlink', path: 'guide.md', harnesses: ['codexcli'], scope: 'always', capability: 'instructed',
            writer: 'cockpit', schemaVersion: 1, ownership: 'symlink', target: '../sibling/AGENTS.md',
            source: { root: '/synthetic/sibling', path: '/synthetic/sibling/AGENTS.md', sha256: digest('guide'), identity: 'inode' } }
        const manifest = encodeOwnershipManifest({ ...manifestInput(), owned: [], surfaces: [markdown(), link] }).manifest
        const projected = projectGeneratedPathFacts(manifest, authority, [])
        if (projected.kind !== 'complete') throw new Error('expected facts')
        const rows = [{ path: 'AGENTS.md', kind: 'file', bytes: Uint8Array.of(0xff), confinement: 'confined', identity: 'inode' },
            { path: 'guide.md', kind: 'symlink', target: link.target, source: link.source, confinement: 'confined', identity: 'link-inode' }]
        expect(classifyGeneratedPaths(projected.facts, rows)).toMatchObject({ kind: 'complete', paths: [{ state: 'unknown' }, { state: 'unchanged' }] })
        for (const confinement of ['dangling', 'escaping']) expect(classifyGeneratedPaths(projected.facts, [rows[0], { ...rows[1], confinement }])).toMatchObject({ kind: 'complete', paths: [{ state: 'unknown' }, { state: 'unknown' }] })
    })
})

describe('identity-bearing shared ownership', () => {
    function bound(entry: SurfaceDesiredEntry): SurfaceDesiredEntry {
        const result = bindSurfaceOwnershipIdentity([entry], authority.cockpitId)
        if (result.kind !== 'complete') throw new Error('expected identity binding')
        return result.entries[0]!
    }

    it('authenticates legacy whole-file shared migration from exact raw bytes', () => {
        const original = markdown()
        const rendered = renderSharedPostimage('', original)
        if (rendered.kind !== 'complete') throw new Error('expected legacy bytes')
        const input = manifestInput()
        const payload = { format: 'cockpit-generated-ownership/v1', cockpitId: authority.cockpitId,
            generation: input.generation, source: { path: 'cockpit.toml', sha256: input.sourceSha256 }, personaSource: input.personaSource,
            files: [{ path: original.path, ownership: 'whole-file', sha256: digest(rendered.bytes) }] }
        const parsed = parseOwnershipManifest(JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) }), authority)
        if (parsed.kind !== 'complete') throw new Error('expected authenticated legacy manifest')
        const desired = bound(original)
        const prior = captureLegacySharedOwnership(Buffer.from(rendered.bytes), desired, parsed.manifest)
        expect(prior).toMatchObject({ kind: 'shared-region', region: { sha256: digest('generated\n') } })
        expect(renderSharedPostimage(rendered.bytes, desired, prior, parsed.manifest)).toMatchObject({ kind: 'complete' })
        expect(captureLegacySharedOwnership(Buffer.from(`${rendered.bytes}tamper`), desired, parsed.manifest)).toBeUndefined()
        expect(captureLegacySharedOwnership(Buffer.from(rendered.bytes), desired, { ...parsed.manifest })).toBeUndefined()
    })

    it('reconciles authenticated legacy Markdown once and refuses copied, partial, duplicated and injected owner markers', () => {
        const legacy = markdown()
        const old = encodeOwnershipManifest({ ...manifestInput(), owned: [], surfaces: [legacy] }).manifest
        const entry = bound(legacy)
        const current = encodeOwnershipManifest({ ...manifestInput(), owned: [], surfaces: [entry] }).manifest
        const before = 'prefix\n<!-- cockpit:instructions:start -->\ngenerated\n<!-- cockpit:instructions:end -->\nsuffix\n'
        const rendered = renderSharedPostimage(before, entry, old.entries[0], old)
        const ownerBegin = `<!-- cockpit:owner:${authority.cockpitId}:start -->`
        const ownerEnd = `<!-- cockpit:owner:${authority.cockpitId}:end -->`
        expect(rendered).toEqual({ kind: 'complete', bytes: `prefix\n<!-- cockpit:instructions:start -->\n${ownerBegin}\ngenerated\n${ownerEnd}\n<!-- cockpit:instructions:end -->\nsuffix\n` })
        if (rendered.kind !== 'complete') throw new Error('expected reconciliation')
        expect(renderSharedPostimage(rendered.bytes, entry, current.entries[0], current)).toEqual(rendered)
        expect(removeSharedOwnership(rendered.bytes, current.entries[0]!, current)).toEqual({ kind: 'complete', bytes: 'prefix\n\nsuffix\n' })
        for (const changed of [rendered.bytes.replaceAll(authority.cockpitId, `cockpit:foreign:${'f'.repeat(64)}`),
            rendered.bytes.replace(ownerEnd, ''), rendered.bytes.replace(ownerBegin, `${ownerBegin}\n${ownerBegin}`),
            rendered.bytes.replace('generated', 'tampered'), rendered.bytes.replace('generated', `generated\n${ownerBegin}`)]) {
            expect(renderSharedPostimage(changed, entry, current.entries[0], current)).toMatchObject({ kind: 'refusal' })
            expect(removeSharedOwnership(changed, current.entries[0]!, current)).toMatchObject({ kind: 'refusal' })
        }
        expect(renderSharedPostimage(before, entry, old.entries[0], { ...old })).toMatchObject({ kind: 'refusal' })
        expect(bindSurfaceOwnershipIdentity([markdown(`injected\n${ownerBegin}\n`)], authority.cockpitId)).toMatchObject({ kind: 'refusal' })
    })

    it('marks the contiguous OpenCode group while preserving foreign bytes and rejecting foreign or ambiguous comments', () => {
        const entry = bound(opencode([{ key: 'instructions', valueBytes: '[]' }]))
        const manifest = encodeOwnershipManifest({ ...manifestInput(), owned: [], surfaces: [entry] }).manifest
        const legacy = encodeOwnershipManifest({ ...manifestInput(), owned: [], surfaces: [opencode([{ key: 'instructions', valueBytes: '[]' }])] }).manifest
        const before = '{"instructions":[]  , \n "theme":"dark", "z": 1}\n'
        const start = `/* cockpit:owner:${authority.cockpitId}:start */`
        const end = `/* cockpit:owner:${authority.cockpitId}:end */`
        const rendered = renderSharedPostimage(before, entry, legacy.entries[0], legacy)
        expect(rendered).toEqual({ kind: 'complete', bytes: `{${start}"instructions":[]${end}  , \n "theme":"dark", "z": 1}\n` })
        if (rendered.kind !== 'complete') throw new Error('expected OpenCode reconciliation')
        expect(renderSharedPostimage(rendered.bytes, entry, manifest.entries[0], manifest)).toEqual(rendered)
        expect(removeSharedOwnership(rendered.bytes, manifest.entries[0]!, manifest)).toEqual({ kind: 'complete', bytes: '{   \n "theme":"dark", "z": 1}\n' })
        for (const changed of [rendered.bytes.replaceAll(authority.cockpitId, `cockpit:foreign:${'f'.repeat(64)}`),
            rendered.bytes.replace(end, ''), rendered.bytes.replace(start, `${start}${start}`),
            rendered.bytes.replace(start, '').replace(end, ''),
            rendered.bytes.replace('[]', '["tampered"]'), rendered.bytes.replace('"theme"', '/* arbitrary */"theme"'),
            rendered.bytes.replace('"z": 1', '"theme": "other"'), rendered.bytes.replace('1}', '1,}')]) {
            expect(renderSharedPostimage(changed, entry, manifest.entries[0], manifest)).toMatchObject({ kind: 'refusal' })
        }
        const expanded = bound(opencode([{ key: 'instructions', valueBytes: '[]' }, { key: 'mcp', valueBytes: '{}' }]))
        expect(renderSharedPostimage(rendered.bytes.replace('"z": 1', '"mcp": {}'), expanded, manifest.entries[0], manifest)).toMatchObject({ kind: 'refusal' })
    })
})
