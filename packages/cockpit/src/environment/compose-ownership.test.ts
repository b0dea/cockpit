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
    it('labels every service of every declared file, the default network and owned volumes, and refuses what it cannot name', () => {
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

        const withVolumes = renderComposeOwnership({ ...identity, sources: [
            { reference: 'compose.yml', source: 'services:\n  db:\n    image: busybox\nvolumes:\n  data:\n  cache: { driver: local }\n  shared: { external: true }\n' },
        ] })
        if (withVolumes.kind !== 'complete') throw new Error(withVolumes.reason)
        const volumeLabels = { ...labels, 'dev.b0dea.cockpit.generation-id': expect.stringMatching(/^[a-f0-9]{64}$/) }
        // An external volume belongs to no stack, so it stays unlabelled and out of reset's reach.
        expect(parse(withVolumes.bytes)).toEqual({
            services: { db: { labels } },
            networks: { default: { labels } },
            volumes: { cache: { labels: volumeLabels }, data: { labels: volumeLabels } },
        })

        // Compose refuses to merge a volume label the volume already sets to the same value.
        const generation = parse(withVolumes.bytes).volumes.data.labels['dev.b0dea.cockpit.generation-id']
        const declared = renderComposeOwnership({ ...identity, sources: [{ reference: 'compose.yml', source: [
            'services:', '  db:', '    image: busybox', 'volumes:',
            '  data:', '    labels:', ...Object.entries({ ...labels, 'dev.b0dea.cockpit.generation-id': generation }).map(([key, value]) => `      ${key}: ${value}`),
            '  logs:', `    labels: ["dev.b0dea.cockpit.stack-id=${identity.stackId}"]`, '',
        ].join('\n') }] })
        if (declared.kind !== 'complete') throw new Error(declared.reason)
        const { 'dev.b0dea.cockpit.stack-id': _stack, ...logsLabels } = { ...labels, 'dev.b0dea.cockpit.generation-id': generation }
        expect(parse(declared.bytes).volumes).toEqual({ logs: { labels: logsLabels } })

        expect(renderComposeOwnership({ ...identity, sources: [{ reference: 'compose.yml', source: 'include: [other.yml]\nservices:\n  api: {}\n' }] }))
            .toMatchObject({ kind: 'refusal', target: 'compose.yml', reason: expect.stringContaining('include') })
        expect(renderComposeOwnership({ ...identity, sources: [{ reference: 'compose.yml', source: 'services: [api]\n' }] }))
            .toMatchObject({ kind: 'refusal', target: 'compose.yml' })
    })
})
