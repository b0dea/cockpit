// Owns the canonical core declarations whose hashes bind consumer overlays to shipped surface
// bytes. Every renderer calls this same constructor, so none may independently reinterpret the
// skill collection or choose a different declaration shape.
import type { SurfaceDeclaration } from '../schema.js'
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

export function shippedSkillNames(assets: ReadonlyMap<string, CoreAsset>): readonly string[] | undefined {
    const bytes = assets.get('skills/collection.json')?.bytes
    if (bytes === undefined) return undefined
    const parsed = tryParseJson(bytes)
    const skills = parsed !== null && typeof parsed === 'object' ? (parsed as { skills?: unknown }).skills : undefined
    return Array.isArray(skills) && skills.every(name => typeof name === 'string')
        ? Object.freeze([...skills]) as readonly string[]
        : undefined
}

/** Each shipped skill's entry point and its own procedure, as neutral skill sources. */
export function shippedSkillSources(
    assets: ReadonlyMap<string, CoreAsset>,
): readonly Readonly<{ name: string; sources: readonly Readonly<{ path: string; bytes: string }>[] }>[] | undefined {
    const skills = shippedSkillNames(assets)
    if (!skills) return undefined
    const rows = skills.map(name => {
        const procedure = (CORE_SKILL_PROCEDURES as Readonly<Record<string, string>>)[name]
        const entry = assets.get(`skills/${name}.skill.md`)?.bytes
        const bytes = procedure === undefined ? undefined : assets.get(`skills/${procedure}`)?.bytes
        return entry === undefined || bytes === undefined ? undefined : Object.freeze({ name, sources: Object.freeze([
            Object.freeze({ path: `skills/${name}/SKILL.md`, bytes: entry }),
            Object.freeze({ path: `skills/${name}/${procedure}`, bytes }),
        ]) })
    })
    return rows.every(row => row !== undefined) ? Object.freeze(rows) : undefined
}

export function coreSurfaceDeclarations(
    assets: ReadonlyMap<string, CoreAsset>,
): readonly SurfaceDeclaration[] | undefined {
    const evaluator = assets.get(CORE_EVALUATOR_ASSET)?.bytes
    const skills = shippedSkillSources(assets)
    if (evaluator === undefined || !skills) return undefined
    const declarations: SurfaceDeclaration[] = [{
        name: 'evaluator', feature: 'subagents' as const, source: CORE_EVALUATOR_ASSET,
        sources: [{ path: 'subagents/evaluator.md', bytes: evaluator }],
    }, ...skills.map(({ name, sources }) => ({
        name, feature: 'skills' as const, source: `skills/${name}.skill.md`, sources: sources.map(source => ({ ...source })),
    }))]
    return Object.freeze(declarations)
}
