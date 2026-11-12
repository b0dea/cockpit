---
"@b00dea/cockpit": patch
---

The guard now holds secrets that only Git history, a pull request diff or a followed link would print:

- A Git command that prints committed content (`diff`, `show`, `log -p`, `grep`, `blame`, `cat-file`, `archive`, `format-patch`, `whatchanged`) is refused when a pathspec or `rev:path` names an environment file, a secrets directory, a declared instance or a `[guards] secret_paths` entry, in both modes and whether or not the index holds it now.
- A command that can print a commit, such as `git log -p`, `git show <rev>` or `git grep <pattern> <rev>`, now asks while any commit reachable from a ref, a reflog or a revision it names holds such a file, not only the index. Limit it with `-- <path>`. In a very large history the check can take seconds, and past its time limit the command asks. `git cat-file -p` of an object other than a `rev:path` or `HEAD` asks, and the plumbing diffs (`diff-tree`, `diff-index`, `diff-files`, `merge-tree`) are no longer allowed unread. An option's value, such as `git log --grep .env`, no longer counts as a path.
- `gh pr diff` is judged as `git diff <rev>` is: it runs from the repository's top while neither the index nor history holds a secret, and asks otherwise. With `--repo`, a URL, or from a subdirectory it asks. Under the allow default `gh search code` and `gh api` reads of files or patches ask too. `gh pr diff --name-only` runs.
- `zip` (without `-y`), `scp` and `rsync -L`, `-k` or `--copy-unsafe-links` follow links below the trees they read, so a tree holding a link now asks, as `diff -r` already did.
- Claude Code's `Read` deny rules for a declared instance or secret path with a non-ASCII name are written in both Unicode normal forms, since Claude Code compares them literally while macOS resolves either spelling to the file.
