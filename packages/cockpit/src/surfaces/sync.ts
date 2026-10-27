import { createHash } from 'node:crypto'

import { snapshotGeneratedJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { ADOPTABLE_SURFACE_PATHS } from './contract.js'
import {
    classifySurfaceOwnership,
    removeSharedOwnership,
    renderSharedPostimage,
    type SurfaceDesiredEntry,
    type SurfaceDiagnostic,
    type SurfacePriorOwnedEntry,
} from './ownership.js'

export const mechanism = {
    id: 'surface-sync-plan',
    module: 'packages/cockpit/src/surfaces/sync.ts',
    exports: ['planSurfaceChanges'],
} as const

export type SurfaceObservedEntry =
    | Readonly<{ path: string; kind: 'missing' }>
    | Readonly<{ path: string; kind: 'file'; bytes: string; sha256: string; identity: string }>
    | Readonly<{ path: string; kind: 'symlink'; target: string; identity: string }>
    | Readonly<{ path: string; kind: 'other'; identity: string }>

export type SurfaceChange =
    | Readonly<{ kind: 'write'; path: string; desired: SurfaceDesiredEntry; postimage?: string; preimage?: Readonly<{ identity: string; sha256?: string }> }>
    | Readonly<{ kind: 'remove'; path: string; priorOwned: SurfacePriorOwnedEntry; postimage?: string; preimage?: Readonly<{ identity: string; sha256?: string }> }>
    | Readonly<{ kind: 'already-absent'; path: string; priorOwned: SurfacePriorOwnedEntry }>

export type SurfaceChangePlanResult =
    | Readonly<{ kind: 'complete'; actions: readonly SurfaceChange[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: SurfaceDiagnostic }>

export interface SurfaceChangeInput {
    readonly configuredHarnesses: readonly string[]
    readonly desired: readonly SurfaceDesiredEntry[]
    readonly priorOwned: readonly SurfacePriorOwnedEntry[]
    readonly observed: readonly SurfaceObservedEntry[]
}

const SHA256 = /^[a-f0-9]{64}$/

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: JsonSnapshotObject, required: readonly string[]): boolean {
    const keys = Object.keys(value).sort()
    const expected = [...required].sort()
    return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function safePath(value: string): boolean {
    return value.length > 0 && value.length <= 4096 && !value.startsWith('/') && !/^[a-z]:[/\\]/i.test(value)
        && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'
            && !['.git', 'internal', 'node_modules'].includes(part))
}

function refuse(message: string, target?: string): SurfaceChangePlanResult {
    return Object.freeze({ kind: 'refusal', diagnostic: Object.freeze({ code: 'SURFACE_STATE_CONFLICT', message, ...(target === undefined ? {} : { target }) }) })
}

function base(value: JsonSnapshotObject, configured: ReadonlySet<string>): boolean {
    const harnesses = value.harnesses
    return typeof value.path === 'string' && safePath(value.path) && Array.isArray(harnesses) && harnesses.length > 0
        && harnesses.every((harness, index) => typeof harness === 'string' && configured.has(harness) && (index === 0 || harnesses[index - 1]! < harness))
        && (value.scope === 'always' || value.scope === 'scoped') && (value.capability === 'enforced' || value.capability === 'instructed')
        && value.writer === 'cockpit' && value.schemaVersion === 1
}

function priorEntry(value: JsonSnapshot, configured: ReadonlySet<string>): SurfacePriorOwnedEntry | undefined {
    if (!object(value) || !base(value, configured) || typeof value.kind !== 'string' || typeof value.ownership !== 'string') return undefined
    if (value.kind === 'file') {
        return exact(value, ['kind', 'path', 'harnesses', 'scope', 'capability', 'writer', 'schemaVersion', 'ownership', 'sha256'])
            && value.ownership === 'whole-file' && typeof value.sha256 === 'string' && SHA256.test(value.sha256)
            ? value as unknown as SurfacePriorOwnedEntry : undefined
    }
    if (value.kind === 'symlink') {
        return exact(value, ['kind', 'path', 'harnesses', 'scope', 'capability', 'writer', 'schemaVersion', 'ownership', 'target', 'source'])
            && value.ownership === 'symlink' && typeof value.target === 'string' && object(value.source)
            && exact(value.source, ['root', 'path', 'sha256', 'identity']) && typeof value.source.root === 'string'
            && typeof value.source.path === 'string' && typeof value.source.sha256 === 'string' && SHA256.test(value.source.sha256)
            && typeof value.source.identity === 'string' && value.source.identity.length > 0
            ? value as unknown as SurfacePriorOwnedEntry : undefined
    }
    if (value.kind !== 'shared-region' || value.ownership !== 'shared-region'
        || !exact(value, ['kind', 'path', 'harnesses', 'scope', 'capability', 'writer', 'schemaVersion', 'ownership', 'regionId', 'region'])
        || typeof value.regionId !== 'string' || !object(value.region) || typeof value.region.sha256 !== 'string' || !SHA256.test(value.region.sha256)) return undefined
    if (value.region.format === 'markdown-delimited') {
        return exact(value.region, ['format', 'begin', 'end', 'sha256']) && typeof value.region.begin === 'string' && typeof value.region.end === 'string'
            ? value as unknown as SurfacePriorOwnedEntry : undefined
    }
    const keys = value.region.keys
    return value.region.format === 'opencode-json-root-properties' && exact(value.region, ['format', 'keys', 'sha256'])
        && Array.isArray(keys) && keys.length > 0 && keys.every((key, index) => typeof key === 'string' && (index === 0 || keys[index - 1]! < key))
        ? value as unknown as SurfacePriorOwnedEntry : undefined
}

function observedEntry(value: JsonSnapshot): SurfaceObservedEntry | undefined {
    if (!object(value) || typeof value.path !== 'string' || !safePath(value.path) || typeof value.kind !== 'string') return undefined
    if (value.kind === 'missing') return exact(value, ['path', 'kind']) ? value as unknown as SurfaceObservedEntry : undefined
    if (value.kind === 'file') return exact(value, ['path', 'kind', 'bytes', 'sha256', 'identity']) && typeof value.bytes === 'string'
        && typeof value.sha256 === 'string' && value.sha256 === digest(value.bytes) && typeof value.identity === 'string' && value.identity.length > 0
        ? value as unknown as SurfaceObservedEntry : undefined
    if (value.kind === 'symlink') return exact(value, ['path', 'kind', 'target', 'identity']) && typeof value.target === 'string'
        && typeof value.identity === 'string' && value.identity.length > 0 ? value as unknown as SurfaceObservedEntry : undefined
    return value.kind === 'other' && exact(value, ['path', 'kind', 'identity']) && typeof value.identity === 'string' && value.identity.length > 0
        ? value as unknown as SurfaceObservedEntry : undefined
}

function priorMatchesObserved(prior: SurfacePriorOwnedEntry, observed: SurfaceObservedEntry): boolean {
    if (prior.kind === 'file') return observed.kind === 'file' && observed.sha256 === prior.sha256
    if (prior.kind === 'symlink') return observed.kind === 'symlink' && observed.target === prior.target
    return observed.kind === 'file'
}

export function planSurfaceChanges(input: unknown): SurfaceChangePlanResult {
    const captured = snapshotGeneratedJson(input)
    if (!object(captured) || !exact(captured, ['configuredHarnesses', 'desired', 'priorOwned', 'observed'])
        || !Array.isArray(captured.configuredHarnesses) || !Array.isArray(captured.desired)
        || !Array.isArray(captured.priorOwned) || captured.priorOwned.length > 256
        || !Array.isArray(captured.observed) || captured.observed.length > 257) return refuse('surface change input must be bounded exact data')
    const ownership = classifySurfaceOwnership({ configuredHarnesses: captured.configuredHarnesses, entries: captured.desired })
    if (ownership.kind === 'refusal') return ownership
    const configured = new Set(captured.configuredHarnesses as readonly string[])
    const prior: SurfacePriorOwnedEntry[] = []
    const observed: SurfaceObservedEntry[] = []
    let priorPath = ''
    for (const candidate of captured.priorOwned) {
        const entry = priorEntry(candidate, configured)
        if (!entry || entry.path <= priorPath) return refuse('prior ownership rows must be valid, unique and sorted')
        priorPath = entry.path
        prior.push(entry)
    }
    let observedPath = ''
    for (const candidate of captured.observed) {
        const entry = observedEntry(candidate)
        if (!entry || entry.path <= observedPath) return refuse('observed rows must be valid, unique and sorted')
        observedPath = entry.path
        observed.push(entry)
    }
    const desiredByPath = new Map(ownership.entries.map(entry => [entry.path, entry]))
    const priorByPath = new Map(prior.map(entry => [entry.path, entry]))
    const observedByPath = new Map(observed.map(entry => [entry.path, entry]))
    if (desiredByPath.has('opencode.jsonc')) {
        const alternate = observedByPath.get('opencode.json')
        if (alternate && alternate.kind !== 'missing' && !priorByPath.has('opencode.json')) return refuse('unmanaged alternate OpenCode configuration exists', 'opencode.json')
    }
    const writes: SurfaceChange[] = []
    for (const desired of ownership.entries) {
        const current = observedByPath.get(desired.path) ?? { path: desired.path, kind: 'missing' as const }
        const previous = priorByPath.get(desired.path)
        if (desired.kind === 'file' && current.kind === 'file' && current.sha256 === desired.sha256
            || desired.kind === 'symlink' && current.kind === 'symlink' && current.target === desired.target) {
            if (!previous || !priorMatchesObserved(previous, current)) return refuse('matching bytes or target are not proof of ownership', desired.path)
            continue
        }
        if (desired.kind === 'shared-region') {
            if (current.kind === 'missing') {
                const baseBytes = desired.region.format === 'opencode-json-root-properties' ? '{}' : ''
                const rendered = renderSharedPostimage(baseBytes, desired)
                if (rendered.kind === 'refusal') return rendered
                writes.push({ kind: 'write', path: desired.path, desired, postimage: rendered.bytes })
                continue
            }
            if (current.kind !== 'file') return refuse('shared surface path is not a regular file', desired.path)
            const rendered = renderSharedPostimage(current.bytes, desired, previous)
            if (rendered.kind === 'refusal') return rendered
            if (rendered.bytes !== current.bytes) writes.push({ kind: 'write', path: desired.path, desired, postimage: rendered.bytes,
                preimage: { identity: current.identity, sha256: current.sha256 } })
            continue
        }
        if (current.kind !== 'missing' && !previous && (ADOPTABLE_SURFACE_PATHS as readonly string[]).includes(desired.path)) {
            return refuse(`existing surface is unmanaged; to keep the settings it holds, adopt it: cockpit sync --config <file> --adopt ${desired.path}`, desired.path)
        }
        if (current.kind !== 'missing' && (!previous || !priorMatchesObserved(previous, current))) return refuse('existing surface is unmanaged or changed', desired.path)
        writes.push({ kind: 'write', path: desired.path, desired,
            ...(current.kind === 'missing' ? {} : { preimage: { identity: current.identity, ...(current.kind === 'file' ? { sha256: current.sha256 } : {}) } }) })
    }
    const removals: SurfaceChange[] = []
    for (const stale of prior) {
        if (desiredByPath.has(stale.path)) continue
        const current = observedByPath.get(stale.path) ?? { path: stale.path, kind: 'missing' as const }
        if (current.kind === 'missing') {
            removals.push({ kind: 'already-absent', path: stale.path, priorOwned: stale })
            continue
        }
        if (stale.kind === 'shared-region') {
            if (current.kind !== 'file') return refuse('stale shared surface changed kind', stale.path)
            const rendered = removeSharedOwnership(current.bytes, stale)
            if (rendered.kind === 'refusal') return rendered
            removals.push({ kind: 'remove', path: stale.path, priorOwned: stale, postimage: rendered.bytes,
                preimage: { identity: current.identity, sha256: current.sha256 } })
            continue
        }
        if (!priorMatchesObserved(stale, current)) return refuse('stale owned surface changed', stale.path)
        removals.push({ kind: 'remove', path: stale.path, priorOwned: stale,
            preimage: { identity: current.identity, ...(current.kind === 'file' ? { sha256: current.sha256 } : {}) } })
    }
    const result = snapshotGeneratedJson({ kind: 'complete', actions: [...writes, ...removals] })
    return result ? result as unknown as SurfaceChangePlanResult : refuse('surface change plan exceeds the captured bounds')
}
