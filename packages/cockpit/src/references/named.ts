import type {
    DocsLintDiagnostic, inspectProseReferences, ProsePathState, ProseReferenceAuthority, walkMarkdownProse,
} from '../../../../scripts/docs-lint.mjs'
import {
    projectGeneratedPathFacts,
    type GeneratedPathFact, type GeneratedPathProducer, type OwnershipAuthority, type OwnershipManifest,
} from '../surfaces/ownership.js'

export const mechanism = {
    id: 'named-reference-resolution',
    module: 'packages/cockpit/src/references/named.ts',
    exports: ['resolveNamedPath', 'inspectNamedReferences'],
} as const

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
    if (!safePath(path)) return Object.freeze({ kind: 'refusal', path, reason: 'reference must name an exact repository-relative path' })
    if (exists) return Object.freeze({ kind: 'resolved', path })
    const fact = facts.find(fact => fact.path === path)
    const declaration = fact?.declaration
    if (declaration?.applicability === 'sibling-unavailable') {
        return Object.freeze({ kind: 'unavailable', path, producer: declaration.producer })
    }
    if (fact?.allowsMissing && declaration?.applicability === 'declared-before-sync') {
        return Object.freeze({ kind: 'declared-before-sync', path, producer: declaration.producer })
    }
    return Object.freeze({ kind: 'refusal', path, reason: 'missing reference has no applicable exact producer declaration' })
}

export function resolveNamedPath(input: NamedPathInput): NamedPathResult {
    const projected = projectGeneratedPathFacts(input.manifest, input.authority, input.declarations)
    if (projected.kind === 'refusal') return Object.freeze({ kind: 'refusal', path: input.path, reason: 'generated path authority was refused' })
    return resolveProjectedPath(input.path, input.exists, projected.facts)
}

export interface NamedReferenceInput extends NamedAuthority {
    readonly documentPath: string
    readonly body: string
    readonly references: ProseReferenceAuthority
    readonly existing: readonly Readonly<{ path: string; body?: string }>[]
    readonly today?: string
}
export interface NamedReferenceInspector {
    readonly inspectProseReferences: typeof inspectProseReferences
    readonly walkMarkdownProse: typeof walkMarkdownProse
}

// The repository checker supplies its walker; published runtime code has no dependency on development scripts.
export function inspectNamedReferences(input: NamedReferenceInput, inspector: NamedReferenceInspector): DocsLintDiagnostic[] {
    const projected = projectGeneratedPathFacts(input.manifest, input.authority, input.declarations)
    if (projected.kind === 'refusal') return [{ path: input.documentPath, line: 1, code: 'DOCEV050_NAMED_REFERENCE_MISSING', message: 'generated path authority was refused' }]
    const existing = new Map(input.existing.map(entry => [entry.path, entry]))
    const resolvePath = (path: string): ProsePathState => {
        const entry = existing.get(path)
        const resolution = resolveProjectedPath(path, entry !== undefined, projected.facts)
        if (resolution.kind === 'refusal') return 'missing'
        if (resolution.kind !== 'resolved') return resolution.kind
        if (entry?.body !== undefined && inspector.walkMarkdownProse(path, entry.body).lines
            .some(row => row.comments.some(comment => /^cockpit:retired(?: |$)/.test(comment)))) return 'retired'
        return 'present'
    }
    return inspector.inspectProseReferences({ path: input.documentPath, body: input.body, authority: input.references, resolvePath,
        ...(input.today === undefined ? {} : { today: input.today }) })
}
