export const ENTRYPOINT_KINDS = Object.freeze([
    'entrypoint',
    'origin',
    'callback_url',
    'advertised_listener',
    'cors_origin',
    'public_base_url',
] as const)

export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]

export function isEntrypointKind(value: unknown): value is EntrypointKind {
    return typeof value === 'string' && (ENTRYPOINT_KINDS as readonly string[]).includes(value)
}
