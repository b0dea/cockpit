// Renders the Compose override that gives a compose-first cockpit's own services, default network
// and named volumes the ownership labels runtime admission and reclaim read. The cockpit's Compose
// files stay untouched: `sync` publishes this override as an owned file and `check` drift-checks it
// like any other, and runtime readiness passes it as the last `--file` only when its bytes equal a
// fresh render of the current Compose files and identity. It parses YAML only to list service and
// volume names; what Compose resolves from the files belongs to compose-topology.ts.
import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'

export const mechanism = {
    id: 'compose-ownership',
    module: 'packages/cockpit/src/environment/compose-ownership.ts',
    exports: ['COMPOSE_OWNERSHIP_FILE', 'renderComposeOwnership'],
} as const

/** Published beside cockpit.toml; the cockpit's own Compose files are passed first. */
export const COMPOSE_OWNERSHIP_FILE = 'compose.cockpit.yml'

const SERVICE_ID = /^[a-z0-9][a-z0-9_.-]*$/
const VOLUME_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const SOURCE_LIMIT_BYTES = 1_048_576

export type ComposeOwnershipRender =
    | Readonly<{ kind: 'complete'; bytes: string }>
    | Readonly<{ kind: 'refusal'; reason: string; target: string }>

export function renderComposeOwnership(input: Readonly<{
    sources: readonly Readonly<{ reference: string; source: string }>[]
    stackId: string
    cockpitId: string
    configSha256: string
}>): ComposeOwnershipRender {
    const services = new Set<string>()
    // Each owned volume and the labels its own files already declare, as KEY -> value.
    const volumes = new Map<string, Map<string, string>>()
    for (const { reference, source } of input.sources) {
        const refuse = (reason: string) => Object.freeze({ kind: 'refusal' as const, reason, target: reference })
        if (Buffer.byteLength(source) > SOURCE_LIMIT_BYTES) return refuse('the Compose file exceeds 1 MiB')
        const document = parseDocument(source, { merge: true })
        if (document.errors.length > 0) return refuse(`the Compose file is not valid YAML: ${document.errors[0]!.message.split('\n', 1)[0]}`)
        const root: unknown = document.toJS({ maxAliasCount: 100 })
        if (root === null || typeof root !== 'object' || Array.isArray(root)) return refuse('the Compose file is not a mapping')
        const record = root as Record<string, unknown>
        // An included file declares services this file cannot name, so they would run unlabelled.
        if (record.include !== undefined) return refuse('`include` is not supported: list each Compose file in environment.compose_files')
        if (record.volumes !== undefined) {
            if (record.volumes === null || typeof record.volumes !== 'object' || Array.isArray(record.volumes)) return refuse('`volumes` is not a mapping')
            for (const [id, declaration] of Object.entries(record.volumes)) {
                if (!VOLUME_ID.test(id)) return refuse(`volume name ${JSON.stringify(id)} is not a Compose volume identifier`)
                // An external volume is created outside this stack, and Compose refuses labels on one.
                const record = declaration !== null && typeof declaration === 'object' && !Array.isArray(declaration)
                    ? declaration as Record<string, unknown> : undefined
                if (record?.external) continue
                const declared = volumes.get(id) ?? new Map<string, string>()
                const labels = record?.labels
                if (Array.isArray(labels)) {
                    for (const entry of labels) if (typeof entry === 'string' && entry.includes('=')) declared.set(entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1))
                } else if (labels !== null && typeof labels === 'object') {
                    for (const [key, value] of Object.entries(labels)) declared.set(key, String(value))
                }
                volumes.set(id, declared)
            }
        }
        if (record.services === undefined) continue
        if (record.services === null || typeof record.services !== 'object' || Array.isArray(record.services)) return refuse('`services` is not a mapping')
        for (const id of Object.keys(record.services)) {
            if (!SERVICE_ID.test(id)) return refuse(`service name ${JSON.stringify(id)} is not a Compose service identifier`)
            services.add(id)
        }
    }
    const labels = {
        'dev.b0dea.cockpit.config-sha256': input.configSha256,
        'dev.b0dea.cockpit.owner-id': input.cockpitId,
        'dev.b0dea.cockpit.stack-id': input.stackId,
    }
    const generation = createHash('sha256').update(`compose-volume-generation\0${input.configSha256}`).digest('hex')
    // Compose 5.5 refuses to merge a volume label the earlier file already sets to the same value
    // ("labels must be a mapping"), so a label a volume already carries is not repeated, and a
    // volume that carries them all needs no entry. Services and networks merge them fine.
    const volumeLabels = [...volumes].sort(([left], [right]) => left.localeCompare(right)).flatMap(([id, declared]) => {
        const missing = Object.entries({ ...labels, 'dev.b0dea.cockpit.generation-id': generation })
            .filter(([key, value]) => declared.get(key) !== value)
        return missing.length === 0 ? [] : [[id, { labels: Object.fromEntries(missing) }] as const]
    })
    const body = stringify({
        services: Object.fromEntries([...services].sort().map((id) => [id, { labels }])),
        // The default network carries the same set, so `down` can remove the network it created.
        networks: { default: { labels } },
        // Reset admits a data-bearing volume only with exact ownership and a generation, as a
        // generated stack's volumes carry; unlabelled, a declared resettable volume was unreachable.
        ...(volumeLabels.length === 0 ? {} : { volumes: Object.fromEntries(volumeLabels) }),
    }, { aliasDuplicateObjects: false })
    return Object.freeze({
        kind: 'complete',
        bytes: `# Generated by cockpit sync from environment.compose_files: ownership labels only. Do not edit.\n${body}`,
    })
}
