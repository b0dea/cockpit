import { dirname, isAbsolute, normalize } from 'node:path'
import type { Diagnostic } from './environment/contract.js'

export const mechanism = {
    id: 'executable-remedy-catalogue',
    module: 'packages/cockpit/src/fix-catalogue.ts',
    exports: ['admitDiagnosticFix', 'formatShellCommand', 'cockpitCommand', 'initCommand', 'bindConfigPath'],
} as const

// A printed command has to run as printed. Every configured command refuses without --config, so a
// remedy written where the path is unknown names this placeholder, and bindConfigPath replaces it
// with the resolved path wherever the command line supplied one.
const CONFIG_PLACEHOLDER = '<your cockpit.toml>'
// runtime measure needs the opposite: it measures the context Docker itself selected and refuses an
// override, so a remedy printed to a shell that exports DOCKER_CONTEXT failed as printed.
const DAEMON_UNSET = 'env -u DOCKER_CONTEXT'

export type ConfiguredCommand = 'setup' | 'sync' | 'check' | 'selftest' | 'upgrade' | 'up' | 'sleep' | 'session' | 'down'
    | 'reset' | 'preflight' | 'doctor' | 'logs' | 'runtime measure' | 'sibling add' | 'sibling remove'

export interface FixContext {
    // Supplied by the command boundary from resolved configuration and its generated inventory,
    // never extracted from diagnostic prose or arbitrary result data.
    readonly resolvedConfigPath: string | null
    readonly generatedTargets: readonly string[]
}

export interface ExecutableFix {
    // npx resolves the project's own cockpit bin; a dev-dependency install puts no `cockpit` on PATH.
    readonly argv: readonly ['npx', '--no', 'cockpit', 'sync', '--config', string]
    readonly command: string
}

const unsafeControl = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/
const plainShellArgument = /^[A-Za-z0-9_@%+=:,./-]+$/

export function formatShellCommand(argv: readonly string[]): string {
    return argv.map((argument) => plainShellArgument.test(argument)
        ? argument
        : `'${argument.replaceAll("'", "'\"'\"'")}'`).join(' ')
}

/**
 * The runnable spelling of a cockpit command. `operand` (a sibling slug) precedes --config as in
 * the command's usage line; `args` follows it as written, so it may hold `<placeholders>`.
 */
export function cockpitCommand(command: ConfiguredCommand,
    options: Readonly<{ config?: string; operand?: string; args?: string }> = {}): string {
    const config = options.config === undefined ? CONFIG_PLACEHOLDER : formatShellCommand([options.config])
    const daemon = command === 'runtime measure' ? `${DAEMON_UNSET} ` : ''
    const operand = options.operand === undefined ? '' : ` ${formatShellCommand([options.operand])}`
    return `${daemon}npx --no cockpit ${command}${operand} --config ${config}${options.args === undefined ? '' : ` ${options.args}`}`
}

/**
 * The runnable spelling of init, which takes its root operand and --target instead of --config.
 * A root or target the producer does not know prints as a placeholder for the reader to fill in.
 */
export function initCommand(options: Readonly<{ root?: string; target?: string; args?: string }> = {}): string {
    const root = options.root === undefined ? '<cockpit root>' : formatShellCommand([options.root])
    const target = options.target === undefined ? '<target>' : formatShellCommand([options.target])
    return `npx --no cockpit init ${root} --target ${target}${options.args === undefined ? '' : ` ${options.args}`}`
}

function bindablePath(path: string | null | undefined): path is string {
    return typeof path === 'string' && isAbsolute(path) && normalize(path) === path && dirname(path) !== path
        && !unsafeControl.test(path)
}

/** Replaces the configuration placeholder in printed text with the resolved path, shell-quoted. */
export function bindConfigPath(text: string, context?: FixContext): string {
    const path = context?.resolvedConfigPath
    return bindablePath(path) ? text.replaceAll(`--config ${CONFIG_PLACEHOLDER}`, `--config ${formatShellCommand([path])}`) : text
}

function safeTarget(target: string): boolean {
    return !unsafeControl.test(target) && !target.includes('\\') && !target.includes(':')
        && target.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

// The one remedy the catalogue executes. Producers keep it as a string literal so the diagnostic
// inventory captures it beside its code; the catalogue admits only this exact spelling.
const GENERATED_DRIFT_FIX = `run ${cockpitCommand('sync')}`

export function admitDiagnosticFix(diagnostic: Diagnostic, context?: FixContext): ExecutableFix | undefined {
    if (diagnostic.severity !== 'error' || diagnostic.code !== 'GENERATED_ARTIFACT_DRIFT'
        || diagnostic.fix !== GENERATED_DRIFT_FIX || !diagnostic.target || !context) return undefined
    const path = context.resolvedConfigPath
    if (!bindablePath(path) || !safeTarget(diagnostic.target)
        || !context.generatedTargets.includes(diagnostic.target)) return undefined
    const argv = Object.freeze(['npx', '--no', 'cockpit', 'sync', '--config', path] as const)
    const command = formatShellCommand(argv)
    return Object.freeze({ argv, command })
}
