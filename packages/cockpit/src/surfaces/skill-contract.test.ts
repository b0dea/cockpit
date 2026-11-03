import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { effectivePolicy } from '../autonomy.js'
import { runCli } from '../cli.js'
import { Autonomy, Work } from '../schema.js'
import { commands } from '../command-table.js'

import { SURFACE_TARGETS, type SurfaceTarget } from './contract.js'
import { generateSurfaceBatch } from './generator-adapter.js'
import { extendInspectedSkillStandingCosts, inspectRenderedSkillSet, inspectSkillSet, projectInspectedSkillOutputs } from './skill-contract.js'

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../surfaces/skills')
const generousCaps: Record<SurfaceTarget, number> = {
    claudecode: 8_192, codexcli: 8_192, opencode: 8_192, cursor: 8_192, grokcli: 8_192,
}
const PROCEDURES: Readonly<Record<string, string>> = {
    'cockpit-setup': 'procedures/setup.md', 'cockpit-explain': 'procedures/explain.md',
    'cockpit-fix': 'procedures/fix.md', 'cockpit-work': 'procedures/work.md',
}
const procedureAssets = await Promise.all(Object.values(PROCEDURES).map(async path =>
    ({ path: `skills/${path}`, bytes: await readFile(join(surfaceRoot, path), 'utf8') })))

function authenticated(source: { path: string; bytes: string }) {
    return { ...source, sha256: createHash('sha256').update(source.bytes).digest('hex') }
}

async function shippedSources() {
    return Promise.all(Object.entries(PROCEDURES).flatMap(([name, procedure]) => [
        readFile(join(surfaceRoot, `${name}.skill.md`), 'utf8').then(bytes => ({ path: `skills/${name}/SKILL.md`, bytes })),
        readFile(join(surfaceRoot, procedure), 'utf8').then(bytes => ({ path: `skills/${name}/${procedure}`, bytes })),
    ]))
}

function input(sources: readonly { path: string; bytes: string }[], standingCostCaps = generousCaps) {
    return { sources, collection: authenticated({ path: 'skills/collection.json', bytes: JSON.stringify({
        skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: standingCostCaps,
    }) }), procedures: procedureAssets.map(authenticated) }
}

function changeEntry(
    sources: readonly { path: string; bytes: string }[],
    transform: (bytes: string) => string,
) {
    return sources.map(source => source.path === 'skills/cockpit-setup/SKILL.md'
        ? { ...source, bytes: transform(source.bytes) }
        : source)
}

function additionalSkill(target: SurfaceTarget, bytes: string) {
    const prefix: Record<SurfaceTarget, string> = {
        claudecode: '.claude', codexcli: '.agents', opencode: '.opencode', cursor: '.cursor', grokcli: '.grok',
    }
    return { target, ...authenticated({ path: `${prefix[target]}/skills/cockpit-browser/SKILL.md`, bytes }) }
}

