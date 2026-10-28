import { createHash } from 'node:crypto'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import type { SurfaceTarget } from './contract.js'
import { GUARD_SURFACE_TARGETS as SURFACE_TARGETS, type GuardSurfaceTarget } from './harness-registry.js'

export const mechanism = {
    id: 'sibling-projection',
    module: 'packages/cockpit/src/surfaces/projection.ts',
    exports: ['observeSiblingGuides', 'planSiblingProjection', 'shippedInstructionCapabilities'],
} as const

const GUIDE_BYTE_LIMIT = 65_536
const GUIDE_COUNT_LIMIT = 256
const OBSERVATION_CONTENT_BYTE_LIMIT = 786_432
const PROJECTION_RESULT_ENTRY_LIMIT = 1_024
const SHA256 = /^[a-f0-9]{64}$/
const SLUG = /^[a-z0-9][a-z0-9-]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

type Mount = 'always' | 'host' | 'none' | `profile:${string}`
type EntryType = 'file' | 'symlink' | 'directory' | 'other'

export interface GuideObservationRequest {
    readonly slug: string
    readonly root: string
    readonly sourcePath: string
}

export interface GuideObservation {
    readonly slug: string
    readonly sourcePath: string
    readonly sourceEntryType: 'file' | 'symlink'
    readonly sourceLinkTarget?: string
    readonly contentPath: string
    readonly content: string
    readonly contentBytes: number
    readonly contentSha256: string
    readonly contentIdentity: string
}

export type GuideObservationResult =
    | { readonly kind: 'complete'; readonly observations: readonly GuideObservation[]; readonly missing: readonly string[] }
    | { readonly kind: 'refusal' | 'unavailable'; readonly diagnostic: ProjectionDiagnostic }

export interface ProjectionSiblingInput {
    slug: string
    mount: Mount
    directoryAuthority: string
    declaredOverride?: string
    guides?: string[]
}

export interface ProjectionPlannerInput {
    canonicalMainCheckout: string
    siblingsRoot: string
    invocationCwd?: string
    activeProfiles: string[]
    guideCapLines: number
    siblings: ProjectionSiblingInput[]
    mountedPaths: Array<{ slug: string; path: string }>
    directoryGrants: Array<{ slug: string; target: SurfaceTarget; path: string }>
    guideObservations: readonly GuideObservation[]
    existingEntries: Array<{ path: string; type: EntryType; target?: string }>
    priorOwnedLinks: Array<{ path: string; target: string }>
    standingSources: Array<{ target: SurfaceTarget; path: string; content: string; scope: 'always' | 'scoped' }>
    loadCharacterizations: Partial<Record<SurfaceTarget, LoadCostCharacterization | undefined>>
}

export interface LoadCostCharacterization {
    measuredOn: string
    provenance: string
    metric: 'lines'
    scopeSemantics: 'conditional' | 'full'
}

export interface ProjectionDiagnostic {
    readonly code: 'PROJECTION_INPUT_INVALID' | 'PROJECTION_GUIDE_UNAVAILABLE' | 'PROJECTION_GUIDE_CHANGED'
        | 'PROJECTION_GUIDE_ESCAPE' | 'PROJECTION_GUIDE_READ_FAILED' | 'PROJECTION_GUIDE_CLOSE_FAILED'
        | 'PROJECTION_ROOT_AMBIGUOUS' | 'PROJECTION_RESULT_BOUNDS'
        | 'PROJECTION_MOUNT_MISMATCH' | 'PROJECTION_GRANT_MISMATCH'
    readonly message: string
    readonly target?: string
    readonly expected?: string
    readonly actual?: string
}

export interface ProjectionLink {
    readonly sibling: string
    readonly path: string
    readonly target: string
    readonly sourceGuidePath: string
    readonly sourceContentPath: string
    readonly sourceEntryType: 'file' | 'symlink'
    readonly sourceLinkTarget?: string
    readonly sourceContentIdentity: string
    readonly sourceContentSha256: string
    readonly sourceContentBytes: number
    readonly ownership: 'whole-file'
}

export interface NativeProjection {
    readonly target: SurfaceTarget
    readonly path: 'CLAUDE.local.md' | 'AGENTS.md' | 'opencode.jsonc'
    readonly mechanism: 'claude-relative-import' | 'codex-root-instruction' | 'opencode-instructions'
    readonly spelling: string
    readonly linkPath: string
    readonly ownership: 'shared-region'
    readonly capability: 'instructed'
    readonly evidence: 'pending_evidence'
    readonly characterizedOn: '2026-09-26'
    readonly provenance: string
}

export interface ShippedInstructionCapability {
    readonly target: SurfaceTarget
    readonly mechanism: NativeProjection['mechanism'] | 'rulesync-rules'
    readonly capability: NativeProjection['capability'] | 'unavailable'
    readonly evidence: NativeProjection['evidence'] | 'not_applicable'
    readonly characterizedOn: string
    readonly provenance: string
}

export interface DirectoryGrant {
    readonly slug: string
    readonly target: SurfaceTarget
    readonly path: string
    readonly spelling: string
    readonly capability: 'instructed'
    readonly evidence: 'pending_evidence'
}

export interface ProjectionComparison {
    readonly path: string
    readonly state: 'current' | 'missing' | 'drift'
    readonly expectedType: 'symlink'
    readonly actualType?: EntryType
    readonly expectedTarget: string
    readonly actualTarget?: string
}

export type StandingCost =
    | {
          readonly target: SurfaceTarget
          readonly status: 'within_cap' | 'exceeded'
          readonly metric: 'lines'
          readonly value: number
          readonly conditionalValue: number
          readonly cap: number
          readonly measuredOn: string
          readonly provenance: string
          readonly scopeSemantics: 'conditional' | 'full'
      }
    | { readonly target: SurfaceTarget; readonly status: 'unavailable'; readonly reason: string }

