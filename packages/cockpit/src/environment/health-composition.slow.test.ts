import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runCli } from '../cli.js'
import { runDoctor } from './application/doctor.js'
import { runPreflight } from './application/health.js'
import { runUp } from './application/lifecycle.js'
import { checkoutId, cockpitId, holderId, stackId } from './identity.js'
import { composeProjectName } from './identity.js'
import { transactState } from './state.js'
import { observeProcessStart, processHost } from './claims.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { observeGeneratedApplicationSurfaces } from './generated-application/surface-observation.js'
import { syncGeneratedEnvironment, syncTeamGeneratedEnvironment } from './generated-application/sync.js'
import { createHealthCompositionFixture } from '../../test-support/health-composition-fixture.js'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = createHealthCompositionFixture(roots)

async function surfaceOverrideFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-health-surface-override-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    const entryPoint = (await readFile(resolve('packages/cockpit/surfaces/skills/cockpit-setup.skill.md'), 'utf8')).replace('{{tool-equivalence}}', 'Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.')
    const procedure = await readFile(resolve('packages/cockpit/surfaces/skills/procedures/setup.md'), 'utf8')
    const declaration = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8'))
        .replace('name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
    await Promise.all([
        mkdir(join(root, 'app'), { recursive: true }),
        mkdir(join(root, 'fixtures'), { recursive: true }),
    ])
    await writeFile(join(root, 'app/AGENTS.md'), 'Synthetic sibling guide.\n')
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    await writeFile(configPath, `${declaration.replace(
        'purpose = "Synthetic application"',
        'purpose = "Synthetic application"\nguides = ["AGENTS.md"]',
    )}
[[surfaces.overlays]]
name = "cockpit-setup"
feature = "skills"
source = "surfaces/bootstrap-override.json"
replaces = { name = "cockpit-setup", sha256 = "${'a'.repeat(64)}" }
sources = [
  { path = "skills/cockpit-setup/SKILL.md", bytes = ${JSON.stringify(entryPoint.replace('Bootstrap this cockpit', 'Bootstrap this synthetic cockpit'))} },
  { path = "skills/cockpit-setup/procedures/setup.md", bytes = ${JSON.stringify(procedure)} },
]
`)
    return { root, configPath }
}

