import { admitUpProgress, planAdmittedUp } from '../src/environment/lifecycle.js'

type UpAdmission = Parameters<typeof admitUpProgress>[0]
export type UpPlanInput = UpAdmission & { readonly completedServices: Parameters<typeof planAdmittedUp>[0]['completedServices'] }

/**
 * Admit then plan an `up` in one call, the way the application sequences the two owner steps.
 * Descriptors are copied rather than read so a hostile accessor reaches the owner unevaluated.
 */
export function planUp(input: UpPlanInput): ReturnType<typeof planAdmittedUp> | Exclude<ReturnType<typeof admitUpProgress>, { kind: 'admitted' }> {
    const { completedServices: completed, ...admission } = Object.getOwnPropertyDescriptors(input)
    const admitted = admitUpProgress(Object.defineProperties({}, admission) as UpAdmission)
    if (admitted.kind !== 'admitted') return admitted
    return planAdmittedUp({ authority: admitted.authority, completedServices: completed?.value ?? [] })
}
