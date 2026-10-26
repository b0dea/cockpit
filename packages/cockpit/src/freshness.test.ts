import { describe, expect, it, vi } from 'vitest'
import { discoverReleaseFreshness, type ReleaseMetadataTransport } from './freshness.js'
import { installedPackageMetadata } from './package-metadata.js'

const response = (value: unknown) => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })() })

describe('doctor release metadata', () => {
    it('stays offline before transport construction for other verbs and nonempty CI or NO_UPDATE_NOTIFIER', async () => {
        const createTransport = vi.fn(() => vi.fn<ReleaseMetadataTransport>())
        for (const input of [{ verb: 'check', env: {} }, { verb: 'doctor', env: { CI: '0' } },
            { verb: 'doctor', env: { NO_UPDATE_NOTIFIER: 'false' } }]) {
            expect(await discoverReleaseFreshness({ ...input, createTransport })).toMatchObject({ kind: 'unknown' })
        }
        expect(createTransport).not.toHaveBeenCalled()
    })

    it('shares one bounded in-flight cached metadata query and retains expiry provenance', async () => {
        const transport = vi.fn<ReleaseMetadataTransport>(async () => response({ name: installedPackageMetadata.name, version: '1.2.3' }))
        const createTransport = vi.fn(() => transport)
        const request = { verb: 'doctor', env: {}, createTransport, now: () => Date.parse('2026-10-22T12:00:00.000Z') }
        const [first, second] = await Promise.all([discoverReleaseFreshness(request), discoverReleaseFreshness(request)])
        expect(first).toEqual(second)
        expect(first).toMatchObject({ kind: 'known', latestVersion: '1.2.3', observedAt: '2026-10-22T12:00:00.000Z', expiresAt: '2026-10-22T12:15:00.000Z' })
        expect(transport).toHaveBeenCalledTimes(1)
        expect(transport.mock.calls[0]![0].url).toBe(`https://registry.npmjs.org/${encodeURIComponent(installedPackageMetadata.name)}/latest`)
        expect(createTransport).toHaveBeenCalledTimes(1)
        await discoverReleaseFreshness(request)
        expect(transport).toHaveBeenCalledTimes(1)
        await discoverReleaseFreshness({ ...request, now: () => Date.parse('2026-10-22T12:15:00.000Z') })
        expect(transport).toHaveBeenCalledTimes(2)
    })

    it('bounds metadata timeout even when the transport ignores cancellation', async () => {
        vi.useFakeTimers()
        try {
            const result = discoverReleaseFreshness({ verb: 'doctor', env: {}, createTransport: () => () => new Promise(() => {}) })
            await vi.advanceTimersByTimeAsync(2_000)
            expect(await result).toMatchObject({ kind: 'unknown', reason: 'release metadata query timed out' })
        } finally { vi.useRealTimers() }
    })

    it('retains unknown evidence on wrong identity, invalid schema, byte overflow and transport failure', async () => {
        for (const transport of [
            async () => response({ name: 'another-package', version: '1.2.3' }),
            async () => response({ name: installedPackageMetadata.name, version: 1 }),
            async () => response('x'.repeat(131_073)),
            async () => { throw new Error('synthetic network unavailable') },
        ]) expect(await discoverReleaseFreshness({ verb: 'doctor', env: {}, createTransport: () => transport })).toMatchObject({ kind: 'unknown', reason: expect.any(String) })
    })
})
