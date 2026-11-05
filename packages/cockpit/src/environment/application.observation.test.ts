import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application/check.js'
import { RefusalError } from './contract.js'
import { ObservationProducerRefusal } from './application/health.js'
import { cockpitPackageVersion } from '../test-support/package-version.js'
import { observeMcpStartup } from './mcp-observation.js'
const applicationOwners = vi.hoisted(() => ({
    logs: {} as Partial<Pick<typeof import('./logs.js'), 'collectLogs' | 'planLogs'>>,
    observations: {} as Partial<Pick<typeof import('./observations.js'), 'aggregateObservations' | 'projectDoctor'>>,
    gitObservation: {} as Partial<Pick<typeof import('./git-observation.js'), 'createComparisonRemoteRefStep' | 'createGitObservationStep' | 'observeComparisonRemoteRef' | 'observeComparisonRemoteRevalidation' | 'observeComparisonRemoteUrl' | 'observeGit'>>,
}))
vi.mock('./logs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./logs.js')>()
    return {
        ...actual,
        collectLogs: (...args: Parameters<typeof actual.collectLogs>) => applicationOwners.logs.collectLogs?.(...args) ?? actual.collectLogs(...args),
        planLogs: (...args: Parameters<typeof actual.planLogs>) => applicationOwners.logs.planLogs?.(...args) ?? actual.planLogs(...args),
    }
})
vi.mock('./observations.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./observations.js')>()
    return {
        ...actual,
        aggregateObservations: (...args: Parameters<typeof actual.aggregateObservations>) => applicationOwners.observations.aggregateObservations?.(...args) ?? actual.aggregateObservations(...args),
        projectDoctor: (...args: Parameters<typeof actual.projectDoctor>) => applicationOwners.observations.projectDoctor?.(...args) ?? actual.projectDoctor(...args),
    }
})
vi.mock('./git-observation.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./git-observation.js')>()
    return {
        ...actual,
        createComparisonRemoteRefStep: (...args: Parameters<typeof actual.createComparisonRemoteRefStep>) => applicationOwners.gitObservation.createComparisonRemoteRefStep?.(...args) ?? actual.createComparisonRemoteRefStep(...args),
        createGitObservationStep: (...args: Parameters<typeof actual.createGitObservationStep>) => applicationOwners.gitObservation.createGitObservationStep?.(...args) ?? actual.createGitObservationStep(...args),
        observeComparisonRemoteRef: (...args: Parameters<typeof actual.observeComparisonRemoteRef>) => applicationOwners.gitObservation.observeComparisonRemoteRef?.(...args) ?? actual.observeComparisonRemoteRef(...args),
        observeComparisonRemoteRevalidation: (...args: Parameters<typeof actual.observeComparisonRemoteRevalidation>) => applicationOwners.gitObservation.observeComparisonRemoteRevalidation?.(...args) ?? actual.observeComparisonRemoteRevalidation(...args),
        observeComparisonRemoteUrl: (...args: Parameters<typeof actual.observeComparisonRemoteUrl>) => applicationOwners.gitObservation.observeComparisonRemoteUrl?.(...args) ?? actual.observeComparisonRemoteUrl(...args),
        observeGit: (...args: Parameters<typeof actual.observeGit>) => applicationOwners.gitObservation.observeGit?.(...args) ?? actual.observeGit(...args),
    }
})
import { loadCockpitConfig } from '../config/load.js'
import { runDoctor, type DoctorSurfaceOverrideInspection } from './application/doctor.js'
import { runPreflight, type HealthObservationSource, type HealthObservationSourceInput } from './application/health.js'
import { runLogs } from './application/logs.js'
import {
    observeSetupCheckout,
    withSetupCheckoutProjection,
} from './setup-observation.js'
import type { PreflightContext } from './observations.js'
import { checkoutId, cockpitId, stackId } from './identity.js'
import { createApplicationFixtureSupport } from '../../test-support/application-fixture.js'

const scratch: string[] = []
const gitDirectory = mkdtempSync(join(tmpdir(), 'cockpit-application-git-'))
const gitCanonicalPath = join(gitDirectory, 'git-executable')
const gitInvocationPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
writeFileSync(gitCanonicalPath, `#!/bin/sh\nexec ${JSON.stringify(gitInvocationPath)} "$@"\n`, { mode: 0o700 })
const gitExecutable = {
    canonicalPath: gitCanonicalPath,
    invocationPath: gitInvocationPath,
    sha256: createHash('sha256').update(readFileSync(gitCanonicalPath)).digest('hex'),
    executionMode: 'verified-path' as const,
}

