import { posix } from 'node:path'
import { snapshotJson, type JsonSnapshot } from '../environment/contract.js'

export const mechanism = {
    id: 'comparison-normalization',
    module: 'packages/cockpit/src/comparison/normalize.ts',
    exports: ['normalizeComparisonOutput'],
} as const

const OUTPUT_BYTE_LIMIT = 1_048_576
const RULE_LIMIT = 32
const allowedKinds = ['timestamp', 'absolute-path', 'port', 'duration-ms'] as const
type NormalizationKind = typeof allowedKinds[number]
type NormalizationRule = Readonly<{ kind: NormalizationKind; candidate: string }>

export type ComparisonNormalizationResult =
    | Readonly<{ kind: 'complete'; raw: string; normalized: string; applied: readonly NormalizationKind[] }>
    | Readonly<{ kind: 'refusal'; code: 'COMPARISON_OUTPUT_INVALID' | 'COMPARISON_NORMALIZATION_INVALID'; message: string }>

function record(value: JsonSnapshot | undefined): value is Readonly<Record<string, JsonSnapshot>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalCandidate(kind: NormalizationKind, candidate: string): boolean {
    switch (kind) {
        case 'timestamp': {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)) return false
            const parsed = new Date(candidate)
            return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === candidate
        }
        case 'absolute-path':
            return candidate.startsWith('/') && candidate !== '/' && !candidate.endsWith('/') && !candidate.includes('\\')
                && posix.normalize(candidate) === candidate && candidate.split('/').every((part, index) => index === 0 || part !== '' && part !== '.' && part !== '..')
        case 'port': {
            if (!/^[1-9]\d{0,4}$/.test(candidate)) return false
            const port = Number(candidate)
            return port >= 1_024 && port <= 65_535
        }
        case 'duration-ms':
            return /^(?:0|[1-9]\d*)(?:\.\d{1,3})?ms$/.test(candidate)
    }
}

function captureRules(input: unknown): readonly NormalizationRule[] | undefined {
    const captured = snapshotJson(input)
    if (!Array.isArray(captured) || captured.length > RULE_LIMIT) return undefined
    const rules: NormalizationRule[] = []
    for (const value of captured) {
        if (!record(value) || Object.keys(value).sort().join(',') !== 'candidate,kind'
            || typeof value.kind !== 'string' || !allowedKinds.includes(value.kind as NormalizationKind)
            || typeof value.candidate !== 'string' || Buffer.byteLength(value.candidate) > 1_024
            || !canonicalCandidate(value.kind as NormalizationKind, value.candidate)) return undefined
        rules.push(Object.freeze({ kind: value.kind as NormalizationKind, candidate: value.candidate }))
    }
    if (new Set(rules.map(rule => rule.candidate)).size !== rules.length) return undefined
    return Object.freeze(rules)
}

export function normalizeComparisonOutput(raw: unknown, inputRules: unknown): ComparisonNormalizationResult {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > OUTPUT_BYTE_LIMIT
        || /[\x00\uD800-\uDFFF]/u.test(raw)) {
        return Object.freeze({ kind: 'refusal', code: 'COMPARISON_OUTPUT_INVALID', message: 'comparison output must be bounded valid text' })
    }
    const rules = captureRules(inputRules)
    if (!rules) {
        return Object.freeze({ kind: 'refusal', code: 'COMPARISON_NORMALIZATION_INVALID', message: 'normalization rules must be bounded declared nondeterminism' })
    }
    let normalized = raw
    const applied: NormalizationKind[] = []
    for (const rule of rules) {
        if (!normalized.includes(rule.candidate)) continue
        normalized = normalized.split(rule.candidate).join(`<${rule.kind}>`)
        applied.push(rule.kind)
    }
    return Object.freeze({ kind: 'complete', raw, normalized, applied: Object.freeze(applied) })
}
