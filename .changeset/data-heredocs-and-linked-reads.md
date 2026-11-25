---
'@b00dea/cockpit': patch
---

Shell the guard does not read is no longer refused for names in the body of a quoted heredoc fed to a plain `cat` or `tee`, since that body is data, as a write tool's content is. With native external reads, a read outside the roots through a link, such as a package in another checkout's pnpm store, is judged where the link leads instead of refused: a secret there is still refused, and a link into the roots is judged there.

A command word holding a slash, such as `local/` or `./set`, is read as the file the shell runs, not as a builtin that prints variables, so it no longer asks as an environment dump.
