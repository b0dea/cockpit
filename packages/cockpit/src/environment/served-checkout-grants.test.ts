import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectClaudeLocalGuard, writeClaudeLocalGuard } from './served-checkout-grants.js'

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
})
