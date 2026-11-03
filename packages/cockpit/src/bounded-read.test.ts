import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBoundedFile } from './bounded-read.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-bounded-read-'))
    roots.push(path)
    return path
}

describe('bounded file read', () => {
    it('reads a regular file up to its bound and reports one past it as too large', () => {
        const path = join(root(), 'input.toml')
        writeFileSync(path, 'name = "x"\n')
        expect(readBoundedFile(path, 11)).toEqual({ kind: 'complete', bytes: Buffer.from('name = "x"\n') })
        expect(readBoundedFile(path, 10)).toEqual({ kind: 'too-large' })
    })

    it('refuses a symbolic link and a FIFO without following or blocking on them', () => {
        const directory = root()
        writeFileSync(join(directory, 'target'), 'secret\n')
        symlinkSync(join(directory, 'target'), join(directory, 'link'))
        expect(() => readBoundedFile(join(directory, 'link'), 64)).toThrow(expect.objectContaining({ code: 'ELOOP' }))
        execFileSync('mkfifo', [join(directory, 'pipe')])
        expect(() => readBoundedFile(join(directory, 'pipe'), 64)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    })
})
