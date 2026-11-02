import { posix } from 'node:path'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_SURFACE_TARGETS, type GuardSurfaceTarget } from '../surfaces/harness-registry.js'
import type { GuardDecision } from './evaluator.js'
import { GUARD_INPUT_LIMITS } from './invocation-parser.js'

export const mechanism = {
    id: 'guard-harness-adapter', module: 'packages/cockpit/src/guards/harness-adapter.ts',
    exports: ['adaptGuardDecision', 'normalizeOpenCodeInput', 'planGuardTransport', 'completeGuardTransport', 'GUARD_HANDLER_ARGV'],
} as const

export const GUARD_HANDLER_ARGV = Object.freeze(['guard-evaluate'] as const)
export interface NativeGuardOutput {
    readonly target: GuardSurfaceTarget | null
    readonly capability: 'instructed'
    readonly decision: GuardDecision['decision']
    readonly exitCode: 0 | 2
    readonly stdout: string
    readonly stderr: string
}
export interface GuardTransportPlan {
    readonly kind: 'complete'
    readonly target: GuardSurfaceTarget
    readonly executable: string
    readonly cwd: string
    readonly argv: readonly ['guard-evaluate', '--harness', GuardSurfaceTarget]
    readonly stdin: string
    readonly timeoutMs: 20000
    readonly stdoutBytes: 65536
    readonly stderrBytes: 65536
}
export interface GuardTransportRefusal { readonly kind: 'refusal'; readonly code: 'GUARD_TRANSPORT_INVALID'; readonly message: string }
const plans = new WeakSet<object>()
function target(value: unknown): value is GuardSurfaceTarget { return typeof value === 'string' && GUARD_SURFACE_TARGETS.some((item) => item === value) }
function record(value: JsonSnapshot | undefined): value is JsonSnapshotObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: JsonSnapshotObject, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)) }
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && Buffer.byteLength(value) <= limit && !/[\uD800-\uDFFF]/u.test(value) }
function absolute(value: unknown): value is string {
    return text(value, GUARD_INPUT_LIMITS.pathBytes) && value.startsWith('/') && value !== '/' && !value.endsWith('/')
        && posix.normalize(value) === value && !/[\x00-\x1f\x7f\\]/.test(value)
}
function decision(value: unknown): GuardDecision | undefined {
    const captured = snapshotJson(value)
    if (!record(captured) || !keys(captured, ['decision', 'reason']) || !['allow', 'ask', 'deny', 'unavailable'].includes(String(captured.decision))
        || !text(captured.reason, 4096) || !captured.reason.trim() || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(captured.reason)) return undefined
    return captured as unknown as GuardDecision
}

/** Native spelling cannot add grants or change the evaluator's hard boundaries. */
export function adaptGuardDecision(harness: unknown, input: unknown): NativeGuardOutput {
    const resolved = decision(input)
    const native = target(harness) ? harness : null
    const selected = resolved && native ? resolved : { decision: 'unavailable' as const, reason: 'Guard adapter received an invalid harness or closed decision.' }
    const verdict = selected.decision === 'ask' && native !== 'claudecode' ? 'deny' : selected.decision
    let stdout = ''
    let stderr = ''
    let exitCode: 0 | 2 = 0
    if (verdict === 'unavailable' || native === 'opencode' && verdict !== 'allow') {
        exitCode = 2
        stderr = `cockpit guard: ${selected.reason}\n`
    } else if (verdict !== 'allow') {
        stdout = JSON.stringify({ hookSpecificOutput: {
            hookEventName: 'PreToolUse', permissionDecision: verdict, permissionDecisionReason: selected.reason,
        } }) + '\n'
    }
    return Object.freeze({ target: native, capability: 'instructed', decision: verdict, exitCode, stdout, stderr })
}

/** Only measured field-name normalization; shell and patch grammar belong to the parser. */
export function normalizeOpenCodeInput(input: unknown): JsonSnapshotObject | undefined {
    const value = snapshotJson(input)
    if (!record(value) || !keys(value, ['tool', 'args', 'cwd']) || typeof value.tool !== 'string' || !record(value.args) || !absolute(value.cwd)) return undefined
    const tools: Record<string, string> = { bash: 'Bash', edit: 'Edit', write: 'Write', apply_patch: 'apply_patch' }
    const tool = Object.hasOwn(tools, value.tool) ? tools[value.tool] : undefined
    if (!tool) return undefined
    const field = tool === 'Bash' ? value.args.command : tool === 'apply_patch' ? value.args.patchText : value.args.filePath ?? value.args.path ?? value.args.file
    if (typeof field !== 'string') return undefined
    const result = snapshotJson({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: value.cwd,
        tool_input: tool === 'Bash' || tool === 'apply_patch' ? { command: field } : { file_path: field } })
    return record(result) && Buffer.byteLength(JSON.stringify(result)) <= GUARD_INPUT_LIMITS.inputBytes ? result : undefined
}

/** The application binds this data to the shared process executor; no handler is installed here. */
export function planGuardTransport(input: unknown): GuardTransportPlan | GuardTransportRefusal {
    const value = snapshotJson(input)
    if (!record(value) || !keys(value, ['target', 'handler', 'cwd', 'stdin']) || !target(value.target)
        || !absolute(value.handler) || !absolute(value.cwd) || !text(value.stdin, GUARD_INPUT_LIMITS.inputBytes)) {
        return Object.freeze({ kind: 'refusal', code: 'GUARD_TRANSPORT_INVALID', message: 'Guard transport requires a resolved handler, canonical cwd and bounded stdin.' })
    }
    // The handler is a second Node process started per tool call. Five seconds was exceeded by Node
    // start-up alone on a loaded developer machine, which failed closed and blocked every tool call;
    // twenty stays well inside the harnesses' own hook timeouts.
    const plan: GuardTransportPlan = Object.freeze({ kind: 'complete', target: value.target, executable: value.handler, cwd: value.cwd,
        argv: Object.freeze([...GUARD_HANDLER_ARGV, '--harness', value.target] as const), stdin: value.stdin, timeoutMs: 20000, stdoutBytes: 65536, stderrBytes: 65536 })
    plans.add(plan)
    return plan
}

export function completeGuardTransport(plan: unknown, response: unknown): NativeGuardOutput {
    const fail = (reason: string): NativeGuardOutput => Object.freeze({ target: null, capability: 'instructed', decision: 'unavailable', exitCode: 2, stdout: '', stderr: `cockpit guard: ${reason}\n` })
    if (typeof plan !== 'object' || plan === null || !plans.has(plan)) return fail('Guard transport plan was not issued by the adapter.')
    const issued = plan as GuardTransportPlan
    const value = snapshotJson(response)
    if (!record(value) || !keys(value, ['exitCode', 'signal', 'stdout', 'stderr']) || value.exitCode !== 0 || value.signal !== null
        || !text(value.stdout, issued.stdoutBytes) || !text(value.stderr, issued.stderrBytes)) {
        return adaptGuardDecision(issued.target, { decision: 'unavailable', reason: 'Guard handler transport failed or exceeded its output bounds.' })
    }
    let reply: unknown
    try { reply = JSON.parse(value.stdout) }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return adaptGuardDecision(issued.target, { decision: 'unavailable', reason: 'Guard handler returned invalid JSON.' })
    }
    return adaptGuardDecision(issued.target, reply)
}