describe('shipped skill contract', () => {
    it('admits only the exact union of shipped skills and explicitly declared extensions', async () => {
        const shipped = await shippedSources()
        const extension = shipped.filter(source => source.path.startsWith('skills/cockpit-setup/')).map(source => ({
            path: source.path.replace('skills/cockpit-setup/', 'skills/inspect/').replace('procedures/setup.md', 'procedures/inspect.md'),
            bytes: source.path.endsWith('/SKILL.md')
                ? source.bytes.replace('name: cockpit-setup', 'name: inspect').replace('procedures/setup.md', 'procedures/inspect.md')
                : '---\nloading: pull\nbudget: uncapped\n---\n\nInspect the product-owned verification target.\n',
        }))
        const captured = input([...shipped, ...extension])
        const admitted = await inspectSkillSet({ ...captured, declaredExtensions: ['inspect'] })
        expect(admitted).toMatchObject({ kind: 'complete', skills: ['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work', 'inspect'],
            collection: { source: { sha256: captured.collection.sha256 }, skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'],
                metric: 'frontmatter_bytes', caps: generousCaps } })
        if (admitted.kind !== 'complete') throw new Error('Declared skill extension refused')
        expect(admitted.collection.entrypoints).toContainEqual(expect.objectContaining({
            path: 'skills/inspect/SKILL.md', displacement: 'skills/inspect/procedures/inspect.md' }))
        expect(admitted.files.filter(file => file.path.endsWith('/SKILL.md'))).toHaveLength(25)
        const paths = captured.sources.map(source => source.path.slice('skills/'.length))
        const generated = await generateSurfaceBatch({ targets: SURFACE_TARGETS, features: ['skills'], sources: captured.sources,
            expectedOutputs: {
                claudecode: paths.map(path => `.claude/skills/${path}`),
                codexcli: paths.flatMap(path => [`.agents/skills/${path}`,
                    ...(path.endsWith('/SKILL.md') ? [`.agents/skills/${path.slice(0, -'SKILL.md'.length)}agents/openai.yaml`] : [])]),
                opencode: paths.map(path => `.opencode/skills/${path}`),
                cursor: paths.map(path => `.cursor/skills/${path}`),
                grokcli: paths.map(path => `.grok/skills/${path}`),
            } })
        expect(await inspectRenderedSkillSet({ ...captured, declaredExtensions: ['inspect'], generated, targets: SURFACE_TARGETS }))
            .toMatchObject({ kind: 'complete', skills: admitted.skills })
        for (const bytes of ['', '---\nloading: eager\nbudget: uncapped\n---\nInspect.\n',
            '---\nloading: pull\nbudget: uncapped\n---\n']) {
            expect(await inspectSkillSet({ ...captured, declaredExtensions: ['inspect'],
                sources: captured.sources.map(source => source.path === 'skills/inspect/procedures/inspect.md'
                    ? { ...source, bytes } : source) })).toMatchObject({ kind: 'refusal' })
        }
        expect(await inspectSkillSet(captured)).toMatchObject({ kind: 'refusal' })
        expect(await inspectSkillSet({ ...input(shipped), declaredExtensions: ['inspect'] })).toMatchObject({ kind: 'refusal' })
        expect(await inspectRenderedSkillSet({ ...captured, generated, targets: SURFACE_TARGETS })).toMatchObject({ kind: 'refusal' })
    })

    it.each([null, 'inspect', ['inspect', 'inspect'], ['zeta', 'alpha'], ['cockpit-setup'], ['bad/name'],
        ['a'.repeat(129)], Array.from({ length: 257 }, (_, index) => `skill-${index}`)])(
        'refuses malformed extension declarations: %j', async declaredExtensions => {
            expect(await inspectSkillSet({ ...input(await shippedSources()), declaredExtensions })).toMatchObject({ kind: 'refusal' })
        },
    )

    it('refuses an undeclared source under a genuine admitted skill root', async () => {
        const sources = [...await shippedSources(), { path: 'skills/cockpit-setup/extra.md', bytes: 'undeclared' }]
        await expect(inspectSkillSet(input(sources))).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_INPUT_INVALID' }], files: [],
        })
    })

    it('refuses unauthenticated collection authority before invoking generation', async () => {
        const sources = await shippedSources()
        await expect(inspectSkillSet({ sources, standingCostCaps: generousCaps })).resolves.toMatchObject({ kind: 'refusal' })
        const captured = input(sources)
        await expect(inspectSkillSet({ ...captured, collection: { ...captured.collection, sha256: '0'.repeat(64) } }))
            .resolves.toMatchObject({ kind: 'refusal' })
    })

    it.each([
        ['malformed', '{'],
        ['extra key', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: generousCaps, extra: true })],
        ['wrong metric', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'bytes', caps: generousCaps })],
        ['incomplete target', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: { claudecode: 8192, codexcli: 8192 } })],
        ['over ceiling', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: { ...generousCaps, codexcli: 65537 } })],
        ['wrong inventory', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-fix'], metric: 'frontmatter_bytes', caps: generousCaps })],
        ['duplicate key', '{"skills":["cockpit-setup","cockpit-explain","cockpit-fix","cockpit-work"],"metric":"bytes","metric":"frontmatter_bytes","caps":{"claudecode":8192,"codexcli":8192,"opencode":8192}}'],
    ])('refuses collection declaration: %s', async (_label, bytes) => {
        const captured = input(await shippedSources())
        await expect(inspectSkillSet({ ...captured, collection: authenticated({ path: captured.collection.path, bytes }) }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_INPUT_INVALID' }] })
    })

    const setupProcedure = procedureAssets[0]!
    it.each([
        ['absent', setupProcedure.path, ''], ['push', setupProcedure.path, setupProcedure.bytes.replace('loading: pull', 'loading: push')],
        ['capped', setupProcedure.path, setupProcedure.bytes.replace('budget: uncapped', 'budget: 8192')],
        ['implicit', setupProcedure.path, setupProcedure.bytes.replace('budget: uncapped\n', '')],
        ['outside the procedures directory', 'skills/setup.md', setupProcedure.bytes],
    ])('refuses packaged procedure metadata: %s', async (_label, path, bytes) => {
        const captured = input(await shippedSources())
        await expect(inspectSkillSet({ ...captured, procedures: [authenticated({ path, bytes }), ...captured.procedures.slice(1)] }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_INPUT_INVALID' }] })
    })

    it('binds the shipped declaration digest, exact inventory, entrypoint caps and each skill to its own pulled procedure', async () => {
        const sources = await shippedSources()
        const bytes = await readFile(join(surfaceRoot, 'collection.json'), 'utf8')
        const captured = input(sources)
        const result = await inspectSkillSet({ ...captured, collection: authenticated({ path: 'skills/collection.json', bytes }) })
        expect(result.kind, JSON.stringify(result)).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.collection).toMatchObject({ source: { path: 'skills/collection.json', sha256: authenticated({ path: 'skills/collection.json', bytes }).sha256 },
            metric: 'frontmatter_bytes', caps: generousCaps,
            procedures: procedureAssets.map(asset => ({ path: asset.path, sha256: authenticated(asset).sha256, loading: 'pull', budget: 'uncapped' })) })
        expect(result.collection.entrypoints).toEqual(['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'].map(name => ({
            path: `skills/${name}/SKILL.md`, cap: ({ 'cockpit-setup': 12, 'cockpit-explain': 12, 'cockpit-fix': 15, 'cockpit-work': 11 } as Record<string, number>)[name]!, metric: 'lines', displacement: `skills/${PROCEDURES[name]}`,
        })))
        expect(SURFACE_TARGETS.map(target => result.files.filter(file => file.target === target).length)).toEqual([8, 12, 8, 8, 8])
        expect(result.files.some(file => file.path.includes('collection'))).toBe(false)
        for (const changed of [sources.filter(source => !source.path.includes('/cockpit-fix/')),
            sources.filter(source => source.path !== 'skills/cockpit-setup/procedures/setup.md'),
            sources.map(source => source.path === 'skills/cockpit-setup/procedures/setup.md' ? { ...source, bytes: source.bytes + 'changed' } : source),
            changeEntry(sources, value => value.replace('procedure: procedures/setup.md', 'procedure: procedures/elsewhere.md')),
            // Another skill's procedure is not this skill's, even byte for byte.
            sources.map(source => source.path === 'skills/cockpit-setup/procedures/setup.md'
                ? { ...source, bytes: sources.find(row => row.path === 'skills/cockpit-fix/procedures/fix.md')!.bytes } : source)]) {
            await expect(inspectSkillSet(input(changed))).resolves.toMatchObject({ kind: 'refusal' })
        }
    })

    it('refuses aliased frontmatter before converting YAML data', async () => {
        const sources = changeEntry(await shippedSources(), bytes => bytes.replace(
            'name: cockpit-setup\n', 'name: &skill cockpit-setup\nalias: *skill\n',
        ))
        await expect(inspectSkillSet(input(sources))).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_FRONTMATTER_INVALID', target: 'skills/cockpit-setup/SKILL.md' }],
        })
    })

    it('renders a representative bootstrap skill through every native harness spelling', async () => {
        const result = await inspectSkillSet(input(await shippedSources()))

        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.skills).toEqual(['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'])
        expect(result.costs.map(cost => [cost.target, cost.status])).toEqual(SURFACE_TARGETS.map(target => [target, 'within_cap']))
        for (const [target, path, tool] of [
            ['claudecode', '.claude/skills/cockpit-setup/SKILL.md', 'Bash'],
            ['codexcli', '.agents/skills/cockpit-setup/SKILL.md', 'shell'],
            ['opencode', '.opencode/skills/cockpit-setup/SKILL.md', 'bash'],
        ] as const) {
            const rendered = result.files.find(file => file.target === target && file.path === path)
            expect(rendered?.bytes).toContain('name: cockpit-setup')
            expect(rendered?.bytes).toContain(`\`${tool}\``)
        }
        expect(result.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: 'codexcli', path: '.agents/skills/cockpit-setup/agents/openai.yaml' }),
            expect.objectContaining({ target: 'claudecode', path: '.claude/skills/cockpit-setup/procedures/setup.md' }),
            expect.objectContaining({ target: 'opencode', path: '.opencode/skills/cockpit-setup/procedures/setup.md' }),
        ]))
    }, 120_000)

    it('projects inspected bootstrap outputs for exactly one selected target', async () => {
        const result = await inspectSkillSet(input(await shippedSources()))
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return

        const projections = SURFACE_TARGETS.map(target => projectInspectedSkillOutputs(result, target, 'cockpit-setup'))
        expect(projections.map(projection => projection.kind === 'complete' ? projection.files.length : 0)).toEqual([2, 3, 2, 2, 2])
        expect(projections.flatMap(projection => projection.kind === 'complete' ? projection.files : [])
            .every(file => !file.bytes.includes('cockpit:verified'))).toBe(true)
        expect(projections[1]).toMatchObject({ kind: 'complete', target: 'codexcli', skill: 'cockpit-setup', files: [
            { path: '.agents/skills/cockpit-setup/SKILL.md' },
            { path: '.agents/skills/cockpit-setup/agents/openai.yaml' },
            { path: '.agents/skills/cockpit-setup/procedures/setup.md' },
        ] })
        expect(projectInspectedSkillOutputs({ ...result }, 'codexcli', 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
        expect(projectInspectedSkillOutputs(result, 'codexcli', 'explain' as 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
    }, 120_000)

    it('ships a direct fix procedure that proves the change with the declared gate and needs no work order', async () => {
        const result = await inspectSkillSet(input(await shippedSources()))
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error('Shipped preparation workflow was refused')
        for (const target of SURFACE_TARGETS) {
            const procedure = result.files.find(file => file.target === target && file.path.endsWith('/cockpit-fix/procedures/fix.md'))
            expect(procedure, target).toBeDefined()
            const fix = procedure!.bytes.slice(procedure!.bytes.indexOf('## Fix\n')).replace(/\s+/g, ' ')
            // A one-line fix that had to pass intake and a source audit first sent an agent into the
            // work-order lane; only work someone else certifies belongs there.
            expect(fix).not.toContain('work intake')
            expect(fix).toContain('It needs no intake, draft, source audit or work-order file')
            expect(fix).toContain('Use the cockpit-work skill instead when someone else must certify the result')
            const before = fix.indexOf('cockpit test-run --config cockpit.toml --gate')
            const edit = fix.indexOf('Then change the repository that owns the defect')
            expect(before).toBeGreaterThan(-1)
            expect(edit).toBeGreaterThan(before)
            expect(fix).toContain('before you edit')
            expect(fix).toContain('simplify it, then review it independently')
        }
    }, 120_000)

    it('admits the complete shipped set, preserves procedure goldens, and measures each rendered installed manifest', async () => {
        const sources = await shippedSources()

        const result = await inspectSkillSet(input(sources))

        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.skills).toEqual(['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'])
        expect(result.costs).toHaveLength(SURFACE_TARGETS.length)
        expect(new Set(result.costs.map(cost => cost.value)).size).toBeGreaterThan(1)
        expect(result.costs.every(cost => cost.metric === 'frontmatter_bytes' && cost.value > 0 && cost.value <= cost.cap)).toBe(true)
        const browserBytes = (await readFile(join(surfaceRoot, 'cockpit-browser.skill.md'), 'utf8'))
            .replace('{{browser}}', 'Use the authenticated browser transport.')
        const browserFiles = (['claudecode', 'codexcli', 'opencode'] as const).map(target => additionalSkill(target, browserBytes))
        const extended = extendInspectedSkillStandingCosts(result, browserFiles)
        expect(extended).toMatchObject({
            kind: 'complete',
            skills: ['cockpit-browser', 'cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'],
            costs: result.costs.map(cost => ({
                ...cost,
                value: cost.value + (['claudecode', 'codexcli', 'opencode'].includes(cost.target) ? 216 : 0),
            })),
            inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
        expect(extendInspectedSkillStandingCosts({ ...result }, browserFiles)).toMatchObject({ kind: 'refusal' })
        expect(extendInspectedSkillStandingCosts(result, [{ ...browserFiles[0]!, sha256: '0'.repeat(64) }]))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVALID' }] })
        expect(extendInspectedSkillStandingCosts(result, [browserFiles[0]!, browserFiles[0]!]))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVALID' }] })
        expect(extendInspectedSkillStandingCosts(result, [{ ...browserFiles[0]!,
            bytes: browserFiles[0]!.bytes.replace('name: cockpit-browser', 'name: wrong-name'),
            sha256: createHash('sha256').update(browserFiles[0]!.bytes.replace('name: cockpit-browser', 'name: wrong-name')).digest('hex'),
        }])).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVALID' }] })
        expect(extendInspectedSkillStandingCosts(result, [result.files.find(file => file.path.endsWith('/cockpit-setup/SKILL.md'))!]))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_NAME_DUPLICATE' }] })
        // Each skill installs only its own procedure, byte for byte; none carries another's sections.
        const renderedProcedures = result.files.filter(file => /\/procedures\/[^/]+\.md$/.test(file.path))
        expect(renderedProcedures).toHaveLength(SURFACE_TARGETS.length * 4)
        for (const file of renderedProcedures) {
            const [, skill, procedure] = /\/skills\/([^/]+)\/(procedures\/[^/]+\.md)$/.exec(file.path)!
            expect(procedure, file.path).toBe(PROCEDURES[skill!])
            expect(file.bytes, file.path).toBe(sources.find(source => source.path === `skills/${skill}/${procedure}`)!.bytes)
        }
        const section = (name: string) => procedureAssets.filter(asset => asset.bytes.includes(`\n## ${name}\n`)).map(asset => asset.path)
        expect(section('Bootstrap')).toEqual(['skills/procedures/setup.md'])
        expect(section('Secret handling')).toEqual(['skills/procedures/setup.md'])
        expect(section('Fix')).toEqual(['skills/procedures/fix.md'])
        expect(section('Work')).toEqual(['skills/procedures/work.md'])
        for (const path of ['skills/procedures/explain.md', 'skills/procedures/fix.md']) {
            expect(procedureAssets.find(asset => asset.path === path)!.bytes, path).toContain('`../../cockpit-setup/procedures/setup.md`')
        }
        const body = procedureAssets.map(asset => asset.bytes).join('\n').replace(/\s+/g, ' ')
        expect(body).not.toContain('## Authenticated testing')
        expect(body).toContain('After accepted initialization')
        expect(body).toContain('references/test-data-and-personas.md')
        expect(body).toContain('Bootstrap does not discover provider identities or create browser state')
        expect(body).toContain('Relay that question to the human')
        expect(body).toContain('INIT_COCKPIT_ROOT_REQUIRED')
        expect(body).toContain('## After upgrading cockpit')
        expect(body).toContain('OVERRIDDEN_CORE_CHANGED')
        expect(body).toContain('lines starting `Upgrade:`')
        expect(body).toContain('If a second person must certify this, use cockpit-work instead.')
        expect(body).toContain('Is this a work order?')
        expect(body).toContain('Never type the digest yourself.')
        expect(body).toContain('cockpit work accept --config cockpit.toml --work-order WO-001')
        expect(body).toContain('## On drift')
        expect(body).toContain('commit it together with the guide change')
        expect(body).toContain('cockpit test-run --config cockpit.toml --gate declared-gate-id')
        const work = body.slice(body.indexOf('## Work'))
        expect(work).toContain('as the *Write a work order* section of `./node_modules/@b00dea/cockpit/docs/work-and-browser.md` shows')
        expect(work).toContain('reuse the planning skills the harness already has')
        expect(work).not.toContain("Run the harness's installed brainstorming and planning skills")
        const installedReview = work.indexOf("Run the harness's installed simplification and code-review skills")
        expect(installedReview).toBeGreaterThan(-1)
        expect(work.indexOf('cockpit work grade')).toBeGreaterThan(installedReview)
        expect(body).toContain('npm install --save-dev --save-exact @b00dea/cockpit@<version>')
        expect(body).not.toContain('`npm update` moves the pinned')
        expect(body).toContain('cockpit sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json')
        expect(body).toContain('cockpit sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json')
        expect(body).toContain('cockpit sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json')
        expect(body).toContain('Show the human the proposed sibling declaration before invoking the command')
        expect(body).toContain('The command writes cockpit.toml immediately; `--json` changes only its output format')
        expect(body).toContain('a human runs `./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal')
        expect(body).not.toContain('--gate unit')
        expect(body).not.toContain('`work accept --interactive`')
        const explain = result.files.find(file => file.target === 'codexcli' && file.path === '.agents/skills/cockpit-explain/SKILL.md')
        const fix = result.files.find(file => file.target === 'opencode' && file.path === '.opencode/skills/cockpit-fix/SKILL.md')
        const setup = result.files.find(file => file.target === 'codexcli' && file.path === '.agents/skills/cockpit-setup/SKILL.md')
        expect(setup?.bytes).toContain('references/test-data-and-personas.md')
        expect(setup?.bytes).toContain('adopt-cockpit')
        const exactInstall = setup?.bytes.indexOf('npm install --save-dev --save-exact @b00dea/cockpit@<version>') ?? -1
        const humanSync = setup?.bytes.indexOf('ask a human to run `npx --no cockpit sync --config cockpit.toml --interactive`') ?? -1
        expect(exactInstall).toBeGreaterThan(-1)
        expect(humanSync).toBeGreaterThan(exactInstall)
        expect(explain?.bytes).toContain('This skill changes nothing.')
        expect(fix?.bytes).toContain('direct-fix door')
        expect(fix?.bytes).toContain('does not scaffold a cockpit')
    }, 120_000)

    it('inspects the skill inventory from one genuine combined generator result', async () => {
        const sources = await shippedSources()
        const combinedSources = [{ path: 'rules/shared.md', bytes: '---\nroot: true\ntargets: ["*"]\n---\nShared rule.\n' }, ...sources]
        const skillPaths = sources.map(source => source.path.slice('skills/'.length))
        const generated = await generateSurfaceBatch({
            targets: SURFACE_TARGETS,
            features: ['rules', 'skills'],
            sources: combinedSources,
            expectedOutputs: {
                claudecode: ['CLAUDE.md', ...skillPaths.map(path => `.claude/skills/${path}`)],
                codexcli: ['AGENTS.md', ...skillPaths.flatMap(path => [`.agents/skills/${path}`,
                    ...(path.endsWith('/SKILL.md') ? [`.agents/skills/${path.slice(0, -'SKILL.md'.length)}agents/openai.yaml`] : [])])],
                opencode: ['AGENTS.md', ...skillPaths.map(path => `.opencode/skills/${path}`)],
                cursor: ['.cursor/rules/shared.mdc', ...skillPaths.map(path => `.cursor/skills/${path}`)],
                grokcli: ['AGENTS.md', ...skillPaths.map(path => `.grok/skills/${path}`)],
            },
        })
        expect(generated.kind, JSON.stringify(generated)).toBe('complete')
        if (generated.kind !== 'complete') return

        const result = await inspectRenderedSkillSet({ ...input(sources), generated, targets: SURFACE_TARGETS })

        expect(result).toMatchObject({ kind: 'complete', skills: ['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'] })
        if (result.kind !== 'complete') return
        expect(result.files.some(file => file.path === 'CLAUDE.md')).toBe(true)
        expect(result.files.filter(file => file.path.includes('/skills/'))).toHaveLength(44)

        const missingSidecar = { ...generated, files: generated.files.filter(file =>
            file.path !== '.agents/skills/cockpit-setup/agents/openai.yaml') }
        await expect(inspectRenderedSkillSet({ ...input(sources), generated: missingSidecar, targets: SURFACE_TARGETS })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVENTORY_INVALID', target: 'codexcli' }],
        })
        // Skills rendered for a tool cockpit.toml does not list are refused, not published beside the listed ones.
        await expect(inspectRenderedSkillSet({ ...input(sources), generated, targets: ['claudecode'] })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVENTORY_INVALID' }],
        })
    }, 120_000)

    it.each([
        ['missing name', (bytes: string) => bytes.replace('name: cockpit-setup\n', '')],
        ['duplicate name', (bytes: string) => bytes.replace('name: cockpit-setup\n', 'name: cockpit-setup\nname: duplicate\n')],
        ['missing tools', (bytes: string) => bytes.replace('  tools: [shell]\n', '')],
        ['missing tool equivalence', (bytes: string) => bytes.replace('    codexcli: [shell]\n', '    codexcli: []\n')],
        ['undeclared native tool', (bytes: string) => bytes.replace('  allowed-tools: [Bash]\n', '  allowed-tools: [Bash, Write]\n')],
        ['missing changes', (bytes: string) => bytes.replace('  changes: [cockpit configuration and generated harness surfaces after preview]\n', '')],
        ['missing non-goals', (bytes: string) => bytes.replace('  non-goals: [parsing registries, deciding environment policy, claiming an unproved installation]\n', '')],
        ['missing procedure', (bytes: string) => bytes.replace('  procedure: procedures/setup.md\n', '')],
        ['missing review metadata', (bytes: string) => bytes.replace('  review: { mechanical: cockpit-skill-contract, judgment: pending }\n', '')],
        ['numbered inline procedure', (bytes: string) => `${bytes}1. Parse inputs\n`],
        ['fenced inline procedure', (bytes: string) => `${bytes}\`\`\`sh\ncockpit check\n\`\`\`\n`],
        ['copied registry logic', (bytes: string) => `${bytes}Parse the registry before continuing.\n`],
        ['copied policy table', (bytes: string) => `${bytes}| Tier | Verdict |\n| --- | --- |\n`],
        ['misspelled command identifier', (bytes: string) => bytes.replace('commands: [init,', 'commands: [innit,')],
        ['absent command identifier', (bytes: string) => bytes.replace('  commands: [init, setup, sync, check, doctor, up, preflight, upgrade, sibling, tool]\n', '')],
        ['stale command identifier', (bytes: string) => bytes.replace('commands: [init,', 'commands: [bootstrap,')],
        ['unadmitted command identifier', (bytes: string) => bytes.replace('commands: [init,', 'commands: [publish,')],
        ['undeclared command', (bytes: string) => `${bytes}Run \`cockpit invent\`.\n`],
        ['misleading completion', (bytes: string) => `${bytes}Report complete without proof.\n`],
        ['excess entry-point cap', (bytes: string) => bytes.replace('  entry-point-lines: 12\n', '  entry-point-lines: 1\n')],
    ])('refuses hostile entry point: %s', async (_label, transform) => {
        const sources = await shippedSources()
        const result = await inspectSkillSet(input(changeEntry(sources, transform)))

        expect(result.kind).toBe('refusal')
        expect(result.status).toBe(2)
    })

    it('fails the rendered harness whose base or conditional skill exceeds the shared installed-set cap', async () => {
        const sources = await shippedSources()
        const accepted = await inspectSkillSet(input(sources))
        expect(accepted.kind).toBe('complete')
        if (accepted.kind !== 'complete') return
        const largest = accepted.costs.reduce((left, right) => left.value >= right.value ? left : right)
        const neutralDescriptionBytes = sources.filter(source => source.path.endsWith('/SKILL.md')).reduce((sum, source) => {
            const match = /^description: "([^"]+)"$/m.exec(source.bytes)
            return sum + Buffer.byteLength(match?.[1] ?? '')
        }, 0)
        expect(largest.value).toBeGreaterThan(neutralDescriptionBytes)
        const baseRefusal = await inspectSkillSet(input(sources, { ...generousCaps, [largest.target]: largest.value - 1 }))
        expect(baseRefusal).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: 'SKILL_STANDING_COST_EXCEEDED', target: largest.target }],
        })

        const claudecode = accepted.costs.find(cost => cost.target === 'claudecode')!
        const caps = { ...generousCaps, claudecode: claudecode.value + 215 }
        const bounded = await inspectSkillSet(input(sources, caps))
        expect(bounded.kind).toBe('complete')
        if (bounded.kind !== 'complete') return
        const browserBytes = (await readFile(join(surfaceRoot, 'cockpit-browser.skill.md'), 'utf8'))
            .replace('{{browser}}', 'Use the authenticated browser transport.')
        const refused = extendInspectedSkillStandingCosts(bounded, [additionalSkill('claudecode', browserBytes)])

        expect(refused).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: 'SKILL_STANDING_COST_EXCEEDED', target: 'claudecode' }],
        })
    }, 240_000)
})


