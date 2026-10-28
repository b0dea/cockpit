import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanOwnedPackageDist } from '../scripts/build.mjs'

const scratch: string[] = []

afterEach(async () => Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))))

function packageFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-build-'))
    scratch.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@b0dea/cockpit' }))
    return root
}

describe('package build output ownership', () => {
    it('removes stale files only from the owned package dist directory', async () => {
        const root = packageFixture()
        mkdirSync(join(root, 'dist'))
        writeFileSync(join(root, 'dist/stale-wrapper.js'), 'stale')
        writeFileSync(join(root, 'keep.txt'), 'keep')

        await cleanOwnedPackageDist(root)

        expect(() => readFileSync(join(root, 'dist/stale-wrapper.js'))).toThrow()
        expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep')
    })

    it('refuses a linked dist directory without touching its target', async () => {
        const root = packageFixture()
        const borrowed = mkdtempSync(join(tmpdir(), 'cockpit-build-borrowed-'))
        scratch.push(borrowed)
        writeFileSync(join(borrowed, 'owned-elsewhere.js'), 'keep')
        symlinkSync(borrowed, join(root, 'dist'))

        await expect(cleanOwnedPackageDist(root)).rejects.toThrow('PACKAGE_DIST_INVALID')
        expect(readFileSync(join(borrowed, 'owned-elsewhere.js'), 'utf8')).toBe('keep')
    })
})