// Each case drives the real lifecycle owners through dozens of child processes (fenced execution,
// publication helpers, Git and runtime probes), so its wall time scales with machine load rather
// than with the work under test. The budget is sized for four concurrent workers on a busy host.
describe('production health adapter composition', { timeout: 180_000 }, () => {
    it.each(['linked', 'nested'] as const)('reports surfaces-only readiness from a %s checkout without inventing runtime evidence', async (layout) => {
        const candidate = await fixture({ unseeded: true })
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8')).split('[environment]')[0]!)
        await writeFile(join(candidate.checkout, '.gitignore'), '*\n!.gitignore\n!cockpit.toml\n')
        await run('git', ['-C', candidate.checkout, 'add', 'cockpit.toml', '.gitignore'])
        await run('git', ['-C', candidate.checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '-m', 'declare synthetic surfaces'])
        const root = layout === 'linked' ? join(candidate.root, 'linked') : join(candidate.checkout, 'nested')
        if (layout === 'linked') await run('git', ['-C', candidate.checkout, 'worktree', 'add', '--quiet', '--detach', root])
        else await mkdir(root)
        const configPath = join(root, 'cockpit.toml')
        if (layout === 'nested') await writeFile(configPath, await readFile(candidate.configPath, 'utf8'))
        await mkdir(join(root, 'siblings/api'), { recursive: true })
        expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete', status: 0 })
        const env = { PATH: '/usr/bin:/bin', HOME: candidate.home, NO_UPDATE_NOTIFIER: '1' }
        const doctor = async () => {
            let stdout = ''
            expect(await runCli(['doctor', '--config', configPath, '--json'], {
                stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true },
            }, {}, { env })).toBe(0)
            return JSON.parse(stdout)
        }
        const report = await doctor()
        expect(report.diagnostics, JSON.stringify(report.diagnostics)).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID' }),
        ]))
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' }))
        expect(report.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'HARNESS_SURFACE_UNAVAILABLE', verdict: 'pass' }),
            expect.objectContaining({ code: 'STATE_UNSEEDED', verdict: 'not-applicable' }),
            expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', verdict: 'not-applicable' }),
            expect.objectContaining({ code: 'RUNNING_CHECKOUT_MISMATCH', verdict: 'not-applicable' }),
        ]))
        expect(report.result.verdict).not.toBe('pass')
        await writeFile(join(root, 'AGENTS.md'), 'Changed generated guidance.\n')
        const changed = await doctor()
        expect(changed.result.freshness.local.status).toBe(2)
        expect(changed.result.checks).not.toContainEqual(expect.objectContaining({ code: 'HARNESS_SURFACE_UNAVAILABLE', verdict: 'pass' }))
    })

    it('passes seeded machine-floor health through public routes and refuses changed published surfaces', async () => {
        const candidate = await fixture({ machineOnly: true })
        const api = join(candidate.checkout, 'siblings/api')
        await run('git', ['init', '--quiet', api])
        await run('git', ['-C', api, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
        await writeFile(join(candidate.checkout, '.gitignore'), '*\n!.gitignore\n!cockpit.toml\n')
        const published = await syncGeneratedEnvironment({ configPath: candidate.configPath })
        expect(published, JSON.stringify(published)).toMatchObject({ kind: 'complete', status: 0 })
        if (published.kind !== 'complete') throw new Error('published application is unavailable')
        expect(observeGeneratedApplicationSurfaces(published.result.application)?.find(row => row.code === 'DIRECTORY_GRANTS_UNAVAILABLE'))
            .toMatchObject({ applicability: { state: 'not-applicable' } })
        await run('git', ['-C', candidate.checkout, 'add', 'cockpit.toml', '.gitignore'])
        await run('git', ['-C', candidate.checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '--allow-empty', '-m', 'publish synthetic surfaces'])
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)
        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        expect(preflight, JSON.stringify(preflight)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
        expect(doctor, JSON.stringify(doctor)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
        expect(execute.mock.calls.some(([step]) => step.argv.includes('up') || step.argv.includes('stop'))).toBe(false)
        const guide = join(candidate.checkout, 'AGENTS.md')
        if (published.kind !== 'complete') throw new Error('published surface projection is unavailable')
        const entry = published.result.application.surfaceManifest.entries.find(row => row.path === 'AGENTS.md')
        if (!entry || entry.kind !== 'shared-region' || entry.region.format !== 'markdown-delimited') throw new Error('published guide region is unavailable')
        const guideBytes = await readFile(guide, 'utf8')
        expect(guideBytes).toContain(entry.region.bytes)
        await writeFile(guide, guideBytes.replace(entry.region.bytes, `${entry.region.bytes}Changed owned guidance.\n`))
        const changed = await runPreflight({ configPath: candidate.configPath }, adapters)
        expect(changed).toMatchObject({ kind: 'blocked', status: 2 })
        expect(changed.result.checks).toContainEqual(expect.objectContaining({ code: 'HARNESS_SURFACE_UNAVAILABLE', verdict: 'unavailable' }))
    })

    // One stack serves every comparison race: bringing it up dominates the cost, and each race
    // restores the bytes it changed before the next one starts.
    it('runs every check that needs no running stack before the first bring-up, and names the bring-up', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true, uncommitted: true })
        // The synthetic runtime reports 2 GiB, so this floor cannot be met.
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('runtime_memory_mb = 1024', 'runtime_memory_mb = 99999999'))
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        const fix = `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config ${candidate.configPath}`

        expect(preflight).toMatchObject({ kind: 'blocked', status: 2, result: { verdict: 'fail' } })
        expect(doctor).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'fail' } })
        for (const outcome of [preflight, doctor]) {
            expect(outcome.diagnostics[0]).toMatchObject({
                severity: 'error', code: 'STATE_UNSEEDED', target: candidate.configPath,
                message: expect.stringContaining(`fix: ${fix}`), fix,
            })
            expect(outcome.result.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', verdict: 'fail' }),
                expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'fail' }),
                expect.objectContaining({ code: 'SIBLING_MISSING', verdict: 'pass' }),
                expect.objectContaining({ code: 'MOUNT_MATERIALIZATION_UNAVAILABLE', verdict: 'not-applicable',
                    reason: expect.stringContaining('observed only while the stack runs') }),
            ]))
        }

        // A home directory this process cannot write, as inside a sandbox, is named with the check it
        // failed; doctor and up used to report only that their evidence was unavailable.
        const readOnlyHome = join(candidate.root, 'read-only-home')
        await mkdir(readOnlyHome, { mode: 0o500 })
        try {
            const env = { PATH: `${candidate.root}:${process.env.PATH}`, HOME: readOnlyHome }
            const configPath = candidate.configPath
            const refusedDoctor = await runDoctor({ configPath }, createHealthCommandAdapters({ configPath, env, timeoutMs: 5_000 }, executeProbe))
            const refusedUp = await runUp({ configPath }, createLifecycleCommandAdapters({ configPath, env, sessionId: 'read-only-home', timeoutMs: 5_000 }, executeProbe))
            for (const outcome of [refusedDoctor, refusedUp]) {
                expect(outcome.diagnostics, JSON.stringify(outcome.diagnostics)).toContainEqual(expect.objectContaining({
                    severity: 'error', code: 'STATE_ROOT_UNAVAILABLE', message: expect.stringContaining(`${readOnlyHome} is not writable by its owner`) }))
            }
        } finally {
            await chmod(readOnlyHome, 0o700)
        }
    })

    it('says a sleeping stack is asleep and to run up, and still checks what needs no running stack', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const holder = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'slept-session' })
        // What `sleep` leaves behind: no session holds the stack and its port lease is released.
        const address = candidate.namespace.paths.coordination(candidate.stack)
        const asleep = await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
            subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
            value: { holders: [], lastReleasedHolder: holder, drain: null,
                lease: { offset: 0, ports: { APP_PORT: 61230 }, released: true, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
        }))
        expect(asleep.kind).toBe('complete')
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(preflight).toMatchObject({ kind: 'blocked', status: 2 })
        expect(doctor).toMatchObject({ kind: 'complete', status: 0 })
        for (const outcome of [preflight, doctor]) {
            expect(outcome.diagnostics[0]).toMatchObject({
                severity: 'error', code: 'STACK_NOT_RUNNING', target: candidate.stack,
                message: expect.stringContaining('is asleep'),
                fix: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config ${candidate.configPath}`,
            })
            expect(outcome.result.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'pass' }),
                expect.objectContaining({ code: 'RUNNING_CHECKOUT_MISMATCH', verdict: 'not-applicable',
                    reason: expect.stringContaining('observed only while the stack runs') }),
            ]))
            expect(outcome.result.verdict).not.toBe('pass')
        }
    })

    it('still reports when a session holds a stack whose runtime cannot be read, instead of refusing the whole doctor', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const holder = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'gone-session' })
        // A holder left by a session that ended without releasing the stack, with nothing running.
        const address = candidate.namespace.paths.coordination(candidate.stack)
        const held = await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
            subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
            value: { holders: [{ holderId: holder, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), claimedAt: new Date().toISOString() }],
                lastReleasedHolder: null, drain: null,
                lease: { offset: 0, ports: { APP_PORT: 61230 }, released: false, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
        }))
        expect(held.kind).toBe('complete')

        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe))

        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('LIFECYCLE_EVIDENCE_INVALID')
        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ code: 'STACK_NOT_RUNNING', target: candidate.stack,
            message: expect.stringContaining('a session holds this stack') }))
    })

    // A held stack whose services could not be read never had Docker probed, so with an unusable Docker
    // doctor named no runtime problem. A failing docker first on PATH stands in for it on any machine;
    // removing docker from PATH does not, since a CI runner keeps one in /usr/bin.
    it('names an unusable Docker when a session holds a stack whose services could not be read', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const holder = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'no-docker-session' })
        const address = candidate.namespace.paths.coordination(candidate.stack)
        const held = await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
            subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
            value: { holders: [{ holderId: holder, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), claimedAt: new Date().toISOString() }],
                lastReleasedHolder: null, drain: null,
                lease: { offset: 0, ports: { APP_PORT: 61230 }, released: false, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
        }))
        expect(held.kind).toBe('complete')

        const broken = join(candidate.root, 'broken-docker')
        await mkdir(broken)
        await writeFile(join(broken, 'docker'), '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n')
        await chmod(join(broken, 'docker'), 0o755)
        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH: `${broken}:/usr/bin:/bin`, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))

        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', target: candidate.stack }))
    })

    // A row with no evidence says nothing about its prerequisite, yet the readiness summary listed it as
    // missing: a runtime row with none read as the container runtime, whose need names the Compose
    // floor, so a current Compose read as too old.
    it('lists no readiness gap for a check that had no evidence because the running stack could not be read', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const holder = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'unread-session' })
        const address = candidate.namespace.paths.coordination(candidate.stack)
        const held = await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
            subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
            value: { holders: [{ holderId: holder, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), claimedAt: new Date().toISOString() }],
                lastReleasedHolder: null, drain: null,
                lease: { offset: 0, ports: { APP_PORT: 61230 }, released: false, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
        }))
        expect(held.kind).toBe('complete')

        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe))

        // The rows a running stack answers had no evidence, and none of them is a missing prerequisite.
        expect(doctor.diagnostics.filter(({ code }) => code === 'STACK_NOT_RUNNING' || code === 'RUNTIME_UNAVAILABLE')).toEqual([expect.objectContaining({ code: 'STACK_NOT_RUNNING', target: candidate.stack, message: expect.stringContaining('a session holds this stack') })])
        expect(doctor.result.checks).toContainEqual(expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', source: `${candidate.configPath}:working-tree`, verdict: 'pass' }))
        const gaps = (doctor.result as { readiness: { gaps: readonly { id: string; findings: readonly { message: string }[] }[] } }).readiness.gaps
        expect(gaps.flatMap(({ findings }) => findings.map(({ message }) => message))).not.toContainEqual(expect.stringContaining('evidence is missing'))
        expect(gaps.map(({ id }) => id)).not.toContain('cockpit-committed')
    })

    // A session whose up refused exits without its closing sleep, and its hold stays behind with
    // nothing running; doctor read that stack as held by a session that no longer exists.
    it('says a stack is asleep when every session holding it has ended, and not while one runs or cannot be confirmed gone', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const checkout = checkoutId({ checkoutPath: candidate.checkout })
        const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const exited = once(session, 'exit')
        try {
            const started = await observeProcessStart(session.pid!, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            const address = candidate.namespace.paths.coordination(candidate.stack)
            const held = await transactState(candidate.namespace, address, { ownerId: holderId({ stackId: candidate.stack, checkoutId: checkout, sessionId: 'ended-session' }) }, () => ({
                format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
                subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
                value: { holders: ['ended-session', 'other-ended-session'].map((sessionId) => ({
                    holderId: holderId({ stackId: candidate.stack, checkoutId: checkout, sessionId }), checkoutId: checkout,
                    claimedAt: new Date().toISOString(), pid: session.pid!, processStart: started.start })),
                lastReleasedHolder: null,
                lease: { offset: 0, ports: { APP_PORT: 61230 }, released: false, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
            }))
            expect(held.kind).toBe('complete')
            const doctor = (execute: typeof executeProbe) => runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
                configPath: candidate.configPath,
                env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
                timeoutMs: 5_000,
            }, execute))
            // A presence probe that answers nothing, as under a sandbox, leaves the session unconfirmed.
            const unconfirmed: typeof executeProbe = async (step) => step.id.startsWith('process:presence:')
                ? { kind: 'refusal' } as unknown as Awaited<ReturnType<typeof executeProbe>> : executeProbe(step)

            for (const execute of [executeProbe, unconfirmed]) {
                if (execute === unconfirmed) {
                    session.kill('SIGKILL')
                    await exited
                }
                const reported = await doctor(execute)
                expect(reported.diagnostics).toContainEqual(expect.objectContaining({ code: 'STACK_NOT_RUNNING',
                    message: expect.stringContaining('a session holds this stack') }))
                expect(reported.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('is asleep'))
            }

            const ended = await doctor(executeProbe)
            expect(ended).toMatchObject({ kind: 'complete', status: 0 })
            expect(ended.diagnostics).toContainEqual(expect.objectContaining({ code: 'STACK_NOT_RUNNING', target: candidate.stack,
                message: expect.stringContaining('is asleep'),
                fix: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config ${candidate.configPath}` }))
            expect(ended.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('a session holds this stack'))
        } finally {
            session.kill('SIGKILL')
        }
    })

    // A stack whose sessions all ended read as running until its reads failed, so about a dozen checks
    // that need no running stack, the machine floors and agent surfaces among them, were listed as
    // missing-evidence errors. The checks only a running stack answers are named on one info line.
    it.each(['never brought up', 'held only by ended sessions'] as const)('groups the checks a stack %s cannot answer on one line that is not an error', async (state) => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: state === 'never brought up' })
        const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const exited = once(session, 'exit')
        try {
            if (state === 'held only by ended sessions') {
                const checkout = checkoutId({ checkoutPath: candidate.checkout })
                const started = await observeProcessStart(session.pid!, processHost(executeProbe))
                if (started.state !== 'present') throw new Error(JSON.stringify(started))
                const holder = holderId({ stackId: candidate.stack, checkoutId: checkout, sessionId: 'ended-session' })
                const address = candidate.namespace.paths.coordination(candidate.stack)
                expect((await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
                    format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
                    subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
                    value: { holders: [{ holderId: holder, checkoutId: checkout, claimedAt: new Date().toISOString(), pid: session.pid!, processStart: started.start }],
                        lastReleasedHolder: null,
                        lease: { offset: 0, ports: { APP_PORT: 61230 }, released: false, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
                }))).kind).toBe('complete')
                // Docker lists none of the stack's containers, as after a restart.
                const docker = join(candidate.root, 'docker')
                await writeFile(docker, (await readFile(docker, 'utf8'))
                    .replace('if [ "$1" = "compose" ]; then', 'case " $* " in *" ps "*) exit 0 ;; esac\nif [ "$1" = "compose" ]; then'))
            }
            session.kill('SIGKILL')
            await exited
            const doctor = async (json: boolean) => {
                let stdout = ''
                expect(await runCli(['doctor', '--config', candidate.configPath, ...json ? ['--json'] : []], {
                    stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true },
                }, {}, { env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home, NO_UPDATE_NOTIFIER: '1' } })).toBe(0)
                return stdout
            }

            const report = JSON.parse(await doctor(true)) as { diagnostics: { severity: string; code: string; message: string }[]; result: { checks: { code: string; verdict: string }[] } }
            const grouped = report.diagnostics.filter(({ code }) => code === 'CHECKS_NEED_RUNNING_STACK')
            expect(grouped).toEqual([expect.objectContaining({ severity: 'info',
                message: expect.stringMatching(/^not checked: needs a running stack \(\d+ checks: [^)]*running-checkout[^)]*\)$/) })])
            expect(report.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('evidence is missing'))
            expect(report.diagnostics.map(({ code }) => code)).not.toContain('EVIDENCE_UNAVAILABLE')
            expect(report.result.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'pass' }),
                expect.objectContaining({ code: 'RUNNING_CHECKOUT_MISMATCH', verdict: 'not-applicable' }),
            ]))
            const errors = report.diagnostics.filter(({ severity }) => severity === 'error').length
            const human = await doctor(false)
            expect(human).toContain(`Findings: ${errors} error${errors === 1 ? '' : 's'}`)
            expect(human).toContain('INFO CHECKS_NEED_RUNNING_STACK')
        } finally {
            session.kill('SIGKILL')
        }
    })

    // The hold a session left when it ended without its closing sleep, its process confirmed gone.
    async function holdLeftByEndedSession(candidate: Awaited<ReturnType<typeof fixture>>) {
        const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const exited = once(session, 'exit')
        try {
            const checkout = checkoutId({ checkoutPath: candidate.checkout })
            const started = await observeProcessStart(session.pid!, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            const holder = holderId({ stackId: candidate.stack, checkoutId: checkout, sessionId: 'ended-session' })
            const address = candidate.namespace.paths.coordination(candidate.stack)
            expect((await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
                format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
                subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
                value: { holders: [{ holderId: holder, checkoutId: checkout, claimedAt: new Date().toISOString(), pid: session.pid!, processStart: started.start }],
                    lastReleasedHolder: null,
                    lease: { offset: 0, ports: { APP_PORT: 61230 }, released: false, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
            }))).kind).toBe('complete')
        } finally {
            session.kill('SIGKILL')
            await exited
        }
    }

    // A terminal that joined a session's stack and ran sleep released only its own hold, and the session
    // then ended without its closing sleep. Docker lists the stack, but its lifecycle record names the
    // released hold, so the stack cannot be read. Doctor had already committed every check to a running
    // stack: beside the one stack finding, each check that needs no stack failed as missing evidence.
    it('reports a stack its ended sessions left once when Docker lists it but it cannot be read, and still runs the checks that need no stack', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        await holdLeftByEndedSession(candidate)
        // The up the released hold ran started every service.
        const released = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'health-fixture' })
        const lifecycle = candidate.namespace.paths.lifecycle(candidate.stack)
        expect((await transactState(candidate.namespace, lifecycle, { ownerId: released }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'lifecycle' as const, cockpitId: lifecycle.cockpitId, subjectId: candidate.stack,
            revision: 1, updatedAt: new Date().toISOString(),
            value: { holderId: released, workBasisSha256: '1'.repeat(64), operationGeneration: '2'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'a'.repeat(64) }], steady: true },
        }))).kind).toBe('complete')
        const project = composeProjectName({ cockpitName: 'synthetic-cockpit', stackId: candidate.stack })
        const docker = join(candidate.root, 'docker')
        await writeFile(docker, (await readFile(docker, 'utf8')).replace('if [ "$1" = "compose" ]; then',
            `case " $* " in *" ps "*) printf '%s\\n' '{"Project":"${project}","Service":"api","State":"running"}'; exit 0 ;; esac\nif [ "$1" = "compose" ]; then`))

        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe))

        expect(doctor.diagnostics.filter(({ code }) => code === 'STACK_NOT_RUNNING'), JSON.stringify(doctor.diagnostics)).toEqual([
            expect.objectContaining({ target: candidate.stack, message: expect.stringContaining('every session that held this stack has ended') })])
        // Docker listed a running service, so the stack is not called asleep.
        expect(doctor.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('is asleep'))
        expect(doctor.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('evidence is missing'))
        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('EVIDENCE_UNAVAILABLE')
        expect(doctor.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'pass' }),
            expect.objectContaining({ code: 'RUNNING_CHECKOUT_MISMATCH', verdict: 'not-applicable' }),
        ]))
    })

    // Docker that could not say what runs left the verdict to the running-stack reads, which failed after
    // every check was committed to a running stack. Calling the stack asleep instead would hide
    // containers that may still run, so the one finding says Docker could not be read.
    // The machine floor is measured through Docker, so with no Docker to reach it is not applicable
    // rather than missing evidence.
    it.each([
        ['cannot list the stack\'s services', 'case " $* " in *" ps "*) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;; esac\n', 'pass'],
        ['cannot be reached at all', 'echo "Cannot connect to the Docker daemon" >&2; exit 1\n', 'not-applicable'],
    ])('says once that Docker could not be read when it %s for a stack its ended sessions left, and still runs the checks that need no stack', async (_, unreadable, floor) => {
        const candidate = await fixture({ configuredRuntime: true })
        await holdLeftByEndedSession(candidate)
        const docker = join(candidate.root, 'docker')
        await writeFile(docker, (await readFile(docker, 'utf8')).replace('#!/bin/sh\n', `#!/bin/sh\n${unreadable}`))

        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe))

        expect(doctor.diagnostics.filter(({ code }) => code === 'STACK_NOT_RUNNING' || code === 'RUNTIME_UNAVAILABLE'), JSON.stringify(doctor.diagnostics)).toEqual([
            expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', target: candidate.stack, message: expect.stringContaining('Docker') })])
        expect(doctor.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('is asleep'))
        expect(doctor.diagnostics.map(({ message }) => message)).not.toContainEqual(expect.stringContaining('evidence is missing'))
        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('EVIDENCE_UNAVAILABLE')
        expect(doctor.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: floor }),
            expect.objectContaining({ code: 'RUNNING_CHECKOUT_MISMATCH', verdict: 'not-applicable' }),
        ]))
    })

    it('names no check as waiting for a running stack in a cockpit that declares no runtime', async () => {
        const candidate = await fixture({ unseeded: true })
        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))

        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' }))
        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('CHECKS_NEED_RUNNING_STACK')
    })

    it('names a runtime probe that ran out of time on a busy machine instead of telling the reader to start Docker', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const docker = join(candidate.root, 'docker')
        await writeFile(docker, (await readFile(docker, 'utf8')).replace('#!/bin/sh\n', '#!/bin/sh\nif [ "$1" = "version" ]; then /bin/sleep 20; fi\n'))
        const doctor = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 3_000,
        }, executeProbe))

        expect(doctor.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'EXECUTION_TIMEOUT', target: 'runtime:docker-server-version',
                message: 'the runtime:docker-server-version probe timed out after 3 s, so the checks it answers were not observed' }),
            expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', message: expect.stringContaining('it timed out after 3 s'),
                fix: expect.stringContaining('too busy') }),
        ]))
    })

    it('names a cockpit root that is not a Git checkout instead of an unavailable observation', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, '.git'), { recursive: true, force: true })
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)

        expect(preflight).toMatchObject({ kind: 'blocked', status: 2, diagnostics: [{
            severity: 'error', code: 'SETUP_PATH_TYPE_INVALID', target: candidate.configPath,
            message: expect.stringContaining(`git -C ${candidate.checkout} init`),
        }] })

        // A cockpit that declares no runtime depends on its Git working tree all the same, so doctor names it.
        const surfacesOnly = await fixture({ unseeded: true })
        await rm(join(surfacesOnly.checkout, '.git'), { recursive: true, force: true })
        const doctor = await runDoctor({ configPath: surfacesOnly.configPath }, createHealthCommandAdapters({
            configPath: surfacesOnly.configPath, env: { PATH: process.env.PATH, HOME: surfacesOnly.home }, timeoutMs: 5_000,
        }, executeProbe))
        expect(doctor.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' }),
            expect.objectContaining({ code: 'SETUP_PATH_TYPE_INVALID', message: expect.stringContaining(`git -C ${surfacesOnly.checkout} init`) }),
        ]))
    })

    it('names a cockpit repository with no commits yet once, with the commands that commit it', async () => {
        const candidate = await fixture({ machineOnly: true, uncommitted: true })
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)

        const git = preflight.diagnostics.filter(({ code, target }) => ['GIT_STATE_UNHEALTHY', 'CHECKOUT_ADJACENCY_UNHEALTHY',
            'RUNNING_CHECKOUT_MISMATCH'].includes(code) || target === 'git')
        expect(git).toEqual([expect.objectContaining({
            code: 'GIT_STATE_UNHEALTHY',
            message: expect.stringContaining('has no commits yet'),
            fix: expect.stringContaining(`git -C ${candidate.checkout} add -A && git -C ${candidate.checkout} commit`),
        })])

        // Doctor checks an uncommitted cockpit that declares no runtime; preflight, the runtime gate, still only refuses it.
        const surfacesOnly = await fixture({ unseeded: true, uncommitted: true })
        // A mounted sibling runs nothing while no runtime is declared, so no Docker is needed.
        await writeFile(surfacesOnly.configPath, (await readFile(surfacesOnly.configPath, 'utf8')).replace('mount = "none"', 'mount = "always"'))
        const surfacesAdapters = createHealthCommandAdapters({
            configPath: surfacesOnly.configPath, env: { PATH: '/usr/bin:/bin', HOME: surfacesOnly.home }, timeoutMs: 5_000,
        }, executeProbe)
        const doctor = await runDoctor({ configPath: surfacesOnly.configPath }, surfacesAdapters)
        expect(doctor.diagnostics[0]).toMatchObject({ code: 'ENVIRONMENT_NOT_DECLARED' })
        expect(doctor.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', verdict: 'fail' }),
            expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', verdict: 'not-applicable', reason: expect.stringContaining('declares no runtime') }),
        ]))
        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('RUNTIME_UNAVAILABLE')
        expect((await runPreflight({ configPath: surfacesOnly.configPath }, surfacesAdapters)).diagnostics.map(({ code }) => code))
            .toEqual(['ENVIRONMENT_NOT_DECLARED'])
    })

    it('warns from doctor when Codex on this machine has not trusted the published guard hook', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await mkdir(join(candidate.checkout, '.codex'))
        await writeFile(join(candidate.checkout, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] } }))
        // Codex has run as this user, so it has a home, but has recorded no trust.
        await mkdir(join(candidate.home, '.codex'))
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'CODEX_HOOK_UNTRUSTED',
            message: expect.stringContaining(`Codex has not trusted the guard hook in ${join(candidate.checkout, '.codex/hooks.json')}`) }))
        // A team that does not list Codex gets no Codex advice, even beside a leftover hooks.json.
        await writeFile(candidate.configPath, `${await readFile(candidate.configPath, 'utf8')}\n[surfaces]\ntools = ["claudecode"]\n`)
        const claudeOnly = await runDoctor({ configPath: candidate.configPath }, adapters)
        expect(claudeOnly.diagnostics.map(({ code }) => code)).not.toContain('CODEX_HOOK_UNTRUSTED')
    })

    it('warns from doctor when Claude Code\'s local settings do not repeat the guard registration', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const settings = join(candidate.checkout, '.claude')
        await mkdir(settings)
        const registration = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'H="$r/.cockpit/guards/bash-guard.sh"; /bin/bash "$H" --harness claudecode' }] }] } }
        await writeFile(join(settings, 'settings.json'), JSON.stringify(registration))
        const adapters = createHealthCommandAdapters({ configPath: candidate.configPath, env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home }, timeoutMs: 5_000 }, executeProbe)
        const codes = async () => (await runDoctor({ configPath: candidate.configPath }, adapters)).diagnostics.map(({ code }) => code)
        expect(await codes()).toContain('CLAUDE_LOCAL_HOOK_MISSING')
        await writeFile(join(settings, 'settings.local.json'), JSON.stringify(registration))
        expect(await codes()).not.toContain('CLAUDE_LOCAL_HOOK_MISSING')
    })

    it('reports the root-checkout discovery mismatch from both doctor readiness and check', async () => {
        const candidate = await fixture({ unseeded: true })
        const linked = join(candidate.root, 'linked')
        await run('git', ['-C', candidate.checkout, 'worktree', 'add', '--quiet', '--detach', linked])
        const configPath = join(linked, 'cockpit.toml')
        await writeFile(configPath, (await readFile(configPath, 'utf8')).split('[environment]')[0]!)
        await mkdir(join(linked, 'siblings/api'), { recursive: true })
        await mkdir(join(candidate.home, '.codex'))
        expect(await syncTeamGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete', status: 0 })
        const env = { PATH: '/usr/bin:/bin', HOME: candidate.home, NO_UPDATE_NOTIFIER: '1' }
        for (const command of ['doctor', 'check']) {
            let stdout = ''
            const status = await runCli([command, '--config', configPath, '--json'], {
                stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true },
            }, {}, { env })
            expect(status, stdout).toBe(0)
            const report = JSON.parse(stdout)
            expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_HOOK_SOURCE_MISMATCH',
                message: expect.stringContaining(join(candidate.checkout, '.codex/hooks.json')) }))
            if (command === 'doctor') expect(report.result.readiness.gaps).toContainEqual(expect.objectContaining({
                id: 'codex-hook-trusted', findings: expect.arrayContaining([expect.objectContaining({ code: 'CODEX_HOOK_SOURCE_MISMATCH' })]),
            }))
        }
    })

    it('gives preflight the observation path doctor has, and says why when it cannot select Git', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const preflight = async (PATH: string) => runPreflight({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))
        const absolutePath = `${candidate.root}:/usr/bin:/bin`
        const codes = async (PATH: string) => (await preflight(PATH)).diagnostics.map(({ code }) => code)
        expect(await codes(`./node_modules/.bin:${absolutePath}`)).toEqual(await codes(absolutePath))
        const noGit = join(candidate.root, 'no-git')
        await mkdir(noGit)
        const unavailable = (await preflight(noGit)).diagnostics
        expect(unavailable).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE', target: 'PATH',
            message: expect.stringContaining('preflight cannot find Git to observe the checkout: Executable was not found in the supplied search path: git') }))
        expect((await preflight('/usr/bin/../bin:/bin')).diagnostics).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE', target: 'PATH',
            message: expect.stringContaining('preflight\'s observation tools cannot be selected') }))
        // With nothing declared there is nothing to observe, so the answer does not depend on PATH; doctor still observes the checkout.
        const surfacesOnly = await fixture({ unseeded: true })
        const noncanonical = { configPath: surfacesOnly.configPath, env: { PATH: '/usr/bin/../bin:/bin', HOME: surfacesOnly.home }, timeoutMs: 5_000 }
        expect((await runPreflight({ configPath: surfacesOnly.configPath }, createHealthCommandAdapters(noncanonical, executeProbe))).diagnostics)
            .toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' })])
        expect((await runDoctor({ configPath: surfacesOnly.configPath }, createHealthCommandAdapters(noncanonical, executeProbe))).diagnostics)
            .toContainEqual(expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE', target: 'PATH' }))
    })

    it('warns from doctor when PATH holds a relative entry, under which the guard asks before every command', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const doctor = async (PATH: string) => runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))
        const warning = expect.objectContaining({ severity: 'warning', code: 'GUARD_SEARCH_PATH_RELATIVE', target: 'PATH' })

        expect((await doctor('/usr/bin:/bin')).diagnostics).not.toContainEqual(warning)
        expect((await doctor('/usr/bin:./node_modules/.bin:/bin')).diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_SEARCH_PATH_RELATIVE',
            message: expect.stringContaining('PATH holds the relative entry "./node_modules/.bin"') }))
        expect((await doctor('/usr/bin::/bin')).diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_SEARCH_PATH_RELATIVE',
            message: expect.stringContaining('an empty entry is the working directory') }))
    })

    it('warns from doctor once the cockpit has work orders or chose its grading, when no evaluator work.evaluators lists is on PATH, and says how each order closed', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const doctor = async () => runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))
        const warning = expect.objectContaining({ severity: 'warning', code: 'EVALUATOR_UNAVAILABLE', target: 'work.grading' })

        // On the default mode with no work orders, nothing would run an evaluator yet.
        expect((await doctor()).diagnostics).not.toContainEqual(warning)
        await mkdir(join(candidate.checkout, 'workorders'))
        expect((await doctor()).diagnostics).toContainEqual(warning)
        await writeFile(join(candidate.root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        expect((await doctor()).diagnostics).not.toContainEqual(warning)
        // Codex on PATH says nothing about a cockpit whose list names only Claude Code and OpenCode.
        await writeFile(candidate.configPath, `${await readFile(candidate.configPath, 'utf8')}\n[work]\nevaluators = ["claudecode", "opencode"]\n`)
        expect((await doctor()).diagnostics).toContainEqual(expect.objectContaining({ code: 'EVALUATOR_UNAVAILABLE',
            message: expect.stringMatching(/Claude Code \(claude\) is not on PATH; install it with .*; OpenCode \(opencode\) is not on PATH; install it/) }))
        await writeFile(join(candidate.root, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        expect((await doctor()).diagnostics).not.toContainEqual(warning)

        // Left unset, the evaluators are the listed tools: a Claude Code team is not sent to install Codex.
        const claudeTeam = await fixture({ configuredRuntime: true, unseeded: true })
        await mkdir(join(claudeTeam.checkout, 'workorders'))
        await writeFile(join(claudeTeam.root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        await writeFile(claudeTeam.configPath, `${await readFile(claudeTeam.configPath, 'utf8')}\n[surfaces]\ntools = ["claudecode"]\n`)
        const claudeDoctor = await runDoctor({ configPath: claudeTeam.configPath }, createHealthCommandAdapters({
            configPath: claudeTeam.configPath, env: { PATH: `${claudeTeam.root}:/usr/bin:/bin`, HOME: claudeTeam.home }, timeoutMs: 5_000,
        }, executeProbe))
        const unavailable = claudeDoctor.diagnostics.find(row => row.code === 'EVALUATOR_UNAVAILABLE')
        expect(unavailable?.message).toMatch(/Claude Code \(claude\) is not on PATH/)
        expect(unavailable?.message).not.toMatch(/Codex|OpenCode/)

        const at = '2026-11-03T10:00:00.000Z', digest = 'a'.repeat(64)
        await mkdir(join(candidate.checkout, '.cockpit/work-orders'), { recursive: true })
        await writeFile(join(candidate.checkout, '.cockpit/work-orders/WO-1.json'), JSON.stringify({ format: 'cockpit-work-order/v1', id: 'WO-1', state: 'done',
            accepted: { at, by: 'agent', digest, sources: {}, base: { '.': 'b'.repeat(40) },
                order: { id: 'WO-1', objective: 'One outcome.', scope: ['src/'], depends_on: [], gates: [], criteria: [{ id: 'AC1', text: 'It holds.' }], non_goals: [] } },
            amendments: [], acknowledgements: [], attempts: 0, notes: [], closure: { at, by: 'agent', how: 'checks-passed' } }))
        expect((await doctor()).diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'WORK_ORDER_CLOSED',
            target: 'workorders/WO-1.md', message: 'WO-1 closed as checks-passed, signed off by agent' }))
    })

    it('reports whether the configured grading can run here, and says what it could not observe', async () => {
        const doctorWith = async (work: string, onPath: boolean) => {
            const candidate = await fixture({ configuredRuntime: true, unseeded: true })
            await writeFile(candidate.configPath, `${await readFile(candidate.configPath, 'utf8')}\n${work}\n`)
            if (onPath) await writeFile(join(candidate.root, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
            const report = await runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
                configPath: candidate.configPath, env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }, timeoutMs: 5_000 }, executeProbe))
            return report.diagnostics.filter(row => row.target === 'work.grading')
        }
        for (const grading of ['checks', 'self', 'off']) expect(await doctorWith(`[work]\ngrading = "${grading}"`, false), grading).toEqual([])
        const subagent = '[work]\ngrading = "subagent"\nevaluators = ["claudecode"]'
        expect(await doctorWith(subagent, true)).toEqual([expect.objectContaining({ severity: 'info', code: 'SUBAGENT_AVAILABILITY_UNOBSERVED',
            message: expect.stringContaining('cannot observe ahead of time whether the working agent can spawn a subagent, so this was not checked') })])
        expect(await doctorWith(subagent, false)).toEqual([expect.objectContaining({ severity: 'warning', code: 'EVALUATOR_UNAVAILABLE',
            message: expect.stringMatching(/no stronger path if the working agent cannot spawn a subagent, which cockpit cannot observe ahead of time, because .*Claude Code \(claude\) is not on PATH/) })])
    })

    it('preserves a lifecycle owner refusal before observing Docker', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const lifecycle = candidate.namespace.paths.lifecycle(candidate.stack)
        await writeFile(lifecycle.path, '{}\n')
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        for (const outcome of [preflight, doctor]) {
            expect(outcome.result).toMatchObject({ verdict: 'unavailable', checks: [] })
            expect(outcome.diagnostics).toContainEqual({
                severity: 'error', code: 'STATE_RECORD_MALFORMED', target: lifecycle.path,
                message: 'state record is malformed or does not match its address',
                fix: 'inspect the lifecycle record; once no cockpit command runs for this stack, run down and up to start it afresh',
            })
        }
        expect(execute.mock.calls.some(([step]) => step.argv0 === join(candidate.root, 'docker'))).toBe(false)
    })

    it('inspects active surface overrides through an authenticated generated preview', async () => {
        const candidate = await surfaceOverrideFixture()
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.root },
            timeoutMs: 5_000,
        }, execute)

        const result = await adapters.inspectSurfaceOverrides?.(candidate.configPath)

        expect(result).toMatchObject({
            kind: 'complete',
            activeOverrides: [{
                name: 'cockpit-setup',
                feature: 'skills',
                recordedSha256: 'a'.repeat(64),
                overlaySource: 'surfaces/bootstrap-override.json',
            }],
            changedOverrideOriginals: [{
                code: 'OVERRIDDEN_CORE_CHANGED',
                name: 'cockpit-setup',
                recordedSha256: 'a'.repeat(64),
                overlaySource: 'surfaces/bootstrap-override.json',
            }],
        })
        expect(execute).toHaveBeenCalled()
    }, 120_000)

    it('names unavailable generated override inspection instead of returning an empty complete result', async () => {
        const adapters = createHealthCommandAdapters({
            configPath: '',
            env: { PATH: process.env.PATH },
            timeoutMs: 5_000,
        }, executeProbe)

        const result = await adapters.inspectSurfaceOverrides?.('')

        expect(result).toEqual({
            kind: 'unavailable',
            code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
            reason: 'surface override inspection needs valid command composition input',
        })
        expect(result).not.toHaveProperty('activeOverrides')
    })

    it('refuses override inspection for a different configuration path', async () => {
        const candidate = await fixture()
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const result = await adapters.inspectSurfaceOverrides?.(join(candidate.root, 'other.toml'))

        expect(result).toEqual({
            kind: 'refusal',
            code: 'SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH',
            reason: 'surface override inspection is bound to the configured cockpit source',
        })
        expect(result).not.toHaveProperty('activeOverrides')
    })

    it('derives steady authority and invokes the real owner producers', async () => {
        // Health needs a declared floor or runtime; with neither, doctor reports ENVIRONMENT_NOT_DECLARED.
        const candidate = await fixture({ machineOnly: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, Path: undefined, LC_ALL: undefined, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(execute.mock.calls.some(([step]) => step.id === 'git-health')).toBe(true)
        expect(result.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'environment-state' }),
            expect.objectContaining({ owner: 'git-observation' }),
            expect.objectContaining({ owner: 'environment-claims' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'PORT_FAMILY_COLLISION', verdict: 'not-applicable' }),
            expect.objectContaining({ owner: 'lifecycle-stage' }),
            expect.objectContaining({ owner: 'environment-template-seeding' }),
            expect.objectContaining({ owner: 'environment-template-seeding', code: 'SIBLING_MISSING' }),
            expect.objectContaining({ owner: 'environment-template-seeding', code: 'ENVIRONMENT_KEYS_STALE', verdict: 'pass', measured: true }),
            expect.objectContaining({ owner: 'environment-template-seeding', code: 'ENVIRONMENT_FILE_NOT_FOUND', verdict: 'pass', measured: true }),
        ]))
        expect(result.result.checks.find(({ owner }) => owner === 'lifecycle-stage')?.measured).toBe(true)
    })

    it('observes sibling Git, schemas and every declared template from a nested configuration', async () => {
        const candidate = await fixture({ machineOnly: true })
        const cockpitRoot = join(candidate.checkout, 'control')
        const configPath = join(cockpitRoot, 'cockpit.toml')
        const api = join(candidate.checkout, 'repositories/api')
        const web = join(candidate.checkout, 'repositories/web')
        await Promise.all([mkdir(cockpitRoot), mkdir(api, { recursive: true }), mkdir(web, { recursive: true })])
        const declarations = [
            'remote = "https://example.invalid/api.git"',
            'environment_files = [{ template = "first.template", instance = "first.instance" }, { template = "second.template", instance = "second.instance" }]',
            '',
            '[[sibling]]',
            'slug = "web"',
            'dir = "web"',
            'mount = "none"',
            'acquire = "none"',
            'var = "WEB_DIR"',
            'toolchain = "none"',
            'purpose = "Synthetic web"',
            'environment_files = [{ template = "web.template", instance = "web.instance" }]',
            '',
        ].join('\n')
        const config = await readFile(candidate.configPath, 'utf8')
        await writeFile(configPath, config.replace('siblings_root = "siblings"', 'siblings_root = "../repositories"')
            .replace('acquire = "none"', 'acquire = "manual"')
            .replace('[ports]', `${declarations}\n[ports]`))
        await Promise.all([
            writeFile(join(api, '.env.schema'), 'PUBLIC_NAME=\n'),
            writeFile(join(api, 'first.template'), 'FIRST=\n'),
            writeFile(join(api, 'first.instance'), 'FIRST=synthetic\n'),
            writeFile(join(api, 'second.template'), 'SECOND=\n'),
            writeFile(join(api, 'second.instance'), 'OTHER=synthetic\n'),
            writeFile(join(web, 'web.template'), 'WEB=\n'),
        ])
        await run('git', ['init', '--quiet', '--initial-branch=main', api])
        await run('git', ['-C', api, 'add', '--', '.env.schema', 'first.template', 'second.template'])
        await run('git', ['-C', api, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
        await run('git', ['-C', api, 'remote', 'add', 'origin', 'https://example.invalid/api.git'])
        await run('git', ['-C', api, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
        await run('git', ['-C', api, 'branch', '--set-upstream-to=origin/main', 'main'])
        await writeFile(join(candidate.root, 'varlock'), '#!/bin/sh\nprintf \'%s\\n\' \'{"config":{"PUBLIC_NAME":{}}}\'\n', { mode: 0o700 })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath,
            env: {
                PATH: `${candidate.root}:/usr/bin:/bin`,
                LANG: 'C',
                HOME: candidate.home,
            },
            timeoutMs: 5_000,
        }, execute)

        const observed = await runDoctor({ configPath }, adapters)
        const siblingGit = execute.mock.calls.map(([step]) => step).find(({ id, labels }) =>
            id === 'git-health' && labels.source === `${configPath}:api`)
        expect(siblingGit).toMatchObject({ cwd: api, argv: expect.arrayContaining(['-C', api]) })
        expect(siblingGit?.env).toEqual({ LANG: 'C' })
        expect(observed.result.comparisons).toContainEqual({ sibling: 'api', result: expect.objectContaining({ kind: 'complete', state: 'match' }) })
        expect(observed.result.checks).toContainEqual(expect.objectContaining({
            owner: 'env-schema-observation', verdict: 'pass', measured: [{ sibling: 'api', state: 'valid', keys: 1 }],
        }))
        const checks = observed.result.checks.filter(({ owner }) => owner === 'environment-template-seeding')
        expect(observed.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ target: 'templates' })]))
        expect(checks).toHaveLength(3)
        expect(checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'SIBLING_MISSING', verdict: 'pass' }),
            expect.objectContaining({ code: 'ENVIRONMENT_KEYS_STALE', verdict: 'fail' }),
            expect.objectContaining({ code: 'ENVIRONMENT_FILE_NOT_FOUND', verdict: 'fail' }),
        ]))
        expect(checks.find(({ code }) => code === 'ENVIRONMENT_KEYS_STALE')?.source).toContain('second.instance')
        expect(checks.find(({ code }) => code === 'ENVIRONMENT_FILE_NOT_FOUND')?.source).toContain('web.instance')

        await rm(web, { recursive: true })
        const missing = await runDoctor({ configPath }, adapters)
        expect(missing.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'SIBLING_MISSING', verdict: 'fail', source: expect.stringContaining('web') }),
        ]))
    }, 120_000)

    it('binds the public command path and never executes for a different configuration', async () => {
        const candidate = await fixture()
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runPreflight({ configPath: join(candidate.root, 'other.toml') }, adapters)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('validates every captured environment name before dispatch', async () => {
        const candidate = await fixture({ machineOnly: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, 'INVALID=NAME': undefined, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(result).toMatchObject({ result: { verdict: 'unavailable' } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('reports a malformed configuration from preflight and doctor instead of an unavailable source', async () => {
        const candidate = await fixture()
        await writeFile(candidate.configPath, '[cockpit\nname = "synthetic"\n')
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(preflight).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' },
            diagnostics: [{ code: 'CONFIG_PARSE_INVALID', target: candidate.configPath }] })
        expect(doctor).toMatchObject({ result: { verdict: 'unavailable' },
            diagnostics: [{ code: 'CONFIG_PARSE_INVALID', target: candidate.configPath }] })
        expect(execute).not.toHaveBeenCalled()
    })

    // An unresolvable declared remote made issuing the observation source throw, and a bare catch
    // turned that into an unexplained unavailable source.
    it('names an unresolvable local remote from doctor', async () => {
        const candidate = await fixture()
        await writeFile(join(dirname(candidate.configPath), 'siblings', 'plain-file'), 'not a directory')
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('dir = "api"\n', 'dir = "api"\nremote = "plain-file/api.git"\n').replace('acquire = "none"', 'acquire = "manual"'))
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID',
            message: expect.stringContaining('sibling api: cannot resolve declared local remote "plain-file/api.git" (ENOTDIR)') }))
    })

    it('rejects hostile public input without invoking its accessor', async () => {
        const candidate = await fixture()
        let reads = 0
        const input = Object.defineProperty({}, 'configPath', {
            enumerable: true,
            get() { reads += 1; throw new Error('hostile accessor') },
        })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runPreflight(input as never, adapters)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(reads).toBe(0)
        expect(execute).not.toHaveBeenCalled()
    })

    it('routes declared machine floors through authentic read-only owner plans', async () => {
        const candidate = await fixture({ machineOnly: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual(expect.arrayContaining([
            'runtime:measure:resources', 'runtime:measure:free-disk',
        ]))
        expect(result.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ target: 'host' }),
            expect.objectContaining({ target: 'runtime' }),
        ]))
        expect(result.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_MEMORY_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_CPU_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_DISK_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'RUNTIME_UNAVAILABLE' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'MOUNT_POSTURE_UNAVAILABLE' }),
        ]))
    })

    it('reissues exact posture and stage authority after a producer crosses the initial window', async () => {
        const candidate = await fixture({ machineOnly: true })
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-09-26T08:00:00.000Z'))
        let advanced = false
        const execute = async (step: Parameters<typeof executeProbe>[0]) => {
            if (!advanced) {
                advanced = true
                vi.setSystemTime(new Date('2026-09-26T08:00:31.000Z'))
            }
            return executeProbe(step)
        }
        try {
            const adapters = createHealthCommandAdapters({
                configPath: candidate.configPath,
                env: { PATH: process.env.PATH, HOME: candidate.home },
                timeoutMs: 5_000,
            }, execute)

            const result = await runDoctor({ configPath: candidate.configPath }, adapters)

            expect(advanced).toBe(true)
            expect(result.result.checks).not.toEqual([])
            expect(result.result.checks).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ reason: 'observation timestamp does not match the evaluation boundary' }),
            ]))
            expect(result.diagnostics).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining('authority has expired') }),
            ]))
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('served checkout health', () => {
    const owner = 'sibling-observation'

    async function recordServed(candidate: Awaited<ReturnType<typeof fixture>>, directory: string) {
        const local = join(dirname(candidate.configPath), '.cockpit', 'local')
        await mkdir(local, { recursive: true })
        await writeFile(join(local, 'sibling-checkouts'), `${JSON.stringify({ format: 'cockpit-sibling-checkouts/v1', checkouts: { api: directory } })}\n`)
    }

    async function rows(candidate: Awaited<ReturnType<typeof fixture>>) {
        const adapters = createHealthCommandAdapters({ configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }, timeoutMs: 5_000 }, vi.fn(executeProbe))
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        return [doctor, preflight].map(result => ({ result, row: result.result.checks.find(check => check.owner === owner) }))
    }

    // `up` refuses a recorded checkout that is gone, so a gate that only warned would pass a stack `up` cannot start.
    it('fails preflight and doctor for a recorded checkout that no longer exists, as up refuses it', async () => {
        const candidate = await fixture({ machineOnly: true })
        const gone = join(candidate.root, 'removed-worktree')
        await recordServed(candidate, gone)

        for (const { result, row } of await rows(candidate)) {
            expect(row).toMatchObject({ code: 'SIBLING_CHECKOUT_UNAVAILABLE', verdict: 'fail', measured: [gone] })
            expect(result.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ severity: 'error', code: 'SIBLING_CHECKOUT_UNAVAILABLE', target: 'served-checkouts' }),
            ]))
        }
    })

    it('passes the row when the recorded checkout exists', async () => {
        const candidate = await fixture({ machineOnly: true })
        const present = join(candidate.root, 'present-worktree')
        await mkdir(present)
        await recordServed(candidate, present)

        for (const { row } of await rows(candidate)) expect(row).toMatchObject({ verdict: 'pass', measured: [] })
    })
})

