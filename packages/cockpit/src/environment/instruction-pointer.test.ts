import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { synchronizeInstructionPointer } from './instruction-pointer.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('sibling instruction pointer', () => {
    it('offers an explicit pointer, preserves team instructions, and refuses an edited owned block', async () => {
        const estate = await mkdtemp(join(tmpdir(), 'cockpit-instruction-pointer-'))
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
})
