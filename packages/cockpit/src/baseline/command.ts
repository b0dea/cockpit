import { runBaselineRecord } from '../environment/application.js'
import type {
    BaselineCommandAdapters,
    BaselineCommandInput,
    BaselineCommandResult,
} from '../environment/application.js'

export type { BaselineCommandAdapters, BaselineCommandInput, BaselineCommandResult }

export const mechanism = {
    id: 'baseline-command',
    module: 'packages/cockpit/src/baseline/command.ts',
    exports: ['baselineCommand'],
} as const

export function baselineCommand(
    input: BaselineCommandInput,
    adapters: BaselineCommandAdapters,
): Promise<BaselineCommandResult> {
    return runBaselineRecord(input, adapters)
}
