---
'@b00dea/cockpit': patch
---

The guard refuses fewer safe commands, and closes some ways around it:

- A Git command that only prints or lists, such as `git grep`, `git log` or `git ls-files`, may name a guard file in a pathspec, including an exclusion like `':!.cockpit'`. Writing verbs, `git grep -O` and a command carrying `GIT_EXTERNAL_DIFF` are still refused.
- A Git output option (`--output`, `-o`, `--output-directory`) whose path holds a glob that can match a guard file is refused, on every Git command that writes one.
- A live key placeholder whose body repeats one character, such as all zeros, runs. A realistic live key is still refused.
- `time ( … )` and `time { …; }` are read as the commands they time.
- `find -exec` running a read-only command, such as `stat`, `cat` or `wc`, counts as a read below find's roots, through links. `stat` joins the read-only commands.
- A redirect to `"$NAME"` is followed into the path when the command just before it is a plain `NAME=path`.
- `git grep --no-index` is judged as a recursive search, so it cannot read an ignored environment file.
- A variable naming a program Git runs (`GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, a pager other than `cat`, `less` or `more`, an editor other than `true`) asks, whether set on the command or exported earlier in the call.
- A push that inline code spells, even across lines, is still refused; the reason now says to write prose that mentions a push with the editor's write tool.
