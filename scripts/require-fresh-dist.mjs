import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../packages/cockpit/', import.meta.url))
// Mirrors tsconfig.build.json: files the build ignores must not make dist look stale.
const NOT_BUILT = /(\.test\.ts|[\\/]test-support[\\/]|[\\/]fixtures[\\/])/

function newestMtime(directory, skip) {
    let newest = 0
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const path = join(entry.parentPath, entry.name)
        if (skip?.test(path)) continue
        newest = Math.max(newest, statSync(path).mtimeMs)
    }
    return newest
}

/**
 * The slow tier runs the built CLI, and nothing builds first, so a stale dist silently tests old
 * code. The build deletes dist before rewriting it, which is unsafe to run from parallel workers,
 * so this only checks and tells the developer to build.
 */
export default function setup() {
    if (!existsSync(join(root, 'dist'))) fail('dist is missing: run npm run build')
    const built = newestMtime(join(root, 'dist'))
    const changed = Math.max(newestMtime(join(root, 'src'), NOT_BUILT), newestMtime(join(root, 'surfaces')))
    if (changed > built) fail('dist is older than src: run npm run build')
}

// Vitest crashes while source-mapping a stack thrown from a global setup and hides the message,
// so the stack is dropped to keep the one line readable.
function fail(message) {
    const error = new Error(message)
    error.stack = message
    throw error
}
