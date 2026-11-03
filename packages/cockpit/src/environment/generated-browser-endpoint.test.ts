import { describe, expect, it } from 'vitest'
import { browserEndpointUnpublished } from './generated-application/prepare.js'

const compose = (...services: string[]) => [{ reference: 'compose.yml', source: `services:\n${services.join('')}` }]
const service = (id: string, port: string) => `  ${id}:\n    image: synthetic\n    ports: ["${port}"]\n`

describe('browser endpoint publication', () => {
    const endpoint = 'ws://localhost:3001/'
    const bases = { BROWSER_PORT: 3001 }

    it('accepts an endpoint port that exactly one service publishes on loopback, by literal or ports.bases variable', () => {
        expect(browserEndpointUnpublished(endpoint, compose(service('browser', '127.0.0.1:${BROWSER_PORT}:3001')), bases)).toBeUndefined()
        expect(browserEndpointUnpublished(endpoint, compose(service('browser', 'localhost:3001:3001'), service('app', '127.0.0.1:4100:3000')), bases)).toBeUndefined()
    })

    it('names why an unpublished, wider or doubly published port is refused', () => {
        expect(browserEndpointUnpublished(endpoint, compose(service('app', '127.0.0.1:4100:3000')), bases))
            .toContain('not published on loopback by any service')
        // No host interface binds every interface, which is not loopback.
        expect(browserEndpointUnpublished(endpoint, compose(service('browser', '${BROWSER_PORT}:3001')), bases))
            .toContain('not published on loopback by any service')
        expect(browserEndpointUnpublished(endpoint, compose(service('browser', '127.0.0.1:${BROWSER_PORT}:3001'), service('other', '127.0.0.1:3001:3001')), bases))
            .toContain('more than one service (compose.yml:browser, compose.yml:other)')
        expect(browserEndpointUnpublished(endpoint, [], bases)).toContain('not published on loopback by any service')
    })
})
