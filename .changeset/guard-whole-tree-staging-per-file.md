---
"@b00dea/cockpit": patch
---

`git add -A` and `git add -u` without a pathspec, and `git commit -a`, are now judged by what Git lists for the whole tree, each changed path as if named on its own, as `git add .` already was. At the top of a checkout `git add -A` now gets the same answer as `git add .`, from any directory it judges the whole tree, and bundled forms such as `-Av` and `-nu` are read too. `git add -u` and `git commit` list only changed and deleted tracked files, since that is all they stage. A changed environment instance or guard file among them is still refused, and `git commit -a` with a changed guard file is now refused as `git add` of it is.

Where Git cannot list the files first, such as with `-f`, a pipe or an earlier command that writes, `git commit -a` now gets the answer `git add -A` gets there instead of running unjudged; other answers are unchanged, and the refusal for staging a directory that holds a secrets directory or an instance now says that, instead of naming forms that are judged file by file.
