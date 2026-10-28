import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { runCli } from '../cli.js'
import { commands } from '../command-table.js'

import { SURFACE_TARGETS, type SurfaceTarget } from './contract.js'
import { generateSurfaceBatch } from './generator-adapter.js'
import { inspectRenderedSkillSet, inspectSkillSet, projectInspectedSkillOutputs } from './skill-contract.js'

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../surfaces/skills')
const generousCaps: Record<SurfaceTarget, number> = { claudecode: 8_192, codexcli: 8_192, opencode: 8_192 }
const terminal = { path: 'skills/procedures/onboarding.md', bytes: await readFile(join(surfaceRoot, 'procedures/onboarding.md'), 'utf8') }

function authenticated(source: { path: string; bytes: string }) {
    return { ...source, sha256: createHash('sha256').update(source.bytes).digest('hex') }
}

async function shippedSources() {
    const names = ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work']
    const procedure = await readFile(join(surfaceRoot, 'procedures/onboarding.md'), 'utf8')
    return Promise.all(names.flatMap(name => [
        readFile(join(surfaceRoot, `${name}.skill.md`), 'utf8').then(bytes => ({ path: `skills/${name}/SKILL.md`, bytes })),
        Promise.resolve({ path: `skills/${name}/procedures/onboarding.md`, bytes: procedure }),
    ]))
}

function input(sources: readonly { path: string; bytes: string }[], standingCostCaps = generousCaps) {
    return { sources, collection: authenticated({ path: 'skills/collection.json', bytes: JSON.stringify({
        skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: standingCostCaps,
        displacement: terminal.path,
    }) }), terminal: authenticated(terminal) }
}

function changeEntry(
    sources: readonly { path: string; bytes: string }[],
    transform: (bytes: string) => string,
) {
    return sources.map(source => source.path === 'skills/cockpit-setup/SKILL.md'
        ? { ...source, bytes: transform(source.bytes) }
        : source)
}

