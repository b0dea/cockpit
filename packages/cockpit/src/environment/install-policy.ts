import { isAbsolute, normalize } from 'node:path'

import { GuardCommandArgv, InstallPolicy, Sibling, type InstallPolicy as InstallPolicyValue, type Sibling as SiblingValue } from '../schema.js'
import { ENVIRONMENT_CODES, snapshotJson, type CheckoutId, type SourceProvenance } from './contract.js'
import {
    consumeInstallPolicyProjection,
    matchesInstallPolicyCatalog,
    type InstallPolicyProjection,
} from './install-policy-observation.js'

export const GUARD_PROJECT_COMMAND_RENDERED_BYTES = 32_768

export function renderGuardProjectCommand(argv: readonly string[]):
    | { readonly kind: 'complete'; readonly command: string }
    | { readonly kind: 'unavailable'; readonly reason: string } {
    const parsed = GuardCommandArgv.safeParse(snapshotJson(argv))
    if (!parsed.success) return { kind: 'unavailable', reason: 'project command argv exceeds the scalar or word bounds' }
    const command = parsed.data.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(' ')
    return Buffer.byteLength(command) < GUARD_PROJECT_COMMAND_RENDERED_BYTES
        ? { kind: 'complete', command }
        : { kind: 'unavailable', reason: 'project command rendering exceeds the byte bound' }
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
    readonly policy: InstallPolicyValue
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

function unavailable(siblingIndex: number, siblingSlug: string, reason: string): InstallPolicyResolution {
    return {
        kind: 'unavailable',
        code: ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE,
        siblingIndex,
        siblingSlug,
        reason,
    }
}

function sourceProvenance(source: SourceProvenance): SourceProvenance | undefined {
    return typeof source.path === 'string' && !source.path.includes('\0')
        && isAbsolute(source.path) && normalize(source.path) === source.path
        && Number.isSafeInteger(source.byteLength) && source.byteLength >= 0
        && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256)
        ? { path: source.path, byteLength: source.byteLength as number, sha256: source.sha256 }
        : undefined
}

export function resolveInstallPolicies(root: InstallPolicyResolutionInput): InstallPolicyResolution {
    const source = sourceProvenance(root.source)
    const siblingIndex = root.siblingIndex
    const sibling = Sibling.safeParse(root.sibling)
    if (!source || !Array.isArray(root.policies) || !Number.isSafeInteger(siblingIndex) || siblingIndex < 0 || !sibling.success) {
        return unavailable(
            Number.isSafeInteger(siblingIndex) ? siblingIndex : 0,
            sibling.success ? sibling.data.slug : 'configuration',
            'install policy resolution input is invalid',
        )
    }
    const policies = root.policies.map((policy) => InstallPolicy.safeParse(policy))
    if (policies.some((policy) => !policy.success)) {
        return unavailable(siblingIndex, sibling.data.slug, 'install policy catalog is invalid')
    }
    const catalog = policies.map((policy) => (policy as Extract<typeof policy, { success: true }>).data)
    const selectors = catalog.map(({ toolchain, lockfile }) => `${toolchain}\0${lockfile}`)
    if (new Set(selectors).size !== selectors.length) {
        return unavailable(siblingIndex, sibling.data.slug, 'install policy catalog is invalid')
    }
    if (sibling.data.toolchain === 'none') return { kind: 'complete', bindings: [] }
    if (typeof root.checkoutRoot !== 'string' || typeof root.checkoutId !== 'string') {
        return unavailable(siblingIndex, sibling.data.slug, 'authenticated lockfile evidence is unavailable')
    }
    const observation = consumeInstallPolicyProjection(root.projection as InstallPolicyProjection)
    if (!observation) return unavailable(siblingIndex, sibling.data.slug, 'authenticated lockfile evidence is unavailable')
    if (!matchesInstallPolicyCatalog(observation, catalog)
        || observation.siblingIndex !== siblingIndex || observation.siblingSlug !== sibling.data.slug
        || observation.checkoutRoot !== root.checkoutRoot || observation.checkoutId !== root.checkoutId
        || observation.source.path !== source.path || observation.source.byteLength !== source.byteLength
        || observation.source.sha256 !== source.sha256) {
        return unavailable(siblingIndex, sibling.data.slug, 'authenticated lockfile evidence does not match the sibling')
    }
    const present = new Set(observation.lockfiles
        .filter((lockfile) => lockfile.state === 'available')
        .map(({ relativePath }) => relativePath))
    const matches = catalog.flatMap((candidate, catalogIndex) =>
        candidate.toolchain === sibling.data.toolchain && present.has(candidate.lockfile)
            ? [{ catalogIndex, policy: candidate }]
            : [])
    if (matches.length !== 1) {
        const candidates = matches.map(({ policy }) => `${policy.toolchain}:${policy.lockfile}`).sort()
        return {
            kind: 'refusal',
            code: matches.length === 0 ? ENVIRONMENT_CODES.INSTALL_POLICY_MISSING : ENVIRONMENT_CODES.INSTALL_POLICY_AMBIGUOUS,
            siblingIndex,
            siblingSlug: sibling.data.slug,
            candidates,
        }
    }
    const selected = matches[0]!
    for (const kind of ['build', 'test'] as const) {
        const argv = selected.policy[kind]
        if (argv && renderGuardProjectCommand(argv).kind !== 'complete') {
            return unavailable(siblingIndex, sibling.data.slug, `${kind} project command rendering exceeds the byte bound`)
        }
    }
    const binding = {
        source,
        siblingIndex,
        diagnostics: { catalogIndex: selected.catalogIndex },
        siblingSlug: sibling.data.slug,
        checkoutRoot: observation.checkoutRoot,
        checkoutId: observation.checkoutId,
        policy: selected.policy,
    }
    return { kind: 'complete', bindings: [binding] }
}
