import { createHash } from 'node:crypto'
import { initCommand } from '../fix-catalogue.js'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { classifyEstateObservation, documentCommand, documentObservedCommand, observeCockpitRoot, observePublicEstate,
    type DocumentConfigurationAnswer } from './draft.js'
import { CockpitConfig } from '../schema.js'
import { loadCockpitConfig } from '../config/load.js'

const root = resolve(import.meta.dirname, '../../../..')
const laneFixture = readFileSync(join(root, 'fixtures/registries/lane-dialect.sh'), 'utf8')
const tierFixture = readFileSync(join(root, 'fixtures/registries/tier-dialect.sh'), 'utf8')
const generatedConfig = parseToml(readFileSync(join(root, 'fixtures/registries/generated-environment.toml'), 'utf8')) as {
    sibling: unknown[]; environment: { install_policies: unknown }
}
const machineFloor = { runtime_memory_mb: 2048, runtime_cpus: 2, free_disk_mb: 10240, cold_start_seconds: 120 }
const localPosture = { addressing: 'port', authentication: 'none',
    posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
const guardHosts = { hosted_db_hosts: ['db.staging.example.invalid'], vendor_endpoint_hosts: ['api.vendor.example.invalid'] }
const scratch: string[] = []

function temporaryPath(name: string) {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-command-'))
    scratch.push(directory)
    return join(directory, name)
}

function sourceInput(source: string) {
    const cockpitRoot = temporaryPath('synthetic-cockpit')
    mkdirSync(join(cockpitRoot, 'env/lib'), { recursive: true })
    writeFileSync(join(cockpitRoot, 'env/lib/instance.sh'), source)
    return { input: { root: cockpitRoot } }
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

type EstateFixture = Readonly<{ repositories: readonly Readonly<{
    slug: string; path: string; evidencePath: string
    runnable: 'confirmed' | 'absent' | 'unknown'; why?: string
}>[] }>
type EstateDigestRow = Readonly<{
    slug: string
    path: string
    runnable: 'confirmed' | 'absent' | 'unknown'
    why?: string
    source: Readonly<{ path: string; sha256: string }>
}>

function materializeEstate(name: string) {
    const declaration = JSON.parse(readFileSync(join(root, 'fixtures/estates', name), 'utf8')) as EstateFixture
    const estateRoot = temporaryPath('synthetic-estate')
    mkdirSync(estateRoot)
    const canonicalRoot = realpathSync(estateRoot)
    const repositories = declaration.repositories.map(row => {
        const repository = join(canonicalRoot, row.path)
        mkdirSync(repository)
        const evidence = JSON.stringify({ repository: row.slug, runnable: row.runnable }) + '\n'
        writeFileSync(join(repository, row.evidencePath), evidence)
        return { ...row, source: { path: row.evidencePath,
            sha256: createHash('sha256').update(evidence).digest('hex') } }
    })
    return { estateRoot: canonicalRoot, repositories }
}

describe('estate observation classification', () => {
    const observe = (root: string, repositories: readonly unknown[]) => async () => ({
        root, observedAt: '2026-10-25T10:00:00.000Z', repositories,
    })
    const observationDigest = (root: string, repositories: readonly EstateDigestRow[]) => createHash('sha256')
        .update(JSON.stringify({ root, repositories: repositories.map(row => ({
            slug: row.slug, path: row.path, runnable: row.runnable, why: row.why ?? null,
            source: { path: row.source.path, sha256: row.source.sha256 },
        })) }))
        .digest('hex')

    it('states the one-sibling floor and only the applicable capabilities', async () => {
        const { estateRoot, repositories } = materializeEstate('one-sibling.json')
        expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, repositories) })).toEqual({
            kind: 'complete', status: 0, diagnostics: [], result: {
                classification: 'one-sibling',
                notice: 'one repository gets the full cockpit: agent instructions, guards, harness settings and its stack; grow it with the sibling add command',
                gaps: [],
                runnable: [{ slug: 'web', path: 'web', disposition: 'confirmed' }],
                sourceObservationSha256: observationDigest(estateRoot, repositories),
            },
        })
    })

    it('changes its source digest when evidence bytes change without changing classification', async () => {
        const { estateRoot, repositories } = materializeEstate('one-sibling.json')
        const first = await classifyEstateObservation({ root: estateRoot }, {
            observe: observe(estateRoot, repositories),
        })
        const evidence = '{"repository":"web","runnable":"confirmed","revision":2}\n'
        writeFileSync(join(estateRoot, 'web/run-observation.json'), evidence)
        const changedRows = [{ ...repositories[0], source: { ...repositories[0].source,
            sha256: createHash('sha256').update(evidence).digest('hex') } }]
        const changed = await classifyEstateObservation({ root: estateRoot }, {
            observe: observe(estateRoot, changedRows),
        })
        expect(changed).toMatchObject({ kind: 'complete', result: {
            classification: 'one-sibling',
            sourceObservationSha256: observationDigest(estateRoot, changedRows),
        } })
        expect(changed.kind === 'complete' && first.kind === 'complete'
            ? changed.result.sourceObservationSha256 : null)
            .not.toBe(first.kind === 'complete' ? first.result.sourceObservationSha256 : null)
    })

    it('returns provenance-bearing named gaps for an incomplete multi-repository estate', async () => {
        const { estateRoot, repositories } = materializeEstate('incomplete-multi-repository.json')
        expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, repositories) }))
            .toMatchObject({ kind: 'complete', result: {
                classification: 'incomplete-multi-repository',
                gaps: [{ field: 'api.runnable', source: 'api/run-observation.json',
                    why: 'the observed repository does not declare a runnable product command' }],
            } })
    })

    it('keeps a single unknown repository at the one-sibling floor with its named gap', async () => {
        const { estateRoot, repositories } = materializeEstate('one-sibling.json')
        const unknown = [{ ...repositories[0], runnable: 'unknown' as const,
            why: 'the runnable product command remains unobserved' }]
        expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, unknown) }))
            .toMatchObject({ kind: 'complete', result: {
                classification: 'one-sibling',
                gaps: [{ field: 'web.runnable', source: 'web/run-observation.json',
                    why: 'the runnable product command remains unobserved' }],
            } })
    })

    it('keeps a non-runnable estate out of compose with one named gap', async () => {
        const { estateRoot, repositories } = materializeEstate('no-runnable-product.json')
        expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, repositories) }))
            .toMatchObject({ kind: 'complete', result: {
                classification: 'no-runnable-product',
                gaps: [{ field: 'runnable-product', source: 'library/run-observation.json',
                    why: 'the observed repository exposes no runnable product' }],
            } })
    })

    it('refuses malformed, linked, changed-root, changed-source and ambiguous observations', async () => {
        const { estateRoot, repositories } = materializeEstate('one-sibling.json')
        const invalid = [
            { root: estateRoot, observedAt: 'not-a-date', repositories },
            { root: `${estateRoot}-changed`, observedAt: '2026-10-25T10:00:00.000Z', repositories },
            { root: estateRoot, observedAt: '2026-10-25T10:00:00.000Z', repositories: [...repositories, repositories[0]] },
        ]
        for (const candidate of invalid) {
            expect(await classifyEstateObservation({ root: estateRoot }, { observe: async () => candidate }))
                .toMatchObject({ kind: 'refusal', status: 2 })
        }
        const linkRoot = temporaryPath('linked-estate')
        symlinkSync(estateRoot, linkRoot)
        expect(await classifyEstateObservation({ root: linkRoot }, { observe: observe(linkRoot, repositories) }))
            .toMatchObject({ kind: 'refusal' })
        writeFileSync(join(estateRoot, 'web/run-observation.json'), 'changed\n')
        expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, repositories) }))
            .toMatchObject({ kind: 'refusal' })
    })

    it('refuses evidence beyond the bounded-read limit even when its digest matches', async () => {
        const { estateRoot, repositories } = materializeEstate('one-sibling.json')
        const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61)
        writeFileSync(join(estateRoot, 'web/run-observation.json'), oversized)
        const rows = [{ ...repositories[0], source: { ...repositories[0].source,
            sha256: createHash('sha256').update(oversized).digest('hex') } }]

        expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, rows) }))
            .toMatchObject({ kind: 'refusal', status: 2 })
    })

    it('refuses contradictory, guessed-toolchain and secret-shaped observations', async () => {
        const { estateRoot, repositories } = materializeEstate('one-sibling.json')
        const cases = [[{ ...repositories[0], why: 'contradiction' }],
            [{ ...repositories[0], toolchain: 'node' }], [{ ...repositories[0], token: 'synthetic' }],
            [{ ...repositories[0], runnable: 'unknown', why: 'api_token=raw-secret-shaped-value' }]]
        for (const rows of cases) {
            expect(await classifyEstateObservation({ root: estateRoot }, { observe: observe(estateRoot, rows) }))
                .toMatchObject({ kind: 'refusal', status: 2 })
        }
    })
})

