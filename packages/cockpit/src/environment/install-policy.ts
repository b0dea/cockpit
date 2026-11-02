import { isAbsolute, normalize } from 'node:path'
import { isProxy } from 'node:util/types'

import { GuardCommandArgv, InstallPolicy, Sibling, type InstallPolicy as InstallPolicyValue, type Sibling as SiblingValue } from '../schema.js'
import { ENVIRONMENT_CODES, snapshotJson, type CheckoutId, type SourceProvenance } from './contract.js'
import {
    consumeInstallPolicyProjection,
    matchesInstallPolicyCatalog,
    type InstallPolicyProjection,
} from './install-policy-observation.js'

export const mechanism = {
    id: 'install-policy-resolution',
    module: 'packages/cockpit/src/environment/install-policy.ts',
    exports: ['resolveInstallPolicies', 'renderGuardProjectCommand', 'GUARD_PROJECT_COMMAND_RENDERED_BYTES'],
} as const

export const GUARD_PROJECT_COMMAND_RENDERED_BYTES = 32_768

export function renderGuardProjectCommand(argv: readonly string[]):
    | { readonly kind: 'complete'; readonly command: string }
    | { readonly kind: 'unavailable'; readonly reason: string } {
    const parsed = GuardCommandArgv.safeParse(snapshotJson(argv))
    if (!parsed.success) return Object.freeze({ kind: 'unavailable', reason: 'project command argv exceeds the scalar or word bounds' })
    const command = parsed.data.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(' ')
    return Buffer.byteLength(command) < GUARD_PROJECT_COMMAND_RENDERED_BYTES
        ? Object.freeze({ kind: 'complete', command })
        : Object.freeze({ kind: 'unavailable', reason: 'project command rendering exceeds the byte bound' })
}

export interface InstallPolicyResolutionInput {
    readonly source: SourceProvenance
    readonly policies: readonly InstallPolicyValue[]
    readonly siblingIndex: number
    readonly sibling: SiblingValue
    readonly checkoutRoot?: string
    readonly checkoutId?: CheckoutId
    readonly projection?: InstallPolicyProjection
}

export interface ResolvedInstallPolicyBinding {
    readonly source: SourceProvenance
    readonly siblingIndex: number
    readonly diagnostics: Readonly<{ readonly catalogIndex: number }>
    readonly siblingSlug: string
    readonly checkoutRoot: string
    readonly checkoutId: CheckoutId
    readonly policy: ResolvedInstallPolicy
}

export type ResolvedInstallPolicy = Omit<InstallPolicyValue, 'install' | 'load_probe' | 'build' | 'test'> & {
    readonly install: readonly string[]
    readonly load_probe: readonly string[]
    readonly build?: readonly string[]
    readonly test?: readonly string[]
}

export type InstallPolicyResolution =
    | { readonly kind: 'complete'; readonly bindings: readonly ResolvedInstallPolicyBinding[] }
    | {
          readonly kind: 'unavailable'
          readonly code: typeof ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE
          readonly siblingIndex: number
          readonly siblingSlug: string
          readonly reason: string
      }
    | {
          readonly kind: 'refusal'
          readonly code: typeof ENVIRONMENT_CODES.INSTALL_POLICY_MISSING | typeof ENVIRONMENT_CODES.INSTALL_POLICY_AMBIGUOUS
          readonly siblingIndex: number
          readonly siblingSlug: string
          readonly candidates: readonly string[]
      }

function immutablePolicy(policy: InstallPolicyValue): ResolvedInstallPolicy {
    return Object.freeze({
        ...policy,
        install: Object.freeze([...policy.install]),
        load_probe: Object.freeze([...policy.load_probe]),
        ...(policy.build ? { build: Object.freeze([...policy.build]) } : {}),
        ...(policy.test ? { test: Object.freeze([...policy.test]) } : {}),
    })
}

function unavailable(siblingIndex: number, siblingSlug: string, reason: string): InstallPolicyResolution {
    return Object.freeze({
        kind: 'unavailable',
        code: ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE,
        siblingIndex,
        siblingSlug,
        reason,
    })
}

function ownRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return undefined
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const allowed = new Set([...required, ...optional])
        const keys = Reflect.ownKeys(value)
        if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))
            || required.some((key) => !(key in descriptors))
            || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return undefined
        return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

function ownArray(value: unknown): readonly unknown[] | undefined {
    if (!Array.isArray(value) || isProxy(value)) return undefined
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
        const length = descriptors.length?.value
        if (!Number.isSafeInteger(length) || length < 0 || length > 4_096
            || Reflect.ownKeys(value).length !== length + 1) return undefined
        const result: unknown[] = []
        for (let index = 0; index < length; index += 1) {
            const descriptor = descriptors[String(index)]
            if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
            result.push(descriptor.value)
        }
        return result
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

function sourceProvenance(value: unknown): SourceProvenance | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const source = snapshot as Record<string, unknown>
    return typeof source.path === 'string' && !source.path.includes('\0')
        && isAbsolute(source.path) && normalize(source.path) === source.path
        && Number.isSafeInteger(source.byteLength) && (source.byteLength as number) >= 0
        && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256)
        ? Object.freeze({ path: source.path, byteLength: source.byteLength as number, sha256: source.sha256 })
        : undefined
}

