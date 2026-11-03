import { isProxy } from 'node:util/types'
import { RefusalError } from '../environment/contract.js'

export interface BrowserProxyInput {
    readonly serverPort: number
    readonly proxyPort: number
    readonly allowedHosts: readonly string[]
    readonly bind?: '127.0.0.1' | '::1'
}

function port(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 65535
}

export function browserProxyAuthorityMatches(value: string, expectedPort: number): boolean {
    if (!port(expectedPort) || typeof value !== 'string' || value.length > 260 || !/^[a-z0-9.[\]:-]+$/.test(value)) return false
    try {
        const parsed = new URL(`http://${value}`)
        return value === `${parsed.hostname}:${expectedPort}`
            && parsed.hostname !== 'undefined' && parsed.hostname !== 'null'
    } catch {
        // A URL parse error quotes the authority; a boolean answer is the whole contract.
        return false
    }
}

export function resolveBrowserProxy(input: BrowserProxyInput) {
    if (!input || typeof input !== 'object' || isProxy(input)
        || Object.values(Object.getOwnPropertyDescriptors(input)).some((descriptor) => !('value' in descriptor))) {
        throw new RefusalError('browser proxy input must contain plain data')
    }
    if (!port(input.serverPort) || !port(input.proxyPort) || input.serverPort === input.proxyPort) {
        throw new RefusalError('browser proxy needs distinct valid server and proxy ports')
    }
    const bind = input.bind ?? '127.0.0.1'
    if (bind !== '127.0.0.1' && bind !== '::1') throw new RefusalError('browser proxy control publication must remain on loopback until authenticated transport is available')
    if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length === 0 || input.allowedHosts.length > 64
        || isProxy(input.allowedHosts)
        || Reflect.ownKeys(input.allowedHosts).length !== input.allowedHosts.length + 1
        || Object.values(Object.getOwnPropertyDescriptors(input.allowedHosts)).some((descriptor) => !('value' in descriptor))
        || new Set(input.allowedHosts).size !== input.allowedHosts.length
        || !input.allowedHosts.every((host) => browserProxyAuthorityMatches(host, input.proxyPort))) {
        throw new RefusalError('browser proxy Host allowlist must contain exact hostname:port authorities')
    }
    return {
        server: { bind: '127.0.0.1' as const, port: input.serverPort, publish: false as const },
        proxy: { bind, port: input.proxyPort, allowedHosts: [...input.allowedHosts], checkHost: true as const },
    }
}

export type BrowserProxyProjection = ReturnType<typeof resolveBrowserProxy>

export function browserHostAllowed(policy: BrowserProxyProjection, host: unknown): boolean {
    return typeof host === 'string' && browserProxyAuthorityMatches(host, policy.proxy.port) && policy.proxy.allowedHosts.includes(host)
}
