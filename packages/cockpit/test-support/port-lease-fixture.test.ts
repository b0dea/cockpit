import { createServer, createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CheckoutId, CockpitId, HolderId, StackId } from '../src/environment/contract.js'
import { selectStateRoot } from '../src/environment/state.js'
import { leasePortFamilyFixture, withSyntheticLoopbackListeners } from './port-lease-fixture.js'

describe('synthetic port lease fixture', () => {
    it('uses declared listener evidence against a hostile host and restores sockets after errors', async () => {
        const server = createServer()
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })
        const root = await mkdtemp(join(tmpdir(), 'cockpit-port-lease-fixture-'))
        try {
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('fixture listener address unavailable')
            const now = new Date().toISOString()
            const cockpitId = `cockpit:port-fixture:${'a'.repeat(64)}` as CockpitId
            const namespace = await selectStateRoot({ platform: 'linux', home: root, cockpitId })
            if (namespace.kind !== 'complete') throw new Error('fixture state root unavailable')
            const evidence = [{
                ports: [address.port],
                observation: { state: 'available' as const, value: [], observedAt: now, producer: 'synthetic-port-fixture' },
            }]
            await expect(leasePortFamilyFixture({
                namespace: namespace.value,
                stackId: `stack:${'b'.repeat(64)}` as StackId,
                holderId: `holder:${'c'.repeat(64)}:session` as HolderId,
                checkoutId: `checkout:${'d'.repeat(64)}` as CheckoutId,
                config: { step: 1, count: 1, bases: { WEB: address.port } },
                now,
                listenerTimeoutMs: 250,
                listenerEvidence: evidence,
            })).resolves.toMatchObject({ kind: 'complete', lease: { ports: { WEB: address.port } } })

            await expect(withSyntheticLoopbackListeners(evidence, () => new Promise<string>((resolveCode, reject) => {
                const socket = createConnection({ host: '127.0.0.1', port: address.port + 1 })
                socket.once('connect', () => { socket.destroy(); reject(new Error('undeclared loopback port connected')) })
                socket.once('error', (error: NodeJS.ErrnoException) => resolveCode(error.code ?? ''))
            }))).resolves.toBe('ERR_TEST_PORT_UNDECLARED')

            const failure = new Error('synthetic callback failure')
            await expect(withSyntheticLoopbackListeners(evidence, async () => { throw failure })).rejects.toBe(failure)
            await expect(new Promise<void>((resolve, reject) => {
                const socket = createConnection({ host: '127.0.0.1', port: address.port })
                socket.once('connect', () => { socket.destroy(); resolve() })
                socket.once('error', reject)
            })).resolves.toBeUndefined()
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            await rm(root, { recursive: true, force: true })
        }
    })
})
