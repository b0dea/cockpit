import { describe, expect, it } from 'vitest'
import type { CheckoutId, StackId } from './contract.js'
import { checkoutId, cockpitId, stackId } from './identity.js'
import {
    resolveInstance,
    selectDestructiveInstance,
    type InstanceCandidate,
} from './instance.js'

const cockpit = cockpitId({ name: 'sample-cockpit', mainCheckoutPath: '/srv/cockpit' })
const checkout = checkoutId({ checkoutPath: '/srv/cockpit' })
const otherCheckout = checkoutId({ checkoutPath: '/srv/other' })

const shared: InstanceCandidate = {
    stackId: stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } }),
    checkoutId: checkout,
}
const firstIsolated: InstanceCandidate = {
    stackId: stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'named', name: 'first' } }),
    checkoutId: checkout,
}
const secondIsolated: InstanceCandidate = {
    stackId: stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'named', name: 'second' } }),
    checkoutId: checkout,
}

function permutations<T>(values: readonly T[]): T[][] {
    if (values.length < 2) return [Array.from(values)]
    return values.flatMap((value, index) =>
        permutations(values.filter((_, candidateIndex) => candidateIndex !== index))
            .map((tail) => [value, ...tail]),
    )
}

describe('destructive instance selection', () => {
    it('preserves an explicit identity across every shared and isolated claim order', () => {
        for (const claimInventory of permutations([shared, firstIsolated, secondIsolated])) {
            expect(selectDestructiveInstance({
                explicit: firstIsolated,
                served: shared,
                launcher: secondIsolated,
                claimInventory: [...claimInventory, claimInventory[0]],
            })).toEqual({ kind: 'selected', source: 'explicit', ...firstIsolated })
        }
    })

    it('preserves an unambiguous served or launcher identity without using claim order', () => {
        expect(selectDestructiveInstance({
            served: shared,
            launcher: secondIsolated,
            claimInventory: [secondIsolated, shared, secondIsolated],
        })).toEqual({
            kind: 'refusal',
            reason: 'ambiguous',
            candidates: [shared, secondIsolated].sort((left, right) => left.stackId.localeCompare(right.stackId)),
        })
        expect(selectDestructiveInstance({
            served: shared,
            launcher: secondIsolated,
            claimInventory: [firstIsolated, shared, firstIsolated],
        })).toEqual({ kind: 'selected', source: 'served', ...shared })
        expect(selectDestructiveInstance({
            served: shared,
            launcher: secondIsolated,
            claimInventory: [firstIsolated, secondIsolated, firstIsolated],
        })).toEqual({ kind: 'selected', source: 'launcher', ...secondIsolated })
        expect(selectDestructiveInstance({
            served: shared,
            launcher: shared,
            claimInventory: [secondIsolated, shared, firstIsolated],
        })).toEqual({ kind: 'selected', source: 'served', ...shared })
    })

    it('selects the canonical launcher identity when served evidence is absent', () => {
        for (const claimInventory of permutations([shared, firstIsolated, secondIsolated])) {
            expect(selectDestructiveInstance({ launcher: shared, claimInventory }))
                .toEqual({ kind: 'selected', source: 'launcher', ...shared })
        }
    })

    it('returns the same stable ambiguity for permutations and duplicate claims', () => {
        const expected = selectDestructiveInstance({
            served: shared,
            launcher: secondIsolated,
            claimInventory: [shared, secondIsolated],
        })

        for (const claimInventory of permutations([shared, firstIsolated, secondIsolated])) {
            expect(selectDestructiveInstance({
                served: shared,
                launcher: secondIsolated,
                claimInventory: [...claimInventory, shared, secondIsolated],
            })).toEqual(expected)
        }
    })

    it('does not turn structural inventory into target authority', () => {
        for (const claimInventory of [[firstIsolated], [firstIsolated, shared, secondIsolated]]) {
            expect(selectDestructiveInstance({ claimInventory })).toEqual({
                kind: 'refusal',
                reason: 'missing-authority',
                candidates: [...claimInventory].sort((left, right) => left.stackId.localeCompare(right.stackId)),
            })
        }
    })

    it('refuses an explicit identity missing from the fresh inventory instead of falling back', () => {
        expect(selectDestructiveInstance({
            explicit: firstIsolated,
            served: shared,
            launcher: secondIsolated,
            claimInventory: [shared, secondIsolated],
        })).toEqual({
            kind: 'refusal',
            reason: 'identity-mismatch',
            candidates: [shared, secondIsolated].sort((left, right) => left.stackId.localeCompare(right.stackId)),
        })
        expect(selectDestructiveInstance({
            explicit: firstIsolated,
            claimInventory: [firstIsolated],
        })).toEqual({ kind: 'selected', source: 'explicit', ...firstIsolated })
    })

    it('refuses one stack identity associated with conflicting checkouts', () => {
        const conflicting = { stackId: shared.stackId, checkoutId: otherCheckout }

        expect(selectDestructiveInstance({
            explicit: shared,
            claimInventory: [shared, conflicting],
        })).toEqual({
            kind: 'refusal',
            reason: 'identity-conflict',
            candidates: [shared, conflicting]
                .sort((left, right) => left.checkoutId.localeCompare(right.checkoutId)),
        })
    })

    it('ignores identity conflicts that do not involve the authenticated explicit target', () => {
        const unrelatedConflict = { stackId: shared.stackId, checkoutId: otherCheckout }

        expect(selectDestructiveInstance({
            explicit: firstIsolated,
            served: shared,
            launcher: secondIsolated,
            claimInventory: [shared, unrelatedConflict, firstIsolated, secondIsolated],
        })).toEqual({ kind: 'selected', source: 'explicit', ...firstIsolated })
    })

    it('refuses contradictory served and launcher identities for the same stack', () => {
        const conflictingLauncher = { stackId: shared.stackId, checkoutId: otherCheckout }

        expect(selectDestructiveInstance({
            served: shared,
            launcher: conflictingLauncher,
            claimInventory: [shared],
        })).toEqual({
            kind: 'refusal',
            reason: 'identity-conflict',
            candidates: [shared, conflictingLauncher]
                .sort((left, right) => left.checkoutId.localeCompare(right.checkoutId)),
        })
    })

    it('refuses malformed authority and inventory values', () => {
        expect(() => selectDestructiveInstance(null as never)).toThrow('input')
        expect(() => selectDestructiveInstance({
            explicit: { stackId: 'stack:bad' as StackId, checkoutId: checkout },
            claimInventory: [],
        })).toThrow('selectDestructiveInstance: explicit')
        expect(() => selectDestructiveInstance({
            claimInventory: [{ stackId: shared.stackId, checkoutId: 'checkout:bad' as CheckoutId }],
        })).toThrow('selectDestructiveInstance: claimInventory')
    })

    it('snapshots destructive identities once before deciding', () => {
        let stackReads = 0
        let checkoutReads = 0
        const oneReadCandidate = {
            get stackId() {
                stackReads += 1
                if (stackReads > 1) throw new Error('stackId read twice')
                return shared.stackId
            },
            get checkoutId() {
                checkoutReads += 1
                if (checkoutReads > 1) throw new Error('checkoutId read twice')
                return shared.checkoutId
            },
        }

        expect(selectDestructiveInstance({
            explicit: oneReadCandidate,
            claimInventory: [shared],
        })).toEqual({ kind: 'selected', source: 'explicit', ...shared })
        expect({ stackReads, checkoutReads }).toEqual({ stackReads: 1, checkoutReads: 1 })
    })

    it('leaves ordinary attach-or-isolate resolution unchanged', () => {
        expect(resolveInstance({
            explicit: firstIsolated,
            served: shared,
            launcher: secondIsolated,
            mountedSet: [shared.checkoutId, secondIsolated.checkoutId],
        })).toEqual({ kind: 'attach', source: 'explicit', ...firstIsolated })
        expect(resolveInstance({
            served: shared,
            launcher: secondIsolated,
            mountedSet: [],
        })).toEqual({ kind: 'isolate', source: 'launcher', ...secondIsolated })
    })
})
