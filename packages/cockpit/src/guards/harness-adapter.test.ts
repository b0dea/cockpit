import { describe, expect, it } from 'vitest'
import { adaptGuardDecision, normalizeOpenCodeInput } from './harness-adapter.js'
import { parseGuardInput } from './invocation-parser.js'
import { evaluateGuard, GUARD_DEFERRED_REASONS, GUARD_ROOT_PROTECTIONS } from './evaluator.js'

const cwd = '/workspace/product'
const protectedIdentities = GUARD_ROOT_PROTECTIONS.map(({ path }) => `${cwd}/${path}`).map(path => ({ path, identity: null, ancestors: [] }))
const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command: 'git push origin HEAD:main' } })
const unsafeReasonCharacters = Array.from({ length: 160 }, (_, code) => code)
    .filter((code) => code < 32 || code >= 127)
    .concat([0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
    .map((code) => String.fromCodePoint(code))

/** The reason a refusal carries, asserting it is spelled the way its harness reads a refusal. */
function refusal(target: 'claudecode' | 'codexcli' | 'opencode', result: ReturnType<typeof adaptGuardDecision>): string {
    if (target === 'opencode') {
        expect(result).toMatchObject({ exitCode: 2, stdout: '' })
        return result.stderr.replace(/^cockpit guard: (.*)\n$/s, '$1')
    }
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    const { hookSpecificOutput } = JSON.parse(result.stdout)
    expect(hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    return hookSpecificOutput.permissionDecisionReason
}

describe('closed native guard representation', () => {
    it('refuses every unsafe reason character while preserving safe reasons', () => {
        const safe = 'Approval required: café, 日本語, 🙂.'
        for (const target of ['claudecode', 'codexcli', 'opencode'] as const) {
            for (const verdict of ['ask', 'deny', 'unavailable'] as const) {
                for (const reason of unsafeReasonCharacters.map((character) => `Before${character}After`)) {
                    for (const result of [adaptGuardDecision(target, { decision: verdict, reason })]) {
                        expect(result.decision).toBe('unavailable')
                        expect(refusal(target, result)).toBe('Guard adapter received an invalid harness or closed decision.')
                    }
                }
                for (const result of [adaptGuardDecision(target, { decision: verdict, reason: safe })]) {
                    if (result.stdout) expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toBe(safe)
                    else expect(result.stderr).toBe(`cockpit guard: ${safe}\n`)
                }
            }
        }
    })

    it('keeps the real evaluator hard denial despite an exact grant on every harness', () => {
        const decision = evaluateGuard(parseGuardInput(payload), {
            canonicalRoot: cwd, configPath: `${cwd}/cockpit.toml`, allowedRoots: [cwd], instances: [], templates: [], protectedIdentities, protectedBranches: ['main'], hostedDatabaseHosts: [], vendorHosts: [],
            declaredAllows: [], declaredDenies: [], ripgrepConfigActive: false,
            executionDirectories: [], searchDirectories: [], secretFileIdentities: [], protectedFilesLinked: false,
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
            canonicalRoot: cwd, configPath: `${cwd}/cockpit.toml`, allowedRoots: [cwd], instances: [], templates: [], protectedIdentities, protectedBranches: ['main'], hostedDatabaseHosts: [], vendorHosts: [],
            declaredAllows: [], declaredDenies: [], ripgrepConfigActive: false,
            executionDirectories: [], searchDirectories: [], secretFileIdentities: [], protectedFilesLinked: false,
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
        expect(decision).toEqual({ decision: 'ask', reason: 'The guard could not tell which remote branch this push updates. Name it: `git push origin <branch>:<branch>`.' })
    })

    // Claude Code prints the whole hook command before the reason of a refusal that exits 2, so a harness
    // that reads decision JSON gets every refusal there; only OpenCode's plugin and an unknown harness exit 2.
    it('represents ask only on the measured prompt harness and refuses unavailable or malformed decisions', () => {
        for (const target of ['claudecode', 'codexcli', 'opencode'] as const) {
            expect(adaptGuardDecision(target, { decision: 'ask', reason: 'Approval required.' }).decision).toBe(target === 'claudecode' ? 'ask' : 'deny')
            // Claude Code prompts for a call the hook leaves unanswered, and its own deny rules still win over an
            // allow answer (measured); Codex rejects an allow answer as unsupported, and OpenCode's plugin reads none.
            const allowed = adaptGuardDecision(target, { decision: 'allow', reason: 'Exact match.' })
            expect(allowed).toMatchObject({ decision: 'allow', exitCode: 0, stderr: '' })
            expect(allowed.stdout).toBe(target === 'claudecode' ? `${JSON.stringify({ hookSpecificOutput: {
                hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Exact match.' } })}\n` : '')
            // Nor is a call asking to leave Claude Code's sandbox, whose retry an allow answer could approve unprompted.
            expect(adaptGuardDecision(target, { decision: 'allow', reason: 'Exact match.' }, { leavesSandbox: true }).stdout).toBe('')
            // An allow the guard leaves to the agent tool's own permissions is not answered on any harness.
            for (const reason of GUARD_DEFERRED_REASONS) expect(adaptGuardDecision(target, { decision: 'allow', reason })).toMatchObject({ decision: 'allow', exitCode: 0, stdout: '', stderr: '' })
            const unavailable = adaptGuardDecision(target, { decision: 'unavailable', reason: 'Parser absent.' })
            expect(unavailable.decision).toBe('unavailable')
            expect(refusal(target, unavailable)).toBe('Parser absent.')
        }
        for (const input of [null, { decision: 'allow', reason: '' }, { decision: 'allow', reason: 'ok', mode: 'escalated' }]) {
            const malformed = adaptGuardDecision('claudecode', input)
            expect(malformed.decision).toBe('unavailable')
            expect(refusal('claudecode', malformed)).toBe('Guard adapter received an invalid harness or closed decision.')
        }
        expect(adaptGuardDecision('unknown', { decision: 'allow', reason: 'ok' })).toMatchObject({ exitCode: 2, stdout: '',
            stderr: 'cockpit guard: Guard adapter received an invalid harness or closed decision.\n' })
    })
})

describe('OpenCode input', () => {
    it('normalizes only OpenCode field names and leaves unsupported shell interpretation to the single parser', () => {
        const raw = { tool: 'bash', args: { command: 'eval "echo 1"' }, cwd }
        const normalized = normalizeOpenCodeInput(raw)
        expect(normalized).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'eval "echo 1"' }, cwd })
        expect(parseGuardInput(normalized)).toMatchObject({ status: 'parsed', unreadable: { text: 'eval "echo 1"' } })
        expect(normalizeOpenCodeInput({ tool: 'apply_patch', args: { patchText: 'raw patch' }, cwd })).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'raw patch' }, cwd })
        expect(normalizeOpenCodeInput({ tool: 'write', args: { filePath: 'src/a.ts', content: 'text' }, cwd })).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' }, cwd })
        expect(normalizeOpenCodeInput({ tool: 'bash', args: {}, cwd })).toBeUndefined()
    })
})
