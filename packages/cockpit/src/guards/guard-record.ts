// What sync records about the guard a hook runs, and where. Three reviews each found another writer
// that replaced the guard script during a session, so the hook stops relying on the evaluator having
// refused every one: it hashes the script and the machine-local identity that names the handler, and
// runs them only when the digest matches the one sync recorded below `~/.cockpit/guards`, a path the
// guard refuses to every agent write. The handler's installed modules are not covered: it imports many
// files, which no per-call hash of a small file reaches.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBoundedFile } from '../bounded-read.js'
import { GUARD_LOCAL_PATHS } from './local-identity.js'

export const GUARD_SCRIPT_PATH = '.cockpit/guards/bash-guard.sh'
// A guard script and identity are a few kilobytes; one past this is not hashed.
const GUARD_RECORD_INPUT_BYTES = 1_048_576

// The check every hook runs before the guard script, kept beside the records so it is as unwritable to
// agents as they are, and so the hook command, which Claude Code prints beside every refusal, stays short.
// It is plain shell naming every program by absolute path, since one found on the session's search path
// could be one an agent planted. The version in its name changes when what it checks does.
export const GUARD_CHECK_PATH = '.cockpit/guards/check-v1.sh'
export const GUARD_CHECK_SCRIPT = `# Written by cockpit sync: checks a cockpit's guard script and identity against the digest sync recorded.
r=$1
c=$(cd "$r" 2>/dev/null && pwd -P) || c=$r
k=
read -r k 2>/dev/null < "$HOME/.cockpit/guards/roots$c/bash-guard.sha256"
t=
for candidate in /usr/bin/sha256sum /sbin/sha256sum /bin/sha256sum; do [ -x "$candidate" ] && { t=$candidate; break; }; done
if [ -n "$t" ]; then h=$(/bin/cat "$r/${GUARD_SCRIPT_PATH}" "$r/.cockpit/local/guard-identity" 2>/dev/null | "$t")
else h=$(/bin/cat "$r/${GUARD_SCRIPT_PATH}" "$r/.cockpit/local/guard-identity" 2>/dev/null | /usr/bin/shasum -a 256); fi
[ -n "$k" ] && [ "\${h%% *}" = "$k" ] && exit 0
echo "cockpit guard: guard script changed or unrecorded in $r; a person reviews what changed it and runs cockpit sync in a terminal" >&2
exit 2
`

/** Where sync records the digest for the cockpit at canonical `root`: the root's own path below the record directory. */
export function guardRecordPath(root: string, home = homedir()): string {
    return join(home, '.cockpit/guards/roots', root, 'bash-guard.sha256')
}

/** The sha256 of the guard script followed by the identity file, as `cat script identity | sha256sum` prints it, or undefined when either is unreadable. */
export function guardRecordDigest(root: string): string | undefined {
    const hash = createHash('sha256')
    for (const path of [GUARD_SCRIPT_PATH, GUARD_LOCAL_PATHS.identity]) {
        let read
        try { read = readBoundedFile(join(root, path), GUARD_RECORD_INPUT_BYTES) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
        }
        if (read.kind !== 'complete') return undefined
        hash.update(read.bytes)
    }
    return hash.digest('hex')
}

export async function writeGuardRecord(root: string, home = homedir()): Promise<Readonly<{ kind: 'complete' }> | Readonly<{ kind: 'refusal'; message: string }>> {
    const digest = guardRecordDigest(root)
    if (digest === undefined) return { kind: 'refusal', message: `${GUARD_SCRIPT_PATH} or ${GUARD_LOCAL_PATHS.identity} is missing or too large to record` }
    const path = guardRecordPath(root, home)
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    await writeFile(path, `${digest}\n`, { mode: 0o600 })
    await writeFile(join(home, GUARD_CHECK_PATH), GUARD_CHECK_SCRIPT, { mode: 0o600 })
    return { kind: 'complete' }
}

/** Whether the recorded digest matches the guard the cockpit at `root` holds now. */
export function inspectGuardRecord(root: string, home = homedir()): 'match' | 'missing' | 'mismatch' {
    let recorded
    try { recorded = readBoundedFile(guardRecordPath(root, home), 4096) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
        throw error
    }
    return recorded.kind === 'complete' && recorded.bytes.toString('utf8').trim() === guardRecordDigest(root) ? 'match' : 'mismatch'
}
