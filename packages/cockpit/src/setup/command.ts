import { runSetup } from '../environment/application.js'
import type {
    SetupCommandAdapters,
    SetupCommandInput,
    SetupCommandResult,
} from '../environment/application.js'
import type { SetupApplicationOutcome } from '../environment/application.js'

export type { SetupCommandAdapters, SetupCommandInput, SetupCommandResult }

export function setupCommand(
    input: SetupCommandInput,
    adapters: SetupCommandAdapters,
): Promise<SetupApplicationOutcome> {
    return runSetup(input, adapters)
}
