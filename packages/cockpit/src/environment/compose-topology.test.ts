import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessComposeTopology, type ComposeServiceTopology } from './compose-topology.js'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

function product(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-topology-')))
    scratch.push(root)
    mkdirSync(join(root, 'api'))
    return root
}

const service = (mountSources: readonly string[]): ComposeServiceTopology =>
    ({ id: 'api', ports: [], healthcheck: true, image: null, build: true, containerName: null, mountSources })

const mountCodes = async (root: string, mountSources: readonly string[], mount = 'always') =>
    (await assessComposeTopology([service(mountSources)], {
        projectDirectory: root, portVariables: [], hostPaths: [],
        siblings: [{ slug: 'shop', var: 'SHOP_DIR', mount, path: root }],
    })).map(row => [row.code, row.target])

describe('compose topology mount posture', () => {
    // up admits a bind inside a mount = "always" checkout as mounting it, so check must too: a
    // brownfield Compose file binds `./api`, never the whole repository.
    it('counts a bind of a directory inside a mount = "always" sibling as mounting it', async () => {
        const root = product()
        expect(await mountCodes(root, [join(root, 'api')])).toEqual([])
        expect(await mountCodes(root, ['${SHOP_DIR}/api'])).toEqual([])
        expect(await mountCodes(root, ['${SHOP_DIR:-.}/api'])).toEqual([])
        expect(await mountCodes(root, ['${SHOP_DIR:-.}'])).toEqual([])
        // Compose reports a long-syntax variable source joined to the project directory.
        expect(await mountCodes(root, [`${root}/\${SHOP_DIR:?run through cockpit}/api`])).toEqual([])
        expect(await mountCodes(root, ['pgdata'])).toEqual([['COMPOSE_SIBLING_NOT_MOUNTED', 'sibling:shop']])
    })

    it('refuses in check every bind up would refuse: outside each sibling, through a link, or unresolvable', async () => {
        const root = product()
        const outside = product()
        symlinkSync(outside, join(root, 'api', 'escape'), 'dir')
        const undeclared = (source: string) => ['COMPOSE_BIND_UNDECLARED', `compose:api:${source}`]
        // A prefix is not containment: `<root>-other` is a different directory.
        expect(await mountCodes(root, [join(root, 'api'), `${root}-other`])).toEqual([undeclared(`${root}-other`)])
        expect(await mountCodes(root, [join(root, 'api'), outside])).toEqual([undeclared(outside)])
        expect(await mountCodes(root, [join(root, 'api'), join(root, 'api', 'escape')])).toEqual([undeclared(join(root, 'api', 'escape'))])
        expect(await mountCodes(root, [join(root, 'api'), '${CACHE_DIR}'])).toEqual([undeclared('${CACHE_DIR}')])
        // A default is the file's own choice and resolves against the project directory, as up resolves it.
        expect(await mountCodes(root, [join(root, 'api'), '${CACHE_DIR:-../elsewhere}'])).toEqual([undeclared('${CACHE_DIR:-../elsewhere}')])
        // A mount = "none" sibling is not handed to containers, so a bind inside it is undeclared too.
        expect(await mountCodes(root, [join(root, 'api')], 'none')).toEqual([undeclared(join(root, 'api'))])
        // A declared generated host path (here relative to a cockpit at `outside`) is admitted exactly
        // where up admits it, and refused, as up refuses it, when no service binds it.
        const withHostPath = async (mountSources: readonly string[]) => (await assessComposeTopology([service(mountSources)], {
            projectDirectory: root, portVariables: [], hostPaths: [{ declared: 'seed.sql', path: join(outside, 'seed.sql') }],
            siblings: [{ slug: 'shop', var: 'SHOP_DIR', mount: 'always', path: root }],
        })).map(row => [row.code, row.target])
        expect(await withHostPath([join(root, 'api'), join(outside, 'seed.sql')])).toEqual([])
        expect(await withHostPath([join(root, 'api')])).toEqual([['GENERATED_HOST_PATH_UNMOUNTED', 'environment.generated_host_paths:seed.sql']])
        // One inside a checkout bound whole reaches the container through that bind.
        expect((await assessComposeTopology([service([root])], {
            projectDirectory: root, portVariables: [], hostPaths: [{ declared: 'api/cache', path: join(root, 'api', 'cache') }],
            siblings: [{ slug: 'shop', var: 'SHOP_DIR', mount: 'always', path: root }],
        })).map(row => row.code)).toEqual([])
    })
})

describe('compose topology port exposure', () => {
    const publishing = (hostIp: string | null, published: string | null = '${API_HOST_PORT}'): ComposeServiceTopology =>
        ({ id: 'api', ports: [{ published, hostIp, target: '3000' }], healthcheck: true, image: null, build: true, containerName: null, mountSources: [] })
    const exposure = async (...ports: ComposeServiceTopology[]) => (await assessComposeTopology(ports, {
        projectDirectory: '/unused', portVariables: ['API_HOST_PORT'], hostPaths: [], siblings: [],
    })).map(row => [row.severity, row.code, row.target])

    // Docker binds every interface when a published port names none; naming one, even 0.0.0.0, is the
    // author saying what they mean.
    it('warns on a published port with no host interface and accepts one that names it', async () => {
        expect(await exposure(publishing(null))).toEqual([['warning', 'COMPOSE_PORT_ALL_INTERFACES', 'compose:api:3000']])
        expect(await exposure(publishing(null, null))).toEqual([['warning', 'COMPOSE_PORT_ALL_INTERFACES', 'compose:api:3000']])
        expect(await exposure(publishing('127.0.0.1'))).toEqual([])
        expect(await exposure(publishing('::1'))).toEqual([])
        expect(await exposure(publishing('0.0.0.0'))).toEqual([])
    })
})

describe('compose topology container names', () => {
    const named = (containerName: string | null): ComposeServiceTopology =>
        ({ id: 'api', ports: [], healthcheck: true, image: null, build: true, containerName, mountSources: [] })
    const findings = async (api: ComposeServiceTopology) => (await assessComposeTopology([api], {
        projectDirectory: '/unused', portVariables: [], hostPaths: [], siblings: [],
    })).map(row => [row.severity, row.code, row.target])

    // Docker refuses a second container of one name, so a second checkout's stack would fail at `up`.
    it('refuses a fixed container_name and accepts a service Compose names itself', async () => {
        expect(await findings(named('fixed-api'))).toEqual([['error', 'COMPOSE_CONTAINER_NAME_FIXED', 'compose:api']])
        expect(await findings(named(null))).toEqual([])
    })
})
