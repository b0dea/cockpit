/**
 * Vitest setup: strips the variables that tell git which repository to act on.
 *
 * Fixtures run git with the ambient environment. Under `git bisect run`, a hook or an alias,
 * git exports GIT_DIR for the outer repository, and a fixture's `git init --bare <tmp>` then
 * re-initialises that outer repository as bare instead of creating the temporary one. From a
 * worktree this flipped `core.bare` in the shared config and broke the main checkout. Production
 * git calls pass an explicit allow-listed environment, so only the test process needs this.
 */
const REPOSITORY_LOCATING_VARIABLES = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
] as const

for (const name of REPOSITORY_LOCATING_VARIABLES) delete process.env[name]
