import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { diagnosticInventoryFromSources } from '../../../scripts/diagnostic-inventory.mjs'

// Detectors that compare the inventory with modules imported from the working tree read the same
// working tree: an inventory of HEAD stays green on an uncommitted change that breaks the property.
export function workingTreeDiagnosticInventory(root: string) {
    const directory = 'packages/cockpit/src'
    const sources = new Map<string, string>()
    for (const entry of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
        const path = join(entry.parentPath, entry.name)
        sources.set(posix.join(directory, path.slice(join(root, directory).length + 1).split(sep).join('/')), readFileSync(path, 'utf8'))
    }
    return diagnosticInventoryFromSources([...sources.keys()].sort(), sources)
}
