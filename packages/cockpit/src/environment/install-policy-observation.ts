import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

import { InstallPolicy, type InstallPolicy as InstallPolicyValue } from '../schema.js'
import {
    hasErrorCode,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    snapshotJson,
    type CheckoutId,
    type SourceProvenance,
} from './contract.js'
import { checkoutId as deriveCheckoutId } from './identity.js'

const OWNER = 'install-policy-lockfile-observation'

const CHECKOUT_ID = /^checkout:[a-f0-9]{64}$/
const SLUG = /^[a-z0-9][a-z0-9-]*$/
const MAX_VALIDITY_MS = 60_000

interface FileIdentity {
    readonly dev: string
    readonly ino: string
    readonly mode: string
    readonly nlink: string
    readonly size: string
    readonly mtimeNs: string
    readonly ctimeNs: string
}

interface AncestorIdentity {
    readonly canonicalPath: string
    readonly identity: FileIdentity
}

interface AvailableLockfile {
    readonly state: 'available'
    readonly relativePath: string
    readonly canonicalPath: string
    readonly identity: FileIdentity
    readonly ancestors: readonly AncestorIdentity[]
}

interface MissingLockfile {
    readonly state: 'missing'
    readonly relativePath: string
    readonly ancestors: readonly AncestorIdentity[]
}

type ObservedLockfile = AvailableLockfile | MissingLockfile

interface ObservationBinding {
    readonly source: SourceProvenance
    readonly siblingIndex: number
    readonly siblingSlug: string
    readonly checkoutRoot: string
    readonly checkoutId: CheckoutId
    readonly rootIdentity: FileIdentity
    readonly catalogSha256: string
    readonly lockfiles: readonly ObservedLockfile[]
    readonly observedAt: string
    readonly validThrough: string
}

export type InstallPolicyLockfileObservation =
    | ({ readonly state: 'available'; readonly producer: typeof OWNER } & ObservationBinding)
    | {
          readonly state: 'unavailable' | 'failed'
          readonly producer: typeof OWNER
          readonly code:
              | typeof ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE
              | typeof ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_INVALID
          readonly reason: string
      }

export interface InstallPolicyObservationContext {
    readonly source: SourceProvenance
    readonly siblingIndex: number
    readonly siblingSlug: string
    readonly checkoutRoot: string
    readonly checkoutId: CheckoutId
    readonly policies: readonly InstallPolicyValue[]
    readonly evaluatedAt: number
}

export interface ConsumedInstallPolicyObservation extends ObservationBinding {}

const issuedObservations = new WeakMap<object, ObservationBinding>()
const issuedProjections = new WeakMap<object, ObservationBinding>()

declare const installPolicyProjectionBrand: unique symbol
export interface InstallPolicyProjection {
    readonly [installPolicyProjectionBrand]: true
}

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
    try {
        return typeof Reflect.get(value, 'then') === 'function'
    } catch { // A throwing getter on caller-supplied data is treated as promise-like, which the caller refuses.
        return true
    }
}

function confined(root: string, candidate: string): boolean {
    const fromRoot = relative(root, candidate)
    return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function identity(stat: BigIntStats): FileIdentity {
    return Object.freeze({
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString(),
        nlink: stat.nlink.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
    })
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return Object.keys(left).every((key) => left[key as keyof FileIdentity] === right[key as keyof FileIdentity])
}

function sameSource(left: SourceProvenance, right: SourceProvenance): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

function validSource(value: unknown): value is SourceProvenance {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const source = value as Record<string, unknown>
    return typeof source.path === 'string' && !source.path.includes('\0')
        && isAbsolute(source.path) && normalize(source.path) === source.path
        && Number.isSafeInteger(source.byteLength) && (source.byteLength as number) >= 0
        && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256)
}

