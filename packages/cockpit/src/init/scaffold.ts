// Writes a starting compose.yml for a small app that has none, once. The file is the user's from then
// on: cockpit never rewrites it, and cockpit.toml runs it as written through environment.compose_files.
// It is deliberately small (one app service, an optional database and cache from a fixed list), so
// anything beyond that is plain Compose the user adds, not more options here.
import { lstat, open } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { deriveSiblingVariable } from '../schema.js'
import { hasErrorCode } from '../environment/contract.js'

export const mechanism = {
    id: 'compose-scaffold',
    module: 'packages/cockpit/src/init/scaffold.ts',
    exports: ['COMPOSE_FILE_NAMES', 'SCAFFOLD_BACKING_SERVICES', 'renderComposeScaffold', 'writeComposeScaffold'],
} as const

/** The names Compose looks for; any one of them already present means the product has a Compose file. */
export const COMPOSE_FILE_NAMES = Object.freeze(['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'])

// Tags pinned to a major version, so a scaffold written today runs the same release line tomorrow.
// The credentials are local-only defaults for a stack bound to loopback; the app reads the URL.
export const SCAFFOLD_BACKING_SERVICES = Object.freeze({
    postgres: Object.freeze({
        image: 'postgres:17-alpine',
        environment: Object.freeze({ POSTGRES_PASSWORD: 'postgres' }),
        volume: '/var/lib/postgresql/data',
        healthcheck: Object.freeze(['CMD', 'pg_isready', '-U', 'postgres']),
        url: Object.freeze(['DATABASE_URL', 'postgres://postgres:postgres@postgres:5432/postgres']),
    }),
    redis: Object.freeze({
        image: 'redis:7-alpine',
        environment: Object.freeze({}),
        volume: '/data',
        healthcheck: Object.freeze(['CMD', 'redis-cli', 'ping']),
        url: Object.freeze(['REDIS_URL', 'redis://redis:6379']),
    }),
})
export type ScaffoldBackingService = keyof typeof SCAFFOLD_BACKING_SERVICES

// One image per toolchain cockpit can recognise without a Dockerfile; anything else brings its own.
const TOOLCHAIN_IMAGE = 'node:22-alpine'

export interface ComposeScaffoldInput {
    /** The app directory, relative to the cockpit root; `.` for the root itself. */
    readonly dir: string
    /** Whether the app directory holds a Dockerfile, which then builds the app image. */
    readonly dockerfile: boolean
    /** Whether it holds a package.json, so a stock Node image can run it without a Dockerfile. */
    readonly packageJson: boolean
    /** The command the app service runs; required without a Dockerfile, which otherwise sets it. */
    readonly command?: readonly string[]
    readonly port: number
    readonly with: readonly ScaffoldBackingService[]
}

export type ComposeScaffold =
    | Readonly<{ kind: 'complete'; service: string; portVariable: string; volumes: readonly string[]; bytes: string }>
    | Readonly<{ kind: 'refusal'; message: string; fix: string }>

const json = (value: unknown) => JSON.stringify(value)

