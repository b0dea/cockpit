// Owns: the opening section of the AGENTS.md / CLAUDE.md that `cockpit sync` writes into a
// consumer's cockpit: what the cockpit is, how to work in it, the rules and their reasons, and
// which skills exist. Must not: read files, invent values the configuration does not declare, or
// restate what a skill already says (it points at the skill instead).
// Hands off to: generated-application.ts, which supplies the facts, and render.ts, which places
// the text in the shared instruction region beside the testing-tier guide.
//
// Why it is short: this text loads into every agent session, and adherence falls as it grows.

export const mechanism = {
    id: 'consumer-instructions',
    module: 'packages/cockpit/src/surfaces/consumer-instructions.ts',
    exports: ['renderConsumerInstructions'],
} as const

export interface ConsumerInstructionsInput {
    readonly name: string
    readonly configFile: string
    readonly siblings: readonly Readonly<{ dir: string; purpose: string; acquire: 'auto' | 'manual' | 'none' }>[]
    // False for a surfaces-only cockpit: stack commands would fail there, so they are not mentioned.
    readonly hasStack: boolean
    readonly guards: Readonly<{ hostedDbHosts: readonly string[]; vendorEndpointHosts: readonly string[]; protectedBranches: readonly string[] }>
    readonly skills: readonly Readonly<{ name: string; description: string | undefined }>[]
}

const ACQUIRE = {
    auto: '`cockpit setup` clones it',
    manual: 'a person clones it',
    none: 'already on disk',
} as const
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
    const { hostedDbHosts, vendorEndpointHosts, protectedBranches } = input.guards
    const noHosts = hostedDbHosts.length + vendorEndpointHosts.length === 0
    const lines: string[] = [
        '# What this is', '',
        `This is the ${code(input.name)} cockpit. It gives every agent the same instructions, skills and guards for the repositories below${input.hasStack ? ', and starts them against your working copies' : ''}.`,
        '',
        '| Directory | Purpose | How it reaches disk |', '| --- | --- | --- |',
        ...input.siblings.map(row => `| ${code(row.dir)} | ${cell(row.purpose)} | ${row.acquire}: ${ACQUIRE[row.acquire]} |`),
        '',
        '# How to work here', '',
    ]
    if (input.hasStack) lines.push(
        `- Run \`cockpit session -- <command>\` to start the stack, run the command against it and release the stack, so nothing is left holding ports. \`cockpit up\` and \`cockpit down\` do it by hand; \`cockpit doctor\` explains a stack that will not start.`,
    )
    lines.push(
        `- Pass \`--config ${inline(input.configFile)}\` to every cockpit command. After editing that file, run \`cockpit sync --dry-run\` to preview the generated files, \`cockpit sync\` to write them and \`cockpit check\` to confirm nothing drifted. Generated files are committed and compared byte for byte, so an unsynced edit fails review.`,
        '',
        '# Rules and why', '',
    )
    lines.push(
        `- Never touch a non-local environment. The guard denies commands that reach a declared non-local host (${hosts('database hosts', hostedDbHosts)}; ${hosts('vendor endpoints', vendorEndpointHosts)}). A local mistake is cheap; a production one is not.${noHosts ? ' With none declared the guard cannot recognise one, so ask before running anything that might reach a hosted service.' : ''}`,
    )
    if (protectedBranches.length > 0) lines.push(
        `- Do not push to ${protectedBranches.map(code).join(' or ')}. The guard refuses it, because those branches are shared and a bad push reaches everyone.`,
    )
    lines.push(
        `- Do not hand-edit generated files; edit ${code(input.configFile)} and sync. Sync overwrites hand edits and \`cockpit check\` reports them as drift.`,
        '',
        '# Skills', '',
        ...input.skills.map(skill => `- ${code(skill.name)}: ${skill.description ? inline(skill.description) : 'not declared'}`),
    )
    return lines.join('\n') + '\n'
}
