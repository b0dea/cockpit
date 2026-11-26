import { readFileSync } from 'node:fs'

export interface InstalledPackageMetadata {
    readonly name: string
    readonly version: string
    readonly engines: Readonly<{ node: string }>
    readonly cockpitSourceRevision: string
}

const actual: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const record = actual !== null && typeof actual === 'object' && !Array.isArray(actual) ? actual : undefined
const fields = record as Record<string, unknown> | undefined
const engines = fields?.engines as Record<string, unknown> | undefined
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && value.length <= 256 && value.trim() === value && !/[\u0000-\u0020\u007f-\u009f]/.test(value)
if (!fields || !text(fields.name) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(fields.name)
    || !text(fields.version) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(fields.version)
    || !engines || typeof engines.node !== 'string' || engines.node.length === 0 || engines.node.length > 256
    || !/^[0-9v<>=~^.*|xX+ -]+$/.test(engines.node) || !/\d/.test(engines.node)
    || !text(fields.cockpitSourceRevision)) throw new Error('Installed package metadata is invalid: name, version, engines.node and cockpitSourceRevision are required')

export const installedPackageMetadata: InstalledPackageMetadata = Object.freeze({
    name: fields.name,
    version: fields.version,
    engines: Object.freeze({ node: engines.node }),
    cockpitSourceRevision: fields.cockpitSourceRevision,
})

/** An exact version, as cockpit pins itself and the registry answers; a range or tag is none. */
export const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** Orders two exact versions; a prerelease sorts before its release, and prerelease identifiers compare as semver says. */
export function compareVersions(a: string, b: string): number {
    const [x, y] = [EXACT_VERSION.exec(a)!, EXACT_VERSION.exec(b)!]
    for (let i = 1; i <= 3; i++) if (x[i] !== y[i]) return Number(x[i]) < Number(y[i]) ? -1 : 1
    if (x[4] === y[4]) return 0
    if (x[4] === undefined || y[4] === undefined) return x[4] === undefined ? 1 : -1
    const [p, q] = [x[4].split('.'), y[4].split('.')]
    for (let i = 0; i < Math.max(p.length, q.length); i++) {
        if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1
        if (p[i] === q[i]) continue
        const numeric = [/^\d+$/.test(p[i]!), /^\d+$/.test(q[i]!)]
        if (numeric[0] && numeric[1]) return Number(p[i]) < Number(q[i]) ? -1 : 1
        if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1
        return p[i]! < q[i]! ? -1 : 1
    }
    return 0
}