function validRelativePath(path: string): boolean {
    return path.length > 0 && !/[\x00-\x1f\x7f]/.test(path) && !path.includes('\\') && !isAbsolute(path)
        && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
        && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function snapshotPolicies(value: unknown): readonly InstallPolicyValue[] | undefined {
    const snapshot = snapshotJson(value)
    if (!Array.isArray(snapshot) || snapshot.length > 4_096) return undefined
    const parsed = snapshot.map((row) => InstallPolicy.safeParse(row))
    if (parsed.some((row) => !row.success)) return undefined
    const policies = parsed.map((row) => (row as Extract<typeof row, { success: true }>).data)
    const selectors = policies.map(({ toolchain, lockfile }) => `${toolchain}\0${lockfile}`)
    const volumes = policies.map(({ volume }) => volume)
    return new Set(selectors).size === selectors.length && new Set(volumes).size === volumes.length
        ? policies
        : undefined
}

function catalogSha256(policies: readonly InstallPolicyValue[]): string {
    const rows = policies.map((policy) => JSON.stringify(policy)).sort()
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

async function stableRoot(path: string): Promise<{ canonicalPath: string; identity: FileIdentity } | Readonly<{ reason: string }>> {
    try {
        const before = await lstat(path, { bigint: true })
        if (!before.isDirectory() || before.isSymbolicLink()) return { reason: 'it is not a plain directory' }
        const canonicalPath = await realpath(path)
        const after = await lstat(canonicalPath, { bigint: true })
        const beforeIdentity = identity(before)
        const afterIdentity = identity(after)
        return canonicalPath === path && after.isDirectory() && !after.isSymbolicLink()
            && sameIdentity(beforeIdentity, afterIdentity)
            ? { canonicalPath, identity: afterIdentity }
            : { reason: 'it is not canonical or changed while it was read' }
    } catch (error) {
        return { reason: errorCause(error) }
    }
}

async function inspectLockfile(root: string, relativePath: string): Promise<ObservedLockfile | 'invalid'> {
    if (!validRelativePath(relativePath)) return 'invalid'
    const ancestors: AncestorIdentity[] = []
    const parts = relativePath.split('/')
    let current = root
    for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index]!)
        if (!confined(root, current)) return 'invalid'
        try {
            const before = await lstat(current, { bigint: true })
            if (before.isSymbolicLink()) return 'invalid'
            const canonicalPath = await realpath(current)
            const after = await lstat(canonicalPath, { bigint: true })
            const beforeIdentity = identity(before)
            const afterIdentity = identity(after)
            if (!confined(root, canonicalPath) || canonicalPath !== current
                || after.isSymbolicLink() || !sameIdentity(beforeIdentity, afterIdentity)) return 'invalid'
            if (index < parts.length - 1) {
                if (!after.isDirectory()) return 'invalid'
                ancestors.push(Object.freeze({ canonicalPath, identity: afterIdentity }))
                continue
            }
            if (!after.isFile() || after.nlink !== 1n) return 'invalid'
            return Object.freeze({
                state: 'available' as const,
                relativePath,
                canonicalPath,
                identity: afterIdentity,
                ancestors: Object.freeze(ancestors),
            })
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) return 'invalid'
            return Object.freeze({
                state: 'missing' as const,
                relativePath,
                ancestors: Object.freeze(ancestors),
            })
        }
    }
    return 'invalid'
}

function sameObservation(left: ObservedLockfile, right: ObservedLockfile): boolean {
    if (left.state !== right.state || left.relativePath !== right.relativePath
        || left.ancestors.length !== right.ancestors.length) return false
    for (let index = 0; index < left.ancestors.length; index += 1) {
        const leftAncestor = left.ancestors[index]!
        const rightAncestor = right.ancestors[index]!
        if (leftAncestor.canonicalPath !== rightAncestor.canonicalPath
            || !sameIdentity(leftAncestor.identity, rightAncestor.identity)) return false
    }
    return left.state === 'missing' || (right.state === 'available'
        && left.canonicalPath === right.canonicalPath && sameIdentity(left.identity, right.identity))
}

function failure(state: 'unavailable' | 'failed', reason: string): InstallPolicyLockfileObservation {
    return Object.freeze({
        state,
        producer: OWNER,
        code: state === 'unavailable'
            ? ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE
            : ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_INVALID,
        reason,
    })
}

export async function observeInstallPolicyLockfiles(input: unknown): Promise<InstallPolicyLockfileObservation> {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return failure('failed', 'install policy observation input is malformed')
    }
    const value = snapshot as Record<string, unknown>
    const expectedKeys = ['checkoutId', 'checkoutRoot', 'observedAt', 'policies', 'siblingIndex', 'siblingSlug', 'source']
    const policies = snapshotPolicies(value.policies)
    if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')
        || !validSource(value.source)
        || !Number.isSafeInteger(value.siblingIndex) || (value.siblingIndex as number) < 0
        || typeof value.siblingSlug !== 'string' || !SLUG.test(value.siblingSlug)
        || typeof value.checkoutRoot !== 'string' || !isAbsolute(value.checkoutRoot)
        || normalize(value.checkoutRoot) !== value.checkoutRoot
        || typeof value.checkoutId !== 'string' || !CHECKOUT_ID.test(value.checkoutId)
        || !policies || !isCanonicalTimestamp(value.observedAt)) {
        return failure('failed', 'install policy observation input is malformed')
    }
    const issuedAt = Date.now()
    const observedAt = Date.parse(value.observedAt)
    if (observedAt > issuedAt || issuedAt - observedAt > MAX_VALIDITY_MS) {
        return failure('failed', 'install policy observation time is outside the freshness window')
    }

    const root = await stableRoot(value.checkoutRoot)
    if ('reason' in root) return failure('unavailable', `checkout root is unavailable: ${root.reason}`)
    if (deriveCheckoutId({ checkoutPath: root.canonicalPath }) !== value.checkoutId) {
        return failure('failed', 'checkout root does not match its declared identity')
    }

    const rows: ObservedLockfile[] = []
    const lockfiles = [...new Set(policies.map((policy) => policy.lockfile))].sort()
    for (const relativePath of lockfiles) {
        const observed = await inspectLockfile(root.canonicalPath, relativePath)
        if (observed === 'invalid') return failure('failed', `lockfile path is invalid: ${relativePath}`)
        rows.push(observed)
    }
    const binding: ObservationBinding = Object.freeze({
        source: Object.freeze({ ...value.source }),
        siblingIndex: value.siblingIndex as number,
        siblingSlug: value.siblingSlug,
        checkoutRoot: root.canonicalPath,
        checkoutId: value.checkoutId as CheckoutId,
        rootIdentity: root.identity,
        catalogSha256: catalogSha256(policies),
        lockfiles: Object.freeze(rows),
        observedAt: value.observedAt,
        validThrough: new Date(observedAt + MAX_VALIDITY_MS).toISOString(),
    })
    const observation = Object.freeze({ state: 'available' as const, producer: OWNER, ...binding })
    issuedObservations.set(observation, binding)
    return observation
}

