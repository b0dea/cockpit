import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createConnection } from 'node:net'

import { leasePortFamily } from '../src/environment/ports.js'

export async function withSyntheticLoopbackListeners<T>(
    listenerEvidence: Parameters<typeof leasePortFamily>[0]['listenerEvidence'],
    operation: () => Promise<T>,
): Promise<T> {
    const declared = new Map<number, boolean | undefined>()
    for (const entry of listenerEvidence) {
        const occupied = entry.observation.state === 'available' ? new Set(entry.observation.value) : undefined
        for (const port of entry.ports) declared.set(port, occupied?.has(port))
    }
    const mutableNet = createRequire(import.meta.url)('node:net') as typeof import('node:net')
    const actualCreateConnection = mutableNet.createConnection
    mutableNet.createConnection = ((...args: unknown[]) => {
        const first = args[0]
        const port = typeof first === 'number'
            ? first
            : first && typeof first === 'object' && 'port' in first ? (first as { port?: unknown }).port : undefined
        const socket = new EventEmitter() as unknown as ReturnType<typeof createConnection>
        socket.destroy = () => socket
        socket.setTimeout = () => socket
        queueMicrotask(() => {
            if (typeof port !== 'number' || !declared.has(port) || declared.get(port) === undefined) {
                socket.emit('error', Object.assign(new Error(`loopback port ${String(port)} has no synthetic listener evidence`), {
                    code: 'ERR_TEST_PORT_UNDECLARED',
                }))
            } else if (declared.get(port)) socket.emit('connect')
            else socket.emit('error', Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
        })
        return socket
    }) as typeof createConnection
    syncBuiltinESMExports()
    try {
        return await operation()
    } finally {
        mutableNet.createConnection = actualCreateConnection
        syncBuiltinESMExports()
    }
}

export function leasePortFamilyFixture(input: Parameters<typeof leasePortFamily>[0]) {
    return withSyntheticLoopbackListeners(input.listenerEvidence, () => leasePortFamily(input))
}
