import { describe, expect, it } from 'vitest'
import { GUARD_INPUT_LIMITS, parseGuardInput } from './invocation-parser.js'
import { invocationCorpus, nativeShellPayload, shellPayload } from './fixtures/invocation-corpus.js'

describe('guard invocation capture', () => {
    it('preserves executable boundaries instead of joining adjacent predicates', () => {
        expect(parseGuardInput(shellPayload('git push origin feature; printf main'))).toMatchObject({
            status: 'parsed', invocations: [
                { executable: 'git', argv: ['push', 'origin', 'feature'] },
                { executable: 'printf', argv: ['main'] },
            ],
        })
    })

    it.each(invocationCorpus)('captures or explicitly refuses $name', (row) => {
        expect(parseGuardInput(shellPayload(row.candidate))).toEqual(typeof row.capture.candidate === 'string'
            ? { status: 'unavailable', reason: row.capture.candidate }
            : { status: 'parsed', tool: 'Bash', cwd: '/workspace/project', invocations: row.capture.candidate, paths: [] })
        expect(parseGuardInput(shellPayload(row.control))).toEqual({ status: 'parsed', tool: 'Bash', cwd: '/workspace/project', invocations: row.capture.control, paths: [] })
    })

    it('keeps wrapper values, assignments, redirects, comments and heredocs out of argv', () => {
        expect(parseGuardInput(shellPayload('KEY=value timeout -s TERM 60 env -C /workspace/project git push origin feature > main # main'))).toMatchObject({
            status: 'parsed', invocations: [{ executable: 'git', argv: ['push', 'origin', 'feature'], wrapped: true,
                words: expect.arrayContaining([
                    { role: 'environment-assignment-value', value: 'value' },
                    { role: 'wrapper-option-value', value: 'TERM' },
                    { role: 'redirect-target', value: 'main' },
                    { role: 'comment', value: ' main' },
                ]),
            }],
        })
        expect(parseGuardInput(shellPayload("cat <<'EOF'\ngit push origin main\nEOF"))).toMatchObject({
            status: 'parsed', invocations: [{ executable: 'cat', argv: [], words: expect.arrayContaining([
                { role: 'heredoc-body', value: 'git push origin main\n' },
            ]) }],
        })
    })

    it('captures static concatenation and escaped separators without evaluating expansion', () => {
        expect(parseGuardInput(shellPayload('g"i"t push origin ma\\in; printf a\\;b'))).toMatchObject({
            status: 'parsed', invocations: [{ executable: 'git', argv: ['push', 'origin', 'main'] }, { argv: ['a;b'] }],
        })
        for (const command of ['echo "$HOME"', 'git add *', 'sh -c "git push origin main"', 'eval "git push origin main"', 'printf `date`', 'printf x\\', 'printf "x', 'echo x &&', '(echo x)', 'cd /tmp; git status', 'printf\vok']) {
            expect(parseGuardInput(shellPayload(command)), command).toMatchObject({ status: 'unavailable', reason: expect.any(String) })
        }
    })

    it('rejects hostile own-data shapes without invoking them', () => {
        let touched = false
        const accessor = { get tool_name() { touched = true; return 'Bash' } }
        const proxy = new Proxy({}, { ownKeys() { touched = true; throw new Error('trap') } })
        for (const input of [accessor, proxy, Object.create({ tool_name: 'Bash' }), { ...shellPayload('printf ok'), extra: true }]) {
            expect(parseGuardInput(input).status).toBe('unavailable')
        }
        expect(touched).toBe(false)
    })

    it('refuses malformed bytes, JSON and unpaired surrogates', () => {
        for (const input of [Buffer.from([0xff]), '{', shellPayload('printf \ud800'), JSON.stringify(shellPayload('printf \ud800'))]) {
            expect(parseGuardInput(input).status).toBe('unavailable')
        }
        expect(parseGuardInput(Buffer.from(JSON.stringify(shellPayload('printf ok')))).status).toBe('parsed')
    })

    it('refuses custom native byte properties without invoking accessors or conversion hooks', () => {
        let touched = false
        const encoded = Buffer.from(JSON.stringify(shellPayload('printf ok')))
        for (const key of ['byteLength', 'buffer', 'byteOffset', Symbol.iterator, Symbol.toPrimitive]) {
            const bytes = new Uint8Array(encoded)
            Object.defineProperty(bytes, key, { get() { touched = true; return 1 } })
            expect(parseGuardInput(bytes).status).toBe('unavailable')
        }
        class ForeignBytes extends Uint8Array {}
        expect(parseGuardInput(new ForeignBytes(encoded)).status).toBe('unavailable')
        expect(touched).toBe(false)
        expect(parseGuardInput(new Uint8Array(encoded)).status).toBe('parsed')
        expect(parseGuardInput(encoded).status).toBe('parsed')
    })

    it('captures native Bash execution options without letting them change or bypass the command', () => {
        const command = 'git push origin feature; git push origin main'
        expect(parseGuardInput(nativeShellPayload(command))).toEqual(parseGuardInput(shellPayload(command)))
        const native = nativeShellPayload(command)
        for (const [key, value] of [['description', 42], ['timeout', '120000'], ['run_in_background', 'false'], ['dangerouslyDisableSandbox', 1], ['extra', true]] as const) {
            expect(parseGuardInput({ ...native, tool_input: { ...native.tool_input, [key]: value } }), key).toEqual({ status: 'unavailable', reason: 'Malformed command payload.' })
        }
        const patch = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/workspace/project', tool_input: { command: '*** Begin Patch\n*** Add File: a\n+ok\n*** End Patch', timeout: 1 } }
        expect(parseGuardInput(patch).status).toBe('unavailable')
    })

    it('validates optional native fields as own well-formed scalars', () => {
        for (const content of [{}, '\ud800', 42]) {
            expect(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: '/workspace/project', tool_input: { file_path: 'file', content } }).status).toBe('unavailable')
        }
    })

    it('treats non-ASCII whitespace as literal shell word content', () => {
        expect(parseGuardInput(shellPayload('printf a\u00a0b'))).toMatchObject({ status: 'parsed', invocations: [{ argv: ['a\u00a0b'] }] })
    })

    it('distinguishes adjacent descriptor numbers from numeric arguments', () => {
        expect(parseGuardInput(shellPayload('printf ok 2> errors 1>&2'))).toMatchObject({
            status: 'parsed', invocations: [{ argv: ['ok'], redirects: [{ target: 'errors', write: true }] }],
        })
        expect(parseGuardInput(shellPayload('printf 2 > errors'))).toMatchObject({ status: 'parsed', invocations: [{ argv: ['2'] }] })
    })

    it('accepts exact input, invocation, word and UTF-8 word bounds and rejects plus one', () => {
        expect(GUARD_INPUT_LIMITS).toEqual({ inputBytes: 65536, invocations: 256, words: 4096, wordBytes: 4096, paths: 256, pathBytes: 4096 })
        const encoded = JSON.stringify(shellPayload('printf ok'))
        expect(parseGuardInput(encoded + ' '.repeat(65536 - Buffer.byteLength(encoded))).status).toBe('parsed')
        expect(parseGuardInput(encoded + ' '.repeat(65537 - Buffer.byteLength(encoded))).status).toBe('unavailable')
        for (const [limit, create] of [
            [256, (n: number) => Array(n).fill('true').join(';')],
            [4096, (n: number) => ['printf', ...Array(n - 1).fill('x')].join(' ')],
            [4096, (n: number) => `printf ${'é'.repeat(Math.floor(n / 2))}${n % 2 ? 'x' : ''}`],
        ] as const) {
            expect(parseGuardInput(shellPayload(create(limit))).status).toBe('parsed')
            expect(parseGuardInput(shellPayload(create(limit + 1))).status).toBe('unavailable')
        }
    })

    it('bounds patch targets including move destinations and UTF-8 path bytes', () => {
        const patch = (count: number) => ({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/workspace/project',
            tool_input: { command: ['*** Begin Patch', ...Array.from({ length: count }, (_, i) => `*** Add File: file-${i}\n+ok`), '*** End Patch'].join('\n') } })
        expect(parseGuardInput(patch(256))).toMatchObject({ status: 'parsed', paths: expect.any(Array) })
        expect(parseGuardInput(patch(257)).status).toBe('unavailable')
        const edit = (path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: '/workspace/project', tool_input: { file_path: path, content: 'ok' } })
        expect(parseGuardInput(edit('é'.repeat(2048))).status).toBe('parsed')
        expect(parseGuardInput(edit('é'.repeat(2048) + 'x')).status).toBe('unavailable')
        expect(parseGuardInput({ ...patch(1), tool_input: { command: '*** Begin Patch\n*** Update File: old\n*** Move to: new\n@@\n-a\n+b\n*** End Patch' } })).toMatchObject({ status: 'parsed', paths: ['old', 'new'] })
    })
})
