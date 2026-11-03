import { sha256Hex } from '../sha256.js'
import { authenticatedExecutionOutcome, executeProbe } from '../environment-exec/execute.js'
import type { ExecutionStep } from '../environment/contract.js'
import { resolveNamedPath, type NamedPathInput } from '../references/named.js'
import { bindSurfaceOwnershipIdentity, type SurfaceDesiredEntry } from '../surfaces/ownership.js'
import { resolveExecutablePath } from '../environment/executable.js'
import { errorCause } from '../environment/contract.js'

export type NativeHookEntry = Extract<SurfaceDesiredEntry, { kind: 'file' }>
export interface NativeHookPolicy extends NamedPathInput { readonly bytes: string }
export type NativeHookMeasurement = ExecutionStep
export interface NativeHookBudget {
    readonly prepareMeasurement: (entry: NativeHookEntry) => Promise<NativeHookMeasurement>
    readonly policy: NativeHookPolicy
}
export type NativeHookInput = Readonly<{
    cockpitId: string
    harnesses: readonly string[]
}> & (Readonly<{ install: 'inspect'; budget?: NativeHookBudget }>
    | Readonly<{ install: 'explicit-native'; budget: NativeHookBudget }>)
type HookRefusal = Readonly<{ kind: 'refusal'; reason: string }>
export type HookBudgetResult = Readonly<{ kind: 'within-budget'; scope: 'supplied-execution-environment'; executionSha256: string; limitMs: number; measuredMs: number }>
    | Readonly<{ kind: 'ci-required'; reason: string }> | HookRefusal
export type NativeHookProjection = Readonly<{
    kind: 'complete'
    entries: readonly NativeHookEntry[]
    cost: Extract<HookBudgetResult, { kind: 'within-budget' }>
    activation: Readonly<{ kind: 'explicit-native-install'; hooksPath: '.githooks'; mode: 493 }>
}> | Readonly<{ kind: 'not-installed'; reason: string }> | Exclude<HookBudgetResult, { kind: 'within-budget' }>

export const NATIVE_HOOK_COST_SCRIPT = `{
    count=0
    while [ "$count" -lt 128 ]; do
        printf 'refs/heads/cost %s refs/heads/cost %s\\n' "$2" "$3"
        count=$((count + 1))
    done
} | /bin/sh "$1"`

const refusal = (reason: string): HookRefusal => ({ kind: 'refusal', reason })

function policyLimit(policy: NativeHookPolicy): number | HookRefusal {
    const reference = resolveNamedPath(policy)
    if (reference.kind !== 'resolved') return refusal(`native hook budget policy is unavailable: ${policy.path}`)
    const owner = policy.manifest.entries.find(entry => entry.path === policy.path)
    if (!owner || owner.kind !== 'file' || typeof policy.bytes !== 'string' || Buffer.byteLength(policy.bytes) > 64
        || sha256Hex(policy.bytes) !== owner.sha256) return refusal('native hook budget must bind exact policy bytes to the ownership manifest')
    const marker = /^native-hook-ms=([1-9][0-9]*)\n$/.exec(policy.bytes)
    const limitMs = marker ? Number(marker[1]) : Number.NaN
    return Number.isSafeInteger(limitMs) ? limitMs : refusal('native hook policy must declare one positive native-hook-ms cap')
}

export async function checkNativeHookBudget(entry: NativeHookEntry, measurement: NativeHookMeasurement, policy: NativeHookPolicy): Promise<HookBudgetResult> {
    const cap = policyLimit(policy)
    if (typeof cap !== 'number') return cap
    const resolvedShell = await resolveExecutablePath('/bin/sh')
    if (resolvedShell.state !== 'available') return refusal('native hook requires an authenticated system shell')
    const file = measurement?.consumedFiles?.find(file => !file.executable && file.sha256 === entry.sha256
        && measurement.argv.length === 7 && measurement.argv[4] === file.path && file.argvIndexes.length === 1 && file.argvIndexes[0] === 4)
    const argv = measurement?.argv
    const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && /[1-9a-f]/.test(value)
    const shell = measurement?.consumedFiles?.find(file => file.executable && file.path === resolvedShell.value.canonicalPath
        && file.sha256 === resolvedShell.value.sha256 && file.executionMode === resolvedShell.value.executionMode
        && file.argvIndexes.length === 1 && file.argvIndexes[0] === 0)
    const workload = shell && argv && argv[0] === resolvedShell.value.canonicalPath && argv[1] === '-c' && argv[2] === NATIVE_HOOK_COST_SCRIPT
        && argv[3] === 'native-hook-cost' && oid(argv[5]!) && oid(argv[6]!) && argv[5]!.length === argv[6]!.length && argv[5] !== argv[6]
    const marker = /^# cockpit:budget name=native-hook-ms limit-ms=([1-9][0-9]*)$/m.exec(entry.bytes)
    const limitMs = marker ? Number(marker[1]) : Number.NaN
    if (!file || !workload || entry.writer !== 'cockpit' || sha256Hex(entry.bytes) !== entry.sha256 || limitMs !== cap) {
        return refusal('native hook requires intact bytes, an authenticated policy cap and the exact 128-update ancestry workload')
    }
    const executionSha256 = sha256Hex(JSON.stringify(measurement))
    const started = performance.now()
    const outcome = authenticatedExecutionOutcome(await executeProbe(measurement), measurement)
    const measuredMs = Math.ceil(performance.now() - started)
    if (!outcome || outcome.kind !== 'complete' || outcome.execution.exitCode !== 0) {
        return refusal(`native hook cost execution failed: ${outcome?.kind === 'refusal' ? outcome.code : 'missing authenticated successful receipt'}`)
    }
    return measuredMs > limitMs
        ? { kind: 'ci-required', reason: `native hook cost ${measuredMs}ms exceeds native-hook-ms=${limitMs}; move this check to CI` }
        : { kind: 'within-budget', scope: 'supplied-execution-environment', executionSha256, limitMs, measuredMs }
}

