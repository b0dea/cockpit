---
"@b00dea/cockpit": patch
---

Git commands that write another revision's files into the working tree are judged against the guard's own files. In a repository whose work tree holds the guard, its hook registrations, the secrets directory or a declared instance, `git merge`, `checkout` and `switch` to a revision, `reset --hard`/`--merge`/`--keep`, `cherry-pick`, `revert`, `rebase`, `stash`, `stash pop`/`apply` and `pull --ff-only` are refused when they would change one of those files, and ask when the revision does not resolve or an earlier command in the call could change it. Any other `git pull` there asks, since what it brings is unknown until it is fetched: fetch first, then `git merge --ff-only <remote>/<branch>`. `git am` of a mail whose body is base64 or quoted-printable, or of a file that names no path, asks.
