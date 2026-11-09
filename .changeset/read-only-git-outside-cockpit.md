---
"@b00dea/cockpit": patch
---

The guard asks less often for harmless Git reads:

- With `[guards] external_reads = "native"`, a read-only Git command in a repository outside the cockpit, such as `git -C <checkout> worktree list --porcelain`, `status`, `log` or `branch -a`, is left to the agent tool's own permission, as a named file read already was, instead of being refused. It must run alone in the call, from a directory holding its own `.git`, in the read-only profile's exact form: `-c`, aliases, external diff, pager options, writes and network access stay refused. Commands that print file content there, such as `diff`, `show` or `log -p`, pass only when that repository tracks no `.env*` or `.secrets` file. With the default `grant`, the complete command still needs a `[guards] allow` rule.
- The read-only profile now also covers `git ls-files`, `git cat-file -t`/`-s`/`-e`/`-p` of one object, `git merge-base`, `git remote` (names only), `git branch -l`, and `git config --get <key>`, `--get-all` and `git config get` for a key in a section that holds no URL or credential, such as `user.name` or `core.editor`. Configuration writes stay refused; listings, patterns and keys such as `remote.origin.url` or `credential.helper` ask, and say to read one key instead.
- `git fetch` still asks, since it writes objects and refs under `.git`, and the refusal now names the read-only alternative: `git -C <repository> log --oneline <branch>`.
