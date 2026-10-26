import { runSleep } from '../environment/application.js'
import type {
    SleepCommandAdapters,
    SleepCommandInput,
    SleepCommandResult,
} from '../environment/application.js'

export type { SleepCommandAdapters, SleepCommandInput, SleepCommandResult }

export const mechanism = {
    id: 'sleep-command',
    module: 'packages/cockpit/src/sleep/command.ts',
    exports: ['sleepCommand'],
} as const

export function sleepCommand(
    input: SleepCommandInput,
    adapters: SleepCommandAdapters,
): Promise<SleepCommandResult> {
    return runSleep(input, adapters)
}
