import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_REQUESTS = 4
const REQUEST_TIMEOUT_MS = 5_000

function terminalEvents(harness: 'claudecode' | 'codexcli', request: object): string {
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
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic selftest complete.' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
            { type: 'message_stop' },
        ]
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** Captures native prompt input locally; the response performs no inference or tool calls. */
export async function startSelftestModel(harness: 'claudecode' | 'codexcli'): Promise<{
    endpoint: string
    requests(): readonly unknown[]
    failure(): string | undefined
    close(): Promise<void>
}> {
    const route = `/${randomBytes(24).toString('hex')}`
    const path = `${route}${harness === 'codexcli' ? '/responses' : '/v1/messages'}`
    const captured: unknown[] = []
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
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
                reject(400, 'selftest model request must contain a JSON object')
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
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' })
            response.end(terminalEvents(harness, body))
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
    return {
        endpoint: `http://127.0.0.1:${address.port}${route}`,
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
