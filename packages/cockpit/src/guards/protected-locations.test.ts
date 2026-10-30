import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GUARD_SECRET_FILE_LIMIT } from './evaluator.js'
import { guardInstalledDirectories, guardSearchDirectories, guardSecretFiles } from './protected-locations.js'

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

    it('keeps absolute search path directories inside the allowed roots under both spellings', () => {
        const root = scratch()
        mkdirSync(join(root, 'real-bin'))
        symlinkSync(join(root, 'real-bin'), join(root, 'bin'))
        expect(guardSearchDirectories(`/usr/bin:${root}/bin/:relative/bin::${root}/missing/bin:${root}-other/bin`, [root]))
            .toEqual([join(root, 'bin'), join(root, 'missing/bin'), join(root, 'real-bin')])
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
