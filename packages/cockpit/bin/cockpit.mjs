#!/usr/bin/env node

// Mirrors package.json "engines.node"; the floor is the 22.x minor, not just the major.
const supportedRange = '^22.22.0 || ^24.0.0 || ^26.0.0'
const minimumNode22Minor = 22
const version = process.versions.node
const match = typeof version === 'string' && /^([0-9]+)\.([0-9]+)\.[0-9]+(?:[-+].*)?$/.exec(version)
const major = match ? Number(match[1]) : Number.NaN
const minor = match ? Number(match[2]) : Number.NaN

if (!Number.isInteger(major) || major < 22 || (major === 22 && minor < minimumNode22Minor)) {
    console.error(
        `COCKPIT_NODE_VERSION_UNSUPPORTED: Node.js ${supportedRange} is required; this is ${version}.`,
    )
    process.exitCode = 1
} else {
    const { runCli } = await import('../dist/cli.js')
    const argv = process.argv.slice(2)
    if (argv[0] !== 'session' && argv[0] !== 'logs') {
        process.exitCode = await runCli(argv)
    } else {
        const controller = new AbortController()
        const abort = () => controller.abort()
        process.once('SIGINT', abort)
        process.once('SIGTERM', abort)
        try {
            process.exitCode = await runCli(argv, process, {}, { signal: controller.signal })
        } finally {
            process.removeListener('SIGINT', abort)
            process.removeListener('SIGTERM', abort)
        }
    }
}
