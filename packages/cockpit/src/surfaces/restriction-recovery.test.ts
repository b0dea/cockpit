import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { expandRestrictions } from './restrictions.js'

const scratch: string[] = []
afterAll(async () => { await Promise.all(scratch.map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
    const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-recovery-')))
    scratch.push(estate)
    const root = join(estate, "cock'pit$(printf injected); root")
    await mkdir(root)
    const configFile = "-cock'pit$(printf injected); config.toml"
    const configPath = join(root, configFile)
    const surfaces = new URL('../../surfaces/guards/', import.meta.url)
    const rendered = expandRestrictions({ canonicalProjectRoot: root,
        guardTemplate: await readFile(new URL('bash-guard.sh', surfaces), 'utf8'),
        guardPath: '.cockpit/guards/bash-guard.sh', configFile, instances: [],
        policy: { hosted_db_hosts: [], protected_branches: ['main'], readonly: { kind: 'agent', name: 'evaluator' } },
        adapters: await Promise.all(['claude', 'codex', 'opencode'].map(async name =>
            JSON.parse(await readFile(new URL(`${name}.adapter.json`, surfaces), 'utf8')) as unknown)),
    })
    if (rendered.kind !== 'complete') throw new Error(rendered.message)
    const run = (harness: 'claudecode' | 'codexcli', command = 'git restore -- .cockpit/guards/bash-guard.sh', event: 'PreToolUse' | 'SessionStart' = 'PreToolUse') => {
        const registration = rendered.targets.find(target => target.target === harness)!.files[0]!
        const hook = (JSON.parse(registration.bytes) as { hooks: Record<typeof event, Array<{ hooks: Array<{ command: string }> }>> }).hooks[event][0]!.hooks[0]!.command
        return spawnSync('/bin/sh', ['-c', hook], { cwd: root, encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } }),
        })
    }
    const launcher = join(root, 'node_modules/@b00dea/cockpit/bin/cockpit.mjs')
    const handler = join(root, 'node_modules/@b00dea/cockpit/dist/cli.js')
    // The hook command only runs the committed guard script, which carries the recovery text.
    const guard = join(root, rendered.sharedGuard.path)
    await mkdir(dirname(guard), { recursive: true })
    await writeFile(guard, rendered.sharedGuard.bytes)
    return { root, configPath, rendered, run, launcher, handler, guard }
}

it.each(['claudecode', 'codexcli'] as const)('holds %s calls when retained hooks outlive the configured branch', async harness => {
    const { root, configPath, run } = await fixture()
    for (const command of ['git restore -- .cockpit/guards/bash-guard.sh', 'npx --no cockpit sync --config cockpit.toml']) {
        const refused = run(harness, command)
        expect(refused).toMatchObject({ status: 2, stdout: '' })
        expect(refused.stderr).toContain(configPath)
        expect(refused.stderr).toContain('Local hook changes can remain after switching branches')
        expect(refused.stderr).toContain('a human must return to the intended configured checkout/worktree and branch')
        expect(refused.stderr).toContain('preserve native guards')
        expect(refused.stderr).toContain('Close and reopen the agent')
        expect(refused.stderr).not.toContain('git restore')
        expect(refused.stderr).not.toContain('sync --config')
    }
    expect(existsSync(join(root, 'injected'))).toBe(false)
})

it('diagnoses a missing OpenCode guard through the emitted plugin without admitting the tool call', async () => {
    const { root, configPath, rendered, guard: committed } = await fixture()
    await rm(committed)
    const plugin = rendered.targets.find(target => target.target === 'opencode')!.files[0]!
    const path = join(root, plugin.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, plugin.bytes)
    // A command larger than a pipe buffer makes the launcher exit before the call is written, as a small
    // one sometimes does on a loaded machine: the refusal and its reason must survive the closed pipe.
    const run = (padding = 0) => spawnSync(process.execPath, ['--input-type=module', '--eval',
        `const { CockpitRestrictions } = await import(${JSON.stringify(pathToFileURL(path).href)}); const hooks = await CockpitRestrictions(); await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git restore -- .cockpit/guards/bash-guard.sh' + ' '.repeat(${padding}) } })`,
    ], { cwd: root, encoding: 'utf8' })
    for (const padding of [0, 1024 * 1024]) {
        expect(run(padding)).toMatchObject({ status: 1, stdout: '', stderr: expect.stringContaining('Local hook changes can remain after switching branches') })
    }
    await writeFile(configPath, '[cockpit]\n')
    expect(run()).toMatchObject({ status: 1, stdout: '', stderr: expect.stringContaining('@b00dea/cockpit is not installed or is incomplete') })
    // An allow from a guard that exited before reading the whole call judged none of it.
    const guard = join(root, '.cockpit/guards/bash-guard.sh')
    await mkdir(dirname(guard), { recursive: true })
    await writeFile(guard, 'exit 0\n')
    expect(run(1024 * 1024)).toMatchObject({ status: 1, stdout: '', stderr: expect.stringContaining('cockpit restriction guard failed: spawnSync /bin/bash EPIPE') })
})

