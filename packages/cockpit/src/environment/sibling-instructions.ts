// Which root instruction files each agent tool loads in a repository, measured 2026-11-03 by asking
// each tool for words only a file it had loaded could tell it, beside a decoy file it must not load:
// Codex 0.166.0 and OpenCode 1.19.5 loaded AGENTS.md; Claude Code 2.1.317 loaded only CLAUDE.md (its
// built-in AGENTS.md reader is an option user settings can turn on and project settings cannot). With
// no AGENTS.md, OpenCode fell back to CLAUDE.md and Codex loaded nothing. None of the three loaded
// .cursorrules, .cursor/rules, GEMINI.md, .github/copilot-instructions.md or .windsurfrules. So a
// repository's instructions reach every tool alike only when AGENTS.md holds them and CLAUDE.md
// imports it; anything else leaves some tool without them.
import { randomBytes } from 'node:crypto'
import { sha256Hex } from '../sha256.js'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { readBoundedInput } from '../config/load.js'
import { ENVIRONMENT_CODES, errorCause, isMissing, RefusalError, type EnvironmentDiagnostic } from './contract.js'

const CLAUDE_IMPORT = '@AGENTS.md\n'
const TOOL_ONLY_FILES = ['.cursorrules', '.cursor/rules', 'GEMINI.md', '.github/copilot-instructions.md', '.windsurfrules'] as const

type FileState = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'present'; real: string; bytes: Uint8Array; text: string }>

interface Classification {
    readonly state: 'linked' | 'agents-only' | 'claude-only' | 'unlinked' | 'neither'
    /** CLAUDE.md names a file of its own with Claude's `@path` import, which no other tool follows. */
    readonly claudeImports: boolean
    readonly agents: FileState
    readonly claude: FileState
}

async function readInstructionFile(path: string): Promise<FileState> {
    try { await lstat(path) } catch (error) {
        if (isMissing(error)) return { kind: 'absent' }
        throw error
    }
    // A link is read where it resolves, so CLAUDE.md linked to AGENTS.md counts as one file.
    const real = await realpath(path)
    const read = await readBoundedInput(real)
    if (read.kind !== 'complete') throw new RefusalError(`${path} is larger than cockpit reads`)
    return { kind: 'present', real, bytes: read.bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) }
}

async function classify(root: string): Promise<Classification> {
    const agents = await readInstructionFile(join(root, 'AGENTS.md'))
    const claude = await readInstructionFile(join(root, 'CLAUDE.md'))
    // Claude Code resolves `@path` at the start of a line or after whitespace; an email address has neither.
    const claudeImports = claude.kind === 'present' && /(^|\s)@\S/.test(claude.text)
    if (agents.kind === 'absent') return { state: claude.kind === 'absent' ? 'neither' : 'claude-only', claudeImports, agents, claude }
    if (claude.kind === 'absent') return { state: 'agents-only', claudeImports, agents, claude }
    const linked = claude.real === agents.real || /^[ \t]*@(\.\/)?AGENTS\.md[ \t]*$/m.test(claude.text)
    return { state: linked ? 'linked' : 'unlinked', claudeImports, agents, claude }
}

/**
 * One warning for each way a repository's root instruction files leave a listed agent tool without
 * them. A team that uses only Claude Code loses nothing when a repository keeps CLAUDE.md alone.
 */
