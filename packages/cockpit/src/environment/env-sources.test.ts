import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../cli.js'

const SCHEMA = '.env.schema'
const SENTINEL = 'sentinel-never-shown-5d2e81'
const roots: string[] = []

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const sibling = (slug: string) => ['[[sibling]]', `slug = "${slug}"`, `dir = "${slug}"`, 'mount = "none"', 'acquire = "none"', `var = "${slug.toUpperCase()}_DIR"`, `purpose = "Synthetic ${slug}"`,
    ...slug === 'declared' ? ['environment_files = [{ template = "runtime.template", instance = "config/runtime.instance" }]'] : [], '']

function estate(...slugs: string[]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-env-sources-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "siblings"', '', ...slugs.flatMap(sibling), '[ports]', 'bases = {}', ''].join('\n'))
    for (const slug of slugs) mkdirSync(join(root, 'siblings', slug), { recursive: true })
    const bin = join(root, 'bin')
    mkdirSync(bin)
    // Stands in for Varlock so a run leaves evidence: neither command may execute a schema.
    writeFileSync(join(bin, 'varlock'), `#!/bin/sh\ntouch '${join(root, 'varlock-ran')}'\n`, { mode: 0o700 })
    return { root, configPath, sibling: (slug: string) => join(root, 'siblings', slug), varlockRan: () => existsSync(join(root, 'varlock-ran')),
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } }
}

function write(path: string, text: string) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
}

function git(repository: string, ...args: string[]) {
    execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' })
}

async function cli(env: Readonly<Record<string, string>>, ...args: string[]) {
    let stdout = ''
    let stderr = ''
    const status = await runCli(args, { stdout: { write: (text) => ((stdout += text), true) }, stderr: { write: (text) => ((stderr += text), true) } }, {}, { env })
    return { status, stdout, stderr }
}

type Space = ReturnType<typeof estate>
const keysJson = async (space: Space) => {
    const ran = await cli(space.env, 'env', 'keys', '--config', space.configPath, '--json')
    return { ...ran, report: JSON.parse(ran.stdout) }
}
const sourceAt = (report: { result: { sources: { path: string }[] } }, path: string) => report.result.sources.find((source) => source.path === path) as Record<string, unknown> | undefined

