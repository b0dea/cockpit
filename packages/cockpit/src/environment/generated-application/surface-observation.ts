import type { StandingCost } from '../../surfaces/projection.js'
import { surfaceModelSha256 } from '../../surfaces/render.js'
import { ENVIRONMENT_CODES, snapshotEnvironmentObservation, type EnvironmentObservation } from '../contract.js'
import { stackId } from '../identity.js'
import { type GeneratedApplicationProjection, OWNER, issuedApplicationProjections, issuedSurfaceObservations } from './shared.js'

// The rows only this observation answers; when it cannot be made they report missing evidence.
export const SURFACE_OBSERVATION_CODES: readonly string[] = [ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE,
    ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE]

export function observeGeneratedApplicationSurfaces(
    application: GeneratedApplicationProjection,
): readonly EnvironmentObservation[] | undefined {
    const record = application !== null && typeof application === 'object'
        ? issuedApplicationProjections.get(application)
        : undefined
    if (!record?.currentPublication || record.surfaceSelftest !== application.surfaceSelftest) return undefined
    const grantsSha256 = surfaceModelSha256(record.surfaceHealth.grants)
    const availableGuideCosts = record.surfaceHealth.guideCosts.filter(
        (cost): cost is Exclude<StandingCost, { status: 'unavailable' }> => cost.status !== 'unavailable',
    )
    if (!grantsSha256 || grantsSha256 !== record.surfaceHealth.nativeGrants.modelSha256
        || availableGuideCosts.length !== record.surfaceHealth.guideCosts.length
        || availableGuideCosts.some(cost => cost.status !== 'within_cap')) return undefined
    const guideValue = availableGuideCosts.reduce((maximum, cost) => Math.max(maximum, cost.value), 0)
    const guideCap = availableGuideCosts[0]?.cap
    if (guideCap === undefined || availableGuideCosts.some(cost => cost.cap !== guideCap)) return undefined
    const observedAt = record.surfaceHealth.observedAt
    const required = (posture: string) => ({ state: 'required' as const, posture })
    const observations = [
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, owner: OWNER, stackId: record.stackId,
            source: `surface-manifest:${record.surfaceSelftest.manifestSha256}`,
            observed: { state: 'available', value: { manifestSha256: record.surfaceSelftest.manifestSha256,
                harnesses: record.surfaceSelftest.configuredHarnesses, entries: record.surfaceSelftest.entries.length }, observedAt },
            expectation: { kind: 'present' }, applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'run npx --no cockpit sync --config <your cockpit.toml>, then rerun npx --no cockpit preflight --config <your cockpit.toml>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, owner: OWNER, stackId: record.stackId,
            source: `directory-grants:${grantsSha256}`,
            observed: { state: 'available', value: { grants: record.surfaceHealth.grants.length,
                generatedFragments: record.surfaceHealth.nativeGrants.fragments.length, modelSha256: grantsSha256 }, observedAt },
            expectation: { kind: 'present' }, applicability: record.surfaceHealth.grants.length > 0
                ? required('directory-grants')
                : { state: 'not-applicable', posture: 'directory-grants', reason: 'the active sibling projection declares no directory grants' },
            freshness: { state: 'current' },
            remedy: 'run npx --no cockpit sync --config <your cockpit.toml>, then rerun npx --no cockpit preflight --config <your cockpit.toml>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, owner: OWNER, stackId: record.stackId,
            source: `surface-guide-costs:${record.surfaceSelftest.manifestSha256}`,
            observed: { state: 'available', value: guideValue, observedAt }, expectation: { kind: 'maximum', value: guideCap },
            applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'move conditional guidance behind its scoped or pull-loaded surface, then run npx --no cockpit sync --config <your cockpit.toml>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, owner: OWNER, stackId: record.stackId,
            source: `installed-skill-inventory:${record.surfaceHealth.skillInventorySha256}`,
            observed: { state: 'available', value: { coreCollectionSha256: record.surfaceHealth.skillCollectionSha256,
                inventorySha256: record.surfaceHealth.skillInventorySha256, inventory: record.surfaceHealth.skillInventory, skills: record.surfaceHealth.skills,
                costs: record.surfaceHealth.skillCosts.map(({ target, metric, value, cap }) => ({ target, metric, value, cap })) }, observedAt },
            expectation: { kind: 'present' }, applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'move skill procedure text out of always-loaded entry points, then run npx --no cockpit sync --config <your cockpit.toml>',
        }),
    ]
    if (!observations.every((observation): observation is EnvironmentObservation => observation !== undefined)) return undefined
    const issuedAt = Date.now()
    for (const observation of observations) issuedSurfaceObservations.set(observation, issuedAt)
    return observations
}
