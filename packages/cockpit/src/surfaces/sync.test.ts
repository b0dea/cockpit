import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { SurfaceDesiredEntry, SurfacePriorOwnedEntry } from './ownership.js'
import { planSurfaceChanges } from './sync.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const base = { harnesses: ['codexcli'] as ['codexcli'], scope: 'always' as const, capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const }
const desiredFile = (path: string, bytes: string): SurfaceDesiredEntry => ({ ...base, kind: 'file', ownership: 'whole-file', path, bytes, sha256: digest(bytes) })
const priorFile = (path: string, bytes: string): SurfacePriorOwnedEntry => ({ ...base, kind: 'file', ownership: 'whole-file', path, sha256: digest(bytes) })

describe('surface change planning', () => {
    it('orders desired writes before exact stale removals and records missing stale ownership as already absent', () => {
        const result = planSurfaceChanges({
            configuredHarnesses: ['codexcli'], desired: [desiredFile('new.txt', 'new')],
            priorOwned: [priorFile('gone.txt', 'old'), priorFile('stale.txt', 'old')],
            observed: [
                { path: 'gone.txt', kind: 'missing' },
                { path: 'new.txt', kind: 'missing' },
                { path: 'stale.txt', kind: 'file', bytes: 'old', sha256: digest('old'), identity: 'file:1' },
            ],
        })
        expect(result).toMatchObject({ kind: 'complete', actions: [
            { kind: 'write', path: 'new.txt' },
            { kind: 'already-absent', path: 'gone.txt' },
            { kind: 'remove', path: 'stale.txt' },
        ] })
    })

    it('refuses changed stale state instead of deleting by desired-path absence', () => {
        expect(planSurfaceChanges({
            configuredHarnesses: ['codexcli'], desired: [], priorOwned: [priorFile('stale.txt', 'old')],
            observed: [{ path: 'stale.txt', kind: 'file', bytes: 'changed', sha256: digest('changed'), identity: 'file:2' }],
        })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT', target: 'stale.txt' } })
    })

    it('tells the reader where a hand edit belongs and to ask before discarding it or an unrecorded file', () => {
        const desired = [desiredFile('skill.md', 'generated')]
        const observed = (bytes: string) => [{ path: 'skill.md', kind: 'file', bytes, sha256: digest(bytes), identity: 'file:5' }]
        expect(planSurfaceChanges({ configuredHarnesses: ['codexcli'], desired, priorOwned: [priorFile('skill.md', 'generated')], observed: observed('hand edit') }))
            .toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT', target: 'skill.md',
                message: expect.stringContaining('edited by hand'), fix: expect.stringContaining('ask the person who owns the cockpit before you discard the hand edit') } })
        for (const bytes of ['someone else', 'generated']) {
            expect(planSurfaceChanges({ configuredHarnesses: ['codexcli'], desired, priorOwned: [], observed: observed(bytes) }))
                .toMatchObject({ kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT', target: 'skill.md',
                    fix: expect.stringContaining('only with their approval move the file away or delete it') } })
        }
    })

    it('preserves shared outside bytes and refuses an unmanaged alternate OpenCode config', () => {
        const body = 'generated\n'
        const desired: SurfaceDesiredEntry = { ...base, kind: 'shared-region', ownership: 'shared-region', path: 'AGENTS.md', regionId: 'cockpit-instructions',
            region: { format: 'markdown-delimited', begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->', bytes: body, sha256: digest(body) } }
        expect(planSurfaceChanges({ configuredHarnesses: ['codexcli'], desired: [desired], priorOwned: [], observed: [
            { path: 'AGENTS.md', kind: 'file', bytes: 'human\n', sha256: digest('human\n'), identity: 'file:3' },
        ] })).toMatchObject({ kind: 'complete', actions: [{ kind: 'write', postimage: 'human\n<!-- cockpit:instructions:start -->\ngenerated\n<!-- cockpit:instructions:end -->\n' }] })

        const members = [{ key: 'instructions', valueBytes: '[]' }]
        const openCode: SurfaceDesiredEntry = { ...base, harnesses: ['opencode'], kind: 'shared-region', ownership: 'shared-region', path: 'opencode.jsonc',
            regionId: 'cockpit-opencode-root-properties', region: { format: 'opencode-json-root-properties', members, sha256: digest(JSON.stringify(members)) } }
        expect(planSurfaceChanges({ configuredHarnesses: ['codexcli', 'opencode'], desired: [openCode], priorOwned: [], observed: [
            { path: 'opencode.json', kind: 'file', bytes: '{}', sha256: digest('{}'), identity: 'file:4' },
            { path: 'opencode.jsonc', kind: 'missing' },
        ] })).toMatchObject({ kind: 'refusal', diagnostic: { target: 'opencode.json' } })
    })
})
