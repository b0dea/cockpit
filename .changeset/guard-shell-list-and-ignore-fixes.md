---
"@b0dea/cockpit": patch
---

The guard no longer allows reads of a declared instance through these spellings:

- A `cd` after `||` may not run while the `&&` after it still does, so in `pwd || cd ./src && cat config/active.instance` the `cat` is now judged from both directories and denied.
- A newline after `&&`, `||` or `|` continues the list, so `pwd |` followed by a `cd` on the next line is refused like any `cd` in a pipeline.
- `rg` falls back to the guard's own walk when a `.gitignore` holds a line Git and ripgrep may match differently, such as `[[:alpha:]]`, braces, a backslash escape, trailing whitespace, a `**` inside a path component or bytes that are not UTF-8; Git could ignore a file ripgrep then reads.
- A path or `git -C` directory that leaves a symlink through `..`, such as `cat link/../active.instance`, is no longer judged by its spelling; it is treated like any symlink.
- `env -C` with `$?`, `cd` or `env -C` with `..` after a directory name, `pushd`, `popd`, zsh's `chdir`, `builtin` and a zsh `=command` word are refused, since the guard cannot see the directory or path they expand to.
