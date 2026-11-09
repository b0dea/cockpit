import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GUARD_EXECUTABLE_SEARCH_PATH, resolveGitExecutable } from '../environment/executable.js'
import { executeProbe } from '../environment-exec/execute.js'
import { GUARD_SECRET_FILE_LIMIT } from './evaluator.js'
import { guardBranchFacts, guardInstalledDirectories, guardPatchTargets, guardRemoteCredentials, guardSearchDirectories, guardSearchPathRelativeEntry, guardSecretFiles,
    guardSensitivePathsBelow, guardTrackedSensitivePaths, guardUnignoredSensitivePaths } from './protected-locations.js'

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
    })

    it('names every path a patch file applies to, and none when a header is one it cannot read', () => {
        const root = scratch()
        const patch = (text: string) => { writeFileSync(join(root, 'p.diff'), text); return guardPatchTargets(join(root, 'p.diff')) }
        expect(patch('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\t2026-01-01\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
            + 'diff --git a/old.ts b/.cockpit/guards/bash-guard.sh\nrename from old.ts\nrename to .cockpit/guards/bash-guard.sh\n')).toEqual(['src/a.ts', 'old.ts', '.cockpit/guards/bash-guard.sh'])
        expect(patch('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n')).toEqual(['new.ts'])
        expect(patch('diff --git "a/x y" "b/x y"\n')).toBeNull()
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