describe('public estate observation', () => {
    it('binds Compose runnable evidence to current bounded regular bytes', async () => {
        const estateRoot = temporaryPath('compose-estate')
        mkdirSync(join(estateRoot, 'app'), { recursive: true })
        writeFileSync(join(estateRoot, 'app/package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }))
        writeFileSync(join(estateRoot, 'app/compose.yml'), 'services:\n  app:\n    image: synthetic.invalid/app:1\n')
        const canonical = realpathSync(estateRoot)
        const observed = await observePublicEstate({ root: canonical })
        expect(observed).toMatchObject({ repositories: [{ slug: 'app', runnable: 'confirmed', sources: [
            { path: 'package.json', sha256: expect.any(String) },
            { path: 'compose.yml', sha256: expect.any(String) },
        ] }] })

        writeFileSync(join(estateRoot, 'app/compose.yml'), 'services:\n  app:\n    image: synthetic.invalid/app:2\n')
        expect(await classifyEstateObservation({ root: canonical }, { observe: async () => observed }))
            .toMatchObject({ kind: 'refusal', status: 2 })
        rmSync(join(estateRoot, 'app/compose.yml'))
        symlinkSync(join(estateRoot, 'app/package.json'), join(estateRoot, 'app/compose.yml'))
        expect(await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate }))
            .toMatchObject({ kind: 'refusal', status: 2, diagnostics: [{
                code: 'DOCUMENT_ESTATE_OBSERVATION_INVALID',
                message: expect.stringContaining('symbolic link'),
                target: join(canonical, 'app/compose.yml'),
                fix: expect.stringContaining(`rerun ${initCommand()} with the root, target and options you ran it with`),
            }] })
        expect(await classifyEstateObservation({ root: canonical }, { observe: async () => {
            throw new Error('api_token=raw-secret-shaped-value')
        } })).toMatchObject({ kind: 'refusal', diagnostics: [{
            message: 'estate observation owner failed', target: canonical,
        }] })
    })

    it('keeps every supported ambiguous source as one bounded named runnable gap', async () => {
        const estateRoot = temporaryPath('ambiguous-estate')
        mkdirSync(join(estateRoot, 'app'), { recursive: true })
        const files = {
            'package.json': JSON.stringify({ scripts: { build: 'node build.mjs' } }),
            'pyproject.toml': '[project]\nname = "app"\n',
            'Cargo.toml': '[package]\nname = "app"\nversion = "0.0.0"\n',
            'go.mod': 'module example.invalid/app\n',
            Gemfile: 'source "https://rubygems.org"\n',
            Dockerfile: 'FROM scratch\n',
            'compose.yaml': 'services: {}\n',
            'compose.yml': 'services: []\n',
            'docker-compose.yaml': 'not-services: true\n',
            'docker-compose.yml': 'services:\n  app: null\n',
        }
        for (const [name, bytes] of Object.entries(files)) writeFileSync(join(estateRoot, 'app', name), bytes)
        const canonical = realpathSync(estateRoot)

        const outcome = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })

        expect(outcome).toMatchObject({ kind: 'complete', result: {
            classification: 'one-sibling',
            gaps: [{ field: 'app.runnable', source: 'app/package.json', why: expect.stringContaining('additional source issues') }],
            runnable: [{ slug: 'app', disposition: 'unknown' }],
        } })
        if (outcome.kind !== 'complete') throw new Error('ambiguous public source observation was refused')
        expect(outcome.result.gaps[0]!.why.length).toBeLessThanOrEqual(512)
        // Joined with other repositories' reasons into one why, each reason names its repository's file.
        expect(outcome.result.gaps[0]!.why).toMatch(/^app\/package\.json declares no non-empty dev, start or serve script; app\/pyproject\.toml /)
    })

    it('refuses a manifest appearing inside an omitted candidate during observation', async () => {
        const estateRoot = temporaryPath('changing-estate')
        mkdirSync(join(estateRoot, 'web'), { recursive: true })
        mkdirSync(join(estateRoot, 'worker'))
        const manifest = JSON.stringify({ scripts: { dev: 'node server.js' } })
        writeFileSync(join(estateRoot, 'web/package.json'), manifest)
        const canonical = realpathSync(estateRoot)
        const outcome = await classifyEstateObservation({ root: canonical }, { observe: async input => {
            const observed = await observePublicEstate(input)
            writeFileSync(join(estateRoot, 'worker/package.json'), manifest)
            return observed
        } })
        expect(outcome).toMatchObject({ kind: 'refusal' })
        expect(await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate }))
            .toMatchObject({ kind: 'complete', result: { classification: 'ready-multi-repository' } })
    })

    it.each(['manifest', 'repository'])('refuses an observer omitting an existing public %s', async omission => {
        const estateRoot = temporaryPath('omitted-estate')
        mkdirSync(join(estateRoot, 'app'), { recursive: true })
        writeFileSync(join(estateRoot, 'app/package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
        writeFileSync(join(estateRoot, 'app/pyproject.toml'), '[project]\nname = "app"\n')
        mkdirSync(join(estateRoot, 'worker'))
        writeFileSync(join(estateRoot, 'worker/package.json'), JSON.stringify({ scripts: { dev: 'node worker.js' } }))
        const canonical = realpathSync(estateRoot)
        const outcome = await classifyEstateObservation({ root: canonical }, { observe: async input => {
            const observation = structuredClone(await observePublicEstate(input)) as { repositories: { sources?: unknown }[] }
            if (omission === 'manifest') delete observation.repositories[0]!.sources
            else observation.repositories.pop()
            return observation
        } })
        expect(outcome).toMatchObject({ kind: 'refusal' })
        expect(await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate }))
            .toMatchObject({ kind: 'complete', result: { classification: 'ready-multi-repository' } })
    })

    it.each(['an empty', 'a documents-only'])('observes %s root with no package manifest as nothing runnable', async shape => {
        const estateRoot = temporaryPath('genesis')
        mkdirSync(estateRoot)
        if (shape === 'a documents-only') {
            mkdirSync(join(estateRoot, 'decisions'))
            writeFileSync(join(estateRoot, 'decisions/0001-record.md'), '# Record decisions\n')
        }
        const canonical = realpathSync(estateRoot)
        const classified = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        expect(classified).toMatchObject({ kind: 'complete', result: {
            classification: 'no-runnable-product', runnable: [],
            gaps: [{ field: 'runnable-product', source: '.' }],
        } })
        if (classified.kind !== 'complete') throw new Error('manifest-free estate classification failed')
        expect(await documentObservedCommand({ root: canonical, configuration: {
            sourceObservationSha256: classified.result.sourceObservationSha256,
            classification: classified.result.classification, answers: [],
        } })).toMatchObject({ kind: 'gap-draft', question: { field: 'cockpit.name' } })
        // An empty observation is only true while it stays true: a manifest makes it an omission.
        mkdirSync(join(estateRoot, 'api'))
        writeFileSync(join(estateRoot, 'api/package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
        expect(await classifyEstateObservation({ root: canonical }, {
            observe: async () => ({ root: canonical, observedAt: '2026-10-25T10:00:00.000Z', repositories: [] }),
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_INVALID' }] })
    })

    it('keeps a polyglot repository unknown until its runnable command is confirmed', async () => {
        const estateRoot = temporaryPath('polyglot-estate')
        mkdirSync(join(estateRoot, 'app'), { recursive: true })
        writeFileSync(join(estateRoot, 'app/package.json'), JSON.stringify({ scripts: { build: 'tsc' } }))
        writeFileSync(join(estateRoot, 'app/pyproject.toml'), '[project]\nname = "app"\n')
        const canonical = realpathSync(estateRoot)
        const first = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        expect(first).toMatchObject({ kind: 'complete', result: {
            classification: 'one-sibling', gaps: [{ field: 'app.runnable' }],
        } })
        if (first.kind !== 'complete') throw new Error('polyglot estate classification failed')
        writeFileSync(join(estateRoot, 'app/pyproject.toml'), '[project]\nname = "updated-app"\n')
        const second = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        if (second.kind !== 'complete') throw new Error('updated polyglot estate classification failed')
        expect(second.result.sourceObservationSha256).not.toBe(first.result.sourceObservationSha256)
    })

    it('reads only fixed public manifests and binds runnable classification to their bytes', async () => {
        const estateRoot = temporaryPath('public-estate')
        mkdirSync(join(estateRoot, 'web'), { recursive: true })
        mkdirSync(join(estateRoot, 'library'), { recursive: true })
        writeFileSync(join(estateRoot, 'web/package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
        writeFileSync(join(estateRoot, 'web/.env'), 'TOKEN=not-read')
        writeFileSync(join(estateRoot, 'library/pyproject.toml'), '[project]\nname = "library"\n')
        const canonical = realpathSync(estateRoot)
        const observed = await observePublicEstate({ root: canonical })
        expect(observed).toMatchObject({ root: canonical, repositories: [
            { slug: 'library', evidencePath: 'pyproject.toml', runnable: 'unknown' },
            { slug: 'web', evidencePath: 'package.json', runnable: 'confirmed' },
        ] })
        const first = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        writeFileSync(join(estateRoot, 'web/package.json'), JSON.stringify({ scripts: { dev: 'vite --host' } }))
        const second = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        expect(first).toMatchObject({ kind: 'complete', result: { classification: 'incomplete-multi-repository' } })
        expect(second).toMatchObject({ kind: 'complete', result: { classification: 'incomplete-multi-repository' } })
        if (first.kind !== 'complete' || second.kind !== 'complete') throw new Error('public observation did not classify')
        expect(first.result.sourceObservationSha256).not.toBe(second.result.sourceObservationSha256)
        expect(await documentObservedCommand({ root: canonical, configuration: {
            sourceObservationSha256: second.result.sourceObservationSha256,
            classification: second.result.classification, answers: [],
        } })).toMatchObject({ kind: 'gap-draft', question: { field: 'cockpit.name' } })
    })

    it('rejects caller-selected greenfield provenance before rendering', async () => {
        const estateRoot = temporaryPath('observed-estate')
        mkdirSync(join(estateRoot, 'web'), { recursive: true })
        writeFileSync(join(estateRoot, 'web/package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
        const canonical = realpathSync(estateRoot)
        expect(await documentObservedCommand({ root: canonical, configuration: {
            sourceObservationSha256: 'f'.repeat(64), classification: 'ready-multi-repository', answers: [],
        } })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_CHANGED' }] })
        const classified = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        if (classified.kind !== 'complete') throw new Error('public estate classification failed')
        expect(await documentObservedCommand({ root: canonical, configuration: {
            sourceObservationSha256: classified.result.sourceObservationSha256,
            classification: classified.result.classification, answers: [],
        } })).toMatchObject({ kind: 'gap-draft', question: { field: 'cockpit.name' } })
    })

    it('resolves a single unknown runnable gap and completes the interview with the Compose files that run it', async () => {
        const estateRoot = temporaryPath('unknown-estate')
        mkdirSync(join(estateRoot, 'app'), { recursive: true })
        writeFileSync(join(estateRoot, 'app/pyproject.toml'), '[project]\nname = "app"\n')
        const canonical = realpathSync(estateRoot)
        const classified = await classifyEstateObservation({ root: canonical }, { observe: observePublicEstate })
        expect(classified).toMatchObject({ kind: 'complete', result: {
            classification: 'one-sibling', gaps: [{ field: 'app.runnable' }],
        } })
        if (classified.kind !== 'complete') throw new Error('public estate classification failed')
        const configuration = { sourceObservationSha256: classified.result.sourceObservationSha256,
            classification: classified.result.classification, answers: [] as DocumentConfigurationAnswer[] }
        const answerQuestion = (question: NonNullable<Awaited<ReturnType<typeof documentObservedCommand>>['question']>, value: unknown) => {
            const bytes = JSON.stringify(value)
            return { questionId: question.id, bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
                provenance: 'operator-confirmed' as const }
        }
        let pending = await documentObservedCommand({ root: canonical, configuration })
        configuration.answers.push(answerQuestion(pending.question!, 'unknown-estate'))
        pending = await documentObservedCommand({ root: canonical, configuration })
        const changedDirectory = structuredClone(generatedConfig.sibling) as Record<string, unknown>[]
        changedDirectory[0] = { ...changedDirectory[0], dir: 'different-app' }
        expect(await documentObservedCommand({ root: canonical, configuration: { ...configuration,
            answers: [...configuration.answers, answerQuestion(pending.question!, changedDirectory)] } })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_ESTATE_TOPOLOGY_MISMATCH', target: 'sibling',
                message: 'the sibling answer must declare exactly the repositories init observed (app (dir "app")); it declares app (dir "different-app"), which init did not observe; it omits app (dir "app")',
                fix: 'declare one sibling for each repository the message says init observed, with that slug and dir, and no other; add any other repository after init with npx --no cockpit sibling add <slug> --config <your cockpit.toml>' }],
        })
        configuration.answers.push(answerQuestion(pending.question!, generatedConfig.sibling))
        pending = await documentObservedCommand({ root: canonical, configuration })
        expect(pending).toMatchObject({ kind: 'gap-draft', question: { field: 'estate.runnable' } })
        // The observed repositories are children of the root, so the draft says so at every step.
        expect(pending.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_INFERRED', target: 'cockpit.siblings_root' }))
        configuration.answers.push(answerQuestion(pending.question!, {
            app: { runnable: true, service: 'app', command: ['node', 'server.mjs'] },
        }))
        for (const value of [{ APP_HOST_PORT: 4100 }, generatedConfig.environment.install_policies,
            { seeded_data: false, signed_in_users: false }]) {
            pending = await documentObservedCommand({ root: canonical, configuration })
            configuration.answers.push(answerQuestion(pending.question!, value))
        }
        pending = await documentObservedCommand({ root: canonical, configuration })
        expect(pending).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.compose_files' } })
        configuration.answers.push(answerQuestion(pending.question!, ['compose.yml']))
        pending = await documentObservedCommand({ root: canonical, configuration })
        configuration.answers.push(answerQuestion(pending.question!, machineFloor))
        pending = await documentObservedCommand({ root: canonical, configuration })
        configuration.answers.push(answerQuestion(pending.question!, localPosture))
        pending = await documentObservedCommand({ root: canonical, configuration })
        configuration.answers.push(answerQuestion(pending.question!, 'none'))
        pending = await documentObservedCommand({ root: canonical, configuration })
        configuration.answers.push(answerQuestion(pending.question!, guardHosts))
        pending = await documentObservedCommand({ root: canonical, configuration })
        configuration.answers.push(answerQuestion(pending.question!, {
            confirmed: true, sha256: pending.question!.expectedSha256,
        }))
        expect(await documentObservedCommand({ root: canonical, configuration })).toMatchObject({ kind: 'complete', status: 0 })
    })
})

// A draft from a registry before any answer: the registry is read before the first question.
const pendingAnswers = { sourceObservationSha256: 'a'.repeat(64), answers: [] }
const draftFrom = (input: { root?: string; registry?: string }) =>
    documentCommand({ root: input.root ?? temporaryPath('synthetic-cockpit'), ...input, configuration: pendingAnswers })

describe('document source classification', () => {
    it('refuses invalid UTF-8 instead of changing registry content in the draft', async () => {
        const registry = temporaryPath('invalid-encoding.sh')
        writeFileSync(registry, Buffer.concat([
            Buffer.from('X_SIBLINGS=(\n  "api|api|api|app|API_DIR|'),
            Buffer.from([0xff]),
            Buffer.from('"\n)\n'),
        ]))

        const outcome = await draftFrom({ registry })

        expect(outcome.kind).toBe('refusal')
        expect(outcome.status).toBe(2)
        expect(outcome.artifact).toBeNull()
        expect(outcome.destination).toBeNull()
        expect(outcome.diagnostics).toEqual([
            expect.objectContaining({ code: 'REGISTRY_ENCODING_INVALID' }),
        ])
    })

    it('attributes a root-derived name without publishing the machine-local root', async () => {
        const { input } = sourceInput(laneFixture)
        const outcome = await draftFrom(input)
        const absoluteRoot = input.root as string

        expect(outcome.artifact).not.toContain(absoluteRoot)
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(absoluteRoot)
        expect(outcome.artifact).toContain('the positional cockpit root basename')
    })

    it('distinguishes missing, unreadable, empty, absent, and ambiguous registries', async () => {
        const missing = await draftFrom({ registry: temporaryPath('missing.sh') })

        const directory = temporaryPath('directory')
        mkdirSync(directory)
        const unreadable = await draftFrom({ registry: directory })

        const emptyPath = temporaryPath('empty.sh')
        writeFileSync(emptyPath, '')
        const empty = await draftFrom({ registry: emptyPath })

        const absentPath = temporaryPath('absent.sh')
        writeFileSync(absentPath, 'export EXAMPLE=value\n')
        const absent = await draftFrom({ registry: absentPath })

        const ambiguousPath = temporaryPath('ambiguous.sh')
        writeFileSync(
            ambiguousPath,
            'X_SIBLINGS=(\n  "a|a|a|app|A_DIR|purpose"\n  "b|b|b|main|auto|B_DIR|purpose"\n)\n',
        )
        const ambiguous = await draftFrom({ registry: ambiguousPath })

        expect(missing.diagnostics.map((item) => item.code)).toEqual(['REGISTRY_NOT_FOUND'])
        expect(missing.diagnostics[0]).toMatchObject({
            message: expect.stringContaining('--registry names an existing shell-registry cockpit'),
            fix: expect.stringContaining(`for a new product run: ${initCommand()}`),
        })
        expect(unreadable.diagnostics.map((item) => item.code)).toEqual(['REGISTRY_UNREADABLE'])
        expect(empty.diagnostics.map((item) => item.code)).toEqual(['REGISTRY_EMPTY'])
        expect(absent.diagnostics.map((item) => item.code)).toEqual(['REGISTRY_NOT_FOUND'])
        const ambiguityDiagnostics = ambiguous.diagnostics.filter((item) => item.code.startsWith('REGISTRY_'))
        expect(ambiguityDiagnostics.length).toBeGreaterThan(0)
        expect(ambiguityDiagnostics.every((item) => item.code === 'REGISTRY_AMBIGUOUS')).toBe(true)
        expect(ambiguous.diagnostics.some((item) => item.code === 'DOCUMENT_GAP')).toBe(true)
        for (const outcome of [missing, unreadable, empty, absent, ambiguous]) {
            expect(outcome.artifact).toBeNull()
        }
    })

    it('refuses an oversized registry before parsing it', async () => {
        const registry = temporaryPath('oversized.sh')
        writeFileSync(registry, Buffer.alloc(1_048_577, 0x20))

        const outcome = await draftFrom({ registry })

        expect(outcome).toMatchObject({
            kind: 'refusal', artifact: null, result: null,
            diagnostics: [expect.objectContaining({ code: 'REGISTRY_TOO_LARGE' })],
        })
    })

    it('classifies duplicate sibling arrays as structured registry ambiguity', async () => {
        const registry = temporaryPath('duplicate-arrays.sh')
        writeFileSync(registry, [
            'FIRST_SIBLINGS=(',
            '  "first|first|first|app|FIRST_DIR|purpose"',
            ')',
            'SECOND_SIBLINGS=(',
            '  "second|second|second|app|SECOND_DIR|purpose"',
            ')',
        ].join('\n'))

        const outcome = await draftFrom({ registry })
        const registryDiagnostics = outcome.diagnostics.filter((item) => item.code.startsWith('REGISTRY_'))

        expect(registryDiagnostics).toEqual([
            expect.objectContaining({ code: 'REGISTRY_AMBIGUOUS', target: 'registry line 4' }),
        ])
        expect(registryDiagnostics).not.toEqual([
            expect.objectContaining({ code: 'REGISTRY_ROW_SKIPPED' }),
        ])
    })

    it('refuses a multi-profile assignment without emitting a partial draft', async () => {
        const registry = temporaryPath('multi-profile.sh')
        writeFileSync(
            registry,
            'X_SIBLINGS=(\n  "app|app|app|main|auto|APP_DIR|EXTRA_PROFILES=web,api make run"\n)\n',
        )

        const outcome = await draftFrom({ registry })

        expect(outcome.kind).toBe('skipped-scope')
        expect(outcome.artifact).toBeNull()
        expect(outcome.diagnostics).toContainEqual(
            expect.objectContaining({
                severity: 'error',
                code: 'REGISTRY_AMBIGUOUS',
                target: 'registry line 2',
            }),
        )
    })

    it('keeps equal adjacent inferences separately attributed and in registry order', async () => {
        const registry = temporaryPath('equal-inferences.sh')
        writeFileSync(
            registry,
            [
                'X_SIBLINGS=(',
                '  "first|first|first|main|auto|FIRST_DIR|ordinary repository"',
                '  "second|second|second|main|auto|SECOND_DIR|ordinary repository"',
                ')',
                '',
            ].join('\n'),
        )

        const outcome = await draftFrom({ registry })
        const artifact = outcome.artifact ?? ''

        expect(artifact.match(/no profile and no make target in purpose/g)).toHaveLength(2)
        expect(artifact.indexOf('sibling.first.mount')).toBeLessThan(artifact.indexOf('sibling.second.mount'))
        expect(artifact.indexOf('slug = "first"')).toBeLessThan(artifact.indexOf('slug = "second"'))
        // Every decision shows its default as a comment. A person keeps reset, which deletes stack data,
        // and MCP approval, whose agent setting the block warns starts processes outside the guard.
        expect(artifact).toContain('# [work.gates]\n# accept = "agent"')
        expect(artifact).toContain('# reset = "person"')
        expect(artifact).toContain('# mcp_approve = "person"')
        expect(artifact).toContain('# mcp_approve = "agent" lets an agent start processes outside the guard')
    })

    it('never exposes a skipped source row or lets the command module write files', async () => {
        const registry = temporaryPath('skipped.sh')
        const rawRow = 'private-row-token|too|few'
        writeFileSync(registry, `X_SIBLINGS=(\n  "ok|ok|ok|app|OK_DIR|purpose"\n  "${rawRow}"\n)\n`)

        const outcome = await draftFrom({ registry })
        const commandSource = readFileSync(join(root, 'packages/cockpit/src/init/draft.ts'), 'utf8')
        const cliSource = readFileSync(join(root, 'packages/cockpit/src/cli.ts'), 'utf8')
        const commandTableSource = readFileSync(join(root, 'packages/cockpit/src/command-table.ts'), 'utf8')

        expect(outcome.kind).toBe('skipped-scope')
        expect(outcome.artifact).toBeNull()
        expect(outcome.diagnostics.find((item) => item.code === 'REGISTRY_ROW_SKIPPED')?.target).toBe('registry line 3')
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(rawRow)
        expect(commandSource).not.toMatch(/\bwriteFile\b/)
        expect(commandSource).not.toMatch(/command-table|\.\.\/cli/)
        expect(cliSource).not.toMatch(/\bparseRegistry\b|\bgaps\s*\(/)
        expect(commandTableSource).not.toMatch(/init\/draft|\.\/cli/)
        expect(commandSource).not.toMatch(/_SIBLINGS.*test\(source\)/)
    })

    it('preserves every inferred reason from a real tier registry', async () => {
        const registry = temporaryPath('tier.sh')
        writeFileSync(registry, tierFixture)

        const outcome = await draftFrom({ registry })
        const inferred = outcome.diagnostics.filter((item) => item.code === 'DOCUMENT_INFERRED' && item.target?.startsWith('sibling.'))

        expect(inferred).toHaveLength(9)
        expect(inferred.every((item) => item.message.length > 0)).toBe(true)
    })
})

describe('operator-confirmed document completion', () => {
    const sourceObservationSha256 = 'a'.repeat(64)
    const answer = (question: NonNullable<Awaited<ReturnType<typeof documentCommand>>['question']>, value: unknown) => {
        const bytes = JSON.stringify(value)
        return { questionId: question.id, bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'), provenance: 'operator-confirmed' as const }
    }
    const confirmDefaults = (question: NonNullable<Awaited<ReturnType<typeof documentCommand>>['question']>) =>
        answer(question, { confirmed: true, sha256: question.expectedSha256 })
    // The cockpit name is always asked first; these cases are about the answers after it.
    const answerName = async (input: { root: string }) => answer((await documentCommand({ ...input,
        configuration: { sourceObservationSha256, answers: [] } })).question!, 'app-cockpit')

    it('advances a real registry draft through explicit ports and defaults to a loadable document', async () => {
        const { input } = sourceInput('X_SIBLINGS=(\n  "app|app|app|app|APP_DIR|Synthetic application"\n)\n')
        const nameAnswer = await answerName(input)
        const configuration = { sourceObservationSha256, answers: [nameAnswer] }
        const ports = await documentCommand({ ...input, configuration })

        expect(ports).toMatchObject({ kind: 'gap-draft', question: { field: 'ports.bases' } })
        const rejected = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, answer(ports.question!, { APP_HOST_PORT: 'not-a-port' })],
        } })
        expect(rejected.diagnostics).toMatchObject([{
            code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            message: expect.stringContaining('bases.APP_HOST_PORT: Invalid input: expected number, received string'),
        }])
        const portAnswer = answer(ports.question!, { APP_HOST_PORT: 4100 })
        const policies = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer],
        } })
        expect(policies).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.install_policies' } })
        const policyAnswer = answer(policies.question!, generatedConfig.environment.install_policies)
        const generated = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer],
        } })
        expect(generated).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.compose_files' } })
        const generatedAnswer = answer(generated.question!, ['compose.yml'])
        const machine = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer],
        } })
        // Nothing reads a floor from the product, so the question must not claim one was looked for.
        expect(machine.question).toMatchObject({ field: 'environment.machine', why: expect.stringContaining('a person states: cockpit never proposes them') })
        const machineAnswer = answer(machine.question!, machineFloor)
        const posture = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer],
        } })
        const postureAnswer = answer(posture.question!, localPosture)
        const testingDraft = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer],
        } })
        const testingAnswer = answer(testingDraft.question!, 'none')
        const guards = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer],
        } })
        const guardAnswer = answer(guards.question!, guardHosts)
        const defaults = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer],
        } })
        expect(defaults).toMatchObject({ kind: 'gap-draft', question: {
            field: 'configuration.defaults', expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        } })
        expect(defaults.diagnostics.some(item => item.code === 'DOCUMENT_DEFAULT')).toBe(true)
        const complete = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer, confirmDefaults(defaults.question!)],
        } })

        expect(complete).toMatchObject({ kind: 'complete', status: 0, question: null })
        expect(parseToml(defaults.artifact!)).toEqual(parseToml(complete.artifact!))
        expect(CockpitConfig.parse(parseToml(complete.artifact!)).guards).toMatchObject(guardHosts)
        const configPath = temporaryPath('cockpit.toml')
        writeFileSync(configPath, complete.artifact!)
        expect(await loadCockpitConfig(configPath)).toMatchObject({ kind: 'complete', status: 0 })
    })

    it('completes compose-first from a Compose file the checkout already has', async () => {
        const { input } = sourceInput('X_SIBLINGS=(\n  "app|app|app|app|APP_DIR|Synthetic application"\n)\n')
        const nameAnswer = await answerName(input)
        const configuration = { sourceObservationSha256, answers: [nameAnswer] }
        const portAnswer = answer((await documentCommand({ ...input, configuration }))!.question!, {})
        const afterPorts = await documentCommand({ ...input, configuration: { ...configuration, answers: [nameAnswer, portAnswer] } })
        const policyAnswer = answer(afterPorts.question!, generatedConfig.environment.install_policies)
        const generated = await documentCommand({ ...input, configuration: { ...configuration, answers: [nameAnswer, portAnswer, policyAnswer] } })
        // A product with no Compose file is pointed at the one-time scaffold rather than left stuck.
        expect(generated.question!.why).toContain('npx --no cockpit init <cockpit root> --scaffold-compose <app dir> --port <port>')
        const composeAnswer = answer(generated.question!, ['compose.yml'])
        // Runtime commands refuse a declared runtime without a machine floor, and the floor is a
        // product requirement: it is asked, never defaulted.
        const machine = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, composeAnswer] } })
        expect(machine).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.machine' } })
        expect(await documentCommand({ ...input, configuration: { ...configuration, answers: [nameAnswer, portAnswer, policyAnswer,
            composeAnswer, answer(machine.question!, { runtime_memory_mb: 2048 })] } })).toMatchObject({ kind: 'refusal',
            diagnostics: [{ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID', message: expect.stringContaining('machine floor') }] })
        const machineAnswer = answer(machine.question!, machineFloor)
        // Preflight refuses a runtime whose posture is undeclared, so it is asked with a plain-localhost example.
        const posture = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, composeAnswer, machineAnswer] } })
        expect(posture).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.posture',
            why: expect.stringContaining(JSON.stringify(localPosture)) } })
        expect(await documentCommand({ ...input, configuration: { ...configuration, answers: [nameAnswer, portAnswer, policyAnswer,
            composeAnswer, machineAnswer, answer(posture.question!, { ...localPosture, authentication: 'real' })] } })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                message: expect.stringContaining('authentication posture real is not named by a requirement') }] })
        const postureAnswer = answer(posture.question!, localPosture)
        const testingDraft = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, composeAnswer, machineAnswer, postureAnswer] } })
        const testingAnswer = answer(testingDraft.question!, 'none')
        const guards = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, composeAnswer, machineAnswer, postureAnswer, testingAnswer] } })
        const guardAnswer = answer(guards.question!, guardHosts)
        const defaults = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, composeAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer] } })
        expect(defaults).toMatchObject({ kind: 'gap-draft', question: { field: 'configuration.defaults' } })
        expect(defaults.artifact).not.toContain('# [default] environment.compose_files')
        expect(defaults.artifact).toContain('# [default] environment.resettable_volumes = []')
        const complete = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, composeAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer, confirmDefaults(defaults.question!)] } })
        expect(complete).toMatchObject({ kind: 'complete', status: 0 })
        const document = parseToml(complete.artifact!) as { environment: { compose_files: string[]; machine?: unknown } }
        expect(document.environment.compose_files).toEqual(['compose.yml'])
        expect(document.environment.machine).toEqual(machineFloor)
        expect(document.environment).toMatchObject(localPosture)
        // "none" is a recorded decision, not a missing answer: no gate, and the file says why.
        expect(document).not.toHaveProperty('testing')
        expect(complete.artifact).toContain('# Decision: testing: no test gate is declared because the operator stated that the product has no tests to run yet')

        expect(testingDraft).toMatchObject({ kind: 'gap-draft', question: { field: 'testing' } })
        const declaredTesting = { stages: [{ id: 'app-test', command: ['make', 'test'], requires_stack: false }],
            gates: [{ id: 'app-full', tier: 'full', stages: ['app-test'], changes: 'Any behavior' }] }
        const throughTesting = (value: unknown) => [nameAnswer, portAnswer, policyAnswer, composeAnswer, machineAnswer, postureAnswer,
            answer(testingDraft.question!, value), guardAnswer]
        expect(await documentCommand({ ...input, configuration: { ...configuration, answers: throughTesting({ stages: [] }) } })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID', message: expect.stringContaining('"none" or a [testing] table') }] })
        const testedDefaults = await documentCommand({ ...input, configuration: { ...configuration, answers: throughTesting(declaredTesting) } })
        const tested = await documentCommand({ ...input, configuration: { ...configuration,
            answers: [...throughTesting(declaredTesting), confirmDefaults(testedDefaults.question!)] } })
        expect(parseToml(tested.artifact!)).toMatchObject({ testing: { ...declaredTesting, native_hooks: { install: 'inspect' } } })

        const empty = await documentCommand({ ...input, configuration: {
            ...configuration, answers: [nameAnswer, portAnswer, policyAnswer, answer(generated.question!, [])] } })
        expect(empty).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID',
            message: expect.stringContaining('at least one path') }] })
    })

    it('asks only missing logical groups without a registry and accepts explicit empty ports', async () => {
        const estateRoot = temporaryPath('Invalid_Name')
        mkdirSync(estateRoot)
        const base = { root: estateRoot, configuration: {
            sourceObservationSha256, classification: 'one-sibling' as const, answers: [],
        } }
        const name = await documentCommand(base)
        expect(name).toMatchObject({ kind: 'gap-draft', question: { field: 'cockpit.name' } })
        const nameAnswer = answer(name.question!, 'single-product')
        const sibling = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer],
        } })
        expect(sibling).toMatchObject({ kind: 'gap-draft', question: { field: 'sibling' } })
        const siblingAnswer = answer(sibling.question!, generatedConfig.sibling)
        const ports = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer],
        } })
        expect(ports).toMatchObject({ kind: 'gap-draft', question: { field: 'ports.bases' } })
        const portAnswer = answer(ports.question!, {})
        const policies = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer],
        } })
        expect(policies).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.install_policies' } })
        const policyAnswer = answer(policies.question!, generatedConfig.environment.install_policies)
        const testData = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer],
        } })
        expect(testData).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.test_data',
            why: expect.stringContaining('seeded data and signed-in users') } })
        expect(testData.question?.why).toContain('{ seeded_data: boolean, signed_in_users: boolean }')
        expect(await documentCommand({ ...base, configuration: { ...base.configuration,
            answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer,
                answer(testData.question!, { seeded_data: false })] } })).toMatchObject({ kind: 'refusal',
            diagnostics: [{ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID', target: 'environment.test_data' }] })
        const testDataAnswer = answer(testData.question!, { seeded_data: false, signed_in_users: false })
        const generated = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer],
        } })
        expect(generated).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.compose_files' } })
        const generatedAnswer = answer(generated.question!, ['compose.yml'])
        const machine = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer, generatedAnswer],
        } })
        const machineAnswer = answer(machine.question!, machineFloor)
        const posture = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer, generatedAnswer, machineAnswer],
        } })
        const postureAnswer = answer(posture.question!, localPosture)
        const testingDraft = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer, generatedAnswer, machineAnswer, postureAnswer],
        } })
        const testingAnswer = answer(testingDraft.question!, 'none')
        const guards = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer],
        } })
        const guardAnswer = answer(guards.question!, guardHosts)
        const defaults = await documentCommand({ ...base, configuration: {
            ...base.configuration, answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer],
        } })
        expect(defaults).toMatchObject({ kind: 'gap-draft', question: { field: 'configuration.defaults' } })
        // There is no registry here, so no default may be explained by one.
        expect(defaults.diagnostics.filter(item => item.code === 'DOCUMENT_DEFAULT').length).toBeGreaterThan(0)
        expect(defaults.artifact).not.toMatch(/registry dialect|source registry/)
        const complete = await documentCommand({ ...base, configuration: {
            ...base.configuration,
            answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, testDataAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer,
                confirmDefaults(defaults.question!)],
        } })
        expect(complete).toMatchObject({ kind: 'complete', status: 0 })
        expect(parseToml(defaults.artifact!)).toEqual(parseToml(complete.artifact!))
        expect(complete.artifact).toContain('# Decision: seeded data: not declared')
        expect(complete.artifact).toContain('# Decision: signed-in users: not declared')
        const requiredTestData = answer(testData.question!, { seeded_data: true, signed_in_users: true })
        const composeAnswer = answer(generated.question!, ['compose.yml'])
        const unresolvedDefaults = await documentCommand({ ...base, configuration: {
            ...base.configuration,
            answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, requiredTestData, composeAnswer, machineAnswer, postureAnswer, testingAnswer,
                guardAnswer],
        } })
        expect(unresolvedDefaults).toMatchObject({ kind: 'gap-draft', question: { field: 'configuration.defaults' } })
        expect(unresolvedDefaults.artifact).not.toContain('# [default] environment.compose_files')
        const unresolved = await documentCommand({ ...base, configuration: {
            ...base.configuration,
            answers: [nameAnswer, siblingAnswer, portAnswer, policyAnswer, requiredTestData, composeAnswer, machineAnswer, postureAnswer, testingAnswer,
                guardAnswer, confirmDefaults(unresolvedDefaults.question!)],
        } })
        expect(unresolved).toMatchObject({ kind: 'complete', status: 0 })
        expect(unresolved.artifact).toContain('# Decision: seeded data: required but unresolved')
        expect(unresolved.artifact).toContain('# Decision: signed-in users: required but unresolved')
        expect(parseToml(complete.artifact!)).toMatchObject({
            cockpit: { name: 'single-product', siblings_root: '.' },
            sibling: [{ slug: 'app' }], ports: { bases: {} },
        })
        expect(parseToml(complete.artifact!).cockpit).not.toHaveProperty('scope')
        expect(complete.diagnostics).toContainEqual(expect.objectContaining({
            code: 'DOCUMENT_INFERRED', target: 'cockpit.siblings_root',
            message: expect.stringContaining('authenticated greenfield estate'),
        }))
    })

    it('fills only registry sibling gaps and refuses changes to detected facts', async () => {
        const { input } = sourceInput(
            'X_SIBLINGS=(\n  "runner|runner|runner|host|RUNNER_DIR|production hardware runner"\n)\n',
        )
        const nameAnswer = await answerName(input)
        const pending = await documentCommand({ ...input, configuration: { sourceObservationSha256, answers: [nameAnswer] } })
        expect(pending).toMatchObject({ kind: 'gap-draft', question: { field: 'sibling' } })
        const sibling = {
            slug: 'runner', dir: 'runner', remote: 'runner', mount: 'host', acquire: 'auto',
            var: 'RUNNER_DIR', purpose: 'production hardware runner', toolchain: 'node',
            host_reason: 'requires a local display device', gate: 'operator',
        }
        expect(await documentCommand({ ...input, configuration: { sourceObservationSha256,
            answers: [nameAnswer, answer(pending.question!, [{ ...sibling, dir: 'changed' }])] } }))
            .toMatchObject({ kind: 'refusal', status: 2 })
        expect(await documentCommand({ ...input, configuration: { sourceObservationSha256,
            answers: [nameAnswer, answer(pending.question!, [sibling])] } }))
            .toMatchObject({ kind: 'gap-draft', question: { field: 'ports.bases' } })
    })

    it('refuses wrong, extra, malformed, sensitive and stale answers', async () => {
        const { input } = sourceInput('X_SIBLINGS=(\n  "app|app|app|app|APP_DIR|Synthetic application"\n)\n')
        const nameAnswer = await answerName(input)
        const pending = await documentCommand({ ...input, configuration: { sourceObservationSha256, answers: [nameAnswer] } })
        const valid = answer(pending.question!, { APP_HOST_PORT: 4100 })
        const policies = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid],
        } })
        const policyAnswer = answer(policies.question!, generatedConfig.environment.install_policies)
        const generated = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid, policyAnswer],
        } })
        const generatedAnswer = answer(generated.question!, ['compose.yml'])
        const machine = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid, policyAnswer, generatedAnswer],
        } })
        const machineAnswer = answer(machine.question!, machineFloor)
        const posture = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid, policyAnswer, generatedAnswer, machineAnswer],
        } })
        const postureAnswer = answer(posture.question!, localPosture)
        const testingDraft = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid, policyAnswer, generatedAnswer, machineAnswer, postureAnswer],
        } })
        const testingAnswer = answer(testingDraft.question!, 'none')
        const guards = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer],
        } })
        const guardAnswer = answer(guards.question!, guardHosts)
        const defaults = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, valid, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer],
        } })
        const cases = [
            [nameAnswer, { ...valid, questionId: `question:${'b'.repeat(64)}` }],
            [nameAnswer, { ...valid, bytes: '{', sha256: createHash('sha256').update('{').digest('hex') }],
            [nameAnswer, answer(pending.question!, { api_token: 'raw-secret-value' })],
        ]
        for (const answers of cases) {
            expect(await documentCommand({ ...input, configuration: { sourceObservationSha256, answers } }))
                .toMatchObject({ kind: 'refusal', status: 2 })
        }
        expect(await documentCommand({ ...input, configuration: { sourceObservationSha256,
            answers: [nameAnswer, valid, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer, confirmDefaults(defaults.question!), valid] } }))
            .toMatchObject({ kind: 'refusal', status: 2,
                diagnostics: [expect.objectContaining({ code: 'DOCUMENT_CONFIGURATION_ANSWER_EXTRA' })] })

        writeFileSync(join(input.root, 'env/lib/instance.sh'),
            'X_SIBLINGS=(\n  "api|api|api|app|API_DIR|Changed purpose"\n)\n')
        expect(await documentCommand({ ...input, configuration: { sourceObservationSha256, answers: [nameAnswer, valid] } }))
            .toMatchObject({ kind: 'refusal', status: 2 })
    })

    it('rejects missing or changed explicit confirmation of the surfaced defaults', async () => {
        const { input } = sourceInput('X_SIBLINGS=(\n  "app|app|app|app|APP_DIR|Synthetic application"\n)\n')
        const nameAnswer = await answerName(input)
        const ports = await documentCommand({ ...input, configuration: { sourceObservationSha256, answers: [nameAnswer] } })
        const portAnswer = answer(ports.question!, { APP_HOST_PORT: 4100 })
        const policies = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer],
        } })
        const policyAnswer = answer(policies.question!, generatedConfig.environment.install_policies)
        const generated = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer],
        } })
        const generatedAnswer = answer(generated.question!, ['compose.yml'])
        const machine = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer],
        } })
        const machineAnswer = answer(machine.question!, machineFloor)
        const posture = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer],
        } })
        const postureAnswer = answer(posture.question!, localPosture)
        const testingDraft = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer],
        } })
        const testingAnswer = answer(testingDraft.question!, 'none')
        const guards = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer],
        } })
        const guardAnswer = answer(guards.question!, guardHosts)
        const defaults = await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer],
        } })
        expect(defaults).toMatchObject({ kind: 'gap-draft', question: { field: 'configuration.defaults' } })
        const changed = answer(defaults.question!, { confirmed: true, sha256: 'f'.repeat(64) })
        expect(await documentCommand({ ...input, configuration: {
            sourceObservationSha256, answers: [nameAnswer, portAnswer, policyAnswer, generatedAnswer, machineAnswer, postureAnswer, testingAnswer, guardAnswer, changed],
        } })).toMatchObject({ kind: 'refusal', status: 2 })
    })

    it('confirms the same values for a one-repository estate as for any other estate', async () => {
        const estateRoot = temporaryPath('single-product')
        mkdirSync(estateRoot)
        const reachConfirmation = async (classification: 'one-sibling' | undefined) => {
            const configuration = { sourceObservationSha256, ...(classification ? { classification } : {}), answers: [] as ReturnType<typeof answer>[] }
            let pending = await documentCommand({ root: estateRoot, configuration })
            for (const value of ['single-product', generatedConfig.sibling, { APP_HOST_PORT: 4100 },
                generatedConfig.environment.install_policies, { seeded_data: false, signed_in_users: false },
                ['compose.yml'], machineFloor, localPosture, 'none', guardHosts]) {
                configuration.answers.push(answer(pending.question!, value))
                pending = await documentCommand({ root: estateRoot, configuration })
            }
            expect(pending).toMatchObject({ kind: 'gap-draft', question: { field: 'configuration.defaults' } })
            return { configuration, pending }
        }
        const estate = await reachConfirmation(undefined)
        const single = await reachConfirmation('one-sibling')
        // No value is inferred from the repository count, so one repository gets the same guards, settings and instructions.
        expect(single.pending.question!.expectedSha256).toBe(estate.pending.question!.expectedSha256)
        expect(await documentCommand({ root: estateRoot, configuration: { ...single.configuration, answers: [
            ...single.configuration.answers,
            answer(single.pending.question!, { confirmed: true, sha256: estate.pending.question!.expectedSha256 }),
        ] } })).toMatchObject({ kind: 'complete', status: 0 })
    })

    it('observes only the product repository a dedicated cockpit sits beside and declares it through siblings_root', async () => {
        const parent = realpathSync(temporaryPath('workspace').replace(/workspace$/, ''))
        for (const name of ['shop', 'unrelated', 'shop-cockpit']) mkdirSync(join(parent, name))
        writeFileSync(join(parent, 'shop/package.json'), JSON.stringify({ name: 'shop' }))
        writeFileSync(join(parent, 'shop/package-lock.json'), '{}\n')
        writeFileSync(join(parent, 'unrelated/package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
        expect(await observeCockpitRoot({ root: join(parent, 'shop') })).toBe('cockpit-root')
        mkdirSync(join(parent, 'shop/.git'))
        expect(await observeCockpitRoot({ root: join(parent, 'shop') })).toBe('product-repository')
        expect(await observeCockpitRoot({ root: join(parent, 'shop-cockpit') })).toBe('cockpit-root')
        mkdirSync(join(parent, 'worker'))
        mkdirSync(join(parent, 'worker/.git'))
        writeFileSync(join(parent, 'worker/Dockerfile'), 'FROM python:3.13-slim\nCMD ["python", "worker.py"]\n')
        expect(await observeCockpitRoot({ root: join(parent, 'worker') })).toBe('product-repository')
        writeFileSync(join(parent, 'worker/Dockerfile'), 'FROM scratch\n')
        expect(await observeCockpitRoot({ root: join(parent, 'worker') })).toBe('product-repository')
        writeFileSync(join(parent, 'worker/compose.yml'), 'services: {}\n')
        expect(await observeCockpitRoot({ root: join(parent, 'worker') })).toBe('product-repository')

        const scoped = await classifyEstateObservation({ root: parent, repositories: ['shop'] }, { observe: observePublicEstate })
        expect(scoped).toMatchObject({ kind: 'complete', result: { classification: 'no-runnable-product',
            runnable: [{ slug: 'shop', path: 'shop', disposition: 'absent' }] } })
        if (scoped.kind !== 'complete') throw new Error('scoped observation did not classify')
        const siblings = { root: parent, repositories: ['shop'] }
        const configuration = { sourceObservationSha256: scoped.result.sourceObservationSha256,
            classification: scoped.result.classification, answers: [] as ReturnType<typeof answer>[] }
        const cockpitRoot = join(parent, 'shop-cockpit')
        let pending = await documentObservedCommand({ root: cockpitRoot, estate: siblings, configuration })
        for (const value of ['shop-cockpit', [{ slug: 'shop', dir: 'shop', mount: 'none', acquire: 'none', var: 'SHOP_DIR', purpose: 'The shop' }],
            {}, { hosted_db_hosts: [], vendor_endpoint_hosts: [] }]) {
            configuration.answers.push(answer(pending.question!, value))
            pending = await documentObservedCommand({ root: cockpitRoot, estate: siblings, configuration })
        }
        configuration.answers.push(confirmDefaults(pending.question!))
        const completed = await documentObservedCommand({ root: cockpitRoot, estate: siblings, configuration })
        expect(completed, JSON.stringify(completed.diagnostics)).toMatchObject({ kind: 'complete' })
        expect(parseToml(completed.artifact!)).toMatchObject({ cockpit: { name: 'shop-cockpit', siblings_root: '..' },
            sibling: [{ slug: 'shop', dir: 'shop', toolchain: 'none' }] })
        // A defaulted toolchain names the lockfile it overrode instead of claiming nothing declares one.
        expect(completed.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_DEFAULT', target: 'sibling.shop.toolchain',
            message: '../shop/package-lock.json proposes the node toolchain, but the sibling answer leaves toolchain unset; materialised from the CockpitConfig schema default' }))
        // A repository the dedicated cockpit was not created for is never observed into its estate.
        expect(await classifyEstateObservation({ root: parent, repositories: ['missing'] }, { observe: observePublicEstate }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_INVALID' }] })
    })

    it('observes an in-repo cockpit\'s own manifest as its runnable sibling at "." and asks for its runtime', async () => {
        const product = realpathSync(temporaryPath('store').replace(/store$/, '')) + '/store'
        mkdirSync(join(product, 'src'), { recursive: true })
        writeFileSync(join(product, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }))
        mkdirSync(join(product, 'plugin'))
        writeFileSync(join(product, 'plugin', 'package.json'), JSON.stringify({ scripts: { dev: 'node plugin.mjs' } }))
        expect(await classifyEstateObservation({ root: product }, { observe: observePublicEstate }))
            .toMatchObject({ kind: 'complete', result: { classification: 'one-sibling',
                runnable: [{ slug: 'plugin', path: 'plugin', disposition: 'confirmed' }] } })
        const estate = { root: product, rootIsRepository: true as const }
        const observed = await classifyEstateObservation(estate, { observe: observePublicEstate })
        expect(observed).toMatchObject({ kind: 'complete', result: { classification: 'one-sibling',
            runnable: [{ slug: 'store', path: '.', disposition: 'confirmed' }] } })
        if (observed.kind !== 'complete') throw new Error('in-repo observation did not classify')
        const configuration = { sourceObservationSha256: observed.result.sourceObservationSha256,
            classification: observed.result.classification, answers: [] as ReturnType<typeof answer>[] }
        let pending = await documentObservedCommand({ root: product, estate, configuration })
        for (const value of ['store', [{ slug: 'store', dir: '.', mount: 'none', acquire: 'none', var: 'STORE_DIR', purpose: 'The store' }], {}]) {
            configuration.answers.push(answer(pending.question!, value))
            pending = await documentObservedCommand({ root: product, estate, configuration })
        }
        // The product keeps its runtime interview instead of collapsing to a surfaces-only cockpit.
        expect(pending, JSON.stringify(pending.diagnostics)).toMatchObject({ kind: 'gap-draft', question: { field: 'environment.install_policies' } })
    })

    it('binds an in-repo estate to its manifest while unrelated child directories change', async () => {
        const requested = temporaryPath('root-product')
        mkdirSync(requested)
        const product = realpathSync(requested)
        writeFileSync(join(product, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }))
        for (let index = 0; index < 65; index++) mkdirSync(join(product, `component-${index}`))
        const estate = { root: product, rootIsRepository: true as const }

        const observed = await classifyEstateObservation(estate, { observe: async input => {
            const value = await observePublicEstate(input)
            mkdirSync(join(product, 'another-component'))
            return value
        } })

        expect(observed).toMatchObject({ kind: 'complete', result: { classification: 'one-sibling',
            runnable: [{ path: '.', disposition: 'confirmed' }] } })
        const stale = await classifyEstateObservation(estate, { observe: async input => {
            const value = await observePublicEstate(input)
            writeFileSync(join(product, 'package.json'), JSON.stringify({ scripts: { start: 'node changed.mjs' } }))
            return value
        } })
        expect(stale).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_INVALID' }] })
    })

    it('completes a no-runnable estate as a surfaces-only configuration that states no runtime is declared', async () => {
        const estateRoot = temporaryPath('empty-product')
        mkdirSync(estateRoot)
        const configuration = { sourceObservationSha256, classification: 'no-runnable-product' as const, answers: [] as ReturnType<typeof answer>[] }
        let pending = await documentCommand({ root: estateRoot, configuration })
        for (const value of ['empty-product', generatedConfig.sibling, {}]) {
            configuration.answers.push(answer(pending.question!, value))
            pending = await documentCommand({ root: estateRoot, configuration })
        }
        // The guard governs the agent's commands whether or not anything runs, so the hosts are asked
        // here too; an explicit empty answer is kept as a recorded decision, not a silent default.
        expect(pending).toMatchObject({ kind: 'gap-draft', question: { field: 'guards', why: expect.stringContaining('production, staging, shared') } })
        expect(await documentCommand({ root: estateRoot, configuration: { ...configuration, answers: [...configuration.answers,
            answer(pending.question!, { hosted_db_hosts: [] })] } })).toMatchObject({ kind: 'refusal',
            diagnostics: [{ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID' }] })
        configuration.answers.push(answer(pending.question!, { hosted_db_hosts: [], vendor_endpoint_hosts: [] }))
        pending = await documentCommand({ root: estateRoot, configuration })
        expect(pending).toMatchObject({ kind: 'gap-draft', question: { field: 'configuration.defaults' } })
        expect(pending.diagnostics.map(row => row.target)).not.toContain('guards.hosted_db_hosts')
        configuration.answers.push(confirmDefaults(pending.question!))
        const completed = await documentCommand({ root: estateRoot, configuration })
        expect(completed).toMatchObject({ kind: 'complete', status: 0 })
        expect(parseToml(pending.artifact!)).toEqual(parseToml(completed.artifact!))
        expect(completed.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'DOCUMENT_RUNTIME_NOT_DECLARED' }))
        expect(completed.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'DOCUMENT_GUARD_HOSTS_NONE' }))
        expect(completed.artifact).toMatch(/^# Decision: guards: the operator stated that no non-local environment/m)
        const parsed = CockpitConfig.parse(parseToml(completed.artifact!))
        expect(parsed.environment.compose_files).toEqual([])
    })
})
