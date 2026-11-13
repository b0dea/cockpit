import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Vitest setup: strips ambient variables that make fixture subprocesses act on the developer's
 * machine instead of the fixture.
 *
 * Fixtures run git with the ambient environment. Under `git bisect run`, a hook or an alias,
 * git exports GIT_DIR for the outer repository, and a fixture's `git init --bare <tmp>` then
 * re-initialises that outer repository as bare instead of creating the temporary one. From a
 * worktree this flipped `core.bare` in the shared config and broke the main checkout. Production
 * git calls pass an explicit allow-listed environment, so only the test process needs this.
 *
 * BASH_ENV and ENV make every non-interactive shell source a startup file. A developer's file
 * that defines an `npm` function shadowed the stand-in `npm` a release-script test puts first on
 * PATH, so the test ran the developer's npm wrapper instead.
 *
 * HOME is a fresh directory for each test file, and the XDG directories derive from it: sync records the
 * guard below ~/.cockpit/guards, and tests that synced into the developer's home left hundreds of records
 * there and overwrote the machine's shared guard check.
 */
const AMBIENT_VARIABLES = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
    'BASH_ENV', 'ENV', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
] as const

for (const name of AMBIENT_VARIABLES) delete process.env[name]
process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-test-home-')))
