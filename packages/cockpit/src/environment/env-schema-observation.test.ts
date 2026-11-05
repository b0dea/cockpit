import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import type { StackId } from './contract.js'
import { envSchemaOverrides, observeEnvSchemas } from './env-schema-observation.js'
import { resolveGitExecutable } from './executable.js'

const SCHEMA = '.env.schema'
const SECRET = 'sentinel-resolved-value-7c1e94'
const REQUIRED_EMPTY = 'Value is required but is currently empty'
const stackId = `stack:${'4'.repeat(64)}` as StackId
const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A cockpit root with one sibling, a Varlock stand-in on PATH, and nothing else. */
async function workspace(varlockBody: string = report()) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-env-schema-')))
    roots.push(root)
    const cockpit = join(root, 'cockpit')
    const api = join(root, 'cockpit', 'siblings', 'api')
    await mkdir(api, { recursive: true })
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'varlock'), `#!/bin/sh\n${varlockBody}\n`, { mode: 0o700 })
    return { root, cockpit, api, bin, central: join(cockpit, 'env', '.secrets', 'synthetic', 'api') }
}

function report(errors?: Record<string, unknown>, extra: Record<string, unknown> = {}, exitCode = errors ? 1 : 0): string {
    const body = JSON.stringify({ config: { API_KEY: { value: SECRET }, REGION: { value: SECRET } }, ...errors ? { errors } : {}, ...extra })
    return `cat <<'JSON'\n${body}\nJSON\nexit ${exitCode}`
}

function git(repository: string, ...args: string[]) {
    execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' })
}

async function trackedSchemas(repository: string, ...relative: string[]) {
    git(repository, 'init', '--quiet')
    for (const directory of relative) {
        await mkdir(join(repository, directory), { recursive: true })
        await writeFile(join(repository, directory, SCHEMA), 'API_KEY=\n')
    }
    git(repository, 'add', '--', ...relative.map((directory) => join(directory, SCHEMA)))
}

async function observe(space: Awaited<ReturnType<typeof workspace>>, env: Record<string, string> = {}) {
    const resolved = await resolveGitExecutable(process.env)
    if (resolved.state !== 'available') throw new Error('git is unavailable')
    const execute = vi.fn(executeProbe)
    const [observation] = await observeEnvSchemas({
        stackId, cockpit: { root: space.cockpit, name: 'synthetic' }, siblings: [{ slug: 'api', root: space.api }], git: resolved.value,
        env: { PATH: `${space.bin}:/usr/bin:/bin`, ...env }, timeoutMs: 5_000,
    }, { execute })
    const steps = execute.mock.calls.map(([step]) => step)
    return { observation: observation!, varlock: steps.filter(({ id }) => id.startsWith('env-schema:')) }
}

