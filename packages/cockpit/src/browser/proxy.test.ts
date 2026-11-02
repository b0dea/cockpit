import { describe, expect, it } from 'vitest'
import { browserHostAllowed, resolveBrowserProxy } from './proxy.js'

describe('browser proxy exposure', () => {
    it('keeps the server on container loopback and publishes only the checking proxy', () => {
        const proxy = resolveBrowserProxy({ serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] })
        expect(proxy).toEqual({
            server: { bind: '127.0.0.1', port: 3000, publish: false },
            proxy: { bind: '127.0.0.1', port: 3001, allowedHosts: ['localhost:3001'], checkHost: true },
        })
        expect(browserHostAllowed(proxy, 'localhost:3001')).toBe(true)
        for (const header of [undefined, 'attacker.invalid:3001', 'localhost:3000', 'localhost',
            'localhost:3001.attacker.invalid', 'localhost:3001,attacker.invalid', 'localhost:3001\r\nX: y',
            ['localhost:3001', 'localhost:3001']]) {
            expect(browserHostAllowed(proxy, header), JSON.stringify(header)).toBe(false)
        }
    })

    it('refuses non-loopback control publication and never publishes the browser server', () => {
        for (const bind of ['0.0.0.0', '::'] as const) {
            const formerDecision = { serverPort: 3000, proxyPort: 3001, allowedHosts: ['browser.example.invalid:3001'], bind, widerExposure: true }
            expect(() => Reflect.apply(resolveBrowserProxy, undefined, [formerDecision]), bind).toThrow('loopback')
        }
        expect(resolveBrowserProxy({ serverPort: 3000, proxyPort: 3001, allowedHosts: ['[::1]:3001'], bind: '::1' }).proxy.bind).toBe('::1')
        expect(resolveBrowserProxy({ serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] }).server).toEqual({ bind: '127.0.0.1', port: 3000, publish: false })
    })

    it('refuses ambiguous authorities, wildcard hosts and invalid ports', () => {
        for (const host of ['*', '*.example.invalid:3001', 'http://localhost:3001', 'localhost:3002', 'user@localhost:3001', 'localhost:3001/path',
            'localhost:03001', 'null:3001', 'undefined:3001']) {
            expect(() => resolveBrowserProxy({ serverPort: 3000, proxyPort: 3001, allowedHosts: [host] }), host).toThrow('Host')
        }
        for (const port of [0, 65536, 1.5, Number.NaN]) {
            expect(() => resolveBrowserProxy({ serverPort: port, proxyPort: 3001, allowedHosts: ['localhost:3001'] })).toThrow('port')
        }
    })

    it('preserves explicit standard ports in the Host allowlist', () => {
        const proxy = resolveBrowserProxy({ serverPort: 3000, proxyPort: 80, allowedHosts: ['localhost:80'] })
        expect(browserHostAllowed(proxy, 'localhost:80')).toBe(true)
        expect(browserHostAllowed(proxy, 'localhost')).toBe(false)
    })
})
