import { posix } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { evaluateGuard, GUARD_ROOT_PROTECTIONS } from './evaluator.js'
import { parseGuardInput } from './invocation-parser.js'
import { invocationCorpus, shellPayload } from './fixtures/invocation-corpus.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from '../environment/install-policy.js'

const root = '/workspace/project'
const other = '/workspace/other'
const instance = `${root}/config/active.instance`
// A search's evidence also lists the `.env*` and `.secrets` names below it; synthetic trees hold none.
const inspect = ({ path, cwd, operation }: { path: string; cwd: string; operation?: string }) => ({ status: 'resolved', path: posix.resolve(cwd, path), symlink: false, identity: null, ancestors: [],
    ...(operation === 'search' ? { sensitive: [] as string[] | null } : {}) })
// Identity facts for every protected path; synthetic tests name only the ones they exercise.
type IdentityFacts = Record<string, { identity: string | null; ancestors: string[] }>
function protectedIdentities(instances: readonly { path: string }[], known: IdentityFacts = {}) {
    return [...instances.map((item) => item.path), `${root}/cockpit.toml`, ...GUARD_ROOT_PROTECTIONS.map((item) => `${root}/${item.path}`)]
        .map((path) => ({ path, ...(known[path] ?? { identity: null, ancestors: [] }) }))
}
const candidate = (executable: string, argv: string[], cwd = root) => ({ executable, argv, cwd })
function policy() {
    return {
        canonicalRoot: root, configPath: `${root}/cockpit.toml`, allowedRoots: [root, other], instances: [{ name: 'active', path: instance }], templates: [] as string[], protectedIdentities: protectedIdentities([{ path: instance }]),
        protectedBranches: ['main', 'release/stable'], hostedDatabaseHosts: ['db.example.test', '*.database.example.test'], vendorHosts: ['api.vendor.example.test'],
        declaredAllows: [] as Array<{ argv: string[]; reason: string; cwd?: string }>,
        declaredDenies: [] as Array<{ match: 'prefix' | 'contains'; argv: string[]; reason: string; fix?: string }>,
        ripgrepConfigActive: false,
        executionDirectories: [] as string[],
        searchDirectories: [] as string[],
        searchPathRelativeEntry: null as string | null,
        secretFileIdentities: [] as string[] | null,
        protectedFilesLinked: false,
        cockpitInvocations: [candidate('/opt/cockpit/bin/cockpit', ['status']), candidate('/opt/cockpit/bin/cockpit', ['logs', 'web', '--lines', '20'])],
        cockpitLaunchers: [candidate('cockpit', [])],
        projectCommands: [
            { checkoutRoot: root, kind: 'test', executable: 'npm', argv: ['test'] },
            { checkoutRoot: other, kind: 'build', executable: 'npm', argv: ['run', 'build'] },
            // These synthetic exact profiles prove predicates without granting command families.
            ...['git push origin feature', 'git push origin main:refs/heads/feature', 'git push --push-option=main origin feature', 'printf main', 'printf ok', 'cat'].map((command) => {
                const [executable, ...argv] = command.split(' ')
                return { checkoutRoot: root, kind: 'test', executable, argv }
            }),
        ],
    }
}
function decide(command: string, configured = policy(), cwd = root) {
    return evaluateGuard(parseGuardInput(shellPayload(command, cwd)), configured, inspect)
}

