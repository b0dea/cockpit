import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { prepareSelectedBootstrapSurface, resumeSelectedBootstrapSurface, applySelectedBootstrapSurface, syncGeneratedEnvironment, checkGeneratedEnvironment } from '../generated-environment/command.js'
import { loadCockpitConfig } from '../config/load.js'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { runInitApplication, type InitApplicationAdapters, type InitApplicationInput } from './init-application.js'
import { runCli } from '../cli.js'
import { renderHumanValue } from '../diagnostics.js'
import { cockpitCommand, initCommand } from '../fix-catalogue.js'
import { classifyEstateObservation, draftFromEstate, observePublicEstate } from '../init/draft.js'
import { composeFindings } from '../init/derive.js'
import { readState, selectBootstrapStateRoot } from './state.js'
import { syncTeamGeneratedEnvironment } from './generated-application/sync.js'
import { inspectInitReadiness } from './readiness-composition.js'
import { executeProbe } from '../environment-exec/execute.js'
import { digest, fixture, removeInitApplicationFixtures } from '../../test-support/init-application-fixture.js'
import { stubComposeTopology } from '../../test-support/compose-topology-docker.js'

// End-to-end init runs through the real bootstrap, document and generated-environment owners.
afterEach(removeInitApplicationFixtures)

