import { runPreflight } from '../environment/application.js'
import type {
    PreflightCommandAdapters,
    PreflightCommandInput,
    PreflightCommandResult,
} from '../environment/application.js'

export type { PreflightCommandAdapters, PreflightCommandInput, PreflightCommandResult }

export const mechanism = {
    id: 'preflight-command',
    module: 'packages/cockpit/src/preflight/command.ts',
    exports: ['preflightCommand'],
} as const

export function preflightCommand(
    input: PreflightCommandInput,
    adapters: PreflightCommandAdapters,
): Promise<PreflightCommandResult> {
    return runPreflight(input, adapters)
}
