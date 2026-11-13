// Derives, for one guard call, where the running agent tool keeps its own files: its home
// directories, the Claude Code project names whose auto memory belongs to this cockpit, the
// session's scratchpad and the private temp directories. Each comes from what the harness reported
// in the hook payload, the variables it runs with and the machine, never from a guessed layout; the
// evaluator classifies and judges every path below them.
//
// Measured 2026-11-13 on macOS with Claude Code 2.1.323, Codex CLI 0.168.0 and OpenCode 1.19.5:
// docs/safety-and-autonomy.md#agent-workspaces holds the table and how each fact was observed.
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { readBoundedFile } from '../bounded-read.js'
import { snapshotExecutionStep, RefusalError } from '../environment/contract.js'
import type { ResolvedExecutable } from '../environment/executable.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { claudeProjectKey } from './agent-homes.js'
import { AGENT_TYPE, type GuardAgentHome, type GuardAgentWorkspace } from './evaluator.js'
import type { GuardExecute } from './protected-locations.js'

/** What the hook payload says about the session, as the harness sent it. */
export interface GuardAgentSession {
    readonly transcriptPath?: string
    readonly sessionId?: string
    readonly scratchpadDir?: string
    /** Set on calls a Claude Code subagent makes. */
    readonly agentType?: string
}
/** The variables that move each tool's files, as the harness's environment holds them. */
export const GUARD_AGENT_VARIABLES = Object.freeze(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'CODEX_HOME', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'] as const)
export type GuardAgentEnvironment = Readonly<Partial<Record<(typeof GUARD_AGENT_VARIABLES)[number], string>>>

export interface GuardAgentAreas {
    readonly agentHomes: readonly GuardAgentHome[]
    readonly agentMemoryKeys: readonly string[]
    readonly agentType?: string
    readonly agentWorkspaces: readonly GuardAgentWorkspace[]
    readonly agentReadAreas: readonly string[]
}

const absolute = (value: string | undefined): value is string => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)
// An area the guard cannot locate, such as a stale worktree's main checkout or a TMPDIR it may not read,
// is left out: that admits nothing there, while a thrown error would refuse every guarded call.
function located<T>(derive: () => T): T | undefined {
    try { return derive() } catch { return undefined }
}
const within = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

/** Where a path lands: its deepest existing ancestor through every link, then the rest as spelled. */
function landing(path: string): string {
    const rest: string[] = []
    for (let cursor = normalize(path).replace(/(.)\/+$/, '$1'); ; cursor = dirname(cursor)) {
        try { return join(realpathSync(cursor), ...rest) }
        catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || cursor === '/') throw error
            rest.unshift(basename(cursor))
        }
    }
}

/**
 * The main checkout of the repository holding `root`, as Git's own layout names it: a `.git`
 * directory marks the main checkout, and a linked worktree's `.git` file names its administrative
 * directory, whose `commondir` leads to the main one. Claude Code keys auto memory by it, so a
 * session in a worktree writes the main checkout's memory (measured: a worktree and a subdirectory
 * session both wrote under the repository root's name). Outside any repository it is `root` itself;
 * a layout it cannot read gives none, so no memory is admitted for it.
 */
export function mainCheckout(root: string): string | undefined {
    for (let directory = root; ; directory = dirname(directory)) {
        const entry = join(directory, '.git')
        let status
        try { status = lstatSync(entry) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (status?.isDirectory()) return realpathSync(directory)
        if (status?.isFile()) {
            const read = (path: string) => { const result = readBoundedFile(path, 4096); return result.kind === 'complete' ? result.bytes.toString('utf8').trim() : undefined }
            const named = /^gitdir: (.+)$/.exec(read(entry) ?? '')?.[1]
            if (!named) return undefined
            const administrative = resolve(directory, named)
            let common: string
            try { common = resolve(administrative, read(join(administrative, 'commondir')) ?? '.') }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; common = administrative }
            const real = realpathSync(common)
            return basename(real) === '.git' ? dirname(real) : undefined
        }
        if (status) return undefined
        if (directory === '/') return realpathSync(root)
    }
}

/** A private temp directory: a directory the current user owns that no one else may enter. */
function privateDirectory(path: string, uid: number): boolean {
    const status = lstatSync(path)
    return status.isDirectory() && status.uid === uid && (status.mode & 0o077) === 0
}

