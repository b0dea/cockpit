import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import { readBoundedInput } from '../config/load.js'
import { validReleaseIntegrity } from './command.js'
import { CORE_SURFACE_ASSET_PATHS, coreSurfaceDeclarations } from '../surfaces/core-declarations.js'
import { surfaceDeclarationSha256 } from '../surfaces/merge.js'
import { errorCause } from '../environment/contract.js'
import type { SurfaceFeature } from '../surfaces/contract.js'
import type {
    AffectedOverrideOriginal,
    AuthenticatedUpgradeDiscovery,
    AuthenticatedUpgradeDiscoveryComplete,
    UpgradeDiscoveryRequest,
    UpgradeReleaseIdentity,
} from './command.js'

export const mechanism = {
    id: 'upgrade-release-evidence',
    module: 'packages/cockpit/src/upgrade/release-evidence.ts',
    exports: ['createReleaseRecord', 'assembleReleaseEvidence', 'createReleaseEvidenceDiscovery'],
} as const

const MAX_ORIGINALS = 256
const SHA256 = /^[a-f0-9]{64}$/
const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const FEATURES = new Set<SurfaceFeature>(['rules', 'subagents', 'skills', 'hooks'])

export interface AuthenticatedCurrentOverride {
    readonly name: string
    readonly feature: Extract<SurfaceFeature, 'rules' | 'subagents' | 'skills' | 'hooks'>
    readonly originalSha256: string
    readonly recordedSha256: string
    readonly overlaySource: string
}

export interface AuthenticatedCurrentOverrideProjection {
    readonly activeOverrides: readonly AuthenticatedCurrentOverride[]
}

export interface InstalledUpgradeIdentity {
    readonly package: string
    readonly version: string
    readonly integrity?: string
}

export interface ReleaseEvidenceDiscoveryOptions {
    readonly configPath: string
    readonly evidencePath: string
    readonly expectedSha256: string
    readonly projection: AuthenticatedCurrentOverrideProjection
    readonly installed?: InstalledUpgradeIdentity
}

interface ReleaseOriginal {
    readonly name: string
    readonly feature: AuthenticatedCurrentOverride['feature']
    readonly sha256: string
}

interface ReleaseRecord extends UpgradeReleaseIdentity {
    readonly originals: readonly ReleaseOriginal[]
}

interface ReleaseEvidence {
    readonly schema: 'cockpit-upgrade-release-evidence/v1'
    readonly current: ReleaseRecord
    readonly candidate: ReleaseRecord
}

interface ReleaseRecordDocument {
    readonly schema: 'cockpit-upgrade-release-record/v1'
    readonly release: ReleaseRecord
}

export type ReleaseEvidencePublication =
    | Readonly<{ kind: 'complete'; bytes: string; sha256: string }>
    | Readonly<{ kind: 'refusal'; reason: string }>

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function ownRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort()
    const wanted = [...expected].sort()
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function boundedText(value: unknown, maxBytes = 4_096): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes
        && !/[\u0000-\u001f\u007f]/.test(value)
}

function safeRelativePath(value: unknown): value is string {
    if (!boundedText(value, 1_024) || value.startsWith('/') || value.includes('\\')) return false
    return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function captureOriginals(value: unknown): readonly ReleaseOriginal[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_ORIGINALS) return undefined
    const originals: ReleaseOriginal[] = []
    let previous = ''
    for (const item of value) {
        const record = ownRecord(item)
        if (!record || !exactKeys(record, ['name', 'feature', 'sha256'])
            || typeof record.name !== 'string' || !NAME.test(record.name)
            || typeof record.feature !== 'string' || !FEATURES.has(record.feature as SurfaceFeature)
            || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)
            || record.name <= previous) return undefined
        previous = record.name
        originals.push(Object.freeze({
            name: record.name,
            feature: record.feature as ReleaseOriginal['feature'],
            sha256: record.sha256,
        }))
    }
    return Object.freeze(originals)
}

