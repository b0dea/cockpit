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
