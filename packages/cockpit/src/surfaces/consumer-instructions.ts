// Owns: the opening section of the AGENTS.md / CLAUDE.md that `cockpit sync` writes into a
// consumer's cockpit: what the cockpit is, how to work in it, the rules and their reasons, and
// which skills exist. Must not: read files, invent values the configuration does not declare, or
// restate what a skill already says (it points at the skill instead).
// Hands off to: generated-application.ts, which supplies the facts, and render.ts, which places
// the text in the shared instruction region beside the testing-tier guide.
//
// Why it is short: this text loads into every agent session, and adherence falls as it grows.
// Every command is spelled through cockpitCommand so an agent can run it exactly as written.

import { cockpitCommand, type ConfiguredCommand } from '../fix-catalogue.js'

export interface ConsumerInstructionsInput {
    readonly name: string
    readonly configFile: string
    readonly siblings: readonly Readonly<{ dir: string; purpose: string; acquire: 'auto' | 'manual' | 'none' }>[]
    // False for a surfaces-only cockpit: stack commands would fail there, so they are not mentioned.
    readonly hasStack: boolean
    readonly guards: Readonly<{ declaredDatabaseHosts: readonly string[]; declaredVendorHosts: readonly string[]; pushRefusedBranches: readonly string[] }>
    readonly skills: readonly Readonly<{ name: string; description: string | undefined }>[]
}

const HOSTS_SHOWN = 5

const inline = (value: string) => value.replace(/\s+/g, ' ').replaceAll('`', "'").trim()
const cell = (value: string) => inline(value).replaceAll('|', '\\|')
const code = (value: string) => `\`${inline(value)}\``

function hosts(label: string, declared: readonly string[]): string {
    if (declared.length === 0) return `${label}: not declared`
    const shown = declared.slice(0, HOSTS_SHOWN).map(code).join(', ')
    return `${label}: ${shown}${declared.length > HOSTS_SHOWN ? ` and ${declared.length - HOSTS_SHOWN} more in \`[guards]\`` : ''}`
}

export function renderConsumerInstructions(input: ConsumerInstructionsInput): string {
    const run = (command: ConfiguredCommand, args?: string) => code(cockpitCommand(command, { config: input.configFile, ...(args === undefined ? {} : { args }) }))
    const acquire = { auto: `${run('setup')} clones it`, manual: 'a person clones it', none: 'already on disk' } as const
    const { declaredDatabaseHosts, declaredVendorHosts, pushRefusedBranches } = input.guards
    const noHosts = declaredDatabaseHosts.length + declaredVendorHosts.length === 0
    const lines: string[] = [
        '# What this is', '',
        `This is the ${code(input.name)} cockpit. It gives every agent the same instructions, skills and guards for the repositories below${input.hasStack ? ', and starts them against your working copies' : ''}.`,
        '',
        '| Directory | Purpose | How it reaches disk |', '| --- | --- | --- |',
        ...input.siblings.map(row => `| ${code(row.dir)} | ${cell(row.purpose)} | ${row.acquire}: ${acquire[row.acquire]} |`),
        '',
        '# How to work here', '',
    ]
    if (input.hasStack) lines.push(
        `- Run ${run('session', '-- <command>')} to start the stack, run the command against it and release the stack, so nothing is left holding ports; the command gets each leased port under its \`[ports.bases]\` name and each URL as \`COCKPIT_ENTRYPOINT_<NAME>\`. ${run('up')} and ${run('down')} do it by hand (down deletes containers); ${run('doctor')} explains a stack that will not start.`,
    )
    lines.push(
        `- Every cockpit command takes \`--config ${inline(input.configFile)}\`. After editing that file, run ${run('sync', '--dry-run')} to preview the generated files, ${run('sync')} to write them and ${run('check')} to confirm nothing drifted. Generated files are committed and compared byte for byte, so an unsynced edit fails review.`,
        '',
        '# Rules and why', '',
    )
    lines.push(
        `- Never touch a non-local environment. The guard denies commands that reach a declared non-local host (${hosts('database hosts', declaredDatabaseHosts)}; ${hosts('vendor endpoints', declaredVendorHosts)}). A local mistake is cheap; a production one is not.${noHosts ? ' With none declared the guard cannot recognise one, so ask before running anything that might reach a hosted service.' : ''}`,
    )
    if (pushRefusedBranches.length > 0) lines.push(
        `- Do not push to ${pushRefusedBranches.map(code).join(' or ')}. The guard refuses it, because those branches are shared and a bad push reaches everyone.`,
    )
    lines.push(
        `- Do not hand-edit generated files; edit ${code(input.configFile)} and sync. ${run('check')} reports a hand edit as drift and sync refuses to overwrite it; to recover, undo the edit (or delete a file cockpit wrote whole), then sync.`,
        '',
        '# Skills', '',
        ...input.skills.map(skill => `- ${code(skill.name)}: ${skill.description ? inline(skill.description) : 'not declared'}`),
    )
    return lines.join('\n') + '\n'
}