export async function inspectSiblingInstructions(
    repository: Readonly<{ slug: string; root: string }>,
    tools: readonly string[],
): Promise<readonly EnvironmentDiagnostic[]> {
    const claude = tools.includes('claudecode')
    // OpenCode falls back to CLAUDE.md when AGENTS.md is absent; Codex does not.
    const agentsReaders = tools.includes('codexcli') || tools.includes('opencode')
    const target = `sibling:${repository.slug}`
    const findings: EnvironmentDiagnostic[] = []
    let classified: Classification
    const toolOnly: string[] = []
    try {
        classified = await classify(repository.root)
        for (const name of TOOL_ONLY_FILES) {
            try { await lstat(join(repository.root, name)); toolOnly.push(name) } catch (error) {
                if (!isMissing(error)) throw error
            }
        }
    } catch (error) {
        return [{
            severity: 'warning' as const,
            code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            message: `which agent tools load the instructions of sibling ${repository.slug} could not be checked: ${errorCause(error)}`,
            target,
            fix: `make the instruction files at the root of ${repository.root} readable UTF-8 files, then rerun this command`,
        }]
    }
    if (classified.state === 'agents-only' && claude) findings.push({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'SIBLING_INSTRUCTIONS_AGENTS_ONLY' satisfies typeof ENVIRONMENT_CODES.SIBLING_INSTRUCTIONS_AGENTS_ONLY,
        message: `sibling ${repository.slug} has AGENTS.md but no CLAUDE.md, so Claude Code started there loads none of its instructions`,
        target,
        fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> to see the CLAUDE.md it proposes (one line, @AGENTS.md); once a person approves it, or without one where [autonomy] instruction_files = "agent", run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-files',
    })
    if (classified.state === 'claude-only' && tools.includes('codexcli')) findings.push({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'SIBLING_INSTRUCTIONS_CLAUDE_ONLY' satisfies typeof ENVIRONMENT_CODES.SIBLING_INSTRUCTIONS_CLAUDE_ONLY,
        message: `sibling ${repository.slug} has CLAUDE.md but no AGENTS.md, so Codex started there loads none of its instructions`
            + (classified.claudeImports ? '; CLAUDE.md imports other files with @, which only Claude Code follows, so setup proposes no move' : ''),
        target,
        fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> to see the move it proposes (CLAUDE.md copied byte for byte to AGENTS.md, CLAUDE.md replaced by @AGENTS.md) and, once a person approves it, or without one where [autonomy] instruction_files = "agent", rerun it with --write-instruction-files; when CLAUDE.md imports other files with @, setup proposes nothing and a person moves the shared instructions into AGENTS.md by hand',
    })
    if (classified.state === 'unlinked' && claude && agentsReaders) findings.push({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'SIBLING_INSTRUCTIONS_UNLINKED' satisfies typeof ENVIRONMENT_CODES.SIBLING_INSTRUCTIONS_UNLINKED,
        message: `sibling ${repository.slug} has both AGENTS.md and CLAUDE.md, but CLAUDE.md does not import AGENTS.md, so Claude Code loads only CLAUDE.md and Codex only AGENTS.md`,
        target,
        fix: 'a person merges the instructions every tool needs into AGENTS.md, then makes CLAUDE.md a line reading @AGENTS.md followed only by instructions that apply to Claude Code alone',
    })
    if (classified.state === 'neither') findings.push({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'SIBLING_INSTRUCTIONS_MISSING' satisfies typeof ENVIRONMENT_CODES.SIBLING_INSTRUCTIONS_MISSING,
        message: `sibling ${repository.slug} has neither AGENTS.md nor CLAUDE.md, so no agent tool started there loads instructions for it`,
        target,
        fix: 'a person writes AGENTS.md with what an agent must know to work in the repository, then runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-files to add the CLAUDE.md that imports it',
    })
    if (toolOnly.length > 0) findings.push({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'SIBLING_INSTRUCTIONS_TOOL_ONLY' satisfies typeof ENVIRONMENT_CODES.SIBLING_INSTRUCTIONS_TOOL_ONLY,
        message: `sibling ${repository.slug} keeps instructions in ${toolOnly.join(', ')}, which Claude Code, Codex and OpenCode do not load`,
        target,
        fix: 'a person moves the instructions every tool needs from those files into AGENTS.md, and keeps only settings specific to one tool where they are',
    })
    return findings
}

export type SiblingInstructionFilesChange = 'claude-import' | 'move-to-agents'

export type SiblingInstructionFilesResult =
    | Readonly<{ kind: 'none'; root: string }>
    | Readonly<{ kind: 'offered' | 'written'; root: string; change: SiblingInstructionFilesChange }>
    | Readonly<{ kind: 'refusal'; root: string; reason: string }>

