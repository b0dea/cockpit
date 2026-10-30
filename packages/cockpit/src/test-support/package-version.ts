import { readFileSync } from 'node:fs'

// Why: the release step bumps this version, so a test that spells it out fails on the release pull
// request. It is read from the manifest rather than from package-metadata.ts, so a CLI that reports
// the wrong version still fails the assertions built on it.
const manifestUrl = new URL('../../package.json', import.meta.url)
const manifest: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'))
if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new Error(`${manifestUrl.pathname} has no string version field`)
}

export const cockpitPackageVersion: string = manifest.version
