import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { SurfaceDesiredEntry, SurfacePriorOwnedEntry } from './ownership.js'
import { compareSurfaceState } from './check.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const base = { harnesses: ['codexcli'] as ['codexcli'], scope: 'always' as const, capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const }

describe('surface state comparison', () => {
    it('uses the change planner ownership semantics for current, missing and stale rows', () => {
        const current: SurfaceDesiredEntry = { ...base, kind: 'file', ownership: 'whole-file', path: 'current.txt', bytes: 'same', sha256: digest('same') }
        const priorCurrent: SurfacePriorOwnedEntry = { ...base, kind: 'file', ownership: 'whole-file', path: 'current.txt', sha256: digest('same') }
        const missing: SurfaceDesiredEntry = { ...base, kind: 'file', ownership: 'whole-file', path: 'missing.txt', bytes: 'new', sha256: digest('new') }
        const stale: SurfacePriorOwnedEntry = { ...base, kind: 'file', ownership: 'whole-file', path: 'stale.txt', sha256: digest('old') }
        expect(compareSurfaceState({
            configuredHarnesses: ['codexcli'], desired: [current, missing], priorOwned: [priorCurrent, stale], observed: [
                { path: 'current.txt', kind: 'file', bytes: 'same', sha256: digest('same'), identity: 'file:1' },
                { path: 'missing.txt', kind: 'missing' },
                { path: 'stale.txt', kind: 'file', bytes: 'old', sha256: digest('old'), identity: 'file:2' },
            ],
        })).toEqual({ kind: 'complete', current: ['current.txt'], missing: ['missing.txt'], drift: [], stale: ['stale.txt'], alreadyAbsent: [] })
    })

    it('does not claim or compare bytes outside an owned Markdown region', () => {
        const bytes = 'owned\n'
        const desired: SurfaceDesiredEntry = { ...base, kind: 'shared-region', ownership: 'shared-region', path: 'AGENTS.md', regionId: 'cockpit-instructions',
            region: { format: 'markdown-delimited', begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->', bytes, sha256: digest(bytes) } }
        const prior: SurfacePriorOwnedEntry = { ...base, kind: 'shared-region', ownership: 'shared-region', path: 'AGENTS.md', regionId: 'cockpit-instructions',
            region: { format: 'markdown-delimited', begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->', sha256: digest(bytes) } }
        const observed = 'human changed\n<!-- cockpit:instructions:start -->\nowned\n<!-- cockpit:instructions:end -->\n'
        expect(compareSurfaceState({ configuredHarnesses: ['codexcli'], desired: [desired], priorOwned: [prior], observed: [
            { path: 'AGENTS.md', kind: 'file', bytes: observed, sha256: digest(observed), identity: 'file:3' },
        ] })).toMatchObject({ kind: 'complete', current: ['AGENTS.md'], drift: [] })
    })
})
