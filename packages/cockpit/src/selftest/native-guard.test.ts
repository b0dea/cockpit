import { describe, expect, it } from 'vitest'

import { brokenNativeGuardSettings, nativeGuardCommands, validateNativeGuardPair } from '../../libexec/native-selftest-guard.mjs'

type GuardPair = Parameters<typeof validateNativeGuardPair>[0]

function guardPair(): GuardPair {
    const host = 'vendor.example.test'
    const brokenCommand = `cockpit-selftest-missing-hook-${'b'.repeat(24)}`
    const guardCommand = 'node ./guard.mjs'
    // A team's hooks sit beside cockpit's guard, before and after it.
    const candidateBytes = `${JSON.stringify({ hooks: { PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: './team-bash-guard.sh' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: guardCommand }, { type: 'command', command: './team-audit.sh' }] },
    ] } }, null, 2)}\n`
    const brokenBytes = brokenNativeGuardSettings(candidateBytes, guardCommand, brokenCommand).bytes
    if (!brokenBytes) throw new Error('synthetic guard registration is invalid')

    function trace(denied: boolean, nonce: string) {
        const commands = nativeGuardCommands(host, '43210', nonce)
        const messages: object[] = [{ role: 'user', content: [{ type: 'text', text: 'Run the paired guard controls.' }] }]
        const requests = [structuredClone({ messages })]
        const events: object[] = []
        for (const [id, command, marker] of [
            ['cockpit_forbidden', commands.forbiddenCommand, commands.receiptMarker],
            ['cockpit_ordinary', commands.allowedCommand, commands.ordinaryMarker],
        ]) {
            const rejected = denied && id === 'cockpit_forbidden'
            const use = { type: 'tool_use', id, name: 'Bash', input: { command } }
            events.push({ type: 'assistant', message: { content: [use] } })
            messages.push({ role: 'assistant', content: [use] })
            events.push({ type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', exit_code: denied ? 0 : 127,
                stdout: rejected ? JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny',
                    permissionDecisionReason: 'Refusing executable use of a declared vendor host.' } }) : '',
                stderr: denied ? '' : `${brokenCommand}: command not found` })
            const content = rejected ? 'Denied by hook' : marker
            const result = { type: 'tool_result', tool_use_id: id, content, is_error: rejected }
            events.push({ type: 'user', message: { content: [result] },
                tool_use_result: { stdout: content, interrupted: false },
                tool_result_meta: [{ id, permission_decision: { decision: rejected ? 'reject' : 'accept', source: rejected ? 'hook' : 'config' } }] })
            messages.push({ role: 'user', content: [result] })
            requests.push(structuredClone({ messages }))
        }
        // Native parents can report success even when a child tool was denied.
        events.push({ type: 'result', subtype: 'success', is_error: false, result: 'Complete' })
        return { stdout: events.map(event => JSON.stringify(event)).join('\n'),
            observation: { endpoint: `http://127.0.0.1:43210/${nonce}`, input: JSON.stringify(requests),
                receipts: denied ? [] : [`/${nonce}/guard-receipt`] } }
    }

    const candidate = trace(true, 'c'.repeat(48)), broken = trace(false, 'd'.repeat(48))
    return { host, guardCommand, brokenCommand, candidateBytes, brokenBytes,
        observations: { candidate: candidate.observation, broken: broken.observation },
        candidateStdout: candidate.stdout, brokenStdout: broken.stdout }
}

function changeEvents(pair: GuardPair, role: 'candidate' | 'broken', change: (events: ReturnType<typeof JSON.parse>[]) => void) {
    const key = role === 'candidate' ? 'candidateStdout' : 'brokenStdout'
    const events = pair[key].split('\n').map(line => JSON.parse(line))
    change(events)
    pair[key] = events.map(event => JSON.stringify(event)).join('\n')
}

