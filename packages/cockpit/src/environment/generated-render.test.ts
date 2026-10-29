import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { browserClientLimit } from '../browser/runtime.js'
import { projectGeneratedComposeArtifactAuthority, projectGeneratedComposeRuntimeIdentity, renderGeneratedEnvironment } from './generated-render.js'

describe('generated browser runner rendering', () => {
    it('keeps committed bytes portable while retaining authenticated local runtime identity', async () => {
        const loaded = await loadCockpitConfig(resolve('fixtures/registries/generated-environment.toml'))
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) throw new Error('fixture unavailable')
        const shared = { declaration: loaded.result.config.environment.generated, sourceSha256: 'a'.repeat(64),
            generation: 'b'.repeat(64), portDefaults: loaded.result.config.ports.bases, siblingDirectories: { app: 'app' } }
        const first = renderGeneratedEnvironment({ ...shared, stackId: `stack:${'c'.repeat(64)}`,
            cockpitId: `cockpit:portable:${'d'.repeat(64)}` })
        const second = renderGeneratedEnvironment({ ...shared, stackId: `stack:${'e'.repeat(64)}`,
            cockpitId: `cockpit:portable:${'f'.repeat(64)}` })
        if (first.kind !== 'complete' || second.kind !== 'complete') throw new Error('render unavailable')
        expect(first.compose).toBe(second.compose)
        expect(first.manifest).toEqual(second.manifest)
        expect(first.compose).toContain('${COCKPIT_OWNER_ID:?cockpit runtime owner identity is unavailable}')
        const firstAuthority = projectGeneratedComposeArtifactAuthority(first)
        const secondAuthority = projectGeneratedComposeArtifactAuthority(second)
        expect(firstAuthority && projectGeneratedComposeRuntimeIdentity(firstAuthority)).toEqual({
            stackId: `stack:${'c'.repeat(64)}`, cockpitId: `cockpit:portable:${'d'.repeat(64)}`,
        })
        expect(secondAuthority && projectGeneratedComposeRuntimeIdentity(secondAuthority)).toEqual({
            stackId: `stack:${'e'.repeat(64)}`, cockpitId: `cockpit:portable:${'f'.repeat(64)}`,
        })
    })
    it('renders declared sibling build inputs beside the cockpit while confining generated outputs', () => {
        const declaration = {
            compose_file: 'compose.generated.yml',
            services: [{ id: 'api', sibling: 'api', build: { context: '.', dockerfile: 'Dockerfile' },
                command: ['node', 'server.mjs'], health: { property: 'The synthetic API responds',
                    interval_seconds: 2, timeout_seconds: 2, retries: 10, start_period_seconds: 1,
                    probe: { location: 'in-stack', service: 'api', cwd: '.', argv: ['node', '--version'], timeout_seconds: 30 } } }],
        }
        const input = { declaration, sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64),
            stackId: `stack:${'c'.repeat(64)}`, cockpitId: `cockpit:build:${'d'.repeat(64)}`, portDefaults: {} }
        for (const [directory, context, expected] of [
            ['../api', '.', '../api'],
            ['../../product repositories/api', 'service', '../../product repositories/api/service'],
            ['.', '.', '.'],
            ['api', 'service', 'api/service'],
            ['..', '.', '..'],
        ] as const) {
            const rendered = renderGeneratedEnvironment({ ...input,
                declaration: { ...declaration, services: [{ ...declaration.services[0], build: { context, dockerfile: 'Dockerfile' } }] },
                siblingDirectories: { api: directory } })
            expect(rendered, directory).toMatchObject({ kind: 'complete' })
            if (rendered.kind !== 'complete') throw new Error('declared sibling build unavailable')
            expect(parse(rendered.compose).services.api.build).toEqual({ context: expected, dockerfile: 'Dockerfile' })
            expect(rendered.manifest.map(file => file.path)).toEqual(['compose.generated.yml', 'docs/cockpit/environment-decisions.md'])
        }
        for (const directory of ['/outside/api', 'api/../../outside', '../api/../outside', 'C:\\outside', 'C:/outside', 'api\\nested', 'api\u0000suffix']) {
            expect(renderGeneratedEnvironment({ ...input, siblingDirectories: { api: directory } })).toMatchObject({
                kind: 'refusal', code: 'GENERATED_INPUT_INVALID',
                reason: 'built service api names sibling api without a valid relative checkout directory; fix: correct its sibling dir under cockpit.siblings_root, then run cockpit sync',
            })
        }
        expect(renderGeneratedEnvironment({ ...input, siblingDirectories: {} })).toMatchObject({
            kind: 'refusal', code: 'GENERATED_INPUT_INVALID',
            reason: 'built service api names sibling api without a valid relative checkout directory; fix: correct its sibling dir under cockpit.siblings_root, then run cockpit sync',
        })
        expect(renderGeneratedEnvironment({ ...input, declaration: { ...declaration, compose_file: '../outside.yml' },
            siblingDirectories: { api: '../api' } })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID' })
    })

    it('renders image-service mount inputs from the sibling while keeping browser inputs cockpit-local', async () => {
        const loaded = await loadCockpitConfig(resolve('fixtures/registries/generated-environment.toml'))
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) throw new Error('fixture unavailable')
        const template = loaded.result.config.environment.generated.services[0]!
        const service = { ...template, mounts: [
            { kind: 'bind' as const, source: '.', target: '/workspace/source', source_type: 'directory' as const },
            { kind: 'environment-file' as const, source: 'config/runtime', target: '/workspace/config', source_type: 'file' as const },
        ] }
        const runner = { ...service, id: 'browser', ports: [], mounts: [
            { kind: 'bind' as const, source: '.cockpit/browser', target: '/browser', source_type: 'directory' as const },
        ] }
        const input = { declaration: { compose_file: 'compose.generated.yml', services: [service] }, browserRunner: { service: runner },
            sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64), stackId: `stack:${'c'.repeat(64)}`,
            cockpitId: `cockpit:mounts:${'d'.repeat(64)}`, portDefaults: loaded.result.config.ports.bases,
            siblingDirectories: { app: '../api' } }
        const rendered = renderGeneratedEnvironment(input)
        expect(rendered).toMatchObject({ kind: 'complete' })
        if (rendered.kind !== 'complete') throw new Error(rendered.reason)
        const compose = parse(rendered.compose)
        expect(compose.services.app.volumes).toEqual([
            { type: 'bind', source: '../api', target: '/workspace/source', read_only: false },
            { type: 'bind', source: '../api/config/runtime', target: '/workspace/config', read_only: true },
        ])
        expect(compose.services.browser.volumes).toEqual([
            { type: 'bind', source: '.cockpit/browser', target: '/browser', read_only: false },
        ])
        expect(compose.services.app.labels['dev.b0.cockpit.mounts']).toBe('bind:.:/workspace/source,environment-file:config/runtime:/workspace/config')
        expect(rendered.replay.mounts).toContain('app:bind:.:/workspace/source')
        expect(rendered.observations.find(({ id }) => id === 'mount:app:/workspace/source')?.target).toBe('.')
        expect(renderGeneratedEnvironment({ ...input, siblingDirectories: {} })).toMatchObject({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID' })
    })

    it('refuses cyclic generated input within the shared capture bounds', () => {
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        expect(renderGeneratedEnvironment({
            declaration: cyclic,
            sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64), stackId: `stack:${'c'.repeat(64)}`,
            cockpitId: `cockpit:capture:${'d'.repeat(64)}`, portDefaults: {}, siblingDirectories: {},
        })).toEqual({
            kind: 'refusal', code: 'GENERATED_INPUT_INVALID',
            reason: 'generated environment identity or port defaults are invalid',
        })
    })

    it('keeps container-shell dollars literal through Compose interpolation', async () => {
        const loaded = await loadCockpitConfig(resolve('fixtures/registries/generated-environment.toml'))
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) return
        const declaration = loaded.result.config.environment.generated
        const service = declaration.services[0]!
        const vendors = declaration.vendors.map(({ tls: _tls, ...vendor }) => vendor)
        const rendered = renderGeneratedEnvironment({
            declaration: { ...declaration, vendors, services: [{ ...service, role: 'one-shot' as const, one_shot_failure: 'park' as const,
                command: ['/usr/bin/env'],
                health: { ...service.health, probe: { ...service.health.probe,
                    argv: ['/bin/sh', '-c', 'printf "%s" "$PAYLOAD"'] } } }] },
            sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64), stackId: `stack:${'c'.repeat(64)}`,
            cockpitId: `cockpit:compose:${'d'.repeat(64)}`, portDefaults: loaded.result.config.ports.bases,
            siblingDirectories: { app: 'app' },
        })
        expect(rendered, JSON.stringify(rendered)).toMatchObject({ kind: 'complete' })
        if (rendered.kind !== 'complete') return
        expect(rendered.compose).toContain('$${MESSAGES_TOKEN:-}')
        expect(rendered.compose).toContain('$$PAYLOAD')
        expect(rendered.compose).toContain('status=$$?')
        const compose = parse(rendered.compose)
        expect(compose.services.app.ports).toEqual(['${APP_HOST_PORT:-4100}:3000'])

        const root = await mkdtemp(join(tmpdir(), 'cockpit-compose-interpolation-'))
        try {
            const sentinel = join(root, 'injected')
            const hostile = `x"; touch ${sentinel}; #`
            const execute = (script: string, argv: readonly string[]) => new Promise<Readonly<{ exitCode: number | null; stdout: string; stderr: string }>>((resolveExecution, reject) => {
                const child = spawn('/bin/sh', ['-eu', '-c', script, '--', ...argv], {
                    env: { MESSAGES_TOKEN: hostile, PAYLOAD: hostile }, stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 5_000, killSignal: 'SIGKILL',
                })
                const stdout: Buffer[] = []
                const stderr: Buffer[] = []
                child.stdout!.on('data', chunk => stdout.push(chunk))
                child.stderr!.on('data', chunk => stderr.push(chunk))
                child.once('error', reject)
                child.once('exit', exitCode => resolveExecution({ exitCode,
                    stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
            })
            const decodeComposeDollar = (value: string) => value.replaceAll('$$', () => '$')
            const wrapperResult = await execute(decodeComposeDollar(compose.services.app.entrypoint[3]), compose.services.app.command)
            expect(wrapperResult).toMatchObject({ exitCode: 0, stderr: '' })
            expect(wrapperResult.stdout.split('\n')).toContain(`MESSAGES_TOKEN=${hostile}`)
            const healthResult = await execute(decodeComposeDollar(compose.services.app.healthcheck.test[1]), [])
            expect(healthResult).toEqual({ exitCode: 0, stdout: hostile, stderr: '' })
            await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('adds one loopback-published runner to the authenticated generated Compose artifact', async () => {
        const loaded = await loadCockpitConfig(resolve('fixtures/registries/generated-environment.toml'))
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) return
        const declaration = loaded.result.config.environment.generated
        const template = declaration.services[0]!
        const runner = {
            ...template,
            id: 'cockpit-browser-runner',
            profiles: [],
            command: ['/cockpit/browser-runner.sh', 'serve'],
            image: { ...template.image!,
                manifest_probe: { ...template.image!.manifest_probe, service: 'cockpit-browser-runner' },
                registry_auth_probe: template.image!.registry_auth_probe
                    ? { ...template.image!.registry_auth_probe, service: 'cockpit-browser-runner' } : undefined },
            ports: [{ name: 'browser-proxy', host_variable: 'BROWSER_PORT', host_ip: '127.0.0.1' as const, internal: 3001 }],
            host_aliases: [{ hostname: 'app.example.invalid', address: '127.0.0.1' }],
            mounts: [{ kind: 'environment-file' as const, source: '.cockpit/browser/runner.sh', target: '/cockpit/browser-runner.sh', source_type: 'file' as const }],
            dependencies: [],
            health: { ...template.health,
                probe: { ...template.health.probe, service: 'cockpit-browser-runner' },
                tool_probe: { ...template.health.tool_probe, service: 'cockpit-browser-runner' } },
        }
        const invalid = renderGeneratedEnvironment({
            declaration, browserRunner: { service: { ...runner, health: { ...runner.health, start_period_seconds: 10,
                measurement: { ...runner.health.measurement, duration_seconds: 15 } } } },
            sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64), stackId: `stack:${'c'.repeat(64)}`,
            cockpitId: `cockpit:browser:${'d'.repeat(64)}`, portDefaults: { ...loaded.result.config.ports.bases, BROWSER_PORT: 3001 },
            siblingDirectories: { app: 'app' },
        })
        expect(invalid).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID' })
        const rendered = renderGeneratedEnvironment({
            declaration, browserRunner: { service: runner }, sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64),
            stackId: `stack:${'c'.repeat(64)}`, cockpitId: `cockpit:browser:${'d'.repeat(64)}`,
            portDefaults: { ...loaded.result.config.ports.bases, BROWSER_PORT: 3001 }, siblingDirectories: { app: 'app' },
        })
        expect(rendered, JSON.stringify(rendered)).toMatchObject({ kind: 'complete', replay: {
            mounts: expect.arrayContaining(['cockpit-browser-runner:environment-file:.cockpit/browser/runner.sh:/cockpit/browser-runner.sh']),
        } })
        if (rendered.kind !== 'complete') return
        expect(parse(rendered.compose).services['cockpit-browser-runner']).toMatchObject({
            command: ['/cockpit/browser-runner.sh', 'serve'],
            ports: [{ target: 3001, published: '${BROWSER_PORT:-3001}', host_ip: '127.0.0.1', protocol: 'tcp' }],
            extra_hosts: { 'app.example.invalid': '127.0.0.1' },
        })
    })

    it('runs the fixed remote and foreground launchers with bounded Host proxies and reaps their private installs', async ({ signal, onTestFinished }) => {
        const serializedClientLimit = String(browserClientLimit(4, 'serialized'))
        const root = await mkdtemp(join(tmpdir(), 'cockpit-runner-boundary-'))
        const ownedChildren = new Set<ReturnType<typeof spawn>>()
        onTestFinished(async () => {
            try {
                await Promise.all([...ownedChildren].map(runner => {
                    if (runner.exitCode !== null || runner.signalCode !== null) return Promise.resolve()
                    return new Promise<void>((resolveExit, reject) => {
                        const cleanup = () => {
                            runner.off('exit', onExit)
                            runner.off('error', onError)
                        }
                        const onExit = () => { cleanup(); resolveExit() }
                        const onError = (error: Error) => { cleanup(); reject(error) }
                        runner.once('exit', onExit)
                        runner.once('error', onError)
                        if (runner.exitCode !== null || runner.signalCode !== null) onExit()
                        else if (!runner.kill('SIGTERM')) onError(new Error('owned browser runner could not be stopped'))
                    })
                }))
            } finally {
                await rm(root, { recursive: true, force: true })
            }
        })
        const bin = join(root, 'bin')
        await mkdir(bin)
        const manifest = '{"dependencies":{"@playwright/test":"1.2.3"}}\n'
        const lockfile = '{"lockfileVersion":3}\n'
        await writeFile(join(root, 'package.json'), manifest)
        await writeFile(join(root, 'package-lock.json'), lockfile)
        await writeFile(join(bin, 'npm'), `#!/bin/sh
set -eu
mkdir -p node_modules/@playwright/test node_modules/playwright
printf '{"version":"1.2.3"}' > node_modules/@playwright/test/package.json
cat > node_modules/playwright/index.js <<'JS'
const fs = require('node:fs'); const net = require('node:net'); const { EventEmitter } = require('node:events')
const browserType = engine => ({ launchServer: async options => {
  if (options.host !== '127.0.0.1' || options.wsPath !== undefined || options.headless === false && options.port !== 0 || options.headless === true && (engine === 'chromium' && options.args[0] !== '--host-resolver-rules=MAP app.example.invalid 127.0.0.1' || engine !== 'chromium' && options.args !== undefined)) throw new Error('unsafe launch')
  const emitter = new EventEmitter(); const sockets = new Set()
  const listener = net.createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.once('data', bytes => {
    const value = bytes.toString('latin1'); const line = value.split('\\r\\n', 1)[0]
    fs.appendFileSync(process.env.COCKPIT_TEST_UPSTREAM, line + '|' + value.slice(value.indexOf('\\r\\n\\r\\n') + 4) + '\\n')
    socket.write(line === 'GET /synthetic-private-' + engine + ' HTTP/1.1'
      ? 'HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n'
      : 'HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n')
  }) })
  if (engine === 'firefox') await new Promise(resolve => setTimeout(resolve, 1100))
  await new Promise(resolve => listener.listen(options.port, '127.0.0.1', resolve)); const port = listener.address().port
  fs.appendFileSync(process.env.COCKPIT_TEST_LAUNCH, JSON.stringify({ engine, ...options }) + '\\n')
  emitter.wsEndpoint = () => 'ws://127.0.0.1:' + port + '/synthetic-private-' + engine
  emitter.close = async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => listener.close(resolve)); emitter.emit('close') }
  return emitter
} })
exports.chromium = browserType('chromium'); exports.firefox = browserType('firefox'); exports.webkit = browserType('webkit')
JS
printf '%s' "$PWD" > "$COCKPIT_TEST_WORKSPACE"
`)
        await chmod(join(bin, 'npm'), 0o755)
        const sha = (value: string) => createHash('sha256').update(value).digest('hex')
        const workspaceRecord = join(root, 'workspace')
        const launchRecord = join(root, 'launches')
        const upstreamRecord = join(root, 'upstream-requests')
        await writeFile(upstreamRecord, '')
        const child = spawn('/bin/sh', [resolve('packages/cockpit/surfaces/scripts/browser-runner.sh'), 'debugger',
            '--manifest', join(root, 'package.json'), '--lockfile', join(root, 'package-lock.json'),
            '--manifest-sha256', sha(manifest), '--lock-sha256', sha(lockfile), '--driver-version', '1.2.3',
            '--server-port', '3000', '--proxy-port', '0', '--max-clients', serializedClientLimit, '--artifacts', join(root, 'artifacts'),
            '--allowed-host', 'localhost:4100', '--engine', 'chromium', '--deadline-seconds', '30', '--ws-path', '/public-debugger'], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COCKPIT_TEST_WORKSPACE: workspaceRecord,
                COCKPIT_TEST_LAUNCH: launchRecord, COCKPIT_TEST_UPSTREAM: upstreamRecord }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        ownedChildren.add(child)
        const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
            let stdout = ''
            child.stdout!.on('data', chunk => { stdout += chunk; const line = stdout.split('\n')[0]; if (line) resolveEndpoint(line) })
            child.once('error', reject); child.once('exit', code => reject(new Error(`debugger exited before readiness: ${code}`)))
        })
        const parsed = new URL(endpoint)
        expect(parsed.hostname).toBe('localhost')
        expect(parsed.pathname).toBe('/public-debugger')
        const rawRequest = (port: number, bytes: string, requestSignal?: AbortSignal) => new Promise<{ socket: ReturnType<typeof createConnection>; bytes: string }>((resolveResponse, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port, signal: requestSignal })
            socket.once('connect', () => socket.write(bytes))
            socket.once('data', bytes => resolveResponse({ socket, bytes: bytes.toString('ascii') })); socket.once('error', reject)
        })
        const request = (port: number, path: string, host: string, headers = '', buffered = '') => rawRequest(port,
            `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n${buffered}`)
        const waitForPublicProxy = async (runner: ReturnType<typeof spawn>, engine: string, port: number) => {
            const exited = () => runner.exitCode !== null || runner.signalCode !== null
            let rejectExit!: (error: Error) => void
            const processExit = new Promise<never>((_resolve, reject) => { rejectExit = reject })
            const onError = (error: Error) => rejectExit(error)
            const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
                rejectExit(new Error(`${engine} runner exited before readiness: ${code ?? exitSignal}`))
            runner.once('error', onError)
            runner.once('exit', onExit)
            try {
                if (exited()) throw new Error(`${engine} runner exited before readiness: ${runner.exitCode ?? runner.signalCode}`)
                while (true) {
                    try {
                        const response = await Promise.race([rawRequest(port,
                            `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`, signal), processExit])
                        response.socket.destroy()
                        if (!response.bytes.includes('200 OK')) throw new Error(`${engine} runner readiness returned ${response.bytes.split('\r\n', 1)[0]}`)
                        return
                    } catch (error) {
                        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
                        if (code !== 'ECONNREFUSED') throw error
                        await Promise.race([delay(10, undefined, { signal }), processExit])
                    }
                }
            } finally {
                runner.off('error', onError)
                runner.off('exit', onExit)
            }
        }
        const denied = await request(Number(parsed.port), parsed.pathname, 'foreign.invalid')
        expect(denied.bytes).toContain('403 Forbidden')
        denied.socket.destroy()
        const duplicate = await request(Number(parsed.port), parsed.pathname, `localhost:${parsed.port}\r\nHost: localhost:${parsed.port}`)
        expect(duplicate.bytes).toContain('403 Forbidden')
        duplicate.socket.destroy()
        const beforeProtocolDenials = await readFile(upstreamRecord, 'utf8')
        const health = await rawRequest(Number(parsed.port), `GET / HTTP/1.1\r\nHost: localhost:${parsed.port}\r\nConnection: close\r\n\r\n`)
        expect(health.bytes).toContain('200 OK')
        health.socket.destroy()
        const ordinary = await rawRequest(Number(parsed.port), `GET ${parsed.pathname} HTTP/1.1\r\nHost: localhost:${parsed.port}\r\nConnection: close\r\n\r\n`)
        expect(ordinary.bytes).toContain('403 Forbidden')
        ordinary.socket.destroy()
        const browserHealth = await rawRequest(Number(parsed.port), `GET / HTTP/1.1\r\nHost: localhost:${parsed.port}\r\nConnection: close\r\nSec-Fetch-Site: cross-site\r\n\r\n`)
        expect(browserHealth.bytes).toContain('403 Forbidden')
        browserHealth.socket.destroy()
        const wrongPath = await request(Number(parsed.port), '/not-the-issued-path', `localhost:${parsed.port}`)
        expect(wrongPath.bytes).toContain('403 Forbidden')
        wrongPath.socket.destroy()
        const browserSocket = await request(Number(parsed.port), parsed.pathname, `localhost:${parsed.port}`, 'Origin: http://app.example.invalid\r\n')
        expect(browserSocket.bytes).toContain('403 Forbidden')
        browserSocket.socket.destroy()
        expect(await readFile(upstreamRecord, 'utf8')).toBe(beforeProtocolDenials)
        const incomplete = createConnection({ host: '127.0.0.1', port: Number(parsed.port) })
        await new Promise<void>((resolveConnect, reject) => { incomplete.once('connect', resolveConnect); incomplete.once('error', reject) })
        const blocked = await request(Number(parsed.port), parsed.pathname, `localhost:${parsed.port}`)
        expect(blocked.bytes).toContain('503 Service Unavailable')
        blocked.socket.destroy()
        const incompleteExpired = await new Promise<boolean>(resolveExpired => {
            let settled = false
            const finish = (expired: boolean) => {
                if (settled) return
                settled = true
                clearTimeout(watchdog)
                resolveExpired(expired)
            }
            const watchdog = setTimeout(() => { finish(false); incomplete.destroy() }, 3_000)
            incomplete.once('close', () => finish(true))
            incomplete.once('error', () => undefined)
        })
        const recovered = await request(Number(parsed.port), parsed.pathname, `localhost:${parsed.port}`, '', 'buffered-frame')
        expect(recovered.bytes).toContain('101 Switching Protocols')
        await new Promise<void>((resolveClose, reject) => {
            recovered.socket.once('close', resolveClose)
            recovered.socket.once('error', reject)
            recovered.socket.end()
        })
        const admitted = await request(Number(parsed.port), parsed.pathname, `localhost:${parsed.port}`)
        expect(admitted.bytes).toContain('101 Switching Protocols')
        const capped = await request(Number(parsed.port), parsed.pathname, `localhost:${parsed.port}`)
        expect(capped.bytes).toContain('503 Service Unavailable')
        capped.socket.destroy(); admitted.socket.destroy()
        expect(await readFile(upstreamRecord, 'utf8')).toContain('GET /synthetic-private-chromium HTTP/1.1|buffered-frame')
        child.kill('SIGTERM')
        await new Promise<void>((resolveExit, reject) => { child.once('exit', () => resolveExit()); child.once('error', reject) })
        expect(incompleteExpired).toBe(true)
        const privateWorkspace = await readFile(workspaceRecord, 'utf8')
        await expect(stat(privateWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })

        const reservePort = async () => {
            const listener = (await import('node:net')).createServer()
            await new Promise<void>((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveListen) })
            const address = listener.address()
            if (!address || typeof address === 'string') throw new Error('port fixture unavailable')
            await new Promise<void>((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()))
            return address.port
        }
        const serverPort = await reservePort()
        const proxyPort = await reservePort()
        const remote = spawn('/bin/sh', [resolve('packages/cockpit/surfaces/scripts/browser-runner.sh'), 'serve',
            '--manifest', join(root, 'package.json'), '--lockfile', join(root, 'package-lock.json'),
            '--manifest-sha256', sha(manifest), '--lock-sha256', sha(lockfile), '--driver-version', '1.2.3',
            '--server-port', String(serverPort), '--proxy-port', String(proxyPort), '--max-clients', serializedClientLimit, '--artifacts', join(root, 'remote-artifacts'),
            '--allowed-host', `localhost:${proxyPort}`, '--engine', 'chromium', '--ws-path', '/fixed-token',
            '--resolver-rule', 'MAP app.example.invalid 127.0.0.1'], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COCKPIT_TEST_WORKSPACE: workspaceRecord,
                COCKPIT_TEST_LAUNCH: launchRecord, COCKPIT_TEST_UPSTREAM: upstreamRecord }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        ownedChildren.add(remote)
        const remoteExit = new Promise<void>((resolveExit, reject) => { remote.once('exit', () => resolveExit()); remote.once('error', reject) })
        try {
            await waitForPublicProxy(remote, 'chromium', proxyPort)
            const remoteResponse = await request(proxyPort, '/fixed-token', `localhost:${proxyPort}`)
            expect(remoteResponse.bytes).toContain('101 Switching Protocols')
            remoteResponse.socket.destroy()
            const launches = (await readFile(launchRecord, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
            expect(launches).toEqual(expect.arrayContaining([
                expect.objectContaining({ headless: false, host: '127.0.0.1', port: 0 }),
                expect.objectContaining({ headless: true, host: '127.0.0.1', port: serverPort,
                    args: ['--host-resolver-rules=MAP app.example.invalid 127.0.0.1'] }),
            ]))
            expect(launches).toEqual(expect.not.arrayContaining([expect.objectContaining({ wsPath: expect.anything() })]))
        } finally {
            if (remote.exitCode === null) remote.kill('SIGTERM')
            await remoteExit
        }
        const remoteWorkspace = await readFile(workspaceRecord, 'utf8')
        await expect(stat(remoteWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })

        const firefoxServerPort = await reservePort()
        const firefoxProxyPort = await reservePort()
        const firefox = spawn('/bin/sh', [resolve('packages/cockpit/surfaces/scripts/browser-runner.sh'), 'serve',
            '--manifest', join(root, 'package.json'), '--lockfile', join(root, 'package-lock.json'),
            '--manifest-sha256', sha(manifest), '--lock-sha256', sha(lockfile), '--driver-version', '1.2.3',
            '--server-port', String(firefoxServerPort), '--proxy-port', String(firefoxProxyPort), '--max-clients', serializedClientLimit, '--artifacts', join(root, 'firefox-artifacts'),
            '--allowed-host', `localhost:${firefoxProxyPort}`, '--engine', 'firefox', '--ws-path', '/fixed-token',
            '--resolver-rule', 'MAP app.example.invalid 127.0.0.1'], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COCKPIT_TEST_WORKSPACE: workspaceRecord,
                COCKPIT_TEST_LAUNCH: launchRecord, COCKPIT_TEST_UPSTREAM: upstreamRecord }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        ownedChildren.add(firefox)
        const firefoxExit = new Promise<number | null>((resolveExit, reject) => { firefox.once('exit', resolveExit); firefox.once('error', reject) })
        let firefoxExitCode: number | null
        try {
            await waitForPublicProxy(firefox, 'firefox', firefoxProxyPort)
            const firefoxResponse = await request(firefoxProxyPort, '/fixed-token', `localhost:${firefoxProxyPort}`)
            expect(firefoxResponse.bytes).toContain('101 Switching Protocols')
            firefoxResponse.socket.destroy()
        } finally {
            if (firefox.exitCode === null) firefox.kill('SIGTERM')
            firefoxExitCode = await firefoxExit
        }
        expect(firefoxExitCode).toBe(143)
        const allLaunches = (await readFile(launchRecord, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
        expect(allLaunches.at(-1)).toMatchObject({ engine: 'firefox', headless: true, host: '127.0.0.1', port: firefoxServerPort })
        expect(allLaunches.at(-1)).not.toHaveProperty('wsPath')
        expect(allLaunches.at(-1)).not.toHaveProperty('args')
    }, 30_000)
})
