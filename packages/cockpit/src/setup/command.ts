import { runSetup } from '../environment/application.js'
import type {
    SetupCommandAdapters,
    SetupCommandInput,
    SetupCommandResult,
} from '../environment/application.js'
import type { SetupApplicationOutcome } from '../environment/application.js'

export type { SetupCommandAdapters, SetupCommandInput, SetupCommandResult }

export const mechanism = {
    id: 'setup-command',
    module: 'packages/cockpit/src/setup/command.ts',
    exports: ['setupCommand'],
} as const

export function setupCommand(
    input: SetupCommandInput,
    adapters: SetupCommandAdapters,
): Promise<SetupApplicationOutcome> {
    return runSetup(input, adapters)
}
