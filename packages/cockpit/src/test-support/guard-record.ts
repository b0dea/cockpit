import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { GUARD_CHECK_PATH, GUARD_CHECK_SCRIPT, GUARD_SCRIPT_PATH, guardRecordPath } from '../guards/guard-record.js'
import { GUARD_LOCAL_PATHS } from '../guards/local-identity.js'

/**
 * Records a synthetic cockpit's guard as sync would, for a test that runs a generated hook against
 * files it wrote itself, in the test's own home. A fixture without an identity file records none, and
 * the check leaves its absence to the guard script's own diagnosis.
 */
export function recordTestGuard(root: string, home = homedir()): void {
    const canonical = realpathSync(root)
    const digests = [GUARD_SCRIPT_PATH, GUARD_LOCAL_PATHS.identity].map(path => {
        try { return createHash('sha256').update(readFileSync(join(canonical, path))).digest('hex') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return '' }
    })
    const record = guardRecordPath(canonical, home)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, `${digests.join('\n')}\n`)
    writeFileSync(join(home, GUARD_CHECK_PATH), GUARD_CHECK_SCRIPT)
}