describe('env keys', () => {
    it('reports names and declared attributes, and never a value, resolver, comment or unparsed line', async () => {
        const space = estate('api')
        write(join(space.sibling('api'), SCHEMA), [
            '# @defaultRequired=false @defaultSensitive=true',
            '# ---',
            '',
            `# ${SENTINEL} comment text mentioning @sensitive=false`,
            `# @required @type=url # ${SENTINEL} after a decorator`,
            `PLAIN=${SENTINEL}`,
            '',
            '# @optional @public',
            `export EXPORTED=${SENTINEL}`,
            '',
            `# @required=forEnv(${SENTINEL})`,
            `# @type=enum(${SENTINEL}, other)`,
            `CONDITIONAL=exec("vault kv get ${SENTINEL}")`,
            '',
            '# @type="not bare"',
            'QUOTED_TYPE=',
            '',
            '# detached by the blank line',
            '# @required',
            '',
            `MULTI="first ${SENTINEL}`,
            `LEAKED_FROM_QUOTE=${SENTINEL}`,
            'last"',
            '',
            `TRIPLE='''first ${SENTINEL}`,
            `LEAKED_FROM_TRIPLE=${SENTINEL}`,
            `'''`,
            '',
            'CALL=concat(',
            `  LEAKED_FROM_CALL=${SENTINEL}`,
            ')',
            '',
            `dotted.name=${SENTINEL}`,
            `1BAD=${SENTINEL}`,
            `a bare ${SENTINEL} line`,
            `# @required @@${SENTINEL}`,
            '',
            '# @sensitive=false',
            `HAS_INLINE=${SENTINEL} # @sensitive`,
            `INLINE_ONLY=${SENTINEL} # @sensitive`,
            '',
        ].join('\n'))
        // Beside the schema and never opened: a key in either would prove it was read.
        write(join(space.sibling('api'), '.env'), `FROM_DOTENV=${SENTINEL}\n`)
        write(join(space.sibling('api'), '.env.local'), `FROM_LOCAL=${SENTINEL}\n`)

        const json = await keysJson(space)
        const human = await cli(space.env, 'env', 'keys', '--config', space.configPath)

        expect(json.status).toBe(0)
        expect(sourceAt(json.report, join(space.sibling('api'), SCHEMA))).toEqual({
            owner: 'api', path: join(space.sibling('api'), SCHEMA), kind: 'schema', reference: `api:${SCHEMA}`, state: 'read', unparsed: 4,
            keys: [
                { name: 'PLAIN', required: true, sensitive: true, type: 'url' },
                { name: 'EXPORTED', required: false, sensitive: false },
                // A condition has no static answer, and still overrides the default.
                { name: 'CONDITIONAL', sensitive: true, type: 'enum' },
                { name: 'QUOTED_TYPE', required: false, sensitive: true },
                { name: 'MULTI', required: false, sensitive: true },
                { name: 'TRIPLE', required: false, sensitive: true },
                { name: 'CALL', required: false, sensitive: true },
                // A decorator after the value is not read, so no default is claimed over it.
                { name: 'HAS_INLINE', sensitive: false },
                { name: 'INLINE_ONLY' },
            ],
        })
        expect(human.status).toBe(0)
        expect(human.stdout).toContain('name: PLAIN')
        for (const output of [json.stdout, json.stderr, human.stdout, human.stderr]) {
            expect(output).not.toContain(SENTINEL)
            for (const leaked of ['LEAKED_FROM', 'FROM_DOTENV', 'FROM_LOCAL', 'dotted.name', '1BAD']) expect(output).not.toContain(leaked)
        }
        expect(space.varlockRan()).toBe(false)
    })

    it('reads the probe\'s roots, falls back to templates, and reports a link by name without following it', async () => {
        const space = estate('api', 'web', 'plain', 'linked')
        const api = space.sibling('api')
        write(join(api, 'services/web', SCHEMA), 'NESTED=\n')
        write(join(api, SCHEMA), 'ROOT_KEY=\n')
        git(api, 'init', '--quiet')
        git(api, 'add', '--', join('services/web', SCHEMA))
        // Git does not track this one, so it is no declared component, as the probe treats it.
        write(join(api, 'services/hidden', SCHEMA), 'HIDDEN=\n')
        write(join(space.sibling('web'), '.env.example'), 'FROM_EXAMPLE=\n')
        write(join(space.sibling('web'), '.env.template'), 'FROM_TEMPLATE=\n')
        write(join(space.sibling('plain'), SCHEMA), 'PLAIN_KEY=\n')
        write(join(space.sibling('plain'), '.env.example'), 'SHADOWED_BY_SCHEMA=\n')
        const secret = join(space.root, 'secret.txt')
        write(secret, `LINK_TARGET=${SENTINEL}\n`)
        symlinkSync(secret, join(space.sibling('linked'), SCHEMA))
        write(join(space.root, SCHEMA), 'COCKPIT_KEY=\n')

        const { status, stdout, report } = await keysJson(space)

        expect(status).toBe(0)
        expect(report.result.sources.map((source: { path: string; kind: string; state: string; keys?: { name: string }[]; owner: string }) =>
            [source.owner, source.path, source.kind, source.state, source.keys?.map(({ name }) => name)])).toEqual([
            ['api', join(api, SCHEMA), 'schema', 'read', ['ROOT_KEY']],
            ['api (services/web)', join(api, 'services/web', SCHEMA), 'schema', 'read', ['NESTED']],
            ['web', join(space.sibling('web'), '.env.example'), 'template', 'read', ['FROM_EXAMPLE']],
            ['web', join(space.sibling('web'), '.env.template'), 'template', 'read', ['FROM_TEMPLATE']],
            ['plain', join(space.sibling('plain'), SCHEMA), 'schema', 'read', ['PLAIN_KEY']],
            ['linked', join(space.sibling('linked'), SCHEMA), 'schema', 'symbolic-link', undefined],
            ['cockpit root', join(space.root, SCHEMA), 'schema', 'read', ['COCKPIT_KEY']],
        ])
        expect(report.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'ENV_KEYS_SOURCE_SKIPPED', target: 'linked' })])
        expect(report.guidance).toEqual([{ code: 'ENV_KEYS_SOURCE_SKIPPED', target: 'linked', text: 'replace it with a regular file in that directory' }])
        expect(stdout).not.toContain(SENTINEL)
        expect(stdout).not.toContain('HIDDEN')
    })

    it('reads the checkout cockpit use serves, not the declared directory', async () => {
        const space = estate('api')
        write(join(space.sibling('api'), SCHEMA), 'DECLARED=\n')
        const worktree = join(space.root, 'api-worktree')
        write(join(worktree, SCHEMA), 'SERVED=\n')
        write(join(space.root, '.cockpit/local/sibling-checkouts'), `${JSON.stringify({ format: 'cockpit-sibling-checkouts/v1', checkouts: { api: worktree } })}\n`)
        const { report } = await keysJson(space)
        expect(sourceAt(report, join(worktree, SCHEMA))).toMatchObject({ keys: [{ name: 'SERVED' }] })
        expect(sourceAt(report, join(space.sibling('api'), SCHEMA))).toBeUndefined()
    })

    it('stops a value that never closes rather than reading its content as keys, and says when output is cut', async () => {
        const space = estate('api')
        write(join(space.sibling('api'), '.env.example'), `BEFORE=1\nOPEN="${SENTINEL}\nLEAKED=${SENTINEL}\n`)
        write(join(space.root, '.env.sample'), Array.from({ length: 2_100 }, (_, index) => `KEY_${index}=\n`).join(''))

        const { status, stdout, report } = await keysJson(space)

        expect(status).toBe(0)
        expect(sourceAt(report, join(space.sibling('api'), '.env.example'))).toMatchObject({ keys: [{ name: 'BEFORE' }], unparsed: 1 })
        expect(stdout).not.toContain(SENTINEL)
        expect(sourceAt(report, join(space.root, '.env.sample'))).toMatchObject({ keysOmitted: 53 })
        expect((sourceAt(report, join(space.root, '.env.sample'))!.keys as unknown[])).toHaveLength(2_047)
        expect(report.result.truncated).toBe('output stops at 2048 keys and 256 sources: 53 keys and 0 directories were left out')
    })

    it('exits 0 naming what it looked for when there is no source, and 2 naming the reason when Git or a file fails', async () => {
        const space = estate('api')
        const empty = await keysJson(space)
        expect(empty.status).toBe(0)
        expect(empty.report.result).toEqual({
            summary: 'no source found: looked for .env.schema, .env.example, .env.sample, or .env.template in each directory below',
            sources: [], lookedFor: [SCHEMA, '.env.example', '.env.sample', '.env.template'], lookedIn: [space.root, space.sibling('api')],
        })
        expect((await cli(space.env, 'env', 'keys', '--config', space.configPath)).stdout).toContain('no source found')

        writeFileSync(join(space.root, SCHEMA), Buffer.from([0x41, 0x3d, 0xff, 0x0a]))
        const api = space.sibling('api')
        write(join(api, SCHEMA), 'NOT_REACHED=\n')
        git(api, 'init', '--quiet')
        writeFileSync(join(api, '.git', 'index'), 'not an index')
        const failed = await keysJson(space)
        expect(failed.status).toBe(2)
        expect(failed.report.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE', target: 'api', message: expect.stringMatching(/api \(\.\) could not be listed: tracked schemas could not be listed: Git failed/) }),
            expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE', target: 'cockpit root', message: expect.stringContaining('not valid UTF-8') }),
        ]))
        // A failing run still answers with what it could read.
        expect((await cli(space.env, 'env', 'keys', '--config', space.configPath)).stdout).toContain('unreadable')
    })
})

