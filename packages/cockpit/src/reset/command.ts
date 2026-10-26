import { runReset } from '../environment/application.js'
import type {
    ResetCommandAdapters,
    ResetCommandInput,
    ResetCommandResult,
} from '../environment/application.js'

export type { ResetCommandAdapters, ResetCommandInput, ResetCommandResult }

export const mechanism = {
    id: 'reset-command',
    module: 'packages/cockpit/src/reset/command.ts',
    exports: ['resetCommand'],
} as const

export function resetCommand(
    input: ResetCommandInput,
    adapters: ResetCommandAdapters,
): Promise<ResetCommandResult> {
    return runReset(input, adapters)
}