function nativeScript(cockpitId: string, limitMs: number): string {
    return `#!/bin/sh
# cockpit:writer ${cockpitId}
# cockpit:budget name=native-hook-ms limit-ms=${limitMs}
count=0
while IFS=' ' read -r local_ref local_oid remote_ref remote_oid extra || [ -n "$local_ref$local_oid$remote_ref$remote_oid$extra" ]; do
    count=$((count + 1))
    if [ "$count" -gt 128 ]; then
        echo 'native push guard: more than 128 ref updates; review and split the push' >&2
        exit 2
    fi
    case "$local_ref:$remote_ref:$extra" in
        refs/*:refs/*:) ;;
        *) echo 'native push guard: malformed ref update' >&2; exit 2 ;;
    esac
    for oid in "$local_oid" "$remote_oid"; do
        case "$oid" in
            ''|*[!0-9a-f]*) echo 'native push guard: malformed object identity' >&2; exit 2 ;;
        esac
        if [ "\${#oid}" -ne 40 ] && [ "\${#oid}" -ne 64 ]; then
            echo 'native push guard: malformed object identity length' >&2
            exit 2
        fi
    done
    if [ "\${#local_oid}" -ne "\${#remote_oid}" ]; then
        echo 'native push guard: object identity formats differ' >&2
        exit 2
    fi
    case "$local_oid" in
        *[!0]*) ;;
        *) echo 'native push guard: branch or tag deletion requires explicit review' >&2; exit 2 ;;
    esac
    case "$remote_oid" in
        *[!0]*) ;;
        *) continue ;;
    esac
    git merge-base --is-ancestor "$remote_oid" "$local_oid"
    status=$?
    case "$status" in
        0) ;;
        1) echo 'native push guard: non-fast-forward update requires explicit review' >&2; exit 2 ;;
        *) echo 'native push guard: ancestry check failed; inspect repository state' >&2; exit 2 ;;
    esac
done
exit 0
`
}

export async function projectNativeHooks(input: NativeHookInput): Promise<NativeHookProjection> {
    if (input.install === 'inspect') return { kind: 'not-installed', reason: 'native hooks require explicit installation' }
    if (input.install !== 'explicit-native' || !/^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/.test(input.cockpitId)
        || input.budget.policy.authority.cockpitId !== input.cockpitId) {
        return refusal('native hook requires explicit installation, cockpit identity and a named positive budget')
    }
    const limit = policyLimit(input.budget.policy)
    if (typeof limit !== 'number') return limit
    const bytes = nativeScript(input.cockpitId, limit)
    const harnesses = [...new Set(input.harnesses)].sort()
    if (!harnesses.length) return refusal('native hook requires configured harness ownership')
    const entry: NativeHookEntry = { path: '.githooks/pre-push', kind: 'file', ownership: 'whole-file',
        harnesses: harnesses as [string, ...string[]], writer: 'cockpit', schemaVersion: 1, scope: 'scoped', capability: 'instructed', bytes, sha256: sha256Hex(bytes) }
    if (typeof input.budget.prepareMeasurement !== 'function') return refusal('native hook requires a bounded measurement plan callback')
    let measurement: NativeHookMeasurement
    try { measurement = await input.budget.prepareMeasurement(entry) }
    catch (error) { return refusal(`native hook measurement failed: ${errorCause(error)}`) }
    const cost = await checkNativeHookBudget(entry, measurement, input.budget.policy)
    if (cost.kind !== 'within-budget') return cost
    const owned = bindSurfaceOwnershipIdentity([entry], input.cockpitId)
    if (owned.kind === 'refusal') return refusal(owned.diagnostic.message)
    return { kind: 'complete', entries: [entry], cost,
        activation: { kind: 'explicit-native-install', hooksPath: '.githooks', mode: 0o755 } }
}