describe('resolved guard evaluation', () => {
    it('applies declared deny and allow rules in precedence order to normalized invocations', () => {
        const configured = policy()
        configured.declaredAllows.push(
            { argv: ['make', 'verify'], reason: 'The repository verification target is safe.', cwd: root },
            { argv: ['printf'], reason: 'Synthetic output is safe.' },
            { argv: ['tool', '*'], reason: 'A literal star operand is safe.' },
        )
        configured.declaredDenies.push(
            { match: 'prefix', argv: ['make', 'release'], reason: 'Release changes shared state.', fix: 'Run make verify instead.' },
            { match: 'contains', argv: ['--environment', 'shared'], reason: 'Shared environments are human-operated.' },
        )

        expect(decide('make verify --unit', configured)).toEqual({ decision: 'allow', reason: 'The repository verification target is safe.' })
        expect(decide("tool '*'", configured)).toEqual({ decision: 'allow', reason: 'A literal star operand is safe.' })
        expect(decide('make verify --unit', configured, other).decision).toBe('ask')
        expect(decide('make release --environment local', configured)).toEqual({
            decision: 'deny', reason: 'Release changes shared state. Fix: Run make verify instead.',
        })
        expect(decide('tool deploy --environment shared --confirm', configured)).toEqual({
            decision: 'deny', reason: 'Shared environments are human-operated.',
        })
        expect(decide('timeout 30 make release', configured).decision).toBe('deny')
        expect(decide('env RELEASE_MODE=1 make release', configured).decision).toBe('deny')
        expect(decide('timeout 30 make verify', configured).decision).toBe('ask')
        expect(decide('printf db.example.test', configured).decision).toBe('deny')
        expect(decide('printf ok > /outside/result', configured).decision).toBe('unavailable')
    })

    it('matches every literal project tuple word while preserving exactness and hard denies', () => {
        for (const executable of ['npm', 'build tool', 'tool*?[];literal']) {
            const tuple = [executable, '*', '**', '?', '[', ']', 'file[1]?.txt']
            expect(GuardCommandArgv.safeParse(tuple).success).toBe(true)
            const rendered = renderGuardProjectCommand(tuple)
            if (rendered.kind !== 'complete') throw new Error(JSON.stringify(rendered))
            const configured = policy()
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable, argv: tuple.slice(1) })
            expect(decide(rendered.command, configured).decision, executable).toBe('allow')
            for (const changed of [[executable + 'x', ...tuple.slice(1)], [...tuple, 'extra'], [executable, '?', ...tuple.slice(2)]]) {
                const command = renderGuardProjectCommand(changed)
                if (command.kind !== 'complete') throw new Error(JSON.stringify(command))
                expect(decide(command.command, configured).decision).toBe('ask')
            }
            expect(decide(rendered.command, configured, other).decision).toBe('ask')
            expect(decide(`${rendered.command}; curl https://api.vendor.example.test`, configured).decision).toBe('deny')
            expect(decide(`${rendered.command}; git add '*.txt'`, configured).decision).toBe('unavailable')
        }
        for (const tuple of [['a'.repeat(129)], ['npm', '\x80'], ['npm', '\ud800'], Array(33).fill('x')]) {
            const configured = policy()
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: tuple[0]!, argv: tuple.slice(1) })
            expect(decide('npm test', configured).decision).toBe('unavailable')
        }
        const configured = policy()
        configured.cockpitInvocations.push(candidate('npm', ['*']))
        expect(decide('npm test', configured).decision).toBe('unavailable')
    })
    it.each(invocationCorpus)('refuses the executable $name candidate and permits its distinct control', (row) => {
        const configured = policy()
        const parsed = parseGuardInput(shellPayload(row.control))
        expect(parsed).toEqual({ status: 'parsed', tool: 'Bash', cwd: root, invocations: row.capture.control, paths: [], removed: [] })
        const refused = parseGuardInput(shellPayload(row.candidate))
        expect(refused).toEqual(typeof row.capture.candidate === 'string' ? { status: 'unavailable', reason: row.capture.candidate }
            : { status: 'parsed', tool: 'Bash', cwd: root, invocations: row.capture.candidate, paths: [], removed: [] })
        for (const item of row.capture.control) {
            if (item.executable) configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: item.executable, argv: [...item.argv] })
        }
        expect(decide(row.candidate, configured)).toEqual({ decision: row.decision, reason: row.cause })
        expect(decide(row.control, configured).decision).toBe('allow')
    })

    it('scans every invocation for hard denies before considering any grant or ask', () => {
        for (const command of ['npm test; curl https://db.example.test', 'curl https://api.vendor.example.test; npm test', 'git reset --hard; printf db.example.test', 'unknown; printf db.example.test', 'npm test | printf db.example.test']) {
            expect(decide(command).decision, command).toBe('deny')
        }
        const configured = policy()
        configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: 'printf', argv: ['db.example.test'] })
        expect(decide('printf db.example.test', configured).decision).toBe('deny')
    })

    it('matches configured hosts only in executed roles and at hostname boundaries', () => {
        for (const command of ['curl HTTPS://DB.EXAMPLE.TEST:443/path', 'curl https://db.example.test./', 'printf db.example.test', 'db.example.test', 'HOST=db.example.test npm test', 'env HOST=api.vendor.example.test npm test', 'printf tenant.database.example.test']) {
            expect(decide(command).decision, command).toBe('deny')
        }
        for (const command of ['printf ok > db.example.test', "cat <<'EOF'\ndb.example.test\nEOF", 'npm test # db.example.test', 'work() { curl db.example.test; }; npm test', "alias work='curl db.example.test'; npm test"]) {
            expect(decide(command).decision, command).toBe('allow')
        }
        for (const host of ['notdb.example.test', 'db.example.test.evil', 'other.example.test']) {
            expect(decide(`printf ${host}`).decision).toBe('ask')
        }
        // Resolvers apply compatibility normalisation, so fullwidth letters and ideographic dots name the same host.
        for (const command of ['curl http://db。example。test/', 'curl http://ｄｂ.example.test/', 'curl https://db．example．test', 'curl https://API.VENDOR｡EXAMPLE.TEST']) {
            expect(decide(command).decision, command).toBe('deny')
        }
    })

    it.each([
        { field: 'hostedDatabaseHosts', host: 'localhost', wildcard: false, reason: 'Refusing executable use of a declared hosted database host.' },
        { field: 'vendorHosts', host: 'vendor', wildcard: false, reason: 'Refusing executable use of a declared vendor host.' },
        { field: 'hostedDatabaseHosts', host: 'localhost', wildcard: true, reason: 'Refusing executable use of a declared hosted database host.' },
        { field: 'vendorHosts', host: 'vendor', wildcard: true, reason: 'Refusing executable use of a declared vendor host.' },
    ])('enforces separate single-label $field with wildcard=$wildcard', ({ field, host, wildcard, reason }) => {
        const configured = { ...policy(), [field]: [wildcard ? `*.${host}` : host] }
        for (const value of [host, `HTTPS://${host.toUpperCase()}:443/path`, ...(wildcard ? [`tenant.${host}`] : [])]) {
            expect(decide(`printf ${value}`, configured), value).toEqual({ decision: 'deny', reason })
        }
        expect(decide('npm test', configured).decision).toBe('allow')
        for (const value of [`not${host}`, `${host}.example.test`, ...(!wildcard ? [`tenant.${host}`] : [])]) {
            expect(decide(`printf ${value}`, configured).decision, value).toBe('ask')
        }
    })

    it.each(['hostedDatabaseHosts', 'vendorHosts'] as const)('enforces shared host bounds and normalized uniqueness for %s', (field) => {
        const exact = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
        const rows = Array.from({ length: 128 }, (_, i) => `host-${i}.example.test`)
        expect(decide('npm test', { ...policy(), hostedDatabaseHosts: rows, vendorHosts: rows }).decision).toBe('allow')
        for (const hosts of [[], [exact], [`*.${exact}`]]) {
            expect(decide('npm test', { ...policy(), [field]: hosts }).decision, JSON.stringify(hosts)).toBe('allow')
        }
        for (const hosts of [
            ['DB.example.test'], ['https://db.example.test'], ['db..example.test'],
            [`${'a'.repeat(64)}.test`], [`${exact}a`], [`*.${exact}a`],
            ['db.example.test', 'db.example.test'], ['db.example.test', '*.db.example.test'],
            ['*.db.example.test', 'db.example.test'], [...rows, 'extra.example.test'],
        ]) {
            expect(decide('npm test', { ...policy(), [field]: hosts }), JSON.stringify(hosts))
                .toEqual({ decision: 'unavailable', reason: 'Guard policy is incomplete or malformed.' })
        }
    })

    it('requires exact executable, cwd and complete argv for each profile', () => {
        expect(decide('/opt/cockpit/bin/cockpit status').decision).toBe('allow')
        expect(decide('/opt/cockpit/bin/cockpit logs web --lines 20').decision).toBe('allow')
        expect(decide('npm test').decision).toBe('allow')
        expect(decide('npm run build', policy(), other).decision).toBe('allow')
        for (const command of ['/opt/cockpit/bin/cockpit', '/opt/cockpit/bin/cockpit status extra', '/opt/cockpit/bin/cockpit status --unknown', '/opt/cockpit/bin/cockpit logs web --lines', 'cockpit status', '/tmp/cockpit status', 'npm test -- --extra', 'npm test-extra', 'npm', 'env npm test', 'timeout 60 npm test', 'PATH=/tmp npm test']) {
            expect(decide(command).decision, command).toBe('ask')
        }
        expect(decide('npm test', policy(), other).decision).toBe('ask')
        expect(decide('npm test', policy(), '/outside').decision).toBe('unavailable')
    })

    it('separates branch destinations from remotes, option values and source refs', () => {
        for (const command of ['git push origin main', 'git push origin HEAD:refs/heads/main', 'git push origin :main', 'git push --delete origin release/stable', 'git push --all origin', 'git push --mirror origin', "git push origin 'refs/heads/*:refs/heads/*' main", 'git push --unknown origin main']) {
            const configured = policy()
            const [executable, ...argv] = command.split(' ')
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable, argv })
            expect(decide(command, configured), command).toEqual({ decision: 'deny', reason: 'Refusing push to a declared protected branch.' })
        }
        for (const command of ['git push origin', 'git reset --hard', 'git clean -fd']) {
            const configured = policy()
            const [executable, ...argv] = command.split(' ')
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable, argv })
            expect(decide(command, configured).decision, command).toBe('ask')
        }
        for (const command of ['git push main feature', 'git push -o main origin feature', 'git push origin refs/heads/main:feature', 'git push origin main:refs/tags/main']) {
            const configured = policy()
            const [executable, ...argv] = command.split(' ')
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable, argv })
            expect(decide(command, configured).decision, command).toBe('allow')
        }
    })

    it.each(['HEAD', '@'])('holds exactly granted symbolic source-only push %s for approval', (source) => {
        const configured = policy()
        configured.cockpitInvocations.push(candidate('git', ['push', 'origin', source]))
        expect(decide(`git push origin ${source}`, configured)).toEqual({ decision: 'ask', reason: 'Push destination requires human approval.' })
    })

    it('holds unresolved source-only revisions across push forms without overriding protected destinations or explicit safe destinations', () => {
        for (const source of ['HEAD', '@', 'FETCH_HEAD', 'ORIG_HEAD', 'AUTO_MERGE', 'refs/remotes/origin/HEAD', 'heads/main', 'HEAD~1', 'feature^', 'feature^{commit}', '@{u}', 'feature@{1}', 'feature..main', 'deadbeef', 'v1-2-gdeadbeef']) {
            for (const prefix of ['', '+']) {
                const ref = prefix + source
                for (const args of [['push', 'origin'], ['push', '--repo=origin'], ['push', '--repo', 'origin'], ['-C', root, 'push', '--', 'origin']]) {
                    for (const suffix of [[ref], [ref, 'feature:refs/heads/main'], ['main', ref], [`${ref}:refs/heads/feature`]]) {
                        const argv = [...args, ...suffix]
                        const configured = policy()
                        configured.cockpitInvocations.push(candidate('git', argv))
                        const expected = suffix.length > 1 ? 'deny' : suffix[0].endsWith(':refs/heads/feature') ? 'allow' : 'ask'
                        expect(decide(`git ${argv.map((word) => `'${word}'`).join(' ')}`, configured).decision, JSON.stringify(argv)).toBe(expected)
                    }
                }
            }
        }
        for (const ref of ['feature', 'feature/topic', 'refs/heads/feature']) {
            const configured = policy()
            configured.cockpitInvocations.push(candidate('git', ['push', 'origin', ref]))
            expect(decide(`git push origin ${ref}`, configured).decision, ref).toBe('allow')
        }
    })

    it('witnesses symbolic source-only pushes resolving to main using local bare repositories and dry runs', () => {
        const directory = realpathSync(mkdtempSync(posix.join(tmpdir(), 'guard-push-')))
        try {
            const source = posix.join(directory, 'source.git')
            const remote = posix.join(directory, 'remote.git')
            const hooks = posix.join(directory, 'hooks')
            mkdirSync(hooks)
            const git = (cwd: string, argv: string[], input?: string) => {
                const result = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, ...argv], {
                    cwd, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536,
                    env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                        GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.test', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.test' },
                })
                expect(result.error).toBeUndefined()
                expect(result.status, result.stderr).toBe(0)
                return result.stdout.trim()
            }
            for (const path of [source, remote]) git(directory, ['init', '--bare', '--initial-branch=main', `--template=${hooks}`, path])
            const tree = git(source, ['hash-object', '-t', 'tree', '-w', '--stdin'], '')
            const commit = git(source, ['commit-tree', tree, '-m', 'Synthetic initial commit'])
            git(source, ['branch', 'main', commit])
            for (const ref of ['HEAD', '@', '+HEAD', '+@']) {
                expect(git(source, ['push', '--dry-run', '--porcelain', remote, ref])).toContain('*\tHEAD:refs/heads/main\t[new branch]')
            }
            expect(git(remote, ['for-each-ref', '--format=%(refname)'])).toBe('')
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('refuses unproven staging pathspecs before path inspection even with an exact grant', () => {
        for (const path of ['config/*', 'config/active.*', 'config/active.?nstance', 'config/[a]ctive.instance', ':(literal)config/active.instance', ':config/active.instance']) {
            const configured = policy()
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: 'git', argv: ['add', path] })
            const staged: string[] = []
            expect(evaluateGuard(parseGuardInput(shellPayload(`git add '${path}'`)), configured, (request) => {
                if (request.operation === 'stage') staged.push(request.path)
                return inspect(request)
            })).toEqual({ decision: 'unavailable', reason: 'Unproven Git staging pathspec grammar.' })
            expect(staged).toEqual([])
        }
        const configured = policy()
        configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: 'git', argv: ['add', 'config/template'] })
        expect(decide('git add config/template', configured).decision).toBe('allow')
        expect(decide("git add 'config/active.instance'", configured).decision).toBe('deny')
    })

    it('denies exact instance writes, moves, redirects and staged directories while permitting templates', () => {
        const payload = (tool_name: string, tool_input: object) => ({ hook_event_name: 'PreToolUse', tool_name, cwd: root, tool_input })
        for (const input of [
            payload('Write', { file_path: instance, content: 'value' }), payload('Edit', { file_path: instance, old_string: 'a', new_string: 'b' }),
            payload('Write', { file_path: `${root}/env/.secrets/project/api/resolver`, content: 'provider-reference' }),
            payload('apply_patch', { command: `*** Begin Patch\n*** Add File: ${instance}\n+value\n*** End Patch` }),
            payload('apply_patch', { command: `*** Begin Patch\n*** Update File: template\n*** Move to: ${instance}\n@@\n-a\n+b\n*** End Patch` }),
            shellPayload('git add config/active.instance'), shellPayload('git -C /workspace/project add config/active.instance'), shellPayload('git add .'), shellPayload('printf ok > config/active.instance'),
            shellPayload('printf ok > env/.secrets/project/api/resolver'), shellPayload('git add env/.secrets/project'),
        ]) expect(evaluateGuard(parseGuardInput(input), policy(), inspect).decision).toBe('deny')
        const noInstances = policy()
        noInstances.instances = []
        noInstances.protectedIdentities = protectedIdentities([])
        expect(evaluateGuard(parseGuardInput(shellPayload('git add -f env')), noInstances, inspect).decision).toBe('deny')
        expect(evaluateGuard(parseGuardInput(payload('Write', { file_path: 'config/template', content: 'value' })), policy(), inspect).decision).toBe('allow')
        expect(decide('git add config/template').decision).toBe('ask')
        expect(decide('git add --pathspec-from-file=list').decision).toBe('unavailable')
    })

    it('denies writes that would disable the guard while permitting neighbouring harness files', () => {
        const payload = (tool_name: string, tool_input: object) => ({ hook_event_name: 'PreToolUse', tool_name, cwd: root, tool_input })
        const refusal = { decision: 'deny', reason: 'Refusing mutation of the guard, its hook registration or its ownership manifest.' }
        for (const path of ['.cockpit/guards/bash-guard.sh', '.cockpit/generated-environment-ownership.json', '.claude/settings.json',
            '.claude/settings.local.json', '.mcp.json', '.codex/hooks.json', '.codex/config.toml',
            '.cursor/mcp.json', '.cursor/cli.json', '.grok/config.toml', 'opencode.json', 'opencode.jsonc',
            '.opencode/plugin/cockpit-guards.js', '.opencode/plugin/extra.js', '.opencode/plugins/rulesync-hooks.js',
            '.cockpit/bundles/claudecode-plugin/.mcp.json', '.cockpit/bundles/claudecode-plugin/hooks/hooks.json', '.Claude/Settings.json',
            '.cockpit/mcp/server.sh', '.cockpit/mcp/added.sh',
            // An unkeyed work-order record written by an agent would be accepted as the operator's.
            '.cockpit/work-orders/WO-001/current.json', '.cockpit/work-orders/WO-001/generation-00000001/completion.json',
            '.cockpit/transactions/pending.json', '.cockpit/actors/operator.json',
            'cockpit/adopted/.claude/settings.json', 'cockpit/adopted/.codex/hooks.json', 'cockpit/adopted/.codex/config.toml']) {
            for (const input of [
                payload('Write', { file_path: `${root}/${path}`, content: '{}' }), payload('Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
                payload('apply_patch', { command: `*** Begin Patch\n*** Update File: template\n*** Move to: ${path}\n@@\n-a\n+b\n*** End Patch` }),
                shellPayload(`printf ok > ${path}`),
            ]) expect(evaluateGuard(parseGuardInput(input), policy(), inspect), `${input.tool_name} ${path}`).toEqual(refusal)
        }
        for (const path of [`${other}/.claude/settings.json`, `${root}/.claude/agents/evaluator.md`, `${root}/.cockpit/guards/notes.md`, `${root}/.opencode/agents/reviewer.md`,
            `${root}/workorders/WO-001.md`]) {
            expect(evaluateGuard(parseGuardInput(payload('Write', { file_path: path, content: '{}' })), policy(), inspect).decision, path).toBe('allow')
        }
    })

    describe('protected identity', () => {
        const payload = (tool_name: string, tool_input: object) => ({ hook_event_name: 'PreToolUse', tool_name, cwd: root, tool_input })
        const env = `${root}/api/.env`
        const secrets = `${root}/env/.secrets`
        const control = `${root}/.codex/hooks.json`
        // Synthetic inodes for a case-insensitive volume: every spelling of an existing entry reports its identity.
        const known = {
            [env]: { identity: '1:30', ancestors: ['1:10', '1:20'] },
            [secrets]: { identity: '1:50', ancestors: ['1:10', '1:40'] },
            [control]: { identity: '1:70', ancestors: ['1:10', '1:60'] },
        }
        const configured = () => ({ ...policy(), instances: [{ name: 'api', path: env }], protectedIdentities: protectedIdentities([{ path: env }], known) })
        const volume = (facts: IdentityFacts) => (request: { path: string; cwd: string }) => {
            const path = posix.resolve(request.cwd, request.path)
            return { status: 'resolved', path, symlink: false, ...(facts[path] ?? { identity: null, ancestors: [] }) }
        }
        const writes = (path: string) => [
            payload('Write', { file_path: path, content: 'value' }), payload('Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
            payload('apply_patch', { command: `*** Begin Patch\n*** Add File: ${path}\n+value\n*** End Patch` }),
            payload('apply_patch', { command: `*** Begin Patch\n*** Update File: template\n*** Move to: ${path}\n@@\n-a\n+b\n*** End Patch` }),
            shellPayload(`npm test > ${path}`),
        ]

        it('denies case variants of an instance through every write channel whether or not the leaf exists yet', () => {
            for (const path of [`${root}/api/.ENV`, `${root}/API/.Env`]) {
                for (const facts of [{ [path]: known[env] }, {}] as IdentityFacts[]) {
                    for (const input of writes(path)) {
                        expect(evaluateGuard(parseGuardInput(input), configured(), volume(facts)), `${input.tool_name} ${path}`)
                            .toEqual({ decision: 'deny', reason: 'Refusing mutation or staging of a declared environment instance.' })
                    }
                }
            }
            for (const facts of [{ [`${root}/API`]: { identity: '1:20', ancestors: ['1:10'] } }, {}] as IdentityFacts[]) {
                const grant = configured()
                grant.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: 'git', argv: ['add', 'API'] })
                expect(evaluateGuard(parseGuardInput(shellPayload('git add API')), grant, volume(facts)).decision).toBe('deny')
            }
        })

        it('denies any spelling that shares the identity of an instance or guard control file', () => {
            const linked = `${root}/notes/registration.json`
            for (const [identity, reason] of [[known[env], 'Refusing mutation or staging of a declared environment instance.'],
                [known[control], 'Refusing mutation of the guard, its hook registration or its ownership manifest.']] as const) {
                for (const input of writes(linked)) {
                    expect(evaluateGuard(parseGuardInput(input), configured(), volume({ [linked]: identity })), `${input.tool_name}`).toEqual({ decision: 'deny', reason })
                }
            }
            // toLowerCase() leaves U+017F alone; the volume and the shared normalisation fold it to `s`.
            const variant = `${root}/.claude/\u017Fettings.json`
            for (const facts of [{ [variant]: { identity: '1:90', ancestors: ['1:10', '1:80'] } }, {}] as IdentityFacts[]) {
                expect(evaluateGuard(parseGuardInput(payload('Write', { file_path: variant, content: '{}' })), configured(), volume(facts)))
                    .toEqual({ decision: 'deny', reason: 'Refusing mutation of the guard, its hook registration or its ownership manifest.' })
            }
        })

        it('denies a not-yet-existing leaf inside the secrets root under a folded spelling or a shared ancestor identity', () => {
            const reason = 'Refusing mutation or staging below a secrets directory.'
            for (const path of [`${root}/env/.\u017Fecrets/project/new-resolver`, `${root}/ENV/.SECRETS/new-resolver`]) {
                for (const input of writes(path)) expect(evaluateGuard(parseGuardInput(input), configured(), volume({})), `${input.tool_name} ${path}`).toEqual({ decision: 'deny', reason })
            }
            const linked = `${root}/linked/new-resolver`
            for (const input of writes(linked)) {
                expect(evaluateGuard(parseGuardInput(input), configured(), volume({ [linked]: { identity: null, ancestors: ['1:10', '1:40', '1:50'] } })), `${input.tool_name}`)
                    .toEqual({ decision: 'deny', reason })
            }
        })

        it('permits an unprotected file whose name differs from an existing one only by case', () => {
            for (const path of [`${root}/config/Template`, `${root}/api/.ENV.example`, `${root}/notes/Hooks.json`]) {
                for (const input of writes(path)) {
                    expect(evaluateGuard(parseGuardInput(input), configured(), volume({ [path]: { identity: '1:95', ancestors: ['1:10', '1:20'] } })).decision, `${input.tool_name} ${path}`).toBe('allow')
                }
            }
        })

        it('refuses a policy or evidence that omits or malforms an identity', () => {
            const input = parseGuardInput(payload('Write', { file_path: `${root}/config/template`, content: 'value' }))
            const complete = configured()
            for (const protectedIdentities of [complete.protectedIdentities.slice(1), [...complete.protectedIdentities, complete.protectedIdentities[0]],
                complete.protectedIdentities.map((item, i) => i === 0 ? { ...item, identity: 'inode' } : item),
                complete.protectedIdentities.map((item, i) => i === 0 ? { ...item, ancestors: [7] } : item)]) {
                expect(evaluateGuard(input, { ...complete, protectedIdentities }, volume({})).decision).toBe('unavailable')
            }
            for (const evidence of [{ status: 'resolved', path: `${root}/config/template`, symlink: false },
                { status: 'resolved', path: `${root}/config/template`, symlink: false, identity: '1', ancestors: [] },
                { status: 'resolved', path: `${root}/config/template`, symlink: false, identity: null, ancestors: 'none' }]) {
                expect(evaluateGuard(input, complete, (request) => request.path === root ? volume({})(request) : evidence).decision).toBe('unavailable')
            }
        })
    })

    it('refuses missing, escaping, symlink or malformed path evidence and still finds later hard denies', () => {
        const input = parseGuardInput(shellPayload('npm test'))
        for (const evidence of [undefined, { status: 'resolved', path: '/outside', symlink: false }, { status: 'resolved', path: root, symlink: true }, { status: 'unavailable', reason: 'unreadable' }]) {
            expect(evaluateGuard(input, policy(), () => evidence).decision).toBe('unavailable')
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('npm test; printf db.example.test')), policy(), () => undefined).decision).toBe('deny')
        expect(evaluateGuard(input, policy(), () => { throw new Error('inspection failed') }).decision).toBe('unavailable')
    })

    it('requires a complete own-data policy and refuses family grants', () => {
        for (const bad of [undefined, {}, { ...policy(), vendorHosts: undefined }, { ...policy(), canonicalRoot: '/outside' }, { ...policy(), cockpitInvocations: [candidate('cockpit', ['*'])] }]) {
            expect(evaluateGuard(parseGuardInput(shellPayload('npm test')), bad, inspect).decision).toBe('unavailable')
        }
        let touched = false
        expect(evaluateGuard(parseGuardInput(shellPayload('npm test')), { get canonicalRoot() { touched = true; return root } }, inspect).decision).toBe('unavailable')
        expect(touched).toBe(false)
    })

    it('rejects reconstructed parser products and enforces the staging path budget', () => {
        const parsed = parseGuardInput(shellPayload('npm test'))
        expect(evaluateGuard(JSON.parse(JSON.stringify(parsed)), policy(), inspect).decision).toBe('unavailable')
        expect(decide(`git add ${Array.from({ length: 256 }, (_, i) => `file-${i}`).join(' ')}`).decision).toBe('ask')
        expect(decide(`git add ${Array.from({ length: 257 }, (_, i) => `file-${i}`).join(' ')}`).decision).toBe('unavailable')
    })

    it.each(invocationCorpus)('blocks execution of $name and proves its bypass and executable control', (row) => {
        const directory = realpathSync(mkdtempSync(posix.join(tmpdir(), 'guard-execution-')))
        try {
            const bin = posix.join(directory, 'bin')
            const log = posix.join(directory, 'calls.jsonl')
            mkdirSync(bin)
            mkdirSync(posix.join(directory, 'config'))
            writeFileSync(posix.join(directory, 'config/active.instance'), 'synthetic instance')
            writeFileSync(posix.join(directory, 'config/template'), 'synthetic template')
            const logger = `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');\nconst args = process.argv.slice(2); const name = path.basename(process.argv[1]);\nconst executable = name === 'record' ? args.shift() : name;\nfs.appendFileSync(process.env.GUARD_CALL_LOG, JSON.stringify({ executable, argv: args, cwd: process.cwd(), host: process.env.DB_URL ?? null }) + '\\n');\n`
            for (const name of ['record', 'git', 'curl']) writeFileSync(posix.join(bin, name), logger, { mode: 0o700 })
            const scripts = {
                timeout: 'while [ "$1" = -s ] || [ "$1" = -k ]; do shift 2; done\nshift\nexec "$@"',
                nice: '[ "$1" = -n ] && shift 2\nexec "$@"',
                setsid: '[ "$1" = --wait ] && shift\nexec "$@"',
                nohup: 'exec "$@"',
                env: 'if [ "$1" = -C ]; then cd "$2" || exit 1; shift 2; fi\nexec "$@"',
            }
            for (const [name, script] of Object.entries(scripts)) writeFileSync(posix.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o700 })
            const configured = policy()
            for (const item of row.capture.control) {
                if (item.executable) configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable: item.executable, argv: [...item.argv] })
            }
            const dispatch = (command: string, enforce: boolean) => {
                writeFileSync(log, '')
                const verdict = evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect)
                if (enforce && verdict.decision !== 'allow') return { dispatched: false, calls: [] }
                // Functions observe builtins without replacing their output or shell expansion semantics.
                const prelude = 'printf() { record printf "$@"; builtin printf "$@"; }\ncat() { record cat "$@"; command cat "$@"; }\n'
                const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-O', 'expand_aliases', '-c', prelude + command], {
                    cwd: directory, env: { PATH: `${bin}:/usr/bin:/bin`, GUARD_CALL_LOG: log }, encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536,
                })
                expect(result.error).toBeUndefined()
                expect(result.stderr).toBe('')
                expect(result.status).toBe(0)
                const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line))
                return { dispatched: true, calls }
            }
            expect(dispatch(row.candidate, true)).toEqual({ dispatched: false, calls: [] })
            const bypass = dispatch(row.candidate, false)
            expect(bypass.dispatched).toBe(true)
            expect(bypass.calls).toContainEqual({ executable: row.witness.executable, argv: row.witness.argv, cwd: posix.resolve(directory, posix.relative(root, row.witness.cwd)),
                host: row.witness.words.find((word) => word.role === 'environment-assignment-value')?.value ?? null })
            const control = dispatch(row.control, true)
            expect(control.dispatched).toBe(true)
            expect(control.calls).toEqual(row.capture.control.filter((item) => item.executable !== null).map((item) => ({
                executable: item.executable, argv: item.argv, cwd: directory, host: null,
            })))
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })
})

