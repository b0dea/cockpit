import { posix } from 'node:path'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_SURFACE_TARGETS, type GuardSurfaceTarget } from '../surfaces/harness-registry.js'
import type { GuardDecision } from './evaluator.js'
import { GUARD_INPUT_LIMITS } from './invocation-parser.js'

export const GUARD_HANDLER_ARGV = Object.freeze(['guard-evaluate'] as const)
export interface NativeGuardOutput {
    readonly target: GuardSurfaceTarget | null
    readonly capability: 'instructed'
    readonly decision: GuardDecision['decision']
    readonly exitCode: 0 | 2
    readonly stdout: string
    readonly stderr: string
}

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
    return { target: native, capability: 'instructed', decision: verdict, exitCode, stdout, stderr }
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
