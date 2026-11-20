import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runGuardImportApplication } from './application/adopt.js'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

function cockpit(files: Readonly<Record<string, string>>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-guard-import-')))
    scratch.push(root)
    writeFileSync(join(root, 'cockpit.toml'), '')
    mkdirSync(join(root, 'app'))
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), text)
        chmodSync(join(root, path), 0o755)
    }
    return root
}

// Synthetic stand-ins for both hooks: each reads the PreToolUse payload from standard input, as an agent tool sends it.
const OLD_HOOK = `#!/bin/bash
input=$(cat)
[ -n "\${LEAKED:-}" ] && { echo "saw a variable it was not given" >&2; exit 2; }
case "$input" in *'"crash"'*) echo "jq: not found" >&2; exit 1 ;; esac
case "$input" in *'"npm publish'*) echo "BLOCKED: publishing is a release step" >&2; exit 2 ;; esac
case "$input" in *'"make deploy"'*) [ "$(pwd -P)" = "$CLAUDE_PROJECT_DIR/app" ] && { echo "no deploys from app" >&2; exit 2; } ;; esac
exit 0
`
const COCKPIT_GUARD = `#!/bin/bash
input=$(cat)
[ "$1 $2" = "--harness claudecode" ] || exit 9
case "$input" in *'cat .env'*) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing to read a secret file."}}\\n' ;;
*) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok"}}\\n' ;; esac
`

describe('guard import application', () => {
    it('replays each case through both hooks in its directory, with a minimal environment, and runs no command', async () => {
        const root = cockpit({ 'old-guard.sh': OLD_HOOK, '.cockpit/guards/bash-guard.sh': COCKPIT_GUARD })
        writeFileSync(join(root, 'cases.json'), JSON.stringify([
            { id: 'list', command: 'ls' },
            { id: 'publish', command: 'npm publish --access public' },
            { id: 'deploy-root', command: 'make deploy' },
            { id: 'deploy-app', command: 'make deploy', cwd: 'app' },
            { id: 'secret', command: 'cat .env' },
            { id: 'marker', command: `touch ${join(root, 'ran')}` },
            { id: 'crash', command: 'crash' },
        ]))
        const outcome = await runGuardImportApplication({ configPath: join(root, 'cockpit.toml'), hookScript: join(root, 'old-guard.sh'),
            casesFile: join(root, 'cases.json'), env: { PATH: process.env.PATH, HOME: process.env.HOME, LEAKED: '1' } }, { execute: executeProbe })
        // A hook that failed on a case leaves a hole in the comparison, so the run says so and fails.
        expect(outcome.status).toBe(2)
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'ADOPT_HOOK_EXECUTED' }),
            expect.objectContaining({ severity: 'error', code: 'ADOPT_CASES_UNCOMPARED', message: expect.stringContaining('(crash)') })])
        expect(outcome.result?.oldOnly.map(row => row.case.id)).toEqual(['publish', 'deploy-app'])
        expect(outcome.result?.cockpitOnly.map(row => row.case.id)).toEqual(['secret'])
        expect(outcome.result?.errors.map(row => row.case.id)).toEqual(['crash'])
        expect(outcome.result?.proposals.map(row => row.prefix)).toEqual([['npm', 'publish']])
        expect(outcome.result?.unproposed).toEqual([{ caseId: 'deploy-app', why: expect.stringContaining('also refuses a case the old guard allowed') }])
        expect(outcome.artifact).toContain('Refused only by cockpit (1)')
        expect(() => realpathSync(join(root, 'ran'))).toThrow()
    })

    it('refuses before replaying any case when there is no working cockpit guard to compare with', async () => {
        const missing = cockpit({ 'old-guard.sh': OLD_HOOK })
        // What the installed guard answers when it cannot judge at all, such as with a stale identity.
        const held = cockpit({ 'old-guard.sh': OLD_HOOK, '.cockpit/guards/bash-guard.sh':
            '#!/bin/bash\nprintf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"guard held"}}\\n\'\n' })
        for (const [root, code] of [[missing, 'ADOPT_INPUT_UNAVAILABLE'], [held, 'ADOPT_COCKPIT_GUARD_UNAVAILABLE']] as const) {
            writeFileSync(join(root, 'cases.json'), JSON.stringify([{ id: 'marker', command: `touch ${join(root, 'ran')}` }]))
            const outcome = await runGuardImportApplication({ configPath: join(root, 'cockpit.toml'), hookScript: join(root, 'old-guard.sh'),
                casesFile: join(root, 'cases.json'), env: { PATH: process.env.PATH } }, { execute: executeProbe })
            expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code, fix: expect.stringContaining('sync --config') }] })
        }
    })

    it('refuses a case whose directory lies outside the cockpit root', async () => {
        const root = cockpit({ 'old-guard.sh': OLD_HOOK, '.cockpit/guards/bash-guard.sh': COCKPIT_GUARD })
        writeFileSync(join(root, 'cases.json'), JSON.stringify([{ id: 'up', command: 'ls', cwd: '..' }]))
        const outcome = await runGuardImportApplication({ configPath: join(root, 'cockpit.toml'), hookScript: join(root, 'old-guard.sh'),
            casesFile: join(root, 'cases.json'), env: { PATH: process.env.PATH } }, { execute: executeProbe })
        expect(outcome).toMatchObject({ status: 2, diagnostics: [{ code: 'ADOPT_CASES_INVALID', message: expect.stringContaining('outside the cockpit root') }] })
    })
})