// Both checkout roots are Git repositories in these synthetic facts.
const withGit = (request: { path: string; cwd: string; operation?: string }) => {
    const resolved = posix.resolve(request.cwd, request.path)
    return { ...inspect(request), identity: [root, other].some((checkout) => resolved === `${checkout}/.git`) ? '9:1' : null }
}
const decideInRepositories = (command: string, cwd = root) => evaluateGuard(parseGuardInput(shellPayload(command, cwd)), policy(), withGit)

describe('built-in read-only profile', () => {
    it('asks before ripgrep when an ambient configuration can add hidden behavior', () => {
        const configured = policy()
        configured.ripgrepConfigActive = true
        expect(decide('rg needle src', configured).decision).toBe('ask')
        expect(decide('grep needle src', configured).decision).toBe('allow')
    })

    it('allows exact read-only inspection commands and pipelines of them without a prompt', () => {
        for (const command of ['ls', 'ls -la src', 'pwd', 'cat README.md', 'cat -n README.md', 'head -n 20 src/a.ts', 'head -5 src/a.ts', 'tail -n5 src/a.ts',
            'wc -l src/a.ts src/b.ts', 'rg needle src', "rg -i -g '!*.min.js' needle src", 'rg --files src', 'grep -rn needle src', 'grep needle src/a.ts',
            'fd name src', "find src -name '*.ts' -type f", 'git status', 'git diff --stat', 'git log --oneline -5', 'git show HEAD',
            'git branch', 'git branch --list', 'git -C ../other status', 'cockpit check', 'cockpit doctor --json', 'cockpit --help',
            'rg needle src | head -n 5', 'ls && pwd', 'grep --context=2 needle src/a.ts', 'git diff main -- src/a.ts']) {
            expect(decideInRepositories(command), command).toEqual({ decision: 'allow', reason: expect.any(String) })
        }
    })

    it('judges every launcher spelling by the one proof that it starts the installed cockpit', () => {
        // The application proves each spelling, with its exact launcher words, from one directory.
        const script = './node_modules/@b0dea/cockpit/bin/cockpit.mjs'
        const launched = () => ({ ...policy(), cockpitLaunchers: [candidate('cockpit', []), candidate('npx', ['--no', 'cockpit']),
            candidate('npx', ['--no', '--', 'cockpit']), candidate('./node_modules/.bin/cockpit', []), candidate('node', [script])] })
        const decideLaunched = (command: string, configured = launched(), cwd = root) => evaluateGuard(parseGuardInput(shellPayload(command, cwd)), configured, inspect)
        for (const command of ['cockpit check', 'npx --no cockpit doctor --config cockpit.toml', 'npx --no cockpit check --json', 'npx --no -- cockpit --help',
            'npx --no -- cockpit --version', 'npx --no cockpit session --help', 'npx --no cockpit work intake --help', './node_modules/.bin/cockpit check --config cockpit.toml', `node ${script} doctor`]) {
            expect(decideLaunched(command), command).toEqual({ decision: 'allow', reason: expect.any(String) })
            expect(decideLaunched(command, { ...launched(), cockpitLaunchers: [] }).decision, command).toBe('ask')
        }
        expect(decideLaunched('cockpit check', { ...launched(), cockpitLaunchers: [] }).reason).toContain('could not prove it starts the installed cockpit')
        for (const command of [
            // Without --no, npx may download a package; any other npx option picks another package, command or shell.
            'npx cockpit doctor', 'npx --yes cockpit doctor', 'npx --no --package other cockpit doctor', 'npx --no -p other cockpit doctor',
            'npx --no --call other cockpit doctor', 'npx --no -c other cockpit doctor', 'npx --no other doctor',
            // npx reads every option before the first operand after the package name as its own.
            'npx --no cockpit --script-shell=/bin/sh doctor', 'npx --no cockpit --help',
            // A proof covers its own script only, and node options run code before the script.
            'node ./other.mjs doctor', `node --require ./other.cjs ${script} doctor`,
            'npx --no cockpit sync --config cockpit.toml', './node_modules/.bin/cockpit sync --config cockpit.toml',
        ]) expect(decideLaunched(command).decision, command).not.toBe('allow')
        expect(decideLaunched('npx --no cockpit doctor', launched(), `${root}/src`).decision).toBe('ask')
        expect(decideLaunched('npx --no cockpit check --config env/.secrets/token').decision).toBe('deny')
        // The package name is not an operand naming the cockpit/ control directory, and an exact
        // profile under the npx spelling admits only where the spelling is proven.
        const admitted = launched()
        admitted.cockpitInvocations.push(candidate('npx', ['--no', 'cockpit', 'sync', '--config', 'cockpit.toml', '--dry-run']))
        expect(decideLaunched('npx --no cockpit sync --config cockpit.toml --dry-run', admitted).decision).toBe('allow')
        expect(decideLaunched('npx --no cockpit sync --config cockpit.toml --dry-run', { ...admitted, cockpitLaunchers: [] }))
            .toEqual({ decision: 'ask', reason: expect.stringContaining('npx --no cockpit counts only from the cockpit root') })
        // An admitted session is judged by its command, which runs as written with no shell.
        const session = (command: string[]) => {
            const configured = launched()
            configured.cockpitInvocations.push(candidate('npx', ['--no', 'cockpit', 'session', '--config', 'cockpit.toml', '--', ...command]))
            return decideLaunched(['npx --no cockpit session --config cockpit.toml --', ...command.map(word => `'${word}'`)].join(' '), configured).decision
        }
        expect(session(['cat', 'README.md'])).toBe('allow')
        expect(session(['cat', 'README.md;rm', 'src'])).toBe('allow')
        expect(session(['rm', '-rf', 'src'])).toBe('ask')
        expect(session(['sh', '-c', 'cat README.md'])).toBe('ask')
        expect(session(['cat', 'config/active.instance'])).toBe('deny')
        // A command that parses a named file can quote it back, so the file is checked as a read.
        const reading = (file: string) => {
            const configured = launched()
            const profile = { ...candidate('npx', ['--no', 'cockpit', 'work', 'intake', '--config', 'cockpit.toml', '--intent', file]), reads: [`${root}/${file}`] }
            configured.cockpitInvocations.push(profile)
            return decideLaunched(`npx --no cockpit work intake --config cockpit.toml --intent ${file}`, configured).decision
        }
        expect(reading('intents/task.json')).toBe('allow')
        expect(reading('.env')).toBe('ask')
        expect(reading('config/active.instance')).toBe('deny')
        expect(reading('env/.secrets/token')).toBe('deny')
        for (const malformed of [candidate('npx', ['--no']), candidate('npx', ['--no', 'cockpit'], '/outside'), candidate('sh', [])]) {
            expect(decideLaunched('npx --no cockpit doctor', { ...launched(), cockpitLaunchers: [malformed] }).decision).toBe('unavailable')
        }
    })

    it('treats redirects to the null device and standard streams as no file access', () => {
        for (const command of ['cat README.md 2>/dev/null', 'ls > /dev/null 2>&1', 'rg needle src 2>/dev/stderr', 'cat README.md >/dev/stdout', 'wc -l < /dev/null']) {
            expect(decideInRepositories(command), command).toEqual({ decision: 'allow', reason: expect.any(String) })
        }
        expect(decide('printf x 2>/dev/null').decision).toBe('ask')
        for (const command of ['cat README.md 2>/dev/tty', 'cat README.md > /tmp/out', 'cat README.md 2>/dev/null/x']) {
            expect(decideInRepositories(command).decision, command).toBe('unavailable')
        }
        expect(decideInRepositories('wc -l < /dev/zero').decision).toBe('ask')
    })

    it('runs read-only Git only where the directory has its own .git', () => {
        // A planted HEAD, objects, refs and config make any directory an implicit bare repository whose
        // configuration Git would honour; discovery prefers a root's own `.git`, which is not agent-writable.
        expect(decideInRepositories('git status', `${root}/planted`).decision).toBe('ask')
        expect(decideInRepositories('git -C planted status').decision).toBe('ask')
        expect(decide('git status').decision).toBe('ask')
        expect(decideInRepositories('git status').decision).toBe('allow')
    })

    it('falls back to a prompt for every shape outside the exact read-only table', () => {
        for (const command of [
            'git diff --no-index env/.secrets/token README.md',
            // Searches that widen past ignore rules; a glob that is not an exclusion re-includes hidden and ignored files.
            'rg --hidden needle src', 'rg -uu needle src', 'grep -R needle src', "rg -g '.env*' KEY src", "rg --glob='*.ts' needle src", "rg --iglob '*' needle src",
            // Options that run programs or write files.
            'rg --pre cat needle src', 'rg --pre=cat needle src', 'rg --hostname-bin cat needle src', 'rg -z needle src',
            'find src -exec cat src/a.ts ;', 'find src -delete', 'fd -x cat name src', 'fd --exec cat name src', 'tail -f src/a.ts',
            'git -c core.pager=cat log', 'git --git-dir=other log', 'git log --output=out.txt', 'git diff --output out.txt', 'git diff --ext-diff',
            'git show HEAD:config/active.instance', 'git branch topic', 'cockpit sync', 'cockpit check --unknown',
            'git diff --no-index src/a.ts README.md', 'git diff -- .env.local', 'grep -C 5 needle src/a.ts', 'grep -A x needle src/a.ts',
            // Undeclared environment files, paths outside the roots, writes, wrappers and mixed chains.
            'cat .env.local', 'cat /etc/hosts', 'ls /tmp', 'cat src/a.ts > copy.txt', 'env ls', 'LANG=C ls', 'LS', 'ls; touch src/a.ts',
        ]) {
            expect(decideInRepositories(command).decision, command).toBe('ask')
        }
        // A declared template documents the instance's variables, so it is data, not an unknown `.env*` file.
        const templated = { ...policy(), templates: [`${root}/.env.example`, `${other}/.env.example`] }
        for (const command of ['cat .env.example', 'head -n 5 ../other/.env.example', 'grep KEY .ENV.EXAMPLE']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), templated, withGit).decision, command).toBe('allow')
        }
        for (const command of ['cat .env.local', 'cat ../other/.env.local', 'cat .env.example.local']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), templated, withGit).decision, command).toBe('ask')
        }
    })

    it('lets a recursive search through only when no protected path can exist below it', () => {
        // Nothing protected exists yet, so a search of the whole root reads no secret.
        for (const command of ['rg needle', 'grep -r needle .', "grep -r -e 'needle' -- '.'", 'rg needle ../other']) {
            expect(decideInRepositories(command), command).toEqual({ decision: 'allow', reason: expect.any(String) })
        }
        const present = (path: string) => ({ ...policy(), protectedIdentities: protectedIdentities([{ path: instance }], { [path]: { identity: '7:9', ancestors: [] } }) })
        expect(evaluateGuard(parseGuardInput(shellPayload('rg needle')), present(instance), withGit)).toEqual({ decision: 'ask',
            reason: 'A recursive search of . would read config/active.instance, a declared environment instance or secrets directory. Search a path that does not contain it.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('grep -r needle ..', `${root}/src`)), present(`${root}/env/.secrets`), withGit).reason)
            .toBe('A recursive search of .. would read ../env/.secrets, a declared environment instance or secrets directory. Search a path that does not contain it.')
        expect(evaluateGuard(parseGuardInput(shellPayload('rg needle src')), present(instance), withGit).decision).toBe('allow')
        // Another command in the same call could write an instance or an environment file before the
        // search reads it, as `vercel env pull .env.local && rg KEY .` would, wherever the search is rooted.
        for (const command of ['npm test && rg needle', 'npm test && rg needle src']) {
            expect(decideInRepositories(command), command).toEqual({ decision: 'ask',
                reason: `A recursive search of ${command.endsWith('src') ? 'src' : '.'} could read an environment file or secrets directory that another command in this call creates first. Run the search on its own.` })
        }
        expect(decideInRepositories('rg needle src | head -n 5').decision).toBe('allow')
        // Any environment file or secrets directory the walk finds below the tree is unproven, wherever it sits.
        const walked = (found: string[] | null, templates: string[] = []) => (command: string, cwd = root) => evaluateGuard(parseGuardInput(shellPayload(command, cwd)),
            { ...policy(), templates }, (request: { path: string; cwd: string; operation?: string }) => ({ ...withGit(request),
                ...(request.operation === 'search' ? { sensitive: found && found.filter((path) => path.startsWith(posix.resolve(request.cwd, request.path))) } : {}) }))
        const local = walked([`${other}/.env.local`, `${root}/packages/web/.secrets`])
        expect(local('grep -rn API_KEY ..', `${root}/src`)).toEqual({ decision: 'ask',
            reason: 'A recursive search of .. would read ../packages/web/.secrets, an environment file or secrets directory that is not a declared template. Search a path that does not contain it.' })
        expect(local('grep -r KEY ../other')).toEqual({ decision: 'ask',
            reason: 'A recursive search of ../other would read ../other/.env.local, an environment file or secrets directory that is not a declared template. Search a path that does not contain it.' })
        expect(local('grep -r KEY ../other/.env.local').decision).toBe('ask')
        expect(local('rg needle src').decision).toBe('allow')
        expect(walked([`${root}/.env.example`], [`${root}/.env.example`])('grep -rn KEY .').decision).toBe('allow')
        expect(walked(null)('rg needle src')).toEqual({ decision: 'ask',
            reason: 'A recursive search of src covers more than the guard walks to prove it reads no environment file or secrets directory. Search a narrower path.' })
    })

    it('keeps reads of declared instances and secrets a hard denial under every spelling', () => {
        for (const command of ['cat config/active.instance', 'cat CONFIG/ACTIVE.INSTANCE', 'cat ./config/../config/active.instance',
            'head env/.secrets/token', 'wc -c < config/active.instance', 'grep needle config/active.instance',
            'rg -f config/active.instance needle src', 'grep --color needle config/active.instance', 'ls && cat config/active.instance',
            "grep --context '' env/.secrets/token", 'git log -p -- config/active.instance', 'git diff HEAD env/.secrets/token', 'cockpit check --config env/.secrets/token',
            // A recursive search rooted at or below a secrets directory reads it as surely as cat does.
            'rg . env/.secrets/token', 'grep -r . env/.secrets/token', 'rg . env/.secrets/project', 'rg -l . env/.secrets/project/',
            'grep -rn . env/.secrets/', 'rg . env/.SECRETS/token', 'rg . ../other/.secrets', 'rg needle config/active.instance',
            // A case-insensitive volume resolves a folded spelling of the checkout itself to the instance.
            'cat ../PROJECT/config/active.instance', 'rg . ../Project/env/.secrets']) {
            expect(decideInRepositories(command), command).toEqual({ decision: 'deny', reason: 'Refusing to read a declared environment instance or secrets directory into the agent context.' })
        }
        // A hard link carries the instance's identity under a spelling no normalisation equates.
        const linked = policy()
        linked.protectedIdentities = protectedIdentities([{ path: instance }], { [instance]: { identity: '7:9', ancestors: ['7:1', '7:2'] } })
        const facts = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            return { status: 'resolved', path: resolved, symlink: false, identity: resolved.endsWith('/notes.txt') ? '7:9' : null, ancestors: [] }
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('cat notes.txt')), linked, facts).decision).toBe('deny')
        // A symlink is never evidence of what is read, so it is not read-only.
        const symlinked = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            return resolved.endsWith('/link') ? { status: 'resolved', path: resolved, symlink: true } : inspect({ path, cwd })
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('cat link')), policy(), symlinked).decision).toBe('ask')
    })

    it('denies direct writes to Git metadata, whose configuration chooses what read-only Git runs', () => {
        for (const command of ['printf x > .git/config', 'printf x > .GIT/Config', 'printf x > ../other/.git/hooks/fsmonitor']) {
            expect(decide(command).reason, command).toBe('Refusing direct mutation of Git metadata: its configuration chooses programs that read-only Git commands run.')
        }
        expect(evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: '.git/config', content: '[core]' } }), policy(), inspect).decision).toBe('deny')
        expect(evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: '.gitignore', content: 'x' } }), policy(), inspect).decision).toBe('allow')
        // `git config` writes the same configuration, and a global value reaches every repository.
        const granted = policy()
        granted.declaredAllows.push({ argv: ['git', 'config'], reason: 'Repository configuration is declared safe.' })
        for (const command of ['git config core.hooksPath /tmp', 'git config --global core.pager cat', 'git config --add core.fsmonitor x',
            'git config --unset core.pager', 'git config --replace-all core.pager cat', 'git config -e', 'git config set core.pager cat',
            'git config --file .git/config core.pager cat', 'git -C ../other config core.fsmonitor x', 'git config --unknown core.pager']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), granted, inspect).reason, command)
                .toBe('Refusing direct mutation of Git metadata: its configuration chooses programs that read-only Git commands run.')
        }
        for (const command of ['git config --get core.pager', 'git config core.pager', 'git config --list', 'git config -l --show-origin',
            'git config get core.pager', 'git config list', 'git config --global --get user.name', 'git config --get-regexp ^core']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), granted, inspect).decision, command).toBe('allow')
        }
    })
})

