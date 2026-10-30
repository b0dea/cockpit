import { snapshotJson, type Diagnostic, type SetupRefusalEvidence } from './environment/contract.js'
import type { InvocationRecord } from './invocation.js'
import { admitDiagnosticFix, bindConfigPath, cockpitCommand, type FixContext } from './fix-catalogue.js'

export type { Diagnostic } from './environment/contract.js'

export const mechanism = {
    id: 'diagnostic-envelope',
    module: 'packages/cockpit/src/diagnostics.ts',
    exports: ['renderHumanDiagnostics', 'renderHumanValue', 'renderJsonResponse'],
} as const

const COMMON_REFUSAL_GUIDANCE: Readonly<Record<string, Readonly<{ why: string; fix: string }>>> = Object.freeze({
    INIT_CANONICAL_OWNERSHIP_MISSING: Object.freeze({
        why: 'init cannot safely resume when its recorded bootstrap state and generated ownership disagree',
        fix: 'restore the committed ownership metadata, then rerun the same npx --no cockpit init command',
    }),
    SURFACE_SOURCE_UNAVAILABLE: Object.freeze({
        why: 'generated instructions cannot be trusted without the declared sibling source',
        fix: `restore the named sibling checkout at its declared path, then rerun ${cockpitCommand('sync')}`,
    }),
    SURFACE_OWNERSHIP_INVALID: Object.freeze({
        why: 'cockpit cannot prove which generated settings it is allowed to replace',
        fix: `restore the last committed generated ownership metadata, then rerun ${cockpitCommand('sync')}`,
    }),
    SURFACE_STATE_CONFLICT: Object.freeze({
        why: 'sync would overwrite content that cockpit did not write',
        fix: `for a generated file you edited, move the change into cockpit.toml or a surface overlay, then undo the edit or delete the file and rerun ${cockpitCommand('sync')}; for the team's own .claude/settings.json, .codex/config.toml or .codex/hooks.json, have a human approve ${cockpitCommand('sync', { args: '--adopt <path>' })}`,
    }),
    GENERATED_ARTIFACT_DRIFT: Object.freeze({
        why: 'generated files no longer match the canonical cockpit configuration',
        fix: `run ${cockpitCommand('sync')}, then retry`,
    }),
    GENERATED_OWNERSHIP_INVALID: Object.freeze({
        why: 'publication cannot safely update files without authenticated ownership metadata',
        fix: `restore the committed ownership metadata and rerun ${cockpitCommand('sync')}`,
    }),
    GUARD_AUTHORITY_UNAVAILABLE: Object.freeze({
        why: 'the guard cannot make a safe allow or deny decision without current generated authority',
        fix: `restore cockpit.toml and the generated guard files, then have a human run ${cockpitCommand('sync')}`,
    }),
    GUARD_REFUSED: Object.freeze({
        why: 'the requested command is outside the current cockpit guard policy',
        fix: `follow the refusal reason or ask a human to change cockpit.toml and run ${cockpitCommand('sync')}`,
    }),
    RUNTIME_UNAVAILABLE: Object.freeze({
        why: 'cockpit cannot start or inspect the declared environment without a reachable container runtime',
        fix: 'start the configured container runtime and verify docker info succeeds, then retry',
    }),
    RUNTIME_UNMEASURED: Object.freeze({
        why: 'the current runtime has no measured support row, so its timing and capability bounds are unknown',
        fix: `run ${cockpitCommand('runtime measure', { args: '--image <ref> --write' })}, review the change, then retry`,
    }),
    CLAIM_CO_TENANT: Object.freeze({
        why: 'another holder still owns or is using the same stack',
        fix: `for a failed up attempt, run ${cockpitCommand('up')} to resume or ${cockpitCommand('down')} to release; otherwise have every owning session run ${cockpitCommand('sleep')}, then retry`,
    }),
    PORT_FAMILY_COLLISION: Object.freeze({
        why: 'one or more ports selected for this stack are already in use',
        fix: 'stop the named listener or release the inactive stack, then retry',
    }),
    PORT_LEASE_EXHAUSTED: Object.freeze({
        why: 'every declared port family is leased or occupied',
        fix: 'release an inactive stack or extend ports.count after checking host capacity',
    }),
    SETUP_MANUAL_MISSING: Object.freeze({
        why: 'a manually managed sibling must already exist before cockpit can wire it',
        fix: `create the named checkout at its declared path, then run ${cockpitCommand('setup')} again`,
    }),
    SETUP_REMOTE_MISMATCH: Object.freeze({
        why: 'rewiring an existing checkout to a different repository could replace the wrong source',
        fix: `correct the checkout remote or the sibling declaration, then run ${cockpitCommand('setup')} again`,
    }),
})

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

