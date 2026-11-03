import { describe, expect, it } from 'vitest'
import { repositoryIdentity } from './repository-identity.js'

describe('repository identity', () => {
    it('normalizes supported HTTPS, SSH URL, and SCP transports to one identity', () => {
        const remotes = [
            'https://Example.Invalid/group/service.git',
            'HTTPS://EXAMPLE.INVALID:443/group/service.git',
            'https://example.invalid./group/service',
            'ssh://git@example.invalid/group/service.git',
            'ssh://git@example.invalid:22/group/service',
            'git@example.invalid:group/service.git',
            'example.invalid:group/service',
        ]

        for (const remote of remotes) {
            expect(repositoryIdentity(remote)).toEqual({
                kind: 'known',
                identity: { host: 'example.invalid', owner: 'group', repository: 'service' },
            })
        }
    })

    it('retains host, owner, nested-owner, and repository boundaries', () => {
        expect(repositoryIdentity('https://code.invalid/one/two/service.git')).toEqual({
            kind: 'known',
            identity: { host: 'code.invalid', owner: 'one/two', repository: 'service' },
        })
        expect(repositoryIdentity('https://other.invalid/one/two/service.git'))
            .not.toEqual(repositoryIdentity('https://code.invalid/one/two/service.git'))
        expect(repositoryIdentity('https://code.invalid/one-two/service.git'))
            .not.toEqual(repositoryIdentity('https://code.invalid/one/two-service.git'))
        expect(repositoryIdentity('https://code.invalid/one/service.git.git')).toEqual({
            kind: 'known',
            identity: { host: 'code.invalid', owner: 'one', repository: 'service.git' },
        })
    })

    it('accepts a repository at the host root across supported transports', () => {
        for (const remote of [
            'https://example.invalid/api.git',
            'ssh://example.invalid/api.git',
            'git@example.invalid:api.git',
        ]) {
            expect(repositoryIdentity(remote)).toEqual({
                kind: 'known',
                identity: { host: 'example.invalid', owner: '', repository: 'api' },
            })
        }
    })

    it.each([
        'http://code.invalid/owner/service.git',
        'git://code.invalid/owner/service.git',
        'file:///srv/owner/service.git',
        '/srv/owner/service.git',
        '../owner/service.git',
        'C:\\owner\\service.git',
        // A drive-relative Windows path has the host:path shape of an SCP remote.
        'C:owner/service.git',
        'ssh://git@code.invalid:2200/owner/service.git',
        'ssh://git@[2001:db8::1]/owner/service.git',
    ])('returns explicit unknown for unsupported transport %s', (remote) => {
        expect(repositoryIdentity(remote)).toEqual({ kind: 'unknown', reason: 'unsupported' })
    })

    it.each([
        'https://token@code.invalid/owner/service.git',
        'https://user:password@code.invalid/owner/service.git',
        'ssh://token@code.invalid/owner/service.git',
        'token@code.invalid:owner/service.git',
    ])('refuses credential-bearing input without returning it: %s', (remote) => {
        const result = repositoryIdentity(remote)

        expect(result).toEqual({ kind: 'unknown', reason: 'credentialed' })
        expect(JSON.stringify(result)).not.toContain(remote)
        expect(JSON.stringify(result)).not.toMatch(/token|password/)
    })

    it.each([
        '',
        'https://code.invalid/owner/',
        'https://code.invalid/owner//service.git',
        'https://code.invalid/owner/../service.git',
        'https://code.invalid/owner/%73ervice.git',
        'https://code.invalid/owner/service.git?ref=main',
        'https://code.invalid/owner/service.git#fragment',
        'https://code.invalid\\@other.invalid/owner/service.git',
        'https://code.invalid/owner\\sub/service.git',
        'https://code.invalid/owner/x\\..\\service.git',
        'https:///code.invalid/owner/service.git',
        'https://@code.invalid/owner/service.git',
        'https://code.invalid:/owner/service.git',
        'https://ｅxample.invalid/owner/service.git',
        'https://example。invalid/owner/service.git',
        'https://127.1/owner/service.git',
        'https://0177.0.0.1/owner/service.git',
        'https://0x7f000001/owner/service.git',
        'https://0x7f.0.0.1/owner/service.git',
        'https://127.0.0x0.1/owner/service.git',
        'git@code.invalid:/owner/service.git',
        ' https://code.invalid/owner/service.git',
        'https://code.invalid/owner/service.git\n',
        'git@@code.invalid:owner/service.git',
    ])('returns explicit unknown for malformed or ambiguous input %j', (remote) => {
        expect(repositoryIdentity(remote)).toEqual({ kind: 'unknown', reason: 'malformed' })
    })

    it('preserves ordinary DNS labels that contain digits', () => {
        expect(repositoryIdentity('https://node1.code.invalid/owner/service.git')).toEqual({
            kind: 'known',
            identity: { host: 'node1.code.invalid', owner: 'owner', repository: 'service' },
        })
    })

    it('bounds input and never includes the rejected value in its result', () => {
        const remote = `https://code.invalid/owner/${'a'.repeat(2_100)}.git`
        const result = repositoryIdentity(remote)

        expect(result).toEqual({ kind: 'unknown', reason: 'unbounded' })
        expect(JSON.stringify(result)).not.toContain('a'.repeat(100))
    })

    it('classifies non-string values without coercion or disclosure', () => {
        for (const value of [null, undefined, 1, {}, { toString: () => 'https://code.invalid/owner/service.git' }]) {
            expect(repositoryIdentity(value)).toEqual({ kind: 'unknown', reason: 'malformed' })
        }
    })
})
