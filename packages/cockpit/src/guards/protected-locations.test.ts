import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GUARD_SECRET_FILE_LIMIT } from './evaluator.js'
import { guardInstalledDirectories, guardSearchDirectories, guardSearchPathRelativeEntry, guardSecretFiles, guardSensitivePathsBelow } from './protected-locations.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-protected-locations-')))
    roots.push(root)
    return root
}
function writePackage(directory: string, name: string, dependencies: Record<string, string> = {}) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, dependencies }))
}

describe('guard protected locations', () => {
    it('finds the running package, its consumer spelling and every package it loads as Node resolves them', () => {
        const root = scratch()
        const store = join(root, 'store/tool')
        writePackage(store, '@synthetic/tool', { 'dep-a': '1.0.0' })
        mkdirSync(join(root, 'consumer/node_modules/@synthetic'), { recursive: true })
        symlinkSync(store, join(root, 'consumer/node_modules/@synthetic/tool'))
        // The consumer's own copies are decoys: Node resolves the package's imports from its real path.
        writePackage(join(root, 'consumer/node_modules/dep-a'), 'dep-a', { 'dep-b': '1.0.0' })
        writePackage(join(root, 'consumer/node_modules/dep-a/node_modules/dep-b'), 'dep-b')
        writePackage(join(root, 'consumer/node_modules/dep-b'), 'dep-b')
        writePackage(join(root, 'store/node_modules/dep-a'), 'dep-a', { 'dep-b': '1.0.0' })
        writePackage(join(root, 'store/node_modules/dep-a/node_modules/dep-b'), 'dep-b')
        expect(guardInstalledDirectories(store, join(root, 'consumer'))).toEqual([
            join(root, 'consumer/node_modules/@synthetic/tool'), store,
            join(root, 'store/node_modules/dep-a'), join(root, 'store/node_modules/dep-a/node_modules/dep-b'),
        ].sort())
        writePackage(store, '@synthetic/tool', { missing: '1.0.0' })
        expect(() => guardInstalledDirectories(store, join(root, 'consumer'))).toThrow(`guard dependency missing is not installed above ${store}`)
    })

    it('keeps absolute search path directories inside the allowed roots under both spellings, and names the first relative entry', () => {
        const root = scratch()
        mkdirSync(join(root, 'real-bin'))
        symlinkSync(join(root, 'real-bin'), join(root, 'bin'))
        const searchPath = `/usr/bin:${root}/bin/:relative/bin::${root}/missing/bin:${root}-other/bin`
        expect(guardSearchDirectories(searchPath, [root])).toEqual([join(root, 'bin'), join(root, 'missing/bin'), join(root, 'real-bin')])
        expect(guardSearchPathRelativeEntry(searchPath)).toBe('relative/bin')
        expect(guardSearchPathRelativeEntry('/usr/bin::/bin')).toBe('')
        expect(guardSearchPathRelativeEntry('./node_modules/.bin:/usr/bin')).toBe('./node_modules/.bin')
        expect(guardSearchPathRelativeEntry('/usr/bin:/bin')).toBeNull()
    })

    it('finds every environment file and secrets directory a recursive search would reach, without following links, up to its bound', () => {
        const root = scratch()
        mkdirSync(join(root, 'tree/src'), { recursive: true })
        writeFileSync(join(root, 'tree/src/a.ts'), 'export {}\n')
        expect(guardSensitivePathsBelow(join(root, 'tree'))).toEqual([])
        mkdirSync(join(root, 'tree/pkg/.Secrets'), { recursive: true })
        writeFileSync(join(root, 'tree/src/.ENV.local'), 'SYNTHETIC=1\n')
        writeFileSync(join(root, 'tree/.envrc'), 'export SYNTHETIC=1\n')
        mkdirSync(join(root, 'outside'))
        writeFileSync(join(root, 'outside/.env'), 'SYNTHETIC=1\n')
        symlinkSync(join(root, 'outside'), join(root, 'tree/linked'))
        expect(guardSensitivePathsBelow(join(root, 'tree'))).toEqual([join(root, 'tree/.envrc'), join(root, 'tree/pkg/.Secrets'), join(root, 'tree/src/.ENV.local')])
        expect(guardSensitivePathsBelow(join(root, 'tree/src/.ENV.local'))).toEqual([join(root, 'tree/src/.ENV.local')])
        expect(guardSensitivePathsBelow(join(root, 'absent'))).toEqual([])
        expect(guardSensitivePathsBelow(join(root, 'tree'), 6)).toBeNull()
    })

    it('enumerates every secrets file identity under any folded spelling and reports a second hard link or an exceeded bound', () => {
        const root = scratch()
        mkdirSync(join(root, 'env/.secrets/project'), { recursive: true })
        writeFileSync(join(root, 'env/.secrets/token'), 'synthetic\n')
        writeFileSync(join(root, 'env/.secrets/project/key'), 'synthetic\n')
        writeFileSync(join(root, 'env/notes.txt'), 'not secret\n')
        expect(guardSecretFiles(root)).toEqual({ identities: expect.any(Array), linked: false })
        expect(guardSecretFiles(root).identities).toHaveLength(2)
        linkSync(join(root, 'env/.secrets/token'), join(root, 'alias'))
        expect(guardSecretFiles(root)).toMatchObject({ linked: true })
        for (let index = 0; index < GUARD_SECRET_FILE_LIMIT; index++) writeFileSync(join(root, `env/.secrets/project/file-${index}`), '')
        expect(guardSecretFiles(root)).toEqual({ identities: null, linked: true })
        expect(guardSecretFiles(join(root, 'absent'))).toEqual({ identities: [], linked: false })
    })
})
