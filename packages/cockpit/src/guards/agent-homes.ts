// What each agent tool keeps in its own directories, by entry: data the agent reads and writes while
// it works, controls that change what the agent may do or which hooks run, and credentials. An entry
// this table does not name asks, so a tool update that adds one opens nothing until a person admits it.
//
// Sources: the entries present on macOS on 2026-11-13 under Claude Code 2.1.323, Codex CLI 0.168.0 and
// OpenCode 1.19.5, with what each holds taken from the tools' documentation
// (https://code.claude.com/docs/en/claude-directory, https://learn.chatgpt.com/docs/customization/memories.md)
// and from probes that drove each tool and logged where its hooks saw it write.
// docs/safety-and-autonomy.md#agent-workspaces keeps the measured table.

export type AgentHomeTool = 'claude' | 'codex' | 'opencode-data' | 'opencode-config'
export type AgentHomeClass = 'data' | 'control' | 'credential'

type Rule = readonly [RegExp, AgentHomeClass, string]
// Each rule matches the folded path below the home; the first that matches decides. A trailing
// `(?:/|$)` names a directory and everything below it.
const below = (name: string) => `^${name}(?:/|$)`
const rules = (entries: readonly (readonly [string, AgentHomeClass, string])[]): readonly Rule[] =>
    entries.map(([pattern, kind, why]) => [new RegExp(pattern), kind, why] as const)

const LOGIN = 'it holds the tool\'s login'
const SETTINGS = 'it changes what the agent may do or which hooks run'
const INSTRUCTIONS = 'the tool loads it as instructions, skills, agents or code'
const SOURCED = 'the tool\'s shell sources it before every command it runs'

const AGENT_HOME_RULES: Readonly<Record<AgentHomeTool, readonly Rule[]>> = Object.freeze({
    // `CLAUDE_CONFIG_DIR`, else ~/.claude. `.claude.json` sits here only when that variable moves it.
    claude: rules([
        [below('\\.credentials\\.json'), 'credential', LOGIN],
        [below('\\.claude\\.json[^/]*'), 'credential', 'it holds account details, project trust and personal MCP servers'],
        // Earlier copies of `.claude.json`, which holds account details.
        [below('backups'), 'credential', 'it holds copies of the account details in .claude.json'],
        // Each running IDE connection's lock file carries the token that authenticates it.
        [below('ide'), 'credential', 'it holds the tokens of IDE connections'],
        [below('settings[^/]*'), 'control', SETTINGS],
        [below('(?:remote-settings|policy-limits|managed-settings)[^/]*'), 'control', SETTINGS],
        [below('(?:keybindings\\.json|themes|statusline[^/]*|\\.mcp\\.json)'), 'control', SETTINGS],
        [below('(?:claude|claude\\.local|agents)\\.md'), 'control', INSTRUCTIONS],
        [below('(?:rules|skills|commands|output-styles|agents|workflows|hooks|plugins|dev-mods)'), 'control', INSTRUCTIONS],
        // The Bash tool applies the captured shell state to each command, and the session environment
        // file is sourced before each one.
        [below('(?:shell-snapshots|session-env)'), 'control', SOURCED],
        // Rewinding a checkpoint writes these snapshots back into the project's files.
        [below('file-history'), 'control', 'Claude Code writes these snapshots back into project files when a checkpoint is restored'],
        [below('(?:projects|plans|tasks|todos|statsig|logs|agent-memory|debug|paste-cache|image-cache|uploads'
            + '|feedback|feedback-bundles|usage-data|cache|sessions|history\\.jsonl|stats-cache\\.json)'), 'data', ''],
    ]),
    // `CODEX_HOME`, else ~/.codex.
    codex: rules([
        [below('(?:auth\\.json|auth\\.lock|mcp-oauth-locks|app-server-control|ipc)'), 'credential', LOGIN],
        [below('(?:[^/]*\\.)?config\\.toml[^/]*'), 'control', SETTINGS],
        [below('(?:hooks\\.json|\\.codex-global-state\\.json[^/]*)'), 'control', SETTINGS],
        [below('(?:agents|agents\\.override|instructions)\\.md'), 'control', INSTRUCTIONS],
        [below('(?:prompts|rules|skills|plugins|packages|vendor_imports)'), 'control', INSTRUCTIONS],
        // Consolidated memories carry skills that feed instructions; plugins unpack below `.tmp`.
        [below('memories[^/]*/skills'), 'control', INSTRUCTIONS],
        [below('\\.tmp/plugins[^/]*'), 'control', INSTRUCTIONS],
        [below('shell_snapshots'), 'control', SOURCED],
        // The agent writes memory as notes, as Codex's own prompt directs; the consolidated memories load
        // into every later session, so only Codex's own pipeline writes them.
        [below('memories[^/]*/extensions/ad_hoc/notes'), 'data', ''],
        [below('memories[^/]*'), 'control', 'Codex loads its consolidated memories into every later session'],
        [below('(?:sessions|archived_sessions|log|history\\.jsonl|session_index\\.jsonl[^/]*|cache|tmp|\\.tmp|attachments'
            + '|generated_images|thread-writer-locks|sqlite|[a-z_]+_\\d+\\.sqlite(?:-shm|-wal)?|version\\.json|update-check\\.json)'), 'data', ''],
    ]),
    // `$XDG_DATA_HOME/opencode`, else ~/.local/share/opencode.
    'opencode-data': rules([
        [below('(?:auth\\.json|mcp-auth\\.json)'), 'credential', LOGIN],
        // Each snapshot is a Git directory OpenCode runs Git against, whose configuration names programs.
        [below('snapshot'), 'control', 'OpenCode runs Git against it, and its configuration chooses programs Git runs'],
        [below('(?:opencode\\.db[^/]*|log|tool-output|storage)'), 'data', ''],
    ]),
    // `$XDG_CONFIG_HOME/opencode`, else ~/.config/opencode: configuration, instructions and plugin code throughout.
    'opencode-config': rules([['^', 'control', 'OpenCode loads its configuration, instructions and plugins from there']]),
})

/** The class of a path below a tool home, by its folded relative spelling; undefined is an entry cockpit does not know. */
export function classifyAgentHomeEntry(tool: AgentHomeTool, relative: string): Readonly<{ kind: AgentHomeClass; why: string }> | undefined {
    const rule = AGENT_HOME_RULES[tool].find(([pattern]) => pattern.test(relative))
    return rule && { kind: rule[1], why: rule[2] }
}

export const AGENT_HOME_TOOLS: readonly AgentHomeTool[] = Object.freeze(Object.keys(AGENT_HOME_RULES) as AgentHomeTool[])

/**
 * Claude Code's name for a directory under `projects/` and its temp tree: the real path with every
 * character but a letter or digit replaced by `-`, and past 200 characters the first 200, a `-` and
 * the base-36 magnitude of a 32-bit `h * 31 + code` hash of the path. Measured on Claude Code 2.1.323.
 */
export function claudeProjectKey(path: string): string {
    const key = path.replace(/[^A-Za-z0-9]/g, '-')
    if (key.length <= 200) return key
    let hash = 0
    for (let at = 0; at < path.length; at++) hash = (hash << 5) - hash + path.charCodeAt(at) | 0
    return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}
