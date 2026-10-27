import { describe, expect, it } from 'vitest'
import { adaptGuardDecision, completeGuardTransport, normalizeOpenCodeInput, planGuardTransport, GUARD_HANDLER_ARGV } from './harness-adapter.js'
import { parseGuardInput, GUARD_INPUT_LIMITS } from './invocation-parser.js'
import { evaluateGuard, GUARD_ROOT_PROTECTIONS } from './evaluator.js'

const cwd = '/workspace/product'
const protectedIdentities = [...GUARD_ROOT_PROTECTIONS.map(({ path }) => `${cwd}/${path}`), `${cwd}/cockpit.toml`].map(path => ({ path, identity: null, ancestors: [] }))
const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command: 'git push origin HEAD:main' } })
const unsafeReasonCharacters = Array.from({ length: 160 }, (_, code) => code)
    .filter((code) => code < 32 || code >= 127)
    .concat([0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
    .map((code) => String.fromCodePoint(code))

describe('closed native guard representation', () => {
    it('refuses every unsafe reason character at direct and completed transport seams while preserving safe reasons', () => {
        const safe = 'Approval required: café, 日本語, 🙂.'
        for (const target of ['claudecode', 'codexcli', 'opencode'] as const) {
            const plan = planGuardTransport({ target, handler: '/workspace/bin/cockpit', cwd, stdin: payload })
            for (const verdict of ['ask', 'deny', 'unavailable'] as const) {
                const complete = (reason: string) => completeGuardTransport(plan, {
                    exitCode: 0, signal: null, stdout: JSON.stringify({ decision: verdict, reason }), stderr: '',
                })
                for (const reason of unsafeReasonCharacters.map((character) => `Before${character}After`)) {
                    for (const result of [adaptGuardDecision(target, { decision: verdict, reason }), complete(reason)]) {
                        expect(result).toMatchObject({ decision: 'unavailable', exitCode: 2, stdout: '' })
                        expect(result.stderr).toBe('cockpit guard: Guard adapter received an invalid harness or closed decision.\n')
                    }
                }
                for (const result of [adaptGuardDecision(target, { decision: verdict, reason: safe }), complete(safe)]) {
                    if (result.stdout) expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toBe(safe)
                    else expect(result.stderr).toBe(`cockpit guard: ${safe}\n`)
                }
            }
        }
    })

    it('keeps the real evaluator hard denial despite an exact grant on every harness', () => {
        const decision = evaluateGuard(parseGuardInput(payload), {
            canonicalRoot: cwd, configPath: `${cwd}/cockpit.toml`, allowedRoots: [cwd], instances: [], protectedIdentities, protectedBranches: ['main'], hostedDatabaseHosts: [], vendorHosts: [],
            cockpitInvocations: [{ executable: 'git', cwd, argv: ['push', 'origin', 'HEAD:main'] }], projectCommands: [],
        }, ({ path }) => ({ status: 'resolved', path, symlink: false, identity: null, ancestors: [] }))
        expect(decision.decision).toBe('deny')
        for (const target of ['claudecode', 'codexcli', 'opencode'] as const) {
            const native = adaptGuardDecision(target, decision)
            expect(native.decision).toBe('deny')
            expect(native.capability).toBe('instructed')
            if (target === 'opencode') expect(native).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringContaining(decision.reason) })
            else expect(JSON.parse(native.stdout)).toEqual({ hookSpecificOutput: {
                hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason,
            } })
        }
    })

    it.each(['HEAD', '@'])('adapts the real unresolved push %s to a prompt or no-prompt denial despite an exact grant', (source) => {
        const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command: `git push origin ${source}` } }
        const decision = evaluateGuard(parseGuardInput(input), {
            canonicalRoot: cwd, configPath: `${cwd}/cockpit.toml`, allowedRoots: [cwd], instances: [], protectedIdentities, protectedBranches: ['main'], hostedDatabaseHosts: [], vendorHosts: [],
            cockpitInvocations: [{ executable: 'git', cwd, argv: ['push', 'origin', source] }], projectCommands: [],
        }, ({ path }) => ({ status: 'resolved', path, symlink: false, identity: null, ancestors: [] }))
        for (const target of ['claudecode', 'codexcli', 'opencode'] as const) {
            const native = adaptGuardDecision(target, decision)
            const expected = target === 'claudecode' ? 'ask' : 'deny'
            expect(native.decision).toBe(expected)
            expect(native.capability).toBe('instructed')
            if (target === 'opencode') expect(native).toMatchObject({ exitCode: 2, stdout: '', stderr: `cockpit guard: ${decision.reason}\n` })
            else {
                expect(native.exitCode).toBe(0)
                expect(JSON.parse(native.stdout)).toEqual({ hookSpecificOutput: {
                    hookEventName: 'PreToolUse', permissionDecision: expected, permissionDecisionReason: decision.reason,
                } })
            }
        }
        expect(decision).toEqual({ decision: 'ask', reason: 'Push destination requires human approval.' })
    })

    it('represents ask only on the measured prompt harness and refuses unavailable or malformed decisions', () => {
        for (const target of ['claudecode', 'codexcli', 'opencode'] as const) {
            expect(adaptGuardDecision(target, { decision: 'ask', reason: 'Approval required.' }).decision).toBe(target === 'claudecode' ? 'ask' : 'deny')
            expect(adaptGuardDecision(target, { decision: 'allow', reason: 'Exact match.' })).toMatchObject({ decision: 'allow', exitCode: 0, stdout: '' })
            expect(adaptGuardDecision(target, { decision: 'unavailable', reason: 'Parser absent.' })).toMatchObject({ decision: 'unavailable', exitCode: 2 })
        }
        for (const input of [null, { decision: 'allow', reason: '' }, { decision: 'allow', reason: 'ok', mode: 'escalated' }]) {
            expect(adaptGuardDecision('claudecode', input)).toMatchObject({ decision: 'unavailable', exitCode: 2 })
        }
        expect(adaptGuardDecision('unknown', { decision: 'allow', reason: 'ok' }).exitCode).toBe(2)
    })
})

