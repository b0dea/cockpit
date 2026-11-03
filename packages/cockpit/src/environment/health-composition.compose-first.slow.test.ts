import { execFile } from 'node:child_process'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runDoctor, runPreflight, runUp } from './application.js'
import { composeProjectName } from './identity.js'
import { COMPOSE_OWNERSHIP_FILE } from './compose-ownership.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { syncGeneratedEnvironment, checkGeneratedEnvironment } from './generated-application.js'
import { loadCockpitConfig } from '../config/load.js'
import { createHealthCompositionFixture } from '../../test-support/health-composition-fixture.js'

const run = promisify(execFile)
const roots: string[] = []
const fixture = createHealthCompositionFixture(roots)

afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The case publishes, brings up, checks and then runs preflight seven times through the real owners
// against a Node-scripted Docker: well over a minute on a busy host, so it runs in the slow tier.
describe('production health adapter composition', { timeout: 180_000 }, () => {
    it('checks a compose-first stack and rejects config, lifecycle and lease changes during comparison probes', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, COMPOSE_OWNERSHIP_FILE))
        const listener = createServer()
        await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
        const address = listener.address()
        if (!address || typeof address === 'string') throw new Error('synthetic listener address is unavailable')
        const port = address.port
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        const config = (await readFile(candidate.configPath, 'utf8')).replace('61230', String(port))
            .replace('dir = "api"', 'dir = "api"\nremote = "https://example.invalid/synthetic/api.git"')
            .replace('acquire = "none"', 'acquire = "manual"')
        await writeFile(candidate.configPath, config)
        const image = `example.invalid/synthetic@sha256:${'a'.repeat(64)}`
        await writeFile(join(candidate.checkout, 'compose.yml'), `services:
  api:
    image: ${image}
    healthcheck:
      test: [CMD, 'true']
    ports:
      - target: 3000
        published: "\${APP_PORT:-${port}}"
`)
        await writeFile(join(candidate.checkout, '.gitignore'), '*\n!.gitignore\n!cockpit.toml\n!compose.yml\n')
        const api = join(candidate.checkout, 'siblings/api')
        await run('git', ['init', '--quiet', api])
        await run('git', ['-C', api, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
        await run('git', ['-C', api, 'remote', 'add', 'origin', 'https://example.invalid/synthetic/api.git'])
        await run('git', ['-C', api, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
        const branch = (await run('git', ['-C', api, 'branch', '--show-current'])).stdout.trim()
        await run('git', ['-C', api, 'branch', '--set-upstream-to=origin/main', branch])
        const loadedConfig = await loadCockpitConfig(candidate.configPath)
        if (loadedConfig.kind !== 'complete') throw new Error(JSON.stringify(loadedConfig.diagnostics))
        const digest = loadedConfig.result.runtimeSha256
        const project = composeProjectName({ cockpitName: 'synthetic-cockpit', stackId: candidate.stack })
        const docker = join(candidate.root, 'docker')
        await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2)
const port = process.env.APP_PORT || '${port}'
const labels = { 'dev.b0dea.cockpit.stack-id': '${candidate.stack}', 'dev.b0dea.cockpit.config-sha256': '${digest}',
    'com.docker.compose.project': '${project}', 'com.docker.compose.service': 'api' }
const id = '${'a'.repeat(64)}'
const output = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
if (args[0] === 'version') output('27.1.2')
else if (args[0] === 'info') output(args.join(' ').includes('OperatingSystem') ? ['Docker Desktop', 'docker-desktop', 'linux'] : '2147483648|2')
else if (args[0] === 'compose' && args[1] === 'version') output('2.39.2')
else if (args[0] === 'compose' && args.includes('config')) output({ services: { api: { image: '${image}', healthcheck: { test: ['CMD', 'true'] }, labels,
    ports: [{ target: 3000, published: args.includes('--no-interpolate') ? '$' + '{APP_PORT}' : port, host_ip: '127.0.0.1', protocol: 'tcp' }] } } })
else if (args[0] === 'compose' && args.includes('ps')) output(args.includes('--quiet') ? id : { ID: id.slice(0, 12), Project: '${project}', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0 })
else if (args[0] === 'container' && args[1] === 'inspect') output({ ID: id, State: 'running', Health: 'healthy', Labels: labels, Mounts: [],
    Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } })
else if (args[0] === 'compose' && args.includes('up')) process.exit(0)
else process.exit(64)
`)
        await chmod(docker, 0o700)
        const env = { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home }
        vi.stubEnv('PATH', env.PATH)
        const publication = await syncGeneratedEnvironment({ configPath: candidate.configPath })
        expect(publication, JSON.stringify(publication)).toMatchObject({ kind: 'complete', status: 0 })
        await run('git', ['-C', candidate.checkout, 'add', 'cockpit.toml', 'compose.yml', '.gitignore'])
        await run('git', ['-C', candidate.checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'publish synthetic runtime'])
        let listening = false
        let changeDuringComparison: (() => Promise<void>) | undefined
        const execute = vi.fn(async (step: Parameters<typeof executeProbe>[0]) => {
            const result = await executeProbe(step)
            if (step.id === 'git:api:comparison-url' && changeDuringComparison) {
                const change = changeDuringComparison
                changeDuringComparison = undefined
                await change()
            }
            if (step.argv.includes('up') && !listening) {
                await new Promise<void>(resolve => listener.listen(Number(step.env.APP_PORT ?? port), '127.0.0.1', resolve))
                listening = true
            }
            return result
        })
        try {
            const up = await runUp({ configPath: candidate.configPath }, createLifecycleCommandAdapters({
                configPath: candidate.configPath, env, sessionId: 'synthetic-health-runtime', timeoutMs: 5_000,
            }, execute))
            expect(up, JSON.stringify(up)).toMatchObject({ kind: 'complete', status: 0 })
            expect(execute.mock.calls.map(([step]) => step.id)).toEqual(expect.arrayContaining([
                `runtime:docker-compose:topology:${project}`, 'runtime:measure:resources', 'runtime:measure:free-disk',
            ]))
            const checked = await checkGeneratedEnvironment({ configPath: candidate.configPath })
            expect(checked, JSON.stringify(checked)).toMatchObject({ kind: 'complete', status: 0 })
            const statePath = candidate.namespace.paths.lifecycle(candidate.stack).path
            const before = await readFile(statePath, 'utf8')
            execute.mockClear()
            const adapters = createHealthCommandAdapters({ configPath: candidate.configPath, env, timeoutMs: 5_000 }, execute)
            const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
            const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
            expect(preflight, JSON.stringify(preflight)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
            expect(doctor, JSON.stringify(doctor)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
            expect(await readFile(statePath, 'utf8')).toBe(before)
            expect(execute.mock.calls.some(([step]) => step.argv.includes('up') || step.argv.includes('stop'))).toBe(false)
            for (const authority of ['config', 'lifecycle', 'lease'] as const) {
                const authorityPath = authority === 'config' ? candidate.configPath
                    : authority === 'lifecycle' ? statePath : candidate.namespace.paths.coordination(candidate.stack).path
                const authorityBytes = await readFile(authorityPath)
                let changed = false
                changeDuringComparison = async () => {
                    await writeFile(authorityPath, authority === 'config' ? `${config}\n# changed during comparison\n` : '{}\n')
                    changed = true
                }
                try {
                    const raced = await runPreflight({ configPath: candidate.configPath }, adapters)
                    expect(changed, authority).toBe(true)
                    expect(raced, `${authority}: ${JSON.stringify(raced)}`).toMatchObject({ kind: 'blocked', status: 2, result: { verdict: 'unavailable' } })
                } finally {
                    await writeFile(authorityPath, authorityBytes)
                }
            }
            // Every race restored distinct bytes, so a lingering change from any of them fails here.
            const restored = await runPreflight({ configPath: candidate.configPath }, adapters)
            expect(restored, JSON.stringify(restored)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
            await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
            listening = false
            const stopped = await runPreflight({ configPath: candidate.configPath }, adapters)
            expect(stopped).toMatchObject({ kind: 'blocked', status: 2 })
            expect(stopped.result.checks).toContainEqual(expect.objectContaining({ code: 'PORT_FAMILY_COLLISION', verdict: 'fail' }))
        } finally {
            if (listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        }
    })
})
