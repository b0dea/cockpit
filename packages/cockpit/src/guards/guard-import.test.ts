import { describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { guardCommandInvocations } from '../environment/application/guard.js'
import { guardParity, parseGuardCases, readHookAnswer, renderGuardParity, type ComparedCase, type HookVerdict } from './guard-import.js'

const ROOT = '/workspace/product'
const allow: HookVerdict = { decision: 'allow', reason: 'no decision' }
const deny = (reason: string): HookVerdict => ({ decision: 'deny', reason })
const row = (id: string, command: string, old: HookVerdict, cockpit: HookVerdict): ComparedCase => ({ case: { id, command }, cwd: ROOT, old, cockpit })

describe('guard import', () => {
    it('reads cases as guard prove does and names the case it refuses', () => {
        expect(parseGuardCases(JSON.stringify([{ id: 'a', command: 'ls' }, { id: 'b', command: 'make deploy', cwd: 'app', expect: 'deny' }])))
            .toEqual({ cases: [{ id: 'a', command: 'ls' }, { id: 'b', command: 'make deploy', cwd: 'app', expect: 'deny' }] })
        expect(parseGuardCases(JSON.stringify([{ id: 'a', command: 'ls', expected: 'allow' }])))
            .toEqual({ refusal: expect.stringContaining('case "a" must be an object with "id" and "command"') })
        expect(parseGuardCases(JSON.stringify([{ id: 'a', command: 'ls' }, { id: 'a', command: 'pwd' }])))
            .toEqual({ refusal: expect.stringContaining('case "a" needs an "id" no other case uses') })
        expect(parseGuardCases('{}')).toEqual({ refusal: expect.stringContaining('JSON array') })
    })

    it('reads a hook answer the way Claude Code does, and a failed hook as no answer', () => {
        const answer = (exitCode: number, stdout = '', stderr = '') => readHookAnswer({ exitCode, stdout, stderr })
        const json = (value: unknown) => answer(0, `${JSON.stringify(value)}\n`)
        expect(answer(2, '', 'BLOCKED: no publishing\n')).toEqual({ decision: 'deny', reason: 'BLOCKED: no publishing' })
        expect(json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'not here' } }))
            .toEqual({ decision: 'deny', reason: 'not here' })
        expect(json({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm' } })).toEqual({ decision: 'ask', reason: 'confirm' })
        expect(json({ decision: 'block', reason: 'legacy shape' })).toEqual({ decision: 'deny', reason: 'legacy shape' })
        expect(json({ continue: false, stopReason: 'halt' })).toEqual({ decision: 'deny', reason: 'halt' })
        expect(answer(0)).toMatchObject({ decision: 'allow' })
        expect(answer(0, 'checked\n')).toMatchObject({ decision: 'allow' })
        expect(answer(1, '', 'jq: command not found')).toEqual({ decision: 'error', reason: 'exited 1: jq: command not found' })
    })

    it('sorts the cases into parity sections and proposes the narrowest deny rule that spares what the old guard allowed', () => {
        const parity = guardParity([
            row('force-push', 'git push --force origin main', deny('no force push'), deny('Refusing a force push.')),
            row('publish', 'npm publish --access public', deny('BLOCKED: publishing is a release step'), allow),
            row('publish-dry', 'npm publish --dry-run', allow, allow),
            row('delete-prod', 'curl -X DELETE https://api.example.invalid/items', deny('no deletes'), { decision: 'ask', reason: 'unknown host' }),
            row('get', 'curl -X GET https://api.example.invalid/items', allow, allow),
            row('destroy', 'terraform destroy -auto-approve', deny('no destroy'), allow),
            row('apply-plan', 'terraform apply plan.out', deny('no apply'), allow),
            // The old guard allowed these, so no proposal may refuse them, even where cockpit failed or reads no plain commands.
            row('apply-check', 'terraform apply -help', allow, { decision: 'error', reason: 'timed out' }),
            row('upload-eval', 'eval "twine upload --repository test dist"', allow, { decision: 'ask', reason: 'unread shell' }),
            row('upload', 'twine upload dist', deny('no uploads'), allow),
            row('chained', 'make build && docker push registry.example.invalid/app', deny('no pushes'), allow),
            row('env', 'cat .env', allow, deny('Refusing to read a secret file.')),
            row('broken', 'ls', { decision: 'error', reason: 'exited 1' }, allow),
        ], guardCommandInvocations)
        expect(parity.bothRefuse.map(r => r.case.id)).toEqual(['force-push'])
        expect(parity.oldOnly.map(r => r.case.id)).toEqual(['publish', 'delete-prod', 'destroy', 'apply-plan', 'upload', 'chained'])
        expect(parity.cockpitOnly.map(r => r.case.id)).toEqual(['env'])
        expect(parity.errors.map(r => r.case.id)).toEqual(['apply-check', 'broken'])
        expect(parity.unproposed).toEqual([{ caseId: 'chained', why: expect.stringContaining('split it into one case per command') }])
        // `npm publish` alone would also refuse the dry run the old guard allowed, so the rule names the flag;
        // a rule never names a program alone, which would refuse every use of it.
        expect(parity.proposals).toEqual([
            { caseIds: ['publish'], prefix: ['npm', 'publish', '--access'], reason: 'BLOCKED: publishing is a release step' },
            { caseIds: ['delete-prod'], prefix: ['curl', '-X', 'DELETE'], reason: 'no deletes' },
            { caseIds: ['destroy'], prefix: ['terraform', 'destroy'], reason: 'no destroy' },
            { caseIds: ['apply-plan'], prefix: ['terraform', 'apply', 'plan.out'], reason: 'no apply' },
            { caseIds: ['upload'], prefix: ['twine', 'upload', 'dist'], reason: 'no uploads' },
        ])
        const report = renderGuardParity(parity)
        expect(report).toContain('Refused only by the old guard')
        expect(report).toContain('cockpit: asks a person: unknown host')
        expect(report).toContain('nothing was written')
        // Every proposed block is valid TOML of the documented shape.
        const proposed = report.slice(report.indexOf('[[guards.deny]]'))
        expect(parseToml(proposed)).toEqual({ guards: { deny: [
            { prefix: ['npm', 'publish', '--access'], reason: 'BLOCKED: publishing is a release step' },
            { prefix: ['curl', '-X', 'DELETE'], reason: 'no deletes' },
            { prefix: ['terraform', 'destroy'], reason: 'no destroy' },
            { prefix: ['terraform', 'apply', 'plan.out'], reason: 'no apply' },
            { prefix: ['twine', 'upload', 'dist'], reason: 'no uploads' },
        ] } })
    })
})
