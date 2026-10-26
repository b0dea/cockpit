import {
    generatedApplicationProjection,
    syncGeneratedEnvironment,
    type GeneratedEnvironmentCommandOutcome,
} from './generated-application.js'
import type { Diagnostic } from './contract.js'
import type { SurfaceFeature } from '../surfaces/contract.js'

export const mechanism = {
    id: 'environment-upgrade-application',
    module: 'packages/cockpit/src/environment/upgrade-application.ts',
    exports: ['runConfiguredUpgradeApplication'],
} as const

export interface ConfiguredUpgradeApplicationInput {
    readonly configPath: string
    readonly releaseEvidencePath?: string
    readonly releaseEvidenceSha256?: string
}

interface UpgradeCurrentOverrideProjection {
    readonly activeOverrides: readonly Readonly<{
        name: string
        feature: Extract<SurfaceFeature, 'rules' | 'subagents' | 'skills' | 'hooks'>
        originalSha256: string
        recordedSha256: string
        overlaySource: string
    }>[]
}

interface UpgradeApplicationOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

interface UpgradeApplicationDiscoveryAdapters {
    readonly discoverAuthenticated: (request: Readonly<{ configPath: string }>) => Promise<unknown>
}

export interface ConfiguredUpgradeApplicationAdapters<Outcome extends UpgradeApplicationOutcome> {
    readonly installed: Readonly<{ package: string; version: string }>
    readonly unavailableDiscovery: UpgradeApplicationDiscoveryAdapters['discoverAuthenticated']
    readonly runUpgrade: (
        input: Readonly<{ configPath: string }>,
        adapters: UpgradeApplicationDiscoveryAdapters,
    ) => Promise<Outcome>
    readonly createReleaseEvidenceDiscovery: (options: Readonly<{
        configPath: string
        evidencePath: string
        expectedSha256: string
        projection: UpgradeCurrentOverrideProjection
        installed: Readonly<{ package: string; version: string }>
    }>) => UpgradeApplicationDiscoveryAdapters['discoverAuthenticated']
}

function releaseEvidenceOverrideProjection(
    application: NonNullable<ReturnType<typeof generatedApplicationProjection>>,
): UpgradeCurrentOverrideProjection | undefined {
    const activeOverrides: UpgradeCurrentOverrideProjection['activeOverrides'][number][] = []
    for (const override of application.activeSurfaceOverrides) {
        if (override.feature !== 'rules' && override.feature !== 'subagents'
            && override.feature !== 'skills' && override.feature !== 'hooks') return undefined
        activeOverrides.push(Object.freeze({
            name: override.name,
            feature: override.feature,
            originalSha256: override.originalSha256,
            recordedSha256: override.recordedSha256,
            overlaySource: override.overlaySource,
        }))
    }
    return Object.freeze({ activeOverrides: Object.freeze(activeOverrides) })
}

export async function runConfiguredUpgradeApplication<Outcome extends UpgradeApplicationOutcome>(
    input: ConfiguredUpgradeApplicationInput,
    adapters: ConfiguredUpgradeApplicationAdapters<Outcome>,
): Promise<Outcome | Extract<GeneratedEnvironmentCommandOutcome, { kind: 'refusal' }>> {
    if (!input.releaseEvidencePath || !input.releaseEvidenceSha256) {
        return adapters.runUpgrade(input, { discoverAuthenticated: adapters.unavailableDiscovery })
    }
    const observed = await syncGeneratedEnvironment({ configPath: input.configPath, dryRun: true })
    if (observed.kind === 'refusal') return observed
    const application = generatedApplicationProjection(observed.result.application)
    const projection = application ? releaseEvidenceOverrideProjection(application) : undefined
    if (!projection) {
        return adapters.runUpgrade(input, {
            discoverAuthenticated: async () => ({
                kind: 'refusal',
                code: 'UPGRADE_AUTH_FAILED',
                reason: 'current generated application evidence is unavailable or invalid',
            }),
        })
    }
    return adapters.runUpgrade(input, {
        discoverAuthenticated: adapters.createReleaseEvidenceDiscovery({
            configPath: input.configPath,
            evidencePath: input.releaseEvidencePath,
            expectedSha256: input.releaseEvidenceSha256,
            projection,
            installed: Object.freeze({ package: adapters.installed.package, version: adapters.installed.version }),
        }),
    })
}
