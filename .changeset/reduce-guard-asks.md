---
"@b00dea/cockpit": patch
---

The guard asks far less. A command now runs unless it names something on the blocked list: a secret or `.env` file, a credential store or key file, a declared host, a guard file or agent setting, the installed cockpit, or a forced or protected-branch push. Unknown programs, inline code, containers, variables, globs and reads it cannot prove all run, as a project script does. Shell the guard does not read whole, such as `if`, `case` or a loop, is judged command by command; a command it still cannot read, such as `eval`, gets no answer from the guard, so the agent tool's own permissions decide.

The blocked list is checked in every word of a call, wherever the word sits: `cat $(echo .env)`, `echo .env | xargs cat`, `ls .env` and `corepack pnpm exec git push -f` are refused. A name inside a commit message, a search pattern such as `rg '\.env' docs`, and documentation names such as `.env.example` still run. Inline code and unparsed shell text meet the whole blocked list. Hook-skipping variables such as `HUSKY=0`, `git clean -x`, removals outside the cockpit, a search that would read an existing secret, and `docker inspect` of a container's environment are refused too.

Git commands chained in one call, such as `git stash && git rebase main && git stash pop`, run. Removing `node_modules` stays refused, since it holds the code the guard runs, and the refusal now says to reinstall with the package manager's clean install instead.

A person is still asked before merges, releases and other `gh` changes, `git clean -f`, a push or Git write the guard cannot resolve, Git location variables, and cockpit commands that change what agents may do.

In Claude Code the guard now answers allow for a call it judged, so those calls run without a prompt; your own deny rules still win. Refusals reach Claude Code and Codex as a reason only, without the hook command printed before it.

Sessions started in a cockpit subdirectory now get the Read and Edit deny rules too, and a session in a cockpit below its repository's top is guarded under a linked spelling of its path. The registered hook command no longer changes between releases, so Codex keeps trusting it after an upgrade. Agents can stage the guard script exactly as the last sync recorded it, so an upgrade can be committed.

`[guards] default` is gone, and `[guards] external_reads` now defaults to `"native"`, which leaves reads outside the cockpit to the agent tool. A team that needs a stricter boundary runs the agent tool in its own OS sandbox.

Upgrade: remove `default` from `[guards]` in `cockpit.toml`, set `external_reads = "grant"` there to keep reads outside the cockpit behind exact grants, run `cockpit sync`, then trust the changed hook once more in Codex (later upgrades keep the same command).
