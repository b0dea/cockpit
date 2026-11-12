---
"@b00dea/cockpit": patch
---

The guard reads more of the shell agents write, so fewer safe commands stop an autonomous session, and it refuses one more thing that is actually dangerous.

- A live payment secret or restricted key (`sk` or `rk`, then `_live_` and the key) written into a command's arguments or assignments is refused, since a command line lands in shell history and transcripts. A test key of the same shape still runs.
- `mv` or `cp` onto an existing file inside the cockpit no longer fails with "Guard path inspection failed (ENOTDIR)". Writes to a guard control or outside the roots are still refused.
- Loops followed by a redirect or pipe, `while` and `until` loops, subshells `( … )`, brace groups that feed a pipeline, process substitution `<(…)` and `"${PIPESTATUS[0]}"` are judged by the commands inside them. `xargs` runs its command with the words from standard input as an argument the guard cannot see, so a command that would read or write what they name asks instead of failing to parse. A script a shell, interpreter or `make -f` reads from `<(…)` or `/dev/stdin` asks, as inline code does.
- A redirect into a double-quoted variable set to a plain path by the assignments directly before the command, as in `out=build; npm test > "$out/test.log"`, is judged as that path.
- `cmp` and `diff` are read-only commands, so comparing a guard control with its adopted copy runs. Writing a control is still refused.
- `git remote get-url`, `git remote -v` and `git ls-remote --get-url` run while no configured remote URL or http header carries a credential, and are refused with that reason when one does.
- `gh` reads (`pr view|list|checks`, `run view|list|watch`, `issue view|list`, `repo view`, `auth status`, `gh api` GET) run in the strict mode too, unless they name an `.env*` or `.secrets` path. `gh run rerun`, `gh workflow run`, `gh release create|delete`, `gh secret set` and other commands that publish, delete or spend now ask, and a `gh --jq` filter that reads the environment is refused.
- A working directory reached through a link is refused with a reason naming the link and the way forward (name the path through the link from the checkout), instead of "Guard path inspection failed".
- The refusal for a call whose working directory differs from the guard's names both directories.
