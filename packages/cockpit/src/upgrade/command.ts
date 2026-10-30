import type { GeneratedEnvironmentCommandOutcome } from '../environment/generated-application.js'
import { runConfiguredUpgradeApplication } from '../environment/upgrade-application.js'
import { snapshotJson, type Diagnostic, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import type { SurfaceFeature } from '../surfaces/contract.js'

export const mechanism = {
    id: 'upgrade-command',
    module: 'packages/cockpit/src/upgrade/command.ts',
    exports: ['unavailableUpgradeDiscovery', 'upgradeCommand', 'runConfiguredUpgradeCommand', 'validReleaseIntegrity'],
} as const

const INTEGRITY = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/

export function validReleaseIntegrity(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 256) return false
    const match = INTEGRITY.exec(value)
    if (!match) return false
    const digest = Buffer.from(match[2]!, 'base64')
    return digest.length === Number(match[1]) / 8 && digest.toString('base64') === match[2]
}

const SHA256 = /^[a-f0-9]{64}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const OVERRIDE_FEATURES = new Set<SurfaceFeature>(['rules', 'subagents', 'skills', 'hooks'])
const REFUSAL_CODES = new Set<UpgradeDiscoveryRefusalCode>([
    'UPGRADE_NETWORK_FAILED',
    'UPGRADE_AUTH_FAILED',
    'UPGRADE_VERSION_AMBIGUOUS',
    'UPGRADE_REPAIR_UNVERIFIED',
])
export interface UpgradeCommandInput {
    readonly configPath: string
}

export interface UpgradeDiscoveryRequest {
    readonly configPath: string
}

export interface UpgradeReleaseIdentity {
    readonly package: string
    readonly version: string
    readonly integrity: string
}

export interface AffectedOverrideOriginal {
    readonly name: string
    readonly feature: Extract<SurfaceFeature, 'rules' | 'subagents' | 'skills' | 'hooks'>
    readonly recordedSha256: string
    readonly currentSha256: string
    readonly overlaySource: string
}

export interface AuthenticatedUpgradeDiscoveryComplete {
    readonly kind: 'complete'
    readonly current: UpgradeReleaseIdentity
    readonly candidate: UpgradeReleaseIdentity
    readonly affectedOverrideOriginals: readonly AffectedOverrideOriginal[]
}

export type UpgradeDiscoveryRefusalCode =
    | 'UPGRADE_NETWORK_FAILED'
    | 'UPGRADE_AUTH_FAILED'
    | 'UPGRADE_VERSION_AMBIGUOUS'
    | 'UPGRADE_REPAIR_UNVERIFIED'

export interface AuthenticatedUpgradeDiscoveryRefusal {
    readonly kind: 'refusal'
    readonly code: UpgradeDiscoveryRefusalCode
    readonly reason: string
}

export type AuthenticatedUpgradeDiscovery =
    | AuthenticatedUpgradeDiscoveryComplete
    | AuthenticatedUpgradeDiscoveryRefusal

export interface UpgradeCommandAdapters {
    readonly discoverAuthenticated: (request: UpgradeDiscoveryRequest) => Promise<unknown>
}

export function unavailableUpgradeDiscovery(
    _request: UpgradeDiscoveryRequest,
): Promise<AuthenticatedUpgradeDiscoveryRefusal> {
    return Promise.resolve(Object.freeze({
        kind: 'refusal',
        code: 'UPGRADE_VERSION_AMBIGUOUS',
        reason: 'candidate release identity is unavailable from an authenticated release source',
    }))
}

export type UpgradeCommandRefusalCode = UpgradeDiscoveryRefusalCode
    | 'UPGRADE_SOURCE_INVALID'
    | 'UPGRADE_DISCOVERY_INVALID'

export interface UpgradeCommandResult {
    readonly current: UpgradeReleaseIdentity
    readonly candidate: UpgradeReleaseIdentity
    readonly affectedOverrideOriginals: readonly AffectedOverrideOriginal[]
    readonly commands: readonly [string, string, string]
}

export type UpgradeCommandOutcome =
    | Readonly<{
        kind: 'complete'
        status: 0
        result: UpgradeCommandResult
        diagnostics: readonly []
    }>
    | Readonly<{
        kind: 'refusal'
        status: 2
        result: null
        diagnostics: readonly Diagnostic<UpgradeCommandRefusalCode>[]
    }>

