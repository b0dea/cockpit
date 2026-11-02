import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runRuntimeMeasure, type RuntimeMeasureProbe } from './runtime-measurement.js'
import { readLocalRuntimeMeasurements } from './runtime-measurement-record.js'
import type { RuntimeProbeVerdict } from './runtime-probe.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

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
        '  *) exit 64 ;;',
        'esac',
        '',
    ].join('\n'), { mode: 0o700 })
    await chmod(docker, 0o700)
    return { root, configPath, env: { PATH: `${root}:/usr/bin:/bin`, HOME: root } }
}

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
        await mkdir(join(host.root, '.cockpit', 'local'), { recursive: true })
        await writeFile(join(host.root, '.cockpit', 'local', 'runtime-measurements.json'), JSON.stringify({
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
        expect(await readLocalRuntimeMeasurements(host.root)).toEqual({
            kind: 'read', path: join(host.root, '.cockpit', 'local', 'runtime-measurements.json'),
            rows: [other, { runtime: 'orbstack', daemon: 'orbstack', engineVersion: '29.4.0', composeFloor: '5.1.2', measuredOn: today }],
        })
        expect(await readFile(join(host.root, '.cockpit', 'local', '.gitignore'), 'utf8')).toContain('\n*\n')
    })

    it('replaces an unreadable record with the new measurement and says what it discarded', async () => {
        const host = await measuredHost()
        await mkdir(join(host.root, '.cockpit', 'local'), { recursive: true })
        await writeFile(join(host.root, '.cockpit', 'local', 'runtime-measurements.json'), '{"format":"other"}')
        expect(await readLocalRuntimeMeasurements(host.root)).toMatchObject({ kind: 'unreadable', reason: expect.stringMatching(/^the file is not a cockpit-runtime-measurements\/v1 record/) })

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', env: host.env },
            { execute: executeProbe, probe: async (request) => verdict(true, request.executable.sha256) })

        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        expect(outcome.artifact).toContain('the previous record was unreadable and was replaced: the file is not a cockpit-runtime-measurements/v1 record')
        expect(await readLocalRuntimeMeasurements(host.root)).toMatchObject({ kind: 'read', rows: [{ runtime: 'orbstack', engineVersion: '29.4.0' }] })
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
        expect(await readLocalRuntimeMeasurements(host.root)).toMatchObject({ kind: 'read', rows: [] })
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
        expect(await readLocalRuntimeMeasurements(host.root)).toMatchObject({ kind: 'read', rows: [] })
    })
})