function captureRelease(value: unknown): ReleaseRecord | undefined {
    const record = ownRecord(value)
    if (!record || !exactKeys(record, ['package', 'version', 'integrity', 'originals'])
        || typeof record.package !== 'string' || !PACKAGE_NAME.test(record.package)
        || typeof record.version !== 'string' || !VERSION.test(record.version)
        || !validReleaseIntegrity(record.integrity)) return undefined
    const originals = captureOriginals(record.originals)
    return originals ? Object.freeze({
        package: record.package,
        version: record.version,
        integrity: record.integrity,
        originals,
    }) : undefined
}

function captureEvidence(value: unknown): ReleaseEvidence | undefined {
    const record = ownRecord(value)
    if (!record || !exactKeys(record, ['schema', 'current', 'candidate'])
        || record.schema !== 'cockpit-upgrade-release-evidence/v1') return undefined
    const current = captureRelease(record.current)
    const candidate = captureRelease(record.candidate)
    return current && candidate && current.package === candidate.package
        ? Object.freeze({ schema: record.schema, current, candidate })
        : undefined
}

function captureReleaseRecord(value: unknown): ReleaseRecordDocument | undefined {
    const record = ownRecord(value)
    if (!record || !exactKeys(record, ['schema', 'release'])
        || record.schema !== 'cockpit-upgrade-release-record/v1') return undefined
    const release = captureRelease(record.release)
    return release ? Object.freeze({ schema: record.schema, release }) : undefined
}

function captureInstalledIdentity(value: unknown): InstalledUpgradeIdentity | undefined {
    const record = ownRecord(value)
    if (!record || !exactKeys(record, record.integrity === undefined
        ? ['package', 'version']
        : ['package', 'version', 'integrity'])
        || typeof record.package !== 'string' || !PACKAGE_NAME.test(record.package)
        || typeof record.version !== 'string' || !VERSION.test(record.version)
        || record.integrity !== undefined && !validReleaseIntegrity(record.integrity)) {
        return undefined
    }
    return Object.freeze({
        package: record.package,
        version: record.version,
        ...(record.integrity === undefined ? {} : { integrity: record.integrity }),
    })
}

function captureProjection(value: unknown): AuthenticatedCurrentOverrideProjection | undefined {
    const projection = ownRecord(value)
    if (!projection || !exactKeys(projection, ['activeOverrides'])
        || !Array.isArray(projection.activeOverrides) || projection.activeOverrides.length > MAX_ORIGINALS) return undefined
    const names = new Set<string>()
    const activeOverrides: AuthenticatedCurrentOverride[] = []
    for (const item of projection.activeOverrides) {
        const record = ownRecord(item)
        if (!record || !exactKeys(record, ['name', 'feature', 'originalSha256', 'recordedSha256', 'overlaySource'])
            || typeof record.name !== 'string' || !NAME.test(record.name) || names.has(record.name)
            || typeof record.feature !== 'string' || !FEATURES.has(record.feature as SurfaceFeature)
            || typeof record.originalSha256 !== 'string' || !SHA256.test(record.originalSha256)
            || typeof record.recordedSha256 !== 'string' || !SHA256.test(record.recordedSha256)
            || !safeRelativePath(record.overlaySource)) return undefined
        names.add(record.name)
        activeOverrides.push(Object.freeze({
            name: record.name,
            feature: record.feature as AuthenticatedCurrentOverride['feature'],
            originalSha256: record.originalSha256,
            recordedSha256: record.recordedSha256,
            overlaySource: record.overlaySource,
        }))
    }
    activeOverrides.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    return Object.freeze({ activeOverrides: Object.freeze(activeOverrides) })
}

type ReadFailure = Readonly<{ cause?: string }>

function causeSuffix(failure: ReadFailure): string {
    return failure.cause ? `: ${failure.cause}` : ''
}

async function readEvidence(path: string, expectedSha256: string): Promise<string | ReadFailure> {
    if (!boundedText(path) || !SHA256.test(expectedSha256)) return {}
    try {
        const read = await readBoundedInput(path)
        if (read.kind !== 'complete' || createHash('sha256').update(read.bytes).digest('hex') !== expectedSha256) return {}
        return new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
    } catch (error) {
        return { cause: errorCause(error) }
    }
}

