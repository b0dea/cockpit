import { runUp } from '../environment/application.js'
import type {
    UpCommandAdapters,
    UpCommandInput,
    UpCommandResult,
} from '../environment/application.js'

export type { UpCommandAdapters, UpCommandInput, UpCommandResult }

export const mechanism = {
    id: 'up-command',
    module: 'packages/cockpit/src/up/command.ts',
    exports: ['upCommand'],
} as const

export function upCommand(
    input: UpCommandInput,
    adapters: UpCommandAdapters,
): Promise<UpCommandResult> {
    return runUp(input, adapters)
}
