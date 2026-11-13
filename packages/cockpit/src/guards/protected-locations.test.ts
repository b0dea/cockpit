import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GUARD_EXECUTABLE_SEARCH_PATH, resolveExecutable, resolveGitExecutable } from '../environment/executable.js'
import { executeProbe } from '../environment-exec/execute.js'
import { GUARD_SECRET_FILE_LIMIT } from './evaluator.js'
import { guardArchiveEntries, guardBranchFacts, guardInstalledDirectories, guardPackageManifest, guardPatchTargets, guardRemoteCredentials, guardSearchDirectories, guardSearchPathRelativeEntry,
    guardCommittedSensitivePaths, guardSecretFiles, guardSensitivePathsBelow, guardTrackedSensitivePaths, guardUnignoredSensitivePaths, guardWorktreeChanges } from './protected-locations.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-protected-locations-')))
    roots.push(root)
    return root
}
function writePackage(directory: string, name: string, dependencies: Record<string, string> = {}) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, dependencies }))
}

describe('guard protected locations', () => {
    it('finds the running package, its consumer spelling and every package it loads as Node resolves them', () => {
        const root = scratch()
        const store = join(root, 'store/tool')
        writePackage(store, '@synthetic/tool', { 'dep-a': '1.0.0' })
        mkdirSync(join(root, 'consumer/node_modules/@synthetic'), { recursive: true })
        symlinkSync(store, join(root, 'consumer/node_modules/@synthetic/tool'))
        // The consumer's own copies are decoys: Node resolves the package's imports from its real path.
        writePackage(join(root, 'consumer/node_modules/dep-a'), 'dep-a', { 'dep-b': '1.0.0' })
        writePackage(join(root, 'consumer/node_modules/dep-a/node_modules/dep-b'), 'dep-b')
        writePackage(join(root, 'consumer/node_modules/dep-b'), 'dep-b')
        writePackage(join(root, 'store/node_modules/dep-a'), 'dep-a', { 'dep-b': '1.0.0' })
        writePackage(join(root, 'store/node_modules/dep-a/node_modules/dep-b'), 'dep-b')
        expect(guardInstalledDirectories(store, join(root, 'consumer'))).toEqual([
            join(root, 'consumer/node_modules/@synthetic/tool'), store,
            join(root, 'store/node_modules/dep-a'), join(root, 'store/node_modules/dep-a/node_modules/dep-b'),
        ].sort())
        writePackage(store, '@synthetic/tool', { missing: '1.0.0' })
        expect(() => guardInstalledDirectories(store, join(root, 'consumer'))).toThrow(`guard dependency missing is not installed above ${store}`)
    })

    it('keeps absolute search path directories inside the allowed roots under both spellings, and names the first relative entry', () => {
        const root = scratch()
        mkdirSync(join(root, 'real-bin'))
        symlinkSync(join(root, 'real-bin'), join(root, 'bin'))
        const searchPath = `/usr/bin:${root}/bin/:relative/bin::${root}/missing/bin:${root}-other/bin`
        expect(guardSearchDirectories(searchPath, [root])).toEqual([join(root, 'bin'), join(root, 'missing/bin'), join(root, 'real-bin')])
        expect(guardSearchPathRelativeEntry(searchPath)).toBe('relative/bin')
        expect(guardSearchPathRelativeEntry('/usr/bin::/bin')).toBe('')
        expect(guardSearchPathRelativeEntry('./node_modules/.bin:/usr/bin')).toBe('./node_modules/.bin')
        expect(guardSearchPathRelativeEntry('/usr/bin:/bin')).toBeNull()
    })

    it('finds every environment file and secrets directory a recursive search would reach, without following links, up to its bound', () => {
        const root = scratch()
        mkdirSync(join(root, 'tree/src'), { recursive: true })
        writeFileSync(join(root, 'tree/src/a.ts'), 'export {}\n')
        expect(guardSensitivePathsBelow(join(root, 'tree'))).toEqual([])
        expect(guardSensitivePathsBelow(join(root, 'tree'), undefined, true)).toEqual([])
        mkdirSync(join(root, 'tree/pkg/.Secrets'), { recursive: true })
        writeFileSync(join(root, 'tree/src/.ENV.local'), 'SYNTHETIC=1\n')
        writeFileSync(join(root, 'tree/.envrc'), 'export SYNTHETIC=1\n')
        mkdirSync(join(root, 'outside'))
        writeFileSync(join(root, 'outside/.env'), 'SYNTHETIC=1\n')
        symlinkSync(join(root, 'outside'), join(root, 'tree/linked'))
        expect(guardSensitivePathsBelow(join(root, 'tree'))).toEqual([join(root, 'tree/.envrc'), join(root, 'tree/pkg/.Secrets'), join(root, 'tree/src/.ENV.local')])
        expect(guardSensitivePathsBelow(join(root, 'tree/src/.ENV.local'))).toEqual([join(root, 'tree/src/.ENV.local')])
        expect(guardSensitivePathsBelow(join(root, 'absent'))).toEqual([])
        expect(guardSensitivePathsBelow(join(root, 'tree'), 6)).toBeNull()
        // A tool that follows links, as diff does, reads what the walk never sees behind one.
        expect(guardSensitivePathsBelow(join(root, 'tree'), undefined, true)).toBeNull()
    })

    it('lists the protected paths a default ripgrep search reads from Git, and declines where Git cannot stand for ripgrep', async () => {
        const resolution = await resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH })
        if (resolution.state !== 'available') throw new Error(resolution.reason)
        const git = resolution.value
        const root = scratch()
        const write = (path: string, content = 'SYNTHETIC=1\n') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content) }
        execFileSync('git', ['init', '-q', root])
        write('.gitignore', '.env\nnode_modules\n')
        write('src/a.ts', 'export {}\n')
        write('.env')
        write('node_modules/pkg/.env')
        write('config/runtime.env')
        const instance = join(root, 'config/runtime.env')
        const unignored = (path: string) => guardUnignoredSensitivePaths(join(root, path), [instance], git, executeProbe)
        // Git ignores .env and node_modules, which ripgrep then skips; the declared instance it reads.
        expect(await unignored('.')).toEqual([instance])
        write('.env.local')
        write('pkg/.secrets/token')
        expect(await unignored('.')).toEqual([join(root, '.env.local'), instance, join(root, 'pkg/.secrets')])
        expect(await unignored('src')).toEqual([])
        expect(await unignored('.env')).toEqual([join(root, '.env')])
        // ripgrep searches inside a directory it is named, ignored or not.
        expect(await unignored('node_modules')).toBeUndefined()
        // An ignore file Git does not read, even one Git ignores, and a nested repository Git does not list.
        write('src/.ignore', '!.env\n')
        expect(await unignored('src')).toBeUndefined()
        rmSync(join(root, 'src/.ignore'))
        write('.gitignore', '.env\nnode_modules\n.rgignore\n')
        write('src/.rgignore', '!.env\n')
        expect(await unignored('.')).toBeUndefined()
        rmSync(join(root, 'src/.rgignore'))
        // ripgrep never enters a directory Git ignores whole, so an ignore file there is never read.
        write('node_modules/.rgignore', '!pkg\n!.env\n')
        expect(await unignored('.')).toEqual([join(root, '.env.local'), instance, join(root, 'pkg/.secrets')])
        rmSync(join(root, 'node_modules/.rgignore'))
        // ripgrep stops applying the ignore files above a directory holding `.git` or `.jj`; Git does not.
        write('.gitignore', '.env\nnode_modules\nconfig/runtime.env\n')
        expect(await unignored('.')).toEqual([join(root, '.env.local'), join(root, 'pkg/.secrets')])
        mkdirSync(join(root, 'config/.jj'))
        expect(await unignored('.')).toBeUndefined()
        rmSync(join(root, 'config/.jj'), { recursive: true })
        // Spellings Git and ripgrep read differently, in either ignore direction and at any depth Git reads.
        for (const [file, pattern] of [['.gitignore', 'config/runtime.e[[:alpha:]]v'], ['.gitignore', 'config/runtime.e**'],
            ['.gitignore', 'config/*\n!config/runtime.{env,x}'], ['.gitignore', 'config/*\n!config/runtime.env\t'], ['.gitignore', '\xff\nconfig/runtime.env'],
            ['config/.gitignore', 'runtime.e[[:alpha:]]v']] as const) {
            write('.gitignore', '.env\nnode_modules\n')
            writeFileSync(join(root, file), Buffer.from(`${file === '.gitignore' ? '.env\nnode_modules\n' : ''}${pattern}\n`, 'latin1'))
            expect(await unignored('.'), pattern).toBeUndefined()
            expect(await unignored('config'), pattern).toBeUndefined()
        }
        rmSync(join(root, 'config/.gitignore'))
        write('.gitignore', '.env\nnode_modules\n')
        // An ignore file past the read bound is not read, so nothing is proven about what it hides.
        write('.gitignore', `.env\nnode_modules\n${'#'.repeat(1_048_576)}\n`)
        expect(await unignored('.')).toBeUndefined()
        write('.gitignore', '.env\nnode_modules\n')
        // So below such a directory ripgrep reads one Git ignores whole, whatever it holds.
        write('lib/node_modules/pkg/.env')
        mkdirSync(join(root, 'lib/.jj'))
        expect(await unignored('.')).toBeUndefined()
        rmSync(join(root, 'lib'), { recursive: true })
        execFileSync('git', ['init', '-q', join(root, 'vendor/nested')])
        expect(await unignored('.')).toBeUndefined()
        expect(await unignored('src')).toEqual([])
        // A boundary inside a directory Git ignores whole is never reached.
        rmSync(join(root, 'vendor'), { recursive: true })
        mkdirSync(join(root, 'node_modules/nested/.jj'), { recursive: true })
        write('node_modules/nested/.env.local')
        expect(await unignored('.')).toEqual([join(root, '.env.local'), instance, join(root, 'pkg/.secrets')])
        expect(await guardUnignoredSensitivePaths(scratch(), [], git, executeProbe)).toBeUndefined()
        // Only the index is asked what the repository tracks.
        expect(await guardTrackedSensitivePaths(root, [instance], git, executeProbe)).toEqual([])
        execFileSync('git', ['-C', root, 'add', '--force', '.env', 'config/runtime.env', 'src/a.ts'])
        expect(await guardTrackedSensitivePaths(root, [instance], git, executeProbe)).toEqual([join(root, '.env'), instance])
        // History is asked separately: a file committed once and removed since stays in every commit that held it.
        expect(await guardCommittedSensitivePaths(root, [instance], git, executeProbe)).toEqual([])
        const commit = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', ...args])
        commit('-m', 'Synthetic history')
        execFileSync('git', ['-C', root, 'rm', '-q', '--cached', '.env', 'config/runtime.env'])
        commit('-m', 'Remove the environment files')
        expect(await guardTrackedSensitivePaths(root, [instance], git, executeProbe)).toEqual([])
        expect(await guardCommittedSensitivePaths(root, [instance], git, executeProbe)).toEqual([join(root, '.env'), instance])
        // A deleted branch leaves its commits in HEAD's reflog, which `git show <commit>` still prints.
        const first = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
        execFileSync('git', ['-C', root, 'checkout', '-q', '--orphan', 'clean'])
        commit('--allow-empty', '-m', 'Unrelated history')
        execFileSync('git', ['-C', root, 'branch', '-q', '-D', first])
        expect(await guardCommittedSensitivePaths(root, [], git, executeProbe)).toEqual([join(root, '.env')])
    })

    it('reports what a push or pull acts on, and whether a remote URL Git prints carries a credential', async () => {
        const resolution = await resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH })
        if (resolution.state !== 'available') throw new Error(resolution.reason)
        const git = resolution.value
        const root = scratch()
        const config = (...args: string[]) => execFileSync('git', ['-C', root, 'config', ...args])
        execFileSync('git', ['init', '-q', '-b', 'main', root])
        config('remote.origin.url', 'https://example.test/r.git')
        expect(await guardBranchFacts(root, git, executeProbe)).toEqual({ head: 'refs/heads/main', push: null, pushDefault: null, pushRefspecs: false, pullRebase: false })
        expect(await guardRemoteCredentials(root, git, executeProbe)).toBe(false)
        config('push.default', 'matching')
        config('pull.rebase', 'true')
        config('remote.origin.push', 'refs/heads/*:refs/heads/*')
        expect(await guardBranchFacts(root, git, executeProbe)).toMatchObject({ pushDefault: 'matching', pushRefspecs: true, pullRebase: true })
        config('branch.main.rebase', 'false')
        expect(await guardBranchFacts(root, git, executeProbe)).toMatchObject({ pullRebase: false })
        config('remote.origin.pushurl', 'https://synthetic-user:synthetic-password@example.test/r.git')
        expect(await guardRemoteCredentials(root, git, executeProbe)).toBe(true)
        config('--unset', 'remote.origin.pushurl')
        config('url.https://synthetic-user:synthetic-password@example.test/.insteadOf', 'https://example.test/')
        expect(await guardRemoteCredentials(root, git, executeProbe)).toBe(true)
        config('--remove-section', 'url.https://synthetic-user:synthetic-password@example.test/')
        config('http.https://example.test/.extraHeader', 'AUTHORIZATION: synthetic')
        expect(await guardRemoteCredentials(root, git, executeProbe)).toBe(true)
        // Settings only in the person's global configuration count, below HOME and below XDG_CONFIG_HOME.
        const other = scratch()
        execFileSync('git', ['init', '-q', '-b', 'main', other])
        const home = scratch()
        mkdirSync(join(home, '.config/git'), { recursive: true })
        writeFileSync(join(home, '.config/git/config'), '[push]\n\tdefault = matching\n[url "https://synthetic-user:synthetic-password@example.test/"]\n\tinsteadOf = https://example.test/\n')
        mkdirSync(join(home, 'xdg/git'), { recursive: true })
        writeFileSync(join(home, 'xdg/git/config'), '[pull]\n\trebase = true\n')
        expect(await guardBranchFacts(other, git, executeProbe)).toMatchObject({ pushDefault: null, pullRebase: false })
        expect(await guardBranchFacts(other, git, executeProbe, { HOME: home })).toMatchObject({ pushDefault: 'matching', pullRebase: false })
        expect(await guardBranchFacts(other, git, executeProbe, { HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') })).toMatchObject({ pullRebase: true })
        expect(await guardRemoteCredentials(other, git, executeProbe)).toBe(false)
        expect(await guardRemoteCredentials(other, git, executeProbe, { HOME: home })).toBe(true)
    })

    it('reports which guard controls a revision would write into the work tree, as each Git verb compares them', async () => {
        const resolution = await resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH })
        if (resolution.state !== 'available') throw new Error(resolution.reason)
        const git = resolution.value
        const root = scratch()
        const run = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { encoding: 'utf8' })
        const guard = join(root, '.cockpit/guards/bash-guard.sh')
        mkdirSync(join(root, '.cockpit/guards'), { recursive: true })
        writeFileSync(guard, 'guard\n')
        writeFileSync(join(root, 'notes.md'), 'notes\n')
        run('init', '-q', '-b', 'work')
        run('add', '.')
        run('commit', '-qm', 'base')
        // A second branch replaces the guard, as a commit made in a second worktree does.
        run('switch', '-qc', 'evil')
        writeFileSync(guard, 'exit 0\n')
        run('commit', '-qam', 'replace')
        run('switch', '-q', 'work')
        writeFileSync(join(root, 'notes.md'), 'more notes\n')
        run('commit', '-qam', 'notes')
        const changes = (revision: string, from?: string) => guardWorktreeChanges(root, { revision, ...from === undefined ? {} : { from } }, [guard, join(root, '.cockpit/mcp')], git, executeProbe)
        expect(await changes('evil')).toEqual({ guarded: true, changed: [guard] })
        expect(await changes('work~1')).toEqual({ guarded: true, changed: [] })
        // A pick applies only what the commit changed, and a word that names no commit is unresolved, which asks.
        expect(await changes('evil', 'evil^')).toEqual({ guarded: true, changed: [guard] })
        expect(await changes('work', 'work^')).toEqual({ guarded: true, changed: [] })
        expect(await changes('notes.md')).toBeNull()
        expect(await guardWorktreeChanges(root, { revision: 'missing^3', from: 'missing^3^', optional: true }, [guard], git, executeProbe)).toEqual({ guarded: true, changed: [] })
        // A reset overwrites the work tree itself, local edits included.
        writeFileSync(guard, 'edited\n')
        expect(await changes('HEAD', 'worktree')).toEqual({ guarded: true, changed: [guard] })
        // A from that names no commit lists what the revision holds, as a stash's untracked files are restored.
        expect(await changes('evil', 'evil~5')).toEqual({ guarded: true, changed: [guard], unsettled: [guard] })
        // A repository whose work tree holds no protected path is not guarded; one with no commit names no HEAD.
        const sibling = scratch()
        execFileSync('git', ['init', '-q', sibling])
        expect(await guardWorktreeChanges(sibling, { revision: 'HEAD' }, [guard], git, executeProbe)).toBeNull()
        execFileSync('git', ['-C', sibling, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '--allow-empty', '-m', 'base'])
        expect(await guardWorktreeChanges(sibling, { revision: 'HEAD' }, [guard], git, executeProbe)).toEqual({ guarded: false, changed: [] })
    })

    it('names every agent tool setting, guard script and skill a Git verb would write anywhere in the tree', async () => {
        const resolution = await resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH })
        if (resolution.state !== 'available') throw new Error(resolution.reason)
        const git = resolution.value
        const root = scratch()
        const run = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { encoding: 'utf8' })
        writeFileSync(join(root, 'notes.md'), 'notes\n')
        run('init', '-q', '-b', 'work')
        run('add', '.')
        run('commit', '-qm', 'base')
        // A revision carrying a nested hook registration, a planted guard script, an OpenCode tool, a skill whose
        // frontmatter registers a hook, a command whose body runs a shell, and a plain skill.
        run('switch', '-qc', 'planted')
        for (const [path, text] of Object.entries({ 'deep/.claude/settings.json': '{}', 'deep/sub/.codex/hooks.json': '{}', 'pkg/.cockpit/guards/bash-guard.sh': 'exit 0',
            'pkg/.opencode/plugins/a.js': '', 'pkg/.opencode/tools/t.ts': '', 'tools/skills/probe/SKILL.md': '---\nname: probe\nhooks: {}\n---\n',
            'tools/.claude/commands/run.md': 'Today is !`date`.', 'tools/skills/plain/SKILL.md': '---\nname: plain\n---\nBody.',
            // A Git filter rewrites a file on checkout from the blob the guard would read.
            'tools/skills/filtered/SKILL.md': '---\nname: filtered\n---\nBody.', '.gitattributes': 'tools/skills/filtered/SKILL.md filter=synthetic' })) {
            mkdirSync(join(root, path, '..'), { recursive: true })
            writeFileSync(join(root, path), `${text}\n`)
        }
        run('add', '.')
        run('commit', '-qm', 'planted')
        run('switch', '-q', 'work')
        const planted = [join(root, 'deep/.claude/settings.json'), join(root, 'deep/sub/.codex/hooks.json'), join(root, 'pkg/.cockpit/guards/bash-guard.sh'),
            join(root, 'pkg/.opencode/plugins/a.js'), join(root, 'pkg/.opencode/tools/t.ts')]
        // The plain skill is read and passes; one Git removes is not judged as an instruction.
        const skill = [join(root, 'tools/.claude/commands/run.md'), join(root, 'tools/skills/filtered/SKILL.md'), join(root, 'tools/skills/probe/SKILL.md')]
        const changes = (target: Parameters<typeof guardWorktreeChanges>[1]) => guardWorktreeChanges(root, target, [], git, executeProbe)
        // A checkout or merge of the revision, a restore of a directory from it, and a worktree of it.
        expect(await changes({ revision: 'planted' })).toEqual({ guarded: false, changed: planted, instructions: skill })
        expect(await changes({ revision: 'planted', from: 'worktree', paths: ['deep'] })).toEqual({ guarded: false, changed: [planted[0], planted[1]] })
        expect(await changes({ revision: 'planted', from: ':empty' })).toEqual({ guarded: false, changed: planted, instructions: skill })
        expect((await changes({ revision: 'work', from: 'planted' }))?.instructions).toBeUndefined()
        // The index, as `git update-index --cacheinfo` leaves it, then checked out by path or by a word that names no commit.
        run('read-tree', 'planted')
        expect(await changes({ revision: ':index', from: 'worktree', paths: ['deep'] })).toEqual({ guarded: false, changed: [planted[0], planted[1]] })
        expect(await changes({ revision: 'deep', fallback: 'index' })).toEqual({ guarded: false, changed: [planted[0], planted[1]] })
        run('read-tree', 'work')
        expect(await changes({ revision: 'work', from: 'worktree', paths: ['notes.md'] })).toEqual({ guarded: false, changed: [] })
    })

    it('judges what a verb writes against the working tree, so a HEAD moved under it hides nothing', async () => {
        const resolution = await resolveGitExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH })
        if (resolution.state !== 'available') throw new Error(resolution.reason)
        const git = resolution.value
        const root = scratch()
        const run = (args: string[], input?: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args],
            { encoding: 'utf8', ...input === undefined ? {} : { input } }).trim()
        mkdirSync(join(root, '.claude'), { recursive: true })
        writeFileSync(join(root, '.claude/settings.json'), '{"hooks":{}}\n')
        writeFileSync(join(root, '.gitignore'), '.claude/settings.local.json\n')
        run(['init', '-q', '-b', 'work'])
        run(['add', '.'])
        run(['commit', '-qm', 'base'])
        run(['branch', 'topic'])
        writeFileSync(join(root, '.claude/settings.local.json'), '{}\n')
        // A commit crafted from objects alone, with HEAD moved onto it: the index and the files on disk still hold the guard.
        const blob = (text: string) => run(['hash-object', '-w', '--stdin'], text)
        const tree = (entries: string) => run(['mktree'], entries)
        const claude = tree(`100644 blob ${blob('{}\n')}\tsettings.json\n100644 blob ${blob('{"disableAllHooks":true}\n')}\tsettings.local.json\n`)
        const api = tree(`040000 tree ${tree(`100644 blob ${blob('{}\n')}\tsettings.json\n`)}\t.claude\n`)
        const crafted = run(['commit-tree', tree(`040000 tree ${claude}\t.claude\n040000 tree ${api}\tapi\n100644 blob ${blob('.claude/settings.local.json\n')}\t.gitignore\n`), '-p', 'HEAD', '-m', 'crafted'])
        run(['reset', '--soft', crafted])
        const changes = (target: Parameters<typeof guardWorktreeChanges>[1]) => guardWorktreeChanges(root, target, [], git, executeProbe)
        const planted = [join(root, '.claude/settings.json'), join(root, '.claude/settings.local.json'), join(root, 'api/.claude/settings.json')]
        // A forced checkout of HEAD, and a new worktree of it, write the crafted files over the ones on disk.
        expect(await changes({ revision: 'HEAD', from: 'worktree' })).toEqual({ guarded: false, changed: planted })
        // A merge applies another revision's changes to HEAD: with HEAD moved off what is on disk, what it writes is not
        // judged by them, so every control that differs is named.
        expect(await changes({ revision: 'HEAD' })).toEqual({ guarded: false, changed: [], unsettled: planted })
        // A new worktree named for a branch that does not exist starts at HEAD.
        expect(await changes({ revision: 'nowhere', from: 'worktree', fallback: 'head' })).toEqual({ guarded: false, changed: planted })
    })

    it('lists the members a tar or zip archive would extract, and none from one it cannot read', async () => {
        const root = scratch()
        for (const path of ['src/a.ts', 'pkg/.claude/settings.json']) {
            mkdirSync(join(root, 'content', path, '..'), { recursive: true })
            writeFileSync(join(root, 'content', path), 'synthetic\n')
        }
        execFileSync('tar', ['-czf', join(root, 'a.tgz'), '-C', join(root, 'content'), 'src', 'pkg'])
        execFileSync('zip', ['-qr', join(root, 'a.zip'), 'src', 'pkg'], { cwd: join(root, 'content') })
        writeFileSync(join(root, 'broken.tgz'), 'not an archive')
        const list = async (archive: string, format: 'tar' | 'zip') => {
            const tool = await resolveExecutable(format === 'tar' ? 'tar' : 'unzip', { PATH: GUARD_EXECUTABLE_SEARCH_PATH })
            if (tool.state !== 'available') throw new Error(tool.reason)
            return guardArchiveEntries(join(root, archive), format, tool.value, executeProbe)
        }
        const members = ['pkg/', 'pkg/.claude/', 'pkg/.claude/settings.json', 'src/', 'src/a.ts']
        expect([...await list('a.tgz', 'tar') ?? []].sort()).toEqual(members)
        expect([...await list('a.zip', 'zip') ?? []].sort()).toEqual(members)
        expect(await list('broken.tgz', 'tar')).toBeNull()
        expect(await list('missing.zip', 'zip')).toBeNull()
    })

    it('reads the nearest package manifest inside the roots, and none past them or from an unreadable one', () => {
        const root = scratch()
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-app', scripts: { build: 'tsc', test: 'vitest' } }))
        mkdirSync(join(root, 'copy/dist'), { recursive: true })
        writeFileSync(join(root, 'copy/package.json'), JSON.stringify({ name: '@b00dea/cockpit' }))
        writeFileSync(join(root, 'copy/dist/cli.js'), '')
        const inside = (path: string) => path === root || path.startsWith(`${root}/`)
        expect(guardPackageManifest(join(root, 'src'), inside)).toEqual({ name: 'synthetic-app', scripts: ['build', 'test'] })
        expect(guardPackageManifest(join(root, 'copy/dist/cli.js'), inside)).toEqual({ name: '@b00dea/cockpit', scripts: [] })
        expect(guardPackageManifest(join(root, 'src'), (path: string) => path.startsWith(`${root}/src`))).toEqual({ name: null, scripts: [] })
        writeFileSync(join(root, 'copy/package.json'), '{')
        expect(guardPackageManifest(join(root, 'copy/dist/cli.js'), inside)).toBeNull()
    })

    it('reads every script a workspace declares, from pnpm-workspace.yaml or package.json, and none it cannot bound', () => {
        const root = scratch()
        const inside = (path: string) => path === root || path.startsWith(`${root}/`)
        const write = (path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
        write('package.json', JSON.stringify({ name: 'monorepo', scripts: { lint: 'eslint .' } }))
        write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'tools/**'\n  - '!packages/skip'\n")
        write('packages/web/package.json', JSON.stringify({ name: 'web', scripts: { build: 'vite build' } }))
        write('packages/api/package.json', JSON.stringify({ name: 'api', scripts: { test: 'vitest' } }))
        write('packages/web/node_modules/dep/package.json', JSON.stringify({ name: 'dep', scripts: { evil: 'x' } }))
        write('tools/a/b/package.json', JSON.stringify({ name: 'b', scripts: { gen: 'node gen.js' } }))
        expect(guardPackageManifest(join(root, 'packages/api'), inside, true)).toEqual({ name: 'api', scripts: ['test'], workspace: ['build', 'gen', 'lint', 'test'] })
        // npm and yarn list their workspaces in package.json.
        rmSync(join(root, 'pnpm-workspace.yaml'))
        write('package.json', JSON.stringify({ name: 'monorepo', workspaces: { packages: ['packages/*'] } }))
        expect(guardPackageManifest(join(root, 'packages/api'), inside, true)).toMatchObject({ workspace: ['build', 'test'] })
        write('package.json', JSON.stringify({ name: 'monorepo', workspaces: ['../outside/*'] }))
        expect(guardPackageManifest(join(root, 'packages/api'), inside, true)).toMatchObject({ workspace: null })
    })

    it('names every path a patch file applies to, and none when a header is one it cannot read', () => {
        const root = scratch()
        const patch = (text: string) => { writeFileSync(join(root, 'p.diff'), text); return guardPatchTargets(join(root, 'p.diff')) }
        expect(patch('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\t2026-01-01\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
            + 'diff --git a/old.ts b/.cockpit/guards/bash-guard.sh\nrename from old.ts\nrename to .cockpit/guards/bash-guard.sh\n')).toEqual(['src/a.ts', 'old.ts', '.cockpit/guards/bash-guard.sh'])
        expect(patch('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n')).toEqual(['new.ts'])
        expect(patch('diff --git "a/x y" "b/x y"\n')).toBeNull()
        // `git am` decodes an encoded mail body, so the raw lines name nothing it applies.
        expect(patch('From: synthetic@example.test\nSubject: [PATCH] x\nContent-Transfer-Encoding: base64\n\nZGlmZiAtLWdpdA==\n')).toBeNull()
        expect(patch('Subject: x\ncontent-transfer-encoding: quoted-printable\n\n--- a/src/a.ts\n+++ b/=2Ecockpit/guards/bash-guard.sh\n')).toBeNull()
        expect(patch('Subject: x\nContent-Transfer-Encoding: 8bit\n\n--- a/src/a.ts\n+++ b/src/a.ts\n')).toEqual(['src/a.ts'])
        symlinkSync(join(root, 'p.diff'), join(root, 'link.diff'))
        expect(guardPatchTargets(join(root, 'link.diff'))).toBeNull()
        expect(guardPatchTargets(join(root, 'absent.diff'))).toBeNull()
    })

    it('enumerates every secrets file identity under any folded spelling and reports a second hard link or an exceeded bound', () => {
        const root = scratch()
        mkdirSync(join(root, 'env/.secrets/project'), { recursive: true })
        writeFileSync(join(root, 'env/.secrets/token'), 'synthetic\n')
        writeFileSync(join(root, 'env/.secrets/project/key'), 'synthetic\n')
        writeFileSync(join(root, 'env/notes.txt'), 'not secret\n')
        expect(guardSecretFiles(root)).toEqual({ identities: expect.any(Array), linked: false })
        expect(guardSecretFiles(root).identities).toHaveLength(2)
        linkSync(join(root, 'env/.secrets/token'), join(root, 'alias'))
        expect(guardSecretFiles(root)).toMatchObject({ linked: true })
        for (let index = 0; index < GUARD_SECRET_FILE_LIMIT; index++) writeFileSync(join(root, `env/.secrets/project/file-${index}`), '')
        expect(guardSecretFiles(root)).toEqual({ identities: null, linked: true })
        expect(guardSecretFiles(join(root, 'absent'))).toEqual({ identities: [], linked: false })
    })
})
