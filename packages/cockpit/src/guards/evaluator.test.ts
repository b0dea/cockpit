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
const inspect = ({ path, cwd }: { path: string; cwd: string }) => ({ status: 'resolved', path: posix.resolve(cwd, path), symlink: false, identity: null, ancestors: [] })
// Identity facts for every protected path; synthetic tests name only the ones they exercise.
type IdentityFacts = Record<string, { identity: string | null; ancestors: string[] }>
function protectedIdentities(instances: readonly { path: string }[], known: IdentityFacts = {}) {
    return [...instances.map((item) => item.path), ...GUARD_ROOT_PROTECTIONS.map((item) => `${root}/${item.path}`)]
        .map((path) => ({ path, ...(known[path] ?? { identity: null, ancestors: [] }) }))
}
const candidate = (executable: string, argv: string[], cwd = root) => ({ executable, argv, cwd })
function policy() {
    return {
        canonicalRoot: root, allowedRoots: [root, other], instances: [{ name: 'active', path: instance }], protectedIdentities: protectedIdentities([{ path: instance }]),
        protectedBranches: ['main', 'release/stable'], hostedDatabaseHosts: ['db.example.test', '*.database.example.test'], vendorHosts: ['api.vendor.example.test'],
        cockpitInvocations: [candidate('/opt/cockpit/bin/cockpit', ['status']), candidate('/opt/cockpit/bin/cockpit', ['logs', 'web', '--lines', '20'])],
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
        expect(parsed).toEqual({ status: 'parsed', tool: 'Bash', cwd: root, invocations: row.capture.control, paths: [] })
        const refused = parseGuardInput(shellPayload(row.candidate))
        expect(refused).toEqual(typeof row.capture.candidate === 'string' ? { status: 'unavailable', reason: row.capture.candidate }
            : { status: 'parsed', tool: 'Bash', cwd: root, invocations: row.capture.candidate, paths: [] })
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
            '.claude/settings.local.json', '.mcp.json', '.codex/hooks.json', '.codex/config.toml', '.codex/rules/rulesync.rules',
            'opencode.json', 'opencode.jsonc', '.opencode/plugin/cockpit-guards.js', '.opencode/plugin/extra.js', '.opencode/plugins/rulesync-hooks.js',
            '.cockpit/bundles/claudecode-plugin/.mcp.json', '.cockpit/bundles/claudecode-plugin/hooks/hooks.json', '.Claude/Settings.json']) {
            for (const input of [
                payload('Write', { file_path: `${root}/${path}`, content: '{}' }), payload('Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
                payload('apply_patch', { command: `*** Begin Patch\n*** Update File: template\n*** Move to: ${path}\n@@\n-a\n+b\n*** End Patch` }),
                shellPayload(`printf ok > ${path}`),
            ]) expect(evaluateGuard(parseGuardInput(input), policy(), inspect), `${input.tool_name} ${path}`).toEqual(refusal)
        }
        for (const path of [`${other}/.claude/settings.json`, `${root}/.claude/agents/evaluator.md`, `${root}/.cockpit/guards/notes.md`, `${root}/.opencode/agents/reviewer.md`]) {
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
