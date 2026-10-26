export const mechanism = {
    id: 'repository-identity',
    module: 'packages/cockpit/src/environment/repository-identity.ts',
    exports: ['repositoryIdentity'],
} as const

export interface RepositoryIdentity {
    readonly host: string
    readonly owner: string
    readonly repository: string
}

export type RepositoryIdentityResult =
    | Readonly<{ kind: 'known'; identity: Readonly<RepositoryIdentity> }>
    | Readonly<{ kind: 'unknown'; reason: 'credentialed' | 'malformed' | 'unbounded' | 'unsupported' }>

const INPUT_LIMIT_BYTES = 2_048
const PATH_SEGMENT_LIMIT = 32
const PATH_SEGMENT_LIMIT_BYTES = 255
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const SAFE_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function unknown(reason: Exclude<RepositoryIdentityResult, { kind: 'known' }>['reason']): RepositoryIdentityResult {
    return Object.freeze({ kind: 'unknown', reason })
}

function normalizedHost(value: string): string | undefined {
    const host = value.toLowerCase().replace(/\.$/, '')
    if (host.length === 0 || Buffer.byteLength(host) > 253) return undefined
    const labels = host.split('.')
    if (labels.every((label) => /^(?:\d+|0x[0-9a-f]+)$/.test(label))) {
        if (labels.length !== 4 || labels.some((label) => !/^(?:0|[1-9]\d{0,2})$/.test(label) || Number(label) > 255)) {
            return undefined
        }
        return host
    }
    if (labels.some((label) => label.length === 0 || label.length > 63 || !SAFE_HOST_LABEL.test(label))) return undefined
    return host
}

function known(hostValue: string, pathValue: string): RepositoryIdentityResult {
    const host = normalizedHost(hostValue)
    const path = pathValue.startsWith('/') ? pathValue.slice(1) : pathValue
    if (!host || path.length === 0 || path.startsWith('/') || path.endsWith('/') || path.includes('//')) {
        return unknown('malformed')
    }
    const segments = path.split('/')
    if (segments.length > PATH_SEGMENT_LIMIT) return unknown('malformed')
    if (segments.some((segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment))) {
        return unknown('malformed')
    }
    let repository = segments.pop()!
    if (repository.endsWith('.git')) repository = repository.slice(0, -4)
    if (repository.length === 0 || repository === '.' || repository === '..') return unknown('malformed')
    if ([...segments, repository].some((segment) => Buffer.byteLength(segment) > PATH_SEGMENT_LIMIT_BYTES)) {
        return unknown('unbounded')
    }
    const identity = Object.freeze({ host, owner: segments.join('/'), repository })
    return Object.freeze({ kind: 'known', identity })
}

function urlIdentity(value: string, scheme: string): RepositoryIdentityResult {
    if (scheme !== 'https' && scheme !== 'ssh') return unknown('unsupported')
    const authorityStart = scheme.length + 3
    if (value.length === authorityStart || value[authorityStart] === '/') return unknown('malformed')
    const remainder = value.slice(authorityStart)
    const pathStart = remainder.indexOf('/')
    if (pathStart < 1) return unknown('malformed')
    const authority = remainder.slice(0, pathStart)
    const path = remainder.slice(pathStart)
    const at = authority.indexOf('@')
    if (at === 0 || at !== authority.lastIndexOf('@')) return unknown('malformed')
    let hostAndPort = authority
    if (at > 0) {
        const username = authority.slice(0, at)
        if (scheme === 'https' || username !== 'git') return unknown('credentialed')
        hostAndPort = authority.slice(at + 1)
    }
    const colon = hostAndPort.indexOf(':')
    let host = hostAndPort
    if (colon >= 0) {
        if (colon !== hostAndPort.lastIndexOf(':')) return unknown('unsupported')
        host = hostAndPort.slice(0, colon)
        const port = hostAndPort.slice(colon + 1)
        if (host.length === 0 || port.length === 0) return unknown('malformed')
        if (port !== (scheme === 'https' ? '443' : '22')) return unknown('unsupported')
    }
    return known(host, path)
}

export function repositoryIdentity(value: unknown): RepositoryIdentityResult {
    if (typeof value !== 'string') return unknown('malformed')
    if (Buffer.byteLength(value) > INPUT_LIMIT_BYTES) return unknown('unbounded')
    if (value.length === 0 || /[\s\x00-\x1f\x7f]/u.test(value) || /[%?#]/.test(value)) return unknown('malformed')
    if (/^[A-Za-z]:/.test(value) || /^[./~\\]/.test(value)) return unknown('unsupported')
    if (value.includes('\\')) return unknown('malformed')
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)) return unknown('malformed')

    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value)
    if (scheme) return urlIdentity(value, scheme[1].toLowerCase())
    const scp = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/.exec(value)
    if (!scp) return unknown('malformed')
    const [, username, host, path] = scp
    if (username !== undefined && username !== 'git') return unknown('credentialed')
    if (path.startsWith('/')) return unknown('malformed')
    return known(host, path)
}
