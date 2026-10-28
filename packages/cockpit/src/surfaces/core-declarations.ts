// Owns the canonical core declarations whose hashes bind consumer overlays to shipped surface
// bytes. Runtime rendering and release evidence must call this same constructor; neither may
// independently reinterpret the skill collection or choose a different declaration shape.
import type { SurfaceDeclaration } from '../schema.js'

export const mechanism = {
    id: 'core-surface-declarations',
    module: 'packages/cockpit/src/surfaces/core-declarations.ts',
    exports: ['CORE_EVALUATOR_ASSET', 'CORE_SKILL_ASSETS', 'CORE_SURFACE_ASSET_PATHS', 'shippedSkillNames', 'coreSurfaceDeclarations'],
} as const

export const CORE_EVALUATOR_ASSET = 'agents/evaluator.agent.md' as const
export const CORE_SKILL_ASSETS = Object.freeze([
    'skills/collection.json',
    'skills/cockpit-setup.skill.md',
    'skills/cockpit-explain.skill.md',
    'skills/cockpit-fix.skill.md',
    'skills/cockpit-work.skill.md',
    'skills/procedures/onboarding.md',
] as const)
export const CORE_SURFACE_ASSET_PATHS = Object.freeze([CORE_EVALUATOR_ASSET, ...CORE_SKILL_ASSETS] as const)

export type CoreSurfaceAssetPath = typeof CORE_SURFACE_ASSET_PATHS[number]
type CoreAsset = Readonly<{ bytes: string }>

export function shippedSkillNames(assets: ReadonlyMap<string, CoreAsset>): readonly string[] | undefined {
    const bytes = assets.get('skills/collection.json')?.bytes
    if (bytes === undefined) return undefined
    try {
        const skills = (JSON.parse(bytes) as { skills?: unknown }).skills
        return Array.isArray(skills) && skills.every(name => typeof name === 'string')
            ? Object.freeze([...skills]) as readonly string[]
            : undefined
    } catch { return undefined }
}

export function coreSurfaceDeclarations(
    assets: ReadonlyMap<string, CoreAsset>,
): readonly SurfaceDeclaration[] | undefined {
    const evaluator = assets.get(CORE_EVALUATOR_ASSET)?.bytes
    const procedure = assets.get('skills/procedures/onboarding.md')?.bytes
    const skills = shippedSkillNames(assets)
    if (evaluator === undefined || procedure === undefined || !skills) return undefined
    const entries = skills.map(name => [name, assets.get(`skills/${name}.skill.md`)?.bytes] as const)
    if (entries.some(([, bytes]) => bytes === undefined)) return undefined
    const declarations: SurfaceDeclaration[] = [{
        name: 'evaluator', feature: 'subagents' as const, source: CORE_EVALUATOR_ASSET,
        sources: [{ path: 'subagents/evaluator.md', bytes: evaluator }],
    }, ...entries.map(([name, bytes]) => ({
        name, feature: 'skills' as const, source: `skills/${name}.skill.md`,
        sources: [
            { path: `skills/${name}/SKILL.md`, bytes: bytes! },
            { path: `skills/${name}/procedures/onboarding.md`, bytes: procedure },
        ],
    }))]
    return Object.freeze(declarations)
}
