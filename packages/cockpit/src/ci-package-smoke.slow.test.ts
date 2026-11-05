import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/package-smoke.sh', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// A synthetic package with no dependencies, so the real pack and install need no registry.
function smoke(reported: string) {
    const root = mkdtempSync(join(tmpdir(), 'ci-package-smoke-'))
    roots.push(root)
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-cockpit', version: '1.2.3', bin: { cockpit: 'bin/cockpit.mjs' } }))
    writeFileSync(join(root, 'bin/cockpit.mjs'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(reported)})\n`, { mode: 0o755 })
    return spawnSync('bash', [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, npm_config_cache: join(root, '.cache') } })
}

it('passes when the CLI installed from the tarball reports the manifest version, and fails when it does not', () => {
    const passed = smoke('synthetic-cockpit 1.2.3 (Node synthetic; source development)')
    expect(passed.status, passed.stderr).toBe(0)
    expect(passed.stdout).toContain('package smoke: synthetic-cockpit 1.2.3')
    const stale = smoke('synthetic-cockpit 1.2.2 (Node synthetic; source development)')
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain("the installed CLI reported 'synthetic-cockpit 1.2.2")
}, 120_000)
