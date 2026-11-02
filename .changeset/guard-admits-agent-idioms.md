---
"@b0dea/cockpit": patch
---

The guard now admits the read-only idioms agents use constantly, which headless Codex and OpenCode previously turned into refusals, and every remaining refusal names the command and says what to do instead.

- `cd ./api && <command>` and `cd ./api; <command>` judge the command from the directory it runs in, under the same rules. After `;` or `||` a failed `cd` leaves the shell where it was, so the command is judged from both directories. A bare `cd api` is still refused, because both shells resolve it through `CDPATH` first; the refusal says to write `cd ./api`.
- `echo` and `printf` without options are read-only, and `$?` in their arguments is the previous exit status, not dynamic command construction. A `$?` in any argument that could name a path still asks.
- `sed -n <range>p <file>` reads like `cat`; any other sed command still asks.
- `git rev-parse` and `git branch` with listing flags (`-v`, `-vv`, `-a`, `-r`, `--show-current`) are read-only, and `@{u}`, `HEAD@{1}` and `HEAD~1` are Git revisions, not brace or tilde expansion.
- `git add <paths>` naming a guard control such as `.claude/settings.json` now asks like any other staging instead of being refused outright: staging writes the index, not the file. Committing still requires a person.
- `git add -A`, `git add .` or a directory that contains `env/.secrets` or a declared environment instance is still refused, and the refusal now says to stage the changed files by name.
- A command the guard does not admit now names itself, and says how to proceed: a person approves it or runs it in a terminal, tests run through `npx --no cockpit test-run`, and `[guards] allow` admits a command for good. A read outside the configured roots says so.
