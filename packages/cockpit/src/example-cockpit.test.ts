import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyMarkdownPath, repositoryMarkdownPaths, walkMarkdownProse } from '../../../scripts/docs-lint.mjs'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const launcher = join(repositoryRoot, 'packages/cockpit/bin/cockpit.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'cockpit-example-'))

const developer = { kind: 'human-only', reason: 'developer prerequisite in the source checkout' } as const
const sourceInstall = { kind: 'human-only', reason: 'source installation prerequisite' } as const
const operator = { kind: 'human-only', reason: 'operator input, approval, or estate state required' } as const
const runtime = { kind: 'human-only', reason: 'runtime or destructive environment operation' } as const
const executed = { kind: 'executed', reason: 'run by the synthetic example acceptance test' } as const
const DOCUMENTED_SHELL_BLOCKS = new Map<string, readonly (typeof developer | typeof sourceInstall | typeof operator | typeof runtime | typeof executed)[]>([
    ['CONTRIBUTING.md', [developer, developer, developer]],
    ['README.md', [sourceInstall, operator]],
    ['docs/adoption.md', [operator, operator, operator]],
    ['docs/contributing/style.md', [developer]],
    ['docs/environment.md', [runtime]],
    ['docs/getting-started.md', [sourceInstall, operator, operator, operator, operator, runtime, operator, operator, runtime]],
    ['docs/harness-surfaces.md', [operator]],
    ['docs/parallel-run.md', [operator, runtime, operator]],
    ['docs/contributing/releasing.md', [developer]],
    ['docs/release-policy.md', [operator]],
    ['docs/troubleshooting.md', [operator, operator, developer, developer]],
    ['docs/tutorial.md', [operator, operator, operator, operator, runtime]],
    ['examples/synthetic/README.md', [sourceInstall, executed, operator, executed, runtime]],
    ['examples/minimal/README.md', [executed]],
    ['examples/docs-only/README.md', [executed]],
    ['examples/compose-first/README.md', [executed]],
])

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function copyExample(name: string) {
    const root = join(scratch, name)
    cpSync(join(repositoryRoot, 'examples/synthetic'), root, { recursive: true })
    mkdirSync(join(root, 'repositories/app'), { recursive: true })
    mkdirSync(join(root, 'repositories/web'), { recursive: true })
    execFileSync('git', ['init', '--quiet', '--bare', join(root, 'repositories/synthetic-web.git')])
    mkdirSync(join(root, 'fixtures'), { recursive: true })
    writeFileSync(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    writeFileSync(join(root, 'repositories/app/.gitignore'), '.env\n')
    writeFileSync(join(root, 'repositories/app/package.json'), '{"name":"synthetic-app","version":"0.0.0","scripts":{"build":"node --check probe.mjs","test":"node --check probe.mjs"}}\n')
    writeFileSync(join(root, 'repositories/app/package-lock.json'), '{"name":"synthetic-app","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"synthetic-app","version":"0.0.0"}}}\n')
    writeFileSync(join(root, 'repositories/app/probe.mjs'), 'process.exitCode = 0\n')
    for (const directory of [root, join(root, 'repositories/app'), join(root, 'repositories/web')]) {
        execFileSync('git', ['init', '--quiet', directory])
    }
    execFileSync('git', ['-C', join(root, 'repositories/web'), 'remote', 'add', 'origin', 'synthetic-web.git'])
    execFileSync('git', ['-C', join(root, 'repositories/app'), 'add', '.gitignore', 'package.json', 'package-lock.json', 'probe.mjs'])
    execFileSync('git', ['-C', join(root, 'repositories/app'), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'synthetic fixture'])
    return root
}

function inventory(readme: string) {
    const blocks = [...readme.matchAll(/```sh ([^\n]+)\n([\s\S]*?)```/g)]
    const machineLocal = /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\.\.\/|\$HOME\b)/
    if (machineLocal.test(readme)) throw new Error('example commands depend on a machine-local path')
    if (blocks.some(([, marker]) => marker !== 'executable' && !marker?.startsWith('human-only:'))) {
        throw new Error('shell command block is not classified')
    }
    const classified = (classification: 'executable' | 'human-only') => blocks.flatMap(([, marker, body]) => {
        const kind = marker === 'executable' ? 'executable' : marker?.startsWith('human-only:') ? 'human-only' : 'unknown'
        if (kind !== classification) return []
        return body!.trim().split('\n').map(line => line.trim().split(/\s+/))
    })
    return { executable: classified('executable'), humanOnly: classified('human-only') }
}

function publicShellInventory(documents: ReadonlyMap<string, string>) {
    const blocks: Array<{ path: string; block: number; kind: string; reason: string }> = []
    for (const [path, body] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
        if (classifyMarkdownPath(path) !== 'human') continue
        const walked = walkMarkdownProse(path, body) as ReturnType<typeof walkMarkdownProse> & {
            readonly fences: readonly { readonly info: string }[]
        }
        const fences = walked.fences.filter(fence => /^(?:sh|bash|shell)(?:\s|$)/.test(fence.info))
        const policy = DOCUMENTED_SHELL_BLOCKS.get(path) ?? []
        const count = Math.max(fences.length, policy.length)
        for (let block = 0; block < count; block += 1) {
            const classification = policy[block]
            blocks.push({ path, block: block + 1, kind: fences[block] && classification ? classification.kind : 'unclassified',
                reason: fences[block] && classification ? classification.reason : 'shell block and classification table differ' })
        }
    }
    for (const path of DOCUMENTED_SHELL_BLOCKS.keys()) if (!documents.has(path)) {
        blocks.push({ path, block: 0, kind: 'unclassified', reason: 'classified public document is missing' })
    }
    return blocks
}

function run(root: string, argv: string[]) {
    const environment = join(scratch, '.environment', basename(root))
    mkdirSync(join(environment, 'home'), { recursive: true, mode: 0o700 })
    mkdirSync(join(environment, 'state'), { recursive: true, mode: 0o700 })
    const result = spawnSync(process.execPath, [launcher, ...argv.slice(1)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', HOME: join(environment, 'home'), XDG_STATE_HOME: join(environment, 'state') },
    })
    return { ...result, response: result.stdout ? JSON.parse(result.stdout) : undefined }
}

describe('the public synthetic cockpit', () => {
    it('executes every classified non-destructive command in the synthetic example README', () => {
        const root = copyExample('complete')
        const readme = readFileSync(join(root, 'README.md'), 'utf8')
        const { executable, humanOnly } = inventory(readme)

        expect(executable.map(argv => argv.slice(0, 2))).toEqual([
            ['cockpit', 'sync'], ['cockpit', 'sync'], ['cockpit', 'setup'], ['cockpit', 'check'],
        ])
        expect(humanOnly.map(argv => argv.slice(0, 2))).toEqual([
            ['mkdir', '-p'], ['printf', '\'[{"id":"synthetic"}]\\n\''],
            ['printf', '\'.env\\n\''],
            ['printf', '\'%s\\n\''], ['printf', '\'%s\\n\''], ['printf', '\'process.exitCode'],
            ['git', 'init'], ['git', 'init'], ['git', 'init'], ['git', 'init'],
            ['git', '-C'],
            ['git', '-C'], ['git', '-C'],
            ['git', '-C'], ['git', '-C'],
            ['cockpit', 'preflight'], ['cockpit', 'up'], ['cockpit', 'down'],
        ])
        for (const argv of executable) {
            if (argv[1] === 'setup') {
                const app = join(root, 'repositories/app')
                execFileSync('git', ['-C', app, 'add', '.env.example'])
                execFileSync('git', ['-C', app, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                    'commit', '--quiet', '-m', 'generated synthetic template'])
            }
            const result = run(root, argv)
            expect(result.status, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
            expect(result.stderr).toBe('')
            expect(result.response.invocation.exitCode).toBe(0)
        }
        expect(existsSync(join(root, '.cockpit/generated-environment-ownership.json'))).toBe(true)
        expect(existsSync(join(root, 'compose.generated.yml'))).toBe(true)
        expect(existsSync(join(root, 'repositories/app/.env'))).toBe(true)
        expect(existsSync(join(root, 'app/.env.example'))).toBe(false)
    })

    it('fails for a missing sibling and stale generated output', () => {
        const missing = copyExample('missing-sibling')
        expect(run(missing, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json']).status).toBe(0)
        execFileSync('git', ['-C', join(missing, 'repositories/app'), 'add', '.env.example'])
        execFileSync('git', ['-C', join(missing, 'repositories/app'), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '-m', 'generated synthetic template'])
        rmSync(join(missing, 'repositories/web'), { recursive: true })
        rmSync(join(missing, 'repositories/synthetic-web.git'), { recursive: true })
        const missingResult = run(missing, ['cockpit', 'setup', '--config', 'cockpit.toml', '--json'])
        expect(missingResult.status).toBe(2)
        const missingCodes = missingResult.response.diagnostics.map((row: { code: string }) => row.code)
        expect(missingCodes, JSON.stringify(missingCodes)).toContain('EXECUTION_STEP_FAILED')

        const stale = copyExample('stale')
        expect(run(stale, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json']).status).toBe(0)
        const generated = join(stale, '.agents/skills/bootstrap/SKILL.md')
        expect(existsSync(generated)).toBe(true)
        writeFileSync(generated, `${readFileSync(generated, 'utf8')}\nstale\n`)
        const staleResult = run(stale, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        expect(staleResult.status).toBe(2)
        expect(staleResult.response.diagnostics.map((row: { code: string }) => row.code)).toContain('SURFACE_STATE_CONFLICT')
    })

    it('renders a valid Compose file from the minimal example and reports its undecided subjects', () => {
        const root = join(scratch, 'minimal')
        cpSync(join(repositoryRoot, 'examples/minimal'), root, { recursive: true })
        execFileSync('git', ['init', '--quiet', root])
        const { executable } = inventory(readFileSync(join(root, 'README.md'), 'utf8'))
        expect(executable.map(argv => argv.slice(1, 2))).toEqual([['sync'], ['sync'], ['check']])
        const results = executable.map(argv => {
            const result = run(root, argv)
            expect(result.status, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
            return result
        })
        expect(results[0]!.response.result.changes).toContainEqual({ operation: 'write', path: 'compose.generated.yml' })
        const compose = readFileSync(join(root, 'compose.generated.yml'), 'utf8')
        expect(compose).toContain('    build:\n      context: api\n')
        const native = spawnSync('docker', ['compose', '-f', join(root, 'compose.generated.yml'), 'config', '-q'], { cwd: root, encoding: 'utf8' })
        if (native.error) {
            expect({ kind: 'unavailable', reason: (native.error as NodeJS.ErrnoException).code ?? 'native Compose did not return' }).toMatchObject({ kind: 'unavailable' })
        } else expect(native.status, native.stderr).toBe(0)
        expect(readFileSync(join(root, 'docs/cockpit/environment-decisions.md'), 'utf8')).toContain('## service:api\n\n- Status: **undecided**')
        const check = results[2]!.response
        expect(check.result.currentness.decisions).toEqual({
            path: 'docs/cockpit/environment-decisions.md', undecided: 2, subjects: ['port:api:http', 'service:api'],
        })
        expect(check.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'GENERATED_DECISIONS_UNDECIDED' }))
    })

    it('rejects undocumented or machine-local command dependencies', () => {
        const exampleRoot = join(repositoryRoot, 'examples/synthetic')
        const readme = readFileSync(join(exampleRoot, 'README.md'), 'utf8')
        const config = readFileSync(join(exampleRoot, 'cockpit.toml'), 'utf8')
        expect(() => inventory(readme)).not.toThrow()
        expect(() => inventory(`${readme}\n\`\`\`sh unknown\ncockpit doctor --config cockpit.toml\n\`\`\`\n`))
            .toThrow('shell command block is not classified')
        expect(() => inventory(readme.replace('cockpit.toml --json', '$HOME/cockpit.toml --json')))
            .toThrow('machine-local path')
        expect(config).toContain('source = "cockpit.overlay.toml"')
        expect(existsSync(join(exampleRoot, 'cockpit.overlay.toml'))).toBe(true)
        expect(dirname(join(exampleRoot, 'cockpit.toml'))).toBe(exampleRoot)
    })

    it('inventories every public shell block as executed or human-only with an owner reason', () => {
        const documents = new Map(repositoryMarkdownPaths(repositoryRoot)
            .map(path => [path, readFileSync(join(repositoryRoot, path), 'utf8')] as const))
        const classified = publicShellInventory(documents)
        expect(classified.filter(row => row.kind === 'unclassified')).toEqual([])
        expect(classified.filter(row => row.kind === 'executed')).toEqual([
            { path: 'examples/compose-first/README.md', block: 1, ...executed },
            { path: 'examples/docs-only/README.md', block: 1, ...executed },
            { path: 'examples/minimal/README.md', block: 1, ...executed },
            { path: 'examples/synthetic/README.md', block: 2, ...executed },
            { path: 'examples/synthetic/README.md', block: 4, ...executed },
        ])
        expect(classified.filter(row => row.kind === 'human-only').every(row => row.reason.length > 0)).toBe(true)

        const planted = new Map(documents)
        planted.set('docs/environment.md', `${planted.get('docs/environment.md')}\n\`\`\`sh\ncockpit unknown-command\n\`\`\`\n`)
        expect(publicShellInventory(planted).filter(row => row.kind === 'unclassified')).toContainEqual({
            path: 'docs/environment.md', block: 2, kind: 'unclassified', reason: 'shell block and classification table differ',
        })
    })
})

describe('cockpits without a generated environment', () => {
    function copyPlainExample(example: string, name: string) {
        const root = join(scratch, name)
        cpSync(join(repositoryRoot, 'examples', example), root, { recursive: true })
        execFileSync('git', ['init', '--quiet', root])
        return root
    }

    function syncedComposeFirst(name: string) {
        const root = copyPlainExample('compose-first', name)
        const sync = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
        expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0)
        return root
    }

    it('publishes and checks only the surfaces of a docs-only cockpit and refuses to run it', () => {
        const root = copyPlainExample('docs-only', 'docs-only')
        const { executable } = inventory(readFileSync(join(root, 'README.md'), 'utf8'))
        expect(executable.map(argv => argv[1])).toEqual(['sync', 'check', 'up'])
        const [sync, check, up] = executable.map(argv => run(root, argv))
        for (const result of [sync!, check!]) {
            expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
            expect(result.stderr).toBe('')
        }
        expect(existsSync(join(root, '.claude/skills/bootstrap/SKILL.md'))).toBe(true)
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
        expect(existsSync(join(root, 'env'))).toBe(false)
        expect(sync!.response.result.changes.map((change: { path: string }) => change.path)).not.toContain('compose.generated.yml')
        expect(up!.status).toBe(2)
        expect(up!.response.diagnostics).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' })])
        const doctor = run(root, ['cockpit', 'doctor', '--config', 'cockpit.toml', '--json'])
        expect(doctor.response.result.verdict).toBe('unavailable')
        expect(doctor.response.diagnostics).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' })])
        expect(doctor.response.result.declarations).toContainEqual(expect.objectContaining({ subject: 'runtime', state: 'not-declared' }))
    })

    it('owns the surfaces of a compose-first cockpit, leaves its Compose file alone and passes check', () => {
        const root = copyPlainExample('compose-first', 'compose-first')
        const compose = readFileSync(join(root, 'compose.yml'), 'utf8')
        const { executable } = inventory(readFileSync(join(root, 'README.md'), 'utf8'))
        expect(executable.map(argv => argv[1])).toEqual(['sync', 'check'])
        const [, check] = executable.map(argv => {
            const result = run(root, argv)
            expect(result.status, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
            return result
        })
        const ownership = JSON.parse(readFileSync(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8'))
        const owned = ownership.entries.map((entry: { path: string }) => entry.path)
        expect(owned).toContain('.claude/skills/bootstrap/SKILL.md')
        expect(owned).toContain('.cockpit/guards/bash-guard.sh')
        expect(owned.filter((path: string) => !path.startsWith('.') && !/^(?:AGENTS|CLAUDE)\.md$|^opencode\.jsonc$/.test(path))).toEqual([])
        expect(readFileSync(join(root, 'compose.yml'), 'utf8')).toBe(compose)
        expect(check!.response.diagnostics.filter((row: { code: string }) => row.code.startsWith('COMPOSE_'))).toEqual([])
    })

    it('fails check on a published host port that no ports.bases variable leases', () => {
        const root = syncedComposeFirst('compose-first-port')
        const path = join(root, 'compose.yml')
        writeFileSync(path, readFileSync(path, 'utf8').replace('"${WEB_HOST_PORT:-4300}:3000"', '"4300:3000"'))
        const check = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        expect(check.status).toBe(2)
        expect(check.response.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'error', code: 'COMPOSE_PORT_NOT_LEASED', target: 'compose:web:3000' }))
    })

    it('warns, without failing check, that a service with no healthcheck is ready once running', () => {
        const root = syncedComposeFirst('compose-first-health')
        const path = join(root, 'compose.yml')
        const [api, web] = readFileSync(path, 'utf8').split('  web:\n')
        writeFileSync(path, `${api}  web:\n${web!.slice(0, web!.indexOf('    healthcheck:'))}`)
        const check = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
        expect(check.response.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'warning', code: 'COMPOSE_HEALTHCHECK_MISSING', target: 'compose:web' }))
    })
})
