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
    ({ id: 'api', ports: [], healthcheck: true, image: null, build: true, mountSources })

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
        // A declared generated host path is admitted exactly where up admits it.
        expect((await assessComposeTopology([service([join(root, 'api'), join(outside, 'seed.sql')])], {
            projectDirectory: root, portVariables: [], hostPaths: [join(outside, 'seed.sql')],
            siblings: [{ slug: 'shop', var: 'SHOP_DIR', mount: 'always', path: root }],
        })).map(row => row.code)).toEqual([])
    })
})