it.each([false, true])('composes observed greenfield answers and surfaces review values (large purpose: %s)', async largePurpose => {
    const f = fixture()
    mkdirSync(join(f.root, 'app'))
    mkdirSync(join(f.root, 'fixtures'))
    const packageBytes = JSON.stringify({ scripts: { start: 'node server.mjs' } })
    await writeFile(join(f.root, 'app/package.json'), packageBytes)
    await writeFile(join(f.root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    await writeFile(join(f.root, 'compose.yml'),
        'services:\n  app:\n    image: synthetic.invalid/app:1\n    ports: ["127.0.0.1:${APP_HOST_PORT:-4100}:3000"]\n    volumes: ["./app:/app"]\n')
    await stubComposeTopology({ app: { image: 'synthetic.invalid/app:1', ports: ['127.0.0.1:${APP_HOST_PORT:-4100}:3000'],
        volumes: [{ type: 'bind', source: join(f.root, 'app'), target: '/app' }] } })
    const sourceConfig = parseToml(await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')) as {
        sibling: Record<string, unknown>[]; ports: { bases: unknown }; environment: { install_policies: unknown }
    }
    if (largePurpose) sourceConfig.sibling[0]!.purpose = 'p'.repeat(65_000)
    const synchronizeInputs: boolean[] = []
    let defaultsDocument: string | undefined
    const adapters: InitApplicationAdapters = {
        ...f.adapters,
        prepareBootstrap: prepareSelectedBootstrapSurface,
        resumeBootstrap: resumeSelectedBootstrapSurface,
        applyBootstrap: applySelectedBootstrapSurface,
        document: async input => {
            const outcome = await draftFromEstate(input)
            if (outcome.question?.field === 'configuration.defaults') defaultsDocument = outcome.artifact ?? undefined
            return outcome
        },
        classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
        composeFindings,
        observeDestination: async ({ path }) => {
            if (!existsSync(path)) return { kind: 'absent' }
            return { kind: 'available', sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
        },
        validateConfig: loadCockpitConfig,
        synchronize: input => {
            synchronizeInputs.push(input.bootstrapState !== undefined)
            return syncGeneratedEnvironment(input)
        },
        check: checkGeneratedEnvironment,
    }
    const greenfieldInput: InitApplicationInput = {
        // Two tools chosen: the first gets the setup skill before the interview, and both are written once it ends.
        root: f.root, target: f.input.target, tools: [f.input.target, 'claudecode'], accepted: false, sessionId: f.input.sessionId,
        platform: f.input.platform, home: f.input.home, xdgStateHome: f.input.xdgStateHome,
    }
    const preview = await runInitApplication(greenfieldInput, adapters)
    expect(preview.kind).toBe('pending')
    const accepted = { ...greenfieldInput, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
    let outcome = await runInitApplication(accepted, adapters)
    for (let count = 0; outcome.kind === 'pending' && outcome.result?.question; count += 1) {
        expect(count).toBeLessThan(11)
        const question = outcome.result.question
        if (question.field === 'configuration.defaults') {
            if (largePurpose) expect(Buffer.byteLength(defaultsDocument!)).toBeGreaterThan(65_536)
            expect(defaultsDocument).toContain('# [default] ')
            expect(defaultsDocument).toContain('# [inferred] ')
            expect(outcome).toMatchObject({ artifact: null, destination: null,
                result: { question: { document: defaultsDocument!.split('\n') } } })
            expect(question.document!.join('\n')).toBe(defaultsDocument)
            expect(existsSync(f.destination)).toBe(false)
            let interactiveReview = ''
            expect(await runCli(['init', f.root, '--target', 'codexcli', '--interactive'], {
                stdout: { write: () => true }, stderr: { write: () => true },
                answerInitQuestion: async current => {
                    interactiveReview = renderHumanValue(current)
                    return undefined
                },
            }, { init: () => runInitApplication(greenfieldInput, adapters) })).toBe(2)
            expect(interactiveReview).toContain(question.expectedSha256)
            expect(interactiveReview).toContain(sourceConfig.sibling[0]!.purpose)
            for (const line of defaultsDocument!.split('\n').filter(line => line.startsWith('# [default]') || line.startsWith('# [inferred]'))) {
                expect(interactiveReview).toContain(line)
            }
            for (const json of [false, true]) {
                let stdout = ''
                expect(await runCli(['init', f.root, '--target', 'codexcli', ...(json ? ['--json'] : [])], {
                    stdout: { write: value => { stdout += value; return true } },
                    stderr: { write: () => true },
                }, { init: () => runInitApplication(greenfieldInput, adapters) })).toBe(0)
                if (json) expect(JSON.parse(stdout).result.question.document.join('\n')).toBe(defaultsDocument)
                else {
                    expect(stdout).toContain(question.expectedSha256)
                    expect(stdout).toContain(sourceConfig.sibling[0]!.purpose)
                    for (const line of defaultsDocument!.split('\n').filter(line => line.startsWith('# [default]') || line.startsWith('# [inferred]'))) {
                        expect(stdout).toContain(line)
                    }
                }
            }
            expect(existsSync(f.destination)).toBe(false)
            expect(await runInitApplication({ ...accepted, greenfieldAnswer: {
                questionId: question.id, bytes: JSON.stringify({ confirmed: true, sha256: digest('0') }),
                provenance: 'operator-confirmed',
            } }, adapters)).toMatchObject({ kind: 'refusal', status: 2,
                diagnostics: expect.arrayContaining([{ severity: 'error', code: 'DOCUMENT_DEFAULT_CONFIRMATION_INVALID',
                    message: expect.any(String), target: 'configuration.defaults' }]) })
            expect(existsSync(f.destination)).toBe(false)
            if (largePurpose) return
        }
        const value = question.field === 'cockpit.name' ? 'checkout' : question.field === 'sibling' ? sourceConfig.sibling
            : question.field === 'ports.bases' ? sourceConfig.ports.bases
                : question.field === 'environment.install_policies' ? sourceConfig.environment.install_policies
                : question.field === 'environment.test_data' ? { seeded_data: false, signed_in_users: false }
                : question.field === 'environment.compose_files' ? ['compose.yml']
                : question.field === 'environment.machine'
                    ? { runtime_memory_mb: 2048, runtime_cpus: 2, free_disk_mb: 10240, cold_start_seconds: 120 }
                : question.field === 'environment.posture' ? { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
                : question.field === 'testing' ? 'none'
                : question.field === 'guards' ? { hosted_db_hosts: [], vendor_endpoint_hosts: [] }
                    : question.field === 'configuration.defaults'
                        ? { confirmed: true, sha256: question.expectedSha256 }
                        : undefined
        expect(value, question.field).toBeDefined()
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes: JSON.stringify(value), provenance: 'operator-confirmed',
        } }, adapters)
    }
    const artifact = outcome
    expect(artifact.kind, JSON.stringify(artifact)).toBe('artifact')
    // The Compose file publishes its port from a ports.bases variable, so check's findings have nothing to add beyond the healthcheck.
    expect(artifact.diagnostics.map(row => row.code)).not.toContain('COMPOSE_PORT_NOT_LEASED')
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ kind: 'refusal' })
    await writeFile(join(f.root, 'app/package.json'), JSON.stringify({ scripts: { start: 'node changed.mjs' } }))
    expect(await runInitApplication(accepted, adapters)).toMatchObject({ kind: 'refusal', status: 2,
        diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_CHANGED' }] })
    await writeFile(join(f.root, 'app/package.json'), packageBytes)
    await writeFile(f.destination, artifact.artifact!)
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ kind: 'complete', status: 0,
        result: { config: { cockpit: expect.not.objectContaining({ scope: expect.anything() }), environment: { compose_files: ['compose.yml'] } } } })
    const completed = await runInitApplication(accepted, adapters)
    expect(completed, JSON.stringify(completed)).toMatchObject({ kind: 'complete', status: 0,
        result: { stage: 'environment-verified' } })
    expect(synchronizeInputs).toEqual([true])
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ result: { config: { surfaces: { tools: ['codexcli', 'claudecode'] } } } })
    for (const skill of ['.agents/skills/cockpit-setup/SKILL.md', '.claude/skills/cockpit-setup/SKILL.md']) expect(existsSync(join(f.root, skill)), skill).toBe(true)
    expect(existsSync(join(f.root, '.opencode'))).toBe(false)
}, 120_000)