describe('shipped skill descriptions', () => {
    it('lead with the trigger, carry the cockpit- prefix and stay inside the shared standing-cost budget with the browser skill', async () => {
        const names = ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work', 'cockpit-browser']
        let total = 0
        for (const name of names) {
            const bytes = await readFile(join(surfaceRoot, `${name}.skill.md`), 'utf8')
            expect(bytes).toMatch(new RegExp(`^---\\nname: ${name}\\n`))
            const description = /^description: "([^"]+)"$/m.exec(bytes)?.[1] ?? ''
            expect(description.startsWith('Use when '), name).toBe(true)
            total += Buffer.byteLength(description)
        }
        const browser = await readFile(join(surfaceRoot, 'cockpit-browser.skill.md'), 'utf8')
        expect(browser).toContain('cockpit browser drive --config cockpit.toml --json')
        expect(browser).toContain('cockpit browser screenshot --config cockpit.toml --json')
        // Rendered frontmatter adds per-harness keys; the neutral descriptions alone must leave room for them.
        expect(total).toBeLessThan(8192 / 4)
    })
})

describe('shipped procedure commands', () => {
    it('routes every procedure command with its required source arguments', async () => {
        const procedure = procedureAssets.map(asset => asset.bytes).join('\n')
        // `<tool>` is the reader's own agent tool target; any valid one routes the same way.
        const invocations = [...procedure.matchAll(/`\.\/node_modules\/\.bin\/cockpit ([^`]+)`/g)]
            .map(match => match[1]!.replaceAll('<tool>', 'claudecode').split(' '))
        expect(invocations.length).toBeGreaterThanOrEqual(9)
        // The procedure is run by a person at a terminal; a CI runner's CI variable would make the
        // interactive sync step refuse, correctly, before routing.
        const { CI: _ci, ...humanEnvironment } = process.env
        for (const argv of invocations) {
            let invoked = false
            const handler = async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } }
            let output = ''
            const sink = { write: (text: string) => { output += text; return true } }
            const status = await runCli(argv, { stdout: sink, stderr: sink, confirmInit: async preview => preview.previewSha256,
                confirmWorkOrder: async candidate => candidate.digest, confirmStaleRemoval: async () => undefined }, {
                init: async input => { invoked = true; return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [], result: { stage: 'surface-previewed', root: input.root, target: input.target, previewSha256: 'a'.repeat(64), files: [] } } },
                // The documented work commands are the agent's; a gate the policy gives an agent needs no binding.
                beginOperatorWorkApplication: async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } },
                // The policy sync decides by, in place of a cockpit.toml on disk.
                loadPolicy: async () => ({ current: effectivePolicy({ work: Work.parse({}), autonomy: Autonomy.parse({}) }), record: async () => {} }),
                ...Object.fromEntries(commands.filter(command => command.handler !== 'init').map(command => [command.handler, handler])),
                sync: async input => { invoked = true; return { status: 0, diagnostics: [], result: {
                    action: 'sync' as const, dryRun: input.dryRun === true, changes: [],
                } } },
            }, { env: humanEnvironment })
            expect(status, `${argv.join(' ')}: ${output}`).toBe(0)
            expect(invoked, argv.join(' ')).toBe(true)
        }
    })
})
