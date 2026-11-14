import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createProduct, explain, JOURNEY_TIMEOUT, type Product, removeScratch, type Run } from '../test-support/journey/harness.js'

afterAll(removeScratch)

const PACKAGE_LAUNCHER = './node_modules/@b00dea/cockpit/bin/cockpit.mjs'

// What a person or CI sees: the exit code and the diagnostic codes, not paths that name the launcher.
const outcome = (run: Run) => ({ status: run.status, codes: run.json?.diagnostics?.map((row) => `${row.severity} ${row.code}`).sort() })

// Claude Code runs the PreToolUse hook sync wrote, with the tool call as JSON on stdin; a refusal
// comes back as a permissionDecision, and silence with exit 0 lets the call run.
function guardDecision(product: Product, command: string, path: string): string {
    const hook = JSON.parse(product.read('.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command
    const result = spawnSync('/bin/sh', ['-c', hook], {
        cwd: product.root, env: { ...product.env, PATH: path, CLAUDE_PROJECT_DIR: product.root }, encoding: 'utf8',
        input: JSON.stringify({ session_id: 'journey', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: product.root, tool_input: { command } }),
    })
    if (result.status !== 0) return `exit ${result.status}: ${result.stderr}`
    return result.stdout === '' ? 'allow' : JSON.parse(result.stdout).hookSpecificOutput.permissionDecision
}

it('behaves the same through every documented launcher, any Node binary and under the guard', () => {
    const shop = createProduct('npm')
    const sync = shop.cockpit(['sync'])
    expect(sync.status, explain(sync)).toBe(0)
    // A second Node binary first on the agent tool's PATH, as when the terminal that ran sync uses one
    // Node and the agent tool another; the guard admits a `node` the agent's PATH names.
    const otherBin = join(shop.root, '..', 'agent-bin')
    const otherNode = join(otherBin, 'node')
    mkdirSync(otherBin)
    copyFileSync(process.execPath, otherNode, constants.COPYFILE_FICLONE)
    const agentPath = `${otherBin}:${dirname(process.execPath)}:${shop.env.PATH}`
    const launchers = [
        ['./node_modules/.bin/cockpit'],
        ['node', PACKAGE_LAUNCHER],
        [process.execPath, PACKAGE_LAUNCHER],
        [otherNode, PACKAGE_LAUNCHER],
    ]
    const expected = outcome(shop.cockpit(['check']))
    expect(expected.status).toBe(0)
    for (const launcher of launchers) {
        expect(outcome(shop.cockpit(['check'], { launcher })), launcher.join(' ')).toEqual(expected)
        const dryRun = shop.cockpit(['sync', '--dry-run'], { launcher })
        expect(dryRun.status, `${launcher.join(' ')}: ${explain(dryRun)}`).toBe(0)
        expect(guardDecision(shop, `${launcher.join(' ')} sync --config cockpit.toml --dry-run`, agentPath), launcher.join(' ')).toBe('allow')
    }
    // The control: the same hook refuses what it must, so `allow` above is a judgement, not silence.
    expect(guardDecision(shop, 'git push --force origin main', agentPath)).toBe('deny')
}, JOURNEY_TIMEOUT)

it('runs under pnpm\'s layout, through its shim and through the package path', () => {
    const shop = createProduct('pnpm', { layout: 'pnpm' })
    const sync = shop.cockpit(['sync'])
    expect(sync.status, explain(sync)).toBe(0)
    for (const launcher of [['./node_modules/.bin/cockpit'], [PACKAGE_LAUNCHER]]) {
        const check = shop.cockpit(['check'], { launcher })
        expect(check.status, `${launcher.join(' ')}: ${explain(check)}`).toBe(0)
    }
}, JOURNEY_TIMEOUT)