describe('cockpit structure protection', () => {
    const removal = 'Refusing to delete, rename, truncate, relink or make unreadable cockpit.toml or .cockpit/generated-environment-ownership.json: every later guarded call reads them, so losing either holds the agent until a human restores it. Edit cockpit.toml in place instead.'
    const controlRemoval = 'Refusing mutation of the guard, its hook registration or its ownership manifest.'
    const protectedRead = 'Refusing to read a declared environment instance or secrets directory into the agent context.'
    const instanceMutation = 'Refusing mutation or staging of a declared environment instance.'
    const secretMutation = 'Refusing mutation or staging below a secrets directory.'
    const patch = (body: string) => evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: root,
        tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } }), policy(), inspect)

    it('denies deleting, renaming or truncating the configuration or the ownership manifest', () => {
        for (const command of ['rm cockpit.toml', 'rm -f ./cockpit.toml', 'unlink COCKPIT.TOML', 'mv cockpit.toml old.toml', 'mv -t archive cockpit.toml',
            'git rm cockpit.toml', 'git rm --cached cockpit.toml', 'git mv cockpit.toml old.toml', 'rm .cockpit/generated-environment-ownership.json',
            'rm -rf .cockpit', 'rm -rf .', 'rm -rf ../project', 'find . -delete', 'printf x > cockpit.toml', 'npm test; rm cockpit.toml']) {
            expect(decide(command), command).toEqual({ decision: 'deny', reason: removal })
        }
        expect(patch('*** Delete File: cockpit.toml')).toEqual({ decision: 'deny', reason: removal })
        expect(patch('*** Update File: cockpit.toml\n*** Move to: old.toml\n@@\n-a\n+b')).toEqual({ decision: 'deny', reason: removal })
        const empty = (path: string) => evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: path, content: '' } }), policy(), inspect)
        for (const path of ['cockpit.toml', `${root}/COCKPIT.TOML`]) expect(empty(path), path).toEqual({ decision: 'deny', reason: removal })
        expect(empty('.cockpit/generated-environment-ownership.json').decision).toBe('deny')
        for (const command of [
            'truncate -s 0 cockpit.toml', 'truncate --size 0 ./COCKPIT.TOML', 'truncate --size=0 subdir/../cockpit.toml',
            `truncate -s0 ${root}/cockpit.toml`, 'truncate -s=0 cockpit.toml', 'truncate -c -s 0 -- cockpit.toml', 'truncate -cs0 cockpit.toml',
            'truncate --no-create --size=0 cockpit.toml', 'truncate -o -s 0 cockpit.toml', 'truncate --io-blocks --size=0 cockpit.toml',
            'truncate -r reference cockpit.toml', 'truncate -rreference cockpit.toml', 'truncate --reference reference cockpit.toml', 'truncate --reference=reference cockpit.toml',
            '/usr/bin/truncate -s 0 cockpit.toml', 'truncate -s 0 .cockpit/generated-environment-ownership.json',
            'dd count=0 of=cockpit.toml', 'dd if=source.txt of=cockpit.toml', 'dd of=./COCKPIT.TOML conv=sync',
            'dd of=notes.txt of=cockpit.toml', 'dd of=cockpit.toml of=notes.txt', 'dd seek=1 of=cockpit.toml',
            'dd oflag=append of=cockpit.toml', 'dd conv=notruncate of=cockpit.toml',
            '/bin/dd of=subdir/../cockpit.toml', 'dd count=0 of=.cockpit/generated-environment-ownership.json',
            'tee cockpit.toml', 'tee -i ./COCKPIT.TOML', 'tee -- cockpit.toml -a',
            'tee --output-error=warn cockpit.toml', 'tee cockpit.toml -a', '/usr/bin/tee subdir/../cockpit.toml',
            'tee .cockpit/generated-environment-ownership.json',
            // A link or an unreadable mode loses the configuration as surely as deleting it.
            'ln -sf notes.txt cockpit.toml', 'ln -f notes.txt ./COCKPIT.TOML', 'ln -s -f -- notes.txt cockpit.toml', 'ln -sft . notes/cockpit.toml',
            'chmod 000 cockpit.toml', 'chmod 0200 cockpit.toml', 'chmod u-r cockpit.toml', 'chmod a= cockpit.toml', 'chmod go+r,u-rw cockpit.toml',
            'chmod --reference=notes.txt cockpit.toml', 'chmod 000 .cockpit/generated-environment-ownership.json',
        ]) {
            const configured = policy()
            const [executable, ...argv] = command.split(' ')
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable, argv })
            expect.soft(decide(command, configured), command).toEqual({ decision: 'deny', reason: removal })
        }
        for (const command of ['dd of=../cockpit.toml', 'tee ../cockpit.toml']) {
            const nested = policy()
            nested.declaredAllows.push({ argv: command.split(' '), cwd: `${root}/subdir`, reason: 'Repository writes are declared safe.' })
            expect(decide(command, nested, `${root}/subdir`), command).toEqual({ decision: 'deny', reason: removal })
        }
        const nested = policy()
        nested.declaredAllows.push({ argv: ['truncate', '-s', '0', '../cockpit.toml'], cwd: `${root}/subdir`, reason: 'Repository file resizing is declared safe.' })
        expect(decide('truncate -s 0 ../cockpit.toml', nested, `${root}/subdir`)).toEqual({ decision: 'deny', reason: removal })
        // The same identity under another spelling, such as a hard link, is the same file.
        const linked = policy()
        linked.protectedIdentities = protectedIdentities([{ path: instance }], { [`${root}/cockpit.toml`]: { identity: '7:5', ancestors: ['7:1'] } })
        const facts = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            return { status: 'resolved', path: resolved, symlink: false,
                identity: resolved.endsWith('/alias.toml') ? '7:5' : resolved.endsWith('/archive') ? '7:1' : null, ancestors: [] }
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('rm alias.toml')), linked, facts)).toEqual({ decision: 'deny', reason: removal })
        for (const command of ['truncate -s 0 alias.toml', 'truncate -s 0 archive', 'dd of=alias.toml', 'tee alias.toml']) {
            linked.declaredAllows.push({ argv: command.split(' '), reason: 'Repository file resizing is declared safe.' })
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), linked, facts), command).toEqual({ decision: 'deny', reason: removal })
        }
    })

    it('denies removal of every guard control file and directory despite declared command grants', () => {
        for (const protection of GUARD_ROOT_PROTECTIONS.filter(({ path }) => path !== 'env/.secrets')) {
            const target = protection.type === 'directory' ? `${protection.path}/installed-control` : protection.path
            const configured = policy()
            configured.declaredAllows.push({ argv: ['rm'], reason: 'Repository cleanup is declared safe.' })
            expect(evaluateGuard(parseGuardInput(shellPayload(`rm -rf ${target}`)), configured, inspect), target)
                .toEqual({ decision: 'deny', reason: protection.path === '.cockpit/generated-environment-ownership.json' ? removal : controlRemoval })
        }
    })

    it('denies removal through command and patch forms, case variants and containing directories', () => {
        const commands = [
            'rm .codex/hooks.json', 'git rm .claude/settings.json', 'mv opencode.json archived.json', 'find .codex -delete',
            'rm -rf .claude', 'rm -rf .opencode/plugin/installed-control', 'rm -rf cockpit/adopted', 'unlink .CODEX/HOOKS.JSON',
        ]
        for (const command of commands) {
            const configured = policy()
            configured.declaredAllows.push({ argv: [command.split(' ')[0]!], reason: 'Repository cleanup is declared safe.' })
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({ decision: 'deny', reason: controlRemoval })
        }
        expect(patch('*** Delete File: .mcp.json')).toEqual({ decision: 'deny', reason: controlRemoval })
    })

    it('denies visible writer destinations before declared command grants', () => {
        const commands = [
            'cp replacement .codex/hooks.json', 'cp replacement .CODEX/HOOKS.JSON', 'cp hooks.json .codex',
            'cp -t .codex hooks.json', 'cp --target-directory=.codex hooks.json', 'cp --target-directory .codex hooks.json',
            'install replacement .claude/settings.json', 'install -m 644 replacement .claude/settings.json',
            'install -t .claude settings.json', 'tee .mcp.json', 'tee -a .cursor/mcp.json',
            'mv replacement opencode.json', 'mv -t .grok config.toml', 'git mv replacement .grok/config.toml',
            'dd if=replacement of=.codex/hooks.json', 'touch .claude/settings.json',
            'truncate -s 0 .codex/config.toml', 'chmod 600 opencode.json',
        ]
        for (const command of commands) {
            const configured = policy()
            configured.declaredAllows.push({ argv: [command.split(' ')[0]!], reason: 'Repository file writing is declared safe.' })
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({ decision: 'deny', reason: controlRemoval })
        }
        const configured = policy()
        configured.declaredAllows.push({ argv: ['cp'], reason: 'Repository file writing is declared safe.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('cp --parents src/file archive')), configured, inspect)).toEqual({
            decision: 'unavailable', reason: 'Unsupported visible writer option.',
        })
    })

    it('resolves git mv destinations from the git execution directory', () => {
        const configured = policy()
        configured.declaredAllows.push({ argv: ['git'], reason: 'Repository moves are declared safe.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('git -C .codex mv -f ../README.md hooks.json')), configured, inspect)).toEqual({
            decision: 'deny', reason: controlRemoval,
        })
        expect(evaluateGuard(parseGuardInput(shellPayload('git -C docs mv old.md new.md')), configured, inspect)).toEqual({
            decision: 'allow', reason: 'Repository moves are declared safe.',
        })
    })

    it('resolves Git archive outputs and fallback operands from the Git execution directory', () => {
        const configured = policy()
        configured.declaredAllows.push({
            argv: ['git', '-C', 'subdir', 'archive'],
            reason: 'Repository archive creation is declared safe.',
        })
        const outputArgs = (destination: string) => [
            ...['o', 'ou', 'out', 'outp', 'outpu', 'output']
                .flatMap(option => [`--${option}=${destination}`, `--${option} ${destination}`]),
            `-o ${destination}`,
            `-o${destination}`,
            `-vo ${destination}`,
            `-vo${destination}`,
        ]
        for (const [destination, reason] of [
            ['../cockpit.toml', removal],
            ['../.codex/config.toml', controlRemoval],
            ['../config/active.instance', instanceMutation],
            ['../env/.secrets/token', secretMutation],
        ] as const) {
            for (const args of outputArgs(destination)) {
                const command = `git -C subdir archive ${args} HEAD`
                expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                    decision: 'deny', reason,
                })
            }
        }
        for (const args of outputArgs('../release.tar')) {
            const command = `git -C subdir archive ${args} HEAD`
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'allow', reason: 'Repository archive creation is declared safe.',
            })
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('git -C subdir archive HEAD ../.codex/config.toml')), configured, inspect)).toEqual({
            decision: 'unavailable', reason: 'Invocation names a guard control but its filesystem effect is not classified.',
        })
        expect(evaluateGuard(parseGuardInput(shellPayload('git -C subdir archive HEAD ../release.tar')), configured, inspect)).toEqual({
            decision: 'allow', reason: 'Repository archive creation is declared safe.',
        })
        for (const command of [
            'git -C subdir archive --format=tar --prefix=source/ --worktree-attributes -v HEAD docs',
            'git -C subdir archive --prefix -o../cockpit.toml HEAD',
        ]) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'allow', reason: 'Repository archive creation is declared safe.',
            })
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('git -C subdir archive --future-output=../release.tar HEAD')), configured, inspect)).toEqual({
            decision: 'unavailable', reason: 'Unsupported visible writer option.',
        })
    })

    it('denies a visible writer destination that shares a guard control identity', () => {
        const control = `${root}/.codex/hooks.json`
        const alias = `${root}/notes/registration.json`
        const directoryAlias = `${root}/notes/codex-copy`
        const linked = policy()
        linked.protectedIdentities = protectedIdentities([{ path: instance }], { [control]: { identity: '7:8', ancestors: ['7:1', '7:2'] } })
        linked.declaredAllows.push({ argv: ['cp'], reason: 'Repository file writing is declared safe.' })
        const facts = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            return { status: 'resolved', path: resolved, symlink: false,
                identity: resolved === alias ? '7:8' : resolved === directoryAlias ? '7:2' : null, ancestors: [] }
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('cp replacement notes/registration.json')), linked, facts)).toEqual({ decision: 'deny', reason: controlRemoval })
        expect(evaluateGuard(parseGuardInput(shellPayload('cp -t notes/codex-copy hooks.json')), linked, facts)).toEqual({ decision: 'deny', reason: controlRemoval })
        linked.declaredAllows.push({ argv: ['custom-mutator'], reason: 'The custom mutator is declared safe.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('custom-mutator notes/registration.json')), linked, facts)).toEqual({
            decision: 'unavailable', reason: 'Invocation names a guard control but its filesystem effect is not classified.',
        })
        linked.declaredAllows.push({ argv: ['tar'], reason: 'Repository archive extraction is declared safe.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('tar -xf payload.tar -C notes/codex-copy')), linked, facts)).toEqual({
            decision: 'deny', reason: controlRemoval,
        })
    })

    it('does not let command grants authorize visible control operands or extraction destinations', () => {
        const configured = policy()
        configured.declaredAllows.push({ argv: ['custom-mutator'], reason: 'The custom mutator is declared safe.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('custom-mutator .cursor/cli.json')), configured, inspect)).toEqual({
            decision: 'unavailable', reason: 'Invocation names a guard control but its filesystem effect is not classified.',
        })
        configured.declaredAllows.push({ argv: ['tar'], reason: 'Repository archive extraction is declared safe.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('tar -xf payload.tar')), configured, inspect)).toEqual({
            decision: 'deny', reason: controlRemoval,
        })
        expect(evaluateGuard(parseGuardInput(shellPayload('tar -xf payload.tar -C .codex')), configured, inspect)).toEqual({
            decision: 'deny', reason: controlRemoval,
        })
        for (const command of ['tar -xf payload.tar -C archive', 'tar -x -f payload.tar --directory archive',
            'tar --extract --file=payload.tar --directory=archive', 'tar --get --file payload.tar -C archive']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'allow', reason: 'Repository archive extraction is declared safe.',
            })
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('tar -xvf payload.tar -C archive')), configured, inspect)).toEqual({
            decision: 'unavailable', reason: 'Unsupported visible writer option.',
        })
        for (const command of ['tar xf payload.tar', 'tar --extr -f payload.tar']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'unavailable', reason: 'Unsupported visible writer option.',
            })
        }
    })

    it('denies protected sources of bounded writers before declared command grants', () => {
        const configured = policy()
        for (const executable of ['cp', 'install', 'dd', 'tar']) {
            configured.declaredAllows.push({ argv: [executable], reason: 'Repository file writing is declared safe.' })
        }
        for (const command of ['cp config/active.instance copy.txt', 'install config/active.instance copy.txt',
            'dd if=config/active.instance of=copy.txt', 'tar -xf config/active.instance -C archive']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'deny', reason: protectedRead,
            })
        }
        for (const command of ['cp source.txt copy.txt', 'install source.txt copy.txt', 'dd if=source.txt of=copy.txt']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect).decision, command).toBe('allow')
        }

        const linked = policy()
        linked.protectedIdentities = protectedIdentities([{ path: instance }], { [instance]: { identity: '7:8', ancestors: ['7:1'] } })
        linked.declaredAllows.push({ argv: ['cp'], reason: 'Repository file writing is declared safe.' })
        const facts = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            return { status: 'resolved', path: resolved, symlink: false,
                identity: resolved === `${root}/notes/source.instance` ? '7:8' : null, ancestors: [] }
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('cp notes/source.instance copy.txt')), linked, facts)).toEqual({
            decision: 'deny', reason: protectedRead,
        })
    })

    it('denies removing identity aliases of a control, its ancestor or its protected directory subtree', () => {
        const control = `${root}/.codex/hooks.json`
        const directory = `${root}/.opencode/plugin`
        const linked = policy()
        linked.protectedIdentities = protectedIdentities([{ path: instance }], {
            [control]: { identity: '7:8', ancestors: ['7:1', '7:2'] },
            [directory]: { identity: '7:4', ancestors: ['7:1', '7:3'] },
        })
        linked.declaredAllows.push({ argv: ['rm'], reason: 'Repository cleanup is declared safe.' })
        const facts = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            const aliases: IdentityFacts = {
                [`${root}/notes/registration.json`]: { identity: '7:8', ancestors: [] },
                [`${root}/notes/codex-copy`]: { identity: '7:2', ancestors: [] },
                [`${root}/notes/plugin/control.js`]: { identity: null, ancestors: ['7:4'] },
            }
            return { status: 'resolved', path: resolved, symlink: false, ...(aliases[resolved] ?? { identity: null, ancestors: [] }) }
        }
        for (const command of ['rm notes/registration.json', 'rm -rf notes/codex-copy', 'rm notes/plugin/control.js']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), linked, facts), command).toEqual({ decision: 'deny', reason: controlRemoval })
        }
    })

    it('denies every removal route for instances and secrets before declared command grants', () => {
        const configured = policy()
        configured.declaredAllows.push(
            { argv: ['rm'], reason: 'Repository cleanup is declared safe.' },
            { argv: ['mv'], reason: 'Repository moves are declared safe.' },
            { argv: ['find'], reason: 'Repository cleanup is declared safe.' },
        )
        for (const command of ['rm config/active.instance', 'mv config/active.instance copy.txt', 'rm -rf config']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'deny', reason: instanceMutation,
            })
        }
        for (const command of ['rm env/.secrets/project/token', 'mv env/.secrets/project/token copy.txt', 'find env -delete']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'deny', reason: secretMutation,
            })
        }
        expect(patch('*** Delete File: config/active.instance')).toEqual({ decision: 'deny', reason: instanceMutation })
        expect(patch('*** Delete File: env/.secrets/project/token')).toEqual({ decision: 'deny', reason: secretMutation })
        for (const command of ['rm notes/temporary.txt', 'mv notes/old.txt notes/new.txt']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect).decision, command).toBe('allow')
        }

        const secretRoot = `${root}/env/.secrets`
        const linked = policy()
        linked.protectedIdentities = protectedIdentities([{ path: instance }], {
            [instance]: { identity: '7:8', ancestors: ['7:1', '7:2'] },
            [secretRoot]: { identity: '7:9', ancestors: ['7:1', '7:3'] },
        })
        linked.declaredAllows.push(
            { argv: ['rm'], reason: 'Repository cleanup is declared safe.' },
            { argv: ['mv'], reason: 'Repository moves are declared safe.' },
        )
        const facts = ({ path, cwd }: { path: string; cwd: string }) => {
            const resolved = posix.resolve(cwd, path)
            const aliases: IdentityFacts = {
                [`${root}/notes/active.alias`]: { identity: '7:8', ancestors: [] },
                [`${root}/notes/token.alias`]: { identity: null, ancestors: ['7:9'] },
                [`${root}/notes/config-copy`]: { identity: '7:2', ancestors: [] },
                [`${root}/notes/env-copy`]: { identity: '7:3', ancestors: [] },
            }
            return { status: 'resolved', path: resolved, symlink: false, ...(aliases[resolved] ?? { identity: null, ancestors: [] }) }
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('rm notes/active.alias')), linked, facts)).toEqual({ decision: 'deny', reason: instanceMutation })
        expect(evaluateGuard(parseGuardInput(shellPayload('mv notes/token.alias copy.txt')), linked, facts)).toEqual({ decision: 'deny', reason: secretMutation })
        expect(evaluateGuard(parseGuardInput(shellPayload('rm -rf notes/config-copy')), linked, facts)).toEqual({ decision: 'deny', reason: instanceMutation })
        expect(evaluateGuard(parseGuardInput(shellPayload('mv notes/env-copy archive')), linked, facts)).toEqual({ decision: 'deny', reason: secretMutation })
    })

    it('does not let declared grants authorize removals outside configured roots', () => {
        const configured = policy()
        configured.declaredAllows.push(
            { argv: ['rm'], reason: 'Repository cleanup is declared safe.' },
            { argv: ['mv'], reason: 'Repository moves are declared safe.' },
        )
        for (const command of ['rm ../sibling/file', 'mv ../sibling/file copy.txt']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured, inspect), command).toEqual({
                decision: 'ask', reason: 'Removal outside configured roots requires human approval.',
            })
            expect(decide(command).decision, command).toBe('ask')
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('rm notes/temporary.txt')), configured, inspect)).toEqual({
            decision: 'allow', reason: 'Repository cleanup is declared safe.',
        })
        expect(patch('*** Delete File: ../sibling/file').decision).toBe('unavailable')
    })

    it('keeps editing the configuration and removing ordinary files outside the boundary', () => {
        expect(patch('*** Update File: cockpit.toml\n@@\n-a\n+b').decision).toBe('allow')
        expect(evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: 'cockpit.toml', content: '[cockpit]' } }), policy(), inspect).decision).toBe('allow')
        expect(evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: 'notes/empty.txt', content: '' } }), policy(), inspect).decision).toBe('allow')
        for (const command of ['rm src/a.ts', 'mv old.toml cockpit.toml', 'rm -rf /tmp/scratch', 'printf x >> cockpit.toml']) {
            expect(decide(command).decision, command).toBe('ask')
        }
        for (const command of [
            'truncate -s 0 notes.txt', 'dd count=0 of=notes.txt', 'tee notes.txt',
            'dd if=source.txt of=cockpit.toml conv=notrunc', 'dd of=cockpit.toml conv=sync,notrunc',
            'dd conv=notrunc conv=sync of=cockpit.toml', 'dd conv=sync conv=notrunc of=cockpit.toml',
            'tee -a cockpit.toml', 'tee --append cockpit.toml', 'tee -ai cockpit.toml', 'tee -ia -- cockpit.toml',
            'cp source.txt cockpit.toml', 'install source.txt cockpit.toml', 'mv old.toml cockpit.toml',
            'touch cockpit.toml', 'chmod 600 cockpit.toml', 'chmod 644 cockpit.toml', 'chmod u+x,go-w cockpit.toml', 'chmod u=rw cockpit.toml',
            'ln -s ../cockpit.toml notes/alias.toml', 'ln -f notes/old.txt notes/new.txt',
        ]) {
            const configured = policy()
            const [executable, ...argv] = command.split(' ')
            configured.projectCommands.push({ checkoutRoot: root, kind: 'test', executable, argv })
            expect(decide(command, configured).decision, command).toBe('allow')
        }
        for (const command of ['dd unsupported=value conv=notrunc of=notes.txt', 'dd conv= of=notes.txt',
            'dd conv=notrunc,unknown of=cockpit.toml', 'dd conv=notrunc oflag=unknown of=cockpit.toml',
            'dd of=', 'tee -a --output-error=unknown cockpit.toml', 'tee --append=yes notes.txt', 'tee notes.txt -a', 'tee --unknown notes.txt']) {
            const configured = policy()
            configured.declaredAllows.push({ argv: command.split(' '), reason: 'Repository writes are declared safe.' })
            expect.soft(decide(command, configured).decision, command).toBe('unavailable')
        }
    })
})