export type ProjectionPlanResult =
    | {
          readonly kind: 'complete'
          readonly links: readonly ProjectionLink[]
          readonly native: readonly NativeProjection[]
          readonly grants: readonly DirectoryGrant[]
          readonly comparisons: readonly ProjectionComparison[]
          readonly staleLinks: readonly { readonly path: string; readonly target: string }[]
          readonly costs: readonly StandingCost[]
          readonly headline?: { readonly metric: 'lines'; readonly value: number; readonly target: SurfaceTarget }
      }
    | { readonly kind: 'refusal'; readonly diagnostic: ProjectionDiagnostic }

function isObject(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: JsonSnapshotObject, required: readonly string[], optional: readonly string[] = []): boolean {
    const allowed = new Set([...required, ...optional])
    return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function capturedValue<T>(value: T): T | undefined {
    const captured = snapshotJson(value)
    return captured === undefined ? undefined : captured as unknown as T
}

const RESULT_BOUNDS_DIAGNOSTIC = Object.freeze<ProjectionDiagnostic>({
    code: 'PROJECTION_RESULT_BOUNDS',
    message: 'sibling projection result exceeds the immutable snapshot bound',
})
const OBSERVATION_RESULT_BOUNDS = Object.freeze<GuideObservationResult>({
    kind: 'refusal',
    diagnostic: RESULT_BOUNDS_DIAGNOSTIC,
})
const PLANNER_RESULT_BOUNDS = Object.freeze<ProjectionPlanResult>({
    kind: 'refusal',
    diagnostic: RESULT_BOUNDS_DIAGNOSTIC,
})

function diagnostic(
    code: ProjectionDiagnostic['code'],
    message: string,
    details: Pick<ProjectionDiagnostic, 'target' | 'expected' | 'actual'> = {},
): ProjectionDiagnostic {
    return capturedValue({ code, message, ...details }) ?? RESULT_BOUNDS_DIAGNOSTIC
}

function refuse(value: ProjectionDiagnostic): ProjectionPlanResult {
    return capturedValue<ProjectionPlanResult>({ kind: 'refusal', diagnostic: value }) ?? PLANNER_RESULT_BOUNDS
}

function observedOutcome(value: GuideObservationResult): GuideObservationResult {
    return capturedValue(value) ?? OBSERVATION_RESULT_BOUNDS
}

function safeGuidePath(path: string): boolean {
    if (path.length === 0 || path.length > 4096 || path.startsWith('/') || /^[a-z]:[/\\]/i.test(path)
        || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) return false
    return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function safeOwnedLinkPath(path: string): boolean {
    return /^\.sibling-[a-z0-9][a-z0-9-]*-[A-Za-z0-9._-]+\.md$/.test(path)
}

function contained(root: string, path: string): boolean {
    const fromRoot = relative(root, path)
    return fromRoot === '' || !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

function snapshotRequests(input: unknown): { readonly requests: readonly GuideObservationRequest[]; readonly allowedRoots: readonly string[] } | undefined {
    const snapshot = snapshotJson(input)
    if (!isObject(snapshot) || !exactKeys(snapshot, ['allowedRoots', 'requests']) || !Array.isArray(snapshot.requests)
        || snapshot.requests.length > GUIDE_COUNT_LIMIT) return undefined
    const allowedRoots = stringArray(snapshot.allowedRoots)
    if (!allowedRoots || allowedRoots.length === 0 || allowedRoots.length > GUIDE_COUNT_LIMIT
        || new Set(allowedRoots).size !== allowedRoots.length || allowedRoots.some(root => !isAbsolute(root))) return undefined
    const result: GuideObservationRequest[] = []
    const identities = new Set<string>()
    for (const request of snapshot.requests) {
        if (!isObject(request) || !exactKeys(request, ['slug', 'root', 'sourcePath'])
            || typeof request.slug !== 'string' || !SLUG.test(request.slug)
            || typeof request.root !== 'string' || !isAbsolute(request.root)
            || typeof request.sourcePath !== 'string' || !isAbsolute(request.sourcePath)) return undefined
        const sourcePath = request.sourcePath
        if (!allowedRoots.includes(request.root) || !contained(request.root, sourcePath)) return undefined
        const identity = `${request.slug}\0${sourcePath}`
        if (identities.has(identity)) return undefined
        identities.add(identity)
        result.push({ slug: request.slug, root: request.root, sourcePath })
    }
    return { requests: result, allowedRoots }
}

interface FileIdentity {
    readonly dev: bigint
    readonly ino: bigint
    readonly mode: bigint
    readonly size: bigint
    readonly mtimeNs: bigint
    readonly ctimeNs: bigint
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
}

function statIdentity(stat: FileIdentity): string {
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

function inodeIdentity(stat: Pick<FileIdentity, 'dev' | 'ino'>): string {
    return `${stat.dev}:${stat.ino}`
}

interface PathIdentity {
    readonly entry: FileIdentity
    readonly entryType: 'file' | 'symlink'
    readonly linkTarget?: string
    readonly contentPath: string
    readonly target: FileIdentity
}

interface RootAuthority {
    readonly declared: string
    readonly canonical: string
    readonly declaredIdentity: string
    readonly directoryIdentity: string
    readonly handle: Awaited<ReturnType<typeof open>>
}

function declaredRootIdentity(entry: FileIdentity, linkTarget: string | undefined): string {
    return entry.isSymbolicLink() ? `${statIdentity(entry)}:${linkTarget ?? ''}` : inodeIdentity(entry)
}

async function rootEntryIdentity(path: string): Promise<{ readonly entry: FileIdentity; readonly identity: string }> {
    const entry = await lstat(path, { bigint: true })
    if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error('sibling root is not a directory or symlink')
    const linkTarget = entry.isSymbolicLink() ? await readlink(path) : undefined
    return { entry, identity: declaredRootIdentity(entry, linkTarget) }
}

async function captureRootAuthority(declared: string): Promise<RootAuthority | ProjectionDiagnostic> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let failure: ProjectionDiagnostic | undefined
    try {
        const before = await rootEntryIdentity(declared)
        handle = await open(declared, 'r')
        const directory = await handle.stat({ bigint: true })
        const canonical = await realpath(declared)
        const direct = await lstat(canonical, { bigint: true })
        const after = await rootEntryIdentity(declared)
        if (!directory.isDirectory() || !direct.isDirectory() || before.identity !== after.identity
            || inodeIdentity(directory) !== inodeIdentity(direct)
            || !before.entry.isSymbolicLink() && inodeIdentity(before.entry) !== inodeIdentity(directory)) {
            failure = diagnostic('PROJECTION_GUIDE_CHANGED', `declared sibling root changed while its authority was captured: ${declared}`, { target: declared })
        } else {
            return {
                declared,
                canonical,
                declaredIdentity: before.identity,
                directoryIdentity: inodeIdentity(directory),
                handle,
            }
        }
    } catch {
        failure = diagnostic('PROJECTION_GUIDE_UNAVAILABLE', `declared sibling root could not be observed: ${declared}`, { target: declared })
    }
    try {
        await handle?.close()
    } catch {
        return diagnostic('PROJECTION_GUIDE_CLOSE_FAILED', `sibling root authority descriptor close failed: ${declared}`, { target: declared })
    }
    return failure ?? diagnostic('PROJECTION_GUIDE_UNAVAILABLE', `declared sibling root observation produced no result: ${declared}`, { target: declared })
}

async function rootAuthorityStable(root: RootAuthority): Promise<boolean> {
    try {
        const directory = await root.handle.stat({ bigint: true })
        const declared = await rootEntryIdentity(root.declared)
        const canonical = await realpath(root.declared)
        const direct = await lstat(canonical, { bigint: true })
        return directory.isDirectory() && direct.isDirectory()
            && root.declaredIdentity === declared.identity && root.canonical === canonical
            && root.directoryIdentity === inodeIdentity(directory) && root.directoryIdentity === inodeIdentity(direct)
    } catch {
        return false
    }
}

async function finishRootObservation(
    roots: readonly RootAuthority[],
    outcome: GuideObservationResult,
): Promise<GuideObservationResult> {
    let closeFailure: ProjectionDiagnostic | undefined
    for (const root of roots) {
        try {
            await root.handle.close()
        } catch {
            closeFailure ??= diagnostic('PROJECTION_GUIDE_CLOSE_FAILED', `sibling root authority descriptor close failed: ${root.declared}`, { target: root.declared })
        }
    }
    return closeFailure ? observedOutcome({ kind: 'refusal', diagnostic: closeFailure }) : outcome
}

async function pathIdentity(sourcePath: string): Promise<PathIdentity> {
    const entry = await lstat(sourcePath, { bigint: true })
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('guide entry type is unsupported')
    const entryType = entry.isSymbolicLink() ? 'symlink' : 'file'
    const linkTarget = entryType === 'symlink' ? await readlink(sourcePath) : undefined
    const contentPath = await realpath(sourcePath)
    const target = await lstat(contentPath, { bigint: true })
    return { entry, entryType, ...(linkTarget === undefined ? {} : { linkTarget }), contentPath, target }
}

async function readGuide(
    request: GuideObservationRequest,
    requestRoot: RootAuthority,
): Promise<GuideObservation | 'missing' | ProjectionDiagnostic> {
    if (!await rootAuthorityStable(requestRoot)) {
        return diagnostic('PROJECTION_GUIDE_CHANGED', `declared sibling root changed before guide observation: ${request.root}`, { target: request.root })
    }
    let pathBefore: PathIdentity
    try {
        pathBefore = await pathIdentity(request.sourcePath)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
        return diagnostic('PROJECTION_GUIDE_UNAVAILABLE', `guide entry could not be observed: ${request.sourcePath}`, { target: request.sourcePath })
    }
    if (!await rootAuthorityStable(requestRoot)) {
        return diagnostic('PROJECTION_GUIDE_CHANGED', `declared sibling root changed during guide entry observation: ${request.root}`, { target: request.root })
    }
    if (!contained(requestRoot.canonical, pathBefore.contentPath)) {
        return diagnostic('PROJECTION_GUIDE_ESCAPE', `guide resolves outside its declared sibling root: ${request.sourcePath}`, {
            target: request.sourcePath, expected: requestRoot.canonical, actual: pathBefore.contentPath,
        })
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined
    let result: GuideObservation | ProjectionDiagnostic | undefined
    try {
        handle = await open(request.sourcePath, 'r')
    } catch {
        if (!await rootAuthorityStable(requestRoot)) {
            return diagnostic('PROJECTION_GUIDE_CHANGED', `declared sibling root changed before guide open: ${request.root}`, { target: request.root })
        }
        return diagnostic('PROJECTION_GUIDE_UNAVAILABLE', `guide content could not be opened: ${request.sourcePath}`, { target: request.sourcePath })
    }
    try {
        const before = await handle.stat({ bigint: true })
        if (!await rootAuthorityStable(requestRoot)) {
            result = diagnostic('PROJECTION_GUIDE_CHANGED', `declared sibling root changed during guide open: ${request.root}`, { target: request.root })
        } else if (!before.isFile() || before.size > BigInt(GUIDE_BYTE_LIMIT)
            || inodeIdentity(before) !== inodeIdentity(pathBefore.target)) {
            result = diagnostic('PROJECTION_GUIDE_CHANGED', `guide changed before its bounded read: ${request.sourcePath}`, { target: request.sourcePath })
        } else {
            const buffer = Buffer.alloc(Number(before.size) + 1)
            let offset = 0
            let rootChanged = false
            while (offset < buffer.byteLength) {
                if (!await rootAuthorityStable(requestRoot)) {
                    rootChanged = true
                    break
                }
                const read = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
                if (!await rootAuthorityStable(requestRoot)) {
                    rootChanged = true
                    break
                }
                if (read.bytesRead === 0) break
                offset += read.bytesRead
            }
            const after = await handle.stat({ bigint: true })
            let pathAfter: PathIdentity | undefined
            try {
                if (!await rootAuthorityStable(requestRoot)) rootChanged = true
                pathAfter = await pathIdentity(request.sourcePath)
                if (!await rootAuthorityStable(requestRoot)) rootChanged = true
            } catch {
                // A pathname that disappears or becomes unreadable during the read is an identity change.
            }
            if (rootChanged) {
                result = diagnostic('PROJECTION_GUIDE_CHANGED', `declared sibling root changed during guide read: ${request.root}`, { target: request.root })
            } else if (offset > GUIDE_BYTE_LIMIT || statIdentity(before) !== statIdentity(after) || !pathAfter
                || statIdentity(pathBefore.entry) !== statIdentity(pathAfter.entry)
                || pathBefore.entryType !== pathAfter.entryType || pathBefore.linkTarget !== pathAfter.linkTarget
                || pathBefore.contentPath !== pathAfter.contentPath
                || statIdentity(pathBefore.target) !== statIdentity(pathAfter.target)
                || inodeIdentity(after) !== inodeIdentity(pathAfter.target)) {
                result = diagnostic('PROJECTION_GUIDE_CHANGED', `guide changed during its bounded read: ${request.sourcePath}`, { target: request.sourcePath })
            } else if (!contained(requestRoot.canonical, pathAfter.contentPath)) {
                result = diagnostic('PROJECTION_GUIDE_ESCAPE', `guide resolves outside its declared sibling root: ${request.sourcePath}`, {
                    target: request.sourcePath, expected: requestRoot.canonical, actual: pathAfter.contentPath,
                })
            } else {
                let content: string | undefined
                try {
                    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
                } catch {
                    result = diagnostic('PROJECTION_GUIDE_UNAVAILABLE', `guide is not valid UTF-8: ${request.sourcePath}`, { target: request.sourcePath })
                }
                if (content !== undefined) {
                    result = capturedValue<GuideObservation>({
                        slug: request.slug,
                        sourcePath: request.sourcePath,
                        sourceEntryType: pathAfter.entryType,
                        ...(pathAfter.linkTarget === undefined ? {} : { sourceLinkTarget: pathAfter.linkTarget }),
                        contentPath: pathAfter.contentPath,
                        content,
                        contentBytes: offset,
                        contentSha256: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex'),
                        contentIdentity: statIdentity(after),
                    }) ?? RESULT_BOUNDS_DIAGNOSTIC
                }
            }
        }
    } catch {
        result = diagnostic('PROJECTION_GUIDE_READ_FAILED', `guide descriptor read failed: ${request.sourcePath}`, { target: request.sourcePath })
    }
    try {
        await handle.close()
    } catch {
        return diagnostic('PROJECTION_GUIDE_CLOSE_FAILED', `guide descriptor close failed: ${request.sourcePath}`, { target: request.sourcePath })
    }
    return result ?? diagnostic('PROJECTION_GUIDE_READ_FAILED', `guide descriptor read produced no bounded result: ${request.sourcePath}`, { target: request.sourcePath })
}

export async function observeSiblingGuides(input: unknown): Promise<GuideObservationResult> {
    const captured = snapshotRequests(input)
    if (!captured) return observedOutcome({ kind: 'refusal', diagnostic: diagnostic('PROJECTION_INPUT_INVALID', 'guide observation input is invalid') })
    const allowedRoots: RootAuthority[] = []
    for (const declared of captured.allowedRoots) {
        const root = await captureRootAuthority(declared)
        if ('code' in root) {
            const kind = root.code === 'PROJECTION_GUIDE_CHANGED' || root.code === 'PROJECTION_GUIDE_CLOSE_FAILED' ? 'refusal' : 'unavailable'
            return finishRootObservation(allowedRoots, observedOutcome({ kind, diagnostic: root }))
        }
        allowedRoots.push(root)
    }
    if (new Set(allowedRoots.map(root => root.canonical)).size !== allowedRoots.length) {
        return finishRootObservation(allowedRoots, observedOutcome({ kind: 'refusal', diagnostic: diagnostic('PROJECTION_ROOT_AMBIGUOUS', 'declared sibling roots resolve to the same canonical authority') }))
    }
    const observations: GuideObservation[] = []
    const missing: string[] = []
    let contentBytes = 0
    for (const request of captured.requests) {
        const mostSpecificRoot = allowedRoots.filter(root => contained(root.declared, request.sourcePath))
            .sort((left, right) => {
                const leftDepth = relative(left.declared, request.sourcePath).split(/[\\/]/).length
                const rightDepth = relative(right.declared, request.sourcePath).split(/[\\/]/).length
                return leftDepth - rightDepth || left.declared.localeCompare(right.declared)
            })[0]
        if (!mostSpecificRoot || request.root !== mostSpecificRoot.declared) {
            return finishRootObservation(allowedRoots, observedOutcome({ kind: 'refusal', diagnostic: diagnostic('PROJECTION_INPUT_INVALID', `guide request is not bound to its most-specific sibling root: ${request.sourcePath}`, { target: request.sourcePath }) }))
        }
        const requestRoot = allowedRoots.find(root => root.declared === request.root)!
        const observed = await readGuide(request, requestRoot)
        if (observed === 'missing') missing.push(request.sourcePath)
        else if ('code' in observed) {
            const refusal = ['PROJECTION_GUIDE_CHANGED', 'PROJECTION_GUIDE_ESCAPE', 'PROJECTION_GUIDE_READ_FAILED',
                'PROJECTION_GUIDE_CLOSE_FAILED', 'PROJECTION_RESULT_BOUNDS'].includes(observed.code)
            return finishRootObservation(allowedRoots, observedOutcome({ kind: refusal ? 'refusal' : 'unavailable', diagnostic: observed }))
        } else {
            contentBytes += observed.contentBytes
            if (contentBytes > OBSERVATION_CONTENT_BYTE_LIMIT) return finishRootObservation(allowedRoots, OBSERVATION_RESULT_BOUNDS)
            observations.push(observed)
        }
    }
    return finishRootObservation(allowedRoots, observedOutcome({ kind: 'complete', observations, missing }))
}

interface CapturedInput {
    readonly canonicalMainCheckout: string
    readonly siblingsRoot: string
    readonly activeProfiles: readonly string[]
    readonly guideCapLines: number
    readonly siblings: readonly ProjectionSiblingInput[]
    readonly mountedPaths: readonly { readonly slug: string; readonly path: string }[]
    readonly directoryGrants: readonly { readonly slug: string; readonly target: SurfaceTarget; readonly path: string }[]
    readonly guideObservations: readonly GuideObservation[]
    readonly existingEntries: readonly { readonly path: string; readonly type: EntryType; readonly target?: string }[]
    readonly priorOwnedLinks: readonly { readonly path: string; readonly target: string }[]
    readonly standingSources: readonly { readonly target: SurfaceTarget; readonly path: string; readonly content: string; readonly scope: 'always' | 'scoped' }[]
    readonly loadCharacterizations: Readonly<Partial<Record<SurfaceTarget, LoadCostCharacterization>>>
}

function target(value: JsonSnapshot | undefined): value is SurfaceTarget {
    return typeof value === 'string' && (SURFACE_TARGETS as readonly string[]).includes(value)
}

function stringArray(value: JsonSnapshot | undefined): readonly string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as readonly string[] : undefined
}

function capturePlannerInput(input: unknown): CapturedInput | undefined {
    const value = snapshotJson(input)
    if (!isObject(value) || !exactKeys(value, [
        'canonicalMainCheckout', 'siblingsRoot', 'activeProfiles', 'guideCapLines', 'siblings',
        'mountedPaths', 'directoryGrants', 'guideObservations', 'existingEntries',
        'priorOwnedLinks', 'standingSources', 'loadCharacterizations',
    ], ['invocationCwd'])
        || typeof value.canonicalMainCheckout !== 'string' || !isAbsolute(value.canonicalMainCheckout)
        || typeof value.siblingsRoot !== 'string' || value.siblingsRoot.length === 0
        || typeof value.guideCapLines !== 'number' || !Number.isSafeInteger(value.guideCapLines) || value.guideCapLines <= 0
        || !Array.isArray(value.siblings) || value.siblings.length > GUIDE_COUNT_LIMIT
        || !Array.isArray(value.mountedPaths) || value.mountedPaths.length > GUIDE_COUNT_LIMIT
        || !Array.isArray(value.directoryGrants) || !Array.isArray(value.guideObservations)
        || !Array.isArray(value.existingEntries) || !Array.isArray(value.priorOwnedLinks)
        || !Array.isArray(value.standingSources) || !isObject(value.loadCharacterizations)
        || value.directoryGrants.length > GUIDE_COUNT_LIMIT * SURFACE_TARGETS.length
        || value.guideObservations.length > GUIDE_COUNT_LIMIT || value.existingEntries.length > GUIDE_COUNT_LIMIT * 2
        || value.priorOwnedLinks.length > GUIDE_COUNT_LIMIT || value.standingSources.length > GUIDE_COUNT_LIMIT * SURFACE_TARGETS.length) return undefined
    const activeProfiles = stringArray(value.activeProfiles)
    if (!activeProfiles || new Set(activeProfiles).size !== activeProfiles.length
        || activeProfiles.some(profile => !/^[a-z0-9][a-z0-9.-]*$/.test(profile))) return undefined

    const siblings: ProjectionSiblingInput[] = []
    const siblingSlugs = new Set<string>()
    for (const row of value.siblings) {
        if (!isObject(row) || !exactKeys(row, ['slug', 'mount', 'directoryAuthority'], ['declaredOverride', 'guides'])
            || typeof row.slug !== 'string' || !SLUG.test(row.slug) || siblingSlugs.has(row.slug)
            || typeof row.mount !== 'string' || !/^(?:always|host|none|profile:[a-z0-9][a-z0-9-]*)$/.test(row.mount)
            || typeof row.directoryAuthority !== 'string' || row.directoryAuthority.length === 0
            || row.declaredOverride !== undefined && (typeof row.declaredOverride !== 'string' || !isAbsolute(row.declaredOverride))) return undefined
        const guides = row.guides === undefined ? ['CLAUDE.md', 'AGENTS.md'] : stringArray(row.guides)
        if (!guides || guides.length > GUIDE_COUNT_LIMIT || new Set(guides).size !== guides.length || guides.some(guide => !safeGuidePath(guide))) return undefined
        siblingSlugs.add(row.slug)
        siblings.push({
            slug: row.slug,
            mount: row.mount as Mount,
            directoryAuthority: row.directoryAuthority,
            ...(row.declaredOverride === undefined ? {} : { declaredOverride: row.declaredOverride }),
            guides: [...guides],
        })
    }

    const mountedPaths: Array<{ slug: string; path: string }> = []
    const mountIds = new Set<string>()
    for (const row of value.mountedPaths) {
        if (!isObject(row) || !exactKeys(row, ['slug', 'path']) || typeof row.slug !== 'string' || !SLUG.test(row.slug)
            || mountIds.has(row.slug) || typeof row.path !== 'string' || !isAbsolute(row.path)) return undefined
        mountIds.add(row.slug)
        mountedPaths.push({ slug: row.slug, path: row.path })
    }

    const directoryGrants: Array<{ slug: string; target: SurfaceTarget; path: string }> = []
    const grantIds = new Set<string>()
    for (const row of value.directoryGrants) {
        if (!isObject(row) || !exactKeys(row, ['slug', 'target', 'path']) || typeof row.slug !== 'string' || !SLUG.test(row.slug)
            || !target(row.target) || typeof row.path !== 'string' || !isAbsolute(row.path)) return undefined
        const id = `${row.slug}\0${row.target}`
        if (grantIds.has(id)) return undefined
        grantIds.add(id)
        directoryGrants.push({ slug: row.slug, target: row.target, path: row.path })
    }

    const guideObservations: GuideObservation[] = []
    const observationIds = new Set<string>()
    for (const row of value.guideObservations) {
        if (!isObject(row) || !exactKeys(row, ['slug', 'sourcePath', 'sourceEntryType', 'contentPath', 'content', 'contentBytes', 'contentSha256', 'contentIdentity'], ['sourceLinkTarget'])
            || typeof row.slug !== 'string' || !SLUG.test(row.slug) || typeof row.sourcePath !== 'string' || !isAbsolute(row.sourcePath)
            || typeof row.contentPath !== 'string' || !isAbsolute(row.contentPath)
            || row.sourceEntryType !== 'file' && row.sourceEntryType !== 'symlink'
            || row.sourceLinkTarget !== undefined && typeof row.sourceLinkTarget !== 'string'
            || typeof row.content !== 'string' || typeof row.contentBytes !== 'number' || !Number.isSafeInteger(row.contentBytes)
            || Buffer.byteLength(row.content) !== row.contentBytes || row.contentBytes > GUIDE_BYTE_LIMIT
            || typeof row.contentSha256 !== 'string' || !SHA256.test(row.contentSha256)
            || createHash('sha256').update(row.content).digest('hex') !== row.contentSha256
            || typeof row.contentIdentity !== 'string' || row.contentIdentity.length === 0
            || observationIds.has(`${row.slug}\0${row.sourcePath}`)) return undefined
        observationIds.add(`${row.slug}\0${row.sourcePath}`)
        guideObservations.push(row as unknown as GuideObservation)
    }

    const existingEntries: Array<{ path: string; type: EntryType; target?: string }> = []
    const entryPaths = new Set<string>()
    for (const row of value.existingEntries) {
        if (!isObject(row) || !exactKeys(row, ['path', 'type'], ['target']) || typeof row.path !== 'string' || entryPaths.has(row.path)
            || !['file', 'symlink', 'directory', 'other'].includes(String(row.type))
            || row.target !== undefined && typeof row.target !== 'string'
            || row.type === 'symlink' && typeof row.target !== 'string') return undefined
        entryPaths.add(row.path)
        existingEntries.push(row as unknown as { path: string; type: EntryType; target?: string })
    }

    const priorOwnedLinks: Array<{ path: string; target: string }> = []
    const priorPaths = new Set<string>()
    for (const row of value.priorOwnedLinks) {
        if (!isObject(row) || !exactKeys(row, ['path', 'target']) || typeof row.path !== 'string' || !safeOwnedLinkPath(row.path)
            || priorPaths.has(row.path) || typeof row.target !== 'string') return undefined
        priorPaths.add(row.path)
        priorOwnedLinks.push({ path: row.path, target: row.target })
    }

    const standingSources: Array<{ target: SurfaceTarget; path: string; content: string; scope: 'always' | 'scoped' }> = []
    const standingIds = new Set<string>()
    for (const row of value.standingSources) {
        if (!isObject(row) || !exactKeys(row, ['target', 'path', 'content', 'scope']) || !target(row.target)
            || typeof row.path !== 'string' || !safeGuidePath(row.path) || typeof row.content !== 'string'
            || row.scope !== 'always' && row.scope !== 'scoped' || standingIds.has(`${row.target}\0${row.path}`)) return undefined
        standingIds.add(`${row.target}\0${row.path}`)
        standingSources.push(row as unknown as { target: SurfaceTarget; path: string; content: string; scope: 'always' | 'scoped' })
    }

    const loadCharacterizations: Partial<Record<SurfaceTarget, LoadCostCharacterization>> = {}
    if (Object.keys(value.loadCharacterizations).some(key => !(SURFACE_TARGETS as readonly string[]).includes(key))) return undefined
    for (const harness of SURFACE_TARGETS) {
        const row = value.loadCharacterizations[harness]
        if (row === undefined || row === null) continue
        if (!isObject(row) || !exactKeys(row, ['measuredOn', 'provenance', 'metric', 'scopeSemantics'])
            || typeof row.measuredOn !== 'string' || !DATE.test(row.measuredOn)
            || typeof row.provenance !== 'string' || row.provenance.length === 0
            || row.metric !== 'lines' || row.scopeSemantics !== 'conditional' && row.scopeSemantics !== 'full') return undefined
        loadCharacterizations[harness] = row as unknown as LoadCostCharacterization
    }

    return {
        canonicalMainCheckout: value.canonicalMainCheckout,
        siblingsRoot: value.siblingsRoot,
        activeProfiles,
        guideCapLines: value.guideCapLines,
        siblings,
        mountedPaths,
        directoryGrants,
        guideObservations,
        existingEntries,
        priorOwnedLinks,
        standingSources,
        loadCharacterizations,
    }
}

function selected(row: ProjectionSiblingInput, profiles: ReadonlySet<string>): boolean {
    return row.mount === 'always' || row.mount.startsWith('profile:') && profiles.has(row.mount.slice(8))
}

function siblingDirectory(input: CapturedInput, row: ProjectionSiblingInput): string {
    if (row.declaredOverride !== undefined) return resolve(row.declaredOverride)
    if (isAbsolute(row.directoryAuthority)) return resolve(row.directoryAuthority)
    return resolve(input.canonicalMainCheckout, input.siblingsRoot, row.directoryAuthority)
}

function linkPath(slug: string, guide: string): string {
    return `.sibling-${slug}-${guide.replaceAll('/', '-')}`
}

const INSTRUCTION_CAPABILITIES = Object.freeze([
    Object.freeze({
        target: 'claudecode', mechanism: 'claude-relative-import', capability: 'instructed', evidence: 'pending_evidence',
        characterizedOn: '2026-09-26', provenance: 'source setup projection header and in-tree relative import measurement',
    }),
    Object.freeze({
        target: 'codexcli', mechanism: 'codex-root-instruction', capability: 'instructed', evidence: 'pending_evidence',
        characterizedOn: '2026-09-26', provenance: 'Codex reads root AGENTS.md; native file-import syntax remains unavailable',
    }),
    Object.freeze({
        target: 'opencode', mechanism: 'opencode-instructions', capability: 'instructed', evidence: 'pending_evidence',
        characterizedOn: '2026-09-26', provenance: 'source instructions-list loading measurement',
    }),
    Object.freeze({
        target: 'cursor', mechanism: 'rulesync-rules', capability: 'unavailable', evidence: 'not_applicable',
        characterizedOn: '2026-10-28', provenance: 'no authenticated native candidate and broken-control probe is committed',
    }),
    Object.freeze({
        target: 'grokcli', mechanism: 'rulesync-rules', capability: 'unavailable', evidence: 'not_applicable',
        characterizedOn: '2026-10-28', provenance: 'no authenticated native candidate and broken-control probe is committed',
    }),
] as const satisfies readonly ShippedInstructionCapability[])
const issuedInstructionCapabilities = new WeakSet<object>()

export function shippedInstructionCapabilities(): readonly ShippedInstructionCapability[] {
    const rows = Object.freeze(INSTRUCTION_CAPABILITIES.map(row => Object.freeze({ ...row })))
    for (const row of rows) issuedInstructionCapabilities.add(row)
    issuedInstructionCapabilities.add(rows)
    return rows
}

function nativeProjection(targetName: GuardSurfaceTarget, link: ProjectionLink, slug: string): NativeProjection {
    const capabilities = shippedInstructionCapabilities()
    const fact = issuedInstructionCapabilities.has(capabilities)
        ? capabilities.find(row => row.target === targetName) : undefined
    if (!fact || !issuedInstructionCapabilities.has(fact) || fact.capability !== 'instructed'
        || fact.evidence !== 'pending_evidence' || fact.mechanism === 'rulesync-rules' || fact.characterizedOn !== '2026-09-26') {
        throw new Error(`instruction capability is unavailable for ${targetName}`)
    }
    if (targetName === 'claudecode') return {
        target: targetName,
        path: 'CLAUDE.local.md',
        mechanism: fact.mechanism,
        spelling: `@./${link.path}`,
        linkPath: link.path,
        ownership: 'shared-region',
        capability: fact.capability,
        evidence: fact.evidence,
        characterizedOn: fact.characterizedOn,
        provenance: fact.provenance,
    }
    if (targetName === 'codexcli') return {
        target: targetName,
        path: 'AGENTS.md',
        mechanism: fact.mechanism,
        spelling: `Read ./${link.path} before editing ${slug}.`,
        linkPath: link.path,
        ownership: 'shared-region',
        capability: fact.capability,
        evidence: fact.evidence,
        characterizedOn: fact.characterizedOn,
        provenance: fact.provenance,
    }
    return {
        target: targetName,
        path: 'opencode.jsonc',
        mechanism: fact.mechanism,
        spelling: link.path,
        linkPath: link.path,
        ownership: 'shared-region',
        capability: fact.capability,
        evidence: fact.evidence,
        characterizedOn: fact.characterizedOn,
        provenance: fact.provenance,
    }
}

function grantSpelling(targetName: SurfaceTarget, path: string): string {
    if (targetName === 'claudecode') return `permissions.additionalDirectories:${path}`
    if (targetName === 'codexcli') return `sandbox_workspace_write.writable_roots:${path}`
    return `permission.external_directory:${path}/**=allow`
}

function lines(content: string): number {
    if (content.length === 0) return 0
    const matches = content.match(/\n/g)?.length ?? 0
    return matches + (content.endsWith('\n') ? 0 : 1)
}

export function planSiblingProjection(input: unknown): ProjectionPlanResult {
    const captured = capturePlannerInput(input)
    if (!captured) return refuse(diagnostic('PROJECTION_INPUT_INVALID', 'sibling projection input is invalid'))
    const profiles = new Set(captured.activeProfiles)
    const active = captured.siblings.filter(row => selected(row, profiles))
    const activeSlugs = new Set(active.map(row => row.slug))
    if (captured.mountedPaths.length !== active.length || captured.mountedPaths.some(row => !activeSlugs.has(row.slug))
        || captured.directoryGrants.length !== active.length * SURFACE_TARGETS.length
        || captured.directoryGrants.some(row => !activeSlugs.has(row.slug))) {
        return refuse(diagnostic('PROJECTION_INPUT_INVALID', 'mounted paths and grants must exactly cover active sibling rows'))
    }

    const links: ProjectionLink[] = []
    const grants: DirectoryGrant[] = []
    for (const sibling of active) {
        const resolvedDirectory = siblingDirectory(captured, sibling)
        const mounted = captured.mountedPaths.find(row => row.slug === sibling.slug)!
        if (mounted.path !== resolvedDirectory) {
            return refuse(diagnostic('PROJECTION_MOUNT_MISMATCH', `projection and generated environment mount disagree for ${sibling.slug}`, {
                target: sibling.slug, expected: resolvedDirectory, actual: mounted.path,
            }))
        }
        for (const harness of SURFACE_TARGETS) {
            const declared = captured.directoryGrants.find(row => row.slug === sibling.slug && row.target === harness)
            if (!declared) return refuse(diagnostic('PROJECTION_INPUT_INVALID', `directory grant coverage is incomplete for ${sibling.slug}:${harness}`))
            if (declared.path !== resolvedDirectory) {
                return refuse(diagnostic('PROJECTION_GRANT_MISMATCH', `projection and ${harness} directory grant disagree for ${sibling.slug}`, {
                    target: `${sibling.slug}:${harness}`, expected: resolvedDirectory, actual: declared.path,
                }))
            }
            grants.push({
                slug: sibling.slug,
                target: harness,
                path: resolvedDirectory,
                spelling: grantSpelling(harness, resolvedDirectory),
                capability: 'instructed',
                evidence: 'pending_evidence',
            })
        }

        const seenContent = new Set<string>()
        const seenPaths = new Set<string>()
        for (const guide of sibling.guides ?? ['CLAUDE.md', 'AGENTS.md']) {
            const sourceGuidePath = join(resolvedDirectory, guide)
            const observation = captured.guideObservations.find(row => row.slug === sibling.slug && row.sourcePath === sourceGuidePath)
            if (!observation || seenContent.has(observation.contentSha256)) continue
            seenContent.add(observation.contentSha256)
            const path = linkPath(sibling.slug, guide)
            if (!safeOwnedLinkPath(path) || seenPaths.has(path) || links.some(link => link.path === path)) {
                return refuse(diagnostic('PROJECTION_INPUT_INVALID', `guide projection path collides: ${path}`, { target: path }))
            }
            seenPaths.add(path)
            const targetPath = relative(dirname(join(captured.canonicalMainCheckout, path)), sourceGuidePath)
            links.push({
                sibling: sibling.slug,
                path,
                target: targetPath,
                sourceGuidePath,
                sourceContentPath: observation.contentPath,
                sourceEntryType: observation.sourceEntryType,
                ...(observation.sourceLinkTarget === undefined ? {} : { sourceLinkTarget: observation.sourceLinkTarget }),
                sourceContentIdentity: observation.contentIdentity,
                sourceContentSha256: observation.contentSha256,
                sourceContentBytes: observation.contentBytes,
                ownership: 'whole-file',
            })
        }
    }

    links.sort((left, right) => left.path.localeCompare(right.path))
    grants.sort((left, right) => left.slug.localeCompare(right.slug)
        || SURFACE_TARGETS.indexOf(left.target as GuardSurfaceTarget) - SURFACE_TARGETS.indexOf(right.target as GuardSurfaceTarget))
    const projectedEntries = links.length * (SURFACE_TARGETS.length + 2) + grants.length
        + captured.priorOwnedLinks.length + SURFACE_TARGETS.length
    if (projectedEntries > PROJECTION_RESULT_ENTRY_LIMIT) return PLANNER_RESULT_BOUNDS
    const native = links.flatMap(link => SURFACE_TARGETS.map(harness => nativeProjection(harness, link, link.sibling)))
        .sort((left, right) => SURFACE_TARGETS.indexOf(left.target as GuardSurfaceTarget)
            - SURFACE_TARGETS.indexOf(right.target as GuardSurfaceTarget) || left.linkPath.localeCompare(right.linkPath))

    const current = new Map(captured.existingEntries.map(entry => [entry.path, entry]))
    const comparisons: ProjectionComparison[] = links.map(link => {
        const actual = current.get(link.path)
        if (!actual) return { path: link.path, state: 'missing', expectedType: 'symlink', expectedTarget: link.target }
        const state = actual.type === 'symlink' && actual.target === link.target ? 'current' : 'drift'
        return {
            path: link.path,
            state,
            expectedType: 'symlink',
            actualType: actual.type,
            expectedTarget: link.target,
            ...(actual.target === undefined ? {} : { actualTarget: actual.target }),
        }
    })
    const desiredPaths = new Set(links.map(link => link.path))
    const staleLinks = captured.priorOwnedLinks.filter(link => {
        const entry = current.get(link.path)
        return !desiredPaths.has(link.path) && entry?.type === 'symlink' && entry.target === link.target
    })

    const costs: StandingCost[] = []
    for (const harness of SURFACE_TARGETS) {
        const characterization = captured.loadCharacterizations[harness]
        if (!characterization) {
            costs.push({ target: harness, status: 'unavailable', reason: 'load cost is not characterized' })
            continue
        }
        const guideCost = native.filter(row => row.target === harness).reduce((sum, row) => {
            if (harness === 'codexcli') return sum + lines(row.spelling)
            const link = links.find(candidate => candidate.path === row.linkPath)!
            const observation = captured.guideObservations.find(candidate => candidate.sourcePath === link.sourceGuidePath)!
            return sum + lines(observation.content)
        }, 0)
        let always = guideCost
        let scoped = 0
        for (const source of captured.standingSources.filter(source => source.target === harness)) {
            if (source.scope === 'scoped' && characterization.scopeSemantics === 'conditional') scoped += lines(source.content)
            else always += lines(source.content)
        }
        costs.push({
            target: harness,
            status: always > captured.guideCapLines ? 'exceeded' : 'within_cap',
            metric: 'lines',
            value: always,
            conditionalValue: scoped,
            cap: captured.guideCapLines,
            measuredOn: characterization.measuredOn,
            provenance: characterization.provenance,
            scopeSemantics: characterization.scopeSemantics,
        })
    }
    const available = costs.filter((cost): cost is Exclude<StandingCost, { status: 'unavailable' }> => cost.status !== 'unavailable')
    const headlineCost = available.reduce<(typeof available)[number] | undefined>((maximum, cost) => !maximum || cost.value > maximum.value ? cost : maximum, undefined)
    return capturedValue<ProjectionPlanResult>({
        kind: 'complete',
        links,
        native,
        grants,
        comparisons,
        staleLinks,
        costs,
        ...(headlineCost ? { headline: { metric: 'lines', value: headlineCost.value, target: headlineCost.target } } : {}),
    }) ?? PLANNER_RESULT_BOUNDS
}
