---
"@b00dea/cockpit": patch
---

The guard no longer lets a recursive search or a shadowed command name read secrets without a prompt.

- A recursive search (`rg`, `grep -r`, OpenCode's grep) is allowed only when a bounded walk of its tree finds no `.secrets` directory and no `.env*` file other than a declared template, and every other command in the call is read-only, so none can write one first. `grep -rn API_KEY .` used to print an undeclared sibling `.env.local` that `cat` would have stopped at. A tree too large to walk needs approval; the reason names what was found, so the agent can search a narrower path.
- `rg -g`, `--glob` and `--iglob` are read-only only as `!` exclusions, because any other glob overrides ripgrep's hidden and ignore filters.
- While the agent harness's `PATH` holds a relative or empty entry, no command is allowed without a prompt, since a file the agent wrote could run in place of a command or of the interpreter a path-spelled script starts by name. The reason names the entry; remove it from the `PATH` the harness starts with.
