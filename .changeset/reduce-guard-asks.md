---
"@b00dea/cockpit": patch
---

The guard asks far less. A command now runs unless it names a secret, a credential store, a declared host, a guard file or agent setting, or a forced or protected-branch push; unknown programs, inline code, containers, variables, globs, shell forms the guard does not parse, and reads it cannot prove run as a project script does. Inline code and unparsed shell text meet the whole blocked list. A person is still asked before merges, releases and other `gh` changes, `git clean -f`, pushes or Git writes the guard cannot resolve, Git location variables, and cockpit commands that change what agents may do. Hook-skipping variables such as `HUSKY=0`, `git clean -x`, removals outside the cockpit, a search that would read an existing secret, and `docker inspect` of a container's environment are refused. `[guards] external_reads` now defaults to `"native"`.

Sessions started in a cockpit subdirectory now get the Read and Edit deny rules too, in the local settings that carry the hook. Agents can stage the guard script exactly as the last `sync` recorded it, so an upgrade can be committed; other guard files are refused with the `!` command a person runs.

The strict mode is gone: `[guards] default` no longer exists. A team that needs a stricter boundary runs the agent tool in its own OS sandbox.

Upgrade: remove `default` from `[guards]` in `cockpit.toml` if it is set; set `external_reads = "grant"` to keep reads outside the cockpit behind exact grants.
