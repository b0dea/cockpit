import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import { createMachine, createProduct, ok, PRODUCT_FILES, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

// Keeps the fake docker honest: the same journey against a real daemon. Opt in with
// COCKPIT_JOURNEY_DOCKER=1 and a running daemon; COCKPIT_JOURNEY_IMAGE names a local image with a
// shell (default alpine:3.20), because measuring the runtime neither pulls nor builds. It never
// starts a daemon. Set DOCKER_HOST when the daemon is not on the default socket: each command runs
// with an isolated home, so the Docker CLI does not see the current user's contexts.
it.skipIf(process.env.COCKPIT_JOURNEY_DOCKER !== '1')('brings a tiny stack up and down against the real Docker daemon', () => {
    const image = process.env.COCKPIT_JOURNEY_IMAGE ?? 'alpine:3.20'
    const docker = execFileSync('/bin/sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
    const info = spawnSync(docker, ['image', 'inspect', image], { encoding: 'utf8' })
    expect(info.status, `docker cannot reach a daemon holding ${image}: ${info.stderr}`).toBe(0)
    const machine = createMachine('real', { realDocker: docker })
    const shop = createProduct('real', { machine, files: { 'compose.yml': PRODUCT_FILES['compose.yml']!.replace('node:22-alpine', image) } })
    for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT'] as const) if (process.env[name]) shop.env[name] = process.env[name]
    ok(shop, ['sync'])
    ok(shop, ['check'])
    ok(shop, ['runtime', 'measure', '--image', image])
    try {
        ok(shop, ['up'])
        expect(ok(shop, ['ps']).json?.result.services).toEqual([expect.objectContaining({ service: 'app', state: 'running' })])
    } finally {
        ok(shop, ['down'])
    }
})
