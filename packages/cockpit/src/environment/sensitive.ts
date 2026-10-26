export const mechanism = {
    id: 'environment-sensitive-data',
    module: 'packages/cockpit/src/environment/sensitive.ts',
    exports: ['isSensitiveField', 'redactSensitiveText', 'redactSensitiveMessage'],
} as const

const SENSITIVE_FIELD = /(?:authorization|password|passwd|token|secret|credential|private[_-]?key|api[_-]?key)/i
const SENSITIVE_ASSIGNMENT = /((?:authorization|password|passwd|token|secret|credential|private[_-]?key|api[_-]?key)[a-z0-9_-]*[\\"']*\s*[=:]\s*(?:bearer\s+)?)[^\r\n]*/ig

export function isSensitiveField(name: string): boolean {
    return SENSITIVE_FIELD.test(name)
}

export function redactSensitiveText(value: string): string {
    return value.replace(SENSITIVE_ASSIGNMENT, '$1[redacted]')
}

function redactStructured(value: unknown, key = '', depth = 0): unknown {
    if (depth > 64) throw new TypeError('structured diagnostic exceeds the nesting limit')
    if (isSensitiveField(key)) return '[redacted]'
    if (Array.isArray(value)) return value.map(item => redactStructured(item, '', depth + 1))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([name, child]) => [name, redactStructured(child, name, depth + 1)]))
    return typeof value === 'string' ? redactSensitiveText(value) : value
}

export function redactSensitiveMessage(message: string): string | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(message) }
    catch {
        if (/[\r\n]/.test(message)) {
            const lines = message.split(/(\r?\n|\r)/).map((line, index) => index % 2 ? line : redactSensitiveMessage(line))
            return lines.some(line => line === undefined) ? undefined : lines.join('')
        }
        // A partial sensitive object cannot be redacted safely one header at a time.
        for (const match of message.matchAll(SENSITIVE_ASSIGNMENT)) {
            const value = match[0].slice(match[1]!.length).trimStart()
            if (!value || value.startsWith('{') || value.startsWith('[')) return undefined
        }
        return redactSensitiveText(message)
    }
    if (typeof parsed === 'string') return redactSensitiveText(parsed)
    try { return JSON.stringify(redactStructured(parsed)) }
    catch { return undefined }
}
