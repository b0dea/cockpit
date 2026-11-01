import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
    await mkdir(home)
    if (hooks !== null) await writeFile(join(root, '.codex/hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify(hooks))
    const alias = join(base, 'alias')
    await symlink(root, alias)
    const configPath = join(root, 'cockpit.toml')
    const trust = (source: string, hashes: Record<string, string>, extra = '') => writeFile(join(home, 'config.toml'),
        Object.entries(hashes).map(([suffix, hash]) => `[hooks.state."${source}/.codex/hooks.json:${suffix}"]\ntrusted_hash = "${hash}"\n${extra}`).join('\n'))
    const inspect = (at = root) => inspectCodexHookTrust({ root: at, configPath, env: { CODEX_HOME: home } })
    return { root, alias, home, trust, inspect }
}

describe('Codex hook trust', () => {
    it('reports the hook untrusted until Codex has recorded trust for its current version', async () => {
        const fixture = await estate()
        const untrusted = await fixture.inspect()
        expect(untrusted).toEqual([expect.objectContaining({ severity: 'warning', code: 'CODEX_HOOK_UNTRUSTED', target: '.codex/hooks.json',
            message: expect.stringContaining('Codex has not trusted the guard hook'),
            fix: expect.stringContaining(`codex -C ${fixture.root} in a terminal (not codex exec)`) })])
        expect(untrusted[0]!.fix).toContain(`npx --no cockpit doctor --config ${join(fixture.root, 'cockpit.toml')}`)

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
        expect(await (await estate({ hooks: { PreToolUse: [{ hooks: [{ type: 'prompt' }] }] } })).inspect()).toEqual(unverified)
        const homeless = await estate()
        expect(await inspectCodexHookTrust({ root: homeless.root, configPath: join(homeless.root, 'cockpit.toml'), env: {} })).toEqual(unverified)
        // No published Codex hook means nothing to trust.
        expect(await (await estate(null)).inspect()).toEqual([])
    })
})
