---
"@b00dea/cockpit": patch
---

Agents can now create a worktree beside the checkout: `git worktree add [-b <branch> | -B <branch> | --detach] <path> [<commit-ish>]` on its own in a call, without `--force`, where `<path>` does not exist yet, sits in the directory that holds the checkout and is named after it, such as `../<checkout>-feature-x`. It no longer needs a write path, since what it writes is the repository's own committed content. Any other name, such as `node_modules`, an existing or linked path, and any other command in the same call are refused, and `git worktree add -B` of a protected branch is now refused.

`git stash pop` and `git stash apply` are now judged by every path the stash entry changes, and with `--index` also as staged, so an entry holding an environment file or a staged guard script is refused instead of restored.

`git rm` of a glob or directory is now judged by every path the index holds there, so removing a declared instance or a secrets file through a glob is refused as naming it is. A `git add` or `git commit` glob that Git listed is judged only by the paths it lists, so `git add '*.json'` no longer fails because the pattern could match a guard file's name. `git checkout -- .` and `git restore .` no longer ask when no guard file there would change. `git restore --staged` and `git reset` of a directory, a glob or the whole tree are judged by every path whose index entry they set back, so `git restore --staged .` and `git reset` run unless a guard file, instance or secret is among them.

A checkout, merge, reset or stash that would write an environment file or an `.npmrc` from another revision, such as `git checkout <rev> -- .`, is now refused, as writing one directly is.