interface VersionParts {
    readonly major: number
    readonly minor: number
    readonly patch: number
    readonly prerelease: readonly string[]
}

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: JsonSnapshotObject, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function boundedText(value: JsonSnapshot | undefined, maxBytes = 4_096): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes
        && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseVersion(value: JsonSnapshot | undefined): VersionParts | undefined {
    if (typeof value !== 'string' || value.length > 256) return undefined
    const match = VERSION.exec(value)
    if (!match) return undefined
    const numeric = match.slice(1, 4).map(Number)
    if (numeric.some(part => !Number.isSafeInteger(part))) return undefined
    const prerelease = match[4]?.split('.') ?? []
    if (prerelease.some(part => /^\d+$/.test(part) && (part.length > 1 && part.startsWith('0') || !Number.isSafeInteger(Number(part))))) {
        return undefined
    }
    return { major: numeric[0]!, minor: numeric[1]!, patch: numeric[2]!, prerelease }
}

function compareVersions(left: VersionParts, right: VersionParts): number {
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
    }
    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
    }
    const length = Math.max(left.prerelease.length, right.prerelease.length)
    for (let index = 0; index < length; index += 1) {
        const leftPart = left.prerelease[index]
        const rightPart = right.prerelease[index]
        if (leftPart === rightPart) continue
        if (leftPart === undefined) return -1
        if (rightPart === undefined) return 1
        const leftNumeric = /^\d+$/.test(leftPart)
        const rightNumeric = /^\d+$/.test(rightPart)
        if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
        return leftPart < rightPart ? -1 : 1
    }
    return 0
}

function captureIdentity(value: JsonSnapshot | undefined): { identity: UpgradeReleaseIdentity; version: VersionParts } | undefined {
    if (!object(value) || !exactKeys(value, ['package', 'version', 'integrity'])
        || typeof value.package !== 'string' || value.package.length > 214 || !PACKAGE_NAME.test(value.package)
        || !validReleaseIntegrity(value.integrity)) return undefined
    const version = parseVersion(value.version)
    if (!version) return undefined
    return {
        identity: Object.freeze({ package: value.package, version: value.version as string, integrity: value.integrity }),
        version,
    }
}

function safeRelativePath(value: JsonSnapshot | undefined): value is string {
    if (!boundedText(value) || value.length > 1_024 || value.startsWith('/') || value.includes('\\')) return false
    const segments = value.split('/')
    return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function captureAffectedOriginals(value: JsonSnapshot | undefined): readonly AffectedOverrideOriginal[] | undefined {
    if (!Array.isArray(value) || value.length > 256) return undefined
    const names = new Set<string>()
    const originals: AffectedOverrideOriginal[] = []
    for (const item of value) {
        if (!object(item) || !exactKeys(item, ['name', 'feature', 'recordedSha256', 'currentSha256', 'overlaySource'])
            || typeof item.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(item.name)
            || typeof item.feature !== 'string' || !OVERRIDE_FEATURES.has(item.feature as SurfaceFeature)
            || typeof item.recordedSha256 !== 'string' || !SHA256.test(item.recordedSha256)
            || typeof item.currentSha256 !== 'string' || !SHA256.test(item.currentSha256)
            || item.recordedSha256 === item.currentSha256 || !safeRelativePath(item.overlaySource)
            || names.has(item.name)) return undefined
        names.add(item.name)
        originals.push(Object.freeze({
            name: item.name,
            feature: item.feature as AffectedOverrideOriginal['feature'],
            recordedSha256: item.recordedSha256,
            currentSha256: item.currentSha256,
            overlaySource: item.overlaySource,
        }))
    }
    return Object.freeze(originals)
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

function reviewCommands(configPath: string): readonly [string, string, string] {
    const config = shellQuote(configPath)
    return Object.freeze([
        `npx --no cockpit sync --config ${config} --dry-run`,
        `npx --no cockpit sync --config ${config}`,
        `npx --no cockpit preflight --config ${config}`,
    ])
}

function refusal(code: UpgradeCommandRefusalCode, message: string, target?: string): UpgradeCommandOutcome {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: Object.freeze([Object.freeze({
            severity: 'error' as const,
            code,
            message,
            ...(target === undefined ? {} : { target }),
        })]),
    })
}

function captureInput(input: unknown): UpgradeDiscoveryRequest | undefined {
    const captured = snapshotJson(input)
    if (!object(captured) || !boundedText(captured.configPath) || captured.configPath.length > 4_096) return undefined
    return Object.freeze({ configPath: captured.configPath })
}