afterEach(() => {
    vi.restoreAllMocks()
    applicationOwners.logs = {}
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(gitDirectory, { recursive: true, force: true }))

const { unissuedContextFixture } = createApplicationFixtureSupport(scratch, gitExecutable)

describe('observation application runners', () => {
    afterEach(() => {
        applicationOwners.observations = {}
        applicationOwners.gitObservation = {}
        applicationOwners.logs.planLogs = undefined
        applicationOwners.logs.collectLogs = undefined
    })

    const passed = Object.freeze({
        verdict: 'pass' as const,
        revision: '1'.repeat(64),
        checks: Object.freeze([]),
    })
    const context = Object.freeze({
        authorities: Object.freeze([]),
        stages: Object.freeze([{ stage: 'steady' }]),
    }) as never
    const commandInput = Object.freeze({ configPath: '/synthetic/cockpit.toml' })

    it('awaits one canonical currentness and separate release freshness even when doctor health is unavailable', async () => {
        const prepare = vi.spyOn(generatedCurrentnessOwner, 'prepareGeneratedEnvironmentCurrentness')
        const release = vi.fn(async () => ({ kind: 'unknown' as const, reason: 'synthetic registry unavailable' }))
        try {
            const result = await runDoctor(commandInput, { load: async () => undefined, execute: vi.fn(), discoverReleaseFreshness: release })
            expect(prepare).toHaveBeenCalledExactlyOnceWith(commandInput)
            expect(release).toHaveBeenCalledTimes(1)
            expect(result.result).toMatchObject({ verdict: 'unavailable', freshness: {
                local: { kind: 'refusal' }, release: { kind: 'unknown', reason: 'synthetic registry unavailable' },
                installedProducer: { package: '@b00dea/cockpit', version: cockpitPackageVersion, sourceRevision: 'development' },
                repair: { fixes: [], refusal: { kind: 'refusal' } },
            } })
            // The full check envelope lists every owned path; doctor keeps only whether files are current.
            expect(Object.keys(result.result.freshness.local).sort()).toEqual(['diagnostics', 'kind', 'status'])
        } finally { prepare.mockRestore() }
    })

    it('names what each approved MCP server lacks to start without starting it or printing a value', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-mcp-')))
        const original = generatedCurrentnessOwner.prepareGeneratedEnvironmentCurrentness
        const source = { kind: 'sibling', slug: 'app', path: '.mcp.json', sha256: 'a'.repeat(64) } as const
        mkdirSync(join(directory, 'bin'))
        writeFileSync(join(directory, 'bin/headers'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        const servers = [
            { name: 'local', command: 'bin/absent', args: [], cwd: directory, envNames: ['LOCAL_TOKEN'], optionalEnvNames: ['OPTIONAL_LOCAL_PORT'], enabled: true, sources: [source] },
            { name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' },
                helper: { command: 'bin/headers', args: [], cwd: directory }, envNames: ['REMOTE_TOKEN'], enabled: true, sources: [source] },
            { name: 'off', command: 'bin/absent', args: [], cwd: directory, envNames: ['OFF_TOKEN'], enabled: false, sources: [source] },
        ] as const
        const prepare = vi.spyOn(generatedCurrentnessOwner, 'prepareGeneratedEnvironmentCurrentness')
            .mockImplementation(async input => ({ ...await original(input), mcpServers: servers }))
        try {
            const doctorWith = async (env: Record<string, string>) => (await runDoctor(commandInput, { load: async () => undefined, execute: vi.fn(),
                inspectMcpStartup: rows => observeMcpStartup(rows, { PATH: '/usr/bin:/bin', ...env }) }))
                .diagnostics.filter(row => row.code.startsWith('MCP_'))
            const reported = await doctorWith({ REMOTE_TOKEN: 'synthetic-credential-canary' })
            expect(reported.map(row => [row.code, row.target])).toEqual([['MCP_COMMAND_UNRESOLVED', 'local'], ['MCP_ENVIRONMENT_UNSET', 'local']])
            expect(reported[1]!.message).toContain('LOCAL_TOKEN')
            expect(await doctorWith({ LOCAL_TOKEN: 'synthetic-credential-canary' })).toEqual([
                expect.objectContaining({ code: 'MCP_COMMAND_UNRESOLVED', target: 'local' }),
                expect.objectContaining({ code: 'MCP_ENVIRONMENT_UNSET', target: 'remote', message: expect.stringContaining('REMOTE_TOKEN') }),
            ])
            expect(JSON.stringify(reported)).not.toContain('synthetic-credential-canary')
        } finally { prepare.mockRestore(); rmSync(directory, { recursive: true, force: true }) }
    })

    it('tells a relative PATH entry apart from a command that is not installed', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-mcp-path-')))
        const server = (name: string, command: string) => ({ name, command, args: [], cwd: directory, envNames: [], enabled: true, sources: [] })
        try {
            const report = async (PATH: string, command = 'sh') => (await observeMcpStartup([server('local', command)], { PATH }))[0]
            expect(await report('/usr/bin:/bin')).toBeUndefined()
            const installed = await report('./node_modules/.bin:/bin:/usr/bin')
            expect(installed).toMatchObject({ code: 'MCP_COMMAND_UNRESOLVED', target: 'local', fix: expect.stringContaining('the MCP declaration needs no change') })
            expect(installed!.message).toContain('the dot-relative entry "./node_modules/.bin"')
            expect(installed!.message).toContain('doctor excludes from observation')
            expect(installed!.message).toContain('sh is at /bin/sh among the absolute entries')
            expect(installed!.message).not.toContain('no tool can start')
            expect((await report('../bin:/usr/bin:/bin'))!.message).toContain('the parent-relative entry "../bin"')
            expect((await report('/usr/bin::/bin'))!.message).toContain('an empty entry, which is the working directory')
            expect((await report('node_modules/.bin'))!.message).toContain('the bare relative entry "node_modules/.bin"')

            const missing = await report('./node_modules/.bin:/usr/bin:/bin', 'cockpit-synthetic-absent')
            expect(missing!.message).toContain('is in none of the absolute entries either')
            expect(missing!.fix).toContain('has to be installed')
            // Only a relative entry earns this text: a plain miss, or a path-spelled command, keeps the installation advice.
            for (const [PATH, command] of [['/usr/bin:/bin', 'cockpit-synthetic-absent'], ['./node_modules/.bin:/usr/bin', 'bin/absent']] as const) {
                expect((await report(PATH, command))!.message).toContain('so no tool can start it')
            }
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('warns that the guard denies no host when a declared runtime leaves both guard host lists empty', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-guards-')))
        try {
            const doctorFor = async (body: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', '', body, ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.diagnostics.filter(row => row.code === 'GUARD_HOSTS_UNDECLARED')
            }
            const compose = '[environment]\ncompose_files = ["compose.yml"]'
            expect(await doctorFor(compose)).toEqual([expect.objectContaining({ severity: 'warning', target: 'guards',
                message: expect.stringContaining('guards.vendor_endpoint_hosts'), fix: expect.stringContaining('[guards]') })])
            expect(await doctorFor(`[guards]\nhosted_db_hosts = ["db.staging.example.invalid"]\n\n${compose}`)).toEqual([])
            // init writes an explicit "none" as both keys; one key alone still leaves the other kind unanswered.
            expect(await doctorFor(`[guards]\nhosted_db_hosts = []\nvendor_endpoint_hosts = []\n\n${compose}`)).toEqual([])
            expect(await doctorFor(`[guards]\nhosted_db_hosts = []\n\n${compose}`)).toHaveLength(1)
            expect(await doctorFor('')).toEqual([])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('warns that no work can be graded PASS while a product declares no test gate', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-testing-')))
        try {
            const doctorFor = async (body: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', '', body, ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.diagnostics.filter(row => row.code === 'TESTING_GATE_UNDECLARED')
            }
            const compose = '[environment]\ncompose_files = ["compose.yml"]'
            expect(await doctorFor(compose)).toEqual([{ severity: 'warning', code: 'TESTING_GATE_UNDECLARED', target: 'testing',
                message: 'cockpit.toml declares no [testing] gate, so test-run has nothing to run and no work in this product can be graded PASS',
                fix: expect.stringContaining('npx --no cockpit sync --config <your cockpit.toml>') }])
            expect(await doctorFor(`${compose}\n\n[testing]\nstages = [{ id = "unit", command = ["make", "test"], requires_stack = false }]\n`
                + 'gates = [{ id = "all", tier = "full", stages = ["unit"], changes = "Any behavior" }]\nnative_hooks = { install = "inspect" }')).toEqual([])
            // A docs-only cockpit has no product to test.
            expect(await doctorFor('')).toEqual([])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('names docs check among its declarations only when [docs] is declared, without running it', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-docs-')))
        try {
            const doctorFor = async (body: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', '', body, ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.result.declarations.filter(row => row.subject === 'docs')
            }
            expect(await doctorFor('[docs]\nliving = ["README.md"]')).toEqual([{ subject: 'docs', state: 'declared', source: 'docs',
                reason: `docs check reads the declared living documents and decision records; doctor does not run it: npx --no cockpit docs check --config ${join(directory, 'cockpit.toml')}` }])
            expect(await doctorFor('')).toEqual([])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('warns about declarations no person has confirmed until they are removed from unconfirmed', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-unconfirmed-')))
        try {
            const doctorFor = async (head: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, [head, '[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.diagnostics.filter(row => row.code === 'DECLARATION_UNCONFIRMED')
            }
            expect(await doctorFor('unconfirmed = ["environment.machine", "guards"]\n')).toEqual([{ severity: 'warning',
                code: 'DECLARATION_UNCONFIRMED', target: 'unconfirmed',
                message: 'environment.machine, guards in cockpit.toml were chosen by the setup agent or by no one named, not stated by a person, so they may not describe this product',
                // The agent confirms what an observation verifies; a trust decision stays a person's.
                fix: 'run npx --no cockpit confirm environment.machine --config <your cockpit.toml>, which confirms environment.machine only if the container runtime measured on this machine meets the declared memory, CPU and free-disk floor; '
                    + 'a person confirms guards with whoever owns the product, corrects cockpit.toml if a value is wrong, deletes its entry from unconfirmed, then runs npx --no cockpit sync --config <your cockpit.toml> in a terminal outside the agent' }])
            expect(await doctorFor('')).toEqual([])
            // A policy the last sync recorded stronger than cockpit.toml now declares is reported, not silently weaker.
            mkdirSync(join(directory, '.cockpit'))
            const person = { accept: 'person', amend: 'person', answer: 'person', signoff: 'person', acknowledge: 'person' }
            writeFileSync(join(directory, '.cockpit/policy.json'), JSON.stringify({ format: 'cockpit-policy/v1', policy: {
                grading: 'independent', gates: person, autonomy: { sync: 'person', stale_delete: 'person', reset: 'person', mcp_approve: 'person' } } }))
            const weakened = (await runDoctor({ configPath: join(directory, 'cockpit.toml') }, { load: async () => undefined, execute: vi.fn() }))
                .diagnostics.filter(row => row.code === 'POLICY_WEAKENING_UNCONFIRMED')
            expect(weakened).toEqual([expect.objectContaining({ severity: 'warning', target: 'autonomy',
                message: expect.stringContaining('work.gates.accept: person -> agent') })])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('names every other cockpit state folder it cannot read, and every orphaned stack, with the prune that removes them', async () => {
        const cockpits = '/synthetic/state/v1/cockpits'
        const skipped = [{ path: `${cockpits}/one`, reason: 'format is not supported' }, { path: `${cockpits}/two`, reason: 'format is not supported' }]
        const orphaned = { severity: 'warning' as const, code: 'STACKS_ORPHANED' as const, target: cockpits, message: 'this machine has stacks that no checkout can reach' }
        const result = await runDoctor({ configPath: '/synthetic/cockpit.toml' }, { load: async () => undefined, execute: vi.fn(),
            readUnreadableState: async () => ({ kind: 'complete', skipped }), inspectStacks: async () => [orphaned] })
        expect(result.diagnostics.filter(row => row.code === 'STATE_RECORD_MALFORMED')).toEqual([{ severity: 'warning',
            code: 'STATE_RECORD_MALFORMED', target: cockpits,
            message: `2 state folders of other cockpits under ${cockpits} cannot be read by this cockpit version (format is not supported), so their claims and port leases were ignored`,
            fix: 'preview their removal with npx --no cockpit stacks prune --config <your cockpit.toml>, which removes those an earlier cockpit build left once none of their stacks is kept, then apply it with --apply' }])
        expect(result.diagnostics.filter(row => row.code === 'STACKS_ORPHANED')).toEqual([orphaned])

        // An inventory that cannot be read is said, not taken for one with nothing in it.
        const locked = await runDoctor({ configPath: '/synthetic/cockpit.toml' }, { load: async () => undefined, execute: vi.fn(),
            readUnreadableState: async () => ({ kind: 'refusal', diagnostics: [{ severity: 'error', code: 'STATE_LOCKED',
                message: 'coordination publication is in progress', target: `${cockpits}/one`, fix: 'retry after the coordination transaction completes' }] }) })
        expect(locked.diagnostics.filter(row => row.code === 'STATE_LOCKED')).toEqual([{ severity: 'warning', code: 'STATE_LOCKED',
            target: `${cockpits}/one`, fix: 'retry after the coordination transaction completes',
            message: "doctor could not read this machine's cockpit state, so it did not check for other cockpits' state this version cannot read: coordination publication is in progress" }])
    })

    it.each(['authenticated', 'bootstrap', 'missing', 'throwing'] as const)(
        'starts doctor health loading during surface inspection and awaits both for a %s source',
        async (sourceKind) => {
            const source = await healthSourceFixture(sourceKind === 'bootstrap'
                ? { authorities: [], stages: [{ stage: 'bootstrap' }] } as never : context)
            const inspection = Object.freeze({
                kind: 'complete' as const,
                activeOverrides: Object.freeze([]),
                changedOverrideOriginals: Object.freeze([]),
            })
            let releaseInspection!: (value: DoctorSurfaceOverrideInspection) => void
            const heldInspection = new Promise<DoctorSurfaceOverrideInspection>((resolveInspection) => {
                releaseInspection = resolveInspection
            })
            let releaseLoad!: () => void
            const heldLoad = new Promise<void>((resolveLoad) => { releaseLoad = resolveLoad })
            let loadStarted = false
            let inspectionStarted = false
            let completed = false
            const result = runDoctor(source.input, {
                load: (input, issue) => {
                    loadStarted = true
                    return heldLoad.then(() => {
                        if (sourceKind === 'missing') return undefined
                        if (sourceKind === 'throwing') throw new Error('synthetic health source unavailable')
                        return source.load(input, issue)
                    })
                },
                execute: vi.fn(),
                inspectSurfaceOverrides: () => {
                    inspectionStarted = true
                    return heldInspection
                },
            }).then((value) => {
                completed = true
                return value
            })
            try {
                expect(loadStarted).toBe(true)
                expect(inspectionStarted).toBe(true)
                await Promise.resolve()
                expect(completed).toBe(false)
            } finally {
                releaseInspection(inspection)
                releaseLoad()
                await result
            }
            expect((await result).result.surfaceOverrides).toEqual(inspection)
        },
    )

    it('uses one shared evaluation for blocking preflight and read-only doctor', async () => {
        const evaluation = Object.freeze({
            verdict: 'fail' as const,
            revision: '2'.repeat(64),
            checks: Object.freeze([Object.freeze({
                code: 'GIT_STATE_UNHEALTHY' as const,
                owner: 'git-observation', stackId: `stack:${'3'.repeat(64)}` as never,
                source: 'checkout:working-tree', verdict: 'fail' as const,
                reason: 'working tree differs', remedy: 'repair the working tree',
                observedAt: '2026-09-25T00:00:00.000Z', expected: { kind: 'present' as const },
            })]),
        })
        const aggregate = vi.fn((_groups: readonly (readonly unknown[])[], _context: unknown) => evaluation)
        const projection = Object.freeze({ verdict: evaluation.verdict, checks: Object.freeze([]) })
        const project = vi.fn(() => projection)
        applicationOwners.observations.aggregateObservations = aggregate as never
        applicationOwners.observations.projectDoctor = project as never
        const execute = vi.fn()
        const first = await healthSourceFixture(context)
        const second = await healthSourceFixture(context)
        const load = vi.fn()
            .mockImplementationOnce(first.load)
            .mockImplementationOnce(second.load)

        const preflight = await runPreflight(first.input, { load, execute })
        const doctor = await runDoctor(second.input, { load, execute })

        expect(load).toHaveBeenCalledTimes(2)
        expect(load).toHaveBeenNthCalledWith(1, first.input, expect.any(Function), expect.any(Function), 'preflight')
        expect(load).toHaveBeenNthCalledWith(2, second.input, expect.any(Function), expect.any(Function), 'doctor')
        expect(aggregate).toHaveBeenCalledTimes(4)
        for (const [index, preflight] of [first.preflight, first.preflight, second.preflight, second.preflight].entries()) {
            expect(aggregate.mock.calls[index]?.[0]).toHaveLength(healthProducerNames.length)
            expect(aggregate.mock.calls[index]?.[1]).toBe(preflight)
        }
        expect(preflight).toMatchObject({
            kind: 'blocked', status: 2,
            result: { verdict: 'fail', revision: evaluation.revision },
        })
        expect(preflight.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', fix: 'repair the working tree' }),
        ]))
        expect(doctor).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'fail' } })
        expect(project).toHaveBeenCalledWith(evaluation)
        expect(execute).toHaveBeenCalledTimes(2)
    })

    it.each([
        ['active overrides', {
            kind: 'complete' as const,
            activeOverrides: [{ name: 'review-rules', feature: 'rules' as const, originalSha256: '1'.repeat(64), recordedSha256: '1'.repeat(64), overlaySource: 'cockpit.toml' }],
            changedOverrideOriginals: [],
        }],
        ['changed override originals, without collapsing them into active rows', {
            kind: 'complete' as const,
            activeOverrides: [],
            changedOverrideOriginals: [{ code: 'OVERRIDDEN_CORE_CHANGED' as const, name: 'review-rules', recordedSha256: '1'.repeat(64), currentSha256: '2'.repeat(64), overlaySource: 'cockpit.toml' }],
        }],
        // An unavailable inspection is named, never reported as a valid empty set.
        ['an unavailable inspection', {
            kind: 'unavailable' as const,
            code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE' as const,
            reason: 'authenticated generated projection is unavailable',
        }],
    ] as const)('projects %s through the read-only doctor seam', async (_label, inspection) => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.observations.projectDoctor = vi.fn(() => ({ verdict: 'pass', checks: [] })) as never
        const source = await healthSourceFixture(context)
        const inspectSurfaceOverrides = vi.fn(async () => structuredClone(inspection) as DoctorSurfaceOverrideInspection)

        const result = await runDoctor(source.input, {
            load: source.load,
            execute: vi.fn(),
            inspectSurfaceOverrides,
        })

        expect(inspectSurfaceOverrides).toHaveBeenCalledExactlyOnceWith(source.input.configPath)
        expect(result.result.surfaceOverrides).toEqual(inspection)
        expect(Object.keys(result.result.surfaceOverrides).sort()).toEqual(Object.keys(inspection).sort())
    })

    it('keeps bootstrap selection out of the public input and rejects it for doctor', async () => {
        const aggregate = vi.fn(() => passed)
        applicationOwners.observations.aggregateObservations = aggregate as never
        applicationOwners.observations.projectDoctor = vi.fn(() => ({ verdict: 'pass', checks: [] })) as never
        const bootstrapContext = { authorities: [], stages: [{ stage: 'bootstrap' }] } as never
        const preflightSource = await healthSourceFixture(bootstrapContext)
        const doctorSource = await healthSourceFixture(bootstrapContext)

        expect(commandInput).not.toHaveProperty('stage')
        await expect(runPreflight(preflightSource.input, { load: preflightSource.load, execute: vi.fn() }))
            .resolves.toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        await expect(runDoctor(doctorSource.input, { load: doctorSource.load, execute: vi.fn() }))
            .resolves.toMatchObject({ kind: 'complete', result: { verdict: 'unavailable' } })
        expect(aggregate).not.toHaveBeenCalled()
    })

    it('blocks unauthenticated lifecycle evidence instead of treating its stage label as authority', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => {
            throw new RefusalError('preflight needs authentic lifecycle stage authority')
        }) as never

        const source = await healthSourceFixture(context)
        await expect(runPreflight(source.input, { load: source.load, execute: vi.fn() })).resolves.toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable' },
            diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
        })
    })

    it('reports the refusal a producer recorded instead of the observation window it cost', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => {
            throw new RefusalError('health preflight authority could not preserve its observation window')
        }) as never
        const refusal = Object.freeze({ severity: 'error' as const, code: 'GENERATED_ENVIRONMENT_UNAVAILABLE' as const,
            message: 'the generated files do not match cockpit.toml', target: 'cockpit.toml' })
        let refuse: ((diagnostics: readonly unknown[]) => undefined) | undefined
        const source = await healthSourceFixture(context, () => async () => { refuse?.([refusal]); return [] })
        const load = (input: unknown, issue: never, reject: (diagnostics: readonly unknown[]) => undefined) => {
            refuse = reject
            return source.load(input, issue)
        }
        await expect(runPreflight(source.input, { load, execute: vi.fn() } as never)).resolves.toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable' }, diagnostics: [refusal],
        })
    })

    it('rejects a preflight context issued for another configuration before producers or execution', async () => {
        const first = await healthSourceFixture(context)
        const producer = vi.fn(async () => [])
        const second = await healthSourceFixture(first.preflight as never, () => producer)
        const execute = vi.fn()

        await expect(runPreflight(second.input, { load: second.load, execute } as never)).resolves.toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable' },
        })
        expect(producer).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it.each([
        ['a mismatch blocks with the safe remedy', { kind: 'complete' as const, code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const, state: 'mismatch' as const, remoteName: 'fork', reason: 'wrong fork' },
            (comparison: unknown) => ({ kind: 'blocked', result: { verdict: 'fail', comparisons: [{ sibling: 'api', result: comparison }] },
                diagnostics: [{ code: 'GIT_COMPARISON_REMOTE_MISMATCH', message: 'wrong fork', fix: 'in the sibling checkout, run `git status --short --branch` and `git remote -v`; reconcile the selected upstream and declared repository, then rerun the command' }] })],
        ['a match completes', { kind: 'complete' as const, code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const, state: 'match' as const, remoteName: 'origin' },
            (comparison: unknown) => ({ kind: 'complete', result: { comparisons: [{ sibling: 'api', result: comparison }] } })],
    ] as const)('routes status, upstream, selected URL, and final revalidation through the sole executor: %s', async (_label, comparison, expected) => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const status = Object.freeze({ id: 'status' })
        const ref = Object.freeze({ kind: 'probe' as const, step: Object.freeze({ id: 'ref' }) })
        const url = Object.freeze({ kind: 'probe' as const, step: Object.freeze({ id: 'url' }), remoteName: comparison.remoteName })
        const revalidate = Object.freeze({ kind: 'probe' as const, step: Object.freeze({ id: 'revalidate' }), remoteName: comparison.remoteName })
        const git = Object.freeze({ kind: 'complete', observations: Object.freeze([]), evidence: Object.freeze({}) })
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => status) as never
        applicationOwners.gitObservation.observeGit = vi.fn(() => git) as never
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn((input: { git?: unknown }) => input.git ? ref : ({ kind: 'unavailable', code: comparison.code, reason: 'status required' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRef = vi.fn(() => url) as never
        applicationOwners.gitObservation.observeComparisonRemoteUrl = vi.fn(() => revalidate) as never
        applicationOwners.gitObservation.observeComparisonRemoteRevalidation = vi.fn(() => comparison) as never
        const execute = vi.fn(async (_step: { readonly id: string }) => Object.freeze({}))

        const source = await healthSourceFixture(context)
        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual(['status', 'ref', 'url', 'revalidate'])
        expect(result).toMatchObject(expected(comparison))
    })

    it('preserves acquire none without a declared remote as not applicable without Git execution', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const notApplicable = Object.freeze({
            kind: 'not-applicable' as const,
            code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const,
            reason: 'sibling api has no declared comparison remote',
        })
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn(() => notApplicable) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => { throw new Error('Git must remain unused') }) as never
        const execute = vi.fn()

        const source = await healthSourceFixture(context, undefined, [
            '[cockpit]',
            'name = "synthetic-cockpit"',
            'siblings_root = "."',
            '',
            '[[sibling]]',
            'slug = "api"',
            'dir = "api"',
            'acquire = "none"',
            'mount = "always"',
            'var = "API_DIR"',
            'purpose = "Synthetic API"',
            '',
            '[ports]',
            'bases = { APP_PORT = 4100 }',
            '',
        ].join('\n'))
        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(result).toMatchObject({ kind: 'complete', result: { verdict: 'pass', comparisons: [{ result: notApplicable }] } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('preserves an unavailable comparison result and its safe remedy', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const unavailable = Object.freeze({
            kind: 'unavailable' as const,
            code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const,
            reason: 'comparison upstream is unavailable for sibling api',
            remoteName: 'fork',
        })
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn(() => unavailable) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => undefined) as never

        const source = await healthSourceFixture(context)
        const result = await runPreflight(source.input, { load: source.load, execute: vi.fn() } as never)

        expect(result).toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable', comparisons: [{ result: unavailable }] },
            diagnostics: [{ code: unavailable.code, message: unavailable.reason,
                fix: 'in the sibling checkout, run `git status --short --branch` and `git remote -v`; reconcile the selected upstream and declared repository, then rerun the command',
            }],
        })
        expect(JSON.stringify(result)).not.toContain('example.invalid')
    })

    it('names the failed comparison probe and sibling when execution throws', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => Object.freeze({ id: 'status' })) as never
        const source = await healthSourceFixture(context)

        const result = await runPreflight(source.input, {
            load: source.load,
            execute: async () => { throw new Error('private executor detail') },
        } as never)

        expect(result).toMatchObject({
            kind: 'blocked',
            diagnostics: [{
                code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                message: 'Git status probe execution is unavailable for sibling api: Error',
                target: 'api',
            }],
        })
        expect(JSON.stringify(result)).not.toContain('private executor detail')
    })

    it('keeps log planning bounded and requires cancellation for follow mode', async () => {
        const planned = Object.freeze({ kind: 'planned' as const, step: Object.freeze({ id: 'logs' }) })
        const records = Object.freeze([{ message: 'ready', stream: 'stdout' }])
        applicationOwners.logs.planLogs = vi.fn(() => planned) as never
        applicationOwners.logs.collectLogs = vi.fn(async () => ({ kind: 'complete', records })) as never
        const execute = vi.fn()

        const observe = vi.fn(async () => ({ request: logRequestBaseFixture() }))
        const publicInput = {
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: true, json: true,
        } as const
        await expect(runLogs(publicInput, { observe, execute } as never))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }] })
        expect(applicationOwners.logs.planLogs).not.toHaveBeenCalled()
        expect(observe).not.toHaveBeenCalled()

        const signal = new AbortController().signal
        const complete = await runLogs(
            publicInput,
            { observe, execute, signal } as never,
        )
        expect(observe).toHaveBeenCalledWith({ configPath: publicInput.configPath, service: publicInput.service })
        expect(applicationOwners.logs.planLogs).toHaveBeenCalledWith(expect.objectContaining({
            service: 'api', since: '5m', tail: 25, follow: true,
        }), undefined)
        expect(applicationOwners.logs.collectLogs).toHaveBeenCalledWith(planned, execute, signal, undefined)
        expect(complete).toMatchObject({ kind: 'complete', result: { json: true, records } })
    })

    it('runs the full comparison precursor for every configured sibling and combines nonpass results', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn((input: { sibling: string }) => ({
            id: `${input.sibling}:status`,
        })) as never
        applicationOwners.gitObservation.observeGit = vi.fn(() => ({
            kind: 'complete', evidence: {}, observations: [{ source: 'comparison precursor' }],
        })) as never
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn((input: { sibling: string; git?: unknown }) => input.git
            ? ({ kind: 'probe', step: { id: `${input.sibling}:ref` } })
            : ({ kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH', reason: 'status required' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRef = vi.fn((stage: { step: { id: string } }) => ({
            kind: 'probe', step: { id: stage.step.id.replace(':ref', ':url') }, remoteName: 'origin',
        })) as never
        applicationOwners.gitObservation.observeComparisonRemoteUrl = vi.fn((stage: { step: { id: string } }) => ({
            kind: 'probe', step: { id: stage.step.id.replace(':url', ':revalidate') }, remoteName: 'origin',
        })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRevalidation = vi.fn((stage: { step: { id: string } }) => stage.step.id.startsWith('web:')
            ? ({ kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'mismatch', remoteName: 'origin', reason: 'wrong web fork' })
            : ({ kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'match', remoteName: 'origin' })) as never
        const source = await healthSourceFixture(context, undefined, [
            '[cockpit]', 'name = "synthetic-cockpit"', 'siblings_root = "."', '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"', 'remote = "ssh://example.invalid/api.git"',
            'acquire = "auto"', 'mount = "always"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
            '[[sibling]]', 'slug = "web"', 'dir = "web"', 'remote = "ssh://example.invalid/web.git"',
            'acquire = "auto"', 'mount = "always"', 'var = "WEB_DIR"', 'purpose = "Synthetic web"', '',
            '[ports]', 'bases = { APP_PORT = 4100 }', '',
        ].join('\n'))
        const execute = vi.fn(async (_step: { readonly id: string }) => Object.freeze({}))

        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual([
            'api:status', 'api:ref', 'api:url', 'api:revalidate',
            'web:status', 'web:ref', 'web:url', 'web:revalidate',
        ])
        expect(result).toMatchObject({
            kind: 'blocked', result: {
                verdict: 'fail',
                comparisons: [
                    { sibling: 'api', result: { state: 'match' } },
                    { sibling: 'web', result: { state: 'mismatch', reason: 'wrong web fork' } },
                ],
            },
        })
    })

    it('runs every named producer and authenticates the aggregate before comparison execution', async () => {
        const order: string[] = []
        applicationOwners.observations.aggregateObservations = vi.fn(() => {
            order.push('authenticate')
            throw new RefusalError('lifecycle authority is not authentic')
        }) as never
        const source = await healthSourceFixture(context, (name) => async () => {
            order.push(name)
            return []
        })
        const execute = vi.fn()

        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(order).toEqual([
            'claims', 'git', 'host', 'lifecycle', 'ports', 'runtime', 'state', 'templates', 'envSchema', 'siblings', 'surfaces',
            'authenticate',
        ])
        expect(execute).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
    })

    it('keeps a rejected producer nonpass and names it without exposing its error', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const source = await healthSourceFixture(context, (name) => async () => {
            if (name === 'runtime') throw new Error('private runtime detail')
            return []
        })

        const result = await runPreflight(source.input, {
            load: source.load, execute: vi.fn(),
        } as never)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'EVIDENCE_UNAVAILABLE', message: 'runtime observation producer failed', target: 'runtime',
        })]))
        expect(JSON.stringify(result)).not.toContain('private runtime detail')
    })

    it('reports the refusal a producer failed on in place of its own evidence-unavailable finding', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const refusal = { severity: 'error' as const, code: 'COMPOSE_PORT_NOT_LEASED', target: 'compose:web:3000', message: 'web publishes a fixed port', fix: 'publish it from a ports.bases variable' }
        const source = await healthSourceFixture(context, (name) => async () => {
            if (name === 'surfaces') throw new ObservationProducerRefusal('check refused the publication', [refusal as never])
            return []
        })

        const result = await runPreflight(source.input, { load: source.load, execute: vi.fn() } as never)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(result.diagnostics).toContainEqual(refusal)
        expect(result.diagnostics.map(({ message }) => message)).not.toContain('surfaces observation producer failed')
    })

    it.each(['missing', 'extra'] as const)('rejects a %s producer cohort before execution', async (shape) => {
        const source = await healthSourceFixture(context, undefined, undefined, (producers) => {
            const changed = { ...producers } as Record<string, () => Promise<readonly never[]>>
            if (shape === 'missing') delete changed.runtime
            else changed.unknown = async () => []
            return changed
        }, false)
        const execute = vi.fn()

        await expect(runPreflight(source.input, { load: source.load, execute } as never))
            .resolves.toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(execute).not.toHaveBeenCalled()
    })

    it.each([
        ['service', 'API'],
        ['service', 'a'.repeat(129)],
        ['since', 'all'],
        ['since', '1'.repeat(65)],
        ['tail', -1],
        ['tail', 1.5],
        ['tail', 100_001],
    ] as const)('rejects invalid public log %s before observing runtime identity', async (field, value) => {
        const observe = vi.fn()
        const input = {
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: false, json: true,
            [field]: value,
        }

        const result = await runLogs(input as never, { observe, execute: vi.fn() } as never)

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }] })
        expect(observe).not.toHaveBeenCalled()
    })

    it('refuses hostile log observation accessors without evaluating them', async () => {
        const request = vi.fn(() => logRequestBaseFixture())
        const restart = vi.fn(() => undefined)
        const observed = Object.defineProperties({}, {
            request: { enumerable: true, get: request },
            restart: { enumerable: true, get: restart },
        })

        const result = await runLogs({
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: false, json: true,
        }, { observe: async () => observed as never, execute: vi.fn() })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }] })
        expect(request).not.toHaveBeenCalled()
        expect(restart).not.toHaveBeenCalled()
    })
})

