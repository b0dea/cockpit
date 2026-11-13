---
"@b00dea/cockpit": patch
---

**Security:** 0.1.15 and earlier let an agent rewrite the guard through `git checkout -b <new> <rev>` and `git pull --ff-only`, each of which the guard judged as writing nothing. Upgrading closes both: a Git write whose revision or paths the guard cannot resolve now asks, and every pull in a cockpit holding the guard asks.

The guard no longer blocks an agent tool's own files, with no configuration:

- Claude Code and Codex write their own memory, plans and notes (Claude Code's auto memory for this cockpit's projects and plans, Codex's memory notes), Claude Code's session scratchpad, file by file, and read back this cockpit's Claude Code projects and the session's own files. What the tool writes itself is read-only to agents, a subagent's user memory asks before a write, and temp directories are judged as before. Each location comes from the hook payload and the tool's environment.
- The tools' settings, instructions, hooks, skills, plugins and anything they load into later sessions stay refused to writes, their logins to reads and writes, and an entry the guard does not know asks. Claude Code memory and transcripts are written only for this cockpit's own checkouts, and a subagent writes only its own memory.
- A read of anything else in a tool's home asks: settings and configuration, prompt history, pasted text, other sessions' and projects' files.
- Links, extractions, executable modes, `.env*` names and guard paths stay refused there as anywhere outside the roots.
- A Claude Code session started in a subdirectory of the cockpit is now guarded too: sync repeats the guard registration in the root's machine-local `.claude/settings.local.json`, which Claude Code reads from subdirectories, the hook finds the cockpit by walking up from the session, and `doctor` warns when the local registration is missing.
- The guard refuses agents writing an agent tool's settings, hooks or MCP configuration at any depth (`.claude/settings*.json`, `.claude/hooks/`, `.mcp.json`, `.codex/config.toml`, `opencode.json` and the like), which a session started in that directory would load; `doctor` reports existing ones and any `disableAllHooks`.
- The Claude Code and Codex guard hooks stop their search for the guard at the nearest `.git` entry, so a session in a linked worktree kept below the main checkout runs that worktree's guard instead of being refused; Codex asks a person to trust its hook again. A cockpit below its repository's top also registers the guard in the top's `.claude/settings.local.json`, gated to sessions inside the cockpit.
- `git init`, `git clone` and `git submodule add` ask when the new repository would land inside the cockpit, where a Claude Code session started in it would load no cockpit hook; `doctor` reports such repositories (`AGENT_NESTED_REPOSITORY`).
- A Git checkout, restore, merge, new worktree or index entry that would write an agent tool's settings, hooks or guard script anywhere in the tree is refused, and one that would write a skill, command or agent file asks.
- A `Write` or `Edit` that leaves `hooks` or `mcpServers` in a skill's, command's or agent's frontmatter asks, as any other writer of those files does, since Claude Code runs what they register outside the guard.
- The hook runs the guard script only when it, and the machine-local identity, match the digest sync records below `~/.cockpit/guards`, so a guard replaced by any writer holds every call until a person runs sync; `doctor` reports a mismatch, and a worktree inside the cockpit that holds no recorded guard. Codex asks a person to trust its hook again.
- A Git write the guard cannot fully resolve asks: an unresolved revision, `--stdin`, revision walks, options it does not list, `bisect`, `stash branch`, `read-tree`, `update-index --index-info`, `submodule` updates and `worktree add --no-checkout` or `--orphan`. A new branch is judged by its start point.
- `tar -x` and `unzip` into the cockpit list the archive first and judge each member; other extractors and a `gh repo clone` into the cockpit ask.
- A skill, command or agent file whose body runs a shell command (`` !` ``) or whose `allowed-tools` grants the shell asks, and Git checkouts read those files instead of asking by name. OpenCode's `.opencode/tool(s)/` is refused at any depth.
- Temp directories are no longer agent workspaces: Claude Code keeps scratch files in its scratchpad, and other tools inside the checkout or under a write path a person adds.
