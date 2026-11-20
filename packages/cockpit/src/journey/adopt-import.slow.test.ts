import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createProduct, explain, JOURNEY_TIMEOUT, ok, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

// A team's guard from before cockpit: a PreToolUse hook that refuses publishing and infrastructure teardown.
const OLD_GUARD = `#!/bin/sh
input=$(cat)
case "$input" in
  *'"npm publish'*) echo "BLOCKED: publishing is a release step" >&2; exit 2 ;;
  *'"terraform destroy'*) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no teardown"}}\\n' ;;
esac
exit 0
`

it('replays an existing guard\'s cases beside the installed cockpit guard and proposes deny rules for its gaps', () => {
    const shop = createProduct('shop-import', { files: {
        'old-guard.sh': OLD_GUARD,
        'cases.json': JSON.stringify([
            { id: 'status', command: 'git status' },
            { id: 'publish', command: 'npm publish --access public' },
            { id: 'teardown', command: 'terraform destroy -auto-approve' },
            { id: 'force-push', command: 'git push --force origin main' },
        ]),
    } })
    chmodSync(join(shop.root, 'old-guard.sh'), 0o755)
    ok(shop, ['sync'])
    const before = shop.git('status', '--porcelain')

    const run = shop.cockpit(['adopt', '--import-guard', 'old-guard.sh', '--cases', 'cases.json'])
    expect(run.status, explain(run)).toBe(0)
    expect(run.json?.diagnostics).toEqual([expect.objectContaining({ code: 'ADOPT_HOOK_EXECUTED', severity: 'warning' })])
    const result = run.json?.result
    expect(result.errors, explain(run)).toEqual([])
    expect(result.oldOnly.map((row: { case: { id: string } }) => row.case.id)).toEqual(['publish', 'teardown'])
    expect(result.cockpitOnly.map((row: { case: { id: string } }) => row.case.id)).toEqual(['force-push'])
    expect(result.proposals).toEqual([
        { caseIds: ['publish'], prefix: ['npm', 'publish'], reason: 'BLOCKED: publishing is a release step' },
        { caseIds: ['teardown'], prefix: ['terraform', 'destroy'], reason: 'no teardown' },
    ])
    // It proposes; it writes nothing.
    expect(shop.git('status', '--porcelain')).toBe(before)

    const human = shop.cockpit(['adopt', '--import-guard', 'old-guard.sh', '--cases', 'cases.json'], { json: false })
    expect(human.stdout).toContain('Refused only by the old guard')
    expect(human.stdout).toContain('[[guards.deny]]')
}, JOURNEY_TIMEOUT)

it('previews what adopting takes over from an existing setup and what stays the repository\'s, writing nothing', () => {
    const shop = createProduct('shop-takeover', { files: {
        'cockpit.toml': null,
        'Makefile': 'up:\n\tdocker compose up -d\ndown:\n\tdocker compose down\nlint:\n\tnpm run lint\n',
        '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './old-guard.sh' }] }] } }),
    } })
    const before = shop.git('status', '--porcelain')
    const preview = shop.cockpit(['init', shop.root, '--target', 'claudecode'], { config: false })
    expect(preview.status, explain(preview)).toBe(0)
    expect(preview.json?.result.writes).toContain('cockpit.toml')
    expect(preview.json?.result.interview.takesOver).toEqual([
        { path: '.claude/settings.json', note: expect.stringContaining('PreToolUse: ./old-guard.sh') },
        { path: 'Makefile', note: expect.stringContaining('make up, make down drive Docker Compose') },
    ])
    expect(preview.json?.result.interview.staysYours.map((row: { path: string }) => row.path)).toEqual(['Makefile', 'compose.yml'])
    expect(shop.git('status', '--porcelain')).toBe(before)
}, JOURNEY_TIMEOUT)
