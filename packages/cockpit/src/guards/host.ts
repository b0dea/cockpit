export const GUARD_HOST_LIMITS = Object.freeze({ hostnameBytes: 253, labelBytes: 63, rows: 128 })

const label = `[a-z0-9](?:[a-z0-9-]{0,${GUARD_HOST_LIMITS.labelBytes - 2}}[a-z0-9])?`
// ASCII makes these character bounds identical to UTF-8 byte bounds, including in editor schemas.
export const GUARD_HOST_PATTERN = new RegExp(`^(?:\\*\\.)?(?=[a-z0-9.-]{1,${GUARD_HOST_LIMITS.hostnameBytes}}(?![\\s\\S]))${label}(?:\\.${label})*(?![\\s\\S])`)

export function isGuardHost(value: unknown): value is string {
    return typeof value === 'string' && GUARD_HOST_PATTERN.test(value)
}

export function normalizeGuardHost(value: string): string {
    return value.startsWith('*.') ? value.slice(2) : value
}
