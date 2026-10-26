#!/usr/bin/env node

const minimumNodeMajor = 22
const version = process.versions.node
const match = typeof version === 'string' && /^([0-9]+)\.[0-9]+\.[0-9]+(?:[-+].*)?$/.exec(version)
const major = match ? Number(match[1]) : Number.NaN

if (!Number.isInteger(major) || major < minimumNodeMajor) {
    console.error(
        `COCKPIT_NODE_VERSION_UNSUPPORTED: Node.js ${minimumNodeMajor} or newer is required.`,
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
