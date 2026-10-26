import { runDown } from '../environment/application.js'
import type {
    DownCommandAdapters,
    DownCommandInput,
    DownCommandResult,
} from '../environment/application.js'

export type { DownCommandAdapters, DownCommandInput, DownCommandResult }

export const mechanism = {
    id: 'down-command',
    module: 'packages/cockpit/src/down/command.ts',
    exports: ['downCommand'],
} as const

export function downCommand(
    input: DownCommandInput,
    adapters: DownCommandAdapters,
): Promise<DownCommandResult> {
    return runDown(input, adapters)
}