describe('shipped skill contract', () => {
    it('admits only the exact union of shipped skills and explicitly declared extensions', async () => {
        const shipped = await shippedSources()
        const extension = shipped.filter(source => source.path.startsWith('skills/cockpit-setup/')).map(source => ({
            path: source.path.replace('skills/cockpit-setup/', 'skills/inspect/').replace('procedures/onboarding.md', 'procedures/inspect.md'),
            bytes: source.path.endsWith('/SKILL.md')
                ? source.bytes.replace('name: cockpit-setup', 'name: inspect').replace('procedures/onboarding.md', 'procedures/inspect.md')
                : '---\nloading: pull\nbudget: uncapped\n---\n\nInspect the product-owned verification target.\n',
        }))
        const captured = input([...shipped, ...extension])
        const admitted = await inspectSkillSet({ ...captured, declaredExtensions: ['inspect'] })
        expect(admitted).toMatchObject({ kind: 'complete', skills: ['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work', 'inspect'],
            collection: { source: { sha256: captured.collection.sha256 }, skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'],
                metric: 'frontmatter_bytes', caps: generousCaps, displacement: terminal.path } })
        if (admitted.kind !== 'complete') throw new Error('Declared skill extension refused')
        expect(admitted.collection.entrypoints).toContainEqual(expect.objectContaining({
            path: 'skills/inspect/SKILL.md', displacement: 'skills/inspect/procedures/inspect.md' }))
        expect(admitted.files.filter(file => file.path.endsWith('/SKILL.md'))).toHaveLength(15)
        const paths = captured.sources.map(source => source.path.slice('skills/'.length))
        const generated = await generateSurfaceBatch({ targets: SURFACE_TARGETS, features: ['skills'], sources: captured.sources,
            expectedOutputs: {
                claudecode: paths.map(path => `.claude/skills/${path}`),
                codexcli: paths.flatMap(path => [`.agents/skills/${path}`,
                    ...(path.endsWith('/SKILL.md') ? [`.agents/skills/${path.slice(0, -'SKILL.md'.length)}agents/openai.yaml`] : [])]),
                opencode: paths.map(path => `.opencode/skills/${path}`),
            } })
        expect(await inspectRenderedSkillSet({ ...captured, declaredExtensions: ['inspect'], generated }))
            .toMatchObject({ kind: 'complete', skills: admitted.skills })
        for (const bytes of ['', '---\nloading: eager\nbudget: uncapped\n---\nInspect.\n',
            '---\nloading: pull\nbudget: uncapped\n---\n']) {
            expect(await inspectSkillSet({ ...captured, declaredExtensions: ['inspect'],
                sources: captured.sources.map(source => source.path === 'skills/inspect/procedures/inspect.md'
                    ? { ...source, bytes } : source) })).toMatchObject({ kind: 'refusal' })
        }
        expect(await inspectSkillSet(captured)).toMatchObject({ kind: 'refusal' })
        expect(await inspectSkillSet({ ...input(shipped), declaredExtensions: ['inspect'] })).toMatchObject({ kind: 'refusal' })
        expect(await inspectRenderedSkillSet({ ...captured, generated })).toMatchObject({ kind: 'refusal' })
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
        ['extra key', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: generousCaps, displacement: terminal.path, extra: true })],
        ['wrong metric', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'bytes', caps: generousCaps, displacement: terminal.path })],
        ['incomplete target', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: { claudecode: 8192, codexcli: 8192 }, displacement: terminal.path })],
        ['over ceiling', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: { ...generousCaps, codexcli: 65537 }, displacement: terminal.path })],
        ['wrong inventory', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-fix'], metric: 'frontmatter_bytes', caps: generousCaps, displacement: terminal.path })],
        ['outside sink', JSON.stringify({ skills: ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'], metric: 'frontmatter_bytes', caps: generousCaps, displacement: '../onboarding.md' })],
        ['duplicate key', '{"skills":["cockpit-setup","cockpit-explain","cockpit-fix","cockpit-work"],"metric":"bytes","metric":"frontmatter_bytes","caps":{"claudecode":8192,"codexcli":8192,"opencode":8192},"displacement":"skills/procedures/onboarding.md"}'],
    ])('refuses collection declaration: %s', async (_label, bytes) => {
        const captured = input(await shippedSources())
        await expect(inspectSkillSet({ ...captured, collection: authenticated({ path: captured.collection.path, bytes }) }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_INPUT_INVALID' }] })
    })

    it.each([
        ['absent', ''], ['push', terminal.bytes.replace('loading: pull', 'loading: push')],
        ['capped', terminal.bytes.replace('budget: uncapped', 'budget: 8192')],
        ['implicit', terminal.bytes.replace('budget: uncapped\n', '')],
    ])('refuses terminal documentation metadata: %s', async (_label, bytes) => {
        const captured = input(await shippedSources())
        await expect(inspectSkillSet({ ...captured, terminal: authenticated({ path: terminal.path, bytes }) }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SKILL_INPUT_INVALID' }] })
    })

    it('binds the shipped declaration digest, exact inventory, entrypoint caps and pull terminal', async () => {
        const sources = await shippedSources()
        const bytes = await readFile(join(surfaceRoot, 'collection.json'), 'utf8')
        const captured = input(sources)
        const result = await inspectSkillSet({ ...captured, collection: authenticated({ path: 'skills/collection.json', bytes }) })
        expect(result.kind, JSON.stringify(result)).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.collection).toMatchObject({ source: { path: 'skills/collection.json', sha256: authenticated({ path: 'skills/collection.json', bytes }).sha256 },
            metric: 'frontmatter_bytes', caps: generousCaps, displacement: terminal.path,
            terminal: { path: terminal.path, sha256: authenticated(terminal).sha256, loading: 'pull', budget: 'uncapped' } })
        expect(result.collection.entrypoints).toEqual(['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'].map(name => ({
            path: `skills/${name}/SKILL.md`, cap: ({ 'cockpit-setup': 11, 'cockpit-explain': 11, 'cockpit-fix': 14, 'cockpit-work': 10 } as Record<string, number>)[name]!, metric: 'lines', displacement: terminal.path,
        })))
        expect(SURFACE_TARGETS.map(target => result.files.filter(file => file.target === target).length)).toEqual([8, 12, 8])
        expect(result.files.some(file => file.path.includes('collection'))).toBe(false)
        for (const changed of [sources.filter(source => !source.path.includes('/cockpit-fix/')),
            sources.filter(source => source.path !== 'skills/cockpit-setup/procedures/onboarding.md'),
            sources.map(source => source.path === 'skills/cockpit-setup/procedures/onboarding.md' ? { ...source, bytes: source.bytes + 'changed' } : source),
            changeEntry(sources, value => value.replace('procedure: procedures/onboarding.md', 'procedure: procedures/elsewhere.md'))]) {
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
            expect.objectContaining({ target: 'claudecode', path: '.claude/skills/cockpit-setup/procedures/onboarding.md' }),
            expect.objectContaining({ target: 'opencode', path: '.opencode/skills/cockpit-setup/procedures/onboarding.md' }),
        ]))
    }, 120_000)

    it('projects inspected bootstrap outputs for exactly one selected target', async () => {
        const result = await inspectSkillSet(input(await shippedSources()))
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return

        const projections = SURFACE_TARGETS.map(target => projectInspectedSkillOutputs(result, target, 'cockpit-setup'))
        expect(projections.map(projection => projection.kind === 'complete' ? projection.files.length : 0)).toEqual([2, 3, 2])
        expect(projections.flatMap(projection => projection.kind === 'complete' ? projection.files : [])
            .every(file => !file.bytes.includes('cockpit:verified'))).toBe(true)
        expect(projections[1]).toMatchObject({ kind: 'complete', target: 'codexcli', skill: 'cockpit-setup', files: [
            { path: '.agents/skills/cockpit-setup/SKILL.md' },
            { path: '.agents/skills/cockpit-setup/agents/openai.yaml' },
            { path: '.agents/skills/cockpit-setup/procedures/onboarding.md' },
        ] })
        expect(projectInspectedSkillOutputs({ ...result }, 'codexcli', 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
        expect(projectInspectedSkillOutputs(result, 'codexcli', 'explain' as 'cockpit-setup')).toMatchObject({ kind: 'refusal' })
    }, 120_000)

    it('ships intent routing, installed capability discovery and reviews before grading in every fix procedure', async () => {
        const result = await inspectSkillSet(input(await shippedSources()))
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error('Shipped preparation workflow was refused')
        for (const target of SURFACE_TARGETS) {
            const procedure = result.files.find(file => file.target === target && file.path.endsWith('/cockpit-fix/procedures/onboarding.md'))
            expect(procedure, target).toBeDefined()
            const body = procedure!.bytes.replace(/\s+/g, ' ')
            const routing = body.indexOf('Before creating files, route the intent')
            const discovery = body.indexOf('Inspect repository- and user-installed skills')
            const drafting = body.indexOf('Only after route and capacity admission, prepare a draft')
            const reviews = body.indexOf('After each substantial implementation batch and again before grading')
            expect(routing).toBeGreaterThan(-1)
            expect(discovery).toBeGreaterThan(routing)
            expect(drafting).toBeGreaterThan(discovery)
            expect(reviews).toBeGreaterThan(drafting)
            expect(body).toContain('A fix result creates zero work-order files')
            expect(body).toContain('Re-evaluate the route when scope changes')
            expect(body).toContain('Record capability selection, chosen source, applicability and reason')
            expect(body).toContain('simplification first, then independent code review')
            expect(body).toContain('Persist findings and dispositions')
            expect(body).toContain('The grader starts only after final declared verification is current')
            expect(body).toContain('Semantic applicability and these conversation steps are instructed')
        }
    }, 120_000)

    it('admits the complete shipped set, preserves procedure goldens, and measures each rendered installed manifest', async () => {
        const sources = await shippedSources()
        const procedure = sources.find(source => source.path === 'skills/cockpit-setup/procedures/onboarding.md')?.bytes
        expect(procedure).toBeDefined()

        const result = await inspectSkillSet(input(sources))

        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.skills).toEqual(['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'])
        expect(result.costs).toHaveLength(3)
        expect(new Set(result.costs.map(cost => cost.value)).size).toBeGreaterThan(1)
        expect(result.costs.every(cost => cost.metric === 'frontmatter_bytes' && cost.value > 0 && cost.value <= cost.cap)).toBe(true)
        const renderedProcedures = result.files.filter(file => file.path.endsWith('/procedures/onboarding.md'))
        expect(renderedProcedures).toHaveLength(SURFACE_TARGETS.length * 4)
        expect(renderedProcedures.every(file => file.bytes === procedure)).toBe(true)
        const body = procedure!.replace(/\s+/g, ' ')
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
        expect(body).toContain('A missing counter is not zero')
        expect(body).toContain('cockpit work-accept --config cockpit.toml --work-order WO-001 --interactive')
        expect(body).toContain('result.orders[0].state.attempts')
        expect(body).toContain('cockpit test-run --config cockpit.toml --gate declared-gate-id')
        const work = body.slice(body.indexOf('## Work'))
        const installedReview = work.indexOf("Run the harness's installed simplification and code-review skills")
        expect(installedReview).toBeGreaterThan(-1)
        expect(work.indexOf('cockpit work-review')).toBeGreaterThan(installedReview)
        expect(body).toContain('npm install --save-dev --save-exact @b0dea/cockpit@<version>')
        expect(body).not.toContain('`npm update` moves the pinned')
        expect(body).toContain('cockpit sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json')
        expect(body).toContain('cockpit sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json')
        expect(body).toContain('cockpit sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json')
        expect(body).toContain('Show the human the proposed sibling declaration before invoking the command')
        expect(body).toContain('The command writes cockpit.toml immediately; `--json` changes only its output format')
        expect(body).toContain('a human runs `cockpit sync --config cockpit.toml` in a terminal')
        expect(body).not.toContain('--gate unit')
        expect(body).not.toContain('`work-accept --interactive`')
        const explain = result.files.find(file => file.target === 'codexcli' && file.path === '.agents/skills/cockpit-explain/SKILL.md')
        const fix = result.files.find(file => file.target === 'opencode' && file.path === '.opencode/skills/cockpit-fix/SKILL.md')
        const setup = result.files.find(file => file.target === 'codexcli' && file.path === '.agents/skills/cockpit-setup/SKILL.md')
        expect(setup?.bytes).toContain('references/test-data-and-personas.md')
        expect(setup?.bytes).toContain('adopt-cockpit')
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
            },
        })
        expect(generated.kind, JSON.stringify(generated)).toBe('complete')
        if (generated.kind !== 'complete') return

        const result = await inspectRenderedSkillSet({ ...input(sources), generated })

        expect(result).toMatchObject({ kind: 'complete', skills: ['cockpit-explain', 'cockpit-fix', 'cockpit-setup', 'cockpit-work'] })
        if (result.kind !== 'complete') return
        expect(result.files.some(file => file.path === 'CLAUDE.md')).toBe(true)
        expect(result.files.filter(file => file.path.includes('/skills/'))).toHaveLength(28)

        const missingSidecar = { ...generated, files: generated.files.filter(file =>
            file.path !== '.agents/skills/cockpit-setup/agents/openai.yaml') }
        await expect(inspectRenderedSkillSet({ ...input(sources), generated: missingSidecar })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'SKILL_RENDER_INVENTORY_INVALID', target: 'codexcli' }],
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
        ['missing procedure', (bytes: string) => bytes.replace('  procedure: procedures/onboarding.md\n', '')],
        ['missing review metadata', (bytes: string) => bytes.replace('  review: { mechanical: cockpit-skill-contract, judgment: pending }\n', '')],
        ['numbered inline procedure', (bytes: string) => `${bytes}1. Parse inputs\n`],
        ['fenced inline procedure', (bytes: string) => `${bytes}\`\`\`sh\ncockpit check\n\`\`\`\n`],
        ['copied registry logic', (bytes: string) => `${bytes}Parse the registry before continuing.\n`],
        ['copied policy table', (bytes: string) => `${bytes}| Tier | Verdict |\n| --- | --- |\n`],
        ['misspelled command identifier', (bytes: string) => bytes.replace('commands: [init,', 'commands: [innit,')],
        ['absent command identifier', (bytes: string) => bytes.replace('  commands: [init, document, sync, check, doctor, up, preflight, upgrade, sibling]\n', '')],
        ['stale command identifier', (bytes: string) => bytes.replace('commands: [init,', 'commands: [bootstrap,')],
        ['unadmitted command identifier', (bytes: string) => bytes.replace('commands: [init,', 'commands: [publish,')],
        ['undeclared command', (bytes: string) => `${bytes}Run \`cockpit invent\`.\n`],
        ['misleading completion', (bytes: string) => `${bytes}Report complete without proof.\n`],
        ['excess entry-point cap', (bytes: string) => bytes.replace('  entry-point-lines: 11\n', '  entry-point-lines: 1\n')],
    ])('refuses hostile entry point: %s', async (_label, transform) => {
        const sources = await shippedSources()
        const result = await inspectSkillSet(input(changeEntry(sources, transform)))

        expect(result.kind).toBe('refusal')
        expect(result.status).toBe(2)
    })

    it('fails the rendered harness whose own installed-set cap is exceeded', async () => {
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
        const caps = { ...generousCaps, [largest.target]: largest.value - 1 }

        const refused = await inspectSkillSet(input(sources, caps))

        expect(refused).toMatchObject({
            kind: 'refusal',
            diagnostics: [{ code: 'SKILL_STANDING_COST_EXCEEDED', target: largest.target }],
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
        expect(browser).toContain('cockpit browser-accessibility --config cockpit.toml --json')
        expect(browser).toContain('cockpit browser-screenshot --config cockpit.toml --json')
        // Rendered frontmatter adds per-harness keys; the neutral descriptions alone must leave room for them.
        expect(total).toBeLessThan(8192 / 4)
    })
})