export async function withInstallPolicyProjection<T>(
    observation: unknown,
    expected: InstallPolicyObservationContext,
    use: (projection: InstallPolicyProjection) => SynchronousResult<T>,
): Promise<SynchronousResult<T> | undefined> {
    if (observation === null || typeof observation !== 'object') return undefined
    const binding = issuedObservations.get(observation)
    issuedObservations.delete(observation)
    const snapshot = snapshotJson(expected)
    if (!binding || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof use !== 'function') return undefined
    const context = snapshot as Record<string, unknown>
    const expectedKeys = ['checkoutId', 'checkoutRoot', 'evaluatedAt', 'policies', 'siblingIndex', 'siblingSlug', 'source']
    const policies = snapshotPolicies(context.policies)
    const trustedCurrentTime = Date.now()
    if (Object.keys(context).sort().join('\0') !== expectedKeys.join('\0')
        || !validSource(context.source) || !policies
        || !Number.isSafeInteger(context.siblingIndex) || !Number.isSafeInteger(context.evaluatedAt)
        || binding.siblingIndex !== context.siblingIndex || binding.siblingSlug !== context.siblingSlug
        || binding.checkoutRoot !== context.checkoutRoot || binding.checkoutId !== context.checkoutId
        || !sameSource(binding.source, context.source)
        || binding.catalogSha256 !== catalogSha256(policies)
        || (context.evaluatedAt as number) !== Date.parse(binding.observedAt)
        || (context.evaluatedAt as number) > trustedCurrentTime
        || trustedCurrentTime > Date.parse(binding.validThrough)) return undefined

    const root = await stableRoot(binding.checkoutRoot)
    if ('reason' in root || !sameIdentity(root.identity, binding.rootIdentity)
        || deriveCheckoutId({ checkoutPath: root.canonicalPath }) !== binding.checkoutId) return undefined
    for (const lockfile of binding.lockfiles) {
        const current = await inspectLockfile(binding.checkoutRoot, lockfile.relativePath)
        if (current === 'invalid' || !sameObservation(lockfile, current)) return undefined
    }
    const projection = Object.freeze({}) as InstallPolicyProjection
    issuedProjections.set(projection, binding)
    try {
        const result: unknown = use(projection)
        if (isPromiseLike(result)) {
            // The caller receives the contract error immediately; observing the invalid result prevents
            // a later rejection from becoming detached process state.
            void Promise.resolve(result).catch(() => undefined)
            throw new RefusalError('install policy projection callback must be synchronous')
        }
        return result as SynchronousResult<T>
    } finally {
        issuedProjections.delete(projection)
    }
}

export function consumeInstallPolicyProjection(
    projection: InstallPolicyProjection,
): ConsumedInstallPolicyObservation | undefined {
    try {
        if (projection === null || typeof projection !== 'object') return undefined
        const binding = issuedProjections.get(projection)
        if (!binding) return undefined
        issuedProjections.delete(projection)
        return binding
    } catch { // A throwing accessor or proxy trap on the projection makes it malformed; the caller refuses it.
        return undefined
    }
}

export function matchesInstallPolicyCatalog(
    observation: ConsumedInstallPolicyObservation,
    policies: readonly InstallPolicyValue[],
): boolean {
    const snapshot = snapshotPolicies(policies)
    return snapshot !== undefined && observation.catalogSha256 === catalogSha256(snapshot)
}
