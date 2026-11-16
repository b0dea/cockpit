import { exactKeys } from '../exact-keys.js'
import {
    RefusalError,
    ENVIRONMENT_CODES,
    snapshotJson,
    type EnvironmentCode,
    type EnvironmentObservation,
    type ObservationExpectation,
    type StackId,
} from './contract.js'
import { isMachineFloorEvidence, type MachineFloorEvidence } from './runtime.js'

const OWNER = 'host-observation'

export const observationDeclarations = Object.freeze([
    { id: 'machine-memory', owner: OWNER, postures: ['machine-floor'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR },
    { id: 'machine-cpu', owner: OWNER, postures: ['machine-floor'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.MACHINE_CPU_BELOW_FLOOR },
    { id: 'machine-disk', owner: OWNER, postures: ['machine-floor'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR },
] as const)

export interface HostCapacityFloor {
    readonly memoryBytes: number
    readonly cpuMillis: number
    readonly freeDiskBytes: number
}

function metric(stackId: StackId, evidence: MachineFloorEvidence, code: EnvironmentCode, source: string,
    measured: number, expectation: ObservationExpectation, remedy: string): EnvironmentObservation {
    return {
        code, owner: OWNER, stackId, source,
        observed: { state: 'available', value: measured, observedAt: evidence.observedAt },
        expectation,
        applicability: { state: 'required', posture: 'machine-floor' },
        freshness: { state: 'current' }, remedy,
    }
}

export function observeHostCapacity(input: {
    readonly evidence: MachineFloorEvidence
}): readonly EnvironmentObservation[] {
    if (input === null || typeof input !== 'object' || Object.keys(input).length !== 1 || !isMachineFloorEvidence(input.evidence)) {
        throw new RefusalError('machine-floor evidence is not authentic')
    }
    const evidence = input.evidence
    const stackId = evidence.stackId
    const floor = snapshotJson(evidence.floor)
    if (typeof stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(stackId)
        || floor === null || typeof floor !== 'object' || Array.isArray(floor)
        || !exactKeys(floor, ['cpuMillis', 'freeDiskBytes', 'memoryBytes'])
        || Object.values(floor).some((value) => !Number.isSafeInteger(value) || (value as number) < 1)) {
        throw new RefusalError('host capacity floor must use exact positive integer units')
    }
    const threshold = floor as unknown as HostCapacityFloor
    return [
        metric(stackId as StackId, evidence, ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR, 'runtime-memory-bytes', evidence.memoryBytes, { kind: 'minimum', value: threshold.memoryBytes }, 'make the declared runtime memory available'),
        metric(stackId as StackId, evidence, ENVIRONMENT_CODES.MACHINE_CPU_BELOW_FLOOR, 'runtime-cpu-millis', evidence.cpuMillis, { kind: 'minimum', value: threshold.cpuMillis }, 'make the declared runtime CPU capacity available'),
        metric(stackId as StackId, evidence, ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR, 'free-disk-bytes', evidence.freeDiskBytes, { kind: 'minimum', value: threshold.freeDiskBytes }, 'free disk space or lower the declared floor deliberately'),
    ]
}
