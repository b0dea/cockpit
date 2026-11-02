import { recordLocalRuntimeMeasurement } from '../src/environment/runtime-measurement-record.js'
import { selectMachineStateRoot } from '../src/environment/state.js'

// Stands in for `runtime measure`: records, through the production writer, a passing measurement of
// the runtime the synthetic docker stand-ins report (Docker Desktop, engine 27.1.2, Compose 2.39.2),
// in the per-user state root the given HOME selects.
export async function recordSyntheticMeasurement(home: string): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error(`unsupported platform ${process.platform}`)
    const stateRoot = await selectMachineStateRoot({ platform: process.platform, home })
    if (stateRoot.kind !== 'complete') throw new Error(stateRoot.kind === 'refusal' ? stateRoot.message : 'state root unavailable')
    const recorded = await recordLocalRuntimeMeasurement(stateRoot.value, {
        runtime: 'docker-desktop', daemon: 'docker-desktop', engineVersion: '27.1.2', composeFloor: '2.20.0', measuredOn: '2026-09-26',
    })
    if (recorded.kind !== 'complete') throw new Error(recorded.reason)
}
