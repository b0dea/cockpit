import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { claudeProjectKey } from './agent-homes.js'
import { guardAgentAreas } from './agent-workspaces.js'

describe('agent workspaces', () => {
    it('names a project as Claude Code does, hashing a path past 200 characters', () => {
        // Measured with Claude Code 2.1.323: a session started in this 264-character directory kept its
        // transcript under this name.
        const measured = `/private/tmp/cockpit-key-probe/sub/${'x'.repeat(229)}`
        expect(measured).toHaveLength(264)
        expect(claudeProjectKey(measured)).toBe(`${measured.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200)}-ycx1oj`)
        expect(claudeProjectKey('/workspace/my_project.v2')).toBe('-workspace-my-project-v2')
    })

    it('locates each tool\'s own files from the payload, the harness variables and the machine', () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-areas-')))
        try {
            const uid = userInfo().uid
            const home = join(base, 'home')
            const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { encoding: 'utf8' })
            mkdirSync(join(base, 'main'), { recursive: true })
            expect(git('init', '-q', join(base, 'main')).status).toBe(0)
            expect(git('-C', join(base, 'main'), 'commit', '-q', '--allow-empty', '-m', 'init').status).toBe(0)
            expect(git('-C', join(base, 'main'), 'worktree', 'add', '-q', join(base, 'linked')).status).toBe(0)
            const plain = join(base, 'plain')
            for (const directory of [home, plain, join(base, 'private-tmp'), join(base, 'shared-tmp')]) mkdirSync(directory, { recursive: true })
            chmodSync(join(base, 'private-tmp'), 0o700)
            chmodSync(join(base, 'shared-tmp'), 0o755)
            const transcript = join(home, '.claude/projects/-synthetic-project/session-one.jsonl')
            const claude = guardAgentAreas('claudecode', { transcriptPath: transcript, sessionId: 'session-one' },
                { home, uid, env: { TMPDIR: `${join(base, 'private-tmp')}/` } }, [join(base, 'linked'), plain])
            // A linked worktree writes its main checkout's memory; a directory outside Git is its own project.
            expect(claude.agentMemoryKeys).toEqual([claudeProjectKey(join(base, 'main')), claudeProjectKey(plain)])
            expect(claude.agentHomes).toEqual([{ tool: 'claude', path: join(home, '.claude') }])
            const scratchpad = join(realpathSync('/tmp'), `claude-${uid}`, '-synthetic-project', 'session-one', 'scratchpad')
            expect(claude.agentWorkspaces).toContainEqual({ kind: 'scratchpad', path: scratchpad })
            expect(claude.agentReadAreas).toEqual([join(home, '.claude/projects/-synthetic-project'), join(scratchpad, '..')])
            // A private TMPDIR is a workspace under both spellings, and /tmp is one too.
            expect(claude.agentWorkspaces).toContainEqual({ kind: 'temp', path: join(base, 'private-tmp') })
            expect(claude.agentWorkspaces).toContainEqual({ kind: 'temp', path: realpathSync('/tmp') })
            // The payload's scratchpad wins, and CLAUDE_CONFIG_DIR moves the home.
            const moved = guardAgentAreas('claudecode', { scratchpadDir: join(base, 'pad/scratchpad'), transcriptPath: transcript, sessionId: 'session-one' },
                { home, uid, env: { CLAUDE_CONFIG_DIR: join(base, 'config') } }, [plain])
            expect(moved.agentHomes).toEqual([{ tool: 'claude', path: join(base, 'config') }])
            expect(moved.agentWorkspaces).toContainEqual({ kind: 'scratchpad', path: join(base, 'pad/scratchpad') })
            // A TMPDIR others may enter is no workspace.
            const shared = guardAgentAreas('codexcli', {}, { home, uid, env: { TMPDIR: join(base, 'shared-tmp') } }, [plain])
            expect(shared.agentWorkspaces.map(area => area.path)).not.toContain(join(base, 'shared-tmp'))
            // Codex's home is CODEX_HOME, else where its rollout transcript lives, else ~/.codex.
            const rollout = join(base, 'codex-home/sessions/2026/11/13/rollout-2026-11-13T08-00-00-synthetic.jsonl')
            expect(guardAgentAreas('codexcli', { transcriptPath: rollout }, { home, uid, env: {} }, [plain]).agentHomes).toEqual([{ tool: 'codex', path: join(base, 'codex-home') }])
            expect(guardAgentAreas('codexcli', { transcriptPath: rollout }, { home, uid, env: { CODEX_HOME: join(base, 'exported') } }, [plain]).agentHomes)
                .toEqual([{ tool: 'codex', path: join(base, 'exported') }])
            expect(guardAgentAreas('codexcli', {}, { home, uid, env: {} }, [plain]).agentHomes).toEqual([{ tool: 'codex', path: join(home, '.codex') }])
            expect(guardAgentAreas('opencode', {}, { home, uid, env: { XDG_DATA_HOME: join(base, 'data') } }, [plain]).agentHomes)
                .toEqual([{ tool: 'opencode-data', path: join(base, 'data/opencode') }, { tool: 'opencode-config', path: join(home, '.config/opencode') }])
            // A worktree whose main checkout is gone names no project and stops nothing; a subagent's name passes through.
            mkdirSync(join(base, 'stale'))
            writeFileSync(join(base, 'stale/.git'), `gitdir: ${join(base, 'pruned/.git/worktrees/stale')}\n`)
            const stale = guardAgentAreas('claudecode', { agentType: 'reviewer' }, { home, uid, env: {} }, [join(base, 'stale'), plain])
            expect(stale.agentMemoryKeys).toEqual([claudeProjectKey(plain)])
            expect(stale.agentType).toBe('reviewer')
            // Neither the home directory nor one above it is ever an area.
            expect(guardAgentAreas('claudecode', {}, { home, uid, env: { CLAUDE_CONFIG_DIR: home } }, [plain]).agentHomes).toEqual([])
        } finally { rmSync(base, { recursive: true, force: true }) }
    })
})