describe('env schema health', () => {
    // Distinctive enough that any copy of it in output or state is unmistakable.
    const SECRET = 'sentinel-resolved-value-7c1e94'
    const schemaOwner = 'env-schema-observation'

    async function commitSchema(repository: string, file: string) {
        await writeFile(join(repository, file), 'API_KEY=\n')
        await run('git', ['-C', repository, 'add', '--force', '--', file])
        await run('git', ['-C', repository, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'schema'])
    }

    async function withVarlock(candidate: Awaited<ReturnType<typeof fixture>>, body: string | undefined) {
        await commitSchema(candidate.checkout, join('siblings', 'api', '.env.schema'))
        if (body === undefined) return
        const path = join(candidate.root, 'varlock')
        await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
        await chmod(path, 0o700)
    }

    // A varlock report whose values and messages both carry the secret, as a real one can.
    const report = (errors?: Record<string, string>) => JSON.stringify({
        blobFormatVersion: 1,
        config: { API_KEY: { value: SECRET, isSensitive: true }, REGION: { value: SECRET, isSensitive: false } },
        ...(errors ? { errors: { configItems: errors } } : {}),
    })
    const printing = (json: string, exitCode: number) =>
        `cat <<'JSON'\n${json}\nJSON\nprintf '%s\\n' '${SECRET}' >&2\nexit ${exitCode}`

    async function health(candidate: Awaited<ReturnType<typeof fixture>>, options: { readonly path?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> } = {}) {
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: options.path ?? `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home, ...options.env },
            timeoutMs: options.timeoutMs ?? 5_000,
        }, execute)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const row = (result: typeof doctor | typeof preflight) => result.result.checks.find(({ owner }) => owner === schemaOwner)
        return { execute, doctor, preflight, row }
    }

    const varlockCalls = (execute: { readonly mock: { readonly calls: readonly (readonly [Parameters<typeof executeProbe>[0], ...unknown[]])[] } }) =>
        execute.mock.calls.map(([step]) => step).filter(({ id }) => id.startsWith('env-schema:'))

    async function files(directory: string): Promise<string[]> {
        const { readdir } = await import('node:fs/promises')
        const found: string[] = []
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) found.push(...await files(path))
            else if (entry.isFile()) found.push(path)
        }
        return found
    }

    it('reports a valid env schema for a sibling that contains .env.schema', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, `test "$VARLOCK_TELEMETRY_DISABLED" = true || exit 42\n${printing(report(), 0)}`)

        const { execute, doctor, preflight, row } = await health(candidate)

        expect(varlockCalls(execute)).toHaveLength(2)
        expect(varlockCalls(execute)[0]!.argv.slice(1)).toEqual([
            'load', '--agent', '--format', 'json-full', '--path', join(candidate.checkout, 'siblings', 'api'),
        ])
        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({
                code: 'ENV_SCHEMA_UNHEALTHY', verdict: 'pass', measured: [{ sibling: 'api', state: 'valid', keys: 2 }],
            })
        }
    })

    it('validates the checkout cockpit use serves, not the declared directory', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report(), 0))
        const worktree = join(candidate.root, 'api-worktree')
        await mkdir(worktree, { recursive: true })
        await run('git', ['init', '--quiet', worktree])
        await commitSchema(worktree, '.env.schema')
        const local = join(dirname(candidate.configPath), '.cockpit', 'local')
        await mkdir(local, { recursive: true })
        await writeFile(join(local, 'sibling-checkouts'), `${JSON.stringify({ format: 'cockpit-sibling-checkouts/v1', checkouts: { api: worktree } })}\n`)

        const { execute } = await health(candidate)

        expect(varlockCalls(execute).map(({ argv }) => argv[argv.indexOf('--path') + 1])).toContain(worktree)
        expect(varlockCalls(execute).map(({ argv }) => argv[argv.indexOf('--path') + 1])).not.toContain(join(candidate.checkout, 'siblings', 'api'))
    })

    it('does not run varlock for a sibling without .env.schema', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report(), 0))
        await rm(join(candidate.checkout, 'siblings', 'api', '.env.schema'))

        const { execute, doctor, row } = await health(candidate)

        expect(varlockCalls(execute)).toEqual([])
        expect(row(doctor)).toMatchObject({ verdict: 'pass', measured: [] })
    })

    it('never carries a resolved value into output, diagnostics or persisted state', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report({ API_KEY: `Value ${SECRET} is required but is currently empty`, REGION: `bad value ${SECRET}` }), 1))

        const { doctor, preflight } = await health(candidate)

        const everything = JSON.stringify([doctor, preflight])
        expect(everything).toContain('API_KEY')
        expect(everything).not.toContain(SECRET)
        const persisted = await Promise.all((await files(candidate.home)).map((path) => readFile(path, 'utf8')))
        expect(persisted.length).toBeGreaterThan(0)
        expect(persisted.join('\n')).not.toContain(SECRET)
    })

    it('warns, without failing the row, when varlock is not installed', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, undefined)

        const { doctor, preflight, row } = await health(candidate)

        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({ verdict: 'pass', measured: [{ sibling: 'api', state: 'tool-missing' }] })
            expect(result.diagnostics).toContainEqual(expect.objectContaining({
                severity: 'warning', code: 'ENV_SCHEMA_TOOL_MISSING', target: 'api', fix: expect.stringContaining('https://varlock.dev'),
            }))
        }
    })

    it('warns, without failing the row or running Varlock, about a schema that is not committed', async () => {
        const candidate = await fixture({ machineOnly: true })
        const marker = join(candidate.root, 'varlock-ran')
        await withVarlock(candidate, `touch '${marker}'\n${printing(report(), 0)}`)
        const api = join(candidate.checkout, 'siblings', 'api')
        await writeFile(join(api, '.env.schema'), 'API_KEY=exec("synthetic")\n')

        const { doctor, preflight, row } = await health(candidate)

        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({ verdict: 'pass', measured: [{ sibling: 'api', state: 'not-run' }] })
            expect(result.diagnostics).toContainEqual({
                severity: 'warning', code: 'ENV_SCHEMA_UNCOMMITTED', target: 'api',
                message: expect.stringMatching(new RegExp(`^api has an \\.env\\.schema that is not committed.*A person who reviewed it can run VARLOCK_TELEMETRY_DISABLED=true varlock load --path ${api}$`)),
                fix: 'commit the schema to have it validated, or have a person review it and run the load this message names',
            })
        }
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    // A product's own env gap is the product's to fix; it must not stop every agent's preflight.
    it('warns in preflight, without failing the row, naming the invalid keys and the fix', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report({ DATABASE_URL: 'Value is required but is currently empty', PORT: 'Unable to coerce string to number' }), 1))

        const { preflight, row } = await health(candidate)

        expect(row(preflight)).toMatchObject({ verdict: 'pass' })
        expect(preflight.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'warning',
            code: 'ENV_SCHEMA_UNHEALTHY',
            message: expect.stringMatching(/api .*missing required DATABASE_URL.*could not validate or resolve PORT/),
            // An agent is pointed at the names it can read itself.
            fix: expect.stringMatching(/have a person run `VARLOCK_TELEMETRY_DISABLED=true varlock load --path <schema directory> --path.*\.\/node_modules\/@b00dea\/cockpit\/bin\/cockpit\.mjs env keys --config <your cockpit\.toml>/),
        }))
    })

    it('warns on a provider it cannot resolve through, naming keys only', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report({ API_KEY: `exec(): command failed (exit code 3): ${SECRET}` }), 1))

        const { doctor, preflight, row } = await health(candidate)

        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({ verdict: 'pass' })
            expect(result.diagnostics).toContainEqual(expect.objectContaining({
                severity: 'warning', code: 'ENV_SCHEMA_UNHEALTHY', message: expect.stringMatching(/api .*could not validate or resolve API_KEY/),
                fix: expect.stringContaining('sign in to it, then rerun'),
            }))
        }
        expect(JSON.stringify([doctor, preflight])).not.toContain(SECRET)
    })

    it('warns about keys the caller\'s shell satisfied, without failing the row or naming a value', async () => {
        const candidate = await fixture({ machineOnly: true })
        const overridden = JSON.stringify({ config: { API_KEY: { value: SECRET } }, overrideKeys: ['API_KEY'] })
        await withVarlock(candidate, `env | grep -q '^_VARLOCK_' && exit 42\n${printing(overridden, 0)}`)

        const { doctor, preflight, row } = await health(candidate, { env: { _VARLOCK_FILTER: 'REGION', API_KEY: SECRET } })

        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({ verdict: 'pass' })
            expect(result.diagnostics).toContainEqual(expect.objectContaining({
                severity: 'warning', code: 'ENV_SCHEMA_OVERRIDDEN', target: 'api', message: expect.stringContaining('API_KEY came from the shell'),
                fix: expect.stringContaining('unset those variables'),
            }))
        }
        expect(JSON.stringify([doctor, preflight])).not.toContain(SECRET)
    })

    it('reports a required env schema gap from doctor on a cockpit that declares no runtime', async () => {
        const candidate = await fixture({ unseeded: true })
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8')).split('[environment]')[0]!)
        await mkdir(join(candidate.checkout, 'siblings', 'api'), { recursive: true })
        await withVarlock(candidate, printing(report({ API_KEY: 'Value is required but is currently empty' }), 1))
        await expect(syncGeneratedEnvironment({ configPath: candidate.configPath })).resolves.toMatchObject({ kind: 'complete', status: 0 })

        const { doctor, preflight, row } = await health(candidate)

        expect(preflight.diagnostics).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' })])
        expect(row(doctor)).toMatchObject({ verdict: 'pass' })
        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'ENV_SCHEMA_UNHEALTHY', message: expect.stringContaining('missing required API_KEY'),
            fix: expect.stringContaining('cockpit doctor on a cockpit that declares no runtime') }))
    })

    it('names a varlock timeout instead of hanging', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, 'sleep 30')

        const { preflight, row } = await health(candidate, { timeoutMs: 400 })

        expect(row(preflight)).toMatchObject({ verdict: 'pass' })
        expect(preflight.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'warning', code: 'ENV_SCHEMA_UNHEALTHY',
            message: expect.stringMatching(/api .*varlock timed out after 400 ms/),
        }))
    })
})