// Sync writes the cockpit's package pin and scripts into the root package.json, editing the
// product's own manifest or creating one beside a Compose-only product.
it.each([
    ['its own package manifest', { name: 'synthetic-shop', scripts: { test: 'node test.mjs' } }],
    ['only a Compose file', undefined],
] as const)('resumes an in-repo init of a product with %s after sync wrote into it, and still refuses a product change', async (_shape, productManifest) => {
    const f = fixture()
    if (productManifest) await writeFile(join(f.root, 'package.json'), `${JSON.stringify(productManifest)}\n`)
    const composeBytes = 'services:\n  web:\n    image: synthetic.invalid/web:1\n    ports: ["127.0.0.1:${WEB_HOST_PORT:-4100}:80"]\n'
    await writeFile(join(f.root, 'compose.yml'), composeBytes)
    // The first bring-up has not happened yet, so preflight stops the run as it does on a fresh machine.
    let preflight: InitApplicationAdapters['preflight'] = async () => ({ kind: 'blocked', status: 2, result: null,
        diagnostics: [{ severity: 'error', code: 'STATE_UNSEEDED', message: 'synthetic: lifecycle is still in bootstrap' }] })
    const adapters: InitApplicationAdapters = {
        ...f.adapters,
        prepareBootstrap: prepareSelectedBootstrapSurface,
        resumeBootstrap: resumeSelectedBootstrapSurface,
        applyBootstrap: applySelectedBootstrapSurface,
        document: draftFromEstate,
        classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
        observeDestination: async ({ path }) => {
            if (!existsSync(path)) return { kind: 'absent' }
            return { kind: 'available', sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
        },
        validateConfig: loadCockpitConfig,
        // The production binding: sync also writes the cockpit's package pin and scripts.
        synchronize: input => syncTeamGeneratedEnvironment(input),
        preflight: input => preflight(input),
    }
    // A plain sync finds init's state where this machine keeps it, so init records it there too.
    const input: InitApplicationInput = { root: f.root, target: f.input.target, tools: [f.input.target], accepted: false, sessionId: f.input.sessionId,
        platform: process.platform as 'darwin' | 'linux', home: f.input.home, xdgStateHome: f.input.xdgStateHome, cockpitRoot: { kind: 'in-repo' } }
    const preview = await runInitApplication(input, adapters)
    const accepted = { ...input, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
    let outcome = await runInitApplication(accepted, adapters)
    for (let count = 0; outcome.kind === 'pending' && outcome.result?.question; count += 1) {
        expect(count).toBeLessThan(11)
        const question = outcome.result.question
        const value = question.field === 'cockpit.name' ? 'synthetic-shop' : question.field === 'sibling'
            ? [{ slug: 'checkout', dir: '.', mount: 'none', acquire: 'none', var: 'CHECKOUT_DIR', purpose: 'Synthetic shop' }]
            : question.field === 'ports.bases' ? { WEB_HOST_PORT: 4100 }
                : question.field === 'environment.install_policies' ? []
                    : question.field === 'environment.test_data' ? { seeded_data: false, signed_in_users: false }
                        : question.field === 'environment.compose_files' ? ['compose.yml']
                            : question.field === 'environment.machine'
                                ? { runtime_memory_mb: 256, runtime_cpus: 1, free_disk_mb: 512, cold_start_seconds: 120 }
                                : question.field === 'environment.posture' ? { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
                                    : question.field === 'testing' ? 'none'
                                    : question.field === 'guards' ? { hosted_db_hosts: [], vendor_endpoint_hosts: [] }
                                        : question.field === 'configuration.defaults' ? { confirmed: true, sha256: question.expectedSha256 }
                                            : undefined
        expect(value, question.field).toBeDefined()
        // The setup agent was told to pick sensible defaults, and said which answers it picked.
        const provenance = question.field === 'environment.machine' || question.field === 'guards' ? 'agent-default' : 'operator-confirmed'
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes: JSON.stringify(value), provenance,
        } }, adapters)
    }
    expect(outcome.kind, JSON.stringify(outcome)).toBe('artifact')
    const drafted = parseToml(outcome.artifact!) as { cockpit: { name: string }; unconfirmed: string[] }
    expect(drafted.cockpit.name).toBe('synthetic-shop')
    // Values the agent chose are not recorded as the operator's: each says who chose it, and stays listed until a person confirms it.
    expect(drafted.unconfirmed).toEqual(['environment.machine', 'guards'])
    expect(outcome.artifact).toMatch(/^# Unconfirmed: environment\.machine was chosen by the setup agent as a default/m)
    expect(outcome.artifact).toContain('# Decision: guards: the setup agent assumed, as a default, that no non-local environment')
    expect(outcome.artifact).not.toContain('the operator stated that no non-local environment')
    expect(outcome.result).toMatchObject({ unconfirmed: [{ field: 'environment.machine', provenance: 'agent-default' },
        { field: 'guards', provenance: 'agent-default' }] })
    await writeFile(f.destination, outcome.artifact!)
    // A stop before init's own sync leaves init's setup skill with no ownership record. A plain sync
    // refused it as foreign and told the agent to delete it; it now adopts init's own publication.
    const unvalidated = await runInitApplication(accepted, { ...adapters, validateConfig: async () => ({ kind: 'refusal', status: 2,
        result: null, diagnostics: [{ severity: 'error', code: 'CONFIG_SCHEMA_INVALID', message: 'synthetic' }] }) })
    expect(unvalidated).toMatchObject({ kind: 'refusal',
        diagnostics: [{ code: 'CONFIG_SCHEMA_INVALID' }, { code: 'INIT_VERIFICATION_INCOMPLETE' }] })
    vi.stubEnv('HOME', f.input.home)
    vi.stubEnv('XDG_STATE_HOME', f.input.xdgStateHome)
    // A setup file that no longer holds what init published cannot be adopted; the refusal names the
    // unfinished init and how to resume it rather than only calling the file unrecorded.
    const setupSkill = ['.agents/skills/cockpit-setup/SKILL.md', '.claude/skills/cockpit-setup/SKILL.md'].find(path => existsSync(join(f.root, path)))!
    const setupBytes = await readFile(join(f.root, setupSkill), 'utf8')
    await writeFile(join(f.root, setupSkill), `${setupBytes}hand edit\n`)
    const unadopted = await syncTeamGeneratedEnvironment({ configPath: f.destination })
    expect(unadopted).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SURFACE_STATE_CONFLICT', target: setupSkill,
        message: expect.stringContaining(`an unfinished init for this root (--target ${f.input.target}) published it`),
        fix: expect.stringContaining(`resume that init with ${initCommand({ root: f.root, target: f.input.target })} and the options you started it with`) }] })
    await writeFile(join(f.root, setupSkill), setupBytes)
    const plainSync = await syncTeamGeneratedEnvironment({ configPath: f.destination }).finally(() => vi.unstubAllEnvs())
    expect(plainSync, JSON.stringify(plainSync.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })
    // A run that stops after the draft still names what no person confirmed, and which prerequisites
    // are missing: an agent sees only this last outcome. init ran from a copy of cockpit outside the root.
    const stopped = await runInitApplication(accepted, { ...adapters,
        inspectReadiness: input => inspectInitReadiness(input, { env: process.env, timeoutMs: 5_000, execute: executeProbe }) })
    // This fixture root is not a Git working tree either.
    expect(stopped).toMatchObject({ kind: 'refusal',
        diagnostics: [{ code: 'STATE_UNSEEDED' }, { code: 'INIT_VERIFICATION_INCOMPLETE' }, { code: 'COCKPIT_NOT_INSTALLED' },
            { code: 'SETUP_PATH_TYPE_INVALID' }],
        result: { unconfirmed: [{ field: 'environment.machine' }, { field: 'guards' }],
            readiness: { state: 'runtime', gaps: [{ id: 'cockpit-git', level: 'required' }, { id: 'cockpit-installed', level: 'recommended' }] } } })
    expect(JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8'))).toMatchObject({
        ...productManifest, scripts: { ...productManifest?.scripts, 'cockpit:sync': 'cockpit sync --config cockpit.toml' },
        devDependencies: { '@b00dea/cockpit': expect.any(String) } })

    // A product source changed after acceptance is still a different estate. Rerunning init alone
    // refuses again, so the remedy names both ways out.
    await writeFile(join(f.root, 'compose.yml'), composeBytes.replace('web:1', 'web:2'))
    for (let rerun = 0; rerun < 2; rerun += 1) expect(await runInitApplication(accepted, adapters)).toMatchObject({ kind: 'refusal',
        diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_CHANGED', fix: `restore the product files changed since init drafted cockpit.toml, then rerun ${initCommand({ root: f.root, target: f.input.target, args: `--accept-preview ${accepted.acceptedPreviewSha256}` })}; to keep the change instead, finish without init: run ${cockpitCommand('sync', { config: f.destination })}, then ${cockpitCommand('check', { config: f.destination })}` }] })
    await writeFile(join(f.root, 'compose.yml'), composeBytes)

    preflight = f.adapters.preflight
    const resumed = await runInitApplication(accepted, adapters)
    expect(resumed, JSON.stringify(resumed.diagnostics)).toMatchObject({ kind: 'complete', result: { stage: 'environment-verified',
        unconfirmed: [{ field: 'environment.machine' }, { field: 'guards' }] } })
}, 120_000)


