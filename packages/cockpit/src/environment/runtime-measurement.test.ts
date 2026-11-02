import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runRuntimeMeasure, type RuntimeMeasureProbe } from './runtime-measurement.js'
import { readLocalRuntimeMeasurements } from './runtime-measurement-record.js'
import { selectMachineStateRoot } from './state.js'
import type { RuntimeProbeVerdict } from './runtime-probe.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const IMAGE_ID = `sha256:${'c'.repeat(64)}`
const CONFIG = [
    '[cockpit]', 'name = "synthetic-measure"', 'siblings_root = "siblings"', '',
    '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "always"', 'acquire = "none"',
    'var = "API_DIR"', 'toolchain = "none"', 'purpose = "Synthetic API"', '',
    '[[sibling.derives.mcp_sources]]', 'path = "browser.mcp.json"', 'format = "mcp-json"',
    'provenance = { source = "cockpit.toml", kind = "declared", reason = "Declared in this configuration" }', '',
    '[ports]', 'step = 10', 'count = 1', 'bases = { APP_PORT = 61330 }', '',
    '[environment]', 'compose_files = ["compose.yml"]', '',
].join('\n')

// A docker stand-in answering only the reads the measure command makes before it hands over to the probe.
async function measuredHost(endpoint = 'unix:///synthetic/docker.sock') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-runtime-measure-test-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, CONFIG)
    await writeFile(join(root, 'endpoint'), `${endpoint}\n`)
    const docker = join(root, 'docker')
    await writeFile(docker, [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "context show") printf "synthetic\\n" ;;',
        `  "context inspect") /bin/cat ${JSON.stringify(join(root, 'endpoint'))} ;;`,
        '  "version --format") printf "29.4.0\\n" ;;',
        '  "compose version") printf "5.1.2\\n" ;;',
        `  "info --format") printf '%s\\n' '["OrbStack","orbstack","linux"]' ;;`,
        `  "image inspect") printf '%s\\n' '${IMAGE_ID}' ;;`,
        // Leftover listings and removals: the test seeds `listing-<kind>` and reads `removals`.
        `  "ps -a") /bin/cat ${JSON.stringify(join(root, 'listing-container'))} 2>/dev/null; exit 0 ;;`,
        `  "network ls") /bin/cat ${JSON.stringify(join(root, 'listing-network'))} 2>/dev/null; exit 0 ;;`,
        `  "volume ls") /bin/cat ${JSON.stringify(join(root, 'listing-volume'))} 2>/dev/null; exit 0 ;;`,
        `  "container rm"|"network rm"|"volume rm") [ -e ${JSON.stringify(join(root, 'rm-fails'))} ] && { echo "refused" >&2; exit 1; }; echo "$1 $2 $(for a; do :; done; echo "$a")" >> ${JSON.stringify(join(root, 'removals'))}; exit 0 ;;`,
        '  *) exit 64 ;;',
        'esac',
        '',
    ].join('\n'), { mode: 0o700 })
    await chmod(docker, 0o700)
    return { root, configPath, env: { PATH: `${root}:/usr/bin:/bin`, HOME: root } }
}

async function machineStateRoot(host: Awaited<ReturnType<typeof measuredHost>>): Promise<string> {
    const selected = await selectMachineStateRoot({ platform: process.platform as 'darwin' | 'linux', home: host.env.HOME })
    if (selected.kind !== 'complete') throw new Error('state root unavailable')
    return selected.value
}
const machineRecord = async (host: Awaited<ReturnType<typeof measuredHost>>) => join(await machineStateRoot(host), 'machine', 'runtime-measurements.json')

