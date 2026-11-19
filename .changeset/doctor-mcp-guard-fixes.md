---
'@b00dea/cockpit': patch
---

Doctor prints every finding it counts, an MCP server can say it starts the stack, and the guard lets through two everyday commands it refused.

- Doctor lists its findings under its report on stdout, where its "listed below" points. They went to stderr, so a reader of stdout alone, such as a pipe or a tool that captures the streams apart, saw the count but missed any finding no readiness gap names, such as a start a killed session left unfinished.
- An MCP server whose command runs a script that starts the stack through `cockpit session` can be marked in `cockpit.toml` with `[mcp.starts_stack]` and `<server> = true`. Codex then gets the same `startup_timeout_sec` as for a server that runs `cockpit session` directly, which cockpit can't see inside a script. The server must be a declared local one, and the mark needs `[environment.machine]`; sync refuses it otherwise and says why. An agent can add it without a person's approval.
- The guard judges `cd name && …` with a single directory name like `cd sub/dir && …`. It runs when the directory exists below, the name does not start with a dot, and the call leaves `CDPATH` alone. `cd workorders && jq . WO-1/evidence/x.json` no longer asks in Claude Code or is refused in Codex.
- The guard no longer refuses inline code or unread shell text as a credential-store read just because it names `.codex` or `.claude`, as a jq filter or a printed string does. Every other credential name is still judged as reached from the home directory, as is an agent tool's directory once a login file inside it is named too. A word after a `cd` into a directory on home's own path that reaches a credential store is refused.
- A command whose path is an expansion followed by a credential name, such as `cat "$(getent passwd $USER | cut -d: -f6)/.netrc"` or `"$X/.aws/credentials"`, is now refused whatever the expansion holds, as is code that joins `/.netrc` to a directory it found.
