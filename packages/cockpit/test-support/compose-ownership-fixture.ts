import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from '../src/environment/compose-ownership.js'

// Stands in for `sync`: a compose_files stack runs only with the ownership override rendered from
// its current Compose files and identity, so a fixture publishes the same production render.
export async function publishComposeOwnership(
    checkout: string,
    context: { readonly stackId: string; readonly cockpitId: string; readonly source: { readonly sha256: string } },
    references: readonly string[] = ['compose.yml'],
): Promise<void> {
    const sources = await Promise.all(references.map(async (reference) => ({
        reference, source: await readFile(join(checkout, reference), 'utf8'),
    })))
    const rendered = renderComposeOwnership({
        sources, stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.source.sha256,
    })
    if (rendered.kind !== 'complete') throw new Error(rendered.reason)
    await writeFile(join(checkout, COMPOSE_OWNERSHIP_FILE), rendered.bytes)
}
