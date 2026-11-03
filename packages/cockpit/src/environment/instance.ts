import type { CheckoutId, StackId } from './contract.js'
import { RefusalError } from './contract.js'

export interface InstanceCandidate {
    readonly stackId: StackId
    readonly checkoutId: CheckoutId
}

export interface ResolveInstanceInput {
    readonly explicit?: InstanceCandidate
    readonly served: InstanceCandidate
    readonly launcher: InstanceCandidate
    readonly mountedSet: readonly CheckoutId[]
}

export interface InstanceResolution extends InstanceCandidate {
    readonly kind: 'attach' | 'isolate'
    readonly source: 'explicit' | 'served' | 'launcher'
}

export interface SelectDestructiveInstanceInput {
    readonly explicit?: InstanceCandidate
    readonly served?: InstanceCandidate
    readonly launcher?: InstanceCandidate
    readonly claimInventory: readonly InstanceCandidate[]
}

export type DestructiveInstanceSelection =
    | Readonly<{
          kind: 'selected'
          source: 'explicit' | 'served' | 'launcher'
          stackId: StackId
          checkoutId: CheckoutId
      }>
    | Readonly<{
          kind: 'refusal'
          reason: 'ambiguous' | 'identity-conflict' | 'identity-mismatch' | 'missing-authority'
          candidates: readonly InstanceCandidate[]
      }>

const STACK_ID = /^stack:[a-f0-9]{64}$/
const CHECKOUT_ID = /^checkout:[a-f0-9]{64}$/

function candidate(
    value: InstanceCandidate,
    field: string,
    operation: 'resolveInstance' | 'selectDestructiveInstance' = 'resolveInstance',
): InstanceCandidate {
    if (
        value === null
        || typeof value !== 'object'
        || typeof value.stackId !== 'string'
        || !STACK_ID.test(value.stackId)
        || typeof value.checkoutId !== 'string'
        || !CHECKOUT_ID.test(value.checkoutId)
    ) {
        throw new RefusalError(`${operation}: ${field} candidate is malformed`)
    }
    return value
}

function destructiveCandidate(value: InstanceCandidate, field: string): Readonly<InstanceCandidate> {
    if (value === null || typeof value !== 'object') return candidate(value, field, 'selectDestructiveInstance')
    const stackId = value.stackId
    const checkoutId = value.checkoutId
    return Object.freeze(candidate({ stackId, checkoutId }, field, 'selectDestructiveInstance'))
}

function candidateKey(value: InstanceCandidate): string {
    return `${value.stackId}\0${value.checkoutId}`
}

function canonicalCandidates(values: readonly InstanceCandidate[]): readonly InstanceCandidate[] {
    const unique = new Map<string, InstanceCandidate>()
    for (const value of values) unique.set(candidateKey(value), value)
    return Object.freeze(Array.from(unique.values(), (value) => Object.freeze({ ...value })).sort((left, right) => {
        if (left.stackId !== right.stackId) return left.stackId < right.stackId ? -1 : 1
        return left.checkoutId < right.checkoutId ? -1 : left.checkoutId === right.checkoutId ? 0 : 1
    }))
}

function conflictingStackIds(values: readonly InstanceCandidate[]): ReadonlySet<StackId> {
    const checkoutsByStack = new Map<StackId, Set<CheckoutId>>()
    for (const value of values) {
        const checkouts = checkoutsByStack.get(value.stackId) ?? new Set<CheckoutId>()
        checkouts.add(value.checkoutId)
        checkoutsByStack.set(value.stackId, checkouts)
    }
    return new Set(
        Array.from(checkoutsByStack)
            .filter(([, checkouts]) => checkouts.size > 1)
            .map(([stackId]) => stackId),
    )
}

function destructiveRefusal(
    reason: Exclude<DestructiveInstanceSelection, { kind: 'selected' }>['reason'],
    candidates: readonly InstanceCandidate[],
): DestructiveInstanceSelection {
    return Object.freeze({ kind: 'refusal', reason, candidates: canonicalCandidates(candidates) })
}

