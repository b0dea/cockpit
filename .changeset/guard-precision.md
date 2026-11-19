---
'@b00dea/cockpit': patch
---

The guard refuses fewer safe commands:

- A Git command that only prints or lists, such as `git grep`, `git log` or `git ls-files`, may name a guard file in a pathspec, including an exclusion like `':!.cockpit'`. Writing verbs and `git grep -O` are still refused.
- A live key placeholder whose body repeats one character, such as all zeros, runs. A realistic live key is still refused.
- `time ( … )` and `time { …; }` are read as the commands they time.
- Prose in inline code that mentions a push and, later, a protected branch runs. A push counts only in a command's shape: on one line, with its force, deletion or protected branch within a few words of it.
- `find -exec` running a read-only command, such as `stat`, `cat` or `wc`, counts as a read below find's roots. `stat` joins the read-only commands.
- A redirect to `"$NAME"` is followed into the path when a plain `NAME=path` on its own earlier in the same list is the only place the call sets NAME.