describe('env schema', () => {
    const schemaAt = (space: Space, path: string, ...flags: string[]) => cli(space.env, 'env', 'schema', '--config', space.configPath, '--path', path, ...flags)
    const TEXT = '# a comment stays\n# @required\nAPI_KEY=exec("synthetic")\n\nexport OTHER = "a  b"\n'

    it('prints a discovered schema verbatim, from a sibling, a tracked directory and the cockpit root, running nothing', async () => {
        const space = estate('api')
        const api = space.sibling('api')
        write(join(api, SCHEMA), TEXT)
        write(join(api, 'services/web', SCHEMA), `NESTED=\n${TEXT}`)
        git(api, 'init', '--quiet')
        git(api, 'add', '--', join('services/web', SCHEMA))
        write(join(space.root, SCHEMA), 'COCKPIT=\n')

        const root = await schemaAt(space, `api:${SCHEMA}`)
        expect(root).toEqual({ status: 0, stdout: TEXT, stderr: '' })
        expect((await schemaAt(space, `api:services/web/${SCHEMA}`)).stdout).toBe(`NESTED=\n${TEXT}`)
        expect((await schemaAt(space, SCHEMA)).stdout).toBe('COCKPIT=\n')
        expect(JSON.parse((await schemaAt(space, `api:${SCHEMA}`, '--json')).stdout).result).toEqual({ reference: `api:${SCHEMA}`, path: join(api, SCHEMA), text: TEXT })
        // The directory alone names the same schema, and the result names the file.
        expect(await schemaAt(space, 'api:')).toEqual(root)
        expect((await schemaAt(space, 'api:services/web')).stdout).toBe(`NESTED=\n${TEXT}`)
        expect((await schemaAt(space, '.')).stdout).toBe('COCKPIT=\n')
        expect(JSON.parse((await schemaAt(space, 'api:', '--json')).stdout).result).toEqual({ reference: `api:${SCHEMA}`, path: join(api, SCHEMA), text: TEXT })
        expect(space.varlockRan()).toBe(false)
    })

    it('keeps a control character from reaching a terminal, and the exact text in JSON', async () => {
        const space = estate('api')
        write(join(space.sibling('api'), SCHEMA), 'A=\u001b[31m\n')
        expect((await schemaAt(space, `api:${SCHEMA}`)).stdout).toBe('A=\\u001b[31m\n')
        expect(JSON.parse((await schemaAt(space, `api:${SCHEMA}`, '--json')).stdout).result.text).toBe('A=\u001b[31m\n')
    })

    it('refuses every other name, a link, a non-file, an undiscovered directory and an oversized file, showing nothing inside', async () => {
        const space = estate('api', 'linked', 'hardlinked', 'directory', 'huge', 'absent')
        const api = space.sibling('api')
        const secret = join(space.root, 'secret.txt')
        write(secret, `TOKEN=${SENTINEL}\n`)
        // On a case-insensitive filesystem the last one is what `.env.schema` opens, so only the name can refuse it.
        for (const name of ['.env', '.env.local', '.env.schema.private', '.ENV.SCHEMA']) write(join(api, name), `TOKEN=${SENTINEL}\n`)
        // Outside the sibling, reachable only by climbing.
        write(join(space.root, 'siblings', SCHEMA), `TOKEN=${SENTINEL}\n`)
        write(join(api, 'untracked', SCHEMA), `TOKEN=${SENTINEL}\n`)
        symlinkSync(secret, join(space.sibling('linked'), SCHEMA))
        linkSync(secret, join(space.sibling('hardlinked'), SCHEMA))
        mkdirSync(join(space.sibling('directory'), SCHEMA))
        write(join(space.sibling('huge'), SCHEMA), `TOKEN=${SENTINEL}\n${'#'.repeat(1_048_576)}\n`)

        for (const [path, why] of [
            ['.env', 'named exactly'], ['api:.env', 'named exactly'], ['api:.env.local', 'named exactly'], ['api:.env.schema.private', 'named exactly'],
            ['api:.ENV.SCHEMA', 'named exactly'], [`../${SCHEMA}`, 'named exactly'], [`api:../${SCHEMA}`, 'named exactly'], [`api:services/../../${SCHEMA}`, 'named exactly'],
            [secret, 'named exactly'], [`api:untracked/${SCHEMA}`, 'not in a directory cockpit discovers'], [`nosuch:${SCHEMA}`, 'not in a directory cockpit discovers'],
            [`linked:${SCHEMA}`, 'is a symbolic link'], [`hardlinked:${SCHEMA}`, 'another hard link'], [`directory:${SCHEMA}`, 'not a regular file'], [`huge:${SCHEMA}`, 'larger than'],
            [`absent:${SCHEMA}`, 'does not exist'],
        ] as const) {
            for (const ran of [await schemaAt(space, path), await schemaAt(space, path, '--json')]) {
                expect(ran.status, path).toBe(2)
                expect(`${ran.stdout}${ran.stderr}`, path).toContain('ENV_SCHEMA_READ_REFUSED')
                expect(`${ran.stdout}${ran.stderr}`, path).toContain(why)
                expect(`${ran.stdout}${ran.stderr}`, path).toMatch(/Fix|"fix"|Guidance|"guidance"/)
                expect(`${ran.stdout}${ran.stderr}`, path).not.toContain(SENTINEL)
            }
        }
        // A schema that does not exist yet is created, not read: the remedy names that route.
        expect((await schemaAt(space, `absent:${SCHEMA}`)).stderr).toContain(`--path absent:${SCHEMA} --replace-from <draft>`)
        expect(space.varlockRan()).toBe(false)
    })

    it('refuses a tracked directory replaced by a link, and a sibling Git cannot list', async () => {
        const space = estate('api', 'broken')
        const api = space.sibling('api')
        write(join(api, 'services/web', SCHEMA), 'TRACKED=\n')
        git(api, 'init', '--quiet')
        git(api, 'add', '--', join('services/web', SCHEMA))
        const elsewhere = join(space.root, 'elsewhere')
        write(join(elsewhere, SCHEMA), `TOKEN=${SENTINEL}\n`)
        rmSync(join(api, 'services/web'), { recursive: true })
        symlinkSync(elsewhere, join(api, 'services/web'))
        const linked = await schemaAt(space, `api:services/web/${SCHEMA}`)
        expect(linked.status).toBe(2)
        expect(linked.stderr).toContain('is a symbolic link')
        expect(`${linked.stdout}${linked.stderr}`).not.toContain(SENTINEL)
        expect(sourceAt((await keysJson(space)).report, join(api, 'services/web'))).toMatchObject({ state: 'symbolic-link' })

        const broken = space.sibling('broken')
        write(join(broken, SCHEMA), `TOKEN=${SENTINEL}\n`)
        git(broken, 'init', '--quiet')
        writeFileSync(join(broken, '.git', 'index'), 'not an index')
        const unlisted = await schemaAt(space, `broken:${SCHEMA}`)
        expect(unlisted.status).toBe(2)
        expect(unlisted.stderr).toContain('could not be listed')
        expect(`${unlisted.stdout}${unlisted.stderr}`).not.toContain(SENTINEL)
    })
})

