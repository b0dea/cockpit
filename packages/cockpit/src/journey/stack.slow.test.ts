import { afterAll, expect, it } from 'vitest'
import { cloneProduct, createMachine, createProduct, explain, ok, type Product, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

// docs/getting-started.md "Bring the product up" and docs/tutorial.md "Bring the stack up".
function bringUp(product: Product) {
    ok(product, ['sync'])
    ok(product, ['check'])
    ok(product, ['runtime', 'measure', '--image', 'node:22-alpine'])
}

const removals = (calls: string[][]) => calls.filter((argv) => argv.includes('rm') || argv.includes('down'))

it('starts the stack, shows it to every later command, resets only declared data and starts it again', () => {
    const shop = createProduct('shop')
    bringUp(shop)
    const unready = shop.cockpit(['test-run', '--gate', 'all'])
    expect(unready.status, explain(unready)).not.toBe(0)
    expect(unready.json?.result.verdict).toBe('DEGRADED')

    const up = ok(shop, ['up'])
    expect(up.json?.result).toMatchObject({ change: 'started', ports: { APP_PORT: expect.any(Number) } })
    ok(shop, ['preflight'])
    expect(ok(shop, ['ps']).json?.result.services).toEqual([expect.objectContaining({ service: 'app', state: 'running', health: 'healthy' })])
    // Each command is its own process, so a gate that needs the stack must find the one `up` started.
    expect(ok(shop, ['test-run', '--gate', 'all']).json?.result).toMatchObject({ verdict: 'PASS', satisfiesGate: true })
    const logs = shop.cockpit(['logs', '--service', 'app'], { json: false })
    expect(logs.status, explain(logs)).toBe(0)
    expect(logs.stdout).toContain('app listening')

    const volumes = () => shop.docker.state().volumes.map((volume) => volume.Labels['com.docker.compose.volume']).sort()
    expect(volumes()).toEqual(['cache', 'data'])
    const before = shop.docker.calls().length
    ok(shop, ['reset', '--apply'])
    expect(volumes()).toEqual(['cache'])
    expect(removals(shop.docker.calls().slice(before)).filter((argv) => argv.includes('volume'))).toEqual([
        expect.arrayContaining(['volume', 'rm', expect.stringMatching(/_data$/)]),
    ])

    expect(ok(shop, ['up']).json?.result).toMatchObject({ change: 'started', ports: up.json?.result.ports })
    ok(shop, ['preflight'])
    ok(shop, ['down'])
    expect(shop.docker.state().containers).toEqual([])
    expect(volumes()).toEqual(['cache', 'data'])
    expect(ok(shop, ['up']).json?.result.change).toBe('started')
    ok(shop, ['down'])
})

it('gives two checkouts of one product their own ports and stacks, and neither can stop the other', () => {
    const machine = createMachine('laptop')
    const first = createProduct('first', { machine })
    bringUp(first)
    first.git('add', '--all')
    first.git('commit', '--quiet', '--message', 'Adopt cockpit')
    const second = cloneProduct(first, 'second', machine)
    ok(second, ['sync'])

    const firstUp = ok(first, ['up']).json?.result
    const secondUp = ok(second, ['up']).json?.result
    expect(secondUp.stackId).not.toBe(firstUp.stackId)
    expect(secondUp.ports.APP_PORT).not.toBe(firstUp.ports.APP_PORT)
    ok(first, ['preflight'])
    ok(second, ['preflight'])

    const owned = (stackId: string) => new Set(machine.docker.state().containers
        .filter((container) => container.Config.Labels['dev.b0dea.cockpit.stack-id'] === stackId).map((container) => container.Id))
    const firstContainers = owned(firstUp.stackId)
    const secondContainers = owned(secondUp.stackId)
    const before = machine.docker.calls().length
    ok(second, ['down'])
    // Teardown names what it removes by id, and only what carries this stack's label.
    for (const argv of removals(machine.docker.calls().slice(before)).filter((call) => call.includes('container'))) {
        expect(secondContainers.has(argv.at(-1)!), argv.join(' ')).toBe(true)
    }
    expect(owned(secondUp.stackId).size).toBe(0)
    expect(owned(firstUp.stackId)).toEqual(firstContainers)
    expect(ok(first, ['ps']).json?.result.services).toEqual([expect.objectContaining({ state: 'running' })])
    ok(first, ['preflight'])
    ok(first, ['down'])
})
