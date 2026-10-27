// Owns the process-wide record of executables whose bytes were already hashed and matched. The Node
// binary is over 100 MB and every authenticated child process re-checked it, which made each guarded
// tool call hash it several times. A file is recognised again only while its device, inode, size,
// mode, modification and change times are all unchanged: an unprivileged process cannot rewrite or
// replace a file without moving its change time or inode, so a matching fingerprint is the same
// evidence a re-hash gives under the executor's cooperative-filesystem model. It decides nothing:
// callers still compare the digest with the one they expect.
import type { Stats } from 'node:fs'

export const mechanism = {
    id: 'environment-verified-digest', module: 'packages/cockpit/src/environment-exec/verified-digest.ts',
    exports: ['fileFingerprint', 'recordVerifiedDigest', 'verifiedDigest'],
} as const

const MAX_ENTRIES = 64
const verified = new Map<string, string>()

export function fileFingerprint(path: string, status: Pick<Stats, 'dev' | 'ino' | 'size' | 'mode' | 'mtimeMs' | 'ctimeMs'>): string {
    return JSON.stringify([path, status.dev, status.ino, status.size, status.mode, status.mtimeMs, status.ctimeMs])
}

export function recordVerifiedDigest(fingerprint: string, sha256: string): void {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('verified digest must be a SHA-256 hex string')
    verified.delete(fingerprint)
    verified.set(fingerprint, sha256)
    if (verified.size > MAX_ENTRIES) verified.delete(verified.keys().next().value!)
}

export function verifiedDigest(fingerprint: string): string | undefined {
    return verified.get(fingerprint)
}
