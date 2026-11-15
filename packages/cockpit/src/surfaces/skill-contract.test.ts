import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { runCli } from '../cli.js'
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

// Rendered for every harness, the way a cockpit that lists them all renders the entry points.
const shippedSources = async () => (await shippedSourcesRaw()).map(source => ({ ...source,
    bytes: source.bytes.replace('{{tool-equivalence}}', 'Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.') }))

async function shippedSourcesRaw() {
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

const rendered = (captured: ReturnType<typeof input>) => captured

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
        expect(await inspectRenderedSkillSet({ ...rendered(captured), declaredExtensions: ['inspect'], generated, targets: SURFACE_TARGETS }))
            .toMatchObject({ kind: 'complete', skills: admitted.skills })
        expect(await inspectSkillSet(captured)).toMatchObject({ kind: 'refusal' })
        expect(await inspectSkillSet({ ...input(shipped), declaredExtensions: ['inspect'] })).toMatchObject({ kind: 'refusal' })
        expect(await inspectRenderedSkillSet({ ...rendered(captured), generated, targets: SURFACE_TARGETS })).toMatchObject({ kind: 'refusal' })
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

        const projections = SURFACE_TARGETS.map(target => projectInspectedSkillOutputs(result, [target], 'cockpit-setup'))
        expect(projections.map(projection => projection.kind === 'complete' ? projection.files.length : 0)).toEqual([2, 3, 2, 2, 2])
        expect(projections.flatMap(projection => projection.kind === 'complete' ? projection.files : [])
            .every(file => !file.bytes.includes('cockpit:verified'))).toBe(true)
        expect(projections[1]).toMatchObject({ kind: 'complete', target: 'codexcli', skill: 'cockpit-setup', files: [
            { path: '.agents/skills/cockpit-setup/SKILL.md' },
            { path: '.agents/skills/cockpit-setup/agents/openai.yaml' },
            { path: '.agents/skills/cockpit-setup/procedures/setup.md' },
        ] })
        // Every listed tool gets its own setup skill in one projection, keyed by the first.
        expect(projectInspectedSkillOutputs(result, ['codexcli', 'claudecode'], 'cockpit-setup')).toMatchObject({
            kind: 'complete', target: 'codexcli', files: expect.arrayContaining([
                expect.objectContaining({ target: 'codexcli' }), expect.objectContaining({ target: 'claudecode' })]) })
        expect(projectInspectedSkillOutputs(result, [], 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
        expect(projectInspectedSkillOutputs({ ...result }, ['codexcli'], 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
        expect(projectInspectedSkillOutputs(result, ['codexcli'], 'explain' as 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
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
            const before = fix.indexOf('./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config cockpit.toml --gate')
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
                value: cost.value + (['claudecode', 'codexcli', 'opencode'].includes(cost.target) ? 192 : 0),
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
        // Each skill installs only its own procedure, so each carries the shared rules for running cockpit; one copy that drifts misleads that skill alone.
        const operatingRules = procedureAssets.map(asset => /\n## Running cockpit\n[\s\S]*?(?=\n## )/.exec(asset.bytes)?.[0])
        expect(operatingRules.every(rules => rules !== undefined && rules.includes('GUARD_AUTHORITY_UNAVAILABLE'))).toBe(true)
        expect(new Set(operatingRules).size).toBe(1)
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
        expect(body).toContain('prove the fix with the product\'s own test runner, and report that no gate graded it')
        expect(body).toContain('Is this a work order?')
        expect(body).toContain('Never type the digest yourself.')
        expect(body).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs work accept --config cockpit.toml --work-order WO-001')
        expect(body).toContain('## On drift')
        expect(body).toContain('commit it together with the guide change')
        expect(body).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config cockpit.toml --gate declared-gate-id')
        const work = body.slice(body.indexOf('## Work'))
        expect(work).toContain('as the *Write a work order* section of `./node_modules/@b00dea/cockpit/docs/work-and-browser.md` shows')
        expect(work).toContain('reuse the planning skills the harness already has')
        expect(work).not.toContain("Run the harness's installed brainstorming and planning skills")
        const installedReview = work.indexOf("Run the harness's installed simplification and code-review skills")
        expect(installedReview).toBeGreaterThan(-1)
        expect(work.indexOf('./node_modules/@b00dea/cockpit/bin/cockpit.mjs work grade')).toBeGreaterThan(installedReview)
        expect(body).toContain('npm install --save-dev --save-exact @b00dea/cockpit@<version>')
        expect(body).not.toContain('`npm update` moves the pinned')
        expect(body).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json')
        expect(body).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json')
        expect(body).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json')
        expect(body).toContain('Show the human the proposed sibling declaration before invoking the command')
        expect(body).toContain('The command writes cockpit.toml immediately; `--json` changes only its output format')
        // A new repository is a new directory the agent may write, so its sync is a person's; an added tool is not, so the agent runs it.
        expect(body).toContain('Adding or removing a repository widens what agents may do (a new repository is a new directory they may write), so until a person runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a terminal and confirms it, calls are judged under the configuration last synced and every refusal names the sibling')
        expect(body).not.toContain('the hold names')
        expect(body).toContain('Adding a tool does not widen what agents may do, so you may run `tool add`')
        expect(body).not.toContain('until a person runs `./node_modules/.bin/cockpit down')
        expect(body).not.toContain('until a person runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs down')
        expect(body).not.toContain('--gate unit')
        expect(body).not.toContain('`work accept --interactive`')
        const explain = result.files.find(file => file.target === 'codexcli' && file.path === '.agents/skills/cockpit-explain/SKILL.md')
        const fix = result.files.find(file => file.target === 'opencode' && file.path === '.opencode/skills/cockpit-fix/SKILL.md')
        const setup = result.files.find(file => file.target === 'codexcli' && file.path === '.agents/skills/cockpit-setup/SKILL.md')
        expect(setup?.bytes).toContain('references/test-data-and-personas.md')
        expect(setup?.bytes).toContain('adopt-cockpit')
        // Installing a release by hand makes the guard hold every agent call, so the sync that follows is a person's.
        const upgrade = body.slice(body.indexOf('## After upgrading cockpit'))
        const exactInstall = upgrade.indexOf('npm install --save-dev --save-exact @b00dea/cockpit@<version>')
        const humanSync = upgrade.indexOf('a person runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --dry-run` and then `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a terminal')
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

        const result = await inspectRenderedSkillSet({ ...rendered(input(sources)), generated, targets: SURFACE_TARGETS })

        expect(result).toMatchObject({ kind: 'complete', skills: ['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'] })
        if (result.kind !== 'complete') return
        expect(result.files.some(file => file.path === 'CLAUDE.md')).toBe(true)
        expect(result.files.filter(file => file.path.includes('/skills/'))).toHaveLength(44)

        const missingSidecar = { ...generated, files: generated.files.filter(file =>
            file.path !== '.agents/skills/cockpit-setup/agents/openai.yaml') }
        await expect(inspectRenderedSkillSet({ ...rendered(input(sources)), generated: missingSidecar, targets: SURFACE_TARGETS })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVENTORY_INVALID', target: 'codexcli' }],
        })
        // Skills rendered for a tool cockpit.toml does not list are refused, not published beside the listed ones.
        await expect(inspectRenderedSkillSet({ ...rendered(input(sources)), generated, targets: ['claudecode'] })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVENTORY_INVALID' }],
        })
    }, 120_000)

    it('admits a declared extension on its name and description alone, with any files of its own', async () => {
        const extension = [
            { path: 'skills/inspect/SKILL.md', bytes: '---\nname: inspect\ndescription: Inspect the product.\ntargets: ["*"]\n---\n\n# Inspect\n\n1. Read [one](one.md).\n2. Read [two](notes/two.md).\n' },
            { path: 'skills/inspect/one.md', bytes: 'One.\n' },
            { path: 'skills/inspect/notes/two.md', bytes: 'Two.\n' },
        ]
        const captured = { ...input([...await shippedSources(), ...extension]), declaredExtensions: ['inspect'] }
        expect(await inspectSkillSet(captured)).toMatchObject({ kind: 'complete', skills: expect.arrayContaining(['inspect']) })
        for (const [label, bytes] of [['missing name', '---\ndescription: Inspect.\n---\nInspect.\n'],
            ['missing description', '---\nname: inspect\n---\nInspect.\n'],
            ['duplicate key', '---\nname: inspect\nname: other\ndescription: Inspect.\n---\nInspect.\n']] as const) {
            expect(await inspectSkillSet({ ...captured, sources: captured.sources.map(source =>
                source.path === 'skills/inspect/SKILL.md' ? { ...source, bytes } : source) }), label).toMatchObject({ kind: 'refusal', status: 2 })
        }
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
        const caps = { ...generousCaps, claudecode: claudecode.value + 191 }
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


describe('shipped skill house style', () => {
    // Held here rather than at runtime: these rules keep cockpit's own skills short and honest, and a
    // consumer's skills are theirs to shape.
    it('keeps each entry point within its line cap, its procedure out of it and its commands declared', async () => {
        const known = new Set(commands.map(command => command.name))
        for (const name of Object.keys(PROCEDURES)) {
            const bytes = await readFile(join(surfaceRoot, `${name}.skill.md`), 'utf8')
            const end = bytes.indexOf('\n---\n', 4)
            const frontmatter = parseYaml(bytes.slice(4, end)) as Record<string, any>
            const body = bytes.slice(end + 5).trim()
            const { cockpit: contract } = frontmatter
            expect(contract.procedure, name).toBe(PROCEDURES[name])
            expect(body.split('\n').length, name).toBeLessThanOrEqual(contract['entry-point-lines'])
            expect(body, name).not.toMatch(/^\s*(?:\d+[.)]\s+|```)/m)
            expect(body, name).toContain('{{tool-equivalence}}')
            expect(frontmatter.claudecode['allowed-tools'], name).toEqual(contract['tool-equivalences'].claudecode)
            expect(frontmatter.opencode['allowed-tools'], name).toEqual(contract['tool-equivalences'].opencode)
            for (const command of contract.commands as string[]) expect(known.has(command), `${name}: ${command}`).toBe(true)
            for (const [, command] of body.matchAll(/`cockpit\s+([a-z][a-z-]*)/g)) expect(contract.commands, name).toContain(command)
        }
    })
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
        expect(browser).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs browser drive --config cockpit.toml --json')
        expect(browser).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs browser screenshot --config cockpit.toml --json')
        // Rendered frontmatter adds per-harness keys; the neutral descriptions alone must leave room for them.
        expect(total).toBeLessThan(8192 / 4)
    })
})

describe('shipped procedure commands', () => {
    it('routes every procedure command with its required source arguments', async () => {
        const procedure = procedureAssets.map(asset => asset.bytes).join('\n')
        // `<tool>` is the reader's own agent tool target; any valid one routes the same way.
        const invocations = [...procedure.matchAll(/`\.\/node_modules\/(?:\.bin\/cockpit|@b00dea\/cockpit\/bin\/cockpit\.mjs) ([^`]+)`/g)]
            .map(match => match[1]!.replaceAll('<tool>', 'claudecode').replaceAll('<reference>', 'app:.env.schema').split(' '))
        expect(invocations.length).toBeGreaterThanOrEqual(9)
        // The procedure is run by a person at a terminal; a CI runner's CI variable would make the
        // interactive sync step refuse, correctly, before routing.
        const { CI: _ci, ...humanEnvironment } = process.env
        for (const argv of invocations) {
            let invoked = false
            const handler = async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } }
            let output = ''
            const sink = { write: (text: string) => { output += text; return true } }
            const status = await runCli(argv, { stdout: sink, stderr: sink,
                confirmWorkOrder: async candidate => candidate.digest, confirmWidening: async () => true }, {
                init: async input => { invoked = true; return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [], result: { stage: 'surface-previewed', root: input.root, target: input.target, previewSha256: 'a'.repeat(64), files: [] } } },
                // The documented work commands are the agent's; a gate the policy gives an agent needs no binding.
                beginOperatorWorkApplication: async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } },
                // A prune reads the machine's stacks, which a routing check has none of.
                beginStacksPrune: async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } },
                // What sync decides by, in place of a cockpit.toml on disk.
                loadPolicy: async () => ({ configSha256: 'a'.repeat(64), widened: [], seeded: false, approveMcp: async () => 'a'.repeat(64) }),
                ...Object.fromEntries(commands.filter(command => command.handler !== 'init').map(command => [command.handler, handler])),
                sync: async input => { invoked = true; return { status: 0, diagnostics: [], result: {
                    action: 'sync' as const, dryRun: input.dryRun === true, sourceSha256: 'a'.repeat(64), changes: [],
                } } },
            }, { env: humanEnvironment })
            expect(status, `${argv.join(' ')}: ${output}`).toBe(0)
            expect(invoked, argv.join(' ')).toBe(true)
        }
    })
})