describe('shipped onboarding commands', () => {
    it('routes every onboarding command with its required source arguments', async () => {
        const procedure = await readFile(join(surfaceRoot, 'procedures/onboarding.md'), 'utf8')
        const invocations = [...procedure.matchAll(/`cockpit ([^`]+)`/g)].map(match => match[1]!.split(' '))
        expect(invocations.length).toBeGreaterThanOrEqual(9)
        for (const argv of invocations) {
            let invoked = false
            const handler = async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } }
            let output = ''
            const sink = { write: (text: string) => { output += text; return true } }
            const status = await runCli(argv, { stdout: sink, stderr: sink, confirmInit: async preview => preview.previewSha256,
                confirmWorkOrder: async candidate => candidate.digest, confirmStaleRemoval: async () => undefined }, {
                init: async input => { invoked = true; return { kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [], result: { stage: 'surface-previewed', root: input.root, target: input.target, previewSha256: 'a'.repeat(64), files: [], nextCommand: 'accept exact preview' } } },
                beginOperatorWorkApplication: async () => ({ digest: 'a'.repeat(64), prompt: 'Confirm the documented work-order command.',
                    decide: async () => { invoked = true; return { status: 0, result: null, diagnostics: [] } } }),
                ...Object.fromEntries(commands.filter(command => command.handler !== 'init').map(command => [command.handler, handler])),
                sync: async input => { invoked = true; return { status: 0, diagnostics: [], result: {
                    action: 'sync' as const, dryRun: input.dryRun === true, changes: [],
                } } },
            })
            expect(status, `${argv.join(' ')}: ${output}`).toBe(0)
            expect(invoked, argv.join(' ')).toBe(true)
        }
    })
})
