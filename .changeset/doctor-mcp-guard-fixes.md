---
'@b00dea/cockpit': patch
---

Doctor prints every finding it counts, an MCP server can say it starts the stack, and the guard lets through two everyday commands it refused.

- Doctor lists its findings under its report on stdout, where its "listed below" points. They went to stderr, so a reader of stdout alone, such as a pipe or a tool that captures the streams apart, saw the count but missed any finding no readiness gap names, such as a start a killed session left unfinished.
- An MCP server whose command runs a script that starts the stack through `cockpit session` can be marked in `cockpit.toml` with `[mcp.starts_stack]` and `<server> = true`. Codex then gets the same `startup_timeout_sec` as for a server that runs `cockpit session` directly, which cockpit can't see inside a script. The server must be a declared local one, and the mark needs `[environment.machine]`; sync refuses it otherwise and says why. An agent can add it without a person's approval.
- The guard judges `cd name && …` with a single directory name like `cd sub/dir && …`. It runs when the directory exists below, the name does not start with a dot, and the call leaves `CDPATH` alone. `cd workorders && jq . WO-1/evidence/x.json` no longer asks in Claude Code or is refused in Codex.
- The guard no longer refuses inline code or unread shell text as a credential-store read just because it names `.codex` or `.claude`, as a jq filter or a printed string does. The home-directory check for bare names now applies only to a `cd` target and the words after it. `cat ~/.codex/auth.json`, code that opens `$HOME/.codex/auth.json` and `cd .aws && cat credentials` are still refused.
