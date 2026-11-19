---
'@b00dea/cockpit': patch
---

Doctor prints every finding it counts, an MCP server can say it starts the stack, and the guard lets `cd` into a single existing directory name.

- Doctor lists its findings under its report on stdout, where its "listed below" points. They went to stderr, so a reader of stdout alone, such as a pipe or a tool that captures the streams apart, saw the count but missed any finding no readiness gap names, such as a start a killed session left unfinished.
- An MCP server whose command runs a script that starts the stack through `cockpit session` can be marked in `cockpit.toml` with `[mcp.starts_stack]` and `<server> = true`. Codex then gets the same `startup_timeout_sec` as for a server that runs `cockpit session` directly, which cockpit can't see inside a script. The server must be a declared local one, and the mark needs `[environment.machine]`; sync refuses it otherwise and says why. An agent can add it without a person's approval.
- The guard judges `cd name && …` with a single directory name like `cd sub/dir && …`. It runs when the directory exists below, the name does not start with a dot, and the call leaves `CDPATH` alone. `cd workorders && jq . WO-1/evidence/x.json` no longer asks in Claude Code or is refused in Codex.
- A word after a `cd` into a directory on the home directory's own path, such as `cd workspace && cat home/.aws/credentials` for a home directory at `/workspace/home` and a `CDPATH` that holds `/`, is refused when it reaches a credential store.
- A command whose path is an expansion followed by a credential name, such as `cat "$(getent passwd $USER | cut -d: -f6)/.netrc"` or `"$X/.aws/credentials"`, is now refused whatever the expansion holds, as is code that joins `/.netrc` to a directory it found.
- Inline code and shell text the guard cannot read that name an agent tool's home directory, such as `.claude` or `.codex`, stay refused, even as a printed string or a jq field: code can reach the home directory in more ways than the guard can list. Write prose that names them with the agent tool's own file-writing tool.
- `tar -c` judges each source from the directory the `-C` before it names, so `tar -C ~ -cf out.tar .codex` is refused like a direct read of `~/.codex`.