describe('native guard paired evidence', () => {
    it('accepts a linked native hook denial beside a named missing-command control and ordinary allowed commands', () => {
        expect(validateNativeGuardPair(guardPair())).toBeNull()
    })

    it.each<[string, (pair: GuardPair) => void]>([
        ['missing forbidden tool call', pair => changeEvents(pair, 'candidate', events => { events.splice(0, 1) })],
        ['forged forbidden command', pair => changeEvents(pair, 'candidate', events => { events[0].message.content[0].input.command = 'printf forged' })],
        ['wrong native tool', pair => changeEvents(pair, 'candidate', events => { events[0].message.content[0].name = 'OtherTool' })],
        ['result linked to a different tool', pair => changeEvents(pair, 'candidate', events => { events[2].message.content[0].tool_use_id = 'other' })],
        ['result before its invocation', pair => changeEvents(pair, 'candidate', events => { [events[0], events[2]] = [events[2], events[0]] })],
        ['duplicated tool result', pair => changeEvents(pair, 'candidate', events => { events.push(events[2]) })],
        ['missing hook denial', pair => changeEvents(pair, 'candidate', events => { events.splice(1, 1) })],
        ['hook denial from a different lifecycle event', pair => changeEvents(pair, 'candidate', events => { events[1].hook_event = 'PostToolUse' })],
        ['hook response after the result', pair => changeEvents(pair, 'candidate', events => { [events[1], events[2]] = [events[2], events[1]] })],
        ['failed candidate hook', pair => changeEvents(pair, 'candidate', events => { events[1].exit_code = 127 })],
        ['forged denial reason', pair => changeEvents(pair, 'candidate', events => { events[1].stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Unrelated refusal' } }) })],
        ['missing hook attribution', pair => changeEvents(pair, 'candidate', events => { delete events[2].tool_result_meta })],
        ['hook attribution linked to another tool', pair => changeEvents(pair, 'candidate', events => { events[2].tool_result_meta[0].id = 'other' })],
        ['denial attributed to configuration', pair => changeEvents(pair, 'candidate', events => { events[2].tool_result_meta[0].permission_decision.source = 'config' })],
        ['interrupted ordinary command', pair => changeEvents(pair, 'candidate', events => { events[5].tool_use_result.interrupted = true })],
        ['ordinary command without native stdout', pair => changeEvents(pair, 'candidate', events => { delete events[5].tool_use_result.stdout })],
        ['broken hook with the wrong exit code', pair => changeEvents(pair, 'broken', events => { events[1].exit_code = 1 })],
        ['broken hook without its command name', pair => changeEvents(pair, 'broken', events => { events[1].stderr = 'command not found' })],
        ['broken ordinary hook without failure evidence', pair => changeEvents(pair, 'broken', events => { events.splice(4, 1) })],
        ['candidate command reached loopback', pair => { pair.observations.candidate.receipts = [`/${'c'.repeat(48)}/guard-receipt`] }],
        ['broken command did not reach loopback', pair => { pair.observations.broken.receipts = [] }],
        ['receipt from another control', pair => { pair.observations.broken.receipts = [`/${'c'.repeat(48)}/guard-receipt`] }],
        ['different registration settings', pair => { pair.brokenBytes = pair.brokenBytes.replace('"Bash"', '"OtherTool"') }],
        ['broken control that also drops a team hook', pair => { pair.brokenBytes = pair.brokenBytes.replace('./team-audit.sh', pair.brokenCommand) }],
        ['broken control that breaks a team hook instead', pair => {
            pair.brokenBytes = pair.candidateBytes.replace('./team-bash-guard.sh', pair.brokenCommand)
        }],
        ['guard command another cockpit generated', pair => { pair.guardCommand = 'node ./other-guard.mjs' }],
        ['missing model request', pair => { const requests = JSON.parse(pair.observations.candidate.input); requests.pop(); pair.observations.candidate.input = JSON.stringify(requests) }],
        ['forged result returned to the model', pair => { const requests = JSON.parse(pair.observations.candidate.input); requests[1].messages[2].content[0].content = 'forged'; pair.observations.candidate.input = JSON.stringify(requests) }],
        ['result returned under another tool identifier', pair => { const requests = JSON.parse(pair.observations.candidate.input); requests[1].messages[2].content[0].tool_use_id = 'other'; pair.observations.candidate.input = JSON.stringify(requests) }],
    ])('rejects %s', (_name, change) => {
        const pair = guardPair()
        change(pair)
        expect(validateNativeGuardPair(pair)).toEqual(expect.any(String))
    })

    it('does not treat a successful native parent as evidence of a child refusal or execution', () => {
        const pair = guardPair()
        const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Complete' })
        pair.candidateStdout = success
        pair.brokenStdout = success
        expect(validateNativeGuardPair(pair)).toEqual(expect.any(String))
    })

    it.each<[string, (pair: GuardPair) => void]>([
        ['invalid event JSON', pair => { pair.candidateStdout = '{' }],
        ['invalid request JSON', pair => { pair.observations.candidate.input = '{' }],
        ['null event', pair => { pair.candidateStdout = 'null' }],
        ['null model requests', pair => { pair.observations.candidate.input = 'null' }],
        ['null model request entries', pair => { pair.observations.candidate.input = '[null,null,null]' }],
        ['null hook decision', pair => changeEvents(pair, 'candidate', events => { events[1].stdout = 'null' })],
        ['null tool block', pair => changeEvents(pair, 'candidate', events => { events[0].message.content = [null] })],
        ['non-array tool metadata', pair => changeEvents(pair, 'candidate', events => { events[2].tool_result_meta = {} })],
        ['invalid candidate settings', pair => { pair.candidateBytes = 'null' }],
        ['invalid loopback port', pair => { pair.observations.candidate.endpoint = `http://127.0.0.1:99999/${'c'.repeat(48)}` }],
    ])('returns a diagnostic without throwing for %s', (_name, change) => {
        const pair = guardPair()
        change(pair)
        expect(() => validateNativeGuardPair(pair)).not.toThrow()
        expect(validateNativeGuardPair(pair)).toEqual(expect.any(String))
    })
})
