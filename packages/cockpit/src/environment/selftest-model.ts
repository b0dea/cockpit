import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_REQUESTS = 4
const REQUEST_TIMEOUT_MS = 5_000

interface GuardProbe {
    host: string
    forbiddenCommand: string
    allowedCommand: string
    receiptMarker: string
    ordinaryMarker: string
    receipts(): readonly string[]
}

function modelEvents(harness: 'claudecode' | 'codexcli', request: object, tool?: { id: string; command: string }): string {
    const model = 'model' in request && typeof request.model === 'string' ? request.model : 'synthetic'
    const events = harness === 'codexcli'
        ? [{ type: 'response.completed', response: {
            id: 'resp_synthetic', object: 'response', created_at: 0, model, status: 'completed', output: [],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        } }]
        : [
            { type: 'message_start', message: {
                id: 'msg_synthetic', type: 'message', role: 'assistant', model, content: [], stop_reason: null,
                stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
            } },
            { type: 'content_block_start', index: 0, content_block: tool
                ? { type: 'tool_use', id: tool.id, name: 'Bash', input: {} }
                : { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: tool
                ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: tool.command }) }
                : { type: 'text_delta', text: 'Synthetic selftest complete.' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
            { type: 'message_stop' },
        ]
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** Captures native input locally; guard mode requests fixed commands confined to this listener. */
export async function startSelftestModel(harness: 'claudecode' | 'codexcli', guardHost?: string): Promise<{
    endpoint: string
    guard?: GuardProbe
    requests(): readonly unknown[]
    failure(): string | undefined
    close(): Promise<void>
}> {
    if (guardHost !== undefined) {
        if (harness !== 'claudecode') throw new Error('selftest guard tools require Claude')
        if (guardHost.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(guardHost)) {
            throw new Error('selftest guard hostname must be a DNS hostname without wildcards, ports or paths')
        }
    }
    const route = `/${randomBytes(24).toString('hex')}`
    const path = `${route}${harness === 'codexcli' ? '/responses' : '/v1/messages'}`
    const receiptPath = `${route}/guard-receipt`
    const captured: unknown[] = []
    const receipts: string[] = []
    let guard: GuardProbe | undefined
    let guardAuthority: string | undefined
    let failure: string | undefined
    let closing: Promise<void> | undefined
    const server = createServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: 1_000 }, (request, response) => {
        const reject = (status: number, reason: string, recordFailure = true) => {
            if (recordFailure) failure ??= reason
            response.writeHead(status, { 'Content-Type': 'text/plain', 'Connection': 'close' })
            response.end(reason)
            request.resume()
        }
        // Unrelated local traffic must not be able to poison a probe whose nonce it does not know.
        if (request.url !== route && !request.url?.startsWith(`${route}/`)) {
            reject(404, 'unknown selftest model route', false)
            return
        }
        if (failure !== undefined) { reject(503, 'selftest model capture already failed'); return }
        if (guard && request.url === receiptPath) {
            if (request.method !== 'GET' || request.headers.host !== guardAuthority) {
                reject(400, 'unexpected selftest guard receipt method or host')
                return
            }
            if (receipts.length >= MAX_REQUESTS) { reject(429, 'selftest guard receipt limit exceeded'); return }
            receipts.push(receiptPath)
            response.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'close' })
            response.end(guard.receiptMarker)
            request.resume()
            return
        }
        if (request.method !== 'POST') { reject(405, 'unexpected selftest model request method'); return }
        if (request.url !== path && !(harness === 'claudecode' && request.url === `${path}?beta=true`)) {
            reject(404, 'unexpected selftest model request path')
            return
        }
        if (captured.length >= MAX_REQUESTS) { reject(429, 'selftest model request limit exceeded'); return }
        let size = 0
        const chunks: Buffer[] = []
        let finished = false
        const timer = setTimeout(() => {
            if (finished) return
            finished = true
            reject(408, 'selftest model request timed out')
        }, REQUEST_TIMEOUT_MS)
        const stop = () => { finished = true; clearTimeout(timer) }
        request.on('data', (chunk: Buffer) => {
            if (finished) return
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                stop()
                reject(413, 'selftest model request byte limit exceeded')
                return
            }
            chunks.push(chunk)
        })
        request.on('error', () => {
            stop()
            if (!closing) failure ??= 'selftest model request stream failed'
        })
        request.on('aborted', () => {
            stop()
            if (!closing) failure ??= 'selftest model request was aborted'
        })
        request.on('end', () => {
            if (finished) return
            stop()
            let body: unknown
            try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch {
                reject(400, 'selftest model request must contain a UTF-8 JSON object')
                return
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                reject(400, 'selftest model request must contain a JSON object')
                return
            }
            // Concurrent uploads must recheck the shared limits after finishing their bodies.
            if (failure !== undefined) { reject(503, 'selftest model capture already failed'); return }
            if (captured.length >= MAX_REQUESTS) { reject(429, 'selftest model request limit exceeded'); return }
            captured.push(body)
            const tool = !guard || captured.length > 2 ? undefined : captured.length === 1
                ? { id: 'cockpit_forbidden', command: guard.forbiddenCommand }
                : { id: 'cockpit_ordinary', command: guard.allowedCommand }
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' })
            response.end(modelEvents(harness, body, tool))
        })
    })
    server.on('error', error => { failure ??= `selftest model listener failed: ${error.message}` })
    server.on('clientError', (_error, socket) => {
        if (!closing) failure ??= 'selftest model received an invalid HTTP request'
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('selftest model listener has no TCP address')
    if (guardHost !== undefined) {
        guardAuthority = `${guardHost}:${address.port}`
        const receiptMarker = `COCKPIT_GUARD_RECEIPT_${route.slice(1)}`
        const ordinaryMarker = `COCKPIT_GUARD_ORDINARY_${route.slice(1)}`
        guard = {
            host: guardHost,
            forbiddenCommand: `curl --disable --silent --show-error --noproxy '*' --connect-timeout 2 --max-time 5 --resolve ${guardAuthority}:127.0.0.1 http://${guardAuthority}${receiptPath}`,
            allowedCommand: `printf ${ordinaryMarker}`,
            receiptMarker,
            ordinaryMarker,
            receipts: () => receipts.slice(),
        }
    }
    return {
        endpoint: `http://127.0.0.1:${address.port}${route}`,
        ...(guard ? { guard } : {}),
        requests: () => captured.slice(),
        failure: () => failure,
        close: () => {
            closing ??= new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(new Error(`selftest model listener could not close: ${error.message}`)) : resolve())
                server.closeAllConnections()
            })
            return closing
        },
    }
}
