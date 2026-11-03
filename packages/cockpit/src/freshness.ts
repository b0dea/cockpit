import { get } from 'node:https'
import { installedPackageMetadata } from './package-metadata.js'
import { RefusalError, errorCause } from './environment/contract.js'

export type ReleaseFreshness = Readonly<{
    kind: 'known'; package: string; installedVersion: string; latestVersion: string
    currency: 'same-version' | 'different-version'; observedAt: string; expiresAt: string
}> | Readonly<{ kind: 'unknown'; reason: string; observedAt?: string; expiresAt?: string }>

export type ReleaseMetadataTransport = (request: Readonly<{ url: string; signal: AbortSignal }>) => Promise<Readonly<{
    status: number; body: AsyncIterable<Uint8Array>
}>>

interface ReleaseDiscoveryInput {
    readonly verb: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly createTransport?: () => ReleaseMetadataTransport
    readonly now?: () => number
}

const MAX_BYTES = 131_072
const TIMEOUT_MS = 2_000
const CACHE_MS = 900_000
const cache = new WeakMap<() => ReleaseMetadataTransport, { expiresAt: number; value: Promise<ReleaseFreshness> }>()
const createTransport = (): ReleaseMetadataTransport => ({ url, signal }) => new Promise((resolve, reject) => {
    const request = get(url, { signal, headers: { accept: 'application/json' } }, response => {
        resolve({ status: response.statusCode ?? 0, body: response })
    })
    request.on('error', reject)
})

async function query(factory: () => ReleaseMetadataTransport, now: number): Promise<ReleaseFreshness> {
    const observedAt = new Date(now).toISOString()
    const expiresAt = new Date(now + CACHE_MS).toISOString()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new RefusalError('release metadata query timed out')) }, TIMEOUT_MS)
    })
    try {
        const transport = factory()
        const result = await Promise.race([timeout, (async () => {
            const response = await transport({ url: `https://registry.npmjs.org/${encodeURIComponent(installedPackageMetadata.name)}/latest`, signal: controller.signal })
            if (response.status !== 200) throw new RefusalError(`release metadata returned HTTP ${response.status}`)
            const chunks: Uint8Array[] = []
            let size = 0
            for await (const chunk of response.body) {
                size += chunk.byteLength
                if (size > MAX_BYTES) { controller.abort(); throw new RefusalError('release metadata exceeded byte limit') }
                chunks.push(chunk)
            }
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
            if (value === null || typeof value !== 'object' || Array.isArray(value)
                || !('name' in value) || value.name !== installedPackageMetadata.name || !('version' in value)
                || typeof value.version !== 'string' || value.version.length > 256
                || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.version)) throw new RefusalError('release metadata schema or package identity is invalid')
            return { kind: 'known' as const, package: installedPackageMetadata.name,
                installedVersion: installedPackageMetadata.version, latestVersion: value.version,
                currency: value.version === installedPackageMetadata.version ? 'same-version' as const : 'different-version' as const, observedAt, expiresAt }
        })()])
        return result
    } catch (error) {
        return { kind: 'unknown', reason: errorCause(error), observedAt, expiresAt }
    } finally {
        if (timer) clearTimeout(timer)
        controller.abort()
    }
}

export function discoverReleaseFreshness(input: ReleaseDiscoveryInput): Promise<ReleaseFreshness> {
    // Admissions precede even cache access: an opted-out caller must not reuse online evidence.
    if (input.env.CI) return Promise.resolve({ kind: 'unknown', reason: 'release discovery disabled by CI' })
    if (input.env.NO_UPDATE_NOTIFIER) return Promise.resolve({ kind: 'unknown', reason: 'release discovery disabled by NO_UPDATE_NOTIFIER' })
    if (input.verb !== 'doctor') return Promise.resolve({ kind: 'unknown', reason: 'release discovery is doctor-only' })
    const factory = input.createTransport ?? createTransport
    const now = (input.now ?? Date.now)()
    const existing = cache.get(factory)
    if (existing && existing.expiresAt > now) return existing.value
    const value = query(factory, now)
    cache.set(factory, { expiresAt: now + CACHE_MS, value })
    return value
}