const healthProducerNames = [
    'claims', 'git', 'host', 'lifecycle', 'ports', 'runtime', 'state', 'templates', 'envSchema', 'siblings', 'surfaces',
] as const

function logRequestBaseFixture() {
    return Object.freeze({
        runtime: 'docker-compose' as const,
        executable: Object.freeze({}),
        cwd: '/synthetic',
        stackId: `stack:${'1'.repeat(64)}` as never,
        configSha256: '2'.repeat(64),
        batchId: '3'.repeat(64),
        containerId: 'api-1',
        runtimeVersion: '1.0.0',
        composeVersion: '2.0.0',
        projectName: 'synthetic',
        composeFiles: Object.freeze([]),
        services: Object.freeze(['api']),
        service: 'api',
        timeoutMs: 1_000,
        outputLimitBytes: 1_024,
        env: Object.freeze({}),
    })
}

async function healthSourceFixture(
    preflight: never,
    producer: (name: typeof healthProducerNames[number]) => () => Promise<readonly never[]> = () => async () => [],
    configSource?: string,
    transformProducers: (
        producers: Readonly<Record<string, () => Promise<readonly never[]>>>,
    ) => Readonly<Record<string, () => Promise<readonly never[]>>> = (producers) => producers,
    required = true,
) {
    const value = await unissuedContextFixture(configSource)
    const loaded = await loadCockpitConfig(value.configPath)
    if (loaded.kind !== 'complete') throw new Error('health configuration did not load')
    const observed = await observeSetupCheckout({
        source: value.candidate.source,
        cockpitName: loaded.result.config.cockpit.name,
        observedAt: value.candidate.observedAt,
        env: value.candidate.env,
        gitExecutable: value.candidate.gitExecutable,
    })
    const producers = Object.freeze(Object.fromEntries(
        healthProducerNames.map((name) => [name, producer(name)]),
    ))
    const expectedStackId = stackId({
        cockpitId: cockpitId({
            name: loaded.result.config.cockpit.name,
            mainCheckoutPath: value.candidate.mainCheckoutPath,
        }),
        checkoutId: checkoutId({ checkoutPath: value.candidate.mainCheckoutPath }),
        variant: { kind: 'shared' },
    })
    const requested = preflight as unknown as {
        readonly authorities?: readonly unknown[]
        readonly stages?: readonly { readonly stage?: unknown }[]
    }
    const validThrough = new Date(Date.parse(value.candidate.observedAt) + 30_000).toISOString()
    const requestedStage = requested.stages?.[0]?.stage === 'bootstrap' ? 'bootstrap' as const : 'steady' as const
    const boundPreflight: PreflightContext = requested.authorities?.length
        ? preflight
        : Object.freeze({
            authorities: Object.freeze([Object.freeze({
                stackId: expectedStackId,
                evaluatedAt: value.candidate.observedAt,
                validThrough,
                revision: loaded.result.source.sha256,
                source: loaded.result.source.path,
                postures: Object.freeze(['environment']),
                environmentPostures: Object.freeze({ addressing: null, authentication: null }),
                postureRequirements: Object.freeze([]),
            })]),
            stages: Object.freeze([Object.freeze({
                stackId: expectedStackId,
                stage: requestedStage,
                observedAt: value.candidate.observedAt,
                validThrough,
            })]),
        })
    const load = async (_input: unknown, issue: (source: HealthObservationSourceInput) => HealthObservationSource | undefined) => {
        const source = await withSetupCheckoutProjection(observed, {
            source: value.candidate.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(value.candidate.observedAt),
        }, (checkout) => issue({
            checkout,
            configuration: loaded.result,
            preflight: boundPreflight,
            env: Object.freeze({}),
            gitExecutable,
            timeoutMs: 1_000,
            producers: transformProducers(producers),
            refreshPreflight: async (previous: PreflightContext) => previous === boundPreflight ? boundPreflight : undefined,
            stopped: null,
            notices: () => [],
        } as never))
        if (!source && required) throw new Error('health source was not issued')
        return source
    }
    return Object.freeze({ load, preflight: boundPreflight, input: Object.freeze({ configPath: loaded.result.source.path }) })
}
