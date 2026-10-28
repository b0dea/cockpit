import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import type { CheckoutId, CockpitId, HolderId, StackId } from './contract.js'

export const mechanism = {
    id: 'environment-identity',
    module: 'packages/cockpit/src/environment/identity.ts',
    exports: ['cockpitId', 'publicationCockpitId', 'checkoutId', 'stackId', 'holderId', 'bootstrapHolderId'],
} as const

declare const bootstrapLockOwnerBrand: unique symbol
export type BootstrapLockOwnerId = string & { readonly [bootstrapLockOwnerBrand]: 'BootstrapLockOwnerId' }

export type StackVariant =
    | { readonly kind: 'shared' }
    | { readonly kind: 'named'; readonly name: string }

export interface CanonicalMainCheckoutEvidence {
    readonly mainCheckoutPath: string
}

export interface CanonicalCheckoutEvidence {
    readonly checkoutPath: string
}

const COCKPIT_NAME = /^[a-z0-9][a-z0-9-]*$/
const STACK_NAME = /^[a-z0-9][a-z0-9-]*$/
const COCKPIT_ID = /^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/
const CHECKOUT_ID = /^checkout:[a-f0-9]{64}$/
const STACK_ID = /^stack:[a-f0-9]{64}$/

function digest(parts: readonly string[]): string {
    const hash = createHash('sha256')
    for (const part of parts) {
        hash.update(String(Buffer.byteLength(part, 'utf8')))
        hash.update(':')
        hash.update(part)
    }
    return hash.digest('hex')
}

function canonicalPath(value: string, field: string): string {
    if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value) || normalize(value) !== value) {
        throw new TypeError(`identity: ${field} must be a canonical absolute path`)
    }
    return value
}

function closedIdentity(value: string, pattern: RegExp, field: string): string {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new TypeError(`identity: ${field} is malformed`)
    }
    return value
}

export function cockpitId(input: { readonly name: string } & CanonicalMainCheckoutEvidence): CockpitId {
    if (typeof input?.name !== 'string' || !COCKPIT_NAME.test(input.name)) {
        throw new TypeError('identity: cockpit name must use lowercase letters, digits, and hyphens')
    }
    const mainCheckoutPath = canonicalPath(input.mainCheckoutPath, 'mainCheckoutPath')
    return `cockpit:${input.name}:${digest([mainCheckoutPath])}` as CockpitId
}

export function publicationCockpitId(input: { readonly name: string }): CockpitId {
    if (typeof input?.name !== 'string' || !COCKPIT_NAME.test(input.name)) {
        throw new TypeError('identity: cockpit name must use lowercase letters, digits, and hyphens')
    }
    return `cockpit:${input.name}:${digest(['publication', input.name])}` as CockpitId
}

export function checkoutId(input: CanonicalCheckoutEvidence): CheckoutId {
    const checkoutPath = canonicalPath(input?.checkoutPath, 'checkoutPath')
    return `checkout:${digest([checkoutPath])}` as CheckoutId
}

export function stackId(input: {
    readonly cockpitId: CockpitId
    readonly checkoutId: CheckoutId
    readonly variant: StackVariant
}): StackId {
    const cockpit = closedIdentity(input?.cockpitId, COCKPIT_ID, 'cockpitId')
    const checkout = closedIdentity(input?.checkoutId, CHECKOUT_ID, 'checkoutId')
    const variant = input?.variant
    if (variant?.kind === 'shared') {
        return `stack:${digest([cockpit, checkout, 'shared'])}` as StackId
    }
    if (variant?.kind === 'named' && STACK_NAME.test(variant.name)) {
        return `stack:${digest([cockpit, checkout, 'named', variant.name])}` as StackId
    }
    throw new TypeError('identity: stack variant is malformed')
}

export function holderId(input: {
    readonly stackId: StackId
    readonly checkoutId: CheckoutId
    readonly sessionId: string
}): HolderId {
    const stack = closedIdentity(input?.stackId, STACK_ID, 'stackId')
    const checkout = closedIdentity(input?.checkoutId, CHECKOUT_ID, 'checkoutId')
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || input.sessionId.includes('\0')) {
        throw new TypeError('identity: sessionId must be a non-empty string without NUL bytes')
    }
    return `holder:${digest([stack, checkout, 'session', input.sessionId])}:session` as HolderId
}

export function bootstrapHolderId(input: {
    readonly checkoutId: CheckoutId
    readonly sessionId: string
}): BootstrapLockOwnerId {
    const checkout = closedIdentity(input?.checkoutId, CHECKOUT_ID, 'checkoutId')
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || input.sessionId.includes('\0')) {
        throw new TypeError('identity: sessionId must be a non-empty string without NUL bytes')
    }
    return `bootstrap-holder:${digest([checkout, 'session', input.sessionId])}:session` as BootstrapLockOwnerId
}
