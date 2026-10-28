import { posix } from 'node:path'
import { captureHookWiring, hookEvidenceMatches, type HookWiring } from '../../libexec/validate-harness-evidence.mjs'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import type { GuardInvocationProfile, GuardProjectCommand } from '../guards/evaluator.js'
import { GUARD_INPUT_LIMITS } from '../guards/invocation-parser.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from '../environment/install-policy.js'
import type { GuardSurfaceTarget } from '../surfaces/harness-registry.js'

export const mechanism = {
    id: 'autonomy-launch-representation', module: 'packages/cockpit/src/autonomy/launcher.ts',
    exports: ['issueResolvedAutonomyGrants', 'planAutonomyLaunch'],
} as const

export interface ResolvedAutonomyGrants {
    readonly target: GuardSurfaceTarget
    readonly nativeReads: readonly string[]
    readonly cockpitInvocations: readonly GuardInvocationProfile[]
    readonly projectCommands: readonly GuardProjectCommand[]
    readonly guardRegistration: { readonly registered: true; readonly wiring: HookWiring }
}
export interface AutonomyLaunchPlan {
    readonly kind: 'complete'
    readonly target: GuardSurfaceTarget
    readonly mode: 'ordinary' | 'escalated'
    readonly capability: 'instructed'
    readonly guardRequired: true
    readonly permissionGrants: Pick<ResolvedAutonomyGrants, 'nativeReads' | 'cockpitInvocations' | 'projectCommands'>
    readonly activeProtections: readonly string[]
}
export interface AutonomyLaunchRefusal {
    readonly kind: 'refusal'
    readonly code: 'AUTONOMY_GRANTS_INVALID' | 'AUTONOMY_MODE_INVALID' | 'AUTONOMY_ESCALATION_REQUIRED' | 'AUTONOMY_EVIDENCE_REQUIRED'
    readonly message: string
}
const issuedGrants = new WeakSet<object>()
const readSpellings = { claudecode: ['Read', 'Glob', 'Grep'], codexcli: [], opencode: ['read', 'glob', 'grep'] } as const
const protections = Object.freeze(['hard-deny evaluation', 'always-run guard', 'native ask or ask-to-deny', 'exact invocation grants', 'read-only instructions'])
function record(value: JsonSnapshot | undefined): value is JsonSnapshotObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: JsonSnapshotObject, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)) }
function text(value: JsonSnapshot | undefined): value is string {
    return typeof value === 'string' && Buffer.byteLength(value) <= GUARD_INPUT_LIMITS.wordBytes && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value)
}
function path(value: JsonSnapshot | undefined): value is string {
    return text(value) && value.startsWith('/') && value !== '/' && !value.endsWith('/') && posix.normalize(value) === value && !value.includes('\\')
}
function command(value: JsonSnapshot | undefined, project: boolean): boolean {
    if (!record(value) || !keys(value, project ? ['executable', 'checkoutRoot', 'kind', 'argv'] : ['executable', 'cwd', 'argv'])
        || !path(project ? value.checkoutRoot : value.cwd) || !Array.isArray(value.argv)) return false
    if (project) {
        const tuple = GuardCommandArgv.safeParse([value.executable, ...value.argv])
        return (value.kind === 'build' || value.kind === 'test') && tuple.success
            && renderGuardProjectCommand(tuple.data).kind === 'complete'
    }
    return text(value.executable) && value.executable.length > 0 && !/[\s*?\[\]\\]/u.test(value.executable)
        && (!value.executable.includes('/') || path(value.executable))
        && value.argv.length <= GUARD_INPUT_LIMITS.words
        && value.argv.every((arg) => text(arg) && !/[*?\[\]]/.test(arg))
}

/** Application authority issues exact candidates here; this module never discovers or evaluates policy. */
export function issueResolvedAutonomyGrants(input: unknown): ResolvedAutonomyGrants | undefined {
    const value = snapshotJson(input)
    if (!record(value) || !keys(value, ['target', 'nativeReads', 'cockpitInvocations', 'projectCommands', 'guardRegistration'])
        || typeof value.target !== 'string' || !Object.hasOwn(readSpellings, value.target)
        || !Array.isArray(value.nativeReads) || new Set(value.nativeReads).size !== value.nativeReads.length
        || !value.nativeReads.every((read) => typeof read === 'string' && (readSpellings[value.target as GuardSurfaceTarget] as readonly string[]).includes(read))
        || !Array.isArray(value.cockpitInvocations) || !Array.isArray(value.projectCommands)
        || value.cockpitInvocations.length + value.projectCommands.length > GUARD_INPUT_LIMITS.invocations
        || !value.cockpitInvocations.every((item) => command(item, false)) || !value.projectCommands.every((item) => command(item, true))
        || !record(value.guardRegistration) || !keys(value.guardRegistration, ['registered', 'wiring']) || value.guardRegistration.registered !== true) return undefined
    const wiring = captureHookWiring(value.guardRegistration.wiring)
    if (!wiring || wiring.target !== value.target) return undefined
    // All fields are frozen own data with closed shapes before entering the typed representation.
    const grants = value as unknown as ResolvedAutonomyGrants
    issuedGrants.add(grants)
    return grants
}

export function planAutonomyLaunch(grants: unknown, options: unknown = {}): AutonomyLaunchPlan | AutonomyLaunchRefusal {
    const refusal = (code: AutonomyLaunchRefusal['code'], message: string): AutonomyLaunchRefusal => Object.freeze({ kind: 'refusal', code, message })
    if (typeof grants !== 'object' || grants === null || !issuedGrants.has(grants)) {
        return refusal('AUTONOMY_GRANTS_INVALID', 'Autonomy requires application-issued resolved grants and current guard registration.')
    }
    const captured = snapshotJson(options)
    if (!record(captured) || Object.keys(captured).some((key) => !['mode', 'explicitEscalation', 'evidence'].includes(key))
        || Object.hasOwn(captured, 'mode') && captured.mode !== 'ordinary' && captured.mode !== 'escalated'
        || Object.hasOwn(captured, 'explicitEscalation') && typeof captured.explicitEscalation !== 'boolean') {
        return refusal('AUTONOMY_MODE_INVALID', 'Autonomy mode must be ordinary or explicitly escalated.')
    }
    const mode = captured.mode === 'escalated' ? 'escalated' : 'ordinary'
    const resolved = grants as ResolvedAutonomyGrants
    if (mode === 'escalated') {
        if (captured.explicitEscalation !== true) return refusal('AUTONOMY_ESCALATION_REQUIRED', 'Escalated launch requires an explicit escalation flag.')
        const evidence = Object.getOwnPropertyDescriptor(options, 'evidence')?.value as unknown
        if (!hookEvidenceMatches(evidence, resolved.guardRegistration.wiring)) {
            return refusal('AUTONOMY_EVIDENCE_REQUIRED', 'Escalated launch requires authenticated fresh exact hook, handler, registration and native candidate/control evidence.')
        }
    } else if (captured.explicitEscalation === true) {
        return refusal('AUTONOMY_MODE_INVALID', 'An escalation flag requires escalated mode.')
    }
    return Object.freeze({ kind: 'complete', target: resolved.target, mode, capability: 'instructed', guardRequired: true,
        permissionGrants: Object.freeze({ nativeReads: resolved.nativeReads, cockpitInvocations: resolved.cockpitInvocations, projectCommands: resolved.projectCommands }),
        activeProtections: protections })
}