describe('installed code, search path and secret links', () => {
    const installed = `${root}/node_modules/@b0dea/cockpit`
    const execution = 'Refusing to change the installed cockpit, a node_modules/.bin directory or a command search path directory: code there runs as the guard or in place of a permitted command.'
    const link = 'Refusing to link to a secrets directory, a declared environment instance, a guard control or the installed cockpit: the link would reach it under a name the guard does not protect.'
    const payload = (tool_name: string, tool_input: object) => ({ hook_event_name: 'PreToolUse', tool_name, cwd: root, tool_input })
    const configured = () => {
        const value = policy()
        value.executionDirectories.push(installed, `${root}/node_modules/zod`)
        value.searchDirectories.push(`${root}/tools/bin`)
        for (const executable of ['cp', 'mv', 'rm', 'ln', 'chmod', 'tee', 'touch', 'install']) {
            value.declaredAllows.push({ argv: [executable], reason: 'Repository file writing is declared safe.' })
        }
        return value
    }

    it('denies every write channel into the installed cockpit, its dependencies, node_modules/.bin and search path directories', () => {
        // The guard authenticates its entry point only, so any other module it loads is a control.
        for (const path of [`${installed}/dist/guards/harness-adapter.js`, `${installed}/package.json`, `${root}/node_modules/zod/index.js`,
            `${root}/NODE_MODULES/@B0DEA/COCKPIT/dist/cli.js`, `${root}/node_modules/.bin/docker`, `${other}/node_modules/.bin/cockpit`, `${root}/tools/bin/ls`]) {
            for (const input of [payload('Write', { file_path: path, content: 'x' }), payload('Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
                payload('apply_patch', { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` }), shellPayload(`printf x >> ${path}`)]) {
                expect(evaluateGuard(parseGuardInput(input), configured(), inspect), `${input.tool_name} ${path}`).toEqual({ decision: 'deny', reason: execution })
            }
        }
        for (const command of ['rm -rf node_modules', 'rm node_modules/@b0dea/cockpit/dist/cli.js', 'mv node_modules/@b0dea/cockpit old',
            'cp evil.js node_modules/@b0dea/cockpit/dist/cli.js', 'cp evil node_modules/.bin', 'ln -s /bin/rm node_modules/.bin/ls',
            'chmod +x node_modules/.bin/docker', 'touch tools/bin/git', 'tee tools/bin/rg', 'mv evil tools/bin', 'cp -t tools evil-bin', 'install evil tools/bin/ls']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured(), inspect), command).toEqual({ decision: 'deny', reason: execution })
        }
        // Another package, a deeper file below a search path directory, and an argument naming installed code stay ordinary.
        for (const input of [payload('Write', { file_path: `${root}/node_modules/left-pad/index.js`, content: 'x' }),
            payload('Write', { file_path: `${root}/tools/bin/fixtures/notes.txt`, content: 'x' }), shellPayload('cp notes.txt tools/notes.txt')]) {
            expect(evaluateGuard(parseGuardInput(input), configured(), inspect).decision, JSON.stringify(input.tool_input)).toBe('allow')
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('node node_modules/.bin/tsc')), configured(), inspect).decision).toBe('ask')
    })

    it('admits no command while the search path holds a relative entry, since a file the agent wrote can shadow it or its interpreter', () => {
        // `packages/web/git` is no protected search directory, yet `.` makes it the `git` that runs there.
        const relative = (entry: string) => ({ ...configured(), searchPathRelativeEntry: entry,
            cockpitLaunchers: [candidate('cockpit', []), candidate('./node_modules/.bin/cockpit', [])] })
        const decideWith = (command: string, entry: string | null, cwd = root) => evaluateGuard(parseGuardInput(shellPayload(command, cwd)),
            entry === null ? { ...relative(''), searchPathRelativeEntry: null } : relative(entry), withGit).decision
        expect(evaluateGuard(parseGuardInput(payload('Write', { file_path: `${root}/packages/web/git`, content: 'x' })), relative('.'), inspect).decision).toBe('allow')
        for (const command of ['git status', 'ls', 'cat README.md', 'npm test', 'cockpit check', 'rm notes.txt']) {
            for (const entry of ['.', '', './node_modules/.bin']) expect(decideWith(command, entry), `${entry} ${command}`).toBe('ask')
            expect(decideWith(command, null), command).toBe('allow')
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('ls', `${root}/packages/web`)), relative(''), inspect).reason)
            .toBe('The command search path the agent runs with holds the relative entry "" (an empty entry is the working directory), so ls, or a program it starts by name, may run a file the agent wrote instead of the permitted program. Remove relative entries from the PATH the agent harness starts with.')
        // A path-spelled launcher still finds its `#!/usr/bin/env node` interpreter on that path, and hard denials come first.
        expect(decideWith('./node_modules/.bin/cockpit check', '.')).toBe('ask')
        expect(decideWith('./node_modules/.bin/cockpit check', null)).toBe('allow')
        expect(decideWith('cat config/active.instance', '.')).toBe('deny')
        for (const entry of ['/abs', 'a\nb']) expect(evaluateGuard(parseGuardInput(shellPayload('ls')), relative(entry), inspect).decision).toBe('unavailable')
    })

    it('denies every write channel that would plant an .npmrc inside an allowed root', () => {
        // npm applies a project .npmrc to `npx --no cockpit`, so its script-shell or node-options would
        // run other code as the launcher the guard trusts, within the same compound command.
        const npmrc = 'Refusing to write an .npmrc inside the configured roots: npm applies it to `npx --no cockpit`, and its script-shell or node-options would run other code as the cockpit launcher the guard trusts. A person edits .npmrc.'
        for (const path of [`${root}/.npmrc`, `${other}/.npmrc`, `${root}/packages/app/.npmrc`, `${root}/.NPMRC`]) {
            for (const input of [payload('Write', { file_path: path, content: 'script-shell=./evil' }), payload('Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
                payload('apply_patch', { command: `*** Begin Patch\n*** Add File: ${path}\n+node-options=--require ./evil.js\n*** End Patch` }), shellPayload(`printf x >> ${path}`)]) {
                expect(evaluateGuard(parseGuardInput(input), configured(), inspect), `${input.tool_name} ${path}`).toEqual({ decision: 'deny', reason: npmrc })
            }
        }
        for (const command of ['printf script-shell=./evil > .npmrc && npx --no cockpit up --config cockpit.toml', 'cp evil .npmrc', 'mv evil packages/app/.npmrc',
            'tee .npmrc', 'ln -s evil .npmrc', 'cp -t . other/.npmrc']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured(), inspect), command).toEqual({ decision: 'deny', reason: npmrc })
        }
        expect(evaluateGuard(parseGuardInput(payload('Write', { file_path: `${root}/notes/npmrc.txt`, content: 'x' })), configured(), inspect).decision).toBe('allow')
    })

    it('denies links to secrets, instances, guard controls and installed code', () => {
        for (const command of ['ln env/.secrets/token notes/token', 'ln -s ../env/.secrets/token notes/token', 'ln -s env/.SECRETS notes/secrets',
            'ln config/active.instance notes/copy', 'ln -s ../config/active.instance notes/copy', 'ln -s config notes/config', 'ln -s ../other/.secrets/key notes/key',
            'ln .claude/settings.json notes/settings.json', `ln ${installed}/dist/cli.js notes/cli.js`, 'ln -st notes ../node_modules/@b0dea/cockpit']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), configured(), inspect), command).toEqual({ decision: 'deny', reason: link })
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('ln -s ../README.md notes/readme.md')), configured(), inspect).decision).toBe('allow')
        expect(evaluateGuard(parseGuardInput(shellPayload('ln --unknown notes/a notes/b')), configured(), inspect)).toEqual({ decision: 'unavailable', reason: 'Unsupported visible writer option.' })
    })

    it('denies reading, writing or linking an existing hard link to a secrets file', () => {
        const value = configured()
        value.secretFileIdentities = ['7:30']
        const facts = (request: { path: string; cwd: string; operation?: string }) => {
            const resolved = posix.resolve(request.cwd, request.path)
            return { ...inspect(request), identity: resolved === `${root}/notes/copy` ? '7:30' : null }
        }
        for (const command of ['cat notes/copy', 'head -n 1 notes/copy', 'rg . notes/copy', 'grep -r . notes/copy', 'cp notes/copy notes/second']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), value, facts), command)
                .toEqual({ decision: 'deny', reason: 'Refusing to read a declared environment instance or secrets directory into the agent context.' })
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('printf x > notes/copy')), value, facts)).toEqual({ decision: 'deny', reason: 'Refusing mutation or staging below a secrets directory.' })
        expect(evaluateGuard(parseGuardInput(shellPayload('ln notes/copy notes/third')), value, facts)).toEqual({ decision: 'deny', reason: link })
        expect(evaluateGuard(parseGuardInput(shellPayload('cat notes/other')), value, facts).decision).toBe('allow')
    })

    it('asks before a recursive search when a protected file has another hard link, and before any read when secrets were not enumerated', () => {
        const linked = configured()
        linked.protectedFilesLinked = true
        expect(evaluateGuard(parseGuardInput(shellPayload('rg needle src')), linked, inspect).decision).toBe('ask')
        expect(evaluateGuard(parseGuardInput(shellPayload('cat src/a.ts')), linked, inspect).decision).toBe('allow')
        expect(evaluateGuard(parseGuardInput(shellPayload('rg needle src')), configured(), inspect).decision).toBe('allow')
        const unenumerated = configured()
        unenumerated.secretFileIdentities = null
        for (const command of ['cat src/a.ts', 'rg needle src']) {
            expect(evaluateGuard(parseGuardInput(shellPayload(command)), unenumerated, inspect).decision, command).toBe('ask')
        }
        expect(evaluateGuard(parseGuardInput(shellPayload('ls src')), unenumerated, inspect).decision).toBe('allow')
    })

    it('refuses execution, search path and secret identity fields that escape or malform', () => {
        for (const change of [{ executionDirectories: ['/outside/node_modules/x'] }, { executionDirectories: ['relative/dir'] }, { searchDirectories: [`${root}/bin/`] },
            { secretFileIdentities: ['inode'] }, { secretFileIdentities: undefined }, { protectedFilesLinked: 'yes' }]) {
            expect(evaluateGuard(parseGuardInput(shellPayload('ls')), { ...configured(), ...change }, inspect).decision, JSON.stringify(change)).toBe('unavailable')
        }
    })
})
