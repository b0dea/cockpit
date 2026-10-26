import { runLogs } from '../environment/application.js'
import type {
    LogsCommandAdapters,
    LogsCommandInput,
    LogsCommandResult,
} from '../environment/application.js'

export type { LogsCommandAdapters, LogsCommandInput, LogsCommandResult }

export const mechanism = {
    id: 'logs-command',
    module: 'packages/cockpit/src/logs/command.ts',
    exports: ['logsCommand'],
} as const

export function logsCommand(
    input: LogsCommandInput,
    adapters: LogsCommandAdapters,
): Promise<LogsCommandResult> {
    return runLogs(input, adapters)
}