it('uses the same recovery at the shared launcher when machine-local identity is unavailable', async () => {
    const { root, configPath, rendered, launcher, handler } = await fixture()
    const path = join(root, rendered.sharedGuard.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, rendered.sharedGuard.bytes)
    const run = () => spawnSync('/bin/bash', [path, '--harness', 'codexcli'], { cwd: root, encoding: 'utf8', input: '{}' })
    expect(run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('Local hook changes can remain after switching branches') })
    await writeFile(configPath, '[cockpit]\n')
    expect(run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('@b00dea/cockpit is not installed or is incomplete') })
    await mkdir(dirname(launcher), { recursive: true })
    await mkdir(dirname(handler), { recursive: true })
    await writeFile(handler, '')
    await writeFile(launcher, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
    const refused = run()
    expect(refused).toMatchObject({ status: 2, stdout: '' })
    const command = /a human must run `([^`]+)`/.exec(refused.stderr)?.[1]
    expect(command, refused.stderr).toBeDefined()
    expect(spawnSync('/bin/sh', ['-c', command!], { cwd: root, encoding: 'utf8' }))
        .toMatchObject({ status: 0, stderr: '', stdout: `<sync>\n<--config>\n<${configPath}>\n` })
})

it.each(['claudecode', 'codexcli'] as const)('surfaces stale %s session setup before the first held tool call', async harness => {
    const { root, configPath, run, launcher, handler } = await fixture()
    const missingConfig = run(harness, '', 'SessionStart')
    expect(missingConfig.status).toBe(0)
    expect(missingConfig.stdout).toContain('Local hook changes can remain after switching branches')
    await writeFile(configPath, '[cockpit]\n')
    const missingInstall = run(harness, '', 'SessionStart')
    expect(missingInstall.status).toBe(0)
    expect(missingInstall.stdout).toContain('@b00dea/cockpit is not installed or is incomplete')
    await mkdir(dirname(launcher), { recursive: true })
    await mkdir(dirname(handler), { recursive: true })
    await writeFile(handler, '')
    await writeFile(launcher, '#!/bin/sh\nprintf "<%s>\\n" "$@"\nexit 2\n', { mode: 0o755 })
    const checked = run(harness, '', 'SessionStart')
    expect(checked).toMatchObject({ status: 0, stderr: '', stdout: `<check>\n<--config>\n<${configPath}>\n` })
    expect(existsSync(join(root, 'injected'))).toBe(false)
})

it.each(['claudecode', 'codexcli'] as const)('names the missing package before prescribing %s regeneration', async harness => {
    const { configPath, run, launcher } = await fixture()
    await writeFile(configPath, '[cockpit]\n')
    for (const incomplete of [false, true]) {
        if (incomplete) {
            await mkdir(dirname(launcher), { recursive: true })
            await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        }
        const refused = run(harness)
        expect(refused).toMatchObject({ status: 2, stdout: '' })
        expect(refused.stderr).toContain('@b00dea/cockpit is not installed or is incomplete')
        expect(refused.stderr).toContain("repository's documented dependency-install command")
        expect(refused.stderr).toContain('in a terminal, outside the agent')
        expect(refused.stderr).not.toContain('npx')
        expect(refused.stderr).not.toContain('sync --config')
        expect(refused.stderr).not.toContain('git restore')
    }
})

it.each(['claudecode', 'codexcli'] as const)('prints an executable quoted recovery command for %s without running it', async harness => {
    const { root, configPath, run, launcher, handler } = await fixture()
    await writeFile(configPath, '[cockpit]\n')
    await mkdir(dirname(launcher), { recursive: true })
    await mkdir(dirname(handler), { recursive: true })
    await writeFile(handler, '')
    const canary = `${launcher}.called`
    await writeFile(launcher, '#!/bin/sh\n: > "$0.called"\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
    const refused = run(harness)
    expect(refused).toMatchObject({ status: 2, stdout: '' })
    expect(refused.stderr).toContain('a human must run')
    expect(refused.stderr).toContain('in a terminal, outside the agent')
    expect(refused.stderr).not.toContain('git restore')
    const command = /a human must run `([^`]+)`/.exec(refused.stderr)?.[1]
    expect(command, refused.stderr).toBeDefined()
    expect(existsSync(canary)).toBe(false)
    const captured = spawnSync('/bin/sh', ['-c', command!], { cwd: root, encoding: 'utf8' })
    expect(captured).toMatchObject({ status: 0, stderr: '', stdout: `<sync>\n<--config>\n<${configPath}>\n` })
    expect(existsSync(canary)).toBe(true)
    expect(existsSync(join(root, 'injected'))).toBe(false)
})

it.each(['claudecode', 'codexcli'] as const)('does not take a directory at the launcher path for an installed %s package', async harness => {
    const { configPath, run, launcher, handler } = await fixture()
    await writeFile(configPath, '[cockpit]\n')
    await mkdir(launcher, { recursive: true })
    await mkdir(dirname(handler), { recursive: true })
    await writeFile(handler, '')
    const refused = run(harness)
    expect(refused).toMatchObject({ status: 2, stdout: '' })
    expect(refused.stderr).toContain('@b00dea/cockpit is not installed or is incomplete')
    expect(refused.stderr).not.toContain('sync --config')
    const session = run(harness, '', 'SessionStart')
    expect(session.status).toBe(0)
    expect(session.stdout).toContain('@b00dea/cockpit is not installed or is incomplete')
})

it('names no invented path and asks for the cockpit root when the hook finds no checkout', async () => {
    const { root, rendered } = await fixture()
    const configFile = "-cock'pit$(printf injected); config.toml"
    const hook = (JSON.parse(rendered.targets.find(target => target.target === 'claudecode')!.files[0]!.bytes) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!.hooks[0]!.command
    const refused = spawnSync('/bin/sh', ['-c', hook], { cwd: root, encoding: 'utf8', input: '{}', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } })
    expect(refused).toMatchObject({ status: 2, stdout: '' })
    expect(refused.stderr).toContain('cockpit guard failed (127): <unset>/.cockpit/guards/bash-guard.sh; sync the cockpit')
    expect(refused.stderr).not.toContain(' /.cockpit/')
    expect(refused.stderr).not.toContain(` /${configFile}`)
    expect(existsSync(join(root, 'injected'))).toBe(false)
})