export function guardAgentAreas(
    harness: 'claudecode' | 'codexcli' | 'opencode',
    session: GuardAgentSession,
    machine: Readonly<{ home: string; uid: number; env: GuardAgentEnvironment }>,
    roots: readonly string[],
): GuardAgentAreas {
    const { home: personal, uid, env } = machine
    const homes: GuardAgentHome[] = []
    const home = (tool: GuardAgentHome['tool'], spelled: string) => { const path = located(() => landing(spelled)); if (path) homes.push({ tool, path }) }
    const workspaces: GuardAgentWorkspace[] = []
    const readAreas: string[] = []
    const memoryKeys = new Set<string>()
    // A temp directory and the spellings that lead to it, such as `/tmp` for `/private/tmp`.
    const temp = (spelled: string, real: string) => {
        for (const path of new Set([real, normalize(spelled).replace(/(.)\/+$/, '$1')])) {
            if (!workspaces.some(area => area.kind === 'temp' && area.path === path)) workspaces.push({ kind: 'temp', path })
        }
    }
    if (harness === 'claudecode') {
        // CLAUDE_CONFIG_DIR moves every ~/.claude path, `.claude.json` included.
        home('claude', absolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(personal, '.claude'))
        for (const root of roots) {
            const main = located(() => mainCheckout(root))
            if (main) memoryKeys.add(claudeProjectKey(main))
        }
        // The payload names the scratchpad when the session has one (documented, not seen headless, where
        // sessions have none); otherwise its documented place below Claude Code's temp tree, named after the
        // transcript's project directory, as this session's own scratchpad was observed to be.
        const transcript = absolute(session.transcriptPath) ? session.transcriptPath : undefined
        const project = transcript && basename(dirname(dirname(transcript))) === 'projects' ? basename(dirname(transcript)) : undefined
        const scratchpad = absolute(session.scratchpadDir) ? located(() => landing(session.scratchpadDir!))
            : project && /^[A-Za-z0-9-]{1,255}$/.test(project) && /^[A-Za-z0-9-]{1,128}$/.test(session.sessionId ?? '')
                ? located(() => join(landing(absolute(env.CLAUDE_CODE_TMPDIR) ? env.CLAUDE_CODE_TMPDIR : '/tmp'), `claude-${uid}`, project, session.sessionId!, 'scratchpad')) : undefined
        // The session's own project, which a worktree or subdirectory session names apart from the memory key.
        const claudeHome = homes.find(item => item.tool === 'claude')?.path
        if (claudeHome && project && /^[A-Za-z0-9-]{1,255}$/.test(project)) readAreas.push(join(claudeHome, 'projects', project))
        // The session's own checkpoints, which hold what it edited.
        if (claudeHome && /^[A-Za-z0-9-]{1,128}$/.test(session.sessionId ?? '')) readAreas.push(join(claudeHome, 'file-history', session.sessionId!))
        if (scratchpad) {
            workspaces.push({ kind: 'scratchpad', path: scratchpad })
            // The session's own temp tree: task output and images Claude Code writes beside the scratchpad.
            if (basename(scratchpad) === 'scratchpad') readAreas.push(dirname(scratchpad))
        }
    }
    if (harness === 'codexcli') {
        // CODEX_HOME reaches the hook only when the person exported it; the rollout transcript lives below it.
        const fromTranscript = absolute(session.transcriptPath) ? /^(.+)\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.exec(session.transcriptPath)?.[1] : undefined
        home('codex', absolute(env.CODEX_HOME) ? env.CODEX_HOME : fromTranscript ?? join(personal, '.codex'))
    }
    if (harness === 'opencode') {
        home('opencode-data', join(absolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(personal, '.local/share'), 'opencode'))
        home('opencode-config', join(absolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(personal, '.config'), 'opencode'))
    }
    // Each tool inherits the person's TMPDIR, which is per user and private on macOS; one that is not stays shut.
    const tmpdir = absolute(env.TMPDIR) ? located(() => realpathSync(env.TMPDIR!)) : undefined
    if (tmpdir && located(() => privateDirectory(tmpdir, uid))) temp(env.TMPDIR!, tmpdir)
    const shared = located(() => realpathSync('/tmp'))
    if (shared) temp('/tmp', shared)
    // The home directory or a directory above it is never an area: it would admit every shell startup file.
    const outsideHome = (path: string) => !within(personal, path)
    return {
        agentHomes: homes.filter(item => outsideHome(item.path)),
        agentMemoryKeys: [...memoryKeys],
        ...harness === 'claudecode' && AGENT_TYPE.test(session.agentType ?? '') ? { agentType: session.agentType } : {},
        agentWorkspaces: workspaces.filter(item => outsideHome(item.path)),
        agentReadAreas: readAreas.filter(outsideHome),
    }
}

// The shells a tool runs a hook through, which a hook command may start again; the first other ancestor is the tool.
const HOOK_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * When the agent tool that started process `pid` began, from `ps -A -o pid=,ppid=,lstart=,comm=` run
 * with LC_ALL=C and TZ=UTC0: the start of the first process at or above `pid` that is not a shell, or
 * undefined when the chain leaves the listing or a start does not parse.
 */
export function agentToolStart(listing: string, pid: number): number | undefined {
    const processes = new Map<number, { ppid: number; started: number; name: string }>()
    for (const line of listing.split('\n')) {
        // procps separates the command by one space, macOS by several.
        const row = /^\s*(\d+)\s+(\d+)\s+[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s+(\S.*)$/.exec(line)
        const month = row ? MONTHS.indexOf(row[3]!) : -1
        if (!row || month < 0) continue
        processes.set(Number(row[1]), { ppid: Number(row[2]), name: basename(row[9]!.trim()).replace(/^-/, ''),
            started: Date.UTC(Number(row[8]), month, Number(row[4]), Number(row[5]), Number(row[6]), Number(row[7])) })
    }
    for (let current = processes.get(pid), hops = 0; current && hops < 32; current = processes.get(current.ppid), hops++) {
        if (!HOOK_SHELLS.has(current.name)) return current.started
    }
    return undefined
}

/** The start of the agent tool above process `pid`, as `ps` reports it, or undefined when it cannot be read. */
export async function guardAgentStart(ps: ResolvedExecutable, execute: GuardExecute, pid: number): Promise<number | undefined> {
    const step = snapshotExecutionStep({
        id: 'guard-agent-start',
        argv: [ps.canonicalPath, '-A', '-o', 'pid=,ppid=,lstart=,comm='],
        argv0: ps.invocationPath, cwd: '/', env: { LC_ALL: 'C', TZ: 'UTC0' }, timeoutMs: 10_000,
        stdoutLimitBytes: 4_194_304, stderrLimitBytes: 65_536, paths: [], ports: [], labels: { action: 'guard-agent-start' }, expected: [],
        consumedFiles: [{ path: ps.canonicalPath, sha256: ps.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: ps.executionMode }],
        filesystemChecks: [], compensation: [],
    })
    if (!step) throw new RefusalError('the process listing that dates the agent tool could not be planned')
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    return outcome?.kind === 'complete' ? agentToolStart(outcome.stdout.toString('utf8'), pid) : undefined
}
