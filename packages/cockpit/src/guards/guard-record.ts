// What sync records about the guard a hook runs, and where. Three reviews each found another writer
// that replaced the guard script during a session, so the hook stops relying on the evaluator having
// refused every one: it hashes the script and the machine-local identity that names the handler, and
// runs them only when the digest matches the one sync recorded below `~/.cockpit/guards`, a path the
// guard refuses to every agent write. The handler's installed modules are not covered: it imports many
// files, which no per-call hash of a small file reaches.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBoundedFile } from '../bounded-read.js'
import { GUARD_LOCAL_FORMAT, GUARD_LOCAL_PATHS } from './local-identity.js'

export const GUARD_SCRIPT_PATH = '.cockpit/guards/bash-guard.sh'
// A guard script and identity are a few kilobytes; one past this is not hashed.
const GUARD_RECORD_INPUT_BYTES = 1_048_576

// The check every hook runs in place of the guard script, kept beside the records so it is as unwritable
// to agents as they are. Its name and arguments (`<directory> --harness <target>`) never change: Codex
// trusts a hook by its exact command and runs without it until a person trusts a changed one, so each
// registered command is a fixed line that runs this script, and what changes between releases changes
// here, where sync rewrites it. Every cockpit on the machine runs the copy the latest sync wrote.
//
// Registrations are committed, so the script finds the cockpit from the directory the hook passes, the
// one the session started in. A session can start in a subdirectory of the cockpit, where the guard
// script would be one an agent may have written, so it takes the outermost directory at or above that
// one that holds the guard script: the directories above the cockpit lie outside every root, which
// agents do not write. Claude Code 2.1.323 sets CLAUDE_PROJECT_DIR to the directory a session started
// in, a subdirectory included (measured 2026-11-13). The walk stops at the nearest directory holding a
// `.git` entry, the top of the checkout the session is in: a linked worktree that Claude Code keeps
// below the main checkout holds its own committed guard, and the one above it belongs to another
// checkout. A second guard script within that bound is ambiguous, whoever wrote it, and none means no
// guard to run, so either blocks the call.
//
// It refuses a linked `.cockpit`, guard directory, local directory, script or identity, and either file
// when it is not a regular one (a FIFO identity would hold the read until the hook times out). It reads
// each file once, compares those bytes with the file's own recorded digest, so bytes moved from one to
// the other are a change, then runs the script text it hashed with the root it checked and the identity
// text it hashed: nothing is read again after the comparison. A missing identity is left to the recorded
// script, which refuses without it and names the fix. It is POSIX shell, which the hook runs with
// /bin/bash, naming every program by absolute path, since one found on the session's search path could
// be one an agent planted.
export const GUARD_CHECK_PATH = '.cockpit/guards/check.sh'
// One check serves every cockpit on the machine, written by whichever sync ran last, possibly another release's.
// The guard script refuses a check whose protocol is not the one it was written for; raise it when what the check
// hands the script changes.
export const GUARD_CHECK_PROTOCOL = '1'
// What the check hands instead when a linked worktree nobody has synced is judged by its main checkout, whose policy
// does not cover the worktree's own hook registrations, MCP wrappers, instances or secret paths; the guard then admits
// only `cd`, `pwd` and the sync that binds the worktree's own guard to its cockpit. A guard script from before this
// fallback refuses it as another release's, as it refused the call before.
export const GUARD_CHECK_UNSYNCED_PROTOCOL = '2'
export const GUARD_CHECK_SCRIPT = `# Written by cockpit sync: finds the cockpit at or above a session's directory and runs its guard script once it and the identity match the digests sync recorded.
refuse() {
    echo "cockpit guard: $1; a person reviews what changed it and runs cockpit sync in a terminal" >&2
    exit 2
}
start=$1
shift
# Sets r to the directory holding the guard script from $1 up to the nearest one with a .git entry, and g to that one.
find_guard() {
    d=$1
    r=
    g=
    n=0
    while [ -n "$d" ]; do
        [ -f "$d/${GUARD_SCRIPT_PATH}" ] && { r=$d; n=$((n+1)); }
        [ -e "$d/.git" ] && { g=$d; break; }
        d=\${d%/*}
    done
    if [ "$n" -gt 1 ]; then
        echo "cockpit guard: more than one ${GUARD_SCRIPT_PATH} at or above $start, so the guard to run is ambiguous; a person removes the one that is not the cockpit's" >&2
        exit 2
    fi
}
# Sets m to the main checkout of the linked worktree at $1, read from Git's own files without running Git: the
# .git file names the worktree's Git directory, whose commondir names the shared .git directory of the main
# checkout. That directory's gitdir must name the worktree back, so a .git file written by hand cannot borrow
# another checkout's worktree record. Anything else leaves m empty.
main_checkout() {
    m=
    l=
    { IFS= read -r l; } 2>/dev/null < "$1/.git"
    case $l in "gitdir: "?*) l=\${l#gitdir: } ;; *) return ;; esac
    case $l in /*) ;; *) l=$1/$l ;; esac
    l=$(cd "$l" 2>/dev/null && pwd -P) || return
    b=
    { IFS= read -r b; } 2>/dev/null < "$l/gitdir"
    case $b in */.git) b=\${b%/.git} ;; *) return ;; esac
    case $b in /*) ;; *) b=$l/$b ;; esac
    b=$(cd "$b" 2>/dev/null && pwd -P) || return
    [ "$b" = "$(cd "$1" 2>/dev/null && pwd -P)" ] || return
    s=
    { IFS= read -r s; } 2>/dev/null < "$l/commondir"
    [ -n "$s" ] || return
    case $s in /*) ;; *) s=$l/$s ;; esac
    s=$(cd "$s" 2>/dev/null && pwd -P) || return
    [ "\${l%/*}" = "$s/worktrees" ] || return
    case $s in */.git) m=\${s%/.git} ;; esac
}
find_guard "$start"
v=${GUARD_CHECK_PROTOCOL}
# A linked worktree nobody has installed and synced has no guard identity, so its own guard would refuse every
# call, a \`cd\` back out included, and Claude Code keeps judging later calls from it. Its main checkout judges it
# instead, admitting only what leaves the worktree or binds its own guard; that guard is recorded like any other.
# A worktree kept beside its main checkout has none above it, so the main checkout is the one Git's files name,
# and the checkout the worktree sits in only where they name none that has synced.
i=$r/${GUARD_LOCAL_PATHS.identity}
if [ -n "$g" ] && [ -f "$g/.git" ] && { [ -z "$r" ] || { [ ! -e "$i" ] && [ ! -L "$i" ]; }; }; then
    main_checkout "$g"
    if [ -n "$m" ] && [ -f "$m/${GUARD_SCRIPT_PATH}" ] && [ -f "$m/${GUARD_LOCAL_PATHS.identity}" ]; then
        r=$m
        v=${GUARD_CHECK_UNSYNCED_PROTOCOL}
    else
        w=$r
        find_guard "\${g%/*}"
        if [ -n "$r" ]; then v=${GUARD_CHECK_UNSYNCED_PROTOCOL}; else r=$w; fi
    fi
fi
if [ -z "$r" ]; then
    echo "cockpit guard: no ${GUARD_SCRIPT_PATH} at or above $start; a person starts the agent in a cockpit, or runs cockpit sync there in a terminal" >&2
    exit 2
fi
t=
for candidate in /usr/bin/sha256sum /sbin/sha256sum /bin/sha256sum; do [ -x "$candidate" ] && { t=$candidate; break; }; done
digest() { if [ -n "$t" ]; then printf '%s' "$1" | "$t"; else printf '%s' "$1" | /usr/bin/shasum -a 256; fi; }
# Sets c, s, script and identity from the cockpit at $r once its guard script and identity match what sync recorded.
load() {
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
}
load
# A synced linked worktree whose identity, recorded and unchanged, names a Node or handler that is gone, as after a
# package manager pruned the version it bound or Node moved, would refuse every call before any handler ran, the bind
# that repairs it included. Its main checkout judges it instead, as for a worktree nobody has synced. A malformed
# identity is left to the worktree's own guard script, which refuses it.
if [ "$v" = ${GUARD_CHECK_PROTOCOL} ] && [ -n "$identity" ] && [ -n "$g" ] && [ -f "$g/.git" ] && [ "$c" = "$(cd "$g" 2>/dev/null && pwd -P)" ]; then
    f=
    n=
    h=
    { IFS= read -r f; IFS= read -r n; IFS= read -r h; } <<EOF
$identity
EOF
    if [ "$f" = '${GUARD_LOCAL_FORMAT}' ] && [ -n "$n" ] && [ -n "$h" ] && { [ ! -x "$n" ] || [ ! -r "$h" ]; }; then
        main_checkout "$g"
        if [ -n "$m" ] && [ "$m" != "$c" ] && [ -f "$m/${GUARD_SCRIPT_PATH}" ] && [ -f "$m/${GUARD_LOCAL_PATHS.identity}" ]; then
            r=$m
            v=${GUARD_CHECK_UNSYNCED_PROTOCOL}
            load
        fi
    fi
fi
COCKPIT_GUARD_CHECK_PROTOCOL=$v COCKPIT_GUARD_CHECKED_ROOT=$c COCKPIT_GUARD_CHECKED_IDENTITY=$identity exec /bin/bash -c "$script" "$s" "$@"
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

/**
 * Records the guard at `root`. With `scriptSha256`, the digest of the guard script sync rendered or verified, a script
 * on disk with other bytes is refused rather than recorded: one written after the check would be blessed unseen.
 */
export async function writeGuardRecord(root: string, home = homedir(), scriptSha256?: string): Promise<Readonly<{ kind: 'complete' }> | Readonly<{ kind: 'refusal'; message: string }>> {
    const digest = guardRecordDigest(root)
    if (digest === undefined) return { kind: 'refusal', message: `${GUARD_SCRIPT_PATH} or ${GUARD_LOCAL_PATHS.identity} is missing or too large to record` }
    if (scriptSha256 !== undefined && digest.split('\n')[0] !== scriptSha256) return { kind: 'refusal', message: `${GUARD_SCRIPT_PATH} changed after sync checked it` }
    const path = guardRecordPath(root, home)
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    await replaceFile(path, `${digest}\n`)
    await replaceFile(join(home, GUARD_CHECK_PATH), GUARD_CHECK_SCRIPT)
    return { kind: 'complete' }
}

// A hook starting while sync writes would read a cut-off file, and a check cut off after a line falls off its end
// with exit 0, so each file is written beside its place and renamed over it.
async function replaceFile(path: string, text: string): Promise<void> {
    // A name no other writer can predict, so none can plant a file there first or collide with it.
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
    try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
    } finally {
        await rm(temporary, { force: true })
    }
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