function captureRefusal(value: JsonSnapshotObject, target: string): UpgradeCommandOutcome | undefined {
    if (!exactKeys(value, ['kind', 'code', 'reason']) || typeof value.code !== 'string'
        || !REFUSAL_CODES.has(value.code as UpgradeDiscoveryRefusalCode) || !boundedText(value.reason)) return undefined
    return refusal(value.code as UpgradeDiscoveryRefusalCode, value.reason as string, target)
}

function captureComplete(value: JsonSnapshotObject, target: string): UpgradeCommandOutcome {
    if (!exactKeys(value, ['kind', 'current', 'candidate', 'affectedOverrideOriginals'])) {
        return refusal('UPGRADE_DISCOVERY_INVALID', 'authenticated upgrade discovery returned an invalid result', target)
    }
    const current = captureIdentity(value.current)
    const candidate = captureIdentity(value.candidate)
    if (!current || !candidate || current.identity.package !== candidate.identity.package
        || compareVersions(candidate.version, current.version) <= 0) {
        return refusal('UPGRADE_VERSION_AMBIGUOUS', 'upgrade discovery did not establish one compatible current and candidate version', target)
    }
    const affectedOverrideOriginals = captureAffectedOriginals(value.affectedOverrideOriginals)
    if (!affectedOverrideOriginals) {
        return refusal('UPGRADE_DISCOVERY_INVALID', 'authenticated upgrade discovery returned invalid affected override originals', target)
    }
    return Object.freeze({
        kind: 'complete' as const,
        status: 0 as const,
        result: Object.freeze({
            current: current.identity,
            candidate: candidate.identity,
            affectedOverrideOriginals,
            commands: reviewCommands(target),
        }),
        diagnostics: Object.freeze([] as const),
    })
}

export async function upgradeCommand(
    input: UpgradeCommandInput,
    adapters: UpgradeCommandAdapters,
): Promise<UpgradeCommandOutcome> {
    const request = captureInput(input)
    if (!request) return refusal('UPGRADE_SOURCE_INVALID', 'upgrade requires a bounded cockpit configuration path')

    let discovered: unknown
    try {
        discovered = await adapters.discoverAuthenticated(request)
    } catch (error) {
        const reason = error instanceof Error && boundedText(error.message) ? error.message : 'unknown transport failure'
        return refusal('UPGRADE_NETWORK_FAILED', `upgrade discovery failed: ${reason}`, request.configPath)
    }

    const captured = snapshotJson(discovered)
    if (!object(captured) || (captured.kind !== 'complete' && captured.kind !== 'refusal')) {
        return refusal('UPGRADE_DISCOVERY_INVALID', 'authenticated upgrade discovery returned an invalid result', request.configPath)
    }
    if (captured.kind === 'refusal') {
        return captureRefusal(captured, request.configPath)
            ?? refusal('UPGRADE_DISCOVERY_INVALID', 'authenticated upgrade discovery returned an invalid refusal', request.configPath)
    }
    return captureComplete(captured, request.configPath)
}

export interface ConfiguredUpgradeCommandInput extends UpgradeCommandInput {
    readonly releaseEvidencePath?: string
    readonly releaseEvidenceSha256?: string
}

interface UpgradeCurrentOverrideProjection {
    readonly activeOverrides: readonly Readonly<{
        name: string
        feature: Extract<SurfaceFeature, 'rules' | 'subagents' | 'skills' | 'hooks'>
        originalSha256: string
        recordedSha256: string
        overlaySource: string
    }>[]
}

export interface ConfiguredUpgradeCommandAdapters {
    readonly installed: Readonly<{ package: string; version: string }>
    readonly createReleaseEvidenceDiscovery: (options: Readonly<{
        configPath: string
        evidencePath: string
        expectedSha256: string
        projection: UpgradeCurrentOverrideProjection
        installed: Readonly<{ package: string; version: string }>
    }>) => UpgradeCommandAdapters['discoverAuthenticated']
}

export async function runConfiguredUpgradeCommand(
    input: ConfiguredUpgradeCommandInput,
    adapters: ConfiguredUpgradeCommandAdapters,
): Promise<UpgradeCommandOutcome | Extract<GeneratedEnvironmentCommandOutcome, { kind: 'refusal' }>> {
    return runConfiguredUpgradeApplication(input, {
        ...adapters,
        unavailableDiscovery: unavailableUpgradeDiscovery,
        runUpgrade: upgradeCommand,
    })
}
