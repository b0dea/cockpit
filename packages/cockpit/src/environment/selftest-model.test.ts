import { request } from 'node:http'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { startSelftestModel } from './selftest-model.js'

const models: Awaited<ReturnType<typeof startSelftestModel>>[] = []

afterEach(async () => {
    await Promise.all(models.splice(0).map(model => model.close()))
})

async function start(harness: 'claudecode' | 'codexcli' = 'codexcli', guardHost?: string) {
    const model = await startSelftestModel(harness, guardHost)
    models.push(model)
    return model
}

function send(url: string, body: string | Buffer, method = 'POST', headers: Record<string, string> = {}) {
    return new Promise<{ status: number | undefined; contentType: string | undefined; body: string }>((resolve, reject) => {
        const call = request(url, { method, headers, agent: false }, response => {
            let result = ''
            response.setEncoding('utf8')
            response.on('data', chunk => { result += chunk })
            response.on('end', () => resolve({ status: response.statusCode, contentType: response.headers['content-type'], body: result }))
            response.on('error', reject)
        })
        call.on('error', reject)
        call.setTimeout(10_000, () => call.destroy(new Error('synthetic HTTP client timed out')))
        call.end(method === 'GET' ? undefined : body)
    })
}

function events(body: string): unknown[] {
    return body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
}