async function createExclusive(path: string, bytes: Uint8Array | string, mode: number): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
}

async function holds(path: string, expected: Uint8Array | string): Promise<boolean> {
    const read = await readBoundedInput(path)
    return read.kind === 'complete' && Buffer.from(read.bytes).equals(Buffer.from(expected))
}

/**
 * Makes AGENTS.md the file every tool loads and CLAUDE.md the import Claude Code needs, in the two
 * cases that need no judgement: AGENTS.md alone gains a CLAUDE.md reading `@AGENTS.md`, and CLAUDE.md
 * alone, when it imports nothing of its own, moves byte for byte to AGENTS.md and becomes that import.
 * Without `write` it only reports the change. It writes only ordinary files directly in a canonical
 * root, never through a link, and refuses when a file changed after it was read.
 */
export async function synchronizeSiblingInstructionFiles(input: Readonly<{ siblingRoot: string; write: boolean }>): Promise<SiblingInstructionFilesResult> {
    const root = input.siblingRoot
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    let created: string | undefined
    try {
        if (await realpath(root) !== root) return { kind: 'refusal', root, reason: 'the sibling root must be a canonical directory without symlink redirects' }
        const classified = await classify(root)
        const change: SiblingInstructionFilesChange | undefined = classified.state === 'agents-only' ? 'claude-import'
            : classified.state === 'claude-only' && !classified.claudeImports ? 'move-to-agents' : undefined
        if (!change) return { kind: 'none', root }
        const before = await lstat(change === 'claude-import' ? agentsPath : claudePath)
        if (!before.isFile()) return { kind: 'refusal', root, reason: `${change === 'claude-import' ? 'AGENTS.md' : 'CLAUDE.md'} is not an ordinary file` }
        if (!input.write) return { kind: 'offered', root, change }
        if (change === 'claude-import') {
            await createExclusive(claudePath, CLAUDE_IMPORT, 0o644)
            created = claudePath
        } else {
            const original = classified.claude.kind === 'present' ? classified.claude.bytes : new Uint8Array()
            await createExclusive(agentsPath, original, Number(before.mode) & 0o777)
            created = agentsPath
            const temporary = join(root, `.CLAUDE.md.cockpit-instructions-${randomBytes(8).toString('hex')}`)
            try {
                await createExclusive(temporary, CLAUDE_IMPORT, Number(before.mode) & 0o777)
                const current = await lstat(claudePath)
                const reread = await readBoundedInput(claudePath)
                if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
                    || current.mtimeMs !== before.mtimeMs || reread.kind !== 'complete' || sha256Hex(reread.bytes) !== sha256Hex(original)) {
                    throw new RefusalError('CLAUDE.md changed before it could be replaced')
                }
                await rename(temporary, claudePath)
            } finally {
                await unlink(temporary).catch((cleanup: unknown) => { if (!isMissing(cleanup)) throw cleanup })
            }
        }
        // From here the instructions live only in what was written; nothing is undone any more.
        created = undefined
        await syncDirectory(root)
        if (!await holds(claudePath, CLAUDE_IMPORT)) return { kind: 'refusal', root, reason: 'CLAUDE.md does not hold the import after writing' }
        if (change === 'move-to-agents' && !await holds(agentsPath, classified.claude.kind === 'present' ? classified.claude.bytes : '')) {
            return { kind: 'refusal', root, reason: 'AGENTS.md does not hold the moved instructions after writing' }
        }
        return { kind: 'written', root, change }
    } catch (error) {
        // A file this run created is removed when the change could not complete, so a half-made move
        // never leaves two copies of the instructions that can drift apart.
        if (created) {
            try { await unlink(created) } catch (cleanup) {
                if (!isMissing(cleanup)) return { kind: 'refusal', root, reason: `${errorCause(error)}; ${created} could not be removed: ${errorCause(cleanup)}` }
            }
        }
        return { kind: 'refusal', root, reason: errorCause(error) }
    }
}
