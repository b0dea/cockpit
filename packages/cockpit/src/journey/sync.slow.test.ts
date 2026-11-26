import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createMachine, createProduct, JOURNEY_TIMEOUT, linkedWorktree, ok, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

it('applies a narrowing edit to cockpit.toml on an agent\'s sync, and a widening one only on a person\'s yes at a terminal', () => {
    const shop = createProduct('shop')
    ok(shop, ['sync'])
    shop.git('add', '--all')
    shop.git('commit', '--quiet', '--message', 'Adopt cockpit')

    shop.write('cockpit.toml', shop.read('cockpit.toml').replace('purpose = "Synthetic app"', 'purpose = "Storefront app"'))
    expect(shop.cockpit(['check']).status).toBe(2)
    expect(ok(shop, ['sync']).json?.result.changes).toContainEqual({ operation: 'write', path: 'AGENTS.md' })
    expect(shop.read('AGENTS.md')).toContain('Storefront app')
    ok(shop, ['check'])

    const settings = shop.read('.claude/settings.json')
    shop.write('cockpit.toml', `${shop.read('cockpit.toml')}
[[guards.allow]]
argv = ["make", "deploy-preview"]
reason = "Deploys a throwaway preview"
`)
    const check = shop.cockpit(['check'])
    expect(check.status).toBe(2)
    expect(check.errors).toContain('GUARD_CONFIG_WIDENED')
    const sync = shop.cockpit(['sync'])
    expect(sync.status).toBe(2)
    expect(sync.errors).toContain('GUARD_CONFIG_WIDENED')
    expect(shop.read('.claude/settings.json')).toBe(settings)

    // A person runs approve in a terminal of their own, reads what widens and answers y; no digest is typed.
    const confirmed = shop.cockpit(['approve'], { json: false, answer: 'y' })
    expect(confirmed.status, confirmed.stdout).toBe(0)
    expect(confirmed.stdout).toContain('guards.allow')
    expect(confirmed.stdout.match(/Approve\? \[y\/N/g)).toHaveLength(1)
    // check failed with GUARD_CONFIG_WIDENED before the yes; it passes once the edit is applied.
    ok(shop, ['check'])
}, JOURNEY_TIMEOUT)

// An upgrade approved in a linked worktree installs the new cockpit there and runs its sync, which binds the worktree's
// guard to it. An agent's bind after that, through the main checkout's older cockpit or the worktree's own, was refused
// with advice to install the older version or to have a person sync again, a sync that then found nothing to do.
it('binds a linked worktree\'s guard in the sync an upgrade there runs, and answers a later bind that it is already bound', () => {
    const machine = createMachine('worktree-upgrade')
    const shop = createProduct('worktree-upgrade', { machine })
    ok(shop, ['sync'])
    shop.git('add', '--all')
    shop.git('commit', '--quiet', '--message', 'Adopt cockpit')
    const feature = linkedWorktree(shop, 'worktree-upgrade-feature', machine)
    const config = join(feature.root, 'cockpit.toml')
    const [, node, module] = shop.read('.cockpit/local/guard-identity').split('\n') as [string, string, string]
    const version = (JSON.parse(readFileSync(join(dirname(dirname(module)), 'package.json'), 'utf8')) as { version: string }).version
    const bind = (launcher: string, json = false) => {
        const run = spawnSync(node, [launcher, 'sync', '--config', config, '--bind-worktree', ...json ? ['--json'] : []], { cwd: feature.root, env: feature.env, encoding: 'utf8' })
        return { status: run.status, stdout: run.stdout, output: `${run.stdout}${run.stderr}` }
    }
    const mainLauncher = join(dirname(dirname(module)), 'bin/cockpit.mjs')
    const ownLauncher = join(feature.root, 'node_modules/@b00dea/cockpit/bin/cockpit.mjs')
    // A new worktree's agent binds its guard through the main checkout's cockpit.
    const first = bind(mainLauncher)
    expect(first.status, first.output).toBe(0)
    expect(first.stdout).toContain(`Sync bound the guard of ${feature.root} to @b00dea/cockpit ${version} at ${dirname(dirname(module))}.`)

    // A pin moved past the cockpit the guard is bound to is not already bound, though the handler's bytes still match.
    feature.write('package.json', feature.read('package.json').replace(`"@b00dea/cockpit": "${version}"`, '"@b00dea/cockpit": "9.9.9"'))
    expect(bind(mainLauncher).output).toContain('GUARD_WORKTREE_BIND_REFUSED')

    // The person approves an upgrade there: the install pins and installs the new release, then its sync runs.
    feature.install('9.9.9')
    const approved = feature.cockpit(['sync'], { json: false })
    expect(approved.status, `${approved.stdout}${approved.stderr}`).toBe(0)
    expect(approved.stdout).toContain(`Sync bound the guard of ${feature.root} to @b00dea/cockpit 9.9.9 at ${feature.root}/node_modules/@b00dea/cockpit.`)
    const hook = (JSON.parse(feature.read('.claude/settings.json')) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }).hooks.PreToolUse.at(-1)!.hooks[0]!.command
    const write = () => {
        const run = spawnSync('/bin/sh', ['-c', hook], { cwd: feature.root, encoding: 'utf8', env: { ...feature.env, CLAUDE_PROJECT_DIR: feature.root },
            input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: feature.root, tool_input: { file_path: join(feature.root, 'notes.md'), content: 'synthetic' } }) })
        expect(run.status, run.stderr).toBe(0)
        return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string } : { permissionDecision: 'allow', permissionDecisionReason: '' }
    }
    expect(write().permissionDecision).toBe('allow')
    // Nothing is left to bind, whichever cockpit the agent runs the bind with, and the person's second sync finds nothing.
    for (const launcher of [mainLauncher, ownLauncher]) {
        const again = bind(launcher)
        expect(again.status, again.output).toBe(0)
        expect(again.stdout).toBe(`Nothing to bind: the guard of ${feature.root} is already bound to @b00dea/cockpit 9.9.9 at ${feature.root}/node_modules/@b00dea/cockpit; nothing was written.\n`)
    }
    expect(feature.cockpit(['sync'], { json: false }).stdout).toMatch(/^Nothing to sync: all \d+ generated files were already current\.\n$/)

    // A binding gone stale, as when the installed cockpit is replaced, is not already bound. The main checkout's cockpit
    // cannot bind a worktree pinning another release, so the bind names the one step that does, and the worktree's own
    // guard no longer offers that bind.
    const handler = join(feature.root, 'node_modules/@b00dea/cockpit/dist/cli.js')
    writeFileSync(handler, `${readFileSync(handler, 'utf8')}\n// replaced\n`)
    const stale = bind(mainLauncher, true)
    expect(stale.status, stale.output).toBe(2)
    expect(JSON.parse(stale.stdout)).toMatchObject({ diagnostics: [{ code: 'GUARD_WORKTREE_BIND_REFUSED',
        message: `package.json in ${feature.root} pins @b00dea/cockpit 9.9.9, newer than the ${version} running: that checkout runs its own cockpit, not this one, so the worktree's guard was not bound and nothing was written` }],
        guidance: [{ text: `a person reviews the worktree, then runs \`cd ${feature.root} && ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml\` in a terminal outside the agent, which binds the worktree's guard to the cockpit installed there` }] })
    expect(write()).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.not.stringContaining('--bind-worktree') })
    // With an upgrade waiting for the person, the approve that installs and syncs it is the one step.
    feature.write('package-lock.json', '{}\n')
    const queued = spawnSync(node, [ownLauncher, 'upgrade', '10.0.0', '--config', 'cockpit.toml', '--json'], { cwd: feature.root, env: { ...feature.env, CLAUDECODE: '1' }, encoding: 'utf8' })
    expect(JSON.parse(queued.stdout).diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_PERSON_REQUIRED',
        message: expect.stringContaining('the approval installs it and syncs, which binds this checkout\'s guard to it') })])
    expect(JSON.parse(bind(mainLauncher, true).stdout)).toMatchObject({ diagnostics: [{ code: 'GUARD_WORKTREE_BIND_REFUSED' }],
        guidance: [{ text: `a person runs \`cd ${feature.root} && npx --no cockpit approve\` in a terminal outside the agent: the upgrade waiting there installs and syncs, which binds the worktree's guard to the cockpit installed there, and no bind follows it` }] })
}, JOURNEY_TIMEOUT)
