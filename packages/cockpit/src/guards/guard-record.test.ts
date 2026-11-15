import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUARD_CHECK_PATH, GUARD_CHECK_PROTOCOL, writeGuardRecord } from './guard-record.js'

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
})
