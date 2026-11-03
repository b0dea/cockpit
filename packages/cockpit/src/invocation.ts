import { isAbsolute, normalize } from 'node:path'

export const EXIT_CODES = Object.freeze({ success: 0, failure: 2, cancelled: 130 } as const)
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]

export interface InvocationRecord {
    readonly verb: string
    readonly durationMs: number
    readonly exitCode: ExitCode
    readonly resolvedConfigPath: string | null
}

export function createInvocationRecord(input: InvocationRecord): InvocationRecord {
    const { verb, durationMs, exitCode, resolvedConfigPath } = input
    if (typeof verb !== 'string' || !/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(verb)) {
        throw new Error('Invocation verb must be non-empty command words without control characters')
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
        throw new Error('Invocation durationMs must be a non-negative finite safe integer')
    }
    if (!Object.values(EXIT_CODES).includes(exitCode)) {
        throw new Error('Invocation exitCode must be success (0), failure (2), or cancellation (130)')
    }
    if (resolvedConfigPath !== null && (typeof resolvedConfigPath !== 'string'
        || !isAbsolute(resolvedConfigPath) || normalize(resolvedConfigPath) !== resolvedConfigPath
        || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(resolvedConfigPath))) {
        throw new Error('Invocation resolvedConfigPath must be null or a normalized absolute path without control characters')
    }
    return Object.freeze({ verb, durationMs, exitCode, resolvedConfigPath })
}