describe('env schema discovery and load paths', () => {
    it('validates tracked nested schemas, an untracked root and the cockpit root, each with its own central directory', async () => {
        const space = await workspace()
        await trackedSchemas(space.api, 'services/web', 'services/gone', 'services/plain')
        await rm(join(space.api, 'services/gone', SCHEMA))
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        await writeFile(join(space.cockpit, SCHEMA), 'API_KEY=\n')
        await mkdir(space.central, { recursive: true })
        await mkdir(join(space.central, 'services/web'), { recursive: true })

        const { observation, varlock } = await observe(space)

        const loads = Object.fromEntries(varlock.map(({ cwd, argv }) => [cwd, argv.slice(1)]))
        const load = (...paths: string[]) => ['load', '--agent', '--format', 'json-full', ...paths.flatMap((path) => ['--path', path])]
        expect(loads).toEqual({
            [space.api]: load(space.api, space.central),
            [join(space.api, 'services/web')]: load(join(space.api, 'services/web'), join(space.central, 'services/web')),
            [join(space.api, 'services/plain')]: load(join(space.api, 'services/plain')),
            // The cockpit's own schema belongs to no sibling, so its central directory is the store itself.
            [space.cockpit]: load(space.cockpit, join(space.cockpit, 'env', '.secrets', 'synthetic')),
        })
        expect(observation.observed).toMatchObject({ state: 'available', value: [
            { sibling: 'api', state: 'valid', keys: 2 },
            { sibling: 'api (services/plain)', state: 'valid', keys: 2 },
            { sibling: 'api (services/web)', state: 'valid', keys: 2 },
            { sibling: 'cockpit root', state: 'valid', keys: 2 },
        ] })
    })

    it('probes a cockpit root that is also a sibling once, under the sibling', async () => {
        const space = await workspace()
        await writeFile(join(space.cockpit, SCHEMA), 'API_KEY=\n')
        const resolved = await resolveGitExecutable(process.env)
        if (resolved.state !== 'available') throw new Error('git is unavailable')
        const execute = vi.fn(executeProbe)
        await observeEnvSchemas({ stackId, cockpit: { root: space.cockpit, name: 'synthetic' }, siblings: [{ slug: 'root', root: space.cockpit }], git: resolved.value,
            env: { PATH: `${space.bin}:/usr/bin:/bin` }, timeoutMs: 5_000 }, { execute })
        expect(execute.mock.calls.filter(([step]) => step.id.startsWith('env-schema:')).map(([step]) => step.id)).toEqual(['env-schema:root'])
    })

    it('refuses a central path it must not follow, naming that path, without reading inside it or running Varlock', async () => {
        const space = await workspace()
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        await mkdir(join(space.central, '..'), { recursive: true })
        const elsewhere = join(space.root, 'elsewhere')
        await mkdir(elsewhere)
        await symlink(elsewhere, space.central)

        const linked = await observe(space)
        expect(linked.varlock).toEqual([])
        expect(linked.observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringContaining(`${space.central} is a symbolic link`) })

        await rm(space.central)
        await writeFile(space.central, 'not a directory\n')
        expect((await observe(space)).observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringContaining(`${space.central} is not a directory`) })

        await rm(space.central)
        const store = join(space.central, '..')
        await chmod(store, 0o000)
        try {
            const denied = await observe(space)
            expect(denied.varlock).toEqual([])
            expect(denied.observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringContaining(`${space.central} could not be inspected`) })
        } finally {
            await chmod(store, 0o700)
        }
    })

    it('falls back to the root outside a repository, and is unavailable when Git fails or reports too many schemas', async () => {
        const space = await workspace()
        await mkdir(join(space.api, 'services/web'), { recursive: true })
        await writeFile(join(space.api, 'services/web', SCHEMA), 'API_KEY=\n')
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        expect((await observe(space)).observation.observed).toMatchObject({ state: 'available', value: [{ sibling: 'api', state: 'valid' }] })

        await trackedSchemas(space.api, 'services/web')
        await writeFile(join(space.api, '.git', 'index'), 'not an index')
        const refused = await observe(space)
        expect(refused.varlock).toEqual([])
        expect(refused.observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/api \(\.\): tracked schemas could not be listed: Git failed: fatal: .*index/) })

        await rm(join(space.api, '.git'), { recursive: true })
        await trackedSchemas(space.api, ...Array.from({ length: 64 }, (_, index) => `services/s${index}`))
        expect((await observe(space)).observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('tracks more than 64 schemas') })

        // A name that cannot be shown could hide a schema, so it is no clean listing.
        await rm(join(space.api, '.git'), { recursive: true })
        await trackedSchemas(space.api, 'services/line\nbreak')
        expect((await observe(space)).observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('control or undecodable characters') })
    })

    it('leaves a missing sibling to the row that reports it', async () => {
        const space = await workspace()
        await rm(space.api, { recursive: true })
        expect((await observe(space)).observation.observed).toMatchObject({ state: 'available', value: [] })
    })
})

