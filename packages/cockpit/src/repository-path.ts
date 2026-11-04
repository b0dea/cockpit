// A path in one of a cockpit's repositories: `path` in the cockpit's own, or `<sibling slug>:path` in a
// sibling. Work-order scopes and sources, the [docs] declarations and every reader of them spell and
// split it here, so a reference one admits is the reference the other resolves.
const SLUG = '[a-z0-9][a-z0-9-]{0,63}'

// Never absolute or climbing. The climbing check looks past the sibling prefix, which would otherwise
// consume the `:` before `..`.
/** A path or glob (`*`, `?`, `**`), optionally `<slug>:`-prefixed, without `..` segments or a leading `/`. */
export const REPOSITORY_PATH = new RegExp(`^(?!(?:${SLUG}:)?(?:.*/)?\\.\\.(?:/|$))(?:${SLUG}:)?(?![/])[A-Za-z0-9._@+\\-/*?]+$`)

/** One file or directory, optionally `<slug>:`-prefixed: no wildcards, no `.` or `..` segments, no leading or trailing `/`. */
export const REPOSITORY_FILE = new RegExp(`^(?!(?:${SLUG}:)?(?:.*/)?\\.\\.?(?:/|$))(?:${SLUG}:)?(?![/])[A-Za-z0-9._@+\\-/]*[A-Za-z0-9._@+-]$`)

const PREFIXED = new RegExp(`^(${SLUG}):(.*)$`)

/** The sibling a reference names, if any, and the path inside that repository. */
export function splitRepositoryPath(reference: string): Readonly<{ slug?: string; path: string }> {
    const match = PREFIXED.exec(reference)
    return match ? { slug: match[1]!, path: match[2]! } : { path: reference }
}
