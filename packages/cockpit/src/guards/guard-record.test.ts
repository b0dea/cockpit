import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUARD_CHECK_PATH, writeGuardRecord } from './guard-record.js'

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
        write(root, 'printf "ran %s %s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*"\n', 'identity\n')
        expect(await writeGuardRecord(root, home)).toEqual({ kind: 'complete' })
        const check = (from = root) => spawnSync('/bin/sh', [join(home, GUARD_CHECK_PATH), from, '--harness', 'codexcli'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } })
        expect(check()).toMatchObject({ status: 0, stdout: `ran ${root} --harness codexcli` })
        // Bytes moved from one file to the other leave their concatenation as it was, and are still a change.
        write(root, 'printf "ran %s %s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*"\nid', 'entity\n')
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('guard script changed') })
        // An identity naming another handler is a change on its own.
        write(root, 'printf "ran %s %s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*"\n', 'planted\n')
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('guard script changed') })
        write(root, 'printf "ran %s %s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*"\n', 'identity\n')
        // A linked guard directory could lead the script to another identity than the one checked.
        const elsewhere = join(base, 'elsewhere')
        write(elsewhere, 'printf "ran %s %s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*"\n', 'identity\n')
        rmSync(join(root, '.cockpit/guards'), { recursive: true })
        symlinkSync(join(elsewhere, '.cockpit/guards'), join(root, '.cockpit/guards'))
        expect(check()).toMatchObject({ status: 2, stderr: expect.stringContaining('link') })
        // Without an identity the recorded script runs, and refuses for want of one.
        rmSync(join(root, '.cockpit/guards'))
        write(root, 'printf "ran %s %s" "$COCKPIT_GUARD_CHECKED_ROOT" "$*"\n', 'identity\n')
        rmSync(join(root, '.cockpit/local/guard-identity'))
        expect(check()).toMatchObject({ status: 0, stdout: `ran ${root} --harness codexcli` })
    })
})
