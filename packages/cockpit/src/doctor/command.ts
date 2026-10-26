import { runDoctor } from '../environment/application.js'
import type {
    DoctorCommandAdapters,
    DoctorCommandInput,
    DoctorCommandResult,
} from '../environment/application.js'

export type { DoctorCommandAdapters, DoctorCommandInput, DoctorCommandResult }

export const mechanism = {
    id: 'doctor-command',
    module: 'packages/cockpit/src/doctor/command.ts',
    exports: ['doctorCommand'],
} as const

export function doctorCommand(
    input: DoctorCommandInput,
    adapters: DoctorCommandAdapters,
): Promise<DoctorCommandResult> {
    return runDoctor(input, adapters)
}