function humanLines(value: import('./environment/contract.js').JsonSnapshot, depth: number): string[] {
    const indent = '  '.repeat(depth)
    if (value === null) return [`${indent}none`]
    if (typeof value === 'string') return [`${indent}${escapeForTerminal(value)}`]
    if (typeof value === 'boolean' || typeof value === 'number') return [`${indent}${String(value)}`]
    if (Array.isArray(value)) {
        if (value.length === 0) return [`${indent}(none)`]
        return value.flatMap((item) => {
            if (item === null || typeof item !== 'object') {
                const [line] = humanLines(item, 0)
                return [`${indent}- ${line}`]
            }
            return [`${indent}-`, ...humanLines(item, depth + 1)]
        })
    }
    const entries = Object.entries(value)
    if (entries.length === 0) return [`${indent}(none)`]
    return entries.flatMap(([key, item]) => {
        const label = `${indent}${escapeForTerminal(key)}:`
        if (item === null || typeof item !== 'object') {
            const [line] = humanLines(item, 0)
            return [`${label} ${line}`]
        }
        return [label, ...humanLines(item, depth + 1)]
    })
}

export function renderHumanValue(value: unknown): string {
    const captured = snapshotJson(value)
    return captured === undefined ? 'Result is not available as bounded human-readable text.\n'
        : `${humanLines(captured, 0).join('\n')}\n`
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
        const { severity, code, target, fix } = source
        const admitted = admitDiagnosticFix(source, context)
        const identity = { code, ...(target === undefined ? {} : { target }) }
        const message = bindConfigPath(source.message, context)
        const diagnostic = { severity, ...identity, message, ...(admitted ? { fix: admitted.command } : {}) }
        diagnostics.set(JSON.stringify(diagnostic), diagnostic)
        if (fix !== undefined && !admitted) {
            const row = { ...identity, text: bindConfigPath(fix, context) }
            guidance.set(JSON.stringify(row), row)
        } else if (fix === undefined && Object.prototype.hasOwnProperty.call(COMMON_REFUSAL_GUIDANCE, code)) {
            const row = { ...identity, text: bindConfigPath(COMMON_REFUSAL_GUIDANCE[code]!.fix, context) }
            guidance.set(JSON.stringify(row), row)
        }
    }
    return { diagnostics: [...diagnostics.values()], guidance: [...guidance.values()] }
}

// What each lifecycle `change` means to the person who ran the command; `--json` keeps the raw value.
const LIFECYCLE_CHANGES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
    up: Object.freeze({ started: 'Stack started', resumed: 'Stack resumed', unchanged: 'Stack already running' }),
    sleep: Object.freeze({
        stopped: 'Stack stopped',
        retained: "Released this checkout's hold; another holder keeps the stack running",
        unchanged: 'Nothing to stop: no session holds the stack',
    }),
    down: Object.freeze({ removed: 'Stack removed' }),
})

