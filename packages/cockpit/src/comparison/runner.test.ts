import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseComparisonFixture } from './contract.js'
import { runComparison, type ComparisonSubjectProjection } from './runner.js'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const roots: string[] = []
const cockpitRevision = 'c'.repeat(40)

async function compilePackagedComparisonRuntime(sourceRevision: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-package-')))
    roots.push(root)
    const dependencyRoot = dirname(dirname(require.resolve('zod/package.json')))
    await symlink(dependencyRoot, join(root, 'node_modules'), 'dir')
    await mkdir(join(root, 'libexec'))
    await copyFile(join(process.cwd(), 'packages/cockpit/libexec/validate-harness-evidence.mjs'),
        join(root, 'libexec/validate-harness-evidence.mjs'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@example/cockpit', version: '1.0.0', type: 'module',
        engines: { node: '>=22' }, cockpitSourceRevision: sourceRevision }))
    await run(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '--singleThreaded', '--project', join(process.cwd(), 'packages/cockpit/tsconfig.build.json'),
        '--rootDir', join(process.cwd(), 'packages/cockpit/src'), '--outDir', join(root, 'dist')], { cwd: process.cwd() })
    return {
        runner: await import(pathToFileURL(join(root, 'dist/comparison/runner.js')).href),
        execute: await import(pathToFileURL(join(root, 'dist/environment-exec/execute.js')).href),
        executable: await import(pathToFileURL(join(root, 'dist/environment/executable.js')).href),
        identity: await import(pathToFileURL(join(root, 'dist/environment/identity.js')).href),
        destructive: await import(pathToFileURL(join(root, 'dist/environment/destructive-composition.js')).href),
    }
}

let packagedRuntimeAttempt: ReturnType<typeof compilePackagedComparisonRuntime> | undefined

function packagedComparisonRuntime(sourceRevision: string) {
    if (sourceRevision !== cockpitRevision) throw new Error('comparison package source revision changed')
    packagedRuntimeAttempt ??= compilePackagedComparisonRuntime(sourceRevision)
    return packagedRuntimeAttempt
}

async function fixture(name = 'command-set.json') {
    const parsed = parseComparisonFixture(JSON.parse(await readFile(join(process.cwd(), 'fixtures/comparison', name), 'utf8')))
    if (parsed.kind !== 'complete') throw new Error(parsed.message)
    return parsed.fixture
}

const forgedProjection = () => Object.freeze({}) as ComparisonSubjectProjection