describe('env schema report categories', () => {
    async function classified(errors: Record<string, unknown>, extra?: Record<string, unknown>) {
        const space = await workspace(report(errors, extra))
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        const { observation } = await observe(space)
        expect(JSON.stringify(observation)).not.toContain(SECRET)
        return observation
    }

    it('reports a provider it cannot resolve through as unavailable, naming keys only and how to recover', async () => {
        // A provider can say "required" too; only the exact empty-value message proves a key is missing.
        for (const message of [`exec(): command failed (exit code 3): ${SECRET}`, 'Unable to coerce string to number', `credential ${SECRET} is required`]) {
            const observation = await classified({ configItems: { API_KEY: message } })
            expect(observation.observed).toMatchObject({ state: 'unavailable', reason: 'env schema could not be checked: api (.): could not validate or resolve API_KEY' })
            expect(observation.remedy).toContain('a secret provider may be signed out or unreachable: sign in to it, then rerun')
            expect(observation.remedy).toContain('VARLOCK_TELEMETRY_DISABLED=true varlock load --path <schema directory> --path <cockpit root>/env/.secrets/synthetic/<slug>[/<relative dir>]')
            expect(observation.remedy).toContain('cockpit doctor on a cockpit that declares no runtime')
        }
    })

    it('fails the row only for a key that is actually missing or a schema that does not load', async () => {
        const mixed = await classified({ configItems: { API_KEY: REQUIRED_EMPTY, REGION: `exec(): command failed (exit code 3): ${SECRET}` } })
        expect(mixed.observed).toMatchObject({ state: 'failed', reason: 'env schema is invalid in api (.): missing required API_KEY; could not validate or resolve REGION' })
        expect(mixed.remedy).toContain('signed out')

        const missing = await classified({ configItems: { API_KEY: REQUIRED_EMPTY } })
        expect(missing.observed).toMatchObject({ state: 'failed', reason: 'env schema is invalid in api (.): missing required API_KEY' })
        expect(missing.remedy).not.toContain('signed out')

        expect((await classified({ root: [`plugin ${SECRET} failed`] })).observed)
            .toMatchObject({ state: 'failed', reason: 'env schema is invalid in api (.): schema could not be loaded' })
    })

    it('carries an unavailable schema into a failing row beside the invalid one', async () => {
        const space = await workspace(`case "$*" in *services/web*) ${report({ configItems: { REGION: 'exec(): command failed' } })} ;; *) ${report({ configItems: { API_KEY: REQUIRED_EMPTY } })} ;; esac`)
        await trackedSchemas(space.api, 'services/web')
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        expect((await observe(space)).observation.observed).toMatchObject({ state: 'failed',
            reason: 'env schema is invalid in api (.): missing required API_KEY; could not be checked: api (services/web): could not validate or resolve REGION' })
    })
})

describe('env schema caller environment', () => {
    it('strips every Varlock control variable and keeps what a provider may need', async () => {
        const space = await workspace(`env | grep -q '^_VARLOCK_' && exit 42\ntest "$PROVIDER_TOKEN_FILE" = synthetic || exit 43\n${report()}`)
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        const { observation } = await observe(space, { _VARLOCK_FILTER: 'REGION', _VARLOCK_USE_FROZEN_ENV: '1', PROVIDER_TOKEN_FILE: 'synthetic' })
        expect(observation.observed).toMatchObject({ state: 'available', value: [{ sibling: 'api', state: 'valid' }] })
    })

    it('surfaces overridden keys from a passing row, names only', async () => {
        const space = await workspace(report(undefined, { overrideKeys: ['REGION', 'API_KEY'] }))
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        const { observation } = await observe(space)
        expect(observation.observed).toMatchObject({ state: 'available', value: [{ sibling: 'api', state: 'valid', keys: 2, overrides: ['API_KEY', 'REGION'] }] })
        const measured = observation.observed.state === 'available' ? observation.observed.value : null
        expect(envSchemaOverrides({ owner: observation.owner, verdict: 'pass', measured })).toEqual([{ schema: 'api', keys: ['API_KEY', 'REGION'] }])
        expect(envSchemaOverrides({ owner: observation.owner, verdict: 'fail', measured })).toEqual([])
    })

    it('refuses an override list it cannot read rather than discarding it', async () => {
        const space = await workspace(report(undefined, { overrideKeys: [`${SECRET}=value`] }))
        await writeFile(join(space.api, SCHEMA), 'API_KEY=\n')
        const { observation } = await observe(space)
        expect(observation.observed).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('unrecognised shape') })
        expect(JSON.stringify(observation)).not.toContain(SECRET)
    })
})
