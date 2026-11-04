import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkStore } from './store.js'

// The filesystem is the boundary: a rename is held open so a second recovery runs inside the first one's takeover.
const hook = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((to: string) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
    const real = await importOriginal<typeof import('node:fs/promises')>()
    return { ...real, rename: async (from: string, to: string) => { await hook.beforeRename?.(to); return real.rename(from, to) } }
})

const roots: string[] = []
afterEach(() => { hook.beforeRename = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('work store', () => {
    it('lets only one of two concurrent recoveries take over a dead lock', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-work-store-'))
        roots.push(root)
        const directory = join(root, '.cockpit/work-orders')
        mkdirSync(directory, { recursive: true })
        const exited = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString())
        writeFileSync(join(directory, 'WO-1.lock'), JSON.stringify({ pid: exited, host: hostname(), container: false }))
        const store = createWorkStore(root)
        const containers = async () => ({ state: 'no-docker' as const, reason: 'no Docker client on PATH' })

        let reached!: () => void
        let release!: () => void
        const atTakeover = new Promise<void>(resolve => { reached = resolve })
        const released = new Promise<void>(resolve => { release = resolve })
        hook.beforeRename = async to => {
            if (!to.endsWith('WO-1.lock')) return
            hook.beforeRename = undefined
            reached()
            await released
        }
        const first = store.recover('WO-1', true, containers)
        await atTakeover
        const second = await store.recover('WO-1', true, containers).catch((error: unknown) => error)
        release()
        expect(await first).toMatchObject({ lock: 'removed' })
        expect(second).toMatchObject({ message: expect.stringContaining('another work recover is taking over the lock on WO-1') })
        expect(readdirSync(directory)).toEqual([])
    })
})