function verdict(passed: boolean, runtimeExecutableSha256: string): RuntimeProbeVerdict {
    return {
        status: passed ? 'supported' : 'unavailable',
        runtime: passed ? { name: 'Docker Engine', version: '29.4.0' } : null,
        composeVersion: passed ? '5.1.2' : null,
        composeFloor: '5.1.2',
        measuredOn: new Date().toISOString().slice(0, 10),
        candidate: passed ? 'passed' : 'failed',
        brokenControl: 'rejected',
        evidence: {
            batchId: 'a'.repeat(32), installedModuleSha256: 'b'.repeat(64), runtimeExecutableSha256,
            candidateSha256: 'd'.repeat(64), brokenControlSha256: 'e'.repeat(64), projectName: 'cockpit-probe-synthetic',
            runtimePath: '/synthetic/docker', runtimeVersion: '29.4.0', composeVersion: '5.1.2',
            operatingSystem: 'darwin', architecture: 'arm64', startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
            candidateChecks: { localRuntime: true, health: passed }, brokenControlRejected: true,
            cleanup: { ownedSurvivors: [], resourcesEqual: true, claimsEqual: true, leasesEqual: true },
        },
        operatorAction: passed ? null : { required: true, code: 'RUNTIME_UNAVAILABLE', reason: 'profile activation, health, mounts, or canonical ownership labels were not closed' },
    }
}

