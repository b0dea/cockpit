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

// The check every hook runs in place of the guard script, kept beside the records so it is as unwritable
// to agents as they are, and so the hook command, which Claude Code prints beside every refusal, stays
// short. It refuses a linked `.cockpit`, guard directory, local directory, script or identity, and either
// file when it is not a regular one (a FIFO identity would hold the read until the hook times out). It
// reads each file once, compares those bytes with the file's own recorded digest, so bytes moved from one
// to the other are a change, then runs the script text it hashed with the root it checked and the
// identity text it hashed: nothing is read again after the comparison. A missing identity is left to the
// recorded script, which refuses without it and names the fix. It is POSIX shell, run by dash on Linux,
// naming every program by absolute path, since one found on the session's search path could be one an
// agent planted. The version in its name changes when what it checks does.
export const GUARD_CHECK_PATH = '.cockpit/guards/check-v3.sh'
export const GUARD_CHECK_SCRIPT = `# Written by cockpit sync: runs a cockpit's guard script once it and the identity match the digests sync recorded.
refuse() {
    echo "cockpit guard: $1; a person reviews what changed it and runs cockpit sync in a terminal" >&2
    exit 2
}
r=$1
shift
c=$(cd "$r" 2>/dev/null && pwd -P) || c=$r
s="$c/${GUARD_SCRIPT_PATH}"
i="$c/${GUARD_LOCAL_PATHS.identity}"
for p in "$c/.cockpit" "$c/.cockpit/guards" "$c/.cockpit/local" "$s" "$i"; do
    [ -L "$p" ] && refuse "$p is a link, so the guard it leads to is not the one sync recorded"
done
[ -f "$s" ] || refuse "$s is not a regular file"
if [ -e "$i" ] && [ ! -f "$i" ]; then refuse "$i is not a regular file"; fi
k1=
k2=
{ read -r k1; read -r k2; } 2>/dev/null < "$HOME/.cockpit/guards/roots$c/bash-guard.sha256"
t=
for candidate in /usr/bin/sha256sum /sbin/sha256sum /bin/sha256sum; do [ -x "$candidate" ] && { t=$candidate; break; }; done
digest() { if [ -n "$t" ]; then printf '%s' "$1" | "$t"; else printf '%s' "$1" | /usr/bin/shasum -a 256; fi; }
# Command substitution drops trailing newlines, so each read ends with a marker that is then removed.
script=$(/bin/cat "$s" && printf x) || refuse "$s could not be read"
script=\${script%x}
identity=
if [ -f "$i" ]; then
    identity=$(/bin/cat "$i" && printf x) || refuse "$i could not be read"
    identity=\${identity%x}
    h2=$(digest "$identity")
    [ "\${h2%% *}" = "$k2" ] || refuse "guard script changed or unrecorded in $c"
fi
h1=$(digest "$script")
{ [ -n "$k1" ] && [ "\${h1%% *}" = "$k1" ]; } || refuse "guard script changed or unrecorded in $c"
COCKPIT_GUARD_CHECKED_ROOT=$c COCKPIT_GUARD_CHECKED_IDENTITY=$identity exec /bin/bash -c "$script" "$s" "$@"
`

/** Where sync records the digest for the cockpit at canonical `root`: the root's own path below the record directory. */
export function guardRecordPath(root: string, home = homedir()): string {
    return join(home, '.cockpit/guards/roots', root, 'bash-guard.sha256')
}

/** The sha256 of the guard script and of the identity file, one per line, or undefined when either is unreadable. */
export function guardRecordDigest(root: string): string | undefined {
    const digests: string[] = []
    for (const path of [GUARD_SCRIPT_PATH, GUARD_LOCAL_PATHS.identity]) {
        let read
        try { read = readBoundedFile(join(root, path), GUARD_RECORD_INPUT_BYTES) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
        }
        if (read.kind !== 'complete') return undefined
        digests.push(createHash('sha256').update(read.bytes).digest('hex'))
    }
    return digests.join('\n')
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
