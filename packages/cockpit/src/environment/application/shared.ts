import { isAbsolute, relative, sep } from 'node:path'
import { type EnvironmentCommandOutcome, type EnvironmentDiagnostic, type SourceProvenance, forwardedRefusal, snapshotJson } from '../contract.js'

export function exactEnvironment(input: unknown): Readonly<Record<string, string>> | undefined {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || Object.entries(snapshot).some(([name, value]) => name.length === 0 || name.includes('\0')
            || name.includes('=') || typeof value !== 'string' || value.includes('\0'))) return undefined
    return { ...snapshot } as Readonly<Record<string, string>>
}

export function uniqueDiagnostics(diagnostics: readonly EnvironmentDiagnostic[]): readonly EnvironmentDiagnostic[] {
    const seen = new Set<string>()
    return diagnostics.filter((diagnostic) => {
        const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.target, diagnostic.fix])
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

export function sameSource(left: SourceProvenance, right: SourceProvenance): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

export function ownerDiagnostic(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
    fix?: string,
): EnvironmentDiagnostic {
    return { severity: 'error', code, message, target, ...(fix ? { fix } : {}) }
}

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function confinedPath(root: string, candidate: string): boolean {
    const relation = relative(root, candidate)
    return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

export function ownDataValues(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const actual = Reflect.ownKeys(descriptors)
        if (actual.some((key) => typeof key !== 'string')
            || required.some((key) => !descriptors[key])
            || actual.some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) {
            return undefined
        }
        const captured: Record<string, unknown> = {}
        for (const key of actual as string[]) {
            const descriptor = descriptors[key]
            if (!descriptor || !('value' in descriptor)) return undefined
            captured[key] = descriptor.value
        }
        return captured
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

export function lifecycleRefusal(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
    fix?: string,
): Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }> {
    return forwardedRefusal([ownerDiagnostic(code, message, target, fix)])
}