describe('runtime measurement recording', () => {
    it('records this machine\'s measurement outside cockpit.toml and replaces only the same runtime on a re-measure', async () => {
        const host = await measuredHost()
        const executionEnvironments: Readonly<Record<string, string>>[] = []
        const prefixes: string[] = []
        const probe: RuntimeMeasureProbe = async (request) => {
            // The context read once at the start is the one the probe measures, whatever `docker context use` does meanwhile.
            expect(request.env).toEqual({ PATH: host.env.PATH, DOCKER_CONTEXT: 'synthetic' })
            expect(request.image).toEqual({ reference: IMAGE_ID, id: IMAGE_ID })
            prefixes.push(request.projectPrefix)
            return verdict(true, request.executable.sha256)
        }
        const today = new Date().toISOString().slice(0, 10)
        const other = { runtime: 'colima', daemon: 'colima', engineVersion: '27.0.1', composeFloor: '2.20.0', measuredOn: '2026-09-26' }
        const record = await machineRecord(host)
        await mkdir(dirname(record), { recursive: true })
        await writeFile(record, JSON.stringify({
            format: 'cockpit-runtime-measurements/v1',
            measurements: [other, { runtime: 'orbstack', daemon: 'orbstack', engineVersion: '28.0.0', composeFloor: '2.0.0', measuredOn: '2026-09-01' }],
        }))

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: async step => {
                executionEnvironments.push(step.env)
                return executeProbe(step)
            }, probe })

        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        expect(outcome.artifact).toContain('it replaces the measurement from 2026-09-01 (engine 28.0.0)')
        expect(executionEnvironments.slice(0, 2)).toEqual([{ PATH: host.env.PATH }, { PATH: host.env.PATH }])
        expect(executionEnvironments.length).toBeGreaterThan(2)
        for (const env of executionEnvironments.slice(2)) expect(env).toEqual({ PATH: host.env.PATH, DOCKER_CONTEXT: 'synthetic' })
        expect(prefixes).toEqual(['synthetic-measure'])
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
        expect(await readLocalRuntimeMeasurements(await machineStateRoot(host))).toEqual({
            kind: 'read', path: record,
            rows: [other, { runtime: 'orbstack', daemon: 'orbstack', engineVersion: '29.4.0', composeFloor: '5.1.2', measuredOn: today }],
        })
        // A measurement is a machine fact: nothing is written beside this checkout's cockpit.toml,
        // so another worktree of the same cockpit reads the same record instead of measuring again.
        await expect(stat(join(host.root, '.cockpit'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('replaces an unreadable record with the new measurement and says what it discarded', async () => {
        const host = await measuredHost()
        const record = await machineRecord(host)
        await mkdir(dirname(record), { recursive: true })
        await writeFile(record, '{"format":"other"}')
        expect(await readLocalRuntimeMeasurements(await machineStateRoot(host))).toMatchObject({ kind: 'unreadable', reason: expect.stringMatching(/^the file is not a cockpit-runtime-measurements\/v1 record/) })

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: executeProbe, probe: async (request) => verdict(true, request.executable.sha256) })

        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        expect(outcome.artifact).toContain('the previous record was unreadable and was replaced: the file is not a cockpit-runtime-measurements/v1 record')
        expect(await readLocalRuntimeMeasurements(await machineStateRoot(host))).toMatchObject({ kind: 'read', rows: [{ runtime: 'orbstack', engineVersion: '29.4.0' }] })
    })

    it('passes the exact local Unix selection to the runtime probe without changing endpoint identity', async () => {
        const endpoint = 'unix:///synthetic home/docker%23?#.sock'
        const host = await measuredHost(endpoint)
        const selections: (string | undefined)[] = []
        for (const env of [host.env, { ...host.env, DOCKER_HOST: endpoint }] as Readonly<Record<string, string>>[]) {
            const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env }, {
                execute: executeProbe,
                probe: async (request) => {
                    selections.push(request.env.DOCKER_HOST)
                    return verdict(true, request.executable.sha256)
                },
            })
            expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        }
        expect(selections).toEqual([undefined, endpoint])
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    // The guard asks before an `env -u DOCKER_CONTEXT` wrapper, and an ask is a denial for some
    // agents, so measure takes the context DOCKER_CONTEXT names exactly as `up` will.
    it('measures the local context DOCKER_CONTEXT names and pins it for every later step', async () => {
        const host = await measuredHost()
        const steps: string[] = []
        const environments: Readonly<Record<string, string>>[] = []
        const env = { ...host.env, DOCKER_CONTEXT: 'synthetic-named' }
        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env }, {
            execute: async (step) => { steps.push(step.argv.slice(1).join(' ')); environments.push(step.env); return executeProbe(step) },
            probe: async (request) => {
                expect(request.env).toEqual({ PATH: host.env.PATH, DOCKER_CONTEXT: 'synthetic-named' })
                return verdict(true, request.executable.sha256)
            },
        })

        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        expect(outcome.result).toMatchObject({ endpoint: { value: 'unix:///synthetic/docker.sock', source: 'docker context synthetic-named' } })
        expect(steps[0]).toBe('context inspect synthetic-named --format {{.Endpoints.docker.Host}}')
        expect(steps).not.toContain('context show')
        for (const stepEnv of environments.slice(1)) expect(stepEnv).toEqual({ PATH: host.env.PATH, DOCKER_CONTEXT: 'synthetic-named' })
    })

    it('refuses a DOCKER_CONTEXT that names a remote daemon before probing', async () => {
        const host = await measuredHost('tcp://synthetic.invalid:2376')
        let calls = 0
        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine',
            env: { ...host.env, DOCKER_CONTEXT: 'synthetic-named' } }, {
            execute: executeProbe, probe: async (request) => { calls += 1; return verdict(true, request.executable.sha256) },
        })

        expect(outcome).toMatchObject({ status: 2, diagnostics: [{
            code: 'RUNTIME_UNAVAILABLE', target: 'docker context synthetic-named',
            message: expect.stringMatching(/DOCKER_CONTEXT.*tcp:\/\/synthetic\.invalid:2376/),
        }] })
        expect(calls).toBe(0)
        expect(await readLocalRuntimeMeasurements(await machineStateRoot(host))).toMatchObject({ kind: 'read', rows: [] })
    })

    it('refuses a Windows pipe on a POSIX host before runtime probing or daemon commands', async () => {
        const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine'
        const host = await measuredHost(endpoint)
        for (const env of [host.env, { ...host.env, DOCKER_HOST: endpoint }] as Readonly<Record<string, string>>[]) {
            const steps: string[][] = []
            let calls = 0
            const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env }, {
                execute: async (step) => { steps.push([...step.argv]); return executeProbe(step) },
                probe: async (request) => { calls += 1; return verdict(true, request.executable.sha256) },
            })
            expect(outcome).toMatchObject({ status: 2, diagnostics: [env.DOCKER_HOST === undefined
                ? { code: 'RUNTIME_UNAVAILABLE', target: 'docker context synthetic', message: expect.stringContaining(endpoint) }
                : { code: 'CLI_USAGE_INVALID', target: 'DOCKER_HOST' }] })
            expect(calls).toBe(0)
            expect(steps.every((argv) => argv[1] === 'context')).toBe(true)
            if (env.DOCKER_HOST !== undefined) expect(steps).toEqual([])
        }
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    it('refuses context endpoint whitespace instead of trimming it into a different identity', async () => {
        const host = await measuredHost('unix:///synthetic/docker.sock ')
        let calls = 0
        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env }, {
            execute: executeProbe, probe: async (request) => { calls += 1; return verdict(true, request.executable.sha256) },
        })
        expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'RUNTIME_UNAVAILABLE' }] })
        expect(calls).toBe(0)
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    it('refuses malformed local endpoints without invoking the runtime probe or writing configuration', async () => {
        const host = await measuredHost()
        let calls = 0
        for (const endpoint of [
            'unix://synthetic.invalid/docker.sock', 'unix:///tmp/docker.sock\0',
        ]) {
            const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine',
                env: { ...host.env, DOCKER_HOST: endpoint } }, {
                execute: executeProbe, probe: async (request) => { calls += 1; return verdict(true, request.executable.sha256) },
            })
            expect(outcome, JSON.stringify(endpoint)).toMatchObject({ status: 2, diagnostics: [{ code: 'CLI_USAGE_INVALID', target: 'DOCKER_HOST' }] })
        }
        expect(calls).toBe(0)
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    it('tells a person to pull a missing image rather than to start a runtime that is running', async () => {
        const host = await measuredHost()
        const docker = join(host.root, 'docker')
        await writeFile(docker, (await readFile(docker, 'utf8')).replace(`printf '%s\\n' '${IMAGE_ID}'`,
            `printf 'Error: No such image: nosuch:latest\\n' >&2; exit 1`))
        let probed = false

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'nosuch:latest', env: host.env },
            { execute: executeProbe, probe: async (request) => { probed = true; return verdict(true, request.executable.sha256) } })

        expect(probed).toBe(false)
        expect(outcome).toMatchObject({ status: 2, artifact: null, diagnostics: [{
            code: 'RUNTIME_IMAGE_UNAVAILABLE', target: '--image',
            message: expect.stringContaining('"nosuch:latest" is not a local image'),
            fix: expect.stringContaining('docker pull <image>'),
        }] })

        // A Compose that answers with a version floors cannot compare is an installation to change, not a runtime to start.
        await writeFile(docker, (await readFile(docker, 'utf8')).replace('printf "5.1.2\\n"', 'printf "dev\\n"'))
        const unparseable = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: executeProbe, probe: async (request) => { probed = true; return verdict(true, request.executable.sha256) } })
        expect(probed).toBe(false)
        expect(unparseable).toMatchObject({ status: 2, diagnostics: [{
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Docker Compose reported version "dev" from `docker compose version --short`, which has no numeric X.Y.Z core',
            fix: expect.stringMatching(/^install a Docker Engine and Docker Compose release whose .*docker compose version --short` print X\.Y\.Z/),
        }] })
    })

    it('records nothing when the candidate fails', async () => {
        const host = await measuredHost()

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: executeProbe, probe: async (request) => verdict(false, request.executable.sha256) })

        expect(outcome).toMatchObject({ status: 2, artifact: null, diagnostics: [{
            code: 'RUNTIME_UNAVAILABLE',
            message: expect.stringMatching(/^runtime orbstack was not measured as supported \(candidate failed, broken control rejected\): profile activation.*nothing was recorded$/),
        }] })
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
        expect(await readLocalRuntimeMeasurements(await machineStateRoot(host))).toMatchObject({ kind: 'read', rows: [] })
    })

    it('removes only this cockpit\'s dead probe leftovers before probing, names them, and keeps a live measure\'s', async () => {
        const host = await measuredHost()
        const scratch = join(host.root, 'tmp')
        await mkdir(scratch)
        vi.stubEnv('TMPDIR', scratch)
        const dead = 'a'.repeat(32)
        const live = 'b'.repeat(32)
        const foreign = 'c'.repeat(32)
        const project = (batch: string, prefix = 'synthetic-measure') => `${prefix}-probe-${batch}-0123456789ab`
        await writeFile(join(host.root, 'listing-container'), [
            `${'1'.repeat(64)}\t${project(dead)}\t${dead}`, `${'2'.repeat(64)}\t${project(live)}\t${live}`,
            `${'3'.repeat(64)}\t${project(foreign, 'other-cockpit')}\t${foreign}`, `${'4'.repeat(64)}\t\t`,
            // Named like a dead probe but carrying a different probe label: not provably cockpit's.
            `${'6'.repeat(64)}\t${project(dead)}\t${foreign}`,
        ].join('\n'))
        await writeFile(join(host.root, 'listing-network'), `${'5'.repeat(64)}\t${project(dead)}\t${dead}\n`)
        await writeFile(join(host.root, 'listing-volume'), `${project(dead)}-data\t${project(dead)}\t${dead}\n`)
        // A measure that exited without cleaning up, whose probe directory still names its batch.
        const deadDirectory = join(scratch, 'cockpit-runtime-measure-AAAAAA')
        await mkdir(join(deadDirectory, 'probe'), { recursive: true })
        await writeFile(join(deadDirectory, 'owner'), '2147483646\n')
        await writeFile(join(deadDirectory, 'probe', `candidate-${dead}.yml`), '')
        // A measure whose owner is still running: its batch must survive.
        const liveDirectory = join(scratch, 'cockpit-runtime-measure-BBBBBB')
        await mkdir(join(liveDirectory, 'probe'), { recursive: true })
        await writeFile(join(liveDirectory, 'owner'), `${process.pid}\n`)
        await writeFile(join(liveDirectory, 'probe', `candidate-${live}.yml`), '')

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: executeProbe, probe: async (request) => verdict(true, request.executable.sha256) })

        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        expect((await readFile(join(host.root, 'removals'), 'utf8')).trim().split('\n')).toEqual([
            `container rm ${'1'.repeat(64)}`, `network rm ${'5'.repeat(64)}`, `volume rm ${project(dead)}-data`,
        ])
        expect(outcome.artifact).toContain('removed what an interrupted measure left behind')
        expect(outcome.artifact).toContain(`container ${'1'.repeat(12)} (project ${project(dead)})`)
        expect(outcome.artifact).toContain(`left in place, since a measure may still be running: container ${'2'.repeat(12)} (project ${project(live)})`)
        await expect(stat(deadDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await stat(liveDirectory)).isDirectory()).toBe(true)
    })

    it('refuses to probe when a leftover from an interrupted measure cannot be removed, and names it', async () => {
        const host = await measuredHost()
        const scratch = join(host.root, 'tmp')
        await mkdir(scratch)
        vi.stubEnv('TMPDIR', scratch)
        await writeFile(join(host.root, 'listing-container'), `${'1'.repeat(64)}\tsynthetic-measure-probe-${'a'.repeat(32)}-0123456789ab\t${'a'.repeat(32)}\n`)
        await writeFile(join(host.root, 'rm-fails'), '')
        let probed = false

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: executeProbe, probe: async (request) => { probed = true; return verdict(true, request.executable.sha256) } })

        expect(probed).toBe(false)
        expect(outcome).toMatchObject({ status: 2, diagnostics: [{ message: expect.stringContaining(`container ${'1'.repeat(12)} (project synthetic-measure-probe-${'a'.repeat(32)}-0123456789ab): `) }] })
        expect(outcome.diagnostics[0]!.message).toContain('could not be removed')
    })
})
