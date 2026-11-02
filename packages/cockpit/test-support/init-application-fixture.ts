import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { InitApplicationAdapters, InitApplicationInput } from '../src/environment/init-application.js'
import type { SurfaceTarget } from '../src/surfaces/contract.js'

// Shared by the init application tests and their slow end-to-end cases.
const scratch: string[] = []

export function removeInitApplicationFixtures() {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
}
export const digest = (character: string) => character.repeat(64)

export function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-init-application-'))
    scratch.push(directory)
    const requestedRoot = join(directory, 'checkout')
    const home = join(directory, 'home')
    mkdirSync(requestedRoot, { mode: 0o700 })
    mkdirSync(home, { mode: 0o700 })
    const root = realpathSync(requestedRoot)
    const destination = join(root, 'cockpit.toml')
    const calls: string[] = []
    let destinationState: { kind: 'absent' } | { kind: 'available'; sha256: string } = { kind: 'absent' }
    // The files init publishes, which every other path stands for; a test removes them to model a
    // root that was deleted and recreated.
    let publishedState: { kind: 'absent' } | { kind: 'available'; sha256: string } = { kind: 'available', sha256: digest('2') }
    let canonicalOwnership = false
    let previewSha256 = digest('3')
    const preview = Object.freeze({
        kind: 'complete' as const,
        status: 0 as const,
        diagnostics: Object.freeze([]),
        result: Object.freeze({
            root,
            target: 'codexcli' as SurfaceTarget,
            sources: Object.freeze([{ path: 'skills/cockpit-setup.skill.md', sha256: digest('1') }]),
            files: Object.freeze([{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: digest('2') }]),
            previewSha256,
        }),
        authority: Object.freeze({ kind: 'selected-bootstrap-publication-authority' as const }),
    })
    let prepared = preview
    const adapters: InitApplicationAdapters = {
        now: () => '2026-10-25T00:00:00.000Z',
        prepareBootstrap: async ({ target }) => {
            calls.push('prepare')
            prepared = Object.freeze({ ...preview, result: Object.freeze({ ...preview.result, target, previewSha256 }) })
            return prepared
        },
        resumeBootstrap: async () => {
            calls.push('resume')
            return canonicalOwnership
                ? Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]),
                    result: prepared.result, canonicalOwnership: true as const })
                : Object.freeze({ kind: 'pending' as const, status: 0 as const, diagnostics: Object.freeze([]),
                    result: null, canonicalOwnership: false as const })
        },
        applyBootstrap: async () => {
            calls.push('apply')
            return prepared
        },
        document: async () => {
            calls.push('document')
            return { kind: 'complete', status: 0, diagnostics: [], result: { document: 'name = "synthetic"\n' },
                artifact: 'name = "synthetic"\n', destination }
        },
        observeDestination: async ({ path }) => {
            // A dedicated cockpit writes its cockpit.toml beside the product, not into this root.
            if (basename(path) !== 'cockpit.toml') {
                // As in the CLI, a path under a missing directory is refused rather than reported absent;
                // only the topmost missing directory reads as absent.
                if (publishedState.kind === 'absent' && relative(root, path).includes(sep)) return { kind: 'refusal', diagnostics: [] }
                return publishedState
            }
            calls.push('observe')
            return destinationState
        },
        validateConfig: async () => { calls.push('validate'); return { kind: 'complete', status: 0, diagnostics: [], result: {} } },
        synchronize: async () => { calls.push('sync'); canonicalOwnership = true; return { kind: 'complete', status: 0, diagnostics: [], result: {} } },
        check: async () => { calls.push('check'); return { kind: 'complete', status: 0, diagnostics: [], result: {} } },
        preflight: async () => { calls.push('preflight'); return { kind: 'complete', status: 0, diagnostics: [], result: { verdict: 'pass' } } },
    }
    const input: InitApplicationInput = {
        root: resolve(root), target: 'codexcli', registry: join(root, 'env/registry.sh'), accepted: false,
        sessionId: 'synthetic-session', platform: 'linux', home, xdgStateHome: join(home, 'state'),
    }
    return {
        root, destination, calls, adapters, input,
        setDestination: (value: typeof destinationState) => { destinationState = value },
        setPublished: (value: typeof publishedState) => { publishedState = value },
        setPreviewSha256: (value: string) => { previewSha256 = value },
    }
}
