import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { renderComposeOwnership } from '../environment/compose-ownership.js'
import { runCli } from '../cli.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function app(files: Readonly<Record<string, string>>) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-scaffold-')))
    roots.push(root)
    await mkdir(join(root, 'api'))
    for (const [path, bytes] of Object.entries(files)) await writeFile(join(root, path), bytes)
    return root
}

function capture() {
    let stdout = ''
    let stderr = ''
    return {
        io: { stdout: { write: (chunk: string) => { stdout += chunk; return true } }, stderr: { write: (chunk: string) => { stderr += chunk; return true } } },
        output: () => ({ stdout, stderr }),
    }
}

describe('init --scaffold-compose', () => {
    it('writes one compose.yml the user owns: the app on a leased loopback port, mounted, with its backing services', async () => {
        const root = await app({ 'api/Dockerfile': 'FROM node:22-alpine\n' })
        const output = capture()
        const status = await runCli(['init', root, '--scaffold-compose', 'api', '--port', '3000', '--with', 'redis,postgres', '--json'], output.io as never)
        expect(status, output.output().stdout).toBe(0)
        expect(JSON.parse(output.output().stdout).result).toEqual({ action: 'scaffolded', path: join(root, 'compose.yml'),
            service: 'api', portVariable: 'API_HOST_PORT', volumes: ['postgres-data', 'redis-data'] })
        const compose = parse(await readFile(join(root, 'compose.yml'), 'utf8'))
        expect(compose.services.api).toEqual({
            build: '${API_DIR:-./api}', init: true, working_dir: '/app',
            ports: ['127.0.0.1:${API_HOST_PORT:-3000}:3000'], volumes: ['./api:/app'],
            environment: { DATABASE_URL: 'postgres://postgres:postgres@postgres:5432/postgres', REDIS_URL: 'redis://redis:6379' },
            depends_on: { postgres: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } },
        })
        expect(compose.services.postgres).toMatchObject({ image: 'postgres:17-alpine', volumes: ['postgres-data:/var/lib/postgresql/data'] })
        expect(compose.services.redis).toMatchObject({ image: 'redis:7-alpine', healthcheck: { test: ['CMD', 'redis-cli', 'ping'] } })
        expect(Object.keys(compose.volumes)).toEqual(['postgres-data', 'redis-data'])
        // cockpit can label it and reset its volumes as written, which is what sync and up require of it.
        expect(renderComposeOwnership({ sources: [{ reference: 'compose.yml', source: await readFile(join(root, 'compose.yml'), 'utf8') }],
            stackId: `stack:${'a'.repeat(64)}`, cockpitId: `cockpit:scaffold:${'b'.repeat(64)}`, configSha256: 'c'.repeat(64),
            resettableVolumes: ['postgres-data', 'redis-data'] })).toMatchObject({ kind: 'complete' })
    })

    it('runs a package.json app on the stock Node image only with the command that starts it', async () => {
        const root = await app({ 'package.json': '{"name":"tiny"}\n' })
        const refused = capture()
        expect(await runCli(['init', root, '--scaffold-compose', '.', '--port', '8080', '--json'], refused.io as never)).toBe(2)
        const response = JSON.parse(refused.output().stdout)
        expect(response.diagnostics).toEqual([expect.objectContaining({ code: 'INIT_SCAFFOLD_INVALID',
            message: 'the cockpit root has no Dockerfile, so the scaffold needs the command that starts the app' })])
        expect(response.guidance).toContainEqual(expect.objectContaining({ code: 'INIT_SCAFFOLD_INVALID',
            text: 'pass --command with the start command, such as --command "npm start", or add a Dockerfile to the app directory' }))
        const written = capture()
        expect(await runCli(['init', root, '--scaffold-compose', '.', '--port', '8080', '--command', 'npm start', '--json'], written.io as never)).toBe(0)
        expect(parse(await readFile(join(root, 'compose.yml'), 'utf8')).services.app).toMatchObject({
            image: 'node:22-alpine', command: ['npm', 'start'], ports: ['127.0.0.1:${APP_HOST_PORT:-8080}:8080'], volumes: ['.:/app'] })
    })

    it.each(['compose.yml', 'docker-compose.yaml'])('leaves an existing %s alone and refuses', async (name) => {
        const root = await app({ 'api/Dockerfile': 'FROM node:22-alpine\n', [name]: 'services: {}\n' })
        const output = capture()
        expect(await runCli(['init', root, '--scaffold-compose', 'api', '--port', '3000', '--json'], output.io as never)).toBe(2)
        expect(JSON.parse(output.output().stdout).diagnostics).toEqual([expect.objectContaining({ code: 'INIT_SCAFFOLD_COMPOSE_EXISTS', target: join(root, name) })])
        expect(await readFile(join(root, name), 'utf8')).toBe('services: {}\n')
    })
})
