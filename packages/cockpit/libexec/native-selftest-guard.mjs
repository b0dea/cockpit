export function nativeGuardCommands(host, port, nonce) {
    const receiptMarker = `COCKPIT_GUARD_RECEIPT_${nonce}`
    const ordinaryMarker = `COCKPIT_GUARD_ORDINARY_${nonce}`
    return {
        forbiddenCommand: `curl --disable --silent --show-error --noproxy '*' --connect-timeout 2 --max-time 5 --resolve ${host}:${port}:127.0.0.1 http://${host}:${port}/${nonce}/guard-receipt`,
        allowedCommand: `printf ${ordinaryMarker}`, receiptMarker, ordinaryMarker,
    }
}

export function nativeGuardInvocation(host) {
    const commands = nativeGuardCommands(host, '{loopback-port}', '{nonce}')
    return ['{executable}', '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
        '--no-session-persistence', '--setting-sources', '', '--settings', '{control}', '--tools', 'Bash',
        '--allowedTools', `Bash(${commands.forbiddenCommand})`, `Bash(${commands.allowedCommand})`,
        '--strict-mcp-config', '--permission-prompts', 'none', '--', 'Run only the synthetic loopback measurement.']
}

export function brokenNativeGuardSettings(bytes, command) {
    let settings
    try { settings = JSON.parse(bytes) } catch { return undefined }
    const groups = settings?.hooks?.PreToolUse
    if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0]?.hooks) || groups[0].hooks.length !== 1
        || groups[0].hooks[0]?.type !== 'command' || typeof groups[0].hooks[0].command !== 'string') return undefined
    groups[0].hooks[0].command = command
    return `${JSON.stringify(settings, null, 2)}\n`
}

export function validateNativeGuardPair({ host, brokenCommand, candidateBytes, brokenBytes, observations, candidateStdout, brokenStdout }) {
    if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)
        || typeof brokenCommand !== 'string' || !/^cockpit-selftest-missing-hook-[a-f0-9]{24}$/.test(brokenCommand)
        || typeof candidateBytes !== 'string' || typeof brokenBytes !== 'string'
        || brokenNativeGuardSettings(candidateBytes, brokenCommand) !== brokenBytes) return 'native guard controls do not preserve the generated registration beside its broken command'
    for (const role of ['candidate', 'broken']) {
        const observation = observations?.[role]
        const endpoint = typeof observation?.endpoint === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/([a-f0-9]{48})$/.exec(observation.endpoint) : null
        if (!endpoint || Number(endpoint[1]) > 65535 || typeof observation.input !== 'string' || !Array.isArray(observation.receipts)) return 'native guard observation is malformed'
        const commands = nativeGuardCommands(host, endpoint[1], endpoint[2])
        let events, requests
        try {
            const stdout = role === 'candidate' ? candidateStdout : brokenStdout
            if (typeof stdout !== 'string') return 'native guard event stream must be text'
            events = stdout.trim().split('\n').map(line => JSON.parse(line))
            requests = JSON.parse(observation.input)
        } catch { return 'native guard observations must contain structured native events and model requests' }
        if (!Array.isArray(requests) || requests.length !== 3 || observation.receipts.length !== (role === 'candidate' ? 0 : 1)
            || observation.receipts.some(path => path !== `/${endpoint[2]}/guard-receipt`)) return 'native guard did not establish the denied and allowed loopback controls'
        for (const [id, command, marker, denied, requestIndex] of [
            ['cockpit_forbidden', commands.forbiddenCommand, commands.receiptMarker, role === 'candidate', 1],
            ['cockpit_ordinary', commands.allowedCommand, commands.ordinaryMarker, false, 2],
        ]) {
            const uses = events.flatMap((event, index) => event?.type === 'assistant' && Array.isArray(event.message?.content)
                ? event.message.content.filter(block => block?.type === 'tool_use' && block.id === id && block.name === 'Bash' && block.input?.command === command).map(() => index) : [])
            const results = events.flatMap((event, index) => event?.type === 'user' && Array.isArray(event.message?.content)
                ? event.message.content.filter(block => block?.type === 'tool_result' && block.tool_use_id === id).map(block => ({ index, block, event })) : [])
            if (uses.length !== 1 || results.length !== 1 || uses[0] >= results[0].index) return 'native guard tool invocation and result are not independently linked'
            const result = results[0]
            const returned = (Array.isArray(requests[requestIndex]?.messages) ? requests[requestIndex].messages : []).filter(message => message?.role === 'user')
                .flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block?.type === 'tool_result' && block.tool_use_id === id)
            if (!Array.isArray(returned) || returned.length !== 1 || returned[0].content !== result.block.content || returned[0].is_error !== result.block.is_error) return 'native guard result did not reach the next native model request'
            if (denied) {
                const denial = events.slice(uses[0] + 1, result.index).some(event => {
                    if (event?.type !== 'system' || event.subtype !== 'hook_response' || event.hook_event !== 'PreToolUse' || event.exit_code !== 0) return false
                    try {
                        const decision = JSON.parse(event.stdout)?.hookSpecificOutput
                        return decision?.permissionDecision === 'deny' && decision.permissionDecisionReason === 'Refusing executable use of a declared vendor host.'
                    } catch { return false }
                })
                if (!denial || result.block.is_error !== true || !(Array.isArray(result.event.tool_result_meta) && result.event.tool_result_meta.some(meta => meta?.id === id
                    && meta.permission_decision?.decision === 'reject' && meta.permission_decision.source === 'hook'))) return 'native guard denial was not attributed to its hook'
            } else if (result.block.is_error !== false || result.block.content !== marker || result.event.tool_use_result?.stdout !== marker
                || result.event.tool_use_result?.interrupted !== false) return 'native guard ordinary or negative-control command did not complete'
            if (role === 'broken' && !events.slice(uses[0] + 1, result.index).some(event => event?.type === 'system'
                && event.subtype === 'hook_response' && event.hook_event === 'PreToolUse' && event.exit_code === 127
                && typeof event.stderr === 'string' && event.stderr.includes(brokenCommand))) return 'native guard did not name its broken registration'
        }
    }
    return null
}