describe('comparison runner', () => {
    it('refuses before execution when the refreshed full subject differs', async () => {
        const execute = vi.fn()
        const result = await runComparison(await fixture(), {
            refresh: async () => forgedProjection(),
            withLifecycle: async use => Object.freeze({ kind: 'complete' as const, result: await use(Object.freeze({
                stack: 'stack', checkout: Object.freeze({ id: 'checkout', root: '/tmp/isolated' }), entrypoints: Object.freeze([]),
                execute, up: vi.fn(), down: vi.fn(), beginReset: vi.fn(),
            }) as never) }),
        })
        expect(result).toMatchObject({ kind: 'refusal', retainCheckout: true, reason: 'comparison subject identity changed before execution' })
        expect(execute).not.toHaveBeenCalled()
    })

    it('rejects a structurally identical clone of a refreshed subject projection', async () => {
        const cloned = { ...forgedProjection() } as ComparisonSubjectProjection
        const result = await runComparison(await fixture(), {
            refresh: async () => cloned,
            withLifecycle: async use => Object.freeze({ kind: 'complete' as const, result: await use(Object.freeze({
                stack: 'stack', checkout: Object.freeze({ id: 'checkout', root: '/tmp/isolated' }), entrypoints: Object.freeze([]),
                execute: vi.fn(), up: vi.fn(), down: vi.fn(), beginReset: vi.fn(),
            }) as never) }),
        })
        expect(result).toMatchObject({ kind: 'refusal', retainCheckout: true, reason: 'comparison subject identity changed before execution' })
    })

    // Full comparisons authenticate every command boundary; the budget covers several complete runs.
    it.each([
        { name: 'runs command-set.json only from owner-observed identity and an explicit reset approval', fixtureName: 'command-set.json', scenario: 'normal' },
        { name: 'runs second-shape.json only from owner-observed identity and an explicit reset approval', fixtureName: 'second-shape.json', scenario: 'normal' },
        { name: 'refuses an executable identity change between implementation bindings', fixtureName: 'command-set.json', scenario: 'executable-change' },
        { name: 'refuses a material input replaced by a FIFO after final down', fixtureName: 'command-set.json', scenario: 'final-fifo' },
    ] as const)('$name', async ({ fixtureName, scenario }) => {
        const selectedParent = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-selected-')))
        const selected = join(selectedParent, 'selected')
        const active = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-active-')))
        const stateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-state-')))
        const observationStateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-observation-state-')))
        roots.push(selectedParent, active, stateHome, observationStateHome)
        const base = await fixture(fixtureName)
        await run('git', ['init', '--quiet'], { cwd: active })
        const selectedConfig = Buffer.from([
            '[cockpit]', 'name = "selected"', 'siblings_root = "siblings"', '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "always"', 'acquire = "none"',
            'var = "API_DIR"', 'toolchain = "none"', 'purpose = "Synthetic API"', '',
            '[ports]', 'step = 10', 'count = 1', 'bases = { WEB_PORT = 61380 }', '',
            '[environment]', 'compose_files = ["compose.yml"]', 'resettable_volumes = []', 'generated_host_paths = []',
            'install_policies = [{ toolchain = "node", volume = "node-modules", lockfile = "package-lock.json", install = ["npm", "ci"], load_probe = ["npm", "test"] }]',
            'runtime_measurements = [{ runtime = "docker-desktop", compose_floor = "2.20.0", measured_on = "2026-09-26", candidate = "passed", broken_control = "rejected", status = "supported" }]', '',
            '[environment.machine]', 'runtime_memory_mb = 1024', 'runtime_cpus = 1', 'free_disk_mb = 1024', 'cold_start_seconds = 30', '',
        ].join('\n'))
        await writeFile(join(active, 'cockpit.toml'), selectedConfig)
        await run('git', ['add', '.'], { cwd: active })
        await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'main fixture'], { cwd: active })
        await run('git', ['worktree', 'add', '--quiet', '-b', 'comparison', selected], { cwd: active })
        await mkdir(join(selected, 'fixtures'), { recursive: true })
        await mkdir(join(active, 'siblings/api'), { recursive: true })
        await writeFile(join(selected, 'compose.yml'), ['services:', '  api:', '    image: synthetic.invalid/api',
            '    volumes:', '      - type: bind', `        source: ${JSON.stringify(join(active, 'siblings/api'))}`,
            '        target: /api', '',
        ].join('\n'))
        await writeFile(join(selected, 'docker'), [
            '#!/bin/sh', 'if [ "$1" = "--host" ]; then shift 2; fi',
            'if [ "$1" = "version" ]; then printf "27.1.2\\n"; exit 0; fi',
            'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\\n"; exit 0; fi',
            'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
            'if [ "$1" = "info" ]; then printf "2147483648|2\\n"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " config "; then /bin/cat "$PWD/topology.json"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " up "; then /usr/bin/touch "$PWD/runtime-up"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " stop"; then /bin/rm -f "$PWD/runtime-up"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " ps --format json"; then if [ -f "$PWD/runtime-up" ]; then /bin/cat "$PWD/runtime.json"; fi; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " ps --quiet"; then if [ -f "$PWD/runtime-up" ]; then printf "%s\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; fi; exit 0; fi',
            'if [ "$1" = "compose" ]; then exit 0; fi',
            'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then /bin/cat "$PWD/inspect.json"; exit 0; fi',
            'if [ "$1" = "context" ]; then /bin/cat "$PWD/selection.json"; exit 0; fi', 'exit 0', '',
        ].join('\n'), { mode: 0o700 })
        await writeFile(join(selected, 'selection.json'), '{"context":"default","endpoint":"unix:///tmp/synthetic.sock"}\n')
        const secondShape = fixtureName === 'second-shape.json'
        const registry = secondShape
            ? await readFile(join(process.cwd(), 'fixtures/registries/lane-dialect.sh')) : Buffer.from('registry')
        const environment = secondShape
            ? Buffer.from(JSON.stringify({ optionalProfiles: ['client', 'operations'],
                sourceModes: ['empty', 'seed', 'dump'] }) + '\n') : Buffer.from('environment')
        const packageBytes = Buffer.from('package')
        const registryPath = secondShape ? 'fixtures/registries/lane-dialect.sh' : 'fixtures/registry.toml'
        const environmentPath = secondShape ? 'fixtures/source-material.json' : 'fixtures/environment.json'
        await mkdir(dirname(join(selected, registryPath)), { recursive: true })
        await writeFile(join(selected, registryPath), registry)
        await writeFile(join(selected, environmentPath), environment)
        await writeFile(join(selected, 'package.bin'), packageBytes)
        const ownerExecutable = join(selected, 'owner-command')
        await symlink(await realpath('/usr/bin/true'), ownerExecutable)
        await writeFile(join(selected, '.gitignore'), ['comparison.json', 'topology.json', 'runtime.json', 'inspect.json', 'runtime-up', 'selection.json', ''].join('\n'))
        await run('git', ['add', '.'], { cwd: selected })
        await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: selected })
        const legacyRevision = (await run('git', ['rev-parse', 'HEAD'], { cwd: selected })).stdout.trim()
        await writeFile(join(selected, 'comparison-baseline.txt'), 'current comparison baseline\n')
        await run('git', ['add', 'comparison-baseline.txt'], { cwd: selected })
        await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'comparison baseline'], { cwd: selected })
        const revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: selected })).stdout.trim()
        const runtime = await packagedComparisonRuntime(cockpitRevision)
        const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
        const material = [
            { path: registryPath, sha256: hash(registry) },
            { path: environmentPath, sha256: hash(environment) },
        ]
        const commands = [...base.commands.shared, ...base.commands.extras]
        const ownerCommands = new Set(['up', 'down', 'reset'])
        await writeFile(join(selected, 'topology.json'), JSON.stringify({ services: { api: {
            volumes: [{ type: 'bind', source: join(active, 'siblings/api'), target: '/api' }],
        } } }))
        const lifecycleInput = Object.freeze({ configPath: join(selected, 'cockpit.toml'),
            env: Object.freeze({ PATH: `${selected}:/usr/bin:/bin`, HOME: stateHome }),
            sessionId: 'comparison-runner', timeoutMs: 30_000, dockerContext: 'default' })
        const observedPostState = await runtime.destructive.withBoundedComparisonLifecycle(
            Object.freeze({ ...lifecycleInput, env: Object.freeze({ ...lifecycleInput.env, HOME: observationStateHome }) }),
            runtime.execute.executeProbe, async (bounded: any) => ({ stack: bounded.stack,
                digest: runtime.destructive.consumeComparisonPostState(
                    await bounded.observePostState('legacy', 'preflight'),
                    { stackId: bounded.stack, checkoutId: bounded.checkout.id, implementation: 'legacy', command: 'preflight' },
                ),
            }))
        if (observedPostState.kind !== 'complete' || !observedPostState.result.digest) throw new Error('owner post-state unavailable')
        const commonPostStates = base.implementations[0]!.postStates.map(row => ({
            command: row.command, observationSha256: observedPostState.result.digest,
        }))
        const implementations = base.implementations.map(implementation => ({
            ...implementation,
            revision: implementation.id === 'cockpit' ? cockpitRevision : legacyRevision,
            bindings: implementation.bindings.map(binding => ({ ...binding,
                executable: ownerCommands.has(binding.command) ? ownerExecutable : '/usr/bin/printf',
                argv: ownerCommands.has(binding.command) ? [] : [binding.command], inputSha256s: material.map(row => row.sha256) })),
            postStates: commonPostStates,
        }))
        const candidate = { ...base, subject: { revisions: { legacy: legacyRevision, cockpit: cockpitRevision },
            packageIntegrity: hash(packageBytes), inputs: material }, implementations }
        const accepted = parseComparisonFixture(candidate)
        if (accepted.kind !== 'complete') throw new Error(accepted.message)
        await writeFile(join(selected, 'comparison.json'), JSON.stringify(accepted.fixture))
        const git = await runtime.executable.resolveGitExecutable({ PATH: process.env.PATH ?? '' })
        if (git.state !== 'available') throw new Error(git.reason)
        const source = { path: join(selected, 'cockpit.toml'), byteLength: selectedConfig.byteLength, sha256: hash(selectedConfig) }
        const expectedCheckout = runtime.identity.checkoutId({ checkoutPath: selected })
        const expectedStack = observedPostState.result.stack
        await writeFile(join(selected, 'topology.json'), JSON.stringify({ services: { api: {
            labels: { 'dev.b0dea.cockpit.stack-id': expectedStack, 'dev.b0dea.cockpit.config-sha256': source.sha256 },
            volumes: [{ type: 'bind', source: join(active, 'siblings/api'), target: '/api' }],
        } } }))
        await writeFile(join(selected, 'runtime.json'), JSON.stringify({ ID: 'a'.repeat(12), Name: 'selected-api-1',
            Project: 'selected', Service: 'api', State: 'running', Health: '', ExitCode: 0,
            Labels: `com.docker.compose.project=selected,com.docker.compose.service=api,dev.b0dea.cockpit.config-sha256=${source.sha256},dev.b0dea.cockpit.stack-id=${expectedStack}` }))
        await writeFile(join(selected, 'inspect.json'), JSON.stringify({ ID: 'a'.repeat(64), State: 'running', Health: '', Labels: {
            'com.docker.compose.project': 'selected', 'com.docker.compose.service': 'api',
            'dev.b0dea.cockpit.config-sha256': source.sha256, 'dev.b0dea.cockpit.stack-id': expectedStack,
        } }))
        const observeFixture = async (observedFixture: typeof accepted.fixture, observedLifecycle: any) => {
            const observedAt = new Date().toISOString()
            return runtime.runner.observeComparisonSubject({ fixture: observedFixture, lifecycle: observedLifecycle,
                packagePath: 'package.bin', fixturePath: 'comparison.json',
                checkout: { input: { source, cockpitName: 'selected', observedAt, env: {}, gitExecutable: git.value },
                    context: { source, cockpitName: 'selected', evaluatedAt: Date.parse(observedAt) } } })
        }
        const refresh = (observedLifecycle: any) => observeFixture(accepted.fixture, observedLifecycle)
        const withLifecycle = async <T>(use: (value: any) => Promise<T>) => {
            await rm(join(selected, 'runtime-up'), { force: true })
            const runStateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-run-state-')))
            roots.push(runStateHome)
            return runtime.destructive.withBoundedComparisonLifecycle(Object.freeze({
                ...lifecycleInput, env: Object.freeze({ ...lifecycleInput.env, HOME: runStateHome }),
            }), runtime.execute.executeProbe, use)
        }
        if (scenario === 'executable-change') {
            let executableChanged = false
            const result = await runtime.runner.runComparison(accepted.fixture, {
                refresh,
                withLifecycle: <T>(use: (value: any) => Promise<T>) => withLifecycle(bounded => use(Object.freeze({
                    ...bounded,
                    resolveExecutable: async (declaration: string) => executableChanged
                        ? Object.freeze({ state: 'unavailable', reason: 'executable identity changed' })
                        : bounded.resolveExecutable(declaration),
                    execute: async (step: any) => {
                        const outcome = await bounded.execute(step)
                        if (step.labels.implementation === 'legacy' && step.labels.command === 'preflight') {
                            executableChanged = true
                        }
                        return outcome
                    },
                }))),
                decideReset: async () => 'approve',
            })
            expect(result).toMatchObject({
                kind: 'refusal', retainCheckout: true, reason: 'comparison subject identity changed during execution',
            })
            return
        }
        if (scenario === 'final-fifo') {
            const result = await runtime.runner.runComparison(accepted.fixture, {
                refresh,
                withLifecycle: <T>(use: (value: any) => Promise<T>) => withLifecycle(bounded => use(Object.freeze({
                    ...bounded,
                    down: async () => {
                        const outcome = await bounded.down()
                        const path = join(selected, registryPath)
                        await rm(path)
                        await run('mkfifo', [path])
                        return outcome
                    },
                }))),
                decideReset: async () => 'approve',
            })
            expect(result).toMatchObject({
                kind: 'refusal', retainCheckout: true, reason: 'comparison subject identity changed during execution',
            })
            return
        }
        const mismatchedLifecycle = await runtime.runner.runComparison(accepted.fixture, {
            refresh,
            withLifecycle: <T>(use: (value: any) => Promise<T>) => withLifecycle(bounded => use(Object.freeze({
                ...bounded, checkout: Object.freeze({ ...bounded.checkout, root: active }),
            }))),
            decideReset: async () => 'approve',
        })
        expect(mismatchedLifecycle).toMatchObject({
            kind: 'refusal',
            reason: 'comparison subject identity changed before execution',
        })
        const result = await runtime.runner.runComparison(accepted.fixture, {
            refresh,
            withLifecycle,
            decideReset: async () => 'approve',
        })
        if (result.kind === 'refusal') throw new Error(JSON.stringify(result))
        expect(result).toMatchObject({ kind: 'complete', retainCheckout: false })
        if (result.kind === 'complete') {
            expect(result.evidence).toHaveLength(commands.length * 2 + 1)
            expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
                command: 'preflight', stdout: 'preflight', normalizedStdout: 'preflight', source: 'process',
            })]))
        }

        const changedAdoptionCandidate = structuredClone(accepted.fixture)
        changedAdoptionCandidate.adoption[0]!.state = changedAdoptionCandidate.adoption[0]!.state === 'migrated'
            ? 'documented-only' : 'migrated'
        const changedAdoption = parseComparisonFixture(changedAdoptionCandidate)
        if (changedAdoption.kind !== 'complete') throw new Error(changedAdoption.message)
        expect(await runtime.runner.runComparison(changedAdoption.fixture, {
            refresh: (bounded: any) => observeFixture(changedAdoption.fixture, bounded),
            withLifecycle,
            decideReset: async () => 'approve',
        })).toMatchObject({ kind: 'refusal', reason: 'comparison subject identity changed before execution' })

        const staleSourceCandidate = structuredClone(accepted.fixture)
        staleSourceCandidate.subject.inputs[0]!.sha256 = '9'.repeat(64)
        for (const implementation of staleSourceCandidate.implementations) {
            for (const binding of implementation.bindings) binding.inputSha256s[0] = '9'.repeat(64)
        }
        const staleSource = parseComparisonFixture(staleSourceCandidate)
        if (staleSource.kind !== 'complete') throw new Error(staleSource.message)
        await writeFile(join(selected, 'comparison.json'), JSON.stringify(staleSource.fixture))
        expect(await runtime.runner.runComparison(staleSource.fixture, {
            refresh: (bounded: any) => observeFixture(staleSource.fixture, bounded),
            withLifecycle,
            decideReset: async () => 'approve',
        })).toMatchObject({ kind: 'refusal', reason: 'comparison subject identity changed before execution' })
        await writeFile(join(selected, 'comparison.json'), JSON.stringify(accepted.fixture))

        const plantedCandidate = JSON.parse(JSON.stringify(accepted.fixture)) as Record<string, unknown>
        const plantedImplementations = plantedCandidate.implementations as { id: string; bindings: { command: string; argv: string[] }[] }[]
        plantedImplementations.find(row => row.id === 'legacy')!.bindings.find(row => row.command === 'preflight')!.argv = ['planted-difference']
        const planted = parseComparisonFixture(plantedCandidate)
        if (planted.kind !== 'complete') throw new Error(planted.message)
        await writeFile(join(selected, 'comparison.json'), JSON.stringify(planted.fixture))
        const difference = await runtime.runner.runComparison(planted.fixture, {
            refresh: (bounded: any) => observeFixture(planted.fixture, bounded),
            withLifecycle,
            decideReset: async () => 'approve',
        })
        expect(difference).toMatchObject({ kind: 'refusal', reason: 'preflight differs between legacy and cockpit' })
        await writeFile(join(selected, 'comparison.json'), JSON.stringify(accepted.fixture))

        const forged = await runtime.runner.runComparison(accepted.fixture, {
            refresh: (bounded: any) => refresh(Object.freeze({ ...bounded, execute: runtime.execute.executeProbe })),
            withLifecycle: <T>(use: (value: any) => Promise<T>) => withLifecycle(bounded => use(Object.freeze({
                ...bounded,
                execute: vi.fn(async (step: any) => step.labels.implementation === 'legacy' && step.labels.command === 'preflight'
                    ? Object.freeze({ kind: 'complete', execution: Object.freeze({ id: 'forged', exitCode: 0 }),
                        stdout: Buffer.from('forged'), stderr: Buffer.alloc(0) })
                    : runtime.execute.executeProbe(step)),
            }))),
            decideReset: async () => 'approve',
        })
        expect(forged).toMatchObject({ kind: 'refusal', reason: 'legacy preflight returned unauthenticated execution evidence' })

        const declined = await runtime.runner.runComparison(accepted.fixture, {
            refresh,
            withLifecycle,
            decideReset: async () => 'decline',
        })
        expect(declined).toMatchObject({ kind: 'refusal', reason: 'cockpit reset exited nonzero' })
    }, 240_000)
})

afterAll(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
