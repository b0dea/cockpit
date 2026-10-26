import { createHash } from 'node:crypto'

import { snapshotGeneratedJson, snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'

export const mechanism = {
    id: 'surface-contract',
    module: 'packages/cockpit/src/surfaces/contract.ts',
    exports: [
        'SURFACE_TARGETS', 'SURFACE_FEATURES', 'SURFACE_FILE_MAX_BYTES', 'SURFACE_OUTPUT_MAX_BYTES',
        'SURFACE_OUTPUT_MAX_FILES', 'SURFACE_BUNDLE_FORMATS', 'captureSurfaceBatch', 'captureSurfaceBundleBatch',
        'bundleSurfaceFiles', 'surfaceSourcesMatchFeature',
    ],
} as const

export const SURFACE_TARGETS = Object.freeze(['claudecode', 'codexcli', 'opencode'] as const)
export const SURFACE_FEATURES = Object.freeze(['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const)
export const SURFACE_BUNDLE_FORMATS = Object.freeze(['claudecode-plugin'] as const)
export const SURFACE_FILE_MAX_BYTES = 65_536
export const SURFACE_OUTPUT_MAX_BYTES = 4_194_304
export const SURFACE_OUTPUT_MAX_FILES = 256
export type SurfaceTarget = typeof SURFACE_TARGETS[number]
export type SurfaceFeature = typeof SURFACE_FEATURES[number]
export type SurfaceBundleFormat = typeof SURFACE_BUNDLE_FORMATS[number]

export interface SurfaceSourceFile {
    readonly path: string
    readonly bytes: string
}

export interface SurfaceBatch {
    readonly targets: readonly SurfaceTarget[]
    readonly features: readonly SurfaceFeature[]
    readonly sources: readonly SurfaceSourceFile[]
    readonly expectedOutputs: Readonly<Partial<Record<SurfaceTarget, readonly string[]>>>
}

export interface SurfaceBundleBatch {
    readonly format: SurfaceBundleFormat
    readonly features: readonly SurfaceFeature[]
    readonly sources: readonly SurfaceSourceFile[]
    readonly expectedOutputs: readonly string[]
}

export interface RenderedSurfaceFile {
    readonly target: SurfaceTarget
    readonly path: string
    readonly bytes: string
    readonly sha256: string
}

const TARGETS = new Set<SurfaceTarget>(SURFACE_TARGETS)
const FEATURES = new Set<SurfaceFeature>(SURFACE_FEATURES)
const CLAUDE_PLUGIN_FEATURES = new Set<SurfaceFeature>(['mcp', 'subagents', 'skills', 'hooks'])
const SHA256 = /^[a-f0-9]{64}$/
const RULE_PATH = /^rules\/[^/]+\.md$/
const SUBAGENT_PATH = /^subagents\/[^/]+\.md$/
const SKILL_PATH = /^skills\/([a-z0-9][a-z0-9-]*)\/(.+)$/
const PRIVATE_SEGMENTS = new Set(['.git', 'internal', 'node_modules'])

function exactKeys(value: JsonSnapshotObject, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function isObject(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: JsonSnapshot | undefined): readonly string[] | undefined {
    return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')
        ? value as readonly string[]
        : undefined
}

function uniqueValues<T>(values: readonly T[]): boolean {
    return new Set(values).size === values.length
}

function safeRelativePath(path: string): boolean {
    if (path.length === 0 || path.startsWith('/') || /^[a-z]:\//i.test(path)
        || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) return false
    const segments = path.split('/')
    return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !PRIVATE_SEGMENTS.has(segment))
}

function sourceFeature(path: string): SurfaceFeature | undefined {
    if (RULE_PATH.test(path)) return 'rules'
    if (path === 'mcp.jsonc') return 'mcp'
    if (SUBAGENT_PATH.test(path)) return 'subagents'
    if (SKILL_PATH.test(path)) return 'skills'
    if (path === 'hooks.jsonc') return 'hooks'
    if (path === 'permissions.jsonc') return 'permissions'
    return undefined
}

function validSourceFiles(value: JsonSnapshot | undefined, requested: ReadonlySet<SurfaceFeature>): boolean {
    if (!Array.isArray(value) || value.length === 0) return false
    const paths = new Set<string>()
    const supplied = new Set<SurfaceFeature>()
    const skillRoots = new Set<string>()
    const skillDefinitions = new Set<string>()

    for (const item of value) {
        if (!isObject(item) || !exactKeys(item, ['path', 'bytes'])
            || typeof item.path !== 'string' || typeof item.bytes !== 'string'
            || Buffer.byteLength(item.bytes) > SURFACE_FILE_MAX_BYTES
            || !safeRelativePath(item.path) || paths.has(item.path)) return false
        const feature = sourceFeature(item.path)
        if (!feature || !requested.has(feature)) return false
        paths.add(item.path)
        supplied.add(feature)
        const skill = SKILL_PATH.exec(item.path)
        if (skill) {
            const root = skill[1]!
            skillRoots.add(root)
            if (skill[2] === 'SKILL.md') skillDefinitions.add(root)
        }
    }

    return [...requested].every(feature => supplied.has(feature))
        && [...skillRoots].every(root => skillDefinitions.has(root))
}

export function surfaceSourcesMatchFeature(input: unknown, feature: SurfaceFeature): boolean {
    return FEATURES.has(feature) && validSourceFiles(snapshotJson(input), new Set([feature]))
}

function validExpectedOutputs(
    value: JsonSnapshot | undefined,
    targets: readonly SurfaceTarget[],
): boolean {
    if (!isObject(value) || !exactKeys(value, targets)) return false
    for (const target of targets) {
        const paths = stringArray(value[target])
        if (!paths || !uniqueValues(paths) || paths.some(path => !safeRelativePath(path))) return false
    }
    return true
}

export function captureSurfaceBatch(input: unknown): SurfaceBatch | undefined {
    const snapshot = snapshotJson(input)
    if (!isObject(snapshot) || !exactKeys(snapshot, ['targets', 'features', 'sources', 'expectedOutputs'])) return undefined
    const targets = stringArray(snapshot.targets)
    const features = stringArray(snapshot.features)
    if (!targets || !uniqueValues(targets) || !targets.every(target => TARGETS.has(target as SurfaceTarget))
        || !features || !uniqueValues(features) || !features.every(feature => FEATURES.has(feature as SurfaceFeature))) return undefined

    const admittedTargets = targets as readonly SurfaceTarget[]
    const admittedFeatures = features as readonly SurfaceFeature[]
    if (!validSourceFiles(snapshot.sources, new Set(admittedFeatures))
        || !validExpectedOutputs(snapshot.expectedOutputs, admittedTargets)) return undefined
    return snapshot as unknown as SurfaceBatch
}

export function captureSurfaceBundleBatch(input: unknown): SurfaceBundleBatch | undefined {
    const snapshot = snapshotJson(input)
    if (!isObject(snapshot) || !exactKeys(snapshot, ['format', 'features', 'sources', 'expectedOutputs'])
        || snapshot.format !== 'claudecode-plugin') return undefined
    const features = stringArray(snapshot.features)
    const expectedOutputs = stringArray(snapshot.expectedOutputs)
    if (!features || !uniqueValues(features)
        || !features.every(feature => CLAUDE_PLUGIN_FEATURES.has(feature as SurfaceFeature))
        || !expectedOutputs || !uniqueValues(expectedOutputs) || expectedOutputs.some(path => !safeRelativePath(path))
        || !validSourceFiles(snapshot.sources, new Set(features as readonly SurfaceFeature[]))) return undefined
    return snapshot as unknown as SurfaceBundleBatch
}

function renderedFile(value: JsonSnapshot): RenderedSurfaceFile | undefined {
    if (!isObject(value) || !exactKeys(value, ['target', 'path', 'bytes', 'sha256'])
        || typeof value.target !== 'string' || !TARGETS.has(value.target as SurfaceTarget)
        || typeof value.path !== 'string' || !safeRelativePath(value.path)
        || typeof value.bytes !== 'string' || Buffer.byteLength(value.bytes) > SURFACE_FILE_MAX_BYTES
        || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
        || createHash('sha256').update(value.bytes).digest('hex') !== value.sha256) return undefined
    return value as unknown as RenderedSurfaceFile
}

export function bundleSurfaceFiles(input: readonly RenderedSurfaceFile[]): readonly SurfaceSourceFile[] | undefined {
    const snapshot = snapshotGeneratedJson(input)
    if (!Array.isArray(snapshot) || snapshot.length === 0 || snapshot.length > SURFACE_OUTPUT_MAX_FILES) return undefined
    const paths = new Set<string>()
    const bundled: SurfaceSourceFile[] = []
    let totalBytes = 0
    for (const item of snapshot) {
        const admitted = renderedFile(item)
        if (!admitted) return undefined
        const path = `${admitted.target}/${admitted.path}`
        if (paths.has(path)) return undefined
        totalBytes += Buffer.byteLength(admitted.bytes)
        if (totalBytes > SURFACE_OUTPUT_MAX_BYTES) return undefined
        paths.add(path)
        bundled.push(Object.freeze({ path, bytes: admitted.bytes }))
    }
    bundled.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const bounded = snapshotGeneratedJson(bundled)
    return Array.isArray(bounded) ? bounded as unknown as readonly SurfaceSourceFile[] : undefined
}
