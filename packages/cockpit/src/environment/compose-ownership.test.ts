import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { renderComposeOwnership } from './compose-ownership.js'

const identity = {
    stackId: `stack:${'a'.repeat(64)}`,
    cockpitId: `cockpit:duo:${'b'.repeat(64)}`,
    configSha256: 'c'.repeat(64),
}
const labels = {
    'dev.b0dea.cockpit.config-sha256': identity.configSha256,
    'dev.b0dea.cockpit.owner-id': identity.cockpitId,
    'dev.b0dea.cockpit.stack-id': identity.stackId,
}

describe('compose-first ownership override', () => {
    it('labels every service of every declared file and the default network, and refuses what it cannot name', () => {
        const rendered = renderComposeOwnership({ ...identity, sources: [
            { reference: 'compose.yml', source: 'services:\n  web:\n    build: ./web\n  api:\n    image: busybox\n' },
            { reference: 'compose.worker.yml', source: 'services:\n  worker:\n    image: busybox\n' },
        ] })
        if (rendered.kind !== 'complete') throw new Error(rendered.reason)
        expect(rendered.bytes).not.toContain('&')
        expect(parse(rendered.bytes)).toEqual({
            services: { api: { labels }, web: { labels }, worker: { labels } },
            networks: { default: { labels } },
        })

        expect(renderComposeOwnership({ ...identity, sources: [{ reference: 'compose.yml', source: 'include: [other.yml]\nservices:\n  api: {}\n' }] }))
            .toMatchObject({ kind: 'refusal', target: 'compose.yml', reason: expect.stringContaining('include') })
        expect(renderComposeOwnership({ ...identity, sources: [{ reference: 'compose.yml', source: 'services: [api]\n' }] }))
            .toMatchObject({ kind: 'refusal', target: 'compose.yml' })
        expect(renderComposeOwnership({ ...identity, sources: [{ reference: 'compose.yml', source: 'volumes: {}\n' }] }))
            .toMatchObject({ kind: 'refusal', reason: 'the Compose files declare no services' })
    })
})
