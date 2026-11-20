// How the guard reads `[guards] related_checkouts`, shared by the policy it builds and sync's widening check, so
// the two never disagree about which entries name another checkout.
import { join, resolve } from 'node:path'

/** An entry as the guard resolves it: `~/` from the home directory, anything else from the cockpit root. */
export function relatedCheckoutPath(spelled: string, root: string, home: string): string {
    return spelled.startsWith('~/') ? join(home, spelled.slice(2)) : resolve(root, spelled)
}

/**
 * Whether a resolved entry is, or holds, one of the allowed roots. One cockpit.toml serves every checkout of a
 * product, so such an entry is the cockpit itself where the guard runs, and names no other checkout.
 */
export function relatedCheckoutHoldsRoot(path: string, allowedRoots: Iterable<string>): boolean {
    return [...allowedRoots].some(root => root === path || root.startsWith(path === '/' ? '/' : `${path}/`))
}
