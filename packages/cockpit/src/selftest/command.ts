import {
    runConfiguredSurfaceSelftestApplication,
    runConfiguredSurfaceSelftestOutcome as configuredOutcome,
    runSelftestOperatorCommand as operatorCommand,
    type SurfaceSelftestHandlerInput,
    type SurfaceSelftestDispatchOutcome,
    type SelftestOperatorOptions,
    type SelftestOperatorIo,
    runSurfaceSelftestApplication,
    type ConfiguredSurfaceSelftestCommandInput,
    type SurfaceSelftestCommandAdapters,
    type SurfaceSelftestCommandInput,
    type SurfaceSelftestCommandOutcome,
} from '../environment/selftest-application.js'

export type {
    ConfiguredSurfaceSelftestCommandInput,
    SurfaceSelftestCommandAdapters,
    SurfaceSelftestCommandInput,
    SurfaceSelftestCommandOutcome,
    SurfaceSelftestExecutableCandidate,
    SurfaceSelftestProbeSpecificationsCandidate,
} from '../environment/selftest-application.js'

export const mechanism = {
    id: 'surface-selftest-command',
    module: 'packages/cockpit/src/selftest/command.ts',
    exports: ['runSurfaceSelftestCommand', 'runConfiguredSurfaceSelftestCommand', 'runConfiguredSurfaceSelftestOutcome', 'runSelftestOperatorCommand'],
} as const

export function runSurfaceSelftestCommand(
    input: SurfaceSelftestCommandInput,
    adapters?: SurfaceSelftestCommandAdapters,
): Promise<SurfaceSelftestCommandOutcome> {
    return runSurfaceSelftestApplication(input, adapters)
}

export function runConfiguredSurfaceSelftestCommand(
    input: ConfiguredSurfaceSelftestCommandInput,
    adapters?: SurfaceSelftestCommandAdapters,
): Promise<SurfaceSelftestCommandOutcome> {
    return runConfiguredSurfaceSelftestApplication(input, adapters)
}

export function runConfiguredSurfaceSelftestOutcome(input: SurfaceSelftestHandlerInput): Promise<SurfaceSelftestDispatchOutcome> {
    return configuredOutcome(input)
}

export function runSelftestOperatorCommand(
    input: SurfaceSelftestHandlerInput,
    options: SelftestOperatorOptions,
    io: SelftestOperatorIo,
    handler: (input: SurfaceSelftestHandlerInput) => Promise<SurfaceSelftestDispatchOutcome>,
): Promise<SurfaceSelftestDispatchOutcome> {
    return operatorCommand(input, options, io, handler)
}
