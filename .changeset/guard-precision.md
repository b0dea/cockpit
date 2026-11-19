---
'@b00dea/cockpit': patch
---

The guard refuses fewer safe commands, and closes some ways around it:

- A Git command that only prints or lists, such as `git grep`, `git log` or `git ls-files`, may name a guard file in a pathspec, including an exclusion like `':!.cockpit'`. Writing verbs, `git grep -O` and a command carrying `GIT_EXTERNAL_DIFF` are still refused.
- Any write to a path holding `*`, `?` or `[` asks, whatever writes it: a redirect, a Git output option, `cp`, `curl -o`.
- A variable assignment or export whose value names a guard file, an agent tool's settings or the installed cockpit is refused, as writing that path is.
- A live key placeholder whose body repeats one character, such as all zeros, runs. A realistic live key is still refused.
- `time ( … )` and `time { …; }` are read as the commands they time.
- `find -exec` running a read-only command, such as `stat`, `cat` or `wc`, counts as a read below find's roots. Whatever program find hands the found paths, its roots are searched for secrets, through links. `stat` joins the read-only commands.
- A redirect to `"$NAME"` in a call's second command is followed into the path its first command, a plain `NAME=path`, assigns.
- `git grep --no-index`, and `--untracked` with `--no-exclude-standard`, are judged as a recursive search, so they cannot read an ignored environment file.
- A variable naming a program Git runs (`GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_SEQUENCE_EDITOR`, an editor other than `true`) asks when set on a git command, or when set or exported anywhere else in the call. An editor set for a commit given its message, and pager variables, run.
- A Git trace variable holding a path is judged as a write of that path.
- A push that inline code spells, even across lines, is still refused. The reason now says to write prose that mentions a push with the editor's write tool.
