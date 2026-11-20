/**
 * What adopting cockpit takes over from a repository's existing setup, and what stays the repository's,
 * read from the files init observes. init shows both beside the files it writes, before it writes any.
 */
import { join, posix, relative as pathRelative, resolve, sep } from 'node:path'
import { ADOPTABLE_SURFACE_PATHS, ADOPTED_SURFACE_ROOT } from '../surfaces/contract.js'
import { COMPOSE_NAMES, readBounded } from './derive.js'

export type TakeoverRow = Readonly<{ path: string; note: string }>
export type Takeover = Readonly<{ takesOver: readonly TakeoverRow[]; staysYours: readonly TakeoverRow[] }>

interface TakeoverInput {
    /** Files must stay under this observed authority root. */
    readonly root: string
    /** The cockpit root, which cockpit's generated agent settings are written to; paths are shown relative to it. */
    readonly configurationRoot?: string
    readonly repositories: readonly Readonly<{ path: string }>[]
}

const STACK_RECIPE = /\bdocker(?:-compose|\s+compose)\b/

/** Makefile targets whose recipe runs Docker Compose, directly or through a variable that holds it. */
export function composeTargets(makefile: string): readonly string[] {
    const lines = makefile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
    const composeVariables = new Set<string>()
    for (const line of lines) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::{1,3}|\?|\+)?=\s*(.*)$/.exec(line)
        if (assignment && STACK_RECIPE.test(assignment[2]!)) composeVariables.add(assignment[1]!)
    }
    const drivesStack = (recipe: string) => STACK_RECIPE.test(recipe)
        || [...composeVariables].some(name => recipe.includes(`$(${name})`) || recipe.includes(`\${${name}}`))
    const targets = new Set<string>()
    let current: readonly string[] = []
    for (const line of lines) {
        const rule = /^([^\s:#=][^:#=]*?)\s*::?(?!=)/.exec(line)
        if (rule && !line.startsWith('\t')) { current = rule[1]!.split(/\s+/).filter(name => !name.startsWith('.')); continue }
        if (line.startsWith('\t') && drivesStack(line)) for (const target of current) targets.add(target)
    }
    return [...targets]
}

/** Every hook command a settings file registers, by event; undefined when the file is not JSON. */
function hookCommands(settings: string): readonly string[] | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(settings) } catch { return undefined } // The caller says the hooks could not be listed.
    const hooks = (parsed as { hooks?: unknown } | null)?.hooks
    if (hooks === null || typeof hooks !== 'object') return []
    return Object.entries(hooks).flatMap(([event, rows]) => (Array.isArray(rows) ? rows : [])
        .flatMap(row => Array.isArray(row?.hooks) ? row.hooks : [])
        .flatMap(hook => typeof hook?.command === 'string' ? [`${event}: ${hook.command}`] : []))
}

export async function observeTakeover(input: TakeoverInput): Promise<Takeover> {
    const configurationRoot = input.configurationRoot ?? input.root
    const own = pathRelative(input.root, configurationRoot) || '.'
    const shown = (directory: string, name: string) => {
        const path = pathRelative(configurationRoot, resolve(input.root, directory, name))
        return path.split(sep).join(posix.sep) || '.'
    }
    const takesOver: TakeoverRow[] = []
    const staysYours: TakeoverRow[] = []
    for (const path of ADOPTABLE_SURFACE_PATHS) {
        const read = await readBounded(input.root, join(own, posix.dirname(path)), posix.basename(path))
        if (read.kind === 'absent') continue
        const hooks = read.kind === 'text' && path.endsWith('.json') ? hookCommands(read.text) : []
        const kept = read.kind === 'skipped' ? `; it ${read.reason}, so its hooks are not listed`
            : hooks === undefined ? '; it is not JSON, so its hooks are not listed'
                : hooks.length ? `, and its hooks (${hooks.join('; ')}) keep running beside cockpit's guard until you drop them; compare a guard hook with cockpit adopt --import-guard <hook> --cases <file> first` : ''
        takesOver.push({ path, note: `cockpit generates this file, so sync refuses until a person moves it to ${ADOPTED_SURFACE_ROOT}/${path}; sync then merges it with cockpit's${kept}` })
    }
    for (const directory of [...new Set([own, ...input.repositories.map(row => row.path)])]) {
        const makefile = await readBounded(input.root, directory, 'Makefile')
        if (makefile.kind === 'text') {
            const targets = composeTargets(makefile.text)
            if (targets.length) takesOver.push({ path: shown(directory, 'Makefile'), note: `${targets.map(target => `make ${target}`).join(', ')} ${targets.length === 1 ? 'drives' : 'drive'} Docker Compose; cockpit up, down and reset take that stack over. Stop it with the old command before the first cockpit up: both would run the same services against the same checkout, and neither stops the other's` })
            staysYours.push({ path: shown(directory, 'Makefile'), note: 'cockpit never edits it; its other targets keep working' })
        } else if (makefile.kind === 'skipped') {
            staysYours.push({ path: shown(directory, 'Makefile'), note: `it ${makefile.reason}, so its Compose targets are not listed` })
        }
        for (const name of COMPOSE_NAMES) {
            if ((await readBounded(input.root, directory, name)).kind === 'text') {
                staysYours.push({ path: shown(directory, name), note: 'cockpit reads it and layers compose.cockpit.yml over it; it never edits it' })
            }
        }
    }
    return { takesOver, staysYours }
}