export function resolveInstallPolicies(input: InstallPolicyResolutionInput): InstallPolicyResolution {
    const root = ownRecord(
        input,
        ['source', 'policies', 'siblingIndex', 'sibling'],
        ['checkoutRoot', 'checkoutId', 'projection'],
    )
    const source = sourceProvenance(root?.source)
    const policyInputs = ownArray(root?.policies)
    const siblingIndex = root?.siblingIndex
    const sibling = Sibling.safeParse(snapshotJson(root?.sibling))
    if (!source || !policyInputs || !Number.isSafeInteger(siblingIndex) || (siblingIndex as number) < 0 || !sibling.success) {
        return unavailable(
            Number.isSafeInteger(siblingIndex) ? siblingIndex as number : 0,
            sibling.success ? sibling.data.slug : 'configuration',
            'install policy resolution input is invalid',
        )
    }
    const policies = policyInputs.map((policy) => InstallPolicy.safeParse(snapshotJson(policy)))
    if (policies.some((policy) => !policy.success)) {
        return unavailable(siblingIndex as number, sibling.data.slug, 'install policy catalog is invalid')
    }
    const catalog = policies.map((policy) => (policy as Extract<typeof policy, { success: true }>).data)
    const selectors = catalog.map(({ toolchain, lockfile }) => `${toolchain}\0${lockfile}`)
    const volumes = catalog.map(({ volume }) => volume)
    if (new Set(selectors).size !== selectors.length || new Set(volumes).size !== volumes.length) {
        return unavailable(siblingIndex as number, sibling.data.slug, 'install policy catalog is invalid')
    }
    if (sibling.data.toolchain === 'none') return Object.freeze({ kind: 'complete', bindings: Object.freeze([]) })
    if (typeof root?.checkoutRoot !== 'string' || typeof root.checkoutId !== 'string') {
        return unavailable(siblingIndex as number, sibling.data.slug, 'authenticated lockfile evidence is unavailable')
    }
    const observation = consumeInstallPolicyProjection(root.projection as InstallPolicyProjection)
    if (!observation) return unavailable(siblingIndex as number, sibling.data.slug, 'authenticated lockfile evidence is unavailable')
    if (!matchesInstallPolicyCatalog(observation, catalog)
        || observation.siblingIndex !== siblingIndex || observation.siblingSlug !== sibling.data.slug
        || observation.checkoutRoot !== root.checkoutRoot || observation.checkoutId !== root.checkoutId
        || observation.source.path !== source.path || observation.source.byteLength !== source.byteLength
        || observation.source.sha256 !== source.sha256) {
        return unavailable(siblingIndex as number, sibling.data.slug, 'authenticated lockfile evidence does not match the sibling')
    }
    const present = new Set(observation.lockfiles
        .filter((lockfile) => lockfile.state === 'available')
        .map(({ relativePath }) => relativePath))
    const matches = catalog.flatMap((candidate, catalogIndex) =>
        candidate.toolchain === sibling.data.toolchain && present.has(candidate.lockfile)
            ? [{ catalogIndex, policy: candidate }]
            : [])
    if (matches.length !== 1) {
        const candidates = Object.freeze(matches.map(({ policy }) => `${policy.toolchain}:${policy.lockfile}`).sort())
        return Object.freeze({
            kind: 'refusal',
            code: matches.length === 0 ? ENVIRONMENT_CODES.INSTALL_POLICY_MISSING : ENVIRONMENT_CODES.INSTALL_POLICY_AMBIGUOUS,
            siblingIndex: siblingIndex as number,
            siblingSlug: sibling.data.slug,
            candidates,
        })
    }
    const selected = matches[0]!
    for (const kind of ['build', 'test'] as const) {
        const argv = selected.policy[kind]
        if (argv && renderGuardProjectCommand(argv).kind !== 'complete') {
            return unavailable(siblingIndex as number, sibling.data.slug, `${kind} project command rendering exceeds the byte bound`)
        }
    }
    const binding = Object.freeze({
        source,
        siblingIndex: siblingIndex as number,
        diagnostics: Object.freeze({ catalogIndex: selected.catalogIndex }),
        siblingSlug: sibling.data.slug,
        checkoutRoot: observation.checkoutRoot,
        checkoutId: observation.checkoutId,
        policy: immutablePolicy(selected.policy),
    })
    return Object.freeze({ kind: 'complete', bindings: Object.freeze([binding]) })
}
