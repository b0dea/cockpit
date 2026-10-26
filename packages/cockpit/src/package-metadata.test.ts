import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { installedPackageMetadata } from './package-metadata.js'

describe('installed package metadata', () => {
    it('fails closed for absent or malformed installed identity without caller fallback', () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-package-metadata-'))
        try {
            mkdirSync(join(root, 'src'))
            const modulePath = join(root, 'src/package-metadata.ts')
            writeFileSync(modulePath, readFileSync(new URL('./package-metadata.ts', import.meta.url)))
            const actual = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
            for (const changed of [{ ...actual, name: '' }, { ...actual, version: 'latest' },
                { ...actual, engines: {} }, { ...actual, cockpitSourceRevision: null }]) {
                writeFileSync(join(root, 'package.json'), JSON.stringify(changed))
                const result = spawnSync(process.execPath, ['--import', 'tsx', modulePath], { encoding: 'utf8' })
                expect(result.status).not.toBe(0)
                expect(result.stderr).toContain('Installed package metadata is invalid')
            }
        } finally { rmSync(root, { recursive: true, force: true }) }
    })
    it('uses the actual source-relative package identity and freezes its complete projection', () => {
        const actual = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        expect(installedPackageMetadata).toEqual({ name: actual.name, version: actual.version,
            engines: { node: actual.engines.node }, cockpitSourceRevision: actual.cockpitSourceRevision })
        expect(Object.isFrozen(installedPackageMetadata)).toBe(true)
        expect(Object.isFrozen(installedPackageMetadata.engines)).toBe(true)
    })
})