describe('bounded staged guard transport', () => {
    it('forwards raw stdin with only frozen handler argv and accepts only a closed bounded reply', () => {
        const plan = planGuardTransport({ target: 'codexcli', handler: '/workspace/bin/cockpit', cwd, stdin: payload })
        expect(GUARD_HANDLER_ARGV).toEqual(['guard-evaluate'])
        expect(plan).toEqual({ kind: 'complete', target: 'codexcli', executable: '/workspace/bin/cockpit', cwd,
            argv: ['guard-evaluate', '--harness', 'codexcli'], stdin: payload,
            timeoutMs: 20000, stdoutBytes: 65536, stderrBytes: 65536 })
        expect(Object.isFrozen(plan)).toBe(true)
        const response = { exitCode: 0, signal: null, stdout: JSON.stringify({ decision: 'deny', reason: 'Protected branch.' }), stderr: '' }
        expect(completeGuardTransport(plan, response).decision).toBe('deny')
        for (const failed of [
            { ...response, exitCode: 2 }, { ...response, signal: 'SIGTERM' }, { ...response, stdout: '' },
            { ...response, stdout: '{' }, { ...response, stdout: JSON.stringify({ decision: 'allow' }) },
            { ...response, stdout: response.stdout + '\n{}' }, { ...response, stderr: 'x'.repeat(65537) },
        ]) expect(completeGuardTransport(plan, failed)).toMatchObject({ decision: 'unavailable', exitCode: 2 })
        expect(completeGuardTransport({ ...plan }, response).exitCode).toBe(2)
    })

    it('does not classify shell text and fails closed before dispatch on invalid or oversized transport data', () => {
        const base = { target: 'claudecode', handler: '/workspace/bin/cockpit', cwd, stdin: 'not JSON or shell $(anything)' }
        expect(planGuardTransport(base).kind).toBe('complete')
        expect(planGuardTransport({ ...base, argv: ['internal', 'guard', '--harness', 'claudecode'] }).kind).toBe('refusal')
        expect(planGuardTransport({ ...base, stdin: 'x'.repeat(GUARD_INPUT_LIMITS.inputBytes) }).kind).toBe('complete')
        for (const extra of [{ stdin: 'x'.repeat(GUARD_INPUT_LIMITS.inputBytes + 1) }, { handler: 'cockpit' }, { handler: '/bin/../bin/cockpit' }, { argv: ['other'] }, { target: 'other' }, { stdin: '\ud800' }]) {
            expect(planGuardTransport({ ...base, ...extra }).kind).toBe('refusal')
        }
        let reads = 0
        expect(planGuardTransport(Object.defineProperty({ ...base }, 'stdin', { get() { reads++; return payload }, enumerable: true })).kind).toBe('refusal')
        expect(reads).toBe(0)
    })

    it('normalizes only OpenCode field names and leaves unsupported shell interpretation to the single parser', () => {
        const raw = { tool: 'bash', args: { command: 'echo $(dynamic)' }, cwd }
        const normalized = normalizeOpenCodeInput(raw)
        expect(normalized).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo $(dynamic)' }, cwd })
        expect(parseGuardInput(normalized).status).toBe('unavailable')
        expect(normalizeOpenCodeInput({ tool: 'apply_patch', args: { patchText: 'raw patch' }, cwd })).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'raw patch' }, cwd })
        expect(normalizeOpenCodeInput({ tool: 'write', args: { filePath: 'src/a.ts', content: 'text' }, cwd })).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' }, cwd })
        expect(normalizeOpenCodeInput({ tool: 'bash', args: {}, cwd })).toBeUndefined()
    })
})
