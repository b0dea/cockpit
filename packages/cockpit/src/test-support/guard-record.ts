import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { GUARD_CHECK_PATH, GUARD_CHECK_SCRIPT, GUARD_SCRIPT_PATH, guardRecordPath } from '../guards/guard-record.js'
import { GUARD_LOCAL_PATHS } from '../guards/local-identity.js'

/**
 * Records a synthetic cockpit's guard as sync would, for a test that runs a generated hook against
 * files it wrote itself, in the test's own home. The digest covers the files
 * present, as the hook's `cat` does, so a fixture without an identity file still reaches the guard
 * script's own diagnosis of it.
 */
export function recordTestGuard(root: string, home = homedir()): void {
    const canonical = realpathSync(root)
    const hash = createHash('sha256')
    for (const path of [GUARD_SCRIPT_PATH, GUARD_LOCAL_PATHS.identity]) {
        try { hash.update(readFileSync(join(canonical, path))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const record = guardRecordPath(canonical, home)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, `${hash.digest('hex')}\n`)
    writeFileSync(join(home, GUARD_CHECK_PATH), GUARD_CHECK_SCRIPT)
}
