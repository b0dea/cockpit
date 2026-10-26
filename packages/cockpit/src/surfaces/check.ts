import { snapshotGeneratedJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import type { SurfaceDiagnostic } from './ownership.js'
import { planSurfaceChanges, type SurfaceChangeInput } from './sync.js'

export const mechanism = {
    id: 'surface-state-check',
    module: 'packages/cockpit/src/surfaces/check.ts',
    exports: ['compareSurfaceState'],
} as const

export type SurfaceComparisonResult =
    | Readonly<{
          kind: 'complete'
          current: readonly string[]
          missing: readonly string[]
          drift: readonly string[]
          stale: readonly string[]
          alreadyAbsent: readonly string[]
      }>
    | Readonly<{ kind: 'refusal'; diagnostic: SurfaceDiagnostic }>

export type SurfaceComparisonInput = SurfaceChangeInput

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function compareSurfaceState(input: unknown): SurfaceComparisonResult {
    const captured = snapshotGeneratedJson(input)
    if (!object(captured) || !Array.isArray(captured.desired) || !Array.isArray(captured.observed)) {
        return Object.freeze({ kind: 'refusal', diagnostic: Object.freeze({ code: 'SURFACE_INPUT_INVALID', message: 'surface comparison requires the change planner input model' }) })
    }
    const plan = planSurfaceChanges(captured)
    if (plan.kind === 'refusal') return plan
    const desiredPaths = captured.desired.flatMap(entry => object(entry) && typeof entry.path === 'string' ? [entry.path] : [])
    const observed = new Map(captured.observed.flatMap(entry => object(entry) && typeof entry.path === 'string' && typeof entry.kind === 'string'
        ? [[entry.path, entry.kind] as const] : []))
    const desiredActions = new Map(plan.actions.filter(action => action.kind === 'write').map(action => [action.path, action]))
    const current = desiredPaths.filter(path => !desiredActions.has(path)).sort()
    const missing = desiredPaths.filter(path => desiredActions.has(path) && (observed.get(path) ?? 'missing') === 'missing').sort()
    const drift = desiredPaths.filter(path => desiredActions.has(path) && observed.get(path) !== undefined && observed.get(path) !== 'missing').sort()
    const stale = plan.actions.filter(action => action.kind === 'remove').map(action => action.path).sort()
    const alreadyAbsent = plan.actions.filter(action => action.kind === 'already-absent').map(action => action.path).sort()
    const result = snapshotGeneratedJson({ kind: 'complete', current, missing, drift, stale, alreadyAbsent })
    return result ? result as unknown as SurfaceComparisonResult
        : Object.freeze({ kind: 'refusal', diagnostic: Object.freeze({ code: 'SURFACE_BOUNDS', message: 'surface comparison exceeds the captured bounds' }) })
}
