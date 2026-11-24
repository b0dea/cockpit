import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUARD_CHECK_PATH, GUARD_CHECK_PROTOCOL, writeGuardRecord } from './guard-record.js'
import { GUARD_CHECK_UNSYNCED_PROTOCOL } from './guard-record.js'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('guard record', () => {
    it('runs the guard script with the checked root only while it and the identity match what sync recorded, and never through a link', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-record-')))
        scratch.push(base)
        const home = join(base, 'home')
        const root = join(base, 'cockpit')
        const write = (checkout: string, script: string, identity: string) => {
            mkdirSync(join(checkout, '.cockpit/guards'), { recursive: true })
            mkdirSync(join(checkout, '.cockpit/local'), { recursive: true })
            writeFileSync(join(checkout, '.cockpit/guards/bash-guard.sh'), script)
            writeFileSync(join(checkout, '.cockpit/local/guard-identity'), identity)
        }
        write(root, 'printf "ran %s %s|%s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*" "${COCKPIT_GUARD_CHECKED_IDENTITY-}"\n', 'identity\n')
        expect(await writeGuardRecord(root, home)).toEqual({ kind: 'complete' })
        // The OpenCode plugin runs the check with /bin/sh, which is dash on Linux: both answer alike.
        const check = (from = root) => {
            const [sh, dash] = ['/bin/sh', '/bin/dash'].map(shell => spawnSync(shell, [join(home, GUARD_CHECK_PATH), from, '--harness', 'codexcli'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 10_000 }))
            expect({ status: dash!.status, stdout: dash!.stdout, stderr: dash!.stderr }).toEqual({ status: sh!.status, stdout: sh!.stdout, stderr: sh!.stderr })
            return sh!
        }
        // The script runs from the bytes the check hashed, and is handed the identity it hashed rather than reading it again.
        expect(check()).toMatchObject({ status: 0, stdout: `ran ${root} --harness codexcli|identity\n` })
        // Bytes moved from one file to the other leave their concatenation as it was, and are still a change.
        write(root, 'printf "ran %s %s|%s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*" "${COCKPIT_GUARD_CHECKED_IDENTITY-}"\nid', 'entity\n')
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('guard script changed') })
        // An identity naming another handler is a change on its own.
        write(root, 'printf "ran %s %s|%s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*" "${COCKPIT_GUARD_CHECKED_IDENTITY-}"\n', 'planted\n')
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('guard script changed') })
        write(root, 'printf "ran %s %s|%s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*" "${COCKPIT_GUARD_CHECKED_IDENTITY-}"\n', 'identity\n')
        // A linked guard directory could lead the script to another identity than the one checked.
        const elsewhere = join(base, 'elsewhere')
        write(elsewhere, 'printf "ran %s %s|%s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*" "${COCKPIT_GUARD_CHECKED_IDENTITY-}"\n', 'identity\n')
        rmSync(join(root, '.cockpit/guards'), { recursive: true })
        symlinkSync(join(elsewhere, '.cockpit/guards'), join(root, '.cockpit/guards'))
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('link') })
        // Without an identity the recorded script runs, and refuses for want of one.
        rmSync(join(root, '.cockpit/guards'))
        write(root, 'printf "ran %s %s|%s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*" "${COCKPIT_GUARD_CHECKED_IDENTITY-}"\n', 'identity\n')
        rmSync(join(root, '.cockpit/local/guard-identity'))
        expect(check()).toMatchObject({ status: 0, stdout: `ran ${root} --harness codexcli|` })
        // An identity that is no regular file, such as a FIFO a read would wait on until the hook times out, is refused unread.
        execFileSync('mkfifo', [join(root, '.cockpit/local/guard-identity')])
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('not a regular file') })
    })

    it('replaces the check in one rename, so a hook starting during sync runs a whole file', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-record-')))
        scratch.push(base)
        const home = join(base, 'home')
        const root = join(base, 'cockpit')
        mkdirSync(join(root, '.cockpit/guards'), { recursive: true })
        mkdirSync(join(root, '.cockpit/local'), { recursive: true })
        writeFileSync(join(root, '.cockpit/guards/bash-guard.sh'), 'printf "%s" "$COCKPIT_GUARD_CHECK_PROTOCOL"\n')
        writeFileSync(join(root, '.cockpit/local/guard-identity'), 'identity\n')
        expect(await writeGuardRecord(root, home)).toEqual({ kind: 'complete' })
        expect(spawnSync('/bin/sh', [join(home, GUARD_CHECK_PATH), root], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } }).stdout).toBe(GUARD_CHECK_PROTOCOL)
        // A second name for the old file keeps its bytes: the new check is a new file, never the old one rewritten in place.
        writeFileSync(join(home, GUARD_CHECK_PATH), 'previous check\n')
        linkSync(join(home, GUARD_CHECK_PATH), join(base, 'previous'))
        expect(await writeGuardRecord(root, home)).toEqual({ kind: 'complete' })
        expect(readFileSync(join(base, 'previous'), 'utf8')).toBe('previous check\n')
        expect(readFileSync(join(home, GUARD_CHECK_PATH), 'utf8')).toContain('cockpit sync')
    })

    it('records a guard script only with the bytes the caller checked', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-record-')))
        scratch.push(base)
        const root = join(base, 'cockpit')
        mkdirSync(join(root, '.cockpit/guards'), { recursive: true })
        mkdirSync(join(root, '.cockpit/local'), { recursive: true })
        writeFileSync(join(root, '.cockpit/guards/bash-guard.sh'), 'printf checked\n')
        writeFileSync(join(root, '.cockpit/local/guard-identity'), 'identity\n')
        const checked = createHash('sha256').update('printf checked\n').digest('hex')
        writeFileSync(join(root, '.cockpit/guards/bash-guard.sh'), 'printf swapped\n')
        expect(await writeGuardRecord(root, join(base, 'home'), checked)).toMatchObject({ kind: 'refusal', message: expect.stringContaining('changed after sync checked it') })
        writeFileSync(join(root, '.cockpit/guards/bash-guard.sh'), 'printf checked\n')
        expect(await writeGuardRecord(root, join(base, 'home'), checked)).toEqual({ kind: 'complete' })
    })

    it('judges a synced linked worktree whose recorded Node or handler is gone by its main checkout, and nothing else', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-record-')))
        scratch.push(base)
        const home = join(base, 'home')
        const root = join(base, 'app')
        const worktree = join(base, 'app-feature')
        for (const [checkout, script] of [[root, 'printf "%s %s" "$COCKPIT_GUARD_CHECK_PROTOCOL" "$COCKPIT_GUARD_CHECKED_ROOT"\n'], [worktree, 'printf "own %s" "$COCKPIT_GUARD_CHECK_PROTOCOL"\n']]) {
            mkdirSync(join(checkout, '.cockpit/guards'), { recursive: true })
            mkdirSync(join(checkout, '.cockpit/local'), { recursive: true })
            writeFileSync(join(checkout, '.cockpit/guards/bash-guard.sh'), script)
        }
        writeFileSync(join(root, '.cockpit/local/guard-identity'), 'identity\n')
        mkdirSync(join(root, '.git/worktrees/feature'), { recursive: true })
        writeFileSync(join(root, '.git/worktrees/feature/commondir'), '../..\n')
        writeFileSync(join(root, '.git/worktrees/feature/gitdir'), `${join(worktree, '.git')}\n`)
        writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, '.git/worktrees/feature')}\n`)
        expect(await writeGuardRecord(root, home)).toEqual({ kind: 'complete' })
        const check = () => {
            const [sh, dash] = ['/bin/sh', '/bin/dash'].map(shell => spawnSync(shell, [join(home, GUARD_CHECK_PATH), worktree], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 10_000 }))
            expect({ status: dash!.status, stdout: dash!.stdout, stderr: dash!.stderr }).toEqual({ status: sh!.status, stdout: sh!.stdout, stderr: sh!.stderr })
            return sh!
        }
        const bound = async (node: string, handler: string, format = 'cockpit-guard-local/v1') => {
            writeFileSync(join(worktree, '.cockpit/local/guard-identity'), `${format}\n${node}\n${handler}\n{}\n`)
            expect(await writeGuardRecord(worktree, home)).toEqual({ kind: 'complete' })
        }
        // A runtime that is still there runs the worktree's own guard.
        await bound('/bin/sh', join(root, '.cockpit/local/guard-identity'))
        expect(check()).toMatchObject({ status: 0, stdout: `own ${GUARD_CHECK_PROTOCOL}` })
        for (const [node, handler] of [[join(base, 'gone/node'), join(root, '.cockpit/local/guard-identity')], ['/bin/sh', join(base, 'gone/cli.js')]]) {
            await bound(node, handler)
            expect(check(), `${node} ${handler}`).toMatchObject({ status: 0, stdout: `${GUARD_CHECK_UNSYNCED_PROTOCOL} ${root}` })
        }
        // A malformed identity is the worktree guard's own to refuse, and one changed since sync recorded it refuses here.
        await bound(join(base, 'gone/node'), join(base, 'gone/cli.js'), 'another-format')
        expect(check()).toMatchObject({ status: 0, stdout: `own ${GUARD_CHECK_PROTOCOL}` })
        await bound(join(base, 'gone/node'), join(base, 'gone/cli.js'))
        writeFileSync(join(worktree, '.cockpit/local/guard-identity'), `cockpit-guard-local/v1\n${join(base, 'gone/node')}\n${join(base, 'other/cli.js')}\n{}\n`)
        expect(check()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('unrecorded') })
    })

    it('judges a linked worktree beside its main checkout, synced nowhere, by the main checkout its Git files name', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-record-')))
        scratch.push(base)
        const home = join(base, 'home')
        const root = join(base, 'app')
        mkdirSync(join(root, '.cockpit/guards'), { recursive: true })
        mkdirSync(join(root, '.cockpit/local'), { recursive: true })
        mkdirSync(join(root, '.git/worktrees/feature'), { recursive: true })
        writeFileSync(join(root, '.cockpit/guards/bash-guard.sh'), 'printf "%s %s" "$COCKPIT_GUARD_CHECK_PROTOCOL" "$COCKPIT_GUARD_CHECKED_ROOT"\n')
        writeFileSync(join(root, '.cockpit/local/guard-identity'), 'identity\n')
        writeFileSync(join(root, '.git/worktrees/feature/commondir'), '../..\n')
        expect(await writeGuardRecord(root, home)).toEqual({ kind: 'complete' })
        // The worktree carries the committed guard script but no identity, as a new one does.
        const worktree = join(base, 'app-feature')
        writeFileSync(join(root, '.git/worktrees/feature/gitdir'), `${join(worktree, '.git')}\n`)
        mkdirSync(join(worktree, '.cockpit/guards'), { recursive: true })
        writeFileSync(join(worktree, '.cockpit/guards/bash-guard.sh'), 'printf worktree-guard\n')
        const check = () => {
            const [sh, dash] = ['/bin/sh', '/bin/dash'].map(shell => spawnSync(shell, [join(home, GUARD_CHECK_PATH), worktree], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 10_000 }))
            expect({ status: dash!.status, stdout: dash!.stdout, stderr: dash!.stderr }).toEqual({ status: sh!.status, stdout: sh!.stdout, stderr: sh!.stderr })
            return sh!
        }
        // Git writes the pointer absolute, or relative to the worktree with worktree.useRelativePaths.
        for (const pointer of [join(root, '.git/worktrees/feature'), '../app/.git/worktrees/feature']) {
            writeFileSync(join(worktree, '.git'), `gitdir: ${pointer}\n`)
            expect(check(), pointer).toMatchObject({ status: 0, stdout: `${GUARD_CHECK_UNSYNCED_PROTOCOL} ${root}` })
        }
        // A pointer Git did not write, or one borrowing a record that names another worktree, finds nothing to judge by,
        // as does a main checkout without a synced guard.
        const planted = join(base, 'planted')
        mkdirSync(join(planted, '.cockpit/guards'), { recursive: true })
        writeFileSync(join(planted, '.cockpit/guards/bash-guard.sh'), 'printf planted-guard\n')
        writeFileSync(join(planted, '.git'), `gitdir: ${join(root, '.git/worktrees/feature')}\n`)
        expect(spawnSync('/bin/sh', [join(home, GUARD_CHECK_PATH), planted], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } }))
            .toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('unrecorded') })
        for (const pointer of ['planted', `gitdir: ${join(base, 'missing')}`]) {
            writeFileSync(join(worktree, '.git'), `${pointer}\n`)
            expect(check(), pointer).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('unrecorded') })
        }
        writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, '.git/worktrees/feature')}\n`)
        rmSync(join(root, '.cockpit/local/guard-identity'))
        expect(check()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('unrecorded') })
    })
})
