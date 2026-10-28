import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { synchronizeInstructionPointer } from './instruction-pointer.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('sibling instruction pointer', () => {
    it('offers an explicit pointer, preserves team instructions, and refuses an edited owned block', async () => {
        const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-instruction-pointer-')))
        roots.push(estate)
        const cockpitRoot = join(estate, 'cockpit')
        const siblingRoot = join(estate, 'product')
        await Promise.all([mkdir(cockpitRoot), mkdir(siblingRoot)])
        const path = join(siblingRoot, 'AGENTS.md')
        const original = '# Team guide\n\nKeep this text.\n'
        await writeFile(path, original)

        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot, write: false })).toMatchObject({
            kind: 'offered', path, target: '../cockpit/AGENTS.md',
        })
        expect(await readFile(path, 'utf8')).toBe(original)

        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot, write: true })).toMatchObject({ kind: 'written' })
        const written = await readFile(path, 'utf8')
        expect(written).toBe(`${original}<!-- cockpit:instruction-pointer:start -->\nRead [the cockpit instructions](<../cockpit/AGENTS.md>) before editing this repository.\n<!-- cockpit:instruction-pointer:end -->\n`)
        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot, write: true })).toMatchObject({ kind: 'unchanged' })
        expect(await readFile(path, 'utf8')).toBe(written)

        const edited = written.replace('before editing', 'before changing')
        await writeFile(path, edited)
        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot, write: true })).toMatchObject({
            kind: 'refusal', reason: 'the existing instruction pointer was edited',
        })
        expect(await readFile(path, 'utf8')).toBe(edited)

        const missingSibling = join(estate, 'empty-product')
        await mkdir(missingSibling)
        const missingPath = join(missingSibling, 'AGENTS.md')
        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot: missingSibling, write: false })).toMatchObject({
            kind: 'offered', path: missingPath, target: '../cockpit/AGENTS.md',
        })
        await expect(readFile(missingPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('refuses a sibling root replaced by a symlink without changing the destination guide', async () => {
        const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-pointer-redirect-')))
        roots.push(estate)
        const cockpitRoot = join(estate, 'cockpit')
        const siblingRoot = join(estate, 'product')
        const outside = join(estate, 'unrelated')
        await Promise.all([mkdir(cockpitRoot), mkdir(outside)])
        await symlink(outside, siblingRoot, 'dir')
        const original = '# Unrelated instructions\n'
        await writeFile(join(outside, 'AGENTS.md'), original)
        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot, write: true })).toMatchObject({ kind: 'refusal' })
        expect(await readFile(join(outside, 'AGENTS.md'), 'utf8')).toBe(original)
    })

    it('refuses invalid UTF-8 without replacing any product bytes', async () => {
        const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-pointer-encoding-')))
        roots.push(estate)
        const cockpitRoot = join(estate, 'cockpit')
        const siblingRoot = join(estate, 'product')
        await Promise.all([mkdir(cockpitRoot), mkdir(siblingRoot)])
        const path = join(siblingRoot, 'AGENTS.md')
        const original = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a])
        await writeFile(path, original)
        expect(await synchronizeInstructionPointer({ cockpitRoot, siblingRoot, write: true })).toMatchObject({ kind: 'refusal' })
        expect(await readFile(path)).toEqual(original)
    })

})
