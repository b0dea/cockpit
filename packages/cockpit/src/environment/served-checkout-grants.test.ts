import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectAgentSettingsHazards, inspectClaudeLocalGuard, writeClaudeLocalGuard } from './served-checkout-grants.js'
import { writeGuardRecord } from '../guards/guard-record.js'

describe('Claude Code local guard registration', () => {
    it('repeats the committed guard hook in the local settings beside a person\'s own, and doctor flags it missing', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-local-guard-')))
        try {
            const settingsDirectory = join(root, '.claude')
            mkdirSync(settingsDirectory)
            const committed = (command: string) => ({ matcher: 'Bash|Edit|Write', hooks: [{ type: 'command', command, timeout: 30 }] })
            const guard = 'd=x; H="$r/.cockpit/guards/bash-guard.sh"; /bin/bash "$H" --harness claudecode'
            const write = (file: string, value: unknown) => writeFileSync(join(settingsDirectory, file), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
            const local = () => JSON.parse(readFileSync(join(settingsDirectory, 'settings.local.json'), 'utf8'))
            write('settings.json', { hooks: { PreToolUse: [committed(guard)], SessionStart: [{ hooks: [{ type: 'command', command: 'check' }] }] } })
            // A person's own settings and hooks stay, and an earlier guard registration is replaced, not repeated.
            const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'person-hook.sh' }] }
            write('settings.local.json', { permissions: { additionalDirectories: ['/workspace/served'] },
                hooks: { PreToolUse: [own, committed(`${guard} --old`)], PostToolUse: [own] } })
            expect(inspectClaudeLocalGuard(root)).toEqual([expect.objectContaining({ severity: 'warning', code: 'CLAUDE_LOCAL_HOOK_MISSING' })])
            expect(await writeClaudeLocalGuard(root)).toEqual({ kind: 'complete' })
            expect(local()).toEqual({ permissions: { additionalDirectories: ['/workspace/served'] },
                hooks: { PreToolUse: [own, committed(guard)], PostToolUse: [own] } })
            expect(inspectClaudeLocalGuard(root)).toEqual([])
            // Once nothing commits a guard registration, cockpit's own is taken back and the person's stays.
            write('settings.json', { hooks: {} })
            expect(await writeClaudeLocalGuard(root)).toEqual({ kind: 'complete' })
            expect(local()).toEqual({ permissions: { additionalDirectories: ['/workspace/served'] }, hooks: { PreToolUse: [own], PostToolUse: [own] } })
            // A file Claude Code would drop as unreadable is never rewritten.
            write('settings.json', { hooks: { PreToolUse: [committed(guard)] } })
            write('settings.local.json', '{ "hooks": ')
            expect(await writeClaudeLocalGuard(root)).toMatchObject({ kind: 'refusal', message: expect.stringContaining('settings.local.json') })
            expect(readFileSync(join(settingsDirectory, 'settings.local.json'), 'utf8')).toBe('{ "hooks": ')
            expect(inspectClaudeLocalGuard(root)).toEqual([expect.objectContaining({ code: 'CLAUDE_LOCAL_HOOK_MISSING' })])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('flags an agent tool\'s settings below the cockpit root and any settings that switch hooks off', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-settings-hazards-')))
        try {
            for (const directory of ['.claude', 'app/.claude', 'app/web/.codex', 'node_modules/pkg/.claude', 'docs']) mkdirSync(join(root, directory), { recursive: true })
            const write = (path: string, value: unknown) => writeFileSync(join(root, path), `${JSON.stringify(value)}\n`)
            write('.claude/settings.json', { hooks: {} })
            write('docs/settings.json', {})
            expect(inspectAgentSettingsHazards(root)).toEqual([])
            write('app/.claude/settings.json', { hooks: {} })
            writeFileSync(join(root, 'app/web/.codex/config.toml'), '')
            // Installed packages are not where a session starts.
            write('node_modules/pkg/.claude/settings.json', {})
            const nested = inspectAgentSettingsHazards(root)
            expect(nested).toEqual([expect.objectContaining({ severity: 'warning', code: 'AGENT_SETTINGS_NESTED', message: expect.stringContaining('app/.claude/settings.json') })])
            expect(nested[0]!.message).toContain('app/web/.codex/config.toml')
            expect(nested[0]!.message).not.toContain('node_modules')
            // disableAllHooks anywhere Claude Code reads it switches the guard off, the local settings included.
            write('.claude/settings.local.json', { disableAllHooks: true })
            expect(inspectAgentSettingsHazards(root)).toContainEqual(expect.objectContaining({ code: 'AGENT_HOOKS_DISABLED', message: expect.stringContaining('.claude/settings.local.json') }))
            write('.claude/settings.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'H="$r/.cockpit/guards/bash-guard.sh"; /bin/bash "$H" --harness claudecode' }] }] } })
            write('.claude/settings.local.json', { disableAllHooks: true, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'H="$r/.cockpit/guards/bash-guard.sh"; /bin/bash "$H" --harness claudecode' }] }] } })
            expect(inspectClaudeLocalGuard(root)).toEqual([expect.objectContaining({ code: 'CLAUDE_LOCAL_HOOK_MISSING', message: expect.stringContaining('disableAllHooks') })])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('flags a Git repository below the cockpit root that is neither its worktree nor a declared sibling', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'nested-repositories-')))
        try {
            const git = (...args: string[]) => expect(spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { cwd: root }).status).toBe(0)
            git('init', '--quiet')
            git('commit', '--quiet', '--allow-empty', '-m', 'init')
            git('worktree', 'add', '--quiet', 'worktrees/wt')
            mkdirSync(join(root, 'app'))
            git('init', '--quiet', 'app')
            expect(inspectAgentSettingsHazards(root, [join(root, 'app')])).toEqual([])
            mkdirSync(join(root, 'pkg/.git'), { recursive: true })
            writeFileSync(join(root, 'stray'), '')
            mkdirSync(join(root, 'docs'))
            writeFileSync(join(root, 'docs/.git'), 'gitdir: /workspace/nowhere\n')
            const found = inspectAgentSettingsHazards(root, [join(root, 'app')])
            expect(found).toEqual([expect.objectContaining({ severity: 'warning', code: 'AGENT_NESTED_REPOSITORY' })])
            expect(found[0]!.message).toContain('pkg/.git')
            expect(found[0]!.message).toContain('docs/.git')
            expect(found[0]!.message).not.toContain('worktrees/wt')
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('flags a guard script that no longer matches the digest sync recorded, at the root and in a worktree kept below it', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-records-')))
        const home = realpathSync(mkdtempSync(join(tmpdir(), 'guard-records-home-')))
        try {
            const git = (...args: string[]) => expect(spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { cwd: root }).status).toBe(0)
            const guard = (checkout: string) => {
                mkdirSync(join(checkout, '.cockpit/guards'), { recursive: true })
                mkdirSync(join(checkout, '.cockpit/local'), { recursive: true })
                writeFileSync(join(checkout, '.cockpit/guards/bash-guard.sh'), 'guard\n')
                writeFileSync(join(checkout, '.cockpit/local/guard-identity'), 'identity\n')
            }
            git('init', '--quiet')
            git('commit', '--quiet', '--allow-empty', '-m', 'init')
            git('worktree', 'add', '--quiet', 'worktrees/wt')
            guard(root)
            const codes = () => inspectAgentSettingsHazards(root, [], home).map(finding => `${finding.code} ${finding.target}`)
            expect(codes()).toEqual(['GUARD_RECORD_MISMATCH .cockpit/guards/bash-guard.sh', 'GUARD_WORKTREE_UNGUARDED worktrees/wt'])
            await writeGuardRecord(root, home)
            guard(join(root, 'worktrees/wt'))
            expect(codes()).toEqual(['GUARD_WORKTREE_UNGUARDED worktrees/wt'])
            await writeGuardRecord(join(root, 'worktrees/wt'), home)
            expect(codes()).toEqual([])
            writeFileSync(join(root, '.cockpit/guards/bash-guard.sh'), 'exit 0\n')
            expect(codes()).toEqual(['GUARD_RECORD_MISMATCH .cockpit/guards/bash-guard.sh'])
        } finally {
            rmSync(root, { recursive: true, force: true })
            rmSync(home, { recursive: true, force: true })
        }
    })
})
