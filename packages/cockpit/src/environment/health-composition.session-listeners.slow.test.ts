import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runPreflight } from './application/health.js'
import { runSleep, runUp } from './application/lifecycle.js'
import { observeProcessStart, processHost } from './claims.js'
import { composeProjectName } from './identity.js'
import { COMPOSE_OWNERSHIP_FILE } from './compose-ownership.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { syncGeneratedEnvironment } from './generated-application/sync.js'
import { loadCockpitConfig } from '../config/load.js'
import { createHealthCompositionFixture } from '../../test-support/health-composition-fixture.js'

const run = promisify(execFile)
const roots: string[] = []
const fixture = createHealthCompositionFixture(roots)
const children: ChildProcess[] = []

afterEach(async () => {
    vi.unstubAllEnvs()
    for (const child of children.splice(0)) {
        // Each stand-in session leads its own process group; its listeners are in it.
        try { process.kill(-child.pid!, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// A host process listening on a leased port that Compose does not publish, such as a dev server
// the product keeps outside its containers.
const LISTENER = `const server = require('node:net').createServer()
server.listen(Number(process.argv[2]), process.argv[3], () => process.stdout.write('ready\\n'))
`

// A stand-in for a \`cockpit session\` wrapper: for each "<port> <host>" line it starts a listener as
// its own child and prints that child's pid once it listens.
const WRAPPER = `const { spawn } = require('node:child_process')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const [port, host] = line.split(' ')
    const child = spawn(process.execPath, [require('node:path').join(__dirname, 'listener.cjs'), port, host], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.once('data', () => process.stdout.write(child.pid + '\\n'))
})
`

interface StandInSession {
    readonly pid: number
    readonly listen: (port: number, host: '127.0.0.1' | '::1') => Promise<number>
}

function startSession(root: string): StandInSession {
    const child = spawn(process.execPath, [join(root, 'wrapper.cjs')], { stdio: ['pipe', 'pipe', 'inherit'], detached: true })
    children.push(child)
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
    return {
        pid: child.pid!,
        listen: async (port, host) => {
            child.stdin!.write(`${port} ${host}\n`)
            const next = await lines.next()
            if (next.done) throw new Error('stand-in session ended before its listener started')
            return Number(next.value)
        },
    }
}

async function freePort(): Promise<number> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('synthetic listener address is unavailable')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    return address.port
}

async function listen(port: number, host: string): Promise<Server> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(port, host, resolve))
    return server
}

async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

// A killed process stays signalable until its parent reaps it, which on Linux can take longer than
// a few event-loop turns.
async function exited(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        try { process.kill(pid, 0) } catch { return }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`process ${pid} did not exit`)
}

// The case brings up a stack through the real owners against a Node-scripted Docker, then runs
// preflight a dozen times with real host processes and sockets, so it runs in the slow tier.
describe('session-owned host listeners on leased ports', { timeout: 300_000 }, () => {
    it('accepts a listener only while a live session holding this stack started it', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, COMPOSE_OWNERSHIP_FILE))
        const appPort = await freePort()
        const webPort = await freePort()
        const config = (await readFile(candidate.configPath, 'utf8'))
            .replace('bases = { APP_PORT = 61230 }', `bases = { APP_PORT = ${appPort}, WEB_PORT = ${webPort} }`)
        await writeFile(candidate.configPath, config)
        const image = `example.invalid/synthetic@sha256:${'a'.repeat(64)}`
        await writeFile(join(candidate.checkout, 'compose.yml'), `services:
  api:
    image: ${image}
    healthcheck:
      test: [CMD, 'true']
    ports:
      - target: 3000
        published: "\${APP_PORT:-${appPort}}"
`)
        await writeFile(join(candidate.checkout, '.gitignore'), '*\n!.gitignore\n!cockpit.toml\n!compose.yml\n')
        await writeFile(join(candidate.root, 'listener.cjs'), LISTENER)
        await writeFile(join(candidate.root, 'wrapper.cjs'), WRAPPER)
        const loadedConfig = await loadCockpitConfig(candidate.configPath)
        if (loadedConfig.kind !== 'complete') throw new Error(JSON.stringify(loadedConfig.diagnostics))
        const digest = loadedConfig.result.runtimeSha256
        const project = composeProjectName({ cockpitName: 'synthetic-cockpit', stackId: candidate.stack })
        const docker = join(candidate.root, 'docker')
        await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2)
const port = process.env.APP_PORT || '${appPort}'
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

        // The published port stands for the container: this process listens where Compose would.
        let published: Server | undefined
        // A change made right after the named read, once `earlier` reads of it have passed.
        let after: { readonly step: string; earlier: number; readonly change: () => Promise<void> } | undefined
        let listenerReads = 0
        const execute = vi.fn(async (step: Parameters<typeof executeProbe>[0]) => {
            const result = await executeProbe(step)
            if (step.id.startsWith('process:listeners')) listenerReads += 1
            if (after && step.id.startsWith(after.step) && after.earlier-- === 0) {
                const { change } = after
                after = undefined
                await change()
            }
            if (step.argv.includes('up') && !published) published = await listen(Number(step.env.APP_PORT ?? appPort), '127.0.0.1')
            return result
        })
        const lifecycle = (sessionId: string, holderProcess?: { pid: number; processStart: string }) => createLifecycleCommandAdapters({
            configPath: candidate.configPath, env, sessionId, timeoutMs: 5_000,
            ...(holderProcess ? { holderProcess } : {}),
        }, execute)
        const health = createHealthCommandAdapters({ configPath: candidate.configPath, env, timeoutMs: 5_000 }, execute)
        const preflight = () => runPreflight({ configPath: candidate.configPath }, health)
        const portCheck = (outcome: Awaited<ReturnType<typeof preflight>>) =>
            outcome.result.checks.find(({ code }) => code === 'PORT_FAMILY_COLLISION')
        const strangers: Server[] = []
        try {
            const plain = await runUp({ configPath: candidate.configPath }, lifecycle('synthetic-plain'))
            expect(plain, JSON.stringify(plain)).toMatchObject({ kind: 'complete', status: 0 })
            expect(plain.kind === 'complete' && plain.result.ports).toMatchObject({ WEB_PORT: webPort })

            // An unpublished lease nothing listens on is free, as before.
            const free = await preflight()
            expect(free, JSON.stringify(free)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })

            const session = startSession(candidate.root)
            const started = await observeProcessStart(session.pid, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(`stand-in session start is unreadable: ${JSON.stringify(started)}`)
            await session.listen(webPort, '127.0.0.1')

            // The recorded identity names the session's pid with another start: the pid now belongs
            // to a process the hold was not taken by.
            const reused = started.start.startsWith('lstart:') ? 'lstart:2000-01-01T00:00:00.000Z' : started.start.replace(/:[0-9]+$/, ':1')
            const stale = await runUp({ configPath: candidate.configPath }, lifecycle('synthetic-stale', { pid: session.pid, processStart: reused }))
            expect(stale, JSON.stringify(stale)).toMatchObject({ kind: 'complete', status: 0 })
            const staleHold = await preflight()
            expect(staleHold).toMatchObject({ kind: 'blocked', status: 2 })
            expect(portCheck(staleHold), JSON.stringify(staleHold)).toMatchObject({ verdict: 'fail' })
            expect(await runSleep({ configPath: candidate.configPath }, lifecycle('synthetic-stale'))).toMatchObject({ kind: 'complete' })

            const live = await runUp({ configPath: candidate.configPath }, lifecycle('synthetic-live', { pid: session.pid, processStart: started.start }))
            expect(live, JSON.stringify(live)).toMatchObject({ kind: 'complete', status: 0 })
            const owned = await preflight()
            expect(owned, JSON.stringify(owned)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })

            // A second listener on the same port from a process no session started.
            strangers.push(await listen(webPort, '::1'))
            const foreign = await preflight()
            expect(foreign).toMatchObject({ kind: 'blocked', status: 2 })
            expect(portCheck(foreign), JSON.stringify(foreign)).toMatchObject({ verdict: 'fail' })
            await close(strangers.pop()!)

            // A live session that does not hold this stack, as another checkout's session would.
            const other = startSession(candidate.root)
            await other.listen(webPort, '::1')
            const otherSession = await preflight()
            expect(otherSession).toMatchObject({ kind: 'blocked', status: 2 })
            expect(portCheck(otherSession), JSON.stringify(otherSession)).toMatchObject({ verdict: 'fail' })
            process.kill(-other.pid, 'SIGKILL')
            await exited(other.pid)
            expect(await preflight()).toMatchObject({ kind: 'complete', status: 0 })

            // The lease record changes while the listener owners are read; whichever lease check sees
            // it first, preflight cannot vouch for the ports.
            const coordination = candidate.namespace.paths.coordination(candidate.stack).path
            const coordinationBytes = await readFile(coordination)
            after = { step: 'process:listeners', earlier: 0, change: async () => { await writeFile(coordination, '{}\n') } }
            try {
                const leaseChanged = await preflight()
                expect(after).toBeUndefined()
                expect(leaseChanged, JSON.stringify(leaseChanged)).toMatchObject({ kind: 'blocked', status: 2, result: { verdict: 'unavailable' } })
            } finally {
                await writeFile(coordination, coordinationBytes)
            }

            // The session's listener is replaced by a stranger's after its ownership was proven: the
            // second process-table read closes the first ownership observation.
            const reads = listenerReads
            const replaced = await session.listen(webPort, '::1')
            after = { step: 'process:table', earlier: 1, change: async () => {
                process.kill(replaced, 'SIGKILL')
                await exited(replaced)
                strangers.push(await listen(webPort, '::1'))
            } }
            const raced = await preflight()
            expect(after).toBeUndefined()
            expect(listenerReads).toBe(reads + 2)
            expect(raced).toMatchObject({ kind: 'blocked', status: 2 })
            expect(portCheck(raced), JSON.stringify(raced)).not.toMatchObject({ verdict: 'pass' })
            await close(strangers.pop()!)
            expect(await preflight()).toMatchObject({ kind: 'complete', status: 0 })

            // The session ends without releasing its hold; its listener outlives it.
            process.kill(session.pid, 'SIGKILL')
            await exited(session.pid)
            const ended = await preflight()
            expect(ended).toMatchObject({ kind: 'blocked', status: 2 })
            expect(portCheck(ended), JSON.stringify(ended)).toMatchObject({ verdict: 'fail' })
        } finally {
            await Promise.all(strangers.map(close))
            if (published) await close(published)
        }
    })
})
