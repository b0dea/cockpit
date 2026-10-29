import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import type { ExecutionStep } from './contract.js'
import { runRuntimeMeasure, type RuntimeMeasureProbe } from './runtime-measurement.js'
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
        '  "context inspect") /bin/cat \"$PWD/endpoint\" ;;',
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
    it('appends exactly one supported row for the identified runtime, which then admits it', async () => {
        const host = await measuredHost()
        const probe: RuntimeMeasureProbe = async (request) => {
            // The selected context stays the probe's to resolve; only an operator's own DOCKER_HOST passes through.
            expect(request.env.DOCKER_HOST).toBeUndefined()
            expect(request.image).toEqual({ reference: IMAGE_ID, id: IMAGE_ID })
            return verdict(true, request.executable.sha256)
        }

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true, env: host.env },
            { execute: executeProbe, probe })

        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        const written = await readFile(host.configPath, 'utf8')
        expect(written.startsWith(CONFIG)).toBe(true)
        const loaded = await loadCockpitConfig(host.configPath)
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete') return
        expect(loaded.result.config.environment.runtime_measurements).toEqual([{
            runtime: 'orbstack', compose_floor: '5.1.2', measured_on: new Date().toISOString().slice(0, 10),
            candidate: 'passed', broken_control: 'rejected', status: 'supported',
        }])
    })

    it('passes the exact local Unix selection to the runtime probe without changing endpoint identity', async () => {
        const endpoint = 'unix:///synthetic home/docker%23?#.sock'
        const host = await measuredHost(endpoint)
        const selections: (string | undefined)[] = []
        for (const env of [host.env, { ...host.env, DOCKER_HOST: endpoint }] as Readonly<Record<string, string>>[]) {
            const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: false, env }, {
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

    it.each(['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'])(
        'passes the exact Windows pipe %s to the runtime observation boundary without dispatch', async (endpoint) => {
            const host = await measuredHost()
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')
            if (!platform?.configurable) throw new Error('process.platform cannot be configured for the OS boundary test')
            const steps: ExecutionStep[] = []
            let probeCalls = 0
            try {
                Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
                const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true,
                    env: { ...host.env, DOCKER_HOST: endpoint } }, {
                    execute: async (step) => { steps.push(step); throw new Error('stop before process dispatch') },
                    probe: async (request) => { probeCalls += 1; return verdict(true, request.executable.sha256) },
                })
                expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'RUNTIME_UNAVAILABLE' }] })
            } finally {
                Object.defineProperty(process, 'platform', platform)
            }
            expect(steps).toHaveLength(1)
            expect(steps[0]).toMatchObject({ id: 'runtime:docker-server-version', cwd: host.root,
                argv: [expect.any(String), 'version', '--format', '{{.Server.Version}}'],
                env: { PATH: host.env.PATH, DOCKER_HOST: endpoint },
            })
            expect(probeCalls).toBe(0)
            expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
        })

    it('refuses a Windows pipe on a POSIX host before runtime probing or daemon commands', async () => {
        const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine'
        const host = await measuredHost(endpoint)
        for (const env of [host.env, { ...host.env, DOCKER_HOST: endpoint }] as Readonly<Record<string, string>>[]) {
            const steps: string[][] = []
            let calls = 0
            const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true, env }, {
                execute: async (step) => { steps.push([...step.argv]); return executeProbe(step) },
                probe: async (request) => { calls += 1; return verdict(true, request.executable.sha256) },
            })
            expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'RUNTIME_UNAVAILABLE' }] })
            expect(calls).toBe(0)
            expect(steps.every((argv) => argv[1] === 'context')).toBe(true)
            if (env.DOCKER_HOST !== undefined) expect(steps).toEqual([])
        }
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    it('refuses context endpoint whitespace instead of trimming it into a different identity', async () => {
        const host = await measuredHost('unix:///synthetic/docker.sock ')
        let calls = 0
        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: false, env: host.env }, {
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
            'npipe:////synthetic.invalid/pipe/docker_engine', 'npipe:////./pipe/docker_engine/../other',
            'npipe:////./pipe/docker_engine ', 'unix://synthetic.invalid/docker.sock', 'unix:///tmp/docker.sock\0',
        ]) {
            const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true,
                env: { ...host.env, DOCKER_HOST: endpoint } }, {
                execute: executeProbe, probe: async (request) => { calls += 1; return verdict(true, request.executable.sha256) },
            })
            expect(outcome, JSON.stringify(endpoint)).toMatchObject({ status: 2, diagnostics: [{ code: 'RUNTIME_UNAVAILABLE' }] })
        }
        expect(calls).toBe(0)
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    it('writes nothing when the candidate fails', async () => {
        const host = await measuredHost()

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true, env: host.env },
            { execute: executeProbe, probe: async (request) => verdict(false, request.executable.sha256) })

        expect(outcome).toMatchObject({ status: 2, artifact: null, diagnostics: [{
            code: 'RUNTIME_UNAVAILABLE',
            message: expect.stringMatching(/^runtime orbstack was not measured as supported \(candidate failed, broken control rejected\): profile activation.*nothing was written$/),
        }] })
        expect(await readFile(host.configPath, 'utf8')).toBe(CONFIG)
    })

    it('refuses --write when cockpit.toml no longer reads as the measured configuration plus one row', async () => {
        const host = await measuredHost()
        const edited = CONFIG.replace('name = "synthetic-measure"', 'name = "edited-meanwhile"')
        // The probe runs for minutes; an operator editing cockpit.toml meanwhile must keep their edit.
        const probe: RuntimeMeasureProbe = async (request) => {
            await writeFile(host.configPath, edited)
            return verdict(true, request.executable.sha256)
        }

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true, env: host.env },
            { execute: executeProbe, probe })

        expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'CONFIG_CHANGED_DURING_EXECUTION', target: host.configPath }] })
        expect(await readFile(host.configPath, 'utf8')).toBe(edited)
    })

    it('refuses --write and prints the inline row when measurements are an inline array the append cannot extend', async () => {
        const host = await measuredHost()
        const inline = `${CONFIG}runtime_measurements = []\n`
        await writeFile(host.configPath, inline)

        const outcome = await runRuntimeMeasure({ configPath: host.configPath, image: 'node:22-alpine', write: true, env: host.env },
            { execute: executeProbe, probe: async (request) => verdict(true, request.executable.sha256) })

        expect(outcome).toMatchObject({ status: 2, diagnostics: [{
            code: 'CONFIG_PARSE_INVALID', message: expect.stringContaining('{ runtime = "orbstack", compose_floor = "5.1.2"'),
        }] })
        expect(await readFile(host.configPath, 'utf8')).toBe(inline)
    })
})