export function selectDestructiveInstance(input: SelectDestructiveInstanceInput): DestructiveInstanceSelection {
    if (input === null || typeof input !== 'object') {
        throw new RefusalError('selectDestructiveInstance: input is malformed')
    }
    const explicitValue = input.explicit
    const servedValue = input.served
    const launcherValue = input.launcher
    const inventoryValue = input.claimInventory
    const explicit = explicitValue === undefined ? undefined : destructiveCandidate(explicitValue, 'explicit')
    const served = servedValue === undefined ? undefined : destructiveCandidate(servedValue, 'served')
    const launcher = launcherValue === undefined ? undefined : destructiveCandidate(launcherValue, 'launcher')
    if (!Array.isArray(inventoryValue)) {
        throw new RefusalError('selectDestructiveInstance: claimInventory is malformed')
    }
    const inventory = canonicalCandidates(inventoryValue.map((value) => destructiveCandidate(value, 'claimInventory')))
    const conflictingStacks = conflictingStackIds(inventory)

    const inventoryKeys = new Set(inventory.map(candidateKey))
    if (explicit !== undefined) {
        if (conflictingStacks.has(explicit.stackId)) {
            return destructiveRefusal(
                'identity-conflict',
                inventory.filter((value) => value.stackId === explicit.stackId),
            )
        }
        return inventoryKeys.has(candidateKey(explicit))
            ? Object.freeze({ kind: 'selected', source: 'explicit', ...explicit })
            : destructiveRefusal('identity-mismatch', inventory)
    }

    const authorities = [
        ...(served === undefined ? [] : [{ source: 'served' as const, value: served }]),
        ...(launcher === undefined ? [] : [{ source: 'launcher' as const, value: launcher }]),
    ]
    if (authorities.length === 0) return destructiveRefusal('missing-authority', inventory)

    const authorityCandidates = canonicalCandidates(authorities.map(({ value }) => value))
    const authorityConflict = conflictingStackIds(authorityCandidates)
    if (authorityConflict.size > 0) {
        return destructiveRefusal(
            'identity-conflict',
            authorityCandidates.filter((value) => authorityConflict.has(value.stackId)),
        )
    }
    const relevantStacks = new Set(authorityCandidates.map(({ stackId }) => stackId))
    const relevantInventoryConflicts = new Set(Array.from(conflictingStacks).filter((stackId) => relevantStacks.has(stackId)))
    if (relevantInventoryConflicts.size > 0) {
        return destructiveRefusal(
            'identity-conflict',
            inventory.filter((value) => relevantInventoryConflicts.has(value.stackId)),
        )
    }

    const relevant = authorities.filter(({ value }) => inventoryKeys.has(candidateKey(value)))
    const distinct = canonicalCandidates(relevant.map(({ value }) => value))
    if (distinct.length === 0) return destructiveRefusal('identity-mismatch', inventory)
    if (distinct.length > 1) return destructiveRefusal('ambiguous', distinct)

    const selected = relevant[0]!
    return Object.freeze({ kind: 'selected', source: selected.source, ...selected.value })
}

export function resolveInstance(input: ResolveInstanceInput): InstanceResolution {
    if (input === null || typeof input !== 'object') {
        throw new RefusalError('resolveInstance: input is malformed')
    }
    const served = candidate(input.served, 'served')
    const launcher = candidate(input.launcher, 'launcher')
    const explicit = input.explicit === undefined ? undefined : candidate(input.explicit, 'explicit')
    if (
        !Array.isArray(input.mountedSet)
        || input.mountedSet.some((value) => typeof value !== 'string' || !CHECKOUT_ID.test(value))
    ) {
        throw new RefusalError('resolveInstance: mountedSet contains a malformed checkout identity')
    }

    const mounted = new Set<CheckoutId>(input.mountedSet)
    const selected = explicit === undefined
        ? mounted.has(served.checkoutId)
            ? { source: 'served' as const, value: served }
            : { source: 'launcher' as const, value: launcher }
        : { source: 'explicit' as const, value: explicit }

    return Object.freeze({
        kind: mounted.has(selected.value.checkoutId) ? 'attach' : 'isolate',
        source: selected.source,
        stackId: selected.value.stackId,
        checkoutId: selected.value.checkoutId,
    })
}