/** The compose.yml text for the declared app, with the [ports.bases] variable and volumes it introduces. */
export function renderComposeScaffold(input: ComposeScaffoldInput): ComposeScaffold {
    const dir = input.dir === '.' ? '.' : normalize(input.dir)
    if (isAbsolute(dir) || dir.split('/').includes('..') || dir.includes('\\') || /[\x00-\x1f\x7f$]/.test(dir)) return Object.freeze({
        kind: 'refusal', message: `the app directory ${json(input.dir)} is not a plain path inside the cockpit root`,
        fix: 'pass --scaffold-compose the app directory relative to the cockpit root, or . for the root itself' })
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) return Object.freeze({
        kind: 'refusal', message: `--port ${input.port} is not a TCP port`, fix: 'pass --port the port the app listens on inside its container' })
    if (!input.dockerfile && !input.packageJson) return Object.freeze({
        kind: 'refusal', message: `${dir === '.' ? 'the cockpit root' : dir} has neither a Dockerfile nor a package.json, so no image is known to run it`,
        fix: 'add a Dockerfile to the app directory, then rerun the scaffold' })
    if (!input.dockerfile && !input.command?.length) return Object.freeze({
        kind: 'refusal', message: `${dir === '.' ? 'the cockpit root' : dir} has no Dockerfile, so the scaffold needs the command that starts the app`,
        fix: 'pass --command with the start command, such as --command "npm start", or add a Dockerfile to the app directory' })
    const service = (dir === '.' ? 'app' : basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
    const portVariable = `${service.toUpperCase().replaceAll('-', '_')}_HOST_PORT`
    const siblingVariable = deriveSiblingVariable(service)
    const source = dir === '.' ? '.' : `./${dir}`
    const backing = [...new Set(input.with)].sort()
    const lines = [
        "# Written once by cockpit's Compose scaffold; it is yours to edit. cockpit runs it as",
        '# written and never rewrites it. Every published port binds 127.0.0.1 and comes from a',
        '# [ports.bases] variable, so parallel stacks do not collide.',
        'services:',
        `  ${service}:`,
        ...input.dockerfile ? [`    build: \${${siblingVariable}:-${source}}`] : [`    image: ${TOOLCHAIN_IMAGE}`],
        // A minimal init as PID 1 forwards SIGTERM, so sleep and down stop the app promptly.
        '    init: true',
        '    working_dir: /app',
        ...input.command?.length ? [`    command: ${json(input.command)}`] : [],
        `    ports: [${json(`127.0.0.1:\${${portVariable}:-${input.port}}:${input.port}`)}]`,
        `    volumes: [${json(`${source}:/app`)}]`,
        ...backing.length > 0 ? [
            '    environment:',
            ...backing.map(name => `      ${SCAFFOLD_BACKING_SERVICES[name].url[0]}: ${json(SCAFFOLD_BACKING_SERVICES[name].url[1])}`),
            '    depends_on:',
            ...backing.flatMap(name => [`      ${name}:`, '        condition: service_healthy']),
        ] : [],
        ...backing.flatMap(name => {
            const declared = SCAFFOLD_BACKING_SERVICES[name]
            return [
                `  ${name}:`,
                `    image: ${declared.image}`,
                ...Object.keys(declared.environment).length > 0 ? ['    environment:',
                    ...Object.entries(declared.environment).map(([key, value]) => `      ${key}: ${json(value)}`)] : [],
                `    volumes: [${json(`${name}-data:${declared.volume}`)}]`,
                '    healthcheck:',
                `      test: ${json(declared.healthcheck)}`,
                '      interval: 5s',
                '      retries: 10',
            ]
        }),
        ...backing.length > 0 ? ['volumes:', ...backing.map(name => `  ${name}-data: {}`)] : [],
        '',
    ]
    return Object.freeze({ kind: 'complete', service, portVariable, volumes: Object.freeze(backing.map(name => `${name}-data`)),
        bytes: lines.join('\n') })
}

export type ComposeScaffoldWrite = Readonly<{ kind: 'written'; path: string }> | Readonly<{ kind: 'exists'; path: string }>

/** Creates root/compose.yml unless any Compose file is already there; it never replaces one. */
export async function writeComposeScaffold(root: string, bytes: string): Promise<ComposeScaffoldWrite> {
    for (const name of COMPOSE_FILE_NAMES) {
        const path = join(root, name)
        try {
            await lstat(path)
            return Object.freeze({ kind: 'exists', path })
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error
        }
    }
    const path = join(root, 'compose.yml')
    // `wx` fails if the file appeared since the check, so a concurrent write is never replaced.
    const handle = await open(path, 'wx', 0o644)
    try { await handle.writeFile(bytes) } finally { await handle.close() }
    return Object.freeze({ kind: 'written', path })
}
