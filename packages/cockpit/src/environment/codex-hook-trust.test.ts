import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { renderHumanDiagnostics } from '../diagnostics.js'
import { executeProbe } from '../environment-exec/execute.js'
import { inspectCodexHookTrust } from './codex-hook-trust.js'

const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

// Codex 0.165.0 `app-server` reported these as the current hashes of the synthetic hooks below
// (2026-11-01), and reported each hook trusted only when its recorded trusted_hash matched.
const HOOKS = {
    description: 'Synthetic hooks.',
    hooks: {
        PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] },
            { hooks: [{ type: 'command', command: "printf 'it''s ok'", timeout: 30, statusMessage: 'checking' }] },
        ],
        Stop: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'true', async: true }] }],
    },
}
const MEASURED = {
    'pre_tool_use:0:0': 'sha256:764714315dbe4c5371706b6a0b78a3feb320d7ba156e97679691abac82047027',
    'pre_tool_use:1:0': 'sha256:88e790d19d856c9cbe3f3c69e63608438f51f5ccbce17d23ac673b6f050a2f22',
    'stop:0:0': 'sha256:fbc96d5753340a4590d23f35ed0cb94e8a483cbb94657362cbf3c934ad57886b',
}

async function estate(hooks: unknown = HOOKS) {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-codex-trust-')))
    scratch.push(base)
    const root = join(base, 'cockpit')
    const home = join(base, 'codex-home')
    await mkdir(join(root, '.codex'), { recursive: true })
    execFileSync('git', ['init', '--quiet', '-b', 'main', root])
    await mkdir(home)
    if (hooks !== null) await writeFile(join(root, '.codex/hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify(hooks))
    const alias = join(base, 'alias')
    await symlink(root, alias)
    const trust = (source: string, hashes: Record<string, string>, extra = '') => writeFile(join(home, 'config.toml'),
        Object.entries(hashes).map(([suffix, hash]) => `[hooks.state."${source}/.codex/hooks.json:${suffix}"]\ntrusted_hash = "${hash}"\n${extra}`).join('\n'))
    const inspect = (at = root) => inspectCodexHookTrust({ root: at, env: { CODEX_HOME: home, PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 }, executeProbe)
    return { root, alias, home, trust, inspect }
}

describe('Codex hook trust', () => {
    it.each(['root', 'nested'])('checks the discovered original-checkout hooks before considering %s worktree trust', async layout => {
        const fixture = await estate()
        execFileSync('git', ['-C', fixture.root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '--allow-empty', '-m', 'Create synthetic repository'])
        const checkout = join(fixture.root, '..', 'linked')
        execFileSync('git', ['-C', fixture.root, 'worktree', 'add', '--quiet', '--detach', checkout])
        const linked = layout === 'nested' ? join(checkout, 'nested') : checkout
        const original = layout === 'nested' ? join(fixture.root, 'nested') : fixture.root
        await mkdir(join(linked, '.codex'), { recursive: true })
        if (layout === 'nested') await mkdir(join(original, '.codex'), { recursive: true })
        await writeFile(join(linked, '.codex/hooks.json'), JSON.stringify(HOOKS))
        await fixture.trust(linked, MEASURED)
        const source = join(original, '.codex/hooks.json')
        const mismatch = [expect.objectContaining({ code: 'CODEX_HOOK_SOURCE_MISMATCH',
            message: expect.stringContaining(source), fix: expect.stringContaining('review') })]

        await rm(source, { force: true })
        expect(await fixture.inspect(linked)).toEqual(mismatch)
        await writeFile(source, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'legacy-guard' }] }] } }))
        expect(await fixture.inspect(linked)).toEqual(mismatch)

        await writeFile(source, JSON.stringify(HOOKS))
        const untrusted = await fixture.inspect(linked)
        expect(untrusted).toEqual([expect.objectContaining({ code: 'CODEX_HOOK_UNTRUSTED',
            message: expect.stringContaining(`Codex has not trusted the guard hook in ${source}`),
            fix: expect.stringContaining('codex -C <hook source directory>') })])
        expect(untrusted[0]!.message).toContain(original)
        await fixture.trust(original, MEASURED)
        expect(await fixture.inspect(linked)).toEqual([])
    })

    // Codex 0.166.0 sourced a directory's own hooks.json outside Git and in a bare repository's worktree,
    // so trust recorded there clears the warning rather than the check calling the source unverified.
    it.each(['outside Git', 'in a bare repository\'s worktree'])('checks the directory\'s own hooks %s', async layout => {
        const fixture = await estate()
        let root = fixture.root
        if (layout === 'outside Git') await rm(join(root, '.git'), { recursive: true })
        else {
            const bare = join(fixture.root, '..', 'bare.git')
            execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare])
            execFileSync('git', ['-C', fixture.root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                'commit', '--quiet', '--allow-empty', '-m', 'Create synthetic repository'])
            execFileSync('git', ['-C', fixture.root, 'push', '--quiet', bare, 'main'])
            root = join(fixture.root, '..', 'worktree')
            execFileSync('git', ['-C', bare, 'worktree', 'add', '--quiet', '--detach', root, 'main'])
            await mkdir(join(root, '.codex'))
            await writeFile(join(root, '.codex/hooks.json'), JSON.stringify(HOOKS))
        }
        expect(await fixture.inspect(root)).toEqual([expect.objectContaining({ code: 'CODEX_HOOK_UNTRUSTED',
            message: expect.stringContaining(`Codex has not trusted the guard hook in ${join(root, '.codex/hooks.json')}`) })])
        await fixture.trust(root, MEASURED)
        expect(await fixture.inspect(root)).toEqual([])
    })

    it('reports the hook untrusted until Codex has recorded trust for its current version', async () => {
        const fixture = await estate()
        const untrusted = await fixture.inspect()
        expect(untrusted).toEqual([expect.objectContaining({ severity: 'warning', code: 'CODEX_HOOK_UNTRUSTED', target: '.codex/hooks.json',
            message: expect.stringContaining('Codex has not trusted the guard hook'),
            fix: expect.stringContaining('codex -C <hook source directory> in a terminal (not codex exec)') })])
        // The remedy is a literal so the troubleshooting index can repeat it; the printed fix still
        // names this cockpit's configuration.
        expect(renderHumanDiagnostics(untrusted, undefined, { resolvedConfigPath: join(fixture.root, 'cockpit.toml'), generatedTargets: [] }))
            .toContain(`then run npx --no cockpit doctor --config ${join(fixture.root, 'cockpit.toml')}\n`)

        await fixture.trust(fixture.root, MEASURED)
        expect(await fixture.inspect()).toEqual([])
        // Trust is keyed by the session directory's spelling; a symlinked spelling still finds it.
        expect(await fixture.inspect(fixture.alias)).toEqual([])

        await fixture.trust(fixture.root, { ...MEASURED, 'stop:0:0': MEASURED['pre_tool_use:0:0'] })
        expect(await fixture.inspect()).toEqual([expect.objectContaining({ message: expect.stringContaining('trusted an earlier version') })])
        const { 'stop:0:0': _stop, ...partial } = MEASURED
        await fixture.trust(fixture.root, partial)
        expect(await fixture.inspect()).toEqual([expect.objectContaining({ message: expect.stringContaining('has not trusted') })])
        await fixture.trust(fixture.root, MEASURED, 'enabled = false\n')
        expect(await fixture.inspect()).toEqual([expect.objectContaining({ message: expect.stringContaining('is disabled in') })])
    })

    it('says unverified, never trusted, when the hook or the Codex configuration cannot be read', async () => {
        const unverified = [expect.objectContaining({ code: 'CODEX_HOOK_UNTRUSTED', message: expect.stringContaining('could not verify') })]
        const malformed = await estate()
        // A parse error quotes the lines around it, which may hold a credential, so none is reported.
        await writeFile(join(malformed.home, 'config.toml'), 'API_TOKEN = "sentinel-credential"\n[hooks.state\n')
        const reported = await malformed.inspect()
        expect(reported).toEqual(unverified)
        expect(JSON.stringify(reported)).not.toContain('sentinel-credential')
        expect(reported[0]!.message).toContain('at line 2')
        expect(await (await estate('{')).inspect()).toEqual(unverified)
        // A configuration over the read bound says so, rather than "unknown error".
        const oversized = await estate()
        await writeFile(join(oversized.home, 'config.toml'), `# ${'x'.repeat(4 * 1024 * 1024)}\n`)
        expect(await oversized.inspect()).toEqual([expect.objectContaining({ code: 'CODEX_HOOK_UNTRUSTED',
            message: expect.stringContaining(`reading ${join(oversized.home, 'config.toml')} failed: ${join(oversized.home, 'config.toml')} exceeds`) })])
        expect(await (await estate({ hooks: { PreToolUse: [{ hooks: [{ type: 'prompt' }] }] } })).inspect()).toEqual(unverified)
        const homeless = await estate()
        expect(await inspectCodexHookTrust({ root: homeless.root, env: {}, timeoutMs: 5_000 }, executeProbe)).toEqual(unverified)
        const noGit = await estate()
        expect(await inspectCodexHookTrust({ root: noGit.root, env: { CODEX_HOME: noGit.home, PATH: '/missing-git' }, timeoutMs: 5_000 }, executeProbe))
            .toEqual([expect.objectContaining({ message: expect.stringContaining('the hook source cannot be established') })])
        const unauthenticated = await estate()
        expect(await inspectCodexHookTrust({ root: unauthenticated.root,
            env: { CODEX_HOME: unauthenticated.home, PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 }, async step => ({ ...await executeProbe(step) })))
            .toEqual([expect.objectContaining({ message: expect.stringContaining('Git could not establish the original checkout hook source') })])
        // No published Codex hook means nothing to trust.
        expect(await (await estate(null)).inspect()).toEqual([])
        // Nor does a machine where Codex has never run as this user: no Codex home, no session to skip it.
        const codexless = await estate()
        await rm(codexless.home, { recursive: true })
        expect(await codexless.inspect()).toEqual([])
    })
})