describe('bounded synthetic selftest model', () => {
    it('streams fixed Claude guard tools and records only authenticated loopback receipts', async () => {
        const model = await start('claudecode', 'api.vendor.example.test')
        const guard = model.guard!
        const url = new URL(model.endpoint)
        const receiptPath = `${url.pathname}/guard-receipt`
        expect(guard.host).toBe('api.vendor.example.test')
        expect(guard.forbiddenCommand).toBe(`curl --disable --silent --show-error --noproxy '*' --connect-timeout 2 --max-time 5 --resolve api.vendor.example.test:${url.port}:127.0.0.1 http://api.vendor.example.test:${url.port}${receiptPath}`)
        expect(guard.allowedCommand).toBe(`printf ${guard.ordinaryMarker}`)
        expect(guard.receiptMarker).toMatch(/^COCKPIT_GUARD_RECEIPT_[a-f0-9]{48}$/)
        expect(guard.ordinaryMarker).toMatch(/^COCKPIT_GUARD_ORDINARY_[a-f0-9]{48}$/)
        for (const [id, command] of [['cockpit_forbidden', guard.forbiddenCommand], ['cockpit_ordinary', guard.allowedCommand]]) {
            const result = await send(model.endpoint + '/v1/messages', '{}')
            expect(result.status).toBe(200)
            expect(events(result.body)).toEqual([
                expect.objectContaining({ type: 'message_start', message: expect.objectContaining({ content: [] }) }),
                { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } },
                { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } },
                { type: 'content_block_stop', index: 0 },
                expect.objectContaining({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }),
                { type: 'message_stop' },
            ])
        }
        expect((await send(new URL('/foreign/guard-receipt', model.endpoint).href, '', 'GET', { Host: `api.vendor.example.test:${url.port}` })).status).toBe(404)
        expect(guard.receipts()).toEqual([])
        expect(model.failure()).toBeUndefined()
        const receipt = await send(model.endpoint + '/guard-receipt', '', 'GET', { Host: `api.vendor.example.test:${url.port}` })
        expect(receipt).toMatchObject({ status: 200, body: guard.receiptMarker })
        expect(guard.receipts()).toEqual([receiptPath])
        expect(events((await send(model.endpoint + '/v1/messages', '{}')).body)).toContainEqual(expect.objectContaining({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }))
        expect((await send(model.endpoint + '/v1/messages', '{}')).status).toBe(200)
        expect((await send(model.endpoint + '/v1/messages', '{}')).status).toBe(429)
        expect(model.requests()).toHaveLength(4)
        expect(model.failure()).toContain('request limit')
    })

    it.each(['', '*.example.test', 'host:80', 'host/path', '-host', 'host-', 'x'.repeat(254)])('refuses an unsafe guard hostname: %s', async host => {
        await expect(startSelftestModel('claudecode', host)).rejects.toThrow('guard hostname')
    })

    it('refuses guard tools for Codex', async () => {
        await expect(startSelftestModel('codexcli', 'api.vendor.example.test')).rejects.toThrow('Claude')
    })

    it.each([
        { suffix: '/guard-receipt', host: 'foreign.example.test', method: 'GET' },
        { suffix: '/other', host: 'api.vendor.example.test', method: 'GET' },
        { suffix: '/guard-receipt', host: 'api.vendor.example.test', method: 'POST' },
    ])('fails closed on unexpected guarded receipt $method $suffix from $host', async ({ suffix, host, method }) => {
        const model = await start('claudecode', 'api.vendor.example.test')
        const url = new URL(model.endpoint)
        expect((await send(model.endpoint + suffix, '{}', method, { Host: `${host}:${url.port}` })).status).not.toBe(200)
        expect(model.guard!.receipts()).toEqual([])
        expect(model.failure()).toContain('unexpected')
        expect((await send(model.endpoint + '/v1/messages', '{}')).status).toBe(503)
    })

    it('bounds guard receipts independently from captured model requests', async () => {
        const model = await start('claudecode', 'api.vendor.example.test')
        const url = new URL(model.endpoint)
        for (let index = 0; index < 4; index++) {
            expect((await send(model.endpoint + '/guard-receipt', '', 'GET', { Host: `api.vendor.example.test:${url.port}` })).status).toBe(200)
        }
        expect((await send(model.endpoint + '/guard-receipt', '', 'GET', { Host: `api.vendor.example.test:${url.port}` })).status).toBe(429)
        expect(model.guard!.receipts()).toHaveLength(4)
        expect(model.requests()).toEqual([])
        expect(model.failure()).toContain('receipt limit')
    })

    it.each(['codexcli', 'claudecode'] as const)('captures %s JSON and returns terminal native streaming events', async harness => {
        const model = await start(harness)
        const url = new URL(model.endpoint)
        expect(url.hostname).toBe('127.0.0.1')
        expect(url.pathname).toMatch(/^\/[a-f0-9]{48}$/)
        const body = { model: 'synthetic', stream: true, input: [{ text: 'synthetic skill body' }] }
        const suffix = harness === 'codexcli' ? '/responses' : '/v1/messages?beta=true'
        const result = await send(model.endpoint + suffix, JSON.stringify(body), 'POST', { 'x-synthetic-private-header': 'not retained' })
        expect(result.status).toBe(200)
        expect(result.contentType).toBe('text/event-stream')
        expect(model.requests()).toEqual([body])
        expect(model.failure()).toBeUndefined()
        expect(JSON.stringify(model.requests())).not.toContain('not retained')
        if (harness === 'codexcli') {
            expect(events(result.body)).toEqual([expect.objectContaining({ type: 'response.completed', response: expect.objectContaining({ status: 'completed', output: [] }) })])
        } else {
            expect(events(result.body)).toEqual([
                expect.objectContaining({ type: 'message_start', message: expect.objectContaining({ role: 'assistant', content: [] }) }),
                expect.objectContaining({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
                expect.objectContaining({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Synthetic selftest complete.' } }),
                { type: 'content_block_stop', index: 0 },
                expect.objectContaining({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }),
                { type: 'message_stop' },
            ])
        }
    })

    it('rejects an unknown nonce without capturing or poisoning the legitimate probe', async () => {
        const model = await start()
        const foreign = new URL('/unknown/responses', model.endpoint)
        expect((await send(foreign.href, '{}')).status).toBe(404)
        expect(model.requests()).toEqual([])
        expect(model.failure()).toBeUndefined()
        expect((await send(model.endpoint + '/responses', '{}')).status).toBe(200)
        expect(model.requests()).toEqual([{}])
    })

    it.each([
        { suffix: '/responses', method: 'GET', status: 405 },
        { suffix: '/v1/messages', method: 'POST', status: 404 },
        { suffix: '/responses?beta=true', method: 'POST', status: 404 },
    ])('fails closed on an authenticated unexpected request $method $suffix', async ({ suffix, method, status }) => {
        const model = await start()
        expect((await send(model.endpoint + suffix, '{}', method)).status).toBe(status)
        expect(model.failure()).toContain('unexpected')
        expect((await send(model.endpoint + '/responses', '{}')).status).toBe(503)
        expect(model.requests()).toEqual([])
    })

    it.each(['{', '[]', 'null', '"text"'])('rejects invalid JSON objects before capture: %s', async body => {
        const model = await start()
        expect((await send(model.endpoint + '/responses', body)).status).toBe(400)
        expect(model.failure()).toContain('JSON object')
        expect((await send(model.endpoint + '/responses', '{}')).status).toBe(503)
        expect(model.requests()).toEqual([])
    })

    it('rejects malformed UTF-8 inside otherwise valid JSON before capture', async () => {
        const model = await start()
        const body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])
        expect((await send(model.endpoint + '/responses', body)).status).toBe(400)
        expect(model.failure()).toContain('UTF-8 JSON object')
        expect((await send(model.endpoint + '/responses', '{}')).status).toBe(503)
        expect(model.requests()).toEqual([])
    })

    it('rejects an oversized streamed body before capture', async () => {
        const model = await start()
        const result = await send(model.endpoint + '/responses', JSON.stringify({ text: 'x'.repeat(1024 * 1024) }))
        expect(result.status).toBe(413)
        expect(model.failure()).toContain('byte limit')
        expect(model.requests()).toEqual([])
    })

    it('refuses further requests after the bounded capture count', async () => {
        const model = await start()
        for (let index = 0; index < 4; index++) {
            expect((await send(model.endpoint + '/responses', JSON.stringify({ index }))).status).toBe(200)
        }
        expect((await send(model.endpoint + '/responses', '{}')).status).toBe(429)
        expect(model.failure()).toContain('request limit')
        expect(model.requests()).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }])
    })

    it('times out an incomplete authorized body without capture', async () => {
        const model = await start()
        const url = new URL(model.endpoint)
        const socket = createConnection({ host: url.hostname, port: Number(url.port) })
        const closed = once(socket, 'close')
        let response = ''
        socket.on('data', chunk => { response += chunk.toString() })
        await once(socket, 'connect')
        socket.write(`POST ${url.pathname}/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{`)
        await closed
        expect(response).toContain('408')
        expect(model.failure()).toContain('timed out')
        expect(model.requests()).toEqual([])
    })

    it('closes active sockets and permits repeated close calls', async () => {
        const model = await start()
        const url = new URL(model.endpoint)
        const socket = createConnection({ host: url.hostname, port: Number(url.port) })
        const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
        socket.on('error', error => { expect(error).toHaveProperty('code', 'ECONNRESET') })
        await once(socket, 'connect')
        await model.close()
        await closed
        expect(socket.destroyed).toBe(true)
        await model.close()
        expect(model.failure()).toBeUndefined()
    })
})
