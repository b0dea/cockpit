import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandSpelling } from './command-table.js'
import { runGuardCommand } from './cli-guard.js'
import type { CliHandlerOverrides, CliIo, CliRuntime } from './cli-main.js'

export type {
    CliHandlerOverrides, CliIo, CliRuntime, CommandHandlers, CommandOutcome, ComposeScaffoldRequest,
} from './cli-main.js'

// The shell guard runs this entry on every agent tool call, so a guard decision loads only its own
// modules; every other command loads the full CLI. Native Windows goes to the full CLI for its refusal.
export async function runCli(
    args: readonly string[],
    io: CliIo = process,
    handlerOverrides: CliHandlerOverrides = {},
    runtime: CliRuntime = {},
): Promise<number> {
    if (process.platform !== 'win32' && commandSpelling(args).name === 'guard-evaluate') {
        return runGuardCommand(commandSpelling(args).rest, io, runtime.env ?? process.env)
    }
    return (await import('./cli-main.js')).runCli(args, io, handlerOverrides, runtime)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await runCli(process.argv.slice(2))
}
