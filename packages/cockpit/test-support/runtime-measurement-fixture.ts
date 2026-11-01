import { recordLocalRuntimeMeasurement } from '../src/environment/runtime-measurement-record.js'

// Stands in for `runtime measure`: records, through the production writer, a passing measurement of
// the runtime the synthetic docker stand-ins report (Docker Desktop, engine 27.1.2, Compose 2.39.2).
export async function recordSyntheticMeasurement(cockpitRoot: string): Promise<void> {
    const recorded = await recordLocalRuntimeMeasurement(cockpitRoot, {
        runtime: 'docker-desktop', daemon: 'docker-desktop', engineVersion: '27.1.2', composeFloor: '2.20.0', measuredOn: '2026-09-26',
    })
    if (recorded.kind !== 'complete') throw new Error(recorded.reason)
}