function publicationComplete(value: ReleaseRecordDocument | ReleaseEvidence): ReleaseEvidencePublication {
    const bytes = `${JSON.stringify(value, null, 2)}\n`
    return Object.freeze({ kind: 'complete', bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
}

function publicationRefusal(reason: string): ReleaseEvidencePublication {
    return Object.freeze({ kind: 'refusal', reason })
}

async function readPackageText(path: string): Promise<string | ReadFailure> {
    try {
        const read = await readBoundedInput(path)
        return read.kind === 'complete' ? new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) : {}
    } catch (error) { return { cause: errorCause(error) } }
}

export async function createReleaseRecord(input: InstalledUpgradeIdentity): Promise<ReleaseEvidencePublication> {
    const supplied = captureInstalledIdentity(input)
    if (!supplied?.integrity) return publicationRefusal('published package identity is invalid')
    const manifestText = await readPackageText(join(PACKAGE_ROOT, 'package.json'))
    let manifest: unknown
    let manifestCause = typeof manifestText === 'string' ? '' : causeSuffix(manifestText)
    try { manifest = typeof manifestText === 'string' ? JSON.parse(manifestText) : undefined } catch (error) {
        manifest = undefined
        manifestCause = `: ${errorCause(error)}`
    }
    const packageManifest = ownRecord(manifest)
    if (!packageManifest || packageManifest.name !== supplied.package || packageManifest.version !== supplied.version) {
        return publicationRefusal(`published package identity does not match the source package manifest${manifestCause}`)
    }
    const assets = new Map<string, Readonly<{ bytes: string }>>()
    for (const path of CORE_SURFACE_ASSET_PATHS) {
        const bytes = await readPackageText(join(PACKAGE_ROOT, 'surfaces', path))
        if (typeof bytes !== 'string') return publicationRefusal(`core surface asset could not be authenticated: ${path}${causeSuffix(bytes)}`)
        assets.set(path, Object.freeze({ bytes }))
    }
    const declarations = coreSurfaceDeclarations(assets)
    if (!declarations) return publicationRefusal('core surface declarations could not be constructed')
    const originals = declarations.map(declaration => Object.freeze({
        name: declaration.name,
        feature: declaration.feature as ReleaseOriginal['feature'],
        sha256: surfaceDeclarationSha256(declaration),
    })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    const release = captureRelease({ ...supplied, originals })
    return release
        ? publicationComplete(Object.freeze({ schema: 'cockpit-upgrade-release-record/v1' as const, release }))
        : publicationRefusal('core release record does not match the exact release schema')
}

export async function assembleReleaseEvidence(input: Readonly<{
    currentPath: string
    currentSha256: string
    candidatePath: string
    candidateSha256: string
}>): Promise<ReleaseEvidencePublication> {
    const currentText = await readEvidence(resolve(input.currentPath), input.currentSha256)
    if (typeof currentText !== 'string') return publicationRefusal(`current release record could not be authenticated${causeSuffix(currentText)}`)
    const candidateText = await readEvidence(resolve(input.candidatePath), input.candidateSha256)
    if (typeof candidateText !== 'string') return publicationRefusal(`candidate release record could not be authenticated${causeSuffix(candidateText)}`)
    let currentValue: unknown
    let candidateValue: unknown
    try { currentValue = JSON.parse(currentText) } catch (error) { return publicationRefusal(`current release record is not valid JSON: ${errorCause(error)}`) }
    try { candidateValue = JSON.parse(candidateText) } catch (error) { return publicationRefusal(`candidate release record is not valid JSON: ${errorCause(error)}`) }
    const current = captureReleaseRecord(currentValue)
    const candidate = captureReleaseRecord(candidateValue)
    if (!current) return publicationRefusal('current release record does not match the exact release schema')
    if (!candidate) return publicationRefusal('candidate release record does not match the exact release schema')
    if (current.release.package !== candidate.release.package) {
        return publicationRefusal('release records do not name the same package')
    }
    return publicationComplete(Object.freeze({
        schema: 'cockpit-upgrade-release-evidence/v1' as const,
        current: current.release,
        candidate: candidate.release,
    }))
}

function refusal(
    code: 'UPGRADE_AUTH_FAILED' | 'UPGRADE_REPAIR_UNVERIFIED',
    reason: string,
): AuthenticatedUpgradeDiscovery {
    return Object.freeze({ kind: 'refusal', code, reason })
}

function joinEvidence(
    evidence: ReleaseEvidence,
    projection: AuthenticatedCurrentOverrideProjection,
): AuthenticatedUpgradeDiscovery {
    const current = new Map(evidence.current.originals.map(original => [original.name, original]))
    const candidate = new Map(evidence.candidate.originals.map(original => [original.name, original]))
    const affected: AffectedOverrideOriginal[] = []
    for (const active of projection.activeOverrides) {
        const before = current.get(active.name)
        const after = candidate.get(active.name)
        if (!before || !after || before.feature !== active.feature || after.feature !== active.feature
            || before.sha256 !== active.originalSha256 || active.recordedSha256 !== active.originalSha256) {
            return refusal('UPGRADE_REPAIR_UNVERIFIED', `release evidence does not match active override "${active.name}"`)
        }
        if (after.sha256 !== before.sha256) {
            affected.push(Object.freeze({
                name: active.name,
                feature: active.feature,
                recordedSha256: before.sha256,
                currentSha256: after.sha256,
                overlaySource: active.overlaySource,
            }))
        }
    }
    const complete: AuthenticatedUpgradeDiscoveryComplete = Object.freeze({
        kind: 'complete',
        current: Object.freeze({
            package: evidence.current.package,
            version: evidence.current.version,
            integrity: evidence.current.integrity,
        }),
        candidate: Object.freeze({
            package: evidence.candidate.package,
            version: evidence.candidate.version,
            integrity: evidence.candidate.integrity,
        }),
        affectedOverrideOriginals: Object.freeze(affected),
    })
    return complete
}

export function createReleaseEvidenceDiscovery(
    options: ReleaseEvidenceDiscoveryOptions,
): (request: UpgradeDiscoveryRequest) => Promise<AuthenticatedUpgradeDiscovery> {
    const configPath = typeof options.configPath === 'string' && options.configPath.length > 0
        ? resolve(options.configPath)
        : undefined
    const evidencePath = typeof options.evidencePath === 'string' && options.evidencePath.length > 0
        ? resolve(options.evidencePath)
        : undefined
    const expectedSha256 = options.expectedSha256
    const projection = captureProjection(options.projection)
    const installed = captureInstalledIdentity(options.installed)
    return async (request) => {
        if (!installed) {
            return refusal('UPGRADE_AUTH_FAILED', 'installed package identity is unavailable or invalid')
        }
        if (!configPath || !evidencePath || !projection || !SHA256.test(expectedSha256)
            || !request || typeof request.configPath !== 'string' || resolve(request.configPath) !== configPath) {
            return refusal('UPGRADE_AUTH_FAILED', 'release evidence is not bound to the requested configuration')
        }
        const bytes = await readEvidence(evidencePath, expectedSha256)
        if (typeof bytes !== 'string') return refusal('UPGRADE_AUTH_FAILED', `release evidence could not be authenticated${causeSuffix(bytes)}`)
        let parsed: unknown
        try { parsed = JSON.parse(bytes) } catch (error) { return refusal('UPGRADE_REPAIR_UNVERIFIED', `release evidence is not valid JSON: ${errorCause(error)}`) }
        const evidence = captureEvidence(parsed)
        if (!evidence) return refusal('UPGRADE_REPAIR_UNVERIFIED', 'release evidence does not match the exact release schema')
        if (evidence.current.package !== installed.package || evidence.current.version !== installed.version
            || installed.integrity !== undefined && evidence.current.integrity !== installed.integrity) {
            return refusal('UPGRADE_AUTH_FAILED', 'release evidence current release does not match the installed package identity')
        }
        return joinEvidence(evidence, projection)
    }
}
