import type { Diagnostic, SetupRefusalEvidence } from './environment/contract.js'
import type { InvocationRecord } from './invocation.js'
import { admitDiagnosticFix, type FixContext } from './fix-catalogue.js'

export type { Diagnostic } from './environment/contract.js'

export const mechanism = {
    id: 'diagnostic-envelope',
    module: 'packages/cockpit/src/diagnostics.ts',
    exports: ['renderHumanDiagnostics', 'renderJsonResponse'],
} as const

interface HumanReviewOutcome {
    readonly status: number
    readonly result: unknown
}

interface HumanReviewContext {
    readonly command: string | undefined
    readonly outcome: HumanReviewOutcome
}

// Command-line mistakes (as opposed to failed work) get a pointer to the relevant --help.
const USAGE_ERROR_CODE = /^CLI_(?:USAGE_INVALID|UNKNOWN_COMMAND|COMMAND_REQUIRED)$|_(?:DUPLICATE|UNSUPPORTED)$/

function escapeForTerminal(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (character) => {
        if (/[\u0080-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(character)) {
            return `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
        }
        const escaped = JSON.stringify(character)
        return escaped.slice(1, -1)
    })
}

function terminalSafeJson(value: unknown, space?: number): string {
    // JSON already escapes C0; the remaining terminal controls must retain their JSON value.
    return JSON.stringify(value, null, space).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
}

interface Guidance {
    readonly code: string
    readonly target?: string
    readonly text: string
}

function projectDiagnostics(input: readonly Diagnostic[], context?: FixContext): {
    diagnostics: readonly Diagnostic[]
    guidance: readonly Guidance[]
} {
    const diagnostics = new Map<string, Diagnostic>()
    const guidance = new Map<string, Guidance>()
    for (const source of input) {
        const { severity, code, message, target, fix } = source
        const admitted = admitDiagnosticFix(source, context)
        const identity = { code, ...(target === undefined ? {} : { target }) }
        const diagnostic = { severity, ...identity, message, ...(admitted ? { fix: admitted.command } : {}) }
        diagnostics.set(JSON.stringify(diagnostic), diagnostic)
        if (fix !== undefined && !admitted) {
            const row = { ...identity, text: fix }
            guidance.set(JSON.stringify(row), row)
        }
    }
    return { diagnostics: [...diagnostics.values()], guidance: [...guidance.values()] }
}

export function renderHumanDiagnostics(
    diagnostics: readonly Diagnostic[],
    review?: HumanReviewContext,
    fixContext?: FixContext,
    usageHint?: string,
): string {
    if (review) {
        const { command, outcome } = review
        if (outcome.status !== 0 || outcome.result === null || typeof outcome.result !== 'object') return ''
        if (command === 'sync' && 'dryRun' in outcome.result && outcome.result.dryRun === true
            && 'changes' in outcome.result && Array.isArray(outcome.result.changes)) {
            const changes = outcome.result.changes as readonly { operation: unknown; path: unknown }[]
            if (!changes.every((change) => change && (change.operation === 'write' || change.operation === 'remove')
                && typeof change.path === 'string')) return ''
            return changes.length === 0 ? 'No generated changes.\n'
                : `${changes.map((change) => `${change.operation} ${terminalSafeJson(change.path)}`).join('\n')}\n`
        }
        if (command === 'logs' && 'records' in outcome.result && Array.isArray(outcome.result.records)) {
            const records = outcome.result.records as readonly { timestamp: unknown; stream: unknown; message: unknown }[]
            return records.length === 0 ? 'No log records.\n'
                : `${records.map(record => escapeForTerminal(`${String(record.timestamp)} ${String(record.stream)} ${String(record.message)}`)).join('\n')}\n`
        }
        if (command === 'selftest' || command === 'upgrade' || command === 'doctor' || command === 'init') {
            return `${terminalSafeJson(outcome.result, 2)}\n`
        }
        return ''
    }
    if (diagnostics.length === 0) return ''
    const projected = projectDiagnostics(diagnostics, fixContext)
    const hint = usageHint !== undefined && diagnostics.some(({ code }) => USAGE_ERROR_CODE.test(code)) ? usageHint : ''
    return `${projected.diagnostics
        .map((diagnostic) => {
            const target = diagnostic.target ? ` [${escapeForTerminal(diagnostic.target)}]` : ''
            const fix = diagnostic.fix ? ` Fix: ${escapeForTerminal(diagnostic.fix)}` : ''
            const guidance = projected.guidance.filter(row => row.code === diagnostic.code && row.target === diagnostic.target)
                .map(row => ` Guidance: ${escapeForTerminal(row.text)}`).join('')
            return `${diagnostic.severity.toUpperCase()} ${escapeForTerminal(diagnostic.code)}${target}: ${escapeForTerminal(diagnostic.message)}${fix}${guidance}`
        })
        .join('\n')}\n${hint}`
}

export function renderJsonResponse(outcome: {
    result: unknown
    diagnostics: readonly Diagnostic[]
    evidence?: SetupRefusalEvidence
    invocation?: InvocationRecord
    progress?: Readonly<{ applied: readonly string[]; notApplied: readonly string[]; attempted?: readonly string[] }>
}, fixContext?: FixContext): string {
    const { result, diagnostics, evidence, progress, invocation } = outcome
    const projected = projectDiagnostics(diagnostics, fixContext)
    return `${terminalSafeJson({ result, diagnostics: projected.diagnostics,
        ...(projected.guidance.length === 0 ? {} : { guidance: projected.guidance }), ...(evidence === undefined ? {} : { evidence }),
        ...(progress === undefined ? {} : { progress }), ...(invocation === undefined ? {} : { invocation }) })}\n`
}