// A successful up, sleep, down or preflight printed nothing in human mode, so a person could not
// tell success from a command that never ran. One line says what happened; anything outside the
// known result shape prints nothing rather than a guess.
function lifecycleSummary(command: string, result: Readonly<Record<string, unknown>>): string {
    if (command === 'preflight') {
        if (typeof result.verdict !== 'string' || !Array.isArray(result.checks)) return ''
        const counts = new Map<string, number>()
        for (const check of result.checks as readonly { verdict?: unknown }[]) {
            const verdict = String(check?.verdict).replaceAll('-', ' ')
            counts.set(verdict, (counts.get(verdict) ?? 0) + 1)
        }
        const tally = [...counts].map(([verdict, count]) => `${count} ${verdict === 'pass' ? count === 1 ? 'check passes' : 'checks pass' : verdict}`)
        return escapeForTerminal(`Preflight ${result.verdict === 'pass' ? 'passed' : result.verdict}: ${tally.join(', ') || 'no checks'}.`) + '\n'
    }
    const headline = Object.hasOwn(LIFECYCLE_CHANGES, command) && typeof result.change === 'string'
        && Object.hasOwn(LIFECYCLE_CHANGES[command]!, result.change) ? LIFECYCLE_CHANGES[command]![result.change] : undefined
    if (headline === undefined || typeof result.stackId !== 'string') return ''
    const cold = result.coldStart as Readonly<{ measuredMillis?: unknown; limitMillis?: unknown }> | undefined
    const timing = typeof cold?.measuredMillis === 'number' && typeof cold.limitMillis === 'number'
        ? `; cold start ${(cold.measuredMillis / 1000).toFixed(1)}s of the ${Math.round(cold.limitMillis / 1000)}s limit` : ''
    const entrypoints = Array.isArray(result.entrypoints) ? (result.entrypoints as readonly { name?: unknown; value?: unknown }[])
        .filter(({ name, value }) => typeof name === 'string' && typeof value === 'string')
        .map(({ name, value }) => `  ${escapeForTerminal(String(name))}: ${escapeForTerminal(String(value))}\n`) : []
    return `${escapeForTerminal(`${headline} (${result.stackId})${timing}.`)}\n${entrypoints.join('')}`
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
            return renderHumanValue(outcome.result)
        }
        return command === undefined ? '' : lifecycleSummary(command, outcome.result as Readonly<Record<string, unknown>>)
    }
    if (diagnostics.length === 0) return ''
    const projected = projectDiagnostics(diagnostics, fixContext)
    const hint = usageHint !== undefined && diagnostics.some(({ code }) => USAGE_ERROR_CODE.test(code)) ? usageHint : ''
    return `${projected.diagnostics
        .map((diagnostic) => {
            const target = diagnostic.target ? ` [${escapeForTerminal(diagnostic.target)}]` : ''
            const guidance = projected.guidance.filter(row => row.code === diagnostic.code && row.target === diagnostic.target)
            const common = Object.prototype.hasOwnProperty.call(COMMON_REFUSAL_GUIDANCE, diagnostic.code)
                ? COMMON_REFUSAL_GUIDANCE[diagnostic.code]
                : undefined
            if (common) {
                const fix = diagnostic.fix ?? guidance[0]?.text ?? bindConfigPath(common.fix, fixContext)
                return `${diagnostic.severity.toUpperCase()} ${escapeForTerminal(diagnostic.code)}${target}\n`
                    + `What failed: ${escapeForTerminal(diagnostic.message)}\n`
                    + `Why it matters: ${escapeForTerminal(common.why)}\n`
                    + `Fix: ${escapeForTerminal(fix)}`
            }
            const fix = diagnostic.fix ? ` Fix: ${escapeForTerminal(diagnostic.fix)}` : ''
            const renderedGuidance = guidance.map(row => ` Guidance: ${escapeForTerminal(row.text)}`).join('')
            return `${diagnostic.severity.toUpperCase()} ${escapeForTerminal(diagnostic.code)}${target}: ${escapeForTerminal(diagnostic.message)}${fix}${renderedGuidance}`
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
