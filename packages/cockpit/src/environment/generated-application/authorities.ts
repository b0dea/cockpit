import { resolve } from 'node:path'
import { consumeWorkEnvironmentConfigProjection, loadCockpitConfig, projectWorkEnvironmentConfig } from '../../config/load.js'
import { CORE_EVALUATOR_ASSET as EVALUATOR_ASSET } from '../../surfaces/core-declarations.js'
import { nodeAuthority, readAnchoredFile } from '../../generated-environment/transaction.js'
import { TESTING_GUIDE_REGISTRY, createGateRegistry } from '../../testing/gates.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import {
    type ConsumedWorkApplicationAuthorities,
    type GeneratedApplicationProjection,
    type GeneratedEnvironmentCommandInput,
    MAX_SURFACE_FILE_BYTES,
    type RefusalOutcome,
    SURFACE_ROOT,
    type WorkApplicationAuthoritiesProjection,
    defaultAdapters,
    issuedApplicationProjections,
    issuedWorkApplicationAuthorities,
    projectedWorkApplicationAuthorities,
    readSurfaceAsset,
    sha256,
} from './shared.js'
import { commandInput } from './prepare.js'

export function generatedApplicationProjection(value: unknown): GeneratedApplicationProjection | undefined {
    return value !== null && typeof value === 'object' && issuedApplicationProjections.has(value)
        ? value as GeneratedApplicationProjection : undefined
}

export function generatedSelftestGuardRuntime(application: GeneratedApplicationProjection, root: string) {
    const record = issuedApplicationProjections.get(application)
    return record?.currentPublication && record.root === root ? record.guardRuntime : undefined
}

export function generatedSelftestGuardHandler(application: GeneratedApplicationProjection, root: string) {
    const record = issuedApplicationProjections.get(application)
    return record?.currentPublication && record.root === root ? record.guardHandler : undefined
}

export function projectWorkApplicationAuthorities(
    application: GeneratedApplicationProjection,
): WorkApplicationAuthoritiesProjection | undefined {
    if (application === null || typeof application !== 'object' || projectedWorkApplicationAuthorities.has(application)) return undefined
    const record = issuedApplicationProjections.get(application)
    if (!record?.workApplication) return undefined
    const projection: WorkApplicationAuthoritiesProjection = { kind: 'work-application-authorities' }
    projectedWorkApplicationAuthorities.add(application)
    issuedWorkApplicationAuthorities.set(projection, record.workApplication)
    return projection
}

export function consumeWorkApplicationAuthorities(
    projection: WorkApplicationAuthoritiesProjection,
): ConsumedWorkApplicationAuthorities | undefined {
    if (projection === null || typeof projection !== 'object') return undefined
    const record = issuedWorkApplicationAuthorities.get(projection)
    if (!record) return undefined
    issuedWorkApplicationAuthorities.delete(projection)
    return record
}

export async function prepareWorkApplicationAuthorities(
    input: GeneratedEnvironmentCommandInput,
): Promise<WorkApplicationAuthoritiesProjection | RefusalOutcome> {
    const request = commandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'work application input is invalid', 'work')
    const loaded = await loadCockpitConfig(request.configPath)
    if (loaded.kind !== 'complete') return {
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [...loaded.diagnostics],
    }
    const configProjection = projectWorkEnvironmentConfig(loaded.result)
    const workEnvironment = configProjection && consumeWorkEnvironmentConfigProjection(configProjection)
    const node = await nodeAuthority()
    if (!workEnvironment || !node) return refuse('GENERATED_RENDER_UNAUTHENTICATED', 'work configuration or Node authority is unavailable', request.configPath)
    const read = await readAnchoredFile(SURFACE_ROOT, EVALUATOR_ASSET, MAX_SURFACE_FILE_BYTES, node, defaultAdapters)
    const evaluator = readSurfaceAsset(EVALUATOR_ASSET, read)
    if (!evaluator) return refuse('SURFACE_INPUT_INVALID', 'the shipped evaluator could not be authenticated', EVALUATOR_ASSET)
    const projection: WorkApplicationAuthoritiesProjection = { kind: 'work-application-authorities' }
    issuedWorkApplicationAuthorities.set(projection, Object.freeze({
        workEnvironment,
        evaluator: Object.freeze({ path: resolve(SURFACE_ROOT, evaluator.path), bytes: evaluator.bytes,
            sha256: evaluator.sha256, identity: evaluator.identity, restriction: 'instructed' as const }),
        installedSkills: Object.freeze([]),
        testing: Object.freeze({ registry: workEnvironment.testing ? createGateRegistry(workEnvironment.testing.declarations) : TESTING_GUIDE_REGISTRY }),
    }))
    return projection
}
