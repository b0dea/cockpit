import {
    projectGeneratedPathFacts,
    type GeneratedPathFact, type GeneratedPathProducer, type OwnershipAuthority, type OwnershipManifest,
} from '../surfaces/ownership.js'

interface NamedAuthority {
    readonly manifest: OwnershipManifest
    readonly authority: OwnershipAuthority
    readonly declarations: unknown
}
export interface NamedPathInput extends NamedAuthority {
    readonly path: string
    readonly exists: boolean
}
export type NamedPathResult = Readonly<{ kind: 'resolved'; path: string }>
    | Readonly<{ kind: 'declared-before-sync' | 'unavailable'; path: string; producer: GeneratedPathProducer }>
    | Readonly<{ kind: 'refusal'; path: string; reason: string }>

function safePath(path: string): boolean {
    return typeof path === 'string' && path.length > 0 && !/[\\\u0000-\u001f\u007f]/.test(path)
        && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
        && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function resolveProjectedPath(path: string, exists: boolean, facts: readonly GeneratedPathFact[]): NamedPathResult {
    if (!safePath(path)) return { kind: 'refusal', path, reason: 'reference must name an exact repository-relative path' }
    if (exists) return { kind: 'resolved', path }
    const fact = facts.find(fact => fact.path === path)
    const declaration = fact?.declaration
    if (declaration?.applicability === 'sibling-unavailable') {
        return { kind: 'unavailable', path, producer: declaration.producer }
    }
    if (fact?.allowsMissing && declaration?.applicability === 'declared-before-sync') {
        return { kind: 'declared-before-sync', path, producer: declaration.producer }
    }
    return { kind: 'refusal', path, reason: 'missing reference has no applicable exact producer declaration' }
}

export function resolveNamedPath(input: NamedPathInput): NamedPathResult {
    const projected = projectGeneratedPathFacts(input.manifest, input.authority, input.declarations)
    if (projected.kind === 'refusal') return { kind: 'refusal', path: input.path, reason: 'generated path authority was refused' }
    return resolveProjectedPath(input.path, input.exists, projected.facts)
}
