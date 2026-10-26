import { createHash } from 'node:crypto'

import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { SurfaceDeclaration, SurfaceOverlay, type SurfaceDeclaration as SurfaceDeclarationValue } from '../schema.js'
import type { SurfaceFeature } from './contract.js'

export const mechanism = {
    id: 'surface-merge',
    module: 'packages/cockpit/src/surfaces/merge.ts',
    exports: ['surfaceDeclarationSha256', 'mergeSurfaceDeclarations'],
} as const

export interface ActiveSurfaceOverride {
    readonly name: string
    readonly feature: SurfaceFeature
    readonly originalSha256: string
    readonly recordedSha256: string
    readonly overlaySource: string
}

export interface SurfaceUpgradeFinding {
    readonly code: 'OVERRIDDEN_CORE_CHANGED'
    readonly name: string
    readonly recordedSha256: string
    readonly currentSha256: string
    readonly overlaySource: string
}

export interface SurfaceMergeComplete {
    readonly kind: 'complete'
    readonly surfaces: readonly SurfaceDeclarationValue[]
    readonly overrides: readonly ActiveSurfaceOverride[]
    readonly findings: readonly SurfaceUpgradeFinding[]
}

export interface SurfaceMergeRefusal {
    readonly kind: 'refusal'
    readonly code: 'SURFACE_INPUT_INVALID' | 'SURFACE_NAME_DUPLICATE' | 'SURFACE_KIND_AMBIGUOUS'
        | 'SURFACE_OVERRIDE_INVALID' | 'SURFACE_PATH_CONFLICT'
    readonly message: string
}

export type SurfaceMergeResult = SurfaceMergeComplete | SurfaceMergeRefusal

function immutable<T>(value: T): T | undefined {
    return snapshotJson(value) as T | undefined
}

function isObject(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function refusal(code: SurfaceMergeRefusal['code'], message: string): SurfaceMergeRefusal {
    return immutable({ kind: 'refusal', code, message })!
}

function canonicalDeclaration(declaration: SurfaceDeclarationValue): Record<string, unknown> {
    return {
        name: declaration.name,
        feature: declaration.feature,
        sources: declaration.sources.map((source) => ({ path: source.path, bytes: source.bytes })),
        source: declaration.source,
        ...(declaration.replaces ? { replaces: declaration.replaces } : {}),
    }
}

export function surfaceDeclarationSha256(declaration: SurfaceDeclarationValue): string {
    return createHash('sha256').update(JSON.stringify(canonicalDeclaration(declaration))).digest('hex')
}

function duplicateName(declarations: readonly SurfaceDeclarationValue[]): string | undefined {
    const names = new Set<string>()
    for (const declaration of declarations) {
        if (names.has(declaration.name)) return declaration.name
        names.add(declaration.name)
    }
    return undefined
}

function compareName(left: { readonly name: string }, right: { readonly name: string }): number {
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function mergeSurfaceDeclarations(coreInput: unknown, overlayInput: unknown): SurfaceMergeResult {
    const captured = snapshotJson({ core: coreInput, overlays: overlayInput })
    if (!isObject(captured)) {
        return refusal('SURFACE_INPUT_INVALID', 'core and overlay declarations must be bounded immutable data')
    }
    const coreResult = SurfaceDeclaration.array().safeParse(captured.core)
    const overlayResult = SurfaceOverlay.array().safeParse(captured.overlays)
    if (!coreResult.success || !overlayResult.success) {
        return refusal('SURFACE_INPUT_INVALID', 'core or overlay declarations are invalid')
    }
    const core = coreResult.data
    const overlays = overlayResult.data
    const repeated = duplicateName(core) ?? duplicateName(overlays)
    if (repeated) return refusal('SURFACE_NAME_DUPLICATE', `surface name "${repeated}" is declared more than once`)
    if (core.some((declaration) => declaration.replaces)) {
        return refusal('SURFACE_OVERRIDE_INVALID', 'core declarations cannot replace another surface')
    }

    const resolved = new Map(core.map((declaration) => [declaration.name, declaration]))
    const overrides: ActiveSurfaceOverride[] = []
    const findings: SurfaceUpgradeFinding[] = []
    for (const overlay of overlays) {
        const original = resolved.get(overlay.name)
        if (!original) {
            if (overlay.replaces) return refusal('SURFACE_OVERRIDE_INVALID', `override "${overlay.name}" has no core original`)
            resolved.set(overlay.name, overlay)
            continue
        }
        if (original.feature !== overlay.feature) {
            return refusal('SURFACE_KIND_AMBIGUOUS', `surface "${overlay.name}" changes feature from ${original.feature} to ${overlay.feature}`)
        }
        if (!overlay.replaces || overlay.replaces.name !== overlay.name) {
            return refusal('SURFACE_OVERRIDE_INVALID', `surface "${overlay.name}" collides with core without an explicit replacement`)
        }
        const originalSha256 = surfaceDeclarationSha256(original)
        overrides.push({
            name: overlay.name,
            feature: overlay.feature,
            originalSha256,
            recordedSha256: overlay.replaces.sha256,
            overlaySource: overlay.source,
        })
        if (originalSha256 !== overlay.replaces.sha256) {
            findings.push({
                code: 'OVERRIDDEN_CORE_CHANGED',
                name: overlay.name,
                recordedSha256: overlay.replaces.sha256,
                currentSha256: originalSha256,
                overlaySource: overlay.source,
            })
        }
        resolved.set(overlay.name, overlay)
    }

    const paths = new Map<string, string>()
    const surfaces = [...resolved.values()]
    for (const declaration of surfaces) {
        for (const source of declaration.sources) {
            const owner = paths.get(source.path)
            if (owner) return refusal('SURFACE_PATH_CONFLICT', `surface path "${source.path}" is owned by both "${owner}" and "${declaration.name}"`)
            paths.set(source.path, declaration.name)
        }
    }
    surfaces.sort(compareName)
    overrides.sort(compareName)
    findings.sort(compareName)
    return immutable({ kind: 'complete', surfaces, overrides, findings })!
}