it.each(['scalar', 'artifact'] as const)('refuses an unreviewable defaults draft before confirmation (%s bound)', async bound => {
    const f = fixture()
    mkdirSync(join(f.root, 'app'))
    mkdirSync(join(f.root, 'fixtures'))
    await writeFile(join(f.root, 'app/package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }))
    await writeFile(join(f.root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    const sourceConfig = parseToml(await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')) as {
        sibling: { purpose: string }[]; ports: { bases: Record<string, number> }; environment: { install_policies: unknown[] }
    }
    const guards = { hosted_db_hosts: [] as string[], vendor_endpoint_hosts: [] as string[] }
    // TOML spends one byte more per array item than JSON, so this answer fits the 64 KiB answer
    // bound and still renders one line over it.
    const scalarComposeFiles = Array.from({ length: 6_300 }, (_, index) => `${index.toString(36).padStart(3, '0')}.yml`)
    if (bound === 'artifact') {
        sourceConfig.sibling[0]!.purpose = 'p'.repeat(60_000)
        sourceConfig.ports.bases['A'.repeat(60_000)] = 4101
        const word = 'w'.repeat(127)
        sourceConfig.environment.install_policies.push(...Array.from({ length: 7 }, (_, index) => ({
            toolchain: 'node', lockfile: `locks/${index}/package-lock.json`, build: Array(32).fill(word), test: Array(32).fill(word),
        })))
        for (let index = 0; index < 128; index += 1) {
            const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${index}.example.test`
            guards.hosted_db_hosts.push(`db.${host}`)
            guards.vendor_endpoint_hosts.push(`vendor.${host}`)
        }
    }
    let defaultsDocument: string | undefined
    const adapters: InitApplicationAdapters = {
        ...f.adapters,
        prepareBootstrap: prepareSelectedBootstrapSurface,
        resumeBootstrap: resumeSelectedBootstrapSurface,
        applyBootstrap: applySelectedBootstrapSurface,
        document: async input => {
            const outcome = await draftFromEstate(input)
            if (outcome.question?.field === 'configuration.defaults') defaultsDocument = outcome.artifact ?? undefined
            return outcome
        },
        classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
    }
    const input = { ...f.input, registry: undefined }
    const preview = await runInitApplication(input, adapters)
    const accepted = { ...input, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
    let outcome = await runInitApplication(accepted, adapters)
    for (let count = 0; outcome.kind === 'pending' && outcome.result?.question
        && outcome.result.question.field !== 'configuration.defaults'; count += 1) {
        expect(count).toBeLessThan(10)
        const question = outcome.result.question
        const value = question.field === 'cockpit.name' ? 'checkout' : question.field === 'sibling' ? sourceConfig.sibling
            : question.field === 'ports.bases' ? sourceConfig.ports.bases
                : question.field === 'environment.install_policies' ? sourceConfig.environment.install_policies
                    : question.field === 'environment.test_data' ? { seeded_data: false, signed_in_users: false }
                        : question.field === 'environment.compose_files' ? ['compose.yml',
                            ...bound === 'artifact' ? Array.from({ length: 7 }, (_, index) => `${'c'.repeat(8_000)}${index}.yml`) : scalarComposeFiles]
                            : question.field === 'environment.machine'
                                ? { runtime_memory_mb: 2048, runtime_cpus: 2, free_disk_mb: 10240, cold_start_seconds: 120 }
                                : question.field === 'environment.posture' ? { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
                                : question.field === 'testing' ? 'none'
                                : question.field === 'guards' ? guards : undefined
        expect(value, question.field).toBeDefined()
        const bytes = JSON.stringify(value)
        expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(65_536)
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes, provenance: 'operator-confirmed',
        } }, adapters)
    }
    expect(defaultsDocument, JSON.stringify(outcome)).toBeDefined()
    if (bound === 'scalar') {
        expect(Buffer.byteLength(defaultsDocument!)).toBeLessThan(262_144)
        expect(defaultsDocument!.split('\n').some(line => Buffer.byteLength(line) > 65_536)).toBe(true)
    } else {
        expect(Buffer.byteLength(defaultsDocument!)).toBeGreaterThan(262_144)
        expect(defaultsDocument!.split('\n').every(line => Buffer.byteLength(line) <= 65_536)).toBe(true)
    }
    expect(outcome).toMatchObject({ kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
        diagnostics: [{ code: 'INIT_DRAFT_INVALID', message: expect.stringContaining('--reset-answer') }] })
    expect(existsSync(f.destination)).toBe(false)
    const selected = await selectBootstrapStateRoot({ platform: input.platform, home: input.home,
        xdgStateHome: input.xdgStateHome, checkoutRoot: input.root, target: input.target })
    if (selected.kind !== 'complete') throw new Error(JSON.stringify(selected))
    const saved = await readState(selected.value.paths.bootstrap(input.target))
    if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
    expect(saved.value.value.greenfield!.questions.some(question => question.field === 'configuration.defaults')).toBe(false)
}, 120_000)