describe('env schema --replace-from', () => {
    const replacing = (space: Space, draft: string, reference = `api:${SCHEMA}`, ...flags: string[]) =>
        cli(space.env, 'env', 'schema', '--config', space.configPath, '--path', reference, '--replace-from', draft, ...flags)
    const OLD = 'OLD_KEY=\n'

    it('replaces or creates a discovered schema from a draft, leaving nothing else behind, and runs nothing', async () => {
        const space = estate('api')
        const api = space.sibling('api')
        write(join(api, SCHEMA), OLD)
        write(join(api, 'services/web', SCHEMA), OLD)
        git(api, 'init', '--quiet')
        git(api, 'add', '--', join('services/web', SCHEMA))
        write(join(space.root, 'drafts/schema.txt'), 'NEW_KEY=exec("synthetic")\n')

        const replaced = await replacing(space, 'drafts/schema.txt', `api:${SCHEMA}`, '--json')
        expect(replaced.status).toBe(0)
        expect(JSON.parse(replaced.stdout).result).toMatchObject({ action: 'replaced', path: join(api, SCHEMA), note: expect.stringContaining('not validated until committed') })
        expect(readFileSync(join(api, SCHEMA), 'utf8')).toBe('NEW_KEY=exec("synthetic")\n')
        expect(replaced.stdout).not.toContain('NEW_KEY')

        expect((await replacing(space, join(space.root, 'drafts/schema.txt'), `api:services/web/${SCHEMA}`)).status).toBe(0)
        expect(readFileSync(join(api, 'services/web', SCHEMA), 'utf8')).toBe('NEW_KEY=exec("synthetic")\n')

        // The cockpit root holds none yet, and a discovered root may gain its first.
        const created = await replacing(space, 'drafts/schema.txt', SCHEMA, '--json')
        expect(JSON.parse(created.stdout).result).toMatchObject({ action: 'created', path: join(space.root, SCHEMA) })
        expect(readFileSync(join(space.root, SCHEMA), 'utf8')).toBe('NEW_KEY=exec("synthetic")\n')
        expect(readdirSync(api).filter((name) => name.startsWith('.cockpit'))).toEqual([])
        // The draft survives: nothing but the schema changed.
        expect(existsSync(join(space.root, 'drafts/schema.txt'))).toBe(true)
        expect(space.varlockRan()).toBe(false)
    })

    it('creates the first nested schema only at an established tracked component boundary', async () => {
        const space = estate('api')
        const api = space.sibling('api')
        const component = join(api, 'local/worker')
        write(join(component, 'server.ts'), 'export {}\n')
        write(join(component, '.env.local'), `TOKEN=${SENTINEL}\n`)
        git(api, 'init', '--quiet')
        git(api, 'add', '--', 'local/worker/server.ts')
        write(join(space.root, 'draft.txt'), 'WORKER_KEY=exec("synthetic")\n')

        const created = await replacing(space, 'draft.txt', `api:local/worker/${SCHEMA}`, '--json')
        expect(created.status, `${created.stdout}${created.stderr}`).toBe(0)
        expect(JSON.parse(created.stdout).result).toMatchObject({ action: 'created', path: join(component, SCHEMA), note: expect.stringContaining('not validated until committed') })
        expect(readFileSync(join(component, SCHEMA), 'utf8')).toBe('WORKER_KEY=exec("synthetic")\n')
        expect(`${created.stdout}${created.stderr}`).not.toContain(SENTINEL)
        expect(readdirSync(component).filter((name) => name.startsWith('.cockpit'))).toEqual([])
        expect(space.varlockRan()).toBe(false)

        const beforeAdd = await cli(space.env, 'env', 'schema', '--config', space.configPath, '--path', `api:local/worker/${SCHEMA}`)
        expect(beforeAdd.status).toBe(2)
        git(api, 'add', '--', 'local/worker/.env.schema')
        const afterAdd = await cli(space.env, 'env', 'schema', '--config', space.configPath, '--path', `api:local/worker/${SCHEMA}`)
        expect(afterAdd.status).toBe(0)
        expect(afterAdd.stdout).toContain('WORKER_KEY=exec("synthetic")')
        expect(space.varlockRan()).toBe(false)

        // Untracked files and tracked descendants do not establish the requested boundary.
        write(join(api, 'untracked/server.ts'), 'export {}\n')
        for (const reference of [`api:untracked/${SCHEMA}`, `api:local/${SCHEMA}`, `nosuch:local/worker/${SCHEMA}`]) {
            const refused = await replacing(space, 'draft.txt', reference)
            expect(refused.status, reference).toBe(2)
            expect(`${refused.stdout}${refused.stderr}`).not.toContain(SENTINEL)
        }
        expect(existsSync(join(api, 'untracked', SCHEMA))).toBe(false)
        expect(existsSync(join(api, 'local', SCHEMA))).toBe(false)
    })

    it('creates a nested schema only in the checkout currently served', async () => {
        const space = estate('api')
        const api = space.sibling('api')
        write(join(api, 'component/server.ts'), 'export {}\n')
        git(api, 'init', '--quiet')
        git(api, 'add', '--', 'component/server.ts')
        git(api, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture')
        const worktree = join(space.root, 'api-worktree')
        git(api, 'worktree', 'add', '--detach', worktree)
        write(join(space.root, '.cockpit/local/sibling-checkouts'), `${JSON.stringify({ format: 'cockpit-sibling-checkouts/v1', checkouts: { api: worktree } })}\n`)
        write(join(space.root, 'draft.txt'), 'SERVED_KEY=\n')
        const created = await replacing(space, 'draft.txt', `api:component/${SCHEMA}`)
        expect(created.status).toBe(0)
        expect(readFileSync(join(worktree, 'component', SCHEMA), 'utf8')).toBe('SERVED_KEY=\n')
        expect(existsSync(join(api, 'component', SCHEMA))).toBe(false)
        expect(space.varlockRan()).toBe(false)
    })

    // The fixture below shares one outside file with a hard link, which would refuse a linked
    // directory on its own; here the outside file is a single regular file under the tracked name.
    it('refuses a component reached through a linked directory', async () => {
        const space = estate('api')
        const api = space.sibling('api')
        write(join(space.root, 'draft.txt'), 'NEW_KEY=\n')
        const outside = join(space.root, 'outside')
        for (const directory of ['linked', 'parent/child']) write(join(api, directory, 'server.ts'), 'export {}\n')
        git(api, 'init', '--quiet')
        git(api, 'add', '--', 'linked', 'parent')
        write(join(outside, 'server.ts'), 'export {}\n')
        write(join(outside, 'child/server.ts'), 'export {}\n')
        rmSync(join(api, 'linked'), { recursive: true })
        symlinkSync(outside, join(api, 'linked'))
        rmSync(join(api, 'parent'), { recursive: true })
        symlinkSync(outside, join(api, 'parent'))
        for (const reference of [`api:linked/${SCHEMA}`, `api:parent/child/${SCHEMA}`]) {
            const ran = await replacing(space, 'draft.txt', reference)
            expect(ran.status, reference).toBe(2)
            expect(ran.stdout + ran.stderr, reference).toContain('is a symbolic link')
        }
        expect(existsSync(join(outside, SCHEMA))).toBe(false)
        expect(existsSync(join(outside, 'child', SCHEMA))).toBe(false)
    })

    it('refuses linked, sensitive or protected component authority without reading its bytes', async () => {
        const space = estate('api', 'declared')
        const api = space.sibling('api')
        write(join(space.root, 'draft.txt'), 'NEW_KEY=\n')
        const outside = join(space.root, 'outside')
        write(join(outside, 'server.ts'), SENTINEL)
        for (const directory of ['linked-directory', 'linked-file', 'hardlinked-file', 'secret-only', 'deleted']) {
            write(join(api, directory, directory === 'secret-only' ? '.env.local' : 'server.ts'), SENTINEL)
        }
        git(api, 'init', '--quiet')
        git(api, 'add', '--', 'linked-directory', 'linked-file', 'hardlinked-file', 'secret-only', 'deleted')
        rmSync(join(api, 'linked-directory'), { recursive: true })
        symlinkSync(outside, join(api, 'linked-directory'))
        rmSync(join(api, 'linked-file/server.ts'))
        symlinkSync(join(outside, 'server.ts'), join(api, 'linked-file/server.ts'))
        rmSync(join(api, 'hardlinked-file/server.ts'))
        linkSync(join(outside, 'server.ts'), join(api, 'hardlinked-file/server.ts'))
        rmSync(join(api, 'deleted'), { recursive: true })
        const declared = space.sibling('declared')
        write(join(declared, 'config/runtime.instance'), SENTINEL)
        git(declared, 'init', '--quiet')
        git(declared, 'add', '--', 'config/runtime.instance')
        for (const reference of [
            ...['linked-directory', 'linked-file', 'hardlinked-file', 'secret-only', 'deleted', '.secrets', 'component/../outside', './outside'].map((directory) => `api:${directory}/${SCHEMA}`),
            `declared:config/${SCHEMA}`,
        ]) {
            const ran = await replacing(space, 'draft.txt', reference)
            expect(ran.status, reference).toBe(2)
            expect(`${ran.stdout}${ran.stderr}`).not.toContain(SENTINEL)
        }
        expect(existsSync(join(outside, SCHEMA))).toBe(false)
        expect(existsSync(join(declared, 'config', SCHEMA))).toBe(false)
        expect(space.varlockRan()).toBe(false)
    })

    it('refuses to launder a secret through a draft, leaving the target unchanged and the secret unshown', async () => {
        const space = estate('api', 'declared')
        const api = space.sibling('api')
        write(join(api, SCHEMA), OLD)
        const secretText = `TOKEN=${SENTINEL}\n`
        for (const draft of ['.env', '.ENV', '.env.local', '.env.example', '.Env.Draft', '.env-drafts/schema.txt', '.secrets/schema.txt', '.\u017Fecrets/schema.txt',
            'env/.secrets/synthetic/api/schema.txt']) write(join(space.root, draft), secretText)
        const instance = join(space.sibling('declared'), 'config/runtime.instance')
        write(instance, secretText)
        const secret = join(space.root, 'secret.txt')
        write(secret, secretText)
        symlinkSync(secret, join(space.root, 'linked.txt'))
        symlinkSync(join(space.root, '.secrets'), join(space.root, 'linked-directory'))
        write(join(space.root, 'original.txt'), secretText)
        linkSync(join(space.root, 'original.txt'), join(space.root, 'second-name.txt'))
        mkdirSync(join(space.root, 'directory.txt'))
        write(join(space.root, 'huge.txt'), `${secretText}${'#'.repeat(1_048_576)}\n`)
        writeFileSync(join(space.root, 'binary.txt'), Buffer.concat([Buffer.from(secretText), Buffer.from([0xff])]))

        for (const [draft, why] of [
            ['.env', 'starts with .env'], ['.ENV', 'starts with .env'], ['.env.local', 'starts with .env'], ['.env.example', 'starts with .env'], ['.Env.Draft', 'starts with .env'],
            ['.env-drafts/schema.txt', 'starts with .env'], ['.secrets/schema.txt', 'is .secrets'], ['.\u017Fecrets/schema.txt', 'is .secrets'], ['env/.secrets/synthetic/api/schema.txt', 'is .secrets'],
            [instance, 'the guard protects it'], ['cockpit.toml', 'the guard protects it'],
            ['linked.txt', 'symbolic link'], ['linked-directory/schema.txt', 'is .secrets'], ['second-name.txt', 'another hard link'], ['directory.txt', 'not a regular file'],
            ['huge.txt', 'larger than'], ['binary.txt', 'not valid UTF-8'], ['absent.txt', 'could not be inspected'],
        ] as const) {
            for (const ran of [await replacing(space, draft), await replacing(space, draft, `api:${SCHEMA}`, '--json')]) {
                const output = `${ran.stdout}${ran.stderr}`
                expect(ran.status, draft).toBe(2)
                expect(output, draft).toContain('ENV_SCHEMA_REPLACE_REFUSED')
                expect(output, draft).toContain(why)
                expect(output, draft).not.toContain(SENTINEL)
                expect(readFileSync(join(api, SCHEMA), 'utf8'), draft).toBe(OLD)
            }
        }
        expect(space.varlockRan()).toBe(false)
    })

    it('refuses a target that is a link, a second name, undiscovered or not exactly named, changing nothing', async () => {
        const space = estate('linked', 'hardlinked', 'api')
        const draftText = `NEW=${SENTINEL}\n`
        write(join(space.root, 'draft.txt'), draftText)
        const elsewhere = join(space.root, 'elsewhere.txt')
        write(elsewhere, OLD)
        symlinkSync(elsewhere, join(space.sibling('linked'), SCHEMA))
        const shared = join(space.root, 'shared.txt')
        write(shared, OLD)
        linkSync(shared, join(space.sibling('hardlinked'), SCHEMA))
        write(join(space.sibling('api'), '.env.local'), OLD)
        for (const [reference, code, why] of [
            [`linked:${SCHEMA}`, 'ENV_SCHEMA_REPLACE_REFUSED', 'symbolic link'], [`hardlinked:${SCHEMA}`, 'ENV_SCHEMA_REPLACE_REFUSED', 'another hard link'],
            ['api:.env.local', 'ENV_SCHEMA_READ_REFUSED', 'named exactly'], [`api:untracked/${SCHEMA}`, 'ENV_SCHEMA_READ_REFUSED', 'not in a directory cockpit discovers'],
        ] as const) {
            const ran = await replacing(space, 'draft.txt', reference)
            expect(ran.status, reference).toBe(2)
            expect(`${ran.stdout}${ran.stderr}`, reference).toContain(code)
            expect(`${ran.stdout}${ran.stderr}`, reference).toContain(why)
            expect(`${ran.stdout}${ran.stderr}`, reference).not.toContain(SENTINEL)
        }
        expect(readFileSync(elsewhere, 'utf8')).toBe(OLD)
        expect(readFileSync(shared, 'utf8')).toBe(OLD)
        expect(readFileSync(join(space.sibling('api'), '.env.local'), 'utf8')).toBe(OLD)
    })
})
