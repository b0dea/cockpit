/**
 * Owns `cockpit tool add` and `cockpit tool remove`: they edit the `[surfaces] tools` list of
 * cockpit.toml so nobody hand-edits it. They write no tool's files: the next sync renders an added
 * tool from the same sources as the others, and offers a removed tool's owned files to the
 * stale-removal approval that already guards every deletion of a generated file.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse, TomlError } from 'smol-toml'
import { loadCockpitConfig } from '../config/load.js'
import { setSurfaceTools } from '../config/surface-tools-toml.js'
import { writeVerifiedConfig } from '../config/verified-write.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { CockpitConfig } from '../schema.js'
import { harnessFact, SURFACE_TARGETS, type SurfaceTarget } from '../surfaces/harness-registry.js'
import { ENVIRONMENT_CODES, errorCause } from './contract.js'
import type { SiblingOutcome } from './sibling-registration.js'

export const mechanism = {
    id: 'tool-registration',
    module: 'packages/cockpit/src/environment/tool-registration.ts',
    exports: ['runToolChange'],
} as const

export interface ToolChangeInput {
    readonly operation: 'add' | 'remove'
    readonly configPath: string
    readonly tool: string
    /** Show the edited list and write nothing. */
    readonly dryRun: boolean
}

const EDIT_BY_HAND_FIX = 'edit the tools list under [surfaces] in cockpit.toml by hand, then run npx --no cockpit sync --config <your cockpit.toml> --dry-run'

function refused(code: string, message: string, target: string, fix?: string): SiblingOutcome {
    return Object.freeze({ status: 2, result: null, artifact: null, destination: null,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error' as const, code, message, target, ...(fix === undefined ? {} : { fix }) })]) })
}

/** Key order must not matter when two parsed configurations are compared. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1)) : item)
}

function done(artifact: string, result: Record<string, unknown>): SiblingOutcome {
    return Object.freeze({ status: 0, diagnostics: Object.freeze([]), destination: null, artifact, result: Object.freeze(result) })
}

export async function runToolChange(input: ToolChangeInput): Promise<SiblingOutcome> {
    if (!SURFACE_TARGETS.includes(input.tool as SurfaceTarget)) {
        return refused('CLI_USAGE_INVALID', `unknown tool ${JSON.stringify(input.tool)}; cockpit renders ${SURFACE_TARGETS.join(', ')}`, input.tool)
    }
    const tool = input.tool as SurfaceTarget
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({ status: 2, result: null, diagnostics: loaded.diagnostics })
    const configPath = loaded.result.source.path
    const config = loaded.result.config
    // The list keeps the order it was written in; an added tool goes last.
    const before = config.surfaces.tools
    const after = input.operation === 'add' ? before.includes(tool) ? before : [...before, tool] : before.filter(row => row !== tool)
    const preview = cockpitCommand('sync', { config: configPath, args: '--dry-run' })
    if (after.length === before.length) {
        return done(`${harnessFact(tool).displayName} (${tool}) is ${input.operation === 'add' ? 'already' : 'not'} listed in ${configPath}; nothing was written.\n`,
            { action: 'unchanged', config: configPath, tool, tools: before })
    }
    const bytes = await readFile(configPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== loaded.result.source.sha256) {
        return refused(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, 'cockpit.toml changed while it was being read; nothing was written', configPath,
            `run the same npx --no cockpit tool ${input.operation} command again`)
    }
    const edit = setSurfaceTools(bytes.toString('utf8'), after)
    if (edit.kind === 'unsupported') {
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, `cockpit.toml cannot be edited safely: ${edit.reason}; nothing was written`, 'surfaces.tools', EDIT_BY_HAND_FIX)
    }
    // The schema decides what a list may hold (a guarded tool, every browser harness), so its refusal is the message.
    let parsed
    try { parsed = CockpitConfig.safeParse(parse(edit.text)) } catch (error) {
        const where = error instanceof TomlError ? `at line ${error.line}, column ${error.column}` : errorCause(error)
        return refused(ENVIRONMENT_CODES.CONFIG_PARSE_INVALID, `the edit would leave cockpit.toml unparseable (${where}); nothing was written`, 'surfaces.tools', EDIT_BY_HAND_FIX)
    }
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `${input.operation === 'add' ? 'adding' : 'removing'} ${tool} would leave cockpit.toml invalid (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema'}); nothing was written`,
            'surfaces.tools', 'change what the message names first, then run the command again')
    }
    const expected = canonical({ ...config, surfaces: { ...config.surfaces, tools: after } })
    const exact = (candidate: unknown) => canonical(candidate) === expected
    if (!exact(parsed.data)) {
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, 'the edit would change more than the tools list; nothing was written', 'surfaces.tools', EDIT_BY_HAND_FIX)
    }
    const line = `tools = [${after.map(row => JSON.stringify(row)).join(', ')}]`
    const next = input.operation === 'add'
        ? `The next sync writes ${harnessFact(tool).displayName}'s instructions, skills and settings from the same sources as the other tools; preview them with ${preview}.`
        : `The next sync offers the files cockpit wrote for ${harnessFact(tool).displayName} for removal: ${preview} lists them, and a person approves their removal with ${cockpitCommand('sync', { config: configPath, args: '--interactive' })}.`
    const result = { action: input.dryRun ? 'previewed' : input.operation === 'add' ? 'added' : 'removed', config: configPath, tool, tools: after,
        next: preview }
    if (input.dryRun) return done(`Would set [surfaces] ${line} in ${configPath}; nothing was written.\n${next}\n`, result)

    const rerun = `let the other edit finish, then run the same npx --no cockpit tool ${input.operation} command again`
    const written = await writeVerifiedConfig({
        path: configPath, expectedSha256: sha256, temporaryTag: 'tool',
        edit: () => edit.text,
        isExactChange: exact,
        messages: {
            changedBefore: { message: 'cockpit.toml changed since it was read; nothing was written', fix: rerun },
            changedDuring: { message: 'cockpit.toml changed while the edit was being prepared; nothing was written', fix: rerun },
            invalid: (reason) => ({ message: `the edit would leave cockpit.toml invalid (${reason}); nothing was written`, fix: EDIT_BY_HAND_FIX }),
            notExact: { message: 'the edit would change more than the tools list; nothing was written', fix: EDIT_BY_HAND_FIX },
            writtenMismatch: { message: 'the tools list was written, but re-reading cockpit.toml shows a change beyond it',
                fix: 'review cockpit.toml for the change you did not make before running npx --no cockpit sync --config <your cockpit.toml> --dry-run' },
        },
    })
    if (written.kind !== 'complete') return refused(written.code, written.message, configPath, written.fix)
    return done(`Set [surfaces] ${line} in ${configPath}.\n${next}\n`, result)
}
