import { runSetup } from '../environment/application/setup.js'
import type { SetupCommandAdapters, SetupCommandInput, SetupCommandResult } from '../environment/application/setup.js'
import type { SetupApplicationOutcome } from '../environment/application/setup.js'

export type { SetupCommandAdapters, SetupCommandInput, SetupCommandResult }

export function setupCommand(
    input: SetupCommandInput,
    adapters: SetupCommandAdapters,
): Promise<SetupApplicationOutcome> {
    return runSetup(input, adapters)
}
