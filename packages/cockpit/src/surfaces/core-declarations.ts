// Owns the canonical core declarations whose hashes bind consumer overlays to shipped surface
// bytes. Every renderer calls this same constructor, so none may independently reinterpret the
// skill collection or choose a different declaration shape.
import type { SurfaceDeclaration } from '../schema.js'
import type { SurfaceTarget } from './contract.js'
import { GUARD_SURFACE_TARGETS } from './harness-registry.js'
import { tryParseJson } from '../environment/contract.js'

export const CORE_EVALUATOR_ASSET = 'agents/evaluator.agent.md' as const
// Each shipped skill installs only its own procedure; one shared copy per skill multiplied the whole
// procedure by the skill count in every tool's skills directory. The entry point's `procedure`
// field names the same file, and the skill contract refuses a mismatch.
export const CORE_SKILL_PROCEDURES = Object.freeze({
    'cockpit-setup': 'procedures/setup.md',
    'cockpit-explain': 'procedures/explain.md',
    'cockpit-fix': 'procedures/fix.md',
    'cockpit-work': 'procedures/work.md',
} as const)
export const CORE_PROCEDURE_ASSETS = Object.freeze([
    'skills/procedures/setup.md',
    'skills/procedures/explain.md',
    'skills/procedures/fix.md',
    'skills/procedures/work.md',
] as const)
export const CORE_SKILL_ASSETS = Object.freeze([
    'skills/collection.json',
    'skills/cockpit-setup.skill.md',
    'skills/cockpit-explain.skill.md',
    'skills/cockpit-fix.skill.md',
    'skills/cockpit-work.skill.md',
    ...CORE_PROCEDURE_ASSETS,
] as const)

type CoreAsset = Readonly<{ bytes: string }>

const TOOL_PLACEHOLDER = '{{tool-equivalence}}'
// The shell tool's name differs per harness, so an entry point names only the tools the cockpit
// actually renders for; a harness without a guard (no entry here) uses whichever shell it has.
const SHELL_TOOL: Readonly<Partial<Record<SurfaceTarget, string>>> = Object.freeze({
    claudecode: '`Bash` in Claude Code', codexcli: '`shell` in Codex CLI', opencode: '`bash` in OpenCode',
})

function toolEquivalenceLine(tools: readonly SurfaceTarget[]): string {
    // Listed in the harness registry's order, so the sentence does not depend on how `tools` is spelled.
    const names = GUARD_SURFACE_TARGETS.filter(target => tools.includes(target)).flatMap(target => SHELL_TOOL[target] ?? [])
    if (names.length === 0) return 'Use your shell tool.'
    const last = names.at(-1)!
    return `Use ${names.length === 1 ? last : `${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} or ${last}`}.`
}

function shippedSkillNames(assets: ReadonlyMap<string, CoreAsset>): readonly string[] | undefined {
    const bytes = assets.get('skills/collection.json')?.bytes
    if (bytes === undefined) return undefined
    const parsed = tryParseJson(bytes)
    const skills = parsed !== null && typeof parsed === 'object' ? (parsed as { skills?: unknown }).skills : undefined
    return Array.isArray(skills) && skills.every(name => typeof name === 'string')
        ? [...skills] as readonly string[]
        : undefined
}

/** Each shipped skill's entry point and its own procedure, as neutral skill sources. */
export function shippedSkillSources(
    assets: ReadonlyMap<string, CoreAsset>,
    tools: readonly SurfaceTarget[],
): readonly Readonly<{ name: string; sources: readonly Readonly<{ path: string; bytes: string }>[] }>[] | undefined {
    const skills = shippedSkillNames(assets)
    if (!skills) return undefined
    const rows = skills.map(name => {
        const procedure = (CORE_SKILL_PROCEDURES as Readonly<Record<string, string>>)[name]
        const entry = assets.get(`skills/${name}.skill.md`)?.bytes
        const bytes = procedure === undefined ? undefined : assets.get(`skills/${procedure}`)?.bytes
        return entry === undefined || bytes === undefined ? undefined : { name, sources: [
            { path: `skills/${name}/SKILL.md`, bytes: entry.replace(TOOL_PLACEHOLDER, toolEquivalenceLine(tools)) },
            { path: `skills/${name}/${procedure}`, bytes },
        ] }
    })
    return rows.every(row => row !== undefined) ? rows : undefined
}

/** The browser MCP server as the cockpit writes it for Claude Code, with its tool restriction if one is declared. */
export type EvaluatorBrowser = Readonly<{ name: string; allowedTools?: readonly string[] }>

// Claude Code 2.1.318 offered a subagent only the tools its `tools` front matter listed and refused a
// Write and a Bash call by name, while a control whose key was misspelled wrote and ran both (measured
// 2026-11-05). The evaluator gets file reads and exactly the browser tools this cockpit lets Claude Code
// call, so a grade keeps its browser and nothing else: `mcp__<server>` admits every tool of an
// unrestricted server, and Claude Code names a tool with a dot in it with an underscore instead.
export function evaluatorClaudeTools(browser: EvaluatorBrowser | undefined): readonly string[] {
    const browserTools = browser === undefined ? [] : browser.allowedTools === undefined ? [`mcp__${browser.name}`]
        : browser.allowedTools.map(tool => `mcp__${browser.name}__${tool.replaceAll('.', '_')}`)
    return ['Read', 'Grep', 'Glob', ...browserTools]
}

// Rulesync carries the `claudecode` section into Claude Code's agent front matter only.
function withClaudeTools(evaluator: string, claudeTools: readonly string[]): string | undefined {
    const end = evaluator.indexOf('\n---\n', 4)
    if (!evaluator.startsWith('---\n') || end < 0) return undefined
    return `${evaluator.slice(0, end)}\nclaudecode:\n  tools:\n${claudeTools.map(tool => `    - ${JSON.stringify(tool)}\n`).join('')}${evaluator.slice(end + 1)}`
}

export function coreSurfaceDeclarations(
    assets: ReadonlyMap<string, CoreAsset>,
    tools: readonly SurfaceTarget[],
    evaluatorBrowser?: EvaluatorBrowser,
): readonly SurfaceDeclaration[] | undefined {
    const shipped = assets.get(CORE_EVALUATOR_ASSET)?.bytes
    const evaluator = shipped === undefined ? undefined : withClaudeTools(shipped, evaluatorClaudeTools(evaluatorBrowser))
    const skills = shippedSkillSources(assets, tools)
    if (evaluator === undefined || !skills) return undefined
    const declarations: SurfaceDeclaration[] = [{
        name: 'evaluator', feature: 'subagents' as const, source: CORE_EVALUATOR_ASSET,
        sources: [{ path: 'subagents/evaluator.md', bytes: evaluator }],
    }, ...skills.map(({ name, sources }) => ({
        name, feature: 'skills' as const, source: `skills/${name}.skill.md`, sources: sources.map(source => ({ ...source })),
    }))]
    return declarations
}
